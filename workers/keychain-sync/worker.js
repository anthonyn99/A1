// ─────────────────────────────────────────────────────────────────────────────
// keychain-sync — Firestore proxy for the Vault browser extension.
//
// WHY THIS EXISTS
// The Firebase project (task-dashboard-d2b53) enforces App Check (reCAPTCHA v3).
// That blocks direct Firestore access from any non-registered origin — including
// a chrome-extension:// page — even with a valid anonymous ID token. A browser
// extension cannot mint a reCAPTCHA v3 App Check token.
//
// So Vault talks to this Worker instead. The Worker authenticates to Firestore
// with the Firebase **service account** (same secrets pattern as
// taskhub-reminders), which bypasses both App Check and security rules. It reads
// and writes the single shared document:
//
//     dashboards/keychain  →  { connections, colmap, savedAt }
//
// which is the exact same document the Index app's Keychain uses — so Vault and
// Keychain stay in perfect sync, both directions.
//
// ENDPOINTS  (all require header  X-Vault-Key: <VAULT_KEY secret>)
//   GET  /keychain   → { connections, colmap, savedAt }
//   PUT  /keychain   ← { connections, colmap }   (savedAt stamped server-side)
//
// SECRETS (wrangler secret put …): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
//   FIREBASE_PRIVATE_KEY, VAULT_KEY
// ─────────────────────────────────────────────────────────────────────────────

const DOC_PATH = "dashboards/keychain";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Vault-Key",
  "Access-Control-Max-Age": "86400"
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname !== "/keychain" && url.pathname !== "/") {
      return json({ error: "not found" }, 404);
    }

    // Shared-key gate — Keychain holds sensitive data, so the proxy is not public.
    if (!env.VAULT_KEY || request.headers.get("X-Vault-Key") !== env.VAULT_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    const projectId = env.FIREBASE_PROJECT_ID;
    const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${DOC_PATH}`;

    try {
      const token = await getGoogleAccessToken(env);

      if (request.method === "GET") {
        const r = await fetch(docUrl, { headers: { Authorization: "Bearer " + token } });
        if (r.status === 404) return json({ connections: [], colmap: null, savedAt: 0 });
        if (!r.ok) return json({ error: "firestore read " + r.status, detail: await r.text() }, 502);
        const doc = await r.json();
        const f = doc.fields || {};
        return json({
          connections: f.connections ? decode(f.connections) : [],
          colmap: f.colmap ? decode(f.colmap) : null,
          savedAt: f.savedAt ? decode(f.savedAt) : 0
        });
      }

      if (request.method === "PUT") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const connections = sanitize(Array.isArray(body.connections) ? body.connections : []);
        const colmap = Array.isArray(body.colmap) && body.colmap.length ? body.colmap : null;
        const payload = {
          fields: {
            connections: encode(connections),
            colmap: encode(colmap),
            savedAt: encode(Date.now())
          }
        };
        const r = await fetch(docUrl, {
          method: "PATCH",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!r.ok) return json({ error: "firestore write " + r.status, detail: await r.text() }, 502);
        return json({ ok: true, savedAt: payload.fields.savedAt.integerValue });
      }

      return json({ error: "method not allowed" }, 405);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};

// ── Firestore typed-value <-> plain JS ────────────────────────────────────────
function encode(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number")
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === "string") return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(encode) } };
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) { if (v !== undefined) fields[k] = encode(v); }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function decode(v) {
  if (!v || typeof v !== "object") return v;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  if ("mapValue" in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = decode(val);
    return out;
  }
  return v;
}

function sanitize(obj) {
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = sanitize(v);
    return out;
  }
  return obj;
}

// ── Service-account → Google access token (bypasses App Check + rules) ────────
// Verbatim pattern from workers/taskhub-reminders/worker.js.
let _memToken = null;

async function getGoogleAccessToken(env) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (_memToken && _memToken.expiresAt > nowSec + 300) return _memToken.token;

  if (env.TOKEN_CACHE) {
    try {
      const kv = await env.TOKEN_CACHE.get("gat", "json");
      if (kv && kv.expiresAt > nowSec + 300) { _memToken = kv; return kv.token; }
    } catch (e) { console.warn("KV read error:", e.message); }
  }

  const now = nowSec;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL, sub: env.FIREBASE_CLIENT_EMAIL,
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
    scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore"
  }));
  const payload = `${header}.${claim}`;
  let raw = (env.FIREBASE_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n").replace(/\\r/g, "").replace(/^['"]|['"]$/g, "");
  const pemBody = raw
    .replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").trim();
  if (!pemBody || pemBody.length < 100)
    throw new Error("FIREBASE_PRIVATE_KEY empty/too short after parsing — re-upload the secret");
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", keyBytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(payload));
  const jwt = `${payload}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const j = await res.json();
  const entry = { token: j.access_token, expiresAt: now + 3600 };
  _memToken = entry;
  if (env.TOKEN_CACHE) {
    try { await env.TOKEN_CACHE.put("gat", JSON.stringify(entry), { expirationTtl: 3300 }); }
    catch (e) { console.warn("KV write error:", e.message); }
  }
  return entry.token;
}

function b64url(data) {
  const b = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = ""; b.forEach(x => s += String.fromCharCode(x));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
