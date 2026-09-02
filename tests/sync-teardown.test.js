// Teardown-cycle sync defects — the "popup on every open" + "PC edits never reach
// the phone" pair.
//
// All four bugs below share one origin: _teardown() runs constantly (tab hidden
// 45s, 5 min idle, pagehide/freeze on every mobile app-switch) and it terminates
// the Firestore client, re-arms the server-seen gates, and bumps _fbGen — but the
// machinery built around those gates was not written to survive that cycle.
//
//   1. STUCK WATCHDOG      _teardown() never stopped the stall timers. A watcher
//                          armed before it kept ticking with a `started` clock
//                          already past the 60s alert threshold, and because
//                          _fbWatchStall refuses to arm a second watcher per key,
//                          it also BLOCKED the healthy one the next init() would
//                          have armed. Result: a permanent every-10-minutes popup
//                          on a connection that was working fine.
//   2. DEAD RETRY CLOSURE  _stallRetry held a doc ref bound to the terminated
//                          instance, so the watchdog's only escape hatch could
//                          never succeed. _freshGet swallowed that error and
//                          returned null, so _stallErr stayed empty and the popup
//                          blamed "the connection never confirmed" — which is why
//                          the real cause could not be read off the message.
//   3. DROPPED EDIT        A parked write replayed after a teardown failed the
//                          generation check and was DISCARDED. The task stayed in
//                          localStorage so the PC looked correct, while the cloud
//                          never received it and the phone never saw it.
//   4. DISCARDED SNAPSHOT  A remote doc arriving while a local write was pending
//                          hit a bare `return`. Firestore never re-sends an
//                          unchanged doc, so the other device's change was gone
//                          from the UI for good — and the pending whole-document
//                          write then overwrote it in the cloud too.

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

// ── Rig: the shipped gate + watchdog + teardown cycle, on a fake clock ────────
function makeRig(opts) {
  opts = opts || {};
  const st = {
    now: 0, timers: [], alerts: [], written: [], retries: 0,
    serverSeen: false, pending: [], gen: 0, live: true, clientId: 1,
    serverAvailable: false, stallTimers: {}, stallErr: {}, stallRetry: {},
    // set true to model the FIXED behaviour, false for the original
    fixed: opts.fixed !== false,
  };

  const setIntervalFake = (fn, ms) => { const t = { fn, ms, next: st.now + ms, alive: true }; st.timers.push(t); return t; };
  const clearIntervalFake = (t) => { if (t) t.alive = false; };

  const stopStall = (key) => {
    if (st.stallTimers[key]) { clearIntervalFake(st.stallTimers[key]); st.stallTimers[key] = null; }
    if (st.fixed) delete st.stallErr[key];
  };
  const stopAllStalls = () => Object.keys(st.stallTimers).forEach(stopStall);

  const markSeen = () => {
    if (st.serverSeen) return;
    st.serverSeen = true;
    stopStall('vedasdash');
    const q = st.pending; st.pending = [];
    q.forEach(fn => fn());
  };

  // The escape hatch. It closes over the client instance it was registered
  // against, exactly as the shipped _stallRetry closes over a doc ref bound to one
  // particular Firestore client. After terminate()+re-init that ref is permanently
  // dead — a LATER client being alive does not revive it.
  const registerRetry = () => {
    const boundClientId = st.clientId;
    st.stallRetry['vedasdash'] = async () => {
      st.retries++;
      if (boundClientId !== st.clientId || !st.live) {
        if (st.fixed) throw new Error('client-terminated');
        return null;              // original: _freshGet swallowed it, evidence lost
      }
      if (st.serverAvailable) markSeen();
    };
  };
  registerRetry();

  const watch = () => {
    if (st.fixed && st.serverSeen) return;
    if (st.stallTimers['vedasdash']) return;       // one watcher per key
    const started = st.now;
    st.stallTimers['vedasdash'] = setIntervalFake(async () => {
      if (st.serverSeen) { stopStall('vedasdash'); return; }
      let err = null;
      try {
        if (st.stallRetry['vedasdash']) await st.stallRetry['vedasdash']();
        else err = 'no-retry-registered';
      } catch (e) { err = e.message; }
      if (st.fixed) {
        // Self-heal the one cause that waiting can never fix.
        if (err === 'client-terminated') { stopStall('vedasdash'); st.init(); return; }
        if (st.serverSeen) { stopStall('vedasdash'); return; }
        if (err) st.stallErr['vedasdash'] = err; else delete st.stallErr['vedasdash'];
      } else {
        if (err) st.stallErr['vedasdash'] = err;
        if (st.serverSeen) return;
      }
      if (st.now - started > 60000) st.alerts.push({ at: st.now, why: st.stallErr['vedasdash'] || 'connection-never-confirmed' });
    }, 10000);
  };

  const whenSeen = (fn) => { if (st.serverSeen) return fn(); st.pending = [fn]; watch(); };

  // A queued whole-document write, stamped with the generation it was built in.
  st.save = (label) => {
    const payload = { label, gen: st.gen };
    whenSeen(() => {
      if (payload.gen !== st.gen) {
        if (st.fixed) {
          // Rebuild from CURRENT state rather than discarding the user's edit.
          st.written.push(payload.label);         // the edit is still in local state
          return;
        }
        return;                                    // original: silently dropped
      }
      st.written.push(payload.label);
    });
  };

  st.init = () => {
    st.live = true;
    st.clientId++;                   // initializeFirestore() → a NEW client
    registerRetry();                 // re-registered against it
    // Anything still parked needs a watcher against the NEW client — in the app
    // this happens because the gate is re-entered (the next save, the pagehide
    // flush, or the watchdog's own self-heal tick). Without the fix, the stale
    // watcher from the previous connection is still occupying the key and this
    // is a no-op, which is precisely the wedge.
    if (st.pending.length) watch();
  };

  st.teardown = () => {
    st.live = false;                 // terminate(db) — every existing ref is now dead
    st.serverSeen = false;           // re-arm the gate
    st.gen++;                        // new generation
    if (st.fixed) stopAllStalls();   // THE FIX
  };

  st.advance = async (ms) => {
    const target = st.now + ms;
    for (;;) {
      const due = st.timers.filter(t => t.alive && t.next <= target).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      st.now = due.next; due.next += due.ms;
      await due.fn();
    }
    st.now = target;
  };
  return st;
}

