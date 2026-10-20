// shruti-drive: Shruti's media store (podcast and video audio, narrations,
// transcripts, imported originals) in Tony's Google Drive.
//
// The Google refresh token lives here, in KV, never in a browser: Tony connects
// once (one consent click) and every device and both profiles stream through
// this worker. Scope is drive.file, so the worker can only see files it made
// itself, all under one "Shruti" folder: Shruti/<book>/<chapter>/<name>.
//
// Who may call it: anyone holding a working Orca key (Shruti's own trust root;
// each person pastes theirs in Settings). The key is checked against Orca's
// GET /v1/models and a pass is cached for ten minutes (Cache API, no KV
// writes). An <audio> element cannot send a header, so playback uses signed
// links instead: POST /sign returns /f/<id>?e=<expiry>&s=<hmac> for six hours.
//
// Routes
//   GET    /health                 { ok, configured, connected, email }
//   POST   /connect     (key)      { url } Google's consent page
//   GET    /callback               Google returns here; stores the refresh token
//   POST   /disconnect  (key)      revoke and forget
//   PUT    /f?book&chapter&name&owner   (key)  body = the file  -> { id, size, mime, store, owner }
//   POST   /sign        (key)      { ids: [...] } -> { urls: { id: url } }
//   GET    /f/<id>      (key or signed)  streams the file; Range passes through, so audio can seek
//   DELETE /f/<id>      (key)
//
// Secrets (wrangler secret put): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SIGN_KEY.
// Optional var ALLOWED_KEYS: comma-separated SHA-256 hex of the Orca keys that may
// call it; empty = any working Orca key.

const ORCA = 'https://orca.vedapatel05.workers.dev/v1';
const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const ORIGINS = [/^https:\/\/anthonyn99\.github\.io$/, /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/];
const SIGN_TTL = 6 * 3600;
const AUTH_TTL = 600;
const TOKEN_KEY = 'google';

let access = null;          // { token, exp } for this isolate
const folders = new Map();  // path -> Drive folder id, for this isolate

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
  if (p === '/' || p === '/health') {
    const t = await readToken(env);
    return json({ ok: true, configured: configured(env), connected: !!t, email: (t && t.email) || null, signing: !!env.SIGN_KEY });
  }
  if (p === '/callback' && m === 'GET') return callback(env, url);
  if (p === '/connect' && m === 'POST') { await requireKey(req, env, ctx); return connect(env, url); }
  if (p === '/disconnect' && m === 'POST') { await requireKey(req, env, ctx); return disconnect(env); }
  if (p === '/f' && m === 'PUT') { await requireKey(req, env, ctx); return upload(req, env, url); }
  if (p === '/sign' && m === 'POST') { await requireKey(req, env, ctx); return sign(req, env, url); }
  const f = /^\/f\/([\w-]{10,200})$/.exec(p);
  if (f && (m === 'GET' || m === 'HEAD')) {
    if (!(await validSig(env, f[1], url))) await requireKey(req, env, ctx);
    return stream(req, env, f[1]);
  }
  if (f && m === 'DELETE') { await requireKey(req, env, ctx); return remove(env, f[1]); }
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
async function validSig(env, id, url) {
  const e = Number(url.searchParams.get('e')), s = url.searchParams.get('s') || '';
  if (!env.SIGN_KEY || !s || !(e > Date.now() / 1000)) return false;
  const want = await hmac(env, id + '.' + e);
  if (want.length !== s.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ s.charCodeAt(i);
  return diff === 0;
}
async function sign(req, env, url) {
  if (!env.SIGN_KEY) throw fail(503, 'SIGN_KEY is not set');
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => /^[\w-]{10,200}$/.test(x)).slice(0, 100) : [];
  const e = Math.floor(Date.now() / 1000) + SIGN_TTL;
  const urls = {};
  for (const id of ids) urls[id] = url.origin + '/f/' + id + '?e=' + e + '&s=' + (await hmac(env, id + '.' + e));
  return json({ ok: true, expires: e, urls });
}

