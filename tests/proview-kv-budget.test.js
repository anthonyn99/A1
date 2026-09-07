/* ProView must not spend KV writes it does not need to.

   WHY THIS FILE EXISTS
   KV WRITES are capped at 1,000/day per Cloudflare ACCOUNT, shared by every
   worker on it. ProView was the whole of RiftIQ's contribution to that (WarRoom
   has no KV binding at all -- it has always used caches.default), and the client
   loads EVERY configured league on open, so a heavy day was a dozen leagues
   against a 15-minute TTL, each expiry costing a write.

   Two things now prevent that, and both are invisible when they regress: the
   worker still answers correctly either way, it just quietly costs more. So the
   properties are asserted here rather than left to be noticed on a quota page.

   The subtle one is the refresh floor. Skipping the write for unchanged content
   also skips renewing the entry's expirationTtl, so a payload that never
   changes would expire out of KV entirely and take the stale-fallback with it --
   gone exactly when upstream is down and it is the only copy left. The floor
   must therefore always be comfortably below PV_KEEP.

   Run: node tests/proview-kv-budget.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'workers2', 'proview-api', 'worker.js'), 'utf8');

let pass = 0; const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function section(s) { console.log('\n' + s); }

const num = (re) => { const m = SRC.match(re); return m ? Function('return (' + m[1] + ')')() : null; };
const PV_KEEP = num(/const PV_KEEP\s*=\s*([^;]+);/);
const FLOOR = num(/const PV_REFRESH_FLOOR_MS\s*=\s*([^;]+);/);

section('The durable copy cannot expire while it is being skipped');
t('PV_KEEP is defined', PV_KEEP > 0, String(PV_KEEP) + 's');
t('a refresh floor is defined', FLOOR > 0, String(FLOOR) + 'ms');
t('the floor is well inside PV_KEEP', FLOOR > 0 && PV_KEEP > 0 && FLOOR < PV_KEEP * 1000 * 0.75,
  'floor ' + (FLOOR / 86400000).toFixed(1) + 'd vs keep ' + (PV_KEEP / 86400).toFixed(1) + 'd. ' +
  'An unchanged entry is only rewritten at the floor, so a floor at or near ' +
  'PV_KEEP lets it expire out of KV — losing the stale-fallback precisely when ' +
  'upstream is down and it is the only copy left.');

section('Writes are conditional, not unconditional');
t('the write is gated on content actually changing',
  /const unchanged = cached && cached\.body===body;/.test(SRC) &&
  /if\(!unchanged \|\| age>PV_REFRESH_FLOOR_MS\)\{[\s\S]{0,160}PV_CACHE\.put\(/.test(SRC),
  'An unconditional put re-stores a byte-identical payload and spends a write to ' +
  'do it — which is what made this worker spike the account budget.');
t('there is exactly ONE KV write path',
  (SRC.match(/PV_CACHE\.put\(/g) || []).length === 1,
  'Found ' + (SRC.match(/PV_CACHE\.put\(/g) || []).length + '. A second, ungated write ' +
  'would silently undo the first.');

section('The free cache sits in front of the metered one');
t('caches.default is used', /caches\.default/.test(SRC),
  'This is the layer that costs nothing against any quota — the same one ' +
  'warroom-api has always used, which is why WarRoom never contributed to these spikes.');
t('the edge is checked BEFORE KV',
  SRC.indexOf('edge.match(edgeKey)') < SRC.indexOf('PV_CACHE.getWithMetadata'),
  'Checking KV first would keep paying a KV read on every request.');
t('a fresh KV hit also populates the edge',
  /pvEdgePut\(edge,edgeKey,cached\.body,ttl,ctx\)/.test(SRC),
  'Otherwise every request inside a TTL still costs a KV read.');
t('the edge write never blocks the response',
  /ctx\.waitUntil\(p\)/.test(SRC),
  'A cache write is an optimisation and must not add latency to the answer.');
t('the edge entry expires with the TTL it was cached under',
  /'Cache-Control':'public, max-age='\+ttl/.test(SRC),
  'A longer edge life than the TTL would serve stale data past its freshness window.');

section('Failure still falls back to the durable copy');
t('an upstream error serves the stale KV body',
  (SRC.match(/pvCorsResponse\(cached\.body,'STALE'\)/g) || []).length === 2,
  'Both the thrown-error and the non-OK path must fall back, not 502 over a copy ' +
  'that is sitting right there.');

console.log('\n' + '─'.repeat(64));
if (failures.length) {
  console.log(failures.length + ' FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
if (!pass) { console.log('NO CHECKS RAN — the harness is broken, not passing.'); process.exit(1); }
console.log('All ' + pass + ' proview-kv-budget checks passed.');
