/**
 * OneInbox Worker — Gmail multi-account backend + Gemini email parser
 * ============================================================================
 *
 * OneInbox is a standalone A1 Suite app (oneinbox.html, at the A1 root beside
 * index.html / insight.html / vault.html). This worker is
 * the ONLY place that ever holds a Gmail refresh token or an API key: the front
 * end talks exclusively to these endpoints, authorized by an app-lock session
 * token. Nothing sensitive is ever shipped to the browser.
 *
 * ── Trust model ─────────────────────────────────────────────────────────────
 *   • Gmail refresh tokens          → KV only (oi:acct:<email>). Never Firestore,
 *                                     never the client, never a log line.
 *   • Gemini / OAuth client secret  → Cloudflare secrets. Never leave the worker.
 *   • Every /gmail/* and /ai/* call → requires a valid app-lock session token,
 *                                     the same PBKDF2 lock index.html and
 *                                     insight.html use. No token, no mailbox.
 *   • /pubsub/push                  → guarded by a shared PUBSUB_TOKEN in the
 *                                     query string (Google signs nothing we can
 *                                     cheaply verify at the edge).
 *
 * ── AI chain (empirically chosen, not guessed) ──────────────────────────────
 * Benchmarked on 18 real-shaped emails (coupon / package / bill / subscription /
 * travel / appointment / traps) scored on exact field extraction:
 *
 *   gemini-3.5-flash-lite   96-97%   p50  660ms   ← best accuracy AND fastest
 *   gemini-3.1-flash-lite   96-97%   p50 1090ms
 *   gemini-3.6-flash        79%      p50 1340ms, p90 14.9s, early 429s
 *   gemini-2.5-flash        72%      quota-limited
 *   gemini-2.5-flash-lite   404 on this key      → excluded
 *   gemini-2.0-flash        429 always           → excluded
 *
 * Two findings shaped the design, both counter to the obvious plan:
 *   1. Escalating hard emails to a BIGGER model made results WORSE, not better.
 *      There is therefore no "Pro tier" in this chain — the order below is by
 *      measured accuracy, and later entries exist purely for extra free-tier
 *      capacity (quota is per-model, so each one is a fresh daily pool).
 *   2. A wide 20-property response schema silently destroyed extraction —
 *      every model dropped amount/dueDate/startDate at 68-72%. Collapsing to
 *      ONE shared `date`/`merchant`/`amount` vocabulary (PARSE_SCHEMA) took the
 *      same models to 97% with no other change. Keep the schema narrow.
 * Also measured: thinkingLevel:'high' makes 3.x emit unparseable JSON. Stay low.
 *
 * When every cloud model is exhausted, localParse() (regex + carrier patterns)
 * still returns a usable record, so ingestion never hard-fails.
 *
 * ── Endpoints ───────────────────────────────────────────────────────────────
 *   GET  /                    health (no secrets)
 *   POST /lock/session        password → device token   |  /lock/check  /lock/end
 *   GET  /oauth/start         → Google consent URL      |  GET /oauth/callback
 *   POST /accounts            list connected accounts (no tokens)
 *   POST /accounts/update     signature / display name
 *   POST /accounts/disconnect revoke + forget an account
 *   POST /gmail/list          threads/messages for a label or search
 *   POST /gmail/message       one message, decoded (html+text+attachments meta)
 *   POST /gmail/attachment    one attachment's bytes (base64)
 *   POST /gmail/send          send (or schedule) from ANY connected account
 *   POST /gmail/modify        star / archive / trash / read / label
 *   POST /gmail/draft         create or update a draft
 *   POST /gmail/labels        label list for an account
 *   POST /ai/parse            classify arbitrary text (used by the UI + ingest)
 *   POST /ai/reply            draft a reply in the user's voice
 *   POST /gmail/watch         (re)register Gmail push for every account
 *   POST /pubsub/push?token=  Gmail → Pub/Sub → here. Real-time ingestion.
 *   POST /cron                driven by taskhub-reminders' every-minute cron
 *
 * ── Firestore layout (project task-dashboard-d2b53) ─────────────────────────
 *   dashboards/oneinbox                  meta: accounts, settings, lastSync
 *   dashboards/oneinbox/emails/{id}      metadata + AI classification
 *   dashboards/oneinbox/cards/{id}       TaskHub-bound cards (coupons/packages)
 * Subcollections, NOT one fat doc — the suite's dashboards are single documents
 * capped at Firestore's 1 MiB limit, and a mailbox would blow through that.
 * index.html reads dashboards/oneinbox/cards to paint TaskHub; it never writes.
 */

const ALLOWED_ORIGIN = 'https://anthonyn99.github.io';

// ════════════════════════════════════════════════════════════════════════════
// HTTP helpers
// ════════════════════════════════════════════════════════════════════════════

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

// CPU NOTE: this used to append one character at a time. That is fine for a JWT
// header but ruinous for anything large — a 1 MB payload costs ~100 ms of CPU,
// and the Workers free plan allows 10 ms per invocation, so the isolate is
// killed mid-request. A killed isolate answers with Cloudflare's own error page,
// which carries no CORS headers, so the browser surfaces it as a bare
// "Failed to fetch" with nothing to read. Chunked fromCharCode is ~10x cheaper;
// bulk payloads (attachments) avoid this path entirely — see gapiUpload.
const b64url = (input) => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = '';
  const CHUNK = 0x8000;                    // apply() args are stack-allocated
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// Gmail hands back base64url with no padding and (in raw bodies) stray newlines.
function b64urlDecode(str) {
  if (!str) return '';
  const norm = str.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);   // UTF-8 aware, not latin-1
  } catch { return ''; }
}

// ════════════════════════════════════════════════════════════════════════════
// APP LOCK — the same PBKDF2 record every other A1 app uses
//
// The record itself is created/changed through taskhub-reminders'
// /auth/journal/* endpoints (journal 'applock', entry 'tony_oneinbox'); this
// worker only READS it, then mints a device token so a refresh doesn't ask for
// the password again. Each token is stamped with the password's fingerprint, so
// changing or resetting the password instantly invalidates every device.
// ════════════════════════════════════════════════════════════════════════════

const LOCK_KEY = 'jlock:applock:tony_oneinbox';

const b64ToBytes = (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0));

async function verifyLock(env, password) {
  if (!password || !env.OI_KV) return false;
  let rec;
  try { rec = await env.OI_KV.get(LOCK_KEY, 'json'); } catch { return false; }
  if (!rec || !rec.hash || !rec.salt) return false;
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64ToBytes(rec.salt), iterations: rec.iter || 100000, hash: 'SHA-256' }, km, 256);
  const got = new Uint8Array(bits), want = b64ToBytes(rec.hash);
  if (got.length !== want.length) return false;
  // Constant-time compare — never bail early on the first differing byte.
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

async function lockVersion(env) {
  try {
    const rec = await env.OI_KV.get(LOCK_KEY, 'json');
    if (!rec || !rec.hash || !rec.salt) return null;
    return rec.salt + ':' + rec.hash.slice(0, 24);
  } catch { return null; }
}

async function tokenValid(env, token) {
  if (!token) return false;
  const rec = await env.OI_KV.get('oi:locktok:' + token, 'json');
  if (!rec || !rec.v) return false;
  const cur = await lockVersion(env);
  return !!cur && rec.v === cur;
}

// Every mailbox route funnels through this. A request without a live session
// token never reaches Gmail.
async function requireSession(env, body, origin) {
  if (await tokenValid(env, body && body.token)) return null;
  return json({ ok: false, error: 'locked' }, origin, 401);
}

async function handleLock(path, request, env, origin) {
  const body = await request.json().catch(() => ({}));

  if (path === '/lock/session') {
    if (!(await verifyLock(env, body.password))) return json({ ok: false }, origin, 401);
    const v = await lockVersion(env);
    const token = b64url(crypto.getRandomValues(new Uint8Array(24)));
    await env.OI_KV.put('oi:locktok:' + token, JSON.stringify({ v, at: Date.now() }));
    return json({ ok: true, token }, origin);
  }
  if (path === '/lock/check') return json({ ok: await tokenValid(env, body.token) }, origin);
  if (path === '/lock/end') {
    if (body.token) await env.OI_KV.delete('oi:locktok:' + body.token).catch(() => {});
    return json({ ok: true }, origin);
  }
  return json({ ok: false, error: 'unknown lock route' }, origin, 404);
}

// ════════════════════════════════════════════════════════════════════════════
// GOOGLE OAUTH — connecting Gmail accounts
//
// Scopes are the narrowest set that still supports read + send + label edits.
// gmail.modify covers read/label/archive/trash; gmail.send covers sending;
// gmail.compose covers drafts. We deliberately do NOT request full `gmail`
// scope (which grants permanent-delete and settings access we never use).
// ════════════════════════════════════════════════════════════════════════════

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid'
].join(' ');

const redirectUri = (env) => `${env.WORKER_ORIGIN}/oauth/callback`;

async function oauthStart(request, env, origin) {
  const url = new URL(request.url);
  // The session token is verified now and parked in KV against a one-time
  // nonce, so the callback (which arrives as a top-level browser navigation and
  // therefore can't carry a header) can still prove the flow was authorized.
  if (!(await tokenValid(env, url.searchParams.get('token')))) {
    return json({ ok: false, error: 'locked' }, origin, 401);
  }
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
  await env.OI_KV.put('oi:state:' + nonce, JSON.stringify({ at: Date.now() }), { expirationTtl: 600 });

  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: OAUTH_SCOPES,
    // offline + consent is what actually yields a refresh_token. Without
    // prompt=consent Google returns one only on the very first authorization,
    // so re-adding an account later would silently produce a dead entry.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: nonce
  });
  return json({ ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString() }, origin);
}

