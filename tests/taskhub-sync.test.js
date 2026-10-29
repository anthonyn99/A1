#!/usr/bin/env node
/**
 * Two devices, the REAL index.html, one fake Firestore.
 *
 * Two separate headless Edge browsers (two devices: own storage, own memory)
 * load index.html from https://a1.test. Every Firebase module is replaced by a
 * stub whose Firestore lives HERE, in this process, behind https://fs.test:
 * reads, writes, transactions (optimistic, version-checked) and listeners
 * (polled). Workers and other network writes are refused. Nothing real is
 * read or written.
 *
 * Replays:
 *   1. The 2026-10-19 reset. Device A loads, then sleeps. Device B adds tasks.
 *      A wakes and makes an edit before its listener has caught up. Before the
 *      versioned save, A's whole stale TaskHub replaced the cloud copy.
 *   2. Both devices edit Veda's TaskHub at the same moment: both edits survive.
 *   3. A save from an old app version (no rev) lands with stale content: a
 *      device that has the real state saves it back over it.
 *
 * Run: node tests/taskhub-sync.test.js
 *      TH_INDEX=<path to another index.html> node tests/taskhub-sync.test.js
 *      (the second form runs an older build, to show the reset it had)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INDEX = process.env.TH_INDEX ? path.resolve(process.env.TH_INDEX) : path.join(ROOT, 'index.html');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The fake Firestore ──────────────────────────────────────────────────────
const store = new Map();   // path → { ver, data }
let clock = 0;
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function deepMerge(a, b) {
  const out = Object.assign({}, a);
  for (const [k, v] of Object.entries(b)) {
    if (isObj(v) && v.__del === 1) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}
const fsWrites = [];   // [path, data] in order
function fsHandle(url, body) {
  const u = new URL(url);
  if (u.pathname === '/get') {
    const p = u.searchParams.get('p'), e = store.get(p);
    return { status: 200, json: e ? { exists: true, data: e.data, ver: e.ver } : { exists: false, ver: 0 } };
  }
  if (u.pathname === '/commit') {
    const { reads, writes } = JSON.parse(body || '{}');
    for (const r of reads || []) { const e = store.get(r.p); if ((e ? e.ver : 0) !== r.ver) return { status: 409, json: { conflict: r.p } }; }
    for (const w of writes || []) {
      const e = store.get(w.p);
      if (w.del) { store.delete(w.p); continue; }
      const data = w.merge && e ? deepMerge(e.data, w.data) : deepMerge({}, w.data);
      store.set(w.p, { ver: ++clock, data });
      fsWrites.push([w.p, data]);
    }
    return { status: 200, json: { ok: true } };
  }
  return { status: 404, json: {} };
}
const put = (p, data) => store.set(p, { ver: ++clock, data: JSON.parse(JSON.stringify(data)) });
const get = (p) => (store.get(p) || {}).data;

// ── Firebase stubs ──────────────────────────────────────────────────────────
const FS_STUB = `
const API = 'https://fs.test/';
async function call(p, body) {
  if (window.__fsOffline) { const e = new Error('offline'); e.code = 'unavailable'; throw e; }
  const r = await fetch(API + p, body ? { method: 'POST', body: JSON.stringify(body) } : {});
  if (r.status === 409) { const e = new Error('aborted'); e.code = 'aborted'; throw e; }
  return r.json();
}
const clone = (x) => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const clean = (x) => JSON.parse(JSON.stringify(x, (k, v) => v && v.__del === 1 ? v : v));
function snapOf(ref, r) {
  return { id: ref.id, ref, metadata: { fromCache: false, hasPendingWrites: false },
           exists: () => !!r.exists, data: () => r.exists ? clone(r.data) : undefined };
}
export const initializeFirestore = (app) => ({ type: 'firestore', app });
export const getFirestore = initializeFirestore;
export const persistentLocalCache = () => ({});
export const persistentMultipleTabManager = () => ({});
export const persistentSingleTabManager = () => ({});
export const terminate = async () => {};
export const clearIndexedDbPersistence = async () => {};
export function doc(base, ...parts) {
  const pre = base && base.type === 'collection' ? [base.path] : [];
  const db = base && base.type === 'firestore' ? base : (base && base.firestore) || base;
  const p = pre.concat(parts).join('/');
  return { type: 'document', firestore: db, path: p, id: p.split('/').pop() };
}
export function collection(db, ...parts) { return { type: 'collection', firestore: db, path: parts.join('/') }; }
const pass = () => ({});
export const query = (c) => c, where = pass, orderBy = pass, limit = pass, startAt = pass, startAfter = pass, endBefore = pass, endAt = pass, documentId = pass;
export async function getDocs() { return { docs: [], empty: true, size: 0, forEach() {} }; }
export async function getDoc(ref) { return snapOf(ref, await call('get?p=' + encodeURIComponent(ref.path))); }
export const getDocFromServer = getDoc;
export async function getDocFromCache() { const e = new Error('no cache'); e.code = 'unavailable'; throw e; }
export const deleteField = () => ({ __del: 1 });
export async function setDoc(ref, data, opts) { await call('commit', { reads: [], writes: [{ p: ref.path, data: clean(data), merge: !!(opts && opts.merge) }] }); }
export async function updateDoc(ref, data) { await call('commit', { reads: [], writes: [{ p: ref.path, data: clean(data), merge: true }] }); }
export async function deleteDoc(ref) { await call('commit', { reads: [], writes: [{ p: ref.path, del: true }] }); }
export async function runTransaction(db, fn) {
  for (let i = 0; i < 5; i++) {
    const reads = [], writes = [];
    const tx = {
      get: async (ref) => { const r = await call('get?p=' + encodeURIComponent(ref.path)); reads.push({ p: ref.path, ver: r.ver }); return snapOf(ref, r); },
      set: (ref, data, opts) => { writes.push({ p: ref.path, data: clean(data), merge: !!(opts && opts.merge) }); return tx; },
      update: (ref, data) => { writes.push({ p: ref.path, data: clean(data), merge: true }); return tx; },
      delete: (ref) => { writes.push({ p: ref.path, del: true }); return tx; }
    };
    const out = await fn(tx);
    try { await call('commit', { reads, writes }); window.__txCount = (window.__txCount || 0) + 1; return out; }
    catch (e) { if (e.code !== 'aborted') throw e; }
  }
  const e = new Error('transaction failed'); e.code = 'aborted'; throw e;
}
export function onSnapshot(ref, a, b, c) {
  let cb, err;
  if (typeof a === 'function') { cb = a; err = b; } else { cb = b; err = c; }
  if (!ref || ref.type !== 'document') return () => {};
  let last = -1, stop = false;
  const tick = async () => {
    if (stop) return;
    if (!window.__fsOffline && !window.__fsHold) {
      try { const r = await call('get?p=' + encodeURIComponent(ref.path)); if (r.ver !== last) { last = r.ver; cb(snapOf(ref, r)); } } catch (e) {}
    }
    if (!stop) setTimeout(tick, 120);
  };
  tick();
  return () => { stop = true; };
}`;
const STUBS = {
  'firebase-app.js': 'export const initializeApp = (c, n) => ({ name: n || "[DEFAULT]" }); export const getApps = () => [];',
  'firebase-auth.js': 'const u = { uid: "test-user", isAnonymous: true }; export const getAuth = () => ({ currentUser: u }); export const signInAnonymously = async () => ({ user: u }); export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb(u), 0); return () => {}; };',
  'firebase-app-check.js': 'export const initializeAppCheck = () => ({}); export class ReCaptchaV3Provider {} export const getToken = async () => ({ token: "t" });',
  'firebase-firestore.js': FS_STUB,
  'firebase-messaging.js': 'export const getMessaging = () => ({}); export const getToken = async () => { throw new Error("no push in tests"); }; export const onMessage = () => () => {}; export const deleteToken = async () => true;',
  'firebase-storage.js': 'export const getStorage = () => ({}); export const ref = () => ({}); export const uploadBytes = async () => ({}); export const getDownloadURL = async () => ""; export const deleteObject = async () => {};'
};

// ── A device: its own Edge, its own profile ─────────────────────────────────
// A1_CHROME names another Chromium-family browser (a Linux or cloud machine,
// where there is no Edge); it is launched the same way.
function findEdge() {
  return [process.env.A1_CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => p && fs.existsSync(p));
}
async function device(name) {
  const port = 9400 + Math.floor(Math.random() * 500);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-sync-' + name + '-'));
  const proc = spawn(findEdge(), ['--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
    '--remote-debugging-port=' + port, '--user-data-dir=' + udd, '--window-size=1280,900']
    .concat(process.platform === 'linux' ? ['--no-sandbox'] : [], ['about:blank']), { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 60 && !list; i++) { try { list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); } catch (e) { await sleep(200); } }
  const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pend = new Map();
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
    if (d.method === 'Runtime.consoleAPICalled') {
      const t = d.params.args.map((a) => a.value !== undefined ? a.value : a.description || '').join(' ');
      if (/TaskHub|Veda|Firebase|merged|old app version/.test(t)) logs.push(t);
      return;
    }
    if (d.method === 'Runtime.exceptionThrown') { logs.push('EXC ' + (d.params.exceptionDetails.exception || {}).description); return; }
    if (d.method !== 'Fetch.requestPaused') return;
    const req = d.params.request, rid = d.params.requestId, url = req.url;
    const cors = [{ name: 'Access-Control-Allow-Origin', value: '*' }];
    const reply = (status, body, type) => send('Fetch.fulfillRequest', { requestId: rid, responseCode: status,
      responseHeaders: [{ name: 'Content-Type', value: type || 'text/plain' }].concat(cors), body: Buffer.from(body || '').toString('base64') });
    if (url.startsWith('https://fs.test/')) { const r = fsHandle(url, req.postData); return reply(r.status, JSON.stringify(r.json), 'application/json'); }
    const stub = Object.keys(STUBS).find((k) => url.includes('gstatic.com/firebasejs') && url.split('?')[0].endsWith('/' + k));
    if (stub) return reply(200, STUBS[stub], 'text/javascript');
    if (url.includes('gstatic.com/firebasejs')) return reply(200, 'export {};', 'text/javascript');
    if (url.startsWith('https://a1.test/')) {
      const p = decodeURIComponent(new URL(url).pathname.slice(1)) || 'index.html';
      const file = p === 'index.html' ? INDEX : path.join(ROOT, p);
      if (!fs.existsSync(file)) return reply(404, '');
      const ext = path.extname(file);
      const type = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'text/html';
      const buf = fs.readFileSync(file);
      return send('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }], body: buf.toString('base64') });
    }
    // A1_CDN_DIR: a local mirror of cdnjs (<dir>/react/18.2.0/umd/...), for a
    // machine that cannot reach it. A file it lacks still goes to the network.
    const lib = /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/(.+)$/.exec(url.split('?')[0]);
    if (lib && process.env.A1_CDN_DIR && fs.existsSync(path.join(process.env.A1_CDN_DIR, lib[1]))) {
      return send('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }].concat(cors),
        body: fs.readFileSync(path.join(process.env.A1_CDN_DIR, lib[1])).toString('base64') });
    }
    // Only the page's CDN libraries and fonts may load. Everything else (workers,
    // Google APIs, reCAPTCHA) is refused, so nothing real can be written.
    if (/cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|unpkg\.com/.test(url)) return send('Fetch.continueRequest', { requestId: rid });
    return reply(503, '');
  };
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Runtime.enable');
  await send('Page.enable');
  const evalJs = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(name + ': ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result.result.value;
  };
  const until = async (e, n = 100, ms = 150) => { for (let i = 0; i < n; i++) { try { if (await evalJs(e)) return true; } catch (x) {} await sleep(ms); } return false; };
  return { name, send, evalJs, until, logs,
    close: async () => { try { ws.close(); } catch (e) {} proc.kill(); await sleep(400); try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {} } };
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const dk = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const now = new Date(), today = dk(now), yest = dk(new Date(now.getTime() - 86400000));
const monday = (() => { const d = new Date(now); const w = (d.getDay() + 6) % 7; d.setDate(d.getDate() - w); return dk(d); })();
const task = (id, title, extra) => Object.assign({ id, title, type: 'task', category: 'personal', done: false, repeat: 'none' }, extra || {});
const seedTony = { savedAt: Date.now() - 3600e3, weekKey: monday,
  goals: [{ id: 'g1', title: 'Goal one', done: false }], monthlyGoals: [], habits: [], hc: {}, goalPrefs: {},
  data: { [yest]: [task('t1', 'Old task')], [today]: [task('t2', 'Morning task')] } };
const seedVeda = { savedAt: Date.now() - 3600e3, weekKey: monday, goals: [], monthlyGoals: [], habits: [], hc: {}, rules: [],
  data: { [today]: [task('v1', 'Cook dinner')] } };

const has = (list, want) => want.every((w) => String(list).split(',').includes(w));
const dupTitles = (doc, day) => { const t = ((doc && doc.data && doc.data[day]) || []).map((x) => x.title); return t.length !== new Set(t).size; };
const ids = (doc, day) => ((doc && doc.data && doc.data[day]) || []).map((x) => x.id).sort().join(',');
const stateIds = (dev, who, day) => dev.evalJs(`(() => { const s = window.${who}.getState(); return ((s.data || {})[${JSON.stringify(day)}] || []).map(x => x.id).sort().join(','); })()`);
const addTask = (dev, who, day, t) => dev.evalJs(`(() => { window.${who}.mutateData(p => Object.assign({}, p, { [${JSON.stringify(day)}]: ((p || {})[${JSON.stringify(day)}] || []).concat([${JSON.stringify(t)}]) })); return 1; })()`);
const tick = (dev, who, day, id) => dev.evalJs(`(() => { window.${who}.mutateData(p => Object.assign({}, p, { [${JSON.stringify(day)}]: (p[${JSON.stringify(day)}] || []).map(x => x.id === ${JSON.stringify(id)} ? Object.assign({}, x, { done: true }) : x) })); return 1; })()`);

async function open(dev, profile) {
  await dev.send('Page.navigate', { url: 'https://a1.test/index.html' });
  const fn = profile === 'veda' ? '_profileGoVeda' : '_profileGoTony', who = profile === 'veda' ? '_vdVoice' : '_thVoice';
  const up = await dev.until(`!!window.${fn}`, 200);
  if (up) await dev.evalJs(`window.${fn}(); 1`);
  return up && await dev.until(`!!(window.${who} && window.${who}.getState && Object.keys(window.${who}.getState().data || {}).length)`, 200);
}

(async () => {
  if (!findEdge()) { console.log('  skip  Edge not found'); return; }
  console.log('index: ' + path.relative(ROOT, INDEX) + '\n');
  put('dashboards/main', seedTony);
  put('dashboards/vedasdash', seedVeda);
  const A = await device('A'), B = await device('B');
  try {
    console.log('1. The 2026-10-19 reset (Tony)');
    ok(await open(A, 'tony'), 'device A opens Tony\u2019s TaskHub');
    ok(await A.until(`(window._thVoice.getState().data[${JSON.stringify(today)}] || []).some(x => x.id === 't2')`, 60), 'A shows the cloud copy');
    await A.evalJs('window.__fsOffline = true; 1');                       // A goes to sleep
    ok(await open(B, 'tony'), 'device B opens Tony\u2019s TaskHub');
    await addTask(B, '_thVoice', yest, task('n1', 'Orca visual'));
    await sleep(600);
    await addTask(B, '_thVoice', today, task('n2', 'Record game'));
    ok(await B.until(`1`) && await (async () => { for (let i = 0; i < 60; i++) { if (has(ids(get('dashboards/main'), today), ['n2', 't2'])) return true; await sleep(150); } return false; })(),
       'B\u2019s new tasks reach the cloud');
    // A wakes and taps before its listener has caught up.
    await A.evalJs('window.__fsHold = true; window.__fsOffline = false; 1');
    await tick(A, '_thVoice', today, 't2');
    await sleep(2500);
    await A.evalJs('window.__fsHold = false; 1');
    await sleep(2500);
    const m = get('dashboards/main');
    console.log('        today on server: ' + JSON.stringify((m.data[today] || []).map((x) => [x.id, x.title, x._planId || x.repeatId || ''])));
    ok(ids(m, yest) === 'n1,t1', 'yesterday\u2019s added task survives A\u2019s save: ' + ids(m, yest));
    ok(has(ids(m, today), ['n2', 't2']), 'today\u2019s added task survives: ' + ids(m, today));
    ok(!dupTitles(m, today) && !dupTitles(m, yest), 'nothing is duplicated by the merge');
    ok(((m.data[today] || []).find((x) => x.id === 't2') || {}).done === true, 'A\u2019s own tick is saved too');
    ok(await A.until(`(() => { const s = window._thVoice.getState().data[${JSON.stringify(yest)}] || []; return s.some(x => x.id === 'n1'); })()`, 40),
       'A now shows B\u2019s tasks');
    ok(await B.until(`(() => { const s = window._thVoice.getState().data[${JSON.stringify(today)}] || []; return (s.find(x => x.id === 't2') || {}).done === true; })()`, 40),
       'B shows A\u2019s tick');
    ok(typeof m.rev === 'number' && (get('dashboards/main_head') || {}).rev === m.rev, 'the doc carries a version that matches its head');

    console.log('\n2. Both devices edit Veda\u2019s TaskHub at once');
    ok(await open(A, 'veda') && await open(B, 'veda'), 'both open Veda\u2019s TaskHub');
    // Several rounds, both devices editing in the same instant (round 0 waits
    // for nothing; later rounds land while the previous saves are settling).
    const want = ['v1'];
    for (let r = 0; r < 5; r++) {
      await Promise.all([addTask(A, '_vdVoice', today, task('va' + r, 'From A ' + r)), addTask(B, '_vdVoice', today, task('vb' + r, 'From B ' + r))]);
      want.push('va' + r, 'vb' + r);
      await sleep(r * 120);
    }
    let v = '';
    for (let i = 0; i < 100 && !has(v, want); i++) { await sleep(150); v = ids(get('dashboards/vedasdash'), today); }
    ok(has(v, want), 'every edit from both devices is in the cloud: ' + v);
    ok(await A.until(`(window._vdVoice.getState().data[${JSON.stringify(today)}] || []).length === 11`, 80) &&
       await B.until(`(window._vdVoice.getState().data[${JSON.stringify(today)}] || []).length === 11`, 80), 'and on both devices');

    console.log('\n3. A save from an old app version');
    const before = get('dashboards/vedasdash');
    const stale = JSON.parse(JSON.stringify(seedVeda)); stale.savedAt = Date.now();   // old app: no rev, old content
    put('dashboards/vedasdash', stale);
    let back = '';
    for (let i = 0; i < 60 && !has(back, want); i++) { await sleep(150); back = ids(get('dashboards/vedasdash'), today); }
    ok(has(back, want), 'an up-to-date device saves the real state back over it: ' + back);
    ok(typeof get('dashboards/vedasdash').rev === 'number' && get('dashboards/vedasdash').rev > before.rev, 'with a new version');
  } catch (e) {
    fails++; console.log('  FAIL  ' + (e && e.message || e));
  } finally {
    if (fails) console.log('\n--- writes ---\n' + fsWrites.filter(([p]) => /^dashboards\/(main|vedasdash)$/.test(p))
      .map(([p, d]) => p + ' rev=' + d.rev + ' today=' + ids(d, today) + ' yest=' + ids(d, yest)).join('\n'));
    if (fails) { console.log('\n--- device A log ---\n' + A.logs.slice(-25).join('\n') + '\n--- device B log ---\n' + B.logs.slice(-25).join('\n')); }
    await A.close(); await B.close();
  }
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
