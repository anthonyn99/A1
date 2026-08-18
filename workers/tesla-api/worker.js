// ============================================================================
// taskhub-tesla-api — Cloudflare Worker
//
// Server-side half of the Tesla widget in index.html (window.THTS). Tesla's
// Fleet API requires a confidential OAuth client — the client secret and the
// refresh token can never touch the browser — so this Worker is where the
// token lives and where the widget's single GET /vehicle call is served from.
//
// Routes:
//   GET  /.well-known/appspecific/com.tesla.3p.public-key.pem
//        → the partner public key Tesla requires to be hosted on this domain
//          before partner_accounts registration will succeed. Static, public,
//          not sensitive — the private half never leaves this machine (see
//          tesla-private-key.pem, which is .gitignore'd and unused by this
//          Worker; it exists only because Tesla's registration flow expects
//          a keypair to exist, even though this integration signs no vehicle
//          commands).
//
//   GET  /callback?code=...&state=...
//        → OAuth redirect target. Exchanges the code for tokens, discovers
//          the vehicle, and stores {refresh_token, vehicle_id, access_token}
//          in KV. `state` must match the TESLA_STATE secret or the exchange
//          is refused — this is a personal one-time setup route left live on
//          the internet, and the state check is what stops a random hit on
//          it from doing anything.
//
//   GET  /admin/register-partner?key=<TESLA_ADMIN_KEY>
//        → one-time: exchanges a client-credentials token and POSTs this
//          Worker's domain to /api/1/partner_accounts. Must be run once,
//          after the public key route above is live, before /callback can
//          succeed. Gated by TESLA_ADMIN_KEY so it isn't a bare-internet POST.
//
//   GET  /admin/status?key=<TESLA_ADMIN_KEY>
//        → whether a vehicle is linked, its name, and token freshness —
//          without ever echoing the tokens themselves.
//
//   GET  /vehicle
//        → what the widget's THTS.configure({endpoint:...}) actually calls.
//          Refreshes the access token if needed (Tesla ROTATES the refresh
//          token on every use — the new one is written back to KV immediately,
//          every time, or the next refresh would fail with invalid_grant).
//          Cheap /api/1/vehicles list call first to read sleep state WITHOUT
//          risking a wake; only calls the heavier vehicle_data endpoint when
//          the car is already online. NEVER calls wake_up — a sleeping car
//          stays asleep and the widget gets the last cached reading with
//          state:"asleep", which is what backs its own poll interval off to
//          5 minutes instead of 60 seconds.
//
// Bindings (wrangler.toml):
//   TESLA_KV            KV namespace — tokens + the 60s vehicle_data cache
//   TESLA_CLIENT_ID      var  — public, safe to commit
//   TESLA_REDIRECT_URI   var  — must exactly match what's registered with Tesla
//   TESLA_API_BASE       var  — regional Fleet API base (NA by default — see
//                                note below if Tesla changes this hostname)
//   TESLA_AUTH_BASE      var  — https://auth.tesla.com
//   ALLOWED_ORIGIN        var — the one browser origin /vehicle answers to
//
// Secrets (`wrangler secret put <NAME>`, never in wrangler.toml):
//   TESLA_CLIENT_SECRET  — from the Tesla developer dashboard
//   TESLA_ADMIN_KEY      — protects /admin/*
//   TESLA_STATE          — protects /callback from junk hits
// ============================================================================


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
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYZU8a+1U2Ja6zfRGrvgoBAKN5uKB
+gGz777nyxBS+ikCRf6HIvTCQ34G8qXv9QzKgdvZARgELT3T+g/2J7aeAw==
-----END PUBLIC KEY-----
`;

const KV_TOKENS = 'tokens';
const KV_VEHICLE_CACHE = 'vehicle_data';

const VEHICLE_DATA_ENDPOINTS =
  'charge_state;climate_state;drive_state;location_data;vehicle_state;vehicle_config;gui_settings';

const CACHE_FRESH_MS = 60 * 1000;         // matches the widget's own POLL_AWAKE
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(env, origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/.well-known/appspecific/com.tesla.3p.public-key.pem') {
        // cors carries its own Content-Type:application/json for the JSON
        // routes — spread it FIRST here so the PEM type wins, not the other
        // way round. (Caught by testing: this exact ordering bug shipped the
        // key with Content-Type application/json on first deploy.)
        return new Response(PUBLIC_KEY_PEM, {
          headers: { ...cors, 'Content-Type': 'application/x-pem-file' },
        });
      }
      if (url.pathname === '/callback') return await handleCallback(url, env, cors);
      if (url.pathname === '/admin/register-partner') return await handleRegisterPartner(url, request, env, cors);
      if (url.pathname === '/admin/status') return await handleStatus(url, env, cors);
      if (url.pathname === '/vehicle') {
        return await handleVehicle(env, cors, url.searchParams.get('wake') === '1');
      }
      if (url.pathname === '/') {
        return new Response('taskhub-tesla-api — see index.html Tesla widget', {
          headers: { 'Content-Type': 'text/plain', ...cors },
        });
      }
      return j({ error: 'Not found' }, 404, cors);
    } catch (e) {
      return j({ error: e.message || String(e) }, 500, cors);
    }
  },
};

// ── /callback — one-time OAuth exchange ────────────────────────────────────
async function handleCallback(url, env, cors) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');

  if (err) return html(`<h3>Tesla returned an error</h3><p>${escapeHtml(err)}</p>`, 400, cors);
  if (!code) return html('<h3>Missing code</h3>', 400, cors);
  if (!env.TESLA_STATE || state !== env.TESLA_STATE) {
    return html('<h3>Invalid state</h3><p>This link did not come from a request this Worker issued.</p>', 403, cors);
  }

  const tok = await postForm(`${env.TESLA_AUTH_BASE}/oauth2/v3/token`, {
    grant_type: 'authorization_code',
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    code,
    redirect_uri: env.TESLA_REDIRECT_URI,
    audience: env.TESLA_API_BASE,
  });
  if (!tok.ok) {
    return html(`<h3>Token exchange failed</h3><pre>${escapeHtml(JSON.stringify(tok.body, null, 2))}</pre>`, 502, cors);
  }

  // Discover the vehicle — a cheap list call, wakes nothing.
  const list = await getJson(`${env.TESLA_API_BASE}/api/1/vehicles`, tok.body.access_token);
  const vehicles = (list.ok && Array.isArray(list.body.response)) ? list.body.response : [];
  if (!vehicles.length) {
    return html('<h3>Connected, but no vehicles found</h3><p>Token exchange succeeded but /api/1/vehicles returned none.</p>', 200, cors);
  }
  const v = vehicles[0]; // first (and, for a personal account, presumably only) vehicle

  const now = Date.now();
  await env.TESLA_KV.put(KV_TOKENS, JSON.stringify({
    refresh_token: tok.body.refresh_token,
    access_token: tok.body.access_token,
    access_token_expires_at: now + (tok.body.expires_in || 28800) * 1000,
    vehicle_id: v.id_s || String(v.id),
    vin: v.vin,
    display_name: v.display_name || null,
    linked_at: now,
  }));

  const extra = vehicles.length > 1
    ? `<p>Note: ${vehicles.length} vehicles found on this account — linked the first one (${escapeHtml(v.display_name || v.vin)}). Tell Claude if that's the wrong car and the linking logic can be pointed at a specific VIN.</p>`
    : '';
  return html(
    `<h3>Tesla linked ✓</h3><p>Vehicle: <b>${escapeHtml(v.display_name || v.vin)}</b></p>${extra}` +
    `<p>You can close this tab. The dashboard endpoint is now live at <code>/vehicle</code>.</p>`,
    200, cors
  );
}