// Small self-closing page so the popup disappears and the opener refreshes.
function oauthDone(env, ok, msg) {
  const html = `<!doctype html><meta charset="utf-8"><title>OneInbox</title>
<body style="background:#1a1a1d;color:#f4f3f0;font:15px/1.5 system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
<div><div style="color:#e0b874;font-size:19px;font-weight:700;margin-bottom:8px">${ok ? 'Account connected' : 'Could not connect'}</div>
<div style="opacity:.75">${msg || ''}</div></div>
<script>try{window.opener&&window.opener.postMessage({oneinbox:'oauth',ok:${ok ? 'true' : 'false'}},'${ALLOWED_ORIGIN}');}catch(e){}setTimeout(function(){window.close();},${ok ? 900 : 4000});</script>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function oauthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (url.searchParams.get('error')) return oauthDone(env, false, 'Google returned: ' + url.searchParams.get('error'));
  if (!code || !state) return oauthDone(env, false, 'Missing authorization code.');

  const st = await env.OI_KV.get('oi:state:' + state, 'json');
  if (!st) return oauthDone(env, false, 'This link expired — start again from OneInbox.');
  await env.OI_KV.delete('oi:state:' + state).catch(() => {});

  const tok = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID || '',
      client_secret: env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: redirectUri(env),
      grant_type: 'authorization_code'
    })
  }).then(r => r.json()).catch(() => null);

  if (!tok || !tok.access_token) {
    return oauthDone(env, false, 'Token exchange failed' + (tok && tok.error ? ': ' + tok.error : '') + '.');
  }
  if (!tok.refresh_token) {
    return oauthDone(env, false, 'Google did not return a refresh token. Remove OneInbox at myaccount.google.com/permissions, then connect again.');
  }

  const prof = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + tok.access_token }
  }).then(r => r.json()).catch(() => ({}));
  const email = (prof.email || '').toLowerCase();
  if (!email) return oauthDone(env, false, 'Could not read the account address.');

  const existing = (await env.OI_KV.get('oi:acct:' + email, 'json')) || {};
  await env.OI_KV.put('oi:acct:' + email, JSON.stringify({
    ...existing,
    email,
    refresh_token: tok.refresh_token,
    name: existing.name || prof.name || email.split('@')[0],
    signature: existing.signature || '',
    addedAt: existing.addedAt || Date.now()
  }));
  await addAccountIndex(env, email);

  // Start real-time push for the new account straight away; a failure here is
  // not fatal (the /cron poll is the safety net), so it never blocks the connect.
  try { await startWatch(env, email); } catch (e) { console.warn('watch on connect failed:', e.message); }

  return oauthDone(env, true, email);
}

// ── Account index ───────────────────────────────────────────────────────────
// A KV list costs one of the free plan's 1,000 daily LIST operations, and the
// UI asks for accounts on every load. A single index key makes that one read.

async function getAccountIndex(env) {
  return (await env.OI_KV.get('oi:accts', 'json')) || [];
}
async function addAccountIndex(env, email) {
  const list = await getAccountIndex(env);
  if (!list.includes(email)) await env.OI_KV.put('oi:accts', JSON.stringify([...list, email]));
}
async function removeAccountIndex(env, email) {
  const list = await getAccountIndex(env);
  await env.OI_KV.put('oi:accts', JSON.stringify(list.filter(e => e !== email)));
}
async function getAccount(env, email) {
  if (!email) return null;
  return env.OI_KV.get('oi:acct:' + String(email).toLowerCase(), 'json');
}
async function saveAccount(env, acct) {
  await env.OI_KV.put('oi:acct:' + acct.email, JSON.stringify(acct));
}
// The client only ever sees this shape — no refresh_token, ever.
const publicAccount = (a) => ({
  email: a.email, name: a.name || a.email.split('@')[0], signature: a.signature || '',
  addedAt: a.addedAt || 0, watchExpiry: a.watchExpiry || 0, unread: a.unread || 0
});

// ════════════════════════════════════════════════════════════════════════════
// GMAIL ACCESS TOKENS
// Access tokens live ~1h. Cache them in KV (keyed per account) so a burst of UI
// requests costs one refresh, not one per call.
// ════════════════════════════════════════════════════════════════════════════

const _memTok = new Map();   // per-isolate cache in front of KV

async function gmailToken(env, email) {
  const nowSec = Math.floor(Date.now() / 1000);
  const mem = _memTok.get(email);
  if (mem && mem.exp > nowSec + 120) return mem.token;

  const cached = await env.OI_KV.get('oi:tok:' + email, 'json');
  if (cached && cached.exp > nowSec + 120) { _memTok.set(email, cached); return cached.token; }

  const acct = await getAccount(env, email);
  if (!acct || !acct.refresh_token) throw new Error('account not connected: ' + email);

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID || '',
      client_secret: env.GOOGLE_CLIENT_SECRET || '',
      refresh_token: acct.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) {
    // invalid_grant = Google will not honour the refresh token any more: access
    // was revoked, the password changed, or — the one that bites here — the
    // OAuth consent screen fell back to "Testing", where refresh tokens expire
    // after 7 days. Whatever the cause, the only cure is reconnecting the
    // account, so say that instead of leaving a bare error code for the user
    // to interpret.
    if (d.error === 'invalid_grant') {
      const e = new Error(`Gmail access for ${email} has expired or been revoked — reconnect it in Settings.`);
      e.reconnect = email;
      throw e;
    }
    throw new Error(`gmail token ${email}: ${d.error || 'refresh failed'}`);
  }
  const rec = { token: d.access_token, exp: nowSec + (d.expires_in || 3600) };
  _memTok.set(email, rec);
  await env.OI_KV.put('oi:tok:' + email, JSON.stringify(rec), { expirationTtl: Math.max(120, (d.expires_in || 3600) - 60) });
  return rec.token;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Bounded-concurrency map. Gmail enforces 250 quota units per USER per SECOND,
// and messages.get costs 5 — so a Promise.all over a 40-message page fires 200
// units at once, and the unified inbox does that for every account in parallel.
// Refreshing with several mailboxes connected would burst well past the limit
// and come back as rateLimitExceeded. Six at a time stays comfortably inside it
// while still being far faster than serial.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

async function gapi(env, email, path, init = {}) {
  const token = await gmailToken(env, email);
  const r = await fetch(GMAIL + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  if (r.status === 204) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = d?.error?.message || r.status;
    throw new Error(`gmail ${path} ${r.status}: ${String(msg).slice(0, 200)}`);
  }
  return d;
}

const GMAIL_UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

// Anything with an attachment goes out through Gmail's media-upload URI instead
// of the plain JSON endpoint, because the JSON endpoint wants the whole message
// base64'd into a `raw` field. Encoding megabytes of MIME inside the Worker
// blew the CPU budget and killed the isolate — the symptom was "Failed to fetch"
// in the browser, since a killed isolate's error page has no CORS headers.
// Here the MIME bytes ARE the request body: no second base64 pass at all, and
// Gmail's ceiling rises from ~5 MB to 35 MB.
//
// uploadType=multipart (rather than the simpler =media) so the metadata part can
// still carry threadId — without it a reply with an attachment would start its
// own thread.
async function gapiUpload(env, email, path, rawMime, meta = {}, method = 'POST') {
  const token = await gmailToken(env, email);
  const bd = 'up_' + crypto.randomUUID();
  const body =
    `--${bd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${bd}\r\nContent-Type: message/rfc822\r\n\r\n${rawMime}\r\n` +
    `--${bd}--\r\n`;
  // Blob, not the bare string: a Blob has a known byte length, so the request
  // goes out with Content-Length instead of chunked transfer-encoding. Google's
  // upload endpoints are strict about that, and a chunked upload can sit there
  // until the edge times out — which reaches the browser as a bare network
  // error, not as something the UI can report.
  const r = await fetch(`${GMAIL_UPLOAD}${path}?uploadType=multipart`, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${bd}` },
    body: new Blob([body])
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = d?.error?.message || r.status;
    throw new Error(`gmail upload ${path} ${r.status}: ${String(msg).slice(0, 200)}`);
  }
  return d;
}

// ════════════════════════════════════════════════════════════════════════════
// MIME decoding — Gmail payload → { text, html, attachments }
// ════════════════════════════════════════════════════════════════════════════

function headerMap(headers) {
  const h = {};
  for (const { name, value } of headers || []) h[name.toLowerCase()] = value;
  return h;
}

function walkParts(part, out) {
  if (!part) return out;
  const mime = part.mimeType || '';
  const filename = part.filename || '';
  const body = part.body || {};

  if (filename && body.attachmentId) {
    out.attachments.push({
      filename,
      mimeType: mime,
      size: body.size || 0,
      attachmentId: body.attachmentId,
      // Inline images are referenced by cid: in the HTML; flagging them lets the
      // UI hide them from the attachment strip instead of showing phantom files.
      inline: /inline/i.test(headerMap(part.headers)['content-disposition'] || ''),
      contentId: (headerMap(part.headers)['content-id'] || '').replace(/^<|>$/g, '')
    });
  } else if (mime === 'text/html' && body.data) {
    out.html += b64urlDecode(body.data);
  } else if (mime === 'text/plain' && body.data) {
    out.text += b64urlDecode(body.data);
  }
  for (const p of part.parts || []) walkParts(p, out);
  return out;
}

function decodeMessage(msg) {
  const h = headerMap(msg.payload?.headers);
  const parts = walkParts(msg.payload, { text: '', html: '', attachments: [] });
  return {
    id: msg.id,
    threadId: msg.threadId,
    historyId: msg.historyId,
    labelIds: msg.labelIds || [],
    snippet: msg.snippet || '',
    internalDate: Number(msg.internalDate || 0),
    subject: h.subject || '(no subject)',
    from: h.from || '',
    to: h.to || '',
    cc: h.cc || '',
    bcc: h.bcc || '',
    replyTo: h['reply-to'] || '',
    messageId: h['message-id'] || '',
    references: h.references || '',
    listUnsubscribe: h['list-unsubscribe'] || '',
    date: h.date || '',
    ...parts
  };
}

