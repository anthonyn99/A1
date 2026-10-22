// Library -> book -> chapter. Shipped books live in the repo (books/<id>/
// book.json and one file per chapter), so the Gita works with no network
// beyond the page; imported books (Phase 8) live in Firestore (books.js), on
// the Shared shelf or the person's own (Mine). Progress is per person
// (dashboards/shruti[_veda] -> progress.<book>.ch<n>), even on shared books.

import { me, ls, lsKey, on as onDoc, SHIPPED as SHIPPED_IDS, isShipped, P as PROFILE, PROFILES } from './core.js';
import { renderRead } from './reader.js';
import * as POD from './podcast.js';
import * as VID from './video.js';
import * as M from './media.js';
import * as G from './generate.js';
import * as MK from './make.js';
import * as NR from './narrate.js';
import * as T from './text.js';
import * as PDF from './pdf.js';
import * as H from './study/hub.js';
import * as B from './books.js';
import * as OR from './order.js';
// Import (and its extractor) loads the first time someone imports or renames a
// book: most visits never need its ~1,000 lines.
const IMP = () => import('./import.js').catch(() => {
  if (window.Shruti) window.Shruti.toast('Import could not be loaded. Check the connection and try again.', true);
  return { open() {}, rename() {} };
});

export const SHIPPED = SHIPPED_IDS;
const COVERS = { gita: { bg: '#2b2235', tx: '#f2ead8', ac: '#e0b874', kicker: 'Shared' } };
// Imported books get one of these, chosen by their id, so a cover never changes.
const PALETTE = [
  { bg: '#23303a', tx: '#e8eef2', ac: '#8fc1d4' }, { bg: '#2f2a22', tx: '#f1e9dc', ac: '#d9a960' },
  { bg: '#26302a', tx: '#e7efe8', ac: '#93c49f' }, { bg: '#332630', tx: '#f2e6ee', ac: '#d49bbd' },
  { bg: '#2a2b38', tx: '#e9e9f4', ac: '#a9a6e6' }, { bg: '#352a26', tx: '#f3e8e2', ac: '#e09a7e' },
];

/* ── icons (Lucide-style lines) ───────────────────────────────────────────── */
const I = (b) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + b + '</svg>';
export const IC = {
  read: I('<path d="M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2z"/><path d="M22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z"/>'),
  listen: I('<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z"/><path d="M3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z"/>'),
  watch: I('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 9l5 3-5 3z"/>'),
  study: I('<rect x="3" y="5" width="13" height="15" rx="2"/><path d="M8 2h11a2 2 0 0 1 2 2v13"/>'),
  lessons: I('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>'),
  library: I('<path d="M4 4v16"/><path d="M9 4v16"/><path d="M14 5l4 15"/><path d="M3 20h18"/>'),
  play: I('<path d="M7 4l13 8-13 8z" fill="currentColor"/>'),
  next: I('<path d="M9 6l6 6-6 6"/>'),
  prev: I('<path d="M15 6l-6 6 6 6"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  pdf: I('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 12v6"/><path d="M9 15l3 3 3-3"/>'),
  check: I('<path d="M20 6 9 17l-5-5"/>'),
  ribbon: I('<path d="M6 3h12v18l-6-4-6 4z"/>'),
  undo: I('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>'),
  key: I('<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="M16 7l3 3"/><path d="M18.5 4.5l2 2"/>'),
  upload: I('<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  pen: I('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  trash: I('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  book: '<svg viewBox="14 14 68 68" fill="none" stroke="currentColor" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M48 40c-6-4-14-6-24-6v38c10 0 18 2 24 6 6-4 14-6 24-6V34c-10 0-18 2-24 6Z"/><path d="M48 40v38"/><path d="M41 28a10 10 0 0 1 14 0"/><path d="M35 21a19 19 0 0 1 26 0"/></svg>',
};
const NRname = (id) => String(id || '').replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace(/(Multilingual)?Neural$/, '');
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const MODES = [
  { id: 'read', label: 'Read' }, { id: 'listen', label: 'Listen' }, { id: 'watch', label: 'Watch' },
  { id: 'study', label: 'Study' }, { id: 'lessons', label: 'Lessons' },
];

/* ── data ─────────────────────────────────────────────────────────────────── */
const cache = new Map();
async function getJSON(url) {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }).catch((e) => { cache.delete(url); throw e; }));
  return cache.get(url);
}
export const loadBook = (id) => (isShipped(id) ? getJSON('books/' + id + '/book.json') : B.get(id));
export const loadChapter = (id, file) => (isShipped(id) ? getJSON('books/' + id + '/' + file) : B.chapter(id, file));
export const loadLessons = (id) => (isShipped(id) ? getJSON('books/' + id + '/lessons.json').catch(() => ({})) : Promise.resolve({}));