(async () => {
  console.log('\n-- 1. the popup: a teardown must not leave a wedged watchdog behind --');
  // The real sequence: a write parks, then the 5-minute IDLE teardown fires. init()
  // does NOT run on that path — it waits for the next click/keypress/visibility
  // change — so the stale watcher keeps ticking against a dead retry closure with a
  // `started` clock from before the teardown, and alerts. When the user finally does
  // come back, init() re-registers the retry, but _fbWatchStall still refuses to arm
  // a fresh watcher and `started` is never reset, so the popup has already fired and
  // keeps re-firing on the 10-minute rate limit.
  {
    const r = makeRig({ fixed: false });
    r.save('edit-1');                 // parks, arms the watchdog
    await r.advance(20000);
    r.teardown();                     // idle teardown — no init() follows it
    r.serverAvailable = true;         // the network itself is FINE
    await r.advance(60000);           // user is away; watcher ticks on a dead ref
    ok('(regression model) stale watchdog alerts though the network is fine',
      r.alerts.length >= 1, r.alerts);
    ok('(regression model) and it blamed the connection, naming no real cause',
      r.alerts.length >= 1 && r.alerts[0].why === 'connection-never-confirmed', r.alerts[0]);
    r.init();                         // user comes back and clicks
    await r.advance(20000);
    ok('(regression model) the popup already fired before recovery was possible',
      r.alerts.length >= 1, r.alerts);
  }
  {
    const r = makeRig();
    r.save('edit-1');
    await r.advance(20000);
    r.teardown();
    r.serverAvailable = true;
    await r.advance(60000);
    ok('fixed: no popup on a connection that is working', r.alerts.length === 0, r.alerts);
    r.init();                         // user comes back
    await r.advance(20000);
    ok('fixed: still no popup after the user returns', r.alerts.length === 0, r.alerts);
    ok('fixed: the parked edit actually reached the cloud', r.written.includes('edit-1'), r.written);
  }

  console.log('\n-- 2. a genuinely stuck connection is still reported --');
  {
    const r = makeRig();
    r.save('edit-1');
    r.serverAvailable = false;        // really unreachable, no teardown involved
    await r.advance(90000);
    ok('the user IS still told when sync is truly stuck', r.alerts.length >= 1, r.alerts);
    ok('and it never stopped retrying', r.retries >= 8, r.retries);
    ok('nothing was written', r.written.length === 0);
  }

  console.log('\n-- 3. a dead retry closure self-heals instead of crying outage --');
  {
    const r = makeRig();
    r.save('edit-1');
    await r.advance(15000);
    r.live = false;                   // client terminated under the running watcher
    r.serverAvailable = true;
    await r.advance(45000);
    ok('the watchdog re-inited rather than alerting', r.alerts.length === 0, r.alerts);
    ok('and the parked edit landed once the client was live again',
      r.written.includes('edit-1'), r.written);
  }

  console.log('\n-- 4. a PC edit parked across a teardown must not be discarded --');
  {
    const r = makeRig({ fixed: false });
    r.save('add-task-on-pc');         // parks behind the server-seen gate
    r.teardown();                     // tab hidden / idle — bumps the generation
    r.serverAvailable = true;
    r.init();
    await r.advance(15000);
    ok('(regression model) the task is silently dropped, never reaching the cloud',
      !r.written.includes('add-task-on-pc'), r.written);
  }
  {
    const r = makeRig();
    r.save('add-task-on-pc');
    r.teardown();
    r.serverAvailable = true;
    r.init();
    await r.advance(15000);
    ok('fixed: the task reaches the cloud (so the phone can see it)',
      r.written.includes('add-task-on-pc'), r.written);
  }

  // ── 5. Listener: a remote doc arriving mid-write must be held, not dropped ──
  // Firestore does not re-send an unchanged document, so a bare `return` here is
  // the last time this session ever sees the other device's edit.
  function makeListener(fixed) {
    const L = { applied: [], deferred: null, savePending: false, lastWritten: 0, ownWrites: new Set() };
    L.onSnapshot = (d) => {
      if (L.savePending) {
        if (fixed) { L.deferred = d; }
        return;                       // original: gone for good
      }
      if (L.ownWrites.has(d.savedAt)) return;
      L.applied.push(d);
    };
    L.settleWrite = () => {
      L.savePending = false;
      if (!fixed) return;
      const d = L.deferred; L.deferred = null;
      if (!d || L.savePending) return;
      if (L.ownWrites.has(d.savedAt)) return;
      if (d.savedAt <= L.lastWritten) return;   // already superseded — no news
      L.applied.push(d);
    };
    return L;
  }

  console.log('\n-- 5. a phone edit landing mid-save must still reach the PC --');
  {
    const L = makeListener(false);
    L.savePending = true;                                   // PC is mid-save
    L.onSnapshot({ savedAt: 5000, from: 'phone' });          // phone edit arrives
    L.settleWrite();
    ok('(regression model) the phone edit is lost from the UI permanently',
      L.applied.length === 0, L.applied);
  }
  {
    const L = makeListener(true);
    L.savePending = true;
    L.onSnapshot({ savedAt: 5000, from: 'phone' });
    L.settleWrite();
    ok('fixed: the phone edit is replayed once the local write settles',
      L.applied.length === 1 && L.applied[0].from === 'phone', L.applied);
  }
  {
    const L = makeListener(true);
    L.savePending = true;
    L.lastWritten = 9000;                                   // our write is newer
    L.onSnapshot({ savedAt: 5000, from: 'phone' });
    L.settleWrite();
    ok('fixed: a held doc OLDER than our own write is not replayed over it',
      L.applied.length === 0, L.applied);
  }
  {
    const L = makeListener(true);
    L.savePending = true;
    L.ownWrites.add(7000);
    L.onSnapshot({ savedAt: 7000, from: 'self-echo' });
    L.settleWrite();
    ok('fixed: our own echo is still suppressed, not replayed as remote news',
      L.applied.length === 0, L.applied);
  }

  // ── Static: the shipped file really carries these fixes ────────────────────
  console.log('\n-- static: index.html --');
  {
    const HTML = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');

    ok('_teardown() stops every stall watchdog',
      /_fbStopAllStalls\(\);/.test(HTML) && /function _fbStopAllStalls\(\)/.test(HTML));

    ok('_teardown() stops them alongside re-arming the server-seen gates',
      /_noServerSeen = false;[\s\S]{0,1200}_fbStopAllStalls\(\);/.test(HTML),
      'The watchers must reset together with the gates they watch.');

    ok('_fbStopStall clears the recorded cause with the timer',
      /function _fbStopStall\(key\)\{[\s\S]{0,500}delete _stallErr\[key\];/.test(HTML),
      'A stale cause would mis-explain every later stall.');

    ok('the watchdog will not arm for a doc already confirmed',
      /function _fbWatchStall\(key, label, isSeen\) \{\s*\n\s*if \(isSeen\(\)\) return;/.test(HTML));

    ok('the watchdog re-checks the gate AFTER the retry resolves',
      /if \(isSeen\(\)\) \{ _fbStopStall\(key\); return; \}[\s\S]{0,500}if \(err\) _stallErr\[key\] = err;/.test(HTML),
      'Alerting on the tick that just succeeded is a false alarm.');

    ok('a refused SERVER read is reported even when the cache fallback answered',
      /let _fbLastServerErr = null;/.test(HTML) &&
      /_fbLastServerErr = _msg \|\| 'unknown';/.test(HTML) &&
      /if \(!err && _fbLastServerErr\) err = _fbLastServerErr;/.test(HTML),
      'Otherwise permission-denied is reported as "connection never confirmed" — ' +
      'and that one never fixes itself by waiting.');

    ok('a terminated client self-heals instead of reporting an outage',
      /err === 'client-terminated'[\s\S]{0,300}init\(\);/.test(HTML));

    ok('_freshGet fails fast on a terminated client rather than swallowing it',
      /_fbIsTerminated\(e\)\) throw new Error\('client-terminated'\)/.test(HTML) &&
      /function _fbIsTerminated\(e\)\{/.test(HTML),
      'Swallowing it is what made the popup blame the connection.');

    // BEHAVIOURAL, not textual. The three assertions above all passed while the
    // detector was broken, because they only prove _fbIsTerminated is CALLED --
    // not that it returns true for the error Firestore actually throws.
    //
    // Firestore throws exactly:
    //   new FirestoreError(FAILED_PRECONDITION, 'The client has already been terminated')
    // and FirestoreError sets BOTH `code` and `message`. The old detector tested
    // `e.code || e.message`, so it only ever saw 'failed-precondition' and the
    // message-matching regex never received the message. Result: every
    // terminated-client read was recorded as _fbLastServerErr='failed-precondition'
    // and shown to the user as 'The cloud could not be reached (failed-precondition)'
    // with advice to wait -- for a client waiting cannot revive. So run the real
    // error shape through the real function.
    {
      const _i = HTML.indexOf('function _fbIsTerminated');
      const _end = _i < 0 ? -1 : HTML.indexOf('\n  }', _i);
      const src = _end < 0 ? '' : HTML.slice(_i, _end + 4);
      ok('_fbIsTerminated is extractable for behavioural testing', !!src);
      if (src) {
        const isTerm = new Function(src + '; return _fbIsTerminated;')();
        class FirestoreError extends Error {
          constructor(code, message){ super(message); this.name='FirebaseError'; this.code=code; this.message=message; }
        }
        ok('detects the REAL terminated error (code+message, as Firestore throws it)',
          isTerm(new FirestoreError('failed-precondition','The client has already been terminated')),
          'e.code||e.message hides the message behind the code -- this is the popup bug.');
        ok('detects the trailing-period variant from ensureFirestoreConfigured',
          isTerm(new FirestoreError('failed-precondition','The client has already been terminated.')));
        ok('detects an INTERNAL ASSERTION failure',
          isTerm(new FirestoreError('internal','FIRESTORE INTERNAL ASSERTION FAILED: Unexpected state')));
        ok('detects a bare Error carrying only the message',
          isTerm(new Error('The client has already been terminated')));
        // Negatives matter as much: swallowing these as 'terminated' would hide a real
        // permissions problem or a genuinely missing index behind a silent retry.
        ok('does NOT swallow permission-denied',
          !isTerm(new FirestoreError('permission-denied','Missing or insufficient permissions.')),
          'permission-denied must stay visible -- waiting never fixes it.');
        ok('does NOT swallow a genuine failed-precondition (missing index)',
          !isTerm(new FirestoreError('failed-precondition','The query requires an index.')),
          'Only a failed-precondition ABOUT termination is a terminated client.');
        ok('does NOT swallow an unavailable outage',
          !isTerm(new FirestoreError('unavailable','The service is currently unavailable.')));
        ok('does NOT swallow the fresh-timeout sentinel', !isTerm(new Error('fresh-timeout')));
        ok('tolerates null', !isTerm(null));
      }
    }

    for (const [label, rebuild, pend] of [
      ['TaskHub', '_thRebuildPayload', '_pendingPayload'],
      ['Veda',    '_vdRebuildPayload', '_vdPendingPayload'],
    ]) {
      ok(label + ': a stale-generation write is rebuilt, not silently dropped',
        new RegExp(pend + '\\._gen !== _fbGen[\\s\\S]{0,1200}' + rebuild).test(HTML),
        'Dropping it loses the edit — the PC keeps it locally and the phone never sees it.');
      ok(label + ': the app exposes the rebuild hook',
        new RegExp('window\\.' + rebuild + '=\\(\\)=>').test(HTML));
    }

    for (const [label, defer, drain] of [
      ['TaskHub', '_thDeferredRemote', '_thDrainDeferred'],
      ['Veda',    '_vdDeferredRemote', '_vdDrainDeferred'],
    ]) {
      ok(label + ': a remote doc arriving mid-write is held, not discarded',
        new RegExp(defer + ' = d; return;').test(HTML),
        'Firestore never re-sends an unchanged doc — a bare return loses it for good.');
      ok(label + ': and it is replayed once the local write settles',
        new RegExp('function ' + drain + '\\(\\)').test(HTML) &&
        (HTML.match(new RegExp(drain + '\\(\\);', 'g')) || []).length >= 3,
        'Every path that clears savePending must drain, not just the success path.');
    }
  }

  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
})();
