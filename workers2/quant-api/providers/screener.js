// Share counts for the heat map (Refinements Batch 2, B1; A1-Priv docs/TradeHub/quant/r2-01.md).
// Nasdaq's stock screener answers every US stock in ONE call (no key): 502 of the S&P 500's 503
// (B0, 2026-11-20). Its prices are the previous close and its market caps break across a split
// (SNDK read $967 B: pre-split price × post-split shares), so only the SHARE COUNT is kept:
// shares = its cap ÷ its price. The heat map multiplies that by today's price.
//
//   shares(L, cache, now) → { SYM: { n, name } }   1 call a day (edge cache WEIGHTS_S)
import { call, noteBad, UA_BROWSER } from '../lib/net.js';

const URL = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true';
const KEY = 'https://quant-api.cache/screener-shares-v1';
export const WEIGHTS_S = 86_400;
const num = (x) => { const v = Number(String(x == null ? '' : x).replace(/[$,%\s]/g, '')); return Number.isFinite(v) ? v : null; };
/** Nasdaq writes class shares BRK/B (and sometimes BRK^B); everyone else here writes BRK.B. */
export const symOfNasdaq = (s) => String(s || '').trim().toUpperCase().replace(/[/^]/g, '.');

/** The screener's rows → { SYM: { n: shares, name } } (rows without a cap or price are left out). */
export function sharesFrom(rows) {
  const out = {};
  for (const r of rows || []) {
    const s = symOfNasdaq(r.symbol), cap = num(r.marketCap), px = num(r.lastsale);
    if (!s || !(cap > 0) || !(px > 0)) continue;
    out[s] = { n: Math.round(cap / px), name: String(r.name || '').replace(/\s+(Common Stock|Class [A-Z] Common Stock|Ordinary Shares|American Depositary Shares).*$/i, '').slice(0, 60) };
  }
  return out;
}

export async function shares(L, cache, now = Date.now()) {
  const hit = cache && await cache.get(KEY);
  if (hit && hit.at && now - hit.at < WEIGHTS_S * 1000 && hit.map) return hit.map;
  const j = await call(L, 'nasdaq', URL, { headers: { 'user-agent': UA_BROWSER, accept: 'application/json' }, timeout: 15000 });
  const rows = j && j.data && (j.data.rows || (j.data.table && j.data.table.rows));
  if (!Array.isArray(rows) || !rows.length) throw noteBad(L, 'nasdaq', 'the screener had no rows');
  const map = sharesFrom(rows);
  if (cache) await cache.put(KEY, { at: now, map }, WEIGHTS_S);
  return map;
}
