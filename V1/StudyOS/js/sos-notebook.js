/* ============================================================================
 * StudyOS notes — V's Notebook (A1's Notebook, docs/Notebook/README.md)
 * ============================================================================
 * Every text editor StudyOS had is one Notebook now (2026-10-29): the Quick
 * Notes view, each Notes module's pages (the docx "so" editor, js/notes-sync.js
 * until then) and the plain-textarea notes older modules carried. It is Veda's
 * side of Notebook, mounted ONCE as an instance (window.SOS_NOTEBOOK in
 * studyos.html: key stn, store dashboards/studyos_notebook), with one folder
 * per place:
 *
 *   Quick Notes view       folder 'quick'
 *   a Notes module         folder <module id> (class or KSU module)
 *
 * The one instance moves between the two places (Notebook.attach / detach) and
 * switches folder (Notebook.folder), so the list, search, tags, Trash and New
 * Entry always show just that place's pages, as before. Everything else, the
 * editor and its templates, AI tools, sync, is Notebook's: a change there
 * reaches StudyOS by itself. Talk to it only through Notebook's API.
 *
 * MOVING THE OLD NOTES IN (once, Notebook.importPages, which never overwrites
 * a page and records its tag in the store, so it runs on one device only):
 *   - quick notes: the main document's `notes` [{id, title, body, updated}]
 *   - each Notes module: studyos_notes/{moduleId} (server copy) merged with
 *     this device's cache of it, ids, dates, tags, trash and images kept
 *   - every module's old textarea notes (mod.notes), which nothing has shown
 *     since the page editor came in; a non-Notes module's go to Quick Notes
 * The old copies are never written or deleted: they are the backup.
 * ========================================================================== */
(function () {
'use strict';

var NB = window.SOS_NOTEBOOK;
if (!NB) return;
var KEY = NB.key, QUICK = 'quick';
var S = { mount: null, cfg: null, host: null, folder: null };
// tag -> true once a move is done. Kept on the device too (studyos_nb_moved):
// the store records every finished move, so a device that saw one finish never
// needs to ask again, and a later visit costs no reads.
var MOVED_KEY = 'studyos_nb_moved';
var _moved = (function () { try { return JSON.parse(localStorage.getItem(MOVED_KEY) || '{}') || {}; } catch (e) { return {}; } })();
function markMoved(tag) {
  _moved[tag] = true;
  try { localStorage.setItem(MOVED_KEY, JSON.stringify(_moved)); } catch (e) {}
}
var _moving = null;       // the import chain, so two never run at once

function nb() { return window.Notebook; }
function bridge() { return window._sosBridge || {}; }
function snapshot() { try { return bridge().getSnapshot ? bridge().getSnapshot() : null; } catch (e) { return null; } }

/* ── Showing it ─────────────────────────────────────────────────────────── */
function mount(host, folder) {
  if (S.mount) return S.mount;
  if (!nb()) return Promise.reject(new Error('Notebook did not load'));
  var cfg = Object.assign({}, NB, {
    container: host, folder: folder,
    onReady: function () { moveAll(); }
  });
  host.innerHTML = '';
  S.cfg = cfg;
  S.mount = nb().mount(cfg).then(function () { return cfg; });
  return S.mount;
}

// Put the notes in `host`, on `folder`. Resolves once they are on screen.
function show(host, folder) {
  if (!host) return Promise.resolve(false);
  folder = String(folder);
  S.host = host; S.folder = folder;
  host.classList.add('sos-nb-host');
  host.setAttribute('data-nb-loading', '');
  var first = !S.mount;
  var p;
  try { p = mount(host, folder); } catch (e) { p = Promise.reject(e); }
  return p.then(function () {
    if (S.host !== host) return false;           // closed (or moved) while it opened
    host.removeAttribute('data-nb-loading');
    nb().attach(KEY, host);
    var f = nb().folder(KEY, folder);
    refit();
    if (!first && folder !== QUICK) moveModule(folder);
    return f;
  }).catch(function (e) {
    console.warn('[StudyOS] notes could not open:', e);
    if (S.host === host) {
      host.removeAttribute('data-nb-loading');
      host.innerHTML = '<div class="sos-nb-msg">Notes could not open. Check the connection, then reload StudyOS.</div>';
    }
    return false;
  });
}

// The page editor fits its sheet to the width it is given; after a move into
// a new box (or a box that just appeared) it has to measure again.
function refit() {
  [0, 120, 400].forEach(function (ms) { setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }, ms); });
}

// Take the notes off screen: save what is being typed, set them aside (still
// running, so an edit in flight finishes).
function hide(host) {
  if (host && S.host !== host) return;
  try { if (nb() && S.mount) nb().flushAll(); } catch (e) {}
  S.host = null;
  if (nb() && S.mount) nb().detach(KEY);
}

