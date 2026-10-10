// Guardian in a real browser: every screen, both themes (Tony = MAGI, Veda =
// her TaskHub palette), desktop and phone, with a stateful fake worker and a
// fake platform authenticator. Screenshots land in SHOTS (printed at the end).
//
// Checks what jsdom can't: the overlay really covers the page, the card fits a
// phone with no horizontal scroll, the biometric button unlocks through
// navigator.credentials, fonts/themes resolve, and Escape/Enter work.
//
// Run: CDP_ALLOW_FONTS=1 node tests/live/guardian.live.js
'use strict';
const { connect, evalJs, sleep, shotPath, SHOTS } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const URL_ = 'https://anthonyn99.github.io/A1/tests/live/guardian-harness.html';

// Stateful fake of taskhub-reminders' password routes.
const recs = {}; let n = 0; const mails = [];
const ver = (k) => (recs[k] ? 'v' + recs[k].salt : null);
const setRec = (k, pw) => { recs[k] = { pw, salt: ++n }; };
setRec('applock:tony_demo', 'tonypw');
setRec('applock:veda_demo', 'vedapw');
const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://formspree.io/*'],
  handle: (req) => {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    if (/formspree/.test(req.url)) { mails.push('form:' + req.url); return { json: { ok: true } }; }
    const b = req.postData ? JSON.parse(req.postData) : {};
    const p = new URL(req.url).pathname, k = b.journal + ':' + b.entryId, r = recs[k];
    if (p === '/auth/journal/status-many') {
      const out = {}; b.locks.forEach((l) => { const kk = l.journal + ':' + l.entryId; out[kk] = { hasLock: !!recs[kk], ver: ver(kk) }; });
      return { json: { ok: true, locks: out } };
    }
    if (p === '/auth/journal/verify') return { json: r ? { ok: r.pw === b.password } : { ok: false, noLock: true } };
    if (p === '/auth/journal/set-lock') { if (r && r.pw !== b.current) return { status: 403, json: { ok: false, error: 'needs-current' } }; setRec(k, b.password); return { json: { ok: true } }; }
    if (p === '/auth/journal/hint') { mails.push('hint:' + b.owner); return { json: { ok: true, emailed: true } }; }
    if (p === '/auth/reset/request') { mails.push('reset:' + b.owner); return { json: { ok: true, emailed: true, to: 'v***@gmail.com' } }; }
    return { json: { ok: false } };
  },
};
const FAKE_AUTH = `(function(){ if (window.top !== window) return;
  window.__gets = 0; window.__creates = 0;
  var P = function(){}; P.isUserVerifyingPlatformAuthenticatorAvailable = function(){ return Promise.resolve(true); };
  Object.defineProperty(window, 'PublicKeyCredential', { value: P, configurable: true, writable: true });
  var cred = { rawId: new Uint8Array([9,8,7]).buffer, getClientExtensionResults: function(){ return {}; } };
  Object.defineProperty(navigator, 'credentials', { value: { create: function(){ window.__creates++; return Promise.resolve(cred); }, get: function(){ window.__gets++; return Promise.resolve(cred); } }, configurable: true });
})();`;

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_AUTH });
  const S = (sel) => `document.querySelector('guardian-lock').shadowRoot.querySelector(${JSON.stringify(sel)})`;
  const btn = (t) => `[...document.querySelector('guardian-lock').shadowRoot.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(t)})`;
  const shot = async (name) => {
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(shotPath('guardian-' + name), Buffer.from(r.data, 'base64'));
  };
  const load = async (w, h, mobile) => {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile });
    await c.send('Page.navigate', { url: URL_ }); await sleep(900);
    await evalJs(c, `localStorage.clear(); sessionStorage.clear(); document.cookie.split(';').forEach(k => document.cookie = k.split('=')[0].trim() + '=; path=/; max-age=0'); return 1;`);
    await c.send('Page.navigate', { url: URL_ }); await sleep(900);
    await evalJs(c, `Guardian.define('tony_demo', { owner: 'tony', label: 'TradeHub', root: '#app' });
      Guardian.define('veda_demo', { owner: 'veda', label: 'Brainstorm Journal', kind: 'app' }); return 1;`);
  };
  const info = () => evalJs(c, `
    const host = document.querySelector('guardian-lock'); const sr = host && host.shadowRoot;
    const ov = sr && sr.querySelector('.ov'), card = sr && sr.querySelector('.card');
    if (!ov) return JSON.stringify({ open: false });
    const r = ov.getBoundingClientRect(), cr = card.getBoundingClientRect();
    return JSON.stringify({ open: true, theme: ov.dataset.theme, covers: r.width >= innerWidth && r.height >= innerHeight,
      fits: cr.left >= 0 && cr.right <= innerWidth, hscroll: document.documentElement.scrollWidth > innerWidth,
      title: getComputedStyle(sr.querySelector('.title')).fontFamily, bg: getComputedStyle(card).backgroundColor,
      buttons: [...sr.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean), err: (sr.querySelector('.err')||{}).textContent || '' });`).then(JSON.parse);

  for (const [w, h, mobile, tag] of [[1440, 900, false, 'desktop'], [390, 844, true, 'phone']]) {
    console.log('\n' + tag + ' — Tony');
    await load(w, h, mobile);
    await evalJs(c, `window.__g = Guardian.gate('tony_demo'); return 1;`); await sleep(700);
    let u = await info();
    ok('gate covers the page', u.open && u.covers, JSON.stringify(u));
    ok('Tony theme: MAGI card #232327, Manrope title', u.theme === 'tony' && u.bg === 'rgb(35, 35, 39)' && /Manrope/.test(u.title), JSON.stringify(u));
    ok('card fits, no horizontal scroll', u.fits && !u.hscroll, JSON.stringify(u));
    ok('content hidden behind the gate', await evalJs(c, `getComputedStyle(document.getElementById('app')).visibility === 'hidden'`));
    await shot(tag + '-tony-unlock');
    await evalJs(c, `${S('input')}.value = 'wrong'; ${S('input')}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1;`); await sleep(500);
    u = await info();
    ok('Enter submits; wrong password says so', /Wrong password/.test(u.err), JSON.stringify(u));
    await shot(tag + '-tony-wrong');
    await evalJs(c, `${S('input')}.value = 'tonypw'; ${btn('Unlock')}.click(); return 1;`); await sleep(800);
    ok('right password unlocks and shows the content', (await evalJs(c, `window.__g`)) === true && (await evalJs(c, `getComputedStyle(document.getElementById('app')).visibility`)) === 'visible');
    // The offer to register a biometric does not appear on a first unlock (only after a change); open the menu.
    await evalJs(c, `Guardian.manage('tony_demo'); return 1;`); await sleep(500);
    u = await info();
    ok('menu: lock now, register, change, remove, cancel', ['Lock this device now', 'Register biometrics', 'Change password', 'Remove lock', 'Cancel'].every((t) => u.buttons.includes(t) || (t === 'Register biometrics' && u.buttons.some((b) => /^Register /.test(b)))), JSON.stringify(u.buttons));
    await shot(tag + '-tony-menu');
    await evalJs(c, `[...document.querySelector('guardian-lock').shadowRoot.querySelectorAll('button')].find(b => /^Register /.test(b.textContent.trim())).click(); return 1;`); await sleep(600);
    ok('register calls the platform authenticator', (await evalJs(c, 'window.__creates')) === 1);
    await shot(tag + '-tony-registered');
    await evalJs(c, `${btn('OK')}.click(); Guardian.lockNow('tony_demo'); return 1;`); await sleep(300);
    await evalJs(c, `window.__g = Guardian.gate('tony_demo'); return 1;`); await sleep(600);
    u = await info();
    ok('locked again shows "Unlock with …"', u.buttons.some((b) => /^Unlock with /.test(b)), JSON.stringify(u.buttons));
    await shot(tag + '-tony-unlock-bio');
    await evalJs(c, `[...document.querySelector('guardian-lock').shadowRoot.querySelectorAll('button')].find(b => /^Unlock with /.test(b.textContent.trim())).click(); return 1;`); await sleep(700);
    ok('biometric unlocks', (await evalJs(c, `window.__g`)) === true && (await evalJs(c, 'window.__gets')) === 1);
    await evalJs(c, `Guardian.changePassword('tony_demo'); return 1;`); await sleep(400);
    await shot(tag + '-tony-change');
    await evalJs(c, `Guardian.close(); return 1;`);

    console.log('\n' + tag + ' — Veda');
    await evalJs(c, `window.__v = Guardian.gate('veda_demo'); return 1;`); await sleep(700);
    u = await info();
    ok('Veda theme: her card #26272A, Lora title', u.theme === 'veda' && u.bg === 'rgb(38, 39, 42)' && /Lora/.test(u.title), JSON.stringify(u));
    ok('card fits, no horizontal scroll', u.fits && !u.hscroll, JSON.stringify(u));
    await shot(tag + '-veda-unlock');
    await evalJs(c, `${btn('Email me my hint')}.click(); return 1;`); await sleep(500);
    ok('hint goes out as Veda', mails.includes('hint:veda'), mails.join());
    await evalJs(c, `${btn('Reset password')}.click(); return 1;`); await sleep(300);
    await shot(tag + '-veda-reset');
    await evalJs(c, `${btn('Email me a code')}.click(); return 1;`); await sleep(600);
    ok('reset code requested as Veda', mails.includes('reset:veda'), mails.join());
    await shot(tag + '-veda-code');
    await evalJs(c, `document.querySelector('guardian-lock').shadowRoot.querySelector('.ov').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;`); await sleep(300);
    ok('Escape cancels back to the program', (await evalJs(c, `window.__v`)) === false && !(await info()).open);
    await evalJs(c, `Guardian.setLock('veda_new'); return 1;`); await sleep(300);
    await evalJs(c, `Guardian.define('veda_new', { owner: 'veda', label: 'Rules' }); Guardian.setLock('veda_new'); return 1;`); await sleep(400);
    await shot(tag + '-veda-set');
    await evalJs(c, `Guardian.close(); return 1;`);
  }

  console.log('\nScreenshots: ' + SHOTS + '\\guardian-*.png');
  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
