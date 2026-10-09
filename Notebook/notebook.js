/* Notebook — the journals (MyJournal, Brainstorm Journal, OurJournal) as one
   program that runs inside whichever host page loads it. It has no page of its
   own. Contract: docs/Notebook/README.md. Plan: docs/Notebook/plan.md.

   LOADING. A host loads this file as a classic, SYNCHRONOUS script:
     <script src="Notebook/notebook.js?v=<stamp>"></script>
   and it writes the core engines in right behind its own tag, so they parse and
   run exactly where the host put it (index.html's app lock, NavOrder and
   profile code wrap journal functions while the page parses, so order matters).
   The DOCX editor and its stylesheet load at a second spot the host picks with
   Notebook.load('docx'), which keeps their place in the CSS cascade.

   MOUNTING. Notebook.mount({ app, key, store, ... }) puts an app on the page.
   An app under its own key (brainstorm as bj, myjournal as tj: index.html) is
   written in place while the page parses. Under any other key it is an
   INSTANCE: the app's own source with its key rewritten (tj -> key, the
   tony_journal store -> store, ...), its Firestore layer made the same way from
   the @nb-store template in core/fb.js, mounted inline into the host's
   container. A change to MyJournal therefore reaches every instance at once.

   The ?v= stamp is a hash of this folder (tools/notebook-stamp.js). Every file
   written from here carries the same stamp, so one bump busts GitHub Pages'
   10-minute cache for all of them; tests/notebook-wiring.test.js fails when a
   host's stamp is stale. */
