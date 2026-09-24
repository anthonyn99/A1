// Guards Code Mode's Firestore sync in the console (Phase 13).
//
// Not a regex check: the real functions are cut out of magi.html and run in a
// VM against a fake Firestore that counts writes, with fake timers. What this
// pins, and why each matters:
//   1. The merge: newest updatedAt wins per project, a tie changes nothing,
//      each engine owns only its own binding, a deletion beats older copies.
//   2. Write counts, the whole point of the phase: one change -> one write;
//      ten rapid changes -> one write; nothing new -> no write; a running
//      task -> ZERO writes until it ends; a finished task -> one index write
//      plus one body doc, once, even when its stream is replayed.
//   3. The listener branch ignores an identical snapshot and stands aside
//      while a change made here is on its way up.
//   4. No second listener: onSnapshot appears exactly once in the page.
//   5. The 64 KB guard.
//
// The engine half is magi/tests/test_code_sync.py; the browser half is
// tests/live/magi-sync.live.js.
//
// Run: node tests/magi-code-sync.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MAGI = fs.readFileSync(path.join(__dirname, '..', 'magi.html'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const a = MAGI.indexOf('/* ══ CODE MODE, ACROSS YOUR DEVICES (Phase 13)');
const b = MAGI.indexOf('/** Share a token this browser has.');
const BLOCK = a > 0 && b > a ? MAGI.slice(a, b) : '';
ok('the sync block is where it should be', BLOCK.length > 2000);

// ── a tiny world for the block to run in ──────────────────────────────────
function world() {
  const timers = [];
  let now = 0;
  const ls = new Map();
  const ss = new Map();
  const writes = [];
  const docs = new Map();
  const W = {
    writes, docs, timers,
    console: { warn(...m) { if (process.env.DEBUG) console.log('   warn', ...m); }, log() {} },
    Date: class extends Date {
      constructor(...x) { super(...(x.length ? x : [1790000000000 + now])); }
      static now() { return 1790000000000 + now; }
      static parse(s) { return Date.parse(s); }
    },
    JSON, Math, Map, Set, Object, Array, String, Number, isNaN, Promise, Error,
    setTimeout(fn, ms) { const t = { fn, due: now + ms, id: timers.length + 1 }; timers.push(t); return t.id; },
    clearTimeout(id) { const t = timers.find((x) => x.id === id); if (t) t.fn = null; },
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) },
    sessionStorage: { getItem: (k) => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)) },
    lsKey: (k) => 'magi.tony.' + k,
    prof: () => ({ doc: 'magi' }),
    CLOUD: {
      enabled: true, db: {},
      fs: {
        doc: (db, ...p) => ({ path: p.join('/') }),
        setDoc: async (ref, data, opts) => { writes.push({ path: ref.path, data: JSON.parse(JSON.stringify(data)), opts }); docs.set(ref.path, data); },
        getDoc: async (ref) => ({ exists: () => docs.has(ref.path), data: () => docs.get(ref.path) }),
        serverTimestamp: () => 'TS',
      },
    },
    cloudInit: async () => true,
    _indexDoc: () => ({ path: 'magi' }),
    setSync() {}, _syncFail: (w, e) => w + ': ' + e.message,
    codeMode: () => false, renderCodeView() {}, updateEnabled() {},
    online: () => true, codeSetProject() {},
    CODE: { state: null, order: [], picks: null, task: null },
    engine: null, puts: [],
    advance(ms) { now += ms; },
  };
  W.lsRead = (k, d) => { const v = W.localStorage.getItem(k); return v == null ? d : JSON.parse(v); };
  W.lsWrite = (k, v) => W.localStorage.setItem(k, JSON.stringify(v));
  W.CODE_ORDER_KEY = 'magi.tony.code.order';
  W.CODE_PICK_KEY = 'magi.tony.code.units';
  W.codeBusy = () => !!(W.CODE.task && !W.CODE.task.done);
  W.codeGet = async (p) => {
    if (p === '/sync') return JSON.parse(JSON.stringify(W.engine));
    if (p === '/state') return { projects: [], engine: W.engine.engine, rev: W.engine.rev };
    throw new Error('unexpected ' + p);
  };
  W.codePost = async (p, body, method) => {
    W.puts.push(body);
    // A fake engine that applies what is newer, the way sync.py does.
    const t = (s) => Date.parse(s || '') || 0;
    let saved = 0;
    for (const [id, c] of Object.entries(body.projects || {})) {
      const e = W.engine.projects[id];
      if (!e || t(c.updatedAt) > t(e.updatedAt)) {
        W.engine.projects[id] = { ...c, bindings: e ? e.bindings : {} };
        saved++;
      }
    }
    if (saved) W.engine.rev++;
    return { ok: true, applied: { save: saved, delete: 0, tomb: 0 }, ...JSON.parse(JSON.stringify(W.engine)) };
  };
  vm.createContext(W);
  vm.runInContext(BLOCK + '\nthis.__x = { codeStable, codeSyncMerge, codeSyncFromCloud, codeSyncCheck, codeSyncReconcile, cloudSaveCode, codeFlush, codeSyncTaskEnd, codeChainTouched, CODE_SYNC, get dirty() { return _codeDirty; } };', W);
  return W;
}

