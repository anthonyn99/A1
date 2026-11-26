// COPY of A1-Priv TradeHub/core/detect-swing.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Swing setups on daily bars (docs/TradeHub/quant/phase-05.md). Pure, and no
// lookahead: what a detector says about bar i reads nothing after bar i.
//
// detectSwing(ctx) → Candidate[] for the daily bar ctx.i (a CLOSED bar):
//   ctx = { symbol, bars: { '1d': Bar[] }, i, rs, earnings, levelsAt }
//   rs        { rank3m }: the 3-month return's rank (0 to 100) among the
//             snapshot's stocks; a number, or a function of i. Unknown = no rs-leader.
//   earnings  a Set of 'YYYY-MM-DD' report dates for this symbol (Catalysts);
//             unknown = no earnings-drift.
//   levelsAt  (j) → core/levels.js levels() as of bar j; by default worked
//             out here from the daily bars up to j (and their weekly vote).
// Candidate = { setup, horizon: 'swing', dir, at, trigger, structure: { invalid, ref }, notes }.
import { sma, atr } from './indicators.js';
import { nyClock } from './clock.js';
import { levels } from './levels.js';
import { toWeekly } from './weekly.js';

export const BASE_BARS = 15, BASE_MAX = 0.12, BASE_VOL = 1.5, VOL_AVG = 50;
export const PULL_ATR = 0.5, PULL_BARS = 3, SLOPE_BARS = 5;
export const RS_MIN = 85, HIGH_BARS = 20;
export const GAP_MIN = 0.04, DRIFT_BARS = 10, HOLD_ATR = 0.25;
export const RECLAIM_BARS = 3;
export const SWING_SETUPS = ['base-breakout', 'ma-pullback', 'rs-leader', 'earnings-drift', 'failed-breakdown'];
// A setup does not fire again this many bars after it fired.
const QUIET = { 'base-breakout': 10, 'ma-pullback': PULL_BARS, 'rs-leader': 5, 'earnings-drift': DRIFT_BARS, 'failed-breakdown': RECLAIM_BARS };

const prepCache = new WeakMap();
/** Drop the cached series of `bars` (core/backtest.js after each symbol: a prep holds the levels
 *  as of every bar, ~19 MB a symbol, and the weekly run held 113 of them until the heap ran out). */
export const forgetPrepSwing = (bars) => { if (bars) prepCache.delete(bars); };
/** Tests only: is a prep of `bars` cached? */
export const _hasPrepSwing = (bars) => prepCache.has(bars);
/** The series the detectors read, once per run of daily bars (cached). */
export function prepSwing(bars) {
  let p = prepCache.get(bars);
  if (p) return p;
  const c = bars.map((b) => b.c), v = bars.map((b) => b.v);
  p = {
    bars, c,
    atr: atr(bars, 14), sma20: sma(c, 20), sma50: sma(c, 50), vAvg: sma(v, VOL_AVG),
    date: bars.map((b) => nyClock(b.t + 12 * 3_600_000).date),
    levels: new Map(), memo: new Map(),
  };
  prepCache.set(bars, p);
  return p;
}
/** Levels as of daily bar j, from the bars up to it (and their weekly vote). */
export function levelsAsOf(p, j) {
  if (j < 0) return null;
  if (!p.levels.has(j)) { const hist = p.bars.slice(0, j + 1); p.levels.set(j, levels({ daily: hist, weekly: toWeekly(hist) })); }
  return p.levels.get(j);
}

const topThird = (b) => b.h > b.l && (b.c - b.l) / (b.h - b.l) >= 2 / 3;
const cand = (p, i, setup, dir, invalid, ref, notes) => ({
  setup, horizon: 'swing', dir, at: p.bars[i].t, trigger: p.bars[i].c, structure: { invalid, ref }, notes,
});
const minLow = (b, from, to) => { let m = Infinity; for (let j = Math.max(0, from); j <= to; j++) m = Math.min(m, b[j].l); return m; };
const maxHigh = (b, from, to) => { let m = -Infinity; for (let j = Math.max(0, from); j <= to; j++) m = Math.max(m, b[j].h); return m; };

