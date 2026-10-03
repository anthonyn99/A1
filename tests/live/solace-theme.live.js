// Theme overhaul phase 8: Solace in MAGI's look, its four reorderable lists
// (circuits, routines, a circuit's modules, recipes) and a recipe's steps on
// dragsort.js (MAGI's drag), and its text boxes on resizegrip.js (MAGI's
// corner grip). Real mouse and touch input over CDP, asserting the order
// Solace actually SAVES (the Firestore write), not just the DOM.
//
// Firebase is faked: a module whose getDoc/onSnapshot answer seeded documents
// and whose setDoc records into window.__fsWrites. Nothing leaves the machine.
//
//   1. theme: MAGI colours, solid purple primary + current section/view,
//      purple wordmark, MAGI's .btn type, no gradients, no old fonts, no grip
//      dots, numbers in Inter 500 tabular, magi hover
//   2. MotionCore: mouse-drag a circuit (saved order, the drop's click does not
//      open the card, a plain click does), a routine, a circuit's modules
//   3. Recipes: drag a recipe (saved order, the drop's click does not open it),
//      no drag while searching, drag a step (saved, renumbered)
//   4. grips: MAGI's on the recipe instructions, a step, both MotionCore boxes:
//      drag, stored height, auto-grow leaves it alone, click hands it back
//   5. dialogs: uiModal, the confirm box, the lock
//   6. phone width: a quick swipe scrolls, a held finger drags
//
// Run:          node tests/live/solace-theme.live.js
// Shots only:   node tests/live/solace-theme.live.js --shots <label>
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
const SHOTS = process.argv[2] === '--shots' ? (process.argv[3] || 'solace') : null;

const mods = (p, n) => Array.from({ length: n }, (_, i) => ({ id: p + 'm' + i, name: 'Move ' + (i + 1), time: 30 + 15 * i, desc: i === 0 ? 'Keep the core tight' : '' }));
const SEED = {
  'dashboards/motioncore': {
    circuits: [
      { id: 'c1', name: 'Morning HIIT', desc: 'Fast start', modules: mods('c1', 4) },
      { id: 'c2', name: 'Core Burner', desc: '', modules: mods('c2', 3) },
      { id: 'c3', name: 'Mobility Flow', desc: 'Slow and easy', modules: mods('c3', 5) },
    ],
    routines: [
      { id: 'r1', name: 'Push Day A', content: 'Bench Press - 4x8 @ 185lb\nIncline DB Press - 3x10\n\nCardio - 20 min' },
      { id: 'r2', name: 'Pull Day A', content: 'Rows - 4x10\nCurls - 3x12' },
      { id: 'r3', name: 'Leg Day', content: 'Squat - 5x5' },
    ],
    savedAt: 1,
  },
  'dashboards/mealsuite': {
    recipes: [
      { id: 'ra', name: 'Chicken Stir Fry', category: 'Dinner', prepTime: '30 min', servings: '4 servings', ingredients: [{ name: 'Chicken', qty: '500 g' }, { name: 'Soy sauce', qty: '3 tbsp' }], tools: ['Wok'], instructions: '1. Slice the chicken\n2. Heat the wok\n3. Stir fry everything' },
      { id: 'rb', name: 'Overnight Oats', category: 'Breakfast', prepTime: '5 min', servings: '1', ingredients: [{ name: 'Oats', qty: '1 cup' }], tools: [], instructions: '1. Mix\n2. Chill' },
      { id: 'rc', name: 'Greek Salad', category: 'Lunch', prepTime: '15 min', servings: '2', ingredients: [], tools: [], instructions: '' },
      { id: 'rd', name: 'Brownies', category: 'Dessert', prepTime: '45 min', servings: '12', ingredients: [], tools: [], instructions: '' },
    ],
    savedAt: 1,
  },
  'dashboards/applock': { locks: {} },
};

