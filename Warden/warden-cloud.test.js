/* Node verification for the Cloud upload queue — folder uploads in particular.
 *
 *   node Warden/warden-cloud.test.js
 *
 * warden-cloud.js is a browser IIFE that hangs itself off `window`, so it runs
 * here inside a vm with the handful of globals it actually touches. Nothing is
 * mocked beyond that: the queue, the folder resolver and the readability guard
 * under test are the real ones.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ── harness ───────────────────────────────────────────────────────────────*/
let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + what); }
  else { fail++; console.log('  ✗ ' + what + '\n      expected ' + e + '\n      actual   ' + a); }
}
function ok(cond, what) { eq(!!cond, true, what); }

function loadCloud() {
  const store = Object.create(null);
  const win = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    location: { origin: 'https://test.local', href: 'https://test.local/' },
    navigator: { onLine: true, userAgent: 'node' },
    crypto: require('crypto').webcrypto,
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' })
  };
  win.window = win;
  win.document = {
    addEventListener() {}, removeEventListener() {}, hidden: false,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }),
    body: { appendChild() {}, removeChild() {} },
    querySelector: () => null, querySelectorAll: () => [],
    documentElement: { style: { setProperty() {} } }
  };
  const ctx = vm.createContext(Object.assign(win, {
    console, AbortController, Blob, URL, TextEncoder, TextDecoder,
    CustomEvent: class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } },
    XMLHttpRequest: class {}
  }));
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'warden-cloud.js'), 'utf8'), ctx, { filename: 'warden-cloud.js' });
  return ctx.WardenCloud;
}

/* A provider that records everything, with an in-memory tree. `seed` pre-creates
 * folders as {parentId: [{id,name,folder}]}. */
function fakeProvider(id, seed) {
  const tree = Object.assign(Object.create(null), seed || {});
  const calls = { mkdir: [], list: [], upload: [] };
  let n = 0;
  const p = {
    id, label: id, rootId: 'root', caps: {}, calls, tree,
    failMkdir: 0,           // fail this many mkdir calls before succeeding
    configured: () => true, connected: () => true, connect: async () => {}, disconnect() {},
    list: async parent => { calls.list.push(parent); return (tree[parent] || []).slice(); },
    search: async () => [], downloadUrl: async () => '', rename: async () => {},
    remove: async () => {}, move: async () => {}, shareLink: async () => '',
    quota: async () => ({ used: 0, total: 0 }),
    mkdir: async (name, parent) => {
      calls.mkdir.push({ name, parent });
      if (p.failMkdir > 0) { p.failMkdir--; throw new Error('mkdir boom'); }
      const entry = { id: parent + '/' + name + '#' + (++n), name, folder: true, parent, provider: id };
      (tree[parent] = tree[parent] || []).push(entry);
      tree[entry.id] = [];
      return entry;
    },
    upload: async (file, parent) => {
      calls.upload.push({ name: file.name, parent });
      return { id: parent + '/' + file.name, name: file.name, folder: false, size: file.size, parent, provider: id };
    }
  };
  return p;
}

// A stand-in File. `unreadable` reproduces a dropped DIRECTORY: size 0, no type,
// and a slice that throws the moment anything reads it.
function file(name, size, unreadable) {
  return {
    name, size: size === undefined ? 1 : size, type: unreadable ? '' : 'application/pdf',
    slice() {
      return { arrayBuffer: async () => { if (unreadable) throw new Error('NotFoundError'); return new ArrayBuffer(1); } };
    }
  };
}

function settle(VC) {
  // The queue is serial and promise-driven; a few macrotask turns is plenty for
  // any of these fixtures to finish.
  return new Promise(res => setTimeout(res, 30));
}
function q(VC) { return VC.queue(); }
function statusOf(VC, label) {
  const i = q(VC).filter(x => (x.label || x.name) === label)[0];
  return i ? i.status : 'missing';
}

/* ── tests ─────────────────────────────────────────────────────────────────*/

test('a loose file uploads straight into the open folder', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake');
  VC.register(p);
  VC.enqueue(file('deed.pdf'), 'fake', 'root');
  await settle(VC);
  eq(p.calls.upload, [{ name: 'deed.pdf', parent: 'root' }], 'uploaded to the parent unchanged');
  eq(p.calls.mkdir.length, 0, 'no folder was created');
  eq(statusOf(VC, 'deed.pdf'), 'done', 'item finished');
});

test('a dropped folder recreates its tree, one mkdir per level', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake');
  VC.register(p);
  // Trust/a.pdf, Trust/b.pdf, Trust/2024/c.pdf — three files, two folders.
  VC.enqueue(file('a.pdf'), 'fake', 'root', ['Trust']);
  VC.enqueue(file('b.pdf'), 'fake', 'root', ['Trust']);
  VC.enqueue(file('c.pdf'), 'fake', 'root', ['Trust', '2024']);
  await settle(VC);
  eq(p.calls.mkdir.map(c => c.name), ['Trust', '2024'], 'each level created exactly once');
  eq(p.calls.mkdir[0].parent, 'root', 'top folder went under the open folder');
  const trust = p.calls.mkdir[1].parent;
  ok(/Trust/.test(trust), 'the nested folder went inside the one above it');
  eq(p.calls.upload.map(c => c.name), ['a.pdf', 'b.pdf', 'c.pdf'], 'every file uploaded');
  eq(p.calls.upload[0].parent, p.calls.upload[1].parent, 'siblings share one folder');
  ok(p.calls.upload[2].parent !== p.calls.upload[0].parent, 'the nested file went deeper');
  eq(q(VC).filter(i => i.status === 'done').length, 3, 'all three finished');
});

