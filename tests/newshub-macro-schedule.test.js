// newshub-api's macro schedule feed (2026-11-09).
//
// The official release calendars are read once a day (refreshMacroSchedule) instead
// of being typed into worker.js every December. This suite runs the real code,
// lifted out of worker.js, against the agencies' real pages (saved in
// tests/fixtures/macro-schedule, fetched 2026-11-09) and walks every case the
// Catalysts warning has to catch.
//
//   1. parsers: FRED, BEA (.ics), Census, the Fed, the ECB — real pages, plus
//      folded lines, cross-month meetings, notation votes, empty/changed pages
//   2. msCheckList: what a believable year looks like
//   3. msMergeRun: first run, a source down, a moved date, a shrunken list, a
//      rejected list, agency vs FRED, sources that list only what is ahead
//   4. authoritativeMacro / computedMacro: official years, built-in fallback,
//      next year's rule-based releases, jobless claims on holiday weeks
//   5. mergeAiMacro: AI dropped where the schedule covers the year, flagged
//      (approx) where it doesn't, untouched for releases nobody schedules
//   6. macroScheduleStatus: every warning, and silence when all is well
//   7. wiring + budget: the 06:20 tick, ~19 fetches, ONE KV write per refresh
//
// Run: node tests/newshub-macro-schedule.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = process.env.NEWSHUB_SRC || path.join(ROOT, 'workers', 'newshub-api', 'worker.js');
const TOML_PATH = process.env.NEWSHUB_TOML || path.join(ROOT, 'workers', 'newshub-api', 'wrangler.toml');
const FIX = process.env.MACRO_FIXTURES || path.join(__dirname, 'fixtures', 'macro-schedule');
const SRC = fs.readFileSync(SRC_PATH, 'utf8').replace(/\r\n/g, '\n');
const TOML = fs.readFileSync(TOML_PATH, 'utf8');
const fx = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) : '')); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const between = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker ' + a); return SRC.slice(i, j); };

const code = between('function mktDow(', 'function mktComputeYear(')
  + between('// ── AUTHORITATIVE macro release calendar', '// Today / +N days as YYYY-MM-DD')
  + '\nmodule.exports = { MACRO_BUILTIN, MS_SERIES, MS_KEY, MS_UA, msParseFred, msParseBea, msParseCensus, msParseFomc, msParseEcb, msCheckList, msMergeRun, msFetchAll, refreshMacroSchedule, msYearsOf, msOfficial, macroSeriesOf, macroCovered, macroScheduleStatus, authoritativeMacro, computedMacro, mergeAiMacro, macroOfficialYears, fedHolidaySet, msEtDate };';
const sb = { module: { exports: {} }, Intl, Date, Math, JSON, Promise, AbortSignal, console, Object, Set, Map, Array, String, Number, RegExp, Error };
vm.createContext(sb);
vm.runInContext(code, sb);
const M = sb.module.exports;
const B = M.MACRO_BUILTIN;
const ET = (iso) => Date.parse(iso);          // instants given in UTC
const y = (rows, yr) => rows.filter(r => r.date.startsWith(String(yr))).map(r => r.date);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. Parsers, on the agencies\' real pages');
const fred = {};
for (const [rid, yr] of [[10,2026],[46,2026],[50,2026],[192,2026],[54,2026],[53,2026],[9,2026],[9,2025],[10,2027]]) fred[rid + '-' + yr] = M.msParseFred(fx(`fred-${rid}-${yr}.html`), rid, yr);
ok('FRED CPI 2026 = the 12 dates of the published 2026 table', eq(fred['10-2026'].rows.map(r => r.date), B.cpi), fred['10-2026'].rows);
ok('FRED jobs 2026 = the published table', eq(fred['50-2026'].rows.map(r => r.date), B.jobs));
ok('FRED PPI 2026 has the shutdown-moved dates (13 releases, Jan 14 not Jan 15)', fred['46-2026'].rows.length === 13 && fred['46-2026'].rows[0].date === '2026-01-14');
ok('FRED PPI agrees with the table from here on (Nov 13, Dec 15)', eq(fred['46-2026'].rows.slice(-2).map(r => r.date), ['2026-11-13','2026-12-15']));
ok('FRED JOLTS 2026: 12 releases, ends Dec 1', fred['192-2026'].rows.length === 12 && fred['192-2026'].rows[11].date === '2026-12-01');
ok('FRED retail 2025 includes the annual-revision day (Apr 25) the agency files separately', y(fred['9-2025'].rows, 2025).includes('2025-04-25'));
ok('FRED 2027 page before publication: no dates, not mistaken for another year', fred['10-2027'].rows.length === 0 && !fred['10-2027'].truncated);
ok('FRED rows of another release on the page are ignored', M.msParseFred(fx('fred-10-2026.html'), 46, 2026).rows.length === 0);
ok('FRED rows of another year are ignored', M.msParseFred(fx('fred-10-2026.html'), 10, 2027).rows.length === 0);
ok('FRED paged list is flagged, not taken as the whole year', M.msParseFred('Friday January 09, 2026 <a href="/release?rid=50">x</a> Releases 1 - 50 of 73', 50, 2026).truncated);

