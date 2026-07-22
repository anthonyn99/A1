// ─────────────────────────────────────────────────────────────────────────────
// parsers/common.js — the parser registry + the DOM helpers every store module
// is built from.
//
// This file (and every parsers/*.js beside it) is loaded in TWO contexts:
//
//   1. the background service worker, via importScripts() in background.js —
//      so it can look up a store's searchUrl() and which file to inject. This
//      is also what makes the Install-PriceWatch packager discover the parser
//      files: index.html's collector walks importScripts() calls.
//   2. the scraped page's ISOLATED world, via chrome.scripting.executeScript —
//      where parse()/blocked() actually run against the DOM.
//
// Therefore: NOTHING here may touch `document` at load time. DOM access belongs
// inside parse() / blocked() only.
//
// A store module is registered by DOMAIN, matching the `domain` field MyList
// stores per retailer. A store whose domain has no module registered is
// reported back as source:"unsupported" — never an error that sinks the whole
// request.
// ─────────────────────────────────────────────────────────────────────────────
(function (g) {
  "use strict";

  var PARSERS = g.PW_PARSERS || (g.PW_PARSERS = {});

  // ── DOM helpers (page context only) ──────────────────────────────────────
  // Every selector below is a LIST tried in order. Retail markup churns
  // constantly, so a store module lists today's selector first and older /
  // more generic ones after; a module keeps working through a redesign as long
  // as one of them still matches.
  var H = {
    // First element matching any selector in the list.
    pick: function (root, sels) {
      for (var i = 0; i < sels.length; i++) {
        try { var el = root.querySelector(sels[i]); if (el) return el; } catch (e) {}
      }
      return null;
    },
    // All elements for the FIRST selector in the list that matches anything.
    pickAll: function (root, sels) {
      for (var i = 0; i < sels.length; i++) {
        try {
          var els = root.querySelectorAll(sels[i]);
          if (els && els.length) return Array.prototype.slice.call(els);
        } catch (e) {}
      }
      return [];
    },
    text: function (el) {
      if (!el) return "";
      return String(el.textContent || "").replace(/\s+/g, " ").trim();
    },
    textOf: function (root, sels) { return H.text(H.pick(root, sels)); },
    attr: function (root, sels, name) {
      var el = H.pick(root, sels);
      if (!el) return "";
      return String(el.getAttribute(name) || "").trim();
    },
    // Resolve a possibly-relative href against the current page.
    abs: function (href) {
      if (!href) return "";
      try { return new URL(href, location.href).href; } catch (e) { return ""; }
    },
    // Lazy-loaded grids leave the real src in data-src / srcset until scrolled.
    img: function (root, sels) {
      var el = H.pick(root, sels);
      if (!el) return "";
      var src = el.getAttribute("src") || el.getAttribute("data-src") || "";
      if (!src) {
        var ss = el.getAttribute("srcset") || el.getAttribute("data-srcset") || "";
        if (ss) src = ss.split(",")[0].trim().split(" ")[0];
      }
      return H.abs(src);
    },
    // Price from a list of selectors, falling back to a regex sweep of the
    // card's own text — which is what carries a module through a markup change
    // that renames the price node.
    price: function (root, sels) {
      for (var i = 0; i < sels.length; i++) {
        var els = [];
        try { els = Array.prototype.slice.call(root.querySelectorAll(sels[i])); } catch (e) {}
        for (var j = 0; j < els.length; j++) {
          var p = g.PWCore.parsePrice(H.text(els[j]));
          if (p !== null) return p;
        }
      }
      var m = H.text(root).match(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/);
      return m ? g.PWCore.parsePrice(m[0]) : null;
    },
    // DEFINITIVE bot-wall signatures — the named interstitials of the big
    // vendors (Akamai "Challenge Validation", PerimeterX, Cloudflare, Incapsula)
    // plus a visible captcha. Seeing one of these ends the attempt immediately.
    hardBlocked: function () {
      var t = String(document.title || "").toLowerCase();
      if (/robot|captcha|challenge validation|just a moment|are you a human|access denied|bot detect|unusual traffic|verify you|request unsuccessful|pardon our interruption/.test(t)) return true;
      if (document.querySelector('form[action*="validateCaptcha"], iframe[src*="recaptcha"], iframe[title*="challenge"], #captcha, #px-captcha, [data-testid="captcha"]')) return true;
      return /enable javascript and cookies to continue|verifying you are human/i
        .test(document.body && document.body.innerText || "");
    },
    // SOFT signal: an empty / near-empty body. On its own this is ambiguous —
    // a slow SPA looks identical for the first second — so callers must only
    // conclude "blocked" from this after the poll budget is spent, never on the
    // first pass. (Walgreens' Akamai wall renders a 0-length body, which is
    // what this catches once hardBlocked misses the title.)
    weakBlocked: function () {
      return (document.body && document.body.innerText || "").length < 220;
    }
  };

  // Normalise whatever a module returns into the one shape the background
  // expects, dropping anything without a usable price or product URL.
  function normResults(list, max) {
    var out = [], seen = {};
    (list || []).forEach(function (r) {
      if (!r) return;
      var price = g.PWCore.parsePrice(r.price);
      var url = String(r.url || "").trim();
      var title = String(r.title || "").replace(/\s+/g, " ").trim();
      if (price === null || !url || !title) return;
      var k = url.split("?")[0];
      if (seen[k]) return;
      seen[k] = 1;
      out.push({
        title: title.slice(0, 160),
        price: price,
        currency: String(r.currency || "USD").slice(0, 6),
        thumb: String(r.thumb || "").slice(0, 600),
        url: url.slice(0, 600),
        brand: String(r.brand || "").slice(0, 60),
        size: String(r.size || "").slice(0, 40)
      });
    });
    return out.slice(0, max || 12);
  }

  g.PWP = {
    H: H,
    normResults: normResults,
    // def: { file, name, searchUrl(q), blocked?(), parse() }
    register: function (domain, def) {
      PARSERS[domain] = def;
      return def;
    },
    get: function (domain) { return PARSERS[g.PWCore.cleanDomain(domain)] || null; },
    domains: function () { return Object.keys(PARSERS); },
    // Runs in the page. Returns {results, blocked, weak} — never throws, so a
    // broken selector degrades to "found nothing" instead of killing the run.
    // `blocked` is definitive; `weak` is the caller's to interpret once it has
    // stopped waiting for the page to fill in.
    run: function (domain) {
      var def = PARSERS[domain];
      if (!def) return { results: [], blocked: false, weak: false, note: "no parser for " + domain };
      try {
        if ((def.blocked && def.blocked()) || H.hardBlocked()) return { results: [], blocked: true, weak: false };
      } catch (e) {}
      var weak = false;
      try { weak = H.weakBlocked(); } catch (e) {}
      try {
        return { results: normResults(def.parse(), def.max || 12), blocked: false, weak: weak };
      } catch (e) {
        return { results: [], blocked: false, weak: weak, note: "parse error: " + (e && e.message || e) };
      }
    }
  };
})(typeof self !== "undefined" ? self : this);