// ── /admin/register-partner — one-time domain registration ────────────────
async function handleRegisterPartner(url, request, env, cors) {
  if (!requireAdmin(url, env)) return j({ error: 'Forbidden' }, 403, cors);

  const partnerTok = await postForm(`${env.TESLA_AUTH_BASE}/oauth2/v3/token`, {
    grant_type: 'client_credentials',
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    scope: 'openid vehicle_device_data vehicle_location',
    audience: env.TESLA_API_BASE,
  });
  if (!partnerTok.ok) return j({ step: 'client_credentials', ...partnerTok.body }, 502, cors);

  const domain = new URL(env.TESLA_REDIRECT_URI).hostname;
  const reg = await postJson(`${env.TESLA_API_BASE}/api/1/partner_accounts`, partnerTok.body.access_token, { domain });
  return j({ step: 'partner_accounts', domain, status: reg.status, body: reg.body }, reg.ok ? 200 : 502, cors);
}

// ── /admin/status — inspect without ever exposing tokens ──────────────────
async function handleStatus(url, env, cors) {
  if (!requireAdmin(url, env)) return j({ error: 'Forbidden' }, 403, cors);
  const raw = await env.TESLA_KV.get(KV_TOKENS);
  if (!raw) return j({ linked: false }, 200, cors);
  const t = JSON.parse(raw);
  return j({
    linked: true,
    vehicle: t.display_name,
    vin: t.vin ? t.vin.slice(-6) : null,          // last 6 only — enough to confirm, not enough to be sensitive
    linked_at: new Date(t.linked_at).toISOString(),
    access_token_valid_for_s: Math.max(0, Math.round((t.access_token_expires_at - Date.now()) / 1000)),
  }, 200, cors);
}

