// Library -> book -> chapter. Books ship in the repo (books/<id>/book.json and
// one file per chapter), so the Gita works with no network beyond the page.
// Progress is per person (dashboards/shruti[_veda] -> progress.<book>.ch<n>),
// even on shared books.

import { me, shared, ls, lsKey } from './core.js';
import { renderRead } from './reader.js';
import * as POD from './podcast.js';
import * as VID from './video.js';
import * as M from './media.js';
import * as G from './generate.js';
import * as T from './text.js';

export const SHIPPED = ['gita'];
const COVERS = { gita: { bg: '#2b2235', tx: '#f2ead8', ac: '#e0b874', kicker: 'Shared' } };

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
  check: I('<path d="M20 6 9 17l-5-5"/>'),
  ribbon: I('<path d="M6 3h12v18l-6-4-6 4z"/>'),
  undo: I('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>'),
  key: I('<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="M16 7l3 3"/><path d="M18.5 4.5l2 2"/>'),
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
export const loadBook = (id) => getJSON('books/' + id + '/book.json');
export const loadChapter = (id, file) => getJSON('books/' + id + '/' + file);
export const loadLessons = (id) => getJSON('books/' + id + '/lessons.json').catch(() => ({}));

export const chKey = (n) => 'ch' + n;
export function progressOf(book, n) { return me.get('progress.' + book + '.' + chKey(n), {}) || {}; }
/** 0..1 for a chapter: done = 1, else how far it was read. */
export function fracOf(book, n) {
  const p = progressOf(book, n);
  if (p.done) return 1;
  return Math.max(0, Math.min(1, Number(p.f) || 0));
}
// What a chapter offers, per mode. Listen/Watch/Study come from generated
// assets recorded in the shared doc, or shipped ones (pods, vids: the book's
// media/podcasts.json and media/videos.json).
export function available(book, n, lessons, pods, vids) {
  const a = shared.get('assets.' + book + '.' + chKey(n), {}) || {};
  return {
    read: true,
    listen: !!a.podcast || !!(pods && pods[String(n)]),
    watch: !!a.video || !!(vids && vids[String(n)]),
    study: !!(a.study && Object.keys(a.study).length),
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
  const c = COVERS[b.id] || { bg: '#2a2f3a', tx: '#eef', ac: '#c0aeea', kicker: b.shared ? 'Shared' : 'Mine' };
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

/* ── views ────────────────────────────────────────────────────────────────── */
export async function viewLibrary(el, { go }) {
  const books = await Promise.all(SHIPPED.map((id) => loadBook(id).catch(() => null)));
  const sharedBooks = books.filter(Boolean);
  // Personal shelves come with Import (Phase 8); the order is per person.
  const order = me.get('shelf.order', []) || [];
  sharedBooks.sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999));
  const card = (b) => {
    const f = bookFrac(b);
    return '<button class="book" data-dkey="' + esc(b.id) + '" data-go="#/b/' + esc(b.id) + '">' + cover(b) +
      '<div class="bk-meta"><div class="bk-t">' + esc(b.title) + '</div><div class="bk-a">' + esc(b.translator || b.author || '') + '</div>' +
      '<div class="bk-bar"><i style="width:' + (f * 100).toFixed(1) + '%"></i></div></div></button>';
  };
  el.innerHTML =
    '<div class="lib-hero"><h1>Library</h1><p>Read, listen, watch and study, one chapter at a time.</p></div>' +
    '<div class="sec-h"><h2>Shared</h2><span class="n">Tony and Veda</span></div>' +
    '<div class="shelf" id="shelf-shared">' + sharedBooks.map(card).join('') + '</div>' +
    '<div class="sec-h"><h2>Mine</h2></div>' +
    '<div class="mine-empty">' + IC.plus + '<span><b>Your own books will sit here.</b> Importing a PDF, EPUB, Word file or text is coming soon.</span></div>';
  el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { if (!(window.A1Drag && A1Drag.active)) go(b.dataset.go); }));
  const shelf = el.querySelector('#shelf-shared');
  if (window.A1Drag && shelf && sharedBooks.length > 1) {
    A1Drag.sort(shelf, {
      row: '.book', axis: 'grid', hold: 300,
      onDrop(from, to) {
        const ids = sharedBooks.map((b) => b.id);
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        me.set({ 'shelf.order': ids }, { now: true });
      },
    });
  }
}

