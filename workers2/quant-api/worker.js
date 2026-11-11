// quant-api: TradeHub Quant's worker (A1-Priv docs/TradeHub/quant-plan.md).
// One door for market data, the budget ledger, and (later phases) signals,
// history, alerts and Drive. Everything it stores is in D1; it uses no KV.
//
// Who may call it: Tony's Orca key, sent as `Authorization: Bearer orca_sk_…`.
// The worker holds only the SHA-256 of the keys it accepts (secret
// ALLOWED_KEYS), so the key itself is never stored here, and with no
// ALLOWED_KEYS set every route but /health is refused.
//
// Routes (Phase 0)
//   GET /health            { ok, db, time }         no key needed
//   GET /whoami   (key)    { ok }                   proves the key is accepted
//   GET /usage    (key)    { day, usage: [{service, n, cap}], health: [...] }
//
// Budgets: every call to an outside service goes through spend(), which counts
// it in D1 and refuses once the service's daily cap is reached. Caps sit far
// under each free tier (docs/TradeHub/quant-plan.md, "No usage spikes").

const ORIGINS = [
  /^https:\/\/a1-priv\.av1\.workers\.dev$/,
  /^https:\/\/anthonyn99\.github\.io$/,
  /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/,
];

// Daily caps per outside service (calls a day). A service not listed has none.
export const CAPS = {
  finnhub: 20000,   // free: 60 a minute
  alpaca: 30000,    // free: 200 a minute
  public: 5000,
  yahoo: 5000,
  cboe: 500,
  fred: 400,        // free: 1,000 a day
  sec: 2000,
  alphavantage: 20, // free: 25 a day
  tiingo: 400,
  groq: 800,        // free: about 1,000 a day
};

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const r = await route(req, env, new URL(req.url), ctx);
      for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
      return r;
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, e.status || 500, cors);
    }
  },
};

async function route(req, env, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  if (m === 'GET' && (p === '/' || p === '/health')) {
    let db = false;
    try { db = !!(await env.DB.prepare('SELECT 1 AS one').first()); } catch (e) {}
    return json({ ok: true, db, time: Date.now() });
  }
  await auth(req, env);
  if (m === 'GET' && p === '/whoami') return json({ ok: true });
  if (m === 'GET' && p === '/usage') {
    const d = day();
    const rows = (await env.DB.prepare('SELECT service, n FROM usage WHERE day = ? ORDER BY service').bind(d).all()).results || [];
    const health = (await env.DB.prepare('SELECT provider, ok, status, latency_ms, detail, at, ok_at FROM provider_health ORDER BY provider').all()).results || [];
    return json({ ok: true, day: d, usage: rows.map((r) => ({ service: r.service, n: r.n, cap: CAPS[r.service.split(':')[0]] || null })), health });
  }
  throw fail(404, 'no such route');
}

/* ── who may call ───────────────────────────────────────────────────────── */
export async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function auth(req, env) {
  const allowed = String(env.ALLOWED_KEYS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) throw fail(503, 'this worker has no allowed keys set');
  const key = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^orca_sk_[\w-]{8,}$/.test(key)) throw fail(401, 'an Orca key is needed');
  const h = await sha256Hex(key);
  // Compare against every allowed hash without stopping early.
  let ok = 0;
  for (const a of allowed) ok |= same(h, a) ? 1 : 0;
  if (!ok) throw fail(403, 'this key may not use quant-api');
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ── the budget ledger ──────────────────────────────────────────────────── */
export const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
/** Count one call to `service` today. Resolves false (and counts nothing)
 *  when the service is at its cap, so the caller moves to the next source. */
export async function spend(env, service, n = 1) {
  const cap = CAPS[service.split(':')[0]];
  const d = day();
  if (cap) {
    const row = await env.DB.prepare('SELECT n FROM usage WHERE day = ? AND service = ?').bind(d, service).first();
    if (row && row.n + n > cap) return false;
  }
  await env.DB.prepare('INSERT INTO usage (day, service, n) VALUES (?, ?, ?) ON CONFLICT (day, service) DO UPDATE SET n = n + excluded.n').bind(d, service, n).run();
  return true;
}
/** Record how a provider just answered. */
export async function noteHealth(env, provider, ok, status, latencyMs, detail) {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO provider_health (provider, ok, status, latency_ms, detail, at, ok_at) VALUES (?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT (provider) DO UPDATE SET ok = excluded.ok, status = excluded.status, latency_ms = excluded.latency_ms, detail = excluded.detail, at = excluded.at, ok_at = COALESCE(excluded.ok_at, provider_health.ok_at)')
    .bind(provider, ok ? 1 : 0, status == null ? null : status, latencyMs == null ? null : Math.round(latencyMs), ok ? null : String(detail || '').slice(0, 200), now, ok ? now : null).run();
}

/* ── small helpers ──────────────────────────────────────────────────────── */
function fail(status, message) { return Object.assign(new Error(message), { status }); }
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
function corsHeaders(req) {
  const o = req.headers.get('origin') || '';
  if (!ORIGINS.some((re) => re.test(o))) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': o,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}
