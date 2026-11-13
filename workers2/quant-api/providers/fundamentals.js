// The ticker dossier's sources (A1-Priv docs/TradeHub/quant/phase-07.md).
// Each part is one call to one source, turned into plain facts `{ name: value }`
// (fractions for margins and growth, dollars for money, YYYY-MM-DD for dates).
// The page merges the parts and marks disagreements (A1-Priv TradeHub/data/dossier.js).
//
//   part           source                                    call
//   metric         Finnhub stock/metric (basic financials)   1
//   recommendation Finnhub stock/recommendation              1
//   surprises      Finnhub stock/earnings                    1
//   calendar       Finnhub calendar/earnings                 1  (+1 Nasdaq earnings date when Finnhub has none)
//   insiders       Finnhub stock/insider-transactions        1
//   target         Nasdaq analyst target price + counts      1  (+1 Alpha Vantage OVERVIEW when Nasdaq fails and its key is set)
//   estimates      Nasdaq estimate momentum (revisions)      1
//   sec            SEC company facts (annual 10-K numbers)   1  (+1 the SEC ticker map when the CIK is not given; edge-cached a week)
//
// Finnhub's price target and candles are PAID (Phase 0 found 403): no URL for
// either exists in this file, and a test fails if one appears.
import { call, noteBad, BARS_TIMEOUT } from '../lib/net.js';

const FH = 'https://finnhub.io/api/v1';
const NQ = 'https://api.nasdaq.com/api/analyst';
export const SEC_UA = 'TradeHub personal research (quant-api worker)';
const NQ_HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', accept: 'application/json' };
const DAY = 86_400_000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null);
/** The first of `names` that `o` has as a finite number. */
const pick = (o, ...names) => { for (const n of names) { const v = num(o && o[n]); if (v != null) return v; } return null; };
const pct = (x) => (x == null ? null : x / 100);
const enc = encodeURIComponent;

/* ── Finnhub ─────────────────────────────────────────────────────────────── */
const fh = (L, env, path) => call(L, 'finnhub', `${FH}/${path}${path.includes('?') ? '&' : '?'}token=${enc(env.FINNHUB_KEY)}`);

/** stock/metric → the company's numbers, and its 5-year P/E and P/S history (quarterly). */
export async function metric(L, env, sym) {
  const j = await fh(L, env, `stock/metric?symbol=${enc(sym)}&metric=all`);
  const m = j && j.metric;
  if (!m || !Object.keys(m).length) throw noteBad(L, 'finnhub', 'no metrics for ' + sym);
  const hist = (key) => {
    const s = j.series && j.series.quarterly && j.series.quarterly[key];
    return Array.isArray(s) ? s.filter((x) => x && num(x.v) != null && x.period).slice(0, 20).map((x) => ({ d: String(x.period).slice(0, 10), v: num(x.v) })).reverse() : null;
  };
  const cap = pick(m, 'marketCapitalization');
  return {
    high52: pick(m, '52WeekHigh'), low52: pick(m, '52WeekLow'), beta: pick(m, 'beta'),
    marketCap: cap == null ? null : cap * 1e6,
    pe: pick(m, 'peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM'),
    ps: pick(m, 'psTTM'),
    eps: pick(m, 'epsTTM', 'epsBasicExclExtraItemsTTM', 'epsExclExtraItemsTTM'),
    epsFy: pick(m, 'epsAnnual', 'epsBasicExclExtraItemsAnnual', 'epsExclExtraItemsAnnual'),
    grossMargin: pct(pick(m, 'grossMarginTTM')), grossMarginFy: pct(pick(m, 'grossMarginAnnual')),
    operatingMargin: pct(pick(m, 'operatingMarginTTM')), operatingMarginFy: pct(pick(m, 'operatingMarginAnnual')),
    netMargin: pct(pick(m, 'netProfitMarginTTM')), netMarginFy: pct(pick(m, 'netProfitMarginAnnual')),
    roe: pct(pick(m, 'roeTTM', 'roeRfy')),
    revGrowth3y: pct(pick(m, 'revenueGrowth3Y')), epsGrowth3y: pct(pick(m, 'epsGrowth3Y')),
    revGrowthYoy: pct(pick(m, 'revenueGrowthTTMYoy')),
    dividendYield: pct(pick(m, 'currentDividendYieldTTM', 'dividendYieldIndicatedAnnual')),
    payoutRatio: pct(pick(m, 'payoutRatioTTM', 'payoutRatioAnnual')),
    peHist: hist('pe'), psHist: hist('ps'),
  };
}

