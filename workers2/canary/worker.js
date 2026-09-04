/**
 * canary — the smoke test for the account-2 deploy lane.
 *
 * This worker exists to answer one question: "does workers2/ actually reach
 * My Account 2?" It holds no data, no secrets and no bindings, so it can be
 * redeployed or deleted at any time without consequence.
 *
 * It is worth keeping rather than deleting after the first green run: when a
 * future workers2/ deploy fails, this tells you within one request whether the
 * lane itself broke (expired token, revoked account access, changed subdomain)
 * or whether the problem is in the worker you were actually shipping.
 *
 *   https://canary.av1-2.workers.dev/        → human-readable
 *   https://canary.av1-2.workers.dev/health  → JSON, for scripts
 */

// Deliberately permissive: this endpoint reports nothing sensitive, and the
// point of a canary is that anything can check it. Workers holding real data
// pin ALLOWED_ORIGINS to https://anthonyn99.github.io instead.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const body = {
      ok: true,
      worker: 'canary',
      // Read back from the request rather than a var, so this reflects where
      // the worker ACTUALLY landed, not where the config claimed it would.
      host: url.hostname,
      account: 'My Account 2',
      lane: 'workers2/ → deploy-workers2.yml → CF_API_TOKEN_2',
      // Colo the request was served from — handy for confirming it is really
      // running on Cloudflare's edge and not a cached response somewhere.
      colo: request.cf?.colo ?? null,
      time: new Date().toISOString(),
    };

    if (url.pathname === '/health' || url.pathname === '/') {
      const wantsJson =
        url.pathname === '/health' ||
        (request.headers.get('accept') || '').includes('application/json');

      if (wantsJson) {
        return new Response(JSON.stringify(body, null, 2), {
          headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
        });
      }
      return new Response(
        `canary is up\n\n` +
          `host    ${body.host}\n` +
          `account ${body.account}\n` +
          `lane    ${body.lane}\n` +
          `colo    ${body.colo}\n` +
          `time    ${body.time}\n`,
        { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } }
      );
    }

    return new Response(JSON.stringify({ ok: false, error: 'not-found' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
    });
  },
};
