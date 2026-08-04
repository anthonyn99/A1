/* ============================================================================
 * StudyOS — Firebase sync layer  (ES module)
 * ============================================================================
 * Owns everything that talks to Firestore. Publishes the exact same globals
 * and window events the app already listens for, so js/studyos.js and
 * js/applock.js needed no changes to work with it:
 *
 *   window._fbReady            true once Firestore is live
 *   window._fbAuthReady        promise, resolves when anon auth has a token
 *   window._fbLoadStudyOs()    → Promise<data|null>   (fresh server read)
 *   window._fbSaveStudyOs(p)   debounced 1.5s guarded write
 *   window._fbLoadAppLocks()   → Promise<locks|null>
 *   window._fbSaveAppLocks(o)  debounced 400ms write
 *   window._fbSaveReminder(r)  push reminder → /reminders  (read by the cron)
 *   window._fbDeleteReminder(id)
 *   window._fbSaveFcmToken(t)  device push token → /fcm_tokens
 *
 *   events: fb-ready, fb-sos-remote, fb-sos-synced, fb-sos-saved, fb-sos-error
 *
 * Everything account-specific comes from config/config.js. With Firebase
 * unconfigured this module exits immediately and StudyOS runs purely local —
 * localStorage + IndexedDB — with the sync pill showing "offline".
 *
 * PRESERVED BEHAVIOUR (do not "simplify" these — each one is a fixed bug):
 *   • stale-overwrite guard: no write may land until this session has confirmed
 *     real server state once. Without it, a refresh that fell back to the
 *     offline cache would write the OLD class list back over the newer server
 *     copy — permanently deleting files that had been uploaded elsewhere.
 *   • held-snapshot replay: snapshots arriving inside our own-save echo window
 *     are held and re-applied, not dropped. Dropping them meant a genuine
 *     update from another device could be discarded for good.
 *   • size guard: an oversized write is refused client-side, because Firestore
 *     rejecting a >1MiB document wedges the sync queue for the whole app.
 *   • single-tab persistence on iOS: the multi-tab lease never gets released
 *     when iOS kills a backgrounded PWA, so the next cold launch hangs.
 * ------------------------------------------------------------------------- */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js';
import { initializeAppCheck, ReCaptchaV3Provider } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-app-check.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, persistentSingleTabManager,
  doc, setDoc, deleteDoc, onSnapshot, getDoc, getDocFromServer,
} from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';

const CFG   = window.STUDYOS_CONFIG || {};
const FB    = CFG.firebase || {};
const PATHS = FB.paths || {};

