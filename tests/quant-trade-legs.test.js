// quant-api TR1 (A1-Priv docs/TradeHub/quant-trading-refine-1.md): order legs and cancels, on a fake Alpaca PAPER API
// that behaves as the real one did on 2026-11-23 (measured with 1-share orders), and on Webull's sandbox replies:
//   - a replaced order cancels through its replacement (Alpaca's replaced_by), never "already in replaced state"
//   - after a bracket's entry fills, the open list's lone take profit is swapped for its parent with BOTH legs
//   - dropping a leg before the fill: the bracket is cancelled, then the entry is placed again with the other leg (OTO)
//   - dropping a leg after the fill: the cancel takes the other exit too, which is placed again on its own (closing)
//   - the kill switch refuses re-placing an entry; a leg that is not part of the order is refused
//   - Webull: a bracket's parts (one combo id) become one order with legs, held while the entry waits; a drop cancels
//     the leg alone (the sandbox keeps the rest) and puts nothing back
//
// Run: node tests/quant-trade-legs.test.js
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

/* ── a fake Alpaca that keeps brackets the way the real one does ──────────── */
const A = { orders: new Map(), next: 1, calls: [], held: 0, reset() { this.orders.clear(); this.calls.length = 0; this.held = 0; } };
const res = (body, status = 200) => new Response(body == null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const nested = (o) => ({ ...o, legs: (o.legIds || []).map((id) => A.orders.get(id)) });
const OPEN = new Set(['new', 'accepted', 'held', 'pending_new']);
function addOrder(b, extra = {}) {
  const o = { id: 'a' + (A.next++), status: extra.status || 'new', symbol: b.symbol, side: b.side, type: b.type, qty: String(b.qty), time_in_force: b.time_in_force, limit_price: b.limit_price || null, stop_price: b.stop_price || null,
    order_class: b.order_class || 'simple', filled_qty: '0', replaced_by: null, client_order_id: b.client_order_id || null, legIds: [] };
  A.orders.set(o.id, o);
  const exit = b.side === 'buy' ? 'sell' : 'buy';
  if (b.take_profit) { const l = addOrder({ symbol: b.symbol, side: exit, type: 'limit', qty: b.qty, time_in_force: b.time_in_force, limit_price: b.take_profit.limit_price, order_class: o.order_class }, { status: b.order_class === 'oco' ? 'new' : 'held' }); o.legIds.push(l.id); l.parent = o.id; }
  if (b.stop_loss) { const l = addOrder({ symbol: b.symbol, side: exit, type: 'stop', qty: b.qty, time_in_force: b.time_in_force, stop_price: b.stop_loss.stop_price, order_class: o.order_class }, { status: 'held' }); o.legIds.push(l.id); l.parent = o.id; }
  return o;
}
function cancelGroup(o) { o.status = 'canceled'; for (const id of o.legIds) A.orders.get(id).status = 'canceled'; }
const fakeFetch = async (url, init = {}) => {
  const u = new URL(String(url)), m = (init.method || 'GET').toUpperCase(), p = u.pathname;
  A.calls.push(m + ' ' + p + u.search);
  if (u.origin !== 'https://paper-api.alpaca.markets') return res({ message: 'not the paper host' }, 599);
  if (p === '/v2/account') return res({ status: 'ACTIVE', equity: '100000', last_equity: '100000', cash: '100000', buying_power: '400000' });
  if (p.startsWith('/v2/positions/') && m === 'GET') { const sym = p.split('/').pop(); return sym === 'F' ? res({ symbol: 'F', qty: String(A.held), side: 'long' }) : res({ message: 'position does not exist' }, 404); }
  if (p === '/v2/orders' && m === 'POST') { const b = JSON.parse(init.body); return res(nested(addOrder({ ...b, qty: Number(b.qty), limit_price: b.limit_price, stop_price: b.stop_price }))); }
  if (p === '/v2/orders' && m === 'GET') {
    const st = u.searchParams.get('status'), top = [...A.orders.values()].filter((o) => !o.parent);
    if (st === 'open') {
      // The real API: a filled bracket's take profit shows alone (top level, no legs); its held stop does not show.
      const out = top.filter((o) => OPEN.has(o.status)).map(nested);
      for (const o of top) if (o.status === 'filled') for (const id of o.legIds) { const l = A.orders.get(id); if (l.status === 'new') out.push({ ...l, legs: [] }); }
      return res(out);
    }
    return res(top.map(nested).reverse());
  }
  const mm = /^\/v2\/orders\/([\w-]+)$/.exec(p);
  if (mm) {
    const o = A.orders.get(mm[1]);
    if (!o) return res({ message: 'order not found' }, 404);
    if (m === 'GET') return res(nested(o));
    if (m === 'PATCH') {   // a replace answers a NEW order; the old one turns "replaced"
      const b = JSON.parse(init.body), n = { ...o, id: 'a' + (A.next++), ...b, legIds: [...o.legIds], replaced_by: null };
      o.status = 'replaced'; o.replaced_by = n.id; A.orders.set(n.id, n);
      if (o.parent) { const par = A.orders.get(o.parent); par.legIds = par.legIds.map((x) => (x === o.id ? n.id : x)); }
      return res(nested(n));
    }
    if (m === 'DELETE') {
      if (o.status === 'replaced') return res({ message: 'order is already in "replaced" state' }, 422);
      if (!OPEN.has(o.status)) return res({ message: 'order is already in "' + o.status + '" state' }, 422);
      if (o.parent) {
        const par = A.orders.get(o.parent);
        if (par.order_class !== 'oco' && OPEN.has(par.status)) cancelGroup(par);              // a held leg takes the whole bracket
        else { for (const id of par.legIds) A.orders.get(id).status = 'canceled'; if (par.order_class === 'oco') par.status = 'canceled'; }   // an exit takes the other one
      } else if (o.order_class === 'oco') cancelGroup(o);
      else cancelGroup(o);
      return res(null, 204);
    }
  }
  return res({ message: 'not faked: ' + m + ' ' + p }, 500);
};
const req = (body) => new Request('https://x/', { method: 'POST', body: JSON.stringify(body) });
const read = async (r) => r.json();
const noWait = async () => {};

(async () => {
  const P = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'lib', 'paper.js')).href);
  const WB = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'lib', 'brokers', 'webull.js')).href);
  const env = { ALPACA_KEY: 'PKTEST', ALPACA_SECRET: 'SECRET', DB: realD1() };

  console.log('\nA replaced order cancels (Tony #34)');
  A.reset();
  const lim = addOrder({ symbol: 'F', side: 'buy', type: 'limit', qty: 1, time_in_force: 'gtc', limit_price: '10' });
  const moved = await read(await P.replace(env, new Request('https://x/', { method: 'PATCH', body: JSON.stringify({ limit_price: 10.1, who: 'tony' }) }), lim.id, { fetchFn: fakeFetch, priceOf: async () => 11.6 }));
  ok('a replace answers a new id (as Alpaca does)', moved.order.id !== lim.id && A.orders.get(lim.id).status === 'replaced');
  const c = await read(await P.cancel(env, lim.id, fakeFetch, { wait: noWait }));
  ok('cancelling the OLD id cancels its replacement', c.ok && c.canceled === moved.order.id && A.orders.get(moved.order.id).status === 'canceled', JSON.stringify(c));
  let threw = null; try { await P.cancel(env, 'nope', fakeFetch, { wait: noWait }); } catch (e) { threw = e; }
  ok('an unknown order is fine (already gone)', threw === null);

  console.log('\nThe stop leg after a fill is not lost');
  A.reset();
  const br = addOrder({ symbol: 'F', side: 'buy', type: 'market', qty: 1, time_in_force: 'day', order_class: 'bracket', take_profit: { limit_price: '12.5' }, stop_loss: { stop_price: '10.5' } });
  br.status = 'filled'; br.filled_qty = '1'; A.held = 1;
  A.orders.get(br.legIds[0]).status = 'new';   // the take profit works; the stop stays held (Alpaca's OCO)
  let r = await read(await P.orders(env, new URL('https://x/paper/orders?status=open'), fakeFetch));
  ok('the open list has the filled parent with BOTH legs, not a lone take profit', r.orders.length === 1 && r.orders[0].id === br.id && r.orders[0].legs.length === 2 && r.orders[0].legs.some((l) => l.type === 'stop'), JSON.stringify(r.orders.map((o) => [o.id, o.legs && o.legs.length])));
  const before = A.calls.length;
  A.reset(); addOrder({ symbol: 'F', side: 'buy', type: 'limit', qty: 1, time_in_force: 'gtc', limit_price: '10' });
  await P.orders(env, new URL('https://x/paper/orders?status=open'), fakeFetch);
  ok('no extra read when nothing is hidden', A.calls.length === 1, A.calls.join(' | ') + ' ' + before);

  console.log('\nDrop a leg before the fill (Tony #37)');
  A.reset();
  const b1 = addOrder({ symbol: 'F', side: 'buy', type: 'limit', qty: 1, time_in_force: 'gtc', limit_price: '10', order_class: 'bracket', take_profit: { limit_price: '10.5' }, stop_loss: { stop_price: '9.5' } });
  const [tp1, sl1] = b1.legIds;
  r = await read(await P.dropLeg(env, req({ parent: b1.id, who: 'tony' }), sl1, { fetchFn: fakeFetch, wait: noWait }));
  const again = A.orders.get(r.order.id);
  ok('the old bracket is cancelled', A.orders.get(b1.id).status === 'canceled');
  ok('the entry is placed again with the take profit kept (an OTO), same price and size', again && again.order_class === 'oto' && again.limit_price === '10' && again.qty === '1' && nested(again).legs.length === 1 && nested(again).legs[0].type === 'limit' && nested(again).legs[0].limit_price === '10.5', JSON.stringify(again && nested(again)));
  ok('it says what happened, and that the take profit stayed', r.kept === 'tp' && /cancelled/.test(r.steps.join()) && /without its stop loss/.test(r.steps.join()), JSON.stringify(r));
  const row = env.DB.sql.prepare("SELECT * FROM paper_orders WHERE reason LIKE 'dropped the stop loss%'").get();
  ok('the new order is logged with who and why before it went out', row && row.who === 'tony' && row.alpaca_id === r.order.id);
  A.reset();
  const b2 = addOrder({ symbol: 'F', side: 'buy', type: 'limit', qty: 1, time_in_force: 'gtc', limit_price: '10', order_class: 'oto', stop_loss: { stop_price: '9.5' } });
  r = await read(await P.dropLeg(env, req({ parent: b2.id, who: 'tony' }), b2.legIds[0], { fetchFn: fakeFetch, wait: noWait }));
  ok('an OTO without its only leg goes back as a plain limit', A.orders.get(r.order.id).order_class === 'simple' && r.kept === null);
  env.DB.sql.exec("INSERT INTO meta (k, v, at) VALUES ('paper_kill', '1', 1)");
  A.reset();
  const b3 = addOrder({ symbol: 'F', side: 'buy', type: 'limit', qty: 1, time_in_force: 'gtc', limit_price: '10', order_class: 'bracket', take_profit: { limit_price: '10.5' }, stop_loss: { stop_price: '9.5' } });
  threw = null; try { await P.dropLeg(env, req({ parent: b3.id, who: 'tony' }), b3.legIds[0], { fetchFn: fakeFetch, wait: noWait }); } catch (e) { threw = e; }
  ok('the kill switch refuses placing an entry again (nothing cancelled)', threw && threw.status === 409 && A.orders.get(b3.id).status === 'new');
  env.DB.sql.exec("DELETE FROM meta WHERE k = 'paper_kill'");
  threw = null; try { await P.dropLeg(env, req({ parent: b3.id, who: 'tony' }), 'a999', { fetchFn: fakeFetch, wait: noWait }); } catch (e) { threw = e; }
  ok('a leg that is not part of the order is refused', threw && threw.status === 404);
  threw = null; try { await P.dropLeg(env, req({ parent: b3.id }), b3.legIds[0], { fetchFn: fakeFetch, wait: noWait }); } catch (e) { threw = e; }
  ok('who is required', threw && threw.status === 400);

  console.log('\nDrop a leg after the fill');
  A.reset();
  const b4 = addOrder({ symbol: 'F', side: 'buy', type: 'market', qty: 1, time_in_force: 'gtc', order_class: 'bracket', take_profit: { limit_price: '12.5' }, stop_loss: { stop_price: '10.5' } });
  b4.status = 'filled'; b4.filled_qty = '1'; A.held = 1; A.orders.get(b4.legIds[0]).status = 'new';
  r = await read(await P.dropLeg(env, req({ parent: b4.id, who: 'tony' }), b4.legIds[0], { fetchFn: fakeFetch, wait: noWait }));
  const put = A.orders.get(r.order && r.order.id);
  ok('the take profit is cancelled and the stop Alpaca took with it is back on its own', A.orders.get(b4.legIds[0]).status === 'canceled' && put && put.type === 'stop' && put.side === 'sell' && put.stop_price === '10.5' && put.order_class === 'simple' && put.time_in_force === 'gtc', JSON.stringify(r));
  ok('the steps say both', /take profit was cancelled/.test(r.steps.join()) && /stop loss was placed again/.test(r.steps.join()));
  A.reset();
  const b5 = addOrder({ symbol: 'F', side: 'buy', type: 'market', qty: 5, time_in_force: 'gtc', order_class: 'bracket', take_profit: { limit_price: '12.5' }, stop_loss: { stop_price: '10.5' } });
  b5.status = 'filled'; b5.filled_qty = '5'; A.held = 2; A.orders.get(b5.legIds[0]).status = 'new';
  threw = null; try { await P.dropLeg(env, req({ parent: b5.id, who: 'tony' }), b5.legIds[0], { fetchFn: fakeFetch, wait: noWait }); } catch (e) { threw = e; }
  ok('a kept exit larger than the position is not placed again, and it says so', threw && threw.status === 409 && /no longer matches the position/.test(threw.message));

  console.log('\nWebull: one order per bracket');
  const g = (cid, combo, side, type, extra = {}) => ({ combo_order_id: 'C1', combo_type: combo, orders: [{ client_order_id: cid, order_id: 'B' + cid, combo_type: combo, symbol: 'F', side, order_type: type, total_quantity: '1', filled_quantity: '0', status: 'SUBMITTED', time_in_force: 'DAY', ...extra }] });
  const list = WB.ordersOut([g('x1m', 'MASTER', 'BUY', 'LIMIT', { limit_price: '10' }), g('x1s', 'STOP_LOSS', 'SELL', 'STOP_LOSS', { stop_price: '9.5' }), g('x1p', 'STOP_PROFIT', 'SELL', 'LIMIT', { limit_price: '10.5' }),
    { combo_order_id: 'N1', combo_type: 'NORMAL', orders: [{ client_order_id: 'n1', order_id: 'Bn1', combo_type: 'NORMAL', symbol: 'AAPL', side: 'BUY', order_type: 'LIMIT', total_quantity: '1', status: 'SUBMITTED', limit_price: '50', time_in_force: 'GTC' }] }]);
  ok('three parts with one combo id become one bracket with two legs', list.length === 2 && list[0].id === 'x1m' && list[0].order_class === 'bracket' && list[0].legs.length === 2, JSON.stringify(list.map((o) => [o.id, o.order_class, (o.legs || []).length])));
  ok('the legs wait for the entry (held), as Alpaca says it', list[0].legs.every((l) => l.status === 'held'));
  ok('a plain order is left alone', list[1].id === 'n1' && list[1].order_class === 'simple' && !list[1].legs.length);
  const filled = WB.ordersOut([g('y1s', 'STOP_LOSS', 'SELL', 'STOP_LOSS', { stop_price: '9.5' }), g('y1p', 'STOP_PROFIT', 'SELL', 'LIMIT', { limit_price: '10.5' })]);
  ok('after the fill (no MASTER) the two exits are one OCO pair, take profit first', filled.length === 1 && filled[0].id === 'y1p' && filled[0].order_class === 'oco' && filled[0].legs[0].id === 'y1s' && filled[0].legs[0].status === 'new');

  console.log('\nWebull: drop a leg');
  const W = { calls: [], open: [g('z1m', 'MASTER', 'BUY', 'LIMIT', { limit_price: '10' }), g('z1s', 'STOP_LOSS', 'SELL', 'STOP_LOSS', { stop_price: '9.5' }), g('z1p', 'STOP_PROFIT', 'SELL', 'LIMIT', { limit_price: '10.5' })] };
  const wfetch = async (url, init = {}) => {
    const u = new URL(String(url)), p = u.pathname; W.calls.push((init.method || 'GET') + ' ' + p);
    if (u.origin !== 'https://api.sandbox.webull.com') return res({ message: 'not the sandbox' }, 599);
    if (p === '/openapi/account/list') return res([{ account_id: 'ACC', account_class: 'INDIVIDUAL_MARGIN', account_label: 'Individual Margin' }]);
    if (p === '/trading/orders/open-orders/list') return res(W.open);
    if (p === '/trading/orders/cancel') { const b = JSON.parse(init.body); W.open = W.open.filter((x) => x.orders[0].client_order_id !== b.client_order_id); return res({ client_order_id: b.client_order_id }); }
    if (p === '/trading/orders/get') { const id = u.searchParams.get('client_order_id'), hit = W.open.find((x) => x.orders[0].client_order_id === id); return res(hit || { ...g(id, 'STOP_PROFIT', 'SELL', 'LIMIT'), orders: [{ ...g(id, 'STOP_PROFIT', 'SELL', 'LIMIT').orders[0], status: 'CANCELLED' }] }); }
    if (p === '/trading/orders/place') return res({ order_id: 'NEW' });
    return res({ message: 'not faked ' + p }, 500);
  };
  const wenv = { WEBULL_PAPER_KEY: 'k', WEBULL_PAPER_SECRET: 's', DB: realD1() };
  WB.clearCache();
  r = await read(await WB.dropLeg(wenv, req({ parent: 'z1m', who: 'tony' }), new URL('https://x/'), 'z1s', { fetchFn: wfetch, wait: noWait }));
  ok('the stop loss alone is cancelled; the entry and take profit stand; nothing is placed', r.ok && W.open.length === 2 && !W.calls.some((x) => /place/.test(x)) && r.kept === 'tp', JSON.stringify(r) + ' ' + W.calls.join(','));
  WB.clearCache();
  threw = null; try { await WB.dropLeg(wenv, req({ parent: 'z1m', who: 'tony' }), new URL('https://x/'), 'zzz9', { fetchFn: wfetch, wait: noWait }); } catch (e) { threw = e; }
  ok('Webull: a leg that is not part of the order is refused', threw && threw.status === 404);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
