// Guards apphead.js: the app mark beside every program's title and Everwell's
// sync pill (dot + word, no outline), one design across the suite
// (Tony, 2026-10-13).
//
//  1. Every program loads it and puts its mark in the header. A new program
//     belongs in PAGES the day it ships.
//  2. No program keeps a sync indicator of its own: each draws the shared pill
//     (Notebook styles its own copy of the same design, checked below).
//  3. The browser extensions cannot load a file from outside their folder, so
//     each carries a copy; copies must stay byte-identical to the root file.
//  4. Every glyph a page asks for exists.
//
// Run: node tests/apphead-wiring.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./moved');

const ROOT = path.join(__dirname, '..');
const LOADS = new RegExp('<script[^>]+src=["\']' + M.src('apphead.js') + '["\']');

// page → the marks it must show (static data-a1-app or a React AppIcon).
const PAGES = {
  'index.html': ['taskhub', 'journal', 'gita'],
  'mylist.html': ['mylist'],
  'oneinbox.html': ['oneinbox'],
  'magi.html': ['magi'],
  'wellness.html': ['wellness'],
  'tradehub.html': ['tradehub'],
  'insight.html': ['insight'],
  'vault.html': ['vault'],
  'riftiq.html': ['riftiq', 'proview'],
  'Shruti/shruti.html': ['shruti'],
};
// Shield and Everwell draw their own mark (Shield's is the model; Everwell's
// is its start-screen button), but Shield still uses the shared pill.
const PILL_ONLY = ['shield.html'];
const COPIES = [
  ['PriceWatch', 'popup.html', 'pricewatch'],
  ['Vault', 'popup.html', 'vault'],
  [path.join('V1', 'Launcher'), 'popup.html', null],
];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const srcPath = path.join(ROOT, 'apphead.js');
const src = fs.readFileSync(srcPath);
// Load it in a bare sandbox to learn the glyph names.
const sandbox = { window: {}, document: { readyState: 'complete', getElementById: () => null, createElement: () => ({}), head: { appendChild() {} }, querySelectorAll: () => [] }, navigator: {}, setTimeout, clearTimeout, WeakMap };
vm.runInNewContext(src.toString(), sandbox);
const names = (sandbox.window.A1Head && sandbox.window.A1Head.names) || [];
ok('apphead.js defines A1Head with glyphs', names.length > 10);

const marks = (html) => {
  const out = new Set();
  html.replace(/data-a1-app="([a-z-]+)"/g, (_, n) => out.add(n));
  html.replace(/AppIcon,\{app:"([a-z-]+)"/g, (_, n) => out.add(n));
  html.replace(/AppIcon app="([a-z-]+)"/g, (_, n) => out.add(n));
  return out;
};

for (const [name, want] of Object.entries(PAGES)) {
  if (M.isMoved(name) && !M.has(name)) { M.skipNote(name); continue; }
  const html = M.read(name);
  ok(name + ' loads apphead.js', LOADS.test(html));
  const got = marks(html);
  for (const w of want) ok(name + ' shows the ' + w + ' mark', got.has(w));
  for (const g of got) ok(name + ': glyph "' + g + '" exists', names.includes(g));
  ok(name + ' draws the shared sync pill', /a1-sync|A1Head\.sync|A1Head\.SyncPill/.test(html));
}
for (const name of PILL_ONLY) {
  const html = M.read(name);
  ok(name + ' loads apphead.js', LOADS.test(html));
  ok(name + ' draws the shared sync pill', /A1Head\.sync/.test(html) && /class="a1-sync/.test(html));
}

// The old per-program indicators are gone.
const GONE = [
  ['mylist.html', /class="sync-pill"/],
  ['oneinbox.html', /class="syncind"/],
  ['insight.html', /class="syncind"/],
  ['riftiq.html', /class="syncind"/],
  ['shield.html', /class="sync" id="sync"/],
  ['wellness.html', /class="wl-sync"/],
  ['index.html', /syncStatus==="saving"\?"Syncing…"/],
  ['tradehub.html', /syncLabel/],
];
for (const [name, re] of GONE) {
  if (M.isMoved(name) && !M.has(name)) continue;
  ok(name + ' has no old sync indicator', !re.test(M.read(name)));
}

// Notebook styles its pills itself (instances live on hosts that may not load
// apphead.js), in Everwell's design: no outline, Everwell's words.
for (const [x, app] of [['tj', 'myjournal'], ['bj', 'brainstorm']]) {
  const css = fs.readFileSync(path.join(ROOT, 'Notebook', 'apps', app + '.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'Notebook', 'apps', app + '.js'), 'utf8');
  const rule = new RegExp('#' + x + '-root \\.' + x + '-sync-pill \\{[^}]*\\}').exec(css);
  ok(app + ': pill has no outline', !!rule && /border: 0/.test(rule[0]) && /background: transparent/.test(rule[0]));
  ok(app + ': Everwell\'s words', /syncing:'Syncing…', synced:'Synced', error:'Sync failed'/.test(js));
}

for (const [folder, page, mark] of COPIES) {
  const copyRel = path.join(folder, 'apphead.js');
  if (M.isMoved(copyRel) && !M.has(copyRel)) { M.skipNote(folder); continue; }
  const copy = M.file(copyRel);
  ok(copyRel + ' exists', fs.existsSync(copy));
  if (!fs.existsSync(copy)) continue;
  ok(copyRel + ' is identical to the root file', fs.readFileSync(copy).equals(src));
  const html = fs.readFileSync(M.file(path.join(folder, page)), 'utf8');
  ok(path.join(folder, page) + ' loads apphead.js', /<script[^>]+src=["']apphead\.js["']/.test(html));
  if (mark) ok(path.join(folder, page) + ' shows the ' + mark + ' mark', marks(html).has(mark));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
