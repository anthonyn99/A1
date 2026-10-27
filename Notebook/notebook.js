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

   MOUNTING. Notebook.mount({ profile, ... }) puts a side on the page: 'tony'
   (the myjournal app, key tj) or 'veda' (the brainstorm app, key bj). Under its
   own key (index.html) an app is written in place while the page parses. Under
   any other key it is an INSTANCE: the app's own source with its key rewritten
   (tj or bj -> key, its store -> store, ...), its Firestore layer made from the
   @nb-store template in core/fb.js, mounted inline into the host's container.
   A change to either app therefore reaches every instance of that side at once.

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
// makes an instance (see MOUNTING above).
var NATIVE = { brainstorm: 'bj', myjournal: 'tj' };
// Notebook's two sides. A host names a side, not an app:
//   Notebook.mount({ profile: 'tony' })   Tony's journal (MyJournal, tj)
//   Notebook.mount({ profile: 'veda' })   Veda's journal (bj)
// They work and are named the same way (OurJournal + the person's own
// journal); only the colours, fonts and Veda's extra templates differ.
// profile + key + store mounts an instance of that side.
var PROFILES = {
  tony: { app: 'myjournal', key: 'tj', store: 'tony_journal' },
  veda: { app: 'brainstorm', key: 'bj', store: 'journal' }
};
function resolveProfile(cfg) {
  if (!cfg) return cfg;
  // The older { app } form: the profile is the app's side.
  if (cfg.profile === undefined) { if (cfg.app === 'myjournal') cfg.profile = 'tony'; else if (cfg.app === 'brainstorm') cfg.profile = 'veda'; return cfg; }
  var p = PROFILES[cfg.profile];
  if (!p || (cfg.app && cfg.app !== p.app)) throw new Error('Notebook.mount: profile is tony or veda');
  cfg.app = p.app;
  if (!cfg.key) { cfg.key = p.key; cfg.store = cfg.store || p.store; }
  return cfg;
}
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

