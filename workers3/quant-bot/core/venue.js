// COPY of A1-Priv TradeHub/core/venue.js, made by A1-Priv tools/sync-core.mjs. Edit the original, then run it again.
// The paper venue (docs/TradeHub/quant/phase-09c.md): the order shapes, the
// checks every order passes before it goes out, and the venue interface every
// adapter fills (data/paper.js over quant-api's Alpaca PAPER account today; a
// native simulator could stand in). Pure.
//
// The page never calls a broker: orders go to quant-api (/paper/orders, and from
// Batch 4 /trade/:broker/orders), which checks them again (A1 workers2/quant-api/
// lib/paper.js, the same rules, one table tests both) and is the only code that
// reaches a paper broker (Alpaca paper; the Webull SANDBOX from Batch 4 T1). Real
// Webull stays read-only everywhere.
//
// Order (Alpaca's own shape): { symbol, side: 'buy'|'sell', type, time_in_force: 'day'|'gtc',
//   qty? | notional?, limit_price?, stop_price?, trail_percent? | trail_price?, extended_hours?,
//   order_class?: 'simple'|'bracket'|'oco'|'oto', take_profit?: { limit_price }, stop_loss?: { stop_price, limit_price? },
//   client_order_id? }
export const TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'], SIDES = ['buy', 'sell'], TIFS = ['day', 'gtc'], CLASSES = ['simple', 'bracket', 'oco', 'oto'];
export const MAX_ORDER_SHARE = 0.25;
export const VENUE_METHODS = ['account', 'positions', 'orders', 'place', 'cancel', 'replace', 'close', 'activity', 'kill', 'runs', 'startRun', 'changeRun'];
export const TYPE_TEXT = { market: 'market', limit: 'limit', stop: 'stop', stop_limit: 'stop-limit', trailing_stop: 'trailing stop' };
const SYM_RE = /^[A-Z][A-Z0-9.]{0,9}$/, ID_RE = /^[\w-]{1,64}$/;
const num = (x) => (x == null || x === '' ? null : Number(x));
const pos = (x) => Number.isFinite(x) && x > 0;

/**
 * Every reason `o` may not go out, in words → { ok, errors }.
 * ctx: { price (the latest), stale (the feed is STALE), equity (the account's), kill (the kill switch), closing }
 */
export function checkOrder(o, { price = null, stale = false, equity = null, kill = false, closing = false } = {}) {
  const e = [];
  if (!o || typeof o !== 'object') return { ok: false, errors: ['an order is needed'] };
  const type = o.type, side = o.side, qty = num(o.qty), notional = num(o.notional), lp = num(o.limit_price), sp = num(o.stop_price);
  if (kill && !closing) e.push('the kill switch is on: only closing orders and cancels go out');
  if (!SYM_RE.test(String(o.symbol || ''))) e.push('the symbol must be a ticker such as NVDA');
  if (!SIDES.includes(side)) e.push('the side is buy or sell');
  if (!TYPES.includes(type)) e.push('the type is market, limit, stop, stop_limit or trailing_stop');
  if (!TIFS.includes(o.time_in_force)) e.push('time in force is day or gtc');
  if (qty == null && notional == null) e.push('a size is needed (shares, or dollars for a market order)');
  if (qty != null && !pos(qty)) e.push('the share count must be above zero');
  if (qty != null && pos(qty) && !Number.isInteger(qty) && !(type === 'market' && o.time_in_force === 'day')) e.push('fractional shares only on a market day order');
  if (notional != null && (!pos(notional) || type !== 'market')) e.push('a dollar size only on a market order, above zero');
  if ((type === 'limit' || type === 'stop_limit') && !pos(lp)) e.push('a limit order needs a limit price above zero');
  if ((type === 'stop' || type === 'stop_limit') && !pos(sp)) e.push('a stop order needs a stop price above zero');
  if (type === 'trailing_stop') {
    const tp = num(o.trail_percent), tv = num(o.trail_price);
    if (!(pos(tp) && tp <= 50) && !pos(tv)) e.push('a trailing stop needs a trail percent (above 0, up to 50) or a trail price');
  }
  if (o.extended_hours && !(type === 'limit' && o.time_in_force === 'day')) e.push('extended hours only on a limit day order');
  if (type === 'market' && stale) e.push('no market order while the price is stale');
  const cls = o.order_class || 'simple';
  if (!CLASSES.includes(cls)) e.push('the order class is simple, bracket, oco or oto');
  const ref = lp || (type === 'market' ? price : sp) || price;
  if (cls === 'bracket') {
    const tp = num(o.take_profit && o.take_profit.limit_price), sl = num(o.stop_loss && o.stop_loss.stop_price);
    if (!pos(tp) || !pos(sl)) e.push('a bracket needs a target and a stop');
    else if (pos(ref) && (side === 'buy' ? !(sl < ref && ref < tp) : !(tp < ref && ref < sl))) e.push(side === 'buy' ? 'a buy bracket needs its stop below the price and its target above' : 'a short bracket needs its stop above the price and its target below');
  }
  if (type === 'stop' && pos(sp) && pos(price) && !closing && cls === 'simple') {
    if (side === 'buy' && sp <= price) e.push('a buy stop must be above the current price');
    if (side === 'sell' && sp >= price) e.push('a sell stop must be below the current price');
  }
  const value = notional != null ? notional : pos(qty) && pos(ref) ? qty * ref : null;
  if (!closing && pos(value) && pos(equity) && value > equity * MAX_ORDER_SHARE) e.push(`no order larger than ${MAX_ORDER_SHARE * 100}% of the account (this one is ${Math.round(value / equity * 100)}%)`);
  if (o.client_order_id != null && !ID_RE.test(String(o.client_order_id))) e.push('the client order id is up to 64 letters, digits, - or _');
  return { ok: !e.length, errors: [...new Set(e)] };
}

