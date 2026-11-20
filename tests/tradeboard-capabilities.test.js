// tradeboard-api GET /api/portfolio/capabilities (workers/tradeboard-api/src/worker.js).
//
// The probe asks Webull whether this key may use each READ endpoint the worker
// already uses and reports status only. Webull is read-only in TradeHub, so this
// runs the real worker code against a fake Webull and proves:
//   1. it answers GET only, behind App Check
//   2. every endpoint is reported allowed / denied (401, 403, 417) / errored
//   3. the answer never carries the token, the secret, the account id or any value
//   4. it never calls an order, preview, replace or cancel endpoint, and the only
//      POST it makes is Webull's token check
//   5. account type and market-data subscription are read when Webull shows them
//
// Run: node tests/tradeboard-capabilities.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workers', 'tradeboard-api', 'src', 'worker.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const TOKEN = 'tok-SECRET-9f8e7d', SECRET = 'app-secret-XYZ', ACCT = 'ACC778899001';

function load(fakeWebull, { appCheck = true, tokenState = { token: TOKEN, status: 'NORMAL', expireTime: Date.now() + 10 * 864e5, createTime: new Date(Date.now() - 2 * 864e5).toISOString() } } = {}) {
  const calls = [];
  const code = SRC.replace(/export default \{/, 'module.exports.default = {')
    + '\nverifyAppCheckToken = async () => ' + (appCheck ? 'true' : 'false') + ';';
  const kv = new Map([['wb_account', ACCT]]);
  if (tokenState) kv.set('wb_token', JSON.stringify(tokenState));
  const env = {
    WEBULL_APP_KEY: 'k', WEBULL_APP_SECRET: SECRET,
    TB_KV: { get: async (k, t) => { const v = kv.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
  };
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
  const sandbox = {
    module: { exports: {} }, console: { log() {}, warn() {}, error() {} },
    crypto: cryptoShim, TextEncoder, TextDecoder, URL, atob, btoa, AbortSignal, Request, Response, Headers,
    setTimeout: (f) => { f(); return 0; },
    caches: { default: { match: async () => undefined, put: async () => {} } },
    fetch: async (u, init) => {
      const url = new URL(u);
      const call = { path: url.pathname, q: Object.fromEntries(url.searchParams), method: (init && init.method) || 'GET' };
      calls.push(call);
      const r = fakeWebull(url.pathname, call.q, call);
      return { ok: r.status === undefined || r.status < 400, status: r.status || 200, json: async () => r.body };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'worker.js' });
  const call = (method, p) => sandbox.module.exports.default.fetch(new Request('https://w' + p, { method }), env, { waitUntil() {} })
    .then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() }));
  return { calls, kv, call };
}

const fullWebull = (p) => {
  if (p === '/openapi/auth/token/check') return { body: { token: TOKEN, status: 'NORMAL', expire_time: Date.now() + 9 * 864e5 } };
  if (p === '/openapi/account/list') return { body: [{ account_id: ACCT, account_type: 'MARGIN', account_class: 'INDIVIDUAL', user_id: '5550001' }] };
  if (p === '/openapi/assets/balance') return { body: { account_id: ACCT, total_net_liquidation_value: '123456.78', total_cash_balance: '4321.00', account_currency_assets: [] } };
  if (p === '/openapi/assets/positions') return { body: [{ symbol: 'NVDA', quantity: '42', market_value: '7777' }] };
  if (p === '/openapi/trade/order/history') return { body: [{ client_order_id: 'COID-1', orders: [{ client_order_id: 'COID-1', symbol: 'NVDA', filled_price: '190.5' }] }] };
  if (p === '/openapi/trade/order/open') return { body: [] };
  if (p === '/trading/orders/get') return { status: 417, body: { error_code: 'ORDER_NOT_FOUND', message: 'not found' } };
  if (p === '/openapi/trade/order/detail') return { body: { client_order_id: 'COID-1', commission: { actual_commission: '0' } } };
  if (p === '/trading/activities/cash-activities/list') return { body: { data: [{ amount: '100' }], pagination_key: null } };
  if (p === '/market-data/watchlists/list') return { body: [{ watchlist_id: 'W1', name: 'Mine' }] };
  if (p === '/market-data/watchlists/instruments/list') return { body: { instruments: [{ symbol: 'SPY' }] } };
  if (p === '/market-data/stocks/snapshots/list') return { status: 403, body: { error_code: 'NO_PERMISSION', message: 'market data not subscribed' } };
  return { status: 404, body: { message: 'unexpected ' + p } };
};

