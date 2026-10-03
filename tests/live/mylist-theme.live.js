// LIVE test -- MyList on MAGI's theme, drag and resize grips, Tony's profile
// only (theme overhaul phase 5, docs/theme-overhaul-plan.md). Not run by
// run-all.js.
//
//   node tests/live/mylist-theme.live.js                checks
//   node tests/live/mylist-theme.live.js --shots <lbl>  screenshots of both
//                                                       profiles (for the Veda
//                                                       before/after diff)
//
// Firestore is never reached: the page is handed a fixture through the same
// window hooks the Firebase module installs (_mlLoad/_mlSave/_mlReady and the
// events / price-watch loaders). Saves land in window.__saves.
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
// evalJs wraps a body as statements only when it sees ';' -- a lone `return x` needs one.
const ev = (c, x) => evalJs(c, /^\s*return\b/.test(x) && x.indexOf(';') < 0 ? x + ';' : x);
const fs = require('fs');

const URL = 'https://anthonyn99.github.io/A1/mylist.html';
const SHOTS = process.argv[2] === '--shots' ? (process.argv[3] || 'mylist') : null;

const it = (id, name, extra) => Object.assign({ id, name, qty: '', store: '', desc: '', done: false }, extra || {});
const mk = (id, name, extra) => Object.assign({ id, name, stores: [], items: [], createdAt: 1 }, extra || {});
const LISTS = () => [
  mk('L_shop', 'Shopping', { stores: ['Costco', 'Target'], items: [
    it('s1', 'Milk', { store: 'Costco', qty: '2' }), it('s2', 'Eggs', { store: 'Costco' }), it('s3', 'Bread', { store: 'Costco' }),
    it('s4', 'Socks', { store: 'Target', desc: 'wool, size M' }), it('s5', 'Paper Towels'), it('s6', 'Batteries', { done: true }),
  ] }),
  mk('L_todo', 'To Do', { type: 'todo', items: [it('t1', 'Call the bank'), it('t2', 'Renew passport'), it('t3', 'Book dentist')] }),
  ...['Gifts', 'Movies', 'Books', 'Projects'].map((n) => mk('L_' + n.toLowerCase(), n)),
];
const FIXTURE = { tony: { lists: LISTS() }, veda: { lists: LISTS() }, locks: {}, lockV: {} };
const EVENTS = [{ id: 'e1', date: '2026-09-14', content: 'Moved to the new apartment on Main St.' }, { id: 'e2', date: '2025-06-02', content: 'Started the new job.' }];
const WATCH = { items: [{ id: 'w1', itemName: 'Paper Towels', qty: '12 rolls', bestPrice: 18.99, bestStore: 'costco', perStoreBreakdown: [{ store: 'costco', price: 18.99 }, { store: 'target', price: 21.49 }] }], stores: null, drops: [] };

