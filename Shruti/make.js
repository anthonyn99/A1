// Make with AI, the sheets (rebuilt 2026-10-22, Tony: "far more elegant", and
// "only the stuff relevant to the tab I'm on"):
//   open(ctx, tab)  the chapter's maker for that tab: Read -> a narration,
//                   Listen -> a podcast, Watch -> a video, Study -> a study
//                   set, Lessons -> lessons. Its versions, its few choices,
//                   "More options" for the rest, and Make.
//   openJobs()      what is being made on this device (the header's pill).
//   openBuild(book) Build everything: every chapter, every kind, in the
//                   background, with one progress bar.
// Making runs in jobs.js, so a sheet can be closed and the work goes on.

import * as C from './core.js';
import * as O from './orca.js';
import * as M from './media.js';
import * as G from './generate.js';
import * as J from './jobs.js';
import * as NR from './narrate.js';
import * as POD from './podcast.js';
import * as VID from './video.js';
import * as OR from './order.js';
import * as T from './text.js';

let ui = { toast: () => {}, go: () => {}, openSettings: () => {} };
export function setUI(x) { ui = Object.assign(ui, x); }
const keyOf = () => String(C.me.get('orcaKey', '') || '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const I = (b, fill) => '<svg viewBox="0 0 24 24" ' + (fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"') + ' aria-hidden="true">' + b + '</svg>';
const IC = {
  spark: G.ICON,
  x: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  play: I('<path d="M8 5.5v13l10.5-6.5z"/>', true),
  trash: I('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  check: I('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  read: I('<path d="M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2z"/><path d="M22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z"/>'),
  podcast: I('<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z"/><path d="M3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z"/>'),
  video: I('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 9l5 3-5 3z"/>'),
  study: I('<rect x="3" y="5" width="13" height="15" rx="2"/><path d="M8 2h11a2 2 0 0 1 2 2v13"/>'),
  lessons: I('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>'),
  layers: I('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  chev: I('<path d="M9 6l6 6-6 6"/>'),
};
const KIND_OF_TAB = { read: 'read', listen: 'podcast', watch: 'video', study: 'study', lessons: 'lessons' };
const HEAD = {
  read: ['Make a narration', 'The chapter read aloud in one voice, kept for every device.'],
  podcast: ['Make a podcast', 'Two hosts tell the story and teach every lesson.'],
  video: ['Make a video', 'Narrated, with artwork, the verses and every lesson.'],
  lessons: ['Draw the lessons', 'Every lesson the chapter teaches.'],
  study: ['Make a study set', 'Flashcards, a quiz, a mind map and slides.'],
};
const STAGES = { lessons: 'Find every lesson', write: 'Write', check: 'Check', repair: 'Repair', speak: 'Speak', upload: 'Save', done: 'Done' };
const ACCENT = { 'en-US': 'American', 'en-GB': 'British', 'en-AU': 'Australian', 'en-IN': 'Indian', 'en-IE': 'Irish', 'en-CA': 'Canadian' };
const vName = (id) => NR.voiceName(id);
const vInfo = (id) => O.VOICES.find((v) => v.id === id) || { id, name: vName(id), locale: '', gender: '' };
const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const who = (p) => (C.PROFILES[p] ? C.PROFILES[p].label : p || '');

/* ── small pieces ────────────────────────────────────────────────────────── */
function sheet(id, cls, label) {
  const dim = document.createElement('div');
  dim.className = 'sheet-dim'; dim.id = id;
  dim.innerHTML = '<aside class="sheet mk ' + (cls || '') + '" role="dialog" aria-modal="true" aria-labelledby="' + id + '-h"></aside>';
  document.body.appendChild(dim);
  const aside = dim.firstChild;
  const offs = [];
  const close = () => { dim.remove(); removeEventListener('keydown', onKey); offs.forEach((f) => f()); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.sheet-dim:not(#' + id + ') ~ .sheet-dim, #settings')) close(); };
  addEventListener('keydown', onKey);
  dim.addEventListener('click', (e) => { if (e.target === dim || e.target.closest('[data-close]')) close(); });
  return { dim, aside, close, offs, label };
}
const head = (id, icon, title, sub) => '<header class="mk-head"><span class="mk-ic">' + icon + '</span><div class="mk-ht"><h2 id="' + id + '-h">' + esc(title) + '</h2>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div><button class="ib" data-close aria-label="Close">' + IC.x + '</button></header>';
/** A segmented control: [[value, label, hint?]]. */
const seg = (name, opts, value, label) => '<div class="seg mk-seg" role="radiogroup" aria-label="' + esc(label || name) + '">' + opts.map(([v, t]) => '<button role="radio" data-' + name + '="' + esc(v) + '" aria-checked="' + (String(v) === String(value)) + '">' + esc(t) + '</button>').join('') + '</div>';
const unitChips = (rows) => '<div class="chips gen-units">' + rows.map((r) => '<button class="chip' + (r.on ? ' on' : '') + (r.status !== 'ready' && r.status !== 'unknown' ? ' off' : '') + '" data-unit="' + esc(r.id) + '" role="checkbox" aria-checked="' + r.on + '" title="' + esc(O.STATUS[r.status] ? r.name + ': ' + O.STATUS[r.status] : r.name) + '" aria-label="' + esc(r.name + (O.STATUS[r.status] ? ', ' + O.STATUS[r.status] : '')) + '">' + (r.on ? IC.check : '') + esc(r.name) + '</button>').join('') + '</div>';
function bindUnits(box, redraw) {
  const rows = O.unitRows(C.me.get('units', {}) || {}, O.cachedModels(keyOf()));
  box.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => {
    const cur = C.me.get('units', {}) || {}, on = Object.assign({}, cur.on || {}), r = rows.find((x) => x.id === b.dataset.unit);
    on[r.id] = !r.on; C.me.set({ 'units.on': on }); redraw();
  }));
}
/** A voice row: pick it, or hear it. */
const voiceRow = (v, on, name) => '<div class="mk-voice' + (on ? ' on' : '') + '" role="radio" tabindex="0" aria-checked="' + on + '" data-' + name + '="' + esc(v.id) + '"><span class="dot"></span><span class="mk-vn"><b>' + esc(v.name) + '</b><span>' + esc([ACCENT[v.locale] || v.locale, v.gender].filter(Boolean).join(' · ')) + '</span></span><button class="ib sm" data-try="' + esc(v.id) + '" aria-label="Hear ' + esc(v.name) + '" title="Hear ' + esc(v.name) + '">' + IC.play + '</button></div>';
function bindVoices(box, name, pick) {
  box.querySelectorAll('[data-' + name + ']').forEach((row) => {
    const go = () => pick(row.getAttribute('data-' + name));
    row.addEventListener('click', (e) => { if (!e.target.closest('[data-try]')) go(); });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  box.querySelectorAll('[data-try]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); NR.preview(b.dataset.try, b); }));
}

/* ── the chapter's maker ─────────────────────────────────────────────────── */
/** ctx: {book, bookTitle, n, title, ch, lessons, shipped:{podcast, video, read, lessons}, chapters, loadChapter}. */
export function open(ctx, tab) {
  if (document.getElementById('gen-sheet')) return;
  const kind = ctx.n === 0 && tab !== 'study' ? 'read' : (KIND_OF_TAB[tab] || 'podcast');
  const [title, lead] = HEAD[kind];
  const S = sheet('gen-sheet', 'gen k-' + kind);
  S.aside.innerHTML = head('gen-sheet', IC[kind], title, (ctx.n ? 'Chapter ' + ctx.n + ' · ' : '') + ctx.title) +
    '<p class="mk-lead">' + esc(lead) + '</p><section class="mk-sec" id="gen-vers"></section><section class="mk-sec" id="gen-opts"></section><section class="mk-run" id="gen-run"></section>';
  const st = { kind, ctx, study: { scope: 'chapter', sec: null, chs: new Set([ctx.n]) } };
  const draw = () => { drawVersions(S, st); drawOptions(S, st); drawRun(S, st); };
  draw();
  // A task moving, another device's job, a version saved elsewhere: repaint
  // the parts that show them (not the options while one is being changed).
  const repaint = () => {
    if (!S.dim.isConnected) return;
    if (window.A1Drag && A1Drag.active) { A1Drag.later(repaint); return; }
    drawVersions(S, st); drawRun(S, st);
  };
  S.offs.push(J.on(repaint), C.on('doc:shared', repaint), C.on('doc:me', repaint));
  if (keyOf() && !O.cachedModels(keyOf())) O.models(keyOf()).then(() => { if (S.dim.isConnected) { drawOptions(S, st); drawRun(S, st); } });
}

function drawVersions(S, st) {
  const box = S.aside.querySelector('#gen-vers'), { ctx, kind } = st;
  if (kind === 'study') { box.hidden = true; return; }
  const list = M.versions(ctx.book, ctx.n, kind), cur = M.featured(ctx.book, ctx.n, kind);
  const shipped = ctx.shipped && ctx.shipped[kind];
  const orderKey = 'ver.' + ctx.book + '.ch' + ctx.n + '.' + kind;
  const job = M.jobOf(ctx.book, ctx.n, kind), mine = J.latest(ctx.book, ctx.n, kind);
  const other = job && !(mine && mine.state === 'running');
  if (!shipped && !list.length && !other) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const row = (id, t, meta, canDelete) => '<div class="gv' + ((cur || null) === id ? ' on' : '') + '" data-dkey="' + esc(id || 'orig') + '" title="' + esc(OR.HINT) + '"><div class="gv-pick" tabindex="0" data-feature="' + esc(id || '') + '" role="radio" aria-checked="' + ((cur || null) === id) + '"><span class="dot"></span><span><b>' + esc(t) + '</b><span>' + esc(meta) + '</span></span></div>' +
    (canDelete ? '<button class="ib sm" data-del="' + esc(id) + '" title="Delete this version" aria-label="Delete this version">' + IC.trash + '</button>' : '') + '</div>';
  const desc = (r) => [r.voices && r.voices.filter(Boolean).map(vName).join(' & '), r.duration && T.fmtTime(r.duration), r.lessons && r.lessons.length + ' lessons', r.model && G.modelName(r.model), who(r.by), when(r.at)].filter(Boolean).join(' · ');
  const name = (r) => (kind === 'lessons' ? 'Lessons' : kind === 'read' ? vName(r.voice) : J.KIND_NAME[kind]) + (r.length && kind !== 'read' ? ' · ' + (G.LENGTHS[r.length] || {}).label : '');
  box.innerHTML = '<div class="mk-label">Versions<span>' + (C.shared === M.docFor(ctx.book) ? 'The ticked one plays for both of you' : 'The ticked one plays') + '</span></div>' +
    (other ? '<div class="stat busy gen-other"><i></i><span>' + esc(who(job.by) + ' is making this' + (job.text ? ': ' + job.text.toLowerCase() : '') + '…') + '</span></div>' : '') +
    '<div class="gvs">' + OR.arrange([...(shipped ? [{ k: 'orig', html: row(null, kind === 'lessons' ? 'Your own notes' : 'Comes with Shruti', shipped, false) }] : []),
      ...list.map((r) => ({ k: r.id, html: row(r.id, name(r), desc(r), true) }))], (x) => x.k, OR.get(orderKey)).map((x) => x.html).join('') + '</div>';
  OR.sortable(box.querySelector('.gvs'), { row: '.gv', onMove: (ks) => { OR.put(orderKey, ks); drawVersions(S, st); } });
  box.querySelectorAll('[data-feature]').forEach((b) => b.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.altKey) { e.preventDefault(); b.click(); } }));
  box.querySelectorAll('[data-feature]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.feature || null;
    if (id === (cur || null)) return;
    if (kind === 'podcast' && POD.active(ctx.book, ctx.n)) POD.stop();
    if (kind === 'video' && VID.active(ctx.book, ctx.n)) VID.stop();
    M.feature(ctx.book, ctx.n, kind, id);
    ui.toast(id ? 'This version plays now' : 'The original plays now');
    drawVersions(S, st);
  }));
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!await window.uiConfirm('Delete this version? Its files on Drive are deleted too.', { title: 'Delete version', okLabel: 'Delete' })) return;
    if (kind === 'podcast' && POD.active(ctx.book, ctx.n)) POD.stop();
    if (kind === 'video' && VID.active(ctx.book, ctx.n)) VID.stop();
    await M.remove(ctx.book, ctx.n, kind, b.dataset.del);
    drawVersions(S, st);
  }));
}

