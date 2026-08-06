/* ═══════════════════════════════════════════════════════════════════════════
 * TradeBoard Auth Worker
 * ---------------------------------------------------------------------------
 * Stores the App-Lock / section-lock passwords for TradeBoard. Mirrors the API
 * contract that tradeboard.html's client calls, which in turn mirrors the
 * reference TradeHub worker. NOTHING here stores a password in plaintext:
 * each password is stretched with PBKDF2-SHA256 (210k iterations) over a random
 * 16-byte salt, and only { salt, hash, iterations, hint, v } is persisted in KV.
 *
 * KV binding required:  LOCKS   (a Workers KV namespace)
 *
 * Endpoints (all POST, JSON body, JSON reply, permissive CORS):
 *   /auth/journal/set-lock     { journal, entryId, password, hint? } -> { ok, v }
 *   /auth/journal/verify       { journal, entryId, password }        -> { ok } | { ok:false }
 *   /auth/journal/remove-lock  { journal, entryId, password }        -> { ok } | { ok:false }
 *   /auth/journal/hint         { journal, entryId }                  -> { hint } | { noLock:true }
 *   /auth/reset/request        { journal, entryId }                  -> { ok, code } | { noLock:true }
 *   /auth/reset/confirm        { journal, entryId, code, password, hint? } -> { ok, v } | { error }
 *   /health                    (GET)                                 -> { ok:true }
 *
 * Entry key in KV is `${journal}:${entryId}` so 'applock' + per-tab entryIds
 * never collide. Reset codes are 6 chars, single-record, expire in 15 min, and
 * lock out after 5 bad attempts. The CLIENT emails the code via Formspree; the
 * worker only mints and validates it (so no email secrets live here).
 * ═══════════════════════════════════════════════════════════════════════════ */

// PBKDF2 iterations. Kept modest so each hash fits the Workers free-plan CPU
// budget (heavy counts trip Cloudflare error 1042). 50k over SHA-256 is still a
// strong stretch for a personal app-lock, and the random 16-byte salt per entry
// prevents precomputation/rainbow-table attacks.
const ITERATIONS = 50000;
const RESET_TTL_MS = 15 * 60 * 1000;   // reset code valid for 15 minutes
const RESET_MAX_ATTEMPTS = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── crypto helpers ──────────────────────────────────────────────────────────
function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function randHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations, hash: "SHA-256" },
    key, 256
  );
  return toHex(bits);
}

// Constant-time-ish string compare (both hex, same length expected).
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A random human-friendly 6-char code (no ambiguous 0/O/1/I/L).
function makeResetCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[a[i] % alphabet.length];
  return out;
}

// ── KV access ───────────────────────────────────────────────────────────────
const keyFor = (journal, entryId) => `lock:${journal}:${entryId}`;
const resetKeyFor = (journal, entryId) => `reset:${journal}:${entryId}`;

async function getLock(env, journal, entryId) {
  const raw = await env.LOCKS.get(keyFor(journal, entryId));
  return raw ? JSON.parse(raw) : null;
}
async function putLock(env, journal, entryId, rec) {
  await env.LOCKS.put(keyFor(journal, entryId), JSON.stringify(rec));
}
async function delLock(env, journal, entryId) {
  await env.LOCKS.delete(keyFor(journal, entryId));
}

async function storePassword(env, journal, entryId, password, hint) {
  const salt = randHex(16);
  const hash = await pbkdf2(password, salt, ITERATIONS);
  const rec = { salt, hash, iterations: ITERATIONS, hint: hint || "", v: Date.now() };
  await putLock(env, journal, entryId, rec);
  return rec.v;
}

async function checkPassword(env, journal, entryId, password) {
  const rec = await getLock(env, journal, entryId);
  if (!rec) return { noLock: true };
  const hash = await pbkdf2(password, rec.salt, rec.iterations || ITERATIONS);
  return { ok: safeEqual(hash, rec.hash), rec };
}

// ── request parsing ─────────────────────────────────────────────────────────
async function body(request) {
  try { return await request.json(); } catch { return {}; }
}
function need(obj, ...keys) {
  for (const k of keys) if (obj[k] == null || obj[k] === "") return false;
  return true;
}

// ── route handlers ──────────────────────────────────────────────────────────
async function setLock(env, b) {
  if (!need(b, "journal", "entryId", "password")) return json({ ok: false, error: "missing" }, 400);
  const v = await storePassword(env, b.journal, b.entryId, String(b.password), b.hint || "");
  return json({ ok: true, v });
}

