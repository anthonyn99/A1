// TradeHub's book per paper broker (Batch 4 T5, A1-Priv docs/TradeHub/quant/t4-05.md). A broker's paper
// balance cannot be chosen (Alpaca's is set when the account is made; Webull's sandbox resets only from its
// web console), so TradeHub keeps its own starting capital over it:
//   shown equity = capital + (broker equity − baseline)          (P&L is the broker's, to the cent)
//   shown cash   = broker cash + (capital − baseline)
//   buying power = broker buying power × shown equity / broker equity, capped at bp_cap − what is held
// No book row = the broker's own numbers. Every account read and every order check uses the shown numbers,
// so the page and this worker agree on what can be bought.
//
//   GET  /trade/:broker/book          { book, defaults }
//   PUT  /trade/:broker/book          { capital?, bpCap?, who: 'tony' }   change the capital or the cap (no reset)
//   POST /trade/:broker/book/reset    { capital?, bpCap?, who: 'tony', confirm: true }
//        cancel every open order, close every position at market, a new baseline; capital = the one given,
//        else the book's, else the broker's default ($100,000 Alpaca, $1,000,000 Webull)
import { fail, json } from './http.js';
import { bodyOf } from './charts.js';

export const DEFAULT_CAPITAL = { alpaca: 100000, webull: 1000000 };
export const MIN_CAPITAL = 1000, MAX_CAPITAL = 10_000_000, MAX_RESETS = 20;
const num = (x) => (x == null || x === '' ? null : Number(x));
const fin = (x) => Number.isFinite(x);
const NY_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayNY = (t) => NY_DAY.format(new Date(t));

/** The broker's account `a` ({ equity, cash, buying_power, long_value, short_value, last_equity }) as the book shows it. */
export function applyBook(book, a, now = Date.now()) {
  if (!a) return a;
  if (!book) return { ...a, booked: false };
  const off = book.capital - book.baseline, eq = num(a.equity);
  const equity = fin(eq) ? eq + off : null;
  const scale = fin(eq) && eq > 0 && fin(equity) ? Math.max(0, equity) / eq : 1;
  let bp = fin(num(a.buying_power)) ? num(a.buying_power) * scale : null;
  if (fin(book.bp_cap) && fin(bp)) bp = Math.max(0, Math.min(bp, book.bp_cap - (Math.abs(num(a.long_value) || 0) + Math.abs(num(a.short_value) || 0))));
  const r = (x) => (fin(x) ? Math.round(x * 100) / 100 : x);
  // Reset today: the day starts at the reset (the capital), not at the broker's close yesterday.
  const resetToday = book.resets && book.resets[0] && fin(book.resets[0].at) && dayNY(book.resets[0].at) === dayNY(now);
  const last = resetToday ? book.capital : fin(num(a.last_equity)) ? num(a.last_equity) + off : a.last_equity;
  return { ...a, equity: r(equity), cash: fin(num(a.cash)) ? r(num(a.cash) + off) : a.cash, last_equity: r(last),
    ...(a.day_pnl !== undefined && resetToday && fin(equity) ? { day_pnl: r(equity - book.capital) } : {}),
    buying_power: r(bp), booked: true, broker_equity: eq, broker_cash: num(a.cash), broker_buying_power: num(a.buying_power) };
}
/** An order's dollar value at `price` (its notional, else qty × its limit, stop or the price). */
export function orderValue(o, price) {
  if (!o) return null;
  if (fin(num(o.notional))) return num(o.notional);
  const ref = num(o.limit_price) || num(o.stop_price) || num(price), q = num(o.qty);
  return fin(ref) && fin(q) ? ref * q : null;
}
/** The book's refusal for an order, or '' (a closing order is never refused here). `already` = the value the
 *  broker's buying power already holds back for it (a changed order: its old value), so only the increase counts. */
export function overBook(shown, o, price, closing = false, already = 0) {
  if (closing || !shown || !shown.booked) return '';
  const v = orderValue(o, price), more = fin(v) ? v - (fin(already) ? already : 0) : null;
  return fin(more) && more > 0 && fin(shown.buying_power) && more > shown.buying_power + 0.005 ? `that order ($${v.toFixed(2)}) is more than the book's buying power ($${shown.buying_power.toFixed(2)})` : '';
}

const out = (row) => (row ? { capital: row.capital, baseline: row.baseline, bp_cap: row.bp_cap == null ? null : row.bp_cap, at: row.at, resets: JSON.parse(row.resets || '[]') } : null);
/** The broker's book (null: none, or the table is not there yet). Read from D1 every time, never cached: a
 *  change or a reset must reach every worker copy at once (one D1 read per account poll is nothing). */
