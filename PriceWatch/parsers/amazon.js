// parsers/amazon.js — amazon.com search results.
//
// Grid: /s?k=<term>. Amazon's search markup is the most stable of the four:
// data-component-type="s-search-result" has survived years of redesigns, and
// .a-price > .a-offscreen is the canonical machine-readable price (the visible
// price is split across whole/fraction spans).
//
// Price note (STORE_NOTES.md): Amazon prices vary by seller. This reads the
// buy-box price on the search tile, which is the same number a shopper sees.
(function (g) {
  "use strict";
  var H = g.PWP.H;

  g.PWP.register("amazon.com", {
    file: "parsers/amazon.js",
    name: "Amazon",
    max: 12,

    searchUrl: function (q) {
      return "https://www.amazon.com/s?k=" + encodeURIComponent(q);
    },

    blocked: function () {
      if (document.querySelector('form[action*="validateCaptcha"], #captchacharacters')) return true;
      return /enter the characters you see|sorry, we just need to make sure/i
        .test(document.body && document.body.innerText || "");
    },

    parse: function () {
      var cards = H.pickAll(document, [
        'div[data-component-type="s-search-result"]',
        '.s-result-item[data-asin]:not([data-asin=""])'
      ]);
      return cards.map(function (c) {
        // Skip the sponsored-brand banner rows — they carry no single price.
        if (c.querySelector('[data-component-type="sb-video"], .AdHolder')) return null;
        var asin = c.getAttribute("data-asin") || "";
        var a = H.pick(c, ['h2 a.a-link-normal', 'a.a-link-normal.s-no-outline', 'h2 a', 'a[href*="/dp/"]']);
        var url = H.abs(a && a.getAttribute("href"));
        // A canonical /dp/ URL is stabler than the tracking-laden search href.
        if (asin) url = "https://www.amazon.com/dp/" + asin;
        if (!url) return null;
        return {
          title: H.textOf(c, ['h2 span', '[data-cy="title-recipe"] h2', 'h2']),
          // .a-offscreen is the full "$12.34" string; take it before the split spans.
          price: H.price(c, ['.a-price .a-offscreen', '.a-price', '.a-color-price']),
          thumb: H.img(c, ['img.s-image', 'img']),
          url: url,
          brand: H.textOf(c, ['[data-cy="title-recipe"] .a-row .a-size-base+.a-size-base'])
        };
      }).filter(Boolean);
    }
  });
})(typeof self !== "undefined" ? self : this);
