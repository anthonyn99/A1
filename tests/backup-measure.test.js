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
  DecompressionStream: global.DecompressionStream,
  TextEncoder: global.TextEncoder, TextDecoder: global.TextDecoder,
  crypto: global.crypto, btoa: global.btoa, atob: global.atob,
  // Inert timers. register() starts the setup prompt poll and the watchdog,
  // whose first check is two minutes out — real timers would hold the node
  // event loop open and make this suite hang rather than finish.
  setTimeout: () => 0, clearTimeout: () => {},
  setInterval: () => 0, clearInterval: () => {},
  // No indexedDB here on purpose: the vault is browser-only and is covered by
  // the CDP verification, not by this suite.
  Date, Math, JSON, Object, Error, RegExp, Promise, Array, Uint8Array, String, Number
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
// The first version of this projection multiplied by 94 "retained files",
// which understated growth by ~4x. Git keeps every blob ever committed, so
// pruning the working tree reclaims nothing: growth is commits-per-year times
// blob size, and retention policy is irrelevant to it.
t('git growth is projected from commits per year, not retained files',
  /\['daily', 365\], \['weekly', 52\], \['monthly', 12\]/.test(SRC) &&
  !/coreGz \* 94/.test(SRC),
  'Retention does not bound a git repository.');
t('the projection says so explicitly',
  /git keeps every blob ever committed/.test(SRC));
t('per-document compression is measured',
  /report\.perDoc = perDoc;/.test(SRC),
  'A poor overall ratio is only actionable if you know which document causes it.');
t('documents approaching the 900 KB write guard are flagged',
  /Firestore write guard refuses at 900 KB/.test(SRC),
  'A 700 KB document is a live sync risk, not just a backup sizing question.');

section('Storage writes are gated, not unconditional');

