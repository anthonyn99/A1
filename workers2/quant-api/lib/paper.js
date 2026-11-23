// Paper trading (A1-Priv docs/TradeHub/quant/phase-09c.md): THE ONLY ORDER
// CODE in TradeHub and quant-api. It reaches one host, Alpaca's PAPER API
// (pinned in PAPER_HOST, never built from input), with the paper key. Webull
// stays read-only: nothing here or anywhere else can place, change or cancel a
// Webull order, and Alpaca live (api.alpaca.markets) is never called (a test
// greps for both). Every order is checked here again (the page checks first:
// A1-Priv TradeHub/core/venue.js) and logged with who made it and why.
//
//   GET    /paper/probe                 what the paper API answers (account, clock, rate limit)
//   GET    /paper/account               { account, clock, kill }
//   GET    /paper/positions             { positions }
//   GET    /paper/orders?status=open|closed|all&limit=
//   GET    /paper/activities?after=     { fills }   (Alpaca FILL activities)
//   GET    /paper/log?limit=&run=       { orders }  every order TradeHub sent: who, why, its run
//   POST   /paper/orders                { order, who, reason?, run? } → { order }
//   PATCH  /paper/orders/:id            { qty?, limit_price?, stop_price?, trail?, who }   (replace)
//   DELETE /paper/orders/:id            cancel one (a replaced order: its replacement, TR1)
//   POST   /paper/orders/:id/drop       { parent, who } remove one take profit or stop loss, keep the rest (TR1)
//   DELETE /paper/positions/:symbol     close one at market
//   POST   /paper/kill                  { on: true|false } true: cancel every open order, pause every run
//   GET    /paper/runs                  { runs }
//   POST   /paper/runs                  { name, spec, capital, limits, who } → { run }   start one
//   PATCH  /paper/runs/:id              { state?, limits?, capital?, who }   pause / resume / stop; Neo can never loosen a limit
//   POST   /paper/fills                 { fills }   reconciled fills (the runner), kept once each
//   POST   /paper/equity                { rows: [{ run, day, equity }] }   one row a run a day
import { fail, json } from './http.js';
import { bodyOf } from './charts.js';
import { applyBook, overBook, orderValue } from './books.js';

export const PAPER_HOST = 'https://paper-api.alpaca.markets';
export const TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'], SIDES = ['buy', 'sell'], TIFS = ['day', 'gtc'], CLASSES = ['simple', 'bracket', 'oco', 'oto'];
export const WHO = ['tony', 'run', 'neo'], RUN_STATES = ['running', 'paused', 'stopped'];
export const MAX_ORDER_SHARE = 0.25;   // no order larger than 25% of the account's equity
export const DEFAULT_LIMITS = { maxPositions: 5, maxPositionPct: 20, maxOrdersDay: 20, dailyLossPct: 3, maxDrawdownPct: 15 };
const SYM_RE = /^[A-Z][A-Z0-9.]{0,9}$/, ID_RE = /^[\w-]{1,64}$/, RUN_RE = /^r[a-z0-9]{4,20}$/;
const num = (x) => (x == null || x === '' ? null : Number(x));
const pos = (x) => Number.isFinite(x) && x > 0;

/**
 * Every reason `order` may not go out, in words → { ok, errors }. The same rules as A1-Priv
 * TradeHub/core/venue.js checkOrder (A1 tests/quant-paper-api.test.js runs both on one table).
 * ctx: { price (the latest), stale, equity (the account's), kill, closing }
 */
export function checkOrder(o, { price = null, stale = false, equity = null, kill = false, closing = false } = {}) {
  const e = [];
  if (!o || typeof o !== 'object') return { ok: false, errors: ['an order is needed'] };
  const type = o.type, side = o.side, qty = num(o.qty), notional = num(o.notional), lp = num(o.limit_price), sp = num(o.stop_price);
  if (kill && !closing) e.push('the kill switch is on: only closing orders and cancels go out');
  if (!SYM_RE.test(String(o.symbol || ''))) e.push('the symbol must be a ticker such as NVDA');
  if (!SIDES.includes(side)) e.push('the side is buy or sell');
  if (!TYPES.includes(type)) e.push('the type is market, limit, stop, stop_limit or trailing_stop');
  if (!TIFS.includes(o.time_in_force)) e.push('time in force is day or gtc');
  if (qty == null && notional == null) e.push('a size is needed (shares, or dollars for a market order)');
  if (qty != null && !pos(qty)) e.push('the share count must be above zero');
  if (qty != null && pos(qty) && !Number.isInteger(qty) && !(type === 'market' && o.time_in_force === 'day')) e.push('fractional shares only on a market day order');
  if (notional != null && (!pos(notional) || type !== 'market')) e.push('a dollar size only on a market order, above zero');
  if ((type === 'limit' || type === 'stop_limit') && !pos(lp)) e.push('a limit order needs a limit price above zero');
  if ((type === 'stop' || type === 'stop_limit') && !pos(sp)) e.push('a stop order needs a stop price above zero');
  if (type === 'trailing_stop') {
    const tp = num(o.trail_percent), tv = num(o.trail_price);
    if (!(pos(tp) && tp <= 50) && !pos(tv)) e.push('a trailing stop needs a trail percent (above 0, up to 50) or a trail price');
  }
  if (o.extended_hours && !(type === 'limit' && o.time_in_force === 'day')) e.push('extended hours only on a limit day order');
  if (type === 'market' && stale) e.push('no market order while the price is stale');
  const cls = o.order_class || 'simple';
  if (!CLASSES.includes(cls)) e.push('the order class is simple, bracket, oco or oto');
  const ref = lp || (type === 'market' ? price : sp) || price;
  if (cls === 'bracket') {
    const tp = num(o.take_profit && o.take_profit.limit_price), sl = num(o.stop_loss && o.stop_loss.stop_price);
    if (!pos(tp) || !pos(sl)) e.push('a bracket needs a target and a stop');
    else if (pos(ref) && (side === 'buy' ? !(sl < ref && ref < tp) : !(tp < ref && ref < sl))) e.push(side === 'buy' ? 'a buy bracket needs its stop below the price and its target above' : 'a short bracket needs its stop above the price and its target below');
  }
  if (type === 'stop' && pos(sp) && pos(price) && !closing && cls === 'simple') {
    // A stop entry buys above the price (a breakout) or sells below it; the other side would fill at once.
    if (side === 'buy' && sp <= price) e.push('a buy stop must be above the current price');
    if (side === 'sell' && sp >= price) e.push('a sell stop must be below the current price');
  }
  const value = notional != null ? notional : pos(qty) && pos(ref) ? qty * ref : null;
  if (!closing && pos(value) && pos(equity) && value > equity * MAX_ORDER_SHARE) e.push(`no order larger than ${MAX_ORDER_SHARE * 100}% of the account (this one is ${Math.round(value / equity * 100)}%)`);
  if (o.client_order_id != null && !ID_RE.test(String(o.client_order_id))) e.push('the client order id is up to 64 letters, digits, - or _');
  return { ok: !e.length, errors: [...new Set(e)] };
}

