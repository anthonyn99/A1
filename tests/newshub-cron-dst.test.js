// newshub's morning pre-warm begins at 6 AM Mountain all year (2026-11-02). A UTC
// cron cannot follow daylight saving, so the one trigger fires at 12:00 AND 13:00
// UTC (and at :10 and :20 of each, one build per tick) and scheduled() builds
// only on the runs that are 6 AM in America/Denver.
// Until then it was 12:00 UTC alone: 6 AM in summer but 5 AM all winter.
//
// The real isCronBuildHour is lifted out of worker.js and run over every day of
// two years, clock-change days included.
//
// Run: node tests/newshub-cron-dst.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workers', 'newshub-api', 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
const TOML = fs.readFileSync(path.join(ROOT, 'workers', 'newshub-api', 'wrangler.toml'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const m = /\nfunction isCronBuildHour\(ms\)\{[\s\S]*?\n\}\n/.exec(SRC);
ok('worker.js defines isCronBuildHour', !!m);
const isCronBuildHour = m && new Function(m[0] + '\nreturn isCronBuildHour;')();

console.log('\nThe trigger');
ok('wrangler.toml fires at :00, :10 and :20 of 12:00 and 13:00 UTC from ONE cron expression', /^crons = \["0,10,20 12,13 \* \* \*"\]$/m.test(TOML), (TOML.match(/^crons.*$/m) || [])[0]);
const sched = SRC.slice(SRC.indexOf('async scheduled(event, env, ctx){'));
ok('scheduled() returns before any work unless it is the 6 AM run', /^async scheduled\(event, env, ctx\)\{\n(\s*\/\/.*\n)*\s*if \(!isCronBuildHour\(event\.scheduledTime\)\) return;/.test(sched));

if (isCronBuildHour) {
  const at = (iso) => isCronBuildHour(Date.parse(iso));
  console.log('\nStandard and daylight time');
  ok('winter (MST): 13:00 UTC builds', at('2026-11-02T13:00:00Z'));
  ok('winter (MST): 12:00 UTC (5 AM) does not', !at('2026-11-02T12:00:00Z'));
  ok('summer (MDT): 12:00 UTC builds', at('2026-07-01T12:00:00Z'));
  ok('summer (MDT): 13:00 UTC (7 AM) does not', !at('2026-07-01T13:00:00Z'));
  ok('fall-back day (2026-11-01): 13:00 UTC, not 12:00', at('2026-11-01T13:00:00Z') && !at('2026-11-01T12:00:00Z'));
  ok('spring-forward day (2027-03-14): 12:00 UTC, not 13:00', at('2027-03-14T12:00:00Z') && !at('2027-03-14T13:00:00Z'));

  const bad = [];
  for (let t = Date.parse('2026-01-01T00:00:00Z'); t < Date.parse('2028-01-01T00:00:00Z'); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const n = [12, 13].filter((h) => at(`${d}T${h}:00:00Z`)).length;
    if (n !== 1) bad.push(d + ':' + n);
  }
  ok('every day of 2026 and 2027 builds exactly once', bad.length === 0, bad.slice(0, 5).join(' '));
  ok('the :10 and :20 ticks fall in the same 6 AM hour', at('2026-11-02T13:10:00Z') && at('2026-11-02T13:20:00Z') && !at('2026-11-02T12:20:00Z'));
}

// 2026-11-09: news and the calendar shared one invocation's 50 subrequests, so the
// calendar starved every morning and a raw news build had nothing left to retry
// with. Each tick is now its own invocation, one build apiece.
console.log('\nOne build per tick');
ok(':00 runs the news build alone', /if \(minute < 10\)\{ await cronPrewarmNews\(env, ctx\); return; \}/.test(sched));
ok(':10 runs the raw-build retry alone', /if \(minute < 20\)\{ await cronRetryNews\(env, ctx\)[^\n]*return; \}/.test(sched));
ok('the calendar no longer runs in the news invocation', !/cronPrewarmNews\(env, ctx\);\s*\n[\s\S]{0,400}prewarmCalendar/.test(sched.slice(0, 2500)));
const retry = (SRC.match(/\nasync function cronRetryNews\(env, ctx\)\{[\s\S]*?\n\}\n/) || [''])[0];
ok('cronRetryNews skips a healthy 06:00 build', /if \(!last\.error && !last\.degraded && \(last\.events \|\| 0\) > 0\) return;/.test(retry));
ok('cronRetryNews never retries a retry', /last\.retry/.test(retry));
ok('cronRetryNews skips when someone already rebuilt it', /already rebuilt/.test(retry));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
