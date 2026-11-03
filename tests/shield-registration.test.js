/* Shield must never blank a device's settings by "registering" it again.
 *
 * 2026-11-01: the agent opened shield.html hidden at logon, before the network
 * was up. Firestore's memory cache answered "document does not exist", the page
 * took that as real, wrote a fresh default record over Tony's PC (name "PC", no
 * Emergency targets) and pushed the empty config down to the agent.
 *
 * Three guards, each tested here against the REAL function text in shield.html:
 *   1. _shWatch ignores a cache-only "does not exist" and only a server answer
 *      lifts the write barrier;
 *   2. ensureRegistered writes field by field and never the name or targets;
 *   3. pushConfig sends nothing to the agent while this device has no record.
 *
 * Run: node tests/shield-registration.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// SHIELD_FILE points at another copy (e.g. an older version) to prove these fail there.
const SRC = fs.readFileSync(process.env.SHIELD_FILE || path.join(__dirname, '..', 'Shield/shield.html'), 'utf8');
let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

// Pull one top-level definition out of the page by its opening line, up to the
// first line that closes it at column 0.
function grab(startRe, endLine) {
  const m = startRe.exec(SRC);
  if (!m) throw new Error('not found in shield.html: ' + startRe);
  const end = SRC.indexOf('\n' + endLine, m.index);
  if (end < 0) throw new Error('no end for ' + startRe);
  return SRC.slice(m.index, end + 1 + endLine.length);
}

// ── 1. The listener ──────────────────────────────────────────────────────────
const watchSrc = grab(/window\._shWatch = \(profile, onData, onErr\) => \{/, '};');
function runWatch(snaps) {
  const window = { _shLoadOk: false };
  const delivered = [];
  let opts = null;
  const onSnapshot = (ref, a, b) => {
    const next = typeof a === 'function' ? a : b;
    if (typeof a !== 'function') opts = a;
    snaps.forEach((s) => next(s));
    return () => {};
  };
  const shRef = (p) => ({ path: 'dashboards/shield_' + p });
  // eslint-disable-next-line no-new-func
  new Function('window', 'onSnapshot', 'shRef', watchSrc)(window, onSnapshot, shRef);
  window._shWatch('tony', (d) => delivered.push({ d, barrier: window._shLoadOk }));
  return { window, delivered, opts };
}
const snap = (exists, fromCache, data) => ({
  exists: () => exists, data: () => data, metadata: { fromCache, hasPendingWrites: false },
});

ok('a cache-only "does not exist" is not delivered and keeps the barrier shut', () => {
  const r = runWatch([snap(false, true)]);
  assert.strictEqual(r.delivered.length, 0);
  assert.strictEqual(r.window._shLoadOk, false);
});
ok('the server answer after it is delivered and lifts the barrier', () => {
  const doc = { devices: { dev_a: { name: "Tony's Zenbook" } } };
  const r = runWatch([snap(false, true), snap(true, false, doc)]);
  assert.strictEqual(r.delivered.length, 1);
  assert.strictEqual(r.delivered[0].d, doc);
  assert.strictEqual(r.delivered[0].barrier, true);
});
ok('a server "does not exist" is still a real answer (a brand-new profile)', () => {
  const r = runWatch([snap(false, true), snap(false, false)]);
  assert.strictEqual(r.delivered.length, 1);
  assert.strictEqual(r.delivered[0].d, null);
  assert.strictEqual(r.window._shLoadOk, true);
});
ok('listens with includeMetadataChanges, so that server confirmation arrives', () => {
  assert.ok(runWatch([]).opts && runWatch([]).opts.includeMetadataChanges === true);
});

// ── 2. Registration ──────────────────────────────────────────────────────────
const regSrc = grab(/^function ensureRegistered\(\)\{/m, '}');
function runRegister(dev) {
  const writes = [];
  const S = { devId: 'dev_a', profile: 'tony' };
  const env = {
    S,
    myDev: () => dev,
    caps: () => ({ agent: true }),
    claimedBy: () => 'tony',
    setClaim: () => {},
    sameCaps: () => true,
    platform: () => 'windows',
    deviceType: () => 'desktop',
    now: () => 1,
    write: (f) => { writes.push(f); return Promise.resolve(); },
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(...Object.keys(env), regSrc + '\nreturn ensureRegistered;')(...Object.values(env));
  fn();
  return writes;
}
ok('registering writes individual fields, never the whole device map', () => {
  const w = runRegister(null);
  assert.strictEqual(w.length, 1);
  const keys = Object.keys(w[0]);
  assert.ok(!keys.includes('devices.dev_a'), 'whole-map write: ' + keys);
  keys.forEach((k) => assert.ok(k.startsWith('devices.dev_a.'), k));
});
ok('registering never writes the name, Program Closer or Emergency config', () => {
  const keys = Object.keys(runRegister(null)[0]);
  ['name', 'closer', 'emergency'].forEach((f) =>
    assert.ok(!keys.some((k) => k === 'devices.dev_a.' + f || k.startsWith('devices.dev_a.' + f + '.')), f));
});

// ── 3. The agent push ────────────────────────────────────────────────────────
const pushSrc = grab(/^function pushConfig\(\)\{/m, '}');
function runPush(dev) {
  const calls = [];
  const env = {
    S: { devId: 'dev_a', profile: 'tony' },
    caps: () => ({ agent: true }),
    myDev: () => dev,
    devRec: () => dev,
    cfgEmg: () => ({ targets: [] }),
    cfgCloser: () => ({ targets: [] }),
    reopenAfterTrigger: () => false,
    guardKey: () => '',
    defaultName: () => 'PC',
    Agent: { invoke: (c, a) => { calls.push([c, a]); return Promise.resolve(); } },
  };
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(env), pushSrc + '\nreturn pushConfig;')(...Object.values(env))();
  return calls;
}
ok('no record yet: nothing is pushed to the agent', () => {
  assert.strictEqual(runPush(null).length, 0);
});
ok('with a record: the config is pushed', () => {
  const c = runPush({ name: "Tony's Zenbook" });
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0][0], 'sh_set_config');
});

console.log('All ' + pass + ' shield-registration checks passed.');
