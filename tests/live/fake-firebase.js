// A fake Firebase for live tests: ONE ES module served for every
// https://www.gstatic.com/firebasejs/<ver>/firebase-*.js URL, so a page imports
// it exactly the way it imports the real SDK. Firestore is in-memory with the
// real semantics the A1 pages rely on:
//
//   - setDoc (replace or {merge:true} deep-merge), updateDoc (dotted field
//     paths; 'not-found' when the doc is missing), deleteDoc, deleteField,
//     arrayUnion/arrayRemove/increment, runTransaction, writeBatch
//   - onSnapshot on a doc or a collection: an initial snapshot, a local write
//     fires with hasPendingWrites:true, then (includeMetadataChanges only) a
//     metadata-only snapshot with hasPendingWrites:false, as the real SDK does
//   - every read reports fromCache:false, so a page's "server seen" write
//     guards open the way they do online
//
// In the page, window.__fakeFs is the control surface:
//   __fakeFs.docs                 { path: data }   (live store)
//   __fakeFs.log                  [{op, path, data, t}]  every write, in order
//   __fakeFs.remote(path, data, {merge})   another device writes: listeners
//                                 fire with hasPendingWrites:false
//   __fakeFs.reset()
// The store survives a reload through sessionStorage (__fakefs_docs), so a test
// can seed it before navigating and check it after a reload. Nothing here can
// reach the network.
//
// Use: const { firebaseMock } = require('./fake-firebase.js');
//      const c = await connect({ mock: firebaseMock() });
'use strict';

