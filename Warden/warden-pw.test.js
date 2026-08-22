// Verifies the extension warden core: fetch → unlock → decrypt → domain match,
// the 30-min idle SESSION save/restore (via a stubbed chrome.storage.session),
// and the payments layer + its CVV auth-freshness gate.
const g = globalThis;
require('./warden-crypto.js');
require('./warden-pay.js');

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
  const VC = g.WardenCrypto;
  const { config, dek } = await VC.createWarden('master-pw');
  const items = {};
  items.i1 = { id: 'i1', kind: 'login', enc: await VC.encrypt(dek, { title: 'GitHub', url: 'github.com', username: 'me', password: 'p1' }), deleted: false };
  items.i2 = { id: 'i2', kind: 'login', enc: await VC.encrypt(dek, { title: 'Google', url: 'accounts.google.com', email: 'g@x.com', password: 'p2' }), deleted: false };
  items.i3 = { id: 'i3', kind: 'login', enc: await VC.encrypt(dek, { title: 'Gone' }), deleted: true };
  items.i4 = { id: 'i4', kind: 'sensitive', enc: await VC.encrypt(dek, { title: 'Note' }), deleted: false };
  const VPay = g.WardenPay;
  const card = VPay.normalize({ nickname: 'Chase', cardholder: 'A N', number: '4111111111111111', expMonth: '4', expYear: '2099', cvv: '737' });
  const card2 = VPay.normalize({ nickname: 'Amex', number: '378282246310005', expMonth: '11', expYear: '2099', cvv: '1234', favorite: true });
  items.p1 = { id: 'p1', kind: 'payment', enc: await VC.encrypt(dek, card), deleted: false };
  items.p2 = { id: 'p2', kind: 'payment', enc: await VC.encrypt(dek, card2), deleted: false };
  items.p3 = { id: 'p3', kind: 'payment', enc: await VC.encrypt(dek, VPay.normalize({ nickname: 'Old' })), deleted: true };
  g.fetch = async () => ({ ok: true, json: async () => ({ config, items, savedAt: 1 }) });

  const corePath = require.resolve('./warden-pw-core.js');
  delete require.cache[corePath];
  const VP = require('./warden-pw-core.js');

  ok('hasWarden true', await VP.hasWarden());
  try { await VP.unlock('wrong'); ok('wrong pw rejected', false); } catch (e) { ok('wrong pw rejected', e.message === 'bad-password'); }
  await VP.unlock('master-pw');
  ok('unlocked', VP.isUnlocked());
  const creds = await VP.credentials();
  ok('decrypts 2 logins (skips deleted + sensitive)', creds.length === 2);
  ok('fields decrypt', creds.find((c) => c.title === 'GitHub').password === 'p1');
  ok('matchDomain finds github', VP.matchDomain(creds, 'github.com').length === 1);
  ok('matchDomain no match', VP.matchDomain(creds, 'example.com').length === 0);

  // ── payments share the same unlock, DEK and session ──
  const cards = await VP.payments();
  ok('decrypts 2 payments (skips deleted)', cards.length === 2);
  ok('payments sorted with favourite first', cards[0].nickname === 'Amex');

  // The extension must MIRROR the manual order set in the PWA — same
  // WardenPay.sortCards() call, so the list and the autofill dropdown both follow.
  items.p1 = { id: 'p1', kind: 'payment', enc: await VC.encrypt(dek, Object.assign({}, card, { order: 0 })), deleted: false };
  items.p2 = { id: 'p2', kind: 'payment', enc: await VC.encrypt(dek, Object.assign({}, card2, { order: 1 })), deleted: false };
  await VP.fetchWarden();
  const ordered = await VP.payments();
  ok('manual order overrides the favourite pin in the extension', ordered[0].nickname === 'Chase' && ordered[1].nickname === 'Amex');
  ok('summaries come back in that same order', (await VP.paymentSummaries()).map((s) => s.title).join(',') === 'Chase,Amex');
  ok('payment fields decrypt', cards.find((c) => c.nickname === 'Chase').number === '4111111111111111');
  ok('credentials() unaffected by payments', (await VP.credentials()).length === 2);
  ok('paymentById returns one card', (await VP.paymentById('p1')).nickname === 'Chase');
  ok('paymentById ignores tombstones', (await VP.paymentById('p3')) === null);
  ok('paymentById ignores non-payment ids', (await VP.paymentById('i1')) === null);

  // Summaries are what page-side contexts get — they must carry no secrets.
  const sums = await VP.paymentSummaries();
  const sumStr = JSON.stringify(sums);
  ok('summaries expose no full PAN', sumStr.indexOf('4111111111111111') < 0 && sumStr.indexOf('378282246310005') < 0);
  ok('summaries expose no CVV', sumStr.indexOf('737') < 0 && sumStr.indexOf('1234') < 0);
  ok('summaries still identify the card', sums.some((s) => s.last4 === '1111' && s.networkLabel === 'Visa'));

  // ── CVV auth freshness ──
  ok('fresh right after unlock', VP.authFresh());
  ok('authAge is small after unlock', VP.authAge() < 5000);
  try { await VP.reauth('wrong'); ok('reauth rejects a wrong password', false); } catch (e) { ok('reauth rejects a wrong password', e.message === 'bad-password'); }
  ok('still unlocked after a failed reauth', VP.isUnlocked());
  ok('reauth accepts the right password', await VP.reauth('master-pw'));

  // session was saved on unlock
  ok('session saved to storage', !!store.vpwSession && !!store.vpwSession.dek);
  ok('session records the real unlock moment', !!store.vpwSession.unlockedAt);

  // Activity must extend the idle window WITHOUT extending the auth window or
  // dropping the security stamp (both would silently weaken the warden).
  const beforeTouch = { unlockedAt: store.vpwSession.unlockedAt, stamp: store.vpwSession.stamp };
  await VP.touchSession();
  ok('touch preserves unlockedAt', store.vpwSession.unlockedAt === beforeTouch.unlockedAt);
  ok('touch preserves the security stamp', store.vpwSession.stamp === beforeTouch.stamp && !!store.vpwSession.stamp);

  // simulate a fresh popup open: reload the module (dek=null), restore from session
  delete require.cache[corePath];
  const VP2 = require('./warden-pw-core.js');
  ok('fresh module starts locked', !VP2.isUnlocked());
  const resumed = await VP2.restoreSession();
  ok('restoreSession resumes unlock', resumed && VP2.isUnlocked());
  ok('resumed session can decrypt', (await VP2.credentials()).length === 2);
  ok('resumed session can decrypt payments', (await VP2.payments()).length === 2);

  // A resume is not a re-authentication: an OLD unlock stays old, so the CVV
  // gate closes on a session that was merely carried forward.
  store.vpwSession.unlockedAt = Date.now() - (VP2.CVV_FRESH_MS + 60000);
  delete require.cache[corePath];
  const VPstale = require('./warden-pw-core.js');
  await VPstale.restoreSession();
  ok('stale unlock still opens the warden', VPstale.isUnlocked() && (await VPstale.payments()).length === 2);
  ok('stale unlock fails the CVV freshness gate', !VPstale.authFresh());
  await VPstale.reauth('master-pw');
  ok('reauth reopens the CVV window', VPstale.authFresh());

  // expired session is rejected
  store.vpwSession.at = Date.now() - (VP2.IDLE_MS + 1000);
  delete require.cache[corePath];
  const VP3 = require('./warden-pw-core.js');
  ok('expired session does not resume', !(await VP3.restoreSession()) && !VP3.isUnlocked());
  ok('expired session cleared from storage', !store.vpwSession);

  // security stamp: if the master password changed elsewhere (new stamp in the
  // fetched config), a resumed session must NOT unlock.
  delete require.cache[corePath];
  const VP4 = require('./warden-pw-core.js');
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
