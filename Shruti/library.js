// Library -> book -> chapter. Books ship in the repo (books/<id>/book.json and
// one file per chapter), so the Gita works with no network beyond the page.
// Progress is per person (dashboards/shruti[_veda] -> progress.<book>.ch<n>),
// even on shared books.

import { me, shared, emit, ls, lsKey } from './core.js';

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
  book: '<svg viewBox="14 14 68 68" fill="none" stroke="currentColor" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M48 40c-6-4-14-6-24-6v38c10 0 18 2 24 6 6-4 14-6 24-6V34c-10 0-18 2-24 6Z"/><path d="M48 40v38"/><path d="M41 28a10 10 0 0 1 14 0"/><path d="M35 21a19 19 0 0 1 26 0"/></svg>',
};
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
// What a chapter offers, per mode. Listen/Watch/Study come from generated or
// shipped assets (Phases 4-7), recorded in the shared doc.
export function available(book, n, lessons) {
  const a = shared.get('assets.' + book + '.' + chKey(n), {}) || {};
  return {
    read: true,
    listen: !!a.podcast,
    watch: !!a.video,
    study: !!(a.study && Object.keys(a.study).length),
    lessons: !!(lessons && lessons[n] && lessons[n].lessons && lessons[n].lessons.length),
  };
}

/* ── progress writes: local at once, the server at most every 30 s ─────────── */
const queued = {};
let qTimer = null, lastSent = 0;
export function setProgress(book, n, patch) {
  const base = 'progress.' + book + '.' + chKey(n);
  for (const [k, v] of Object.entries(patch)) queued[base + '.' + k] = v;
  queued[base + '.at'] = Date.now();
  queued.last = { book, n, at: Date.now() };
  const wait = Math.max(0, 30000 - (Date.now() - lastSent));
  if (!qTimer) qTimer = setTimeout(flushProgress, wait);
  // Show it here straight away.
  emit('progress', { book, n });
}
export function flushProgress() {
  clearTimeout(qTimer); qTimer = null;
  if (!Object.keys(queued).length) return;
  const out = Object.assign({}, queued);
  for (const k of Object.keys(queued)) delete queued[k];
  lastSent = Date.now();
  me.set(out);
}
export function queuedFrac(book, n) {
  const k = 'progress.' + book + '.' + chKey(n) + '.f';
  return k in queued ? queued[k] : null;
}
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushProgress(); });

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
    '<div class="empty">' + IC.plus + '<b>Your own books will sit here</b><span>Importing a PDF, EPUB, Word file or pasted text is coming to Shruti soon.</span></div>';
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
  const [b, lessons] = await Promise.all([loadBook(id), loadLessons(id)]);
  const last = me.get('last', null);
  const cur = last && last.book === id ? last.n : null;
  const done = b.chapters.filter((c) => fracOf(id, c.n) >= 1).length;
  const lessonCount = b.chapters.reduce((s, c) => s + (c.lessons || 0), 0);
  const startN = cur != null ? cur : (b.chapters.find((c) => fracOf(id, c.n) < 1) || b.chapters[0]).n;
  const row = (c) => {
    const f = fracOf(id, c.n), av = available(id, c.n, lessons), p = progressOf(id, c.n), md = p.modes || {};
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
    '<div class="sec-h"><h2>Chapters</h2></div><div class="chs">' + b.chapters.map(row).join('') + '</div>';
  el.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => go(x.dataset.go)));
}