export const chKey = (n) => 'ch' + n;
export function progressOf(book, n) { return me.get('progress.' + book + '.' + chKey(n), {}) || {}; }
/** 0..1 for a chapter: done = 1, else how far it was read. */
export function fracOf(book, n) {
  const p = progressOf(book, n);
  if (p.done) return 1;
  return Math.max(0, Math.min(1, Number(p.f) || 0));
}
// What a chapter offers, per mode. Listen/Watch come from generated
// assets recorded in the shared doc, or shipped ones (pods, vids: the book's
// media/podcasts.json and media/videos.json); Study from the book's study.json
// (study) or study sets made with AI (study/hub.js).
export function available(book, n, lessons, pods, vids, study) {
  const a = M.docFor(book).get('assets.' + book + '.' + chKey(n), {}) || {};
  return {
    read: true,
    listen: !!a.podcast || !!(pods && pods[String(n)]),
    watch: !!a.video || !!(vids && vids[String(n)]),
    study: H.hasStudy(book, n, study),
    lessons: !!(lessons && lessons[n] && lessons[n].lessons && lessons[n].lessons.length) || !!(a.lessons && a.lessons.lessons),
  };
}

/** The lessons a chapter teaches: a featured AI-made set, else the readers' notes. */
export function lessonsFor(book, n, lessons) {
  const a = M.docFor(book).get('assets.' + book + '.' + chKey(n) + '.lessons', null);
  if (a && a.lessons && a.lessons.length) return { lessons: a.lessons, summary: a.summary, by: a.model };
  return (lessons && lessons[n]) || null;
}

/* ── progress: shown here at once, sent within 30 s (and on hide / leave) ──── */
export function setProgress(book, n, patch) {
  const base = 'progress.' + book + '.' + chKey(n), out = {};
  for (const [k, v] of Object.entries(patch)) out[base + '.' + k] = v;
  out[base + '.at'] = Date.now();
  out.last = { book, n, at: Date.now() };
  me.set(out, { lazy: true });
}
/** Where this person is: written when a chapter opens, so another device's
 *  "Continue" lands here too. */
export function markOpened(book, n) {
  const last = me.get('last', null);
  if (last && last.book === book && last.n === n) return;
  me.set({ last: { book, n, at: Date.now() } });
}

/* ── pieces ───────────────────────────────────────────────────────────────── */
function cover(b) {
  const c = COVERS[b.id] || Object.assign({ kicker: b.where === 'mine' ? 'Mine' : 'Shared' }, PALETTE[parseInt(OR.hashKey(b.id).slice(1), 36) % PALETTE.length]);
  return '<div class="cover" style="--cv-bg:' + c.bg + ';--cv-tx:' + c.tx + ';--cv-ac:' + c.ac + '">' +
    '<div><div class="cv-kicker">' + esc(c.kicker) + '</div><div class="cv-title" style="margin-top:14px">' + esc(b.title) + '</div>' +
    (b.subtitle ? '<div class="cv-sub">' + esc(b.subtitle) + '</div>' : '') + '</div>' +
    '<div class="cv-mark">' + IC.book + '</div></div>';
}
function ring(frac, label) {
  const r = 18, c = 2 * Math.PI * r, off = c * (1 - frac);
  return '<div class="ring' + (frac >= 1 ? ' done' : '') + '" aria-label="' + Math.round(frac * 100) + '% read">' +
    '<svg viewBox="0 0 42 42"><circle class="tr" cx="21" cy="21" r="' + r + '"/><circle class="pr" cx="21" cy="21" r="' + r + '" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '"/></svg>' +
    '<span>' + esc(label) + '</span></div>';
}
export function bookFrac(b) {
  if (!b.chapters.length) return 0;
  return b.chapters.reduce((s, c) => s + fracOf(b.id, c.n), 0) / b.chapters.length;
}

