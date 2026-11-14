// Google Drive for TradeHub Quant (A1-Priv docs/TradeHub/quant/phase-08.md),
// the same wiring as Shruti's worker (A1 Shruti/worker/worker.js: the pattern
// copied, not imported). Scope drive.file: the worker sees only the files it
// made, all under one `TradeHub/` folder in Tony's Drive.
//
// The refresh token lives in D1 `meta` (row `drive:token`), encrypted with
// AES-GCM under the worker secret DRIVE_KEY (32 bytes, base64); never KV,
// never plain. The connect link's state is signed with the same key.
//
//   GET    /drive/health            { configured, connected, email, files }
//   POST   /drive/connect           { url }  Google's consent page
//   GET    /drive/callback          Google returns here (no Orca key: a browser tab)
//   POST   /drive/disconnect        revokes and forgets the token
//   PUT    /drive/f?path=a/b.json   the body becomes TradeHub/a/b.json; identical
//                                   content is not uploaded again (SHA-256), a new
//                                   one overwrites (Drive keeps the old revision)
//   GET    /drive/f/<id>            the file's bytes
//   DELETE /drive/f/<id>            removes it
//   GET    /drive/list?prefix=      what is there (from D1 drive_files, no Drive call)
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (the OneInbox web client),
// DRIVE_KEY.
import { fail, json } from './http.js';

export const ROOT = 'TradeHub';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const DRIVE = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FILE_MAX = 20_000_000;
let access = null;   // { token, exp } for this isolate

const noTable = (e) => /no such table/i.test(String((e && e.message) || e));
const notYet = () => fail(503, 'the Drive table is not there yet (D1 migration 0008_memory.sql)');
async function guarded(p) { try { return await p; } catch (e) { if (noTable(e)) throw notYet(); throw e; } }

export const configured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.DRIVE_KEY);
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const keyBytes = (env) => { const k = unb64(String(env.DRIVE_KEY || '')); if (k.length !== 32) throw fail(503, 'DRIVE_KEY must be 32 bytes, base64'); return k; };
async function aesKey(env) { return crypto.subtle.importKey('raw', keyBytes(env), 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(JSON.stringify(obj))));
  return 'v1.' + b64(iv) + '.' + b64(ct);
}
export async function open(env, s) {
  const [v, iv, ct] = String(s || '').split('.');
  if (v !== 'v1' || !iv || !ct) return null;
  try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct)))); } catch (e) { return null; }
}
async function hmac(env, msg) {
  const k = await crypto.subtle.importKey('raw', keyBytes(env), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode('drive-state.' + msg)))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
}
export async function sha256(buf) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((x) => x.toString(16).padStart(2, '0')).join(''); }
const redirect = (url) => url.origin + '/drive/callback';

async function readToken(env) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'drive:token'").first();
  return row ? open(env, row.v) : null;
}
const putMeta = (env, k, v) => env.DB.prepare('INSERT INTO meta (k, v, at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, at = excluded.at').bind(k, v, Date.now()).run();

/** GET /drive/health */
export async function health(env) {
  const t = configured(env) ? await readToken(env) : null;
  let files = null;
  try { files = (await env.DB.prepare("SELECT COUNT(*) AS n FROM drive_files WHERE kind = 'file'").first()).n; } catch (e) { if (!noTable(e)) throw e; }
  return json({ ok: true, configured: configured(env), connected: !!(t && t.refresh_token), email: (t && t.email) || null, connectedAt: (t && t.at) || null, files });
}
/** POST /drive/connect → { url }: the consent page; the state is signed and lasts 15 minutes. */
export async function connect(env, url) {
  if (!configured(env)) throw fail(503, 'Drive is not set up on quant-api yet (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DRIVE_KEY)');
  const exp = Math.floor(Date.now() / 1000) + 900, state = exp + '.' + (await hmac(env, String(exp)));
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect(url), response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state });
  return json({ ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q });
}
const page = (title, text) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
  + `<body style="font:16px system-ui;background:#16151b;color:#e8e6ef;display:grid;place-items:center;min-height:90vh;margin:0"><div style="max-width:440px;padding:24px"><h1 style="font-size:20px">${title}</h1><p>${text}</p></div>`,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
