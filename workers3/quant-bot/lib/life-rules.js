// Neo Cortex N5 lifecycle settings (A1-Priv docs/TradeHub/quant/n4-05.md "Rules"): defaults, ranges and the
// patch Tony's Control sends. No imports, so lib/state.js and lib/lifecycle.js can both read it.
export const LIFE_DEFAULTS = Object.freeze({
  shadowSessions: 1, maxLive: 6, matchMin: 90, trialMaxSessions: 20,
  keep: Object.freeze({ minTrades: 15, minSessions: 5, minWinRate: 50, minPF: 1.1 }),
  kill: Object.freeze({ wilsonUpper: 40, minTrades: 10, sleeveDD: 8, driftBand: 25, driftMinSignals: 10 }),
});
// [min, max, whole number?] for each setting Tony may change (N6's Control).
export const LIFE_RANGES = {
  shadowSessions: [1, 5, true], maxLive: [1, 6, true], matchMin: [50, 100, false], trialMaxSessions: [5, 60, true],
  'keep.minTrades': [5, 100, true], 'keep.minSessions': [1, 30, true], 'keep.minWinRate': [0, 100, false], 'keep.minPF': [0.5, 5, false],
  'kill.wilsonUpper': [0, 100, false], 'kill.minTrades': [5, 100, true], 'kill.sleeveDD': [1, 50, false],
  'kill.driftBand': [5, 100, false], 'kill.driftMinSignals': [3, 100, true],
};
/** Lifecycle settings with every default filled in. */
export function lifeSettings(stored = {}) {
  return { ...LIFE_DEFAULTS, ...stored, keep: { ...LIFE_DEFAULTS.keep, ...(stored.keep || {}) }, kill: { ...LIFE_DEFAULTS.kill, ...(stored.kill || {}) } };
}

/** A lifecycle patch → the merged settings, or throws with the reason. */
export function patchLife(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('lifecycle must be an object');
  const next = lifeSettings(current);
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'keep' || k === 'kill') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('lifecycle.' + k + ' must be an object');
      for (const [kk, vv] of Object.entries(v)) { check(k + '.' + kk, vv); next[k] = { ...next[k], [kk]: vv }; }
    } else { check(k, v); next[k] = v; }
  }
  return next;
}
function check(key, value) {
  const range = LIFE_RANGES[key];
  if (!range) throw new Error('unknown lifecycle setting: ' + key);
  const [lo, hi, whole] = range;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi || (whole && !Number.isInteger(value))) {
    throw new Error(`lifecycle.${key} must be ${whole ? 'a whole number ' : ''}from ${lo} to ${hi}`);
  }
}

