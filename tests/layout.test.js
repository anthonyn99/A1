// Guards A1's layout (docs/layout.md): every program's page sits at the top
// (the repo root, or V1's top for Veda's programs) and every other tracked file
// lives in a folder that says what it is for. Only those pages and the files
// that cannot live anywhere else sit at the repo root, at V1/'s top or at
// docs/'s top, and each top-level folder is one Rules/layout.json names. A new
// program: its page in `pages`, its files in a listed folder, docs/layout.md.
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
  const pages = rule.pages || {};
  const loose = got.files.filter((f) => !(f in rule.files) && !(f in pages));
  ok('nothing loose at ' + where + ' (' + got.files.length + ' files: program pages, or each with a reason)', loose.length === 0,
    loose.join(', ') + ' — a program page: list it in Rules/layout.json `pages`; anything else goes in the folder it belongs to (docs/layout.md)');
  const nopage = Object.keys(pages).filter((f) => !got.files.includes(f));
  ok('every program page Rules/layout.json lists sits at ' + where, nopage.length === 0, nopage.join(', '));
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

// A program's page never hides in a folder: the top is where every page lives.
// (Shruti/tests and tests/ hold harness pages, Notebook its embedded frames,
// the extensions their popups, the desktop agents their local UI.)
const NOT_PROGRAMS = /^(tests|Shruti\/tests|docs|Notebook|PriceWatch|V1\/Launcher|Shield\/desktop|V1\/StudyOS\/desktop|V1\/TradeBoard|V1\/tools|magi|workers|workers2|V1\/workers|Backup)\//;
const hidden = files.filter((f) => /\.html$/.test(f) && f.includes('/') && !/^V1\/[^/]+\.html$/.test(f) && !NOT_PROGRAMS.test(f));
ok('no program page hides in a folder', hidden.length === 0, hidden.join(', ') + ' — put the page at the top (Rules/layout.json `pages`)');

// docs/layout.md describes every top-level folder the rules allow, and every page.
const doc = fs.readFileSync(path.join(ROOT, 'docs', 'layout.md'), 'utf8');
const undocPages = Object.keys(L.root.pages).concat(Object.keys(L.V1.pages).map((p) => 'V1/' + p)).filter((p) => !doc.includes('`' + p + '`'));
ok('docs/layout.md names every program page', undocPages.length === 0, undocPages.join(', '));
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
