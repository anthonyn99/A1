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

section('Static: EVERY server-seen guard is re-armed on teardown');

// Reported as "newer MyJournal content is just gone" and "the header button order
// reverts". Root cause: _thServerSeen/_vdServerSeen were re-armed on teardown but
// _bjServerSeen/_tjServerSeen/_noServerSeen were not — so after the tab was hidden
// for one second, those three writers would publish stale in-memory state without
// waiting for the new connection to re-confirm server state. Scoped to the real
// _teardown() body so a reset living somewhere else cannot satisfy the test.
const TEARDOWN = (() => {
  const a = HTML.indexOf('async function _teardown()');
  const b = HTML.indexOf('function _startIdleTimer', a);
  return a === -1 || b === -1 ? '' : HTML.slice(a, b);
})();

t('_teardown() body was located',
  TEARDOWN.length > 0 && /_fbGen\+\+;/.test(TEARDOWN),
  'The other tests in this section depend on finding it.');

for (const flag of ['_thServerSeen', '_vdServerSeen', '_bjServerSeen', '_tjServerSeen',
                    '_noServerSeen', '_vdkcServerSeen']) {
  t('teardown re-arms ' + flag,
    new RegExp(flag + '\\s*=\\s*false;').test(TEARDOWN),
    'Losing the connection must invalidate "we have seen server state" for EVERY writer, '
    + 'or that writer can clobber the doc on resume.');
}

section('Static: every whole-document writer is gated');

// A whole-doc setDoc replaces the entire document, so an ungated one can erase
// data it never read. Field-merge writers (Plans "p_<id>", the journals' per-entry
// "e_<id>") are excluded on purpose — they can only touch what they name.
for (const [label, fn, gate] of [
  ['TaskHub',    '_fbSave',           '_thWhenServerSeen'],
  ['Veda dash',  '_fbSaveVeda',       '_vdWhenServerSeen'],
  ['NavOrder',   '_fbSaveNavOrder',   '_noWhenServerSeen'],
  ['Veda Links', '_fbSaveVedaLinks',  '_vdkcWhenServerSeen'],
]) {
  // Anchor on the arrow-function form: several of these have an earlier
  // `window._fbX = null;` stub declaration that must not be matched instead.
  // Bound the slice at the NEXT window._fb* assignment so a gate belonging to a
  // different function cannot satisfy this test; fall back to a fixed window.
  const a = HTML.indexOf('window.' + fn + ' = (');
  const nxt = a === -1 ? -1 : HTML.indexOf('window._fb', a + fn.length + 10);
  const end = a === -1 ? 0 : Math.min(nxt === -1 ? a + 3000 : nxt, a + 3000);
  const body = a === -1 ? '' : HTML.slice(a, end);
  t(label + ' (' + fn + ') defers through ' + gate,
    body.includes(gate),
    'A whole-doc write that runs before server confirmation can erase unread remote data.');
}

t('Veda Links unlocks the guard only on a genuine server read',
  /if \(snap && !fromCache\) _vdkcMarkServerSeen\(\);/.test(HTML),
  'A cache fallback must NOT count as confirmation.');

t('Veda Links suppresses its own echoes exactly, not by a time window',
  /_vdkcOwnWrites\.has\(d\.savedAt\)/.test(HTML) &&
  !/Date\.now\(\) - _vdkcLastOwnSaveAt < 6000/.test(HTML),
  'The old 6000ms blanket window discarded genuine remote edits, which this device '
  + 'then overwrote with its next whole-doc save.');

t('Veda Links records its own savedAt BEFORE the write',
  /_vdkcNoteOwnWrite\(payload\.savedAt\);[\s\S]{0,120}await setDoc\(vdkcDocRef, payload\);/.test(HTML),
  'Registering after the write races the echo coming back through the listener.');

section('Static: NavOrder (header button order) write-path guards');

const NAVORDER = (() => {
  const a = HTML.indexOf('// ── NavOrder — drag-to-reorder app buttons');
  const b = HTML.indexOf('// ── Tesla widget setup', a);
  return a === -1 || b === -1 ? '' : HTML.slice(a, b);
})();

t('NavOrder block was located',
  NAVORDER.length > 0 && /dashboards\/navorder/.test(NAVORDER),
  'The other tests in this section depend on finding it.');

