// tradeboard-api's Webull order history (workers/tradeboard-api/src/worker.js).
//
// Webull's history endpoint answers the LAST 7 DAYS unless it is given
// start_date/end_date, so History, the FIFO realized P&L and the Journal sync
// only ever saw one week, and a week without a sync lost those fills for good
// (2026-11-03 audit). This runs the real worker code against a fake Webull:
//   1. the summary asks for 30 days, one page
//   2. the journal sync pages on with last_client_order_id, stops on a short or
//      repeated page, and never duplicates an order
//   3. an endpoint that refuses the date range (4xx) falls back to the bare call
//   4. a 429 is NOT treated as a refused range
//   5. fees in Webull's current shape (commission object, fees[]) are read
//   6. the leftover order/detail debug probe is gone
//
// Run: node tests/tradeboard-history.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'workers', 'tradeboard-api', 'src', 'worker.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

function load(fakeWebull) {
  const calls = [];
  const code = SRC.replace(/export default \{/, 'module.exports.default = {')
    + '\nverifyAppCheckToken = async () => true;'
    + '\nObject.assign(module.exports, { fetchHistoryRaw, extractFee, fetchOrders, backfillFees, entryNeedsFee, fetchCashActivities, fetchSnapshots, fetchSparkBars, syncJournalFromWebull });';
  const kv = new Map([['wb_token', JSON.stringify({ token: 't', status: 'NORMAL' })], ['wb_account', 'A1']]);
  const env = {
    WEBULL_APP_KEY: 'k', WEBULL_APP_SECRET: 's',
    TB_KV: { get: async (k, t) => { const v = kv.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
  };
  // Node's Web Crypto has no MD5 (Workers' does); the signer needs it for bodies.
  const nodeCrypto = require('crypto');
  const subtle = nodeCrypto.webcrypto.subtle;
  const cryptoShim = {
    randomUUID: () => nodeCrypto.randomUUID(),
    getRandomValues: (a) => nodeCrypto.webcrypto.getRandomValues(a),
    subtle: {
      importKey: (...x) => subtle.importKey(...x), sign: (...x) => subtle.sign(...x), verify: (...x) => subtle.verify(...x),
      digest: async (alg, data) => alg === 'MD5' ? nodeCrypto.createHash('md5').update(Buffer.from(data)).digest().buffer : subtle.digest(alg, data),
    },
  };
  const cache = new Map();
  const sandbox = {
    module: { exports: {} }, console: { log() {}, warn() {}, error() {} },
    crypto: cryptoShim, TextEncoder, TextDecoder, URL, atob, btoa, AbortSignal, Request, Response, Headers,
    setTimeout: (f) => { f(); return 0; },
    caches: { default: { match: async (r) => { const v = cache.get(r.url); return v ? new Response(v) : undefined; }, put: async (r, res) => { cache.set(r.url, await res.text()); } } },
    fetch: async (u, init) => {
      const url = new URL(u);
      const q = Object.fromEntries(url.searchParams);
      const h = (init && init.headers) || {};
      const call = { path: url.pathname, q, method: (init && init.method) || 'GET', version: h['x-version'], body: init && init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      const r = fakeWebull(url.pathname, q, calls.length, call);
      return { ok: r.status === undefined || r.status < 400, status: r.status || 200, json: async () => r.body };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'worker.js' });
  const call = (method, p) => sandbox.module.exports.default.fetch(new Request('https://w' + p, { method }), env, { waitUntil() {} }).then((r) => r.json());
  return { m: sandbox.module.exports, env, calls, kv, call, cache };
}

const order = (id, extra) => ({ client_order_id: 'c' + id, order_id: 'o' + id, symbol: 'NVDA', side: 'BUY', status: 'FILLED',
  total_quantity: '1', filled_quantity: '1', filled_price: '100', place_time_at: '2026-10-20T14:00:00Z', ...extra });
const group = (id, extra) => ({ client_order_id: 'c' + id, combo_type: 'NORMAL', orders: [order(id, extra)] });

(async () => {
  console.log('summary: 30 days, one page');
  {
    const { m, env, calls } = load(() => ({ body: { data: [group(1), group(2)] } }));
    const out = await m.fetchHistoryRaw('A1', env, {});
    const h = calls.filter(c => c.path === '/openapi/trade/order/history');
    ok('one history call', h.length === 1, h.length);
    ok('start_date and end_date sent', /^\d{4}-\d{2}-\d{2}$/.test(h[0].q.start_date) && /^\d{4}-\d{2}-\d{2}$/.test(h[0].q.end_date), JSON.stringify(h[0].q));
    const span = (Date.parse(h[0].q.end_date) - Date.parse(h[0].q.start_date)) / 86400000;
    ok('window is 30 days, through tomorrow (Webull\'s end date is exclusive: today\'s orders were missed)', span === 31 && h[0].q.end_date === new Date(Date.now() + 86400000).toISOString().slice(0, 10), span + ' ' + h[0].q.end_date);
    ok('page_size 100', h[0].q.page_size === '100');
    ok('two orders flattened', out.length === 2, out.length);
  }

  console.log('journal sync: pages, stops, never duplicates');
  {
    const full = Array.from({ length: 100 }, (_, i) => group(i));
    const { m, env, calls } = load((p, q) => {
      if (!q.last_client_order_id) return { body: { data: full } };
      if (q.last_client_order_id === 'c99') return { body: { data: [group(99), group(100), group(101)] } };   // overlaps by one
      return { body: { data: [] } };
    });
    const out = await m.fetchHistoryRaw('A1', env, { days: 30, maxPages: 3 });
    const h = calls.filter(c => c.path === '/openapi/trade/order/history');
    ok('second page asked with the last group as cursor', h[1] && h[1].q.last_client_order_id === 'c99', h[1] && JSON.stringify(h[1].q));
    ok('short page ends the paging', h.length === 2, h.length);
    ok('102 distinct orders, the overlap not repeated', out.length === 102 && new Set(out.map(o => o.order_id)).size === 102, out.length);
  }
  {
    // An endpoint that ignores the cursor hands page one back: must stop, not loop.
    const full = Array.from({ length: 100 }, (_, i) => group(i));
    const { m, env, calls } = load(() => ({ body: { data: full } }));
    const out = await m.fetchHistoryRaw('A1', env, { days: 30, maxPages: 3 });
    ok('a repeated page stops the paging', calls.length === 2, calls.length);
    ok('and adds nothing', out.length === 100, out.length);
  }

  console.log("today's bracket order reaches the Journal (Tony, 2026-11-04)");
  {
    // A Webull that treats end_date as EXCLUSIVE, like the real one: today's
    // PLTR bracket (buy 165 filled, take-profit 175 filled, stop cancelled)
    // comes back only when the window runs past today.
    const today = new Date().toISOString().slice(0, 10), at = today + 'T15:00:00Z';
    const leg = (id, side, px, status, filled) => ({ client_order_id: 'b' + id, order_id: 'pl' + id, symbol: 'PLTR', side, status,
      total_quantity: '1', filled_quantity: filled ? '1' : '0', filled_price: filled ? px : '0', limit_price: px, place_time_at: at, filled_time_at: filled ? at : undefined });
    const bracket = { client_order_id: 'bk1', combo_type: 'OTOCO', orders: [leg(1, 'BUY', '165', 'FILLED', true), leg(2, 'SELL', '175', 'FILLED', true), leg(3, 'SELL', '150', 'CANCELLED', false)] };
    const { m, env, kv } = load((p, q) => (p === '/openapi/account/list' ? { body: [{ account_id: 'A1' }] } : p === '/openapi/trade/order/history' ? { body: { data: q.end_date > today ? [bracket] : [] } } : { body: {} }));
    await m.syncJournalFromWebull(env);
    const legs = (JSON.parse(kv.get('journal') || '{"trades":[]}').trades || []).filter(t => t.ticker === 'PLTR').flatMap(t => t.legs || []);
    ok("today's buy at 165 and sell at 175 are in the journal; the cancelled stop is not", legs.length === 2 &&
      legs.some(l => l.action === 'BUY' && l.price === 165) && legs.some(l => l.action === 'SELL' && l.price === 175), JSON.stringify(legs));
  }

  console.log('date range refused → the 7-day default');
  {
    const { m, env, calls } = load((p, q) => q.start_date ? { status: 417, body: { message: 'INVALID_PARAMETER' } } : { body: { data: [group(7)] } });
    const out = await m.fetchHistoryRaw('A1', env, {});
    ok('retried without dates', calls.length === 2 && !calls[1].q.start_date, JSON.stringify(calls.map(c => c.q)));
    ok('still returns the orders', out.length === 1 && out[0].order_id === 'o7');
  }
  {
    const { m, env, calls } = load(() => ({ status: 429, body: { message: 'rate' } }));
    let threw = false; try { await m.fetchHistoryRaw('A1', env, {}); } catch (e) { threw = e.status === 429; }
    ok('a 429 is thrown, not retried as a refused range', threw && calls.length === 1, calls.length);
  }
  {
    // fetchOrders keeps its old contract: a failure is [] (the UI reports errors per section).
    const { m, env } = load(() => ({ status: 500, body: {} }));
    const out = await m.fetchOrders('A1', 'history', env);
    ok('fetchOrders history still swallows a 5xx into []', Array.isArray(out) && out.length === 0);
  }

  console.log('fees in Webull\'s current shape');
  {
    const { m } = load(() => ({ body: {} }));
    ok('commission object', m.extractFee({ commission: { actual_commission: '0.50', receivable_commission: '1' } }) === 0.5);
    ok('fees array summed', Math.abs(m.extractFee({ fees: [{ type: 'SEC', actual_value: '0.02' }, { type: 'TAF', actual_value: '0.01' }] }) - 0.03) < 1e-9);
    ok('both together', Math.abs(m.extractFee({ commission: { actual_commission: '1' }, fees: [{ actual_value: '0.02' }] }) - 1.02) < 1e-9);
    ok('old flat field still read', m.extractFee({ fee: '0.07' }) === 0.07);
    ok('no fee → 0', m.extractFee({ commission: { actual_commission: '0' }, fees: [] }) === 0);
    const { m: m2, env } = load(() => ({ body: { data: [group(1, { commission: { actual_commission: '0.25' }, fees: [{ actual_value: '0.03' }] })] } }));
    const rows = await m2.fetchOrders('A1', 'history', env);
    ok('history rows carry the fee', Math.abs(rows[0].fee - 0.28) < 1e-9, rows[0] && rows[0].fee);
  }

  console.log('fees from each order\'s detail (2026-11-03)');
  const detail = (fee) => ({ client_order_id: 'x', combo_type: 'NORMAL', orders: [{ symbol: 'NVDA', status: 'FILLED', commission: { actual_commission: '0' }, fees: fee == null ? [] : [{ type: 'SEC_FEE', actual_value: String(fee) }] }] });
  const entry = (id, extra) => ({ id, source: 'webull', ticker: 'NVDA', side: 'SELL', commission: 0, legs: [{ id: 'L' + id, action: 'SELL', qty: 1, price: 100, fee: 0 }], ...extra });
  {
    // The sync: a new filled sell, fee only in its detail.
    const { m, env, calls, kv } = load((p, q) => {
      if (p === '/openapi/account/list') return { body: [{ account_id: 'A1' }] };
      if (p === '/openapi/trade/order/history') return { body: { data: [group(1, { side: 'SELL' })] } };
      if (p === '/trading/orders/get') return { body: detail(0.03) };
      return { body: {} };
    });
    kv.set('journal', JSON.stringify({ trades: [] }));
    const res = await m.syncJournalFromWebull(env);
    const j = JSON.parse(kv.get('journal'));
    const d = calls.find(c => c.path === '/trading/orders/get');
    ok('the new order\'s detail is read with its client_order_id, as v3', d && d.q.client_order_id === 'c1' && d.version === 'v3', JSON.stringify(d));
    ok('its fee lands on the entry and its leg', j.trades[0].commission === 0.03 && j.trades[0].legs[0].fee === 0.03, JSON.stringify(j.trades[0]));
    ok('it is marked checked, and nothing is left waiting', j.trades[0].feeChecked === true && res.feesRemaining === 0);
    const again = calls.length; await m.syncJournalFromWebull(env);
    ok('the next sync does not ask for it again', !calls.slice(again).some(c => c.path === '/trading/orders/get'));
  }
  {
    // The past: entries without a client_order_id. First call learns the ids, then fees.
    const { env, calls, kv, call } = load((p, q) => {
      if (p === '/openapi/account/list') return { body: [{ account_id: 'A1' }] };
      if (p === '/openapi/trade/order/history') return { body: { data: [group(5), group(6)] } };
      if (p === '/trading/orders/get') return q.client_order_id === 'c6' ? { status: 404, body: { message: 'no' } } : { body: detail(0.02) };
      if (p === '/openapi/trade/order/detail') return { status: 404, body: { message: 'no' } };
      return { body: {} };
    });
    kv.set('journal', JSON.stringify({ trades: [entry('o5'), entry('o6'), entry('o7', { feeChecked: true }), entry('o8', { commission: 0.05 })] }));
    const r1 = await call('POST', '/api/journal/fees');
    ok('call 1 reads order history once for the missing ids', r1.ok && r1.phase === 'ids' && r1.idsFound === 2, JSON.stringify(r1).slice(0, 200));
    const h = calls.find(c => c.path === '/openapi/trade/order/history');
    ok('…two years back', h && (Date.parse(h.q.end_date) - Date.parse(h.q.start_date)) / 86400000 === 731, h && JSON.stringify(h.q));
    const r2 = await call('POST', '/api/journal/fees');
    const j = JSON.parse(kv.get('journal')).trades;
    ok('call 2 reads the fees', r2.ok && r2.phase === 'fees' && r2.updated === 1 && r2.remaining === 0, JSON.stringify({ ...r2, data: undefined }));
    ok('the found fee is written', j.find(t => t.id === 'o5').legs[0].fee === 0.02);
    ok('an order Webull no longer has is marked, not asked again', j.find(t => t.id === 'o6').feeChecked === 'missing');
    ok('already-checked and already-feed entries are never asked', !calls.some(c => /o7|o8|c7|c8/.test(c.q.client_order_id || '')));
    const n = calls.length; const r3 = await call('POST', '/api/journal/fees');
    ok('a third call has nothing left to do', r3.remaining === 0 && calls.length === n + 1, calls.slice(n).map(c => c.path).join(','));   // the account-list probe only
  }
  {
    // A rate limit stops the pass; nothing is marked, so the next call resumes.
    const { env, kv, call } = load((p) => p === '/openapi/account/list' ? { body: [{ account_id: 'A1' }] } : p === '/trading/orders/get' ? { status: 429, body: {} } : { body: {} });
    kv.set('journal', JSON.stringify({ trades: [entry('o1', { clientOrderId: 'c1' })] }));
    kv.set('fee_ids_read', '1');
    const r = await call('POST', '/api/journal/fees');
    ok('a 429 stops the pass and leaves it waiting', r.stopped && r.remaining === 1 && !JSON.parse(kv.get('journal')).trades[0].feeChecked, JSON.stringify({ ...r, data: undefined }));
  }
  {
    // v3 detail missing on this account: falls back to the legacy path, and sticks with it.
    const { m, env, calls } = load((p) => p === '/trading/orders/get' ? { status: 404, body: {} } : p === '/openapi/trade/order/detail' ? { body: detail(0.01) } : { body: {} });
    const jr = { trades: [entry('a', { clientOrderId: 'ca' }), entry('b', { clientOrderId: 'cb' })] };
    await m.backfillFees(env, jr, 'A1', { maxCalls: 5, coidOf: t => t.clientOrderId });
    ok('the legacy detail path answers when v3 does not', jr.trades.every(t => t.legs[0].fee === 0.01));
    ok('…and the second order goes straight to it', calls.filter(c => c.path === '/trading/orders/get').length === 1, calls.map(c => c.path).join(','));
  }

  console.log('cash activity');
  {
    const yearNow = new Date().getUTCFullYear();
    const { env, calls, call } = load((p, q) => {
      if (p === '/openapi/account/list') return { body: [{ account_id: 'A1' }] };
      if (p === '/trading/activities/cash-activities/list') {
        if (!q.pagination_key) return { body: { data: [
          { id: 'a1', activity_type: 'DIVIDENDS', activity_sub_type: 'INCOME', symbol: 'MSFT', trade_date: q.start_time.slice(0, 4) + '-03-10', biz_time: q.start_time.slice(0, 4) + '-03-10T14:00:00.000Z', net_amount: '4.20' },
          { id: 'a2', activity_type: 'TRADE', activity_sub_type: 'BUY', symbol: 'NVDA', trade_date: '2026-03-11', net_amount: '-100' },
        ], pagination_key: 'k2' } };
        return { body: { data: [{ id: 'a3', activity_type: 'DEPOSIT', activity_sub_type: 'ACH', trade_date: q.start_time.slice(0, 4) + '-04-01', biz_time: q.start_time.slice(0, 4) + '-04-01T10:00:00.000Z', net_amount: '500' }] } };
      }
      return { body: {} };
    });
    const r = await call('GET', '/api/portfolio/activities?days=365');
    const ac = calls.filter(c => c.path === '/trading/activities/cash-activities/list');
    ok('read as v3, by year (Webull refuses a range across a year end)', ac.length && ac.every(c => c.version === 'v3' && c.q.start_time.slice(0, 4) === c.q.end_time.slice(0, 4)), JSON.stringify(ac.map(c => [c.q.start_time, c.q.end_time])));
    ok('…covering the last year', ac.some(c => c.q.start_time.startsWith(String(yearNow - 1))) && ac.some(c => c.q.end_time.startsWith(String(yearNow))));
    ok('it pages on', ac.some(c => c.q.pagination_key === 'k2'));
    ok('trades are left out, the rest mapped', r.ok && r.items.length >= 2 && r.items.every(x => x.type !== 'TRADE') && r.items.some(x => x.type === 'DIVIDENDS' && x.amount === 4.2 && x.symbol === 'MSFT'), JSON.stringify(r.items).slice(0, 300));
    ok('newest first', r.items.map(x => x.at).join() === r.items.map(x => x.at).sort().reverse().join());
  }
  {
    const { call, calls } = load((p, q) => {
      if (p === '/openapi/account/list') return { body: [{ account_id: 'A1' }] };
      if (q.activity_types) return { status: 417, body: { message: 'INVALID_PARAMETER' } };
      return { body: { data: [{ id: 'z', activity_type: 'INTERESTS', activity_sub_type: 'CREDIT', trade_date: '2026-10-01', net_amount: '0.80' }] } };
    });
    const r = await call('GET', '/api/portfolio/activities?days=30');
    ok('a refused type list is retried without it', r.ok && r.items.length && calls.some(c => c.path.includes('cash') && !c.q.activity_types), JSON.stringify(r).slice(0, 200));
  }

  console.log('market data');
  {
    const { call, calls } = load((p, q, n, c) => {
      if (p === '/market-data/stocks/snapshots/list') return { body: q.category === 'US_STOCK'
        ? [{ symbol: 'NVDA', price: '206.69', pre_close: '202.06', change_ratio: '0.02291', extend_hour_last_price: '205.5', extend_hour_change_ratio: '-0.0058' }]
        : [{ symbol: 'DRAM', price: '47.64', pre_close: '46.32', change_ratio: '0.0285' }] };
      if (p === '/market-data/stocks/bars/list') return { body: { result: [{ symbol: 'NVDA', result: [{ time: new Date(Date.now() - 600000).toISOString(), close: '205' }, { time: new Date(Date.now() - 300000).toISOString(), close: '206' }] }] } };
      return { body: {} };
    });
    const r = await call('GET', '/api/market/quotes?symbols=NVDA,DRAM&bars=1');
    ok('snapshots with after-hours, v3', r.ok && r.source === 'webull' && Math.abs(r.quotes.NVDA.dp - 2.291) < 1e-9 && r.quotes.NVDA.ext.price === 205.5 && Math.abs(r.quotes.NVDA.ext.dp + 0.58) < 1e-9, JSON.stringify(r).slice(0, 300));
    ok('an ETF the stock category missed is asked for as an ETF', r.quotes.DRAM && calls.some(c => c.q.category === 'US_ETF' && c.q.symbols === 'DRAM'));
    ok('extended hours requested', calls.find(c => c.path.includes('snapshots')).q.extend_hour_required === 'true');
    const b = calls.find(c => c.path === '/market-data/stocks/bars/list');
    ok('sparkline bars: one POST, signed body, 5-minute, all sessions', b && b.method === 'POST' && b.body.timespan === 'M5' && /PRE/.test(b.body.trading_sessions) && JSON.stringify(r.quotes.NVDA.points) === '[205,206]', b && JSON.stringify(b.body));
    const n = calls.length; await call('GET', '/api/market/quotes?symbols=DRAM,NVDA&bars=1');
    ok('a second ask within a minute is served from the edge cache', calls.length === n);
  }
  {
    const { call } = load(() => ({ status: 403, body: { message: 'No market data permission' } }));
    const r = await call('GET', '/api/market/quotes?symbols=NVDA');
    ok('no subscription: a plain ok:false, not an error page', r.ok === false && r.code === 'NO_MARKET_DATA' && r.status === 403, JSON.stringify(r));
  }

  console.log('debug leftovers');
  ok('no order/detail debug probe on every sync', !/PROBE/.test(SRC));
  ok('raw balance payload not logged', !/raw payload:/.test(SRC));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