// ── /vehicle — what the widget polls ───────────────────────────────────────
// `wake` is passed ONLY for an explicit user-initiated refresh (the button in
// the panel header), never by the widget's background polling. Without it a
// sleeping car is left alone and the last cached reading is served — which is
// correct for polling, but means the cache can be many hours old, and a
// software update that finished overnight still shows as "installing 60%".
// An explicit refresh is the user asking for current truth, so it may wake.
// ── What the browser is allowed to see ────────────────────────────────────
// This Worker proxies Tesla's vehicle_data, and that payload carries the VIN,
// the Tesla account user_id, vehicle ids, auth `tokens`, and drive_state with
// LIVE GPS COORDINATES. The endpoint is reachable by anyone who knows the URL,
// so spreading the raw response published the car's real-time position and its
// identifiers to the internet. (The comment further down claiming the browser
// never sees raw lat/lon described placeLabel's intent, not what was shipped —
// the spread defeated it.)
//
// So the response is now an explicit ALLOW-LIST of exactly the fields the
// TaskHub widget reads. Anything new Tesla adds is dropped by default, which is
// the right direction for a field list nobody re-reviews.
const VEHICLE_PUBLIC = {
  charge_state:  ['battery_level', 'est_battery_range', 'battery_range', 'charging_state',
                  'minutes_to_full_charge', 'charge_limit_soc', 'charge_rate', 'time_to_full_charge'],
  climate_state: ['inside_temp', 'outside_temp', 'is_climate_on', 'is_preconditioning'],
  vehicle_state: ['locked', 'odometer', 'df', 'dr', 'pf', 'pr', 'ft', 'rt', 'sentry_mode', 'car_version'],
  gui_settings:  ['gui_distance_units', 'gui_temperature_units', 'gui_charge_rate_units', 'gui_24_hour_time'],
  // Deliberately no latitude/longitude/native_* — `place` is the geocoded city
  // label and is the only location the browser gets.
  drive_state:   ['shift_state', 'speed', 'power', 'timestamp'],
};

function slimVehicle(body) {
  if (!body || typeof body !== 'object') return body;
  const r = body.response;
  if (!r || typeof r !== 'object') return body;
  const out = {};
  // Scalars the widget shows. `state` and `place` are computed here, not by Tesla.
  for (const k of ['state', 'place', 'display_name']) if (r[k] !== undefined) out[k] = r[k];
  for (const [group, keys] of Object.entries(VEHICLE_PUBLIC)) {
    const src = r[group];
    if (!src || typeof src !== 'object') continue;
    const sub = {};
    for (const k of keys) if (src[k] !== undefined) sub[k] = src[k];
    if (Object.keys(sub).length) out[group] = sub;
  }
  const slim = { ...body, response: out };
  // _fetchedAt is the cache stamp the UI uses for "as of"; keep it, drop nothing else.
  return slim;
}