/** stock/recommendation → the newest month's counts and the trend against three months before. */
export async function recommendation(L, env, sym) {
  const j = await fh(L, env, `stock/recommendation?symbol=${enc(sym)}`);
  if (!Array.isArray(j) || !j.length) return { ratings: null };
  const rows = j.slice().sort((a, b) => String(b.period).localeCompare(String(a.period)));
  const of = (r) => ({ buy: (num(r.strongBuy) || 0) + (num(r.buy) || 0), hold: num(r.hold) || 0, sell: (num(r.sell) || 0) + (num(r.strongSell) || 0), period: String(r.period).slice(0, 10) });
  const now = of(rows[0]), then = rows[3] ? of(rows[3]) : null;
  const share = (x) => (x.buy + x.hold + x.sell ? x.buy / (x.buy + x.hold + x.sell) : null);
  let trend = null;
  if (then && share(now) != null && share(then) != null) { const d = share(now) - share(then); trend = d > 0.05 ? 'up' : d < -0.05 ? 'down' : 'flat'; }
  return { ratings: now, ratingTrend: trend };
}

/** stock/earnings → the last four quarters' surprises, newest first. */
export async function surprises(L, env, sym) {
  const j = await fh(L, env, `stock/earnings?symbol=${enc(sym)}`);
  const list = (Array.isArray(j) ? j : []).filter((r) => r && num(r.actual) != null).slice(0, 4)
    .map((r) => ({ period: String(r.period).slice(0, 10), actual: num(r.actual), estimate: num(r.estimate), surprisePct: pct(num(r.surprisePercent)) }));
  return { surprises: list.length ? list : null };
}

/** calendar/earnings for the next 120 days → the next report's date and time. */
export async function calendar(L, env, sym, now) {
  const j = await fh(L, env, `calendar/earnings?from=${ymd(now)}&to=${ymd(now + 120 * DAY)}&symbol=${enc(sym)}`);
  const rows = ((j && j.earningsCalendar) || []).filter((r) => r && r.date && r.symbol === sym).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!rows.length) return { nextEarnings: null };
  const r = rows[0];
  return { nextEarnings: String(r.date).slice(0, 10), earningsTime: r.hour === 'bmo' ? 'before the open' : r.hour === 'amc' ? 'after the close' : null, epsEstimate: num(r.epsEstimate) };
}

/** stock/insider-transactions for 90 days → buys and sells (open-market, codes P and S) by value. */
export async function insiders(L, env, sym, now) {
  const j = await fh(L, env, `stock/insider-transactions?symbol=${enc(sym)}&from=${ymd(now - 90 * DAY)}&to=${ymd(now)}`);
  const rows = ((j && j.data) || []).filter((r) => r && (r.transactionCode === 'P' || r.transactionCode === 'S'));
  let buyValue = 0, sellValue = 0, buys = 0, sells = 0;
  for (const r of rows) {
    const v = Math.abs(num(r.change) || 0) * (num(r.transactionPrice) || 0);
    if (r.transactionCode === 'P') { buys++; buyValue += v; } else { sells++; sellValue += v; }
  }
  const last = rows.slice().sort((a, b) => String(b.transactionDate).localeCompare(String(a.transactionDate))).slice(0, 5)
    .map((r) => ({ name: String(r.name || '').slice(0, 40), date: String(r.transactionDate || r.filingDate || '').slice(0, 10), code: r.transactionCode, shares: Math.abs(num(r.change) || 0), price: num(r.transactionPrice) }));
  return { insiders: { days: 90, buys, sells, buyValue: Math.round(buyValue), sellValue: Math.round(sellValue), last } };
}