(async () => {
  console.log('\n-- capabilities probe');
  {
    const w = load(fullWebull);
    const r = await w.call('GET', '/api/portfolio/capabilities');
    ok('answers 200', r.status === 200, r.status + ' ' + r.text);
    ok('not cacheable', /no-store/.test(r.headers.get('Cache-Control') || ''));
    const d = JSON.parse(r.text);
    const by = Object.fromEntries(d.results.map((x) => [x.endpoint, x]));
    ok('token check reported', by['token check'] && by['token check'].result === 'allowed');
    ok('token status NORMAL', d.token.webullStatus === 'NORMAL' && d.token.cached === 'NORMAL');
    ok('time left about 9 days', d.token.timeLeft && d.token.timeLeft.daysLeft > 8.5 && d.token.timeLeft.daysLeft < 9.5, JSON.stringify(d.token));
    ok('token age about 2 days', d.token.ageDays > 1.5 && d.token.ageDays < 2.5);
    for (const name of ['account list', 'balance', 'positions', 'order history (7 days)', 'open orders', 'order detail v2', 'cash activities (7 days)', 'watchlists', 'watchlist instruments'])
      ok(name + ' allowed', by[name] && by[name].result === 'allowed' && by[name].status === 200, JSON.stringify(by[name]));
    ok('417 counts as denied', by['order detail v3'].result === 'denied' && by['order detail v3'].status === 417);
    ok('403 snapshot = denied', by['quote snapshot (SPY)'].result === 'denied');
    ok('market data not subscribed', /^not subscribed \(403\)/.test(d.marketData), d.marketData);
    ok('account type read', d.accounts.count === 1 && d.accounts.types.includes('account_type=MARGIN'), JSON.stringify(d.accounts));
    ok('counts, not contents', by['positions'].rows === 1 && by['balance'].fields === 4);
    for (const leak of [TOKEN, SECRET, ACCT, '123456.78', '4321', 'NVDA', '7777', 'COID-1', '190.5', '5550001'])
      ok('answer has no ' + leak, !r.text.includes(leak));
    const bad = w.calls.filter((c) => /order\/(place|replace|cancel|preview)|orders\/(place|replace|cancel|preview|batch)/i.test(c.path));
    ok('no order endpoint called', bad.length === 0, JSON.stringify(bad));
    const posts = w.calls.filter((c) => c.method !== 'GET').map((c) => c.path);
    ok('only POST is the token check', posts.length === 1 && posts[0] === '/openapi/auth/token/check', JSON.stringify(posts));
    ok('no KV write', w.kv.get('wb_token') && JSON.parse(w.kv.get('wb_token')).status === 'NORMAL' && w.kv.size === 2);
  }

  console.log('\n-- gates');
  {
    const w = load(fullWebull, { appCheck: false });
    const r = await w.call('GET', '/api/portfolio/capabilities');
    ok('no App Check = 401', r.status === 401);
    ok('no Webull call without App Check', w.calls.length === 0);
  }
  {
    const w = load(fullWebull);
    const r = await w.call('POST', '/api/portfolio/capabilities');
    ok('POST is not a route', r.status === 404);
    ok('POST calls nothing', w.calls.length === 0);
  }

  console.log('\n-- no token, and a denied key');
  {
    const w = load(fullWebull, { tokenState: null });
    const d = JSON.parse((await w.call('GET', '/api/portfolio/capabilities')).text);
    ok('token NONE', d.token.cached === 'NONE');
    ok('reads skipped, not failed', d.results.filter((x) => x.result === 'skipped').length >= 8, JSON.stringify(d.tally));
  }
  {
    const w = load((p) => p === '/openapi/auth/token/check' ? fullWebull(p) : { status: 401, body: { message: 'unauthorized' } });
    const d = JSON.parse((await w.call('GET', '/api/portfolio/capabilities')).text);
    ok('401 account list = denied', d.results.find((x) => x.endpoint === 'account list').result === 'denied');
    ok('needs account id = skipped', d.results.find((x) => x.endpoint === 'balance').result === 'skipped');
  }

  console.log('\n-- source');
  {
    const start = SRC.indexOf('CAPABILITIES PROBE'), end = SRC.indexOf('ROUTER  (matches');
    const block = SRC.slice(start, end);
    ok('probe names no order write path', !/\/(trading\/orders|openapi\/trade\/order)\/(place|replace|cancel|preview|batch)/i.test(block));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
