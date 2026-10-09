/* Notebook — the journal touch-drag helper and JGuard (content-loss guard).
   Moved verbatim from index.html (docs/Notebook/plan.md, Phase 1). */

/* ── Shared touch-drag helper for journal entry lists ── */
window._attachJournalTouchDrag = function(handle, div, entry, list, state, dragOverClass, draggingClass, onReorder) {
  handle.addEventListener('touchstart', function(e) {
    e.stopPropagation();
    var touch = e.touches[0];
    var startY = touch.clientY;
    var srcId = entry.id;
    var clone = null;
    var placeholder = null;
    var items = [];
    var listRect = null;
    var moved = false;

    function onTouchMove(ev) {
      ev.preventDefault();
      var t = ev.touches[0];
      moved = true;

      if (!clone) {
        // Build ghost
        clone = div.cloneNode(true);
        clone.style.cssText = 'position:fixed;left:' + div.getBoundingClientRect().left + 'px;width:' + div.offsetWidth + 'px;opacity:0.85;z-index:99999;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,0.4);transition:none;';
        document.body.appendChild(clone);
        // Placeholder
        placeholder = document.createElement('div');
        placeholder.style.cssText = 'height:' + div.offsetHeight + 'px;background:rgba(224,96,122,0.15);border:1px dashed rgba(224,96,122,0.5);border-radius:4px;margin-bottom:4px;transition:none;';
        div.parentNode.insertBefore(placeholder, div);
        div.style.display = 'none';
        div.classList.add(draggingClass);
        listRect = list.getBoundingClientRect();
        items = Array.from(list.querySelectorAll('.entry-item')).filter(el => el !== div);
      }

      clone.style.top = (t.clientY - div.offsetHeight / 2) + 'px';

      // Find insert position
      var insertBefore = null;
      for (var i = 0; i < items.length; i++) {
        var r = items[i].getBoundingClientRect();
        if (t.clientY < r.top + r.height / 2) { insertBefore = items[i]; break; }
      }
      if (insertBefore) list.insertBefore(placeholder, insertBefore);
      else list.appendChild(placeholder);

      // Auto-scroll list
      var scrollSpeed = 0;
      if (t.clientY < listRect.top + 60) scrollSpeed = -8;
      else if (t.clientY > listRect.bottom - 60) scrollSpeed = 8;
      if (scrollSpeed) list.scrollTop += scrollSpeed;
    }

    function onTouchEnd(ev) {
      document.removeEventListener('touchmove', onTouchMove, {passive:false});
      document.removeEventListener('touchend', onTouchEnd);
      if (!moved) { cleanup(); return; }

      // Determine target from placeholder position
      var allItems = Array.from(list.querySelectorAll('.entry-item')).filter(el => el !== div);
      var phIdx = Array.from(list.children).indexOf(placeholder);
      var insertBeforeEl = null;
      var children = Array.from(list.children).filter(el => el !== placeholder && el !== div);
      // Find where placeholder is relative to real items
      var phPos = Array.from(list.children).indexOf(placeholder);
      var realBefore = null;
      var seenReal = 0;
      for (var i = 0; i < list.children.length; i++) {
        var child = list.children[i];
        if (child === placeholder) break;
        if (child.classList && child.classList.contains('entry-item') && child !== div) {
          seenReal++;
          realBefore = child;
        }
      }
      // Find target entry id
      var afterEl = null;
      var phChildren = Array.from(list.children);
      for (var j = phChildren.indexOf(placeholder) + 1; j < phChildren.length; j++) {
        if (phChildren[j].classList && phChildren[j].classList.contains('entry-item') && phChildren[j] !== div) {
          afterEl = phChildren[j]; break;
        }
      }

      cleanup();

      var fromIdx = state.entries.findIndex(function(x){ return x.id === srcId; });
      var toIdx;
      if (afterEl && afterEl.dataset && afterEl.dataset.entryId) {
        toIdx = state.entries.findIndex(function(x){ return x.id === afterEl.dataset.entryId; });
      } else {
        toIdx = state.entries.length - 1;
      }
      if (fromIdx < 0 || fromIdx === toIdx) return;
      var moved2 = state.entries.splice(fromIdx, 1)[0];
      var finalTo = state.entries.findIndex(function(x){ return x.id === (afterEl && afterEl.dataset && afterEl.dataset.entryId); });
      if (finalTo < 0) state.entries.push(moved2);
      else state.entries.splice(finalTo, 0, moved2);
      onReorder();
    }

    function cleanup() {
      if (clone) { clone.remove(); clone = null; }
      if (placeholder) { placeholder.remove(); placeholder = null; }
      div.style.display = '';
      div.classList.remove(draggingClass);
      list.querySelectorAll('.' + dragOverClass).forEach(function(el){ el.classList.remove(dragOverClass); });
    }

    document.addEventListener('touchmove', onTouchMove, {passive:false});
    document.addEventListener('touchend', onTouchEnd);
  }, {passive:true});
};

