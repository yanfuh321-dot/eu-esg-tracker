/* EU ESG Tracker front end. No build step: plain JavaScript, data from ./data/*.json */
(() => {
  'use strict';

  // ---------------------------------------------------------------- storage (per browser, never shared)
  const PREFIX = 'esgTracker.';
  const store = {
    get(key, fallback = null) {
      try { const v = localStorage.getItem(PREFIX + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ } },
  };
  const session = {
    get(key) { try { return sessionStorage.getItem(PREFIX + key); } catch (e) { return null; } },
    set(key, value) { try { sessionStorage.setItem(PREFIX + key, value); } catch (e) { /* ignore */ } },
  };

  // ---------------------------------------------------------------- dates
  const DAY = 86400000;
  const now = new Date();
  const TODAY = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const F = {
    day: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
    month: new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
    monthLong: new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    long: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
    localDay: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }),
    localDayYear: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    stamp: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  };

  function parseKeyDate(value) {
    const [y, m, d] = value.split('-').map(Number);
    return { t: Date.UTC(y, (m || 1) - 1, d || 1), monthOnly: !d };
  }
  function endOfMonth(t) { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0); }
  function sameMonth(a, b) { const x = new Date(a); const y = new Date(b); return x.getUTCFullYear() === y.getUTCFullYear() && x.getUTCMonth() === y.getUTCMonth(); }
  function isUpcoming(ev) { return (ev.monthOnly ? endOfMonth(ev.t) : ev.t) >= TODAY; }
  function daysUntil(t) { return Math.round((t - TODAY) / DAY); }
  function fmtEventDate(ev) { return ev.monthOnly ? F.month.format(ev.t) : F.day.format(ev.t); }
  function relDays(ev) {
    if (ev.monthOnly) return 'expected';
    const n = daysUntil(ev.t);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n > 0) return `in ${n} days`;
    if (n === -1) return 'yesterday';
    return `${-n} days ago`;
  }
  function localDayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
  function itemTime(item) { return Date.parse(item.published || item.first_seen) || 0; }

  // ---------------------------------------------------------------- text helpers
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  // Learning pages may mark **key phrases**; everything else is escaped.
  const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  const PILLAR_NAMES = { E: 'Environmental', S: 'Social', G: 'Governance' };
  const FLAG_TEXT = { amended: 'Amended', revision: 'Revision under way', stalled: 'Stalled' };
  const KIND_TEXT = { official: 'Official EU sources', industry: 'Specialist news', news: 'News searches' };
  const GROUP_TEXT = {
    decision: 'Vote or adoption', legal: 'Publication or entry into force', delay: 'Delay',
    withdrawn: 'Withdrawal', proposal: 'Proposal or draft', guidance: 'Guidance',
  };
  const LEVEL_TEXT = { direct: 'Applies to you', indirect: 'Reaches you indirectly', watch: 'Could apply soon', background: 'Background' };
  const JURISDICTION_TEXT = { EU: 'EU', DE: 'Germany', CN: 'China' };
  const STALE_AFTER_DAYS = 45;
  const REVIEW_STEPS = [1, 3, 7, 14, 30]; // days until a missed question is asked again
  const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/></svg>';
  const PASS_MARK = 0.8;
  const EXAM_LENGTH = 20;
  const FOUNDATIONS = { id: 'foundations', short: 'Foundations', name: 'How EU ESG law works', area: 'Start here', pillars: ['E', 'S', 'G'] };

  // ---------------------------------------------------------------- state
  const S = {
    regs: [], byId: new Map(), stages: [], reviewed: null,
    items: [], sources: [], generatedAt: null, repository: null, branch: null,
    events: [], devs: [], autoEvents: [],
    hiddenDevs: new Set(store.get('hiddenDevs', [])),
    baseline: null, firstVisit: false,
    watch: new Set(store.get('watch', [])),
    profile: {}, briefing: null, proposals: { items: [], learn_edits: [] },
    board: { pillar: 'all', jur: '', q: '', sort: 'next' },
    news: { q: '', reg: '', kind: '', onlyNew: false, watch: false, important: false, showLow: false, limit: 150 },
    timeline: { pillar: 'all', past: false, reported: true },
    learn: new Map(), progress: store.get('learn', {}), review: store.get('review', {}), quiz: null,
    introPlayed: false,
    route: { view: 'overview' },
    lastViewHash: '#/overview',
    token: 0,
  };

  const $view = document.getElementById('view');
  const $drawer = document.getElementById('drawer');
  const $drawerContent = document.getElementById('drawer-content');

  // ---------------------------------------------------------------- load
  async function loadJson(path) {
    const res = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  async function init() {
    let regData;
    try {
      regData = await loadJson('data/regulations.json');
    } catch (err) {
      $view.innerHTML = `<div class="error-state"><strong>The regulation data could not be loaded.</strong>
        <p>Open the site through a web server (GitHub Pages, or <code>python -m http.server</code> in the <code>site</code> folder) rather than as a local file. Details: ${esc(err.message)}</p></div>`;
      return;
    }
    let newsData = { items: [], sources: [], generated_at: null };
    try { newsData = await loadJson('data/news.json'); } catch (err) { console.warn('news.json not available yet', err); }
    const optional = async (path, fallback) => { try { return await loadJson(path); } catch (err) { console.info(`${path} not available`); return fallback; } };
    const devData = await optional('data/developments.json', { items: [] });
    S.profile = await optional('data/profile.json', {});
    S.briefing = await optional('data/briefing.json', null);
    S.proposals = await optional('data/proposals.json', { items: [], learn_edits: [] });
    if (S.profile.regulations) { S.board.pillar = 'foryou'; S.timeline.pillar = 'foryou'; }

    S.stages = regData.stages;
    S.reviewed = regData.reviewed;
    S.regs = regData.regulations;
    S.regs.forEach((r) => S.byId.set(r.id, r));
    S.items = (newsData.items || []).slice().sort((a, b) => itemTime(b) - itemTime(a));
    S.sources = newsData.sources || [];
    S.generatedAt = newsData.generated_at ? Date.parse(newsData.generated_at) : null;
    S.repository = newsData.repository || null;
    S.branch = newsData.branch || 'main';
    S.devs = devData.items || [];
    S.events = S.regs
      .flatMap((reg) => (reg.dates || []).map((d) => ({ reg, label: d.label, approx: !!d.approx, ...parseKeyDate(d.date) })))
      .sort((a, b) => a.t - b.t);
    buildAutoEvents();

    initVisit();
    renderChrome();
    route();
  }

  function initVisit() {
    const saved = session.get('baseline');
    if (saved !== null) {
      S.firstVisit = saved === 'none';
      S.baseline = S.firstVisit ? null : Number(saved);
    } else {
      const last = store.get('lastSeen', null);
      S.firstVisit = last === null;
      S.baseline = last;
      session.set('baseline', last === null ? 'none' : String(last));
    }
    store.set('lastSeen', Date.now());
  }

  // Relevance. With the AI review an item carries a verdict; without it, search results that
  // name no tracked regulation count as loosely related.
  const isLow = (item) => (item.ai ? item.ai.relevant === false : !!item.weak);
  const importanceOf = (item) => (item.ai && item.ai.relevant ? item.ai.importance || 0 : 0);
  const itemRegs = (item) => [...new Set([...(item.tags || []), ...((item.ai && item.ai.relevant && item.ai.regs) || [])])];
  const hasAiReview = () => S.items.some((it) => it.ai);
  const goodItems = () => S.items.filter((it) => !isLow(it));

  const profileOf = (reg) => (S.profile.regulations || {})[reg.id] || null;
  const levelOf = (reg) => (profileOf(reg) || {}).level || null;
  const isForYou = (reg) => { const l = levelOf(reg); return !!l && l !== 'background'; };
  const levelHtml = (reg) => { const l = levelOf(reg); return l && l !== 'background' ? `<span class="level level-${l}">${LEVEL_TEXT[l]}</span>` : ''; };

  const isNew = (item) => S.baseline !== null && Date.parse(item.first_seen) > S.baseline;
  const newItems = () => goodItems().filter(isNew);

  function markAllRead() {
    S.baseline = Date.now();
    S.firstVisit = false;
    session.set('baseline', String(S.baseline));
    renderChrome();
    renderView();
  }

  // ---------------------------------------------------------------- developments reported in the news
  // The collector groups headlines that report a procedure step (a vote, publication, a delay).
  // They become timeline entries marked as reported. An entry disappears as soon as the curated
  // data in regulations.json has a date for the same regulation within two days of it.
  function buildAutoEvents() {
    const out = [];
    S.devs.forEach((dev) => {
      if (!dev.visible || S.hiddenDevs.has(dev.id)) return;
      const regs = (dev.regs || []).map((id) => S.byId.get(id)).filter(Boolean);
      if (!regs.length || !dev.date) return;
      const t = parseKeyDate(dev.date).t;
      const curated = S.events.filter((e) => regs.includes(e.reg));
      const covered = curated.some((e) => !e.monthOnly && Math.abs(e.t - t) <= 2 * DAY);
      const base = { reg: regs[0], regs, dev, auto: true, label: dev.title };
      if (!covered) out.push({ ...base, kind: 'report', t, monthOnly: false, approx: false });
      (dev.mentions || []).forEach((value) => {
        const d = parseKeyDate(value);
        const known = curated.some((e) => ((d.monthOnly || e.monthOnly) ? sameMonth(e.t, d.t) : e.t === d.t));
        if (!known && isUpcoming(d)) out.push({ ...base, kind: 'mention', ...d, approx: true });
      });
    });
    S.autoEvents = out.sort((a, b) => a.t - b.t);
  }

  function eventsFor(test, withAuto = true) {
    const list = S.events.filter(test);
    return withAuto ? list.concat(S.autoEvents.filter(test)).sort((a, b) => a.t - b.t) : list;
  }

  function reportNote(dev) {
    const who = dev.official ? `official source${dev.publishers > 1 ? ` and ${plural(dev.publishers - 1, 'other')}` : ''}` : plural(dev.publishers, 'source');
    return `${GROUP_TEXT[dev.group] || 'Development'}, reported by ${who}`;
  }

  function autoLabelHtml(ev) {
    const link = `<a href="${esc(safeUrl(ev.dev.link))}" target="_blank" rel="noopener noreferrer">${esc(ev.label)}</a>`;
    return ev.kind === 'mention'
      ? `<span class="label">Date named in news reports: ${link}</span><span class="reported">Not confirmed</span>`
      : `<span class="label">${link}</span><span class="reported">${esc(reportNote(ev.dev))}</span>`;
  }

  function editDataUrl() {
    return S.repository ? `https://github.com/${S.repository}/edit/${S.branch || 'main'}/site/data/regulations.json` : null;
  }

  // ---------------------------------------------------------------- header, nav, footer
  function renderChrome() {
    const up = document.getElementById('updated');
    if (S.generatedAt) {
      up.textContent = `Updates checked ${F.stamp.format(S.generatedAt)}`;
      up.title = new Date(S.generatedAt).toString();
    } else {
      up.textContent = 'Updates not collected yet';
    }
    const count = newItems().length;
    const badge = document.getElementById('news-count');
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.setAttribute('aria-label', `${count} new`);
    if (S.reviewed) {
      document.getElementById('footer-reviewed').textContent =
        `Regulation details reviewed on ${F.day.format(parseKeyDate(S.reviewed).t)}. For orientation only, not legal advice; the texts on EUR-Lex are authoritative.`;
    }
    syncThemeButton();
  }

  // ---------------------------------------------------------------- routing
  const VIEWS = ['overview', 'timeline', 'news', 'learn', 'sources'];

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, query = ''] = raw.split('?');
    const [view = 'overview', param] = path.split('/');
    return { view: view || 'overview', param, query: new URLSearchParams(query) };
  }

  function route() {
    const r = parseHash();
    if (r.view === 'regulation' && S.byId.has(r.param)) {
      if (!$view.dataset.rendered) { S.route = { view: 'overview' }; renderView(); }
      openDrawer(r.param);
      return;
    }
    if (!VIEWS.includes(r.view)) r.view = 'overview';
    if (r.view === 'news' && r.query.toString()) {
      S.news.reg = r.query.get('reg') || '';
      S.news.onlyNew = r.query.get('new') === '1';
      S.news.watch = r.query.get('watch') === '1';
      S.news.q = '';
      S.news.kind = '';
    }
    const changed = S.route.view !== r.view || S.route.param !== r.param;
    S.route = r;
    S.lastViewHash = location.hash || '#/overview';
    if ($drawer.open) $drawer.close();
    renderView();
    if (changed && $view.dataset.rendered === 'again') {
      window.scrollTo({ top: 0 });
      $view.focus({ preventScroll: true });
    }
    $view.dataset.rendered = 'again';
  }

  function renderView() {
    document.querySelectorAll('.tabs a').forEach((a) => {
      if (a.dataset.view === S.route.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    S.token += 1; // pages that load data check this before they draw
    const views = { overview: viewOverview, timeline: viewTimeline, news: viewNews, learn: viewLearn, sources: viewSources };
    const titles = { overview: 'Overview', timeline: 'Timeline', news: 'Updates', learn: 'Learn', sources: 'Sources' };
    document.title = `${titles[S.route.view]}, EU ESG Tracker`;
    (views[S.route.view] || viewOverview)();
    $view.dataset.rendered = $view.dataset.rendered || 'first';
  }

  // ---------------------------------------------------------------- shared pieces
  const primaryPillar = (reg) => (reg.pillars && reg.pillars[0]) || 'E';

  function pillarsHtml(reg) {
    return `<span class="pillars" aria-label="${esc(reg.pillars.map((p) => PILLAR_NAMES[p]).join(', '))}">${reg.pillars
      .map((p) => `<span class="p-${p}" title="${PILLAR_NAMES[p]}">${p}</span>`).join('')}</span>`;
  }

  function flagHtml(reg) {
    return reg.flag ? `<span class="flag flag-${esc(reg.flag)}">${esc(FLAG_TEXT[reg.flag] || reg.flag)}</span>` : '';
  }

  function regPill(reg, asLink = true) {
    const inner = esc(reg.short);
    return asLink
      ? `<a class="pill" data-pillar="${primaryPillar(reg)}" href="#/regulation/${esc(reg.id)}">${inner}</a>`
      : `<span class="pill" data-pillar="${primaryPillar(reg)}">${inner}</span>`;
  }

  function starButton(reg) {
    const on = S.watch.has(reg.id);
    return `<button class="star" type="button" data-watch="${esc(reg.id)}" aria-pressed="${on}"
      aria-label="${on ? 'Remove' : 'Add'} ${esc(reg.short)} ${on ? 'from' : 'to'} watchlist" title="${on ? 'On your watchlist' : 'Add to watchlist'}">${STAR_SVG}</button>`;
  }

  function railHtml(reg) {
    const st = Math.max(0, Math.min(4, reg.stage));
    const stalled = reg.flag === 'stalled';
    let h = `<div class="rail${stalled ? ' is-stalled' : ''}" style="--stage:${st}" role="img" aria-label="Stage ${st + 1} of 5: ${esc(S.stages[st])}${stalled ? ', stalled' : ''}">`;
    h += '<span class="rail-progress"></span>';
    if (stalled && st < 4) h += '<span class="rail-stall"></span>';
    for (let i = 0; i < 5; i += 1) {
      h += `<span class="stn${i < st ? ' done' : i === st ? ' now' : ''}" style="--i:${i}"></span>`;
    }
    return h + '</div>';
  }

  function nextEvent(reg) { return S.events.find((e) => e.reg === reg && isUpcoming(e)) || null; }
  function recentReport(reg) {
    return S.autoEvents.filter((e) => e.kind === 'report' && e.regs.includes(reg) && TODAY - e.t <= 30 * DAY).pop() || null;
  }

  function eventRow(ev, { withReg = true, showRel = true } = {}) {
    const past = !isUpcoming(ev);
    const pills = withReg ? (ev.auto ? ev.regs : [ev.reg]).map((r) => regPill(r)).join('') : '';
    const body = ev.auto ? autoLabelHtml(ev) : `<span>${esc(cap(ev.label))}</span>`;
    return `<li class="${past ? 'is-past' : ''}${ev.auto ? ' is-reported' : ''}">
      <time datetime="${new Date(ev.t).toISOString().slice(0, ev.monthOnly ? 7 : 10)}">${fmtEventDate(ev)}${showRel ? `<span class="days">${relDays(ev)}</span>` : ''}</time>
      <div class="what">${pills}${body}</div>
    </li>`;
  }

  function sourceName(id) { const s = S.sources.find((x) => x.id === id); return s ? s.name : id; }
  function sourceKind(item) { return item.kind || (S.sources.find((x) => x.id === item.source) || {}).kind || 'news'; }

  function newsItemHtml(item, { summary = true, date = true } = {}) {
    const t = itemTime(item);
    const tags = itemRegs(item).map((id) => S.byId.get(id)).filter(Boolean);
    const kind = sourceKind(item);
    const origin = item.publisher || sourceName(item.source);
    const fresh = isNew(item);
    const note = item.ai && item.ai.relevant && item.ai.note ? item.ai.note : '';
    return `<li class="news-item${fresh ? ' is-new' : ''}${date ? '' : ' no-date'}${isLow(item) ? ' is-low' : ''}">
      ${date ? `<time class="news-date" datetime="${esc(item.published || item.first_seen)}">${t ? F.localDay.format(t) : ''}</time>` : ''}
      <div class="news-body">
        <a class="news-title" href="${esc(safeUrl(item.link))}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
        ${summary && note ? `<p class="news-summary news-note"><span>AI note</span>${esc(note)}</p>` : summary && item.summary ? `<p class="news-summary">${esc(item.summary)}</p>` : ''}
        <div class="news-meta">
          ${fresh ? '<span class="new-label"><span class="dot-new" aria-hidden="true"></span>New</span>' : ''}
          ${importanceOf(item) >= 3 ? '<span class="important-label">Important</span>' : ''}
          <span class="src${kind === 'official' ? ' kind-official' : ''}">${esc(origin)}</span>
          ${tags.map((r) => regPill(r)).join('')}
        </div>
      </div>
    </li>`;
  }

  function pillarChips(current, key) {
    const opts = [...(S.profile.regulations ? [['foryou', 'For you', null]] : []), ['all', 'All', null], ['E', 'Environmental', 'var(--pillar-e)'], ['S', 'Social', 'var(--pillar-s)'], ['G', 'Governance', 'var(--pillar-g)'], ['watch', `Watchlist (${S.watch.size})`, null]];
    return opts.map(([v, label, color]) => `<button type="button" class="chip" data-${key}="${v}" aria-pressed="${current === v}">${color ? `<span class="swatch" style="--c:${color}"></span>` : ''}${esc(label)}</button>`).join('');
  }

  function matchesPillar(reg, pillar) {
    if (pillar === 'all') return true;
    if (pillar === 'foryou') return isForYou(reg);
    if (pillar === 'watch') return S.watch.has(reg.id);
    return reg.pillars.includes(pillar);
  }
  const eventMatchesPillar = (ev, pillar) => (ev.auto ? ev.regs : [ev.reg]).some((r) => matchesPillar(r, pillar));

  // ---------------------------------------------------------------- overview
  function viewOverview() {
    const watched = S.regs.filter((r) => S.watch.has(r.id));
    const focus = (reg) => (watched.length ? S.watch.has(reg.id) : !S.profile.regulations || isForYou(reg));
    const pool = S.events.filter((e) => focus(e.reg));
    const hero = pool.find((e) => isUpcoming(e) && !e.approx) || S.events.find((e) => isUpcoming(e) && !e.approx);
    const heroFromWatch = hero && watched.length && S.watch.has(hero.reg.id);
    const heroIdx = hero ? S.events.indexOf(hero) : -1;
    const after = S.events.filter((e, i) => isUpcoming(e) && i !== heroIdx && focus(e.reg)).slice(0, 3);
    const recent = eventsFor((e) => !isUpcoming(e) && !e.monthOnly && TODAY - e.t <= 30 * DAY).reverse();

    let heroHtml = '';
    if (hero) {
      const n = daysUntil(hero.t);
      const when = n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
      heroHtml = `<div class="hero-main">
        <h1 class="hero-line"><a href="#/regulation/${esc(hero.reg.id)}">${esc(hero.reg.short)}</a> ${esc(hero.label)} ${when}.</h1>
        <p class="hero-date">${F.long.format(hero.t)}${heroFromWatch ? ', the next firm date on your watchlist' : S.profile.regulations && isForYou(hero.reg) ? ', the next firm date among the rules that concern you' : ''}</p>
        ${after.length ? `<div class="hero-then"><h2>Also ahead</h2><ol class="date-list">${after.map((e) => eventRow(e)).join('')}</ol></div>` : ''}
        ${recent.length ? `<div class="hero-then"><h2>In the last 30 days</h2><ol class="date-list">${recent.map((e) => eventRow(e)).join('')}</ol></div>` : ''}
      </div>`;
    } else {
      heroHtml = '<div class="hero-main"><h1 class="hero-line">No upcoming dates in the data.</h1><p class="hero-date">Add key dates in site/data/regulations.json.</p></div>';
    }

    $view.innerHTML = `
      ${staleHtml()}
      <section class="hero" data-pillar="${hero ? primaryPillar(hero.reg) : 'E'}">${heroHtml}${sinceHtml()}</section>
      ${proposalsHtml()}
      ${briefingHtml()}

      <section class="section" aria-labelledby="board-title">
        <div class="section-head">
          <div>
            <h2 id="board-title">Where each regulation stands</h2>
            <p>From proposal to application. Select a regulation for scope, key dates and related updates, or open its learning page.</p>
          </div>
        </div>
        <div class="filters">
          <div class="controls" role="group" aria-label="Filter by pillar">${pillarChips(S.board.pillar, 'board-pillar')}</div>
          <span class="spacer"></span>
          <div class="field"><label class="visually-hidden" for="board-q">Search regulations</label>
            <input id="board-q" type="search" placeholder="Search regulations" value="${esc(S.board.q)}" autocomplete="off"></div>
          <div class="field"><label class="visually-hidden" for="board-jur">Jurisdiction</label>
            <select id="board-jur"><option value="">All jurisdictions</option>${[...new Set(S.regs.map((r) => r.jurisdiction || 'EU'))]
              .map((j) => `<option value="${esc(j)}"${S.board.jur === j ? ' selected' : ''}>${esc(JURISDICTION_TEXT[j] || j)}</option>`).join('')}</select></div>
          <div class="field"><label for="board-sort">Sort</label>
            <select id="board-sort">
              <option value="next"${S.board.sort === 'next' ? ' selected' : ''}>Next date</option>
              <option value="stage"${S.board.sort === 'stage' ? ' selected' : ''}>Stage</option>
              <option value="name"${S.board.sort === 'name' ? ' selected' : ''}>Name</option>
            </select></div>
        </div>
        <div class="panel board" id="board">${boardHtml()}</div>
      </section>

      <div class="two-col section">
        <section aria-labelledby="latest-title">
          <div class="section-head"><h2 id="latest-title">Latest updates</h2><a href="#/news">All updates</a></div>
          <div class="panel">${latestHtml()}</div>
        </section>
        <section aria-labelledby="soon-title">
          <div class="section-head"><h2 id="soon-title">Coming up</h2><a href="#/timeline">Full timeline</a></div>
          <div class="panel"><ol class="date-list">${eventsFor((e) => isUpcoming(e) && (e.auto ? e.regs : [e.reg]).some(focus)).slice(0, 8).map((e) => eventRow(e)).join('')}</ol></div>
        </section>
      </div>`;

    playIntro();
  }

  function calendarUrl() {
    return `webcal://${location.host}${location.pathname.replace(/[^/]*$/, '')}calendar.ics`;
  }

  function staleHtml() {
    if (!S.reviewed) return '';
    const age = Math.floor((TODAY - parseKeyDate(S.reviewed).t) / DAY);
    if (age <= STALE_AFTER_DAYS) return '';
    return `<p class="notice">The regulation details were last reviewed ${age} days ago, on ${F.day.format(parseKeyDate(S.reviewed).t)}. Stages and dates may be out of date; check recent updates and the official texts.</p>`;
  }

  function proposalsHtml() {
    const items = S.proposals.items || [];
    const edits = S.proposals.learn_edits || [];
    if (!items.length && !edits.length) return '';
    const total = items.length + edits.length;
    const pulls = S.repository ? `https://github.com/${S.repository}/pulls` : null;
    return `<section class="section proposals" aria-labelledby="proposals-title">
      <div class="panel">
        <div class="proposals-head">
          <div><h2 id="proposals-title">${plural(total, 'proposed change')} waiting for your confirmation</h2>
            <p>The AI review found tracker data that looks out of date. Nothing has been changed. Check the sources, then merge or close the pull request on GitHub.</p></div>
          ${pulls ? `<a class="btn" href="${esc(pulls)}" target="_blank" rel="noopener noreferrer">Review on GitHub</a>` : ''}
        </div>
        <ul class="proposal-list">${items.map((p) => {
          const reg = S.byId.get(p.reg);
          return `<li>${reg ? regPill(reg) : ''}<div><p class="proposal-text">${esc(p.text)}</p>
            <p class="proposal-reason">${esc(p.reason || '')} ${p.checked_with_search ? '' : 'Based on headlines only, not checked with a web search.'}</p>
            <p class="proposal-sources">${(p.sources || []).map((u, i) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">Source ${i + 1}</a>`).join('')}</p></div></li>`;
        }).join('')}${edits.map((e) => {
          const reg = S.byId.get(e.id);
          return `<li>${reg ? regPill(reg) : ''}<div><p class="proposal-text">Learning page: replace “${esc(String(e.old).replace(/\*\*/g, ''))}” with “${esc(String(e.new).replace(/\*\*/g, ''))}”</p>
            <p class="proposal-reason">${esc(e.reason || '')}</p></div></li>`;
        }).join('')}</ul>
      </div></section>`;
  }

  function briefingHtml() {
    const b = S.briefing;
    if (!b || !b.generated_at) return '';
    const when = Date.parse(b.generated_at);
    const old = Date.now() - when > 3 * DAY;
    return `<section class="section briefing" aria-labelledby="briefing-title">
      <div class="section-head"><div><h2 id="briefing-title">Briefing</h2>
        <p>Written by AI on ${F.stamp.format(when)} from ${plural(b.based_on || 0, 'important update')} of the last ${b.days || 7} days${b.checked_with_search ? ', checked with a web search' : ''}. Read the sources before you act on it.${old ? ' This briefing is more than three days old.' : ''}</p></div></div>
      <div class="panel briefing-panel">
        <h3 class="briefing-headline">${esc(b.headline || '')}</h3>
        <p class="briefing-summary">${esc(b.summary || '')}</p>
        ${(b.items || []).length ? `<ol class="briefing-items">${b.items.map((it) => `<li>
          <h4>${(it.regs || []).map((id) => S.byId.get(id)).filter(Boolean).map((r) => regPill(r)).join('')}<span>${esc(it.title)}</span></h4>
          <dl>
            ${it.what ? `<div><dt>What happened</dt><dd>${esc(it.what)}</dd></div>` : ''}
            ${it.meaning ? `<div><dt>What it means for you</dt><dd>${esc(it.meaning)}</dd></div>` : ''}
            ${it.action ? `<div><dt>What to do</dt><dd>${esc(it.action)}</dd></div>` : ''}
          </dl>
          ${(it.sources || []).length ? `<p class="briefing-sources">${it.sources.map((s) => `<a href="${esc(safeUrl(s.link))}" target="_blank" rel="noopener noreferrer">${esc(s.origin || 'Source')}</a>`).join('')}</p>` : ''}
        </li>`).join('')}</ol>` : ''}
        ${(b.watch || []).length ? `<div class="briefing-watch"><h4>Keep an eye on</h4><ul>${b.watch.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      </div></section>`;
  }

  function sinceHtml() {
    const fresh = newItems();
    if (!S.items.length) {
      return `<aside class="since"><h2>Updates</h2>
        <p class="note">${S.generatedAt
          ? 'No matching updates were found on the last check. The <a href="#/sources">Sources</a> page shows whether each feed responded.'
          : 'No updates collected yet. The GitHub Action fills this list on its first run; you can start it from the Actions tab of the repository.'}</p></aside>`;
    }
    if (S.firstVisit) {
      return `<aside class="since"><h2>Welcome</h2>
        <p class="note">From your next visit, updates collected since you were last here are marked as new.</p>
        <p class="note">Star the regulations you are responsible for to build a watchlist. The countdown and filters then focus on them.</p>
        <div class="since-actions"><a class="btn" href="#/news">Browse updates</a><a class="btn btn-quiet" href="#/learn">Start learning</a></div></aside>`;
    }
    const counts = new Map();
    fresh.forEach((it) => itemRegs(it).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([id, n]) => { const r = S.byId.get(id); return r ? `<a class="pill" data-pillar="${primaryPillar(r)}" href="#/news?reg=${esc(id)}&new=1" aria-label="${esc(r.short)}: ${n} new">${esc(r.short)}<span class="pill-count">${n}</span></a>` : ''; }).join('');
    return `<aside class="since"><h2>Since your last visit</h2>
      <p class="since-date">${F.stamp.format(S.baseline)}</p>
      <p class="since-count">${fresh.length ? '<span class="dot-new" aria-hidden="true"></span>' : ''}${fresh.length ? plural(fresh.length, 'new update') : 'Nothing new'}</p>
      ${top ? `<div class="since-tags">${top}</div>` : ''}
      ${fresh.length ? `<div class="since-actions"><a class="btn" href="#/news?new=1">Show new updates</a><button class="btn btn-quiet" type="button" data-action="mark-read">Mark all as read</button></div>`
        : '<p class="note">New items appear here after the next feed check.</p>'}
    </aside>`;
  }

  function filteredRegs() {
    const q = S.board.q.trim().toLowerCase();
    const list = S.regs.filter((r) => matchesPillar(r, S.board.pillar) && (!S.board.jur || (r.jurisdiction || 'EU') === S.board.jur) &&
      (!q || [r.short, r.name, r.area, r.reference, ...(r.keywords || [])].join(' ').toLowerCase().includes(q)));
    const nextT = (r) => { const e = nextEvent(r); return e ? e.t : Infinity; };
    const byName = (a, b) => a.short.localeCompare(b.short);
    if (S.board.sort === 'name') list.sort(byName);
    else if (S.board.sort === 'stage') list.sort((a, b) => a.stage - b.stage || byName(a, b));
    else list.sort((a, b) => nextT(a) - nextT(b) || byName(a, b));
    return list;
  }

  function boardHtml() {
    const list = filteredRegs();
    const header = `<div class="board-header" aria-hidden="true"><span>Regulation</span>
      <span class="stage-labels">${S.stages.map((s) => `<span>${esc(s)}</span>`).join('')}</span><span class="next">Next date</span></div>`;
    if (!list.length) {
      const msg = S.board.pillar === 'watch' && !S.watch.size
        ? '<strong>Your watchlist is empty.</strong>Select the star next to a regulation to add it.'
        : '<strong>No regulations match.</strong>Try another search term, or choose “All”.';
      return header + `<div class="empty">${msg}</div>`;
    }
    return header + list.map((reg, i) => {
      const ev = nextEvent(reg);
      const report = recentReport(reg);
      return `<div class="reg-row" data-pillar="${primaryPillar(reg)}" style="--delay:${Math.min(i, 14) * 55}ms">
        <div class="reg-id">${starButton(reg)}
          <div class="reg-text">
            <a class="reg-link" href="#/regulation/${esc(reg.id)}">${esc(reg.short)}</a>
            <p class="reg-full">${esc(reg.name)}</p>
            <div class="reg-meta">${pillarsHtml(reg)}${levelHtml(reg)}${flagHtml(reg)}<span class="area">${esc(reg.area)}</span><a class="learn-link" href="#/learn/${esc(reg.id)}">Learn</a></div>
          </div>
        </div>
        <div class="rail-cell">${railHtml(reg)}<p class="stage-text">${esc(S.stages[reg.stage])}${reg.flag === 'stalled' ? ', stalled' : ''}</p></div>
        <div class="next">${ev
          ? `<p class="next-date">${fmtEventDate(ev)}${ev.approx ? ' <span class="approx">(expected)</span>' : ''}</p><p class="next-label">${esc(cap(ev.label))}</p>`
          : '<p class="next-none">No upcoming dates</p>'}
          ${report ? `<p class="next-report"><span class="dot-new" aria-hidden="true"></span>${esc(GROUP_TEXT[report.dev.group] || 'Development')} reported ${F.localDay.format(report.t)}</p>` : ''}</div>
      </div>`;
    }).join('');
  }

  function playIntro() {
    if (S.introPlayed) return;
    S.introPlayed = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const board = document.getElementById('board');
    if (!board) return;
    board.classList.add('is-intro');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      board.classList.add('is-drawing');
      board.classList.remove('is-intro');
      setTimeout(() => board.classList.remove('is-drawing'), 2600);
    }));
  }

  function latestHtml() {
    if (!S.items.length) {
      return '<div class="empty"><strong>No updates yet.</strong>Run the “Update and publish” workflow once in the Actions tab of your repository.</div>';
    }
    const list = goodItems();
    const top = hasAiReview() ? list.slice(0, 40).sort((a, b) => importanceOf(b) - importanceOf(a) || itemTime(b) - itemTime(a)).slice(0, 7).sort((a, b) => itemTime(b) - itemTime(a)) : list.slice(0, 7);
    return `<ol class="news-list">${top.map((it) => newsItemHtml(it, { summary: false })).join('')}</ol>`;
  }

  // ---------------------------------------------------------------- timeline
  function reportedPanelHtml() {
    const hidden = S.devs.filter((d) => d.visible && S.hiddenDevs.has(d.id)).length;
    const recent = S.autoEvents.filter((e) => e.kind === 'report' && TODAY - e.t <= 45 * DAY && eventMatchesPillar(e, S.timeline.pillar)).reverse();
    const edit = editDataUrl();
    const rows = recent.map((e) => {
      const others = (e.dev.sources || []).filter((s) => s.link !== e.dev.link).slice(0, 6);
      return `<li class="report">
        <time datetime="${esc(e.dev.date)}">${F.day.format(e.t)}</time>
        <div class="what">
          <p class="report-title">${e.regs.map((r) => regPill(r)).join('')}<a href="${esc(safeUrl(e.dev.link))}" target="_blank" rel="noopener noreferrer">${esc(e.label)}</a></p>
          <p class="report-meta">${esc(reportNote(e.dev))}. Headline from ${esc(e.dev.origin)}.</p>
          ${others.length ? `<details><summary>${plural(others.length, 'more report')}</summary><ul>${others.map((s) => `<li><a href="${esc(safeUrl(s.link))}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a> <span>${esc(s.origin)}</span></li>`).join('')}</ul></details>` : ''}
        </div>
        <button class="btn btn-quiet btn-small" type="button" data-hide-dev="${esc(e.dev.id)}" aria-label="Hide this entry: ${esc(e.label)}">Hide</button>
      </li>`;
    }).join('');
    return `<section class="reports panel" aria-labelledby="reports-title">
      <div class="reports-head">
        <h2 id="reports-title">Reported in the news, last 45 days</h2>
        <p>Votes, adoptions, publications and delays picked up from headlines on every feed check and added to the timeline automatically. They are marked as reported until the step is entered in the regulation data${edit ? ` (<a href="${esc(edit)}" target="_blank" rel="noopener noreferrer">edit regulations.json</a>)` : ''}; the curated dates are never changed by the feeds.</p>
      </div>
      ${rows ? `<ol class="report-list">${rows}</ol>` : '<p class="reports-empty">No procedure steps were reported for this selection in the last 45 days.</p>'}
      ${hidden ? `<p class="reports-foot">${plural(hidden, 'entry', 'entries')} hidden in this browser. <button class="link-btn" type="button" data-action="unhide-devs">Show again</button></p>` : ''}
    </section>`;
  }

  function viewTimeline() {
    const f = S.timeline;
    const events = eventsFor((e) => eventMatchesPillar(e, f.pillar) && (f.past || isUpcoming(e)), f.reported);
    const years = new Map();
    events.forEach((e) => { const y = new Date(e.t).getUTCFullYear(); if (!years.has(y)) years.set(y, []); years.get(y).push(e); });
    const thisYear = new Date(TODAY).getUTCFullYear();

    let body = '';
    if (!events.length) {
      body = `<div class="empty"><strong>No dates to show.</strong>${f.pillar === 'watch' && !S.watch.size ? 'Your watchlist is empty. Star regulations on the overview to add them.' : 'Change the filter or include past dates.'}</div>`;
    } else {
      let todayPlaced = false;
      const todayMarker = `<li class="tl-today" aria-label="Today">Today, ${F.day.format(TODAY)}</li>`;
      body = [...years.entries()].map(([year, list]) => {
        let items = '';
        list.forEach((e) => {
          if (!todayPlaced && isUpcoming(e) && year >= thisYear) { items += todayMarker; todayPlaced = true; }
          const pills = (e.auto ? e.regs : [e.reg]).map((r) => regPill(r)).join('');
          const label = e.auto ? autoLabelHtml(e)
            : `<span class="label">${esc(cap(e.label))}</span>${e.approx ? '<span class="expected">expected</span>' : ''}`;
          items += `<li class="tl-item${isUpcoming(e) ? '' : ' is-past'}${e.auto ? ' is-reported' : ''}" data-pillar="${primaryPillar(e.reg)}">
            <time datetime="${new Date(e.t).toISOString().slice(0, e.monthOnly ? 7 : 10)}">${fmtEventDate(e)}</time>
            <div class="what">${pills}${label}</div>
          </li>`;
        });
        return `<section class="tl-year"><h2>${year}</h2><ol class="tl-list">${items}</ol></section>`;
      }).join('');
    }

    $view.innerHTML = `
      <div class="page-head"><h1>Timeline</h1>
        <p>Key dates across all tracked regulations, from entry into force to reporting deadlines. Dates marked expected are not fixed yet; entries marked reported come from the news and are not confirmed.</p>
        <p class="calendar-links"><a href="${esc(calendarUrl())}">Subscribe to the dates in your calendar</a> or <a href="calendar.ics" download>download them as a file</a>. A subscription updates itself when dates change.</p></div>
      <div class="filters">
        <div class="controls" role="group" aria-label="Filter by pillar">${pillarChips(f.pillar, 'tl-pillar')}</div>
        <span class="spacer"></span>
        <label class="check"><input type="checkbox" id="tl-reported"${f.reported ? ' checked' : ''}> Reported in the news</label>
        <label class="check"><input type="checkbox" id="tl-past"${f.past ? ' checked' : ''}> Show past dates</label>
      </div>
      ${f.reported ? reportedPanelHtml() : ''}
      <div class="panel" style="padding: 0.5rem 1.25rem"><div class="tl">${body}</div></div>`;
  }

  // ---------------------------------------------------------------- updates (news)
  function filteredNews() {
    const f = S.news;
    const q = f.q.trim().toLowerCase();
    return S.items.filter((it) =>
      (f.showLow || !isLow(it)) &&
      (!f.important || importanceOf(it) >= 2) &&
      (!f.reg || itemRegs(it).includes(f.reg)) &&
      (!f.kind || sourceKind(it) === f.kind) &&
      (!f.onlyNew || isNew(it)) &&
      (!f.watch || itemRegs(it).some((t) => S.watch.has(t))) &&
      (!q || `${it.title} ${it.summary || ''} ${it.publisher || ''}`.toLowerCase().includes(q)));
  }

  function viewNews() {
    const f = S.news;
    $view.innerHTML = `
      <div class="page-head"><h1>Updates</h1>
        <p>Collected from EU institutions, specialist ESG media and news searches, and tagged by regulation.${S.generatedAt ? ` Last checked ${F.stamp.format(S.generatedAt)}.` : ''}</p></div>
      <div class="filters">
        <div class="field"><label class="visually-hidden" for="news-q">Search updates</label>
          <input id="news-q" type="search" placeholder="Search updates" value="${esc(f.q)}" autocomplete="off"></div>
        <div class="field"><label class="visually-hidden" for="news-reg">Regulation</label>
          <select id="news-reg"><option value="">All regulations</option>${S.regs.slice().sort((a, b) => a.short.localeCompare(b.short))
            .map((r) => `<option value="${esc(r.id)}"${f.reg === r.id ? ' selected' : ''}>${esc(r.short)}</option>`).join('')}</select></div>
        <div class="field"><label class="visually-hidden" for="news-kind">Source type</label>
          <select id="news-kind"><option value="">All sources</option>${Object.entries(KIND_TEXT)
            .map(([k, v]) => `<option value="${k}"${f.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
        ${hasAiReview() ? `<label class="check"><input type="checkbox" id="news-important"${f.important ? ' checked' : ''}> Important only</label>` : ''}
        <label class="check"><input type="checkbox" id="news-new"${f.onlyNew ? ' checked' : ''}> New only</label>
        <label class="check"><input type="checkbox" id="news-watch"${f.watch ? ' checked' : ''}> Watchlist only</label>
        <span class="spacer"></span>
        <span class="result-count" id="news-result" aria-live="polite"></span>
      </div>
      <div id="news-results"></div>
      ${S.items.some(isLow) ? `<p class="low-toggle"><label class="check"><input type="checkbox" id="news-low"${f.showLow ? ' checked' : ''}> Also show ${plural(S.items.filter(isLow).length, 'low-relevance item')}</label></p>` : ''}`;
    renderNewsResults();
  }

  function renderNewsResults() {
    const box = document.getElementById('news-results');
    const count = document.getElementById('news-result');
    if (!box) return;
    const list = filteredNews();
    count.textContent = S.items.length ? plural(list.length, 'update') : '';
    if (!S.items.length) {
      box.innerHTML = `<div class="panel empty"><strong>No updates collected yet.</strong>
        Open the Actions tab of your GitHub repository, choose “Update and publish” and select “Run workflow”. Afterwards the feeds are checked automatically twice a day.</div>`;
      return;
    }
    if (!list.length) {
      box.innerHTML = `<div class="panel empty"><strong>No updates match these filters.</strong>
        <button class="btn btn-quiet" type="button" data-action="clear-news" style="margin-top:0.75rem">Clear filters</button></div>`;
      return;
    }
    const groups = [];
    list.slice(0, S.news.limit).forEach((it) => {
      const key = localDayKey(itemTime(it));
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(it); else groups.push({ key, t: itemTime(it), items: [it] });
    });
    const todayKey = localDayKey(Date.now());
    const yesterdayKey = localDayKey(Date.now() - DAY);
    box.innerHTML = groups.map((g) => {
      const label = g.key === todayKey ? 'Today' : g.key === yesterdayKey ? 'Yesterday' : F.localDayYear.format(g.t);
      return `<section class="day-group"><h2>${label}</h2><div class="panel"><ol class="news-list">${g.items.map((it) => newsItemHtml(it, { date: false })).join('')}</ol></div></section>`;
    }).join('') + (list.length > S.news.limit
      ? `<p style="margin-top:1.25rem"><button class="btn btn-quiet" type="button" data-action="more-news">Show ${Math.min(150, list.length - S.news.limit)} more</button></p>` : '');
  }

  // ---------------------------------------------------------------- sources
  // "Working" used to mean only "the server answered". A feed that answers without a single
  // item is reported separately now, because that usually means a bot check, not a quiet week.
  function sourceState(s) {
    if (!s.ok) return { level: 'bad', text: 'Failed', detail: [s.error || 'Unknown error', s.note].filter(Boolean).join(' ') };
    if (s.via === 'fallback') return { level: 'warn', text: 'Using fallback', detail: s.note || 'The feed gave nothing, so a news search of the same site was used.' };
    if (!s.fetched) {
      return { level: 'warn', text: 'No items',
        detail: s.empty === undefined
          ? 'The server answered without a single item, usually a bot check or an empty page instead of the feed. The next run records the exact reason.'
          : 'The feed is valid but lists no items at the moment.' };
    }
    if (!s.kept) return { level: 'ok', text: 'Working', detail: `None of the ${s.fetched} items in the feed mentions a tracked regulation or keyword.` };
    return { level: 'ok', text: 'Working', detail: '' };
  }

  function viewSources() {
    const stored = new Map();
    S.items.forEach((it) => stored.set(it.source, (stored.get(it.source) || 0) + 1));
    const states = S.sources.map(sourceState);
    const rows = S.sources.map((s, i) => {
      const st = states[i];
      return `<tr>
        <td><span class="src-name">${esc(s.name)}</span><span class="src-url">${esc(s.url)}</span></td>
        <td>${esc(KIND_TEXT[s.kind] || s.kind)}</td>
        <td><span class="status is-${st.level}">${st.text}</span>${st.detail ? `<span class="status-detail">${esc(st.detail)}</span>` : ''}</td>
        <td class="num">${s.ok ? `${s.kept} of ${s.fetched}` : '–'}</td>
        <td class="num">${stored.get(s.id) || 0}</td>
        <td>${s.last_ok ? F.stamp.format(Date.parse(s.last_ok)) : 'Never'}</td>
      </tr>`;
    }).join('');
    const failed = states.filter((st) => st.level === 'bad').length;
    const warn = states.filter((st) => st.level === 'warn').length;
    const summary = !S.sources.length ? 'No feed check has run yet.'
      : `${plural(S.sources.length, 'source')} checked${S.generatedAt ? ` on ${F.stamp.format(S.generatedAt)}` : ''}. ${
        failed === S.sources.length ? 'None of them responded on the last run. If this persists, check the log of the latest run in the Actions tab.'
          : failed || warn ? [failed ? `${plural(failed, 'source')} failed` : '', warn ? `${plural(warn, 'source')} delivered no items of ${warn === 1 ? 'its' : 'their'} own` : ''].filter(Boolean).join(' and ') + '; the others were not affected.'
            : 'All sources delivered items on the last run.'}`;
    $view.innerHTML = `
      <div class="page-head"><h1>Sources</h1><p>${summary}</p></div>
      ${S.sources.length ? `<div class="panel table-wrap"><table>
        <thead><tr><th scope="col">Source</th><th scope="col">Type</th><th scope="col" class="col-status">Last run</th><th scope="col" class="num">Kept, of items in feed</th><th scope="col" class="num">In Updates now</th><th scope="col">Last success</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : ''}
      <div class="how">
        <h2>How to read the numbers</h2>
        <ul>
          <li><strong>Kept, of items in feed.</strong> “3 of 20” means the feed listed 20 items on the last run and 3 of them mention a tracked regulation or one of the ESG keywords. Feeds only list their newest 10 to 100 items, and general feeds such as EUR-Lex or the Council press releases cover every policy area, so “0 of 100” is normal in a week without ESG legislation.</li>
          <li><strong>0 of 0</strong> is different: the server answered but sent no items. Official sites sometimes do this to automated requests. Such sources are shown as “No items”, or “Using fallback” when a news search of the same site stood in.</li>
          <li><strong>In Updates now</strong> counts the items from this source that are currently on the Updates page, collected over all runs.</li>
        </ul>
        <h2>How updates reach this page</h2>
        <ol>
          <li>A GitHub Action runs <code>scripts/fetch_feeds.py</code> twice a day, and whenever you start it by hand.</li>
          <li>It reads every feed in <code>config/sources.yml</code> and keeps items that mention a tracked regulation, its act number or an ESG keyword, in the title, teaser or full text.</li>
          <li>Items are tagged with the regulations they mention, using the keywords in <code>site/data/regulations.json</code>.</li>
          <li>Headlines that report a procedure step (a vote, publication, a delay) are grouped and added to the <a href="#/timeline">timeline</a> as reported developments.</li>
          <li>If a Gemini API key is set up, an AI review judges each new item for relevance, writes the briefing on the overview, and proposes updates to the regulation data as a pull request that you confirm.</li>
          <li>The results are saved to <code>site/data/news.json</code>, <code>site/data/developments.json</code> and <code>feed.xml</code>, and the site is published again.</li>
        </ol>
        <p style="margin-top:0.75rem">To subscribe in Outlook or a feed reader, use <a href="feed.xml">feed.xml</a>.</p>
      </div>`;
  }

  // ---------------------------------------------------------------- learn: data and progress
  const learnIds = () => [FOUNDATIONS.id, ...S.regs.map((r) => r.id)];
  const moduleMeta = (id) => (id === FOUNDATIONS.id ? FOUNDATIONS : S.byId.get(id));

  async function loadLearn(id) {
    if (S.learn.has(id)) return S.learn.get(id);
    let data = null;
    try { data = await loadJson(`data/learn/${id}.json`); } catch (err) { console.warn(`No learning page for ${id}`, err); }
    S.learn.set(id, data);
    return data;
  }
  const loadAllLearn = () => Promise.all(learnIds().map(loadLearn));

  function readingMinutes(mod) {
    const texts = [];
    const walk = (v) => { if (typeof v === 'string') texts.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk({ ...mod, quiz: null });
    return Math.max(3, Math.round(texts.join(' ').split(/\s+/).length / 200));
  }

  // Spaced repetition: a missed question is asked again after 1, 3, 7, 14 and 30 days.
  const questionKey = (moduleId, text) => { let h = 5381; const str = `${moduleId}|${text}`; for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36); };
  function recordAnswer(moduleId, text, correct) {
    const key = questionKey(moduleId, text);
    const entry = S.review[key];
    if (!correct) S.review[key] = { step: 0, due: Date.now() + REVIEW_STEPS[0] * DAY };
    else if (entry) {
      if (entry.due > Date.now()) return; // answered early; the schedule stays
      const step = entry.step + 1;
      if (step >= REVIEW_STEPS.length) delete S.review[key]; else S.review[key] = { step, due: Date.now() + REVIEW_STEPS[step] * DAY };
    } else return;
    store.set('review', S.review);
  }
  function dueQuestions() {
    const out = [];
    learnIds().forEach((id) => ((S.learn.get(id) || {}).quiz || []).forEach((q) => {
      const entry = S.review[questionKey(id, q.q)];
      if (entry && entry.due <= Date.now()) out.push({ ...q, module: id });
    }));
    return out;
  }

  const progressOf = (id) => S.progress[id] || null;
  const hasPassed = (id) => { const p = progressOf(id); return !!p && p.total > 0 && p.best / p.total >= PASS_MARK; };
  function saveResult(id, score, total) {
    const prev = progressOf(id) || { best: 0, total, attempts: 0 };
    const better = score / total >= (prev.total ? prev.best / prev.total : 0);
    S.progress[id] = { best: better ? score : prev.best, total: better ? total : prev.total, attempts: prev.attempts + 1, last: score, at: Date.now() };
    store.set('learn', S.progress);
  }

  function quizStatusHtml(id, mod) {
    const p = progressOf(id);
    if (!mod || !(mod.quiz || []).length) return '<span class="quiz-state">No quiz yet</span>';
    if (!p) return '<span class="quiz-state">Not tested yet</span>';
    return hasPassed(id)
      ? `<span class="quiz-state is-passed">Passed, ${p.best} of ${p.total}</span>`
      : `<span class="quiz-state is-open">Best ${p.best} of ${p.total}</span>`;
  }

  // ---------------------------------------------------------------- learn: index
  function viewLearn() {
    const id = S.route.param;
    if (id === 'exam') { viewExam(); return; }
    if (id === 'review') { viewExam(true); return; }
    if (id && moduleMeta(id)) { viewLearnPage(id); return; }
    viewLearnIndex();
  }

  async function viewLearnIndex() {
    const token = S.token;
    $view.innerHTML = '<div class="page-head"><h1>Learn</h1><p class="loading-inline">Loading the learning pages…</p></div>';
    await loadAllLearn();
    if (token !== S.token) return;

    const ids = learnIds();
    const withQuiz = ids.filter((id) => ((S.learn.get(id) || {}).quiz || []).length);
    const passed = withQuiz.filter(hasPassed).length;
    const order = { direct: 0, indirect: 1, watch: 2 };
    const ranked = [FOUNDATIONS.id, ...S.regs.slice().sort((a, b) => (order[levelOf(a)] ?? 3) - (order[levelOf(b)] ?? 3)).map((r) => r.id)];
    const next = ranked.find((id) => S.learn.get(id) && !hasPassed(id));
    const due = dueQuestions().length;
    const exam = progressOf('exam');

    const row = (id) => {
      const meta = moduleMeta(id);
      const mod = S.learn.get(id);
      const reg = S.byId.get(id);
      return `<li class="learn-row${hasPassed(id) ? ' is-passed' : ''}" data-pillar="${primaryPillar(meta)}">
        <div class="learn-row-main">
          <a class="learn-row-link" href="#/learn/${esc(id)}">${esc(meta.short)}</a>${reg ? levelHtml(reg) : ''}
          <p class="reg-full">${esc(meta.name)}</p>
        </div>
        <div class="learn-row-stage">${reg ? `${esc(S.stages[reg.stage])}${reg.flag ? `, ${esc((FLAG_TEXT[reg.flag] || reg.flag).toLowerCase())}` : ''}` : 'Read this first'}</div>
        <div class="learn-row-meta">${mod ? `${readingMinutes(mod)} min read, ${plural((mod.quiz || []).length, 'question')}` : 'No learning page yet'}</div>
        <div class="learn-row-state">${quizStatusHtml(id, mod)}</div>
      </li>`;
    };

    const areas = [];
    S.regs.forEach((r) => { let a = areas.find((x) => x.name === r.area); if (!a) { a = { name: r.area, ids: [] }; areas.push(a); } a.ids.push(r.id); });

    $view.innerHTML = `
      <div class="page-head learn-head">
        <div>
          <h1>Learn</h1>
          <p>One page per regulation: why it exists, who is covered, what it requires, the terms and numbers worth knowing, and how it connects to the rest. Each page ends with a short test. Status and dates on the pages come from the tracker, so they stay current.</p>
        </div>
        <aside class="learn-progress" aria-label="Your progress">
          <p class="learn-progress-count">${passed} of ${withQuiz.length}</p>
          <p class="learn-progress-label">tests passed (${Math.round(PASS_MARK * 100)}% or more)</p>
          <div class="meter" role="img" aria-label="${passed} of ${withQuiz.length} tests passed"><span style="width:${withQuiz.length ? (passed / withQuiz.length) * 100 : 0}%"></span></div>
          ${next ? `<a class="btn" href="#/learn/${esc(next)}">${passed || progressOf(next) ? 'Continue with' : 'Start with'} ${esc(moduleMeta(next).short)}</a>` : '<p class="note">Every test passed. Try the mixed test to keep it fresh.</p>'}
        </aside>
      </div>

      <section class="learn-group">
        <h2>Start here</h2>
        <div class="panel"><ul class="learn-list">${row(FOUNDATIONS.id)}</ul></div>
      </section>
      ${areas.map((a) => `<section class="learn-group">
        <h2>${esc(a.name)}</h2>
        <div class="panel"><ul class="learn-list">${a.ids.map(row).join('')}</ul></div>
      </section>`).join('')}

      ${due ? `<section class="learn-group">
        <h2>Repeat</h2>
        <div class="panel exam-teaser">
          <div>
            <p class="exam-title">${plural(due, 'question')} due again</p>
            <p class="exam-text">Questions you missed come back after 1, 3, 7, 14 and 30 days until you get them right each time.</p>
          </div>
          <a class="btn" href="#/learn/review">Repeat them now</a>
        </div>
      </section>` : ''}
      <section class="learn-group">
        <h2>Mixed test</h2>
        <div class="panel exam-teaser">
          <div>
            <p class="exam-title">${EXAM_LENGTH} questions drawn from all pages</p>
            <p class="exam-text">A different selection every time. Afterwards you see which regulations to revisit.${exam ? ` Best so far: ${exam.best} of ${exam.total}.` : ''}</p>
          </div>
          <a class="btn" href="#/learn/exam">Start the mixed test</a>
        </div>
      </section>
      <p class="learn-foot">Progress is stored in this browser only. ${Object.keys(S.progress).length ? '<button class="link-btn" type="button" data-action="reset-learn">Reset progress</button>' : ''}</p>`;
  }

  // ---------------------------------------------------------------- learn: one page
  function sectionHtml(sec) {
    const table = sec.table ? `<div class="table-wrap learn-table"><table>
      <thead><tr>${sec.table.head.map((h) => `<th scope="col">${rich(h)}</th>`).join('')}</tr></thead>
      <tbody>${sec.table.rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${rich(c)}</th>` : `<td>${rich(c)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>` : '';
    return `${(sec.text || []).map((p) => `<p>${rich(p)}</p>`).join('')}
      ${(sec.points || []).length ? `<ul>${sec.points.map((p) => `<li>${rich(p)}</li>`).join('')}</ul>` : ''}
      ${(sec.steps || []).length ? `<ol>${sec.steps.map((p) => `<li>${rich(p)}</li>`).join('')}</ol>` : ''}
      ${table}
      ${(sec.after || []).map((p) => `<p>${rich(p)}</p>`).join('')}`;
  }

  async function viewLearnPage(id) {
    const token = S.token;
    const meta = moduleMeta(id);
    const reg = S.byId.get(id);
    document.title = `Learn ${meta.short}, EU ESG Tracker`;
    $view.innerHTML = `<div class="page-head"><h1>${esc(meta.short)}</h1><p class="loading-inline">Loading the learning page…</p></div>`;
    const mod = await loadLearn(id);
    if (token !== S.token) return;

    const back = '<p class="crumb"><a href="#/learn">All learning pages</a></p>';
    if (!mod) {
      $view.innerHTML = `<div class="page-head">${back}<h1>${esc(meta.short)}</h1><p>${esc(meta.name)}</p></div>
        <div class="panel empty"><strong>There is no learning page for this regulation yet.</strong>
        Add one as <code>site/data/learn/${esc(id)}.json</code>; the README describes the format.
        ${reg ? `<p style="margin-top:0.75rem"><a class="btn btn-quiet" href="#/regulation/${esc(id)}">Open the summary</a></p>` : ''}</div>`;
      return;
    }

    const ids = learnIds();
    const pos = ids.indexOf(id);
    const prev = ids[pos - 1];
    const next = ids[pos + 1];
    const dates = reg ? eventsFor((e) => (e.auto ? e.regs.includes(reg) : e.reg === reg)) : [];
    const related = reg ? goodItems().filter((it) => itemRegs(it).includes(reg.id)) : [];
    const mine = reg ? profileOf(reg) : null;
    const quizCount = (mod.quiz || []).length;

    const blocks = [];
    const add = (key, title, html) => { if (html) blocks.push({ key, title, html }); };

    add('short', 'The short version', `<ul class="essentials">${(mod.essentials || []).map((p) => `<li>${rich(p)}</li>`).join('')}</ul>`);
    if (mine) {
      add('you', 'What this means for you', `
        <p class="you-level">${levelHtml(reg) || `<span class="level level-background">${LEVEL_TEXT.background}</span>`}<span>${rich(mine.why || '')}</span></p>
        ${(mine.points || []).length ? `<ul>${mine.points.map((x) => `<li>${rich(x)}</li>`).join('')}</ul>` : ''}
        ${(mine.ask || []).length ? `<h3>What to ask suppliers for</h3><ul class="ask">${mine.ask.map((x) => `<li>${rich(x)}</li>`).join('')}</ul>` : ''}
        <p class="live-note">Written for this profile: ${esc(S.profile.summary || '')}</p>`);
    }
    if (reg) {
      add('status', 'Where it stands now', `
        <div class="drawer-rail">${railHtml(reg)}
          <div class="stage-labels">${S.stages.map((s, i) => `<span class="${i === reg.stage ? 'is-now' : ''}">${esc(s)}</span>`).join('')}</div>
        </div>
        <p class="status-line">${esc(reg.status)}</p>
        <p class="live-note">This block and the key dates below are read from the tracker data${S.reviewed ? `, last reviewed on ${F.day.format(parseKeyDate(S.reviewed).t)}` : ''}.</p>`);
    }
    (mod.sections || []).forEach((sec, i) => add(`s${i}`, sec.title, sectionHtml(sec)));
    add('terms', 'Key terms', (mod.terms || []).length
      ? `<dl class="terms">${mod.terms.map((t) => `<div><dt>${esc(t.term)}</dt><dd>${rich(t.text)}</dd></div>`).join('')}</dl>` : '');
    add('numbers', 'Numbers to know', (mod.numbers || []).length
      ? `<dl class="numbers">${mod.numbers.map((n) => `<div><dt>${esc(n.value)}</dt><dd>${rich(n.label)}</dd></div>`).join('')}</dl>` : '');
    add('dates', 'Key dates', dates.length
      ? `<ol class="date-list">${dates.map((e) => eventRow(e, { withReg: false })).join('')}</ol>` : '');
    add('related', 'How it connects', (mod.related || []).length
      ? `<ul class="connections">${mod.related.map((r) => {
        const other = moduleMeta(r.id);
        return other ? `<li><a class="pill" data-pillar="${primaryPillar(other)}" href="#/learn/${esc(r.id)}">${esc(other.short)}</a><span>${rich(r.text)}</span></li>` : '';
      }).join('')}</ul>` : '');
    add('mistakes', 'Common mistakes', (mod.mistakes || []).length
      ? `<ul class="mistakes">${mod.mistakes.map((m) => `<li><p class="wrong"><span>Often assumed</span>${rich(m.wrong)}</p><p class="right"><span>Actually</span>${rich(m.right)}</p></li>`).join('')}</ul>` : '');
    add('practice', 'In practice', (mod.practice || []).length
      ? `<ol class="practice">${mod.practice.map((p) => `<li>${rich(p)}</li>`).join('')}</ol>` : '');
    if (reg) {
      add('texts', 'Official texts', (reg.links || []).length
        ? `<ul class="links-list">${reg.links.map((l) => `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a></li>`).join('')}</ul>` : '');
      add('news', 'Latest updates', related.length
        ? `<ol class="news-list">${related.slice(0, 4).map((it) => newsItemHtml(it, { summary: false })).join('')}</ol>
           <p class="more"><a href="#/news?reg=${esc(reg.id)}">All ${related.length} updates on ${esc(reg.short)}</a></p>` : '');
    }
    add('quiz', 'Test yourself', quizCount ? '<div id="quiz" class="quiz"></div>' : '');

    $view.innerHTML = `
      <div class="page-head learn-page-head" data-pillar="${primaryPillar(meta)}">
        ${back}
        <div class="reg-meta">${pillarsHtml(meta)}${reg ? levelHtml(reg) + flagHtml(reg) : ''}<span class="area">${esc(meta.area)}</span></div>
        <h1>${esc(meta.short)}</h1>
        <p class="learn-name">${esc(meta.name)}</p>
        ${reg ? `<p class="learn-ref">${esc(reg.reference)}</p>` : ''}
        <p class="learn-facts">${readingMinutes(mod)} min read, ${plural(quizCount, 'test question')}${mod.reviewed ? `, content reviewed on ${F.day.format(parseKeyDate(mod.reviewed).t)}` : ''}</p>
      </div>
      <div class="learn-layout" data-pillar="${primaryPillar(meta)}">
        <nav class="learn-nav" aria-label="On this page">
          <p class="learn-nav-title">On this page</p>
          <ul>${blocks.map((b) => `<li><button type="button" data-scroll="sec-${b.key}">${esc(b.title)}</button></li>`).join('')}</ul>
          <div class="learn-nav-state">${quizStatusHtml(id, mod)}</div>
        </nav>
        <article class="learn-body">
          ${blocks.map((b) => `<section id="sec-${b.key}" class="learn-section learn-${/^s\d+$/.test(b.key) ? 'text' : b.key}" tabindex="-1"><h2>${esc(b.title)}</h2>${b.html}</section>`).join('')}
          <nav class="learn-pager" aria-label="Other learning pages">
            ${prev ? `<a href="#/learn/${esc(prev)}"><span>Previous</span>${esc(moduleMeta(prev).short)}</a>` : '<span></span>'}
            ${next ? `<a class="is-next" href="#/learn/${esc(next)}"><span>Next</span>${esc(moduleMeta(next).short)}</a>` : '<a class="is-next" href="#/learn/exam"><span>Next</span>Mixed test</a>'}
          </nav>
          <p class="learn-disclaimer">For orientation and learning, not legal advice. The texts on EUR-Lex are authoritative.</p>
        </article>
      </div>`;

    if (quizCount) {
      S.quiz = newQuiz({ key: id, title: meta.short, questions: mod.quiz.map((q) => ({ ...q, module: id })) });
      renderQuiz();
    }
  }

  // ---------------------------------------------------------------- learn: mixed test
  async function viewExam(review = false) {
    const token = S.token;
    const name = review ? 'Repeat' : 'Mixed test';
    document.title = `${name}, EU ESG Tracker`;
    $view.innerHTML = `<div class="page-head"><h1>${name}</h1><p class="loading-inline">Collecting questions…</p></div>`;
    await loadAllLearn();
    if (token !== S.token) return;
    if (review) {
      const picked = shuffle(dueQuestions()).slice(0, 15);
      $view.innerHTML = `
        <div class="page-head"><p class="crumb"><a href="#/learn">All learning pages</a></p><h1>Repeat</h1>
          <p>${picked.length ? `${plural(picked.length, 'question')} you missed earlier.` : 'Nothing is due right now.'}</p></div>
        <div class="learn-layout is-single"><article class="learn-body"><div id="quiz" class="quiz"></div></article></div>`;
      if (!picked.length) { document.getElementById('quiz').innerHTML = '<p><a class="btn" href="#/learn">Back to all pages</a></p>'; return; }
      S.quiz = newQuiz({ key: 'review', title: 'Repeat', questions: picked, mixed: true });
      S.quiz.started = true;
      renderQuiz();
      return;
    }

    // One question per page in turn, pages in random order, until the test is full.
    const pools = shuffle(learnIds().map((id) => ({ id, qs: shuffle(((S.learn.get(id) || {}).quiz || []).slice()) })).filter((p) => p.qs.length));
    const picked = [];
    while (picked.length < EXAM_LENGTH && pools.some((p) => p.qs.length)) {
      pools.forEach((p) => { if (picked.length < EXAM_LENGTH && p.qs.length) picked.push({ ...p.qs.pop(), module: p.id }); });
    }
    $view.innerHTML = `
      <div class="page-head"><p class="crumb"><a href="#/learn">All learning pages</a></p><h1>Mixed test</h1>
        <p>${plural(picked.length, 'question')} drawn from all learning pages. Each answer is explained straight away.</p></div>
      <div class="learn-layout is-single"><article class="learn-body"><div id="quiz" class="quiz"></div></article></div>`;
    if (!picked.length) { document.getElementById('quiz').innerHTML = '<p>No questions are available yet.</p>'; return; }
    S.quiz = newQuiz({ key: 'exam', title: 'Mixed test', questions: picked, mixed: true });
    S.quiz.started = true;
    renderQuiz();
  }

  // ---------------------------------------------------------------- learn: quiz engine
  function newQuiz({ key, title, questions, mixed = false }) {
    return {
      key, title, mixed, started: false, i: 0, answers: [],
      questions: shuffle(questions).map((q) => ({
        q: q.q, why: q.why, module: q.module,
        options: shuffle(q.options.map((text, i) => ({ text, correct: i === q.answer }))),
      })),
    };
  }

  function quizRail(z) {
    return `<div class="quiz-rail" role="img" aria-label="Question ${Math.min(z.i + 1, z.questions.length)} of ${z.questions.length}">${z.questions.map((_, i) => {
      const a = z.answers[i];
      return `<span class="${a === undefined ? (i === z.i ? 'now' : '') : a.correct ? 'right' : 'wrong'}"></span>`;
    }).join('')}</div>`;
  }

  function renderQuiz(focus) {
    const box = document.getElementById('quiz');
    const z = S.quiz;
    if (!box || !z) return;
    const total = z.questions.length;
    const p = progressOf(z.key);

    if (!z.started) {
      box.innerHTML = `<div class="quiz-card quiz-intro">
        <p>${plural(total, 'question')} on this page, each with an explanation. ${Math.round(PASS_MARK * 100)}% correct counts as passed.${p ? ` Your best so far: ${p.best} of ${p.total}.` : ''}</p>
        <button class="btn" type="button" data-quiz="start">${p ? 'Take the test again' : 'Start the test'}</button></div>`;
      return;
    }

    if (z.i >= total) {
      const score = z.answers.filter((a) => a.correct).length;
      const passed = score / total >= PASS_MARK;
      const missed = z.questions.map((q, i) => ({ q, a: z.answers[i] })).filter((x) => !x.a.correct);
      const byModule = new Map();
      missed.forEach((x) => byModule.set(x.q.module, (byModule.get(x.q.module) || 0) + 1));
      const ids = learnIds();
      const nextId = ids[ids.indexOf(z.key) + 1];
      box.innerHTML = `<div class="quiz-card quiz-result${passed ? ' is-passed' : ''}" tabindex="-1">
        ${quizRail(z)}
        <p class="quiz-score">${score} of ${total}</p>
        <p class="quiz-verdict">${passed ? (score === total ? 'Passed, without a single mistake.' : 'Passed.') : `Not passed yet. ${Math.ceil(total * PASS_MARK)} correct answers are needed.`}</p>
        ${z.mixed && byModule.size ? `<div class="quiz-revisit"><h3>Worth revisiting</h3><ul>${[...byModule.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => {
          const m = moduleMeta(id);
          return m ? `<li><a class="pill" data-pillar="${primaryPillar(m)}" href="#/learn/${esc(id)}">${esc(m.short)}</a><span>${plural(n, 'missed question')}</span></li>` : '';
        }).join('')}</ul></div>` : ''}
        ${missed.length ? `<div class="quiz-review"><h3>Questions you missed</h3><ol>${missed.map((x) => `<li>
          <p class="review-q">${rich(x.q.q)}</p>
          <p class="review-a"><span>Your answer</span>${rich(x.a.chosen)}</p>
          <p class="review-a is-right"><span>Correct</span>${rich(x.q.options.find((o) => o.correct).text)}</p>
          <p class="review-why">${rich(x.q.why)}</p></li>`).join('')}</ol></div>` : ''}
        <div class="quiz-actions">
          <button class="btn${passed ? ' btn-quiet' : ''}" type="button" data-quiz="retry">Try again</button>
          ${z.mixed ? '<a class="btn btn-quiet" href="#/learn">Back to all pages</a>'
            : nextId ? `<a class="btn${passed ? '' : ' btn-quiet'}" href="#/learn/${esc(nextId)}">Next: ${esc(moduleMeta(nextId).short)}</a>`
              : '<a class="btn" href="#/learn/exam">Take the mixed test</a>'}
        </div></div>`;
      if (focus) box.querySelector('.quiz-result').focus({ preventScroll: true });
      const state = document.querySelector('.learn-nav-state');
      if (state && !z.mixed) state.innerHTML = quizStatusHtml(z.key, S.learn.get(z.key));
      return;
    }

    const q = z.questions[z.i];
    const answer = z.answers[z.i];
    const m = z.mixed ? moduleMeta(q.module) : null;
    box.innerHTML = `<div class="quiz-card">
      ${quizRail(z)}
      <p class="quiz-count">Question ${z.i + 1} of ${total}${m ? ` <span class="pill" data-pillar="${primaryPillar(m)}">${esc(m.short)}</span>` : ''}</p>
      <h3 class="quiz-q" id="quiz-q" tabindex="-1">${rich(q.q)}</h3>
      <div class="quiz-options" role="group" aria-labelledby="quiz-q">${q.options.map((o, i) => {
        const cls = answer ? (o.correct ? ' is-right' : answer.index === i ? ' is-wrong' : '') : '';
        return `<button type="button" class="quiz-opt${cls}" data-opt="${i}"${answer ? ' disabled' : ''}>
          <span class="opt-key" aria-hidden="true">${'ABCDEF'[i]}</span><span class="opt-text">${rich(o.text)}</span>
          ${answer && o.correct ? '<span class="opt-mark">Correct</span>' : answer && answer.index === i ? '<span class="opt-mark">Your answer</span>' : ''}</button>`;
      }).join('')}</div>
      <div class="quiz-feedback" aria-live="polite">${answer ? `
        <p class="quiz-why${answer.correct ? ' is-right' : ' is-wrong'}"><strong>${answer.correct ? 'Correct.' : 'Not quite.'}</strong> ${rich(q.why)}</p>
        <button class="btn" type="button" data-quiz="next">${z.i + 1 < total ? 'Next question' : 'See the result'}</button>` : ''}</div>
    </div>`;
    if (focus === 'question') box.querySelector('#quiz-q').focus({ preventScroll: true });
    if (focus === 'next') box.querySelector('[data-quiz="next"]').focus({ preventScroll: true });
  }

  function quizAction(action, opt) {
    const z = S.quiz;
    if (!z) return;
    if (action === 'start') { z.started = true; renderQuiz('question'); return; }
    if (action === 'retry') {
      S.quiz = newQuiz({ key: z.key, title: z.title, mixed: z.mixed, questions: z.questions.map((q) => ({ q: q.q, why: q.why, module: q.module, options: q.options.map((o) => o.text), answer: q.options.findIndex((o) => o.correct) })) });
      if (z.mixed) { viewExam(z.key === 'review'); return; }
      S.quiz.started = true;
      renderQuiz('question');
      return;
    }
    if (action === 'answer' && z.answers[z.i] === undefined) {
      const o = z.questions[z.i].options[opt];
      z.answers[z.i] = { index: opt, chosen: o.text, correct: o.correct };
      recordAnswer(z.questions[z.i].module, z.questions[z.i].q, o.correct);
      renderQuiz('next');
      return;
    }
    if (action === 'next') {
      z.i += 1;
      if (z.i >= z.questions.length) {
        if (z.key !== 'review') saveResult(z.key, z.answers.filter((a) => a.correct).length, z.questions.length);
        renderQuiz('result');
      } else {
        renderQuiz('question');
      }
      document.getElementById('quiz').scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }

  // ---------------------------------------------------------------- drawer
  function openDrawer(id, focusTarget = 'close') {
    const reg = S.byId.get(id);
    if (!reg) return;
    const on = S.watch.has(reg.id);
    const dates = eventsFor((e) => (e.auto ? e.regs.includes(reg) : e.reg === reg));
    const related = goodItems().filter((it) => itemRegs(it).includes(reg.id));
    const mine = profileOf(reg);
    $drawerContent.dataset.pillar = primaryPillar(reg);
    $drawerContent.innerHTML = `
      <div class="drawer-top">
        <div class="reg-meta">${pillarsHtml(reg)}${levelHtml(reg)}${flagHtml(reg)}<span class="area">${esc(reg.area)}</span></div>
        <div class="actions">
          <button class="btn btn-quiet star-btn" type="button" data-watch="${esc(reg.id)}" aria-pressed="${on}">${STAR_SVG}<span>${on ? 'On watchlist' : 'Add to watchlist'}</span></button>
          <button class="icon-btn" type="button" data-action="close-drawer" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
      </div>
      <h1 id="drawer-title">${esc(reg.short)}</h1>
      <p class="full-name">${esc(reg.name)}</p>
      <p class="reference">${esc(reg.reference)}</p>
      <div class="drawer-rail">${railHtml(reg)}
        <div class="stage-labels">${S.stages.map((s, i) => `<span class="${i === reg.stage ? 'is-now' : ''}">${esc(s)}</span>`).join('')}</div>
      </div>
      <p class="status-line">${esc(reg.status)}</p>
      <p class="drawer-learn"><a class="btn" href="#/learn/${esc(reg.id)}">Open the learning page</a>${hasPassed(reg.id) ? '<span class="quiz-state is-passed">Test passed</span>' : ''}</p>
      ${mine ? `<section><h2>For you</h2><p class="prose"><strong>${esc(LEVEL_TEXT[mine.level] || '')}.</strong> ${esc(mine.why || '')}</p></section>` : ''}
      <section><h2>What it does</h2><p class="prose">${esc(reg.summary)}</p></section>
      <section><h2>Who is covered</h2><p class="prose">${esc(reg.scope)}</p></section>
      ${dates.length ? `<section><h2>Key dates</h2><ol class="date-list">${dates.map((e) => eventRow(e, { withReg: false })).join('')}</ol></section>` : ''}
      ${(reg.links || []).length ? `<section><h2>Official texts and pages</h2><ul class="links-list">${reg.links
        .map((l) => `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a></li>`).join('')}</ul></section>` : ''}
      <section><h2>Related updates</h2>${related.length
        ? `<ol class="news-list">${related.slice(0, 6).map((it) => newsItemHtml(it, { summary: false })).join('')}</ol>
           ${related.length > 6 ? `<p style="margin-top:0.75rem"><a href="#/news?reg=${esc(reg.id)}">All ${related.length} updates on ${esc(reg.short)}</a></p>` : ''}`
        : '<p class="prose" style="color:var(--ink-2)">No updates mention this regulation in the current feed window.</p>'}</section>`;
    if (!$drawer.open) $drawer.showModal();
    $drawer.scrollTop = 0;
    const target = focusTarget === 'watch' ? '[data-watch]' : '[data-action="close-drawer"]';
    $drawerContent.querySelector(target).focus({ preventScroll: true });
  }

  $drawer.addEventListener('close', () => {
    if (location.hash.startsWith('#/regulation/')) history.replaceState(null, '', S.lastViewHash);
  });
  $drawer.addEventListener('click', (e) => { if (e.target === $drawer) $drawer.close(); });

  // ---------------------------------------------------------------- theme
  function currentTheme() {
    return document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function syncThemeButton() {
    const btn = document.getElementById('theme-toggle');
    const dark = currentTheme() === 'dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.title = btn.getAttribute('aria-label');
    btn.innerHTML = dark
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z"/></svg>';
  }
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('esgTracker.theme', next); } catch (e) { /* ignore */ }
    syncThemeButton();
  });

  // ---------------------------------------------------------------- events (delegated)
  function toggleWatch(id) {
    if (S.watch.has(id)) S.watch.delete(id); else S.watch.add(id);
    store.set('watch', [...S.watch]);
    const y = window.scrollY;
    renderView();
    if ($drawer.open) { openDrawer(id, 'watch'); return; }
    window.scrollTo({ top: y });
    const again = $view.querySelector(`[data-watch="${CSS.escape(id)}"]`);
    if (again) again.focus({ preventScroll: true });
  }

  function setHiddenDevs(ids) {
    S.hiddenDevs = new Set(ids);
    store.set('hiddenDevs', [...S.hiddenDevs]);
    buildAutoEvents();
    const y = window.scrollY;
    renderView();
    window.scrollTo({ top: y });
  }

  document.addEventListener('click', (e) => {
    const watchBtn = e.target.closest('[data-watch]');
    if (watchBtn) { e.preventDefault(); toggleWatch(watchBtn.dataset.watch); return; }

    const chip = e.target.closest('[data-board-pillar]');
    if (chip) { S.board.pillar = chip.dataset.boardPillar; document.querySelectorAll('[data-board-pillar]').forEach((c) => c.setAttribute('aria-pressed', c === chip)); document.getElementById('board').innerHTML = boardHtml(); return; }

    const tlChip = e.target.closest('[data-tl-pillar]');
    if (tlChip) { S.timeline.pillar = tlChip.dataset.tlPillar; viewTimeline(); return; }

    const hide = e.target.closest('[data-hide-dev]');
    if (hide) { setHiddenDevs([...S.hiddenDevs, hide.dataset.hideDev]); return; }

    const scroll = e.target.closest('[data-scroll]');
    if (scroll) {
      const target = document.getElementById(scroll.dataset.scroll);
      if (target) { target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true }); }
      return;
    }

    const opt = e.target.closest('[data-opt]');
    if (opt) { quizAction('answer', Number(opt.dataset.opt)); return; }
    const quizBtn = e.target.closest('[data-quiz]');
    if (quizBtn) { quizAction(quizBtn.dataset.quiz); return; }

    const action = e.target.closest('[data-action]');
    if (!action) return;
    const a = action.dataset.action;
    if (a === 'mark-read') markAllRead();
    if (a === 'close-drawer') $drawer.close();
    if (a === 'more-news') { S.news.limit += 150; renderNewsResults(); }
    if (a === 'clear-news') { Object.assign(S.news, { q: '', reg: '', kind: '', onlyNew: false, watch: false, important: false }); history.replaceState(null, '', '#/news'); viewNews(); }
    if (a === 'unhide-devs') setHiddenDevs([]);
    if (a === 'reset-learn' && window.confirm('Delete your test results in this browser?')) { S.progress = {}; S.review = {}; store.set('learn', S.progress); store.set('review', S.review); renderView(); }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'board-q') { S.board.q = t.value; document.getElementById('board').innerHTML = boardHtml(); }
    if (t.id === 'news-q') { S.news.q = t.value; S.news.limit = 150; renderNewsResults(); }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'board-sort') { S.board.sort = t.value; document.getElementById('board').innerHTML = boardHtml(); }
    if (t.id === 'tl-past') { S.timeline.past = t.checked; viewTimeline(); }
    if (t.id === 'tl-reported') { S.timeline.reported = t.checked; viewTimeline(); }
    if (t.id === 'board-jur') { S.board.jur = t.value; document.getElementById('board').innerHTML = boardHtml(); }
    const newsFields = { 'news-reg': 'reg', 'news-kind': 'kind', 'news-new': 'onlyNew', 'news-watch': 'watch', 'news-important': 'important', 'news-low': 'showLow' };
    if (newsFields[t.id]) {
      S.news[newsFields[t.id]] = t.type === 'checkbox' ? t.checked : t.value;
      S.news.limit = 150;
      if (location.hash.includes('?')) history.replaceState(null, '', '#/news');
      renderNewsResults();
    }
  });

  window.addEventListener('hashchange', route);
  init();
})();
