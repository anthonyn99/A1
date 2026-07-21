// Real verification of vault-session.js with a fake biometric authenticator.
require('./vault-crypto.js');
require('./vault-store.js');
const VaultSession = require('./vault-session.js');
const VaultStore = require('./vault-store.js');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } }
async function throws(name, fn, msg) {
  try { await fn(); fail++; console.log('  ✗ FAIL (no throw):', name); }
  catch (e) { const good = !msg || e.message === msg; good ? (pass++, console.log('  ✓', name, '→', e.message)) : (fail++, console.log('  ✗ wrong error:', name, 'got', e.message, 'want', msg)); }
}

// Fake WebAuthn authenticator we can make succeed / fail / cancel.
function fakeBio() {
  const creds = new Set();
  const state = { mode: 'ok', avail: true };
  return {
    _state: state,
    async available() { return state.avail; },
    isRegistered(app, id) { return creds.has(app + ':' + id); },
    async register(app, id) { if (state.mode === 'cancel') return { ok: false, error: 'cancelled' }; creds.add(app + ':' + id); return { ok: true }; },
    async authenticate(app, id) {
      if (state.mode === 'cancel') return { ok: false, error: 'cancelled' };
      if (state.mode === 'fail') return { ok: false, error: 'NotAllowedError' };
      return creds.has(app + ':' + id) ? { ok: true } : { ok: false, error: 'notregistered' };
    },
    unregister(app, id) { creds.delete(app + ':' + id); },
    label() { return 'Windows Hello'; },
  };
}

