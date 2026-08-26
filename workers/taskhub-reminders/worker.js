/**
 * TaskHub Worker — reminders cron + auth/journal/profile API
 *
 * Reminder read budget per cron tick:
 *   - Normal tick (nothing due): query is bounded to [now-90s, now+10min],
 *     so it returns 0–2 docs → ~0–2 reads. Firestore bills ONE READ PER
 *     DOCUMENT RETURNED (an empty result is billed as a minimum of 1).
 *   - Top-of-hour tick: widens the lower bound to -2h to recover stale
 *     (missed) reminders, then runs cleanup. Heavier, but only 1×/hr.
 *   - fcm_tokens: fetched ONLY when something is due/stale.
 * NOTE: an UNBOUNDED query (no endAt) is billed per matching doc, not "1 per
 * query" — that mistaken assumption is what let 6K reads/hr go unnoticed.
 *
 * Auth/journal/profile state lives in the TOKEN_CACHE KV namespace:
 *   - jlock:<journal>:<entryId>  → { hash, salt, iter, hint }
 *   - profilepw:<profile>        → { hash, salt, iter }
 * Passwords hashed with PBKDF2-SHA256 (never stored in plaintext).
 *
 * Secrets: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, AUTH_SETUP_KEY
 * KV binding: TOKEN_CACHE
 */

const ALLOWED_ORIGIN = 'https://anthonyn99.github.io';

// ── Recovery-email routing ──────────────────────────────────────────────────
// The reset code is emailed BY THE WORKER and never returned to the caller (see
// /auth/reset/request). The consequence that matters: the destination is no
// longer chosen by whoever made the request. It is derived here from the lock's
// own id, so a stranger who asks for a reset only ever mails the code to the
// real owner's inbox — they learn nothing.
//
// Env overrides (MAIL_FORM_VEDA / MAIL_TO_VEDA, same for TONY) let a profile
// move to its own form and address without touching this file.
const MAILBOXES = {
  tony: { form: 'https://formspree.io/f/xeedkebo', email: 'anthonypn99@gmail.com' },
  veda: { form: 'https://formspree.io/f/xzdlwaqg', email: 'vedaapatel1605@gmail.com' },
};
// Most lock ids name their owner ('veda_links', 'profile_veda'). Two do not:
// Veda's Brainstorm Journal ('bj') and Tony's Journal ('tj') key every lock by a
// RANDOM entry id, so the journal name is the only owner signal there — miss it
// and Veda's hints quietly land in Tony's inbox.
const JOURNAL_OWNER = {
  bj: 'veda', veda_journal: 'veda',
  tj: 'tony', tony_myjournal: 'tony',
};

// `owner` may be stated outright by the caller. That is safe to honour: it only
// picks between two fixed mailboxes defined here, so nobody can aim a code at
// an address of their own choosing — the worst it can do is mail the wrong one
// of the two people, which reveals nothing.
function mailboxFor(env, body) {
  const b = body || {};
  const stated = String(b.owner || '').toLowerCase();
  const id = String(b.profile || b.entryId || '').toLowerCase();
  const jr = String(b.journal || '').toLowerCase();
  let who = 'tony';
  if (stated === 'veda' || stated === 'tony') who = stated;
  else if (JOURNAL_OWNER[jr]) who = JOURNAL_OWNER[jr];
  else if (id.includes('veda') || jr.includes('veda')) who = 'veda';
  const up = who.toUpperCase();
  return {
    who,
    form: (env && env['MAIL_FORM_' + up]) || MAILBOXES[who].form,
    email: (env && env['MAIL_TO_' + up]) || MAILBOXES[who].email,
  };
}
function maskEmail(e) {
  const parts = String(e || '').split('@');
  if (parts.length !== 2) return '';
  const u = parts[0];
  const shown = u.length <= 2 ? u.slice(0, 1) : u.slice(0, 2);
  return shown + '*'.repeat(Math.max(1, Math.min(6, u.length - shown.length))) + '@' + parts[1];
}

// ── Idle-tick lookahead ─────────────────────────────────────────────────────
// The cron fires every minute, and a query that matches NOTHING is still billed
// as one read — so simply proving "nothing is due" cost ~1,440 reads/day around
// the clock. The overnight read graph was a dead-flat 60/hr line for exactly
// this reason.
//
// Fix: after a tick that finds nothing to do, record when the next reminder is
// actually due (in KV, which is free at this volume). Subsequent ticks read that
// instead of Firestore and return immediately while the due time is still far
// off. Precision near a due time is untouched — inside the grace window every
// tick runs the real query exactly as before.
//
// Three things keep this from ever swallowing a reminder:
//   1. The top-of-the-hour tick NEVER skips, so the -2h stale sweep and the
//      fired-doc cleanup keep running on schedule regardless of the cache.
//   2. The cache is only trusted for MAX_AGE; after that a tick re-verifies
//      against Firestore even if the cached due time is still distant.
//   3. A reminder created AFTER the lookahead was taken is invisible to it, so
//      the client pokes /reminders/wake when it writes a near-term reminder,
//      which drops the key and forces the next tick to query for real.
// Any KV miss, KV error, or malformed cache falls through to a real query.
const NEXT_DUE_KEY        = 'rem:next';
const LOOKAHEAD_GRACE_MS  = 15 * 60 * 1000; // never skip within 15min of a due time
// Re-verify against Firestore at least this often. This is a BACKSTOP: a new or
// changed reminder POSTs /reminders/wake, which deletes the key outright.
//
// DO NOT RAISE THIS to save KV writes without also raising the query lower
// bound (startAtIso) past it -- tests/notif-delivery.test.js enforces
// lookback > MAX_AGE and will fail. Raising both is still wrong: a reminder
// first seen more than 90s late is marked stale and deliberately NOT sent, so a
// longer skip window turns a lost wake poke into a DROPPED alarm rather than a
// late one. 15min was tried at 30min and reverted for exactly this reason; the
// ~96 KV writes/day this costs is the price of the alarm guarantee.
const LOOKAHEAD_MAX_AGE_MS = 15 * 60 * 1000;

function corsHeaders(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(body, origin, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── Diagnostics: key-gated ────────────────────────────────────────────
    // These read real user data — /remindersdebug returns reminder TITLES and
    // /notifdebug returns device push tokens plus the same reminder contents —
    // and /notifdebug?send=1 pushes a notification to every registered device.
    // All three were reachable by anyone who knew the URL, on a public
    // workers.dev hostname. Nothing in the apps calls them; they are operator
    // tools, so they take the operator's key, exactly like /fixdashboards.
    if (path === '/remindersdebug' || path === '/notifdebug') {
      if (!env.AUTH_SETUP_KEY || url.searchParams.get('key') !== env.AUTH_SETUP_KEY) {
        return json({ ok: false, error: 'unauthorized' }, origin, 401);
      }
    }

    if (path === '/remindersdebug') {
      try {
        let aT; try { aT = await getGoogleAccessToken(env); } catch(e) { return json({ok:false,error:'auth:'+e.message},origin,500); }
        const pid = env.FIREBASE_PROJECT_ID;
        const bu  = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
        const ah  = { 'Authorization': `Bearer ${aT}`, 'Content-Type': 'application/json' };
        // NOTE: a `fired==false` equality filter combined with `orderBy notifyAt`
        // needs a composite index that isn't provisioned, so that query fails
        // silently (returns a non-array error body → 0 results). Query with the
        // equality filter ONLY (no orderBy → no composite index needed) and sort
        // client-side. Optional ?title=<substr> filters by title (case-insensitive).
        const wantTitle = (url.searchParams.get('title') || '').toLowerCase();
        const qr  = await fetch(`${bu}:runQuery`, { method:'POST', headers:ah, body:JSON.stringify({ structuredQuery: {
          from: [{ collectionId:'reminders' }],
          where: { fieldFilter: { field:{ fieldPath:'fired' }, op:'EQUAL', value:{ booleanValue:false } } },
          limit: 300
        }})});
        const raw  = await qr.json();
        if (!Array.isArray(raw)) return json({ ok:false, queryError:(JSON.stringify(raw)||'').slice(0,600) }, origin, 500);
        let docs = raw.filter(r => r.document);
        let out = docs.map(r => { const f=r.document.fields||{}; return {
          id: f.id?.stringValue, notifyAt: f.notifyAt?.stringValue, dash: f.dashboard?.stringValue,
          title: (f.title?.stringValue||''), repeatId: f.notifyRepeatId?.stringValue||null, fired: f.fired?.booleanValue
        };});
        if (wantTitle) out = out.filter(r => (r.title||'').toLowerCase().includes(wantTitle));
        out.sort((a,b) => String(a.notifyAt).localeCompare(String(b.notifyAt)));
        return json({ ok:true, now:new Date().toISOString(), count:out.length,
          reminders: out.map(r => ({ ...r, title: r.title.slice(0,50) })) }, origin);
      } catch(e) { return json({ok:false,error:e.message},origin,500); }
    }

    if (path === '/fixdashboards') {
      try {
        return await handleFixDashboards(request, env, origin);
      } catch (e) {
        return json({ ok: false, error: e.message || 'server error', stack: (e.stack||'').slice(0,400) }, origin, 500);
      }
    }

    if (path === '/notifdebug') {
      try {
        return await handleNotifDebug(request, env, origin);
      } catch (e) {
        return json({ ok: false, error: e.message || 'server error', stack: (e.stack||'').slice(0,400) }, origin, 500);
      }
    }

    // ── /reminders/wake ──────────────────────────────────────────────────────
    // Clears the cron's "next due" lookahead cache so the very next tick does a
    // real Firestore query instead of skipping. The client calls this after it
    // writes a reminder that fires soon (see _fcmScheduleNotif in index.html) —
    // that is what makes the skip in runReminders() safe: the worker can only
    // skip on the strength of a lookahead, and a brand-new near-term reminder is
    // exactly the case a lookahead taken minutes ago cannot know about.
    //
    // Deliberately unauthenticated and side-effect-free: the worst a caller can
    // do is force the cron to run the query it used to run every minute anyway.
    // No Firestore access, no token mint — just one KV delete.
    if (path === '/reminders/wake') {
      try {
        if (env.TOKEN_CACHE) await env.TOKEN_CACHE.delete(NEXT_DUE_KEY);
        return json({ ok: true, cleared: true }, origin);
      } catch (e) {
        // A failure here only means the next tick may skip; never surface a 500
        // to the client for it, and never let it block the reminder write.
        return json({ ok: false, error: e.message || 'kv error' }, origin, 200);
      }
    }

    if (path.startsWith('/auth/')) {
      try {
        return await handleAuth(path, request, env, origin);
      } catch (e) {
        return json({ ok: false, error: e.message || 'server error' }, origin, 500);
      }
    }

    if (path.startsWith('/shield/')) {
      try {
        return await handleShield(path, request, env, origin, url);
      } catch (e) {
        return json({ ok: false, error: e.message || 'server error' }, origin, 500);
      }
    }

    return new Response('TaskHub worker OK', { status: 200, headers: corsHeaders(origin) });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));

    // Insight daily sync piggyback. The account's 5-cron free-plan limit is
    // full, so insight-api has no cron of its own — this every-minute cron
    // fires its daily /transactions sync at 11:00 UTC instead. One POST/day;
    // a missed tick just means that day's sync waits for tomorrow (the sync
    // is cursor-based/incremental, so nothing is ever lost).
    const t = new Date();
    if (t.getUTCHours() === 11 && t.getUTCMinutes() === 0) {
      ctx.waitUntil(
        fetch('https://insight-api.av1.workers.dev/sync', { method: 'POST' })
          .then(r => console.log(`[insight] daily sync triggered → ${r.status}`))
          .catch(e => console.warn('[insight] daily sync trigger failed:', e.message))
      );
    }

    // OneInbox piggyback — same reason as Insight above: no cron slots left.
    // Fires every 5 minutes rather than daily, because this tick drives
    // SCHEDULED SENDS (a mail scheduled for 3:00 must not wait for tomorrow),
    // the Gmail history poll that backstops a dropped Pub/Sub push, and the
    // daily watch re-arm. The worker itself rate-limits the expensive parts
    // against timestamps in KV, so most of these calls return immediately.
    if (t.getUTCMinutes() % 5 === 0) {
      // Prefer the SERVICE BINDING. A plain fetch() to another Worker on the
      // same account can be silently dropped, and that is exactly what happened
      // here: after this piggyback shipped, oneinbox-api's cron state went
      // hours without moving while a manual POST to the same URL worked
      // instantly — so the scheduled call was never arriving. The binding
      // dispatches in-process and is the documented way to do this. The URL
      // fetch stays as a fallback for when the binding isn't present.
      ctx.waitUntil((async () => {
        try {
          const r = env.ONEINBOX
            ? await env.ONEINBOX.fetch('https://oneinbox-api/cron', { method: 'POST' })
            : await fetch('https://oneinbox-api.av1.workers.dev/cron', { method: 'POST' });
          if (!r.ok) console.warn(`[oneinbox] cron → ${r.status}`);
        } catch (e) {
          console.warn('[oneinbox] cron trigger failed:', e.message);
        }
      })());
    }
  }
};

