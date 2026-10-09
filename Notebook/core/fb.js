/* Notebook — the journals' Firestore layer (both journals' load/save/flush/order/
   delete/listen, the stale-overwrite guards, image documents, AI prompt/tools
   docs) and the two thin accessors the engines use (window._fbViz for
   VizEngine boards, window._fbOJ for OurJournal). docs/Notebook/plan.md.

   THE HOST INSTALLS IT. Everything here doubles as "Firebase is ready" (the
   loaders, VizEngine's fbReady(), OJ's fb()), so none of it may exist before
   the host's Firestore does. The host calls Notebook.fb.install(F) from its
   own init(), and again after every re-init, with:
     db()            the CURRENT Firestore instance (a getter: a teardown swaps it)
     doc, getDoc, getDocFromCache, setDoc, updateDoc, deleteDoc, deleteField,
     onSnapshot      from the SDK
     writeRetry(fn, label), upsert(ref, payload, label)   the host's retrying writes
     byteSize(obj), maxWriteBytes   the write-size guard
     a1b(path, data)         the A1Backup tap
     freshGet(ref), isServerSnap(snap)   server-confirmed reads
     watchStall(key, label, isSeen), stopStall(key), stallRetry   the stall popup
   On its teardown the host calls Notebook.fb.unsubscribe() where it drops its
   listeners, and Notebook.fb.rearm() where it re-arms its server-seen guards. */
