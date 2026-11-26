// COPY of A1-Priv TradeHub/core/backtest.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// The setups backtester (docs/TradeHub/quant/phase-06.md): every Scanner
// setup replayed over history, each signal traded by the rules and graded.
// Pure.
//
// One code path with the live scanner: the signals come from core/scan.js
// scanSymbol (the same detectors and the same score.js, no lookahead, proven
// per detector in Phase 5), and each trade is graded by core/grade.js. What
// the backtest adds is only the fill: entry at the NEXT bar's open when that
// open is inside the signal's zone (else no trade), costs, and one open trade
// per symbol and setup at a time.
import { scanSymbol } from './scan.js';
import { grade } from './grade.js';
import { BAR_MS, forgetPrepDay } from './detect-day.js';
import { forgetPrepSwing } from './detect-swing.js';
import { costInR } from './costs.js';
import { FACTORS } from './score.js';

const DAY = 86_400_000;

/** First index of `bars` whose time is ≥ t (binary search). */
export function firstAtOrAfter(bars, t) {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * Trade one signal on the bars after it → a Trade, or null when the next
 * bar's open is outside the zone (or there is no next bar before expiry).
 *   Trade = { id, symbol, setup, horizon, dir, at, regime, regimeScore, score,
 *     factors, entryT, entry, stop, targets, risk, status, done, exitT, rGross,
 *     costR, r, bars, mfe, mae }
 * The grade is grade.js's on the signal with its zone and entry moved to that
 * open: a bar spanning stop and target counts the stop, as live.
 */
export function tradeSignal(sig, bars, { costs, regimeScore = null } = {}) {
  const k = firstAtOrAfter(bars, sig.at + 1);
  const nb = bars[k];
  if (!nb || nb.t >= sig.expires) return null;
  if (sig.horizon === 'day' && nb.t - sig.at > 2 * BAR_MS) return null;   // the next bar is another session
  const [lo, hi] = sig.zone, o = nb.o;
  if (!(o >= lo && o <= hi)) return null;
  const risk = Math.abs(o - sig.stop);
  if (!(risk > 0) || (sig.dir === 'long' ? o <= sig.stop : o >= sig.stop)) return null;
  const end = firstAtOrAfter(bars, sig.expires);
  // grade() never reads bars before sig.at + one step, so the fill bar must sit there.
  const filled = { ...sig, zone: [o, o], entry: o, at: nb.t - (sig.horizon === 'day' ? BAR_MS : DAY) };
  const g = grade(filled, bars.slice(k, Math.min(bars.length, end + 1)), Infinity);
  const costR = costInR(o, risk, costs);
  return {
    id: sig.id, symbol: sig.symbol, setup: sig.setup, horizon: sig.horizon, dir: sig.dir, at: sig.at,
    regime: sig.regime, regimeScore, score: sig.score, factors: sig.factors,
    entryT: nb.t, entry: o, stop: sig.stop, targets: sig.targets, risk,
    status: g.status, done: g.done, exitT: g.closedAt, rGross: g.r,
    costR, r: g.r == null ? null : g.r - costR, bars: g.bars, mfe: g.mfe, mae: g.mae,
  };
}

/**
 * Backtest the setups → `{ trades, signals, skipped }` (trades oldest first).
 *   barsBySymbol  { SYM: { daily, m5 } } (daily bars for swing setups and the
 *                 day setups' levels; 5-minute bars for day setups)
 *   from, to      signals whose bar is in [from, to)
 *   horizons      which setups: ['day', 'swing'] by default
 *   regimeAt      (t, horizon) → { score, label } as of then (never later), or null
 *   rsAt          (symbol) → (t, horizon) → { rank, vsSector, rank3m }, or null
 *   earnings      { SYM: ['YYYY-MM-DD', ...] }
 *   costs         { slippageCents, fees } (core/costs.js)
 *   onProgress    ({ done, total, symbol, bars }) after each symbol
 *   keepSignals   also return every signal found (`list`), for the live-agreement test
 * One open trade per symbol and setup: a signal before the last trade of its
 * setup has finished is skipped (counted in `skipped.busy`).
 */
export function backtest({ barsBySymbol = {}, from = -Infinity, to = Infinity, horizons = ['day', 'swing'], regimeAt = null, rsAt = null,
  earnings = {}, costs = {}, onProgress = null, keepSignals = false } = {}) {
  const trades = [], skipped = { zone: 0, busy: 0, open: 0 }, list = [];
  let signals = 0, done = 0, barsRead = 0;
  const syms = Object.keys(barsBySymbol), total = syms.length;
  for (const symbol of syms) {
    const x = barsBySymbol[symbol] || {}, daily = x.daily || [], m5 = x.m5 || [];
    barsRead += daily.length + m5.length;
    let found = [];
    try {
      found = scanSymbol({
        symbol, m5, daily,
        since: horizons.includes('day') && m5.length ? Math.max(from, m5[0].t) : null,
        swingSince: horizons.includes('swing') && daily.length ? Math.max(from, daily[0].t) : null,
        now: to, regime: regimeAt, rs: rsAt ? rsAt(symbol) : null, events: null,
        earnings: earnings[symbol] ? new Set(earnings[symbol]) : null,
      }).filter((s) => s.at >= from && s.at < to);
    } catch (e) { found = []; }
    signals += found.length;
    if (keepSignals) list.push(...found);
    const busyUntil = new Map();
    for (const s of found) {
      const key = s.setup;
      if ((busyUntil.get(key) || -Infinity) > s.at) { skipped.busy++; continue; }
      const reg = regimeAt ? regimeAt(s.at, s.horizon) : null;
      const t = tradeSignal(s, s.horizon === 'day' ? m5 : daily, { costs, regimeScore: reg ? reg.score : null });
      if (!t) { skipped.zone++; continue; }
      if (!t.done) skipped.open++;
      busyUntil.set(key, t.done ? t.exitT : Infinity);
      trades.push(t);
    }
    // This symbol is done: free its prepared series (they would otherwise live as long as its bars).
    forgetPrepSwing(daily); forgetPrepDay(m5);
    done++;
    if (onProgress) onProgress({ done, total, symbol, bars: barsRead });
  }
  trades.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return keepSignals ? { trades, signals, skipped, list } : { trades, signals, skipped };
}

/** A trade's factors as a plain row in FACTORS order (fit.js reads it). */
export const factorRow = (t) => FACTORS.map((k) => (t.factors && Number.isFinite(t.factors[k]) ? t.factors[k] : 0.5));
