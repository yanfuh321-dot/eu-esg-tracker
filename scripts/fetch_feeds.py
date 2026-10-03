#!/usr/bin/env python3
"""Collect EU ESG updates from RSS/Atom feeds for the EU ESG Tracker.

Reads   config/sources.yml            (which feeds to check)
        site/data/regulations.json    (regulations and the keywords used to tag items)
        site/data/news.json           (previous run, so history and "first seen" dates are kept)
        site/data/developments.json   (previous run, so reported developments are kept)
Writes  site/data/news.json           (items + health of every source, used by the website)
        site/data/developments.json   (procedure steps reported in the news, shown on the timeline)
        site/feed.xml                 (an RSS feed of the tracker itself, for Outlook, Feedly etc.)
        site/calendar.ics             (the key dates as a calendar that Outlook and others can subscribe to)

A failing source never stops the run; its error is recorded and shown on the Sources page.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from urllib.parse import parse_qsl, quote_plus, urlencode, urlparse, urlunparse

import feedparser
import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "sources.yml"
REGS_PATH = ROOT / "site" / "data" / "regulations.json"
NEWS_PATH = ROOT / "site" / "data" / "news.json"
DEVS_PATH = ROOT / "site" / "data" / "developments.json"
FEED_PATH = ROOT / "site" / "feed.xml"
CALENDAR_PATH = ROOT / "site" / "calendar.ics"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0 Safari/537.36 EU-ESG-Tracker/1.0"
)
# Second attempt for servers that turn away browser-like clients but accept feed readers.
READER_AGENT = "EU-ESG-Tracker/1.0 (feed reader)"
ACCEPT = "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8"
TRACKING_PARAMS = re.compile(r"^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|oc$)")
TAG_RE = re.compile(r"<[^>]+>")
ACT_NUMBER = re.compile(r"\b((?:19|20)\d{2}/\d{1,4})\b")


# --------------------------------------------------------------------------- helpers
def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def to_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def from_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def plain_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", value or ""))).strip()


def clean_text(value: str | None, limit: int = 320) -> str:
    text = plain_text(value)
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0].rstrip(",.;:") + "…"
    return text


def entry_full_text(entry) -> str:
    """Everything a feed says about an item: title, teaser, full text and categories.

    Only used to decide whether an item is relevant and which regulations it concerns, so a
    regulation named in the fifth paragraph is found even though the teaser does not mention it.
    """
    parts = [entry.get("title"), entry.get("summary") or entry.get("description")]
    for block in entry.get("content") or []:
        if isinstance(block, dict):
            parts.append(block.get("value"))
    for tag in entry.get("tags") or []:
        if isinstance(tag, dict):
            parts.append(tag.get("term"))
    return plain_text(" ".join(p for p in parts if p))[:20000]


def act_numbers(reference: str | None) -> list[str]:
    """'Regulation (EU) 2023/956, amended by Regulation (EU) 2025/2083' -> ['2023/956', '2025/2083'].

    Official feeds such as EUR-Lex cite acts by number ("amending Regulation (EU) 2023/956"),
    not by nickname, so the numbers in each regulation's reference are used as extra keywords.
    """
    return ACT_NUMBER.findall(reference or "")


def normalise_url(url: str) -> str:
    try:
        parts = urlparse(url.strip())
    except ValueError:
        return url.strip()
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not TRACKING_PARAMS.match(k)]
    path = parts.path.rstrip("/") or "/"
    return urlunparse((parts.scheme.lower(), parts.netloc.lower(), path, "", urlencode(query), ""))


def normalise_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def keyword_regex(words: list[str]) -> re.Pattern | None:
    """Build one case-insensitive regex. 'word' matches whole words, 'word*' matches any ending."""
    parts = []
    for raw in words or []:
        word = str(raw).strip()
        if not word:
            continue
        if word.endswith("*"):
            parts.append(r"\b" + re.escape(word[:-1]) + r"\w*")
        else:
            parts.append(r"\b" + re.escape(word) + r"\b")
    return re.compile("|".join(parts), re.IGNORECASE) if parts else None


def google_news_url(query: str, settings: dict, source: dict | None = None) -> str:
    gn = settings.get("google_news", {}) or {}
    source = source or {}
    lang = source.get("language") or gn.get("language", "en-GB")
    country = source.get("country") or gn.get("country", "GB")
    window = gn.get("window")
    q = f"{query} when:{window}" if window else query
    return (
        f"https://news.google.com/rss/search?q={quote_plus(q)}"
        f"&hl={lang}&gl={country}&ceid={country}:{lang.split('-')[0]}"
    )


def detect_site_url(settings: dict) -> str:
    if settings.get("site_url"):
        return settings["site_url"].rstrip("/") + "/"
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if "/" in repo:
        owner, name = repo.split("/", 1)
        owner = owner.lower()
        if name.lower() == f"{owner}.github.io":
            return f"https://{owner}.github.io/"
        return f"https://{owner}.github.io/{name}/"
    return ""


# --------------------------------------------------------------------------- tagging
class Tagger:
    def __init__(self, regulations: list[dict], relevance_keywords: list[str]):
        self.patterns = [
            (r["id"], keyword_regex(list(r.get("keywords", [])) + act_numbers(r.get("reference"))))
            for r in regulations
        ]
        self.patterns = [(rid, pat) for rid, pat in self.patterns if pat]
        self.relevance = keyword_regex(relevance_keywords)

    def tags(self, text: str) -> list[str]:
        return [rid for rid, pat in self.patterns if pat.search(text)]

    def is_relevant(self, text: str) -> bool:
        return bool(self.relevance and self.relevance.search(text))


# --------------------------------------------------------------------------- fetching
def download_feed(url: str, settings: dict):
    """Return the parsed feed. Raises if the answer is not a feed at all.

    Some servers answer automated requests with an empty page or a bot check and still report
    success. feedparser reads that as "a feed without entries", so the format is checked here:
    a real feed has a version (rss20, atom10, ...), a web page or an empty answer has none.
    """
    if url.startswith("file://"):
        parsed = feedparser.parse(Path(url[7:]).read_bytes())
        answer = "The file was read"
    else:
        parsed, response = None, None
        for agent in (USER_AGENT, READER_AGENT):
            response = requests.get(
                url,
                headers={"User-Agent": agent, "Accept": ACCEPT},
                timeout=settings.get("timeout_seconds", 25),
            )
            response.raise_for_status()
            parsed = feedparser.parse(response.content)
            if parsed.get("version") or parsed.entries:
                break
        kind = (response.headers.get("Content-Type") or "no content type").split(";")[0].strip()
        answer = f"The server answered (HTTP {response.status_code}, {kind}, {len(response.content)} bytes)"
    if not parsed.get("version") and not parsed.entries:
        raise ValueError(f"{answer} but did not send a feed. It is probably turning away automated requests.")
    if parsed.bozo and not parsed.entries:
        raise ValueError(f"Not a valid feed ({type(parsed.bozo_exception).__name__}).")
    return parsed


def describe_error(exc: Exception) -> str:
    if isinstance(exc, requests.HTTPError):
        return f"HTTP {exc.response.status_code}."
    if isinstance(exc, requests.Timeout):
        return "Timed out."
    if isinstance(exc, requests.ConnectionError):
        return "Could not connect."
    return str(exc)[:240] or type(exc).__name__


def fetch_source(source: dict, settings: dict) -> tuple[dict, list]:
    """Return (status, entries). Never raises.

    status["via"] is "feed", or "fallback" when the feed gave nothing and the source's
    fallback_query (a Google News search) was used instead.
    """
    url = source.get("url") or google_news_url(source["query"], settings, source)
    status = {
        "id": source["id"],
        "name": source.get("name", source["id"]),
        "kind": source.get("kind", "news"),
        "url": url,
        "ok": False,
        "error": None,
        "note": None,
        "via": "feed",
        "empty": False,
        "fetched": 0,
        "kept": 0,
    }
    entries: list = []
    try:
        entries = download_feed(url, settings).entries
        status["ok"] = True
        status["empty"] = not entries
    except Exception as exc:  # noqa: BLE001 - a broken feed must not stop the run
        status["error"] = describe_error(exc)

    if not entries and source.get("fallback_query") and source.get("url"):
        problem = status["error"] or "The feed is valid but lists no items."
        try:
            entries = download_feed(google_news_url(source["fallback_query"], settings, source), settings).entries
            status.update(
                ok=True, error=None, via="fallback", empty=not entries,
                note=f"The feed could not be used: {problem} A news search of the same site was used instead.",
            )
        except Exception as exc:  # noqa: BLE001
            status["note"] = f"The news-search fallback failed as well: {describe_error(exc)}"

    status["fetched"] = len(entries)
    return status, entries


def entry_to_item(entry, source: dict, seen_at: datetime, from_search: bool) -> dict | None:
    title = clean_text(entry.get("title"), 300)
    link = (entry.get("link") or "").strip()
    if not title or not link:
        return None

    publisher = None
    if from_search:
        # Google News titles look like "Headline - Publisher"
        src = entry.get("source") or {}
        publisher = (src.get("title") if isinstance(src, dict) else None) or None
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -len(publisher) - 3].rstrip()
        elif " - " in title:
            title, publisher = title.rsplit(" - ", 1)

    summary = clean_text(entry.get("summary") or entry.get("description"))
    # Google News summaries only repeat the title; drop anything that adds nothing.
    if normalise_title(summary).startswith(normalise_title(title)[:60]):
        summary = ""

    published = None
    for key in ("published_parsed", "updated_parsed"):
        struct = entry.get(key)
        if struct:
            published = datetime(*struct[:6], tzinfo=timezone.utc)
            break
    if published and published > seen_at + timedelta(days=1):
        published = None  # ignore dates in the future

    return {
        "id": hashlib.sha1(normalise_url(link).encode()).hexdigest()[:16],
        "title": title,
        "link": link,
        "summary": summary,
        "published": to_iso(published) if published else None,
        "source": source["id"],
        "publisher": publisher,
        "kind": source.get("kind", "news"),
    }


# --------------------------------------------------------------------------- reported developments
# News items that report a step in the legislative procedure (a vote, publication in the Official
# Journal, a postponement ...) are grouped into "developments" and shown on the timeline, marked
# as reported. The curated dates in regulations.json are never changed by this script.
#
# (id, pattern, needs_actor). needs_actor: the headline must also name an EU institution, which
# filters out company news such as "X adopts CSRD software".
DEVELOPMENT_GROUPS = [
    ("withdrawn", r"\b(withdraw(s|n|al|ing)?|withdrew|scrap(s|ped|ping)?|shelv(e|es|ed|ing)|abandon(s|ed|ing)?)\b", False),
    ("delay", r"\b(postpon\w+|delay(s|ed|ing)?|stop[- ]the[- ]clock|push(es|ed|ing)? back|deferr?(s|ed|al|ing)?)\b", False),
    ("legal", r"\b(official journal|enter(s|ed|ing)? into (force|application|effect)|c[oa]mes? into (force|effect)"
              r"|takes? effect|took effect|now in force|start(s|ed)? to apply|becomes? (mandatory|applicable|law))\b", False),
    ("decision", r"\b(adopt(s|ed|ion)|final (approval|adoption|green light|vote)|green[- ]?lights?|sign(s|ed) off"
                 r"|approv(es|ed|al)|endors(es|ed)|votes?|voted|plenary|backs|backed|rejects?|rejected"
                 r"|provisional (agreement|deal)|political agreement|trilogues?"
                 r"|reach(es|ed)? (a |an )?(deal|agreement|compromise)|str(ike|ikes|uck) (a )?deal"
                 r"|negotiating (mandate|position)|general approach)\b", True),
    ("proposal", r"\b(propos(es|ed|al|als)|unveil(s|ed)|draft|consultation|consults|call for evidence)\b", True),
    ("guidance", r"\b(guidance|guidelines|FAQs?|Q&A|delegated (act|regulation)|implementing (act|regulation)"
                 r"|technical standards)\b", True),
]
DEVELOPMENT_GROUPS = [(gid, re.compile(pat, re.IGNORECASE), actor) for gid, pat, actor in DEVELOPMENT_GROUPS]
NEW_ACT = re.compile(r"\b(amending|supplementing|repealing|correcting|corrigendum to)\b", re.IGNORECASE)
EU_ACTOR = re.compile(
    r"\b(EU|European (Commission|Parliament|Council|Union)|Commission|Parliament|MEPs?|Council|Brussels"
    r"|[Mm]ember [Ss]tates|EFRAG|ESMA|EBA|EIOPA|ESAs|lawmakers|co-legislators|trilogues?|ministers"
    r"|ECON|ENVI|JURI|Official Journal)\b"
)
# Explainers and marketing repeat old milestones for months; they are not news about a new step.
NOT_NEWS = re.compile(
    r"\b(webinar|podcast|explained|explainer|guide|what you need to know|how to|tracker|checklist|opinion"
    r"|interview|sponsored|white ?paper|market (size|report)|whitepaper|recap|roundup|round-up)\b|\?",
    re.IGNORECASE,
)
MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"])}
MONTH_RE = "|".join(MONTHS)
DATE_PATTERNS = [
    (re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)? ({MONTH_RE}),? (20\d\d)\b", re.IGNORECASE), ("d", "m", "y")),
    (re.compile(rf"\b({MONTH_RE}) (\d{{1,2}})(?:st|nd|rd|th)?, (20\d\d)\b", re.IGNORECASE), ("m", "d", "y")),
    (re.compile(rf"\b({MONTH_RE}) (20\d\d)\b", re.IGNORECASE), ("m", "y")),
]


def item_time(item: dict) -> datetime | None:
    return from_iso(item.get("published")) or from_iso(item.get("first_seen"))


def mentioned_dates(text: str, after: datetime) -> list[str]:
    """Dates named in a headline that lie after the article itself, as YYYY-MM-DD or YYYY-MM."""
    found, taken = [], []
    for pattern, order in DATE_PATTERNS:
        for match in pattern.finditer(text):
            if any(match.start() < end and match.end() > start for start, end in taken):
                continue  # already read as part of a longer date
            taken.append(match.span())
            parts = dict(zip(order, match.groups()))
            year, month = int(parts["y"]), MONTHS[parts["m"].lower()]
            day = int(parts["d"]) if "d" in parts else None
            try:
                moment = datetime(year, month, day or 28, tzinfo=timezone.utc)
            except ValueError:
                continue
            if moment <= after:
                continue
            value = f"{year:04d}-{month:02d}" + (f"-{day:02d}" if day else "")
            if value not in found:
                found.append(value)
    return found


def classify_development(item: dict, tagger: Tagger) -> tuple[str, list[str], bool] | None:
    """Return (group, regulation ids, strong) if the item reports a procedure step, else None.

    Only regulations named in the headline count (for official sources: headline or teaser), so
    the fallback tags of a news search never create a timeline entry on their own.
    """
    official = item.get("kind") == "official"
    title = item["title"]
    text = f"{title} {item.get('summary', '')}" if official else title
    # Official items were tagged from their full text, which may name the regulation further down.
    regs = tagger.tags(text) or (item.get("tags", []) if official else [])
    if not regs or NOT_NEWS.search(title):
        return None
    has_actor = official or bool(EU_ACTOR.search(title))
    if official and NEW_ACT.search(title):
        return "legal", regs, True  # a new act in an official feed that amends or supplements a tracked one
    for group, pattern, needs_actor in DEVELOPMENT_GROUPS:
        if pattern.search(text):
            if needs_actor and not has_actor:
                return None
            return group, regs, has_actor
    return None


def update_developments(stored: list[dict], items: list[dict], tagger: Tagger,
                        source_names: dict, settings: dict, run_at: datetime) -> list[dict]:
    """Add newly collected items to the stored developments and return the updated list."""
    conf = settings.get("developments", {}) or {}
    if conf.get("enabled", True) is False:
        return stored
    window = timedelta(days=int(conf.get("window_days", 10)))
    min_reports = int(conf.get("min_reports", 2))
    cutoff = run_at - timedelta(days=int(conf.get("max_age_days", 730)))

    devs = [d for d in stored if d.get("sources")]
    known = {src["item"] for d in devs for src in d["sources"]}

    for item in sorted(items, key=lambda it: item_time(it) or run_at):
        if item["id"] in known:
            continue
        found = classify_development(item, tagger)
        when = item_time(item)
        if not found or not when:
            continue
        group, regs, strong = found
        origin = item.get("publisher") or source_names.get(item["source"], item["source"])
        source = {
            "item": item["id"], "title": item["title"], "link": item["link"], "origin": origin,
            "published": to_iso(when), "official": item.get("kind") == "official", "strong": strong,
            "regs": regs,
            "mentions": mentioned_dates(f"{item['title']} {item.get('summary', '')}", when)
            if group in ("delay", "legal", "decision") else [],
        }
        target = next(
            (d for d in devs
             if d["group"] == group
             and {r for s in d["sources"] for r in s["regs"]} & set(regs)
             and abs(from_iso(d["sources"][0]["published"]) - when) <= window),
            None,
        )
        if target:
            target["sources"].append(source)
            target["updated"] = to_iso(run_at)
        else:
            devs.append({
                "id": hashlib.sha1(f"{group}|{item['id']}".encode()).hexdigest()[:12],
                "group": group, "sources": [source],
                "first_seen": to_iso(run_at), "updated": to_iso(run_at),
            })
        known.add(item["id"])

    result = []
    for dev in devs:
        sources = sorted(dev["sources"], key=lambda s: s["published"])
        if from_iso(sources[-1]["published"]) < cutoff:
            continue
        # The headline shown: an official source if there is one, else the first that names an EU institution.
        lead = next((s for s in sources if s["official"]), None) or next((s for s in sources if s["strong"]), sources[0])
        counts: dict[str, int] = {}
        for src in sources:
            for reg in src["regs"]:
                counts[reg] = counts.get(reg, 0) + 1
        regs = [r for r in counts if r in lead["regs"] or counts[r] >= 2]
        publishers = {s["origin"].lower() for s in sources}
        strong_publishers = {s["origin"].lower() for s in sources if s["strong"]}
        official = any(s["official"] for s in sources)
        mentions = []
        for src in sources:
            for date in src["mentions"]:
                if date not in mentions:
                    mentions.append(date)
        dev.update(
            sources=sources, date=lead["published"][:10], regs=regs,
            title=lead["title"], link=lead["link"], origin=lead["origin"],
            official=official, publishers=len(publishers), mentions=mentions,
            # Shown on the website only when it is more than a single report.
            visible=official or len(strong_publishers) >= min_reports or len(publishers) >= min_reports + 1,
        )
        result.append(dev)
    result.sort(key=lambda d: d["date"], reverse=True)
    return result


# --------------------------------------------------------------------------- main
def read_json(path: Path, label: str) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print(f"::warning::{label} was unreadable and has been rebuilt")
        return {}


def main() -> int:
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    settings = config.get("settings", {}) or {}
    sources = config.get("sources", []) or []
    regulations = json.loads(REGS_PATH.read_text(encoding="utf-8"))["regulations"]
    reg_ids = {r["id"] for r in regulations}
    tagger = Tagger(regulations, config.get("relevance_keywords", []))

    previous = read_json(NEWS_PATH, "news.json")
    items = {item["id"]: item for item in previous.get("items", [])}
    previous_status = {s["id"]: s for s in previous.get("sources", [])}

    run_at = now_utc()
    source_by_id = {s["id"]: s for s in sources}
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda s: fetch_source(s, settings), sources))

    statuses = []
    for status, entries in results:
        source = source_by_id[status["id"]]
        mode = source.get("filter", "relevant")
        fallback = [t for t in source.get("tags", []) or [] if t in reg_ids]
        from_search = bool(source.get("query")) or status["via"] == "fallback"
        for entry in entries:
            item = entry_to_item(entry, source, run_at, from_search)
            if not item:
                continue
            text = entry_full_text(entry)
            tags = tagger.tags(text)
            if mode == "regulations" and not tags:
                continue
            if mode == "relevant" and not tags and not tagger.is_relevant(text):
                continue
            item["tags"] = tags or fallback
            # A search result that names no tracked regulation is only loosely related.
            item["weak"] = from_search and not tags
            existing = items.get(item["id"])
            item["first_seen"] = existing["first_seen"] if existing else to_iso(run_at)
            for key in ("ai", "ai_tries"):  # keep the AI review of an item that is collected again
                if existing and key in existing:
                    item[key] = existing[key]
            items[item["id"]] = item
            status["kept"] += 1

        prev = previous_status.get(status["id"], {})
        status["checked_at"] = to_iso(run_at)
        status["last_ok"] = to_iso(run_at) if status["ok"] else prev.get("last_ok")
        statuses.append(status)
        if not status["ok"]:
            print(f"::warning title=Feed failed::{status['name']}: {status['error']}")
        else:
            if status["via"] == "fallback":
                print(f"::warning title=Feed replaced by news search::{status['name']}: {status['note']}")
            elif status["empty"]:
                print(f"::warning title=Feed is empty::{status['name']}: the feed is valid but lists no items")
            print(f"ok   {status['id']:<22} fetched {status['fetched']:>3}  kept {status['kept']:>3}  ({status['via']})")

    # Re-tag stored items (keywords may have changed) and drop anything too old.
    cutoff = run_at - timedelta(days=int(settings.get("max_age_days", 150)))
    kept, seen_titles = [], set()

    def sort_key(it):
        return from_iso(it.get("published")) or from_iso(it.get("first_seen")) or run_at

    for item in sorted(items.values(), key=sort_key, reverse=True):
        if sort_key(item) < cutoff:
            continue
        key = normalise_title(item["title"])
        if key in seen_titles:  # same story from several outlets
            continue
        seen_titles.add(key)
        tags = tagger.tags(f"{item['title']} {item.get('summary', '')}")
        if tags:
            item["tags"] = tags
        kept.append(item)
    kept = kept[: int(settings.get("max_items", 800))]

    stored_counts: dict[str, int] = {}
    for item in kept:
        stored_counts[item["source"]] = stored_counts.get(item["source"], 0) + 1
    for status in statuses:
        status["stored"] = stored_counts.get(status["id"], 0)

    source_names = {s["id"]: s["name"] for s in statuses}
    NEWS_PATH.write_text(
        json.dumps(
            {
                "generated_at": to_iso(run_at),
                # Lets the website link straight to the file to edit when a development needs confirming.
                "repository": os.environ.get("GITHUB_REPOSITORY") or None,
                "branch": os.environ.get("GITHUB_REF_NAME") or None,
                "sources": statuses,
                "items": kept,
            },
            ensure_ascii=False, indent=1,
        ),
        encoding="utf-8",
    )

    stored_devs = read_json(DEVS_PATH, "developments.json").get("items", [])
    developments = update_developments(stored_devs, kept, tagger, source_names, settings, run_at)
    DEVS_PATH.write_text(
        json.dumps({"generated_at": to_iso(run_at), "items": developments}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )

    write_rss(kept[:60], regulations, source_names, settings, run_at)
    write_calendar(regulations, settings, run_at)

    ok = sum(1 for s in statuses if s["ok"])
    shown = sum(1 for d in developments if d.get("visible"))
    print(f"\n{ok}/{len(statuses)} sources ok, {len(kept)} items stored, "
          f"{shown} reported developments on the timeline ({len(developments) - shown} more with a single report).")
    return 0


def write_rss(items: list[dict], regulations: list[dict], source_names: dict, settings: dict, run_at: datetime) -> None:
    short = {r["id"]: r["short"] for r in regulations}
    site_url = detect_site_url(settings)
    title = settings.get("site_title", "EU ESG Tracker")

    rss = ET.Element("rss", version="2.0")
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = f"{title}: latest updates"
    ET.SubElement(channel, "link").text = site_url or "https://github.com"
    ET.SubElement(channel, "description").text = "New EU ESG regulatory updates collected from official and news sources."
    ET.SubElement(channel, "language").text = "en"
    ET.SubElement(channel, "lastBuildDate").text = format_datetime(run_at)

    for item in items:
        labels = [short[t] for t in item.get("tags", []) if t in short]
        node = ET.SubElement(channel, "item")
        prefix = f"[{', '.join(labels)}] " if labels else ""
        ET.SubElement(node, "title").text = prefix + item["title"]
        ET.SubElement(node, "link").text = item["link"]
        guid = ET.SubElement(node, "guid", isPermaLink="false")
        guid.text = item["id"]
        date = from_iso(item.get("published")) or from_iso(item.get("first_seen")) or run_at
        ET.SubElement(node, "pubDate").text = format_datetime(date)
        origin = item.get("publisher") or source_names.get(item["source"], item["source"])
        ET.SubElement(node, "description").text = " ".join(x for x in (item.get("summary"), f"Source: {origin}.") if x)
        for label in labels:
            ET.SubElement(node, "category").text = label

    ET.indent(rss)
    FEED_PATH.write_bytes(ET.tostring(rss, encoding="utf-8", xml_declaration=True))


def ics_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def ics_fold(line: str) -> str:
    """Calendar files limit lines to 75 bytes; longer ones continue on the next line after a space."""
    out, current = [], ""
    for char in line:
        if len((current + char).encode("utf-8")) > 73:
            out.append(current)
            current = " " + char
        else:
            current += char
    out.append(current)
    return "\r\n".join(out)


def write_calendar(regulations: list[dict], settings: dict, run_at: datetime) -> None:
    """All curated dates with a known day, from 30 days ago onwards, as all-day events."""
    site_url = detect_site_url(settings)
    title = settings.get("site_title", "EU ESG Tracker")
    earliest = (run_at - timedelta(days=30)).strftime("%Y-%m-%d")
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//EU ESG Tracker//EN", "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH", f"X-WR-CALNAME:{ics_escape(title)}", "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
        "X-PUBLISHED-TTL:PT12H",
    ]
    stamp = run_at.strftime("%Y%m%dT%H%M%SZ")
    for reg in regulations:
        for entry in reg.get("dates", []):
            date = entry.get("date", "")
            if len(date) != 10 or date < earliest:
                continue  # month-only dates are not fixed yet
            start = datetime.strptime(date, "%Y-%m-%d")
            uid = hashlib.sha1(f"{reg['id']}|{date}|{entry.get('label', '')}".encode()).hexdigest()[:20]
            label = entry.get("label", "")
            summary = f"{reg['short']} {label}" + (" (expected)" if entry.get("approx") else "")
            description = f"{reg['name']}. {reg.get('status', '')}"
            lines += [
                "BEGIN:VEVENT", f"UID:{uid}@eu-esg-tracker", f"DTSTAMP:{stamp}",
                f"DTSTART;VALUE=DATE:{start.strftime('%Y%m%d')}",
                f"DTEND;VALUE=DATE:{(start + timedelta(days=1)).strftime('%Y%m%d')}",
                f"SUMMARY:{ics_escape(summary)}", f"DESCRIPTION:{ics_escape(description)}",
            ]
            if site_url:
                lines.append(f"URL:{site_url}#/regulation/{reg['id']}")
            lines += ["TRANSP:TRANSPARENT", "END:VEVENT"]
    lines.append("END:VCALENDAR")
    CALENDAR_PATH.write_bytes(("\r\n".join(ics_fold(line) for line in lines) + "\r\n").encode("utf-8"))


if __name__ == "__main__":
    sys.exit(main())
