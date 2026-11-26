// COPY of A1-Priv TradeHub/core/pilot.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// A strategy running on paper (docs/TradeHub/quant/phase-09c.md): on each
// closed bar, which orders it places and which positions it closes. Pure.
//
// One code path with the backtest: entries and rule exits are core/simulate.js
// entrySeries over the same contexts (buildContexts), stops and targets are its
// formulas, sizing is its targetShares. What differs is only WHEN: the backtest
// fills at the next bar's open; paper sends a market order after the close, which
// Alpaca fills at that same open. Stops and targets go to Alpaca as bracket legs,
// so they fill between ticks with TradeHub closed.
//
//   decide(spec, { contexts, run, held, equity, capital, limits, taken, at }) →
//     { orders: [{ order, reason }], closes: [{ symbol, reason }], notes }
//   spec      withDefaults()'d and checked;  contexts  buildContexts() over bars up to the LAST CLOSED bar
//   held      { SYM: { side, qty, bars } }  this run's positions (bars held so far)
//   taken     symbols another run holds (a symbol belongs to one run at a time)
//   limits    { maxPositions, maxPositionPct, maxOrdersDay, dailyLossPct, maxDrawdownPct }
//   guard(run, { dayPnl, peak, equity }) → 'ok' | 'pause' | 'stop'   the loss limits
import { entrySeries, STOP_PAD_ATR, FALLBACK_STOP_ATR } from './simulate.js';
import { series } from './strategy-rules.js';
import { atr } from './indicators.js';
import { isStop, isTarget, isTime, riskValueOf } from './strategy.js';
import { clientId, entryOrder, MAX_ORDER_SHARE } from './venue.js';

const fmt = (x) => (Number.isFinite(x) ? x.toFixed(2) : '?');

/** The orders a running strategy places on its last closed bar. */
export function decide(spec, { contexts = {}, run = 'r0000', held = {}, equity = null, capital = 100_000, limits = {}, taken = [], at = null } = {}) {
  const ex = (spec.exit && spec.exit.any) || [], stopX = ex.find(isStop), targetX = ex.find(isTarget), timeX = ex.find(isTime);
  const ruleX = ex.filter((x) => !isStop(x) && !isTarget(x) && !isTime(x));
  const sides = spec.side === 'both' ? ['long', 'short'] : [spec.side];
  const orders = [], closes = [], notes = [];
  const maxPos = Math.min(spec.maxPositions || 10, limits.maxPositions || Infinity);
  let open = Object.keys(held).length;

  // Exits first: a rule exit or the time exit on this bar closes the position (stops and targets are Alpaca's legs).
  for (const [sym, q] of Object.entries(held)) {
    const S = contexts[sym];
    if (!S) { notes.push(`${sym}: no bars this tick`); continue; }
    const i = S.bars.length - 1, mirror = spec.side === 'both' && q.side === 'short';
    if (timeX && q.bars + 1 >= timeX.bars) { closes.push({ symbol: sym, reason: `time exit: held ${q.bars + 1} of ${timeX.bars} bars` }); continue; }
    if (ruleX.length && entrySeries(S, { any: ruleX }, q.side, mirror)[i]) closes.push({ symbol: sym, reason: 'exit rule fired on the bar of ' + new Date(S.t[i]).toISOString().slice(0, 10) });
  }
  open -= closes.length;

  // Entries: the entry block fired on the last closed bar, no position yet, room under both caps.
  for (const sym of Object.keys(contexts).sort()) {
    if (held[sym] || taken.includes(sym)) continue;
    if (open >= maxPos) { notes.push(`at ${maxPos} positions: no new entries`); break; }
    const S = contexts[sym], i = S.bars.length - 1, b = S.bars[i];
    for (const side of sides) {
      const mirror = spec.side === 'both' && side === 'short';
      if (!entrySeries(S, spec.entry || {}, side, mirror)[i]) continue;
      const plan = planEntry(spec, S, i, side, { stopX, targetX, equity: Math.min(capital, equity || capital), limits });
      if (!plan) { notes.push(`${sym}: the entry fired but the size came out under one share`); break; }
      const id = clientId(run, sym, at || b.t, side === 'long' ? 'buy' : 'sell');
      orders.push({ order: entryOrder({ symbol: sym, side: side === 'long' ? 'buy' : 'sell', qty: plan.shares, stop: plan.stop, target: plan.target, id }),
        reason: `${spec.name || 'strategy'}: entry fired on the ${new Date(b.t).toISOString().slice(0, 10)} bar (close ${fmt(b.c)})` + (plan.stop != null ? `, stop ${fmt(plan.stop)}` : '') + (plan.target != null ? `, target ${fmt(plan.target)}` : '') + `, ${plan.shares} shares` });
      open++;
      break;
    }
  }
  return { orders, closes, notes };
}

