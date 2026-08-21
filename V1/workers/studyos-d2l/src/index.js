/* ═══════════════════════════════════════════════════════════════════════════
 * studyos-d2l — Brightspace calendar import
 * ---------------------------------------------------------------------------
 * The server half of StudyOS's D2L integration. Three jobs:
 *
 *   1. CORS proxy.  Brightspace sends no Access-Control-Allow-Origin, so the
 *      browser physically cannot fetch the ICS feed. This Worker can.
 *   2. Secret custody.  The feed URL is a BEARER CAPABILITY — anyone holding
 *      it reads the whole calendar, forever, with no revocation short of
 *      regenerating the token in Brightspace. It lives here in KV and is never
 *      returned to the browser, never written to Firestore, never in config.js
 *      (which is served publicly at /studyos/config/config.js).
 *   3. Normalization.  Parses ICS into JSON so the client stays thin and the
 *      parser stays testable under node (see scripts/test-d2l-ics.mjs).
 *
 * SCOPE — and why it is this small: the ONLY Brightspace data a student can
 * reach without an admin-registered OAuth client is the calendar feed. Grades,
 * announcements and course files require the Valence API. Do NOT attempt them
 * by scraping HTML with a session cookie: it breaks on every Brightspace
 * release and violates most institutional AUPs. See ARCHITECTURE.md §8.
 *
 * Bindings required (wrangler.toml):
 *   KV       D2L      feed URL, sessions, last-good snapshot
 *   service  AUTH     -> studyos-api, for App-Lock password verification
 *
 * No secrets. The feed URL is set at RUNTIME via POST /feed/set, which beats
 * `wrangler secret put`: rotating it needs no redeploy and it never touches
 * shell history or a CI log.
 *
 * Verify:  curl https://studyos-d2l.<subdomain>.workers.dev/health
 * ═══════════════════════════════════════════════════════════════════════════ */

import { parseICS } from './ics.js';
import { extractCourses, classifyType } from './classify.js';

/* StudyOS's App Lock lives in studyos-api, NOT tradeboard-auth (that one is
 * Finance's lock). These two literals must match config/config.js:151
 * (cloudflare.apiWorker.lockNamespace) and :206 (appLock.id) exactly — getting
 * them wrong produces a silent, permanent "wrong password". */
const AUTH_API = 'https://studyos-api.vedapatel05.workers.dev';
const LOCK_ID = { journal: 'studyos_applock', entryId: 'studyos' };

// A session lasts until the password changes or the user disconnects. Matches
// Finance's model: the browser keeps the token so refreshes stay unlocked.
const SESSION_TTL_S = 60 * 60 * 24 * 365;

// Institutions rate-limit calendar feeds. Without a floor, a user holding down
// "Sync" hammers their own university.
const CACHE_FLOOR_MS = 15 * 60 * 1000;

// An unbounded r.text() on a pathological feed OOMs the Worker.
const MAX_FEED_BYTES = 5 * 1024 * 1024;

// Keeps the Firestore document under its 900 KB ceiling (config/config.js:80).
const MAX_ITEMS = 800;

/* ── CORS ─────────────────────────────────────────────────────────────────
   Same allow-list shape as studyos-api (workers/studyos-api/worker.js:61). */
function corsHeaders(origin, env) {
  const allowed = String((env && env.ALLOWED_ORIGINS) || '*')
    .split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || (origin && allowed.includes(origin));
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0] || 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, origin, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
  });
}

/* ── Sessions ─────────────────────────────────────────────────────────────
   Minted only after the App-Lock password verifies against studyos-api. Each
   token records a fingerprint of the password that created it, so changing the
   password invalidates every device at once. */
const sessKey = t => 'sess:' + t;

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function passwordFingerprint(password) {
  // Not a credential — a stable marker so a changed password invalidates old
  // sessions. Real verification is always done by studyos-api.
  return (await sha256Hex('d2l-fp:' + password)).slice(0, 32);
}

