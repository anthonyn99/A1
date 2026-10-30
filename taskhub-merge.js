/* ============================================================================
 * THMerge — three-way merge of two concurrent saves of one TaskHub document
 * (dashboards/main or dashboards/vedasdash).
 *
 *   base   — the version both saves started from
 *   mine   — this device's state (base + its edits)
 *   theirs — what the cloud holds now (base + another device's edits)
 *
 * index.html calls syncMerge when a save is refused because another device
 * saved first (see _casWrite). Nothing is lost in either direction: each
 * side's additions, edits and deletions all survive. Where both changed the
 * same field, this device's value wins: it is the newer intent.
 *
 * Lists of items with ids (goals, habits, each data[<day>]) merge item by
 * item. Plain objects (hc, goalPrefs, rulesDaily) merge key by key. Anything
 * else is one value. Without a base (a fresh page that edited before the
 * cloud copy arrived) the merge is a union: nothing is deleted, and nothing
 * of the sample week (_demo items) is added.
 *
 * Pure functions, no I/O: tested by tests/taskhub-merge.test.js.
 * ========================================================================== */
(function (root) {
  'use strict';

  var SKIP = { savedAt: 1, rev: 1, data: 1 };

  function norm(v) {
    return JSON.stringify(v, function (k, x) {
      if (x && typeof x === 'object' && !Array.isArray(x)) {
        var o = {}; Object.keys(x).sort().forEach(function (q) { o[q] = x[q]; }); return o;
      }
      return x;
    });
  }
  function same(a, b) { return a === b || norm(a) === norm(b); }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function idOf(x) { return isObj(x) && x.id != null ? String(x.id) : null; }

  // One value, three ways. Both changed → mine.
  function pick(b, m, t) {
    if (same(m, b)) return t;
    if (same(t, b)) return m;
    return m;
  }

  // Key by key. A key one side deleted (and the other left alone) is deleted.
  function mergeObj(b, m, t) {
    b = isObj(b) ? b : {}; m = isObj(m) ? m : {}; t = isObj(t) ? t : {};
    var out = {}, keys = {};
    [b, m, t].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      var v = pick(b[k], m[k], t[k]);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  // One item present on both sides.
  function mergeItem(b, m, t) {
    if (same(m, t)) return m;
    if (b === undefined) return isObj(m) && isObj(t) ? mergeObj({}, m, t) : m;
    if (same(m, b)) return t;
    if (same(t, b)) return m;
    return isObj(m) && isObj(t) ? mergeObj(b, m, t) : m;
  }

  function allIds(a) { return a.every(function (x) { return idOf(x) !== null; }); }

  function mergeList(B, M, T) {
    var hasB = Array.isArray(B);
    B = hasB ? B : []; M = Array.isArray(M) ? M : []; T = Array.isArray(T) ? T : [];
    if (!allIds(B.concat(M, T))) return pick(hasB ? B : undefined, M, T) || [];
    var bm = {}, mm = {}, tm = {};
    B.forEach(function (x) { bm[idOf(x)] = x; });
    M.forEach(function (x) { mm[idOf(x)] = x; });
    T.forEach(function (x) { tm[idOf(x)] = x; });

    var out = [];
    T.forEach(function (t) {
      var id = idOf(t), m = mm[id], b = bm[id];
      if (m === undefined) {
        // Not here: this device deleted it, unless theirs changed it since.
        if (b !== undefined && same(t, b)) return;
        out.push(t);
        return;
      }
      out.push(mergeItem(b, m, t));
    });
    // This device's items the cloud does not have: added here → keep; deleted
    // there and untouched here → gone; deleted there but edited here → keep.
    M.forEach(function (m, i) {
      var id = idOf(m);
      if (tm[id] !== undefined) return;
      var b = bm[id];
      if (b !== undefined && same(m, b)) return;
      // The sample week a brand-new device starts with is not something Tony
      // added: one that saved before the cloud copy arrived merged it into
      // the real document (2026-10-29). Seeded items carry _demo.
      if (b === undefined && isObj(m) && m._demo) return;
      var at = 0;
      for (var k = i - 1; k >= 0; k--) {
        var pid = idOf(M[k]);
        var p = -1;
        for (var j = 0; j < out.length; j++) if (idOf(out[j]) === pid) { p = j; break; }
        if (p >= 0) { at = p + 1; break; }
      }
      out.splice(at, 0, m);
    });
    return out;
  }

  function mergeField(b, m, t) {
    if (Array.isArray(m) || Array.isArray(t)) return mergeList(b, m, t);
    if (isObj(m) && isObj(t)) return mergeObj(b, m, t);
    return pick(b, m, t);
  }

  function syncMerge(base, mine, theirs) {
    var hasBase = isObj(base) && Object.keys(base).length > 0;
    base = hasBase ? base : {}; mine = mine || {}; theirs = theirs || {};
    var out = {}, keys = {};
    [mine, theirs].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      if (SKIP[k] || k.charAt(0) === '_') return;
      // Without a base, an absent field is "no news", never a deletion.
      var v = !hasBase && mine[k] === undefined ? theirs[k]
            : !hasBase && theirs[k] === undefined ? mine[k]
            : mergeField(base[k], mine[k], theirs[k]);
      if (v !== undefined) out[k] = v;
    });
    var bd = base.data || {}, md = mine.data || {}, td = theirs.data || {}, data = {}, days = {};
    [bd, md, td].forEach(function (o) { Object.keys(o).forEach(function (k) { days[k] = 1; }); });
    Object.keys(days).sort().forEach(function (day) {
      var inM = day in md, inT = day in td;
      if (!inM && !inT) return;
      var v;
      if (!Array.isArray(md[day]) && !Array.isArray(td[day])) v = pick(bd[day], md[day], td[day]);
      else v = mergeList(day in bd ? bd[day] : undefined, md[day], td[day]);
      // A day one side dropped (archived or emptied) stays dropped unless the
      // merge still holds something for it.
      if (v === undefined) return;
      if (Array.isArray(v) && !v.length && !(inM && inT)) return;
      data[day] = v;
    });
    if (Object.keys(days).length || mine.data || theirs.data) out.data = data;
    return out;
  }

  var api = { syncMerge: syncMerge, mergeList: mergeList, mergeObj: mergeObj, _norm: norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.THMerge = api;
})(this);
