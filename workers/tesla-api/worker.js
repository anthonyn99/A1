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
      if (url.pathname === '/vehicle') return await handleVehicle(env, cors);
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
async function handleVehicle(env, cors) {
  const raw = await env.TESLA_KV.get(KV_TOKENS);
  if (!raw) return j({ error: 'Not linked yet — complete the OAuth flow first' }, 400, cors);
  let t = JSON.parse(raw);

  if (Date.now() > t.access_token_expires_at - TOKEN_REFRESH_SKEW_MS) {
    const refreshed = await refreshToken(env, t);
    if (!refreshed.ok) {
      // Refresh failed — surface the cached reading (if any) rather than a
      // hard error, since a lapsed token shouldn't blank a working widget.
      const cached = await env.TESLA_KV.get(KV_VEHICLE_CACHE, 'json');
      if (cached) return j(cached, 200, cors);
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
  const state = mine ? mine.state : null; // 'online' | 'asleep' | 'offline'

  if (state !== 'online') {
    const cached = await env.TESLA_KV.get(KV_VEHICLE_CACHE, 'json');
    const body = cached || { response: {} };
    body.response = { ...body.response, state: state || 'offline', display_name: t.display_name };
    return j(body, 200, cors);
  }

  const fresh = await env.TESLA_KV.get(KV_VEHICLE_CACHE, 'json');
  if (fresh && fresh._fetchedAt && Date.now() - fresh._fetchedAt < CACHE_FRESH_MS) {
    return j(fresh, 200, cors);
  }

  const vd = await getJson(
    `${env.TESLA_API_BASE}/api/1/vehicles/${t.vehicle_id}/vehicle_data?endpoints=${encodeURIComponent(VEHICLE_DATA_ENDPOINTS)}`,
    t.access_token
  );
  if (!vd.ok) {
    const cached = await env.TESLA_KV.get(KV_VEHICLE_CACHE, 'json');
    if (cached) return j(cached, 200, cors);
    return j({ error: 'Fleet API ' + vd.status }, 502, cors);
  }

  const body = { response: { ...vd.body.response, state: 'online' }, _fetchedAt: Date.now() };
  await env.TESLA_KV.put(KV_VEHICLE_CACHE, JSON.stringify(body));
  return j(body, 200, cors);
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
