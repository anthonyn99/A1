// ============================================================================
// index-backups — Cloudflare Worker (free plan, Workers KV)
//
// WHY THIS EXISTS
// A1Backup keeps an encrypted copy of the Index data on each device, in that
// device's IndexedDB. That survives Firebase losing the data — but not the
// device being lost, stolen, wiped or simply left in a drawer. It also means
// no device can see whether any OTHER device is still backing up, which is how
// a silent failure hides.
//
// This is the off-device sink. Every device pushes its encrypted snapshot here,
// and a script on a desktop later folds those into `Index Backups/` in the repo
// so there is a copy that outlives all of the hardware.
//
// WHAT THIS WORKER CAN AND CANNOT SEE
// Nothing here is readable. Compression and AES-256-GCM happen in the browser,
// against a passphrase this Worker never receives, so every value it stores is
// ciphertext. A total compromise of this Worker leaks sizes and timestamps —
// not tasks, not journals, not passwords. That is deliberate: it is what makes
// it acceptable for these same bytes to end up in a PUBLIC git repository.
//
// LIMITS (free Workers plan, and the reason for the caps below)
//   KV: 1 GB total, 25 MB per value, ~1000 writes/day, 100k reads/day.
// The client already debounces to 10 minutes and caps itself at 60 pushes per
// device per day. Retention here bounds storage from the other end.
//
// Routes
//   GET    /health                      → status
//   GET    /index                       → devices, timestamps, sizes (no content)
//   PUT    /s/<device>                  → store that device's latest snapshot
//   GET    /s/<device>                  → fetch it back (restore, or a pull)
//   PUT    /o/<hash>                    → store one content-addressed object
//   GET    /o/<hash>                    → fetch one object
//   POST   /lease/<name>                → elect one device for a periodic job
//
// Bindings (wrangler.toml):
//   [[kv_namespaces]] binding = "A1_BACKUPS"
// ============================================================================

const KEEP_SNAPSHOTS = 14;          // per device; mirrors A1B_KEEP_CORES
const MAX_VALUE = 24 * 1024 * 1024; // under KV's 25 MB ceiling
const LEASE_MS = 20 * 60 * 60 * 1000;

const ALLOWED_ORIGINS = [
  'https://anthonyn99.github.io',
];

function cors(origin) {
  // Echo only an allowed origin. The payload is encrypted, but there is no
  // reason to let any page on the internet enumerate backup metadata.
  const ok = ALLOWED_ORIGINS.indexOf(origin) >= 0;
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Firebase-AppCheck',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(obj, status, c) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...(c || {}) },
  });
}

// Device and object names come from the client. Keep them tame so a bad request
// cannot reach odd KV keys or walk out of its own prefix.
const safeName = (s) => (/^[A-Za-z0-9._-]{1,120}$/.test(s || '') ? s : null);

// ─── BEGIN GENERATED: appcheck (workers/_shared/appcheck.js) ───
// Do not edit here — edit the canonical copy and run tools/sync-appcheck.js
/* Firebase App Check verification for Cloudflare Workers.
 *
 * WHY THIS EXISTS
 * These Workers are called from pages hosted on GitHub Pages out of a PUBLIC
 * repo, so there is no such thing as a secret the client can hold — any key in
 * the page, or in the browser extension, is world-readable the moment it is
 * committed. That is why several of them ended up with no auth at all rather
 * than weak auth.
 *
 * An App Check token is the one credential that works here: it is minted at
 * runtime by reCAPTCHA against the registered origin, never stored anywhere,
 * and cannot be obtained by someone who is not actually running the app. It is
 * already enforced on Firebase for this project, so this extends the same
 * barrier to the Workers instead of inventing a second scheme.
 *
 * WHAT IT IS NOT
 * App Check attests "this request came from your app", not "this is Tony". It
 * stops strangers, not a person sitting at an unlocked machine. Anything
 * needing per-profile separation still needs the passcode.
 *
 * Canonical copy: workers/_shared/appcheck.js
 * Injected into each worker by tools/sync-appcheck.js — edit HERE, never in a
 * worker, then re-run the sync.
 */

