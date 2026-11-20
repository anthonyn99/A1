// Quant refinements R7 (A1-Priv docs/TradeHub/quant/r1-07.md) and Batch 2 B1 (r2-01.md): the data
// for three cards. Yahoo answers HTTP 406 to Cloudflare (Tony's screenshot, 2026-11-20), so:
//
//   GET /summary?symbol=X[&fresh=1]  { symbol, src, at, facts: { analysis, stats, statSrc? }, failed?, yahoo? }
//        The Analysis and Key Stats cards. Yahoo's quoteSummary first (dossier part 'yahoo',
//        SUMMARY_TTL); when Yahoo fails, rests (FAIL_TTL) or is known down (YAHOO_DOWN_S, any Yahoo
//        failure), the stats come from Nasdaq and Finnhub (providers/nasdaq-stats.js, dossier part
//        'stats', SUMMARY_TTL) with each field's source in `statSrc`; `yahoo` says why Yahoo was not
//        used. Analysis then falls back to the dossier on the page, as before.
//   GET /heatmap?symbols=A,B,…       { items: { SYM: { cap, chg, price, t, name } }, asOf, src, missing }
//        The Heat Map: up to HEAT_MAX symbols. Today's price and change from Alpaca's stock snapshots
//        (200 a call), the share count from Nasdaq's screener (one call a day, providers/screener.js),
//        cap = shares × price. Yahoo's batch quote only when Alpaca fails and Yahoo is not known down.
//        Kept in the edge cache HEAT_LIVE_S in market hours (04:00-20:00 New York), HEAT_QUIET_S outside.
import { fail, json } from './http.js';
import { Ledger } from './ledger.js';
import { symOf } from './charts.js';
import { ProviderError } from './net.js';
import { marketHours } from './time.js';
import { jsonCache } from './dossier.js';
import * as Y from '../providers/yahoo-session.js';
import * as A from '../providers/alpaca.js';
import { shares as screenerShares } from '../providers/screener.js';
import { stats as freeStats } from '../providers/nasdaq-stats.js';

const HOUR = 3600_000;
export const SUMMARY_TTL = 6 * HOUR, FAIL_TTL = HOUR, HEAT_MAX = 600, HEAT_LIVE_S = 120, HEAT_QUIET_S = 1800, YAHOO_DOWN_S = 3600;
/** One flag for every Yahoo route: a Yahoo failure is not tried again for an hour, for any symbol. */
const DOWN_KEY = 'https://quant-api.cache/yahoo-down';
export const yahooDown = async () => { const d = await jsonCache.get(DOWN_KEY); return d && d.why ? d.why : null; };
const markDown = (why) => jsonCache.put(DOWN_KEY, { why, at: Date.now() }, YAHOO_DOWN_S);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
const noTable = (e) => /no such table/i.test(String((e && e.message) || e));

/** GET /summary?symbol=X: Yahoo's analysts, targets and key stats; Nasdaq and Finnhub's stats when Yahoo cannot answer. */
export async function getSummary(env, url, ctx, later) {
  const sym = symOf(url.searchParams.get('symbol'));
  if (sym.startsWith('^')) throw fail(400, 'symbol= (a stock or fund) is needed');
  const fresh = url.searchParams.get('fresh') === '1', now = Date.now();
  let row = null;
  try { row = await env.DB.prepare("SELECT at, body, error, err_at FROM dossier_parts WHERE symbol = ? AND part = 'yahoo'").bind(sym).first(); }
  catch (e) { if (!noTable(e)) throw e; }
  const facts = row && row.at > 0 ? parse(row.body) : null;
  if (facts && (now - row.at < SUMMARY_TTL) && !fresh) return json({ ok: true, symbol: sym, src: 'yahoo', at: row.at, facts });
  // A failure rests an hour (no call), and so does Yahoo itself once it refused anything, unless Tony asks again (fresh=1).
  let why = null;
  if (!fresh && row && row.error && row.err_at && now - row.err_at < FAIL_TTL) why = row.error + ' (tried ' + Math.round((now - row.err_at) / 60000) + ' minutes ago)';
  else if (!fresh) { const down = await yahooDown(); if (down) why = 'yahoo: ' + down + ' (resting for every symbol)'; }
  const L = await Ledger.load(env, now);
  try {
    if (!why) {
      try {
        const f = await Y.summary(L, sym, jsonCache, now);
        await env.DB.prepare("INSERT INTO dossier_parts (symbol, part, at, src, body, error, err_at) VALUES (?, 'yahoo', ?, 'yahoo', ?, NULL, NULL) "
          + 'ON CONFLICT (symbol, part) DO UPDATE SET at = excluded.at, src = excluded.src, body = excluded.body, error = NULL, err_at = NULL').bind(sym, now, JSON.stringify(f)).run().catch((e) => { if (!noTable(e)) throw e; });
        return json({ ok: true, symbol: sym, src: 'yahoo', at: now, facts: f });
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        why = 'yahoo: ' + e.message;
        await env.DB.prepare("INSERT INTO dossier_parts (symbol, part, at, src, body, error, err_at) VALUES (?, 'yahoo', 0, 'yahoo', '{}', ?, ?) "
          + 'ON CONFLICT (symbol, part) DO UPDATE SET error = excluded.error, err_at = excluded.err_at').bind(sym, why, now).run().catch((x) => { if (!noTable(x)) throw x; });
        // A symbol Yahoo does not know says nothing about Yahoo; anything else rests every Yahoo route an hour.
        if (!/HTTP 404/.test(e.message)) await markDown(e.message);
      }
    }
    // B1: the stats from Nasdaq and Finnhub. Yahoo's last analysis (if any) still answers, marked by `failed`.
    const alt = await altStats(env, L, sym, now, fresh);
    if (alt && Object.keys(alt.stats).length) {
      return json({ ok: true, symbol: sym, src: 'nasdaq', at: alt.at, facts: { analysis: facts ? facts.analysis : undefined, stats: alt.stats, statSrc: alt.statSrc }, analysisAt: facts ? row.at : null, failed: why, yahoo: why });
    }
    // The old facts (if any) still answer, marked with their time; the page says how old they are.
    return json({ ok: true, symbol: sym, src: 'yahoo', at: facts ? row.at : null, facts, failed: why });
  } finally { await later(ctx, L.flush()); }
}

