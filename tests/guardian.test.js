// Guardian (Guardian/guardian.js): the one lock every A1 program calls.
// Driven in jsdom against a fake taskhub-reminders worker that behaves like the
// real one (PBKDF2 aside): a record per jlock key, `ver` = a fingerprint that
// moves on every set/change/reset, set-lock over a record needs `current`.
//
// Run: node tests/guardian.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('crypto');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'Guardian', 'guardian.js'), 'utf8');

// ── Fake worker ───────────────────────────────────────────────────────────────
function fakeWorker() {
  const W = { recs: {}, calls: [], mails: [], forms: [], down: false, n: 0, codes: {} };
  const ver = (k) => (W.recs[k] ? 'v' + W.recs[k].salt : null);
  W.ver = ver;
  W.set = (k, pw, hint) => { W.recs[k] = { pw, hint: hint || '', salt: ++W.n }; };
  W.fetch = async (url, opts) => {
    url = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (url.includes('formspree.io')) { W.forms.push({ url, body }); return res(200, { ok: true }); }
    if (W.down) throw new TypeError('Failed to fetch');
    const p = url.replace(/^https:\/\/taskhub-reminders\.av1\.workers\.dev/, '');
    W.calls.push({ p, body });
    const k = body.journal + ':' + body.entryId, r = W.recs[k];
    switch (p) {
      case '/auth/journal/status-many': {
        const out = {};
        body.locks.forEach((l) => { const kk = l.journal + ':' + l.entryId; out[kk] = { hasLock: !!W.recs[kk], ver: ver(kk) }; });
        return res(200, { ok: true, locks: out });
      }
      case '/auth/journal/verify':
        if (!r) return res(200, { ok: false, noLock: true });
        return res(200, { ok: r.pw === body.password });
      case '/auth/journal/set-lock':
        if (r && r.pw !== body.current) return res(403, { ok: false, error: 'needs-current' });
        W.set(k, body.password, body.hint); return res(200, { ok: true });
      case '/auth/journal/remove-lock':
        if (!r) return res(200, { ok: true });
        if (r.pw !== body.password) return res(200, { ok: false });
        delete W.recs[k]; return res(200, { ok: true });
      case '/auth/journal/hint':
        if (!r) return res(200, { noLock: true });
        W.mails.push({ kind: 'hint', owner: body.owner, label: body.label });
        return res(200, { ok: true, relay: { form: 'https://formspree.io/f/' + (body.owner === 'veda' ? 'xzdlwaqg' : 'xeedkebo'), email: body.owner, subject: 'hint', message: r.hint } });
      case '/auth/reset/request':
        if (!r) return res(200, { ok: false, noLock: true });
        W.codes[k] = 'ABC234'; W.mails.push({ kind: 'reset', owner: body.owner });
        return res(200, { ok: true, emailed: true, to: 'a***@x' });
      case '/auth/reset/confirm':
        if (W.codes[k] !== body.code) return res(200, { ok: false, error: 'badcode', remaining: 5 });
        delete W.codes[k]; W.set(k, body.password, body.hint); return res(200, { ok: true });
    }
    return res(404, {});
  };
  return W;
}
function res(status, obj) { return { ok: status < 300, status, json: async () => obj }; }

// ── A page with Guardian loaded ──────────────────────────────────────────────
function page(W, opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><head></head><body><div id="app">secret</div></body>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://anthonyn99.github.io/A1/x.html' });
  const w = dom.window;
  if (opts.storage) Object.keys(opts.storage).forEach((k) => w.localStorage.setItem(k, opts.storage[k]));
  w.fetch = W.fetch;
  Object.defineProperty(w, 'crypto', { value: webcrypto });
  w.TextEncoder = TextEncoder;
  w.Element.prototype.getClientRects = function () { return this.isConnected ? [{}] : []; };
  w.eval(SRC);
  const G = w.Guardian;
  const sr = () => { const host = w.document.querySelector('guardian-lock'); return host && host.shadowRoot; };
  const q = (sel) => sr() && sr().querySelector(sel);
  const all = (sel) => (sr() ? [...sr().querySelectorAll(sel)] : []);
  const button = (text) => all('button').find((b) => b.textContent.trim() === text);
  const input = (ph) => all('input').find((i) => i.placeholder === ph);
  const type = (ph, v) => { const i = input(ph); if (!i) throw new Error('no input ' + ph); i.value = v; };
  const click = (text) => { const b = button(text); if (!b) throw new Error('no button "' + text + '" in [' + all('button').map((x) => x.textContent.trim()).join('|') + ']'); b.click(); };
  const err = () => (q('.err') ? q('.err').textContent : '');
  return { w, G, q, all, button, input, type, click, err, ls: w.localStorage };
}