const px = (x) => (Number.isFinite(x) ? x.toFixed(2) : '?');
/** The order read back in words (the ticket's confirm step), always marked PAPER. */
export function orderText(o) {
  const side = o.side === 'buy' ? (o.closing ? 'Buy to cover' : 'Buy') : o.closing ? 'Sell' : o.short ? 'Sell short' : 'Sell';
  const size = o.notional != null ? `$${Number(o.notional).toLocaleString('en-US')} of` : `${o.qty} share${Number(o.qty) === 1 ? '' : 's'} of`;
  const how = o.type === 'market' ? 'at market' : o.type === 'limit' ? `with a limit at ${px(num(o.limit_price))}` : o.type === 'stop' ? `on a stop at ${px(num(o.stop_price))}`
    : o.type === 'stop_limit' ? `on a stop at ${px(num(o.stop_price))}, limit ${px(num(o.limit_price))}` : `with a trailing stop ${o.trail_percent != null ? o.trail_percent + '%' : '$' + o.trail_price} behind`;
  const legs = o.order_class === 'bracket' ? `, then a target at ${px(num(o.take_profit.limit_price))} and a stop at ${px(num(o.stop_loss.stop_price))}` : '';
  const tif = o.time_in_force === 'gtc' ? 'good till cancelled' : 'for today' + (o.extended_hours ? ', extended hours too' : '');
  return `PAPER: ${side} ${size} ${o.symbol} ${how}${legs}, ${tif}.`;
}

/** A run's order id: run + symbol + bar day + side, so a retried tick sends the same id (Alpaca refuses the double). */
export function clientId(run, symbol, barT, side) {
  const d = new Date(barT).toISOString().slice(0, 10).replace(/-/g, '');
  return `${run}-${String(symbol).replace(/[^A-Z0-9]/g, '')}-${d}-${side}`.slice(0, 64);
}

/** A bracket (or a one-legged order) for an entry with an optional stop and target. */
export function entryOrder({ symbol, side, qty, stop = null, target = null, type = 'market', limit = null, tif = 'day', id = null }) {
  const o = { symbol, side, type, time_in_force: tif, qty };
  if (type === 'limit') o.limit_price = limit;
  if (stop != null && target != null) { o.order_class = 'bracket'; o.take_profit = { limit_price: round2(target) }; o.stop_loss = { stop_price: round2(stop) }; }
  else if (stop != null) { o.order_class = 'oto'; o.stop_loss = { stop_price: round2(stop) }; }
  else if (target != null) { o.order_class = 'oto'; o.take_profit = { limit_price: round2(target) }; }
  if (id) o.client_order_id = id;
  return o;
}
const round2 = (x) => Math.round(x * 100) / 100;

