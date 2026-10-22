// shruti-drive: Shruti's media store (podcast and video audio, narrations,
// transcripts, imported originals) in Google Drive: one Drive per person.
//
// Accounts (`acct`): "tony" (Tony's Drive: his own books AND every shared
// book, whoever made it) and "veda" (Veda's Drive: her own books). Each
// person connects once (one consent click); the refresh tokens live here, in
// KV ("google" for Tony, kept from before there were two, "google:veda"),
// never in a browser, and every device and both profiles stream through this
// worker. Scope is drive.file, so the worker can only see files it made
// itself, all under one "Shruti" folder: Shruti/<book>/<chapter>/<name>.
//
// Who may call it: anyone holding a working Orca key (Shruti's own trust root;
// each person pastes theirs in Settings). The key is checked against Orca's
// GET /v1/models and a pass is cached for ten minutes (Cache API, no KV
// writes). An <audio> element cannot send a header, so playback uses signed
// links instead: /f/<id>?a=<acct>&e=<expiry>&s=<hmac>. An upload returns one
// that never expires (e=0), kept with the file's record, so both profiles
// play shared media with no key at all; POST /sign makes them for older
// records (permanent:true) or for six hours.
//
// Routes
//   GET    /health[?acct]           { ok, configured, connected, email, accounts:{tony,veda} }
//   POST   /connect?acct (key)      { url } Google's consent page for that person's Drive
//   GET    /callback                Google returns here; stores the refresh token
//   POST   /disconnect?acct (key)   revoke and forget
//   PUT    /f?book&chapter&name&owner&acct (key)  body = the file
//                                   -> { id, size, mime, store, owner, acct, url }
//   POST   /sign        (key)       { ids, acct, permanent } -> { urls: { id: url } }
//   GET    /f/<id>?a    (key or signed)  streams the file; Range passes through, so audio can seek
//   DELETE /f/<id>?a    (key)
//
// Secrets (wrangler secret put): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SIGN_KEY.
// Optional var ALLOWED_KEYS: comma-separated SHA-256 hex of the Orca keys that may
// call it; empty = any working Orca key.

const ORCA = 'https://orca.vedapatel05.workers.dev/v1';
const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const ORIGINS = [/^https:\/\/anthonyn99\.github\.io$/, /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/];
const SIGN_TTL = 6 * 3600;
const AUTH_TTL = 600;
export const ACCTS = ['tony', 'veda'];
/** Tony's token keeps the key it had before there were two Drives. */
const tokenKey = (acct) => (acct === 'veda' ? 'google:veda' : 'google');
const acctOf = (v) => (ACCTS.includes(String(v || '')) ? String(v) : 'tony');

const access = new Map();   // acct -> { token, exp }, for this isolate
const folders = new Map();  // acct:path -> Drive folder id, for this isolate

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const r = await route(req, env, url, ctx);
      for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
      return r;
    } catch (e) {
      const status = e.status || 500;
      return json({ ok: false, error: e.message || String(e) }, status, cors);
    }
  },
};

async function route(req, env, url, ctx) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  const acct = acctOf(url.searchParams.get('acct') || url.searchParams.get('a'));
  if (p === '/' || p === '/health') {
    const accounts = {};
    for (const a of ACCTS) { const t = await readToken(env, a); accounts[a] = { connected: !!t, email: (t && t.email) || null }; }
    // The top-level fields are the asked account's (Tony's by default), as before.
    return json({ ok: true, configured: configured(env), connected: accounts[acct].connected, email: accounts[acct].email, acct, accounts, signing: !!env.SIGN_KEY });
  }
  if (p === '/callback' && m === 'GET') return callback(env, url);
  if (p === '/connect' && m === 'POST') { await requireKey(req, env, ctx); return connect(env, url, acct); }
  if (p === '/disconnect' && m === 'POST') { await requireKey(req, env, ctx); return disconnect(env, acct); }
  if (p === '/f' && m === 'PUT') { await requireKey(req, env, ctx); return upload(req, env, url, acct); }
  if (p === '/sign' && m === 'POST') { await requireKey(req, env, ctx); return sign(req, env, url); }
  const f = /^\/f\/([\w-]{10,200})$/.exec(p);
  if (f && (m === 'GET' || m === 'HEAD')) {
    if (!(await validSig(env, f[1], acct, url))) await requireKey(req, env, ctx);
    return stream(req, env, f[1], acct);
  }
  if (f && m === 'DELETE') { await requireKey(req, env, ctx); return remove(env, f[1], acct); }
  return json({ ok: false, error: 'not found' }, 404);
}