export async function readBook(env, broker) {
  let row = null;
  try { row = await env.DB.prepare('SELECT * FROM trade_books WHERE broker = ?').bind(broker).first(); }
  catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
  return out(row);
}
function capitalOf(v) {
  const c = num(v);
  if (!(fin(c) && c >= MIN_CAPITAL && c <= MAX_CAPITAL)) throw fail(400, `capital is between $${MIN_CAPITAL.toLocaleString('en-US')} and $${MAX_CAPITAL.toLocaleString('en-US')}`);
  return Math.round(c * 100) / 100;
}
function capOf(v) {
  if (v === null || v === '' || v === 0) return null;
  const c = num(v);
  if (!(fin(c) && c > 0 && c <= 5 * MAX_CAPITAL)) throw fail(400, 'the buying-power cap is a dollar amount above zero, or none');
  return Math.round(c * 100) / 100;
}
async function save(env, broker, b) {
  try {
    await env.DB.prepare('INSERT INTO trade_books (broker, capital, baseline, bp_cap, at, resets) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (broker) DO UPDATE SET capital = excluded.capital, baseline = excluded.baseline, bp_cap = excluded.bp_cap, at = excluded.at, resets = excluded.resets')
      .bind(broker, b.capital, b.baseline, b.bp_cap, b.at, JSON.stringify(b.resets || [])).run();
  } catch (e) { if (/no such table/i.test(String(e && e.message))) throw fail(503, 'the book table is not there yet (D1 migration 0015_books.sql)'); throw e; }
}

/**
 * /trade/:broker/book… → Response. `rawAccount()` = the broker's own account ({ equity, … }, fresh);
 * `flatten()` = cancel every open order and close every position → { canceled, closing: [symbols], failed: [..] }.
 */
export async function bookRoute(env, req, broker, rest, m, { rawAccount, flatten, now = Date.now() }) {
  if (rest === '/book' && m === 'GET') return json({ ok: true, broker, book: await readBook(env, broker), defaults: { capital: DEFAULT_CAPITAL[broker] } });
  if (m !== 'PUT' && m !== 'POST') throw fail(405, 'GET, PUT or POST');
  const b = (await bodyOf(req, 1000)) || {};
  // Only Tony sets the book: Neo Quant never changes capital or buying power (§1 rule 6).
  if (b.who !== 'tony') throw fail(403, 'only you can change the book (who: tony)');
  const was = await readBook(env, broker);
  if (rest === '/book' && m === 'PUT') {
    if (b.capital == null && !('bpCap' in b)) throw fail(400, 'nothing to change (capital or bpCap)');
    const a = was ? null : await rawAccount();
    if (!was && !(a && fin(num(a.equity)) && num(a.equity) > 0)) throw fail(503, 'the broker account could not be read: try again');
    const next = { capital: b.capital != null ? capitalOf(b.capital) : (was ? was.capital : num(a.equity)), baseline: was ? was.baseline : num(a.equity),
      bp_cap: 'bpCap' in b ? capOf(b.bpCap) : (was ? was.bp_cap : null), at: now, resets: was ? was.resets : [] };
    await save(env, broker, next);
    return json({ ok: true, broker, book: out({ ...next, resets: JSON.stringify(next.resets) }) });
  }
  if (rest === '/book/reset' && m === 'POST') {
    if (b.confirm !== true) throw fail(400, 'a reset closes every position and cancels every order: send confirm: true');
    const capital = b.capital != null ? capitalOf(b.capital) : (was ? was.capital : DEFAULT_CAPITAL[broker]);
    const bp_cap = 'bpCap' in b ? capOf(b.bpCap) : (was ? was.bp_cap : null);
    const done = await flatten();
    // A position the broker would not close (Webull outside market hours) leaves the book as it was: a "fresh"
    // book with old positions in it would mislead. The cancels stand; Tony resets again in market hours.
    if (done.failed && done.failed.length) throw fail(409, `${done.canceled || 0} open order(s) were cancelled, but ${done.failed.join(', ')} could not be closed now (Webull takes market orders only in market hours): the book was not reset; press Reset again in market hours`, { canceled: done.canceled || 0, failed: done.failed });
    const a = await rawAccount();
    if (!(a && fin(num(a.equity)) && num(a.equity) > 0)) throw fail(502, 'the orders were cancelled and the positions sent to close, but the account could not be read for the new baseline: press Reset again');
    const shownBefore = was ? applyBook(was, a, now).equity : num(a.equity);
    const resets = [{ at: now, capital, from: fin(shownBefore) ? Math.round(shownBefore * 100) / 100 : null, canceled: done.canceled || 0, closing: done.closing || [] }, ...(was ? was.resets : [])].slice(0, MAX_RESETS);
    const next = { capital, baseline: num(a.equity), bp_cap, at: now, resets };
    await save(env, broker, next);
    return json({ ok: true, broker, book: out({ ...next, resets: JSON.stringify(resets) }), canceled: done.canceled || 0, closing: done.closing || [], failed: done.failed || [] });
  }
  throw fail(404, 'no such book route');
}