/* ── JGuard: content-loss guard shared by MyJournal (#tj-root) and Brainstorm Journal (#bj-root) ── */
/* ═══════════════════════════════════════════════════════════════════════════
   JGuard — why an entry's content could go blank, and what stops it now.

   Both journals persist an entry by reading the LIVE DOM (saveCurrentEntry does
   `entry.data.html = editor.innerHTML`) and then writing that whole entry to
   Firestore. That is only safe while the DOM on screen really is the entry being
   saved AND has finished painting. Four situations break that assumption, and
   every one of them ends the same way: a blank or foreign editor is written over
   real content, and the whole-entry cloud write spreads the wipe to every device.

     1. SHARED DOM. ONE #tj-page-editor serves every page entry. A save that
        runs while the editor still holds the entry we just left files that
        content under the wrong id.
     2. UNPAINTED DOM. loadActiveEntry() returns early for a locked entry and when
        there is no entry at all, leaving the editor blank. A save in that window
        reads "" as the entry's new content.
     3. A TOUCHED CLOCK — the one that made this recur for months. saveCurrentEntry
        stamped `entry.updated = Date.now()` on EVERY call, even a no-op one. The
        remote merge resolves conflicts with `remoteUpdated <= localUpdated → keep
        local`, so a single no-op save on a session holding stale content made that
        stale copy the permanent winner: the real remote content was dropped the
        moment it arrived, and then overwritten on the next write.
     4. A FOREIGN UNDO STACK. The editor persists undo history per document id
        across sessions. Reopening an entry that had changed elsewhere restored
        that old stack, so one Ctrl+Z jumped to a version from a previous session
        and auto-saved it over the current one.

   This module supplies the primitives; the rules using them live at the call
   sites, where lock state, focus and edit mode are known:

     emptyHtml / emptyData  "is there materially anything here", tags ignored.
     wouldLose              would committing this DOM turn a non-empty field empty?
     sig                    content fingerprint, for no-op detection (excludes
                            `updated`, which is the field we must stop mis-stamping).
     backup / recover       a rolling per-entry local version history, written only
                            when content SHRINKS, so a regression that still gets
                            through is recoverable instead of terminal.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

var BAK_MAX       = 6;        // versions kept per entry
var BAK_MAX_CHARS = 300000;   // never let one entry's history alone blow the quota

// "Empty" means no text AND no embedded object. A page holding nothing but an
// image, a table or a canvas has real content even though stripping tags leaves
// an empty string — treating that as blank is exactly how an image-only page
// would get wiped.
function emptyHtml(html) {
  if (!html) return true;
  var s = String(html);
  if (/<(img|table|canvas|svg|iframe|video|audio|hr|input|object|embed)\b/i.test(s)) return false;
  return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, '').length === 0;
}
function emptyText(v) { return !v || String(v).replace(/\s+/g, '').length === 0; }

function emptyData(template, data) {
  var d = data || {};
  switch (template) {
    case 'page':    return emptyHtml(d.html);
    case 'notes':   return emptyText(d.main) && emptyText(d.links) && emptyText(d.questions);
    case 'cornell': return emptyText(d.topic) && emptyText(d.cues) && emptyText(d.notes) && emptyText(d.summary);
    case 'journal-entries': {
      var dates = d.dates || {};
      return Object.keys(dates).every(function (k) { return emptyHtml(dates[k] && dates[k].html); });
    }
    // The two visual templates keep their content in their OWN document (see
    // the VizEngine block), so the entry carries a fingerprint instead: vizRev
    // is the board's revision and vizCount its meaningful-content measure —
    // element count for a whiteboard, branches-plus-a-named-root for a mind
    // map, deliberately 0 for a freshly created board nobody has touched.
    // vizRev is what says "this entry has been converted"; without it the entry
    // is still on the old model and the legacy tests below are the right ones.
    // The legacy mind map keeps its content on the entry, so it keeps the
    // original emptiness test — unchanged, because the data it guards is
    // unchanged.
    case 'mindmap-legacy':
    case 'mindmap': {
      if (d.vizRev && template === 'mindmap') return !(d.vizCount > 0);
      var n = d.nodes || [];
      if (n.length > 1 || (d.edges || []).length) return false;
      return !n.length || !n[0].label || n[0].label === 'Central Idea';   // untouched default
    }
    case 'whiteboard': return d.vizRev ? !(d.vizCount > 0) : !d.canvas;
    // An unrecognised template must never be called empty — the guards below
    // read "not empty" as "leave it alone", which is the safe direction.
    default: return false;
  }
}
function emptyEntry(e) { return !e || emptyData(e.template, e.data); }

/* Would committing `next` over `old` turn a field that HAS content into an empty
 * one? Checked per FIELD, not per entry: a journal-entries page with ten dated
 * pages is not "empty" just because today's tab blanked, but that one date is
 * still a loss. Deleting a date outright (the key disappears) is an explicit user
 * action, not a loss, so keys missing from `next` are skipped. Mindmap and
 * whiteboard are excluded — their edits are explicit node/stroke operations with
 * their own undo, not a text field that can silently read back blank. */