const bea = M.msParseBea(fx('bea.ics'));
const pce27 = bea.by.pce.filter(r => r.date.startsWith('2027')), gdp27 = bea.by.gdp.filter(r => r.date.startsWith('2027'));
ok('BEA 2027 PCE: 12 releases, Jan 28 covers December', pce27.length === 12 && pce27[0].date === '2027-01-28' && pce27[0].ref === 'December', pce27.slice(0, 2));
ok('BEA 2027 GDP: 12 national estimates, Jan 28 = Q4 2026', gdp27.length === 12 && gdp27[0].ref === 'Q4 2026', gdp27.slice(0, 2));
ok('BEA GDP by county/state rows are not GDP releases (Dec 2 2026, Dec 1 2027)', !bea.by.gdp.some(r => r.date === '2026-12-02' || r.date === '2027-12-01'));
ok('BEA "GDP by State" rows that name a quarter are not GDP releases either (Jan 23 2026, Mar 28 2025)', !bea.by.gdp.some(r => r.date === '2026-01-23' || r.date === '2025-03-28'));
ok('BEA shutdown catch-up PCE keeps its two-month period ("October and November")', bea.by.pce.some(r => r.date === '2026-01-22' && r.ref === 'October and November'));
ok('BEA folded lines are unfolded (Q3 2026 third estimate, Dec 23 2026)', bea.by.gdp.some(r => r.date === '2026-12-23' && r.ref === 'Q3 2026'));
ok('BEA forward 2026 dates agree with the table (Nov 25, Dec 23)', ['2026-11-25','2026-12-23'].every(d => bea.by.pce.some(r => r.date === d) && bea.by.gdp.some(r => r.date === d)));
const icsSyn = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Personal Income and Outlays\\, Decem\r\n ber 2030\r\nDTSTART;VALUE=DATE-TIME:20310129T033000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:GDP (Advance Estimate)\\, 4th Quarter and Year 2030\r\nDTSTART;TZID=America/New_York:20310130T083000\r\nEND:VEVENT\r\nEND:VCALENDAR';
const bs = M.msParseBea(icsSyn);
ok('ICS: a line folded mid-word, CRLF, UTC time converted to the New York date (03:30Z = previous evening)', bs.by.pce.length === 1 && bs.by.pce[0].date === '2031-01-28' && bs.by.pce[0].ref === 'December', bs.by.pce);
ok('ICS: a local (TZID) time keeps its own date', bs.by.gdp.length === 1 && bs.by.gdp[0].date === '2031-01-30' && bs.by.gdp[0].ref === 'Q4 2030');

const cen = M.msParseCensus(fx('census.html'));
ok('Census 2027 retail: 12 releases, Jan 15 covers December', cen.rows.length === 12 && cen.rows[0].date === '2027-01-15' && cen.rows[0].ref === 'December', cen.rows.slice(0, 2));
ok('Census: only "Advance Monthly Sales for Retail", not the advance indicators report', cen.rows.every(r => r.date >= '2027-01-01'));

const fomc = M.msParseFomc(fx('fomc.html'));
ok('Fed 2027: the 8 decision days (meeting\'s second day)', eq(y(fomc.rows, 2027), ['2027-01-27','2027-03-17','2027-04-28','2027-06-09','2027-07-28','2027-09-15','2027-10-27','2027-12-08']), y(fomc.rows, 2027));
ok('Fed 2026 = the published table', eq(y(fomc.rows, 2026), B.fomc), y(fomc.rows, 2026));
ok('Fed "Jan/Feb 31-1" decides on Feb 1', /Jan\/Feb/.test(fx('fomc.html')) && fomc.rows.some(r => /-02-01$/.test(r.date)));
ok('Fed notation vote (Aug 22 2025) is not a meeting; 2025 has its 8 decisions', !fomc.rows.some(r => r.date === '2025-08-22') && y(fomc.rows, 2025).length === 8, y(fomc.rows, 2025));
const fomcSyn = M.msParseFomc('<h4>2031 FOMC Meetings</h4><div class="fomc-meeting__month"><strong>April</strong></div><div class="fomc-meeting__date">30-1</div><div class="fomc-meeting__month"><strong>Dec</strong></div><div class="fomc-meeting__date">30-31*</div><div class="fomc-meeting__month"><strong>March</strong></div><div class="fomc-meeting__date">9 (unscheduled)</div>');
ok('Fed: "30-1" under a single month rolls into the next month; "Dec" abbreviation; unscheduled skipped', eq(fomcSyn.rows.map(r => r.date), ['2031-05-01','2031-12-31']), fomcSyn.rows);

const ecb = M.msParseEcb(fx('ecb.html'));
ok('ECB 2027 = the 8 decisions of its published calendar', eq(y(ecb.rows, 2027), B.ecb.filter(d => d.startsWith('2027'))), y(ecb.rows, 2027));
ok('ECB Dec 17 2026 decision found; non-monetary meetings never count', ecb.rows.some(r => r.date === '2026-12-17') && !ecb.rows.some(r => r.date === '2026-11-26'));

