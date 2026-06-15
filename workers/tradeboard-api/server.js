/**
 * TradeBoard — server.js
 *
 * Webull auth flow:
 *   1. First run: POST /openapi/auth/token/create → get token (PENDING)
 *   2. Open Webull app → Menu → Messages → OpenAPI Notifications → verify SMS code
 *   3. Token becomes NORMAL — cached in token.json, valid 15 days
 *   4. All API calls include x-auth-token header + HMAC-SHA1 signature
 *
 * Firebase migration: copy WEBULL SERVICE block into functions/index.js
 */

require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3001;
app.use(express.json());

/* ══════════════════════════════════════════════════════════════════════════
   WEBULL SERVICE START
   ══════════════════════════════════════════════════════════════════════════ */

const WB_HOST      = 'api.webull.com';
const WB_BASE      = `https://${WB_HOST}`;
const TOKEN_FILE   = path.join(__dirname, '.webull-token.json');

// ── Signature ────────────────────────────────────────────────────────────────
function sign({ reqPath, queryParams = {}, body = null, appKey, appSecret, host, timestamp, nonce }) {
  const signingHeaders = {
    'host':                  host,
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
    const str2    = crypto.createHash('md5').update(bodyStr, 'utf8').digest('hex').toUpperCase();
    str3 = `${reqPath}&${str1}&${str2}`;
  } else {
    str3 = `${reqPath}&${str1}`;
  }

  const encoded = encodeURIComponent(str3);
  const key     = `${appSecret}&`;
  return crypto.createHmac('sha1', key).update(encoded, 'utf8').digest('base64');
}

function makeHeaders({ reqPath, queryParams = {}, body = null, token = null }) {
  const appKey    = process.env.WEBULL_APP_KEY;
  const appSecret = process.env.WEBULL_APP_SECRET;
  if (!appKey || !appSecret) throw new Error('WEBULL_APP_KEY / WEBULL_APP_SECRET missing in .env');

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce     = uuidv4().replace(/-/g, '');
  const sig       = sign({ reqPath, queryParams, body, appKey, appSecret, host: WB_HOST, timestamp, nonce });

  const headers = {
    'x-app-key':             appKey,
    'x-timestamp':           timestamp,
    'x-signature':           sig,
    'x-signature-algorithm': 'HMAC-SHA1',
    'x-signature-version':   '1.0',
    'x-signature-nonce':     nonce,
    'x-version':             'v2',
  };
  if (token)  headers['x-access-token'] = token;
  if (body)   headers['Content-Type'] = 'application/json';
  return headers;
}

