// newshub-api's intraday refresh and /market (2026-11-03).
//
//   1. isRegularSessionET: weekdays 9:30 to 16:15 ET (13:15 on a half day), never
//      on a weekend or an NYSE holiday, right across a DST change.
//   2. /news?intraday=1 rebuilds only a build older than 45 min, on the ordinary
//      (non-fresh) path: it never spends the 12-a-day force budget.
//   3. /market: futures/yield/oil/VIX/dollar from one batched Yahoo call, and per
//      stock today's move plus the pre- or after-hours price when the latest trade
//      sits in that session.
//
// Run: node tests/newshub-market.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workers', 'newshub-api', 'worker.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
const between = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker ' + a); return SRC.slice(i, j); };

const code = between('function mktDow(', '// Holiday/half-day events within')
  + between('// ── Intraday news refresh', 'function isCronBuildHour(')
  + '\nmodule.exports = { isRegularSessionET, buildMarket, sparkStock, INTRADAY_REFRESH_MS, MARKET_CONTEXT };';
let sparkCalls = [];
let sparkReply = null;
const sb = { module: { exports: {} }, Intl, Date, Math, AbortSignal, encodeURIComponent, console,
  fetch: async (u) => { sparkCalls.push(u); return { ok: true, status: 200, json: async () => sparkReply(u) }; } };
vm.createContext(sb);
vm.runInContext(code, sb);
const M = sb.module.exports;

console.log('the regular session, in New York time');
const at = (iso) => Date.parse(iso);
ok('Tue 10:00 ET (EST) is open', M.isRegularSessionET(at('2026-11-03T15:00:00Z')));
ok('Tue 9:29 ET is not yet', !M.isRegularSessionET(at('2026-11-03T14:29:00Z')));
ok('16:15 ET still counts (the closing news)', M.isRegularSessionET(at('2026-11-03T21:15:00Z')));
ok('16:16 ET does not', !M.isRegularSessionET(at('2026-11-03T21:16:00Z')));
ok('in daylight time too: Fri 2026-10-30 10:00 EDT', M.isRegularSessionET(at('2026-10-30T14:00:00Z')));
ok('Saturday is closed', !M.isRegularSessionET(at('2026-11-07T15:00:00Z')));
ok('Thanksgiving is closed', !M.isRegularSessionET(at('2026-11-26T15:00:00Z')));
ok('the day after closes at 13:00 (13:15 counts, 13:16 not)', M.isRegularSessionET(at('2026-11-27T18:15:00Z')) && !M.isRegularSessionET(at('2026-11-27T18:16:00Z')));
ok('the refresh age is 45 minutes', M.INTRADAY_REFRESH_MS === 45 * 60000);

console.log('/news?intraday=1');
const news = SRC.slice(SRC.indexOf("if (url.pathname !== '/news')"));
ok('a cache hit is skipped only when the intraday rebuild is due', /if \(!fresh && cachedRaw && cachedHasEvents && !intradayDue\)/.test(news));
ok('due = asked + real news cached + regular session + older than 45 min',
  /intradayDue = url\.searchParams\.get\('intraday'\) === '1' && cachedHasEvents\s*&& isRegularSessionET\(Date\.now\(\)\) && Date\.now\(\) - cachedGen > INTRADAY_REFRESH_MS/.test(news));
ok('it never counts as a force: the budget is only checked and bumped on fresh', !/intraday[^\n]*(checkRateLimit|bumpRateLimit)/.test(news) && /useLimited = fresh;/.test(news));

console.log('/market');
const NOW = Math.floor(Date.now() / 1000);
const per = (s, e) => ({ start: NOW + s, end: NOW + e });
const row = (symbol, meta, closes, lastTsOff) => ({ symbol, response: [{ meta, timestamp: closes.map((_, i) => NOW + lastTsOff - (closes.length - 1 - i) * 300), indicators: { quote: [{ close: closes }] } }] });
sparkReply = (u) => ({ spark: { result: [
  row('ES=F', { chartPreviousClose: 6800 }, [6810, 6820, 6834], -10),
  row('^TNX', { chartPreviousClose: 4.894 }, [4.9, 4.952], -10),
  row('NVDA', { regularMarketPrice: 206.69, chartPreviousClose: 202.06, currentTradingPeriod: { pre: per(-60000, -40000), regular: per(-40000, -3000), post: per(-3000, 10000) } }, [205, 206.69, null, 205.5], -60),
  row('MU', { regularMarketPrice: 840, chartPreviousClose: 833.59, currentTradingPeriod: { pre: per(-1000, 5000), regular: per(5000, 30000), post: per(30000, 40000) } }, [845, 849.49], -30),
].filter(r => u.includes(encodeURIComponent(r.symbol))) } });
(async () => {
  const r = await M.buildMarket(['NVDA', 'MU']);
  ok('one batched call for context + tickers', sparkCalls.length === 1 && /range=1d/.test(sparkCalls[0]) && /includePrePost=true/.test(sparkCalls[0]), sparkCalls.join(' '));
  const es = r.context.find(c => c.key === 'es'), tnx = r.context.find(c => c.key === 'tnx');
  ok('S&P futures: last price and change vs the prior settle', es.price === 6834 && Math.abs(es.dp - 0.5) < 1e-9, JSON.stringify(es));
  ok('the 10-year yield keeps its unit', tnx.unit === '%' && tnx.price === 4.952);
  ok('a context symbol Yahoo did not return is an empty tile, not an error', r.context.find(c => c.key === 'vix').price === null);
  const nv = r.stocks.NVDA, mu = r.stocks.MU;
  ok('a stock: today\'s regular-session move', Math.abs(nv.dp - (206.69 - 202.06) / 202.06 * 100) < 1e-9 && nv.c === 206.69);
  ok('after hours: the post price vs the close', nv.ext && nv.ext.kind === 'post' && nv.ext.price === 205.5 && Math.abs(nv.ext.dp - (205.5 - 206.69) / 206.69 * 100) < 1e-9, JSON.stringify(nv.ext));
  ok('pre-market: the pre price vs the prior close', mu.ext && mu.ext.kind === 'pre' && Math.abs(mu.ext.dp - (849.49 - 833.59) / 833.59 * 100) < 1e-9, JSON.stringify(mu.ext));
  ok('sparkline points skip the gaps', JSON.stringify(nv.points) === '[205,206.69,205.5]', JSON.stringify(nv.points));
  ok('ok:true when anything came back', r.ok === true && r.source === 'yahoo');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
