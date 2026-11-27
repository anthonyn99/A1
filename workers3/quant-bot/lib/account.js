import { json } from './lab.js';
import { paperBroker } from './alpaca.js';
import { readBotState, readSettings } from './state.js';
import { liveIntents } from './orders.js';
import { reconcile, deployedOf } from './reconcile.js';

const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const round = (x) => Math.round(x * 100) / 100;

/** Authenticated by the worker before any cache lookup. Only the internal response is cacheable. */
export async function getAccount(req, env, { cache = globalThis.caches?.default, fetchFn = fetch } = {}) {
  const key = new Request(new URL('/.bot-cache/v1/account', req.url));
  const cached = await cache?.match(key).catch(() => null);
  if (cached) {
    const body = await cached.json().catch(() => null);
    if (body) return json(body);
  }
  const broker = paperBroker(env, fetchFn);
  const [a, held, orders, { settings }, previous, managed] = await Promise.all([
    broker.account(), broker.positions(), broker.orders(), readSettings(env.DB), readBotState(env.DB), liveIntents(env.DB),
  ]);
  const limits = settings.limits, book = reconcile(a, held, orders, managed, previous, limits);
  const { deployed } = deployedOf(book, previous);
  const cash = num(a.cash);
  const body = {
    account: { equity: round(book.equity), cash: cash == null ? null : round(cash + limits.book - book.startingEquity),
      buying_power: round(Math.max(0, Math.min(book.buyingPower, limits.maxDeployed - deployed))),
      day_pnl: round(book.dayPnl), deployed: round(deployed), booked: true, broker_equity: num(a.equity) },
    book: { capital: limits.book, bp_cap: limits.maxDeployed },
    positions: held.map((p) => ({ symbol: p.symbol, qty: num(p.qty), side: p.side, avg: num(p.avg_entry_price),
      price: num(p.current_price), value: num(p.market_value), pnl: num(p.unrealized_pl), pnlPct: num(p.unrealized_plpc), dayPnl: num(p.unrealized_intraday_pl) })),
    orders,
  };
  await cache?.put(key, new Response(JSON.stringify(body), { headers: { 'cache-control': 'public, max-age=20' } })).catch(() => {});
  return json(body);
}
