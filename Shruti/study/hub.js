// The Study tab: a sidebar like MAGI Studio's (each set, each kind with its
// icon, accent and status) and the chosen tool beside it. Sets come from two
// places:
//   - ready-made: books/<book>/study/chNN.json, written with the book (Claude
//     wrote the Gita's), listed in books/<book>/study.json;
//   - made with AI: <doc>.sets.<book>.<id>, for any scope (a chapter, a
//     section, a selection from Read, several chapters, the whole book),
//     in the shared doc for shared books and the person's own for personal
//     ones (media.js docFor). A set shows on every chapter it covers.
// What each person did with a set (known cards, scores, the slide they were
// on) is theirs: study.<book>.<set>.<kind> in their doc (ui.js).

import * as C from '../core.js';
import * as O from '../orca.js';
import * as M from '../media.js';
import * as G from '../generate.js';
import * as P from './parse.js';
import * as FC from './flashcards.js';
import * as QZ from './quiz.js';
import * as MM from './mindmap.js';
import * as SD from './slides.js';
import { h, esc, IC, progress, OR } from './ui.js';

export const KIND_NAME = { flashcards: 'Flashcards', quiz: 'Quiz', mindmap: 'Mind map', slides: 'Slides' };
const TOOL = { flashcards: FC, quiz: QZ, mindmap: MM, slides: SD };
const nn = (n) => String(n).padStart(2, '0');

/* ── ready-made sets ─────────────────────────────────────────────────────── */
const cache = new Map();
const getJSON = (url) => {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return cache.get(url);
};
/** The book's study index: {"4": {flashcards: 16, quiz: 8, mindmap: 5, slides: 9}, ...} or {}. */
export const shippedIndex = (book) => !C.isShipped(book) ? Promise.resolve({}) : getJSON('books/' + book + '/study.json').then((x) => x || {});
export async function shippedSet(book, n) {
  const idx = await shippedIndex(book);
  if (!idx[String(n)]) return null;
  const raw = await getJSON('books/' + book + '/study/ch' + nn(n) + '.json');
  if (!raw) return null;
  const kinds = {};
  for (const k of P.KINDS) { const it = P.items(k, raw[k]); if (P.count(k, it)) kinds[k] = it; }
  return { id: 'ch' + n, shipped: true, label: n ? 'Chapter ' + n : 'The introduction', scope: { t: 'chapter', ch: [n] }, kinds };
}

/* ── AI-made sets ────────────────────────────────────────────────────────── */
const doc = (book) => M.docFor(book);
export const aiSets = (book) => Object.values(doc(book).get('sets.' + book, {}) || {}).filter((s) => s && s.id && s.kinds);
export const covers = (s, n) => s.scope && (s.scope.t === 'book' || (s.scope.ch || []).includes(n));
export const setsFor = (book, n) => aiSets(book).filter((s) => covers(s, n)).sort((a, b) => (b.at || 0) - (a.at || 0));
export function saveSet(book, rec) {
  const d = doc(book);
  d.set({ ['sets.' + book + '.' + rec.id]: rec }, { now: true });
}
export const removeSet = (book, id) => doc(book).set({ ['sets.' + book + '.' + id]: C.DELETE }, { now: true });
/** Whether a chapter has anything to study (the library's Study badge). */
export const hasStudy = (book, n, idx) => !!(idx && idx[String(n)]) || setsFor(book, n).length > 0;

/* ── status per kind (the sidebar's tag) ─────────────────────────────────── */
export function status(book, set, kind, it) {
  const p = progress(book, set, kind);
  if (kind === 'flashcards') {
    const s = FC.summary(it, p);
    if (s.due) return { t: s.due + ' due', c: 'due' };
    if (s.known === it.length) return { t: 'All known', c: 'good' };
    if (s.known || s.learning) return { t: s.known + ' of ' + it.length + ' known', c: '' };
    return { t: it.length + ' cards', c: 'new' };
  }
  if (kind === 'quiz') {
    const b = QZ.best(p.scores);
    if (b) return { t: 'Best ' + b.s + '/' + b.n, c: b.s === b.n ? 'good' : '' };
    const a = Object.keys(p.picked || {}).length;
    return a ? { t: a + ' of ' + it.length + ' answered', c: '' } : { t: it.length + ' questions', c: 'new' };
  }
  if (kind === 'slides') return p.i ? { t: 'Slide ' + (p.i + 1) + ' of ' + it.length, c: '' } : { t: it.length + ' slides', c: 'new' };
  return { t: it.branches.length + ' branches', c: 'new' };
}

