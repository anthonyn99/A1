// What the four study tools share: icons, small DOM helpers, swipe, a key
// handler that removes itself when its tool leaves the page, and each
// person's synced progress (me doc: study.<book>.<set>.<kind>).

import * as C from '../core.js';

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Text with **bold** kept (models and the ready-made sets both use it). */
export const rich = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
const I = (b) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + b + '</svg>';
export const IC = {
  flashcards: I('<rect x="3" y="6" width="14" height="14" rx="2.5"/><path d="M7 3h11a3 3 0 0 1 3 3v11"/>'),
  quiz: I('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.2-2.5 3.9"/><path d="M12 17.2h.01"/>'),
  mindmap: I('<circle cx="12" cy="12" r="2.6"/><circle cx="4.5" cy="5.5" r="1.8"/><circle cx="19.5" cy="5.5" r="1.8"/><circle cx="4.5" cy="18.5" r="1.8"/><circle cx="19.5" cy="18.5" r="1.8"/><path d="M6 6.8l4 3.4M18 6.8l-4 3.4M6 17.2l4-3.4M18 17.2l-4-3.4"/>'),
  slides: I('<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M12 17v3.5M8 20.5h8"/>'),
  shuffle: I('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>'),
  grid: I('<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>'),
  deck: I('<rect x="4" y="5" width="16" height="14" rx="2.5"/>'),
  tick: I('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  x: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  left: I('<path d="M15 6l-6 6 6 6"/>'),
  right: I('<path d="M9 6l6 6-6 6"/>'),
  undo: I('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  minus: I('<path d="M5 12h14"/>'),
  fit: I('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  full: I('<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>'),
  image: I('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'),
  play: I('<path d="M7 4l13 8-13 8z" fill="currentColor"/>'),
  pause: I('<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor"/>'),
  present: I('<path d="M3 4h18M5 4v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4"/><path d="M12 16v4M9 20h6"/><path d="M10 8l4 2.5-4 2.5z" fill="currentColor"/>'),
  voice: I('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
  copy: I('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  trash: I('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  spark: I('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
};

export function h(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
/** A tool button: icon + label, or icon only with a title. */
export function btn(label, icon, onClick, cls = '', title = '') {
  const b = h('button', 'btn ' + cls, (icon ? IC[icon] : '') + (label ? '<span>' + esc(label) + '</span>' : ''));
  b.type = 'button';
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  else if (!label && icon) b.setAttribute('aria-label', icon);
  b.addEventListener('click', onClick);
  return b;
}

/** Keys for one tool: active while `root` is on the page and nothing is
 *  being typed; removed by itself afterwards. Returns a disposer. */
export function keys(root, fn) {
  const onKey = (e) => {
    if (!root.isConnected) { removeEventListener('keydown', onKey); return; }
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('.sheet-dim, .ui-dim')) return;
    if (root.closest('[hidden]')) return;
    fn(e);
  };
  addEventListener('keydown', onKey);
  return () => removeEventListener('keydown', onKey);
}

/** Horizontal swipe on el: left -> next(), right -> prev(). Marks el so a
 *  click right after a swipe is ignored (justSwiped). */
export function swipe(el, next, prev) {
  let x0 = null, y0 = 0;
  el.addEventListener('touchstart', (e) => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) { el.dataset.swiped = String(Date.now()); dx < 0 ? next() : prev(); }
  }, { passive: true });
}
export const justSwiped = (el) => Date.now() - Number(el.dataset.swiped || 0) < 400;

/* ── progress, per person, synced ───────────────────────────────────────── */
const key = (book, set, kind) => 'study.' + book + '.' + set + '.' + kind;
export const progress = (book, set, kind) => C.me.get(key(book, set, kind), {}) || {};
/** Merge fields into one tool's progress (sent within ~1 s, or at once). */
export function saveProgress(book, set, kind, fields, opt) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[key(book, set, kind) + '.' + k] = v;
  C.me.set(out, opt);
  dispatchEvent(new CustomEvent('shruti:study', { detail: { book, set, kind } }));
}
export const now = () => Date.now();
export const DAY = 86400000;