function voiceSelect(id, value, label) {
  return '<label class="mk-f"><span>' + esc(label) + '</span><select id="' + id + '">' + O.VOICES.map((v) => '<option value="' + esc(v.id) + '"' + (v.id === value ? ' selected' : '') + '>' + esc(v.name + ' · ' + (ACCENT[v.locale] || v.locale) + ' ' + v.gender) + '</option>').join('') + '</select></label>';
}
const LEN_HINT = {
  podcast: { concise: 'about 7 min', standard: 'about 10 min', deep: 'about 13 min' },
  video: { concise: 'about 5 min', standard: 'about 8 min', deep: 'up to 10 min' },
  lessons: { concise: 'a sentence each', standard: 'two or three sentences', deep: 'a short paragraph' },
  study: { concise: 'a few of each', standard: 'a good set', deep: 'many of each' },
};
function drawOptions(S, st) {
  const box = S.aside.querySelector('#gen-opts'), { ctx, kind } = st, p = G.prefs();
  const redraw = () => drawOptions(S, st);
  const rows = O.unitRows(C.me.get('units', {}) || {}, O.cachedModels(keyOf()));
  const more = (inner) => '<details class="mk-more"' + (st.moreOpen ? ' open' : '') + '><summary>' + IC.chev + 'More options</summary><div class="mk-more-in">' + inner + '</div></details>';
  const units = '<div class="mk-f"><span>Units, in your order</span>' + unitChips(rows) + '<button class="lk" data-units>Order them in Settings</button></div>';
  const extra = '<label class="mk-f"><span>Anything else?</span><textarea id="gen-extra" rows="2" maxlength="600" placeholder="e.g. more about the history; keep it light; explain Sanskrit words">' + esc(p.extra) + '</textarea></label>';
  const length = (k) => '<div class="mk-f"><span>' + (k === 'lessons' ? 'Detail' : 'Length') + '<em>' + esc(LEN_HINT[k][p.length] || '') + '</em></span>' + seg('len', Object.entries(G.LENGTHS).map(([v, o]) => [v, o.label]), p.length, 'Length') + '</div>';
  let html = '';
  if (kind === 'podcast') {
    const hosts = G.hostsOf(p), custom = !!(p.hostA || p.hostB);
    html = '<div class="mk-label">Voices</div><div class="mk-pairs" role="radiogroup" aria-label="Hosts">' + G.HOST_PRESETS.map((h, i) => {
      const on = !custom && p.hosts === i;
      return '<button class="mk-pair' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on + '" data-preset="' + i + '"><span class="mk-avs"><i>' + esc(h.hosts[0][0].slice(0, 1)) + '</i><i>' + esc(h.hosts[1][0].slice(0, 1)) + '</i></span><b>' + esc(h.name) + '</b><span>' + esc((ACCENT[vInfo(h.hosts[0][1]).locale] || '')) + '</span></button>';
    }).join('') + '</div>' +
      '<details class="mk-more mk-any"' + (custom ? ' open' : '') + '><summary>' + IC.chev + 'Any two voices</summary><div class="mk-more-in mk-2">' + voiceSelect('gen-a', hosts[0].voice, 'Host A') + voiceSelect('gen-b', hosts[1].voice, 'Host B') + '</div></details>' +
      length('podcast') + more(units + extra);
  } else if (kind === 'video') {
    html = '<div class="mk-label">Narrator</div><div class="mk-voices" role="radiogroup" aria-label="Narrator">' + O.VOICES.map((v) => voiceRow(v, v.id === p.narrator, 'nar')).join('') + '</div>' +
      '<input type="hidden" id="gen-nar" value="' + esc(p.narrator) + '">' + length('video') + more(units + extra);
  } else if (kind === 'lessons') {
    html = length('lessons') + more(units + extra);
  } else if (kind === 'read') {
    html = '<div class="mk-label">Voice</div><div class="mk-voices" role="radiogroup" aria-label="Voice">' + O.VOICES.map((v) => voiceRow(v, v.id === p.voice, 'voice')).join('') + '</div>' +
      '<input type="hidden" id="gen-voice" value="' + esc(p.voice) + '">';
  } else if (kind === 'study') html = studyOptions(st, p) + length('study') + more(units + extra);
  box.innerHTML = html;
  const details = box.querySelector('.mk-more:not(.mk-any)');
  if (details) details.addEventListener('toggle', () => { st.moreOpen = details.open; });
  bindUnits(box, redraw);
  const u = box.querySelector('[data-units]'); if (u) u.addEventListener('click', () => { S.close(); ui.openSettings(); });
  box.querySelectorAll('[data-len]').forEach((b) => b.addEventListener('click', () => { G.setPref('length', b.dataset.len); redraw(); }));
  box.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { C.me.set({ 'gen.hosts': Number(b.dataset.preset), 'gen.hostA': null, 'gen.hostB': null }); redraw(); }));
  const bindSel = (id, k) => { const el = box.querySelector('#' + id); if (el) el.addEventListener('change', () => { G.setPref(k, el.value); if (k === 'hostA' || k === 'hostB') redraw(); }); };
  bindSel('gen-a', 'hostA'); bindSel('gen-b', 'hostB');
  bindVoices(box, 'nar', (v) => { G.setPref('narrator', v); redraw(); });
  bindVoices(box, 'voice', (v) => { G.setPref('voice', v); redraw(); drawRun(S, st); });
  const ex = box.querySelector('#gen-extra'); if (ex) ex.addEventListener('change', () => G.setPref('extra', ex.value.trim()));
  if (kind === 'study') bindStudy(box, st, redraw);
  // The ticked voice stays in view in a long list.
  const on = box.querySelector('.mk-voice.on'); if (on && !st.scrolled) { st.scrolled = true; requestAnimationFrame(() => { const l = on.parentElement; l.scrollTop += on.getBoundingClientRect().top - l.getBoundingClientRect().top - 8; }); }
}