/** A set's kinds in this person's order. */
export const kindsOf = (book, s) => OR.arrange(P.KINDS.filter((k) => s.kinds[k]), (k) => k, OR.get('kinds.' + book + '.' + s.id));

/* ── the tab ─────────────────────────────────────────────────────────────── */
let live = null;   // {dispose, root, ctx}
const pick = (ctx) => C.ls.json(C.lsKey('study.' + ctx.book + '.' + ctx.n), null);
const remember = (ctx, v) => C.ls.put(C.lsKey('study.' + ctx.book + '.' + ctx.n), v);
addEventListener('hashchange', () => setTimeout(() => { if (live && !live.root.isConnected) { live.dispose(); live = null; } }, 0));

/** ctx: {book, bookTitle, n, title, ch, lessons, chapters:[{n,title,file}], loadChapter(file)}. Resolves false when there is nothing. */
export async function renderStudy(body, ctx) {
  const ready = await shippedSet(ctx.book, ctx.n);
  const draw = () => {
    if (live) { live.dispose(); live = null; }
    // Sets, and the kinds inside each, in this person's order (order.sets.<book>, order.kinds.<book>.<set>).
    const sets = OR.arrange([...(ready ? [ready] : []), ...setsFor(ctx.book, ctx.n)], (s) => s.id, OR.get('sets.' + ctx.book));
    if (!sets.length) {
      body.innerHTML = '<div class="empty">' + IC.flashcards + '<b>Nothing to study here yet</b><span>Make flashcards, a quiz, a mind map or slides from this chapter, a section of it or what you select in Read.</span>' +
        '<button class="btn solid" data-make>' + IC.spark + 'Make a study set</button></div>';
      body.querySelector('[data-make]').addEventListener('click', () => openMaker(ctx, draw));
      return;
    }
    let sel = pick(ctx);
    if (!sel || !sets.some((s) => s.id === sel.set && s.kinds[sel.kind])) {
      const s0 = sets[0];
      sel = { set: s0.id, kind: kindsOf(ctx.book, s0)[0] };
    }
    const cur = sets.find((s) => s.id === sel.set);
    body.innerHTML = '<div class="sh"><aside class="sh-side" aria-label="Study sets"></aside><section class="sh-main"><div class="sh-head"></div><div class="sh-tool"></div></section></div>';
    const side = body.querySelector('.sh-side');
    side.innerHTML = sets.map((s) => {
      const meta = s.shipped ? 'Comes with Shruti' : [G.modelName(s.model), s.by && C.PROFILES[s.by] ? C.PROFILES[s.by].label : '', s.at ? new Date(s.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''].filter(Boolean).join(' · ');
      return '<div class="sh-set' + (s.id === sel.set ? ' on' : '') + '" data-dkey="' + esc(s.id) + '" title="' + esc(OR.HINT) + '"><div class="sh-set-h"><span><b>' + esc(s.shipped ? s.label : s.scope.label ? s.scope.label[0].toUpperCase() + s.scope.label.slice(1) : 'Study set') + '</b><span>' + esc(meta) + '</span></span>' +
        (s.shipped ? '' : '<button class="ib sm" data-del="' + esc(s.id) + '" title="Delete this set" aria-label="Delete this set">' + IC.trash + '</button>') + '</div>' +
        kindsOf(ctx.book, s).map((k) => { const stt = status(ctx.book, s.id, k, s.kinds[k]); return '<button class="sh-kind k-' + k + (s.id === sel.set && k === sel.kind ? ' on' : '') + '" data-set="' + esc(s.id) + '" data-kind="' + k + '" data-dkey="' + k + '"><i>' + IC[k] + '</i><span>' + KIND_NAME[k] + '</span><em class="' + stt.c + '">' + esc(stt.t) + '</em></button>'; }).join('') + '</div>';
    }).join('') + '<button class="btn sh-make" data-make>' + IC.spark + 'Make a study set</button>';
    side.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { remember(ctx, { set: b.dataset.set, kind: b.dataset.kind }); draw(); if (matchMedia('(max-width: 760px)').matches) body.querySelector('.sh-main').scrollIntoView({ block: 'start', behavior: 'smooth' }); }));
    side.querySelector('[data-make]').addEventListener('click', () => openMaker(ctx, draw));
    // Drag sets (sideways on a phone, where they scroll that way) and the kinds in a set.
    OR.sortable(side, { row: '.sh-set', axis: matchMedia('(max-width: 760px)').matches ? 'x' : 'y', onMove(ks) {
      const all = OR.get('sets.' + ctx.book);
      OR.put('sets.' + ctx.book, ks.concat(all.filter((k) => !ks.includes(k))));
      draw();
    } });
    side.querySelectorAll('.sh-set').forEach((el) => OR.sortable(el, { row: '.sh-kind', onMove(ks) { OR.put('kinds.' + ctx.book + '.' + el.dataset.dkey, ks); draw(); } }));
    side.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!await window.uiConfirm('Delete this study set? Its progress goes with it.', { title: 'Delete study set', okLabel: 'Delete' })) return;
      removeSet(ctx.book, b.dataset.del);
      draw();
    }));
    body.querySelector('.sh-head').innerHTML = '<span class="sh-ic k-' + sel.kind + '">' + IC[sel.kind] + '</span><div><b>' + KIND_NAME[sel.kind] + '</b><span>' + esc(cur.shipped ? (ctx.n ? 'Chapter ' + ctx.n + ' · ' : '') + ctx.title : cur.scope.label) + '</span></div>';
    // A tool saved progress: its tag in the sidebar follows at once.
    const retag = (e) => {
      if (!side.isConnected) { removeEventListener('shruti:study', retag); return; }
      const { set, kind } = e.detail, s = sets.find((x) => x.id === set), row = side.querySelector('.sh-kind[data-set="' + set + '"][data-kind="' + kind + '"] em');
      if (!s || !row) return;
      const stt = status(ctx.book, set, kind, s.kinds[kind]);
      row.textContent = stt.t; row.className = stt.c;
    };
    addEventListener('shruti:study', retag);
    const root = body.querySelector('.sh-tool');
    const dispose = TOOL[sel.kind].mount(root, cur.kinds[sel.kind], { book: ctx.book, set: cur.id, title: ctx.title });
    live = { dispose, root, ctx };
  };
  draw();
  // Another device made or deleted a set, or progress moved: refresh the sidebar only when idle.
  const off = C.on('doc:' + (doc(ctx.book) === C.me ? 'me' : 'shared'), (e) => {
    if (!body.isConnected) { off(); return; }
    if (!e.remote) return;
    const ids = setsFor(ctx.book, ctx.n).map((s) => s.id).join();
    if (ids !== draw.ids) { draw.ids = ids; if (!document.querySelector('#study-make')) (window.A1Drag ? A1Drag.later(draw) : draw()); }
  });
  draw.ids = setsFor(ctx.book, ctx.n).map((s) => s.id).join();
  if (pending && pending.book === ctx.book && pending.n === ctx.n) { pending = null; openMaker(ctx, draw); }
  return true;
}

