// Theme overhaul phase 7 (docs/theme-overhaul-plan.md): Vault and the Vault
// Launcher extension are MAGI. Real mouse and touch input over CDP, asserting
// what Vault SAVES.
//
//   node tests/live/vault-theme.live.js                 the checks
//   node tests/live/vault-theme.live.js --shots <label> also a shot of each view
//
// Three pages, all served from this working copy by cdp.js (Firebase blocked):
//   vault.html                     the theme, the numbers face, Keychain's card
//                                  and link drags (edit mode, mouse + held
//                                  finger), the header buttons, the uiModal, the
//                                  connection modal's resize grip
//   tests/live/vault-harness.html  the Secure Notes list (the one reorder engine
//                                  Payments and API Keys share) and the tab bar
//   Vault/popup.html               the Launcher: theme + Reorder-mode card drag,
//                                  with chrome.* and the keychain Worker stubbed
'use strict';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

const ORIGIN = 'https://anthonyn99.github.io';
const APP = ORIGIN + '/A1/vault.html';
const HARNESS = ORIGIN + '/A1/tests/live/vault-harness.html';
const POPUP = ORIGIN + '/A1/Vault/popup.html';
const SHOTS = process.argv[2] === '--shots' ? (process.argv[3] || 'vault') : null;
const MASTER = 'correct horse battery staple';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 500) : '')); }
};

// Four connections: two per column, each with links (one has an email row too).
const link = (n) => ({ type: 'link', name: n, url: 'https://' + n.toLowerCase() + '.example.com' });
const CONNS = [
  { name: 'Alpha', color: '#a3c8ec', items: [link('A1'), link('A2'), { type: 'email', value: 'a@example.com' }] },
  { name: 'Bravo', color: '#cfe39c', items: [link('B1')] },
  { name: 'Charlie', color: '#f1b0c4', items: [link('C1'), link('C2')] },
  { name: 'Delta', color: '#c3aee6', items: [link('D1')] },
];
const COLMAP = [0, 0, 1, 1];

