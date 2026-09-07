#!/usr/bin/env node
// ============================================================================
// kv-provision — resolve `kv:<TITLE>` placeholders in a workers2 wrangler.toml
//                into real account-2 KV namespace ids, at deploy time.
//
// WHY THIS EXISTS
// A KV namespace belongs to exactly one Cloudflare account, so a worker moved
// from workers/ to workers2/ cannot keep its old id — it needs a NEW namespace
// on account 2. Those ids can only be minted by something holding account 2's
// credentials, and the only thing that does is CI (CF_API_TOKEN_2). A human
// pasting ids back into git works exactly once and then rots: the next worker
// added here hits the same wall, and a mistyped id deploys green and fails at
// runtime with an empty store.
//
// So workers2 configs name their namespace by TITLE instead:
//
//     [[kv_namespaces]]
//     binding = "A1_BACKUPS"
//     id = "kv:A1_BACKUPS"        # ← resolved here, never committed
//
// This script finds that title on account 2, creates it if missing, and
// rewrites the id in the runner's checkout before `wrangler deploy` runs. The
// repo keeps the readable title; production gets the real id.
//
// FIND-OR-CREATE, EXACT MATCH ONLY
// Titles are unique per account, so an exact match is unambiguous. A prefix or
// fuzzy match is NOT acceptable here: silently binding to the wrong namespace
// is a data-loss bug that looks like a successful deploy. If the API errors we
// exit non-zero rather than create a duplicate, because a second namespace with
// the same purpose is how a worker quietly starts reading an empty store.
//
// Usage (from a worker directory, or pass one):
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... node ../kv-provision.mjs [dir] [--dry-run]
//
// Workers under workers/ do NOT use this — they pin real ids inline, because
// their namespaces already exist on account 1 and are shared between workers.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const DRY = process.argv.includes('--dry-run');
const dir = process.argv.slice(2).find((a) => !a.startsWith('--')) || process.cwd();

const CONFIGS = ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'];
const cfgName = CONFIGS.find((f) => fs.existsSync(path.join(dir, f)));
if (!cfgName) {
  console.error(`kv-provision: no wrangler config in ${dir}`);
  process.exit(1);
}
const cfgPath = path.join(dir, cfgName);
let text = fs.readFileSync(cfgPath, 'utf8');

// Every `kv:<TITLE>` placeholder, in id position. Matches both TOML
// (id = "kv:X") and JSON ("id": "kv:X").
const PLACEHOLDER = /(["']?id["']?\s*[:=]\s*")kv:([A-Za-z0-9_.-]+)(")/g;
const wanted = [...text.matchAll(PLACEHOLDER)].map((m) => m[2]);
if (!wanted.length) {
  console.log(`kv-provision: ${path.basename(dir)} has no kv: placeholders — nothing to do.`);
  process.exit(0);
}
console.log(`kv-provision: ${path.basename(dir)} needs [${[...new Set(wanted)].join(', ')}]`);

if (!TOKEN || !ACCOUNT) {
  console.error('kv-provision: CF_API_TOKEN and CF_ACCOUNT_ID must both be set.');
  process.exit(1);
}

const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces`;
const auth = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

async function cf(url, init) {
  const r = await fetch(url, { ...init, headers: { ...auth, ...(init?.headers || {}) } });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON body handled below */ }
  if (!r.ok || !body || body.success !== true) {
    const msg = body?.errors?.map((e) => `${e.code} ${e.message}`).join('; ')
      || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body.result;
}

// Full listing, paginated. The default page is 20 and reading only the first
// page is how a find-or-create quietly "creates" a namespace that already
// exists — the exact duplicate this script must never make.
async function listAll() {
  const out = [];
  for (let page = 1; ; page++) {
    const res = await cf(`${API}?per_page=100&page=${page}`);
    out.push(...res);
    if (res.length < 100) return out;
  }
}

let existing;
try {
  existing = await listAll();
} catch (e) {
  console.error(`kv-provision: cannot list namespaces on account ${ACCOUNT}: ${e.message}`);
  console.error('  The API token needs Account → Workers KV Storage → Edit.');
  process.exit(1);
}

const byTitle = new Map(existing.map((n) => [n.title, n.id]));
const resolved = new Map();

for (const title of new Set(wanted)) {
  let id = byTitle.get(title);
  if (id) {
    console.log(`  ✓ ${title} → ${id} (existing)`);
  } else if (DRY) {
    console.log(`  · ${title} → would CREATE`);
    id = '0'.repeat(32);
  } else {
    try {
      const made = await cf(API, { method: 'POST', body: JSON.stringify({ title }) });
      id = made.id;
      console.log(`  + ${title} → ${id} (CREATED)`);
    } catch (e) {
      console.error(`kv-provision: failed to create "${title}": ${e.message}`);
      process.exit(1);
    }
  }
  if (!/^[0-9a-f]{32}$/.test(id)) {
    console.error(`kv-provision: refusing a malformed id for "${title}": ${id}`);
    process.exit(1);
  }
  resolved.set(title, id);
}

text = text.replace(PLACEHOLDER, (_m, pre, title, post) => pre + resolved.get(title) + post);

if (DRY) {
  console.log('kv-provision: --dry-run, config not written.');
} else {
  fs.writeFileSync(cfgPath, text);
  console.log(`kv-provision: rewrote ${cfgName} with ${resolved.size} id(s).`);
}
