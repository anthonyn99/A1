/* ============================================================================
 * studyos-api — Cloudflare Worker
 * ============================================================================
 * Two jobs, both on the FREE Workers plan:
 *
 *   1. APP LOCK AUTH  (HTTP)
 *      Owns the StudyOS password. Stores only a salted PBKDF2-SHA256 hash in
 *      Workers KV — never the password, and never anything the browser holds.
 *
 *   2. REMINDER CRON  (scheduled)
 *      Every minute, reads Firestore /reminders for anything due, sends it
 *      through FCM so it arrives with StudyOS CLOSED, then deletes the doc.
 *
 * ── ROUTES ────────────────────────────────────────────────────────────────
 *   GET  /health                     → { ok, kv, fcm }  (setup check)
 *   POST /auth/journal/set-lock      { journal, entryId, password, hint }
 *   POST /auth/journal/verify        { journal, entryId, password }
 *   POST /auth/journal/remove-lock   { journal, entryId, password }
 *   POST /auth/journal/update-hint   { journal, entryId, password, hint }
 *   POST /auth/journal/hint          { journal, entryId }        → { hint }
 *   POST /auth/reset/request         { journal, entryId }        → { code }
 *   POST /auth/reset/confirm         { journal, entryId, code, password, hint }
 *
 * ── BINDINGS (wrangler.toml / secrets) ────────────────────────────────────
 *   KV   TOKEN_CACHE            lock hashes, reset codes, cached Google token
 *   var  FIREBASE_PROJECT_ID    your Firebase project id
 *   sec  FIREBASE_CLIENT_EMAIL  service-account email   (wrangler secret put)
 *   sec  FIREBASE_PRIVATE_KEY   service-account private key
 *   var  ALLOWED_ORIGINS        comma-separated site origins allowed to call
 *
 * The cron half needs the two secrets. The App Lock half does NOT — deploy
 * without them and passwords work while push stays dormant.
 *
 * ── WHY THE RESET CODE COMES BACK IN THE RESPONSE ─────────────────────────
 * /auth/reset/request returns the code to the page, which emails it through
 * Formspree from the browser. That looks odd but grants an attacker nothing:
 * set-lock is itself unauthenticated (it is a personal single-user app), so
 * anyone who could call reset could already call set-lock. Browser-origin
 * email is the proven path; server-origin email would need another provider.
 * ========================================================================== */

const PBKDF2_ITER    = 100000;
const RESET_TTL      = 15 * 60;   // seconds a reset code stays valid
const RESET_MAX_TRIES = 6;        // wrong guesses before the code is burned

/* ── CORS ──────────────────────────────────────────────────────────────────
 * Echo the caller's origin when it is on the allow-list. Set ALLOWED_ORIGINS
 * to your real site once deployed; '*' is fine while testing but lets any page
 * attempt a password guess against your worker. */
function corsHeaders(origin, env) {
  const allowed = String((env && env.ALLOWED_ORIGINS) || '*')
    .split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || (origin && allowed.includes(origin));
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0] || 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
function json(body, origin, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
  });
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (path === '/health') {
      return json({
        ok: true,
        kv:  !!env.TOKEN_CACHE,
        fcm: !!(env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY && env.FIREBASE_PROJECT_ID),
      }, origin, env);
    }

    if (path.startsWith('/auth/')) return handleAuth(path, request, env, origin);

    return json({ ok: false, error: 'unknown route' }, origin, env, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};

/* ══ APP LOCK AUTH ═══════════════════════════════════════════════════════ */

const jKey = (journal, entryId) => `jlock:${journal}:${entryId}`;

async function getJSON(env, key) {
  try { return await env.TOKEN_CACHE.get(key, 'json'); } catch { return null; }
}

