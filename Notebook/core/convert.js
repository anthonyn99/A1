/* Page only (Tony, 2026-11-17): Notebook has one template, Page, on both sides
   and in OurJournal (Tony's Journal Entries stays until he retires it). Every
   entry made with another one (Whiteboard, Mind Map, the old canvas Mind Map,
   Notes, Cornell) becomes a Page the first time an app meets it:

     - its words carry over as headed sections (Notes, Cornell), a mind map as a
       picture of the map plus its outline, a whiteboard as a picture plus any
       text written on it; its attachments go onto the page (images inline,
       files as file chips), and a short line says what it was;
     - BEFORE anything changes, the whole entry as it was is written to its own
       document, dashboards/<store>_legacy_<entryId> (never inside the journal,
       which is near Firestore's size limit), and nothing is converted until
       that write is confirmed. The boards' own documents (<store>_viz_*,
       <store>_canvas_*) are never touched either. So any conversion can be
       undone by hand.

   The apps call NotebookConvert.page(entry, opts) and do their own saving, so a
   converted entry is a normal edit (a new revision) on every path: the personal
   journals and OurJournal alike. Boards are drawn by VizEngine (core/viz.js) in
   a hidden, read-only box: an untouched board writes nothing.
   tests/live/notebook-pageonly.live.js proves it on both sides. */