// A tj source (MyJournal's app and sheet, and the store template every instance
// uses, Veda's side included), rewritten from tj to the instance's key. The tj
// sources name everything by prefix: ids and classes (tj-), functions and state
// (_tj, tjX, TJ_), the store (tony_journal, myjournal_ai...), the loader names
// (_fbLoadTonyJournal) and the title (MyJournal).
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
// A bj source (Veda's app and sheet), rewritten from bj to the instance's key.
// Her loader names carry no prefix (_fbLoadJournal), so they become the names
// the store template defines (_fbLoad<Key>Journal, as MyJournal's do); her
// store literals ('journal', 'journal_img_', brainstorm_journal_v3) become the
// instance's store; her image marker (data-bjkey) becomes the template's
// (data-tjkey). Her name in the UI is not text here: the app reads cfg.title.
function rewriteBj(text, cfg) {
  var K = cfg.key, C = cap(K);
  return text
    .split('brainstorm_journal').join(cfg.store)
    .split("'journal_img_'").join("'" + cfg.store + "_img_'")
    .split("'journal'").join("'" + cfg.store + "'")
    .split('data-bjkey').join('data-tjkey')
    .split("'bjcanvas:'").join("'" + K + "canvas:'")
    .replace(/_fb(Save|Flush|Load|Resync|Delete)Journal/g, '_fb$1' + C + 'Journal')
    .replace(/_fbMigrateJournalIfNeeded/g, '_fbMigrate' + C + 'JournalIfNeeded')
    .replace(/_fbRehydratePageImages/g, '_fbRehydrate' + C + 'PageImages')
    .replace(/Brainstorm(?=[A-Z])/g, C)
    .replace(/(^|[^A-Z])BJ(?![a-z])/g, '$1' + K.toUpperCase())
    .replace(/(^|[^A-Za-z])bj(?![a-z])/g, '$1' + K);
}
function rewriteFor(app) { return app === 'brainstorm' ? rewriteBj : rewrite; }
// An instance runs after the host has parsed, so what the source waits for at
// load (DOMContentLoaded, index's fb-ready) is routed to the instance's own.
function rewriteApp(text, cfg) {
  var K = cfg.key;
  return rewriteFor(cfg.app)(text, cfg)
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

// The rules of a stylesheet that are one app's (a selector naming #tj-root or a
// tj- id/class; bj for Veda's), @media blocks kept around them. notebook.css
// styles MyJournal under #tj-root; an instance needs those rules under its own
// root, and none of the unscoped rest again (the host already has them).
function tjRules(css) { return keyRules(css, 'tj'); }
function keyRules(css, nk) {
  var own = new RegExp('#' + nk + '-root|(^|[^A-Za-z])' + nk + '-');
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  var out = [], i = 0, n = css.length;
  function block(from) {          // index just past the } closing the block opened before `from`
    var d = 1, j = from;
    while (j < n && d) { if (css[j] === '{') d++; else if (css[j] === '}') d--; j++; }
    return j;
  }
  while (i < n) {
    var o = css.indexOf('{', i);
    if (o < 0) break;
    var head = css.slice(i, o).trim(), end = block(o + 1);
    if (/^@media|^@supports/.test(head)) {
      var inner = keyRules(css.slice(o + 1, end - 1), nk);
      if (inner) out.push(head + ' {\n' + inner + '\n}');
    } else if (own.test(head) && !/^@/.test(head)) {
      out.push(head + ' ' + css.slice(o, end));
    }
    i = end;
  }
  return out.join('\n');
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
  // Entry locks are Guardian locks. Loaded unpinned (never ?v=), like every
  // Guardian host, so a Guardian upgrade reaches instances too.
  if (!w.Guardian) jobs.push(loadScript(BASE + '../Guardian/guardian.js'));
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
    if (typeof h.db === 'function' && !h.db()) throw new Error('Notebook: the host\'s Firestore is not up');
    return h;
  });
}
// The F core/fb.js expects from a host (see its header), built from { db, fs }:
// index.html passes its own helpers; another host gets these equivalents.
function hostF(h) {
  // db may be a getter: a host that re-creates its Firestore after a teardown
  // (TradeHub) hands over () => db, so every call reaches the live instance.
  var fs = h.fs, dbGet = typeof h.db === 'function' ? h.db : function () { return h.db; }, noop = function () {};
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
    db: dbGet,
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

// The sheets MyJournal draws on besides its own, in index.html's cascade
// order; myjournal.css goes in at TJ_AT (after Brainstorm's, before the docx
// sheet). Brainstorm's sheet holds the ribbon rule both journals share
// (.docx-toolbar's flex row, padding and gap), and notebook.css's tj rules must
// come AFTER myjournal.css or its .pt-btn colour outranks the AI button's.
// Leaving a sheet out, or taking them in another order, is how Everwell's
// ribbon lost its layout (2026-10-12). tests/notebook-instance.test.js holds
// this order to index.html's.
var TJ_SHEETS = ['core/viz.css', 'core/oj.css', 'apps/brainstorm.css', 'notebook.css'];
var TJ_AT = 3;
// Veda's side the same way: brainstorm.css goes in at BJ_AT, before
// myjournal.css, as in index.html.
var BJ_SHEETS = ['core/viz.css', 'core/oj.css', 'apps/myjournal.css', 'notebook.css'];
var BJ_AT = 2;
// What an instance of each app is made from.
var SPEC = {
  myjournal: { js: 'apps/myjournal.js', css: 'apps/myjournal.css', sheets: TJ_SHEETS, at: TJ_AT },
  brainstorm: { js: 'apps/brainstorm.js', css: 'apps/brainstorm.css', sheets: BJ_SHEETS, at: BJ_AT }
};
function instanceSheet(ownCss, sheets, cfg) {
  var app = cfg.app || 'myjournal', rw = rewriteFor(app), nk = NATIVE[app];
  var parts = sheets.map(function (css) { return rw(keyRules(css, nk), cfg); });
  parts.splice(SPEC[app].at, 0, rw(ownCss, cfg));
  return hostGuard(cfg) + '\n' + parts.join('\n') + '\n' + instanceCss(cfg);
}
// A host's own element rules (Everwell's `select { width: 100% }`, a form
// padding, a font weight) would restyle Notebook's controls: index.html gives a
// bare form control only its Inter font, so MyJournal's show the browser's own
// look in Inter. all:revert + that font puts it back. :where() keeps it at element weight, and this sheet comes after
// the host's, so it beats the host's bare element rules but loses to every
// Notebook rule (each names a class or an id). Then index.html's default hover
// glow for every button in an app root (its :where(#tj-root,...) rule).
function hostGuard(cfg) {
  var R = ':where(#' + cfg.key + '-root)';
  return R + ' :is(input,select,textarea,button){all:revert;font-family:\'Inter\',system-ui,-apple-system,sans-serif;}\n'
    + R + ' :where(button,[role="button"]):hover:not([data-noglow]){box-shadow:var(--suite-glow);}\n'
    + R + ' :where(button,[role="button"]){transition:box-shadow .15s;}\n'
    + R + ' button{transition:box-shadow .15s;}';   // the same, past the revert above
}

// Instance CSS: the app inline in its container instead of over the page, and
// what the host turned off.
function instanceCss(cfg) {
  var R = '#' + cfg.key + '-root', css = [];
  var K = '#' + cfg.key;
  if (cfg.app === 'brainstorm') {
    // What index.html gives Veda's root: her purple hover glow, her body face,
    // and the accent face its :root names. Her header is index's nav (TaskHub,
    // Gita, App Lock, profile); an instance lives inside its host's own.
    css.push(R + '{--suite-glow:0 0 0 1px rgba(141,118,154,.42),0 0 10px rgba(141,118,154,.42);'
      + '--font-accent:\'Fraunces\',Georgia,serif;font-family:\'Nunito\',sans-serif;}');
    css.push(R + ' ' + K + '-nav-header{display:none!important;}');
  }
  if (cfg.mode !== 'overlay') {
    css.push(R + '{position:relative!important;inset:auto!important;z-index:auto!important;'
      + 'display:flex!important;flex-direction:column;width:100%;height:100%;padding-top:0!important;}');
    // What the app pins to the VIEWPORT on a phone (the sidebar drawer, its
    // backdrop, the bottom bar) pins to the instance instead: inside a host's
    // transformed or offset container a fixed drawer peeks out at the edge.
    css.push('@media (max-width: 900px){' + R + ' ' + K + '-sidebar,' + R + ' ' + K + '-sidebar-backdrop{position:absolute!important;height:100%!important;}'
      + R + ' ' + K + '-bottom-bar{position:absolute!important;}}');
  }
  // features.sidebar false: the entry list, its phone drawer and the phone
  // bar's New button go; the host picks the entry (Notebook.open).
  if (cfg.features && cfg.features.sidebar === false) css.push(R + ' ' + K + '-sidebar,' + R + ' ' + K + '-sidebar-backdrop,' + R + ' ' + K + '-bb-new{display:none!important;}');
  if (cfg.features && cfg.features.locks === false) css.push(R + ' ' + K + '-mobile-lock-btn,' + R + ' ' + K + '-btn-lock{display:none!important;}');
  if (Array.isArray(cfg.templates)) css.push(R + ' .template-card' + cfg.templates.map(function (t) { return ':not([data-template="' + t + '"])'; }).join('') + '{display:none!important;}');
  return css.join('\n');
}

// What a host may pass to mount an instance. Anything else is a typo or a
// setting Notebook doesn't have, and a host that silently loses a setting is
// how a program drifts from the others: refuse it. A new setting is added
// here, documented in docs/Notebook/README.md, and defaults so that every
// other program keeps working unchanged.
var OPTIONS = { profile: 1, app: 1, key: 1, store: 1, container: 1, mode: 1, title: 1, templates: 1, features: 1, pinned: 1, onSave: 1, onReady: 1 };
var FEATURES = { ourjournal: 1, locks: 1, sidebar: 1 };
function checkOptions(cfg) {
  Object.keys(cfg).forEach(function (k) { if (!OPTIONS[k]) throw new Error('Notebook.mount: unknown option ' + k); });
  Object.keys(cfg.features || {}).forEach(function (k) { if (!FEATURES[k]) throw new Error('Notebook.mount: unknown feature ' + k); });
  if (cfg.mode && cfg.mode !== 'inline' && cfg.mode !== 'overlay') throw new Error('Notebook.mount: mode is inline or overlay');
}

// Veda's faces, for a host that does not load them (index.html does).
var VEDA_FONTS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Playfair+Display:wght@900&family=Lora:wght@400;700&family=Fraunces:opsz,wght@9..144,400..700&display=swap';
function vedaFonts() {
  if (document.querySelector('link[data-notebook-fonts]')) return;
  var l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = VEDA_FONTS; l.setAttribute('data-notebook-fonts', 'veda');
  document.head.appendChild(l);
}

function instantiate(cfg) {
  var K = cfg.key, spec = SPEC[cfg.app];
  if (cfg.app === 'brainstorm') vedaFonts();
  return helpers()
    .then(function () { return load('core'); })
    .then(function () { return load('docx'); })
    .then(function () { return Promise.all([fetchText(spec.css), fetchText(spec.js), fetchText('core/fb.js')].concat(spec.sheets.map(fetchText))); })
    .then(function (t) {
      var st = document.createElement('style');
      st.setAttribute('data-notebook', K);
      st.textContent = instanceSheet(t[0], t.slice(3), cfg);
      document.head.appendChild(st);
      // The app builds its markup right before its own script element, so the
      // element goes where the markup should: the host's container.
      var el = document.createElement('script');
      el.setAttribute('data-notebook', K);
      el.text = rewriteApp(t[1], cfg) + '\n//# sourceURL=' + BASE + spec.js + '#' + K;
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
  // A host mounts a side: { profile: 'tony' | 'veda' } (PROFILES above; the
  // older { app, key, store } form still works) and, for an instance, adds
  // key + store and:
  //   container   the element it lives in (mode 'inline', the default for an
  //               instance); title (the app's name in its UI);
  //   features    { ourjournal, locks, sidebar } (an instance: ourjournal and
  //               locks off unless set, sidebar on unless set to false);
  //   templates   the template cards to offer, e.g. ['page'];
  //   pinned      [{ id, title, html }] pages always first, never trashed;
  //   onSave(entry), onReady()   hooks.
  // key is the DOM/CSS/localStorage prefix (bj, tj, pb, ...), store its
  // Firestore document under dashboards/. Returns a promise of the config.
  mounts: {},
  profiles: PROFILES,
  mount: function (cfg) {
    cfg = resolveProfile(cfg);
    if (!cfg || !GROUPS[cfg.app] || !NATIVE[cfg.app] || !cfg.key || !/^[a-z]{2,8}$/.test(cfg.key)) throw new Error('Notebook.mount: bad config');
    if (this.mounts[cfg.key]) return this.mounts[cfg.key]._ready;
    if (NATIVE[cfg.app] === cfg.key) { this.mounts[cfg.key] = cfg; load(cfg.app); return (cfg._ready = Promise.resolve(cfg)); }
    if (!cfg.store || !/^[a-z0-9_]+$/.test(cfg.store) || cfg.store === 'tony_journal' || cfg.store === 'journal') throw new Error('Notebook.mount: an instance needs its own store');
    checkOptions(cfg);
    this.mounts[cfg.key] = cfg;
    cfg.mode = cfg.mode || 'inline';
    cfg.features = Object.assign({ ourjournal: false, locks: false, sidebar: true }, cfg.features || {});
    return (cfg._ready = instantiate(cfg));
  },
  // Move a mounted instance into `container` (a host that re-renders its own
  // markup, e.g. TradeHub's React tab), or set it aside, hidden and still
  // running, while the host's spot for it is gone. Both return false when
  // nothing is mounted under `key` yet. A host never moves `#<key>-root` itself.
  attach: function (key, container) {
    var root = document.getElementById(key + '-root');
    if (!root || !this.mounts[key] || !container) return false;
    if (root.parentNode !== container) container.appendChild(root);
    return true;
  },
  detach: function (key) {
    var root = document.getElementById(key + '-root');
    if (!root || !this.mounts[key]) return false;
    var park = document.getElementById('nb-park');
    if (!park) { park = document.createElement('div'); park.id = 'nb-park'; park.style.display = 'none'; document.body.appendChild(park); }
    if (root.parentNode !== park) park.appendChild(root);
    return true;
  },
  // Open entry `id` in the app mounted under `key`, as a click on its row
  // would; opts.edit true/false switches edit/view mode. Waits for the mount
  // and for the entry to load. Resolves true once it is open, false if the
  // entry never turns up.
  open: function (key, id, opts) {
    var cfg = this.mounts[key];
    if (!cfg) return Promise.reject(new Error('Notebook.open: nothing mounted as ' + key));
    return Promise.resolve(cfg._ready).then(function () {
      var f = window['_' + key + 'OpenEntry'];
      if (typeof f !== 'function') throw new Error('Notebook.open: ' + key + ' cannot open entries');
      return f(id, opts);
    });
  },
  // Run fn once the document has parsed (now, for an instance mounted later).
  _whenReady: function (fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else setTimeout(fn, 0);
  },
  _rewrite: rewrite,
  _rewriteApp: rewriteApp,
  _storeSource: storeSource,
  _tjRules: tjRules,
  _instanceSheet: instanceSheet,
  _tjSheets: TJ_SHEETS,
  _tjAt: TJ_AT,
  _rewriteBj: rewriteBj,
  _keyRules: keyRules,
  _spec: SPEC,
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

// <script ... data-lazy>: a host that only mounts an instance later (TradeHub's
// Playbook tab) skips the engines until then; the instance loads them itself.
if (!(me && me.hasAttribute && me.hasAttribute('data-lazy'))) load('core');
})();