async function waitFor(c, expr, ms) {
  const end = Date.now() + (ms || 8000);
  while (Date.now() < end) {
    try { if (await evalJs(c, 'return !!(' + expr + ');')) return true; } catch (e) {}
    await sleep(120);
  }
  return false;
}
const rect = (c, js) => evalJs(c, `var e=(${js}); if(!e) return null; var r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2, l:r.left, t:r.top, w:r.width, h:r.height};`);
async function mouseDrag(c, x, y, dx, dy, steps = 18) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
  await sleep(450);
}
async function click(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(400);
}
async function touchDrag(c, x, y, dx, dy, holdMs, steps = 16) {
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  if (holdMs) await sleep(holdMs);
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] });
    await sleep(16);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(600);
}
async function view(c, w, h, mobile) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 0 });
  await sleep(200);
}
async function shot(c, name) {
  if (!SHOTS) return;
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const f = shotPath(SHOTS + '-' + name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log('  shot ' + f);
}
async function go(c, url) {
  await c.send('Page.navigate', { url });
  await sleep(900);
}
async function openApp(c) {
  await go(c, APP);
  return waitFor(c, `document.querySelectorAll('#kc-conns-list .kc-card').length === 4`, 10000);
}
const saved = (c) => evalJs(c, `return JSON.stringify({ names: JSON.parse(localStorage.getItem('kc_connections')||'[]').map(function(x){return x.name+':'+(x.items||[]).map(function(i){return i.name||i.value;}).join('|');}), colmap: JSON.parse(localStorage.getItem('kc_colmap')||'null') });`).then(JSON.parse);
const cols = (c) => evalJs(c, `return JSON.stringify([].map.call(document.querySelectorAll('#kc-conns-list .kc-col'), function(col){ return [].map.call(col.querySelectorAll('.kc-card .kc-card-name'), function(n){ return n.textContent; }); }));`).then(JSON.parse);
const card = (name) => `[...document.querySelectorAll('#kc-conns-list .kc-card')].find(function(k){ return k.querySelector('.kc-card-name').textContent === '${name}'; })`;
const row = (name) => `[...document.querySelectorAll('#kc-conns-list .kc-item-row')].find(function(r){ return r.querySelector('.kc-link-name') && r.querySelector('.kc-link-name').textContent === '${name}'; })`;

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Network.setBypassServiceWorker', { bypass: true });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const errors = [];
  c.on && c.on('Runtime.exceptionThrown', (m) => errors.push(m.exceptionDetails && (m.exceptionDetails.exception && m.exceptionDetails.exception.description || m.exceptionDetails.text)));

  await view(c, 1280, 900, false);
  await go(c, APP + '?blank');
  await evalJs(c, `localStorage.clear(); localStorage.setItem('kc_connections', ${JSON.stringify(JSON.stringify(CONNS))}); localStorage.setItem('kc_colmap', ${JSON.stringify(JSON.stringify(COLMAP))}); return 1;`);
  ok('vault.html boots with the four seeded connections', await openApp(c));

  console.log('\nTheme');
  const th = JSON.parse(await evalJs(c, `var cs=function(s){var e=document.querySelector(s);return e?getComputedStyle(e):null;};
    var root=getComputedStyle(document.getElementById('kc-root'));
    return JSON.stringify({ ac: root.getPropertyValue('--ac').trim(), acp: root.getPropertyValue('--acp').trim(),
      logo: cs('.kc-logo').color, logoText: (cs('.kc-logo .dot')||cs('.kc-logo')).color, title: cs('.kc-section-title').color, titleFont: cs('.kc-section-title').fontFamily, titleW: cs('.kc-section-title').fontWeight,
      hover: document.body.getAttribute('data-hoverfx'), hbtn: cs('.kc-hbtn').fontSize + ' ' + cs('.kc-hbtn').fontWeight + ' ' + cs('.kc-hbtn').textTransform,
      newBtn: cs('.kc-new-btn.accent').backgroundColor + ' ' + cs('.kc-new-btn.accent').color,
      num: getComputedStyle(document.body).fontVariantNumeric, btnNum: cs('.kc-hbtn').fontVariantNumeric, bodyFont: getComputedStyle(document.body).fontFamily,
      fraunces: !!document.querySelector('link[href*="Fraunces"]') });`));
  ok('MAGI purple accent', th.ac === '#c0aeea', th);
  ok('wordmark is #dbd0f5', th.logo === 'rgb(219, 208, 245)' && th.logoText === th.logo, th);
  ok('section title is a MAGI panel title (Manrope 800, acl)', /Manrope/.test(th.titleFont) && th.titleW === '800' && th.title === 'rgb(219, 208, 245)', th);
  ok('buttons are MAGI\'s .btn type (10px, 700, uppercase)', th.hbtn === '10px 700 uppercase', th.hbtn);
  ok('New Connection (selected/primary) is solid purple with a dark label', th.newBtn === 'rgb(192, 174, 234) rgb(26, 26, 29)', th.newBtn);
  ok('hover mechanics: <body data-hoverfx="magi">', th.hover === 'magi');
  ok('NUMBERS: body + controls are tabular, the face is Inter', th.num === 'tabular-nums' && th.btnNum === 'tabular-nums' && /^"?Inter/.test(th.bodyFont), th);
  ok('no Fraunces loaded', !th.fraunces);
  const grads = JSON.parse(await evalJs(c, `var out=[]; document.querySelectorAll('#kc-root *, #applock-overlay').forEach(function(e){ var b=getComputedStyle(e).backgroundImage; if(/gradient/.test(b) && !e.closest('.vpay-face')) out.push((e.id||e.className||e.tagName)+''); }); return JSON.stringify(out.slice(0,8));`));
  ok('no gradient fills', !grads.length, grads);
  const gold = JSON.parse(await evalJs(c, `var out=[]; document.querySelectorAll('#kc-root *').forEach(function(e){ var s=getComputedStyle(e); [s.color,s.borderTopColor,s.backgroundColor].forEach(function(v){ if(/224, 184, 116/.test(v)) out.push(e.className||e.tagName); }); }); return JSON.stringify(out.slice(0,8));`));
  ok('no gold left on the Keychain screen', !gold.length, gold);
  await shot(c, 'keychain');

  console.log('\nKeychain cards (edit mode, mouse)');
  ok('view mode: a card does not drag', await (async () => {
    const a = await rect(c, card('Alpha') + '.querySelector(".kc-card-name")');
    await mouseDrag(c, a.x, a.y, 0, 160);
    return JSON.stringify(await cols(c)) === JSON.stringify([['Alpha', 'Bravo'], ['Charlie', 'Delta']]);
  })(), await cols(c));
  await evalJs(c, `kcToggleMode(); return 1;`);
  ok('no grip dots on cards or rows', await evalJs(c, `return !document.querySelector('.kc-drag-handle, .kc-item-handle, .dsort-grip');`));
  ok('every column is an A1Drag list', await evalJs(c, `return [].every.call(document.querySelectorAll('#kc-conns-list .kc-col'), function(l){ return l.classList.contains('dsort'); });`));
  let a = await rect(c, card('Alpha') + '.querySelector(".kc-card-name")');
  let b = await rect(c, card('Bravo'));
  await mouseDrag(c, a.x, a.y, 0, b.t + b.h - a.t - 8);
  let s1 = await saved(c);
  ok('a card drags down its column (by its name)', JSON.stringify(await cols(c)) === JSON.stringify([['Bravo', 'Alpha'], ['Charlie', 'Delta']]), await cols(c));
  ok('...and the order is SAVED', s1.names[0].startsWith('Bravo') && s1.names[1].startsWith('Alpha'), s1);
  a = await rect(c, card('Alpha') + '.querySelector(".kc-card-name")');
  const d = await rect(c, card('Delta'));
  await mouseDrag(c, a.x, a.y, d.x - a.x, d.t + d.h - a.y + 10);
  s1 = await saved(c);
  ok('a card moves across to the other column', JSON.stringify(await cols(c)) === JSON.stringify([['Bravo'], ['Charlie', 'Delta', 'Alpha']]), await cols(c));
  ok('...saved: reading order + column map', JSON.stringify(s1.colmap) === '[0,1,1,1]' && s1.names[3].startsWith('Alpha'), s1);

  console.log('\nLink rows (edit mode)');
  const r1 = await rect(c, row('C1') + '.querySelector(".kc-link-name")');
  const r2 = await rect(c, row('C2'));
  await mouseDrag(c, r1.x, r1.y, 0, r2.h + 4);
  s1 = await saved(c);
  ok('a link row drags within its card, not the card around it', s1.names.find((n) => n.startsWith('Charlie')) === 'Charlie:C2|C1' && JSON.stringify(await cols(c)) === JSON.stringify([['Bravo'], ['Charlie', 'Delta', 'Alpha']]), s1);
  const ra = await rect(c, row('A1') + '.querySelector(".kc-link-name")');
  const bb = await rect(c, card('Bravo') + '.querySelector(".kc-items")');
  await mouseDrag(c, ra.x, ra.y, bb.x - ra.x, bb.t + bb.h - ra.y - 4);
  s1 = await saved(c);
  ok('a link row moves into another card', s1.names.find((n) => n.startsWith('Bravo')) === 'Bravo:B1|A1' && s1.names.find((n) => n.startsWith('Alpha')) === 'Alpha:A2|a@example.com', s1);
  let clicks = await evalJs(c, `window.__kcOpened=[]; window.kcVisit=function(u){ window.__kcOpened.push(u); }; return 1;`);
  const vb = await rect(c, row('B1') + '.querySelector(".kc-icon-btn.visit")');
  await mouseDrag(c, vb.x, vb.y, 0, 60);
  ok('a press on a row\'s button is the button\'s, not a drag', (await saved(c)).names.find((n) => n.startsWith('Bravo')) === 'Bravo:B1|A1');
  await click(c, vb.x, vb.y);
  ok('...and it still clicks', (await evalJs(c, `return window.__kcOpened.length;`)) >= 1, await evalJs(c, `return window.__kcOpened;`));

  console.log('\nHeader buttons');
  const hk0 = await evalJs(c, `return [].map.call(document.querySelectorAll('#kc-hbar-actions > [data-hk]'), function(b){ return b.dataset.hk; }).join(',');`);
  const h1 = await rect(c, `document.querySelector('#kc-hbar-actions > [data-hk]')`);
  const h2 = await rect(c, `document.querySelectorAll('#kc-hbar-actions > [data-hk]')[1]`);
  await mouseDrag(c, h1.x, h1.y, h2.x - h1.x + h2.w / 2, 0);
  const hk1 = await evalJs(c, `return [].map.call(document.querySelectorAll('#kc-hbar-actions > [data-hk]'), function(b){ return b.dataset.hk; }).join(',');`);
  ok('header buttons reorder by drag (A1Drag)', hk0.split(',').reverse().join(',') === hk1, hk0 + ' -> ' + hk1);
  ok('...and the drop did not click the button', await evalJs(c, `return getComputedStyle(document.getElementById('applock-overlay')).display === 'none' && !document.querySelector('#kc-vault-setup-overlay[style*="flex"], .kc-overlay[style*="flex"]');`));

  console.log('\nResize grip (connection modal)');
  await evalJs(c, `kcOpenEdit(0); return 1;`);
  await sleep(500);
  const ta = `document.getElementById('kc-f-info')`;
  ok('Additional Info has MAGI\'s grip (no native corner)', await evalJs(c, `var t=${ta}; return !!t.parentElement.querySelector(':scope > .a1-grip') && getComputedStyle(t).resize === 'none';`));
  const g = await rect(c, `${ta}.parentElement.querySelector(':scope > .a1-grip')`);
  const t0 = await rect(c, ta);
  if (g) await mouseDrag(c, g.x + 8, g.y + 8, 0, 70);
  const t1 = await rect(c, ta);
  ok('grip drag grows the box ~70px', t0 && t1 && Math.abs(t1.h - t0.h - 70) <= 6, t0 && t1 && (t0.h + ' -> ' + t1.h));
  ok('height stored per box (a1.h.vault.kc-f-info)', (await evalJs(c, `return localStorage.getItem('a1.h.vault.kc-f-info');`)) === String(Math.round(t1.h)), await evalJs(c, `return Object.keys(localStorage).filter(function(k){return k.indexOf('a1.h.')===0;});`));
  const mod = JSON.parse(await evalJs(c, `var m=document.querySelector('.kc-modal'), o=document.querySelector('.kc-overlay'); return JSON.stringify({ bg: getComputedStyle(m).backgroundColor, ov: getComputedStyle(o).backgroundColor, blur: getComputedStyle(o).backdropFilter, title: getComputedStyle(document.querySelector('.kc-modal-title')).color });`));
  ok('connection modal is MAGI\'s dialog (s1 box, .62 backdrop, 2px blur)', mod.bg === 'rgb(35, 35, 39)' && /0\.62/.test(mod.ov) && /blur\(2px\)/.test(mod.blur), mod);
  await shot(c, 'connection-modal');
  await evalJs(c, `kcCloseModal(); return 1;`);

  console.log('\nuiModal');
  await evalJs(c, `uiConfirm('Delete this?', { title: 'Confirm' }); return 1;`);
  await sleep(300);
  const um = JSON.parse(await evalJs(c, `var ok=document.getElementById('uim-ok'); return JSON.stringify({ bg: getComputedStyle(ok).backgroundColor, color: getComputedStyle(ok).color, box: getComputedStyle(document.getElementById('uim-box')).backgroundColor });`));
  ok('uiModal OK is solid purple with a dark label, on an s1 box', um.bg === 'rgb(192, 174, 234)' && um.color === 'rgb(26, 26, 29)' && um.box === 'rgb(35, 35, 39)', um);
  await shot(c, 'uimodal');
  await evalJs(c, `document.getElementById('uim-cancel').click(); return 1;`);

  console.log('\nPhone: held finger vs swipe');
  await view(c, 390, 844, true);
  await openApp(c);
  await evalJs(c, `if(!document.getElementById('kc-root').classList.contains('edit-mode')) kcToggleMode(); return 1;`);
  await sleep(300);
  const before = JSON.stringify(await cols(c));
  const p1 = await rect(c, `document.querySelectorAll('#kc-conns-list .kc-card')[1].querySelector('.kc-card-name')`);
  const p2 = await rect(c, `document.querySelectorAll('#kc-conns-list .kc-card')[1]`);
  await evalJs(c, `document.getElementById('kc-root').scrollTop = 120; return 1;`);
  await sleep(200);
  await touchDrag(c, p1.x, p1.y + 200, 0, -(p2.h + 20), 0);
  ok('a quick swipe on a card scrolls, never drags', JSON.stringify(await cols(c)) === before, await cols(c));
  await evalJs(c, `document.getElementById('kc-root').scrollTop = 0; return 1;`);
  await sleep(200);
  const q1 = await rect(c, `document.querySelectorAll('#kc-conns-list .kc-card')[0].querySelector('.kc-card-name')`);
  const q2 = await rect(c, `document.querySelectorAll('#kc-conns-list .kc-card')[1]`);
  await touchDrag(c, q1.x, q1.y, 0, q2.h + 20, 380);
  const after = await cols(c);
  const first = JSON.parse(before)[0];
  ok('a held finger (300ms) picks a card up and moves it', after[0][0] === first[1] && after[0][1] === first[0], { before, after });
  await shot(c, 'phone');

  console.log('\nSecure Notes list (the shared reorder: Payments, Notes, API Keys)');
  await view(c, 1280, 900, false);
  await go(c, HARNESS + '?vaulttab=sensitive');
  await evalJs(c, `localStorage.clear(); return 1;`);
  await go(c, HARNESS + '?vaulttab=sensitive');
  await waitFor(c, `document.querySelector('#vault-sensitive-panel input[placeholder="Create master password"]')`, 10000);
  await evalJs(c, `var i=document.querySelectorAll('#vault-sensitive-panel input[type=password]'); i[0].value=${JSON.stringify(MASTER)}; i[1].value=${JSON.stringify(MASTER)}; [].find.call(document.querySelectorAll('#vault-sensitive-panel button'), function(b){ return /Create Vault/.test(b.textContent); }).click(); return 1;`);
  await waitFor(c, `document.querySelector('.vault-recovery-code')`, 15000);
  await evalJs(c, `document.getElementById('vault-rec-ack').click(); [].find.call(document.querySelectorAll('button'), function(b){ return /I saved it/.test(b.textContent); }).click(); return 1;`);
  await sleep(600);
  await evalJs(c, `var h=window.Vault.hostCtx(); h.store().saveMany([{kind:'sensitive',title:'Note A',notes:'aaa',order:0},{kind:'sensitive',title:'Note B',notes:'bbb',order:1},{kind:'sensitive',title:'Note C',notes:'ccc',order:2}]).then(function(){ document.querySelector('.vault-tab[data-tab="sensitive"]').click(); }); return 1;`);
  ok('three notes listed', await waitFor(c, `document.querySelectorAll('#vault-sensitive-panel .vault-site').length === 3`));
  const notes = () => evalJs(c, `return [].map.call(document.querySelectorAll('#vault-sensitive-panel .vault-site .vault-row-title'), function(e){ return e.textContent; }).join(',');`);
  const storedNotes = () => evalJs(c, `return window.Vault.hostCtx().store().byKind('sensitive').slice().sort(function(a,b){ return a.order-b.order; }).map(function(i){ return i.title; }).join(',');`);
  ok('no grip buttons on the rows', await evalJs(c, `return !document.querySelector('#vault-sensitive-panel .vault-drag, #vault-sensitive-panel .dsort-grip');`));
  const n0 = await rect(c, `document.querySelectorAll('#vault-sensitive-panel .vault-site .vault-row-title')[0]`);
  const n2 = await rect(c, `document.querySelectorAll('#vault-sensitive-panel .vault-site')[2]`);
  await mouseDrag(c, n0.x, n0.y, 0, n2.t + n2.h - n0.y - 6);
  await sleep(500);
  ok('a note drags by its title row (mouse)', (await notes()) === 'Note B,Note C,Note A', await notes());
  ok('...the new order is SAVED to the store', (await storedNotes()) === 'Note B,Note C,Note A', await storedNotes());
  ok('...and the drop did not open the row', await evalJs(c, `return [].every.call(document.querySelectorAll('#vault-sensitive-panel .vault-rowbody'), function(b){ return b.style.display === 'none'; });`));
  await evalJs(c, `document.querySelectorAll('#vault-sensitive-panel .vault-note-head')[0].click(); return 1;`);
  await sleep(200);
  const body = await rect(c, `document.querySelectorAll('#vault-sensitive-panel .vault-rowbody')[0].querySelector('.vault-note-text')`);
  await mouseDrag(c, body.l + 6, body.y, 0, 120);
  ok('a press in an open row\'s text selects, never drags', (await notes()) === 'Note B,Note C,Note A', await notes());
  await evalJs(c, `var s=document.querySelector('.vault-search'); s.value='Note'; s.dispatchEvent(new Event('input',{bubbles:true})); return 1;`);
  await sleep(500);
  const m0 = await rect(c, `document.querySelectorAll('#vault-sensitive-panel .vault-site .vault-row-title')[0]`);
  await mouseDrag(c, m0.x, m0.y, 0, 140);
  ok('while a search is on, drag is off (positions would be a lie)', (await storedNotes()) === 'Note B,Note C,Note A', await storedNotes());
  await evalJs(c, `var s=document.querySelector('.vault-search'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); return 1;`);
  await sleep(300);
  const tabsTheme = JSON.parse(await evalJs(c, `var t=document.querySelector('.vault-tab.active'); return JSON.stringify({ bg: getComputedStyle(t).backgroundColor, color: getComputedStyle(t).color });`));
  ok('current tab is solid purple with a dark label', tabsTheme.bg === 'rgb(192, 174, 234)' && tabsTheme.color === 'rgb(26, 26, 29)', tabsTheme);
  await shot(c, 'notes');

  console.log('\nLauncher popup');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    if (location.pathname.endsWith('/Vault/popup.html')) {
      window.__puts = [];
      var DOC = { connections: ${JSON.stringify(CONNS)}, colmap: ${JSON.stringify(COLMAP)}, savedAt: 1 };
      var store = { vault_reorder_mode: true };
      var getter = function (k, cb) { var o = {}; [].concat(k || []).forEach(function (x) { if (x in store) o[x] = store[x]; }); if (cb) cb(o); return Promise.resolve(o); };
      window.chrome = { runtime: { lastError: null, sendMessage: function () {}, getURL: function (p) { return p; }, onMessage: { addListener: function () {} } },
        storage: { local: { get: getter, set: function (o, cb) { Object.assign(store, o); if (cb) cb(); return Promise.resolve(); } },
                   session: { get: getter, set: function (o, cb) { if (cb) cb(); return Promise.resolve(); }, remove: function (k, cb) { if (cb) cb(); return Promise.resolve(); } },
                   onChanged: { addListener: function () {} } },
        tabs: { query: function (q, cb) { if (cb) cb([]); return Promise.resolve([]); }, create: function () {}, group: function () {} },
        tabGroups: { update: function () {} } };
      var realFetch = window.fetch;
      window.fetch = function (url, o) {
        if (String(url).indexOf('keychain-sync') >= 0) {
          if (o && o.method === 'PUT') { window.__puts.push(JSON.parse(o.body)); DOC = Object.assign({}, DOC, JSON.parse(o.body)); }
          return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(DOC); }, text: function () { return Promise.resolve(''); } });
        }
        return realFetch.apply(this, arguments);
      };
    }` });
  await view(c, 620, 640, false);
  await go(c, POPUP);
  // The popup is sized by vault-size.js (<html>), not the viewport: two columns from 560px.
  await evalJs(c, `VaultSize.apply(620, 600); return 1;`);
  await sleep(500);
  ok('popup renders the cards', await waitFor(c, `document.querySelectorAll('#groups .card').length === 4`, 8000), await evalJs(c, `return document.body.innerText.slice(0,200);`));
  const pt = JSON.parse(await evalJs(c, `var t=document.querySelector('.tab.active'); return JSON.stringify({ tab: getComputedStyle(t).backgroundColor + ' ' + getComputedStyle(t).color, logo: getComputedStyle(document.querySelector('.logo')).color, logoBg: getComputedStyle(document.querySelector('.logo')).backgroundImage, hover: document.body.getAttribute('data-hoverfx'), grips: document.querySelectorAll('.grip').length, num: getComputedStyle(document.body).fontVariantNumeric });`));
  ok('popup: current tab solid purple, wordmark #dbd0f5 (no gradient text), magi hover, tabular', pt.tab === 'rgb(192, 174, 234) rgb(26, 26, 29)' && pt.logo === 'rgb(219, 208, 245)' && pt.logoBg === 'none' && pt.hover === 'magi' && pt.num === 'tabular-nums', pt);
  ok('popup: no grip dots in Reorder mode', pt.grips === 0 && await evalJs(c, `return document.getElementById('app').classList.contains('reorder');`));
  const pcols = () => evalJs(c, `return JSON.stringify([].map.call(document.querySelectorAll('#groups .col'), function(col){ return [].map.call(col.querySelectorAll('.card-name'), function(n){ return n.textContent; }); }));`).then(JSON.parse);
  const pc0 = await pcols();
  const pa = await rect(c, `document.querySelectorAll('#groups .col')[0].querySelector('.card-name')`);
  const pd = await rect(c, `document.querySelectorAll('#groups .col')[1].querySelectorAll('.card')[1]`);
  await mouseDrag(c, pa.x, pa.y, pd.x - pa.x, pd.t + pd.h - pa.y + 8);
  await sleep(400);
  const pc1 = await pcols();
  const put = await evalJs(c, `return JSON.stringify(window.__puts[window.__puts.length-1]||null);`).then(JSON.parse);
  ok('popup: a card drags to the other column', pc1[1][pc1[1].length - 1] === pc0[0][0] && pc1[0].length === pc0[0].length - 1, { pc0, pc1 });
  ok('...and is PUT to the keychain doc (order + colmap)', put && put.connections[3].name === pc0[0][0] && JSON.stringify(put.colmap) === '[0,1,1,1]', put && { names: put.connections.map((x) => x.name), colmap: put.colmap });
  await shot(c, 'popup');
  await evalJs(c, `document.getElementById('reorder-toggle').click(); return 1;`);
  const pb = await rect(c, `document.querySelectorAll('#groups .col')[0].querySelector('.card-name')`);
  const pc2 = await pcols();
  await mouseDrag(c, pb.x, pb.y, 0, 160);
  ok('popup: with Reorder off a card stays put', JSON.stringify(await pcols()) === JSON.stringify(pc2));

  ok('no uncaught page errors', !errors.filter(Boolean).length, errors);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
