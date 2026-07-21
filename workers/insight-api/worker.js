/**
 * Insight Worker — Plaid integration + Firestore sync for the Insight finance app
 * (INSIGHT_PLAN.md — steps 1–3: Sandbox pipeline, reusable link-token endpoints
 *  that become the "Add Account" flow, Firestore schema + daily cron sync).
 *
 * Environments:
 *   PLAID_ENV var selects sandbox|production. The build-phase production
 *   hard-block is retired (Sandbox pipeline proven, app-lock enforced
 *   server-side); /sandbox/* and the /transactions debug read-back stay
 *   sandbox-only via sandboxOnly().
 *
 * Token storage (KV binding INSIGHT_KV — never Firestore, never client-side):
 *   plaid:item:<item_id>   → { access_token, item_id, institution_id,
 *                              institution_name, env, createdAt }
 *   plaid:cursor:<item_id> → /transactions/sync cursor (per-item)
 *   gat                    → cached Google service-account access token
 *
 * Firestore schema (project task-dashboard-d2b53, all under dashboards/insight):
 *   dashboards/insight                            → meta doc: lastSyncAt,
 *                                                   lastSyncResults, env
 *   dashboards/insight/plaid_transactions/{txId}  → normalized bank transactions
 *                                                   (worker-written; the UI
 *                                                   treats source:'plaid' as
 *                                                   read-only per the plan)
 *   dashboards/insight/accounts/{accountId}       → live balances per account
 *   (manual_transactions / recurring / cash arrive with the UI build steps)
 *
 * Normalized transaction record (Plaid sign convention: positive = money OUT):
 *   { id, source:'plaid', item_id, institution, account_id, date,
 *     authorized_date, name, merchant, amount, currency, category,
 *     category_detailed, pending, logo_url, updatedAt }
 *
 * Endpoints:
 *   GET  /                   → health (env, item count — no secrets)
 *   POST /sandbox/e2e        → full Sandbox validation chain (sandbox-only)
 *   POST /link/token/create  → link_token for the Plaid Link widget
 *   POST /link/exchange      → public_token → access_token, stored in KV
 *   GET  /items              → stored items (names/ids only — no tokens)
 *   POST /sync               → full pipeline for every item: Plaid
 *                              /transactions/sync → normalize → Firestore.
 *                              Same code path the daily cron runs.
 *   GET  /transactions       → read back recent txs from Firestore (debug /
 *                              verification; sandbox-mode only)
 *
 * Cron: daily 11:00 UTC → same full pipeline as POST /sync.
 *
 * Secrets: PLAID_CLIENT_ID, PLAID_SECRET_SANDBOX, PLAID_SECRET_PRODUCTION,
 *          FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 */

const ALLOWED_ORIGIN = 'https://anthonyn99.github.io';

