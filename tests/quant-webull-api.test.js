// quant-api Webull PAPER broker (Batch 4 T1, A1-Priv docs/TradeHub/quant-trading.md; lib/brokers/webull.js)
// against a faked Webull SANDBOX that answers with replies recorded from the real one on 2026-11-21
// (ids replaced), on a REAL SQLite D1 with every migration: accounts (Individual Margin by default),
// Alpaca-shaped orders and fills, the read cache, the body translation (simple, bracket, trailing,
// extended hours), the shared checks, the log before send (and failing closed before migration 0014),
// replace keeping the time in force, cancel, and this broker's own kill switch.
//
// Run: node tests/quant-webull-api.test.js
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
const WDIR = path.join(__dirname, '..', 'workers2', 'quant-api');
const MIG = path.join(WDIR, 'migrations');
function realD1(skip = []) {
  const sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql') && !skip.includes(x)).sort()) sql.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a.map(norm)),
    async first() { const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
    async all() { return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = sql.prepare(q).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { sql, prepare: (q) => stmt(q), async batch(list) { for (const s of list) await s.run(); return []; } };
}

(async () => {
  console.log('\nWebull paper broker (Batch 4 T1), on replies recorded from the sandbox');
  const WB = await import(pathToFileURL(path.join(WDIR, 'lib', 'brokers', 'webull.js')).href);
  {
    // Recorded 2026-11-21 (ids replaced): the account list, a balance, an order's detail, the open list.
    const ACCTS = [{ account_id: 'FUT1', account_type: 'MARGIN', account_label: 'Futures', account_class: 'FUTURES' }, { account_id: 'MRG1', account_type: 'MARGIN', account_label: 'Individual Margin', account_class: 'INDIVIDUAL_MARGIN' }, { account_id: 'CSH1', account_type: 'CASH', account_label: 'Individual Cash', account_class: 'INDIVIDUAL_CASH' }];
    const BAL = { total_asset_currency: 'USD', total_net_liquidation_value: '1000000.00', total_market_value: '0.00', total_cash_balance: '1000000.00', total_day_profit_loss: '0.00', account_currency_assets: [{ currency: 'USD', cash_balance: '1000000.00', day_buying_power: '4000000', overnight_buying_power: '2000000.00' }] };
    const GROUP = (cid, status, tif = 'GTC', lp = '50.00') => ({ client_order_id: cid, combo_type: 'NORMAL', combo_order_id: 'OID' + cid, orders: [{ symbol: 'AAPL', side: 'BUY', status, fees: [], commission: {}, client_order_id: cid, order_type: 'LIMIT', instrument_type: 'EQUITY', order_id: 'OID' + cid, support_trading_session: 'CORE', entrust_type: 'QTY', total_quantity: '1', filled_quantity: '0', place_time_at: '2026-11-21T22:44:54.339Z', time_in_force: tif, limit_price: lp }] });
    const mkEnv = () => ({ DB: realD1(), WEBULL_PAPER_KEY: 'K', WEBULL_PAPER_SECRET: 'S' });
    const calls = [];
    let open = [], positionsRaw = [], placeReply = { status: 200, body: { client_order_id: 'x', order_id: 'OIDx' } };
    const fake = async (u, init) => {
      const url = new URL(u); calls.push({ m: init.method, p: url.pathname, q: Object.fromEntries(url.searchParams), h: init.headers, b: init.body ? JSON.parse(init.body) : null });
      const R = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
      if (url.host !== 'api.sandbox.webull.com') return R({ message: 'wrong host' }, 500);
      if (url.pathname === '/openapi/account/list') return R(ACCTS);
      if (url.pathname === '/openapi/assets/balance') return R(BAL);
      if (url.pathname === '/openapi/assets/positions') return R(positionsRaw);
      if (url.pathname === '/trading/orders/open-orders/list') return R({ data: open });
      if (url.pathname === '/trading/orders/historical-orders/list') return R({ data: [GROUP('h1', 'CANCELLED'), { ...GROUP('h2', 'FILLED', 'DAY'), orders: [{ ...GROUP('h2', 'FILLED').orders[0], filled_quantity: '1', filled_price: '49.90', filled_time_at: '2026-11-20T15:00:00.000Z' }] }] });
      if (url.pathname === '/trading/orders/get') return R(GROUP(url.searchParams.get('client_order_id'), 'SUBMITTED'));
      if (url.pathname === '/trading/orders/place') return R(placeReply.body, placeReply.status);
      if (url.pathname === '/trading/orders/replace' || url.pathname === '/trading/orders/cancel') return R({ client_order_id: 'x', order_id: 'OIDx' });
      return R({ message: 'no route' }, 404);
    };
    const U = (q = '') => new URL('https://quant-api.test/trade/webull/x' + q);
    const body = async (res) => JSON.parse(await res.text());
    const req = (b) => new Request('https://quant-api.test/x', { method: 'POST', body: JSON.stringify(b) });
    WB.clearCache();
    let env = mkEnv();
    let a = await body(await WB.account(env, U(), fake));
    ok('account: Individual Margin by default, in lib/paper.js\'s shape, with every account listed', a.account.id === 'MRG1' && a.account.equity === 1000000 && a.account.cash === 1000000 && a.account.day_buying_power === 4000000 && a.accounts.length === 3 && a.broker === 'webull', JSON.stringify(a).slice(0, 300));
    WB.clearCache();
    a = await body(await WB.account(env, U('?account=CSH1'), fake));
    ok('...?account= picks another of his accounts', a.account.id === 'CSH1');
    const n0 = calls.length;
    await WB.account(env, U('?account=CSH1'), fake); await WB.account(env, U('?account=CSH1'), fake);
    ok('reads within 3 s are served from the cache (Webull allows 2 reads per 2 s)', calls.length === n0);
    WB.clearCache(); open = [GROUP('o1', 'SUBMITTED')];
    const ol = await body(await WB.orders(env, U('?status=open'), fake));
    ok('open orders come back Alpaca-shaped (id = client order id, lower-case side/type/status)', ol.orders.length === 1 && ol.orders[0].id === 'o1' && ol.orders[0].broker_id === 'OIDo1' && ol.orders[0].side === 'buy' && ol.orders[0].type === 'limit' && ol.orders[0].status === 'new' && ol.orders[0].limit_price === 50 && ol.orders[0].time_in_force === 'gtc');
    const cl = await body(await WB.orders(env, U('?status=closed'), fake));
    ok('closed orders from the history: canceled and filled', cl.orders.map((o) => o.status).join() === 'canceled,filled');
    const fl = await body(await WB.activities(env, U(), fake));
    ok('fills: one per filled order, with its price', fl.fills.length === 1 && fl.fills[0].price === 49.9 && fl.fills[0].symbol === 'AAPL' && fl.fills[0].id === 'wb:OIDh2');
    // Translation, pure.
    const simple = WB.webullBody({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limit_price: 50, time_in_force: 'gtc' }, 'MRG1', 'c1');
    ok('a limit order becomes the body the sandbox took (NORMAL, EQUITY, US, CORE, QTY, strings)', JSON.stringify(simple) === JSON.stringify({ account_id: 'MRG1', new_orders: [{ client_order_id: 'c1', combo_type: 'NORMAL', symbol: 'AAPL', instrument_type: 'EQUITY', market: 'US', side: 'BUY', order_type: 'LIMIT', time_in_force: 'GTC', support_trading_session: 'CORE', entrust_type: 'QTY', quantity: '1', limit_price: '50' }] }), JSON.stringify(simple));
    const br = WB.webullBody({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 2, limit_price: 50, time_in_force: 'day', order_class: 'bracket', take_profit: { limit_price: 60 }, stop_loss: { stop_price: 45 } }, 'MRG1', 'c2');
    ok('a bracket becomes MASTER + STOP_PROFIT (sell limit) + STOP_LOSS (sell stop), one combo id', br.client_combo_order_id === 'c2' && br.new_orders.map((l) => l.combo_type + ':' + l.side + ':' + l.order_type).join() === 'MASTER:BUY:LIMIT,STOP_PROFIT:SELL:LIMIT,STOP_LOSS:SELL:STOP_LOSS' && br.new_orders[2].stop_price === '45' && br.new_orders.every((l) => l.quantity === '2'));
    const tr = WB.webullBody({ symbol: 'AAPL', side: 'sell', type: 'trailing_stop', qty: 1, trail_percent: 2, time_in_force: 'day' }, 'MRG1', 'c3');
    ok('a 2% trailing stop: PERCENTAGE with step 0.02; extended hours → session ALL', tr.new_orders[0].trailing_type === 'PERCENTAGE' && tr.new_orders[0].trailing_stop_step === '0.02'
      && WB.webullBody({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limit_price: 5, time_in_force: 'day', extended_hours: true }, 'M', 'c4').new_orders[0].support_trading_session === 'ALL');
    // Placing: checked, logged BEFORE it is sent, then sent with the category header.
    WB.clearCache(); calls.length = 0;
    env = mkEnv();
    const order = { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limit_price: 50, time_in_force: 'gtc', client_order_id: 'tok1' };
    let r = await body(await WB.place(env, req({ order, who: 'tony' }), U(), { fetchFn: fake, priceOf: async () => 270 }));
    const placeCall = calls.find((c) => c.p === '/trading/orders/place');
    ok('a good order goes out: v3, signed, category US_EQUITY, the client id kept', r.ok && r.order.id === 'tok1' && placeCall && placeCall.h['x-version'] === 'v3' && placeCall.h.category === 'US_EQUITY' && placeCall.b.new_orders[0].client_order_id === 'tok1', JSON.stringify(r).slice(0, 200));
    let e1 = null;
    try { await WB.place(env, req({ order: { ...order, qty: 5000, limit_price: 100, client_order_id: 'tok2' }, who: 'tony' }), U(), { fetchFn: fake, priceOf: async () => 270 }); } catch (x) { e1 = x; }
    ok('an order over 25% of the account is refused by the shared check, and never sent', e1 && e1.status === 422 && /25%/.test(e1.message) && !calls.some((c) => c.b && c.b.new_orders && c.b.new_orders[0].client_order_id === 'tok2'));
    let e2 = null;
    try { await WB.place(env, req({ order: { ...order, client_order_id: 'tok3' }, who: 'neo' }), U(), { fetchFn: fake }); } catch (x) { e2 = x; }
    ok('Neo Quant or a strategy must give a reason', e2 && e2.status === 400 && /reason/.test(e2.message));
    let e3 = null;
    try { await WB.place(env, req({ order: { ...order, type: 'trailing_stop', trail_percent: 2, limit_price: undefined, side: 'sell', client_order_id: 'tok4' }, who: 'tony', closing: false }), U(), { fetchFn: fake, priceOf: async () => 270 }); } catch (x) { e3 = x; }
    ok('a GTC trailing stop is refused before it is sent (Webull: day only)', e3 && e3.status === 422 && /day orders only/.test(e3.message));
    placeReply = { status: 417, body: { message: 'Orders cannot be placed at this time.', error_code: 'OPENAPI_CAN_NOT_TRADING_FOR_NON_TRADING_HOURS' } };
    let e4 = null;
    try { await WB.place(env, req({ order: { ...order, time_in_force: 'day', client_order_id: 'tok5' }, who: 'tony' }), U(), { fetchFn: fake, priceOf: async () => 270 }); } catch (x) { e4 = x; }
    ok('Webull\'s own refusal (outside market hours) comes back in its words', e4 && e4.status === 422 && /cannot be placed at this time/.test(e4.message) && e4.extra && e4.extra.code === 'OPENAPI_CAN_NOT_TRADING_FOR_NON_TRADING_HOURS', e4 && JSON.stringify([e4.message, e4.extra]));
    placeReply = { status: 200, body: { client_order_id: 'x', order_id: 'OIDx' } };

    // The order log: every order is in paper_orders with broker 'webull' BEFORE it is sent, then marked.
    const row = env.DB.sql.prepare("SELECT * FROM paper_orders WHERE id = 'tok1'").get();
    ok('the order was logged as a Webull order, who and status, with the broker\'s id after the answer', row && row.broker === 'webull' && row.who === 'tony' && row.status === 'new' && row.alpaca_id === 'OIDx', JSON.stringify(row));
    const refused = env.DB.sql.prepare("SELECT status, error FROM paper_orders WHERE id = 'tok5'").get();
    ok('...an order Webull refused is kept in the log as refused, with its words', refused && refused.status === 'refused' && /cannot be placed/.test(refused.error));
    ok('...an order the check refused never reached the log or Webull', !env.DB.sql.prepare("SELECT 1 FROM paper_orders WHERE id = 'tok2'").get());
    // Without migration 0014 the log has no broker column: nothing is sent (fails closed).
    const old = { DB: realD1(['0014_broker.sql']), WEBULL_PAPER_KEY: 'K', WEBULL_PAPER_SECRET: 'S' };
    WB.clearCache(); calls.length = 0;
    let e6 = null;
    try { await WB.place(old, req({ order: { ...order, client_order_id: 'tok7' }, who: 'tony' }), U(), { fetchFn: fake, priceOf: async () => 270 }); } catch (x) { e6 = x; }
    ok('before migration 0014 a Webull order is refused with the reason, and never sent', e6 && e6.status === 503 && /0014_broker/.test(e6.message) && !calls.some((c) => c.p === '/trading/orders/place'));
    // Replace keeps the order's time in force (the sandbox refuses a GTC → DAY change); cancel; the kill switch.
    calls.length = 0;
    r = await body(await WB.replace(env, new Request('https://q/x', { method: 'PATCH', body: JSON.stringify({ limit_price: 51, who: 'tony' }) }), U(), 'o1', { fetchFn: fake, priceOf: async () => 270 }));
    const rc = calls.find((c) => c.p === '/trading/orders/replace');
    ok('replace sends the new price and keeps GTC', r.ok && rc && rc.b.modify_orders[0].limit_price === '51' && rc.b.modify_orders[0].time_in_force === 'GTC' && rc.b.modify_orders[0].client_order_id === 'o1');
    r = await body(await WB.cancel(env, U(), 'o1', fake));
    ok('cancel posts the client order id', r.canceled === 'o1' && calls.some((c) => c.p === '/trading/orders/cancel' && c.b.client_order_id === 'o1'));
    WB.clearCache(); calls.length = 0; open = [GROUP('o1', 'SUBMITTED'), GROUP('o2', 'PARTIAL_FILLED')];
    r = await body(await WB.kill(env, req({ on: true }), U(), fake));
    ok('the Webull kill switch cancels every open order one by one', r.kill === true && r.canceled === 2 && calls.filter((c) => c.p === '/trading/orders/cancel').length === 2);
    let e5 = null;
    try { await WB.place(env, req({ order: { ...order, client_order_id: 'tok6' }, who: 'tony' }), U(), { fetchFn: fake, priceOf: async () => 270 }); } catch (x) { e5 = x; }
    ok('...and with it on, a new order is refused', e5 && e5.status === 422 && /kill switch/i.test(e5.message));
    await WB.kill(env, req({ on: false }), U(), fake);
    ok('...switching it off lets orders out again; Alpaca\'s switch is a separate key', (await env.DB.prepare("SELECT v FROM meta WHERE k = 'webull_kill'").first()).v === '0');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
