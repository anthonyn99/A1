/**
 * TradeBoard — Cloudflare Worker
 *
 * Drop-in replacement for server.js.
 * Secrets stored in Cloudflare (never in code).
 * Token + journal stored in Cloudflare KV.
 *
 * KV keys used:
 *   "wb_token"   → { token, status, expireTime, createTime }
 *   "wb_account" → accountId string (cached)
 *   "journal"    → { trades: [], lastSyncedOrderIds: [] }
 */

/* ══════════════════════════════════════════════════════════════════════════
   CORS helper
   ══════════════════════════════════════════════════════════════════════════ */

// ─── BEGIN GENERATED: appcheck (workers/_shared/appcheck.js) ───
// Do not edit here — edit the canonical copy and run tools/sync-appcheck.js
/* Firebase App Check verification for Cloudflare Workers.
 *
 * WHY THIS EXISTS
 * These Workers are called from pages hosted on GitHub Pages out of a PUBLIC
 * repo, so there is no such thing as a secret the client can hold — any key in
 * the page, or in the browser extension, is world-readable the moment it is
 * committed. That is why several of them ended up with no auth at all rather
 * than weak auth.
 *
 * An App Check token is the one credential that works here: it is minted at
 * runtime by reCAPTCHA against the registered origin, never stored anywhere,
 * and cannot be obtained by someone who is not actually running the app. It is
 * already enforced on Firebase for this project, so this extends the same
 * barrier to the Workers instead of inventing a second scheme.
 *
 * WHAT IT IS NOT
 * App Check attests "this request came from your app", not "this is Tony". It
 * stops strangers, not a person sitting at an unlocked machine. Anything
 * needing per-profile separation still needs the passcode.
 *
 * Canonical copy: workers/_shared/appcheck.js
 * Injected into each worker by tools/sync-appcheck.js — edit HERE, never in a
 * worker, then re-run the sync.
 */

// Firebase project number (messagingSenderId), not the project id.
const APPCHECK_PROJECT_NUM = '982539604706';
const APPCHECK_JWKS_URL = 'https://firebaseappcheck.googleapis.com/v1/jwks';
const APPCHECK_JWKS_TTL = 60 * 60 * 1000;

let _acJwks = null;
let _acJwksAt = 0;

function _acB64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _acB64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(_acB64urlToBytes(s)));
}

async function _acKeys() {
  // Cached in module scope: an isolate handles many requests, and refetching
  // the key set per request would add a round trip to every call.
  if (_acJwks && Date.now() - _acJwksAt < APPCHECK_JWKS_TTL) return _acJwks;
  const r = await fetch(APPCHECK_JWKS_URL);
  if (!r.ok) throw new Error('jwks ' + r.status);
  const j = await r.json();
  _acJwks = j.keys || [];
  _acJwksAt = Date.now();
  return _acJwks;
}

/** Verify an App Check JWT. Returns true only if every check passes. */
async function verifyAppCheckToken(token) {
  try {
    if (typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h64, p64, s64] = parts;

    const header = _acB64urlToJson(h64);
    // Pin the algorithm. Accepting whatever the token names is how "alg: none"
    // and HMAC-with-the-public-key forgeries get in.
    if (header.alg !== 'RS256' || header.typ !== 'JWT' || !header.kid) return false;

    const keys = await _acKeys();
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      _acB64urlToBytes(s64),
      new TextEncoder().encode(h64 + '.' + p64)
    );
    if (!ok) return false;

    const p = _acB64urlToJson(p64);
    const now = Math.floor(Date.now() / 1000);
    // A valid signature over someone ELSE's project is still not our token, so
    // audience and issuer are as load-bearing as the signature itself.
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes('projects/' + APPCHECK_PROJECT_NUM)) return false;
    if (p.iss !== 'https://firebaseappcheck.googleapis.com/' + APPCHECK_PROJECT_NUM) return false;
    if (!p.exp || p.exp <= now) return false;
    if (p.iat && p.iat > now + 300) return false;   // clock skew, not the future
    return true;
  } catch {
    return false;
  }
}

/** Guard for a request. Returns null when allowed, or a 401 Response. */
async function requireAppCheck(request, cors) {
  const tok = request.headers.get('X-Firebase-AppCheck');
  if (await verifyAppCheckToken(tok)) return null;
  return new Response(
    JSON.stringify({ ok: false, error: 'unauthorized', hint: 'App Check token required' }),
    { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...(cors || {}) } }
  );
}
// ─── END GENERATED: appcheck ───
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Pragma, X-Firebase-AppCheck',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   WEBULL SIGNATURE  (HMAC-SHA1 via Web Crypto)
   ══════════════════════════════════════════════════════════════════════════ */
const WB_HOST = 'api.webull.com';
const WB_BASE = `https://${WB_HOST}`;

