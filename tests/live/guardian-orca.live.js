// ORCA's gate on Guardian (ORCA repo, branch accounts: app/web/static/lock.js),
// driven headless with ORCA's REAL lock.js and app.css, the real Guardian, and
// a fake ORCA server standing in for its /lock/* routes (worker/src/web/
// picker.ts) — including the per-profile session ORCA keeps server-side.
//
//   - picking a profile raises Guardian's card in that profile's theme
//   - a wrong password is refused; the right one gets the session and opens ORCA
//   - a profile this device already holds opens with no password (/lock/enter)
//   - hint and reset go through ORCA's /lock/forgot and /lock/reset
//   - ?manage=1: Guardian's menu, with no "Remove lock" (refused on the
//     internet); "Lock this device now" clears the session and asks again;
//     change password is ORCA's /lock/change with the current password
//
// Set ORCA_ROOT to the ORCA checkout (default: ../ORCA next to this repo).
// Run: node tests/live/guardian-orca.live.js
'use strict';
const fs = require('fs');
const path = require('path');
const { connect, evalJs, sleep } = require('./cdp.js');

const ORCA = path.resolve(process.env.ORCA_ROOT || path.join(__dirname, '..', '..', '..', 'ORCA'));
if (!fs.existsSync(path.join(ORCA, 'app', 'web', 'static', 'lock.js'))) { console.log('  · skipped: no ORCA checkout at ' + ORCA); process.exit(0); }
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const SITE = 'https://anthonyn99.github.io';
const PROFILES = [
  { id: 'tony', label: 'Tony', emoji: '⚜', ink: true, color: '#c0aeea' },
  { id: 'veda', label: 'Veda', emoji: '✦', ink: false, color: '#8D769A' },
];

