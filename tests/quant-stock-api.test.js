// quant-api, Quant refinements R7 (A1-Priv docs/TradeHub/quant/r1-07.md) and Batch 2 B1 (r2-01.md):
// GET /summary (the Analysis and Key Stats cards: Yahoo, else Nasdaq + Finnhub) and GET /heatmap
// (Alpaca snapshots × Nasdaq's share counts, Yahoo as a fallback). The worker runs against a small
// in-memory D1, a fake edge cache and a fake `fetch` playing Yahoo, Alpaca, Nasdaq and Finnhub.
//
// Run: node tests/quant-stock-api.test.js
'use strict';
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

function fakeDb() {
  const parts = new Map(), usage = new Map(), stats = new Map();
  const db = { parts, usage, stats };
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first() {
      if (/FROM dossier_parts WHERE symbol = \? AND part = 'yahoo'/.test(sql)) { const r = parts.get(args[0]); return r ? { ...r } : null; }
      if (/FROM dossier_parts WHERE symbol = \? AND part = 'stats'/.test(sql)) { const r = stats.get(args[0]); return r ? { ...r } : null; }
      throw new Error('first: ' + sql);
    },
    async all() {
      if (/FROM usage WHERE day = \?/.test(sql)) return { results: [...usage].map(([service, n]) => ({ service, n })) };
      if (/FROM provider_health/.test(sql) || /FROM meta WHERE k LIKE/.test(sql)) return { results: [] };
      throw new Error('all: ' + sql);
    },
    async run() {
      if (/^INSERT INTO usage/.test(sql)) { usage.set(args[1], (usage.get(args[1]) || 0) + args[2]); return {}; }
      if (/^INSERT INTO (provider_health|meta)/.test(sql)) return {};
      if (/^INSERT INTO dossier_parts .*VALUES \(\?, 'yahoo', 0, 'yahoo', '\{\}', \?, \?\)/.test(sql)) {
        if (!/DO UPDATE SET error = excluded\.error, err_at = excluded\.err_at$/.test(sql)) throw new Error('a failure must not overwrite the facts');
        const [symbol, error, errAt] = args, old = parts.get(symbol);
        parts.set(symbol, old ? { ...old, error, err_at: errAt } : { at: 0, body: '{}', error, err_at: errAt }); return {};
      }
      if (/^INSERT INTO dossier_parts .*VALUES \(\?, 'yahoo', \?, 'yahoo', \?, NULL, NULL\)/.test(sql)) { parts.set(args[0], { at: args[1], body: args[2], error: null, err_at: null }); return {}; }
      if (/^INSERT INTO dossier_parts .*VALUES \(\?, 'stats', \?, 'nasdaq', \?, NULL, NULL\)/.test(sql)) { stats.set(args[0], { at: args[1], body: args[2] }); return {}; }
      throw new Error('run: ' + sql);
    },
  });
  db.prepare = (sql) => stmt(sql);
  db.batch = async (list) => { for (const s of list) await s.run(); return []; };
  return db;
}

