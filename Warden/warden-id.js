/* ─────────────────────────────────────────────────────────────────────────────
 * warden-id.js — Warden · ID Documents core (PURE logic, no DOM, no network)
 *
 * The single source of truth for everything identity-document-shaped, in the
 * same spirit as warden-pay.js is for cards. Runs in the PWA and in Node ≥ 16.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * No encryption, no storage, no DOM, no network. An ID document is just another
 * warden-store.js item with `kind: 'iddoc'`, so it inherits the ENTIRE existing
 * security model for free:
 *
 *     { id, kind:'iddoc', enc:{iv,ct}, updatedAt, deleted }
 *
 * `kind` is the only plaintext field (routing, same as 'login'/'payment'). The
 * title, issuer, document number, dates, notes, thumbnails and every attachment
 * reference live inside `enc` — AES-256-GCM under the warden's DEK. The bytes of
 * an uploaded image/PDF are encrypted with the SAME DEK before they leave the
 * device (see warden-id-files.js); the file host only ever holds ciphertext.
 *
 * ── Extensibility ───────────────────────────────────────────────────────────
 * `TYPES` is a registry, not a hardcoded switch. Adding "Concealed Carry
 * Permit" or "Green Card" later is ONE entry here — the store, crypto, sync,
 * search, filters, editor and viewer all key off the registry, and no existing
 * document has to be migrated because the body is a flat, sparse bag of
 * OPTIONAL fields. A field a type doesn't declare is simply never shown.
 *
 * ── Item body (all fields optional; only `docType` + `title` are load-bearing)
 *     docType         one of TYPES[].id ('custom' for user-defined)
 *     title           display name
 *     issuer          issuing agency / provider / employer / school
 *     number          document number (masked in the UI, revealed on demand)
 *     group           secondary number (insurance group number)
 *     region          state / province
 *     country         country
 *     issueDate       'YYYY-MM-DD'
 *     expirationDate  'YYYY-MM-DD'
 *     description     free text (custom documents)
 *     notes           free text
 *     front, back     attachment | null   (two-sided documents)
 *     attachments     [attachment]        (PDFs and extra pages)
 *     tags, category, customFields, favorite, order, createdAt
 *
 *   attachment = { key, name, mime, size, iv, thumb, w, h, addedAt, pending }
 *     key      stable id — also the object key at the file host
 *     iv       base64 AES-GCM IV for the ciphertext blob (bytes live remotely)
 *     thumb    tiny encrypted-at-rest data URL kept INLINE so the grid renders
 *              (blurred) instantly, offline, without fetching full resolution
 *     pending  true while the ciphertext has not been accepted by the host yet
 * ──────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';
  if (global.WardenId) return;

  var KIND = 'iddoc';
  var EXPIRING_DAYS = 60;          // "Expires Soon" window
  var MAX_INLINE_THUMB = 9000;     // bytes — keeps the single warden doc small

  // ── Type registry ─────────────────────────────────────────────────────────
  // `group` drives the filter chips. `sides` is how many photographed faces the
  // document has (2 = front + back, 1 = front only, 0 = attachments only).
  // `fields` is the ORDER the editor renders in; `labels` overrides the generic
  // label for that type so a licence says "License number" and a policy says
  // "Member / policy number" without either needing its own editor.
  var TYPES = [
    {
      id: 'drivers_license', label: 'Driver License', group: 'license', sides: 2, attachments: true,
      fields: ['title', 'issuer', 'number', 'region', 'country', 'issueDate', 'expirationDate', 'notes'],
      labels: { issuer: 'Issuing agency', number: 'License number', region: 'State / Province' },
      hints: { issuer: 'e.g. Colorado DMV', number: 'e.g. 12-345-6789', region: 'e.g. Colorado' },
      subtitle: ['region', 'issuer', 'country'],
    },
    {
      id: 'passport', label: 'Passport', group: 'passport', sides: 1, attachments: true,
      fields: ['title', 'country', 'issuer', 'number', 'issueDate', 'expirationDate', 'notes'],
      labels: { issuer: 'Issuing authority', number: 'Passport number', country: 'Country of issue' },
      hints: { issuer: 'e.g. U.S. Department of State', number: 'e.g. C01X78904', country: 'e.g. United States' },
      subtitle: ['country', 'issuer'],
    },
    {
      id: 'state_id', label: 'State ID', group: 'identity', sides: 2, attachments: true,
      fields: ['title', 'issuer', 'number', 'region', 'country', 'issueDate', 'expirationDate', 'notes'],
      labels: { issuer: 'Issuing agency', number: 'ID number', region: 'State / Province' },
      hints: { issuer: 'e.g. Texas DPS', region: 'e.g. Texas' },
      subtitle: ['region', 'issuer', 'country'],
    },
    {
      id: 'ssn_card', label: 'Social Security Card', group: 'identity', sides: 1, attachments: true,
      fields: ['title', 'issuer', 'number', 'notes'],
      labels: { issuer: 'Issuing agency', number: 'Social Security number' },
      hints: { issuer: 'Social Security Administration', number: '•••-••-1234' },
      subtitle: ['issuer'],
    },
    {
      id: 'birth_certificate', label: 'Birth Certificate', group: 'identity', sides: 1, attachments: true,
      fields: ['title', 'issuer', 'number', 'region', 'country', 'issueDate', 'notes'],
      labels: { issuer: 'Issuing office', number: 'Certificate number', region: 'State / Province', issueDate: 'Date filed' },
      hints: { issuer: 'e.g. County Clerk & Recorder' },
      subtitle: ['region', 'country', 'issuer'],
    },
    {
      id: 'vehicle_registration', label: 'Vehicle Registration', group: 'registration', sides: 1, attachments: true,
      fields: ['title', 'issuer', 'number', 'region', 'issueDate', 'expirationDate', 'notes'],
      labels: { issuer: 'Issuing agency', number: 'Plate / registration number', region: 'State / Province' },
      hints: { title: 'e.g. Toyota Camry', issuer: 'e.g. Colorado DMV', number: 'e.g. ABC-1234' },
      subtitle: ['region', 'issuer'],
    },
    {
      id: 'insurance_card', label: 'Insurance Card', group: 'insurance', sides: 2, attachments: true,
      fields: ['title', 'issuer', 'number', 'group', 'region', 'expirationDate', 'notes'],
      labels: { issuer: 'Insurance provider', number: 'Member / policy number', group: 'Group number', region: 'State / Province' },
      hints: { title: 'e.g. Health Insurance', issuer: 'e.g. Blue Cross' },
      subtitle: ['issuer', 'region'],
    },
    {
      id: 'student_id', label: 'Student ID', group: 'identity', sides: 2, attachments: true,
      fields: ['title', 'issuer', 'number', 'expirationDate', 'notes'],
      labels: { issuer: 'School', number: 'Student ID number' },
      hints: { issuer: 'e.g. University of Colorado' },
      subtitle: ['issuer'],
    },
    {
      id: 'work_id', label: 'Work ID', group: 'identity', sides: 2, attachments: true,
      fields: ['title', 'issuer', 'number', 'expirationDate', 'notes'],
      labels: { issuer: 'Employer', number: 'Employee ID' },
      hints: { issuer: 'e.g. Acme Corp' },
      subtitle: ['issuer'],
    },
    {
      id: 'custom', label: 'Custom Document', group: 'custom', sides: 0, attachments: true,
      fields: ['title', 'description', 'issuer', 'number', 'issueDate', 'expirationDate', 'notes'],
      labels: { title: 'Document title', number: 'Reference number' },
      hints: { title: 'Name this document', description: 'What is this document?' },
      subtitle: ['description', 'issuer'],
      custom: true,
    },
  ];

  // Filter chips, in bar order. `all` is synthesised by the UI.
  var GROUPS = [
    { id: 'license', label: 'Driver License' },
    { id: 'passport', label: 'Passport' },
    { id: 'insurance', label: 'Insurance' },
    { id: 'registration', label: 'Registration' },
    { id: 'identity', label: 'Identity' },
    { id: 'custom', label: 'Custom' },
  ];

  var SORTS = [
    { id: 'added', label: 'Recently Added' },
    { id: 'updated', label: 'Recently Updated' },
    { id: 'alpha', label: 'Alphabetical' },
    { id: 'expiry', label: 'Expiration Date' },
    { id: 'type', label: 'Document Type' },
  ];

  // Generic labels for any field a type doesn't override.
  var FIELD_LABELS = {
    title: 'Title', issuer: 'Issuer', number: 'Document number', group: 'Group number',
    region: 'State / Province', country: 'Country', issueDate: 'Issue date',
    expirationDate: 'Expiration date', description: 'Description', notes: 'Notes',
  };
  var DATE_FIELDS = { issueDate: 1, expirationDate: 1 };
  var LONG_FIELDS = { notes: 1, description: 1 };
  // Fields that are secret enough to mask behind the eye icon.
  var SECRET_FIELDS = { number: 1 };

  function typeById(id) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i];
    return TYPES[TYPES.length - 1]; // 'custom' is the safe fallback for unknown//future ids
  }
  function typeOf(item) { return typeById(item && item.docType); }
  function typeLabel(item) { return typeOf(item).label; }
  function groupOf(item) { return typeOf(item).group; }
  function fieldLabel(type, key) { return (type.labels && type.labels[key]) || FIELD_LABELS[key] || key; }
  function fieldHint(type, key) { return (type.hints && type.hints[key]) || ''; }
  function isDateField(k) { return !!DATE_FIELDS[k]; }
  function isLongField(k) { return !!LONG_FIELDS[k]; }
  function isSecretField(k) { return !!SECRET_FIELDS[k]; }
  function sidesOf(item) { return typeOf(item).sides; }

  // ── Dates ─────────────────────────────────────────────────────────────────
  // Stored as 'YYYY-MM-DD'. Parsed at LOCAL noon so a timezone west of UTC can
  // never roll an expiry back a day and light up a false "Expired" badge.
  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
    if (!m) { var d = new Date(s); return isNaN(d.getTime()) ? null : d; }
    var dt = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
    return isNaN(dt.getTime()) ? null : dt;
  }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  // "March 18, 2030"
  function formatDate(s) {
    var d = parseDate(s); if (!d) return '';
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  // "Nov 2, 2034" — the compact form the cards use.
  function formatDateShort(s) {
    var d = parseDate(s); if (!d) return '';
    return MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  function yearOf(s) { var d = parseDate(s); return d ? String(d.getFullYear()) : ''; }
  function daysUntil(s, now) {
    var d = parseDate(s); if (!d) return null;
    var base = now == null ? Date.now() : now;
    return Math.ceil((d.getTime() - base) / 86400000);
  }

  // Expiration state → the badge on the card.
  //   'none'      no expiration on this document (birth certificate, SSN card)
  //   'expired'   the date has passed
  //   'expiring'  inside the EXPIRING_DAYS window
  //   'valid'     good for a while yet
  function expiryStatus(item, now) {
    var days = daysUntil(item && item.expirationDate, now);
    if (days == null) return { state: 'none', days: null, label: '' };
    if (days < 0) return { state: 'expired', days: days, label: 'Expired' };
    if (days <= EXPIRING_DAYS) {
      return { state: 'expiring', days: days,
        label: days === 0 ? 'Expires today' : days === 1 ? 'Expires tomorrow' : 'Expires in ' + days + ' days' };
    }
    return { state: 'valid', days: days, label: 'Valid' };
  }
  function badgeLabel(item, now) {
    var s = expiryStatus(item, now);
    return s.state === 'expired' ? 'Expired' : s.state === 'expiring' ? 'Expires Soon' : s.state === 'valid' ? 'Valid' : '';
  }

  // ── Masking ───────────────────────────────────────────────────────────────
  // Document numbers read like card numbers: the last four identify it, the
  // rest is the secret. Separators are preserved so the shape stays familiar.
  function maskNumber(v) {
    var s = String(v == null ? '' : v);
    if (!s) return '';
    var keep = 4;
    var body = s.replace(/\s+/g, ' ').trim();
    if (body.length <= keep) return repeat('•', body.length);
    var head = body.slice(0, body.length - keep), tail = body.slice(-keep);
    var masked = head.replace(/[^\s-]/g, '•');
    return masked + tail;
  }
  function repeat(c, n) { var s = ''; for (var i = 0; i < n; i++) s += c; return s; }
  function last4(v) { var s = String(v == null ? '' : v).replace(/\s/g, ''); return s.length > 4 ? s.slice(-4) : s; }

  // ── Attachments ───────────────────────────────────────────────────────────
  function isImage(a) { return !!a && /^image\//i.test(a.mime || ''); }
  function isPdf(a) { return !!a && /pdf$/i.test(a.mime || ''); }
  // Every attachment on an item, in viewer order: front, back, then extras.
  // `slot` is what a Replace/Delete has to write back to.
  function allAttachments(item) {
    var out = [];
    if (item && item.front) out.push({ slot: 'front', label: 'Front', att: item.front });
    if (item && item.back) out.push({ slot: 'back', label: 'Back', att: item.back });
    (item && Array.isArray(item.attachments) ? item.attachments : []).forEach(function (a, i) {
      if (a) out.push({ slot: 'attachments', index: i, label: a.name || 'Attachment ' + (i + 1), att: a });
    });
    return out;
  }
  function attachmentCount(item) { return allAttachments(item).length; }
  // The image the card shows as its (blurred) preview.
  function coverAttachment(item) {
    var list = allAttachments(item);
    for (var i = 0; i < list.length; i++) if (isImage(list[i].att) && list[i].att.thumb) return list[i].att;
    for (var j = 0; j < list.length; j++) if (isImage(list[j].att)) return list[j].att;
    return null;
  }
  // True while any attachment's ciphertext is still waiting on the file host.
  function hasPendingUpload(item) {
    return allAttachments(item).some(function (e) { return !!e.att.pending; });
  }

  // ── Normalisation ─────────────────────────────────────────────────────────
  // Every write funnels through here so a body can never carry a stray field or
  // a half-typed date. Unknown-but-declared future fields survive untouched
  // (see EXTRA_KEYS) — that's what makes the schema additive.
  var BODY_KEYS = ['docType', 'title', 'issuer', 'number', 'group', 'region', 'country',
    'issueDate', 'expirationDate', 'description', 'notes'];
  function str(v) { return v == null ? '' : String(v).trim(); }
  function normalizeDate(v) {
    var s = str(v); if (!s) return '';
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
    var d = parseDate(s);
    return d ? d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) : '';
  }
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  function normalize(item) {
    item = item || {};
    var type = typeOf(item);
    var out = { kind: KIND, docType: type.id };
    BODY_KEYS.forEach(function (k) {
      if (k === 'docType') return;
      out[k] = isDateField(k) ? normalizeDate(item[k]) : str(item[k]);
    });
    if (!out.title) out.title = type.custom ? 'Untitled Document' : type.label;
    out.front = normalizeAttachment(item.front);
    out.back = type.sides >= 2 ? normalizeAttachment(item.back) : null;
    out.attachments = (Array.isArray(item.attachments) ? item.attachments : [])
      .map(normalizeAttachment).filter(Boolean);
    out.tags = Array.isArray(item.tags) ? item.tags.map(str).filter(Boolean)
      : str(item.tags) ? str(item.tags).split(',').map(str).filter(Boolean) : [];
    out.category = str(item.category) || 'Identity';
    out.customFields = (Array.isArray(item.customFields) ? item.customFields : [])
      .map(function (c) { return { label: str(c && c.label), value: str(c && c.value) }; })
      .filter(function (c) { return c.label || c.value; });
    out.favorite = !!item.favorite;
    if (hasOrder(item)) out.order = item.order;
    if (item.createdAt) out.createdAt = item.createdAt;
    return out;
  }
  function normalizeAttachment(a) {
    if (!a || !a.key) return null;
    var o = {
      key: String(a.key), name: str(a.name) || 'document',
      mime: str(a.mime) || 'application/octet-stream',
      size: +a.size || 0, iv: str(a.iv),
      addedAt: +a.addedAt || Date.now(),
    };
    if (a.thumb && String(a.thumb).length <= MAX_INLINE_THUMB) o.thumb = String(a.thumb);
    if (a.w) o.w = +a.w; if (a.h) o.h = +a.h;
    if (a.pending) o.pending = true;
    return o;
  }

  // What a card needs, computed once instead of re-derived in three places.
  function summarize(item, now) {
    var type = typeOf(item);
    var exp = expiryStatus(item, now);
    var parts = (type.subtitle || []).map(function (k) { return str(item && item[k]); }).filter(Boolean);
    return {
      id: item && item.id,
      type: type, typeLabel: type.label, group: type.group,
      title: str(item && item.title) || type.label,
      subtitle: parts.length ? parts[0] : '',
      subtitleFull: parts.join(' · '),
      number: str(item && item.number),
      masked: maskNumber(item && item.number),
      last4: last4(item && item.number),
      expiration: str(item && item.expirationDate),
      expirationLabel: formatDate(item && item.expirationDate),
      expirationShort: formatDateShort(item && item.expirationDate),
      issue: str(item && item.issueDate),
      issueLabel: formatDate(item && item.issueDate),
      expiryState: exp.state, expiryDays: exp.days, expiryLabel: exp.label,
      badge: badgeLabel(item, now),
      favorite: !!(item && item.favorite),
      attachments: attachmentCount(item),
      cover: coverAttachment(item),
      pending: hasPendingUpload(item),
    };
  }

  function validate(item) {
    var errors = [], warnings = [];
    var type = typeOf(item);
    if (!str(item && item.title)) errors.push('Give the document a title.');
    ['issueDate', 'expirationDate'].forEach(function (k) {
      var raw = str(item && item[k]);
      if (raw && !normalizeDate(raw)) errors.push(fieldLabel(type, k) + ' is not a valid date.');
    });
    var iss = parseDate(item && item.issueDate), exp = parseDate(item && item.expirationDate);
    if (iss && exp && exp < iss) errors.push('Expiration date is before the issue date.');
    var st = expiryStatus(item);
    if (st.state === 'expired') warnings.push('This document has already expired.');
    else if (st.state === 'expiring') warnings.push(st.label + '.');
    return { ok: !errors.length, errors: errors, warnings: warnings };
  }

  // ── Sorting / filtering ───────────────────────────────────────────────────
  function hasOrder(i) { return !!i && typeof i.order === 'number' && isFinite(i.order); }
  function nextTopOrder(items) {
    var orders = (items || []).filter(hasOrder).map(function (i) { return i.order; });
    return orders.length ? Math.min.apply(null, orders) - 1 : undefined;
  }
  function cmpTitle(a, b) {
    return String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
  }
  function ts(i, k) { return +(i && i[k]) || 0; }

  // Pinned documents always float, then the chosen sort decides the rest, so
  // switching sort mode never buries something the user deliberately pinned.
  function sortDocs(items, mode) {
    var list = (items || []).slice();
    var cmp;
    if (mode === 'alpha') cmp = cmpTitle;
    else if (mode === 'updated') cmp = function (a, b) { return (ts(b, 'modifiedAt') || ts(b, 'updatedAt')) - (ts(a, 'modifiedAt') || ts(a, 'updatedAt')) || cmpTitle(a, b); };
    else if (mode === 'type') cmp = function (a, b) { return typeLabel(a).localeCompare(typeLabel(b)) || cmpTitle(a, b); };
    else if (mode === 'expiry') {
      // Soonest first; documents with no expiration sort to the end rather than
      // pretending to be infinitely far away in the middle of the list.
      cmp = function (a, b) {
        var da = parseDate(a.expirationDate), db = parseDate(b.expirationDate);
        if (da && db) return da - db || cmpTitle(a, b);
        if (da) return -1;
        if (db) return 1;
        return cmpTitle(a, b);
      };
    } else cmp = function (a, b) { return (ts(b, 'createdAt') || ts(b, 'updatedAt')) - (ts(a, 'createdAt') || ts(a, 'updatedAt')) || cmpTitle(a, b); };
    return list.sort(function (a, b) {
      if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
      return cmp(a, b);
    });
  }
  function filterDocs(items, group) {
    if (!group || group === 'all') return (items || []).slice();
    return (items || []).filter(function (i) { return groupOf(i) === group; });
  }
  // Which filter chips are worth showing — a chip that matches nothing is noise.
  function groupCounts(items) {
    var out = {};
    GROUPS.forEach(function (g) { out[g.id] = 0; });
    (items || []).forEach(function (i) { var g = groupOf(i); if (out[g] != null) out[g]++; });
    return out;
  }

  // ── autofill ──────────────────────────────────────────────────────────────
  // Types whose NUMBER is sensitive enough to need a fresh credential check
  // before it is released to a web page — the same bar the extension already
  // applies to a card's security code. A licence number on a rental form is
  // routine; a Social Security number never is.
  var SENSITIVE_TYPES = { ssn_card: 1 };
  function isSensitive(item) { return !!SENSITIVE_TYPES[typeOf(item).id]; }

  // The value bundle a form filler writes from. Pure and flat, so the DOM-side
  // code (warden-idfill.js) contains no knowledge of the document model — same
  // split WardenPay.autofillValues() uses for cards.
  //
  // `opts.includeNumber` defaults to true; the caller sets it false when the
  // document is sensitive and auth isn't fresh. Dates are pre-split because
  // forms ask for them every possible way.
  function autofillValues(item, opts) {
    opts = opts || {};
    item = item || {};
    var type = typeOf(item);
    var includeNumber = opts.includeNumber !== false;
    var out = {
      docType: type.id,
      typeLabel: type.label,
      title: str(item.title),
      issuer: str(item.issuer),
      region: str(item.region),
      country: str(item.country),
      group: str(item.group),
      number: includeNumber ? str(item.number) : '',
      numberDigits: includeNumber ? str(item.number).replace(/\D/g, '') : '',
    };
    addDateParts(out, 'exp', item.expirationDate);
    addDateParts(out, 'issue', item.issueDate);
    return out;
  }
  function addDateParts(out, prefix, raw) {
    var iso = normalizeDate(raw);
    out[prefix] = iso;                                   // 'YYYY-MM-DD' for <input type=date>
    if (!iso) { out[prefix + 'Us'] = ''; out[prefix + 'Month'] = ''; out[prefix + 'Day'] = ''; out[prefix + 'Year'] = ''; out[prefix + 'YearShort'] = ''; return; }
    var p = iso.split('-');
    out[prefix + 'Year'] = p[0];
    out[prefix + 'YearShort'] = p[0].slice(2);
    out[prefix + 'Month'] = p[1];
    out[prefix + 'Day'] = p[2];
    out[prefix + 'Us'] = p[1] + '/' + p[2] + '/' + p[0];  // MM/DD/YYYY
  }

  // Documents worth surfacing as "needs attention", newest deadline first.
  function expiringSoon(items, now) {
    return (items || []).filter(function (i) {
      var s = expiryStatus(i, now).state;
      return s === 'expired' || s === 'expiring';
    }).sort(function (a, b) { return (parseDate(a.expirationDate) || 0) - (parseDate(b.expirationDate) || 0); });
  }

  var api = {
    KIND: KIND, TYPES: TYPES, GROUPS: GROUPS, SORTS: SORTS,
    EXPIRING_DAYS: EXPIRING_DAYS, MAX_INLINE_THUMB: MAX_INLINE_THUMB,
    FIELD_LABELS: FIELD_LABELS,
    // registry
    typeById: typeById, typeOf: typeOf, typeLabel: typeLabel, groupOf: groupOf, sidesOf: sidesOf,
    fieldLabel: fieldLabel, fieldHint: fieldHint,
    isDateField: isDateField, isLongField: isLongField, isSecretField: isSecretField,
    // dates + expiry
    parseDate: parseDate, formatDate: formatDate, formatDateShort: formatDateShort,
    yearOf: yearOf, daysUntil: daysUntil, expiryStatus: expiryStatus, badgeLabel: badgeLabel,
    normalizeDate: normalizeDate,
    // privacy
    maskNumber: maskNumber, last4: last4,
    // attachments
    isImage: isImage, isPdf: isPdf, allAttachments: allAttachments,
    attachmentCount: attachmentCount, coverAttachment: coverAttachment, hasPendingUpload: hasPendingUpload,
    // items
    normalize: normalize, normalizeAttachment: normalizeAttachment, summarize: summarize, validate: validate,
    // ordering / filtering
    hasOrder: hasOrder, nextTopOrder: nextTopOrder, sortDocs: sortDocs, filterDocs: filterDocs,
    groupCounts: groupCounts, expiringSoon: expiringSoon,
    // autofill
    SENSITIVE_TYPES: SENSITIVE_TYPES, isSensitive: isSensitive, autofillValues: autofillValues,
  };

  global.WardenId = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
