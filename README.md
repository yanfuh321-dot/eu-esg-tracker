# EU ESG Tracker

A self-updating overview of EU ESG regulation, with related EU product rules, German law and Chinese rules: where each file stands, which dates are coming up, what changed recently and what it means for the reader described in the profile. Runs entirely on GitHub (Actions + Pages), no server. The optional AI review uses the Google Gemini API, which has a free tier.

- **Overview**: countdown to the next firm date, "since your last visit" summary, and a procedure rail for every regulation (Proposed → Negotiating → Adopted → In force → Applies).
- **Timeline**: all key dates, past and upcoming, grouped by year. Procedure steps reported in the news (votes, adoptions, publications, delays) are added automatically and marked as reported.
- **Updates**: news collected from EUR-Lex, the European Parliament, the Council, ESG media and Google News searches, tagged by regulation. Filter by regulation, source type, new items or your watchlist.
- **Learn**: a learning page for every regulation plus a foundations page, each with a short test, and a mixed test across all pages.
- **Sources**: health of every feed on the last run, including feeds that answer without delivering items.
- **Watchlist**: star the regulations you are responsible for. The countdown and filters then focus on them (stored in your browser only).
- **RSS output**: subscribe to `feed.xml` in Outlook, Feedly or any feed reader.
- **Calendar**: subscribe to `calendar.ics` to get the key dates in Outlook or another calendar; it updates itself.
- **For you**: `site/data/profile.json` describes the reader. Every regulation is marked as applying directly, indirectly, possibly soon, or as background, and each learning page explains what it means for that reader and what to ask suppliers for.
- **Briefing and proposed updates** (optional, needs a Gemini API key): an AI review marks irrelevant news, writes a short briefing, and proposes updates to the regulation data as a pull request that you confirm.

Covered: CSRD, ESRS (Set 1 and revised), EU Taxonomy, SFDR and SFDR 2.0, CSDDD, CBAM, EUDR, ECGT, Green Claims, ESPR, Batteries Regulation, Forced Labour Regulation, EU ETS, Pay Transparency, EU Green Bond Standard, ESG Ratings Regulation, PPWR, Conflict Minerals; product compliance: Right to Repair, RoHS, REACH, Machinery Regulation; Germany: LkSG, CSRD transposition; China: sustainability disclosure standards, national ETS, and the counter-sanctions and data rules that affect supplier audits.

## Setup (about 10 minutes)

1. **Create a repository** on GitHub, for example `eu-esg-tracker`. It must be **public** for free GitHub Pages (private repositories need a paid plan).
2. **Upload the files** from this folder, keeping the folder structure. The easiest ways are GitHub Desktop or `git push`. If you use "Add file → Upload files" in the browser, check afterwards that `.github/workflows/update.yml` exists: folders starting with a dot are hidden on macOS and Windows and are easily skipped. If it is missing, create it with "Add file → Create new file", type `.github/workflows/update.yml` as the name and paste the content.
3. **Turn on Pages**: Settings → Pages → Build and deployment → Source: **GitHub Actions**.
4. **Run the workflow once**: Actions tab → "Update and publish" → Run workflow. The first run triggered by your upload may have failed because Pages was not switched on yet; that is expected.
5. Open the site at `https://<your-user>.github.io/<repository>/`. The link is also shown in the workflow run and under Settings → Pages.

If step 4 fails when saving updates ("Permission denied" or 403 on `git push`): Settings → Actions → General → Workflow permissions → **Read and write permissions**.

## Updating an existing repository

Upload the files from this folder over the existing ones, keeping the folder structure. The package deliberately contains no `site/data/news.json`, `site/data/developments.json` or `site/feed.xml`: the workflow writes them, and the copies in your repository are newer.

## Setting up the AI review (optional, about 5 minutes)

Without this step the tracker works as before. With it, three things are added: irrelevant news is hidden, a briefing appears on the overview, and outdated tracker data is flagged for you to confirm.

