#!/usr/bin/env node
/**
 * A1Backup Phase 0 — measurement correctness.
 *
 * WHY THIS FILE EXISTS
 * The first live run reported `images ... 17 docs, ~0.0 MB (avg 0.0 KB from 0
 * sampled)` and concluded "blobs in git? YES — 0.0 MB is under the threshold".
 * Both halves were wrong in the same way: the image document ids were built by
 * prefixing the placeholder key, but the placeholder ALREADY contains the full
 * document id (the writer stores `<scheme>` + imgKey where imgKey itself starts
 * `journal_img_`). So every sample read missed, and a zero-sample run was then
 * reported as zero bytes — a silent zero standing in for "no evidence".
 *
 * That is the exact failure mode this whole backup project exists to remove, so
 * it gets a regression test rather than a fix and a shrug.
 *
 * The real functions are lifted out of backup.js so the test cannot drift from
 * the shipped code.
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
const sandbox = { window: {}, console: console, Blob: global.Blob, Response: global.Response };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'backup.js' });
const A1 = sandbox.window.A1Backup;
const { JOURNALS, entryIds, imageKeys } = A1._internals;

// ───────────────────────── the shipped writer's format ─────────────────────
section('The placeholder format matches what index.html actually writes');

// index.html builds:  imgKey = '<prefix>' + entry.id + '_' + hash
//              then:  src   = '<scheme>' + imgKey
// and reads back with: doc(db, 'dashboards', imgKey)   <- no prefix added
const writers = [
  { prefix: 'journal_img_',      scheme: 'bj-fbimg://' },
  { prefix: 'myjournal_img_',    scheme: 'mj-fbimg://' },
  { prefix: 'tony_journal_img_', scheme: 'tj-fbimg://' }
];
writers.forEach(w => {
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
  _order: [entryId, 'e_other'],
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

const bj = JOURNALS.find(j => j.doc === 'journal');
const keys = Object.keys(imageKeys(journalDoc, bj.scheme));

t('finds every distinct image placeholder', keys.length === 2, 'got ' + JSON.stringify(keys));
t('de-duplicates a repeated image', keys.filter(k => k.endsWith('k3f9a2')).length === 1);

// This is the bug: the derived id must be the key ITSELF, never prefix + key.
const derived = keys.slice().sort();
t('derived id is already a full document id',
  derived.every(k => k.indexOf(bj.imgPrefix) === 0),
  'got ' + JSON.stringify(derived));
t('derived id is NOT double-prefixed',
  derived.every(k => k.indexOf(bj.imgPrefix + bj.imgPrefix) !== 0),
  'journal_img_journal_img_... is what made every sample read miss');
t('derived ids equal what the writer stored',
  derived[0] === 'journal_img_' + entryId + '_k3f9a2' &&
  derived[1] === 'journal_img_' + entryId + '_zz01qq',
  'got ' + JSON.stringify(derived));

t('entry ids come off the e_ fields',
  entryIds(journalDoc).sort().join(',') === [entryId, 'plain'].sort().join(','),
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

console.log('\n' + '─'.repeat(64));
if (fail) {
  console.log(fail + ' FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('All ' + pass + ' backup-measure checks passed.');
