#!/usr/bin/env node
// ============================================================================
// kv-migrate — copy ONE KV namespace from Cloudflare account 1 to account 2.
//
// WHY THIS EXISTS
// A KV namespace belongs to exactly one account, so moving a worker from
// workers/ to workers2/ leaves its data behind. For a pure TTL cache that is
// fine — it refills itself. For state it is data loss:
//
//   A1_BACKUPS  the off-device backup sink. Losing it means losing every
//               snapshot older than the next push from each device.
//   TD_KV       wl:current (the watchlist), td_analysis_prompt (the prompt the
//               ChatGPT auto-launcher submits) and td_daily_reminder. None of
//               these are derived from anything — nothing would rebuild them.
//
// Nobody's laptop holds credentials for both accounts at once (wrangler's OAuth
// login only has account 1 in scope), but CI holds both tokens, so this runs
// there — see .github/workflows/workers2-kv-migrate.yml.
//
// IDEMPOTENT AND NON-DESTRUCTIVE. It only ever writes to the destination, never
// deletes from either side, and re-running it just overwrites with the same
// bytes. The source namespace is left completely intact, which is what makes
// the migration reversible: repoint the worker back and the data is still there.
//
// --prune-orphans (A1_BACKUPS ONLY)
// That namespace stores `s/<device>/<ts>` snapshot manifests and the
// `o/<hash>` objects they point at. Snapshot retention was bounded; the objects
// were not, so at migration time 316 of 467 objects — 22 MB of 30 MB — were
// referenced by nothing at all. Copying that across would move the garbage to a
// fresh account and spend 300+ of its 1,000 daily writes doing it. With this
// flag the live set is computed from the manifests and unreferenced objects are
// simply not copied. Nothing is deleted from the source either way, so account
// 1's namespace stays intact as a rollback.
//
// Usage:
//   SRC_TOKEN=... SRC_ACCOUNT=... DST_TOKEN=... DST_ACCOUNT=... \
//     node workers2/kv-migrate.mjs <TITLE> [--dry-run] [--prune-orphans]
// ============================================================================
import process from 'node:process';

const TITLE = process.argv.slice(2).find((a) => !a.startsWith('--'));
const DRY = process.argv.includes('--dry-run');
const PRUNE = process.argv.includes('--prune-orphans');
const { SRC_TOKEN, SRC_ACCOUNT, DST_TOKEN, DST_ACCOUNT } = process.env;

if (!TITLE) { console.error('usage: kv-migrate.mjs <NAMESPACE_TITLE> [--dry-run]'); process.exit(1); }
for (const [k, v] of Object.entries({ SRC_TOKEN, SRC_ACCOUNT, DST_TOKEN, DST_ACCOUNT })) {
  if (!v) { console.error(`kv-migrate: ${k} is not set.`); process.exit(1); }
}

const base = (acct) => `https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces`;

