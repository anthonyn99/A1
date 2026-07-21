/**
 * Insight Worker — Plaid integration for the Insight finance app
 * (INSIGHT_PLAN.md — build step 1: Sandbox pipeline, plus the reusable
 *  link-token endpoints that become the "Add Account" flow in step 2).
 *
 * Environments:
 *   PLAID_ENV var selects sandbox|production. Production is HARD-BLOCKED in
 *   code (see prodGate) until the app-lock gate is wired in build step 7 —
 *   the Sandbox pipeline must be proven end-to-end before any real account
 *   is touched.
 *
 * Token storage (KV binding INSIGHT_KV — never Firestore, never client-side):
 *   plaid:item:<item_id>   → { access_token, item_id, institution_id,
 *                              institution_name, env, createdAt }
 *   plaid:cursor:<item_id> → /transactions/sync cursor (per-item, per-env)
 *
 * Endpoints:
 *   GET  /                   → health (env, item count — no secrets)
 *   POST /sandbox/e2e        → full Sandbox validation: create sandbox public
 *                              token (user_good/pass_good) → exchange → store
 *                              → /accounts/get → /transactions/sync to done.
 *                              Sandbox-only; 403 in production mode.
 *   POST /link/token/create  → link_token for the Plaid Link widget
 *                              (foundation of the step-2 "Add Account" flow)
 *   POST /link/exchange      → public_token → access_token, stored in KV
 *   GET  /items              → stored items (names/ids only — no tokens)
 *   POST /sync               → /transactions/sync every stored item, return
 *                              counts (Firestore writes arrive in step 3)
 *
 * Secrets: PLAID_CLIENT_ID, PLAID_SECRET_SANDBOX, PLAID_SECRET_PRODUCTION
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

// Every Plaid-touching route passes through this. Production mode stays
// unreachable until the Sandbox pipeline is validated AND the app-lock gate
// (build step 7) exists — this is the plan's "don't touch real accounts
// before Sandbox is proven" rule, enforced in code rather than by promise.
function prodGate(env, origin) {
  if (plaidEnv(env) === 'production') {
    return json({
      ok: false,
      error: 'production mode is disabled until the app-lock gate is wired (build step 7). Sandbox only for now.'
    }, origin, 403);
  }
  if (!env.PLAID_CLIENT_ID || !plaidSecret(env)) {
    return json({
      ok: false,
      error: `Plaid secrets not set for ${plaidEnv(env)} — run: wrangler secret put PLAID_CLIENT_ID / PLAID_SECRET_${plaidEnv(env).toUpperCase()} --name insight-api`
    }, origin, 500);
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

// Compact, log/response-safe view of a transaction (no account numbers ever
// appear in /transactions/sync, but keep the surface minimal anyway).
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
          secretsPresent: { clientId: !!env.PLAID_CLIENT_ID, envSecret: !!plaidSecret(env) },
          linkedItems: items
        }, origin);
      }

      if (path === '/sandbox/e2e' && request.method === 'POST') {
        return await handleSandboxE2E(env, origin);
      }

      if (path === '/link/token/create' && request.method === 'POST') {
        const blocked = prodGate(env, origin);
        if (blocked) return blocked;
        const data = await plaidPost(env, '/link/token/create', {
          user: { client_user_id: 'tony' },
          client_name: 'Insight',
          products: ['transactions'],
          transactions: { days_requested: 90 },   // plan: 90-day initial history
          country_codes: ['US'],
          language: 'en'
        });
        return json({ ok: true, link_token: data.link_token, expiration: data.expiration }, origin);
      }

      if (path === '/link/exchange' && request.method === 'POST') {
        const blocked = prodGate(env, origin);
        if (blocked) return blocked;
        let body = {};
        try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, origin, 400); }
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

      if (path === '/items' && request.method === 'GET') {
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

      if (path === '/sync' && request.method === 'POST') {
        const blocked = prodGate(env, origin);
        if (blocked) return blocked;
        const items = await listItems(env);
        const results = [];
        for (const item of items) {
          try {
            const r = await syncItem(env, item);
            results.push({
              item_id: item.item_id,
              institution: item.institution_name,
              ok: true,
              added: r.added.length, modified: r.modified.length, removed: r.removed.length
            });
          } catch (e) {
            results.push({ item_id: item.item_id, institution: item.institution_name, ok: false, error: e.message });
          }
        }
        return json({ ok: results.every(r => r.ok), synced: results.length, results }, origin);
      }

      return json({ ok: false, error: 'unknown route' }, origin, 404);
    } catch (e) {
      return json({ ok: false, error: e.message || 'server error', plaid: e.plaid || undefined }, origin, 500);
    }
  }
};

// ── Sandbox end-to-end validation (build step 1) ────────────────────────────
// Proves the full pipeline headlessly: sandbox public token (the API-side
// equivalent of completing Link with user_good / pass_good) → exchange →
// KV storage → accounts → transactions sync to completion. Response is a
// stage-by-stage report so a failure pinpoints exactly where the chain broke.
async function handleSandboxE2E(env, origin) {
  const blocked = prodGate(env, origin);
  if (blocked) return blocked;
  if (plaidEnv(env) !== 'sandbox') {
    return json({ ok: false, error: '/sandbox/e2e is sandbox-only' }, origin, 403);
  }

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