// ══════════════════════════════════════════════════════════════════════════
//  NOTIF DEBUG  — GET /notifdebug  (inspect what the worker sees; force a push)
//   /notifdebug                → counts of due/stale/tokens + any errors
//   /notifdebug?send=1         → also force-push "WORKER TEST" to ALL tokens
//   /notifdebug?send=1&dash=veda → force-push only to veda-main tokens
// ══════════════════════════════════════════════════════════════════════════
async function handleNotifDebug(request, env, origin) {
  const url = new URL(request.url);
  const out = { ok: true, now: new Date().toISOString() };

  let accessToken;
  try { accessToken = await getGoogleAccessToken(env); }
  catch (e) { return json({ ok:false, step:'auth', error:e.message }, origin, 500); }
  out.auth = 'ok';

  const projectId = env.FIREBASE_PROJECT_ID;
  const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const authHdr   = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const now = Date.now();

  // Same window the cron uses (non-sweep) — keep these two in step, or this
  // endpoint reports on a window the cron does not actually read.
  const startAtIso = new Date(now - 16 * 60 * 1000).toISOString();
  const endAtIso   = new Date(now + 10 * 60 * 1000).toISOString();
  const qRes = await fetch(`${baseUrl}:runQuery`, {
    method: 'POST', headers: authHdr,
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'reminders' }],
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field:{fieldPath:'notifyAt'}, op:'GREATER_THAN_OR_EQUAL', value:{stringValue:startAtIso} } },
        { fieldFilter: { field:{fieldPath:'notifyAt'}, op:'LESS_THAN_OR_EQUAL',    value:{stringValue:endAtIso} } }
      ] } },
      orderBy: [{ field:{fieldPath:'notifyAt'}, direction:'ASCENDING' }],
      limit: 100
    } })
  });
  out.queryStatus = qRes.status;
  if (!qRes.ok) { out.ok = false; out.queryError = (await qRes.text()).slice(0, 500); return json(out, origin); }
  const results = await qRes.json();
  const docs = Array.isArray(results) ? results.filter(r => r.document) : [];
  out.remindersInWindow = docs.length;
  out.reminders = docs.slice(0, 20).map(r => {
    const f = r.document.fields || {};
    return { id: f.id?.stringValue, notifyAt: f.notifyAt?.stringValue, dash: f.dashboard?.stringValue, fired: f.fired?.booleanValue === true };
  });

  // Tokens — read exactly the way the cron reads them, pagination included, so
  // this endpoint can never report a device the cron cannot actually see.
  const tokenDocs = await listTokenDocs(baseUrl, authHdr);
  if (tokenDocs === null) { out.ok = false; out.tokensError = 'fcm_tokens fetch failed'; return json(out, origin); }
  out.uniqueTokens = tokenDocs.length;
  out.tokens = tokenDocs.map(d => ({
    id: (d.name||'').split('/').pop()?.slice(-10),
    dash: d.fields?.mainDash?.stringValue || 'all',
    lastDash: d.fields?.lastDash?.stringValue || null,
    ua: (d.fields?.ua?.stringValue || '').slice(0, 40),
    tokenTail: (d.fields?.token?.stringValue || '').slice(-12)
  }));

  // MATCH ANALYSIS — for each in-window reminder, which tokens would receive it?
  // This is the key diagnostic: a reminder with 0 matching tokens silently never
  // fires. Shows exactly why (e.g. reminder dash="veda" but no device has
  // mainDash="veda"). dashCounts shows the spread of device mainDash values.
  const dashCounts = {};
  tokenDocs.forEach(d => { const md=d.fields?.mainDash?.stringValue||'all'; dashCounts[md]=(dashCounts[md]||0)+1; });
  out.deviceDashCounts = dashCounts;
  out.matchAnalysis = docs.slice(0,20).map(r => {
    const f = r.document.fields || {};
    const dash = f.dashboard?.stringValue || 'all';
    const evt = f.deliverNow?.booleanValue === true || f.source?.stringValue === 'plans';
    const matching = tokenDocs.filter(d => deviceMatches(d, dash, evt)).length;
    return {
      id: f.id?.stringValue,
      dash,
      kind: evt ? 'event' : 'reminder',
      fired: f.fired?.booleanValue === true,
      wouldNotify: matching,
      problem: matching === 0
        ? (evt
            ? `NO DEVICE has mainDash="${dash}" or was last opened as "${dash}" — this event push can never fire`
            : `NO DEVICE has mainDash="${dash}" — this reminder can never fire`)
        : null
    };
  });

  // Optional: force a push right now to confirm FCM delivery end-to-end.
  if (url.searchParams.get('send') === '1') {
    const wantDash = url.searchParams.get('dash') || 'all';
    const targets = tokenDocs.filter(d => deviceMatches(d, wantDash, true));
    out.forcedTo = targets.length;
    const sendResults = [];
    for (const d of targets) {
      const token = d.fields.token.stringValue;
      try {
        await sendFCM(projectId, token, 'WORKER TEST ✓ ' + new Date().toLocaleTimeString(), 'workertest_' + Date.now(), accessToken, 'all', 'event');
        sendResults.push({ token: token.slice(-12), result: 'sent' });
      } catch (e) {
        sendResults.push({ token: token.slice(-12), result: 'FAIL: ' + (e.message || e) });
      }
    }
    out.sendResults = sendResults;
  }

  return json(out, origin);
}