const parseAddr = (s) => {
  const m = /<([^>]+)>/.exec(s || '');
  const email = (m ? m[1] : (s || '')).trim().toLowerCase();
  const name = (s || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  return { email, name: name || email };
};

// Plain text for the AI: the model does better on prose than on markup, and it
// keeps the token bill down. Strip scripts/styles first so CSS never leaks in.
function textForAI(m) {
  let body = m.text;
  if (!body || body.trim().length < 40) {
    body = (m.html || '')
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
  }
  return [
    `From: ${m.from}`,
    `Subject: ${m.subject}`,
    `Received: ${new Date(m.internalDate || Date.now()).toISOString().slice(0, 10)}`,
    '',
    body.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  ].join('\n').slice(0, 6000);   // ~1.5k tokens — plenty; promos pad endlessly
}

// ════════════════════════════════════════════════════════════════════════════
// GEMINI PARSER
// ════════════════════════════════════════════════════════════════════════════

// Ordered by MEASURED accuracy, then by remaining free-tier capacity. See the
// header note: this is deliberately not a "small → big" escalation, because
// escalating measurably hurt. Every entry is a separate daily quota pool, so
// walking the chain multiplies effective capacity.
// SHARED-KEY ORDERING. This key is the same one personal-ai uses for MyList
// voice, TaskHub voice, Journal AI Format and recipes, and Gemini's free-tier
// quota is per-key-per-model. So the order is chosen to keep OneInbox's bulk,
// background email volume OFF the models those interactive features depend on.
//
//   personal-ai uses : 3.1-flash-lite (PRIMARY for MyList + TaskHub voice +
//                      recipe edits), 3.5-flash, 2.5-flash, 2.5-flash-lite,
//                      2.0-flash
//   OneInbox only    : 3.5-flash-lite, 3.6-flash   ← its own private capacity
//
// Email classification is background work where a slightly weaker parse is
// invisible; a failed voice command is not. So OneInbox burns both of its
// EXCLUSIVE pools first, and 3.1-flash-lite — the voice primary — is the very
// last cloud model it will touch, after which it degrades to the local parser
// rather than competing further.
// (2.5-flash was dropped entirely: shared, it leads personal-ai's recipe
// dictation, and it 429'd early in benchmarking anyway.)
const PARSE_MODELS = [
  'gemini-3.5-flash-lite',  // EXCLUSIVE. 96-97%, p50 660ms — best AND fastest
  'gemini-3.6-flash',       // EXCLUSIVE. flagship; slower here but real capacity
  'gemini-3.5-flash',       // shared, but only the Journal lead — low volume
  'gemini-3.1-flash-lite'   // shared VOICE PRIMARY — last resort only
];

// Reply drafting is prose, not extraction — quality over latency, and the
// flagship writes noticeably better replies than the lite models. Leads with
// OneInbox's two exclusive models for the same shared-key reason as above;
// this is user-initiated and rare, so volume here is negligible either way.
const REPLY_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'];

// NARROW ON PURPOSE. A wider schema (one field per category: expiration,
// deliveryDate, dueDate, renewalDate, startDate…) benchmarked at 68-72% because
// models dropped fields; collapsing to a single shared `date`/`merchant`/
// `amount` vocabulary took the identical models to 97%. Do not widen this
// without re-running the benchmark.
const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    category:    { type: 'string', enum: ['coupon', 'package', 'bill', 'subscription', 'travel', 'appointment', 'important', 'general'] },
    confidence:  { type: 'number' },
    summary:     { type: 'string' },
    merchant:    { type: 'string' },
    date:        { type: 'string' },
    amount:      { type: 'string' },
    code:        { type: 'string' },
    carrier:     { type: 'string' },
    tracking:    { type: 'string' },
    orderNumber: { type: 'string' },
    location:    { type: 'string' },
    note:        { type: 'string' },
    actionItems: { type: 'array', items: { type: 'string' } }
  },
  required: ['category', 'confidence', 'summary'],
  propertyOrdering: ['category', 'confidence', 'summary', 'merchant', 'date', 'amount', 'code', 'carrier', 'tracking', 'orderNumber', 'location', 'note', 'actionItems']
};

function parsePrompt(today) {
  return `You are OneInbox's email classifier. Today is ${today}.
Classify the email into ONE category and extract its facts into the SHARED fields below.

CATEGORY - pick the dominant intent:
 coupon        a promo code / discount / sale the user can act on
 package       a shipment or tracking notification
 bill          a bill or payment that is due
 subscription  a recurring charge, renewal, or price change
 travel        a flight / hotel / rental / reservation confirmation
 appointment   a scheduled appointment
 important     needs a human decision or reply, none of the above
 general       everything else (newsletters, marketing with no usable offer)

SHARED FIELDS - the same field names for every category:
 merchant     the company: store, retailer, biller, airline, provider.
 date         THE one actionable date, as YYYY-MM-DD:
                coupon -> when the offer expires
                package -> estimated delivery / arrival
                bill -> the due date
                subscription -> next renewal / when the new price starts
                travel -> departure or check-in
                appointment -> the appointment date
              Resolve relative wording ("tomorrow", "Tuesday", "next week") against today, ${today}.
 amount       money, with its symbol: "$184.32". For coupons use the DISCOUNT ("25% OFF", "$10 OFF", "BOGO").
 code         the literal string the user types or quotes: a coupon code, or a travel confirmation number.
              OMIT it when the offer needs no code - never invent one.
 carrier      package only: USPS, UPS, FedEx, DHL, Amazon, OnTrac, LaserShip, GLS, SpeedX, ...
 tracking     package only: the tracking number, copied EXACTLY.
 orderNumber  the order / account / reference number.
 location     travel or appointment: where.
 note         restrictions, exclusions, or the one caveat worth showing. Short.
 actionItems  only for "important": what the user must actually do.

RULES:
 - OMIT any field the email does not support. Never guess a code, tracking number, amount, or date.
 - MONEY ALREADY SETTLED -> "general". This rule is about BILLS AND SUBSCRIPTIONS ONLY:
   a receipt, a payment confirmation, an autopay notice, "thanks for your payment" or
   "nothing is due at this time" is "general", NOT "bill", and amount/date stay EMPTY.
 - IT DOES NOT APPLY TO SHIPMENTS. Every shipping notification is "package" at EVERY stage:
   ordered, shipped, in transit, out for delivery, delayed, and DELIVERED. The card follows
   the parcel through its whole life, so a "your order was delivered" email is still "package",
   never "general".
 - A PACKAGE ALWAYS GETS A DATE. Resolve the stage into one, against today (${today}):
     "out for delivery" / "arriving today" / "delivered" / "delivered today"  -> ${today}
     "arriving tomorrow"                                                      -> the next day
     a named weekday or explicit date                                         -> that date
   Only leave a package's date empty when the email genuinely says nothing about timing.
 - confidence is 0..1. Use a LOW confidence when the email is ambiguous or you had to guess.
 - summary: one sentence under 100 characters.

EMAIL:
`;
}

// 3.x uses thinkingLevel; 'high' made it emit unparseable JSON in testing, so it
// is pinned low. 2.5 uses a numeric budget where 0 = off.
function thinkingConfig(model) {
  if (model.startsWith('gemini-3')) return { thinkingLevel: 'low' };
  if (model.startsWith('gemini-2.5')) return { thinkingBudget: 0 };
  return undefined;
}

const GEMINI_TIMEOUT_MS = 20000;

async function callGemini(model, key, { prompt, schema, maxOutputTokens = 900 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const gc = { temperature: 0, maxOutputTokens };
  if (schema) { gc.responseMimeType = 'application/json'; gc.responseSchema = schema; }
  const tc = thinkingConfig(model);
  if (tc) gc.thinkingConfig = tc;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: gc });

  let quota = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), GEMINI_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ac.signal });
    } catch {
      await new Promise(res => setTimeout(res, 400 * (attempt + 1)));
      continue;
    } finally { clearTimeout(timer); }

    if (r.status === 429 || r.status >= 500) {
      // Quota or overload. One short retry, then let the caller move down the
      // chain to a model with its own separate daily pool.
      quota = quota || r.status === 429;
      await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
      continue;
    }
    if (r.status === 404) throw new Error('model-unavailable');  // skip immediately
    if (!r.ok) throw new Error(`gemini ${model} ${r.status}`);

    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) continue;
    if (!schema) return text;
    try { return JSON.parse(text); } catch { continue; }
  }
  if (quota) throw new Error('quota');
  return null;
}

async function runChain(models, key, opts) {
  if (!key) return { result: null, model: null, error: 'no-key' };
  let lastErr = null;
  for (const m of models) {
    try {
      const out = await callGemini(m, key, opts);
      if (out) return { result: out, model: m, error: null };
    } catch (e) { lastErr = e.message; }
  }
  return { result: null, model: null, error: lastErr || 'no-output' };
}

// ── Local rule-based parser — the final fallback ────────────────────────────
// Runs when every cloud model is exhausted or the key is missing, so ingestion
// degrades instead of failing. Deliberately conservative: it only claims a
// category when a strong signal is present, and never fabricates a value.

const CARRIERS = [
  { name: 'UPS',      re: /\b(1Z[0-9A-Z]{16})\b/i,                       host: /ups\.com/i },
  { name: 'FedEx',    re: /\b(\d{12}|\d{15}|\d{20}|\d{22})\b/,           host: /fedex\.com/i },
  { name: 'USPS',     re: /\b(9[234]\d{20}|9\d{21}|[A-Z]{2}\d{9}US)\b/i, host: /usps\.com/i },
  { name: 'DHL',      re: /\b(\d{10,11}|JVGL\d{11,})\b/,                 host: /dhl\.(com|de)/i },
  { name: 'Amazon',   re: /\b(TBA\d{10,12})\b/i,                         host: /amazon\.com/i },
  { name: 'OnTrac',   re: /\b([CD]\d{14})\b/i,                           host: /ontrac\.com/i },
  { name: 'LaserShip',re: /\b(1LS\w{9,})\b/i,                            host: /lasership\.com/i },
  { name: 'GLS',      re: /\b(\d{11})\b/,                                host: /gls-group\.(eu|com)/i },
  { name: 'SpeedX',   re: /\b(SPX\w{8,})\b/i,                            host: /speedxservice\.com/i }
];

// A shipment email states its delivery day in prose far more often than as a
// date: "Arriving tomorrow" is Amazon's standard phrasing and carries no digits
// at all. The AI resolves those, but it is not always the thing that ran — the
// daily quota can be spent, a model can fail, and the regex fallback then takes
// over. Without this, every such parcel fell back to "the day the email
// arrived", which for "arriving tomorrow" is reliably one day early: the card
// showed up on the wrong day, or looked like it never showed up at all.
//
// `ref` is the date to resolve against, and it must be the date the EMAIL was
// sent, never today — "arriving tomorrow" in Friday's mail means Saturday no
// matter when the ingest tick that reads it happens to run.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const asIso = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

