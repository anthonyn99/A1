// Sync stall watchdog.
//
// ROOT CAUSE of the 2026-08-25 loss. Writes park until a GENUINE server read
// confirms the document — correct, because a cache-only load must never push
// stale state over good cloud data. But the gate had no way out:
//
//   function _thWhenServerSeen(fn) {
//     if (_thServerSeen) return fn();
//     _thPendingWrites = [fn];      // parked
//     return Promise.resolve();     // ...forever
//   }
//
// If _freshGet burned its three attempts and fell back to the local cache,
// `fromCache` was true, server-seen was never set, and from then on EVERY write
// parked silently while the UI still reported "saved". A desktop wrote all day
// into that queue; the phone kept showing the older cloud copy; when the desktop
// finally reloaded it got a real server read, applied the OLD remote over its
// newer local state, and the day's work was gone from both sides.
//
// The watchdog retries the server read on a timer and, if writes are still stuck
// after a minute, says so loudly — while the local copy is still the good one.

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};

// Faithful re-implementation of the shipped gate + watchdog, on a fake clock.
function makeRig() {
  const st = {
    serverSeen: false, pending: [], written: [], alerts: [],
    now: 0, timers: [], retries: 0, serverAvailable: false,
  };
  const setIntervalFake = (fn, ms) => { const t = { fn, ms, next: st.now + ms, live: true }; st.timers.push(t); return t; };
  const clearIntervalFake = (t) => { if (t) t.live = false; };

  const markSeen = () => {
    if (st.serverSeen) return;
    st.serverSeen = true;
    if (watcher) { clearIntervalFake(watcher); watcher = null; }   // stop immediately
    const q = st.pending; st.pending = [];
    q.forEach(fn => fn());
  };
  const retry = async () => {
    st.retries++;
    if (st.serverAvailable) markSeen();          // a real server read unlocks
  };
  let watcher = null;
  const watch = () => {
    if (watcher) return;
    const started = st.now;
    watcher = setIntervalFake(async () => {
      if (st.serverSeen) { clearIntervalFake(watcher); watcher = null; return; }
      await retry();
      if (!st.serverSeen && st.now - started > 60000) st.alerts.push(st.now);
    }, 10000);
  };
  const whenSeen = (fn) => { if (st.serverSeen) return fn(); st.pending = [fn]; watch(); };

  st.save = (label) => whenSeen(() => st.written.push(label));
  st.advance = async (ms) => {
    const target = st.now + ms;
    for (;;) {
      const due = st.timers.filter(t => t.live && t.next <= target).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      st.now = due.next; due.next += due.ms;
      await due.fn();
    }
    st.now = target;
  };
  return st;
}

(async () => {
  console.log('\n-- the bug: a parked write must not vanish --');
  {
    const r = makeRig();
    r.save('edit-1');
    ok('write is parked, not sent, while unconfirmed', r.written.length === 0 && r.pending.length === 1);
    await r.advance(30000);
    ok('watchdog is retrying the server read', r.retries >= 2, r.retries);
    ok('still nothing written while the server is unreachable', r.written.length === 0);
  }

  console.log('\n-- recovery: the moment the server answers, parked work flushes --');
  {
    const r = makeRig();
    r.save('edit-1');
    await r.advance(25000);
    r.serverAvailable = true;                     // connection comes back
    await r.advance(15000);
    ok('parked write is sent automatically', r.written.includes('edit-1'), r.written);
    ok('queue drained', r.pending.length === 0);
    ok('no alert needed — it recovered inside the minute', r.alerts.length === 0, r.alerts);
  }

  console.log('\n-- the silence that lost the data is gone --');
  {
    const r = makeRig();
    r.save('edit-1');
    await r.advance(90000);
    ok('user IS told after a minute of being stuck', r.alerts.length >= 1, r.alerts);
    ok('and it never gave up retrying', r.retries >= 8, r.retries);
  }

  console.log('\n-- once confirmed, writes go straight through --');
  {
    const r = makeRig();
    r.serverAvailable = true;
    r.save('edit-1');                              // still parks: not yet seen
    await r.advance(11000);
    ok('first write lands after confirmation', r.written.includes('edit-1'));
    r.save('edit-2');
    ok('subsequent writes are immediate, not parked', r.written.includes('edit-2') && r.pending.length === 0);
    ok('watchdog stopped once seen', r.timers.every(t => !t.live), r.timers.map(t => t.live));
  }

  console.log('\n-- only the newest payload is kept while parked --');
  {
    const r = makeRig();
    r.save('old'); r.save('newer'); r.save('newest');
    ok('queue holds exactly one entry', r.pending.length === 1);
    r.serverAvailable = true;
    await r.advance(11000);
    ok('the newest state is what gets written', r.written.length === 1 && r.written[0] === 'newest', r.written);
  }

  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
})();
