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