t('NavOrder save is gated on server confirmation',
  /_noWhenServerSeen\(/.test(NAVORDER),
  'An ungated whole-doc setDoc publishes the hardcoded DEFAULT order over the saved one.');

t('NavOrder stamps the generation it was built in',
  /const gen = _fbGen;/.test(NAVORDER),
  'Needed for the clock-independent backstop.');

t('NavOrder drops stale-generation payloads',
  /gen\s*!==\s*_fbGen/.test(NAVORDER),
  'A reorder composed before a teardown must not overwrite the document.');

t('NavOrder unlocks the guard only on a genuine server read',
  /const fromCache = !!\(snap\.metadata && snap\.metadata\.fromCache\);/.test(NAVORDER) &&
  /if \(!fromCache\) _noMarkServerSeen\(\);/.test(NAVORDER),
  'A cache snapshot must NOT count as confirmation.');

t('NavOrder suppresses its own echoes exactly, not by a time window',
  /_noOwnWrites\.has\(d\.savedAt\)/.test(NAVORDER) &&
  !/Date\.now\(\) - _noLastOwnSaveAt < 1500/.test(NAVORDER),
  'The old 1500ms blanket window also discarded genuine reorders from other '
  + 'devices, which this device then overwrote on its next save.');

t('NavOrder merges the remote order BEFORE unlocking the guard',
  NAVORDER.indexOf('_navOrderModule.applyRemote(d)') <
  NAVORDER.lastIndexOf('if (!fromCache) _noMarkServerSeen();'),
  'Otherwise a held write replays underneath the server state instead of on top of it.');

t('NavOrder re-reads the order at WRITE time, not at call time',
  /typeof getPayload === 'function'/.test(NAVORDER),
  'A payload captured before the gate opens is the PRE-merge order — replaying it '
  + 're-publishes exactly the stale arrangement the gate exists to suppress.');

t('the NavOrder caller passes a getter',
  /window\._fbSaveNavOrder\(function\(\)\{[\s\S]{0,400}tonyLinksMigrated:true/.test(HTML),
  'saveNavOrder() must defer serialising tonyOrder/vedaOrder until write time.');

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
  (HTML.match(/const fromCache = !!\(snap && snap\.metadata && snap\.metadata\.fromCache\);/g) || []).length >= 2 &&
  (HTML.match(/if \(snap && !fromCache\) _(th|vd)MarkServerSeen\(\);/g) || []).length >= 2,
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

section('Static: stale cache must not REPAINT the UI');

// The write path always refused to UPLOAD a cache-fallback read, but nothing
// stopped it being RENDERED — which is how "I opened the desktop, my additions
// were gone, I reloaded and they came back" happened.
t('Loaders tag cache-fallback reads so the caller can tell them apart',
  (HTML.match(/_fromCache/g) || []).length >= 6,
  'A cache read must be distinguishable from a genuine server read.');

t('Both applyRemote implementations reject an older document',
  (HTML.match(/if\(rs&&ls&&rs<ls\)\{/g) || []).length >= 2,
  'savedAt older than what we already applied carries no news and must be dropped.');

t('Both applyRemote implementations ignore a tie from the cache',
  (HTML.match(/if\(remote\._fromCache&&rs&&ls&&rs===ls\)return;/g) || []).length >= 2,
  'Re-applying a tied cache snapshot would clobber unsaved in-flight edits.');

t('Both push paths record their own write as the newest applied state',
  /thLastAppliedRef\.current=payload\.savedAt\|\|Date\.now\(\);/.test(HTML) &&
  /vdLastAppliedRef\.current=payload\.savedAt\|\|Date\.now\(\);/.test(HTML),
  'Set BEFORE the write, or a load landing mid-flight rolls the UI back.');

t('Both last-applied refs are declared',
  /const thLastAppliedRef=useRef\(0\);/.test(HTML) &&
  /const vdLastAppliedRef=useRef\(0\);/.test(HTML));

section('Static: cold phone open (StudyOS mirror race)');

// The mirror lives in a DIFFERENT doc with its own listener, and on a cold phone
// open its cached snapshot lands before vedasdash has loaded. Reconciling then
// rewrote the day-grid from empty state and queued a whole-doc write of it.
t('StudyOS mirror listener drops cached snapshots',
  /_sosMirrorUnsub = onSnapshot\(sosMirrorRef, \{ includeMetadataChanges: true \}[\s\S]{0,220}fromCache\) return;/.test(HTML),
  'A cached mirror snapshot on a cold open is what starts the wipe.');

t('Mirror reconcile refuses to run before Veda cloud data has loaded',
  /if\(!fbLoadedRef\.current\)return;/.test(HTML),
  'Reconciling against a not-yet-loaded grid rewrites data from empty state.');

t('Deferred mirror is replayed once the load lands',
  /if\(fbLoadedRef\.current\)\{[\s\S]{0,140}_sosMirrorLatest\)apply\(window\._sosMirrorLatest\);/.test(HTML),
  'Without the replay, StudyOS tasks would silently never appear.');

t('Mirror reconcile writes through the background-flagged setter',
  /setDataBg\(prev=>\{/.test(HTML) && /const setDataBg=useCallback/.test(HTML),
  'The one path that mutates data without the user must be distinguishable.');

t('Background writes are refused before cloud data has loaded',
  /payload\._bg && !window\._vdCloudLoaded/.test(HTML),
  'A pre-load payload carries a fresh Date.now(), so savedAt and generation checks both miss it.');

t('_bg is stripped before the payload is persisted',
  /delete payload\._bg;/.test(HTML),
  'Internal flags must never reach Firestore.');

t('applyRemote publishes the cloud-loaded flag',
  /window\._vdCloudLoaded=true;/.test(HTML),
  'The Firebase layer needs this fact to gate background writes.');

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
      // opts.noGen models the journals, which have the server-seen gate but no
      // generation backstop — so the gate is load-bearing entirely on its own.
      st.payload = opts.noGen ? { data, savedAt } : { data, savedAt, _gen: st.gen };
      st.savePending = true; st.timer = true;
      st.timer = false; when(doSave);
    },
    flush() { st.timer = false; when(doSave); },
    // opts.rearm === false models the shipped-then-fixed journal bug: teardown
    // destroyed the connection but left "we have seen server state" latched on.
    teardown(withFlush) { if (withFlush) this.flush(); if (opts.rearm !== false) st.seen = false; st.gen++; },
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

section('Behaviour: stale cache repainting the UI (the reported glitch)');

// Models the RENDER path: what the user actually sees. Mirrors applyRemote.
function makeUi() {
  const ui = { shown: null, lastApplied: 0 };
  ui.applyRemote = (remote) => {
    if (!remote) return;
    const rs = remote.savedAt || 0, ls = ui.lastApplied || 0;
    if (rs && ls && rs < ls) return;                       // older than what we have
    if (remote._fromCache && rs && ls && rs === ls) return; // tie from cache: no news
    ui.lastApplied = rs || ls;
    ui.shown = remote.data;
  };
  ui.edit = (data, savedAt) => { ui.shown = data; ui.lastApplied = savedAt; };
  return ui;
}

{ // The exact report: open desktop, a slow server makes the load fall back to a
  // stale IndexedDB copy, and recent additions vanish until a reload.
  const ui = makeUi();
  ui.applyRemote({ data: 'TASKS-A-B-C', savedAt: 5000 });   // fresh server read
  ui.edit('TASKS-A-B-C-D', 6000);                            // user adds an item
  // Slow server → _freshGet falls back to the cache, which predates the addition.
  ui.applyRemote({ data: 'TASKS-A-B-C', savedAt: 5000, _fromCache: true });
  t('a stale cache-fallback load does NOT revert what is on screen',
    ui.shown === 'TASKS-A-B-C-D',
    'This is the "it reverted, then a reload brought it back" glitch.');
}

{ // A cache read that ties the applied timestamp still must not clobber edits
  // made since (which have not been stamped into lastApplied yet).
  const ui = makeUi();
  ui.applyRemote({ data: 'BASE', savedAt: 5000 });
  ui.shown = 'BASE+TYPED';                                   // in-flight, unsaved
  ui.applyRemote({ data: 'BASE', savedAt: 5000, _fromCache: true });
  t('a tied cache read does not clobber an in-flight edit', ui.shown === 'BASE+TYPED');
}

{ // The fix must not break genuine cross-device sync.
  const ui = makeUi();
  ui.applyRemote({ data: 'OLD', savedAt: 1000 });
  ui.applyRemote({ data: 'FROM-PHONE', savedAt: 2000 });
  t('a genuinely newer remote change still applies', ui.shown === 'FROM-PHONE');
}

{ // A fresh SERVER read that is newer than our last edit must win — otherwise the
  // guard would itself cause staleness.
  const ui = makeUi();
  ui.edit('MY-EDIT', 3000);
  ui.applyRemote({ data: 'OTHER-DEVICE-NEWER', savedAt: 4000 });
  t('a newer server doc overrides our older local edit',
    ui.shown === 'OTHER-DEVICE-NEWER');
}

{ // First-ever load has no baseline; it must apply regardless of origin.
  const ui = makeUi();
  ui.applyRemote({ data: 'COLD-START', savedAt: 7000, _fromCache: true });
  t('a cold start still paints from cache (offline open must work)',
    ui.shown === 'COLD-START'); }

section('Behaviour: cold phone open wipes the cloud (the reported repro)');

// Models the cold-open ordering: the mirror doc's listener fires BEFORE vedasdash
// has loaded, the reconcile rewrites `data` from empty state, and the resulting
// whole-document write is held by the server-seen gate — then replays over the
// good cloud copy the moment the gate opens. That replay is the wipe.
function makePhone(cloud) {
  const p = {
    cloudLoaded: false, serverSeen: false, held: null,
    grid: {},                       // in-memory day grid (starts EMPTY on cold open)
    save(payload) {
      if (payload._bg && !p.cloudLoaded) return;      // the fix
      if (p.serverSeen) cloud.doc = { data: payload.data, savedAt: payload.savedAt };
      else p.held = payload;                          // held, replays on unlock
    },
    reconcile(mirrorItems, savedAt) {
      if (!p.cloudLoaded) return;                     // the fix (barrier)
      p.grid = Object.assign({}, p.grid, mirrorItems);
      p.save({ data: p.grid, savedAt, _bg: true });
    },
    load() { p.grid = cloud.doc.data; p.cloudLoaded = true; },
    markServerSeen() {
      p.serverSeen = true;
      if (p.held) { const h = p.held; p.held = null; p.save(h); }
    },
  };
  return p;
}

{ // The exact repro: open TaskHub on the phone, desktop edits get wiped.
  const cloud = { doc: { data: { mon: ['DESKTOP-TASK-1', 'DESKTOP-TASK-2'] }, savedAt: 5000 } };
  const phone = makePhone(cloud);
  // Cold open: the cached mirror snapshot arrives FIRST, before vedasdash loads.
  phone.reconcile({ tue: ['STUDYOS-TASK'] }, 9000);
  t('mirror reconcile before load does not queue a write',
    phone.held === null,
    'This queued payload is what replayed over the desktop edits.');
  // Now the real doc loads and the gate opens.
  phone.load();
  phone.markServerSeen();
  t('desktop tasks survive a cold phone open',
    cloud.doc.data.mon && cloud.doc.data.mon.length === 2,
    'THE REPORTED BUG: opening TaskHub on the phone reverted desktop edits.');
}

{ // After the load, the mirror must still reconcile normally.
  const cloud = { doc: { data: { mon: ['DESKTOP-TASK'] }, savedAt: 5000 } };
  const phone = makePhone(cloud);
  phone.load(); phone.markServerSeen();
  phone.reconcile({ tue: ['STUDYOS-TASK'] }, 9000);
  t('mirror still reconciles once loaded (StudyOS tasks appear)',
    cloud.doc.data.tue && cloud.doc.data.tue[0] === 'STUDYOS-TASK');
  t('and it does not drop the user\'s own tasks',
    cloud.doc.data.mon && cloud.doc.data.mon[0] === 'DESKTOP-TASK');
}

{ // A genuine USER edit before load is still held-and-replayed (not dropped) —
  // the background rule must not swallow real typing.
  const cloud = { doc: { data: { mon: ['OLD'] }, savedAt: 1000 } };
  const phone = makePhone(cloud);
  phone.save({ data: { mon: ['USER-TYPED'] }, savedAt: 2000 });  // no _bg flag
  t('a real user edit before load is held, not dropped', phone.held !== null);
  phone.markServerSeen();
  t('and it lands once the server confirms',
    cloud.doc.data.mon[0] === 'USER-TYPED',
    'Only AUTOMATED writes are refused pre-load; user edits must never be lost.');
}

section('Behaviour: MyJournal entries vanish after the tab is backgrounded');

// The reported failure. A journal write is a field-merge that ALSO republishes
// `_order`, the entry-ID list the UI renders from. Publish a stale `_order` and
// every entry created elsewhere disappears — the e_<id> payloads survive in the
// document, but nothing lists them, so it reads as "the content is just gone".
// Teardown fires 1s after the tab is hidden, so this ran constantly.
// The journals have NO generation backstop (noGen), so the server-seen re-arm is
// the only thing standing between a resumed tab and someone's lost writing.
{
  const run = (rearm) => {
    const cloud = { doc: { data: ['a', 'b'], savedAt: 1000 } };   // data === _order
    const desktop = makeDevice(cloud, { rearm, noGen: true });
    desktop.load(false);                                          // seen = true
    desktop.teardown(false);                                      // tab hidden 1s → teardown
    cloud.doc = { data: ['a', 'b', 'c'], savedAt: 2000 };         // phone adds entry c
    desktop.edit(['a', 'b'], 3000);                               // resume + type, pre-snapshot
    return cloud;
  };

  const broken = run(false);
  t('(regression model) un-rearmed guard really does lose the new entry',
    !broken.doc.data.includes('c'),
    'If this fails the model no longer reproduces the bug and the test below proves nothing.');

  const fixed = run(true);
  t('re-armed guard holds the write instead of republishing a stale _order',
    fixed.doc.data.includes('c'),
    'The resumed tab must not publish an entry list built before it lost the connection.');

  // ...and the held edit is not lost either: it lands once the server confirms.
  const cloud = { doc: { data: ['a', 'b'], savedAt: 1000 } };
  const desktop = makeDevice(cloud, { noGen: true });
  desktop.load(false);
  desktop.teardown(false);
  cloud.doc = { data: ['a', 'b', 'c'], savedAt: 2000 };
  desktop.edit(['a', 'b', 'd'], 3000);      // user creates entry d while disconnected
  desktop.snap(false);                      // fresh server snapshot arrives → merge + replay
  t('the held journal edit still lands after reconnect',
    cloud.doc.data.includes('d'),
    'Holding a write must never mean dropping it.');
}

section('Behaviour: header button order reverts (dashboards/navorder)');

// NavOrder had none of the guards: no server-seen gate and no generation stamp.
// Its payload is built from an in-memory order that STARTS as the hardcoded
// defaults, so a save before the first server snapshot published the defaults
// over the real saved arrangement.
// Mirrors the shipped NavOrder implementation: the saver takes a GETTER, so a
// write released by the gate serialises the CURRENT in-memory order (i.e. after
// the snapshot handler merged the server's copy in), not the order as it stood
// when the save was requested.
function makeNavOrder(cloud, guarded) {
  let seen = !guarded;                 // ungated old code behaved as if always seen
  let pending = null;
  let order = 'DEFAULT-ORDER';         // in-memory order starts as the hardcoded default
  let clock = 6000;
  const own = new Set();
  const write = () => {
    const savedAt = ++clock;
    own.add(savedAt);
    cloud.doc = { data: order, savedAt };   // getter re-read at write time
  };
  return {
    reorder(v) { order = v; },
    save() { if (seen) write(); else pending = write; },
    snap() {
      const d = cloud.doc;
      if (own.has(d.savedAt)) { seen = true; return; }   // our own echo
      order = d.data;                                    // applyRemote merges server order
      seen = true;                                       // marked AFTER the merge
      if (pending) { const p = pending; pending = null; p(); }
    },
    get order() { return order; },
  };
}

{
  // Old code: no gate. The seed/reorder fires before the first snapshot and the
  // hardcoded defaults land on top of the real saved order.
  const c1 = { doc: { data: 'SAVED-ORDER', savedAt: 5000 } };
  makeNavOrder(c1, false).save();
  t('(regression model) ungated NavOrder save really does clobber the saved order',
    c1.doc.data === 'DEFAULT-ORDER',
    'If this fails the model no longer reproduces the bug.');

  // Shipped: the write is held, the snapshot merges the saved order in, and the
  // released write re-reads that merged order instead of the stale defaults.
  const c2 = { doc: { data: 'SAVED-ORDER', savedAt: 5000 } };
  const dev2 = makeNavOrder(c2, true);
  dev2.save();
  dev2.snap();
  t('gated NavOrder save cannot publish defaults over the saved order',
    c2.doc.data === 'SAVED-ORDER',
    'The held write must serialise the merged order, not the pre-load defaults.');

  // ...and a real reorder still saves, which is the whole point of the feature.
  const c3 = { doc: { data: 'SAVED-ORDER', savedAt: 5000 } };
  const dev3 = makeNavOrder(c3, true);
  dev3.snap();                       // load first
  dev3.reorder('USER-DRAGGED');
  dev3.save();
  t('a genuine reorder after load still reaches the cloud',
    c3.doc.data === 'USER-DRAGGED',
    'The guard must not turn into "reordering never persists".');

  // A reorder made BEFORE the connection confirms must survive too, on top of
  // whatever the server had — held, merged, then re-read and published.
  const c4 = { doc: { data: 'SAVED-ORDER', savedAt: 5000 } };
  const dev4 = makeNavOrder(c4, true);
  dev4.reorder('OFFLINE-DRAG');
  dev4.save();                       // held
  dev4.snap();                       // merge sets order to SAVED-ORDER, then replays
  t('an offline reorder is held rather than dropped',
    c4.doc.data === 'SAVED-ORDER' && c4.doc.savedAt > 5000,
    'The write still happens; it just publishes the reconciled order.');
}

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