const FB = `
const SEED = ${JSON.stringify(SEED)};
export const initializeApp = () => ({});
export const getAuth = () => ({});
export const signInAnonymously = () => Promise.resolve({ user: { uid: 't' } });
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb({ uid: 't' }), 0); return () => {}; };
export const initializeAppCheck = () => ({});
export class ReCaptchaV3Provider {}
export const initializeFirestore = () => ({});
export const getFirestore = () => ({});
export const memoryLocalCache = () => ({});
export const doc = (db, ...p) => ({ path: p.join('/'), kind: 'doc' });
const snap = (ref) => ({ exists: () => !!SEED[ref.path], data: () => JSON.parse(JSON.stringify(SEED[ref.path])) });
export const getDoc = (ref) => Promise.resolve(snap(ref));
export const getDocFromServer = (ref) => Promise.resolve(snap(ref));
export const setDoc = (ref, data) => { (window.__fsWrites = window.__fsWrites || []).push({ path: ref.path, data: JSON.parse(JSON.stringify(data)) }); return Promise.resolve(); };
export const onSnapshot = (ref, cb) => { setTimeout(() => cb(snap(ref)), 30); return () => {}; };
`;

const mock = {
  patterns: ['https://taskhub-reminders.av1.workers.dev/*', 'https://personal-ai.av1.workers.dev/*'],
  handle(req) {
    if (req.url.startsWith('https://www.gstatic.com/firebasejs/')) return { text: FB, type: 'text/javascript' };
    if (!/\.workers\.dev/.test(req.url)) return null;
    if (req.method === 'OPTIONS') return { status: 204, json: null };
    return { json: { ok: true } };
  },
};

