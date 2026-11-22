// Webull PAPER trading (Batch 4 T1, A1-Priv docs/TradeHub/quant-trading.md): the Webull SANDBOX only.
// It reaches one host, pinned in WEBULL_HOST (never built from input); Webull production is never
// called (tests/quant-api.test.js). Every route answers in the SAME shapes as lib/paper.js (Alpaca),
// so the page reads either broker with one code path. Every order passes paper.js's checkOrder and
// this broker's kill switch, and is logged in paper_orders (broker = 'webull') BEFORE it is sent.
//
//   GET    /trade/webull/account[?account=]   { account, accounts, kill }   (default: Individual Margin)
//   GET    /trade/webull/positions             { positions }
//   GET    /trade/webull/orders?status=open|closed|all
//   GET    /trade/webull/activities            { fills }   (filled orders of the last 7 days)
//   POST   /trade/webull/orders                { order, who, reason? }   (Alpaca-shaped order in, Webull body out)
//   PATCH  /trade/webull/orders/:id            { qty?, limit_price?, stop_price?, trail?, who }
//   DELETE /trade/webull/orders/:id            cancel one (id = the client order id)
//   DELETE /trade/webull/positions/:symbol     close one at market
//   POST   /trade/webull/kill                  { on } true: cancel every open order; only closing orders until off
//   (T5) the account and the order checks follow the book (lib/books.js); rawAccount + flatten serve its reset
//
// Found on the sandbox (2026-11-21, quant/t4-01.md): place/replace/cancel answer only in market hours for
// DAY orders and for combos (brackets); a GTC single order can be placed, changed and cancelled any time;
// replace must keep the order's time in force; reads (balance, positions, orders) allow 2 requests per 2 s,
// so they are cached here for READ_TTL and shared by concurrent callers.
import { fail, json } from '../http.js';
import { bodyOf } from '../charts.js';
import { checkOrder } from '../paper.js';
import { applyBook, overBook, orderValue } from '../books.js';
import { signedHeaders } from './webull-sign.js';

export const WEBULL_HOST = 'https://api.sandbox.webull.com';
export const READ_TTL = 3000;
const HOSTNAME = 'api.sandbox.webull.com';
const SYM_RE = /^[A-Z][A-Z0-9.]{0,9}$/, CID_RE = /^[A-Za-z0-9]{1,32}$/;
const num = (x) => (x == null || x === '' ? null : Number(x));
const pos = (x) => Number.isFinite(x) && x > 0;
const NY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayNY = (t) => NY_DAY.format(new Date(t));

const TYPE_OUT = { market: 'MARKET', limit: 'LIMIT', stop: 'STOP_LOSS', stop_limit: 'STOP_LOSS_LIMIT', trailing_stop: 'TRAILING_STOP_LOSS' };
const TYPE_IN = Object.fromEntries(Object.entries(TYPE_OUT).map(([k, v]) => [v, k]));
const STATUS_IN = { PENDING: 'pending_new', SUBMITTED: 'new', PARTIAL_FILLED: 'partially_filled', FILLED: 'filled', CANCELLED: 'canceled', FAILED: 'rejected' };
const OPEN = new Set(['pending_new', 'new', 'partially_filled']);

