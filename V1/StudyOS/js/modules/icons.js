/* ============================================================================
 * StudyOS — icons for the feature modules
 * ============================================================================
 * The modules draw StudyOS's one icon set (SOI, js/studyos.js) instead of
 * glyphs like ✓ ✕ ★ ↶ (Tony, 2026-10-29: SVG icons, never emoji or symbols).
 * SOI is a global of the classic script; under Node (the module tests) there
 * is none, and ic() returns '' so markup stays valid.
 * ------------------------------------------------------------------------- */

export function ic(name) {
  const set = typeof window !== 'undefined' && window.SOI;
  return (set && set[name]) || '';
}

export default { ic };