// ── the fake ORCA server ─────────────────────────────────────────────────────
const S = { pw: { tony: 'tpw', veda: 'vpw' }, held: new Set(), calls: [], current: '', manage: false };
function gatePage() {
  const cards = PROFILES.map((p) => `
        <form class="gate-card" method="post" action="/profiles/${p.id}/enter" data-profile="${p.id}" data-label="${p.label}" data-emoji="${p.emoji}" data-ink="${p.ink ? '1' : ''}" data-unlocked="${S.held.has(p.id) ? '1' : '0'}" style="--pc: ${p.color};">
            <button type="submit" class="gate-head"><span class="gate-av">${p.emoji}</span><span class="gate-name">${p.label}</span></button>
        </form>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ORCA - Who goes there?</title><link href="/static/app.css" rel="stylesheet"></head>
<body class="gate-body-page">
<div class="gate" id="gate" data-current="${S.current}" data-open="" data-manage="${S.manage ? '1' : ''}">
  <div class="gate-wrap"><div class="gate-brand">ORCA</div><div class="gate-lede">Who goes there?</div><div class="gate-cards">${cards}</div></div>
</div>
<script src="/static/lock.js"></script></body></html>`;
}
const mock = {
  patterns: [SITE + '/profiles*', SITE + '/static/*', SITE + '/lock/*', SITE + '/'],
  handle(req) {
    const u = new URL(req.url), p = u.pathname;
    if (u.origin !== SITE || p.startsWith('/A1/')) return null;
    if (p === '/profiles') return { text: gatePage(), type: 'text/html' };
    if (p === '/') return { text: '<!DOCTYPE html><title>ORCA app</title><body>APP</body>', type: 'text/html' };
    if (p.startsWith('/static/')) {
      const f = path.join(ORCA, 'app', 'web', 'static', p.slice('/static/'.length));
      if (!fs.existsSync(f)) return { status: 404, text: '' };
      return { text: fs.readFileSync(f, 'utf8'), type: f.endsWith('.css') ? 'text/css' : 'text/javascript' };
    }
    const b = req.postData ? JSON.parse(req.postData) : {}, id = b.profile;
    S.calls.push(p + (b.what ? ':' + b.what : ''));
    switch (p) {
      case '/lock/status': return { json: { ok: true, hasLock: !!S.pw[id], unlocked: S.held.has(id), bio: [] } };
      case '/lock/enter': return S.held.has(id) ? { json: { ok: true } } : { status: 401, json: { ok: false, error: 'locked' } };
      case '/lock/unlock':
        if (!S.pw[id]) return { status: 409, json: { ok: false, error: 'nolock' } };
        if (b.password !== S.pw[id]) return { status: 401, json: { ok: false, error: 'wrong' } };
        S.held.add(id); return { json: { ok: true } };
      case '/lock/change':
        if (b.current !== S.pw[id]) return { status: 401, json: { ok: false, error: 'wrong' } };
        S.pw[id] = b.password; return { json: { ok: true } };
      case '/lock/setup': S.pw[id] = b.password; S.held.add(id); return { json: { ok: true } };
      case '/lock/forgot': return { json: { ok: true, [b.what]: { ok: true, emailed: true, to: 'v***@gmail.com' } } };
      case '/lock/reset':
        if (b.code !== 'ABC234') return { status: 400, json: { ok: false, error: 'badcode' } };
        S.pw[id] = b.password; S.held.add(id); return { json: { ok: true } };
      case '/lock/lock': S.held.delete(id); return { json: { ok: true } };
      case '/lock/remove': return { status: 403, json: { ok: false, error: 'refused' } };
    }
    return { status: 404, json: { ok: false } };
  },
};

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 300)); });
  const js = (e) => evalJs(c, e.trim().indexOf('return') === 0 && e.indexOf(';') < 0 ? e + ';' : e);
  const sr = `document.querySelector('guardian-lock') && document.querySelector('guardian-lock').shadowRoot`;
  const dlg = () => js(`const s = ${sr}; const ov = s && s.querySelector('.ov');
    return JSON.stringify(ov ? { open: true, theme: ov.dataset.theme, text: s.querySelector('.card').innerText, err: (s.querySelector('.err')||{}).textContent||'',
      buttons: [...s.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean), eyes: s.querySelectorAll('.pw .eye').length } : { open: false });`).then(JSON.parse);
  const gtype = (ph, v) => js(`const s = ${sr}; const i = [...s.querySelectorAll('input')].find(i => i.placeholder === ${JSON.stringify(ph)}); if (!i) return 'missing'; i.value = ${JSON.stringify(v)}; return 1;`);
  const gclick = (t) => js(`const s = ${sr}; const b = [...s.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(t)}); if (!b) return 'missing'; b.click(); return 1;`).then(async (r) => { await sleep(700); return r; });
  const where = () => js('return location.pathname;');
  const gateUp = async () => {
    await c.send('Page.navigate', { url: SITE + '/profiles' });
    for (let i = 0; i < 20 && !(await js('return !!window.Guardian;')); i++) await sleep(250);
    await sleep(500);
  };
  const pick = (id) => js(`document.querySelector('.gate-card[data-profile="${id}"]').click(); return 1;`).then(() => sleep(900));

  console.log('\nPicking a locked profile');
  await gateUp();
  ok('the picker draws both cards', (await js(`return document.querySelectorAll('.gate-card').length;`)) === 2);
  await pick('tony');
  let d = await dlg();
  ok("Tony's card asks, in Tony's theme, with the eye", d.open && d.theme === 'tony' && /Tony’s ORCA/.test(d.text) && d.eyes === 1, JSON.stringify(d));
  ok('…and no "Remove lock" anywhere (refused on the internet)', !d.buttons.includes('Remove lock'));
  await gtype('Password', 'nope'); await gclick('Unlock');
  ok('a wrong password is refused', (await dlg()).open && /Wrong password/.test((await dlg()).err), (await dlg()).err);
  await gtype('Password', 'tpw'); await gclick('Unlock'); await sleep(600);
  ok('the right one gets the session and opens ORCA', S.held.has('tony') && (await where()) === '/');

  console.log('\nA profile this device holds');
  await gateUp(); await pick('tony'); await sleep(400);
  ok('opens with no password (/lock/enter)', (await where()) === '/' && S.calls.includes('/lock/enter'));

  console.log("\nVeda: hint and reset");
  await gateUp(); await pick('veda');
  d = await dlg();
  ok("Veda's card wears her theme", d.open && d.theme === 'veda' && /Veda’s ORCA/.test(d.text), JSON.stringify(d));
  await gclick('Email me my hint');
  ok('the hint goes through ORCA\'s /lock/forgot', S.calls.includes('/lock/forgot:hint'));
  await gclick('Reset password'); await gclick('Email me a code');
  ok('the reset code too', S.calls.includes('/lock/forgot:reset') && /Check your email/i.test((await dlg()).text));
  await gtype('6-character code', 'ABC234'); await gtype('New password', 'v2'); await gtype('Confirm new password', 'v2');
  await gclick('Reset password'); await sleep(300);
  await gclick('OK'); await sleep(600);
  ok('reset sets her new password and opens ORCA', S.pw.veda === 'v2' && S.held.has('veda') && (await where()) === '/');

  console.log('\nThe app padlock (?manage=1)');
  S.current = 'tony'; S.manage = true;
  await gateUp();
  d = await dlg();
  ok("Guardian's menu for the current profile, without Remove lock", d.open && d.buttons.includes('Lock this device now') && d.buttons.includes('Change password') && !d.buttons.includes('Remove lock'), JSON.stringify(d.buttons));
  await gclick('Change password');
  await gtype('Current password', 'tpw'); await gtype('New password', 't2'); await gtype('Confirm new password', 't2');
  await gclick('Change password');
  ok('change is ORCA\'s /lock/change with the current password', S.pw.tony === 't2' && S.calls.includes('/lock/change'));
  await gclick('OK'); await sleep(600);
  S.calls.length = 0;
  await gateUp();
  await gclick('Lock this device now'); await sleep(900);
  d = await dlg();
  ok('lock now clears the session and asks again', !S.held.has('tony') && S.calls.includes('/lock/lock') && d.open && d.buttons.includes('Unlock'), JSON.stringify(d));
  await gtype('Password', 't2'); await gclick('Unlock'); await sleep(600);
  ok('the new password opens it again', (await where()) === '/');
  S.manage = false;

  console.log('\nPhone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  S.held.clear(); await gateUp(); await pick('veda');
  ok('the card fits a phone with no sideways scroll', await js(`const s = ${sr}, r = s.querySelector('.card').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;`));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
