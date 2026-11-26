// COPY of A1-Priv TradeHub/core/detect-day.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Day setups on 5-minute bars (docs/TradeHub/quant/phase-05.md). Pure, and no
// lookahead: what a detector says about bar i reads nothing after bar i.
//
// detectDay(ctx) → Candidate[] for the bar being closed, ctx.i:
//   ctx = { symbol, bars: { '5m': Bar[] }, i, levels }
//   levels = core/levels.js levels() of the DAILY bars as of the session
//   before (so nothing of today leaks in): { supports, resistances, tol, atr }.
// Candidate = { setup, horizon: 'day', dir: 'long'|'short', at: bar time,
//   trigger: price, structure: { invalid, ref }, notes: [...] }.
//
// Regular session only (09:30 to the close, 13:00 on a half day), never in
// the first 5 minutes, and each setup fires at most once a session each way,
// so a choppy day cannot fill the ledger.
import { ema, rsi, atr, relVolumeIntraday } from './indicators.js';
import { nyDays, OPEN, CLOSE, HALF_CLOSE } from './clock.js';
import { nyseHalfDays } from './holidays.js';
import { pivots } from './pivots.js';

export const BAR_MS = 5 * 60_000;
export const ORB_BARS = 3, ORB_RVOL = 1.5;              // a 15-minute opening range; relative volume ≥ 1.5
export const RECLAIM_RUN = 6;                            // bars on the other side of VWAP first
export const SWEEP_ATR = 0.1;                            // a wick ≥ 0.1 daily ATR through the level
export const EXPAND_RANGE = 1.8, EXPAND_RVOL = 2, RANGE_BARS = 20;
export const PIVOT_W = 3;                                // a swing point = 3 bars each side
export const DAY_SETUPS = ['orb', 'vwap-reclaim', 'vwap-reject', 'ema-reclaim', 'sweep', 'level-reaction', 'vol-expansion', 'divergence'];

const halfCache = new Map();
const isHalf = (date) => {
  const y = Number(date.slice(0, 4));
  if (!halfCache.has(y)) halfCache.set(y, nyseHalfDays(y));
  return halfCache.get(y).has(date);
};
const topThird = (b) => b.h > b.l && (b.c - b.l) / (b.h - b.l) >= 2 / 3;
const bottomThird = (b) => b.h > b.l && (b.h - b.c) / (b.h - b.l) >= 2 / 3;
const edgeLo = (l) => (l.lo == null ? l.price : l.lo);
const edgeHi = (l) => (l.hi == null ? l.price : l.hi);

const prepCache = new WeakMap();
/** Drop the cached series of `bars` (core/backtest.js after each symbol; see detect-swing.js forgetPrepSwing). */
export const forgetPrepDay = (bars) => { if (bars) prepCache.delete(bars); };
/** Tests only: is a prep of `bars` cached? */
export const _hasPrepDay = (bars) => prepCache.has(bars);
/** Everything the detectors read, worked out once per run of bars: the
 *  regular-session bars and, over them, VWAP (from each open), EMA 9 and 20,
 *  RSI 14, ATR 14, intraday relative volume, each bar's session start, and the
 *  confirmed swing points. Every series is causal (value k reads bars ≤ k).
 *  Cached per bars array. */
export function prepDay(bars) {
  let p = prepCache.get(bars);
  if (p) return p;
  const { day, minute, dates } = nyDays(bars.map((b) => b.t));
  const reg = [], at = new Int32Array(bars.length).fill(-1);
  for (let i = 0; i < bars.length; i++) {
    const end = isHalf(dates[day[i]]) ? HALF_CLOSE : CLOSE;
    if (minute[i] >= OPEN && minute[i] + 5 <= end) { at[i] = reg.length; reg.push(i); }
  }
  const rb = reg.map((i) => bars[i]), rDay = reg.map((i) => day[i]), rMin = reg.map((i) => minute[i]);
  const start = new Int32Array(rb.length);
  for (let k = 0; k < rb.length; k++) start[k] = k > 0 && rDay[k] === rDay[k - 1] ? start[k - 1] : k;
  const c = rb.map((b) => b.c);
  p = {
    bars: rb, at, start, minute: rMin, day: rDay,
    vwap: new Array(rb.length).fill(null),
    ema9: ema(c, 9), ema20: ema(c, 20), rsi: rsi(c, 14), atr: atr(rb, 14),
    rvol: relVolumeIntraday(rb, 20, { floor: true }),   // BV: a partial bar's ratio is a floor (never a false surge)
    piv: pivots(rb, PIVOT_W, PIVOT_W),
    memo: new Map(),
  };
  for (let k = 0; k < rb.length; k++) if (Object.hasOwn(rb[k], 'closedRvol')) p.rvol[k] = rb[k].closedRvol;
  // VWAP starts again at each open (the regular bars carry no pre-market).
  {
    let pv = 0, vol = 0;
    for (let k = 0; k < rb.length; k++) {
      if (start[k] === k) { pv = 0; vol = 0; }
      const b = rb[k];
      pv += (b.h + b.l + b.c) / 3 * b.v; vol += b.v;
      p.vwap[k] = vol > 0 ? pv / vol : null;
    }
  }
  prepCache.set(bars, p);
  return p;
}