/* the study set's scope (formerly study/hub.js openMaker) */
function studyOptions(st, p) {
  const { ctx } = st, s = st.study;
  if (!st.H) return '<p class="hint">Loading…</p>';
  const H = st.H, sel = H.selection(ctx.book, ctx.n), secs = H.sectionsOf(ctx.ch);
  if (s.sec == null && secs.length) s.sec = secs[0].i;
  const kinds = new Set(p.studyKinds || ['flashcards', 'quiz', 'mindmap', 'slides']);
  const scopes = [['chapter', ctx.n ? 'This chapter' : 'The introduction'], ...(secs.length ? [['section', 'A section']] : []), ['selection', 'Your selection'], ['chapters', 'Several chapters'], ['book', 'The whole book']];
  const KN = { flashcards: 'Flashcards', quiz: 'Quiz', mindmap: 'Mind map', slides: 'Slides' };
  return '<div class="mk-label">From</div><div class="chips mk-scope" role="radiogroup">' + scopes.map(([v, t]) => '<button class="chip' + (s.scope === v ? ' on' : '') + '" role="radio" aria-checked="' + (s.scope === v) + '" data-scope="' + v + '"' + (v === 'selection' && !sel ? ' disabled title="Select some text in Read first"' : '') + '>' + esc(t) + '</button>').join('') + '</div>' +
    (s.scope === 'section' ? '<label class="mk-f"><span>Section</span><select id="sm-sec">' + secs.map((x) => '<option value="' + x.i + '"' + (x.i === s.sec ? ' selected' : '') + '>' + esc(x.title) + '</option>').join('') + '</select></label>' : '') +
    (s.scope === 'selection' && sel ? '<blockquote class="sm-sel">' + esc(sel.text.length > 320 ? sel.text.slice(0, 320) + '…' : sel.text) + '</blockquote>' : '') +
    (s.scope === 'chapters' ? '<div class="chips sm-chs">' + ctx.chapters.map((c) => '<button class="chip' + (s.chs.has(c.n) ? ' on' : '') + '" data-ch="' + c.n + '" title="' + esc(c.title) + '">' + (c.n || 'Intro') + '</button>').join('') + '</div>' : '') +
    '<div class="mk-label">What</div><div class="chips">' + Object.keys(KN).map((k) => '<button class="chip k-' + k + (kinds.has(k) ? ' on' : '') + '" role="checkbox" aria-checked="' + kinds.has(k) + '" data-k="' + k + '">' + esc(KN[k]) + '</button>').join('') + '</div>';
}
function bindStudy(box, st, redraw) {
  if (!st.H) { import('./study/hub.js').then((H) => { st.H = H; redraw(); }); return; }
  const s = st.study, p = G.prefs();
  box.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => { s.scope = b.dataset.scope; redraw(); }));
  const sec = box.querySelector('#sm-sec'); if (sec) sec.addEventListener('change', () => { s.sec = Number(sec.value); });
  box.querySelectorAll('[data-ch]').forEach((b) => b.addEventListener('click', () => { const n = Number(b.dataset.ch); s.chs.has(n) && s.chs.size > 1 ? s.chs.delete(n) : s.chs.add(n); redraw(); }));
  box.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => {
    const all = ['flashcards', 'quiz', 'mindmap', 'slides'], k = new Set(p.studyKinds || all);
    k.has(b.dataset.k) && k.size > 1 ? k.delete(b.dataset.k) : k.add(b.dataset.k);
    G.setPref('studyKinds', all.filter((x) => k.has(x))); redraw();
  }));
}

