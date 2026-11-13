// Phase 7's routes (A1-Priv docs/TradeHub/quant/phase-07.md): the ticker
// dossier, the fundamentals the nightly ideas job ranks, the ideas it stores,
// and FINRA short volume. All in D1 (migrations/0007_dossier.sql). Before that
// migration is applied, reads answer empty and the dossier and writes 503.
//
//   GET  /dossier?symbol=X[&cik=N]   { symbol, asOf, parts, failed, pending, calls }
//        parts: { part: { src, at, facts } }, each kept in D1 for its own time
//        (calendar 6 h, SEC 7 days, the rest 24 h). At most DOSSIER_CALLS
//        provider calls a request: parts past that are listed in `pending`
//        and come on the next request (the page asks once more by itself).
//   GET  /fundamentals?symbols=A,B   { items: { SYM: { at, facts } }, failed, calls }
//        Finnhub's basic financials for the ideas job, at most 25 symbols a
//        request, each kept 7 days (shared with the dossier's `metric` part).
//   GET  /ideas                      { ideas, at }  the newest nightly ideas
//   POST /ideas { ideas }            the runner's ideas; the last 30 are kept
//   POST /short-volume { rows: [{ symbol, day, short, total }] }   FINRA's daily
//        file for the watchlist (from the runner); 60 days kept
import { fail, json } from './http.js';
import { Ledger } from './ledger.js';
import { bodyOf, symOf } from './charts.js';
import { ProviderError } from './net.js';
import * as F from '../providers/fundamentals.js';

const HOUR = 3600_000, DAY = 24 * HOUR;
export const DOSSIER_CALLS = 6, FUND_MAX = 25, IDEAS_KEEP = 30, IDEAS_BYTES = 200_000, SHORT_MAX = 3000, SHORT_KEEP_DAYS = 60;
export const TTL = { calendar: 6 * HOUR, metric: DAY, target: DAY, recommendation: DAY, surprises: DAY, insiders: DAY, estimates: DAY, sec: 7 * DAY };
export const FUND_TTL = 7 * DAY;
// The order parts are refreshed in when the call budget runs short: what changes most first.
export const PART_ORDER = ['calendar', 'metric', 'target', 'recommendation', 'surprises', 'insiders', 'estimates', 'sec'];
export const PART_SRC = { calendar: 'finnhub', metric: 'finnhub', target: 'nasdaq', recommendation: 'finnhub', surprises: 'finnhub', insiders: 'finnhub', estimates: 'nasdaq', sec: 'sec' };
const FINNHUB_PARTS = new Set(['calendar', 'metric', 'recommendation', 'surprises', 'insiders']);

const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
const notYet = () => fail(503, 'the dossier tables are not there yet (D1 migration 0007_dossier.sql)');
async function guarded(p, empty) {
  try { return await p; } catch (e) { if (noTable(e)) { if (empty !== undefined) return empty; throw notYet(); } throw e; }
}
const batch = (env, stmts) => (env.DB.batch ? env.DB.batch(stmts) : (async () => { for (const s of stmts) await s.run(); })());
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

// The edge cache as a small JSON store (absent outside Cloudflare, e.g. in the tests).
const edge = () => (typeof caches !== 'undefined' && caches.default) || null;
export const jsonCache = {
  async get(key) { const c = edge(); if (!c) return null; const r = await c.match(key); return r ? r.json() : null; },
  async put(key, v, ttlS) { const c = edge(); if (c) await c.put(key, new Response(JSON.stringify(v), { headers: { 'cache-control': 'public, max-age=' + ttlS } })); },
};

