/* Terra, the tracker's assistant: a pixel-art globe that floats in a corner and answers
   questions about the rules this site covers.

   How it answers
   - It always works from the site's own content: regulations.json, profile.json, the learning
     pages and the briefing. Nothing else is treated as a fact.
   - Without an API key it shows the matching dates, relevance notes and passages itself.
   - With a Google Gemini key, entered once per browser and stored only there, it sends the
     question together with the matching content to Gemini and shows the written answer.
     A key cannot be hidden on a public, static website, which is why it is never part of the
     repository. If Google cannot be reached, the passages are shown instead.

   This file is independent of app.js. It only reads data files and the address bar. */
(() => {
  'use strict';

  // ---------------------------------------------------------------- small helpers
  const PREFIX = 'esgTracker.';
  const store = {
    get(key, fallback = null) { try { const v = localStorage.getItem(PREFIX + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ } },
    remove(key) { try { localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ } },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY = 86400000;
  const fmtDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const fmtMonth = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STAGES = ['Proposed', 'Negotiating', 'Adopted', 'In force', 'Applies'];
  const LEVELS = { direct: 'applies to you', indirect: 'reaches you indirectly', watch: 'could apply soon', background: 'background' };
  const API = 'https://generativelanguage.googleapis.com/v1beta';

  // Simple formatting for answers: paragraphs, "- " bullets and **bold**. Everything is escaped first.
  function formatText(text) {
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const out = [];
    let list = [];
    const flush = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); list = []; } };
    String(text).split(/\n+/).forEach((line) => {
      const t = line.trim();
      if (!t) return;
      const bullet = t.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (bullet) list.push(bullet[1]); else { flush(); out.push(`<p>${inline(t)}</p>`); }
    });
    flush();
    return out.join('');
  }

  // ---------------------------------------------------------------- the sprite sheet (6 x 4 frames)
  const FRAME = {
    blink: [0, 0], idle: [1, 0], smile: [2, 0], wink: [3, 0], blush: [4, 0], shy: [5, 0],
    calm: [0, 1], oh: [1, 1], ooh: [2, 1], talk: [3, 1], grin: [4, 1], laugh: [5, 1],
    cry: [0, 2], sad: [1, 2], angry: [2, 2], shock: [3, 2], sleep1: [4, 2], sleep2: [5, 2],
    wave: [1, 3], love: [2, 3], think: [3, 3], flushed: [4, 3],
  };

  // ---------------------------------------------------------------- markup
  const root = document.createElement('div');
  root.className = 'terra';
  root.innerHTML = `
    <div class="terra-panel" id="terra-panel" role="dialog" aria-label="Ask Terra about the rules" hidden>
      <div class="terra-head">
        <h2>Ask Terra</h2>
        <button type="button" data-terra="setup" aria-label="Settings for AI answers" title="Settings for AI answers"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><path d="M14 4v6M6 14v6"/></svg></button>
        <button type="button" data-terra="close" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="terra-chat">
        <div class="terra-log" role="log" aria-live="polite"></div>
        <div class="terra-chips"></div>
        <form class="terra-form">
          <label class="visually-hidden" for="terra-input">Your question</label>
          <textarea id="terra-input" rows="1" placeholder="Ask about a rule, a date, a duty…" autocomplete="off"></textarea>
          <button class="terra-btn" type="submit">Ask</button>
        </form>
        <p class="terra-foot"></p>
      </div>
      <div class="terra-setup" hidden></div>
    </div>
    <p class="terra-say" hidden></p>
    <button class="terra-pet" type="button" aria-label="Ask Terra, the tracker's assistant" aria-expanded="false" aria-controls="terra-panel">
      <span class="terra-sprite" aria-hidden="true"></span>
    </button>`;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const $pet = $('.terra-pet');
  const $sprite = $('.terra-sprite');
  const $panel = $('.terra-panel');
  const $log = $('.terra-log');
  const $chips = $('.terra-chips');
  const $form = $('.terra-form');
  const $input = $('#terra-input');
  const $foot = $('.terra-foot');
  const $chat = $('.terra-chat');
  const $setup = $('.terra-setup');
  const $say = $('.terra-say');

  // ---------------------------------------------------------------- the mascot's moods and movement
  const pet = { mood: 'idle', until: 0, tick: 0, lastActive: Date.now(), nextBlink: Date.now() + 3000, nextStroll: Date.now() + 25000, offset: 0 };

  function show(name) {
    const [col, row] = FRAME[name] || FRAME.idle;
    $sprite.style.setProperty('--col', col);
    $sprite.style.setProperty('--row', row);
  }

  /** Set a mood. With a duration it falls back to idle afterwards. */
  function mood(name, ms = 0) {
    pet.mood = name;
    pet.until = ms ? Date.now() + ms : 0;
    root.classList.toggle('is-thinking', name === 'think');
    root.classList.toggle('is-sleeping', name === 'sleep');
    frame();
  }

  function frame() {
    const now = Date.now();
    pet.tick += 1;
    if (pet.until && now > pet.until) { pet.mood = 'idle'; pet.until = 0; root.classList.remove('is-thinking', 'is-sleeping'); }
    switch (pet.mood) {
      case 'sleep': show(pet.tick % 6 < 3 ? 'sleep1' : 'sleep2'); break;
      case 'think': show(pet.tick % 8 < 6 ? 'think' : 'ooh'); break;
      case 'talk': show(['talk', 'smile', 'talk', 'idle'][pet.tick % 4]); break;
      case 'idle':
        if (now > pet.nextBlink) { show('blink'); pet.nextBlink = now + 2600 + Math.random() * 4200; }
        else show(pet.tick % 47 === 0 ? 'calm' : 'idle');
        break;
      default: show(pet.mood);
    }
  }

  function say(text, ms = 4500) {
    $say.textContent = text;
    $say.hidden = false;
    clearTimeout(say.timer);
    say.timer = setTimeout(() => { $say.hidden = true; }, ms);
  }

  function hop() {
    if (reduceMotion()) return;
    root.classList.remove('is-hopping');
    void root.offsetWidth; // restart the animation
    root.classList.add('is-hopping');
    setTimeout(() => root.classList.remove('is-hopping'), 1600);
  }

  /** Now and then Terra wanders a few steps along the edge and back. */
  function stroll() {
    if (reduceMotion() || isOpen() || pet.mood !== 'idle' || root.classList.contains('is-dragging')) return;
    const room = root.classList.contains('is-left') ? 1 : -1; // walk towards the middle of the page
    pet.offset = pet.offset ? 0 : room * (40 + Math.round(Math.random() * 70));
    $pet.style.transform = `translateX(${pet.offset}px)`;
    hop();
  }

  setInterval(() => {
    const now = Date.now();
    if (!isOpen() && pet.mood === 'idle' && now - pet.lastActive > 90000) mood('sleep');
    if (now > pet.nextStroll) { pet.nextStroll = now + 22000 + Math.random() * 30000; stroll(); }
    frame();
  }, 230);

  function wake() {
    pet.lastActive = Date.now();
    if (pet.mood === 'sleep') { mood('oh', 700); }
  }
  ['pointermove', 'keydown', 'scroll'].forEach((type) => window.addEventListener(type, wake, { passive: true }));

  $pet.addEventListener('pointerenter', () => { if (!isOpen() && (pet.mood === 'idle' || pet.mood === 'sleep')) mood('wave', 1400); });
  $pet.addEventListener('focus', () => { if (!isOpen() && pet.mood === 'idle') mood('wave', 1400); });

  // Drag to move; a press without movement is a click that opens the panel.
  const drag = { active: false, moved: false, dx: 0, dy: 0 };
  function place(x, y, remember = true) {
    const w = root.offsetWidth, h = root.offsetHeight;
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, x));
    const top = Math.max(4, Math.min(window.innerHeight - h - 4, y));
    root.classList.add('is-placed');
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.classList.toggle('is-left', left + w / 2 < window.innerWidth / 2);
    if (remember) store.set('terraSpot', { x: left / Math.max(1, window.innerWidth - w), y: top / Math.max(1, window.innerHeight - h) });
  }
  function restoreSpot() {
    const spot = store.get('terraSpot');
    if (!spot) return;
    place(spot.x * (window.innerWidth - root.offsetWidth), spot.y * (window.innerHeight - root.offsetHeight), false);
  }
  $pet.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    const box = root.getBoundingClientRect();
    Object.assign(drag, { active: true, moved: false, dx: e.clientX - box.left, dy: e.clientY - box.top, sx: e.clientX, sy: e.clientY });
    $pet.setPointerCapture(e.pointerId);
  });
  $pet.addEventListener('pointermove', (e) => {
    if (!drag.active) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 7) return;
    if (!drag.moved) { drag.moved = true; root.classList.add('is-dragging'); pet.offset = 0; $pet.style.transform = ''; mood('oh'); }
    place(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  const endDrag = () => {
    if (!drag.active) return;
    drag.active = false;
    if (drag.moved) { root.classList.remove('is-dragging'); mood('grin', 900); layoutPanel(); }
  };
  $pet.addEventListener('pointerup', endDrag);
  $pet.addEventListener('pointercancel', endDrag);
  $pet.addEventListener('click', (e) => {
    if (drag.moved) { drag.moved = false; e.preventDefault(); return; }
    toggle();
  });
  window.addEventListener('resize', () => { restoreSpot(); layoutPanel(); });

  // ---------------------------------------------------------------- data from the site
  const D = { ready: null, regs: [], byId: new Map(), profile: {}, learn: new Map(), briefing: null, chunks: [] };

  async function getJson(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }
  const optional = (path, fallback) => getJson(path).catch(() => fallback);

  function loadData() {
    if (D.ready) return D.ready;
    D.ready = (async () => {
      const regData = await getJson('data/regulations.json');
      D.regs = regData.regulations;
      D.regs.forEach((r) => D.byId.set(r.id, r));
      [D.profile, D.briefing] = await Promise.all([optional('data/profile.json', {}), optional('data/briefing.json', null)]);
      const ids = ['foundations', ...D.regs.map((r) => r.id)];
      const pages = await Promise.all(ids.map((id) => optional(`data/learn/${id}.json`, null)));
      ids.forEach((id, i) => { if (pages[i]) D.learn.set(id, pages[i]); });
      buildChunks();
    })();
    D.ready.catch(() => { D.ready = null; });
    return D.ready;
  }

  const plain = (s) => String(s || '').replace(/\*\*/g, '');
  const nameOf = (id) => (id === 'foundations' ? 'Foundations' : (D.byId.get(id) || {}).short || id);
  const mine = (id) => (D.profile.regulations || {})[id] || null;

  function sectionText(sec) {
    const parts = [...(sec.text || []), ...(sec.points || []), ...(sec.steps || [])];
    if (sec.table) parts.push(...sec.table.rows.map((row) => row.join(': ')));
    parts.push(...(sec.after || []));
    return parts.map(plain).join(' ');
  }

  /** Passages for the keyless mode: one per section, term, number and mistake. */
  function buildChunks() {
    const add = (id, title, text) => { if (text) D.chunks.push({ id, title, text: plain(text), tokens: tokens(`${title} ${text}`) }); };
    D.regs.forEach((r) => {
      add(r.id, 'What it does', r.summary);
      add(r.id, 'Who is covered', r.scope);
      add(r.id, 'Where it stands', r.status);
      const m = mine(r.id);
      if (m) add(r.id, 'What it means for you', [m.why, ...(m.points || [])].join(' '));
      if (m && (m.ask || []).length) add(r.id, 'What to ask suppliers for', m.ask.join('; '));
    });
    D.learn.forEach((page, id) => {
      add(id, 'The short version', (page.essentials || []).join(' '));
      (page.sections || []).forEach((sec) => add(id, sec.title, sectionText(sec)));
      (page.terms || []).forEach((t) => add(id, t.term, t.text));
      (page.numbers || []).forEach((n) => add(id, n.value, `${n.value}: ${n.label}`));
      (page.mistakes || []).forEach((m) => add(id, 'Common mistake', `Often assumed: ${m.wrong} Actually: ${m.right}`));
      if ((page.practice || []).length) add(id, 'In practice', page.practice.join(' '));
    });
  }

  // ---------------------------------------------------------------- finding what a question is about
  const STOP = new Set(('a an and are as at be by can do does for from has have how i if in is it its me my of on or our so that the their them then there these they this to up us was we what when where which who why will with would you your about into over than also not no yes ' +
    'der die das den dem des ein eine einer einen einem und oder ist sind war wie was wer wo wann warum wieso welche welcher welches für von mit auf bei zu zum zur im in an am es ich wir uns unser unsere man muss müssen kann können soll sollen gibt gilt gelten nicht auch noch schon denn dass ob aus nach über unter bis').split(' '));
  // Questions may be asked in German while the content is English.
  const GERMAN = {
    batterie: 'battery batteries', akku: 'battery batteries', lieferkette: 'supply chain', lieferant: 'supplier suppliers', verpackung: 'packaging',
    zwangsarbeit: 'forced labour', entwaldung: 'deforestation', reparatur: 'repair', maschine: 'machinery', chemikalie: 'chemicals substances', stoff: 'substances',
    bericht: 'reporting report', frist: 'deadline date', termin: 'deadline date', strafe: 'fine penalty', 'bußgeld': 'fine penalty', sanktion: 'penalty',
    schwelle: 'threshold', emissionshandel: 'emissions trading', kohlenstoff: 'carbon', werbung: 'claims', aussage: 'claims', 'ökodesign': 'ecodesign',
    produktpass: 'product passport', taxonomie: 'taxonomy', sorgfalt: 'due diligence', menschenrecht: 'human rights', daten: 'data', konfliktmineral: 'conflict minerals',
    holz: 'wood', entgelt: 'pay', lohn: 'pay wage', gehalt: 'pay', anleihe: 'bond', nachhaltigkeit: 'sustainability', kunde: 'customers', mitarbeiter: 'employees',
    umsatz: 'turnover', grenzausgleich: 'carbon border', einfuhr: 'import importer', importeur: 'importer', hersteller: 'manufacturer', pflicht: 'duties obligation',
    werkzeug: 'tools', prüfung: 'audit assurance', recycling: 'recycled recycling', betrifft: 'applies', betroffen: 'applies covered', neu: 'new changed',
  };
  function tokens(text) {
    const out = [];
    String(text).toLowerCase().normalize('NFC').split(/[^a-z0-9äöüß€.]+/).forEach((raw) => {
      const w = raw.replace(/^\.+|\.+$/g, '');
      if (w.length < 2 || STOP.has(w)) return;
      out.push(w);
      Object.keys(GERMAN).forEach((key) => { if (w.startsWith(key)) out.push(...GERMAN[key].split(' ')); });
    });
    return out;
  }
  const stem = (w) => (w.length > 4 ? w.replace(/(ies|es|s|ing|ed)$/, '') : w);

  function currentRegId() {
    const m = location.hash.match(/^#\/(?:learn|regulation)\/([\w-]+)/);
    return m && (D.byId.has(m[1]) || m[1] === 'foundations') ? m[1] : null;
  }

  /** Words of each regulation's description, and how many regulations use each word. */
  function regWords() {
    if (regWords.cache) return regWords.cache;
    const perReg = new Map();
    const df = new Map();
    D.regs.forEach((r) => {
      const m = mine(r.id) || {};
      const words = new Set(tokens(`${r.name} ${r.area} ${r.summary} ${r.scope} ${m.why || ''} ${(m.points || []).join(' ')}`).map(stem));
      perReg.set(r.id, words);
      words.forEach((w) => df.set(w, (df.get(w) || 0) + 1));
    });
    regWords.cache = { perReg, df };
    return regWords.cache;
  }

  /** Regulations a question most likely concerns, best first. */
  function matchRegs(question) {
    const qTokens = [...new Set(tokens(question).map(stem))];
    // Names are looked for in the question and in its translated keywords ("Batterien" -> "batteries").
    const q = ` ${question.toLowerCase()} ${tokens(question).join(' ')} `;
    const { perReg, df } = regWords();
    const total = D.regs.length;
    const scored = D.regs.map((r) => {
      let score = 0;
      const names = [r.short, r.id.replace(/-/g, ' '), ...(r.keywords || []).map((k) => k.replace(/\*$/, ''))];
      if (names.some((n) => {
        const needle = n.toLowerCase();
        const at = needle.length < 3 ? -1 : q.indexOf(needle);
        return at >= 0 && !/[a-z0-9]/.test(q[at - 1]) && !/[a-rt-z0-9]/.test(q[at + needle.length] || ' ');
      })) score += 8;
      // A word that describes only a few regulations says a lot; one that fits a third of them says nothing.
      const words = perReg.get(r.id);
      qTokens.forEach((w) => { const n = df.get(w) || 0; if (words.has(w) && n <= total / 4) score += Math.log(total / n); });
      return { id: r.id, score };
    }).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score);
    let top = scored.length ? scored.filter((x) => x.score >= scored[0].score * 0.55).slice(0, 3).map((x) => x.id) : [];
    // "Which rules apply to us?" is about all of them unless a rule is named.
    if (WANTS_RELEVANCE.test(question) && (!scored.length || scored[0].score < 8)) top = [];
    const here = currentRegId();
    if (!top.length && here && here !== 'foundations' && !/\b(which|welche)\b/i.test(question)) top.push(here);
    return top;
  }

  function bestChunks(question, regIds, limit = 3) {
    const qTokens = [...new Set(tokens(question).map(stem))];
    if (!qTokens.length) return [];
    return D.chunks.map((c) => {
      const words = new Set(c.tokens.map(stem));
      let score = qTokens.reduce((n, w) => n + (words.has(w) ? 1 : 0), 0);
      if (regIds.includes(c.id)) score += 1.5;
      return { c, score: score / Math.sqrt(8 + c.tokens.length / 12) };
    }).filter((x) => x.score > 0.45).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.c);
  }

  // ---------------------------------------------------------------- dates
  const today = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); };
  function parseDate(value) { const [y, m, d] = value.split('-').map(Number); return { t: Date.UTC(y, (m || 1) - 1, d || 1), monthOnly: !d }; }
  function upcoming(regIds, days = 400) {
    const now = today();
    const list = [];
    D.regs.forEach((r) => {
      if (regIds && !regIds.includes(r.id)) return;
      if (!regIds && D.profile.regulations && (!mine(r.id) || mine(r.id).level === 'background')) return;
      (r.dates || []).forEach((e) => {
        const d = parseDate(e.date);
        const end = d.monthOnly ? Date.UTC(new Date(d.t).getUTCFullYear(), new Date(d.t).getUTCMonth() + 1, 0) : d.t;
        if (end >= now && d.t <= now + days * DAY) list.push({ reg: r, t: d.t, when: d.monthOnly ? fmtMonth.format(d.t) : fmtDay.format(d.t), label: e.label, approx: !!e.approx });
      });
    });
    return list.sort((a, b) => a.t - b.t);
  }

  // ---------------------------------------------------------------- answers without a model
  const WANTS_DATES = /\b(when|deadline|due|date|dates|upcoming|next|soon|timeline|until|wann|frist|fristen|termin|termine|bis wann|nächste|anstehend)\b/i;
  const WANTS_RELEVANCE = /\b(apply to us|applies to us|affect us|relevant|concern us|which rules|betrifft|betreffen|relevant für|gelten für uns|welche regeln)\b/i;
  const WANTS_NEWS = /\b(changed|new|news|latest|this week|recent|update|updates|neu|neues|geändert|diese woche|aktuell)\b/i;

  function localAnswer(question, regIds) {
    const parts = [];
    if (WANTS_DATES.test(question)) {
      const list = upcoming(regIds.length ? regIds : null, regIds.length ? 900 : 200).slice(0, 7);
      if (list.length) {
        parts.push(`<p><strong>${regIds.length ? 'Coming up' : 'Coming up for the rules that concern you'}</strong></p><ul>${list.map((e) =>
          `<li>${esc(e.when)}${e.approx ? ' (expected)' : ''}: ${esc(e.reg.short)} ${esc(e.label)}</li>`).join('')}</ul>`);
      }
    }
    if (WANTS_RELEVANCE.test(question) && !regIds.length && D.profile.regulations) {
      const group = (level) => D.regs.filter((r) => (mine(r.id) || {}).level === level).map((r) => esc(r.short)).join(', ');
      parts.push(`<p><strong>Applies to you:</strong> ${group('direct')}</p><p><strong>Indirectly:</strong> ${group('indirect') || 'none'}</p><p><strong>Could apply soon:</strong> ${group('watch') || 'none'}</p>`);
    }
    if (WANTS_NEWS.test(question) && D.briefing && D.briefing.headline) {
      parts.push(`<p><strong>From the latest briefing:</strong> ${esc(D.briefing.headline)}. ${esc(D.briefing.summary || '')}</p>`);
    }
    regIds.slice(0, 2).forEach((id) => {
      const r = D.byId.get(id);
      const m = mine(id);
      parts.push(`<p><strong>${esc(r.short)}</strong>${m ? ` (${LEVELS[m.level] || m.level})` : ''}: ${esc(m ? m.why : r.summary)}</p><p>${esc(r.status)}</p>`);
    });
    // A question about all rules is answered by the lists above; loose passages would only distract.
    const chunks = parts.length && !regIds.length ? [] : bestChunks(question, regIds, parts.length ? 2 : 3);
    chunks.forEach((c) => parts.push(`<div class="terra-quote"><strong>${esc(nameOf(c.id))}, ${esc(c.title)}</strong><br>${esc(c.text.length > 420 ? `${c.text.slice(0, 420).replace(/\s+\S*$/, '')}…` : c.text)}</div>`));
    const used = [...new Set([...regIds, ...chunks.map((c) => c.id)])];
    if (!parts.length) {
      return { html: '<p>I could not find this in the tracker’s content. Try naming the rule, for example “CBAM deadline” or “batteries due diligence”.</p>', regs: [] };
    }
    return { html: parts.join(''), regs: used };
  }

  // ---------------------------------------------------------------- answers with Gemini
  function overview() {
    return D.regs.map((r) => {
      const next = upcoming([r.id], 3000)[0];
      const m = mine(r.id);
      return `${r.short} [${r.jurisdiction || 'EU'}] stage: ${STAGES[r.stage]}${r.flag ? `, ${r.flag}` : ''}; for the reader: ${m ? LEVELS[m.level] : 'not rated'}; next date: ${next ? `${next.when} ${next.label}${next.approx ? ' (expected)' : ''}` : 'none'}`;
    }).join('\n');
  }

  function material(regIds) {
    return regIds.map((id) => {
      const r = D.byId.get(id);
      const page = D.learn.get(id) || {};
      const m = mine(id);
      const lines = [`### ${r.short}: ${r.name} (${r.reference})`, `Stage: ${STAGES[r.stage]}${r.flag ? `, ${r.flag}` : ''}. Status: ${r.status}`, `What it does: ${r.summary}`, `Who is covered: ${r.scope}`,
        `Key dates: ${(r.dates || []).map((d) => `${d.date}${d.approx ? ' (expected)' : ''} ${d.label}`).join('; ')}`];
      if (m) lines.push(`For the reader (${LEVELS[m.level]}): ${m.why} ${(m.points || []).join(' ')}`, (m.ask || []).length ? `Ask suppliers for: ${m.ask.join('; ')}` : '');
      if (page.essentials) lines.push(`Short version: ${page.essentials.map(plain).join(' ')}`);
      (page.sections || []).forEach((sec) => lines.push(`${sec.title}: ${sectionText(sec)}`));
      if (page.terms) lines.push(`Terms: ${page.terms.map((t) => `${t.term} = ${plain(t.text)}`).join(' | ')}`);
      if (page.numbers) lines.push(`Numbers: ${page.numbers.map((n) => `${n.value}: ${plain(n.label)}`).join(' | ')}`);
      if (page.mistakes) lines.push(`Common mistakes: ${page.mistakes.map((x) => `NOT "${plain(x.wrong)}" BUT "${plain(x.right)}"`).join(' | ')}`);
      if (page.practice) lines.push(`In practice: ${page.practice.map(plain).join(' ')}`);
      return lines.filter(Boolean).join('\n');
    }).join('\n\n');
  }

  const SYSTEM = () => `You are Terra, the assistant of the EU ESG Tracker website. You answer questions about the EU, German and Chinese sustainability and product rules that the tracker covers.

Rules
- Use only the MATERIAL in the user's message. It is the tracker's own, curated content. Do not add dates, thresholds, article numbers or developments from memory.
- If the material does not answer the question, say so plainly and name the regulation page that comes closest. Never guess.
- The reader: ${D.profile.summary || 'a sustainability professional'} "You" and "we" in a question mean this reader's company.
- Answer in the language of the question.
- Be brief: the direct answer first, then at most five short bullet points starting with "- ". Plain text; **bold** only for the key term or date. No headings, no tables.
- Refer to regulations by their short names. Say when something is only proposed, expected or reported.
- You give orientation, not legal advice. Do not repeat that in every answer.
- If the question is not about these rules, say in one sentence what you can help with.`;

  const chat = { history: [], busy: false };

  async function listModels(key) {
    const cached = store.get('terraModels');
    if (cached && Date.now() - cached.at < 12 * 3600000 && cached.models.length) return cached.models;
    const res = await fetch(`${API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw Object.assign(new Error('key'), { kind: 'key' });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const found = [];
    ((await res.json()).models || []).forEach((entry) => {
      if (!(entry.supportedGenerationMethods || []).includes('generateContent')) return;
      const m = /^models\/(gemini-(\d+(?:\.\d+)?)-flash(-lite)?)$/.exec(entry.name || '');
      if (m) found.push({ name: m[1], version: Number(m[2]), light: !!m[3] });
    });
    // The light models come first: they have the largest free allowance, and the full models'
    // small allowance is left for the tracker's daily review. The answers are grounded in the
    // material that is sent along, which the light models handle well.
    found.sort((a, b) => (b.light - a.light) || (b.version - a.version));
    const models = [...found.filter((m) => m.light).slice(0, 2), ...found.filter((m) => !m.light).slice(0, 3)].map((m) => m.name);
    if (!models.length) models.push('gemini-2.5-flash-lite');
    store.set('terraModels', { at: Date.now(), models });
    return models;
  }

  async function askGemini(key, question, regIds) {
    const models = await listModels(key);
    const news = D.briefing && D.briefing.headline
      ? `Latest briefing (${(D.briefing.generated_at || '').slice(0, 10)}): ${D.briefing.headline}. ${D.briefing.summary || ''} ${(D.briefing.items || []).map((i) => `${i.title}: ${i.what} ${i.meaning}`).join(' ')}` : '';
    const soon = upcoming(null, 200).slice(0, 12).map((e) => `${e.when}${e.approx ? ' (expected)' : ''}: ${e.reg.short} ${e.label}`).join('\n');
    const prompt = `MATERIAL (today is ${fmtDay.format(today())})\n\nAll tracked rules:\n${overview()}\n\nNext dates for the rules that concern the reader:\n${soon}\n\n${news}\n\n${material(regIds)}\n\nQUESTION: ${question}`;
    const contents = [...chat.history.slice(-6).map((m) => ({ role: m.role, parts: [{ text: m.text }] })), { role: 'user', parts: [{ text: prompt }] }];
    const body = JSON.stringify({ system_instruction: { parts: [{ text: SYSTEM() }] }, contents, generationConfig: { temperature: 0.3, maxOutputTokens: 900 } });
    let last = null;
    for (const model of models) {
      const res = await fetch(`${API}/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body });
      if (res.ok) {
        const data = await res.json();
        const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
        const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
        if (text) return { text, model };
        last = new Error('empty answer');
        continue;
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        const detail = await res.text().catch(() => '');
        if (/api key|API_KEY|permission/i.test(detail)) throw Object.assign(new Error('key'), { kind: 'key' });
      }
      last = Object.assign(new Error(`HTTP ${res.status}`), { kind: res.status === 429 ? 'quota' : 'busy' });
      if (res.status === 404) store.remove('terraModels'); // the list is out of date
    }
    throw last || new Error('no model');
  }

  // ---------------------------------------------------------------- the chat panel
  const isOpen = () => !$panel.hidden;
  const getKey = () => store.get('terraKey', '');

  function addMessage(kind, html) {
    const el = document.createElement('div');
    el.className = `terra-msg is-${kind}`;
    el.innerHTML = html;
    $log.appendChild(el);
    $log.scrollTop = $log.scrollHeight;
    return el;
  }

  function fromLine(regIds) {
    const pills = regIds.filter((id) => D.byId.has(id) || id === 'foundations').slice(0, 4)
      .map((id) => `<a class="pill" data-pillar="${esc(((D.byId.get(id) || {}).pillars || ['E'])[0])}" href="#/learn/${esc(id)}">${esc(nameOf(id))}</a>`).join('');
    return pills ? `<div class="terra-from"><span>Read more:</span>${pills}</div>` : '';
  }

  function suggestions() {
    const id = currentRegId();
    const r = id && D.byId.get(id);
    const list = r
      ? [`What does ${r.short} mean for us?`, `What should I ask suppliers for under ${r.short}?`, `Which ${r.short} dates are next?`]
      : ['What is due in the next months?', 'Which rules apply to us directly?', D.briefing ? 'What changed this week?' : 'What do we need from battery suppliers?'];
    $chips.innerHTML = list.map((q) => `<button type="button" data-ask="${esc(q)}">${esc(q)}</button>`).join('');
  }

  function footer() {
    $foot.innerHTML = getKey()
      ? 'Answers are written by Google Gemini from this site’s content. Check the linked pages; not legal advice.'
      : 'Showing matching passages from this site. <button type="button" data-terra="setup">Turn on written AI answers</button>';
  }

  function typeOut(el, html, done) {
    if (reduceMotion()) { el.innerHTML = html; done(); return; }
    // Reveal the finished HTML block by block while Terra "talks".
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const blocks = [...holder.children];
    el.innerHTML = '';
    let i = 0;
    const step = () => {
      if (i >= blocks.length) { done(); return; }
      el.appendChild(blocks[i]);
      i += 1;
      $log.scrollTop = $log.scrollHeight;
      setTimeout(step, 260);
    };
    step();
  }

  async function ask(question) {
    const q = question.trim();
    if (!q || chat.busy) return;
    chat.busy = true;
    $chips.innerHTML = '';
    addMessage('user', esc(q));
    $input.value = '';
    $input.style.height = '';
    const pending = addMessage('bot', '<p>…</p>');
    mood('think');
    let result;
    try {
      await loadData();
      const regIds = matchRegs(q);
      const key = getKey();
      if (key) {
        try {
          const answer = await askGemini(key, q, regIds);
          chat.history.push({ role: 'user', text: q }, { role: 'model', text: answer.text });
          result = { html: formatText(answer.text) + fromLine(regIds), ok: true };
        } catch (err) {
          const local = localAnswer(q, regIds);
          const why = err.kind === 'key' ? 'Google did not accept the API key. Check it in the settings.'
            : err.kind === 'quota' ? 'The free allowance of the API key is used up for now.'
              : err.kind === 'busy' ? 'Google’s models are overloaded at the moment.'
                : 'Google could not be reached from this network. In mainland China that needs a VPN.';
          result = { html: local.html + fromLine(local.regs), note: `${why} Here is what the site itself says.`, ok: false };
        }
      } else {
        const local = localAnswer(q, regIds);
        result = { html: local.html + fromLine(local.regs), ok: true };
      }
    } catch (err) {
      result = { html: '<p>I could not load the tracker’s data. Reload the page and try again.</p>', ok: false, failed: true };
    }
    if (result.note) addMessage('note', esc(result.note));
    $log.appendChild(pending); // keep the answer below the note
    mood(result.failed ? 'sad' : 'talk');
    typeOut(pending, result.html, () => {
      mood(result.failed ? 'sad' : result.ok ? 'grin' : 'calm', 1600);
      chat.busy = false;
    });
  }

  function showSetup(open) {
    $setup.hidden = !open;
    $chat.hidden = open;
    if (!open) { footer(); $input.focus(); return; }
    const key = getKey();
    $setup.innerHTML = `
      <p><strong>Written AI answers</strong></p>
      <p>Without a key I show you the matching dates and passages from this site. With a Google Gemini API key I can write a short answer from that content, in the language you ask in.</p>
      <ol>
        <li>Create a key in <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.</li>
        <li>Paste it here. It is stored in this browser only and sent to Google only.</li>
      </ol>
      <label for="terra-key">Gemini API key</label>
      <input id="terra-key" type="password" autocomplete="off" spellcheck="false" value="${esc(key)}" placeholder="AIza…">
      <div class="terra-row">
        <button class="terra-btn" type="button" data-terra="save-key">Save</button>
        ${key ? '<button class="terra-btn is-quiet" type="button" data-terra="remove-key">Remove key</button>' : ''}
        <button class="terra-btn is-quiet" type="button" data-terra="back">Back</button>
      </div>
      <p class="terra-small">Good to know: your question and the matching site content are sent to Google. On the free tier Google may use them to improve its products, so do not enter confidential information. The key uses the same allowance as the tracker’s daily review if both belong to one Google project; I use the light models first to leave room for it. From mainland China, Google is only reachable through a VPN; without it you get the passages.</p>`;
    $setup.querySelector('#terra-key').focus();
  }

  /** Put the panel on the side of Terra with more room and keep it inside the window. */
  function layoutPanel() {
    $panel.style.left = $panel.style.right = $panel.style.maxHeight = '';
    if (!isOpen() || window.matchMedia('(max-width: 680px)').matches) return;
    const box = $pet.getBoundingClientRect();
    const above = box.top - 20;
    const below = window.innerHeight - box.bottom - 20;
    const low = below > above;
    root.classList.toggle('is-low', low);
    $panel.style.maxHeight = `${Math.max(220, Math.min(544, low ? below : above))}px`;
    const width = $panel.offsetWidth;
    const home = root.getBoundingClientRect();
    const wanted = Math.max(12, Math.min(window.innerWidth - width - 12, home.right - width));
    $panel.style.right = 'auto';
    $panel.style.left = `${wanted - home.left}px`;
  }

  function open() {
    if (isOpen()) return;
    $panel.hidden = false;
    layoutPanel();
    $pet.setAttribute('aria-expanded', 'true');
    $say.hidden = true;
    pet.offset = 0; $pet.style.transform = '';
    mood('smile', 1200);
    store.set('terraMet', true);
    showSetup(false);
    if (!$log.children.length) {
      addMessage('bot', '<p>Hi, I’m Terra. Ask me about any rule on this site: what it requires, whether it applies to you, or which dates are coming up.</p>');
    }
    loadData().then(suggestions).catch(() => {});
    $input.focus();
  }
  function close() {
    if (!isOpen()) return;
    $panel.hidden = true;
    $pet.setAttribute('aria-expanded', 'false');
    $pet.focus({ preventScroll: true });
    mood('wink', 900);
  }
  function toggle() { if (isOpen()) close(); else open(); }

  root.addEventListener('click', (e) => {
    const asked = e.target.closest('[data-ask]');
    if (asked) { ask(asked.dataset.ask); return; }
    const action = (e.target.closest('[data-terra]') || {}).dataset;
    if (!action) return;
    if (action.terra === 'close') close();
    if (action.terra === 'setup') showSetup($setup.hidden);
    if (action.terra === 'back') showSetup(false);
    if (action.terra === 'save-key') {
      const value = $setup.querySelector('#terra-key').value.trim();
      if (value) { store.set('terraKey', value); store.remove('terraModels'); addMessage('note', 'Key saved in this browser. I will now write answers with Gemini.'); mood('love', 1800); }
      showSetup(false);
    }
    if (action.terra === 'remove-key') { store.remove('terraKey'); store.remove('terraModels'); addMessage('note', 'Key removed from this browser.'); showSetup(false); }
  });
  $form.addEventListener('submit', (e) => { e.preventDefault(); ask($input.value); });
  $input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($input.value); } });
  $input.addEventListener('input', () => { $input.style.height = 'auto'; $input.style.height = `${Math.min(112, $input.scrollHeight + 4)}px`; });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); close(); } });
  window.addEventListener('hashchange', () => { if (isOpen() && D.regs.length && !chat.busy && $log.children.length <= 1) suggestions(); });

  // ---------------------------------------------------------------- reactions to the page
  // A passed test gets a cheer. app.js is not involved: Terra just watches for the result card.
  const view = document.getElementById('view');
  if (view) {
    new MutationObserver(() => {
      const card = view.querySelector('.quiz-result');
      if (!card || card.dataset.terraSeen) return;
      card.dataset.terraSeen = '1';
      if (card.classList.contains('is-passed')) { mood('love', 3200); hop(); if (!isOpen()) say('Passed. Well done!'); }
      else { mood('calm', 2200); if (!isOpen()) say('Close. The missed ones come back under Repeat.', 5000); }
    }).observe(view, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------- start
  restoreSpot();
  mood('idle');
  if (!store.get('terraMet')) {
    setTimeout(() => { if (!isOpen()) { mood('wave', 2600); say('Hi, I’m Terra. Click me to ask about the rules.', 7000); } }, 1800);
  }
})();