/** The run area: Make (with what stops it, said first), or the task's progress, or how it ended. */
function drawRun(S, st) {
  const box = S.aside.querySelector('#gen-run'), { ctx, kind } = st;
  const t = J.latest(ctx.book, ctx.n, kind);
  const remote = M.jobOf(ctx.book, ctx.n, kind);
  if (t && (t.state === 'running' || t.state === 'queued' || (t.shown !== false && Date.now() - (t.ended || 0) < 10 * 60e3 && t.state !== 'cancelled'))) { paintTask(S, st, box, t); return; }
  const pre = kind === 'read' ? (keyOf() ? null : O.preflight('')) : O.preflight(keyOf(), C.me.get('units', {}) || {}, O.cachedModels(keyOf()));
  const ahead = J.active().length;
  const p = G.prefs();
  const label = kind === 'read' ? 'Make it in ' + vName(p.voice) : kind === 'study' ? 'Make the set' : 'Make ' + J.KIND_NAME[kind].toLowerCase();
  box.innerHTML = G.problemHTML(pre) +
    '<div class="gen-go"><button class="btn solid mk-go" data-make' + (remote ? ' disabled' : '') + '>' + IC.spark + esc(ahead ? 'Add to the queue' : label) + '</button>' +
    '<span class="hint">' + esc(remote ? who(remote.by) + ' is making one now.' : ahead ? ahead + ' ahead of it. It carries on in the background.' : 'Carries on in the background: you can close this.') + '</span></div>';
  box.querySelector('[data-make]').addEventListener('click', () => start(S, st));
  G.bindProblem(box, S.close);
}
function paintTask(S, st, box, t) {
  const L = (st.ctx.lessons && st.ctx.lessons.lessons) || [];
  const stages = t.kind === 'read' ? ['speak', 'upload', 'done'] : t.kind === 'lessons' ? ['write', 'check', 'done'] : t.kind === 'study' ? ['write', 'done'] : ['write', 'check', 'speak', 'upload', 'done'];
  if (t.repaired && !stages.includes('repair')) stages.splice(stages.indexOf('check') + 1, 0, 'repair');
  if (t.lessonsFirst) stages.unshift('lessons');
  const stage = t.state === 'done' ? 'done' : t.stage === 'start' || t.stage === 'queued' ? stages[0] : t.stage;
  const idx = Math.max(0, stages.indexOf(stage));
  const bad = t.state === 'failed';
  const waiting = t.state === 'queued';
  box.innerHTML = '<div class="mk-prog' + (bad ? ' bad' : t.state === 'done' ? ' good' : '') + '">' +
    '<div class="mk-prog-h"><b>' + esc(waiting ? 'Waiting its turn' : bad ? 'It stopped' : t.state === 'done' ? 'Made' : 'Making ' + J.KIND_NAME[t.kind].toLowerCase()) + '</b>' + (t.model ? '<span class="gen-model">' + esc(G.modelName(t.model)) + '</span>' : '') + '</div>' +
    (waiting ? '' : '<ol class="gen-steps mk-steps">' + stages.map((s, i) => '<li class="' + (bad && i === idx ? 'bad' : i < idx || t.state === 'done' ? 'done' : i === idx ? 'cur' : '') + '"><span>' + esc(STAGES[s]) + '</span></li>').join('') + '</ol>') +
    (!waiting && t.state === 'running' && t.text ? '<p class="mk-now">' + esc(t.text) + '</p>' : '') +
    (t.total && t.state === 'running' ? '<div class="gen-bar"><i style="width:' + (100 * t.done / t.total).toFixed(1) + '%"></i></div>' : '') +
    (t.cov && L.length && (t.kind === 'podcast' || t.kind === 'video') ? '<div class="gen-cov">' + L.map((l) => '<span class="' + (t.cov.covered.includes(l.id) ? 'ok' : 'no') + '" title="' + esc(l.title || '') + '">' + esc(l.id) + '</span>').join('') + '<em>' + t.cov.covered.length + ' of ' + L.length + ' lessons</em></div>' : '') +
    (t.stream ? '<details class="gen-live"' + (st.liveOpen ? ' open' : '') + '><summary>What ' + esc(G.modelName(t.model) || 'the unit') + ' wrote</summary><pre>' + esc(t.stream.slice(-6000)) + '</pre></details>' : '') +
    (bad ? G.problemHTML(t.error) : '') +
    (t.state === 'done' ? '<div class="stat good"><i></i><span>' + esc(t.result && t.result.local ? 'Made. Drive is not connected, so it plays on this device until the page reloads.' : 'Saved. It plays now on every device.') + '</span></div>' : '') +
    '<div class="gen-go">' + (t.state === 'done' ? '<button class="btn solid" data-open>' + (t.kind === 'lessons' ? 'See the lessons' : t.kind === 'read' ? 'Read along' : t.kind === 'study' ? 'Study it' : 'Play it') + '</button><button class="btn" data-again>Make another</button>'
      : bad ? '<button class="btn" data-again>Try again</button>'
      : '<button class="btn" data-cancel>' + (waiting ? 'Remove' : 'Cancel') + '</button><span class="hint">You can close this: it carries on.</span>') + '</div></div>';
  const pre = box.querySelector('.gen-live pre'); if (pre) pre.scrollTop = pre.scrollHeight;
  const det = box.querySelector('.gen-live'); if (det) det.addEventListener('toggle', () => { st.liveOpen = det.open; });
  const c = box.querySelector('[data-cancel]'); if (c) c.addEventListener('click', () => J.cancel(t.id));
  const o = box.querySelector('[data-open]'); if (o) o.addEventListener('click', () => { t.shown = false; S.close(); J.openResult(t); });
  const a = box.querySelector('[data-again]'); if (a) a.addEventListener('click', () => { t.shown = false; drawRun(S, st); });
  G.bindProblem(box, S.close);
}
async function start(S, st) {
  const { ctx, kind } = st, box = S.aside.querySelector('#gen-run');
  // Nothing is sent when it cannot work: no key, a refused key, no unit allowed.
  const stop = kind === 'read' ? (keyOf() ? null : O.preflight('')) : await G.aiReady();
  if (stop) { const old = box.querySelector('.ai-prob'); if (old) old.remove(); box.insertAdjacentHTML('afterbegin', G.problemHTML(stop)); G.bindProblem(box, S.close); return; }
  if (kind === 'read' && !await M.driveReady(ctx.book)) { box.insertAdjacentHTML('afterbegin', G.problemHTML({ title: 'Google Drive is not connected', text: 'A narration is kept on Drive so it plays on every device. Connect Drive in Settings first.', action: 'settings' })); G.bindProblem(box, S.close); return; }
  const p = G.prefs(), opts = { length: p.length, extra: p.extra };
  if (kind === 'podcast') opts.hosts = G.hostsOf(p);
  if (kind === 'video') opts.narrator = { name: vName(p.narrator), voice: p.narrator };
  if (kind === 'read') opts.voice = p.voice;
  if (kind === 'study') {
    const s = st.study, H = st.H || await import('./study/hub.js');
    const sel = H.selection(ctx.book, ctx.n);
    if (s.scope === 'selection' && !sel) return;
    opts.kinds = (p.studyKinds || ['flashcards', 'quiz', 'mindmap', 'slides']).slice();
    opts.scope = { t: s.scope, ch: s.scope === 'chapters' ? [...s.chs].sort((a, b) => a - b) : [ctx.n], sec: s.sec, sel: s.scope === 'selection' ? sel.text : undefined };
  }
  J.add({ kind, book: ctx.book, n: ctx.n, title: ctx.title, opts });
  drawRun(S, st);
}