// Firebase project number (messagingSenderId), not the project id.
const APPCHECK_PROJECT_NUM = '982539604706';
const APPCHECK_JWKS_URL = 'https://firebaseappcheck.googleapis.com/v1/jwks';
const APPCHECK_JWKS_TTL = 60 * 60 * 1000;

let _acJwks = null;
let _acJwksAt = 0;

function _acB64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _acB64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(_acB64urlToBytes(s)));
}

async function _acKeys() {
  // Cached in module scope: an isolate handles many requests, and refetching
  // the key set per request would add a round trip to every call.
  if (_acJwks && Date.now() - _acJwksAt < APPCHECK_JWKS_TTL) return _acJwks;
  const r = await fetch(APPCHECK_JWKS_URL);
  if (!r.ok) throw new Error('jwks ' + r.status);
  const j = await r.json();
  _acJwks = j.keys || [];
  _acJwksAt = Date.now();
  return _acJwks;
}

/** Verify an App Check JWT. Returns true only if every check passes. */
async function verifyAppCheckToken(token) {
  try {
    if (typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h64, p64, s64] = parts;

    const header = _acB64urlToJson(h64);
    // Pin the algorithm. Accepting whatever the token names is how "alg: none"
    // and HMAC-with-the-public-key forgeries get in.
    if (header.alg !== 'RS256' || header.typ !== 'JWT' || !header.kid) return false;

    const keys = await _acKeys();
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      _acB64urlToBytes(s64),
      new TextEncoder().encode(h64 + '.' + p64)
    );
    if (!ok) return false;

    const p = _acB64urlToJson(p64);
    const now = Math.floor(Date.now() / 1000);
    // A valid signature over someone ELSE's project is still not our token, so
    // audience and issuer are as load-bearing as the signature itself.
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes('projects/' + APPCHECK_PROJECT_NUM)) return false;
    if (p.iss !== 'https://firebaseappcheck.googleapis.com/' + APPCHECK_PROJECT_NUM) return false;
    if (!p.exp || p.exp <= now) return false;
    if (p.iat && p.iat > now + 300) return false;   // clock skew, not the future
    return true;
  } catch {
    return false;
  }
}

