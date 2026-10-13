#!/usr/bin/env node
/**
 * Repeating reminders: the right series, at the right time, on time.
 *
 * Tony, 2026-10-12/13: "Put out trash bins" (weekly Monday, 11 AM) rang on his
 * phone at 8 PM, and "Put in trash bins" (Tuesday 11 AM) never reached the phone.
 * Two separate faults, both pinned here against the SHIPPED code:
 *
 *   1. DEAD SERIES. A repeating task's reminder series lives on one row (its
 *      first occurrence). When the task was re-made at 11 AM in July, the old
 *      8 PM rows from May-July stayed in the data still holding the old series,
 *      and the daily re-arm armed every series it found — so the old 8 PM one
 *      came back every day. thNotifyPlan decides which series are live.
 *
 *   2. LATE TICKS. Cloudflare runs the "* * * * *" cron at a fixed second inside
 *      the minute (:43 for this worker), not at :00, and the worker only sent a
 *      reminder that was at most 5s ahead. So an 11:00:00 reminder waited for
 *      the 11:00:43 tick, every push was 60-110s late, and anything past 90s was
 *      marked fired WITHOUT sending: "Put in trash bins" was swept at 11:01:49.
 *
 * Plus the edit path that created the dead series in the first place: moving
 * one occurrence's reminder must be able to move the whole series
 * (thSeriesNotifyEdit).
 *
 * Run: node tests/notif-series.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(ROOT, 'workers', 'taskhub-reminders', 'worker.js'), 'utf8');

const fail = [];
let passed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else fail.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  [' + detail + ']' : ''));
}

// Balanced-brace extraction from a known start marker.
function grab(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
}

// ── fixtures ────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const dk = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const at = (d, h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m || 0, 0, 0).toISOString();
const today = new Date(); today.setHours(12, 0, 0, 0);

// The real shape of Tony's data on 2026-10-13, relative to today: an old
// 8 PM series whose task days all lie in the past (every row a definer, as
// pre-July saves wrote them), and the July re-make at 11 AM that runs for years.
function tonyData() {
  const data = {};
  const put = (d, row) => { (data[dk(d)] = data[dk(d)] || []).push(row); };
  for (let w = 22; w >= 13; w--) {
    const d = addDays(today, -7 * w);
    put(d, { id: 'old' + w, title: 'Put out trash bins', repeat: 'weekly', repeatId: 'oldTask',
      notifyAt: at(d, 20), notifyRepeat: 'weekly', notifyRepeatDays: [0], notifyRepeatId: 'oldSeries' });
  }
  const first = addDays(today, -7 * 11);
  put(first, { id: 'new0', title: 'Put out trash bins', repeat: 'weekly', repeatId: 'newTask',
    notifyAt: at(first, 11), notifyRepeat: 'weekly', notifyRepeatDays: [0], notifyRepeatId: 'newSeries' });
  for (let w = -10; w <= 40; w++) {
    const d = addDays(today, 7 * w);
    put(d, { id: 'new' + (w + 11), title: 'Put out trash bins', repeat: 'weekly', repeatId: 'newTask',
      notifyAt: at(d, 11), notifyRepeat: 'none', notifyRepeatId: null, _notifyView: true });
  }
  return data;
}

console.log('\nthNotifyPlan: only live series are armed');
const planSrc = grab(html, 'window.thNotifyPlan=function(raw,habits){');
check('thNotifyPlan ships in index.html', !!planSrc);
const win = {};
if (planSrc) new Function('window', planSrc)(win);
const plan = win.thNotifyPlan;
if (plan) {
  const p = plan(tonyData(), null);
  check('the re-made 11 AM series is live', !!p.live.newSeries);
  check('it is armed from its defining row, at 11:00', p.live.newSeries && new Date(p.live.newSeries.notifyAt).getHours() === 11);
  check('the old 8 PM series is dead', p.dead.includes('oldSeries') && !p.live.oldSeries, p.dead.join(','));
  check('display-only badges never define a series', !Object.values(p.live).some((r) => r._notifyView));

  // Veda's "Market Opens": every row of a long series defines it (pre-July).
  const md = {};
  for (let w = -20; w <= 30; w++) {
    const d = addDays(today, 7 * w);
    (md[dk(d)] = md[dk(d)] || []).push({ id: 'mo' + w, repeatId: 'moTask', notifyAt: at(d, 17, 50),
      notifyRepeat: 'weekly', notifyRepeatDays: [6], notifyRepeatId: 'moSeries' });
  }
  const mp = plan(md, null);
  const pick = mp.live.moSeries && mp.live.moSeries.notifyAt;
  check('with many defining rows, the one in effect today is used — not one months out',
    !!pick && new Date(pick) <= addDays(today, 1) && new Date(pick) > addDays(today, -8), pick);

  // A series that only starts in the future is armed from its first row.
  const fd = {};
  const s1 = addDays(today, 10);
  fd[dk(s1)] = [{ id: 'f1', repeatId: 'fTask', notifyAt: at(s1, 9), notifyRepeat: 'weekly', notifyRepeatDays: [0], notifyRepeatId: 'fSeries' }];
  const s2 = addDays(today, 17);
  fd[dk(s2)] = [{ id: 'f2', repeatId: 'fTask', notifyAt: at(s2, 9), notifyRepeat: 'weekly', notifyRepeatDays: [0], notifyRepeatId: 'fSeries' }];
  check('a series starting later is armed from its earliest row', plan(fd, null).live.fSeries?.id === 'f1');

  // A repeating reminder on a one-off row has no task series to outlive.
  const od = { [dk(addDays(today, -60))]: [{ id: 'one', notifyAt: at(today, 7), notifyRepeat: 'daily', notifyRepeatId: 'oneSeries' }] };
  check('a repeating reminder on a one-off row stays live', !!plan(od, null).live.oneSeries);

  // The same series id on a dead row and a live row is live (an edit reused it).
  const rd = tonyData();
  rd[dk(addDays(today, -7 * 11))][0].notifyRepeatId = 'oldSeries';
  const rp = plan(rd, null);
  check('a series id reused by a live row is live, not dead', !!rp.live.oldSeries && !rp.dead.includes('oldSeries'));
  check('…and it is armed at the live row\'s time', new Date(rp.live.oldSeries.notifyAt).getHours() === 11);

  // Habits: a reminder switched off leaves its series dead; one never set does not.
  const hp = plan(null, [
    { id: 'pray', notifyAt: at(today, 7), notifyRepeat: 'daily', notifyRepeatId: 'habr_pray' },
    { id: 'exp', notifyAt: null, notifyRepeat: 'none', notifyRepeatDays: [], notifyRepeatId: null },
    { id: 'walk' },
  ]);
  check('a habit with a reminder is live', !!hp.live.habr_pray);
  check('a habit whose reminder was switched off is dead', hp.dead.includes('habr_exp'));
  check('a habit that never had a reminder is left alone', !hp.dead.includes('habr_walk'));
}

console.log('\nEvery scanner goes through it');
const rearm = grab(html, 'window._fcmRearmSeries=async function(force){');
check('the cloud re-arm arms only plan.live', !!rearm && /thNotifyPlan\(raw,null\)/.test(rearm) && !/Object\.values\(raw\)/.test(rearm));
const sweep = grab(html, 'window._fcmDedupSweep=async function(force){');
check('the sweep deletes docs of dead series', !!sweep && /dead\[d\.notifyRepeatId\]&&!live\[d\.notifyRepeatId\]/.test(sweep));
check('…trusting "dead" only for data loaded from the cloud this session',
  !!sweep && /fresh:!!window\._thCloudLoaded/.test(sweep) && /fresh:!!window\._vdCloudLoaded/.test(sweep) && /if\(src\.fresh\)plan\.dead/.test(sweep));
const scan = grab(html, 'function scanAndRegister(){');
check('the on-device poll registers only the live defining row', !!scan && /plan\.live\[item\.notifyRepeatId\|\|item\.id\]!==item/.test(scan));
check('…and drops entries already registered for a dead series', !!scan && /deadSeries\[r\.repeatId\]/.test(scan));

console.log('\nthSeriesNotifyEdit: moving a reminder moves the series');
const editSrc = grab(html, 'function thSeriesNotifyEdit(data,rid,cutoffKey,item){');
check('thSeriesNotifyEdit ships in index.html', !!editSrc);
if (editSrc && plan) {
  let n = 0;
  const uid = () => 'u' + (++n);
  const edit = new Function('uid', editSrc + '; return thSeriesNotifyEdit;')(uid);
  // Tony re-times this week's Monday row from 8 PM to 11 AM, "all future".
  const data = {};
  const first = addDays(today, -7 * 8);
  data[dk(first)] = [{ id: 'a0', repeat: 'weekly', repeatDays: [0], repeatId: 'T', notifyAt: at(first, 20), notifyRepeat: 'weekly', notifyRepeatDays: [0], notifyRepeatId: 'S' }];
  for (let w = -7; w <= 8; w++) {
    const d = addDays(today, 7 * w);
    data[dk(d)] = [{ id: 'a' + (w + 8), repeat: 'weekly', repeatDays: [0], repeatId: 'T', notifyAt: at(d, 20), notifyRepeat: 'none', notifyRepeatId: null, _notifyView: true }];
  }
  const edited = { ...data[dk(today)][0], notifyAt: at(today, 11) };
  const r = edit(data, 'T', dk(today), edited);
  check('the edited date becomes the series\' defining row', r.definer && r.definer.id === edited.id);
  check('…at the new time, keeping the series id and cadence',
    r.definer && new Date(r.definer.notifyAt).getHours() === 11 && r.definer.notifyRepeatId === 'S' && r.definer.notifyRepeat === 'weekly');
  const later = r.next[dk(addDays(today, 14))][0];
  check('later dates show the new time as display-only badges', later._notifyView === true && new Date(later.notifyAt).getHours() === 11);
  check('the old first row no longer defines it', r.next[dk(first)][0].notifyRepeat === 'none');
  const p2 = plan(r.next, null);
  check('the plan now arms exactly one series, at 11 AM',
    Object.keys(p2.live).length === 1 && new Date(p2.live.S.notifyAt).getHours() === 11 && p2.dead.length === 0);

  const off = edit(data, 'T', dk(today), { ...edited, notifyAt: null });
  check('switching it off leaves nothing to arm', !off.definer && Object.keys(plan(off.next, null).live).length === 0);
  check('…and names the series to cancel', off.seriesId === 'S');
}

console.log('\nThe worker sends on the minute, and late ticks still send');
const clsSrc = grab(worker, 'function classifyReminder(at, now, nextTickAt) {');
const holdSrc = grab(worker, 'function holdFor(at, now) {');
const late = worker.match(/const LATE_SEND_MS = (\d+) \* 60 \* 1000;/);
const hold = worker.match(/const MAX_HOLD_MS = (\d+) \* 1000;/);
check('classifyReminder and holdFor ship in the worker', !!clsSrc && !!holdSrc && !!late && !!hold);
if (clsSrc && holdSrc && late && hold) {
  const LATE_SEND_MS = Number(late[1]) * 60000, MAX_HOLD_MS = Number(hold[1]) * 1000;
  const classify = new Function('LATE_SEND_MS', clsSrc + '; return classifyReminder;')(LATE_SEND_MS);
  const holdFor = new Function('MAX_HOLD_MS', holdSrc + '; return holdFor;')(MAX_HOLD_MS);
  const due = Date.UTC(2026, 9, 13, 17, 0, 0);            // 11:00:00 MDT
  // The tick before it, as Cloudflare really runs it: scheduled :43, started late.
  const sched = due - 17000, start = sched + 6000;
  check('the tick before the minute takes it', classify(due, start, sched + 60000) === 'due');
  check('…and holds it until the minute', holdFor(due, start) === 11000);
  check('the tick two minutes before does not', classify(due, sched - 60000 + 6000, sched) === 'later');
  // The real 2026-10-13 case: first seen 109s late.
  check('109s late is still SENT (was dropped)', classify(due, due + 109000, due + 43000 + 60000) === 'due');
  check('far too late is dropped, not sent', classify(due, due + LATE_SEND_MS + 1000, due + LATE_SEND_MS + 60000) === 'stale');
  check('the lateness limit stays inside the query lookback', Number(late[1]) < 16);
  check('a hold never runs into the next tick', MAX_HOLD_MS <= 70000);
  check('runReminders is told the tick\'s scheduled time', /runReminders\(env, event && event\.scheduledTime\)/.test(worker));
  check('due reminders wait for their minute before sending', /holdFor\(at, Date\.now\(\)\)[\s\S]{0,120}setTimeout/.test(worker));
}

console.log('\n' + passed + ' passed, ' + fail.length + ' failed');
if (fail.length) { fail.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