// Run every due timer, then let promises settle; repeat until quiet.
async function settle(W, ms = 5000) {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setImmediate(r));
    W.advance(ms);
    const due = W.timers.filter((t) => t.fn);
    if (!due.length) { await new Promise((r) => setImmediate(r)); return; }
    for (const t of due) { const f = t.fn; t.fn = null; await f(); }
  }
}

const P = (name, at, bind) => ({ name, aliases: [], prefs: { autoCommit: false }, notes: '',
                                 updatedAt: at, bindings: bind || {} });
const T1 = '2026-09-24T10:00:00.000001+00:00';
const T2 = '2026-09-24T11:00:00+00:00';

(async () => {
  console.log('\nThe merge');
  {
    const { codeSyncMerge: M } = world().__x;
    const eng = { engine: { id: 'desk' }, projects: { a: P('A', T2, { desk: { label: 'Desk' } }) }, deleted: {} };
    const cloud = { projects: { a: P('A old', T1, { laptop: { label: 'Laptop' } }) }, deleted: {} };
    let m = M(eng, cloud);
    ok('the engine\'s newer copy wins', m.projects.a.name === 'A' && !m.engineBehind);
    ok('both engines\' bindings are kept', m.projects.a.bindings.desk && m.projects.a.bindings.laptop);
    m = M({ ...eng, projects: { a: P('A', T1) } }, { projects: { a: P('A new', T2) } });
    ok('the cloud\'s newer copy goes to the engine', m.engineBehind && m.toEngine.a.name === 'A new');
    m = M({ ...eng, projects: { a: P('Mine', T1) } }, { projects: { a: P('Theirs', T1) } });
    ok('a tie sends nothing to the engine', !m.engineBehind);
    // ...and keeps the cloud's copy, so the cloud is not rewritten either:
    // an engine that GUARDED a synced pref (A1 kept off) stores it with the
    // same time, and must not then push its version back up forever.
    ok('a tie keeps the cloud copy (no write either way)',m.projects.a.name === 'Theirs');
    m = M({ ...eng, projects: { a: P('A', T1, { desk: { label: 'Desk' } }) } },
          { projects: { a: P('A', T1, { desk: { label: 'Stale' } }) } });
    ok('this engine alone decides its own binding', m.projects.a.bindings.desk.label === 'Desk');
    m = M({ ...eng, projects: { a: P('A', T1) } }, { projects: {}, deleted: { a: T2 } });
    ok('a newer deletion removes it, and tells the engine', !m.projects.a && m.engineBehind && m.deleted.a === T2);
    m = M({ ...eng, projects: { a: P('A', T2) } }, { projects: {}, deleted: { a: T1 } });
    ok('an older deletion loses to a later change', !!m.projects.a);
    m = M({ ...eng, projects: {}, deleted: { a: T2 } }, { projects: { a: P('A', T1) } });
    ok('a deletion on the engine removes the cloud copy', !m.projects.a && !m.engineBehind);
    m = M({ ...eng, projects: {} }, { projects: { n: P('New', T1, { laptop: {} }) } });
    ok('a project only the cloud knows goes to the engine', m.toEngine.n && m.projects.n.bindings.laptop);
    const many = {}; for (let i = 0; i < 260; i++) many['p' + i] = new Date(1.7e12 + i * 1000).toISOString();
    ok('tombstones are bounded to 200', Object.keys(M({ ...eng, projects: {} }, { deleted: many }).deleted).length === 200);
    const W = world();
    ok('stable JSON ignores key order', W.__x.codeStable({ b: 1, a: [1, { d: 2, c: 3 }] }) === W.__x.codeStable({ a: [1, { c: 3, d: 2 }], b: 1 }));
  }

  console.log('\nWrite counts');
  {
    const W = world(); const x = W.__x;
    W.engine = { ok: true, rev: 5, engine: { id: 'desk', label: 'Desk' },
                 projects: { a: P('A', T1, { desk: { label: 'Desk' } }) }, deleted: {} };
    x.codeSyncFromCloud(undefined);             // the first snapshot: no `code` yet
    W.CODE.state = { engine: { id: 'desk' }, rev: 5 };
    await x.codeSyncReconcile();
    await settle(W);
    ok('an empty cloud is seeded with one write', W.writes.length === 1 && W.writes[0].data.code.projects.a, W.writes.length);
    ok('it replaces the one field (mergeFields: code)', W.writes[0].opts && W.writes[0].opts.mergeFields.join() === 'code');
    ok('no path, token or login in it', !/root|token|C:\\|Users/.test(JSON.stringify(W.writes[0].data)));

    // Our own write comes back through the listener: nothing happens.
    x.codeSyncFromCloud(JSON.parse(JSON.stringify(W.writes[0].data.code)));
    await settle(W);
    ok('our own echo costs nothing', W.writes.length === 1);

    // Nothing moved: /state carries the same rev.
    x.codeSyncCheck({ engine: { id: 'desk' }, rev: 5 });
    await settle(W);
    ok('an unchanged rev is not even a request', W.writes.length === 1 && W.puts.length === 0);

    // One preference.
    W.engine.projects.a = { ...W.engine.projects.a, prefs: { autoCommit: true }, updatedAt: T2 };
    W.engine.rev = 6;
    x.codeSyncCheck({ engine: { id: 'desk' }, rev: 6 });
    await settle(W);
    ok('one preference -> exactly one write', W.writes.length === 2, W.writes.length);
    ok('...carrying the new value', W.writes[1].data.code.projects.a.prefs.autoCommit === true);

    // Ten rapid toggles, each followed by the reconcile the sheet triggers.
    x.codeSyncFromCloud(JSON.parse(JSON.stringify(W.writes[1].data.code)));
    for (let i = 0; i < 10; i++) {
      W.engine.projects.a = { ...W.engine.projects.a, prefs: { autoCommit: i % 2 === 0 },
                              updatedAt: new Date(Date.parse(T2) + (i + 1) * 1000).toISOString() };
      W.engine.rev++;
      await x.codeSyncReconcile();
      W.advance(100);                            // 100 ms apart: inside the debounce
    }
    await settle(W);
    ok('ten rapid toggles -> one write', W.writes.length === 3, W.writes.length);
    ok('...of the last value', W.writes[2].data.code.projects.a.prefs.autoCommit === false);

    // The chain.
    W.CODE.order = ['codex', 'claude'];
    x.codeChainTouched();
    x.codeChainTouched();
    await settle(W);
    ok('a reorder -> one write with the chain', W.writes.length === 4 && W.writes[3].data.code.chain.order[0] === 'codex');
  }

  console.log('\nA task in flight');
  {
    const W = world(); const x = W.__x;
    W.engine = { ok: true, rev: 1, engine: { id: 'desk', label: 'Desk' }, projects: {}, deleted: {} };
    x.codeSyncFromCloud({ v: 1, rev: 3, projects: {}, deleted: {}, tasks: [] });
    W.CODE.state = { engine: { id: 'desk', label: 'Desk' }, projects: [{ id: 'a', name: 'A' }], rev: 1 };
    const t = { id: 'task1', prompt: 'do it', events: [], done: false, projectId: 'a' };
    W.CODE.task = t;
    // 400 events, and every trigger that could write, while it runs.
    for (let i = 0; i < 400; i++) t.events.push({ k: i % 3 ? 'tool' : 'text', text: 'x'.repeat(50) });
    W.engine.projects.a = P('A', T2);
    W.engine.rev = 2;
    x.codeSyncCheck({ engine: { id: 'desk' }, rev: 2 });
    x.codeChainTouched();
    await settle(W);
    ok('a 400-event task -> zero writes while it runs', W.writes.length === 0, W.writes.length);
    ok('...and not even a request to the engine', W.puts.length === 0);

    t.done = true;
    t.result = { outcome: 'ok', by_label: 'Claude', write: false };
    x.codeSyncTaskEnd(t);
    await settle(W);
    const body = W.writes.filter((w) => w.path === 'dashboards/magi/code/task1');
    const idx = W.writes.filter((w) => w.path === 'magi');
    ok('its end -> one body doc', body.length === 1);
    ok('...and one index write, carrying what was held too', idx.length === 1
       && idx[0].data.code.tasks[0].id === 'task1' && idx[0].data.code.projects.a
       && idx[0].data.code.chain, JSON.stringify(idx.map((w) => Object.keys(w.data.code))));
    ok('the transcript is a string (Firestore refuses nested arrays)', typeof body[0].data.events === 'string'
       && JSON.parse(body[0].data.events).length === 400);
    ok('the row is one line', idx[0].data.code.tasks[0].prompt === 'do it' && idx[0].data.code.tasks[0].device === 'Desk');

    x.codeSyncFromCloud(JSON.parse(JSON.stringify(idx[0].data.code)));
    x.codeSyncTaskEnd(t);                      // a reload replays the stream to "end"
    await settle(W);
    ok('a replayed end writes nothing again', W.writes.length === 2, W.writes.length);
  }

  console.log('\nThe listener');
  {
    const W = world(); const x = W.__x;
    x.codeSyncFromCloud({ rev: 1, projects: {} });
    const sig = x.CODE_SYNC.sig;
    x.codeSyncFromCloud({ projects: {}, rev: 1 });
    ok('an identical snapshot changes nothing', x.CODE_SYNC.sig === sig);
    W.CODE.order = ['x'];
    x.codeChainTouched();
    x.codeSyncFromCloud({ rev: 0, projects: {}, chain: { order: ['old'], updatedAt: '2000-01-01T00:00:00Z' } });
    ok('a snapshot is ignored while our change is on its way up', x.CODE_SYNC.cloud.rev === 1 && x.dirty);
    await settle(W);
    ok('...and the change still lands', W.writes.length === 1 && W.writes[0].data.code.chain.order[0] === 'x');
    x.codeSyncFromCloud({ rev: 9, projects: {}, chain: { order: ['phone'], picks: { on: ['phone'], known: ['phone'] },
                                                         updatedAt: '2099-01-01T00:00:00Z' } });
    ok('a newer chain from another device is adopted', W.CODE.order[0] === 'phone' && W.CODE.picks.on[0] === 'phone');
  }

  console.log('\nThe 64 KB guard');
  {
    const W = world(); const x = W.__x;
    x.codeSyncFromCloud({});
    const huge = {};
    for (let i = 0; i < 40; i++) huge['p' + i] = { ...P('P' + i, T1), notes: 'n'.repeat(2000) };
    x.CODE_SYNC.want = { projects: huge, deleted: {} };
    x.cloudSaveCode();
    await settle(W);
    ok('an oversized field is refused, not written', W.writes.length === 0);
    ok('...and the page is not left dirty (the listener still applies)', !x.dirty);
  }

  console.log('\nOne listener');
  ok('onSnapshot appears exactly once in the page', (MAGI.match(/\.onSnapshot\(/g) || []).length === 1);
  ok('the code branch rides it', /CLOUD\.unsub = CLOUD\.fs\.onSnapshot[\s\S]{0,1500}codeSyncFromCloud\(d && d\.code\)/.test(MAGI));
  ok('every write is counted', /CLOUD\.fs = cloudCountWrites\(fs\)/.test(MAGI));
  ok('codeLoad checks after /state', /codeSyncCheck\(st\);/.test(MAGI));
  ok('a task end hands over', (MAGI.match(/codeSyncTaskEnd\(t\);/g) || []).length === 2);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