/** The order Alpaca is sent: only its own fields (nothing from the request passes through unread). */
export function alpacaBody(o) {
  const out = { symbol: o.symbol, side: o.side, type: o.type, time_in_force: o.time_in_force };
  for (const k of ['qty', 'notional', 'limit_price', 'stop_price', 'trail_percent', 'trail_price']) if (o[k] != null && o[k] !== '') out[k] = String(num(o[k]));
  if (o.extended_hours) out.extended_hours = true;
  if (o.client_order_id) out.client_order_id = String(o.client_order_id);
  const cls = o.order_class || 'simple';
  if (cls !== 'simple') {
    out.order_class = cls;
    // T6: an OCO (a held position's take profit + stop) carries its prices only in its legs, as Alpaca's docs send it.
    if (cls === 'oco') delete out.limit_price;
    if (o.take_profit) out.take_profit = { limit_price: String(num(o.take_profit.limit_price)) };
    if (o.stop_loss) out.stop_loss = { stop_price: String(num(o.stop_loss.stop_price)), ...(o.stop_loss.limit_price ? { limit_price: String(num(o.stop_loss.limit_price)) } : {}) };
  }
  return out;
}

/** Neo Quant may tighten a run's limits, never loosen them → the limits it tried to loosen. */
export function loosened(oldL, newL) {
  const bad = [];
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    if (newL[k] == null) continue;
    if (Number(newL[k]) > Number(oldL[k] != null ? oldL[k] : DEFAULT_LIMITS[k])) bad.push(k);
  }
  return bad;
}
function limitsOf(x) {
  const l = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(DEFAULT_LIMITS)) if (x && x[k] != null) { const v = Number(x[k]); if (!(v > 0 && v <= (k === 'maxOrdersDay' ? 500 : k === 'maxPositions' ? 100 : 100))) throw fail(400, `limit ${k} must be above 0`); l[k] = v; }
  return l;
}

