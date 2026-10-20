// Drag to reorder (Phase 8), the one way every list in Shruti does it: A1's
// dragsort.js (window.A1Drag) with a 300 ms touch hold, a mouse taking a row
// by any part that is not a control, and no grip dots (Tony's rule,
// docs/theme-overhaul-plan.md §2). The keyboard moves a focused row with
// Alt + an arrow key instead of a grip.
//
// An order is each person's own, kept in their doc as a list of keys
// (order.<what>), never a rewrite of the shared thing it orders, so Tony's
// order never changes Veda's. Something new (a card, a set) that the saved
// order does not name yet keeps its own place after the ones it does.

import * as C from './core.js';

/** The saved keys at order.<path>, or []. */
export const get = (path) => {
  const v = C.me.get('order.' + path, null);
  return Array.isArray(v) ? v : [];
};
export const put = (path, keys) => C.me.set({ ['order.' + path]: keys }, { now: true });

/** items in the person's order. keyOf(item, i) gives each its key. */
export function arrange(items, keyOf, saved) {
  const keyed = items.map((it, i) => ({ it, k: keyOf(it, i), i }));
  if (!saved || !saved.length) return keyed.map((x) => x.it);
  const rank = new Map(saved.map((k, i) => [k, i]));
  const known = keyed.filter((x) => rank.has(x.k)).sort((a, b) => rank.get(a.k) - rank.get(b.k));
  const fresh = keyed.filter((x) => !rank.has(x.k));
  return known.concat(fresh).map((x) => x.it);
}
/** Unique keys for a list: a repeated key gets ~2, ~3 ... */
export function uniq(keys) {
  const seen = new Map();
  return keys.map((k) => { const n = (seen.get(k) || 0) + 1; seen.set(k, n); return n > 1 ? k + '~' + n : k; });
}
/** A short stable key for a piece of text (djb2 over its letters). */
export function hashKey(s) {
  let x = 5381;
  const t = String(s || '').toLowerCase().replace(/\W+/g, '');
  for (let i = 0; i < t.length; i++) x = ((x << 5) + x + t.charCodeAt(i)) >>> 0;
  return 'k' + x.toString(36);
}
export const move = (arr, from, to) => { const a = arr.slice(); a.splice(to, 0, a.splice(from, 1)[0]); return a; };

/**
 * Make a list reorderable. Its rows (direct children matching `row`) carry
 * data-dkey = their key.
 *   sortable(list, {row, axis, onMove(keys, from, to), canDrag, ignore})
 * onMove gets the keys in their new order (after the drop has landed): save
 * them and redraw. Alt+↑/↓ (Alt+←/→ on a row of tiles) on a focused row moves
 * it one place, and the focus stays on it after the redraw.
 */
export function sortable(list, o) {
  if (!list) return;
  const rows = () => Array.from(list.children).filter((n) => n.matches(o.row));
  const keys = () => rows().map((r) => r.dataset.dkey);
  const done = (ks, from, to, focusKey) => {
    const fire = () => {
      o.onMove(ks, from, to);
      if (focusKey) requestAnimationFrame(() => {
        const r = list.isConnected ? list : document;
        const el = r.querySelector('[data-dkey="' + (window.CSS && CSS.escape ? CSS.escape(focusKey) : focusKey) + '"]');
        if (el) (el.matches('button, [tabindex]') ? el : el.querySelector('button, [tabindex]') || el).focus();
      });
    };
    if (window.A1Drag) A1Drag.later(fire); else fire();
  };
  if (window.A1Drag) {
    // Only options that are set: an undefined canDrag would replace dragsort's default.
    const opt = { row: o.row, axis: o.axis || 'y', hold: 300, onDrop(from, to) { done(move(keys(), from, to), from, to); } };
    if (o.canDrag) opt.canDrag = o.canDrag;
    if (o.ignore) opt.ignore = o.ignore;
    A1Drag.sort(list, opt);
  }
  if (list._shrutiKeys) { list._shrutiKeys.o = o; return; }
  const me = { o };
  list._shrutiKeys = me;
  list.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const ax = me.o.axis || 'y';
    const dir = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0;
    if (!dir || (ax === 'y' && /Left|Right/.test(e.key)) || (ax === 'x' && /Up|Down/.test(e.key))) return;
    const r = e.target.closest(me.o.row);
    if (!r || r.parentElement !== list || (me.o.canDrag && !me.o.canDrag(r))) return;
    const ks = keys(), from = ks.indexOf(r.dataset.dkey), to = from + dir;
    if (from < 0 || to < 0 || to >= ks.length) return;
    e.preventDefault(); e.stopPropagation();
    done(move(ks, from, to), from, to, r.dataset.dkey);
  });
}
/** What a row says about moving it (its title): mouse, touch and keys. */
export const HINT = 'Drag to reorder (hold to pick up on a phone; Alt + arrow keys)';
