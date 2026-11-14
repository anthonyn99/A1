// quant-api, Phase 7 (A1-Priv docs/TradeHub/quant/phase-07.md): the ticker
// dossier's parts, the fundamentals the nightly ideas rank, the stored ideas,
// FINRA short volume and the invest horizon on the ledger. The worker runs
// against a small in-memory D1 and a fake `fetch` playing Finnhub, Nasdaq,
// the SEC and Alpha Vantage.
//
// Run: node tests/quant-dossier-api.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const DAY = 86400000;

// The statements the Phase 7 routes and the ledger use, over plain maps.
function fakeDb({ noTables = false } = {}) {
  const parts = new Map(), ideas = [], short = new Map(), usage = new Map(), signals = new Map();
  const seven = (sql) => { const m = /\b(dossier_parts|ideas|short_volume)\b/.exec(sql); if (noTables && m) throw new Error('D1_ERROR: no such table: ' + m[1]); };
  const db = { writes: 0, batches: [], parts, ideas, short, usage, signals };
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first() {
      seven(sql);
      if (/FROM ideas ORDER BY at DESC/.test(sql)) return ideas.slice().sort((a, b) => b.at - a.at || b.id - a.id)[0] || null;
      if (/COUNT\(\*\) AS n FROM signals/.test(sql)) return { n: 0 };
      throw new Error('first: ' + sql);
    },
    async all() {
      seven(sql);
      if (/FROM usage WHERE day = \?/.test(sql)) return { results: [...usage].map(([service, n]) => ({ service, n })) };
      if (/FROM provider_health/.test(sql) || /FROM meta WHERE k LIKE/.test(sql)) return { results: [] };
      if (/^SELECT part, at, src, body, error, err_at FROM dossier_parts WHERE symbol = \?/.test(sql)) return { results: [...parts.values()].filter((r) => r.symbol === args[0]).map((r) => ({ ...r })) };
      if (/FROM dossier_parts WHERE part = 'metric' AND symbol IN/.test(sql)) { const s = JSON.parse(args[0]); return { results: [...parts.values()].filter((r) => r.part === 'metric' && s.includes(r.symbol)) }; }
      if (/FROM short_volume WHERE symbol = \?/.test(sql)) return { results: [...short.values()].filter((r) => r.symbol === args[0]).sort((a, b) => b.day.localeCompare(a.day)).slice(0, args[1] || 40) };
      if (/SELECT id FROM signals WHERE id IN/.test(sql)) return { results: [] };
      throw new Error('all: ' + sql);
    },
    async run() {
      seven(sql);
      if (/^INSERT INTO usage/.test(sql)) { usage.set(args[1], (usage.get(args[1]) || 0) + args[2]); return {}; }
      if (/^INSERT INTO (provider_health|meta)/.test(sql)) return {};
      if (/^INSERT INTO dossier_parts/.test(sql) && /VALUES \(\?, \?, 0, \?, '\{\}', \?, \?\)/.test(sql)) {
        // A failure: kept on the row (a new row gets at 0 and no facts); the old facts stay.
        if (!/DO UPDATE SET error = excluded\.error, err_at = excluded\.err_at$/.test(sql)) throw new Error('a failure must not overwrite the facts');
        const [symbol, part, src, error, errAt] = args, k = symbol + '|' + part, old = parts.get(k);
        parts.set(k, old ? { ...old, error, err_at: errAt } : { symbol, part, at: 0, src, body: '{}', error, err_at: errAt }); db.writes++; return {};
      }
      if (/^INSERT INTO dossier_parts/.test(sql)) {
        const metricOnly = /VALUES \(\?, 'metric', \?, 'finnhub', \?, NULL\)/.test(sql);
        const [symbol, part, at, src, body] = metricOnly ? [args[0], 'metric', args[1], 'finnhub', args[2]] : args;
        parts.set(symbol + '|' + part, { symbol, part, at, src, body, error: null, err_at: null }); db.writes++; return {};
      }
      if (/^INSERT INTO ideas/.test(sql)) { ideas.push({ id: ideas.length + 1, day: args[0], at: args[1], body: args[2] }); db.writes++; return {}; }
      if (/^DELETE FROM ideas WHERE id NOT IN/.test(sql)) { const keep = new Set(ideas.slice().sort((a, b) => b.at - a.at || b.id - a.id).slice(0, args[0]).map((x) => x.id)); for (let i = ideas.length - 1; i >= 0; i--) if (!keep.has(ideas[i].id)) ideas.splice(i, 1); return {}; }
      if (/^INSERT INTO short_volume/.test(sql)) { short.set(args[0] + '|' + args[1], { symbol: args[0], day: args[1], short: args[2], total: args[3] }); db.writes++; return {}; }
      if (/^DELETE FROM short_volume WHERE day < \?/.test(sql)) { for (const [k, r] of short) if (r.day < args[0]) short.delete(k); return {}; }
      if (/^INSERT INTO signals/.test(sql)) { signals.set(args[0], { id: args[0], horizon: args[3] }); return {}; }
      throw new Error('run: ' + sql);
    },
  });
  db.prepare = (sql) => stmt(sql);
  db.batch = async (list) => { db.batches.push(list.length); for (const s of list) await s.run(); return []; };
  return db;
}

