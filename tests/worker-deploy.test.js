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
 * That was nearly the fate of index-backups, which is the off-device
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

function configFor(lane, name) {
  for (const f of CONFIG_NAMES) {
    const p = path.join(ROOT, lane, name, f);
    if (fs.existsSync(p)) return { file: f, text: fs.readFileSync(p, 'utf8') };
  }
  return null;
}

function lane(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => configFor(dir, n) !== null);
}

const workers = lane('workers');
const workers2 = lane('workers2');

section('Every deployable worker is wired into the deploy workflow');
t('found some workers to check', workers.length > 0);
workers.forEach((n) => {
  t(n + ' has a deploy job', WF.includes('workingDirectory: workers/' + n),
    'Add an output, a path filter and a deploy job in deploy-workers.yml, or it ' +
    'will never reach production and nothing will say so.');
  t(n + ' has a path filter', WF.includes("- 'workers/" + n + "/**'"),
    'Without a filter its job never triggers on a push that changes it.');
});

// The account-2 lane DISCOVERS its workers instead of enumerating them, so
// there is no per-worker wiring to check — but a worker there is only deployable
// if it pins its own wrangler, and getting that wrong fails opaquely rather than
// loudly (the runner falls back to its cached v3, which cannot read a v4 config).
section('Account-2 workers can actually be deployed by the workers2 lane');
workers2.forEach((n) => {
  const pkgPath = path.join(ROOT, 'workers2', n, 'package.json');
  t(n + ' has a package.json', fs.existsSync(pkgPath),
    'deploy-workers2.yml hard-errors without one.');
  if (fs.existsSync(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) {}
    const w = (pkg.devDependencies || {}).wrangler || (pkg.dependencies || {}).wrangler;
    t(n + ' pins wrangler v4', /^\^?4/.test(String(w || '')),
      'Found ' + JSON.stringify(w) + '. Without "wrangler": "^4.0.0" the deploy ' +
      'silently falls back to the runner\'s cached v3 and fails on a v4 config.');
  }
});

section('Each worker config is complete enough to deploy');
[['workers', workers], ['workers2', workers2]].forEach(([dir, names]) => {
  names.forEach((n) => {
    const { file, text } = configFor(dir, n);
    // Each check accepts both spellings: TOML `name = "x"` and JSON `"name": "x"`.
    t(n + ' names itself (' + file + ')', /^\s*name\s*=/m.test(text) || /"name"\s*:/.test(text));
    t(n + ' declares an entry point', /^\s*main\s*=/m.test(text) || /"main"\s*:/.test(text));

    // A KV binding with a placeholder id deploys and then fails at runtime, which
    // is the same silent-failure shape this file exists to prevent.
    // Both patterns require `id` to start the key, so `account_id` never matches.
    const ids = (text.match(/^\s*id\s*=\s*"([^"]*)"/gm) || [])
      .concat(text.match(/"id"\s*:\s*"([^"]*)"/g) || []);
    // workers2 is the exception, and only for the ONE placeholder form the lane
    // actually resolves: `kv:<TITLE>`, rewritten to a real id by
    // workers2/kv-provision.mjs before deploy. A namespace lives in a single
    // account, so a worker there cannot carry a literal account-1 id — and any
    // OTHER non-hex value is still a bug, which is why this stays narrow.
    const ok = (l) => /"[0-9a-f]{32}"/.test(l) ||
      (dir === 'workers2' && /"kv:[A-Za-z0-9_.-]+"/.test(l));
    const bad = ids.filter((l) => !ok(l));
    t(n + ' has no placeholder KV ids', bad.length === 0, bad.join(' | '));

    // Account 1 pins its id inline; account 2 gets it from CF_ACCOUNT_ID_2. A
    // stray account_id in workers2 would send the worker to the wrong account,
    // which deploys perfectly happily and is exactly the mistake this split
    // exists to prevent.
    if (dir === 'workers2') {
      t(n + ' does not pin an account_id', !/^\s*account_id\s*=/m.test(text) &&
        !/"account_id"\s*:/.test(text),
        'workers2 gets its account from CF_ACCOUNT_ID_2 — see workers2/README.md.');
    }
  });
});

// A directory with two configs is a trap: wrangler reads one and silently
// ignores the other, so an edit to the loser does nothing and reports nothing.
section('No worker has a second, ignored config file');
[['workers', workers], ['workers2', workers2]].forEach(([dir, names]) => {
  names.forEach((n) => {
    const present = CONFIG_NAMES.filter((f) => fs.existsSync(path.join(ROOT, dir, n, f)));
    t(n + ' has exactly one wrangler config', present.length === 1,
      present.length > 1
        ? 'Found ' + present.join(' + ') + '. wrangler reads ' + present[0] +
          ' and ignores the rest — delete the unused one before they drift apart.'
        : '');
  });
});

// The two lanes deploy to different Cloudflare accounts, so the same worker
// name in both is not a duplicate that merges — it is two live workers on two
// hostnames, one of them stale, with no error anywhere.
section('No worker name exists in both lanes');
const dupes = workers.filter((n) => workers2.includes(n));
t('workers/ and workers2/ do not overlap', dupes.length === 0,
  dupes.length ? 'In both: ' + dupes.join(', ') + '. A move must DELETE the old copy.' : '');

