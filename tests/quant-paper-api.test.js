// quant-api paper trading (A1-Priv docs/TradeHub/quant/phase-09c.md; lib/paper.js)
// against a faked Alpaca PAPER API, on a REAL SQLite D1 with every migration:
// the only host is the paper one; an order is logged before it goes out with
// who/why/run; refused orders never reach Alpaca; a duplicate client id (a retried
// tick) is "already sent"; replace, cancel, close; a rejection and a 429 are
// passed on with Alpaca's reason; the kill switch cancels everything and pauses
// every run, and then only closing orders go out; runs start, pause, stop; Neo
// Quant and strategies can tighten limits but never loosen them or add capital;
// a run's orders a day and its position limit; fills kept once; equity rows;
// checkOrder here and A1-Priv core/venue.js agree on a table of orders.
//
// Run: node tests/quant-paper-api.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const MIG = path.join(__dirname, '..', 'workers2', 'quant-api', 'migrations');
const PRIV = process.env.A1_PRIV ? path.resolve(process.env.A1_PRIV) : path.join(__dirname, '..', '..', 'A1-Priv');
function realD1() {
  const sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) sql.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a.map(norm)),
    async first() { const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
    async all() { return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = sql.prepare(q).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { sql, prepare: (q) => stmt(q), async batch(list) { for (const s of list) await s.run(); return []; } };
}

/* ── a fake Alpaca PAPER API ──────────────────────────────────────────────── */
const A = { calls: [], orders: new Map(), next: 1, plan: [], reset() { this.calls.length = 0; this.plan.length = 0; } };
const res = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': '199', ...headers } });
const fakeFetch = async (url, init = {}) => {
  const u = new URL(String(url)), method = (init.method || 'GET').toUpperCase(), h = new Headers(init.headers || {});
  A.calls.push(method + ' ' + u.origin + u.pathname);
  if (u.origin !== 'https://paper-api.alpaca.markets') return res({ message: 'not the paper host' }, 599);
  if (h.get('APCA-API-KEY-ID') !== 'PKTEST' || h.get('APCA-API-SECRET-KEY') !== 'SECRET') return res({ message: 'unauthorized' }, 401);
  const forced = A.plan.shift();
  if (forced) return res(forced.body, forced.status, forced.headers);
  const p = u.pathname;
  if (p === '/v2/account') return res({ status: 'ACTIVE', currency: 'USD', equity: '100000', last_equity: '99500', cash: '100000', buying_power: '400000', long_market_value: '0', short_market_value: '0', pattern_day_trader: false, daytrade_count: 0, shorting_enabled: true, trading_blocked: false, multiplier: '4' });
  if (p === '/v2/clock') return res({ is_open: false, next_open: '2026-11-16T09:30:00-05:00' });
  if (p === '/v2/positions' && method === 'GET') return res([{ symbol: 'NVDA', qty: '10', side: 'long', avg_entry_price: '100', current_price: '104', market_value: '1040', unrealized_pl: '40', unrealized_plpc: '0.04', unrealized_intraday_pl: '12' }]);
  if (p.startsWith('/v2/positions/') && method === 'DELETE') return res({ id: 'close' + (A.next++), symbol: p.split('/').pop(), side: 'sell', type: 'market', status: 'accepted' });
  if (p === '/v2/orders' && method === 'POST') {
    const b = JSON.parse(init.body);
    if ([...A.orders.values()].some((o) => o.client_order_id === b.client_order_id)) return res({ code: 40010001, message: 'client_order_id must be unique' }, 422);
    const o = { id: 'a' + (A.next++), status: 'accepted', ...b, qty: b.qty };
    A.orders.set(o.id, o);
    return res(o);
  }
  if (p === '/v2/orders' && method === 'GET') return res([...A.orders.values()].filter((o) => o.status !== 'canceled'));
  if (p === '/v2/orders' && method === 'DELETE') { const n = [...A.orders.values()].filter((o) => o.status !== 'canceled'); n.forEach((o) => { o.status = 'canceled'; }); return res(n.map((o) => ({ id: o.id, status: 200 })), 207); }
  const m = /^\/v2\/orders\/([\w-]+)$/.exec(p);
  if (m && method === 'PATCH') { const o = A.orders.get(m[1]); if (!o) return res({ message: 'order not found' }, 404); Object.assign(o, JSON.parse(init.body)); return res(o); }
  if (m && method === 'DELETE') { const o = A.orders.get(m[1]); if (!o) return res({ message: 'order not found' }, 404); o.status = 'canceled'; return new Response(null, { status: 204 }); }
  if (p === '/v2/account/activities/FILL') return res([{ id: 'act1', transaction_time: '2026-11-16T14:30:01Z', order_id: 'a1', symbol: 'NVDA', side: 'buy', qty: '10', price: '100.5', type: 'fill' }]);
  return res({ message: 'no such fake route ' + p }, 404);
};
globalThis.fetch = fakeFetch;

const req = (body, method = 'POST') => new Request('https://quant-api.test/x', { method, body: body == null ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const read = async (r) => JSON.parse(await r.text());
const tryCall = async (fn) => { try { return { ok: true, body: await read(await fn()) }; } catch (e) { return { ok: false, status: e.status, error: e.message, extra: e.extra }; } };

(async () => {
  const P = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'lib', 'paper.js')).href);
  const env = { DB: realD1(), ALPACA_KEY: 'PKTEST', ALPACA_SECRET: 'SECRET' };
  const order = { symbol: 'NVDA', side: 'buy', type: 'limit', time_in_force: 'day', qty: 10, limit_price: 100 };

  console.log('The probe, the account, reads');
  let r = await read(await P.probe(env));
  ok('the probe: account, clock, open orders, the rate limit', r.ok && r.account.status === 'ACTIVE' && r.account.equity === 100000 && r.clock.is_open === false && r.rateLimit.limit === 200);
  ok('...only the paper host was called, with the paper key', A.calls.length === 3 && A.calls.every((c) => c.includes('https://paper-api.alpaca.markets/v2/')));
  r = await read(await P.account(env));
  ok('the account, marked paper, the kill switch off', r.paper && r.account.equity === 100000 && r.kill === false);
  r = await read(await P.positions(env));
  ok('positions with their P&L', r.positions[0].symbol === 'NVDA' && r.positions[0].pnl === 40 && r.positions[0].dayPnl === 12);

  console.log('\nPlacing, logged before it goes out');
  A.reset();
  r = await tryCall(() => P.place(env, req({ order, who: 'tony' }), { priceOf: async () => 101 }));
  ok('Tony\'s order goes to Alpaca paper and comes back accepted', r.ok && r.body.order.status === 'accepted' && A.calls.includes('POST https://paper-api.alpaca.markets/v2/orders'), JSON.stringify(r));
  const row = env.DB.sql.prepare('SELECT * FROM paper_orders').get();
  ok('...it is in the log: who, the order sent, Alpaca\'s id and status', row && row.who === 'tony' && row.symbol === 'NVDA' && row.alpaca_id === r.body.order.id && row.status === 'accepted' && JSON.parse(row.body).limit_price === '100');
  A.reset();
  r = await tryCall(() => P.place(env, req({ order: { ...order, qty: 0 }, who: 'tony' })));
  ok('a bad order is refused with its reason and never reaches Alpaca', !r.ok && r.status === 422 && /above zero/.test(r.error) && !A.calls.some((c) => c.startsWith('POST')));
  r = await tryCall(() => P.place(env, req({ order: { ...order, qty: 300 }, who: 'tony' }), { priceOf: async () => 101 }));
  ok('...over 25% of the account is refused (equity from Alpaca)', !r.ok && /25%/.test(r.error));
  r = await tryCall(() => P.place(env, req({ order, who: 'neo' })));
  ok('Neo Quant\'s order without a reason is refused', !r.ok && r.status === 400 && /reason/.test(r.error));
  r = await tryCall(() => P.place(env, req({ order, who: 'mallory' })));
  ok('an unknown author is refused', !r.ok && r.status === 400);
  const dupBody = { order: { ...order, client_order_id: 'rabc0001-NVDA-20261113-buy' }, who: 'tony' };
  await tryCall(() => P.place(env, req(dupBody), { priceOf: async () => 101 }));
  r = await tryCall(() => P.place(env, req(dupBody), { priceOf: async () => 101 }));
  ok('the same client id again (a retried tick) is "already sent", not an error', r.ok && r.body.duplicate === true);
  A.plan.push({ status: 403, body: { message: 'insufficient buying power' } });
  r = await tryCall(() => P.place(env, req({ order: { ...order, limit_price: 99 }, who: 'tony' }), { priceOf: async () => 101 }));
  ok('Alpaca\'s rejection is passed on with its reason, and logged as refused', !r.ok && /insufficient buying power/.test(r.error) && env.DB.sql.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE status = 'refused'").get().n === 1);
  A.plan.push({ status: 429, body: { message: 'too many requests' } });
  r = await tryCall(() => P.place(env, req({ order: { ...order, limit_price: 98 }, who: 'tony' }), { priceOf: async () => 101 }));
  ok('a 429 is passed on as a 429', !r.ok && r.status === 429);
  const bracket = { ...order, limit_price: 100, order_class: 'bracket', take_profit: { limit_price: 110 }, stop_loss: { stop_price: 95 } };
  r = await tryCall(() => P.place(env, req({ order: bracket, who: 'tony' }), { priceOf: async () => 101 }));
  ok('a bracket goes out with its legs, and nothing Alpaca does not know passes through', r.ok && r.body.order.order_class === 'bracket' && r.body.order.take_profit.limit_price === '110' && !('who' in r.body.order));

  console.log('\nReplace, cancel, close');
  const id = r.body.order.id;
  r = await tryCall(() => P.replace(env, req({ limit_price: 99.5, who: 'tony' }, 'PATCH'), id));
  ok('replace: the new limit at Alpaca, logged', r.ok && A.orders.get(id).limit_price === '99.5' && env.DB.sql.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE status = 'replaced'").get().n === 1);
  r = await tryCall(() => P.cancel(env, id));
  ok('cancel: canceled at Alpaca and in the log', r.ok && A.orders.get(id).status === 'canceled');
  r = await tryCall(() => P.closePosition(env, 'NVDA'));
  ok('close a position: a market close at Alpaca', r.ok && r.body.order.symbol === 'NVDA');
  ok('...and nothing but a ticker or an order id goes into the path', !(await tryCall(() => P.closePosition(env, '../account'))).ok && !(await tryCall(() => P.cancel(env, '../../v2/account'))).ok);

  console.log('\nRuns and their limits');
  r = await tryCall(() => P.startRun(env, req({ name: 'Semis dip', spec: { entry: { all: [{ setup: 'orb' }] } }, capital: 20000, limits: { maxPositions: 3, maxPositionPct: 25, maxOrdersDay: 2 }, who: 'tony' })));
  ok('a run starts with its spec, capital and limits', r.ok && r.body.run.state === 'running' && r.body.run.limits.maxPositions === 3 && /^r[a-z0-9]+$/.test(r.body.run.id));
  const run = r.body.run.id;
  r = await tryCall(() => P.place(env, req({ order: { ...order, qty: 60, client_order_id: run + '-NVDA-1-buy' }, who: 'run', reason: 'entry', run }), { priceOf: async () => 101 }));
  ok('over the run\'s position limit (25% of its 20,000) is refused', !r.ok && r.status === 409 && /position limit/.test(r.error));
  for (let k = 0; k < 2; k++) await tryCall(() => P.place(env, req({ order: { ...order, qty: 5, client_order_id: run + '-NVDA-' + k + '-buy' }, who: 'run', reason: 'entry', run }), { priceOf: async () => 101 }));
  r = await tryCall(() => P.place(env, req({ order: { ...order, qty: 5, client_order_id: run + '-NVDA-9-buy' }, who: 'run', reason: 'entry', run }), { priceOf: async () => 101 }));
  ok('a run\'s orders a day are capped (2 here)', !r.ok && /2 orders today/.test(r.error));
  r = await tryCall(() => P.changeRun(env, req({ limits: { maxPositions: 10 }, who: 'neo' }, 'PATCH'), run));
  ok('Neo Quant cannot loosen a limit', !r.ok && r.status === 403 && /never loosen/.test(r.error));
  r = await tryCall(() => P.changeRun(env, req({ capital: 50000, who: 'neo' }, 'PATCH'), run));
  ok('...nor give a run more capital', !r.ok && r.status === 403);
  r = await tryCall(() => P.changeRun(env, req({ limits: { maxPositions: 2 }, who: 'neo' }, 'PATCH'), run));
  ok('...but it can tighten one', r.ok && r.body.run.limits.maxPositions === 2);
  r = await tryCall(() => P.changeRun(env, req({ state: 'paused', who: 'neo' }, 'PATCH'), run));
  ok('pause', r.ok && r.body.run.state === 'paused');
  r = await tryCall(() => P.place(env, req({ order: { ...order, qty: 5 }, who: 'run', reason: 'entry', run }), { priceOf: async () => 101 }));
  ok('a paused run places nothing but closing orders', !r.ok && r.status === 409 && /paused/.test(r.error));

  console.log('\nThe kill switch');
  await tryCall(() => P.place(env, req({ order: { ...order, limit_price: 97 }, who: 'tony' }), { priceOf: async () => 101 }));
  await tryCall(() => P.changeRun(env, req({ state: 'running', who: 'tony' }, 'PATCH'), run));
  A.reset();
  r = await tryCall(() => P.kill(env, req({ on: true })));
  ok('on: every open order canceled at Alpaca, every run paused', r.ok && r.body.kill && A.calls.includes('DELETE https://paper-api.alpaca.markets/v2/orders') && env.DB.sql.prepare("SELECT COUNT(*) AS n FROM paper_runs WHERE state = 'running'").get().n === 0);
  r = await tryCall(() => P.place(env, req({ order: { ...order, limit_price: 96 }, who: 'tony' }), { priceOf: async () => 101 }));
  ok('...then a new order is refused', !r.ok && /kill switch/.test(r.error));
  r = await tryCall(() => P.place(env, req({ order: { ...order, side: 'sell', limit_price: 104 }, who: 'tony', closing: true }), { priceOf: async () => 101 }));
  ok('...a closing order still goes out', r.ok);
  ok('...no run can be resumed or started', !(await tryCall(() => P.changeRun(env, req({ state: 'running', who: 'tony' }, 'PATCH'), run))).ok && !(await tryCall(() => P.startRun(env, req({ name: 'x', spec: { a: 1 }, capital: 5000 })))).ok);
  r = await tryCall(() => P.kill(env, req({ on: false })));
  ok('off again', r.ok && r.body.kill === false && (await read(await P.account(env))).kill === false);
  r = await tryCall(() => P.changeRun(env, req({ state: 'stopped', who: 'tony' }, 'PATCH'), run));
  ok('stop; a stopped run stays stopped', r.ok && r.body.run.state === 'stopped' && !(await tryCall(() => P.changeRun(env, req({ state: 'running', who: 'tony' }, 'PATCH'), run))).ok);

  console.log('\nFills, equity, the log');
  await P.postFills(env, req({ fills: [{ id: 'act1', at: 1, order: 'a1', run, symbol: 'NVDA', side: 'buy', qty: 10, price: 100.5 }, { id: 'act1', at: 1, symbol: 'NVDA', side: 'buy', qty: 10, price: 100.5 }] }));
  ok('fills are kept once each', env.DB.sql.prepare('SELECT COUNT(*) AS n FROM paper_fills').get().n === 1);
  await P.postEquity(env, req({ rows: [{ run: 'account', day: '2026-11-16', equity: 100100 }, { run: 'account', day: '2026-11-16', equity: 100200 }, { run, day: '2026-11-16', equity: 20050 }] }));
  ok('one equity row a run a day (the newest kept)', env.DB.sql.prepare("SELECT equity FROM paper_equity WHERE run = 'account'").get().equity === 100200);
  r = await read(await P.runs(env));
  ok('runs come back with their equity curve', r.runs[0].equity.length === 1 && r.runs[0].equity[0][1] === 20050);
  r = await read(await P.log(env, new URL('https://x/paper/log?run=' + run)));
  ok('the log by run: each order with who and why', r.orders.length >= 2 && r.orders.every((o) => o.run === run && o.who === 'run' && o.reason === 'entry'));
  r = await read(await P.activities(env, new URL('https://x/paper/activities')));
  ok('Alpaca\'s fills, read', r.fills[0].price === 100.5 && r.fills[0].order === 'a1');

  console.log('\nThe same rules on the page and here');
  const VN = await import(pathToFileURL(path.join(PRIV, 'TradeHub', 'core', 'venue.js')).href);
  const table = [order, { ...order, qty: 0 }, { ...order, type: 'market', limit_price: null }, { ...order, type: 'stop', stop_price: 99 }, { ...order, type: 'trailing_stop', trail_percent: 60 }, { ...order, extended_hours: true },
    { ...order, type: 'market', extended_hours: true }, { ...order, qty: 1.5 }, { ...order, type: 'market', qty: 1.5 }, { ...order, notional: 500, qty: null }, { ...order, qty: 400 }, bracket, { ...bracket, take_profit: { limit_price: 90 } },
    { ...order, side: 'sell', order_class: 'bracket', take_profit: { limit_price: 90 }, stop_loss: { stop_price: 105 } }, { ...order, client_order_id: 'x y' }, { ...order, symbol: 'brk.b' }];
  const ctxs = [{ price: 101, equity: 100000 }, { price: 101, stale: true }, { kill: true }, { kill: true, closing: true }];
  const differ = [];
  table.forEach((o, i) => ctxs.forEach((c, j) => { const a = P.checkOrder(o, c), b = VN.checkOrder(o, c); if (a.ok !== b.ok || a.errors.join() !== b.errors.join()) differ.push(i + '/' + j); }));
  ok(`checkOrder in quant-api and in TradeHub agree on ${table.length * ctxs.length} cases`, !differ.length, differ.join(' '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
