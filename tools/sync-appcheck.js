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

const TARGETS = ['tradeboard-api/src/worker.js', 'trade-dashboard/worker.js', 'newshub-api/worker.js', 'tesla-api/worker.js'];

const body = fs.readFileSync(SRC, 'utf8').trim();
const block = `${BEGIN}\n// Do not edit here — edit the canonical copy and run tools/sync-appcheck.js\n${body}\n${END}`;
const checkOnly = process.argv.includes('--check');

let changed = 0, stale = [];
for (const rel of TARGETS) {
  const p = path.join(ROOT, 'workers', rel);
  if (!fs.existsSync(p)) { console.log('  skip (missing) ' + rel); continue; }
  let s = fs.readFileSync(p, 'utf8');
  const i = s.indexOf(BEGIN), j = s.indexOf(END);
  let next;
  if (i >= 0 && j > i) {
    const cur = s.slice(i, j + END.length);
    if (cur === block) { console.log('  in sync       ' + rel); continue; }
    next = s.slice(0, i) + block + s.slice(j + END.length);
    stale.push(rel);
  } else {
    // First insertion: after the file's leading comment/import preamble, before
    // any code that might reference it.
    const m = s.match(/^(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n|\s*\n|import [^\n]*\n)*/);
    const at = m ? m[0].length : 0;
    next = s.slice(0, at) + '\n' + block + '\n' + s.slice(at);
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