(function () {
'use strict';
if (window.NotebookConvert) return;

var KEEP = { page: 1, 'journal-entries': 1 };
var LABEL = { whiteboard: 'Whiteboard', mindmap: 'Mind Map', 'mindmap-legacy': 'Mind Map', notes: 'Notes', cornell: 'Cornell notes' };

function legacy(e) { return !!e && !!e.template && !KEEP[e.template]; }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// Plain text (a textarea's value) as paragraphs: blank lines split them, single
// line breaks stay, and web addresses become links.
function paras(t) {
  t = String(t == null ? '' : t).replace(/\r\n?/g, '\n').trim();
  if (!t) return '';
  return t.split(/\n{2,}/).map(function (p) {
    var h = esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');
    return '<p>' + h + '</p>';
  }).join('');
}
function section(title, text) { var b = paras(text); return b ? '<h2>' + esc(title) + '</h2>' + b : ''; }
function when(ts) {
  try { return new Date(ts || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return ''; }
}

// A mind map's tree (Mind Elixir nodeData) as a nested list.
function outline(node, depth) {
  if (!node || depth > 30) return '';
  var kids = (node.children || []).map(function (c) { return outline(c, depth + 1); }).join('');
  var self = '<li>' + esc(node.topic || '') + (kids ? '<ul>' + kids + '</ul>' : '') + '</li>';
  return depth === 0 ? '<ul>' + self + '</ul>' : self;
}
// The old canvas mind map's nodes/edges, walked from the root, for when the
// board cannot be drawn (offline): never lose the words.
function graphOutline(d) {
  var nodes = (d && d.nodes) || [];
  if (!nodes.length) return '';
  var byId = {}, kids = {}, used = {};
  nodes.forEach(function (n) { byId[n.id] = n; });
  ((d && d.edges) || []).forEach(function (e) {
    var a = e.from != null ? e.from : e.a, b = e.to != null ? e.to : e.b;
    if (a != null && b != null) (kids[a] = kids[a] || []).push(b);
  });
  function tree(n, depth) {
    used[n.id] = true;
    var o = { topic: n.label == null ? '' : String(n.label) };
    if (depth < 24) o.children = (kids[n.id] || []).filter(function (c) { return byId[c] && !used[c]; }).map(function (c) { return tree(byId[c], depth + 1); });
    return o;
  }
  var root = tree(nodes.find(function (n) { return n.root; }) || nodes[0], 0);
  nodes.forEach(function (n) { if (!used[n.id]) root.children.push({ topic: n.label == null ? '' : String(n.label) }); });
  return outline(root, 0);
}

// A board picture small enough for one image document (the journals move a
// page's images out to their own documents on save; Firestore caps each at 1 MB).
function shrink(dataURL) {
  return new Promise(function (res) {
    if (!dataURL) return res('');
    var img = new Image();
    img.onload = function () {
      var max = 1600, w = img.naturalWidth || 1, h = img.naturalHeight || 1, k = Math.min(1, max / Math.max(w, h));
      try {
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        var x = c.getContext('2d');
        x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
        x.drawImage(img, 0, 0, c.width, c.height);
        var out = c.toDataURL('image/jpeg', 0.86);
        if (out.length > 900000) out = c.toDataURL('image/jpeg', 0.7);
        res(out.length > 980000 ? '' : out);
      } catch (e) { res(''); }
    };
    img.onerror = function () { res(''); };
    img.src = dataURL;
  });
}

// One hidden, read-only board per kind and app, drawn off screen.
var BOARDS = {};
function hiddenBoard(kind, o) {
  var key = o.app + ':' + kind;
  if (BOARDS[key]) return BOARDS[key];
  if (!window.VizEngine) return null;
  var shell = document.createElement('div');
  shell.className = 'viz-shell nb-convert-shell';
  shell.setAttribute('aria-hidden', 'true');
  shell.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;height:800px;display:flex;pointer-events:none;';
  var mount = document.createElement('div');
  mount.className = 'viz-mount';
  mount.style.cssText = 'flex:1;position:relative;';
  shell.appendChild(mount);
  document.body.appendChild(shell);
  BOARDS[key] = window.VizEngine.createBoard({
    kind: kind, app: o.app, prefix: o.prefix,
    prefixFor: o.prefixFor, liveFor: function () { return false; },
    shell: shell, mount: mount, title: kind === 'wb' ? 'Whiteboard' : 'Mind Map',
    setSync: function () {}, entryTitle: function () { return 'Converted'; },
    onMeta: function () {}, onPdf: function () {}
  });
  return BOARDS[key];
}
// Open the board read-only, take its picture and its words, close it. Resolves
// { img, text } or null when it cannot be drawn (offline, the drawing tools not
// downloaded): the caller then waits for a later visit.
var chain = Promise.resolve();
function drawBoard(entry, kind, o) {
  var run = function () {
    var B = hiddenBoard(kind, o);
    if (!B) return null;
    var done = false;
    return new Promise(function (res) {
      var t = setTimeout(function () { if (!done) { done = true; res(null); } }, 45000);
      try { B.setEditable(false); } catch (e) {}
      Promise.resolve(B.open(entry)).then(function () {
        if (done) return;
        if (!B.ready) { done = true; clearTimeout(t); return res(null); }
        var text = '';
        try {
          if (kind === 'mm' && B.mind && B.mind.getData) text = outline((B.mind.getData() || {}).nodeData, 0);
          if (kind === 'wb' && B.api) {
            var words = (B.api.getSceneElements() || []).filter(function (el) { return el.type === 'text' && el.text; }).map(function (el) { return el.text; });
            if (words.length) text = '<ul>' + words.map(function (w) { return '<li>' + esc(w).replace(/\n/g, '<br>') + '</li>'; }).join('') + '</ul>';
          }
        } catch (e) {}
        return B.toPngDataUrl().then(shrink).then(function (img) {
          if (done) return;
          done = true; clearTimeout(t);
          res({ img: img, text: text });
        });
      }).catch(function () { if (!done) { done = true; clearTimeout(t); res(null); } });
    }).then(function (r) {
      return Promise.resolve(B.close()).catch(function () {}).then(function () { return r; });
    });
  };
  // One board at a time: they share the hidden box.
  var p = chain.then(run, run);
  chain = p.catch(function () {});
  return p;
}

function attachments(list, chipClass) {
  var out = '';
  (list || []).forEach(function (a) {
    if (!a || !a.data) return;
    if (a.mime && a.mime.indexOf('image/') === 0) out += '<p><img src="' + a.data + '" alt="' + esc(a.name || '') + '"></p>';
    else out += '<p><a class="' + chipClass + '" href="' + a.data + '" download="' + esc(a.name || 'file') + '" contenteditable="false">' + esc(a.name || 'file') + '</a></p>';
  });
  return out ? '<h2>Attachments</h2>' + out : '';
}

/* The page an entry becomes. opts: { app, prefix, prefixFor, chipClass }.
   Resolves its html, or null when it has to wait (a board that cannot be drawn
   right now). */
function page(entry, o) {
  var d = entry.data || {}, t = entry.template, label = LABEL[t] || t;
  var note = '<p><em>Converted from ' + (/^[AEIOU]/.test(label) ? 'an ' : 'a ') + esc(label) + ' on ' + esc(when()) + '. The original is kept as a backup.</em></p>';
  var att = attachments(d.attachments, o.chipClass || 'nb-file-chip');
  if (t === 'notes') return Promise.resolve(note + section('Main notes', d.main) + section('Links & resources', d.links) + section('Questions', d.questions) + att);
  if (t === 'cornell') return Promise.resolve(note + section('Topic', d.topic) + section('Cues & keywords', d.cues) + section('Notes', d.notes) + section('Summary', d.summary) + att);
  if (t === 'whiteboard' || t === 'mindmap' || t === 'mindmap-legacy') {
    var kind = t === 'whiteboard' ? 'wb' : 'mm';
    // A board that was never drawn on has nothing to picture.
    var empty = kind === 'wb' ? !(entry.vizCount || (d && d.canvas)) && entry.vizRev == null && !entry.vizKind
      : !(d.nodes && d.nodes.length) && !entry.vizCount && entry.vizRev == null;
    if (empty) return Promise.resolve(note + att);
    // The engine reads the old canvas mind map (data.nodes) as a 'mindmap'.
    var asBoard = t === 'mindmap-legacy' ? Object.assign({}, entry, { template: 'mindmap' }) : entry;
    return drawBoard(asBoard, kind, o).then(function (r) {
      if (!r) {
        // Not drawable now. The old canvas mind map still has its words on the
        // entry, so it converts without its picture; a board waits for a later visit.
        if (t === 'mindmap-legacy') return note + graphOutline(d) + att;
        return null;
      }
      var body = (r.img ? '<p><img src="' + r.img + '" alt="' + esc(label) + '"></p>' : '') + (r.text ? (kind === 'mm' ? '<h2>Outline</h2>' : '<h2>Text on the board</h2>') + r.text : '');
      if (!body && t === 'mindmap-legacy') body = graphOutline(d);
      return note + body + att;
    });
  }
  // Anything else unknown: keep whatever html it had.
  return Promise.resolve(note + (typeof d.html === 'string' ? d.html : '') + att);
}

// The entry as it was, in its own document, before anything changes. Resolves
// true once the cloud has it (or already had it).
function backup(prefix, entry) {
  var fbv = window._fbViz;
  if (!fbv || !fbv.set) return Promise.resolve(false);
  var id = prefix + '_legacy_' + entry.id;
  var copy;
  try { copy = JSON.parse(JSON.stringify(entry)); } catch (e) { return Promise.resolve(false); }
  delete copy._dirty; delete copy._fbPushed;
  var doc = { entry: copy, template: entry.template, convertedAt: Date.now(), note: 'Notebook page-only conversion (2026-11-17): this entry as it was.' };
  return Promise.resolve(fbv.get ? fbv.get(id).catch(function () { return null; }) : null).then(function (had) {
    if (had && had.entry && had.template) return true;   // a first conversion's copy is the one to keep
    return fbv.set(id, doc).then(function () { return true; });
  }).catch(function (e) { console.warn('[convert] backup failed, entry left as it is:', entry.id, e && e.message); return false; });
}

window.NotebookConvert = { legacy: legacy, page: page, backup: backup, LABEL: LABEL };
})();