function wouldLose(template, old, next) {
  var o = old || {}, n = next || {};
  function lostText(a, b) { return !emptyText(a) && emptyText(b); }
  function lostHtml(a, b) { return !emptyHtml(a) && emptyHtml(b); }
  switch (template) {
    case 'page':    return lostHtml(o.html, n.html);
    case 'notes':   return lostText(o.main, n.main) || lostText(o.links, n.links) || lostText(o.questions, n.questions);
    case 'cornell': return lostText(o.topic, n.topic) || lostText(o.cues, n.cues) ||
                           lostText(o.notes, n.notes) || lostText(o.summary, n.summary);
    case 'journal-entries': {
      var od = o.dates || {}, nd = n.dates || {};
      return Object.keys(od).some(function (k) {
        if (!(k in nd)) return false;
        return lostHtml(od[k] && od[k].html, nd[k] && nd[k].html);
      });
    }
    default: return false;
  }
}

// Content fingerprint. Deliberately EXCLUDES `updated`, `_fbPushed` and the rest
// of the sync bookkeeping, so "did the user actually change anything" can be
// answered without consulting the timestamp this module exists to protect.
function sig(template, data, title) {
  var d = data || {}, parts = [String(title == null ? '' : title)];
  switch (template) {
    case 'page':    parts.push(d.html || ''); break;
    case 'notes':   parts.push(d.main || '', d.links || '', d.questions || ''); break;
    case 'cornell': parts.push(d.topic || '', d.cues || '', d.notes || '', d.summary || ''); break;
    case 'journal-entries': {
      var dates = d.dates || {};
      parts.push((d.dateOrder || []).join(','));
      Object.keys(dates).sort().forEach(function (k) { parts.push(k, (dates[k] && dates[k].html) || ''); });
      break;
    }
    // vizRev increments once per committed board change, so it is a cheaper and
    // sharper "did anything change" than re-serialising a scene that already
    // has its own change detection.
    case 'mindmap-legacy':
    case 'mindmap':    parts.push('v' + (d.vizRev || 0), String(d.vizCount || 0), d.vizTitle || '',
                                  JSON.stringify(d.nodes || []), JSON.stringify(d.edges || [])); break;
    case 'whiteboard': parts.push('v' + (d.vizRev || 0), String(d.vizCount || 0), d.vizTitle || '',
                                  String((d.canvas || '').length)); break;
    default:           try { parts.push(JSON.stringify(d)); } catch (e) { parts.push('?'); }
  }
  try { parts.push(JSON.stringify(d.attachments || [])); } catch (e) {}
  return parts.join('');
}

// Rough content size, used only to decide whether a version is worth keeping.
function size(template, data) { return sig(template, data, '').length; }

function bakKey(app, id) { return 'jg_bak_' + app + '_' + id; }

