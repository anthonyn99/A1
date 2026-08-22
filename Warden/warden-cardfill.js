// ─────────────────────────────────────────────────────────────────────────────
// warden-cardfill.js — Warden extension · checkout field detection + filling
//
// Runs in the extension's ISOLATED world in every frame (see manifest
// content_scripts). Two consumers, one implementation:
//
//   • content.js   — calls classify()/hasCardFields() to decide when to offer
//                    the "Warden Payments" dropdown and where to anchor it.
//   • background.js — after the user picks a card, injects a one-line bridge
//                    that calls fill(values) HERE. The decrypted number/CVV are
//                    passed straight into that call and written to the DOM; they
//                    are never stored in a variable the page or the long-lived
//                    content script can reach afterwards.
//
// Detection order is autocomplete attribute first (the platform contract that
// Chrome/Safari autofill themselves use), then name/id/label heuristics for the
// large majority of checkouts that don't set it.
//
// NOTE: cross-origin hosted fields (Stripe Elements, Braintree, Adyen) render
// inside their own iframes. Because this script is declared with all_frames,
// it loads inside those frames too and fills them there — each frame fills its
// own inputs. Frames we are not injected into simply stay untouched.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  if (self.WardenCardFill) return;

  // ── haystacks ──────────────────────────────────────────────────────────────
  function labelText(elm) {
    try {
      var t = '';
      if (elm.labels && elm.labels.length) t += ' ' + elm.labels[0].textContent;
      if (elm.id) { var l = document.querySelector('label[for="' + CSS.escape(elm.id) + '"]'); if (l) t += ' ' + l.textContent; }
      var p = elm.closest ? elm.closest('label') : null; if (p) t += ' ' + p.textContent;
      return t;
    } catch (e) { return ''; }
  }
  // Two normalisations, because checkouts name fields both ways:
  //   flat   "cardNumber"  → "cardnumber"   (catches run-together names)
  //   spaced "billing_zip" → "billing zip"  (gives \b anchors something to bite)
  // Underscores are \w, so `\bzip\b` never matches inside "billing_zip" — which
  // is exactly why the spaced form exists.
  function haystack(elm) {
    var raw = [elm.name, elm.id, elm.getAttribute('autocomplete'), elm.placeholder,
      elm.getAttribute('aria-label'), elm.getAttribute('data-testid'), elm.className, labelText(elm)]
      .filter(Boolean).join(' ').toLowerCase();
    return { flat: raw.replace(/[^a-z0-9]/g, ''), spaced: raw.replace(/[^a-z0-9]+/g, ' ').trim() };
  }
  // The spec `autocomplete` value may carry section/billing/shipping prefixes
  // ("billing cc-number"); the field token is always the last one.
  function acToken(elm) {
    var v = String(elm.getAttribute('autocomplete') || '').trim().toLowerCase();
    if (!v || v === 'on' || v === 'off') return '';
    var parts = v.split(/\s+/);
    return parts[parts.length - 1];
  }

  var AC_MAP = {
    'cc-name': 'cc-name', 'cc-given-name': 'cc-name', 'cc-family-name': 'cc-name',
    'cc-number': 'cc-number', 'cc-exp': 'cc-exp', 'cc-exp-month': 'cc-exp-month',
    'cc-exp-year': 'cc-exp-year', 'cc-csc': 'cc-csc', 'cc-type': 'cc-type',
    'street-address': 'address-line1', 'address-line1': 'address-line1', 'address-line2': 'address-line2',
    'address-level2': 'address-city', 'address-level1': 'address-region',
    'postal-code': 'postal-code', 'country': 'country', 'country-name': 'country',
  };

  // Ordered heuristics — the FIRST match wins, so narrow patterns (security
  // code) must precede broad ones ("card ... number").
  var RULES = [
    ['cc-csc', /(cvv|cvc|csc|cvn|cid\b|securitycode|cardcode|verificationcode|verificationnumber|seccode)/],
    ['cc-exp-month', /(expmonth|expirymonth|expirationmonth|monthexpir|ccmonth|ccexpmonth|cardmonth)/],
    ['cc-exp-year', /(expyear|expiryyear|expirationyear|yearexpir|ccyear|ccexpyear|cardyear)/],
    ['cc-exp', /(expdate|expirydate|expirationdate|ccexp|cardexpir|expiration|expires|expiry)/],
    ['cc-number', /(cardnumber|cardno|cardnum|ccnumber|ccnum|creditcard|debitcard|accountnumber|pan\b)/],
    ['cc-name', /(cardholder|nameoncard|cardname|ccname|holdername|nameofcard)/],
    ['postal-code', /(zipcode|postalcode|postcode|\bzip\b|\bpostal\b)/],
    ['address-line2', /(addressline2|address2|addr2|apartment|\bapt\b|suite|unitnumber)/],
    ['address-line1', /(addressline1|address1|addr1|streetaddress|\bstreet\b|billingaddress)/],
    ['address-city', /(\bcity\b|towncity|\btown\b|locality|suburb)/],
    ['address-region', /(\bstate\b|province|\bregion\b|county)/],
    ['country', /(\bcountry\b)/],
  ];

  var TEXTUAL = { INPUT: 1, SELECT: 1 };
  var FILLABLE_INPUT_TYPES = { text: 1, tel: 1, number: 1, search: 1, password: 1, '': 1 };

  function isCandidate(elm) {
    if (!elm || !TEXTUAL[elm.tagName]) return false;
    if (elm.disabled || elm.readOnly) return false;
    if (elm.tagName === 'INPUT') {
      var t = String(elm.type || 'text').toLowerCase();
      if (!FILLABLE_INPUT_TYPES[t]) return false;
    }
    return true;
  }
  function isVisible(elm) {
    // offsetParent is null for display:none AND for position:fixed elements, so
    // fall back to a rect check before rejecting anything.
    if (elm.offsetParent !== null) return true;
    try { var r = elm.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; }
  }

  // Classify one field. Returns a token from AC_MAP's values, or '' if this is
  // not a payment/billing field.
  function classify(elm) {
    if (!isCandidate(elm)) return '';
    var ac = acToken(elm);
    if (AC_MAP[ac]) return AC_MAP[ac];
    // An explicit non-payment autocomplete token is authoritative — never
    // hijack a username/password/email field. This is what keeps the payment
    // dropdown out of the password autofill's way.
    if (ac && /^(username|current-password|new-password|email|one-time-code|tel|name|given-name|family-name|organization)$/.test(ac)) return '';
    var h = haystack(elm);
    if (String(elm.type || '').toLowerCase() === 'password') return '';
    for (var i = 0; i < RULES.length; i++) if (RULES[i][1].test(h.flat) || RULES[i][1].test(h.spaced)) return RULES[i][0];
    // A <select> whose options are exactly 1..12 next to a card number is a
    // month picker even when it is named something unhelpful.
    if (elm.tagName === 'SELECT' && looksLikeMonthSelect(elm)) return 'cc-exp-month';
    if (elm.tagName === 'SELECT' && looksLikeYearSelect(elm)) return 'cc-exp-year';
    return '';
  }
  function looksLikeMonthSelect(sel) {
    var vals = optionValues(sel);
    if (vals.length < 12 || vals.length > 14) return false;
    var nums = vals.map(function (v) { return parseInt(v, 10); }).filter(function (n) { return n >= 1 && n <= 12; });
    return nums.length >= 12;
  }
  function looksLikeYearSelect(sel) {
    var vals = optionValues(sel), y = new Date().getFullYear(), hit = 0;
    for (var i = 0; i < vals.length; i++) {
      var n = parseInt(vals[i], 10);
      if (n >= y - 1 && n <= y + 30) hit++;
      else if (n >= 0 && n <= 99 && (2000 + n) >= y - 1 && (2000 + n) <= y + 30) hit++;
    }
    return vals.length >= 5 && hit >= vals.length - 2;
  }
  function optionValues(sel) {
    return Array.prototype.slice.call(sel.options || [])
      .map(function (o) { return String(o.value || o.textContent || '').trim(); })
      .filter(function (v) { return v && !/^(--|mm|yy|month|year|select)/i.test(v); });
  }

  // Every payment/billing field in this frame, keyed by token.
  function scan(root) {
    var out = {}, all = (root || document).querySelectorAll('input, select');
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (!isVisible(e)) continue;
      var t = classify(e);
      if (!t) continue;
      (out[t] = out[t] || []).push(e);
    }
    return out;
  }
  // True when this frame is worth offering a card for. Requires an actual card
  // field — a lone postal-code or address block (a shipping form) must NOT pop
  // the payments dropdown.
  function hasCardFields(root) {
    var f = scan(root);
    return !!(f['cc-number'] || f['cc-csc'] || f['cc-exp'] || f['cc-exp-month'] || f['cc-name']);
  }
  // A field the dropdown should anchor to.
  function isCardField(elm) {
    var t = classify(elm);
    return t === 'cc-number' || t === 'cc-name' || t === 'cc-csc' || t === 'cc-exp' || t === 'cc-exp-month' || t === 'cc-exp-year';
  }

  // ── writing ────────────────────────────────────────────────────────────────
  // Bypass React/Vue's value-setter shim by calling the NATIVE prototype setter,
  // then dispatch the events frameworks listen for. Same technique the password
  // autofill already uses.
  function setVal(input, val) {
    if (!input || val == null || val === '') return false;
    try {
      var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
        : input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      input.focus({ preventScroll: true });
      if (desc && desc.set) desc.set.call(input, val); else input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }
  // Pick the <option> that means `val`, tolerating "04" vs "4" vs "April" and
  // "2029" vs "29".
  function setSelect(sel, val, kind) {
    if (!sel || !val) return false;
    var want = String(val), n = parseInt(want, 10);
    var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    var cands = [want];
    if (!isNaN(n)) {
      cands.push(String(n), n < 10 ? '0' + n : String(n));
      if (kind === 'year') { cands.push(String(n % 100), String(n).slice(-2)); if (want.length <= 2) cands.push(String(2000 + n)); }
      if (kind === 'month' && n >= 1 && n <= 12) { cands.push(MONTHS[n - 1], MONTHS[n - 1].slice(0, 3)); }
    }
    var opts = sel.options || [];
    for (var c = 0; c < cands.length; c++) {
      var want2 = cands[c].toLowerCase();
      for (var i = 0; i < opts.length; i++) {
        var ov = String(opts[i].value || '').trim().toLowerCase();
        var ot = String(opts[i].textContent || '').trim().toLowerCase();
        if (ov === want2 || ot === want2) { sel.selectedIndex = i; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
      }
    }
    return false;
  }
  function maxLen(elm) { var m = parseInt(elm.getAttribute('maxlength'), 10); return m > 0 ? m : 0; }

  // Some checkouts split the PAN across four 4-digit boxes. Detect that shape
  // and distribute the digits instead of stuffing everything into box one.
  function fillNumber(fields, number) {
    if (!number) return 0;
    var boxes = fields['cc-number'] || [];
    if (!boxes.length) return 0;
    var split = boxes.length >= 3 && boxes.every(function (b) { var m = maxLen(b); return m > 0 && m <= 6; });
    if (split) {
      var per = maxLen(boxes[0]) || 4, n = 0;
      for (var i = 0; i < boxes.length; i++) {
        var chunk = number.slice(i * per, (i + 1) * per);
        if (!chunk) break;
        if (setVal(boxes[i], chunk)) n++;
      }
      return n;
    }
    return setVal(boxes[0], number) ? 1 : 0;
  }
  // A combined MM/YY field: honour maxlength so "MMYY", "MM/YY" and "MM/YYYY"
  // all land correctly.
  function fillCombinedExp(elm, v) {
    if (!v.expMonth || !v.expYear) return false;
    var m = maxLen(elm);
    var val = m === 4 ? v.expMonth + v.expYearShort
      : m === 6 ? v.expMonth + v.expYear
      : m === 7 ? v.expMonth + '/' + v.expYear
      : v.expMonth + '/' + v.expYearShort;
    return setVal(elm, val);
  }

  function first(fields, token) { var a = fields[token]; return a && a.length ? a[0] : null; }

  var CARD_TOKENS = ['cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-name'];

  // Group detected fields by their owning <form>. A page routinely holds more
  // than one form (checkout + newsletter + a login), and filling document-wide
  // lets one form's month/year <select>s shadow another form's combined MM/YY
  // box. So we pick the ONE form that looks most like the payment form and fill
  // inside it.
  function groupByForm(root) {
    var flat = scan(root), groups = [], byKey = new Map();
    Object.keys(flat).forEach(function (token) {
      flat[token].forEach(function (e) {
        var key = e.form || null;
        var g = byKey.get(key);
        if (!g) { g = { form: key, fields: {} }; byKey.set(key, g); groups.push(g); }
        (g.fields[token] = g.fields[token] || []).push(e);
      });
    });
    return groups;
  }
  // Most distinct card tokens wins; a form with no card token at all is never
  // a candidate (that's a shipping/address form).
  function pickCardGroup(groups) {
    var best = null, bestScore = 0;
    groups.forEach(function (g) {
      var score = CARD_TOKENS.filter(function (t) { return g.fields[t]; }).length;
      if (score > bestScore) { bestScore = score; best = g; }
    });
    return best;
  }
  // Billing fields often sit OUTSIDE the card form (a separate address block).
  // Merge every group's billing fields, preferring the card form's own.
  function billingFields(groups, cardGroup) {
    var out = {};
    var order = groups.slice().sort(function (a) { return a === cardGroup ? -1 : 1; });
    ['address-line1', 'address-line2', 'address-city', 'address-region', 'postal-code', 'country'].forEach(function (t) {
      for (var i = 0; i < order.length; i++) { if (order[i].fields[t]) { out[t] = order[i].fields[t]; return; } }
    });
    return out;
  }

  // Fill this frame from the value bundle produced by WardenPay.autofillValues().
  // Returns { filled, cvv } so the caller can report honestly what happened.
  function fill(v, root) {
    v = v || {};
    var groups = groupByForm(root);
    var cardGroup = pickCardGroup(groups);
    if (!cardGroup) return { filled: 0, cvv: false };
    var fields = cardGroup.fields, billing = billingFields(groups, cardGroup);
    var n = 0, cvvFilled = false;

    n += fillNumber(fields, v.number);

    var name = first(fields, 'cc-name');
    if (name && setVal(name, v.name)) n++;

    var mo = first(fields, 'cc-exp-month');
    if (mo) { if (mo.tagName === 'SELECT' ? setSelect(mo, v.expMonth, 'month') : setVal(mo, maxLen(mo) === 1 ? v.expMonthNum : v.expMonth)) n++; }

    var yr = first(fields, 'cc-exp-year');
    if (yr) {
      var yVal = yr.tagName === 'SELECT' ? v.expYear : (maxLen(yr) === 2 ? v.expYearShort : v.expYear);
      if (yr.tagName === 'SELECT' ? setSelect(yr, v.expYear, 'year') : setVal(yr, yVal)) n++;
    }

    // Only use the combined field when there were no separate month/year inputs.
    var exp = first(fields, 'cc-exp');
    if (exp && !mo && !yr && fillCombinedExp(exp, v)) n++;

    var csc = first(fields, 'cc-csc');
    if (csc && v.cvv && setVal(csc, v.cvv)) { n++; cvvFilled = true; }

    var addr = [
      ['address-line1', v.addressLine1], ['address-line2', v.addressLine2],
      ['address-city', v.city], ['postal-code', v.postal],
    ];
    for (var i = 0; i < addr.length; i++) {
      var f = first(billing, addr[i][0]);
      if (f && addr[i][1] && setVal(f, addr[i][1])) n++;
    }
    var region = first(billing, 'address-region');
    if (region && v.region) { if (region.tagName === 'SELECT' ? setSelect(region, v.region) : setVal(region, v.region)) n++; }
    var country = first(billing, 'country');
    if (country && v.country) { if (country.tagName === 'SELECT' ? setSelect(country, v.country) : setVal(country, v.country)) n++; }

    return { filled: n, cvv: cvvFilled };
  }

  self.WardenCardFill = {
    classify: classify, scan: scan, hasCardFields: hasCardFields, isCardField: isCardField,
    fill: fill, groupByForm: groupByForm, pickCardGroup: pickCardGroup,
    _setVal: setVal, _setSelect: setSelect,
  };
})();
