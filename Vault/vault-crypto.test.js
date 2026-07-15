// Real verification of vault-crypto.js against Node's WebCrypto.
const VC = require('./vault-crypto.js');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } }
async function throws(name, fn, msg) {
  try { await fn(); fail++; console.log('  ✗ FAIL (no throw):', name); }
  catch (e) { const good = !msg || e.message === msg; if (good) { pass++; console.log('  ✓', name, '→', e.message); } else { fail++; console.log('  ✗ FAIL wrong error:', name, 'got', e.message, 'want', msg); } }
}

(async () => {
  console.log('\n── createVault + password unlock ──');
  const { config, dek, recoveryCode } = await VC.createVault('Correct-Horse-Battery-Staple-9!');
  ok('config has master/recovery/verifier', !!(config.master && config.recovery && config.verifier));
  ok('recovery code is grouped base32', /^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/.test(recoveryCode));
  console.log('    recoveryCode =', recoveryCode);
  ok('DEK verifies', await VC.verify(config, dek));

  // Round-trip an item under the DEK.
  const item = { site: 'github.com', user: 'anthony', pass: 'p@ss w/ünïcode 🔐', notes: 'line1\nline2' };
  const blob = await VC.encrypt(dek, item);
  ok('ciphertext is not plaintext', !JSON.stringify(blob).includes('anthony') && !JSON.stringify(blob).includes('github'));
  const back = await VC.decrypt(dek, blob);
  ok('item round-trips exactly (incl. unicode/emoji)', JSON.stringify(back) === JSON.stringify(item));

  console.log('\n── unlock with correct/incorrect password ──');
  const dek2 = await VC.unlockWithPassword(config, 'Correct-Horse-Battery-Staple-9!');
  ok('reopened DEK decrypts the same item', JSON.stringify(await VC.decrypt(dek2, blob)) === JSON.stringify(item));
  await throws('wrong password rejected', () => VC.unlockWithPassword(config, 'wrong'), 'bad-password');

  console.log('\n── recovery key unlock ──');
  const dekR = await VC.unlockWithRecovery(config, recoveryCode);
  ok('recovery unlock decrypts item', JSON.stringify(await VC.decrypt(dekR, blob)) === JSON.stringify(item));
  ok('recovery works with lowercase + spaces instead of dashes',
    await VC.verify(config, await VC.unlockWithRecovery(config, recoveryCode.toLowerCase().replace(/-/g, ' '))));
  await throws('wrong recovery rejected', () => VC.unlockWithRecovery(config, 'AAAA-BBBB-CCCC-DDDD'), 'bad-recovery');

  console.log('\n── biometric slot ──');
  const bio = await VC.addBiometricSlot(config, dek, 'device-abc', { label: 'Windows Hello' });
  ok('biometric slot stored in config', !!bio.config.biometrics['device-abc']);
  ok('device key is 32 bytes b64', VC.b64ToBytes(bio.deviceKeyB64).length === 32);
  const dekB = await VC.unlockWithBiometric(bio.config, 'device-abc', bio.deviceKeyB64);
  ok('biometric unlock decrypts item', JSON.stringify(await VC.decrypt(dekB, blob)) === JSON.stringify(item));
  await throws('wrong device key rejected', () => VC.unlockWithBiometric(bio.config, 'device-abc', VC.bytesToB64(VC.randomBytes(32))), 'bad-biometric');
  const removed = VC.removeBiometricSlot(bio.config, 'device-abc');
  ok('biometric slot removed', !removed.biometrics['device-abc']);

  console.log('\n── change master password (DEK preserved, items untouched) ──');
  const changed = await VC.changeMasterPassword(config, dek, 'New-Master-Password-2!');
  await throws('old password no longer works', () => VC.unlockWithPassword(changed, 'Correct-Horse-Battery-Staple-9!'), 'bad-password');
  const dekN = await VC.unlockWithPassword(changed, 'New-Master-Password-2!');
  ok('new password unlocks the SAME vault (item still decrypts)', JSON.stringify(await VC.decrypt(dekN, blob)) === JSON.stringify(item));
  ok('recovery key still valid after password change', await VC.verify(changed, await VC.unlockWithRecovery(changed, recoveryCode)));

  console.log('\n── rotate recovery key ──');
  const rot = await VC.rotateRecoveryKey(config, dek);
  ok('new recovery code differs', rot.recoveryCode !== recoveryCode);
  ok('new recovery code unlocks', await VC.verify(rot.config, await VC.unlockWithRecovery(rot.config, rot.recoveryCode)));
  await throws('old recovery code no longer works', () => VC.unlockWithRecovery(rot.config, recoveryCode), 'bad-recovery');

  console.log('\n── config is cloud-safe (no plaintext leaks) ──');
  const serialized = JSON.stringify(config);
  ok('serialized config never contains the password', !serialized.includes('Correct-Horse'));
  ok('serialized config never contains item plaintext', !serialized.includes('anthony'));
  ok('config JSON survives a stringify/parse round-trip', await VC.verify(JSON.parse(serialized), await VC.unlockWithPassword(JSON.parse(serialized), 'Correct-Horse-Battery-Staple-9!')));

  console.log('\n── security stamp (re-lock signal) ──');
  ok('new vault has a securityStamp', !!config.securityStamp);
  const changedStamp = await VC.changeMasterPassword(config, dek, 'Another-New-PW-1!');
  ok('changeMasterPassword bumps securityStamp', changedStamp.securityStamp && changedStamp.securityStamp !== config.securityStamp);

  console.log('\n── uniqueness / randomness ──');
  const a = await VC.createVault('same-pw'); const b = await VC.createVault('same-pw');
  ok('two vaults with same password have different salts', a.config.master.salt !== b.config.master.salt);
  ok('same item encrypted twice yields different ciphertext (unique IV)',
    (await VC.encrypt(dek, item)).ct !== (await VC.encrypt(dek, item)).ct);

  console.log(`\n${'═'.repeat(40)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(40)}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
