#!/usr/bin/env node
/**
 * Journal inline-image extraction ↔ rehydration must be symmetric.
 *
 * WHY THIS FILE EXISTS
 * dashboards/journal sat at 700 KB, 78% of the 900 KB ceiling where every save
 * is refused and the journal silently stops syncing. The bulk was base64 still
 * inline in entry HTML, and compaction could not shift it: the extractor only
 * ever queried `img[src]`, while those images live in `href`. Three runs moved
 * 51 bytes between them.
 *
 * Widening the extractor is only safe if the rehydrator is widened to match. A
 * placeholder written into an attribute the rehydrator does not restore is a
 * broken image, or a dead link, in someone's journal — and the original bytes
 * are gone from the entry by then. This asserts the round trip on the SHIPPED
 * functions, lifted out of index.html so they cannot drift from what runs.
 *
 * Run: node tests/journal-images.test.js
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

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Lift a function by brace matching from its declaration.
function grab(startMarker) {
  const i = HTML.indexOf(startMarker);
  if (i < 0) throw new Error('not found: ' + startMarker);
  let d = 0, started = false, j = i;
  for (; j < HTML.length; j++) {
    const c = HTML[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) { j++; break; } }
  }
  return HTML.slice(i, j);
}

// A DOM good enough for these two functions: they only ever set innerHTML,
// querySelectorAll, get/setAttribute and read innerHTML back.
let jsdom = null;
try { jsdom = require('jsdom'); } catch (e) { /* optional */ }
if (!jsdom) {
  console.log('  (jsdom not installed — running the DOM-free assertions only)');
}

section('Extractor and rehydrator agree on which attributes they handle');

const bjExtract = grab('const _bjExtractHtmlImages = async (html, e) => {');
const tjExtract = grab('const _tjExtractHtmlImages = async (html, e, dateKey) => {');
const bjRehydrate = grab('window._fbRehydratePageImages = async (html) => {');
const tjRehydrate = grab('window._fbRehydrateTonyPageImages = async (html) => {');

[['Brainstorm', bjExtract, bjRehydrate, 'bj'], ['MyJournal', tjExtract, tjRehydrate, 'tj']]
  .forEach(([label, ext, reh, scheme]) => {
    t(label + ': extractor looks at src AND href',
      /querySelectorAll\('\[src\],\[href\]'\)/.test(ext),
      'It only queried img[src], which is why href images never moved.');
    t(label + ': extractor writes the placeholder into the attribute it read',
      /setAttribute\(attr, '/.test(ext) && !/setAttribute\('src', '/.test(ext),
      'Hard-coding src would put the placeholder in the wrong attribute.');
    t(label + ': rehydrator matches BOTH attributes',
      new RegExp("\\[src\\^=\"" + scheme + "-fbimg://\"\\],\\[href\\^=\"" + scheme + "-fbimg://\"\\]").test(reh),
      'An attribute it does not select is never restored.');
    t(label + ': rehydrator restores the attribute it found',
      /setAttribute\(attr, snap\.data\(\)\.img\)/.test(reh),
      'Restoring into src when the placeholder was in href leaves a dead link.');
    t(label + ': extractor skips trivial data URIs',
      /if \(src\.length < 2048\) return;/.test(ext),
      'A separate document plus a fetch to save a few hundred bytes is a bad trade.');
  });

section('No rehydrator uses an attr it never defined');

// My own edit put setAttribute(attr, ...) into the LEGACY myjournal rehydrator,
// which selects img[src] only and defines no `attr` — a ReferenceError on any
// legacy image. Same shape, opposite direction, in a function I was not even
// changing on purpose.
['window._fbRehydratePageImages = async (html) => {',
 'window._fbRehydrateMyJournalImages = async (html) => {',
 'window._fbRehydrateTonyPageImages = async (html) => {'].forEach((marker) => {
  const body = grab(marker);
  const name = marker.match(/window\.(\w+)/)[1];
  const usesAttr = /setAttribute\(attr,/.test(body);
  const definesAttr = /const attr = /.test(body);
  t(name + ': uses `attr` only if it defines it',
    !usesAttr || definesAttr,
    'setAttribute(attr, ...) with no `attr` in scope throws at runtime.');
  t(name + ': selects href only if it can restore href',
    !/href\^=/.test(body) || usesAttr,
    'Selecting an href placeholder and restoring into src leaves a dead link.');
});

// ───────────────────────── behavioural ─────────────────────────
if (jsdom) {
  section('Round trip: what goes out comes back identical');

  const { JSDOM } = jsdom;
  const dom = new JSDOM('<!doctype html><body></body>');

  const store = {};                       // fake dashboards collection
  const sandbox = {
    document: dom.window.document,
    console: { warn() {}, log() {} },
    Math, JSON, Object, Array, String, Promise, Date,
    doc: (db, coll, id) => ({ id: id || coll }),
    getDoc: async (ref) => ({
      exists: () => Object.prototype.hasOwnProperty.call(store, ref.id),
      data: () => store[ref.id],
    }),
    setDoc: async (ref, val) => { store[ref.id] = val; },
    _fbWriteRetry: async (fn) => fn(),
    db: {},
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(bjExtract + ';\n' + bjRehydrate + ';', sandbox);

  const extract = sandbox._bjExtractHtmlImages;
  const rehydrate = sandbox.window._fbRehydratePageImages;

  const big = 'A'.repeat(4000);
  const cases = {
    'an image in src': '<p>before</p><img src="data:image/png;base64,' + big + '"><p>after</p>',
    'an image in href': '<a href="data:image/png;base64,' + big + '">download</a>',
    'both at once': '<img src="data:image/png;base64,' + big + '"><a href="data:image/jpeg;base64,' + big + '">x</a>',
    'nothing to move': '<p>just text</p><img src="https://example.com/a.png">',
  };

  (async () => {
    for (const [name, original] of Object.entries(cases)) {
      const stripped = await extract(original, { id: 'e1' });
      const back = await rehydrate(stripped);
      t('round-trips ' + name, back === original,
        '\n        in:  ' + original.slice(0, 70) +
        '\n        out: ' + String(back).slice(0, 70));
    }

    const original = cases['an image in href'];
    const stripped = await extract(original, { id: 'e2' });
    t('the href case actually shrinks the entry',
      stripped.length < original.length / 2,
      original.length + ' -> ' + stripped.length + ' chars');
    t('the placeholder lands in href, not src',
      /href="bj-fbimg:\/\//.test(stripped) && !/src="bj-fbimg:\/\//.test(stripped),
      stripped.slice(0, 90));
    t('the image bytes were actually stored',
      Object.keys(store).some((k) => (store[k].img || '').indexOf('data:image') === 0));

    const small = '<img src="data:image/png;base64,' + 'B'.repeat(100) + '">';
    t('a trivial data URI is left alone',
      (await extract(small, { id: 'e3' })) === small);

    finish();
  })().catch((e) => { console.error('threw: ' + (e && (e.stack || e))); process.exit(1); });
} else {
  finish();
}

function finish() {
  console.log('\n' + '─'.repeat(64));
  if (fail) {
    console.log(fail + ' FAILED:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('All ' + pass + ' journal-image checks passed.');
}
