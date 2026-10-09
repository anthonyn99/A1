#!/usr/bin/env node
// Notebook wiring (docs/Notebook/plan.md). The journals' shared code lives in
// Notebook/ and hosts only load and configure it. This holds the line:
//   - every host's ?v= stamp matches the folder (a stale one serves old files)
//   - notebook.js loads its files in order, in place, stamped, during parsing
//   - index.html no longer holds any engine that moved, and each lives in
//     Notebook/ exactly once
//   - index.html loads Notebook synchronously, at the spots the engines held
//   - the Firestore accessors are installed from the host's init(), never at
//     parse time (they double as "Firebase is ready" signals)
// Phase 3 extends the "not in index.html" list to all journal code.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NB = path.join(ROOT, 'Notebook');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const idx = read('index.html');
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
const nbFiles = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.relative(NB, path.join(dir, d.name)).split(path.sep).join('/')]);
})(NB);
const nbSrc = (f) => fs.readFileSync(path.join(NB, f), 'utf8');

console.log('Stamp');
const stamp = require('../tools/notebook-stamp.js');
const st = stamp.run(true);
ok('index.html is a Notebook host', st.hosts.includes('index.html'), st.hosts.join(', '));
ok('every host carries the current stamp (' + st.want + ')', !st.stale.length, 'stale in ' + st.stale.join(', ') + ' — run node tools/notebook-stamp.js');