(function () {
'use strict';
if (window.Notebook) return;

var me = document.currentScript;
var src = (me && me.src) || '';
var BASE = src.replace(/[^\/]*$/, '');                 // .../Notebook/
var STAMP = (src.match(/[?&]v=([^&#]+)/) || [])[1] || '';

// What each group loads, in order. Stylesheets keep their cascade position.
var GROUPS = {
  core: ['core/jguard.js', 'core/viz.css', 'core/viz.js', 'core/oj.css', 'core/oj.js', 'core/fb.js', 'core/md.js'],
  docx: ['notebook.css', 'core/docx.js'],
  // Apps: Notebook.mount({ app }) loads one where the host calls it.
  brainstorm: ['apps/brainstorm.css', 'apps/brainstorm.js'],
  myjournal: ['apps/myjournal.css', 'apps/myjournal.js']
};
// The key each app's source is written for. Mounting it under another key
// makes an instance (see MOUNTING above); only myjournal can be instanced.
var NATIVE = { brainstorm: 'bj', myjournal: 'tj' };
var loaded = {};

function url(f) { return BASE + f + (STAMP ? '?v=' + STAMP : ''); }

function load(group) {
  if (loaded[group]) return loaded[group];
  var files = GROUPS[group];
  if (!files) throw new Error('Notebook: no group ' + group);
  if (document.readyState === 'loading') {
    // During parsing a written tag is parsed next, so scripts run in order,
    // blocking, at this exact point in the document.
    loaded[group] = Promise.resolve();
    document.write(files.map(function (f) {
      return /\.css$/.test(f)
        ? '<link rel="stylesheet" href="' + url(f) + '">'
        : '<script src="' + url(f) + '"><\/script>';
    }).join(''));
    return loaded[group];
  }
  // A host that loads Notebook after parsing: ordered, but asynchronous. The
  // promise settles when the last script has run.
  var last = null;
  files.forEach(function (f) {
    var el;
    if (/\.css$/.test(f)) { el = document.createElement('link'); el.rel = 'stylesheet'; el.href = url(f); }
    else { el = document.createElement('script'); el.src = url(f); el.async = false; last = el; }
    document.head.appendChild(el);
  });
  loaded[group] = new Promise(function (res, rej) {
    if (!last) return res();
    last.onload = function () { res(); };
    last.onerror = function () { rej(new Error('Notebook: ' + group + ' failed to load')); };
  });
  return loaded[group];
}

// ── Instances ───────────────────────────────────────────────────────────────
function cap(k) { return k.charAt(0).toUpperCase() + k.slice(1); }

// The app's source, rewritten from its native key (tj) to the instance's.
// The tj sources name everything by prefix: ids and classes (tj-), functions
// and state (_tj, tjX, TJ_), the store (tony_journal, myjournal_ai...), the
// loader names (_fbLoadTonyJournal) and the title (MyJournal).
// tests/notebook-instance.test.js holds that nothing of tj's survives a rewrite
// to another key, and that the result still parses.
function rewrite(text, cfg) {
  var K = cfg.key;
  return text
    .split('tony_journal').join(cfg.store)
    .split('myjournal_ai').join(cfg.store + '_ai')
    .replace(/Tony(?=[A-Z])/g, cap(K))
    .replace(/(^|[^A-Z])TJ(?![a-z])/g, '$1' + K.toUpperCase())
    .replace(/(^|[^A-Za-z])tj(?![a-z])/g, '$1' + K)
    .split('MyJournal').join(cfg.title || cap(K));
}
// An instance runs after the host has parsed, so what the source waits for at
// load (DOMContentLoaded, index's fb-ready) is routed to the instance's own.
function rewriteApp(text, cfg) {
  var K = cfg.key;
  return rewrite(text, cfg)
    .split("document.addEventListener('DOMContentLoaded', ").join('window.Notebook._whenReady(')
    .split("window.addEventListener('fb-ready', ").join("window.addEventListener('nb-" + K + "-fb-ready', ")
    .split('window._fbReady').join('window._nb' + cap(K) + 'FbReady');
}
// The instance's Firestore layer: core/fb.js's host bindings, the tj state and
// guards, the helpers it shares with Brainstorm's block, and tj's install block
// (everything between its @nb- markers), as one self-contained store.
function storeSource(fb, cfg) {
  function between(a, b, from) {
    var i = fb.indexOf(a, from || 0), j = fb.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error('Notebook: fb.js marker ' + a);
    return { text: fb.slice(i + a.length, j), end: j };
  }
  var host = between("'use strict';\n", '// ── State that outlives').text;
  var st1 = between('// @nb-store {\n', '// @nb-store }');
  var sh1 = between('// @nb-shared {\n', '// @nb-shared }');
  var sh2 = between('// @nb-shared {\n', '// @nb-shared }', sh1.end);
  var st2 = between('// @nb-store {\n', '// @nb-store }', st1.end);
  var assign = between('function install(F) {\n', '\n\n').text;
  return '(function () {\n\'use strict\';\n' + host + st1.text
    + 'return {\ninstall: function (F) {\n' + assign + '\n' + sh1.text + sh2.text + st2.text + '},\n'
    + 'unsubscribe: function () { if (_tjUnsubscribe) { _tjUnsubscribe(); _tjUnsubscribe = null; } },\n'
    + 'rearm: function () { _tjServerSeen = false; },\n'
    + 'serverSeen: function () { return _tjServerSeen; }\n};\n})()';
}

function fetchText(f) {
  return fetch(url(f)).then(function (r) {
    if (!r.ok) throw new Error('Notebook: ' + f + ' ' + r.status);
    return r.text();
  });
}
function loadScript(href) {
  return new Promise(function (res, rej) {
    var el = document.createElement('script');
    el.src = href; el.onload = function () { res(); }; el.onerror = function () { rej(new Error('Notebook: ' + href)); };
    document.head.appendChild(el);
  });
}

// What the apps borrow from a host, with a stand-in where the host has none.
function helpers() {
  var w = window, jobs = [];
  if (!w.TNI) jobs.push(loadScript(BASE + '../tni.js' + (STAMP ? '?v=' + STAMP : '')));
  if (!w.A1Drag) jobs.push(loadScript(BASE + '../dragsort.js' + (STAMP ? '?v=' + STAMP : '')));
  if (!w.uiAlert) w.uiAlert = function (m) { w.alert(String(m == null ? '' : m)); return Promise.resolve(); };
  if (!w.uiConfirm) w.uiConfirm = function (m) { return Promise.resolve(w.confirm(String(m == null ? '' : m))); };
  if (!w.uiPrompt) w.uiPrompt = function (m) { return Promise.resolve(w.prompt(String(m == null ? '' : m), '')); };
  if (!w.uiForm) w.uiForm = function (o) {
    var out = {};
    for (var i = 0; i < ((o && o.fields) || []).length; i++) {
      var f = o.fields[i], v = w.prompt(f.label || f.name, f.value || '');
      if (v === null) return Promise.resolve(null);
      out[f.name] = v;
    }
    return Promise.resolve(out);
  };
  return Promise.all(jobs);
}

// The host's Firestore: window.NotebookFirebase() -> { db, fs } (fs: the
// firebase-firestore module), as LifeHub's LifeHubFirebase.
function hostFirestore() {
  if (typeof window.NotebookFirebase !== 'function') return Promise.reject(new Error('Notebook: the host has no window.NotebookFirebase()'));
  return Promise.resolve(window.NotebookFirebase()).then(function (h) {
    if (!h || !h.db || !h.fs) throw new Error('Notebook: NotebookFirebase() gave no { db, fs }');
    return h;
  });
}
// The F core/fb.js expects from a host (see its header), built from { db, fs }:
// index.html passes its own helpers; another host gets these equivalents.
function hostF(h) {
  var fs = h.fs, db = h.db, noop = function () {};
  var transient = { unavailable: 1, 'deadline-exceeded': 1, aborted: 1, internal: 1, cancelled: 1, unknown: 1 };
  function writeRetry(fn, label) {
    var attempt = 0;
    function go() {
      return Promise.resolve().then(fn).catch(function (err) {
        if (!transient[err && err.code] || attempt >= 3) throw err;
        console.warn((label || 'fb') + ': transient write error, retry ' + (attempt + 1), err.code);
        var wait = 400 * Math.pow(2, attempt++);
        return new Promise(function (r) { setTimeout(r, wait); }).then(go);
      });
    }
    return go();
  }
  var SERVER = typeof WeakSet === 'function' ? new WeakSet() : null;
  return {
    db: function () { return db; },
    doc: fs.doc, getDoc: fs.getDoc, getDocFromCache: fs.getDocFromCache || fs.getDoc, setDoc: fs.setDoc,
    updateDoc: fs.updateDoc, deleteDoc: fs.deleteDoc, deleteField: fs.deleteField, onSnapshot: fs.onSnapshot,
    writeRetry: writeRetry,
    upsert: function (ref, payload, label) {
      return writeRetry(function () {
        return fs.updateDoc(ref, payload).catch(function (err) {
          if (err && err.code === 'not-found') return fs.setDoc(ref, payload);
          throw err;
        });
      }, label);
    },
    byteSize: function (o) { try { return new Blob([JSON.stringify(o || {})]).size; } catch (e) { return JSON.stringify(o || {}).length; } },
    maxWriteBytes: 900000,
    a1b: noop,
    // A read the server confirmed; a cache fallback is never "server seen".
    freshGet: function (ref) {
      return (fs.getDocFromServer || fs.getDoc)(ref)
        .then(function (s) { if (SERVER && s) SERVER.add(s); return s; })
        .catch(function () { return fs.getDoc(ref).catch(function () { return null; }); });
    },
    isServerSnap: function (s) { return !!(s && SERVER && SERVER.has(s)); },
    watchStall: noop, stopStall: noop, stallRetry: {}
  };
}

// Instance CSS: the app inline in its container instead of over the page, and
// what the host turned off.
function instanceCss(cfg) {
  var R = '#' + cfg.key + '-root', css = [];
  if (cfg.mode !== 'overlay') css.push(R + '{position:relative!important;inset:auto!important;z-index:auto!important;'
    + 'display:flex!important;flex-direction:column;width:100%;height:100%;padding-top:0!important;}');
  if (cfg.features && cfg.features.locks === false) css.push(R + ' [id$="-lock-btn"],' + R + ' [id$="-btn-lock"]{display:none!important;}');
  if (Array.isArray(cfg.templates)) css.push(R + ' .template-card' + cfg.templates.map(function (t) { return ':not([data-template="' + t + '"])'; }).join('') + '{display:none!important;}');
  if (!window._pwReset) css.push(R + ' [id$="-lock-forgot"],' + R + ' [id$="-lock-reset"]{display:none!important;}');
  return css.join('\n');
}

function instantiate(cfg) {
  var K = cfg.key;
  return helpers()
    .then(function () { return load('core'); })
    .then(function () { return load('docx'); })
    .then(function () { return Promise.all([fetchText('apps/myjournal.css'), fetchText('apps/myjournal.js'), fetchText('core/fb.js')]); })
    .then(function (t) {
      var st = document.createElement('style');
      st.setAttribute('data-notebook', K);
      st.textContent = rewrite(t[0], cfg) + '\n' + instanceCss(cfg);
      document.head.appendChild(st);
      // The app builds its markup right before its own script element, so the
      // element goes where the markup should: the host's container.
      var el = document.createElement('script');
      el.setAttribute('data-notebook', K);
      el.text = rewriteApp(t[1], cfg) + '\n//# sourceURL=' + BASE + 'apps/myjournal.js#' + K;
      (cfg.container || document.body).appendChild(el);
      var store = (0, eval)(rewrite(storeSource(t[2], cfg), cfg) + '\n//# sourceURL=' + BASE + 'core/fb.js#' + K);
      return hostFirestore().then(function (h) {
        window.Notebook.fb.addStore(K, store, hostF(h));
        window['_nb' + cap(K) + 'FbReady'] = true;
        window.dispatchEvent(new Event('nb-' + K + '-fb-ready'));
        return window.Notebook.mounts[K];
      });
    });
}

window.Notebook = {
  version: STAMP,
  base: BASE,
  load: load,
  // A host mounts an app: { app, key, store } and, for an instance:
  //   container   the element it lives in (mode 'inline', the default for an
  //               instance); title (the app's name in its UI);
  //   features    { ourjournal, locks } (an instance: both off unless set);
  //   templates   the template cards to offer, e.g. ['page'];
  //   pinned      [{ id, title, html }] pages always first, never trashed;
  //   onSave(entry), onReady()   hooks.
  // key is the DOM/CSS/localStorage prefix (bj, tj, pb, ...), store its
  // Firestore document under dashboards/. Returns a promise of the config.
  mounts: {},
  mount: function (cfg) {
    if (!cfg || !GROUPS[cfg.app] || !NATIVE[cfg.app] || !cfg.key || !/^[a-z]{2,8}$/.test(cfg.key)) throw new Error('Notebook.mount: bad config');
    if (this.mounts[cfg.key]) return this.mounts[cfg.key]._ready;
    if (NATIVE[cfg.app] === cfg.key) { this.mounts[cfg.key] = cfg; load(cfg.app); return (cfg._ready = Promise.resolve(cfg)); }
    if (cfg.app !== 'myjournal') throw new Error('Notebook.mount: only myjournal can take another key');
    if (!cfg.store || !/^[a-z0-9_]+$/.test(cfg.store) || cfg.store === 'tony_journal' || cfg.store === 'journal') throw new Error('Notebook.mount: an instance needs its own store');
    this.mounts[cfg.key] = cfg;
    cfg.mode = cfg.mode || 'inline';
    cfg.features = Object.assign({ ourjournal: false, locks: false }, cfg.features || {});
    return (cfg._ready = instantiate(cfg));
  },
  // Run fn once the document has parsed (now, for an instance mounted later).
  _whenReady: function (fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else setTimeout(fn, 0);
  },
  _rewrite: rewrite,
  _rewriteApp: rewriteApp,
  _storeSource: storeSource,
  // DOCX editor config per app key (tj, bj, ...). core/docx.js reads this
  // object as its APPS registry; an app registered after the editor has
  // initialised is initialised on arrival.
  docxApps: {},
  // Persist every mounted journal's pending edit right now (the host's
  // pagehide / hidden-tab safety net calls this). Mount order: bj, then tj.
  flushAll: function () {
    Object.keys(this.mounts).forEach(function (key) {
      try { var f = window['_' + key + 'PersistNow']; if (f) f(); } catch (e) {}
    });
  },
  registerDocx: function (app, cfg) {
    this.docxApps[app] = cfg;
    if (this._docxInitApp) this._docxInitApp(app);
  }
};

load('core');
})();
