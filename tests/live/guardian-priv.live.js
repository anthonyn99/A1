// The A1-Priv programs on Guardian, driven in their real pages (served from
// ../A1-Priv, or A1_ROOT's sibling, by cdp.js) against a stateful fake worker,
// a fake insight-api and a fake platform authenticator. Replaces
// lock-bio-binding.live.js: the biometric-to-password binding it checked per
// page is Guardian's now, and is checked here on every page.
//
// Each of TradeHub, Solace, RiftIQ and Vault:
//   - an old unlock (al_locks + al_unlockedv_*, as cookies only — what an
//     evicted Brave leaves) is adopted: straight in, the old credential kept
//   - the biometric unlocks; a password change elsewhere re-locks the page,
//     voids the biometric and says so; the new password opens it again
//   - a fresh device is held at a hard gate (no Cancel) with the content hidden
// TradeHub's tab locks: a locked tab asks with the app open; Insight: the
// password mints its Plaid session token.
//
// Run: node tests/live/guardian-priv.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const PRIV = 'https://anthonyn99.github.io/A1/';
const recs = {}; let n = 0, tokens = 0; const calls = [];
const ver = (k) => (recs[k] ? 'v' + recs[k].salt : null);
const setRec = (k, pw) => { recs[k] = { pw, salt: ++n }; };
const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://insight-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = new URL(req.url), p = u.pathname, b = req.postData ? JSON.parse(req.postData) : {};
    if (u.host.startsWith('insight-api')) {
      calls.push('insight' + p);
      if (p === '/lock/session') return { json: recs['applock:tony_insight'] && recs['applock:tony_insight'].pw === b.password ? { ok: true, token: 'itok' + (++tokens) } : { ok: false } };
      if (p === '/lock/check') return { json: { ok: /^itok/.test(b.token || '') } };
      return { json: { ok: true } };
    }
    const k = b.journal + ':' + b.entryId, r = recs[k];
    if (p === '/auth/journal/status-many') {
      const out = {}; b.locks.forEach((l) => { const kk = l.journal + ':' + l.entryId; out[kk] = { hasLock: !!recs[kk], ver: ver(kk) }; });
      return { json: { ok: true, locks: out } };
    }
    if (p === '/auth/journal/verify') return { json: r ? { ok: r.pw === b.password } : { ok: false, noLock: true } };
    if (p === '/auth/journal/set-lock') { if (r && r.pw !== b.current) return { status: 403, json: { ok: false, error: 'needs-current' } }; setRec(k, b.password); return { json: { ok: true } }; }
    return { json: { ok: false } };
  },
};
const FAKE_AUTH = `(function(){ if (window.top !== window) return;
  window.__gets = 0;
  var P = function(){}; P.isUserVerifyingPlatformAuthenticatorAvailable = function(){ return Promise.resolve(true); };
  Object.defineProperty(window, 'PublicKeyCredential', { value: P, configurable: true, writable: true });
  var cred = { rawId: new Uint8Array([1,2,3,4]).buffer, getClientExtensionResults: function(){ return {}; } };
  Object.defineProperty(navigator, 'credentials', { value: { create: function(){ return Promise.resolve(cred); }, get: function(){ window.__gets++; return Promise.resolve(cred); } }, configurable: true });
})();`;

const PAGES = [
  { file: 'tradehub.html', id: 'tony_tradehub_standalone', ns: 'tradehub', root: "document.getElementById('tradeboard-root')" },
  { file: 'solace.html', id: 'tony_solace_standalone', ns: 'solacelock', root: "document.getElementById('sol-root')" },
  { file: 'riftiq.html', id: 'tony_warroom_standalone', ns: 'warroomlock', root: "document.getElementById('program-picker')" },   // RiftIQ opens on its program picker
  { file: 'vault.html', id: 'tony_vault_standalone', ns: 'vaultlock', root: "document.getElementById('kc-root')" },
];