/** Stop and target prices computed at the signal bar's close. */
export function entryPrices(S, i, side, { stopX, targetX }) {
  const b = S.bars[i], px = b.c, a = atr(S.bars, 14)[i], long = side === 'long', sgn = long ? 1 : -1;
  let stop = null;
  if (stopX) {
    if (stopX.stop === 'atr' && a) stop = px - sgn * stopX.value * a;
    else if (stopX.stop === 'percent') stop = px * (1 - sgn * stopX.value / 100);
    else if (stopX.stop === 'level') { const lv = long ? series(S, 'level.nearestSupport')[i] : series(S, 'level.nearestResistance')[i]; stop = lv != null && a ? lv - sgn * STOP_PAD_ATR * a : a ? px - sgn * FALLBACK_STOP_ATR * a : null; }
    if (stop != null && (long ? stop >= px : stop <= px)) stop = null;
  }
  const riskPS = stop != null ? Math.abs(px - stop) : 0;
  let target = null;
  if (targetX) {
    if (targetX.target === 'r' && riskPS > 0) target = px + sgn * targetX.value * riskPS;
    else if (targetX.target === 'percent') target = px * (1 + sgn * targetX.value / 100);
    else if (targetX.target === 'level') { const lv = long ? series(S, 'level.nearestResistance')[i] : series(S, 'level.nearestSupport')[i]; if (lv != null && (long ? lv > px : lv < px)) target = lv; }
  }
  return { price: px, stop, target, riskPS };
}

/** Size the manual paper pilot entry from its prices and allocation limits. */
export function planEntry(spec, S, i, side, { stopX, targetX, equity, limits = {} }) {
  const { price: px, stop, target, riskPS } = entryPrices(S, i, side, { stopX, targetX });
  const k = spec.sizing.kind, v = riskValueOf(spec.sizing);
  let sh = k === 'equal' ? equity / spec.maxPositions / px : k === 'percent' ? equity * v / 100 / px : riskPS > 0 ? equity * v / 100 / riskPS : 0;
  sh = Math.min(sh, equity / px);
  // The run's own cap and the account-wide 25% (both checked again by quant-api).
  if (limits.maxPositionPct) sh = Math.min(sh, equity * limits.maxPositionPct / 100 / px);
  sh = Math.min(sh, equity * MAX_ORDER_SHARE / px);
  const shares = Math.floor(sh);
  return shares >= 1 ? { shares, stop, target, riskPS, price: px } : null;
}

/** The loss limits: today's loss over dailyLossPct pauses the run; a drawdown over maxDrawdownPct stops it. */
export function guard(limits, { dayPnl = 0, peak = null, equity = null, capital = null } = {}) {
  const base = capital || equity || 0;
  if (limits.maxDrawdownPct && peak > 0 && equity != null && (peak - equity) / peak * 100 >= limits.maxDrawdownPct) return 'stop';
  if (limits.dailyLossPct && base > 0 && -dayPnl / base * 100 >= limits.dailyLossPct) return 'pause';
  return 'ok';
}