test('an existing folder of the same name is reused, not duplicated', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake', { root: [{ id: 'root/Trust', name: 'Trust', folder: true }] });
  VC.register(p);
  VC.enqueue(file('a.pdf'), 'fake', 'root', ['Trust']);
  await settle(VC);
  eq(p.calls.mkdir.length, 0, 'nothing was created');
  eq(p.calls.upload, [{ name: 'a.pdf', parent: 'root/Trust' }], 'file merged into the existing folder');
});

test('folder matching ignores case', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake', { root: [{ id: 'root/Trust', name: 'Trust', folder: true }] });
  VC.register(p);
  VC.enqueue(file('a.pdf'), 'fake', 'root', ['TRUST']);
  await settle(VC);
  eq(p.calls.mkdir.length, 0, 'no duplicate folder for a case variant');
});

test('a same-named FILE is not mistaken for the folder', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake', { root: [{ id: 'root/Trust', name: 'Trust', folder: false }] });
  VC.register(p);
  VC.enqueue(file('a.pdf'), 'fake', 'root', ['Trust']);
  await settle(VC);
  eq(p.calls.mkdir.map(c => c.name), ['Trust'], 'the folder was still created');
});

test('a dropped DIRECTORY fails with a sentence, not "network error"', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake');
  VC.register(p);
  VC.enqueue(file('The Vee Win Trust', 0, true), 'fake', 'root');
  await settle(VC);
  eq(p.calls.upload.length, 0, 'nothing was sent to the provider');
  const item = q(VC)[0];
  eq(item.status, 'error', 'the item is marked failed');
  ok(/is a folder/.test(item.error), 'the error says it is a folder: ' + JSON.stringify(item.error));
  ok(!/network/i.test(item.error), 'and no longer blames the network');
});

test('a directory reporting a non-zero size is still called a folder', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake');
  VC.register(p);
  // Not every platform reports 0 bytes for a directory; the missing extension
  // is the second tell.
  VC.enqueue(file('The Vee Win Trust', 4096, true), 'fake', 'root');
  await settle(VC);
  ok(/is a folder/.test(q(VC)[0].error), 'named as a folder: ' + JSON.stringify(q(VC)[0].error));
});

test('a file that vanished after being picked says so', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake');
  VC.register(p);
  const f = file('moved.pdf', 500, true); f.type = 'application/pdf';
  VC.enqueue(f, 'fake', 'root');
  await settle(VC);
  const item = q(VC)[0];
  eq(item.status, 'error', 'the item is marked failed');
  ok(/moved or deleted/.test(item.error), 'the error points at the file: ' + JSON.stringify(item.error));
});

test('one bad file does not sink the rest of the folder', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake');
  VC.register(p);
  VC.enqueue(file('good1.pdf'), 'fake', 'root', ['Trust']);
  VC.enqueue(file('bad', 0, true), 'fake', 'root', ['Trust']);
  VC.enqueue(file('good2.pdf'), 'fake', 'root', ['Trust']);
  await settle(VC);
  eq(p.calls.upload.map(c => c.name), ['good1.pdf', 'good2.pdf'], 'the readable files still uploaded');
  eq(q(VC).filter(i => i.status === 'error').length, 1, 'exactly one failure');
});

test('a failed mkdir is not cached — the next file retries it', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake');
  p.failMkdir = 1;
  VC.register(p);
  VC.enqueue(file('a.pdf'), 'fake', 'root', ['Trust']);
  VC.enqueue(file('b.pdf'), 'fake', 'root', ['Trust']);
  await settle(VC);
  eq(p.calls.mkdir.length, 2, 'the second file tried again instead of inheriting the failure');
  eq(p.calls.upload.map(c => c.name), ['b.pdf'], 'and it landed');
  eq(statusOf(VC, 'Trust/a.pdf'), 'error', 'the first file reports the mkdir failure');
});

test('the dock label carries the folder path', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake');
  VC.register(p);
  VC.enqueue(file('c.pdf'), 'fake', 'root', ['Trust', '2024']);
  await settle(VC);
  eq(q(VC)[0].label, 'Trust/2024/c.pdf', 'label shows where the file came from');
  eq(q(VC)[0].name, 'c.pdf', 'name stays the bare filename');
});

test('folder ids are not reused across separate batches', async () => {
  const VC = loadCloud();
  const p = fakeProvider('fake');
  VC.register(p);
  VC.enqueue(file('a.pdf'), 'fake', 'root', ['Trust']);
  await settle(VC);
  const listsAfterFirst = p.calls.list.length;
  VC.enqueue(file('b.pdf'), 'fake', 'root', ['Trust']);
  await settle(VC);
  ok(p.calls.list.length > listsAfterFirst, 'the second batch re-resolved the folder');
  eq(p.calls.mkdir.length, 1, 'and reused the one it found rather than making another');
});

/* ── run ───────────────────────────────────────────────────────────────────*/
(async () => {
  console.log('\nWarden Cloud — upload queue\n');
  for (const [name, fn] of tests) {
    console.log(name);
    try { await fn(); } catch (e) { fail++; console.log('  ✗ threw: ' + (e && e.stack || e)); }
  }
  console.log('\n' + '─'.repeat(64));
  console.log(fail ? fail + ' FAILED, ' + pass + ' passed' : 'All ' + pass + ' cloud upload checks passed.');
  process.exit(fail ? 1 : 0);
})();
