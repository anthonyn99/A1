// A biometric only opens a lock while the password it was enrolled under is
// still the password. Before this, anyone who learned a program's password ONCE
// could enrol their own fingerprint on their own device and keep walking in
// however often the password changed afterwards.
//
// Drives the real single-app locks (TradeHub, Solace, RiftIQ, Vault) headless,
// with a fake platform authenticator (navigator.credentials) and the lock
// service mocked, and checks on each:
//
//   1. a credential enrolled under the current password version offers
//      "Unlock with ..." and unlocks
//   2. two quick opens of the unlock screen (the gate, then a lock snapshot)
//      draw ONE "Unlock with ..." and ONE "Use password instead", not two of
//      each -- the doubled buttons seen on the phone
//   3. a password change on another device (a newer lock version arriving)
//      locks this device, removes the biometric button, says why, and deletes
//      the stale credential
//   4. a credential from before the binding existed counts by its enrolment
//      time: older than the password -> stale, newer -> still good
//   5. the new password unlocks and offers to enrol the biometric again
//
// Run: node tests/live/lock-bio-binding.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io';

const PAGES = [
  { file: 'tradehub.html', ns: 'tradehub', id: 'tony_tradehub_standalone' },
  { file: 'solace.html', ns: 'solacelock', id: 'tony_solace_standalone' },
  { file: 'riftiq.html', ns: 'warroomlock', id: 'tony_warroom_standalone' },
  { file: 'vault.html', ns: 'vaultlock', id: 'tony_vault_standalone' },
];

// A platform authenticator that always says yes, and counts how often it was asked.
const FAKE_AUTH = `
  (function(){
    if (window.top !== window) return;
    window.__bioGets = 0; window.__bioCreates = 0;
    var P = function(){};
    P.isUserVerifyingPlatformAuthenticatorAvailable = function(){ return Promise.resolve(true); };
    try { Object.defineProperty(window, 'PublicKeyCredential', { value: P, configurable: true, writable: true }); } catch (e) {}
    var cred = { rawId: new Uint8Array([1,2,3,4]).buffer, getClientExtensionResults: function(){ return {}; } };
    var creds = {
      create: function(){ window.__bioCreates++; return Promise.resolve(cred); },
      get: function(){ window.__bioGets++; return Promise.resolve(cred); }
    };
    try { Object.defineProperty(navigator, 'credentials', { value: creds, configurable: true }); } catch (e) {}
  })();`;

const T1 = 1700000000000;          // the password the credential was enrolled under
const T2 = T1 + 86400000;          // a password change, a day later