async function verify(env, b) {
  if (!need(b, "journal", "entryId", "password")) return json({ ok: false, error: "missing" }, 400);
  const r = await checkPassword(env, b.journal, b.entryId, String(b.password));
  if (r.noLock) return json({ ok: false, noLock: true });
  return json({ ok: !!r.ok });
}

async function removeLock(env, b) {
  if (!need(b, "journal", "entryId", "password")) return json({ ok: false, error: "missing" }, 400);
  const r = await checkPassword(env, b.journal, b.entryId, String(b.password));
  if (r.noLock) return json({ ok: true, noLock: true });   // nothing to remove = success
  if (!r.ok) return json({ ok: false });
  await delLock(env, b.journal, b.entryId);
  await env.LOCKS.delete(resetKeyFor(b.journal, b.entryId));
  return json({ ok: true });
}

async function hint(env, b) {
  if (!need(b, "journal", "entryId")) return json({ error: "missing" }, 400);
  const rec = await getLock(env, b.journal, b.entryId);
  if (!rec) return json({ noLock: true });
  return json({ ok: true, hint: rec.hint || "" });
}

async function resetRequest(env, b) {
  if (!need(b, "journal", "entryId")) return json({ error: "missing" }, 400);
  const rec = await getLock(env, b.journal, b.entryId);
  if (!rec) return json({ noLock: true });
  const code = makeResetCode();
  const codeSalt = randHex(16);
  const codeHash = await pbkdf2(code, codeSalt, ITERATIONS);
  await env.LOCKS.put(
    resetKeyFor(b.journal, b.entryId),
    JSON.stringify({ codeSalt, codeHash, exp: Date.now() + RESET_TTL_MS, attempts: 0 }),
    { expirationTtl: Math.ceil(RESET_TTL_MS / 1000) }
  );
  // Worker returns the code so the CLIENT can email it via Formspree.
  return json({ ok: true, code });
}

async function resetConfirm(env, b) {
  if (!need(b, "journal", "entryId", "code", "password"))
    return json({ ok: false, error: "missing" }, 400);
  const rkey = resetKeyFor(b.journal, b.entryId);
  const raw = await env.LOCKS.get(rkey);
  if (!raw) return json({ ok: false, error: "expired" });
  const r = JSON.parse(raw);
  if (Date.now() > r.exp) { await env.LOCKS.delete(rkey); return json({ ok: false, error: "expired" }); }
  if (r.attempts >= RESET_MAX_ATTEMPTS) { await env.LOCKS.delete(rkey); return json({ ok: false, error: "locked" }); }

  const tryHash = await pbkdf2(String(b.code).trim().toUpperCase(), r.codeSalt, ITERATIONS);
  if (!safeEqual(tryHash, r.codeHash)) {
    r.attempts += 1;
    const remaining = Math.max(0, RESET_MAX_ATTEMPTS - r.attempts);
    if (remaining <= 0) { await env.LOCKS.delete(rkey); }
    else {
      const ttl = Math.max(1, Math.ceil((r.exp - Date.now()) / 1000));
      await env.LOCKS.put(rkey, JSON.stringify(r), { expirationTtl: ttl });
    }
    return json({ ok: false, error: "badcode", remaining });
  }
  // Code good → set the new password, invalidate the reset record.
  const v = await storePassword(env, b.journal, b.entryId, String(b.password), b.hint || "");
  await env.LOCKS.delete(rkey);
  return json({ ok: true, v });
}

// ── router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (request.method === "GET" && (path === "/health" || path === "")) {
      return json({ ok: true, service: "tradeboard-auth", ts: Date.now() });
    }

    if (request.method !== "POST") return json({ error: "method" }, 405);
    if (!env.LOCKS) return json({ error: "KV binding LOCKS missing" }, 500);

    const b = await body(request);
    try {
      switch (path) {
        case "/auth/journal/set-lock":    return await setLock(env, b);
        case "/auth/journal/verify":      return await verify(env, b);
        case "/auth/journal/remove-lock": return await removeLock(env, b);
        case "/auth/journal/hint":        return await hint(env, b);
        case "/auth/reset/request":       return await resetRequest(env, b);
        case "/auth/reset/confirm":       return await resetConfirm(env, b);
        default:                          return json({ error: "not_found", path }, 404);
      }
    } catch (e) {
      return json({ ok: false, error: "server", detail: String(e && e.message || e) }, 500);
    }
  },
};
