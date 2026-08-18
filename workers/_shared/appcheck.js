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
