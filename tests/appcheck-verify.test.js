/* The App Check verifier, tested against a REAL Google-signed token and against
   forgeries. A verifier tested only on tokens it invented proves nothing, so the
   positive case uses a token actually minted by Firebase for this project. */
'use strict';
const fs = require('fs');
const { webcrypto } = require('crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'workers', '_shared', 'appcheck.js'), 'utf8');
const load = () => new Function(SRC + `
  return { verify: verifyAppCheckToken, guard: requireAppCheck,
           setJwks: (k) => { _acJwks = k; _acJwksAt = Date.now(); } };`)();

// A real Google-signed token cannot be committed (public repo, and it expires in
// an hour). Supply one via APPCHECK_TOKEN to exercise the positive path; without
// it the forgery tests still run, and those are the ones that catch a weakened
// check. tools/mint-appcheck-token.js prints a fresh one.
const REAL = (process.env.APPCHECK_TOKEN || '').trim();
const HAVE_REAL = REAL.split('.').length === 3;
const b64u = (b) => Buffer.from(b).toString('base64url');
const results = [];
const check = (n, ok, d) => { results.push(ok); console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '  [' + d + ']' : '')); };

(async () => {
  console.log('\nAgainst the real Google-signed token' + (HAVE_REAL ? '' : '  (skipped - set APPCHECK_TOKEN to run)'));
  if (HAVE_REAL) {
    const M = load();
    check('a genuine App Check token is accepted', await M.verify(REAL) === true);

    const [h, p, s] = REAL.split('.');
    check('a tampered payload is rejected', await M.verify(`${h}.${b64u(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: 'evil' }))}.${s}`) === false);
    check('a tampered signature is rejected', await M.verify(`${h}.${p}.${s.slice(0, -4)}AAAA`) === false);
    check('a truncated token is rejected', await M.verify(`${h}.${p}`) === false);
    check('an empty token is rejected', await M.verify('') === false);
    check('a null token is rejected', await M.verify(null) === false);
    check('random text is rejected', await M.verify('not-a-jwt-at-all') === false);
  }

  console.log('\nAgainst forgeries signed with an attacker-controlled key');
  {
    // The attacker generates their own RSA key and publishes it. This is the
    // attack that a signature-only check would let through, so the audience and
    // issuer checks are what has to catch it.
    const kp = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const KID = 'attacker-kid';
    const sign = async (payload, header) => {
      const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID, ...(header || {}) }));
      const p = b64u(JSON.stringify(payload));
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, Buffer.from(`${h}.${p}`));
      return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
    };
    const now = Math.floor(Date.now() / 1000);
    const good = { aud: ['projects/982539604706'], iss: 'https://firebaseappcheck.googleapis.com/982539604706', exp: now + 3600, iat: now };
    const mk = () => { const M = load(); M.setJwks([{ kid: KID, kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256' }]); return M; };

    check('a perfectly-formed token signed with the WRONG key is rejected',
      await load().verify(await sign(good)) === false, 'real JWKS has no such kid');

    // Now the worst case: the attacker also controls the key set. Every
    // remaining check has to stand on its own.
    check('...but if their key were trusted, the shape alone would pass',
      await mk().verify(await sign(good)) === true, 'baseline for the checks below');
    check('wrong audience is rejected',
      await mk().verify(await sign({ ...good, aud: ['projects/999999999999'] })) === false);
    check('missing audience is rejected',
      await mk().verify(await sign({ ...good, aud: undefined })) === false);
    check('wrong issuer is rejected',
      await mk().verify(await sign({ ...good, iss: 'https://evil.example/982539604706' })) === false);
    check('an expired token is rejected',
      await mk().verify(await sign({ ...good, exp: now - 10 })) === false);
    check('a token with no exp is rejected',
      await mk().verify(await sign({ ...good, exp: undefined })) === false);
    check('a token issued far in the future is rejected',
      await mk().verify(await sign({ ...good, iat: now + 9999 })) === false);
    check('alg "none" is rejected',
      await mk().verify(await sign(good, { alg: 'none' })) === false);
    check('an HMAC alg is rejected',
      await mk().verify(await sign(good, { alg: 'HS256' })) === false);
    check('a missing kid is rejected',
      await mk().verify(await sign(good, { kid: undefined })) === false);
  }

  console.log('\nThe request guard');
  {
    const M = load();
    const req = (h) => ({ headers: { get: (k) => (h || {})[k] || null } });
    if (HAVE_REAL) check('a request with a genuine token passes',
      await M.guard(req({ 'X-Firebase-AppCheck': REAL }), {}) === null);
    const denied = await M.guard(req({}), { 'Access-Control-Allow-Origin': '*' });
    check('a request with no token gets 401', denied && denied.status === 401);
    check('and the refusal is not cached',
      denied.headers.get('Cache-Control') === 'private, no-store');
    check('and CORS headers survive so the browser can read the error',
      denied.headers.get('Access-Control-Allow-Origin') === '*');
  }

  console.log('\n' + results.filter(Boolean).length + '/' + results.length + ' checks passed');
  // Set exitCode rather than calling process.exit(): the 'wrong key' check above
  // performs a REAL fetch of Google's JWKS, and on Node 24 (Windows) tearing the
  // process down while undici's socket is still closing trips a libuv assertion
  // (UV_HANDLE_CLOSING in win/async.c) and aborts with exit 127 — turning a fully
  // passing run into a hard failure. Letting the loop drain naturally exits clean.
  process.exitCode = results.every(Boolean) ? 0 : 1;
})();