/* ── the host ─────────────────────────────────────────────────────────────── */
async function wb(env, method, path, { query = {}, body = null, version = 'v3', category = false } = {}, fetchFn = fetch) {
  if (!env.WEBULL_PAPER_KEY || !env.WEBULL_PAPER_SECRET) throw fail(503, 'no Webull paper key is set (WEBULL_PAPER_KEY / WEBULL_PAPER_SECRET)');
  if (!/^\/(trading|openapi)\/[\w/-]+$/.test(path)) throw fail(400, 'not a Webull API path');
  const h = await signedHeaders({ host: HOSTNAME, path, query, body, key: env.WEBULL_PAPER_KEY, secret: env.WEBULL_PAPER_SECRET, version });
  if (category) h.category = 'US_EQUITY';   // the official SDK sends it on place
  const qs = new URLSearchParams(query).toString();
  let r, text = '';
  try {
    r = await fetchFn(WEBULL_HOST + path + (qs ? '?' + qs : ''), { method, headers: h, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    text = await r.text();
  } catch (e) { return { ok: false, status: 0, body: { message: String(e.message || e) } }; }
  let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) { j = { message: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, body: j };
}
const must = (r, what) => {
  if (!r.ok) throw fail(r.status === 429 ? 429 : r.status >= 500 || r.status === 0 ? 502 : r.status === 404 ? 404 : 422,
    `Webull paper refused ${what}: ${(r.body && (r.body.message || r.body.error_code)) || 'HTTP ' + r.status}`, { webull: r.status, code: r.body && r.body.error_code });
  return r.body;
};

// Reads are cached for READ_TTL and shared while in flight (Webull: 2 requests per 2 s). Writes clear the cache.
const cache = new Map();
export function clearCache() { cache.clear(); }
function cached(key, load, now = Date.now()) {
  const hit = cache.get(key);
  if (hit && now - hit.at < READ_TTL) return hit.p;
  const p = load().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { at: now, p });
  return p;
}

/* ── accounts ─────────────────────────────────────────────────────────────── */
const listOf = (b) => (Array.isArray(b) ? b : b && (b.data || b.list)) || [];
async function accounts(env, fetchFn) {
  return cached('accounts', async () => listOf(must(await wb(env, 'GET', '/openapi/account/list', { version: 'v2' }, fetchFn), 'the account list')));
}
/** The account to trade in: ?account= (one of the list), else Individual Margin, else the first stock account. Ids change after a sandbox Reset, so never stored. */
async function pick(env, url, fetchFn) {
  const list = await accounts(env, fetchFn), want = url && url.searchParams.get('account');
  const stock = list.filter((a) => /^INDIVIDUAL_/.test(a.account_class || ''));
  const a = (want && list.find((x) => x.account_id === want)) || stock.find((x) => x.account_class === 'INDIVIDUAL_MARGIN') || stock[0] || list[0];
  if (!a) throw fail(502, 'Webull paper has no account');
  return a;
}
async function killOn(env) { try { const r = await env.DB.prepare("SELECT v FROM meta WHERE k = 'webull_kill'").first(); return !!(r && r.v === '1'); } catch (e) { return false; } }

const balance = (env, a, fetchFn) => cached('bal:' + a.account_id, async () => must(await wb(env, 'GET', '/openapi/assets/balance', { query: { account_id: a.account_id }, version: 'v2' }, fetchFn), 'the balance'));
function acctOut(a, bal) {
  const c = (bal.account_currency_assets || [])[0] || {};
  return { id: a.account_id, label: a.account_label, class: a.account_class, equity: num(bal.total_net_liquidation_value), last_equity: null, cash: num(bal.total_cash_balance),
    buying_power: num(c.buying_power != null ? c.buying_power : c.day_buying_power), day_buying_power: num(c.day_buying_power), overnight_buying_power: num(c.overnight_buying_power),
    long_value: num(bal.total_market_value), short_value: null, day_pnl: num(bal.total_day_profit_loss), pattern_day_trader: false, daytrade_count: null, status: 'ACTIVE' };
}
/** The account; with a T5 `book` (lib/books.js) its numbers are the book's, and `book` rides along. */
export async function account(env, url, fetchFn = fetch, book = null) {
  const a = await pick(env, url, fetchFn);
  const [bal, kill] = await Promise.all([balance(env, a, fetchFn), killOn(env)]);
  const list = await accounts(env, fetchFn);
  return json({ ok: true, paper: true, broker: 'webull', kill, clock: null, account: applyBook(book, acctOut(a, bal)), book,
    accounts: list.map((x) => ({ id: x.account_id, label: x.account_label, class: x.account_class })) });
}
/** The broker's own account numbers (no book), fresh: the book's baseline (T5). */
export async function rawAccount(env, url, fetchFn = fetch) { clearCache(); const a = await pick(env, url, fetchFn); return acctOut(a, await balance(env, a, fetchFn)); }

/* ── positions and orders, in lib/paper.js's shapes ───────────────────────── */
export function positionOut(p) {
  const qty = num(p.quantity != null ? p.quantity : p.qty), price = num(p.last_price != null ? p.last_price : p.price);
  return { symbol: p.symbol, qty: qty == null ? null : Math.abs(qty), side: qty != null && qty < 0 ? 'short' : 'long', avg: num(p.cost_price != null ? p.cost_price : p.avg_cost), price,
    value: num(p.market_value), pnl: num(p.unrealized_profit_loss), pnlPct: num(p.unrealized_profit_loss_rate), dayPnl: num(p.day_profit_loss) };
}
async function rawPositions(env, a, fetchFn) {
  return cached('pos:' + a.account_id, async () => listOf(must(await wb(env, 'GET', '/openapi/assets/positions', { query: { account_id: a.account_id }, version: 'v2' }, fetchFn), 'the positions')));
}
export async function positions(env, url, fetchFn = fetch) {
  const a = await pick(env, url, fetchFn);
  return json({ ok: true, paper: true, broker: 'webull', positions: (await rawPositions(env, a, fetchFn)).map(positionOut) });
}
/** One Webull order group → Alpaca-shaped orders (a combo's first leg carries the others in `legs`). */
export function ordersOut(groups) {
  const out = [];
  for (const g of groups || []) {
    const legs = (g.orders || []).map((o) => ({
      id: o.client_order_id || g.client_order_id, broker_id: o.order_id, symbol: o.symbol, side: String(o.side || '').toLowerCase(), type: TYPE_IN[o.order_type] || String(o.order_type || '').toLowerCase(),
      qty: num(o.total_quantity), filled_qty: num(o.filled_quantity), filled_avg_price: num(o.filled_price), limit_price: num(o.limit_price), stop_price: num(o.stop_price),
      trail_price: o.trailing_type === 'AMOUNT' ? num(o.trailing_stop_step) : null, trail_percent: o.trailing_type === 'PERCENTAGE' ? num(o.trailing_stop_step) * 100 : null,
      status: STATUS_IN[o.status] || String(o.status || '').toLowerCase(), time_in_force: String(o.time_in_force || '').toLowerCase(), session: o.support_trading_session || null,
      created_at: o.place_time_at || null, filled_at: o.filled_time_at || null, combo: o.combo_type || g.combo_type || 'NORMAL' }));
    if (!legs.length) continue;
    const master = legs.find((l) => l.combo === 'MASTER') || legs[0];
    out.push({ ...master, order_class: g.combo_type && g.combo_type !== 'NORMAL' ? (legs.length === 3 ? 'bracket' : String(g.combo_type).toLowerCase()) : 'simple', combo_id: g.combo_order_id || null,
      legs: legs.filter((l) => l !== master) });
  }
  return out;
}
async function openGroups(env, a, fetchFn) {
  return cached('open:' + a.account_id, async () => {
    const all = []; let key = null;
    for (let i = 0; i < 5; i++) {   // at most 5 pages (the endpoint allows 2 reads per 2 s)
      const r = must(await wb(env, 'GET', '/trading/orders/open-orders/list', { query: { account_id: a.account_id, ...(key ? { pagination_key: key } : {}) } }, fetchFn), 'the open orders');
      all.push(...listOf(r)); key = r && r.pagination_key; if (!key) break;
    }
    return all;
  });
}
async function historyGroups(env, a, fetchFn) {
  return cached('hist:' + a.account_id, async () => listOf(must(await wb(env, 'GET', '/trading/orders/historical-orders/list', { query: { account_id: a.account_id } }, fetchFn), 'the order history')));
}
export async function orders(env, url, fetchFn = fetch) {
  const status = ['open', 'closed', 'all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'open';
  const a = await pick(env, url, fetchFn);
  let list;
  if (status === 'open') list = ordersOut(await openGroups(env, a, fetchFn));
  else {
    const hist = ordersOut(await historyGroups(env, a, fetchFn));
    list = status === 'closed' ? hist.filter((o) => !OPEN.has(o.status)) : hist;
  }
  return json({ ok: true, paper: true, broker: 'webull', orders: list });
}
export async function activities(env, url, fetchFn = fetch) {
  const a = await pick(env, url, fetchFn);
  const fills = [];
  for (const o of ordersOut(await historyGroups(env, a, fetchFn))) for (const x of [o, ...o.legs]) {
    if (!(x.filled_qty > 0)) continue;
    fills.push({ id: 'wb:' + x.broker_id, at: Date.parse(x.filled_at || x.created_at) || null, order: x.id, symbol: x.symbol, side: x.side, qty: x.filled_qty, price: x.filled_avg_price, type: x.status === 'filled' ? 'fill' : 'partial_fill' });
  }
  return json({ ok: true, paper: true, broker: 'webull', fills: fills.sort((p, q) => (q.at || 0) - (p.at || 0)) });
}

/* ── writes ───────────────────────────────────────────────────────────────── */
/** An Alpaca-shaped order (core/venue.js) → Webull's new_orders. Pure; exported for the tests. */
export function webullBody(o, accountId, cid) {
  const tif = String(o.time_in_force || 'day').toUpperCase(), session = o.extended_hours ? 'ALL' : 'CORE';
  const leg = (x, combo, id) => {
    const l = { client_order_id: id, combo_type: combo, symbol: o.symbol, instrument_type: 'EQUITY', market: 'US', side: String(x.side).toUpperCase(), order_type: TYPE_OUT[x.type],
      time_in_force: tif, support_trading_session: session, entrust_type: 'QTY', quantity: String(num(x.qty)) };
    if (x.limit_price != null) l.limit_price = String(num(x.limit_price));
    if (x.stop_price != null) l.stop_price = String(num(x.stop_price));
    if (x.type === 'trailing_stop') {
      if (x.trail_percent != null) { l.trailing_type = 'PERCENTAGE'; l.trailing_stop_step = String(num(x.trail_percent) / 100); }
      else { l.trailing_type = 'AMOUNT'; l.trailing_stop_step = String(num(x.trail_price)); }
    }
    return l;
  };
  const cls = o.order_class || 'simple', exit = o.side === 'buy' ? 'sell' : 'buy';
  if (cls === 'simple') return { account_id: accountId, new_orders: [leg(o, 'NORMAL', cid)] };
  if (cls === 'bracket') {
    const tp = o.take_profit, sl = o.stop_loss;
    return { account_id: accountId, client_combo_order_id: cid, new_orders: [leg(o, 'MASTER', cid + 'm'),
      leg({ side: exit, type: 'limit', qty: o.qty, limit_price: tp.limit_price }, 'STOP_PROFIT', cid + 'p'),
      leg({ side: exit, type: sl.limit_price ? 'stop_limit' : 'stop', qty: o.qty, stop_price: sl.stop_price, limit_price: sl.limit_price }, 'STOP_LOSS', cid + 's')] };
  }
  if (cls === 'oto') {
    const sl = o.stop_loss, tp = o.take_profit, then = sl ? { side: exit, type: sl.limit_price ? 'stop_limit' : 'stop', qty: o.qty, stop_price: sl.stop_price, limit_price: sl.limit_price } : { side: exit, type: 'limit', qty: o.qty, limit_price: tp.limit_price };
    return { account_id: accountId, client_combo_order_id: cid, new_orders: [leg(o, 'MASTER', cid + 'm'), leg(then, 'OTO', cid + 'o')] };
  }
  if (cls === 'oco') {   // two exits on a held position: a limit (take profit) and a stop
    return { account_id: accountId, client_combo_order_id: cid, new_orders: [leg({ side: o.side, type: 'limit', qty: o.qty, limit_price: o.take_profit ? o.take_profit.limit_price : o.limit_price }, 'OCO', cid + 'p'),
      leg({ side: o.side, type: o.stop_loss.limit_price ? 'stop_limit' : 'stop', qty: o.qty, stop_price: o.stop_loss.stop_price, limit_price: o.stop_loss.limit_price }, 'OCO', cid + 's')] };
  }
  throw fail(400, 'order class is simple, bracket, oco or oto');
}
const WHO = ['tony', 'run', 'neo'];
function whoOf(b) { if (!b || !WHO.includes(b.who)) throw fail(400, 'who is tony, run or neo'); return b.who; }
async function logRow(env, row) {
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO paper_orders (id, at, day, run, who, reason, symbol, side, type, qty, body, status, broker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(row.id, row.at, dayNY(row.at), null, row.who, row.reason || null, row.symbol, row.side, row.type, row.qty, JSON.stringify(row.body), row.status, 'webull').run();
  } catch (e) {
    // Fails closed: an order that cannot be logged is not sent.
    if (/no such (table|column)|has no column named/i.test(String(e && e.message))) throw fail(503, 'the order log has no broker column yet (D1 migration 0014_broker.sql): Webull orders wait for it');
    throw e;
  }
}
async function closes(env, a, o, fetchFn) {
  if (!o || (o.order_class && o.order_class !== 'simple')) return false;
  const p = (await rawPositions(env, a, fetchFn)).map(positionOut).find((x) => x.symbol === o.symbol);
  return !!p && pos(num(o.qty)) && num(o.qty) <= p.qty && (p.side === 'long' ? o.side === 'sell' : o.side === 'buy');
}

export async function place(env, req, url, { fetchFn = fetch, now = Date.now(), priceOf = null, book = null } = {}) {
  const b = await bodyOf(req, 8000), o = b && b.order, who = whoOf(b);
  const reason = String((b && b.reason) || '').trim().slice(0, 400);
  if (who !== 'tony' && !reason) throw fail(400, 'an order from a strategy or Neo Quant carries its reason');
  if (o && o.notional != null) throw fail(422, 'Webull paper takes share quantities here, not a dollar amount');
  const a = await pick(env, url, fetchFn);
  const closing = !!(b && b.closing) && o && SYM_RE.test(String(o.symbol || '')) && await closes(env, a, o, fetchFn);
  if (b && b.closing && !closing) throw fail(422, 'that order does not only close a position (the side, the size or the position is not there)');
  const [kill, acct] = await Promise.all([killOn(env), cached('bal:' + a.account_id, async () => must(await wb(env, 'GET', '/openapi/assets/balance', { query: { account_id: a.account_id }, version: 'v2' }, fetchFn), 'the balance')).catch(() => null)]);
  // T5: with a book, its equity sizes the order and its buying power caps it.
  const shown = acct && book ? applyBook(book, acctOut(a, acct)) : null;
  const equity = shown ? shown.equity : acct ? num(acct.total_net_liquidation_value) : null, price = priceOf ? await priceOf(o && o.symbol) : null;
  const chk = checkOrder(o, { price, equity, kill, closing, stale: !!(b && b.stale) });
  if (!chk.ok) throw fail(422, chk.errors.join('; '), { errors: chk.errors });
  const over = overBook(shown, o, price, closing);
  if (over) throw fail(422, over, { errors: [over] });
  if (!closing && !pos(equity)) throw fail(503, 'the Webull paper account could not be read, so the order cannot be sized against it: try again');
  if (!closing && !pos(num(o.limit_price) || num(o.stop_price) || price)) throw fail(503, 'no current price to size this order against the limits: try again, or give a limit price');
  if (o.type === 'trailing_stop' && String(o.time_in_force || 'day') !== 'day') throw fail(422, 'Webull takes trailing stops as day orders only');
  const cid = CID_RE.test(String(o.client_order_id || '')) ? String(o.client_order_id) : ('w' + now.toString(36) + Math.random().toString(36).slice(2, 8));
  const body = webullBody(o, a.account_id, cid);
  await logRow(env, { id: cid, at: now, who, reason, symbol: o.symbol, side: o.side, type: o.type, qty: num(o.qty), body, status: 'sent' });
  const r = await wb(env, 'POST', '/trading/orders/place', { body, category: true }, fetchFn);
  clearCache();
  await env.DB.prepare('UPDATE paper_orders SET alpaca_id = ?, status = ?, error = ? WHERE id = ?')
    .bind(r.ok ? (r.body.order_id || r.body.combo_order_id || null) : null, r.ok ? 'new' : 'refused', r.ok ? null : String((r.body && r.body.message) || r.status).slice(0, 300), cid).run().catch(() => {});
  const ok = must(r, 'the order');
  return json({ ok: true, paper: true, broker: 'webull', order: { id: cid, broker_id: ok.order_id || null, combo_id: ok.combo_order_id || null, symbol: o.symbol, side: o.side, type: o.type, qty: num(o.qty), status: 'new' } });
}
async function detail(env, a, cid, fetchFn) {
  const r = must(await wb(env, 'GET', '/trading/orders/get', { query: { account_id: a.account_id, client_order_id: cid } }, fetchFn), 'the order');
  const o = ordersOut([r])[0];
  if (!o) throw fail(404, 'no such order');
  return [o, ...o.legs].find((x) => x.id === cid) || o;
}
export async function replace(env, req, url, id, { fetchFn = fetch, priceOf = null, now = Date.now(), book = null } = {}) {
  if (!CID_RE.test(id)) throw fail(400, 'not an order id');
  const b = await bodyOf(req, 2000), who = whoOf(b), patch = {};
  for (const k of ['qty', 'limit_price', 'stop_price', 'trail']) if (b && b[k] != null) { const v = num(b[k]); if (!pos(v)) throw fail(400, k + ' must be above zero'); patch[k] = v; }
  if (!Object.keys(patch).length) throw fail(400, 'nothing to change');
  const a = await pick(env, url, fetchFn);
  const [was, kill, acct] = await Promise.all([detail(env, a, id, fetchFn), killOn(env), cached('bal:' + a.account_id, async () => must(await wb(env, 'GET', '/openapi/assets/balance', { query: { account_id: a.account_id }, version: 'v2' }, fetchFn), 'the balance')).catch(() => null)]);
  if (!OPEN.has(was.status)) throw fail(409, `the order is ${was.status}: only an open order can change`);
  const next = { symbol: was.symbol, side: was.side, type: was.type, time_in_force: was.time_in_force, qty: patch.qty || was.qty, limit_price: patch.limit_price || was.limit_price, stop_price: patch.stop_price || was.stop_price,
    ...(was.type === 'trailing_stop' ? (was.trail_percent != null ? { trail_percent: patch.trail || was.trail_percent } : { trail_price: patch.trail || was.trail_price }) : {}) };
  const shown = acct && book ? applyBook(book, acctOut(a, acct)) : null;
  const equity = shown ? shown.equity : acct ? num(acct.total_net_liquidation_value) : null, price = priceOf ? await priceOf(was.symbol) : null;
  if (!pos(equity)) throw fail(503, 'the Webull paper account could not be read, so the change cannot be checked: try again');
  const chk = checkOrder(next, { price, equity, kill });
  if (!chk.ok) throw fail(422, chk.errors.join('; '), { errors: chk.errors });
  // T5: a change may not raise the order past the book's buying power (only the increase counts).
  const over = overBook(shown, next, price, false, orderValue(was, price));
  if (over) throw fail(422, over, { errors: [over] });
  // Webull refuses a replace that changes the time in force (found on the sandbox): it is always sent unchanged.
  const m = { client_order_id: id, quantity: String(next.qty), time_in_force: String(was.time_in_force).toUpperCase(), order_type: TYPE_OUT[was.type] };
  if (next.limit_price != null) m.limit_price = String(next.limit_price);
  if (next.stop_price != null) m.stop_price = String(next.stop_price);
  if (was.type === 'trailing_stop') { m.trailing_type = was.trail_percent != null ? 'PERCENTAGE' : 'AMOUNT'; m.trailing_stop_step = String(was.trail_percent != null ? next.trail_percent / 100 : next.trail_price); }
  await logRow(env, { id: 'x' + now.toString(36) + Math.random().toString(36).slice(2, 6), at: now, who, reason: 'replaced ' + id, symbol: was.symbol, side: was.side, type: was.type, qty: next.qty, body: m, status: 'replaced' });
  const r = await wb(env, 'POST', '/trading/orders/replace', { body: { account_id: a.account_id, modify_orders: [m] } }, fetchFn);
  clearCache();
  must(r, 'the change');
  return json({ ok: true, paper: true, broker: 'webull', order: { ...was, qty: next.qty, limit_price: next.limit_price, stop_price: next.stop_price } });
}
export async function cancel(env, url, id, fetchFn = fetch) {
  if (!CID_RE.test(id)) throw fail(400, 'not an order id');
  const a = await pick(env, url, fetchFn);
  const r = await wb(env, 'POST', '/trading/orders/cancel', { body: { account_id: a.account_id, client_order_id: id } }, fetchFn);
  clearCache();
  if (!r.ok && !(r.status === 417 && /not present/i.test(JSON.stringify(r.body || '')))) must(r, 'the cancel');
  await env.DB.prepare("UPDATE paper_orders SET status = 'canceled' WHERE id = ? AND broker = 'webull'").bind(id).run().catch(() => {});
  return json({ ok: true, paper: true, broker: 'webull', canceled: id });
}
export async function closePosition(env, url, sym, { fetchFn = fetch, now = Date.now() } = {}) {
  if (!SYM_RE.test(sym)) throw fail(400, 'not a ticker');
  const a = await pick(env, url, fetchFn);
  const p = (await rawPositions(env, a, fetchFn)).map(positionOut).find((x) => x.symbol === sym);
  if (!p || !pos(p.qty)) throw fail(404, 'no ' + sym + ' position');
  const o = { symbol: sym, side: p.side === 'long' ? 'sell' : 'buy', type: 'market', qty: p.qty, time_in_force: 'day' };
  const cid = 'c' + now.toString(36) + Math.random().toString(36).slice(2, 6), body = webullBody(o, a.account_id, cid);
  await logRow(env, { id: cid, at: now, who: 'tony', reason: 'close position', symbol: sym, side: o.side, type: 'market', qty: p.qty, body, status: 'sent' });
  const r = await wb(env, 'POST', '/trading/orders/place', { body, category: true }, fetchFn);
  clearCache();
  const ok = must(r, 'closing ' + sym);
  return json({ ok: true, paper: true, broker: 'webull', order: { id: cid, broker_id: ok.order_id || null, symbol: sym, side: o.side, type: 'market', qty: p.qty } });
}
/** Cancel every open order, one by one (Webull has no cancel-all) → { canceled, failed: [ids] }. */
async function cancelAll(env, a, fetchFn) {
  clearCache();
  const open = ordersOut(await openGroups(env, a, fetchFn));
  let canceled = 0; const failed = [];
  for (const o of open) for (const x of [o, ...o.legs]) {
    if (!OPEN.has(x.status)) continue;
    const r = await wb(env, 'POST', '/trading/orders/cancel', { body: { account_id: a.account_id, client_order_id: x.id } }, fetchFn);
    if (r.ok || (r.status === 417 && /not present/i.test(JSON.stringify(r.body || '')))) canceled++; else failed.push(x.id);   // a combo's legs go with its master
  }
  clearCache();
  return { canceled, failed };
}
/** A book reset (T5): cancel every open order, then close every position at market (logged as Tony's "book reset").
 *  The sandbox takes market orders only in market hours: a close it refuses is in `failed`, never hidden. */
export async function flatten(env, url, { fetchFn = fetch, now = Date.now() } = {}) {
  const a = await pick(env, url, fetchFn);
  const { canceled, failed: notCanceled } = await cancelAll(env, a, fetchFn);
  if (notCanceled.length) throw fail(502, `${canceled} open Webull order(s) were cancelled but ${notCanceled.length} were not: the book was not reset; press Reset again`, { canceled, failed: notCanceled });
  const closing = [], failed = [];
  for (const p of (await rawPositions(env, a, fetchFn)).map(positionOut)) {
    if (!pos(p.qty)) continue;
    const o = { symbol: p.symbol, side: p.side === 'long' ? 'sell' : 'buy', type: 'market', qty: p.qty, time_in_force: 'day' };
    const cid = 'r' + now.toString(36) + Math.random().toString(36).slice(2, 6), body = webullBody(o, a.account_id, cid);
    await logRow(env, { id: cid, at: now, who: 'tony', reason: 'book reset', symbol: p.symbol, side: o.side, type: 'market', qty: p.qty, body, status: 'sent' });
    const r = await wb(env, 'POST', '/trading/orders/place', { body, category: true }, fetchFn);
    if (r.ok) closing.push(p.symbol);
    else { failed.push(p.symbol); await env.DB.prepare('UPDATE paper_orders SET status = ?, error = ? WHERE id = ?').bind('refused', String((r.body && r.body.message) || r.status).slice(0, 300), cid).run().catch(() => {}); }
  }
  clearCache();
  return { canceled, closing, failed };
}

/** This broker's kill switch: on cancels every open order (each one: Webull has no cancel-all); only closing orders go out until it is off. */
export async function kill(env, req, url, fetchFn = fetch) {
  const b = await bodyOf(req, 500), on = !(b && b.on === false), now = Date.now();
  await env.DB.prepare('INSERT INTO meta (k, v, at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, at = excluded.at').bind('webull_kill', on ? '1' : '0', now).run();
  if (!on) return json({ ok: true, broker: 'webull', kill: false });
  const a = await pick(env, url, fetchFn);
  const { canceled, failed } = await cancelAll(env, a, fetchFn);
  if (failed.length) throw fail(502, `the Webull kill switch is on, but ${failed.length} open order(s) were not cancelled: press it again`, { kill: true, failed });
  const held = (await rawPositions(env, a, fetchFn)).length;
  return json({ ok: true, broker: 'webull', kill: true, canceled, unprotected: held });
}
