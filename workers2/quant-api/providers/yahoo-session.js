// Yahoo's signed-in-as-a-browser routes (Quant refinements R7, A1-Priv
// docs/TradeHub/quant/r1-07.md): quoteSummary (analysts, targets, key stats)
// and the v7 batch quote (market cap and the day's change, ~170 symbols a
// call) need Yahoo's A3 cookie and a "crumb" read with it. No key, no account.
//
//   session(L, cache, fresh)  → { cookie, crumb }   2 calls when not cached (fc.yahoo.com, getcrumb);
//                                                    kept in the edge cache SESSION_S seconds
//   summary(L, sym, cache)    → { analysis, stats }  1 call (+2 for a new session)
//   quoteMany(L, syms, cache) → { SYM: { cap, chg, price, t, name } }   one call per QUOTE_CHUNK symbols
//
// A refused crumb (401 / 403) is read again once, then the call fails as a
// ProviderError like any other source (the page falls back to Nasdaq / Finnhub).
// Ledger line `yahoo-crumb` (lib/ledger.js CAPS), apart from `yahoo`: a refusal here
// (Yahoo blocking a route, an unknown symbol) never puts the bars chain in its skip window.
import { call as call0, noteBad as noteBad0, ProviderError, UA_BROWSER, BARS_TIMEOUT } from '../lib/net.js';
import { ysym } from './yahoo.js';

export const SESSION_S = 6 * 3600, QUOTE_CHUNK = 170;
export const MODULES = 'price,summaryDetail,defaultKeyStatistics,financialData,recommendationTrend,calendarEvents,upgradeDowngradeHistory';
const Q2 = 'https://query2.finance.yahoo.com';
const SESSION_KEY = 'https://quant-api.cache/yahoo-session';
const H = { 'user-agent': UA_BROWSER, accept: 'application/json' };
const enc = encodeURIComponent;
export const PROVIDER = 'yahoo-crumb';
const call = (L, _p, url, o) => call0(L, PROVIDER, url, o);
const noteBad = (L, _p, msg) => noteBad0(L, PROVIDER, msg);

const setCookies = (headers) => (headers.getSetCookie ? headers.getSetCookie() : headers.getAll ? headers.getAll('set-cookie') : [headers.get('set-cookie')]).filter(Boolean);