async function handleAuth(path, request, env, origin) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, origin, env, 405);
  if (!env.TOKEN_CACHE) return json({ ok: false, error: 'KV not bound' }, origin, env, 500);

  let body = {};
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'bad json' }, origin, env, 400); }

  const { journal, entryId, password, hint } = body;

  if (path === '/auth/journal/set-lock') {
    if (!journal || !entryId || !password) return json({ ok: false, error: 'missing fields' }, origin, env, 400);
    const rec = await makeHash(password);
    rec.hint = typeof hint === 'string' ? hint : '';
    await env.TOKEN_CACHE.put(jKey(journal, entryId), JSON.stringify(rec));
    return json({ ok: true }, origin, env);
  }

  if (path === '/auth/journal/verify') {
    if (!journal || !entryId || !password) return json({ ok: false }, origin, env);
    const rec = await getJSON(env, jKey(journal, entryId));
    if (!rec) return json({ ok: false, noLock: true }, origin, env);
    return json({ ok: await verifyHash(password, rec) }, origin, env);
  }

  if (path === '/auth/journal/remove-lock') {
    if (!journal || !entryId || !password) return json({ ok: false }, origin, env);
    const rec = await getJSON(env, jKey(journal, entryId));
    if (!rec) return json({ ok: true }, origin, env);          // already gone
    if (!(await verifyHash(password, rec))) return json({ ok: false }, origin, env);
    await env.TOKEN_CACHE.delete(jKey(journal, entryId));
    return json({ ok: true }, origin, env);
  }

  if (path === '/auth/journal/update-hint') {
    if (!journal || !entryId || !password) return json({ ok: false }, origin, env);
    const rec = await getJSON(env, jKey(journal, entryId));
    if (!rec || !(await verifyHash(password, rec))) return json({ ok: false }, origin, env);
    rec.hint = typeof hint === 'string' ? hint : '';
    await env.TOKEN_CACHE.put(jKey(journal, entryId), JSON.stringify(rec));
    return json({ ok: true }, origin, env);
  }

  if (path === '/auth/journal/hint') {
    if (!journal || !entryId) return json({ noLock: true }, origin, env);
    const rec = await getJSON(env, jKey(journal, entryId));
    if (!rec) return json({ noLock: true }, origin, env);
    return json({ ok: true, hint: rec.hint || '' }, origin, env);
  }

  /* ── Password reset by emailed code ─────────────────────────────────────── */
  if (path === '/auth/reset/request') {
    if (!journal || !entryId) return json({ ok: false, error: 'missing fields' }, origin, env, 400);
    const key  = jKey(journal, entryId);
    const lock = await getJSON(env, key);
    if (!lock) return json({ ok: false, noLock: true }, origin, env);
    const code = genResetCode();
    await env.TOKEN_CACHE.put('reset:' + key,
      JSON.stringify({ code: await makeHash(code), exp: Date.now() + RESET_TTL * 1000, tries: 0 }),
      { expirationTtl: RESET_TTL });
    return json({ ok: true, code }, origin, env);
  }

  if (path === '/auth/reset/confirm') {
    const code = String(body.code || '').trim().toUpperCase();
    if (!journal || !entryId || !code || !password) return json({ ok: false, error: 'missing fields' }, origin, env, 400);
    const key = jKey(journal, entryId);
    const rr  = await getJSON(env, 'reset:' + key);
    if (!rr) return json({ ok: false, error: 'expired' }, origin, env);
    if (Date.now() > (rr.exp || 0)) {
      await env.TOKEN_CACHE.delete('reset:' + key);
      return json({ ok: false, error: 'expired' }, origin, env);
    }
    if (!(await verifyHash(code, rr.code))) {
      rr.tries = (rr.tries || 0) + 1;
      if (rr.tries >= RESET_MAX_TRIES) {
        await env.TOKEN_CACHE.delete('reset:' + key);
        return json({ ok: false, error: 'locked' }, origin, env);
      }
      // Preserve the ORIGINAL window rather than resetting the TTL on each try,
      // so guessing can't keep a code alive indefinitely.
      const remainingTtl = Math.max(60, Math.ceil(((rr.exp || 0) - Date.now()) / 1000));
      await env.TOKEN_CACHE.put('reset:' + key, JSON.stringify(rr), { expirationTtl: remainingTtl });
      return json({ ok: false, error: 'badcode', remaining: RESET_MAX_TRIES - rr.tries }, origin, env);
    }
    const newRec = await makeHash(password);
    newRec.hint = typeof hint === 'string' ? hint : '';
    await env.TOKEN_CACHE.put(key, JSON.stringify(newRec));
    await env.TOKEN_CACHE.delete('reset:' + key);
    return json({ ok: true }, origin, env);
  }

  return json({ ok: false, error: 'unknown route' }, origin, env, 404);
}

