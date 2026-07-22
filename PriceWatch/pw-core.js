// ─────────────────────────────────────────────────────────────────────────────
// pw-core.js — pure helpers shared by the service worker and the popup.
//
// The scoring / store-normalisation logic here is a deliberate PORT of
// workers/personal-ai/worker.js (`relevanceScore`, `normStores`, `cleanDomain`)
// so a scraped result set ranks and shapes IDENTICALLY to the AI-search path.
// MyList consumes both through the same `pwApplyResult()`, so if these two ever
// drift the UI silently starts ordering live results differently from estimated
// ones. Keep them in sync.
// ─────────────────────────────────────────────────────────────────────────────
(function (g) {
  "use strict";

  // Only these two banners have a real Kroger Products API path (see
  // STORE_NOTES.md). They are never scraped — the worker prices them.
  var KROGER_BANNERS = { kroger: 1, kingsoopers: 1 };

  function cleanDomain(d) {
    return String(d || "").trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  }

  function normName(s) {
    return String(s == null ? "" : s).toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // Mirrors normStores() in worker.js — same key slug, same kroger coercion, so
  // the store list MyList sends survives the round trip unchanged.
  function normStores(input) {
    if (!Array.isArray(input) || !input.length) return [];
    var out = [], seen = {};
    for (var i = 0; i < input.length; i++) {
      var s = input[i];
      if (!s || !s.key) continue;
      var key = String(s.key).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40);
      if (!key || seen[key]) continue;
      seen[key] = 1;
      var type = (s.type === "kroger" || KROGER_BANNERS[key]) ? "kroger" : "ai";
      out.push({ key: key, name: String(s.name || key).slice(0, 40), domain: cleanDomain(s.domain), type: type });
    }
    return out;
  }

  // 0..~1.3 — token overlap of query(+brandLock) against brand+title, plus a
  // full-phrase bonus. Port of worker.js:relevanceScore.
  function relevanceScore(query, brandLock, text) {
    var q = normName((brandLock ? brandLock + " " : "") + (query || ""));
    var t = normName(text || "");
    if (!q || !t) return 0;
    var qt = q.split(" ").filter(Boolean);
    var ta = t.split(" ").filter(Boolean);
    var tset = {};
    ta.forEach(function (w) { tset[w] = 1; });
    var hit = 0;
    qt.forEach(function (w) {
      if (tset[w]) hit += 1;
      else if (w.length >= 3 && ta.some(function (x) { return x.indexOf(w) >= 0 || w.indexOf(x) >= 0; })) hit += 0.5;
    });
    var score = qt.length ? hit / qt.length : 0;
    if (t.indexOf(normName(query)) >= 0) score += 0.3;
    return score;
  }

  // "$12.34", "12.34", "From $8.99", "$1,299.00" → number | null.
  // Rejects anything outside a sane retail band so stray page numbers ("2024",
  // a star rating, a review count) can't be mistaken for a price.
  function parsePrice(txt) {
    if (typeof txt === "number") return isFinite(txt) ? txt : null;
    var s = String(txt || "").replace(/[  ]/g, " ");
    var m = s.match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
    if (!m) return null;
    var n = parseFloat(m[1].replace(/,/g, "") + (m[2] ? "." + m[2] : ""));
    if (!isFinite(n) || n <= 0 || n > 100000) return null;
    return Math.round(n * 100) / 100;
  }

  function hashKey(s) {
    var h = 5381, str = String(s || "");
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  g.PWCore = {
    KROGER_BANNERS: KROGER_BANNERS,
    cleanDomain: cleanDomain,
    normName: normName,
    normStores: normStores,
    relevanceScore: relevanceScore,
    parsePrice: parsePrice,
    hashKey: hashKey
  };
})(typeof self !== "undefined" ? self : this);