/** A cookie and crumb: from the edge cache, else read now (fc.yahoo.com answers 404 with the cookie: that is expected). */
export async function session(L, cache, fresh = false) {
  if (!fresh && cache) { const s = await cache.get(SESSION_KEY); if (s && s.cookie && s.crumb) return s; }
  const why = L.blocked(PROVIDER);
  if (why) throw new ProviderError(PROVIDER, why);
  if (!L.spend(PROVIDER, 1)) throw new ProviderError(PROVIDER, 'at its daily cap');
  let cookie = '';
  try {
    const r = await fetch('https://fc.yahoo.com/', { redirect: 'manual', headers: { 'user-agent': UA_BROWSER }, signal: AbortSignal.timeout(BARS_TIMEOUT) });
    cookie = setCookies(r.headers).map((c) => c.split(';')[0]).filter((c) => /^A[13S]?=/.test(c)).join('; ');
  } catch (e) { L.note(PROVIDER, false, null, null, 'cookie: ' + (e.message || e)); throw new ProviderError(PROVIDER, 'no cookie (' + (e.message || e) + ')'); }
  if (!cookie) throw noteBad(L, 'yahoo', 'Yahoo sent no cookie');
  const crumb = String(await call(L, 'yahoo', `${Q2}/v1/test/getcrumb`, { headers: { ...H, cookie }, text: true, timeout: BARS_TIMEOUT }) || '').trim();
  if (!crumb || crumb.length > 40 || /[<{\s]/.test(crumb)) throw noteBad(L, 'yahoo', 'Yahoo sent no crumb');
  const s = { cookie, crumb };
  if (cache) await cache.put(SESSION_KEY, s, SESSION_S);
  return s;
}

/** A crumb route, read once more with a new session when Yahoo refuses the old one. */
async function signed(L, cache, path) {
  let s = await session(L, cache);
  try { return await call(L, 'yahoo', `${Q2}${path}${path.includes('?') ? '&' : '?'}crumb=${enc(s.crumb)}`, { headers: { ...H, cookie: s.cookie }, timeout: BARS_TIMEOUT }); }
  catch (e) {
    if (!(e instanceof ProviderError) || (e.status !== 401 && e.status !== 403)) throw e;
    s = await session(L, cache, true);
    return call(L, 'yahoo', `${Q2}${path}${path.includes('?') ? '&' : '?'}crumb=${enc(s.crumb)}`, { headers: { ...H, cookie: s.cookie }, timeout: BARS_TIMEOUT });
  }
}

const raw = (x) => (x && typeof x === 'object' ? (Number.isFinite(x.raw) ? x.raw : null) : Number.isFinite(x) ? x : null);
const ymd = (sec) => (Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString().slice(0, 10) : null);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/** quoteSummary's modules → the Analysis card's facts and the Key Stats card's (plain numbers, YYYY-MM-DD dates). */
export function summaryFacts(x, now = Date.now()) {
  const fd = x.financialData || {}, sd = x.summaryDetail || {}, ks = x.defaultKeyStatistics || {}, pr = x.price || {}, ce = (x.calendarEvents || {}).earnings || {};
  const trend = ((x.recommendationTrend || {}).trend || []).map((t) => ({ period: t.period, strongBuy: t.strongBuy | 0, buy: t.buy | 0, hold: t.hold | 0, sell: t.sell | 0, strongSell: t.strongSell | 0 }));
  const upgrades = (((x.upgradeDowngradeHistory || {}).history) || []).slice(0, 8).map((u) => clean({ day: ymd(u.epochGradeDate), firm: u.firm, to: u.toGrade, from: u.fromGrade, action: u.action, target: u.currentPriceTarget > 0 ? u.currentPriceTarget : null }));
  const dates = (ce.earningsDate || []).map((d) => ymd(raw(d))).filter(Boolean);
  const today = new Date(now).toISOString().slice(0, 10);
  const analysis = clean({
    targetHigh: raw(fd.targetHighPrice), targetMean: raw(fd.targetMeanPrice), targetMedian: raw(fd.targetMedianPrice), targetLow: raw(fd.targetLowPrice),
    analysts: raw(fd.numberOfAnalystOpinions), recKey: fd.recommendationKey && fd.recommendationKey !== 'none' ? fd.recommendationKey : null, recMean: raw(fd.recommendationMean),
    trend: trend.length ? trend : null, upgrades: upgrades.length ? upgrades : null, price: raw(pr.regularMarketPrice) ?? raw(fd.currentPrice),
  });
  const stats = clean({
    open: raw(sd.open) ?? raw(pr.regularMarketOpen), prevClose: raw(sd.previousClose) ?? raw(pr.regularMarketPreviousClose),
    dayHigh: raw(sd.dayHigh) ?? raw(pr.regularMarketDayHigh), dayLow: raw(sd.dayLow) ?? raw(pr.regularMarketDayLow),
    volume: raw(sd.volume) ?? raw(pr.regularMarketVolume), avgVol3m: raw(pr.averageDailyVolume3Month) ?? raw(sd.averageVolume), avgVol10d: raw(sd.averageVolume10days),
    high52: raw(sd.fiftyTwoWeekHigh), low52: raw(sd.fiftyTwoWeekLow), marketCap: raw(sd.marketCap) ?? raw(pr.marketCap),
    peTtm: raw(sd.trailingPE), peFwd: raw(sd.forwardPE) ?? raw(ks.forwardPE), pb: raw(ks.priceToBook), ps: raw(sd.priceToSalesTrailing12Months),
    epsTtm: raw(ks.trailingEps), epsFwd: raw(ks.forwardEps), bps: raw(ks.bookValue), beta: raw(sd.beta) ?? raw(ks.beta),
    divRate: raw(sd.dividendRate), divYield: raw(sd.dividendYield), exDiv: ymd(raw(sd.exDividendDate)),
    shares: raw(ks.sharesOutstanding), float: raw(ks.floatShares), shortFloat: raw(ks.shortPercentOfFloat),
    nextEarnings: dates.find((d) => d >= today) || null, lastEarnings: dates.filter((d) => d < today).pop() || null, earningsEstimate: ce.isEarningsDateEstimate === true ? true : null,
    epsEstimate: raw(ce.earningsAverage), exchange: pr.exchangeName || null, name: pr.longName || pr.shortName || null, currency: pr.currency || null,
    priceAt: Number.isFinite(pr.regularMarketTime) ? pr.regularMarketTime * 1000 : null,
  });
  return { analysis, stats };
}

/** One symbol's quoteSummary → { analysis, stats }. */
export async function summary(L, sym, cache, now = Date.now()) {
  const j = await signed(L, cache, `/v10/finance/quoteSummary/${enc(ysym(sym))}?modules=${MODULES}`);
  const x = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
  if (!x) throw noteBad(L, 'yahoo', 'quoteSummary had nothing for ' + sym);
  return summaryFacts(x, now);
}

/** Many symbols' market cap and day change (v7 quote, QUOTE_CHUNK a call). Symbols Yahoo does not know are left out. */
export async function quoteMany(L, syms, cache) {
  const out = {};
  for (let i = 0; i < syms.length; i += QUOTE_CHUNK) {
    const chunk = syms.slice(i, i + QUOTE_CHUNK), back = new Map(chunk.map((s) => [ysym(s), s]));
    const j = await signed(L, cache, `/v7/finance/quote?symbols=${enc(chunk.map(ysym).join(','))}&fields=symbol,marketCap,regularMarketChangePercent,regularMarketPrice,regularMarketTime,shortName`);
    for (const r of (j && j.quoteResponse && j.quoteResponse.result) || []) {
      const s = back.get(r.symbol);
      if (!s || !Number.isFinite(r.regularMarketPrice)) continue;
      out[s] = clean({ cap: Number.isFinite(r.marketCap) ? r.marketCap : null, chg: Number.isFinite(r.regularMarketChangePercent) ? r.regularMarketChangePercent / 100 : null,
        price: r.regularMarketPrice, t: Number.isFinite(r.regularMarketTime) ? r.regularMarketTime * 1000 : null, name: r.shortName || null });
    }
  }
  return out;
}
