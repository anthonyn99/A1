// The budget ledger and provider health (D1 tables `usage`, `provider_health`).
//
// Every call to an outside service goes through spend(), which counts it and
// refuses once the service's daily cap is reached. A provider that failed
// three times in a row, or hit its cap, is skipped for SKIP_MS (state in
// provider_health.skip_until), so a dead source costs nothing while it is down.

// Daily caps per outside service (calls a day), far under each free tier.
export const CAPS = {
  finnhub: 20000,   // free: 60 a minute
  alpaca: 30000,    // free: 200 a minute
  public: 5000,
  yahoo: 5000,
  cboe: 500,
  fred: 400,        // free: 1,000 a day
  sec: 2000,
  alphavantage: 20, // free: 25 a day
  tiingo: 400,      // free: 1,000 a day
  groq: 800,        // free: about 1,000 a day
};
export const SKIP_MS = 5 * 60_000;
export const FAILS_TO_SKIP = 3;

export const LAT_SAMPLES = 15;

/** The last LAT_SAMPLES answer times of each provider: { provider: [ms…] } (meta rows `lat:<provider>`). */
export async function readLatency(env) {
  const out = {};
  const rows = (await env.DB.prepare("SELECT k, v FROM meta WHERE k LIKE 'lat:%'").all()).results || [];
  for (const r of rows) { try { const a = JSON.parse(r.v); if (Array.isArray(a)) out[r.k.slice(4)] = a; } catch (e) {} }
  return out;
}
export function median(xs) {
  if (!xs || !xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
}

export const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const capOf = (service) => CAPS[service.split(':')[0]];

/** Count `n` calls to `service` today. Resolves false (and counts nothing)
 *  when the service is at its cap, so the caller moves to the next source. */
export async function spend(env, service, n = 1) {
  const cap = capOf(service);
  const d = day();
  if (cap) {
    const row = await env.DB.prepare('SELECT n FROM usage WHERE day = ? AND service = ?').bind(d, service).first();
    if (row && row.n + n > cap) return false;
  }
  await env.DB.prepare(UPSERT_USAGE).bind(d, service, n).run();
  return true;
}
const UPSERT_USAGE = 'INSERT INTO usage (day, service, n) VALUES (?, ?, ?) ON CONFLICT (day, service) DO UPDATE SET n = n + excluded.n';

/** Record how a provider just answered (one write). Three failures in a row
 *  open the skip window; an answer closes it. */
export async function noteHealth(env, provider, ok, status, latencyMs, detail, now = Date.now()) {
  await healthStmt(env, provider, ok, status, latencyMs, detail, now).run();
}
function healthStmt(env, provider, ok, status, latencyMs, detail, now, skipUntil) {
  return env.DB.prepare('INSERT INTO provider_health (provider, ok, status, latency_ms, detail, at, ok_at, fails, skip_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT (provider) DO UPDATE SET ok = excluded.ok, status = excluded.status, latency_ms = excluded.latency_ms, detail = excluded.detail, at = excluded.at, '
    + 'ok_at = COALESCE(excluded.ok_at, provider_health.ok_at), '
    + 'fails = CASE WHEN excluded.ok = 1 THEN 0 ELSE provider_health.fails + 1 END, '
    + 'skip_until = CASE WHEN excluded.skip_until IS NOT NULL THEN excluded.skip_until WHEN excluded.ok = 1 THEN NULL '
    + `WHEN provider_health.fails + 1 >= ${FAILS_TO_SKIP} THEN excluded.at + ${SKIP_MS} ELSE provider_health.skip_until END`)
    .bind(provider, ok ? 1 : 0, status == null ? null : status, latencyMs == null ? null : Math.round(latencyMs),
      ok ? null : String(detail || '').slice(0, 200), now, ok ? now : null, ok ? 0 : 1, skipUntil == null ? null : skipUntil);
}

/**
 * One request's view of the ledger: today's usage and every provider's health
 * read once (two reads), the writes queued and sent together at the end
 * (`flush`, one D1 batch), so a request touching three providers costs two
 * reads and one round trip of writes.
 */
export class Ledger {
  static async load(env, now = Date.now()) {
    const L = new Ledger(env, now);
    const [u, h, lat] = await Promise.all([
      env.DB.prepare('SELECT service, n FROM usage WHERE day = ?').bind(day(now)).all(),
      env.DB.prepare('SELECT * FROM provider_health').all(),
      readLatency(env),
    ]);
    for (const r of (u && u.results) || []) L.used[r.service] = r.n;
    for (const r of (h && h.results) || []) L.health[r.provider] = r;
    L.lat = lat;
    return L;
  }
  constructor(env, now) { this.env = env; this.now = now; this.used = {}; this.health = {}; this.lat = {}; this.latDirty = new Set(); this.queue = []; }
  /** Why `provider` may not be asked now, or '' when it may. */
  blocked(provider) {
    const h = this.health[provider];
    if (h && h.skip_until && h.skip_until > this.now) return (h.fails >= FAILS_TO_SKIP ? 'failing' : 'at its cap') + ', skipped until ' + new Date(h.skip_until).toISOString();
    const cap = capOf(provider);
    if (cap && (this.used[provider] || 0) >= cap) return 'at its daily cap';
    return '';
  }
  /** Count `n` calls. False when that would pass the cap (the provider is
   *  then put in the skip window, and nothing is counted). */
  spend(provider, n = 1) {
    const cap = capOf(provider);
    if (cap && (this.used[provider] || 0) + n > cap) {
      this.health[provider] = Object.assign({}, this.health[provider], { skip_until: this.now + SKIP_MS });
      this.queue.push(healthStmt(this.env, provider, false, null, null, 'at its daily cap', this.now, this.now + SKIP_MS));
      return false;
    }
    this.used[provider] = (this.used[provider] || 0) + n;
    this.queue.push(this.env.DB.prepare(UPSERT_USAGE).bind(day(this.now), provider, n));
    return true;
  }
  note(provider, ok, status, latencyMs, detail) {
    const h = this.health[provider] || { fails: 0 };
    const fails = ok ? 0 : (h.fails || 0) + 1;
    this.health[provider] = Object.assign({}, h, { ok: ok ? 1 : 0, fails, skip_until: ok ? null : fails >= FAILS_TO_SKIP ? this.now + SKIP_MS : h.skip_until });
    this.queue.push(healthStmt(this.env, provider, ok, status, latencyMs, detail, this.now));
    if (ok && Number.isFinite(latencyMs)) {
      this.lat[provider] = (this.lat[provider] || []).concat(Math.round(latencyMs)).slice(-LAT_SAMPLES);
      this.latDirty.add(provider);
    }
  }
  async flush() {
    for (const p of this.latDirty) {
      this.queue.push(this.env.DB.prepare('INSERT INTO meta (k, v, at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, at = excluded.at')
        .bind('lat:' + p, JSON.stringify(this.lat[p]), this.now));
    }
    this.latDirty.clear();
    const q = this.queue; this.queue = [];
    if (!q.length) return;
    if (this.env.DB.batch) await this.env.DB.batch(q);
    else for (const s of q) await s.run();
  }
}
