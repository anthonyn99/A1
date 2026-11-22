// TradeHub Batch 4 T7: trade alerts, worker side (A1-Priv docs/TradeHub/quant/t4-07.md; workers2/quant-api/lib/order-watch.js,
// lib/alerts.js kind `order` + config `trading`, worker.js cron). A paper order filled, partly filled, cancelled or rejected
// → an alert of kind `order` through fire() (the bell + /quant-push), in words; per event and per broker switches; the
// first run only learns (no flood); one read per broker a minute and NO D1 write on a quiet minute; a partial fill new
// each time it grows; a broker that fails does not stop the other; off = not one read past the config.
//
// Run: node tests/quant-order-watch.test.js
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
  const db = { sql, reads: 0, writes: 0 };
  const isRead = (q) => /^\s*SELECT/i.test(q);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a.map(norm)),
    async first() { db.reads++; const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
    async all() { db.reads++; return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
    async run() { if (isRead(q)) db.reads++; else db.writes++; const r = sql.prepare(q).run(...args); return { meta: { changes: r.changes } }; },
  });
  db.prepare = (q) => stmt(q);
  db.batch = async (list) => { for (const s of list) await s.run(); return []; };
  return db;
}
const NOW = Date.UTC(2026, 10, 23, 15, 0);   // Monday 10:00 New York

