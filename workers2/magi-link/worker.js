/**
 * magi-link — where MAGI's backend currently is.
 *
 * MAGI's council cannot leave Tony's PC: it drives real Chrome profiles holding
 * live logins. So magi.html is static (GitHub Pages) and the engine is local,
 * and the only thing that has to travel between them is one string — the
 * current Cloudflare quick-tunnel url, which changes on every cloudflared
 * restart.
 *
 * Veda's original setup solved that by inlining the url into the JS bundle at
 * build time, which made every PC restart a four-step chore: new url → rewrite
 * .env.production → `npm run build` → `firebase deploy`. This worker replaces
 * all four with one PUT: the backend publishes its url on startup, magi.html
 * reads it on load. Nothing is rebuilt and nothing is redeployed, ever.
 *
 *   PUT  /link   { url }   →  backend publishes where it can be reached
 *   GET  /link             →  magi.html asks where that is
 *   DELETE /link           →  backend withdraws it on clean shutdown
 *   GET  /health           →  liveness, no auth
 *
 * ── Why there is no worker secret ──────────────────────────────────────────
 * Both /link verbs require MAGI_API_TOKEN — the same shared secret the backend
 * already gates /api/* on — but this worker never learns it. Records are keyed
 * by SHA-256 of the token, so a caller proves possession by hashing to a key
 * that exists. That means:
 *
 *   · nothing here needs `wrangler secret put`,
 *   · a dump of this KV namespace reveals no credential, and
 *   · A1 is a PUBLIC repo, so the token stays out of it entirely — it lives in
 *     the PC's environment and in the browser's localStorage, never in git.
 *
 * The token is not what protects the backend on its own (the tunnel url plus
 * the backend's own gate do that); it is what stops a passer-by from reading
 * or overwriting the address of a machine driving paid accounts.
 */

const TTL = 60 * 60 * 36; // 36h — a tunnel outlives a day of uptime, but a url
// left behind by a PC that has been off for two days is
// worse than no answer: it sends the UI to a dead host.

const CORS = {
  // A1's pages are served from exactly one origin, and file:// (origin "null")
  // is how magi.html is opened when testing a change before pushing.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,x-magi-token",
  "Access-Control-Max-Age": "86400",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });

/** KV key for a token. Never stores or logs the token itself. */
async function keyFor(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return "link:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (pathname === "/health") {
      return json({ ok: true, worker: "magi-link", account: "av1-2" });
    }

    if (pathname !== "/link") return json({ error: "not found" }, 404);

    // A token is required on every verb. Absent, the answer is 401 rather than
    // an empty result: "you did not authenticate" and "nothing is published"
    // are different problems with different fixes, and collapsing them is what
    // makes a UI show "MAGI is offline" when the real cause is a typo'd token.
    const token = (request.headers.get("x-magi-token") || "").trim();
    if (!token) return json({ error: "missing X-MAGI-Token" }, 401);
    const key = await keyFor(token);

    if (request.method === "GET") {
      const raw = await env.MAGI_LINK.get(key);
      if (!raw) return json({ error: "no backend published" }, 404);
      const rec = JSON.parse(raw);
      return json({ ...rec, age_s: Math.round((Date.now() - rec.at) / 1000) });
    }

    if (request.method === "PUT") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
      const url = String(body?.url || "").trim().replace(/\/+$/, "");
      // Validated rather than trusted: this string is what the browser is about
      // to send a live API token to, so a bad publish must fail here and not
      // become a credential leak to whatever host ended up in the record.
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) {
        return json({ error: "url must be a plain https origin" }, 400);
      }
      await env.MAGI_LINK.put(
        key,
        JSON.stringify({ url, at: Date.now(), host: String(body?.host || "").slice(0, 40) }),
        { expirationTtl: TTL },
      );
      return json({ ok: true, url });
    }

    if (request.method === "DELETE") {
      await env.MAGI_LINK.delete(key);
      return json({ ok: true });
    }

    return json({ error: "method not allowed" }, 405);
  },
};