t('no Firestore write call exists anywhere in backup.js',
  !/\bsetDoc\s*\(|\bupdateDoc\s*\(|\bdeleteDoc\s*\(|\baddDoc\s*\(/.test(SRC),
  'Backups are a restore source; they must never write to Firestore.');

// Phase 1 legitimately writes to IndexedDB and localStorage. What must hold is
// that every capture is gated — kill switch, passphrase, cloud-loaded, storage
// headroom — before anything is stored.
const cap = SRC.slice(SRC.indexOf('async function captureNow'),
                      SRC.indexOf('async function listSnapshots'));
t('capture checks the kill switch first', /if \(killed\(\)\) return/.test(cap));
t('capture refuses while locked', /skipped: 'locked/.test(cap));
t('capture refuses before the cloud has loaded',
  /if \(!opts\.force && !gatesOpen\(\)\)/.test(cap),
  'Acting on state that has not arrived is how the archive bug lost data.');
t('capture refuses when storage headroom is low',
  /if \(!\(await storageOk\(\)\)\)/.test(cap),
  'Filling iOS origin storage can evict Firestore own cache and wedge sync.');
t('the cloud gate checks all three published flags',
  /window\._fbReady && window\._thCloudLoaded && window\._vdCloudLoaded/.test(SRC));
t('a refused snapshot is parked, not dropped, and raises the alarm',
  /suspect-/.test(cap) && /_fbSyncAlert/.test(cap));
t('a refusal leaves the previous snapshot untouched',
  /The previous backup is untouched/.test(cap));


section('A stopped backup announces itself');

// Every incident in this project has been silent. A backup system that quietly
// stops is worse than none, because it is trusted. Neither person can read a
// console — Veda cannot open one on a phone at all — so a failure has to reach
// the same visible alert the sync layer already uses.
const wd = SRC.slice(SRC.indexOf('var STALE_HOURS'), SRC.indexOf('async function report'));
t('a staleness threshold is defined', /var STALE_HOURS = 48;/.test(wd));
t('"set up but nothing ever saved" counts as a failure',
  /nothing has ever been saved/.test(wd),
  'Capture failing from the start looks identical to being idle unless this is checked.');
t('an old last-backup counts as a failure', /the last backup on this device is/.test(wd));
t('an unreadable vault counts as a failure',
  /vault unreadable/.test(wd) && /vault error/.test(wd));
t('failures reach the visible alert, not just the console',
  /window\._fbSyncAlert/.test(wd) && /console\.error\('\[A1Backup\] NOT BACKING UP/.test(wd));
t('the alert says data sync itself is unaffected',
  /still syncing normally/.test(wd),
  'Otherwise a backup warning reads as "you are losing data right now".');
t('it is rate-limited so it cannot become noise',
  /NAG_EVERY_MS/.test(wd) && /_lastNag/.test(wd));
t('the first check is delayed past a slow cold start',
  /setTimeout\(function \(\) \{ healthCheckLoud\(\)[\s\S]{0,40}?\}, 120000\)/.test(SRC),
  'A cold start must not be mistaken for a failure.');
t('it re-checks hourly', /CHECK_EVERY_MS = 3600000/.test(SRC));
t('the watchdog starts when an app registers',
  /try \{ startWatchdog\(\); \} catch \(e\) \{\}/.test(SRC));
t('a disabled or unconfigured device is not nagged',
  /if \(killed\(\)\) return \{ ok: true, why: 'disabled' \};/.test(wd) &&
  /if \(!setupDone\(\)\) return \{ ok: true, why: 'not set up' \};/.test(wd));

section('The listener taps are wired and cannot alter app behaviour');

// Every document Index owns that has a live listener should be tapped, since
// those cost zero extra Firestore reads.
const TAPPED = ['main', 'vedasdash', 'journal', 'tony_journal', 'plans', 'navorder',
                'applock', 'tesla_cfg', 'pv_cards', 'studyos_mirror',
                'studyos_mirror_ack', 'myjournal_docs', 'market_calendar',
                'oneinbox/cards'];
TAPPED.forEach((d) => {
  t("dashboards/" + d + ' is tapped', HTML.includes("_a1b('dashboards/" + d + "'"),
    'A listener already delivers this document; not tapping it wastes a free capture.');
});

t('the tap helper swallows its own failures',
  /const _a1b = \(path, data\) => \{[\s\S]{0,220}?catch \(e\)/.test(HTML),
  'A backup fault must never propagate into a sync handler.');

t('the tap helper is defined before any listener uses it',
  HTML.indexOf('const _a1b = (path, data)') < HTML.indexOf("_a1b('dashboards/"),
  'Const is in the temporal dead zone until its declaration runs.');

// The regression that prompted this check: a tap was appended under a
// brace-less `if`, which silently made the ORIGINAL statement unconditional.
// It was valid JavaScript, so every syntax check and every test still passed.
const htmlLines = HTML.split(/\r?\n/);
const badTaps = [];
htmlLines.forEach((line, i) => {
  if (line.indexOf('_a1b(') === -1) return;
  let j = i - 1;
  while (j >= 0 && (htmlLines[j].trim() === '' || htmlLines[j].trim().indexOf('//') === 0)) j--;
  const prev = (htmlLines[j] || '').trim();
  // A preceding `if (...)` with no `{` and no statement on the same line means
  // this tap became the if's body and displaced whatever followed it.
  if (/^if\s*\(/.test(prev) && prev.indexOf('{') === -1 && /\)$/.test(prev)) {
    badTaps.push('line ' + (i + 1) + ' after: ' + prev);
  }
});
t('no tap was inserted as the body of a brace-less if',
  badTaps.length === 0, badTaps.join('\n      '));

t('no tap participates in control flow',
  !/return _a1b\(|_a1b\([^)]*\)\s*(&&|\|\||\?)/.test(HTML),
  'A tap must be a statement with no effect on what the handler does next.');

// ───────────────────────── behavioural ─────────────────────────
// Everything above is static. This runs the shipped measure() end to end,
// which is the only part that would have caught the original bug.
const imgA = 'journal_img_' + entryId + '_k3f9a2';
const imgB = 'journal_img_' + entryId + '_zz01qq';
const fake = fakeStore({
  journal: journalDoc,
  [imgA]: { img: 'data:image/png;base64,' + 'A'.repeat(4000), savedAt: 1 },
  [imgB]: { img: 'data:image/png;base64,' + 'B'.repeat(6000), savedAt: 1 },
  // A realistically-sized, repetitive TaskHub document. gzip overhead dominates
  // on a few hundred bytes, so a toy fixture would say nothing useful about the
  // compression ratio that git growth actually depends on.
  main: {
    savedAt: 1,
    data: (() => {
      const d = {};
      for (let i = 0; i < 400; i++) {
        const k = '2026-' + String((i % 12) + 1).padStart(2, '0') + '-' +
                  String((i % 28) + 1).padStart(2, '0') + '#' + i;
        d[k] = [
          { id: 'id' + i, type: 'task', done: i % 2 === 0, category: 'work',
            title: 'Some reasonably long task title for realism ' + i },
          { id: 'ev' + i, type: 'event', time: '09:00', category: 'work',
            title: 'Recurring stand-up meeting ' + i }
        ];
      }
      return d;
    })()
  }
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
  t('per-document compression was recorded for every core document',
    Array.isArray(rep.perDoc) && rep.perDoc.length >= 2 &&
    rep.perDoc.every((d) => typeof d.raw === 'number' && typeof d.gz === 'number'),
    'got ' + JSON.stringify((rep.perDoc || []).map((d) => d.path)));
  t('perDoc is sorted by compressed size, largest first',
    (rep.perDoc || []).every((d, i, a) => i === 0 || a[i - 1].gz >= d.gz));
  t('gzip actually compresses (ratio > 2x)',
    rep.totals.coreBytesRaw / rep.totals.coreBytesGzip > 2,
    'raw ' + rep.totals.coreBytesRaw + ' gz ' + rep.totals.coreBytesGzip);

  console.log('\n' + '─'.repeat(64));
  if (fail) {
    console.log(fail + ' FAILED:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('All ' + pass + ' backup-measure checks passed.');
  process.exit(0);
}).catch((e) => {
  console.error('\nmeasure() threw: ' + (e && (e.stack || e.message || e)));
  process.exit(1);
});