async function cf(url, token, init) {
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, ...(init?.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* handled below */ }
  if (!r.ok || !body || body.success !== true) {
    throw new Error(body?.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${r.status}`);
  }
  return body;
}

async function findNamespace(acct, token, title) {
  for (let page = 1; ; page++) {
    const { result } = await cf(`${base(acct)}?per_page=100&page=${page}`, token);
    const hit = result.find((n) => n.title === title);
    if (hit) return hit.id;
    if (result.length < 100) return null;
  }
}

// Every key, following the cursor. A truncated listing here silently migrates
// part of a backup and reports success, which is worse than failing.
async function allKeys(acct, token, ns) {
  const out = [];
  let cursor = '';
  for (;;) {
    const u = new URL(`${base(acct)}/${ns}/keys`);
    u.searchParams.set('limit', '1000');
    if (cursor) u.searchParams.set('cursor', cursor);
    const body = await cf(u, token);
    out.push(...body.result);
    cursor = body.result_info?.cursor || '';
    if (!cursor) return out;
  }
}

const srcNs = await findNamespace(SRC_ACCOUNT, SRC_TOKEN, TITLE);
if (!srcNs) { console.error(`kv-migrate: no namespace "${TITLE}" on source account ${SRC_ACCOUNT}.`); process.exit(1); }

let dstNs = await findNamespace(DST_ACCOUNT, DST_TOKEN, TITLE);
if (!dstNs) {
  if (DRY) { console.log(`would CREATE "${TITLE}" on ${DST_ACCOUNT}`); dstNs = '(pending)'; }
  else {
    const made = await cf(base(DST_ACCOUNT), DST_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: TITLE }),
    });
    dstNs = made.result.id;
    console.log(`created "${TITLE}" on destination → ${dstNs}`);
  }
}
console.log(`kv-migrate: ${TITLE}  ${srcNs} (acct ${SRC_ACCOUNT}) → ${dstNs} (acct ${DST_ACCOUNT})`);

let keys = await allKeys(SRC_ACCOUNT, SRC_TOKEN, srcNs);

if (PRUNE) {
  // FAILS CLOSED, exactly like the Worker's own collector: this decides what
  // does NOT get copied, so anything that could make the live set incomplete —
  // an unreadable manifest, one without an object list — abandons the pruning
  // and copies everything. A slightly fatter destination is a non-event; a
  // migration that quietly dropped a referenced object is not.
  const snaps = keys.filter((k) => k.name.startsWith('s/'));
  const live = new Set();
  let ok = snaps.length > 0;
  for (const k of snaps) {
    if (!ok) break;
    try {
      const r = await fetch(`${base(SRC_ACCOUNT)}/${srcNs}/values/${encodeURIComponent(k.name)}`,
        { headers: { Authorization: 'Bearer ' + SRC_TOKEN } });
      if (!r.ok) { ok = false; break; }
      const j = JSON.parse(await r.text());
      if (!Array.isArray(j.objects)) { ok = false; break; }
      for (const h of j.objects) live.add(String(h));
    } catch (e) { ok = false; }
  }
  if (!ok) {
    console.log('  --prune-orphans: reference set incomplete — copying EVERYTHING instead.');
  } else {
    const dropped = keys.filter((k) => k.name.startsWith('o/') && !live.has(k.name.slice(2)));
    const mb = dropped.reduce((n, k) => n + ((k.metadata && k.metadata.bytes) || 0), 0) / 1048576;
    keys = keys.filter((k) => !dropped.includes(k));
    console.log(`  --prune-orphans: ${live.size} object(s) referenced by ${snaps.length} snapshot(s); ` +
      `skipping ${dropped.length} orphan(s), ${mb.toFixed(2)} MB.`);
  }
}

console.log(`  ${keys.length} key(s) to copy`);
if (DRY) {
  for (const k of keys.slice(0, 20)) console.log('    · ' + k.name);
  if (keys.length > 20) console.log(`    … and ${keys.length - 20} more`);
  console.log('kv-migrate: --dry-run, nothing written.');
  process.exit(0);
}

// Values go over base64 so this is byte-exact for any content, and metadata and
// absolute expiry ride along — GC and /index both read `bytes`/`at` out of the
// metadata, so dropping it would leave the destination looking empty of history.
const MAX_BATCH_BYTES = 5 * 1024 * 1024;
const MAX_BATCH_KEYS = 1000;
const nowSec = Math.floor(Date.now() / 1000);

let batch = [], batchBytes = 0, written = 0, skipped = 0, failed = 0;

async function flush() {
  if (!batch.length) return;
  await cf(`${base(DST_ACCOUNT)}/${dstNs}/bulk`, DST_TOKEN, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });
  written += batch.length;
  console.log(`  wrote ${written}/${keys.length}`);
  batch = []; batchBytes = 0;
}

for (const k of keys) {
  // An entry already past its expiry would be resurrected with a stale absolute
  // expiration and rejected; there is nothing to carry over.
  if (k.expiration && k.expiration <= nowSec + 60) { skipped++; continue; }

  const u = `${base(SRC_ACCOUNT)}/${srcNs}/values/${encodeURIComponent(k.name)}`;
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + SRC_TOKEN } });
  if (!r.ok) {
    // A key that vanished mid-run (retention, TTL) is expected; anything else
    // is not, and must not be papered over.
    if (r.status === 404) { skipped++; continue; }
    console.error(`  ! read ${k.name} → HTTP ${r.status}`);
    failed++; continue;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const entry = { key: k.name, value: buf.toString('base64'), base64: true };
  if (k.metadata) entry.metadata = k.metadata;
  if (k.expiration) entry.expiration = k.expiration;

  batch.push(entry);
  batchBytes += buf.length;
  if (batch.length >= MAX_BATCH_KEYS || batchBytes >= MAX_BATCH_BYTES) await flush();
}
await flush();

console.log(`\nkv-migrate: ${TITLE} — ${written} copied, ${skipped} skipped (expired/gone), ${failed} failed.`);
if (failed) {
  console.error('kv-migrate: some keys could not be read; the destination is INCOMPLETE. Re-run.');
  process.exit(1);
}