export async function viewChapter(el, { id, n, mode, go }) {
  const b = await loadBook(id);
  const isIntro = n === 0;
  const meta = isIntro ? { n: 0, title: b.intro.title, file: b.intro.file } : b.chapters.find((c) => c.n === n);
  if (!meta) { go('#/b/' + id); return; }
  const [ch, lessons] = await Promise.all([loadChapter(id, meta.file), loadLessons(id)]);
  const av = available(id, n, lessons);
  mode = MODES.some((m) => m.id === mode) ? mode : 'read';
  const idx = b.chapters.findIndex((c) => c.n === n);
  const prev = isIntro ? null : idx > 0 ? b.chapters[idx - 1] : (b.intro ? { n: 0, title: b.intro.title } : null);
  const next = isIntro ? b.chapters[0] : b.chapters[idx + 1];
  const tabs = MODES.filter((m) => !isIntro || m.id === 'read').map((m) =>
    '<button data-mode="' + m.id + '" class="' + (m.id === mode ? 'on' : '') + '">' + IC[m.id] + m.label + '</button>').join('');
  el.innerHTML =
    '<div class="cp-head"><div class="k">' + (isIntro ? esc(b.title) : esc(b.unit || 'Chapter') + ' ' + n) + '</div>' +
    '<h1>' + esc(meta.title) + '</h1>' +
    (isIntro ? '' : '<div class="m">' + esc([meta.verses && meta.verses + ' verses', meta.key && meta.key + ' key verses', meta.lessons && meta.lessons + ' lessons'].filter(Boolean).join(' · ')) + '</div>') + '</div>' +
    '<nav class="modes" role="tablist">' + tabs + '</nav><div id="mode-body"></div>' +
    '<div class="cp-nav">' + (prev ? '<button class="btn ghost" data-go="#/b/' + id + '/' + prev.n + '">' + IC.prev + esc(prev.n ? prev.n + '. ' + prev.title : prev.title) + '</button>' : '<span></span>') +
    (next ? '<button class="btn ghost" data-go="#/b/' + id + '/' + next.n + '">' + esc(next.n + '. ' + next.title) + IC.next + '</button>' : '<span></span>') + '</div>';
  el.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => go(x.dataset.go)));
  el.querySelectorAll('[data-mode]').forEach((x) => x.addEventListener('click', () => go('#/b/' + id + '/' + n + (x.dataset.mode === 'read' ? '' : '/' + x.dataset.mode), { replace: true })));
  const body = el.querySelector('#mode-body');
  if (mode === 'read') renderRead(body, ch, id, n);
  else if (mode === 'lessons') renderLessons(body, lessons[n]);
  else body.innerHTML = '<div class="empty">' + IC[mode] + '<b>' + esc(MODES.find((m) => m.id === mode).label) + ' is not made for this chapter yet</b>' +
    '<span>' + (av[mode] ? '' : mode === 'study' ? 'Flashcards, a quiz, a mind map and slides will be built here from the chapter.' : 'It will tell the chapter\'s story and teach every lesson.') + '</span></div>';
  ls.put(lsKey('lastRoute'), { id, n, mode });
}

function renderRead(body, ch, book, n) {
  const out = [];
  for (const bl of ch.blocks || []) {
    if (bl.k === 'h') out.push(bl.minor ? '<h4>' + esc(bl.t) + '</h4>' : '<h3>' + esc(bl.t) + '</h3>');
    else if (bl.k === 'p') {
      out.push('<p>' + (bl.s || []).map((s) => (s.v ? '<span class="vn">' + esc(s.v) + '</span>' : '') +
        (s.key ? '<span class="key">' + esc(s.t) + '</span>' : esc(s.t))).join(' ') + '</p>');
    } else if (bl.k === 'a') out.push('<aside class="' + esc(bl.style || '') + '">' + esc(bl.t) + '</aside>');
  }
  body.innerHTML = '<article class="rd">' + out.join('') + '</article>';
  // How far down the text this person has read: the ring on the chapter list.
  const art = body.querySelector('.rd');
  const had = fracOf(book, n);
  let best = had;
  const measure = () => {
    if (!art.isConnected) { removeEventListener('scroll', measure); return; }
    const r = art.getBoundingClientRect();
    const seen = Math.min(1, Math.max(0, (innerHeight - r.top) / Math.max(1, r.height)));
    if (seen > best + 0.02 || (seen >= 0.98 && best < 1)) {
      best = seen >= 0.98 ? 1 : seen;
      setProgress(book, n, best >= 1 ? { f: 1, done: true, 'modes.read': 1 } : { f: +best.toFixed(3) });
    }
  };
  addEventListener('scroll', measure, { passive: true });
}

function renderLessons(body, L) {
  if (!L || !L.lessons || !L.lessons.length) { body.innerHTML = '<div class="empty">' + IC.lessons + '<b>No lessons for this chapter yet</b></div>'; return; }
  body.innerHTML = '<div class="ls">' + L.lessons.map((l) =>
    '<div class="ls-i"><div class="h"><span class="id">' + esc(l.id) + '</span><span class="tt">' + esc(l.title || '') + '</span></div>' +
    (l.body ? '<div class="bd">' + esc(l.body) + '</div>' : '') + '</div>').join('') +
    (L.summary ? '<div class="ls-sum">' + esc(L.summary) + '</div>' : '') + '</div>';
}