function deliveryEta(text, ref) {
  const t = String(text || '');
  // UTC throughout: the ISO day is what the card is keyed by, and shifting into
  // local time can move a midnight-ish email onto the wrong day.
  const base = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  const plus = n => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + n); return asIso(d); };

  // An explicit date always wins over prose.
  const exact = /(?:arriv\w*|estimated delivery|expected|delivery date|scheduled for|now expected)\b[^\n]{0,40}?(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|[A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?)/i.exec(t);
  if (exact) { const d = isoDate(exact[1], base); if (d) return d; }

  if (/\barriv\w*\s+tomorrow\b|\bexpected\s+tomorrow\b|\btomorrow\b[^\n]{0,20}\bdeliver/i.test(t)) return plus(1);
  // "Out for delivery" and a delivery confirmation are both about today.
  if (/\barriv\w*\s+today\b|\bout for delivery\b|\bwas delivered\b|\bdelivered today\b|\byour package (?:has been|was) delivered\b/i.test(t)) return plus(0);

  // "Arriving Monday" / "Arriving Mon" — the next such weekday at or after the
  // email's own date. Same-day names mean today, not a week out.
  const wd = /\barriv\w*\s+(?:on\s+)?(sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?\b/i.exec(t);
  if (wd) {
    const want = WEEKDAYS.findIndex(d => d.startsWith(wd[1].toLowerCase().slice(0, 3)));
    if (want >= 0) return plus((want - base.getUTCDay() + 7) % 7);
  }
  return '';
}

// Public tracking pages, used for the card's "Track" button. Kept here (not in
// the front end) so carrier coverage is one edit in one place.
const TRACK_URL = {
  UPS: t => `https://www.ups.com/track?tracknum=${t}`,
  FedEx: t => `https://www.fedex.com/fedextrack/?trknbr=${t}`,
  USPS: t => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`,
  DHL: t => `https://www.dhl.com/en/express/tracking.html?AWB=${t}`,
  Amazon: t => `https://www.amazon.com/progress-tracker/package?trackingId=${t}`,
  OnTrac: t => `https://www.ontrac.com/tracking/?number=${t}`,
  LaserShip: t => `https://www.lasership.com/track/${t}`,
  GLS: t => `https://gls-group.eu/track/${t}`,
  SpeedX: t => `https://speedxservice.com/tracking?number=${t}`
};
const trackingUrl = (carrier, tracking) =>
  (tracking && TRACK_URL[carrier]) ? TRACK_URL[carrier](encodeURIComponent(tracking))
    : (tracking ? `https://www.google.com/search?q=${encodeURIComponent(tracking)}` : '');

function isoDate(str, today) {
  if (!str) return '';
  const s = String(str).trim();
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/.exec(s);
  if (m) {
    let y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?/.exec(s);
  if (m) {
    const mi = MON.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) {
      const y = m[3] || String((today || new Date()).getFullYear());
      return `${y}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    }
  }
  return '';
}

// `sentAt` is the date the email was SENT. Relative wording has to resolve
// against that, not against the moment the ingest tick happens to run — a
// message saying "arriving tomorrow" is about the day after it was sent, and
// ingestion can lag it by hours or (after an outage) days.
function localParse(text, fromEmail, sentAt) {
  const t = text || '';
  const today = sentAt instanceof Date && !isNaN(sentAt) ? sentAt : new Date();
  const host = (fromEmail || '').split('@')[1] || '';
  const out = { category: 'general', confidence: 0.3, summary: '', engine: 'local' };

  // Package — a matching carrier pattern is a strong, low-false-positive signal.
  for (const c of CARRIERS) {
    const byHost = c.host.test(host);
    const m = c.re.exec(t);
    if (m && (byHost || /track|shipment|shipped|delivery|package/i.test(t))) {
      out.category = 'package'; out.confidence = byHost ? 0.75 : 0.5;
      out.carrier = c.name; out.tracking = m[1];
      break;
    }
  }

  // A shipment notice does not need to quote a tracking number to be one, and
  // Amazon's routinely does not — it says "Your package was shipped!", shows a
  // Track package button, and keeps the number behind it. Requiring a tracking
  // regex meant those were filed as "general" and never became a card at all.
  // The sender host plus explicit shipment language is a safe pair: marketing
  // from the same host does not say "your package was shipped".
  if (out.category === 'general') {
    const shipperHost = /(amazon|shipment-tracking|ups|fedex|usps|dhl|ontrac|lasership|shopify|shipstation|narvar|aftership)\./i.test(host);
    const shipTalk = /\byour (?:package|order|shipment|parcel)\b[^\n]{0,40}\b(?:was|has been|is)\s+(?:shipped|sent|dispatched|delivered|on its way|out for delivery)\b|\bshipped:|\bout for delivery\b|\barriv\w+\s+(?:today|tomorrow|(?:on\s+)?(?:sun|mon|tues?|wed|thur?s?|fri|sat))/i.test(t);
    if (shipperHost && shipTalk) {
      out.category = 'package'; out.confidence = 0.65;
      if (/amazon/i.test(host)) out.carrier = 'Amazon';
      const ord = /\border\s*#\s*([\d-]{10,})/i.exec(t);
      if (ord) out.orderNumber = ord[1];
    }
  }

  if (out.category === 'package' && !out.date) out.date = deliveryEta(t, today);

  // Coupon — require an explicit code token, otherwise it's just marketing.
  if (out.category === 'general') {
    const code = /\b(?:code|promo code|coupon code|use code)\b[:\s]*["']?([A-Z0-9][A-Z0-9_-]{2,19})\b/i.exec(t);
    const disc = /\b(\d{1,2}%\s*off|\$\d{1,3}(?:\.\d{2})?\s*off|free shipping|bogo)\b/i.exec(t);
    if (code && disc) {
      out.category = 'coupon'; out.confidence = 0.6;
      out.code = code[1].toUpperCase(); out.amount = disc[1].toUpperCase();
      const exp = /\b(?:expires?|ends?|valid through|through)\b[^\n]{0,30}?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|[A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2})/i.exec(t);
      if (exp) out.date = isoDate(exp[1], today);
    }
  }

  // Bill — an amount due AND a due date. "Payment received" must not match.
  if (out.category === 'general' && !/thank you for your payment|payment (was )?received|nothing is due/i.test(t)) {
    const amt = /\b(?:amount due|total due|balance due|payment due)\b[^\n]{0,20}?(\$[\d,]+\.\d{2})/i.exec(t);
    const due = /\bdue (?:date|on|by)\b[^\n]{0,20}?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|[A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2})/i.exec(t);
    if (amt && due) {
      out.category = 'bill'; out.confidence = 0.6;
      out.amount = amt[1]; out.date = isoDate(due[1], today);
    }
  }

  const subj = /^Subject:\s*(.+)$/m.exec(t);
  out.summary = (subj ? subj[1] : (t.split('\n')[0] || '')).slice(0, 100);
  if (!out.merchant && host) out.merchant = host.replace(/^(mail|email|e|news|notices|no-?reply)\./i, '').split('.')[0];
  return out;
}

// ── Daily AI budget ─────────────────────────────────────────────────────────
// One Gemini call per NEW inbox message. Normally that tracks mail volume and
// is modest, but the ceiling is not: ingestion accepts 25 messages per account
// per sync, and with several accounts polled every 15 minutes a flooded or
// newly-connected mailbox could theoretically fire thousands of calls in a day
// and drain the key — which would also starve anything else sharing it.
//
// This caps spend at a predictable number and then degrades to the local
// parser instead of erroring, so ingestion always completes. The counter is
// one KV key holding { d: 'YYYY-MM-DD', n }, written only on days AI actually
// runs (KV writes are the scarce resource — see the runCron note).
const AI_BUDGET_KEY = 'oi:aiq';
const AI_DAILY_MAX = 1200;

// Held in the isolate and flushed ONCE per run, not once per account. A cron
// tick polls every account in a single invocation, so committing per account
// cost 5 x 96 = 480 KV writes/day — half the entire 1,000/day free budget, for
// a counter. Flushing per run makes it ~96. If an isolate dies mid-run the
// worst case is a slightly low count, which is fine: this is a safety cap, not
// an accounting ledger.
let _budget = null, _budgetDirty = false;

async function aiBudget(env) {
  const today = new Date().toISOString().slice(0, 10);
  if (_budget && _budget.d === today) return _budget;
  let rec = null;
  try { rec = await env.OI_KV.get(AI_BUDGET_KEY, 'json'); } catch {}
  if (!rec || rec.d !== today) rec = { d: today, n: 0 };
  _budget = rec;
  return _budget;
}
const aiBudgetSpend = () => { _budgetDirty = true; };
async function aiBudgetFlush(env) {
  if (!_budget || !_budgetDirty) return;
  _budgetDirty = false;
  try { await env.OI_KV.put(AI_BUDGET_KEY, JSON.stringify(_budget)); } catch {}
}

// One email in, one normalized record out. Cloud chain first, local parser last.
// `budget` (optional) lets a caller spend a shared per-run allowance.
async function classify(env, msg, budget) {
  // The email's OWN date anchors every relative phrase in it. Using the wall
  // clock instead put "arriving tomorrow" a day late whenever ingestion lagged
  // the message — which it routinely does, since the poll runs every 15 min and
  // an account that has been unreachable catches up in one burst.
  const sentAt = new Date(msg.internalDate || Date.now());
  const today = sentAt.toISOString().slice(0, 10);
  const text = textForAI(msg);

  const overBudget = budget && budget.n >= AI_DAILY_MAX;
  const { result, model, error } = overBudget
    ? { result: null, model: null, error: 'daily-budget' }
    : await runChain(PARSE_MODELS, env.ONEINBOX_GEMINI_KEY, {
        prompt: parsePrompt(today) + text, schema: PARSE_SCHEMA
      });
  if (budget && !overBudget) { budget.n++; aiBudgetSpend(); }

  const base = result && result.category
    ? { ...result, engine: model }
    : { ...localParse(text, parseAddr(msg.from).email, sentAt), engineError: error || null };

  // The model is told to emit YYYY-MM-DD but occasionally returns prose; and a
  // date already in the past is worse than no date (it would create an expired
  // card), so drop those rather than surfacing them.
  const d = isoDate(base.date, new Date());
  base.date = d && d >= new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10) ? d : '';
  if (base.carrier) {
    const known = CARRIERS.find(c => new RegExp(c.name, 'i').test(base.carrier));
    if (known) base.carrier = known.name;
  }
  if (!base.merchant) base.merchant = parseAddr(msg.from).name;
  return base;
}

// ════════════════════════════════════════════════════════════════════════════
// FIRESTORE (service account — identical pattern to taskhub-reminders)
// ════════════════════════════════════════════════════════════════════════════

let _gTok = null;

async function getGoogleAccessToken(env) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (_gTok && _gTok.expiresAt > nowSec + 300) return _gTok.token;
  try {
    const kv = await env.OI_KV.get('oi:gat', 'json');
    if (kv && kv.expiresAt > nowSec + 300) { _gTok = kv; return kv.token; }
  } catch { /* cache miss is fine */ }

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL, sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600,
    scope: 'https://www.googleapis.com/auth/datastore'
  }));
  const payload = `${header}.${claim}`;
  // Tolerate the slightly-mangled PEM forms secrets pick up in transit — the
  // same normalization taskhub-reminders and insight-api needed.
  const raw = (env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/^['"]|['"]$/g, '');
  const pem = raw.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').trim();
  if (!pem || pem.length < 100) throw new Error('FIREBASE_PRIVATE_KEY missing/short — re-upload the secret');
  const keyBytes = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyBytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(payload));
  const jwt = `${payload}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('service-account token failed: ' + JSON.stringify(d).slice(0, 200));
  _gTok = { token: d.access_token, expiresAt: nowSec + (d.expires_in || 3600) };
  await env.OI_KV.put('oi:gat', JSON.stringify(_gTok), { expirationTtl: 3300 }).catch(() => {});
  return _gTok.token;
}

const fsConfigured = (env) => !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
const fsRoot = (env) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

function fsVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsVal) } };
  return { mapValue: { fields: fsFields(v) } };
}
function fsFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = fsVal(v);
  return out;
}
function fsDecode(val) {
  if (!val || typeof val !== 'object') return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return val.doubleValue;
  if ('stringValue' in val) return val.stringValue;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(fsDecode);
  if ('mapValue' in val) {
    const o = {}, f = val.mapValue.fields || {};
    for (const k of Object.keys(f)) o[k] = fsDecode(f[k]);
    return o;
  }
  return null;
}

async function fsBatchWrite(env, token, writes) {
  if (!writes.length) return 0;
  const url = `https://firestore.googleapis.com/v1/${fsRoot(env).replace('/documents', '')}/documents:batchWrite`;
  let n = 0;
  for (let i = 0; i < writes.length; i += 500) {
    const chunk = writes.slice(i, i + 500);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: chunk })
    });
    if (!res.ok) throw new Error(`batchWrite ${res.status}: ${(await res.text()).slice(0, 200)}`);
    n += chunk.length;
  }
  return n;
}

