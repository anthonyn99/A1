/* Every worker URL in the client points at the account that worker lives on.

   WHY THIS FILE EXISTS
   The suite is split across two Cloudflare accounts to stay inside the free
   tier's per-account KV write limit: workers/ deploys to av1.workers.dev,
   workers2/ to av1-2.workers.dev. The FOLDER decides the hostname, so moving a
   worker between them renames it in production -- and every reference in the
   client has to move with it.

   Missing one is silent in both directions:
     - A stale URL reaches a worker that no longer exists (404) or, worse, one
       that still exists and serves a FROZEN copy of the data. That is not an
       error anywhere; it is stale numbers that look real.
     - The App Check interceptor in tradehub.html gates on a HOSTNAME pattern.
       When trade-dashboard moved to av1-2, the pattern still said `av1`, so the
       token silently stopped being attached: every request still went out and
       every one came back 401. The watchlist and Catalysts stopped working with
       nothing in the page saying why. That is what this test now prevents.

   Run: node tests/worker-url-wiring.test.js */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0; const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function section(s) { console.log('\n' + s); }

/* ── Which worker lives where, read from the configs themselves ──────────── */
const CONFIGS = ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'];
function scriptNames(lane) {
  const dir = path.join(ROOT, lane);
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const cfg = CONFIGS.map((f) => path.join(dir, d.name, f)).find((p) => fs.existsSync(p));
    if (!cfg) continue;
    const text = fs.readFileSync(cfg, 'utf8');
    // The deployed NAME, which is not always the directory name
    // (workers/tesla-api deploys as "taskhub-tesla-api").
    const m = text.match(/^\s*name\s*=\s*"([^"]+)"/m) || text.match(/"name"\s*:\s*"([^"]+)"/);
    if (m) out[m[1]] = d.name;
  }
  return out;
}
const ACCT1 = scriptNames('workers');    // -> av1.workers.dev
const ACCT2 = scriptNames('workers2');   // -> av1-2.workers.dev

section('Both lanes were discovered');
t('workers/ has workers', Object.keys(ACCT1).length > 0, Object.keys(ACCT1).length + ' found');
t('workers2/ has workers', Object.keys(ACCT2).length > 0, Object.keys(ACCT2).length + ' found');

/* ── Every client reference points at the right account ──────────────────── */
// Client-side files only. The workers' own configs legitimately name their own
// hostname, and docs are prose.
const CLIENT = ['index.html', 'tradehub.html', 'riftiq.html', 'vault.html', 'insight.html',
  'mylist.html', 'oneinbox.html', 'shield.html', 'solace.html', 'wellness.html',
  'backup.js', 'firebase-messaging-sw.js',
  'Vault/background.js', 'Vault/manifest.json', 'V1/Launcher/background.js',
  'V1/Launcher/manifest.json', 'trading-auto-launch/launch.py', 'tools/pull-backups.mjs'];

const URL_RE = /https:\/\/([a-z0-9-]+)\.(av1(?:-\d+)?)\.workers\.dev/g;

section('Every worker URL in the client matches the account that worker is on');
let refs = 0;
for (const rel of CLIENT) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, 'utf8');
  const seen = new Set();
  let m;
  while ((m = URL_RE.exec(text))) seen.add(m[1] + '|' + m[2]);
  for (const entry of seen) {
    const [name, sub] = entry.split('|');
    refs++;
    // Veda's account is a third lane with its own subdomain and is not checked
    // here; these two are the ones this repo's own folders decide.
    const onA1 = Object.prototype.hasOwnProperty.call(ACCT1, name);
    const onA2 = Object.prototype.hasOwnProperty.call(ACCT2, name);
    if (!onA1 && !onA2) {
      t(rel + ' -> ' + name, false,
        'No worker by that name in workers/ or workers2/. Either the URL is stale ' +
        'or the worker was deleted — a stale URL 404s, or silently reads a frozen copy.');
      continue;
    }
    const expect = onA2 ? 'av1-2' : 'av1';
    t(rel + ' -> ' + name + ' @ ' + sub, sub === expect,
      'Lives in ' + (onA2 ? 'workers2/' : 'workers/') + ', so it serves ' + expect +
      '.workers.dev — this reference says ' + sub + '.');
  }
}
t('found references to check', refs > 0, refs + ' reference(s)');

/* ── The App Check gate must cover its workers at their CURRENT hostname ─── */
section('The App Check interceptor gates the workers it names');
{
  const th = fs.readFileSync(path.join(ROOT, 'tradehub.html'), 'utf8');
  const m = th.match(/const _AC_GATED = (\/[^\n]+\/);/);
  t('the gate regex was found', !!m);
  if (m) {
    // eslint-disable-next-line no-eval
    const re = eval(m[1]);
    const named = (m[1].match(/\(([a-z0-9-]+(?:\|[a-z0-9-]+)*)\)/) || [])[1];
    const workers = named ? named.split('|') : [];
    t('it names some workers', workers.length > 0, workers.join(', '));
    for (const w of workers) {
      const sub = Object.prototype.hasOwnProperty.call(ACCT2, w) ? 'av1-2' : 'av1';
      const url = 'https://' + w + '.' + sub + '.workers.dev/anything';
      t(w + ' is gated at its real host (' + sub + ')', re.test(url),
        'The token silently stops being attached and every request comes back 401, ' +
        'with nothing in the page reporting it.');
    }
    // The gate must not be so loose it attaches tokens to unrelated hosts.
    t('it does not match an unrelated domain',
      !re.test('https://evil.example.com/av1.workers.dev'));
  }
}

console.log('\n' + '─'.repeat(64));
if (failures.length) {
  console.log(failures.length + ' FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
if (!pass) { console.log('NO CHECKS RAN — the harness is broken, not passing.'); process.exit(1); }
console.log('All ' + pass + ' worker-url-wiring checks passed.');
