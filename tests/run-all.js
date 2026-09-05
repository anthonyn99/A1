#!/usr/bin/env node
/**
 * Runs the whole test suite.
 *
 * WHY THIS FILE EXISTS
 * `npm test` used to be a hand-written `&&` chain naming all 21 test files.
 * Adding a test file to tests/ did not add it to that chain, so the test simply
 * never ran — it sat in the repo looking like coverage while guarding nothing.
 * Two files were in exactly that state when this runner was written:
 * appcheck-verify.test.js (the App Check forgery suite) and sos-ack.test.js
 * (the StudyOS/TaskHub done-state regression). Both passed; neither had run in
 * CI since the day it was committed.
 *
 * So the list is no longer written by hand. Every tests/*.test.js is discovered
 * and run. A new test file is picked up by existing there, which is the only
 * behaviour that cannot silently regress.
 *
 * Unlike the old `&&` chain this does NOT stop at the first failure — it runs
 * everything and prints one summary, so a red run tells you all of what broke
 * rather than only the earliest thing.
 *
 * Run: npm test   (or: node tests/run-all.js)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;

// syntax-check.js parses the single-file apps. It runs first because when a
// root .html is broken every downstream suite fails in a confusing way, and the
// parse error is the one message worth reading.
const FIRST = 'syntax-check.js';

const files = [
  ...(fs.existsSync(path.join(DIR, FIRST)) ? [FIRST] : []),
  ...fs.readdirSync(DIR).filter((f) => f.endsWith('.test.js')).sort(),
];

const failed = [];
for (const f of files) {
  process.stdout.write(`\n\u001b[1m── ${f}\u001b[0m\n`);
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { stdio: 'inherit' });
  const code = r.status === null ? 1 : r.status;
  if (code !== 0) failed.push(`${f} (exit ${code})`);
}

console.log('\n' + '='.repeat(64));
if (failed.length) {
  console.log(`FAILED — ${failed.length} of ${files.length} suites:`);
  failed.forEach((f) => console.log('  ✗ ' + f));
  process.exitCode = 1;
} else {
  console.log(`All ${files.length} suites passed.`);
}