/* ── Nasdaq (no key) ─────────────────────────────────────────────────────── */
const nq = (L, path) => call(L, 'nasdaq', `${NQ}/${path}`, { headers: NQ_HEADERS });

/** analyst/{sym}/targetprice → low / mean / high target and the buy / hold / sell counts. */
export async function target(L, sym) {
  const j = await nq(L, `${enc(sym)}/targetprice`);
  const c = j && j.data && j.data.consensusOverview;
  if (!c) throw noteBad(L, 'nasdaq', 'no target for ' + sym);
  return {
    targetLow: num(c.lowPriceTarget), targetMean: num(c.priceTarget), targetHigh: num(c.highPriceTarget),
    ratings: [c.buy, c.hold, c.sell].every((x) => num(x) != null) ? { buy: num(c.buy), hold: num(c.hold), sell: num(c.sell) } : null,
  };
}
/** analyst/{sym}/earnings-date → the next report's date (parsed from its sentence). */
export async function earningsDate(L, sym) {
  const j = await nq(L, `${enc(sym)}/earnings-date`);
  const text = String((j && j.data && (j.data.reportText || j.data.announcement)) || '');
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  if (!m) return { nextEarnings: null };
  const d = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return { nextEarnings: d, earningsTime: /after market close/i.test(text) ? 'after the close' : /before market open/i.test(text) ? 'before the open' : null };
}
/** analyst/{sym}/estimate-momentum → revisions over four weeks and the year's consensus a month ago vs now. */
export async function estimates(L, sym) {
  const j = await nq(L, `${enc(sym)}/estimate-momentum`);
  const d = j && j.data;
  if (!d || !d.estimatesChanged) return { revisions: null };
  const e = d.estimatesChanged, c = d.changeInConsensus || {};
  const v = (x) => num(x && x.changeValue) || 0;
  const now = num(c.currentData && c.currentData.yrMean), month = num(c.monthData && c.monthData.yrMean);
  return { revisions: { up: v(e.quarterDataUp) + v(e.yearDataUp), down: v(e.quarterDataDown) + v(e.yearDataDown), yearNow: now, yearMonthAgo: month, change: now != null && month ? now / month - 1 : null } };
}

/* ── Alpha Vantage OVERVIEW (≤ 20 a day; only when Nasdaq's target fails) ── */
export const alphavantage = { has: (env) => !!env.ALPHAVANTAGE_KEY };
export async function avTarget(L, env, sym) {
  const j = await call(L, 'alphavantage', `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${enc(sym)}&apikey=${enc(env.ALPHAVANTAGE_KEY)}`);
  const t = num(j && j.AnalystTargetPrice);
  if (t == null) throw noteBad(L, 'alphavantage', 'no target in the answer');
  return { targetMean: t };
}