(async () => {
  const W = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'lib', 'order-watch.js')).href);
  const A = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'lib', 'alerts.js')).href);
  const src = fs.readFileSync(path.join(__dirname, '..', 'workers2', 'quant-api', 'worker.js'), 'utf8');

  console.log('\nThe kind and its config');
  ok('`order` is an alert kind, on by default, pushed outside market hours too, no TaskHub card', A.KINDS.includes('order') && A.DEFAULT_CFG.kinds.order === true && A.DEFAULT_CFG.marketOnly.order === false && A.DEFAULT_CFG.cards.order === false);
  const c0 = A.configOf({});
  ok('trading switches by default: filled, partly filled and rejected on; his own cancels quiet; both brokers on', c0.trading.filled && c0.trading.partial && !c0.trading.canceled && c0.trading.rejected && c0.trading.alpaca && c0.trading.webull);
  ok('a stored config keeps its switches; junk falls back', A.configOf({ trading: { filled: false, webull: false, canceled: 'yes' } }).trading.filled === false && A.configOf({ trading: { webull: false } }).trading.webull === false && A.configOf({ trading: { canceled: 'yes' } }).trading.canceled === false);
  ok('a standing rule for `order` when he has none (B10)', A.standingRules(c0, [], ['order']).length === 1);
  ok('Send every kind once now includes a filled order (12 kinds)', A.TEST_KINDS.length === 12 && A.TEST_KINDS.some((t) => t.kind === 'order' && /^Filled: /.test(t.title)));
  ok('the cron runs the watch beside the check; POST /alerts/orders-check runs it on demand', /orderWatch\.watch\(env, t\)/.test(src) && /'\/alerts\/orders-check'/.test(src));

  console.log('\nEvents and words');
  const evs = W.eventsOf([{ id: 'a', symbol: 'NVDA', side: 'buy', type: 'limit', qty: 10, filled_qty: 10, filled_avg_price: 164.2, status: 'filled',
    legs: [{ id: 'a-tp', symbol: 'NVDA', side: 'sell', type: 'limit', qty: 10, limit_price: 175, status: 'new' }, { id: 'a-sl', symbol: 'NVDA', side: 'sell', type: 'stop', qty: 10, stop_price: 150, status: 'canceled' }] },
    { id: 'b', symbol: 'AMD', side: 'buy', type: 'limit', qty: 10, filled_qty: 4, status: 'partially_filled' }, { id: 'c', status: 'expired' }, { id: 'd', symbol: 'X', status: 'rejected', side: 'sell', type: 'market', qty: 1 }]);
  ok('filled, a leg cancelled, a partial (keyed by its filled qty), a rejection; open and expired orders make none', evs.map((e) => e.key).join() === 'a:filled,a-sl:canceled,b:partial:4,d:rejected', evs.map((e) => e.key).join());
  const wf = W.wordsOf('alpaca', 'filled', evs[0].o);
  ok('"Filled: Buy 10 NVDA at 164.20" / "Alpaca paper · limit order"', wf.title === 'Filled: Buy 10 NVDA at 164.20' && wf.body === 'Alpaca paper · limit order', JSON.stringify(wf));
  ok('"Partly filled: Buy 4 of 10 AMD"', W.wordsOf('webull', 'partial', evs[2].o).title === 'Partly filled: Buy 4 of 10 AMD' && /^Webull paper/.test(W.wordsOf('webull', 'partial', evs[2].o).body));
  ok('"Cancelled: Sell 10 NVDA stop 150.00"', W.wordsOf('alpaca', 'canceled', evs[1].o).title === 'Cancelled: Sell 10 NVDA stop 150.00');

  console.log('\nThe watch');
  const orders = { alpaca: [{ id: 'o1', symbol: 'NVDA', side: 'buy', type: 'limit', qty: 10, limit_price: 160, status: 'new' }], webull: [] };
  const fakeFetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify(orders.alpaca), { status: 200, headers: { 'content-type': 'application/json' } }); };
  let calls = [];
  const wbReads = []; W.BROKERS.webull.read = async () => { wbReads.push(1); if (orders.webullFail) throw new Error('Webull refused'); return orders.webull; };
  const env = { DB: realD1(), ALPACA_KEY: 'k', ALPACA_SECRET: 's', WEBULL_PAPER_KEY: 'k', WEBULL_PAPER_SECRET: 's' };
  const pushes = []; const send = async (e, msg) => { pushes.push(msg); return { ok: true, devices: ['pc'] }; };
  let r = await W.watch(env, NOW, { send, fetchFn: fakeFetch });
  ok('the first run learns what is there, alerts nothing', r.brokers.alpaca.learned && r.brokers.webull.learned && !pushes.length);
  ok('...one Alpaca read: its latest 100 orders, legs nested', calls.length === 1 && /\/v2\/orders\?status=all&limit=100&direction=desc&nested=true$/.test(calls[0]) && /^https:\/\/paper-api\.alpaca\.markets\//.test(calls[0]), calls.join());
  env.DB.writes = 0; env.DB.reads = 0; calls = [];
  r = await W.watch(env, NOW + 60000, { send, fetchFn: fakeFetch });
  ok('a quiet minute: no D1 write, 2 reads (config, seen keys), one read per broker', env.DB.writes === 0 && env.DB.reads === 2 && calls.length === 1 && wbReads.length === 2, JSON.stringify({ w: env.DB.writes, r: env.DB.reads }));
  orders.alpaca[0] = { ...orders.alpaca[0], status: 'partially_filled', filled_qty: 4, filled_avg_price: 159.98 };
  r = await W.watch(env, NOW + 120000, { send, fetchFn: fakeFetch });
  ok('a partial fill → one alert, kind order, its words, a link to Trading on Alpaca', pushes.length === 1 && pushes[0].kind === 'order' && pushes[0].title === 'Partly filled: Buy 4 of 10 NVDA at 159.98' && /#alert=trading:alpaca$/.test(pushes[0].url), JSON.stringify(pushes));
  orders.alpaca[0] = { ...orders.alpaca[0], filled_qty: 7 };
  await W.watch(env, NOW + 180000, { send, fetchFn: fakeFetch });
  ok('...it grows (7 of 10): a new alert', pushes.length === 2 && /Buy 7 of 10/.test(pushes[1].title));
  orders.alpaca[0] = { ...orders.alpaca[0], status: 'filled', filled_qty: 10, filled_avg_price: 160 };
  await W.watch(env, NOW + 240000, { send, fetchFn: fakeFetch });
  ok('...filled: "Filled: Buy 10 NVDA at 160.00"', pushes.length === 3 && pushes[2].title === 'Filled: Buy 10 NVDA at 160.00');
  await W.watch(env, NOW + 300000, { send, fetchFn: fakeFetch });
  ok('...and never again', pushes.length === 3);
  const fires = env.DB.sql.prepare("SELECT * FROM alert_fires WHERE kind = 'order'").all();
  ok('each is in the bell (alert_fires, kind order, pushed)', fires.length === 3 && fires.every((f) => f.pushed === 1 && f.symbol === 'NVDA'));
  // A cancel is quiet by default; a rejection is not.
  orders.alpaca.push({ id: 'o2', symbol: 'AMD', side: 'sell', type: 'stop', qty: 3, stop_price: 140, status: 'canceled' }, { id: 'o3', symbol: 'AMD', side: 'buy', type: 'market', qty: 3, status: 'rejected' });
  await W.watch(env, NOW + 360000, { send, fetchFn: fakeFetch });
  ok('his cancel stays quiet (off by default); the rejection alerts', pushes.length === 4 && /^Rejected: Buy 3 AMD/.test(pushes[3].title), pushes.map((p) => p.title).join(' | '));
  // Webull: its own events, its own words.
  orders.webull.push({ id: 'w1', symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limit_price: 50, filled_qty: 1, filled_avg_price: 50, status: 'filled', legs: [] });
  await W.watch(env, NOW + 420000, { send, fetchFn: fakeFetch });
  ok('Webull: its fill alerts as Webull paper, linked to Trading on Webull', pushes.length === 5 && /Webull paper/.test(pushes[4].body) && /trading:webull$/.test(pushes[4].url));
  // Switches.
  await env.DB.prepare("INSERT INTO meta (k, v, at) VALUES ('alert_cfg', ?, 0) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(JSON.stringify({ trading: { webull: false, filled: true } })).run();
  wbReads.length = 0;
  orders.webull.push({ id: 'w2', symbol: 'AAPL', side: 'sell', type: 'limit', qty: 1, filled_qty: 1, filled_avg_price: 51, status: 'filled', legs: [] });
  await W.watch(env, NOW + 480000, { send, fetchFn: fakeFetch });
  ok('Webull switched off: not even read; nothing sent', wbReads.length === 0 && pushes.length === 5);
  ok('...its seen keys marked paused (once)', JSON.parse(env.DB.sql.prepare("SELECT v FROM meta WHERE k = 'orderwatch:webull'").get().v).paused === true);
  // Review: switched on again, the orders placed meanwhile are learned quietly (no burst of old alerts).
  orders.webull.push({ id: 'w3', symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, filled_qty: 1, filled_avg_price: 52, status: 'filled', legs: [] });
  await env.DB.prepare("UPDATE meta SET v = ? WHERE k = 'alert_cfg'").bind(JSON.stringify({})).run();
  r = await W.watch(env, NOW + 500000, { send, fetchFn: fakeFetch });
  ok('Webull on again: w2 and w3 (filled while off) are learned, not pushed', r.brokers.webull.learned === true && pushes.length === 5, JSON.stringify(r.brokers.webull));
  orders.webull.push({ id: 'w4', symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, filled_qty: 1, filled_avg_price: 53, status: 'filled', legs: [] });
  await W.watch(env, NOW + 520000, { send, fetchFn: fakeFetch });
  ok('...and the next new fill alerts as usual', pushes.length === 6 && /Buy 1 AAPL at 53/.test(pushes[5].title));
  await env.DB.prepare("UPDATE meta SET v = ? WHERE k = 'alert_cfg'").bind(JSON.stringify({ trading: { webull: false } })).run();
  await env.DB.prepare("UPDATE meta SET v = ? WHERE k = 'alert_cfg'").bind(JSON.stringify({ trading: { filled: false } })).run();
  orders.alpaca.push({ id: 'o4', symbol: 'MU', side: 'buy', type: 'market', qty: 1, filled_qty: 1, filled_avg_price: 650, status: 'filled' });
  await W.watch(env, NOW + 540000, { send, fetchFn: fakeFetch });
  ok('"Filled" switched off: a fill makes no alert (still learned, never sent later)', pushes.length === 6);
  await env.DB.prepare("UPDATE meta SET v = ? WHERE k = 'alert_cfg'").bind(JSON.stringify({ kinds: { order: false } })).run();
  calls = []; wbReads.length = 0; env.DB.reads = 0;
  r = await W.watch(env, NOW + 600000, { send, fetchFn: fakeFetch });
  ok('the kind off: two D1 reads (the config, the seen keys), no broker read', r.skipped && env.DB.reads === 2 && !calls.length && !wbReads.length, env.DB.reads);
  // A failing broker does not stop the other.
  await env.DB.prepare("UPDATE meta SET v = '{}' WHERE k = 'alert_cfg'").run();
  await W.watch(env, NOW + 630000, { send, fetchFn: fakeFetch });   // back on: one quiet learning minute first
  orders.webullFail = true;
  orders.alpaca.push({ id: 'o5', symbol: 'TSLA', side: 'buy', type: 'market', qty: 2, filled_qty: 2, filled_avg_price: 390, status: 'filled' });
  r = await W.watch(env, NOW + 660000, { send, fetchFn: fakeFetch });
  ok('Webull refusing: said for Webull, Alpaca\'s fill still alerts', /Webull refused/.test(r.brokers.webull.error) && /Filled: Buy 2 TSLA/.test(pushes[pushes.length - 1].title));
  ok('the seen keys are capped (400)', W.SEEN_MAX === 400);
  // Review: more than 400 current keys: every one kept, so nothing re-alerts each minute.
  const big = { DB: realD1(), ALPACA_KEY: 'k', ALPACA_SECRET: 's' };
  const many = Array.from({ length: 450 }, (_, i) => ({ id: 'm' + i, symbol: 'SPY', side: 'buy', type: 'market', qty: 1, filled_qty: 1, filled_avg_price: 500, status: 'filled' }));
  const bigFetch = async () => new Response(JSON.stringify(many), { status: 200 });
  await W.watch(big, NOW, { send, fetchFn: bigFetch });
  const p0 = pushes.length; big.DB.writes = 0;
  await W.watch(big, NOW + 60000, { send, fetchFn: bigFetch });
  ok('450 current orders: a second minute finds nothing new, writes nothing', pushes.length === p0 && big.DB.writes === 0, big.DB.writes);
  // Review: a failure while firing leaves the keys unseen, so the next minute alerts them.
  const flaky = { DB: realD1(), ALPACA_KEY: 'k', ALPACA_SECRET: 's' }, list = [];
  const flakyFetch = async () => new Response(JSON.stringify(list), { status: 200 });
  await W.watch(flaky, NOW, { send, fetchFn: flakyFetch });
  list.push({ id: 'f1', symbol: 'META', side: 'buy', type: 'market', qty: 1, filled_qty: 1, filled_avg_price: 600, status: 'filled' });
  let threw = false;
  const prep = flaky.DB.prepare, failOnce = { on: true };
  flaky.DB.prepare = (q) => { if (failOnce.on && /INSERT INTO alert_fires/.test(q)) { failOnce.on = false; throw new Error('D1 hiccup'); } return prep(q); };
  try { await W.watch(flaky, NOW + 60000, { send, fetchFn: flakyFetch }); } catch (e) { threw = true; }
  flaky.DB.prepare = prep;
  const p1 = pushes.length;
  await W.watch(flaky, NOW + 120000, { send, fetchFn: flakyFetch });
  ok('a D1 hiccup while firing: the fill alerts on the next minute', threw && pushes.length === p1 + 1 && /META/.test(pushes[pushes.length - 1].title));
  // Review: a rule for one ticker never silences the others; one alert per event.
  const tick = { DB: realD1(), ALPACA_KEY: 'k', ALPACA_SECRET: 's' }, tl = [];
  const tickFetch = async () => new Response(JSON.stringify(tl), { status: 200 });
  await tick.DB.prepare("INSERT INTO alerts (id, kind, symbol, active, created, at) VALUES ('r1', 'order', 'NVDA', 1, 0, 0)").run();
  await W.watch(tick, NOW, { send, fetchFn: tickFetch });
  tl.push({ id: 't1', symbol: 'AMD', side: 'buy', type: 'market', qty: 1, filled_qty: 1, filled_avg_price: 160, status: 'filled' }, { id: 't2', symbol: 'NVDA', side: 'buy', type: 'market', qty: 1, filled_qty: 1, filled_avg_price: 164, status: 'filled' });
  const p2 = pushes.length;
  await W.watch(tick, NOW + 60000, { send, fetchFn: tickFetch });
  const two = pushes.slice(p2).map((p) => p.title);
  ok('with an NVDA order rule: AMD still alerts (standing rule), NVDA alerts once', two.length === 2 && two.some((t) => /AMD/.test(t)) && two.filter((t) => /NVDA/.test(t)).length === 1, two.join(' | '));
  const noKeys = await W.watch({ DB: realD1() }, NOW, { send, fetchFn: fakeFetch });
  ok('no broker keys: nothing to watch', noKeys.skipped === 'no broker to watch');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