async function handleVehicle(env, cors, wake) {
  const raw = await env.TESLA_KV.get(KV_TOKENS);
  if (!raw) return j({ error: 'Not linked yet — complete the OAuth flow first' }, 400, cors);
  let t = JSON.parse(raw);

  if (Date.now() > t.access_token_expires_at - TOKEN_REFRESH_SKEW_MS) {
    const refreshed = await refreshToken(env, t);
    if (!refreshed.ok) {
      // Refresh failed — surface the cached reading (if any) rather than a
      // hard error, since a lapsed token shouldn't blank a working widget.
      const cached = await env.TESLA_KV.get(KV_VEHICLE_CACHE, 'json');
      if (cached) return j(slimVehicle(cached), 200, cors);
      return j({ error: 'Token refresh failed: ' + (refreshed.body && refreshed.body.error) }, 502, cors);
    }
    t = refreshed.t;
  }

  // Cheap list call — tells us awake/asleep/offline without any risk of
  // waking the car, since only the explicit wake_up command does that.
  const list = await getJson(`${env.TESLA_API_BASE}/api/1/vehicles`, t.access_token);
  const mine = list.ok && Array.isArray(list.body.response)
    ? list.body.response.find(x => (x.id_s || String(x.id)) === t.vehicle_id)
    : null;
  let state = mine ? mine.state : null; // 'online' | 'asleep' | 'offline'
  let wakeTried = false, wakeOk = false;

  if (state !== 'online' && wake) {
    wakeTried = true;
    wakeOk = await wakeVehicle(env, t);
    if (wakeOk) state = 'online';
  }

  if (state !== 'online') {
    const cached = await env.TESLA_KV.get(KV_VEHICLE_CACHE, 'json');
    const body = cached || { response: {} };
    body.response = { ...body.response, state: state || 'offline', display_name: t.display_name };
    // Tell the UI the wake was attempted and the car still didn't answer, so
    // it can say so instead of silently repeating stale numbers.
    if (wakeTried) body.wake_failed = true;
    return j(slimVehicle(body), 200, cors);
  }

  // An explicit wake-refresh must not be answered from the 60s cache — the
  // whole point of it is to go and get the current truth.
  if (!wakeTried) {
    const fresh = await env.TESLA_KV.get(KV_VEHICLE_CACHE, 'json');
    if (fresh && fresh._fetchedAt && Date.now() - fresh._fetchedAt < CACHE_FRESH_MS) {
      return j(slimVehicle(fresh), 200, cors);
    }
  }

  const vd = await getJson(
    `${env.TESLA_API_BASE}/api/1/vehicles/${t.vehicle_id}/vehicle_data?endpoints=${encodeURIComponent(VEHICLE_DATA_ENDPOINTS)}`,
    t.access_token
  );
  if (!vd.ok) {
    const cached = await env.TESLA_KV.get(KV_VEHICLE_CACHE, 'json');
    if (cached) return j(slimVehicle(cached), 200, cors);
    return j({ error: 'Fleet API ' + vd.status }, 502, cors);
  }

  // Reverse-geocode into a city label server-side — the browser only ever
  // sees "Longmont, Colorado" (or a configured place name like "Home"),
  // never the raw lat/lon a coordinate string would otherwise leak on screen.
  const ds = vd.body.response.drive_state || {};
  const lat = num(ds.latitude) ?? num(ds.native_latitude);
  const lon = num(ds.longitude) ?? num(ds.native_longitude);
  const place = (lat != null && lon != null) ? await placeLabel(env, lat, lon) : null;

  const body = {
    response: { ...vd.body.response, state: 'online', place },
    _fetchedAt: Date.now(),
  };
  await env.TESLA_KV.put(KV_VEHICLE_CACHE, JSON.stringify(body));
  // Cache keeps the full body (placeLabel may need coords again); only what
  // LEAVES the Worker is slimmed.
  return j(slimVehicle(body), 200, cors);
}

