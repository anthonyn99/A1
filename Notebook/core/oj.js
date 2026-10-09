/* ══════════════════════════════════════════════════════════════════════════
   OurJournal engine (window.OJ) — the journal Tony and Veda share.

   WHAT IT IS
   A third collection of entries that BOTH journals can display. MyJournal and
   Brainstorm Journal each keep their own UI, templates, toolbar and theme; when
   their "OurJournal" tab is on, the app swaps its `state` for the shared
   collection this engine owns (see _tjOJ / _bjOJ in each app). Nothing is
   duplicated: a shared Page opens in the app's own #xx-page-editor, a shared
   board in the app's own VizEngine board.

   FIRESTORE LAYOUT (all under dashboards/, covered by the existing auth rule)
     ourjournal            index — one field per entry, m_<id> = METADATA ONLY
                           (title, template, tags, trash state, creator, order)
     ourjournal_c_<id>     one entry's content: { d, w, pw, by, at }
     ourjournal_img_<key>  page images, extracted like the journals' own
     ourjournal_viz_<id>   whiteboard / mind-map boards (VizEngine, live mode)
   Only the index and the ONE open entry are listened to, so a keystroke costs
   the other person one read of one small document — never the whole journal,
   and never a document they are not looking at.

   LIVE CO-EDITING — why every write names its parent
   Each content write carries w (its own id) and pw (the write it was based
   on). A client keeps a short history of states by w, so when a write arrives
   from the other person it can 3-way merge: base = the state that write was
   built on, local = what is on this screen, remote = what arrived. Two people
   typing in different places both keep every keystroke; two people typing at
   the same spot both keep theirs (ordered deterministically, so both screens
   converge). A client whose write lost a race sees the winner arrive, merges
   its own edits back in and writes again — the document converges without a
   transaction (so no extra read per keystroke) and without a rules change.

   COST
   Writes are throttled per document (1.5s alone, 0.65s while the other person
   is actively editing the same entry) and skipped entirely when nothing that
   is persisted changed. Metadata (title/tags/trash/order) is written field by
   field, only on change. `updated` alone republishes at most every 10 min.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';
if (window.OJ) return;

// `oj_ns` exists for testing only: it points a device at a scratch namespace so
// a test never touches the real shared journal.
var NS = 'ourjournal';
try { NS = localStorage.getItem('oj_ns') || 'ourjournal'; } catch (e) {}

var PEOPLE = { tj: 'tony', bj: 'veda' };
var NAMES = { tony: 'Tony', veda: 'Veda' };
var TEMPLATES = ['page', 'mindmap', 'whiteboard'];   // the templates BOTH journals have
var META = ['title', 'template', 'created', 'updated', 'tags', 'trashed', 'trashChangedAt', 'creator', 'ord'];
var CLIENT = Math.random().toString(36).slice(2, 9);
var TRASH_TTL = 30 * 24 * 3600 * 1000;
var UPDATED_GRAIN = 10 * 60 * 1000;
var WRITE_SOLO = 1500, WRITE_COLLAB = 650, COLLAB_WINDOW = 90000;
var HIST_KEEP = 40;
var MAX_CONTENT_BYTES = 880000;
var LOAD_TIMEOUT = 6000;

function cDocId(id) { return NS + '_c_' + id; }
function fb() { return (window._fbOJ && window._fbReady) ? window._fbOJ : null; }

/* ── small utilities ───────────────────────────────────────────────────── */
// Key-order-independent JSON: Firestore hands maps back in its own key order,
// so a plain JSON.stringify would call two identical objects different.
function stable(v) {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  var ks = Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort();
  return '{' + ks.map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
}
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function sanitize(v) {
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === 'object') {
    var o = {};
    Object.keys(v).forEach(function (k) { if (v[k] !== undefined && v[k] !== null) o[k] = sanitize(v[k]); });
    return o;
  }
  return v;
}
function byteSize(o) { try { return new Blob([JSON.stringify(o)]).size; } catch (e) { return 0; } }

/* ══════════════ Diff + 3-way merge ══════════════
 * Myers O(ND) on interned token ids, with the common prefix and suffix trimmed
 * first — a keystroke-sized change on a long page costs microseconds. A diff
 * that would need more than DIFF_LIMIT edits falls back to one coarse hunk,
 * which the merge still handles (it just resolves more as a conflict). */