/** A view draws into a holder the router then empties into #view: redrawing
 *  later (after a drop, a rename) goes to where the view now is. */
const live = (el) => (el.isConnected ? el : document.getElementById('view') || el);

/* ── views ────────────────────────────────────────────────────────────────── */
export async function viewLibrary(el, { go }) {
  const shipped = (await Promise.all(SHIPPED.map((id) => loadBook(id).catch(() => null)))).filter(Boolean);
  const imp = B.list();
  // Each shelf in the person's own order (shelf.order is the Shared one's,
  // kept from before Mine existed).
  const sharedBooks = OR.arrange([...shipped, ...imp.shared.map((b) => Object.assign({ where: 'shared' }, b))], (b) => b.id, me.get('shelf.order', []) || []);
  const mine = OR.arrange(imp.mine.map((b) => Object.assign({ where: 'mine' }, b)), (b) => b.id, me.get('shelf.mine', []) || []);
  const card = (b) => {
    const f = bookFrac(b);
    return '<button class="book" data-dkey="' + esc(b.id) + '" data-go="#/b/' + esc(b.id) + '" title="' + esc(OR.HINT) + '">' + cover(b) +
      '<div class="bk-meta"><div class="bk-t">' + esc(b.title) + '</div><div class="bk-a">' + esc(b.translator || b.author || '') + '</div>' +
      '<div class="bk-bar"><i style="width:' + (f * 100).toFixed(1) + '%"></i></div></div></button>';
  };
  // Each shelf ends with a quiet "Import a book" tile, the size of a book; what
  // it takes shows only on hover (Tony, 2026-10-22). Shared imports land on the
  // Shared shelf, for both of them.
  const addTile = (where) => '<button class="shelf-add" data-import="' + where + '" aria-label="Import a book to ' + (where === 'mine' ? 'Mine' : 'Shared') + '">' +
    '<span class="sa-cover"><span class="sa-plus">' + IC.plus + '</span><b>Import a book</b><span class="sa-desc">PDF, EPUB, Word or text. Shruti finds the chapters.</span></span></button>';
  el.innerHTML =
    '<div class="lib-hero"><h1>Library</h1><p>Read, listen, watch and study.</p></div>' +
    '<section class="lib-sec"><div class="sec-h lib-h"><h2>Shared</h2><span class="n">Tony and Veda</span></div>' +
    '<div class="shelf" id="shelf-shared">' + sharedBooks.map(card).join('') + addTile('shared') + '</div></section>' +
    '<section class="lib-sec"><div class="sec-h lib-h"><h2>Mine</h2><span class="n">' + esc(PROFILES[PROFILE] ? 'Only ' + PROFILES[PROFILE].label : '') + '</span></div>' +
    '<div class="shelf" id="shelf-mine">' + mine.map(card).join('') + addTile('mine') + '</div></section>';
  el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { if (!(window.A1Drag && A1Drag.active)) go(b.dataset.go); }));
  el.querySelectorAll('[data-import]').forEach((b) => b.addEventListener('click', () => IMP().then((m) => m.open({ go, where: b.dataset.import }))));
  const redraw = () => viewLibrary(live(el), { go });
  OR.sortable(el.querySelector('#shelf-shared'), { row: '.book', axis: 'grid', onMove: (ids) => { me.set({ 'shelf.order': ids }, { now: true }); redraw(); } });
  OR.sortable(el.querySelector('#shelf-mine'), { row: '.book', axis: 'grid', onMove: (ids) => { me.set({ 'shelf.mine': ids }, { now: true }); redraw(); } });
}