ok('a page that changed format gives no rows (not a guess)', [M.msParseFred('<html>new</html>', 10, 2026).rows, M.msParseBea('').by.pce, M.msParseCensus('<table></table>').rows, M.msParseFomc('<p/>').rows, M.msParseEcb('<dl></dl>').rows].every(r => r.length === 0));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. msCheckList');
ok('real lists pass (FRED CPI/PPI/JOLTS 2026, BEA PCE 2027, Fed 2027, ECB 2027)',
  M.msCheckList('cpi', 2026, B.cpi).ok && M.msCheckList('ppi', 2026, fred['46-2026'].rows.map(r => r.date)).ok
  && M.msCheckList('jolts', 2026, fred['192-2026'].rows.map(r => r.date)).ok && M.msCheckList('pce', 2027, pce27.map(r => r.date)).ok
  && M.msCheckList('fomc', 2027, y(fomc.rows, 2027)).ok && M.msCheckList('ecb', 2027, y(ecb.rows, 2027)).ok);
ok('FRED retail 2025/2026 pass (revision days and catch-ups are at most 2 a month)', M.msCheckList('retail', 2025, y(fred['9-2025'].rows, 2025)).ok && M.msCheckList('retail', 2026, fred['9-2026'].rows.map(r => r.date)).ok);
const swap = (arr, i, d) => arr.map((x, k) => k === i ? d : x);
ok('a weekend date is rejected', !M.msCheckList('cpi', 2026, swap(B.cpi, 3, '2026-04-11')).ok);
ok('a federal holiday is rejected (Thanksgiving 2026-11-26)', /holiday/.test(M.msCheckList('cpi', 2026, swap(B.cpi, 10, '2026-11-26')).reason || ''));
ok('a date from another year is rejected', !M.msCheckList('cpi', 2026, swap(B.cpi, 0, '2027-01-13')).ok);
ok('10 releases is too few', M.msCheckList('cpi', 2026, B.cpi.slice(0, 10)).short === true);
ok('a half-loaded year (Jan-Jun) is not a year, even padded to 12', !M.msCheckList('cpi', 2026, ['2026-01-13','2026-01-27','2026-02-13','2026-02-25','2026-03-11','2026-03-25','2026-04-10','2026-04-24','2026-05-12','2026-05-27','2026-06-10','2026-06-24']).ok);
ok('3 releases in one month is rejected', !M.msCheckList('cpi', 2026, [...B.cpi, '2026-03-25', '2026-03-26'].sort()).ok);
ok('FOMC decisions under 3 weeks apart are rejected', !M.msCheckList('fomc', 2026, [...B.fomc, '2026-02-04'].sort()).ok);
ok('7 FOMC decisions is too few', !M.msCheckList('fomc', 2027, y(fomc.rows, 2027).slice(1)).ok);
ok('ECB dates are not checked against US holidays (a Nov 11 decision is fine)', M.msCheckList('ecb', 2027, y(ecb.rows, 2027).map((d, i) => i === 6 ? '2027-11-11' : d).sort()).ok);
ok('federal holidays: New Year on a Saturday is observed Fri Dec 31 of the year before (2027-12-31)', M.fedHolidaySet(2027).has('2027-12-31') && ![...M.fedHolidaySet(2028)].some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || d.endsWith('-00')));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. msMergeRun');
const now = ET('2026-11-09T14:00:00Z');       // 9 AM ET, today
// A run built from the real pages, the way msFetchAll would shape it.
function realFetched(over){
  const lists = {};
  const put = (s, yr, w, rows) => { ((lists[s] = lists[s] || {})[yr] = lists[s][yr] || {})[w] = rows; };
  const rid = { cpi:10, ppi:46, jobs:50, jolts:192, pce:54, gdp:53, retail:9 };
  for (const [s, r] of Object.entries(rid)){ put(s, 2026, 'fred', fred[r + '-2026'] ? fred[r + '-2026'].rows : []); put(s, 2027, 'fred', []); }
  for (const yr of [2026, 2027]){
    put('pce', yr, 'primary', bea.by.pce.filter(r => r.date.startsWith(String(yr))));
    put('gdp', yr, 'primary', bea.by.gdp.filter(r => r.date.startsWith(String(yr))));
    put('retail', yr, 'primary', cen.rows.filter(r => r.date.startsWith(String(yr))));
    put('fomc', yr, 'primary', fomc.rows.filter(r => r.date.startsWith(String(yr))));
    put('ecb', yr, 'primary', ecb.rows.filter(r => r.date.startsWith(String(yr))));
  }
  const f = { sources: { fred:{ok:true}, bea:{ok:true}, census:{ok:true}, fed:{ok:true}, ecb:{ok:true} }, lists };
  return over ? over(f) || f : f;
}
const r1 = M.msMergeRun(null, realFetched(), now);
const has = (r, s, yr) => !!(r.series[s] && r.series[s][yr]);
ok('first run: every 2026 list official (FRED for BLS, BEA/FRED, FRED retail, Fed)', ['cpi','ppi','jobs','jolts','pce','gdp','retail','fomc'].every(s => has(r1, s, '2026')), Object.fromEntries(Object.entries(r1.series).map(([k, v]) => [k, Object.keys(v)])));
ok('first run: 2027 official for PCE/GDP (BEA), retail (Census), FOMC, ECB', ['pce','gdp','retail','fomc','ecb'].every(s => has(r1, s, '2027')));
ok('first run: 2027 CPI/PPI/jobs/JOLTS not official yet (FRED has nothing) — and that is not an "issue"', ['cpi','ppi','jobs','jolts'].every(s => !has(r1, s, '2027')) && !r1.issues.some(i => i.year === '2027' && ['cpi','ppi','jobs','jolts'].includes(i.series)), r1.issues);
ok('BEA is the source for PCE/GDP, Census for retail 2027, FRED for retail 2026', r1.series.pce['2027'].src === 'bea' && r1.series.retail['2027'].src === 'census' && r1.series.retail['2026'].src === 'fred');
ok('periods are kept (PCE Jan 28 2027 = December, GDP = Q4 2026)', r1.series.pce['2027'].refs['2027-01-28'] === 'December' && r1.series.gdp['2027'].refs['2027-01-28'] === 'Q4 2026');
ok('ECB 2026: the page lists only Dec 17, so 2026 stays on the built-in list (not short-listed)', !has(r1, 'ecb', '2026') && M.msOfficial('ecb', 2026, r1));
ok('BEA vs FRED 2026: both complete, so they are compared (no future mismatch)', !r1.issues.some(i => i.code === 'mismatch' && ['pce','gdp'].includes(i.series)), r1.issues.filter(i => i.code === 'mismatch'));
ok('source health: every source answered now', Object.values(r1.sources).every(s => s.okAt === now && !s.err));