(async () => {
  const mock = {
    patterns: ['https://taskhub-reminders.av1.workers.dev/*'],
    handle: (req) => ({ status: 200, json: { ok: true } }),   // every password is right
  };
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_AUTH });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  for (const P of PAGES) {
    console.log('\n' + P.file);
    const credKey = 'bio_cred_' + P.ns + '_' + P.id;
    const seed = async (lockV, rec) => {
      await c.send('Page.navigate', { url: ORIGIN + '/A1/' + P.file + '?blank' }); await sleep(600);
      await evalJs(c, `
        localStorage.clear(); sessionStorage.clear();
        document.cookie.split(';').forEach(function(k){ document.cookie = k.split('=')[0].trim() + '=; path=/; max-age=0'; });
        localStorage.setItem('al_locks', JSON.stringify({ ${JSON.stringify(P.id)}: { locked: true, v: ${lockV} } }));
        ${rec ? `localStorage.setItem(${JSON.stringify(credKey)}, ${JSON.stringify(JSON.stringify(rec))});` : ''}
        return 1;`);
      await c.send('Page.navigate', { url: ORIGIN + '/A1/' + P.file }); await sleep(2500);
    };
    const ui = () => evalJs(c, `
      var box = document.getElementById('applock-bio'), ov = document.getElementById('applock-overlay');
      var btns = box ? [...box.querySelectorAll('button')].map(function(b){ return b.textContent.trim(); }) : [];
      return JSON.stringify({
        overlay: !!ov && getComputedStyle(ov).display !== 'none',
        unlockBtns: btns.filter(function(t){ return /^Unlock with/.test(t); }).length,
        pwLinks: btns.filter(function(t){ return t === 'Use password instead'; }).length,
        err: (document.getElementById('applock-err') || {}).textContent || '',
        cred: localStorage.getItem(${JSON.stringify(credKey)}),
        pwShown: (document.getElementById('applock-pw') || {}).style ? document.getElementById('applock-pw').style.display !== 'none' : null
      });`).then(JSON.parse);
    const openUnlockTwice = () => evalJs(c, `
      var l = {}; l[${JSON.stringify(P.id)}] = { v: ${T1} };
      window._alApplyRemoteLocks(l); window._alApplyRemoteLocks(l); return 1;`);

    // 1 + 2: enrolled under the current password
    await seed(T1, { id: 'AQIDBA', created: T1 + 5, v: T1, label: 'x' });
    await openUnlockTwice(); await sleep(600);
    let u = await ui();
    ok('locked on load', u.overlay, JSON.stringify(u));
    ok('ONE "Unlock with" button after two quick opens', u.unlockBtns === 1, JSON.stringify(u));
    ok('ONE "Use password instead" after two quick opens', u.pwLinks === 1, JSON.stringify(u));
    await evalJs(c, `[...document.querySelectorAll('#applock-bio button')].find(function(b){ return /^Unlock with/.test(b.textContent.trim()); }).click(); return 1;`);
    await sleep(700);
    u = await ui();
    ok('a current credential unlocks', !u.overlay && (await evalJs(c, 'window.__bioGets')) === 1, JSON.stringify(u));

    // 3: the password changes on another device while this one is open
    await evalJs(c, `var l = {}; l[${JSON.stringify(P.id)}] = { v: ${T2} }; window._alApplyRemoteLocks(l); return 1;`);
    await sleep(700);
    u = await ui();
    ok('a password change locks this device again', u.overlay, JSON.stringify(u));
    ok('and offers no biometric unlock', u.unlockBtns === 0 && u.pwLinks === 0, JSON.stringify(u));
    ok('and says the password changed', /password changed/i.test(u.err), u.err);
    ok('and the password box is showing', u.pwShown === true, JSON.stringify(u));
    ok('and the stale credential is deleted', u.cred === null, u.cred);

    // 4: credentials from before the binding (no `v`) judged by enrolment time
    await seed(T2, { id: 'AQIDBA', created: T1 + 5, label: 'legacy' });
    u = await ui();
    ok('legacy credential older than the password: stale', u.unlockBtns === 0 && u.cred === null, JSON.stringify(u));
    await seed(T1, { id: 'AQIDBA', created: T1 + 5, label: 'legacy' });
    u = await ui();
    ok('legacy credential newer than the password: still offered', u.unlockBtns === 1 && u.cred !== null, JSON.stringify(u));

    // 5: the new password unlocks, then offers to enrol again
    await seed(T2, { id: 'AQIDBA', created: T1 + 5, v: T1, label: 'x' });
    await evalJs(c, `
      var pw = document.getElementById('applock-pw'); pw.style.display = ''; pw.value = 'new-password';
      document.getElementById('applock-submit').click(); return 1;`);
    await sleep(1500);
    u = await ui();
    const offer = await evalJs(c, `return (document.body.innerText.match(/Register [^\\n]* to unlock/) || [''])[0];`);
    ok('the new password unlocks', !u.overlay, JSON.stringify(u));
    ok('and offers to register the biometric again', /Register/.test(offer), offer);
  }

  // ── The other lock screens: Index (program/profile lock), Shield, MyList ──
  const errors = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception
      ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
  });
  await c.send('Runtime.enable');
  const OTHERS = [
    { file: 'index.html', key: 'bio_cred_applock_tony_tradehub', box: 'applock-bio', err: 'applock-err',
      setV: (v) => `window._alApplyRemoteLocks({ tony_tradehub: { locked: true, v: ${v} } });`,
      open: `window.alGate('tony_tradehub', function(){});` },
    { file: 'shield.html', key: 'bio_cred_shield_shield_x', box: 'applock-bio', err: 'applock-err',
      setV: (v) => `window._alApplyRemoteLocks({ shield_x: { locked: true, v: ${v} } });`,
      open: `window.AL.gate('shield_x', function(){});` },
    { file: 'mylist.html', key: 'bio_cred_mylist_tony', box: 'lock-bio', err: 'lock-err',
      setV: (v) => `state.locks.tony = true; state.lockV.tony = ${v};`,
      open: `showLock('tony', 'unlock');` },
  ];
  for (const O of OTHERS) {
    console.log('\n' + O.file + ' (lock screen)');
    errors.length = 0;
    await c.send('Page.navigate', { url: ORIGIN + '/A1/' + O.file + '?blank' }); await sleep(600);
    await evalJs(c, `localStorage.clear(); sessionStorage.clear();
      localStorage.setItem(${JSON.stringify(O.key)}, JSON.stringify({ id: 'AQIDBA', created: ${T1 + 5}, v: ${T1}, label: 'x' })); return 1;`);
    await c.send('Page.navigate', { url: ORIGIN + '/A1/' + O.file }); await sleep(O.file === 'index.html' ? 6000 : 2500);
    const count = () => evalJs(c, `
      var box = document.getElementById(${JSON.stringify(O.box)});
      return JSON.stringify({ n: box ? [...box.querySelectorAll('button')].filter(function(b){ return /^Unlock with/.test(b.textContent.trim()); }).length : -1,
        err: (document.getElementById(${JSON.stringify(O.err)}) || {}).textContent || '',
        cred: localStorage.getItem(${JSON.stringify(O.key)}) });`).then(JSON.parse);
    await evalJs(c, O.setV(T1) + O.open + O.open + 'return 1;');
    await sleep(700);
    let r = await count();
    ok('current credential: ONE "Unlock with" after two quick opens', r.n === 1, JSON.stringify(r));
    await evalJs(c, O.setV(T2) + O.open + 'return 1;');
    await sleep(700);
    r = await count();
    ok('after a password change: no biometric button', r.n === 0, JSON.stringify(r));
    ok('says the password changed', /password changed/i.test(r.err), r.err);
    ok('stale credential deleted', r.cred === null, r.cred);
    ok('no page errors', errors.length === 0, errors.join(' | '));
  }

  // ── The Bio helper itself, on every page that carries one ──
  for (const f of ['index.html', 'insight.html', 'magi.html', 'mylist.html', 'oneinbox.html', 'riftiq.html', 'shield.html', 'solace.html', 'tradehub.html', 'vault.html']) {
    await c.send('Page.navigate', { url: ORIGIN + '/A1/' + f + '?blank' }); await sleep(f === 'index.html' ? 3000 : 1200);
    const r = JSON.parse(await evalJs(c, `
      localStorage.removeItem('bio_cred_t_x');
      var reg = await window.Bio.register('t', 'x', { v: 5 });
      var out = { reg: reg.ok, cur: window.Bio.isRegistered('t', 'x', 5), any: window.Bio.isRegistered('t', 'x') };
      var a = await window.Bio.authenticate('t', 'x', { v: 5 });
      out.authCur = a.ok;
      var s = await window.Bio.authenticate('t', 'x', { v: 6 });
      out.authStale = s.error;
      out.gone = localStorage.getItem('bio_cred_t_x') === null;
      out.stale1 = window.Bio.takeStale('t', 'x'); out.stale2 = window.Bio.takeStale('t', 'x');
      return JSON.stringify(out);`));
    ok(f + ': Bio binds a credential to its password version',
      r.reg && r.cur && r.any && r.authCur && r.authStale === 'stale' && r.gone && r.stale1 && !r.stale2, JSON.stringify(r));
  }

  // ── MAGI: no Firebase lock version; the lock service's `ver` fingerprint ──
  console.log('\nmagi.html (lock service fingerprint)');
  let liveVer = 'aaaaaaaaaaaaaaaa';
  const magiMock = {
    patterns: ['https://taskhub-reminders.av1.workers.dev/*'],
    handle: (req) => {
      if (/\/auth\/journal\/status/.test(req.url)) return { status: 200, json: { ok: true, hasLock: true, noLock: false, ver: liveVer } };
      return { status: 200, json: { ok: true } };
    },
  };
  c.ws.close();
  const m = await connect({ mock: magiMock });
  await m.send('Page.enable');
  await m.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_AUTH });
  const magiBoot = async (sessionVer, bioVer) => {
    await m.send('Page.navigate', { url: ORIGIN + '/A1/magi.html?blank' }); await sleep(800);
    await evalJs(m, `localStorage.clear();
      localStorage.setItem('magi.tony.lock_session', JSON.stringify({ at: 1${sessionVer ? `, ver: ${JSON.stringify(sessionVer)}` : ''} }));
      localStorage.setItem('bio_cred_magi_tony', JSON.stringify({ id: 'AQIDBA', created: ${T1}, label: 'MAGI' }));
      ${bioVer ? `localStorage.setItem('magi.tony.bio_ver', ${JSON.stringify(bioVer)});` : ''}
      return 1;`);
    await m.send('Page.navigate', { url: ORIGIN + '/A1/magi.html' }); await sleep(4000);
    return JSON.parse(await evalJs(m, `var s = document.getElementById('lockScreen');
      return JSON.stringify({ locked: !!s && !s.hidden, session: localStorage.getItem('magi.tony.lock_session'),
        cred: localStorage.getItem('bio_cred_magi_tony'), msg: (document.getElementById('lockMsg') || {}).textContent || '' });`));
  };
  let g = await magiBoot('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa');
  ok('session + biometric under the live password: opens, keeps the biometric', !g.locked && g.cred !== null, JSON.stringify(g));
  g = await magiBoot('bbbbbbbbbbbbbbbb', 'bbbbbbbbbbbbbbbb');
  ok('password changed elsewhere: locked on boot', g.locked, JSON.stringify(g));
  ok('the old session is forgotten', g.session === null, g.session);
  ok('the old biometric is deleted', g.cred === null, g.cred);
  ok('says why', /password was changed/i.test(g.msg), g.msg);
  g = await magiBoot(null, null);
  ok('a session from before the fingerprint existed asks for the password once', g.locked && g.cred === null, JSON.stringify(g));
  m.ws.close();

  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