// ══════════════════════════════════════════════════════════════════════════
//  FIX DASHBOARDS — POST /fixdashboards   (one-time server-side data repair)
// ══════════════════════════════════════════════════════════════════════════
// Why: repeating reminders set on one TaskHub were landing on devices whose
// main was the OTHER TaskHub. Root cause = existing reminder docs carrying
// dashboard:'all' (or a wrong value). The cron scoping itself is correct
// (dash==='all' || mainDash===dash); it's the stored data that's wrong. This
// endpoint rebuilds the correct dashboard tag for every reminder doc by reading
// the authoritative task data and matching each reminder's id / notifyRepeatId
// to whichever profile owns it, then PATCHing only the `dashboard` field.
//
// Ownership source of truth (Firestore docs):
//   dashboards/main       → Tony's TaskHub tasks            → 'tony'
//   dashboards/vedasdash  → Veda's TaskHub tasks            → 'veda'
//   dashboards/studyos    → StudyOS (Veda) events/tasks     → 'veda'
//
// Gated by AUTH_SETUP_KEY (same secret used by /auth/profile/setup), so it can
// only be invoked by you via curl. Supports ?dry=1 to preview without writing.
//
//   curl -X POST 'https://<worker>/fixdashboards' \
//        -H 'Content-Type: application/json' \
//        -d '{"key":"<AUTH_SETUP_KEY>"}'
//   add "dry":true to preview.
async function handleFixDashboards(request, env, origin) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, origin, 405);
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const url = new URL(request.url);
  const dryRun = body.dry === true || url.searchParams.get('dry') === '1';
  if (!env.AUTH_SETUP_KEY || body.key !== env.AUTH_SETUP_KEY) {
    return json({ ok: false, error: 'unauthorized' }, origin, 401);
  }

  let accessToken;
  try { accessToken = await getGoogleAccessToken(env); }
  catch (e) { return json({ ok: false, step: 'auth', error: e.message }, origin, 500); }

  const projectId = env.FIREBASE_PROJECT_ID;
  const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const authHdr   = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  // ── 1) Build ownership sets from the authoritative task docs ──────────────
  // Each profile contributes the set of task ids AND notifyRepeatId values that
  // belong to it. A reminder doc is owned by a profile if its notifyRepeatId is
  // in that profile's repeat-set (repeating series), or its id is in that
  // profile's id-set (one-shot), or its id starts with "<repeatId>_" for one of
  // that profile's repeatIds (pre-expanded occurrence whose notifyRepeatId field
  // may be absent on legacy docs).
  const PROFILES = [
    { dash: 'tony', docs: ['dashboards/main'] },
    { dash: 'veda', docs: ['dashboards/vedasdash', 'dashboards/studyos'] }
  ];
  const owner = {}; // dash -> { ids:Set, repeatIds:Set }
  const docReadStatus = {};
  for (const p of PROFILES) {
    owner[p.dash] = { ids: new Set(), repeatIds: new Set() };
    for (const dp of p.docs) {
      const res = await fetch(`${baseUrl}/${dp}`, { headers: authHdr });
      docReadStatus[dp] = res.status;
      if (!res.ok) continue; // doc may not exist (e.g. studyos) — skip
      const doc = await res.json();
      collectIdsFromDashboardDoc(doc, owner[p.dash].ids, owner[p.dash].repeatIds);
    }
  }

  const tonyRepeatIds = owner.tony.repeatIds;
  const vedaRepeatIds = owner.veda.repeatIds;
  const tonyIds = owner.tony.ids;
  const vedaIds = owner.veda.ids;

  function resolveDash(rid, id) {
    // Prefer the unambiguous repeat-series match.
    if (rid) {
      const t = tonyRepeatIds.has(rid), v = vedaRepeatIds.has(rid);
      if (t && !v) return 'tony';
      if (v && !t) return 'veda';
      if (t && v) return null; // ambiguous — leave as-is
    }
    if (id) {
      const t = tonyIds.has(id), v = vedaIds.has(id);
      if (t && !v) return 'tony';
      if (v && !t) return 'veda';
      // pre-expanded occurrence id "<repeatId>_<ts>": derive series and retry
      const series = id.replace(/_r?\d{10,}$/, '');
      if (series && series !== id) {
        const tt = tonyRepeatIds.has(series) || tonyIds.has(series);
        const vv = vedaRepeatIds.has(series) || vedaIds.has(series);
        if (tt && !vv) return 'tony';
        if (vv && !tt) return 'veda';
      }
    }
    return null; // unknown owner — don't touch
  }

  // ── 2) Page through ALL reminder docs ─────────────────────────────────────
  const out = {
    ok: true, dryRun, now: new Date().toISOString(),
    ownership: {
      tony: { tasks: tonyIds.size, repeatSeries: tonyRepeatIds.size },
      veda: { tasks: vedaIds.size, repeatSeries: vedaRepeatIds.size }
    },
    docReadStatus,
    scanned: 0, alreadyCorrect: 0, patched: 0, unresolved: 0, errors: 0,
    samplePatched: [], sampleUnresolved: []
  };

  let pageToken = null;
  do {
    const listUrl = new URL(`${baseUrl}/reminders`);
    listUrl.searchParams.set('pageSize', '300');
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken);
    const listRes = await fetch(listUrl.toString(), { headers: authHdr });
    if (!listRes.ok) { out.ok = false; out.listError = (await listRes.text()).slice(0, 400); break; }
    const listData = await listRes.json();
    const docs = listData.documents || [];
    pageToken = listData.nextPageToken || null;

    for (const d of docs) {
      out.scanned++;
      const f = d.fields || {};
      const id  = f.id?.stringValue || (d.name || '').split('/').pop();
      const rid = f.notifyRepeatId?.stringValue || null;
      const curDash = f.dashboard?.stringValue || 'all';
      const correct = resolveDash(rid, id);

      if (!correct) {
        out.unresolved++;
        if (out.sampleUnresolved.length < 15) out.sampleUnresolved.push({ id, rid, curDash });
        continue;
      }
      if (correct === curDash) { out.alreadyCorrect++; continue; }

      if (out.samplePatched.length < 25) out.samplePatched.push({ id, rid, from: curDash, to: correct });
      if (dryRun) { out.patched++; continue; }

      // PATCH only the dashboard field (cheap: 1 write per doc, masked).
      const patchRes = await fetch(`https://firestore.googleapis.com/v1/${d.name}?updateMask.fieldPaths=dashboard`, {
        method: 'PATCH', headers: authHdr,
        body: JSON.stringify({ fields: { dashboard: { stringValue: correct } } })
      }).catch(() => null);
      if (patchRes && patchRes.ok) out.patched++;
      else out.errors++;
    }
  } while (pageToken);

  return json(out, origin);
}

