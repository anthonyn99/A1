// Shruti's Drive worker (Shruti/worker/worker.js), offline: Orca and Google are
// faked, KV is a Map. Checks who may call it, the signed playback links, the
// connect/callback state, uploads into Shruti/<book>/<chapter>/, and that a
// Range request reaches Drive and its 206 comes back (audio must seek).
//
// Run: node Shruti/tests/worker.test.js
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

const GOOD = 'orca_sk_good', BAD = 'orca_sk_bad';
const calls = [];
const store = new Map();
const KV = {
  async get(k, t) { const v = store.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
};
const cacheMap = new Map();
global.caches = { default: {
  async match(r) { return cacheMap.get(r.url) || null; },
  async put(r, res) { cacheMap.set(r.url, res); },
} };
let folderSeq = 0;
global.fetch = async (url, init = {}) => {
  url = String(url);
  const h = new Headers(init.headers || {});
  calls.push({ url, method: init.method || 'GET', headers: h });
  if (url.startsWith('https://orca.vedapatel05.workers.dev/v1/models')) {
    return new Response('{"data":[]}', { status: h.get('authorization') === 'Bearer ' + GOOD ? 200 : 401 });
  }
  if (url === 'https://oauth2.googleapis.com/token') {
    const b = new URLSearchParams(init.body);
    if (b.get('grant_type') === 'authorization_code') return b.get('code') === 'cv' ? Response.json({ access_token: 'atv', refresh_token: 'rtv', expires_in: 3600 }) : Response.json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 });
    return Response.json({ access_token: b.get('refresh_token') === 'rtv' ? 'atv2' : 'at2', expires_in: 3600 });
  }
  if (url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) return Response.json({ email: h.get('authorization') === 'Bearer atv' ? 'veda@example.com' : 'tony@example.com' });
  if (url.startsWith('https://www.googleapis.com/drive/v3/files?fields=files')) return Response.json({ files: [] });
  if (url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id')) return Response.json({ id: 'folder' + (++folderSeq) });
  if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) {
    return new Response(null, { status: 200, headers: { location: 'https://upload.example/session1' } });
  }
  if (url === 'https://upload.example/session1') return Response.json({ id: 'file_abcdefghij', size: '5', mimeType: 'audio/mpeg' });
  if (/\/drive\/v3\/files\/file_abcdefghij\?alt=media/.test(url)) {
    if (h.get('range')) return new Response('bc', { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 1-2/5', 'content-length': '2' } });
    return new Response('abcde', { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '5' } });
  }
  return new Response('unexpected ' + url, { status: 599 });
};