const DET = {
  'base-breakout'(p, i) {
    if (i < BASE_BARS || p.vAvg[i - 1] == null) return null;
    const b = p.bars, hi = maxHigh(b, i - BASE_BARS, i - 1), lo = minLow(b, i - BASE_BARS, i - 1);
    const width = (hi - lo) / b[i - 1].c, vr = b[i].v / p.vAvg[i - 1];
    if (!(width <= BASE_MAX && b[i].c > hi && vr >= BASE_VOL)) return null;
    return cand(p, i, 'base-breakout', 'long', lo, hi, [`broke a ${BASE_BARS}-day base ${(width * 100).toFixed(1)}% wide on ${vr.toFixed(1)}× volume`]);
  },
  'ma-pullback'(p, i) {
    const b = p.bars, s50 = p.sma50;
    if (i < PULL_BARS + 1 || s50[i] == null || s50[i - SLOPE_BARS] == null || p.atr[i] == null) return null;
    if (!(b[i].c > s50[i] && s50[i] > s50[i - SLOPE_BARS] && b[i].c > b[i - 1].h)) return null;
    let touched = null;
    for (let j = i - PULL_BARS; j < i && !touched; j++) {
      for (const [name, ma] of [['20-day', p.sma20[j]], ['50-day', s50[j]]]) {
        if (ma != null && (Math.abs(b[j].l - ma) <= PULL_ATR * p.atr[i] || (b[j].l <= ma && b[j].h >= ma))) { touched = { name, ma }; break; }
      }
    }
    if (!touched) return null;
    return cand(p, i, 'ma-pullback', 'long', minLow(b, i - PULL_BARS, i), touched.ma, [`pulled back to the ${touched.name} average in an uptrend, then closed above the day before's high`]);
  },
  'rs-leader'(p, i, ctx) {
    const rs = ctx.rs && (typeof ctx.rs.rank3m === 'function' ? ctx.rs.rank3m(i) : ctx.rs.rank3m);
    if (!(rs >= RS_MIN) || i < HIGH_BARS) return null;
    const b = p.bars, hi = maxHigh(b, i - HIGH_BARS, i - 1);
    if (!(b[i].c > hi)) return null;
    return cand(p, i, 'rs-leader', 'long', minLow(b, i - 4, i), hi, [`3-month strength rank ${Math.round(rs)}, a new ${HIGH_BARS}-day closing high`]);
  },
  'earnings-drift'(p, i, ctx) {
    const er = ctx.earnings;
    if (!er || !er.size || p.atr[i] == null) return null;
    const b = p.bars;
    // The latest earnings gap in the last DRIFT_BARS sessions.
    for (let g = i - 1; g >= Math.max(1, i - DRIFT_BARS); g--) {
      const gap = b[g].o / b[g - 1].c - 1;
      // Reported before the open that day, or after the close the session before.
      if (!(gap >= GAP_MIN && topThird(b[g]) && (er.has(p.date[g]) || er.has(p.date[g - 1])))) continue;
      const low = b[g].l;
      for (let j = g + 1; j < i; j++) {
        if (b[j].c < low) return null;                                     // the gap failed
        if (b[j].l <= low + HOLD_ATR * p.atr[j]) return null;              // it already held once
      }
      if (b[i].l <= low + HOLD_ATR * p.atr[i] && b[i].c > low) {
        return cand(p, i, 'earnings-drift', 'long', Math.min(b[i].l, low), low, [`earnings gap of ${(gap * 100).toFixed(1)}% on ${p.date[g]} held its low ${low.toFixed(2)}`]);
      }
      return null;
    }
    return null;
  },
  'failed-breakdown'(p, i, ctx) {
    if (i < RECLAIM_BARS + 1) return null;
    const lv = ctx.levelsAt ? ctx.levelsAt(i - RECLAIM_BARS - 1) : levelsAsOf(p, i - RECLAIM_BARS - 1);
    if (!lv) return null;
    const b = p.bars;
    let best = null;
    for (const l of lv.supports) {
      if (l.rank !== 'Strong') continue;
      const lo = l.lo == null ? l.price : l.lo, hi = l.hi == null ? l.price : l.hi;
      if (!(b[i].c > hi)) continue;
      // A close below it in the last RECLAIM_BARS bars, none back above since, and above it before.
      let j0 = -1;
      for (let j = i - RECLAIM_BARS; j < i; j++) if (b[j].c < lo && (j0 < 0)) j0 = j;
      if (j0 < 0 || b[j0 - 1].c < lo) continue;
      let back = false;
      for (let j = j0 + 1; j < i; j++) if (b[j].c > hi) back = true;
      if (back) continue;
      if (!best || l.score > best.l.score) best = { l, j0 };
    }
    if (!best) return null;
    return cand(p, i, 'failed-breakdown', 'long', minLow(b, best.j0, i), best.l.price, [`lost Strong support ${best.l.price.toFixed(2)} and closed back above it`]);
  },
};

// One memo per (rs, earnings, levelsAt): those feed some detectors.
const NONE = {};
function memoFor(p, ctx) {
  let m = p.memo;
  for (const k of [ctx.rs || NONE, ctx.earnings || NONE, ctx.levelsAt || NONE]) {
    if (!m.has(k)) m.set(k, new Map());
    m = m.get(k);
  }
  return m;
}
function raw(p, setup, i, ctx, m) {
  const key = setup + ':' + i;
  if (m.has(key)) return m.get(key);
  const r = DET[setup](p, i, ctx) || null;
  m.set(key, r);
  return r;
}

/** Swing candidates for daily bar `ctx.i`. A setup that fired in the bars
 *  just before (QUIET) does not fire again. */
export function detectSwing(ctx) {
  const bars = ctx.bars && ctx.bars['1d'];
  if (!bars || !bars.length || ctx.i == null || ctx.i < 1 || ctx.i >= bars.length) return [];
  const p = prepSwing(bars), out = [], m = memoFor(p, ctx);
  for (const setup of SWING_SETUPS) {
    const c = raw(p, setup, ctx.i, ctx, m);
    if (!c) continue;
    let again = false;
    for (let j = Math.max(1, ctx.i - QUIET[setup]); j < ctx.i && !again; j++) if (raw(p, setup, j, ctx, m)) again = true;
    if (!again) out.push(c);
  }
  return out;
}