// ── The two ways a deploy dies silently ────────────────────────────────────
// Both of these actually happened, together, on 2026-09-11, and between them
// they kept EVERY workers/ deploy red from 06:16 onward. taskhub-reminders was
// the worker stuck, and it carries the suite's auth — app locks, password
// hints, reset codes — so a fix for recovery email sat in main, committed and
// undeployed, while reset codes went on not arriving.
section('Every output a deploy job reads is actually declared');
// deploy-studyos-ai gates on `needs.changes.outputs.studyosai`. The filter
// existed, the job existed, and the OUTPUT did not — so the expression
// resolved to empty string, the job skipped on every run since the day it was
// added, and studyos-ai was never deployed even once. Nothing reported it: a
// skipped job is green.
// Normalised: the workflow file is checked out CRLF on Windows (.gitattributes
// pins only *.sh and *.bat), and a \n-anchored pattern silently matches nothing
// there — which would have made this check pass by finding no outputs at all.
const WF_LF = WF.replace(/\r\n/g, '\n');
const changesBlock = (WF_LF.match(/outputs:\n([\s\S]*?)\n\s*steps:/) || [])[1] || '';
const declared = new Set(
  (changesBlock.match(/^\s*([A-Za-z0-9_]+):/gm) || [])
    .map((l) => l.trim().replace(':', '')));
const readOutputs = new Set(
  (WF_LF.match(/needs\.changes\.outputs\.([A-Za-z0-9_]+)/g) || [])
    .map((s) => s.split('.').pop()));
const undeclared = [...readOutputs].filter((o) => !declared.has(o));
t('no job gates on an undeclared output', undeclared.length === 0,
  undeclared.length
    ? 'Read but never declared on the changes job: ' + undeclared.join(', ') +
      '. The job silently never runs.'
    : '');

section('No worker binds to a worker that is not deployable');
// A service binding is resolved by Cloudflare AT DEPLOY TIME. Binding to a
// worker that does not exist on the account does not degrade — it makes
// `wrangler deploy` REJECT the worker doing the binding. That is how one
// unfinished feature (studyos-ai, whose KV namespace is deliberately still
// commented out) took the whole auth worker off the air.
//
// A config that is not ready to ship says so with the marker below, and this
// check makes that declaration binding on everyone else.
const NOT_DEPLOYABLE = /DO NOT DEPLOY/i;
const notReady = new Set();
[['workers', workers], ['workers2', workers2]].forEach(([dir, names]) => {
  names.forEach((n) => { if (NOT_DEPLOYABLE.test(configFor(dir, n).text)) notReady.add(n); });
});
[['workers', workers], ['workers2', workers2]].forEach(([dir, names]) => {
  names.forEach((n) => {
    const { text } = configFor(dir, n);
    // Uncommented lines only — a binding parked behind `#` is the documented
    // way to wait for the target, and must not be reported as live.
    const live = text.split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l));
    const targets = [];
    live.forEach((l) => {
      const m = l.match(/^\s*service\s*=\s*"([^"]+)"/) || l.match(/"service"\s*:\s*"([^"]+)"/);
      if (m) targets.push(m[1]);
    });
    targets.forEach((target) => {
      t(n + ' binds to ' + target + ', which is deployable', !notReady.has(target),
        target + "'s config is marked DO NOT DEPLOY, so it does not exist on the " +
        'account. Cloudflare resolves service bindings at deploy time, so this ' +
        'does not degrade — it fails ' + n + "'s deploy outright. Comment the " +
        'binding out until ' + target + ' ships.');
      t(n + ' binds to ' + target + ', which exists in the repo',
        workers.includes(target) || workers2.includes(target),
        'No worker directory named ' + target + ' in either lane.');
    });
  });
});

section('The backup worker specifically');
// workers2/, not workers/: it moved to the second Cloudflare account, being the
// fastest-growing KV writer on account 1.
const BW = path.join(ROOT, 'workers2', 'index-backups', 'worker.js');
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
      .includes("'workers2/index-backups/worker.js'"),
    'Otherwise the injected verifier goes stale silently.');

  // Snapshots have always been capped per device; the OBJECTS they point at
  // were not, so every document version ever captured accumulated forever and
  // storage only stopped growing at KV's 1 GB ceiling. GC is what bounds the
  // other half, and it is only safe because it fails closed.
  t('it collects orphaned objects',
    /async function collectOrphans\(/.test(src) && /A1_BACKUPS\.delete\('?o\/|delete\(k\.name\)/.test(src),
    'Without this, o/<hash> objects leak on every snapshot eviction.');
  t('GC refuses to act on an incomplete reference set',
    /if \(!snaps\.length\) return null;/.test(src) &&
    /if \(!parsed \|\| !Array\.isArray\(parsed\.objects\)\) return null;/.test(src),
    'An unreadable or object-list-less snapshot must abort the pass — under-counting ' +
    'what is live means deleting data that is still referenced.');
  t('GC never collects an in-flight upload',
    /GC_OBJECT_GRACE_MS/.test(src),
    'Objects are uploaded BEFORE the snapshot referencing them; without a grace ' +
    'period that window is indistinguishable from an orphan.');
  t('every KV listing follows its cursor',
    /async function listAll\(/.test(src) && !/A1_BACKUPS\.list\(\{/.test(src),
    'A truncated list under-reports what is reachable, which makes GC destructive.');
}

console.log('\n' + '─'.repeat(64));
if (fail) {
  console.log(fail + ' FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('All ' + pass + ' worker-deploy checks passed.');