/* ── "Make a study set": the scope picker ───────────────────────────────── */
// What was last selected in Read, per chapter (cleared on reload).
let lastSel = null, pending = null;
document.addEventListener('selectionchange', () => {
  const s = getSelection();
  if (!s || s.isCollapsed) return;
  const a = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
  const rd = a && a.closest && a.closest('article.rd');
  const text = String(s).replace(/\s+/g, ' ').trim();
  if (rd && text.split(' ').length >= 8) {
    const m = /#\/b\/([^/]+)\/(\d+)/.exec(location.hash);
    if (m) lastSel = { book: m[1], n: Number(m[2]), text, at: Date.now() };
  }
});
export const selection = (book, n) => (lastSel && lastSel.book === book && lastSel.n === n ? lastSel : null);
/** Open the maker for a chapter from elsewhere (Make with AI → Study set). */
export function makeFor(book, n) { pending = { book, n }; }
addEventListener('shruti:make-study', (e) => {
  const { book, n } = e.detail;
  makeFor(book, n);
  const want = '#/b/' + book + '/' + n + '/study';
  // Already there: draw the tab again, which opens the maker.
  if (location.hash === want) dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = want;
});

/** The text a scope covers, as the model reads it (headings, [verse] numbers). */
export function sectionsOf(ch) {
  const out = [];
  (ch.blocks || []).forEach((b, i) => { if (b.k === 'h') out.push({ i, title: b.t }); });
  return out;
}
export function sectionText(ch, i) {
  const blocks = ch.blocks || [], end = blocks.findIndex((b, j) => j > i && b.k === 'h');
  return G.sourceText({ blocks: blocks.slice(i, end < 0 ? blocks.length : end) });
}
export function verseSpan(ch, from, to) {
  const vs = [];
  (ch.blocks || []).slice(from, to).forEach((b) => (b.s || []).forEach((s) => { if (s.v) vs.push(s.v); }));
  return vs.length ? (vs.length === 1 ? 'verse ' + vs[0] : 'verses ' + vs[0] + '–' + vs[vs.length - 1].split('.').pop()) : '';
}