export async function viewBook(el, { id, go }) {
  const [b, lessons, pods, vids] = await Promise.all([loadBook(id), loadLessons(id), POD.shipped(id), VID.shipped(id)]);
  const last = me.get('last', null);
  const cur = last && last.book === id ? last.n : null;
  const done = b.chapters.filter((c) => fracOf(id, c.n) >= 1).length;
  const lessonCount = b.chapters.reduce((s, c) => s + (c.lessons || 0), 0);
  const startN = cur != null ? cur : (b.chapters.find((c) => fracOf(id, c.n) < 1) || b.chapters[0]).n;
  const row = (c) => {
    const f = fracOf(id, c.n), av = available(id, c.n, lessons, pods, vids), p = progressOf(id, c.n), md = p.modes || {};
    const badge = (m) => '<span class="bdg ' + (md[m] ? 'done' : av[m] ? 'av' : '') + '" title="' + esc(MODES.find((x) => x.id === m).label + (md[m] ? ': done' : av[m] ? '' : ': not made yet')) + '">' + IC[m] + '</span>';
    const meta = [c.verses ? c.verses + ' verses' : '', c.key ? c.key + ' key' : '', c.lessons ? c.lessons + ' lessons' : ''].filter(Boolean).join(' · ');
    return '<button class="ch' + (cur === c.n ? ' cur' : '') + '" data-go="#/b/' + esc(id) + '/' + c.n + '">' + ring(f, c.n) +
      '<div><div class="t">' + esc(c.title) + '</div><div class="m">' + esc(meta) + '</div></div>' +
      '<div class="badges">' + ['read', 'listen', 'watch', 'study'].map(badge).join('') + '</div></button>';
  };
  el.innerHTML =
    '<div class="bk-head">' + cover(b) + '<div><h1>' + esc(b.title) + '</h1>' +
    '<div class="by">' + esc([b.author, b.translator && 'rendered by ' + b.translator].filter(Boolean).join(', ')) + '</div>' +
    '<div class="stats"><span><b>' + b.chapters.length + '</b> chapters</span><span><b>' + done + '</b> finished</span><span><b>' + lessonCount + '</b> lessons</span></div>' +
    '<div class="acts"><button class="btn solid" data-go="#/b/' + esc(id) + '/' + startN + '">' + IC.play + (cur != null ? 'Continue chapter ' + startN : 'Start reading') + '</button>' +
    (b.intro ? '<button class="btn" data-go="#/b/' + esc(id) + '/0">Introduction</button>' : '') + '</div></div></div>' +
    '<div class="sec-h"><h2>Chapters</h2></div><div class="chs">' + b.chapters.map(row).join('') + '</div>' + bookmarksHtml(b);
  el.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => go(x.dataset.go)));
}

/** Every bookmark this person keeps in a book, chapter by chapter. */
function bookmarksHtml(b) {
  const all = me.get('bookmarks.' + b.id, {}) || {};
  const rows = [];
  for (const c of [{ n: 0, title: b.intro && b.intro.title }, ...b.chapters]) {
    const m = all[chKey(c.n)] || {};
    Object.keys(m).map((k) => Number(k.slice(1))).sort((x, y) => x - y).forEach((blk) =>
      rows.push('<button class="bmk" data-go="#/b/' + esc(b.id) + '/' + c.n + '/read/' + blk + '">' + IC.ribbon +
        '<span><b>' + esc(m['b' + blk].label || '') + '</b><span>' + esc(c.n ? (b.unit || 'Chapter') + ' ' + c.n + ' · ' + c.title : c.title || 'Introduction') + '</span></span></button>'));
  }
  return rows.length ? '<div class="sec-h"><h2>Bookmarks</h2><span class="n">' + rows.length + '</span></div><div class="bmks">' + rows.join('') + '</div>' : '';
}