(async () => {
  console.log('\n── first-run setup ──');
  const backend = VaultStore.memoryBackend();
  const bio = fakeBio();
  const store = VaultSession.memoryDeviceStore();
  let s = new VaultSession({ backend, bio, deviceStore: store, appId: 'vault', autoLockMs: 0 });
  ok('no vault initially', !(await s.hasVault()));
  const { recoveryCode } = await s.setup('MasterPW-123!');
  ok('setup returns recovery code', /^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/.test(recoveryCode));
  ok('session unlocked after setup', s.isUnlocked());
  ok('now has vault', await s.hasVault());
  await throws('cannot set up twice', () => s.setup('x'), 'vault-exists');

  // Save an item through the session's store.
  await s.getStore().load();
  await s.getStore().save({ kind: 'login', title: 'Reddit', username: 'me', password: 'p' });
  ok('item saved via session store', s.getStore().all().length === 1);

  console.log('\n── lock / unlock with password ──');
  s.lock();
  ok('locked clears DEK', !s.isUnlocked());
  await throws('getStore throws while locked', () => { s.getStore(); }, 'locked');
  await throws('wrong password rejected', () => s.unlockWithPassword('nope'), 'bad-password');
  await s.unlockWithPassword('MasterPW-123!');
  ok('correct password unlocks', s.isUnlocked());
  await s.getStore().load();
  ok('items survive lock/unlock', s.getStore().all().length === 1);

  console.log('\n── recovery unlock (fresh session, cold config from backend) ──');
  let s2 = new VaultSession({ backend, bio: fakeBio(), deviceStore: VaultSession.memoryDeviceStore(), autoLockMs: 0 });
  await s2.unlockWithRecovery(recoveryCode);
  ok('recovery unlocks a cold session', s2.isUnlocked());
  await throws('bad recovery rejected', () => (new VaultSession({ backend, autoLockMs: 0 })).unlockWithRecovery('AAAA-BBBB'), 'bad-recovery');

  console.log('\n── biometric enable / unlock / disable ──');
  ok('biometric supported (fake avail)', await s.biometricSupported());
  ok('not enabled yet', !(await s.biometricEnabled()));
  await s.enableBiometric('Windows Hello');
  ok('biometric now enabled', await s.biometricEnabled());
  ok('device key persisted locally', !!store.get('vault.deviceKey'));
  // Cold session on the SAME device (shares deviceStore + registered cred) unlocks via biometric.
  let sBio = new VaultSession({ backend, bio, deviceStore: store, appId: 'vault', autoLockMs: 0 });
  await sBio.unlockWithBiometric();
  ok('biometric unlock works on same device', sBio.isUnlocked());

  // A different device (no device key, no registered cred) cannot use biometrics.
  let sOther = new VaultSession({ backend, bio: fakeBio(), deviceStore: VaultSession.memoryDeviceStore(), autoLockMs: 0 });
  await throws('other device has no biometric slot', () => sOther.unlockWithBiometric(), 'no-biometric-slot');

  // Biometric prompt failure/cancel is surfaced, not swallowed.
  bio._state.mode = 'fail';
  let sFail = new VaultSession({ backend, bio, deviceStore: store, appId: 'vault', autoLockMs: 0 });
  await throws('failed biometric prompt rejected', () => sFail.unlockWithBiometric(), 'bio-failed');
  bio._state.mode = 'ok';

  await s.disableBiometric();
  ok('biometric disabled removes slot + key', !(await s.biometricEnabled()) && !store.get('vault.deviceKey'));

  console.log('\n── change master password (old still verifies, recovery unaffected) ──');
  await throws('change with wrong old password rejected', () => s.changeMasterPassword('wrong', 'X'), 'bad-password');
  await s.changeMasterPassword('MasterPW-123!', 'BrandNew-PW-9!');
  let sNew = new VaultSession({ backend, autoLockMs: 0 });
  await throws('old master password no longer works', () => sNew.unlockWithPassword('MasterPW-123!'), 'bad-password');
  await sNew.unlockWithPassword('BrandNew-PW-9!');
  ok('new master password unlocks same vault', sNew.isUnlocked());
  let sRec = new VaultSession({ backend, autoLockMs: 0 });
  await sRec.unlockWithRecovery(recoveryCode);
  ok('original recovery key still valid after password change', sRec.isUnlocked());

  console.log('\n── security stamp: master-password change re-locks other sessions ──');
  {
    const be2 = VaultStore.memoryBackend();
    const A = new VaultSession({ backend: be2, autoLockMs: 0 });
    const { } = await A.setup('stamp-pw');
    const cfgA = A.getConfig();
    // Device B unlocks with the same vault.
    const B = new VaultSession({ backend: be2, autoLockMs: 0 });
    await B.unlockWithPassword('stamp-pw');
    ok('B unlocked', B.isUnlocked());
    // A changes the master password (bumps securityStamp).
    await A.changeMasterPassword('stamp-pw', 'stamp-pw-2');
    const newCfg = A.getConfig();
    ok('stamp changed after password change', newCfg.securityStamp !== cfgA.securityStamp);
    // B sees the new config and must re-lock.
    ok('B.enforceStamp locks B', B.enforceStamp(newCfg) === true && !B.isUnlocked());
    // Same stamp is a no-op.
    await B.unlockWithPassword('stamp-pw-2');
    ok('enforceStamp no-op on same stamp', B.enforceStamp(newCfg) === false && B.isUnlocked());
  }

  console.log('\n── rotate recovery ──');
  const rot = await sNew.rotateRecovery();
  ok('rotation returns a new, different code', rot.recoveryCode && rot.recoveryCode !== recoveryCode);
  let sRot = new VaultSession({ backend, autoLockMs: 0 });
  await sRot.unlockWithRecovery(rot.recoveryCode);
  ok('new recovery code unlocks', sRot.isUnlocked());

  console.log('\n── reset master password with the recovery key (forgot-password path) ──');
  {
    const be3 = VaultStore.memoryBackend();
    const A = new VaultSession({ backend: be3, autoLockMs: 0 });
    const { recoveryCode: rc } = await A.setup('forgotten-pw', 'my usual one');
    await A.getStore().save({ kind: 'login', title: 'github', password: 'hunter2' });
    const stampBefore = A.getConfig().securityStamp;

    // A locked-out device: fresh session, no password, only the recovery key.
    const L = new VaultSession({ backend: be3, autoLockMs: 0 });
    ok('hint readable while still locked', (await L.getHint()) === 'my usual one');
    await throws('wrong recovery key cannot reset', () => L.resetMasterPasswordWithRecovery('ZZZZ-ZZZZ', 'attacker-pw-1'), 'bad-recovery');
    ok('failed reset leaves the session locked', !L.isUnlocked());
    ok('failed reset did not change the password', await (new VaultSession({ backend: be3, autoLockMs: 0 })).verifyPassword('forgotten-pw'));

    await L.resetMasterPasswordWithRecovery(rc, 'brand-new-pw-2', 'the new clue');
    ok('reset leaves the session unlocked', L.isUnlocked());
    const recovered = await L.getStore().load();
    ok('vault contents survive the reset', recovered.length === 1 && recovered[0].password === 'hunter2');
    ok('hint updated by the reset', (await L.getHint()) === 'the new clue');
    ok('reset bumps securityStamp', L.getConfig().securityStamp !== stampBefore);
    ok('other sessions re-lock after the reset', A.enforceStamp(L.getConfig()) === true);

    const P = new VaultSession({ backend: be3, autoLockMs: 0 });
    await throws('forgotten password no longer works', () => P.unlockWithPassword('forgotten-pw'), 'bad-password');
    await P.unlockWithPassword('brand-new-pw-2');
    ok('new password unlocks from a fresh session', P.isUnlocked());
    const R = new VaultSession({ backend: be3, autoLockMs: 0 });
    await R.unlockWithRecovery(rc);
    ok('same recovery key still works after the reset', R.isUnlocked());

    // Hint plumbing on the ordinary change-password path.
    await P.changeMasterPassword('brand-new-pw-2', 'third-pw-3');
    ok('hint preserved when change omits it', (await P.getHint()) === 'the new clue');
    await P.changeMasterPassword('third-pw-3', 'fourth-pw-4', '');
    ok('hint cleared with an empty string', (await P.getHint()) === '');
  }

  console.log('\n── auto-lock ──');
  let locked = false;
  let sAL = new VaultSession({ backend, autoLockMs: 30, onLock: () => { locked = true; } });
  await sAL.unlockWithPassword('BrandNew-PW-9!');
  ok('unlocked before timer', sAL.isUnlocked());
  await new Promise((r) => setTimeout(r, 60));
  ok('auto-locked after inactivity', !sAL.isUnlocked() && locked);

  console.log(`\n${'═'.repeat(40)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(40)}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
