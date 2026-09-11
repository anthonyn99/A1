#!/usr/bin/env node
/**
 * Copy workers/_shared/appcheck.js into each Worker that needs it.
 *
 * Cloudflare Workers each deploy as a self-contained bundle, and these are
 * plain single-file workers with no build step — so the verifier has to be
 * physically present in each one. Rather than let five copies drift apart
 * (which is how one of them ends up with a weaker check than the others),
 * there is ONE canonical copy and this script writes it into the marked block.
 *
 * Edit workers/_shared/appcheck.js, run this, redeploy.
 *
 * Run: node tools/sync-appcheck.js         (write)
 *      node tools/sync-appcheck.js --check (verify in sync; exit 1 if not)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'workers', '_shared', 'appcheck.js');
const BEGIN = '// ─── BEGIN GENERATED: appcheck (workers/_shared/appcheck.js) ───';
const END = '// ─── END GENERATED: appcheck ───';

// Repo-root-relative, because these workers no longer all live under workers/.
// trade-dashboard and index-backups moved to the account-2 lane (workers2/) to
// split the Cloudflare free-tier KV write budget across two accounts; App Check
// is unaffected by that — it verifies a Firebase project token against a public
// JWKS and never touches Cloudflare — but the PATHS had to follow them.
//
// A wrong path here does not fail: the loop below prints "skip (missing)" and
// carries on, leaving that worker's verifier frozen at whatever it last had.
// tests/worker-deploy.test.js asserts each of these files exists for that
// reason — treat a skip as a bug, not as a valid state.
const TARGETS = [
  'workers/tradeboard-api/src/worker.js',
  'workers/newshub-api/worker.js',
  'workers/tesla-api/worker.js',
  'workers/studyos-ai/worker.js',
  'workers2/trade-dashboard/worker.js',
  'workers2/index-backups/worker.js',
];

const body = fs.readFileSync(SRC, 'utf8').trim();
const block = `${BEGIN}\n// Do not edit here — edit the canonical copy and run tools/sync-appcheck.js\n${body}\n${END}`;
const checkOnly = process.argv.includes('--check');

let changed = 0, stale = [];
for (const rel of TARGETS) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log('  skip (missing) ' + rel); continue; }
  let s = fs.readFileSync(p, 'utf8');

  // core.autocrlf is true on the Windows checkout, so a file git has touched
  // (a stash, a branch switch) comes back CRLF while one written by an editor
  // stays LF — in the same tree, for the same worker. Comparing raw bytes then
  // reports "stale" for a block that is character-for-character identical, and
  // a check that cries wolf is a check nobody reads when it is finally right.
  // Compare on normalised text; write in whatever the file already uses.
  const eol = /\r\n/.test(s) ? '\r\n' : '\n';
  const asFile = (t) => t.replace(/\r?\n/g, eol);
  const same = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

  const i = s.indexOf(BEGIN), j = s.indexOf(END);
  let next;
  if (i >= 0 && j > i) {
    const cur = s.slice(i, j + END.length);
    if (same(cur, block)) { console.log('  in sync       ' + rel); continue; }
    next = s.slice(0, i) + asFile(block) + s.slice(j + END.length);
    stale.push(rel);
  } else {
    // First insertion: after the file's leading comment/import preamble, before
    // any code that might reference it.
    const m = s.match(/^(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n|\s*\n|import [^\n]*\n)*/);
    const at = m ? m[0].length : 0;
    next = s.slice(0, at) + eol + asFile(block) + eol + s.slice(at);
    stale.push(rel);
  }
  if (checkOnly) { console.log('  STALE         ' + rel); continue; }
  fs.writeFileSync(p, next);
  console.log('  written       ' + rel);
  changed++;
}

if (checkOnly && stale.length) {
  console.error('\n' + stale.length + ' worker(s) out of sync with ' + path.relative(ROOT, SRC));
  console.error('Run: node tools/sync-appcheck.js');
  process.exit(1);
}
console.log('\n' + (checkOnly ? 'all workers in sync.' : changed + ' worker(s) updated.'));