async function fsList(env, token, collection, pageSize = 300) {
  const url = `https://firestore.googleapis.com/v1/${fsRoot(env)}/${collection}?pageSize=${pageSize}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.documents || []).map(doc => {
    const o = { _id: (doc.name || '').split('/').pop() };
    for (const [k, v] of Object.entries(doc.fields || {})) o[k] = fsDecode(v);
    return o;
  });
}

// Which of these doc ids already exist? Asked by NAME rather than by listing the
// collection: a list is capped at one page, so once the mailbox archive grew past
// that page the dedupe check would start missing hits and re-run the AI (and
// re-burn quota) on messages already ingested. batchGet is exact at any size.
async function fsExisting(env, token, collection, ids) {
  if (!ids.length) return new Set();
  const root = fsRoot(env);
  const url = `https://firestore.googleapis.com/v1/${root.replace('/documents', '')}/documents:batchGet`;
  const found = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documents: chunk.map(id => `${root}/${collection}/${id}`),
        mask: { fieldPaths: ['id'] }        // names only — don't pay to read bodies
      })
    });
    if (!r.ok) continue;                    // on failure, treat as "unknown" and re-ingest
    for (const row of await r.json()) {
      if (row.found) found.add((row.found.name || '').split('/').pop());
    }
  }
  return found;
}

// Oldest-first page of a SUBcollection, for bounded pruning. `parent` is the
// document that owns it — runQuery resolves collectionId relative to the parent
// in the URL, so querying a subcollection from the database root would silently
// look for a top-level collection of that name and return nothing.
async function fsOldest(env, token, parent, collection, field, n) {
  const url = `https://firestore.googleapis.com/v1/${fsRoot(env)}/${parent}:runQuery`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: collection }],
      orderBy: [{ field: { fieldPath: field }, direction: 'ASCENDING' }],
      limit: n
    }})
  });
  if (!r.ok) return [];
  const rows = await r.json();
  if (!Array.isArray(rows)) return [];
  return rows.filter(x => x.document).map(x => {
    const o = { _id: (x.document.name || '').split('/').pop() };
    for (const [k, v] of Object.entries(x.document.fields || {})) o[k] = fsDecode(v);
    return o;
  });
}

// ════════════════════════════════════════════════════════════════════════════
// TASKHUB BRIDGE
//
// OneInbox writes cards to its OWN collection (dashboards/oneinbox/cards) and
// index.html merges them into Tony's TaskHub at RENDER time. It deliberately
// does NOT write into dashboards/main:
//   • dashboards/main is one document that TaskHub rewrites WHOLESALE from its
//     local React state on a 500ms debounce. A field-level write from here would
//     race that and could be silently clobbered.
//   • Keeping OneInbox's data in OneInbox's own collection means the worst case
//     for any bug in this worker is "a card is missing", never "Tony's TaskHub
//     lost a task".
// Dedupe: the card id is derived from the OFFER, not the email, so the same
// coupon arriving three times updates one card instead of creating three.
// ════════════════════════════════════════════════════════════════════════════

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);

function cardFor(msg, ai) {
  const from = parseAddr(msg.from);
  const base = {
    emailId: msg.id, threadId: msg.threadId, account: msg.account || '',
    merchant: ai.merchant || from.name, summary: ai.summary || msg.subject,
    subject: msg.subject, updatedAt: Date.now(), engine: ai.engine || 'local',
    confidence: ai.confidence ?? 0
  };

  if (ai.category === 'coupon') {
    // Identity = store + code (or store + discount for no-code offers). A repeat
    // send of "NIKE25" therefore lands on the same card id and updates it.
    const id = 'cpn_' + slug(ai.merchant || from.name) + '_' + slug(ai.code || ai.amount || 'offer');
    return {
      id, kind: 'coupon', ...base,
      code: ai.code || '', discount: ai.amount || '', expires: ai.date || '',
      restrictions: ai.note || '',
      storeUrl: from.email ? 'https://' + (from.email.split('@')[1] || '').replace(/^(mail|email|e|news|notices|no-?reply)\./i, '') : ''
    };
  }

  if (ai.category === 'package') {
    // Identity = the tracking number. Ship → out-for-delivery → delivered all
    // update ONE card, and a changed ETA moves that same card's day.
    const id = 'pkg_' + slug(ai.tracking || (ai.orderNumber + '_' + ai.merchant));
    // A package card with no eta renders NOWHERE — the weekly view is keyed by
    // day, so a dateless card silently vanishes instead of failing loudly.
    //
    // Three sources, best first:
    //   1. the AI's resolved date
    //   2. the email's own words ("Arriving tomorrow"), read against the date
    //      the email was SENT — this is what rescues a parcel whenever the AI
    //      did not run or missed it
    //   3. the day the mail arrived, which is right for "out for delivery" and
    //      delivery confirmations, and one day early for everything else. Last
    //      resort: better a card on roughly the right day than none at all.
    const sentAt = new Date(msg.internalDate || Date.now());
    const read = ai.date || deliveryEta(`${msg.subject}\n${msg.text || msg.snippet || ''}`, sentAt);
    const eta = read || sentAt.toISOString().slice(0, 10);
    return {
      id, kind: 'package', ...base,
      carrier: ai.carrier || '', tracking: ai.tracking || '',
      orderNumber: ai.orderNumber || '', eta,
      etaExact: !!read,             // false = inferred from the email's own date
      trackUrl: trackingUrl(ai.carrier, ai.tracking),
      delivered: /delivered/i.test(msg.subject + ' ' + (ai.summary || ''))
    };
  }

  // These four are placed on the weekly view BY DATE, so without one there is
  // nowhere to draw them — a card with no date would be written to Firestore
  // and then be invisible forever, which is worse than no card at all (you'd
  // never know it existed to go looking for it). Unlike a package, guessing the
  // email's own date would be actively wrong here: an appointment reminder that
  // arrives today is not an appointment today. So skip the card and leave the
  // classification on the message, where the reader still shows it.
  if (ai.category === 'bill' || ai.category === 'subscription') {
    if (!ai.date) return null;
    const id = (ai.category === 'bill' ? 'bill_' : 'sub_') + slug(ai.merchant || from.name) + '_' + slug(ai.date || ai.amount);
    return { id, kind: ai.category, ...base, amount: ai.amount || '', due: ai.date };
  }

  if (ai.category === 'travel' || ai.category === 'appointment') {
    if (!ai.date) return null;
    const id = (ai.category === 'travel' ? 'trv_' : 'apt_') + slug(ai.code || ai.merchant) + '_' + slug(ai.date);
    return { id, kind: ai.category, ...base, confirmation: ai.code || '', when: ai.date, location: ai.location || '' };
  }

  return null;   // general / important produce no TaskHub card
}

// ════════════════════════════════════════════════════════════════════════════
// INGESTION — fetch → classify → Firestore (+ card)
// ════════════════════════════════════════════════════════════════════════════

const emailDocId = (account, id) => `${slug(account.split('@')[0])}_${id}`;

// SUBREQUEST BUDGET. Cloudflare's free plan allows only 50 subrequests per
// Worker invocation, and each message costs ~2 (fetch the message, then the
// Gemini call) on top of per-account overhead. Polling 5 accounts x 12 messages
// blew straight through it — the later accounts died with "Too many subrequests
// by single Worker invocation" and ingested nothing at all. So a run processes a
// bounded number of MESSAGES in total, and runCron rotates which accounts get
// looked at first, so everything is covered across successive ticks.
const MSGS_PER_RUN = 8;

async function ingestMessages(env, email, ids, budget, opts = {}) {
  if (!ids.length || !fsConfigured(env)) return { ingested: 0, cards: 0 };
  const room = budget ? Math.max(0, budget.msgs) : 25;
  if (!room) return { ingested: 0, cards: 0, deferred: ids.length };

  const token = await getGoogleAccessToken(env);
  const root = fsRoot(env);

  // Work out what is ACTUALLY new before spending any budget. The hourly
  // snapshot hands back the same newest-12 ids every time, so budgeting before
  // the dedupe check meant each run burned its whole allowance re-confirming
  // mail it already had, and genuinely new messages never got a turn.
  // batchGet is a single subrequest for the whole list, so checking all of them
  // is effectively free.
  // A rescan deliberately ignores that dedupe. Classification is not a
  // once-and-forever fact: it changes when the parser improves, and an email
  // that was read while the AI was out of quota — or while its account could
  // not be reached at all — is filed on whatever the regex fallback managed at
  // the time and never looked at again. Re-reading is the only way to recover
  // a card that was missed or dated wrong.
  let fresh;
  if (opts.rescan) {
    fresh = ids;
  } else {
    const known = await fsExisting(env, token, 'dashboards/oneinbox/emails',
      ids.map(id => emailDocId(email, id)));
    fresh = ids.filter(id => !known.has(emailDocId(email, id)));
  }

  const batch = fresh.slice(0, Math.min(25, room));
  if (budget) budget.msgs -= batch.length;
  const deferred = fresh.length - batch.length;
  const existing = new Set();   // batch is already known-new

  // Shared run-scoped budget; persisted by aiBudgetFlush() at the end of the
  // whole run, not here (see the note on aiBudget).
  const aiRec = await aiBudget(env);
  const startedAt = aiRec.n;

  const writes = [];
  let cards = 0;
  for (const id of batch) {
    const docId = emailDocId(email, id);
    if (existing.has(docId)) continue;
    let msg;
    try { msg = decodeMessage(await gapi(env, email, `/messages/${id}?format=full`)); }
    catch (e) { console.warn('fetch message failed', id, e.message); continue; }
    msg.account = email;

    // Never classify the user's own outbound mail, and never spend AI on spam.
    const isOwn = msg.labelIds.includes('SENT') || msg.labelIds.includes('DRAFT');
    const isJunk = msg.labelIds.includes('SPAM') || msg.labelIds.includes('TRASH');
    const ai = (isOwn || isJunk)
      ? { category: 'general', confidence: 1, summary: msg.subject, engine: 'skipped' }
      : await classify(env, msg, aiRec);

    const from = parseAddr(msg.from);
    writes.push({ update: {
      name: `${root}/dashboards/oneinbox/emails/${docId}`,
      fields: fsFields({
        id: msg.id, account: email, threadId: msg.threadId,
        subject: msg.subject, fromEmail: from.email, fromName: from.name,
        snippet: msg.snippet.slice(0, 300), date: msg.internalDate,
        labels: msg.labelIds, unread: msg.labelIds.includes('UNREAD'),
        starred: msg.labelIds.includes('STARRED'),
        hasAttachments: msg.attachments.filter(a => !a.inline).length > 0,
        category: ai.category, confidence: ai.confidence ?? 0,
        summary: ai.summary || '', merchant: ai.merchant || '',
        aiDate: ai.date || '', amount: ai.amount || '', code: ai.code || '',
        carrier: ai.carrier || '', tracking: ai.tracking || '',
        orderNumber: ai.orderNumber || '', location: ai.location || '',
        note: ai.note || '', actionItems: ai.actionItems || [],
        engine: ai.engine || 'local', ingestedAt: Date.now()
      })
    }});

    const card = cardFor(msg, ai);
    if (card) {
      cards++;
      writes.push({ update: { name: `${root}/dashboards/oneinbox/cards/${card.id}`, fields: fsFields(card) } });
    }
  }

  if (writes.length) {
    // DEDUPE BY DOCUMENT NAME. Firestore rejects an entire batchWrite with
    // "the same document cannot be written more than once in a single request"
    // if two writes target one doc — and card ids are derived from the OFFER,
    // not the email, precisely so repeats collapse onto one card. So two
    // notifications about the same parcel in one batch (very common: "arriving
    // soon" + "out for delivery" minutes apart, both with no tracking number,
    // both collapsing to the same id) poisoned the whole batch. Every email in
    // it was then lost, silently, for that account. Last write wins, which is
    // the newest state of the parcel.
    const byName = new Map();
    for (const w of writes) byName.set(w.update.name, w);
    const deduped = [...byName.values()];

    // updateMask keeps this a FIELD write: the meta doc also holds settings the
    // UI owns, and a maskless update would wipe them.
    deduped.push({
      update: { name: `${root}/dashboards/oneinbox`, fields: fsFields({ lastIngestAt: Date.now() }) },
      updateMask: { fieldPaths: ['lastIngestAt'] }
    });
    await fsBatchWrite(env, token, deduped);
  }
  return { ingested: writes.length, cards, deferred, aiUsed: aiRec.n - startedAt, aiToday: aiRec.n };
}

