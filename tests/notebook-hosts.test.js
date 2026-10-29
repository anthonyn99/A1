#!/usr/bin/env node
// Every program that mounts Notebook (docs/Notebook/README.md, "What reaches
// which program"). One change to Notebook has to reach every one of them, so a
// host may only load, mount and configure it, through Notebook's API. This
// holds that for every host tools/notebook-stamp.js finds (A1, and A1-Priv
// when it is checked out next to this repo), new ones included:
//   - it loads notebook.js once, as a classic synchronous script (or data-lazy),
//     at the current stamp
//   - its mount call spells app, key and store out, so this test can read them
//   - an instance hands Notebook its Firestore (window.NotebookFirebase) and
//     has a store of its own
//   - it never reaches into the instance: no `#<key>-…` ids or classes (in
//     script or CSS), no `_<key>X` functions, no `<key>_…` storage keys, no
//     instance ready events. It uses Notebook.open / attach / detach / the
//     mount options instead. (Everwell once clicked Notebook's sidebar rows
//     and hid them with its own CSS; TradeHub moved #pb-root by hand. A rename
//     inside Notebook would have broken both, silently.)
// index.html is the native host of tj and bj and owns how they open inside
// TaskHub, so it is exempt from the last rule; tests/notebook-wiring.test.js
// covers it.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const stamp = require('../tools/notebook-stamp.js');
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

const NATIVE = { myjournal: 'tj', brainstorm: 'bj' };
const want = stamp.stamp();
const hosts = stamp.hosts();
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
ok('hosts are found (' + hosts.map(rel).join(', ') + ')', hosts.length > 0);