const cand = (p, k, setup, dir, invalid, ref, notes) => ({
  setup, horizon: 'day', dir, at: p.bars[k].t, trigger: p.bars[k].c, structure: { invalid, ref }, notes,
});

/* Each detector: (p, k, levels) → a candidate at regular bar k, or null.
   It may assume k is not the session's first bar. */
const DET = {
  orb(p, k) {
    const s = p.start[k], b = p.bars;
    if (p.minute[s] !== OPEN || k < s + ORB_BARS) return null;
    let hi = -Infinity, lo = Infinity;
    for (let j = s; j < s + ORB_BARS; j++) { hi = Math.max(hi, b[j].h); lo = Math.min(lo, b[j].l); }
    const rv = p.rvol[k];
    if (rv == null || rv < ORB_RVOL) return null;
    const mid = (hi + lo) / 2;
    if (b[k].c > hi) return cand(p, k, 'orb', 'long', mid, hi, [`closed above the opening range (${hi.toFixed(2)}) on ${rv.toFixed(1)}× volume`]);
    if (b[k].c < lo) return cand(p, k, 'orb', 'short', mid, lo, [`closed below the opening range (${lo.toFixed(2)}) on ${rv.toFixed(1)}× volume`]);
    return null;
  },
  'vwap-reclaim'(p, k) {
    if (k - RECLAIM_RUN < p.start[k] || p.vwap[k] == null) return null;
    for (let j = k - RECLAIM_RUN; j < k; j++) if (!(p.vwap[j] != null && p.bars[j].c < p.vwap[j])) return null;
    const b = p.bars[k];
    if (!(b.c > p.vwap[k] && topThird(b))) return null;
    return cand(p, k, 'vwap-reclaim', 'long', b.l, p.vwap[k], [`back above VWAP (${p.vwap[k].toFixed(2)}) after ${RECLAIM_RUN}+ bars below`]);
  },
  'vwap-reject'(p, k) {
    if (k - RECLAIM_RUN < p.start[k] || p.vwap[k] == null) return null;
    for (let j = k - RECLAIM_RUN; j < k; j++) if (!(p.vwap[j] != null && p.bars[j].c > p.vwap[j])) return null;
    const b = p.bars[k];
    if (!(b.c < p.vwap[k] && bottomThird(b))) return null;
    return cand(p, k, 'vwap-reject', 'short', b.h, p.vwap[k], [`back below VWAP (${p.vwap[k].toFixed(2)}) after ${RECLAIM_RUN}+ bars above`]);
  },
  'ema-reclaim'(p, k) {
    const e9 = p.ema9, e20 = p.ema20, b = p.bars;
    if (k - 1 < p.start[k] || [e9[k], e20[k], e9[k - 1], e20[k - 1]].some((x) => x == null)) return null;
    const above = (j) => b[j].c > e9[j] && b[j].c > e20[j];
    if (!(above(k) && !above(k - 1) && e20[k] > e20[k - 1])) return null;
    return cand(p, k, 'ema-reclaim', 'long', Math.min(b[k].l, e20[k]), e20[k], ['back above the 9 and 20 EMA, the 20 rising']);
  },
  sweep(p, k, lv) {
    if (!lv || !lv.atr || k - 1 < p.start[k]) return null;
    const w = p.bars[k - 1], b = p.bars[k], d = SWEEP_ATR * lv.atr;
    let best = null;
    for (const l of [...lv.supports, ...lv.resistances]) {
      if (l.rank === 'Weak') continue;
      const lo = edgeLo(l), hi = edgeHi(l);
      if (w.l <= lo - d && w.c > lo && b.c > w.c && b.c > lo) {
        if (!best || l.score > best.l.score) best = { l, dir: 'long', invalid: w.l };
      } else if (w.h >= hi + d && w.c < hi && b.c < w.c && b.c < hi) {
        if (!best || l.score > best.l.score) best = { l, dir: 'short', invalid: w.h };
      }
    }
    if (!best) return null;
    return cand(p, k, 'sweep', best.dir, best.invalid, best.l.price,
      [`swept ${best.l.rank} ${best.dir === 'long' ? 'support' : 'resistance'} ${best.l.price.toFixed(2)} and closed back ${best.dir === 'long' ? 'above' : 'below'}`]);
  },
  'level-reaction'(p, k, lv) {
    if (!lv || lv.tol == null) return null;
    const b = p.bars[k], tol = lv.tol, s = p.start[k];
    let best = null;
    for (const l of [...lv.supports, ...lv.resistances]) {
      if (l.rank !== 'Strong') continue;
      const lo = edgeLo(l), hi = edgeHi(l);
      const touches = (x) => x.l <= hi + tol && x.h >= lo - tol;
      if (!touches(b)) continue;
      let first = true;
      for (let j = s; j < k && first; j++) if (touches(p.bars[j])) first = false;
      if (!first) continue;
      if (b.c > hi && topThird(b) && b.l <= hi + tol) { if (!best || l.score > best.l.score) best = { l, dir: 'long', invalid: b.l }; }
      else if (b.c < lo && bottomThird(b) && b.h >= lo - tol) { if (!best || l.score > best.l.score) best = { l, dir: 'short', invalid: b.h }; }
    }
    if (!best) return null;
    return cand(p, k, 'level-reaction', best.dir, best.invalid, best.l.price,
      [`first touch of Strong ${best.dir === 'long' ? 'support' : 'resistance'} ${best.l.price.toFixed(2)} today, rejected`]);
  },
  'vol-expansion'(p, k) {
    if (k < RANGE_BARS) return null;
    const b = p.bars[k], rv = p.rvol[k];
    let sum = 0;
    for (let j = k - RANGE_BARS; j < k; j++) sum += p.bars[j].h - p.bars[j].l;
    const avg = sum / RANGE_BARS, rng = b.h - b.l;
    if (!(avg > 0 && rng >= EXPAND_RANGE * avg && rv != null && rv >= EXPAND_RVOL) || b.c === b.o) return null;
    const dir = b.c > b.o ? 'long' : 'short';
    return cand(p, k, 'vol-expansion', dir, dir === 'long' ? b.l : b.h, b.c, [`a ${(rng / avg).toFixed(1)}× range bar on ${rv.toFixed(1)}× volume`]);
  },
  divergence(p, k) {
    // A swing point that becomes known at bar k, against the one before it.
    const known = p.piv.filter((q) => q.known === k && p.day[q.i] === p.day[k]);
    for (const q of known) {
      let prev = null;
      for (const x of p.piv) { if (x.i >= q.i) break; if (x.type === q.type && p.day[x.i] === p.day[k]) prev = x; }
      if (!prev || p.rsi[q.i] == null || p.rsi[prev.i] == null) continue;
      if (q.type === 'low' && q.price < prev.price && p.rsi[q.i] > p.rsi[prev.i]) return cand(p, k, 'divergence', 'long', q.price, q.price, ['a lower low with a higher RSI low']);
      if (q.type === 'high' && q.price > prev.price && p.rsi[q.i] < p.rsi[prev.i]) return cand(p, k, 'divergence', 'short', q.price, q.price, ['a higher high with a lower RSI high']);
    }
    return null;
  },
};

