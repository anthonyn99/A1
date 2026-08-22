// Routing + auth gate tests for Warden's three Workers.
//
// These cannot be deployed from Tony's machine (they need Veda's Cloudflare
// account and a Firebase service account), so what is checked here is exactly
// the part that does not need either: which paths exist, which key is demanded,
// and that a wrong or missing key is refused BEFORE any Firestore call is made.
//
// The Firestore/KV layers are stubbed. A test that reaches the stub proves the
// gate opened; a test that never reaches it proves the gate held.
//
//   node Warden/workers/routing.test.mjs

import { generateKeyPairSync } from 'node:crypto';

import links from './warden-links/worker.js';
import pw from './warden-pw-sync/worker.js';
import files from './warden-files/worker.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
}
async function status(worker, url, opts, env) {
  const res = await worker.fetch(new Request(url, opts), env);
  return { code: res.status, body: await res.text().catch(() => '') };
}

const KEY = 'wd-test-key';

// Firestore is reached over global fetch; stub it so an opened gate is visible
// without a network call.
let firestoreHits = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  firestoreHits.push(String(u));
  // Enough shape for the token exchange and the document read to not throw.
  return new Response(JSON.stringify({ access_token: 'stub', expires_in: 3600, fields: {} }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
};

// A REAL RSA key, not a dummy: the Worker signs a service-account JWT with
// crypto.subtle before it calls Firestore, so a fake PEM fails at importKey and
// the request dies at 500 having never exercised the path under test. Generating
// a throwaway keypair lets the authorised path run all the way to the fetch.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const ENV = {
  WARDEN_KEY: KEY,
  FIREBASE_PROJECT_ID: 'her-project',
  FIREBASE_CLIENT_EMAIL: 'sa@her-project.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: PEM,
};

console.log('\nwarden-links');
{
  firestoreHits = [];
  ok('unknown path is 404', (await status(links, 'https://w/nope', {}, ENV)).code === 404);
  ok('OPTIONS preflight is 204', (await status(links, 'https://w/links', { method: 'OPTIONS' }, ENV)).code === 204);

  const noKey = await status(links, 'https://w/links', {}, ENV);
  ok('missing key is 401', noKey.code === 401, 'got ' + noKey.code);

  const badKey = await status(links, 'https://w/links', { headers: { 'X-Warden-Key': 'wrong' } }, ENV);
  ok('wrong key is 401', badKey.code === 401, 'got ' + badKey.code);

  ok('no Firestore call made while unauthorised', firestoreHits.length === 0,
     firestoreHits.length + ' call(s) leaked');

  const noSecret = await status(links, 'https://w/links', { headers: { 'X-Warden-Key': KEY } }, { ...ENV, WARDEN_KEY: '' });
  ok('unset WARDEN_KEY refuses everything', noSecret.code === 401, 'got ' + noSecret.code);

  firestoreHits = [];
  await status(links, 'https://w/links', { headers: { 'X-Warden-Key': KEY } }, ENV);
  ok('correct key reaches Firestore', firestoreHits.length > 0);
  ok('targets dashboards/warden_links', firestoreHits.some(u => u.includes('dashboards/warden_links')),
     firestoreHits.join(' '));
  ok('never targets Tony\'s documents',
     !firestoreHits.some(u => /dashboards\/(keychain|veda_links|vault_pw)/.test(u)));

  firestoreHits = [];
  await status(links, 'https://w/', { headers: { 'X-Warden-Key': KEY } }, ENV);
  ok('bare "/" aliases to the links document', firestoreHits.some(u => u.includes('dashboards/warden_links')));
}

console.log('\nwarden-pw-sync');
{
  firestoreHits = [];
  ok('old /vault path is gone (404)', (await status(pw, 'https://w/vault', { headers: { 'X-Warden-Key': KEY } }, ENV)).code === 404);
  ok('missing key is 401', (await status(pw, 'https://w/warden', {}, ENV)).code === 401);
  ok('wrong key is 401', (await status(pw, 'https://w/warden', { headers: { 'X-Warden-Key': 'wrong' } }, ENV)).code === 401);
  ok('no Firestore call made while unauthorised', firestoreHits.length === 0, firestoreHits.length + ' leaked');

  firestoreHits = [];
  await status(pw, 'https://w/warden', { headers: { 'X-Warden-Key': KEY } }, ENV);
  ok('correct key reaches Firestore', firestoreHits.length > 0);
  ok('targets dashboards/warden_pw', firestoreHits.some(u => u.includes('dashboards/warden_pw')), firestoreHits.join(' '));
  ok('never targets dashboards/vault_pw', !firestoreHits.some(u => u.includes('dashboards/vault_pw')));
}

console.log('\nwarden-files');
{
  const KV = {
    _d: new Map(),
    async get(k, t) { const v = this._d.get(k); return v === undefined ? null : (t === 'arrayBuffer' ? v : v); },
    async getWithMetadata(k) { return { value: this._d.get(k) ?? null, metadata: null }; },
    async put(k, v) { this._d.set(k, v); },
    async delete(k) { this._d.delete(k); },
  };
  const FENV = { WARDEN: KV };

  const h = await status(files, 'https://f/health', {}, FENV);
  ok('/health is 200 and needs no key', h.code === 200, 'got ' + h.code);
  ok('/health names warden-files', h.body.includes('warden-files'), h.body.slice(0, 60));
  ok('/health reports the namespace bound', /"warden":true/.test(h.body.replace(/\s/g, '')), h.body.slice(0, 80));

  ok('OPTIONS preflight ok', [200, 204].includes((await status(files, 'https://f/warden/f/a', { method: 'OPTIONS' }, FENV)).code));
  ok('unknown bucket is 404', (await status(files, 'https://f/keychain/f/abc', {}, FENV)).code === 404);
  ok('old links bucket is gone', (await status(files, 'https://f/links/f/abc', {}, FENV)).code === 404);

  const put = await status(files, 'https://f/warden/f/testkey', { method: 'PUT', body: 'ciphertext-bytes' }, FENV);
  ok('PUT into the warden bucket succeeds', put.code === 200, 'got ' + put.code + ' ' + put.body.slice(0, 60));
  const get = await status(files, 'https://f/warden/f/testkey', {}, FENV);
  ok('GET returns what was stored', get.code === 200 && get.body.includes('ciphertext'), 'got ' + get.code);

  ok('empty PUT is rejected', (await status(files, 'https://f/warden/f/k2', { method: 'PUT', body: '' }, FENV)).code === 400);
  ok('unsafe key is rejected', (await status(files, 'https://f/warden/f/' + encodeURIComponent('../etc/passwd'), {}, FENV)).code === 400);
  ok('missing namespace binding is a 500, not a crash',
     (await status(files, 'https://f/warden/f/k', {}, {})).code === 500);
}

globalThis.fetch = realFetch;
console.log('\n' + '='.repeat(50));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
