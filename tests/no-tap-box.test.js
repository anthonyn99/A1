// Guards "no blue box on a phone tap or hold" in every program.
//
// Mobile Chrome/Brave paint a blue box over anything tapped (the tap highlight),
// and a long-press on a button selects its label. Each program page carries
// the same <style id="no-tap-box"> block; ORCA's one stylesheet carries the
// same rules. Guardian and LifeHub draw inside shadow roots that reset
// everything with `:host{all:initial}`, which drops the page's rule, so they
// must restate it themselves (this is how the lock screens grew the box).
//
// A new program page goes in PAGES.
//
// Run: node tests/no-tap-box.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./moved');

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

const PAGES = [
  'index.html', 'magi.html', 'mylist.html', 'oneinbox.html', 'shield.html',
  'wellness.html', 'backup-export.html', 'backup-restore.html',
  'insight.html', 'riftiq.html', 'solace.html', 'tradehub.html', 'vault.html',
];
const NO_HIGHLIGHT = /\*,\*::before,\*::after\{-webkit-tap-highlight-color:transparent\}/;
const NO_SELECT = /button,\[role="button"\][^{]*\{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none\}/;

for (const p of PAGES) {
  if (!M.has(p)) { M.skipNote(p); continue; }
  const s = M.read(p);
  const m = s.match(/<style id="no-tap-box">([\s\S]*?)<\/style>/);
  ok(p + ' has the no-tap-box block', !!m && NO_HIGHLIGHT.test(m[1]) && NO_SELECT.test(m[1]));
  // Before the page's own styles, so a page rule can still opt an element back in.
  ok(p + ' puts it before its other styles', !!m && s.indexOf('<style') === s.indexOf('<style id="no-tap-box">'));
}

// Shadow roots that reset with all:initial must restate the rule.
const shadow = (rel, re) => {
  const s = fs.readFileSync(path.join(M.ROOT, rel), 'utf8');
  ok(rel + ' restates no tap highlight inside its shadow root', re.test(s));
};
shadow('Guardian/guardian.js', /':host,\*,\*::before,\*::after\{-webkit-tap-highlight-color:transparent\}'/);
shadow('LifeHub/lifehub.js', /':host,\*,\*::before,\*::after\{-webkit-tap-highlight-color:transparent\}'/);

const orca = path.join(M.ROOT, '..', 'ORCA', 'app', 'web', 'static', 'app.css');
if (fs.existsSync(orca)) {
  const c = fs.readFileSync(orca, 'utf8');
  ok('ORCA app.css carries the same rules', NO_HIGHLIGHT.test(c) && NO_SELECT.test(c));
} else console.log('  · skipped ORCA: no ../ORCA checkout here');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
