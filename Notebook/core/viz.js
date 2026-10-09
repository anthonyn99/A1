/* ══════════════════════════════════════════════════════════════════════════
     VIZ ENGINE — the shared Whiteboard (Excalidraw) + Mind Map (Mind Elixir)
     runtime behind BOTH journals.

     WHY IT LIVES HERE, ONCE. Veda's Brainstorm Journal and Tony's MyJournal are
     two independent copies of the same editor shell, and these two visual
     templates are the only part expensive enough that a second copy would be a
     second set of bugs — an Excalidraw mount is a React tree, a canvas renderer
     and a megabyte of CDN payload. So the engine is written once and
     PARAMETERISED by app ('bj' / 'tj'): document prefix, sync-pill setter,
     theme. Everything app-specific arrives through the config object; nothing
     here reads a global belonging to either journal.

     DOCUMENT MODEL. A visual entry's content does NOT live in the journal
     document. dashboards/journal (and dashboards/tony_journal) is one Firestore
     document holding every entry and already sits at ~78% of the size ceiling —
     a single drawing in there would wedge the whole journal's sync. Each board
     therefore gets its own document, chunked when it outgrows one:

        dashboards/{prefix}_viz_{entryId}        chunk 0 + chunk count
        dashboards/{prefix}_viz_{entryId}_1..n   overflow chunks
        dashboards/{prefix}_vizf_{fileId}        one embedded image, content-hashed

     The entry itself keeps only a fingerprint (vizRev / vizCount / vizKind) so
     the journal's merge, empty-guard and auto-title logic can still reason about
     it without loading the board.

     THE LEGACY DOCUMENTS ARE NEVER WRITTEN. Old whiteboards are a base64 PNG in
     dashboards/{prefix}_canvas_{entryId}; old Veda mind maps are data.nodes /
     data.edges on the entry. Both are READ ONCE, converted, and then left
     exactly as they were forever. If a conversion is ever wrong the original is
     still sitting there untouched.
     ══════════════════════════════════════════════════════════════════════════ */

/* ── VizEngine core: local cache, CDN loaders, chunked board documents ────────
 *
 * Deliberately free of any journal-specific reference. Nothing else (Firebase,
 * JGuard, the journals themselves) is touched by it; everything it needs arrives through window._fbViz — the thin Firestore
 * accessor the Firebase module installs — or through a config object.
 * ========================================================================== */
(function () {
'use strict';

/* ── Local cache (IndexedDB) ─────────────────────────────────────────────────
 * localStorage is the wrong store here and the journals already learned that
 * the hard way: a whiteboard PNG alone could blow the ~5MB quota and the thrown
 * QuotaExceededError broke document open, the lock screen and cloud sync all at
 * once. Boards therefore cache in IndexedDB, which is quota-generous, async,
 * and cannot take the rest of the app down with it. Every call resolves rather
 * than rejects — a browser in private mode with IDB disabled must degrade to
 * "cloud only", not to "cannot draw". */
var IDB_NAME = 'viz_store_v1', IDB_STORE = 'kv', _idb = null, _idbFail = false;
function idbOpen() {
  if (_idbFail) return Promise.resolve(null);
  if (_idb) return Promise.resolve(_idb);
  return new Promise(function (res) {
    var req;
    try { req = indexedDB.open(IDB_NAME, 1); }
    catch (e) { _idbFail = true; return res(null); }
    req.onupgradeneeded = function (e) {
      try { e.target.result.createObjectStore(IDB_STORE); } catch (_) {}
    };
    req.onsuccess = function (e) { _idb = e.target.result; res(_idb); };
    req.onerror = function () { _idbFail = true; res(null); };
    req.onblocked = function () { _idbFail = true; res(null); };
  });
}
function idbGet(key) {
  return idbOpen().then(function (db) {
    if (!db) return null;
    return new Promise(function (res) {
      try {
        var r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        r.onsuccess = function (e) { res(e.target.result == null ? null : e.target.result); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  });
}
function idbDel(key) {
  return idbOpen().then(function (db) {
    if (!db) return false;
    return new Promise(function (res) {
      try {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
        tx.onabort = function () { res(false); };
      } catch (e) { res(false); }
    });
  });
}
function idbPut(key, val) {
  return idbOpen().then(function (db) {
    if (!db) return false;
    return new Promise(function (res) {
      try {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
        tx.onabort = function () { res(false); };
      } catch (e) { res(false); }
    });
  });
}

/* ── CDN loaders ─────────────────────────────────────────────────────────────
 * Both editors are real npm libraries with no build step available to us —
 * index.html ships as-is — so they load from jsdelivr at EXACT pinned versions,
 * the same lazy-on-first-use pattern KaTeX already uses in core/docx.js. Nothing
 * is fetched until someone actually opens a visual template, so the other
 * templates and TaskHub pay nothing for them.
 *
 * Excalidraw 0.17.6 is chosen over 0.18.x on purpose: 0.17 is the last line
 * shipping a real UMD bundle, which is the only form that can be dropped into
 * a page with no bundler. 0.18 is ESM-with-code-splitting and would need an
 * import map plus ESM React — more moving parts, all of them CDN-dependent.
 *
 * A failed load REJECTS and clears the cached promise, so pressing Retry
 * genuinely retries instead of replaying the same failure forever. */
var CDN = 'https://cdn.jsdelivr.net/npm/';
var V_REACT = '18.2.0', V_EXC = '0.17.6', V_ME = '5.15.1';
var EXC_BASE = CDN + '@excalidraw/excalidraw@' + V_EXC + '/dist/';

function loadScript(src) {
  return new Promise(function (res, rej) {
    var s = document.createElement('script');
    s.src = src; s.async = false; s.crossOrigin = 'anonymous';
    s.onload = function () { res(); };
    s.onerror = function () { s.remove(); rej(new Error('load failed: ' + src)); };
    document.head.appendChild(s);
  });
}

/* ── Offline-capable library loading ─────────────────────────────────────────
 * A drawing that is saved locally is no use if the editor that opens it lives
 * on a CDN: reload a board on a train and the page would have the work and no
 * way to show it. So the FIRST successful load of each library also files a
 * copy of its source in IndexedDB, and a later load that cannot reach the
 * network runs that copy instead.
 *
 * The network is still tried first, so the normal path is an ordinary <script
 * src> the browser can stream-compile and HTTP-cache. The archive copy is
 * fetched afterwards, off the critical path, and normally comes straight out of
 * the HTTP cache. Cache keys carry the pinned version, so a version bump
 * naturally misses and re-archives rather than resurrecting an old build.
 *
 * The Excalidraw fonts and locale chunks it pulls at runtime are NOT archived —
 * offline it falls back to system fonts and its built-in English. A board that
 * opens in the wrong typeface is a far better outcome than one that will not
 * open at all. */
function archive(url, key) {
  setTimeout(function () {
    idbGet('lib:' + key).then(function (have) {
      if (have && have.t) return;
      return fetch(url).then(function (r) { return r.ok ? r.text() : null; })
        .then(function (t) { if (t) return idbPut('lib:' + key, { t: t, at: Date.now() }); });
    }).catch(function () { /* the archive is a bonus, never a requirement */ });
  }, 4000);
}
function runArchived(key, kind) {
  return idbGet('lib:' + key).then(function (c) {
    if (!c || !c.t) throw new Error('no offline copy of ' + key);
    if (kind === 'css') {
      var st = document.createElement('style');
      st.textContent = c.t; st.setAttribute('data-viz-lib', key);
      document.head.appendChild(st);
      return;
    }
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(new Blob([c.t], { type: 'text/javascript' }));
      var s = document.createElement('script');
      s.src = url; s.async = false;
      s.onload = function () { URL.revokeObjectURL(url); res(); };
      s.onerror = function () { URL.revokeObjectURL(url); rej(new Error('offline copy of ' + key + ' would not run')); };
      document.head.appendChild(s);
    });
  });
}
function loadScriptOffline(src, key) {
  return loadScript(src)
    .then(function () { archive(src, key); })
    .catch(function (e) {
      console.warn('[viz] ' + key + ' unreachable, trying the offline copy:', e.message);
      return runArchived(key, 'js');
    });
}
function loadCss(href, id, key) {
  if (id && document.getElementById(id)) return Promise.resolve();
  return new Promise(function (res, rej) {
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; if (id) l.id = id;
    l.onload = function () { res(true); };
    l.onerror = function () { l.remove(); rej(new Error('css')); };
    document.head.appendChild(l);
  }).then(function () { if (key) archive(href, key); })
    // Styling is not worth failing a board over: if neither the network nor the
    // archive has it, the editor still works, just unstyled.
    .catch(function () { return key ? runArchived(key, 'css').catch(function () {}) : undefined; });
}

var _excP = null;
function loadExcalidraw() {
  if (window.ExcalidrawLib) return Promise.resolve(window.ExcalidrawLib);
  if (_excP) return _excP;
  // Must be set BEFORE the bundle evaluates — it is read at module scope to
  // resolve the hand-drawn fonts and locale chunks.
  window.EXCALIDRAW_ASSET_PATH = EXC_BASE;
  // The page ALREADY carries React 18.2 + ReactDOM 18.2 (the TaskHubs are built
  // on them, loaded near the top of this file) — the exact pair this Excalidraw
  // build is compiled against. So the normal path adds no React at all and the
  // two share one copy. The fallback below only runs if that ever stops being
  // true; if the app moves off React 18, this pin has to move with it.
  _excP = (window.React && window.ReactDOM ? Promise.resolve() :
      loadScriptOffline(CDN + 'react@' + V_REACT + '/umd/react.production.min.js', 'react@' + V_REACT)
        .then(function () { return loadScriptOffline(CDN + 'react-dom@' + V_REACT + '/umd/react-dom.production.min.js', 'react-dom@' + V_REACT); }))
    .then(function () { return loadScriptOffline(EXC_BASE + 'excalidraw.production.min.js', 'excalidraw@' + V_EXC); })
    .then(function () {
      if (!window.ExcalidrawLib) throw new Error('Excalidraw did not register');
      return window.ExcalidrawLib;
    })
    .catch(function (e) { _excP = null; throw e; });
  return _excP;
}

var _meP = null;
function loadMindElixir() {
  if (window.MindElixir && window.MindElixir.default) return Promise.resolve(window.MindElixir.default);
  if (_meP) return _meP;
  _meP = loadCss(CDN + 'mind-elixir@' + V_ME + '/dist/MindElixir.css', 'viz-me-css', 'me-css@' + V_ME)
    .then(function () { return loadScriptOffline(CDN + 'mind-elixir@' + V_ME + '/dist/MindElixir.iife.js', 'mind-elixir@' + V_ME); })
    .then(function () {
      if (!window.MindElixir || !window.MindElixir.default) throw new Error('Mind Elixir did not register');
      return window.MindElixir.default;
    })
    .catch(function (e) { _meP = null; throw e; });
  return _meP;
}

/* ── Chunked board documents ─────────────────────────────────────────────────
 * A board is one JSON string. Firestore caps a document at 1,048,576 bytes and
 * this file's own writer refuses anything over 900,000 (FB_MAX_WRITE_BYTES), so
 * the string is split across as many documents as it needs:
 *
 *   {base}      { k, n, c0, rev, savedAt }      ← always read first
 *   {base}_1..n { c }                           ← only fetched when n > 1
 *
 * The overwhelming majority of boards are one document and therefore one read.
 * Chunk 0 lives in the base document rather than off to the side precisely so
 * that stays true. */
var CHUNK_CHARS = 600000;      // first guess at a slice
var CHUNK_BYTES = 700000;      // the real ceiling — Firestore counts UTF-8 bytes
var MAX_FILE_CHUNKS = 10;      // ≈6MB per embedded image before we refuse to sync

var _enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
function byteLen(s) { return _enc ? _enc.encode(s).length : s.length * 3; }

/* Slice by BYTES, not by characters. A mind map written in Chinese, or an emoji
 * in a node label, is 3–4 UTF-8 bytes per JS character — chunking at a fixed
 * character count would sail past the document limit and the write would be
 * rejected with the board apparently saved. The loop also refuses to end a
 * chunk on a lone surrogate half, which Firestore would store as U+FFFD and
 * silently corrupt on rejoin. */
function splitChunks(str) {
  var out = [], i = 0, n = str.length;
  while (i < n) {
    var take = Math.min(CHUNK_CHARS, n - i);
    var piece = str.slice(i, i + take);
    while (take > 1 && byteLen(piece) > CHUNK_BYTES) {
      take = Math.max(1, Math.floor(take * 0.75));
      piece = str.slice(i, i + take);
    }
    if (take < n - i) {
      var last = piece.charCodeAt(piece.length - 1);
      if (last >= 0xD800 && last <= 0xDBFF && take > 1) { take--; piece = str.slice(i, i + take); }
    }
    out.push(piece);
    i += take;
  }
  return out.length ? out : [''];
}

function fbReady() { return !!(window._fbViz && window._fbViz.get); }

/* Read a chunked payload. Returns the JSON string, or null when absent. */
function readChunked(baseId) {
  if (!fbReady()) return Promise.resolve(null);
  return window._fbViz.get(baseId).then(function (d) {
    if (!d || typeof d.c0 !== 'string') return null;
    var n = d.n || 1;
    if (n <= 1) return { str: d.c0, meta: d };
    var rest = [];
    for (var i = 1; i < n; i++) rest.push(window._fbViz.get(baseId + '_' + i));
    return Promise.all(rest).then(function (parts) {
      var s = d.c0;
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i] || typeof parts[i].c !== 'string') throw new Error('viz: chunk ' + (i + 1) + ' of ' + baseId + ' is missing');
        s += parts[i].c;
      }
      return { str: s, meta: d };
    });
  });
}

/* Write a chunked payload. Overflow chunks go out FIRST so the base document —
 * the one every reader starts from — only ever points at chunks that already
 * exist. A half-written board then reads as "not saved yet" rather than as a
 * corrupt one. */
function writeChunked(baseId, str, extra) {
  if (!fbReady()) return Promise.reject(new Error('offline'));
  var parts = splitChunks(str);
  var tail = [];
  for (var i = 1; i < parts.length; i++) {
    tail.push(window._fbViz.set(baseId + '_' + i, { c: parts[i], savedAt: Date.now() }));
  }
  return Promise.all(tail).then(function () {
    var payload = { c0: parts[0], n: parts.length, savedAt: Date.now() };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
    return window._fbViz.set(baseId, payload);
  });
}

window.VizStore = {
  idbGet: idbGet, idbPut: idbPut, idbDel: idbDel,
  loadExcalidraw: loadExcalidraw, loadMindElixir: loadMindElixir,
  readChunked: readChunked, writeChunked: writeChunked,
  splitChunks: splitChunks, byteLen: byteLen, MAX_FILE_CHUNKS: MAX_FILE_CHUNKS,
  fbReady: fbReady
};
})();

