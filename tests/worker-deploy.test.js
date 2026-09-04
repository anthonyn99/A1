#!/usr/bin/env node
/**
 * Every worker that can be deployed IS deployed.
 *
 * WHY THIS FILE EXISTS
 * `.github/workflows/deploy-workers.yml` does not discover worker folders — it
 * has an explicit entry per worker: an output, a path filter, and a deploy job.
 * A new worker directory is therefore committed, pushed, and never deployed,
 * with no error anywhere. It simply does not exist in production while looking
 * completely fine in the repo.
 *
 * That was nearly the fate of workers/index-backups, which is the off-device
 * half of the backup system: it would have been pushed, appeared to be part of
 * the suite, and quietly never received a single byte.
 *
 * Run: node tests/worker-deploy.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  ✗ ' + name); }
}
function section(s) { console.log('\n' + s); }

const ROOT = path.join(__dirname, '..');
const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-workers.yml'), 'utf8');

// A worker is "deployable" if it has a wrangler config in ANY of wrangler's
// supported formats — not just TOML. Matching only wrangler.toml meant a
// .jsonc-configured worker (warroom-api is one) was invisible here: it would
// vanish from every check below while the suite still reported all green,
// which is precisely the silent gap this file exists to close.
//
// Order matters and mirrors wrangler's own precedence, confirmed by running
// `wrangler deploy --dry-run` in workers/warroom-api with both files present:
// it reported configFileType "jsonc". So when a directory has more than one,
// the FIRST entry here is the one wrangler actually reads, and the one this
// test must inspect — checking the ignored file would be worse than useless.
const CONFIG_NAMES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

function configFor(name) {
  for (const f of CONFIG_NAMES) {
    const p = path.join(ROOT, 'workers', name, f);
    if (fs.existsSync(p)) return { file: f, text: fs.readFileSync(p, 'utf8') };
  }
  return null;
}

const workers = fs.readdirSync(path.join(ROOT, 'workers'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => configFor(n) !== null);

section('Every deployable worker is wired into the deploy workflow');
t('found some workers to check', workers.length > 0);
workers.forEach((n) => {
  t(n + ' has a deploy job', WF.includes('workingDirectory: workers/' + n),
    'Add an output, a path filter and a deploy job in deploy-workers.yml, or it ' +
    'will never reach production and nothing will say so.');
  t(n + ' has a path filter', WF.includes("- 'workers/" + n + "/**'"),
    'Without a filter its job never triggers on a push that changes it.');
});

section('Each worker config is complete enough to deploy');
workers.forEach((n) => {
  const { file, text } = configFor(n);
  // Each check accepts both spellings: TOML `name = "x"` and JSON `"name": "x"`.
  t(n + ' names itself (' + file + ')', /^\s*name\s*=/m.test(text) || /"name"\s*:/.test(text));
  t(n + ' declares an entry point', /^\s*main\s*=/m.test(text) || /"main"\s*:/.test(text));
  // A KV binding with a placeholder id deploys and then fails at runtime, which
  // is the same silent-failure shape this file exists to prevent.
  // Both patterns require `id` to start the key, so `account_id` never matches.
  const ids = (text.match(/^\s*id\s*=\s*"([^"]*)"/gm) || [])
    .concat(text.match(/"id"\s*:\s*"([^"]*)"/g) || []);
  const bad = ids.filter((l) => !/"[0-9a-f]{32}"/.test(l));
  t(n + ' has no placeholder KV ids', bad.length === 0, bad.join(' | '));
});

// A directory with two configs is a trap: wrangler reads one and silently
// ignores the other, so an edit to the loser does nothing and reports nothing.
section('No worker has a second, ignored config file');
workers.forEach((n) => {
  const present = CONFIG_NAMES.filter((f) => fs.existsSync(path.join(ROOT, 'workers', n, f)));
  t(n + ' has exactly one wrangler config', present.length === 1,
    present.length > 1
      ? 'Found ' + present.join(' + ') + '. wrangler reads ' + present[0] +
        ' and ignores the rest — delete the unused one before they drift apart.'
      : '');
});

section('The backup worker specifically');
const BW = path.join(ROOT, 'workers', 'index-backups', 'worker.js');
t('index-backups worker exists', fs.existsSync(BW));
if (fs.existsSync(BW)) {
  const src = fs.readFileSync(BW, 'utf8');
  t('it requires App Check on every route past /health',
    /const denied = await requireAppCheck\(request, c\);/.test(src) &&
    /if \(denied\) return denied;/.test(src));
  t('it refuses anything that is not an encrypted envelope',
    /error: 'not-encrypted'/.test(src),
    'The worker must never become a place plaintext can land by accident.');
  t('it bounds its own storage',
    /const KEEP_SNAPSHOTS = \d+;/.test(src) && /A1_BACKUPS\.delete\(/.test(src));
  t('retention never deletes the newest snapshot',
    /const excess = stamps\.length - KEEP_SNAPSHOTS;/.test(src) &&
    /for \(let i = 0; i < excess; i\+\+\)/.test(src),
    'Sorted oldest-first and only beyond the keep count.');
  t('it restricts CORS to the app origin',
    /https:\/\/anthonyn99\.github\.io/.test(src) && /ALLOWED_ORIGINS/.test(src));
  t('key names from the client are validated',
    /const safeName = /.test(src),
    'Unvalidated names let a request walk out of its own prefix.');
  t('it is registered in the App Check sync targets',
    fs.readFileSync(path.join(ROOT, 'tools', 'sync-appcheck.js'), 'utf8')
      .includes("'index-backups/worker.js'"),
    'Otherwise the injected verifier goes stale silently.');
}

console.log('\n' + '─'.repeat(64));
if (fail) {
  console.log(fail + ' FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('All ' + pass + ' worker-deploy checks passed.');