// Walk a Firestore-REST dashboard doc and collect every task id + notifyRepeatId.
// Tony/Veda TaskHub docs store: data: { <dateKey>: [ {id, notifyAt, notifyRepeat,
// notifyRepeatId, ...}, ... ] }. StudyOS stores events/tasks arrays whose ids the
// client prefixes with sos_ev_ / sos_task_ when scheduling — we record BOTH the
// raw id and the prefixed form so either shape matches.
function collectIdsFromDashboardDoc(doc, idSet, repeatIdSet) {
  const fields = doc && doc.fields;
  if (!fields) return;

  const pushItem = (item) => {
    const m = item && item.mapValue && item.mapValue.fields;
    if (!m) return;
    const id  = m.id?.stringValue;
    const rid = m.notifyRepeatId?.stringValue;
    if (id) {
      idSet.add(id);
      idSet.add('sos_ev_' + id);   // StudyOS event reminder id form
      idSet.add('sos_task_' + id); // StudyOS task reminder id form
    }
    if (rid) repeatIdSet.add(rid);
  };

  const walkArray = (arrVal) => {
    const vals = arrVal && arrVal.arrayValue && arrVal.arrayValue.values;
    if (Array.isArray(vals)) vals.forEach(pushItem);
  };

  // TaskHub shape: data is a map of dateKey -> array
  const dataMap = fields.data?.mapValue?.fields;
  if (dataMap) Object.values(dataMap).forEach(walkArray);

  // StudyOS shape: top-level events / tasks arrays (and a few aliases)
  ['events', 'tasks', 'eventList', 'taskList'].forEach(k => {
    if (fields[k]) walkArray(fields[k]);
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  AUTH / JOURNAL / PROFILE
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
//  SHIELD — profile-wide emergency state
// ══════════════════════════════════════════════════════════════════════════
//
// Shield's desktop agent has to learn that "Emergency — all my devices" was
// pressed even when no browser is open on that machine, so it cannot use the
// Firestore listener the web page uses. It polls here instead.
//
// Why this endpoint rather than the agent reading Firestore directly:
//
//   · COST. A poll straight to Firestore is a billed read per device per poll —
//     roughly 2,900/device/day at 30s. This project has already come within a
//     few hundred reads of the daily free quota once. KV reads are a separate,
//     far larger allowance, so polling here costs no Firestore reads at all.
//   · SECURITY. Turning an emergency OFF is the dangerous direction, and until
//     now only the UI enforced the passcode — anything speaking to Firestore
//     could clear it. Here the passcode is checked SERVER-SIDE against the same
//     PBKDF2 record the app locks use, so an unauthenticated caller can raise a
//     lockdown but can never lift one.
//
// Turning it ON deliberately needs no passcode: it is the fail-safe direction,
// it is reversible, and an emergency button that first asks for a password is
// not an emergency button.
//
// KV holds only the SIGNAL — active, a monotonic version, and who raised it.
// Each device already has its own targets on disk; Firestore stays the record
// the UI reads. That keeps this endpoint tiny and impossible to get out of step
// in a way that matters.

// ── Access token ──────────────────────────────────────────────────────────
//
// This endpoint began life unauthenticated. That was defensible while the URL
// only existed inside compiled code, but the iOS guard pastes it into an
// Apple Shortcut and a setup wizard prints it on screen — so it is now written
// down, and two problems become pressing:
//
//   · READ.  A GET revealed whether a lockdown was live and which device raised
//            it, to anyone holding the URL.
//   · WRITE. A POST with active:true needed NO credential, so anyone holding
//            the URL could close every application on every device of that
//            profile, at will. Turning it OFF was always passcode-checked, so
//            this was disruption rather than a bypass — but a stranger reaching
//            into the machine all the same.
//
// The write is closed outright by an opaque per-profile token; the read is
// reduced to a bare boolean without one, for the reason spelled out at the GET
// handler below. The token is minted on demand by /shield/key, which proves the
// caller knows the profile's Shield passcode using the same PBKDF2 record the
// app locks already use — no second auth system, and no secret that has to be
// deployed with the Worker.
//
// Raising an emergency still needs no PASSWORD, only the token: a button that
// asks for a password first is not an emergency button. The token is what stops
// it being the whole internet's button.

const shieldKey = (profile) => `shield:emergency:${profile}`;
const shieldTokKey = (profile) => `shield:token:${profile}`;
// Reverse index: token → profile. Exists so the guard URL can be JUST the
// token. Shield's UI is required never to show a profile's real name, and that
// URL gets printed in the setup wizard and pasted into an Apple Shortcut, so
// `?profile=tony` would have leaked the one thing the whole app hides.
const shieldTokProfKey = (tok) => `shield:tokprof:${tok}`;
const SHIELD_PROFILES = ['tony', 'veda'];

function randomToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish compare, so a wrong token cannot be found a byte at a time. */
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Mirror a profile-wide emergency into Firestore.
 *
 * There are two stores by design: KV is what the desktop agents poll (a
 * Firestore poll would be a billed read per device per poll), and Firestore is
 * what the OPEN PAGES render from. When the page raises an emergency it writes
 * both itself, so this is not needed. When the AGENT raises one — the tray item
 * or Ctrl+Shift+G, with no window anywhere — nothing was writing Firestore, and
 * the result was a profile-wide lockdown that every screen still described as
 * "this device only", including the phone's.
 *
 * The agent has no Firebase credentials and should not have any; this Worker
 * already holds a service account for the reminders cron, so the mirror belongs
 * here. One write, only on the agent path, so the page path is unchanged.
 */
async function mirrorGlobalToFirestore(env, profile, rec) {
  try {
    const token = await getGoogleAccessToken(env);
    const path = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/dashboards/shield_${profile}`;
    // `global` is a self-contained map, so masking the whole field is correct
    // and cannot clobber `devices` beside it.
    const body = { fields: { global: { mapValue: { fields: {
      active: { booleanValue: !!rec.active },
      v:      { integerValue: String(rec.v || 0) },
      at:     { integerValue: String(rec.at || 0) },
      byId:   { stringValue: String(rec.byId || '') },
      byName: { stringValue: String(rec.byName || '') },
      scope:  { stringValue: 'all' }
    } } } } };
    const r = await fetch(`https://firestore.googleapis.com/v1/${path}?updateMask.fieldPaths=global`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) console.warn('[shield] mirror failed:', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) {
    console.warn('[shield] mirror failed:', e.message);
    return false;
  }
}

/* The guard token, cached in the isolate.
 *
 * The desktop agents poll /shield/emergency around the clock, and every poll was
 * TWO KV reads: the emergency record, and the token to authorise the read. The
 * emergency record genuinely has to be fresh every time - it is the whole point
 * - but the token changes only when somebody rotates it, which is close to
 * never. Reading it per poll doubled Shield's KV bill for no information.
 *
 * A rotation therefore takes up to TTL to be enforced everywhere. That is the
 * cost, and it is the right way round: a stale token briefly keeps working,
 * which is a delay, rather than a fresh one briefly failing, which would take
 * the agents off the remote channel.
 */
const SHIELD_TOK_TTL_MS = 5 * 60 * 1000;
const _shTok = new Map();   // profile -> { k, at }

async function shieldToken(env, profile) {
  const hit = _shTok.get(profile);
  if (hit && Date.now() - hit.at < SHIELD_TOK_TTL_MS) return hit.rec;
  const rec = await getJSON(env, shieldTokKey(profile));
  _shTok.set(profile, { rec, at: Date.now() });
  return rec;
}
function shieldTokenForget(profile) { _shTok.delete(profile); }

async function shieldTokenOk(env, profile, given) {
  const tok = await shieldToken(env, profile);
  // No token minted yet → this profile has never run the key flow, so the
  // endpoint stays open for it. Minting one is what turns protection on, and
  // doing it this way means an existing install keeps working until its wizard
  // is run rather than locking the user out of their own emergency.
  if (!tok || !tok.k) return true;
  return tokensMatch(tok.k, String(given || ''));
}

async function handleShield(path, request, env, origin, url) {
  if (!env.TOKEN_CACHE) return json({ ok: false, error: 'KV not bound' }, origin, 500);

  // Mint (or return) the profile's token. Passcode-gated.
  if (path === '/shield/key' && request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, origin, 400); }
    const profile = String(body.profile || '').toLowerCase();
    if (!SHIELD_PROFILES.includes(profile)) return json({ ok: false, error: 'bad profile' }, origin, 400);

    const lock = await getJSON(env, jKey('applock', `${profile}_shield`));
    if (lock) {
      const password = String(body.password || '');
      if (!password || !(await verifyHash(password, lock))) {
        return json({ ok: false, error: 'badpassword' }, origin, 403);
      }
    }
    // No passcode set: nothing to verify against. Same reasoning as the OFF
    // path — refusing would leave the user unable to set this up at all.

    let tok = await getJSON(env, shieldTokKey(profile));
    if (!tok || !tok.k || body.rotate === true) {
      const old = tok && tok.k;
      tok = { k: randomToken(), at: Date.now() };
      await env.TOKEN_CACHE.put(shieldTokKey(profile), JSON.stringify(tok));
      shieldTokenForget(profile);
      await env.TOKEN_CACHE.put(shieldTokProfKey(tok.k), JSON.stringify({ profile }));
      // A rotation has to actually revoke the old token, or "rotate" means
      // nothing — the wizard offers it precisely for the case where the old URL
      // got somewhere it should not have.
      if (old) await env.TOKEN_CACHE.delete(shieldTokProfKey(old));
    } else if (!(await getJSON(env, shieldTokProfKey(tok.k)))) {
      // Token minted before the reverse index existed. Backfill it so the
      // token-only URL works without forcing a rotation.
      await env.TOKEN_CACHE.put(shieldTokProfKey(tok.k), JSON.stringify({ profile }));
    }
    return json({ ok: true, k: tok.k }, origin);
  }

  // Reading and writing are gated differently, on purpose.
  //
  // The dangerous direction is the WRITE — a POST could close every application
  // on every device of a profile with no credential at all — so that is token-
  // gated outright. The READ is not, and cannot be: the desktop agent polls this
  // endpoint, its token is handed down by the Shield page, and if the page is
  // never opened on that PC after a token is minted on the phone, gating the
  // read would make the agent go quietly deaf to remote emergencies. A feature
  // whose whole point is reaching a PC with its browser shut must not break
  // because a token was minted somewhere else.
  //
  // So an un-keyed read gets the minimal record — the boolean and its version,
  // nothing about which device raised it or when. What leaks is that a profile
  // is currently locked down, to someone who already guessed the profile name.
  // A keyed read gets everything.
  if (path === '/shield/emergency' && request.method === 'GET') {
    const given = url.searchParams.get('k') || '';
    let profile = (url.searchParams.get('profile') || '').toLowerCase();
    // Token-only form, used by the iOS guard shortcut: the token names its own
    // profile, so the URL never has to.
    if (!profile && given) {
      const rev = await getJSON(env, shieldTokProfKey(given));
      if (rev && rev.profile) profile = String(rev.profile).toLowerCase();
    }
    if (!SHIELD_PROFILES.includes(profile)) return json({ ok: false, error: 'bad profile' }, origin, 400);

    const rec = (await getJSON(env, shieldKey(profile))) || { active: false, v: 0 };
    const tok = await shieldToken(env, profile);
    // `active` is deliberately a plain top-level boolean in both shapes: the
    // Shortcut reads it with one Get Dictionary Value, and every extra level of
    // nesting is another action a person has to add by hand on a phone.
    if (!given) {
      // Nothing minted yet means nothing to protect, so an existing install
      // keeps the answer it has always had — including the device name its
      // takeover screen shows. Trimming starts only once a token exists.
      if (!tok || !tok.k) return json({ ok: true, ...rec }, origin);
      return json({ ok: true, active: !!rec.active, v: rec.v || 0 }, origin);
    }
    if (!tok || !tok.k || !tokensMatch(tok.k, given)) {
      return json({ ok: false, error: 'badkey' }, origin, 403);
    }
    return json({ ok: true, ...rec }, origin);
  }

  if (path === '/shield/emergency' && request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, origin, 400); }

    const profile = String(body.profile || '').toLowerCase();
    if (!SHIELD_PROFILES.includes(profile)) return json({ ok: false, error: 'bad profile' }, origin, 400);
    if (!(await shieldTokenOk(env, profile, body.k))) {
      return json({ ok: false, error: 'badkey' }, origin, 403);
    }
    const active = !!body.active;

    // Lifting a lockdown requires the profile's Shield passcode, checked here
    // rather than trusted from the client. Raising one does not.
    if (!active) {
      const rec = await getJSON(env, jKey('applock', `${profile}_shield`));
      if (rec) {
        const password = String(body.password || '');
        if (!password || !(await verifyHash(password, rec))) {
          return json({ ok: false, error: 'badpassword' }, origin, 403);
        }
      }
      // No passcode set for that profile: nothing to verify against, and
      // refusing would strand every device in a lockdown nobody can lift.
    }

    // Monotonic version. Never let a stale or replayed write win, and never let
    // a client's clock move the state backwards.
    const prev = (await getJSON(env, shieldKey(profile))) || { v: 0 };
    const v = Math.max(Number(body.v) || 0, (prev.v || 0) + 1);
    const rec = {
      active,
      v,
      at: Date.now(),
      byId: String(body.byId || '').slice(0, 64),
      byName: String(body.byName || '').slice(0, 64),
    };
    await env.TOKEN_CACHE.put(shieldKey(profile), JSON.stringify(rec));
    // Raised by the agent (tray or global hotkey), where no page exists to
    // write Firestore. See mirrorGlobalToFirestore.
    if (body.via === 'agent') {
      await mirrorGlobalToFirestore(env, profile, rec);
    }
    return json({ ok: true, ...rec }, origin);
  }

  return json({ ok: false, error: 'not found' }, origin, 404);
}

