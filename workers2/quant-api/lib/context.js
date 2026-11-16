// Phase 13 (A1-Priv docs/TradeHub/quant/phase-13.md): the options, macro and
// earnings context. All in D1 (migrations/0012_context.sql).
//
//   GET  /options?symbol=X     { chain, ivLog, calls, cached, label }   CBOE's delayed chain, compact;
//                              at most 2 CBOE calls a symbol a New York day (MAX_CALLS), and a fetch
//                              only when the cached one is older than REFRESH_MS; the 30-day IV is
//                              logged once a day (iv_log)
//   GET  /macro                { series: { ID: [[day, v]…] }, names, at }   FRED, each series refreshed
//                              at most every MACRO_TTL (≤ 7 calls a refresh)
//   GET  /macro/dates          { dates: { kind: [day…] } }   past release days (FRED's calendar, 2025 on);
//                              a past year is kept once read after it ended, this year read again weekly
//   GET  /earnings?symbols=A,B { reports: { SYM: [{ day, time, eps, est }] } }   no outside call
//   POST /earnings/fetch       { mode: 'nightly' | 'backfill', max } → { asked, stored, stop, done }
//                              nightly: the last 3 weekdays again (late EPS) and any of the last 7 not asked
//                              (today only after 20:00 New York); backfill: the newest weekdays never asked,
//                              back 10 years, at most `max` (≤ 20) a call; a backfill never asks a day twice
import { fail, json } from './http.js';
import { Ledger } from './ledger.js';
import { ProviderError } from './net.js';
import { bodyOf, symOf } from './charts.js';
import { nyDate, nyClock } from './time.js';
import * as O from '../providers/options.js';
import * as M from '../providers/macro.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const MAX_CALLS = 2, REFRESH_MS = 3 * HOUR, IV_KEEP = 260, MACRO_TTL = 6 * HOUR;
export const FETCH_MAX = 20, NIGHTLY_DAYS = 7, RECHECK_DAYS = 3, BACKFILL_YEARS = 10;
export const LABEL = '15 min delayed';

const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
const notYet = () => fail(503, 'the context tables are not there yet (D1 migration 0012_context.sql)');
async function guarded(p) { try { return await p; } catch (e) { if (noTable(e)) throw notYet(); throw e; } }
const batch = (env, stmts) => (env.DB.batch ? env.DB.batch(stmts) : (async () => { for (const s of stmts) await s.run(); })());
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

/** Whether a cached chain is used as it is: fetched today (New York) and either
 *  fresh enough or at today's CBOE allowance. */
export function useCached(row, now) {
  if (!row) return false;
  if (row.day !== nyDate(now)) return false;
  return row.calls >= MAX_CALLS || now - row.at < REFRESH_MS;
}

/* ── /options ───────────────────────────────────────────────────────────── */
export async function getOptions(env, url) {
  const sym = symOf(url.searchParams.get('symbol'));
  if (!sym) throw fail(400, 'symbol is needed');
  const now = Date.now(), today = nyDate(now);
  const row = await guarded(env.DB.prepare('SELECT * FROM options_cache WHERE symbol = ?').bind(sym).first());
  const readLog = async () => ((await env.DB.prepare('SELECT day, iv FROM iv_log WHERE symbol = ? ORDER BY day DESC LIMIT ?').bind(sym, IV_KEEP).all()).results || []).reverse();
  if (useCached(row, now)) return json({ ok: true, chain: parse(row.body), ivLog: await readLog(), calls: row.calls, cached: true, label: LABEL });
  if (!O.canAsk(sym)) return json({ ok: true, chain: row ? parse(row.body) : null, ivLog: await readLog(), calls: 0, cached: !!row, label: LABEL, note: 'CBOE options are not asked for this symbol' });
  // Reserve the call first, in one statement: two requests at once cannot both pass the cap, and a
  // failed fetch still uses its call (and waits REFRESH_MS), so a ticker CBOE cannot answer costs at most 2 a day.
  const won = await env.DB.prepare("INSERT INTO options_cache (symbol, day, at, calls, body) VALUES (?, ?, ?, 1, 'null') ON CONFLICT (symbol) DO UPDATE SET "
    + 'calls = CASE WHEN options_cache.day = excluded.day THEN options_cache.calls + 1 ELSE 1 END, day = excluded.day, at = excluded.at '
    + 'WHERE options_cache.day <> excluded.day OR (options_cache.calls < ? AND options_cache.at <= ?)').bind(sym, today, now, MAX_CALLS, now - REFRESH_MS).run();
  if (!won || !won.meta || !won.meta.changes) {
    const cur = await env.DB.prepare('SELECT * FROM options_cache WHERE symbol = ?').bind(sym).first();
    return json({ ok: true, chain: cur ? parse(cur.body) : null, ivLog: await readLog(), calls: cur ? cur.calls : 0, cached: true, label: LABEL });
  }
  const calls = row && row.day === today ? row.calls + 1 : 1;
  const L = await Ledger.load(env, now);
  let chain = null, note = null;
  try { chain = await O.chain(L, sym, now); }
  catch (e) { if (!(e instanceof ProviderError)) throw e; note = 'CBOE: ' + e.message; }
  await L.flush();
  if (!chain) return json({ ok: true, chain: row ? parse(row.body) : null, ivLog: await readLog(), calls, cached: !!(row && parse(row.body)), stale: !!(row && parse(row.body)), label: LABEL, note });
  const stmts = [env.DB.prepare('UPDATE options_cache SET body = ? WHERE symbol = ?').bind(JSON.stringify(chain), sym)];
  // The 30-day IV, once a day (the first fetch of the day keeps it; INSERT OR IGNORE).
  if (Number.isFinite(chain.iv30) && chain.iv30 > 0) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO iv_log (symbol, day, iv) VALUES (?, ?, ?)').bind(sym, today, chain.iv30));
  await batch(env, stmts);
  return json({ ok: true, chain, ivLog: await readLog(), calls, cached: false, label: LABEL });
}