/* ══ PASSWORD HASHING ════════════════════════════════════════════════════ */

function b64(bytes) { let s = ''; new Uint8Array(bytes).forEach(b => s += String.fromCharCode(b)); return btoa(s); }
function fromB64(str) { return Uint8Array.from(atob(str), c => c.charCodeAt(0)); }

async function pbkdf2(password, saltBytes, iter) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: iter, hash: 'SHA-256' }, km, 256);
  return new Uint8Array(bits);
}

async function makeHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: b64(await pbkdf2(password, salt, PBKDF2_ITER)), salt: b64(salt), iter: PBKDF2_ITER };
}

async function verifyHash(password, rec) {
  if (!rec || !rec.hash || !rec.salt) return false;
  const got  = await pbkdf2(password, fromB64(rec.salt), rec.iter || PBKDF2_ITER);
  const want = fromB64(rec.hash);
  if (got.length !== want.length) return false;
  // Constant-time compare: never leak how much of the hash matched via timing.
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

function genResetCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I, L, O, 0, 1
  const r = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[r[i] % alphabet.length];
  return s;
}

/* ══ REMINDER CRON ═══════════════════════════════════════════════════════
 * Reads only a NARROW due-window each tick. An unbounded query would return —
 * and bill for — up to 100 future-dated docs every single minute; bounding the
 * upper edge means a normal tick reads 0–2 docs.
 *
 *   lower: now - 90s   (covers a missed tick / clock skew)
 *   upper: now + 60s   (anything due before the next tick)
 *
 * Once an hour the lower bound widens to -2h to recover reminders that were
 * missed entirely (worker hiccup), without paying that read cost every tick.
 * ════════════════════════════════════════════════════════════════════════ */
async function runReminders(env) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    return;   // push not configured — nothing to do, and nothing to warn about
  }

  const now = Date.now();
  let accessToken;
  try { accessToken = await getGoogleAccessToken(env); }
  catch (e) { console.error('[reminders] auth failed:', e.message); return; }

  const projectId = env.FIREBASE_PROJECT_ID;
  const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const authHdr   = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  const staleSweep = new Date(now).getUTCMinutes() === 0;
  const lower = staleSweep ? now - 2 * 60 * 60 * 1000 : now - 90 * 1000;
  const upper = now + 60 * 1000;

  // Single-field range filter on notifyAt → no composite index required.
  const queryRes = await fetch(`${baseUrl}:runQuery`, {
    method: 'POST', headers: authHdr,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'reminders' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'notifyAt' }, op: 'GREATER_THAN_OR_EQUAL', value: { integerValue: String(lower) } } },
              { fieldFilter: { field: { fieldPath: 'notifyAt' }, op: 'LESS_THAN_OR_EQUAL',    value: { integerValue: String(upper) } } },
            ],
          },
        },
        orderBy: [{ field: { fieldPath: 'notifyAt' }, direction: 'ASCENDING' }],
        limit: 50,
      },
    }),
  });
  if (!queryRes.ok) { console.error('[reminders] query failed:', await queryRes.text()); return; }

  const results = await queryRes.json();
  if (!Array.isArray(results)) return;

  const due = results.filter(r => r.document);
  if (!due.length) return;
  console.log(`[reminders] tick read ${due.length} doc(s) | window ${staleSweep ? '-2h' : '-90s'}..+60s`);

  // Fetch device tokens only when something is actually due.
  let tokens = [];
  try {
    const tRes = await fetch(`${baseUrl}/fcm_tokens`, { headers: authHdr });
    if (tRes.ok) {
      const tj = await tRes.json();
      tokens = (tj.documents || [])
        .map(d => d.fields?.token?.stringValue)
        .filter(Boolean);
    }
  } catch (e) { console.warn('[reminders] token fetch failed:', e.message); }

  if (!tokens.length) { console.warn('[reminders] no device tokens registered'); return; }

  for (const r of due) {
    const f     = r.document.fields || {};
    const id    = f.id?.stringValue || '';
    const title = f.title?.stringValue || 'StudyOS reminder';
    const bodyT = f.body?.stringValue || 'StudyOS';

    let delivered = false;
    for (const token of tokens) {
      try { await sendFCM(projectId, token, title, bodyT, id, accessToken); delivered = true; }
      catch (e) {
        // An unregistered token is a device that uninstalled or cleared data.
        // Not an error worth retrying — just note it and move on.
        console.warn('[reminders] send failed:', e.message);
      }
    }
    // Delete once handled so it can never fire twice. Deleting even when every
    // send failed is deliberate: a permanently-undeliverable reminder would
    // otherwise be retried every tick for two hours.
    try {
      await fetch(`https://firestore.googleapis.com/v1/${r.document.name}`, { method: 'DELETE', headers: authHdr });
    } catch (e) { console.warn('[reminders] delete failed:', e.message); }
    if (delivered) console.log(`[reminders] sent "${title}" (${id})`);
  }
}

