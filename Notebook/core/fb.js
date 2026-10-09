/* Notebook — the journals' Firestore layer. Phase 1 holds the two thin
   document accessors the engines use (window._fbViz for VizEngine boards,
   window._fbOJ for OurJournal); the rest of the journal Firebase code follows
   in later phases (docs/Notebook/plan.md).

   THE HOST INSTALLS THEM. Both accessors double as "Firebase is ready" signals
   (VizEngine's fbReady(), OJ's fb()), so they must not exist before the host's
   Firestore does. The host calls Notebook.fb.install(api) from its own init(),
   and again after every re-init, with:
     db()            the CURRENT Firestore instance (a getter: a teardown swaps it)
     doc, getDoc, setDoc, deleteDoc, deleteField, onSnapshot   from the SDK
     writeRetry(fn, label)   the host's transient-failure retry
     byteSize(obj), maxWriteBytes   the write-size guard
     a1b(path, data)         the A1Backup tap
     imgGet(ref)             cache-first read for image documents */
(function () {
'use strict';
window.Notebook.fb = {
  install: function (F) {
    const db = F.db, doc = F.doc, getDoc = F.getDoc, setDoc = F.setDoc, deleteDoc = F.deleteDoc,
      deleteField = F.deleteField, onSnapshot = F.onSnapshot, _fbWriteRetry = F.writeRetry,
      _fbByteSize = F.byteSize, FB_MAX_WRITE_BYTES = F.maxWriteBytes, _a1b = F.a1b, _jImgGet = F.imgGet;

    /* ── Viz boards (Whiteboard / Mind Map) — generic document access ─────────
     *
     * The visual templates keep each board in its own dashboards/ document
     * (see core/viz.js for the layout and why). All they need from here is
     * get / set / watch on one document id, plus the same transient-failure
     * retry every other write gets. The engine owns the chunking, the debounce
     * and the offline queue; this stays a thin accessor so there is exactly one
     * Firestore setup in the app.
     *
     * Writes are BOUNDED BY CONSTRUCTION: the engine never hands over more than
     * one chunk at a time and sizes chunks in UTF-8 bytes, so the size guard
     * here is a backstop against a bug, not the mechanism. A refusal is loud —
     * a board that silently stops syncing is the failure this codebase has
     * already paid for once. */
    const _vizWatch = {};
    window._fbViz = {
      get: async (id) => {
        const snap = await getDoc(doc(db(), 'dashboards', id));
        return snap.exists() ? snap.data() : null;
      },
      set: (id, payload) => {
        const bytes = _fbByteSize(payload);
        if (bytes > FB_MAX_WRITE_BYTES) {
          const msg = 'A board chunk came out at ' + Math.round(bytes / 1024) + ' KB, over the '
            + Math.round(FB_MAX_WRITE_BYTES / 1024) + ' KB document limit. It is saved on this device but NOT in the cloud.';
          console.error('[viz] ' + msg);
          if (window._fbSyncAlert) window._fbSyncAlert('Board sync', msg);
          return Promise.reject(new Error('viz-chunk-too-large'));
        }
        return _fbWriteRetry(() => setDoc(doc(db(), 'dashboards', id), payload), 'viz ' + id)
          .then((r) => {
            // Feed the board into the local backup vault. Every other document
            // reaches it from a listener that was already running; a board has
            // no listener on the writing device, so it is handed over here —
            // still at zero extra Firestore reads, because we just wrote it.
            // SCENE documents only: the image documents beside them can be
            // megabytes each and would be re-hashed on every capture, and they
            // are already durable in Firestore and cached in IndexedDB here.
            if (id.indexOf('_viz_') > 0) _a1b('dashboards/' + id, payload);
            return r;
          });
      },
      // One listener per key, replacing whatever that key held. Navigating
      // between boards therefore cannot stack listeners the way an unkeyed
      // onSnapshot would.
      watch: (key, id, cb) => {
        if (_vizWatch[key]) { try { _vizWatch[key](); } catch (e) {} delete _vizWatch[key]; }
        const un = onSnapshot(doc(db(), 'dashboards', id),
          (snap) => { if (snap.exists()) cb(snap.data()); },
          (e) => console.warn('[viz] watch failed:', e && (e.code || e.message)));
        _vizWatch[key] = un;
        return () => { try { un(); } catch (e) {} if (_vizWatch[key] === un) delete _vizWatch[key]; };
      }
    };

    /* ── OurJournal — thin document access for the OJ engine ──────────────
     * The engine (window.OJ, core/oj.js) owns the model: an index of
     * metadata, one content document per entry, merge + throttle + echo
     * detection. This only reads, writes and listens, through the same retry
     * as every other write. Re-installed on every host init(); the listeners
     * die with the old client on teardown and the engine re-attaches them on
     * the fb-ready that follows. */
    window._fbOJ = {
      // Only used for image documents, which never change under their key —
      // so the local cache is always current and saves a billed read.
      get: async (id) => {
        const snap = await _jImgGet(doc(db(), 'dashboards', id));
        return snap.exists() ? snap.data() : null;
      },
      set: (id, payload) => {
        const bytes = _fbByteSize(payload);
        if (bytes > FB_MAX_WRITE_BYTES) return Promise.reject(new Error('oj-too-large'));
        return _fbWriteRetry(() => setDoc(doc(db(), 'dashboards', id), payload), 'OJ ' + id);
      },
      // Field-level merge: only the entries (and fields) named are touched, so
      // two people changing two different entries never overwrite each other.
      merge: (id, payload) => _fbWriteRetry(() => setDoc(doc(db(), 'dashboards', id), payload, { merge: true }), 'OJ index'),
      remove: (id) => _fbWriteRetry(() => deleteDoc(doc(db(), 'dashboards', id)), 'OJ delete'),
      del: () => deleteField(),
      watch: (id, cb) => onSnapshot(doc(db(), 'dashboards', id), { includeMetadataChanges: true }, (snap) => {
        const md = snap.metadata || {};
        const exists = snap.exists();
        const data = exists ? snap.data() : null;
        if (exists && !md.fromCache && !md.hasPendingWrites) _a1b('dashboards/' + id, data);
        cb({ exists, data, fromCache: !!md.fromCache, pending: !!md.hasPendingWrites });
      }, (e) => console.warn('[OJ] watch failed:', id, e && (e.code || e.message)))
    };
  }
};
})();
