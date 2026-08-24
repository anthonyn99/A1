// Account-wide KV write audit.
//
// The earlier checker only watched TOKEN_CACHE and only five named keys, which
// missed eleven other namespaces. This one is TTL-agnostic and covers all of
// them: snapshot every namespace twice, then diff.
//
//   key appears            -> it was written
//   expiration moves later -> it was rewritten (TTL restarted)
//
// BLIND SPOT, stated plainly: a key written WITHOUT a TTL has no expiry to move,
// so a rewrite of it is invisible here. Those are checked separately by reading
// the few known no-TTL hot keys and comparing their embedded timestamps.
//
// Usage: node workers/kv-audit.mjs [gapMinutes]   (default 10)

import { execFile } from 'child_process';
import { promisify } from 'util';
const run = promisify(execFile);

const NS = [
  ['db15ea4183e84982baabf95bf974d933', 'FILES'],
  ['dbfdf972572440bcaea7b53a34253921', 'INSIGHT_KV'],
  ['368086aa79d34d8383ef85bd1e4f597b', 'KEYCHAIN'],
  ['43e7af9882894b5b82f34bb9b6f88719', 'LINKS'],
  ['dc67fb750dcc4858a8fcff9367b549e9', 'NEWSHUB_CACHE'],
  ['512ff8d9f3144c16966179105586768d', 'PV_CACHE'],
  ['74a9866ac7e944178287f647d76aaf26', 'TB_KV'],
  ['897dc1bcd93d4a55ab67836639d3866b', 'TD_KV'],
  ['66ed99d28b9541bd81c8d98c9a483e8c', 'TESLA_KV'],
  ['b51e916cf3bf4f37ad146af5ca031575', 'TOKEN_CACHE'],
  ['b70722a46ddb40d49906e2e4aedc7b4a', 'WX_CACHE'],
];

const GAP_MIN = Number(process.argv[2] || 10);

async function listNs(id) {
  const { stdout } = await run('npx',
    ['wrangler', 'kv', 'key', 'list', '--namespace-id', id, '--remote'],
    { shell: true, maxBuffer: 1 << 26 });
  const m = new Map();
  for (const k of JSON.parse(stdout)) m.set(k.name, k.expiration || 0);
  return m;
}

async function snapshot() {
  const out = {};
  for (const [id, name] of NS) {
    try { out[name] = await listNs(id); }
    catch (e) { out[name] = null; console.log(`  (${name}: list failed — ${e.message.slice(0, 60)})`); }
  }
  return out;
}

const stamp = () => new Date().toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' });

console.log(`KV write audit — two snapshots ${GAP_MIN} min apart, all ${NS.length} namespaces.\n`);
console.log(stamp() + ' MDT  taking snapshot 1…');
const a = await snapshot();
const t0 = Date.now();

await new Promise(r => setTimeout(r, GAP_MIN * 60_000));

console.log(stamp() + ' MDT  taking snapshot 2…\n');
const b = await snapshot();
const elapsedMin = (Date.now() - t0) / 60000;

let grand = 0;
const rows = [];
for (const [, name] of NS) {
  const A = a[name], B = b[name];
  if (!A || !B) continue;
  const added = [], rewritten = [];
  for (const [k, exp] of B) {
    if (!A.has(k)) added.push(k);
    else if (exp && A.get(k) && exp > A.get(k)) rewritten.push(k);
  }
  const n = added.length + rewritten.length;
  grand += n;
  const noTtl = [...B.values()].filter(v => !v).length;
  rows.push({ name, n, keys: B.size, noTtl, sample: [...added.slice(0, 3), ...rewritten.slice(0, 3)] });
}

rows.sort((x, y) => y.n - x.n);
console.log('namespace        keys  no-TTL   writes seen   →  per day');
console.log('─'.repeat(64));
for (const r of rows) {
  const perDay = (r.n / elapsedMin) * 1440;
  console.log('  ' + r.name.padEnd(15) + String(r.keys).padStart(4) + String(r.noTtl).padStart(8) +
    String(r.n).padStart(13) + '   →  ' + String(Math.round(perDay)).padStart(5));
  if (r.sample.length) console.log('      ' + r.sample.join(', ').slice(0, 90));
}
console.log('─'.repeat(64));
console.log('  observed over ' + elapsedMin.toFixed(1) + ' min: ' + grand + ' write(s)  →  ~' +
  Math.round((grand / elapsedMin) * 1440) + '/day of the 1,000 free-tier write cap');
console.log('\n  NOTE: keys with no TTL cannot show a rewrite this way — see the');
console.log('  no-TTL column for how many are invisible in each namespace.');
