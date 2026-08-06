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

  /* Live listener.
   *
   * This used to gate on a 6-SECOND WALL-CLOCK WINDOW after our own last save:
   * any snapshot landing inside it was held, and — if another local save had
   * happened meanwhile — DISCARDED, on the theory that the local edit was
   * newer. Two problems, both of which showed up as "it synced, but the other
   * device didn't change until I refreshed":
   *
   *   1. _sosLastOwnSaveAt is stamped on every _fbSaveStudyOs call (i.e. every
   *      edit, debounced 1.5s) AND again after the write resolves, so an
   *      actively-used device sat in a near-permanent 6s blackout.
   *   2. onSnapshot does not re-deliver. A dropped snapshot is gone for good,
   *      so a delete performed on device A could stay visible on device B
   *      indefinitely — precisely the reported bug.
   *
   * Firestore already answers the "is this my own echo?" question exactly, so
   * no timing heuristic is needed: metadata.hasPendingWrites is true only while
   * THIS client has unacknowledged local writes. Those we skip (we already
   * rendered them optimistically). Everything else is real server state and is
   * applied immediately — which is what makes edits appear live on every
   * device. The document is a full snapshot of state, so applying a slightly
   * older one is self-correcting: the next snapshot carries the newer state. */
  const _sosEmitRemote = (data) => {
    window.dispatchEvent(new CustomEvent('fb-sos-remote', { detail: data }));
    window.dispatchEvent(new CustomEvent('fb-sos-synced'));
  };

  _sosUnsubscribe = onSnapshot(sosDocRef, { includeMetadataChanges: false }, (snap) => {
    // A snapshot straight off the wire proves we've seen real server state.
    if (snap.metadata && snap.metadata.fromCache === false) _sosMarkServerSeen();
    if (!snap.exists()) return;

    // Our own not-yet-acknowledged write echoing back. The local UI is already
    // showing this exact state, so re-emitting it would just churn the DOM.
    if (snap.metadata && snap.metadata.hasPendingWrites) return;

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
  /* Debounce coalesces a burst of edits (typing in a note, dragging an event)
   * into one write. 1500ms was tuned when snapshots were held for 6s anyway;
   * now that remote state applies immediately, the debounce IS the end-to-end
   * latency other devices see, so it is the thing to keep short. 400ms still
   * collapses a typing burst into a single write while making an edit land on
   * the other device almost at once. */
  const SOS_SAVE_DEBOUNCE_MS = 400;
  window._fbSaveStudyOs = (payload) => {
    _sosPendingPayload = payload;
    _sosLastOwnSaveAt = Date.now();
    if (_sosSaveTimer) clearTimeout(_sosSaveTimer);
    _sosSaveTimer = setTimeout(() => { _sosWhenServerSeen(_sosDoSave); }, SOS_SAVE_DEBOUNCE_MS);
  };

  /* ══ Notes-module page editor (docx engine "so" app) ═══════════════════════
   * One Firestore doc per StudyOS Notes module, at studyos_notes/{moduleId} —
   * unlike the single whole-suite StudyOS document above, each module's pages
   * sync independently so opening one module's editor never has to read or
   * write another module's (potentially large, image-heavy) page content.
   * Mirrors the same stale-overwrite guard used for the main document: no
   * write for a given module may land until this session has confirmed real
   * server state for THAT module at least once. */
  const NOTES_COLLECTION = PATHS.studyosNotes || 'studyos_notes';
  const _notesServerSeen = {};      // moduleId -> bool
  const _notesPendingWrites = {};   // moduleId -> [fn]
  const _notesSaveTimers = {};      // moduleId -> timeout id
  const _notesPendingPayload = {};  // moduleId -> payload
  const _notesUnsub = {};           // moduleId -> unsubscribe fn

  function _notesMarkServerSeen(modId) {
    if (_notesServerSeen[modId]) return;
    _notesServerSeen[modId] = true;
    const q = _notesPendingWrites[modId] || []; _notesPendingWrites[modId] = [];
    q.forEach((fn) => { try { fn(); } catch (e) { console.warn('[StudyOS Notes] deferred write failed:', e && e.message); } });
  }
  function _notesWhenServerSeen(modId, fn) {
    if (_notesServerSeen[modId]) return fn();
    if (!_notesPendingWrites[modId]) _notesPendingWrites[modId] = [];
    if (_notesPendingWrites[modId].indexOf(fn) === -1) _notesPendingWrites[modId].push(fn);
    return Promise.resolve();
  }
  function _notesDocRef(modId) { return doc(db, NOTES_COLLECTION, String(modId)); }

  // Live per-module listener, started lazily the first time a module is opened
  // (openNotesModule calls _fbLoadJournal, which starts this) — not for every
  // module up front, since most modules are never opened in a given session.
  function _notesWatch(modId) {
    if (_notesUnsub[modId]) return;
    _notesUnsub[modId] = onSnapshot(_notesDocRef(modId), { includeMetadataChanges: false }, (snap) => {
      if (snap.metadata && snap.metadata.fromCache === false) _notesMarkServerSeen(modId);
      if (!snap.exists()) return;
      if (snap.metadata && snap.metadata.hasPendingWrites) return;   // our own echo
      window.dispatchEvent(new CustomEvent('fb-notes-remote', { detail: { moduleId: modId, data: snap.data() } }));
    }, (err) => { console.warn('[StudyOS Notes] onSnapshot error:', modId, err && err.code); });
  }

  window._fbLoadJournal = async (modId) => {
    if (!modId) return null;
    _notesWatch(modId);
    try {
      const snap = await _freshGet(_notesDocRef(modId));
      if (snap && snap.metadata && snap.metadata.fromCache === false) _notesMarkServerSeen(modId);
      if (snap && snap.exists()) return snap.data();
      return null;
    } catch (e) {
      console.warn('[StudyOS Notes] load failed:', modId, e);
      return null;
    }
  };

  const _notesDoSave = async (modId) => {
    const payload = _notesPendingPayload[modId];
    if (!payload) return;
    _notesPendingPayload[modId] = null;
    const ok = await _guardedWrite(_notesDocRef(modId), payload, 'StudyOS Notes ' + modId);
    window.dispatchEvent(new CustomEvent(ok ? 'fb-notes-saved' : 'fb-notes-error', { detail: { moduleId: modId } }));
  };
  const NOTES_SAVE_DEBOUNCE_MS = 400;
  // getState is called lazily at flush time (not at call time) so the LATEST
  // in-memory state is what gets written, even if more edits land during the
  // debounce window — same reasoning as the StudyOS document's own pending-
  // payload slot above.
  window._fbSaveJournal = (modId, getState) => {
    if (!modId) return;
    const state = getState();
    _notesPendingPayload[modId] = { entries: state.entries, activeId: state.activeId, savedAt: Date.now() };
    if (_notesSaveTimers[modId]) clearTimeout(_notesSaveTimers[modId]);
    _notesSaveTimers[modId] = setTimeout(() => { _notesWhenServerSeen(modId, () => _notesDoSave(modId)); }, NOTES_SAVE_DEBOUNCE_MS);
  };
  window._fbFlushJournal = (modId) => {
    if (!modId || !_notesSaveTimers[modId]) return;
    clearTimeout(_notesSaveTimers[modId]);
    _notesWhenServerSeen(modId, () => _notesDoSave(modId));
  };
  // Single-entry / order-only writes read the full current entries array and
  // save it via the same debounced path — StudyOS Notes stores the whole
  // module's entries as one document (like the "so" state shape), not one
  // Firestore doc per entry, so there is no smaller unit to write.
  window._fbSaveJournalEntry = (modId, entry, allEntries) => {
    if (!modId) return;
    window._fbSaveJournal(modId, () => ({ entries: allEntries, activeId: entry.id }));
  };
  window._fbSaveJournalOrder = (modId, entries) => {
    if (!modId) return;
    window._fbSaveJournal(modId, () => ({ entries: entries, activeId: null }));
  };
  window._fbDeleteJournalEntry = async (modId, entryId) => {
    // Entries live inside the one per-module document (not per-entry docs), so
    // "deleting" an entry is just writing the module's array without it —
    // openNotesModule's caller (hardDeleteEntry) already filtered state.entries
    // before this is called; nothing further to do here.
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