/* ── VizEngine boards ────────────────────────────────────────────────────────
 *
 * One controller shape serves both templates. They differ in three places only
 * — which library they mount, how a document is serialised, and what the node
 * bar does — so they share one file rather than one base class and two
 * subclasses; the branches are marked `kind === 'wb'` / `'mm'` and there are
 * only a handful.
 *
 * THE SAVE PIPELINE is the part worth reading. Drawing fires pointer events at
 * screen rate and Excalidraw's onChange rides along with them, so nothing
 * expensive may run there. The chain is:
 *
 *   pointer → library's own state (untouched by us)
 *           → onChange: ONE integer scene-version compare, then a timer poke
 *           → debounce (idle 1.5s, hard ceiling 8s)
 *           → serialise once → IndexedDB → Firestore → entry fingerprint
 *
 * No serialisation, no JSON, no Firestore call and no journal save happens
 * per stroke. A continuous drawing session writes at most once every 8s, and a
 * pause writes 1.5s later. Everything before the debounce is local, which is
 * why the canvas stays at full frame rate while the network is slow or gone.
 * ========================================================================== */
(function () {
'use strict';

var S = window.VizStore;
var SAVE_IDLE = 1500;      // quiet period before a save
var SAVE_MAX  = 8000;      // hard ceiling during nonstop drawing
var RETRY_MS  = [4000, 12000, 30000, 60000, 120000];
var REMOTE_QUIET = 6000;   // don't take a remote update within this of a local edit
var LIVE_IDLE = 700;       // shared (OurJournal) boards: quiet period before a save
var LIVE_MAX  = 2500;      // ...and the ceiling while someone draws nonstop
var LIVE_CLIENT = Math.random().toString(36).slice(2, 9);
var OPEN_READ_MS = 7000;   // a cloud read on the open path may not outlast this
var SLOW_SAVE = 9000;      // a cloud write still in flight after this is not "saving"

function svg(d, extra) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + (extra || '') + '</svg>';
}
var ICON = {
  expand:   svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  collapse: svg('<path d="M3 8h3a2 2 0 0 0 2-2V3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/>'),
  download: svg('<path d="M12 3v12"/><path d="m7 12 5 5 5-5"/><path d="M4 21h16"/>'),
  plus:     svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  sibling:  svg('<path d="M4 7h7"/><path d="M4 17h7"/><path d="M15 12h5"/><path d="M17 9l3 3-3 3"/>'),
  pencil:   svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  fold:     svg('<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="m4 9 2 3-2 3"/>'),
  center:   svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/>'),
  trash:    svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  undo:     svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>'),
  redo:     svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h4"/>')
};

function mkBtn(id, iconKey, label, title) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'viz-bar-btn';
  if (id) b.id = id;
  b.innerHTML = ICON[iconKey] + '<span class="viz-btn-lbl">' + label + '</span>';
  b.setAttribute('aria-label', title || label);
  b.title = title || label;
  return b;
}

/* First non-empty line of a string, trimmed to a title-sized length. Mirrors
 * the journals' own _bjAutoTitle so a board-derived title looks like every
 * other auto-title in the sidebar. */
function firstLine(s) {
  var line = String(s || '').split('\n').map(function (x) { return x.trim(); })
    .find(function (x) { return x.length > 1; }) || '';
  if (!line) return '';
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
}

function download(blob, name) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
}
function safeName(t, ext) {
  var base = String(t || 'Untitled').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 60);
  return (base || 'Untitled') + '.' + ext;
}

/* Every live board, so the page-lifecycle hooks below can flush all of them
 * without either journal having to know the other exists. */
var BOARDS = [];
function flushAll() {
  return Promise.all(BOARDS.map(function (b) { return b.flush(); }));
}
window.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') flushAll();
});
// pagehide is the only one iOS Safari fires reliably on tab close / app switch.
window.addEventListener('pagehide', function () { flushAll(); });
window.addEventListener('online', function () {
  BOARDS.forEach(function (b) { b.retryNow(); });
});

/* ══════════════════════════════════════════════════════════════════════════
   createBoard(cfg)

   cfg = {
     kind:     'wb' | 'mm'
     app:      'bj' | 'tj'                 — journal identity, for the sync events
     prefix:   'journal' | 'tony_journal'  — Firestore document prefix
     shell:    element (the .viz-shell)
     mount:    element (the .viz-mount)
     title:    'Whiteboard' | 'Mind Map'
     setSync:  fn(status)                  — drives the journal's own pill
     onMeta:   fn(stats)                   — entry fingerprint changed; journal saves it
     entryTitle: fn()                      — current entry title, for export filenames
   }
   ══════════════════════════════════════════════════════════════════════════ */
