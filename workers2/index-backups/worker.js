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
//   KV: 1 GB total, 25 MB per value, ~1000 writes/day, 100k reads/day — all
//   PER ACCOUNT. This Worker runs on account 2 (av1-2.workers.dev) for exactly
//   that reason: it was account 1's fastest-growing writer, going from nothing
//   to ~105 writes/day within a week as more devices started backing up.
// The client already debounces to 10 minutes and caps itself at 60 pushes per
// device per day. Retention here bounds storage from the other end.
//
// STORAGE IS BOUNDED AT BOTH ENDS — it was not always
//   Snapshots: KEEP_SNAPSHOTS per device, oldest evicted on write.
//   Objects:   collected when no surviving snapshot references them.
// The second half was missing, and the gap was not small: by the time it was
// noticed, 316 of 467 objects — 22 MB of the 30 MB stored, 73% — were reachable
// from nothing at all. Every edit to any document left its previous version
// behind forever, and the only thing that would ever have stopped it was KV's
// 1 GB ceiling. See collectOrphans().
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
// Auth: App Check for the app; or `Authorization: Bearer <PULL_SECRET>` for
// READ-ONLY pulls by tools/pull-backups.mjs, which has no browser to mint a
// token with. Set with: wrangler secret put PULL_SECRET
//
// Bindings (wrangler.toml):
//   [[kv_namespaces]] binding = "A1_BACKUPS"
// ============================================================================

const KEEP_SNAPSHOTS = 14;          // per device; mirrors A1B_KEEP_CORES
const MAX_VALUE = 24 * 1024 * 1024; // under KV's 25 MB ceiling
const LEASE_MS = 20 * 60 * 60 * 1000;

// ── Object garbage collection ───────────────────────────────────────────────
// Snapshots are bounded (KEEP_SNAPSHOTS per device) but the content-addressed
// objects they point at were NOT: every `o/<hash>` ever written stayed forever.
// Retention would drop a device's oldest snapshot and the documents only that
// snapshot referenced simply leaked, so storage grew with every edit anyone
// ever made and only stopped at KV's 1 GB ceiling.
//
// GC is safe here only because a snapshot lists its object hashes IN THE CLEAR
// (backup.js sets `envMan.objects`) — the Worker cannot decrypt anything, so
// without that list it could never know what is still reachable.
const GC_KEY = 'gc/objects';
const GC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
// An object is uploaded BEFORE the snapshot that references it, so there is a
// window where a live object looks unreachable. Nothing newer than this is ever
// collected, which closes that race without any locking.
const GC_OBJECT_GRACE_MS = 24 * 60 * 60 * 1000;
// Deletes are capped at 1,000/day per ACCOUNT on the free plan, shared with
// snapshot retention. A backlog therefore has to be worked off across passes
// rather than in one sweep that runs into the limit and starts failing — which
// would leave collection permanently behind. Whatever is left is collected on
// the next pass.
const GC_MAX_DELETES = 400;

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

// Constant-time compare. A plain === on a secret leaks its prefix through
// response timing, which is a cheap thing to get right and an awkward one to
// explain later.
function timingSafeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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

// Every key under a prefix, following the cursor.
//
// KV's list() returns a bounded page (1000 keys) plus a cursor, and reading only
// the first page is not a smaller answer — it is a WRONG one. Here it would be
// actively destructive: a truncated snapshot listing understates what is
// reachable, and GC would then delete live objects. Every listing in this file
// goes through here for that reason.
async function listAll(kv, prefix) {
  const out = [];
  let cursor;
  for (;;) {
    const page = await kv.list(cursor ? { prefix, cursor } : { prefix });
    out.push(...page.keys);
    if (page.list_complete || !page.cursor) return out;
    cursor = page.cursor;
  }
}

