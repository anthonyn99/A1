#!/usr/bin/env node
// Notebook typing cost (Tony, 2026-11-20: "it lags, I have a lot of text and
// images"). Autosave runs every few seconds while typing, so each of its steps
// used to copy or re-parse the whole page. These are the cheaper versions, and
// this suite holds them to the SAME answers as the code they replaced:
//   - JGuard.emptyHtml: a scan that stops at the first visible character
//   - JGuard.same: the "did anything change" check, never "same" where sig differs
//   - fb.js _jExtractImgs: the image extraction done on the html string, with
//     the exact output the DOM path wrote (key attribute last, placeholder in
//     the value), and null (= take the DOM path) for markup it cannot be sure of
//   - _tjSetSync / _bjSetSync: saying Syncing again changes nothing
//   - docx.js: the undo history drops images nothing uses, reads the editor's
//     html once per change, and the journals' autosave reads it from there
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
function t(name, ok, why) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (why ? '  -> ' + why : '')); }
}

// ── JGuard ───────────────────────────────────────────────────────────────────
const store = {};
const sb = { window: {}, console, JSON, Math, Date, Object, Array, String, RegExp, Error, Promise, setTimeout, clearTimeout,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }, key: () => null, length: 0 } };
vm.createContext(sb);
vm.runInContext(read('Notebook/core/jguard.js'), sb, { filename: 'jguard.js' });
const J = sb.window.JGuard;

function oldEmpty(html) {
  if (!html) return true;
  const s = String(html);
  if (/<(img|table|canvas|svg|iframe|video|audio|hr|input|object|embed)\b/i.test(s)) return false;
  return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, '').length === 0;
}
let seed = 12345;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const parts = ['<p>', '</p>', '<br>', ' ', '\n', '&nbsp;', '&NBSP;', ' ', 'x', '<', '>', '<span style="a">', '&amp;', '​', '<b', '&nb'];
let diffs = 0, firstDiff = '';
for (let i = 0; i < 40000; i++) {
  let s = ''; const n = rnd(8);
  for (let j = 0; j < n; j++) s += parts[rnd(parts.length)];
  if (oldEmpty(s) !== J.emptyHtml(s)) { if (!diffs) firstDiff = JSON.stringify(s); diffs++; }
}
t('emptyHtml answers as the strip-and-replace version did (40,000 random pages)', diffs === 0, firstDiff);
t('emptyHtml: blank markup is empty, a word is not, an image is not',
  J.emptyHtml('<p>&nbsp;</p><p><br></p>') && !J.emptyHtml('<p> a </p>') && !J.emptyHtml('<p><img src="x"></p>'));

const vals = ['', 'a', 'ab', '<p>x</p>'];
let unsafe = 0;
for (let i = 0; i < 20000; i++) {
  const pick = () => vals[rnd(vals.length)];
  const mk = () => Object.assign({ html: pick(), attachments: rnd(5) ? [] : [{ n: pick() }] }, rnd(3) ? {} : { margins: { mt: rnd(2) } });
  const a = mk(), b = rnd(2) ? JSON.parse(JSON.stringify(a)) : mk(), ta = pick(), tb = rnd(2) ? ta : pick();
  if (J.same('page', a, b, ta, tb) && J.sig('page', a, ta) !== J.sig('page', b, tb)) unsafe++;
  const je = () => ({ dateOrder: ['d1', 'd2'].slice(0, rnd(3)), dates: rnd(2) ? { d1: { html: pick() } } : { d1: { html: pick() }, d2: { html: pick() } } });
  const c = je(), d = rnd(2) ? JSON.parse(JSON.stringify(c)) : je();
  if (J.same('journal-entries', c, d, ta, tb) && J.sig('journal-entries', c, ta) !== J.sig('journal-entries', d, tb)) unsafe++;
}
t('JGuard.same never calls two different contents the same (20,000 pairs)', unsafe === 0);
t('JGuard.same: identical page is same, one changed letter is not',
  J.same('page', { html: '<p>ab</p>' }, { html: '<p>ab</p>' }, 'T', 'T') && !J.same('page', { html: '<p>ab</p>' }, { html: '<p>ac</p>' }, 'T', 'T'));
for (const app of ['myjournal', 'brainstorm']) {
  t(app + ': the no-op save guard uses JGuard.same', /window\.JGuard\.same\(entry\.template, entry\.data, _next, entry\.title, _title\)/.test(read('Notebook/apps/' + app + '.js')));
}

// ── fb.js image extraction (string path) ─────────────────────────────────────
const fb = read('Notebook/core/fb.js');
const a = fb.indexOf('    const _jUnesc'), b = fb.indexOf('    // @nb-shared }', a);
t('fb.js: the string extraction sits in the shared block instances copy', a > 0 && b > a && fb.lastIndexOf('// @nb-shared {', a) > fb.lastIndexOf('// @nb-shared }', a));
const ex = {};
vm.runInNewContext(fb.slice(a, b) + '\nex._jExtractImgs = _jExtractImgs;', { ex, String, RegExp, Promise });
const big = (c) => 'data:image/png;base64,' + c.repeat(3000);
const keyFor = (s) => 'k' + s.length;
const putOk = async () => true;
const run = (html, put) => ex._jExtractImgs(html, 'data-tjkey', 'tj-fbimg://', keyFor, put || putOk);

