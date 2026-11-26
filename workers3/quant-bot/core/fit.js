// COPY of A1-Priv TradeHub/core/fit.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Walk-forward fitting and the calibration table (docs/TradeHub/quant/phase-06.md).
// Pure; every random draw comes from a seeded generator, so a run is repeatable.
//
// From the backtester's trades:
//   - six folds by time; fold k is tested on a model fitted on folds < k only,
//     with training trades still open when fold k begins left out (purged), so
//     no test bar is ever in its own training set;
//   - per setup, a logistic regression of "hit T1 before the stop" on the eight
//     factors, L2-regularised (λ = 1), by plain gradient descent; a factor's
//     fitted weight is used only when its sign agrees in ≥ 5 of the 6 fits
//     (folds 1 to 5, plus all the folds), otherwise Phase 5's default stands;
//   - per setup and regime bucket, from the OUT-OF-SAMPLE trades only (folds 1
//     to 5): n, hit rate, average win and loss in R, EV, max drawdown in R,
//     median bars held, a bootstrap 95% interval on the mean R (1,000
//     resamples) and whether it is an edge after a Benjamini-Hochberg
//     correction at 10% across the setups tested.
import { FACTORS, WEIGHTS, SHRINK_K, bucketOf, BUCKETS, capWeights } from './score.js';
import { factorRow } from './backtest.js';

export const FOLDS = 6, LAMBDA = 1, RESAMPLES = 1000, FDR = 0.10, STABLE = 5, MIN_FIT = 30, CURVE_POINTS = 60;
export const CAL_V = 1;

/** A seeded uniform generator in [0, 1) (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fold of each trade (0 to k−1) by its signal time: equal counts, and trades
 *  of the same moment always in the same fold → `{ fold: Int8Array, starts }`
 *  (`starts[f]` = the first signal time in fold f). */
export function foldsOf(trades, k = FOLDS) {
  const n = trades.length, order = trades.map((t, i) => i).sort((a, b) => trades[a].at - trades[b].at);
  const starts = [];
  for (let f = 0; f < k; f++) { const i = order[Math.floor(f * n / k)]; starts.push(i == null ? Infinity : trades[i].at); }
  for (let f = 1; f < k; f++) if (starts[f] < starts[f - 1]) starts[f] = starts[f - 1];
  const fold = new Int8Array(n);
  for (let i = 0; i < n; i++) { let f = 0; while (f + 1 < k && trades[i].at >= starts[f + 1]) f++; fold[i] = f; }
  return { fold, starts };
}

/** The training rows for test fold `k`: folds before it, minus any trade not
 *  finished before fold k's first signal (purged). */
export function trainFor(trades, folds, k) {
  const start = folds.starts[k], out = [];
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (folds.fold[i] < k && t.exitT != null && t.exitT < start) out.push(t);
  }
  return out;
}

/** Logistic regression by gradient descent → `{ w, b }`. Minimises
 *  `(1/n)·Σ logloss + (λ/2n)·‖w‖²` over centred inputs (x − 0.5). */
export function logistic(X, y, { lambda = LAMBDA, iters = 600, lr = 1 } = {}) {
  const n = X.length, d = n ? X[0].length : 0, w = new Float64Array(d);
  let b = 0;
  if (!n) return { w: Array.from(w), b };
  const g = new Float64Array(d);
  for (let it = 0; it < iters; it++) {
    g.fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const x = X[i];
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * (x[j] - 0.5);
      const e = 1 / (1 + Math.exp(-z)) - y[i];
      gb += e;
      for (let j = 0; j < d; j++) g[j] += e * (x[j] - 0.5);
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] + lambda * w[j]) / n;
    b -= lr * gb / n;
  }
  return { w: Array.from(w), b };
}

const isWin = (t) => t.status === 'target1' || t.status === 'target2';

/** Fitted factor weights for one setup's trades → `{ weights, fits, stable }`.
 *  `stable[k]` = +1 / −1 when the sign agrees in ≥ 5 fits, else 0. A stable
 *  positive factor's weight follows its coefficient, a stable negative one
 *  drops to 0, and the stable factors share what their defaults shared, so the
 *  weights still sum to 1. `weights` is null when nothing was stable. */
export function fitWeights(trades, folds, opts = {}) {
  const fits = [];
  const fitOn = (rows) => (rows.length >= MIN_FIT && rows.some(isWin) && !rows.every(isWin) ? logistic(rows.map(factorRow), rows.map((t) => (isWin(t) ? 1 : 0)), opts).w : null);
  for (let k = 1; k < FOLDS; k++) { const f = fitOn(trainFor(trades, folds, k)); if (f) fits.push(f); }
  const all = fitOn(trades.filter((t) => t.done));
  if (all) fits.push(all);
  const stable = {};
  FACTORS.forEach((k, j) => {
    const pos = fits.filter((f) => f[j] > 0).length, neg = fits.filter((f) => f[j] < 0).length;
    stable[k] = pos >= STABLE ? 1 : neg >= STABLE ? -1 : 0;
  });
  const keys = FACTORS.filter((k) => stable[k] !== 0);
  if (!keys.length || !all) return { weights: null, fits, stable };
  const share = keys.reduce((s, k) => s + WEIGHTS[k], 0);
  const mag = keys.map((k) => (stable[k] > 0 ? Math.max(0, all[FACTORS.indexOf(k)]) : 0)), sum = mag.reduce((a, b) => a + b, 0);
  const weights = { ...WEIGHTS };
  keys.forEach((k, i) => { weights[k] = sum > 0 ? share * mag[i] / sum : WEIGHTS[k]; });
  return { weights: capWeights(weights), fits, stable };
}