const later = now + 86400000;
const r2 = M.msMergeRun(r1, realFetched(f => { f.sources.fred = { ok:false, err:'HTTP 503' }; for (const s of ['cpi','ppi','jobs','jolts','pce','gdp','retail']) for (const yr of [2026, 2027]) delete f.lists[s][yr].fred; }), later);
ok('FRED down: CPI 2026 kept from the last good run', eq(r2.series.cpi['2026'], r1.series.cpi['2026']));
ok('FRED down: its okAt stays at the last success, the error is recorded', r2.sources.fred.okAt === now && r2.sources.fred.err === 'HTTP 503');
ok('FRED down: PCE still from BEA', r2.series.pce['2027'].src === 'bea');

const moved = realFetched(f => { f.lists.cpi[2026].fred = fred['10-2026'].rows.map(r => r.date === '2026-12-10' ? { date:'2026-12-11' } : r); });
const r3 = M.msMergeRun(r1, moved, later);
ok('a moved date is followed (CPI Dec 10 → Dec 11)', r3.series.cpi['2026'].dates.includes('2026-12-11') && !r3.series.cpi['2026'].dates.includes('2026-12-10'));
ok('...and logged as a change', r3.changes.some(c => c.series === 'cpi' && eq(c.removed, ['2026-12-10']) && eq(c.added, ['2026-12-11'])), r3.changes);
const r3b = M.msMergeRun(r3, moved, later + 86400000);
ok('the change is logged once, not every day after', r3b.changes.filter(c => c.series === 'cpi').length === 1);
const r3c = M.msMergeRun(r3, moved, later + 15 * 86400000);
ok('changes are forgotten after 14 days', !r3c.changes.some(c => c.series === 'cpi'));
ok('a moved PAST date is not a change', !M.msMergeRun(r1, realFetched(f => { f.lists.cpi[2026].fred = fred['10-2026'].rows.map(r => r.date === '2026-01-13' ? { date:'2026-01-14' } : r); }), later).changes.length);

const shrunk = realFetched(f => { f.lists.cpi[2026].fred = fred['10-2026'].rows.slice(0, 9); });
const r4 = M.msMergeRun(r1, shrunk, later);
ok('a list that shrank below a full year keeps the old one (postponement?)', eq(r4.series.cpi['2026'].dates, r1.series.cpi['2026'].dates));
ok('...and files a "shrank" issue', r4.issues.some(i => i.code === 'shrank' && i.series === 'cpi'), r4.issues);

const weekend = realFetched(f => { f.lists.ppi[2026].fred = fred['46-2026'].rows.map(r => r.date === '2026-12-15' ? { date:'2026-12-12' } : r); });
const r5 = M.msMergeRun(r1, weekend, later);
ok('an unbelievable list is rejected and the old one kept', r5.series.ppi['2026'].dates.includes('2026-12-15') && r5.issues.some(i => i.code === 'rejected' && i.series === 'ppi'), r5.issues);

const dis = realFetched(f => { f.lists.gdp[2026].fred = bea.by.gdp.filter(r => r.date.startsWith('2026')).map(r => r.date === '2026-12-23' ? { date:'2026-12-22' } : { date:r.date }); });
const r6 = M.msMergeRun(r1, dis, later);
ok('agency vs FRED disagree on a future date: the agency\'s date is used', r6.series.gdp['2026'].src === 'bea' && r6.series.gdp['2026'].dates.includes('2026-12-23'));
ok('...and a mismatch is filed with what each alone lists', r6.issues.some(i => i.code === 'mismatch' && i.series === 'gdp' && eq(i.bea, ['2026-12-23']) && eq(i.fred, ['2026-12-22'])), r6.issues);

const beaShort = realFetched(f => { f.lists.pce[2027].primary = pce27.slice(0, 5); });
const r7 = M.msMergeRun(null, beaShort, now);
ok('next year only partly published (no earlier list): not official, an "incomplete" note', !has(r7, 'pce', '2027') && r7.issues.some(i => i.code === 'incomplete' && i.series === 'pce'));