/* ── /macro ─────────────────────────────────────────────────────────────── */
export async function getMacro(env) {
  const now = Date.now();
  const rows = (await guarded(env.DB.prepare('SELECT id, at, body FROM macro_series').all())).results || [];
  const have = new Map(rows.map((r) => [r.id, r]));
  const stale = Object.keys(M.SERIES).filter((id) => !have.has(id) || now - have.get(id).at > MACRO_TTL);
  const notes = [];
  if (stale.length) {
    const L = await Ledger.load(env, now), stmts = [];
    await Promise.all(stale.map(async (id) => {
      try {
        const s = await M.fredSeries(L, id, now);
        have.set(id, { id, at: now, body: JSON.stringify(s) });
        stmts.push(env.DB.prepare('INSERT INTO macro_series (id, at, body) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at, body = excluded.body').bind(id, now, JSON.stringify(s)));
      } catch (e) { if (!(e instanceof ProviderError)) throw e; notes.push(id + ': ' + e.message); }
    }));
    await L.flush();
    if (stmts.length) await batch(env, stmts);
  }
  const series = {};
  let at = 0;
  for (const [id, r] of have) { if (!M.SERIES[id]) continue; series[id] = parse(r.body) || []; at = Math.max(at, r.at); }
  return json({ ok: true, series, names: M.SERIES, at: at || null, notes });
}

/* ── /macro/dates ───────────────────────────────────────────────────────── */
export const DATES_TTL = 7 * DAY, DATES_PER_CALL = 20;
export async function getMacroDates(env) {
  const now = Date.now(), year = Number(nyDate(now).slice(0, 4));
  const rows = (await guarded(env.DB.prepare("SELECT id, at, body FROM macro_series WHERE id LIKE 'dates:%'").all())).results || [];
  const have = new Map(rows.map((r) => [r.id, r]));
  const want = [];
  for (const kind of Object.keys(M.RIDS)) for (let y = M.FIRST_YEAR; y <= year; y++) {
    const id = `dates:${kind}:${y}`, r = have.get(id);
    // Final once read after the year ended AND it listed days (an empty page may be a format change: read again weekly).
    const final = r && Number(nyDate(r.at).slice(0, 4)) > y && (parse(r.body) || []).length > 0;
    if (!r || (!final && now - r.at > DATES_TTL)) want.push([id, kind, y]);
  }
  const notes = [];
  if (want.length) {
    const L = await Ledger.load(env, now), stmts = [];
    for (const [id, kind, y] of want.slice(0, DATES_PER_CALL)) {
      try {
        const days = await M.releaseDays(L, kind, y);
        if (!days.length) notes.push(id + ': none listed');
        have.set(id, { id, at: now, body: JSON.stringify(days) });
        stmts.push(env.DB.prepare('INSERT INTO macro_series (id, at, body) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at, body = excluded.body').bind(id, now, JSON.stringify(days)));
      } catch (e) { if (!(e instanceof ProviderError)) throw e; notes.push(id + ': ' + e.message); }
    }
    await L.flush();
    if (stmts.length) await batch(env, stmts);
  }
  const dates = {};
  for (const [id, r] of have) { const kind = id.split(':')[1]; if (!M.RIDS[kind]) continue; dates[kind] = (dates[kind] || []).concat(parse(r.body) || []); }
  for (const k of Object.keys(dates)) dates[k] = [...new Set(dates[k])].sort();
  return json({ ok: true, dates, from: M.FIRST_YEAR, notes });
}

