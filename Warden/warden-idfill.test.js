// Real verification of warden-idfill.js — the identity-document field detector
// and filler that the extension runs inside every page.
//
// It is DOM code, so this file stands up a minimal DOM shim rather than pulling
// in jsdom (the repo has no node_modules and stays that way). The shim covers
// exactly what the module touches: querySelectorAll, getAttribute, labels,
// options, native value setters, and event dispatch.
//
//   node warden-idfill.test.js
const VID = require('./warden-id.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

// ── the smallest DOM that can host the module ────────────────────────────────
class Ev { constructor(t) { this.type = t; } }
class Elm {
  constructor(tag, attrs) {
    this.tagName = tag.toUpperCase();
    this._attrs = Object.assign({}, attrs || {});
    // NOT an own property: real elements expose `value` on their prototype, and
    // the module deliberately writes through the native prototype setter. An own
    // property here would shadow that and make every fill look like a no-op.
    this._v = this._attrs.value || '';
    this.type = this._attrs.type || (tag === 'input' ? 'text' : '');
    this.name = this._attrs.name || '';
    this.id = this._attrs.id || '';
    this.placeholder = this._attrs.placeholder || '';
    this.className = this._attrs.class || '';
    this.disabled = !!this._attrs.disabled;
    this.readOnly = !!this._attrs.readOnly;
    this.labels = this._attrs.label ? [{ textContent: this._attrs.label }] : [];
    this.options = (this._attrs.options || []).map((o) =>
      typeof o === 'string' ? { value: o, textContent: o } : o);
    this.selectedIndex = -1;
    this.offsetParent = {};              // "visible"
    this.events = [];
    this.files = null;
  }
  getAttribute(k) {
    if (k === 'autocomplete') return this._attrs.autocomplete || null;
    if (k === 'maxlength') return this._attrs.maxlength != null ? String(this._attrs.maxlength) : null;
    if (k === 'accept') return this._attrs.accept != null ? this._attrs.accept : null;
    return this._attrs[k] != null ? String(this._attrs[k]) : null;
  }
  closest() { return null; }
  focus() {}
  getBoundingClientRect() { return { width: 100, height: 20 }; }
  dispatchEvent(e) { this.events.push(e.type); return true; }
}
Object.defineProperty(Elm.prototype, 'value', {
  configurable: true,
  get() { return this._v; },
  set(v) { this._v = v; },
});
class Doc {
  constructor(elms) { this.elms = elms; }
  querySelectorAll(sel) {
    const wantFile = /input\[type="file"\]/.test(sel);
    return this.elms.filter((e) => {
      if (wantFile) return e.tagName === 'INPUT' && String(e.type).toLowerCase() === 'file';
      if (/input, ?select/.test(sel)) return e.tagName === 'INPUT' || e.tagName === 'SELECT';
      return false;
    });
  }
  querySelector() { return null; }
}
function install(elms) {
  global.document = new Doc(elms);
  return global.document;
}
// Native prototype value setters, which the module deliberately reaches for.
global.HTMLInputElement = function () {};
global.HTMLSelectElement = function () {};
global.HTMLTextAreaElement = function () {};
[global.HTMLInputElement, global.HTMLSelectElement, global.HTMLTextAreaElement].forEach((C) => {
  Object.defineProperty(C.prototype, 'value', {
    configurable: true,
    get() { return this._v; },
    set(v) { this._v = v; },
  });
});
global.Event = Ev;
global.CSS = { escape: (s) => s };
global.self = global;
install([]);

require('./warden-idfill.js');
const IF = global.WardenIdFill;

const inp = (attrs) => new Elm('input', attrs);
const sel = (attrs) => new Elm('select', attrs);

(async () => {
  console.log('\n── strong field detection ──');
  ok('driver licence number', IF.classify(inp({ name: 'driversLicenseNumber' })) === 'id-license');
  ok('DL number abbreviation', IF.classify(inp({ name: 'dl_number' })) === 'id-license');
  ok('passport number', IF.classify(inp({ id: 'passportNumber' })) === 'id-passport');
  ok('passport by label', IF.classify(inp({ name: 'pp', label: 'Passport' })) === 'id-passport');
  ok('SSN', IF.classify(inp({ name: 'ssn' })) === 'id-ssn');
  ok('social security spelled out', IF.classify(inp({ name: 'social_security_number' })) === 'id-ssn');
  ok('insurance member id', IF.classify(inp({ name: 'memberId' })) === 'id-member');
  ok('policy number', IF.classify(inp({ name: 'policy_number' })) === 'id-member');
  ok('insurance group number', IF.classify(inp({ name: 'groupNumber' })) === 'id-group');
  ok('licence plate', IF.classify(inp({ name: 'licensePlate' })) === 'id-plate');
  ok('generic government id', IF.classify(inp({ name: 'governmentId' })) === 'id-number');
  ok('student id', IF.classify(inp({ name: 'studentId' })) === 'id-number');
  ok('all of the above are STRONG', ['id-license', 'id-passport', 'id-ssn', 'id-member', 'id-group', 'id-plate', 'id-number'].every(IF.isStrong));

  console.log('\n── weak / contextual fields ──');
  ok('expiration date', IF.classify(inp({ name: 'expirationDate' })) === 'id-exp');
  ok('issue date', IF.classify(inp({ name: 'dateOfIssue' })) === 'id-issue');
  ok('issuing state', IF.classify(inp({ name: 'issuingState' })) === 'id-state');
  ok('issuing country', IF.classify(inp({ name: 'countryOfIssue' })) === 'id-country');
  ok('issuing agency', IF.classify(inp({ name: 'issuingAgency' })) === 'id-issuer');
  ok('weak tokens are not strong', !IF.isStrong('id-exp') && !IF.isStrong('id-state'));
  // A bare "state" is an address until an identity field says otherwise.
  ok('bare "state" is NOT claimed without context', IF.classify(inp({ name: 'state' })) === '');
  ok('bare "state" IS claimed with context enabled', IF.classify(inp({ name: 'state' }), { context: true }) === 'id-state');

  console.log('\n── never fights Payments or Passwords ──');
  // Stand up the real card filler and confirm it wins every field it claims.
  require('./warden-cardfill.js');
  ok('card number is left to Payments', IF.classify(inp({ name: 'cardNumber' })) === '');
  ok('CVV is left to Payments', IF.classify(inp({ name: 'cvv' })) === '');
  ok('billing ZIP is left to Payments', IF.classify(inp({ name: 'billing_zip' })) === '');
  ok('checkout State is left to Payments even with context on',
    IF.classify(inp({ name: 'state', autocomplete: 'address-level1' }), { context: true }) === '');
  ok('password field is never claimed', IF.classify(inp({ type: 'password', name: 'password' })) === '');
  ok('username field is never claimed', IF.classify(inp({ name: 'username', autocomplete: 'username' })) === '');
  ok('email field is never claimed', IF.classify(inp({ type: 'email', name: 'email' })) === '');

  console.log('\n── scanning a form ──');
  const rental = [
    inp({ name: 'driversLicenseNumber' }),
    inp({ name: 'state' }),                       // generic — needs the context pass
    inp({ name: 'expirationDate', type: 'date' }),
    inp({ name: 'email', type: 'email' }),
  ];
  install(rental);
  const scanned = IF.scan();
  ok('finds the strong field', !!scanned['id-license']);
  ok('the context pass picks up the bare State', !!scanned['id-state']);
  ok('finds the expiry', !!scanned['id-exp']);
  ok('ignores the email', !scanned['id-email']);
  ok('hasIdFields is true for this form', IF.hasIdFields());

  install([inp({ name: 'street' }), inp({ name: 'city' }), inp({ name: 'state' })]);
  ok('a plain address form does NOT trigger ID Docs', IF.hasIdFields() === false);
  ok('…and its State stays unclaimed', Object.keys(IF.scan()).length === 0);

  console.log('\n── filling ──');
  const doc = {
    docType: 'drivers_license', title: 'Driver License', issuer: 'Colorado DMV',
    number: '12-345-6789', region: 'Colorado', country: 'United States',
    issueDate: '2024-03-18', expirationDate: '2030-03-18',
  };
  const v = VID.autofillValues(doc);
  ok('autofillValues splits the expiry every way forms ask for it',
    v.exp === '2030-03-18' && v.expUs === '03/18/2030' && v.expMonth === '03' &&
    v.expDay === '18' && v.expYear === '2030' && v.expYearShort === '30');
  ok('…and the issue date too', v.issue === '2024-03-18' && v.issueUs === '03/18/2024');
  ok('no date → empty strings, never "undefined"',
    (() => { const b = VID.autofillValues({ docType: 'ssn_card', number: '1' }); return b.exp === '' && b.expUs === '' && b.expYear === ''; })());

  const f = {
    lic: inp({ name: 'driversLicenseNumber' }),
    state: sel({ name: 'issuingState', options: ['', 'California', 'Colorado', 'Texas'] }),
    country: inp({ name: 'countryOfIssue' }),
    exp: inp({ name: 'expirationDate', type: 'date' }),
    issue: inp({ name: 'issueDate' }),                 // plain text → US format
  };
  install(Object.values(f));
  const r = IF.fill(v);
  ok('fills 5 fields', r.filled === 5);
  ok('the licence number lands in the licence box', f.lic.value === '12-345-6789');
  ok('reports that the number was filled', r.number === true);
  ok('a <select> state matches by option text', f.state.selectedIndex === 2);
  ok('country fills', f.country.value === 'United States');
  ok('type=date gets ISO', f.exp.value === '2030-03-18');
  ok('a text date gets MM/DD/YYYY', f.issue.value === '03/18/2024');
  ok('React/Vue see the change (input+change+blur dispatched)',
    f.lic.events.includes('input') && f.lic.events.includes('change') && f.lic.events.includes('blur'));

  console.log('\n── the right number goes in the right box ──');
  const passport = VID.autofillValues({ docType: 'passport', number: 'C01X78904', country: 'United States' });
  const both = { pp: inp({ name: 'passportNumber' }), dl: inp({ name: 'driversLicenseNumber' }) };
  install(Object.values(both));
  IF.fill(passport);
  ok('a passport fills the passport box, not the licence box',
    both.pp.value === 'C01X78904' && both.dl.value === '');

  const lic2 = VID.autofillValues(doc);
  const both2 = { pp: inp({ name: 'passportNumber' }), dl: inp({ name: 'driversLicenseNumber' }) };
  install(Object.values(both2));
  IF.fill(lic2);
  ok('a licence fills the licence box, not the passport box',
    both2.dl.value === '12-345-6789' && both2.pp.value === '');

  const ins = VID.autofillValues({ docType: 'insurance_card', number: 'M99887766', group: 'GRP-4410' });
  const insF = { mem: inp({ name: 'memberId' }), grp: inp({ name: 'groupNumber' }) };
  install(Object.values(insF));
  IF.fill(ins);
  ok('insurance splits member id and group number',
    insF.mem.value === 'M99887766' && insF.grp.value === 'GRP-4410');

  // A form that only offers a generic "ID number" still gets the licence.
  const generic = { g: inp({ name: 'identificationNumber' }) };
  install(Object.values(generic));
  ok('falls back to a generic ID field', IF.fill(VID.autofillValues(doc)).filled === 1 && generic.g.value === '12-345-6789');

  console.log('\n── withholding a sensitive number ──');
  ok('SSN card is flagged sensitive', VID.isSensitive({ docType: 'ssn_card' }) === true);
  ok('a driver licence is not', VID.isSensitive({ docType: 'drivers_license' }) === false);
  const withheld = VID.autofillValues({ docType: 'ssn_card', number: '123-45-6789' }, { includeNumber: false });
  ok('the number is stripped from the bundle', withheld.number === '' && withheld.numberDigits === '');
  const ssnF = { s: inp({ name: 'ssn' }) };
  install(Object.values(ssnF));
  const rw = IF.fill(withheld);
  ok('so nothing is written and the caller is told', rw.filled === 0 && rw.number === false && ssnF.s.value === '');
  const allowed = VID.autofillValues({ docType: 'ssn_card', number: '123-45-6789' });
  install(Object.values(ssnF));
  ok('with fresh auth it does fill', IF.fill(allowed).number === true);

  console.log('\n── file-upload fields ──');
  ok('an image-only upload is offered', IF.isIdFileField(inp({ type: 'file', accept: 'image/*' })));
  ok('a PDF upload is offered', IF.isIdFileField(inp({ type: 'file', accept: '.pdf,application/pdf' })));
  ok('an unrestricted upload is offered', IF.isIdFileField(inp({ type: 'file' })));
  ok('a CSV-only upload is NOT offered', IF.isIdFileField(inp({ type: 'file', accept: '.csv,text/csv' })) === false);
  ok('a text input is not a file field', IF.isIdFileField(inp({ name: 'x' })) === false);
  ok('accept matching: image/* takes a png', IF.fileAccepts(inp({ type: 'file', accept: 'image/*' }), 'image/png', 'a.png'));
  ok('accept matching: image/* rejects a pdf', IF.fileAccepts(inp({ type: 'file', accept: 'image/*' }), 'application/pdf', 'a.pdf') === false);
  ok('accept matching: .jpg extension list', IF.fileAccepts(inp({ type: 'file', accept: '.jpg,.png' }), 'image/png', 'scan.png'));
  ok('accept matching: exact mime', IF.fileAccepts(inp({ type: 'file', accept: 'application/pdf' }), 'application/pdf', 'a.pdf'));
  ok('accept matching: no accept takes anything', IF.fileAccepts(inp({ type: 'file' }), 'image/heic', 'a.heic'));
  ok('a file field is an anchor for the dropdown', IF.isIdField(inp({ type: 'file', accept: 'image/*' })));

  console.log('\n── base64 → File → input.files ──');
  // The exact path the background→content-script handoff takes.
  global.File = class File {
    constructor(parts, name, opts) {
      this.name = name; this.type = (opts && opts.type) || '';
      this.size = parts.reduce((n, p) => n + (p.length || p.byteLength || 0), 0);
      this._parts = parts;
    }
  };
  global.DataTransfer = class DataTransfer {
    constructor() { this.items = { _f: [], add: (f) => this.items._f.push(f) }; }
    get files() { return this.items._f; }
  };
  global.atob = (b) => Buffer.from(b, 'base64').toString('binary');
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  const b64 = Buffer.from(bytes).toString('base64');
  const file = IF.fileFromBase64(b64, 'license-front.png', 'image/png');
  ok('rebuilds the file with its real name and type',
    file.name === 'license-front.png' && file.type === 'image/png' && file.size === bytes.length);
  const target = inp({ type: 'file', accept: 'image/*' });
  ok('attaches into input.files', IF.attachFile(target, file) === true);
  ok('the page is notified', target.events.includes('input') && target.events.includes('change'));
  ok('attachFile refuses nothing-to-attach', IF.attachFile(target, null) === false);

  console.log('\n' + (fail ? '✗ ' + fail + ' failed, ' + pass + ' passed' : '✓ all ' + pass + ' passed') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