/* ── the Make with AI button: shows what is being made for this chapter ─── */
export function watchButton(btn, book, n) {
  const label = btn.innerHTML;
  let shown = false;   // the view is built off the page, then swapped in
  const paint = () => {
    if (!btn.isConnected) { if (shown) { off1(); off2(); } else requestAnimationFrame(paint); return; }
    shown = true;
    const mine = J.active().filter((t) => t.book === book && t.n === n);
    const remote = ['podcast', 'video', 'lessons', 'read'].map((k) => M.jobOf(book, n, k)).find(Boolean);
    const busy = mine.length || remote;
    btn.classList.toggle('busy', !!busy);
    if (busy) {
      const t = mine.find((x) => x.state === 'running') || mine[0];
      const pct = t && t.total ? Math.round(100 * t.done / t.total) : null;
      btn.innerHTML = '<span class="mk-spin" aria-hidden="true"></span><span>Making' + (t ? ' ' + J.KIND_NAME[t.kind].toLowerCase() : remote ? ' (' + who(remote.by) + ')' : '') + (pct != null ? ' · ' + pct + '%' : '…') + '</span>';
      btn.title = 'Still being made in the background. Tap to see.';
    } else { btn.innerHTML = label; btn.title = ''; }
  };
  const off1 = J.on(paint), off2 = C.on('doc:shared', paint);
  paint();
}

