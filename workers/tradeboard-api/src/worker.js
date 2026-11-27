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

/* `version` is the x-version header. The /openapi/... paths this worker has always
   used answer to v2; Webull's current /trading/... and /market-data/... paths are
   v3. x-version is not part of the signature, so signing is the same for both. */
async function makeHeaders({ reqPath, queryParams = {}, body = null, token = null, env, version = 'v2' }) {
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
    'x-version':             version,
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
async function wb(method, endpoint, { query = {}, body = null, requireToken = true, version = 'v2' } = {}, env) {
  let token = null;
  if (requireToken) {
    const cached = await loadToken(env);
    if (!cached?.token) throw { code: 'NO_TOKEN', message: 'No token — call /api/portfolio/create-token first, then verify in Webull app.' };
    if (cached.status !== 'NORMAL') throw { code: 'TOKEN_PENDING', message: `Token status: ${cached.status}. Verify in Webull app.` };
    token = cached.token;
  }

  const bodyStr = body ? JSON.stringify(body) : null;
  const headers = await makeHeaders({ reqPath: endpoint, queryParams: query, body: bodyStr, token, env, version });

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
  /* (The raw payload is on GET /api/portfolio/balance-raw; it is no longer
     written to the worker log on every refresh.) */
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

/* Pull the real fee off a Webull order object. Field name varies, so probe
   known candidates, then sum component fees (SEC + TAF + commission + tax).
   Also digs filled-leg arrays. Returns a float (0 if none). */
function extractFee(r) {
  if (!r || typeof r !== 'object') return 0;
  // 0) Webull's current order shape: commission is an object
  //    {actual_commission, receivable_commission} and fees an array of
  //    {type, actual_value, receivable_value}. parseFloat() of either is NaN,
  //    so the probes below never saw them.
  let shaped = 0;
  if (r.commission && typeof r.commission === 'object' && !Array.isArray(r.commission)) {
    const c = parseFloat(r.commission.actual_commission ?? r.commission.receivable_commission);
    if (!isNaN(c) && c > 0) shaped += c;
  }
  if (Array.isArray(r.fees)) {
    shaped += r.fees.reduce((a, f) => { const v = parseFloat(f && (f.actual_value ?? f.receivable_value ?? f.amount)); return a + (isNaN(v) || v < 0 ? 0 : v); }, 0);
  }
  if (shaped > 0) return Math.round(shaped * 10000) / 10000;
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

/* ORDER HISTORY WINDOW. Webull's history endpoint answers the LAST 7 DAYS unless
   it is given start_date/end_date (yyyy-MM-dd), 10 rows a page unless page_size is
   set. Called bare, History, the FIFO realized P&L and the Journal sync only ever
   saw one week: a week without a sync lost those fills for good.

   READ IN WINDOWS, NEVER BY PAGING (2026-11-27). Given a date range, Webull
   returns at most page_size (100) order GROUPS, in no time order, and its
   last_client_order_id cursor means nothing on an unordered list: page two
   repeated most of page one, page three was usually refused (429), and orders
   simply never came back. The 30-day read held 255 of the month's orders and
   was missing the 11/27 TSLA buy at 8:35 (1 @ 398.74), so the 8:37 sell that
   closed it read NO BASIS. A window with fewer than 100 groups is complete, so
   the range is read in windows of HISTORY_WINDOW_DAYS, newest first, and a
   window that comes back full is split in half and read again until every
   window fits. The result carries `complete: false` when the call budget ran
   out or a window failed, so the caller can say so instead of trusting it. */
const HISTORY_DAYS = 30;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_WINDOW_DAYS = 7;
const HISTORY_PAGE_GAP_MS = 1100;   // history allows 2 calls per 2 s
const DAY_MS = 86400000;
const ymd = d => d.toISOString().slice(0, 10);

function flattenOrderGroups(list) {
  const flat = [];
  for (const item of list) {
    const inner = item && item.orders;
    if (Array.isArray(inner) && inner.length) { for (const o of inner) flat.push(o); }
    else if (item) flat.push(item);
  }
  return flat;
}
const listOf = raw => (Array.isArray(raw) ? raw : (raw?.data || raw?.orders || raw?.items || []));

async function fetchHistoryRaw(accountId, env, { days = HISTORY_DAYS, maxCalls = 16 } = {}) {
  /* Day numbers (UTC). The end is TOMORROW: Webull's end date is exclusive, and
     sent as today none of today's orders came back (Tony, 2026-11-04: PLTR
     165 → 175 bracket, not pulled). Adjacent windows share one boundary, so
     whatever day Webull's dates mean, together they cover the whole range. */
  const endDay = Math.floor(Date.now() / DAY_MS) + 1;
  const startDay = endDay - days - 1;
  const dayStr = n => ymd(new Date(n * DAY_MS));
  const query = (s, e, extra) => ({ account_id: accountId, page_size: HISTORY_PAGE_SIZE, start_date: dayStr(s), end_date: dayStr(e), ...extra });
  /* Long ranges (the 2-year fee-id pass) start with wider windows, leaving half
     the budget for splits. */
  const width = Math.max(HISTORY_WINDOW_DAYS, Math.ceil((endDay - startDay) / Math.max(1, Math.floor(maxCalls / 2))));
  const todo = [];   // a stack, oldest first: pop() reads the newest window
  for (let s = startDay; s < endDay; s += width) todo.push([s, Math.min(s + width, endDay)]);

  const out = [], ids = new Set();
  const take = groups => {
    let fresh = 0;
    for (const o of flattenOrderGroups(groups)) {
      const id = o.order_id || o.client_order_id;
      if (id && ids.has(id)) continue;
      if (id) ids.add(id);
      out.push(o); fresh++;
    }
    return fresh;
  };
  let calls = 0, complete = true;
  const ask = async q => {
    if (calls++) await delay(HISTORY_PAGE_GAP_MS);
    try { return listOf(await wb('GET', '/openapi/trade/order/history', { query: q }, env)); }
    catch (e) {
      if (e.status !== 429) throw e;
      await delay(2 * HISTORY_PAGE_GAP_MS);   // one retry: the limit is per 2 s
      calls++;
      return listOf(await wb('GET', '/openapi/trade/order/history', { query: q }, env));
    }
  };

  while (todo.length) {
    if (calls >= maxCalls) { complete = false; break; }
    const [s, e] = todo.pop();
    let groups;
    try { groups = await ask(query(s, e)); }
    catch (err) {
      if (!out.length && calls <= 2) {
        /* A 4xx on the first window means this account's endpoint refused the
           date range. Fall back to the call that has always worked (Webull's
           own 7-day default) rather than losing History entirely. 401/429/5xx
           are not about the parameters: those are thrown. */
        if (!(err.status >= 400 && err.status < 500) || err.status === 401 || err.status === 429) throw err;
        console.warn('[orders/history] date range refused (' + err.status + '), using the 7-day default');
        const raw = await wb('GET', '/openapi/trade/order/history', { query: { account_id: accountId, page_size: HISTORY_PAGE_SIZE } }, env);
        const flat = flattenOrderGroups(listOf(raw));
        flat.complete = false;
        return flat;
      }
      console.warn('[orders/history] window', dayStr(s), 'to', dayStr(e), 'failed:', err.message);
      complete = false;
      continue;
    }
    take(groups);
    if (groups.length < HISTORY_PAGE_SIZE) continue;   // the window is whole
    if (e - s > 1) {
      const mid = s + Math.floor((e - s) / 2);
      todo.push([s, mid], [mid, e]);                   // the newer half is read first
      continue;
    }
    /* One day with 100+ order groups: the cursor is all that is left. Page on
       while pages bring something new; the day counts as complete only when a
       page comes back short. */
    let page = groups, whole = false;
    for (let n = 0; n < 3 && calls < maxCalls; n++) {
      const last = page[page.length - 1];
      const cursor = last && (last.client_order_id || (last.orders && last.orders[0] && last.orders[0].client_order_id));
      if (!cursor) break;
      let next;
      try { next = await ask(query(s, e, { last_client_order_id: cursor })); }
      catch (err) { console.warn('[orders/history] day', dayStr(s), 'page', n + 2, 'failed:', err.message); break; }
      const fresh = take(next);
      if (next.length < HISTORY_PAGE_SIZE) { whole = true; break; }
      if (!fresh) break;
      page = next;
    }
    if (!whole) complete = false;
  }
  if (!complete) console.warn('[orders/history] incomplete:', calls, 'calls,', todo.length, 'window(s) unread');
  out.complete = complete;
  return out;
}

async function fetchOrders(accountId, type = 'open', env, opts = {}) {
  try {
    const flat = type === 'open'
      ? flattenOrderGroups(listOf(await wb('GET', '/openapi/trade/order/open', { query: { account_id: accountId, page_size: 100 } }, env)))
      : await fetchHistoryRaw(accountId, env, opts);

    const rows = flat.map(r => ({
      orderId:   r.order_id         || r.client_order_id,
      clientOrderId: r.client_order_id,
      ticker:    r.symbol           || r.ticker?.symbol || r.instrument?.symbol || '',
      side:      r.side             || r.action || r.order_side || '',
      qty:       p(r.total_quantity    || r.quantity || r.qty || 0),
      filled:    p(r.filled_quantity   || r.filled_qty || 0),
      price:     p(r.limit_price       || r.filled_price || 0),
      /* Stop/trigger price — an open STOP order has no limit_price at all, so
         without this the UI can only report it as a market order. */
      stopPrice: p(r.stop_price        || r.aux_price || 0),
      avgFill:   p(r.filled_price      || r.avg_filled_price || 0),
      total:     p(r.filled_amount     || 0),
      fee:       extractFee(r),
      status:    r.status,
      orderType: r.order_type,
      tif:       r.time_in_force       || 'DAY',
      createdAt: r.place_time_at       || r.create_time,
      filledAt:  r.filled_time_at      || r.filled_time,
    }));
    rows.complete = flat.complete !== false;   // false: History could not read every window
    return rows;
  } catch(e) { console.error('[orders]', e.message); const none = []; none.complete = false; return none; }
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
    clientOrderId: order.clientOrderId || null,
    source:     'webull',
    ticker:     order.ticker || '',
    side,
    market:     'STOCK',
    /* Webull marks a short sale side 'SHORT' (its cover is a plain BUY), so
       only that side is known to be short here. TradeHub works out the real
       position direction when it groups the fills (tbGroupLegsIntoPositions). */
    direction:  side === 'SHORT' ? 'SHORT' : 'LONG',
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
    // 30 days, up to 3 pages: a missed week (or three) of syncs still lands.
    const orders  = await fetchOrders(accountId, 'history', env, { days: HISTORY_DAYS, maxCalls: 24 });
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

    /* Also build a map: ticker+side+day+qty+price → trade index, for fee backfill
       matching. Quantity and price are part of the key: keyed on the day alone,
       a second same-day order in the same ticker matched the first one's entry
       and was dropped instead of added.
       Only imported/manual entries are indexed. A source:'webull' entry IS an
       order, already matched by id above — letting an unknown order "patch" it
       is how the second 9/9 PLTR buy (1@170, same as the first) was consumed as
       a fee backfill on the first buy and never added. */
    const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
    const fpOf = (tk, side, dt, qty, price) =>
      `${(tk||'').toUpperCase()}|${(side||'').toUpperCase()}|${String(dt||'').slice(0, 10)}|${num(qty)}|${num(price)}`;
    const tradeByFingerprint = new Map();
    journal.trades.forEach((t, idx) => {
      if (t.source === 'webull') return;
      (t.legs || []).forEach(l => {
        const fp = fpOf(t.ticker, l.action || t.side, l.datetime || t.date, l.qty, l.price);
        if (!tradeByFingerprint.has(fp)) tradeByFingerprint.set(fp, { idx, leg: l });
      });
    });

    let added = 0, coidAdded = 0;
    /* DEBUG: surface what statuses the account actually returns so margin/cash
       differences are visible in `wrangler tail`. */
    console.log('[journal] history orders:', orders.length,
      'statuses:', JSON.stringify([...new Set(orders.map(o => o.status))]));

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
      const fp = fpOf(o.ticker, o.side, o.filledAt || o.createdAt,
                      parseFloat(o.filled) || o.qty, parseFloat(o.avgFill) || o.price);

      if (knownIds.has(id)) {
        const idx = journal.trades.findIndex(t =>
          t.id === id || t.orderId === id ||
          (t.legs||[]).some(l => l._wbId === id || l.orderId === id)
        );
        /* The client_order_id is what an order's detail (its fees) is read by. */
        if (idx >= 0 && o.clientOrderId && !journal.trades[idx].clientOrderId) { journal.trades[idx].clientOrderId = o.clientOrderId; coidAdded++; }
        /* Known by id — patch fee if missing */
        if (fee > 0) {
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

      /* Not known by id — try fingerprint match to backfill fee on imported/manual
         entries. Only an actual patch consumes the order: it used to `continue`
         regardless, so an order whose twin already had a fee was never added. */
      const fpHit = fee > 0 && tradeByFingerprint.get(fp);
      if (fpHit && !(parseFloat(fpHit.leg.fee) > 0)) {
        const t = journal.trades[fpHit.idx];
        fpHit.leg.fee = fee;
        if (!t.commission || t.commission === 0) t.commission = fee;
        tradeByFingerprint.delete(fp);
        knownIds.add(id);
        added++;
        continue;
      }

      journal.trades.unshift(orderToEntry(o));
      knownIds.add(id);
      added++;
    }
    /* Fees for the newest orders, read from each order's detail (a few per
       sync; the rest of any backlog is /api/journal/fees's job). */
    const coidById = new Map(orders.filter(o => o.orderId && o.clientOrderId).map(o => [o.orderId, o.clientOrderId]));
    const fees = await backfillFees(env, journal, accountId, { maxCalls: 6, coidOf: t => t.clientOrderId || coidById.get(t.id) });
    if (added > 0 || coidAdded > 0 || fees.changed) {
      await saveJournal(env, journal);
      console.log(`[journal] Synced ${added} new trade(s)/fee patch(es), ${fees.updated} fee(s) read`);
    }
    return { trades: journal.trades, feesRemaining: fees.remaining, historyComplete: orders.complete !== false };
  } catch(e) {
    console.error('[journal] sync error:', e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ORDER FEES  (2026-11-03)
   The history list does not reliably carry fees; an order's DETAIL does
   (commission {actual_commission} + fees [{type, actual_value}], e.g. the SEC fee
   and FINRA TAF on a sell, the CAT fee on every order). Each filled order's
   detail is read ONCE: the answer, fee or not, is recorded on its journal entry
   (`feeChecked`), so a fee is never asked for twice. Webull allows 2 detail
   calls per 2 s, so calls are spaced and capped per request.
   ══════════════════════════════════════════════════════════════════════════ */
const FEE_CALL_GAP_MS = 1100;
const FEE_DETAIL_PATHS = [['/trading/orders/get', 'v3'], ['/openapi/trade/order/detail', 'v2']];

/* {ok:true, fee} | {ok:false, retry} — retry=false means Webull answered
   definitively that it has no such order (a 4xx other than 401/429). `ver`
   carries the index of the detail path that worked, so one request stops
   trying the other. */
async function fetchOrderFee(accountId, clientOrderId, env, ver) {
  const order = ver && ver.i != null ? [FEE_DETAIL_PATHS[ver.i]] : FEE_DETAIL_PATHS;
  let last = null;
  for (const [path, version] of order) {
    try {
      const raw = await wb('GET', path, { query: { account_id: accountId, client_order_id: clientOrderId }, version }, env);
      if (ver) ver.i = FEE_DETAIL_PATHS.findIndex(p => p[0] === path);
      return { ok: true, fee: extractFee(raw?.data || raw) };
    } catch (e) {
      last = e;
      if (e && (e.code || e.status === 401 || e.status === 429 || !(e.status >= 400))) return { ok: false, retry: true };
      if (order.length > 1) await delay(FEE_CALL_GAP_MS);
    }
  }
  return { ok: false, retry: !(last && last.status >= 400 && last.status < 500) };
}

/* A Webull journal entry still waiting for its fee: one order, never checked,
   no fee on it. Older worker versions merged several fills into one entry;
   those cannot be matched to a single order and are left alone. */
function entryNeedsFee(t) {
  if (!t || t.source !== 'webull' || t.feeChecked) return false;
  if ((t.legs || []).length > 1) return false;
  if (parseFloat(t.commission) > 0) return false;
  return !(t.legs && t.legs[0] && parseFloat(t.legs[0].fee) > 0);
}

/* Reads fees for up to `maxCalls` entries. `coidOf(t)` names the
   client_order_id (the detail call's key); an entry with none is tried by its
   own id, which IS the client_order_id when Webull sent no order_id. Mutates
   the entries; returns what it did. */
async function backfillFees(env, journal, accountId, { maxCalls, coidOf }) {
  let calls = 0, updated = 0, stopped = false;
  const ver = {};
  for (const t of journal.trades) {
    if (!entryNeedsFee(t)) continue;
    if (calls >= maxCalls) break;
    if (calls) await delay(FEE_CALL_GAP_MS);
    calls++;
    const coid = coidOf(t) || t.id;
    const r = await fetchOrderFee(accountId, coid, env, ver);
    if (!r.ok) {
      if (r.retry) { stopped = true; break; }      // rate limit / auth / outage: try again later
      t.feeChecked = 'missing';
      continue;
    }
    t.feeChecked = true;
    if (coid !== t.id) t.clientOrderId = coid;
    if (r.fee > 0) {
      t.commission = r.fee;
      if (t.legs && t.legs[0]) t.legs[0].fee = r.fee;
      updated++;
    }
  }
  const remaining = journal.trades.filter(entryNeedsFee).length;
  return { calls, updated, remaining, stopped, changed: calls > 0 };
}

/* ══════════════════════════════════════════════════════════════════════════
   CASH ACTIVITY  (2026-11-03) — dividends, deposits/withdrawals, fees, tax,
   interest, corporate actions. Webull's /trading/activities/cash-activities/
   list (v3). It refuses a range that crosses a calendar year, so the range is
   split by year, and it pages with pagination_key. Trades are left out: they
   are already in History and would bury everything else.
   ══════════════════════════════════════════════════════════════════════════ */
const CASH_TYPES = 'DEPOSIT,WITHDRAW,FEES,TRANSFER,DIVIDENDS,TAX,INTERESTS,CORPORATE_ACTION,OPTION_EA,JOURNAL';
const isoMs = d => d.toISOString().replace(/\.\d{3}Z$/, '.000Z');

function mapCashActivity(r) {
  return {
    id:       r.id || null,
    type:     String(r.activity_type || '').toUpperCase(),
    sub:      String(r.activity_sub_type || '').toUpperCase(),
    symbol:   r.symbol || '',
    date:     r.trade_date || (r.biz_time ? String(r.biz_time).slice(0, 10) : ''),
    at:       r.biz_time || null,
    amount:   p(r.net_amount),
    currency: r.currency || 'USD',
  };
}

async function fetchCashActivities(accountId, env, { days }) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const ranges = [];
  for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
    const a = y === start.getUTCFullYear() ? start : new Date(Date.UTC(y, 0, 1));
    const b = y === end.getUTCFullYear() ? end : new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    ranges.push([a, b]);
  }
  const out = [];
  let withTypes = true;
  for (const [a, b] of ranges) {
    let key = null;
    for (let page = 0; page < 8; page++) {
      const query = { account_id: accountId, start_time: isoMs(a), end_time: isoMs(b) };
      if (withTypes) query.activity_types = CASH_TYPES;
      if (key) query.pagination_key = key;
      let raw;
      try {
        raw = await wb('GET', '/trading/activities/cash-activities/list', { query, version: 'v3' }, env);
      } catch (e) {
        /* A list of types the endpoint will not take: ask for everything and
           drop trades here instead. Anything else is a real failure. */
        if (withTypes && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) { withTypes = false; page--; continue; }
        throw e;
      }
      const rows = Array.isArray(raw) ? raw : (raw?.data || []);
      rows.forEach(r => { const m = mapCashActivity(r); if (m.type !== 'TRADE' && m.type !== 'EC_SETTLEMENT') out.push(m); });
      key = raw && !Array.isArray(raw) ? raw.pagination_key : null;
      if (!key || !rows.length) break;
      await delay(600);
    }
  }
  const seen = new Set();
  return out.filter(x => { const k = x.id || (x.type + x.sub + x.date + x.amount + x.symbol); if (seen.has(k)) return false; seen.add(k); return true; })
            .sort((x, y) => String(y.at || y.date).localeCompare(String(x.at || x.date)));
}

/* ══════════════════════════════════════════════════════════════════════════
   MARKET DATA  (2026-11-03) — Webull snapshots (incl. pre/after-hours) and
   today's 5-minute bars for sparklines. Webull serves these through OpenAPI only
   with an OpenAPI market-data subscription (Nasdaq Basic, bought for OpenAPI —
   the app's own subscription does not count). Without one this answers
   {ok:false, code:'NO_MARKET_DATA'} and TradeHub uses its free fallback.
   ══════════════════════════════════════════════════════════════════════════ */
function mapSnapshot(r) {
  const price = p(r.price), prev = p(r.pre_close);
  const ratio = r.change_ratio != null && r.change_ratio !== '' ? p(r.change_ratio) * 100 : (prev ? (price - prev) / prev * 100 : null);
  const extPrice = p(r.extend_hour_last_price);
  const extRatio = r.extend_hour_change_ratio != null && r.extend_hour_change_ratio !== '' ? p(r.extend_hour_change_ratio) * 100 : null;
  return {
    price, prevClose: prev || null, dp: ratio,
    ext: extPrice ? { price: extPrice, dp: extRatio, at: r.extend_hour_last_trade_time || null } : null,
    at: r.last_trade_time || null,
  };
}

async function fetchSnapshots(symbols, env) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 20) {
    const chunk = symbols.slice(i, i + 20);
    for (const category of ['US_STOCK', 'US_ETF']) {
      const need = chunk.filter(s => !out[s]);
      if (!need.length) break;
      const raw = await wb('GET', '/market-data/stocks/snapshots/list',
        { query: { symbols: need.join(','), category, extend_hour_required: 'true' }, version: 'v3' }, env);
      const rows = Array.isArray(raw) ? raw : (raw?.data || raw?.result || []);
      rows.forEach(r => { if (r && r.symbol) out[String(r.symbol).toUpperCase()] = mapSnapshot(r); });
    }
  }
  return out;
}

/* Today's session (pre-market through after-hours) as 5-minute closes, at most
   ~60 points per symbol: enough for a sparkline, small enough to cache. */
async function fetchSparkBars(symbols, env) {
  const out = {};
  const since = Date.now() - 20 * 3600 * 1000;
  for (let i = 0; i < symbols.length; i += 20) {
    const chunk = symbols.slice(i, i + 20);
    const raw = await wb('POST', '/market-data/stocks/bars/list',
      { body: { symbols: chunk, category: 'US_STOCK', timespan: 'M5', count: 200, trading_sessions: 'PRE,RTH,ATH' }, version: 'v3' }, env);
    const list = Array.isArray(raw) ? raw : (raw?.result || raw?.data || []);
    for (const s of list) {
      const bars = (s.result || []).map(b => ({ t: Date.parse(b.time), c: p(b.close) })).filter(b => b.t >= since && b.c > 0).sort((a, b) => a.t - b.t);
      if (bars.length) out[String(s.symbol).toUpperCase()] = downsample(bars.map(b => b.c), 60);
    }
  }
  return out;
}
function downsample(arr, n) {
  if (arr.length <= n) return arr;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * (arr.length - 1) / (n - 1))]);
  return out;
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
   WATCHLISTS (read-only; Webull OpenAPI v3, added by Webull 2026-09-20)
   GET /market-data/watchlists/list → [{ watchlist_id, name, sort, ... }]
   GET /market-data/watchlists/instruments/list?watchlist_id= → { instruments: [{ symbol, name, exchange_code, sort }] }
   Both come sorted by `sort` DESCENDING, which is the REVERSE of Webull's app (Tony,
   2026-11-20: Trackers came back SOXX, DXY, VIX; his app shows VIX, DXY, SOXX). So both
   are put in `sort` ascending order here: the app's order, top first.
   An instrument with no `symbol` (futures and Treasury yields in Trackers came back
   missing) is kept under its other name fields; one with none is counted in `skipped`
   with the fields it had, so a gap says why instead of hiding.
   At most 20 lists, so ≤ 21 subrequests.
   ══════════════════════════════════════════════════════════════════════════ */
