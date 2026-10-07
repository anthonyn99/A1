/* ============================================================================
 * StudyOS — flashcard settings
 * ============================================================================
 * Per device, in localStorage, like the AI settings (studyos_ai_v1). What
 * must agree ACROSS devices — how many new cards were introduced today — is
 * derived from the cards themselves (card.introducedAt), which sync, so the
 * phone and the laptop never each hand out a full day's quota.
 * ------------------------------------------------------------------------- */

const KEY = 'studyos_cards_settings_v1';

export const DEFAULTS = Object.freeze({
  newPerDay: 15,          // Mochi recommends a handful; 15 keeps a semester moving
  reviewsPerDay: 200,
  retention: 0.9,         // FSRS target retention
  advancedGrading: false, // 4 buttons (Again/Hard/Good/Easy) instead of Forgot/Remembered
  onlyReadLessons: true,  // only introduce breakdown cards from lessons she has opened
});

const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

export function cardSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { s = null; }
  if (!s || typeof s !== 'object') return { ...DEFAULTS };
  return {
    newPerDay: Math.round(clamp(s.newPerDay, 0, 500, DEFAULTS.newPerDay)),
    reviewsPerDay: Math.round(clamp(s.reviewsPerDay, 10, 5000, DEFAULTS.reviewsPerDay)),
    retention: clamp(s.retention, 0.7, 0.98, DEFAULTS.retention),
    advancedGrading: typeof s.advancedGrading === 'boolean' ? s.advancedGrading : DEFAULTS.advancedGrading,
    onlyReadLessons: typeof s.onlyReadLessons === 'boolean' ? s.onlyReadLessons : DEFAULTS.onlyReadLessons,
  };
}

export function saveCardSettings(next) {
  const clean = { ...cardSettings(), ...(next || {}) };
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch (e) { return { ok: false }; }
  try { window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity: 'cards' } })); } catch (e) {}
  return { ok: true, value: cardSettings() };
}

export default { DEFAULTS, cardSettings, saveCardSettings };