export async function viewBook(el, { id, go }) {
  const [b, lessons, pods, vids, study] = await Promise.all([loadBook(id), loadLessons(id), POD.shipped(id), VID.shipped(id), H.shippedIndex(id)]);
  const last = me.get('last', null);
  const cur = last && last.book === id ? last.n : null;
  const done = b.chapters.filter((c) => fracOf(id, c.n) >= 1).length;
  const lessonCount = b.chapters.reduce((s, c) => s + (c.lessons || 0), 0);
  const startN = cur != null ? cur : (b.chapters.find((c) => fracOf(id, c.n) < 1) || b.chapters[0]).n;
  const row = (c) => {
    const f = fracOf(id, c.n), av = available(id, c.n, lessons, pods, vids, study), p = progressOf(id, c.n), md = p.modes || {};
    const badge = (m) => '<span class="bdg ' + (md[m] ? 'done' : av[m] ? 'av' : '') + '" title="' + esc(MODES.find((x) => x.id === m).label + (md[m] ? ': done' : av[m] ? '' : ': not made yet')) + '">' + IC[m] + '</span>';
    const meta = [c.verses ? c.verses + ' verses' : '', c.key ? c.key + ' key' : '', c.lessons ? c.lessons + ' lessons' : '', c.words ? Number(c.words).toLocaleString() + ' words' : ''].filter(Boolean).join(' · ');
    return '<button class="ch' + (cur === c.n ? ' cur' : '') + '" data-go="#/b/' + esc(id) + '/' + c.n + '">' + ring(f, c.n) +
      '<div><div class="t">' + esc(c.title) + '</div><div class="m">' + esc(meta) + '</div></div>' +
      '<div class="badges">' + ['read', 'listen', 'watch', 'study'].map(badge).join('') + '</div></button>';
  };
  const unit = b.unit || 'Chapter', plural = unit.toLowerCase() + (b.chapters.length === 1 ? '' : 's');
  el.innerHTML =
    '<div class="bk-head">' + cover(b) + '<div><h1>' + esc(b.title) + '</h1>' +
    '<div class="by">' + esc([b.author, b.translator && 'rendered by ' + b.translator].filter(Boolean).join(', ')) + '</div>' +
    '<div class="stats"><span><b>' + b.chapters.length + '</b> ' + esc(plural) + '</span><span><b>' + done + '</b> finished</span>' + (b.imported ? '<span><b>' + Number(b.words || 0).toLocaleString() + '</b> words</span>' : '<span><b>' + lessonCount + '</b> lessons</span>') + '</div>' +
    '<div class="acts"><button class="btn solid" data-go="#/b/' + esc(id) + '/' + startN + '">' + IC.play + (cur != null ? 'Continue ' + esc(unit.toLowerCase()) + ' ' + startN : 'Start reading') + '</button>' +
    (b.intro ? '<button class="btn" data-go="#/b/' + esc(id) + '/0">Introduction</button>' : '') +
    '<button class="btn" data-build>' + G.ICON + 'Build everything</button>' +
    (b.imported ? '<button class="btn ghost" data-rename>' + IC.pen + 'Rename</button><button class="btn ghost danger" data-delete>' + IC.trash + 'Delete</button>' : '') + '</div>' +
    (b.imported ? '<p class="bk-src">' + esc((b.where === 'mine' ? 'Only yours' : 'Shared with ' + (PROFILE === 'veda' ? 'Tony' : 'Veda')) + ' · imported from ' + ((b.src && b.src.name) || 'pasted text') + (b.by && PROFILES[b.by] ? ' by ' + PROFILES[b.by].label : '')) + '</p>' : '') + '</div></div>' +
    '<div class="sec-h"><h2>' + esc(unit + 's') + '</h2></div><div class="chs">' + b.chapters.map(row).join('') + '</div>' + bookmarksHtml(b);
  el.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => { if (!(window.A1Drag && A1Drag.active)) go(x.dataset.go); }));
  el.querySelector('[data-build]').addEventListener('click', () => MK.openBuild(id));
  const rn = el.querySelector('[data-rename]');
  if (rn) rn.addEventListener('click', () => IMP().then((m) => m.rename(b, () => viewBook(live(el), { id, go }))));
  const del = el.querySelector('[data-delete]');
  if (del) del.addEventListener('click', async () => {
    const both = b.where !== 'mine';
    if (!await window.uiConfirm('Delete “' + b.title + '”' + (both ? ' for both of you' : '') + '? Its text and everything made from it (podcasts, videos, study sets) go too.', { title: 'Delete book', okLabel: 'Delete' })) return;
    await B.remove(id);
    window.Shruti && window.Shruti.toast('Deleted “' + b.title + '”');
    go('#/');
  });
  OR.sortable(el.querySelector('.bmks'), { row: '.bmk', axis: 'grid', onMove: (keys) => { OR.put('bmk.' + id, keys); viewBook(live(el), { id, go }); } });
}

/** Every bookmark this person keeps in a book: in book order, or the order
 *  they dragged them into (order.bmk.<book>). */