(async () => {
  const W = (await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'worker.js')).href)).default;
  const env = { DRIVE: KV, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', SIGN_KEY: 'k'.repeat(32) };
  const BASE = 'https://shruti-drive.av1-2.workers.dev';
  const call = (p, init = {}, e = env) => W.fetch(new Request(BASE + p, init), e, { waitUntil() {} });
  const auth = (k) => ({ authorization: 'Bearer ' + k });

  console.log('\nHealth and CORS');
  let r = await call('/health', { headers: { origin: 'https://anthonyn99.github.io' } });
  let j = await r.json();
  ok('health says configured, not yet connected', j.ok && j.configured && !j.connected && j.signing, JSON.stringify(j));
  ok('the Pages origin is allowed', r.headers.get('access-control-allow-origin') === 'https://anthonyn99.github.io');
  r = await call('/health', { headers: { origin: 'https://evil.example' } });
  ok('another origin is not echoed', r.headers.get('access-control-allow-origin') === 'https://anthonyn99.github.io');
  r = await call('/f', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:8080' } });
  ok('a preflight answers 204 with Range allowed', r.status === 204 && /range/.test(r.headers.get('access-control-allow-headers')));

  console.log('\nWho may call');
  r = await call('/connect', { method: 'POST' });
  ok('no key: 401', r.status === 401);
  r = await call('/connect', { method: 'POST', headers: auth(BAD) });
  ok('a key Orca rejects: 401', r.status === 401);
  const orcaBefore = calls.filter((c) => c.url.includes('/v1/models')).length;
  r = await call('/connect', { method: 'POST', headers: auth(GOOD) });
  j = await r.json();
  ok('a working key gets Google\'s consent url', r.status === 200 && /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/.test(j.url), JSON.stringify(j));
  const consent = new URL(j.url);
  ok('consent asks offline access to drive.file only', consent.searchParams.get('access_type') === 'offline' && /drive\.file/.test(consent.searchParams.get('scope')) && !/auth\/drive(?:\s|$)/.test(consent.searchParams.get('scope')));
  ok('the redirect is this worker\'s /callback', consent.searchParams.get('redirect_uri') === BASE + '/callback');
  await call('/connect', { method: 'POST', headers: auth(GOOD) });
  ok('a passed key is cached (Orca asked once)', calls.filter((c) => c.url.includes('/v1/models')).length === orcaBefore + 1);
  const hash = require('crypto').createHash('sha256').update(GOOD).digest('hex');
  r = await call('/connect', { method: 'POST', headers: auth(GOOD) }, { ...env, ALLOWED_KEYS: 'deadbeef' });
  ok('ALLOWED_KEYS refuses a key not on it', r.status === 403);
  r = await call('/connect', { method: 'POST', headers: auth(GOOD) }, { ...env, ALLOWED_KEYS: 'deadbeef,' + hash });
  ok('…and lets one on it through', r.status === 200);

  console.log('\nConnect');
  r = await call('/callback?code=c1&state=1.forged');
  ok('a forged state is refused, nothing stored', /Link expired/.test(await r.text()) && !store.has('google'));
  r = await call('/f/file_abcdefghij', { headers: auth(GOOD) });
  ok('before connecting, a file read says not connected (409)', r.status === 409);
  r = await call('/callback?code=c1&state=' + encodeURIComponent(consent.searchParams.get('state')));
  ok('the real state connects', /Google Drive connected/.test(await r.text()));
  ok('the refresh token and email are kept in KV', JSON.parse(store.get('google') || '{}').refresh_token === 'rt1' && JSON.parse(store.get('google')).email === 'tony@example.com');
  j = await (await call('/health')).json();
  ok('health now says connected, with the account', j.connected && j.email === 'tony@example.com');

  console.log('\nUpload');
  r = await call('/f?book=gita&chapter=ch02&name=podcast.mp3&owner=veda', { method: 'PUT', headers: { ...auth(GOOD), 'content-type': 'audio/mpeg' }, body: 'abcde' });
  j = await r.json();
  ok('an upload returns the Drive id, store and owner', j.ok && j.id === 'file_abcdefghij' && j.store === 'gdrive' && j.owner === 'veda' && j.path === 'Shruti/gita/ch02/podcast.mp3', JSON.stringify(j));
  const made = calls.filter((c) => c.url.includes('/drive/v3/files?fields=id'));
  ok('it made the Shruti, book and chapter folders', made.length === 3);
  r = await call('/f?book=gita&chapter=ch02&name=x.mp3', { method: 'PUT', body: 'x' });
  ok('an upload without a key is refused', r.status === 401);

  console.log('\nPlayback');
  r = await call('/f/file_abcdefghij');
  ok('a bare file url is refused', r.status === 401);
  r = await call('/sign', { method: 'POST', headers: { ...auth(GOOD), 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['file_abcdefghij', '../bad'] }) });
  j = await r.json();
  const signed = j.urls && j.urls.file_abcdefghij;
  ok('sign returns a link per valid id only', !!signed && Object.keys(j.urls).length === 1, JSON.stringify(j));
  const u = new URL(signed);
  r = await call(u.pathname + u.search, { headers: { range: 'bytes=1-2' } });
  ok('a signed link streams, and Range comes back as 206', r.status === 206 && (await r.text()) === 'bc' && r.headers.get('content-range') === 'bytes 1-2/5');
  ok('the Range header reached Drive', calls.some((c) => /alt=media/.test(c.url) && c.headers.get('range') === 'bytes=1-2'));
  r = await call(u.pathname + u.search.replace(/s=[^&]+/, 's=AAAA'));
  ok('a tampered signature is refused', r.status === 401);
  r = await call(u.pathname + '?e=' + (Math.floor(Date.now() / 1000) - 5) + '&s=' + u.searchParams.get('s'));
  ok('an expired link is refused', r.status === 401);
  r = await call('/f/file_abcdefghij', { headers: auth(GOOD) });
  ok('a key works without a signature', r.status === 200 && (await r.text()) === 'abcde');

  console.log('\nDisconnect');
  r = await call('/disconnect', { method: 'POST', headers: auth(GOOD) });
  ok('disconnect forgets the token', r.status === 200 && !store.has('google'));
  ok('…and revokes it at Google', calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke?token=rt1')));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
