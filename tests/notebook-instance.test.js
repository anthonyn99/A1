// Notebook instances (docs/Notebook/README.md): MyJournal mounted under another
// key/store is its own source rewritten (Notebook._rewrite / _rewriteApp), with a
// Firestore layer built from core/fb.js's @nb-store template (_storeSource).
// This checks the rewrite on the real sources: it parses, nothing of tj's
// survives (ids, functions, store paths, title), and the store layer can only
// ever touch the instance's own documents.
//
// Run: node tests/notebook-instance.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
const NB = path.join(__dirname, '..', 'Notebook');
const rd = (f) => fs.readFileSync(path.join(NB, f), 'utf8').replace(/\r\n/g, '\n');

// notebook.js in a sandbox (after parsing: it appends instead of writing).
const win = { document: { readyState: 'complete', currentScript: { src: 'https://x/A1/Notebook/notebook.js?v=s' },
  createElement: () => ({}), head: { appendChild: () => {} } } };
win.window = win;
vm.runInNewContext(rd('notebook.js'), win);
const N = win.Notebook;
const cfg = { key: 'pb', store: 'tradehub_playbook', title: 'Playbook' };

const parses = (code) => { try { new vm.Script(code); return true; } catch (e) { return e.message; } };
const TJ_LEFT = /(^|[^A-Za-z])tj(?![a-z])|tony_journal|TonyJournal|myjournal_ai|(^|[^A-Z])TJ(?![a-z])/;
const leftover = (s) => { const m = s.match(TJ_LEFT); if (!m) return ''; const i = s.indexOf(m[0]); return s.slice(Math.max(0, i - 40), i + 40); };

console.log('\nThe app, rewritten to pb');
const app = N._rewriteApp(rd('apps/myjournal.js'), cfg);
ok('it parses', parses(app) === true, parses(app));
ok('nothing of tj survives', !TJ_LEFT.test(app), leftover(app));
ok('its markup is pb\'s', /<div id="pb-root">/.test(app) && /id="pb-entries-list"/.test(app));
ok('it stores locally under the store\'s name', /const STORAGE_KEY = 'tradehub_playbook_v3';/.test(app));
ok('it reads its own mount config', /window\.Notebook\.mounts\.pb\b/.test(app));
ok('its locks are its own namespace', /journal: 'pb'/.test(app));
ok('it waits for its own Firestore, not the host\'s fb-ready', /'nb-pb-fb-ready'/.test(app) && !/'fb-ready'/.test(app) && !/window\._fbReady\b/.test(app));
ok('nothing waits for a DOMContentLoaded that has passed', !/addEventListener\('DOMContentLoaded'/.test(app.replace(/if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded'/g, '')));
ok('it registers its DOCX config as pb, on Tony\'s side', /Notebook\.registerDocx\('pb', \{\n  root: 'pb-root'/.test(app) && /name: 'Playbook', side: 'tony'/.test(app));

console.log('\nIts stylesheet');
const css = N._rewrite(rd('apps/myjournal.css'), cfg);
ok('every #tj-root rule is #pb-root\'s', !TJ_LEFT.test(css) && /#pb-root/.test(css), leftover(css));
const shell = N._rewrite(N._tjRules(rd('notebook.css')), cfg);
ok('the shell/DOCX rules notebook.css has for #tj-root come along as #pb-root\'s', /#pb-root \.docx-trash-btn/.test(shell) && !TJ_LEFT.test(shell), leftover(shell));
ok('...and only those: no unscoped rule is repeated over the host\'s styles',
  shell.split('}').filter((r) => r.includes('{') && !/^\s*@/.test(r)).every((r) => /#pb-root|pb-/.test(r.split('{')[0]) || /^\s*$/.test(r.split('{')[0]) || /@media/.test(r)));
ok('...balanced braces', (shell.match(/\{/g) || []).length === (shell.match(/\}/g) || []).length);

console.log('\nIts Firestore layer');
const store = N._rewrite(N._storeSource(rd('core/fb.js'), cfg), cfg);
ok('it parses as one expression', parses('(' + store + ')') === true, parses('(' + store + ')'));
ok('nothing of tj survives', !TJ_LEFT.test(store), leftover(store));
ok('its document is dashboards/tradehub_playbook', /"dashboards\/tradehub_playbook"/.test(store));
ok('it never names another journal\'s documents', !/dashboards\/journal\b|'journal_ai|'journal_img_|bj-fbimg|_bj[A-Z]/.test(store));
const st = vm.runInNewContext(store, { window: {}, console });
ok('it gives install / unsubscribe / rearm / serverSeen', ['install', 'unsubscribe', 'rearm', 'serverSeen'].every((k) => typeof st[k] === 'function'));
ok('...and starts not having seen the server', st.serverSeen() === false);
ok('its loaders are pb\'s', /window\._fbLoadPbJournal = /.test(store) && /window\._fbSavePBTools = /.test(store));

console.log('\nMounting');
let threw = 0;
for (const bad of [{ app: 'myjournal', key: 'pb' }, { app: 'myjournal', key: 'pb', store: 'tony_journal' },
  { app: 'brainstorm', key: 'pb', store: 'x' }, { app: 'myjournal', key: 'P-B', store: 'x' }]) {
  try { N.mount(bad); } catch (e) { threw++; }
}
ok('an instance needs its own store, a valid key, and myjournal', threw === 4, threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
