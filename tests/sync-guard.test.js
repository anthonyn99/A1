#!/usr/bin/env node
/**
 * TaskHub sync regression tests.
 *
 * WHY THIS FILE EXISTS
 * The "my edits reverted" bug was fixed three separate times and came back twice,
 * because each fix was verified by reading the code rather than by running it.
 * These tests encode the failure modes so a regression fails loudly instead of
 * silently eating a day of someone's work.
 *
 * WHAT IT CHECKS
 * Part 1 — STATIC: asserts the real index.html still contains the specific
 *   protections. These catch a well-meaning edit that removes a guard.
 * Part 2 — BEHAVIOURAL: a faithful model of the save/listener/teardown state
 *   machine, replaying each historical bug end-to-end.
 *
 * Run: node tests/sync-guard.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  ✗ ' + name); }
}
function section(s) { console.log('\n' + s); }

// ───────────────────────── Part 1: static guards ─────────────────────────
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

section('Static: write-path guards present in index.html');

t('TaskHub save is gated on server confirmation',
  /_saveTimer\s*=\s*setTimeout\(\(\)\s*=>\s*_thWhenServerSeen\(_doTaskHubSave\)/.test(HTML),
  'window._fbSave must defer through _thWhenServerSeen, not call _doTaskHubSave directly.');

t('Veda save is gated on server confirmation',
  /_vdSaveTimer\s*=\s*setTimeout\(\(\)\s*=>\s*_vdWhenServerSeen\(_doVedaSave\)/.test(HTML),
  'window._fbSaveVeda must defer through _vdWhenServerSeen.');

t('TaskHub flush respects the guard',
  /window\._fbFlush\s*=[^\n]*_thWhenServerSeen\(_doTaskHubSave\)/.test(HTML),
  'A tab-hide flush must not bypass the guard.');

t('Veda flush respects the guard',
  /window\._fbFlushVeda\s*=[^\n]*_vdWhenServerSeen\(_doVedaSave\)/.test(HTML),
  'A tab-hide flush must not bypass the guard.');

t('Teardown re-arms both server-seen guards',
  /_thServerSeen\s*=\s*false;[\s\S]{0,200}_vdServerSeen\s*=\s*false;/.test(HTML),
  'Losing the connection must invalidate "we have seen server state".');

t('Teardown bumps the generation counter',
  /_fbGen\+\+;/.test(HTML),
  'Without this, protection depends on device clocks agreeing.');

t('Both save paths stamp the generation',
  (HTML.match(/payload\._gen\s*=\s*_fbGen;/g) || []).length >= 2,
  'Each payload must record the generation it was built in.');

t('Both save paths drop stale-generation payloads',
  (HTML.match(/_gen\s*!==\s*undefined\s*&&[\s\S]{0,40}_gen\s*!==\s*_fbGen/g) || []).length >= 2,
  'A payload built before the last disconnect must never overwrite the document.');

section('Static: listener ordering (the bug that reverted the desktop)');

// The fatal pattern was: unlock the guard, THEN discard the snapshot via an early
// return on savePending. Assert the drop-stale-write check precedes the unlock.
for (const [label, markFn, pendingVar] of [
  ['TaskHub', '_thMarkServerSeen', '_savePending'],
  ['Veda',    '_vdMarkServerSeen', '_vdSavePending'],
]) {
  const body = HTML.slice(HTML.indexOf('onSnapshot(' + (label === 'Veda' ? 'vdDocRef' : 'docRef') + ', { includeMetadataChanges'));
  const cb = body.slice(0, body.indexOf('}, (err)'));
  const idxDrop = cb.search(new RegExp(pendingVar + '\\s*&&\\s*\\(d\\.savedAt'));
  // NOTE: the `!snap.exists()` early-return line contains its own MarkServerSeen
  // call. We care about the one gating the MAIN path, i.e. the first occurrence
  // AFTER the stale-write check — not that incidental earlier one.
  const idxMark = cb.indexOf(markFn + '()', idxDrop === -1 ? 0 : idxDrop);
  // Likewise anchor the bare `if (savePending) return;` to after the unlock, so we
  // measure the real early-return and not an unrelated one further up.
  const reEarly = new RegExp('if\\s*\\(' + pendingVar + '\\)\\s*return');
  const tailFrom = idxMark === -1 ? 0 : idxMark;
  const relEarly = cb.slice(tailFrom).search(reEarly);
  const idxEarly = relEarly === -1 ? -1 : tailFrom + relEarly;
  t(label + ': stale-write check runs BEFORE the guard unlocks',
    idxDrop !== -1 && idxMark !== -1 && idxDrop < idxMark,
    'Unlocking writes on a snapshot that is then discarded is exactly the bug.');
  t(label + ': guard unlocks BEFORE the savePending early-return',
    idxMark !== -1 && idxEarly !== -1 && idxMark < idxEarly,
    'Otherwise a pending save permanently blocks the unlock.');
}

section('Static: mobile/iOS lifecycle');

t('Ready listener is NOT one-shot (both apps re-pull on reconnect)',
  !/addEventListener\("fb-ready",onReady,\{once:true\}\)/.test(HTML) &&
  (HTML.match(/addEventListener\("fb-ready",onReady\)/g) || []).length >= 2,
  'A {once:true} ready listener is why the phone never re-fetched.');

t('pageshow/resume reconnect handlers exist (iOS bfcache)',
  /addEventListener\("pageshow"/.test(HTML) && /addEventListener\("resume"/.test(HTML),
  'iOS restores the web app without firing visibilitychange.');

t('Pending writes are flushed BEFORE teardown bumps the generation',
  /_flushThenTeardown[\s\S]{0,200}_fbFlushAll[\s\S]{0,80}_teardown\(\)/.test(HTML),
  'Otherwise an edit made just before backgrounding is dropped as stale-generation.');

t('Loader only unlocks on a genuine server read',
  (HTML.match(/!\(snap\.metadata\s*&&\s*snap\.metadata\.fromCache\)\)\s*_(th|vd)MarkServerSeen/g) || []).length >= 2,
  'A cache fallback must NOT count as confirmation.');

section('Static: pull-to-refresh');

t('pull-to-refresh re-reads the cloud rather than reloading the page',
  /pull-to-refresh failed/.test(HTML) &&
  /profile === 'veda' \? window\._fbLoadVeda : window\._fbLoad/.test(HTML),
  'location.reload() would discard unsaved edits and re-run the App Lock gate.');

t('pull-to-refresh flushes pending edits before re-reading',
  /_fbFlushAll[\s\S]{0,400}typeof loader !== 'function'/.test(HTML),
  'Refreshing must never drop something typed but not yet saved.');

t('pull-to-refresh repaints via the same event a live snapshot uses',
  /dispatchEvent\(new CustomEvent\(evt, \{ detail: remote \}\)\)/.test(HTML),
  'A second merge path would drift from the listener implementation.');

t('pull-to-refresh is touch-only',
  /matchMedia\('\(pointer: coarse\)'\)\.matches\) return;/.test(HTML),
  'Must be inert on desktop.');

section('Static: loader does not discard valid cloud docs');

t('Cloud doc accepted without requiring savedAt',
  (HTML.match(/remote\.data\|\|remote\.habits\|\|remote\.goals\|\|remote\.savedAt/g) || []).length >= 2,
  'Gating on savedAt silently dropped valid docs and invited a stale overwrite.');

// ───────────────────── Part 2: behavioural state machine ─────────────────────
// Mirrors the shipped save/listener/teardown logic.
function makeDevice(cloud, opts) {
  opts = opts || {};
  const st = {
    seen: false, queued: [], savePending: false, payload: null, gen: 0,
    mem: null, own: new Set(), timer: false,
  };
  const mark = () => {
    if (st.seen) return;
    st.seen = true;
    const q = st.queued; st.queued = [];
    q.forEach(fn => fn());
  };
  const when = (fn) => { if (st.seen) return fn(); st.queued = [fn]; };
  const doSave = () => {
    if (!st.payload) return;
    if (st.payload._gen !== undefined && st.payload._gen !== st.gen) {   // generation backstop
      st.payload = null; st.savePending = false; return;
    }
    const p = st.payload; st.payload = null;
    st.own.add(p.savedAt);
    cloud.doc = { data: p.data, savedAt: p.savedAt };
    st.savePending = false;
  };
  return {
    st,
    load(fromCache) { if (!fromCache) mark(); st.mem = cloud.doc.data; },
    edit(data, savedAt) {
      st.mem = data;
      st.payload = { data, savedAt, _gen: st.gen };
      st.savePending = true; st.timer = true;
      st.timer = false; when(doSave);
    },
    flush() { st.timer = false; when(doSave); },
    teardown(withFlush) { if (withFlush) this.flush(); st.seen = false; st.gen++; },
    snap(fromCache) {
      const d = cloud.doc;
      if (fromCache) return;
      if (st.savePending && (d.savedAt || 0) > (st.payload ? (st.payload.savedAt || 0) : 0)) {
        st.payload = null; st.timer = false; st.savePending = false;
      }
      mark();
      if (st.savePending) return;
      if (st.own.has(d.savedAt || 0)) return;
      st.mem = d.data;
    },
  };
}

section('Behaviour: the reported failures');

{ // The original report: a day of desktop edits reverted.
  const cloud = { doc: { data: 'DESKTOP-DAY-OF-EDITS', savedAt: 9000 } };
  const phone = makeDevice(cloud);
  phone.load(false); phone.teardown(true);
  cloud.doc = { data: 'DESKTOP-DAY-OF-EDITS', savedAt: 9000 };
  phone.edit('PHONE-STALE', 5000);            // queued from stale memory on resume
  t('stale phone write does not reach the cloud while disconnected',
    cloud.doc.data === 'DESKTOP-DAY-OF-EDITS');
  phone.snap(false);
  t('desktop edits survive the phone reconnecting',
    cloud.doc.data === 'DESKTOP-DAY-OF-EDITS');
  t('phone adopts the desktop edits', phone.st.mem === 'DESKTOP-DAY-OF-EDITS');
}

{ // Clock skew: phone clock is fast, so its stale data has a HIGHER timestamp.
  const cloud = { doc: { data: 'DESKTOP-REAL', savedAt: 1000 } };
  const phone = makeDevice(cloud);
  phone.load(false); phone.teardown(false);   // disconnect, nothing pending
  phone.st.payload = { data: 'PHONE-STALE', savedAt: 999999, _gen: phone.st.gen - 1 };
  phone.st.savePending = true;
  phone.snap(false);                          // reconnect; savedAt comparison FAILS here
  phone.flush();
  t('clock-skewed stale write is still rejected (generation backstop)',
    cloud.doc.data === 'DESKTOP-REAL',
    'This is the case a timestamp comparison alone cannot catch.');
}

section('Behaviour: no data loss in the other direction');

{ const cloud = { doc: { data: 'OLD', savedAt: 1000 } };
  const d = makeDevice(cloud); d.load(false);
  d.edit('MY-NEW-TYPING', 5000);
  t('a genuinely newer local edit still reaches the cloud', cloud.doc.data === 'MY-NEW-TYPING'); }

{ const cloud = { doc: { data: 'CLOUD', savedAt: 1000 } };
  const d = makeDevice(cloud);
  d.edit('OFFLINE-EDIT', 2000);               // never confirmed a server read
  t('offline edit is held, not written', cloud.doc.data === 'CLOUD');
  d.snap(false);
  t('offline edit replays once the server confirms', cloud.doc.data === 'OFFLINE-EDIT'); }

{ const cloud = { doc: { data: 'X', savedAt: 1000 } };
  const d = makeDevice(cloud); d.load(false);
  d.edit('TYPED-JUST-BEFORE-BACKGROUNDING', 3000);
  d.teardown(true);                           // flush THEN bump generation
  t('edit made just before backgrounding is not lost',
    cloud.doc.data === 'TYPED-JUST-BEFORE-BACKGROUNDING',
    'Teardown must flush before invalidating the generation.'); }

{ const cloud = { doc: { data: 'MINE', savedAt: 4000 } };
  const d = makeDevice(cloud); d.load(false);
  d.edit('MINE2', 5000); d.snap(false);
  t('our own write echo does not revert the user', d.st.mem === 'MINE2'); }

// ───────────────────────────────── summary ─────────────────────────────────
console.log('\n' + '─'.repeat(64));
if (fail) {
  console.log('FAILED: ' + fail + ' of ' + (pass + fail));
  console.log('\nRegressions:');
  failures.forEach(f => console.log('  • ' + f));
  console.log('\nThese guard against silent data loss. Do not weaken a test to make it pass.');
  process.exit(1);
}
console.log('All ' + pass + ' sync-guard checks passed.');
