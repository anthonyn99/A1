// Guards popups.js: every popup backdrop wears TaskHub's look (rgba(0,0,0,.6)
// + blur(7px) saturate(.9)), a click outside closes it, a drag that ends
// outside never does (Tony, 2026-11-03: "ALL popups in both Index AND all A1
// apps ... the defaults ... in the future too").
//
//  1. Every program loads it in <head>, before the page's own code. A new
//     program belongs in PAGES the day it ships (docs/popups.md).
//  2. The look is TaskHub's exactly, and Guardian's lock (a shadow root the
//     file can't reach) carries the same look in its own CSS.
//  3. ORCA's pages load it too (both the Python templates and the worker).
//
// Prove behaviour with: node tests/live/popups.live.js
// Run: node tests/popups-wiring.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./moved');

const ROOT = path.join(__dirname, '..');
const TAG = new RegExp('<script[^>]+src=["\']' + M.src('popups.js') + '["\'][^>]*>');
const PAGES = ['index.html', 'magi.html', 'mylist.html', 'shield.html', 'Shruti/shruti.html', 'V1/wellness.html',
  'backup-restore.html', 'backup-export.html', 'V1/studyos.html',
  'oneinbox.html', 'insight.html', 'tradehub.html', 'riftiq.html', 'everwell.html', 'vault.html'];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const code = fs.readFileSync(path.join(ROOT, 'popups.js'), 'utf8');
ok('popups.js parses', (() => { try { new vm.Script(code); return true; } catch (e) { return false; } })());
ok('the look is TaskHub\'s', /var DIM = 'rgba\(0,0,0,\.6\)';/.test(code) && /var BLUR = 'blur\(7px\) saturate\(\.9\)';/.test(code));
ok('clicks are guarded in the capture phase', /addEventListener\('click', onClick, true\)/.test(code));
const guardian = fs.readFileSync(path.join(ROOT, 'Guardian/guardian.js'), 'utf8');
ok('Guardian\'s lock wears the same look', /\.ov\{[^}]*background:rgba\(0,0,0,\.6\);-webkit-backdrop-filter:blur\(7px\) saturate\(\.9\);backdrop-filter:blur\(7px\) saturate\(\.9\)/.test(guardian));

for (const name of PAGES) {
  if (M.isMoved(name) && !M.has(name)) { M.skipNote(name); continue; }
  const html = (M.isMoved(name) ? M.read(name) : fs.readFileSync(path.join(ROOT, name), 'utf8'));
  const m = TAG.exec(html);
  ok(name + ' loads popups.js', !!m);
  if (!m) continue;
  const at = m.index, head = html.indexOf('</head>');
  ok(name + ': in <head>', head < 0 || at < head, 'tag at ' + at + ', </head> at ' + head);
  const firstRender = [/ReactDOM\.(createRoot|render)\(/, /<script[^>]+type=["']text\/babel/].map((re) => { const x = re.exec(html); return x ? x.index : Infinity; });
  ok(name + ': before any React render', at < Math.min.apply(null, firstRender));
}

const ORCA = path.join(ROOT, '..', 'ORCA');
if (fs.existsSync(ORCA)) {
  for (const f of ['app/web/templates/base.html', 'app/web/templates/_picker_base.html']) {
    ok('ORCA ' + f + ' loads popups.js', fs.readFileSync(path.join(ORCA, f), 'utf8').includes('https://anthonyn99.github.io/A1/popups.js'));
  }
  const ts = fs.readFileSync(path.join(ORCA, 'worker/src/web/html.ts'), 'utf8');
  ok('ORCA worker pages load popups.js', (ts.match(/<script src="\$\{POPUPS_SRC\}"><\/script>/g) || []).length === (ts.match(/<script src="\$\{SCROLLBAR_SRC\}"><\/script>/g) || []).length);
} else console.log('  skip ORCA (no checkout beside A1)');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
