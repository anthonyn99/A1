/* Notebook — the journals (MyJournal, Brainstorm Journal, OurJournal) as one
   program that runs inside whichever host page loads it. It has no page of its
   own. Plan and contract: docs/Notebook/plan.md.

   LOADING. A host loads this file as a classic, SYNCHRONOUS script:
     <script src="Notebook/notebook.js?v=<stamp>"></script>
   and it writes the core engines in right behind its own tag, so they parse and
   run exactly where the host put it (index.html's app lock, NavOrder and
   profile code wrap journal functions while the page parses, so order matters).
   The DOCX editor and its stylesheet load at a second spot the host picks with
   Notebook.load('docx'), which keeps their place in the CSS cascade.

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
  core: ['core/jguard.js', 'core/viz.css', 'core/viz.js', 'core/oj.css', 'core/oj.js', 'core/fb.js'],
  docx: ['notebook.css', 'core/docx.js'],
  // Apps: Notebook.mount({ app }) loads one where the host calls it.
  brainstorm: ['apps/brainstorm.css', 'apps/brainstorm.js']
};
var loaded = {};

function url(f) { return BASE + f + (STAMP ? '?v=' + STAMP : ''); }

function load(group) {
  if (loaded[group]) return;
  var files = GROUPS[group];
  if (!files) throw new Error('Notebook: no group ' + group);
  loaded[group] = true;
  if (document.readyState === 'loading') {
    // During parsing a written tag is parsed next, so scripts run in order,
    // blocking, at this exact point in the document.
    document.write(files.map(function (f) {
      return /\.css$/.test(f)
        ? '<link rel="stylesheet" href="' + url(f) + '">'
        : '<script src="' + url(f) + '"><\/script>';
    }).join(''));
    return;
  }
  // A host that loads Notebook after parsing: ordered, but asynchronous.
  files.forEach(function (f) {
    var el;
    if (/\.css$/.test(f)) { el = document.createElement('link'); el.rel = 'stylesheet'; el.href = url(f); }
    else { el = document.createElement('script'); el.src = url(f); el.async = false; }
    document.head.appendChild(el);
  });
}

window.Notebook = {
  version: STAMP,
  base: BASE,
  load: load,
  // A host mounts an app where its markup should sit: { app, key, store }.
  // key is the DOM/CSS/localStorage prefix (bj, tj, ...), store its Firestore
  // document under dashboards/.
  mounts: {},
  mount: function (cfg) {
    if (!cfg || !GROUPS[cfg.app] || !cfg.key) throw new Error('Notebook.mount: bad config');
    if (this.mounts[cfg.key]) return;
    this.mounts[cfg.key] = cfg;
    load(cfg.app);
  },
  // DOCX editor config per app key (tj, bj, ...). core/docx.js reads this
  // object as its APPS registry; an app registered after the editor has
  // initialised is initialised on arrival.
  docxApps: {},
  registerDocx: function (app, cfg) {
    this.docxApps[app] = cfg;
    if (this._docxInitApp) this._docxInitApp(app);
  }
};

load('core');
})();