/* ── the outside world ──────────────────────────────────────────────────── */
const W = { calls: [], down: new Set(), empty: new Set(), reset() { this.calls.length = 0; this.down.clear(); this.empty.clear(); }, count(re) { return this.calls.filter((u) => re.test(u)).length; } };
const res = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const host = (u) => (u.includes('finnhub.io') ? 'finnhub' : u.includes('api.nasdaq.com') ? 'nasdaq' : u.includes('sec.gov') ? 'sec' : u.includes('alphavantage') ? 'alphavantage' : 'other');
const FY = (end, val, form = '10-K') => ({ start: new Date(Date.parse(end) - 364 * DAY).toISOString().slice(0, 10), end, val, form, filed: end.replace(/-\d\d$/, '-28') });
globalThis.fetch = async (url) => {
  const u = String(url), h = host(u);
  W.calls.push(u);
  if (W.down.has(h)) return res({ error: 'down' }, 500);
  if (h === 'finnhub') {
    if (/\/stock\/metric/.test(u)) return res(W.empty.has('metric') ? { metric: {} } : { metric: { '52WeekHigh': 212.2, '52WeekLow': 120.1, beta: 1.8, marketCapitalization: 4500000, peTTM: 48.2, psTTM: 25, epsTTM: 3.9, epsAnnual: 3.7, grossMarginTTM: 72.1, grossMarginAnnual: 70, operatingMarginTTM: 61, operatingMarginAnnual: 60, netProfitMarginTTM: 53, roeTTM: 110, revenueGrowth3Y: 85, epsGrowth3Y: 120, revenueGrowthTTMYoy: 62, currentDividendYieldTTM: 0.02, payoutRatioTTM: 1.1 },
      series: { quarterly: { pe: [{ period: '2026-07-31', v: 48 }, { period: '2026-04-30', v: 40 }, { period: '2026-01-31', v: 55 }], ps: [{ period: '2026-07-31', v: 25 }] } } });
    if (/\/stock\/recommendation/.test(u)) return res([{ period: '2026-11-01', strongBuy: 20, buy: 18, hold: 5, sell: 1, strongSell: 0 }, { period: '2026-10-01', strongBuy: 20, buy: 17, hold: 6, sell: 1, strongSell: 0 }, { period: '2026-09-01', strongBuy: 19, buy: 17, hold: 6, sell: 1, strongSell: 0 }, { period: '2026-08-01', strongBuy: 15, buy: 15, hold: 10, sell: 2, strongSell: 0 }]);
    if (/\/stock\/earnings/.test(u)) return res([{ period: '2026-07-31', actual: 1.05, estimate: 1.0, surprisePercent: 5 }]);
    if (/\/calendar\/earnings/.test(u)) return res({ earningsCalendar: W.empty.has('calendar') ? [] : [{ date: '2026-11-19', hour: 'amc', symbol: 'NVDA', epsEstimate: 1.1 }] });
    if (/\/stock\/insider-transactions/.test(u)) return res({ data: [{ name: 'A', change: -1000, transactionPrice: 180, transactionCode: 'S', transactionDate: '2026-10-20' }, { name: 'B', change: 100, transactionPrice: 170, transactionCode: 'P', transactionDate: '2026-10-01' }, { name: 'C', change: 50, transactionPrice: 0, transactionCode: 'M', transactionDate: '2026-10-02' }] });
    return res({ error: 'no route' }, 404);
  }
  if (h === 'nasdaq') {
    if (/targetprice/.test(u)) return res({ data: { consensusOverview: { lowPriceTarget: 170, highPriceTarget: 345, priceTarget: 247.58, buy: 27, sell: 0, hold: 11 } } });
    if (/earnings-date/.test(u)) return res({ data: { reportText: 'NVIDIA is expected* to report earnings on  11/17/2026 after market close.' } });
    if (/estimate-momentum/.test(u)) return res({ data: { changeInConsensus: { monthData: { yrMean: 9.4 }, currentData: { yrMean: 9.29 } }, estimatesChanged: { quarterDataDown: { changeValue: 3 }, quarterDataUp: { changeValue: 1 }, yearDataDown: { changeValue: 2 }, yearDataUp: { changeValue: 0 } } } });
  }
  if (h === 'sec') {
    if (/company_tickers/.test(u)) return res({ 0: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA' }, 1: { cik_str: 1, ticker: 'BRK-B' } });
    if (/companyfacts\/CIK0001045810/.test(u)) return res({ entityName: 'NVIDIA CORP', facts: { 'us-gaap': {
      Revenues: { units: { USD: [FY('2026-01-25', 200e9), FY('2025-01-26', 130e9), FY('2024-01-28', 61e9), FY('2023-01-29', 27e9), { start: '2026-04-28', end: '2026-07-27', val: 60e9, form: '10-Q', filed: '2026-08-28' }] } },
      GrossProfit: { units: { USD: [FY('2026-01-25', 150e9)] } }, OperatingIncomeLoss: { units: { USD: [FY('2026-01-25', 120e9)] } },
      NetIncomeLoss: { units: { USD: [FY('2026-01-25', 100e9)] } }, DepreciationDepletionAndAmortization: { units: { USD: [FY('2026-01-25', 3e9)] } },
      NetCashProvidedByUsedInOperatingActivities: { units: { USD: [FY('2026-01-25', 90e9)] } }, PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [FY('2026-01-25', 5e9)] } },
      PaymentsOfDividends: { units: { USD: [FY('2026-01-25', 1e9)] } }, EarningsPerShareDiluted: { units: { 'USD/shares': [FY('2026-01-25', 4.0), FY('2025-01-26', 2.9), FY('2024-01-28', 1.2), FY('2023-01-29', 0.17)] } },
      LongTermDebtNoncurrent: { units: { USD: [{ end: '2026-07-27', val: 8e9, form: '10-Q', filed: '2026-08-28' }] } },
      CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: '2026-07-27', val: 20e9, form: '10-Q', filed: '2026-08-28' }] } },
    } } });
    return res({}, 404);
  }
  if (h === 'alphavantage') return res({ AnalystTargetPrice: '250.1' });
  return res({ error: 'unexpected ' + u }, 500);
};

