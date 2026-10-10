// Guards Guardian — the ONE lock system (Guardian/guardian.js) every A1
// program calls instead of carrying its own (docs/Guardian/README.md).
//
// Ways this rots without anything erroring:
//
//  1. A program grows its own lock again: an inline overlay, a `window.Bio`
//     helper, a `_mailRelay`/`_pwReset` copy, or direct calls to the worker's
//     password routes. Every program (and every new one) is scanned for those.
//  2. A host pins a version (guardian.js?v=…) or keeps a local copy — then
//     upgrading Guardian no longer reaches it. Hosts must load the one live
//     file: "Guardian/guardian.js" in A1, the absolute Pages URL elsewhere.
//  3. The folder sprawls. Guardian is one file.
//
// PENDING lists programs whose old lock has not moved to Guardian yet. It only
// ever shrinks; when it is empty the migration is finished, and the scan then
// covers every page in both repos with no exceptions.
//
// Run: node tests/guardian-wiring.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./moved');

const ROOT = M.ROOT;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

// Programs on Guardian. A host lists the scripts (besides its .html) that make
// up its lock surface, so the scan covers code that lives outside the page.
const HOSTS = {
};
// Not migrated yet (shrinks phase by phase; must end empty).
const PENDING = [
  'index.html', 'shield.html', 'Notebook/apps/myjournal.js', 'Notebook/apps/brainstorm.js',
  'mylist.html', 'oneinbox.html', 'magi.html',
  'tradehub.html', 'insight.html', 'vault.html', 'riftiq.html', 'solace.html',
];
// Never touched by Guardian (user decision 2026-10-10): StudyOS keeps its own
// backend (V1/ is Veda's StudyOS world), and Vault/'s WebAuthn is the vault
// MASTER-password encryption (a PRF-derived key), not a lock.
const EXEMPT = /^(?:V1|Vault)[\\/]/;

console.log('\nThe folder');
const G = 'Guardian/guardian.js';
ok('Guardian/guardian.js exists', fs.existsSync(path.join(ROOT, G)));
const src = fs.readFileSync(path.join(ROOT, G), 'utf8');
let parsed = true; try { new vm.Script(src, { filename: G }); } catch (e) { parsed = false; }
ok('guardian.js parses', parsed);
ok('it is the only file in Guardian/', fs.readdirSync(path.join(ROOT, 'Guardian')).join() === 'guardian.js', fs.readdirSync(path.join(ROOT, 'Guardian')));
ok('its README lives in docs/Guardian/', fs.existsSync(path.join(ROOT, 'docs', 'Guardian', 'README.md')));

// Signs of a hand-built lock. Each is something only Guardian may contain.
const OWN_LOCK = [
  [/window\.Bio\s*=/, 'its own window.Bio helper'],
  [/_mailRelay\s*=/, 'its own _mailRelay'],
  [/_pwReset\s*=/, 'its own _pwReset'],
  [/\/auth\/journal\/(?:verify|set-lock|remove-lock|hint)\b/, 'direct calls to the worker password routes'],
  [/\/auth\/reset\/(?:request|confirm)\b/, 'its own reset-code flow'],
  [/navigator\.credentials\.(?:create|get)\s*\(/, 'its own WebAuthn calls'],
  [/id=["'](?:applock-overlay|lockScreen|lock-overlay|tj-lock-overlay|bj-lock-overlay)["']/, 'its own lock overlay'],
];
const tagRe = new RegExp('<script\\b[^>]*\\bsrc=["\']' + M.src('Guardian/guardian.js') + '([^"\']*)["\'][^>]*>', 'g');

console.log('\nEvery Guardian host loads the one live file and has no lock of its own');
for (const [file, extra] of Object.entries(HOSTS)) {
  if (M.isMoved(file) && !M.has(file)) { M.skipNote(file); continue; }
  const html = M.read(file);
  const tags = [...html.matchAll(tagRe)];
  ok(file + ' loads Guardian exactly once', tags.length === 1, tags.length);
  ok(file + ' loads it unpinned (no ?v=, so upgrades reach it)', tags[0] && tags[0][1] === '', tags[0] && tags[0][1]);
  ok(file + ' loads it before first paint (not defer/async)', tags[0] && !/\b(?:defer|async)\b/.test(tags[0][0]), tags[0] && tags[0][0]);
  for (const f of [file].concat(extra || [])) {
    const text = f === file ? html : M.read(f);
    for (const [re, what] of OWN_LOCK) ok(f + ' has no ' + what, !re.test(text), (text.match(re) || [])[0]);
  }
}

console.log('\nNo page anywhere builds a lock outside Guardian');
function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/^(?:node_modules|\.git|tests|workers2?|Index Backups|desktop|magi|tools|docs|\.claude|\.deploy)$/.test(e.name)) continue;
    const p = path.join(dir, e.name), rel = path.relative(base, p).replace(/\\/g, '/');
    if (e.isDirectory()) { if (!e.isSymbolicLink()) walk(p, base, out); }
    else if (/\.(?:html|js)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const scan = walk(ROOT, ROOT, []).filter((f) => !f.startsWith('Guardian/') && !EXEMPT.test(f));
if (fs.existsSync(M.PRIV)) walk(M.PRIV, M.PRIV, []).forEach((f) => { if (!scan.includes(f) && !EXEMPT.test(f)) scan.push(f); });
const offenders = [];
for (const f of scan) {
  if (PENDING.includes(f) || HOSTS[f] !== undefined) continue;
  let text; try { text = M.has(f) ? M.read(f) : fs.readFileSync(path.join(fs.existsSync(path.join(ROOT, f)) ? ROOT : M.PRIV, f), 'utf8'); } catch (e) { continue; }
  if (/^<!doctype html>[\s\S]{0,2000}location\.replace\(/i.test(text) && text.length < 4000) continue;   // redirect stubs
  const hit = OWN_LOCK.find(([re]) => re.test(text));
  if (hit) offenders.push(f + ' (' + hit[1] + ')');
}
ok('no unlisted page carries its own lock', offenders.length === 0, offenders.join(', '));
console.log('  · ' + PENDING.length + ' program(s) still pending migration' + (PENDING.length ? ': ' + PENDING.join(', ') : ' — done'));

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
