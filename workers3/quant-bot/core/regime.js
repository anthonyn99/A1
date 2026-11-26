// COPY of A1-Priv TradeHub/core/regime.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// The market regime: one label and a 0 to 100 score from trend, breadth,
// volatility and credit. Pure.
//
// Inputs: `index` = daily bars of the index (SPY), oldest first.
// `breadth` = `{ above50, mcclellan }`: the share (0 to 1) of members above
// their 50-day average, and the McClellan oscillator (breadth.js). `vix` =
// VIX closes (or bars). `credit` = the high-yield spread in percentage points
// (FRED BAMLH0A0HYM2). Every list after `index` is lined up on its END: its
// last value belongs to the index's last bar, and it may be shorter. A part
// with no data scores a neutral 50 and is named in `missing`.
import { sma, percentRank } from './indicators.js';

// Phase 6 may retune these walk-forward; a change is recorded in quant-plan.md §0.
export const WEIGHTS = { trend: 0.40, breadth: 0.30, vol: 0.20, credit: 0.10 };
export const LABELS = [[65, 'Risk-on uptrend'], [50, 'Constructive'], [35, 'Choppy'], [20, 'Risk-off'], [-Infinity, 'Capitulation']];
export const SLOPE_BARS = 10, SLOPE_FULL = 0.02;       // the 50-day's move over 10 bars: −2% → 0, +2% → full marks
export const VIX_CALM = 12, VIX_PANIC = 40;            // VIX level: 12 → 100, 40 → 0
export const CREDIT_BARS = 20, CREDIT_FULL = 0.5;      // the spread's 20-day change: −0.5 pt → 100, +0.5 pt → 0

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
/** The label for a score: ≥65 Risk-on uptrend, ≥50 Constructive, ≥35 Choppy, ≥20 Risk-off, else Capitulation. */
export const labelOf = (score) => (Number.isFinite(score) ? LABELS.find(([min]) => score >= min)[1] : null);

/** The regime at every bar → `{ score, label, parts: { trend, breadth, vol, credit }, missing }`.
 *  `trend = 35·[c > SMA200] + 35·[c > SMA50] + 30·clamp((slope + 2%)/4%)`, slope = `SMA50_t/SMA50_{t−10} − 1`.
 *  `breadth = 70·above50 + 30·[McClellan > 0]` (15 at zero or unknown).
 *  `vol = 0.6·clamp((40 − VIX)/28)·100 + 0.4·(1 − 20-day percent rank of VIX)·100`.
 *  `credit = clamp(50 − 100·(spread_t − spread_{t−20}))`.
 *  `score = 0.40·trend + 0.30·breadth + 0.20·vol + 0.10·credit`; null until the index has 200 bars. */
export function regimeSeries({ index, breadth, vix, credit } = {}) {
  const N = index ? index.length : 0, c = (index || []).map((b) => b.c);
  const ma50 = sma(c, 50), ma200 = sma(c, 200);
  // A list lined up on its end: the value for index bar i, or null (a gap in the data, a NaN, is null too).
  const lined = (list) => (list && list.length ? (i) => { let v = list[i - (N - list.length)]; if (v != null && typeof v === 'object') v = v.c; return Number.isFinite(v) ? v : null; } : null);
  const above = lined(breadth && breadth.above50), osc = lined(breadth && breadth.mcclellan), cr = lined(credit);
  const vx = lined(vix), vixList = vx ? Array.from({ length: N }, (_, i) => vx(i)) : null;
  const vixRank = vixList ? percentRank(vixList, 20) : null;
  const missing = [];
  if (!above) missing.push('breadth');
  if (!vx) missing.push('vol');
  if (!cr) missing.push('credit');

  const parts = { trend: [], breadth: [], vol: [], credit: [] }, score = [], label = [];
  for (let i = 0; i < N; i++) {
    const back = ma50[i - SLOPE_BARS];
    if (ma200[i] == null || back == null) {
      for (const k of Object.keys(parts)) parts[k].push(null);
      score.push(null); label.push(null);
      continue;
    }
    const slope = ma50[i] / back - 1;
    const trend = (c[i] > ma200[i] ? 35 : 0) + (c[i] > ma50[i] ? 35 : 0) + 30 * clamp((slope + SLOPE_FULL) / (2 * SLOPE_FULL), 0, 1);

    let br = 50;
    const a = above ? above(i) : null;
    if (a != null) { const o = osc ? osc(i) : null; br = 70 * clamp(a, 0, 1) + (o == null || o === 0 ? 15 : o > 0 ? 30 : 0); }

    let vol = 50;
    const v = vx ? vx(i) : null;
    if (v != null) {
      const level = 100 * clamp((VIX_PANIC - v) / (VIX_PANIC - VIX_CALM), 0, 1), rank = vixRank[i];
      vol = rank == null ? level : 0.6 * level + 0.4 * (1 - rank) * 100;
    }

    let cred = 50;
    const now = cr ? cr(i) : null, then = cr ? cr(i - CREDIT_BARS) : null;
    if (now != null && then != null) cred = clamp(50 - 50 * (now - then) / CREDIT_FULL, 0, 100);

    const s = WEIGHTS.trend * trend + WEIGHTS.breadth * br + WEIGHTS.vol * vol + WEIGHTS.credit * cred;
    parts.trend.push(trend); parts.breadth.push(br); parts.vol.push(vol); parts.credit.push(cred);
    score.push(s); label.push(labelOf(s));
  }
  return { score, label, parts, missing };
}

/** The regime now → `{ label, score, parts: { trend, breadth, vol, credit }, since, missing }`;
 *  `since` = how many bars the label has held (1 = it changed today). */
export function regime(input) {
  const r = regimeSeries(input), i = r.score.length - 1;
  if (i < 0 || r.score[i] == null) return { label: null, score: null, parts: { trend: null, breadth: null, vol: null, credit: null }, since: 0, missing: r.missing };
  let since = 1;
  while (i - since >= 0 && r.label[i - since] === r.label[i]) since++;
  return {
    label: r.label[i], score: r.score[i],
    parts: { trend: r.parts.trend[i], breadth: r.parts.breadth[i], vol: r.parts.vol[i], credit: r.parts.credit[i] },
    since, missing: r.missing,
  };
}