// Webull's app order: `sort` ascending; equal sorts keep the reverse of the order received.
const wlAppOrder = (a) => a.slice().reverse().sort((x, y) => (Number(x.sort) || 0) - (Number(y.sort) || 0));
const wlSymbol = (i) => String(i.symbol || i.ticker || i.disSymbol || i.display_symbol || i.symbol_name || i.code || '').trim().toUpperCase();
async function fetchWatchlists(env) {
  const raw = await wb('GET', '/market-data/watchlists/list', { version: 'v3' }, env);
  const lists = wlAppOrder((Array.isArray(raw) ? raw : listOf(raw)).slice(0, 20));
  const out = [];
  for (const l of lists) {
    const id = String(l.watchlist_id ?? l.id ?? '');
    if (!id) continue;
    let tickers = [], error = null, skipped = null;
    try {
      const r = await wb('GET', '/market-data/watchlists/instruments/list', { query: { watchlist_id: id }, version: 'v3' }, env);
      const items = (Array.isArray(r?.instruments) ? r.instruments : listOf(r)).filter((i) => i && typeof i === 'object');
      const bad = items.filter((i) => !wlSymbol(i));
      if (bad.length) skipped = { n: bad.length, fields: Object.keys(bad[0]).slice(0, 20) };
      tickers = wlAppOrder(items.filter((i) => wlSymbol(i)))
        .map((i) => ({ symbol: wlSymbol(i), name: i.name || '', exchange: i.exchange_code || '', sort: Number(i.sort) || 0 }));
    } catch (e) { error = e.message || 'failed'; }
    out.push({ id, name: String(l.name || ''), sort: Number(l.sort) || 0, updated: l.update_time || null, tickers, ...(skipped ? { skipped } : {}), ...(error ? { error } : {}) });
  }
  return out;
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
   CAPABILITIES CHECK  (GET /api/portfolio/capabilities, 2026-11-20)
   Asks Webull, one call at a time, whether this key may use each READ endpoint
   the worker already relies on, and reports only what came back: HTTP status,
   allowed / denied (401, 403, 417) / errored, and how many fields or rows the
   answer had. Never the token, the secret, an account id or any balance,
   position or order value. The one write-shaped call is Webull's token check
   (a POST that only reads the token's state, as /token-status does). No order,
   preview, replace or cancel endpoint is ever named here: Webull stays
   read-only in TradeHub.
   ══════════════════════════════════════════════════════════════════════════ */
const CAP_GAP_MS = 1100;   // balance, positions, orders and detail allow 2 calls per 2 s
const capVerdict = (s) => (s >= 200 && s < 300 ? 'allowed' : (s === 401 || s === 403 || s === 417) ? 'denied' : 'errored');
function capShape(raw) {
  if (Array.isArray(raw)) return { rows: raw.length, fields: raw[0] && typeof raw[0] === 'object' ? Object.keys(raw[0]).length : 0 };
  if (raw && typeof raw === 'object') {
    const inner = listOf(raw);
    return { fields: Object.keys(raw).length, ...(Array.isArray(inner) && inner !== raw ? { rows: inner.length } : {}) };
  }
  return { fields: 0 };
}
/* Short string values under a key naming the account's type or class (CASH,
   MARGIN, INDIVIDUAL...), one level deep. Nothing else is read off the answer. */
function capAccountTypes(raw) {
  const out = new Set();
  const scan = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (/^(account_?type|account_?class|account_?category|margin_?type|type)$/i.test(k) && typeof v === 'string' && v.length <= 24 && !/\d{5,}/.test(v)) out.add(k + '=' + v);
    }
  };
  const list = Array.isArray(raw) ? raw : (listOf(raw).length ? listOf(raw) : [raw]);
  for (const a of list) { scan(a); if (a && typeof a === 'object') for (const v of Object.values(a)) if (v && typeof v === 'object' && !Array.isArray(v)) scan(v); }
  return [...out];
}
function capTimeLeft(expire) {
  if (expire == null || expire === '') return null;
  const n = typeof expire === 'number' || /^\d+$/.test(String(expire)) ? Number(expire) : Date.parse(expire);
  if (!isFinite(n)) return null;
  const ms = (n < 1e12 ? n * 1000 : n) - Date.now();
  return { expiresAt: new Date(ms + Date.now()).toISOString(), msLeft: ms, daysLeft: Math.round(ms / 864e5 * 10) / 10 };
}

