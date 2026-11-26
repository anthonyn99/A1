// COPY of A1-Priv TradeHub/core/live-eval.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// The bot's last-bar evaluator (docs/TradeHub/quant/n4-01.md, "The windowed last-bar
// evaluator"). The bot needs each rule's value on the NEWEST bar only; N0 measured the
// full-series engine at ~32 ms of Worker CPU for 40 symbols x 400 bars. So the SAME code as
// the backtest (simulate.js entrySeries) runs on a window just long enough for every
// indicator to have converged, and the test proves it agrees with the full series. Pure.
//
//   warmupOf(spec)                      bars the window needs (before session alignment): the longest look-back + 2;
//                                       day setups 21 whole sessions (their volume baseline)
//   windowStart(bars, need, intraday)   where the window starts: `need` bars back, moved to a session's first bar
//                                       and never later than the previous session's first bar (VWAP, gaps)
//   evalLast(spec, bars, { daily, side, rules }) → { fire: bool, i, from }   rules: 'entry' | 'exit'
import { rulesOf, isStop, isTarget, isTime } from './strategy.js';
import { argsOf } from './strategy-rules.js';
import { buildContexts, entrySeries } from './simulate.js';
import { nyClock } from './clock.js';
import { DAY_SETUPS } from './detect-day.js';

export const MIN_WINDOW = 30, SWING_SETUP_WINDOW = 260;   // no upper cap: a cut window would change the answer
// Day setups rate volume against the same minute of the last 20 sessions (indicators.js relVolumeIntraday), so they
// need 21 whole sessions. N4 carries that baseline from a once-a-day computation instead (n4-01.md); until then the
// window is honest and long.
export const DAY_SETUP_SESSIONS = 21, BARS_PER_SESSION = { '5m': 78, '15m': 26, '1h': 7 };
// Smoothed indicators (EMA-style recursion) carry their whole past; x4 their length leaves < e^-8 of the start in them.
const SMOOTHED = new Set(['ema', 'rsi', 'atr', 'adx']);

/** The look-back one rule reference needs. */
function needOf(r, tf) {
  if (r.setup != null) return DAY_SETUPS.includes(r.setup) && tf !== '1d' ? DAY_SETUP_SESSIONS * (BARS_PER_SESSION[tf] || 78) : SWING_SETUP_WINDOW;
  if (!r.ind) return 0;
  const a = argsOf(r.ind, r.args);
  if (r.ind.startsWith('macd')) return ((a[1] || 26) + (a[2] || 9)) * 4;
  if (r.ind === 'adx') return (a[0] || 14) * 8;   // smoothed twice
  const n = typeof a[0] === 'number' ? a[0] : 0;
  const extra = (r.op === 'rising' || r.op === 'falling') && typeof r.than === 'number' ? r.than : 0;
  return (SMOOTHED.has(r.ind) ? n * 4 : n) + extra + (r.op === 'crossesAbove' || r.op === 'crossesBelow' ? 1 : 0);
}

/** Bars the window needs for every rule of `spec` to read as it would on the full history. */
export function warmupOf(spec) {
  let need = 14 * 4;   // the ATR(14) every stop and size reads
  let setupNeed = 0;
  for (const r of rulesOf(spec)) { const x = needOf(r, spec.timeframe); if (r.setup != null) setupNeed = Math.max(setupNeed, x); else need = Math.max(need, x); }
  return Math.max(setupNeed, MIN_WINDOW, need + 2);
}

/** The window's first bar: `need` back, moved to a session's first bar, with the previous session whole. */
export function windowStart(bars, need, intraday) {
  let s = Math.max(0, bars.length - need);
  if (!intraday || s === 0) return s;
  const day = (i) => nyClock(bars[i].t).date, last = day(bars.length - 1);
  // Back to the first bar of the session that holds bar s.
  while (s > 0 && day(s - 1) === day(s)) s--;
  // The previous session must be whole too (a gap reads its last close; VWAP restarts each session).
  if (day(s) === last) { while (s > 0 && day(s - 1) === last) s--; if (s > 0) { s--; while (s > 0 && day(s - 1) === day(s)) s--; } }
  return s;
}

/** Does the spec's entry (or its exit rules) fire on the last bar of `bars`? */
export function evalLast(spec, bars, { daily = null, side = 'long', rules = 'entry', mirror = false } = {}) {
  const n = bars.length;
  if (!n) return { fire: false, i: -1, from: 0 };
  const intraday = spec.timeframe !== '1d';
  const from = windowStart(bars, warmupOf(spec), intraday), win = from ? bars.slice(from) : bars;
  const ctx = buildContexts(spec, { bars: { X: win }, daily: daily ? { X: daily } : {} }).X;
  const block = rules === 'exit' ? { any: ((spec.exit && spec.exit.any) || []).filter((x) => !isStop(x) && !isTarget(x) && !isTime(x)) } : spec.entry || {};
  const s = entrySeries(ctx, block, side, mirror);
  return { fire: !!s[win.length - 1], i: n - 1, from };
}
