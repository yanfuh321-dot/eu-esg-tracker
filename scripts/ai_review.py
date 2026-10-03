#!/usr/bin/env python3
"""Optional AI review for the EU ESG Tracker, using the Google Gemini API.

Runs after fetch_feeds.py and only when the environment has GEMINI_API_KEY (a repository secret).
Without a key it does nothing and the tracker works as before. A failure in here never stops the
workflow: every task is wrapped, and problems are reported as warnings.

What it does
  1. Review   every new item in news.json gets a verdict: relevant or not for the reader described
              in site/data/profile.json, how important, which regulations, and a one-line note.
  2. Briefing once a day, a short "what changed, what it means, what to do" for the website
              (site/data/briefing.json).
  3. Propose  once a day, changes to the curated data in regulations.json where the news shows it
              is out of date, and corrections to learning pages that contradict that data.
              Proposals are NOT applied. They are written to .ai/ and the workflow turns them into
              a pull request; the data changes only when you merge it.

Reads   config/sources.yml (settings.ai), site/data/*.json, site/data/learn/*.json
Writes  site/data/news.json (adds "ai" to items), site/data/briefing.json,
        site/data/proposals.json, site/data/ai_state.json, and .ai/ (proposed files + PR text)

Only public information is sent to the API: headlines, the tracker's own data and the profile.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
CONFIG_PATH = ROOT / "config" / "sources.yml"
REGS_PATH = DATA / "regulations.json"
NEWS_PATH = DATA / "news.json"
DEVS_PATH = DATA / "developments.json"
PROFILE_PATH = DATA / "profile.json"
LEARN_DIR = DATA / "learn"
BRIEFING_PATH = DATA / "briefing.json"
PROPOSALS_PATH = DATA / "proposals.json"
STATE_PATH = DATA / "ai_state.json"
OUT_DIR = ROOT / ".ai"

API = "https://generativelanguage.googleapis.com/v1beta"
FALLBACK_MODEL = "gemini-2.5-flash"
STAGES = ["Proposed", "Negotiating", "Adopted", "In force", "Applies"]
FLAGS = {"amended", "revision", "stalled", None}
DATE_RE = re.compile(r"^\d{4}-\d{2}(-\d{2})?$")


def warn(message: str) -> None:
    print(f"::warning title=AI review::{message}")


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def clip(text, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


def parse_json(text: str):
    """Models wrap JSON in code fences or add a sentence around it; find the JSON anyway."""
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        raise ValueError("no JSON in the answer")
    start = min(starts)
    end = max(text.rfind("}"), text.rfind("]"))
    return json.loads(text[start:end + 1])


# --------------------------------------------------------------------------- Gemini
class Unavailable(Exception):
    """The model cannot answer right now (overloaded, over quota, unknown): try the next one."""


class Gemini:
    PAUSE = 13  # seconds between calls, which keeps even a five-requests-per-minute quota

    def __init__(self, key: str, model: str, use_search: bool, preferred: str | None, minutes: float):
        self.key = key
        self.use_search = use_search
        self.calls = 0
        self.last_call = 0.0
        self.deadline = time.time() + minutes * 60
        if model in ("", "auto", None):
            self.models = self.list_models()
            if preferred in self.models:  # the model that worked on the last run goes first
                self.models.remove(preferred)
                self.models.insert(0, preferred)
        else:
            self.models = [model]
        self.model = self.models[0]

    def list_models(self) -> list[str]:
        """Flash models this key can use, newest first, then the lighter Flash-Lite models.

        The newest model is often overloaded or has no free quota, so the others serve as fallbacks.
        """
        found = []
        try:
            res = requests.get(f"{API}/models", params={"pageSize": 1000}, headers={"x-goog-api-key": self.key}, timeout=30)
            res.raise_for_status()
            for entry in res.json().get("models", []):
                if "generateContent" not in entry.get("supportedGenerationMethods", []):
                    continue
                match = re.fullmatch(r"models/gemini-(\d+(?:\.\d+)?)-flash(-lite)?", entry.get("name", ""))
                if match:
                    found.append((bool(match.group(2)), -float(match.group(1)), entry["name"].split("/", 1)[1]))
        except Exception as exc:  # noqa: BLE001
            warn(f"Could not list models ({clip(exc, 120)}); using {FALLBACK_MODEL}.")
        names = [name for _, _, name in sorted(found)][:6]
        return names or [FALLBACK_MODEL]

    def post(self, model: str, body: dict):
        if time.time() > self.deadline:
            raise TimeoutError("the time budget for the AI review is used up; the rest follows on the next run")
        wait = self.PAUSE - (time.time() - self.last_call)
        if self.calls and wait > 0:
            time.sleep(wait)
        self.calls += 1
        self.last_call = time.time()
        return requests.post(f"{API}/models/{model}:generateContent", json=body, headers={"x-goog-api-key": self.key}, timeout=120)

    @staticmethod
    def reason(res) -> str:
        try:
            message = res.json()["error"]["message"]
        except Exception:  # noqa: BLE001
            message = res.text
        return f"HTTP {res.status_code}: {clip(message, 180)}"

    def ask(self, model: str, system: str, prompt: str, search: bool):
        body = {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 8192},
        }
        if search:
            body["tools"] = [{"google_search": {}}]
        else:
            body["generationConfig"]["responseMimeType"] = "application/json"
        res = self.post(model, body)
        if res.status_code in (429, 500, 503):
            time.sleep(20)  # one more try: brief overloads and per-minute limits pass quickly
            res = self.post(model, body)
        if res.status_code in (400, 429) and search:
            # Search grounding has its own, smaller quota and is not available for every key.
            warn(f"Google Search could not be used ({self.reason(res)}); continuing without it.")
            self.use_search = False
            return self.ask(model, system, prompt, search=False)
        if res.status_code in (404, 429, 500, 503):
            raise Unavailable(self.reason(res))
        if not res.ok:
            raise RuntimeError(self.reason(res))
        data = res.json()
        candidate = (data.get("candidates") or [{}])[0]
        parts = (candidate.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        if not text.strip():
            raise ValueError(f"empty answer (finish reason: {candidate.get('finishReason')})")
        chunks = (candidate.get("groundingMetadata") or {}).get("groundingChunks") or []
        sources = [c["web"]["uri"] for c in chunks if c.get("web", {}).get("uri")]
        return parse_json(text), sources

    def generate(self, system: str, prompt: str, search: bool = False):
        """Return (parsed JSON, list of source URLs the model consulted).

        If the current model is overloaded or over its quota, the next one in the list takes over
        for the rest of the run.
        """
        while True:
            try:
                return self.ask(self.model, system, prompt, search and self.use_search)
            except Unavailable as exc:
                position = self.models.index(self.model)
                if position + 1 >= len(self.models):
                    raise RuntimeError(f"no model could answer; last error from {self.model}: {exc}") from exc
                following = self.models[position + 1]
                warn(f"{self.model} is not available ({exc}); switching to {following}.")
                self.model = following


class FakeModel:
    """For tests: answers come from a JSON file, keyed by task name (AI_FAKE=path)."""

    def __init__(self, path: str):
        self.answers = json.loads(Path(path).read_text(encoding="utf-8"))
        self.model, self.use_search, self.calls = "fake", True, 0

    def generate(self, system: str, prompt: str, search: bool = False):
        self.calls += 1
        task = re.search(r"TASK: (\w+)", system).group(1)
        return copy.deepcopy(self.answers.get(task, {})), ["https://example.org/source"] if search else []


# --------------------------------------------------------------------------- shared context
def profile_text(profile: dict) -> str:
    if not profile:
        return "No reader profile is configured; judge relevance for a general EU sustainability professional."
    facts = "\n".join(f"- {f}" for f in profile.get("facts", []))
    return f"Reader profile: {profile.get('summary', '')}\n{facts}"


def regulation_index(regs: list[dict], profile: dict) -> str:
    levels = {k: v.get("level", "background") for k, v in (profile.get("regulations") or {}).items()}
    return "\n".join(
        f"- {r['id']}: {r['short']} ({r['name']}; {r.get('jurisdiction', 'EU')}); relevance for the reader: {levels.get(r['id'], 'unknown')}"
        for r in regs
    )


def item_time(item: dict) -> str:
    return item.get("published") or item.get("first_seen") or ""


# --------------------------------------------------------------------------- 1. review new items
REVIEW_SYSTEM = """TASK: review
You screen news headlines for a regulatory tracker on EU, German and Chinese sustainability and product law.
{profile}