async function hmacSHA1Base64(key, message) {
  const enc     = new TextEncoder();
  const keyData = enc.encode(key);
  const msgData = enc.encode(message);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData,
    { name: 'HMAC', hash: 'SHA-1' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  // base64 encode
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function md5Hex(str) {
  const enc  = new TextEncoder();
  const buf  = await crypto.subtle.digest('MD5', enc.encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
}

async function makeHeaders({ reqPath, queryParams = {}, body = null, token = null, env }) {
  const appKey    = env.WEBULL_APP_KEY;
  const appSecret = env.WEBULL_APP_SECRET;
  if (!appKey || !appSecret) throw new Error('WEBULL_APP_KEY / WEBULL_APP_SECRET not set in Worker secrets');

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce     = crypto.randomUUID().replace(/-/g, '');

  const signingHeaders = {
    'host':                  WB_HOST,
    'x-app-key':             appKey,
    'x-signature-algorithm': 'HMAC-SHA1',
    'x-signature-nonce':     nonce,
    'x-signature-version':   '1.0',
    'x-timestamp':           timestamp,
  };

  const all  = { ...queryParams, ...signingHeaders };
  const str1 = Object.keys(all).sort().map(k => `${k}=${all[k]}`).join('&');

  let str3;
  if (body) {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const str2    = await md5Hex(bodyStr);
    str3 = `${reqPath}&${str1}&${str2}`;
  } else {
    str3 = `${reqPath}&${str1}`;
  }

  const encoded = encodeURIComponent(str3);
  const key     = `${appSecret}&`;
  const sig     = await hmacSHA1Base64(key, encoded);

  const headers = {
    'x-app-key':             appKey,
    'x-timestamp':           timestamp,
    'x-signature':           sig,
    'x-signature-algorithm': 'HMAC-SHA1',
    'x-signature-version':   '1.0',
    'x-signature-nonce':     nonce,
    'x-version':             'v2',
  };
  if (token) headers['x-access-token'] = token;
  if (body)  headers['Content-Type'] = 'application/json';
  return headers;
}

/* ══════════════════════════════════════════════════════════════════════════
   KV helpers
   ══════════════════════════════════════════════════════════════════════════ */
async function loadToken(env)      { try { const v = await env.TB_KV.get('wb_token',   'json'); return v; } catch { return null; } }
async function saveToken(env, data){ await env.TB_KV.put('wb_token', JSON.stringify(data)); }
async function loadJournal(env)    { try { const v = await env.TB_KV.get('journal',    'json'); return v || { trades: [], lastSyncedOrderIds: [] }; } catch { return { trades: [], lastSyncedOrderIds: [] }; } }
async function saveJournal(env, d) { await env.TB_KV.put('journal', JSON.stringify(d)); }

/* ══════════════════════════════════════════════════════════════════════════
   WEBULL FETCH WRAPPER
   ══════════════════════════════════════════════════════════════════════════ */
async function wb(method, endpoint, { query = {}, body = null, requireToken = true } = {}, env) {
  let token = null;
  if (requireToken) {
    const cached = await loadToken(env);
    if (!cached?.token) throw { code: 'NO_TOKEN', message: 'No token — call /api/portfolio/create-token first, then verify in Webull app.' };
    if (cached.status !== 'NORMAL') throw { code: 'TOKEN_PENDING', message: `Token status: ${cached.status}. Verify in Webull app.` };
    token = cached.token;
  }

  const bodyStr = body ? JSON.stringify(body) : null;
  const headers = await makeHeaders({ reqPath: endpoint, queryParams: query, body: bodyStr, token, env });

  // Build URL with query params
  const url = new URL(`${WB_BASE}${endpoint}`);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    method:  method.toUpperCase(),
    headers,
    body:    bodyStr || undefined,
    signal:  AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    console.error(`[wb] ${method} ${endpoint} → ${res.status}`, errData);
    const err = new Error(errData?.message || `HTTP ${res.status}`);
    err.status   = res.status;
    err.wbData   = errData;
    throw err;
  }

  return res.json();
}

/* ══════════════════════════════════════════════════════════════════════════
   ACCOUNT LIST + ID

   account/list can return MULTIPLE accounts (e.g. after a cash→margin switch).
   The old code blindly took list[0].account_id and cached it for an hour, so if
   Webull put the empty/closed account first, every downstream call queried the
   wrong id → 200 with all-zero data and no error → the dashboard showed $0
   while the real account had money. Now we:
     • read the id off whichever field Webull uses (account_id / accountId / …)
     • pick the account that actually has assets (highest net-liquidation),
       falling back to a MARGIN-typed account, then list[0]
     • validate the KV-cached id is still in the live list before trusting it
   ══════════════════════════════════════════════════════════════════════════ */
function acctIdOf(a) {
  return a?.account_id ?? a?.accountId ?? a?.secAccountId ?? a?.sec_account_id ?? a?.id ?? null;
}

async function fetchAccountList(env) {
  const raw  = await wb('GET', '/openapi/account/list', {}, env);
  const list = Array.isArray(raw) ? raw : (raw?.data || raw?.accounts || []);
  return list;
}

async function getAccountId(env, { force = false } = {}) {
  const list = await fetchAccountList(env);
  if (!list.length) throw new Error('No accounts found.');
  const ids = list.map(acctIdOf).filter(Boolean);
  console.log('[account/list] accounts:', JSON.stringify(list.map(a => ({
    id: acctIdOf(a), type: a.account_type || a.accountType, status: a.status
  }))));

  const cached = await env.TB_KV.get('wb_account');
  if (!force && cached && ids.includes(cached)) return cached;

  let chosen = null;

  if (list.length === 1) {
    chosen = acctIdOf(list[0]);
  } else {
    /* >1 account — pick the one with the most money. Query each balance and
       compare net-liquidation. (cached afterward, so this runs rarely.) */
    let best = -1;
    for (const a of list) {
      const id = acctIdOf(a);
      if (!id) continue;
      try {
        const bal = await wb('GET', '/openapi/assets/balance', { query: { account_id: id } }, env);
        const nl  = p((bal || {}).total_net_liquidation_value || 0);
        console.log('[account/list] candidate', id, 'netLiq', nl);
        if (nl > best) { best = nl; chosen = id; }
        await delay(350);
      } catch (e) { console.error('[account/list] balance probe failed', id, e.message); }
    }
    /* If every probe returned 0/failed, prefer a MARGIN account, else first id. */
    if (!chosen || best <= 0) {
      const margin = list.find(a => /margin/i.test(a.account_type || a.accountType || ''));
      chosen = acctIdOf(margin) || ids[0];
    }
  }

  if (!chosen) throw new Error('Could not resolve an account id from account/list.');
  await env.TB_KV.put('wb_account', chosen, { expirationTtl: 3600 });
  return chosen;
}

/* ══════════════════════════════════════════════════════════════════════════
   DATA FETCHERS
   ══════════════════════════════════════════════════════════════════════════ */
const p = n => { const x = parseFloat(n); return isNaN(x) ? 0 : x; };

const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchBalance(accountId, env) {
  const raw = await wb('GET', '/openapi/assets/balance', { query: { account_id: accountId } }, env);
  return mapBalance(raw, accountId);
}

/* Pure mapper — split out of fetchBalance so /balance-raw can show the raw
   payload and its mapping side by side off ONE Webull call (the balance
   endpoint rate-limits hard). */
function mapBalance(raw, accountId) {
  const d    = raw || {};
  const acct = (d.account_currency_assets || [])[0] || {};
  /* DEBUG: dump real Webull keys so field mapping can be confirmed against the app */
  console.log('[balance] raw top-level keys:', JSON.stringify(Object.keys(d)));
  console.log('[balance] raw currency-asset keys:', JSON.stringify(Object.keys(acct)));
  console.log('[balance] raw payload:', JSON.stringify(raw));
  /* Resolve a numeric field by trying several key names across both objects */
  const pick = (...keys) => {
    for (const k of keys) {
      if (acct[k] !== undefined && acct[k] !== null && acct[k] !== '') return p(acct[k]);
    }
    for (const k of keys) {
      if (d[k] !== undefined && d[k] !== null && d[k] !== '') return p(d[k]);
    }
    return 0;
  };
  /* Same idea, but matched by PATTERN instead of exact key name. Webull has
     renamed these BP fields between API versions (day_buying_power →
     day_trading_buying_power → dayTradingBuyingPower …), so an exact-name list
     silently returns 0 the moment they rename one. Scanning every key in both
     objects for a regex keeps the mapping alive across renames.
     `avoid` excludes near-misses — e.g. the intraday matcher must not swallow
     "overNIGHT_trading_buying_power". */
  const pickRe = (re, avoid = null) => {
    for (const src of [acct, d]) {
      for (const k of Object.keys(src)) {
        const norm = k.replace(/[_-]/g, '').toLowerCase();
        if (!re.test(norm)) continue;
        if (avoid && avoid.test(norm)) continue;
        const v = src[k];
        if (v !== undefined && v !== null && v !== '' && !isNaN(parseFloat(v))) return p(v);
      }
    }
    return 0;
  };
  /* First non-zero wins: exact known names first, pattern scan as the safety net. */
  const firstNonZero = (...vals) => { for (const v of vals) if (v) return v; return 0; };
  const totalNetLiq = p(d.total_net_liquidation_value || 0);
  const cashBal     = p(d.total_cash_balance           || 0);
  const settledC    = p(acct.settled_cash              || 0);
  /* BUYING POWER — Webull margin accounts return SEVERAL BP figures:
       total_buying_power     = equity × 2 (RegT)  — grows as positions appreciate
       day_buying_power       = equity × 4 (PDT)   — also inflates
       available_buying_power = withdrawable / cash-like
       buying_power           = spot cash-equivalent
     Old priority grabbed the margin-inflated number first → BP "rose after every
     trade" (it was just tracking 2× equity, not actual spendable cash). New
     priority prefers the cash-like figure; margin BP is last-resort. Then a
     sanity clamp: BP can never exceed total net liquidation, and if it returns
     0/negative while cash exists, fall back to settled cash. */
  let bpRaw = pick('available_buying_power','buying_power','settled_cash','cash_buying_power','day_buying_power','total_buying_power');
  let bpFinal = bpRaw;

  /* MARGIN BUYING POWER — the three figures Webull shows on its account screen.
     These are deliberately NOT clamped like `buyingPower` above: on a margin
     account they are SUPPOSED to exceed net liquidation (that's the leverage),
     so the cash-sanity clamp would destroy them. They're reported as-is. */
  const intradayBP = firstNonZero(
    pick('day_trading_buying_power','intraday_buying_power','day_buying_power','dtbp'),
    pickRe(/(day|intraday)(trading)?buyingpower/, /(overnight|night)/),
  );
  const overnightBP = firstNonZero(
    pick('overnight_buying_power','night_trading_buying_power','overnight_trading_buying_power'),
    pickRe(/(overnight|nighttrading)buyingpower/),
  );
  const optionsBP = firstNonZero(
    pick('option_buying_power','options_buying_power','option_trading_buying_power'),
    pickRe(/options?(trading)?buyingpower/),
  );
  if (bpFinal <= 0 && (settledC > 0 || cashBal > 0)) bpFinal = settledC > 0 ? settledC : cashBal;
  if (totalNetLiq > 0 && bpFinal > totalNetLiq + 0.01) {
    console.warn('[balance] buyingPower', bpFinal, '> totalNetLiq', totalNetLiq, '— clamping to settled/cash');
    bpFinal = settledC > 0 ? settledC : cashBal;
  }
  return {
    accountId,
    accountType:       d.account_type || acct.account_type || 'Margin',
    currency:          d.total_asset_currency           || 'USD',
    totalValue:        totalNetLiq,
    netLiquidation:    totalNetLiq,
    marketValue:       p(d.total_market_value           || 0),
    cashBalance:       cashBal,
    buyingPower:       bpFinal,
    buyingPowerRaw:    bpRaw,  /* expose pre-clamp value for debugging */
    /* null (not 0) when Webull omits the field, so the UI hides the row
       instead of reporting a confident "$0.00" that isn't real. */
    intradayBP:        intradayBP  || null,
    overnightBP:       overnightBP || null,
    optionsBP:         optionsBP   || null,
    settledCash:       settledC,
    unsettledCash:     p(acct.unsettled_cash            || 0),
    dayPnL:            p(d.total_day_profit_loss        || 0),
    unrealizedPnL:     p(d.total_unrealized_profit_loss || 0),
    unrealizedPct:     p(acct.unrealized_profit_loss_rate || 0),
    /* Webull balance endpoint usually omits realized P&L entirely; front-end
       derives it via FIFO over trade history when this stays 0. */
    realizedPnL:       pick('realized_profit_loss','total_realized_profit_loss','realized_pnl'),
    initialMargin:     p(acct.initial_margin            || 0),
    maintenanceMargin: p(acct.maintenance_margin        || 0),
    excessLiquidity:   p(acct.excess_liquidity          || 0),
    _fetchedAt:        new Date().toISOString(),
  };
}

async function fetchPositions(accountId, env) {
  const raw  = await wb('GET', '/openapi/assets/positions', { query: { account_id: accountId } }, env);
  const list = Array.isArray(raw) ? raw : (raw?.data || raw?.positions || []);
  return list.map(r => {
    const qty      = p(r.quantity    || r.qty      || 0);
    const avgCost  = p(r.cost_price  || r.avg_cost || 0);
    const mktPrice = p(r.last_price  || r.mkt_price|| 0);
    const mktValue = p(r.market_value) || qty * mktPrice;
    const cost     = p(r.total_cost)   || qty * avgCost;
    const uPnL     = p(r.unrealized_profit_loss) || (mktValue - cost);
    return {
      ticker:        r.ticker?.symbol || r.symbol || '—',
      name:          r.ticker?.name   || r.name   || '',
      shares:        qty,
      avgCost,
      currentPrice:  mktPrice,
      marketValue:   mktValue,
      costBasis:     cost,
      unrealizedPnL: uPnL,
      unrealizedPct: cost > 0 ? (uPnL / cost) * 100 : 0,
      lastChangePct: p(r.last_change_ratio || 0),
      side:          r.position_type || 'Long',
    };
  });
}

/* Fetch full detail for one order by id — the history LIST endpoint omits fees,
   but the per-order DETAIL endpoint carries them. Rate limit: 2 req / 2s. */
async function fetchOrderDetail(clientOrderId, accountId, env) {
  try {
    const raw = await wb('GET', '/openapi/trade/order/detail',
      { query: { account_id: accountId, client_order_id: clientOrderId } }, env);
    return raw?.data || raw || null;
  } catch (e) { console.error('[order/detail]', clientOrderId, e.message); return null; }
}

/* Pull the real fee off a Webull order/detail object. Field name varies, so probe
   known candidates, then sum component fees (SEC + TAF + commission + tax).
   Also digs filled-leg arrays. Returns a float (0 if none). */
function extractFee(r) {
  if (!r || typeof r !== 'object') return 0;
  // 1) explicit single total-fee field, first hit wins
  const totalKeys = ['fee', 'fees', 'total_fee', 'total_fees', 'totalFee', 'commission'];
  for (const k of totalKeys) {
    if (r[k] != null && r[k] !== '') {
      const v = parseFloat(r[k]);
      if (!isNaN(v) && v > 0) return v;
    }
  }
  // 2) component fees — sum them
  const compKeys = ['sec_fee', 'secFee', 'taf_fee', 'tafFee', 'transaction_fee',
                    'transactionFee', 'regulatory_fee', 'tax', 'other_fee'];
  let sum = 0;
  for (const k of compKeys) {
    const v = parseFloat(r[k]);
    if (!isNaN(v) && v > 0) sum += v;
  }
  if (sum > 0) return sum;
  // 3) nested fee detail object/array (e.g. r.fee_detail, r.charges)
  for (const nk of ['fee_detail', 'feeDetail', 'charges', 'fees_detail']) {
    const nested = r[nk];
    if (Array.isArray(nested)) {
      const ns = nested.reduce((a, x) => a + (parseFloat(x?.amount ?? x?.fee ?? x) || 0), 0);
      if (ns > 0) return ns;
    } else if (nested && typeof nested === 'object') {
      const v = parseFloat(nested.amount ?? nested.total ?? nested.fee);
      if (!isNaN(v) && v > 0) return v;
    }
  }
  // 4) filled-leg arrays (Webull detail often nests fills with per-fill fees)
  for (const lk of ['items', 'orders', 'fills', 'trade_list', 'tradeList', 'filled_orders']) {
    const arr = r[lk];
    if (Array.isArray(arr) && arr.length) {
      const ls = arr.reduce((a, x) => a + extractFee(x), 0);
      if (ls > 0) return ls;
    }
  }
  return 0;
}

async function fetchOrders(accountId, type = 'open', env) {
  try {
    const endpoint = type === 'open'
      ? '/openapi/trade/order/open'
      : '/openapi/trade/order/history';
    const raw  = await wb('GET', endpoint, { query: { account_id: accountId, page_size: 100 } }, env);
    const list = Array.isArray(raw) ? raw : (raw?.data || raw?.orders || raw?.items || []);
    if (type === 'history') console.log('[orders/history] raw groups:', Array.isArray(list) ? list.length : 0);

    const flat = [];
    for (const item of list) {
      const inner = item.orders;
      if (Array.isArray(inner) && inner.length) {
        for (const o of inner) flat.push(o);
      } else {
        flat.push(item);
      }
    }

    /* DEBUG: dump keys of first flattened order so the real fee field name is
       confirmable in `wrangler tail`. Remove once fee mapping verified. */
    if (type === 'history' && flat.length) {
      console.log('[orders/history] sample order keys:', JSON.stringify(Object.keys(flat[0])));
      console.log('[orders/history] sample fee-ish:', JSON.stringify({
        fee: flat[0].fee, fees: flat[0].fees, commission: flat[0].commission,
        sec_fee: flat[0].sec_fee, taf_fee: flat[0].taf_fee, tax: flat[0].tax,
        extracted: extractFee(flat[0])
      }));
    }

    return flat.map(r => ({
      orderId:   r.order_id         || r.client_order_id,
      clientOrderId: r.client_order_id,
      ticker:    r.symbol           || r.ticker?.symbol,
      side:      r.side,
      qty:       p(r.total_quantity    || r.quantity || 0),
      filled:    p(r.filled_quantity   || 0),
      price:     p(r.limit_price       || r.filled_price || 0),
      avgFill:   p(r.filled_price      || r.avg_filled_price || 0),
      total:     p(r.filled_amount     || 0),
      fee:       extractFee(r),
      status:    r.status,
      orderType: r.order_type,
      tif:       r.time_in_force       || 'DAY',
      createdAt: r.place_time_at       || r.create_time,
      filledAt:  r.filled_time_at      || r.filled_time,
    }));
  } catch(e) { console.error('[orders]', e.message); return []; }
}

/* ══════════════════════════════════════════════════════════════════════════
   JOURNAL HELPERS
   ══════════════════════════════════════════════════════════════════════════ */
function orderToEntry(order) {
  const qty     = parseFloat(order.filled) || parseFloat(order.qty) || 0;
  const avgFill = parseFloat(order.avgFill) || parseFloat(order.price) || 0;
  const side    = (order.side || 'BUY').toUpperCase();
  const dt      = order.filledAt || order.createdAt || new Date().toISOString();
  const fee     = parseFloat(order.fee) || 0;
  const legs    = [{ id: crypto.randomUUID(), action: side, datetime: dt, qty, price: avgFill, fee }];
  return {
    id:         order.orderId || crypto.randomUUID(),
    source:     'webull',
    ticker:     order.ticker || '',
    side,
    market:     'STOCK',
    direction:  'LONG',
    qty,
    avgFill,
    gross:      qty * avgFill,
    orderType:  order.orderType || 'LIMIT',
    commission: fee,
    netPnL:     null,
    pnlPct:     null,
    setupType:  '',
    timeframe:  '',
    confidence: 0,
    status:     side === 'SELL' ? 'CLOSED' : 'OPEN',
    legs,
    tags:       [],
    notes:      '',
    date:       dt,
    createdAt:  new Date().toISOString(),
  };
}

async function syncJournalFromWebull(env) {
  try {
    const cached = await loadToken(env);
    if (!cached?.token || cached.status !== 'NORMAL') return;
    const accountId = await getAccountId(env);
    await delay(500);
    const orders  = await fetchOrders(accountId, 'history', env);
    const journal = await loadJournal(env);
    /* Build lookup by every known id variant: entry.id, orderId, leg._wbId, leg orderId */
    const knownIds = new Set();
    journal.trades.forEach(t => {
      knownIds.add(t.id);
      if (t.orderId) knownIds.add(t.orderId);
      (t.legs || []).forEach(l => {
        if (l._wbId)   knownIds.add(l._wbId);
        if (l.orderId) knownIds.add(l.orderId);
      });
    });

    /* Also build a map: ticker+side+datePrefix → trade index, for fee backfill matching */
    const tradeByFingerprint = new Map();
    journal.trades.forEach((t, idx) => {
      (t.legs || []).forEach(l => {
        const dt = (l.datetime || t.date || '').slice(0, 10);
        const fp = `${(t.ticker||'').toUpperCase()}|${(l.action||t.side||'').toUpperCase()}|${dt}`;
        tradeByFingerprint.set(fp, idx);
      });
    });

    let added = 0;
    /* DEBUG: surface what statuses the account actually returns so margin/cash
       differences are visible in `wrangler tail`. */
    console.log('[journal] history orders:', orders.length,
      'statuses:', JSON.stringify([...new Set(orders.map(o => o.status))]));

    /* ── ONE-SHOT DEBUG: dump the DETAIL payload for the first filled order so the
       real fee field name is confirmable in `wrangler tail`. Remove after verify. ── */
    const probe = orders.find(o => String(o.status||'').toUpperCase().includes('FILL') && o.clientOrderId);
    if (probe) {
      const det = await fetchOrderDetail(probe.clientOrderId, accountId, env);
      console.log('[order/detail] PROBE keys:', JSON.stringify(det ? Object.keys(det) : null));
      console.log('[order/detail] PROBE extracted fee:', extractFee(det));
      console.log('[order/detail] PROBE payload:', JSON.stringify(det));
    }
    /* Treat an order as fillable if Webull marks it filled in ANY casing/variant
       (FILLED, Filled, PARTIAL_FILLED, partially_filled, …) or it has filled qty.
       Cash→Margin switch changed the status string, which the old strict
       `!== 'FILLED'` check silently dropped. */
    const isFilled = o => {
      const s = String(o.status || '').toUpperCase();
      if (s.includes('FILL')) return true;            // FILLED / PARTIAL_FILLED / FILLED_PARTIALLY
      return (parseFloat(o.filled) || 0) > 0;          // fallback: any filled quantity
    };
    for (const o of orders) {
      if (!isFilled(o)) continue;
      const id = o.orderId;
      if (!id) continue;

      const fee = parseFloat(o.fee) || 0;
      const oDate = (o.filledAt || o.createdAt || '').slice(0, 10);
      const fp = `${(o.ticker||'').toUpperCase()}|${(o.side||'').toUpperCase()}|${oDate}`;

      if (knownIds.has(id)) {
        /* Known by id — patch fee if missing */
        if (fee > 0) {
          const idx = journal.trades.findIndex(t =>
            t.id === id || t.orderId === id ||
            (t.legs||[]).some(l => l._wbId === id || l.orderId === id)
          );
          if (idx >= 0) {
            if (!journal.trades[idx].commission || journal.trades[idx].commission === 0) {
              journal.trades[idx].commission = fee;
            }
            const legs = journal.trades[idx].legs || [];
            const legIdx = legs.findIndex(l => l._wbId === id || l.action === (o.side||'').toUpperCase());
            if (legIdx >= 0 && (!legs[legIdx].fee || legs[legIdx].fee === 0)) {
              journal.trades[idx].legs[legIdx].fee = fee;
              added++;
            }
          }
        }
        continue;
      }

      /* Not known by id — try fingerprint match to backfill fee on imported/manual entries */
      if (fee > 0 && tradeByFingerprint.has(fp)) {
        const idx = tradeByFingerprint.get(fp);
        const legs = journal.trades[idx].legs || [];
        const legIdx = legs.findIndex(l => l.action === (o.side||'').toUpperCase());
        if (legIdx >= 0 && (!legs[legIdx].fee || legs[legIdx].fee === 0)) {
          journal.trades[idx].legs[legIdx].fee = fee;
          if (!journal.trades[idx].commission || journal.trades[idx].commission === 0) {
            journal.trades[idx].commission = fee;
          }
          knownIds.add(id);
          added++;
        }
        continue;
      }

      journal.trades.unshift(orderToEntry(o));
      knownIds.add(id);
      added++;
    }
    if (added > 0) {
      await saveJournal(env, journal);
      console.log(`[journal] Synced ${added} new trade(s)/fee patch(es)`);
    }
    return journal.trades;
  } catch(e) {
    console.error('[journal] sync error:', e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ERROR MAP
   ══════════════════════════════════════════════════════════════════════════ */
function mapError(err) {
  const s = err.status;
  if (s === 401) return 'Webull auth failed — invalid token or signature';
  if (s === 403) return 'Webull access denied — check API permissions';
  if (s === 429) return 'Webull rate limit — wait and retry';
  if (s >= 500)  return 'Webull API unavailable';
  return err.message || 'Unknown error';
}

/* ══════════════════════════════════════════════════════════════════════════
   SEQUENTIAL FETCH  (avoids 429 burst)
   ══════════════════════════════════════════════════════════════════════════ */
async function fetchSequential(accountId, env) {
  const results = { account: null, positions: [], orders: [], history: [], activities: [], errors: {} };
  try { results.account   = await fetchBalance(accountId, env);            } catch(e) { results.errors.account   = e.message; }
  await delay(400);
  try { results.positions = await fetchPositions(accountId, env);          } catch(e) { results.errors.positions = e.message; }
  await delay(400);
  try { results.orders    = await fetchOrders(accountId, 'open', env);     } catch(e) { results.errors.orders    = e.message; }
  await delay(400);
  try { results.history   = await fetchOrders(accountId, 'history', env);  } catch(e) { results.errors.history   = e.message; }
  return results;
}

/* ══════════════════════════════════════════════════════════════════════════
   ROUTER  (matches original Express routes exactly)
   ══════════════════════════════════════════════════════════════════════════ */
async function handleRequest(request, env) {
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method.toUpperCase();

  // Preflight
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ── Health ──────────────────────────────────────────────────────────────
  // ── App Check gate ────────────────────────────────────────────────────
  // /api/portfolio/* is a live Webull brokerage account and /api/journal is a
  // personal trade record; both were readable by anyone with the URL. The repo
  // is public, so no client-held key could ever be a secret — an App Check
  // token is minted at runtime against the registered origin and is the only
  // credential a public browser app can actually keep. /api/health stays open
  // so uptime checks keep working (it no longer reports token state).
  if (path.startsWith('/api/portfolio') || path.startsWith('/api/journal')) {
    const denied = await requireAppCheck(request, corsHeaders());
    if (denied) return denied;
  }

  if (path === '/api/health' && method === 'GET') {
    const cached = await loadToken(env);
    return json({
      ok:          true,
      configured:  !!(env.WEBULL_APP_KEY && env.WEBULL_APP_SECRET),
      tokenStatus: cached?.status || 'NONE',
      tokenExpiry: cached?.expireTime || null,
      timestamp:   new Date().toISOString(),
    });
  }

  // ── Create token ─────────────────────────────────────────────────────────
  if (path === '/api/portfolio/create-token' && method === 'POST') {
    try {
      const endpoint = '/openapi/auth/token/create';
      const body     = {};
      const headers  = await makeHeaders({ reqPath: endpoint, body: JSON.stringify(body), env });
      const res = await fetch(`${WB_BASE}${endpoint}`, {
        method: 'POST',
        headers,
        body:   JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json();
      await saveToken(env, {
        token:      data.token || data.access_token,
        status:     data.status || 'PENDING',
        expireTime: data.expireTime || data.expire_time,
        createTime: new Date().toISOString(),
      });
      return json({ ok: true, status: data.status, message: 'Token created. Open Webull app → Menu → Messages → OpenAPI Notifications → verify SMS code.' });
    } catch(err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // ── Token status ──────────────────────────────────────────────────────────
  if (path === '/api/portfolio/token-status' && method === 'GET') {
    try {
      const cached = await loadToken(env);
      if (!cached?.token) return json({ ok: true, status: 'NONE', message: 'No token created yet.' });
      const endpoint = '/openapi/auth/token/check';
      const body     = { token: cached.token };
      const headers  = await makeHeaders({ reqPath: endpoint, body: JSON.stringify(body), env });
      const res    = await fetch(`${WB_BASE}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const data   = await res.json();
      const status = data.status || data.token_status || cached.status;
      await saveToken(env, { ...cached, status });
      return json({ ok: true, status, message: status === 'NORMAL' ? '✓ Token active.' : `Status: ${status}. Verify in Webull app.` });
    } catch(err) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // ── Accounts (debug + cache-bust) ─────────────────────────────────────────
  // GET /api/portfolio/accounts        → list every account + its balance
  // GET /api/portfolio/accounts?reset=1 → also clear cached id & re-resolve
  if (path === '/api/portfolio/accounts' && method === 'GET') {
    try {
      if (url.searchParams.get('reset') === '1') {
        await env.TB_KV.delete('wb_account');
      }
      const list = await fetchAccountList(env);
      const out  = [];
      for (const a of list) {
        const id = acctIdOf(a);
        let netLiq = null, cash = null;
        try {
          const bal = await wb('GET', '/openapi/assets/balance', { query: { account_id: id } }, env);
          netLiq = p((bal || {}).total_net_liquidation_value || 0);
          cash   = p((bal || {}).total_cash_balance || 0);
        } catch (e) { /* leave null */ }
        out.push({ id, type: a.account_type || a.accountType || null, status: a.status || null, netLiq, cash });
        await delay(300);
      }
      const resolved = await getAccountId(env, { force: true });
      return json({ ok: true, accounts: out, resolvedAccountId: resolved });
    } catch (err) {
      return json({ ok: false, error: mapError(err) }, 500);
    }
  }

  // ── Raw balance (debug) ───────────────────────────────────────────────────
  // GET /api/portfolio/balance-raw → untouched Webull /assets/balance payload.
  // Webull renames buying-power fields between API versions; this is how you
  // find out what they're called today without redeploying to read a log line.
  if (path === '/api/portfolio/balance-raw' && method === 'GET') {
    try {
      const accountId = url.searchParams.get('account_id') || await getAccountId(env);
      const raw = await wb('GET', '/openapi/assets/balance', { query: { account_id: accountId } }, env);
      return json({ ok: true, accountId, mapped: mapBalance(raw, accountId), raw });
    } catch (err) {
      return json({ ok: false, error: mapError(err) }, 500);
    }
  }

  // ── Portfolio summary ────────────────────────────────────────────────────
  if (path === '/api/portfolio/summary' && method === 'GET') {
    try {
      /* TOKEN GATE — getAccountId reads the cached id from KV without a token,
         and fetchSequential swallows per-fetch throws into `errors`. Together
         that let an EXPIRED token return ok:true with empty data → UI showed a
         fake "LIVE" dashboard of $0 instead of the reconnect screen. Check the
         token up front so a dead/pending token surfaces as 401 + code, which is
         what the front-end connect flow listens for. */
      const tok = await loadToken(env);
      if (!tok?.token)             throw { code: 'NO_TOKEN',      message: 'No token — connect to Webull.' };
      if (tok.status !== 'NORMAL') throw { code: 'TOKEN_PENDING', message: `Token status: ${tok.status}. Verify in Webull app.` };

      const accountId = await getAccountId(env);
      const { account, positions, orders, history, activities, errors } = await fetchSequential(accountId, env);

      /* If the balance fetch failed (account null), don't pretend we're live —
         a connected account always returns a balance object. */
      if (!account) {
        return json({ ok: false, error: errors?.account || 'No account data from Webull', code: 'NO_DATA', errors }, 502);
      }

      const totalVal = account?.totalValue || 0;
      return json({
        ok: true,
        data: {
          account,
          positions: (positions || []).map(p2 => ({ ...p2, allocationPct: totalVal > 0 ? (p2.marketValue / totalVal) * 100 : 0 })),
          orders:     orders     || [],
          history:    history    || [],
          activities: activities || [],
          errors,
        },
      });
    } catch(err) {
      if (err.code === 'NO_TOKEN' || err.code === 'TOKEN_PENDING') {
        return json({ ok: false, error: err.message, code: err.code }, 401);
      }
      return json({ ok: false, error: mapError(err) }, 500);
    }
  }

  // ── Journal: GET all ─────────────────────────────────────────────────────
  if (path === '/api/journal' && method === 'GET') {
    const journal = await loadJournal(env);
    return json({ ok: true, data: journal.trades });
  }

  // ── Journal: POST manual entry ───────────────────────────────────────────
  if (path === '/api/journal' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { ticker, side, qty, avgFill, date, setupType, timeframe, tags, notes,
            orderType, commission, netPnL, pnlPct, legs, market, direction,
            target, stopLoss, confidence, status } = body;
    if (!ticker || !side) return json({ ok: false, error: 'ticker and side required' }, 400);
    const entry = {
      id:         crypto.randomUUID(),
      source:     'manual',
      ticker:     ticker.toUpperCase().trim(),
      side:       side.toUpperCase(),
      market:     market    || 'STOCK',
      direction:  direction || 'LONG',
      target:     target    || null,
      stopLoss:   stopLoss  || null,
      qty:        parseFloat(qty)     || 0,
      avgFill:    parseFloat(avgFill) || 0,
      gross:      (parseFloat(qty)||0) * (parseFloat(avgFill)||0),
      orderType:  orderType || 'LIMIT',
      commission: parseFloat(commission) || 0,
      netPnL:     netPnL != null ? parseFloat(netPnL) : null,
      pnlPct:     pnlPct != null ? parseFloat(pnlPct) : null,
      setupType:  setupType  || '',
      timeframe:  timeframe  || '',
      confidence: parseInt(confidence) || 0,
      status:     status     || null,
      legs:       Array.isArray(legs) ? legs : [],
      tags:       Array.isArray(tags) ? tags : (tags ? tags.split(',').map(t=>t.trim()) : []),
      notes:      notes || '',
      date:       date  || new Date().toISOString(),
      createdAt:  new Date().toISOString(),
    };
    const journal = await loadJournal(env);
    journal.trades.unshift(entry);
    await saveJournal(env, journal);
    return json({ ok: true, data: entry });
  }

  // ── Journal: PATCH ───────────────────────────────────────────────────────
  const patchMatch = path.match(/^\/api\/journal\/(.+)$/);
  if (patchMatch && method === 'PATCH') {
    const id   = patchMatch[1];
    const body = await request.json().catch(() => ({}));
    const journal = await loadJournal(env);
    const idx  = journal.trades.findIndex(t => t.id === id);
    if (idx === -1) return json({ ok: false, error: 'Entry not found' }, 404);
    const allowed = ['notes','setupType','timeframe','tags','commission','netPnL','pnlPct','ticker','side','qty','avgFill','date','orderType','legs','market','direction','target','stopLoss','confidence','status'];
    for (const k of allowed) {
      if (body[k] !== undefined) journal.trades[idx][k] = body[k];
    }
    journal.trades[idx].gross = journal.trades[idx].qty * journal.trades[idx].avgFill;
    await saveJournal(env, journal);
    return json({ ok: true, data: journal.trades[idx] });
  }

  // ── Journal: DELETE ──────────────────────────────────────────────────────
  if (patchMatch && method === 'DELETE') {
    const id      = patchMatch[1];
    const journal = await loadJournal(env);
    const before  = journal.trades.length;
    journal.trades = journal.trades.filter(t => t.id !== id);
    if (journal.trades.length === before) return json({ ok: false, error: 'Not found' }, 404);
    await saveJournal(env, journal);
    return json({ ok: true });
  }

  // ── Journal: Webull sync ─────────────────────────────────────────────────
  if (path === '/api/journal/sync' && method === 'POST') {
    const trades = await syncJournalFromWebull(env);
    const journal = await loadJournal(env);
    return json({ ok: true, data: journal.trades });
  }

  // ── 404 ──────────────────────────────────────────────────────────────────
  return json({ ok: false, error: `Not found: ${method} ${path}` }, 404);
}

/* ══════════════════════════════════════════════════════════════════════════
   WORKER ENTRY POINT
   ══════════════════════════════════════════════════════════════════════════ */
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch(err) {
      console.error('[worker] unhandled:', err);
      return json({ ok: false, error: 'Internal server error' }, 500);
    }
  },
};
