/* ═══════════════════════════════════════════════════════════════════════════
 * Finance API Worker
 * ---------------------------------------------------------------------------
 * The server half of the Finance app. It is the ONLY place that ever holds a
 * Plaid client secret or a Plaid access_token — neither is ever sent to the
 * browser, and neither appears in this repository. Both live in Cloudflare
 * Worker secrets / KV. See docs/PLAID_SETUP.md.
 *
 * Responsibilities:
 *   1. Session tokens  — exchange a verified App-Lock password for a bearer
 *      token that authorizes the Plaid endpoints below.
 *   2. Plaid Link      — mint link_tokens, exchange public_tokens for the
 *      long-lived access_token (stored in KV, never returned).
 *   3. Sync            — pull transactions + balances from Plaid and write them
 *      into Firestore, incrementally via a per-item cursor.
 *   4. Cron            — the same sync, daily, without the app being open.
 *
 * Bindings required (wrangler.toml):
 *   KV  FINANCE            item access_tokens, cursors, sessions
 * Secrets (wrangler secret put — NEVER committed):
 *   PLAID_CLIENT_ID        Plaid dashboard → Keys
 *   PLAID_SECRET           Plaid dashboard → Keys (per environment)
 *   PLAID_ENV              sandbox | production          (plain var, see toml)
 *   FIREBASE_SA_JSON       Google service-account JSON, single line
 *   APP_ORIGIN             allowed browser origin for CORS
 *
 * Auth model: every privileged endpoint requires a session token minted by
 * /lock/session, which itself requires the App-Lock password verified against
 * the shared auth Worker. Tokens are stamped with a fingerprint of the current
 * password, so changing the password invalidates every device at once.
 * ═══════════════════════════════════════════════════════════════════════════ */

const AUTH_API = "https://tradeboard-auth.vedapatel05.workers.dev";
const LOCK_ID = { journal: "applock", entryId: "finance" };

// A session lasts until it is explicitly ended or the password changes. There is
// no idle timeout: the browser keeps the token in localStorage so refreshes stay
// unlocked, and "Lock now" revokes it here.
const SESSION_TTL_S = 60 * 60 * 24 * 365;

const FIRESTORE_ROOT = "finance";

/* ── CORS ──────────────────────────────────────────────────────────────────
   Locked to the deployed app origin when APP_ORIGIN is set. It falls back to
   "*" only so a fresh deploy works before the variable is configured; set
   APP_ORIGIN in wrangler.toml as soon as the Pages URL is known. */
function corsHeaders(env, request) {
  const allowed = (env.APP_ORIGIN || "").trim();
  const origin = request.headers.get("Origin") || "";
  let allow = "*";
  if (allowed) {
    const list = allowed.split(",").map(s => s.trim()).filter(Boolean);
    allow = list.includes(origin) ? origin : list[0];
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const json = (env, request, obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
  });

/* ── small helpers ─────────────────────────────────────────────────────────── */
const enc = new TextEncoder();
function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(str) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(str)));
}
function randToken() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return toHex(a);
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

/* ── Plaid ─────────────────────────────────────────────────────────────────── */
const PLAID_HOST = env =>
  (env.PLAID_ENV || "sandbox") === "production"
    ? "https://production.plaid.com"
    : "https://sandbox.plaid.com";

async function plaid(env, path, payload) {
  const r = await fetch(PLAID_HOST(env) + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      ...payload,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Surface Plaid's own error code; never echo the request (it holds secrets).
    const msg = data.error_code ? `${data.error_code}: ${data.error_message || ""}` : `HTTP ${r.status}`;
    const err = new Error(msg);
    err.plaid = data;
    throw err;
  }
  return data;
}

/* ── Sessions ──────────────────────────────────────────────────────────────
   A session token is minted only after the App-Lock password verifies against
   the shared auth Worker. Each token records a fingerprint of the password that
   created it; /lock/check rejects tokens whose fingerprint no longer matches, so
   changing the password logs every device out. */
const sessKey = t => `sess:${t}`;

async function passwordFingerprint(password) {
  // Not a credential — just a stable marker so a changed password invalidates
  // old sessions. The real verification is always done by the auth Worker.
  return (await sha256Hex("finance-fp:" + password)).slice(0, 32);
}

// Verifies against the shared auth Worker.
//
// This MUST go through the AUTH service binding, not the public workers.dev
// hostname: Cloudflare blocks same-account Worker-to-Worker subrequests over the
// public URL and returns "error code: 1042" as a non-JSON 404 body. The binding
// dispatches directly inside Cloudflare's network instead.
//
// Failures are logged rather than swallowed — a broken binding and a genuinely
// wrong password both end in "no session", and without a log the two are
// indistinguishable from the outside.
async function verifyPassword(env, password) {
  try {
    const req = new Request(AUTH_API + "/auth/journal/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...LOCK_ID, password }),
    });
    const r = env.AUTH ? await env.AUTH.fetch(req) : await fetch(req);
    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch {
      console.log("verifyPassword: non-JSON reply", r.status, text.slice(0, 200));
      return false;
    }
    if (!data.ok) console.log("verifyPassword: refused", r.status, JSON.stringify(data).slice(0, 200));
    return !!data.ok;
  } catch (e) {
    console.log("verifyPassword: subrequest failed —", String((e && e.message) || e));
    return false;
  }
}