(async () => {
  const c = await connect({ mock: firebaseMock(mock) });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_AUTH });
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 300)); });
  const js = (e) => evalJs(c, e.trim().indexOf('return') === 0 && e.indexOf(';') < 0 ? e + ';' : e);
  const sr = `document.querySelector('guardian-lock') && document.querySelector('guardian-lock').shadowRoot`;
  const dlg = () => js(`const s = ${sr}; const ov = s && s.querySelector('.ov');
    return JSON.stringify(ov ? { open: true, text: s.querySelector('.card').innerText, err: (s.querySelector('.err')||{}).textContent||'',
      buttons: [...s.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean) } : { open: false });`).then(JSON.parse);
  const gtype = (ph, v) => js(`const s = ${sr}; const i = [...s.querySelectorAll('input')].find(i => i.placeholder === ${JSON.stringify(ph)}); if (!i) return 'missing'; i.value = ${JSON.stringify(v)}; return 1;`);
  const gclick = (t) => js(`const s = ${sr}; const b = [...s.querySelectorAll('button')].find(b => b.textContent.trim().indexOf(${JSON.stringify(t)}) === 0); if (!b) return 'missing'; b.click(); return 1;`).then(async (r) => { await sleep(900); return r; });
  const shown = (root) => js(`var r = ${root}; return !!r && getComputedStyle(r).display !== 'none' && getComputedStyle(r).visibility !== 'hidden' && !document.documentElement.classList.contains('wr-prelock');`);
  const fresh = async (file, seedJs) => {
    await c.send('Page.navigate', { url: PRIV + 'LifeHub/lifehub.js' }); await sleep(400);
    await js(`localStorage.clear(); sessionStorage.clear(); document.cookie.split(';').forEach(k => document.cookie = k.split('=')[0].trim() + '=; path=/; max-age=0'); ${seedJs || ''} return 1;`);
    await c.send('Page.navigate', { url: PRIV + file }); await sleep(5000);
  };

  for (const P of PAGES) {
    console.log('\n' + P.file);
    setRec('applock:' + P.id, 'pw1');
    const T1 = 1700000000000;
    // An evicted Brave: the old lock's records survive only as alDur cookies.
    await fresh(P.file, `
      document.cookie = 'al_locks=' + encodeURIComponent(JSON.stringify({ ${JSON.stringify(P.id)}: { locked: true, v: ${T1} } })) + '; path=/';
      document.cookie = 'al_unlockedv_${P.id}=${T1 + 5}; path=/';
      localStorage.setItem('bio_cred_${P.ns}_${P.id}', JSON.stringify({ id: 'AQIDBA', created: ${T1 + 9}, v: ${T1} }));`);
    let d = await dlg();
    ok('an old unlock (cookies only) is adopted: no prompt, content shown', !d.open && (await shown(P.root)), JSON.stringify(d));
    ok('its old biometric credential is kept', await js(`return JSON.parse(localStorage.getItem('gd.b.applock:${P.id}') || '{}').id === 'AQIDBA';`));

    // Lock this device now → the biometric unlocks.
    await js(`Guardian.lockNow(${JSON.stringify(P.id)}); return 1;`); await sleep(700);
    d = await dlg();
    ok('lock now: a hard gate (no Cancel) over hidden content', d.open && !d.buttons.includes('Cancel') && !(await shown(P.root)), JSON.stringify(d));
    ok('it offers the biometric', d.buttons.some((b) => /^Unlock with/.test(b)), JSON.stringify(d.buttons));
    await gclick('Unlock with');
    ok('the biometric unlocks it', !(await dlg()).open && (await shown(P.root)) && (await js('return window.__gets;')) >= 1);

    // The password changes on another device.
    setRec('applock:' + P.id, 'pw2');
    await js(`Guardian.refresh([${JSON.stringify(P.id)}], true); return 1;`); await sleep(1200);
    d = await dlg();
    ok('a password change elsewhere locks this device again', d.open && !(await shown(P.root)), JSON.stringify(d));
    ok('…with no biometric button, saying why', !d.buttons.some((b) => /^Unlock with/.test(b)) && /password changed/i.test(d.err), JSON.stringify(d));
    ok('…and the old credential is gone', await js(`return localStorage.getItem('gd.b.applock:${P.id}') === null;`));
    await gtype('Password', 'pw1'); await gclick('Unlock');
    ok('the old password no longer works', (await dlg()).open && /Wrong/.test((await dlg()).err));
    await gtype('Password', 'pw2'); await gclick('Unlock'); await sleep(400);
    d = await dlg();
    ok('the new password opens it and offers to re-register the biometric', (await shown(P.root)) && d.open && /Register/.test(d.buttons.join(' ')), JSON.stringify(d));
    await gclick('Not now');

    // A fresh device.
    await fresh(P.file);
    d = await dlg();
    ok('a fresh device: asks, content hidden', d.open && !(await shown(P.root)), JSON.stringify(d));
  }

  console.log('\ntradehub.html — tab locks');
  setRec('applock:tony_tradehub_standalone', 'pw');
  setRec('applock:tony_tradehub_tab_journal', 'tabpw');
  await fresh('tradehub.html', `localStorage.setItem('al_locks', JSON.stringify({ tony_tradehub_standalone: { locked: true, v: 1 }, tony_tradehub_tab_journal: { locked: true, v: 1 } }));
    localStorage.setItem('al_unlockedv_tony_tradehub_standalone', '2');`);
  ok('the app opens (adopted)', !(await dlg()).open);
  await js(`[...document.querySelectorAll('#tradeboard-root button, #tradeboard-root [role=tab], #tradeboard-root a')].find(b => /^\\s*Journal\\s*$/.test(b.textContent)) && [...document.querySelectorAll('#tradeboard-root button, #tradeboard-root [role=tab], #tradeboard-root a')].find(b => /^\\s*Journal\\s*$/.test(b.textContent)).click(); return 1;`);
  await sleep(1500);
  let d = await dlg();
  ok('a locked tab asks for its own password', d.open && /Journal/.test(d.text), JSON.stringify(d));
  await gtype('Password', 'tabpw'); await gclick('Unlock'); await sleep(600);
  ok('the tab opens', !(await dlg()).open && !(await js(`return !!document.querySelector('.tb-tablock-gate');`)));

  console.log('\ninsight.html');
  setRec('applock:tony_insight', 'ipw');
  await fresh('insight.html');
  d = await dlg();
  ok('a hard gate with no Cancel, content hidden', d.open && !d.buttons.includes('Cancel') && (await js(`return getComputedStyle(document.querySelector('body > .wrap')).visibility;`)) === 'hidden', JSON.stringify(d));
  await gtype('Password', 'ipw'); await gclick('Unlock'); await sleep(600);
  ok('the password mints the Plaid session token', /^itok/.test(JSON.parse((await js(`return localStorage.getItem('insight_lock_session') || '{}';`))).token || ''));
  ok('and opens Insight', !(await dlg()).open && (await js(`return getComputedStyle(document.querySelector('body > .wrap')).visibility;`)) === 'visible');
  await js(`document.getElementById('lockNowBtn').click(); return 1;`); await sleep(600);
  d = await dlg();
  ok('its menu has no "Remove lock"', d.open && !d.buttons.includes('Remove lock') && d.buttons.includes('Change password'), JSON.stringify(d.buttons));
  await gclick('Cancel');

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