/* ── the header's pill and the panel of what is being made ───────────────── */
export function bindPill(el) {
  let doneAt = 0;
  const paint = () => {
    const act = J.active(), s = J.summary();
    if (!act.length) {
      if (!s.total || !doneAt) { el.hidden = !s.total || Date.now() - doneAt > 8000; }
      if (s.total && !doneAt) doneAt = Date.now();
      el.classList.add('done'); el.style.setProperty('--p', '1');
      el.querySelector('span').textContent = s.failed ? s.failed + ' stopped' : 'Done';
      el.classList.toggle('bad', !!s.failed);
      if (!s.failed) setTimeout(() => { if (!J.active().length) el.hidden = true; }, 8000);
      else el.hidden = false;
      return;
    }
    doneAt = 0;
    el.hidden = false; el.classList.remove('done', 'bad');
    el.style.setProperty('--p', s.frac.toFixed(3));
    el.querySelector('span').textContent = s.total > 1 ? s.finished + ' of ' + s.total : Math.round(s.frac * 100) + '%';
    el.title = 'Being made: ' + act.map((t) => J.KIND_NAME[t.kind] + (t.n != null ? ' · ch ' + t.n : '')).join(', ');
  };
  J.on(paint);
  el.addEventListener('click', openJobs);
  paint();
}
export function openJobs() {
  if (document.getElementById('jobs-sheet')) return;
  const S = sheet('jobs-sheet', 'jobs');
  const draw = () => {
    if (!S.dim.isConnected) return;
    const s = J.summary(), list = J.tasks.slice().sort((a, b) => (rank(a) - rank(b)) || (a.at - b.at));
    S.aside.innerHTML = head('jobs-sheet', IC.layers, 'Being made', s.total ? s.finished + ' of ' + s.total + ' finished' : 'Nothing right now') +
      (s.total ? '<div class="jb-bar"><i style="width:' + (100 * s.frac).toFixed(1) + '%"></i></div>' : '<p class="mk-lead">What you make with AI shows here while it is made, wherever you are in Shruti.</p>') +
      '<div class="jb-list">' + list.map((t) => '<div class="jb ' + t.state + '"><span class="jb-ic">' + (IC[t.kind] || IC.spark) + '</span><div class="jb-t"><b>' + esc(J.KIND_NAME[t.kind] + (t.n != null ? ' · Chapter ' + t.n : '')) + '</b><span>' + esc(t.state === 'failed' ? (t.error && (t.error.title + ': ' + t.error.text)) || 'It stopped' : t.state === 'running' ? (t.text || 'Working') + (t.model ? ' · ' + G.modelName(t.model) : '') : t.state === 'queued' ? 'Waiting' : t.state === 'done' ? (t.text || 'Made') : t.state === 'skipped' ? 'Already made' : 'Cancelled') + '</span>' +
        (t.state === 'running' && t.total ? '<i class="jb-mini"><i style="width:' + (100 * t.done / t.total).toFixed(1) + '%"></i></i>' : '') + '</div>' +
        (t.state === 'running' || t.state === 'queued' ? '<button class="ib sm" data-cx="' + t.id + '" aria-label="Cancel" title="Cancel">' + IC.x + '</button>' : t.state === 'done' ? '<button class="btn sm" data-go="' + t.id + '">Open</button>' : '') + '</div>').join('') + '</div>' +
      (s.total ? '<div class="jb-acts">' + (J.active().length ? '<button class="btn ghost danger sm" data-cxall>Cancel all</button>' : '') + (s.finished ? '<button class="btn ghost sm" data-clear>Clear finished</button>' : '') + '</div>' : '');
    S.aside.querySelectorAll('[data-cx]').forEach((b) => b.addEventListener('click', () => J.cancel(b.dataset.cx)));
    S.aside.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { S.close(); J.openResult(J.get(b.dataset.go)); }));
    const all = S.aside.querySelector('[data-cxall]'); if (all) all.addEventListener('click', () => J.active().forEach((t) => J.cancel(t.id)));
    const cl = S.aside.querySelector('[data-clear]'); if (cl) cl.addEventListener('click', () => J.clearDone());
  };
  const rank = (t) => ({ running: 0, queued: 1, failed: 2, done: 3, skipped: 4, cancelled: 5 }[t.state]);
  draw();
  S.offs.push(J.on(draw));
}