function corsHeaders(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(body, origin, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

// ── Plaid plumbing ──────────────────────────────────────────────────────────

function plaidEnv(env) {
  return env.PLAID_ENV === 'production' ? 'production' : 'sandbox';
}

function plaidSecret(env) {
  return plaidEnv(env) === 'production' ? env.PLAID_SECRET_PRODUCTION : env.PLAID_SECRET_SANDBOX;
}

// The former production hard-block is retired: its two conditions are met
// (Sandbox pipeline proven end-to-end; app-lock enforced server-side on the
// connect flow). What remains: a secrets-presence check for every Plaid
// route, and a sandbox-only guard for test/debug endpoints so they vanish
// in production.
function secretsGate(env, origin) {
  if (!env.PLAID_CLIENT_ID || !plaidSecret(env)) {
    return json({
      ok: false,
      error: `Plaid secrets not set for ${plaidEnv(env)} — run: wrangler secret put PLAID_CLIENT_ID / PLAID_SECRET_${plaidEnv(env).toUpperCase()} --name insight-api`
    }, origin, 500);
  }
  return null;
}

function sandboxOnly(env, origin) {
  if (plaidEnv(env) !== 'sandbox') {
    return json({ ok: false, error: 'sandbox-only endpoint' }, origin, 403);
  }
  return null;
}

// POST to a Plaid endpoint with client credentials injected. Throws a rich
// error carrying Plaid's error_code so callers/logs show exactly what failed.
async function plaidPost(env, path, body) {
  const res = await fetch(`https://${plaidEnv(env)}.plaid.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: plaidSecret(env),
      ...body
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${path} → ${data.error_code || res.status}: ${data.error_message || 'unknown Plaid error'}`);
    err.plaid = { code: data.error_code, type: data.error_type, request_id: data.request_id };
    throw err;
  }
  return data;
}

// ── App-lock verification (same PBKDF2 records index.html's locks use) ──────
// The lock is created/changed via taskhub-reminders' /auth/journal/* endpoints
// (journal 'applock', entry 'tony_insight'); this worker only READS the record
// to gate the bank-connect endpoints server-side. No lock set → deny.
const LOCK_KEY = 'jlock:applock:tony_insight';

function b64ToBytes(str) { return Uint8Array.from(atob(str), c => c.charCodeAt(0)); }

async function verifyLock(env, password) {
  if (!password || !env.AUTH_KV) return false;
  let rec;
  try { rec = await env.AUTH_KV.get(LOCK_KEY, 'json'); } catch { return false; }
  if (!rec || !rec.hash || !rec.salt) return false;
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64ToBytes(rec.salt), iterations: rec.iter || 100000, hash: 'SHA-256' }, km, 256);
  const got = new Uint8Array(bits), want = b64ToBytes(rec.hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

// A verified password can be exchanged for a 1-hour bearer token (see
// /lock/session) so the page stays unlocked across refreshes without holding
// the password anywhere. Tokens live in KV with a hard TTL and are revocable
// (/lock/end = the "Lock now" button). Link endpoints accept either form.
async function verifyLockOrToken(env, body) {
  if (body && body.token) return !!(await env.INSIGHT_KV.get('locktok:' + body.token));
  return verifyLock(env, body && body.lock);
}

const itemKey   = (id) => `plaid:item:${id}`;
const cursorKey = (id) => `plaid:cursor:${id}`;

async function listItems(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.INSIGHT_KV.list({ prefix: 'plaid:item:', cursor });
    for (const k of page.keys) {
      const item = await env.INSIGHT_KV.get(k.name, 'json');
      if (item) out.push(item);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

async function storeItem(env, item) {
  await env.INSIGHT_KV.put(itemKey(item.item_id), JSON.stringify(item));
}

// /transactions/sync one item to completion. Retries PRODUCT_NOT_READY (a
// freshly-linked item's history takes a few seconds to extract — routine in
// Sandbox, possible in production) with a short backoff.
async function syncItem(env, item, { maxReadyRetries = 8 } = {}) {
  let cursor = (await env.INSIGHT_KV.get(cursorKey(item.item_id))) || undefined;
  const added = [], modified = [], removed = [];
  let hasMore = true, readyRetries = 0, pages = 0;

  while (hasMore) {
    let data;
    try {
      data = await plaidPost(env, '/transactions/sync', {
        access_token: item.access_token,
        cursor,
        count: 500
      });
    } catch (e) {
      if (e.plaid?.code === 'PRODUCT_NOT_READY' && readyRetries < maxReadyRetries) {
        readyRetries++;
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
    pages++;
    added.push(...(data.added || []));
    modified.push(...(data.modified || []));
    removed.push(...(data.removed || []));
    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  // Persist the cursor only after a fully-consumed sync, so a mid-sync
  // failure re-reads from the last durable point instead of dropping a page.
  if (cursor) await env.INSIGHT_KV.put(cursorKey(item.item_id), cursor);
  return { added, modified, removed, pages, readyRetries };
}

// Compact, log/response-safe view of a transaction.
function txSummary(t) {
  return {
    id: t.transaction_id,
    date: t.date,
    name: t.merchant_name || t.name,
    amount: t.amount,
    currency: t.iso_currency_code,
    category: t.personal_finance_category?.primary || (t.category || [])[0] || null,
    pending: t.pending
  };
}

// ── Normalization ───────────────────────────────────────────────────────────

// "FOOD_AND_DRINK" → "Food & Drink" — display form of Plaid's
// personal_finance_category, stored alongside the raw detailed code so the UI
// can re-bucket later without a resync.
function prettyCategory(code) {
  if (!code) return null;
  return code.toLowerCase().split('_')
    .map(w => w === 'and' ? '&' : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function normalizeTx(t, item) {
  return {
    id: t.transaction_id,
    source: 'plaid',
    item_id: item.item_id,
    institution: item.institution_name || item.institution_id || null,
    account_id: t.account_id,
    date: t.date,                                   // YYYY-MM-DD (posted)
    authorized_date: t.authorized_date || null,
    name: t.name || null,
    merchant: t.merchant_name || null,
    amount: t.amount,                               // Plaid: positive = money OUT
    currency: t.iso_currency_code || 'USD',
    category: prettyCategory(t.personal_finance_category?.primary),
    category_detailed: t.personal_finance_category?.detailed || null,
    pending: t.pending === true,
    logo_url: t.logo_url || t.personal_finance_category_icon_url || null,
    updatedAt: Date.now()
  };
}

function normalizeAccount(a, item) {
  return {
    account_id: a.account_id,
    item_id: item.item_id,
    institution: item.institution_name || item.institution_id || null,
    name: a.name || null,
    official_name: a.official_name || null,
    mask: a.mask || null,
    type: a.type || null,
    subtype: a.subtype || null,
    balance_current: a.balances?.current ?? null,
    balance_available: a.balances?.available ?? null,
    currency: a.balances?.iso_currency_code || 'USD',
    updatedAt: Date.now()
  };
}

// ── Firestore plumbing (service account — same pattern as taskhub-reminders) ─

let _memToken = null;

async function getGoogleAccessToken(env) {
  const nowSec = Math.floor(Date.now() / 1000);

  if (_memToken && _memToken.expiresAt > nowSec + 300) return _memToken.token;

  if (env.INSIGHT_KV) {
    try {
      const kv = await env.INSIGHT_KV.get('gat', 'json');
      if (kv && kv.expiresAt > nowSec + 300) { _memToken = kv; return kv.token; }
    } catch (e) { console.warn('KV read error:', e.message); }
  }

  const now    = nowSec;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim  = b64url(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL, sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore'
  }));
  const payload  = `${header}.${claim}`;
  // Robust PEM parsing — tolerate literal "\n", base64url chars, stray quotes
  // (same normalization taskhub-reminders needed for slightly-mangled secrets).
  let raw = (env.FIREBASE_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/^['"]|['"]$/g, '');
  const pemBody  = raw
    .replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+').replace(/_/g, '/')
    .trim();
  if (!pemBody || pemBody.length < 100) {
    throw new Error('FIREBASE_PRIVATE_KEY empty/too short after parsing — re-upload the secret');
  }
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key      = await crypto.subtle.importKey('pkcs8', keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig      = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(payload));
  const jwt      = `${payload}.${b64url(sig)}`;
  const res      = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const j = await res.json();

  const entry = { token: j.access_token, expiresAt: now + 3600 };
  _memToken   = entry;
  if (env.INSIGHT_KV) {
    try { await env.INSIGHT_KV.put('gat', JSON.stringify(entry), { expirationTtl: 3300 }); }
    catch (e) { console.warn('KV write error:', e.message); }
  }
  return entry.token;
}

function b64url(data) {
  const b = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = ''; b.forEach(x => s += String.fromCharCode(x));
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function fsConfigured(env) {
  return !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}

const fsDocRoot = (env) =>
  `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// JS value → Firestore REST typed value. Nulls kept (nullValue) so a field
// like merchant:null is visible in the doc rather than silently absent.
function fsVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsVal) } };
  return { mapValue: { fields: fsFields(v) } };
}

function fsFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fsVal(v);
  return out;
}

// batchWrite in chunks of ≤500 (Firestore's per-call limit). `update` without
// a mask is a full set (create-or-overwrite) — right for normalized records we
// own end-to-end. Returns total write count.
async function fsBatchWrite(env, token, writes) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:batchWrite`;
  let written = 0;
  for (let i = 0; i < writes.length; i += 500) {
    const chunk = writes.slice(i, i + 500);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: chunk })
    });
    if (!res.ok) throw new Error(`batchWrite failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    // batchWrite is non-atomic: per-write status array. Surface any failure.
    const bad = (data.status || []).filter(s => s.code && s.code !== 0);
    if (bad.length) throw new Error(`batchWrite: ${bad.length} write(s) failed: ${JSON.stringify(bad[0]).slice(0, 200)}`);
    written += chunk.length;
  }
  return written;
}

// ── Full sync pipeline (cron + POST /sync share this) ───────────────────────
// Per item: Plaid /transactions/sync → normalize → Firestore batchWrite
// (upsert added+modified, delete removed) → refresh account balances →
// stamp the meta doc. Firestore-less mode (secrets not yet set) still runs
// the Plaid leg and reports firestore:'skipped' so nothing hard-fails.
async function runFullSync(env, trigger) {
  const items = await listItems(env);
  const out = { ok: true, trigger, env: plaidEnv(env), synced: 0, results: [] };

  const writeFs = fsConfigured(env);
  let token = null;
  if (writeFs) token = await getGoogleAccessToken(env);
  else out.firestore = 'skipped — FIREBASE_* secrets not set';

  for (const item of items) {
    const r = { item_id: item.item_id, institution: item.institution_name, ok: true };
    try {
      const sync = await syncItem(env, item);
      r.added = sync.added.length;
      r.modified = sync.modified.length;
      r.removed = sync.removed.length;

      if (writeFs) {
        const root = fsDocRoot(env);
        const writes = [];
        for (const t of [...sync.added, ...sync.modified]) {
          writes.push({ update: {
            name: `${root}/dashboards/insight/plaid_transactions/${t.transaction_id}`,
            fields: fsFields(normalizeTx(t, item))
          }});
        }
        for (const t of sync.removed) {
          writes.push({ delete: `${root}/dashboards/insight/plaid_transactions/${t.transaction_id}` });
        }

        // Balances ride along on every sync (plan §4.6) — cheap, one call/item.
        const acc = await plaidPost(env, '/accounts/get', { access_token: item.access_token });
        for (const a of acc.accounts) {
          writes.push({ update: {
            name: `${root}/dashboards/insight/accounts/${a.account_id}`,
            fields: fsFields(normalizeAccount(a, item))
          }});
        }
        r.accounts = acc.accounts.length;
        r.firestoreWrites = await fsBatchWrite(env, token, writes);
      }
      out.synced++;
    } catch (e) {
      r.ok = false;
      r.error = e.message;
      out.ok = false;
    }
    out.results.push(r);
  }

  if (writeFs) {
    try {
      await fsBatchWrite(env, token, [{ update: {
        name: `${fsDocRoot(env)}/dashboards/insight`,
        fields: fsFields({
          lastSyncAt: Date.now(),
          lastSyncTrigger: trigger,
          env: plaidEnv(env),
          lastSyncResults: out.results.map(r => ({
            institution: r.institution, ok: r.ok,
            added: r.added ?? 0, modified: r.modified ?? 0, removed: r.removed ?? 0
          }))
        })
      }}]);
    } catch (e) {
      out.metaWriteError = e.message;
    }
  }

  return out;
}

// ── Routes ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (path === '/' || path === '/health') {
        const items = env.INSIGHT_KV ? (await env.INSIGHT_KV.list({ prefix: 'plaid:item:' })).keys.length : -1;
        return json({
          ok: true,
          app: 'insight-api',
          plaidEnv: plaidEnv(env),
          secretsPresent: {
            clientId: !!env.PLAID_CLIENT_ID,
            envSecret: !!plaidSecret(env),
            firestore: fsConfigured(env)
          },
          linkedItems: items
        }, origin);
      }

      if (path === '/sandbox/e2e' && request.method === 'POST') {
        return await handleSandboxE2E(env, origin);
      }

      // ── App-lock sessions ──────────────────────────────────────────────
      if (path === '/lock/session' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch { body = {}; }
        if (!(await verifyLock(env, body.password))) {
          return json({ ok: false, error: 'wrong password' }, origin, 401);
        }
        const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        await env.INSIGHT_KV.put('locktok:' + token, '1', { expirationTtl: 3600 });
        return json({ ok: true, token, expiresAt: Date.now() + 3600 * 1000 }, origin);
      }

      if (path === '/lock/end' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch { body = {}; }
        if (body.token) await env.INSIGHT_KV.delete('locktok:' + body.token);
        return json({ ok: true }, origin);
      }

      if (path === '/link/token/create' && request.method === 'POST') {
        const blocked = secretsGate(env, origin);
        if (blocked) return blocked;
        let body = {};
        try { body = await request.json(); } catch { body = {}; }
        if (!(await verifyLockOrToken(env, body))) {
          return json({ ok: false, error: 'app lock required', lockRequired: true }, origin, 401);
        }
        const data = await plaidPost(env, '/link/token/create', {
          user: { client_user_id: 'tony' },
          client_name: 'Insight',
          products: ['transactions'],
          transactions: { days_requested: 90 },   // plan: 90-day initial history
          country_codes: ['US'],
          language: 'en',
          // OAuth institutions (Chase, Capital One, Wells Fargo…) redirect the
          // browser to the bank and back — this URI must also be registered as
          // an Allowed Redirect URI in the Plaid Dashboard (API settings).
          redirect_uri: 'https://anthonyn99.github.io/A1/insight.html'
        });
        return json({ ok: true, link_token: data.link_token, expiration: data.expiration }, origin);
      }

      if (path === '/link/exchange' && request.method === 'POST') {
        const blocked = secretsGate(env, origin);
        if (blocked) return blocked;
        let body = {};
        try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, origin, 400); }
        if (!(await verifyLockOrToken(env, body))) {
          return json({ ok: false, error: 'app lock required', lockRequired: true }, origin, 401);
        }
        if (!body.public_token) return json({ ok: false, error: 'missing public_token' }, origin, 400);

        const ex = await plaidPost(env, '/item/public_token/exchange', { public_token: body.public_token });
        const item = {
          access_token: ex.access_token,
          item_id: ex.item_id,
          institution_id: body.institution_id || null,
          institution_name: body.institution_name || null,
          env: plaidEnv(env),
          createdAt: Date.now()
        };
        await storeItem(env, item);
        return json({ ok: true, item_id: ex.item_id, institution: item.institution_name }, origin);
      }

      // POST + lock-gated: in production this lists your real institutions.
      if (path === '/items' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch { body = {}; }
        if (!(await verifyLockOrToken(env, body))) {
          return json({ ok: false, error: 'app lock required', lockRequired: true }, origin, 401);
        }
        const items = await listItems(env);
        return json({
          ok: true,
          count: items.length,
          items: items.map(i => ({
            item_id: i.item_id,
            institution_id: i.institution_id,
            institution_name: i.institution_name,
            env: i.env,
            createdAt: i.createdAt
          }))
        }, origin);
      }

      // TEMP (remove after use): pre-production cleanup — deletes the sandbox
      // Plaid items/cursors from KV and every sandbox-sourced doc from
      // Firestore so production starts from a clean slate. Sandbox-mode only.
      if (path === '/admin/wipe-sandbox-data' && request.method === 'POST') {
        const blocked = sandboxOnly(env, origin);
        if (blocked) return blocked;
        let deletedKV = 0;
        for (const prefix of ['plaid:item:', 'plaid:cursor:']) {
          let cursor;
          do {
            const page = await env.INSIGHT_KV.list({ prefix, cursor });
            for (const k of page.keys) { await env.INSIGHT_KV.delete(k.name); deletedKV++; }
            cursor = page.list_complete ? null : page.cursor;
          } while (cursor);
        }
        let deletedFs = 0;
        if (fsConfigured(env)) {
          const token = await getGoogleAccessToken(env);
          const root = fsDocRoot(env);
          for (const coll of ['plaid_transactions', 'accounts']) {
            let pageToken = null;
            do {
              const listUrl = new URL(`https://firestore.googleapis.com/v1/${root}/dashboards/insight/${coll}`);
              listUrl.searchParams.set('pageSize', '300');
              if (pageToken) listUrl.searchParams.set('pageToken', pageToken);
              const res = await fetch(listUrl, { headers: { 'Authorization': `Bearer ${token}` } });
              if (!res.ok) break;
              const data = await res.json();
              const docs = data.documents || [];
              pageToken = data.nextPageToken || null;
              if (docs.length) {
                await fsBatchWrite(env, token, docs.map(d => ({ delete: d.name })));
                deletedFs += docs.length;
              }
            } while (pageToken);
          }
          // Clear the sync-meta stamp too (subcollections incl. meta/expenselog persist).
          await fetch(`https://firestore.googleapis.com/v1/${root}/dashboards/insight`, {
            method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
          });
        }
        return json({ ok: true, deletedKV, deletedFs }, origin);
      }

      // Sandbox-only: wipe sync cursors so the next /sync re-pulls full
      // history. Needed when the Firestore layer (or any downstream change)
      // arrives after a cursor already consumed the history — re-pulled txs
      // upsert by transaction_id, so this is always idempotent.
      if (path === '/sandbox/reset-cursors' && request.method === 'POST') {
        const blocked = sandboxOnly(env, origin) || secretsGate(env, origin);
        if (blocked) return blocked;
        const items = await listItems(env);
        for (const i of items) await env.INSIGHT_KV.delete(cursorKey(i.item_id));
        return json({ ok: true, cursorsReset: items.length }, origin);
      }

      if (path === '/sync' && request.method === 'POST') {
        const blocked = secretsGate(env, origin);
        if (blocked) return blocked;
        return json(await runFullSync(env, 'manual'), origin);
      }

      // Debug/verification read-back: newest Firestore transactions.
      // Sandbox-only — in production the frontend reads Firestore directly
      // via onSnapshot and no transaction data is exposed on this worker.
      if (path === '/transactions' && request.method === 'GET') {
        const blocked = sandboxOnly(env, origin) || secretsGate(env, origin);
        if (blocked) return blocked;
        if (!fsConfigured(env)) return json({ ok: false, error: 'FIREBASE_* secrets not set' }, origin, 500);
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 100);
        const token = await getGoogleAccessToken(env);
        const res = await fetch(`https://firestore.googleapis.com/v1/${fsDocRoot(env)}/dashboards/insight:runQuery`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ structuredQuery: {
            from: [{ collectionId: 'plaid_transactions' }],
            orderBy: [{ field: { fieldPath: 'date' }, direction: 'DESCENDING' }],
            limit
          }})
        });
        if (!res.ok) return json({ ok: false, error: (await res.text()).slice(0, 400) }, origin, 500);
        const rows = await res.json();
        const docs = (Array.isArray(rows) ? rows : []).filter(r => r.document);
        return json({
          ok: true,
          count: docs.length,
          transactions: docs.map(r => {
            const f = r.document.fields || {};
            return {
              id: f.id?.stringValue,
              date: f.date?.stringValue,
              name: f.merchant?.stringValue || f.name?.stringValue,
              amount: parseFloat(f.amount?.doubleValue ?? f.amount?.integerValue ?? '0'),
              category: f.category?.stringValue || null,
              institution: f.institution?.stringValue,
              pending: f.pending?.booleanValue === true
            };
          })
        }, origin);
      }

      return json({ ok: false, error: 'unknown route' }, origin, 404);
    } catch (e) {
      return json({ ok: false, error: e.message || 'server error', plaid: e.plaid || undefined }, origin, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Daily incremental sync (plan §3) — runs in whichever env is active.
    ctx.waitUntil(
      runFullSync(env, 'cron')
        .then(r => console.log(`[cron] synced ${r.synced} item(s):`,
          r.results.map(x => `${x.institution}: +${x.added ?? 0}/~${x.modified ?? 0}/-${x.removed ?? 0}${x.ok ? '' : ' FAILED: ' + x.error}`).join(' | ')))
        .catch(e => console.error('[cron] sync failed:', e.message))
    );
  }
};