/* ── Moving the old notes in ────────────────────────────────────────────── */
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// A plain-text note as page HTML: a paragraph per blank-line block, its line
// breaks kept.
function textToHtml(t) {
  var blocks = String(t == null ? '' : t).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return blocks.filter(function (b) { return b.trim(); })
    .map(function (b) { return '<p>' + b.split('\n').map(esc).join('<br>') + '</p>'; }).join('') || '<p><br></p>';
}
// Firestore field names: a page id may not hold . / ~ * [ ]
function safeId(id) { return String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '_'); }
function num(v, d) { v = Number(v); return isFinite(v) && v > 0 ? v : d; }

function textPages(notes, folder, prefix, extraTags) {
  return (Array.isArray(notes) ? notes : []).filter(function (n) { return n && n.id != null && (String(n.title || '').trim() || String(n.body || '').trim()); })
    .map(function (n) {
      var t = num(n.updated, Date.now());
      var p = { id: prefix + safeId(n.id), title: String(n.title || ''), folder: folder,
        created: num(n.created, t), updated: t, tags: (extraTags || []).slice(), data: { html: textToHtml(n.body) } };
      if (n._sos) p.host = n._sos;
      return p;
    });
}

// A module's page-editor entries: the server copy, plus anything only this
// device's cache has (an edit that never reached the cloud). The newer copy
// of a page wins.
function editorPages(modId, remote) {
  var byId = {}, order = [];
  function take(list) {
    (Array.isArray(list) ? list : []).forEach(function (e) {
      if (!e || !e.id) return;
      var id = String(e.id), cur = byId[id];
      if (!cur) order.push(id);
      if (!cur || num(e.updated, 0) > num(cur.updated, 0)) byId[id] = e;
    });
  }
  take(remote && remote.entries);
  try { var c = JSON.parse(localStorage.getItem('studyos_notes_' + modId) || 'null'); take(c && c.entries); } catch (e) {}
  return order.map(function (id) {
    var e = byId[id], d = e.data || {};
    var t = num(e.updated, Date.now());
    var p = { id: safeId(id), title: String(e.title || ''), template: 'page', folder: String(modId),
      created: num(e.created, t), updated: t, tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
      data: { html: String(d.html || ''), attachments: Array.isArray(d.attachments) ? d.attachments : [] } };
    if (e.trashed) { p.trashed = e.trashed; p.trashChangedAt = e.trashChangedAt || e.trashed; }
    if (e._sos) p.host = e._sos;
    return p;
  });
}

function notesModules(snap) {
  var out = [];
  (snap && snap.classes || []).forEach(function (c) { (c.modules || []).forEach(function (m) { out.push({ cls: c, mod: m }); }); });
  (snap && snap.ksu && snap.ksu.modules || []).forEach(function (m) { out.push({ cls: { id: 'ksu', name: 'KSU' }, mod: m }); });
  return out;
}

function importOnce(tag, pages) {
  if (_moved[tag]) return Promise.resolve('already');
  // Nothing to move (a module made since): no write; asked again next visit.
  if (!pages.length) return Promise.resolve({ added: [], kept: [], failed: [] });
  return nb().importPages(KEY, pages, tag).then(function (r) {
    if (r === 'already' || (r && !(r.failed || []).length)) markMoved(tag);
    if (r && r.added && r.added.length) console.info('[StudyOS] moved ' + r.added.length + ' note page(s) into Notebook (' + tag + ')');
    if (r && r.failed && r.failed.length) {
      console.warn('[StudyOS] notes that could not move yet (' + tag + '):', r.failed);
      try { window.showNotif && window.showNotif('alert', 'Some notes are still waiting to move', r.failed.length + ' page(s) were too large to store. They are safe where they were.'); } catch (e) {}
    }
    return r;
  });
}

// StudyOS's own data (the quick notes, the class and module list) as the
// SERVER has it: until then this device may hold a stale or empty copy, and a
// move made from that would record itself as done with notes missing.
function serverSeen() {
  return new Promise(function (res) {
    if (window._fbSosServerSeen && window._fbSosServerSeen()) return res();
    window.addEventListener('fb-sos-server-seen', function () { setTimeout(res, 0); }, { once: true });
  });
}

function chain(fn) {
  var run = function () { return serverSeen().then(fn); };
  _moving = (_moving || Promise.resolve()).then(run, run).catch(function (e) {
    console.warn('[StudyOS] moving notes into Notebook paused (it retries next time):', e && e.message);
  });
  return _moving;
}

