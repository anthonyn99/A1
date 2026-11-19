// Quant refinements R7 (A1-Priv docs/TradeHub/quant/r1-07.md): the data for
// three new cards, from Yahoo (providers/yahoo-session.js; R0 found it matches
// Tony's Webull screenshot exactly on SNDK).
//
//   GET /summary?symbol=X[&fresh=1]  { symbol, src, at, facts: { analysis, stats }, failed? }
//        The Analysis and Key Stats cards. Kept in D1 as the dossier part
//        'yahoo' (no new table) for SUMMARY_TTL; a failure is remembered for
//        FAIL_TTL and answered as { failed } (200), so the page falls back to
//        the dossier's Nasdaq / Finnhub parts at once. At most 3 Yahoo calls.
//   GET /heatmap?symbols=A,B,…       { items: { SYM: { cap, chg, price, t, name } }, asOf, src, missing }
//        The Heat Map: up to HEAT_MAX symbols, one Yahoo call per 170 (+2 for
//        a new session), kept in the edge cache HEAT_LIVE_S in market hours
//        (04:00-20:00 New York) and HEAT_QUIET_S outside. 503 when Yahoo fails.
import { fail, json } from './http.js';
import { Ledger } from './ledger.js';
import { symOf } from './charts.js';
import { ProviderError } from './net.js';
import { marketHours } from './time.js';
import { jsonCache } from './dossier.js';
import * as Y from '../providers/yahoo-session.js';

const HOUR = 3600_000;
export const SUMMARY_TTL = 6 * HOUR, FAIL_TTL = HOUR, HEAT_MAX = 600, HEAT_LIVE_S = 120, HEAT_QUIET_S = 1800;
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
const noTable = (e) => /no such table/i.test(String((e && e.message) || e));

/** GET /summary?symbol=X: Yahoo's analysts, targets and key stats for one symbol. */
export async function getSummary(env, url, ctx, later) {
  const sym = symOf(url.searchParams.get('symbol'));
  if (sym.startsWith('^')) throw fail(400, 'symbol= (a stock or fund) is needed');
  const fresh = url.searchParams.get('fresh') === '1', now = Date.now();
  let row = null;
  try { row = await env.DB.prepare("SELECT at, body, error, err_at FROM dossier_parts WHERE symbol = ? AND part = 'yahoo'").bind(sym).first(); }
  catch (e) { if (!noTable(e)) throw e; }
  const facts = row && row.at > 0 ? parse(row.body) : null;
  if (facts && (now - row.at < SUMMARY_TTL) && !fresh) return json({ ok: true, symbol: sym, src: 'yahoo', at: row.at, facts });
  if (row && row.error && row.err_at && now - row.err_at < FAIL_TTL) {
    return json({ ok: true, symbol: sym, src: 'yahoo', at: facts ? row.at : null, facts, failed: row.error + ' (tried ' + Math.round((now - row.err_at) / 60000) + ' minutes ago)' });
  }
  const L = await Ledger.load(env, now);
  try {
    const f = await Y.summary(L, sym, jsonCache, now);
    await env.DB.prepare("INSERT INTO dossier_parts (symbol, part, at, src, body, error, err_at) VALUES (?, 'yahoo', ?, 'yahoo', ?, NULL, NULL) "
      + 'ON CONFLICT (symbol, part) DO UPDATE SET at = excluded.at, src = excluded.src, body = excluded.body, error = NULL, err_at = NULL').bind(sym, now, JSON.stringify(f)).run().catch((e) => { if (!noTable(e)) throw e; });
    return json({ ok: true, symbol: sym, src: 'yahoo', at: now, facts: f });
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    const why = 'yahoo: ' + e.message;
    await env.DB.prepare("INSERT INTO dossier_parts (symbol, part, at, src, body, error, err_at) VALUES (?, 'yahoo', 0, 'yahoo', '{}', ?, ?) "
      + 'ON CONFLICT (symbol, part) DO UPDATE SET error = excluded.error, err_at = excluded.err_at').bind(sym, why, now).run().catch((x) => { if (!noTable(x)) throw x; });
    // The old facts (if any) still answer, marked with their time; the page says how old they are.
    return json({ ok: true, symbol: sym, src: 'yahoo', at: facts ? row.at : null, facts, failed: why });
  } finally { await later(ctx, L.flush()); }
}

/** A short, stable cache key for a set of symbols (order does not matter). */
async function keyOf(syms) {
  const text = syms.slice().sort().join(',');
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return 'https://quant-api.cache/heatmap/' + [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** GET /heatmap?symbols=…: market cap and the day's change for each, from Yahoo's batch quote. */
export async function getHeatmap(env, url, ctx, later) {
  const syms = [...new Set(String(url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => symOf(s)).filter((s) => !s.startsWith('^')))];
  if (!syms.length) throw fail(400, 'symbols= is needed');
  if (syms.length > HEAT_MAX) throw fail(400, `at most ${HEAT_MAX} symbols a request`);
  const now = Date.now(), key = await keyOf(syms);
  const hit = await jsonCache.get(key);
  if (hit && hit.items) return json({ ok: true, ...hit, cached: true });
  const L = await Ledger.load(env, now);
  try {
    const items = await Y.quoteMany(L, syms, jsonCache);
    if (!Object.keys(items).length) throw fail(503, 'Yahoo answered with no quotes');
    const asOf = Math.max(0, ...Object.values(items).map((x) => x.t || 0)) || now;
    const out = { items, asOf, src: 'yahoo', missing: syms.filter((s) => !items[s]) };
    await jsonCache.put(key, out, marketHours(now) ? HEAT_LIVE_S : HEAT_QUIET_S);
    return json({ ok: true, ...out, cached: false });
  } catch (e) {
    if (e instanceof ProviderError) throw fail(503, 'the heat map needs Yahoo, which did not answer (' + e.message + ')');
    throw e;
  } finally { await later(ctx, L.flush()); }
}