function bookmarksHtml(b) {
  const all = me.get('bookmarks.' + b.id, {}) || {};
  const marks = [];
  for (const c of [{ n: 0, title: b.intro && b.intro.title }, ...b.chapters]) {
    const m = all[chKey(c.n)] || {};
    Object.keys(m).map((k) => Number(k.slice(1))).sort((x, y) => x - y).forEach((blk) => marks.push({ c, blk, m: m['b' + blk], key: chKey(c.n) + '.b' + blk }));
  }
  const rows = OR.arrange(marks, (x) => x.key, OR.get('bmk.' + b.id)).map(({ c, blk, m, key }) =>
    '<button class="bmk" data-dkey="' + esc(key) + '" title="' + esc(OR.HINT) + '" data-go="#/b/' + esc(b.id) + '/' + c.n + '/read/' + blk + '">' + IC.ribbon +
    '<span><b>' + esc(m.label || '') + '</b><span>' + esc(c.n ? (b.unit || 'Chapter') + ' ' + c.n + ' · ' + c.title : c.title || 'Introduction') + '</span></span></button>');
  return rows.length ? '<div class="sec-h"><h2>Bookmarks</h2><span class="n">' + rows.length + '</span></div><div class="bmks">' + rows.join('') + '</div>' : '';
}