function openMaker(ctx, redraw) {
  if (document.getElementById('study-make')) return;
  const p = G.prefs();
  const sel = selection(ctx.book, ctx.n), secs = sectionsOf(ctx.ch);
  const st = { scope: 'chapter', sec: secs.length ? secs[0].i : null, chs: new Set([ctx.n]), kinds: new Set(p.studyKinds || P.KINDS), running: false, abort: null };
  const dim = h('div', 'sheet-dim');
  dim.id = 'study-make';
  dim.innerHTML = '<aside class="sheet gen" role="dialog" aria-modal="true" aria-labelledby="sm-h"><div class="sh-h"><h2 id="sm-h">Make a study set</h2><button class="ib" data-close aria-label="Close">' + IC.x + '</button></div>' +
    '<p class="gen-sub">' + esc((ctx.n ? 'Chapter ' + ctx.n + ' · ' : '') + ctx.title) + '</p><section class="card" id="sm-scope"></section><section class="card" id="sm-what"></section><section class="card" id="sm-run"></section></aside>';
  document.body.appendChild(dim);
  const close = () => { if (st.running && st.abort) st.abort.abort(); dim.remove(); removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', onKey);
  dim.addEventListener('click', (e) => { if (e.target === dim || e.target.closest('[data-close]')) close(); });

  const scopes = [
    { id: 'chapter', label: ctx.n ? 'This chapter' : 'The introduction' },
    ...(secs.length ? [{ id: 'section', label: 'A section' }] : []),
    { id: 'selection', label: 'Your selection', off: !sel },
    { id: 'chapters', label: 'Several chapters' },
    { id: 'book', label: 'The whole book' },
  ];
  const drawScope = () => {
    const box = dim.querySelector('#sm-scope');
    box.innerHTML = '<h3>From</h3><div class="chips" role="radiogroup">' + scopes.map((s) => '<button class="chip' + (st.scope === s.id ? ' on' : '') + '" role="radio" aria-checked="' + (st.scope === s.id) + '" data-scope="' + s.id + '"' + (s.off ? ' disabled title="Select some text in Read first"' : '') + '>' + esc(s.label) + '</button>').join('') + '</div>' +
      (st.scope === 'section' ? '<label class="gen-f"><span>Section</span><select id="sm-sec">' + secs.map((s) => '<option value="' + s.i + '"' + (s.i === st.sec ? ' selected' : '') + '>' + esc(s.title) + '</option>').join('') + '</select></label>' : '') +
      (st.scope === 'selection' && sel ? '<blockquote class="sm-sel">' + esc(sel.text.length > 320 ? sel.text.slice(0, 320) + '…' : sel.text) + '</blockquote><p class="hint">' + sel.text.split(' ').length + ' words selected in Read.</p>' : '') +
      (st.scope === 'selection' && !sel ? '<p class="hint">Select a passage in the Read tab, then come back here.</p>' : '') +
      (st.scope === 'chapters' ? '<div class="chips sm-chs">' + ctx.chapters.map((c) => '<button class="chip' + (st.chs.has(c.n) ? ' on' : '') + '" data-ch="' + c.n + '" title="' + esc(c.title) + '">' + (c.n || 'Intro') + '</button>').join('') + '</div>' : '') +
      (st.scope === 'book' ? '<p class="hint">All ' + ctx.chapters.length + ' parts of ' + esc(ctx.bookTitle) + ': a long ask, best with the larger units.</p>' : '');
    box.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => { st.scope = b.dataset.scope; drawScope(); }));
    const s2 = box.querySelector('#sm-sec'); if (s2) s2.addEventListener('change', () => { st.sec = Number(s2.value); });
    box.querySelectorAll('[data-ch]').forEach((b) => b.addEventListener('click', () => { const n = Number(b.dataset.ch); st.chs.has(n) && st.chs.size > 1 ? st.chs.delete(n) : st.chs.add(n); drawScope(); }));
  };
  const drawWhat = () => {
    const box = dim.querySelector('#sm-what'), q = G.prefs();
    const rows = O.unitRows(C.me.get('units', {}) || {}, null).filter((r) => r.on);
    box.innerHTML = '<h3>What</h3><div class="chips">' + P.KINDS.map((k) => '<button class="chip k-' + k + (st.kinds.has(k) ? ' on' : '') + '" role="checkbox" aria-checked="' + st.kinds.has(k) + '" data-k="' + k + '">' + IC[k] + KIND_NAME[k] + '</button>').join('') + '</div>' +
      '<div class="gen-f"><span>Length</span><div class="chips">' + Object.entries(G.LENGTHS).map(([k, v]) => '<button class="chip' + (q.length === k ? ' on' : '') + '" data-len="' + k + '">' + v.label + '</button>').join('') + '</div></div>' +
      '<p class="hint">Units, in your order: ' + esc(rows.map((r) => r.name).join(' → ') || 'none ticked') + ' (Settings).</p>' +
      '<label class="gen-f"><span>Anything else? (optional)</span><textarea id="sm-extra" rows="2" maxlength="600" placeholder="e.g. focus on the Sanskrit terms; harder questions">' + esc(q.extra) + '</textarea></label>';
    box.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.k; st.kinds.has(k) && st.kinds.size > 1 ? st.kinds.delete(k) : st.kinds.add(k); G.setPref('studyKinds', P.KINDS.filter((x) => st.kinds.has(x))); drawWhat(); }));
    box.querySelectorAll('[data-len]').forEach((b) => b.addEventListener('click', () => { G.setPref('length', b.dataset.len); drawWhat(); }));
    const ex = box.querySelector('#sm-extra'); ex.addEventListener('change', () => G.setPref('extra', ex.value.trim()));
  };
  const drawRun = (R) => {
    const box = dim.querySelector('#sm-run');
    if (!R) {
      box.innerHTML = '<div class="gen-go"><button class="btn solid" data-go>' + IC.spark + 'Make it</button><span class="hint">One unit call per kind, about a minute each.</span></div>';
      box.querySelector('[data-go]').addEventListener('click', start);
      return;
    }
    box.innerHTML = '<h3>' + (R.error ? 'It stopped' : R.done ? 'Made' : 'Making') + (R.model ? '<span class="gen-model">' + esc(G.modelName(R.model)) + '</span>' : '') + '</h3>' +
      '<ol class="gen-steps">' + R.kinds.map((k, i) => '<li class="' + (R.counts[k] != null ? 'done' : R.error && i === R.i ? 'bad' : i === R.i && !R.done ? 'cur' : '') + '">' + KIND_NAME[k] + (R.counts[k] != null ? ' <span>' + R.counts[k] + '</span>' : '') + '</li>').join('') + '</ol>' +
      (R.stream ? '<details class="gen-live"' + (R.done || R.error ? '' : ' open') + '><summary>What ' + esc(G.modelName(R.model) || 'the unit') + ' wrote</summary><pre>' + esc(R.stream.slice(-5000)) + '</pre></details>' : '') +
      (R.error ? '<div class="stat bad"><i></i><span>' + esc(R.error) + '</span></div>' : '') +
      '<div class="gen-go">' + (R.done ? '<button class="btn solid" data-open>Study it</button>' : R.error ? '<button class="btn" data-again>Try again</button>' : '<button class="btn" data-cancel>Cancel</button>') + '</div>';
    const pre = box.querySelector('.gen-live pre'); if (pre) pre.scrollTop = pre.scrollHeight;
    const c = box.querySelector('[data-cancel]'); if (c) c.addEventListener('click', () => st.abort && st.abort.abort());
    const a = box.querySelector('[data-again]'); if (a) a.addEventListener('click', () => drawRun(null));
    const o = box.querySelector('[data-open]'); if (o) o.addEventListener('click', () => { close(); redraw(); });
  };
  async function scopeOf() {
    if (st.scope === 'section') {
      const s = secs.find((x) => x.i === st.sec) || secs[0], end = (ctx.ch.blocks || []).findIndex((b, j) => j > s.i && b.k === 'h');
      const vs = verseSpan(ctx.ch, s.i, end < 0 ? undefined : end);
      return { t: 'section', ch: [ctx.n], label: '“' + s.title + '”' + (vs ? ' (' + vs + ')' : '') + ' in chapter ' + ctx.n, text: sectionText(ctx.ch, s.i), lessons: null };
    }
    if (st.scope === 'selection') return { t: 'selection', ch: [ctx.n], label: 'a passage selected in chapter ' + ctx.n, text: sel.text, lessons: null };
    if (st.scope === 'chapter') return { t: 'chapter', ch: [ctx.n], label: ctx.n ? 'chapter ' + ctx.n + ' (“' + ctx.title + '”)' : 'the introduction', text: G.sourceText(ctx.ch), lessons: ctx.lessons };
    const list = st.scope === 'book' ? ctx.chapters : ctx.chapters.filter((c) => st.chs.has(c.n));
    const chs = await Promise.all(list.map((c) => ctx.loadChapter(c.file)));
    const text = list.map((c, i) => '# ' + (c.n ? 'Chapter ' + c.n + ': ' : '') + c.title + '\n\n' + G.sourceText(chs[i])).join('\n\n');
    const nums = list.map((c) => c.n);
    return { t: st.scope, ch: nums, label: st.scope === 'book' ? 'the whole book' : 'chapters ' + nums.filter(Boolean).join(', ') + (nums.includes(0) ? ' and the introduction' : ''), text, lessons: null };
  }
  async function start() {
    if (!C.me.get('orcaKey', '')) { const go = await window.uiConfirm('Making uses Orca with your own key. Paste it once in Settings.', { title: 'Your Orca key is needed', okLabel: 'Open Settings' }); if (go) { close(); window.Shruti && window.Shruti.openSettings(); } return; }
    if (st.scope === 'selection' && !sel) return;
    const q = G.prefs(), kinds = P.KINDS.filter((k) => st.kinds.has(k));
    const R = { kinds, counts: {}, i: 0, stream: '', model: null };
    st.running = true; st.abort = new AbortController();
    drawRun(R);
    let t = 0;
    const paint = (force) => { if (force || Date.now() - t > 150) { t = Date.now(); drawRun(R); } };
    try {
      const sc = await scopeOf();
      const res = await G.runStudy({ kinds, book: ctx.book, bookTitle: ctx.bookTitle, scope: sc, text: sc.text, lessons: sc.lessons, length: q.length, extra: q.extra, models: O.chain(C.me.get('units', {}) || {}, null) }, {
        kind: (k, i) => { R.i = i; paint(true); },
        delta: (d) => { R.stream += d; paint(); },
        model: (m) => { R.model = m; paint(true); },
        done: (k, c) => { R.counts[k] = c; paint(true); },
      }, { signal: st.abort.signal, parse: P });
      const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      saveSet(ctx.book, { id, kinds: res.kinds, model: res.model, by: C.P, at: Date.now(), length: q.length, scope: { t: sc.t, ch: sc.ch, label: sc.label }, ...(q.extra ? { asked: q.extra.slice(0, 300) } : {}) });
      remember(ctx, { set: id, kind: kinds[0] });
      R.done = true;
      window.Shruti && window.Shruti.toast('Study set saved');
    } catch (e) {
      R.error = e && e.code === 'abort' ? 'Cancelled.' : (e && e.message) || String(e);
    }
    st.running = false;
    drawRun(R);
  }
  drawScope(); drawWhat(); drawRun(null);
}
