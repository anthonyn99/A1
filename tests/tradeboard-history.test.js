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
    + '\nmodule.exports.fetchHistoryRaw = fetchHistoryRaw; module.exports.extractFee = extractFee; module.exports.fetchOrders = fetchOrders;';
  const kv = new Map([['wb_token', JSON.stringify({ token: 't', status: 'NORMAL' })]]);
  const env = {
    WEBULL_APP_KEY: 'k', WEBULL_APP_SECRET: 's',
    TB_KV: { get: async (k, t) => { const v = kv.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
  };
  const sandbox = {
    module: { exports: {} }, console: { log() {}, warn() {}, error() {} },
    crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, URL, atob, btoa, AbortSignal,
    setTimeout: (f) => { f(); return 0; },
    Response: class { constructor(b, i) { this.body = b; this.status = (i && i.status) || 200; } },
    fetch: async (u) => {
      const url = new URL(u);
      const q = Object.fromEntries(url.searchParams);
      calls.push({ path: url.pathname, q });
      const r = fakeWebull(url.pathname, q, calls.length);
      return { ok: r.status === undefined || r.status < 400, status: r.status || 200, json: async () => r.body };
    },
  };
  // The worker's md5 helper uses Web Crypto MD5, which Node does not ship; no
  // signed request here has a body, so it is never reached.
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'worker.js' });
  return { m: sandbox.module.exports, env, calls };
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
    ok('window is 30 days', span === 30, span);
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

  console.log('debug leftovers');
  ok('no order/detail probe on every sync', !/PROBE|order\/detail/.test(SRC));
  ok('raw balance payload not logged', !/raw payload:/.test(SRC));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
