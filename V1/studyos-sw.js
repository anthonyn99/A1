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
 * NO CACHING. This worker deliberately has no cache logic: the suite serves
 * HTML with `no-cache` headers (see the _headers block in build.mjs) so app
 * updates reach devices immediately, and a caching SW here would defeat that.
 * ------------------------------------------------------------------------- */

const STAGE_DB = 'sos_share_stage';
const STAGE_VER = 1;
const STAGE_ST = 'pending';

// Take over promptly so a freshly installed worker handles the very next share
// rather than waiting for every StudyOS tab to close.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  let url;
  try { url = new URL(event.request.url); } catch (_) { return; }
  if (event.request.method === 'POST' && /\/studyos\/share\/?$/.test(url.pathname)) {
    event.respondWith(handleShare(event.request));
  }
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
