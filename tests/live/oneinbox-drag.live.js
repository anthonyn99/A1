// Theme overhaul phase 3: OneInbox in MAGI's look, its account list on
// dragsort.js (MAGI's drag) and its signature boxes on resizegrip.js (MAGI's
// corner grip). Real mouse, keyboard and touch input over CDP, asserting the
// order OneInbox actually SAVES (localStorage oneinbox_acct_order and the
// Firestore write), not just the DOM.
//
// OneInbox needs its mail worker and Firebase, so both are faked here: the
// worker answers three accounts and a few messages, Firebase is a no-op module
// that records setDoc calls in window.__fsWrites. Nothing leaves the machine.
//
//   1. theme: MAGI tokens, solid purple Compose, purple wordmark, magi hover
//   2. desktop: rows carry a real grip button, no old svg grip
//   3. desktop: mouse-drag a row by its label, saved + synced order change,
//      the drop's click does not select the account, a plain click does
//   4. desktop: ↑/↓ on a focused grip moves the row and keeps focus on it;
//      a click on a grip never selects the account
//   5. phone width: a finger on the row scrolls, a finger on the grip drags
//   6. the signature box has MAGI's grip: drag, click toggle, reload keeps it
//
// Run:          node tests/live/oneinbox-drag.live.js
// Shots only:   node tests/live/oneinbox-drag.live.js --shots <label>
//               (with A1_ROOT=<worktree> for a "before" of an older tag)
'use strict';
process.env.CDP_ALLOW_FONTS = '1';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io';
const SHOTS = process.argv[2] === '--shots' ? (process.argv[3] || 'oneinbox') : null;

const ACCTS = ['alpha@example.com', 'bravo@example.com', 'charlie@example.com'];
const T0 = 1790000000000;
const MSGS = (acct) => [
  { id: acct[0] + '1', account: acct, from: 'Parcel Desk <parcels@shop.example>', subject: 'Your package is out for delivery', snippet: 'Arriving today between 2 and 6pm.', date: String(T0 - 3600e3), unread: true },
  { id: acct[0] + '2', account: acct, from: 'Electric Co <billing@power.example>', subject: 'Your October statement is ready', snippet: 'Amount due $84.12 by Oct 21.', date: String(T0 - 86400e3), unread: false },
];

const FB = `
export const initializeApp = () => ({});
export const getAuth = () => ({});
export const signInAnonymously = () => Promise.resolve({ user: { uid: 't' } });
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb({ uid: 't' }), 0); return () => {}; };
export const initializeAppCheck = () => ({});
export class ReCaptchaV3Provider {}
export const initializeFirestore = () => ({});
export const persistentLocalCache = () => ({});
export const persistentSingleTabManager = () => ({});
export const doc = (db, ...p) => ({ path: p.join('/') });
export const collection = (db, ...p) => ({ path: p.join('/') });
export const query = (c) => c;
export const orderBy = () => ({});
export const limit = () => ({});
export const getDoc = () => Promise.resolve({ exists: () => false, data: () => ({}) });
export const setDoc = (ref, data) => { (window.__fsWrites = window.__fsWrites || []).push({ path: ref.path, data }); return Promise.resolve(); };
export const onSnapshot = () => () => {};
`;

const mock = {
  patterns: ['https://oneinbox-api.av1.workers.dev/*', 'https://taskhub-reminders.av1.workers.dev/*'],
  handle(req) {
    if (req.url.startsWith('https://www.gstatic.com/firebasejs/')) return { text: FB, type: 'text/javascript' };
    const api = /^https:\/\/(oneinbox-api|taskhub-reminders)\.av1\.workers\.dev(\/[^?]*)/.exec(req.url);
    if (!api) return null;
    if (req.method === 'OPTIONS') return { status: 204, json: null };
    const body = (() => { try { return JSON.parse(req.postData || '{}'); } catch { return {}; } })();
    switch (api[2]) {
      case '/accounts': return { json: { ok: true, accounts: ACCTS.map((email) => ({ email, name: email.split('@')[0], signature: '' })) } };
      case '/gmail/list': return { json: { ok: true, messages: MSGS(body.account || ACCTS[0]) } };
      case '/gmail/labels': return { json: { ok: true, labels: [] } };
      case '/gmail/message': return { json: { ok: true, message: { id: body.id, labelIds: [], attachments: [],
        html: '<p>Hi Tony,</p><p>Your package is out for delivery and should arrive today between 2 and 6pm.</p>', text: '' } } };
      default: return { json: { ok: true } };
    }
  },
};