Tracked regulations:
{regs}

For every headline decide:
- relevant: true if it is about one of the tracked regulations or its subject matter as it affects the reader. false for a different meaning of an abbreviation, unrelated countries, market-size reports, advertising, event announcements.
- importance: 3 = a change of law, date, scope or official guidance on a regulation that is "direct", "indirect" or "watch" for the reader; 2 = an official step or solid news on any tracked regulation; 1 = commentary, explainers, opinion; 0 = not relevant.
- regs: ids of the tracked regulations it concerns (may be empty).
- note: one plain sentence of at most 25 words saying what happened and, if clear, why it matters to the reader. Use only what the headline supports. No speculation, no hype.

Answer with JSON only: {{"items": [{{"n": 1, "relevant": true, "importance": 2, "regs": ["cbam"], "note": "..."}}]}} with one entry per headline, using its number."""


def review_items(model, news: dict, regs: list[dict], profile: dict, conf: dict) -> int:
    reg_ids = {r["id"] for r in regs}
    todo = [it for it in news.get("items", []) if "ai" not in it and it.get("ai_tries", 0) < 2][: int(conf.get("max_items_per_run", 80))]
    system = REVIEW_SYSTEM.format(profile=profile_text(profile), regs=regulation_index(regs, profile))
    done = 0
    for start in range(0, len(todo), 40):
        batch = todo[start:start + 40]
        lines = [f"{n}. {it['title']} [{it.get('publisher') or it.get('source')}, {item_time(it)[:10]}]" for n, it in enumerate(batch, 1)]
        try:
            answer, _ = model.generate(system, "Headlines:\n" + "\n".join(lines))
        except Exception as exc:  # noqa: BLE001
            warn(f"Reviewing news items failed: {clip(exc, 200)}")
            break
        rows = answer.get("items", []) if isinstance(answer, dict) else answer
        for row in rows if isinstance(rows, list) else []:
            try:
                item = batch[int(row["n"]) - 1]
            except (KeyError, ValueError, IndexError, TypeError):
                continue
            relevant = bool(row.get("relevant"))
            importance = max(0, min(3, int(row.get("importance") or 0))) if relevant else 0
            item["ai"] = {
                "relevant": relevant,
                "importance": importance,
                "regs": [r for r in row.get("regs") or [] if r in reg_ids],
                "note": clip(row.get("note"), 220) if relevant else "",
            }
            item.pop("ai_tries", None)
            done += 1
        for item in batch:
            if "ai" not in item:  # the model skipped it; try once more on the next run, then leave it
                item["ai_tries"] = item.get("ai_tries", 0) + 1
    return done


# --------------------------------------------------------------------------- 2. briefing
BRIEFING_SYSTEM = """TASK: briefing
You write a short briefing for one reader of a regulatory tracker.
{profile}

