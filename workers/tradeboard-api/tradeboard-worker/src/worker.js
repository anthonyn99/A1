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
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Pragma',
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
   ACCOUNT ID  (cached in KV for 1 hour)
   ══════════════════════════════════════════════════════════════════════════ */
async function getAccountId(env) {
  const cached = await env.TB_KV.get('wb_account');
  if (cached) return cached;
  const raw  = await wb('GET', '/openapi/account/list', {}, env);
  const list = Array.isArray(raw) ? raw : (raw?.data || []);
  if (!list.length) throw new Error('No accounts found.');
  const id = list[0].account_id;
  await env.TB_KV.put('wb_account', id, { expirationTtl: 3600 }); // cache 1h
  return id;
}

/* ══════════════════════════════════════════════════════════════════════════
   DATA FETCHERS
   ══════════════════════════════════════════════════════════════════════════ */
const p = n => { const x = parseFloat(n); return isNaN(x) ? 0 : x; };

const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchBalance(accountId, env) {
  const raw  = await wb('GET', '/openapi/assets/balance', { query: { account_id: accountId } }, env);
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
    overnightBP:       pick('night_trading_buying_power','overnight_buying_power'),
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

  // ── Portfolio summary ────────────────────────────────────────────────────
  if (path === '/api/portfolio/summary' && method === 'GET') {
    try {
      const accountId = await getAccountId(env);
      const { account, positions, orders, history, activities, errors } = await fetchSequential(accountId, env);
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
