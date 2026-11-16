// quant-api, Phase 13 (A1-Priv docs/TradeHub/quant/phase-13.md): the options,
// macro and earnings context. CBOE's chain compacted (same shape A1-Priv
// core/options.js reads), cached, AT MOST 2 CBOE calls a symbol a New York day,
// the 30-day IV logged once a day; FRED's CSV (no key) refreshed at most every
// 6 hours; Nasdaq's earnings calendar by date, resumable, never asking a day
// twice, only companies of $5B+; before migration 0012 a 503 that names it;
// the Orca key required; newshub is never called. A REAL SQLite D1 with every
// migration; outside services faked.
//
// Run: node tests/quant-context-api.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const QA = path.join(__dirname, '..', 'workers2', 'quant-api');
const MIG = path.join(QA, 'migrations');

function realD1({ skip = [] } = {}) {
  const sql = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql') && !skip.includes(x)).sort()) sql.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a.map(norm)),
    async first() { const r = sql.prepare(q).get(...args); return r ? { ...r } : null; },
    async all() { return { results: sql.prepare(q).all(...args).map((r) => ({ ...r })) }; },
    async run() { const r = sql.prepare(q).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { sql, prepare: (q) => stmt(q), async batch(list) { for (const s of list) await s.run(); return []; } };
}

// A CBOE answer: spot 100, contracts on 3 expiries + one too far out and strikes outside ±30%.
const ymd = (t) => new Date(t).toISOString().slice(2, 10).replace(/-/g, '');
function cboe(sym, now, iv30 = 31.5) {
  const ex = [4, 32, 60, 200].map((d) => now + d * 86400000), options = [];
  for (const t of ex) for (const k of [60, 90, 95, 100, 105, 110, 140]) for (const cp of ['C', 'P']) {
    options.push({ option: `${sym}${ymd(t)}${cp}${String(k * 1000).padStart(8, '0')}`, bid: 1.1, ask: 1.3, iv: 0.3, open_interest: 100, volume: 10, delta: cp === 'C' ? 0.5 : -0.5, gamma: 0.05 });
  }
  return { timestamp: 'x', data: { symbol: sym, current_price: 100, iv30, options } };
}
const W = { calls: [], down: new Set(), cboeNow: Date.now() };
const res = (body, status = 200, text = false) => new Response(text ? body : JSON.stringify(body), { status, headers: { 'content-type': text ? 'text/csv' : 'application/json' } });
globalThis.fetch = async (url) => {
  const u = String(url);
  W.calls.push(u);
  const h = /cboe\.com/.test(u) ? 'cboe' : /stlouisfed/.test(u) ? 'fred' : /nasdaq\.com/.test(u) ? 'nasdaq' : 'other';
  if (W.down.has(h)) return res({ error: 'down' }, 500);
  if (h === 'cboe') { const sym = /options\/([A-Z.]+)\.json/.exec(u)[1]; return res(cboe(sym, W.cboeNow)); }
  if (h === 'fred' && /releases\/calendar/.test(u)) {
    // The real page saved 2026-11-09 (CPI 2026) answers for every rid and year: only CPI rows for that year count.
    return res(fs.readFileSync(path.join(__dirname, 'fixtures', 'macro-schedule', 'fred-10-2026.html'), 'utf8'), 200, true);
  }
  if (h === 'fred') { const id = /id=([A-Z0-9]+)/.exec(u)[1]; return res('observation_date,' + id + '\n2026-11-12,3.20\n2026-11-13,.\n2026-11-14,3.23\n', 200, true); }
  if (h === 'nasdaq') {
    const d = /date=(\d{4}-\d{2}-\d{2})/.exec(u)[1];
    return res({ data: { rows: [
      { symbol: 'BIG', time: 'time-after-hours', eps: '$1.23', epsForecast: '$1.10', marketCap: '$90,000,000,000' },
      { symbol: 'LOSS', time: 'time-pre-market', eps: '($0.45)', epsForecast: '($0.50)', marketCap: '$6,000,000,000' },
      { symbol: 'TINY', time: 'time-pre-market', eps: '$0.10', epsForecast: '$0.09', marketCap: '$300,000,000' },
      { symbol: 'NOCAP', time: 'time-not-supplied', eps: '', epsForecast: '$0.20', marketCap: '' },
    ].map((r) => ({ ...r, d })) } });
  }
  return res({ error: 'no' }, 404);
};

(async () => {
  const Wk = (await import(pathToFileURL(path.join(QA, 'worker.js')).href)).default;
  const C = await import(pathToFileURL(path.join(QA, 'lib', 'context.js')).href);
  const O = await import(pathToFileURL(path.join(QA, 'providers', 'options.js')).href);
  const M = await import(pathToFileURL(path.join(QA, 'providers', 'macro.js')).href);
  const KEY = 'orca_sk_test_context_0123456789';
  const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');
  const call = async (env, method, p, body, { key = KEY } = {}) => {
    const r = await Wk.fetch(new Request('https://quant-api.test' + p, { method, headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
    let j = null; try { j = JSON.parse(await r.text()); } catch (e) {}
    return { status: r.status, body: j };
  };
  const env = { DB: realD1(), ALLOWED_KEYS: hash(KEY) };
  const cboeCalls = () => W.calls.filter((u) => /cboe/.test(u)).length;

  console.log('\nthe compact chain');
  const now = Date.UTC(2026, 10, 16, 15);
  const cc = O.compactChain(cboe('AAPL', now), now);
  ok('expiries within 120 days only (3 of 4), sorted', cc.expiries.length === 3 && cc.expiries[0].exp < cc.expiries[1].exp, cc.expiries.map((e) => e.exp));
  ok('strikes within ±30% of spot (60 and 140 dropped), each side by strike', cc.expiries.every((e) => e.c.map((r) => r[0]).join() === '90,95,100,105,110' && e.p.length === 5));
  ok('row = [k, bid, ask, iv, oi, vol, delta, gamma]', JSON.stringify(cc.expiries[0].c[2]) === JSON.stringify([100, 1.1, 1.3, 0.3, 100, 10, 0.5, 0.05]), JSON.stringify(cc.expiries[0].c[2]));
  ok('iv30 31.5 (percent) → 0.315; spot, delayed', cc.iv30 === 0.315 && cc.spot === 100 && cc.delayed === true && cc.symbol === 'AAPL');
  ok('OCC symbols parsed', JSON.stringify(O.parseOcc('AAPL261116C00275000')) === JSON.stringify({ root: 'AAPL', exp: '2026-11-16', type: 'C', k: 275 }) && O.parseOcc('junk') === null);
  ok('index symbols are not asked (their chains are 10+ MB)', !O.canAsk('^VIX') && !O.canAsk('_SPX') && O.canAsk('BRK.B'));

  console.log('\n/options: cached, at most 2 CBOE calls a symbol a day');
  W.cboeNow = Date.now();
  let r = await call(env, 'GET', '/options?symbol=NVDA');
  ok('first ask: fetched, labelled "15 min delayed"', r.status === 200 && r.body.chain && r.body.cached === false && r.body.calls === 1 && r.body.label === '15 min delayed', JSON.stringify(r.body).slice(0, 300));
  ok('one CBOE call, counted in the ledger', cboeCalls() === 1 && env.DB.sql.prepare("SELECT n FROM usage WHERE service='cboe'").get().n === 1);
  ok('the 30-day IV logged for today', r.body.ivLog.length === 1 && r.body.ivLog[0].iv === 0.315);
  r = await call(env, 'GET', '/options?symbol=NVDA');
  ok('asked again within 3 hours: the cache, no call', r.body.cached === true && cboeCalls() === 1);
  // 4 hours later: a second (last) call; then never a third that day.
  env.DB.sql.prepare("UPDATE options_cache SET at = at - 4*3600000 WHERE symbol='NVDA'").run();
  W.cboeNow = Date.now(); r = await call(env, 'GET', '/options?symbol=NVDA');
  ok('4 hours on: refreshed once more (calls 2)', r.body.cached === false && r.body.calls === 2 && cboeCalls() === 2, JSON.stringify(r.body).slice(0, 200));
  ok('the IV log keeps the day\'s first value (one row a day)', env.DB.sql.prepare("SELECT COUNT(*) n FROM iv_log WHERE symbol='NVDA'").get().n === 1);
  env.DB.sql.prepare("UPDATE options_cache SET at = at - 8*3600000 WHERE symbol='NVDA'").run();
  for (let i = 0; i < 5; i++) await call(env, 'GET', '/options?symbol=NVDA');
  ok('at 2 calls: never a third that day, however old (≤ 2 per symbol per day)', cboeCalls() === 2);
  ok('useCached: another day → fetch again', C.useCached({ day: '2000-01-01', calls: 2, at: Date.now() }, Date.now()) === false);
  W.down.add('cboe');
  r = await call(env, 'GET', '/options?symbol=AMD');
  ok('CBOE down and nothing cached: no chain, the reason said', r.status === 200 && r.body.chain === null && /CBOE/.test(r.body.note || ''), JSON.stringify(r.body));
  W.down.delete('cboe');
  r = await call(env, 'GET', '/options?symbol=%5EVIX');
  ok('an index symbol: no CBOE call, says it is not asked', r.status === 200 && r.body.chain === null && /not asked/.test(r.body.note) && cboeCalls() === 3, JSON.stringify(r.body));
  r = await call(env, 'GET', '/options');
  ok('no symbol → 400', r.status === 400);

  console.log('\n/macro: FRED without a key');
  const before = W.calls.length;
  r = await call(env, 'GET', '/macro');
  const fredCalls = W.calls.slice(before).filter((u) => /stlouisfed/.test(u));
  ok('every series once, from fredgraph.csv (no key)', fredCalls.length === Object.keys(M.SERIES).length && fredCalls.every((u) => /fredgraph\.csv\?id=/.test(u) && !/api_key/.test(u)), fredCalls.length);
  ok('missing days (".") left out', JSON.stringify(r.body.series.DGS10) === JSON.stringify([['2026-11-12', 3.2], ['2026-11-14', 3.23]]), JSON.stringify(r.body.series.DGS10));
  ok('names for the card', r.body.names.BAMLH0A0HYM2 === 'High-yield spread');
  const b2 = W.calls.length; await call(env, 'GET', '/macro');
  ok('asked again within 6 hours: no call', W.calls.length === b2);

  console.log('\n/macro/dates: past release days from FRED\'s calendar');
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'macro-schedule', 'fred-10-2026.html'), 'utf8');
  const cpi26 = M.parseFredCalendar(html, 10, 2026);
  ok('the real CPI 2026 page: 11+ weekday dates, all in 2026', cpi26.length >= 11 && cpi26.every((d) => d.startsWith('2026-') && ![0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())), JSON.stringify(cpi26));
  ok('another rid on the same page → none', M.parseFredCalendar(html, 46, 2026).length === 0);
  const d0 = W.calls.length;
  r = await call(env, 'GET', '/macro/dates');
  const year = new Date().getUTCFullYear(), years = year - 2025 + 1, kinds = Object.keys(M.RIDS).length;
  ok('each kind × year from 2025 asked once (at most 20 a call)', W.calls.length - d0 === Math.min(20, kinds * years), W.calls.length - d0);
  ok('CPI days come back sorted', Array.isArray(r.body.dates.cpi) && r.body.dates.cpi.join() === cpi26.join(), JSON.stringify(r.body.dates.cpi));
  const d1 = W.calls.length; await call(env, 'GET', '/macro/dates');
  ok('asked again the same week: no call when everything was read', kinds * years > 20 || W.calls.length === d1);

  console.log('\n/earnings: Nasdaq by date, resumable, never a day twice');
  const at20 = Date.UTC(2026, 10, 17, 2);   // 21:00 New York on Mon Nov 16
  const nightly = C.daysToAsk('nightly', new Set(), { now: at20 });
  ok('nightly after 20:00 New York: today and the 6 weekdays before (7)', nightly.length === 7 && nightly[0] === '2026-11-16' && !nightly.some((d) => [0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())), JSON.stringify(nightly));
  ok('nightly before 20:00: from yesterday', C.daysToAsk('nightly', new Set(), { now: Date.UTC(2026, 10, 16, 18) })[0] === '2026-11-13');
  ok('a day already asked is never asked again', !C.daysToAsk('nightly', new Set(['2026-11-16']), { now: at20 }).includes('2026-11-16'));
  const bf = C.daysToAsk('backfill', new Set(), { now: at20, max: 5, oldest: '2026-11-06' });
  ok('backfill walks back from the oldest day asked', bf[0] === '2026-11-05' && bf.length === 5, JSON.stringify(bf));
  ok('never further back than 10 years', C.daysToAsk('backfill', new Set(), { now: at20, max: 40, oldest: '2016-11-20' }).every((d) => d >= '2016-11-15'));
  const nb = W.calls.length;
  r = await call(env, 'POST', '/earnings/fetch', { mode: 'backfill', max: 3 });
  ok('backfill: 3 days asked, one Nasdaq call each', r.status === 200 && r.body.asked.length === 3 && W.calls.slice(nb).filter((u) => /nasdaq/.test(u)).length === 3, JSON.stringify(r.body));
  ok('only $5B+ kept (BIG, LOSS), not TINY or one with no cap', r.body.stored === 6 && env.DB.sql.prepare("SELECT COUNT(*) n FROM earnings WHERE symbol IN ('TINY','NOCAP')").get().n === 0);
  const first = r.body.asked;
  r = await call(env, 'POST', '/earnings/fetch', { mode: 'backfill', max: 3 });
  ok('resumed: the next 3 days back, none repeated', r.body.asked.length === 3 && r.body.asked.every((d) => !first.includes(d) && d < first[first.length - 1]), JSON.stringify([first, r.body.asked]));
  r = await call(env, 'GET', '/earnings?symbols=BIG,LOSS,NONE');
  const big = r.body.reports.BIG;
  ok('GET: each symbol\'s reports, oldest first, with time and EPS', big.length === 6 && big[0].day < big[5].day && big[0].time === 'amc' && big[0].eps === 1.23 && big[0].est === 1.1 && r.body.reports.NONE.length === 0, JSON.stringify(big[0]));
  ok('negative EPS read from "($0.45)"', r.body.reports.LOSS[0].eps === -0.45 && r.body.reports.LOSS[0].time === 'bmo');
  ok('GET says which days have been asked', r.body.asked && r.body.asked.days === 6);
  W.down.add('nasdaq');
  r = await call(env, 'POST', '/earnings/fetch', { mode: 'backfill', max: 3 });
  ok('Nasdaq down: stops, says so, marks nothing asked', r.body.asked.length === 0 && /Nasdaq/.test(r.body.stop || '') && env.DB.sql.prepare('SELECT COUNT(*) n FROM earnings_days').get().n === 6, JSON.stringify(r.body));
  W.down.delete('nasdaq');

  console.log('\nbefore the migration, the key, newshub');
  const bare = { DB: realD1({ skip: ['0012_context.sql'] }), ALLOWED_KEYS: hash(KEY) };
  r = await call(bare, 'GET', '/options?symbol=NVDA');
  ok('no tables yet: 503 naming the migration', r.status === 503 && /0012_context\.sql/.test(r.body.error), JSON.stringify(r.body));
  r = await call(env, 'GET', '/macro', null, { key: null });
  ok('no Orca key → refused', r.status === 401 || r.status === 403, r.status);
  ok('newshub is never called (its subrequest budget is untouched)', !W.calls.some((u) => /newshub/.test(u)));
  const ctxSrc = fs.readFileSync(path.join(QA, 'lib', 'context.js'), 'utf8') + fs.readFileSync(path.join(QA, 'providers', 'options.js'), 'utf8') + fs.readFileSync(path.join(QA, 'providers', 'macro.js'), 'utf8');
  ok('no newshub address anywhere in the context code', !/newshub/.test(ctxSrc));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