// The raw answer of one detector at regular bar k, remembered per levels.
const NO_LEVELS = {};
function raw(p, setup, k, lv) {
  const lk = lv || NO_LEVELS;
  let m = p.memo.get(lk);
  if (!m) p.memo.set(lk, m = new Map());
  const key = setup + ':' + k;
  if (m.has(key)) return m.get(key);
  const r = DET[setup](p, k, lv) || null;
  m.set(key, r);
  return r;
}

/** Day candidates for bar `ctx.i` of `ctx.bars['5m']`. */
export function detectDay(ctx) {
  const bars = ctx.bars && ctx.bars['5m'];
  if (!bars || !bars.length || ctx.i == null || ctx.i < 0 || ctx.i >= bars.length) return [];
  const p = prepDay(bars), k = p.at[ctx.i];
  if (k < 0 || p.minute[k] === OPEN) return [];
  const out = [];
  for (const setup of ctx.setup ? [ctx.setup] : DAY_SETUPS) {
    const c = raw(p, setup, k, ctx.levels);
    if (!c) continue;
    // Once a session each way: not if it already fired earlier today.
    let again = false;
    for (let j = p.start[k]; j < k && !again; j++) {
      if (p.minute[j] === OPEN) continue;
      const e = raw(p, setup, j, ctx.levels);
      if (e && e.dir === c.dir) again = true;
    }
    if (!again) out.push(c);
  }
  return out;
}