async function sendFCM(projectId, token, title, body, id, accessToken) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        // DATA-ONLY (no `notification` block). This guarantees the service
        // worker's onBackgroundMessage runs for EVERY message and draws it with
        // a unique tag, so several same-minute reminders can't be collapsed or
        // silently dropped by the browser's auto-display path.
        data: { id: String(id || ''), title: String(title), body: String(body), app: 'studyos' },
        android: { priority: 'high' },
        // A UNIQUE Topic per message stops the push service coalescing two
        // reminders fired at the same instant to the same device.
        webpush: { headers: { Urgency: 'high', TTL: '600', Topic: crypto.randomUUID().replace(/-/g, '') } },
      },
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error?.message || String(res.status));
  }
}

/* ══ GOOGLE SERVICE-ACCOUNT TOKEN ════════════════════════════════════════
 * Signs a JWT with the service-account key and exchanges it for an access
 * token. Cached in memory and KV so a normal tick makes no token call at all.
 * ════════════════════════════════════════════════════════════════════════ */
let _memToken = null;

async function getGoogleAccessToken(env) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (_memToken && _memToken.expiresAt > nowSec + 300) return _memToken.token;

  if (env.TOKEN_CACHE) {
    try {
      const kv = await env.TOKEN_CACHE.get('gat', 'json');
      if (kv && kv.expiresAt > nowSec + 300) { _memToken = kv; return kv.token; }
    } catch (e) { console.warn('[reminders] KV read error:', e.message); }
  }

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim  = b64url(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec, exp: nowSec + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore',
  }));
  const payload = `${header}.${claim}`;

  // Robust PEM parsing. A pasted secret arrives in several broken shapes:
  //   • real newlines (correct)          • literal "\n" two-char sequences
  //   • base64url chars (-/_) for +//    • stray wrapping quotes
  // Normalize all of them so a slightly-mangled secret still works.
  const raw = (env.FIREBASE_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/^['"]|['"]$/g, '');
  const pemBody = raw
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+').replace(/_/g, '/')
    .trim();
  if (!pemBody || pemBody.length < 100) {
    throw new Error('FIREBASE_PRIVATE_KEY empty or too short after parsing — re-upload the secret');
  }

  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(payload));
  const jwt = `${payload}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const j = await res.json();

  const entry = { token: j.access_token, expiresAt: nowSec + 3600 };
  _memToken = entry;
  if (env.TOKEN_CACHE) {
    try { await env.TOKEN_CACHE.put('gat', JSON.stringify(entry), { expirationTtl: 3300 }); }
    catch (e) { console.warn('[reminders] KV write error:', e.message); }
  }
  return entry.token;
}

function b64url(data) {
  const b = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = ''; b.forEach(x => s += String.fromCharCode(x));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
