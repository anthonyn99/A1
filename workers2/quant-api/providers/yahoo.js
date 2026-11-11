// Yahoo Finance (no key). Quotes through the spark batch, bars through the
// chart API. Not sold as real-time: every quote says realtime:false.
//
// Phase 0 found `range=max` returns MONTHLY points, so every chart request
// sends period1/period2. Intraday history is short: 1m for the last 30 days
// (at most 8 days a request), 5m-30m for 60 days, 1h for 730 days.
import { call, noteBad, UA_BROWSER, QUOTE_TIMEOUT, BARS_TIMEOUT } from '../lib/net.js';
import { bar, dailyStamp, mergeBars, unsplit } from '../lib/bars.js';

const BASE = 'https://query1.finance.yahoo.com';
const H = { 'user-agent': UA_BROWSER, accept: 'application/json' };
const INTERVAL = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '1d': '1d' };
const DAY = 86400_000;
/** How far back Yahoo serves each interval, and the most one request may span. */
export const REACH = { '1m': [29 * DAY, 7 * DAY], '5m': [59 * DAY, 59 * DAY], '15m': [59 * DAY, 59 * DAY], '30m': [59 * DAY, 59 * DAY], '1h': [729 * DAY, 729 * DAY] };
/** Yahoo writes class shares with a dash (BRK-B). */
export const ysym = (s) => s.replace(/\./g, '-');

export async function quotes(L, env, syms, now) {
  const out = {};
  for (let i = 0; i < syms.length; i += 20) {
    const chunk = syms.slice(i, i + 20);
    const j = await call(L, 'yahoo', `${BASE}/v7/finance/spark?symbols=${encodeURIComponent(chunk.map(ysym).join(','))}&range=1d&interval=1m&includePrePost=true`, { headers: H, timeout: QUOTE_TIMEOUT });
    const res = (j && j.spark && j.spark.result) || [];
    for (const s of chunk) {
      const r = res.find((x) => x && x.symbol === ysym(s));
      const q = r && r.response && r.response[0];
      if (!q || !q.meta) continue;
      // The last minute bar (pre and after hours included) or the regular price, whichever is newer.
      let price = q.meta.regularMarketPrice, t = (q.meta.regularMarketTime || 0) * 1000;
      const ts = q.timestamp || [], cl = (q.indicators && q.indicators.quote && q.indicators.quote[0] && q.indicators.quote[0].close) || [];
      for (let k = ts.length - 1; k >= 0; k--) {
        if (cl[k] > 0) { if (ts[k] * 1000 > t) { price = cl[k]; t = ts[k] * 1000; } break; }
      }
      if (price > 0 && t > 0) out[s] = { symbol: s, price, t, heard: now, provider: 'yahoo', realtime: false, delayMs: 0 };
    }
  }
  return out;
}

async function chart(L, sym, tf, from, to) {
  const u = `${BASE}/v8/finance/chart/${encodeURIComponent(ysym(sym))}?period1=${Math.floor(from / 1000)}&period2=${Math.ceil(to / 1000)}`
    + `&interval=${INTERVAL[tf]}&includePrePost=true&events=split`;
  const j = await call(L, 'yahoo', u, { headers: H, timeout: BARS_TIMEOUT });
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw noteBad(L, 'yahoo', (j && j.chart && j.chart.error && j.chart.error.description) || 'no chart in the answer');
  const ts = r.timestamp || [], q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i] * 1000;
    const b = bar(tf === '1d' ? dailyStamp(t) : t, q.open && q.open[i], q.high && q.high[i], q.low && q.low[i], q.close && q.close[i], q.volume && q.volume[i]);
    if (b) out.push(b);
  }
  const splits = Object.values((r.events && r.events.splits) || {})
    .map((s) => ({ t: tf === '1d' ? dailyStamp(s.date * 1000) : s.date * 1000, ratio: s.numerator / s.denominator }))
    .filter((s) => s.ratio > 0 && Number.isFinite(s.ratio));
  return { bars: out, splits };
}

/** Bars of a base timeframe. Yahoo's prices are split-adjusted; raw (adj
 *  false) multiplies back the splits it reports. `clipped` says the range
 *  asked for reached past what Yahoo keeps. */
export async function bars(L, env, sym, tf, from, to, adj, now) {
  if (!INTERVAL[tf]) return null;
  let clipped = false;
  const reach = REACH[tf];
  if (reach && from < now - reach[0]) { from = now - reach[0]; clipped = true; }
  if (from > to) return Object.assign([], { clipped });
  const step = reach ? reach[1] : Infinity;
  const parts = [], splits = [];
  for (let a = from; a <= to; a += step) {
    const p = await chart(L, sym, tf, a, Math.min(to, a + step));
    parts.push(p.bars); splits.push(...p.splits);
  }
  const all = mergeBars(...parts);
  return Object.assign(adj ? all : unsplit(all, splits), { clipped });
}