(async () => {
  console.log('\n1. no lock: gate opens with no prompt');
  {
    const W = fakeWorker(); const P = page(W);
    P.G.define('tony_x', { label: 'X' });
    const r = await P.G.gate('tony_x');
    ok('resolves true', r === true);
    ok('no dialog', !P.G.isOpen());
    ok('one status-many call', W.calls.filter((c) => c.p === '/auth/journal/status-many').length === 1, W.calls);
  }

  console.log('\n2. locked: prompt, wrong then right password, marker = ver');
  {
    const W = fakeWorker(); W.set('applock:tony_x', 'pw1');
    const P = page(W);
    P.G.define('tony_x', { label: 'X', root: '#app' });
    const g = P.G.gate('tony_x');
    await tick(20);
    ok('dialog open', P.G.isOpen());
    ok('Tony theme', P.q('.ov').getAttribute('data-theme') === 'tony');
    ok('root hidden while locked', P.w.document.getElementById('guardian-prepaint').textContent.includes('#app'));
    P.type('Password', 'nope'); P.click('Unlock'); await tick(20);
    ok('wrong password message', /Wrong password/.test(P.err()), P.err());
    ok('still open', P.G.isOpen());
    P.type('Password', 'pw1'); P.click('Unlock'); await tick(40);
    ok('gate resolves true', (await g) === true);
    ok('marker records the worker ver', P.ls.getItem('gd.u.applock:tony_x') === W.ver('applock:tony_x'), P.ls.getItem('gd.u.applock:tony_x'));
    ok('root shown again', !P.w.document.getElementById('guardian-prepaint').textContent.includes('#app'));
    ok('isUnlocked', P.G.isUnlocked('tony_x'));
    ok('second gate needs no prompt', (await P.G.gate('tony_x')) === true && !P.G.isOpen());
    ok('marker mirrored to a cookie', /gdu\.applock_tony_x=/.test(P.w.document.cookie), P.w.document.cookie);

    console.log('\n3. password changed on another device: re-lock + bio void + stale flag');
    P.ls.setItem('gd.b.applock:tony_x', JSON.stringify({ id: 'cred', ver: W.ver('applock:tony_x') }));
    let locked = null; P.w.addEventListener('guardian:lock', (e) => { locked = e.detail; });
    W.set('applock:tony_x', 'pw2');
    await P.G.refresh(['tony_x']);
    ok('device is locked again', !P.G.isUnlocked('tony_x'));
    ok('guardian:lock fired with reason changed', locked && locked.reason === 'changed', locked);
    ok('biometric dropped', P.ls.getItem('gd.b.applock:tony_x') === null);
    ok('stale flag set for re-enrol offer', P.ls.getItem('gd.s.applock:tony_x') === '1');
    ok('visible root re-gated automatically', P.G.isOpen());
    P.G.close();
  }

  console.log('\n4. client throttle: 5 wrong → 30s cooldown');
  {
    const W = fakeWorker(); W.set('applock:t', 'pw'); const P = page(W);
    P.G.define('t', { owner: 'tony' }); P.G.gate('t'); await tick(20);
    for (let i = 0; i < 5; i++) { P.type('Password', 'bad'); P.click('Unlock'); await tick(15); }
    const before = W.calls.filter((c) => c.p === '/auth/journal/verify').length;
    P.type('Password', 'pw'); P.click('Unlock'); await tick(15);
    ok('6th try blocked locally', /Wait \d+s/.test(P.err()), P.err());
    ok('no request sent while cooling down', W.calls.filter((c) => c.p === '/auth/journal/verify').length === before);
    P.G.close();
  }

  console.log('\n5. legacy adoption: old app-lock marker opens with no prompt, old biometric kept');
  {
    const W = fakeWorker(); W.set('applock:tony_tradehub', 'pw');
    const P = page(W, { storage: {
      al_locks: JSON.stringify({ tony_tradehub: { locked: true, v: 100 } }),
      al_unlockedat_tony_tradehub: '150',
      bio_cred_applock_tony_tradehub: JSON.stringify({ id: 'oldcred', v: 120, prf: true, prfSalt: 'c2FsdA' }),
    } });
    P.G.define('tony_tradehub', { label: 'TradeHub', legacy: P.G.legacy.al('tony_tradehub', 'applock') });
    ok('locked (from the old cache) before the worker answers', P.G.isLocked('tony_tradehub'));
    ok('unlocked by adoption', P.G.isUnlocked('tony_tradehub'));
    const b = JSON.parse(P.ls.getItem('gd.b.applock:tony_tradehub') || 'null');
    ok('same credential id adopted (same fingerprint prompt)', b && b.id === 'oldcred' && b.prf === true, b);
    await P.G.refresh();
    ok('pending marker resolved to the real ver', P.ls.getItem('gd.u.applock:tony_tradehub') === W.ver('applock:tony_tradehub'));
    ok('adopted biometric bound to the real ver', JSON.parse(P.ls.getItem('gd.b.applock:tony_tradehub')).ver === W.ver('applock:tony_tradehub'));
    ok('still unlocked after refresh', P.G.isUnlocked('tony_tradehub'));

    console.log('\n6. lock this device now is not undone by adoption on reload');
    P.G.lockNow('tony_tradehub');
    ok('locked now', !P.G.isUnlocked('tony_tradehub'));
    const P2 = page(W, { storage: Object.fromEntries(Object.keys(P.ls).map((k) => [k, P.ls.getItem(k)])) });
    P2.w.document.cookie = P.w.document.cookie;
    P2.G.define('tony_tradehub', { label: 'TradeHub', legacy: P2.G.legacy.al('tony_tradehub', 'applock') });
    ok('reload: still locked', !P2.G.isUnlocked('tony_tradehub'));
  }
  {
    const W = fakeWorker(); W.set('applock:tony_vault', 'pw');
    const P = page(W, { storage: {
      al_locks: JSON.stringify({ tony_vault: { locked: true, v: 500 } }),
      al_unlockedat_tony_vault: '400',
      bio_cred_applock_tony_vault: JSON.stringify({ id: 'c', v: 300 }),
    } });
    P.G.define('tony_vault', { legacy: P.G.legacy.al('tony_vault') });
    ok('stale old marker (password changed since) is NOT adopted', !P.G.isUnlocked('tony_vault'));
    ok('stale old biometric not adopted', P.ls.getItem('gd.b.applock:tony_vault') === null);
  }
  {
    const W = fakeWorker(); W.set('applock:tony_myjournal', 'pw');
    const P = page(W, { storage: { al_locks: '{}' } });
    P.G.define('tony_myjournal', { legacy: P.G.legacy.al('tony_myjournal') });
    ok('old registry had no lock → still opens (no surprise prompt)', P.G.isUnlocked('tony_myjournal'));
  }
  {
    const W = fakeWorker(); W.set('applock:profile_tony', 'pw');
    const P = page(W);
    P.G.define('profile_tony', { legacy: P.G.legacy.al('profile_tony') });
    await P.G.refresh();
    ok('a brand-new device (no old records at all) is NOT adopted — it asks', !P.G.isUnlocked('profile_tony') && P.G.mustBlock('profile_tony'));
  }
  {
    const W = fakeWorker(); W.set('tj:e1', 'pw');
    const P = page(W, { storage: { tj_unlockedat_e1: '900' } });
    P.G.define('tj:e1', { journal: 'tj', entryId: 'e1', kind: 'entry', legacy: P.G.legacy.marker('tj_', 'e1', 800) });
    ok('journal entry marker adopted', P.G.isUnlocked('tj:e1'));
    P.G.define('tj:e2', { journal: 'tj', entryId: 'e2', kind: 'entry', legacy: P.G.legacy.marker('tj_', 'e2', 800) });
    ok('entry never unlocked here stays locked', !P.G.isUnlocked('tj:e2'));
  }
  {
    const W = fakeWorker(); W.set('applock:tony_magi', 'pw');
    const P = page(W);
    P.G.define('tony_magi', { legacy: { open: () => 'vSTALE' } });
    ok('ver-string legacy (MAGI) adopted before status', P.G.isUnlocked('tony_magi'));
    await P.G.refresh();
    ok('…and re-locked once the worker ver differs', !P.G.isUnlocked('tony_magi'));
  }

  console.log('\n7. menu: change password is ONE set-lock with current');
  {
    const W = fakeWorker(); W.set('applock:tony_x', 'old');
    const P = page(W); let changed = null;
    P.G.define('tony_x', { label: 'X', onChange: (id, what) => { changed = what; } });
    await P.G.refresh();
    P.ls.setItem('gd.u.applock:tony_x', W.ver('applock:tony_x'));
    P.ls.setItem('gd.b.applock:tony_x', JSON.stringify({ id: 'c', ver: W.ver('applock:tony_x') }));
    P.G.manage('tony_x'); await tick(20);
    ok('menu offers lock now', !!P.button('Lock this device now'));
    ok('menu offers remove', !!P.button('Remove lock'));
    P.click('Change password'); await tick(5);
    P.type('Current password', 'wrong'); P.type('New password', 'new'); P.type('Confirm new password', 'new');
    P.click('Change password'); await tick(20);
    ok('wrong current rejected', /Current password is wrong/.test(P.err()), P.err());
    ok('lock untouched after a wrong current', W.recs['applock:tony_x'].pw === 'old');
    P.type('Current password', 'old'); P.type('New password', 'new'); P.type('Confirm new password', 'nex');
    P.click('Change password'); await tick(5);
    ok('mismatch caught', /don't match/.test(P.err()));
    P.type('Confirm new password', 'new'); P.click('Change password'); await tick(40);
    ok('no remove-lock in the change flow', !W.calls.some((c) => c.p === '/auth/journal/remove-lock'));
    ok('password changed', W.recs['applock:tony_x'].pw === 'new');
    ok('this device stays unlocked at the new ver', P.ls.getItem('gd.u.applock:tony_x') === W.ver('applock:tony_x'));
    ok('this device biometric voided', P.ls.getItem('gd.b.applock:tony_x') === null);
    ok('onChange("change")', changed === 'change');
    ok('confirmation shown', !!P.button('OK')); P.click('OK');
  }

  console.log('\n8. hint + reset are routed by owner');
  {
    const W = fakeWorker(); W.set('bj:e9', 'pw', 'blue'); W.set('applock:profile_tony', 'pw');
    const P = page(W);
    P.G.define('bj:e9', { journal: 'bj', entryId: 'e9', kind: 'entry', owner: 'veda', label: 'Entry' });
    P.G.gate('bj:e9'); await tick(20);
    ok('Veda theme on her lock', P.q('.ov').getAttribute('data-theme') === 'veda');
    P.click('Email me my hint'); await tick(30);
    ok('hint asked as owner veda', W.mails[0] && W.mails[0].owner === 'veda', W.mails);
    ok('relay posted to Veda\'s Formspree', W.forms[0] && /xzdlwaqg/.test(W.forms[0].url), W.forms);
    P.G.close();
    P.G.define('profile_tony', { label: 'Tony' });
    P.G.gate('profile_tony'); await tick(20);
    P.click('Reset password'); await tick(5);
    P.click('Email me a code'); await tick(30);
    ok('reset asked as owner tony', W.mails[1] && W.mails[1].kind === 'reset' && W.mails[1].owner === 'tony', W.mails);
    P.type('6-character code', 'WRONG1'); P.type('New password', 'n1'); P.type('Confirm new password', 'n1');
    P.click('Reset password'); await tick(30);
    ok('bad code message', /not correct/.test(P.err()), P.err());
    P.type('6-character code', 'ABC234'); P.click('Reset password'); await tick(40);
    ok('reset sets the new password', W.recs['applock:profile_tony'].pw === 'n1');
    ok('device unlocked at new ver', P.G.isUnlocked('profile_tony') && P.ls.getItem('gd.u.applock:profile_tony') === W.ver('applock:profile_tony'));
    P.click('OK');
  }

  console.log('\n9. set + remove');
  {
    const W = fakeWorker(); const P = page(W);
    P.G.define('veda_rules', { label: 'Rules' });
    const m = P.G.manage('veda_rules'); await tick(30);
    ok('no lock → set screen', !!P.button('Set password'));
    P.type('New password', 'a'); P.type('Confirm password', 'a'); P.click('Set password'); await tick(40);
    ok('lock created', W.recs['applock:veda_rules'] && W.recs['applock:veda_rules'].pw === 'a');
    ok('this device unlocked', P.G.isUnlocked('veda_rules') && P.G.isLocked('veda_rules'));
    ok('manage resolves true', (await m) === true);
    P.G.manage('veda_rules'); await tick(20);
    P.click('Remove lock'); await tick(5);
    P.type('Password', 'x'); P.click('Remove lock'); await tick(20);
    ok('wrong password keeps the lock', !!W.recs['applock:veda_rules']);
    P.type('Password', 'a'); P.click('Remove lock'); await tick(20);
    ok('lock removed', !W.recs['applock:veda_rules'] && !P.G.isLocked('veda_rules'));
  }
  {
    const W = fakeWorker(); W.set('applock:tony_oneinbox', 'pw'); const P = page(W);
    P.G.define('tony_oneinbox', { allowRemove: false }); await P.G.refresh();
    P.G.manage('tony_oneinbox'); await tick(20);
    ok('allowRemove:false hides Remove lock', !P.button('Remove lock'));
    P.G.close();
  }

  console.log('\n10. verify: always asks, resolves the password; offline fallback (Shield)');
  {
    const W = fakeWorker(); W.set('applock:tony_shield', 'sh');
    const P = page(W);
    P.G.define('tony_shield', { offline: true });
    P.ls.setItem('gd.u.applock:tony_shield', 'whatever');
    const v = P.G.verify('tony_shield'); await tick(20);
    ok('asks even though the device is unlocked', P.G.isOpen());
    P.type('Password', 'sh'); P.click('Continue'); await tick(60);
    ok('resolves the password', (await v) === 'sh');
    await tick(300);
    ok('offline verifier written', !!P.ls.getItem('gd.o.applock:tony_shield'));
    W.down = true;
    const v2 = P.G.verify('tony_shield'); await tick(20);
    P.type('Password', 'bad'); P.click('Continue'); await tick(400);
    ok('offline: wrong password rejected', P.G.isOpen() && /Wrong/.test(P.err()), P.err());
    P.type('Password', 'sh'); P.click('Continue'); await tick(400);
    ok('offline: right password accepted', (await v2) === 'sh');
    const v3 = P.G.verify('tony_shield'); await tick(20); P.G.close();
    ok('cancel resolves null', (await v3) === null);
  }

  console.log('\n11. session hook (OneInbox / Insight)');
  {
    const W = fakeWorker(); W.set('applock:tony_insight', 'pw');
    const P = page(W); let minted = null, alive = true, ended = false;
    P.G.define('tony_insight', { session: { mint: (pw) => { minted = pw; return true; }, check: () => alive, end: () => { ended = true; } } });
    P.G.gate('tony_insight'); await tick(20);
    P.type('Password', 'pw'); P.click('Unlock'); await tick(40);
    ok('session minted with the password', minted === 'pw');
    alive = false; await P.G.refresh(['tony_insight']);
    ok('server forgot the session → locked', !P.G.isUnlocked('tony_insight'));
    P.G.lockNow('tony_insight');
    ok('lock now ends the session', ended);
  }

  console.log('\n12. prepaint + custom backend (ORCA)');
  {
    const W = fakeWorker(); W.set('applock:tony_p', 'pw');
    const P = page(W, { storage: { 'gd.c.applock:tony_p': JSON.stringify({ h: true, v: 'vX', t: 1 }) } });
    P.G.define('tony_p', { root: '#app' }); P.G.prepaint(['tony_p']);
    ok('prepaint hides a locked root synchronously', P.w.document.getElementById('guardian-prepaint').textContent.includes('#app'));
  }
  {
    const W = fakeWorker(); const P = page(W); const seen = [];
    const backend = {
      status: async () => ({ hasLock: true, ver: 'o1' }),
      verify: async (d, pw) => { seen.push('verify'); return { ok: pw === 'orca' }; },
      set: async () => ({ ok: true }), remove: async () => ({ ok: true }),
      hint: async () => ({ ok: true, emailed: true }), resetRequest: async () => ({ ok: true, emailed: true }), resetConfirm: async () => ({ ok: true }),
    };
    P.G.define('veda_orca', { owner: 'veda', backend });
    const g = P.G.gate('veda_orca'); await tick(20);
    P.type('Password', 'orca'); P.click('Unlock'); await tick(30);
    ok('custom backend verified the password', seen[0] === 'verify' && (await g) === true);
    ok('worker never called', W.calls.length === 0, W.calls);
  }

  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