// The places a host names one of the instance's own things.
function reaches(src, K) {
  const pats = [
    { re: new RegExp('[\'"`#.]' + K + '-[a-z]', 'g'), what: 'an element of the instance (#' + K + '-…)' },
    { re: new RegExp('(^|[^A-Za-z0-9])_' + K + '[A-Z]\\w*', 'g'), what: 'a function of the instance (_' + K + '…)' },
    { re: new RegExp('[\'"`]' + K + '_[a-z]', 'g'), what: 'a storage key of the instance (' + K + '_…)' },
    { re: new RegExp('nb-' + K + '-fb-ready|_nb' + K.charAt(0).toUpperCase() + K.slice(1) + 'FbReady', 'g'), what: 'the instance\'s ready signal' },
  ];
  // The mount call's own store name is the host's to choose (it often starts
  // with the key), not a reach into the instance.
  const lines = src.replace(/store\s*:\s*(['"])[a-z0-9_]+\1/g, "store: ''").split('\n'), out = [];
  pats.forEach((p) => lines.forEach((l, i) => {
    p.re.lastIndex = 0;
    if (p.re.test(l)) out.push('line ' + (i + 1) + ': ' + p.what + ': ' + l.trim().slice(0, 120));
  }));
  return out;
}

// The scripts a host loads from its own folder (a relative src that exists).
function localScripts(f) {
  const src = fs.readFileSync(f, 'utf8'), out = [];
  for (const m of src.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
    const u = m[1].split(/[?#]/)[0];
    if (/^([a-z]+:)?\/\//i.test(u) || u.startsWith('/')) continue;
    const p = path.resolve(path.dirname(f), u);
    // Notebook's own files are Notebook's (a fixture loads it by a relative path).
    if (p.indexOf(path.join(ROOT, 'Notebook') + path.sep) === 0) continue;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p);
  }
  return out;
}

for (const f of hosts) {
  const src = fs.readFileSync(f, 'utf8'), name = rel(f);
  console.log('\n' + name);
  const tags = src.match(/<script\b[^>]*\bsrc="[^"]*Notebook\/notebook\.js[^"]*"[^>]*>/g) || [];
  ok('loads notebook.js exactly once', tags.length === 1, tags.length + ' tags');
  const tag = tags[0] || '';
  ok('...as a classic, synchronous script (data-lazy allowed)', !/\b(async|defer)\b|type="module"/.test(tag), tag);
  ok('...at the current stamp (' + want + ')', tag.includes('notebook.js?v=' + want + '"'), tag);

  const mounts = [...src.matchAll(/app\s*:\s*['"](myjournal|brainstorm)['"]\s*,\s*key\s*:\s*['"]([a-z]{2,8})['"]\s*,\s*store\s*:\s*['"]([a-z0-9_]+)['"]/g)]
    .map((m) => ({ app: m[1], key: m[2], store: m[3] }));
  // The profile form: { profile: 'tony' | 'veda' } for a side itself, plus key and store for an instance.
  const SIDE = { tony: { app: 'myjournal', key: 'tj', store: 'tony_journal' }, veda: { app: 'brainstorm', key: 'bj', store: 'journal' } };
  for (const m of src.matchAll(/Notebook\.mount\(\{\s*profile\s*:\s*['"](tony|veda)['"]\s*\}/g)) mounts.push(SIDE[m[1]]);
  for (const m of src.matchAll(/profile\s*:\s*['"](tony|veda)['"]\s*,\s*key\s*:\s*['"]([a-z]{2,8})['"]\s*,\s*store\s*:\s*['"]([a-z0-9_]+)['"]/g))
    mounts.push({ app: SIDE[m[1]].app, key: m[2], store: m[3] });
  ok('its mount call names a profile (or spells out app, key and store, in that order)', mounts.length > 0,
    'write Notebook.mount({ profile: \'tony\', key: \'xx\', store: \'xx_store\', ... })');
  const instances = mounts.filter((m) => NATIVE[m.app] !== m.key);
  if (!instances.length) { ok('a native host (tj/bj) only; index.html\'s own rules apply', name === 'index.html', name); continue; }
  ok('it hands Notebook its Firestore (window.NotebookFirebase = ...)', /window\.NotebookFirebase\s*=/.test(src));
  for (const m of instances) {
    ok(m.key + ': mounts one of the two sides (Tony\'s myjournal or Veda\'s brainstorm)', m.app === 'myjournal' || m.app === 'brainstorm', m.app);
    ok(m.key + ': has a store of its own (' + m.store + ')', m.store !== 'tony_journal' && m.store !== 'journal');
    const bad = reaches(src, m.key);
    ok(m.key + ': never reaches into the instance (Notebook.open / attach / detach / mount options instead)', !bad.length, '\n       ' + bad.join('\n       '));
    // The host's own scripts beside it (StudyOS keeps its Notebook glue in
    // js/sos-notebook.js): the same rule, file by file.
    for (const own of localScripts(f)) {
      const b2 = reaches(fs.readFileSync(own, 'utf8'), m.key);
      ok(m.key + ': ' + rel(own) + ' never reaches into the instance either', !b2.length, '\n       ' + b2.join('\n       '));
    }
  }
}

console.log('\nThe guard itself');
// A host that does what Everwell and TradeHub used to must fail.
const BAD = [
  "document.querySelector('#ewn-entries-list .entry-item').click();",
  "$('ewn-btn-edit');",
  '#ew-nb-host #ewn-sidebar{display:none}',
  'window._ewnTrashAPI.purge([]);',
  "localStorage.getItem('ewn_unlocked_x');",
  "window.addEventListener('nb-ewn-fb-ready', f);",
  "document.getElementById('pb-root')"].join('\n');
ok('it catches an element, a function, a storage key and the ready signal', reaches(BAD, 'ewn').length === 6, JSON.stringify(reaches(BAD, 'ewn')));
ok('...and #pb-root moved by hand', reaches(BAD, 'pb').length === 1);
const GOOD = `Notebook.mount({ app: 'myjournal', key: 'ewn', store: 'ewn_notes' }); Notebook.open('ewn', id, { edit: true });
  Notebook.attach('pb', host); .tb-pb-host{} document.getElementById('tb-pb-root'); ew-nb-host`;
ok('...and lets the API, the mount call and look-alike names through', reaches(GOOD, 'ewn').length === 0 && reaches(GOOD, 'pb').length === 0,
  JSON.stringify(reaches(GOOD, 'ewn').concat(reaches(GOOD, 'pb'))));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
