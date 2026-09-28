/* ============================================================================
 * StudyOS — share-target service worker
 * ============================================================================
 * PURPOSE: catch exactly one thing — the POST that the OS share sheet sends to
 * /studyos/share when someone shares files into StudyOS. Everything else falls
 * straight through to the network.
 *
 * ⚠️ SCOPE IS /studyos/ DELIBERATELY. Do NOT move this file to the site root,
 * and do NOT add it to `rootFiles` in scripts/build.mjs. The root scope belongs
 * to firebase-messaging-sw.js (the FCM SDK requires it there), and two service
 * workers cannot both own the root — see that file's own header warning. Push
 * notifications break if this one claims root.
 *
 * It lives at V1/studyos-sw.js (top level, NOT js/) because a worker served
 * from /studyos/js/ could only control /studyos/js/*, which does not cover the
 * app itself. build.mjs copies it beside studyos.html via the `assets` list.
 *
 * OFFLINE FALLBACK, NEVER STALE (engagement upgrade). The suite serves
 * everything `no-cache` (see _headers in build.mjs) so updates reach devices
 * immediately, and the original rule here was "no caching" for that reason.
 * The drills (SQL sandbox, visualizers) are meant to work offline, so this
 * worker now keeps a copy of what it fetches — but it is NETWORK-FIRST: the
 * cache is read ONLY when the network fails. Online, every request still goes
 * to the server and the fresh response replaces the copy, so an update lands
 * exactly as before.
 *
 * The one cache-first path is vendor/<name>-<version>/ (sql.js WASM, ~700KB):
 * a new version is a new path, so a cached copy can never be stale, and
 * re-downloading it on every open would waste her data.
 *
 * Only same-origin GETs under this worker's scope are touched. Firebase,
 * Firestore, the bridge on 127.0.0.1, and the share POST are left alone.
 * ------------------------------------------------------------------------- */

const CACHE = 'studyos-offline-v1';
const VENDOR_RE = /\/vendor\/[\w.-]+-\d+(\.\d+)*\//;

const STAGE_DB = 'sos_share_stage';
const STAGE_VER = 1;
const STAGE_ST = 'pending';

// Take over promptly so a freshly installed worker handles the very next share
// rather than waiting for every StudyOS tab to close.
// Precache the shell and the SQL engine so the very first offline open works;
// everything else is cached the first time it is used online. Each file is
// fetched on its own so one renamed path cannot fail the whole install.
const PRECACHE = ['./', 'css/studyos.css', 'js/studyos.js', 'config/config.js', 'js/modules/boot.js',
  'vendor/sqljs-1.14.2/sql-wasm.js', 'vendor/sqljs-1.14.2/sql-wasm.wasm'];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {})))));
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  // Drop caches from older versions of this worker.
  for (const k of await caches.keys()) if (k.startsWith('studyos-offline-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  let url;
  try { url = new URL(event.request.url); } catch (_) { return; }
  if (event.request.method === 'POST' && /\/studyos\/share\/?$/.test(url.pathname)) {
    event.respondWith(handleShare(event.request));
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  event.respondWith(VENDOR_RE.test(url.pathname) ? cacheFirst(event.request) : networkFirst(event.request));
  // Anything else: return WITHOUT calling respondWith, so the browser handles
  // the request exactly as it would if this worker did not exist.
});

async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter(f => f && typeof f.name === 'string' && typeof f.size === 'number');
    if (files.length) await stashFiles(files);
  } catch (err) {
    // A failed stash must still land the user in the app rather than on an
    // error page; they can retry the share.
    console.warn('[StudyOS SW] share stash failed:', err);
  }
  // 303 converts the POST into a GET so a reload of the landing page cannot
  // re-submit the share.
  return Response.redirect('./?share=1', 303);
}

function openStage() {
  return new Promise((resolve, reject) => {
    let r;
    try { r = indexedDB.open(STAGE_DB, STAGE_VER); }
    catch (e) { reject(e); return; }
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STAGE_ST)) db.createObjectStore(STAGE_ST, { keyPath: 'id' });
    };
    r.onsuccess = e => resolve(e.target.result);
    r.onerror = () => reject(r.error);
  });
}

// Staging lives in its OWN database, not in sos_file_store. Two reasons:
// adding a store there would mean a version bump, and that store's open()
// rejects on `blocked` — so upgrading while a second StudyOS tab was open
// would break every file read and write in both tabs. And keeping the two
// apart means a share that is never confirmed cannot pollute the real library.
async function stashFiles(files) {
  const db = await openStage();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STAGE_ST, 'readwrite');
      const st = tx.objectStore(STAGE_ST);
      const ts = Date.now();
      files.forEach((f, i) => {
        st.put({
          id: 'st_' + ts + '_' + i + '_' + Math.random().toString(36).slice(2, 6),
          blob: f,
          name: f.name || 'shared',
          type: f.type || 'application/octet-stream',
          size: f.size || 0,
          ts,
        });
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    try { db.close(); } catch (_) {}
  }
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    // ignoreSearch: module imports carry cache-busting queries in tests.
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
  return res;
}
