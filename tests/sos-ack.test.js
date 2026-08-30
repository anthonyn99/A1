#!/usr/bin/env node
/**
 * StudyOS <-> TaskHub done-state ack tests.
 *
 * WHY THIS FILE EXISTS
 * Ticking a StudyOS task inside TaskHub said "synced", and a reload unticked it
 * again. Nothing was ever lost server-side, which is the signature of a RENDER
 * bug, not a write bug (see the taskhub-sync-two-paths note).
 *
 * THE BUG
 * The ack channel was WRITE-ONLY on the TaskHub side. A tick wrote
 * dashboards/studyos_mirror_ack, but TaskHub reconciles from
 * dashboards/studyos_mirror, and only StudyOS can rebuild that -- and only while
 * StudyOS is actually open in a tab. With StudyOS closed (the normal case: it is
 * a different site) the mirror kept reporting done:false, and since the
 * reconcile is authoritative for every _sosId item, the next load faithfully
 * re-applied that false and wiped the tick.
 *
 * Three failure modes are modelled below:
 *   1. tick with StudyOS closed -> reverted on reload, forever
 *   2. tick then reload inside the ack debounce window -> reverted
 *   3. untick in StudyOS after a TaskHub tick -> re-ticked by a stale full map
 *
 * Run: node tests/sos-ack.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  FAIL ' + name); }
}
function section(s) { console.log('\n' + s); }

// ------------------------- Part 1: static guards -------------------------
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const TMJS = fs.readFileSync(path.join(__dirname, '..', 'V1', 'js', 'taskmirror.js'), 'utf8');

section('Static: TaskHub reads its own ack back');

t('An ack listener exists',
  /_sosAckUnsub = onSnapshot\(sosAckRef/.test(HTML),
  'Without reading the ack back, a tick is invisible to the reconcile that overwrites it.');

t('The ack unsub is declared and torn down',
  /let _sosAckUnsub\s*=\s*null;/.test(HTML) &&
  /if \(_sosAckUnsub\)\s*\{ _sosAckUnsub\(\);\s*_sosAckUnsub\s*=\s*null; \}/.test(HTML),
  'Every listener must be released on teardown or it leaks across re-auth.');

t('The reconcile merges the ack before applying',
  /window\._sosMergeAck\?window\._sosMergeAck\(rawItems\|\|\{\}\)/.test(HTML),
  'The overlay must happen BEFORE the signature is computed, or a tick-only change is skipped.');

t('Consumed acks are pruned against the raw mirror',
  /window\._sosPruneAck&&window\._sosPruneAck\(e\.detail\|\|\{\}\)/.test(HTML),
  'An ack that never expires becomes a competing source of truth that never loses.');

t('The ack is held in memory immediately, not only after the debounce',
  /window\._sosAckLatest = Object\.assign\(\{\}, doneMap \|\| \{\}\);/.test(HTML),
  'A reload inside the 600ms debounce window must still see the tick.');

t('Only divergences are published in the ack',
  /if\(!!m\.done!==!!t\.done\)map\[t\._sosId\]=!!t\.done;/.test(HTML),
  'A full done-map re-asserts stale values and re-ticks tasks unticked in StudyOS.');

t('The ack merge only touches task ids, never events',
  /if \(String\(sid\)\.indexOf\('t_'\) !== 0\) return;/.test(HTML),
  'Events have no done-state in StudyOS.');

t('The ack merge never resurrects a task missing from the mirror',
  /const it = items\[sid\];\s*\n\s*if \(!it \|\| !!it\.done === !!ack\[sid\]\) return;/.test(HTML),
  'An ack for a task deleted in StudyOS must not re-create it.');

section('Static: StudyOS side');

t('StudyOS ignores a replay of an ack it already applied',
  /if \(at && at === lastAckSavedAt\) return;/.test(TMJS),
  'Re-applying a consumed ack fights a change made in StudyOS in the meantime.');

t('The dead ackApplying flag is gone',
  !/ackApplying/.test(TMJS),
  'It was assigned but never read.');

// ------------------------- Part 2: behavioural -------------------------
// Faithful model of the two documents and the reconcile, so each failure mode
// is replayed end to end rather than asserted by reading the source.

function makeWorld() {
  return {
    mirror: {},        // dashboards/studyos_mirror .items   (StudyOS writes)
    ack: {},           // dashboards/studyos_mirror_ack.done (TaskHub writes)
    sosTasks: {},      // StudyOS's own task store
    studyosOpen: false,
  };
}

// --- TaskHub side, mirroring index.html ---
function mergeAck(items, ack) {
  let out = null;
  Object.keys(items || {}).forEach(sid => {
    if (String(sid).indexOf('t_') !== 0) return;
    if (!Object.prototype.hasOwnProperty.call(ack, sid)) return;
    const it = items[sid];
    if (!it || !!it.done === !!ack[sid]) return;
    if (!out) out = Object.assign({}, items);
    out[sid] = Object.assign({}, it, { done: !!ack[sid] });
  });
  return out || items;
}

function pruneAck(items, ack) {
  Object.keys(ack).forEach(sid => {
    const it = items && items[sid];
    if (!it || !!it.done === !!ack[sid]) delete ack[sid];
  });
}

// What TaskHub renders for a task after a (re)load.
function taskhubView(w, sid) {
  const merged = mergeAck(w.mirror, w.ack);
  return merged[sid] ? !!merged[sid].done : null;
}

// TaskHub ticks a mirrored task: publish only the divergence.
function taskhubTick(w, sid, done) {
  const m = w.mirror[sid];
  if (m && !!m.done !== !!done) w.ack[sid] = !!done;
  if (w.studyosOpen) studyosConsumeAck(w);
}

// --- StudyOS side, mirroring taskmirror.js ---
function studyosConsumeAck(w) {
  let changed = false;
  Object.keys(w.ack).forEach(sid => {
    if (sid.indexOf('t_') !== 0) return;
    const id = sid.slice(2);
    if (w.sosTasks[id] && w.sosTasks[id].done !== !!w.ack[sid]) {
      w.sosTasks[id].done = !!w.ack[sid];
      changed = true;
    }
  });
  if (changed) studyosRepublish(w);
}

function studyosRepublish(w) {
  const items = {};
  Object.keys(w.sosTasks).forEach(id => {
    items['t_' + id] = {
      _sosId: 't_' + id, type: 'task', title: w.sosTasks[id].name,
      done: !!w.sosTasks[id].done, dateKey: '2026-08-30',
    };
  });
  w.mirror = items;
  pruneAck(w.mirror, w.ack);   // TaskHub prunes on the mirror snapshot
}

section('Behavioural: mode 1 -- tick with StudyOS CLOSED');
{
  const w = makeWorld();
  w.sosTasks = { a1: { name: 'Read ch.4', done: false } };
  studyosRepublish(w);
  w.studyosOpen = false;

  t('starts unticked', taskhubView(w, 't_a1') === false);
  taskhubTick(w, 't_a1', true);
  t('shows ticked right after the tick', taskhubView(w, 't_a1') === true);
  // A reload re-reads both docs from scratch; the mirror is unchanged.
  t('STILL ticked after a reload (this is the reported bug)',
    taskhubView(w, 't_a1') === true,
    'The mirror still says done:false; only the ack overlay preserves the tick.');
  t('still ticked after many reloads', taskhubView(w, 't_a1') === true);
}

section('Behavioural: mode 2 -- StudyOS comes online later');
{
  const w = makeWorld();
  w.sosTasks = { a1: { name: 'Read ch.4', done: false } };
  studyosRepublish(w);

  taskhubTick(w, 't_a1', true);
  t('ticked while StudyOS was closed', taskhubView(w, 't_a1') === true);

  w.studyosOpen = true;
  studyosConsumeAck(w);
  t('StudyOS applied the flip', w.sosTasks.a1.done === true);
  t('the mirror now agrees', w.mirror.t_a1.done === true);
  t('the ack entry was retired', !Object.prototype.hasOwnProperty.call(w.ack, 't_a1'),
    'A permanent ack would override a later untick made in StudyOS.');
  t('TaskHub still shows it ticked', taskhubView(w, 't_a1') === true);
}

section('Behavioural: mode 3 -- untick in StudyOS after a TaskHub tick');
{
  const w = makeWorld();
  w.sosTasks = { a1: { name: 'Read ch.4', done: false }, b2: { name: 'Essay', done: false } };
  studyosRepublish(w);
  w.studyosOpen = true;

  taskhubTick(w, 't_a1', true);
  t('a1 ticked and consumed', w.sosTasks.a1.done === true && !w.ack.t_a1);

  // The user unticks a1 inside StudyOS.
  w.sosTasks.a1.done = false;
  studyosRepublish(w);
  t('a1 reads unticked in TaskHub', taskhubView(w, 't_a1') === false);

  // Now tick a DIFFERENT task. The old full-map ack re-sent a1:true here.
  taskhubTick(w, 't_b2', true);
  t('ticking b2 does NOT re-tick a1',
    w.sosTasks.a1.done === false && taskhubView(w, 't_a1') === false,
    'The old ack published every done-state, so it re-asserted a stale true.');
  t('b2 is ticked', taskhubView(w, 't_b2') === true);
}

section('Behavioural: an ack never resurrects a deleted task');
{
  const w = makeWorld();
  w.sosTasks = { a1: { name: 'Read ch.4', done: false } };
  studyosRepublish(w);
  w.studyosOpen = false;

  taskhubTick(w, 't_a1', true);
  // Deleted inside StudyOS while TaskHub was away.
  delete w.sosTasks.a1;
  studyosRepublish(w);

  t('the task is gone from the mirror', !w.mirror.t_a1);
  t('the orphaned ack entry was pruned', !Object.prototype.hasOwnProperty.call(w.ack, 't_a1'));
  t('TaskHub does not resurrect it', taskhubView(w, 't_a1') === null);
}

section('Behavioural: untick from TaskHub survives a reload too');
{
  const w = makeWorld();
  w.sosTasks = { a1: { name: 'Read ch.4', done: true } };
  studyosRepublish(w);
  w.studyosOpen = false;

  t('starts ticked', taskhubView(w, 't_a1') === true);
  taskhubTick(w, 't_a1', false);
  t('unticked, and it survives a reload', taskhubView(w, 't_a1') === false,
    'The overlay has to work in both directions, not just false->true.');
}

// ------------------------------- summary -------------------------------
console.log('\n' + '-'.repeat(64));
if (fail) {
  console.log('FAILED: ' + fail + ' of ' + (pass + fail));
  console.log('\nRegressions:');
  failures.forEach(f => console.log('  * ' + f));
  process.exit(1);
}
console.log('ALL PASSED -- ' + pass + ' assertions');
