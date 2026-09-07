/* OneInbox cron cadence: read off the clock, not out of KV.

   WHY THIS FILE EXISTS
   runCron fires on a fixed 5-minute tick, so the tick already knows whether it
   is a half-hour boundary. Persisting `lastPoll` to compare against that same
   clock cost 48 KV writes/day -- in a namespace SHARED by six workers against a
   1,000 writes/day ACCOUNT cap -- purely to re-derive something the caller was
   already holding.

   Gating on the clock is free, but it moves the failure mode. A stored
   timestamp is self-correcting: miss a tick and the next one catches up. A
   clock gate is not -- if the window is too narrow the poll is silently
   skipped, and if it is too wide the poll runs twice. Neither shows up as an
   error. The first looks like "mail is 30 minutes late sometimes"; the second
   looks like nothing at all until the quota page.

   So the two properties that matter are exactly:
     - EVERY half hour, at least one tick qualifies  (no silent gap)
     - NO half hour has two                          (no silent doubling)

   The daily jobs deliberately still use stored timestamps -- see runCron.

   Run: node tests/oneinbox-cron-cadence.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'workers', 'oneinbox-api', 'worker.js'), 'utf8');

let pass = 0; const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function section(s) { console.log('\n' + s); }

const W = new Function(`${SRC.replace(/export default \{[\s\S]*$/, '')}
  return { isDueTick, POLL_EVERY_MIN, SNAPSHOT_EVERY_MIN, POLL_WINDOW_MIN };`)();

// taskhub-reminders drives this worker on `minute % 5 === 0`, so these are the
// only minutes runCron is ever entered on.
const TICKS = [];
for (let m = 0; m < 1440; m += 5) TICKS.push(m);

section('The window cannot admit two ticks');
t('POLL_WINDOW_MIN <= the 5-minute tick interval', W.POLL_WINDOW_MIN <= 5,
  'POLL_WINDOW_MIN=' + W.POLL_WINDOW_MIN + '. Wider than the tick interval and two ticks ' +
  'fall in the same window — the poll runs twice and every mailbox is fetched twice.');

section('The half-hourly poll fires exactly twice an hour');
{
  const due = TICKS.filter((m) => W.isDueTick(m, W.POLL_EVERY_MIN));
  t('runs ' + (1440 / W.POLL_EVERY_MIN) + 'x/day, no more no less',
    due.length === 1440 / W.POLL_EVERY_MIN, due.length + ' tick(s)/day');
  // Every window must contain exactly one, which is the real invariant --
  // the right COUNT could still be the wrong distribution.
  let gaps = 0, doubles = 0;
  for (let w = 0; w < 1440; w += W.POLL_EVERY_MIN) {
    const inWindow = due.filter((m) => m >= w && m < w + W.POLL_EVERY_MIN).length;
    if (inWindow === 0) gaps++;
    if (inWindow > 1) doubles++;
  }
  t('no half hour is skipped', gaps === 0, gaps + ' gap(s)');
  t('no half hour polls twice', doubles === 0, doubles + ' double(s)');
  t('and it lands on the boundaries', due.slice(0, 4).join(',') === '0,30,60,90',
    due.slice(0, 4).join(','));
}

section('The hourly snapshot fires exactly once an hour');
{
  const due = TICKS.filter((m) => W.isDueTick(m, W.SNAPSHOT_EVERY_MIN));
  t('runs 24x/day', due.length === 24, due.length + ' tick(s)/day');
  let bad = 0;
  for (let h = 0; h < 24; h++) {
    if (due.filter((m) => m >= h * 60 && m < (h + 1) * 60).length !== 1) bad++;
  }
  t('exactly one per clock hour', bad === 0, bad + ' bad hour(s)');
  t('every snapshot tick is also a poll tick', due.every((m) => W.isDueTick(m, W.POLL_EVERY_MIN)),
    'The snapshot only happens INSIDE the poll block, so a snapshot tick that is ' +
    'not a poll tick would never run at all.');
}

section('A tick that arrives late still counts');
{
  // The tick fires on the minute; runCron runs inside ctx.waitUntil, so it can
  // read the clock a minute or two later. An equality test would drop that poll
  // silently -- mail simply arrives 30 minutes later, with nothing logged.
  const late = [0, 1, 2, 3, 4].map((d) => W.isDueTick(30 + d, W.POLL_EVERY_MIN));
  t('up to 4 minutes late is still due', late.every(Boolean), JSON.stringify(late));
  t('5 minutes late is NOT (that is the next tick\'s job)',
    !W.isDueTick(35, W.POLL_EVERY_MIN));
}

section('The stored state holds ONLY the once-a-day work');
{
  const body = SRC.slice(SRC.indexOf('async function runCron'));
  const end = body.indexOf('\n}\n');
  const fn = body.slice(0, end);
  // Tests ASSIGNMENT, not mention: the cleanup below deliberately names these
  // fields in order to delete them, and a substring check would read that as
  // the very regression it is there to prevent.
  for (const gone of ['lastPoll', 'lastSnap', 'acctCursor']) {
    t('state.' + gone + ' is no longer assigned',
      !new RegExp('state\\.' + gone + '\\s*=[^=]').test(fn),
      'That is the 48 writes/day this change removes.');
  }
  // These must NOT be clock-gated: a daily job that fires at exactly one tick
  // loses a whole day when that tick is missed, whereas a stored timestamp is
  // caught up by the next tick.
  for (const kept of ['lastWatch', 'lastSweep']) {
    t('state.' + kept + ' is still stored', fn.includes('state.' + kept + ' = now'),
      'Daily jobs keep timestamps on purpose — see runCron. They cost ~2 writes/day.');
  }

  // The record is loaded from KV and written back wholesale, so not writing a
  // field is not the same as removing it: the old values would ride along
  // forever, advertising a lastPoll nothing updates.
  t('the retired fields are deleted on the next write',
    /delete state\.lastPoll; delete state\.lastSnap; delete state\.acctCursor;/.test(fn),
    'Otherwise oi:cron keeps claiming state the code no longer maintains.');
}

section('A manual refresh still bypasses the clock entirely');
t('force short-circuits the poll gate', /if \(force \|\| isDueTick\(minuteOfDay, POLL_EVERY_MIN\)\)/.test(SRC),
  'Pressing Refresh must never mean "wait up to 30 minutes".');
t('force short-circuits the snapshot gate', /const snapshot = force \|\| isDueTick\(/.test(SRC));

section('The account rotation survived losing its stored cursor');
{
  // It used to advance a stored counter; it is now derived from which half-hour
  // of the epoch this is. Exercised on REAL timestamps through the same
  // expression the worker uses — a rotation test that reduces to `k % n` proves
  // nothing about the formula that actually ships.
  const slot = (nowMs, n) => Math.floor(nowMs / (W.POLL_EVERY_MIN * 60e3)) % n;
  const HALF = W.POLL_EVERY_MIN * 60e3;
  const base = Date.UTC(2026, 8, 7, 0, 0, 0);

  for (const n of [1, 2, 3, 4, 5, 7]) {
    const seen = new Set();
    for (let k = 0; k < n * 3; k++) seen.add(slot(base + k * HALF, n));
    t('with ' + n + ' mailbox(es), every one eventually leads', seen.size === n,
      'reached ' + seen.size + ' of ' + n);
  }

  // Consecutive polls must MOVE, or the rotation is decorative and the same
  // mailbox spends the shared message budget every time.
  const n = 5;
  let stuck = 0;
  for (let k = 0; k < 40; k++) {
    if (slot(base + k * HALF, n) === slot(base + (k + 1) * HALF, n)) stuck++;
  }
  t('consecutive polls start on different mailboxes', stuck === 0, stuck + ' repeat(s)');

  // Within one window the value must not change, or two ticks of the same poll
  // would disagree about where to start.
  t('the slot is stable across the whole window',
    slot(base, n) === slot(base + (W.POLL_WINDOW_MIN - 1) * 60e3, n));
}

console.log('\n' + '─'.repeat(64));
if (failures.length) {
  console.log(failures.length + ' FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
if (!pass) { console.log('NO CHECKS RAN — the harness is broken, not passing.'); process.exit(1); }
console.log('All ' + pass + ' cron-cadence checks passed.');