/** Guard for a request. Returns null when allowed, or a 401 Response. */
async function requireAppCheck(request, cors) {
  const tok = request.headers.get('X-Firebase-AppCheck');
  if (await verifyAppCheckToken(tok)) return null;
  return new Response(
    JSON.stringify({ ok: false, error: 'unauthorized', hint: 'App Check token required' }),
    { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...(cors || {}) } }
  );
}
// ─── END GENERATED: appcheck ───

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const c = cors(request.headers.get('Origin') || '');
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    if (path === '/health') return json({ ok: true, service: 'index-backups' }, 200, c);

    if (!env.A1_BACKUPS) return json({ ok: false, error: 'kv-not-bound' }, 500, c);

    // Everything past here is gated. These Workers are called from a public
    // repo's pages, so there is no secret the client can hold; App Check
    // attests "this request came from the app" and is the only real gate.
    const denied = await requireAppCheck(request, c);
    if (denied) return denied;

    // ── /index — what exists, without revealing any of it ────────────────
    if (path === '/index' && request.method === 'GET') {
      const list = await env.A1_BACKUPS.list({ prefix: 's/' });
      const devices = {};
      for (const k of list.keys) {
        const m = /^s\/([^/]+)\/(\d+)$/.exec(k.name);
        if (!m) continue;
        const d = m[1], at = Number(m[2]);
        const meta = k.metadata || {};
        if (!devices[d] || at > devices[d].at) {
          devices[d] = { at, bytes: meta.bytes || null, docs: meta.docs || null };
        }
        devices[d].count = (devices[d].count || 0) + 1;
      }
      return json({ ok: true, devices, now: Date.now() }, 200, c);
    }

    // ── /s/<device> — a device's snapshot ────────────────────────────────
    const sm = /^\/s\/([^/]+)$/.exec(path);
    if (sm) {
      const device = safeName(sm[1]);
      if (!device) return json({ ok: false, error: 'bad-device' }, 400, c);

      if (request.method === 'PUT') {
        const body = await request.text();
        if (body.length > MAX_VALUE) {
          return json({ ok: false, error: 'too-large', bytes: body.length, max: MAX_VALUE }, 413, c);
        }
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) {
          return json({ ok: false, error: 'not-json' }, 400, c);
        }
        // Refuse anything that is not an encrypted envelope. The Worker cannot
        // read the contents and must never become a place plaintext can land
        // by accident.
        if (!parsed || parsed.alg !== 'AES-256-GCM' || !parsed.ct || !parsed.iv) {
          return json({ ok: false, error: 'not-encrypted' }, 400, c);
        }
        const at = Date.now();
        await env.A1_BACKUPS.put('s/' + device + '/' + at, body, {
          metadata: { bytes: body.length, docs: parsed.docs || null, at },
        });

        // Retention, so storage is bounded from this end too. Oldest first,
        // and only ever beyond the keep count — this deletes copies, never the
        // newest one.
        const mine = await env.A1_BACKUPS.list({ prefix: 's/' + device + '/' });
        const stamps = mine.keys.map((k) => k.name).sort();
        const excess = stamps.length - KEEP_SNAPSHOTS;
        for (let i = 0; i < excess; i++) await env.A1_BACKUPS.delete(stamps[i]);

        return json({ ok: true, at, kept: Math.min(stamps.length, KEEP_SNAPSHOTS) }, 200, c);
      }

      if (request.method === 'GET') {
        const want = url.searchParams.get('at');
        const mine = await env.A1_BACKUPS.list({ prefix: 's/' + device + '/' });
        if (!mine.keys.length) return json({ ok: false, error: 'no-snapshots' }, 404, c);
        const names = mine.keys.map((k) => k.name).sort();
        const key = want ? 's/' + device + '/' + want : names[names.length - 1];
        const val = await env.A1_BACKUPS.get(key);
        if (val == null) return json({ ok: false, error: 'not-found' }, 404, c);
        return new Response(val, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...c },
        });
      }
    }

    // ── /o/<hash> — one content-addressed object ─────────────────────────
    // Named by a hash of its own plaintext, so an unchanged document is stored
    // exactly once no matter how many times it is captured.
    const om = /^\/o\/([^/]+)$/.exec(path);
    if (om) {
      const hash = safeName(om[1]);
      if (!hash) return json({ ok: false, error: 'bad-hash' }, 400, c);

      if (request.method === 'PUT') {
        const existing = await env.A1_BACKUPS.get('o/' + hash);
        if (existing != null) return json({ ok: true, deduped: true }, 200, c);
        const body = await request.text();
        if (body.length > MAX_VALUE) return json({ ok: false, error: 'too-large' }, 413, c);
        await env.A1_BACKUPS.put('o/' + hash, body, { metadata: { bytes: body.length } });
        return json({ ok: true, stored: true }, 200, c);
      }
      if (request.method === 'GET') {
        const val = await env.A1_BACKUPS.get('o/' + hash);
        if (val == null) return json({ ok: false, error: 'not-found' }, 404, c);
        return new Response(val, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...c },
        });
      }
    }

    // ── /lease/<name> — elect ONE device for a periodic job ──────────────
    // Three devices each running the same daily read pass would triple its
    // Firestore cost for no benefit. Whoever wins the lease does the work.
    const lm = /^\/lease\/([^/]+)$/.exec(path);
    if (lm && request.method === 'POST') {
      const name = safeName(lm[1]);
      if (!name) return json({ ok: false, error: 'bad-lease' }, 400, c);
      let who = '';
      try { who = String(((await request.json()) || {}).device || ''); } catch (e) {}
      if (!safeName(who)) return json({ ok: false, error: 'bad-device' }, 400, c);

      const cur = await env.A1_BACKUPS.get('lease/' + name, { type: 'json' });
      const now = Date.now();
      if (cur && cur.until > now && cur.device !== who) {
        return json({ ok: true, granted: false, holder: cur.device, until: cur.until }, 200, c);
      }
      const next = { device: who, until: now + LEASE_MS };
      await env.A1_BACKUPS.put('lease/' + name, JSON.stringify(next),
        { expirationTtl: Math.ceil(LEASE_MS / 1000) + 60 });
      return json({ ok: true, granted: true, until: next.until }, 200, c);
    }

    return json({ ok: false, error: 'not-found' }, 404, c);
  },
};