async function probeCapabilities(env) {
  const results = [];
  const probe = async (name, method, endpoint, opts = {}) => {
    const row = { endpoint: name, path: endpoint, method, version: opts.version || 'v2' };
    try {
      const raw = await wb(method, endpoint, opts, env);
      Object.assign(row, { status: 200, result: 'allowed' }, capShape(raw));
      results.push(row);
      return raw;
    } catch (e) {
      if (e && e.code) Object.assign(row, { status: null, result: 'skipped', reason: e.code });
      else {
        const d = (e && e.wbData) || {};
        const status = (e && e.status) || null;
        Object.assign(row, { status, result: status ? capVerdict(status) : 'errored' });
        const code = d.error_code || d.code || d.errorCode;
        const msg = d.message || d.msg || (e && e.message);
        if (code) row.webullCode = String(code).slice(0, 60);
        if (msg) row.webullMessage = String(msg).slice(0, 160);
      }
      results.push(row);
      return null;
    } finally { await delay(CAP_GAP_MS); }
  };

  // Token: the cached state, then Webull's own check of it.
  const cached = await loadToken(env);
  const token = { cached: cached?.token ? (cached.status || 'UNKNOWN') : 'NONE', createdAt: cached?.createTime || null };
  if (cached?.token) {
    const endpoint = '/openapi/auth/token/check';
    const row = { endpoint: 'token check', path: endpoint, method: 'POST', version: 'v2' };
    try {
      const body = JSON.stringify({ token: cached.token });
      const headers = await makeHeaders({ reqPath: endpoint, body, env });
      const res = await fetch(`${WB_BASE}${endpoint}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
      const data = await res.json().catch(() => ({}));
      Object.assign(row, { status: res.status, result: capVerdict(res.status), fields: Object.keys(data || {}).length });
      token.webullStatus = data.status || data.token_status || null;
      token.checkExpiry = data.expireTime ?? data.expire_time ?? data.expires_at ?? null;
    } catch (e) { Object.assign(row, { status: null, result: 'errored', reason: (e && e.message || 'failed').slice(0, 120) }); }
    results.push(row);
    const exp = token.checkExpiry ?? cached.expireTime ?? null;
    token.expiry = exp;
    token.timeLeft = capTimeLeft(exp);
    if (cached.createTime) token.ageDays = Math.round((Date.now() - Date.parse(cached.createTime)) / 864e5 * 10) / 10;
    await delay(CAP_GAP_MS);
  }

  // Account list → its types, then the account the dashboard reads.
  const list = await probe('account list', 'GET', '/openapi/account/list');
  const accounts = list ? (Array.isArray(list) ? list : (list.data || list.accounts || [])) : [];
  const accountTypes = list ? capAccountTypes(list) : [];
  let accountId = null;
  if (accounts.length) {
    const cachedId = await env.TB_KV.get('wb_account');
    const ids = accounts.map(acctIdOf).filter(Boolean);
    accountId = cachedId && ids.includes(cachedId) ? cachedId : ids[0] || null;
  }
  const acct = accountId ? { account_id: accountId } : null;
  const skip = (name, path, version = 'v2') => results.push({ endpoint: name, path, method: 'GET', version, status: null, result: 'skipped', reason: 'no account id' });

  let balanceTypes = [];
  if (acct) {
    const bal = await probe('balance', 'GET', '/openapi/assets/balance', { query: acct });
    if (bal) balanceTypes = capAccountTypes(bal);
    await probe('positions', 'GET', '/openapi/assets/positions', { query: acct });
    const hist = await probe('order history (7 days)', 'GET', '/openapi/trade/order/history', { query: { ...acct, page_size: 10 } });
    await probe('open orders', 'GET', '/openapi/trade/order/open', { query: { ...acct, page_size: 10 } });
    const first = hist ? flattenOrderGroups(listOf(hist)).find((o) => o && o.client_order_id) : null;
    if (first) {
      for (const [path, version] of FEE_DETAIL_PATHS) {
        await probe('order detail ' + version, 'GET', path, { query: { ...acct, client_order_id: first.client_order_id }, version });
      }
    } else for (const [path, version] of FEE_DETAIL_PATHS) results.push({ endpoint: 'order detail ' + version, path, method: 'GET', version, status: null, result: 'skipped', reason: 'no order in the last 7 days to look up' });
    const end = new Date(), start = new Date(end.getTime() - 7 * 864e5);
    await probe('cash activities (7 days)', 'GET', '/trading/activities/cash-activities/list', { query: { ...acct, start_time: isoMs(start), end_time: isoMs(end) }, version: 'v3' });
  } else {
    skip('balance', '/openapi/assets/balance'); skip('positions', '/openapi/assets/positions');
    skip('order history (7 days)', '/openapi/trade/order/history'); skip('open orders', '/openapi/trade/order/open');
    for (const [path, version] of FEE_DETAIL_PATHS) skip('order detail ' + version, path, version);
    skip('cash activities (7 days)', '/trading/activities/cash-activities/list', 'v3');
  }

  const wl = await probe('watchlists', 'GET', '/market-data/watchlists/list', { version: 'v3' });
  const wlList = wl ? (Array.isArray(wl) ? wl : listOf(wl)) : [];
  const wlId = wlList.length ? String(wlList[0].watchlist_id ?? wlList[0].id ?? '') : '';
  if (wlId) await probe('watchlist instruments', 'GET', '/market-data/watchlists/instruments/list', { query: { watchlist_id: wlId }, version: 'v3' });
  const snap = await probe('quote snapshot (SPY)', 'GET', '/market-data/stocks/snapshots/list', { query: { symbols: 'SPY', category: 'US_ETF', extend_hour_required: 'true' }, version: 'v3' });
  const snapRow = results[results.length - 1];
  const snapRows = snap ? (Array.isArray(snap) ? snap : (snap.data || snap.result || [])) : [];
  const marketData = snapRow.result === 'allowed'
    ? (snapRows.length ? 'subscribed (quotes returned)' : 'allowed but no quotes returned')
    : snapRow.result === 'denied' ? 'not subscribed (' + snapRow.status + ')' : snapRow.result + (snapRow.status ? ' (' + snapRow.status + ')' : '');

  const tally = results.reduce((t, r) => (t[r.result] = (t[r.result] || 0) + 1, t), {});
  return {
    ok: true,
    asOf: new Date().toISOString(),
    token,
    accounts: { count: accounts.length, types: accountTypes, balanceTypeFields: balanceTypes },
    marketData,
    tally,
    results,
    note: 'Read endpoints only. No order, preview, replace or cancel endpoint was called. 5-minute bars (a POST) were not probed.',
  };
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
  if (path.startsWith('/api/portfolio') || path.startsWith('/api/journal') || path.startsWith('/api/market')) {
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

  // ── Capabilities (GET only; see probeCapabilities) ────────────────────────
  if (path === '/api/portfolio/capabilities' && method === 'GET') {
    try {
      const out = await probeCapabilities(env);
      return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...corsHeaders() } });
    } catch (err) {
      return json({ ok: false, error: (err && err.message) || 'probe failed' }, 500);
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
    const res = await syncJournalFromWebull(env);
    const journal = await loadJournal(env);
    return json({ ok: true, data: journal.trades, feesRemaining: (res && res.feesRemaining) || 0, historyComplete: !!(res && res.historyComplete) });
  }

  // ── Journal: read fees for past orders (POST /api/journal/fees) ──────────
  // TradeHub calls this until `remaining` is 0. The first call that finds
  // entries without a client_order_id reads up to two years of order history
  // once, only to learn those ids (an order's detail is keyed by it), and
  // returns; every call after reads up to 15 details. Each answer is recorded
  // on its entry, so the whole pass happens once.
  if (path === '/api/journal/fees' && method === 'POST') {
    try {
      const tok = await loadToken(env);
      if (!tok?.token || tok.status !== 'NORMAL') return json({ ok: false, error: 'Webull is not connected', code: 'NO_TOKEN' }, 401);
      const accountId = await getAccountId(env);
      const journal = await loadJournal(env);
      const lacking = journal.trades.filter(t => entryNeedsFee(t) && !t.clientOrderId);
      if (lacking.length && !(await env.TB_KV.get('fee_ids_read'))) {
        const hist = await fetchOrders(accountId, 'history', env, { days: 730, maxCalls: 20 });
        const coidById = new Map(hist.filter(o => o.orderId && o.clientOrderId).map(o => [o.orderId, o.clientOrderId]));
        let n = 0;
        for (const t of lacking) { const c = coidById.get(t.id); if (c) { t.clientOrderId = c; n++; } }
        if (n) await saveJournal(env, journal);
        await env.TB_KV.put('fee_ids_read', String(Date.now()), { expirationTtl: 7 * 86400 });
        return json({ ok: true, phase: 'ids', idsFound: n, updated: 0, remaining: journal.trades.filter(entryNeedsFee).length, data: journal.trades });
      }
      const r = await backfillFees(env, journal, accountId, { maxCalls: 15, coidOf: t => t.clientOrderId });
      if (r.changed) await saveJournal(env, journal);
      return json({ ok: true, phase: 'fees', updated: r.updated, checked: r.calls, remaining: r.remaining, stopped: r.stopped, data: journal.trades });
    } catch (err) {
      return json({ ok: false, error: (err && err.message) || mapError(err) }, 500);
    }
  }

  // ── Cash activity (GET /api/portfolio/activities?days=N, 7 ≤ N ≤ 400) ─────
  if (path === '/api/portfolio/activities' && method === 'GET') {
    try {
      const tok = await loadToken(env);
      if (!tok?.token || tok.status !== 'NORMAL') return json({ ok: false, error: 'Webull is not connected', code: 'NO_TOKEN' }, 401);
      const days = Math.max(7, Math.min(400, parseInt(url.searchParams.get('days') || '365', 10) || 365));
      const accountId = await getAccountId(env);
      const items = await fetchCashActivities(accountId, env, { days });
      return json({ ok: true, days, items, asOf: new Date().toISOString() });
    } catch (err) {
      return json({ ok: false, error: err.code ? err.message : mapError(err), status: err.status || null }, err.code ? 401 : 502);
    }
  }

  // ── Watchlists (GET /api/portfolio/watchlists[?fresh=1]) ─────────────────
  // Read-only. Cached 60 s at the edge (Cache API, no KV).
  if (path === '/api/portfolio/watchlists' && method === 'GET') {
    const cacheReq = new Request('https://tb-cache.internal/watchlists');
    if (url.searchParams.get('fresh') !== '1') {
      try { const hit = await caches.default.match(cacheReq); if (hit) return json(await hit.json()); } catch (e) {}
    }
    try {
      const lists = await fetchWatchlists(env);
      const payload = { ok: true, lists, asOf: Date.now() };
      try { await caches.default.put(cacheReq, new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } })); } catch (e) {}
      return json(payload);
    } catch (err) {
      return json({ ok: false, code: err.code || null, status: err.status || null, error: err.code ? err.message : mapError(err), detail: err.wbData || null }, err.code ? 401 : 502);
    }
  }

  // ── Market data (GET /api/market/quotes?symbols=A,B&bars=1) ───────────────
  // Cached 60 s at the edge (Cache API: no KV, no quota), keyed by the list.
  if (path === '/api/market/quotes' && method === 'GET') {
    const symbols = [...new Set(String(url.searchParams.get('symbols') || '').toUpperCase().split(',').map(x => x.trim()).filter(x => /^[A-Z][A-Z0-9.-]{0,9}$/.test(x)))].slice(0, 60);
    if (!symbols.length) return json({ ok: false, error: 'symbols required' }, 400);
    const wantBars = url.searchParams.get('bars') === '1';
    const cacheReq = new Request('https://tb-cache.internal/mq/' + (wantBars ? 'b/' : '') + symbols.slice().sort().join(','));
    try { const hit = await caches.default.match(cacheReq); if (hit) return json(await hit.json()); } catch (e) {}
    try {
      const quotes = await fetchSnapshots(symbols, env);
      if (!Object.keys(quotes).length) return json({ ok: false, code: 'NO_MARKET_DATA', error: 'Webull returned no quotes' });
      if (wantBars) {
        try { const pts = await fetchSparkBars(symbols, env); for (const [k, v] of Object.entries(pts)) if (quotes[k]) quotes[k].points = v; } catch (e) {}
      }
      const payload = { ok: true, source: 'webull', quotes, asOf: Date.now() };
      try { await caches.default.put(cacheReq, new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' } })); } catch (e) {}
      return json(payload);
    } catch (err) {
      /* No OpenAPI market-data subscription answers 401/403/417. Say so
         plainly; TradeHub falls back to its free quotes. */
      return json({ ok: false, code: err.code || 'NO_MARKET_DATA', status: err.status || null, error: (err && err.message) || 'market data unavailable' });
    }
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