var DIFF_LIMIT = 1200;
function diffHunks(a, b) {
  var n = a.length, m = b.length, pre = 0, suf = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  var N = n - pre - suf, M = m - pre - suf;
  if (!N && !M) return [];
  if (!N || !M) return [{ a: pre, al: N, b: pre, bl: M }];
  var max = N + M, off = max + 1, v = new Int32Array(2 * max + 3), trace = [], D = -1;
  outer:
  for (var d = 0; d <= max; d++) {
    if (d > DIFF_LIMIT) break;
    for (var k = -d; k <= d; k += 2) {
      var x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      var y = x - k;
      while (x < N && y < M && a[pre + x] === b[pre + y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { trace.push(v.slice(off - d, off + d + 1)); D = d; break outer; }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (D < 0) return [{ a: pre, al: N, b: pre, bl: M }];
  // Backtrack into edit ops (in reverse), then fold consecutive edits into hunks.
  var ops = [];   // {t:'d', ai} deletion of A[ai] | {t:'i', ai} insertion before A[ai]
  var cx = N, cy = M;
  for (var dd = D; dd > 0; dd--) {
    var V = trace[dd - 1], kk = cx - cy;
    var get = function (kv) { return V[kv + (dd - 1)]; };
    var down = (kk === -dd || (kk !== dd && get(kk - 1) < get(kk + 1)));
    var pk = down ? kk + 1 : kk - 1;
    var px = get(pk), py = px - pk;
    if (down) ops.push({ t: 'i', ai: px });
    else ops.push({ t: 'd', ai: px });
    cx = px; cy = py;
  }
  ops.reverse();
  var hunks = [], cur = null;
  ops.forEach(function (o) {
    if (cur && o.ai === cur.a + cur.al) { if (o.t === 'd') cur.al++; else cur.bl++; }
    else { cur = { a: o.ai, al: o.t === 'd' ? 1 : 0, b: 0, bl: o.t === 'i' ? 1 : 0 }; hunks.push(cur); }
  });
  // Between hunks A and B are equal, so each hunk's B start is its A start
  // plus the net growth of every hunk before it.
  var shift = 0;
  hunks.forEach(function (h) {
    h.b = h.a + shift + pre;
    h.a += pre;
    shift += h.bl - h.al;
  });
  return hunks;
}

function tokenize(s) {
  return s ? (s.match(/<[^>]*>?|&#?\w+;|[A-Za-z0-9À-ɏͰ-ϿЀ-ӿ]+|\s+|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || []) : [];
}

// diff3 over token arrays. Regions that only one side changed take that side;
// regions both changed identically take it once; a real conflict at a pure
// insertion point keeps BOTH (ordered by content so both clients agree), and a
// conflicting modification keeps the local version (the person typing it).
function merge3Tokens(O, A, B, ia, ib, io) {
  var hs = [];
  diffHunks(io, ia).forEach(function (h) { hs.push({ s: 'a', o: h.a, ol: h.al, x: h.b, xl: h.bl }); });
  diffHunks(io, ib).forEach(function (h) { hs.push({ s: 'b', o: h.a, ol: h.al, x: h.b, xl: h.bl }); });
  hs.sort(function (p, q) { return p.o - q.o || (p.s < q.s ? -1 : 1); });
  var out = [], at = 0, i = 0;
  function sideRange(list, side, rs, re) {
    var mine = list.filter(function (h) { return h.s === side; });
    if (!mine.length) return null;
    var f = mine[0], l = mine[mine.length - 1];
    return [f.x - (f.o - rs), l.x + l.xl + (re - (l.o + l.ol))];
  }
  while (i < hs.length) {
    var rs = hs[i].o, re = hs[i].o + hs[i].ol, grp = [hs[i]]; i++;
    while (i < hs.length && hs[i].o <= re) { re = Math.max(re, hs[i].o + hs[i].ol); grp.push(hs[i]); i++; }
    for (var c = at; c < rs; c++) out.push(O[c]);
    var ra = sideRange(grp, 'a', rs, re), rb = sideRange(grp, 'b', rs, re);
    var ta = ra ? A.slice(ra[0], ra[1]) : O.slice(rs, re);
    var tb = rb ? B.slice(rb[0], rb[1]) : O.slice(rs, re);
    if (!ra) Array.prototype.push.apply(out, tb);
    else if (!rb) Array.prototype.push.apply(out, ta);
    else {
      var sa = ta.join(''), sb = tb.join('');
      if (sa === sb) Array.prototype.push.apply(out, ta);
      else if (re === rs) Array.prototype.push.apply(out, union2(ta, tb));   // both inserted here: keep both, shared text once
      else if (!ta.length) Array.prototype.push.apply(out, tb);    // never let a delete swallow an edit
      else if (isSubseq(ta, tb)) Array.prototype.push.apply(out, tb);   // the other side has all of ours, and more
      else Array.prototype.push.apply(out, ta);
    }
    at = re;
  }
  for (var z = at; z < O.length; z++) out.push(O[z]);
  return out;
}

function isSubseq(a, b) {
  var j = 0;
  for (var i = 0; i < b.length && j < a.length; i++) if (b[i] === a[j]) j++;
  return j === a.length;
}
// Two insertions at the same point, as one: runs both contain appear once, and
// each side's own text is kept — ordered by content, so both screens agree.
function union2(ta, tb) {
  var ids = new Map(), n = 0;
  function intern(arr) { var r = new Int32Array(arr.length); for (var i = 0; i < arr.length; i++) { var v = ids.get(arr[i]); if (v === undefined) { v = n++; ids.set(arr[i], v); } r[i] = v; } return r; }
  var hs = diffHunks(intern(ta), intern(tb)), out = [], at = 0;
  hs.forEach(function (h) {
    for (var c = at; c < h.a; c++) out.push(ta[c]);
    var xa = ta.slice(h.a, h.a + h.al), xb = tb.slice(h.b, h.b + h.bl);
    if (xa.join('') <= xb.join('')) out.push.apply(out, xa.concat(xb)); else out.push.apply(out, xb.concat(xa));
    at = h.a + h.al;
  });
  for (var z = at; z < ta.length; z++) out.push(ta[z]);
  return out;
}
function mergeText(base, local, remote) {
  base = base || ''; local = local || ''; remote = remote || '';
  if (local === remote) return local;
  if (base === local) return remote;
  if (base === remote) return local;
  var O = tokenize(base), A = tokenize(local), B = tokenize(remote);
  var ids = new Map(), n = 0;
  function intern(arr) { var r = new Int32Array(arr.length); for (var i = 0; i < arr.length; i++) { var t = arr[i], v = ids.get(t); if (v === undefined) { v = n++; ids.set(t, v); } r[i] = v; } return r; }
  return merge3Tokens(O, A, B, intern(A), intern(B), intern(O)).join('');
}

// Per-field merge of an entry's data object; `html` is merged token by token.
function mergeD(base, local, remote) {
  base = base || {}; local = local || {}; remote = remote || {};
  var out = {}, keys = {};
  [local, remote].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
  Object.keys(keys).forEach(function (k) {
    if (k === 'html') { out.html = mergeText(base.html, local.html, remote.html); return; }
    var sb = stable(base[k]), sl = stable(local[k]), sr = stable(remote[k]);
    var v = (sl === sb) ? remote[k] : local[k];   // only local changed it → local; else remote
    if (sl !== sb && sr !== sb && sl !== sr && k === 'attachments' && Array.isArray(local[k]) && Array.isArray(remote[k])) {
      // Two people attached different files at once — keep both lists' files.
      var seen = {}; v = [];
      local[k].concat(remote[k]).forEach(function (a) { var id = a && (a.id || a.name); if (!seen[id]) { seen[id] = 1; v.push(a); } });
    }
    if (v !== undefined) out[k] = clone(v);
  });
  return out;
}

/* ── caret mapping ──────────────────────────────────────────────────────
 * A remote patch must not move the local caret. Position is measured in
 * "units" over the editor (text chars, one per <br>, one per block start) so
 * the mapping survives nodes being replaced; the old→new linear text diff then
 * says how far text before the caret moved. */
var BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TABLE|TR|TD|TH|SECTION|ARTICLE|HR|FIGURE|DL|DT|DD|DETAILS|SUMMARY)$/;
function linear(root) {
  var s = '';
  (function walk(n) {
    for (var c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeType === 1) {
        if (c.tagName === 'BR') s += '\n';
        else { if (BLOCK.test(c.tagName)) s += '\n'; walk(c); }
      }
    }
  })(root);
  return s;
}
function unitsBefore(root, node, offset) {
  var count = 0, done = false;
  function walk(n) {
    for (var c = n.firstChild, i = 0; c && !done; c = c.nextSibling, i++) {
      if (n === node && i === offset) { done = true; return; }
      if (c === node && c.nodeType === 3) { count += offset; done = true; return; }
      if (c.nodeType === 3) count += c.data.length;
      else if (c.nodeType === 1) {
        if (c.tagName === 'BR') count++;
        else { if (BLOCK.test(c.tagName)) count++; walk(c); }
      }
    }
    if (n === node && !done) done = true;
  }
  walk(root);
  return count;
}
function pointAt(root, target) {
  var count = 0, res = null;
  function walk(n) {
    for (var c = n.firstChild; c && !res; c = c.nextSibling) {
      if (c.nodeType === 3) {
        if (target <= count + c.data.length) { res = [c, Math.max(0, target - count)]; return; }
        count += c.data.length;
      } else if (c.nodeType === 1) {
        if (c.tagName === 'BR') {
          if (target === count) { res = [n, Array.prototype.indexOf.call(n.childNodes, c)]; return; }
          count++;
        } else {
          if (BLOCK.test(c.tagName)) {
            if (target === count) { res = [c, 0]; return; }
            count++;
            if (target === count && !c.firstChild) { res = [c, 0]; return; }
          }
          walk(c);
        }
      }
    }
  }
  walk(root);
  return res || [root, root.childNodes.length];
}
function mapPos(hunks, pos) {
  var shift = 0;
  for (var i = 0; i < hunks.length; i++) {
    var h = hunks[i];
    // An insertion exactly AT the caret stays after it: the other person's
    // text appears where they typed it, and this caret does not jump over it.
    if (h.al === 0 && h.a === pos) break;
    if (h.a + h.al <= pos) { shift += h.bl - h.al; continue; }
    if (h.a < pos) return h.b + h.bl;             // caret was inside text the other person replaced
    break;
  }
  return pos + shift;
}
function codes(s) { var r = new Int32Array(s.length); for (var i = 0; i < s.length; i++) r[i] = s.charCodeAt(i); return r; }

// Patch the editor to `html` touching only the top-level nodes that changed, so
// image handlers, math boxes and the caret's own paragraph survive untouched
// whenever the other person was editing somewhere else.
function patchEditor(ed, html) {
  var sel = window.getSelection(), inside = sel && sel.rangeCount && ed.contains(sel.anchorNode) && ed.contains(sel.focusNode);
  var before = inside ? linear(ed) : null, aU = 0, fU = 0;
  if (inside) { aU = unitsBefore(ed, sel.anchorNode, sel.anchorOffset); fU = unitsBefore(ed, sel.focusNode, sel.focusOffset); }
  var tpl = document.createElement('template');
  tpl.innerHTML = html;
  var nw = Array.prototype.slice.call(tpl.content.childNodes), old = Array.prototype.slice.call(ed.childNodes);
  function key(nd) { return nd.nodeType === 1 ? nd.outerHTML : (nd.nodeType === 3 ? '#' + nd.data : '!'); }
  var i = 0;
  while (i < old.length && i < nw.length && key(old[i]) === key(nw[i])) i++;
  var j = 0;
  while (j < old.length - i && j < nw.length - i && key(old[old.length - 1 - j]) === key(nw[nw.length - 1 - j])) j++;
  var anchor = old[old.length - j] || null;
  for (var r = i; r < old.length - j; r++) ed.removeChild(old[r]);
  for (var s = i; s < nw.length - j; s++) ed.insertBefore(nw[s], anchor);
  if (inside) {
    var after = linear(ed);
    if (after !== before) {
      var hk = diffHunks(codes(before), codes(after));
      var pa = pointAt(ed, mapPos(hk, aU)), pf = pointAt(ed, mapPos(hk, fU));
      try { sel.setBaseAndExtent(pa[0], pa[1], pf[0], pf[1]); } catch (e) {}
    }
  }
}

/* ══════════════ Images ══════════════
 * Same model as the journals: an inline image over 2 KB is moved into its own
 * document and the page keeps an oj-fbimg:// placeholder. Content-addressed,
 * so an image is uploaded ONCE — not on every save, which is what the old
 * extractors did — and fetched once per session however often it is shown. */
var IMG = { data: new Map(), uploaded: new Set(), fetching: new Map() };
function imgKey(src) {
  var h = 0, step = Math.max(1, Math.floor(src.length / 1024));
  for (var i = 0; i < src.length; i += step) h = (Math.imul(31, h) + src.charCodeAt(i)) | 0;
  h = (Math.imul(31, h) + src.length) | 0;
  return NS + '_img_' + Math.abs(h).toString(36) + src.length.toString(36);
}
function dehydrateHtml(html, collect) {
  if (!html || html.indexOf('data:') < 0) return html || '';
  var t = document.createElement('template');
  t.innerHTML = html;
  var changed = false;
  t.content.querySelectorAll('[src^="data:"],[href^="data:"]').forEach(function (el) {
    var attr = (el.getAttribute('src') || '').indexOf('data:') === 0 ? 'src' : 'href';
    var src = el.getAttribute(attr) || '';
    if (src.length < 2048) return;
    var key = imgKey(src);
    if (!IMG.data.has(key)) IMG.data.set(key, src);
    if (IMG.uploaded.has(key)) {
      el.setAttribute(attr, 'oj-fbimg://' + key);
      el.setAttribute('data-ojkey', key);
      changed = true;
    } else if (collect && collect.indexOf(key) < 0) collect.push(key);
  });
  return changed ? t.innerHTML : html;
}
function keysIn(html) {
  var out = [], re = /oj-fbimg:\/\/([A-Za-z0-9_-]+)/g, m;
  while ((m = re.exec(html || ''))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
  return out;
}
function rehydrateHtml(html) {
  if (!html || html.indexOf('oj-fbimg://') < 0) return html || '';
  var t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('[src^="oj-fbimg://"],[href^="oj-fbimg://"]').forEach(function (el) {
    var attr = (el.getAttribute('src') || '').indexOf('oj-fbimg://') === 0 ? 'src' : 'href';
    var key = (el.getAttribute(attr) || '').slice(11);
    var data = IMG.data.get(key);
    if (data) el.setAttribute(attr, data);
  });
  return t.innerHTML;
}
function ensureImgs(keys) {
  var f = fb();
  return Promise.all((keys || []).map(function (k) {
    if (IMG.data.has(k)) { IMG.uploaded.add(k); return null; }
    if (!f) return null;
    if (!IMG.fetching.has(k)) {
      IMG.fetching.set(k, f.get(k).then(function (d) {
        if (d && d.img) { IMG.data.set(k, d.img); IMG.uploaded.add(k); }
      }).catch(function (e) { console.warn('[OJ] image fetch failed', k, e && (e.code || e.message)); })
        .then(function () { IMG.fetching.delete(k); }));
    }
    return IMG.fetching.get(k);
  }));
}
function uploadImgs(keys) {
  var f = fb();
  return Promise.all((keys || []).map(function (k) {
    if (IMG.uploaded.has(k) || !IMG.data.has(k) || !f) return null;
    return f.set(k, { img: IMG.data.get(k), savedAt: Date.now() }).then(function () { IMG.uploaded.add(k); })
      .catch(function (e) { console.warn('[OJ] image upload failed, kept inline', k, e && (e.code || e.message)); });
  }));
}
function dehydrateD(d, collect) {
  var o = Object.assign({}, d || {});
  delete o.vizRev; delete o.vizCount;          // a board's local fingerprint — never shared
  if (typeof o.html === 'string') o.html = dehydrateHtml(o.html, collect);
  return sanitize(o);
}
function rehydrateD(d) {
  var o = clone(d || {});
  if (typeof o.html === 'string') o.html = rehydrateHtml(o.html);
  return o;
}
function blankData(t) {
  if (t === 'page') return { html: '', attachments: [] };
  return { attachments: [] };
}
function isBlank(t, d) {
  if (window.JGuard && window.JGuard.emptyData) { try { return window.JGuard.emptyData(t, d); } catch (e) {} }
  return !d || (t === 'page' && !String(d.html || '').replace(/<[^>]*>|&nbsp;|\s/g, ''));
}

/* ══════════════ Per-app bridges ══════════════ */
var apps = {};
function metaProj(e) {
  var p = {};
  META.forEach(function (f) { if (e[f] !== undefined && e[f] !== null) p[f] = clone(e[f]); });
  if (!p.title) p.title = '';
  if (!p.tags) p.tags = [];
  return p;
}
function cacheKey(app) { return 'oj_cache_' + app + (NS === 'ourjournal' ? '' : '_' + NS); }
function loadCache(app) {
  var S = { entries: [], activeId: null, deletedIds: [] };
  try {
    var r = JSON.parse(localStorage.getItem(cacheKey(app)) || 'null');
    if (r && Array.isArray(r.entries)) {
      S.activeId = r.activeId || null;
      S.deletedIds = Array.isArray(r.deletedIds) ? r.deletedIds : [];
      r.entries.forEach(function (m) { if (m && m.id && m.template) S.entries.push(Object.assign({}, m, { data: null, _ojLoaded: false, _fbPushed: true })); });
    }
  } catch (e) {}
  return S;
}
// META ONLY. Content lives in Firestore's own IndexedDB cache (it persists
// every document we listen to), so caching it here too would double the
// storage for nothing and eat into the ~5 MB localStorage every A1 app shares.
function writeCache(app) {
  var a = apps[app]; if (!a) return;
  try {
    localStorage.setItem(cacheKey(app), JSON.stringify({
      activeId: a.S.activeId,
      deletedIds: (a.S.deletedIds || []).slice(-200),
      entries: a.S.entries.filter(function (e) { return e._fbPushed; }).map(function (e) { return Object.assign({ id: e.id }, metaProj(e)); })
    }));
  } catch (e) {}
}

function register(app, hooks) {
  if (apps[app]) return apps[app].S;
  var a = apps[app] = {
    app: app, person: PEOPLE[app], h: hooks, S: loadCache(app), on: false,
    idx: { unsub: null, seen: false },
    docs: {}, kn: {}, sent: {}, dirty: {}, dels: {}, metaTimer: null, metaInflight: null, purged: false, idxFirstServer: false
  };
  // Fast path for live typing: schedule a content write straight off the
  // editor's input, without waiting out the app's own autosave debounce.
  var ed = hooks.editor && hooks.editor();
  if (ed) ed.addEventListener('input', function () {
    if (!a.on || !hooks.shown()) return;
    var e = active(a);
    if (e && e.template === 'page' && e._ojLoaded && a.docs[e.id]) schedule(a, a.docs[e.id]);
  });
  return a.S;
}
function active(a) { var id = a.S.activeId; return id ? a.S.entries.find(function (e) { return e.id === id; }) || null : null; }

/* ── index (metadata) ── */
function startIndex(a) {
  var f = fb(); if (!f || a.idx.unsub) return;
  a.idx.seen = false;
  a.idx.unsub = f.watch(NS, function (snap) { onIndex(a, snap); });
}
function stopIndex(a) {
  if (a.idx.unsub) { try { a.idx.unsub(); } catch (e) {} a.idx.unsub = null; }
  a.idx.seen = false;
}
function onIndex(a, snap) {
  if (snap.pending) return;
  var S = a.S, fromCache = snap.fromCache, data = snap.exists ? (snap.data || {}) : {};
  var metas = {};
  Object.keys(data).forEach(function (k) {
    var v = data[k];
    if (k.indexOf('m_') === 0 && v && typeof v === 'object' && v.template) metas[k.slice(2)] = v;
  });
  var byId = {}, dels = new Set(S.deletedIds || []);
  S.entries.forEach(function (e) { byId[e.id] = e; });
  var ae = active(a), aTitle = ae && ae.title, aTags = ae && stable(ae.tags);
  Object.keys(metas).forEach(function (id) {
    if (dels.has(id) || a.dels[id]) return;
    var m = metas[id], e = byId[id];
    if (!e) { e = { id: id, data: null, _ojLoaded: false }; S.entries.push(e); byId[id] = e; }
    var dm = a.dirty[id];
    META.forEach(function (f) {
      if (dm && (dm.__new || dm[f])) return;          // our own unsent change wins until it lands
      if (m[f] === undefined) delete e[f]; else e[f] = clone(m[f]);
    });
    e._fbPushed = true;
    delete e._ojNew;
    var sent = {}; META.forEach(function (f) { if (m[f] !== undefined) sent[f] = clone(m[f]); });
    a.sent[id] = sent;
  });
  if (!fromCache) {
    // The server's key list is the truth: an entry it no longer has was deleted.
    var gone = [];
    S.entries = S.entries.filter(function (e) {
      if (metas[e.id]) return true;
      if (e._ojNew && !e._fbPushed) return true;            // created here, not uploaded yet
      gone.push(e.id); return false;
    });
    gone.forEach(function (id) { forget(a, id); });
  }
  S.entries.sort(function (x, y) {
    var ox = typeof x.ord === 'number' ? x.ord : -1e15 - (x.created || 0);
    var oy = typeof y.ord === 'number' ? y.ord : -1e15 - (y.created || 0);
    return ox - oy || (y.created || 0) - (x.created || 0);
  });
  var shown = a.on && a.h.shown();
  var now = active(a);
  if (S.activeId && (!now || now.trashed)) {
    var nxt = S.entries.find(function (e) { return !e.trashed; });
    S.activeId = nxt ? nxt.id : null;
    if (shown) a.h.reload();
  } else if (shown && now) {
    // The open entry's title or tags changed on the other side.
    var ti = a.h.titleInput && a.h.titleInput();
    if (now.title !== aTitle && ti && document.activeElement !== ti) ti.value = now.title || '';
    if (stable(now.tags) !== aTags && a.h.renderTags) a.h.renderTags(now.tags || []);
  }
  if (shown) a.h.render();
  writeCache(a.app);
  if (!fromCache) {
    a.idx.seen = true;
    flushMeta(a);
    purgeOnce(a);
  }
}
function forget(a, id) {
  var S = a.S;
  if (!Array.isArray(S.deletedIds)) S.deletedIds = [];
  if (S.deletedIds.indexOf(id) < 0) S.deletedIds.push(id);
  if (S.deletedIds.length > 300) S.deletedIds = S.deletedIds.slice(-300);
  delete a.sent[id]; delete a.dirty[id]; delete a.kn[id];
  var s = a.docs[id];
  if (s) { clearTimeout(s.timer); if (s.unsub) try { s.unsub(); } catch (e) {} delete a.docs[id]; }
}
function purgeOnce(a) {
  if (a.purged) return;
  a.purged = true;
  var cutoff = Date.now() - TRASH_TTL;
  a.S.entries.filter(function (e) { return e.trashed && e.trashed < cutoff; }).forEach(function (e) {
    a.S.entries = a.S.entries.filter(function (x) { return x.id !== e.id; });
    hardDelete(a.app, e.id);
  });
}

// Order is an `ord` number per entry rather than one shared array, so a
// reorder writes ONE entry's field and two people reordering never collide.
function normalizeOrd(list) {
  var prev = -Infinity;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (typeof e.ord === 'number' && e.ord > prev) { prev = e.ord; continue; }
    var nxt = null;
    for (var j = i + 1; j < list.length; j++) if (typeof list[j].ord === 'number' && list[j].ord > prev) { nxt = list[j].ord; break; }
    var v;
    if (prev === -Infinity) v = (nxt === null) ? 0 : nxt - 1;
    else if (nxt === null) v = prev + 1;
    else v = (prev + nxt) / 2;
    if (!(v > prev) || (nxt !== null && !(v < nxt))) {    // ran out of float room: renumber all
      list.forEach(function (x, k) { x.ord = k; });
      return;
    }
    e.ord = v; prev = v;
  }
}

function touched(app) {
  var a = apps[app]; if (!a) return;
  normalizeOrd(a.S.entries);
  a.S.entries.forEach(function (e) {
    var p = metaProj(e), s = a.sent[e.id];
    if (!s) { a.dirty[e.id] = { __new: true }; return; }
    META.forEach(function (f) {
      if (f === 'updated') { if ((p.updated || 0) - (s.updated || 0) >= UPDATED_GRAIN) (a.dirty[e.id] = a.dirty[e.id] || {}).updated = 1; return; }
      if (stable(p[f]) !== stable(s[f])) (a.dirty[e.id] = a.dirty[e.id] || {})[f] = 1;
    });
  });
  if (Object.keys(a.dirty).length) {
    a.h.setSync('syncing');
    clearTimeout(a.metaTimer);
    a.metaTimer = setTimeout(function () { flushMeta(a); }, 500);
  }
  var ae = active(a);
  if (ae && ae._ojLoaded) schedule(a, session(a, ae));
  writeCache(app);
}

function flushMeta(a) {
  clearTimeout(a.metaTimer); a.metaTimer = null;
  var f = fb();
  if (!f || !a.idx.seen || a.metaInflight) return a.metaInflight || Promise.resolve();
  var ids = Object.keys(a.dirty), delIds = Object.keys(a.dels);
  if (!ids.length && !delIds.length) return Promise.resolve();
  var payload = {}, sentNew = [], taken = {};
  ids.forEach(function (id) {
    var e = a.S.entries.find(function (x) { return x.id === id; });
    var dm = a.dirty[id]; taken[id] = dm;
    if (!e || !e.template) return;
    var p = metaProj(e), s = a.sent[id], obj = {};
    if (dm.__new || !s) { obj = Object.assign({ id: id }, p); sentNew.push(e); }
    else META.forEach(function (fl) { if (dm[fl]) obj[fl] = (p[fl] === undefined) ? f.del() : p[fl]; });
    if (Object.keys(obj).length) payload['m_' + id] = obj;
    a.sent[id] = p;
  });
  delIds.forEach(function (id) { payload['m_' + id] = f.del(); });
  a.dirty = {}; var dels = a.dels; a.dels = {};
  if (!Object.keys(payload).length) return Promise.resolve();
  payload.savedAt = Date.now();
  a.metaInflight = f.merge(NS, payload).then(function () {
    a.metaInflight = null;
    sentNew.forEach(function (e) { e._fbPushed = true; });
    Object.keys(dels).forEach(function (id) { f.remove(cDocId(id)).catch(function () {}); });
    writeCache(a.app);
    a.h.setSync('synced');
    if (Object.keys(a.dirty).length || Object.keys(a.dels).length) flushMeta(a);
  }).catch(function (err) {
    a.metaInflight = null;
    console.warn('[OJ] index write failed:', err && (err.code || err.message));
    Object.keys(taken).forEach(function (id) { a.dirty[id] = Object.assign({}, taken[id], a.dirty[id] || {}); delete a.sent[id]; a.dirty[id].__new = true; });
    Object.keys(dels).forEach(function (id) { a.dels[id] = 1; });
    a.h.setSync('error');
    setTimeout(function () { flushMeta(a); }, 4000);
  });
  return a.metaInflight;
}

function hardDelete(app, id) {
  var a = apps[app]; if (!a) return;
  a.S.entries = a.S.entries.filter(function (e) { return e.id !== id; });
  var wasPushed = !!a.sent[id];
  forget(a, id);
  if (wasPushed) { a.dels[id] = 1; flushMeta(a); }
  writeCache(app);
}

/* ── content sessions (one live document per OPEN entry) ── */
function know(a, id) { return a.kn[id] || (a.kn[id] = { known: null, hist: new Map(), mine: new Set() }); }
function remember(k, w, d) {
  if (!w) return;
  k.hist.set(w, d);
  if (k.hist.size > HIST_KEEP) k.hist.delete(k.hist.keys().next().value);
}
function session(a, e) {
  var s = a.docs[e.id];
  if (s) { s.entry = e; s.closing = false; if (!s.unsub) watchSession(a, s); return s; }
  s = a.docs[e.id] = {
    id: e.id, entry: e, unsub: null, seen: false, want: false, timer: null, inflight: null,
    lastWrite: 0, lastForeign: 0, chain: Promise.resolve(), closing: false, errN: 0, readyRes: null
  };
  s.ready = new Promise(function (r) { s.readyRes = r; });
  if (e._ojLoaded) s.readyRes();
  watchSession(a, s);
  return s;
}
function watchSession(a, s) {
  var f = fb(); if (!f || s.unsub) return;
  s.seen = false;
  s.unsub = f.watch(cDocId(s.id), function (snap) {
    if (snap.pending) return;
    var rec = snap.exists ? snap.data : null, fromCache = snap.fromCache;
    s.chain = s.chain.then(function () { return onContent(a, s, rec, fromCache); })
      .catch(function (err) { console.warn('[OJ] content update failed:', err); });
  });
  // Nothing cached and the server is slow: open blank rather than hang. Anything
  // typed meanwhile is MERGED with the real content when it arrives (see foreign).
  setTimeout(function () {
    if (!s.entry._ojLoaded && a.docs[s.id] === s) { s.entry.data = s.entry.data || blankData(s.entry.template); s.entry._ojLoaded = true; s.readyRes(); }
  }, LOAD_TIMEOUT);
}
function onContent(a, s, rec, fromCache) {
  var e = s.entry, k = know(a, s.id);
  var p = Promise.resolve();
  if (!rec || !rec.d) {
    if (!e._ojLoaded) { e.data = e.data || blankData(e.template); e._ojLoaded = true; s.readyRes(); }
  } else if (k.mine.has(rec.w)) {
    // Our own write, confirmed.
  } else if (!e._ojLoaded) {
    p = ensureImgs(keysIn(rec.d.html)).then(function () {
      if (e._ojLoaded) return foreign(a, s, rec);
      e.data = Object.assign(e.data || {}, rehydrateD(rec.d));
      k.known = { w: rec.w, pw: rec.pw, d: rec.d }; remember(k, rec.w, rec.d);
      e._ojLoaded = true; s.readyRes();
    });
  } else if (k.known && k.known.w === rec.w) {
    // Same state re-delivered (cache → server confirmation).
  } else {
    p = foreign(a, s, rec);
  }
  return p.then(function () {
    if (!fromCache) s.seen = true;
    if (s.seen && s.want) schedule(a, s);
    maybeClose(a, s);
  });
}
function localD(a, s, collect) {
  var e = s.entry, d = Object.assign({}, e.data || {});
  if (e.template === 'page' && a.h.pageOwned(e.id)) d.html = a.h.editor().innerHTML;
  return dehydrateD(d, collect);
}
function foreign(a, s, rec) {
  var k = know(a, s.id);
  remember(k, rec.w, rec.d);
  s.lastForeign = Date.now();
  return ensureImgs(keysIn(rec.d.html)).then(function () {
    if (a.docs[s.id] !== s) return;
    var e = s.entry, local = localD(a, s), known = k.known, merged;
    // Take the remote copy as-is only when it was BUILT ON what this screen
    // already had and nothing was typed since. A write made from an older state
    // (it raced ours) must be merged, or it would silently drop our last edit.
    if (known && rec.pw === known.w && stable(local) === stable(known.d)) merged = rec.d;
    else {
      var base = known ? (k.hist.get(rec.pw) || known.d) : {};
      merged = mergeD(base, local, rec.d);
    }
    k.known = { w: rec.w, pw: rec.pw, d: rec.d };
    applyMerged(a, s, merged);
    if (stable(merged) !== stable(rec.d)) s.want = true;                    // our edits still need to go up
  });
}
function applyMerged(a, s, merged) {
  var e = s.entry, nd = rehydrateD(merged);
  if (e.template === 'page' && a.h.pageOwned(e.id)) {
    var ed = a.h.editor(), cur = ed.innerHTML, target = nd.html || '';
    if (cur !== target) {
      var run = function () { patchEditor(ed, target); };
      if (window._docxRemoteApply) window._docxRemoteApply(ed.id, cur, target, run); else run();
      if (a.h.rebind) a.h.rebind(ed);
    }
    var hadMargins = stable(e.data && e.data.margins);
    e.data = Object.assign(e.data || {}, nd);
    e.data.html = ed.innerHTML;
    if (stable(e.data.margins) !== hadMargins && a.h.pageSetup) a.h.pageSetup();
  } else {
    e.data = Object.assign(e.data || {}, nd);
  }
  if (a.h.dataChanged) a.h.dataChanged(e);
}
function schedule(a, s) {
  s.want = true;
  if (s.timer || s.inflight || !s.seen || !fb()) return;
  var iv = (Date.now() - s.lastForeign < COLLAB_WINDOW) ? WRITE_COLLAB : WRITE_SOLO;
  var wait = Math.max(0, s.lastWrite + iv - Date.now());
  s.timer = setTimeout(function () { s.timer = null; writeNow(a, s); }, wait);
}
var _wseq = 0, _tooBigSaid = {};
function writeNow(a, s) {
  clearTimeout(s.timer); s.timer = null;
  var f = fb(), e = s.entry;
  if (!s.want || s.inflight || !s.seen || !f || !e._ojLoaded || a.docs[s.id] !== s) return s.inflight || Promise.resolve();
  var k = know(a, s.id), pending = [];
  var d = localD(a, s, pending);
  if (k.known && stable(d) === stable(k.known.d)) {
    s.want = false;
    if (!a.metaInflight && !Object.keys(a.dirty).length) a.h.setSync('synced');
    maybeClose(a, s); return Promise.resolve();
  }
  // Never let a blank become the first published state of an entry: an absent
  // content document already means "blank", and this is the shape a not-yet-
  // painted editor has.
  if (!k.known && isBlank(e.template, d)) { s.want = false; maybeClose(a, s); return Promise.resolve(); }
  s.want = false;
  a.h.setSync('syncing');
  var prevKnown = k.known;
  s.inflight = uploadImgs(pending).then(function () {
    if (pending.length) d = localD(a, s);
    var bytes = byteSize(d);
    if (bytes > MAX_CONTENT_BYTES) {
      if (!_tooBigSaid[s.id]) {
        _tooBigSaid[s.id] = 1;
        if (window.uiAlert) window.uiAlert('This shared entry is too large to sync (' + Math.round(bytes / 1024) + ' KB of text). It is saved on this device but the other person will not see new changes until it is shorter.', { title: 'OurJournal' });
      }
      throw new Error('oj-too-large');
    }
    var w = CLIENT + a.app + (++_wseq).toString(36) + Date.now().toString(36);
    var payload = { d: d, w: w, pw: prevKnown ? prevKnown.w : '', by: a.person, at: Date.now() };
    k.mine.add(w); remember(k, w, d);
    k.known = { w: w, pw: payload.pw, d: d };
    s.lastWrite = Date.now();
    return f.set(cDocId(s.id), payload);
  }).then(function () {
    s.inflight = null; s.errN = 0;
    a.h.setSync('synced');
    if (s.want) schedule(a, s); else maybeClose(a, s);
  }).catch(function (err) {
    s.inflight = null; s.errN++;
    if (k.known && !prevKnown || (k.known && prevKnown && k.known.w !== prevKnown.w)) k.known = prevKnown;
    console.warn('[OJ] content write failed:', err && (err.code || err.message));
    a.h.setSync('error');
    if (err && err.message === 'oj-too-large') return;
    s.want = true;
    setTimeout(function () { if (a.docs[s.id] === s) schedule(a, s); }, Math.min(30000, 1500 * s.errN));
  });
  return s.inflight;
}
function maybeClose(a, s) {
  if (!s.closing || s.want || s.inflight || s.timer) return;
  if (s.unsub) { try { s.unsub(); } catch (e) {} s.unsub = null; }
  if (a.docs[s.id] === s) delete a.docs[s.id];
}

/* ══════════════ Public API ══════════════ */
window.OJ = {
  NS: NS,
  TEMPLATES: TEMPLATES,
  person: function (app) { return PEOPLE[app]; },
  name: function (p) { return NAMES[p] || ''; },
  register: register,
  state: function (app) { return apps[app] ? apps[app].S : null; },
  isLoaded: function (e) { return !!(e && e._ojLoaded); },
  enter: function (app) {
    var a = apps[app]; if (!a) return;
    a.on = true;
    startIndex(a);
    try { localStorage.setItem('oj_mode_' + app, '1'); } catch (e) {}
  },
  leave: function (app) {
    var a = apps[app]; if (!a) return;
    a.on = false;
    try { localStorage.removeItem('oj_mode_' + app); } catch (e) {}
    flushMeta(a);
    Object.keys(a.docs).forEach(function (id) { var s = a.docs[id]; s.closing = true; if (s.want) writeNow(a, s); else maybeClose(a, s); });
    // The index listener stays only while something is still waiting to go up.
    var stop = function () { if (!a.on) stopIndex(a); };
    if (a.metaInflight) a.metaInflight.then(stop, stop); else if (!Object.keys(a.dirty).length) stop();
  },
  wasOn: function (app) { try { return localStorage.getItem('oj_mode_' + app) === '1'; } catch (e) { return false; } },
  // An entry needs its content before it can be painted.
  open: function (app, e) {
    var a = apps[app]; if (!a || !e) return;
    var s = session(a, e);
    s.ready.then(function () {
      if (a.on && a.h.shown() && a.S.activeId === e.id) a.h.reload();
    });
  },
  // The app painted entry `e`: it is now the one live document; every other
  // session flushes what it owes and closes (no listener left on a document
  // nobody is looking at).
  painted: function (app, e) {
    var a = apps[app]; if (!a) return;
    if (e) session(a, e);
    Object.keys(a.docs).forEach(function (id) {
      if (e && id === e.id) return;
      var s = a.docs[id]; s.closing = true;
      if (s.want) writeNow(a, s); else maybeClose(a, s);
    });
  },
  created: function (app, e) {
    var a = apps[app]; if (!a) return;
    e.creator = PEOPLE[app];
    e._ojLoaded = true; e._ojNew = true;
    session(a, e);
  },
  touched: touched,
  flush: function (app) {
    var a = apps[app]; if (!a) return Promise.resolve();
    var ps = [flushMeta(a)];
    Object.keys(a.docs).forEach(function (id) { var s = a.docs[id]; if (s.want) ps.push(writeNow(a, s)); });
    return Promise.all(ps);
  },
  hardDelete: hardDelete,
  writeCache: writeCache,
  mergeText: mergeText,
  mergeD: mergeD,
  _diff: diffHunks,
  _patchEditor: patchEditor
};

// Every (re)connection: the previous listeners died with the old client, so
// re-attach the index and every open document. Writes wait for the new
// connection to confirm server state before they flush (seen flags reset).
window.addEventListener('fb-ready', function () {
  Object.keys(apps).forEach(function (app) {
    var a = apps[app];
    if (a.idx.unsub) { try { a.idx.unsub(); } catch (e) {} a.idx.unsub = null; }
    if (a.on || Object.keys(a.dirty).length || Object.keys(a.dels).length) startIndex(a);
    Object.keys(a.docs).forEach(function (id) {
      var s = a.docs[id];
      if (s.unsub) { try { s.unsub(); } catch (e) {} s.unsub = null; }
      watchSession(a, s);
    });
  });
});
})();