/* ── the host ─────────────────────────────────────────────────────────────── */
async function alpaca(env, path, init = {}, fetchFn = fetch) {
  if (!env.ALPACA_KEY || !env.ALPACA_SECRET) throw fail(503, 'no Alpaca paper key is set');
  if (!/^\/v2\/[\w/?=&.,%-]*$/.test(path)) throw fail(400, 'not a paper API path');
  const r = await fetchFn(PAPER_HOST + path, { ...init, headers: { 'APCA-API-KEY-ID': env.ALPACA_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET, 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch (e) { body = { message: text.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, body, limit: r.headers.get('x-ratelimit-limit'), remaining: r.headers.get('x-ratelimit-remaining') };
}
/** Alpaca's refusal in plain words where its own is cryptic (TR1, met on the real paper account 2026-11-23). */
export function refusalText(msg) {
  const m = String(msg || '');
  if (/wash trade/i.test(m)) return 'it could trade against one of your own working orders on the other side of this stock (Alpaca calls that a wash trade): cancel or change that order first, or send the entry and its exits together as one bracket';
  if (/insufficient qty available/i.test(m)) return 'those shares are already held by a working order (a stop loss or take profit on them): cancel or change that order first';
  if (/not shortable|cannot be sold short/i.test(m)) return 'this stock cannot be sold short on Alpaca paper';
  return m;
}
const must = (r, what) => { if (!r.ok) throw fail(r.status === 429 ? 429 : r.status >= 500 ? 502 : r.status === 404 ? 404 : 422, `Alpaca paper refused ${what}: ${refusalText((r.body && (r.body.message || r.body.error)) || 'HTTP ' + r.status)}`, { alpaca: r.status, raw: r.body && r.body.message }); return r.body; };
const noTable = (e) => /no such table/i.test(String(e && e.message));
async function db(p) { try { return await p; } catch (e) { if (noTable(e)) throw fail(503, 'the paper tables are not there yet (D1 migration 0010_paper.sql)'); throw e; } }
async function killOn(env) { const r = await db(env.DB.prepare("SELECT v FROM meta WHERE k = 'paper_kill'").first()); return !!(r && r.v === '1'); }
const NY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayNY = (t) => NY_DAY.format(new Date(t));   // daylight saving included

/* ── routes ───────────────────────────────────────────────────────────────── */
export async function probe(env, fetchFn) {
  const [acct, clock, orders] = await Promise.all([alpaca(env, '/v2/account', {}, fetchFn), alpaca(env, '/v2/clock', {}, fetchFn), alpaca(env, '/v2/orders?status=open&limit=1', {}, fetchFn)]);
  const a = acct.body || {};
  return json({ ok: acct.ok && clock.ok && orders.ok, host: PAPER_HOST,
    account: acct.ok ? { status: a.status, currency: a.currency, equity: num(a.equity), cash: num(a.cash), buying_power: num(a.buying_power), pattern_day_trader: a.pattern_day_trader, shorting_enabled: a.shorting_enabled, trading_blocked: a.trading_blocked, multiplier: a.multiplier } : { error: acct.status },
    clock: clock.ok ? clock.body : { error: clock.status }, orders: orders.ok ? { open: (orders.body || []).length } : { error: orders.status },
    rateLimit: { limit: num(acct.limit), remaining: num(acct.remaining) } });
}
const acctOut = (x) => ({ equity: num(x.equity), last_equity: num(x.last_equity), cash: num(x.cash), buying_power: num(x.buying_power), long_value: num(x.long_market_value), short_value: num(x.short_market_value), pattern_day_trader: !!x.pattern_day_trader, daytrade_count: x.daytrade_count, status: x.status });
/** The account; with a T5 `book` (lib/books.js) its numbers are the book's, and `book` rides along. */
export async function account(env, fetchFn, book = null) {
  const [a, c, kill] = await Promise.all([alpaca(env, '/v2/account', {}, fetchFn), alpaca(env, '/v2/clock', {}, fetchFn), killOn(env).catch(() => false)]);
  const x = must(a, 'the account');
  return json({ ok: true, paper: true, kill, clock: c.ok ? c.body : null, account: applyBook(book, acctOut(x)), book });
}
/** The broker's own account numbers (no book), fresh: the book's baseline (T5). */
export async function rawAccount(env, fetchFn = fetch) { return acctOut(must(await alpaca(env, '/v2/account', {}, fetchFn), 'the account')); }
/** A book reset (T5): cancel every open order, then close every position at market (Alpaca queues the closes outside market hours). */
export async function flatten(env, fetchFn = fetch) {
  const c = await alpaca(env, '/v2/orders', { method: 'DELETE' }, fetchFn);
  if (!c.ok) throw fail(502, 'Alpaca did not cancel the open orders (HTTP ' + c.status + '): the book was not reset; press Reset again');
  const p = await alpaca(env, '/v2/positions?cancel_orders=true', { method: 'DELETE' }, fetchFn);
  if (!p.ok) throw fail(502, `${Array.isArray(c.body) ? c.body.length : 0} open order(s) were cancelled (stops included), but Alpaca did not close the positions (HTTP ${p.status}): the book was not reset; press Reset again`);
  const list = Array.isArray(p.body) ? p.body : [];
  return { canceled: Array.isArray(c.body) ? c.body.length : 0, closing: list.filter((x) => !x.status || x.status < 300).map((x) => x.symbol), failed: list.filter((x) => x.status >= 300).map((x) => x.symbol) };
}
export async function positions(env, fetchFn) {
  const r = must(await alpaca(env, '/v2/positions', {}, fetchFn), 'the positions');
  return json({ ok: true, paper: true, positions: (r || []).map((p) => ({ symbol: p.symbol, qty: num(p.qty), side: p.side, avg: num(p.avg_entry_price), price: num(p.current_price), value: num(p.market_value), pnl: num(p.unrealized_pl), pnlPct: num(p.unrealized_plpc), dayPnl: num(p.unrealized_intraday_pl) })) });
}
export async function orders(env, url, fetchFn) {
  const status = ['open', 'closed', 'all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'open';
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
  const r = must(await alpaca(env, `/v2/orders?status=${status}&limit=${limit}&nested=true`, {}, fetchFn), 'the orders');
  return json({ ok: true, paper: true, orders: status === 'open' ? await withLegs(env, r || [], fetchFn) : r || [] });
}
const OPEN_ST = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'held', 'pending_replace', 'accepted_for_bidding', 'calculated']);
/** TR1 (measured 2026-11-23): once a bracket's entry fills, Alpaca's open list shows its take profit alone, a top-level
 *  order with a class and no legs, and hides the held stop. Such an orphan is swapped for its filled parent with every leg
 *  (one extra read, only when an orphan is there), so the page sees the take profit AND the stop. */
export async function withLegs(env, list, fetchFn = fetch) {
  const orphans = list.filter((o) => o.order_class && o.order_class !== 'simple' && !(Array.isArray(o.legs) && o.legs.length));
  if (!orphans.length) return list;
  const all = await alpaca(env, '/v2/orders?status=all&limit=100&direction=desc&nested=true', {}, fetchFn);
  if (!all.ok || !Array.isArray(all.body)) return list;
  const out = [], seen = new Set();
  for (const o of list) {
    if (!orphans.includes(o)) { out.push(o); continue; }
    const parent = all.body.find((x) => Array.isArray(x.legs) && x.legs.some((l) => l.id === o.id));
    if (!parent) { out.push(o); continue; }
    if (seen.has(parent.id)) continue;
    seen.add(parent.id);
    out.push(parent);
  }
  return out;
}
/** T7: the account's latest orders, every status, legs nested (one read; lib/order-watch.js turns changes into alerts). */
export async function recentOrders(env, fetchFn = fetch) {
  return must(await alpaca(env, '/v2/orders?status=all&limit=100&direction=desc&nested=true', {}, fetchFn), 'the orders') || [];
}
export async function activities(env, url, fetchFn) {
  const after = url.searchParams.get('after');
  const q = after && /^[\d\-T:.Z]+$/.test(after) ? '&after=' + encodeURIComponent(after) : '';
  const r = must(await alpaca(env, `/v2/account/activities/FILL?direction=desc&page_size=100${q}`, {}, fetchFn), 'the activity');
  return json({ ok: true, paper: true, fills: (r || []).map((f) => ({ id: f.id, at: Date.parse(f.transaction_time), order: f.order_id, symbol: f.symbol, side: f.side, qty: num(f.qty), price: num(f.price), type: f.type })) });
}
export async function log(env, url) {
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200)), run = url.searchParams.get('run');
  // Alpaca's rows only (Batch 4: a Webull order never shows under Alpaca); before migration 0014 every row is Alpaca's.
  const q = (w) => (run && RUN_RE.test(run) ? env.DB.prepare(`SELECT * FROM paper_orders WHERE run = ?${w} ORDER BY at DESC LIMIT ?`).bind(run, limit) : env.DB.prepare(`SELECT * FROM paper_orders${w ? ' WHERE' + w.replace(' AND', '') : ''} ORDER BY at DESC LIMIT ?`).bind(limit));
  let rows;
  try { rows = (await db(q(" AND broker = 'alpaca'").all())).results || []; }
  catch (e) { if (!/no such column|has no column/i.test(String(e && e.message))) throw e; rows = (await db(q('').all())).results || []; }
  return json({ ok: true, orders: rows.map((r) => ({ ...r, body: JSON.parse(r.body || 'null') })) });
}

/** POST /paper/orders: checked (kill switch, the order's own rules, 25% of equity, the run's limits), logged, sent. */
export async function place(env, req, { fetchFn = fetch, now = Date.now(), priceOf = null, book = null } = {}) {
  const b = await bodyOf(req, 8000), o = b && b.order, who = whoOf(b);
  const reason = String((b && b.reason) || '').trim().slice(0, 400);
  if (who !== 'tony' && !reason) throw fail(400, 'an order from a strategy or Neo Quant carries its reason');
  const runId = b && b.run ? String(b.run) : null;
  if (runId && !RUN_RE.test(runId)) throw fail(400, 'not a run id');
  // "closing" lifts the kill switch and the size caps, so it is CHECKED against the real position, never trusted.
  const closing = !!(b && b.closing) && o && SYM_RE.test(String(o.symbol || '')) && await closesPosition(env, o, fetchFn);
  if (b && b.closing && !closing) throw fail(422, 'that order does not only close a position (the side, the size or the position is not there)');
  const [kill, acct] = await Promise.all([killOn(env), alpaca(env, '/v2/account', {}, fetchFn)]);
  // T5: with a book, its equity sizes the order and its buying power caps it.
  const shown = acct.ok && book ? applyBook(book, acctOut(acct.body)) : null;
  const equity = shown ? shown.equity : acct.ok ? num(acct.body.equity) : null;
  const price = priceOf ? await priceOf(o && o.symbol) : null;
  const chk = checkOrder(o, { price, equity, kill, closing, stale: !!(b && b.stale) });
  if (!chk.ok) throw fail(422, chk.errors.join('; '), { errors: chk.errors });
  const over = overBook(shown, o, price, closing);
  if (over) throw fail(422, over, { errors: [over] });
  // The size checks fail closed: without the account's equity, or a price to size a share order, nothing new goes out.
  if (!closing && !pos(equity)) throw fail(503, 'the paper account could not be read, so the order cannot be sized against it: try again');
  if (!closing && o.notional == null && !pos(num(o.limit_price) || num(o.stop_price) || price)) throw fail(503, 'no current price to size this order against the limits: try again, or give a limit price');
  if (runId) {
    const run = await db(env.DB.prepare('SELECT * FROM paper_runs WHERE id = ?').bind(runId).first());
    if (!run) throw fail(404, 'no such run');
    if (run.state !== 'running' && !closing) throw fail(409, `the run is ${run.state}: only closing orders`);
    const L = JSON.parse(run.limits || '{}'), today = dayNY(now);
    const n = await db(env.DB.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE run = ? AND day = ? AND status != 'refused'").bind(runId, today).first());
    if (!closing && n && n.n >= (L.maxOrdersDay || DEFAULT_LIMITS.maxOrdersDay)) throw fail(409, `the run has placed its ${L.maxOrdersDay} orders today`);
    const ref = num(o.limit_price) || price, value = num(o.notional) || (pos(ref) ? num(o.qty) * ref : null);
    if (!closing && pos(value) && value > run.capital * (L.maxPositionPct || DEFAULT_LIMITS.maxPositionPct) / 100) throw fail(409, `over the run's position limit (${L.maxPositionPct}% of its ${run.capital} capital)`);
  }
  const id = String(o.client_order_id || ('t' + now.toString(36) + Math.random().toString(36).slice(2, 8)));
  const body = alpacaBody({ ...o, client_order_id: id });
  // Logged before it is sent: an order that goes out is always in the log, with who and why.
  await db(env.DB.prepare('INSERT OR IGNORE INTO paper_orders (id, at, day, run, who, reason, symbol, side, type, qty, body, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, now, dayNY(now), runId, who, reason || null, body.symbol, body.side, body.type, num(body.qty) || null, JSON.stringify(body), 'sent').run());
  const r = await alpaca(env, '/v2/orders', { method: 'POST', body: JSON.stringify(body) }, fetchFn);
  // A retried tick sends the same client id: Alpaca refuses the duplicate, which is not an error.
  if (!r.ok && r.status === 422 && /client_order_id/i.test(JSON.stringify(r.body || ''))) return json({ ok: true, duplicate: true, id });
  await db(env.DB.prepare('UPDATE paper_orders SET alpaca_id = ?, status = ?, error = ? WHERE id = ?').bind(r.ok ? r.body.id : null, r.ok ? r.body.status : 'refused', r.ok ? null : String((r.body && r.body.message) || r.status).slice(0, 300), id).run());
  return json({ ok: true, paper: true, order: must(r, 'the order') });
}
/** PATCH an order: the order AS CHANGED passes every check again (its rules, the kill switch, 25% of equity, its run's limits). */
export async function replace(env, req, id, { fetchFn = fetch, priceOf = null, now = Date.now(), book = null } = {}) {
  if (!/^[\w-]{1,64}$/.test(id)) throw fail(400, 'not an order id');
  const b = await bodyOf(req, 2000), who = whoOf(b), patch = {};
  for (const k of ['qty', 'limit_price', 'stop_price', 'trail']) if (b && b[k] != null) { const v = num(b[k]); if (!pos(v)) throw fail(400, k + ' must be above zero'); patch[k] = String(v); }
  if (!Object.keys(patch).length) throw fail(400, 'nothing to change');
  const [cur, kill, acct] = await Promise.all([alpaca(env, '/v2/orders/' + id, {}, fetchFn), killOn(env), alpaca(env, '/v2/account', {}, fetchFn)]);
  const was = must(cur, 'the order');
  const next = { symbol: was.symbol, side: was.side, type: was.type, time_in_force: was.time_in_force, qty: num(patch.qty || was.qty), limit_price: num(patch.limit_price || was.limit_price), stop_price: num(patch.stop_price || was.stop_price),
    ...(was.type === 'trailing_stop' ? (was.trail_percent != null ? { trail_percent: num(patch.trail || was.trail_percent) } : { trail_price: num(patch.trail || was.trail_price) }) : {}), extended_hours: !!was.extended_hours };
  const shown = acct.ok && book ? applyBook(book, acctOut(acct.body)) : null;
  const equity = shown ? shown.equity : acct.ok ? num(acct.body.equity) : null, price = priceOf ? await priceOf(was.symbol) : null;
  if (!pos(equity)) throw fail(503, 'the paper account could not be read, so the change cannot be checked: try again');
  const chk = checkOrder(next, { price, equity, kill });
  if (!chk.ok) throw fail(422, chk.errors.join('; '), { errors: chk.errors });
  // T5: a change may not raise the order past the book's buying power (only the increase counts: the old value is held already).
  const over = overBook(shown, next, price, false, orderValue({ qty: num(was.qty), limit_price: num(was.limit_price), stop_price: num(was.stop_price), notional: num(was.notional) }, price));
  if (over) throw fail(422, over, { errors: [over] });
  const orig = await db(env.DB.prepare('SELECT run FROM paper_orders WHERE alpaca_id = ? ORDER BY at LIMIT 1').bind(id).first());
  const runId = orig && orig.run;
  if (runId) {
    const run = await db(env.DB.prepare('SELECT * FROM paper_runs WHERE id = ?').bind(runId).first());
    const L = run ? JSON.parse(run.limits || '{}') : {}, ref = next.limit_price || next.stop_price || price;
    if (run && run.state !== 'running') throw fail(409, `the run is ${run.state}: its orders can be cancelled, not changed`);
    if (run && pos(ref) && next.qty * ref > run.capital * (L.maxPositionPct || DEFAULT_LIMITS.maxPositionPct) / 100) throw fail(409, `over the run's position limit (${L.maxPositionPct}% of its ${run.capital} capital)`);
  }
  const r = must(await alpaca(env, '/v2/orders/' + id, { method: 'PATCH', body: JSON.stringify(patch) }, fetchFn), 'the change');
  await db(env.DB.prepare('INSERT OR IGNORE INTO paper_orders (id, at, day, run, who, reason, symbol, side, type, qty, body, status, alpaca_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('x' + now.toString(36) + Math.random().toString(36).slice(2, 6), now, dayNY(now), runId || null, who, 'replaced ' + id, r.symbol, r.side, r.type, num(r.qty), JSON.stringify(patch), 'replaced', r.id).run());
  return json({ ok: true, paper: true, order: r });
}
/** Cancel one order. TR1 (Tony's #34): a replaced order (moved on the chart) cancels its replacement, following
 *  Alpaca's replaced_by; one still being replaced is asked again a moment later. */
export async function cancel(env, id, fetchFn = fetch, { wait = sleep } = {}) {
  if (!/^[\w-]{1,64}$/.test(id)) throw fail(400, 'not an order id');
  let cur = id;
  for (let i = 0; i < 6; i++) {
    const r = await alpaca(env, '/v2/orders/' + cur, { method: 'DELETE' }, fetchFn);
    if (r.ok || r.status === 404) break;
    const why = String((r.body && (r.body.message || r.body.error)) || '');
    if (r.status === 422 && /replaced/i.test(why) && !/pending/i.test(why)) {
      const g = await alpaca(env, '/v2/orders/' + cur, {}, fetchFn);
      if (g.ok && g.body && g.body.replaced_by && /^[\w-]{1,64}$/.test(g.body.replaced_by)) { cur = g.body.replaced_by; continue; }
    }
    if (r.status === 422 && /pending/i.test(why) && i < 5) { await wait(350); continue; }
    must(r, 'the cancel');
  }
  await db(env.DB.prepare("UPDATE paper_orders SET status = 'canceled' WHERE alpaca_id = ? OR alpaca_id = ?").bind(id, cur).run()).catch(() => {});
  return json({ ok: true, paper: true, canceled: cur, asked: id });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exitOf = (x) => (x.type === 'stop' || x.type === 'stop_limit' || x.type === 'trailing_stop' ? 'sl' : 'tp');
const exitName = (x) => (exitOf(x) === 'sl' ? 'stop loss' : 'take profit');
/** Read an order until `done(order)` or `ms` pass → the last read (null if none answered). */
async function until(env, id, done, { fetchFn, wait, ms = 6000, step = 300 }) {
  let last = null;
  for (let t = 0; t <= ms; t += step) {
    const r = await alpaca(env, '/v2/orders/' + id + '?nested=true', {}, fetchFn);
    if (r.ok) { last = r.body; if (done(last)) return last; }
    await wait(step);
  }
  return last;
}
/**
 * POST /paper/orders/:id/drop { parent, who }: take one take profit or stop loss off an order and keep the rest (TR1,
 * Tony's #37). Alpaca cancels a whole bracket when one held leg is cancelled, and the other exit when one exit is
 * cancelled after the fill (both measured 2026-11-23), so:
 *   entry not filled (bracket / OTO): cancel the group, wait for Alpaca to say so, place the entry again with the kept
 *     exit (an OTO) or alone; the kill switch refuses this (only cancels and closing orders go out while it is on).
 *   entry filled, or an OCO pair on a position: cancel the dropped exit; a kept exit Alpaca took with it is placed again
 *     as a closing order of its own.
 * Each new order is logged ("dropped the take profit of …") before it is sent → { ok, order, kept, steps }.
 */
export async function dropLeg(env, req, id, { fetchFn = fetch, now = Date.now(), wait = sleep } = {}) {
  if (!ID_RE.test(id)) throw fail(400, 'not an order id');
  const b = await bodyOf(req, 1000), who = whoOf(b), pid = String((b && b.parent) || '');
  if (!ID_RE.test(pid)) throw fail(400, 'the order the leg belongs to is needed (parent)');
  const g = must(await alpaca(env, '/v2/orders/' + pid + '?nested=true', {}, fetchFn), 'the order');
  const cls = g.order_class || 'simple', legs = Array.isArray(g.legs) ? g.legs : [];
  const group = cls === 'oco' ? [g, ...legs] : legs;   // an OCO's parent is itself an exit
  const drop = group.find((x) => x.id === id);
  if (!drop || cls === 'simple') throw fail(404, 'that take profit or stop loss is not part of this order');
  const kept = group.filter((x) => x.id !== id && OPEN_ST.has(String(x.status)));
  const what = exitName(drop), steps = [];
  let n = 0;
  const placeAgain = async (o, reason, closing) => {
    const cid = 'd' + now.toString(36) + (n++) + Math.random().toString(36).slice(2, 6);
    const body = alpacaBody({ ...o, client_order_id: cid });
    await db(env.DB.prepare('INSERT OR IGNORE INTO paper_orders (id, at, day, run, who, reason, symbol, side, type, qty, body, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(cid, now, dayNY(now), null, who, reason, body.symbol, body.side, body.type, num(body.qty) || null, JSON.stringify(body), 'sent').run());
    const r = await alpaca(env, '/v2/orders', { method: 'POST', body: JSON.stringify(body) }, fetchFn);
    await db(env.DB.prepare('UPDATE paper_orders SET alpaca_id = ?, status = ?, error = ? WHERE id = ?').bind(r.ok ? r.body.id : null, r.ok ? r.body.status : 'refused', r.ok ? null : String((r.body && r.body.message) || r.status).slice(0, 300), cid).run());
    if (!r.ok) throw fail(502, `${steps.join('; ')}; but Alpaca refused placing ${closing ? 'the kept ' + exitName(o) : 'the order'} again (${(r.body && r.body.message) || 'HTTP ' + r.status}): ${closing ? 'the position has no ' + exitName(o) + ' now' : 'nothing is working for ' + o.symbol + ' now'}`, { alpaca: r.status });
    return r.body;
  };
  const filled = num(g.filled_qty) > 0;
  const entryOpen = cls !== 'oco' && OPEN_ST.has(String(g.status)) && !filled;
  if (cls !== 'oco' && !entryOpen && g.status !== 'filled') throw fail(409, `the entry is ${g.status}${filled ? ' (part filled)' : ''}: cancel the order, or wait for the fill`);
  if (entryOpen) {
    if (await killOn(env)) throw fail(409, 'the kill switch is on: the order can be cancelled, not placed again without its ' + what);
    const c = await alpaca(env, '/v2/orders/' + pid, { method: 'DELETE' }, fetchFn);
    if (!c.ok && c.status !== 404) must(c, 'cancelling the order to take its ' + what + ' off');
    const after = await until(env, pid, (x) => x && (x.status === 'canceled' || x.status === 'filled' || num(x.filled_qty) > 0), { fetchFn, wait });
    if (!after || after.status !== 'canceled') throw fail(409, after && (after.status === 'filled' || num(after.filled_qty) > 0) ? 'the entry filled while the ' + what + ' was being taken off: its exits stand, look again' : 'Alpaca did not confirm the cancel in time: look again before placing anything');
    steps.push('the order was cancelled');
    const o = { symbol: g.symbol, side: g.side, type: g.type, time_in_force: g.time_in_force, qty: num(g.qty) };
    for (const k of ['limit_price', 'stop_price', 'trail_percent', 'trail_price']) if (num(g[k]) != null && !(g.type === 'trailing_stop' && k === 'stop_price')) o[k] = num(g[k]);
    if (g.extended_hours) o.extended_hours = true;
    const k = kept[0];
    if (k) { o.order_class = 'oto'; if (exitOf(k) === 'sl') o.stop_loss = { stop_price: num(k.stop_price), ...(num(k.limit_price) ? { limit_price: num(k.limit_price) } : {}) }; else o.take_profit = { limit_price: num(k.limit_price) }; }
    const order = await placeAgain(o, `dropped the ${what} of ${pid}`, false);
    return json({ ok: true, paper: true, order, kept: k ? exitOf(k) : null, steps: [...steps, 'placed again without its ' + what] });
  }
  // The exits of a position: cancel the one dropped; whatever Alpaca took with it goes back on its own.
  const c = await alpaca(env, '/v2/orders/' + id, { method: 'DELETE' }, fetchFn);
  if (!c.ok && c.status !== 404) must(c, 'the cancel');
  steps.push('the ' + what + ' was cancelled');
  let order = null;
  for (const k of kept) {
    const after = await until(env, k.id, (x) => x && x.status === 'canceled', { fetchFn, wait, ms: 2400 });
    if (!after || after.status !== 'canceled') continue;   // still working: nothing to put back
    const o = { symbol: k.symbol, side: k.side, type: k.type, time_in_force: k.time_in_force === 'day' ? 'day' : 'gtc', qty: num(k.qty) };
    for (const f of ['limit_price', 'stop_price', 'trail_percent', 'trail_price']) if (num(k[f]) != null && !(k.type === 'trailing_stop' && f === 'stop_price')) o[f] = num(k[f]);
    if (!(await closesPosition(env, o, fetchFn))) throw fail(409, `${steps.join('; ')}; the ${exitName(k)} went with it and no longer matches the position, so it was not placed again`);
    order = await placeAgain(o, `kept the ${exitName(k)} of ${pid}`, true);
    steps.push('the ' + exitName(k) + ' was placed again on its own');
  }
  return json({ ok: true, paper: true, order, kept: kept.length ? exitOf(kept[0]) : null, steps });
}
export async function closePosition(env, sym, fetchFn) {
  if (!SYM_RE.test(sym)) throw fail(400, 'not a ticker');
  const r = must(await alpaca(env, '/v2/positions/' + sym, { method: 'DELETE' }, fetchFn), 'closing ' + sym);
  return json({ ok: true, paper: true, order: r });
}
/** The kill switch: on cancels every open order and pauses every run; only closing orders go out until it is off. */
export async function kill(env, req, fetchFn) {
  const b = await bodyOf(req, 500), on = !(b && b.on === false), now = Date.now();
  await db(env.DB.prepare('INSERT INTO meta (k, v, at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, at = excluded.at').bind('paper_kill', on ? '1' : '0', now).run());
  if (!on) return json({ ok: true, kill: false });
  const [c] = await Promise.all([alpaca(env, '/v2/orders', { method: 'DELETE' }, fetchFn), db(env.DB.prepare("UPDATE paper_runs SET state = 'paused', updated = ? WHERE state = 'running'").bind(now).run())]);
  // The runs are paused and only closing orders go out either way; a cancel-all Alpaca did not take is said, never reported as done.
  if (!c.ok) throw fail(502, 'the kill switch is on and every run is paused, but Alpaca did not cancel the open orders (HTTP ' + c.status + '): press it again', { kill: true });
  // Cancelling everything also cancels the bracket stops on open positions: say how many positions are left without one.
  const held = await alpaca(env, '/v2/positions', {}, fetchFn);
  return json({ ok: true, kill: true, canceled: Array.isArray(c.body) ? c.body.length : 0, unprotected: held.ok && Array.isArray(held.body) ? held.body.length : null });
}

/* ── strategy runs ────────────────────────────────────────────────────────── */
/** Who acts: required on every write (a missing author is never taken as Tony's). */
function whoOf(b) { if (!b || !WHO.includes(b.who)) throw fail(400, 'who is tony, run or neo'); return b.who; }
/** Does `o` only close (part of) the account's position in its symbol? Checked against Alpaca, never taken from the caller. */
async function closesPosition(env, o, fetchFn) {
  // T6 review: an OCO (a held position's take profit + stop, both for its shares) only closes too.
  if (!o || (o.order_class && o.order_class !== 'simple' && o.order_class !== 'oco') || o.notional != null) return false;
  const r = await alpaca(env, '/v2/positions/' + o.symbol, {}, fetchFn);
  if (!r.ok) return false;
  const held = Math.abs(num(r.body.qty)), long = r.body.side === 'long', q = num(o.qty);
  return pos(q) && q <= held && (long ? o.side === 'sell' : o.side === 'buy');
}
const runOut = (r) => ({ ...r, spec: JSON.parse(r.spec || 'null'), limits: JSON.parse(r.limits || '{}'), stats: JSON.parse(r.stats || 'null') });
export async function runs(env) {
  const rows = (await db(env.DB.prepare('SELECT * FROM paper_runs ORDER BY created DESC LIMIT 100').all())).results || [];
  // The newest 400 days of each listed run (not the whole table).
  const ids = rows.map((r) => r.id), eq = ids.length ? ((await db(env.DB.prepare(`SELECT run, day, equity FROM paper_equity WHERE run IN (${ids.map(() => '?').join(',')}) ORDER BY day DESC LIMIT ?`).bind(...ids, 400 * ids.length).all())).results || []).reverse() : [];
  return json({ ok: true, runs: rows.map((r) => ({ ...runOut(r), equity: eq.filter((x) => x.run === r.id).map((x) => [x.day, x.equity]) })) });
}
export async function startRun(env, req) {
  const b = await bodyOf(req, 12000), now = Date.now();
  const name = String((b && b.name) || '').trim().slice(0, 80), capital = num(b && b.capital), who = whoOf(b);
  if (!name) throw fail(400, 'a name is needed');
  if (!(capital >= 1000 && capital <= 1e7)) throw fail(400, 'capital is from 1,000 to 10,000,000');
  if (!b.spec || typeof b.spec !== 'object' || JSON.stringify(b.spec).length > 8000) throw fail(400, 'a spec (up to 8 KB) is needed');
  if (await killOn(env)) throw fail(409, 'the kill switch is on');
  const n = await db(env.DB.prepare("SELECT COUNT(*) AS n FROM paper_runs WHERE state != 'stopped'").first());
  if (n && n.n >= 20) throw fail(429, 'at most 20 runs at once');
  const id = 'r' + now.toString(36) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
  const limits = limitsOf(b.limits);
  await db(env.DB.prepare('INSERT INTO paper_runs (id, name, created, updated, spec, capital, limits, state, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, now, now, JSON.stringify(b.spec), capital, JSON.stringify(limits), 'running', who).run());
  return json({ ok: true, run: { id, name, created: now, spec: b.spec, capital, limits, state: 'running', by: who } });
}
export async function changeRun(env, req, id) {
  if (!RUN_RE.test(id)) throw fail(400, 'not a run id');
  const b = await bodyOf(req, 4000), who = whoOf(b), now = Date.now();
  const run = await db(env.DB.prepare('SELECT * FROM paper_runs WHERE id = ?').bind(id).first());
  if (!run) throw fail(404, 'no such run');
  if (run.state === 'stopped') throw fail(409, 'a stopped run stays stopped (start a new one)');
  const sets = [], vals = [];
  if (b.state != null) {
    if (!RUN_STATES.includes(b.state)) throw fail(400, 'state is running, paused or stopped');
    if (b.state === 'running' && await killOn(env)) throw fail(409, 'the kill switch is on');
    sets.push('state = ?'); vals.push(b.state);
  }
  if (b.limits != null) {
    const old = JSON.parse(run.limits || '{}'), next = limitsOf({ ...old, ...b.limits });
    if (who !== 'tony') { const bad = loosened(old, b.limits); if (bad.length) throw fail(403, 'Neo Quant and strategies can tighten limits, never loosen them (' + bad.join(', ') + ')'); }
    sets.push('limits = ?'); vals.push(JSON.stringify(next));
  }
  if (b.capital != null) {
    const c = num(b.capital);
    if (!(c >= 1000 && c <= 1e7)) throw fail(400, 'capital is from 1,000 to 10,000,000');
    if (who !== 'tony' && c > run.capital) throw fail(403, 'only Tony can give a run more capital');
    sets.push('capital = ?'); vals.push(c);
  }
  if (b.stats != null && who === 'run') { sets.push('stats = ?'); vals.push(JSON.stringify(b.stats).slice(0, 20000)); }
  if (b.lastBar != null && who === 'run') { sets.push('last_bar = ?'); vals.push(num(b.lastBar)); }
  if (!sets.length) throw fail(400, 'nothing to change');
  await db(env.DB.prepare(`UPDATE paper_runs SET ${sets.join(', ')}, updated = ? WHERE id = ?`).bind(...vals, now, id).run());
  return json({ ok: true, run: runOut(await env.DB.prepare('SELECT * FROM paper_runs WHERE id = ?').bind(id).first()) });
}
export async function postFills(env, req) {
  const b = await bodyOf(req, 60000), list = Array.isArray(b && b.fills) ? b.fills.slice(0, 200) : [];
  const q = list.filter((f) => f && /^[\w:.-]{1,80}$/.test(String(f.id)) && SYM_RE.test(String(f.symbol))).map((f) => env.DB.prepare('INSERT OR IGNORE INTO paper_fills (id, at, order_id, run, symbol, side, qty, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(String(f.id), num(f.at), f.order || null, f.run && RUN_RE.test(f.run) ? f.run : null, f.symbol, f.side === 'sell' ? 'sell' : 'buy', num(f.qty), num(f.price)));
  if (q.length) await db(env.DB.batch(q));
  return json({ ok: true, kept: q.length });
}
export async function postEquity(env, req) {
  const b = await bodyOf(req, 20000), rows = Array.isArray(b && b.rows) ? b.rows.slice(0, 60) : [];
  const q = rows.filter((r) => r && (r.run === 'account' || RUN_RE.test(String(r.run))) && /^\d{4}-\d\d-\d\d$/.test(String(r.day)) && Number.isFinite(num(r.equity)))
    .map((r) => env.DB.prepare('INSERT INTO paper_equity (run, day, equity) VALUES (?, ?, ?) ON CONFLICT (run, day) DO UPDATE SET equity = excluded.equity').bind(r.run, r.day, num(r.equity)));
  if (q.length) await db(env.DB.batch(q));
  return json({ ok: true, kept: q.length });
}
