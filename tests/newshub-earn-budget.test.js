// newshub-api's earnings calendar on a 40-ticker list (Quant Refinements Batch 2 B2, 2026-11-20).
// A build may make 50 subrequests. Finnhub's earnings route is per-symbol, so a followed list the
// size of Tony's Webull Main (~40) plus Nasdaq's ~22 daily pages would not fit. Nasdaq and
// AlphaVantage now run first and Finnhub is asked only about tickers they do not already agree on,
// within what is left. This suite lifts earnFinnhubTargets out of worker.js and checks the wiring.
//
// Run: node tests/newshub-earn-budget.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workers', 'newshub-api', 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

const start = SRC.indexOf('const EARN_SUBREQ_TOTAL');
const end = SRC.indexOf('async function fetchEarningsCalendar(');
ok('the rule is in worker.js', start > 0 && end > start);
const ctx = {};
vm.runInNewContext(SRC.slice(start, end) + '\nthis.earnFinnhubTargets = earnFinnhubTargets; this.TOTAL = EARN_SUBREQ_TOTAL; this.RESERVE = EARN_SUBREQ_RESERVE;', ctx);
const pick = ctx.earnFinnhubTargets;

const wl = Array.from({ length: 40 }, (_, i) => 'T' + i);
const nas = [{ ticker: 'T0', date: '2026-12-01' }, { ticker: 'T1', date: '2026-12-02' }, { ticker: 'T2', date: '2026-12-03' }];
const av = [{ ticker: 'T0', date: '2026-12-01' }, { ticker: 'T1', date: '2026-12-05' }, { ticker: 'T3', date: '2026-12-04' }];
let out = pick(wl, nas, av, 100);
ok('a ticker Nasdaq and AlphaVantage agree on is not asked of Finnhub (T0)', !out.includes('T0'));
ok('...one they disagree on, or that only one lists, still is (T1, T2, T3)', ['T1', 'T2', 'T3'].every((t) => out.includes(t)));
ok('...tickers with no date anywhere come first, then the single-source ones', out.indexOf('T4') < out.indexOf('T1') && out[0] === 'T4', out.slice(0, 5).join());
out = pick(wl, nas, av, 46 - 22);
ok('a 40-ticker list with 22 Nasdaq pages: Finnhub gets what is left (24), never more', out.length === 24);
ok('...no budget left: Finnhub is not asked at all', pick(wl, nas, av, -3).length === 0);
ok('the whole build stays inside 50: Nasdaq pages + reserve + Finnhub', ctx.TOTAL === 50 && ctx.RESERVE >= 3);

const build = SRC.slice(SRC.indexOf('async function buildCalendar('), SRC.indexOf('async function buildCalendar(') + 4000);
ok('buildCalendar runs Nasdaq and AlphaVantage before Finnhub', build.indexOf('fetchEarningsNasdaq(wl') > 0 && build.indexOf('fetchEarningsCalendar(fhList') > build.indexOf('fetchEarningsNasdaq(wl'));
ok('...and gives Finnhub the budget left after the pages Nasdaq actually asked for', /const fhBudget = EARN_SUBREQ_TOTAL - EARN_SUBREQ_RESERVE - cov\.nasdaqTries;/.test(build));
ok('Nasdaq counts every page it asks for (retries too)', /cov\.nasdaqTries = \(cov\.nasdaqTries \|\| 0\) \+ 1;/.test(SRC));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
