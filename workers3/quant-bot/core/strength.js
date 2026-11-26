// COPY of A1-Priv TradeHub/core/strength.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Relative strength against a benchmark, and sector rotation. Pure; `c` and
// `bench` are closes of the same days, oldest first, the same length.
import { sma } from './indicators.js';

/** Relative strength over `n` bars: `(c_t/c_{t−n}) / (b_t/b_{t−n}) − 1`. */
export function relStrength(c, bench, n) {
  return c.map((x, i) => (i < n || !c[i - n] || !bench[i - n] || !bench[i] ? null : (x / c[i - n]) / (bench[i] / bench[i - n]) - 1));
}

/** The relative-strength line: `c_t / b_t`. */
export function rsLine(c, bench) {
  return c.map((x, i) => (bench[i] ? x / bench[i] : null));
}

/** Rank of each symbol's `n`-bar return among the set, 0 to 100:
 *  `100 · (symbols with a lower return) / (symbols − 1)`. `map`: symbol →
 *  closes. A symbol with too little history is left out (null). */
export function rsRank(map, n) {
  const ret = {};
  for (const s of Object.keys(map)) {
    const c = map[s], i = c.length - 1;
    ret[s] = i >= n && c[i - n] ? c[i] / c[i - n] - 1 : null;
  }
  const have = Object.keys(ret).filter((s) => ret[s] != null), out = {};
  for (const s of Object.keys(ret)) {
    if (ret[s] == null) { out[s] = null; continue; }
    let below = 0;
    for (const o of have) if (ret[o] < ret[s]) below++;
    out[s] = have.length > 1 ? 100 * below / (have.length - 1) : 50;
  }
  return out;
}

export const LEADING = 'Leading', WEAKENING = 'Weakening', LAGGING = 'Lagging', IMPROVING = 'Improving';

/** Rotation, as on a relative rotation graph → `{ ratio, momentum, quadrant }`
 *  (three series). `rs = 100·c/b`; `ratio = 100·rs/SMA(rs, n)`;
 *  `momentum = 100·ratio/SMA(ratio, n)`; both centre on 100. Quadrant: ratio
 *  and momentum ≥ 100 Leading; ratio ≥ 100 only Weakening; neither Lagging;
 *  momentum ≥ 100 only Improving. */
export function rotation(c, bench, n = 10) {
  const rs = rsLine(c, bench).map((x) => (x == null ? null : 100 * x));
  const a = sma(rs, n), ratio = rs.map((x, i) => (a[i] ? 100 * x / a[i] : null));
  const b = sma(ratio, n), momentum = ratio.map((x, i) => (b[i] ? 100 * x / b[i] : null));
  const quadrant = momentum.map((m, i) => (m == null ? null
    : ratio[i] >= 100 ? (m >= 100 ? LEADING : WEAKENING) : (m >= 100 ? IMPROVING : LAGGING)));
  return { ratio, momentum, quadrant };
}
