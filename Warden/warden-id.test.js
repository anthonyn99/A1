// Real verification of warden-id.js (pure logic) PLUS an end-to-end check that
// ID-document items ride the EXISTING warden-crypto/warden-store pipeline with
// every sensitive field encrypted at rest, and that attachment BYTES round-trip
// through the session's DEK without the plaintext ever being persisted.
//
//   node warden-id.test.js
const VID = require('./warden-id.js');
const VC = require('./warden-crypto.js');
const WardenStore = require('./warden-store.js');
const WardenSession = require('./warden-session.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

// A fixed "now" so expiry tests can't go stale a year from today.
const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime();
const DAY = 86400000;
const iso = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

(async () => {
  console.log('\n── type registry ──');
  ok('every type has a unique id', new Set(VID.TYPES.map((t) => t.id)).size === VID.TYPES.length);
  ok('all ten requested types exist', ['drivers_license', 'passport', 'state_id', 'ssn_card',
    'birth_certificate', 'vehicle_registration', 'insurance_card', 'student_id', 'work_id', 'custom']
    .every((id) => VID.TYPES.some((t) => t.id === id)));
  ok('every type declares fields', VID.TYPES.every((t) => Array.isArray(t.fields) && t.fields.length));
  ok('every type maps to a known filter group',
    VID.TYPES.every((t) => VID.GROUPS.some((g) => g.id === t.group)));
  ok('unknown / future type falls back to custom', VID.typeById('green_card_2030').id === 'custom');
  ok('two-sided documents are the ID-shaped ones',
    VID.typeById('drivers_license').sides === 2 && VID.typeById('insurance_card').sides === 2 &&
    VID.typeById('work_id').sides === 2 && VID.typeById('birth_certificate').sides === 1);
  ok('licence relabels "number" per type', VID.fieldLabel(VID.typeById('drivers_license'), 'number') === 'License number');
  ok('passport relabels "number" per type', VID.fieldLabel(VID.typeById('passport'), 'number') === 'Passport number');
  ok('unlabelled field falls back to the generic label',
    VID.fieldLabel(VID.typeById('passport'), 'notes') === 'Notes');
  ok('custom type is user-titled', VID.typeById('custom').custom === true);

  console.log('\n── dates ──');
  ok('formats long', VID.formatDate('2030-03-18') === 'March 18, 2030');
  ok('formats short', VID.formatDateShort('2034-11-02') === 'Nov 2, 2034');
  ok('blank date formats to empty', VID.formatDate('') === '' && VID.formatDate(null) === '');
  ok('garbage date formats to empty', VID.formatDate('not-a-date') === '');
  ok('year extraction', VID.yearOf('2030-03-18') === '2030');
  ok('normalises loose input', VID.normalizeDate('2030-3-8') === '2030-03-08');
  ok('normalises already-canonical input', VID.normalizeDate('2030-03-08') === '2030-03-08');
  // Parsed at local noon: a UTC-based parse would render this as the 17th in
  // any timezone west of Greenwich.
  ok('no timezone drift on the boundary', VID.parseDate('2030-03-18').getDate() === 18);

  console.log('\n── expiration tracking ──');
  const expired = { expirationDate: iso(NOW - 5 * DAY) };
  const soon = { expirationDate: iso(NOW + 10 * DAY) };
  const valid = { expirationDate: iso(NOW + 400 * DAY) };
  const none = { docType: 'ssn_card' };
  ok('expired', VID.expiryStatus(expired, NOW).state === 'expired');
  ok('expiring inside the window', VID.expiryStatus(soon, NOW).state === 'expiring');
  ok('valid outside the window', VID.expiryStatus(valid, NOW).state === 'valid');
  ok('no expiration → none', VID.expiryStatus(none, NOW).state === 'none');
  ok('edge: exactly at the window boundary still counts as expiring',
    VID.expiryStatus({ expirationDate: iso(NOW + VID.EXPIRING_DAYS * DAY) }, NOW).state === 'expiring');
  ok('edge: one day past the window is valid',
    VID.expiryStatus({ expirationDate: iso(NOW + (VID.EXPIRING_DAYS + 2) * DAY) }, NOW).state === 'valid');
  ok('badge wording', VID.badgeLabel(expired, NOW) === 'Expired' &&
    VID.badgeLabel(soon, NOW) === 'Expires Soon' && VID.badgeLabel(valid, NOW) === 'Valid' &&
    VID.badgeLabel(none, NOW) === '');
  ok('expiringSoon collects expired + expiring, soonest first', (() => {
    const l = VID.expiringSoon([valid, soon, expired], NOW);
    return l.length === 2 && l[0] === expired && l[1] === soon;
  })());

  console.log('\n── privacy / masking ──');
  ok('masks all but the last four', VID.maskNumber('123456784321') === '••••••••4321');
  ok('keeps separators legible', VID.maskNumber('12-345-6789') === '••-•••-6789');
  ok('short numbers mask completely', VID.maskNumber('321') === '•••');
  ok('empty stays empty', VID.maskNumber('') === '' && VID.maskNumber(null) === '');
  ok('last4', VID.last4('C01X78904') === '8904' && VID.last4('12') === '12');

  console.log('\n── normalisation ──');
  const raw = {
    docType: 'drivers_license', title: '  Driver License  ', issuer: 'Colorado DMV',
    number: '12-345-6789', region: 'Colorado', expirationDate: '2030-3-18',
    tags: ' travel , , family ', notes: 'glovebox',
    customFields: [{ label: '', value: '' }, { label: 'Class', value: 'C' }],
    stray: 'should not survive',
  };
  const n = VID.normalize(raw);
  ok('trims strings', n.title === 'Driver License');
  ok('normalises dates on write', n.expirationDate === '2030-03-18');
  ok('splits + cleans tags', JSON.stringify(n.tags) === JSON.stringify(['travel', 'family']));
  ok('drops empty custom fields', n.customFields.length === 1 && n.customFields[0].label === 'Class');
  ok('drops unknown keys', n.stray === undefined);
  ok('stamps the kind', n.kind === 'iddoc');
  ok('defaults the category', n.category === 'Identity');
  ok('titles an untitled document after its type', VID.normalize({ docType: 'passport' }).title === 'Passport');
  ok('a custom document with no title gets a placeholder', VID.normalize({ docType: 'custom' }).title === 'Untitled Document');
  ok('one-sided types cannot carry a back image',
    VID.normalize({ docType: 'passport', back: { key: 'k', iv: 'i' } }).back === null);
  ok('two-sided types can', VID.normalize({ docType: 'drivers_license', back: { key: 'k', iv: 'i' } }).back.key === 'k');
  ok('an attachment with no key is dropped', VID.normalizeAttachment({ name: 'x' }) === null);
  ok('an oversized thumbnail is dropped rather than bloating the warden doc',
    VID.normalizeAttachment({ key: 'k', thumb: 'd'.repeat(VID.MAX_INLINE_THUMB + 1) }).thumb === undefined);
  ok('a small thumbnail is kept', VID.normalizeAttachment({ key: 'k', thumb: 'data:image/jpeg;base64,AAAA' }).thumb.length > 0);

  console.log('\n── validation ──');
  ok('a titled document is valid', VID.validate({ docType: 'passport', title: 'US Passport' }).ok);
  ok('an untitled one is not', !VID.validate({ docType: 'passport', title: '' }).ok);
  ok('expiry before issue is rejected',
    !VID.validate({ title: 'x', issueDate: '2030-01-01', expirationDate: '2020-01-01' }).ok);
  ok('a bad date is rejected', !VID.validate({ title: 'x', expirationDate: 'soon' }).ok);
  ok('an expired document warns but still saves', (() => {
    const v = VID.validate({ title: 'x', expirationDate: '2001-01-01' });
    return v.ok && v.warnings.length > 0;
  })());

  console.log('\n── summarise ──');
  const dl = { id: 'a', docType: 'drivers_license', title: 'Driver License', region: 'Colorado', issuer: 'Colorado DMV', number: '12-345-6789', expirationDate: '2030-03-18' };
  const s = VID.summarize(dl, NOW);
  ok('title', s.title === 'Driver License');
  ok('subtitle prefers the type\'s first declared field', s.subtitle === 'Colorado');
  ok('full subtitle chains them', s.subtitleFull === 'Colorado · Colorado DMV');
  ok('expiry rendered for the card', s.expirationShort === 'Mar 18, 2030');
  ok('number never leaves summarize unmasked by accident', s.masked === '••-•••-6789');

  console.log('\n── sorting & filtering ──');
  const docs = [
    { id: '1', docType: 'passport', title: 'Alpha Passport', createdAt: 100, modifiedAt: 500, expirationDate: '2034-11-02' },
    { id: '2', docType: 'drivers_license', title: 'Adam License', createdAt: 300, modifiedAt: 100, expirationDate: '2030-03-18' },
    { id: '3', docType: 'insurance_card', title: 'Blue Cross', createdAt: 200, modifiedAt: 900 },
    { id: '4', docType: 'custom', title: 'Zebra Papers', createdAt: 400, modifiedAt: 200, favorite: true },
  ];
  const ids = (l) => l.map((d) => d.id).join('');
  ok('pinned always leads', VID.sortDocs(docs, 'alpha')[0].id === '4');
  ok('alphabetical', ids(VID.sortDocs(docs.filter((d) => !d.favorite), 'alpha')) === '213');
  ok('recently added', ids(VID.sortDocs(docs.filter((d) => !d.favorite), 'added')) === '231');
  ok('recently updated', ids(VID.sortDocs(docs.filter((d) => !d.favorite), 'updated')) === '312');
  ok('expiration: soonest first, undated last',
    ids(VID.sortDocs(docs.filter((d) => !d.favorite), 'expiry')) === '213');
  ok('by document type', ids(VID.sortDocs(docs.filter((d) => !d.favorite), 'type')) === '231');
  ok('sortDocs does not mutate its input', (() => {
    const before = ids(docs); VID.sortDocs(docs, 'alpha'); return ids(docs) === before;
  })());
  ok('filter by group', ids(VID.filterDocs(docs, 'license')) === '2');
  ok('filter "all" returns everything', VID.filterDocs(docs, 'all').length === 4);
  ok('group counts', (() => {
    const c = VID.groupCounts(docs);
    return c.license === 1 && c.passport === 1 && c.insurance === 1 && c.custom === 1 && c.registration === 0;
  })());
  ok('every filter chip in the spec exists',
    ['license', 'passport', 'insurance', 'registration', 'identity', 'custom']
      .every((g) => VID.GROUPS.some((x) => x.id === g)));
  ok('every sort mode in the spec exists',
    ['added', 'updated', 'alpha', 'expiry', 'type'].every((m) => VID.SORTS.some((x) => x.id === m)));

  console.log('\n── attachments ──');
  const att = (k, mime) => ({ key: k, iv: 'iv', mime: mime || 'image/jpeg', name: k, size: 10 });
  const withFiles = {
    docType: 'drivers_license',
    front: Object.assign(att('f'), { thumb: 'data:image/jpeg;base64,AAA' }),
    back: att('b'),
    attachments: [att('p1', 'application/pdf')],
  };
  ok('viewer order is front, back, extras',
    VID.allAttachments(withFiles).map((e) => e.att.key).join('') === 'fbp1');
  ok('slots are addressable for replace/delete', (() => {
    const l = VID.allAttachments(withFiles);
    return l[0].slot === 'front' && l[2].slot === 'attachments' && l[2].index === 0;
  })());
  ok('count', VID.attachmentCount(withFiles) === 3);
  ok('cover prefers an image that has a thumbnail', VID.coverAttachment(withFiles).key === 'f');
  ok('a PDF-only document has no cover image',
    VID.coverAttachment({ attachments: [att('p', 'application/pdf')] }) === null);
  ok('image/pdf detection', VID.isImage(att('x')) && VID.isPdf(att('y', 'application/pdf')));
  ok('pending upload is detected', VID.hasPendingUpload({ front: Object.assign(att('f'), { pending: true }) }));
  ok('a fully-uploaded document is not pending', !VID.hasPendingUpload(withFiles));

  console.log('\n── autofill bundle ──');
  const av = VID.autofillValues({
    docType: 'drivers_license', title: ' Driver License ', issuer: 'Colorado DMV',
    number: '12-345-6789', region: 'Colorado', country: 'United States',
    issueDate: '2024-3-8', expirationDate: '2030-03-18',
  });
  ok('carries the type so the filler knows which box to aim at', av.docType === 'drivers_license');
  ok('trims as it goes', av.title === 'Driver License');
  ok('normalises a loose date on the way out', av.issue === '2024-03-08' && av.issueUs === '03/08/2024');
  ok('splits the expiry every way a form can ask',
    av.exp === '2030-03-18' && av.expUs === '03/18/2030' && av.expMonth === '03' &&
    av.expDay === '18' && av.expYear === '2030' && av.expYearShort === '30');
  ok('offers a digits-only number for strict inputs', av.numberDigits === '123456789');
  ok('a missing date yields empty strings, never undefined', (() => {
    const b = VID.autofillValues({ docType: 'ssn_card', number: '1' });
    return b.exp === '' && b.expUs === '' && b.expYear === '' && b.expYearShort === '';
  })());
  ok('includeNumber:false strips the number AND its digits', (() => {
    const b = VID.autofillValues({ docType: 'ssn_card', number: '123-45-6789' }, { includeNumber: false });
    return b.number === '' && b.numberDigits === '';
  })());
  ok('only the SSN card is sensitive', VID.isSensitive({ docType: 'ssn_card' }) &&
    !VID.isSensitive({ docType: 'drivers_license' }) && !VID.isSensitive({ docType: 'passport' }) &&
    !VID.isSensitive({ docType: 'insurance_card' }));
  ok('an unknown future type is not silently treated as sensitive',
    VID.isSensitive({ docType: 'green_card_2030' }) === false);

  console.log('\n── manual ordering ──');
  ok('hasOrder', VID.hasOrder({ order: 0 }) && !VID.hasOrder({}) && !VID.hasOrder({ order: NaN }));
  ok('nextTopOrder goes above the current minimum', VID.nextTopOrder([{ order: 2 }, { order: 5 }]) === 1);
  ok('nextTopOrder is undefined on an unordered list', VID.nextTopOrder([{}, {}]) === undefined);

  // ── end-to-end: the real crypto + store pipeline ────────────────────────────
  console.log('\n── encrypted at rest (real warden-crypto + warden-store) ──');
  const backend = WardenStore.memoryBackend();
  const { config, dek } = await VC.createWarden('correct horse battery staple');
  await backend.saveConfig(config);
  const store = new WardenStore(backend, dek);
  await store.load();

  const saved = await store.save(VID.normalize({
    docType: 'passport', title: 'US Passport', issuer: 'U.S. Department of State',
    number: 'C01X78904', country: 'United States', expirationDate: '2034-11-02',
    notes: 'in the safe',
  }));
  const rawDoc = backend._raw.get(saved.id);
  const wire = JSON.stringify(rawDoc);
  ok('only id/kind/enc/updatedAt/deleted are plaintext',
    Object.keys(rawDoc).sort().join(',') === 'deleted,enc,id,kind,updatedAt');
  ok('kind routes in the clear (by design)', rawDoc.kind === 'iddoc');
  ok('the document number is NOT on the wire', wire.indexOf('C01X78904') === -1);
  ok('the issuer is NOT on the wire', wire.indexOf('Department of State') === -1);
  ok('the title is NOT on the wire', wire.indexOf('US Passport') === -1);
  ok('the expiration date is NOT on the wire', wire.indexOf('2034-11-02') === -1);
  ok('the notes are NOT on the wire', wire.indexOf('in the safe') === -1);
  ok('it decrypts back intact', store.get(saved.id).number === 'C01X78904');
  ok('byKind routes it to the ID Docs tab', store.byKind('iddoc').length === 1);

  console.log('\n── search ──');
  await store.save(VID.normalize({
    docType: 'drivers_license', title: 'Driver License', issuer: 'Colorado DMV',
    number: '12-345-6789', region: 'Colorado', expirationDate: '2030-03-18',
  }));
  await store.save(VID.normalize({
    docType: 'insurance_card', title: 'Health Insurance', issuer: 'Blue Cross', number: 'M99887766',
  }));
  const found = (q) => store.search(q).filter((i) => i.kind === 'iddoc').map((i) => i.title);
  ok('by title', found('passport')[0] === 'US Passport');
  ok('by issuer', found('blue cross')[0] === 'Health Insurance');
  ok('by state', found('colorado')[0] === 'Driver License');
  ok('by country', found('united states')[0] === 'US Passport');
  ok('by document type wording', found('licence').length >= 1 || found('license').length >= 1);
  ok('by expiration year', found('2030')[0] === 'Driver License');
  ok('by notes', found('safe')[0] === 'US Passport');
  ok('by partial document number (3+ chars)', found('78904')[0] === 'US Passport');
  // "877" appears ONLY inside the insurance member number, nowhere else in that
  // item — so these two assertions isolate the number field exactly.
  ok('a 3-char fragment does reach the number field', found('877')[0] === 'Health Insurance');
  // …and two characters must not be enough to walk a number digit by digit.
  ok('a 2-char number fragment does not confirm a number', found('77').length === 0);

  console.log('\n── attachment bytes round-trip through the session DEK ──');
  const session = new WardenSession({ backend, deviceStore: WardenSession.memoryDeviceStore(), autoLockMs: 0 });
  await session.unlockWithPassword('correct horse battery staple');
  const plain = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 250, 251, 252]);
  const sealed = await session.encryptBytes(plain);
  ok('ciphertext differs from plaintext',
    Buffer.compare(Buffer.from(sealed.bytes), Buffer.from(plain)) !== 0);
  ok('GCM tag makes the ciphertext longer', sealed.bytes.length === plain.length + 16);
  ok('an IV comes back for storage', typeof sealed.iv === 'string' && sealed.iv.length > 0);
  const back = await session.decryptBytes(sealed.iv, sealed.bytes);
  ok('round-trips byte for byte', Buffer.compare(Buffer.from(back), Buffer.from(plain)) === 0);
  ok('a tampered blob is rejected, not silently corrupted', await (async () => {
    const bad = sealed.bytes.slice(); bad[2] ^= 0xff;
    try { await session.decryptBytes(sealed.iv, bad); return false; } catch (e) { return true; }
  })());
  ok('two encryptions of the same bytes differ (fresh IV each time)', await (async () => {
    const a = await session.encryptBytes(plain), b = await session.encryptBytes(plain);
    return a.iv !== b.iv && Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)) !== 0;
  })());
  session.lock();
  ok('a locked session refuses to encrypt bytes', await (async () => {
    try { await session.encryptBytes(plain); return false; } catch (e) { return e.message === 'locked'; }
  })());
  ok('a locked session refuses to decrypt bytes', await (async () => {
    try { await session.decryptBytes(sealed.iv, sealed.bytes); return false; } catch (e) { return e.message === 'locked'; }
  })());

  console.log('\n' + (fail ? '✗ ' + fail + ' failed, ' + pass + ' passed' : '✓ all ' + pass + ' passed') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
