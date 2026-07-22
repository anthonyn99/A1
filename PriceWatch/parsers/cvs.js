// parsers/cvs.js — cvs.com search results.
//
// Grid: /search?searchTerm=<term>. CVS renders results client-side into a
// React grid, so the settle-poll in background.js matters more here than at
// Walmart/Amazon — an immediate parse usually sees an empty shell.
//
// Price caveat (STORE_NOTES.md): CVS online and in-store prices differ and the
// site often wants a ZIP before showing a store price. This reads the ONLINE
// price, which is what renders without a store selected.
(function (g) {
  "use strict";
  var H = g.PWP.H;

  g.PWP.register("cvs.com", {
    file: "parsers/cvs.js",
    name: "CVS",
    max: 10,

    searchUrl: function (q) {
      return "https://www.cvs.com/search?searchTerm=" + encodeURIComponent(q);
    },

    parse: function () {
      var cards = H.pickAll(document, [
        '[data-testid="product-card"]',
        '.product-card',
        'li[class*="product-tile"]',
        'article[class*="product"]'
      ]);
      return cards.map(function (c) {
        var a = H.pick(c, ['a[href*="/shop/"]', 'a[href*="prodid"]', 'a[href]']);
        var url = H.abs(a && a.getAttribute("href"));
        if (!url) return null;
        return {
          title: H.textOf(c, [
            '[data-testid="product-title"]',
            '.product-title',
            'a[href*="/shop/"] span',
            'h3', 'h2'
          ]) || H.text(a),
          price: H.price(c, [
            '[data-testid="product-price"]',
            '.product-price',
            '[class*="price"]'
          ]),
          thumb: H.img(c, ['img[data-testid="product-image"]', 'img']),
          url: url
        };
      }).filter(Boolean);
    }
  });
})(typeof self !== "undefined" ? self : this);
