// Guards the wiring of hoverfx.js — the one hover language every A1 program
// shares (a dim control lifts on hover, a bright one settles).
//
// Two things can silently break it, and neither shows up as an error anywhere:
//
//  1. A page stops loading it. The app still works; its buttons just quietly go
//     dead to the cursor, and nobody notices until they are looking for it.
//     A NEW single-file app belongs in PAGES the day it ships, same rule as
//     tests/syntax-check.js.
//
//  2. A copy drifts. The browser extensions and the Shield desktop UI cannot
//     reference a file outside their own folder, so each carries a copy of
//     hoverfx.js. Copies rot: someone fixes a bug in the root file and the three
//     copies keep the bug forever. This asserts they are byte-identical, so the
//     only way to change the behaviour is to change it everywhere.
//
// Run: node tests/hoverfx-wiring.test.js

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Pages served from the repo root, which load the shared file directly.
const PAGES = [
  'index.html', 'riftiq.html', 'tradehub.html', 'shield.html', 'mylist.html',
  'solace.html', 'vault.html', 'insight.html', 'oneinbox.html', 'wellness.html',
];

// Folders that ship their own copy, and the page in each that loads it.
const COPIES = [
  ['Vault', 'popup.html'],
  ['PriceWatch', 'popup.html'],
  [path.join('V1', 'Launcher'), 'popup.html'],
  [path.join('desktop', 'shield', 'ui'), 'index.html'],
];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const srcPath = path.join(ROOT, 'hoverfx.js');
ok('hoverfx.js exists at the repo root', fs.existsSync(srcPath));
if (!fs.existsSync(srcPath)) { console.log('\n  1 failed'); process.exit(1); }
const src = fs.readFileSync(srcPath);

// The listener is delegated from `document`, so it must not be deferred behind
// anything: it is loaded last on purpose, but a `defer`/`async` attribute would
// also be fine. What must NOT happen is the tag going missing.
for (const name of PAGES) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) { ok(name + ' exists', false); continue; }
  const html = fs.readFileSync(file, 'utf8');
  ok(name + ' loads hoverfx.js', /<script[^>]+src=["']hoverfx\.js["']/.test(html));
}

// index.html is the one page that must pass data-roots: it hosts several
// programs plus a shared program nav that already answers the cursor with its
// own gold outline and glow. Unscoped, the layer would double up on that nav.
const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const rootsAttr = /<script[^>]+src=["']hoverfx\.js["'][^>]*\sdata-roots=["']([^"']+)["']/.exec(idx);
ok('index.html scopes hoverfx with data-roots', !!rootsAttr);
if (rootsAttr) {
  const roots = rootsAttr[1].split(',').map((s) => s.trim());
  for (const id of ['#root', '#veda-root', '#tj-root', '#bj-root', '#thset-overlay']) {
    ok('index.html data-roots covers ' + id, roots.includes(id));
  }
  ok('index.html does NOT scope the program nav', !roots.includes('#tony-app-nav'));
}

for (const [folder, page] of COPIES) {
  const copy = path.join(ROOT, folder, 'hoverfx.js');
  const label = path.join(folder, 'hoverfx.js');
  if (!fs.existsSync(copy)) { ok(label + ' exists', false); continue; }
  ok(label + ' is identical to the root file', fs.readFileSync(copy).equals(src));

  const file = path.join(ROOT, folder, page);
  if (!fs.existsSync(file)) { ok(path.join(folder, page) + ' exists', false); continue; }
  const html = fs.readFileSync(file, 'utf8');
  ok(path.join(folder, page) + ' loads hoverfx.js',
     /<script[^>]+src=["']hoverfx\.js["']/.test(html));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