/* ── /earnings ──────────────────────────────────────────────────────────── */
export async function getEarnings(env, url) {
  const syms = String(url.searchParams.get('symbols') || url.searchParams.get('symbol') || '').split(',').filter((x) => x.trim()).map(symOf).slice(0, 60);
  if (!syms.length) throw fail(400, 'symbols is needed');
  const rows = (await guarded(env.DB.prepare('SELECT symbol, day, time, eps, est FROM earnings WHERE symbol IN (SELECT value FROM json_each(?)) ORDER BY day').bind(JSON.stringify(syms)).all())).results || [];
  const reports = Object.fromEntries(syms.map((s) => [s, []]));
  for (const r of rows) reports[r.symbol].push({ day: r.day, time: r.time, eps: r.eps, est: r.est });
  const span = await env.DB.prepare('SELECT MIN(day) AS lo, MAX(day) AS hi, COUNT(*) AS n FROM earnings_days').first();
  return json({ ok: true, reports, asked: span ? { from: span.lo, to: span.hi, days: span.n } : null });
}

const isWeekday = (d) => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6; };
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);

/**
 * The days a fetch asks, newest first, given the days already asked (a Set):
 *   nightly   the last RECHECK_DAYS weekdays again (EPS Nasdaq fills in late), and any of the
 *             last NIGHTLY_DAYS weekdays not asked yet
 *   backfill  the newest weekdays never asked, back to BACKFILL_YEARS: every hole is filled
 *             (an outage longer than a week too), and a day asked is never asked again
 */
export function daysToAsk(mode, asked, { now = Date.now(), max = FETCH_MAX } = {}) {
  const out = [], c = nyClock(now);
  const lastDay = c.minutes >= 20 * 60 ? c.date : addDays(c.date, -1);
  const floor = addDays(c.date, -Math.round(BACKFILL_YEARS * 365.25));
  if (mode === 'nightly') {
    for (let d = lastDay, seen = 0; seen < NIGHTLY_DAYS && out.length < max; d = addDays(d, -1)) {
      if (!isWeekday(d)) continue;
      seen++;
      if (seen <= RECHECK_DAYS || !asked.has(d)) out.push(d);
    }
    return out;
  }
  for (let d = lastDay; out.length < max && d >= floor; d = addDays(d, -1)) if (isWeekday(d) && !asked.has(d)) out.push(d);
  return out;
}

export async function postEarningsFetch(env, req) {
  const b = (await bodyOf(req, 2000)) || {};
  const mode = b.mode === 'backfill' ? 'backfill' : 'nightly';
  const max = Math.max(1, Math.min(FETCH_MAX, Number(b.max) || FETCH_MAX));
  const now = Date.now();
  const askedRows = (await guarded(env.DB.prepare('SELECT day FROM earnings_days').all())).results || [];
  const asked = new Set(askedRows.map((r) => r.day));
  const days = daysToAsk(mode, asked, { now, max });
  const L = await Ledger.load(env, now);
  let stored = 0, stop = null;
  const done = [];
  try {
    for (const d of days) {
      let rows;
      try { rows = await M.earningsOn(L, d); }
      catch (e) { if (!(e instanceof ProviderError)) throw e; stop = 'Nasdaq: ' + e.message; break; }
      // A value Nasdaq has not filled in yet never wipes one already stored.
      const stmts = rows.map((r) => env.DB.prepare('INSERT INTO earnings (symbol, day, time, eps, est) VALUES (?, ?, ?, ?, ?) ON CONFLICT (symbol, day) DO UPDATE SET time = COALESCE(excluded.time, earnings.time), eps = COALESCE(excluded.eps, earnings.eps), est = COALESCE(excluded.est, earnings.est)')
        .bind(r.symbol, r.day, r.time, r.eps, r.est));
      stmts.push(env.DB.prepare('INSERT INTO earnings_days (day, at, n) VALUES (?, ?, ?) ON CONFLICT (day) DO UPDATE SET at = excluded.at, n = excluded.n').bind(d, now, rows.length));
      await batch(env, stmts);
      stored += rows.length; done.push(d);
    }
  } finally { await L.flush(); }
  const left = mode === 'backfill' ? daysToAsk('backfill', new Set([...asked, ...done]), { now, max: 1 }).length : 0;
  return json({ ok: true, mode, asked: done, stored, stop, done: mode === 'backfill' ? !left : true });
}