export async function viewChapter(el, { id, n, mode, at, go }) {
  const b = await loadBook(id);
  const isIntro = n === 0;
  const meta = isIntro ? { n: 0, title: b.intro.title, file: b.intro.file } : b.chapters.find((c) => c.n === n);
  if (!meta) { go('#/b/' + id); return; }
  const [ch, lessons, pods, vids, reads, study] = await Promise.all([loadChapter(id, meta.file), loadLessons(id), POD.shipped(id), VID.shipped(id), (isShipped(id) ? getJSON('books/' + id + '/media/index.json').catch(() => ({})) : {}), H.shippedIndex(id)]);
  const av = available(id, n, lessons, pods, vids, study);
  mode = MODES.some((m) => m.id === mode) && (!isIntro || mode === 'study') ? mode : 'read';
  const idx = b.chapters.findIndex((c) => c.n === n);
  const prev = isIntro ? null : idx > 0 ? b.chapters[idx - 1] : (b.intro ? { n: 0, title: b.intro.title } : null);
  const next = isIntro ? b.chapters[0] : b.chapters[idx + 1];
  const tabs = MODES.filter((m) => !isIntro || m.id === 'read' || m.id === 'study').map((m) =>
    '<button data-mode="' + m.id + '" class="' + (m.id === mode ? 'on' : '') + '">' + IC[m.id] + m.label + '</button>').join('');
  // The header (Tony, 2026-10-22: "way cleaner"): the chapter, its title, one
  // quiet line of counts; on the right, read-or-not and Make with AI. Then the
  // tabs, sticky under the top bar.
  const counts = isIntro ? [] : [meta.verses && meta.verses + ' verses', meta.key && meta.key + ' key', meta.lessons && meta.lessons + ' lessons', meta.words && Number(meta.words).toLocaleString() + ' words'].filter(Boolean);
  const navBtn = (c, dir) => '<button class="cpn ' + dir + '" data-go="#/b/' + id + '/' + c.n + '"><span class="cpn-k">' + (dir === 'prev' ? IC.prev + 'Previous' : 'Next' + IC.next) + '</span><b>' + esc(c.n ? c.n + '. ' + c.title : c.title) + '</b></button>';
  el.innerHTML =
    '<header class="cp-head"><div class="cp-t"><div class="k">' + (isIntro ? esc(b.title) : esc(b.unit || 'Chapter') + ' ' + n) + '</div>' +
    '<h1>' + esc(meta.title) + '</h1>' +
    (counts.length ? '<div class="m">' + counts.map((x) => '<span>' + esc(x) + '</span>').join('') + '</div>' : '') + '</div>' +
    '<div class="cp-acts"><button class="btn ghost mark" id="mark-read"></button><button class="btn" id="make-ai">' + G.ICON + 'Make with AI</button></div></header>' +
    '<nav class="modes" role="tablist"><div class="modes-in">' + tabs + '</div></nav><div id="mode-body"></div>' +
    '<nav class="cp-nav" aria-label="Chapters">' + (prev ? navBtn(prev, 'prev') : '<span></span>') + (next ? navBtn(next, 'next') : '<span></span>') + '</nav>';
  el.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => go(x.dataset.go)));
  el.querySelectorAll('[data-mode]').forEach((x) => x.addEventListener('click', () => go('#/b/' + id + '/' + n + (x.dataset.mode === 'read' ? '' : '/' + x.dataset.mode), { replace: true })));
  const body = el.querySelector('#mode-body');
  // Read / unread by hand: unread clears the ring, so the chapter counts as
  // not finished again (until it is read to the end once more).
  const mark = el.querySelector('#mark-read');
  const paintMark = () => {
    const isDone = fracOf(id, n) >= 1;
    mark.innerHTML = IC.check + '<span>' + (isDone ? 'Read' : 'Mark read') + '</span>';
    mark.classList.toggle('on', isDone);
    mark.setAttribute('aria-pressed', String(isDone));
    mark.title = isDone ? 'Read. Tap to mark it unread and start over.' : 'Count this chapter as read.';
  };
  paintMark();
  body.addEventListener('shruti:read', paintMark);
  mark.addEventListener('click', () => {
    const toDone = fracOf(id, n) < 1;
    setProgress(id, n, toDone ? { f: 1, done: true, 'modes.read': 1 } : { f: 0, done: false, 'modes.read': 0 });
    me.flush && me.flush();
    paintMark();
    body.dispatchEvent(new CustomEvent('shruti:mark', { detail: { done: toDone } }));
  });
  // What "Make with AI" needs, and what ships for each kind.
  const L = lessonsFor(id, n, lessons);
  const p = pods && pods[String(n)], v = vids && vids[String(n)], r = reads && reads[String(n)];
  const ctx = { book: id, bookTitle: b.title, n, title: meta.title, ch, lessons: L, shipped: {
    podcast: p && (p.hosts || []).join(' & ') + ' · ' + T.fmtTime(p.duration),
    video: v && v.narrator + ' · ' + T.fmtTime(v.duration),
    read: r && NRname(r.voice) + ' · ' + T.fmtTime(r.duration),
    lessons: lessons && lessons[n] && lessons[n].lessons ? lessons[n].lessons.length + ' lessons from Tony and Veda’s notes' : null,
  } };
  // Make with AI makes what this tab shows (Tony, 2026-10-22), and shows when
  // something for this chapter is being made in the background.
  Object.assign(ctx, { chapters: [...(b.intro ? [{ n: 0, title: b.intro.title, file: b.intro.file }] : []), ...b.chapters], loadChapter: (file) => loadChapter(id, file) });
  const mk = el.querySelector('#make-ai');
  mk.addEventListener('click', () => MK.open(ctx, mode));
  MK.watchButton(mk, id, n);
  const notMade = (md, kind) => {
    body.innerHTML = '<div class="empty">' + IC[md] + '<b>' + esc(MODES.find((m) => m.id === md).label) + ' is not made for this chapter yet</b>' +
      '<span>' + (md === 'study' ? 'Flashcards, a quiz, a mind map and slides will be built here from the chapter.' : md === 'lessons' ? 'Lessons can be drawn from the chapter with AI.' : 'It will tell the chapter’s story and teach every lesson.') + '</span>' +
      (kind ? '<button class="btn solid" data-make-now>' + G.ICON + 'Make it now</button>' : '') + '</div>';
    const b2 = body.querySelector('[data-make-now]'); if (b2) b2.addEventListener('click', () => MK.open(ctx, md));
  };
  const drawMode = () => {
    const L = ctx.lessons = lessonsFor(id, n, lessons), av = available(id, n, lessons, pods, vids, study);
    if (mode === 'read') renderRead(body, ch, id, n, { title: meta.title, at });
    else if (mode === 'lessons') { if (L && L.lessons && L.lessons.length) renderLessons(body, L, { bookTitle: b.title, n, title: meta.title }); else notMade('lessons', 'lessons'); }
    else if (mode === 'listen' && (av.listen || POD.active(id, n))) renderListen(body, id, n, meta, L, () => notMade('listen', 'podcast'));
    else if (mode === 'watch' && (av.watch || VID.active(id, n))) renderWatch(body, id, n, meta, L, () => notMade('watch', 'video'));
    else if (mode === 'study') H.renderStudy(body, { book: id, bookTitle: b.title, n, title: meta.title, ch, lessons: L, chapters: [...(b.intro ? [{ n: 0, title: b.intro.title, file: b.intro.file }] : []), ...b.chapters], loadChapter: (file) => loadChapter(id, file) });
    else notMade(mode, { listen: 'podcast', watch: 'video' }[mode]);
  };
  drawMode();
  // Another version ticked (in Make with AI here, or on another device), or a
  // new one made: the tab shows it at once (Tony, 2026-10-22: it waited until
  // the tab was opened again). Never under something playing.
  const doc = M.docFor(id), assetSig = () => JSON.stringify(doc.get('assets.' + id + '.' + chKey(n), {}) || {});
  let sig = assetSig();
  const offA = onDoc(doc === me ? 'doc:me' : 'doc:shared', () => {
    if (!body.isConnected) { offA(); return; }
    const now = assetSig();
    if (now === sig) return;
    sig = now;
    if (mode === 'lessons' || (mode === 'listen' && !(POD.active(id, n) && POD.state.playing)) || (mode === 'watch' && !(VID.active(id, n) && VID.state.playing))) {
      if (window.A1Drag && A1Drag.active) A1Drag.later(drawMode); else drawMode();
    }
  });
  ls.put(lsKey('lastRoute'), { id, n, mode });
  markOpened(id, n);
}