function createBoard(cfg) {
  var B = {
    kind: cfg.kind, app: cfg.app, prefix: cfg.prefix,
    entryId: null, token: 0,
    lib: null, api: null, mind: null, root: null,
    mounted: false, editable: false, ready: false,
    dirty: false, saving: false, closing: false,
    lastSerial: null, cloudSerial: null, pendingFiles: null, rev: 0, count: 0, docTitle: '',
    lastLocalEdit: 0, lastCloudAt: 0, retryIx: 0, retryTimer: null,
    idleTimer: null, firstDirtyAt: 0, slowTimer: null,
    uploaded: {},           // prefix+fileId → true, so an unchanged image is never re-sent
    watchOff: null,
    // Per-ENTRY document prefix and live flag. One board instance serves both
    // the app's own entries and OurJournal's, so where a board lives is decided
    // by the entry it was opened for — recorded by id so a save still in flight
    // for a previous entry can never land under the next one's prefix.
    pfx: {}, live: {},
    // Live (shared) boards: the writes this device made (echo detection), the
    // last cloud state merged into the canvas, and recent states by write id
    // (the mind-map merge base).
    myW: {}, known: null, hist: {}, histOrder: [], deferT: null
  };
  BOARDS.push(B);

  /* ── chrome ─────────────────────────────────────────────────────────── */
  var bar = document.createElement('div');
  bar.className = 'viz-bar';
  var titleEl = document.createElement('span');
  titleEl.className = 'viz-bar-title';
  titleEl.textContent = cfg.title;
  var status = document.createElement('span');
  status.className = 'viz-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.innerHTML = '<span class="viz-dot"></span><span class="viz-status-txt"></span>';
  var spacer = document.createElement('span');
  spacer.className = 'viz-bar-sp';
  var btnFs = mkBtn(null, 'expand', 'Fullscreen', 'Fullscreen canvas');
  var btnDl = mkBtn(null, 'download', 'Export', 'Export this board');
  bar.appendChild(titleEl); bar.appendChild(status); bar.appendChild(spacer);
  bar.appendChild(btnFs); bar.appendChild(btnDl);
  cfg.shell.insertBefore(bar, cfg.shell.firstChild);

  var veil = document.createElement('div');
  veil.className = 'viz-veil';
  veil.hidden = true;
  cfg.mount.appendChild(veil);

  var hint = document.createElement('div');
  hint.className = 'viz-hint';
  hint.hidden = true;
  hint.innerHTML = cfg.kind === 'wb'
    ? '<span class="viz-hint-h">A blank canvas</span>'
      + '<span class="viz-hint-p">Pick a tool and draw &middot; scroll or pinch to zoom<br>space or two fingers to pan</span>'
    : '<span class="viz-hint-h">Start with one idea</span>'
      + '<span class="viz-hint-p">Double-tap the centre node to name it<br>then Child and Sibling to branch out</span>';
  cfg.mount.appendChild(hint);

  function setVeil(state, msg, onRetry) {
    if (state === 'off') { veil.hidden = true; veil.innerHTML = ''; return; }
    veil.hidden = false;
    if (state === 'loading') {
      veil.innerHTML = '<div class="viz-veil-spin"></div><div class="viz-veil-msg">' + msg + '</div>';
      return;
    }
    veil.innerHTML = '<div class="viz-veil-title">' + (state === 'error' ? 'Could not open this board' : 'Notice') + '</div>'
      + '<div class="viz-veil-msg">' + msg + '</div>';
    if (onRetry) {
      var b = document.createElement('button');
      b.className = 'viz-veil-btn'; b.type = 'button'; b.textContent = 'Try again';
      b.addEventListener('click', onRetry);
      veil.appendChild(b);
    }
  }

  var STATUS_TXT = { saving: 'Saving…', saved: 'Saved', offline: 'Offline — saved here', error: 'Unable to sync', idle: '' };
  var statusClear = null;
  function setStatus(s) {
    status.className = 'viz-status' + (s === 'idle' ? '' : ' viz-vis viz-' + s);
    status.querySelector('.viz-status-txt').textContent = STATUS_TXT[s] || '';
    // Mirror onto the journal's own pill so the whole app reads one state, and
    // so the mobile bottom bar shows it exactly as the Page template does.
    if (cfg.setSync) {
      if (s === 'saving') cfg.setSync('syncing');
      else if (s === 'saved') cfg.setSync('synced');
      else if (s === 'error' || s === 'offline') cfg.setSync('error');
    }
    clearTimeout(statusClear);
    if (s === 'saved') statusClear = setTimeout(function () { setStatus('idle'); }, 2600);
  }

  /* ── fullscreen ─────────────────────────────────────────────────────── */
  var fsOn = false;
  function setFs(on) {
    fsOn = on;
    cfg.shell.classList.toggle('viz-fs', on);
    btnFs.innerHTML = (on ? ICON.collapse : ICON.expand)
      + '<span class="viz-btn-lbl">' + (on ? 'Exit' : 'Fullscreen') + '</span>';
    btnFs.title = btnFs.getAttribute('aria-label') === null ? btnFs.title : (on ? 'Exit fullscreen' : 'Fullscreen canvas');
    btnFs.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen canvas');
    btnFs.classList.toggle('viz-active', on);
    // Both engines size to their container; give them a frame to see the change.
    requestAnimationFrame(function () { relayout(); });
  }
  btnFs.addEventListener('click', function () { setFs(!fsOn); });

  function relayout() {
    try {
      if (B.api && B.api.refresh) B.api.refresh();
      if (B.mind && B.mind.linkDiv) B.mind.linkDiv();
    } catch (e) {}
  }
  // Orientation change, fold/unfold, the on-screen keyboard, a resized desktop
  // window — all of them arrive here as a box change, which is the only signal
  // that actually generalises across devices.
  var ro = null;
  if (window.ResizeObserver) {
    var roT = null;
    ro = new ResizeObserver(function () {
      clearTimeout(roT);
      roT = setTimeout(relayout, 120);
    });
    ro.observe(cfg.mount);
  } else {
    window.addEventListener('resize', function () { setTimeout(relayout, 150); });
  }

  /* ── document identity ──────────────────────────────────────────────── */
  function pfxOf(id) { return B.pfx[id] || cfg.prefix; }
  function isLive(id) { return !!(id && B.live[id]); }
  function baseId(id) { return pfxOf(id) + '_viz_' + id; }
  function fileId(fid, id) { return pfxOf(id) + '_vizf_' + fid; }
  function cacheKey(id) { return cfg.app + ':' + id; }
  function legacyCanvasId(id) { return pfxOf(id) + '_canvas_' + id; }

  /* ── change detection ───────────────────────────────────────────────── */
  function markDirty() {
    if (!B.ready || B.closing) return;
    B.dirty = true;
    B.lastLocalEdit = Date.now();
    hint.hidden = true;
    var now = Date.now();
    if (!B.firstDirtyAt) B.firstDirtyAt = now;
    setStatus(navigator.onLine === false ? 'offline' : 'saving');
    clearTimeout(B.idleTimer);
    // Idle debounce, with a hard ceiling so an unbroken drawing session still
    // reaches disk. Without the ceiling the timer restarts forever and a crash
    // mid-drawing loses the lot.
    // A shared board saves sooner: the other person is watching it live.
    var live = isLive(B.entryId);
    var wait = live ? ((now - B.firstDirtyAt >= LIVE_MAX) ? 0 : LIVE_IDLE)
                    : ((now - B.firstDirtyAt >= SAVE_MAX) ? 0 : SAVE_IDLE);
    B.idleTimer = setTimeout(function () { save(); }, wait);
  }

  /* ── serialise ──────────────────────────────────────────────────────── */
  function serialise() {
    if (cfg.kind === 'wb') {
      if (!B.api) return null;
      var visible = B.api.getSceneElements() || [];
      var elements = visible;
      // A SHARED board also publishes recent deletions (Excalidraw keeps them
      // as isDeleted tombstones). Without them a merge could not tell "you
      // deleted it" from "I have not seen it yet", and would resurrect it.
      // Tombstones older than a week are dropped — everyone has synced by then.
      if (isLive(B.entryId) && B.api.getSceneElementsIncludingDeleted) {
        var wk = Date.now() - 7 * 86400000;
        elements = (B.api.getSceneElementsIncludingDeleted() || []).filter(function (el) {
          return !el.isDeleted || (el.updated || 0) > wk;
        });
      }
      var st = B.api.getAppState() || {};
      var allFiles = B.api.getFiles() || {};
      // Only files the scene still references. Excalidraw's file cache keeps
      // every image ever added in this session, including ones from other
      // entries and ones the user has since deleted; publishing those would
      // upload another entry's images under this one.
      var need = {};
      visible.forEach(function (el) { if (el.fileId) need[el.fileId] = true; });
      var files = {};
      Object.keys(need).forEach(function (k) { if (allFiles[k]) files[k] = allFiles[k]; });
      var doc = {
        v: 2, kind: 'wb', elements: elements,
        appState: {
          viewBackgroundColor: st.viewBackgroundColor || '#1b1c1e',
          gridSize: st.gridSize || null,
          gridModeEnabled: !!st.gridModeEnabled
        },
        fileIds: Object.keys(files)
      };
      var txt = '';
      visible.forEach(function (el) { if (el.type === 'text' && el.text) txt += el.text + '\n'; });
      return { doc: doc, files: files, count: visible.length, title: firstLine(txt) };
    }
    if (!B.mind) return null;
    var data = B.mind.getData();
    var n = 0;
    (function walk(node) { n++; (node.children || []).forEach(walk); })(data.nodeData);
    var root = data.nodeData || {};
    var named = root.topic && root.topic !== DEFAULT_ROOT;
    return {
      doc: { v: 2, kind: 'mm', mind: data },
      files: {},
      // "Content" is branches plus a named root, so a freshly created map with
      // its untouched default centre node counts as 0 and the journal's own
      // empty-entry guards keep treating it as empty.
      count: (n - 1) + (named ? 1 : 0),
      title: named ? firstLine(root.topic) : ''
    };
  }
  var DEFAULT_ROOT = 'Central Idea';

  /* ── save ─────────────────────────────────────────────────────────────
   *
   * Two halves, and the split is the whole point. The LOCAL half — serialise,
   * write to IndexedDB, tell the journal — runs on EVERY save, unconditionally.
   * The CLOUD half is allowed to be slow, to fail, or (offline, where Firestore
   * queues a write that neither resolves nor rejects) to hang indefinitely.
   *
   * Making the local half wait on the cloud half is a way to lose work: draw
   * two things on a train and the second one would sit in memory behind a
   * network write that will not settle until the tunnel ends, and closing the
   * tab would take it. So local never waits, and the cloud write chases the
   * newest serialisation once it eventually lands. */
  function save() {
    clearTimeout(B.idleTimer);
    if (!B.ready || !B.entryId) return Promise.resolve();
    var s;
    try { s = serialise(); } catch (e) { console.warn('[viz] serialise failed:', e && e.message); return Promise.resolve(); }
    if (!s) return Promise.resolve();
    var str;
    try { str = JSON.stringify(s.doc); } catch (e) { console.warn('[viz] stringify failed:', e && e.message); return Promise.resolve(); }
    B.dirty = false; B.firstDirtyAt = 0;
    var id = B.entryId;
    var local = Promise.resolve();

    if (str !== B.lastSerial) {
      B.lastSerial = str;
      B.rev++; B.count = s.count; B.docTitle = s.title;
      B.pendingFiles = s.files;
      // Local first, always.
      local = S.idbPut(cacheKey(id), { rev: B.rev, str: str, files: s.files, at: Date.now() });
      // Tell the journal the entry's fingerprint moved, so the sidebar, the
      // auto-title and the entry's own updated/rev follow the board.
      if (cfg.onMeta) { try { cfg.onMeta({ rev: B.rev, count: s.count, title: s.title, kind: cfg.kind }); } catch (e) {} }
    } else if (B.lastSerial === B.cloudSerial) {
      // Nothing changed in the editor (a selection, a pan, a tool switch) and
      // the cloud already has this exact content: no write of any kind.
      setStatus(B.lastCloudAt ? 'saved' : 'idle');
      return local;
    }

    if (B.saving) {
      // A cloud write is already in the air and will chase this content when it
      // lands. Re-arm the honesty timer: markDirty() has just said "Saving…"
      // and, offline, that upload may never settle to correct it.
      armSlow(id);
    } else {
      pushCloud(id);
    }
    // WHAT THIS RESOLVES ON is deliberate: the LOCAL write only, never the
    // cloud one. Offline, a Firestore write neither resolves nor rejects, and
    // close() awaits this — returning the cloud promise there would freeze
    // entry switching for as long as the connection is down.
    return local;
  }

  function armSlow(id) {
    clearTimeout(B.slowTimer);
    setStatus(navigator.onLine === false ? 'offline' : 'saving');
    B.slowTimer = setTimeout(function () {
      if (B.entryId === id && B.saving) setStatus(navigator.onLine === false ? 'offline' : 'error');
    }, SLOW_SAVE);
  }

  function pushCloud(id) {
    var str = B.lastSerial, rev = B.rev, files = B.pendingFiles || {};
    if (!str) return Promise.resolve();
    var extra = { k: cfg.kind, rev: rev };
    if (isLive(id)) {
      // w names this write, pw the cloud state it was built on — how the
      // other screen recognises its own echo and finds the merge base.
      extra.w = LIVE_CLIENT + cfg.app + (++liveSeq).toString(36) + Date.now().toString(36);
      extra.pw = (B.known && B.known.w) || '';
      B.myW[extra.w] = 1;
    }
    // Offline, a Firestore write neither resolves nor rejects — it sits in the
    // local mutation queue until the connection comes back. Saying "Saving…"
    // for that whole flight is the one thing this indicator must never do: it
    // reads as "your work is on its way" while nothing is moving. So the status
    // runs on its own clock. The write is NOT cancelled — it is still queued and
    // will land on reconnect — only the label is corrected.
    armSlow(id);
    B.saving = (function () {
      if (!S.fbReady()) return Promise.reject(new Error('firebase-not-ready'));
      return uploadFiles(files, id)
        .then(function () { return S.writeChunked(baseId(id), str, extra); });
    })()
      .then(function () {
        clearTimeout(B.slowTimer);
        B.saving = null; B.retryIx = 0; B.lastCloudAt = Date.now();
        B.cloudSerial = str;
        if (extra.w && B.entryId === id) { B.known = { w: extra.w, str: str }; remember(extra.w, str); }
        if (B.entryId === id) setStatus('saved');
        window.dispatchEvent(new CustomEvent('fb-' + cfg.app + '-canvas-saved', { detail: id }));
        // Anything serialised while that was in the air goes now.
        if (B.entryId === id && B.lastSerial !== B.cloudSerial) pushCloud(id);
        else if (B.dirty) markDirty();
      })
      .catch(function (e) {
        clearTimeout(B.slowTimer);
        B.saving = null;
        console.warn('[viz] cloud save failed:', e && (e.code || e.message));
        if (B.entryId === id) setStatus(navigator.onLine === false ? 'offline' : 'error');
        scheduleRetry(id);
      });
    return B.saving;
  }

  function scheduleRetry(id) {
    clearTimeout(B.retryTimer);
    var wait = RETRY_MS[Math.min(B.retryIx, RETRY_MS.length - 1)];
    B.retryIx++;
    B.retryTimer = setTimeout(function () { retry(id); }, wait);
  }
  // A retry is just another cloud push of whatever the newest local copy is —
  // never of the payload that happened to fail, which by now may be two edits
  // out of date.
  function retry(id) {
    if (B.entryId !== id || !B.lastSerial || B.saving) return;
    if (!S.fbReady()) { scheduleRetry(id); return; }
    pushCloud(id);
  }
  B.retryNow = function () {
    if (B.entryId && B.lastSerial && B.lastSerial !== B.cloudSerial) {
      clearTimeout(B.retryTimer); B.retryIx = 0; retry(B.entryId);
    }
  };

  /* Images are content-addressed by Excalidraw (fileId is a hash of the bytes),
   * so an image that has not changed is never uploaded twice — not on this
   * save, and not on any later one in this session. */
  function uploadFiles(files, id) {
    var ids = Object.keys(files || {});
    var pf = pfxOf(id);
    var todo = ids.filter(function (k) { return !B.uploaded[pf + k]; });
    if (!todo.length) return Promise.resolve();
    return Promise.all(todo.map(function (k) {
      var f = files[k], data = (f && f.dataURL) || '';
      if (!data) return Promise.resolve();
      var chunks = S.splitChunks(data);
      if (chunks.length > S.MAX_FILE_CHUNKS) {
        // Refusing quietly is how a device ends up holding work no other device
        // will ever see. Say so, once, and keep the image locally.
        console.error('[viz] image too large to sync: ' + Math.round(data.length / 1024) + ' KB');
        if (window.uiAlert) window.uiAlert(
          'One image on this board is too large to sync to the cloud ('
          + Math.round(data.length / 1024 / 1024 * 10) / 10 + ' MB). It is saved on this device, '
          + 'but your other devices will not see it. Try inserting a smaller version.',
          { title: 'Image too large' });
        B.uploaded[pf + k] = true;   // don't retry it forever
        return Promise.resolve();
      }
      return S.writeChunked(fileId(k, id), data, { mime: (f && f.mimeType) || 'image/png' })
        .then(function () { B.uploaded[pf + k] = true; });
    }));
  }

  function fetchFiles(ids, id) {
    if (!ids || !ids.length || !S.fbReady()) return Promise.resolve({});
    id = id || B.entryId;
    var pf = pfxOf(id);
    return Promise.all(ids.map(function (k) {
      return S.readChunked(fileId(k, id))
        .then(function (r) { return r ? { id: k, dataURL: r.str, mime: (r.meta && r.meta.mime) || 'image/png' } : null; })
        .catch(function () { return null; });
    })).then(function (rows) {
      var out = {};
      rows.forEach(function (r) {
        if (!r) return;
        out[r.id] = { id: r.id, dataURL: r.dataURL, mimeType: r.mime, created: Date.now() };
        B.uploaded[pf + r.id] = true;   // it is already in the cloud; never re-upload
      });
      return out;
    });
  }

  B.flush = function () {
    clearTimeout(B.idleTimer);
    if (!B.ready || !B.entryId) return Promise.resolve();
    return save();
  };

  /* ── loading ────────────────────────────────────────────────────────── */
  function blankDoc() {
    return cfg.kind === 'wb'
      ? { v: 2, kind: 'wb', elements: [], appState: { viewBackgroundColor: bgColor() }, fileIds: [] }
      : { v: 2, kind: 'mm', mind: null };
  }
  function bgColor() {
    try {
      return (getComputedStyle(cfg.shell).getPropertyValue('--bg') || '#1b1c1e').trim() || '#1b1c1e';
    } catch (e) { return '#1b1c1e'; }
  }

  /* A cloud read that never answers must not hold the board hostage. Firestore
   * offline does not always fail fast: asking for a document it has never
   * cached can simply hang, and every second of that is a user staring at a
   * loading veil that swallows their pointer. So every read on the open path is
   * capped, and a read that misses its deadline is treated as "nothing there" —
   * the local copy is used instead, and if there is none the board opens blank
   * and EMPTY, which the first-edit rule keeps harmless: an untouched board
   * writes nothing, so a slow network can never overwrite a real one. */
  function capped(p, ms) {
    return Promise.race([
      Promise.resolve(p).catch(function () { return null; }),
      new Promise(function (res) { setTimeout(function () { res(null); }, ms || OPEN_READ_MS); })
    ]);
  }

  /* Read the board. Local cache first so the canvas paints immediately, the
   * cloud copy second and only if it is genuinely newer. Nothing here writes:
   * a board that has never been saved in the new format is CONVERTED in memory
   * from whatever legacy form exists and only becomes a document when the user
   * actually touches it. */
  function loadDoc(entry) {
    var id = entry.id;
    var cached = S.idbGet(cacheKey(id));
    var remote = capped(S.fbReady() ? S.readChunked(baseId(id)).catch(function (e) {
      console.warn('[viz] cloud read failed:', e && (e.code || e.message));
      return null;
    }) : Promise.resolve(null));

    return Promise.all([cached, remote]).then(function (r) {
      var c = r[0], rem = r[1];
      var cRev = c ? (c.rev || 0) : -1;
      var rRev = rem && rem.meta ? (rem.meta.rev || 0) : -1;
      if (rem && rRev >= cRev) {
        return { str: rem.str, rev: rRev, files: null, source: 'cloud', w: (rem.meta && rem.meta.w) || '' };
      }
      if (c) return { str: c.str, rev: cRev, files: c.files || null, source: 'local' };
      return null;
    }).then(function (found) {
      if (found) {
        var doc;
        try { doc = JSON.parse(found.str); }
        catch (e) {
          // A parse failure must never be answered with a blank board — that is
          // one autosave away from erasing the real one.
          throw new Error('This board’s saved data could not be read. Nothing has been changed — reload the page, and if it persists the previous version is still in the cloud.');
        }
        // Images that came out of the LOCAL cache travel with the document, so
        // an offline reopen shows the pictures instead of grey placeholders.
        if (found.files) {
          var inline = [];
          Object.keys(found.files).forEach(function (k) {
            var f = found.files[k];
            if (f && f.dataURL) inline.push({ id: k, dataURL: f.dataURL, mimeType: f.mimeType || 'image/png', created: Date.now() });
          });
          if (inline.length) doc._inlineFiles = inline;
        }
        return { doc: doc, rev: found.rev, serial: found.str, source: found.source, w: found.w || '' };
      }
      return migrate(entry).then(function (m) {
        // rev 0 and NO serial: the converted board is not yet a saved document,
        // so the first real edit writes it, and an untouched visit writes nothing.
        return { doc: m, rev: 0, serial: null };
      });
    });
  }

  /* ── legacy conversion (non-destructive) ────────────────────────────── */
  function migrate(entry) {
    if (cfg.kind === 'wb') {
      var legacy = (entry.data && entry.data.canvas) || '';
      var pull = legacy ? Promise.resolve(legacy)
        : (S.fbReady() && !isLive(entry.id)
            ? capped(window._fbViz.get(legacyCanvasId(entry.id))).then(function (d) { return (d && d.canvas) || ''; })
            : Promise.resolve(''));
      return pull.then(function (dataURL) {
        if (!dataURL) return blankDoc();
        // The old whiteboard was a flat 1400×900 bitmap with no object model to
        // recover, so it comes across as an image element on the new canvas:
        // still visible, still movable, still exportable — and the original PNG
        // document is left exactly where it was.
        var fid = 'legacy_' + entry.id;
        return {
          v: 2, kind: 'wb',
          elements: [{
            type: 'image', id: 'legacyimg_' + entry.id, fileId: fid,
            x: 0, y: 0, width: 1400, height: 900, angle: 0,
            strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid',
            strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100,
            groupIds: [], frameId: null, roundness: null, seed: 1, version: 1,
            versionNonce: 1, isDeleted: false, boundElements: null,
            updated: Date.now(), link: null, locked: false, status: 'saved', scale: [1, 1]
          }],
          appState: { viewBackgroundColor: bgColor() },
          fileIds: [fid],
          _inlineFiles: [{ id: fid, dataURL: dataURL, mimeType: 'image/png', created: Date.now() }]
        };
      });
    }
    // Mind map: the old model was a free-form node/edge graph with absolute
    // positions. Mind Elixir is a tree, so the graph is walked breadth-first
    // from the root and anything the walk cannot reach is re-parented to the
    // root rather than dropped. entry.data.nodes/edges are never modified.
    var nodes = (entry.data && entry.data.nodes) || [];
    if (!nodes.length) return Promise.resolve(blankDoc());
    var byId = {}, used = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    var edges = (entry.data && entry.data.edges) || [];
    var kids = {};
    edges.forEach(function (e) {
      var a = e.from != null ? e.from : e.a, b = e.to != null ? e.to : e.b;
      if (a == null || b == null) return;
      (kids[a] = kids[a] || []).push(b);
    });
    var rootN = nodes.find(function (n) { return n.root; }) || nodes[0];
    // Field names come straight from the old canvas model: label / imageData /
    // imgW / imgH / fill / stroke. Anything it does not recognise is left
    // behind rather than guessed at — the original entry.data.nodes is still
    // there, unmodified, if something needs to be recovered by hand later.
    function conv(n) {
      var o = { id: 'm' + n.id, topic: String(n.label == null ? '' : n.label) || 'Node' };
      if (n.imageData) o.image = { url: n.imageData, width: n.imgW || 160, height: n.imgH || 120 };
      if (n.fill || n.stroke) o.style = { background: n.fill || undefined, color: n.stroke || undefined };
      return o;
    }
    function build(n, depth) {
      used[n.id] = true;
      var o = conv(n);
      if (depth > 24) return o;   // a cycle in the old edge list must not recurse forever
      var ch = (kids[n.id] || []).filter(function (cid) { return byId[cid] && !used[cid]; });
      if (ch.length) o.children = ch.map(function (cid) { return build(byId[cid], depth + 1); });
      return o;
    }
    var tree = build(rootN, 0);
    var orphans = nodes.filter(function (n) { return !used[n.id]; });
    if (orphans.length) {
      tree.children = (tree.children || []).concat(orphans.map(function (n) { return conv(n); }));
    }
    return Promise.resolve({ v: 2, kind: 'mm', mind: { nodeData: tree, arrows: [], summaries: [], direction: 1 } });
  }

  /* ── remote watch ───────────────────────────────────────────────────── */
  function startWatch(id) {
    stopWatch();
    if (!S.fbReady() || !window._fbViz.watch) return;
    if (isLive(id)) { liveWatch(id); return; }
    B.watchOff = window._fbViz.watch(cfg.app + ':viz', baseId(id), function (d) {
      if (!d || B.entryId !== id) return;
      var rRev = d.rev || 0;
      if (rRev <= B.rev) return;                              // ours, or older
      if (Date.now() - B.lastLocalEdit < REMOTE_QUIET) return; // still drawing — don't yank the canvas
      if (B.dirty || B.saving) return;
      S.readChunked(baseId(id)).then(function (r) {
        if (!r || B.entryId !== id || B.dirty || B.saving) return;
        if (Date.now() - B.lastLocalEdit < REMOTE_QUIET) return;
        var doc; try { doc = JSON.parse(r.str); } catch (e) { return; }
        B.rev = r.meta.rev || rRev;
        B.lastSerial = r.str; B.cloudSerial = r.str;
        applyDoc(doc, true);
      }).catch(function () {});
    });
  }
  function stopWatch() {
    if (B.watchOff) { try { B.watchOff(); } catch (e) {} B.watchOff = null; }
    clearTimeout(B.deferT);
  }

  /* ── live (shared) boards ─────────────────────────────────────────────
   * An OurJournal board can be open on two screens at once. The single-owner
   * rule above (ignore the cloud while drawing, newest rev wins) would lose
   * whoever saved first, so a shared board MERGES instead:
   *   whiteboard — per element, by Excalidraw's own version counter (the rule
   *                its collaboration mode uses), deletions included as
   *                tombstones, never touching the element being drawn;
   *   mind map   — 3-way per node (content, parent, sibling order), with the
   *                state the remote write was built on as the base.
   * If the merge result differs from what arrived, this side still has edits
   * the other has not seen, so it saves — and the two converge. */
  var liveSeq = 0;
  function remember(w, str) {
    if (!w) return;
    if (!B.hist[w]) B.histOrder.push(w);
    B.hist[w] = str;
    while (B.histOrder.length > 20) delete B.hist[B.histOrder.shift()];
  }
  function liveWatch(id) {
    B.watchOff = window._fbViz.watch(cfg.app + ':viz', baseId(id), function (d) {
      if (!d || B.entryId !== id || !B.ready) return;
      if (d.w && B.myW[d.w]) return;                             // our own write
      if (B.known && d.w && B.known.w === d.w) return;           // already merged
      var get = ((d.n || 1) <= 1 && typeof d.c0 === 'string')
        ? Promise.resolve({ str: d.c0, meta: d })
        : S.readChunked(baseId(id));
      get.then(function (r) {
        if (!r || B.entryId !== id || !B.ready) return;
        liveMerge(id, r.str, r.meta || {});
      }).catch(function (e) { console.warn('[viz] live read failed:', e && (e.code || e.message)); });
    });
  }
  function mmBusy() {
    // Mind Elixir's inline topic editor is a contenteditable box inside the
    // map; refreshing under it would throw away the half-typed topic.
    var a = document.activeElement;
    return !!(a && cfg.mount.contains(a) && (a.isContentEditable || a.id === 'input-box'));
  }
  function liveMerge(id, str, meta) {
    var rdoc; try { rdoc = JSON.parse(str); } catch (e) { return; }
    var rec = { w: meta.w || '', pw: meta.pw || '', str: str };
    remember(rec.w, str);
    B.rev = Math.max(B.rev, meta.rev || 0);
    if (cfg.kind === 'wb') {
      if (!B.api) return;
      var local = B.api.getSceneElementsIncludingDeleted ? B.api.getSceneElementsIncludingDeleted() : B.api.getSceneElements();
      var st = B.api.getAppState() || {};
      var busy = {};
      [st.editingElement, st.draggingElement, st.resizingElement, st.multiElement]
        .forEach(function (el) { if (el && el.id) busy[el.id] = 1; });
      if (st.editingLinearElement && st.editingLinearElement.elementId) busy[st.editingLinearElement.elementId] = 1;
      if (st.selectedElementsAreBeingDragged) Object.keys(st.selectedElementIds || {}).forEach(function (k) { busy[k] = 1; });
      var byId = {}; (local || []).forEach(function (el) { byId[el.id] = el; });
      var out = [], seen = {}, complete = true;
      (rdoc.elements || []).forEach(function (r) {
        var l = byId[r.id], pick = r;
        if (l && (busy[l.id] || l.version > r.version || (l.version === r.version && l.versionNonce < r.versionNonce))) pick = l;
        if (pick !== r && (pick.version !== r.version || pick.versionNonce !== r.versionNonce)) complete = false;
        out.push(pick); seen[r.id] = 1;
      });
      (local || []).forEach(function (l) { if (!seen[l.id]) { out.push(l); if (!l.isDeleted) complete = false; } });
      var have = B.api.getFiles() || {};
      var missing = (rdoc.fileIds || []).filter(function (k) { return !have[k]; });
      (missing.length ? fetchFiles(missing, id) : Promise.resolve({})).then(function (got) {
        if (B.entryId !== id || !B.api) return;
        var add = Object.keys(got).map(function (k) { return got[k]; });
        if (add.length) { try { B.api.addFiles(add); } catch (e) {} }
        var app = rdoc.appState || {};
        var upd = { elements: out, commitToHistory: false };
        if (app.viewBackgroundColor && app.viewBackgroundColor !== lastBg) upd.appState = { viewBackgroundColor: app.viewBackgroundColor };
        B.api.updateScene(upd);
        B.known = rec;
        if (out.some(function (el) { return !el.isDeleted; })) hint.hidden = true;
        afterLiveApply(complete);
      });
      return;
    }
    if (!B.mind) return;
    if (mmBusy()) {
      // Try again once the topic being typed is committed.
      clearTimeout(B.deferT);
      B.deferT = setTimeout(function () { if (B.entryId === id) liveMerge(id, str, meta); }, 500);
      return;
    }
    var rm = rdoc.mind || null;
    if (!rm || !rm.nodeData) return;
    var lm = B.mind.getData();
    var km = null;
    if (B.known) { try { km = JSON.parse(B.known.str).mind; } catch (e) {} }
    var merged;
    if (km && rec.pw === B.known.w && mindSig(lm) === mindSig(km)) merged = rm;   // built on ours, nothing changed here since
    else {
      var bs = B.hist[rec.pw] || (B.known && B.known.str) || null, bm = null;
      if (bs) { try { bm = JSON.parse(bs).mind; } catch (e) {} }
      merged = mergeMind(bm, lm, rm);
    }
    B.known = rec;
    B.mind.refresh(merged);
    var kids = ((merged.nodeData || {}).children || []).length;
    hint.hidden = kids > 0 || !B.editable;
    syncNodeBar();
    afterLiveApply(mindSig(merged) === mindSig(rm));
  }
  function afterLiveApply(sameAsRemote) {
    if (sameAsRemote) {
      // The canvas now shows exactly the cloud copy: record it as saved so the
      // change events this apply causes do not write it straight back.
      var s = null; try { s = serialise(); } catch (e) {}
      if (s) {
        var str = JSON.stringify(s.doc);
        B.lastSerial = str; B.cloudSerial = str; B.count = s.count; B.docTitle = s.title;
        B.dirty = false; B.firstDirtyAt = 0; clearTimeout(B.idleTimer);
        if (cfg.onMeta) { try { cfg.onMeta({ rev: B.rev, count: s.count, title: s.title, kind: cfg.kind }); } catch (e) {} }
      }
    } else {
      markDirty();
    }
  }
  // What a mind map "is" for comparison: its structure and content, not the
  // theme or anything else the library carries for display.
  function mindSig(m) {
    if (!m) return '';
    function strip(n) {
      var o = {};
      Object.keys(n).forEach(function (k) { if (k !== 'parent' && k !== 'children') o[k] = n[k]; });
      o.c = (n.children || []).map(strip);
      return o;
    }
    try { return JSON.stringify([m.nodeData ? strip(m.nodeData) : null, m.arrows || [], m.summaries || [], m.direction]); } catch (e) { return ''; }
  }
  function flatMind(m) {
    var out = {}, order = {};
    if (!m || !m.nodeData) return { nodes: out, order: order, root: null };
    (function walk(n, parent) {
      var o = {};
      Object.keys(n).forEach(function (k) { if (k !== 'parent' && k !== 'children') o[k] = n[k]; });
      out[n.id] = { p: parent, x: JSON.stringify(o) };
      order[n.id] = (n.children || []).map(function (c) { return c.id; });
      (n.children || []).forEach(function (c) { walk(c, n.id); });
    })(m.nodeData, null);
    return { nodes: out, order: order, root: m.nodeData.id };
  }
  function mergeMind(bm, lm, rm) {
    var B0 = flatMind(bm), L = flatMind(lm), R = flatMind(rm);
    var root = L.root || R.root;
    var res = {}, ids = {};
    Object.keys(L.nodes).forEach(function (k) { ids[k] = 1; });
    Object.keys(R.nodes).forEach(function (k) { ids[k] = 1; });
    Object.keys(ids).forEach(function (id) {
      var b = B0.nodes[id], l = L.nodes[id], r = R.nodes[id];
      if (l && r) {
        res[id] = { p: (b && l.p === b.p) ? r.p : l.p, x: (b && l.x === b.x) ? r.x : l.x };
      } else if (l) {
        // Removed on the other side: gone, unless this side changed it since.
        if (b && l.x === b.x && l.p === b.p) return;
        res[id] = { p: l.p, x: l.x };
      } else {
        if (b && r.x === b.x && r.p === b.p) return;
        res[id] = { p: r.p, x: r.x };
      }
    });
    if (!res[root]) res[root] = { p: null, x: (L.nodes[root] || R.nodes[root]).x };
    res[root].p = null;
    Object.keys(res).forEach(function (id) { if (id !== root && (!res[id].p || !res[res[id].p])) res[id].p = root; });
    // Children order: whichever side reordered this parent's children wins;
    // anything the chosen order does not list is appended.
    function kidsOf(pid) {
      var lo = L.order[pid], ro = R.order[pid], bo = B0.order[pid];
      var pick = (lo && bo && lo.join() === bo.join()) ? (ro || lo) : (lo || ro || []);
      var list = pick.filter(function (c) { return res[c] && res[c].p === pid; });
      Object.keys(res).forEach(function (c) { if (res[c].p === pid && list.indexOf(c) < 0) list.push(c); });
      return list;
    }
    var placed = {};
    function build(id, depth) {
      placed[id] = 1;
      var n = JSON.parse(res[id].x);
      var kids = depth > 60 ? [] : kidsOf(id).filter(function (c) { return !placed[c]; });
      n.children = kids.map(function (c) { return build(c, depth + 1); });
      return n;
    }
    var tree = build(root, 0);
    // A parent cycle (A moved under B here, B under A there) leaves nodes
    // unreachable — hang them off the root rather than lose them.
    Object.keys(res).forEach(function (id) { if (!placed[id]) tree.children.push(build(id, 1)); });
    function pickPart(k) {
      var b = bm ? JSON.stringify(bm[k]) : undefined, l = JSON.stringify(lm[k]);
      return (l === b) ? rm[k] : lm[k];
    }
    return { nodeData: tree, arrows: pickPart('arrows') || [], summaries: pickPart('summaries') || [], direction: pickPart('direction'), theme: lm.theme };
  }

  /* ── mount + apply ──────────────────────────────────────────────────── */
  function whenSized() {
    // Both libraries measure their container on mount; mounting into a
    // display:none box gives a 0×0 canvas that never recovers.
    return new Promise(function (res) {
      var tries = 0;
      (function poll() {
        if (cfg.mount.clientWidth > 0 && cfg.mount.clientHeight > 0) return res(true);
        if (++tries > 120) return res(false);
        requestAnimationFrame(poll);
      })();
    });
  }

  function ensureMounted() {
    if (B.mounted) return Promise.resolve();
    return whenSized().then(function () {
      if (cfg.kind === 'wb') return mountExcalidraw();
      return mountMindElixir();
    }).then(function () { B.mounted = true; });
  }

  /* ── Excalidraw ─────────────────────────────────────────────────────── */
  var excProps = null;
  function renderExc() {
    if (!B.root || !excProps) return;
    var L = B.lib;
    var menu = window.React.createElement(L.MainMenu, null, [
      window.React.createElement(L.MainMenu.DefaultItems.LoadScene, { key: 'ls' }),
      window.React.createElement(L.MainMenu.DefaultItems.SaveAsImage, { key: 'si' }),
      window.React.createElement(L.MainMenu.DefaultItems.Export, { key: 'ex' }),
      window.React.createElement(L.MainMenu.Separator, { key: 'sep' }),
      window.React.createElement(L.MainMenu.DefaultItems.ChangeCanvasBackground, { key: 'bg' }),
      window.React.createElement(L.MainMenu.DefaultItems.ClearCanvas, { key: 'cc' }),
      window.React.createElement(L.MainMenu.DefaultItems.Help, { key: 'hp' })
    ]);
    B.root.render(window.React.createElement(L.Excalidraw, excProps, menu));
  }
  function mountExcalidraw() {
    return S.loadExcalidraw().then(function (L) {
      B.lib = L;
      var host = document.createElement('div');
      host.style.cssText = 'position:absolute;inset:0;';
      cfg.mount.insertBefore(host, veil);
      B.root = window.ReactDOM.createRoot(host);
      excProps = {
        excalidrawAPI: function (api) { B.api = api; },
        initialData: { elements: [], appState: { viewBackgroundColor: bgColor() }, scrollToContent: true },
        theme: 'dark',
        langCode: 'en',
        name: cfg.entryTitle ? cfg.entryTitle() : 'Board',
        viewModeEnabled: !B.editable,
        // The journals bind their own Ctrl+S / Ctrl+Z on document; letting
        // Excalidraw also listen globally makes both fire for one keystroke.
        handleKeyboardGlobally: false,
        autoFocus: false,
        UIOptions: {
          // The journal is dark-only for both profiles; a light-mode canvas
          // inside it reads as a bug, not a choice.
          canvasActions: { toggleTheme: false }
        },
        onChange: onExcChange
      };
      renderExc();
      // The API arrives on the first commit; wait for it before anything else
      // tries to push a scene into it.
      return new Promise(function (res) {
        var n = 0;
        (function poll() {
          if (B.api) return res();
          if (++n > 300) return res();
          requestAnimationFrame(poll);
        })();
      });
    });
  }
  var lastSceneVer = -1, lastBg = '';
  function onExcChange(elements, appState) {
    if (!B.ready) return;
    // The ONLY work done per pointer event: one integer compare over the scene
    // version plus a background-colour string compare. No JSON, no allocation,
    // no React state of ours.
    var v = B.lib.getSceneVersion(elements);
    var bg = appState && appState.viewBackgroundColor || '';
    if (v === lastSceneVer && bg === lastBg) return;
    lastSceneVer = v; lastBg = bg;
    markDirty();
  }

  /* ── Mind Elixir ────────────────────────────────────────────────────── */
  function meTheme() {
    var cs = getComputedStyle(cfg.shell);
    function tok(n, d) { var v = (cs.getPropertyValue(n) || '').trim(); return v || d; }
    var accent = tok('--purple', '#8d769a');
    return {
      name: 'Index',
      type: 'dark',
      // Branch colours: the profile accent leads, then a spread that reads
      // clearly on the journal's charcoal without importing another palette.
      palette: [accent, tok('--green', '#5daf6d'), tok('--cyan', '#22d3ee'), tok('--orange', '#fb923c'),
                tok('--red', '#e74c3c'), tok('--purple2', '#6e5c7a'), tok('--text2', '#afb0b5'), accent],
      cssVar: {
        '--node-gap-x': '28px', '--node-gap-y': '10px',
        '--main-gap-x': '58px', '--main-gap-y': '38px',
        '--root-radius': '10px', '--main-radius': '8px',
        '--root-color': tok('--text', '#ececee'),
        '--root-bgcolor': tok('--card2', '#303135'),
        '--root-border-color': accent,
        '--main-color': tok('--text', '#ececee'),
        '--main-bgcolor': tok('--card', '#26272a'),
        '--main-bgcolor-transparent': tok('--card', '#26272a'),
        '--main-border': '1px solid ' + tok('--border2', '#4a4b51'),
        '--topic-padding': '5px',
        '--color': tok('--text2', '#afb0b5'),
        '--bgcolor': tok('--bg', '#1b1c1e'),
        '--selected': accent,
        '--accent-color': accent,
        '--panel-color': tok('--text', '#ececee'),
        '--panel-bgcolor': tok('--card', '#26272a'),
        '--panel-border-color': tok('--border', '#3d3e43'),
        '--map-padding': '40px 60px'
      }
    };
  }
  function mountMindElixir() {
    return S.loadMindElixir().then(function (ME) {
      B.lib = ME;
      var host = document.createElement('div');
      host.className = 'mind-elixir';
      host.style.cssText = 'position:absolute;inset:0;';
      cfg.mount.insertBefore(host, veil);
      B.mind = new ME({
        el: host,
        direction: ME.SIDE,
        draggable: true,
        contextMenu: true,
        toolBar: true,
        keypress: true,
        allowUndo: true,
        // The map scrolls inside its own container; letting it spill would put
        // a second scrollbar on the journal and break the fixed-height layout.
        overflowHidden: false,
        newTopicName: 'New idea',
        theme: meTheme()
      });
      B.mind.init({ nodeData: { id: 'root', topic: DEFAULT_ROOT, root: true, children: [] } });
      // Undo/redo go through refresh(), which does not fire `operation` — so
      // they would silently never be saved without this.
      ['undo', 'redo'].forEach(function (m) {
        var orig = B.mind[m];
        if (typeof orig !== 'function') return;
        B.mind[m] = function () { var r = orig.apply(B.mind, arguments); markDirty(); syncNodeBar(); return r; };
      });
      B.mind.bus.addListener('operation', function () { markDirty(); });
      B.mind.bus.addListener('expandNode', function () { markDirty(); });
      B.mind.bus.addListener('changeDirection', function () { markDirty(); });
      B.mind.bus.addListener('selectNodes', function () { syncNodeBar(); });
      B.mind.bus.addListener('unselectNodes', function () { syncNodeBar(); });
      buildNodeBar();
    });
  }

  /* Touch-first node actions. Mind Elixir binds its own menu to `contextmenu`,
   * which iOS Safari and Android Chrome do not deliver dependably from a long
   * press — so on a tablet the entire editing vocabulary would be unreachable.
   * These call exactly the library's own methods; nothing is reimplemented. */
  var nodeBar = null;
  function buildNodeBar() {
    nodeBar = document.createElement('div');
    nodeBar.className = 'viz-nodebar';
    nodeBar.setAttribute('role', 'toolbar');
    nodeBar.setAttribute('aria-label', 'Node actions');
    var defs = [
      ['plus',    'Child',   'Add child node (Tab)',        function () { B.mind.addChild(); }],
      ['sibling', 'Sibling', 'Add sibling node (Enter)',    function () { B.mind.insertSibling('after'); }],
      ['pencil',  'Rename',  'Rename node (F2)',            function () { B.mind.beginEdit(); }],
      ['fold',    'Fold',    'Collapse or expand branch',   function () { var n = B.mind.currentNode; if (n) { B.mind.expandNode(n); markDirty(); } }],
      ['center',  'Centre',  'Centre the map',              function () { B.mind.toCenter(); }],
      ['undo',    'Undo',    'Undo',                        function () { if (B.mind.undo) B.mind.undo(); }],
      ['redo',    'Redo',    'Redo',                        function () { if (B.mind.redo) B.mind.redo(); }],
      ['trash',   'Delete',  'Delete selected node',        function () {
        var sel = B.mind.currentNodes || [];
        if (!sel.length) return;
        if (sel.length === 1 && !sel[0].nodeObj.parent) return;   // never the root
        B.mind.removeNodes(sel);
      }]
    ];
    defs.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'viz-nodebtn' + (d[0] === 'trash' ? ' viz-danger' : '');
      b.innerHTML = ICON[d[0]] + '<span class="viz-btn-lbl">' + d[1] + '</span>';
      b.title = d[2]; b.setAttribute('aria-label', d[2]);
      b.addEventListener('click', function (e) {
        e.preventDefault();
        if (!B.editable || !B.mind) return;
        try { d[3](); } catch (err) { console.warn('[viz] node action failed:', err && err.message); }
      });
      nodeBar.appendChild(b);
    });
    cfg.mount.appendChild(nodeBar);
    syncNodeBar();
  }
  /* Enable each action only when it can actually do something. Two of them
   * cannot always act, and a button that silently no-ops reads as a broken app:
   *  - Fold needs a node that HAS children. Mind Elixir hangs the expander off
   *    the parent wrapper, and the root has none, so folding the centre node is
   *    not a thing the library can do at all.
   *  - Delete refuses the root, because a mind map without one is not a map. */
  function syncNodeBar() {
    if (!nodeBar) return;
    nodeBar.classList.toggle('viz-on', !!B.editable);
    var sel = (B.mind && B.mind.currentNodes) || [];
    var one = sel.length === 1 ? sel[0] : null;
    var has = sel.length > 0;
    var canFold = !!(one && one.nodeObj && one.nodeObj.parent && (one.nodeObj.children || []).length);
    var canDelete = has && !sel.some(function (e) { return e.nodeObj && !e.nodeObj.parent; });
    var enabled = [has, has, has, canFold, true, true, true, canDelete];
    Array.prototype.forEach.call(nodeBar.children, function (b, i) {
      b.disabled = !enabled[i];
      b.style.opacity = b.disabled ? '.35' : '';
    });
  }

  /* ── apply a document to the live editor ────────────────────────────── */
  function applyDoc(doc, isRemote) {
    if (cfg.kind === 'wb') {
      if (!B.api) return Promise.resolve();
      var els = (doc && doc.elements) || [];
      var app = (doc && doc.appState) || {};
      var inline = (doc && doc._inlineFiles) || null;
      var ids = (doc && doc.fileIds) || [];
      var pre = inline ? Promise.resolve(inline.reduce(function (a, f) { a[f.id] = f; return a; }, {}))
                       : Promise.resolve({});
      return pre.then(function (have) {
        var missing = ids.filter(function (k) { return !have[k]; });
        return fetchFiles(missing).then(function (got) {
          var all = [];
          Object.keys(have).forEach(function (k) { all.push(have[k]); });
          Object.keys(got).forEach(function (k) { all.push(got[k]); });
          if (all.length) { try { B.api.addFiles(all); } catch (e) {} }
          B.api.updateScene({
            elements: B.lib.restoreElements ? B.lib.restoreElements(els, null) : els,
            appState: {
              viewBackgroundColor: app.viewBackgroundColor || bgColor(),
              gridSize: app.gridSize || null,
              gridModeEnabled: !!app.gridModeEnabled
            },
            // Switching entries must not let Ctrl+Z walk back into the previous
            // board — which, once saved, would be an invisible cross-entry wipe.
            commitToHistory: false
          });
          if (!isRemote && B.api.history && B.api.history.clear) { try { B.api.history.clear(); } catch (e) {} }
          if (els.length) {
            if (B.api.scrollToContent) { try { B.api.scrollToContent(els, { fitToContent: true }); } catch (e) {} }
          } else if (!isRemote) {
            // An empty board opens at the origin at 100%, not wherever the last
            // entry happened to leave the viewport.
            try { B.api.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } }, commitToHistory: false }); } catch (e) {}
          }
          lastSceneVer = B.lib.getSceneVersion(B.api.getSceneElements() || []);
          lastBg = app.viewBackgroundColor || bgColor();
          hint.hidden = els.length > 0 || !B.editable;
        });
      });
    }
    if (!B.mind) return Promise.resolve();
    var data = (doc && doc.mind) || null;
    if (!data || !data.nodeData) {
      data = { nodeData: { id: 'root', topic: DEFAULT_ROOT, root: true, children: [] }, arrows: [], summaries: [], direction: B.mind.direction };
    }
    B.mind.refresh(data);
    B.mind.toCenter();
    if (B.mind.clearHistory) { try { B.mind.clearHistory(); } catch (e) {} }
    var kids = (data.nodeData.children || []).length;
    hint.hidden = (kids > 0) || (data.nodeData.topic !== DEFAULT_ROOT) || !B.editable;
    syncNodeBar();
    return Promise.resolve();
  }

  /* ── public: open / close / edit mode ───────────────────────────────── */
  B.open = function (entry) {
    var id = entry.id;
    var tok = ++B.token;
    B.pfx[id] = cfg.prefixFor ? (cfg.prefixFor(entry) || cfg.prefix) : cfg.prefix;
    B.live[id] = !!(cfg.liveFor && cfg.liveFor(entry));
    if (B.entryId === id && B.ready) return Promise.resolve();
    // The previous board is flushed and torn down BEFORE this one claims the
    // controller — close() clears entryId, so setting it first would let the
    // outgoing save land under the incoming entry's id.
    var prior = B.entryId ? B.close() : Promise.resolve();
    setVeil('loading', 'Opening ' + cfg.title.toLowerCase() + '…');
    return prior
      .then(function () {
        if (B.token !== tok) return null;
        B.entryId = id;
        B.ready = false; B.dirty = false; B.firstDirtyAt = 0;
        B.lastSerial = null; B.cloudSerial = null; B.pendingFiles = null;
        B.rev = 0; B.count = 0; B.docTitle = '';
        B.lastLocalEdit = 0; B.lastCloudAt = 0; B.retryIx = 0;
        B.known = null; B.hist = {}; B.histOrder = []; clearTimeout(B.deferT);
        clearTimeout(B.retryTimer);
        setStatus('idle');
        return ensureMounted().then(function () {
          if (B.token !== tok) return null;
          return loadDoc(entry);
        });
      })
      .then(function (r) {
        if (!r || B.token !== tok) return;
        B.rev = r.rev; B.lastSerial = r.serial;
        // A board that came back FROM the cloud is already there — recording that
        // stops the first open from re-uploading a document nobody changed.
        if (r.source !== 'local') B.cloudSerial = r.serial;
        if (r.source === 'cloud' && r.serial) { B.known = { w: r.w || '', str: r.serial }; remember(r.w, r.serial); }
        return applyDoc(r.doc, false).then(function () {
          if (B.token !== tok) return;
          B.ready = true;
          setVeil('off');
          startWatch(id);
        });
      })
      .catch(function (e) {
        if (B.token !== tok) return;
        console.error('[viz] open failed:', e);
        B.ready = false;
        var msg = (e && e.message) || '';
        // The two failures worth wording carefully. Both leave the saved board
        // completely intact — say so, because a blank canvas with an error on it
        // is otherwise indistinguishable from a board that has been lost.
        if (/offline copy|load failed|did not register/i.test(msg)) {
          msg = 'The drawing tools could not be downloaded, and this device has no offline copy of them yet. '
              + 'Your board is safe and unchanged — reconnect and try again.';
        } else if (!msg) {
          msg = 'Something went wrong opening this board. Nothing has been changed.';
        }
        setVeil('error', msg, function () { B.entryId = null; B.open(entry); });
      });
  };

  B.close = function () {
    B.closing = true;
    stopWatch();
    clearTimeout(B.idleTimer);
    clearTimeout(B.retryTimer);
    clearTimeout(B.slowTimer);
    var p = (B.ready && B.dirty) ? save() : Promise.resolve();
    return p.then(function () {
      B.closing = false;
      B.ready = false;
      B.entryId = null;
      if (fsOn) setFs(false);
    });
  };

  B.setEditable = function (on) {
    B.editable = !!on;
    if (cfg.kind === 'wb') {
      if (excProps) { excProps.viewModeEnabled = !B.editable; renderExc(); }
    } else if (B.mind) {
      if (B.editable) B.mind.enableEdit(); else B.mind.disableEdit();
      syncNodeBar();
    }
    if (!B.editable) hint.hidden = true;
    else if (B.ready) hint.hidden = B.count > 0;
  };

  B.stats = function () {
    return B.entryId ? { rev: B.rev, count: B.count, title: B.docTitle, kind: cfg.kind } : null;
  };
  B.isOpen = function (id) { return B.entryId === id; };

  /* ── export ─────────────────────────────────────────────────────────── */
  function exportName(ext) { return safeName(cfg.entryTitle ? cfg.entryTitle() : cfg.title, ext); }

  B.toPngDataUrl = function () {
    if (cfg.kind === 'wb') {
      if (!B.api || !B.lib.exportToBlob) return Promise.resolve('');
      var els = B.api.getSceneElements() || [];
      if (!els.length) return Promise.resolve('');
      return B.lib.exportToBlob({
        elements: els, appState: Object.assign({}, B.api.getAppState(), { exportBackground: true, exportWithDarkMode: false }),
        files: B.api.getFiles(), mimeType: 'image/png', quality: 1, exportPadding: 24
      }).then(blobToDataUrl).catch(function () { return ''; });
    }
    if (!B.mind || !B.mind.exportPng) return Promise.resolve('');
    return B.mind.exportPng(false).then(function (b) { return b ? blobToDataUrl(b) : ''; }).catch(function () { return ''; });
  };
  function blobToDataUrl(blob) {
    return new Promise(function (res) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { res(''); };
      fr.readAsDataURL(blob);
    });
  }

  function doExport(fmt) {
    if (fmt === 'pdf') { if (cfg.onPdf) cfg.onPdf(); return; }
    if (cfg.kind === 'wb') {
      if (!B.api) return;
      var els = B.api.getSceneElements() || [];
      var st = Object.assign({}, B.api.getAppState(), { exportBackground: true, exportWithDarkMode: false });
      var files = B.api.getFiles();
      if (fmt === 'png') {
        B.lib.exportToBlob({ elements: els, appState: st, files: files, mimeType: 'image/png', quality: 1, exportPadding: 24 })
          .then(function (b) { download(b, exportName('png')); })
          .catch(function (e) { console.warn('[viz] png export failed', e); });
      } else if (fmt === 'svg') {
        B.lib.exportToSvg({ elements: els, appState: st, files: files, exportPadding: 24 })
          .then(function (node) {
            download(new Blob([new XMLSerializer().serializeToString(node)], { type: 'image/svg+xml' }), exportName('svg'));
          })
          .catch(function (e) { console.warn('[viz] svg export failed', e); });
      } else if (fmt === 'json') {
        var json = B.lib.serializeAsJSON ? B.lib.serializeAsJSON(els, B.api.getAppState(), files, 'local')
                                         : JSON.stringify({ elements: els });
        download(new Blob([json], { type: 'application/json' }), exportName('excalidraw'));
      }
      return;
    }
    if (!B.mind) return;
    if (fmt === 'png') {
      B.mind.exportPng(false).then(function (b) { if (b) download(b, exportName('png')); })
        .catch(function (e) { console.warn('[viz] png export failed', e); });
    } else if (fmt === 'svg') {
      Promise.resolve(B.mind.exportSvg(false)).then(function (b) { if (b) download(b, exportName('svg')); })
        .catch(function (e) { console.warn('[viz] svg export failed', e); });
    } else if (fmt === 'json') {
      download(new Blob([B.mind.getDataString()], { type: 'application/json' }), exportName('mindmap.json'));
    }
  }

  var menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; document.removeEventListener('pointerdown', onDocDown, true); } }
  function onDocDown(e) { if (menuEl && !menuEl.contains(e.target) && e.target !== btnDl) closeMenu(); }
  btnDl.addEventListener('click', function () {
    if (menuEl) { closeMenu(); return; }
    menuEl = document.createElement('div');
    menuEl.className = 'viz-nodebar viz-on';
    menuEl.setAttribute('role', 'menu');
    menuEl.style.cssText = 'position:absolute;top:42px;right:8px;left:auto;transform:none;bottom:auto;flex-wrap:wrap;';
    [['png', 'PNG'], ['svg', 'SVG'], ['pdf', 'PDF'], ['json', cfg.kind === 'wb' ? 'Editable file' : 'JSON']].forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'viz-nodebtn'; b.setAttribute('role', 'menuitem');
      b.innerHTML = '<span class="viz-btn-lbl" style="display:inline">' + d[1] + '</span>';
      b.addEventListener('click', function () { closeMenu(); doExport(d[0]); });
      menuEl.appendChild(b);
    });
    cfg.shell.appendChild(menuEl);
    setTimeout(function () { document.addEventListener('pointerdown', onDocDown, true); }, 0);
    menuEl.querySelector('button').focus();
  });
  // Escape unwinds one layer at a time: the export menu first, then fullscreen.
  // Both editors get the keystroke before this does (they listen on their own
  // container, which is a descendant), so Escape still deselects inside them.
  cfg.shell.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (menuEl) { closeMenu(); e.stopPropagation(); return; }
    if (fsOn) { setFs(false); e.stopPropagation(); }
  });

  return B;
}

window.VizEngine = { createBoard: createBoard };
})();
