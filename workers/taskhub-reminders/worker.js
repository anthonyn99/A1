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

    if (path.startsWith('/auth/')) {
      try {
        return await handleAuth(path, request, env, origin);
      } catch (e) {
        return json({ ok: false, error: e.message || 'server error' }, origin, 500);
      }
    }

    return new Response('TaskHub worker OK', { status: 200, headers: corsHeaders(origin) });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
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

  // Same window the cron uses (non-sweep)
  const startAtIso = new Date(now - 90 * 1000).toISOString();
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

  // Tokens
  const tRes = await fetch(`${baseUrl}/fcm_tokens`, { headers: authHdr });
  out.tokensStatus = tRes.status;
  if (!tRes.ok) { out.ok = false; out.tokensError = (await tRes.text()).slice(0, 500); return json(out, origin); }
  const tData = await tRes.json();
  const seen = new Set();
  const tokenDocs = (tData.documents || []).filter(d => {
    const t = d.fields?.token?.stringValue;
    if (!t || seen.has(t)) return false; seen.add(t); return true;
  });
  out.uniqueTokens = tokenDocs.length;
  out.tokens = tokenDocs.map(d => ({
    id: (d.name||'').split('/').pop()?.slice(-10),
    dash: d.fields?.mainDash?.stringValue || 'all',
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
    const matching = tokenDocs.filter(d => {
      const md = d.fields?.mainDash?.stringValue || 'all';
      return dash === 'all' || md === dash;
    }).length;
    return {
      id: f.id?.stringValue,
      dash,
      fired: f.fired?.booleanValue === true,
      wouldNotify: matching,
      problem: matching === 0 ? `NO DEVICE has mainDash="${dash}" — this reminder can never fire` : null
    };
  });

  // Optional: force a push right now to confirm FCM delivery end-to-end.
  if (url.searchParams.get('send') === '1') {
    const wantDash = url.searchParams.get('dash') || 'all';
    const targets = tokenDocs.filter(d => {
      const md = d.fields?.mainDash?.stringValue || 'all';
      return wantDash === 'all' || md === wantDash;
    });
    out.forcedTo = targets.length;
    const sendResults = [];
    for (const d of targets) {
      const token = d.fields.token.stringValue;
      try {
        await sendFCM(projectId, token, 'WORKER TEST ✓ ' + new Date().toLocaleTimeString(), 'workertest_' + Date.now(), accessToken, 'all');
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

async function handleAuth(path, request, env, origin) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, origin, 405);
  if (!env.TOKEN_CACHE) return json({ ok: false, error: 'KV not bound' }, origin, 500);

  let body = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, origin, 400); }

  if (path === '/auth/journal/set-lock') {
    const { journal, entryId, password, hint } = body;
    if (!journal || !entryId || !password) return json({ ok: false, error: 'missing fields' }, origin, 400);
    const rec = await makeHash(password);
    rec.hint = typeof hint === 'string' ? hint : '';
    await env.TOKEN_CACHE.put(jKey(journal, entryId), JSON.stringify(rec));
    return json({ ok: true }, origin);
  }

  if (path === '/auth/journal/verify') {
    const { journal, entryId, password } = body;
    if (!journal || !entryId || !password) return json({ ok: false }, origin);
    const rec = await getJSON(env, jKey(journal, entryId));
    if (!rec) return json({ ok: false, noLock: true }, origin);
    return json({ ok: await verifyHash(password, rec) }, origin);
  }

  if (path === '/auth/journal/remove-lock') {
    const { journal, entryId, password } = body;
    if (!journal || !entryId || !password) return json({ ok: false }, origin);
    const rec = await getJSON(env, jKey(journal, entryId));
    if (!rec) return json({ ok: true }, origin);
    if (!(await verifyHash(password, rec))) return json({ ok: false }, origin);
    await env.TOKEN_CACHE.delete(jKey(journal, entryId));
    return json({ ok: true }, origin);
  }

  if (path === '/auth/journal/update-hint') {
    const { journal, entryId, password, hint } = body;
    if (!journal || !entryId || !password) return json({ ok: false }, origin);
    const rec = await getJSON(env, jKey(journal, entryId));
    if (!rec || !(await verifyHash(password, rec))) return json({ ok: false }, origin);
    rec.hint = typeof hint === 'string' ? hint : '';
    await env.TOKEN_CACHE.put(jKey(journal, entryId), JSON.stringify(rec));
    return json({ ok: true }, origin);
  }

  if (path === '/auth/journal/hint') {
    const { journal, entryId } = body;
    if (!journal || !entryId) return json({ noLock: true }, origin);
    const rec = await getJSON(env, jKey(journal, entryId));
    if (!rec) return json({ noLock: true }, origin);
    return json({ ok: true, hint: rec.hint || '' }, origin);
  }

  if (path === '/auth/profile/verify') {
    const { profile, password } = body;
    if (!profile || !password) return json({ ok: false }, origin);
    const rec = await getJSON(env, pKey(profile));
    if (!rec) return json({ ok: false, noLock: true }, origin);
    return json({ ok: await verifyHash(password, rec) }, origin);
  }

  // Seed/reset a profile password. Gated by AUTH_SETUP_KEY (call via curl).
  if (path === '/auth/profile/setup') {
    const { profile, password, key } = body;
    if (!env.AUTH_SETUP_KEY || key !== env.AUTH_SETUP_KEY) return json({ ok: false, error: 'unauthorized' }, origin, 401);
    if (!profile || !password) return json({ ok: false, error: 'missing fields' }, origin, 400);
    await env.TOKEN_CACHE.put(pKey(profile), JSON.stringify(await makeHash(password)));
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

// ══════════════════════════════════════════════════════════════════════════
//  REMINDERS CRON  (unchanged logic)
// ══════════════════════════════════════════════════════════════════════════

async function runReminders(env) {
  const now = Date.now();

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
  //   lower bound: now - 90s   (catches a tick we just missed / clock skew)
  //   upper bound: now + 10min  (anything sooner than the next few ticks)
  const startAtIso = new Date(now - 90 * 1000).toISOString();
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

  const due = [], stale = [];
  for (const r of results) {
    if (!r.document) continue;
    if (r.document.fields?.fired?.booleanValue === true) continue;
    const at = new Date(r.document.fields?.notifyAt?.stringValue).getTime();
    if (isNaN(at)) continue;
    if (at > tenMinFromNow) continue;
    if (at <= now + 5000 && at > now - 90000) due.push(r);
    else if (at <= now - 90000) stale.push(r);
  }

  if (!due.length && !stale.length) {
    if (new Date(now).getMinutes() === 0) {
      await cleanupFiredReminders(baseUrl, authHdr);
    }
    return;
  }

  const tokensRes = await fetch(`${baseUrl}/fcm_tokens`, { headers: authHdr });
  if (!tokensRes.ok) { console.error('FCM tokens fetch failed:', await tokensRes.text()); return; }
  const tokensData = await tokensRes.json();
  const seen = new Set();
  const tokenDocs = (tokensData.documents || []).filter(d => {
    const t = d.fields?.token?.stringValue;
    if (!t || seen.has(t)) return false;
    seen.add(t); return true;
  });

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

  const sentKeys = new Set();
  await Promise.allSettled(due.map(async (r) => {
    const fields = r.document.fields || {};
    const title  = fields.title?.stringValue || 'Task reminder';
    const id     = fields.id?.stringValue    || '';
    const dash   = fields.dashboard?.stringValue || 'all';
    const key    = occKeyFor(fields);

    // Claim the occurrence key BEFORE any await — Promise.allSettled runs these
    // concurrently, and an await before the add() would let two docs for the
    // same occurrence both see has()===false and both fire. Synchronous
    // check+add here makes the first doc the sole sender for that occurrence.
    const dup = sentKeys.has(key);
    if (!dup) sentKeys.add(key);

    await maybeReschedule(r.document, baseUrl, authHdr);

    // Scope: dashboard-tagged reminder → only devices whose main matches.
    let targets = [];
    if (!dup) {
      targets = tokenDocs
        .filter(d => {
          const md = d.fields?.mainDash?.stringValue || 'all';
          // STRICT scoping. A profile-tagged reminder (tony / veda / StudyOS=veda)
          // fires ONLY on devices whose main dashboard EQUALS that profile. The
          // old `md === 'all'` escape hatch let a device that never picked a main
          // receive everything — that's how a Tony reminder landed on Veda's
          // TaskHub. Only an explicitly 'all'-tagged reminder (test/diagnostic)
          // broadcasts. Each device MUST set its main ("Set as main" button).
          return dash === 'all' || md === dash;
        })
        .map(d => d.fields.token.stringValue);
      if (!targets.length) console.log(`No matching devices for dash="${dash}"`);
    }

    // Fire the push(es) and the mark-fired write TOGETHER, so a task + event
    // set for the same minute go out simultaneously instead of staggered
    // behind the mark-fired network call.
    const jobs = [ markFired(r.document.name, accessToken) ];
    targets.forEach(token => jobs.push(
      sendFCM(projectId, token, title, id, accessToken, dash)
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

async function sendFCM(projectId, token, title, id, accessToken, dash) {
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
        data: { id: String(id || ''), title: String(title || 'Task reminder'), body: String(title || 'Task reminder'), dash: String(dash || 'all') },
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