// The edge cache (caches.default), honouring max-age.
const EDGE = new Map();
globalThis.caches = { default: {
  async match(k) { const e = EDGE.get(String(k)); if (!e || e.until < Date.now()) return undefined; return new Response(e.body); },
  async put(k, r) { const age = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') || '')[1]); EDGE.set(String(k), { body: await r.text(), until: Date.now() + age * 1000, age }); },
} };

const Y = { calls: [], crumbs: 0, refuse: 0, down: false, empty: false, reset() { this.calls.length = 0; this.refuse = 0; this.down = false; this.empty = false; } };
const res = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const SNDK = {
  price: { regularMarketPrice: { raw: 805.1 }, regularMarketTime: 1795467600, longName: 'Sandisk Corporation', exchangeName: 'NasdaqGS', currency: 'USD', averageDailyVolume3Month: { raw: 10560000 } },
  financialData: { targetHighPrice: { raw: 3000 }, targetMeanPrice: { raw: 2047.375 }, targetMedianPrice: { raw: 2100 }, targetLowPrice: { raw: 870 }, numberOfAnalystOpinions: { raw: 24 }, recommendationKey: 'strong_buy', recommendationMean: { raw: 1.48 } },
  recommendationTrend: { trend: [{ period: '0m', strongBuy: 4, buy: 17, hold: 4, sell: 0, strongSell: 0 }, { period: '-1m', strongBuy: 4, buy: 16, hold: 5, sell: 0, strongSell: 0 }] },
  summaryDetail: { open: { raw: 805.87 }, previousClose: { raw: 797.24 }, dayHigh: { raw: 820 }, dayLow: { raw: 790 }, volume: { raw: 9000000 }, fiftyTwoWeekHigh: { raw: 2354.39 }, fiftyTwoWeekLow: { raw: 183 }, marketCap: { raw: 109.8e9 }, trailingPE: { raw: 6.17 }, forwardPE: { raw: 2.67 }, priceToSalesTrailing12Months: { raw: 3.79 }, dividendRate: {}, dividendYield: {} },
  defaultKeyStatistics: { priceToBook: { raw: 6.13 }, trailingEps: { raw: 125.12 }, bookValue: { raw: 125.93 }, sharesOutstanding: { raw: 142.29e6 }, floatShares: { raw: 140.39e6 } },
  calendarEvents: { earnings: { earningsDate: [{ raw: 1793304000 }], earningsAverage: { raw: 57.12 } } },
  upgradeDowngradeHistory: { history: [{ epochGradeDate: 1793646189, firm: 'Fox Advisors', toGrade: 'Equal-Weight', fromGrade: 'Overweight', action: 'down', currentPriceTarget: 0 }, { epochGradeDate: 1793386601, firm: 'Rosenblatt', toGrade: 'Buy', fromGrade: 'Buy', action: 'main', currentPriceTarget: 2400 }] },
};
// B1: the other sources, played here. N.down / AP.down switch them off.
const N = { calls: [], down: false }, AP = { calls: [], down: false };
const SCREEN = { data: { rows: [
  { symbol: 'S0', name: 'S0 Inc. Common Stock', lastsale: '$100.00', marketCap: '1000000000.00' },
  { symbol: 'SNDK', name: 'Sandisk Corporation Common Stock', lastsale: '$755.16', marketCap: '967062099221.00' },
  { symbol: 'BRK/B', name: 'Berkshire Hathaway Inc. Class B', lastsale: '$500.00', marketCap: '1000000000000.00' },
] } };
const MU = {
  summary: { data: { summaryData: { MarketCap: { value: '684,948,451,474' }, PreviousClose: { value: '$690.44' }, TodayHighLow: { value: '$668.99/$599.15' }, FiftTwoWeekHighLow: { value: '$1255/$192.59' },
    AnnualizedDividend: { value: '$0.60' }, ExDividendDate: { value: 'Oct 14, 2026' }, Yield: { value: '0.09%' } } } },
  info: { data: { primaryData: { lastSalePrice: '$605.88' } } },
  forecast: { data: { quarterlyForecast: { rows: [{ consensusEPSForecast: 37.95 }, { consensusEPSForecast: 41.74 }, { consensusEPSForecast: 44 }, { consensusEPSForecast: 46.31 }] } } },
  short: { data: { shortInterestTable: { rows: [{ settlementDate: '10/30/2026', interest: '23,385,015' }] } } },
  metric: { metric: { peTTM: 9.58, psTTM: 6.11, epsTTM: 74.21, beta: 2.48, pbQuarterly: 4.2, bookValuePerShareQuarterly: 144.1, '52WeekHigh': 1255, '52WeekLow': 192.59, marketCapitalization: 684948 } },
};
globalThis.fetch = async (url, o = {}) => {
  const u = String(url), hd = o.headers || {};
  if (/data\.alpaca\.markets/.test(u)) {
    AP.calls.push(u);
    if (AP.down) return res({ message: 'down' }, 500);
    const syms = decodeURIComponent(/symbols=([^&]+)/.exec(u)[1]).split(',');
    // Even rows: a trade in today's session (against the day before); odd rows: after hours past
    // midnight UTC (still today's New York session: against the day before too).
    return res(Object.fromEntries(syms.filter((s) => s !== 'ZZZZ').map((s, i) => [s, { latestTrade: { p: 110, t: i % 2 ? '2026-11-21T01:30:00Z' : '2026-11-20T18:00:00Z' }, dailyBar: { t: '2026-11-20T05:00:00Z', c: 108 }, prevDailyBar: { t: '2026-11-19T05:00:00Z', c: 100 } }])));
  }
  if (/api\.nasdaq\.com/.test(u)) {
    N.calls.push(u);
    if (N.down) return res({ data: null }, 500);
    if (/screener/.test(u)) return res(SCREEN);
    if (/quote\/MU\/summary/.test(u)) return res(MU.summary);
    if (/quote\/MU\/info/.test(u)) return res(MU.info);
    if (/analyst\/MU\/earnings-forecast/.test(u)) return res(MU.forecast);
    if (/quote\/MU\/short-interest/.test(u)) return res(MU.short);
    return res({ data: null, status: { rCode: 400 } });
  }
  if (/finnhub\.io/.test(u)) { N.calls.push(u); return /symbol=MU/.test(u) ? res(MU.metric) : res({ metric: {} }); }
  Y.calls.push(u);
  if (Y.down) return res({ error: 'down' }, 500);
  if (u === 'https://fc.yahoo.com/') return res('<html>404</html>', 404, { 'set-cookie': 'A3=d=AQAB' + (++Y.crumbs) + '; Max-Age=31557600; Domain=.yahoo.com' });
  if (/\/v1\/test\/getcrumb/.test(u)) return /^A3=/.test(hd.cookie || '') ? res('crumb' + Y.crumbs) : res('no', 401);
  const crumb = (/[?&]crumb=([^&]+)/.exec(u) || [])[1];
  if (!crumb) return res({ finance: { error: 'Invalid Crumb' } }, 401);
  if (Y.refuse > 0) { Y.refuse--; return res({ finance: { error: 'Invalid Crumb' } }, 401); }
  if (/quoteSummary\/SNDK/.test(u)) return res({ quoteSummary: { result: [SNDK] } });
  if (/quoteSummary\//.test(u)) return res({ quoteSummary: { result: null, error: { code: 'Not Found' } } }, 404);
  if (/\/v7\/finance\/quote/.test(u)) {
    if (Y.empty) return res({ quoteResponse: { result: [] } });
    const syms = decodeURIComponent(/symbols=([^&]+)/.exec(u)[1]).split(',');
    return res({ quoteResponse: { result: syms.filter((s) => s !== 'ZZZZ').map((s, i) => ({ symbol: s, marketCap: 1e9 * (i + 1), regularMarketChangePercent: i % 2 ? -1.25 : 0.5, regularMarketPrice: 100 + i, regularMarketTime: 1795467600, shortName: s + ' Inc' })) } });
  }
  return res({ error: 'unexpected ' + u }, 500);
};

(async () => {
  const W8 = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'worker.js')).href);
  const S = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'lib', 'stock.js')).href);
  const worker = W8.default;
  const KEY = 'orca_sk_test_stock_0123456789', hash = crypto.createHash('sha256').update(KEY).digest('hex');
  const call = async (env, p, { key = KEY } = {}) => {
    const r = await worker.fetch(new Request('https://quant-api.test' + p, { headers: key ? { authorization: 'Bearer ' + key } : {} }), env, null);
    let j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, body: j };
  };
  const env = { DB: fakeDb(), ALLOWED_KEYS: hash, FINNHUB_KEY: 'fh_test' };
  const clearDown = () => { for (const k of [...EDGE.keys()]) if (/yahoo-down/.test(k)) EDGE.delete(k); };

  console.log('\n/summary: Analysis and Key Stats');
  ok('the route needs the key', (await call(env, '/summary?symbol=SNDK', { key: null })).status === 401);
  ok('a symbol is needed (an index is refused)', (await call(env, '/summary')).status === 400 && (await call(env, '/summary?symbol=^VIX')).status === 400);
  Y.reset();
  let r = await call(env, '/summary?symbol=sndk');
  ok('a first look: cookie, crumb, quoteSummary = 3 calls', r.status === 200 && Y.calls.length === 3 && /fc\.yahoo\.com/.test(Y.calls[0]) && /getcrumb/.test(Y.calls[1]) && /quoteSummary\/SNDK\?modules=.*financialData.*&crumb=crumb/.test(Y.calls[2]), Y.calls.join(' '));
  const a = r.body.facts.analysis, s = r.body.facts.stats;
  ok('the targets match Tony\'s Webull screenshot (high 3000, mean 2047.375, low 870, 24 analysts)', a.targetHigh === 3000 && a.targetMean === 2047.375 && a.targetLow === 870 && a.analysts === 24 && a.recKey === 'strong_buy', JSON.stringify(a));
  ok('...the five rating buckets for this month and before', a.trend[0].strongBuy === 4 && a.trend[0].buy === 17 && a.trend[0].hold === 4 && a.trend.length === 2);
  ok('...the latest upgrades and downgrades, a target only when one was given', a.upgrades.length === 2 && a.upgrades[0].firm === 'Fox Advisors' && a.upgrades[0].target === undefined && a.upgrades[1].target === 2400 && /^\d{4}-\d\d-\d\d$/.test(a.upgrades[0].day));
  ok('key stats: every field in the screenshot', s.open === 805.87 && s.prevClose === 797.24 && s.high52 === 2354.39 && s.low52 === 183 && s.marketCap === 109.8e9 && s.avgVol3m === 10560000
    && s.peTtm === 6.17 && s.peFwd === 2.67 && s.pb === 6.13 && s.ps === 3.79 && s.epsTtm === 125.12 && s.bps === 125.93 && s.shares === 142.29e6 && s.float === 140.39e6, JSON.stringify(s));
  ok('...an empty dividend is left out, not zero', !('divRate' in s) && !('divYield' in s));
  ok('...a past earnings date is the last one, not the next', s.lastEarnings === '2026-10-29' && !('nextEarnings' in s), JSON.stringify([s.lastEarnings, s.nextEarnings]));
  ok('kept in D1 as the dossier part "yahoo"', env.DB.parts.has('SNDK') && JSON.parse(env.DB.parts.get('SNDK').body).analysis.targetHigh === 3000);
  Y.reset();
  r = await call(env, '/summary?symbol=SNDK');
  ok('a second look within 6 h: no call at all', r.status === 200 && Y.calls.length === 0 && r.body.facts.analysis.analysts === 24);
  Y.reset();
  r = await call(env, '/summary?symbol=SNDK&fresh=1');
  ok('fresh=1 asks again, and the cached session saves the cookie and crumb calls', r.status === 200 && Y.calls.length === 1, Y.calls.join(' '));
  Y.reset(); Y.refuse = 1;
  r = await call(env, '/summary?symbol=SNDK&fresh=1');
  ok('a refused crumb: a new session once, then the answer', r.status === 200 && Y.calls.length === 4 && r.body.facts.analysis.targetMean === 2047.375, Y.calls.join(' '));
  Y.reset();
  r = await call(env, '/summary?symbol=NOPE');
  ok('a symbol Yahoo does not know: 200 with `failed`, no facts', r.status === 200 && /yahoo: HTTP 404/.test(r.body.failed) && r.body.facts === null, JSON.stringify(r.body));
  Y.reset();
  r = await call(env, '/summary?symbol=NOPE');
  ok('...remembered for an hour: no call the next time', Y.calls.length === 0 && /tried \d+ minutes ago/.test(r.body.failed));
  Y.reset();
  r = await call(env, '/summary?symbol=NOPE&fresh=1');
  ok('...but fresh=1 (Tony asking again) tries Yahoo once more', Y.calls.length >= 1 && /HTTP 404/.test(r.body.failed));
  ok('...a symbol Yahoo does not know does not mark Yahoo down', ![...EDGE.keys()].some((k) => /yahoo-down/.test(k)));
  env.DB.parts.get('SNDK').at -= 7 * 3600000;
  Y.reset(); Y.down = true;
  r = await call(env, '/summary?symbol=SNDK');
  ok('Yahoo down with old facts: they still answer with their time, and `failed` says why', r.status === 200 && r.body.facts.analysis.targetHigh === 3000 && r.body.failed && (r.body.analysisAt || r.body.at) < Date.now() - 6 * 3600000, JSON.stringify(r.body).slice(0, 200));
  ok('...and Yahoo now rests for every symbol (an hour)', [...EDGE.entries()].some(([k, v]) => /yahoo-down/.test(k) && v.age === S.YAHOO_DOWN_S));

  console.log('\n/summary without Yahoo (B1): Nasdaq + Finnhub');
  Y.reset(); N.calls.length = 0;
  r = await call(env, '/summary?symbol=MU');
  const ms = (r.body.facts && r.body.facts.stats) || {}, src = (r.body.facts && r.body.facts.statSrc) || {};
  ok('Yahoo resting: not asked at all for a new symbol', Y.calls.length === 0, Y.calls.join(' '));
  ok('...the stats come from Nasdaq and Finnhub (src nasdaq, `yahoo` says why)', r.status === 200 && r.body.src === 'nasdaq' && /resting/.test(r.body.yahoo || ''), JSON.stringify(r.body).slice(0, 300));
  ok('...market cap, dividend, ex-dividend, yield, previous close, day and 52-week ranges from Nasdaq', ms.marketCap === 684948451474 && ms.divRate === 0.6 && ms.exDiv === '2026-10-14' && Math.abs(ms.divYield - 0.0009) < 1e-9 && ms.prevClose === 690.44 && ms.dayHigh === 668.99 && ms.dayLow === 599.15 && ms.high52 === 1255 && ms.low52 === 192.59, JSON.stringify(ms));
  ok('...shares = cap / price, P/E (FWD) = price / the next four quarters, short % of shares', ms.shares === Math.round(684948451474 / 605.88) && Math.abs(ms.peFwd - 605.88 / 170) < 1e-9 && Math.abs(ms.shortFloat - 23385015 / ms.shares) < 1e-12, JSON.stringify([ms.shares, ms.peFwd, ms.shortFloat]));
  ok('...P/E, P/S, EPS, beta, P/B and BPS from Finnhub', ms.peTtm === 9.58 && ms.ps === 6.11 && ms.epsTtm === 74.21 && ms.beta === 2.48 && ms.pb === 4.2 && ms.bps === 144.1, JSON.stringify(ms));
  ok('...each field names its source', src.marketCap === 'nasdaq' && src.shares === 'computed' && src.peFwd === 'computed' && src.pb === 'finnhub', JSON.stringify(src));
  ok('...kept as dossier part "stats"', env.DB.stats.has('MU'));
  N.calls.length = 0;
  r = await call(env, '/summary?symbol=MU');
  ok('...a second look within 6 h: no call', N.calls.length === 0 && r.body.facts.stats.pb === 4.2);
  r = await call(env, '/summary?symbol=QQQQ');
  ok('a symbol neither source knows: the old answer (no facts, `failed`)', r.status === 200 && r.body.facts === null && !!r.body.failed, JSON.stringify(r.body).slice(0, 200));
  clearDown();

  console.log('\n/heatmap');
  EDGE.clear(); Y.reset();
  const many = Array.from({ length: 503 }, (_, i) => 'S' + i);
  ok('symbols are needed; more than 600 refused', (await call(env, '/heatmap')).status === 400 && (await call(env, '/heatmap?symbols=' + Array.from({ length: 601 }, (_, i) => 'Q' + i).join(','))).status === 400);
  Y.reset();
  r = await call(env, '/heatmap?symbols=' + many.join(',') + ',BRK.B,ZZZZ');
  const quoteCalls = Y.calls.filter((u) => /v7\/finance\/quote/.test(u));
  ok('505 symbols: 3 batch calls (170 a call) + the session\'s 2', r.status === 200 && quoteCalls.length === 3 && Y.calls.length === 5, Y.calls.length);
  ok('...each with its market cap and the day\'s change as a fraction', r.body.items.S0.cap === 1e9 && r.body.items.S0.chg === 0.005 && r.body.items.S1.chg === -0.0125 && r.body.items.S0.price === 100);
  ok('...a class share asked as BRK.B comes back as BRK.B (Yahoo writes BRK-B)', !!r.body.items['BRK.B'] && quoteCalls.some((u) => /BRK-B/.test(decodeURIComponent(u))));
  ok('...one Yahoo does not know is listed in `missing`', JSON.stringify(r.body.missing) === '["ZZZZ"]' && r.body.src === 'yahoo' && r.body.asOf === 1795467600000);
  Y.reset();
  r = await call(env, '/heatmap?symbols=' + ['ZZZZ', 'BRK.B', ...many.slice().reverse()].join(','));
  ok('the same set in another order: from the edge cache, no call', r.status === 200 && Y.calls.length === 0 && r.body.cached === true);
  const ages = [...EDGE.entries()].filter(([k]) => /heatmap/.test(k)).map(([, v]) => v.age);
  ok('...kept 120 s in market hours or 1800 s outside them', ages.length === 1 && (ages[0] === S.HEAT_LIVE_S || ages[0] === S.HEAT_QUIET_S), JSON.stringify(ages));
  Y.reset(); Y.empty = true;
  r = await call(env, '/heatmap?symbols=AAA,BBB');
  ok('Yahoo answering with no quotes: 503, said plainly', r.status === 503 && /no quotes/.test(r.body.error), JSON.stringify(r.body));
  EDGE.clear(); Y.reset(); Y.down = true;
  r = await call(env, '/heatmap?symbols=AAA,BBB');
  ok('Yahoo down: 503 that names Yahoo', r.status === 503 && /needs Yahoo/.test(r.body.error), JSON.stringify(r.body));
  ok('every call is counted on its own ledger line (yahoo-crumb), never the bars chain\'s yahoo', (env.DB.usage.get('yahoo-crumb') || 0) > 0 && !env.DB.usage.has('yahoo'), JSON.stringify([...env.DB.usage]));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
