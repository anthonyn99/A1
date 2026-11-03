// Guards A1's layout (docs/layout.md): every tracked file lives in a folder
// that says what it is for. Only the files that cannot live anywhere else sit
// at the repo root, at V1/'s top or at docs/'s top, and each top-level folder
// is one Rules/layout.json names. A new program gets its own folder (listed
// there and in docs/layout.md in the same change), never loose files.
//
// Run: node tests/layout.test.js

'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const L = JSON.parse(fs.readFileSync(path.join(ROOT, 'Rules', 'layout.json'), 'utf8'));
const files = cp.execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\n').filter(Boolean)
  // A file staged for deletion is not part of the tree any more.
  .filter((f) => fs.existsSync(path.join(ROOT, f)));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
};

// Files directly inside `dir` ('' = the root) and the folders under it.
function level(dir) {
  const pre = dir ? dir + '/' : '';
  const here = files.filter((f) => f.startsWith(pre)).map((f) => f.slice(pre.length));
  return {
    files: [...new Set(here.filter((f) => !f.includes('/')))].sort(),
    folders: [...new Set(here.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort(),
  };
}

for (const [dir, rule, where] of [['', L.root, 'the repo root'], ['V1', L.V1, 'V1/'], ['docs', L.docs, 'docs/']]) {
  const got = level(dir);
  const loose = got.files.filter((f) => !(f in rule.files));
  ok('nothing loose at ' + where + ' (' + got.files.length + ' files, each with a reason)', loose.length === 0,
    loose.join(', ') + ' — move it into the folder it belongs to (docs/layout.md), or, if it truly cannot move, give it a reason in Rules/layout.json');
  if (rule.folders) {
    const unknown = got.folders.filter((f) => !(f in rule.folders));
    ok('every folder at ' + where + ' is a known one (' + got.folders.length + ')', unknown.length === 0,
      unknown.join(', ') + ' — a new program or kind of file: add its folder to Rules/layout.json and docs/layout.md');
    const gone = Object.keys(rule.folders).filter((f) => !got.folders.includes(f));
    ok('Rules/layout.json lists no folder that is gone from ' + where, gone.length === 0, gone.join(', '));
  }
  const stale = Object.keys(rule.files).filter((f) => !got.files.includes(f));
  ok('Rules/layout.json lists no file that is gone from ' + where, stale.length === 0, stale.join(', '));
}

// docs/layout.md describes every top-level folder the rules allow.
const doc = fs.readFileSync(path.join(ROOT, 'docs', 'layout.md'), 'utf8');
const undoc = Object.keys(L.root.folders).filter((f) => !f.startsWith('.') && !doc.includes('`' + f + '/`'));
ok('docs/layout.md describes every top-level folder', undoc.length === 0, undoc.join(', '));
const undocV1 = Object.keys(L.V1.folders).filter((f) => !f.startsWith('.') && !doc.includes('`V1/' + f + '/`'));
ok('docs/layout.md describes every V1 folder', undocV1.length === 0, undocV1.join(', '));

// CLAUDE.md carries the rule, so every session (Claude, Codex through MAGI) sees it.
const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
ok('CLAUDE.md points every new file at docs/layout.md', /docs\/layout\.md/.test(claude));

// ORCA (Veda's repo) still loads these three from the old root address until
// its templates switch to Shared/. Until then they must be exact copies, so a
// change to Shared/ can never leave ORCA on a stale file.
const norm = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
for (const f of L.root.orcaCopies || []) {
  ok('root ' + f + ' (ORCA\'s copy) is identical to Shared/' + f, fs.existsSync(path.join(ROOT, f)) && norm(f) === norm('Shared/' + f),
    'copy Shared/' + f + ' over it (or delete it and its Rules/layout.json entry once ORCA loads Shared/' + f + ')');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