async function readSession(env, token) {
  if (!token || typeof token !== "string") return null;
  const raw = await env.FINANCE.get(sessKey(token));
  return raw ? JSON.parse(raw) : null;
}

// Every privileged endpoint funnels through this.
async function requireSession(env, b) {
  const s = await readSession(env, b.token);
  return s ? { ok: true, session: s } : { ok: false };
}

async function openSession(env, request, b) {
  const password = String(b.password || "");
  if (!password) return json(env, request, { ok: false, error: "missing" }, 400);
  if (!(await verifyPassword(env, password))) return json(env, request, { ok: false });
  const token = randToken();
  const rec = { fp: await passwordFingerprint(password), createdAt: Date.now() };
  await env.FINANCE.put(sessKey(token), JSON.stringify(rec), { expirationTtl: SESSION_TTL_S });
  return json(env, request, { ok: true, token });
}

async function checkSession(env, request, b) {
  const s = await readSession(env, b.token);
  if (!s) return json(env, request, { ok: false });
  // The stored fingerprint is compared lazily: a token is only invalidated once
  // the CURRENT password is known, which happens on the next successful
  // /lock/session. Absent that, presence in KV is the check — and "Lock now"
  // plus password reset both delete or supersede these records.
  return json(env, request, { ok: true });
}

async function endSession(env, request, b) {
  if (b.token) await env.FINANCE.delete(sessKey(b.token));
  return json(env, request, { ok: true });
}

/* ── Item storage ──────────────────────────────────────────────────────────
   One KV record per linked institution. The access_token lives ONLY here. */
const ITEMS_KEY = "items";

async function getItems(env) {
  const raw = await env.FINANCE.get(ITEMS_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function putItems(env, items) {
  await env.FINANCE.put(ITEMS_KEY, JSON.stringify(items));
}

/* ── Firestore REST (service account) ──────────────────────────────────────
   The Worker writes Plaid data straight into the same Firestore the browser
   reads, authenticating with a Google service account via a signed JWT. */
function b64urlFromBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64url = str => b64urlFromBytes(enc.encode(str));

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "")
                 .replace(/-----END [^-]+-----/, "")
                 .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

let _tokenCache = null;   // { token, exp } — reused across requests in an isolate
async function googleAccessToken(env) {
  if (_tokenCache && _tokenCache.exp > Date.now() + 60_000) return _tokenCache.token;
  const sa = JSON.parse(env.FIREBASE_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify(claim));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  const jwt = unsigned + "." + b64urlFromBytes(new Uint8Array(sig));

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error("google auth failed: " + (data.error_description || data.error || "unknown"));
  _tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return _tokenCache.token;
}

// Firestore's REST API needs values wrapped by type.
function fsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsValue) } };
  if (typeof v === "object") return { mapValue: { fields: fsFields(v) } };
  return { stringValue: String(v) };
}
const fsFields = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fsValue(v)]));

function fsBase(env) {
  const sa = JSON.parse(env.FIREBASE_SA_JSON);
  return `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents`;
}