// Reverse geocode → "Longmont, Colorado". Same free BigDataCloud endpoint and
// caching shape as taskhub-weather-api's placeLabel() — rounded to 2 decimals
// (~1.1km) both for cache reuse and so this Worker never stores or returns a
// precise fix, only the city it resolves to. Best-effort: a failed lookup
// just means the Location card falls back to a configured place or hides.
async function placeLabel(env, lat, lon) {
  const rlat = lat.toFixed(2), rlon = lon.toFixed(2);
  const key = `place:${rlat}:${rlon}`;
  try {
    const hit = await env.TESLA_KV.get(key);
    if (hit !== null) return hit || null;
    const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${rlat}&longitude=${rlon}&localityLanguage=en`);
    if (!res.ok) return null;
    const g = await res.json();
    const city = g.locality || g.city || '';
    // US gets the 2-letter postal code ("Colorado" → "CO") — this label has
    // to fit a ~140px compact-bar column, and the full state name doesn't.
    // Everywhere else keeps the region/country name as BigDataCloud gives it,
    // since there's no equivalent universal abbreviation to reach for.
    const region = (g.countryCode === 'US' && US_STATE_ABBR[g.principalSubdivision])
      || g.principalSubdivision || g.countryName || '';
    const label = [city, region].filter(Boolean).join(', ');
    await env.TESLA_KV.put(key, label, { expirationTtl: 30 * 24 * 3600 });
    return label || null;
  } catch (e) {
    return null;
  }
}

// Wake a sleeping car and wait for it to answer. wake_up returns immediately
// with state:"asleep"; the car needs a few seconds to actually come up, so the
// vehicles list is polled until it flips to online. A Model 3 typically takes
// 5–15s. Bounded well under the Worker request budget — if it hasn't answered
// by then it is genuinely unreachable (underground, no signal) and the caller
// falls back to cache rather than hanging.
async function wakeVehicle(env, t) {
  try {
    await postJson(`${env.TESLA_API_BASE}/api/1/vehicles/${t.vehicle_id}/wake_up`, t.access_token, {});
  } catch (e) { /* the poll below is the real check */ }
  for (let i = 0; i < 9; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const list = await getJson(`${env.TESLA_API_BASE}/api/1/vehicles`, t.access_token);
    const me = list.ok && Array.isArray(list.body.response)
      ? list.body.response.find(x => (x.id_s || String(x.id)) === t.vehicle_id)
      : null;
    if (me && me.state === 'online') return true;
  }
  return false;
}

async function refreshToken(env, t) {
  const res = await postForm(`${env.TESLA_AUTH_BASE}/oauth2/v3/token`, {
    grant_type: 'refresh_token',
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    refresh_token: t.refresh_token,
  });
  if (!res.ok) return { ok: false, body: res.body };

  // Tesla ROTATES the refresh token on every use — the old one stops working
  // the moment this response lands, so the new one MUST be persisted now or
  // the next refresh 5 minutes from now fails with invalid_grant and the
  // whole link silently dies until someone redoes the OAuth flow by hand.
  const next = {
    ...t,
    access_token: res.body.access_token,
    access_token_expires_at: Date.now() + (res.body.expires_in || 28800) * 1000,
    refresh_token: res.body.refresh_token || t.refresh_token,
  };
  await env.TESLA_KV.put(KV_TOKENS, JSON.stringify(next));
  return { ok: true, t: next };
}

// ── helpers ─────────────────────────────────────────────────────────────
function requireAdmin(url, env) {
  return !!env.TESLA_ADMIN_KEY && url.searchParams.get('key') === env.TESLA_ADMIN_KEY;
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  let body; try { body = await res.json(); } catch (e) { body = { error: 'Non-JSON response: ' + res.status }; }
  return { ok: res.ok, status: res.status, body };
}
async function postJson(url, bearer, obj) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
    body: JSON.stringify(obj),
  });
  let body; try { body = await res.json(); } catch (e) { body = { error: 'Non-JSON response: ' + res.status }; }
  return { ok: res.ok, status: res.status, body };
}
async function getJson(url, bearer) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + bearer } });
  let body; try { body = await res.json(); } catch (e) { body = { error: 'Non-JSON response: ' + res.status }; }
  return { ok: res.ok, status: res.status, body };
}

// CORS is deliberately narrow — this proxies one person's vehicle telemetry,
// not a public API. `null` covers the widget being opened over file://, which
// is how this app is normally run locally (see index.html memory notes).
function corsHeaders(env, origin) {
  const allowed = origin === env.ALLOWED_ORIGIN || origin === 'null' || !origin;
  return {
    'Access-Control-Allow-Origin': allowed ? (origin || env.ALLOWED_ORIGIN) : env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
function j(o, status, cors) { return new Response(JSON.stringify(o), { status, headers: cors }); }
function html(body, status, cors) {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:32px;max-width:640px;margin:auto;line-height:1.5">${body}</body>`,
    { status, headers: { ...cors, 'Content-Type': 'text/html' } });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

const US_STATE_ABBR = {
  Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',
  Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',
  Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',
  Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',
  Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV',
  'New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY',
  'North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',
  Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',
  Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA',
  'West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY','District of Columbia':'DC',
};