// One Notes module: its page-editor pages and its old textarea notes.
function moveModule(modId) {
  var tag = 'sos-mod-' + safeId(modId);
  if (_moved[tag]) return Promise.resolve();
  return chain(function () {
    if (_moved[tag]) return;
    var hit = notesModules(snapshot()).filter(function (x) { return String(x.mod.id) === String(modId); })[0];
    if (!hit || hit.mod.type !== 'notes') return;
    var read = window._fbReadOldNotes ? window._fbReadOldNotes(modId) : Promise.resolve(null);
    return read.then(function (remote) {
      var pages = editorPages(modId, remote).concat(textPages(hit.mod.notes, String(modId), 'sosn_' + safeId(modId) + '_'));
      return importOnce(tag, pages).then(function (r) {
        if (r !== 'already') return;
        // Another device moved this module first. Pages only THIS device's
        // cache of the old editor had (written here, never synced) go in now,
        // once per device; a page Notebook already has is never touched.
        var ltag = tag + '-local';
        if (_moved[ltag]) return;
        var onServer = {};
        (remote && remote.entries || []).forEach(function (e) { if (e && e.id) onServer[safeId(e.id)] = true; });
        var mine = editorPages(modId, null).filter(function (p) { return !onServer[p.id]; });
        if (!mine.length) { markMoved(ltag); return; }
        return nb().importPages(KEY, mine, null).then(function (r2) {
          if (r2 && !(r2.failed || []).length) markMoved(ltag);
          if (r2 && r2.added && r2.added.length) console.info('[StudyOS] moved ' + r2.added.length + ' page(s) only this device had (' + tag + ')');
        });
      });
    });
  });
}

// Everything, once per device session: quick notes, then every module.
function moveAll() {
  chain(function () {
    var snap = snapshot();
    if (!snap) return;
    // The quick notes, and the textarea notes of modules that never showed
    // notes (documents, prompts): they go to Quick Notes, tagged with where
    // they came from, so nothing written is left behind.
    var pages = textPages(snap.notes, QUICK, 'sosq_');
    notesModules(snap).forEach(function (x) {
      if (x.mod.type === 'notes') return;
      pages = pages.concat(textPages(x.mod.notes, QUICK, 'sosn_' + safeId(x.mod.id) + '_', [String(x.cls.name || 'KSU'), String(x.mod.name || 'Module')]));
    });
    return importOnce('sos-quick', pages);
  });
  chain(function () {
    notesModules(snapshot()).forEach(function (x) { if (x.mod.type === 'notes') moveModule(x.mod.id); });
  });
  return _moving;
}

/* ── For the rest of StudyOS ────────────────────────────────────────────── */
// The pages in a folder (a Notes module), live ones only, as Notebook keeps them.
function pages(folder) {
  var all = (S.cfg && S.cfg.entries) ? S.cfg.entries() : [];
  return all.filter(function (e) { return e && !e.trashed && e.folder === String(folder); });
}

// A page StudyOS writes itself: the pipeline's generated note, into module
// `folder`. Re-running one source replaces its page (found by host.sourceFileId)
// rather than stacking copies. Mounts the notes (off screen) if they are not up.
function putGenerated(folder, spec) {
  folder = String(folder);
  var ready = S.mount;
  if (!ready) {
    // Off screen: mounted into a hidden holder that stays, until a view shows it.
    var park = document.getElementById('sos-nb-offscreen');
    if (!park) { park = document.createElement('div'); park.id = 'sos-nb-offscreen'; park.style.display = 'none'; document.body.appendChild(park); }
    ready = mount(park, S.folder || folder);
  }
  return Promise.resolve(ready).then(function () {
    return moveModule(folder);
  }).then(function () {
    var src = spec.sourceId ? String(spec.sourceId) : '';
    var all = (S.cfg && S.cfg.entries) ? S.cfg.entries() : [];
    var prior = src && all.filter(function (e) { return e && e.folder === folder && e.host && String(e.host.sourceFileId || '') === src; })[0];
    var id = prior ? prior.id : 'gen_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    return nb().putPage(KEY, {
      id: id, folder: folder, title: String(spec.title || 'Generated note'),
      tags: ['generated'], data: { html: String(spec.html || '') },
      host: Object.assign({ generated: true }, spec.meta || {}, src ? { sourceFileId: src } : {})
    });
  });
}

window.SOSNotes = {
  QUICK: QUICK,
  show: show,
  hide: hide,
  pages: pages,
  putGenerated: putGenerated,
  moveAll: moveAll,
  mounted: function () { return !!S.mount; },
  // For tests: the pure converters.
  _textToHtml: textToHtml,
  _editorPages: editorPages
};

// Leaving the page (or the app going to the background): save what is typed.
window.addEventListener('pagehide', function () { try { if (S.mount && nb()) nb().flushAll(); } catch (e) {} });
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') { try { if (S.mount && nb()) nb().flushAll(); } catch (e) {} }
});
})();
