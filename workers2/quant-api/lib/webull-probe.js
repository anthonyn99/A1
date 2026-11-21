// Webull SANDBOX probe (Batch 4 T0, docs/TradeHub/quant-trading.md in A1-Priv).
//
//   GET /webull/probe        read-only: which sandbox host answers, whether a token is needed,
//                            the accounts, each one's balance, positions and open orders,
//                            the rate-limit headers, and signs of a SHARED test account.
//
// Read-only on purpose: no order is placed here. The order round trip (place far from the
// market, replace, cancel, a bracket, a trailing stop) is T1's first step, with Webull's order
// bodies checked against the docs and Tony watching. Only the SANDBOX hosts below are ever
// called; Webull production (api.webull.com) never appears in quant-api (tests/quant-api.test.js).
// Keys: WEBULL_PAPER_KEY / WEBULL_PAPER_SECRET, set by Tony with `wrangler secret put`.

export const SANDBOX_HOSTS = ['api.sandbox.webull.com', 'us-openapi-alb.uat.webullbroker.com'];

const enc = new TextEncoder();
async function hmacSha1B64(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))));
}
// MD5 in plain JS: Workers' WebCrypto has MD5 but Node's (the tests) does not, so one code path for both.
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
export function md5Upper(str) {
  const msg = enc.encode(str), n = ((msg.length + 8) >>> 6) + 1, w = new Uint32Array(n * 16);
  for (let i = 0; i < msg.length; i++) w[i >> 2] |= msg[i] << ((i % 4) * 8);
  w[msg.length >> 2] |= 0x80 << ((msg.length % 4) * 8);
  w[n * 16 - 2] = (msg.length * 8) >>> 0; w[n * 16 - 1] = Math.floor(msg.length / 0x20000000);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let o = 0; o < w.length; o += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; } else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; } else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const t = d; d = c; c = b;
      const x = (a + f + MD5_K[i] + w[o + g]) >>> 0, s = MD5_S[(i >> 4) * 4 + (i % 4)];
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0; a = t;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map((v) => [0, 8, 16, 24].map((s) => ((v >>> s) & 255).toString(16).padStart(2, '0')).join('')).join('').toUpperCase();
}

/** Webull's signature (the same scheme tradeboard-api uses): HMAC-SHA1 of the URL-encoded
 *  "path&sorted(query+signing headers)[&MD5(body)]" with key "secret&". Exported for the test. */
export async function signedHeaders({ host, path, query = {}, body = null, key, secret, token = null, version = 'v2', now = new Date(), nonce = crypto.randomUUID().replace(/-/g, '') }) {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sh = { host, 'x-app-key': key, 'x-signature-algorithm': 'HMAC-SHA1', 'x-signature-nonce': nonce, 'x-signature-version': '1.0', 'x-timestamp': ts };
  const all = { ...query, ...sh };
  const s1 = Object.keys(all).sort().map((k) => `${k}=${all[k]}`).join('&');
  const bodyStr = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const s3 = bodyStr ? `${path}&${s1}&${md5Upper(bodyStr)}` : `${path}&${s1}`;
  const h = { 'x-app-key': key, 'x-timestamp': ts, 'x-signature': await hmacSha1B64(secret + '&', encodeURIComponent(s3)),
    'x-signature-algorithm': 'HMAC-SHA1', 'x-signature-version': '1.0', 'x-signature-nonce': nonce, 'x-version': version };
  if (token) h['x-access-token'] = token;
  if (bodyStr) h['Content-Type'] = 'application/json';
  return h;
}

const RL = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'];

