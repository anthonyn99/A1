/* ─────────────────────────────────────────────────────────────────────────────
 * warden-pay.js — Warden · payment-methods core (PURE logic, no DOM, no network)
 *
 * The single source of truth for everything payment-shaped, shared verbatim by
 * the PWA (warden-pay-ui.js) and the browser extension (popup panel, background
 * service worker, autofill content script) — exactly like warden-crypto.js is
 * shared for crypto. Runs in the PWA, an extension, and Node ≥ 16.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * No encryption, no storage, no DOM. A payment method is just another
 * warden-store.js item with `kind: 'payment'`, so it inherits the ENTIRE existing
 * security model for free:
 *
 *     { id, kind:'payment', enc:{iv,ct}, updatedAt, deleted }
 *
 * `kind` is the only plaintext field (routing, same as 'login'/'sensitive').
 * The card number, CVV, cardholder, billing address, expiry, nickname, brand
 * and last-4 ALL live inside `enc` — AES-256-GCM under the warden's DEK. The
 * cloud never sees a single digit. See warden-crypto.js / warden-store.js.
 *
 * ── Extensibility ───────────────────────────────────────────────────────────
 * `METHODS` is a registry, not a hardcoded card type. Adding a bank account,
 * PayPal, or a gift card later means appending one entry there (+ its fields)
 * — the store, crypto, sync, autofill dispatch and UI all key off the registry.
 * Likewise `IMPORTERS` is a registry, so a new exporter format is one object.
 * ──────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';
  if (global.WardenPay) return;

  var KIND = 'payment';

  // ── Card networks ─────────────────────────────────────────────────────────
  // `test` matches the IIN/BIN prefix. ORDER MATTERS: narrower ranges first
  // (Discover's 622126-622925 sits inside UnionPay's 62, so it is listed first).
  var NETWORKS = [
    { id: 'amex',       label: 'American Express', test: /^3[47]/,                                                  lengths: [15],             gaps: [4, 10],    cvv: 4, color: '#1F72CD' },
    { id: 'diners',     label: 'Diners Club',      test: /^3(?:0[0-59]|[689])/,                                     lengths: [14, 16, 19],     gaps: [4, 10],    cvv: 3, color: '#0079BE' },
    { id: 'jcb',        label: 'JCB',              test: /^35(?:2[89]|[3-8])/,                                      lengths: [16, 17, 18, 19], gaps: [4, 8, 12], cvv: 3, color: '#0B4EA2' },
    { id: 'visa',       label: 'Visa',             test: /^4/,                                                      lengths: [13, 16, 19],     gaps: [4, 8, 12], cvv: 3, color: '#1A1F71' },
    { id: 'maestro',    label: 'Maestro',          test: /^(?:5018|5020|5038|5893|6304|6759|676[1-3])/,             lengths: [12, 13, 14, 15, 16, 17, 18, 19], gaps: [4, 8, 12], cvv: 3, color: '#6C6BBD' },
    { id: 'mastercard', label: 'Mastercard',       test: /^(?:5[1-5]|2(?:2(?:2[1-9]|[3-9])|[3-6]|7(?:[01]|20)))/,   lengths: [16],             gaps: [4, 8, 12], cvv: 3, color: '#EB001B' },
    { id: 'discover',   label: 'Discover',         test: /^(?:6011|64[4-9]|65|622(?:12[6-9]|1[3-9]|[2-8]|9[01]|92[0-5]))/, lengths: [16, 17, 18, 19], gaps: [4, 8, 12], cvv: 3, color: '#FF6000' },
    { id: 'unionpay',   label: 'UnionPay',         test: /^62/,                                                     lengths: [16, 17, 18, 19], gaps: [4, 8, 12], cvv: 3, color: '#E21836' },
    { id: 'mir',        label: 'Mir',              test: /^220[0-4]/,                                               lengths: [16, 17, 18, 19], gaps: [4, 8, 12], cvv: 3, color: '#0F754E' },
    { id: 'rupay',      label: 'RuPay',            test: /^(?:60|6521|6522)/,                                       lengths: [16],             gaps: [4, 8, 12], cvv: 3, color: '#097B3C' },
  ];
  var UNKNOWN_NETWORK = { id: 'unknown', label: 'Card', test: null, lengths: [], gaps: [4, 8, 12], cvv: 3, color: '#6E6E7E' };

  function networkById(id) {
    for (var i = 0; i < NETWORKS.length; i++) if (NETWORKS[i].id === id) return NETWORKS[i];
    return UNKNOWN_NETWORK;
  }
  // Detect from the number itself. Returns the UNKNOWN_NETWORK object (never
  // null) so callers can always read .label/.cvv/.gaps without a guard.
  function detectNetwork(number) {
    var d = digits(number);
    if (!d) return UNKNOWN_NETWORK;
    for (var i = 0; i < NETWORKS.length; i++) if (NETWORKS[i].test.test(d)) return NETWORKS[i];
    return UNKNOWN_NETWORK;
  }
  // The network to USE for an item: an explicitly-saved brand wins (so a card
  // whose number was never stored still shows the right logo), else detection.
  function networkOf(item) {
    item = item || {};
    if (item.network && item.network !== 'unknown') return networkById(item.network);
    return detectNetwork(item.number || '');
  }

  // ── Number helpers ────────────────────────────────────────────────────────
  function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

  // Group a string into the network's display blocks (works on digits OR on a
  // masked string of bullets — it never strips characters).
  function group(str, gaps) {
    str = String(str == null ? '' : str);
    gaps = gaps && gaps.length ? gaps : [4, 8, 12];
    var out = '', prev = 0;
    for (var i = 0; i < gaps.length && gaps[i] < str.length; i++) { out += str.slice(prev, gaps[i]) + ' '; prev = gaps[i]; }
    return out + str.slice(prev);
  }
  function formatNumber(number, networkId) {
    var d = digits(number);
    if (!d) return '';
    return group(d, (networkId ? networkById(networkId) : detectNetwork(d)).gaps);
  }
  function last4(number) { var d = digits(number); return d.length >= 4 ? d.slice(-4) : d; }

  // "•••• •••• •••• 1234" — the DEFAULT representation everywhere. Full numbers
  // are only ever produced by an explicit, authenticated reveal.
  function maskNumber(number, networkId, opts) {
    var d = digits(number);
    if (!d) return '';
    var keep = opts && opts.keep != null ? opts.keep : 4;
    if (d.length <= keep) return d;
    var hidden = opts && opts.char ? opts.char : '•';
    var masked = new Array(d.length - keep + 1).join(hidden) + d.slice(-keep);
    return group(masked, (networkId ? networkById(networkId) : detectNetwork(d)).gaps);
  }
  // Compact form for tight rows / the extension dropdown: "Visa •• 1234".
  function shortMask(item) {
    var n = networkOf(item), l4 = last4(item.number || item.last4 || '');
    return n.label + (l4 ? ' •• ' + l4 : '');
  }

  // Luhn (mod-10) checksum — catches typos, and is what every checkout uses.
  function luhn(number) {
    var d = digits(number);
    if (d.length < 12) return false;
    var sum = 0, dbl = false;
    for (var i = d.length - 1; i >= 0; i--) {
      var n = d.charCodeAt(i) - 48;
      if (dbl) { n *= 2; if (n > 9) n -= 9; }
      sum += n; dbl = !dbl;
    }
    return sum % 10 === 0;
  }
  function cvvLength(item) { return networkOf(item).cvv; }

  // ── Expiry ────────────────────────────────────────────────────────────────
  function padMonth(m) { var n = parseInt(String(m).replace(/\D/g, ''), 10); return n >= 1 && n <= 12 ? (n < 10 ? '0' + n : String(n)) : ''; }
  // Accepts 4-digit ("2029"), 2-digit ("29") or a full date; returns 4 digits.
  function fullYear(y) {
    var s = String(y == null ? '' : y).replace(/\D/g, '');
    if (!s) return '';
    if (s.length >= 4) return s.slice(0, 4);
    if (s.length <= 2) return String(2000 + parseInt(s, 10));
    return s;
  }
  function shortYear(y) { var f = fullYear(y); return f ? f.slice(-2) : ''; }
  function expiryLabel(month, year) {
    var m = padMonth(month), y = shortYear(year);
    return m && y ? m + '/' + y : (m || y || '');
  }
  // Parse the many shapes a pasted/imported expiry arrives in: "04/29",
  // "4-2029", "2029-04", "042029". Returns { month, year } ('' when unknown).
  function parseExpiry(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return { month: '', year: '' };
    var m = /^(\d{4})\D+(\d{1,2})$/.exec(s);                   // 2029-04
    if (m) return { month: padMonth(m[2]), year: fullYear(m[1]) };
    m = /^(\d{1,2})\D+(\d{2,4})$/.exec(s);                     // 04/29, 4-2029
    if (m) return { month: padMonth(m[1]), year: fullYear(m[2]) };
    var d = s.replace(/\D/g, '');
    if (d.length === 4) return { month: padMonth(d.slice(0, 2)), year: fullYear(d.slice(2)) };
    if (d.length === 6) return { month: padMonth(d.slice(0, 2)), year: fullYear(d.slice(2)) };
    return { month: '', year: '' };
  }
  var EXPIRING_DAYS = 60;
  // 'expired' | 'expiring' | 'valid' | 'unknown'. A card is valid through the
  // LAST day of its expiry month, which is how issuers define it.
  function expiryStatus(month, year, now) {
    var m = padMonth(month), y = fullYear(year);
    if (!m || !y) return { state: 'unknown', days: null, label: '' };
    var end = new Date(parseInt(y, 10), parseInt(m, 10), 1).getTime(); // 1st of the NEXT month
    var t = now == null ? Date.now() : now;
    var days = Math.floor((end - t) / 86400000);
    if (days <= 0) return { state: 'expired', days: days, label: 'Expired' };
    if (days <= EXPIRING_DAYS) return { state: 'expiring', days: days, label: 'Expires in ' + days + ' day' + (days === 1 ? '' : 's') };
    return { state: 'valid', days: days, label: '' };
  }

  // ── Billing address ───────────────────────────────────────────────────────
  // Stored as a structured object so autofill can target individual checkout
  // fields; rendered as one line for display/copy.
  function emptyAddress() { return { line1: '', line2: '', city: '', region: '', postal: '', country: '' }; }
  function normalizeAddress(a) {
    a = a || {};
    return {
      line1: String(a.line1 || '').trim(), line2: String(a.line2 || '').trim(),
      city: String(a.city || '').trim(), region: String(a.region || '').trim(),
      postal: String(a.postal || '').trim(), country: String(a.country || '').trim(),
    };
  }
  function hasAddress(a) {
    a = normalizeAddress(a);
    return !!(a.line1 || a.line2 || a.city || a.region || a.postal || a.country);
  }
  function formatAddress(a, sep) {
    a = normalizeAddress(a);
    var cityLine = [a.city, a.region].filter(Boolean).join(', ');
    if (a.postal) cityLine = cityLine ? cityLine + ' ' + a.postal : a.postal;
    return [a.line1, a.line2, cityLine, a.country].filter(Boolean).join(sep == null ? ', ' : sep);
  }

  // ── Method registry (the extensibility seam) ──────────────────────────────
  // Every payment item carries `method`. Today only 'card' ships, with card
  // TYPES (credit/debit/prepaid/charge) as a sub-classification, because that's
  // the axis Google Wallet surfaces. A future 'bank'/'paypal' method plugs in
  // here with its own fields + autofill mapping and needs no changes elsewhere.
  var CARD_TYPES = [
    { id: 'credit',  label: 'Credit card' },
    { id: 'debit',   label: 'Debit card' },
    { id: 'prepaid', label: 'Prepaid card' },
    { id: 'charge',  label: 'Charge card' },
  ];
  var METHODS = [{
    id: 'card',
    label: 'Card',
    types: CARD_TYPES,
    defaultType: 'credit',
    autofillable: true,
  }];
  function methodById(id) {
    for (var i = 0; i < METHODS.length; i++) if (METHODS[i].id === id) return METHODS[i];
    return METHODS[0];
  }
  function typeLabel(item) {
    item = item || {};
    var m = methodById(item.method || 'card');
    for (var i = 0; i < m.types.length; i++) if (m.types[i].id === item.type) return m.types[i].label;
    return m.types[0].label;
  }

  // ── Normalisation ─────────────────────────────────────────────────────────
  // Canonical shape for a payment BODY (the object warden-store.js encrypts).
  // Called on every save so stored items stay uniform regardless of source
  // (manual entry, import, older schema).
  function normalize(item) {
    item = item || {};
    var number = digits(item.number);
    var net = item.network && item.network !== 'unknown' ? networkById(item.network) : detectNetwork(number);
    return {
      kind: KIND,
      method: methodById(item.method || 'card').id,
      type: item.type || 'credit',
      nickname: String(item.nickname || '').trim(),
      cardholder: String(item.cardholder || '').trim(),
      number: number,
      // Denormalised for display without re-deriving. Still INSIDE the encrypted
      // body — never in the plaintext doc envelope.
      network: net.id,
      last4: last4(number),
      expMonth: padMonth(item.expMonth),
      expYear: fullYear(item.expYear),
      cvv: String(item.cvv == null ? '' : item.cvv).replace(/\D/g, ''),
      billing: normalizeAddress(item.billing),
      notes: String(item.notes || ''),
      favorite: !!item.favorite,
      // Manual drag position. Left undefined (and therefore absent from the
      // encrypted body) until the wallet is actually reordered.
      order: hasOrder(item) ? item.order : undefined,
      category: item.category || 'Payments',
      tags: Array.isArray(item.tags) ? item.tags.filter(Boolean) : [],
      customFields: Array.isArray(item.customFields) ? item.customFields.filter(function (c) { return c && ((c.label || '').trim() || (c.value || '').trim()); }) : [],
    };
  }

  // A safe display summary — contains NO full number and NO CVV, so it is what
  // gets handed to less-trusted contexts (e.g. the autofill dropdown in a page).
  function summarize(item, now) {
    item = item || {};
    var net = networkOf(item);
    var l4 = last4(item.number || item.last4 || '');
    var exp = expiryStatus(item.expMonth, item.expYear, now);
    return {
      id: item.id,
      method: item.method || 'card',
      network: net.id,
      networkLabel: net.label,
      networkColor: net.color,
      typeLabel: typeLabel(item),
      nickname: String(item.nickname || '').trim(),
      cardholder: String(item.cardholder || '').trim(),
      last4: l4,
      masked: maskNumber(item.number || (l4 ? new Array(13).join('0') + l4 : ''), net.id),
      title: String(item.nickname || '').trim() || (net.label + (l4 ? ' •• ' + l4 : '')),
      subtitle: typeLabel(item) + (l4 ? ' · •••• ' + l4 : ''),
      expiry: expiryLabel(item.expMonth, item.expYear),
      expiryState: exp.state,
      expiryLabelLong: exp.label,
      favorite: !!item.favorite,
      hasCvv: !!(item.cvv && String(item.cvv).length),
      hasBilling: hasAddress(item.billing),
    };
  }

  // ── Validation (for the editor; never blocks decryption) ──────────────────
  function validate(item) {
    var errors = [], warnings = [];
    var n = digits(item && item.number), net = networkOf(item);
    if (!n) {
      warnings.push('No card number saved — autofill will skip this card.');
    } else {
      if (n.length < 12) errors.push('Card number looks too short.');
      else if (!luhn(n)) errors.push('That card number fails its checksum — check for a typo.');
      else if (net.lengths.length && net.lengths.indexOf(n.length) < 0) warnings.push('Unusual length for a ' + net.label + ' card.');
    }
    if (item && item.expMonth && !padMonth(item.expMonth)) errors.push('Expiry month must be 1–12.');
    if (item && item.expMonth && item.expYear) {
      var st = expiryStatus(item.expMonth, item.expYear);
      if (st.state === 'expired') warnings.push('This card is already expired.');
    }
    var cvv = String((item && item.cvv) || '').replace(/\D/g, '');
    if (cvv && cvv.length !== net.cvv) warnings.push(net.label + ' security codes are ' + net.cvv + ' digits.');
    if (!item || !String(item.cardholder || '').trim()) warnings.push('No cardholder name — some checkouts require it.');
    return { errors: errors, warnings: warnings, ok: errors.length === 0 };
  }

  // ── Autofill values ───────────────────────────────────────────────────────
  // The ONLY place that turns a stored card into checkout-field values. Both the
  // extension's page injector and any future filler consume this, so the field
  // semantics can never drift between them.
  //
  // `opts.includeCvv` defaults to FALSE: the CVV is only ever included when the
  // caller has proven a fresh authentication (see warden-pw-core.authFresh()).
  function autofillValues(item, opts) {
    opts = opts || {};
    item = item || {};
    var b = normalizeAddress(item.billing);
    var m = padMonth(item.expMonth), y = fullYear(item.expYear);
    var num = digits(item.number);
    return {
      name: String(item.cardholder || '').trim(),
      number: num,
      numberFormatted: formatNumber(num, networkOf(item).id),
      network: networkOf(item).id,
      expMonth: m,                       // "04"
      expMonthNum: m ? String(parseInt(m, 10)) : '',  // "4"
      expYear: y,                        // "2029"
      expYearShort: shortYear(y),        // "29"
      exp: m && y ? m + '/' + shortYear(y) : '',      // "04/29"
      expFull: m && y ? m + '/' + y : '',             // "04/2029"
      cvv: opts.includeCvv ? String(item.cvv || '') : '',
      addressLine1: b.line1, addressLine2: b.line2,
      addressCombined: [b.line1, b.line2].filter(Boolean).join(' '),
      city: b.city, region: b.region, postal: b.postal, country: b.country,
      addressOneLine: formatAddress(b),
    };
  }

  // ── Sorting / searching (client-side only — the cloud sees ciphertext) ────
  // Ordering has to happen here, on decrypted items, for the same reason search
  // does: the cloud holds ciphertext and cannot sort anything.
  //
  // `order` is a per-card integer set by dragging. It is AUTHORITATIVE when
  // present. Cards that have never been reordered (a fresh warden, an import)
  // carry no `order` and fall back to the original heuristic — favourites
  // first, then expiring/expired surfaced, then by nickname — so a warden that
  // has never been dragged sorts exactly as it did before this existed.
  function hasOrder(c) { return !!c && typeof c.order === 'number' && isFinite(c.order); }

  function autoCompare(now) {
    return function (a, b) {
      if (!!b.favorite !== !!a.favorite) return b.favorite ? 1 : -1;
      var sa = expiryStatus(a.expMonth, a.expYear, now).state, sb = expiryStatus(b.expMonth, b.expYear, now).state;
      var rank = { expired: 0, expiring: 1, valid: 2, unknown: 3 };
      if (rank[sa] !== rank[sb]) return rank[sa] - rank[sb];
      return String(a.nickname || a.last4 || '').localeCompare(String(b.nickname || b.last4 || ''));
    };
  }
  function sortCards(items, now) {
    var list = (items || []).slice();
    var manual = list.filter(hasOrder).sort(function (a, b) {
      if (a.order !== b.order) return a.order - b.order;
      return String(a.nickname || a.last4 || '').localeCompare(String(b.nickname || b.last4 || ''));
    });
    var auto = list.filter(function (c) { return !hasOrder(c); }).sort(autoCompare(now));
    return manual.concat(auto);
  }

  // ── Manual ordering ───────────────────────────────────────────────────────
  // Pure array move — `list` is the currently displayed (already sorted) order.
  function moveInList(list, from, to) {
    var out = (list || []).slice();
    if (from < 0 || from >= out.length) return out;
    to = Math.max(0, Math.min(out.length - 1, to));
    out.splice(to, 0, out.splice(from, 1)[0]);
    return out;
  }
  // Given the desired id sequence, return the MINIMAL set of { id, order }
  // updates. Cards already sitting at their index are omitted, so dropping a
  // card next to where it started rewrites two rows, not the whole wallet —
  // every skipped card is one less re-encrypt and one less synced change.
  function reorderPlan(orderedIds, cards) {
    var byId = {};
    (cards || []).forEach(function (c) { if (c && c.id) byId[c.id] = c; });
    var plan = [];
    (orderedIds || []).forEach(function (id, i) {
      var c = byId[id];
      if (c && c.order !== i) plan.push({ id: id, order: i });
    });
    return plan;
  }
  // Where a newly added card should sit. Once a wallet has a manual order, new
  // cards go to the TOP (you just added it — you want to see it); an unordered
  // wallet returns undefined and keeps using the heuristic.
  function nextTopOrder(cards) {
    var orders = (cards || []).filter(hasOrder).map(function (c) { return c.order; });
    return orders.length ? Math.min.apply(null, orders) - 1 : undefined;
  }
  // Local, plaintext-free filter used by the popup (the PWA uses the richer
  // ranked store.search()). Never matches on the full number — only last 4 —
  // so a shoulder-surfer can't confirm digits by typing them.
  function filterCards(items, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return items || [];
    return (items || []).filter(function (c) {
      var net = networkOf(c);
      var hay = [c.nickname, c.cardholder, net.label, net.id, typeLabel(c), c.last4 || last4(c.number), expiryLabel(c.expMonth, c.expYear), formatAddress(c.billing), c.notes,
        Array.isArray(c.tags) ? c.tags.join(' ') : ''].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  // ── Import registry (extensible) ──────────────────────────────────────────
  // Each importer maps an EXTERNAL export into normalised payment bodies.
  // Callers hand over already-parsed data (rows for CSV, an object for JSON) —
  // this module stays free of file/DOM concerns, so the same importers run in
  // the PWA and in Node tests.
  //
  //   { id, label, format:'csv'|'json', note, detect(input), extract(input) }
  //
  // Adding a new source = appending one object here. Nothing else changes.
  function headerIndex(headers) {
    var map = {};
    (headers || []).forEach(function (h, i) { map[String(h).trim().toLowerCase().replace(/^"|"$/g, '')] = i; });
    return map;
  }
  function pick(map, row, names) {
    for (var i = 0; i < names.length; i++) {
      var j = map[names[i]];
      if (j != null && row[j] != null && String(row[j]).length) return String(row[j]);
    }
    return '';
  }
  function nonEmpty(o) {
    return !!(digits(o.number) || String(o.nickname || '').trim() || String(o.cardholder || '').trim());
  }

  var IMPORTERS = [
    {
      id: 'warden-json', label: 'Warden (plain JSON export)', format: 'json',
      note: 'A Warden payments export made from Settings → Import / Export.',
      detect: function (j) { return !!(j && j.format === 'warden-payments' && Array.isArray(j.items)); },
      extract: function (j) { return (j.items || []).map(normalize).filter(nonEmpty); },
    },
    {
      id: 'bitwarden-json', label: 'Bitwarden (.json export)', format: 'json',
      note: 'Bitwarden exports cards in its JSON format only — CSV drops them.',
      detect: function (j) { return !!(j && Array.isArray(j.items) && j.items.some(function (i) { return i && i.card; })); },
      extract: function (j) {
        return (j.items || []).filter(function (i) { return i && i.card; }).map(function (i) {
          var c = i.card || {};
          return normalize({
            nickname: i.name || '', cardholder: c.cardholderName || '', number: c.number || '',
            network: brandToNetwork(c.brand), expMonth: c.expMonth, expYear: c.expYear, cvv: c.code || '',
            notes: i.notes || '', favorite: !!i.favorite,
          });
        }).filter(nonEmpty);
      },
    },
    {
      id: 'onepassword-csv', label: '1Password (credit cards .csv)', format: 'csv',
      note: 'Export a Credit Card category from 1Password as CSV.',
      detect: function (rows) {
        var m = headerIndex(rows[0]);
        return m['number'] != null && (m['expiry date'] != null || m['expiry'] != null) && (m['cardholder name'] != null || m['cardholder'] != null);
      },
      extract: function (rows) {
        var m = headerIndex(rows[0]), out = [];
        for (var r = 1; r < rows.length; r++) {
          var row = rows[r];
          var exp = parseExpiry(pick(m, row, ['expiry date', 'expiry', 'expires']));
          out.push(normalize({
            nickname: pick(m, row, ['title', 'name']), cardholder: pick(m, row, ['cardholder name', 'cardholder']),
            number: pick(m, row, ['number', 'card number']), cvv: pick(m, row, ['cvv', 'verification number', 'security code']),
            expMonth: exp.month, expYear: exp.year, type: cardTypeFrom(pick(m, row, ['type'])),
            notes: pick(m, row, ['notes', 'note']),
          }));
        }
        return out.filter(nonEmpty);
      },
    },
    {
      id: 'chrome-csv', label: 'Chrome / Edge / Brave (payment methods .csv)', format: 'csv',
      note: 'Chromium browsers export cards as name,expiration_month,expiration_year,card_number.',
      detect: function (rows) {
        var m = headerIndex(rows[0]);
        return m['card_number'] != null || (m['expiration_month'] != null && m['expiration_year'] != null);
      },
      extract: function (rows) {
        var m = headerIndex(rows[0]), out = [];
        for (var r = 1; r < rows.length; r++) {
          var row = rows[r];
          out.push(normalize({
            cardholder: pick(m, row, ['name', 'name_on_card', 'cardholder']),
            nickname: pick(m, row, ['nickname', 'card_nickname']),
            number: pick(m, row, ['card_number', 'number']),
            expMonth: pick(m, row, ['expiration_month', 'exp_month', 'month']),
            expYear: pick(m, row, ['expiration_year', 'exp_year', 'year']),
          }));
        }
        return out.filter(nonEmpty);
      },
    },
    {
      // Deliberate last resort — matches any CSV that has *something* card-shaped.
      id: 'generic-csv', label: 'Generic CSV', format: 'csv',
      note: 'Any CSV with a recognisable card-number column.',
      detect: function (rows) {
        var m = headerIndex(rows[0]);
        return ['card number', 'cardnumber', 'number', 'card_no', 'pan'].some(function (k) { return m[k] != null; });
      },
      extract: function (rows) {
        var m = headerIndex(rows[0]), out = [];
        for (var r = 1; r < rows.length; r++) {
          var row = rows[r];
          var exp = parseExpiry(pick(m, row, ['expiry', 'expiration', 'exp', 'expiry date', 'expiration date']));
          out.push(normalize({
            nickname: pick(m, row, ['nickname', 'name', 'title', 'label']),
            cardholder: pick(m, row, ['cardholder', 'cardholder name', 'name on card', 'holder']),
            number: pick(m, row, ['card number', 'cardnumber', 'number', 'card_no', 'pan']),
            cvv: pick(m, row, ['cvv', 'cvc', 'csc', 'security code', 'code']),
            expMonth: pick(m, row, ['exp month', 'expiration_month', 'exp_month', 'month']) || exp.month,
            expYear: pick(m, row, ['exp year', 'expiration_year', 'exp_year', 'year']) || exp.year,
            type: cardTypeFrom(pick(m, row, ['type', 'card type'])),
            notes: pick(m, row, ['notes', 'note', 'memo']),
            billing: {
              line1: pick(m, row, ['address', 'address1', 'billing address', 'street']),
              line2: pick(m, row, ['address2', 'address line 2']),
              city: pick(m, row, ['city', 'town']),
              region: pick(m, row, ['state', 'region', 'province']),
              postal: pick(m, row, ['zip', 'zip code', 'postal', 'postal code', 'postcode']),
              country: pick(m, row, ['country']),
            },
          }));
        }
        return out.filter(nonEmpty);
      },
    },
  ];

  // Map an exporter's free-text brand ("Visa", "americanExpress") to our id.
  function brandToNetwork(brand) {
    var b = String(brand || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!b) return '';
    if (b.indexOf('visa') === 0) return 'visa';
    if (b.indexOf('master') === 0) return 'mastercard';
    if (b.indexOf('amer') === 0 || b === 'amex') return 'amex';
    if (b.indexOf('disc') === 0) return 'discover';
    if (b.indexOf('diner') === 0) return 'diners';
    if (b.indexOf('jcb') === 0) return 'jcb';
    if (b.indexOf('union') === 0) return 'unionpay';
    if (b.indexOf('maestro') === 0) return 'maestro';
    return '';
  }
  function cardTypeFrom(text) {
    var t = String(text || '').toLowerCase();
    if (t.indexOf('debit') >= 0) return 'debit';
    if (t.indexOf('prepaid') >= 0) return 'prepaid';
    if (t.indexOf('charge') >= 0) return 'charge';
    return 'credit';
  }

  // Pick the first importer that recognises this input. `format` disambiguates
  // rows-vs-object. Returns null when nothing matches.
  function detectImporter(input, format) {
    for (var i = 0; i < IMPORTERS.length; i++) {
      var imp = IMPORTERS[i];
      if (imp.format !== format) continue;
      try { if (imp.detect(input)) return imp; } catch (e) {}
    }
    return null;
  }
  // One-shot: detect + extract. Throws a human-readable Error when unrecognised.
  function importPayments(input, format) {
    if (format === 'csv' && (!Array.isArray(input) || input.length < 2)) throw new Error('No rows found');
    var imp = detectImporter(input, format);
    if (!imp) throw new Error('Unrecognised ' + String(format).toUpperCase() + ' — no card columns found');
    return { importer: imp, items: imp.extract(input) };
  }

  // ── Brand marks ───────────────────────────────────────────────────────────
  // Simplified, self-drawn network badges (no remote assets — the extension's
  // MV3 CSP and the PWA both forbid remote code/images here). 40×26 viewBox so
  // they sit like a real card logo.
  function brandMark(networkId) {
    var n = networkById(networkId || 'unknown');
    var w = '<svg viewBox="0 0 40 26" width="34" height="22" fill="none" xmlns="http://www.w3.org/2000/svg">';
    var box = '<rect x="0.5" y="0.5" width="39" height="25" rx="4" fill="#fff" stroke="rgba(0,0,0,.12)"/>';
    switch (n.id) {
      case 'visa':
        return w + box + '<text x="20" y="17.5" font-family="Georgia,serif" font-size="11" font-style="italic" font-weight="700" fill="#1A1F71" text-anchor="middle">VISA</text></svg>';
      case 'mastercard':
        return w + box + '<circle cx="16" cy="13" r="7.5" fill="#EB001B"/><circle cx="24" cy="13" r="7.5" fill="#F79E1B" fill-opacity="0.9"/><path d="M20 7.2a7.5 7.5 0 0 0 0 11.6 7.5 7.5 0 0 0 0-11.6z" fill="#FF5F00"/></svg>';
      case 'amex':
        return w + '<rect x="0.5" y="0.5" width="39" height="25" rx="4" fill="#1F72CD"/><text x="20" y="16.5" font-family="Arial,Helvetica,sans-serif" font-size="8" font-weight="700" fill="#fff" text-anchor="middle">AMEX</text></svg>';
      case 'discover':
        return w + box + '<path d="M40 22V15c-7 5-17 7-27 7h27z" fill="#FF6000"/><text x="18" y="13" font-family="Arial,Helvetica,sans-serif" font-size="7" font-weight="700" fill="#231F20" text-anchor="middle">DISCOVER</text></svg>';
      case 'diners':
        return w + box + '<circle cx="20" cy="13" r="8" fill="#0079BE"/><circle cx="20" cy="13" r="4.6" fill="#fff"/></svg>';
      case 'jcb':
        return w + box + '<rect x="7" y="5" width="8" height="16" rx="2" fill="#0B4EA2"/><rect x="16" y="5" width="8" height="16" rx="2" fill="#B3242C"/><rect x="25" y="5" width="8" height="16" rx="2" fill="#127C3F"/></svg>';
      case 'unionpay':
        return w + box + '<rect x="6" y="5" width="9" height="16" rx="2" fill="#E21836"/><rect x="15.5" y="5" width="9" height="16" rx="2" fill="#00447C"/><rect x="25" y="5" width="9" height="16" rx="2" fill="#007B84"/></svg>';
      case 'maestro':
        return w + box + '<circle cx="16" cy="13" r="7.5" fill="#0099DF"/><circle cx="24" cy="13" r="7.5" fill="#ED0006" fill-opacity="0.9"/><path d="M20 7.2a7.5 7.5 0 0 0 0 11.6 7.5 7.5 0 0 0 0-11.6z" fill="#6C6BBD"/></svg>';
      case 'mir':
        return w + box + '<text x="20" y="17" font-family="Arial,Helvetica,sans-serif" font-size="9" font-weight="700" fill="#0F754E" text-anchor="middle">MIR</text></svg>';
      case 'rupay':
        return w + box + '<text x="20" y="16.5" font-family="Arial,Helvetica,sans-serif" font-size="7.5" font-weight="700" fill="#097B3C" text-anchor="middle">RuPay</text></svg>';
      default:
        return w + box + '<rect x="5" y="8" width="30" height="3" rx="1.5" fill="#C9C9D4"/><rect x="5" y="15" width="14" height="3" rx="1.5" fill="#E1E1E8"/></svg>';
    }
  }

  var api = {
    KIND: KIND,
    NETWORKS: NETWORKS, METHODS: METHODS, CARD_TYPES: CARD_TYPES, IMPORTERS: IMPORTERS,
    EXPIRING_DAYS: EXPIRING_DAYS,
    // numbers
    digits: digits, luhn: luhn, detectNetwork: detectNetwork, networkById: networkById, networkOf: networkOf,
    formatNumber: formatNumber, maskNumber: maskNumber, shortMask: shortMask, last4: last4, cvvLength: cvvLength,
    // expiry
    padMonth: padMonth, fullYear: fullYear, shortYear: shortYear, expiryLabel: expiryLabel,
    parseExpiry: parseExpiry, expiryStatus: expiryStatus,
    // address
    emptyAddress: emptyAddress, normalizeAddress: normalizeAddress, hasAddress: hasAddress, formatAddress: formatAddress,
    // items
    normalize: normalize, summarize: summarize, validate: validate, typeLabel: typeLabel, methodById: methodById,
    autofillValues: autofillValues, sortCards: sortCards, filterCards: filterCards,
    // manual ordering
    hasOrder: hasOrder, moveInList: moveInList, reorderPlan: reorderPlan, nextTopOrder: nextTopOrder,
    // import
    detectImporter: detectImporter, importPayments: importPayments, brandToNetwork: brandToNetwork, cardTypeFrom: cardTypeFrom,
    // display
    brandMark: brandMark,
  };

  global.WardenPay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
