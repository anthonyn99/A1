/**
 * WarRoom API — Riot Games API proxy.
 *
 * Holds the only copy of RIOT_API_KEY (secret). riftiq.html talks to nothing
 * but this worker.
 *
 * Why it caches
 * -------------
 * Riot's free/development key allows ~20 req/s and ~100 req/2min *for the key*,
 * not per visitor. WarRoom blows through that trivially: one profile load is
 * ~26 calls (3 + 20 match details + summoner + spectator), and opening the
 * Ladder tab used to fire ~101 (1 league page + 50 rows x 2 lookups). Two page
 * loads inside two minutes was enough to 429 the whole app, which is what a
 * "rate limited on the first open of the day" report actually looks like.
 *
 * So: everything that can be cached is cached at the edge, keyed on the Riot
 * path. Match details by id are immutable, so they are held for 30 days and a
 * re-open of the same profile costs 0 Riot calls. The client also has its own
 * scheduler, but the edge cache is what makes a refresh nearly free.
 *
 * Why it checks Origin
 * --------------------
 * The worker URL is written in plain text inside a page served from
 * anthonyn99.github.io, so anyone who views source can read it. It used to
 * answer any caller with Access-Control-Allow-Origin: *, which made it a free
 * public Riot proxy running on Tony's key — a third-party page could spend the
 * whole rate limit. Requests that carry a browser Origin must now carry an
 * allowed one.
 */

const ALLOWED_ORIGINS = ['https://anthonyn99.github.io'];
// Any local dev server, whatever port it grabbed.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin);
}

// Riot path -> edge TTL in seconds. First matching prefix wins; 0 = never cache.
const CACHE_RULES = [
  // Immutable once the game is over. This is the big one.
  { test: (p) => /^\/lol\/match\/v5\/matches\/[^/]+$/.test(p), ttl: 2592000 },
  // Live game state — must never be cached or the live card goes stale.
  { test: (p) => p.startsWith('/lol/spectator/'), ttl: 0 },
  { test: (p) => p.startsWith('/lol/match/v5/matches/by-puuid/'), ttl: 60 },
  { test: (p) => p.startsWith('/riot/account/v1/accounts/'), ttl: 86400 },
  { test: (p) => p.startsWith('/lol/summoner/v4/summoners/'), ttl: 3600 },
  { test: (p) => p.startsWith('/lol/champion-mastery/'), ttl: 300 },
  { test: (p) => /^\/lol\/league\/v4\/(challenger|grandmaster|master)leagues\//.test(p), ttl: 900 },
  { test: (p) => p.startsWith('/lol/league/'), ttl: 180 },
  { test: (p) => p.startsWith('/lol/status/'), ttl: 300 }
];

function ttlFor(path) {
  for (const rule of CACHE_RULES) if (rule.test(path)) return rule.ttl;
  return 0;
}

function corsFor(request) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    // Let the page read how much of the Riot budget is left.
    'Access-Control-Expose-Headers':
      'X-App-Rate-Limit, X-App-Rate-Limit-Count, X-Method-Rate-Limit, X-Method-Rate-Limit-Count, Retry-After, X-WR-Cache',
    'Content-Type': 'application/json'
  };
  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  } else if (!origin) {
    // Non-browser callers (curl, the health check) get a permissive header;
    // there is no browser to protect in that case.
    headers['Access-Control-Allow-Origin'] = '*';
  }
  return headers;
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;              // no Origin = not a cross-origin browser call
  if (origin === 'null') return true;    // file:// during local testing
  return isAllowedOrigin(origin);
}

// Riot headers worth passing through so the client can see its own budget.
const PASS_THROUGH = [
  'x-app-rate-limit',
  'x-app-rate-limit-count',
  'x-method-rate-limit',
  'x-method-rate-limit-count',
  'retry-after'
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsFor(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (!originAllowed(request)) {
      return new Response(JSON.stringify({ error: 'origin not allowed' }), { status: 403, headers: cors });
    }

    // ── Riot API proxy ────────────────────────────────────────────────────
    if (url.pathname.startsWith('/api/riot')) {
      const endpoint = url.searchParams.get('endpoint');
      const region   = url.searchParams.get('region') || 'na1';
      if (!endpoint) {
        return new Response(JSON.stringify({ error: 'Missing endpoint' }), { status: 400, headers: cors });
      }
      if (!endpoint.startsWith('/')) {
        return new Response(JSON.stringify({ error: 'Bad endpoint' }), { status: 400, headers: cors });
      }
      // Region goes straight into a hostname — keep it to the shard shape.
      if (!/^[a-z0-9]{2,8}$/.test(region)) {
        return new Response(JSON.stringify({ error: 'Bad region' }), { status: 400, headers: cors });
      }

      const path = endpoint.split('?')[0];
      const ttl  = ttlFor(path);

      // Cache key never carries the API key, and is namespaced by region.
      const cacheKey = new Request(
        'https://warroom-cache.internal/' + region + endpoint,
        { method: 'GET' }
      );
      const cache = caches.default;

      if (ttl > 0) {
        const hit = await cache.match(cacheKey);
        if (hit) {
          const h = new Headers(hit.headers);
          for (const [k, v] of Object.entries(cors)) h.set(k, v);
          h.set('X-WR-Cache', 'HIT');
          return new Response(hit.body, { status: hit.status, headers: h });
        }
      }

      const riotUrl = `https://${region}.api.riotgames.com${endpoint}`;
      const resp = await fetch(riotUrl, {
        headers: { 'X-Riot-Token': env.RIOT_API_KEY, 'Accept': 'application/json' }
      });
      const body = await resp.text();

      const headers = new Headers(cors);
      for (const name of PASS_THROUGH) {
        const v = resp.headers.get(name);
        if (v) headers.set(name, v);
      }
      headers.set('X-WR-Cache', ttl > 0 ? 'MISS' : 'BYPASS');

      if (ttl > 0 && resp.status === 200) {
        const toCache = new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + ttl }
        });
        ctx.waitUntil(cache.put(cacheKey, toCache));
      }

      return new Response(body, { status: resp.status, headers });
    }

    // ── DDragon version proxy ─────────────────────────────────────────────
    if (url.pathname === '/api/ddragon-version') {
      const cache = caches.default;
      const key = new Request('https://warroom-cache.internal/ddragon-version');
      const hit = await cache.match(key);
      if (hit) {
        const h = new Headers(hit.headers);
        for (const [k, v] of Object.entries(cors)) h.set(k, v);
        h.set('X-WR-Cache', 'HIT');
        return new Response(hit.body, { status: hit.status, headers: h });
      }
      const resp = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
      const data = await resp.text();
      if (resp.status === 200) {
        ctx.waitUntil(cache.put(key, new Response(data, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
        })));
      }
      return new Response(data, { status: resp.status, headers: cors });
    }

    // ── Debug ─────────────────────────────────────────────────────────────
    if (url.pathname === '/debug') {
      return new Response(JSON.stringify({
        key: env.RIOT_API_KEY ? 'set' : 'missing',
        origin: request.headers.get('Origin') || null,
        allowed: originAllowed(request)
      }), { headers: cors });
    }

    return new Response('WarRoom API ready', { status: 200, headers: { ...cors, 'Content-Type': 'text/plain' } });
  }
};
