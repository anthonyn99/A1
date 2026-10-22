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
      body.querySelector('[data-make]').addEventListener('click', () => openMaker(ctx));
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
    side.querySelector('[data-make]').addEventListener('click', () => openMaker(ctx));
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
    const ids = setsFor(ctx.book, ctx.n).map((s) => s.id).join();
    if (ids !== draw.ids) { draw.ids = ids; (window.A1Drag ? A1Drag.later(draw) : draw()); }
  });
  draw.ids = setsFor(ctx.book, ctx.n).map((s) => s.id).join();
  return true;
}

/* ── "Make a study set": the scope picker ───────────────────────────────── */
// What was last selected in Read, per chapter (cleared on reload).
let lastSel = null;
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
/** What a scope covers, as the model reads it. scope: {t: chapter|section|
 *  selection|chapters|book, ch:[n], sec (a heading's block), sel (the text)}.
 *  ctx: {n, title, ch, lessons, chapters, loadChapter}. Resolves {t, ch, label, text, lessons}.
 *  (A background task keeps only the scope and gets the text when it runs.) */
export async function scopeText(ctx, scope) {
  const t = (scope && scope.t) || 'chapter';
  if (t === 'section') {
    const secs = sectionsOf(ctx.ch), s = secs.find((x) => x.i === scope.sec) || secs[0];
    const end = (ctx.ch.blocks || []).findIndex((b, j) => j > s.i && b.k === 'h');
    const vs = verseSpan(ctx.ch, s.i, end < 0 ? undefined : end);
    return { t, ch: [ctx.n], label: '“' + s.title + '”' + (vs ? ' (' + vs + ')' : '') + ' in chapter ' + ctx.n, text: sectionText(ctx.ch, s.i), lessons: null };
  }
  if (t === 'selection') return { t, ch: [ctx.n], label: 'a passage selected in chapter ' + ctx.n, text: scope.sel, lessons: null };
  if (t === 'chapter') return { t, ch: [ctx.n], label: ctx.n ? 'chapter ' + ctx.n + ' (“' + ctx.title + '”)' : 'the introduction', text: G.sourceText(ctx.ch), lessons: ctx.lessons };
  const list = t === 'book' ? ctx.chapters : ctx.chapters.filter((c) => (scope.ch || []).includes(c.n));
  const chs = await Promise.all(list.map((c) => ctx.loadChapter(c.file)));
  const text = list.map((c, i) => '# ' + (c.n ? 'Chapter ' + c.n + ': ' : '') + c.title + '\n\n' + G.sourceText(chs[i])).join('\n\n');
  const nums = list.map((c) => c.n);
  return { t, ch: nums, label: t === 'book' ? 'the whole book' : 'chapters ' + nums.filter(Boolean).join(', ') + (nums.includes(0) ? ' and the introduction' : ''), text, lessons: null };
}

/** "Make a study set": make.js's sheet for the Study tab (it runs in the
 *  background, jobs.js; the new set shows here when it is saved). */
function openMaker(ctx) {
  import('../make.js').then((MK) => MK.open(ctx, 'study'));
}