// Census / ECB list only what is still ahead: the year's past is filled from the
// stored list, so a source dropping past months doesn't make the year "short".
const inMay = ET('2027-05-20T14:00:00Z');
const aheadOnly = realFetched(f => { f.lists.retail[2027].primary = cen.rows.filter(r => r.date >= '2027-05-21'); f.lists.retail[2027].fred = []; });
const r8 = M.msMergeRun(r1, aheadOnly, inMay);
ok('a source listing only what is ahead keeps the year whole (past filled from the stored list)', has(r8, 'retail', '2027') && r8.series.retail['2027'].dates.length === 12, r8.series.retail['2027']);
ok('years before last year are dropped from the record', !M.msMergeRun(r8, realFetched(), ET('2028-02-01T14:00:00Z')).series.cpi['2026']);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. authoritativeMacro / computedMacro');
const names = (ev) => ev.map(e => e.date + ' ' + e.name);
const win = M.authoritativeMacro('2026-12-20', '2027-01-31', r1);
ok('Jan 2027 retail from Census, named for its period ("December Retail Sales", Jan 15)', names(win).includes('2027-01-15 December Retail Sales'));
ok('Jan 2027 GDP/PCE from BEA (Jan 28: Q4 2026 GDP, December PCE Report)', names(win).includes('2027-01-28 Q4 2026 GDP') && names(win).includes('2027-01-28 December PCE Report'));
ok('Jan 2027 FOMC decision (Jan 27) and its minutes from Dec 9 2026 (Dec 30)', names(win).includes('2027-01-27 FOMC Rate Decision') && names(win).includes('2026-12-30 FOMC Minutes'));
ok('no 2027 CPI / jobs / ADP until FRED publishes them (AI fills in, Est.)', !win.some(e => e.date >= '2027-01-01' && ['cpi','jobs','adp','ppi','jolts'].includes(e.series)));
ok('rule-based releases now exist for 2027 too (ISM Jan 4, Michigan prelim Jan 8)', names(win).includes('2027-01-04 December ISM Manufacturing PMI') && names(win).includes('2027-01-08 January Michigan Sentiment (Prelim)'), names(win).filter(n => /ISM|Michigan/.test(n)));
ok('every event names its release (series)', win.every(e => typeof e.series === 'string' && e.series));
const nov = M.authoritativeMacro('2026-11-09', '2026-12-31', r1), novB = M.authoritativeMacro('2026-11-09', '2026-12-31', null);
const strip = (ev) => names(ev).filter(n => !/Jobless Claims/.test(n)).sort();
ok('the feed and the old 2026 table give the same Nov-Dec 2026 calendar (names and dates)', eq(strip(nov), strip(novB)), strip(nov).filter(n => !strip(novB).includes(n)).concat(['|'], strip(novB).filter(n => !strip(nov).includes(n))));
ok('no schedule at all: the built-in 2026 table still serves', novB.some(e => e.name === 'October CPI Report' && e.date === '2026-11-10'));
const claims = (a, b) => M.computedMacro(a, b, null).filter(e => e.series === 'claims').map(e => e.date);
ok('jobless claims: Thanksgiving week releases Wednesday (2026-11-25)', claims('2026-11-20', '2026-11-30').includes('2026-11-25') && !claims('2026-11-20', '2026-11-30').includes('2026-11-26'));
ok('jobless claims: Christmas Thursday 2025 → Wed Dec 24; New Year Thursday 2026 → Wed Dec 31', eq(claims('2025-12-22', '2026-01-02'), ['2025-12-24', '2025-12-31']));
ok('jobless claims: an ordinary Thursday is unchanged', eq(claims('2026-12-01', '2026-12-07'), ['2026-12-03']));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n5. mergeAiMacro');
const ai = (name, date, category) => ({ kind:'macro', ticker:null, name, date, category: category || 'inflation' });
const auth27 = M.authoritativeMacro('2027-01-25', '2027-02-24', r1);
const aiList = [
  ai('January CPI Report', '2027-02-10'), ai('December Jobs Report (NFP)', '2027-02-05', 'jobs'), ai('January ISM Manufacturing PMI', '2027-02-01', 'growth'),
  ai('Housing Starts', '2027-02-17', 'housing'), ai('Fed Governor Waller Speech', '2027-01-27', 'fed'), ai('ECB Rate Decision', '2027-02-04', 'fed'),
  ai('FOMC Minutes', '2027-02-17', 'fed'), ai('Fed Chair Warsh Testimony', '2027-02-24', 'fed'), ai('Semiannual Monetary Policy Report to Congress', '2027-02-23', 'fed'),
  ai('January Retail Sales', '2027-02-18', 'growth'), ai('January S&P Global Flash PMI', '2027-02-19', 'growth'), ai('PCE Price Index', '2027-01-28'),
];
const merged = M.mergeAiMacro(auth27, aiList, r1);
const byName = Object.fromEntries(merged.map(e => [e.name.replace(' (approx)', ''), e]));
ok('CPI 2027 not official → AI kept, flagged (approx), series cpi', byName['January CPI Report'] && byName['January CPI Report'].approx && byName['January CPI Report'].name === 'January CPI Report (approx)' && byName['January CPI Report'].series === 'cpi');
ok('jobs 2027 not official → AI kept (approx)', byName['December Jobs Report (NFP)'] && byName['December Jobs Report (NFP)'].approx);
ok('ISM is a rule → AI dropped in any year', !byName['January ISM Manufacturing PMI']);
ok('housing (unscheduled) → kept, not flagged', byName['Housing Starts'] && !byName['Housing Starts'].approx);
ok('a Fed speech on FOMC day → kept, not flagged', byName['Fed Governor Waller Speech'] && !byName['Fed Governor Waller Speech'].approx);
ok('ECB 2027 official → AI dropped (it used to land as a duplicate "fed" event)', !byName['ECB Rate Decision']);
ok('FOMC 2027 official → AI minutes dropped', !byName['FOMC Minutes']);
ok('plain testimony (unscheduled) → kept, not flagged', byName['Fed Chair Warsh Testimony'] && !byName['Fed Chair Warsh Testimony'].approx);
ok('semiannual testimony has no 2027 date yet → kept (approx)', byName['Semiannual Monetary Policy Report to Congress'] && byName['Semiannual Monetary Policy Report to Congress'].approx);
ok('retail 2027 official (Census) → AI dropped', !byName['January Retail Sales']);
ok('Flash PMI after 2026 has no official list → AI kept (approx)', byName['January S&P Global Flash PMI'] && byName['January S&P Global Flash PMI'].approx);
ok('PCE 2027 official → AI dropped', !byName['PCE Price Index']);
const cpiOn = { ...r1, series: { ...r1.series, cpi: { ...r1.series.cpi, '2027': { dates: ['2027-01-13','2027-02-10','2027-03-10','2027-04-13','2027-05-12','2027-06-10','2027-07-14','2027-08-11','2027-09-14','2027-10-13','2027-11-10','2027-12-10'], refs:{}, src:'fred', at:now } } } };
ok('once FRED publishes CPI 2027, the AI CPI is dropped', !M.mergeAiMacro(M.authoritativeMacro('2027-01-25','2027-02-24', cpiOn), aiList, cpiOn).some(e => /CPI/.test(e.name)));
const off = M.macroOfficialYears(r1);
ok('macroOfficialYears: per release, ADP follows jobs and minutes follow FOMC', eq(off.adp, off.jobs) && eq(off.minutes, off.fomc) && off.pce.includes('2027') && !off.cpi.includes('2027') && off.flashpmi.includes('2026'));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n6. macroScheduleStatus');
const codes = (st) => st.warnings.map(w => w.code);
const healthy = M.msMergeRun(null, realFetched(f => { for (const s of ['cpi','ppi','jobs','jolts']) f.lists[s][2027].fred = cpiOn.series.cpi['2027'].dates.map((d, i) => ({ date: d })); }), now);
// (CPI's 2027 dates stand in for the other BLS releases: valid shape, all weekdays.)
ok('everything official and answering → no warnings at all', M.macroScheduleStatus(healthy, now, 30).warnings.length === 0, M.macroScheduleStatus(healthy, now, 30).warnings);
ok('no record → feed-missing', eq(codes(M.macroScheduleStatus(null, now, 30)), ['feed-missing']));
ok('checked yesterday → fine', !codes(M.macroScheduleStatus(healthy, now + 86400000, 30)).includes('feed-stale'));
ok('not checked for 3 days → feed-stale', codes(M.macroScheduleStatus(healthy, now + 3 * 86400000, 30)).includes('feed-stale'));
ok('the whole check stopped → ONE feed-stale warning, not five "source down" too', eq(codes(M.macroScheduleStatus(healthy, now + 10 * 86400000, 30)), ['feed-stale']), codes(M.macroScheduleStatus(healthy, now + 10 * 86400000, 30)));
ok('warnings read as sentences (capitalised)', M.macroScheduleStatus(r1, ET('2026-12-10T15:00:00Z'), 30).warnings.every(w => /^[A-Z0-9]/.test(w.text)));
const fredDown = { ...healthy, sources: { ...healthy.sources, fred: { okAt: now - 4 * 86400000, at: now, err: 'HTTP 503' } } };
const sd = M.macroScheduleStatus(fredDown, now, 30).warnings.find(w => w.code === 'source-down');
ok('a source failing 4 days → source-down naming it, the error, and that its last dates are used', sd && /FRED/.test(sd.text) && /HTTP 503/.test(sd.text) && /last good dates/.test(sd.text), sd);
ok('a source failing 2 days → not yet', !codes(M.macroScheduleStatus({ ...healthy, sources: { ...healthy.sources, bea: { okAt: now - 2 * 86400000, at: now, err: 'x' } } }, now, 30)).includes('source-down'));
const never = M.macroScheduleStatus({ ...healthy, sources: { ...healthy.sources, ecb: { okAt: null, at: now, err: 'HTTP 403' } } }, now, 30).warnings.find(w => w.code === 'source-down');
ok('a source that never answered → says so', never && /on any check yet/.test(never.text));

