// CBOE's delayed option chain (15 minutes, no key), A1-Priv
// docs/TradeHub/quant/phase-13.md "Options". One call returns every contract of
// a symbol with its IV and greeks (AAPL ≈ 1.5 MB, SPY ≈ 5.6 MB); it is cut down
// here to the compact form A1-Priv TradeHub/core/options.js reads:
//   { symbol, spot, iv30, at, delayed: true,
//     expiries: [{ exp, c: [[k, bid, ask, iv, oi, vol, delta, gamma]…], p: […] }] }
// Index symbols (SPX, VIX…) are not asked: their chains are 10+ MB.
import { call, noteBad, ProviderError } from '../lib/net.js';

export const URL_OF = (sym) => `https://cdn-api.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`;
export const MAX_DAYS = 120, MAX_EXPIRIES = 10, BAND = 0.3, TIMEOUT = 15000;
export const canAsk = (s) => /^[A-Z][A-Z.]{0,5}$/.test(s);
const OCC = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const DAY = 86_400_000;
const n4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

/** "AAPL261116C00275000" → { root, exp: '2026-11-16', type: 'C', k: 275 } or null. */
export function parseOcc(s) {
  const m = OCC.exec(String(s || ''));
  return m ? { root: m[1], exp: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5], k: Number(m[6]) / 1000 } : null;
}

/** CBOE's JSON → the compact chain: expiries within 120 days (at most 10),
 *  strikes within ±30% of spot, each side sorted by strike. */
export function compactChain(j, now = Date.now()) {
  const d = j && j.data;
  const spot = d && Number(d.current_price);
  if (!d || !Array.isArray(d.options) || !(spot > 0)) return null;
  const by = new Map(), lo = spot * (1 - BAND), hi = spot * (1 + BAND);
  const today = new Date(now - 5 * 3_600_000).toISOString().slice(0, 10), last = new Date(now + MAX_DAYS * DAY).toISOString().slice(0, 10);
  for (const o of d.options) {
    const p = parseOcc(o && o.option);
    if (!p || p.exp < today || p.exp > last || p.k < lo || p.k > hi) continue;
    let e = by.get(p.exp);
    if (!e) by.set(p.exp, (e = { exp: p.exp, c: [], p: [] }));
    (p.type === 'C' ? e.c : e.p).push([p.k, n4(o.bid), n4(o.ask), n4(o.iv), o.open_interest | 0, o.volume | 0, n4(o.delta), n4(o.gamma)]);
  }
  const expiries = [...by.values()].sort((a, b) => (a.exp < b.exp ? -1 : 1)).slice(0, MAX_EXPIRIES);
  for (const e of expiries) { e.c.sort((a, b) => a[0] - b[0]); e.p.sort((a, b) => a[0] - b[0]); }
  const iv30 = Number(d.iv30);
  return { symbol: String(d.symbol || '').replace(/^_/, ''), spot, iv30: iv30 > 0 ? iv30 / 100 : null, at: now, delayed: true, expiries };
}

/** Fetch and compact one symbol's chain (one CBOE call through the ledger). */
export async function chain(L, sym, now = Date.now()) {
  if (!canAsk(sym)) throw new ProviderError('cboe', 'not a symbol CBOE lists options for here');
  const j = await call(L, 'cboe', URL_OF(sym), { timeout: TIMEOUT });
  const c = compactChain(j, now);
  if (!c || !c.expiries.length) throw noteBad(L, 'cboe', 'no options in the chain');
  return c;
}