/* ── Build everything ────────────────────────────────────────────────────── */
// Tony, 2026-10-22: one button that pre-builds a book: the read-aloud in the
// voices chosen, a podcast, a video, lessons and study sets for every chapter,
// with a unit per kind or one for all, in the background with a progress bar.
const BUILD_KINDS = ['read', 'podcast', 'video', 'lessons', 'study'];
const MINUTES = { read: 3, podcast: 7, video: 6, lessons: 2, study: 5 };
/** Whether a chapter already has it (Build everything skips those by default). */
export function made(t, ctx) {
  const a = M.docFor(t.book).get('assets.' + t.book + '.ch' + t.n, {}) || {};
  if (t.kind === 'read') return (ctx.ready || []).some((r) => r.voice === t.opts.voice);
  if (t.kind === 'lessons') return !!(ctx.lessons && ctx.lessons.lessons && ctx.lessons.lessons.length);
  if (t.kind === 'study') return !!ctx.hasStudy;
  return !!a[t.kind] || !!(ctx.shipped && ctx.shipped[t.kind]);
}
export async function openBuild(book) {
  if (document.getElementById('build-sheet')) return;
  const L = await import('./library.js');
  const b = await L.loadBook(book);
  const chapters = [...(b.intro ? [{ n: 0, title: b.intro.title }] : []), ...b.chapters];
  const saved = C.me.get('build.' + book, null) || {};
  const p = G.prefs();
  const st = Object.assign({
    kinds: { read: true, podcast: true, video: true, lessons: false, study: true },
    voices: [p.voice], hosts: p.hosts || 0, narrator: p.narrator, length: p.length, studyKinds: ['flashcards', 'quiz', 'mindmap', 'slides'],
    unit: { all: '' }, chs: chapters.map((c) => c.n), skip: true,
  }, saved);
  st.chs = new Set(st.chs);
  const S = sheet('build-sheet', 'build');
  const keepPrefs = () => C.me.set({ ['build.' + book]: Object.assign({}, st, { chs: [...st.chs] }) });
  const rows = () => O.unitRows(C.me.get('units', {}) || {}, O.cachedModels(keyOf())).filter((r) => r.status !== 'scope' && r.status !== 'missing');
  const unitSel = (k) => '<select class="bd-unit" data-unit-of="' + k + '" aria-label="Unit for ' + esc(J.KIND_NAME[k]) + '"><option value="">' + (k === 'all' ? 'Your order (Settings)' : 'Same as all') + '</option>' + rows().map((r) => '<option value="' + esc(r.id) + '"' + (st.unit[k] === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('') + '</select>';
  const plan = () => {
    const out = [];
    const nonIntro = [...st.chs].filter((n) => n !== 0).sort((a, b2) => a - b2);
    const all = [...st.chs].sort((a, b2) => a - b2);
    const unitFor = (k) => st.unit[k] || st.unit.all || '';
    // Per chapter, lessons first: the podcast and video then teach them.
    for (const n of all) {
      const ch = chapters.find((c) => c.n === n);
      if (st.kinds.lessons && n) out.push({ kind: 'lessons', n, title: ch.title, opts: { length: st.length, onlyIfNone: st.skip } });
      if (st.kinds.read) st.voices.forEach((v) => out.push({ kind: 'read', n, title: ch.title, opts: { voice: v, onlyIfNone: st.skip } }));
      if (st.kinds.podcast && n) out.push({ kind: 'podcast', n, title: ch.title, opts: { length: st.length, hosts: G.hostsOf({ hosts: st.hosts }), onlyIfNone: st.skip } });
      if (st.kinds.video && n) out.push({ kind: 'video', n, title: ch.title, opts: { length: st.length, narrator: { name: vName(st.narrator), voice: st.narrator }, onlyIfNone: st.skip } });
      if (st.kinds.study) out.push({ kind: 'study', n, title: ch.title, opts: { length: st.length, kinds: st.studyKinds.slice(), scope: { t: 'chapter', ch: [n] }, onlyIfNone: st.skip } });
    }
    out.forEach((t) => { const u = unitFor(t.kind); if (u) t.opts.models = [u]; });
    return { list: out, chapters: nonIntro.length };
  };
  const draw = () => {
    const pl = plan(), mins = pl.list.reduce((s, t) => s + MINUTES[t.kind], 0);
    const KN = { flashcards: 'Flashcards', quiz: 'Quiz', mindmap: 'Mind map', slides: 'Slides' };
    const row = (k, inner) => '<div class="bd-row' + (st.kinds[k] ? ' on' : '') + '"><label class="bd-sw"><input type="checkbox" data-kind="' + k + '"' + (st.kinds[k] ? ' checked' : '') + '><span class="mk-ic sm">' + IC[k] + '</span><b>' + esc(J.KIND_NAME[k]) + '</b></label>' + (st.kinds[k] ? '<div class="bd-in">' + inner + (k !== 'read' ? '<label class="mk-f bd-u"><span>Unit</span>' + unitSel(k) + '</label>' : '') + '</div>' : '') + '</div>';
    S.aside.innerHTML = head('build-sheet', IC.layers, 'Build everything', b.title) +
      '<p class="mk-lead">Everything made ahead, in the background. Come back any time: the bar at the top shows how far it has come.</p>' +
      '<section class="mk-sec"><div class="mk-label">What to make</div>' +
        row('read', '<div class="mk-f"><span>Voices</span><div class="chips">' + O.VOICES.map((v) => '<button class="chip' + (st.voices.includes(v.id) ? ' on' : '') + '" data-v="' + esc(v.id) + '">' + esc(v.name) + '</button>').join('') + '</div></div>') +
        row('podcast', '<div class="mk-f"><span>Hosts</span><div class="chips">' + G.HOST_PRESETS.map((h, i) => '<button class="chip' + (st.hosts === i ? ' on' : '') + '" data-h="' + i + '">' + esc(h.name) + '</button>').join('') + '</div></div>') +
        row('video', voiceSelect('bd-nar', st.narrator, 'Narrator')) +
        row('lessons', '<p class="hint">Only where a chapter has none yet; your own notes are never replaced.</p>') +
        row('study', '<div class="mk-f"><span>Kinds</span><div class="chips">' + Object.keys(KN).map((k) => '<button class="chip' + (st.studyKinds.includes(k) ? ' on' : '') + '" data-sk="' + k + '">' + KN[k] + '</button>').join('') + '</div></div>') +
      '</section>' +
      '<section class="mk-sec"><div class="mk-label">How</div>' +
        '<label class="mk-f"><span>Units for everything</span>' + unitSel('all') + '</label>' +
        '<div class="mk-f"><span>Length</span>' + seg('len', Object.entries(G.LENGTHS).map(([v, o]) => [v, o.label]), st.length, 'Length') + '</div>' +
        '<label class="sw bd-skip"><input type="checkbox" id="bd-skip"' + (st.skip ? ' checked' : '') + '><span>Skip what is already made</span></label>' +
      '</section>' +
      '<section class="mk-sec"><div class="mk-label">Chapters<span><button class="lk" data-chall>' + (st.chs.size === chapters.length ? 'None' : 'All') + '</button></span></div><div class="chips sm-chs">' + chapters.map((c) => '<button class="chip' + (st.chs.has(c.n) ? ' on' : '') + '" data-ch="' + c.n + '" title="' + esc(c.title) + '">' + (c.n || 'Intro') + '</button>').join('') + '</div></section>' +
      '<section class="mk-run" id="bd-run">' + G.problemHTML(O.preflight(keyOf(), C.me.get('units', {}) || {}, O.cachedModels(keyOf()))) +
        '<div class="gen-go"><button class="btn solid mk-go" data-build' + (pl.list.length ? '' : ' disabled') + '>' + IC.spark + 'Build ' + pl.list.length + ' thing' + (pl.list.length === 1 ? '' : 's') + '</button><span class="hint">' + (pl.list.length ? 'About ' + (mins >= 90 ? Math.round(mins / 60) + ' hours' : mins + ' minutes') + (st.skip ? ', less for what is already made' : '') + '.' : 'Choose something to make.') + '</span></div></section>';
    S.aside.querySelectorAll('[data-kind]').forEach((x) => x.addEventListener('change', () => { st.kinds[x.dataset.kind] = x.checked; keepPrefs(); draw(); }));
    S.aside.querySelectorAll('[data-v]').forEach((x) => x.addEventListener('click', () => { const v = x.dataset.v; st.voices = st.voices.includes(v) ? (st.voices.length > 1 ? st.voices.filter((y) => y !== v) : st.voices) : st.voices.concat([v]); keepPrefs(); draw(); }));
    S.aside.querySelectorAll('[data-h]').forEach((x) => x.addEventListener('click', () => { st.hosts = Number(x.dataset.h); keepPrefs(); draw(); }));
    S.aside.querySelectorAll('[data-sk]').forEach((x) => x.addEventListener('click', () => { const k = x.dataset.sk; st.studyKinds = st.studyKinds.includes(k) ? (st.studyKinds.length > 1 ? st.studyKinds.filter((y) => y !== k) : st.studyKinds) : st.studyKinds.concat([k]); keepPrefs(); draw(); }));
    const nar = S.aside.querySelector('#bd-nar'); if (nar) nar.addEventListener('change', () => { st.narrator = nar.value; keepPrefs(); });
    S.aside.querySelectorAll('[data-unit-of]').forEach((x) => x.addEventListener('change', () => { st.unit[x.dataset.unitOf] = x.value; keepPrefs(); }));
    S.aside.querySelectorAll('[data-len]').forEach((x) => x.addEventListener('click', () => { st.length = x.dataset.len; keepPrefs(); draw(); }));
    S.aside.querySelector('#bd-skip').addEventListener('change', (e) => { st.skip = e.target.checked; keepPrefs(); draw(); });
    S.aside.querySelectorAll('[data-ch]').forEach((x) => x.addEventListener('click', () => { const n = Number(x.dataset.ch); st.chs.has(n) ? st.chs.delete(n) : st.chs.add(n); keepPrefs(); draw(); }));
    S.aside.querySelector('[data-chall]').addEventListener('click', () => { st.chs = st.chs.size === chapters.length ? new Set() : new Set(chapters.map((c) => c.n)); keepPrefs(); draw(); });
    G.bindProblem(S.aside, S.close);
    S.aside.querySelector('[data-build]').addEventListener('click', async () => {
      const stop = await G.aiReady();
      if (stop && (st.kinds.podcast || st.kinds.video || st.kinds.lessons || st.kinds.study)) { draw(); return; }
      const group = 'g' + Date.now().toString(36);
      const pl2 = plan();
      pl2.list.forEach((t) => J.add(Object.assign({ book, group }, t)));
      S.close();
      ui.toast('Building ' + pl2.list.length + ' things in the background');
      openJobs();
    });
  };
  draw();
  if (keyOf() && !O.cachedModels(keyOf())) O.models(keyOf()).then(() => { if (S.dim.isConnected) draw(); });
}
