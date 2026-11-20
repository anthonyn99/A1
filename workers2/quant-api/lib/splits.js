// Stock splits from the sources, applied wherever bars are still on the old share basis
// (Tony 2026-11-20: SNDK's 8-for-1 went ex that morning; Alpaca's history was still raw at the open, so
// the chart showed ~$800 bars next to $80 live prices, and the levels came out of the new ones).
//
//   getSplits(L, env, sym, now) → [{ t, ratio, ex }]   t = 00:00 New York on the ex-date, ratio = new
//                                   shares per old (8 for an 8-for-1, 0.1 for a 1-for-10). Alpaca's
//                                   corporate actions first, Yahoo's split events if Alpaca has no key or
//                                   fails. Edge-cached 6 h (Cache API, no KV); [] when neither answers.
//   resplit(bars, splits)        → bars with every bar before an ex-date divided by its ratio, but ONLY
//                                   where the seam still shows the unadjusted jump (the last close before
//                                   the ex-date over the first open after it ≈ the ratio). Bars a provider
//                                   already adjusted show no jump and pass untouched, so a split is never
//                                   applied twice. A range that ends before the ex-date has no seam: left as
//                                   the provider sent it.
import { call, ProviderError, UA_BROWSER } from './net.js';
import { nyMidnight, nyDate } from './time.js';
import * as yahooP from '../providers/yahoo.js';

export const SPLIT_TOL = 0.3, SPLITS_TTL_S = 6 * 3600, SPLITS_BACK_DAYS = 3 * 365, SEAM_BACK_MS = 5 * 86_400_000, SEAM_FIT = 0.06;
const DAY = 86_400_000;

/** Alpaca's v1 corporate actions → [{ ex, ratio }]. */
export function fromAlpaca(j, sym) {
  const ca = (j && j.corporate_actions) || {};
  return [...(ca.forward_splits || []), ...(ca.reverse_splits || [])]
    .filter((s) => s && (!s.symbol || String(s.symbol).toUpperCase() === sym) && s.ex_date && s.new_rate > 0 && s.old_rate > 0)
    .map((s) => ({ ex: String(s.ex_date).slice(0, 10), ratio: s.new_rate / s.old_rate }));
}
/** Yahoo's chart events → [{ ex, ratio }]. */
export function fromYahoo(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  return Object.values((r && r.events && r.events.splits) || {})
    .filter((s) => s && s.date && s.numerator > 0 && s.denominator > 0)
    .map((s) => ({ ex: nyDate(s.date * 1000), ratio: s.numerator / s.denominator }));
}
const shape = (list) => {
  const seen = new Map();
  for (const s of list) if (Number.isFinite(s.ratio) && s.ratio > 0 && Math.abs(s.ratio - 1) > 1e-9 && /^\d{4}-\d{2}-\d{2}$/.test(s.ex)) seen.set(s.ex, s);
  return [...seen.values()].sort((a, b) => (a.ex < b.ex ? -1 : 1)).map((s) => ({ t: nyMidnight(s.ex), ratio: s.ratio, ex: s.ex }));
};

export async function getSplits(L, env, sym, now = Date.now(), { cache = globalThis.caches && globalThis.caches.default } = {}) {
  sym = String(sym || '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) return [];
  const key = `https://quant-api.cache/splits?s=${encodeURIComponent(sym)}&d=${nyDate(now)}`;
  if (cache) { try { const hit = await cache.match(key); if (hit) return await hit.json(); } catch (e) { /* ask again */ } }
  const start = nyDate(now - SPLITS_BACK_DAYS * DAY), end = nyDate(now + 30 * DAY);
  let list = null;
  if (env.ALPACA_KEY && env.ALPACA_SECRET) {
    try {
      const j = await call(L, 'alpaca', `https://data.alpaca.markets/v1/corporate-actions?symbols=${encodeURIComponent(sym)}&types=forward_split,reverse_split&start=${start}&end=${end}&limit=1000`,
        { headers: { 'APCA-API-KEY-ID': env.ALPACA_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET, accept: 'application/json' } });
      list = fromAlpaca(j, sym);
    } catch (e) { if (!(e instanceof ProviderError)) throw e; }
  }
  if (!list) {
    try {
      const j = await call(L, 'yahoo', `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooP.ysym(sym))}?period1=${Math.floor((now - SPLITS_BACK_DAYS * DAY) / 1000)}&period2=${Math.ceil(now / 1000)}&interval=1d&events=split`,
        { headers: { 'user-agent': UA_BROWSER, accept: 'application/json' } });
      list = fromYahoo(j);
    } catch (e) { if (!(e instanceof ProviderError)) throw e; return []; }
  }
  const out = shape(list);
  if (cache) { try { await cache.put(key, new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=' + SPLITS_TTL_S } })); } catch (e) { /* fine */ } }
  return out;
}

export function resplit(bars, splits) {
  if (!Array.isArray(bars) || bars.length < 2 || !splits || !splits.length) return bars;
  let out = bars;
  // Newest first: an older split's seam is then compared on bars already on one basis.
  for (const s of [...splits].sort((a, b) => b.t - a.t)) {
    if (!(s.ratio > 0) || Math.abs(s.ratio - 1) < 1e-9) continue;
    // B3 (Tony's SNDK, 2026-11-20 13:29): the unadjusted jump is not always AT the ex-date (Alpaca sent Nov 19 on
    // the new basis and Nov 17-18 raw). The ex-date's own seam first, as before; only when it shows no jump, the
    // boundary in the SEAM_BACK_MS before it that matches the ratio best, and only a clearly split-sized one
    // (within SEAM_FIT in log terms, and over half the split's size: an earnings gap or a flat day never is).
    const k = out.findIndex((b) => b.t >= s.t), gap = (j) => { const b0 = out[j - 1].c, a = out[j].o > 0 ? out[j].o : out[j].c; return b0 > 0 && a > 0 ? b0 / a : null; };
    let i = k > 0 && gap(k) && Math.abs(gap(k) / s.ratio - 1) <= SPLIT_TOL ? k : -1;
    if (i < 0) {
      let best = SEAM_FIT;
      for (let j = 1; j < out.length && out[j].t < s.t; j++) {
        if (out[j].t < s.t - SEAM_BACK_MS) continue;
        const g = gap(j); if (!g) continue;
        const err = Math.abs(Math.log(g) - Math.log(s.ratio));
        if (err < best && Math.abs(Math.log(g)) > Math.abs(Math.log(s.ratio)) / 2) { best = err; i = j; }
      }
    }
    if (i <= 0) continue;   // no unadjusted jump at or before the ex-date: already adjusted (or no seam held)
    const r = s.ratio;
    out = out.map((b, k) => (k >= i ? b : { ...b, o: b.o / r, h: b.h / r, l: b.l / r, c: b.c / r, v: Math.round(b.v * r) }));
  }
  return out;
}
