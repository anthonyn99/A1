/* ============================================================================
 * StudyOS — lesson bookmarks
 * ============================================================================
 * A bookmark is a step of a lesson, or a passage selected in one. Steps have
 * no ids (a step is its index, and Rewrite/Upgrade replaces them), so each
 * bookmark keeps a snapshot — heading, type, page — to find its step again
 * and to show something readable even when the step is gone.
 *
 *   topic.bookmarks = [{ id, block, heading, type, page, text, at }]
 *     block  the step index when it was saved
 *     text   the passage, or '' for the whole step
 *
 * Saved on the topic (breakdown.setBookmarks), so it syncs with the topic.
 * Pure: no DOM, no storage — tested by scripts/test-bookmarks.mjs.
 * ------------------------------------------------------------------------- */

export const MAX_PER_TOPIC = 200;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
export const headingOf = (b) => (b && (b.heading || b.title)) || '';
export const typeOf = (b) => (b && (b.type || b.kind)) || '';

/** A new bookmark for step `block` (a v2 step or a v1 block). */
export function make(block, step, text = '') {
  return {
    id: Math.random().toString(36).slice(2, 10),
    block,
    heading: String(headingOf(step)).slice(0, 200),
    type: typeOf(step),
    page: (step && step.page) || 0,
    text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    at: Date.now(),
  };
}

/** The whole-step bookmark on step `block`, if any. */
export const stepMark = (list, block) => (list || []).find((b) => b.block === block && !b.text) || null;

/** The list with a whole-step bookmark on `block` added or removed. */
export function toggleStep(list, block, step) {
  const cur = list || [];
  const on = stepMark(cur, block);
  return on ? cur.filter((b) => b !== on) : add(cur, make(block, step));
}

/** The list with `bm` added (a passage already saved on that step is not repeated). */
export function add(list, bm) {
  const cur = (list || []).filter((b) => !(b.block === bm.block && norm(b.text) === norm(bm.text)));
  return [...cur, bm].slice(-MAX_PER_TOPIC);
}

export const remove = (list, id) => (list || []).filter((b) => b.id !== id);

/**
 * The step a bookmark points at now: its saved index if that step still has
 * its heading, else the nearest step with that heading, else the figure of
 * its page, else its index clamped to the lesson.
 */
export function findStep(blocks, bm) {
  const n = (blocks || []).length;
  if (!n || !bm) return 0;
  const want = norm(bm.heading);
  const at = Number.isInteger(bm.block) ? bm.block : 0;
  if (want) {
    if (at >= 0 && at < n && norm(headingOf(blocks[at])) === want) return at;
    let best = -1;
    blocks.forEach((b, k) => { if (norm(headingOf(b)) === want && (best < 0 || Math.abs(k - at) < Math.abs(best - at))) best = k; });
    if (best >= 0) return best;
  }
  if (bm.page) {
    const k = blocks.findIndex((b) => typeOf(b) === 'figure' && b.page === bm.page);
    if (k >= 0) return k;
  }
  return Math.max(0, Math.min(n - 1, at));
}