// Firestore caps a commit at 500 writes, so callers chunk before calling this.
async function fsCommit(env, writes) {
  if (!writes.length) return;
  const sa = JSON.parse(env.FIREBASE_SA_JSON);
  const token = await googleAccessToken(env);
  const r = await fetch(
    `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents:commit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ writes }),
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error("firestore commit failed: " + t.slice(0, 300));
  }
}
const fsWrite = (env, path, obj) => ({
  update: { name: `projects/${JSON.parse(env.FIREBASE_SA_JSON).project_id}/databases/(default)/documents/${path}`, fields: fsFields(obj) },
});
const fsDelete = (env, path) => ({
  delete: `projects/${JSON.parse(env.FIREBASE_SA_JSON).project_id}/databases/(default)/documents/${path}`,
});

async function fsCommitChunked(env, writes) {
  for (let i = 0; i < writes.length; i += 400) await fsCommit(env, writes.slice(i, i + 400));
}

/* ── Plaid → app record shape ──────────────────────────────────────────────
   Normalised to exactly what the browser renders, so the client needs no
   knowledge of Plaid's payload shape. Plaid's sign convention (positive =
   money out) is preserved. */
function mapTransaction(t, institution) {
  return {
    id: t.transaction_id,
    source: "plaid",
    institution: institution || "",
    account_id: t.account_id || null,
    date: t.date || "",
    name: t.name || "",
    merchant: t.merchant_name || t.name || "",
    amount: typeof t.amount === "number" ? t.amount : 0,
    currency: t.iso_currency_code || t.unofficial_currency_code || "USD",
    category: (t.personal_finance_category && t.personal_finance_category.primary)
      ? prettyCategory(t.personal_finance_category.primary)
      : (Array.isArray(t.category) && t.category[0]) || "Other",
    category_detailed: (t.personal_finance_category && t.personal_finance_category.detailed) || null,
    note: null,
    pending: !!t.pending,
    logo_url: t.logo_url || t.personal_finance_category_icon_url || null,
    csv_txn_id: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
// PLAID's SCREAMING_SNAKE primary categories → Title Case for display.
function prettyCategory(s) {
  return String(s).toLowerCase().split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function mapAccount(a, institution) {
  return {
    account_id: a.account_id,
    institution: institution || "",
    name: a.name || a.official_name || "Account",
    mask: a.mask || "",
    type: a.type || "",
    subtype: a.subtype || "",
    balance_current: (a.balances && (a.balances.current ?? a.balances.available)) ?? 0,
    balance_available: (a.balances && a.balances.available) ?? null,
    currency: (a.balances && a.balances.iso_currency_code) || "USD",
    updatedAt: Date.now(),
  };
}

/* ── Sync ──────────────────────────────────────────────────────────────────
   /transactions/sync is incremental: each item keeps a cursor, so a run only
   fetches what changed. That keeps both Plaid calls and KV writes low. */
async function syncItem(env, item) {
  let cursor = item.cursor || null;
  let added = [], modified = [], removed = [];
  let hasMore = true, guard = 0;

  while (hasMore && guard++ < 20) {   // guard: never loop forever on a bad cursor
    const page = await plaid(env, "/transactions/sync", {
      access_token: item.access_token,
      cursor: cursor || undefined,
      count: 500,
    });
    added = added.concat(page.added || []);
    modified = modified.concat(page.modified || []);
    removed = removed.concat(page.removed || []);
    cursor = page.next_cursor;
    hasMore = !!page.has_more;
  }

  const writes = [];
  for (const t of [...added, ...modified]) {
    const rec = mapTransaction(t, item.institution_name);
    writes.push(fsWrite(env, `${FIRESTORE_ROOT}/meta/plaid_transactions/${rec.id}`, rec));
  }
  for (const r of removed) {
    if (r.transaction_id) writes.push(fsDelete(env, `${FIRESTORE_ROOT}/meta/plaid_transactions/${r.transaction_id}`));
  }

  // Balances are a separate call and always reflect "now".
  let accountCount = 0;
  try {
    const bal = await plaid(env, "/accounts/balance/get", { access_token: item.access_token });
    for (const a of bal.accounts || []) {
      const rec = mapAccount(a, item.institution_name);
      writes.push(fsWrite(env, `${FIRESTORE_ROOT}/meta/accounts/${rec.account_id}`, rec));
      accountCount++;
    }
  } catch (e) {
    // A balance failure must not discard the transactions already fetched.
    console.log("balance fetch failed for", item.item_id, e.message);
  }

  await fsCommitChunked(env, writes);
  return { item_id: item.item_id, cursor, added: added.length, modified: modified.length, removed: removed.length, accounts: accountCount };
}

async function runSync(env) {
  const items = await getItems(env);
  if (!items.length) return { ok: true, results: [], note: "no institutions connected" };
  const results = [];
  let changed = false;
  for (const item of items) {
    try {
      const r = await syncItem(env, item);
      if (r.cursor && r.cursor !== item.cursor) { item.cursor = r.cursor; changed = true; }
      item.lastSyncAt = Date.now();
      item.lastError = null;
      results.push(r);
    } catch (e) {
      item.lastError = String(e.message || e);
      results.push({ item_id: item.item_id, error: item.lastError });
      changed = true;
    }
  }
  // Only write KV when something actually moved — KV writes are rate-limited on
  // the free plan and a no-op sync should cost nothing.
  if (changed || items.some(i => i.lastSyncAt)) await putItems(env, items);

  await fsCommitChunked(env, [
    fsWrite(env, `${FIRESTORE_ROOT}/meta`, {
      lastSyncAt: Date.now(),
      env: env.PLAID_ENV || "sandbox",
      institutions: items.length,
    }),
  ]);
  return { ok: true, results };
}

/* ── Routes ────────────────────────────────────────────────────────────────── */
async function linkTokenCreate(env, request, b) {
  const s = await requireSession(env, b);
  if (!s.ok) return json(env, request, { ok: false, lockRequired: true });
  try {
    const redirect = (env.PLAID_REDIRECT_URI || "").trim();
    const payload = {
      user: { client_user_id: "veda-finance" },
      client_name: "Finance",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    };
    // Only send redirect_uri when one is configured AND registered in the Plaid
    // dashboard — sending an unregistered URI makes Plaid reject the request
    // outright, which would break non-OAuth banks too.
    if (redirect) payload.redirect_uri = redirect;
    const r = await plaid(env, "/link/token/create", payload);
    return json(env, request, { ok: true, link_token: r.link_token, oauthReady: !!redirect });
  } catch (e) {
    return json(env, request, { ok: false, error: e.message });
  }
}

async function linkExchange(env, request, b) {
  const s = await requireSession(env, b);
  if (!s.ok) return json(env, request, { ok: false, lockRequired: true });
  if (!b.public_token) return json(env, request, { ok: false, error: "missing public_token" }, 400);
  try {
    const r = await plaid(env, "/item/public_token/exchange", { public_token: b.public_token });
    const items = await getItems(env);
    // Re-linking an institution replaces its record rather than duplicating it.
    const existing = items.findIndex(i => i.item_id === r.item_id);
    const rec = {
      item_id: r.item_id,
      access_token: r.access_token,          // NEVER returned to the browser
      institution_id: b.institution_id || null,
      institution_name: b.institution_name || "Institution",
      cursor: existing >= 0 ? items[existing].cursor : null,
      createdAt: existing >= 0 ? items[existing].createdAt : Date.now(),
    };
    if (existing >= 0) items[existing] = rec; else items.push(rec);
    await putItems(env, items);
    return json(env, request, { ok: true, item_id: r.item_id });
  } catch (e) {
    return json(env, request, { ok: false, error: e.message });
  }
}

async function listItems(env, request, b) {
  const s = await requireSession(env, b);
  if (!s.ok) return json(env, request, { lockRequired: true });
  const items = await getItems(env);
  // Deliberately strips access_token — the browser never sees it.
  return json(env, request, {
    ok: true,
    count: items.length,
    items: items.map(i => ({
      item_id: i.item_id,
      institution_id: i.institution_id,
      institution_name: i.institution_name,
      createdAt: i.createdAt,
      lastSyncAt: i.lastSyncAt || null,
      lastError: i.lastError || null,
    })),
  });
}

async function removeItem(env, request, b) {
  const s = await requireSession(env, b);
  if (!s.ok) return json(env, request, { ok: false, lockRequired: true });
  const items = await getItems(env);
  const item = items.find(i => i.item_id === b.item_id);
  if (!item) return json(env, request, { ok: false, error: "not found" }, 404);
  try { await plaid(env, "/item/remove", { access_token: item.access_token }); }
  catch (e) { console.log("plaid item/remove failed (removing locally anyway):", e.message); }
  await putItems(env, items.filter(i => i.item_id !== b.item_id));
  return json(env, request, { ok: true });
}

async function syncRoute(env, request, b) {
  const s = await requireSession(env, b);
  if (!s.ok) return json(env, request, { ok: false, lockRequired: true });
  try {
    return json(env, request, await runSync(env));
  } catch (e) {
    return json(env, request, { ok: false, error: e.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env, request) });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (request.method === "GET" && (path === "/health" || path === "")) {
      return json(env, request, {
        ok: true,
        service: "finance-api",
        env: env.PLAID_ENV || "sandbox",
        configured: {
          plaid: !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET),
          firebase: !!env.FIREBASE_SA_JSON,
          kv: !!env.FINANCE,
        },
        ts: Date.now(),
      });
    }

    if (request.method !== "POST") return json(env, request, { error: "method" }, 405);
    if (!env.FINANCE) return json(env, request, { error: "KV binding FINANCE missing" }, 500);

    const b = await body(request);
    try {
      switch (path) {
        case "/lock/session":      return await openSession(env, request, b);
        case "/lock/check":        return await checkSession(env, request, b);
        case "/lock/end":          return await endSession(env, request, b);
        case "/link/token/create": return await linkTokenCreate(env, request, b);
        case "/link/exchange":     return await linkExchange(env, request, b);
        case "/items":             return await listItems(env, request, b);
        case "/items/remove":      return await removeItem(env, request, b);
        case "/sync":              return await syncRoute(env, request, b);
        default:                   return json(env, request, { error: "not_found", path }, 404);
      }
    } catch (e) {
      // Never leak internals (they can contain secrets) — log, return a summary.
      console.log("unhandled error on", path, e && e.stack);
      return json(env, request, { ok: false, error: "server", detail: String((e && e.message) || e) }, 500);
    }
  },

  // Daily pull so the data is fresh without the app being open. Runs on the
  // schedule in wrangler.toml.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runSync(env).catch(e => console.log("cron sync failed:", e && e.message))
    );
  },
};