/* ── Backups live in IndexedDB, not localStorage ─────────────────────────────
 * Every A1 page shares this origin's 5 MB of localStorage, and on Veda's Brave
 * it was full (2026-09-30); these backups were 230 KB of it and each can reach
 * BAK_MAX_CHARS. They now go to their own IndexedDB database (a1_jguard; its
 * own, so it does not depend on the VizStore script loading first). readBak is
 * synchronous for its callers (recovery decides while an entry opens), so
 * _bakMem is the working copy: filled from IndexedDB at load, written through
 * on every backup. A legacy localStorage key is read until the move below has
 * copied it into IndexedDB and read it back, and only then removed. If
 * IndexedDB is unavailable, backups keep using localStorage exactly as before. */
var _bakMem = {};             // bakKey -> list
var _bakDb = null, _bakDbFail = false;
function _bakOpen() {
  if (_bakDbFail) return Promise.resolve(null);
  if (_bakDb) return Promise.resolve(_bakDb);
  return new Promise(function (res) {
    var rq;
    try { rq = indexedDB.open('a1_jguard', 1); } catch (e) { _bakDbFail = true; return res(null); }
    rq.onupgradeneeded = function (e) { try { e.target.result.createObjectStore('bak'); } catch (x) {} };
    rq.onsuccess = function (e) { _bakDb = e.target.result; res(_bakDb); };
    rq.onerror = rq.onblocked = function () { _bakDbFail = true; res(null); };
  });
}
function _bakIdb(mode, fn) {
  return _bakOpen().then(function (db) {
    if (!db) return null;
    return new Promise(function (res) {
      try {
        var tx = db.transaction('bak', mode), out = { v: null };
        fn(tx.objectStore('bak'), out);
        tx.oncomplete = function () { res(out.v === null ? true : out.v); };
        tx.onerror = tx.onabort = function () { res(null); };
      } catch (e) { res(null); }
    });
  });
}
function _bakPut(k, list) {
  return _bakIdb('readwrite', function (st) { st.put(list, k); });
}
function _bakLoadAll() {
  return _bakIdb('readonly', function (st, out) {
    out.v = {};
    var c = st.openCursor();
    c.onsuccess = function (e) { var cur = e.target.result; if (cur) { out.v[cur.key] = cur.value; cur.continue(); } };
  }).then(function (all) {
    if (all && typeof all === 'object') Object.keys(all).forEach(function (k) { if (!_bakMem[k]) _bakMem[k] = all[k]; });
    return !!all;
  });
}
function _bakMoveOut() {
  var keys = [];
  try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('jg_bak_') === 0) keys.push(k); } } catch (e) {}
  return Promise.all(keys.map(function (k) {
    var list; try { list = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return null; }
    if (!Array.isArray(list)) return null;
    _bakMem[k] = list;       // the localStorage copy is the newest one there is
    var raw = JSON.stringify(list);
    return _bakPut(k, list)
      .then(function (ok) { return ok ? _bakIdb('readonly', function (st, out) { var g = st.get(k); g.onsuccess = function () { out.v = g.result; }; }) : null; })
      .then(function (back) { if (back && JSON.stringify(back) === raw) { try { localStorage.removeItem(k); } catch (e) {} } });
  }));
}
try { _bakLoadAll().then(function (ok) { if (ok) return _bakMoveOut(); }).catch(function () {}); } catch (e) {}

