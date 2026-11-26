// COPY of A1-Priv TradeHub/core/drift.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// Live vs backtest (docs/TradeHub/quant/phase-09c.md): the same numbers measured
// on a paper run's closed trades and on the backtest over the same days, side by
// side, and how far apart they are. Pure.
//
//   drift(paper, backtest) → { paper, backtest, gap: { n, winRate, expectancyR, total }, slipR, matched, missed, extra, notes }
//   paper / backtest = trades [{ symbol, entryT, exitT, entry, exit, pnl, ret, r }]
// A paper trade is matched to a backtest trade on the same symbol whose entry is
// within two days; slipR is the mean difference in R of the matched pairs (paper
// minus backtest: fills, gaps, missed bars). Paper fills are simulated by Alpaca
// too (no queue position, no market impact): small caps and size look better on
// paper than they would be.
import { tradeStats } from './metrics.js';

const TWO_DAYS = 2 * 86_400_000;
const sub = (a, b) => (a == null || b == null ? null : a - b);

/** Live (paper) vs backtest over the same span. */
export function drift(paper = [], backtest = []) {
  const P = tradeStats(paper), B = tradeStats(backtest), used = new Set(), pairs = [];
  for (const t of paper) {
    const k = backtest.findIndex((x, j) => !used.has(j) && x.symbol === t.symbol && Math.abs(x.entryT - t.entryT) <= TWO_DAYS);
    if (k >= 0) { used.add(k); pairs.push([t, backtest[k]]); }
  }
  const withR = pairs.filter(([a, b]) => Number.isFinite(a.r) && Number.isFinite(b.r));
  const slipR = withR.length ? withR.reduce((s, [a, b]) => s + (a.r - b.r), 0) / withR.length : null;
  const total = (list) => list.reduce((s, t) => s + (t.pnl || 0), 0);
  const notes = [];
  if (backtest.length - used.size > 0) notes.push(`${backtest.length - used.size} backtest trade${backtest.length - used.size === 1 ? '' : 's'} with no paper fill (missed or not yet taken)`);
  if (paper.length - pairs.length > 0) notes.push(`${paper.length - pairs.length} paper trade${paper.length - pairs.length === 1 ? '' : 's'} the backtest did not take`);
  if (slipR != null && Math.abs(slipR) >= 0.1) notes.push(`fills differ by ${slipR > 0 ? '+' : ''}${slipR.toFixed(2)} R a trade on average (slippage and gaps)`);
  notes.push('Paper fills are simulated: no queue position, no market impact.');
  return {
    paper: { n: P.n, winRate: P.winRate, expectancyR: P.expectancyR, total: total(paper) },
    backtest: { n: B.n, winRate: B.winRate, expectancyR: B.expectancyR, total: total(backtest) },
    gap: { n: P.n - B.n, winRate: sub(P.winRate, B.winRate), expectancyR: sub(P.expectancyR, B.expectancyR), total: total(paper) - total(backtest) },
    slipR, matched: pairs.length, missed: backtest.length - used.size, extra: paper.length - pairs.length, notes,
  };
}

/** Round trips from paper fills → trades, oldest first (bookOf's trips). */
export const tripsOf = (fills = []) => bookOf(fills).trips;

/**
 * Fills (oldest first or not) → { trips, open: { SYM: { side, qty, entry, entryT, stop } }, realized }.
 * A fill on the open side adds to it (average price); the other side closes it, and what is left
 * over (a flip: buy 10, sell 15) opens the other side. A fill's `stop` (an entry's stop-loss leg)
 * gives each trip its R: pnl over the risk taken.
 */
export function bookOf(fills = []) {
  const open = {}, trips = [];
  for (const f of [...fills].sort((a, b) => a.at - b.at)) {
    let qty = Number(f.qty) || 0;
    if (!(qty > 0) || !Number.isFinite(f.price)) continue;
    const q = open[f.symbol];
    if (!q) { open[f.symbol] = { side: f.side, qty, entry: f.price, entryT: f.at, stop: f.stop != null ? f.stop : null }; continue; }
    if (q.side === f.side) { const n = q.qty + qty; q.entry = (q.entry * q.qty + f.price * qty) / n; q.qty = n; if (q.stop == null && f.stop != null) q.stop = f.stop; continue; }
    const long = q.side === 'buy', shut = Math.min(q.qty, qty), pnl = (long ? f.price - q.entry : q.entry - f.price) * shut;
    const riskPS = q.stop != null ? Math.abs(q.entry - q.stop) : 0;
    trips.push({ symbol: f.symbol, side: long ? 'long' : 'short', entryT: q.entryT, exitT: f.at, entry: q.entry, exit: f.price, shares: shut, pnl, ret: pnl / (q.entry * shut), r: riskPS > 0 ? pnl / (riskPS * shut) : null, bars: null });
    q.qty -= shut; qty -= shut;
    if (q.qty <= 1e-9) delete open[f.symbol];
    if (qty > 1e-9) open[f.symbol] = { side: f.side, qty, entry: f.price, entryT: f.at, stop: null };
  }
  return { trips, open, realized: trips.reduce((s, t) => s + t.pnl, 0) };
}

/** A run's fills from Alpaca's orders (nested, with their legs): every order whose client id starts with the run's id. */
export function runFills(orders = [], run) {
  const out = [];
  const fillOf = (o, stop = null) => { const q = Number(o.filled_qty), p = Number(o.filled_avg_price); if (q > 0 && Number.isFinite(p)) out.push({ symbol: o.symbol, side: o.side, qty: q, price: p, at: Date.parse(o.filled_at || o.updated_at || o.submitted_at), stop, order: o.id }); };
  for (const o of orders) {
    if (!o || !String(o.client_order_id || '').startsWith(run + '-')) continue;
    const legs = Array.isArray(o.legs) ? o.legs : [], stopLeg = legs.find((l) => l.type === 'stop' || l.type === 'stop_limit');
    fillOf(o, stopLeg ? Number(stopLeg.stop_price) : o.stop_loss ? Number(o.stop_loss.stop_price) : null);
    for (const l of legs) fillOf(l);
  }
  return out;
}