/* ── Google OAuth ─────────────────────────────────────────────────────────── */
function configured(env) { return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET); }
function redirectUri(url) { return url.origin + '/callback'; }
async function readToken(env) {
  if (!env.DRIVE) return null;
  try { return await env.DRIVE.get(TOKEN_KEY, 'json'); } catch (e) { return null; }
}
async function connect(env, url) {
  if (!configured(env)) throw fail(503, 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set');
  if (!env.SIGN_KEY) throw fail(503, 'SIGN_KEY is not set');
  const exp = Math.floor(Date.now() / 1000) + 900;
  const state = exp + '.' + (await hmac(env, 'connect.' + exp));
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(url), response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return json({ ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q });
}
async function callback(env, url) {
  const [exp, sig] = String(url.searchParams.get('state') || '').split('.');
  if (!env.SIGN_KEY || !(Number(exp) > Date.now() / 1000) || sig !== (await hmac(env, 'connect.' + exp))) {
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
  await env.DRIVE.put(TOKEN_KEY, JSON.stringify({ refresh_token: t.refresh_token, email, at: Date.now() }));
  access = { token: t.access_token, exp: Date.now() + ((t.expires_in || 3600) - 60) * 1000 };
  folders.clear();
  return page('Google Drive connected', 'Shruti can now keep its audio and video in ' + (email || 'your Drive') + '. You can close this tab.');
}
async function disconnect(env) {
  const t = await readToken(env);
  if (t && t.refresh_token) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.refresh_token), { method: 'POST' }).catch(() => {});
  if (env.DRIVE) await env.DRIVE.delete(TOKEN_KEY);
  access = null; folders.clear();
  return json({ ok: true });
}
async function accessToken(env) {
  if (access && access.exp > Date.now()) return access.token;
  const t = await readToken(env);
  if (!t || !t.refresh_token) throw fail(409, 'Google Drive is not connected');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw fail(r.status === 400 ? 409 : 502, 'Google refused the Drive token (' + (j.error || r.status) + '); connect again');
  access = { token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 60) * 1000 };
  return access.token;
}

/* ── Drive ────────────────────────────────────────────────────────────────── */
const DRIVE = 'https://www.googleapis.com/drive/v3';
const seg = (s, fallback) => String(s || fallback).replace(/[^\w .()-]/g, '_').slice(0, 120) || fallback;
async function gfetch(env, url, init = {}) {
  const tok = await accessToken(env);
  const headers = new Headers(init.headers || {});
  headers.set('authorization', 'Bearer ' + tok);
  return fetch(url, { ...init, headers });
}
async function folder(env, parts) {
  let parent = 'root', path = '';
  for (const name of parts) {
    path += '/' + name;
    if (folders.has(path)) { parent = folders.get(path); continue; }
    const q = "name = '" + name.replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '" + parent + "' in parents";
    const r = await gfetch(env, DRIVE + '/files?fields=files(id)&pageSize=1&q=' + encodeURIComponent(q));
    const j = await r.json();
    let id = j.files && j.files[0] && j.files[0].id;
    if (!id) {
      const c = await gfetch(env, DRIVE + '/files?fields=id', {
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
async function upload(req, env, url) {
  const book = seg(url.searchParams.get('book'), 'misc');
  const chapter = seg(url.searchParams.get('chapter'), 'book');
  const name = seg(url.searchParams.get('name'), 'file');
  const owner = /^(tony|veda)$/.test(url.searchParams.get('owner') || '') ? url.searchParams.get('owner') : 'tony';
  const mime = (req.headers.get('content-type') || 'application/octet-stream').split(';')[0];
  const parent = await folder(env, ['Shruti', book, chapter]);
  const start = await gfetch(env, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,mimeType', {
    method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime },
    body: JSON.stringify({ name, parents: [parent], appProperties: { shruti: '1', owner } }),
  });
  const loc = start.headers.get('location');
  if (!start.ok || !loc) throw fail(502, 'Drive refused the upload (' + start.status + ')');
  const body = await req.arrayBuffer();
  const put = await fetch(loc, { method: 'PUT', headers: { 'content-type': mime }, body });
  const j = await put.json().catch(() => ({}));
  if (!put.ok || !j.id) throw fail(502, 'Drive upload failed (' + put.status + ')');
  return json({ ok: true, id: j.id, size: Number(j.size || body.byteLength), mime, store: 'gdrive', owner, path: ['Shruti', book, chapter, name].join('/') });
}
async function stream(req, env, id) {
  const headers = {};
  const range = req.headers.get('range');
  if (range) headers.range = range;
  const r = await gfetch(env, DRIVE + '/files/' + encodeURIComponent(id) + '?alt=media', { method: 'GET', headers });
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
async function remove(env, id) {
  const r = await gfetch(env, DRIVE + '/files/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw fail(502, 'Drive could not delete it (' + r.status + ')');
  return json({ ok: true });
}
