// parsers/walmart.js — walmart.com search results.
//
// Grid: /search?q=<term>. Cards are the only reliable anchor Walmart has kept
// stable across redesigns — every tile carries data-item-id. The selector
// lists below run newest-markup-first.
(function (g) {
  "use strict";
  var H = g.PWP.H;

  g.PWP.register("walmart.com", {
    file: "parsers/walmart.js",
    name: "Walmart",
    max: 12,

    searchUrl: function (q) {
      return "https://www.walmart.com/search?q=" + encodeURIComponent(q);
    },

    // Walmart's bot wall is a "Robot or human?" press-and-hold page.
    blocked: function () {
      if (document.querySelector('[data-testid="captcha"], #px-captcha, form[action*="blocked"]')) return true;
      return /robot or human/i.test(document.body && document.body.innerText || "");
    },

    parse: function () {
      var cards = H.pickAll(document, [
        'div[data-item-id]',
        '[data-testid="list-view"] > div',
        '[data-automation-id="product-tile"]'
      ]);
      return cards.map(function (c) {
        var a = H.pick(c, ['a[link-identifier]', 'a[href*="/ip/"]', 'a[href]']);
        var url = H.abs(a && a.getAttribute("href"));
        // Sponsored tiles and "shop similar" rails link off-catalogue; only
        // /ip/ URLs are real product pages.
        if (url.indexOf("/ip/") < 0) return null;
        return {
          title: H.textOf(c, [
            'span[data-automation-id="product-title"]',
            '[data-automation-id="product-title"]',
            'a[link-identifier] span',
            'span.w_iUH7'
          ]) || H.text(a),
          price: H.price(c, [
            'div[data-automation-id="product-price"] span.w_iUH7',
            'div[data-automation-id="product-price"]',
            '[data-automation-id="product-price"]',
            'span.f2'
          ]),
          thumb: H.img(c, ['img[data-testid="productTileImage"]', 'img[loading]', 'img']),
          url: url,
          brand: H.textOf(c, ['[data-automation-id="product-brand"]'])
        };
      }).filter(Boolean);
    }
  });
})(typeof self !== "undefined" ? self : this);