async function handleAuth(path, request, env, origin) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, origin, 405);
  if (!env.TOKEN_CACHE) return json({ ok: false, error: 'KV not bound' }, origin, 500);

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, origin, 400); }

  // Creating a lock where none exists is open (that is first-run). OVERWRITING
  // one is not: without this check, anyone who could guess an entryId could POST
  // a new password over an existing lock and own it. The established
  // change-password flow in every app is verify → remove-lock → set-lock, so by
  // the time it lands here the record is already gone and nothing needs to
  // change client-side; `current` is offered for a caller that would rather
  // rotate in one step.
  if (path === '/auth/journal/set-lock') {
    const { journal, entryId, password, hint, current } = body;
    if (!journal || !entryId || !password) return json({ ok: false, error: 'missing fields' }, origin, 400);
    const k = jKey(journal, entryId);
    const existing = await getJSON(env, k);
    if (existing) {
      const wait = await guessBlocked(env, k);
      if (wait) return throttled(wait, origin);
      if (!current || !(await verifyHash(current, existing))) {
        await guessFail(env, k);
        return json({ ok: false, error: 'needs-current' }, origin, 403);
      }
      await guessClear(env, k);
    }
    const rec = await makeHash(password);
    rec.hint = typeof hint === 'string' ? hint : '';
    await env.TOKEN_CACHE.put(k, JSON.stringify(rec));
    return json({ ok: true }, origin);
  }

  if (path === '/auth/journal/verify') {
    const { journal, entryId, password } = body;
    if (!journal || !entryId || !password) return json({ ok: false }, origin);
    const k = jKey(journal, entryId);
    const wait = await guessBlocked(env, k);
    if (wait) return throttled(wait, origin);
    const rec = await getJSON(env, k);
    if (!rec) return json({ ok: false, noLock: true }, origin);
    const ok = await verifyHash(password, rec);
    if (ok) await guessClear(env, k); else await guessFail(env, k);
    return json({ ok }, origin);
  }

  if (path === '/auth/journal/remove-lock') {
    const { journal, entryId, password } = body;
    if (!journal || !entryId || !password) return json({ ok: false }, origin);
    const k = jKey(journal, entryId);
    const wait = await guessBlocked(env, k);
    if (wait) return throttled(wait, origin);
    const rec = await getJSON(env, k);
    if (!rec) return json({ ok: true }, origin);
    if (!(await verifyHash(password, rec))) { await guessFail(env, k); return json({ ok: false }, origin); }
    await guessClear(env, k);
    await env.TOKEN_CACHE.delete(k);
    return json({ ok: true }, origin);
  }

  if (path === '/auth/journal/update-hint') {
    const { journal, entryId, password, hint } = body;
    if (!journal || !entryId || !password) return json({ ok: false }, origin);
    const k = jKey(journal, entryId);
    const wait = await guessBlocked(env, k);
    if (wait) return throttled(wait, origin);
    const rec = await getJSON(env, k);
    if (!rec || !(await verifyHash(password, rec))) { await guessFail(env, k); return json({ ok: false }, origin); }
    await guessClear(env, k);
    rec.hint = typeof hint === 'string' ? hint : '';
    await env.TOKEN_CACHE.put(k, JSON.stringify(rec));
    return json({ ok: true }, origin);
  }

  // "Does a lock exist here?" — and nothing else. Insight and OneInbox ask this
  // on every page load to decide between the setup and unlock screens. They used
  // to ask /hint for it, which was fine while /hint just returned text; now that
  // /hint MAILS the owner, a boot-time call there would send an email on every
  // single page load. This endpoint answers the boot question without mailing.
  if (path === '/auth/journal/status') {
    const { journal, entryId } = body;
    if (!journal || !entryId) return json({ ok: false, error: 'missing fields' }, origin, 400);
    const rec = await getJSON(env, jKey(journal, entryId));
    return json({ ok: true, hasLock: !!rec, noLock: !rec }, origin);
  }

  // The hint is deliberately reachable without a password (that is the whole
  // point of "forgot password?"), which used to mean it was readable by anyone
  // who asked. It is now MAILED to the owner instead of returned, so asking for
  // someone else's hint tells you nothing and merely sends them an email.
  if (path === '/auth/journal/hint') {
    const { journal, entryId } = body;
    if (!journal || !entryId) return json({ noLock: true }, origin);
    const k = jKey(journal, entryId);
    // Throttled in its OWN namespace: a mail flood must not lock the password
    // out, and a locked-out password must not block the way back in.
    const mk = 'mail:' + k;
    const wait = await guessBlocked(env, mk);
    if (wait) return throttled(wait, origin);
    const rec = await getJSON(env, k);
    if (!rec) return json({ noLock: true }, origin);
    const box = mailboxFor(env, body);
    const label = String(body.label || entryId);
    const m = hintMail(label, rec.hint, body.appName);
    const ok = await sendMail(box, m.subject, m.message);
    await guessFail(env, mk);
    return json({ ok, emailed: ok, to: maskEmail(box.email) }, origin);
  }

  if (path === '/auth/profile/verify') {
    const { profile, password } = body;
    if (!profile || !password) return json({ ok: false }, origin);
    const k = pKey(profile);
    const wait = await guessBlocked(env, k);
    if (wait) return throttled(wait, origin);
    const rec = await getJSON(env, k);
    if (!rec) return json({ ok: false, noLock: true }, origin);
    const ok = await verifyHash(password, rec);
    if (ok) await guessClear(env, k); else await guessFail(env, k);
    return json({ ok }, origin);
  }

  // Seed/reset a profile password. Gated by AUTH_SETUP_KEY (call via curl).
  if (path === '/auth/profile/setup') {
    const { profile, password, key } = body;
    if (!env.AUTH_SETUP_KEY || key !== env.AUTH_SETUP_KEY) return json({ ok: false, error: 'unauthorized' }, origin, 401);
    if (!profile || !password) return json({ ok: false, error: 'missing fields' }, origin, 400);
    await env.TOKEN_CACHE.put(pKey(profile), JSON.stringify(await makeHash(password)));
    return json({ ok: true }, origin);
  }

  // ── PASSWORD RESET VIA EMAILED CODE ──────────────────────────────────────
  // request: generate a short code, store it hashed (with TTL) and MAIL it to
  // the lock's owner. confirm: check the pasted code + attempt count, then set
  // the new password. Works for any journal/entryId lock (MyList, journals,
  // app-locks, tab-locks) and for profile passwords.
  //
  // This endpoint used to return the code in its own response so the page could
  // email it. That made the reset flow a complete bypass of the lock: ask for a
  // code, read it off the reply, confirm with it, own the lock. The code now
  // goes only to the address derived from the lock id (see mailboxFor) and the
  // reply carries nothing but "sent, to t***@…". Asking for someone else's
  // reset now just sends them an email.
  if (path === '/auth/reset/request') {
    const key = resetKeyFor(body);
    if (!key) return json({ ok: false, error: 'missing fields' }, origin, 400);
    // Own namespace — see the note on /auth/journal/hint. Someone who has just
    // locked themselves out by guessing needs this path to still work.
    const mk = 'mail:' + key;
    const wait = await guessBlocked(env, mk);
    if (wait) return throttled(wait, origin);
    const lock = await getJSON(env, key);
    if (!lock) return json({ ok: false, noLock: true }, origin);
    const code = genResetCode();
    const codeRec = await makeHash(code);
    const box = mailboxFor(env, body);
    const label = String(body.label || body.entryId || body.profile || 'your lock');
    const m = resetMail(label, code, body.appName);
    // Mail FIRST: if it can't be delivered there is no point storing a code
    // nobody will ever see, and the caller must be told the reset didn't start.
    if (!(await sendMail(box, m.subject, m.message))) {
      return json({ ok: false, error: 'email-failed' }, origin, 502);
    }
    await env.TOKEN_CACHE.put('reset:' + key,
      JSON.stringify({ code: codeRec, exp: Date.now() + RESET_TTL * 1000, tries: 0 }),
      { expirationTtl: RESET_TTL });
    await guessFail(env, mk);   // rate-limit the mailer itself
    return json({ ok: true, emailed: true, to: maskEmail(box.email) }, origin);
  }

  if (path === '/auth/reset/confirm') {
    const key = resetKeyFor(body);
    const code = String(body.code || '').trim().toUpperCase();
    const password = body.password;
    if (!key || !code || !password) return json({ ok: false, error: 'missing fields' }, origin, 400);
    const rr = await getJSON(env, 'reset:' + key);
    if (!rr) return json({ ok: false, error: 'expired' }, origin);
    if (Date.now() > (rr.exp || 0)) { await env.TOKEN_CACHE.delete('reset:' + key); return json({ ok: false, error: 'expired' }, origin); }
    const good = await verifyHash(code, rr.code);
    if (!good) {
      rr.tries = (rr.tries || 0) + 1;
      if (rr.tries >= RESET_MAX_TRIES) { await env.TOKEN_CACHE.delete('reset:' + key); return json({ ok: false, error: 'locked' }, origin); }
      // Preserve the original TTL window rather than resetting it on each try.
      const remainingTtl = Math.max(60, Math.ceil(((rr.exp || 0) - Date.now()) / 1000));
      await env.TOKEN_CACHE.put('reset:' + key, JSON.stringify(rr), { expirationTtl: remainingTtl });
      return json({ ok: false, error: 'badcode', remaining: RESET_MAX_TRIES - rr.tries }, origin);
    }
    const newRec = await makeHash(password);
    if (body.profile) {
      await env.TOKEN_CACHE.put(pKey(body.profile), JSON.stringify(newRec));
    } else {
      newRec.hint = typeof body.hint === 'string' ? body.hint : '';
      await env.TOKEN_CACHE.put(jKey(body.journal, body.entryId), JSON.stringify(newRec));
    }
    await env.TOKEN_CACHE.delete('reset:' + key);
    // The password just changed, so any lockout earned by guessing the OLD one
    // is meaningless — clear it rather than making a recovered user wait it out.
    await guessClear(env, key);
    return json({ ok: true }, origin);
  }

  return json({ ok: false, error: 'unknown route' }, origin, 404);
}

const jKey = (journal, entryId) => `jlock:${journal}:${entryId}`;
const pKey = (profile) => `profilepw:${profile}`;