// ── Token persistence ─────────────────────────────────────────────────────────
function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {}
  return null;
}
function saveToken(data) {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// ── Token lifecycle ───────────────────────────────────────────────────────────
async function wb(method, endpoint, { query = {}, body = null, requireToken = true } = {}) {
  const appKey    = process.env.WEBULL_APP_KEY;
  const appSecret = process.env.WEBULL_APP_SECRET;

  let token = null;
  if (requireToken) {
    const cached = loadToken();
    if (!cached?.token) throw { code: 'NO_TOKEN', message: 'No token — call /api/portfolio/create-token first, then verify in Webull app.' };
    if (cached.status !== 'NORMAL') throw { code: 'TOKEN_PENDING', message: `Token status: ${cached.status}. Verify in Webull app (Menu → Messages → OpenAPI Notifications).` };
    token = cached.token;
  }

  const bodyStr = body ? JSON.stringify(body) : null;
  const headers = makeHeaders({ reqPath: endpoint, queryParams: query, body: bodyStr, token });

  try {
    const res = await axios({
      method: method.toLowerCase(),
      url:    `${WB_BASE}${endpoint}`,
      params: query,
      data:   bodyStr,
      headers,
      timeout: 12000,
    });
    return res.data;
  } catch(err) {
    console.error(`[wb] ${method} ${endpoint} → ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
    throw err;
  }
}

// ── Account ID cache ──────────────────────────────────────────────────────────
let _accountId = null;
async function getAccountId() {
  if (_accountId) return _accountId;
  const raw  = await wb('GET', '/openapi/account/list');
  const list = Array.isArray(raw) ? raw : (raw?.data || []);
  if (!list.length) throw new Error('No accounts found.');
  _accountId = list[0].account_id;
  console.log(`[TradeBoard] Account ID: ${_accountId}`);
  return _accountId;
}

// ── Data fetchers ─────────────────────────────────────────────────────────────
const p = n => { const x = parseFloat(n); return isNaN(x) ? 0 : x; };

async function fetchBalance(accountId) {
  const raw = await wb('GET', '/openapi/assets/balance', { query: { account_id: accountId } });
  const d   = raw || {};
  const acct = (d.account_currency_assets || [])[0] || {};
  return {
    accountId,
    accountType:       'Margin',
    currency:          d.total_asset_currency              || 'USD',
    totalValue:        p(d.total_net_liquidation_value     || 0),
    netLiquidation:    p(d.total_net_liquidation_value     || 0),
    marketValue:       p(d.total_market_value              || 0),
    cashBalance:       p(d.total_cash_balance              || 0),
    buyingPower:       p(acct.buying_power                 || 0),
    overnightBP:       p(acct.night_trading_buying_power   || 0),
    settledCash:       p(acct.settled_cash                 || 0),
    unsettledCash:     p(acct.unsettled_cash               || 0),
    dayPnL:            p(d.total_day_profit_loss           || 0),
    unrealizedPnL:     p(d.total_unrealized_profit_loss    || 0),
    unrealizedPct:     p(acct.unrealized_profit_loss_rate  || 0),
    realizedPnL:       p(acct.realized_profit_loss         || 0),
    initialMargin:     p(acct.initial_margin               || 0),
    maintenanceMargin: p(acct.maintenance_margin           || 0),
    excessLiquidity:   p(acct.excess_liquidity             || 0),
    _fetchedAt:        new Date().toISOString(),
  };
}

async function fetchPositions(accountId) {
  const raw  = await wb('GET', '/openapi/assets/positions', { query: { account_id: accountId } });
  const list = Array.isArray(raw) ? raw : (raw?.data || raw?.positions || []);
  return list.map(r => {
    const qty      = p(r.quantity    || r.qty       || 0);
    const avgCost  = p(r.cost_price  || r.avg_cost  || 0);
    const mktPrice = p(r.last_price  || r.mkt_price || 0);
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

async function fetchOrders(accountId, type = 'open') {
  try {
    const endpoint = type === 'open'
      ? '/openapi/trade/order/open'
      : '/openapi/trade/order/history';
    const raw  = await wb('GET', endpoint, { query: { account_id: accountId, page_size: 50 } });
    const list = Array.isArray(raw) ? raw : (raw?.data || raw?.orders || raw?.items || []);

    // History returns combo wrappers with nested orders[] — flatten them
    const flat = [];
    for (const item of list) {
      const inner = item.orders;
      if (Array.isArray(inner) && inner.length) {
        for (const o of inner) flat.push(o);
      } else {
        flat.push(item);
      }
    }

    return flat.map(r => ({
      orderId:   r.order_id        || r.client_order_id,
      ticker:    r.symbol          || r.ticker?.symbol,
      side:      r.side,
      qty:       p(r.total_quantity   || r.quantity || 0),
      filled:    p(r.filled_quantity  || 0),
      price:     p(r.limit_price      || r.filled_price || 0),
      avgFill:   p(r.filled_price     || r.avg_filled_price || 0),
      total:     p(r.filled_amount    || 0),
      fee:       p(r.commission       || r.fee || r.total_fee || r.fees || 0),
      status:    r.status,
      orderType: r.order_type,
      tif:       r.time_in_force      || r.time_in_forc || 'DAY',
      createdAt: r.place_time_at      || r.create_time,
      filledAt:  r.filled_time_at     || r.filled_time,
    }));
  } catch(e) { console.error('[orders]', e.message); return []; }
}

async function fetchActivities(accountId) {
  try {
    // No dedicated activities endpoint confirmed — skip gracefully
    return [];
  } catch { return []; }
}

/* WEBULL SERVICE END */

/* ══════════════════════════════════════════════════════════════════════════
   API ROUTES
   ══════════════════════════════════════════════════════════════════════════ */

// Health + token status
app.get('/api/health', (req, res) => {
  const cached = loadToken();
  res.json({
    ok:          true,
    configured:  !!(process.env.WEBULL_APP_KEY && process.env.WEBULL_APP_SECRET),
    tokenStatus: cached?.status || 'NONE',
    tokenExpiry: cached?.expireTime || null,
    timestamp:   new Date().toISOString(),
  });
});

// Step 1: Create token — call this once, then verify in app
app.post('/api/portfolio/create-token', async (req, res) => {
  try {
    const endpoint = '/openapi/auth/token/create';
    const body     = {};
    const bodyStr  = JSON.stringify(body);
    const headers  = makeHeaders({ reqPath: endpoint, body: bodyStr });
    headers['Content-Type'] = 'application/json';

    const result = await axios.post(`${WB_BASE}${endpoint}`, bodyStr, { headers, timeout: 12000 });
    const data   = result.data;

    // Save token to disk
    saveToken({
      token:      data.token || data.access_token,
      status:     data.status || 'PENDING',
      expireTime: data.expireTime || data.expire_time,
      createTime: new Date().toISOString(),
    });

    console.log('[TradeBoard] Token created, status:', data.status);
    res.json({ ok: true, status: data.status, message: 'Token created. Open Webull app → Menu → Messages → OpenAPI Notifications → verify SMS code.' });
  } catch (err) {
    console.error('[create-token]', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.msg || err.message });
  }
});

// Step 2: Check token status
app.get('/api/portfolio/token-status', async (req, res) => {
  try {
    const cached = loadToken();
    if (!cached?.token) return res.json({ ok: true, status: 'NONE', message: 'No token created yet.' });

    const endpoint = '/openapi/auth/token/check';
    const body     = { token: cached.token };
    const bodyStr  = JSON.stringify(body);
    const headers  = makeHeaders({ reqPath: endpoint, body: bodyStr });
    headers['Content-Type'] = 'application/json';

    const result = await axios.post(`${WB_BASE}${endpoint}`, bodyStr, { headers, timeout: 10000 });
    const data   = result.data;
    const status = data.status || data.token_status || cached.status;

    // Update cached status
    saveToken({ ...cached, status });
    console.log('[TradeBoard] Token status:', status);

    res.json({ ok: true, status, message: status === 'NORMAL' ? '✓ Token active — portfolio data available.' : `Status: ${status}. Verify in Webull app.` });
  } catch (err) {
    console.error('[token-status]', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.msg || err.message });
  }
});

// Rate-limit guard: prevent concurrent summary requests
let _summaryInFlight = false;
let _summaryLastAt   = 0;
const SUMMARY_COOLDOWN_MS = 20000; // 20s minimum between full fetches
const delay = ms => new Promise(r => setTimeout(r, ms));

// Sequential fetch helper — one request at a time with gap between each
async function fetchSequential(accountId) {
  const results = { account: null, positions: [], orders: [], history: [], activities: [], errors: {} };

  try { results.account    = await fetchBalance(accountId);           } catch(e) { results.errors.account    = e.message; }
  await delay(400);
  try { results.positions  = await fetchPositions(accountId);         } catch(e) { results.errors.positions  = e.message; }
  await delay(400);
  try { results.orders     = await fetchOrders(accountId, 'open');    } catch(e) { results.errors.orders     = e.message; }
  await delay(400);
  try { results.history    = await fetchOrders(accountId, 'history'); } catch(e) { results.errors.history    = e.message; }
  // activities always empty — no extra request
  return results;
}

// Main data endpoint
app.get('/api/portfolio/summary', async (req, res) => {
  try {
    // Block concurrent requests
    if (_summaryInFlight) {
      return res.status(429).json({ ok: false, error: 'Request already in progress — try again shortly.' });
    }
    // Enforce cooldown unless forced
    const age = Date.now() - _summaryLastAt;
    if (age < SUMMARY_COOLDOWN_MS && req.query.force !== '1') {
      return res.status(429).json({ ok: false, error: `Rate limited — wait ${Math.ceil((SUMMARY_COOLDOWN_MS - age) / 1000)}s before refreshing.` });
    }

    _summaryInFlight = true;
    _summaryLastAt   = Date.now();
    try {
      const accountId = await getAccountId();
      const { account, positions, orders, history, activities, errors } = await fetchSequential(accountId);
      const totalVal = account?.totalValue || 0;
      res.json({
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
    } finally {
      _summaryInFlight = false;
    }
  } catch (err) {
    _summaryInFlight = false;
    const code = err.code;
    if (code === 'NO_TOKEN' || code === 'TOKEN_PENDING') {
      return res.status(401).json({ ok: false, error: err.message, code });
    }
    console.error('[summary]', err.message);
    res.status(500).json({ ok: false, error: mapError(err) });
  }
});

app.get('/api/portfolio/account',   async (req, res) => wrap(res, async () => { const id = await getAccountId(); return fetchBalance(id); }));
app.get('/api/portfolio/positions', async (req, res) => wrap(res, async () => { const id = await getAccountId(); return fetchPositions(id); }));
app.get('/api/portfolio/orders',    async (req, res) => wrap(res, async () => { const id = await getAccountId(); return fetchOrders(id, 'open'); }));
app.get('/api/portfolio/history',   async (req, res) => wrap(res, async () => { const id = await getAccountId(); return fetchOrders(id, 'history'); }));

async function wrap(res, fn) {
  try { res.json({ ok: true, data: await fn() }); }
  catch (err) { res.status(err.response?.status || 500).json({ ok: false, error: mapError(err) }); }
}

function mapError(err) {
  const s = err.response?.status;
  if (s === 401) return 'Webull auth failed — invalid token or signature';
  if (s === 403) return 'Webull access denied — check API permissions';
  if (s === 429) return 'Webull rate limit — wait and retry';
  if (s >= 500)  return 'Webull API unavailable';
  if (err.code === 'ENOTFOUND') return 'Cannot reach api.webull.com';
  return err.message || 'Unknown error';
}

/* ══════════════════════════════════════════════════════════════════════════
   JOURNAL
   Permanent local storage in journal.json.
   Firebase migration: replace loadJournal/saveJournal with Firestore reads/writes.
   ══════════════════════════════════════════════════════════════════════════ */

const JOURNAL_FILE = path.join(__dirname, 'journal.json');

function loadJournal() {
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')); }
  catch { return { trades: [], lastSyncedOrderIds: [] }; }
}
function saveJournal(data) {
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(data, null, 2));
}

// Build a journal entry from a filled order
function orderToEntry(order) {
  const qty     = parseFloat(order.qty)    || 0;
  const avgFill = parseFloat(order.avgFill) || parseFloat(order.price) || 0;
  const side    = (order.side || 'BUY').toUpperCase();
  const dt      = order.filledAt || order.createdAt || new Date().toISOString();

  // Synthesize legs so the new UI can compute stats from them
  const legs = [{ id: uuidv4(), action: side, datetime: dt, qty, price: avgFill, fee: parseFloat(order.fee) || 0 }];

  // A SELL order = closed trade; BUY = open position
  const status = side === 'SELL' ? 'CLOSED' : 'OPEN';

  return {
    id:         order.orderId || uuidv4(),
    source:     'auto',
    ticker:     order.ticker  || '',
    side,
    market:     'STOCK',
    direction:  'LONG',
    qty,
    avgFill,
    gross:      qty * avgFill,
    orderType:  order.orderType || 'LIMIT',
    commission: 0,
    netPnL:     null,
    pnlPct:     null,
    setupType:  '',
    timeframe:  '',
    confidence: 0,
    status,
    legs,
    tags:       [],
    notes:      '',
    date:       dt,
    createdAt:  new Date().toISOString(),
  };
}

// Auto-sync: pull recent fills, add any not already in journal
let _syncInFlight = false;
async function syncJournalFromWebull() {
  if (_syncInFlight) return; // skip if already running
  _syncInFlight = true;
  try {
    const cached = loadToken();
    if (!cached?.token || cached.status !== 'NORMAL') return;
    const accountId = await getAccountId();
    await delay(500); // breathe before next request
    const orders    = await fetchOrders(accountId, 'history');
    const journal   = loadJournal();
    const known     = new Set(journal.trades.map(t => t.id));
    let added = 0;
    for (const o of orders) {
      if (o.status !== 'FILLED') continue;
      const id = o.orderId;
      if (!id || known.has(id)) continue;
      journal.trades.unshift(orderToEntry(o));
      known.add(id);
      added++;
    }
    if (added > 0) {
      saveJournal(journal);
      console.log(`[journal] Auto-synced ${added} new trade(s)`);
    }
  } catch(e) { console.error('[journal] sync error:', e.message); }
  finally { _syncInFlight = false; }
}

// GET all journal entries
app.get('/api/journal', (req, res) => {
  const journal = loadJournal();
  res.json({ ok: true, data: journal.trades });
});

// POST manual entry
app.post('/api/journal', (req, res) => {
  const { ticker, side, qty, avgFill, date, setupType, timeframe, tags, notes, orderType, commission, netPnL, pnlPct, legs, market, direction, target, stopLoss, confidence, status } = req.body;
  if (!ticker || !side) return res.status(400).json({ ok: false, error: 'ticker and side required' });
  const entry = {
    id:         uuidv4(),
    source:     'manual',
    ticker:     ticker.toUpperCase().trim(),
    side:       side.toUpperCase(),
    market:     market     || 'STOCK',
    direction:  direction  || 'LONG',
    target:     target     || null,
    stopLoss:   stopLoss   || null,
    qty:        parseFloat(qty)     || 0,
    avgFill:    parseFloat(avgFill) || 0,
    gross:      (parseFloat(qty)||0) * (parseFloat(avgFill)||0),
    orderType:  orderType  || 'LIMIT',
    commission: parseFloat(commission) || 0,
    netPnL:     netPnL  != null ? parseFloat(netPnL)  : null,
    pnlPct:     pnlPct  != null ? parseFloat(pnlPct)  : null,
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
  const journal = loadJournal();
  journal.trades.unshift(entry);
  saveJournal(journal);
  res.json({ ok: true, data: entry });
});

// PATCH update notes / fields on existing entry
app.patch('/api/journal/:id', (req, res) => {
  const journal = loadJournal();
  const idx = journal.trades.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Entry not found' });
  const allowed = ['notes','setupType','timeframe','tags','commission','netPnL','pnlPct','ticker','side','qty','avgFill','date','orderType','legs','market','direction','target','stopLoss','confidence','status'];
  for (const k of allowed) {
    if (req.body[k] !== undefined) journal.trades[idx][k] = req.body[k];
  }
  // Recompute gross if qty/avgFill changed
  journal.trades[idx].gross = journal.trades[idx].qty * journal.trades[idx].avgFill;
  saveJournal(journal);
  res.json({ ok: true, data: journal.trades[idx] });
});

// DELETE entry
app.delete('/api/journal/:id', (req, res) => {
  const journal = loadJournal();
  const before  = journal.trades.length;
  journal.trades = journal.trades.filter(t => t.id !== req.params.id);
  if (journal.trades.length === before) return res.status(404).json({ ok: false, error: 'Not found' });
  saveJournal(journal);
  res.json({ ok: true });
});

// POST trigger manual sync from Webull
app.post('/api/journal/sync', async (req, res) => {
  await syncJournalFromWebull();
  const journal = loadJournal();
  res.json({ ok: true, data: journal.trades });
});

/* ══════════════════════════════════════════════════════════════════════════
   SERVE HTML
   ══════════════════════════════════════════════════════════════════════════ */
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'TradeBoard_v3.html')));

/* ══════════════════════════════════════════════════════════════════════════
   START
   ══════════════════════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  const ok     = !!(process.env.WEBULL_APP_KEY && process.env.WEBULL_APP_SECRET);
  const cached = loadToken();
  console.log(`\n  TradeBoard`);
  console.log(`  ──────────────────────────────`);
  console.log(`  Open        → http://localhost:${PORT}`);
  console.log(`  Creds       → ${ok ? '✓ Set' : '✗ MISSING — edit .env'}`);
  console.log(`  Token       → ${cached?.status || 'NONE — open Portfolio tab to set up'}`);
  console.log('');
  // Auto-sync journal: wait 30s on startup (let portfolio fetch settle first), then every 5 min
  setTimeout(syncJournalFromWebull, 30000);
  setInterval(syncJournalFromWebull, 5 * 60 * 1000);
});
