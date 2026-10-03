/* ============================================================================
 * A1BackupMerge — put a TaskHub dashboard back to a backup without losing
 * what was done after it.
 *
 * Three states of one dashboard doc (dashboards/main or dashboards/vedasdash):
 *   base — what the doc was reset TO (an older backup)
 *   good — the backup from just before the reset
 *   live — what the doc holds now, including fixes made since the reset
 *
 * Every list item (goals, monthlyGoals, habits, rules, rulesDaily, and each
 * data[<day>] list) is matched by id and merged three ways:
 *   - changed only in good (live still equals base)  -> take good
 *   - changed in live since the reset                -> keep live
 *   - added in good, missing from live               -> restore it
 *   - removed in good, brought back by the reset     -> remove it
 *   - added in live after the reset                  -> keep it, UNLESS it is a
 *     re-typed copy of an item being restored (same day, mostly the same
 *     words) — then the original returns and the copy is dropped, carrying
 *     its done state over.
 * Day keys that live no longer has but base did are left out: those days were
 * moved to the archive sidecars and must never re-enter the main doc.
 *
 * Pure functions, no I/O: used by backup-restore.html and by
 * tests/backup-merge.test.js.
 * ========================================================================== */
(function (root) {
  'use strict';

  var LISTS = ['goals', 'monthlyGoals', 'habits', 'rules', 'rulesDaily'];

  function norm(v) {
    return JSON.stringify(v, function (k, x) {
      if (x && typeof x === 'object' && !Array.isArray(x)) {
        var o = {}; Object.keys(x).sort().forEach(function (q) { o[q] = x[q]; }); return o;
      }
      return x;
    });
  }
  function same(a, b) { return norm(a) === norm(b); }
  function idOf(x) { return x && typeof x === 'object' && x.id != null ? String(x.id) : null; }
  function titleOf(x) { return String((x && (x.title || x.text || x.name)) || ''); }
  function words(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
      .filter(function (w) { return w.length > 2; });
  }
  // Re-typed copy: most of the shorter title's words appear in the longer one.
  function looksRetyped(a, b) {
    var wa = words(titleOf(a)), wb = words(titleOf(b));
    if (!wa.length || !wb.length) return false;
    var short = wa.length <= wb.length ? wa : wb, long = short === wa ? wb : wa;
    var hit = short.filter(function (w) { return long.indexOf(w) >= 0; }).length;
    return hit >= 2 && hit / short.length >= 0.6;
  }

  // Field-level three-way merge of two versions of one item.
  function mergeItem(b, g, l) {
    if (b === undefined) return same(g, l) ? l : l;          // both added: live wins
    if (same(l, b)) return g;
    if (same(g, b)) return l;
    if (!g || !l || typeof g !== 'object' || typeof l !== 'object' || Array.isArray(g)) return l;
    var out = {}, keys = {};
    [b || {}, g, l].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      var bv = (b || {})[k], gv = g[k], lv = l[k];
      var v = same(lv, bv) ? gv : lv;
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  // Merge one list. `where` labels the report lines.
  function mergeList(B, G, L, where, report) {
    B = Array.isArray(B) ? B : []; G = Array.isArray(G) ? G : []; L = Array.isArray(L) ? L : [];
    // Lists without ids cannot be matched item by item: take whole-list 3-way.
    var allIds = B.concat(G, L).every(function (x) { return idOf(x) !== null; });
    if (!allIds) {
      if (same(L, B) && !same(G, B)) { report.push({ op: 'replaced', where: where }); return G.slice(); }
      return L.slice();
    }
    var bm = {}, gm = {}, lm = {};
    B.forEach(function (x) { bm[idOf(x)] = x; });
    G.forEach(function (x) { gm[idOf(x)] = x; });
    L.forEach(function (x) { lm[idOf(x)] = x; });

    var restored = [];     // good items live is missing
    var result = [];
    G.forEach(function (g) {
      var id = idOf(g), l = lm[id], b = bm[id];
      if (l === undefined) {
        // Missing from live: either the reset removed it (b missing → added
        // last night) or it was deleted / re-typed this morning. Both come back.
        restored.push(g); result.push(g);
        report.push({ op: 'restored', where: where, title: titleOf(g) });
        return;
      }
      var m = mergeItem(b, g, l);
      if (!same(m, l)) report.push({ op: 'updated', where: where, title: titleOf(m), changes: diffKeys(l, m) });
      result.push(m);
    });
    // Live-only items: removed last night (in base, not in good) → drop;
    // added this morning → keep, unless it re-types a restored original.
    L.forEach(function (l, i) {
      var id = idOf(l);
      if (gm[id] !== undefined) return;
      if (bm[id] !== undefined && same(bm[id], l)) {
        report.push({ op: 'removed', where: where, title: titleOf(l) });
        return;
      }
      var orig = restored.filter(function (r) { return looksRetyped(r, l); })[0];
      if (orig) {
        if (l.done && !orig.done) {
          var j = result.indexOf(orig);
          orig = Object.assign({}, orig, { done: true });
          result[j] = orig;
        }
        report.push({ op: 'dropped-copy', where: where, title: titleOf(l), original: titleOf(orig) });
        return;
      }
      // Keep it, placed after the live item that preceded it.
      var at = 0;
      for (var k = i - 1; k >= 0; k--) {
        var p = result.findIndex(function (r) { return idOf(r) === idOf(L[k]); });
        if (p >= 0) { at = p + 1; break; }
      }
      result.splice(at, 0, l);
      report.push({ op: 'kept-new', where: where, title: titleOf(l) });
    });
    return result;
  }

  function diffKeys(a, b) {
    var keys = {};
    [a || {}, b || {}].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
    return Object.keys(keys).filter(function (k) { return !same((a || {})[k], (b || {})[k]); });
  }

  // Merge whole dashboard docs. Returns { doc, report }.
  function mergeDoc(base, good, live) {
    base = base || {}; good = good || {}; live = live || {};
    var report = [], out = {};
    var keys = {};
    [good, live].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      if (k === 'data' || k === 'savedAt') return;
      if (LISTS.indexOf(k) >= 0) { out[k] = mergeList(base[k], good[k], live[k], k, report); return; }
      var v = mergeItem(base[k], good[k], live[k]);
      if (v !== undefined) out[k] = v;
      if (!same(v, live[k])) report.push({ op: 'updated', where: k });
    });
    var bd = base.data || {}, gd = good.data || {}, ld = live.data || {}, data = {};
    var days = {};
    [gd, ld].forEach(function (o) { Object.keys(o).forEach(function (k) { days[k] = 1; }); });
    Object.keys(days).sort().forEach(function (day) {
      if (!(day in ld) && (day in bd)) return;            // archived since — never re-add
      if (!Array.isArray(gd[day]) && !Array.isArray(ld[day])) {
        data[day] = day in ld ? ld[day] : gd[day]; return;
      }
      var m = mergeList(bd[day], gd[day], ld[day], 'data/' + day, report);
      if (m.length || day in ld) data[day] = m;
    });
    out.data = data;
    out.savedAt = live.savedAt;
    return { doc: out, report: report };
  }

  var api = { mergeDoc: mergeDoc, mergeList: mergeList, looksRetyped: looksRetyped, _norm: norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.A1BackupMerge = api;
})(this);