async function getJSON(env, key) {
  try { return await env.TOKEN_CACHE.get(key, 'json'); } catch { return null; }
}

const PBKDF2_ITER = 100000;

function b64(bytes) {
  let s = ''; new Uint8Array(bytes).forEach(b => s += String.fromCharCode(b));
  return btoa(s);
}
function fromB64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function pbkdf2(password, saltBytes, iter) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: iter, hash: 'SHA-256' }, km, 256);
  return new Uint8Array(bits);
}

async function makeHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return { hash: b64(hash), salt: b64(salt), iter: PBKDF2_ITER };
}

async function verifyHash(password, rec) {
  if (!rec || !rec.hash || !rec.salt) return false;
  const iter = rec.iter || PBKDF2_ITER;
  const got = await pbkdf2(password, fromB64(rec.salt), iter);
  const want = fromB64(rec.hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

// ── Password-reset codes (emailed) ──────────────────────────────────────────
const RESET_TTL = 15 * 60;      // seconds a code stays valid
const RESET_MAX_TRIES = 6;      // wrong guesses before a code is burned
function resetKeyFor(body) {
  if (body && body.profile) return pKey(body.profile);
  if (body && body.journal && body.entryId) return jKey(body.journal, body.entryId);
  return null;
}
function genResetCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1 (avoid confusion)
  const r = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[r[i] % alphabet.length];
  return s;
}

// Mail from the WORKER so secrets never travel back to the requester.
// Formspree is the same transport the pages already use and it accepts a
// server-side POST, so this needs no new account, key or secret.
async function sendMail(box, subject, message) {
  try {
    const r = await fetch(box.form, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ email: box.email, subject, message }),
    });
    return r.ok;
  } catch (e) { return false; }
}
function resetMail(label, code, appName) {
  const app = appName || 'A1';
  return {
    subject: app + ' — Password Reset Code',
    message: 'Your password reset code for ' + (label || 'your lock') + ' is:\n\n    ' + code +
      '\n\nEnter this code to set a new password. It expires in 15 minutes.\n\n' +
      'If you did not request this, ignore this email — your current password ' +
      'stays in place and nothing changes.\n\n— ' + app,
  };
}
function hintMail(label, hint, appName) {
  const app = appName || 'A1';
  return {
    subject: app + ' — Password Hint',
    message: 'Your password hint for ' + (label || 'your lock') + ':\n\n    ' +
      (hint || '(no hint was saved)') +
      '\n\nThis is only the reminder you saved — your password itself is never ' +
      'stored and cannot be emailed.\n\n— ' + app,
  };
}

// ── Brute-force throttle ────────────────────────────────────────────────────
// Every client already enforces "5 wrong tries → 30s cooldown", but that lives
// in the page: a direct HTTP caller never runs it. This is the same budget
// enforced where it actually binds, keyed per lock.
//
// KV is eventually consistent, so under a burst the count can lag by a second
// or so and a few extra guesses may land. That is fine for the job — the point
// is turning UNLIMITED online guessing into a hard stop, not counting exactly.
const GUESS_MAX = 8;            // wrong answers before the lock stops replying
const GUESS_WINDOW = 15 * 60;   // seconds the counter — and the lockout — live

async function guessState(env, key) {
  const r = await getJSON(env, 'fail:' + key);
  return { n: (r && r.n) || 0, until: (r && r.until) || 0 };
}
// → 0 when free to try, else the seconds remaining on the lockout.
async function guessBlocked(env, key) {
  const s = await guessState(env, key);
  if (s.until && Date.now() < s.until) return Math.max(1, Math.ceil((s.until - Date.now()) / 1000));
  return 0;
}
async function guessFail(env, key) {
  const s = await guessState(env, key);
  const n = s.n + 1;
  const until = n >= GUESS_MAX ? Date.now() + GUESS_WINDOW * 1000 : 0;
  try {
    await env.TOKEN_CACHE.put('fail:' + key, JSON.stringify({ n, until }), { expirationTtl: GUESS_WINDOW });
  } catch (e) {}
}
async function guessClear(env, key) {
  try { await env.TOKEN_CACHE.delete('fail:' + key); } catch (e) {}
}
function throttled(secs, origin) {
  return json({ ok: false, error: 'throttled', retryAfter: secs }, origin, 429);
}

// ══════════════════════════════════════════════════════════════════════════
//  REMINDERS CRON
//  Due/stale classification and push delivery are unchanged. What is new is the
//  KV lookahead above it, which lets a tick that has nothing to do return
//  without paying for a Firestore query — see the NEXT_DUE_KEY block up top.
// ══════════════════════════════════════════════════════════════════════════

// True when a previous tick already proved nothing is due for a while. Costs one
// KV read (free at this volume) and saves the billed Firestore query. Fails
// OPEN in every uncertain case — the only outcome of returning false is that we
// run the query we used to run every minute anyway.
async function shouldSkipTick(env, now) {
  if (!env.TOKEN_CACHE) return false;                   // no KV → never skip
  if (new Date(now).getMinutes() === 0) return false;   // top of hour: stale sweep + cleanup must run
  try {
    const c = await env.TOKEN_CACHE.get(NEXT_DUE_KEY, 'json');
    if (!c || typeof c.checkedAt !== 'number') return false;
    const age = now - c.checkedAt;
    if (age < 0 || age > LOOKAHEAD_MAX_AGE_MS) return false;  // stale/clock skew → re-verify
    if (c.nextDueAt === null) return true;              // verified: nothing upcoming at all
    if (typeof c.nextDueAt !== 'number') return false;
    return now < c.nextDueAt - LOOKAHEAD_GRACE_MS;
  } catch (e) {
    return false;
  }
}

// Record when the next reminder is due, so idle ticks can skip the query.
// `nextInWindow` is the earliest not-yet-due doc the tick already read — when it
// is set the answer is free, because we paid for that result set already. Only
// when the window held nothing pending do we spend ONE read to look past it.
async function refreshLookahead(env, baseUrl, authHdr, now, nextInWindow, windowEnd) {
  if (!env.TOKEN_CACHE) return;
  let nextDueAt = nextInWindow;
  if (nextDueAt === null) {
    try {
      const res = await fetch(`${baseUrl}:runQuery`, {
        method: 'POST', headers: authHdr,
        body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: 'reminders' }],
          // Single-field range + matching orderBy — no composite index needed,
          // same shape as the main query.
          where: { fieldFilter: { field: { fieldPath: 'notifyAt' }, op: 'GREATER_THAN', value: { stringValue: new Date(windowEnd).toISOString() } } },
          orderBy: [{ field: { fieldPath: 'notifyAt' }, direction: 'ASCENDING' }],
          limit: 1
        } })
      });
      if (!res.ok) return;                    // leave the key absent → next tick queries
      const rows = await res.json();
      const hit  = Array.isArray(rows) ? rows.find(r => r.document) : null;
      const at   = hit ? new Date(hit.document.fields?.notifyAt?.stringValue).getTime() : NaN;
      nextDueAt  = isNaN(at) ? null : at;
    } catch (e) { return; }
  }
  // Only write when a LATER tick could actually use the result to skip.
  //
  // shouldSkipTick() skips on `now < nextDueAt - LOOKAHEAD_GRACE_MS`, so once we
  // are inside that window no future tick will skip whatever we store here — it
  // is going to run the query either way until this reminder passes. Writing
  // anyway cost one KV write per tick for the whole 15 minutes before EVERY
  // reminder, which on the free plan (1,000 writes/day against 100,000 reads)
  // was the single largest avoidable line on the bill. `nextDueAt === null`
  // stays worth writing: that is the "nothing upcoming at all" answer every
  // idle tick skips on.
  if (nextDueAt !== null && now >= nextDueAt - LOOKAHEAD_GRACE_MS) return;

  try {
    // TTL is a third safety net: even a wedged cache self-heals within the hour.
    await env.TOKEN_CACHE.put(
      NEXT_DUE_KEY,
      JSON.stringify({ nextDueAt, checkedAt: now }),
      { expirationTtl: 3600 }
    );
  } catch (e) { /* non-fatal — the next tick just queries */ }
}