/** GET /drive/callback: Google's answer; keeps the refresh token, sealed. */
export async function callback(env, url) {
  const [exp, sig] = String(url.searchParams.get('state') || '').split('.');
  if (!configured(env) || !(Number(exp) > Date.now() / 1000) || !sig || sig !== (await hmac(env, exp))) return page('Link expired', 'Start again from TradeHub: Control, then Connect Drive.');
  if (url.searchParams.get('error')) return page('Not connected', 'Google said: ' + String(url.searchParams.get('error')).replace(/[<>&]/g, ''));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect(url), grant_type: 'authorization_code' }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.refresh_token) return page('Not connected', 'Google did not return a refresh token (' + String(t.error || r.status).replace(/[<>&]/g, '') + '). Try again.');
  let email = null;
  try { email = (await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: 'Bearer ' + t.access_token } })).json()).email || null; } catch (e) {}
  await putMeta(env, 'drive:token', await seal(env, { refresh_token: t.refresh_token, email, at: Date.now() }));
  access = { token: t.access_token, exp: Date.now() + ((t.expires_in || 3600) - 60) * 1000 };
  return page('Google Drive connected', 'TradeHub can now keep its archives and backups in ' + (email ? email.replace(/[<>&]/g, '') : 'this Drive') + ', under a folder named TradeHub. You can close this tab.');
}
/** POST /drive/disconnect */
export async function disconnect(env) {
  const t = configured(env) ? await readToken(env) : null;
  if (t && t.refresh_token) await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.refresh_token), { method: 'POST' }).catch(() => {});
  await env.DB.prepare("DELETE FROM meta WHERE k = 'drive:token'").run();
  access = null;
  return json({ ok: true });
}
export function forget() { access = null; }
async function token(env) {
  if (access && access.exp > Date.now()) return access.token;
  const t = await readToken(env);
  if (!t || !t.refresh_token) throw fail(409, 'Google Drive is not connected (Control ▸ Connect Drive)');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw fail(r.status === 400 ? 409 : 502, 'Google refused the Drive token (' + (j.error || r.status) + '); connect again');
  access = { token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 60) * 1000 };
  return access.token;
}
async function gfetch(env, url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('authorization', 'Bearer ' + (await token(env)));
  return fetch(url, { ...init, headers });
}

/** A path under TradeHub/ made safe → ['ledger', '2026-11.jsonl'] (refused when empty or climbing). */
export function cleanPath(p) {
  const parts = String(p || '').replace(/^\/+/, '').replace(/^TradeHub\//, '').split('/').map((s) => s.trim());
  if (!parts.length || parts.some((s) => !s || s === '.' || s === '..' || s.length > 120 || !/^[\w .()+-]+$/.test(s)) || parts.length > 6) throw fail(400, 'path must be like ledger/2026-11.jsonl (letters, digits, . _ - ( ) + and spaces)');
  return parts;
}
/** The folder TradeHub/<parts…>, made when missing; ids kept in drive_files. */
async function folder(env, parts) {
  let parent = 'root', path = '';
  for (const name of [ROOT, ...parts]) {
    path = path ? path + '/' + name : name;
    const row = await env.DB.prepare("SELECT id FROM drive_files WHERE path = ? AND kind = 'folder'").bind(path).first();
    if (row) { parent = row.id; continue; }
    const q = "name = '" + name.replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '" + parent + "' in parents";
    const j = await (await gfetch(env, DRIVE + '/files?fields=files(id)&pageSize=1&q=' + encodeURIComponent(q))).json().catch(() => ({}));
    let id = j.files && j.files[0] && j.files[0].id;
    if (!id) {
      const c = await gfetch(env, DRIVE + '/files?fields=id', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) });
      if (!c.ok) throw fail(502, 'Drive refused to make the folder ' + path + ' (' + c.status + ')');
      id = (await c.json()).id;
    }
    await env.DB.prepare("INSERT INTO drive_files (path, id, kind, at) VALUES (?, ?, 'folder', ?) ON CONFLICT (path) DO UPDATE SET id = excluded.id").bind(path, id, Date.now()).run();
    parent = id;
  }
  return parent;
}
const MIME = { json: 'application/json', jsonl: 'application/x-ndjson', md: 'text/markdown', gz: 'application/gzip', txt: 'text/plain' };