const lastWrite = (c, path, field) => evalJs(c, `var w=(window.__fsWrites||[]).filter(x=>x.path===${JSON.stringify(path)}&&x.data&&x.data.${field}); return JSON.stringify(w.length?w[w.length-1].data.${field}:null);`).then(JSON.parse);
const ids = (c, sel, attr = 'id') => evalJs(c, `return JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map(r=>r.dataset.${attr}));`).then(JSON.parse);
const rect = async (c, js) => JSON.parse(await evalJs(c, `return JSON.stringify((() => { const e = (${js}); if (!e) return null; const b = e.getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, left: b.left, top: b.top, right: b.right, bottom: b.bottom}; })());`));
const css = (c, sel, prop) => evalJs(c, `var e=document.querySelector(${JSON.stringify(sel)}); return e?getComputedStyle(e)[${JSON.stringify(prop)}]:'(none)';`);
const PURPLE = 'rgb(192, 174, 234)', DARK = 'rgb(26, 26, 29)', ACL = 'rgb(219, 208, 245)';

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
async function touchDrag(c, x, y, dx, dy, steps = 16, holdMs = 0) {
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  if (holdMs) await sleep(holdMs);
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] });
    await sleep(16);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
}
async function load(c, w, h, mobile, route = 'fitness/motioncore') {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/solace.html?blank' }); await sleep(800);
  await evalJs(c, `localStorage.clear(); localStorage.setItem('sol_route', ${JSON.stringify(route)}); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/solace.html' });
  await sleep(2200);
}
const goTo = (c, sec) => evalJs(c, `SOL.go(${JSON.stringify(sec)}); 1`).then(() => sleep(400));
const mcView = (c, v) => evalJs(c, `mcSwitchView('${v}', document.getElementById('mc-nav-${v}')); 1`).then(() => sleep(300));
async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const f = shotPath(SHOTS + '-' + name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log('shot', f);
}
// The middle of a card's header, clear of its buttons.
const cardHead = (c, sel) => rect(c, `document.querySelector(${JSON.stringify(sel)}).querySelector('.circuit-card-title, .routine-title')`);

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Network.setBypassServiceWorker', { bypass: true });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  if (SHOTS) {
    await load(c, 1280, 900, false);
    await evalJs(c, "mcToggleCircuit('c1'); 1"); await sleep(200);
    await shot(c, 'circuits');
    await mcView(c, 'routines'); await evalJs(c, "mcToggleRoutine('r1'); 1"); await sleep(200);
    await shot(c, 'routines');
    await evalJs(c, "mcOpenEditRoutineModal('r1'); 1"); await sleep(400);
    await shot(c, 'routine-modal');
    await evalJs(c, "mcCloseModal('mc-routine-modal'); mcSwitchView('circuits', document.getElementById('mc-nav-circuits')); mcOpenEditCircuitModal('c1'); 1"); await sleep(400);
    await shot(c, 'circuit-modal');
    await evalJs(c, "mcCloseModal('mc-circuit-modal'); mcStartTimer('c1'); 1"); await sleep(1500);
    await evalJs(c, "mcTogglePause(); 1"); await sleep(200);
    await shot(c, 'timer');
    await evalJs(c, "mcStopTimer(); 1");
    await goTo(c, 'nutrition'); await sleep(300);
    await shot(c, 'recipes');
    await evalJs(c, "SOL.recOpenDetail('ra'); 1"); await sleep(400);
    await shot(c, 'recipe');
    await evalJs(c, "SOL.recEditStep(1); 1"); await sleep(300);
    await shot(c, 'recipe-step-edit');
    await evalJs(c, "SOL.recCancelStep(); SOL.recOpenEdit('ra'); 1"); await sleep(400);
    await shot(c, 'recipe-modal');
    await evalJs(c, "SOL.recCloseModal(); SOL.recDelete('ra'); 1"); await sleep(300);
    await shot(c, 'confirm');
    await evalJs(c, "document.getElementById('confirm-no').click(); uiConfirm('Delete this circuit?', {danger:true, okLabel:'Delete'}); 1"); await sleep(300);
    await shot(c, 'uiconfirm');
    await evalJs(c, "document.getElementById('uim-cancel').click(); uiPrompt('Name it', {title:'Rename'}); 1"); await sleep(300);
    await shot(c, 'uiprompt');
    await evalJs(c, "document.getElementById('uim-cancel').click(); SOL.openDevicePicker(); 1"); await sleep(600);
    await shot(c, 'mic-picker');
    await evalJs(c, "SOL.closeDevicePicker(); SOL.manageLock(); 1"); await sleep(600);
    await shot(c, 'lock');
    await load(c, 400, 860, true);
    await shot(c, 'phone-circuits');
    await load(c, 400, 860, true, 'nutrition/recipes');
    await shot(c, 'phone-recipes');
    c.ws.close(); process.exit(0);
  }

  // ── 1. theme ──
  await load(c, 1280, 900, false);
  console.log('theme');
  ok('body opts into MAGI hover', (await evalJs(c, "return document.body.dataset.hoverfx;")) === 'magi');
  ok('Solace is on screen', (await evalJs(c, "return document.getElementById('sol-root').classList.contains('on');")) === true);
  ok('wordmark is #dbd0f5', (await css(c, '#sol-title', 'color')) === ACL);
  ok('the current section is solid purple', (await css(c, '.sol-sec-btn.on', 'backgroundColor')) === PURPLE);
  ok('its label is dark', (await css(c, '.sol-sec-btn.on', 'color')) === DARK);
  ok('the current MotionCore view is solid purple', (await css(c, '#mc-nav-circuits', 'backgroundColor')) === PURPLE);
  const nb = '#mc-view-circuits .btn-primary';
  ok('"New Circuit" is a solid purple fill', (await css(c, nb, 'backgroundColor')) === PURPLE && (await css(c, nb, 'color')) === DARK);
  ok("buttons are MAGI's .btn (10px, 700, uppercase, 1px)", (await css(c, nb, 'fontSize')) === '10px' && (await css(c, nb, 'fontWeight')) === '700'
    && (await css(c, nb, 'textTransform')) === 'uppercase' && (await css(c, nb, 'letterSpacing')) === '1px');
  ok('a ghost button rests on a #45454c outline', (await css(c, '.circuit-card .btn-ghost', 'borderTopColor')) === 'rgb(69, 69, 76)');
  ok('a danger button is an outline, not a wash', (await css(c, '.circuit-card .btn-danger', 'backgroundColor')) === 'rgba(0, 0, 0, 0)');
  ok('cards sit on a hairline, radius 8', (await css(c, '.circuit-card', 'borderTopColor')) === 'rgba(255, 255, 255, 0.06)' && (await css(c, '.circuit-card', 'borderTopLeftRadius')) === '8px');
  ok('no grip dots anywhere', (await evalJs(c, "return document.querySelectorAll('.drag-handle, .dsort-grip').length;")) === 0);
  ok('the lists are A1Drag lists', (await evalJs(c, "return !!window.A1Drag && document.getElementById('mc-circuits-list').classList.contains('dsort');")) === true);
  const fonts = await evalJs(c, "var s=new Set(); document.querySelectorAll('#sol-root *').forEach(e=>s.add(getComputedStyle(e).fontFamily)); return JSON.stringify([...s]);");
  ok('no Bebas Neue, DM Sans or Fraunces left', !/Bebas|DM Sans|Fraunces/.test(fonts), fonts);
  ok('the font links load only Inter and Manrope', (await evalJs(c, "return [...document.querySelectorAll('link[href*=\"fonts.googleapis\"]')].map(l=>l.href).join(' ');")).match(/Bebas|DM\+Sans|Fraunces/) === null);
  const grads = await evalJs(c, "return JSON.stringify([...document.querySelectorAll('*')].filter(e=>!e.classList.contains('a1-grip')).filter(e=>/gradient\\(/.test(getComputedStyle(e).backgroundImage)).map(e=>e.id||e.className));");
  ok('no gradient fills', grads === '[]', grads);
  const gold = await evalJs(c, "var g=/224, 184, 116|239, 205, 148/; return JSON.stringify([...document.querySelectorAll('#sol-root *')].filter(e=>{var s=getComputedStyle(e); return g.test(s.color)||g.test(s.borderTopColor)||g.test(s.backgroundColor)||g.test(s.boxShadow);}).map(e=>e.className||e.tagName));");
  ok('no gold doing an accent job', gold === '[]', gold);
  // NUMBERS (§2): Inter 500, tabular.
  await evalJs(c, "mcToggleCircuit('c1'); 1"); await sleep(200);
  for (const sel of ['#mc-cbody-c1 .module-time', '#mc-cbody-c1 .module-num', '.circuit-card .badge']) {
    const f = await css(c, sel, 'fontFamily'), w = await css(c, sel, 'fontWeight'), v = await css(c, sel, 'fontVariantNumeric');
    ok(`numbers: ${sel} is Inter 500 tabular`, /^Inter/.test(f) && w === '500' && v === 'tabular-nums', f + ' ' + w + ' ' + v);
  }
  await evalJs(c, "mcToggleCircuit('c1'); 1"); await sleep(200);
  // magi hover on a real button
  const pb = await rect(c, `document.querySelector('${nb}')`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pb.x, y: pb.y }); await sleep(250);
  ok('hover lifts brightness 1.15', /brightness\(1\.15\)/.test(await css(c, nb, 'filter')), await css(c, nb, 'filter'));
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await sleep(150);

  // ── 2. MotionCore drags ──
  console.log('motioncore');
  ok('circuits start in seed order', JSON.stringify(await ids(c, '#mc-circuits-list > .circuit-card')) === '["c1","c2","c3"]');
  let a = await cardHead(c, '.circuit-card[data-id="c1"]');
  let b = await cardHead(c, '.circuit-card[data-id="c2"]');
  await mouseDrag(c, a.x, a.y, 0, b.y - a.y);
  ok('mouse drag moves the circuit', JSON.stringify(await ids(c, '#mc-circuits-list > .circuit-card')) === '["c2","c1","c3"]', JSON.stringify(await ids(c, '#mc-circuits-list > .circuit-card')));
  ok("the drop's click did not open the card", (await css(c, '#mc-cbody-c1', 'display')) === 'none');
  await sleep(1800);
  let w = await lastWrite(c, 'dashboards/motioncore', 'circuits');
  ok('the new circuit order is SAVED', w && w.map(x => x.id).join() === 'c2,c1,c3', w && w.map(x => x.id).join());
  a = await cardHead(c, '.circuit-card[data-id="c3"]');
  await click(c, a.x, a.y);
  ok('a plain click still opens a card', (await css(c, '#mc-cbody-c3', 'display')) === 'block');
  await evalJs(c, "mcToggleCircuit('c3'); 1");
  // a press on a card's button is that button's
  const run = await rect(c, "document.querySelector('.circuit-card[data-id=\"c2\"] .run-btn')");
  await mouseDrag(c, run.x, run.y, 0, 120);
  await evalJs(c, "mcStopTimer(); 1");
  ok("a drag from a card's button moves nothing", JSON.stringify(await ids(c, '#mc-circuits-list > .circuit-card')) === '["c2","c1","c3"]');

  await mcView(c, 'routines');
  a = await cardHead(c, '.routine-card[data-id="r3"]');
  b = await cardHead(c, '.routine-card[data-id="r1"]');
  await mouseDrag(c, a.x, a.y, 0, (b.y - a.y) - 20);
  ok('mouse drag moves a routine up', JSON.stringify(await ids(c, '#mc-routines-list > .routine-card')) === '["r3","r1","r2"]', JSON.stringify(await ids(c, '#mc-routines-list > .routine-card')));
  await sleep(1800);
  w = await lastWrite(c, 'dashboards/motioncore', 'routines');
  ok('the new routine order is SAVED', w && w.map(x => x.id).join() === 'r3,r1,r2', w && w.map(x => x.id).join());
  await mcView(c, 'circuits');

  // a circuit's modules, inside its edit dialog
  await evalJs(c, "mcOpenEditCircuitModal('c1'); 1"); await sleep(400);
  ok('the dialog is MAGI (.62 backdrop)', (await css(c, '#mc-circuit-modal', 'backgroundColor')) === 'rgba(0, 0, 0, 0.62)');
  ok('dialog title is #dbd0f5', (await css(c, '#mc-circuit-modal-title', 'color')) === ACL);
  ok('field labels are 9px / 700 / #8d8d94', (await css(c, '#mc-circuit-modal label', 'fontSize')) === '9px' && (await css(c, '#mc-circuit-modal label', 'color')) === 'rgb(141, 141, 148)');
  const mr = (i) => rect(c, `document.querySelectorAll('#mc-modules-build-list > .module-builder-item')[${i}].querySelector('.mbitem-name')`);
  a = await mr(0); b = await mr(1);
  await mouseDrag(c, a.x, a.y, 0, b.y - a.y);
  ok('mouse drag moves a module', JSON.stringify(await ids(c, '#mc-modules-build-list > .module-builder-item')) === '["c1m1","c1m0","c1m2","c1m3"]', JSON.stringify(await ids(c, '#mc-modules-build-list > .module-builder-item')));
  ok('the numbers follow the move', (await evalJs(c, "return [...document.querySelectorAll('#mc-modules-build-list .mbitem-num')].map(e=>e.textContent).join();")) === '1,2,3,4');
  // the description grip (was a native resize corner)
  ok("the description box has MAGI's grip", (await evalJs(c, "var t=document.getElementById('mc-circuit-desc'); return !!t.parentElement.querySelector('.a1-grip') && getComputedStyle(t).resize;")) === 'none');
  await evalJs(c, "mcSaveCircuit(); 1"); await sleep(1800);
  w = await lastWrite(c, 'dashboards/motioncore', 'circuits');
  const c1 = w && w.find(x => x.id === 'c1');
  ok("the circuit's new module order is SAVED", c1 && c1.modules.map(m => m.id).join() === 'c1m1,c1m0,c1m2,c1m3', c1 && c1.modules.map(m => m.id).join());

  // the routine box's grip: drag, stored, click hands it back
  await mcView(c, 'routines');
  await evalJs(c, "mcOpenEditRoutineModal('r1'); 1"); await sleep(400);
  const box = await rect(c, "document.getElementById('mc-routine-content')");
  const g = await rect(c, "document.getElementById('mc-routine-content').parentElement.querySelector('.a1-grip')");
  ok("the routine box has MAGI's grip", !!g);
  if (g) {
    await mouseDrag(c, g.right - 8, g.bottom - 8, 0, 90, 10);
    const h1 = (await rect(c, "document.getElementById('mc-routine-content')")).h;
    ok('dragging the grip grows the box', Math.abs(h1 - (box.h + 90)) <= 4, box.h + ' -> ' + h1);
    ok('the height is stored', (await evalJs(c, "return localStorage.getItem('a1.h.sol.routine');")) === String(Math.round(h1)), await evalJs(c, "return localStorage.getItem('a1.h.sol.routine');"));
    const g2 = await rect(c, "document.getElementById('mc-routine-content').parentElement.querySelector('.a1-grip')");
    await click(c, g2.right - 8, g2.bottom - 8);
    ok('a click hands it back', (await evalJs(c, "return localStorage.getItem('a1.h.sol.routine');")) === null);
  }
  await evalJs(c, "mcCloseModal('mc-routine-modal'); 1");
  await mcView(c, 'circuits');

  // ── 3. Recipes ──
  console.log('recipes');
  await goTo(c, 'nutrition');
  ok('recipes start in seed order', JSON.stringify(await ids(c, '#rec-list-rows > .rec-row')) === '["ra","rb","rc","rd"]');
  const rr = (id) => rect(c, `document.querySelector('.rec-row[data-id="${id}"] .rec-name')`);
  a = await rr('ra'); b = await rr('rc');
  await mouseDrag(c, a.x, a.y, 0, (b.y - a.y) + 30);
  ok('mouse drag moves a recipe', JSON.stringify(await ids(c, '#rec-list-rows > .rec-row')) === '["rb","rc","ra","rd"]', JSON.stringify(await ids(c, '#rec-list-rows > .rec-row')));
  ok("the drop's click did not open it", (await evalJs(c, "return !!document.getElementById('rec-list-rows');")) === true);
  await sleep(1500);
  w = await lastWrite(c, 'dashboards/mealsuite', 'recipes');
  ok('the new recipe order is SAVED', w && w.map(x => x.id).join() === 'rb,rc,ra,rd', w && w.map(x => x.id).join());
  // no drag while a search is on: a drop would land where you cannot see
  await evalJs(c, "var s=document.getElementById('rec-search'); s.value='a'; SOL.recRerender(); 1"); await sleep(200);
  const vis = await ids(c, '#rec-list-rows > .rec-row');
  a = await rr(vis[0]);
  await mouseDrag(c, a.x, a.y, 0, 140);
  ok('no drag while searching', JSON.stringify(await ids(c, '#rec-list-rows > .rec-row')) === JSON.stringify(vis));
  await evalJs(c, "var s=document.getElementById('rec-search'); s.value=''; SOL.recRerender(); 1"); await sleep(200);
  a = await rr('rb');
  await click(c, a.x, a.y);
  ok('a plain click opens a recipe', (await evalJs(c, "return !!document.getElementById('rec-steps-container');")) === true);
  await evalJs(c, "SOL.recBack(); SOL.recOpenDetail('ra'); 1"); await sleep(300);
  ok('the detail section titles are #dbd0f5', (await css(c, '.rec-sec', 'color')) === ACL);
  ok('quantities are Inter 500 tabular', (await css(c, '.rec-ing .qt', 'fontVariantNumeric')) === 'tabular-nums' && (await css(c, '.rec-ing .qt', 'fontWeight')) === '500');
  const sr = (i) => rect(c, `document.querySelectorAll('#rec-steps-container > .rec-step')[${i}].querySelector('.rec-step-t')`);
  a = await sr(2); b = await sr(0);
  await mouseDrag(c, a.x, a.y, 0, (b.y - a.y) - 12);
  const steps = await evalJs(c, "return [...document.querySelectorAll('#rec-steps-container .rec-step-t')].map(e=>e.textContent).join('|');");
  ok('mouse drag moves a step', steps === 'Stir fry everything|Slice the chicken|Heat the wok', steps);
  await sleep(1500);
  w = await lastWrite(c, 'dashboards/mealsuite', 'recipes');
  const ra = w && w.find(x => x.id === 'ra');
  ok('the steps are SAVED, renumbered', ra && ra.instructions === '1. Stir fry everything\n2. Slice the chicken\n3. Heat the wok', ra && JSON.stringify(ra.instructions));
  // a step's editor carries a grip
  await evalJs(c, "SOL.recEditStep(0); 1"); await sleep(300);
  ok("a step's editor has MAGI's grip", (await evalJs(c, "var t=document.getElementById('rec-step-input'); return !!(t && t.parentElement.querySelector('.a1-grip'));")) === true);
  ok('the old ns-resize grip is gone', (await evalJs(c, "return document.querySelectorAll('.resize-grip').length;")) === 0);
  await evalJs(c, "SOL.recCancelStep(); SOL.recOpenEdit('ra'); 1"); await sleep(400);
  ok('the recipe dialog is MAGI (.62 backdrop, s1 box, radius 8)', (await css(c, '#rec-modal', 'backgroundColor')) === 'rgba(0, 0, 0, 0.62)'
    && (await css(c, '.rec-mbox', 'backgroundColor')) === 'rgb(35, 35, 39)' && (await css(c, '.rec-mbox', 'borderTopLeftRadius')) === '8px');
  ok('"Save recipe" is solid purple', (await css(c, '#rec-modal .btn.solid', 'backgroundColor')) === PURPLE);
  const ig = await rect(c, "document.getElementById('rec-instr').parentElement.querySelector('.a1-grip')");
  ok("the instructions box has MAGI's grip", !!ig);
  if (ig) {
    const h0 = (await rect(c, "document.getElementById('rec-instr')")).h;
    await mouseDrag(c, ig.right - 8, ig.bottom - 8, 0, 70, 10);
    const h1 = (await rect(c, "document.getElementById('rec-instr')")).h;
    ok('dragging it grows the box', Math.abs(h1 - (h0 + 70)) <= 4, h0 + ' -> ' + h1);
    await evalJs(c, "var t=document.getElementById('rec-instr'); t.value+='\\nmore'; SOL.autoGrow(t); 1");
    ok('auto-grow leaves a hand-sized box alone', Math.abs((await rect(c, "document.getElementById('rec-instr')")).h - h1) <= 1);
    ok('its height is stored', !!(await evalJs(c, "return localStorage.getItem('a1.h.sol.rec-instr');")));
  }
  await evalJs(c, "SOL.recCloseModal(); 1");

  // ── 5. dialogs ──
  console.log('dialogs');
  await evalJs(c, "SOL.recDelete('rd'); 1"); await sleep(300);
  ok('the confirm box is MAGI (.62 backdrop)', (await css(c, '#confirm-overlay', 'backgroundColor')) === 'rgba(0, 0, 0, 0.62)');
  await evalJs(c, "document.getElementById('confirm-no').click(); window.__p = uiConfirm('Sure?', {okLabel:'Yes'}); 1"); await sleep(300);
  ok('uiModal OK is solid purple with a dark label', (await css(c, '#uim-ok', 'backgroundColor')) === PURPLE && (await css(c, '#uim-ok', 'color')) === DARK);
  ok('uiModal backdrop is .62', (await css(c, '#uim-overlay', 'backgroundColor')) === 'rgba(0, 0, 0, 0.62)');
  await evalJs(c, "document.getElementById('uim-cancel').click(); uiConfirm('Delete?', {danger:true, okLabel:'Delete'}); 1"); await sleep(300);
  ok('a danger OK is a red outline', (await css(c, '#uim-ok', 'backgroundColor')) === 'rgba(0, 0, 0, 0)' && (await css(c, '#uim-ok', 'color')) === 'rgb(214, 138, 124)');
  await evalJs(c, "document.getElementById('uim-cancel').click(); SOL.manageLock(); 1"); await sleep(600);
  ok('the lock card outline is #9a86c9', (await css(c, '#applock-box', 'borderTopColor')) === 'rgb(154, 134, 201)');
  ok('the lock has no glow', (await css(c, '#applock-overlay', 'backgroundImage')) === 'none');
  ok('"Set Password" is solid purple', (await css(c, '#applock-submit', 'backgroundColor')) === PURPLE && (await css(c, '#applock-submit', 'color')) === DARK);
  await evalJs(c, "document.getElementById('applock-cancel').click(); 1"); await sleep(300);

  // ── 6. phone ──
  console.log('phone');
  await load(c, 400, 860, true);
  a = await cardHead(c, '.circuit-card[data-id="c1"]');
  b = await cardHead(c, '.circuit-card[data-id="c2"]');
  const before = await ids(c, '#mc-circuits-list > .circuit-card');
  await touchDrag(c, a.x, a.y, 0, (b.y - a.y) + 60, 10, 0);
  ok('a quick swipe on a card does not move it', JSON.stringify(await ids(c, '#mc-circuits-list > .circuit-card')) === JSON.stringify(before));
  await evalJs(c, 'window.scrollTo(0,0); 1'); await sleep(200);
  a = await cardHead(c, '.circuit-card[data-id="c1"]');
  b = await cardHead(c, '.circuit-card[data-id="c2"]');
  await touchDrag(c, a.x, a.y, 0, b.y - a.y, 16, 420);
  ok('a held finger drags the card', JSON.stringify(await ids(c, '#mc-circuits-list > .circuit-card')) === '["c2","c1","c3"]', JSON.stringify(await ids(c, '#mc-circuits-list > .circuit-card')));
  await load(c, 400, 860, true, 'nutrition/recipes');
  a = await rr('ra'); b = await rr('rb');
  await touchDrag(c, a.x, a.y, 0, b.y - a.y, 16, 420);
  ok('a held finger drags a recipe', JSON.stringify(await ids(c, '#rec-list-rows > .rec-row')) === '["rb","ra","rc","rd"]', JSON.stringify(await ids(c, '#rec-list-rows > .rec-row')));
  const ov = await evalJs(c, "return document.documentElement.scrollWidth > innerWidth;");
  ok('nothing runs off a phone screen', ov === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