// Every registered device, de-duped by token.
//
// PAGINATED. Firestore's REST list endpoint returns a DEFAULT PAGE of 20
// documents plus a nextPageToken, and the old call read neither. Device docs are
// keyed by a localStorage device id, so they accumulate — a cleared browser
// profile, a reinstalled PWA or a new phone each mint another one. Once the
// collection passed 20 docs, every device after the first page became invisible
// to this worker and silently stopped receiving anything: no error, no log, just
// a person who no longer gets notifications. Ask for a full page and follow the
// cursor.
async function listTokenDocs(baseUrl, authHdr) {
  const out = [];
  const seen = new Set();
  let pageToken = null;
  do {
    const url = new URL(`${baseUrl}/fcm_tokens`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), { headers: authHdr });
    if (!res.ok) { console.error('FCM tokens fetch failed:', await res.text()); return null; }
    const data = await res.json();
    for (const d of (data.documents || [])) {
      const t = d.fields?.token?.stringValue;
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(d);
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return out;
}

// Does this device belong to the profile a notification is addressed to?
//
// `mainDash` is the device's declared main dashboard, and it is the right test
// for a SCHEDULED reminder: those are personal alarms and must not ring on the
// other person's device.
//
// An EVENT push is addressed to a PERSON, not to a device role, and its in-app
// twin already follows the person: _thPlanBanner shows on whichever profile is
// OPEN right now. Routing the push on mainDash alone contradicted that, and the
// two gates could exclude each other completely. On a device whose main is the
// other profile — including one that merely had the other profile opened on it
// first, since goTony/goVeda auto-claim an unset main — the push was never sent
// AND the banner never fired, so the person sitting in front of it got no
// notification on either surface. That is the "Veda proposed/confirmed a plan
// and the other side heard nothing" case. `lastDash`, the profile most recently
// opened on that device, closes exactly that gap, and only for events: reminder
// scoping is untouched.
function deviceMatches(d, dash, eventPush) {
  if (dash === 'all') return true;
  const md = d.fields?.mainDash?.stringValue || 'all';
  if (md === dash) return true;
  if (!eventPush) return false;
  return (d.fields?.lastDash?.stringValue || '') === dash;
}

async function runReminders(env) {
  const now = Date.now();

  if (await shouldSkipTick(env, now)) return;

  let accessToken;
  try { accessToken = await getGoogleAccessToken(env); }
  catch (e) { console.error('Auth failed:', e.message); return; }

  const projectId = env.FIREBASE_PROJECT_ID;
  const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const authHdr   = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  // Read ONLY the narrow due-window. The previous query was unbounded on the
  // upper end (notifyAt >= now-2hr, ASC, limit 100) so it returned — and was
  // BILLED for — up to 100 future-dated docs EVERY minute. With repeating
  // reminders pre-expanding many future occurrences, that pinned reads at
  // 100/tick × 60 = 6,000/hr around the clock, even idle. Bounding the upper
  // edge to ~10min ahead means a normal tick reads 0–2 docs.
  //   lower bound: now - 16min (see below)
  //   upper bound: now + 10min  (anything sooner than the next few ticks)
  //
  // The lower bound is 16 minutes, not the 90s the DUE test uses, because the
  // two answer different questions. 90s is how late a SCHEDULED alarm may be and
  // still ring. 16 minutes is how far back this query must look to be sure it
  // SEES an event push (deliverNow, below) written since the last tick that
  // actually ran — and with the lookahead skip in place, that gap can be a full
  // LOOKAHEAD_MAX_AGE_MS. An event push dated by a browser whose clock lags, or
  // written on a tick whose wake poke never landed, fell outside a 90s window
  // and so was never returned by a normal tick at all: it surfaced only in the
  // top-of-hour sweep, which marks stale docs fired WITHOUT sending. That is how
  // a proposed plan could be queued perfectly and still never reach the other
  // person. The extra reads are bounded by what fired in the last 16 minutes —
  // typically 0-3 docs — not by the future-dated pile the old unbounded query
  // walked.
  const startAtIso = new Date(now - 16 * 60 * 1000).toISOString();
  const endAtIso   = new Date(now + 10 * 60 * 1000).toISOString();
  const tenMinFromNow = now + 10 * 60 * 1000;
  // Sweep window for STALE reminders (device offline, missed their minute).
  // Run only at the top of the hour so the wider read happens 1×/hr instead of
  // every tick — keeps stale recovery without the per-tick read cost.
  const doStaleSweep = new Date(now).getMinutes() === 0;
  const sweepStartIso = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const queryRes = await fetch(`${baseUrl}:runQuery`, {
    method: 'POST', headers: authHdr,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'reminders' }],
        // Explicit range filter on a SINGLE field (notifyAt) — no composite
        // index needed, and unambiguous (cursor before:true/false semantics
        // were the suspected cause of delivery stopping). Lower bound widens
        // to -2h only at the top of the hour for stale recovery.
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'notifyAt' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: doStaleSweep ? sweepStartIso : startAtIso } } },
              { fieldFilter: { field: { fieldPath: 'notifyAt' }, op: 'LESS_THAN_OR_EQUAL',    value: { stringValue: endAtIso } } }
            ]
          }
        },
        orderBy: [{ field: { fieldPath: 'notifyAt' }, direction: 'ASCENDING' }],
        limit: 100
      }
    })
  });
  if (!queryRes.ok) { console.error('Reminders query failed:', await queryRes.text()); return; }
  const results = await queryRes.json();
  if (!Array.isArray(results)) return;
  // Per-tick read accounting — Firestore bills 1 read per doc returned. This
  // line makes the read volume visible in `wrangler tail`: a healthy bounded
  // query logs a single-digit count; ~100 means the old unbounded query is
  // still live (redeploy needed).
  const _docCount = results.filter(r => r.document).length;
  console.log(`[reminders] tick read ${_docCount} doc(s) | window ${doStaleSweep ? '(stale sweep -2h)' : '-90s..+10m'}`);

  // A reminder is a SCHEDULED alarm: ringing it long after its minute is worse
  // than staying quiet, so anything more than 90s late is dropped — marked fired
  // and never sent. An EVENT push is the opposite. `deliverNow` means "this just
  // happened, deliver it at the first opportunity": it has no meaningful minute,
  // so no amount of lateness can make it undeliverable. A missed tick, a lost
  // wake poke, a lagging client clock or an offline stretch must DELAY one,
  // never destroy it. Without this every Plans notification was one skipped tick
  // away from being silently marked fired with nobody notified.
  //
  // `source:'plans'` is honoured alongside the flag so docs written by an older
  // client build — which sets source but not deliverNow — are covered too.
  const isEventPush = (fsDoc) => {
    const f = fsDoc.fields || {};
    return f.deliverNow?.booleanValue === true || f.source?.stringValue === 'plans';
  };

  const due = [], stale = [];
  // Earliest UNFIRED doc in this window that is not due YET. It is the next
  // moment the cron has to be awake for, and it comes free out of the result
  // set we have already been billed for — so a tick that sees one never has to
  // spend a second read to build its lookahead.
  let nextInWindow = null;
  for (const r of results) {
    if (!r.document) continue;
    if (r.document.fields?.fired?.booleanValue === true) continue;
    const at = new Date(r.document.fields?.notifyAt?.stringValue).getTime();
    if (isEventPush(r.document)) {
      // Only its own future date can hold an event push back, and only briefly.
      // An unreadable date is no reason to withhold one.
      if (isNaN(at) || at <= now + 5000) due.push(r);
      else if (nextInWindow === null || at < nextInWindow) nextInWindow = at;
      continue;
    }
    if (isNaN(at)) continue;
    if (at > tenMinFromNow) continue;
    if (at <= now + 5000 && at > now - 90000) due.push(r);
    else if (at <= now - 90000) stale.push(r);
    // Everything left is inside the window but still ahead of us. Capturing it
    // is what stops the lookahead from ever jumping PAST a pending reminder:
    // "nothing due this tick" is not the same as "nothing due for 10 minutes".
    else if (nextInWindow === null || at < nextInWindow) nextInWindow = at;
  }

  if (!due.length && !stale.length) {
    if (new Date(now).getMinutes() === 0) {
      await cleanupFiredReminders(baseUrl, authHdr);
    }
    await refreshLookahead(env, baseUrl, authHdr, now, nextInWindow, tenMinFromNow);
    return;
  }

  const tokenDocs = await listTokenDocs(baseUrl, authHdr);
  if (tokenDocs === null) return;    // fetch failed; already logged

  for (const r of stale) {
    await markFired(r.document.name, accessToken);
    await maybeReschedule(r.document, baseUrl, authHdr);
  }

  // Collapse duplicate due docs so any legacy pile of duplicate reminders can't
  // fire dozens of identical pushes at once. Key on the reminder ID (globally
  // unique per item — e.g. sos_ev_<x> vs sos_task_<y>), NOT on title. A
  // title-based key wrongly collapsed two DISTINCT reminders that happened to
  // render the same text at the same minute, dropping all but the first — which
  // is exactly how a task + event set for the same time lost one push. Legacy
  // docs missing an id fall back to content-based collapse so old dup piles are
  // still suppressed.
  // Collapse to ONE push per OCCURRENCE — keyed on (series + minute), not on
  // the doc id. Two schedulers can write the same occurrence under different
  // ids (client expands '<series>_<ts>'; legacy worker reschedule wrote
  // '<series>_r<ts>'), and the stale sweep can surface several at once. Keying
  // on the distinct doc id let each fire separately (the 2–3× bug). The series
  // is notifyRepeatId when present, else the reminder id with any occurrence
  // suffix stripped; the minute is notifyAt floored to 60s. Falls back to
  // content for legacy docs with no id.
  function occKeyFor(fields){
    const id   = fields.id?.stringValue || '';
    const repId= fields.notifyRepeatId?.stringValue || '';
    const nAt  = fields.notifyAt?.stringValue || '';
    const t    = new Date(nAt).getTime();
    if (isNaN(t)) {
      const dash = fields.dashboard?.stringValue || 'all';
      const title= fields.title?.stringValue || '';
      return id ? ('occ:' + id) : ('c:' + title + '|' + nAt + '|' + dash);
    }
    // strip a trailing _<ts> or _r<ts> occurrence suffix to recover the series
    const series = repId || id.replace(/_r?\d{10,}$/, '') || id;
    return 'occ:' + series + ':' + Math.floor(t / 60000);
  }

  // CONTENT key — the occurrence key above collapses only docs that agree on the
  // SERIES, and the duplicates that actually reach people do not. Every edit of a
  // repeating task re-expands it client-side under a BRAND-NEW notifyRepeatId,
  // and the old series' docs are never deleted, so each edit adds one more live
  // series firing the same reminder at the same minute. One weekly "Charge Car"
  // had accumulated five (May 7 → Jul 18) and shipped five pushes per Friday.
  // Two docs that render the same text, for the same profile, at the same minute
  // are ONE reminder to the person receiving them — the card shows nothing else
  // to tell them apart — so only the first is sent. Title is normalised because
  // re-typing an edited task changes its casing ("Charge car" vs "Charge Car").
  function contentKeyFor(fields){
    const dash  = fields.dashboard?.stringValue || 'all';
    const title = (fields.title?.stringValue || '').trim().toLowerCase();
    const nAt   = fields.notifyAt?.stringValue || '';
    const t     = new Date(nAt).getTime();
    return 'c:' + dash + '|' + title + '|' + (isNaN(t) ? nAt : Math.floor(t / 60000));
  }

  const sentKeys = new Set();
  const sentContent = new Set();
  await Promise.allSettled(due.map(async (r) => {
    const fields = r.document.fields || {};
    const title  = fields.title?.stringValue || 'Task reminder';
    const id     = fields.id?.stringValue    || '';
    const dash   = fields.dashboard?.stringValue || 'all';
    const evt    = isEventPush(r.document);
    const key    = occKeyFor(fields);
    const cKey   = contentKeyFor(fields);

    // Claim BOTH keys BEFORE any await — Promise.allSettled runs these
    // concurrently, and an await before the add() would let two docs for the
    // same occurrence both see has()===false and both fire. Synchronous
    // check+add here makes the first doc the sole sender. A doc is a duplicate
    // if EITHER key is already claimed: same occurrence, or same visible text at
    // the same minute for the same profile (the orphaned-series case).
    const dup = sentKeys.has(key) || sentContent.has(cKey);
    if (!dup) { sentKeys.add(key); sentContent.add(cKey); }

    await maybeReschedule(r.document, baseUrl, authHdr);

    // Scope: profile-tagged notification → only that person's devices. STRICT
    // for scheduled reminders, widened to the device's last-used profile for
    // event pushes — see deviceMatches.
    let targets = [];
    if (!dup) {
      targets = tokenDocs
        .filter(d => deviceMatches(d, dash, evt))
        .map(d => d.fields.token.stringValue);
      if (!targets.length) console.log(`No matching devices for dash="${dash}"${evt ? ' (event push)' : ''}`);
    }

    // Fire the push(es) and the mark-fired write TOGETHER, so a task + event
    // set for the same minute go out simultaneously instead of staggered
    // behind the mark-fired network call.
    const jobs = [ markFired(r.document.name, accessToken) ];
    targets.forEach(token => jobs.push(
      sendFCM(projectId, token, title, id, accessToken, dash, evt ? 'event' : 'reminder')
        .catch(e => console.warn(`FCM failed ...${token.slice(-8)}:`, e.message))
    ));
    await Promise.allSettled(jobs);
  }));
}

