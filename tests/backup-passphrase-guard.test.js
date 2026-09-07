/* A1Backup: a wrong passphrase must not be accepted silently.

   WHY THIS FILE EXISTS
   unlock() used to take ANY passphrase. It derived a key, STORED it, then
   "proved" encryption worked by round-tripping a probe it had just created --
   which tests WebCrypto, not the passphrase. Entering a different one therefore
   succeeded, reported success, and split the backup history in two: everything
   after used a new key, everything before opened only with the old one, and
   nothing said so. It would surface at restore time, which is the one moment it
   must not.

   Not hypothetical: iOS evicts script-writable storage after ~7 days without a
   visit and the passphrase lives in localStorage, so an unopened phone comes
   back asking for it with the original possibly forgotten.

   The guard has to hold two lines at once, and they pull in opposite directions:
     - REFUSE a passphrase that does not open existing backups (fail closed), and
     - never refuse just because it could not CHECK (fail open) -- a dropped
       request must not lock someone out of their own backups.
   Conflating "nothing to check against" with "checked and failed" breaks one or
   the other, so both are asserted here.

   Run: node tests/backup-passphrase-guard.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'backup.js'), 'utf8');

let pass = 0; const failures = [];
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { failures.push(name + (detail ? '\n      ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}
function section(s) { console.log('\n' + s); }

/* ── The real crypto, lifted out of backup.js ───────────────────────────────
   Re-implementing PBKDF2+AES-GCM in the test would prove the test works, not
   the shipped code. These are the shipped algorithm and parameters. */
const ITER = Number((SRC.match(/PBKDF2_ITER:\s*(\d+)/) || [])[1]);
const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKeyWith(pass, saltB64, iter) {
  const base = await webcrypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function makeEnvelope(plain, pass, saltB64) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyWith(pass, saltB64, ITER);
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  return { alg: 'AES-256-GCM', ct: b64(new Uint8Array(ct)), iv: b64(iv), kdf: { salt: saltB64, iter: ITER } };
}
async function opens(env, pass) {
  try {
    const key = await deriveKeyWith(pass, env.kdf.salt, env.kdf.iter);
    await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.ct));
    return true;
  } catch { return false; }
}

/* Mirrors verifyPassphrase()'s decision table. The shipped function is welded to
   IndexedDB and fetch; what has to be right is the LOGIC, and specifically the
   none/unavailable/mismatch distinction. Kept in step with the source by the
   structural assertions in the last section. */
async function verify(candidate, { local = [], remote = null }) {
  let checked = 0, reached = false;
  for (const env of local.slice(0, 3)) {
    if (!env || !env.ct) continue;
    reached = true; checked++;
    if (await opens(env, candidate)) return { state: 'match', checked, source: 'this device' };
  }
  if (remote !== null) {                      // null = worker unreachable
    for (const [device, env] of Object.entries(remote)) {
      if (!env || !env.ct) continue;
      reached = true; checked++;
      if (await opens(env, candidate)) return { state: 'match', checked, source: device };
    }
  }
  if (!reached) return { state: 'none', checked: 0 };
  return { state: 'mismatch', checked };
}

const SALT_A = b64(webcrypto.getRandomValues(new Uint8Array(16)));
const SALT_B = b64(webcrypto.getRandomValues(new Uint8Array(16)));
const TONY = 'tony-correct-horse';
const VEDA = 'veda-different-passphrase';
const WRONG = 'not-the-passphrase';