(function () {
'use strict';

// The host's Firestore and helpers, as of the last install().
let _H = null;
const db = () => _H.db();
let doc, getDoc, getDocFromCache, setDoc, updateDoc, deleteDoc, deleteField, onSnapshot,
  _fbWriteRetry, _fbUpsert, _fbByteSize, FB_MAX_WRITE_BYTES, _a1b, _freshGet, _fbIsServerSnap,
  _fbWatchStall, _fbStopStall, _stallRetry;

// ── State that outlives a re-init (it lived at index.html's module level) ──
  const BJ_DOC_PATH   = "dashboards/journal";
  const TJ_DOC_PATH   = "dashboards/tony_journal";
  let _bjSaveTimer   = null;
  let _tjSaveTimer   = null;
  let _bjUnsubscribe  = null;
  let _tjUnsubscribe  = null;
  let _bjLastOwnSaveAt   = 0;
  let _bjLastWrittenSavedAt = 0;   // exact savedAt value we wrote — used to skip own-echo in onSnapshot
  let _tjLastOwnSaveAt   = 0;
  let _tjLastWrittenSavedAt = 0;   // same pattern for TonyJournal

  // ── Stale-overwrite guard for the two journals (MyJournal=tj, Brainstorm=bj) ──
  // ROOT CAUSE this fixes: on a hard refresh where the server read times out, the
  // loader used to fall back to the stale IndexedDB cache, show an OLD version, and
  // then let the debounced autosave write that OLD version back over the newer
  // server copy — permanently destroying progress.
  //
  // GUARANTEE: a session may NOT write to Firestore until it has confirmed the real
  // server state at least once (a live snapshot with metadata.fromCache === false,
  // OR a loader read that came straight from the server). Until then every save is
  // QUEUED (never dropped) and flushed only AFTER the incoming server data has been
  // merged — so a stale-cache-only session can never clobber fresh remote data, and
  // no genuine local edit is ever lost.
  let _bjServerSeen = false, _bjPendingWrites = [], _bjLastAppliedSavedAt = 0;
  let _tjServerSeen = false, _tjPendingWrites = [], _tjLastAppliedSavedAt = 0;
  function _bjMarkServerSeen() {
    if (_bjServerSeen) return;
    _bjServerSeen = true;
    _fbStopStall('journal');
    const q = _bjPendingWrites; _bjPendingWrites = [];
    q.forEach(fn => { try { fn(); } catch(e) { console.warn('BJ deferred write failed:', e && e.message); } });
  }
  function _bjWhenServerSeen(fn) {
    if (_bjServerSeen) return fn();
    // Dedupe identical refs (the debounced _bjDoSave) so a long offline session can't
    // grow this queue without bound; distinct closures (order/entry/delete) still queue.
    if (_bjPendingWrites.indexOf(fn) === -1) _bjPendingWrites.push(fn);
    _fbWatchStall('journal', 'Brainstorm Journal', () => _bjServerSeen);
    return Promise.resolve();
  }
  function _tjMarkServerSeen() {
    if (_tjServerSeen) return;
    _tjServerSeen = true;
    _fbStopStall('tony_journal');
    const q = _tjPendingWrites; _tjPendingWrites = [];
    q.forEach(fn => { try { fn(); } catch(e) { console.warn('TJ deferred write failed:', e && e.message); } });
  }
  function _tjWhenServerSeen(fn) {
    if (_tjServerSeen) return fn();
    // Dedupe identical refs (the debounced _tjDoSave) so a long offline session can't
    // grow this queue without bound; distinct closures (order/entry/delete) still queue.
    if (_tjPendingWrites.indexOf(fn) === -1) _tjPendingWrites.push(fn);
    _fbWatchStall('tony_journal', 'MyJournal', () => _tjServerSeen);
    return Promise.resolve();
  }

// ── The boards' and OurJournal's document accessors ──
function installAccessors(F) {
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

function install(F) {
  _H = F;
  doc = F.doc; getDoc = F.getDoc; getDocFromCache = F.getDocFromCache; setDoc = F.setDoc;
  updateDoc = F.updateDoc; deleteDoc = F.deleteDoc; deleteField = F.deleteField; onSnapshot = F.onSnapshot;
  _fbWriteRetry = F.writeRetry; _fbUpsert = F.upsert; _fbByteSize = F.byteSize; FB_MAX_WRITE_BYTES = F.maxWriteBytes;
  _a1b = F.a1b; _freshGet = F.freshGet; _fbIsServerSnap = F.isServerSnap;
  _fbWatchStall = F.watchStall; _fbStopStall = F.stopStall; _stallRetry = F.stallRetry;

    // ── Brainstorm Journal ─────────────────────────────────────────────────────
    // COLLAB ARCHITECTURE: each entry is stored as a separate field "e_{entryId}"
    // in the single journal doc. updateDoc merges at the field level — Device A
    // writing entry X never touches entry Y that Device B is editing. True collab,
    // no overwrite collisions, exactly like Google Docs per-document isolation.
    const bjDocRef = doc(db(), BJ_DOC_PATH);
    _stallRetry['journal'] = async () => { const sn = await _freshGet(bjDocRef); if (_fbIsServerSnap(sn)) _bjMarkServerSeen(); };

    // Helper: deep-sanitize object (remove null/undefined for Firestore)
    const _bjSanitize = (v) => {
      if (Array.isArray(v)) return v.map(_bjSanitize);
      if (v && typeof v === 'object') {
        const o = {};
        Object.entries(v).forEach(([k,val]) => {
          if (val !== undefined && val !== null) o[k] = _bjSanitize(val);
        });
        return o;
      }
      return v;
    };

    // ── Journal image documents: upload once, read from cache ──────────────
    // The extractors run on EVERY save of a page, and every image on the page
    // used to be re-uploaded each time — one Firestore write per image per
    // autosave, for bytes the cloud already had. An image document never
    // changes under its key, so a key already confirmed with these exact bytes
    // is simply pointed at. Reads go to Firestore's own IndexedDB cache first
    // (free, and always current for a document that never changes) instead of
    // a billed server read on every open of every page.
    const _jImgSent = new Map();   // imgKey → signature of the bytes the cloud holds
    const _jImgSig = (src) => {
      let h = 0; const step = Math.max(1, Math.floor(src.length / 1024));
      for (let i = 0; i < src.length; i += step) h = (Math.imul(31, h) + src.charCodeAt(i)) | 0;
      return src.length + ':' + h;
    };
    const _jImgSeen = (key, src) => _jImgSent.get(key) === _jImgSig(src);
    const _jImgMark = (key, src) => { if (key && src) _jImgSent.set(key, _jImgSig(src)); };
    const _jImgGet = async (ref) => {
      try {
        const c = await getDocFromCache(ref);
        if (c && c.exists() && c.data().img) { _jImgMark(ref.id, c.data().img); return c; }
      } catch (e) { /* not cached yet */ }
      const snap = await getDoc(ref);
      if (snap && snap.exists() && snap.data().img) _jImgMark(ref.id, snap.data().img);
      return snap;
    };

    // Extract inline data: images from an HTML string into their own docs. The
    // bj-fbimg:// placeholder is written ONLY after the image is confirmed saved
    // (with retry); if the upload ultimately fails the inline data URI is kept so a
    // pasted screenshot is never silently lost.
    const _bjExtractHtmlImages = async (html, e) => {
      // A <template> is inert: unlike a detached <div>, assigning innerHTML
      // does not make the browser try to fetch every src it finds — which is
      // what produced ERR_UNKNOWN_URL_SCHEME for our own placeholders.
      const div = document.createElement('template');
      div.innerHTML = html;
      // src OR href. The journals hold images in both, and only src was ever
      // looked at — so an entry whose images lived in href stayed inline
      // forever. The rehydrator below restores whichever attribute was used.
      const imgs = Array.from(div.content.querySelectorAll('[src],[href]'));
      await Promise.all(imgs.map(async (img) => {
        const attr = (img.getAttribute('src') || '').startsWith('data:') ? 'src'
                   : (img.getAttribute('href') || '').startsWith('data:') ? 'href' : '';
        if (!attr) return;
        const src = img.getAttribute(attr) || '';
        // Leave trivial ones alone: a separate document plus a fetch to save a
        // few hundred bytes is a worse trade than leaving it in place.
        if (src.length < 2048) return;
        let imgKey = img.getAttribute('data-bjkey') || '';
        if (!imgKey) {
          let h = 0;
          const step = Math.max(1, Math.floor(src.length / 512));
          for (let i = 0; i < src.length; i += step) { h = (Math.imul(31, h) + src.charCodeAt(i)) | 0; }
          h = (Math.imul(31, h) + src.length) | 0;
          imgKey = 'journal_img_' + e.id + '_' + Math.abs(h).toString(36);
        }
        const imgRef = doc(db(), 'dashboards', imgKey);
        // Already in the cloud with these exact bytes: point at it, no write.
        if (typeof _jImgSeen === 'function' && _jImgSeen(imgKey, src)) {
          img.setAttribute('data-bjkey', imgKey);
          img.setAttribute(attr, 'bj-fbimg://' + imgKey);
          return;
        }
        try {
          await _fbWriteRetry(() => setDoc(imgRef, { img: src, savedAt: Date.now() }), 'BJ img ' + imgKey);
          if (typeof _jImgMark === 'function') _jImgMark(imgKey, src);
          img.setAttribute('data-bjkey', imgKey);
          img.setAttribute(attr, 'bj-fbimg://' + imgKey);
        } catch(err) {
          console.warn('BJ image upload failed, keeping inline:', imgKey, err.message);
        }
      }));
      return div.innerHTML;
    };

    // Helper: strip canvas + extract inline images from a single entry before saving
    // Local-only sync bookkeeping, stripped before anything is published: _dirty is
    // THIS device's "not uploaded yet" mark and _fbPushed its "seen on the server"
    // mark. Shipping either would hand another device our sync state as if it were
    // its own — a receiver would think its copy was already safe, or refuse to let
    // the server correct it.
    const _bjStripLocal = (e) => { const o = Object.assign({}, e); delete o._dirty; delete o._fbPushed; return o; };
    const _bjStripEntry = async (e0) => {
      const e = _bjStripLocal(e0);
      if (e.template === 'whiteboard') {
        const { canvas, history, ...rest } = (e.data || {});
        return { entry: { ...e, data: rest }, imageUploadPromises: [] };
      }
      if (e.template === 'page' && e.data && e.data.html) {
        const html = await _bjExtractHtmlImages(e.data.html, e);
        return { entry: { ...e, data: { ...e.data, html } }, imageUploadPromises: [] };
      }
      if (e.template === 'journal-entries' && e.data && e.data.dates) {
        const strippedDates = {};
        for (const [dateKey, dateData] of Object.entries(e.data.dates)) {
          if (!dateData || !dateData.html) { strippedDates[dateKey] = dateData || { html: '' }; continue; }
          strippedDates[dateKey] = { ...dateData, html: await _bjExtractHtmlImages(dateData.html, e) };
        }
        return { entry: { ...e, data: { ...e.data, dates: strippedDates } }, imageUploadPromises: [] };
      }
      return { entry: e, imageUploadPromises: [] };
    };

    // Load: reconstruct entries[] from flat "e_{id}" fields + legacy "entries" array
    window._fbLoadJournal = async () => {
      try {
        const snap = await _freshGet(bjDocRef);
        // A server-sourced read confirms the true remote state → writes are now safe.
        if (snap && snap.metadata && !snap.metadata.fromCache) _bjMarkServerSeen();
        if (!snap || !snap.exists()) return null;
        const data = snap.data();
        // New per-entry field format
        const entries = [];
        Object.entries(data).forEach(([k, v]) => {
          if (k.startsWith('e_') && v && typeof v === 'object' && v.id) entries.push(v);
        });
        if (entries.length > 0) {
          // Use explicit _order array if saved, else fall back to created-desc sort
          if (Array.isArray(data._order) && data._order.length > 0) {
            const orderMap = {}; data._order.forEach((id, i) => { orderMap[id] = i; });
            entries.sort((a, b) => {
              const ia = orderMap[a.id] != null ? orderMap[a.id] : 9999;
              const ib = orderMap[b.id] != null ? orderMap[b.id] : 9999;
              return ia !== ib ? ia - ib : (b.created || 0) - (a.created || 0);
            });
          } else {
            entries.sort((a, b) => (b.created || 0) - (a.created || 0));
          }
          return { entries, activeId: data.activeId || null, _legacy: false };
        }
        // Legacy shape: one `entries` array and no e_* fields at all.
        if (Array.isArray(data.entries) && data.entries.length > 0) return Object.assign({}, data, { _legacy: true });
        return null;
      } catch(e) {
        console.warn("Firebase Journal load failed:", e);
        return null;
      }
    };

    // Save: write active entry + _order array + activeId.
    // Refactored to be FLUSHABLE: the pending getState is stored on a module var so a
    // synchronous flush (entry switch / tab hide / navigate away) can persist it
    // immediately instead of waiting out the 300ms debounce — which previously dropped
    // the write entirely if the page unloaded or the active entry changed first.
    let _bjPendingGetState = null;
    let _bjSaveInFlight = null;
    // SERIALISED. Two overlapping writes of the same whole entry are a race: if they
    // land out of order the OLDER payload wins and the newest keystrokes are gone.
    // A save requested while one is still crossing the network is CHAINED behind it
    // instead — and because the chained link reads _bjPendingGetState fresh when it
    // finally runs, it carries the latest state rather than a stale snapshot.
    const _bjDoSave = () => {
      if (_bjSaveInFlight) {
        _bjSaveInFlight = _bjSaveInFlight.then(_bjRunSave, _bjRunSave);
        return _bjSaveInFlight;
      }
      return _bjRunSave();
    };
    const _bjRunSave = async () => {
      if (!_bjPendingGetState) return _bjSaveInFlight || undefined;
      const getState = _bjPendingGetState; _bjPendingGetState = null;
      _bjSaveInFlight = (async () => {
        try {
          const { entries, activeId } = getState();
          const activeEntry = entries.find(e => e.id === activeId);
          if (!activeEntry) return;

          const { entry: stripped, imageUploadPromises } = await _bjStripEntry(activeEntry);
          const sanitized = _bjSanitize(stripped);

          await Promise.all(imageUploadPromises);

          // Write active entry field + _order (full entry ID list) + activeId + savedAt
          const fieldKey = 'e_' + activeEntry.id;
          const _order = entries.map(e => e.id);
          const _bjSavedAt = Date.now();
          _bjLastOwnSaveAt = _bjSavedAt;
          _bjLastWrittenSavedAt = _bjSavedAt;
          await _fbUpsert(bjDocRef, { [fieldKey]: sanitized, _order, activeId, savedAt: _bjSavedAt }, 'BJ save');
          _bjLastOwnSaveAt = Date.now();
          // Names the entry — see the MyJournal twin: the UI clears that entry's
          // _dirty mark on this event.
          window.dispatchEvent(new CustomEvent("fb-bj-saved", { detail: { id: activeEntry.id } }));
        } catch(e) {
          console.error("Firebase Journal save failed:", e.code, e.message, e);
          window.dispatchEvent(new CustomEvent("fb-bj-error"));
        } finally { _bjSaveInFlight = null; }
      })();
      return _bjSaveInFlight;
    };
    window._fbSaveJournal = (getState) => {
      _bjPendingGetState = getState;
      if (_bjSaveTimer) clearTimeout(_bjSaveTimer);
      // Gate the actual write on server-confirmation. If the server hasn't been seen
      // yet the edit stays in _bjPendingGetState and is flushed the moment it is —
      // never written blind over data we haven't reconciled with.
      _bjSaveTimer = setTimeout(() => _bjWhenServerSeen(_bjDoSave), 300);
    };
    // Flush any pending BJ save NOW (returns the write promise). Called before an entry
    // switch and on tab-hide/navigate so an in-progress edit is never lost to the debounce.
    window._fbFlushJournal = () => { if (_bjSaveTimer) { clearTimeout(_bjSaveTimer); _bjSaveTimer = null; } return _bjWhenServerSeen(_bjDoSave); };

    // Dedicated order-only save (called on drag reorder — no active entry content needed)
    window._fbSaveJournalOrder = (entries) => _bjWhenServerSeen(() => {
      const _order = entries.map(e => e.id);
      const _bjOrdTs = Date.now();
      _bjLastOwnSaveAt = _bjOrdTs;
      _bjLastWrittenSavedAt = _bjOrdTs;
      return _fbUpsert(bjDocRef, { _order, savedAt: _bjOrdTs }, 'BJ order')
        .catch(err => console.warn('BJ order save failed:', err.message));
    });

    // Save ONE specific entry's field immediately (used for trash/restore of a
    // non-active entry — the debounced _fbSaveJournal only writes the active one).
    window._fbSaveJournalEntry = (entry, allEntries) => _bjWhenServerSeen(async () => {
      if (!entry || !entry.id) return;
      try {
        const { entry: stripped, imageUploadPromises } = await _bjStripEntry(entry);
        const sanitized = _bjSanitize(stripped);
        await Promise.all(imageUploadPromises || []);
        const _ts = Date.now();
        _bjLastOwnSaveAt = _ts; _bjLastWrittenSavedAt = _ts;
        const payload = { ['e_' + entry.id]: sanitized, savedAt: _ts };
        if (Array.isArray(allEntries)) payload._order = allEntries.map(e => e.id);
        await _fbUpsert(bjDocRef, payload, 'BJ save-one');
        window.dispatchEvent(new CustomEvent('fb-bj-saved', { detail: { id: entry.id } }));
      } catch(e) { console.warn('BJ save-one failed:', e.message); }
    });

    /* ── Image compaction ──────────────────────────────────────────────────
     *
     * Measured 2026-09-01: dashboards/journal is 700 KB, which is 78% of the
     * 900 KB ceiling where _guardedWrite refuses EVERY save and the journal
     * silently stops syncing. Almost all of it is a handful of base64 images
     * still inline in entry HTML — one entry alone is 468 KB. They compress at
     * 2.1x, because base64 of an already-compressed image barely compresses.
     *
     * _bjExtractHtmlImages moves an inline image into its own document and
     * leaves a bj-fbimg:// placeholder, which the rehydrator swaps back for
     * display. It runs on every save, so anything pasted today is already
     * handled; these entries predate it or arrived by another route.
     *
     * So this does not extract anything itself — it re-saves the affected
     * entries through the SAME path a normal edit takes. Reusing the shipped
     * extractor matters: it only replaces the src once the image document is
     * CONFIRMED written, and keeps the inline copy if that write fails. A
     * failed run therefore shrinks nothing and loses nothing.
     *
     * One entry field is written at a time, and `_order` is deliberately never
     * touched — republishing a stale order is its own known way to lose a
     * journal's entry list.
     * ==================================================================== */
    const _IMG_URI_RE = /data:[a-z]+\/[a-z0-9.+-]+;base64,/i;

    // Where a data: URI survived extraction, so we know whether the extractor
    // needs widening. It only handles <img src="data:...">, so an image can
    // legitimately remain in a style attribute, a srcset, or an SVG <image>.
    //
    // Scans the HTML strings directly rather than the JSON of the entry: in
    // JSON every quote is escaped as \" and an attribute pattern never matches.
    // Reports attribute NAMES and counts only — never any content.
    function _htmlStringsOf(entry) {
      const out = [];
      const d = (entry && entry.data) || {};
      if (typeof d.html === 'string') out.push(d.html);
      if (d.dates && typeof d.dates === 'object') {
        Object.keys(d.dates).forEach((k) => {
          const v = d.dates[k];
          if (v && typeof v.html === 'string') out.push(v.html);
        });
      }
      return out;
    }

    function _describeRemainingImages(entry) {
      try {
        const forms = {};
        let total = 0;
        _htmlStringsOf(entry).forEach((html) => {
          let i = 0;
          for (;;) {
            const at = html.indexOf('data:', i);
            if (at < 0) break;
            i = at + 5;
            if (!/^[a-z]+\/[a-z0-9.+-]+;base64,/i.test(html.slice(at + 5, at + 45))) continue;
            total++;
            // Walk back to the nearest attribute name before this point.
            const before = html.slice(Math.max(0, at - 80), at);
            const m = before.match(/([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*["']?[^"'=]*$/);
            const name = m ? m[1].toLowerCase() : 'unknown';
            forms[name] = (forms[name] || 0) + 1;
          }
        });
        if (!total) return '';
        return Object.keys(forms).map((k) => k + ' x' + forms[k]).join(', ');
      } catch (e) { return ''; }
    }

    function _bytesOfDoc(d) {
      try { return new Blob([JSON.stringify(d || {})]).size; }
      catch (e) { try { return JSON.stringify(d || {}).length; } catch (_) { return 0; } }
    }

    async function _compactImages(cfg) {
      const { ref, label, stripEntry, sanitize, opts } = cfg;
      const o = opts || {};

      // Never rewrite someone's journal without a verified backup to fall back
      // on. This is the whole reason the backup went first.
      if (!o.force) {
        // Deliberately NOT health().ok — that reports true for a device with no
        // backup at all, so the watchdog does not nag people who never set one
        // up. As an interlock it would have waved through the exact case it
        // exists to stop. Ask for a real, recent snapshot instead.
        let st = null;
        try { st = window.A1Backup && (await window.A1Backup.status()); } catch (e) {}
        const haveBackup = !!(st && st.locked === false && st.lastSnapshot && !st.stale);
        if (!haveBackup) {
          const why = !st ? 'the backup system is not loaded'
            : st.locked ? 'no passphrase is set on this device'
            : !st.lastSnapshot ? 'nothing has been backed up yet'
            : 'the last backup is stale';
          console.warn('[Compact] ' + label + ': refusing — ' + why + '. This rewrites journal ' +
                       'entries, so it will not run without a verified backup to fall back on. ' +
                       'Call with { force: true } only if you accept that risk.');
          return { skipped: 'no verified backup: ' + why };
        }
      }

      const snap = await _freshGet(ref);
      if (!snap || !snap.exists()) return { skipped: 'no document' };
      const d = snap.data() || {};
      const before = _bytesOfDoc(d);

      const targets = Object.keys(d).filter((k) => {
        if (k.indexOf('e_') !== 0) return false;
        try { return _IMG_URI_RE.test(JSON.stringify(d[k])); } catch (e) { return false; }
      });

      if (!targets.length) {
        console.log('[Compact] ' + label + ': nothing inline to move; ' +
                    (before / 1024).toFixed(0) + ' KB.');
        return { moved: 0, before, after: before };
      }

      console.log('[Compact] ' + label + ': ' + (before / 1024).toFixed(0) + ' KB, ' +
                  targets.length + ' entr' + (targets.length === 1 ? 'y' : 'ies') +
                  ' with inline images. Moving them out…');

      let done = 0, failed = 0;
      for (const key of targets) {
        const id = key.slice(2);
        try {
          const wasBytes = _bytesOfDoc(d[key]);
          const { entry: stripped } = await stripEntry(d[key]);
          const clean = sanitize(stripped);
          const nowBytes = _bytesOfDoc(clean);

          // Judge by whether this HELPED, not by whether the result is
          // spotless. The extractor only handles <img src="data:...">, so an
          // entry can legitimately still hold a data: URI in a style
          // attribute, a srcset or an SVG <image> afterwards. Demanding a
          // perfectly clean entry threw away real, already-uploaded work and
          // left the images orphaned in Firestore having shrunk nothing.
          if (nowBytes >= wasBytes) {
            console.warn('  ' + id + ': nothing could be moved — left untouched (' +
                         (wasBytes / 1024).toFixed(0) + ' KB)');
            failed++;
            continue;
          }
          await _fbUpsert(ref, { [key]: clean, savedAt: Date.now() }, label + ' compact');
          done++;
          const left = _describeRemainingImages(clean);
          console.log('  ' + id + ': ' + (wasBytes / 1024).toFixed(0) + ' KB -> ' +
                      (nowBytes / 1024).toFixed(0) + ' KB' +
                      (left ? '   (still inline: ' + left + ')' : ''));
        } catch (e) {
          failed++;
          console.warn('  ' + id + ': failed — ' + (e && (e.message || e)));
        }
      }

      // Re-read rather than assume. The point of this is the document's real
      // size against the write guard, and only the server knows that.
      const after = _bytesOfDoc(((await _freshGet(ref)) || { data: () => ({}) }).data() || {});
      const pct = (n) => ((100 * n) / 921600).toFixed(0) + '% of the write guard';
      console.log('[Compact] ' + label + ': ' + (before / 1024).toFixed(0) + ' KB (' + pct(before) +
                  ')  ->  ' + (after / 1024).toFixed(0) + ' KB (' + pct(after) + ')' +
                  '   moved ' + done + (failed ? ', failed ' + failed : ''));
      return { moved: done, failed, before, after };
    }

    window._bjCompactImages = (opts) => _compactImages({
      ref: bjDocRef, label: 'Brainstorm Journal',
      stripEntry: _bjStripEntry, sanitize: _bjSanitize, opts
    });

    window._fbDeleteJournalEntry = (entryId) => _bjWhenServerSeen(async () => {
      try {
        const _delTs = Date.now();
        _bjLastOwnSaveAt = _delTs;
        _bjLastWrittenSavedAt = _delTs;
        await _fbWriteRetry(() => updateDoc(bjDocRef, { ["e_" + entryId]: deleteField(), savedAt: _delTs }), 'BJ delete');
      }
      catch(e) { if (e.code !== "not-found") console.warn("BJ delete failed:", e.message); }
    });

    // Migrate legacy data: write each entry as its own field, remove old entries[] array
    window._fbMigrateJournalIfNeeded = (legacyEntries) => _bjWhenServerSeen(async () => {
      if (!Array.isArray(legacyEntries) || legacyEntries.length === 0) return;
      try {
        const payload = { savedAt: Date.now() };
        for (const e of legacyEntries) {
          const { entry: stripped } = await _bjStripEntry(e);
          payload['e_' + e.id] = _bjSanitize(stripped);
        }
        // MERGE, never a bare setDoc. setDoc REPLACES the document, so this used to
        // delete _order and activeId and republish every entry from whatever this
        // device happened to have read — and when _freshGet had fallen back to the
        // IndexedDB cache, that was this device's stale copy overwriting the real one
        // for ALL entries at once. Combined with the boot-time trigger below firing
        // on every single page load, that is how a phone resurrected entries deleted
        // days ago and pushed week-old page content over the desktop's.
        await _fbWriteRetry(() => setDoc(bjDocRef, payload, { merge: true }), 'BJ migrate');
        console.log('BJ: migrated', legacyEntries.length, 'entries to per-entry field format');
      } catch(err) {
        console.warn('BJ migration failed:', err.message);
      }
    });

    // ── Rehydrate page HTML: replace bj-fbimg:// placeholders with actual data URIs ──────────────
    window._fbRehydratePageImages = async (html) => {
      if (!html || !html.includes('bj-fbimg://')) return html;
      // A <template> is inert: unlike a detached <div>, assigning innerHTML
      // does not make the browser try to fetch every src it finds — which is
      // what produced ERR_UNKNOWN_URL_SCHEME for our own placeholders.
      const div = document.createElement('template');
      div.innerHTML = html;
      // Must mirror the extractor exactly: it can place the placeholder in
      // src or href, and an attribute it fails to restore is a broken image
      // or a dead link for the reader.
      const imgs = Array.from(div.content.querySelectorAll(
        '[src^="bj-fbimg://"],[href^="bj-fbimg://"]'));
      await Promise.all(imgs.map(async (img) => {
        const attr = (img.getAttribute('src') || '').indexOf('bj-fbimg://') === 0 ? 'src' : 'href';
        const imgKey = img.getAttribute(attr).replace('bj-fbimg://', '');
        try {
          const imgRef = doc(db(), 'dashboards', imgKey);
          const snap = await (typeof _jImgGet === 'function' ? _jImgGet(imgRef) : getDoc(imgRef));
          if (snap.exists() && snap.data().img) {
            img.setAttribute(attr, snap.data().img);
          }
        } catch(err) {
          console.warn('BJ image rehydrate failed:', imgKey, err.message);
        }
      }));
      return div.innerHTML;
    };


    // Turn a journal document into the detail the UI merge expects. Shared by the
    // live listener and the authoritative resync below so the two can never drift.
    const _bjBuildRemote = (data, authoritative) => {
      const entries = [];
      const _allPresentIds = [];
      Object.entries(data).forEach(([k, v]) => {
        if (k.startsWith('e_')) {
          _allPresentIds.push(k.slice(2));
          if (v && typeof v === 'object' && v.id) entries.push(v);
        }
      });
      if (Array.isArray(data._order) && data._order.length > 0) {
        const orderMap = {}; data._order.forEach((id, i) => { orderMap[id] = i; });
        entries.sort((a, b) => {
          const ia = orderMap[a.id] != null ? orderMap[a.id] : 9999;
          const ib = orderMap[b.id] != null ? orderMap[b.id] : 9999;
          return ia !== ib ? ia - ib : (b.created || 0) - (a.created || 0);
        });
      } else {
        entries.sort((a, b) => (b.created || 0) - (a.created || 0));
      }
      return { entries, activeId: data.activeId || null, _order: data._order || null,
               _fbHasData: true, _allPresentIds, _authoritative: !!authoritative };
    };

    /* ── Server-authoritative resync ───────────────────────────────────────────
     * The live listener alone is not enough, and this is why "the phone shows a
     * week-old page, and entries I deleted days ago are back" happens:
     *
     *   - onSnapshot is served from the IndexedDB cache FIRST, so on a phone that
     *     has been backgrounded for days the cached copy is what paints;
     *   - the merge that follows is a defensive, per-entry last-write-wins on a
     *     DEVICE WALL CLOCK, so a local copy carrying a newer `updated` rejects the
     *     real server content the moment it arrives — and permanently, because
     *     nothing ever lowers that number again;
     *   - and the loader that does a forced server read only ran ONCE per page
     *     load, so re-opening the app after a teardown re-read nothing at all.
     *
     * This is the other half: a FORCED server read applied as the TRUTH — content,
     * deletions and order all come from the server, and the only thing kept from
     * this device is an entry it has edited but not yet uploaded (entry._dirty).
     * Run on open, on resume and on reconnect, it makes a journal that has not been
     * opened here in a week show the current state instead of this device's memory
     * of it. Cost is one document read per open — the read the page already did at
     * boot, no longer only at boot. */
    window._fbResyncJournal = async () => {
      try {
        const snap = await _freshGet(bjDocRef);
        if (!snap) return false;
        // _freshGet falls back to the CACHE when the server is unreachable, and a
        // cached read must never authorise itself — that is exactly the stale copy
        // this is here to correct.
        const fromServer = !!(snap.metadata && !snap.metadata.fromCache);
        if (fromServer) _bjMarkServerSeen();
        if (!snap.exists()) return false;
        const data = snap.data();
        _bjLastAppliedSavedAt = data.savedAt || 0;
        window.dispatchEvent(new CustomEvent('fb-bj-remote-update', { detail: _bjBuildRemote(data, fromServer) }));
        window.dispatchEvent(new CustomEvent('fb-bj-synced'));
        return fromServer;
      } catch (e) { console.warn('Journal resync failed:', e && e.message); return false; }
    };

    // ── Brainstorm Journal real-time listener ─────────────────────────────────
    // includeMetadataChanges:true so we reliably observe the fromCache→server
    // transition even when the cached and server data are identical; that transition
    // is what unlocks writes (see the stale-overwrite guard above).
    if (_bjUnsubscribe) { _bjUnsubscribe(); _bjUnsubscribe = null; }
    _bjUnsubscribe = onSnapshot(bjDocRef, { includeMetadataChanges: true }, (snap) => {
      const _fromCache = !!(snap.metadata && snap.metadata.fromCache);
      if (!snap.exists()) { if (!_fromCache) _bjMarkServerSeen(); return; }
      const data = snap.data();
      const _bjSnapSavedAt = data.savedAt || 0;
      _a1b('dashboards/journal', data);
      // Echo detection: skip ONLY when savedAt is exactly what WE wrote AND within 3s.
      // deleteField() writes don't bump savedAt — the old <= comparison falsely matched
      // and suppressed another device's deletion. 15s blanket also dropped legitimate
      // remote changes arriving shortly after a local save.
      const isOwnEcho = _bjSnapSavedAt > 0
        && _bjSnapSavedAt === _bjLastWrittenSavedAt
        && (Date.now() - _bjLastOwnSaveAt) < 3000;
      if (isOwnEcho) { if (!_fromCache) _bjMarkServerSeen(); return; }
      // Metadata-only refire (same data we already merged): confirm the server and
      // drop out without re-running the merge / re-rendering the sidebar.
      if (_bjSnapSavedAt > 0 && _bjSnapSavedAt === _bjLastAppliedSavedAt) { if (!_fromCache) _bjMarkServerSeen(); return; }
      _bjLastAppliedSavedAt = _bjSnapSavedAt;
      // Always dispatch — even entries.length===0 — so deletions propagate. A
      // snapshot that came from the SERVER is as authoritative as the forced read
      // above: it IS the current document, not this device's memory of it. Only
      // cache-sourced snapshots go through the defensive merge.
      window.dispatchEvent(new CustomEvent("fb-bj-remote-update", { detail: _bjBuildRemote(data, !_fromCache) }));
      window.dispatchEvent(new CustomEvent("fb-bj-synced"));
      // Confirm server AFTER the merge above has been applied, so any writes that were
      // queued while offline flush against the already-reconciled state (never clobber).
      if (!_fromCache) _bjMarkServerSeen();
    });

    /* The whiteboard used to upload a full-canvas PNG after every stroke, into
     * dashboards/journal_canvas_<id>. It is gone: boards now write structured,
     * chunked documents on a debounce (see Notebook/core/fb.js and the VizEngine
     * in core/viz.js). The OLD documents are deliberately left in place and are read
     * once, on first open, to convert an old drawing into the new model.
     * ==================================================================== */

    // ── AI Format prompt (per-journal, cross-device synced via its own doc) ──
    // Legacy single-prompt doc. The AI Tools store below superseded it, but the
    // write is kept so an older device/tab still picks up AI Format prompt edits,
    // and the listener still seeds a first-time migration into the new store.
    window._fbSaveBJPrompt = async (prompt) => {
      try {
        await setDoc(doc(db(), 'dashboards', 'journal_aiprompt'), { prompt: String(prompt), savedAt: Date.now() });
        window.dispatchEvent(new CustomEvent('fb-bj-prompt-saved'));
      } catch(e) { console.warn('BJ prompt save failed:', e.message); }
    };
    try {
      onSnapshot(doc(db(), 'dashboards', 'journal_aiprompt'), (snap) => {
        if (snap.exists() && typeof snap.data().prompt === 'string') {
          try { localStorage.setItem('docx_aiprompt_bj', JSON.stringify(snap.data().prompt)); } catch(e) {}
          window.dispatchEvent(new CustomEvent('docx-prompt-updated', { detail: { app: 'bj', prompt: snap.data().prompt } }));
        }
      });
    } catch(e) {}

    // ── AI Tools (built-in prompts + unlimited custom tools) ──
    // Stored as a single JSON string so the whole tool set moves atomically and
    // Firestore never has to model nested arrays. Mirrors the AI-prompt doc's
    // pattern: write drives the sync pill, snapshot mirrors into localStorage.
    window._fbSaveBJTools = async (json) => {
      try {
        await setDoc(doc(db(), 'dashboards', 'journal_aitools'), { tools: String(json), savedAt: Date.now() });
        window.dispatchEvent(new CustomEvent('fb-bj-prompt-saved'));
      } catch(e) {
        console.warn('BJ AI tools save failed:', e.message);
        window.dispatchEvent(new CustomEvent('fb-bj-error'));
      }
    };
    try {
      onSnapshot(doc(db(), 'dashboards', 'journal_aitools'), (snap) => {
        if (!snap.exists() || typeof snap.data().tools !== 'string') return;
        try { localStorage.setItem('docx_aitools_bj', snap.data().tools); } catch(e) {}
        window.dispatchEvent(new CustomEvent('docx-aitools-updated', { detail: { app: 'bj' } }));
      });
    } catch(e) {}


    // The boards' and OurJournal's document accessors.
    installAccessors(Object.assign({}, F, { imgGet: _jImgGet }));


    window._fbRehydrateMyJournalImages = async (html) => {
      if (!html || !html.includes('mj-fbimg://')) return html;
      // A <template> is inert: unlike a detached <div>, assigning innerHTML
      // does not make the browser try to fetch every src it finds — which is
      // what produced ERR_UNKNOWN_URL_SCHEME for our own placeholders.
      const div = document.createElement('template');
      div.innerHTML = html;
      const imgs = Array.from(div.content.querySelectorAll('img[src^="mj-fbimg://"]'));
      await Promise.all(imgs.map(async (img) => {
        const imgKey = img.getAttribute('src').replace('mj-fbimg://', '');
        try {
          const imgRef = doc(db(), 'dashboards', imgKey);
          const snap = await (typeof _jImgGet === 'function' ? _jImgGet(imgRef) : getDoc(imgRef));
          if (snap.exists() && snap.data().img) {
            img.setAttribute('src', snap.data().img);
          }
        } catch(err) {
          console.warn('MJ image rehydrate failed:', imgKey, err.message);
        }
      }));
      return div.innerHTML;
    };

    // ── Tony's Brainstorm Journal Firebase ───────────────────────────────────────
    const tjDocRef = doc(db(), TJ_DOC_PATH);
    _stallRetry['tony_journal'] = async () => { const sn = await _freshGet(tjDocRef); if (_fbIsServerSnap(sn)) _tjMarkServerSeen(); };

    const _tjSanitize = (v) => {
      if (Array.isArray(v)) return v.map(_tjSanitize);
      if (v && typeof v === 'object') {
        const o = {};
        Object.entries(v).forEach(([k,val]) => {
          if (val !== undefined && val !== null) o[k] = _tjSanitize(val);
        });
        return o;
      }
      return v;
    };

    // Extract inline data: images from an HTML string into their own docs. The
    // tj-fbimg:// placeholder is written ONLY after the image is confirmed saved
    // (with retry); on failure the inline data URI is kept so nothing is lost.
    const _tjExtractHtmlImages = async (html, e, dateKey) => {
      // A <template> is inert: unlike a detached <div>, assigning innerHTML
      // does not make the browser try to fetch every src it finds — which is
      // what produced ERR_UNKNOWN_URL_SCHEME for our own placeholders.
      const div = document.createElement('template');
      div.innerHTML = html;
      // src OR href. The journals hold images in both, and only src was ever
      // looked at — so an entry whose images lived in href stayed inline
      // forever. The rehydrator below restores whichever attribute was used.
      const imgs = Array.from(div.content.querySelectorAll('[src],[href]'));
      await Promise.all(imgs.map(async (img) => {
        const attr = (img.getAttribute('src') || '').startsWith('data:') ? 'src'
                   : (img.getAttribute('href') || '').startsWith('data:') ? 'href' : '';
        if (!attr) return;
        const src = img.getAttribute(attr) || '';
        // Leave trivial ones alone: a separate document plus a fetch to save a
        // few hundred bytes is a worse trade than leaving it in place.
        if (src.length < 2048) return;
        let imgKey = img.getAttribute('data-tjkey') || '';
        if (!imgKey) {
          let h = 0;
          const step = Math.max(1, Math.floor(src.length / 512));
          for (let i = 0; i < src.length; i += step) { h = (Math.imul(31, h) + src.charCodeAt(i)) | 0; }
          h = (Math.imul(31, h) + src.length) | 0;
          const suffix = dateKey ? (dateKey.replace(/-/g,'') + '_') : '';
          imgKey = 'tony_journal_img_' + e.id + '_' + suffix + Math.abs(h).toString(36);
        }
        const imgRef = doc(db(), 'dashboards', imgKey);
        // Already in the cloud with these exact bytes: point at it, no write.
        if (typeof _jImgSeen === 'function' && _jImgSeen(imgKey, src)) {
          img.setAttribute('data-tjkey', imgKey);
          img.setAttribute(attr, 'tj-fbimg://' + imgKey);
          return;
        }
        try {
          await _fbWriteRetry(() => setDoc(imgRef, { img: src, savedAt: Date.now() }), 'TJ img ' + imgKey);
          if (typeof _jImgMark === 'function') _jImgMark(imgKey, src);
          img.setAttribute('data-tjkey', imgKey);
          img.setAttribute(attr, 'tj-fbimg://' + imgKey);
        } catch(err) {
          console.warn('TJ image upload failed, keeping inline:', imgKey, err.message);
        }
      }));
      return div.innerHTML;
    };

    // Local-only sync bookkeeping, stripped before anything is published: _dirty is
    // THIS device's "not uploaded yet" mark and _fbPushed its "seen on the server"
    // mark. Shipping either would hand another device our sync state as if it were
    // its own — a receiver would think its copy was already safe, or refuse to let
    // the server correct it.
    const _tjStripLocal = (e) => { const o = Object.assign({}, e); delete o._dirty; delete o._fbPushed; return o; };
    const _tjStripEntry = async (e0) => {
      const e = _tjStripLocal(e0);
      if (e.template === 'whiteboard') {
        const { canvas, history, ...rest } = (e.data || {});
        return { entry: { ...e, data: rest }, imageUploadPromises: [] };
      }
      if (e.template === 'page' && e.data && e.data.html) {
        const html = await _tjExtractHtmlImages(e.data.html, e, null);
        return { entry: { ...e, data: { ...e.data, html } }, imageUploadPromises: [] };
      }
      if (e.template === 'journal-entries' && e.data && e.data.dates) {
        const strippedDates = {};
        for (const [dateKey, dateData] of Object.entries(e.data.dates)) {
          if (!dateData || !dateData.html) { strippedDates[dateKey] = dateData || { html: '' }; continue; }
          strippedDates[dateKey] = { ...dateData, html: await _tjExtractHtmlImages(dateData.html, e, dateKey) };
        }
        return { entry: { ...e, data: { ...e.data, dates: strippedDates } }, imageUploadPromises: [] };
      }
      return { entry: e, imageUploadPromises: [] };
    };

    window._fbLoadTonyJournal = async () => {
      try {
        const snap = await _freshGet(tjDocRef);
        // A server-sourced read confirms the true remote state → writes are now safe.
        if (snap && snap.metadata && !snap.metadata.fromCache) _tjMarkServerSeen();
        if (!snap || !snap.exists()) return null;
        const data = snap.data();
        const entries = [];
        Object.entries(data).forEach(([k, v]) => {
          if (k.startsWith('e_') && v && typeof v === 'object' && v.id) entries.push(v);
        });
        if (entries.length > 0) {
          // Use explicit _order array if saved, else fall back to created-desc sort
          if (Array.isArray(data._order) && data._order.length > 0) {
            const orderMap = {}; data._order.forEach((id, i) => { orderMap[id] = i; });
            entries.sort((a, b) => {
              const ia = orderMap[a.id] != null ? orderMap[a.id] : 9999;
              const ib = orderMap[b.id] != null ? orderMap[b.id] : 9999;
              return ia !== ib ? ia - ib : (b.created || 0) - (a.created || 0);
            });
          } else {
            entries.sort((a, b) => (b.created || 0) - (a.created || 0));
          }
          return { entries, activeId: data.activeId || null, _legacy: false };
        }
        // Legacy shape: one `entries` array and no e_* fields at all.
        if (Array.isArray(data.entries) && data.entries.length > 0) return Object.assign({}, data, { _legacy: true });
        return null;
      } catch(e) { console.warn("Firebase TonyJournal load failed:", e); return null; }
    };

    // Save: write active entry + _order array + activeId. FLUSHABLE — see BJ above.
    let _tjPendingGetState = null;
    let _tjSaveInFlight = null;
    // SERIALISED. Two overlapping writes of the same whole entry are a race: if they
    // land out of order the OLDER payload wins and the newest keystrokes are gone.
    // A save requested while one is still crossing the network is CHAINED behind it
    // instead — and because the chained link reads _tjPendingGetState fresh when it
    // finally runs, it carries the latest state rather than a stale snapshot.
    const _tjDoSave = () => {
      if (_tjSaveInFlight) {
        _tjSaveInFlight = _tjSaveInFlight.then(_tjRunSave, _tjRunSave);
        return _tjSaveInFlight;
      }
      return _tjRunSave();
    };
    const _tjRunSave = async () => {
      if (!_tjPendingGetState) return _tjSaveInFlight || undefined;
      const getState = _tjPendingGetState; _tjPendingGetState = null;
      _tjSaveInFlight = (async () => {
        try {
          const { entries, activeId } = getState();
          const activeEntry = entries.find(e => e.id === activeId);
          if (!activeEntry) return;
          const { entry: stripped, imageUploadPromises } = await _tjStripEntry(activeEntry);
          const sanitized = _tjSanitize(stripped);
          await Promise.all(imageUploadPromises);
          const fieldKey = 'e_' + activeEntry.id;
          const _order = entries.map(e => e.id);
          const _tjSavedAt = Date.now();
          _tjLastOwnSaveAt = _tjSavedAt;
          _tjLastWrittenSavedAt = _tjSavedAt;
          await _fbUpsert(tjDocRef, { [fieldKey]: sanitized, _order, activeId, savedAt: _tjSavedAt }, 'TJ save');
          _tjLastOwnSaveAt = Date.now();
          // Names the entry: the UI clears that entry's _dirty mark on this event,
          // and clearing the wrong one would either strand an unsynced edit or drop
          // the protection from one that really is still unsynced.
          window.dispatchEvent(new CustomEvent("fb-tj-saved", { detail: { id: activeEntry.id } }));
        } catch(e) {
          console.error("Firebase TonyJournal save failed:", e.code, e.message, e);
          window.dispatchEvent(new CustomEvent("fb-tj-error"));
        } finally { _tjSaveInFlight = null; }
      })();
      return _tjSaveInFlight;
    };
    window._fbSaveTonyJournal = (getState) => {
      _tjPendingGetState = getState;
      if (_tjSaveTimer) clearTimeout(_tjSaveTimer);
      // Gate the write on server-confirmation (see the stale-overwrite guard above):
      // an edit made before the true server state is known stays queued, never blind-written.
      _tjSaveTimer = setTimeout(() => _tjWhenServerSeen(_tjDoSave), 300);
    };
    // Flush any pending TJ save NOW (returns the write promise).
    window._fbFlushTonyJournal = () => { if (_tjSaveTimer) { clearTimeout(_tjSaveTimer); _tjSaveTimer = null; } return _tjWhenServerSeen(_tjDoSave); };

    // Dedicated order-only save (called on drag reorder)
    window._fbSaveJournalOrder = window._fbSaveJournalOrder || function() {};
    window._fbSaveTonyJournalOrder = (entries) => _tjWhenServerSeen(() => {
      const _order = entries.map(e => e.id);
      const _tjOrdTs = Date.now();
      _tjLastOwnSaveAt = _tjOrdTs;
      _tjLastWrittenSavedAt = _tjOrdTs;
      return _fbUpsert(tjDocRef, { _order, savedAt: _tjOrdTs }, 'TJ order')
        .catch(err => console.warn('TJ order save failed:', err.message));
    });

    // Save ONE specific entry's field immediately (used for trash/restore of a
    // non-active entry — the debounced _fbSaveTonyJournal only writes the active one).
    window._fbSaveTonyJournalEntry = (entry, allEntries) => _tjWhenServerSeen(async () => {
      if (!entry || !entry.id) return;
      try {
        const { entry: stripped, imageUploadPromises } = await _tjStripEntry(entry);
        const sanitized = _tjSanitize(stripped);
        await Promise.all(imageUploadPromises || []);
        const _ts = Date.now();
        _tjLastOwnSaveAt = _ts; _tjLastWrittenSavedAt = _ts;
        const payload = { ['e_' + entry.id]: sanitized, savedAt: _ts };
        if (Array.isArray(allEntries)) payload._order = allEntries.map(e => e.id);
        await _fbUpsert(tjDocRef, payload, 'TJ save-one');
        window.dispatchEvent(new CustomEvent('fb-tj-saved', { detail: { id: entry.id } }));
      } catch(e) { console.warn('TJ save-one failed:', e.message); }
    });

    window._tjCompactImages = (opts) => _compactImages({
      ref: tjDocRef, label: 'MyJournal',
      stripEntry: _tjStripEntry, sanitize: _tjSanitize, opts
    });

    window._fbDeleteTonyJournalEntry = (entryId) => _tjWhenServerSeen(async () => {
      try {
        const _delTs = Date.now();
        _tjLastOwnSaveAt = _delTs;
        _tjLastWrittenSavedAt = _delTs;
        await _fbWriteRetry(() => updateDoc(tjDocRef, { ["e_" + entryId]: deleteField(), savedAt: _delTs }), 'TJ delete');
      }
      catch(e) { if (e.code !== "not-found") console.warn("TJ delete failed:", e.message); }
    });

    window._fbMigrateTonyJournalIfNeeded = (legacyEntries) => _tjWhenServerSeen(async () => {
      if (!Array.isArray(legacyEntries) || legacyEntries.length === 0) return;
      try {
        const payload = { savedAt: Date.now() };
        for (const e of legacyEntries) {
          const { entry: stripped } = await _tjStripEntry(e);
          payload['e_' + e.id] = _tjSanitize(stripped);
        }
        // MERGE, never a bare setDoc. setDoc REPLACES the document, so this used to
        // delete _order and activeId and republish every entry from whatever this
        // device happened to have read — and when _freshGet had fallen back to the
        // IndexedDB cache, that was this device's stale copy overwriting the real one
        // for ALL entries at once. Combined with the boot-time trigger below firing
        // on every single page load, that is how a phone resurrected entries deleted
        // days ago and pushed week-old page content over the desktop's.
        await _fbWriteRetry(() => setDoc(tjDocRef, payload, { merge: true }), 'TJ migrate');
      } catch(err) { console.warn('TJ migration failed:', err.message); }
    });

    window._fbRehydrateTonyPageImages = async (html) => {
      if (!html || !html.includes('tj-fbimg://')) return html;
      // A <template> is inert: unlike a detached <div>, assigning innerHTML
      // does not make the browser try to fetch every src it finds — which is
      // what produced ERR_UNKNOWN_URL_SCHEME for our own placeholders.
      const div = document.createElement('template');
      div.innerHTML = html;
      // Must mirror the extractor exactly: it can place the placeholder in
      // src or href, and an attribute it fails to restore is a broken image
      // or a dead link for the reader.
      const imgs = Array.from(div.content.querySelectorAll(
        '[src^="tj-fbimg://"],[href^="tj-fbimg://"]'));
      await Promise.all(imgs.map(async (img) => {
        const attr = (img.getAttribute('src') || '').indexOf('tj-fbimg://') === 0 ? 'src' : 'href';
        const imgKey = img.getAttribute(attr).replace('tj-fbimg://', '');
        try {
          const imgRef = doc(db(), 'dashboards', imgKey);
          const snap = await (typeof _jImgGet === 'function' ? _jImgGet(imgRef) : getDoc(imgRef));
          if (snap.exists() && snap.data().img) img.setAttribute(attr, snap.data().img);
        } catch(err) { console.warn('TJ image rehydrate failed:', imgKey, err.message); }
      }));
      return div.innerHTML;
    };


    // Turn a journal document into the detail the UI merge expects. Shared by the
    // live listener and the authoritative resync below so the two can never drift.
    const _tjBuildRemote = (data, authoritative) => {
      const entries = [];
      const _allPresentIds = [];
      Object.entries(data).forEach(([k, v]) => {
        if (k.startsWith('e_')) {
          _allPresentIds.push(k.slice(2));
          if (v && typeof v === 'object' && v.id) entries.push(v);
        }
      });
      if (Array.isArray(data._order) && data._order.length > 0) {
        const orderMap = {}; data._order.forEach((id, i) => { orderMap[id] = i; });
        entries.sort((a, b) => {
          const ia = orderMap[a.id] != null ? orderMap[a.id] : 9999;
          const ib = orderMap[b.id] != null ? orderMap[b.id] : 9999;
          return ia !== ib ? ia - ib : (b.created || 0) - (a.created || 0);
        });
      } else {
        entries.sort((a, b) => (b.created || 0) - (a.created || 0));
      }
      return { entries, activeId: data.activeId || null, _order: data._order || null,
               _fbHasData: true, _allPresentIds, _authoritative: !!authoritative };
    };

    /* ── Server-authoritative resync ───────────────────────────────────────────
     * The live listener alone is not enough, and this is why "the phone shows a
     * week-old page, and entries I deleted days ago are back" happens:
     *
     *   - onSnapshot is served from the IndexedDB cache FIRST, so on a phone that
     *     has been backgrounded for days the cached copy is what paints;
     *   - the merge that follows is a defensive, per-entry last-write-wins on a
     *     DEVICE WALL CLOCK, so a local copy carrying a newer `updated` rejects the
     *     real server content the moment it arrives — and permanently, because
     *     nothing ever lowers that number again;
     *   - and the loader that does a forced server read only ran ONCE per page
     *     load, so re-opening the app after a teardown re-read nothing at all.
     *
     * This is the other half: a FORCED server read applied as the TRUTH — content,
     * deletions and order all come from the server, and the only thing kept from
     * this device is an entry it has edited but not yet uploaded (entry._dirty).
     * Run on open, on resume and on reconnect, it makes a journal that has not been
     * opened here in a week show the current state instead of this device's memory
     * of it. Cost is one document read per open — the read the page already did at
     * boot, no longer only at boot. */
    window._fbResyncTonyJournal = async () => {
      try {
        const snap = await _freshGet(tjDocRef);
        if (!snap) return false;
        // _freshGet falls back to the CACHE when the server is unreachable, and a
        // cached read must never authorise itself — that is exactly the stale copy
        // this is here to correct.
        const fromServer = !!(snap.metadata && !snap.metadata.fromCache);
        if (fromServer) _tjMarkServerSeen();
        if (!snap.exists()) return false;
        const data = snap.data();
        _tjLastAppliedSavedAt = data.savedAt || 0;
        window.dispatchEvent(new CustomEvent('fb-tj-remote-update', { detail: _tjBuildRemote(data, fromServer) }));
        window.dispatchEvent(new CustomEvent('fb-tj-synced'));
        return fromServer;
      } catch (e) { console.warn('TonyJournal resync failed:', e && e.message); return false; }
    };

    // ── Tony's Journal real-time listener ────────────────────────────────────
    // includeMetadataChanges:true so the fromCache→server transition reliably fires
    // and unlocks writes (see the stale-overwrite guard above).
    if (_tjUnsubscribe) { _tjUnsubscribe(); _tjUnsubscribe = null; }
    _tjUnsubscribe = onSnapshot(tjDocRef, { includeMetadataChanges: true }, (snap) => {
      const _fromCache = !!(snap.metadata && snap.metadata.fromCache);
      if (!snap.exists()) { if (!_fromCache) _tjMarkServerSeen(); return; }
      const data = snap.data();
      const _tjSnapSavedAt = data.savedAt || 0;
      _a1b('dashboards/tony_journal', data);
      // Echo detection: exact timestamp match + within 3s only. deleteField() writes
      // do not bump savedAt so the old <= comparison suppressed remote deletions.
      const isOwnEcho = _tjSnapSavedAt > 0
        && _tjSnapSavedAt === _tjLastWrittenSavedAt
        && (Date.now() - _tjLastOwnSaveAt) < 3000;
      if (isOwnEcho) { if (!_fromCache) _tjMarkServerSeen(); return; }
      // Metadata-only refire (same data we already merged): confirm the server and
      // drop out without re-running the merge / re-rendering the sidebar.
      if (_tjSnapSavedAt > 0 && _tjSnapSavedAt === _tjLastAppliedSavedAt) { if (!_fromCache) _tjMarkServerSeen(); return; }
      _tjLastAppliedSavedAt = _tjSnapSavedAt;
      // Always dispatch — even entries.length===0 — so deletions propagate. A
      // snapshot that came from the SERVER is as authoritative as the forced read
      // above: it IS the current document, not this device's memory of it. Only
      // cache-sourced snapshots go through the defensive merge.
      window.dispatchEvent(new CustomEvent("fb-tj-remote-update", { detail: _tjBuildRemote(data, !_fromCache) }));
      window.dispatchEvent(new CustomEvent("fb-tj-synced"));
      // Confirm server AFTER the merge above has been applied, so any writes that were
      // queued while offline flush against the already-reconciled state (never clobber).
      if (!_fromCache) _tjMarkServerSeen();
    });


    // ── AI Format prompt (per-journal, cross-device synced via its own doc) ──
    // Legacy single-prompt doc. The AI Tools store below superseded it, but the
    // write is kept so an older device/tab still picks up AI Format prompt edits,
    // and the listener still seeds a first-time migration into the new store.
    window._fbSaveTJPrompt = async (prompt) => {
      try {
        await setDoc(doc(db(), 'dashboards', 'myjournal_aiprompt'), { prompt: String(prompt), savedAt: Date.now() });
        window.dispatchEvent(new CustomEvent('fb-tj-prompt-saved'));
      } catch(e) { console.warn('TJ prompt save failed:', e.message); }
    };
    // Live-sync the remote prompt into localStorage so AI Format always uses the latest.
    try {
      onSnapshot(doc(db(), 'dashboards', 'myjournal_aiprompt'), (snap) => {
        if (snap.exists() && typeof snap.data().prompt === 'string') {
          try { localStorage.setItem('docx_aiprompt_tj', JSON.stringify(snap.data().prompt)); } catch(e) {}
          window.dispatchEvent(new CustomEvent('docx-prompt-updated', { detail: { app: 'tj', prompt: snap.data().prompt } }));
        }
      });
    } catch(e) {}

    // ── AI Tools (built-in prompts + unlimited custom tools) ──
    // Stored as a single JSON string so the whole tool set moves atomically and
    // Firestore never has to model nested arrays. Mirrors the AI-prompt doc's
    // pattern: write drives the sync pill, snapshot mirrors into localStorage.
    window._fbSaveTJTools = async (json) => {
      try {
        await setDoc(doc(db(), 'dashboards', 'myjournal_aitools'), { tools: String(json), savedAt: Date.now() });
        window.dispatchEvent(new CustomEvent('fb-tj-prompt-saved'));
      } catch(e) {
        console.warn('TJ AI tools save failed:', e.message);
        window.dispatchEvent(new CustomEvent('fb-tj-error'));
      }
    };
    try {
      onSnapshot(doc(db(), 'dashboards', 'myjournal_aitools'), (snap) => {
        if (!snap.exists() || typeof snap.data().tools !== 'string') return;
        try { localStorage.setItem('docx_aitools_tj', snap.data().tools); } catch(e) {}
        window.dispatchEvent(new CustomEvent('docx-aitools-updated', { detail: { app: 'tj' } }));
      });
    } catch(e) {}
}

window.Notebook.fb = {
  install: install,
  // The host's teardown: drop both journals' listeners...
  unsubscribe: function () {
    if (_bjUnsubscribe)  { _bjUnsubscribe();  _bjUnsubscribe  = null; }
    if (_tjUnsubscribe)  { _tjUnsubscribe();  _tjUnsubscribe  = null; }
  },
  // ...and re-arm their stale-overwrite guards: that connection is gone, so
  // "we have seen server state" is no longer true (see the guard above).
  rearm: function () {
    _bjServerSeen = false;
    _tjServerSeen = false;
  },
  serverSeen: function (key) { return key === 'bj' ? _bjServerSeen : key === 'tj' ? _tjServerSeen : false; }
};
})();
