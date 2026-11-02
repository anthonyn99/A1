// Guards controls.js: A1's own selects, date / time pickers, checkboxes,
// colour picker and tooltips, so no program shows a browser-drawn control
// (Tony, 2026-11-02: "update EVERYTHING to clean ergonomic custom, our own,
// UI", both sides).
//
//  1. Every program loads it in <head>, before React or any page code (its
//     value hooks must be in place before React tracks an input). A new
//     program belongs in PAGES the day it ships.
//  2. Veda-only pages say so on the tag; StudyOS, which has its own controls,
//     limits it to V's Notebook.
//  3. Vault keeps vault-controls.js and does not load this one.
//
// Prove behaviour with: node tests/live/controls.live.js
// Run: node tests/controls-wiring.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./moved');

const ROOT = path.join(__dirname, '..');
const TAG = new RegExp('<script[^>]+src=["\']' + M.src('controls.js') + '["\'][^>]*>');
const PAGES = ['index.html', 'magi.html', 'mylist.html', 'shield.html', 'Shruti/shruti.html', 'wellness.html',
  'backup-restore.html', 'backup-export.html', 'V1/studyos.html',
  'oneinbox.html', 'insight.html', 'tradehub.html', 'riftiq.html', 'everwell.html'];
const VEDA_ONLY = ['wellness.html', 'V1/studyos.html'];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const code = fs.readFileSync(path.join(ROOT, 'controls.js'), 'utf8');
ok('controls.js parses', (() => { try { new vm.Script(code); return true; } catch (e) { return false; } })());
ok('controls.js stands down beside Vault\'s own', /if \(window\.A1Controls \|\| window\.VaultControls\) return;/.test(code));

for (const name of PAGES) {
  if (M.isMoved(name) && !M.has(name)) { M.skipNote(name); continue; }
  const html = (M.isMoved(name) ? M.read(name) : fs.readFileSync(path.join(ROOT, name), 'utf8'));
  const m = TAG.exec(html);
  ok(name + ' loads controls.js', !!m);
  if (!m) continue;
  const at = m.index, head = html.indexOf('</head>');
  ok(name + ': in <head>', head < 0 || at < head, 'tag at ' + at + ', </head> at ' + head);
  // Before anything that renders: React's first render, Babel or page modules.
  const firstRender = [/ReactDOM\.(createRoot|render)\(/, /<script[^>]+type=["']text\/babel/].map((re) => { const x = re.exec(html); return x ? x.index : Infinity; });
  ok(name + ': before any React render', at < Math.min.apply(null, firstRender));
  if (VEDA_ONLY.includes(name)) ok(name + ': tagged as Veda\'s', /data-profile=["']veda["']/.test(m[0]), m[0]);
}
const studyos = fs.readFileSync(path.join(ROOT, 'V1/studyos.html'), 'utf8');
ok('StudyOS limits it to V\'s Notebook', /controls\.js"[^>]*data-scope="\.sos-nb-host,\.sos-nb-modal-host"/.test(studyos));
if (M.has('vault.html')) ok('Vault does not load it', !TAG.test(M.read('vault.html')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