/** The free routes' stats for `sym`, kept as dossier part 'stats' for SUMMARY_TTL → { at, stats, statSrc } or null. */
async function altStats(env, L, sym, now, fresh) {
  let row = null;
  try { row = await env.DB.prepare("SELECT at, body FROM dossier_parts WHERE symbol = ? AND part = 'stats'").bind(sym).first(); }
  catch (e) { if (!noTable(e)) throw e; }
  const kept = row && row.at > 0 ? parse(row.body) : null;
  if (kept && !fresh && now - row.at < SUMMARY_TTL) return { at: row.at, ...kept };
  const got = await freeStats(L, env, sym);
  if (!Object.keys(got.stats).length) return kept ? { at: row.at, ...kept } : null;
  await env.DB.prepare("INSERT INTO dossier_parts (symbol, part, at, src, body, error, err_at) VALUES (?, 'stats', ?, 'nasdaq', ?, NULL, NULL) "
    + 'ON CONFLICT (symbol, part) DO UPDATE SET at = excluded.at, src = excluded.src, body = excluded.body, error = NULL, err_at = NULL').bind(sym, now, JSON.stringify(got)).run().catch((e) => { if (!noTable(e)) throw e; });
  return { at: now, ...got };
}

/** A short, stable cache key for a set of symbols (order does not matter). */
async function keyOf(syms) {
  const text = syms.slice().sort().join(',');
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return 'https://quant-api.cache/heatmap/' + [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** GET /heatmap?symbols=…: market cap and the day's change for each (Alpaca × Nasdaq's share counts; Yahoo as a fallback). */
export async function getHeatmap(env, url, ctx, later) {
  const syms = [...new Set(String(url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => symOf(s)).filter((s) => !s.startsWith('^')))];
  if (!syms.length) throw fail(400, 'symbols= is needed');
  if (syms.length > HEAT_MAX) throw fail(400, `at most ${HEAT_MAX} symbols a request`);
  const now = Date.now(), key = await keyOf(syms);
  const hit = await jsonCache.get(key);
  if (hit && hit.items) return json({ ok: true, ...hit, cached: true });
  const L = await Ledger.load(env, now);
  try {
    let items = {}, src = null;
    const why = [];
    if (A.has(env)) {
      try {
        const [snap, sh] = await Promise.all([A.snapshots(L, env, syms), screenerShares(L, jsonCache, now).catch((e) => { why.push('nasdaq: ' + (e.message || e)); return {}; })]);
        for (const s of syms) {
          const x = snap[s];
          if (!x) continue;
          const w = sh[s];
          items[s] = clean({ cap: w ? w.n * x.price : null, chg: x.prev > 0 ? x.price / x.prev - 1 : null, price: x.price, t: x.t, name: w ? w.name : null });
        }
        src = 'alpaca+nasdaq';
        // No share counts (the screener failed): no tile can be sized, so this answer is no answer (never cached).
        if (!Object.values(items).some((x) => x.cap > 0)) { why.push('nasdaq: no share counts'); items = {}; }
      } catch (e) { if (!(e instanceof ProviderError)) throw e; why.push('alpaca: ' + e.message); }
    } else why.push('alpaca: no key');
    if (!Object.keys(items).length) {
      const down = await yahooDown();
      if (down) throw fail(503, `the heat map could not be read (${why.join('; ')}; Yahoo is resting: ${down})`);
      try { items = await Y.quoteMany(L, syms, jsonCache); src = 'yahoo'; }
      catch (e) { if (!(e instanceof ProviderError)) throw e; await markDown(e.message); throw fail(503, `the heat map could not be read (${[...why, 'yahoo: ' + e.message].join('; ')})`); }
      if (!Object.keys(items).length) throw fail(503, 'the heat map could not be read: no source had quotes');
    }
    const asOf = Math.max(0, ...Object.values(items).map((x) => x.t || 0)) || now;
    const out = { items, asOf, src, missing: syms.filter((s) => !items[s]) };
    await jsonCache.put(key, out, marketHours(now) ? HEAT_LIVE_S : HEAT_QUIET_S);
    return json({ ok: true, ...out, cached: false });
  } finally { await later(ctx, L.flush()); }
}
