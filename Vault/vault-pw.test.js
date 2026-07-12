// Verifies the extension password core: fetch → unlock → decrypt → domain match,
// plus the 30-min idle SESSION save/restore (via a stubbed chrome.storage.session).
const g = globalThis;
require('./vault-crypto.js');

// stub chrome.storage.session (in-memory)
const store = {};
g.chrome = {
  storage: {
    session: {
      get: (k, cb) => cb({ [k]: store[k] }),
      set: (o, cb) => { Object.assign(store, o); cb && cb(); },
      remove: (k, cb) => { delete store[k]; cb && cb(); },
    },
    onChanged: { addListener() {} },
  },
};

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL', n)); };

(async () => {
  const VC = g.VaultCrypto;
  const { config, dek } = await VC.createVault('master-pw');
  const items = {};
  items.i1 = { id: 'i1', kind: 'login', enc: await VC.encrypt(dek, { title: 'GitHub', url: 'github.com', username: 'me', password: 'p1' }), deleted: false };
  items.i2 = { id: 'i2', kind: 'login', enc: await VC.encrypt(dek, { title: 'Google', url: 'accounts.google.com', email: 'g@x.com', password: 'p2' }), deleted: false };
  items.i3 = { id: 'i3', kind: 'login', enc: await VC.encrypt(dek, { title: 'Gone' }), deleted: true };
  items.i4 = { id: 'i4', kind: 'sensitive', enc: await VC.encrypt(dek, { title: 'Note' }), deleted: false };
  g.fetch = async () => ({ ok: true, json: async () => ({ config, items, savedAt: 1 }) });

  const corePath = require.resolve('./vault-pw-core.js');
  delete require.cache[corePath];
  const VP = require('./vault-pw-core.js');

  ok('hasVault true', await VP.hasVault());
  try { await VP.unlock('wrong'); ok('wrong pw rejected', false); } catch (e) { ok('wrong pw rejected', e.message === 'bad-password'); }
  await VP.unlock('master-pw');
  ok('unlocked', VP.isUnlocked());
  const creds = await VP.credentials();
  ok('decrypts 2 logins (skips deleted + sensitive)', creds.length === 2);
  ok('fields decrypt', creds.find((c) => c.title === 'GitHub').password === 'p1');
  ok('matchDomain finds github', VP.matchDomain(creds, 'github.com').length === 1);
  ok('matchDomain no match', VP.matchDomain(creds, 'example.com').length === 0);

  // session was saved on unlock
  ok('session saved to storage', !!store.vpwSession && !!store.vpwSession.dek);

  // simulate a fresh popup open: reload the module (dek=null), restore from session
  delete require.cache[corePath];
  const VP2 = require('./vault-pw-core.js');
  ok('fresh module starts locked', !VP2.isUnlocked());
  const resumed = await VP2.restoreSession();
  ok('restoreSession resumes unlock', resumed && VP2.isUnlocked());
  ok('resumed session can decrypt', (await VP2.credentials()).length === 2);

  // expired session is rejected
  store.vpwSession.at = Date.now() - (VP2.IDLE_MS + 1000);
  delete require.cache[corePath];
  const VP3 = require('./vault-pw-core.js');
  ok('expired session does not resume', !(await VP3.restoreSession()) && !VP3.isUnlocked());
  ok('expired session cleared from storage', !store.vpwSession);

  // security stamp: if the master password changed elsewhere (new stamp in the
  // fetched config), a resumed session must NOT unlock.
  delete require.cache[corePath];
  const VP4 = require('./vault-pw-core.js');
  // put a valid session back, but the served config now has a different stamp
  store.vpwSession = { dek: store.vpwSession ? store.vpwSession.dek : null, at: Date.now(), stamp: 'OLD-STAMP' };
  if (!store.vpwSession.dek) { // rebuild a dek if the expired test cleared it
    const raw = await crypto.subtle.exportKey('raw', dek);
    store.vpwSession = { dek: VC.bytesToB64(new Uint8Array(raw)), at: Date.now(), stamp: 'OLD-STAMP' };
  }
  ok('stamp mismatch blocks resume', !(await VP4.restoreSession()) && !VP4.isUnlocked());
  ok('mismatched session cleared', !store.vpwSession);

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