/* ── brokers (Batch 4 T1, docs/TradeHub/quant-trading.md) ───────────────────
   One order model (the shape above) for every broker; each broker declares what it can do, and
   checkFor() adds its own refusals to checkOrder's. The page reaches a broker only through quant-api
   /trade/:broker/…; "live" is a mode the code knows and refuses until a future batch builds it. */
export const BROKERS = ['alpaca', 'webull', 'cortex'];
export const MODES = ['paper', 'live'];
export const LIVE_BUILT = false;
export const CAPABILITIES = {
  alpaca: { label: 'Alpaca', types: TYPES, tifs: TIFS, classes: CLASSES, fractional: true, notional: true, trailingTifs: ['day', 'gtc'],
    extended: 'limit day orders', sessions: ['core', 'extended'], clientIdMax: 64, defaultCapital: 100000, runs: true,
    note: 'Alpaca paper: fills against live quotes; brackets, OCO, OTO; trailing stops on single orders.' },
  webull: { label: 'Webull', types: TYPES, tifs: TIFS, classes: CLASSES, fractional: false, notional: false, trailingTifs: ['day'],
    extended: 'limit orders', sessions: ['core', 'all'], clientIdMax: 32, defaultCapital: 1000000, runs: false,
    note: 'Webull paper (sandbox): day orders and brackets go in only during market hours; a GTC order can be placed, changed and cancelled any time; trailing stops are day orders.' },
  cortex: { label: 'Neo Cortex', readOnly: true, types: [], tifs: [], classes: [], fractional: false, notional: false, trailingTifs: [],
    extended: false, sessions: [], clientIdMax: 0, runs: false },
};
/** quant-api's address for a broker's route; throws for live (not built) or an unknown broker. */
export function tradePath(broker, rest = '', mode = 'paper') {
  if (mode === 'live' && !LIVE_BUILT) throw new Error('live trading is not built yet: paper only');
  if (!BROKERS.includes(broker)) throw new Error('no such broker: ' + broker);
  if (CAPABILITIES[broker].readOnly) throw new Error('Neo Cortex is read-only');
  return '/trade/' + broker + rest;
}
/** checkOrder plus what this broker refuses, in words → { ok, errors }. */
export function checkFor(broker, o, ctx = {}) {
  const base = checkOrder(o, ctx), e = [...base.errors], cap = CAPABILITIES[broker];
  if (ctx.mode === 'live' && !LIVE_BUILT) e.push('live trading is not built yet: paper only');
  if (!cap) return { ok: false, errors: [...e, 'no such broker: ' + broker] };
  if (cap.readOnly) return { ok: false, errors: [cap.label + ' is read-only'] };
  if (o && typeof o === 'object') {
    const qty = num(o.qty);
    if (!cap.notional && o.notional != null) e.push(`${cap.label} takes a share count, not a dollar amount`);
    if (!cap.fractional && qty != null && pos(qty) && !Number.isInteger(qty)) e.push(`${cap.label} paper takes whole shares only`);
    if (o.type === 'trailing_stop' && !cap.trailingTifs.includes(o.time_in_force)) e.push(`${cap.label} takes trailing stops as ${cap.trailingTifs.join(' or ')} orders only`);
    if (o.client_order_id != null && (String(o.client_order_id).length > cap.clientIdMax || (broker === 'webull' && !/^[A-Za-z0-9]+$/.test(String(o.client_order_id))))) e.push(`${cap.label}'s order id is up to ${cap.clientIdMax} ${broker === 'webull' ? 'letters and digits' : 'characters'}`);
  }
  return { ok: !e.length, errors: [...new Set(e)] };
}
/** The read-back with the broker named ("PAPER · Webull: Buy 1 share …"). */
export function orderTextFor(broker, o) {
  const cap = CAPABILITIES[broker];
  return orderText(o).replace(/^PAPER:/, 'PAPER · ' + (cap ? cap.label : broker) + ':');
}
/** clientId for a broker: Webull wants up to 32 letters and digits. */
export function clientIdFor(broker, run, symbol, barT, side) {
  const id = clientId(run, symbol, barT, side);
  return broker === 'webull' ? id.replace(/[^A-Za-z0-9]/g, '').slice(0, 32) : id;
}