/* ── Bail out cleanly when unconfigured ───────────────────────────────────── */
if (!window.STUDYOS_CONFIG_READY || !window.STUDYOS_CONFIG_READY('firebase')) {
  console.info('[StudyOS] Firebase not configured — running local-only. Fill in config/config.js §1 to enable cloud sync.');
  window._fbReady = false;
  window._fbAuthReady = Promise.resolve(false);
  window.dispatchEvent(new CustomEvent('fb-unconfigured'));
} else {
  const app = initializeApp({
    apiKey: FB.apiKey,
    authDomain: FB.authDomain,
    projectId: FB.projectId,
    storageBucket: FB.storageBucket,
    messagingSenderId: FB.messagingSenderId,
    appId: FB.appId,
  });

  /* Optional App Check. Off by default: a misconfigured App Check blocks every
   * request and is indistinguishable from broken security rules. */
  if (FB.appCheck && FB.appCheck.enabled && FB.appCheck.recaptchaSiteKey) {
    try {
      initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(FB.appCheck.recaptchaSiteKey),
        isTokenAutoRefreshEnabled: true,
      });
    } catch (e) { console.warn('[StudyOS] App Check init failed:', e); }
  }

  /* ── Anonymous auth ────────────────────────────────────────────────────────
   * Gates the security rules without asking anyone to log in. Exposed as a
   * promise because a read that fires before auth resolves can only be answered
   * from the local cache — which is the "shows old data, then slowly syncs"
   * symptom on cold launches. */
  const auth = getAuth(app);
  let _authResolve;
  window._fbAuthReady = new Promise((res) => { _authResolve = res; });
  onAuthStateChanged(auth, (user) => { if (user) { try { _authResolve && _authResolve(true); } catch (e) {} } });
  signInAnonymously(auth).catch((e) => {
    console.error('[StudyOS] Anonymous auth failed:', e && e.code,
      '\n→ Firebase console → Authentication → Sign-in method → enable "Anonymous".');
  });

  /* ── Firestore with offline persistence ───────────────────────────────────
   * iOS home-screen PWAs get the SINGLE-tab manager. The multi-tab manager
   * elects a leader through an IndexedDB "primary lease"; iOS kills backgrounded
   * PWAs without releasing it, so the next cold launch waits — sometimes
   * forever — for the stale lease to expire before syncing from the server. A
   * home-screen PWA only ever runs one instance, so nothing is lost. */
  const _isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);

  let db;
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: _isIOS ? persistentSingleTabManager({}) : persistentMultipleTabManager(),
      }),
    });
  } catch (e) {
    console.warn('[StudyOS] Persistent cache unavailable, falling back to memory:', e);
    db = initializeFirestore(app, {});
  }

  const FB_MAX_WRITE_BYTES = FB.maxDocBytes || 900 * 1024;
  function _fbByteSize(obj) {
    try { return new Blob([JSON.stringify(obj)]).size; }
    catch (e) { try { return JSON.stringify(obj).length; } catch (_) { return 0; } }
  }

  /* Guarded write: refuse oversized payloads, time out a stuck write, and never
   * treat a genuinely-offline queue as a failure. Returns true on success. */
  let _fbWriteFailStreak = 0;
  async function _guardedWrite(ref, payload, label) {
    const bytes = _fbByteSize(payload);
    if (bytes > FB_MAX_WRITE_BYTES) {
      console.error('[StudyOS] ' + label + ' write blocked: ' + bytes +
        ' bytes is over the safe limit — not submitting (would wedge sync). Data kept locally.');
      return false;
    }
    // Definitely offline: let it queue and settle on reconnect. A queued offline
    // edit is not a poisoned write, so no timeout and no false failure.
    if (navigator.onLine === false) {
      try { await setDoc(ref, payload); _fbWriteFailStreak = 0; return true; }
      catch (e) { console.warn('[StudyOS] ' + label + ' write failed (offline):', e && (e.code || e.message)); return false; }
    }
    const writeP = setDoc(ref, payload);
    writeP.catch(() => {});   // swallow a late rejection if the timeout wins the race
    let to;
    const timeoutP = new Promise((_, rej) => { to = setTimeout(() => rej(new Error('fb-write-timeout')), 12000); });
    try {
      await Promise.race([writeP, timeoutP]);
      clearTimeout(to);
      _fbWriteFailStreak = 0;
      return true;
    } catch (e) {
      clearTimeout(to);
      _fbWriteFailStreak++;
      console.warn('[StudyOS] ' + label + ' write failed:', e && (e.code || e.message));
      return false;
    }
  }

  /* Fresh read: try the SERVER up to 3× before ever falling back to the cache.
   * A single slow round-trip returning a stale cached copy is how a hard refresh
   * could surface an OLD version of the data. */
  async function _freshGet(ref) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await Promise.race([
          getDocFromServer(ref),
          new Promise((_, rej) => setTimeout(() => rej(new Error('fresh-timeout')), 5000)),
        ]);
      } catch (e) {
        if (attempt < 2) { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); continue; }
        try { return await getDoc(ref); } catch (_) { return null; }
      }
    }
    return null;
  }

  /* ══ StudyOS document ════════════════════════════════════════════════════ */
  const sosDocRef = doc(db, PATHS.studyos || 'dashboards/studyos');

  let _sosSaveTimer = null;
  let _sosLastOwnSaveAt = 0;
  let _sosUnsubscribe = null;

  /* Stale-overwrite guard. A session may NOT write until it has confirmed real
   * server state at least once. Until then writes are QUEUED (never dropped)
   * and flushed after the incoming server data merges. */
  let _sosServerSeen = false;
  let _sosPendingWrites = [];
  function _sosMarkServerSeen() {
    if (_sosServerSeen) return;
    _sosServerSeen = true;
    const q = _sosPendingWrites; _sosPendingWrites = [];
    q.forEach((fn) => { try { fn(); } catch (e) { console.warn('[StudyOS] deferred write failed:', e && e.message); } });
  }
  function _sosWhenServerSeen(fn) {
    if (_sosServerSeen) return fn();
    // Dedupe by reference so a long offline session can't grow this unbounded.
    if (_sosPendingWrites.indexOf(fn) === -1) _sosPendingWrites.push(fn);
    return Promise.resolve();
  }

  /* Live listener. Snapshots landing inside our own-save echo window are HELD
   * and replayed, never dropped — onSnapshot only re-fires on the next change,
   * so a dropped update from another device is lost for good. */
  let _sosHeldRemote = null, _sosHeldRemoteAt = 0, _sosHeldTimer = null;
  const _sosEmitRemote = (data) => {
    window.dispatchEvent(new CustomEvent('fb-sos-remote', { detail: data }));
    window.dispatchEvent(new CustomEvent('fb-sos-synced'));
  };

  _sosUnsubscribe = onSnapshot(sosDocRef, (snap) => {
    // A snapshot straight off the wire proves we've seen real server state.
    if (snap.metadata && snap.metadata.fromCache === false) _sosMarkServerSeen();
    if (!snap.exists()) return;
    const gap = Date.now() - _sosLastOwnSaveAt;
    if (gap < 6000) {
      _sosHeldRemote = snap.data();
      _sosHeldRemoteAt = Date.now();
      if (_sosHeldTimer) clearTimeout(_sosHeldTimer);
      _sosHeldTimer = setTimeout(() => {
        _sosHeldTimer = null;
        const data = _sosHeldRemote; _sosHeldRemote = null;
        if (!data) return;
        // A local edit queued after this snapshot arrived is the newer state —
        // replaying the older doc over it would undo the user's work.
        if (_sosLastOwnSaveAt > _sosHeldRemoteAt) return;
        _sosEmitRemote(data);
      }, (6000 - gap) + 250);
      return;
    }
    _sosHeldRemote = null;
    if (_sosHeldTimer) { clearTimeout(_sosHeldTimer); _sosHeldTimer = null; }
    _sosEmitRemote(snap.data());
  }, (err) => {
    console.warn('[StudyOS] onSnapshot error:', err && err.code);
    window.dispatchEvent(new CustomEvent('fb-sos-error'));
  });

  window._fbLoadStudyOs = async () => {
    try {
      const snap = await _freshGet(sosDocRef);
      // Only a genuinely-fresh read unlocks writing. A cache hit leaves us
      // locked, so the stale copy we're about to render can never be written
      // back over newer server data.
      if (snap && snap.metadata && snap.metadata.fromCache === false) _sosMarkServerSeen();
      if (snap && snap.exists()) return snap.data();
      return null;
    } catch (e) {
      console.warn('[StudyOS] load failed:', e);
      return null;
    }
  };

  /* One stable function reference (not a per-call closure) so the server-seen
   * queue dedupes it, plus one slot holding the LATEST payload — a session that
   * stays locked coalesces into a single correct write instead of replaying a
   * backlog of stale ones. */
  let _sosPendingPayload = null;
  const _sosDoSave = async () => {
    const payload = _sosPendingPayload;
    if (!payload) return;
    _sosPendingPayload = null;
    try {
      _sosLastOwnSaveAt = Date.now();
      const ok = await _guardedWrite(sosDocRef, payload, 'StudyOS');
      _sosLastOwnSaveAt = Date.now();
      window.dispatchEvent(new CustomEvent(ok ? 'fb-sos-saved' : 'fb-sos-error'));
    } catch (e) {
      console.warn('[StudyOS] save failed:', e);
      window.dispatchEvent(new CustomEvent('fb-sos-error'));
    }
  };
  window._fbSaveStudyOs = (payload) => {
    _sosPendingPayload = payload;
    _sosLastOwnSaveAt = Date.now();
    if (_sosSaveTimer) clearTimeout(_sosSaveTimer);
    _sosSaveTimer = setTimeout(() => { _sosWhenServerSeen(_sosDoSave); }, 1500);
  };

  /* ══ App Lock state ══════════════════════════════════════════════════════
   * WHICH lock is on, and at what version — shared across all devices. The
   * password itself never touches Firestore; only its salted hash lives in the
   * Worker's KV. */
  const alDocRef = doc(db, PATHS.applock || 'dashboards/studyos_lock');
  let _alLastOwnSaveAt = 0;
  let _alSaveTimer = null;

  window._fbSaveAppLocks = (locksObj) => {
    clearTimeout(_alSaveTimer);
    _alSaveTimer = setTimeout(async () => {
      try {
        _alLastOwnSaveAt = Date.now();
        await setDoc(alDocRef, { locks: locksObj || {}, savedAt: Date.now() });
        _alLastOwnSaveAt = Date.now();
      } catch (e) { console.warn('[AppLock] Firebase save failed:', e); }
    }, 400);
  };
  window._fbLoadAppLocks = async () => {
    try {
      const snap = await _freshGet(alDocRef);
      if (snap && snap.exists()) { const d = snap.data(); return d.locks || {}; }
    } catch (e) { console.warn('[AppLock] Firebase load failed:', e); }
    return null;
  };
  onSnapshot(alDocRef, (snap) => {
    if (!snap.exists()) return;
    if (Date.now() - _alLastOwnSaveAt < 2000) return;   // our own echo
    const d = snap.data();
    if (window._alApplyRemoteLocks) window._alApplyRemoteLocks(d.locks || {});
  }, (err) => { console.warn('[AppLock] onSnapshot error:', err && err.code); });

  /* ══ Push reminders ══════════════════════════════════════════════════════
   * One document per scheduled reminder. The studyos-api Worker's cron reads
   * documents whose notifyAt has passed, sends them through FCM, and deletes
   * them. Writing here is all the client has to do. */
  const REMINDERS = PATHS.reminders || 'reminders';
  window._fbSaveReminder = async (rem) => {
    if (!rem || !rem.id) return false;
    try {
      await setDoc(doc(db, REMINDERS, String(rem.id)), rem);
      return true;
    } catch (e) { console.warn('[StudyOS] reminder save failed:', e && e.code); return false; }
  };
  window._fbDeleteReminder = async (id) => {
    if (!id) return;
    try { await deleteDoc(doc(db, REMINDERS, String(id))); }
    catch (e) { console.warn('[StudyOS] reminder delete failed:', e && e.code); }
  };

  /* Device push token, so the cron knows where to deliver. Keyed by token so
   * re-registering the same device is idempotent. */
  const FCM_TOKENS = PATHS.fcmTokens || 'fcm_tokens';
  window._fbSaveFcmToken = async (token, meta) => {
    if (!token) return;
    try {
      await setDoc(doc(db, FCM_TOKENS, token), Object.assign({
        token, app: 'studyos', ua: navigator.userAgent || '', updatedAt: Date.now(),
      }, meta || {}));
    } catch (e) { console.warn('[StudyOS] token save failed:', e && e.code); }
  };

  /* ── Ready ────────────────────────────────────────────────────────────────
   * Announced after auth resolves so the first listener carries a real token.
   * A 6s cap keeps a wedged auth from blocking the whole app forever — the app
   * still boots, just local-first, and syncs when auth eventually lands. */
  Promise.race([
    window._fbAuthReady,
    new Promise((r) => setTimeout(r, 6000)),
  ]).then(() => {
    window._fbReady = true;
    window.dispatchEvent(new CustomEvent('fb-ready'));
  });
}