async function maybeReschedule(fsDoc, baseUrl, authHdr) {
  // DISABLED. The client now pre-expands all future occurrences (~3-week
  // horizon, deterministic ids) and re-arms on every app open. Worker-side
  // rescheduling is redundant AND introduces a timezone bug: `cur.getDay()`
  // here is UTC, but the client stores `notifyRepeatDays` in LOCAL Mon-based
  // index. For a user in Mountain Time who picks Friday evening (e.g. 6pm MT
  // → 01:00 UTC Sat), this worker sees Saturday, walks forward looking for
  // Friday, lands on next Fri 01:00 UTC = Thursday evening MT → notification
  // fires ONE DAY EARLY. Returning early eliminates the bug entirely. The
  // pre-expanded occurrence docs the client writes carry `notifyRepeat:'none'`
  // anyway, so live data never reaches the buggy branch — this guard catches
  // any legacy 'daily'/'weekly' docs that still exist.
  return;
  /* eslint-disable no-unreachable */
  const f = fsDoc.fields || {};
  const notifyRepeat = f.notifyRepeat?.stringValue || 'none';
  if (notifyRepeat === 'none') return;

  const notifyAt   = f.notifyAt?.stringValue;
  const title      = f.title?.stringValue      || '';
  const id         = f.id?.stringValue         || '';
  const dashboard  = f.dashboard?.stringValue  || 'all';
  const repeatId   = f.notifyRepeatId?.stringValue || null;
  const repeatDays = (f.notifyRepeatDays?.arrayValue?.values || [])
                       .map(v => parseInt(v.integerValue ?? v.stringValue ?? '0'));

  if (!notifyAt || !repeatId) return;

  const cur = new Date(notifyAt);
  let next  = null;

  if (notifyRepeat === 'daily') {
    next = new Date(cur); next.setDate(next.getDate() + 1);
  } else if (notifyRepeat === 'weekly' && repeatDays.length) {
    const toMonIdx = d => (d === 0 ? 6 : d - 1);
    for (let i = 1; i <= 7; i++) {
      const c = new Date(cur); c.setDate(cur.getDate() + i);
      if (repeatDays.includes(toMonIdx(c.getDay()))) { next = c; break; }
    }
  }

  if (!next) return;

  // Use the SAME deterministic id scheme as the client's pre-expansion
  // ('<series>_<ms>') so that if both the client and this worker schedule the
  // same future occurrence, they write the SAME doc id and overwrite each
  // other instead of creating two docs that would fire twice. (The old
  // '<id>_r<ts>' scheme diverged from the client and produced duplicates.)
  next.setSeconds(0, 0); // align to the minute so ids match the client's
  const series = repeatId || id.replace(/_r?\d{10,}$/, '') || id;
  const nextId = series + '_' + next.getTime();
  await fetch(`${baseUrl}/reminders/${nextId}`, {
    method: 'PATCH', headers: authHdr,
    body: JSON.stringify({
      fields: {
        id:               { stringValue: nextId },
        title:            { stringValue: title },
        notifyAt:         { stringValue: next.toISOString() },
        dashboard:        { stringValue: dashboard },
        notifyRepeat:     { stringValue: notifyRepeat },
        notifyRepeatDays: { arrayValue: { values: repeatDays.map(d => ({ integerValue: String(d) })) } },
        notifyRepeatId:   { stringValue: repeatId },
        fired:            { booleanValue: false },
        createdAt:        { integerValue: String(Date.now()) }
      }
    })
  }).catch(e => console.warn('Reschedule write failed:', e.message));
}

async function sendFCM(projectId, token, title, id, accessToken, dash, kind) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        // DATA-ONLY (no `notification` payload). This guarantees the service
        // worker's onBackgroundMessage runs for EVERY message and draws it with
        // a unique tag, so multiple same-minute reminders can't be collapsed or
        // dropped by Android/Brave's auto-display path.
        // `kind` tells the receiving device which scope gate to apply: 'reminder'
        // (this device's MAIN profile only) or 'event' (also the profile open on
        // it right now). Missing, on a push from an older worker → 'reminder'.
        data: { id: String(id || ''), title: String(title || 'Task reminder'), body: String(title || 'Task reminder'), dash: String(dash || 'all'), kind: String(kind || 'reminder') },
        android: { priority: 'high' },
        // UNIQUE Topic per message → the push service can NEVER coalesce/replace
        // two reminders fired at the same instant to the same device (Android
        // Chrome's web-push path will otherwise drop the 2nd of a same-token
        // pair when the device is locked). 32 url-safe chars, FCM Topic-legal.
        webpush: { headers: { Urgency: 'high', TTL: '600', Topic: crypto.randomUUID().replace(/-/g, '') } }
      }
    })
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || res.status);
}

async function markFired(docName, accessToken) {
  const fields = { fired: { booleanValue: true }, firedAt: { integerValue: String(Date.now()) } };
  const mask   = 'updateMask.fieldPaths=fired&updateMask.fieldPaths=firedAt';
  await fetch(`https://firestore.googleapis.com/v1/${docName}?${mask}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  }).catch(e => console.warn('markFired failed:', e.message));
}

async function cleanupFiredReminders(baseUrl, authHdr) {
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const res = await fetch(`${baseUrl}:runQuery`, {
      method: 'POST', headers: authHdr,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'reminders' }],
          where: { fieldFilter: { field: { fieldPath: 'fired' }, op: 'EQUAL', value: { booleanValue: true } } },
          limit: 50
        }
      })
    });
    if (!res.ok) return;
    const docs = await res.json();
    if (!Array.isArray(docs)) return;
    await Promise.allSettled(
      docs.filter(r => r.document).map(r =>
        fetch(`https://firestore.googleapis.com/v1/${r.document.name}`, {
          method: 'DELETE', headers: authHdr
        }).catch(() => {})
      )
    );
    console.log(`[cleanup] deleted ${docs.filter(r => r.document).length} old fired reminders`);
  } catch(e) {
    console.warn('[cleanup] failed:', e.message);
  }
}

let _memToken = null;

async function getGoogleAccessToken(env) {
  const nowSec = Math.floor(Date.now() / 1000);

  if (_memToken && _memToken.expiresAt > nowSec + 300) return _memToken.token;

  if (env.TOKEN_CACHE) {
    try {
      const kv = await env.TOKEN_CACHE.get('gat', 'json');
      if (kv && kv.expiresAt > nowSec + 300) { _memToken = kv; return kv.token; }
    } catch (e) { console.warn('KV read error:', e.message); }
  }

  const now    = nowSec;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim  = b64url(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL, sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore'
  }));
  const payload  = `${header}.${claim}`;
  // Robust PEM parsing. The stored secret can arrive in several broken shapes:
  //   • real newlines (correct)             • literal "\n" two-char sequences
  //   • base64url chars (-/_) instead of +/   • stray wrapping quotes
  // Normalize ALL of these before atob() so a slightly-mangled secret still works.
  let raw = (env.FIREBASE_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')          // literal backslash-n → real newline
    .replace(/\\r/g, '')            // literal backslash-r → drop
    .replace(/^['"]|['"]$/g, '');   // strip wrapping quotes if present
  const pemBody  = raw
    .replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+').replace(/_/g, '/')  // base64url → standard base64
    .trim();
  if (!pemBody || pemBody.length < 100){
    throw new Error('FIREBASE_PRIVATE_KEY empty/too short after parsing — re-upload the secret');
  }
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key      = await crypto.subtle.importKey('pkcs8', keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig      = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(payload));
  const jwt      = `${payload}.${b64url(sig)}`;
  const res      = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const j = await res.json();

  const entry = { token: j.access_token, expiresAt: now + 3600 };
  _memToken   = entry;
  if (env.TOKEN_CACHE) {
    try { await env.TOKEN_CACHE.put('gat', JSON.stringify(entry), { expirationTtl: 3300 }); }
    catch (e) { console.warn('KV write error:', e.message); }
  }
  return entry.token;
}

function b64url(data) {
  const b = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = ''; b.forEach(x => s += String.fromCharCode(x));
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
