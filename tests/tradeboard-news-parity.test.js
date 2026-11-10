// Veda's news worker (V1/workers/tradeboard-news) carries newshub-api's fixes
// (2026-11-09 parity sweep). The real code is lifted out of her worker.js:
//   1. finalizeEvents: one card per event, the first AI verdict per id — a
//      re-delivered AI window and the omission retries used to show the same
//      story two or three times
//   2. the raw fill in runPipeline marks each event filled, so its retry
//      batches can't raw-fill it again
//   3. /news?intraday=1 rebuilds a feed older than 45 min during the regular
//      session only (holidays, half days and weekends included)
//   4. /quotes is cached in the Cache API (no KV write per poll) and only when
//      quotes came back
//   5. the functions newshub-api and her worker share stay the same where
//      newshub-api fixed them (finalizeEvents, the session clock, /quotes)
//
// Run: node tests/tradeboard-news-parity.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(process.env.TBNEWS_SRC || path.join(ROOT, 'V1', 'workers', 'tradeboard-news', 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
const NH = fs.readFileSync(path.join(ROOT, 'workers', 'newshub-api', 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
const fnOf = (src, name) => { const m = new RegExp('\\nfunction ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n').exec(src); return m ? m[0] : null; };
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); return i < 0 || j < 0 ? null : src.slice(i, j); };

console.log('1. finalizeEvents');
const fin = fnOf(SRC, 'finalizeEvents');
ok('her worker defines finalizeEvents', !!fin);
if (fin) {
  const sb = { module: { exports: {} }, Math, Set, Array, Date, String };
  vm.createContext(sb);
  vm.runInContext(fin + '\nmodule.exports = finalizeEvents;', sb);
  const f = sb.module.exports;
  const ev = (id, t) => ({ id, candidateTickers: [t], sources: [{ headline: 'H ' + id }], sourceCount: 1, ts: 1 });
  const ai = (id, s) => ({ id, primaryTicker: 'NVDA', summary: s, aiAnalyzed: true });
  let out;
  try { out = f([ev('a', 'NVDA'), ev('b', 'NVDA'), ev('b', 'NVDA')], [ai('a', 'first'), ai('a', 'second')], ['NVDA']); } catch (e) { out = { err: e.message }; }
  const list = Array.isArray(out) ? out : (out && (out.events || out.enriched)) || [];
  const ids = list.map(e => e.id);
  ok('an AI verdict delivered twice makes one card, the first', ids.filter(x => x === 'a').length === 1 && (list.find(e => e.id === 'a') || {}).summary === 'first', JSON.stringify(out).slice(0, 300));
  ok('an event repeated in the input is raw-filled once', ids.filter(x => x === 'b').length === 1, ids.join(','));
}

console.log('\n2. the raw fill in runPipeline');
const rp = between(SRC, '// ── Per-batch raw fallback', 'const headline = ev.sources?.[0]?.headline');
ok('each raw-filled event is marked filled before its card is made', !!rp && /enrichedIds\.add\(ev\.id\);\s*\n\s*$/.test(rp), rp && rp.slice(-300));

console.log('\n3. intraday');
const clock = between(SRC, '// ── Intraday news refresh (2026-11-03)', '// ── /market: the market at a glance');
const mkt = between(SRC, 'function mktDow(', 'function mktComputeYear(') !== null ? between(SRC, 'function mktDow(', '// Holiday/half-day events within') : null;
ok('her worker has the session clock', !!clock && !!mkt);
if (clock && mkt) {
  const sb = { module: { exports: {} }, Intl, Date, Math };
  vm.createContext(sb);
  vm.runInContext(mkt + clock + '\nmodule.exports = { isRegularSessionET, INTRADAY_REFRESH_MS };', sb);
  const { isRegularSessionET, INTRADAY_REFRESH_MS } = sb.module.exports;
  const at = (iso) => isRegularSessionET(Date.parse(iso));
  ok('a Tuesday at 10:00 ET is the session', at('2026-11-03T15:00:00Z'));
  ok('9:29 ET is not yet', !at('2026-11-03T14:29:00Z'));
  ok('16:15 ET still counts (the closing news)', at('2026-11-03T21:15:00Z'));
  ok('16:16 ET does not', !at('2026-11-03T21:16:00Z'));
  ok('a Saturday never', !at('2026-11-07T16:00:00Z'));
  ok('Thanksgiving (NYSE closed) never', !at('2026-11-26T16:00:00Z'));
  ok('the day after Thanksgiving closes at 13:00 (13:15 counts, 13:16 does not)', at('2026-11-27T18:15:00Z') && !at('2026-11-27T18:16:00Z'));
  ok('a feed counts as stale after 45 minutes', INTRADAY_REFRESH_MS === 45 * 60 * 1000);
}
const news = between(SRC, "const intradayDue = url.searchParams.get('intraday') === '1'", "// ── Peek mode (?cacheOnly=1)");
ok('/news?intraday=1 skips the cache hit only for a stale feed during the session', !!news && /isRegularSessionET\(Date\.now\(\)\) && Date\.now\(\) - cachedGen > INTRADAY_REFRESH_MS/.test(news) && /if \(!fresh && cachedRaw && cachedHasEvents && !intradayDue\)/.test(news));

console.log('\n4. /quotes');
const q = between(SRC, "if (url.pathname === '/quotes'){", "// ── /_stage — INTERNAL staged-build worker.");
ok('/quotes reads and writes the Cache API, not KV', !!q && /caches\.default\.match/.test(q) && /caches\.default\.put/.test(q) && !/NEWSHUB_CACHE\.(get|put)/.test(q));
ok('…and caches only quotes that came back', !!q && /if \(quotes && Object\.keys\(quotes\)\.length\)\{/.test(q));

console.log('\n5. the same code as newshub-api where it was fixed');
const norm = (s) => (s || '').split('\n').map(l => l.replace(/\/\/.*$/, '').trim()).filter(Boolean).join('\n');
ok('finalizeEvents matches newshub-api', norm(fnOf(SRC, 'finalizeEvents')) === norm(fnOf(NH, 'finalizeEvents')));
ok('the session clock matches newshub-api', norm(fnOf(SRC, 'isRegularSessionET')) === norm(fnOf(NH, 'isRegularSessionET')) && norm(fnOf(SRC, 'etClock')) === norm(fnOf(NH, 'etClock')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