// ── Sandbox end-to-end validation (build step 1) ────────────────────────────
// Proves the full pipeline headlessly: sandbox public token (the API-side
// equivalent of completing Link with user_good / pass_good) → exchange →
// KV storage → accounts → transactions sync to completion. Response is a
// stage-by-stage report so a failure pinpoints exactly where the chain broke.
async function handleSandboxE2E(env, origin) {
  const blocked = sandboxOnly(env, origin) || secretsGate(env, origin);
  if (blocked) return blocked;

  const report = { ok: false, env: 'sandbox', stages: {} };

  // 1) Sandbox public token — First Platypus Bank (ins_109508), Plaid's
  //    canonical test institution for user_good / pass_good.
  const pub = await plaidPost(env, '/sandbox/public_token/create', {
    institution_id: 'ins_109508',
    initial_products: ['transactions'],
    options: { override_username: 'user_good', override_password: 'pass_good' }
  });
  report.stages.public_token = { ok: true };

  // 2) Exchange for a persistent access token — the same call the real
  //    "Add Account" flow will make after the Link widget hands back a
  //    public_token.
  const ex = await plaidPost(env, '/item/public_token/exchange', { public_token: pub.public_token });
  report.stages.exchange = { ok: true, item_id: ex.item_id };

  // 3) Persist exactly as production items will be persisted.
  const item = {
    access_token: ex.access_token,
    item_id: ex.item_id,
    institution_id: 'ins_109508',
    institution_name: 'First Platypus Bank (sandbox)',
    env: 'sandbox',
    createdAt: Date.now()
  };
  await storeItem(env, item);
  const stored = await env.INSIGHT_KV.get(itemKey(ex.item_id), 'json');
  report.stages.kv_storage = { ok: !!stored && stored.access_token === ex.access_token };

  // 4) Balances/accounts — comes free with the Transactions product.
  const acc = await plaidPost(env, '/accounts/get', { access_token: ex.access_token });
  report.stages.accounts = {
    ok: true,
    count: acc.accounts.length,
    accounts: acc.accounts.map(a => ({
      name: a.name, type: a.type, subtype: a.subtype,
      mask: a.mask, current: a.balances.current, available: a.balances.available
    }))
  };

  // 5) Full incremental sync to completion.
  const sync = await syncItem(env, item);
  report.stages.transactions_sync = {
    ok: true,
    added: sync.added.length,
    modified: sync.modified.length,
    removed: sync.removed.length,
    pages: sync.pages,
    productReadyRetries: sync.readyRetries,
    sample: sync.added.slice(0, 8).map(txSummary)
  };

  report.ok = Object.values(report.stages).every(s => s.ok);
  return json(report, origin);
}