const d10 = ET('2026-12-10T15:00:00Z');       // window reaches Jan 9 2027
const w10 = M.macroScheduleStatus(r1, d10, 30).warnings.find(w => w.code === 'window-estimated');
ok('Dec 10: window reaches Jan 9 2027 → CPI, PPI, jobs, JOLTS 2027 flagged as Est., waiting on FRED', w10 && eq([...w10.series].sort(), ['cpi','jobs','jolts','ppi']) && /FRED/.test(w10.text) && /automatic/.test(w10.text), w10);
ok('...FOMC is not (it never meets before Jan 20) and nothing official is listed', w10 && !w10.series.includes('fomc') && !w10.series.includes('pce'));
const d03 = ET('2026-12-03T15:00:00Z');       // window to Jan 2 2027
ok('Dec 3: window ends Jan 2 → no window warning; next-year-pending note instead', !codes(M.macroScheduleStatus(r1, d03, 30)).includes('window-estimated') && codes(M.macroScheduleStatus(r1, d03, 30)).includes('next-year-pending'));
const np = M.macroScheduleStatus(r1, ET('2026-11-20T15:00:00Z'), 30).warnings.find(w => w.code === 'next-year-pending');
ok('Nov 20: next-year-pending is a note (info), lists what is still to come', np && np.level === 'info' && eq([...np.series].sort(), ['cpi','jobs','jolts','ppi']));
ok('Nov 10: too early for the next-year note', !codes(M.macroScheduleStatus(r1, ET('2026-11-10T15:00:00Z'), 30)).includes('next-year-pending'));
ok('next-year-pending goes quiet once everything is in', !codes(M.macroScheduleStatus(healthy, ET('2026-11-20T15:00:00Z'), 30)).includes('next-year-pending'));
const feb27 = M.macroScheduleStatus(r1, ET('2027-02-10T15:00:00Z'), 30).warnings.find(w => w.code === 'window-estimated');
ok('Feb 2027 with CPI 2027 still missing → this year\'s CPI is flagged (warn)', feb27 && feb27.level === 'warn' && feb27.series.includes('cpi') && feb27.series.includes('fomc') === false);
const nye = ET('2027-01-01T03:00:00Z');       // Dec 31 2026, 10 PM in New York
ok('New Year\'s Eve at 10 PM ET is still Dec 31 (the date is New York\'s, not UTC\'s)', M.msEtDate(nye) === '2026-12-31');