/* ── SEC company facts ───────────────────────────────────────────────────── */
/** The SEC's ticker → CIK map (one call, kept in the edge cache for a week). */
export async function cikOf(L, sym, cache) {
  const key = 'https://quant-api.cache/sec-tickers';
  let map = cache ? await cache.get(key) : null;
  if (!map) {
    const j = await call(L, 'sec', 'https://www.sec.gov/files/company_tickers.json', { headers: { 'user-agent': SEC_UA }, timeout: BARS_TIMEOUT });
    map = {};
    for (const r of Object.values(j || {})) if (r && r.ticker) map[String(r.ticker).toUpperCase().replace('-', '.')] = String(r.cik_str);
    if (cache) await cache.put(key, map, 7 * 86400);
  }
  return map[sym] || null;
}
// The us-gaap concepts each number is read from, the first that is reported wins.
const CONCEPTS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss'],
  da: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  dividendsPaid: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
  epsFy: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
};
const INSTANT = {
  longDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  shortDebt: ['LongTermDebtCurrent', 'DebtCurrent', 'ShortTermBorrowings'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
};
/** One concept's annual (10-K, about a year long) values → [{ fy, end, val }] newest first, one per year end. */
function annual(facts, names) {
  for (const n of names) {
    const units = facts[n] && facts[n].units;
    const rows = units && (units.USD || units['USD/shares']);
    if (!rows) continue;
    const by = new Map();
    for (const r of rows) {
      if (!/^10-K/.test(r.form || '') || !r.start || !r.end) continue;
      const days = (Date.parse(r.end) - Date.parse(r.start)) / DAY;
      if (days < 350 || days > 380) continue;
      const old = by.get(r.end);
      if (!old || String(r.filed) > String(old.filed)) by.set(r.end, r);
    }
    const out = [...by.values()].sort((a, b) => b.end.localeCompare(a.end)).map((r) => ({ end: r.end, val: r.val }));
    if (out.length) return out;
  }
  return [];
}
/** One balance-sheet concept's newest value (any 10-K or 10-Q). */
function instant(facts, names) {
  for (const n of names) {
    const rows = facts[n] && facts[n].units && facts[n].units.USD;
    if (!rows) continue;
    const r = rows.filter((x) => /^10-[KQ]/.test(x.form || '') && x.end && !x.start).sort((a, b) => b.end.localeCompare(a.end) || String(b.filed).localeCompare(String(a.filed)))[0];
    if (r) return { end: r.end, val: r.val };
  }
  return null;
}
/** companyfacts → the last fiscal year's numbers, computed margins and 3-year growth, debt and cash. */
export async function sec(L, cik) {
  const j = await call(L, 'sec', `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`, { headers: { 'user-agent': SEC_UA }, timeout: BARS_TIMEOUT });
  const g = j && j.facts && j.facts['us-gaap'];
  if (!g) throw noteBad(L, 'sec', 'no us-gaap facts');
  const a = Object.fromEntries(Object.entries(CONCEPTS).map(([k, names]) => [k, annual(g, names)]));
  const last = (k) => (a[k][0] ? a[k][0].val : null);
  const rev = last('revenue'), fyEnd = a.revenue[0] ? a.revenue[0].end : (a.netIncome[0] || {}).end || null;
  const ratio = (x, y) => (x != null && y ? x / y : null);
  const growth3 = (k) => { const s = a[k]; return s.length >= 4 && s[3].val > 0 && s[0].val > 0 ? Math.pow(s[0].val / s[3].val, 1 / 3) - 1 : null; };
  const ld = instant(g, INSTANT.longDebt), sd = instant(g, INSTANT.shortDebt), cash = instant(g, INSTANT.cash);
  const debt = ld || sd ? (ld ? ld.val : 0) + (sd ? sd.val : 0) : null;
  const ebitda = last('operatingIncome') != null && last('da') != null ? last('operatingIncome') + last('da') : null;
  const ocf = last('operatingCashFlow'), capex = last('capex');
  return {
    fiscalYearEnd: fyEnd, name: j.entityName || null,
    revenue: rev, netIncome: last('netIncome'), operatingCashFlow: ocf, capex,
    freeCashFlow: ocf != null && capex != null ? ocf - capex : null,
    dividendsPaid: last('dividendsPaid'), epsFy: last('epsFy'),
    grossMarginFy: ratio(last('grossProfit'), rev), operatingMarginFy: ratio(last('operatingIncome'), rev), netMarginFy: ratio(last('netIncome'), rev),
    revGrowth3y: growth3('revenue'), epsGrowth3y: growth3('epsFy'),
    totalDebt: debt, cash: cash ? cash.val : null, ebitda,
    netDebtEbitda: debt != null && cash && ebitda > 0 ? (debt - cash.val) / ebitda : null,
    balanceAt: (cash || ld || sd || {}).end || null,
  };
}