(async () => {
  t('no inline image: the html comes back untouched', (await run('<p>plain</p>')) === '<p>plain</p>');
  t('a small inline image stays inline', (await run('<p><img src="data:image/png;base64,abc"></p>')) === '<p><img src="data:image/png;base64,abc"></p>');
  const k = keyFor(big('A'));
  t('a pasted image: placeholder in the value, key attribute added last (as setAttribute did)',
    (await run('<p>a<img src="' + big('A') + '" style="width:300px">b</p>')) === '<p>a<img src="tj-fbimg://' + k + '" style="width:300px" data-tjkey="' + k + '">b</p>');
  t('an image that already has a key keeps it, and its place',
    (await run('<p><img src="' + big('B') + '" data-tjkey="old_1" alt="x"></p>')) === '<p><img src="tj-fbimg://old_1" data-tjkey="old_1" alt="x"></p>');
  t('an empty key attribute is filled in place',
    (await run('<p><img data-tjkey="" src="' + big('C') + '"></p>')) === '<p><img data-tjkey="' + keyFor(big('C')) + '" src="tj-fbimg://' + keyFor(big('C')) + '"></p>');
  t('a file chip (href) is handled like an image',
    (await run('<p><a href="' + big('D') + '" download="f.pdf">f</a></p>')) === '<p><a href="tj-fbimg://' + keyFor(big('D')) + '" download="f.pdf" data-tjkey="' + keyFor(big('D')) + '">f</a></p>');
  t('a failed upload keeps the image inline, byte for byte',
    (await run('<p><img src="' + big('E') + '"></p>', async () => false)) === '<p><img src="' + big('E') + '"></p>');
  t('data-src is not mistaken for src',
    (await run('<p><img data-src="q" src="' + big('F') + '"></p>')) === '<p><img data-src="q" src="tj-fbimg://' + keyFor(big('F')) + '" data-tjkey="' + keyFor(big('F')) + '"></p>');
  t('an escaped value is unescaped before it is uploaded and keyed', await (async () => {
    let got = null; const v = 'data:image/svg+xml;utf8,' + 'x'.repeat(3000) + '&amp;y';
    await run('<p><img src="' + v + '"></p>', async (key, src) => { got = src; return true; });
    return got === v.replace('&amp;', '&');
  })());
  t('markup it cannot be sure of goes to the DOM path (single quotes)', (await run("<img src='" + big('G') + "'>")) === null);
  t('...(a raw ">" inside another value)', (await run('<p><img alt="a>b" src="' + big('H') + '"></p>')) === null);
  t('...(text that only reads src="data:...)', (await run('<p>&lt;img src="data:' + 'Q'.repeat(3000) + '"</p>')) === null);
  for (const app of ['tj', 'bj']) {
    t(app + ': the extractor tries the string path first, then the DOM path', new RegExp("const fast = await _jExtractImgs\\(html, 'data-" + app + "key', '" + app + "-fbimg://', keyFor, put\\);\\s*if \\(fast !== null\\) return fast;").test(fb));
  }

  // ── sync pill, cache write, autosave rhythm ────────────────────────────────
  for (const [file, k] of [['myjournal', 'tj'], ['brainstorm', 'bj']]) {
    const src = read('Notebook/apps/' + file + '.js');
    t(k + ': saying Syncing again returns before touching the pill', src.indexOf("if (status === 'syncing' && " + k + "SyncStatus === 'syncing' && pill && pill.className === '" + k + "-sync-pill " + k + "-sync-syncing') return;") > 0);
    t(k + ': the cache is not built past the localStorage quota', new RegExp('if \\(_' + k + 'CacheChars\\(\\) <= _' + k.toUpperCase() + '_CACHE_MAX\\) localStorage\\.setItem').test(src));
    t(k + ': autosave reads the page through _docxHtml', src.indexOf('window._docxHtml ? window._docxHtml(_pe) : _pe.innerHTML') > 0);
    t(k + ': a very long page saves at least every 5s', src.indexOf("(_now - _" + k + "AutoFirstAt >= (_big ? 5000 : 1500))") > 0);
  }

  // ── docx.js undo history ─────────────────────────────────────────────────
  const dx = read('Notebook/core/docx.js');
  t('history: images no history refers to are let go when a page opens', /function seed\(\) \{[^\n]*_hxGc\(\)/.test(dx) && /_HX\.list\[id\] = undefined/.test(dx));
  t('history: the stack has a size budget besides its step count', /HIST_MAX_CHARS = \d+/.test(dx) && /trimStack\(\);/.test(dx));
  t('history: record() and snap() read the editor through one cached copy', !/hcompact\(ctx\.edEl\.innerHTML\)/.test(dx) && /function compactHtml\(\)/.test(dx));
  t('history: every editor change drops the cached copy, suppressed or not', /function onMutation\(\) \{\s*rawC = null; cmpC = null;/.test(dx));
  t('history: a long page is not expanded just to be refused by the persist cap', /hexpandLen\(materialize\(stack\[lo\]\)\) > HIST_MAX_KEY/.test(dx));
  t('font size sync no longer copies the whole page text on each keyup', !/ctx\.edEl\.textContent\.replace/.test(dx) && /_docxHasText\(ctx\.edEl\)/.test(dx));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