/* ── responses ────────────────────────────────────────────────────────────── */
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}
function fail(status, message) { const e = new Error(message); e.status = status; return e; }
function corsHeaders(req) {
  const o = req.headers.get('origin') || '';
  const allow = ORIGINS.some((re) => re.test(o)) ? o : 'https://anthonyn99.github.io';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, range, x-shruti-profile',
    'access-control-expose-headers': 'content-length, content-range, accept-ranges, content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}
function page(title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#1a1a1d;color:#e9e9ee;font:16px/1.5 Inter,system-ui,sans-serif;padding:16px;box-sizing:border-box">' +
    '<div style="max-width:420px;text-align:center"><h1 style="font-size:22px;color:#c0aeea;margin:0 0 8px">' + esc(title) + '</h1><p style="margin:0;color:#adadb2">' + esc(text) + '</p></div>',
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/* ── who may call ─────────────────────────────────────────────────────────── */
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function requireKey(req, env, ctx) {
  const h = req.headers.get('authorization') || '';
  const key = /^Bearer\s+(\S+)$/i.exec(h);
  if (!key) throw fail(401, 'An Orca key is required');
  const hash = await sha256(key[1]);
  const allowed = String(env.ALLOWED_KEYS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(hash)) throw fail(403, 'This Orca key may not use Shruti\'s Drive');
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const ck = new Request('https://shruti-drive.internal/auth/' + hash);
  if (cache && (await cache.match(ck))) return hash;
  const r = await fetch(ORCA + '/models', { headers: { authorization: 'Bearer ' + key[1] } });
  if (r.status === 401 || r.status === 403) throw fail(401, 'Orca rejected this key');
  if (!r.ok) throw fail(502, 'Orca could not check the key (' + r.status + ')');
  if (cache) {
    const put = cache.put(ck, new Response('1', { headers: { 'cache-control': 'max-age=' + AUTH_TTL } }));
    if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
  }
  return hash;
}

/* ── signed links ─────────────────────────────────────────────────────────── */
async function hmac(env, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SIGN_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** What a link signs: Tony's six-hour links keep their old form (id.e). */
const sigMsg = (id, acct, e) => (acct === 'tony' && e ? id + '.' + e : acct + '.' + id + '.' + e);
async function validSig(env, id, acct, url) {
  const raw = url.searchParams.get('e'), e = Number(raw), s = url.searchParams.get('s') || '';
  // e=0: a link that never expires (made at upload, kept with the file's record).
  if (!env.SIGN_KEY || !s || !(raw === '0' || e > Date.now() / 1000)) return false;
  const want = await hmac(env, sigMsg(id, acct, e));
  if (want.length !== s.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ s.charCodeAt(i);
  return diff === 0;
}
/** A playback link for one file: for six hours, or for good (e=0). */
async function link(env, origin, id, acct, permanent) {
  const e = permanent ? 0 : Math.floor(Date.now() / 1000) + SIGN_TTL;
  return origin + '/f/' + id + '?' + (acct === 'tony' ? '' : 'a=' + acct + '&') + 'e=' + e + '&s=' + (await hmac(env, sigMsg(id, acct, e)));
}
async function sign(req, env, url) {
  if (!env.SIGN_KEY) throw fail(503, 'SIGN_KEY is not set');
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => /^[\w-]{10,200}$/.test(x)).slice(0, 100) : [];
  const acct = acctOf(body.acct), permanent = !!body.permanent;
  const urls = {};
  for (const id of ids) urls[id] = await link(env, url.origin, id, acct, permanent);
  return json({ ok: true, expires: permanent ? 0 : Math.floor(Date.now() / 1000) + SIGN_TTL, acct, urls });
}

/* ── Google OAuth ─────────────────────────────────────────────────────────── */
function configured(env) { return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET); }
function redirectUri(url) { return url.origin + '/callback'; }
async function readToken(env, acct = 'tony') {
  if (!env.DRIVE) return null;
  try { return await env.DRIVE.get(tokenKey(acct), 'json'); } catch (e) { return null; }
}
async function connect(env, url, acct) {
  if (!configured(env)) throw fail(503, 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set');
  if (!env.SIGN_KEY) throw fail(503, 'SIGN_KEY is not set');
  const exp = Math.floor(Date.now() / 1000) + 900;
  // The state names whose Drive this is, signed, so the callback keeps it there.
  const state = exp + '.' + acct + '.' + (await hmac(env, 'connect.' + acct + '.' + exp));
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(url), response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state,
  });
  return json({ ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q });
}
async function callback(env, url) {
  const parts = String(url.searchParams.get('state') || '').split('.');
  // exp.acct.sig (a two-part exp.sig is Tony's, from before there were two Drives).
  const [exp, acct, sig] = parts.length === 3 ? parts : [parts[0], 'tony', parts[1]];
  const want = parts.length === 3 ? 'connect.' + acct + '.' + exp : 'connect.' + exp;
  if (!env.SIGN_KEY || !ACCTS.includes(acct) || !(Number(exp) > Date.now() / 1000) || sig !== (await hmac(env, want))) {
    return page('Link expired', 'Start again from Shruti: Settings, then Connect Google Drive.');
  }
  if (url.searchParams.get('error')) return page('Not connected', 'Google said: ' + url.searchParams.get('error'));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(url), grant_type: 'authorization_code' }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.refresh_token) return page('Not connected', 'Google did not return a refresh token (' + (t.error || r.status) + '). Try again.');
  let email = null;
  try {
    const u = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: 'Bearer ' + t.access_token } });
    email = (await u.json()).email || null;
  } catch (e) {}
  await env.DRIVE.put(tokenKey(acct), JSON.stringify({ refresh_token: t.refresh_token, email, at: Date.now() }));
  access.set(acct, { token: t.access_token, exp: Date.now() + ((t.expires_in || 3600) - 60) * 1000 });
  clearFolders(acct);
  return page('Google Drive connected', 'Shruti can now keep ' + (acct === 'veda' ? 'Veda' : 'Tony') + '\'s audio and video in ' + (email || 'this Drive') + '. You can close this tab.');
}
function clearFolders(acct) { for (const k of [...folders.keys()]) if (k.startsWith(acct + ':')) folders.delete(k); }
async function disconnect(env, acct) {
  const t = await readToken(env, acct);
  if (t && t.refresh_token) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.refresh_token), { method: 'POST' }).catch(() => {});
  if (env.DRIVE) await env.DRIVE.delete(tokenKey(acct));
  access.delete(acct); clearFolders(acct);
  return json({ ok: true });
}
async function accessToken(env, acct) {
  const a = access.get(acct);
  if (a && a.exp > Date.now()) return a.token;
  const t = await readToken(env, acct);
  if (!t || !t.refresh_token) throw fail(409, (acct === 'veda' ? 'Veda\'s' : 'Tony\'s') + ' Google Drive is not connected');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw fail(r.status === 400 ? 409 : 502, 'Google refused the Drive token (' + (j.error || r.status) + '); connect again');
  access.set(acct, { token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 60) * 1000 });
  return j.access_token;
}