/** Bootstrap of a mean → `{ lo, hi, p }`: the 2.5th and 97.5th percentiles of
 *  `resamples` resampled means, and a two-sided p-value for "the mean is 0"
 *  (twice the share of resampled means on the other side of 0, at least 1/(B+1)). */
export function bootstrapMean(xs, { resamples = RESAMPLES, random = rng(1) } = {}) {
  const n = xs.length;
  if (!n) return { lo: null, hi: null, p: 1 };
  const means = new Float64Array(resamples);
  const sum0 = xs.reduce((a, b) => a + b, 0);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[(random() * n) | 0];
    means[r] = s / n;
  }
  means.sort();
  const q = (f) => means[Math.min(resamples - 1, Math.max(0, Math.round(f * (resamples - 1))))];
  let other = 0;
  for (const m of means) if (sum0 >= 0 ? m <= 0 : m >= 0) other++;
  return { lo: q(0.025), hi: q(0.975), p: Math.min(1, Math.max(1 / (resamples + 1), 2 * other / resamples)) };
}

/** Benjamini-Hochberg at false-discovery rate `q` → which p-values pass. */
export function bh(pvals, q = FDR) {
  const m = pvals.length, order = pvals.map((p, i) => i).sort((a, b) => pvals[a] - pvals[b]);
  let kMax = -1;
  order.forEach((i, r) => { if (pvals[i] <= (r + 1) / m * q) kMax = r; });
  const pass = new Array(m).fill(false);
  for (let r = 0; r <= kMax; r++) pass[order[r]] = true;
  return pass;
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** One cell's numbers from its trades (net R) → `{ n, wins, hitRate, p,
 *  avgWinR, avgLossR, ev, meanR, maxDDR, medianBars, ci, pValue, small }`.
 *  `p = (wins + 20·p₀)/(n + 20)`, `ev = p·avgWin − (1−p)·avgLoss`. */
export function cellStats(list, { p0 = null, random, resamples = RESAMPLES, curve = false } = {}) {
  const rs = list.map((t) => t.r), n = rs.length;
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
  const hitRate = n ? wins.length / n : null, prior = p0 == null ? hitRate : p0;
  const p = n ? (wins.length + SHRINK_K * prior) / (n + SHRINK_K) : null;
  const avgWinR = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLossR = losses.length ? -losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  let cum = 0, peak = 0, dd = 0;
  const byExit = [...list].sort((a, b) => (a.exitT || a.at) - (b.exitT || b.at)), pts = [];
  for (const t of byExit) { cum += t.r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); if (curve) pts.push([t.exitT || t.at, cum]); }
  const b = bootstrapMean(rs, { random, resamples });
  const out = {
    n, wins: wins.length, hitRate, p, avgWinR, avgLossR,
    ev: n ? p * avgWinR - (1 - p) * avgLossR : null, meanR: n ? rs.reduce((a, c) => a + c, 0) / n : null,
    maxDDR: dd, medianBars: median(list.map((t) => t.bars).filter(Number.isFinite)),
    ci: [b.lo, b.hi], pValue: b.p, small: n < 30, significant: false,
  };
  if (curve) { const step = Math.max(1, Math.ceil(pts.length / CURVE_POINTS)); out.curve = pts.filter((x, i) => i % step === 0 || i === pts.length - 1); }
  return out;
}

/**
 * The calibration table from the backtester's trades →
 * `{ v, fittedAt, span: { from, to }, folds, n, setups: { setup: { all, on,
 *   neutral, off } }, weights: { setup: {...} }, stable: { setup: {...} } }`.
 * Each cell is cellStats over that setup's out-of-sample trades in that regime
 * bucket; `significant` = passes Benjamini-Hochberg at 10% (setups as one
 * family, regime cells as another), its interval excludes zero and its mean
 * is above zero. `now` stamps fittedAt.
 */
export function calibrate(trades, { now = Date.now(), seed = 1, resamples = RESAMPLES, q = FDR } = {}) {
  const done = trades.filter((t) => t.done && Number.isFinite(t.r));
  const random = rng(seed);
  const folds = foldsOf(done);
  const bySetup = new Map();
  done.forEach((t, i) => { if (!bySetup.has(t.setup)) bySetup.set(t.setup, []); bySetup.get(t.setup).push({ t, i }); });
  const setups = {}, weights = {}, stable = {}, allCells = [], bucketCells = [];
  for (const [setup, items] of [...bySetup].sort((a, b) => a[0].localeCompare(b[0]))) {
    const own = items.map((x) => x.t), ownFolds = foldsOf(own);
    const fw = fitWeights(own, ownFolds);
    if (fw.weights) weights[setup] = fw.weights;
    stable[setup] = fw.stable;
    const oos = items.filter((x) => folds.fold[x.i] >= 1).map((x) => x.t);
    const all = cellStats(oos, { random, resamples, curve: true });
    setups[setup] = { all };
    allCells.push(all);
    for (const b of BUCKETS) {
      const cell = cellStats(oos.filter((t) => bucketOf(t.regimeScore) === b), { p0: all.hitRate, random, resamples });
      setups[setup][b] = cell;
      if (cell.n) bucketCells.push(cell);
    }
  }
  for (const family of [allCells, bucketCells]) {
    const pass = bh(family.map((c) => c.pValue), q);
    family.forEach((c, i) => { c.significant = pass[i] && c.n > 0 && c.ci[0] > 0 && c.meanR > 0; });
  }
  const at = done.map((t) => t.at);
  return {
    v: CAL_V, fittedAt: now, span: { from: at.length ? Math.min(...at) : null, to: at.length ? Math.max(...at) : null },
    folds: folds.starts, n: done.length, oosFrom: folds.starts[1], setups, weights, stable,
  };
}
