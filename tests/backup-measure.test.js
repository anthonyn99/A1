#!/usr/bin/env node
/**
 * A1Backup Phase 0 — measurement correctness.
 *
 * WHY THIS FILE EXISTS
 * The first live run reported `images ... 17 docs, ~0.0 MB (avg 0.0 KB from 0
 * sampled)` and then concluded "blobs in git? YES — 0.0 MB is under the
 * threshold". Both halves were wrong, in the same way:
 *
 *   1. Image document ids were built as imgPrefix + placeholderKey. But the
 *      placeholder ALREADY contains the full document id — index.html writes
 *      imgKey = '<prefix>' + entry.id + '_' + hash and stores the placeholder
 *      as '<scheme>' + imgKey, then reads it back with
 *      doc(db, 'dashboards', imgKey), nothing added. Re-prefixing produced
 *      journal_img_journal_img_… so every sample read missed.
 *   2. A run that sampled nothing then reported zero bytes, and a zero sailed
 *      through the threshold check as though it were evidence.
 *
 * A silent zero standing in for "no evidence" is the exact failure mode this
 * whole backup project exists to remove, so it gets a regression test.
 *
 * The static checks below assert the shape of the fix; the behavioural section
 * at the bottom runs the SHIPPED measure() against a fake Firestore, which is
 * the only part that would have caught the original bug — the ids were derived
 * correctly and then re-prefixed by the caller.
 *
 * Run: node tests/backup-measure.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  ✗ ' + name); }
}
function section(s) { console.log('\n' + s); }

const SRC = fs.readFileSync(path.join(__dirname, '..', 'backup.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Load the SHIPPED file in a sandbox and use its own functions. Lifting them
// out by brace matching (as the older suites do) is unreliable here: imageKeys
// contains a regex literal full of brackets that defeats a naive matcher.
const sandbox = {
  window: {}, console: console,
  Blob: global.Blob, Response: global.Response,
  CompressionStream: global.CompressionStream,
  Date, Math, JSON, Object, Error, RegExp, Promise
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'backup.js' });
const A1 = sandbox.window.A1Backup;
const { JOURNALS, entryIds, imageKeys } = A1._internals;

// A fake Firestore holding exactly the documents we say exist, so measure()
// runs unmodified and the id-derivation path is exercised for real.
function fakeStore(docs) {
  const reads = [];
  return {
    reads,
    db: {},
    fs: {
      doc: (_db, p) => ({ path: p }),
      getDoc: async (ref) => {
        reads.push(ref.path);
        const key = ref.path.split('/').slice(1).join('/');
        const has = Object.prototype.hasOwnProperty.call(docs, key);
        return { exists: () => has, data: () => docs[key] };
      }
    }
  };
}

// ───────────────────────── the shipped writer's format ─────────────────────
section("The placeholder format matches what index.html actually writes");

const writers = [
  { prefix: 'journal_img_',      scheme: 'bj-fbimg://' },
  { prefix: 'myjournal_img_',    scheme: 'mj-fbimg://' },
  { prefix: 'tony_journal_img_', scheme: 'tj-fbimg://' }
];
writers.forEach((w) => {
  t("index.html builds imgKey starting '" + w.prefix + "'",
    new RegExp("imgKey\\s*=\\s*'" + w.prefix + "'").test(HTML));
  t("index.html stores the placeholder as '" + w.scheme + "' + imgKey",
    HTML.includes("'" + w.scheme + "' + imgKey"));
});
t('the rehydrator reads the placeholder value as the document id, unprefixed',
  (HTML.match(/const imgRef = doc\(db, 'dashboards', imgKey\);/g) || []).length >= 2,
  'If this ever gains a prefix, backup.js must change with it.');

// ───────────────────────── derivation from a journal doc ───────────────────
section('Image ids are derived correctly from a realistic journal document');

const entryId = 'e17abc9';
const journalDoc = {
  savedAt: 1756713600000,
  activeId: entryId,
  _order: [entryId, 'plain'],
  ['e_' + entryId]: {
    id: entryId, title: 'Notes', template: 'page',
    data: { html:
      '<p>before</p>' +
      '<img src="bj-fbimg://journal_img_' + entryId + '_k3f9a2">' +
      '<p>mid</p>' +
      '<img src="bj-fbimg://journal_img_' + entryId + '_zz01qq">' +
      '<img src="bj-fbimg://journal_img_' + entryId + '_k3f9a2">' +   // duplicate
      '<p>after</p>' }
  },
  ['e_plain']: { id: 'plain', data: { html: '<p>no images here</p>' } }
};

const bj = JOURNALS.find((j) => j.doc === 'journal');
const keys = Object.keys(imageKeys(journalDoc, bj.scheme));
const derived = keys.slice().sort();

t('finds every distinct image placeholder', keys.length === 2, 'got ' + JSON.stringify(keys));
t('de-duplicates a repeated image', keys.filter((k) => k.endsWith('k3f9a2')).length === 1);
t('derived id is already a full document id',
  derived.every((k) => k.indexOf(bj.imgPrefix) === 0), 'got ' + JSON.stringify(derived));
t('derived ids equal what the writer stored',
  derived[0] === 'journal_img_' + entryId + '_k3f9a2' &&
  derived[1] === 'journal_img_' + entryId + '_zz01qq', 'got ' + JSON.stringify(derived));
t('entry ids come off the e_ fields',
  entryIds(journalDoc).sort().join(',') === ['plain', entryId].sort().join(','),
  'got ' + JSON.stringify(entryIds(journalDoc)));

section('backup.js guards the derivation it depends on');

t('backup.js uses the placeholder key directly as the document id',
  /allImageIds\[k\]\s*=\s*true/.test(SRC) &&
  !/allImageIds\[spec\.imgPrefix \+ k\]/.test(SRC),
  'The prefix must not be re-applied.');
t('a key not matching its journal prefix is reported, not silently kept',
  /oddKeys\.push/.test(SRC) && /unrecognisedKeys/.test(SRC),
  'A scheme change should surface loudly instead of yielding zero images.');

section('A zero-sample run can never be read as zero bytes');

t('estimateValid is false when ids exist but none were sampled',
  /var imgOk = \(imgIds\.length === 0\) \|\| \(sampled\.length > 0\);/.test(SRC));
t('estTotalBytes is null — not 0 — when the estimate is invalid',
  /estTotalBytes: imgOk \? avg \* imgIds\.length : null/.test(SRC),
  'Zero would green-light putting blobs in git on no evidence at all.');
t('the git decision refuses to decide without a valid estimate',
  /CANNOT DECIDE/.test(SRC) && /Do NOT treat this as 0 MB/.test(SRC));

section('Compressed size is measured, not assumed');

t('gzipBytes uses CompressionStream and returns null when unavailable',
  /new CompressionStream\('gzip'\)/.test(SRC) &&
  /if \(typeof CompressionStream === 'undefined'\) return null;/.test(SRC),
  'Git growth follows the compressed size; it must be a measurement.');
t('the old "typically lands near a tenth" guess is gone',
  !/near a tenth of this/.test(SRC));
t('git growth is projected from the measured gzip size',
  /coreGz \* 94/.test(SRC),
  '94 = 30 daily + 52 weekly + 12 monthly retained files.');

section('Phase 0 is still inert');

t('no Firestore write call exists anywhere in backup.js',
  !/\bsetDoc\s*\(|\bupdateDoc\s*\(|\bdeleteDoc\s*\(|\baddDoc\s*\(/.test(SRC),
  'Backups are a restore source; they must never write to Firestore.');
t('no IndexedDB or localStorage write in phase 0',
  !/localStorage\.setItem|indexedDB\.open/.test(SRC));

// ───────────────────────── behavioural ─────────────────────────
// Everything above is static. This runs the shipped measure() end to end,
// which is the only part that would have caught the original bug.
const imgA = 'journal_img_' + entryId + '_k3f9a2';
const imgB = 'journal_img_' + entryId + '_zz01qq';
const fake = fakeStore({
  journal: journalDoc,
  [imgA]: { img: 'data:image/png;base64,' + 'A'.repeat(4000), savedAt: 1 },
  [imgB]: { img: 'data:image/png;base64,' + 'B'.repeat(6000), savedAt: 1 },
  main: { data: {}, savedAt: 1 }
});
A1.register({ db: fake.db, projectId: 'test-project', appId: 'fake', fs: fake.fs });

A1.measure('fake').then((rep) => {
  section('Behaviour: measure() reads the image documents that actually exist');

  const im = rep.groups.images;
  t('found both images', im.count === 2, 'got ' + im.count);
  t('SAMPLED both images (the bug sampled none)', im.sampled === 2,
    'sampled ' + im.sampled + ' — a double-prefixed id reads as absent');
  t('estimate is marked valid', im.estimateValid === true);
  t('estimated bytes are non-zero and sane',
    im.estTotalBytes > 8000 && im.estTotalBytes < 40000, 'got ' + im.estTotalBytes);
  t('it requested the real image ids',
    fake.reads.includes('dashboards/' + imgA) && fake.reads.includes('dashboards/' + imgB),
    'requested: ' + fake.reads.filter((x) => x.indexOf('_img_') >= 0).join(', '));
  t('it never requested a double-prefixed id',
    !fake.reads.some((x) => /journal_img_journal_img_/.test(x)),
    'requested: ' + fake.reads.filter((x) => /_img_/.test(x)).join(', '));
  t('no unrecognised keys for a well-formed journal', im.unrecognisedKeys.length === 0);

  section('Behaviour: compressed size is a real measurement');
  t('gzipped core size was measured',
    typeof rep.totals.coreBytesGzip === 'number' && rep.totals.coreBytesGzip > 0,
    'got ' + rep.totals.coreBytesGzip);
  t('gzip actually compresses (ratio > 2x)',
    rep.totals.coreBytesRaw / rep.totals.coreBytesGzip > 2,
    'raw ' + rep.totals.coreBytesRaw + ' gz ' + rep.totals.coreBytesGzip);

  console.log('\n' + '─'.repeat(64));
  if (fail) {
    console.log(fail + ' FAILED:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('All ' + pass + ' backup-measure checks passed.');
}).catch((e) => {
  console.error('\nmeasure() threw: ' + (e && (e.stack || e.message || e)));
  process.exit(1);
});
