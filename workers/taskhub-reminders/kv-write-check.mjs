// Measure the ACTUAL KV write rate without the analytics API.
//
// Cloudflare's free plan allows 100,000 reads/day but only 1,000 WRITES, so
// writes are the number that matters. The dashboard reports them, but the API
// that serves it needs an Analytics token; this gets the same answer by
// observation instead.
//
// How: every key written with an expirationTtl exposes its expiry, so
//   written_ago = TTL - (expiration - now)
// Sample repeatedly and each time written_ago COLLAPSES, that key was rewritten.
// Counting collapses over a known window gives a real write rate to extrapolate.
//
// Usage:  node workers/taskhub-reminders/kv-write-check.mjs [minutes]
// Default 20 minutes — long enough to catch the 15-minute reminder heartbeat.

import { execFile } from 'child_process';
import { promisify } from 'util';
const run = promisify(execFile);

const NS = 'b51e916cf3bf4f37ad146af5ca031575';   // TOKEN_CACHE
// TTLs the code writes these with, needed to turn an expiry into a write time.
const TTL = { 'rem:next': 3600, 'gat': 3300, 'oi:gat': 3300, 'pw_gat': 3300, 'kroger_tok': 3600 };

const MINUTES = Number(process.argv[2] || 20);
const EVERY_MS = 60_000;

async function sample() {
  const { stdout } = await run('npx', ['wrangler', 'kv', 'key', 'list', '--namespace-id', NS, '--remote'],
    { shell: true, maxBuffer: 1 << 24 });
  const now = Math.floor(Date.now() / 1000);
  const out = {};
  for (const k of JSON.parse(stdout)) {
    if (!k.expiration) continue;
    const ttl = TTL[k.name];
    if (!ttl) continue;
    out[k.name] = ttl - (k.expiration - now);   // seconds since it was written
  }
  return out;
}

console.log(`Watching TOKEN_CACHE for ${MINUTES} min — a write shows up as an age that drops.\n`);

const first = await sample();
let prev = first;
const writes = {};
Object.keys(first).forEach(k => { writes[k] = 0; });
console.log(new Date().toISOString().slice(11, 19) + '  baseline: ' +
  Object.entries(first).map(([k, v]) => `${k}=${v}s`).join('  '));

const started = Date.now();
const ticks = Math.max(1, Math.round((MINUTES * 60_000) / EVERY_MS));
for (let i = 0; i < ticks; i++) {
  await new Promise(r => setTimeout(r, EVERY_MS));
  let cur;
  try { cur = await sample(); } catch (e) { console.log('  sample failed: ' + e.message); continue; }
  const hits = [];
  for (const k of Object.keys(cur)) {
    // A rewrite resets the clock, so the age goes DOWN instead of up.
    if (prev[k] !== undefined && cur[k] < prev[k]) { writes[k] = (writes[k] || 0) + 1; hits.push(k); }
  }
  console.log(new Date().toISOString().slice(11, 19) + '  ' +
    Object.entries(cur).map(([k, v]) => `${k}=${v}s`).join('  ') +
    (hits.length ? '   <-- WRITE: ' + hits.join(', ') : ''));
  prev = cur;
}

const elapsedMin = (Date.now() - started) / 60000;
console.log('\n── observed over ' + elapsedMin.toFixed(1) + ' min ──');
let perDay = 0;
for (const [k, n] of Object.entries(writes)) {
  const daily = (n / elapsedMin) * 1440;
  perDay += daily;
  console.log('  ' + k.padEnd(12) + n + ' write(s)  →  ~' + Math.round(daily) + '/day');
}
console.log('  ' + ''.padEnd(12, '-'));
console.log('  these keys alone: ~' + Math.round(perDay) + ' writes/day of the 1,000 free-tier cap');
console.log('\nExpected after the Aug 21 fix: rem:next writes ONLY on its ~15-min');
console.log('heartbeat (~96/day). If you see rem:next writing every minute, the');
console.log('grace-window skip in refreshLookahead() has regressed.');