/** Upload `body` (ArrayBuffer) to TradeHub/<path> → { id, path, sha, size, skipped }. Used by the route and the archive. */
export async function putFile(env, path, body, mimeIn) {
  const parts = cleanPath(path), full = [ROOT, ...parts].join('/'), name = parts[parts.length - 1];
  if (body.byteLength > FILE_MAX) throw fail(413, 'a file may be at most ' + FILE_MAX + ' bytes');
  const sha = await sha256(body), mime = mimeIn || MIME[name.split('.').pop()] || 'application/octet-stream';
  const have = await guarded(env.DB.prepare("SELECT id, sha FROM drive_files WHERE path = ? AND kind = 'file'").bind(full).first());
  if (have && have.sha === sha) return { ok: true, id: have.id, path: full, sha, size: body.byteLength, skipped: true };
  let id;
  if (have) {
    // Same path, new content: a new revision of the same file.
    const r = await gfetch(env, UPLOAD + '/files/' + encodeURIComponent(have.id) + '?uploadType=media&fields=id', { method: 'PATCH', headers: { 'content-type': mime }, body });
    if (r.status === 404) return putFile(env, path, body, mimeIn, await env.DB.prepare('DELETE FROM drive_files WHERE path = ?').bind(full).run());
    if (!r.ok) throw fail(502, 'Drive refused the update (' + r.status + ')');
    id = have.id;
  } else {
    const parent = await folder(env, parts.slice(0, -1));
    const start = await gfetch(env, UPLOAD + '/files?uploadType=resumable&fields=id', {
      method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime },
      body: JSON.stringify({ name, parents: [parent], appProperties: { tradehub: '1' } }),
    });
    const loc = start.headers.get('location');
    if (!start.ok || !loc) throw fail(502, 'Drive refused the upload (' + start.status + ')');
    const put = await fetch(loc, { method: 'PUT', headers: { 'content-type': mime }, body });
    const j = await put.json().catch(() => ({}));
    if (!put.ok || !j.id) throw fail(502, 'Drive upload failed (' + put.status + ')');
    id = j.id;
  }
  await env.DB.prepare("INSERT INTO drive_files (path, id, kind, sha, size, mime, at) VALUES (?, ?, 'file', ?, ?, ?, ?) "
    + 'ON CONFLICT (path) DO UPDATE SET id = excluded.id, sha = excluded.sha, size = excluded.size, mime = excluded.mime, at = excluded.at').bind(full, id, sha, body.byteLength, mime, Date.now()).run();
  return { ok: true, id, path: full, sha, size: body.byteLength, skipped: false };
}
/** PUT /drive/f?path= */
export async function putRoute(env, req, url) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > FILE_MAX) throw fail(413, 'a file may be at most ' + FILE_MAX + ' bytes');
  const body = await req.arrayBuffer();
  return json(await putFile(env, url.searchParams.get('path'), body, (req.headers.get('content-type') || '').split(';')[0] || null));
}
/** GET /drive/f/<id> */
export async function getFile(env, id) {
  const known = await guarded(env.DB.prepare("SELECT path, mime FROM drive_files WHERE id = ? AND kind = 'file'").bind(id).first());
  if (!known) throw fail(404, 'no such TradeHub file');
  const r = await gfetch(env, DRIVE + '/files/' + encodeURIComponent(id) + '?alt=media');
  if (!r.ok) throw fail(r.status === 404 ? 404 : 502, 'Drive could not send the file (' + r.status + ')');
  return new Response(r.body, { status: 200, headers: { 'content-type': known.mime || 'application/octet-stream', 'cache-control': 'no-store', 'x-path': known.path } });
}
/** DELETE /drive/f/<id> */
export async function deleteFile(env, id) {
  const known = await guarded(env.DB.prepare("SELECT path FROM drive_files WHERE id = ? AND kind = 'file'").bind(id).first());
  if (!known) throw fail(404, 'no such TradeHub file');
  const r = await gfetch(env, DRIVE + '/files/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw fail(502, 'Drive could not delete it (' + r.status + ')');
  await env.DB.prepare('DELETE FROM drive_files WHERE path = ?').bind(known.path).run();
  return json({ ok: true, path: known.path });
}
/** GET /drive/list?prefix=backup/ → files under TradeHub/<prefix>, newest first. */
export async function list(env, url) {
  const prefix = ROOT + '/' + String(url.searchParams.get('prefix') || '').replace(/^\/+/, '').replace(/^TradeHub\//, '');
  const rows = (await guarded(env.DB.prepare("SELECT path, id, sha, size, mime, at FROM drive_files WHERE kind = 'file' AND substr(path, 1, ?) = ? ORDER BY path DESC LIMIT 1000").bind(prefix.length, prefix).all())).results || [];
  return json({ ok: true, files: rows });
}