console.log('Loader');
function boot(readyState) {
  const written = [], appended = [];
  const el = (tag) => ({ tag });
  const win = {};
  const document = {
    readyState,
    currentScript: { src: 'https://anthonyn99.github.io/A1/Notebook/notebook.js?v=abc123' },
    write: (s) => written.push(s),
    createElement: el,
    head: { appendChild: (e) => appended.push(e) },
  };
  win.window = win; win.document = document;
  vm.runInNewContext(nbSrc('notebook.js'), win);
  return { win, written, appended };
}
const b = boot('loading');
const coreTags = (b.written[0] || '').match(/<(script src|link rel="stylesheet" href)="[^"]+"/g) || [];
const files = coreTags.map((t) => t.match(/"([^"]+)"$/)[1]);
ok('during parsing, the core group is written in place, in one write', b.written.length === 1 && files.length > 0, JSON.stringify(b.written));
ok('every file it writes is stamped with notebook.js\'s own ?v=', files.every((f) => f.endsWith('?v=abc123')), files.join(' '));
ok('...and resolved next to notebook.js', files.every((f) => f.startsWith('https://anthonyn99.github.io/A1/Notebook/')));
ok('the engines load in their original order (jguard, viz, oj) and fb.js last',
  files.map((f) => f.replace(/^.*\/Notebook\//, '').replace(/\?.*/, '')).join(',') === 'core/jguard.js,core/viz.css,core/viz.js,core/oj.css,core/oj.js,core/fb.js,core/md.js', files.join(' '));
ok('scripts are plain parser-blocking tags (no async/defer)', !/\b(async|defer)\b/.test(b.written[0]));
b.win.Notebook.load('docx');
ok('Notebook.load(\'docx\') writes the stylesheet before the module',
  /notebook\.css\?v=abc123"><script src="[^"]*core\/docx\.js\?v=abc123"><\/script>$/.test(b.written[1] || ''), b.written[1]);
b.win.Notebook.load('docx');
ok('a group loads once', b.written.length === 2);
const late = boot('complete');
ok('after parsing it appends ordered (async=false) elements instead of writing',
  !late.written.length && late.appended.length === 7 && late.appended.filter((e) => e.tag === 'script').every((e) => e.async === false));
const groupFiles = new Set((nbSrc('notebook.js').match(/'(?:(?:core|apps)\/[\w.]+|notebook\.css)'/g) || []).map((s) => s.slice(1, -1)));
ok('every file the loader names exists', [...groupFiles].every((f) => nbFiles.includes(f)), [...groupFiles].filter((f) => !nbFiles.includes(f)).join(', '));
ok('every Notebook file is loaded by some group (no orphans)',
  nbFiles.filter((f) => f !== 'notebook.js' && !groupFiles.has(f)).length === 0,
  nbFiles.filter((f) => f !== 'notebook.js' && !groupFiles.has(f)).join(', '));
const reg = boot('loading').win.Notebook, inits = [];
reg.registerDocx('xx', { root: 'xx-root' });
ok('registerDocx before the editor initialises only records the config', reg.docxApps.xx && reg.docxApps.xx.root === 'xx-root' && !inits.length);
reg._docxInitApp = (a) => inits.push(a);
reg.registerDocx('yy', {});
ok('registerDocx after it initialises the app on arrival', inits.join() === 'yy');

const mb = boot('loading'), mnb = mb.win.Notebook;
mnb.mount({ app: 'brainstorm', key: 'bj', store: 'journal' });
ok('Notebook.mount writes the app in place: its stylesheet, then its script',
  /apps\/brainstorm\.css\?v=abc123"><script src="[^"]*apps\/brainstorm\.js\?v=abc123"><\/script>$/.test(mb.written[1] || ''), mb.written[1]);
mnb.mount({ app: 'brainstorm', key: 'bj', store: 'journal' });
ok('...once per key, and it records the config', mb.written.length === 2 && mnb.mounts.bj.store === 'journal');
let threw = false; try { mnb.mount({ app: 'nope', key: 'zz' }); } catch (e) { threw = true; }
ok('...and refuses an app it does not know', threw);

console.log('Moved out of index.html, living in Notebook/ exactly once');
const MOVED = [
  ['the touch-drag helper', /window\._attachJournalTouchDrag\s*=/],
  ['JGuard', /window\.JGuard\s*=/],
  ['VizEngine', /window\.VizEngine\s*=/],
  ['the VizEngine core', /function fbReady\(\) \{ return !!\(window\._fbViz/],
  ['the OurJournal engine', /window\.OJ\s*=\s*\{/],
  ['the OurJournal CSS', /\.oj-rail\b/],
  ['the DOCX module', /window\._docxRebindImages\s*=/],
  ['the DOCX CSS', /\.docx-sheet\b/],
  ['the journal shell responsive CSS', /#tj-root #tj-sidebar, #bj-root #bj-sidebar/],
  ['the board accessor', /window\._fbViz\s*=/],
  ['the OurJournal accessor', /window\._fbOJ\s*=/],
  ['the Brainstorm app', /const STORAGE_KEY = 'brainstorm_journal_v3';/],
  ['Brainstorm\'s markup', /<div id="bj-root">/],
  ['Brainstorm\'s CSS', /#bj-root #bj-sidebar-header \{/],
  ['Brainstorm\'s icon sizing', /#bj-root \.bji\{/],
  ['Brainstorm\'s lock', /BJ LOCK SYSTEM/],
  ['the bj DOCX config', /Notebook\.registerDocx\('bj'/],
  ['the MyJournal app', /const STORAGE_KEY = 'tony_journal_v3';/],
  ['MyJournal\'s markup', /<div id="tj-root">/],
  ['MyJournal\'s CSS', /#tj-root #tj-sidebar-header \{/],
  ['MyJournal\'s icon sizing', /#tj-root \.tji\{/],
  ['MyJournal\'s lock', /TJ LOCK SYSTEM/],
  ['the tj DOCX config', /Notebook\.registerDocx\('tj'/],
  ['the MyJournal sidebar rail', /window\.MJDocsUI = /],
  ['the rail\'s CSS', /#tj-root #mjd-nav \{/],
  ['the journals\' Firestore loaders', /window\._fbLoadTonyJournal = /],
  ['Brainstorm\'s Firestore loader', /window\._fbLoadJournal = /],
  ['the journals\' stale-overwrite guards', /function _tjWhenServerSeen\(fn\)/],
  ['the journal image documents', /const _jImgGet = /],
];
for (const [name, re] of MOVED) {
  const inNb = nbFiles.filter((f) => re.test(nbSrc(f)));
  ok(name + ': not in index.html, in ' + (inNb.join(', ') || 'nothing'), !re.test(idx) && inNb.length === 1);
}

console.log('index.html as a host');
const tags = idx.match(/<script[^>]*Notebook\/notebook\.js[^>]*>/g) || [];
ok('loads notebook.js once', tags.length === 1, tags.join(' | '));
ok('...as a classic, blocking script', tags.length && !/\b(async|defer|type=)/.test(tags[0]), tags[0]);
const at = (s) => idx.indexOf(s);
const bjMount = at("Notebook.mount({ app: 'brainstorm', key: 'bj', store: 'journal' });");
const tjMount = at("Notebook.mount({ app: 'myjournal', key: 'tj', store: 'tony_journal' });");
ok('...before Brainstorm and MyJournal (they use JGuard, VizEngine and OJ while booting)',
  at('Notebook/notebook.js') > 0 && at('Notebook/notebook.js') < bjMount && bjMount < tjMount);
ok('each journal is mounted once, where its markup used to sit (Brainstorm, then MyJournal)',
  bjMount > 0 && tjMount > bjMount && (idx.match(/Notebook\.mount\(/g) || []).length === 2);
ok('the host\'s MyJournal nav (showTonyJournal, _tonyNav) is defined before MyJournal mounts (its rail wraps showTonyJournal)',
  at('window.showTonyJournal = function') > 0 && at('window.showTonyJournal = function') < tjMount && at('window._tonyNav = function') < tjMount
  && !nbFiles.some((f) => /window\.(hideTonyJournal|_tonyNav|_updateTonyNavActive|tjSwitchTo) = function/.test(nbSrc(f))));
ok('_pwReset stays the host\'s (the app lock uses it): defined once, in index.html',
  (idx.match(/window\._pwReset = /g) || []).length === 1 && !nbFiles.some((f) => /window\._pwReset = /.test(nbSrc(f))));
ok('the DOCX group loads after both journals, where its sheets used to be (cascade order)',
  at("Notebook.load('docx')") > tjMount && at("Notebook.load('docx')") < at('TaskHub Voice Control'));
ok('the rail\'s CSS is last in notebook.css (at 1100-1180px its --sidebar-w must win)',
  nbSrc('notebook.css').lastIndexOf('--sidebar-w') === nbSrc('notebook.css').indexOf('#tj-root { --sidebar-w: 300px; }') + 11);
for (const [k, src] of [['tj', nbSrc('apps/myjournal.js')], ['bj', nbSrc('apps/brainstorm.js')]]) {
  const m = src.match(new RegExp("Notebook\\.registerDocx\\('" + k + "', (\\{[\\s\\S]*?\\n\\})\\);"));
  let cfg = null; try { cfg = m && vm.runInNewContext('(' + m[1] + ')'); } catch (e) {}
  ok(k + ' registers its DOCX config, with the image binder it used to be hardcoded to',
    cfg && cfg.root === k + '-root' && cfg.bindImg === '_' + k + 'BindImg' && cfg.trashAPI === '_' + k + 'TrashAPI', m && m[1]);
}
ok('the image re-binder routes through the registry, not a hardcoded pair',
  /var bind = APPS\[app\] && window\[APPS\[app\]\.bindImg\];/.test(nbSrc('core/docx.js')) && !/_bjBindImg|_tjBindImg/.test(nbSrc('core/docx.js')));
const install = idx.match(/window\.Notebook\.fb\.install\(\{([\s\S]*?)\}\);/);
ok('Firebase init() installs the journal layer, with db as a live getter', install && /db: \(\) => db\b/.test(install[1]), install && install[1]);
const initStart = idx.indexOf('async function init() {');
ok('...from inside init() (re-installed on every re-init)', install && initStart > 0 && idx.indexOf(install[0]) > initStart);
const fbSrc = nbSrc('core/fb.js');
ok('fb.js only defines the accessors when installed', !/^window\._fb(Viz|OJ)\s*=/m.test(fbSrc) && /^function install\(F\) \{/m.test(fbSrc) && /^  install: function \(F\) \{\r?\n    install\(F\);/m.test(fbSrc));
ok('...and every Firestore call goes to the live db (no db captured at install)', !/doc\(db,/.test(fbSrc) && /const db = \(\) => _H\.db\(\);/.test(fbSrc));
const TD = (() => { const a = idx.indexOf('async function _teardown()'); return a < 0 ? '' : idx.slice(a, idx.indexOf('function _startIdleTimer', a)); })();
ok('the host\'s teardown drops the journal listeners and re-arms their guards',
  /window\.Notebook\.fb\.unsubscribe\(\);/.test(TD) && /window\.Notebook\.fb\.rearm\(\);/.test(TD)
  && /rearm: function \(\) \{\s*_bjServerSeen = false;\s*_tjServerSeen = false;/.test(fbSrc));

console.log('No journal code left in index.html (Notebook Phase 3 end state)');
// Code only: comments may still name the engines (the loader's comment does).
const idxCode = idx.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const [name, re] of [
  ['the journals\' remote-apply', /_(tj|bj)ApplyRemote\b/],
  ['the OurJournal engine', /window\.OJ\s*=/],
  ['VizEngine', /\bVizEngine\b/],
  ['JGuard', /\bJGuard\b/],
  ['the DOCX module', /_docxRebindImages|\.docx-sheet\b/],
  ['a journal Firestore path', /dashboards\/(journal|tony_journal)\b|['"](journal|tony_journal)_img_/],
  ['a journal stale-overwrite guard', /_(tj|bj)(ServerSeen|WhenServerSeen|MarkServerSeen)\b/],
  ['journal markup', /id="(tj|bj)-(root|sidebar|main|body)"/],
]) ok('index.html: no ' + name, !re.test(idxCode), (idxCode.match(re) || [])[0]);
// Style rules that name ONLY a journal root belong to the app's stylesheet. A
// rule listing several app roots (the hover glow, the fonts, the 2000px cap, the
// settings gear) is host config, like hoverfx's data-roots list.
const styles = (idx.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const journalOnly = (styles.match(/[^{}]+\{/g) || []).map((s) => s.slice(0, -1).trim())
  .filter((sel) => /#(tj|bj)-root\b/.test(sel) && !/#(root|veda-root|wr-root|tradeboard-root|cooking-view|tony-app-nav-inner)\b/.test(sel));
ok('index.html has no style rule for a journal root alone', journalOnly.length === 0, journalOnly.slice(0, 5).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
