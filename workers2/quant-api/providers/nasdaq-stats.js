// Key Stats when Yahoo refuses (Refinements Batch 2, B1; A1-Priv docs/TradeHub/quant/r2-01.md).
// Yahoo answers HTTP 406 to Cloudflare, so the card's Yahoo-only fields come from free routes here:
//   Nasdaq quote/{SYM}/summary          market cap, dividend, ex-dividend, yield, day range, previous close, 52 weeks
//   Nasdaq quote/{SYM}/info             the price (shares = cap ÷ price)
//   Nasdaq analyst/{SYM}/earnings-forecast  P/E (FWD) = price ÷ the next four quarters' consensus EPS
//   Nasdaq quote/{SYM}/short-interest   short interest, as a share of shares outstanding (no free float)
//   Finnhub stock/metric                P/E, P/S, EPS, beta, P/B, BPS
// → { stats, statSrc }: the same field names as Yahoo's (providers/yahoo-session.js summaryFacts), and the
//   source of each. A route that fails leaves its fields out; nothing is guessed.
import { call, UA_BROWSER } from '../lib/net.js';
import * as F from './fundamentals.js';

const NQ = 'https://api.nasdaq.com/api';
const H = { 'user-agent': UA_BROWSER, accept: 'application/json' };
const enc = encodeURIComponent;
const num = (x) => { if (x == null) return null; const v = Number(String(x).replace(/[$,%\s]/g, '')); return String(x).trim() && Number.isFinite(v) ? v : null; };
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
/** "Oct 14, 2026" → "2026-10-14". */
export function ymdOf(text) {
  const m = /([A-Z][a-z]{2})\w* (\d{1,2}), (\d{4})/.exec(String(text || ''));
  return m && MONTHS[m[1]] ? `${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}
/** "$668.99/$599.15" → [668.99, 599.15]. */
const pair = (text) => String(text || '').split('/').map(num);

/** Nasdaq's four answers and Finnhub's metric → { stats, statSrc } (pure: the tests feed it). */
export function statsFrom({ summary, info, forecast, short, metric } = {}) {
  const stats = {}, statSrc = {};
  const put = (k, v, src) => { if (v != null && Number.isFinite(v) || (typeof v === 'string' && v)) { stats[k] = v; statSrc[k] = src; } };
  const sd = summary && summary.summaryData;
  const val = (k) => (sd && sd[k] ? sd[k].value : null);
  const price = num(info && info.primaryData && info.primaryData.lastSalePrice);
  if (sd) {
    put('marketCap', num(val('MarketCap')), 'nasdaq');
    put('prevClose', num(val('PreviousClose')), 'nasdaq');
    const [dh, dl] = pair(val('TodayHighLow')); put('dayHigh', dh, 'nasdaq'); put('dayLow', dl, 'nasdaq');
    const [hi, lo] = pair(val('FiftTwoWeekHighLow') || val('FiftyTwoWeekHighLow')); put('high52', hi, 'nasdaq'); put('low52', lo, 'nasdaq');
    put('divRate', num(val('AnnualizedDividend')), 'nasdaq');
    const y = num(val('Yield')); put('divYield', y == null ? null : y / 100, 'nasdaq');
    put('exDiv', ymdOf(val('ExDividendDate')), 'nasdaq');
  }
  if (stats.marketCap > 0 && price > 0) put('shares', Math.round(stats.marketCap / price), 'computed');
  const rows = forecast && forecast.quarterlyForecast && forecast.quarterlyForecast.rows;
  if (Array.isArray(rows) && rows.length >= 4 && price > 0) {
    const next4 = rows.slice(0, 4).map((r) => num(r.consensusEPSForecast));
    if (next4.every((x) => x != null)) { const eps = next4.reduce((a, b) => a + b, 0); if (eps > 0) { put('epsFwd', eps, 'nasdaq'); put('peFwd', price / eps, 'computed'); } }
  }
  const sRows = short && short.shortInterestTable && short.shortInterestTable.rows;
  const si = Array.isArray(sRows) && sRows.length ? num(sRows[0].interest) : null;
  if (si != null && stats.shares > 0) { put('shortShares', si, 'nasdaq'); put('shortFloat', si / stats.shares, 'computed'); }
  if (metric) {
    put('peTtm', metric.pe, 'finnhub'); put('ps', metric.ps, 'finnhub'); put('epsTtm', metric.eps, 'finnhub'); put('beta', metric.beta, 'finnhub');
    put('pb', metric.pb, 'finnhub'); put('bps', metric.bps, 'finnhub');
    if (stats.high52 == null) put('high52', metric.high52, 'finnhub');
    if (stats.low52 == null) put('low52', metric.low52, 'finnhub');
    if (stats.marketCap == null) put('marketCap', metric.marketCap, 'finnhub');
  }
  return { stats, statSrc };
}

/** One symbol's stats from the free routes (≤ 5 calls). Each route that fails is left out. */
export async function stats(L, env, sym) {
  const get = (path) => call(L, 'nasdaq', `${NQ}/${path}`, { headers: H }).then((j) => (j && j.data) || null).catch(() => null);
  const [summary, info, forecast, short, metric] = await Promise.all([
    get(`quote/${enc(sym)}/summary?assetclass=stocks`), get(`quote/${enc(sym)}/info?assetclass=stocks`),
    get(`analyst/${enc(sym)}/earnings-forecast`), get(`quote/${enc(sym)}/short-interest?assetClass=stocks`),
    env.FINNHUB_KEY ? F.metric(L, env, sym).catch(() => null) : Promise.resolve(null),
  ]);
  return statsFrom({ summary, info, forecast, short, metric });
}