const mm = { ...healthy, issues: [{ code:'mismatch', series:'retail', year:'2026', census:[], fred:['2026-11-20'] }] };
const mmw = M.macroScheduleStatus(mm, now, 30).warnings.find(w => w.code === 'mismatch');
ok('a mismatch inside the window → a note naming the date and that the agency\'s is used', mmw && mmw.level === 'info' && /Nov 20/.test(mmw.text) && /agency's date is used/.test(mmw.text), mmw);
ok('a mismatch outside the window → silent (FRED\'s yearly revision days)', !codes(M.macroScheduleStatus({ ...healthy, issues: [{ code:'mismatch', series:'retail', year:'2027', census:[], fred:['2027-04-23'] }] }, now, 30)).includes('mismatch'));
ok('shrank → warn', M.macroScheduleStatus({ ...healthy, issues: [{ code:'shrank', series:'cpi', year:'2026', src:'fred', reason:'only 9 dates (a full year has at least 11)' }] }, now, 30).warnings.some(w => w.code === 'shrank' && w.level === 'warn' && /postponed/.test(w.text)));
ok('rejected → warn with the reason', M.macroScheduleStatus({ ...healthy, issues: [{ code:'rejected', series:'ppi', year:'2026', src:'fred', reason:'2026-12-12 falls on a weekend' }] }, now, 30).warnings.some(w => w.code === 'rejected' && /weekend/.test(w.text)));
const noPce27 = { ...healthy, series: { ...healthy.series, pce: { '2026': healthy.series.pce['2026'] } } };
ok('incomplete next year: silent once official from elsewhere', !codes(M.macroScheduleStatus({ ...healthy, issues: [{ code:'incomplete', series:'pce', year:'2027', src:'bea', reason:'only 5 dates' }] }, ET('2026-10-02T15:00:00Z'), 30)).includes('incomplete'));
ok('incomplete next year in March → silent; in October → a note', !codes(M.macroScheduleStatus({ ...noPce27, issues: [{ code:'incomplete', series:'pce', year:'2027', src:'bea', reason:'only 5 dates' }] }, ET('2026-03-02T15:00:00Z'), 30)).includes('incomplete')
  && codes(M.macroScheduleStatus({ ...noPce27, issues: [{ code:'incomplete', series:'pce', year:'2027', src:'bea', reason:'only 5 dates' }] }, ET('2026-10-02T15:00:00Z'), 30)).includes('incomplete'));
const mv = { ...healthy, changes: [{ series:'cpi', year:'2026', removed:['2026-12-10'], added:['2026-12-11'], at: now - 2 * 86400000 }] };
const mvw = M.macroScheduleStatus(mv, now, 30).warnings.find(w => w.code === 'moved');
ok('a moved date in the past week → "CPI moved from Dec 10 to Dec 11"', mvw && /CPI moved from Dec 10 to Dec 11/.test(mvw.text), mvw);
ok('...gone after a week', !codes(M.macroScheduleStatus({ ...mv, changes: [{ ...mv.changes[0], at: now - 8 * 86400000 }] }, now, 30)).includes('moved'));
ok('...silent once the dates have passed', !codes(M.macroScheduleStatus({ ...mv, changes: [{ series:'cpi', year:'2026', removed:['2026-11-05'], added:['2026-11-06'], at: now - 86400000 }] }, now, 30)).includes('moved'));
ok('status reports each release\'s official years', eq(M.macroScheduleStatus(r1, now, 30).official.retail, ['2026','2027']));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n7. Wiring and budget');
const sched = SRC.slice(SRC.indexOf('async scheduled(event, env, ctx){'));
ok('the 06:20 tick reads the official calendars, alone in its invocation', /if \(minute < 30\)\{ await refreshMacroSchedule\(env\)[^\n]*return; \}/.test(sched));
ok('wrangler.toml fires the :30 tick (Catalysts)', /^crons = \["0,10,20,30 12,13 \* \* \*"\]$/m.test(TOML));
ok('buildCalendar loads the stored schedule and uses it', /const sched = await loadMacroSchedule\(env\);\s*\n\s*const authMacro = authoritativeMacro\(fromD, toD, sched\);/.test(SRC) && /mergeAiMacro\(authMacro, aiMacro, sched\)/.test(SRC));
ok('the calendar tells TradeHub which years are official', /cov\.macroOfficial = macroOfficialYears\(sched\)/.test(SRC));
ok('/macro-schedule exists and refresh is rate-limited', /url\.pathname === '\/macro-schedule'/.test(SRC) && /MS_REFRESH_MIN_GAP/.test(SRC.slice(SRC.indexOf("url.pathname === '/macro-schedule'"))));
ok('the old once-a-year switch is gone (HARDCODED_YEARS, MACRO_RELEASES_2026)', !/HARDCODED_YEARS|MACRO_RELEASES_2026/.test(SRC));

(async () => {
  // Every source answered with the real fixtures; count requests and KV writes.
  const calls = [];
  const fakeFetch = async (url, opt) => {
    calls.push({ url, ua: opt && opt.headers && opt.headers['User-Agent'] });
    let body = '';
    const m = /rid=(\d+)&y=(\d+)/.exec(url);
    if (m){ const f = `fred-${m[1]}-${m[2]}.html`; body = fs.existsSync(path.join(FIX, f)) ? fx(f) : fx('fred-10-2027.html'); }
    else if (/bea\.gov/.test(url)) body = fx('bea.ics');
    else if (/census\.gov/.test(url)) body = fx('census.html');
    else if (/federalreserve\.gov/.test(url)) body = fx('fomc.html');
    else if (/ecb\.europa\.eu/.test(url)) body = fx('ecb.html');
    return { ok: true, status: 200, text: async () => body };
  };
  const puts = [];
  const env = { NEWSHUB_CACHE: { get: async () => null, put: async (k, v) => { puts.push([k, v]); } } };
  const t0 = process.hrtime.bigint();
  const rec = await M.refreshMacroSchedule(env, now, fakeFetch);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(`one refresh = ${calls.length} fetches (≤ 20 of the invocation's 50)`, calls.length <= 20 && calls.length >= 18, calls.length);
  ok('every request identifies itself honestly (MS_UA)', calls.every(c => c.ua === M.MS_UA));
  ok('one refresh = exactly ONE KV write, to the schedule key', puts.length === 1 && puts[0][0] === M.MS_KEY);
  ok('the record round-trips through JSON and is small (< 20 KB)', JSON.parse(puts[0][1]).v === 1 && puts[0][1].length < 20000, puts[0][1].length);
  ok('all five sources answered', Object.values(rec.sources).every(s => s.okAt === now), rec.sources);
  console.log(`  (parse + merge of all real pages: ${ms.toFixed(1)} ms in node)`);

  // A source that 403s, one whose page changed, one that times out.
  const bad = async (url, opt) => {
    if (/ecb\./.test(url)) return { ok:false, status:403, text: async () => 'Forbidden' };
    if (/census\./.test(url)) return { ok:true, status:200, text: async () => '<html>redesigned</html>' };
    if (/federalreserve/.test(url)) throw new Error('The operation was aborted due to timeout');
    return fakeFetch(url, opt);
  };
  const rb = await M.refreshMacroSchedule({ NEWSHUB_CACHE: { get: async () => JSON.stringify(rec), put: async () => {} } }, now + 86400000, bad);
  ok('403 / changed page / timeout are each recorded against their source, old dates kept',
    /403/.test(rb.sources.ecb.err) && /format changed/.test(rb.sources.census.err) && /timeout/.test(rb.sources.fed.err)
    && rb.sources.ecb.okAt === now && eq(rb.series.fomc['2027'], rec.series.fomc['2027']) && eq(rb.series.retail['2027'], rec.series.retail['2027']), rb.sources);
  const fredBroken = async (url, opt) => /stlouisfed/.test(url) ? { ok:true, status:200, text: async () => '<html>nothing</html>' } : fakeFetch(url, opt);
  const rf = await M.refreshMacroSchedule({ NEWSHUB_CACHE: { get: async () => JSON.stringify(rec), put: async () => {} } }, now + 86400000, fredBroken);
  ok('FRED pages that parse to nothing count as FRED failing (format changed), not as "no releases"', !rf.sources.fred.okAt || rf.sources.fred.okAt === now, rf.sources.fred);
  ok('...and CPI 2026 is kept', eq(rf.series.cpi['2026'], rec.series.cpi['2026']));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
