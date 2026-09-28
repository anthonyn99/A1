/* ============================================================================
 * StudyOS — schema versions  (DATA_MODEL.md §6)
 * ============================================================================
 * Every document written by the engagement-upgrade stores (quiz, progress)
 * carries `v`. upgrade() brings an older document up to the current shape on
 * READ, so data written by an old build — on a device that has not reloaded
 * yet — is converted rather than dropped.
 *
 * Adding a version: bump CURRENT[kind] and add a step to STEPS[kind] that
 * turns version N into N+1. Steps must be pure and must never delete a record
 * they do not understand; an unknown field is carried along untouched.
 *
 * The pre-existing stores (classes/events/tasks, cards, sessions) are NOT
 * routed through here: they predate versioning and their shapes are pinned by
 * their own tests. A document with no `v` at all is treated as version 1.
 * ------------------------------------------------------------------------- */

export const CURRENT = { quiz: 1, progress: 1 };

const STEPS = {
  quiz: {},
  progress: {},
};

export function upgrade(kind, doc) {
  if (!doc || typeof doc !== 'object') return doc;
  // A bare array is how a list would have been stored before `v` existed.
  let d = Array.isArray(doc) ? { v: 1, items: doc } : { ...doc };
  let v = Number(d.v) || 1;
  const target = CURRENT[kind] || 1;
  const steps = STEPS[kind] || {};
  while (v < target) {
    const step = steps[v];
    if (!step) break;           // missing step: keep what we have, never drop it
    d = step(d);
    v += 1;
    d.v = v;
  }
  return d;
}

export default { upgrade, CURRENT };