Today is {today}. You receive the important news items of the last {days} days, procedure steps reported in the news, and the next curated deadlines.
Write for a practitioner: concrete, calm, no filler, British English. Say plainly when something is only reported or proposed and not yet law. Never present a date or decision as fact unless the material or a source you checked supports it. If little happened, say so in one sentence and return few or no items.

Answer with JSON only:
{{"headline": "at most 12 words",
  "summary": "two or three sentences, at most 60 words",
  "items": [{{"title": "at most 12 words", "regs": ["id"], "what": "what happened, at most 40 words", "meaning": "what it means for this reader, at most 40 words", "action": "what to do now, at most 25 words, or empty", "sources": ["ids of the news items used, as given"]}}],
  "watch": ["up to three things to keep an eye on in the coming weeks, one sentence each"]}}
At most five items, most important first. Only use regulation ids from the material."""


def write_briefing(model, news: dict, devs: list[dict], regs: list[dict], profile: dict, conf: dict, run_at: datetime) -> bool:
    days = int(conf.get("briefing_days", 7))
    since = iso(run_at - timedelta(days=days))
    levels = {k: v.get("level") for k, v in (profile.get("regulations") or {}).items()}
    by_id = {it["id"]: it for it in news.get("items", [])}
    important = [
        it for it in news.get("items", [])
        if item_time(it) >= since and (it.get("ai") or {}).get("relevant") and it["ai"]["importance"] >= 2
    ]
    important.sort(key=lambda it: (it["ai"]["importance"], item_time(it)), reverse=True)
    material = {
        "news": [
            {"id": it["id"], "date": item_time(it)[:10], "title": it["title"], "publisher": it.get("publisher") or it.get("source"),
             "regs": it["ai"]["regs"] or it.get("tags", []), "importance": it["ai"]["importance"], "note": it["ai"]["note"]}
            for it in important[:45]
        ],
        "reported_steps": [
            {"date": d["date"], "kind": d["group"], "regs": d["regs"], "headline": d["title"], "sources": d.get("publishers"), "official": d.get("official")}
            for d in devs if d.get("visible") and d["date"] >= (run_at - timedelta(days=14)).strftime("%Y-%m-%d")
        ],
        "deadlines": sorted(
            [
                {"date": e["date"], "reg": r["id"], "what": f"{r['short']} {e['label']}", "expected_only": bool(e.get("approx"))}
                for r in regs if levels.get(r["id"], "direct") != "background"
                for e in r.get("dates", [])
                if run_at.strftime("%Y-%m") <= e["date"][:7] and e["date"] <= (run_at + timedelta(days=120)).strftime("%Y-%m-%d")
            ],
            key=lambda x: x["date"],
        )[:12],
    }
    system = BRIEFING_SYSTEM.format(profile=profile_text(profile), today=run_at.strftime("%-d %B %Y"), days=days)
    try:
        answer, sources = model.generate(system, json.dumps(material, ensure_ascii=False), search=True)
    except Exception as exc:  # noqa: BLE001
        warn(f"Writing the briefing failed: {clip(exc, 200)}")
        return False
    if not isinstance(answer, dict):
        warn("The briefing answer had an unexpected shape and was discarded.")
        return False
    reg_ids = {r["id"] for r in regs}
    items = []
    for row in (answer.get("items") or [])[:5]:
        if not isinstance(row, dict) or not row.get("title"):
            continue
        links = [
            {"title": by_id[s]["title"], "link": by_id[s]["link"], "origin": by_id[s].get("publisher") or by_id[s].get("source")}
            for s in row.get("sources") or [] if s in by_id
        ][:4]
        items.append({
            "title": clip(row["title"], 120), "regs": [r for r in row.get("regs") or [] if r in reg_ids],
            "what": clip(row.get("what"), 320), "meaning": clip(row.get("meaning"), 320),
            "action": clip(row.get("action"), 220), "sources": links,
        })
    write_json(BRIEFING_PATH, {
        "generated_at": iso(run_at), "model": model.model, "days": days, "checked_with_search": bool(sources),
        "headline": clip(answer.get("headline"), 140), "summary": clip(answer.get("summary"), 500),
        "items": items, "watch": [clip(w, 240) for w in (answer.get("watch") or [])[:3] if w],
        "based_on": len(material["news"]),
    })
    return True


# --------------------------------------------------------------------------- 3. proposals for regulations.json
PROPOSAL_SYSTEM = """TASK: proposals
You maintain the curated data of a regulatory tracker. Today is {today}.
For each regulation you receive the curated entry (stage, flag, status text, key dates) and the recent news about it.
Find curated data that is now outdated, wrong or missing a key date. Typical cases: an expected step has happened, a date was postponed or fixed, an act was adopted or published, the status text describes a situation that has changed.