/** Run one part: its calls (and its fallback's, if the budget allows) → { src, facts, calls }. */
async function runPart(part, { L, env, sym, cik, now, room }) {
  let calls = 0;
  const one = async (fn) => { calls++; return fn(); };
  if (FINNHUB_PARTS.has(part) && !env.FINNHUB_KEY) throw new ProviderError('finnhub', 'no Finnhub key set');
  if (part === 'metric') return { src: 'finnhub', facts: await one(() => F.metric(L, env, sym)), calls };
  if (part === 'recommendation') return { src: 'finnhub', facts: await one(() => F.recommendation(L, env, sym)), calls };
  if (part === 'surprises') return { src: 'finnhub', facts: await one(() => F.surprises(L, env, sym)), calls };
  if (part === 'insiders') return { src: 'finnhub', facts: await one(() => F.insiders(L, env, sym, now)), calls };
  if (part === 'estimates') return { src: 'nasdaq', facts: await one(() => F.estimates(L, sym)), calls };
  if (part === 'calendar') {
    const f = await one(() => F.calendar(L, env, sym, now));
    if (f.nextEarnings || room - calls < 1) return { src: 'finnhub', facts: f, calls };
    // Finnhub knows no date: Nasdaq's earnings date is the second source.
    try { const n = await one(() => F.earningsDate(L, sym)); if (n.nextEarnings) return { src: 'nasdaq', facts: n, calls }; } catch (e) { if (!(e instanceof ProviderError)) throw e; }
    return { src: 'finnhub', facts: f, calls };
  }
  if (part === 'target') {
    try { return { src: 'nasdaq', facts: await one(() => F.target(L, sym)), calls }; }
    catch (e) {
      if (!(e instanceof ProviderError) || !F.alphavantage.has(env) || room - calls < 1) throw e;
      return { src: 'alphavantage', facts: await one(() => F.avTarget(L, env, sym)), calls };
    }
  }
  if (part === 'sec') {
    let id = cik;
    if (!id) { calls++; id = await F.cikOf(L, sym, jsonCache); }   // a cached map makes no call, but is counted as one (the budget cannot see the cache)
    if (!id) throw new ProviderError('sec', 'the SEC has no company number for ' + sym);
    return { src: 'sec', facts: await one(() => F.sec(L, id)), calls };
  }
  throw new Error('no such part ' + part);
}

/** GET /dossier?symbol=X[&cik=N]: the stored parts, the stale ones refreshed (≤ DOSSIER_CALLS calls). */
export async function getDossier(env, url, ctx, later) {
  const sym = symOf(url.searchParams.get('symbol'));
  if (!sym || sym.startsWith('^')) throw fail(400, 'symbol= (a stock or fund) is needed');
  const cikQ = url.searchParams.get('cik');
  const cik = cikQ && /^\d{1,10}$/.test(cikQ) ? cikQ.replace(/^0+/, '') : null;
  const now = Date.now();
  const rows = (await guarded(env.DB.prepare('SELECT part, at, src, body, error FROM dossier_parts WHERE symbol = ?').bind(sym).all())).results || [];
  const have = Object.fromEntries(rows.map((r) => [r.part, r]));
  const stale = PART_ORDER.filter((p) => !have[p] || now - have[p].at > TTL[p]);
  const parts = {}, failed = {}, pending = [], writes = [];
  for (const r of rows) if (PART_SRC[r.part]) parts[r.part] = { src: r.src, at: r.at, facts: parse(r.body) || {} };
  let calls = 0;
  const L = await Ledger.load(env, now);
  try {
    for (const p of stale) {
      const room = DOSSIER_CALLS - calls;
      if (room < 1) { pending.push(p); continue; }
      try {
        const r = await runPart(p, { L, env, sym, cik, now, room });
        calls += r.calls;
        parts[p] = { src: r.src, at: now, facts: r.facts };
        writes.push(env.DB.prepare('INSERT INTO dossier_parts (symbol, part, at, src, body, error) VALUES (?, ?, ?, ?, ?, NULL) '
          + 'ON CONFLICT (symbol, part) DO UPDATE SET at = excluded.at, src = excluded.src, body = excluded.body, error = NULL').bind(sym, p, now, r.src, JSON.stringify(r.facts)));
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        calls += 1;
        failed[p] = (e.provider ? e.provider + ': ' : '') + e.message;
      }
    }
  } finally { await later(ctx, L.flush()); }
  if (writes.length) await batch(env, writes);
  // FINRA short volume: the runner's rows, no call.
  const sv = (await guarded(env.DB.prepare('SELECT day, short, total FROM short_volume WHERE symbol = ? ORDER BY day DESC LIMIT 40').bind(sym).all(), { results: [] })).results || [];
  if (sv.length) parts.short = { src: 'finra', at: Date.parse(sv[0].day + 'T21:00:00Z'), facts: { shortVolume: sv.map((r) => ({ day: r.day, ratio: r.total ? r.short / r.total : null })) } };
  const asOf = Math.max(0, ...Object.values(parts).map((p) => p.at || 0));
  return json({ ok: true, symbol: sym, asOf: asOf || null, parts, failed, pending, calls });
}