function readBak(app, id) {
  var k = bakKey(app, id);
  if (Array.isArray(_bakMem[k])) return _bakMem[k].slice();
  try { var v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}

/* Keep a copy of the CURRENT content just before it is replaced by something
 * smaller. Growth is never a loss and snapshotting every keystroke would blow the
 * localStorage quota on one long page, so shrinkage is the only trigger. */
function backup(app, entry, nextData) {
  try {
    if (!entry || !entry.id || emptyEntry(entry)) return;
    if (size(entry.template, nextData) >= size(entry.template, entry.data)) return;
    var payload = JSON.stringify({ template: entry.template, title: entry.title || '', data: entry.data });
    if (payload.length > BAK_MAX_CHARS) return;
    var list = readBak(app, entry.id);
    if (list.length && list[0].p === payload) return;
    list.unshift({ t: Date.now(), p: payload });
    while (list.length > BAK_MAX) list.pop();
    var k = bakKey(app, entry.id);
    if (!_bakDbFail) {
      _bakMem[k] = list;
      _bakPut(k, list).then(function (ok) {
        if (ok) { try { localStorage.removeItem(k); } catch (e) {} return; }
        // IndexedDB refused: keep the old localStorage behaviour for this one.
        try { localStorage.setItem(k, JSON.stringify(list)); }
        catch (e) { try { localStorage.setItem(k, JSON.stringify(list.slice(0, 2))); } catch (x) {} }
      });
      return;
    }
    try { localStorage.setItem(k, JSON.stringify(list)); }
    catch (e) { try { localStorage.setItem(k, JSON.stringify(list.slice(0, 2))); } catch (x) {} }
  } catch (e) {}
}

// Newest kept version that still has content.
function latestBackup(app, id) {
  var list = readBak(app, id);
  for (var i = 0; i < list.length; i++) {
    try {
      var v = JSON.parse(list[i].p);
      if (!emptyData(v.template, v.data)) return { at: list[i].t, title: v.title, template: v.template, data: v.data };
    } catch (e) {}
  }
  return null;
}

/* The editor's cross-session undo stack (docx_hist_<app>_<entryId>) is a second,
 * independent copy of a page's HTML sitting in this browser. For content lost
 * BEFORE this guard shipped there is no JGuard backup, so that stack is the only
 * surviving copy — worth reading before declaring a page gone. */
function histRecover(app, id) {
  try {
    var raw = localStorage.getItem('docx_hist_' + app + '_' + id);
    if (!raw) return null;
    var stack = (JSON.parse(raw) || {}).stack || [];
    var best = '';
    stack.forEach(function (s) {
      if (s && typeof s.html === 'string' && !emptyHtml(s.html) && s.html.length > best.length) best = s.html;
    });
    return best || null;
  } catch (e) { return null; }
}

/* An entry the user EMPTIED ON PURPOSE. Recovery exists to repair unexplained
 * emptiness; a deliberate clear is explained, and resurrecting it on the next open
 * would be its own kind of data corruption — the user's deletion undone behind
 * their back. Recorded as a timestamp so the marker expires naturally: write
 * content again and the next backup is newer than the marker, which re-arms
 * recovery for that new content. */
function markCleared(app, id) {
  try { localStorage.setItem('jg_cleared_' + app + '_' + id, String(Date.now())); } catch (e) {}
}
function clearedAt(app, id) {
  var v = parseInt(localStorage.getItem('jg_cleared_' + app + '_' + id) || '', 10);
  return isNaN(v) ? 0 : v;
}

/* Heal an entry that has come back empty, in place. Returns true if it changed
 * anything. Only ever ADDS content to an empty field — it can never overwrite
 * something the user still has. */
function recover(app, entry) {
  if (!entry || !entry.id || !emptyEntry(entry)) return false;
  var bak = latestBackup(app, entry.id);
  // Emptied on purpose, and nothing has been written since — leave it empty.
  var mark = clearedAt(app, entry.id);
  if (mark && mark >= (bak ? bak.at : 0)) return false;
  if (bak && bak.template === entry.template) {
    entry.data = bak.data;
    if (!entry.title && bak.title) entry.title = bak.title;
    console.warn('[JGuard] restored ' + app + ' entry ' + entry.id + ' from local backup of ' + new Date(bak.at).toLocaleString());
    return true;
  }
  if (entry.template === 'page') {
    var html = histRecover(app, entry.id);
    if (html) {
      entry.data = entry.data || {};
      entry.data.html = html;
      console.warn('[JGuard] restored ' + app + ' entry ' + entry.id + ' from its saved editor history');
      return true;
    }
  }
  return false;
}

window.JGuard = {
  emptyHtml: emptyHtml, emptyText: emptyText, emptyData: emptyData, emptyEntry: emptyEntry,
  wouldLose: wouldLose, sig: sig, size: size,
  backup: backup, latestBackup: latestBackup, histRecover: histRecover, recover: recover,
  markCleared: markCleared, clearedAt: clearedAt,
  // Manual escape hatch from the console: JGuard.versions('tj', entryId)
  versions: function (app, id) {
    return readBak(app, id).map(function (r) {
      var v = {}; try { v = JSON.parse(r.p); } catch (e) {}
      return { at: new Date(r.t).toLocaleString(), title: v.title, data: v.data };
    });
  }
};
})();