Rules
- Propose a change only if an official source, or at least two independent reliable sources, support it. Give their URLs. If you can search the web, verify there first and prefer EUR-Lex, the Commission, Parliament, Council, national gazettes and ministries.
- If you are not sure, propose nothing. An empty list is a good answer.
- Do not propose style changes, and do not repeat what the curated data already says.
- Stages: 0 Proposed, 1 Negotiating, 2 Adopted, 3 In force, 4 Applies. Flags: amended, revision, stalled or null.
- Dates are YYYY-MM-DD, or YYYY-MM when only the month is known. Labels are lower case and continue the short name, like "enters into force" or "applies to large companies".
- Status texts are one to three plain sentences, at most 300 characters.

Answer with JSON only:
{{"proposals": [{{"reg": "id", "type": "add_date | change_date | remove_date | set_status | set_stage | set_flag",
  "date": "for add_date and change_date: the new date; for remove_date: the date to remove",
  "old_date": "for change_date: the curated date being replaced", "label": "for add_date and change_date",
  "approx": false, "status": "for set_status", "stage": 0, "flag": "for set_flag",
  "reason": "one or two sentences", "sources": ["https://..."], "confidence": "high | medium"}}]}}
At most six proposals."""


def fingerprint(p: dict) -> str:
    key = {"add_date": p.get("date"), "change_date": f"{p.get('old_date')}>{p.get('date')}", "remove_date": p.get("date"),
           "set_status": "status", "set_stage": p.get("stage"), "set_flag": p.get("flag")}[p["type"]]
    return hashlib.sha1(f"{p['reg']}|{p['type']}|{key}".encode()).hexdigest()[:14]


def valid_proposal(p, by_id: dict) -> dict | None:
    """Strict check of one model proposal; returns a clean copy or None."""
    if not isinstance(p, dict) or p.get("reg") not in by_id:
        return None
    kind = str(p.get("type", "")).strip()
    sources = [s for s in p.get("sources") or [] if isinstance(s, str) and s.startswith("http")][:5]
    if kind not in ("add_date", "change_date", "remove_date", "set_status", "set_stage", "set_flag") or not sources:
        return None
    clean = {"reg": p["reg"], "type": kind, "reason": clip(p.get("reason"), 400), "sources": sources,
             "confidence": "high" if p.get("confidence") == "high" else "medium"}
    dates = {d["date"] for d in by_id[p["reg"]].get("dates", [])}
    if kind in ("add_date", "change_date"):
        if not DATE_RE.match(str(p.get("date", ""))) or not p.get("label"):
            return None
        clean.update(date=p["date"], label=clip(p["label"], 160), approx=bool(p.get("approx")))
        if kind == "change_date":
            if p.get("old_date") not in dates:
                return None
            clean["old_date"] = p["old_date"]
    elif kind == "remove_date":
        if p.get("date") not in dates:
            return None
        clean["date"] = p["date"]
    elif kind == "set_status":
        if not p.get("status") or len(str(p["status"])) > 500:
            return None
        clean["status"] = clip(p["status"], 500)
    elif kind == "set_stage":
        if not isinstance(p.get("stage"), int) or not 0 <= p["stage"] <= 4:
            return None
        clean["stage"] = p["stage"]
    elif kind == "set_flag":
        flag = p.get("flag") or None
        if flag not in FLAGS:
            return None
        clean["flag"] = flag
    return clean


def is_satisfied(p: dict, reg: dict) -> bool:
    """True if the curated data already contains what the proposal asks for."""
    dates = {d["date"] for d in reg.get("dates", [])}
    kind = p["type"]
    if kind == "add_date":
        return p["date"] in dates
    if kind == "change_date":
        return p["old_date"] not in dates or p["date"] in dates
    if kind == "remove_date":
        return p["date"] not in dates
    if kind == "set_status":
        return reg.get("status") == p["status"]
    if kind == "set_stage":
        return reg.get("stage") == p["stage"]
    return (reg.get("flag") or None) == p["flag"]


def apply_proposal(p: dict, reg: dict) -> None:
    kind = p["type"]
    entry = {"date": p.get("date"), "label": p.get("label")}
    if p.get("approx"):
        entry["approx"] = True
    if kind == "add_date":
        reg.setdefault("dates", []).append(entry)
    elif kind == "change_date":
        reg["dates"] = [entry if d["date"] == p["old_date"] else d for d in reg["dates"]]
    elif kind == "remove_date":
        reg["dates"] = [d for d in reg["dates"] if d["date"] != p["date"]]
    elif kind == "set_status":
        reg["status"] = p["status"]
    elif kind == "set_stage":
        reg["stage"] = p["stage"]
    elif kind == "set_flag":
        reg["flag"] = p["flag"]
    if "dates" in reg:
        reg["dates"].sort(key=lambda d: d["date"])


def describe(p: dict, reg: dict) -> str:
    kind = p["type"]
    if kind == "add_date":
        return f"Add the date {p['date']}{' (expected)' if p.get('approx') else ''}: “{reg['short']} {p['label']}”"
    if kind == "change_date":
        return f"Move the date {p['old_date']} to {p['date']}: “{reg['short']} {p['label']}”"
    if kind == "remove_date":
        old = next((d["label"] for d in reg.get("dates", []) if d["date"] == p["date"]), "")
        return f"Remove the date {p['date']}: “{reg['short']} {old}”"
    if kind == "set_status":
        return f"New status text: “{p['status']}”"
    if kind == "set_stage":
        return f"Change the stage from {STAGES[reg.get('stage', 0)]} to {STAGES[p['stage']]}"
    return f"Change the label from {reg.get('flag') or 'none'} to {p['flag'] or 'none'}"


def find_proposals(model, news: dict, devs: list[dict], regs: list[dict], profile: dict, run_at: datetime) -> list[dict]:
    levels = {k: v.get("level") for k, v in (profile.get("regulations") or {}).items()}
    since = iso(run_at - timedelta(days=21))
    evidence: dict[str, list] = {}
    for it in news.get("items", []):
        ai = it.get("ai") or {}
        if item_time(it) < since or not ai.get("relevant") or ai.get("importance", 0) < 2:
            continue
        for reg_id in ai.get("regs") or it.get("tags", []):
            evidence.setdefault(reg_id, []).append({"date": item_time(it)[:10], "title": it["title"], "publisher": it.get("publisher") or it.get("source"), "url": it["link"]})
    for d in devs:
        if d.get("visible") and d["date"] >= since[:10]:
            for reg_id in d["regs"]:
                evidence.setdefault(reg_id, []).append({"date": d["date"], "title": d["title"], "publisher": d.get("origin"), "url": d["link"], "reports": d.get("publishers")})
    today = run_at.strftime("%Y-%m-%d")
    chosen = []
    for r in regs:
        overdue = any(e.get("approx") and e["date"] <= today[: len(e["date"])] for e in r.get("dates", []))
        if evidence.get(r["id"]) or (overdue and levels.get(r["id"], "direct") != "background") or r.get("stage", 4) < 3:
            chosen.append(r)
    chosen = chosen[:16]
    if not chosen:
        return []
    material = [
        {"id": r["id"], "name": f"{r['short']} ({r['name']})", "stage": r.get("stage"), "flag": r.get("flag"), "status": r.get("status"),
         "dates": r.get("dates", []), "recent_news": evidence.get(r["id"], [])[:8]}
        for r in chosen
    ]
    system = PROPOSAL_SYSTEM.format(today=run_at.strftime("%-d %B %Y"))
    answer, sources = model.generate(system, json.dumps(material, ensure_ascii=False), search=True)
    rows = answer.get("proposals", []) if isinstance(answer, dict) else []
    by_id = {r["id"]: r for r in regs}
    out = []
    for row in rows[:6] if isinstance(rows, list) else []:
        clean = valid_proposal(row, by_id)
        if clean and not is_satisfied(clean, by_id[clean["reg"]]):
            clean["checked_with_search"] = bool(sources)
            out.append(clean)
    return out


# --------------------------------------------------------------------------- 4. learning pages against the data
LEARN_SYSTEM = """TASK: learncheck
You compare a learning page with the tracker's curated data for the same regulation. The curated data is the reference.
Report only statements on the learning page that contradict the curated data: a date, a threshold, a status ("is still a proposal" when it is adopted), a number. Ignore differences of style, detail or emphasis, and anything the curated data does not cover.