// The set of object hashes every stored snapshot still references.
//
// FAILS CLOSED. This set decides what gets deleted, so anything that could make
// it incomplete — an unreadable snapshot, one that does not parse, one written
// before `objects` rode in the clear — aborts the whole pass and returns null.
// Deleting a live object is unrecoverable; skipping a GC cycle costs nothing but
// a few kilobytes until the next one.
async function liveObjectHashes(env) {
  const snaps = await listAll(env.A1_BACKUPS, 's/');
  // No snapshots at all means "nothing is reachable", which would collect the
  // entire store. That is never a conclusion worth acting on — on an empty or
  // half-migrated namespace it is simply wrong.
  if (!snaps.length) return null;

  const live = new Set();
  for (const k of snaps) {
    let parsed;
    try {
      const raw = await env.A1_BACKUPS.get(k.name);
      if (raw == null) return null;
      parsed = JSON.parse(raw);
    } catch (e) { return null; }
    if (!parsed || !Array.isArray(parsed.objects)) return null;
    for (const h of parsed.objects) live.add(String(h));
  }
  return live;
}

// Delete objects no surviving snapshot points at. Rate-limited, and only ever
// called from ctx.waitUntil() so a push never waits on it.
async function collectOrphans(env, now) {
  try {
    const last = await env.A1_BACKUPS.get(GC_KEY, { type: 'json' });
    if (last && typeof last.at === 'number' && now - last.at < GC_MIN_INTERVAL_MS) return;

    const live = await liveObjectHashes(env);
    if (!live) return;                      // incomplete picture — do nothing

    const objects = await listAll(env.A1_BACKUPS, 'o/');
    let deleted = 0, bytes = 0, held = 0, remaining = 0;
    for (const k of objects) {
      if (live.has(k.name.slice(2))) continue;
      const at = k.metadata && k.metadata.at;
      // Objects written before this field existed have no `at`; they predate
      // the current push by definition, so they are collectable.
      if (typeof at === 'number' && now - at < GC_OBJECT_GRACE_MS) { held++; continue; }
      if (deleted >= GC_MAX_DELETES) { remaining++; continue; }
      await env.A1_BACKUPS.delete(k.name);
      deleted++;
      bytes += (k.metadata && k.metadata.bytes) || 0;
    }
    await env.A1_BACKUPS.put(GC_KEY, JSON.stringify({
      at: now, deleted, bytes, held, remaining, live: live.size, scanned: objects.length,
    }));
  } catch (e) {
    // GC is maintenance. It must never turn a failed cleanup into a failed backup.
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const c = cors(request.headers.get('Origin') || '');
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    if (path === '/health') return json({ ok: true, service: 'index-backups' }, 200, c);

    if (!env.A1_BACKUPS) return json({ ok: false, error: 'kv-not-bound' }, 500, c);

    // Everything past here is gated. Two ways in, deliberately:
    //
    //  1. App Check — for the app itself. These Workers are called from a public
    //     repo's pages, so there is no secret a browser can hold; App Check
    //     attests "this request came from the app" and is the only real gate.
    //
    //  2. A PULL secret — for tools/pull-backups.mjs, which has no browser and
    //     therefore cannot mint an App Check token. It is READ ONLY: it can
    //     fetch snapshots and objects, never write or delete. A backup step
    //     that needs a human to paste a token is a backup step that stops
    //     happening, and the thing it guards is ciphertext either way.
    const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const pullOk = !!(env.PULL_SECRET && bearer && timingSafeEq(bearer, env.PULL_SECRET));
    if (!(pullOk && request.method === 'GET')) {
      const denied = await requireAppCheck(request, c);
      if (denied) return denied;
    }

    // ── /index — what exists, without revealing any of it ────────────────
    if (path === '/index' && request.method === 'GET') {
      const list = await listAll(env.A1_BACKUPS, 's/');
      const devices = {};
      for (const k of list) {
        const m = /^s\/([^/]+)\/(\d+)$/.exec(k.name);
        if (!m) continue;
        const d = m[1], at = Number(m[2]);
        const meta = k.metadata || {};
        if (!devices[d] || at > devices[d].at) {
          devices[d] = { at, bytes: meta.bytes || null, docs: meta.docs || null };
        }
        devices[d].count = (devices[d].count || 0) + 1;
      }

      // Storage, so "is this quietly filling up?" is answerable without
      // guessing. Object bytes dominate — snapshots are small manifests.
      //
      // Deliberately built from LIST METADATA plus the last GC record, and not
      // by recomputing the live set: that needs a read per snapshot, and at ~80ms
      // each it would turn a status chip into a multi-second call. `lastGc`
      // already carries what matters — a `remaining` that never reaches zero, or
      // an `at` that stops advancing, means collection has stopped working.
      let storage = null;
      try {
        const objects = await listAll(env.A1_BACKUPS, 'o/');
        const bytesOf = (ks) => ks.reduce((n, k) => n + ((k.metadata && k.metadata.bytes) || 0), 0);
        const snapBytes = bytesOf(list), objBytes = bytesOf(objects);
        storage = {
          snapshots: list.length, snapshotBytes: snapBytes,
          objects: objects.length, objectBytes: objBytes,
          totalBytes: snapBytes + objBytes,
          keepPerDevice: KEEP_SNAPSHOTS,
          lastGc: await env.A1_BACKUPS.get(GC_KEY, { type: 'json' }),
        };
      } catch (e) { /* reporting only */ }

      return json({ ok: true, devices, storage, now: Date.now() }, 200, c);
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
        //
        // Sorted lexically, which is only the same as chronologically because
        // every stamp is a fixed-width millisecond epoch. It stops being true in
        // the year 2286 (14 digits), and would silently start deleting the WRONG
        // snapshots rather than erroring — noted because that is exactly the
        // shape of bug this file must not have.
        const mine = await listAll(env.A1_BACKUPS, 's/' + device + '/');
        const stamps = mine.map((k) => k.name).sort();
        const excess = stamps.length - KEEP_SNAPSHOTS;
        for (let i = 0; i < excess; i++) await env.A1_BACKUPS.delete(stamps[i]);

        // Which of this snapshot's objects are NOT in the store.
        //
        // The client keeps a local "already uploaded" set and skips re-offering
        // anything in it, so an object that left the store — collected as an
        // orphan after its content briefly stopped being referenced, or simply
        // lost — would never be re-sent, and this snapshot would restore
        // incomplete with nothing reporting it. One listing (not one read per
        // hash) answers it, and the client repairs by uploading just these.
        let missing = [];
        try {
          if (Array.isArray(parsed.objects) && parsed.objects.length) {
            const have = new Set((await listAll(env.A1_BACKUPS, 'o/')).map((k) => k.name.slice(2)));
            missing = parsed.objects.map(String).filter((h) => !have.has(h));
          }
        } catch (e) { /* reporting only — never fail a stored backup over it */ }

        // Objects can only become unreachable when a snapshot is evicted, so
        // that is the only time it is worth looking. Rate-limited inside, and
        // detached so the push does not wait for it.
        if (excess > 0 && ctx && ctx.waitUntil) ctx.waitUntil(collectOrphans(env, at));

        return json({ ok: true, at, kept: Math.min(stamps.length, KEEP_SNAPSHOTS), missing }, 200, c);
      }

      if (request.method === 'GET') {
        const want = url.searchParams.get('at');
        const mine = await listAll(env.A1_BACKUPS, 's/' + device + '/');
        if (!mine.length) return json({ ok: false, error: 'no-snapshots' }, 404, c);
        const names = mine.map((k) => k.name).sort();
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
        // `at` is what keeps GC off an object that is still in flight: the
        // client uploads objects before the snapshot that references them, so
        // for a moment a live object looks like an orphan.
        await env.A1_BACKUPS.put('o/' + hash, body, {
          metadata: { bytes: body.length, at: Date.now() },
        });
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