1. Open [Google AI Studio](https://aistudio.google.com), sign in and choose **Get API key → Create API key**. The free tier is sufficient; a Gemini subscription is not needed and does not include API use.
2. In your GitHub repository: **Settings → Secrets and variables → Actions → New repository secret**. Name: `GEMINI_API_KEY`. Value: the key.
3. **Settings → Actions → General → Workflow permissions**: choose **Read and write permissions** and tick **Allow GitHub Actions to create and approve pull requests**.
4. Start the workflow once by hand (Actions → Update and publish → Run workflow).

What happens then:

- **Every run** (twice a day): each new item is judged for relevance to the profile and gets a one-line note. Items judged irrelevant are hidden on the Updates page unless you tick the box at the bottom. The first runs work through the backlog, 80 items at a time.
- **Once a day**, and on every run you start by hand: the briefing is rewritten, and the model compares the regulation data with recent news. Where it finds an outdated status, stage or date and can name sources, it adds a proposal. It also checks three learning pages a day against the regulation data.
- **Proposals are never applied automatically.** They appear on the overview and as a pull request called "Proposed updates to regulation data". Open it under **Pull requests**, read the reasons and sources, and press **Merge pull request** to apply everything in it, or **Close pull request** to decline. You can also edit the files in the pull request before merging. Declined proposals are not made again for 90 days.

Things to know:

- On the free tier Google may use what is sent to improve its products. The script sends only headlines, the tracker's own data and the profile. Do not put confidential information into `profile.json`.
- The model works mainly from headlines. With `use_search: true` it may check facts through Google Search where the key allows it; proposals say whether that happened. Treat the briefing and every proposal as a lead to verify, not as a fact.
- Settings are in `config/sources.yml` under `settings.ai`. `model: auto` picks the newest Flash model available to your key.
- If the AI step fails, for example because a limit is reached, the run continues without it and shows a warning in the Actions log.

## How updating works

`.github/workflows/update.yml` runs twice a day (05:15 and 15:15 UTC), on every push to `main`, and whenever you start it by hand. It:

1. runs `scripts/fetch_feeds.py`, which reads every source in `config/sources.yml`,
2. keeps items that mention a tracked regulation (keywords from `site/data/regulations.json`) or an ESG keyword, tags them and removes duplicates,
3. groups headlines that report a procedure step into "reported developments" for the timeline,
4. saves the result to `site/data/news.json`, `site/data/developments.json` and `site/feed.xml` and commits them,
5. publishes the `site` folder to GitHub Pages.

A broken feed never stops the run: the error is shown on the Sources page and as a warning in the Actions log, and the other sources continue as normal. Items older than 150 days are dropped (`max_age_days` in `config/sources.yml`).

### Reading the Sources page

"3 of 20" means the feed listed 20 items on the last run and 3 of them matched. Feeds only list their newest items and general feeds cover every policy area, so "0 of 100" for EUR-Lex is normal in a week without ESG legislation. Items are matched on title, teaser, full text and categories, and on the act numbers in each regulation's `reference` (for example `2023/956`), because official feeds cite acts by number.

"0 of 0" is different: the server answered but sent no items. If the answer is not a feed at all (an empty page or a bot check), the source is shown as **Failed** with the HTTP status and content type. The European Parliament's site is known to do this to automated requests. A source can therefore have a `fallback_query`, a Google News search that is used on runs where its feed gives nothing; the row then shows **Using fallback**. If a feed keeps failing and its fallback finds nothing useful, remove the source from `config/sources.yml`.

### Reported developments on the timeline

On every run the collector looks for headlines that name a tracked regulation and report a procedure step: a vote or adoption, publication or entry into force, a delay, a withdrawal, a proposal or new guidance. Reports on the same regulation and the same kind of step within 10 days are merged into one entry. An entry is shown when an official source reports it, or when at least two different publishers do and the headlines name an EU institution (three if they do not). Explainers, webinars and similar items are ignored. The thresholds are in `config/sources.yml` under `settings.developments`.

These entries appear on the timeline, in the regulation's detail view and on its learning page, marked as **reported**. If a headline names a future date that is not in the curated data ("postponed to December 2027"), that date is shown as well, marked **not confirmed**.

The curated dates in `regulations.json` are never changed automatically, because headlines are not reliable enough for that. To confirm a step, add it to the regulation's `dates`; the reported entry disappears as soon as a curated date for the same regulation lies within two days of it. Entries that are wrong can be hidden with the "Hide" button on the timeline (stored in your browser).

GitHub pauses scheduled workflows in public repositories after 60 days without activity in the repository and sends an e-mail beforehand. Re-enable it with one click in the Actions tab.

## Keeping the regulation data current

Feeds bring in news automatically. The **status of each regulation** (stage, dates, scope) is curated by hand in `site/data/regulations.json`, because no feed reports it reliably. When something changes, for example the SFDR 2.0 plenary vote:

```json
{
  "id": "sfdr2",
  "stage": 1,
  "status": "Short text shown in the detail view",
  "dates": [
    { "date": "2026-10", "label": "goes to a plenary vote in Parliament", "approx": true },
    { "date": "2026-10-21", "label": "Parliament adopts its position" }
  ]
}
```

- `jurisdiction`: `EU`, `DE` or `CN`; shown as a filter on the overview.
- `stage`: 0 Proposed, 1 Negotiating, 2 Adopted, 3 In force, 4 Applies.
- `flag`: `amended`, `revision`, `stalled` or `null`, shown as a label next to the name.
- `dates`: `YYYY-MM-DD`, or `YYYY-MM` if only the month is known. Add `"approx": true` for expected dates; the countdown only uses firm dates. Write labels in lower case as a continuation of the name ("EUDR *applies to …*").
- `keywords`: used to tag news items. A trailing `*` matches any ending (`ESG rating*` also finds "ESG ratings").
- Update `reviewed` at the top of the file; the date is shown in the footer.

Edit the file directly on GitHub (pencil icon). Saving it triggers the workflow and the site is republished within a minute or two.

## The profile

`site/data/profile.json` describes who the tracker is for. It drives the "For you" filter, the countdown on the overview, the "What this means for you" section of each learning page and the AI review's judgement of relevance.

```json
{
  "summary": "One paragraph describing the reader's company and role.",
  "facts": ["Short statements the relevance levels rest on, such as size thresholds."],
  "regulations": {
    "batteries": {
      "level": "direct",
      "why": "One sentence.",
      "points": ["What it means in practice."],
      "ask": ["What to ask suppliers for."]
    }
  }
}
```

`level` is `direct` (applies to you), `indirect` (reaches you through customers or the group), `watch` (could apply soon) or `background`. When the company changes, for example through a new product category or crossing a size threshold, update the facts and the levels. The file is public, so keep it free of company names and internal details.

## Learning pages

Each regulation has a learning page at `site/data/learn/<regulation id>.json`; `foundations.json` is the general introduction. Status, key dates, official texts and latest updates on a learning page are read from the tracker data, so only the explanatory content lives in these files:

```json
{
  "id": "csrd",
  "reviewed": "2026-10-02",
  "essentials": ["Three to five sentences. **Bold** marks key phrases."],
  "sections": [
    { "title": "Why it exists", "text": ["Paragraph."], "points": ["Bullet."], "steps": ["Numbered step."],
      "table": { "head": ["", "Before", "After"], "rows": [["Scope", "…", "…"]] }, "after": ["Closing paragraph."] }
  ],
  "terms": [{ "term": "Double materiality", "text": "…" }],
  "numbers": [{ "value": "1,000", "label": "employees: the first scope threshold" }],
  "related": [{ "id": "esrs", "text": "How the two relate." }],
  "mistakes": [{ "wrong": "What people often assume.", "right": "What is actually the case." }],
  "practice": ["What to do, step by step."],
  "quiz": [{ "q": "Question?", "options": ["A", "B", "C", "D"], "answer": 2, "why": "Explanation shown after answering." }]
}
```

- Every part except `id` is optional; a section may use any of `text`, `points`, `steps`, `table` and `after`.
- `answer` is the position of the correct option, counting from 0. Questions and options are shuffled when shown.
- A test counts as passed at 80%. Results are stored in the visitor's browser only.
- Questions answered wrongly come back under "Repeat" on the Learn page after 1, 3, 7, 14 and 30 days.
- For a new regulation, add it to `regulations.json` and create a file with the same id here. Without a file the page says that no learning page exists yet.
- The learning pages contain thresholds and dates. When a regulation changes, update its learning page and its `reviewed` date along with `regulations.json`.

## Adding or removing sources

Edit `config/sources.yml`. Each source has an `id`, `name`, `kind` (`official`, `industry` for specialist media, or `news`), either a feed `url` or a Google News `query`, a `filter` (`regulations`, `relevant` or `none`) and optionally a `fallback_query`. The file explains each option.

A good addition is a personal **EUR-Lex search feed**: sign in to EUR-Lex, run an expert search (for example new acts mentioning "sustainability reporting"), save it and choose "Create RSS alert" to get a feed URL, then add it with `kind: official`.

## Local preview

```bash
python -m http.server 8000 -d site
# open http://localhost:8000
```

To collect updates locally:

```bash
pip install -r requirements.txt
python scripts/fetch_feeds.py
```

## Project structure

```
.github/workflows/update.yml   schedule, fetch, AI review, commit, pull request, deploy
config/sources.yml             feeds, search queries and settings
scripts/fetch_feeds.py         feed collector (Python 3.10+)
scripts/ai_review.py           optional review with Google Gemini
site/index.html                the website (static, no build step)
site/assets/                   styles.css, app.js, fonts
site/data/regulations.json     curated regulation data
site/data/profile.json         who the tracker is for, and what each regulation means for them
site/data/learn/               one learning page per regulation, plus foundations.json
site/data/news.json            collected updates (written by the workflow)
site/data/developments.json    procedure steps reported in the news (written by the workflow)
site/data/briefing.json        AI briefing (written by the workflow, with an API key)
site/data/proposals.json       changes waiting for confirmation (written by the workflow)
site/data/ai_state.json        bookkeeping of the AI review (written by the workflow)
site/feed.xml                  RSS output (written by the workflow)
site/calendar.ics              key dates as a calendar (written by the workflow)
```

## Disclaimer

For orientation only, not legal advice. Regulation data was reviewed on 29 September 2026 and must be kept up to date by hand. The texts published in the Official Journal and on EUR-Lex are authoritative. The profile, the entries on product compliance, Germany and China and their learning pages were written on 3 October 2026; the German CSRD transposition could not be verified beyond April 2026 and says so. The other learning pages were reviewed on 2 October 2026 and are a study aid, not a substitute for the legal texts. Reported developments are taken from headlines and are not checked. News items link to third-party sources; their content is the responsibility of the respective publishers.