For each contradiction give the smallest replacement that fixes it:
- "old": text copied exactly from the learning page, a phrase or one sentence, long enough to occur only once on the page.
- "new": the corrected text, same style and length.
- "reason": which curated fact it contradicts.
Quiz answers must stay correct: if you change a fact that a quiz question tests, also give replacements for the affected option and explanation.

Answer with JSON only: {"edits": [{"old": "...", "new": "...", "reason": "..."}]}. At most five edits. If the page is consistent, return {"edits": []}."""


def entry_hash(reg: dict) -> str:
    core = {k: reg.get(k) for k in ("stage", "flag", "status", "scope", "summary", "dates", "reference")}
    return hashlib.sha1(json.dumps(core, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


def check_learning_pages(model, regs: list[dict], state: dict, conf: dict, run_at: datetime) -> list[dict]:
    """Return edits as {id, old, new, reason}; they are validated against the page text."""
    checked = state.setdefault("learn_checked", {})
    candidates = [r for r in regs if (LEARN_DIR / f"{r['id']}.json").exists()]
    # Pages whose regulation data changed since the last check come first, then the longest unchecked.
    candidates.sort(key=lambda r: (checked.get(r["id"], {}).get("hash") == entry_hash(r), checked.get(r["id"], {}).get("date", "")))
    edits = []
    for reg in candidates[: int(conf.get("learn_pages_per_day", 3))]:
        path = LEARN_DIR / f"{reg['id']}.json"
        raw = path.read_text(encoding="utf-8")
        page = json.loads(raw)
        material = {
            "curated": {k: reg.get(k) for k in ("short", "name", "reference", "stage", "flag", "status", "summary", "scope", "dates")},
            "stage_names": STAGES,
            "learning_page": {k: page.get(k) for k in ("essentials", "sections", "numbers", "mistakes", "practice", "quiz")},
        }
        try:
            answer, _ = model.generate(LEARN_SYSTEM, json.dumps(material, ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001
            warn(f"Checking the learning page for {reg['short']} failed: {clip(exc, 200)}")
            break  # the others would fail the same way; they are checked on a later run
        checked[reg["id"]] = {"hash": entry_hash(reg), "date": run_at.strftime("%Y-%m-%d")}
        for row in (answer.get("edits") or [])[:5] if isinstance(answer, dict) else []:
            if not isinstance(row, dict) or not row.get("old") or not row.get("new") or row["old"] == row["new"]:
                continue
            # The text must occur exactly once in the file, compared in its JSON-escaped form.
            old = json.dumps(row["old"], ensure_ascii=False)[1:-1]
            if raw.count(old) != 1:
                continue
            edits.append({"id": reg["id"], "old": row["old"], "new": clip(row["new"], 600), "reason": clip(row.get("reason"), 300)})
    return edits


def apply_learn_edits(edits: list[dict], run_at: datetime) -> list[str]:
    """Write edited copies of learning pages to .ai/learn/ and return the ids that changed."""
    changed = []
    for page_id in sorted({e["id"] for e in edits}):
        raw = (LEARN_DIR / f"{page_id}.json").read_text(encoding="utf-8")
        for edit in (e for e in edits if e["id"] == page_id):
            old = json.dumps(edit["old"], ensure_ascii=False)[1:-1]
            new = json.dumps(edit["new"], ensure_ascii=False)[1:-1]
            if raw.count(old) == 1:
                raw = raw.replace(old, new)
        try:
            page = json.loads(raw)
        except json.JSONDecodeError:
            continue
        page["reviewed"] = run_at.strftime("%Y-%m-%d")
        (OUT_DIR / "learn").mkdir(parents=True, exist_ok=True)
        write_json(OUT_DIR / "learn" / f"{page_id}.json", page)
        changed.append(page_id)
    return changed


# --------------------------------------------------------------------------- main
def main() -> int:
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    conf = (config.get("settings", {}) or {}).get("ai", {}) or {}
    fake = os.environ.get("AI_FAKE")
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if conf.get("enabled", True) is False or not (key or fake):
        print("AI review skipped: no GEMINI_API_KEY secret, or settings.ai.enabled is false.")
        return 0

    run_at = now_utc()
    regs_data = read_json(REGS_PATH, {})
    regs = regs_data.get("regulations", [])
    by_id = {r["id"]: r for r in regs}
    news = read_json(NEWS_PATH, {"items": []})
    devs = read_json(DEVS_PATH, {"items": []}).get("items", [])
    profile = read_json(PROFILE_PATH, {})
    state = read_json(STATE_PATH, {})
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)

    # If Google Search was refused recently, do not spend calls on trying it again for a week.
    week_ago = (run_at - timedelta(days=7)).strftime("%Y-%m-%d")
    want_search = bool(conf.get("use_search", True))
    use_search = want_search and state.get("search_refused", "") < week_ago
    model = FakeModel(fake) if fake else Gemini(
        key, conf.get("model", "auto"), use_search, state.get("model"), float(conf.get("max_minutes", 8)))
    print(f"AI review, starting with {model.model}" + (f" (fallbacks: {', '.join(model.models[1:])})" if len(getattr(model, 'models', [])) > 1 else ""))

    # 1. every run: review new items
    reviewed = review_items(model, news, regs, profile, conf)
    write_json(NEWS_PATH, news)
    print(f"reviewed {reviewed} new items")

    today = run_at.strftime("%Y-%m-%d")
    daily = state.get("last_daily") != today or os.environ.get("AI_FORCE") == "1"

    # Pull request bookkeeping. The workflow tells us whether the proposal PR is open.
    pending = [p for p in state.get("pending", []) if p.get("reg") in by_id and not is_satisfied(p, by_id[p["reg"]])]
    dismissed = {fp: day for fp, day in (state.get("dismissed") or {}).items()
                 if day >= (run_at - timedelta(days=int(conf.get("dismiss_days", 90)))).strftime("%Y-%m-%d")}
    pr_open = os.environ.get("AI_PR_OPEN", "")
    if pr_open == "0" and state.get("pr_seen_open"):
        # The PR was closed without all of its changes arriving in main: the rest was declined.
        for p in pending:
            dismissed[p["fp"]] = today
        pending = []
        state["learn_edits"] = []
        state["pr_seen_open"] = False
    elif pr_open not in ("", "0"):
        state["pr_seen_open"] = True

    learn_edits = state.get("learn_edits", [])
    if daily:
        briefed = write_briefing(model, news, devs, regs, profile, conf, run_at)
        if briefed:
            print("briefing written")
        if conf.get("propose_changes", True):
            try:
                for p in find_proposals(model, news, devs, regs, profile, run_at):
                    p["fp"] = fingerprint(p)
                    if p["fp"] in dismissed:
                        continue
                    pending = [q for q in pending if q["fp"] != p["fp"] and not (p["type"] == "set_status" and q["type"] == "set_status" and q["reg"] == p["reg"])]
                    p["proposed_on"] = today
                    pending.append(p)
            except Exception as exc:  # noqa: BLE001
                warn(f"Looking for outdated data failed: {clip(exc, 200)}")
            try:
                fresh = check_learning_pages(model, regs, state, conf, run_at)
                seen = {(e["id"], e["old"]) for e in fresh}
                learn_edits = fresh + [e for e in learn_edits if (e["id"], e["old"]) not in seen]
            except Exception as exc:  # noqa: BLE001
                warn(f"Checking learning pages failed: {clip(exc, 200)}")
        if briefed:
            state["last_daily"] = today  # otherwise the next run tries the daily tasks again

    # Drop stored learning-page edits that no longer match the page (merged, or the page changed).
    still = []
    for e in learn_edits:
        path = LEARN_DIR / f"{e['id']}.json"
        if path.exists() and path.read_text(encoding="utf-8").count(json.dumps(e["old"], ensure_ascii=False)[1:-1]) == 1:
            still.append(e)
    learn_edits = still

    # Build the proposed files and the pull request text.
    lines, listing = [], []
    if pending or learn_edits:
        OUT_DIR.mkdir(exist_ok=True)
        proposed = copy.deepcopy(regs_data)
        proposed_by_id = {r["id"]: r for r in proposed["regulations"]}
        lines += ["These changes were proposed by the AI review from the collected news. **Nothing has been changed yet.**",
                  "Check each one against its sources. Merge this pull request to apply all of them, edit the files in the branch to adjust, or close it to decline. Declined proposals are not made again for a while.", ""]
        if pending:
            lines.append("## Regulation data (`site/data/regulations.json`)")
        for p in pending:
            reg = by_id[p["reg"]]
            text = describe(p, reg)
            apply_proposal(p, proposed_by_id[p["reg"]])
            lines += [f"### {reg['short']}: {text}", "", p["reason"], "",
                      f"Confidence: {p['confidence']}. " + ("Checked with a web search." if p.get("checked_with_search") else "Not checked with a web search; based on headlines only."),
                      "", "Sources:"] + [f"- {s}" for s in p["sources"]] + [""]
            listing.append({"reg": p["reg"], "text": text, "reason": p["reason"], "sources": p["sources"], "confidence": p["confidence"],
                            "checked_with_search": bool(p.get("checked_with_search")), "proposed_on": p.get("proposed_on")})
        write_json(OUT_DIR / "regulations.json", proposed)
        changed_pages = apply_learn_edits(learn_edits, run_at) if learn_edits else []
        if changed_pages:
            lines.append("## Learning pages (`site/data/learn/`)")
            lines.append("The pages below contain statements that contradict the tracker data.")
            for e in learn_edits:
                if e["id"] in changed_pages:
                    lines += ["", f"### {by_id[e['id']]['short']}", f"- Was: {e['old']}", f"- Now: {e['new']}", f"- Why: {e['reason']}"]
        (OUT_DIR / "pr_body.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    write_json(PROPOSALS_PATH, {
        "generated_at": iso(run_at),
        "items": listing,
        "learn_edits": [{"id": e["id"], "old": e["old"], "new": e["new"], "reason": e["reason"]} for e in learn_edits],
    })
    if reviewed or state.get("last_daily") == today:
        state["model"] = model.model  # remembered, so the next run starts with a model that worked
    if use_search and not model.use_search:
        state["search_refused"] = run_at.strftime("%Y-%m-%d")
    state.update(pending=pending, dismissed=dismissed, learn_edits=learn_edits)
    write_json(STATE_PATH, state)
    print(f"{len(pending)} proposals for the regulation data, {len(learn_edits)} for learning pages; {model.calls} API calls, last model {model.model}.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - the AI step must never break the update
        warn(f"The AI review stopped with an error and was skipped: {clip(exc, 300)}")
        sys.exit(0)