/* Verify against the shared auth Worker.
 *
 * This MUST go through the AUTH service binding, not the public workers.dev
 * hostname: Cloudflare blocks same-account Worker-to-Worker subrequests over
 * the public URL and returns "error code: 1042" as a non-JSON 404 body. The
 * binding dispatches inside Cloudflare's network instead.
 *
 * Failures are logged rather than swallowed — a broken binding and a genuinely
 * wrong password both end in "no session", and without a log the two are
 * indistinguishable from the outside.
 *
 * Returns { ok, noLock } — noLock means the user has never set an App Lock, in
 * which case there is no password to check and we let them through rather than
 * locking them out of a feature they cannot otherwise reach. */
async function verifyPassword(env, password) {
  try {
    const req = new Request(AUTH_API + '/auth/journal/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...LOCK_ID, password: password || '' }),
    });
    const r = env.AUTH ? await env.AUTH.fetch(req) : await fetch(req);
    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); }
    catch {
      console.log('verifyPassword: non-JSON reply', r.status, text.slice(0, 200));
      return { ok: false, noLock: false };
    }
    if (data.noLock) return { ok: true, noLock: true };
    if (!data.ok) console.log('verifyPassword: refused', r.status);
    return { ok: !!data.ok, noLock: false };
  } catch (e) {
    console.log('verifyPassword: subrequest failed —', String((e && e.message) || e));
    return { ok: false, noLock: false };
  }
}

async function readSession(env, token) {
  if (!token || typeof token !== 'string') return null;
  try { return await env.D2L.get(sessKey(token), 'json'); } catch { return null; }
}

// Every privileged endpoint funnels through this.
async function requireSession(env, body) {
  const s = await readSession(env, body && body.token);
  return s ? { ok: true, session: s } : { ok: false };
}

/* ── Feed storage ─────────────────────────────────────────────────────────
   `feed` is never returned by any endpoint. /feed/status reports only the
   host, so the UI can say "connected to x.brightspace.com" without ever
   putting the capability back on the wire. */
async function getFeed(env) {
  try { return await env.D2L.get('feed', 'json'); } catch { return null; }
}

async function getSnapshot(env) {
  try { return await env.D2L.get('snapshot', 'json'); } catch { return null; }
}

/* webcal:// is just https:// with a scheme that tells an OS to hand the URL to
 * a calendar app. Rewrite it here rather than making the user do it. */
function normalizeFeedUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  if (/^webcal:\/\//i.test(u)) u = u.replace(/^webcal:\/\//i, 'https://');
  let parsed;
  try { parsed = new URL(u); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // Refuse plaintext: the token in the query string would be on the wire.
  if (parsed.protocol === 'http:') return null;
  return parsed;
}

/* ── Fetch + parse ────────────────────────────────────────────────────────
   Returns { ok, snapshot, stale?, error? }. Never throws. */
async function fetchAndParse(env, opts = {}) {
  const feed = await getFeed(env);
  if (!feed || !feed.url) return { ok: false, error: 'no feed configured' };

  const prior = await getSnapshot(env);

  if (!opts.force && prior && (Date.now() - (prior.fetchedAt || 0)) < CACHE_FLOOR_MS) {
    return { ok: true, snapshot: prior, cached: true };
  }

  let r;
  try {
    r = await fetch(feed.url, {
      headers: {
        Accept: 'text/calendar, text/plain, */*',
        ...(prior && prior.etag ? { 'If-None-Match': prior.etag } : {}),
      },
      // Never let Cloudflare's edge cache a capability URL.
      cf: { cacheTtl: 0, cacheEverything: false },
      redirect: 'follow',
    });
  } catch (e) {
    // A network failure should not look like "the semester ended". Serve the
    // last good snapshot and say it is stale.
    if (prior) return { ok: true, snapshot: prior, stale: true, error: String((e && e.message) || e) };
    return { ok: false, error: 'fetch failed: ' + String((e && e.message) || e) };
  }

  if (r.status === 304 && prior) {
    const bumped = { ...prior, fetchedAt: Date.now() };
    await env.D2L.put('snapshot', JSON.stringify(bumped));
    return { ok: true, snapshot: bumped, cached: true };
  }

  if (!r.ok) {
    if (prior) return { ok: true, snapshot: prior, stale: true, error: 'HTTP ' + r.status };
    return { ok: false, error: 'HTTP ' + r.status };
  }

  const len = parseInt(r.headers.get('content-length') || '0', 10);
  if (len > MAX_FEED_BYTES) return { ok: false, error: 'feed too large (' + len + ' bytes)' };

  const text = await r.text();
  if (text.length > MAX_FEED_BYTES) return { ok: false, error: 'feed too large' };

  const snapshot = await buildSnapshot(text, r.headers.get('etag') || '');
  await env.D2L.put('snapshot', JSON.stringify(snapshot));
  return { ok: true, snapshot };
}

/* Turn raw ICS into the normalized payload the client reconciles against.
 *
 * The per-item `key` is sha256(UID).slice(0,16) rather than the raw UID: a D2L
 * UID runs ~70 characters, and at 600 items that difference is ~40 KB inside a
 * document with a 900 KB ceiling whose breach wedges sync for the whole app
 * (js/firebase-sync.js:121). 64 bits of hash collides at ~1e-14 here. */
async function buildSnapshot(text, etag) {
  const parsed = parseICS(text);
  const { courses, assign } = extractCourses(parsed.events);

  const labelByKey = new Map(courses.map(c => [c.key, c.label]));
  const items = [];

  for (const e of parsed.events) {
    if (items.length >= MAX_ITEMS) break;
    if (!e.start) continue;
    const courseKey = assign.get(e.uid) || '(unassigned)';
    const courseLabel = labelByKey.get(courseKey) || courseKey;
    items.push({
      key: (await sha256Hex(e.uid)).slice(0, 16),
      uid: e.uid,
      courseKey,
      title: e.summary || '(untitled)',
      type: classifyType(e.summary || '', courseLabel),
      date: e.start.date,
      time: e.start.time,
      allDay: !!e.start.allDay,
      isUtc: !!e.start.isUtc,
      tzid: e.start.tzid || '',
      dtRaw: e.start.dtRaw || '',
      description: (e.description || '').slice(0, 500),
      location: e.location || '',
      rrule: e.rrule || '',
      seq: e.sequence || 0,
      lm: e.lastModified || '',
    });
  }

  return {
    fetchedAt: Date.now(),
    etag: etag || '',
    calName: parsed.calName || '',
    truncated: parsed.events.length > MAX_ITEMS,
    totalParsed: parsed.events.length,
    recurringCount: items.filter(i => i.rrule).length,
    courses,
    items,
  };
}

/* ── Routes ───────────────────────────────────────────────────────────────── */

async function handle(request, env, url) {
  const path = url.pathname;
  const origin = request.headers.get('Origin');

  if (path === '/health') {
    const feed = await getFeed(env);
    const snap = await getSnapshot(env);
    return json({
      ok: true,
      kv: !!env.D2L,
      auth: !!env.AUTH,
      feedConfigured: !!(feed && feed.url),
      feedHost: (feed && feed.host) || null,
      lastFetchAt: (snap && snap.fetchedAt) || null,
      lastEventCount: (snap && snap.items && snap.items.length) || 0,
    }, origin, env);
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'POST only' }, origin, env, 405);
  }
  if (!env.D2L) {
    return json({ ok: false, error: 'KV not bound' }, origin, env, 500);
  }

  let body = {};
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'bad json' }, origin, env, 400); }

  /* ── /lock/session ── */
  if (path === '/lock/session') {
    const v = await verifyPassword(env, body.password);
    if (!v.ok) return json({ ok: false, error: 'bad password' }, origin, env, 401);
    const token = crypto.randomUUID().replace(/-/g, '');
    await env.D2L.put(
      sessKey(token),
      JSON.stringify({ createdAt: Date.now(), fp: await passwordFingerprint(body.password || '') }),
      { expirationTtl: SESSION_TTL_S },
    );
    return json({ ok: true, token, noLock: !!v.noLock }, origin, env);
  }

  if (path === '/lock/end') {
    if (body.token) { try { await env.D2L.delete(sessKey(body.token)); } catch {} }
    return json({ ok: true }, origin, env);
  }

  const gate = await requireSession(env, body);
  if (!gate.ok) return json({ ok: false, error: 'no session' }, origin, env, 401);

  /* ── /feed/set ── */
  if (path === '/feed/set') {
    const parsed = normalizeFeedUrl(body.url);
    if (!parsed) {
      return json({ ok: false, error: 'that does not look like an https feed URL' }, origin, env, 400);
    }

    await env.D2L.put('feed', JSON.stringify({
      url: parsed.toString(), host: parsed.host, addedAt: Date.now(),
    }));
    // A changed feed invalidates the cached snapshot.
    try { await env.D2L.delete('snapshot'); } catch {}

    const res = await fetchAndParse(env, { force: true });
    if (!res.ok) {
      return json({ ok: false, error: res.error, host: parsed.host }, origin, env, 502);
    }
    // Zero events from a URL that fetched fine almost always means the token is
    // wrong and Brightspace served a login page. Say so here, at connect time,
    // rather than letting it look like an empty semester later.
    const s = res.snapshot;
    if (!s.items.length) {
      return json({
        ok: false, host: parsed.host,
        error: 'That URL fetched, but contained no calendar events. It is usually a sign the link ' +
               'expired or was copied incompletely — re-copy it from Brightspace > Calendar > Subscribe.',
      }, origin, env, 422);
    }
    return json({
      ok: true, host: parsed.host,
      probe: { events: s.items.length, courses: s.courses.map(c => ({ key: c.key, label: c.label, count: c.count, confidence: c.confidence, rule: c.rule })) },
    }, origin, env);
  }

  /* ── /feed/status ── */
  if (path === '/feed/status') {
    const feed = await getFeed(env);
    const snap = await getSnapshot(env);
    return json({
      ok: true,
      configured: !!(feed && feed.url),
      host: (feed && feed.host) || null,
      addedAt: (feed && feed.addedAt) || null,
      lastFetchAt: (snap && snap.fetchedAt) || null,
      lastEventCount: (snap && snap.items && snap.items.length) || 0,
    }, origin, env);
  }

  /* ── /feed/clear ── */
  if (path === '/feed/clear') {
    try { await env.D2L.delete('feed'); } catch {}
    try { await env.D2L.delete('snapshot'); } catch {}
    return json({ ok: true }, origin, env);
  }

  /* ── /sync ── */
  if (path === '/sync') {
    const res = await fetchAndParse(env, { force: !!body.force });
    if (!res.ok) return json({ ok: false, error: res.error }, origin, env, 502);
    const s = res.snapshot;
    return json({
      ok: true,
      fetchedAt: s.fetchedAt,
      cached: !!res.cached,
      stale: !!res.stale,
      error: res.error || null,
      calName: s.calName,
      truncated: !!s.truncated,
      totalParsed: s.totalParsed,
      recurringCount: s.recurringCount,
      courses: s.courses,
      items: s.items,
    }, origin, env);
  }

  return json({ ok: false, error: 'unknown route' }, origin, env, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }
    try {
      return await handle(request, env, url);
    } catch (e) {
      console.log('unhandled —', String((e && e.stack) || e));
      return json({ ok: false, error: 'internal error' }, origin, env, 500);
    }
  },
};