(async () => {
  const W8 = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'worker.js')).href);
  const worker = W8.default;
  const KEY = 'orca_sk_test_dossier_0123456789', hash = crypto.createHash('sha256').update(KEY).digest('hex');
  const call = async (env, p, { method = 'GET', body, key = KEY } = {}) => {
    const r = await worker.fetch(new Request('https://quant-api.test' + p, { method, headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, null);
    let j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, body: j };
  };
  const mk = (o = {}) => ({ DB: fakeDb(o), ALLOWED_KEYS: hash, FINNHUB_KEY: 'fk', ...o.env });

  console.log('\nThe dossier');
  let env = mk(), r;
  ok('the route needs the key', (await call(env, '/dossier?symbol=NVDA', { key: null })).status === 401);
  ok('a symbol is needed (and an index is refused)', (await call(env, '/dossier')).status === 400 && (await call(env, '/dossier?symbol=^VIX')).status === 400);
  W.reset();
  r = await call(env, '/dossier?symbol=nvda&cik=1045810');
  ok('a first request makes at most 6 provider calls', r.status === 200 && r.body.calls <= 6 && W.calls.length <= 6, r.body && r.body.calls + ' / ' + W.calls.length);
  ok('...the parts past the budget are pending, in order', JSON.stringify(r.body.pending) === JSON.stringify(['estimates', 'sec']), JSON.stringify(r.body.pending));
  ok('...each part carries its source and time', ['calendar', 'metric', 'target', 'recommendation', 'surprises', 'insiders'].every((p) => r.body.parts[p] && r.body.parts[p].src && r.body.parts[p].at > 0));
  // Two batches: the six parts, and the ledger's usage and health rows.
  ok('...stored in ONE batch (plus the ledger\'s)', env.DB.batches.length === 2 && env.DB.parts.size === 6 && env.DB.writes === 6, JSON.stringify(env.DB.batches));
  const f = (p) => r.body.parts[p].facts;
  ok('Finnhub metrics: percents become fractions, market cap in dollars', f('metric').grossMargin === 0.721 && f('metric').marketCap === 4.5e12 && f('metric').pe === 48.2 && f('metric').revGrowth3y === 0.85);
  ok('...its P/E history oldest first', JSON.stringify(f('metric').peHist.map((x) => x.v)) === '[55,40,48]');
  ok('recommendations: counts and the trend over three months', f('recommendation').ratings.buy === 38 && f('recommendation').ratings.sell === 1 && f('recommendation').ratingTrend === 'up', JSON.stringify(f('recommendation')));
  ok('the next earnings date and time', f('calendar').nextEarnings === '2026-11-19' && f('calendar').earningsTime === 'after the close');
  ok('insiders: open-market buys and sells by value (the option exercise is left out)', f('insiders').insiders.sellValue === 180000 && f('insiders').insiders.buyValue === 17000 && f('insiders').insiders.buys === 1);
  ok('Nasdaq: low, mean and high target and the counts', f('target').targetMean === 247.58 && f('target').targetHigh === 345 && f('target').ratings.hold === 11);
  W.reset();
  r = await call(env, '/dossier?symbol=NVDA&cik=1045810');
  ok('the second request fetches only the pending parts', r.status === 200 && r.body.pending.length === 0 && W.calls.length === 2 && r.body.parts.sec && r.body.parts.estimates, W.calls.join(' '));
  const sec = r.body.parts.sec.facts;
  ok('SEC: the last 10-K year (a 10-Q quarter is ignored), margins and 3-year growth worked out', sec.revenue === 200e9 && Math.abs(sec.grossMarginFy - 0.75) < 1e-9 && Math.abs(sec.revGrowth3y - (Math.pow(200 / 27, 1 / 3) - 1)) < 1e-9 && sec.fiscalYearEnd === '2026-01-25', JSON.stringify(sec));
  ok('...free cash flow, net debt / EBITDA', sec.freeCashFlow === 85e9 && Math.abs(sec.netDebtEbitda - (8e9 - 20e9) / 123e9) < 1e-9);
  ok('estimates: revisions up and down, the year consensus change', r.body.parts.estimates.facts.revisions.down === 5 && r.body.parts.estimates.facts.revisions.up === 1 && r.body.parts.estimates.facts.revisions.change < 0);
  W.reset();
  r = await call(env, '/dossier?symbol=NVDA');
  ok('a third request within the day: no calls at all', r.status === 200 && W.calls.length === 0 && r.body.calls === 0);
  const old = env.DB.parts.get('NVDA|calendar'); old.at -= 7 * 3600000;
  W.reset();
  r = await call(env, '/dossier?symbol=NVDA');
  ok('after 6 hours only the earnings date is fetched again', W.calls.length === 1 && /calendar\/earnings/.test(W.calls[0]));
  ok('Finnhub price targets and candles are never asked for', !W.calls.concat(env.DB ? [] : []).some((u) => /price-target|\/stock\/candle/.test(u)));

  console.log('\nSecond sources and failures');
  env = mk(); W.reset(); W.empty.add('calendar');
  r = await call(env, '/dossier?symbol=NVDA&cik=1045810');
  ok('no Finnhub date: Nasdaq\'s earnings date is used (and counted)', r.body.parts.calendar.src === 'nasdaq' && r.body.parts.calendar.facts.nextEarnings === '2026-11-17' && r.body.calls <= 6, JSON.stringify(r.body.parts.calendar));
  env = mk({ env: { ALPHAVANTAGE_KEY: 'av' } }); W.reset(); W.down.add('nasdaq');
  r = await call(env, '/dossier?symbol=NVDA&cik=1045810');
  ok('Nasdaq down: the target comes from Alpha Vantage when its key is set', r.body.parts.target && r.body.parts.target.src === 'alphavantage' && r.body.parts.target.facts.targetMean === 250.1, JSON.stringify(r.body.failed));
  env = mk(); W.reset(); W.down.add('nasdaq');
  r = await call(env, '/dossier?symbol=NVDA&cik=1045810');
  ok('...without its key the target is listed as failed, the rest still come', !r.body.parts.target && /nasdaq/.test(r.body.failed.target) && r.body.parts.metric);
  W.reset();
  r = await call(env, '/dossier?symbol=NVDA&cik=1045810');
  ok('...a failed part is remembered: not asked again within the hour, still listed as failed', W.count(/targetprice/) === 0 && /nasdaq: HTTP 500 \(tried 0 minutes ago\)/.test(r.body.failed.target), JSON.stringify(r.body.failed) + ' ' + W.calls.join(' '));
  env.DB.parts.get('NVDA|target').err_at -= 61 * 60000; W.reset(); W.down.clear();
  r = await call(env, '/dossier?symbol=NVDA&cik=1045810');
  ok('...after an hour it is tried again, and the facts come', W.count(/targetprice/) === 1 && r.body.parts.target && r.body.parts.target.facts.targetMean === 247.58 && !r.body.failed.target);
  env = mk(); W.reset(); W.empty.add('metric');
  await call(env, '/dossier?symbol=SPY');
  W.reset();
  r = await call(env, '/dossier?symbol=SPY');
  ok('an empty answer (an ETF has no financials) waits a day, not an hour', W.count(/stock\/metric/) === 0 && /^nodata: /.test(env.DB.parts.get('SPY|metric').error) && !r.body.parts.metric);
  env.DB.parts.get('SPY|metric').err_at -= 2 * 3600000; W.reset();
  await call(env, '/dossier?symbol=SPY');
  ok('...still waiting two hours later', W.count(/stock\/metric/) === 0);

  console.log('\nThe budget is counted call by call');
  env = mk({ env: { ALPHAVANTAGE_KEY: 'av', FINNHUB_KEY: '' } }); W.reset(); W.down.add('nasdaq');
  r = await call(env, '/dossier?symbol=NVDA');
  ok('a failed fallback counts both its calls; the SEC lookup needs room for two', r.body.calls <= 6 && W.calls.length <= 6 && r.body.calls === W.calls.length, r.body.calls + ' / ' + W.calls.length + ' ' + W.calls.join(' '));
  env = mk(); W.reset();
  for (const p of ['calendar', 'metric', 'target', 'recommendation', 'surprises']) env.DB.parts.set('NVDA|' + p, { symbol: 'NVDA', part: p, at: Date.now(), src: 'finnhub', body: '{}', error: null, err_at: null });
  r = await call(env, '/dossier?symbol=NVDA');   // insiders + estimates = 2, then sec without a CIK needs 2 more: 4 ≤ 6
  ok('...insiders, estimates, then the SEC with its ticker map: 4 calls', r.body.calls === 4 && W.calls.length === 4 && r.body.parts.sec, W.calls.join(' '));
  env = mk(); W.reset();
  for (const p of ['calendar', 'metric', 'target', 'recommendation']) env.DB.parts.set('NVDA|' + p, { symbol: 'NVDA', part: p, at: Date.now(), src: 'finnhub', body: '{}', error: null, err_at: null });
  env.DB.parts.set('NVDA|surprises', { symbol: 'NVDA', part: 'surprises', at: 1, src: 'finnhub', body: '{}', error: null, err_at: null });
  for (let i = 0; i < 2; i++) env.DB.parts.set('X|' + i, { symbol: 'X', part: 'x' + i, at: 1 });
  r = await call(env, '/dossier?symbol=NVDA');   // surprises, insiders, estimates = 3; sec needs 2 → 5; all fit
  ok('...never more than 6, whatever is stale', r.body.calls <= 6 && W.calls.length === r.body.calls);
  env = mk({ env: { FINNHUB_KEY: '' } }); W.reset();
  r = await call(env, '/dossier?symbol=NVDA');
  ok('no Finnhub key: its parts fail without a call or a charge; Nasdaq and the SEC (ticker map) still come', W.count(/finnhub/) === 0 && /no Finnhub key/.test(r.body.failed.metric) && r.body.parts.target && r.body.parts.sec && W.count(/company_tickers/) === 1, JSON.stringify(r.body.failed) + ' ' + W.calls.join(' '));
  env = mk({ noTables: true });
  r = await call(env, '/dossier?symbol=NVDA');
  ok('before migration 0007 the dossier says which migration is missing (503)', r.status === 503 && /0007_dossier/.test(r.body.error));
  r = await call(env, '/ideas');
  ok('...and the ideas read as none', r.status === 200 && r.body.ideas === null);

  console.log('\nFundamentals for the ideas');
  env = mk(); W.reset();
  r = await call(env, '/fundamentals?symbols=NVDA,AMD,MSFT');
  ok('one Finnhub call per symbol, kept in one batch', r.status === 200 && W.count(/stock\/metric/) === 3 && Object.keys(r.body.items).length === 3 && env.DB.batches.includes(3));
  W.reset();
  r = await call(env, '/fundamentals?symbols=NVDA,AMD,MSFT');
  ok('...the same week: from D1, no call', W.calls.length === 0 && r.body.items.AMD.facts.pe === 48.2);
  ok('at most 25 symbols a request', (await call(env, '/fundamentals?symbols=' + Array.from({ length: 26 }, (_, i) => 'S' + i).join(','))).status === 400);
  W.reset(); W.empty.add('metric');
  r = await call(env, '/fundamentals?symbols=ZZZ');
  ok('a symbol Finnhub knows nothing of is listed as failed', r.body.failed.ZZZ && !r.body.items.ZZZ);
  r = await call(env, '/dossier?symbol=AMD');
  ok('the dossier shares the stored metric part', !W.calls.slice(-6).some((u) => /stock\/metric\?symbol=AMD/.test(u)) && r.body.parts.metric.facts.pe === 48.2);

  console.log('\nIdeas and short volume');
  env = mk();
  const idea = { v: 1, day: '2026-11-12', items: [{ symbol: 'NVDA', score: 0.8 }] };
  ok('ideas need v, day and items', (await call(env, '/ideas', { method: 'POST', body: { ideas: { v: 1, items: [] } } })).status === 400);
  r = await call(env, '/ideas', { method: 'POST', body: { ideas: idea } });
  ok('the runner\'s ideas are stored', r.status === 200 && env.DB.ideas.length === 1);
  for (let i = 0; i < 31; i++) await call(env, '/ideas', { method: 'POST', body: { ideas: { ...idea, day: '2026-10-' + String(i % 28 + 1).padStart(2, '0') } } });
  ok('...the last 30 kept', env.DB.ideas.length === 30);
  r = await call(env, '/ideas');
  ok('GET /ideas: the newest', r.status === 200 && r.body.ideas && r.body.ideas.v === 1);
  const day = (k) => new Date(Date.now() - k * DAY).toISOString().slice(0, 10);
  r = await call(env, '/short-volume', { method: 'POST', body: { rows: [{ symbol: 'NVDA', day: day(1), short: 40, total: 100 }, { symbol: 'NVDA', day: day(2), short: 30, total: 100 }, { symbol: 'NVDA', day: day(90), short: 1, total: 2 }] } });
  ok('short volume rows stored, older than 60 days dropped', r.status === 200 && env.DB.short.size === 2);
  ok('...a row with short over total is refused', (await call(env, '/short-volume', { method: 'POST', body: { rows: [{ symbol: 'NVDA', day: day(1), short: 101, total: 100 }] } })).status === 400);
  r = await call(env, '/dossier?symbol=NVDA&cik=1045810');
  ok('the dossier carries the short-volume ratios (FINRA, no call)', r.body.parts.short && r.body.parts.short.src === 'finra' && r.body.parts.short.facts.shortVolume[0].ratio === 0.4);

  console.log('\nThe ledger takes invest signals');
  env = mk();
  r = await call(env, '/signals', { method: 'POST', body: { signals: [{ id: 'sinv001', symbol: 'SPY', setup: 'accumulate', horizon: 'invest', dir: 'long', at: Date.now() - DAY, expires: Date.now() + 180 * DAY, verdict: 'GO', score: 100, entry: 500, stop: 450, zone: [495, 505], targets: [550, 600] }] } });
  ok('horizon invest is accepted', r.status === 200 && env.DB.signals.get('sinv001').horizon === 'invest', JSON.stringify(r.body));

  console.log('\nFile rules');
  const src = fs.readFileSync(path.join(__dirname, '..', 'workers2', 'quant-api', 'providers', 'fundamentals.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'workers2', 'quant-api', 'lib', 'dossier.js'), 'utf8');
  ok('no Finnhub price-target or candle URL in the dossier code', !/price-target|stock\/candle/.test(src));
  ok('no key in the code', !/token=[A-Za-z0-9]{12,}|apikey=[A-Za-z0-9]{8,}/.test(src));
  const mig = fs.readFileSync(path.join(__dirname, '..', 'workers2', 'quant-api', 'migrations', '0007_dossier.sql'), 'utf8');
  ok('migration 0007 only adds', !/\b(DROP|ALTER|DELETE|UPDATE)\b/i.test(mig.replace(/--.*$/gm, '')) && /CREATE TABLE IF NOT EXISTS dossier_parts/.test(mig));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