async function call(env, host, method, path, { query = {}, body = null, token = null, version = 'v2' } = {}, fetchFn = fetch) {
  if (!SANDBOX_HOSTS.includes(host)) throw new Error('not a Webull sandbox host');
  const h = await signedHeaders({ host, path, query, body, key: env.WEBULL_PAPER_KEY, secret: env.WEBULL_PAPER_SECRET, token, version });
  const qs = new URLSearchParams(query).toString();
  const t0 = Date.now();
  let r, text = '';
  try {
    r = await fetchFn(`https://${host}${path}${qs ? '?' + qs : ''}`, { method, headers: h, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    text = await r.text();
  } catch (e) { return { ok: false, status: 0, ms: Date.now() - t0, error: String(e.message || e) }; }
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  const limits = {}; for (const k of RL) { const v = r.headers.get(k); if (v != null) limits[k] = v; }
  return { ok: r.ok, status: r.status, ms: Date.now() - t0, body: j != null ? j : text.slice(0, 400), limits };
}

const listOf = (b) => (Array.isArray(b) ? b : b && (b.data || b.list || b.items || b.accounts)) || [];
const idOf = (a) => a && (a.account_id || a.accountId || a.id);

/** GET /webull/probe → { ok, host, needsToken, accounts: [{ id, balance, positions, openOrders }], shared: [...] } */
export async function probe(env, fetchFn = fetch) {
  if (!env.WEBULL_PAPER_KEY || !env.WEBULL_PAPER_SECRET) return { ok: false, error: 'WEBULL_PAPER_KEY / WEBULL_PAPER_SECRET are not set on quant-api yet (Tony: wrangler secret put)' };
  const tried = [];
  for (const host of SANDBOX_HOSTS) {
    let list = await call(env, host, 'GET', '/openapi/account/list', {}, fetchFn);
    let token = null, needsToken = false, tokenStatus = null;
    if (!list.ok && list.status && list.status !== 404) {
      // A sandbox token is said to be valid at once (no SMS step): create one and retry.
      const c = await call(env, host, 'POST', '/openapi/auth/token/create', { body: {} }, fetchFn);
      token = c.ok && c.body && (c.body.token || (c.body.data && c.body.data.token));
      tokenStatus = c.ok && c.body ? (c.body.status || (c.body.data && c.body.data.status) || null) : null;
      tried.push({ host, step: 'token/create', status: c.status, body: c.ok ? { status: tokenStatus } : c.body });
      if (token) { needsToken = true; list = await call(env, host, 'GET', '/openapi/account/list', { token }, fetchFn); }
    }
    tried.push({ host, step: 'account/list', status: list.status, ms: list.ms, limits: list.limits, error: list.error, body: list.ok ? undefined : list.body });
    if (!list.ok) continue;
    const accounts = [];
    for (const a of listOf(list.body).slice(0, 4)) {
      const q = { account_id: idOf(a) };
      const [bal, pos, open] = [
        await call(env, host, 'GET', '/openapi/assets/balance', { query: q, token }, fetchFn),
        await call(env, host, 'GET', '/openapi/assets/positions', { query: q, token }, fetchFn),
        await call(env, host, 'GET', '/openapi/trade/order/open', { query: { ...q, page_size: 20 }, token }, fetchFn),
      ];
      accounts.push({ id: q.account_id, raw: a, balance: bal.ok ? bal.body : { status: bal.status, body: bal.body },
        positions: pos.ok ? listOf(pos.body).length : { status: pos.status, body: pos.body },
        openOrders: open.ok ? listOf(open.body).length : { status: open.status, body: open.body }, limits: bal.limits });
    }
    // Signs of a SHARED test account (Webull's docs mention them): open orders or positions Tony never
    // placed show up here; T1 reads this before building on Webull paper.
    const shared = accounts.filter((x) => (typeof x.openOrders === 'number' && x.openOrders > 0) || (typeof x.positions === 'number' && x.positions > 0))
      .map((x) => `account ${x.id}: ${x.positions} positions, ${x.openOrders} open orders before TradeHub placed anything`);
    return { ok: true, host, needsToken, tokenStatus, accounts, shared, tried };
  }
  return { ok: false, error: 'no Webull sandbox host answered the account list', tried };
}