// ── Gmail push (watch) ──────────────────────────────────────────────────────
// A watch registration lasts 7 days max, so /cron re-arms daily. historyId is
// the resume point: Pub/Sub only tells us "something changed", never what.

async function startWatch(env, email) {
  if (!env.PUBSUB_TOPIC) return { skipped: 'PUBSUB_TOPIC not set' };
  const r = await gapi(env, email, '/watch', {
    method: 'POST',
    body: JSON.stringify({ topicName: env.PUBSUB_TOPIC, labelIds: ['INBOX'], labelFilterBehavior: 'include' })
  });
  const acct = await getAccount(env, email);
  if (acct) {
    acct.watchExpiry = Number(r.expiration || 0);
    acct.historyId = acct.historyId || r.historyId;
    await saveAccount(env, acct);
  }
  return r;
}

// Pub/Sub says only "account X changed". Ask Gmail what actually changed since
// the historyId we last saw, then ingest only genuinely new message ids.
// `snapshot` also pulls the newest INBOX messages outright, independently of the
// history cursor. It is the self-healing path: if the cursor ever skips ahead
// (a failed batch, an aged-out historyId, a dropped push) the gap would other-
// wise be permanent, because history is a forward-only stream. Re-checking the
// newest few is nearly free — fsExisting dedupes them in one batchGet, so
// already-ingested mail costs no AI and no writes.
async function syncHistory(env, email, { snapshot = false, budget = null } = {}) {
  const acct = await getAccount(env, email);
  if (!acct) return { error: 'unknown account' };

  if (!acct.historyId) {
    // No resume point yet: take the newest inbox messages once, and record the
    // profile's historyId so every later sync is incremental.
    const prof = await gapi(env, email, '/profile');
    const list = await gapi(env, email, '/messages?maxResults=15&labelIds=INBOX');
    acct.historyId = prof.historyId;
    await saveAccount(env, acct);
    return ingestMessages(env, email, (list.messages || []).map(m => m.id), budget);
  }

  let ids = new Set(), pageToken = null, newest = acct.historyId, pages = 0;
  do {
    let h;
    try {
      h = await gapi(env, email, `/history?startHistoryId=${acct.historyId}&historyTypes=messageAdded` +
        (pageToken ? `&pageToken=${pageToken}` : ''));
    } catch (e) {
      // 404 = the history id aged out (Gmail keeps ~1 week). Reset the cursor
      // and let the next tick take a fresh snapshot instead of looping forever.
      if (/404/.test(e.message)) { acct.historyId = null; await saveAccount(env, acct); return { reset: true }; }
      throw e;
    }
    for (const rec of h.history || []) for (const m of rec.messagesAdded || []) {
      const lbl = m.message?.labelIds || [];
      if (lbl.includes('INBOX') && !lbl.includes('DRAFT')) ids.add(m.message.id);
    }
    newest = h.historyId || newest;
    pageToken = h.nextPageToken;
  } while (pageToken && ++pages < 5);

  // Safety snapshot — merge in the newest inbox ids regardless of the cursor.
  if (snapshot) {
    try {
      const recent = await gapi(env, email, '/messages?maxResults=12&labelIds=INBOX');
      for (const m of recent.messages || []) ids.add(m.id);
    } catch (e) { console.warn('snapshot failed', email, e.message); }
  }

  // INGEST FIRST, THEN advance the cursor. The reverse order loses mail
  // permanently: if ingestMessages throws (a Firestore hiccup, a batch write
  // failure) after the cursor has already moved past those ids, the next poll
  // starts from the new point and those messages are never seen again — which
  // is exactly how today's newest mail went missing while older mail was fine.
  // Leaving the cursor put means a failed batch is simply retried next tick.
  const result = await ingestMessages(env, email, [...ids], budget);

  // Only persist when the cursor actually MOVED. A quiet mailbox hands back the
  // same historyId, and rewriting it anyway cost one KV write per account per
  // poll — 5 accounts x 96 polls/day = 480 writes/day against a 1,000/day free
  // limit, purely to store an unchanged value.
  // Hold the cursor when the run hit its message budget: advancing past ids
  // we deliberately deferred would drop them for good.
  if (newest && newest !== acct.historyId && !result.deferred) {
    acct.historyId = newest;
    await saveAccount(env, acct);
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// SENDING
// ════════════════════════════════════════════════════════════════════════════

// RFC 2047 for non-ASCII headers — without it an emoji in a subject line
// arrives as mojibake.
function encodeHeader(s) {
  if (!s || !/[^\x00-\x7F]/.test(s)) return s || '';
  return '=?UTF-8?B?' + b64url(s).replace(/-/g, '+').replace(/_/g, '/') + '?=';
}

// A filename rides inside two header parameters, so a quote or a newline in one
// would break — or forge — the headers around it, and a non-ASCII character
// would arrive as mojibake. Strip the former, RFC 2047 the latter. Truncate
// BEFORE encoding: slicing an encoded word would cut its base64 in half.
function safeFilename(n) {
  return encodeHeader(String(n || 'attachment').replace(/[\r\n"\\]/g, '_').slice(0, 180));
}

// Gmail's own ceiling is 35 MB per message; base64 has already inflated the
// attachment bytes by ~33% by the time they reach here. This guard exists mostly
// so an oversized message fails with a sentence the UI can show, rather than as
// an opaque Gmail 413 or a Worker that runs out of memory building the string.
const MAX_MIME_BYTES = 30 * 1024 * 1024;

// RFC 2045 caps a base64 line at 76 characters, and SMTP itself refuses lines
// over 1000 octets, so unwrapped attachment data is not an option. The obvious
// `replace(/(.{76})/g, '$1\n')` is the single most expensive thing in this file
// — ~15 ms on a 2 MB image, against a 10 ms CPU budget. A slice loop is half
// that, and the browser wraps before sending anyway, so this normally never runs.
function wrap76(b64) {
  if (b64.includes('\n')) return b64;          // already wrapped by the client
  const out = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join('\r\n');
}

function buildMime({ from, fromName, to, cc, bcc, subject, html, text, attachments, inReplyTo, references }) {
  const bd = 'oi_' + Math.random().toString(36).slice(2);
  const alt = 'oa_' + Math.random().toString(36).slice(2);
  const has = attachments && attachments.length;
  const L = [];
  L.push(`From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`);
  L.push(`To: ${to}`);
  if (cc) L.push(`Cc: ${cc}`);
  if (bcc) L.push(`Bcc: ${bcc}`);
  L.push(`Subject: ${encodeHeader(subject || '')}`);
  if (inReplyTo) { L.push(`In-Reply-To: ${inReplyTo}`); L.push(`References: ${references || inReplyTo}`); }
  L.push('MIME-Version: 1.0');

  const bodyBlock = [
    `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
    btoa(unescape(encodeURIComponent(text || ''))).replace(/(.{76})/g, '$1\n'), '',
    `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
    btoa(unescape(encodeURIComponent(html || ''))).replace(/(.{76})/g, '$1\n'), '',
    `--${alt}--`
  ].join('\r\n');

  if (!has) { L.push(bodyBlock); return L.join('\r\n'); }

  L.push(`Content-Type: multipart/mixed; boundary="${bd}"`, '', `--${bd}`);
  L.push(bodyBlock, '');
  for (const a of attachments) {
    const name = safeFilename(a.filename);
    const type = String(a.mimeType || 'application/octet-stream').replace(/[\r\n";]/g, '');
    L.push(`--${bd}`);
    L.push(`Content-Type: ${type}; name="${name}"`);
    L.push(`Content-Disposition: attachment; filename="${name}"`);
    L.push('Content-Transfer-Encoding: base64', '');
    L.push(wrap76(String(a.data || '')), '');
  }
  L.push(`--${bd}--`);
  const raw = L.join('\r\n');
  if (raw.length > MAX_MIME_BYTES) {
    throw new Error(`message is too large (${(raw.length / 1048576).toFixed(1)} MB) — Gmail's limit is 35 MB`);
  }
  return raw;
}

// Which of the two send paths a message takes is decided by SIZE, not by
// whether it has an attachment. The JSON path is the well-trodden one and is
// what every plain message has always used; the only reason to leave it is that
// base64-ing the MIME costs real CPU, and the budget is 10 ms per invocation:
//
//     35 KB MIME → 0.3 ms      500 KB → 3.6 ms
//    250 KB MIME → 1.7 ms      2 MB   → 12 ms   ← over budget
//
// So anything that comfortably fits stays on the proven path — a 25 KB photo
// included — and only genuinely big messages take the upload URI.
const JSON_SEND_MAX = 800 * 1024;

async function sendNow(env, p) {
  const acct = await getAccount(env, p.from);
  if (!acct) throw new Error('unknown sending account');
  const raw = buildMime({ ...p, fromName: acct.name });
  if (raw.length > JSON_SEND_MAX) {
    return gapiUpload(env, p.from, '/messages/send', raw, p.threadId ? { threadId: p.threadId } : {});
  }
  return gapi(env, p.from, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: b64url(raw), threadId: p.threadId || undefined })
  });
}

// Scheduled sends are parked in KV keyed by due-time. /cron drains them, so a
// scheduled mail goes out even with every device closed.
//
// KV BUDGET: the free plan allows 100,000 reads/day but only 1,000 LIST
// operations. /cron runs every 5 minutes (288 ticks/day), so listing blindly
// on every tick would consume roughly a third of the day's LIST budget for
// nothing. A counter key — a plain read, against the huge read budget — lets an
// empty queue cost one read and zero lists.
const SCHED_N = 'oi:schedn';

async function scheduleSend(env, p, at) {
  const id = b64url(crypto.getRandomValues(new Uint8Array(9)));
  await env.OI_KV.put('oi:sched:' + at + ':' + id, JSON.stringify(p), {
    expirationTtl: Math.max(120, Math.ceil((at - Date.now()) / 1000) + 86400)
  });
  const n = Number(await env.OI_KV.get(SCHED_N)) || 0;
  await env.OI_KV.put(SCHED_N, String(n + 1));
  return id;
}

async function drainScheduled(env) {
  const pending = Number(await env.OI_KV.get(SCHED_N)) || 0;
  if (pending <= 0) return 0;

  const now = Date.now();
  const page = await env.OI_KV.list({ prefix: 'oi:sched:', limit: 100 });
  let sent = 0, left = 0;
  for (const k of page.keys) {
    const due = Number(k.name.split(':')[2] || 0);
    if (!due || due > now) { left++; continue; }
    const p = await env.OI_KV.get(k.name, 'json');
    if (p) {
      try { await sendNow(env, p); sent++; }
      catch (e) { console.warn('scheduled send failed:', e.message); }
    }
    await env.OI_KV.delete(k.name);
  }
  // Recount from what the list actually showed, so a stale counter (a TTL
  // expiry, a failed send) self-corrects instead of pinning the queue "busy"
  // and burning a LIST every tick forever.
  if (!page.list_complete) left = Math.max(left, 1);
  await env.OI_KV.put(SCHED_N, String(left));
  return sent;
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════

async function handleGmail(path, body, env, origin) {
  const email = String(body.account || '').toLowerCase();
  if (path !== '/gmail/watch' && !(await getAccount(env, email))) {
    return json({ ok: false, error: 'unknown account' }, origin, 400);
  }

  if (path === '/gmail/list') {
    const p = new URLSearchParams({ maxResults: String(Math.min(body.limit || 25, 50)) });
    if (body.q) p.set('q', body.q);
    if (body.labelIds) for (const l of body.labelIds) p.append('labelIds', l);
    if (body.pageToken) p.set('pageToken', body.pageToken);
    const list = await gapi(env, email, '/messages?' + p.toString());
    // format=metadata keeps the response small; the full body is fetched only
    // when a message is actually opened.
    const msgs = await mapLimit(list.messages || [], 6, m =>
      gapi(env, email, `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`)
        .then(decodeMessage).catch(() => null)
    );
    return json({
      ok: true, nextPageToken: list.nextPageToken || null,
      messages: msgs.filter(Boolean).map(m => ({
        id: m.id, threadId: m.threadId, subject: m.subject, from: m.from, to: m.to,
        snippet: m.snippet, date: m.internalDate, labels: m.labelIds,
        unread: m.labelIds.includes('UNREAD'), starred: m.labelIds.includes('STARRED'), account: email
      }))
    }, origin);
  }

  if (path === '/gmail/message') {
    const m = decodeMessage(await gapi(env, email, `/messages/${body.id}?format=full`));
    return json({ ok: true, message: { ...m, account: email, attachments: m.attachments.filter(a => !a.inline || !a.contentId) } }, origin);
  }

  if (path === '/gmail/attachment') {
    const a = await gapi(env, email, `/messages/${body.id}/attachments/${body.attachmentId}`);
    return json({ ok: true, data: a.data, size: a.size }, origin);
  }

  if (path === '/gmail/send') {
    if (body.sendAt && Number(body.sendAt) > Date.now() + 30000) {
      const id = await scheduleSend(env, body, Number(body.sendAt));
      return json({ ok: true, scheduled: true, id }, origin);
    }
    const r = await sendNow(env, { ...body, from: email });
    return json({ ok: true, id: r.id, threadId: r.threadId }, origin);
  }

  if (path === '/gmail/modify') {
    if (body.op === 'trash')  return json({ ok: true, r: await gapi(env, email, `/messages/${body.id}/trash`, { method: 'POST' }) }, origin);
    if (body.op === 'untrash')return json({ ok: true, r: await gapi(env, email, `/messages/${body.id}/untrash`, { method: 'POST' }) }, origin);
    const map = {
      archive:  { removeLabelIds: ['INBOX'] },
      unarchive:{ addLabelIds: ['INBOX'] },
      read:     { removeLabelIds: ['UNREAD'] },
      unread:   { addLabelIds: ['UNREAD'] },
      star:     { addLabelIds: ['STARRED'] },
      unstar:   { removeLabelIds: ['STARRED'] },
      label:    { addLabelIds: body.labelIds || [] },
      unlabel:  { removeLabelIds: body.labelIds || [] }
    };
    const mod = map[body.op];
    if (!mod) return json({ ok: false, error: 'unknown op' }, origin, 400);
    return json({ ok: true, r: await gapi(env, email, `/messages/${body.id}/modify`, { method: 'POST', body: JSON.stringify(mod) }) }, origin);
  }

  if (path === '/gmail/draft') {
    const acct = await getAccount(env, email);
    const mime = buildMime({ ...body, from: email, fromName: acct.name });
    // Same size split as sendNow.
    if (mime.length > JSON_SEND_MAX) {
      const meta = body.threadId ? { message: { threadId: body.threadId } } : {};
      const d = body.draftId
        ? await gapiUpload(env, email, `/drafts/${body.draftId}`, mime, meta, 'PUT')
        : await gapiUpload(env, email, '/drafts', mime, meta);
      return json({ ok: true, draft: d }, origin);
    }
    const raw = b64url(mime);
    if (body.draftId) {
      return json({ ok: true, draft: await gapi(env, email, `/drafts/${body.draftId}`, { method: 'PUT', body: JSON.stringify({ message: { raw } }) }) }, origin);
    }
    return json({ ok: true, draft: await gapi(env, email, '/drafts', { method: 'POST', body: JSON.stringify({ message: { raw } }) }) }, origin);
  }

  // Re-read the newest mail and rebuild its cards, ignoring the "already seen"
  // check. This is the recovery path for anything the parser missed the first
  // time — a package whose "Arriving tomorrow" was never resolved into a day,
  // or a whole account that was unreachable while its mail arrived.
  //
  // Bounded hard: every message costs a Gmail fetch AND an AI call, against a
  // 50-subrequest ceiling per invocation. 10 at a time keeps a rescan inside
  // that with room to spare; the caller can simply run it again.
  if (path === '/gmail/rescan') {
    const n = Math.min(Math.max(Number(body.limit) || 10, 1), 15);
    const list = await gapi(env, email, `/messages?${new URLSearchParams({ maxResults: String(n), q: body.q || 'newer_than:7d' })}`);
    const ids = (list.messages || []).map(m => m.id);
    const r = await ingestMessages(env, email, ids, { msgs: n }, { rescan: true });
    await aiBudgetFlush(env);
    return json({ ok: true, account: email, looked: ids.length, ...r }, origin);
  }

  if (path === '/gmail/labels') {
    const d = await gapi(env, email, '/labels');
    return json({ ok: true, labels: (d.labels || []).map(l => ({ id: l.id, name: l.name, type: l.type })) }, origin);
  }

  if (path === '/gmail/watch') {
    const list = email ? [email] : await getAccountIndex(env);
    const out = [];
    for (const e of list) {
      try { out.push({ email: e, ...(await startWatch(env, e)) }); }
      catch (err) { out.push({ email: e, error: err.message }); }
    }
    return json({ ok: true, watches: out }, origin);
  }

  return json({ ok: false, error: 'unknown gmail route' }, origin, 404);
}

async function handleAI(path, body, env, origin) {
  if (path === '/ai/parse') {
    const today = new Date().toISOString().slice(0, 10);
    const { result, model, error } = await runChain(PARSE_MODELS, env.ONEINBOX_GEMINI_KEY, {
      prompt: parsePrompt(today) + String(body.text || '').slice(0, 6000), schema: PARSE_SCHEMA
    });
    if (result) return json({ ok: true, engine: model, result }, origin);
    return json({ ok: true, engine: 'local', degraded: error, result: localParse(String(body.text || ''), body.from || '') }, origin);
  }

  if (path === '/ai/reply') {
    const prompt = [
      `Draft a reply to the email below.`,
      `Tone: ${body.tone || 'warm but efficient, professional'}.`,
      `Length: ${body.length || 'short — 2-4 sentences'}.`,
      body.instruction ? `The user wants to say: ${body.instruction}` : `Respond appropriately to what was asked.`,
      ``,
      `Write ONLY the reply body. No subject line, no "Dear", no sign-off block —`,
      `a signature is appended automatically. Plain text, no markdown.`,
      ``,
      `EMAIL:`,
      String(body.text || '').slice(0, 6000)
    ].join('\n');
    const { result, model, error } = await runChain(REPLY_MODELS, env.ONEINBOX_GEMINI_KEY, { prompt, maxOutputTokens: 700 });
    if (result) return json({ ok: true, engine: model, draft: String(result).trim() }, origin);
    return json({ ok: false, error: error || 'AI unavailable' }, origin, 503);
  }

  return json({ ok: false, error: 'unknown ai route' }, origin, 404);
}

// Gmail → Pub/Sub → here. The body is a base64 envelope naming the account and
// its latest historyId; we always ask Gmail what actually changed.
async function handlePubSub(request, env, origin) {
  const url = new URL(request.url);
  if (!env.PUBSUB_TOKEN || url.searchParams.get('token') !== env.PUBSUB_TOKEN) {
    return new Response('forbidden', { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const raw = body?.message?.data ? b64urlDecode(body.message.data) : '';
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* fall through */ }
  const email = String(payload.emailAddress || '').toLowerCase();
  // ALWAYS 204 (even on error). A non-2xx makes Pub/Sub redeliver forever, and
  // a message we cannot parse will never succeed on retry either.
  if (!email) return new Response(null, { status: 204 });
  try { await syncHistory(env, email); }
  catch (e) { console.warn('pubsub sync failed', email, e.message); }
  await aiBudgetFlush(env);
  return new Response(null, { status: 204 });
}

// Driven by taskhub-reminders' every-minute cron. Most ticks do almost nothing;
// the expensive work is rate-limited by timestamps in one KV key.
// `force` ignores the rate-limit gates and runs the poll (with a snapshot) now.
// Without it, hitting /cron to recover from a problem can silently do nothing
// because the 15-minute gate has not elapsed — which is exactly what happened
// while chasing a missing package card: the request returned 200 and skipped
// every piece of work.
async function runCron(env, { force = false } = {}) {
  const out = { at: new Date().toISOString(), forced: force };
  const state = (await env.OI_KV.get('oi:cron', 'json')) || {};
  const now = Date.now();
  // KV WRITE BUDGET: the free plan allows 100,000 reads/day but only 1,000
  // WRITES. This function runs every 5 minutes (288 ticks/day), so writing the
  // state key unconditionally burned 288 writes/day — 29% of the entire daily
  // budget — just to record "nothing happened". Only persist when a gated task
  // actually ran and moved a timestamp.
  let dirty = false;

  // Every tick: scheduled sends (cheap — one bounded KV list).
  try { out.sent = await drainScheduled(env); } catch (e) { out.sendErr = e.message; }

  const accounts = await getAccountIndex(env);

  // Daily: re-arm Gmail watches. Registrations expire after 7 days; re-arming
  // daily means a single missed day is never fatal.
  if (now - (state.lastWatch || 0) > 20 * 3600e3) {
    out.watch = [];
    for (const e of accounts) {
      try { await startWatch(env, e); out.watch.push(e); }
      catch (err) { out.watch.push(e + ':' + err.message); }
    }
    state.lastWatch = now; dirty = true;
  }

  // Every 15 min: incremental history poll. Pure safety net for a dropped
  // Pub/Sub delivery or an expired watch — it is incremental, so a quiet
  // mailbox costs one tiny Gmail call and no AI spend.
  if (force || now - (state.lastPoll || 0) > 15 * 60e3) {
    // Once an hour the poll also takes a snapshot of the newest inbox ids, so
    // any gap the forward-only history cursor left behind repairs itself
    // instead of being lost for good.
    const snapshot = force || now - (state.lastSnap || 0) > 60 * 60e3;
    // Shared message budget for the whole invocation (see MSGS_PER_RUN), and a
    // rotating start point so a bounded run doesn't always spend its budget on
    // the same first account and starve the rest. Every mailbox comes up within
    // a few ticks, and polls run every 15 minutes.
    const budget = { msgs: MSGS_PER_RUN };
    const start = (state.acctCursor || 0) % Math.max(1, accounts.length);
    const ordered = accounts.slice(start).concat(accounts.slice(0, start));
    out.polled = [];
    for (const e of ordered) {
      try { const r = await syncHistory(env, e, { snapshot, budget }); out.polled.push({ e, ...r }); }
      catch (err) { out.polled.push({ e, error: err.message }); }
    }
    state.acctCursor = (start + 1) % Math.max(1, accounts.length);
    state.lastPoll = now; dirty = true;
    if (snapshot) { state.lastSnap = now; out.snapshot = true; }
    out.budgetLeft = budget.msgs;
  }

  // Daily: retire cards whose moment has passed, so TaskHub does not accumulate
  // expired coupons and delivered packages forever.
  if (now - (state.lastSweep || 0) > 20 * 3600e3) {
    try { out.swept = await sweepCards(env); } catch (e) { out.sweepErr = e.message; }
    state.lastSweep = now; dirty = true;
  }

  if (dirty) await env.OI_KV.put('oi:cron', JSON.stringify(state));
  await aiBudgetFlush(env);   // one write per run, covering every account
  return out;
}

// A coupon two days past expiry, or a package delivered a week ago, is noise.
// Also caps the emails collection: metadata for every message ever received
// would grow without bound, and the UI only ever reads the newest 150.
async function sweepCards(env) {
  if (!fsConfigured(env)) return 0;
  const token = await getGoogleAccessToken(env);
  const root = fsRoot(env);
  const today = new Date().toISOString().slice(0, 10);
  const grace = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);

  // Oldest-touched first, so the sweep is drain-safe: a plain single-page list
  // would only ever see the first 300 documents, and anything beyond that page
  // could never be retired. Cards are self-expiring so the collection should
  // stay far below this, but the bound shouldn't depend on that assumption.
  const cards = await fsOldest(env, token, 'dashboards/oneinbox', 'cards', 'updatedAt', 400);
  const dead = cards.filter(c => {
    if (c.kind === 'coupon') return c.expires && c.expires < grace;
    if (c.kind === 'package') return c.delivered && c.updatedAt < Date.now() - 5 * 864e5;
    if (c.kind === 'bill' || c.kind === 'subscription') return c.due && c.due < grace;
    if (c.kind === 'travel' || c.kind === 'appointment') return c.when && c.when < today;
    return c.updatedAt < Date.now() - 45 * 864e5;
  });

  // RETENTION — 1 year of email metadata + AI classifications.
  //
  // Your actual mail is untouched: it lives in Gmail and is always fetched
  // live, so nothing here limits how far back you can read or search. This
  // only bounds OneInbox's own derived data (classification, extracted
  // fields), which is what the AI card and the category badges are drawn from.
  //
  // Sizing, measured against the real doc shape (~1.6 KB, ~3.9 KB billed once
  // Firestore's automatic single-field indexes are counted):
  //     150 mails/day x 365d = 216 MB  (20% of the 1 GiB free tier)
  //     300 mails/day x 365d = 432 MB  (40%)
  //     300 mails/day x 3yr  = 1.3 GB  (OVER — hence a year, not "forever")
  //
  // Oldest-first and bounded, so one sweep is cheap and a backlog drains over
  // successive days instead of one huge, failure-prone run. The page size must
  // EXCEED daily inflow or the collection grows forever: at 200/day a mailbox
  // taking 300/day accumulates 100 docs a day once the window is reached.
  // 500 sits above realistic volume, and Firestore deletes are cheap
  // (20,000/day free).
  const cutoff = Date.now() - 365 * 864e5;
  const oldEmails = (await fsOldest(env, token, 'dashboards/oneinbox', 'emails', 'date', 500))
    .filter(e => (e.date || 0) < cutoff);

  await fsBatchWrite(env, token, [
    ...dead.map(c => ({ delete: `${root}/dashboards/oneinbox/cards/${c._id}` })),
    ...oldEmails.map(e => ({ delete: `${root}/dashboards/oneinbox/emails/${e._id}` }))
  ]);
  return dead.length + oldEmails.length;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    // EVERY route below is `return await`, never a bare `return`. In an async
    // function, `return somePromise` inside a try block hands the promise to
    // the caller BEFORE it settles, so the catch never sees its rejection —
    // the error escapes to the runtime, Cloudflare answers with its own error
    // page, and that page has no CORS headers. The browser then reports a bare
    // "Failed to fetch" with nothing readable in it. That is exactly how a
    // revoked Gmail token spent this morning masquerading as a network fault.
    try {
      // ── Public / browser-navigation routes ──────────────────────────────
      if (path === '/') {
        const b = await aiBudget(env).catch(() => ({ d: '?', n: 0 }));
        return json({
          ok: true, service: 'oneinbox-api',
          accounts: (await getAccountIndex(env)).length,
          ai: !!env.ONEINBOX_GEMINI_KEY, firestore: fsConfigured(env),
          oauth: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
          push: !!(env.PUBSUB_TOPIC && env.PUBSUB_TOKEN),
          // Gemini calls spent today, so usage is inspectable without digging
          // through logs: one call per new inbox message.
          aiToday: b.n, aiLimit: AI_DAILY_MAX, aiDay: b.d
        }, origin);
      }
      if (path === '/oauth/callback') return await oauthCallback(request, env);
      if (path === '/oauth/start') return await oauthStart(request, env, origin);
      if (path === '/pubsub/push') return await handlePubSub(request, env, origin);
      if (path.startsWith('/lock/')) return await handleLock(path, request, env, origin);
      if (path === '/cron') {
        const force = url.searchParams.get('force') === '1';
        // Forced runs are awaited so the caller sees what actually happened;
        // the scheduled path stays fire-and-forget so the cron tick returns fast.
        if (force) return json({ ok: true, ...(await runCron(env, { force: true })) }, origin);
        ctx.waitUntil(runCron(env));
        return json({ ok: true, queued: true }, origin);
      }

      // ── Everything below requires an unlocked session ───────────────────
      const body = await request.json().catch(() => ({}));
      const denied = await requireSession(env, body, origin);
      if (denied) return denied;

      if (path === '/accounts') {
        const list = await getAccountIndex(env);
        const accts = [];
        for (const e of list) { const a = await getAccount(env, e); if (a) accts.push(publicAccount(a)); }
        return json({ ok: true, accounts: accts }, origin);
      }

      if (path === '/accounts/update') {
        const a = await getAccount(env, body.account);
        if (!a) return json({ ok: false, error: 'unknown account' }, origin, 400);
        if (typeof body.signature === 'string') a.signature = body.signature.slice(0, 4000);
        if (typeof body.name === 'string') a.name = body.name.slice(0, 120);
        await saveAccount(env, a);
        return json({ ok: true, account: publicAccount(a) }, origin);
      }

      if (path === '/accounts/disconnect') {
        const a = await getAccount(env, body.account);
        if (a) {
          // Best-effort revoke at Google, then forget the token locally either way.
          await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(a.refresh_token), { method: 'POST' }).catch(() => {});
          await env.OI_KV.delete('oi:acct:' + a.email);
          await env.OI_KV.delete('oi:tok:' + a.email).catch(() => {});
          await removeAccountIndex(env, a.email);
          _memTok.delete(a.email);
        }
        return json({ ok: true }, origin);
      }

      if (path === '/sync') {
        const list = body.account ? [String(body.account).toLowerCase()] : await getAccountIndex(env);
        // A MANUAL sync is always thorough: the user pressed Refresh because
        // something looked missing, so this is the moment to re-check the
        // newest mail directly rather than trusting the history cursor.
        // Same per-invocation message budget as the cron path — a manual sync
        // runs in one Worker invocation too, and is just as subject to the
        // 50-subrequest limit.
        const budget = { msgs: MSGS_PER_RUN };
        const res = [];
        for (const e of list) {
          try { res.push({ account: e, ...(await syncHistory(env, e, { snapshot: true, budget })) }); }
          catch (err) { res.push({ account: e, error: err.message }); }
        }
        await aiBudgetFlush(env);
        return json({ ok: true, results: res }, origin);
      }

      if (path.startsWith('/gmail/')) return await handleGmail(path, body, env, origin);
      if (path.startsWith('/ai/')) return await handleAI(path, body, env, origin);

      return json({ ok: false, error: 'not found' }, origin, 404);
    } catch (e) {
      // Never leak a token or key in an error string.
      const msg = String(e.message || 'server error').replace(/[A-Za-z0-9_\-]{40,}/g, '[redacted]');
      // `reconnect` lets the UI point at the specific mailbox that needs
      // re-authorising rather than just printing the sentence.
      return json({ ok: false, error: msg, reconnect: e.reconnect || undefined }, origin, 500);
    }
  },

  // Inert today (no [triggers] — the account's cron slots are full). Kept so
  // restoring a cron trigger is a one-line wrangler.toml change.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  }
};