/** What a background task needs of its chapter (jobs.js runs with only the
 *  book and chapter number, so a reload can pick a task up again). */
export async function taskContext(book, n) {
  const b = await loadBook(book);
  const meta = n === 0 ? { n: 0, title: b.intro.title, file: b.intro.file } : b.chapters.find((c) => c.n === n);
  if (!meta) throw new Error('That chapter is not in the book any more');
  const [ch, lessons, pods, vids, study, ready] = await Promise.all([loadChapter(book, meta.file), loadLessons(book), POD.shipped(book), VID.shipped(book), H.shippedIndex(book), NR.readyFor(book, n)]);
  return {
    book, n, bookTitle: b.title, title: meta.title, ch, lessons: lessonsFor(book, n, lessons), ready,
    shipped: { podcast: !!(pods && pods[String(n)]), video: !!(vids && vids[String(n)]) },
    hasStudy: H.hasStudy(book, n, study),
    chapters: [...(b.intro ? [{ n: 0, title: b.intro.title, file: b.intro.file }] : []), ...b.chapters],
    loadChapter: (file) => loadChapter(book, file),
  };
}

async function renderListen(body, id, n, meta, L, none) {
  const ok = await POD.renderListen(body, { book: id, n, title: meta.title, lessons: L });
  if (ok === false) none();
}

async function renderWatch(body, id, n, meta, L, none) {
  const ok = await VID.renderWatch(body, { book: id, n, title: meta.title, lessons: L });
  if (ok === false) none();
}

function renderLessons(body, L, meta = {}) {
  if (!L || !L.lessons || !L.lessons.length) { body.innerHTML = '<div class="empty">' + IC.lessons + '<b>No lessons for this chapter yet</b></div>'; return; }
  body.innerHTML = '<div class="ls"><div class="ls-top"><p class="ls-k">' + L.lessons.length + (L.by ? ' lessons drawn by ' + esc(G.modelName(L.by)) + ' (Make with AI)' : ' lessons from Tony and Veda’s notes') + '</p>' +
    '<button class="btn sm" id="ls-pdf">' + IC.pdf + '<span>Save as PDF</span></button></div>' + L.lessons.map((l) =>
    '<div class="ls-i"><div class="h"><span class="id">' + esc(l.id) + '</span><span class="tt">' + esc(l.title || '') + '</span></div>' +
    (l.body ? '<div class="bd">' + esc(l.body) + '</div>' : '') + '</div>').join('') +
    (L.summary ? '<div class="ls-sum"><b>Chapter summary</b>' + esc(L.summary) + '</div>' : '') + '</div>';
  const btn = body.querySelector('#ls-pdf'), label = btn.querySelector('span');
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true; label.textContent = 'Making the PDF…';
    try {
      await PDF.lessonsPDF({ bookTitle: meta.bookTitle, bookShort: meta.bookTitle, n: meta.n, title: meta.title, L, byName: L.by ? G.modelName(L.by) : '' });
      label.textContent = 'Save as PDF';
    } catch (e) { label.textContent = 'Could not make it: try again'; btn.title = e.message || ''; }
    btn.disabled = false;
  });
}