export async function viewChapter(el, { id, n, mode, at, go }) {
  const b = await loadBook(id);
  const isIntro = n === 0;
  const meta = isIntro ? { n: 0, title: b.intro.title, file: b.intro.file } : b.chapters.find((c) => c.n === n);
  if (!meta) { go('#/b/' + id); return; }
  const [ch, lessons, pods, vids, reads] = await Promise.all([loadChapter(id, meta.file), loadLessons(id), POD.shipped(id), VID.shipped(id), getJSON('books/' + id + '/media/index.json').catch(() => ({}))]);
  const av = available(id, n, lessons, pods, vids);
  mode = MODES.some((m) => m.id === mode) ? mode : 'read';
  const idx = b.chapters.findIndex((c) => c.n === n);
  const prev = isIntro ? null : idx > 0 ? b.chapters[idx - 1] : (b.intro ? { n: 0, title: b.intro.title } : null);
  const next = isIntro ? b.chapters[0] : b.chapters[idx + 1];
  const tabs = MODES.filter((m) => !isIntro || m.id === 'read').map((m) =>
    '<button data-mode="' + m.id + '" class="' + (m.id === mode ? 'on' : '') + '">' + IC[m.id] + m.label + '</button>').join('');
  el.innerHTML =
    '<div class="cp-head"><div class="k">' + (isIntro ? esc(b.title) : esc(b.unit || 'Chapter') + ' ' + n) + '</div>' +
    '<h1>' + esc(meta.title) + '</h1>' +
    (isIntro ? '' : '<div class="m">' + esc([meta.verses && meta.verses + ' verses', meta.key && meta.key + ' key verses', meta.lessons && meta.lessons + ' lessons'].filter(Boolean).join(' · ')) + '</div>') +
    '<div class="cp-acts"><button class="btn ghost mark" id="mark-read"></button><button class="btn ghost" id="make-ai">' + G.ICON + 'Make with AI</button></div></div>' +
    '<nav class="modes" role="tablist">' + tabs + '</nav><div id="mode-body"></div>' +
    '<div class="cp-nav">' + (prev ? '<button class="btn ghost" data-go="#/b/' + id + '/' + prev.n + '">' + IC.prev + esc(prev.n ? prev.n + '. ' + prev.title : prev.title) + '</button>' : '<span></span>') +
    (next ? '<button class="btn ghost" data-go="#/b/' + id + '/' + next.n + '">' + esc(next.n + '. ' + next.title) + IC.next + '</button>' : '<span></span>') + '</div>';
  el.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => go(x.dataset.go)));
  el.querySelectorAll('[data-mode]').forEach((x) => x.addEventListener('click', () => go('#/b/' + id + '/' + n + (x.dataset.mode === 'read' ? '' : '/' + x.dataset.mode), { replace: true })));
  const body = el.querySelector('#mode-body');
  // Read / unread by hand: unread clears the ring, so the chapter counts as
  // not finished again (until it is read to the end once more).
  const mark = el.querySelector('#mark-read');
  const paintMark = () => {
    const isDone = fracOf(id, n) >= 1;
    mark.innerHTML = (isDone ? IC.undo + 'Mark as unread' : IC.check + 'Mark as read');
    mark.title = isDone ? 'This chapter counts as read. Mark it unread to start it over.' : 'Count this chapter as read.';
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
  el.querySelector('#make-ai').addEventListener('click', () => G.openSheet(ctx, { listen: 'podcast', watch: 'video', lessons: 'lessons' }[mode]));
  const notMade = (md, kind) => {
    body.innerHTML = '<div class="empty">' + IC[md] + '<b>' + esc(MODES.find((m) => m.id === md).label) + ' is not made for this chapter yet</b>' +
      '<span>' + (md === 'study' ? 'Flashcards, a quiz, a mind map and slides will be built here from the chapter.' : md === 'lessons' ? 'Lessons can be drawn from the chapter with AI.' : 'It will tell the chapter’s story and teach every lesson.') + '</span>' +
      (kind ? '<button class="btn solid" data-make-now>' + G.ICON + 'Make it now</button>' : '') + '</div>';
    const b2 = body.querySelector('[data-make-now]'); if (b2) b2.addEventListener('click', () => G.openSheet(ctx, kind));
  };
  if (mode === 'read') renderRead(body, ch, id, n, { title: meta.title, at });
  else if (mode === 'lessons') { if (L && L.lessons && L.lessons.length) renderLessons(body, L); else notMade('lessons', 'lessons'); }
  else if (mode === 'listen' && (av.listen || POD.active(id, n))) renderListen(body, id, n, meta, L, () => notMade('listen', 'podcast'));
  else if (mode === 'watch' && (av.watch || VID.active(id, n))) renderWatch(body, id, n, meta, L, () => notMade('watch', 'video'));
  else notMade(mode, { listen: 'podcast', watch: 'video' }[mode]);
  ls.put(lsKey('lastRoute'), { id, n, mode });
  markOpened(id, n);
}

async function renderListen(body, id, n, meta, L, none) {
  const ok = await POD.renderListen(body, { book: id, n, title: meta.title, lessons: L });
  if (ok === false) none();
}

async function renderWatch(body, id, n, meta, L, none) {
  const ok = await VID.renderWatch(body, { book: id, n, title: meta.title, lessons: L });
  if (ok === false) none();
}

function renderLessons(body, L) {
  if (!L || !L.lessons || !L.lessons.length) { body.innerHTML = '<div class="empty">' + IC.lessons + '<b>No lessons for this chapter yet</b></div>'; return; }
  body.innerHTML = '<div class="ls"><p class="ls-k">' + L.lessons.length + (L.by ? ' lessons drawn by ' + esc(G.modelName(L.by)) + ' (Make with AI)' : ' lessons from Tony and Veda’s notes') + '</p>' + L.lessons.map((l) =>
    '<div class="ls-i"><div class="h"><span class="id">' + esc(l.id) + '</span><span class="tt">' + esc(l.title || '') + '</span></div>' +
    (l.body ? '<div class="bd">' + esc(l.body) + '</div>' : '') + '</div>').join('') +
    (L.summary ? '<div class="ls-sum"><b>Chapter summary</b>' + esc(L.summary) + '</div>' : '') + '</div>';
}