async function main() {

  section('A wrong passphrase is REFUSED when there is something to check');
  {
    const local = [await makeEnvelope('{"d":1}', TONY, SALT_A)];
    t('the correct passphrase is accepted', (await verify(TONY, { local })).state === 'match');
    const bad = await verify(WRONG, { local });
    t('a wrong passphrase is a mismatch, not a pass', bad.state === 'mismatch', JSON.stringify(bad));
    t('and it says how much it checked', bad.checked > 0, 'checked=' + bad.checked);
  }

  section('It still works after local storage is wiped (the iOS case)');
  {
    // localStorage AND IndexedDB evicted: nothing local survives. The
    // off-device sink is the only thing left that can answer, which is exactly
    // the scenario the guard exists for.
    const remote = { 'iphone-z6wyb1': await makeEnvelope('{"d":1}', VEDA, SALT_B) };
    t('the correct passphrase still verifies remotely',
      (await verify(VEDA, { local: [], remote })).state === 'match');
    t('a wrong one is still refused with no local data',
      (await verify(WRONG, { local: [], remote })).state === 'mismatch');
  }

  section('Tony and Veda may hold DIFFERENT passphrases');
  {
    // Snapshots are keyed by device, not profile, so a device must accept a
    // passphrase that opens ANY stored envelope. Requiring it to open ALL of
    // them would lock out whichever profile checked second.
    const remote = {
      'pc-1cw70x': await makeEnvelope('{"d":"tony"}', TONY, SALT_A),
      'iphone-z6wyb1': await makeEnvelope('{"d":"veda"}', VEDA, SALT_B),
    };
    const a = await verify(TONY, { local: [], remote });
    const b = await verify(VEDA, { local: [], remote });
    t("Tony's passphrase is accepted", a.state === 'match', a.source);
    t("Veda's passphrase is accepted", b.state === 'match', b.source);
    t('a third, wrong passphrase is refused', (await verify(WRONG, { local: [], remote })).state === 'mismatch');
  }

  section('It never refuses when it could not CHECK');
  {
    // The distinction that matters. Refusing here would lock someone out of
    // their own backups over a dropped request.
    t('first run ever (nothing anywhere) is allowed',
      (await verify(TONY, { local: [], remote: {} })).state === 'none');
    t('worker unreachable + no local data is allowed, not refused',
      (await verify(TONY, { local: [], remote: null })).state === 'none');
    t('empty/corrupt envelopes do not count as a failed check',
      (await verify(TONY, { local: [{}, { ct: '' }], remote: null })).state === 'none');
  }

  section('One corrupt object does not condemn a correct passphrase');
  {
    const local = [{ alg: 'AES-256-GCM', ct: 'bm90LXJlYWw=', iv: b64(new Uint8Array(12)), kdf: { salt: SALT_A, iter: ITER } },
                   await makeEnvelope('{"d":1}', TONY, SALT_A)];
    t('it keeps looking past an undecryptable one',
      (await verify(TONY, { local })).state === 'match');
  }

  /* ── The shipped code, structurally ─────────────────────────────────────── */
  section('The guard is wired into unlock(), not merely written');

  const unlockFn = SRC.slice(SRC.indexOf('async function unlock(pass, opts)'));
  const unlockBody = unlockFn.slice(0, unlockFn.indexOf('\n  }'));

  t('unlock() verifies before storing anything',
    unlockBody.indexOf('verifyPassphrase') < unlockBody.indexOf('unlockUnchecked'),
    'Storing first and checking after is how a wrong passphrase gets a foothold — ' +
    'every write between the two uses the wrong key.');
  t('a mismatch throws rather than returning falsy',
    /throw err;/.test(unlockBody) && /code = 'passphrase-mismatch'/.test(unlockBody),
    'A falsy return would be ignored by any caller that does not check it.');
  t('nothing is persisted on the refusal path',
    !/lsSet\(A1B\.PASS_KEY/.test(unlockBody),
    'The device must stay locked, not half-switched.');
  t('the override has to be asked for explicitly',
    /if \(!opts\.allowNewPassphrase\)/.test(unlockBody));

  t('the candidate is tested WITHOUT being stored first',
    /async function decryptEnvWith\(env, pass\)/.test(SRC) &&
    /decryptEnvWith\(env, pass\)/.test(SRC));
  t('verification reads the off-device sink, not just local state',
    /verifyPassphrase[\s\S]{0,2200}WORKER \+ '\/index'/.test(SRC),
    'Local data is gone in the exact case this guard is for.');
  t('"could not check" is distinguished from "checked and failed"',
    /if \(!reached\) return \{ state: VERIFY_STATE\.NONE/.test(SRC),
    'Collapsing these either locks people out on a network blip or lets a wrong ' +
    'passphrase through — opposite failures, one line apart.');

  const setup = SRC.slice(SRC.indexOf('async function promptSetup'));
  t('the setup dialog names the real problem',
    /passphrase-mismatch/.test(setup) && /Wrong passphrase/.test(setup),
    'Reporting it as a generic failure would be the same shrug this replaces.');
  t('and the override states what it costs',
    /can only ever be opened with the OLD passphrase/.test(setup) && /danger: true/.test(setup));

  console.log('\n' + '─'.repeat(64));
  if (failures.length) {
    console.log(failures.length + ' FAILED:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  if (!pass) { console.log('NO CHECKS RAN — the harness is broken, not passing.'); process.exit(1); }
  console.log('All ' + pass + ' passphrase-guard checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