const shown = (c) => evalJs(c, "return JSON.stringify([...document.querySelectorAll('#navAccounts .navitem[data-acct]')].map(r=>r.dataset.acct).filter(a=>a!=='all'));").then(JSON.parse);
const saved = (c) => evalJs(c, "return localStorage.getItem('oneinbox_acct_order')||'[]';").then(JSON.parse);
const synced = (c) => evalJs(c, "var w=(window.__fsWrites||[]).filter(x=>x.data&&x.data.acctOrder); return JSON.stringify(w.length?w[w.length-1].data.acctOrder:null);").then(JSON.parse);
const active = (c) => evalJs(c, "var a=document.querySelector('#navAccounts .navitem.active'); return a?a.dataset.acct:'';");
const rect = async (c, js) => JSON.parse(await evalJs(c, `return JSON.stringify((() => { const e = (${js}); if (!e) return null; const b = e.getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, top: b.top}; })());`));
const row = (a) => `document.querySelector('#navAccounts .navitem[data-acct="${a}"]')`;
const css = (c, sel, prop) => evalJs(c, `var e=document.querySelector(${JSON.stringify(sel)}); return e?getComputedStyle(e)[${JSON.stringify(prop)}]:'(none)';`);

async function mouseDrag(c, x, y, dx, dy, steps = 16) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
  await sleep(500);
}
async function click(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(400);
}
async function touchDrag(c, x, y, dy, steps = 16) {
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / steps }] });
    await sleep(16);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
}
async function load(c, w, h, mobile, keepStorage) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  if (!keepStorage) {
    await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html?blank' }); await sleep(800);
    await evalJs(c, "localStorage.clear(); localStorage.setItem('oneinbox_lock_session', JSON.stringify({token:'test'})); 1");
  }
  await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html' });
  await sleep(2500);
}
async function shot(c, name, w, h) {
  if (w) { await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 }); await sleep(500); }
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const f = shotPath(SHOTS + '-' + name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log('shot', f);
}

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  // A service worker left in the shared test profile would serve a stale page
  // behind the interception; clear the origin and bypass any worker.
  await c.send('Network.setBypassServiceWorker', { bypass: true });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });

  if (SHOTS) {
    await load(c, 1440, 900, false);
    await evalJs(c, "var r=document.querySelector('.msgrow'); if(r) r.click(); 1"); await sleep(900);
    await shot(c, 'desktop');
    await evalJs(c, "document.getElementById('settingsBtn').click(); 1"); await sleep(600);
    await shot(c, 'settings');
    await evalJs(c, "document.getElementById('settingsModal').classList.remove('open'); var l=document.querySelector('a1-lifehub'); var b=l&&(l.shadowRoot||l).querySelector('button'); if(b) b.click(); 1"); await sleep(1500);
    await shot(c, 'lifehub');
    await load(c, 400, 860, true);
    await shot(c, 'mobile');
    await evalJs(c, "document.body.classList.add('drawer'); 1"); await sleep(500);
    await shot(c, 'mobile-drawer');
    c.ws.close(); process.exit(0);
  }

  // ── 1. theme ──
  await load(c, 1440, 900, false);
  console.log('theme');
  ok('body opts into MAGI hover', (await evalJs(c, "return document.body.dataset.hoverfx;")) === 'magi');
  ok('Compose is a solid purple fill', (await css(c, '#composeBtn', 'backgroundColor')) === 'rgb(192, 174, 234)');
  ok('Compose label is dark', (await css(c, '#composeBtn', 'color')) === 'rgb(26, 26, 29)');
  ok('wordmark is #dbd0f5', (await css(c, 'header .brand', 'color')) === 'rgb(219, 208, 245)');
  ok('UI face is Inter', /Inter/.test(await css(c, 'body', 'fontFamily')));
  ok('buttons use MAGI type (10px, 700)', (await css(c, '#composeBtn', 'fontSize')) === '10px' && (await css(c, '#composeBtn', 'fontWeight')) === '700');
  ok('active nav row is solid, purple-edged', (await css(c, '#navFolders .navitem.active', 'backgroundColor')) === 'rgb(44, 44, 49)'
    && /192, 174, 234/.test(await css(c, '#navFolders .navitem.active', 'boxShadow')));
  const grads = await evalJs(c, "return [...document.querySelectorAll('#app *')].filter(e=>/gradient\\(/.test(getComputedStyle(e).backgroundImage)).map(e=>e.className||e.tagName).join(',');");
  ok('no gradient fills in the app', grads === '', grads);
  const gold = await evalJs(c, "return [...document.querySelectorAll('#app *')].filter(e=>{var s=getComputedStyle(e);return /224, 184, 116/.test(s.color+s.backgroundColor+s.borderColor+s.boxShadow);}).map(e=>e.className||e.id||e.tagName).join(',');");
  ok('nothing on screen is gold', gold === '', gold);
  {
    const p = await rect(c, "document.getElementById('composeBtn')");
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await sleep(300);
    const hv = await evalJs(c, "return document.getElementById('composeBtn').style.filter;");
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await sleep(80);
    const pr = await evalJs(c, "var b=document.getElementById('composeBtn'); return b.style.filter+' '+b.style.translate;");
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 895, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 }); await sleep(300);
    await evalJs(c, "var m=document.getElementById('composeModal'); if(m) m.classList.remove('open'); 1");
    ok('hover lifts brightness(1.15)', hv === 'brightness(1.15)', hv);
    ok('press is brightness(0.94) + 1px', /brightness\(0\.94\)/.test(pr) && /1px/.test(pr), pr);
  }

  // ── 2. grips ──
  console.log('desktop');
  ok('three accounts drawn', JSON.stringify(await shown(c)) === JSON.stringify(ACCTS), await shown(c));
  ok('each account row has a real grip button',
    (await evalJs(c, "return [...document.querySelectorAll('#navAccounts .navitem[data-dkey]')].every(r=>r.querySelector('button.dsort-grip'))+'';")) === 'true');
  ok('the old svg grip is gone', (await evalJs(c, "return document.querySelectorAll('#navAccounts svg.grip').length;")) === 0);
  ok('"All accounts" is not draggable', (await evalJs(c, "return !document.querySelector('#navAccounts .navitem[data-acct=all] .dsort-grip')+'';")) === 'true');

  // ── 3. mouse drag ──
  {
    const a = await rect(c, row(ACCTS[0]) + ".querySelector('.lbl')");
    const z = await rect(c, row(ACCTS[2]));
    await mouseDrag(c, a.x - 30, a.y, 0, z.y - a.y + z.h * 0.4);
    const want = [ACCTS[1], ACCTS[2], ACCTS[0]];
    ok('mouse drag reorders the list', JSON.stringify(await shown(c)) === JSON.stringify(want), await shown(c));
    ok('the order is saved on the device', JSON.stringify(await saved(c)) === JSON.stringify(want), await saved(c));
    await sleep(300);
    ok('the order is written to Firestore', JSON.stringify(await synced(c)) === JSON.stringify(want), await synced(c));
    ok('the drop did not select the account', (await active(c)) === 'all', await active(c));
    const b = await rect(c, row(ACCTS[1]) + ".querySelector('.lbl')");
    await click(c, b.x, b.y);
    ok('a plain click selects the account', (await active(c)) === ACCTS[1], await active(c));
  }

  // ── 4. keyboard + grip click ──
  {
    await evalJs(c, `${row(ACCTS[1])}.querySelector('.dsort-grip').focus(); 1`);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await sleep(400);
    const want = [ACCTS[2], ACCTS[1], ACCTS[0]];
    ok('ArrowDown on a grip moves the row', JSON.stringify(await saved(c)) === JSON.stringify(want), await saved(c));
    ok('focus stays on the moved row\'s grip', (await evalJs(c, "var g=document.activeElement; return g&&g.classList.contains('dsort-grip')?g.closest('[data-acct]').dataset.acct:'';")) === ACCTS[1]);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 120, y: 240 });
    const g = await rect(c, row(ACCTS[0]) + ".querySelector('.dsort-grip')");
    await click(c, g.x, g.y);
    ok('a click on a grip does not select its account', (await active(c)) === ACCTS[1], await active(c));
  }

  // ── 5. phone ──
  console.log('phone');
  await load(c, 400, 860, true, true);
  await evalJs(c, "document.body.classList.add('drawer'); 1"); await sleep(500);
  {
    const before = await saved(c);
    const a = await rect(c, row(before[0]) + ".querySelector('.lbl')");
    const z = await rect(c, row(before[2]));
    await touchDrag(c, a.x, a.y, z.y - a.y + z.h * 0.4);
    ok('a finger on the row does not reorder', JSON.stringify(await saved(c)) === JSON.stringify(before), await saved(c));
    const gp = await rect(c, row(before[0]) + ".querySelector('.dsort-grip')");
    ok('the grip is visible on touch', (await css(c, '#navAccounts .dsort-grip', 'opacity')) !== '0');
    const z2 = await rect(c, row(before[2]));
    await touchDrag(c, gp.x, gp.y, z2.y - gp.y + z2.h * 0.4);
    const want = [before[1], before[2], before[0]];
    ok('a finger on the grip reorders', JSON.stringify(await saved(c)) === JSON.stringify(want), await saved(c));
  }

  // ── 6. signature resize ──
  console.log('resize');
  await load(c, 1440, 900, false, true);
  await evalJs(c, "document.getElementById('settingsBtn').click(); 1"); await sleep(700);
  const ta = "document.querySelector('textarea[data-sig]')";
  ok('the signature box has MAGI\'s grip', (await evalJs(c, `return !!${ta}.parentElement.querySelector('button.a1-grip')+'';`)) === 'true');
  ok('no native resize corner', (await evalJs(c, `return getComputedStyle(${ta}).resize;`)) === 'none');
  {
    const h0 = (await rect(c, ta)).h;
    const g = await rect(c, `${ta}.parentElement.querySelector('.a1-grip')`);
    await mouseDrag(c, g.x, g.y, 0, 90);
    const h1 = (await rect(c, ta)).h;
    ok('dragging the grip grows the box', Math.abs(h1 - (h0 + 90)) <= 3, h0 + ' -> ' + h1);
    ok('the height is remembered', !!(await evalJs(c, "return localStorage.getItem('a1.h.oi.sig');")));
    await click(c, g.x, g.y + 90);
    const h2 = (await rect(c, ta)).h;
    ok('a click hands it back to auto', Math.abs(h2 - h0) <= 3 && !(await evalJs(c, `return ${ta}.dataset.userH||'';`)), h2);
    const g2 = await rect(c, `${ta}.parentElement.querySelector('.a1-grip')`);
    await mouseDrag(c, g2.x, g2.y, 0, 60);
    const h3 = (await rect(c, ta)).h;
    await load(c, 1440, 900, false, true);
    await evalJs(c, "document.getElementById('settingsBtn').click(); 1"); await sleep(700);
    const h4 = (await rect(c, ta)).h;
    ok('a reload keeps the chosen height', Math.abs(h4 - h3) <= 2, h3 + ' vs ' + h4);
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
