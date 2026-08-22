// ─────────────────────────────────────────────────────────────────────────────
// warden-idfill.js — Warden extension · identity-document field detection + filling
//
// The ID Docs twin of warden-cardfill.js. Runs in the extension's ISOLATED world
// in every frame (see manifest content_scripts). Two consumers, one
// implementation:
//
//   • content.js    — calls classify()/hasIdFields()/isIdField() to decide when
//                     to offer the "Warden ID Docs" dropdown and where to anchor.
//   • background.js — after the user picks a document, hands the decrypted value
//                     bundle to fill() HERE, or the decrypted FILE BYTES to
//                     attachFile() for an upload field.
//
// ── Two kinds of "filling" ──────────────────────────────────────────────────
//   TEXT   A rental-car form wants a licence number, state and expiry; a visa
//          form wants a passport number and country. fill() writes those.
//   FILE   A form wants a PHOTO of the document ("upload your ID"). attachFile()
//          puts the decrypted scan straight into the <input type="file">, which
//          is the whole point of carrying your documents in a browser at all.
//
// ── Not stepping on Payments (or on Passwords) ──────────────────────────────
// A checkout's State / ZIP / Country belong to the CARD, not to a licence — but
// a car-rental form's "State of issue" belongs to the licence, and both look
// identical to a name-based matcher. So the deference is conditional:
//   • a `cc-*` field is ALWAYS Payments', never touched here;
//   • an address field is Payments' when the page declares it as one via
//     autocomplete, or when the field's OWN <form> actually contains card
//     fields (form-scoped, so a booking form beside a checkout still works);
//   • otherwise it is ours to fill.
// On top of that, the "weak" contextual tokens (state, country, issuer, dates)
// are only claimed at all when a STRONG identity token — a licence / passport /
// SSN / policy number — sits in the same form. A shipping address on its own
// never triggers this section.
//
// ── What crosses into the page ──────────────────────────────────────────────
// Text values arrive already filtered by the background: a sensitive document's
// number (an SSN) is withheld unless a real credential was presented recently,
// exactly as a card's CVV is. File bytes necessarily do land in this isolated
// world — there is no other way to construct a File for an upload field — but
// they are written into the input and dropped immediately, never retained.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  if (self.WardenIdFill) return;

  // ── haystacks (same two normalisations warden-cardfill.js uses) ─────────────
  //   flat   "licenseNumber" → "licensenumber"
  //   spaced "license_number" → "license number"  (gives \b anchors something)
  function labelText(elm) {
    try {
      var t = '';
      if (elm.labels && elm.labels.length) t += ' ' + elm.labels[0].textContent;
      if (elm.id) { var l = document.querySelector('label[for="' + CSS.escape(elm.id) + '"]'); if (l) t += ' ' + l.textContent; }
      var p = elm.closest ? elm.closest('label') : null; if (p) t += ' ' + p.textContent;
      return t;
    } catch (e) { return ''; }
  }
  function haystack(elm) {
    var raw = [elm.name, elm.id, elm.getAttribute('autocomplete'), elm.placeholder,
      elm.getAttribute('aria-label'), elm.getAttribute('data-testid'), elm.className, labelText(elm)]
      .filter(Boolean).join(' ').toLowerCase();
    return { flat: raw.replace(/[^a-z0-9]/g, ''), spaced: raw.replace(/[^a-z0-9]+/g, ' ').trim() };
  }
  function acToken(elm) {
    var v = String(elm.getAttribute('autocomplete') || '').trim().toLowerCase();
    if (!v || v === 'on' || v === 'off') return '';
    var parts = v.split(/\s+/);
    return parts[parts.length - 1];
  }

  // STRONG tokens identify the form as an identity form on their own.
  // Order matters: narrower patterns first (SSN before generic "number").
  var STRONG_RULES = [
    ['id-ssn', /(socialsecurity|\bssn\b|ssnumber|socsec|\btin\b|taxpayerid)/],
    ['id-group', /(groupnumber|groupid|grpnumber|\bgroup\s?no\b|policygroup)/],
    ['id-member', /(memberid|membernumber|memberno|subscriberid|policynumber|policyno|insuranceid|insurancenumber|healthid)/],
    ['id-plate', /(licenseplate|licenceplate|platenumber|\bplate\b|registrationnumber|regnumber|vehicleregistration|\bvin\b)/],
    ['id-passport', /(passportnumber|passportno|\bpassport\b)/],
    ['id-license', /(driverslicense|driverlicense|driverslicence|driverlicence|licensenumber|licencenumber|\bdlnumber\b|\bdl\s?no\b|\bdln\b|driverid)/],
    ['id-number', /(documentnumber|documentid|identificationnumber|identitynumber|idnumber|\bid\s?no\b|governmentid|nationalid|stateid|studentid|employeeid|badgenumber)/],
  ];
  // WEAK tokens only fill when a strong one shares the form. On their own they
  // are just an address or a random date.
  var WEAK_RULES = [
    ['id-exp', /(expirationdate|expirydate|expdate|dateofexpiry|expires|expiration|validuntil|validthru|goodthrough)/],
    ['id-issue', /(issuedate|dateofissue|issuedon|dateissued)/],
    ['id-state', /(issuingstate|stateofissue|licensestate|licencestate|idstate|dlstate)/],
    ['id-country', /(issuingcountry|countryofissue|passportcountry|nationality|countryofcitizenship)/],
    ['id-issuer', /(issuingagency|issuingauthority|issuedby|issuer|insuranceprovider|insurancecompany|carriername)/],
  ];
  // Generic state/country, claimed ONLY in a form that already has a strong
  // identity token and no card field — that's the licence's state, not a
  // billing address.
  var CONTEXT_RULES = [
    ['id-state', /(\bstate\b|province|\bregion\b)/],
    ['id-country', /(\bcountry\b)/],
  ];

  var TEXTUAL = { INPUT: 1, SELECT: 1 };
  var FILLABLE_INPUT_TYPES = { text: 1, tel: 1, number: 1, search: 1, date: 1, month: 1, '': 1 };

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
    if (elm.offsetParent !== null) return true;
    try { var r = elm.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; }
  }
  // Payments own the checkout — but only where that is actually true.
  //
  // A `cc-*` token is always theirs, no question. The address tokens are the
  // subtle case: warden-cardfill.js classifies a bare "State" box as
  // `address-region` for BILLING, so deferring to that unconditionally would
  // mean a car-rental form's "State of issue" could never be filled from a
  // licence. It only belongs to Payments when the field's own form really is a
  // checkout (a card field is present there) or when the page has explicitly
  // declared it as an address field via autocomplete. Otherwise it is ours.
  var ADDRESS_AC = /^(street-address|address-line[12]|address-level[12]|postal-code|country|country-name)$/;
  function claimedByCard(elm) {
    try {
      if (!self.WardenCardFill) return false;
      var t = self.WardenCardFill.classify(elm);
      if (!t) return false;
      if (t.slice(0, 3) === 'cc-') return true;
      if (ADDRESS_AC.test(acToken(elm))) return true;
      return ownerHasCardFields(elm);
    } catch (e) { return false; }
  }
  // Scoped to the field's OWN <form>, not the whole frame. A page routinely
  // carries a checkout alongside something else — a rental booking with a
  // "State of issue" next to a payment form is the exact case — and a
  // frame-wide check would hand that State to Payments and leave the licence
  // half-filled. warden-cardfill.js groups by form for the same reason.
  //
  // Memoised because hasCardFields() walks its whole root and classify() runs
  // once per field. The TTL matters: a single-page checkout can swap a details
  // form for a payment form with no navigation, and a permanently cached
  // "no cards here" would then be wrong for the rest of the session.
  var CARD_CACHE_MS = 500;
  var _cardCache = null, _cardCacheAt = 0;          // frame-level (no owning form)
  var _formCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function ownerHasCardFields(elm) {
    var form = elm && elm.form;
    var now = Date.now();
    if (!form) {
      if (_cardCache !== null && (now - _cardCacheAt) < CARD_CACHE_MS) return _cardCache;
      _cardCache = probe(null); _cardCacheAt = now;
      return _cardCache;
    }
    if (_formCache) {
      var hit = _formCache.get(form);
      if (hit && (now - hit.at) < CARD_CACHE_MS) return hit.v;
      var v = probe(form);
      _formCache.set(form, { v: v, at: now });
      return v;
    }
    return probe(form);
  }
  function probe(root) {
    try { return !!(self.WardenCardFill && self.WardenCardFill.hasCardFields(root || undefined)); }
    catch (e) { return false; }
  }
  function resetCardCache() {
    _cardCache = null; _cardCacheAt = 0;
    if (typeof WeakMap === 'function') _formCache = new WeakMap();
  }

  // Classify one field. `opts.context` allows the generic state/country rules,
  // which the scan pass turns on only once a strong token has been seen.
  function classify(elm, opts) {
    if (!isCandidate(elm)) return '';
    if (claimedByCard(elm)) return '';
    var ac = acToken(elm);
    // An explicit non-identity autocomplete token is authoritative.
    if (ac && /^(username|current-password|new-password|email|one-time-code|cc-|tel-)/.test(ac)) return '';
    var h = haystack(elm);
    var i;
    for (i = 0; i < STRONG_RULES.length; i++) if (STRONG_RULES[i][1].test(h.flat) || STRONG_RULES[i][1].test(h.spaced)) return STRONG_RULES[i][0];
    for (i = 0; i < WEAK_RULES.length; i++) if (WEAK_RULES[i][1].test(h.flat) || WEAK_RULES[i][1].test(h.spaced)) return WEAK_RULES[i][0];
    if (opts && opts.context) {
      for (i = 0; i < CONTEXT_RULES.length; i++) if (CONTEXT_RULES[i][1].test(h.flat) || CONTEXT_RULES[i][1].test(h.spaced)) return CONTEXT_RULES[i][0];
    }
    return '';
  }
  var STRONG = { 'id-ssn': 1, 'id-group': 1, 'id-member': 1, 'id-plate': 1, 'id-passport': 1, 'id-license': 1, 'id-number': 1 };
  function isStrong(token) { return !!STRONG[token]; }

  // ── file inputs ───────────────────────────────────────────────────────────
  // "Upload a photo of your ID" is the other half of filling a form with a
  // document. We only offer on inputs that would actually take an image or PDF.
  function isIdFileField(elm) {
    if (!elm || elm.tagName !== 'INPUT') return false;
    if (String(elm.type || '').toLowerCase() !== 'file') return false;
    if (elm.disabled) return false;
    var accept = String(elm.getAttribute('accept') || '').toLowerCase();
    // No accept attribute → the page takes anything, so we can offer.
    if (!accept) return true;
    return /image|pdf|\.jpe?g|\.png|\.heic|\.webp|\*/.test(accept);
  }
  function fileAccepts(elm, mime, name) {
    var accept = String((elm && elm.getAttribute('accept')) || '').toLowerCase().trim();
    if (!accept) return true;
    var parts = accept.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    mime = String(mime || '').toLowerCase();
    var ext = '.' + String(name || '').toLowerCase().split('.').pop();
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '*' || p === '*/*') return true;
      if (p.charAt(0) === '.') { if (p === ext) return true; continue; }
      if (p.indexOf('/*') > 0) { if (mime.split('/')[0] === p.split('/')[0]) return true; continue; }
      if (p === mime) return true;
    }
    return false;
  }
  // Put a decrypted scan into a page's upload field. DataTransfer is the only
  // way to set input.files programmatically, and it is why this has to run in a
  // content script rather than the service worker.
  function attachFile(input, file) {
    if (!input || !file) return false;
    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.files && input.files.length === 1;
    } catch (e) { return false; }
  }
  // Build a File from bytes handed over by the background (base64 on the wire —
  // structured clone of a big typed array through chrome.runtime is far worse).
  function fileFromBase64(b64, name, mime) {
    var bin = atob(String(b64 || ''));
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name || 'document', { type: mime || 'application/octet-stream' });
  }

  // ── scanning ──────────────────────────────────────────────────────────────
  // Two passes: find the strong tokens first, then re-scan with the generic
  // state/country rules enabled only if we found one.
  function scan(root) {
    resetCardCache();   // the DOM may have changed since the last scan
    var all = (root || document).querySelectorAll('input, select');
    var out = {}, strongSeen = false, i, e, t;
    for (i = 0; i < all.length; i++) {
      e = all[i];
      if (!isVisible(e)) continue;
      t = classify(e);
      if (!t) continue;
      if (isStrong(t)) strongSeen = true;
      (out[t] = out[t] || []).push(e);
    }
    if (strongSeen) {
      for (i = 0; i < all.length; i++) {
        e = all[i];
        if (!isVisible(e)) continue;
        if (classify(e)) continue;                        // already classified
        t = classify(e, { context: true });
        if (t) (out[t] = out[t] || []).push(e);
      }
    }
    return out;
  }
  // Worth offering the ID Docs dropdown in this frame?
  function hasIdFields(root) {
    var f = scan(root);
    for (var k in f) if (isStrong(k)) return true;
    return false;
  }
  // A field the dropdown should anchor to: strong text fields, plus any upload
  // field that would take a scan.
  function isIdField(elm) {
    if (isIdFileField(elm)) return true;
    return isStrong(classify(elm));
  }

  // ── writing ───────────────────────────────────────────────────────────────
  // Same native-setter technique the card filler uses, so React/Vue controlled
  // inputs actually register the change.
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
  // Match an <option> by value OR visible text, tolerating "CO" vs "Colorado"
  // and "US" vs "United States".
  function setSelect(sel, val) {
    if (!sel || !val) return false;
    var want = String(val).trim().toLowerCase();
    var opts = sel.options || [], i;
    for (i = 0; i < opts.length; i++) {
      var ov = String(opts[i].value || '').trim().toLowerCase();
      var ot = String(opts[i].textContent || '').trim().toLowerCase();
      if (ov === want || ot === want) { return commit(sel, i); }
    }
    // Prefix match: "Colorado" picks the option labelled "Colorado (CO)".
    for (i = 0; i < opts.length; i++) {
      var t2 = String(opts[i].textContent || '').trim().toLowerCase();
      if (t2 && (t2.indexOf(want) === 0 || want.indexOf(t2) === 0)) return commit(sel, i);
    }
    return false;
  }
  function commit(sel, i) {
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  // A date field wants one of three shapes. <input type=date> is strict about
  // 'YYYY-MM-DD'; a text box on a US form wants MM/DD/YYYY.
  function setDate(elm, v, prefix) {
    if (!elm) return false;
    var type = String(elm.type || '').toLowerCase();
    if (type === 'date') return setVal(elm, v[prefix]);
    if (type === 'month') return setVal(elm, v[prefix + 'Year'] && v[prefix + 'Month'] ? v[prefix + 'Year'] + '-' + v[prefix + 'Month'] : '');
    var m = parseInt(elm.getAttribute('maxlength'), 10);
    if (m === 8) return setVal(elm, v[prefix + 'Month'] + v[prefix + 'Day'] + v[prefix + 'Year']);
    return setVal(elm, v[prefix + 'Us']);
  }

  function first(fields, token) { var a = fields[token]; return a && a.length ? a[0] : null; }

  // Which of the document-number tokens this document should answer to. A
  // passport fills a "passport number" box; an insurance card fills "member id"
  // and "group number". Everything falls back to the generic id-number.
  var NUMBER_TOKENS_BY_TYPE = {
    passport: ['id-passport', 'id-number'],
    drivers_license: ['id-license', 'id-number'],
    state_id: ['id-number', 'id-license'],
    ssn_card: ['id-ssn', 'id-number'],
    insurance_card: ['id-member', 'id-number'],
    vehicle_registration: ['id-plate', 'id-number'],
    student_id: ['id-number'],
    work_id: ['id-number'],
    birth_certificate: ['id-number'],
    custom: ['id-number'],
  };

  // Fill this frame from the bundle produced by WardenId.autofillValues().
  // Returns { filled, number } so the caller can report honestly — `number`
  // false means the document number was withheld or had nowhere to go.
  function fill(v, root) {
    v = v || {};
    var fields = scan(root);
    var n = 0, numberFilled = false;

    // ── the number ──
    var order = NUMBER_TOKENS_BY_TYPE[v.docType] || ['id-number'];
    // Any strong slot is a valid home for it if the type-specific ones are
    // absent — a page that only says "ID number" still deserves the licence.
    var candidates = order.concat(['id-number', 'id-license', 'id-passport', 'id-member', 'id-plate', 'id-ssn']);
    if (v.number) {
      for (var i = 0; i < candidates.length; i++) {
        var f = first(fields, candidates[i]);
        if (f && setVal(f, v.number)) { n++; numberFilled = true; break; }
      }
    }
    // Insurance group number is its own field, never the member id.
    var grp = first(fields, 'id-group');
    if (grp && v.group && setVal(grp, v.group)) n++;

    // ── the context ──
    var st = first(fields, 'id-state');
    if (st && v.region) { if (st.tagName === 'SELECT' ? setSelect(st, v.region) : setVal(st, v.region)) n++; }
    var ct = first(fields, 'id-country');
    if (ct && v.country) { if (ct.tagName === 'SELECT' ? setSelect(ct, v.country) : setVal(ct, v.country)) n++; }
    var iss = first(fields, 'id-issuer');
    if (iss && v.issuer) { if (iss.tagName === 'SELECT' ? setSelect(iss, v.issuer) : setVal(iss, v.issuer)) n++; }

    var exp = first(fields, 'id-exp');
    if (exp && v.exp && setDate(exp, v, 'exp')) n++;
    var isd = first(fields, 'id-issue');
    if (isd && v.issue && setDate(isd, v, 'issue')) n++;

    return { filled: n, number: numberFilled };
  }

  self.WardenIdFill = {
    classify: classify, scan: scan, hasIdFields: hasIdFields, isIdField: isIdField,
    isStrong: isStrong, isIdFileField: isIdFileField, fileAccepts: fileAccepts,
    attachFile: attachFile, fileFromBase64: fileFromBase64,
    fill: fill,
    _setVal: setVal, _setSelect: setSelect, _setDate: setDate,
    NUMBER_TOKENS_BY_TYPE: NUMBER_TOKENS_BY_TYPE,
  };
})();
