// parsers/walgreens.js — walgreens.com search results.
//
// Grid: /search/results.jsp?Ntt=<term> (the classic endpoint, still what the
// site's own search box submits to). Results hydrate client-side, so like CVS
// this depends on the settle-poll rather than a single immediate parse.
(function (g) {
  "use strict";
  var H = g.PWP.H;

  g.PWP.register("walgreens.com", {
    file: "parsers/walgreens.js",
    name: "Walgreens",
    max: 10,

    searchUrl: function (q) {
      return "https://www.walgreens.com/search/results.jsp?Ntt=" + encodeURIComponent(q);
    },

    parse: function () {
      var cards = H.pickAll(document, [
        '[data-testid="product-card"]',
        '.product-card',
        'li.item',
        'div[id^="product"]'
      ]);
      return cards.map(function (c) {
        var a = H.pick(c, ['a[href*="/store/c/"]', 'a[href*="productId"]', 'a[href]']);
        var url = H.abs(a && a.getAttribute("href"));
        if (!url) return null;
        return {
          title: H.textOf(c, [
            '[data-testid="product-title"]',
            '.product__title',
            '.product-title',
            'a[title]',
            'h3', 'h2'
          ]) || H.attr(c, ['a[title]'], "title") || H.text(a),
          price: H.price(c, [
            '[data-testid="product-price"]',
            '.product__price',
            '.product-price',
            '[class*="price"]'
          ]),
          thumb: H.img(c, ['img.product__img', 'img']),
          url: url
        };
      }).filter(Boolean);
    }
  });
})(typeof self !== "undefined" ? self : this);