const MODULE = String.raw`
const W = window;
const DEL = { __fake: 'deleteField' };
const isSentinel = (v) => v && typeof v === 'object' && v.__fake;
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

const fs = W.__fakeFs || (W.__fakeFs = (() => {
  let docs = {};
  try { docs = JSON.parse(sessionStorage.getItem('__fakefs_docs') || '{}') || {}; } catch (e) {}
  const listeners = [];
  const api = { docs, log: [], listeners, appInit: false, fsInit: false };
  api.persist = () => { try { sessionStorage.setItem('__fakefs_docs', JSON.stringify(api.docs)); } catch (e) {} };
  api.reset = () => { Object.keys(api.docs).forEach((k) => delete api.docs[k]); api.log.length = 0; api.persist(); };
  return api;
})());

function applySentinel(cur, v) {
  if (v.__fake === 'arrayUnion') { const a = Array.isArray(cur) ? cur.slice() : []; v.items.forEach((x) => { if (!a.some((y) => JSON.stringify(y) === JSON.stringify(x))) a.push(x); }); return a; }
  if (v.__fake === 'arrayRemove') { const a = Array.isArray(cur) ? cur : []; return a.filter((y) => !v.items.some((x) => JSON.stringify(x) === JSON.stringify(y))); }
  if (v.__fake === 'increment') return (typeof cur === 'number' ? cur : 0) + v.n;
  if (v.__fake === 'serverTimestamp') return Date.now();
  return cur;
}
// Resolve sentinels in a value written whole (setDoc without merge).
function resolve(v) {
  if (Array.isArray(v)) return v.map(resolve);
  if (isSentinel(v)) return v.__fake === 'deleteField' ? undefined : applySentinel(undefined, v);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) { const r = resolve(v[k]); if (r !== undefined) o[k] = r; } return o; }
  return v;
}
function mergeInto(target, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (isSentinel(v)) { if (v.__fake === 'deleteField') delete target[k]; else target[k] = applySentinel(target[k], v); }
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
      mergeInto(target[k], v);
    } else target[k] = clone(v);
  }
}
function setPath(target, dotted, v) {
  const parts = dotted.split('.');
  let o = target;
  for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
  const last = parts[parts.length - 1];
  if (isSentinel(v)) { if (v.__fake === 'deleteField') delete o[last]; else o[last] = applySentinel(o[last], v); }
  else o[last] = resolve(clone(v));
}
// The log keeps sentinels readable.
function logVal(v) { return JSON.parse(JSON.stringify(v, (k, x) => (isSentinel(x) ? '<<' + x.__fake + '>>' : x))); }

const joinPath = (parts) => parts.filter((p) => p != null && p !== '').join('/').replace(/\/+/g, '/');
function docSnap(path, meta) {
  const has = Object.prototype.hasOwnProperty.call(fs.docs, path);
  const data = has ? clone(fs.docs[path]) : undefined;
  return { id: path.split('/').pop(), ref: { path, id: path.split('/').pop(), type: 'document' },
    exists: () => has, data: () => data, get: (f) => (data ? data[f] : undefined),
    metadata: { fromCache: false, hasPendingWrites: !!(meta && meta.pending) } };
}
function colSnap(path, meta) {
  const depth = path.split('/').length + 1;
  const ds = Object.keys(fs.docs).filter((p) => p.startsWith(path + '/') && p.split('/').length === depth).sort().map((p) => docSnap(p, meta));
  return { docs: ds, size: ds.length, empty: !ds.length, forEach: (f) => ds.forEach(f), docChanges: () => ds.map((d) => ({ type: 'added', doc: d })),
    metadata: { fromCache: false, hasPendingWrites: !!(meta && meta.pending) } };
}
function notify(path, pending) {
  for (const l of fs.listeners.slice()) {
    if (l.dead) continue;
    const hit = l.kind === 'doc' ? l.path === path : (path.startsWith(l.path + '/') && path.split('/').length === l.path.split('/').length + 1);
    if (!hit) continue;
    const fire = (p) => { if (!l.dead) try { l.next(l.kind === 'doc' ? docSnap(l.path, { pending: p }) : colSnap(l.path, { pending: p })); } catch (e) { console.error(e); } };
    if (pending) {
      Promise.resolve().then(() => fire(true));
      if (l.meta) setTimeout(() => fire(false), 40);
    } else setTimeout(() => fire(false), 0);
  }
}
function write(op, path, data, fn, remote) {
  fn();
  fs.log.push({ op, path, data: data === undefined ? undefined : logVal(data), t: Date.now(), remote: !!remote });
  fs.persist();
  notify(path, !remote);
}
fs.remote = (path, data, opts) => {
  write(opts && opts.merge ? 'remoteMerge' : 'remoteSet', path, data, () => {
    if (opts && opts.merge && fs.docs[path]) mergeInto(fs.docs[path], data);
    else { fs.docs[path] = {}; mergeInto(fs.docs[path], data); }
  }, true);
};
fs.remoteDelete = (path) => write('remoteDelete', path, undefined, () => { delete fs.docs[path]; }, true);

// ── firebase-app ──
const APP = { name: '[DEFAULT]', options: {} };
export const initializeApp = (o, name) => { fs.appInit = true; APP.options = o || {}; return APP; };
export const getApps = () => (fs.appInit ? [APP] : []);
export const getApp = () => APP;
export const deleteApp = () => Promise.resolve();
export const setLogLevel = () => {};
export const _getProvider = (app, name) => ({ isInitialized: () => (name === 'firestore' ? fs.fsInit : true) });

// ── firebase-auth ──
const USER = { uid: 'fake-uid', isAnonymous: true };
const AUTH = { currentUser: USER, authStateReady: () => Promise.resolve() };
export const getAuth = () => AUTH;
export const signInAnonymously = () => Promise.resolve({ user: USER });
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb(USER), 0); return () => {}; };

// ── firebase-app-check ──
export class ReCaptchaV3Provider { constructor(k) { this.k = k; } }
export class ReCaptchaEnterpriseProvider { constructor(k) { this.k = k; } }
export const initializeAppCheck = () => ({});
export const getToken = (x) => Promise.resolve({ token: 'fake-appcheck' });   // app-check AND messaging share the name
export const onTokenChanged = () => () => {};

// ── firebase-messaging ──
export const getMessaging = () => ({});
export const onMessage = () => () => {};
export const deleteToken = () => Promise.resolve(true);
export const isSupported = () => Promise.resolve(false);

// ── firebase-storage ──
export const getStorage = () => ({});
export const ref = (s, p) => ({ fullPath: p });
export const uploadBytes = (r) => Promise.resolve({ ref: r });
export const uploadString = (r) => Promise.resolve({ ref: r });
export const getDownloadURL = (r) => Promise.resolve('data:text/plain,' + encodeURIComponent(r.fullPath || ''));
export const deleteObject = () => Promise.resolve();

// ── firebase-firestore ──
const DB = { type: 'firestore' };
export const initializeFirestore = () => { fs.fsInit = true; return DB; };
export const getFirestore = () => { fs.fsInit = true; return DB; };
export const memoryLocalCache = () => ({});
export const persistentLocalCache = () => ({});
export const persistentMultipleTabManager = () => ({});
export const persistentSingleTabManager = () => ({});
export const terminate = () => Promise.resolve();
export const clearIndexedDbPersistence = () => Promise.resolve();
export const enableNetwork = () => Promise.resolve();
export const disableNetwork = () => Promise.resolve();
export const waitForPendingWrites = () => Promise.resolve();
export const doc = (db, ...p) => { const path = joinPath(p); return { path, id: path.split('/').pop(), type: 'document' }; };
export const collection = (db, ...p) => { const path = joinPath(p); return { path, id: path.split('/').pop(), type: 'collection' }; };
export const query = (c) => c;
export const where = () => ({}); export const orderBy = () => ({}); export const limit = () => ({});
export const startAt = () => ({}); export const startAfter = () => ({}); export const endAt = () => ({}); export const endBefore = () => ({});
export const documentId = () => '__name__';
export const deleteField = () => DEL;
export const arrayUnion = (...items) => ({ __fake: 'arrayUnion', items });
export const arrayRemove = (...items) => ({ __fake: 'arrayRemove', items });
export const increment = (n) => ({ __fake: 'increment', n });
export const serverTimestamp = () => ({ __fake: 'serverTimestamp' });
export class Timestamp { constructor(s, n) { this.seconds = s; this.nanoseconds = n; } toMillis() { return this.seconds * 1000; } static now() { return Timestamp.fromMillis(Date.now()); } static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), 0); } }

const notFound = () => Object.assign(new Error('No document to update'), { code: 'not-found' });
function doSet(ref, data, opts) {
  write(opts && opts.merge ? 'setMerge' : 'set', ref.path, data, () => {
    if (opts && opts.merge) { if (!fs.docs[ref.path]) fs.docs[ref.path] = {}; mergeInto(fs.docs[ref.path], data); }
    else fs.docs[ref.path] = resolve(clone(data)) || {};
  });
}
function doUpdate(ref, data) {
  if (!fs.docs[ref.path]) throw notFound();
  write('update', ref.path, data, () => { for (const k of Object.keys(data)) setPath(fs.docs[ref.path], k, data[k]); });
}
function doDelete(ref) { write('delete', ref.path, undefined, () => { delete fs.docs[ref.path]; }); }
export const setDoc = (ref, data, opts) => { doSet(ref, data, opts); return Promise.resolve(); };
export const updateDoc = (ref, data) => { try { doUpdate(ref, data); return Promise.resolve(); } catch (e) { return Promise.reject(e); } };
export const deleteDoc = (ref) => { doDelete(ref); return Promise.resolve(); };
export const addDoc = (col, data) => { const r = doc(null, col.path, 'auto_' + Math.random().toString(36).slice(2, 10)); doSet(r, data); return Promise.resolve(r); };
export const getDoc = (ref) => Promise.resolve(docSnap(ref.path));
export const getDocFromServer = getDoc;
export const getDocFromCache = getDoc;
export const getDocs = (q) => Promise.resolve(colSnap(q.path));
export const getDocsFromServer = getDocs;
export const onSnapshot = (ref, a, b, c) => {
  let opts = {}, next, err;
  if (typeof a === 'function') { next = a; err = b; } else if (a && typeof a.next === 'function') { next = a.next.bind(a); err = a.error && a.error.bind(a); } else { opts = a || {}; next = b; err = c; }
  const l = { path: ref.path, kind: ref.type === 'collection' ? 'col' : 'doc', next, err, meta: !!opts.includeMetadataChanges, dead: false };
  fs.listeners.push(l);
  setTimeout(() => { if (!l.dead) try { next(l.kind === 'doc' ? docSnap(l.path) : colSnap(l.path)); } catch (e) { console.error(e); } }, 0);
  return () => { l.dead = true; };
};
export const runTransaction = async (db, fn) => {
  const tx = {
    get: (r) => Promise.resolve(docSnap(r.path)),
    set: (r, d, o) => { doSet(r, d, o); return tx; },
    update: (r, d) => { doUpdate(r, d); return tx; },
    delete: (r) => { doDelete(r); return tx; },
  };
  return fn(tx);
};
export const writeBatch = () => {
  const ops = [];
  const b = { set: (r, d, o) => { ops.push(() => doSet(r, d, o)); return b; }, update: (r, d) => { ops.push(() => doUpdate(r, d)); return b; },
    delete: (r) => { ops.push(() => doDelete(r)); return b; }, commit: () => { try { ops.forEach((f) => f()); return Promise.resolve(); } catch (e) { return Promise.reject(e); } } };
  return b;
};
`;

// A connect({ mock }) handler that serves the module above for every Firebase
// SDK URL and leaves every other request to `next` (or refuses it).
function firebaseMock(next) {
  return {
    patterns: ['https://www.gstatic.com/firebasejs/*', ...((next && next.patterns) || [])],
    handle(req) {
      if (req.url.startsWith('https://www.gstatic.com/firebasejs/')) return { text: MODULE, type: 'text/javascript' };
      return next && next.handle ? next.handle(req) : null;
    },
  };
}

module.exports = { firebaseMock, FAKE_FIREBASE_MODULE: MODULE };