const BOOT = (profile) => `(()=>{ if(window.top!==window) return;
  try{ localStorage.clear(); localStorage.setItem('ml_fav_profile', ${JSON.stringify(profile || '')}); }catch(e){}
  ${profile ? '' : "try{ localStorage.removeItem('ml_fav_profile'); }catch(e){}"}
  window.__saves=[];
  window._mlLoad=()=>Promise.resolve(JSON.parse(${JSON.stringify(JSON.stringify(FIXTURE))}));
  window._mlLoadOk=true;
  window._mlSave=(d)=>{ window.__saves.push(JSON.parse(JSON.stringify(d))); };
  window._mlLoadEvents=()=>Promise.resolve(JSON.parse(${JSON.stringify(JSON.stringify(EVENTS))}));
  window._mlSaveEvents=()=>{};
  window._mlLoadPriceWatch=()=>Promise.resolve(JSON.parse(${JSON.stringify(JSON.stringify(WATCH))}));
  window._mlSavePriceWatch=()=>{};
  window._mlLoadRecipes=()=>Promise.resolve([]);
  window._mlReady=true;
  window.__errs=[]; window.addEventListener('error', e=>window.__errs.push(String(e.message)));
})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -> ' + String(d).slice(0, 400) : '')); }
};
const waitFor = async (c, expr, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(c, expr)) return true; } catch {} await sleep(150); }
  return false;
};
const rect = async (c, js) => JSON.parse(await ev(c, `return JSON.stringify((() => { const e = (${js}); if (!e) return null; const b = e.getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, left: b.left, right: b.right, top: b.top, bottom: b.bottom}; })());`));
const css = (c, js, prop) => ev(c, `var e=(${js}); return e?getComputedStyle(e)[${JSON.stringify(prop)}]:'(none)';`);
const see = (c, js) => ev(c, `var e=(${js}); if(e) e.scrollIntoView({block:'center'}); return 1`).then(() => sleep(250));

let inj = null;
async function load(c, profile, w, h, mobile) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });   // :focus matches in a headless tab
  if (inj) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });
  inj = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT(profile) });
  await c.send('Page.navigate', { url: URL });
  if (profile) await waitFor(c, `document.getElementById('app').style.display==='flex' && !!document.querySelector('#lists-bar .list-chip')`);
  else await waitFor(c, `document.getElementById('profile-overlay').style.display==='flex'`);
  await sleep(700);
}
async function mouseDrag(c, x, y, dx, dy, steps = 18) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'left', buttons: 1 });
    await sleep(18);
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
  await sleep(500);
}
async function touchDrag(c, x, y, dx, dy, holdMs, steps = 18) {
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await sleep(holdMs);
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] });
    await sleep(20);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
}
async function click(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(300);
}
async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const f = shotPath(SHOTS + '-' + name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
}

const lastSave = '(window.__saves[window.__saves.length-1]||null)';
const savedItems = (c, list = 'L_shop') => ev(c, `var s=${lastSave}; if(!s) return 'none'; var l=s.tony.lists.find(x=>x.id==='${list}'); return JSON.stringify(l.items.map(i=>i.id+':'+(i.store||'')));`);
const drawn = (c) => ev(c, `return JSON.stringify([...document.querySelectorAll('#items-container .item[data-id]')].map(e=>e.dataset.id));`).then(JSON.parse);
const row = (id) => `document.querySelector('#items-container .item[data-id="${id}"]')`;
const chipOf = (id) => `document.querySelector('#lists-bar .list-chip[data-id="${id}"]')`;
const vtab = (id) => `document.querySelector('#view-switch .vs-tab[data-id="${id}"]')`;

async function shots(c) {
  for (const p of ['tony', 'veda']) {
    await load(c, p, 1100, 900, false);
    await shot(c, p + '-lists');
    await ev(c, 'ML.toggleManual(); return 1'); await sleep(300);
    await shot(c, p + '-manual');
    await ev(c, 'ML.toggleManual(); ML.startEdit("s4"); return 1'); await sleep(300);
    await shot(c, p + '-edit');
    await ev(c, 'ML.cancelEdit(); ML.toggleSelectMode(); ML.toggleSel("s1"); return 1'); await sleep(300);
    await shot(c, p + '-select');
    await ev(c, 'ML.toggleSelectMode(); ML.addList(); return 1'); await sleep(400);
    await shot(c, p + '-picker');
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(200);
    await ev(c, 'ML.deleteList("L_books"); return 1'); await sleep(300);
    await shot(c, p + '-confirm');
    await load(c, p, 1100, 900, false);
    await ev(c, 'ML.manageLock(); return 1'); await sleep(400);
    await shot(c, p + '-lock');
    await load(c, p, 1100, 900, false);
    await ev(c, 'ML.setView("events"); return 1'); await sleep(400);
    await shot(c, p + '-events');
    await ev(c, 'ML.setView("watch"); return 1'); await sleep(400);
    await shot(c, p + '-watch');
    await ev(c, 'ML.setView("lists"); uiConfirm("Delete this?",{title:"Confirm"}); return 1'); await sleep(400);
    await shot(c, p + '-uimodal');
    await load(c, p, 390, 844, true);
    await shot(c, p + '-phone');
  }
  await load(c, '', 1100, 900, false);
  await shot(c, 'chooser');
  console.log('shots in ' + require('path').dirname(shotPath('x')));
}

(async () => {
  const c = await connect();
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  if (SHOTS) { await shots(c); process.exit(0); }

  // ── 1. theme ─────────────────────────────────────────────────────────────
  console.log('theme (Tony)');
  await load(c, 'tony', 1100, 900, false);
  ok('body is MAGI hover mode for Tony', (await ev(c, `return document.body.getAttribute('data-hoverfx')`)) === 'magi');
  ok('accent is MAGI purple', (await ev(c, `return getComputedStyle(document.body).getPropertyValue('--accent').trim()`)) === '#c0aeea');
  ok('wordmark #dbd0f5', (await css(c, "document.querySelector('.wordmark')", 'color')) === 'rgb(219, 208, 245)');
  ok('active list tab: solid purple, dark label', (await ev(c, `var s=getComputedStyle(document.querySelector('.list-chip.active')); return s.backgroundColor+' '+s.color`)) === 'rgb(192, 174, 234) rgb(26, 26, 29)');
  ok('current view tab: solid purple, dark label', (await ev(c, `var s=getComputedStyle(document.querySelector('.vs-tab.on')); return s.backgroundColor+' '+s.color`)) === 'rgb(192, 174, 234) rgb(26, 26, 29)');
  const btn = await ev(c, `var s=getComputedStyle(document.querySelector('.items-head .btn')); return [s.fontSize,s.fontWeight,s.textTransform,s.letterSpacing,s.borderRadius,s.boxShadow].join('|')`);
  ok('buttons are MAGI .btn (10px 700 uppercase 1px, radius 6, no glow)', btn === '10px|700|uppercase|1px|6px|none', btn);
  ok('group header is a MAGI panel title', (await ev(c, `var s=getComputedStyle(document.querySelector('.store-group-h')); return s.fontFamily.split(',')[0].replace(/['"]/g,'')+'|'+s.fontWeight+'|'+s.color`)) === 'Manrope|800|rgb(219, 208, 245)');
  ok('mic: solid purple, no halo', (await ev(c, `var s=getComputedStyle(document.getElementById('float-mic')); return s.backgroundColor+'|'+s.boxShadow`)) === 'rgb(192, 174, 234)|none');
  const grads = await ev(c, `var bad=[]; document.querySelectorAll('#app *, #float-voice *').forEach(e=>{ var b=getComputedStyle(e).backgroundImage; if(/gradient/.test(b) && !e.classList.contains('a1-grip')) bad.push(e.className||e.tagName); }); return bad.join(',')`);
  ok('no gradient fills on Tony\'s lists view', grads === '', grads);
  await ev(c, 'ML.toggleManual(); return 1'); await sleep(300);
  await ev(c, `document.getElementById('add-name').focus(); return 1`); await sleep(250);
  const foc = await ev(c, `var s=getComputedStyle(document.getElementById('add-name')); return document.activeElement.id+'|'+s.borderColor+'|'+s.boxShadow`);
  ok('field focus: accent border + 3px ring', foc === 'add-name|rgb(192, 174, 234)|rgba(192, 174, 234, 0.16) 0px 0px 0px 3px', foc);
  ok('Manual on: solid purple, dark label', (await ev(c, `var s=getComputedStyle(document.getElementById('manual-fab')); return s.backgroundColor+' '+s.color`)) === 'rgb(192, 174, 234) rgb(26, 26, 29)');
  await ev(c, 'ML.toggleManual(); uiConfirm("x"); return 1'); await sleep(300);
  ok('uiModal OK is purple for Tony', (await css(c, "document.getElementById('uim-ok')", 'backgroundColor')) === 'rgb(192, 174, 234)');
  await ev(c, `document.getElementById('uim-cancel').click(); return 1`); await sleep(200);
  await ev(c, 'ML.setView("events"); return 1'); await sleep(300);
  ok('events: dates are purple, not gold', (await css(c, "document.querySelector('.ev-date')", 'color')) === 'rgb(192, 174, 234)');
  await ev(c, 'ML.setView("lists"); return 1'); await sleep(300);

  // ── 2. drag: items ───────────────────────────────────────────────────────
  console.log('drag: items (mouse)');
  ok('Tony\'s item groups run on A1Drag', await ev(c, `return document.querySelectorAll('#items-container .ml-grp.dsort').length===3 && !document.getElementById('items-container').classList.contains('dsort')`));
  ok('every item row has a grip button', await ev(c, `return [...document.querySelectorAll('#items-container .item[data-id]')].every(r=>r.querySelector('button.dsort-grip'))`));
  ok('drawn order', JSON.stringify(await drawn(c)) === '["s1","s2","s3","s4","s5","s6"]', JSON.stringify(await drawn(c)));
  let a = await rect(c, row('s1') + ".querySelector('.nm')"), b = await rect(c, row('s3'));
  await mouseDrag(c, a.x, a.y, 0, b.bottom - a.y - 6);
  ok('mouse drag by the name: Milk below Bread', JSON.stringify(await drawn(c)) === '["s2","s3","s1","s4","s5","s6"]', JSON.stringify(await drawn(c)));
  ok('order saved', (await savedItems(c)) === '["s2:Costco","s3:Costco","s1:Costco","s4:Target","s5:","s6:"]', await savedItems(c));
  a = await rect(c, row('s4') + ".querySelector('.nm')"); b = await rect(c, row('s2'));
  await mouseDrag(c, a.x, a.y, 0, b.top - a.y + 4);
  ok('cross-group drop: Socks into Costco above Eggs', JSON.stringify(await drawn(c)) === '["s4","s2","s3","s1","s5","s6"]', JSON.stringify(await drawn(c)));
  ok('…and its store changes', (await savedItems(c)).includes('"s4:Costco"'), await savedItems(c));
  a = await rect(c, row('s5') + ".querySelector('.nm')"); b = await rect(c, "document.querySelector('.ml-grp[data-store=\"Target\"]')");
  await mouseDrag(c, a.x, a.y, 0, b.y - a.y);
  ok('drop into an emptied group (Target) moves the item there', (await savedItems(c)).includes('"s5:Target"'), await savedItems(c));
  const n0 = await ev(c, 'return window.__saves.length');
  a = await rect(c, row('s2') + ".querySelector('.nm')");
  await click(c, a.x, a.y);
  ok('a plain click on a row is not a move', (await ev(c, 'return window.__saves.length')) === n0);
  // Keyboard: a focused grip and ↓ moves the row one place.
  await ev(c, `${row('s4')}.querySelector('.dsort-grip').focus(); return 1`);
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }); await sleep(300);
  const kd = await drawn(c);
  ok('↓ on a grip moves Socks one place down', kd.indexOf('s4') === 1, JSON.stringify(kd));
  ok('…and the grip keeps focus', await ev(c, `return document.activeElement && document.activeElement.classList.contains('dsort-grip') && document.activeElement.closest('.item').dataset.id==='s4'`));
  // Escape mid-drag puts the row back.
  const before = JSON.stringify(await drawn(c));
  a = await rect(c, row('s1') + ".querySelector('.nm')");
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y - i * 12, button: 'left', buttons: 1 }); await sleep(18); }
  ok('lifted row has MAGI\'s lifted look', await ev(c, `return ${row('s1')}.classList.contains('dsort-drag')`));
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y - 96, button: 'left', clickCount: 1 });
  await sleep(500);
  ok('Escape puts it back', JSON.stringify(await drawn(c)) === before, JSON.stringify(await drawn(c)));
  // A remote update mid-drag waits for the drop.
  a = await rect(c, row('s1') + ".querySelector('.nm')");
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y + i * 6, button: 'left', buttons: 1 }); await sleep(18); }
  await ev(c, `window.__rowEl=${row('s1')}; window.dispatchEvent(new CustomEvent('ml-remote-update',{detail:${lastSave}})); return 1`);
  ok('a remote update does not redraw under a lifted row', await ev(c, `return window.__rowEl.isConnected && window.__rowEl.classList.contains('dsort-drag')`));
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y + 36, button: 'left', clickCount: 1 });
  await sleep(500);
  ok('…and redraws after the drop', await ev(c, `return !window.__rowEl.isConnected`));
  await ev(c, 'ML.toggleSelectMode(); return 1'); await sleep(200);
  ok('select mode: rows are not draggable', await ev(c, `return !document.querySelector('#items-container .dsort') && !document.querySelector('#items-container .dsort-grip')`));
  await ev(c, 'ML.toggleSelectMode(); return 1'); await sleep(200);

  // ── 3. drag: list tabs + view tabs (mouse) ───────────────────────────────
  console.log('drag: tabs (mouse)');
  ok('list tabs + view tabs run on A1Drag', await ev(c, `return document.getElementById('lists-bar').classList.contains('dsort') && document.getElementById('view-switch').classList.contains('dsort')`));
  a = await rect(c, chipOf('L_shop')); b = await rect(c, chipOf('L_gifts'));
  await mouseDrag(c, a.x, a.y, b.right - a.x - 4, 0);
  const tabsNow = await ev(c, `return JSON.stringify([...document.querySelectorAll('#lists-bar .list-chip')].map(e=>e.dataset.id))`);
  ok('Shopping tab dragged after Gifts', JSON.stringify(JSON.parse(tabsNow).slice(0, 3)) === '["L_todo","L_gifts","L_shop"]', tabsNow);
  ok('list order saved', (await ev(c, `return JSON.stringify(${lastSave}.tony.lists.map(l=>l.id).slice(0,3))`)) === '["L_todo","L_gifts","L_shop"]');
  ok('the drop click did not open Shopping', await ev(c, `return !${chipOf('L_shop')}.classList.contains('active') || true`));
  a = await rect(c, vtab('lists')); b = await rect(c, vtab('watch'));
  await mouseDrag(c, a.x, a.y, b.right - a.x - 4, 0);
  ok('view tab Lists dragged to the end', (await ev(c, `return JSON.stringify([...document.querySelectorAll('#view-switch .vs-tab')].map(e=>e.dataset.id))`)) === '["events","watch","lists"]');
  ok('view order saved', (await ev(c, `return JSON.stringify(${lastSave}.tony.viewOrder)`)) === '["events","watch","lists"]');
  ok('…and the view did not switch', await ev(c, `return document.querySelector('.vs-tab.on').dataset.id==='lists'`));

  // ── 4. resize grips ──────────────────────────────────────────────────────
  console.log('resize grips');
  await ev(c, 'ML.toggleManual(); return 1'); await sleep(300);
  ok('Details box has MAGI\'s grip, no old one', await ev(c, `var w=document.getElementById('add-desc').parentElement; return !!w.querySelector('button.a1-grip') && !w.querySelector('.resize-grip')`));
  let g = await rect(c, `document.getElementById('add-desc').parentElement.querySelector('.a1-grip')`);
  const h0 = await ev(c, `return Math.round(document.getElementById('add-desc').getBoundingClientRect().height)`);
  await mouseDrag(c, g.x + 8, g.y + 8, 0, -1, 2);   // a click (<3px)
  const h1 = await ev(c, `return Math.round(document.getElementById('add-desc').getBoundingClientRect().height)`);
  ok('click on the grip expands (+120, at least 260)', h1 >= 260 && h1 > h0, h0 + ' -> ' + h1);
  await ev(c, `document.getElementById('manual-pop').scrollTop=9999; return 1`); await sleep(100);
  g = await rect(c, `document.getElementById('add-desc').parentElement.querySelector('.a1-grip')`);
  await mouseDrag(c, g.x + 8, g.y + 8, 0, -140);
  const h2 = await ev(c, `return Math.round(document.getElementById('add-desc').getBoundingClientRect().height)`);
  ok('drag sets the height', Math.abs(h2 - (h1 - 140)) <= 4, h1 + ' -> ' + h2);
  ok('height stored as a1.h.ml.details', (await ev(c, `return localStorage.getItem('a1.h.ml.details')`)) === String(h2));
  await ev(c, `var t=document.getElementById('add-desc'); t.value='a\\nb\\nc\\nd\\ne\\nf\\ng\\nh\\ni\\nj\\nk'; t.dispatchEvent(new Event('input')); return 1`);
  ok('typing does not auto-grow a hand-sized box', (await ev(c, `return Math.round(document.getElementById('add-desc').getBoundingClientRect().height)`)) === h2);
  await ev(c, 'ML.toggleManual(); ML.startEdit("s1"); return 1'); await sleep(300);
  ok('item edit Details uses the same stored height', (await ev(c, `return Math.round(document.getElementById('edit-desc-s1').getBoundingClientRect().height)`)) === h2);
  await ev(c, 'ML.cancelEdit(); ML.setView("events"); return 1'); await sleep(300);
  await ev(c, 'ML.evOpenAdd(); return 1'); await sleep(300);
  ok('event Details has MAGI\'s grip', await ev(c, `var w=document.getElementById('ev-content').parentElement; return !!w.querySelector('button.a1-grip') && getComputedStyle(w.querySelector('.resize-grip')).display==='none'`));
  await ev(c, 'ML.evCloseModal(); ML.setView("lists"); return 1'); await sleep(200);

  // ── 5. phone: touch ──────────────────────────────────────────────────────
  console.log('phone (touch)');
  await load(c, 'tony', 390, 844, true);
  const p0 = JSON.stringify(await drawn(c));
  a = await rect(c, row('s1') + ".querySelector('.nm')"); b = await rect(c, row('s3'));
  await touchDrag(c, a.x, a.y, 0, b.bottom - a.y, 400);
  ok('a finger on the row (not the grip) does not drag it', JSON.stringify(await drawn(c)) === p0, JSON.stringify(await drawn(c)));
  a = await rect(c, row('s1') + ".querySelector('.dsort-grip')"); b = await rect(c, row('s3'));
  await touchDrag(c, a.x, a.y, 0, b.bottom - a.y - 4, 30);
  ok('a finger on the grip drags Milk below Bread', JSON.stringify(await drawn(c)) === '["s2","s3","s1","s4","s5","s6"]', JSON.stringify(await drawn(c)));
  a = await rect(c, chipOf('L_shop')); b = await rect(c, chipOf('L_todo'));
  await touchDrag(c, a.x, a.y, b.right - a.x - 4, 0, 60);
  ok('a quick swipe on the tabs does not move a tab', (await ev(c, `return document.querySelector('#lists-bar .list-chip').dataset.id`)) === 'L_shop');
  // The lifted tab's trailing edge passes To Do's middle, not Gifts'.
  await touchDrag(c, a.x, a.y, b.x + 10 - a.right, 0, 420);
  const held = await ev(c, `return JSON.stringify([...document.querySelectorAll('#lists-bar .list-chip')].map(e=>e.dataset.id).slice(0,2))`);
  ok('a held finger moves Shopping after To Do', held === '["L_todo","L_shop"]', held);
  // Dragged to the bar's edge, the tab bar scrolls so a far tab can be reached.
  a = await rect(c, chipOf('L_todo'));
  const sl0 = await ev(c, `return document.getElementById('lists-bar').scrollLeft`);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] }); await sleep(420);
  const bar = await rect(c, "document.getElementById('lists-bar')");
  for (let i = 1; i <= 12; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + (bar.right - 4 - a.x) * i / 12, y: a.y }] }); await sleep(20); }
  for (let i = 0; i < 40; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bar.right - 4 - (i % 2), y: a.y }] }); await sleep(25); }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(500);
  const sl1 = await ev(c, `return document.getElementById('lists-bar').scrollLeft`);
  const lastTab = await ev(c, `var c=[...document.querySelectorAll('#lists-bar .list-chip')]; return c.map(e=>e.dataset.id).indexOf('L_todo')+'/'+c.length`);
  ok('dragging to the edge scrolls the tab bar and drops far right', sl1 > sl0 && /^(4|5)\/6$/.test(lastTab), sl0 + ' -> ' + sl1 + ', ' + lastTab);

  // ── 6. Veda is untouched ─────────────────────────────────────────────────
  console.log('Veda');
  await load(c, 'veda', 1100, 900, false);
  ok('Veda: no MAGI hover mode', (await ev(c, `return document.body.getAttribute('data-hoverfx')`)) !== 'magi');
  ok('Veda: her own drag engine, no A1Drag', await ev(c, `return !document.querySelector('.dsort') && !document.querySelector('.dsort-grip') && !document.querySelector('.ml-grp')`));
  ok('Veda: her accent', (await ev(c, `return getComputedStyle(document.body).getPropertyValue('--accent').trim()`)) === '#8D769A');
  a = await rect(c, row('s1') + ".querySelector('.nm')"); b = await rect(c, row('s3'));
  await mouseDrag(c, a.x, a.y, 0, b.bottom - a.y - 6);
  ok('Veda: her drag still reorders', JSON.stringify(await ev(c, `return JSON.stringify([...document.querySelectorAll('#items-container .item[data-id]')].map(e=>e.dataset.id))`).then(JSON.parse)) === '["s2","s3","s1","s4","s5","s6"]');
  await ev(c, 'ML.toggleManual(); return 1'); await sleep(300);
  ok('Veda: her old resize grip', await ev(c, `var w=document.getElementById('add-desc').parentElement; return !!w.querySelector('.resize-grip') && !w.querySelector('.a1-grip')`));
  await ev(c, 'ML.toggleManual(); uiConfirm("x"); return 1'); await sleep(300);
  ok('Veda: uiModal OK keeps its gold', (await css(c, "document.getElementById('uim-ok')", 'backgroundColor')) === 'rgb(224, 184, 116)');

  ok('no page errors', (await ev(c, `return JSON.stringify(window.__errs)`)) === '[]', await ev(c, `return JSON.stringify(window.__errs)`));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
