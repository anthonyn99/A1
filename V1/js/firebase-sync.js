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
 *   • a NAMED app ('studyos'): its own IndexedDB cache, so TaskHub's forced
 *     ownership of the shared [DEFAULT] cache can never kill this instance.
 *   • single-tab persistence, never forced: the multi-tab manager lives in the
 *     shared, often-full localStorage; iOS never releases its lease.
 * ------------------------------------------------------------------------- */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js';
import { initializeAppCheck, ReCaptchaV3Provider } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-app-check.js';
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
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
  /* A NAMED app, not [DEFAULT]. Firestore names its IndexedDB cache after the
   * app ("firestore/<appName>/<projectId>/main"), and every A1 page on this
   * origin shares the Index project. Under [DEFAULT], StudyOS shared ONE cache
   * with TaskHub, whose single-tab manager takes it with forceOwnership. When
   * StudyOS held that cache and TaskHub then opened (or re-inited on its 1 s
   * hide-teardown), StudyOS's Firestore failed an internal assertion ("Failed to
   * obtain exclusive access to the persistence layer") and rejected every read
   * and write until a reload: the "sync failed" pill, and StudyOS work never
   * reaching TaskHub through the mirror (2026-09-30, reproduced offline). Its own
   * name gives StudyOS its own cache, which nothing else ever forces.
   * taskmirror.js and push.js take getApps()[0], so they follow automatically.
   * The auth session is per app name too, so this is a separate anonymous user;
   * the Index project's rules only require request.auth != null. */
  const app = initializeApp({
    apiKey: FB.apiKey,
    authDomain: FB.authDomain,
    projectId: FB.projectId,
    storageBucket: FB.storageBucket,
    messagingSenderId: FB.messagingSenderId,
    appId: FB.appId,
  }, 'studyos');

  /* Optional App Check. Off by default: a misconfigured App Check blocks every
   * request and is indistinguishable from broken security rules. */
  if (FB.appCheck && FB.appCheck.enabled && FB.appCheck.recaptchaSiteKey) {
    try {
      const _ac = initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(FB.appCheck.recaptchaSiteKey),
        isTokenAutoRefreshEnabled: true,
      });
      /* Hand the App Check token to callers that talk to a WORKER rather than
       * to Firebase (js/modules/pipeline.js and studyos-ai's /api/ai/* routes).
       *
       * Those Workers sit on public URLs in a public repo, so there is no
       * secret the page could hold instead — an App Check token is the one
       * credential minted at runtime against the registered origin, which is
       * why workers/_shared/appcheck.js verifies exactly this. Firebase's own
       * SDK attaches it automatically; a plain fetch() does not, so it has to
       * be reachable here.
       *
       * Returns null rather than throwing when App Check is off or the mint
       * fails: the caller then gets a clean 401 from the Worker instead of an
       * unhandled rejection inside an unrelated feature. */
      window._fbAppCheckToken = async () => {
        try {
          const { getToken } = await import('https://www.gstatic.com/firebasejs/12.12.0/firebase-app-check.js');
          const r = await getToken(_ac, /* forceRefresh */ false);
          return (r && r.token) || null;
        } catch (e) { console.warn('[StudyOS] App Check token failed:', e); return null; }
      };
    } catch (e) { console.warn('[StudyOS] App Check init failed:', e); }
  }
  if (!window._fbAppCheckToken) window._fbAppCheckToken = async () => null;

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

  /* ── Firestore with offline persistence: SINGLE-tab, on every platform ─────
   *   • Never the multi-tab manager. It coordinates tabs through localStorage,
   *     which every A1 page shares and which fills up: on a full store its first
   *     write throws inside Firestore's queue and every later read and write
   *     fails (Veda's Brave, 2026-09-30). TaskHub's _freeWebStorage also deletes
   *     every firestore_* key on each load, which is that manager's state.
   *   • iOS kills backgrounded PWAs without releasing a multi-tab lease, so the
   *     next cold launch waited for it to expire.
   *   • Never forceOwnership. A second StudyOS tab that finds the lease taken
   *     falls back to a memory cache and still syncs; forcing would make tabs
   *     steal the cache from each other, the failure described above. */
  /* ── One-time recovery from the reminder write flood ──────────────────────
   * Until 2026-09-30, every render queued a Firestore delete for every event
   * and task without a reminder (push.js). Veda's queue in this cache reached
   * ~2,800 unsent writes, and Firestore sends writes strictly in order, so her
   * real saves waited behind them for ages. Before Firestore opens the cache,
   * this reads its queue; if it is large AND holds nothing but regenerable
   * writes (reminder deletes, the TaskHub mirror, the class-apps list, all
   * rebuilt from current data on every load), the cache is dropped and starts
   * clean. Any other pending write (the StudyOS document, notes, cards,
   * topics, sessions) means real data is waiting, and nothing is touched.
   * Only this app's OWN cache ('studyos') is ever considered; TaskHub's is not. */
  const _FS_DB = 'firestore/studyos/' + FB.projectId + '/main';
  const _REGEN = /^(studyos_reminders\/|dashboards\/studyos_mirror$|dashboards\/studyos_class_apps$)/;
  await (async () => {
    try {
      if (!indexedDB || !indexedDB.databases) return;
      const names = (await indexedDB.databases()).map(d => d.name);
      if (names.indexOf(_FS_DB) < 0) return;
      const verdict = await new Promise((res) => {
        const rq = indexedDB.open(_FS_DB);
        rq.onerror = () => res(null);
        rq.onblocked = () => res(null);
        rq.onsuccess = () => {
          const d = rq.result;
          try {
            if (!d.objectStoreNames.contains('mutations')) { d.close(); return res(null); }
            const all = d.transaction('mutations').objectStore('mutations').getAll();
            all.onsuccess = () => {
              const batches = all.result || [];
              let regenOnly = true;
              for (const b of batches) {
                for (const w of (b.mutations || [])) {
                  const name = String((w.update && w.update.name) || w.delete || (w.transform && w.transform.document) || '');
                  const path = name.split('/documents/')[1] || '';
                  if (!_REGEN.test(path)) { regenOnly = false; break; }
                }
                if (!regenOnly) break;
              }
              d.close();
              res({ count: batches.length, regenOnly });
            };
            all.onerror = () => { d.close(); res(null); };
          } catch (e) { try { d.close(); } catch (_) {} res(null); }
        };
      });
      if (!verdict || verdict.count < 200 || !verdict.regenOnly) return;
      await new Promise((res) => {
        const del = indexedDB.deleteDatabase(_FS_DB);
        del.onsuccess = del.onerror = del.onblocked = () => res();
      });
      console.info('[StudyOS] Cleared ' + verdict.count + ' stale queued writes (reminder flood); the cache starts clean.');
    } catch (e) { /* recovery is best-effort; Firestore opens either way */ }
  })();

  let db;
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }),
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
  // For the self-cleanup adapter in studyos.js: true once server state has been
  // applied (the listener marks this only after emitting it).
  window._fbSosServerSeen = () => _sosServerSeen;
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

  /* includeMetadataChanges: TRUE. On a normal reload the first snapshot comes
   * from the persistent cache (fromCache: true); when the server then confirms
   * the SAME data, only the metadata changes, and with metadata changes off
   * Firestore never calls back. Unlocking only from this listener therefore
   * left every write queued forever after the first visit ("not syncing",
   * 2026-09-30). With them on we always see the confirmation; _sosLastEmitted
   * keeps a metadata-only callback from re-rendering unchanged data. */
  let _sosLastEmitted = null;
  _sosUnsubscribe = onSnapshot(sosDocRef, { includeMetadataChanges: true }, (snap) => {
    const fromServer = !!(snap.metadata && snap.metadata.fromCache === false);
    // Our own not-yet-acknowledged write echoing back is skipped: the local UI
    // is already showing this exact state, so re-emitting it would churn the DOM.
    if (snap.exists() && !(snap.metadata && snap.metadata.hasPendingWrites)) {
      const data = snap.data();
      let sig = null;
      try { sig = JSON.stringify(data); } catch (e) {}
      // Emit when the data changed, and once for the first server-confirmed
      // copy (so the app applies server state before writes unlock below).
      if (sig === null || sig !== _sosLastEmitted || (fromServer && !_sosServerSeen)) {
        _sosLastEmitted = sig;
        _sosEmitRemote(data);
      }
    }

    // A snapshot straight off the wire proves we've seen real server state, so
    // queued writes may go. This comes AFTER the emit on purpose: the
    // fb-sos-remote handler applies the data synchronously, and the flush then
    // saves the MERGED state (see _sosDoSave). Unlocking first sent whatever was
    // queued before the server data arrived, which on a device with a stale
    // local cache (Veda's Brave held a one-class copy, 2026-09-30) meant a boot
    // write, such as a file-upload persist, could overwrite the real class list.
    if (fromServer) _sosMarkServerSeen();
  }, (err) => {
    console.warn('[StudyOS] onSnapshot error:', err && err.code);
    window.dispatchEvent(new CustomEvent('fb-sos-error'));
  });

  window._fbLoadStudyOs = async () => {
    try {
      const snap = await _freshGet(sosDocRef);
      // This read does NOT unlock writing: the caller applies the data only
      // after this resolves, so unlocking here would flush queued writes built
      // from the stale local copy first. The live listener unlocks once it has
      // applied server state.
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
    if (!_sosPendingPayload) return;
    // Rebuild from the app's CURRENT state rather than the object captured when
    // the save was requested: a write queued before server state arrived was
    // built from the stale local cache, and the merge has replaced it since.
    let payload = _sosPendingPayload;
    if (typeof window._sosBuildPayload === 'function') {
      try { payload = window._sosBuildPayload() || payload; } catch (e) { console.warn('[StudyOS] payload rebuild failed:', e); }
    }
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

  /* ══ Flashcards + review state ═══════════════════════════════════════════
   * ONE DOCUMENT PER CLASS, deliberately NOT part of the main StudyOS document.
   *
   * That document is written with a whole-document setDoc. Review state is the
   * most write-heavy data in the app — one write per card graded — and the most
   * likely to change on two devices at once (phone between classes, laptop at
   * night). Putting it there would mean the laptop's save silently erasing a
   * phone session's review history, and nothing on screen would look wrong.
   *
   * Same shape and same stale-overwrite guard as the per-module notes above: no
   * write for a class may land until this session has confirmed real server
   * state for THAT class at least once, so a cold start cannot overwrite
   * another device with an empty local deck. */
  const CARDS_COLLECTION = PATHS.studyosCards || 'studyos_cards';
  const _cardsServerSeen = {};
  const _cardsPendingWrites = {};
  const _cardsSaveTimers = {};
  const _cardsPendingPayload = {};
  const _cardsUnsub = {};

  function _cardsMarkServerSeen(classId) {
    if (_cardsServerSeen[classId]) return;
    _cardsServerSeen[classId] = true;
    const q = _cardsPendingWrites[classId] || []; _cardsPendingWrites[classId] = [];
    q.forEach((fn) => { try { fn(); } catch (e) { console.warn('[StudyOS Cards] deferred write failed:', e && e.message); } });
  }
  function _cardsWhenServerSeen(classId, fn) {
    if (_cardsServerSeen[classId]) return fn();
    if (!_cardsPendingWrites[classId]) _cardsPendingWrites[classId] = [];
    if (_cardsPendingWrites[classId].indexOf(fn) === -1) _cardsPendingWrites[classId].push(fn);
    return Promise.resolve();
  }
  function _cardsDocRef(classId) { return doc(db, CARDS_COLLECTION, String(classId)); }

  async function _cardsDoSave(classId) {
    const payload = _cardsPendingPayload[classId];
    if (!payload) return;
    delete _cardsPendingPayload[classId];
    try {
      await setDoc(_cardsDocRef(classId), payload, { merge: false });
    } catch (e) {
      console.warn('[StudyOS Cards] save failed:', classId, e && e.code);
    }
  }

  function _cardsWatch(classId) {
    if (_cardsUnsub[classId]) return;
    _cardsUnsub[classId] = onSnapshot(_cardsDocRef(classId), { includeMetadataChanges: false }, (snap) => {
      if (snap.metadata && snap.metadata.fromCache === false) _cardsMarkServerSeen(classId);
      if (!snap.exists()) return;
      if (snap.metadata && snap.metadata.hasPendingWrites) return;   // our own echo
      const data = snap.data() || {};
      window.dispatchEvent(new CustomEvent('fb-cards-remote', {
        detail: { classId, cards: Array.isArray(data.cards) ? data.cards : [] },
      }));
    }, (err) => console.warn('[StudyOS Cards] onSnapshot error:', classId, err && err.code));
  }

  window._fbSaveCards = (classId, list) => {
    if (!classId) return;
    _cardsPendingPayload[classId] = { cards: list || [], savedAt: Date.now() };
    if (_cardsSaveTimers[classId]) clearTimeout(_cardsSaveTimers[classId]);
    _cardsSaveTimers[classId] = setTimeout(() => {
      _cardsWhenServerSeen(classId, () => _cardsDoSave(classId));
    }, NOTES_SAVE_DEBOUNCE_MS);
  };

  window._fbLoadCards = async (classId) => {
    if (!classId) return null;
    _cardsWatch(classId);
    try {
      const snap = await _freshGet(_cardsDocRef(classId));
      if (snap && snap.metadata && snap.metadata.fromCache === false) _cardsMarkServerSeen(classId);
      if (snap && snap.exists()) {
        const d = snap.data() || {};
        return Array.isArray(d.cards) ? d.cards : [];
      }
      // A class with no deck yet is a legitimate empty state, and confirming
      // that from the server is what unblocks the first write.
      if (snap) _cardsMarkServerSeen(classId);
      return [];
    } catch (e) {
      console.warn('[StudyOS Cards] load failed:', classId, e && e.code);
      return null;
    }
  };

  /* ══ Study sessions ══════════════════════════════════════════════════════
   * One document, same reasoning as the cards above: sessions are written from
   * whichever device she is studying on, and folding them into the main
   * whole-document save would let a laptop save erase an afternoon logged on
   * the phone. Union by id on the client, so append-only data never collides. */
  const SESSIONS_DOC = PATHS.studyosSessions || 'dashboards/studyos_sessions';
  let _ssServerSeen = false;
  let _ssPending = null;
  let _ssTimer = null;
  const _ssRef = doc(db, SESSIONS_DOC);

  async function _ssDoSave() {
    if (!_ssPending) return;
    const payload = _ssPending;
    _ssPending = null;
    try {
      await setDoc(_ssRef, payload, { merge: false });
    } catch (e) {
      console.warn('[StudyOS Sessions] save failed:', e && e.code);
    }
  }

  window._fbSaveSessions = (list) => {
    _ssPending = { sessions: list || [], savedAt: Date.now() };
    if (_ssTimer) clearTimeout(_ssTimer);
    _ssTimer = setTimeout(() => {
      // Same stale-overwrite guard as everywhere else: never write before this
      // session has confirmed real server state, or a cold start would push an
      // empty log over another device's history.
      if (_ssServerSeen) _ssDoSave();
    }, NOTES_SAVE_DEBOUNCE_MS);
  };

  window._fbLoadSessions = async () => {
    try {
      const snap = await _freshGet(_ssRef);
      // Unlocking also flushes a save that was held while locked; without it a
      // session logged before the server answered waited for the NEXT save.
      const unlock = () => { if (_ssServerSeen) return; _ssServerSeen = true; if (_ssPending) _ssDoSave(); };
      if (snap && snap.metadata && snap.metadata.fromCache === false) unlock();
      if (_ssUnsub) return _ssLoadResult(snap);
      _ssUnsub = onSnapshot(_ssRef, { includeMetadataChanges: false }, (s) => {
        if (s.metadata && s.metadata.fromCache === false) unlock();
        if (!s.exists() || (s.metadata && s.metadata.hasPendingWrites)) return;
        const d = s.data() || {};
        window.dispatchEvent(new CustomEvent('fb-sessions-remote', {
          detail: { sessions: Array.isArray(d.sessions) ? d.sessions : [] },
        }));
      }, (err) => console.warn('[StudyOS Sessions] onSnapshot error:', err && err.code));
      return _ssLoadResult(snap);
    } catch (e) {
      console.warn('[StudyOS Sessions] load failed:', e && e.code);
      return null;
    }
  };
  let _ssUnsub = null;     // one listener, however often the log is (re)loaded
  function _ssLoadResult(snap) {
    if (snap && snap.exists()) {
      const d = snap.data() || {};
      return Array.isArray(d.sessions) ? d.sessions : [];
    }
    // An absent log is a legitimate empty state only when the SERVER said so;
    // a cache miss proves nothing (same rule as _fbLoadDoc below).
    if (snap && snap.metadata && snap.metadata.fromCache === false && !_ssServerSeen) {
      _ssServerSeen = true; if (_ssPending) _ssDoSave();
    }
    return snap ? [] : null;
  }

  /* ══ Generic synced documents ════════════════════════════════════════════
   * Topic breakdowns (studyos_topics/{fileId}) need exactly what cards and
   * sessions already have — their own document, a debounced whole-doc write,
   * and the never-write-before-server-seen guard — so they share ONE
   * implementation keyed by path instead of another bespoke copy of the block
   * above. Merging is the caller's job (the store keeps each topic's newest
   * updatedAt), which is what makes a whole-doc write safe here: every write
   * already contains everything this device has seen.
   *
   * `path` is a document path: 'collection/id' or 'dashboards/name'. */
  const _gdSeen = {};
  const _gdPendingPayload = {};
  const _gdTimers = {};
  const _gdUnsub = {};
  const _gdRef = (path) => doc(db, ...String(path).split('/'));

  function _gdMarkSeen(path) {
    if (_gdSeen[path]) return;
    _gdSeen[path] = true;
    // A write that arrived before the server was confirmed was HELD, not
    // dropped — flush it now.
    if (_gdPendingPayload[path]) _gdDoSave(path);
  }

  async function _gdDoSave(path) {
    const payload = _gdPendingPayload[path];
    if (!payload || !_gdSeen[path]) return;
    delete _gdPendingPayload[path];
    try { await setDoc(_gdRef(path), payload, { merge: false }); }
    catch (e) { console.warn('[StudyOS Doc] save failed:', path, e && e.code); }
  }

  function _gdWatch(path) {
    if (_gdUnsub[path]) return;
    _gdUnsub[path] = onSnapshot(_gdRef(path), { includeMetadataChanges: false }, (snap) => {
      if (snap.metadata && snap.metadata.fromCache === false) _gdMarkSeen(path);
      if (!snap.exists() || (snap.metadata && snap.metadata.hasPendingWrites)) return;
      window.dispatchEvent(new CustomEvent('fb-doc-remote', { detail: { path, data: snap.data() || {} } }));
    }, (err) => console.warn('[StudyOS Doc] onSnapshot error:', path, err && err.code));
  }

  window._fbSaveDoc = (path, payload) => {
    if (!path) return;
    _gdPendingPayload[path] = { ...(payload || {}), savedAt: Date.now() };
    if (_gdTimers[path]) clearTimeout(_gdTimers[path]);
    _gdTimers[path] = setTimeout(() => _gdDoSave(path), NOTES_SAVE_DEBOUNCE_MS);
  };

  /** Resolves to the document's data, {} when it does not exist yet, or null
   *  when the read failed (offline) — callers must not treat null as empty. */
  window._fbLoadDoc = async (path) => {
    if (!path) return null;
    _gdWatch(path);
    try {
      const snap = await _freshGet(_gdRef(path));
      if (snap && snap.metadata && snap.metadata.fromCache === false) _gdMarkSeen(path);
      if (snap && snap.exists()) return snap.data() || {};
      // Absent is only a legitimate empty state when the SERVER said so (marked
      // above). _freshGet can fall back to the cache, and a cache miss proves
      // nothing — unblocking writes on it would let a cold offline start push
      // an empty store over another device's data.
      return snap ? {} : null;
    } catch (e) {
      console.warn('[StudyOS Doc] load failed:', path, e && e.code);
      return null;
    }
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

  /* ══ Shield program inventory ════════════════════════════════════════════
   * Read-only, on demand. The Shield desktop agent enumerates the programs
   * installed on a PC and publishes them here (see shield.html
   * _pushShieldApps); StudyOS reads them to populate the Browse picker in the
   * Add Resource dialog.
   *
   * This exists because a browser genuinely cannot do the job itself: there is
   * no API to list installed applications, and <input type="file"> reports
   * C:\fakepath\x.exe rather than the real path, so a resource built from one
   * would save a path that launches nothing. Shield already knows the real
   * paths, so the picker borrows its answer.
   *
   * FETCHED, not subscribed, and only when the picker is opened: this changes
   * when software is installed, which is rare, and a standing listener would
   * cost a concurrent-listener slot on every device for a dialog most sessions
   * never open. */
  const SOS_SHIELD_APPS = PATHS.shieldApps || 'dashboards/studyos_shield_apps';
  window._fbLoadShieldApps = async () => {
    try {
      const snap = await getDoc(doc(db, SOS_SHIELD_APPS));
      if (snap && snap.exists()) return (snap.data() || {}).devices || {};
    } catch (e) { console.warn('[StudyOS] Shield app list load failed:', e); }
    return null;
  };

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