/** GET /fundamentals?symbols=A,B (≤ 25): Finnhub basic financials, each kept FUND_TTL. */
export async function getFundamentals(env, url, ctx, later) {
  const syms = [...new Set(String(url.searchParams.get('symbols') || '').split(',').map((s) => symOf(s)).filter((s) => s && !s.startsWith('^')))];
  if (!syms.length) throw fail(400, 'symbols= is needed');
  if (syms.length > FUND_MAX) throw fail(400, `at most ${FUND_MAX} symbols a request`);
  const now = Date.now();
  const rows = (await guarded(env.DB.prepare("SELECT symbol, at, body FROM dossier_parts WHERE part = 'metric' AND symbol IN (SELECT value FROM json_each(?))").bind(JSON.stringify(syms)).all())).results || [];
  const items = {}, failed = {}, writes = [];
  for (const r of rows) items[r.symbol] = { at: r.at, facts: parse(r.body) || {} };
  const todo = syms.filter((s) => !items[s] || now - items[s].at > FUND_TTL);
  let calls = 0;
  if (todo.length && !env.FINNHUB_KEY) for (const s of todo) failed[s] = 'no Finnhub key set';
  else if (todo.length) {
    const L = await Ledger.load(env, now);
    try {
      for (const s of todo) {
        calls++;
        try {
          const facts = await F.metric(L, env, s);
          items[s] = { at: now, facts };
          writes.push(env.DB.prepare("INSERT INTO dossier_parts (symbol, part, at, src, body, error) VALUES (?, 'metric', ?, 'finnhub', ?, NULL) "
            + 'ON CONFLICT (symbol, part) DO UPDATE SET at = excluded.at, src = excluded.src, body = excluded.body, error = NULL').bind(s, now, JSON.stringify(facts)));
        } catch (e) { if (!(e instanceof ProviderError)) throw e; failed[s] = e.message; }
      }
    } finally { await later(ctx, L.flush()); }
  }
  if (writes.length) await batch(env, writes);
  return json({ ok: true, items, failed, calls });
}

/** GET /ideas: one read. */
export async function getIdeas(env) {
  const row = await guarded(env.DB.prepare('SELECT at, body FROM ideas ORDER BY at DESC, id DESC LIMIT 1').first(), null);
  return json({ ok: true, ideas: row ? parse(row.body) : null, at: row ? row.at : null });
}
/** POST /ideas { ideas }: one insert, and anything past the newest 30 removed (one batch). */
export async function postIdeas(env, req) {
  const b = await bodyOf(req, IDEAS_BYTES + 200);
  const x = b && b.ideas;
  if (!x || typeof x !== 'object' || Array.isArray(x) || x.v !== 1 || !Array.isArray(x.items) || !/^\d{4}-\d{2}-\d{2}$/.test(x.day || '')) throw fail(400, 'ideas needs v 1, day and items');
  const body = JSON.stringify(x), now = Date.now();
  if (body.length > IDEAS_BYTES) throw fail(413, 'ideas may be at most ' + IDEAS_BYTES + ' bytes');
  await guarded(batch(env, [
    env.DB.prepare('INSERT INTO ideas (day, at, body) VALUES (?, ?, ?)').bind(x.day, now, body),
    env.DB.prepare('DELETE FROM ideas WHERE id NOT IN (SELECT id FROM ideas ORDER BY at DESC, id DESC LIMIT ?)').bind(IDEAS_KEEP),
  ]));
  return json({ ok: true, at: now });
}

/** POST /short-volume { rows }: one batch of upserts, rows older than 60 days removed. */
export async function postShortVolume(env, req) {
  const b = await bodyOf(req, 400_000);
  const rows = Array.isArray(b && b.rows) ? b.rows : null;
  if (!rows || !rows.length) throw fail(400, 'rows is needed');
  if (rows.length > SHORT_MAX) throw fail(400, `at most ${SHORT_MAX} rows a call`);
  const stmts = [];
  for (const r of rows) {
    const sym = symOf(r && r.symbol), day = String((r && r.day) || '');
    if (!sym || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !(r.total > 0) || !(r.short >= 0) || r.short > r.total) throw fail(400, 'each row needs symbol, day, short ≤ total');
    stmts.push(env.DB.prepare('INSERT INTO short_volume (symbol, day, short, total) VALUES (?, ?, ?, ?) ON CONFLICT (symbol, day) DO UPDATE SET short = excluded.short, total = excluded.total')
      .bind(sym, day, Math.round(r.short), Math.round(r.total)));
  }
  stmts.push(env.DB.prepare('DELETE FROM short_volume WHERE day < ?').bind(new Date(Date.now() - SHORT_KEEP_DAYS * DAY).toISOString().slice(0, 10)));
  await guarded(batch(env, stmts));
  return json({ ok: true, added: rows.length });
}