/* ── Drive ────────────────────────────────────────────────────────────────── */
const DRIVE = 'https://www.googleapis.com/drive/v3';
const seg = (s, fallback) => String(s || fallback).replace(/[^\w .()-]/g, '_').slice(0, 120) || fallback;
async function gfetch(env, acct, url, init = {}) {
  const tok = await accessToken(env, acct);
  const headers = new Headers(init.headers || {});
  headers.set('authorization', 'Bearer ' + tok);
  return fetch(url, { ...init, headers });
}
async function folder(env, acct, parts) {
  let parent = 'root', path = acct + ':';
  for (const name of parts) {
    path += '/' + name;
    if (folders.has(path)) { parent = folders.get(path); continue; }
    const q = "name = '" + name.replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '" + parent + "' in parents";
    const r = await gfetch(env, acct, DRIVE + '/files?fields=files(id)&pageSize=1&q=' + encodeURIComponent(q));
    const j = await r.json();
    let id = j.files && j.files[0] && j.files[0].id;
    if (!id) {
      const c = await gfetch(env, acct, DRIVE + '/files?fields=id', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
      });
      if (!c.ok) throw fail(502, 'Drive refused to make the folder ' + path + ' (' + c.status + ')');
      id = (await c.json()).id;
    }
    folders.set(path, id);
    parent = id;
  }
  return parent;
}
async function upload(req, env, url, acct) {
  const book = seg(url.searchParams.get('book'), 'misc');
  const chapter = seg(url.searchParams.get('chapter'), 'book');
  const name = seg(url.searchParams.get('name'), 'file');
  const owner = /^(tony|veda)$/.test(url.searchParams.get('owner') || '') ? url.searchParams.get('owner') : 'tony';
  const mime = (req.headers.get('content-type') || 'application/octet-stream').split(';')[0];
  const parent = await folder(env, acct, ['Shruti', book, chapter]);
  const start = await gfetch(env, acct, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,mimeType', {
    method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime },
    body: JSON.stringify({ name, parents: [parent], appProperties: { shruti: '1', owner } }),
  });
  const loc = start.headers.get('location');
  if (!start.ok || !loc) throw fail(502, 'Drive refused the upload (' + start.status + ')');
  const body = await req.arrayBuffer();
  const put = await fetch(loc, { method: 'PUT', headers: { 'content-type': mime }, body });
  const j = await put.json().catch(() => ({}));
  if (!put.ok || !j.id) throw fail(502, 'Drive upload failed (' + put.status + ')');
  const out = { ok: true, id: j.id, size: Number(j.size || body.byteLength), mime, store: 'gdrive', owner, acct, path: ['Shruti', book, chapter, name].join('/') };
  // A link that never expires: whoever can read the record can play the file, with no key.
  if (env.SIGN_KEY) out.url = await link(env, url.origin, j.id, acct, true);
  return json(out);
}
async function stream(req, env, id, acct) {
  const headers = {};
  const range = req.headers.get('range');
  if (range) headers.range = range;
  const r = await gfetch(env, acct, DRIVE + '/files/' + encodeURIComponent(id) + '?alt=media', { method: 'GET', headers });
  if (!r.ok && r.status !== 206) throw fail(r.status === 404 ? 404 : 502, 'Drive could not send the file (' + r.status + ')');
  const out = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');
  out.set('cache-control', 'private, max-age=3600');
  return new Response(req.method === 'HEAD' ? null : r.body, { status: r.status, headers: out });
}
async function remove(env, id, acct) {
  const r = await gfetch(env, acct, DRIVE + '/files/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw fail(502, 'Drive could not delete it (' + r.status + ')');
  return json({ ok: true });
}
