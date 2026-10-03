// Theme overhaul phase 6: Insight in MAGI's look, its tab strip and Recurring
// lists on dragsort.js (MAGI's drag) and its notes fields on resizegrip.js
// (MAGI's corner grip). Real mouse and touch input over CDP, asserting the
// order Insight actually SAVES (the Firestore write), not just the DOM.
//
// Insight needs Firebase, its worker, the lock worker and Plaid, so all four
// are faked: Firebase is a module whose onSnapshot answers seeded documents
// and whose setDoc records into window.__fsWrites. Nothing leaves the machine.
//
//   1. theme: MAGI colours, solid purple primary + current tab, purple
//      wordmark, Insight's own type, no gradients, no old gold, magi hover
//   2. desktop: mouse-drag a tab (saved order, the drop's click does not
//      switch the view, a plain click does)
//   3. Recurring: mouse-drag a manual row and an auto row (saved orders), a
//      press on a row's button is that button's
//   4. the notes grip: MAGI's, drag, stored height, click hands it back
//   5. phone width: a quick swipe scrolls, a held finger drags (rows + tabs)
//
// Run:          node tests/live/insight-theme.live.js
// Shots only:   node tests/live/insight-theme.live.js --shots <label>
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
const SHOTS = process.argv[2] === '--shots' ? (process.argv[3] || 'insight') : null;

// Three monthly merchants (auto-detected recurring) and a few one-offs.
const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
const PLAID = [];
[['Netflix', 15.49, 3], ['Spotify Premium', 11.99, 6], ['Planet Fitness', 24.99, 9]].forEach(([m, a, off], k) => {
  for (let i = 0; i < 4; i++) PLAID.push({ id: 'p' + k + i, merchant: m, name: m, amount: a, date: daysAgo(off + 30 * i), account_id: 'a1', category: 'Subscriptions' });
});
// The same gym under two names (Tony, 2026-10-02): three months as
// "Paramount Accept Vasafit", then "Vasa Fitness". The last charge must keep
// the bill On time, not Missing.
[42, 72, 102].forEach((d, i) => PLAID.push({ id: 'v' + i, merchant: 'Paramount Accept Vasafit', name: 'Paramount Accept Vasafit', amount: 9.99, date: daysAgo(d), account_id: 'a1', category: 'Personal Care' }));
PLAID.push({ id: 'v9', merchant: 'Vasa Fitness', name: 'Vasa Fitness', amount: 9.99, date: daysAgo(11), account_id: 'a1', category: 'Personal Care' });
// Every way a paid bill used to read Late or Missing (Tony, 2026-10-02):
const monthsAgo = (m, extraDays = 0) => { const d = new Date(); d.setMonth(d.getMonth() - m); d.setDate(d.getDate() - extraDays); return ymd(d); };
const bill = (id, name, amount, dates, extra = {}) => dates.forEach((date, i) => PLAID.push({ id: id + i, merchant: name, name, amount, date, account_id: 'a1', category: 'Entertainment', ...extra }));
//  - renamed with no word in common, same price, on schedule
bill('h', 'Hulu', 7.99, [daysAgo(40), daysAgo(70), daysAgo(100)]);
bill('hx', 'HLU*SVC LA', 7.99, [daysAgo(10)]);
//  - this cycle's charge is still pending
bill('d', 'Disney Plus', 13.99, [daysAgo(35), daysAgo(65), daysAgo(95)]);
bill('dp', 'Disney Plus', 13.99, [daysAgo(4)], { pending: true });
//  - one skipped month in a short history (gaps 30 + 61)
bill('a', 'Adobe Creative Cloud', 20.99, [daysAgo(12), daysAgo(42), daysAgo(103)]);
//  - two days behind its date: Due, not Late
bill('i', 'iCloud Storage', 2.99, [monthsAgo(1, 2), monthsAgo(2, 2), monthsAgo(3, 2)]);
//  - really missing; a same-price charge from elsewhere, far from its date,
//    must NOT pay it
bill('c', 'Crunchyroll', 9.49, [daysAgo(50), daysAgo(80), daysAgo(110)]);
bill('cx', 'Corner Store', 9.49, [daysAgo(2)]);
PLAID.push({ id: 'x1', merchant: 'Corner Cafe', name: 'Corner Cafe', amount: 6.4, date: daysAgo(1), account_id: 'a1', category: 'Food' });
PLAID.push({ id: 'x2', merchant: 'Payroll', name: 'ACME PAYROLL', amount: -2400, date: daysAgo(2), account_id: 'a1', category: 'Income' });
const SEED = {
  'dashboards/insight': { lastSyncAt: Date.now() - 3600e3, env: 'production' },
  'dashboards/insight/plaid_transactions': PLAID,
  'dashboards/insight/manual_transactions': [],
  'dashboards/insight/accounts': [
    { id: 'a1', name: 'Everyday Checking', institution: 'Test Bank', type: 'depository', subtype: 'checking', balance: 4210.55 },
    { id: 'a2', name: 'Rewards Card', institution: 'Test Bank', type: 'credit', subtype: 'credit card', balance: 612.3 },
  ],
  'dashboards/insight/meta/expenselog': {
    recurring: [
      { id: 'r1', name: 'Rent', monthly: 1400, annual: null, notes: 'Due on the 1st' },
      { id: 'r2', name: 'Car insurance', monthly: null, annual: 1260, notes: null },
      { id: 'r3', name: 'Phone plan', monthly: 45, annual: null, notes: null },
    ],
    recurringState: {}, recurringOrder: [], cash: 120,
  },
  'dashboards/insight/meta/prefs': { navOrder: ['transactions', 'accounts', 'import', 'addaccount', 'recurring', 'cash'] },
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
export const memoryLocalCache = () => ({});
export const doc = (db, ...p) => ({ path: p.join('/'), kind: 'doc' });
export const collection = (db, ...p) => ({ path: p.join('/'), kind: 'col' });
export const query = (c) => c;
export const orderBy = () => ({});
export const limit = () => ({});
const snap = (ref) => ref.kind === 'col'
  ? { docs: (SEED[ref.path] || []).map((d) => ({ id: d.id, data: () => d })) }
  : { exists: () => !!SEED[ref.path], data: () => SEED[ref.path] };
export const getDoc = (ref) => Promise.resolve(snap(ref));
export const setDoc = (ref, data) => { (window.__fsWrites = window.__fsWrites || []).push({ path: ref.path, data }); return Promise.resolve(); };
export const deleteDoc = () => Promise.resolve();
export const writeBatch = () => ({ set() {}, delete() {}, commit: () => Promise.resolve() });
export const onSnapshot = (ref, cb) => { setTimeout(() => cb(snap(ref)), 30); return () => {}; };
`;

const mock = {
  patterns: ['https://insight-api.av1.workers.dev/*', 'https://taskhub-reminders.av1.workers.dev/*', 'https://cdn.plaid.com/*'],
  handle(req) {
    if (req.url.startsWith('https://www.gstatic.com/firebasejs/')) return { text: FB, type: 'text/javascript' };
    if (req.url.startsWith('https://cdn.plaid.com/')) return { text: '', type: 'text/javascript' };
    if (!/^https:\/\/(insight-api|taskhub-reminders)\.av1\.workers\.dev/.test(req.url)) return null;
    if (req.method === 'OPTIONS') return { status: 204, json: null };
    return { json: { ok: true, items: [] } };
  },
};

const lastWrite = (c, path, field) => evalJs(c, `var w=(window.__fsWrites||[]).filter(x=>x.path===${JSON.stringify(path)}&&x.data&&x.data.${field}); return JSON.stringify(w.length?w[w.length-1].data.${field}:null);`).then(JSON.parse);
const tabs = (c) => evalJs(c, "return JSON.stringify([...document.querySelectorAll('#nav .tab')].map(t=>t.dataset.view));").then(JSON.parse);
const view = (c) => evalJs(c, "var v=document.querySelector('.view.active'); return v?v.id:'';");
const manual = (c) => evalJs(c, "return JSON.stringify([...document.querySelectorAll('#recManual > .txrow')].map(r=>r.dataset.rid));").then(JSON.parse);
const autos = (c) => evalJs(c, "return JSON.stringify([...document.querySelectorAll('#recAuto > .txrow')].map(r=>r.dataset.key));").then(JSON.parse);
const rect = async (c, js) => JSON.parse(await evalJs(c, `return JSON.stringify((() => { const e = (${js}); if (!e) return null; const b = e.getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, left: b.left, top: b.top}; })());`));
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
async function load(c, w, h, mobile) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/insight.html?blank' }); await sleep(800);
  await evalJs(c, "localStorage.clear(); localStorage.setItem('insight_lock_session', JSON.stringify({token:'test'})); 1");
  await c.send('Page.navigate', { url: ORIGIN + '/A1/insight.html' });
  await sleep(2200);
}
const go = (c, v) => evalJs(c, `document.querySelector('#nav .tab[data-view="${v}"]').click(); 1`).then(() => sleep(300));
async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const f = shotPath(SHOTS + '-' + name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log('shot', f);
}

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Network.setBypassServiceWorker', { bypass: true });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  if (SHOTS) {
    await load(c, 1280, 900, false);
    for (const v of ['transactions', 'accounts', 'import', 'addaccount', 'recurring', 'cash']) { await go(c, v); await shot(c, v); }
    await evalJs(c, "document.getElementById('addRecBtn').click(); 1"); await sleep(400);
    await shot(c, 'rec-modal');
    await evalJs(c, "document.getElementById('recModal').classList.remove('open'); document.getElementById('lockNowBtn').click(); 1"); await sleep(600);
    await shot(c, 'lock');
    await load(c, 400, 860, true);
    await shot(c, 'phone');
    c.ws.close(); process.exit(0);
  }

  // ── 1. theme ──
  await load(c, 1280, 900, false);
  console.log('theme');
  ok('body opts into MAGI hover', (await evalJs(c, "return document.body.dataset.hoverfx;")) === 'magi');
  ok('lock screen is out of the way', (await css(c, '#lockScreen', 'display')) === 'none');
  ok('"+ Add entry" is a solid purple fill', (await css(c, '#addManualBtn', 'backgroundColor')) === 'rgb(192, 174, 234)');
  ok('its label is dark', (await css(c, '#addManualBtn', 'color')) === 'rgb(26, 26, 29)');
  // Insight keeps its own type (Tony, 2026-10-02): only the colours are MAGI's.
  ok("buttons keep Insight's type (11.5px, 500)", (await css(c, '#addManualBtn', 'fontSize')) === '11.5px' && (await css(c, '#addManualBtn', 'fontWeight')) === '500');
  ok('the current tab is solid purple', (await css(c, '#nav .tab.active', 'backgroundColor')) === 'rgb(192, 174, 234)');
  ok('wordmark is #dbd0f5', (await css(c, 'header .brand', 'color')) === 'rgb(219, 208, 245)');
  ok('UI face is Inter', /Inter/.test(await css(c, 'body', 'fontFamily')));
  ok('figures are Inter, not a mono face', /^"?Inter/.test(await css(c, '#statIn', 'fontFamily')) && !/Plex/.test(await css(c, '.txamt', 'fontFamily')));
  ok('headings are Manrope at their old size', /Manrope/.test(await css(c, 'header .brand', 'fontFamily')) && (await css(c, '.tab', 'fontSize')) === '11.5px');
  ok('money in stays gold', (await css(c, '#statIn', 'color')) === 'rgb(224, 184, 116)');
  ok('no Fraunces is loaded', (await evalJs(c, "return !/Fraunces/.test([...document.querySelectorAll('link')].map(l=>l.href).join())+'';")) === 'true');
  const scan = async (label) => {
    const grads = await evalJs(c, "return [...document.querySelectorAll('.wrap *, #lockScreen, #lockScreen *')].filter(e=>{var s=getComputedStyle(e),a=getComputedStyle(e,'::after');return /gradient\\(/.test(s.backgroundImage+a.backgroundImage);}).map(e=>e.className||e.id||e.tagName).join(',');");
    ok('no gradient fills (' + label + ')', grads === '', grads);
    const gold = await evalJs(c, "return [...document.querySelectorAll('body *')].filter(e=>{var s=getComputedStyle(e);return /236, 199, 140/.test(s.color+s.backgroundColor+s.borderColor+s.boxShadow+s.outlineColor);}).map(e=>e.className||e.id||e.tagName).join(',');");
    ok('none of the old tan-gold (' + label + ')', gold === '', gold);
  };
  await scan('transactions');
  {
    const p = await rect(c, "document.getElementById('addManualBtn')");
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await sleep(300);
    const hv = await evalJs(c, "return document.getElementById('addManualBtn').style.filter;");
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await sleep(80);
    const pr = await evalJs(c, "var b=document.getElementById('addManualBtn'); return b.style.filter+' '+b.style.translate;");
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 895, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 }); await sleep(300);
    await evalJs(c, "document.getElementById('manualModal').classList.remove('open'); 1");
    ok('hover lifts brightness(1.15)', hv === 'brightness(1.15)', hv);
    ok('press is brightness(0.94) + 1px', /brightness\(0\.94\)/.test(pr) && /1px/.test(pr), pr);
  }
  {
    await evalJs(c, "document.getElementById('addManualBtn').click(); 1"); await sleep(300);
    ok('dialog backdrop is MAGI\'s', (await css(c, '#manualModal', 'backgroundColor')) === 'rgba(0, 0, 0, 0.62)');
    ok('the selected segment is solid purple', (await css(c, '#typeSeg button.on', 'backgroundColor')) === 'rgb(192, 174, 234)');
    await evalJs(c, "document.getElementById('mName').focus(); 1"); await sleep(250);
    ok('a focused field has the accent ring', /192, 174, 234/.test(await css(c, '#mName', 'boxShadow')) && (await css(c, '#mName', 'borderColor')) === 'rgb(192, 174, 234)');
    await evalJs(c, "document.getElementById('manualModal').classList.remove('open'); 1");
  }

  // ── 2. tab drag (desktop) ──
  console.log('tabs');
  ok('the tab strip is a dragsort list', (await evalJs(c, "return document.getElementById('nav').classList.contains('dsort')+'';")) === 'true');
  {
    const a = await rect(c, "document.querySelector('#nav .tab[data-view=transactions]')");
    const b = await rect(c, "document.querySelector('#nav .tab[data-view=import]')");
    await mouseDrag(c, a.x, a.y, b.x - a.x + b.w * 0.2, 0);
    const want = ['accounts', 'import', 'transactions', 'addaccount', 'recurring', 'cash'];
    ok('a mouse drag reorders the tabs', JSON.stringify(await tabs(c)) === JSON.stringify(want), await tabs(c));
    ok('the order is written to Firestore', JSON.stringify(await lastWrite(c, 'dashboards/insight/meta/prefs', 'navOrder')) === JSON.stringify(want), JSON.stringify(await lastWrite(c, 'dashboards/insight/meta/prefs', 'navOrder')));
    ok('the drop did not switch the view', (await view(c)) === 'view-transactions', await view(c));
    const r = await rect(c, "document.querySelector('#nav .tab[data-view=recurring]')");
    await click(c, r.x, r.y);
    ok('a plain click switches the view', (await view(c)) === 'view-recurring', await view(c));
    ok('the current tab follows the click', (await evalJs(c, "return document.querySelector('#nav .tab.active').dataset.view;")) === 'recurring');
  }

  // ── 3. Recurring drags ──
  console.log('recurring');
  await scan('recurring');
  const a0 = await autos(c);
  ok('nine auto-detected bills', a0.length === 9, JSON.stringify(a0));
  const billRow = (re) => evalJs(c, `var r=[...document.querySelectorAll('#recAuto > .txrow')].filter(r=>${re}.test(r.querySelector('.txname').textContent)); return JSON.stringify(r.map(x=>({st:x.querySelector('.chip').textContent, sub:x.querySelector('.txsub').textContent})));`).then(JSON.parse);
  {
    const h = await billRow('/hulu/i');
    ok('a renamed charge on schedule at the same price pays its bill', h.length === 1 && /^On time/.test(h[0].st) && /HLU\*SVC LA/.test(h[0].sub), JSON.stringify(h));
    const d = await billRow('/disney/i');
    ok('a pending charge counts as paid', d.length === 1 && /^On time/.test(d[0].st) && /pending/.test(d[0].sub), JSON.stringify(d));
    const a = await billRow('/adobe/i');
    ok('a skipped month does not lose the bill', a.length === 1 && /Monthly/.test(a[0].sub) && /^On time/.test(a[0].st), JSON.stringify(a));
    const i = await billRow('/icloud/i');
    ok('two days behind is Due, not Late', i.length === 1 && /^Due/.test(i[0].st) && !/Due soon/.test(i[0].st), JSON.stringify(i));
    const cr = await billRow('/crunchyroll/i');
    ok('a same-price charge from elsewhere does not pay a missing bill', cr.length === 1 && /^Missing/.test(cr[0].st) && !/Corner/.test(cr[0].sub), JSON.stringify(cr));
  }
  {
    const v = JSON.parse(await evalJs(c, "var r=[...document.querySelectorAll('#recAuto > .txrow')].find(r=>/vasa/i.test(r.textContent)); return JSON.stringify(r?{n:r.querySelectorAll('.txname').length,st:r.querySelector('.chip').textContent,last:r.textContent}:null);"));
    ok('a renamed charge joins its bill (Vasafit = Vasa Fitness)', !!v && (await evalJs(c, "return [...document.querySelectorAll('#recAuto > .txrow')].filter(r=>/vasa/i.test(r.textContent)).length;")) === 1, JSON.stringify(v));
    ok('so the paid bill is On time, not Missing', !!v && /On time/.test(v.st), v && v.st);
  }
  ok('three manual rows', JSON.stringify(await manual(c)) === '["r1","r2","r3"]', JSON.stringify(await manual(c)));
  ok('rows show no grip', (await evalJs(c, "return !document.querySelector('#recList .dsort-grip')+'';")) === 'true');
  const into = (id, block) => evalJs(c, `document.getElementById('${id}').scrollIntoView({block:'${block}'}); 1`).then(() => sleep(300));
  {
    await into('recManual', 'center');
    const a = await rect(c, "document.querySelector('#recManual > .txrow[data-rid=r1] .txname')");
    const z = await rect(c, "document.querySelector('#recManual > .txrow[data-rid=r3]')");
    await mouseDrag(c, a.x, a.y, 0, z.y - a.y + z.h * 0.3);
    ok('a manual row moves', JSON.stringify(await manual(c)) === '["r2","r3","r1"]', JSON.stringify(await manual(c)));
    await sleep(200);
    const w = await lastWrite(c, 'dashboards/insight/meta/expenselog', 'recurring');
    ok('the manual order is saved', JSON.stringify((w || []).map((r) => r.id)) === '["r2","r3","r1"]', JSON.stringify(w));
  }
  {
    await into('recAuto', 'start');
    const a = await rect(c, "document.querySelector('#recAuto > .txrow:nth-child(3) .txname')");
    const z = await rect(c, "document.querySelector('#recAuto > .txrow:first-child')");
    await mouseDrag(c, a.x, a.y, 0, z.y - a.y - z.h * 0.3);
    const want = [a0[2], a0[0], a0[1], ...a0.slice(3)];
    ok('an auto row moves', JSON.stringify(await autos(c)) === JSON.stringify(want), JSON.stringify(await autos(c)));
    await sleep(200);
    ok('the auto order is saved', JSON.stringify(await lastWrite(c, 'dashboards/insight/meta/expenselog', 'recurringOrder')) === JSON.stringify(want));
  }
  {
    // A manual row cannot be dropped among the auto rows above it.
    await into('recManual', 'center');
    const a = await rect(c, "document.querySelector('#recManual > .txrow .txname')");
    await mouseDrag(c, a.x, a.y, 0, -Math.min(300, a.y - 20));
    ok('a row stays in its own group', (await evalJs(c, "return document.querySelectorAll('#recAuto > .txrow[data-rid]').length;")) === 0 && (await manual(c)).length === 3);
  }
  {
    await into('recManual', 'center');
    const e = await rect(c, "document.querySelector('#recManual > .txrow [data-act=edit]')");
    await mouseDrag(c, e.x, e.y, 0, 60);
    ok('a press on a row\'s button does not drag it', JSON.stringify(await manual(c)) === '["r2","r3","r1"]', JSON.stringify(await manual(c)));
    await evalJs(c, "document.getElementById('recModal').classList.remove('open'); 1");
    await click(c, e.x, e.y);
    ok('the edit button still opens the entry', (await evalJs(c, "return document.getElementById('recModal').classList.contains('open')+'';")) === 'true');
  }

  // ── 4. the notes grip ──
  console.log('grip');
  ok('the old ns-resize grip is gone', (await evalJs(c, "return document.querySelectorAll('.ta-grip').length;")) === 0);
  ok('the notes field has MAGI\'s grip', (await evalJs(c, "var g=document.getElementById('rNotes').parentElement.querySelector('.a1-grip'); return g&&g.tagName;")) === 'BUTTON');
  {
    const h0 = await evalJs(c, "return Math.round(document.getElementById('rNotes').getBoundingClientRect().height);");
    const g = await rect(c, "document.getElementById('rNotes').parentElement.querySelector('.a1-grip')");
    await mouseDrag(c, g.x + 8, g.y + 8, 0, 90);
    const h1 = await evalJs(c, "return Math.round(document.getElementById('rNotes').getBoundingClientRect().height);");
    ok('dragging the grip grows the field', h1 >= h0 + 80, h0 + ' -> ' + h1);
    ok('the height is stored', (await evalJs(c, "return localStorage.getItem('a1.h.ins.rNotes');")) === String(h1));
    const g2 = await rect(c, "document.getElementById('rNotes').parentElement.querySelector('.a1-grip')");
    await click(c, g2.x + 8, g2.y + 8);
    ok('a click hands it back to auto', (await evalJs(c, "return document.getElementById('rNotes').style.height;")) === '' && (await evalJs(c, "return localStorage.getItem('a1.h.ins.rNotes');")) === null);
    ok('the entry note has a grip too', !!(await evalJs(c, "return document.getElementById('mNote').parentElement.querySelector('.a1-grip')?1:0;")));
    await evalJs(c, "document.getElementById('recModal').classList.remove('open'); 1");
  }
  {
    await evalJs(c, "document.getElementById('lockNowBtn').click(); 1"); await sleep(600);
    await scan('lock manager');
    ok('the lock card is outlined in purple', (await css(c, '#lockBox', 'borderTopColor')) === 'rgb(154, 134, 201)');
  }

  // ── 5. phone ──
  console.log('phone');
  await load(c, 400, 860, true);
  await go(c, 'recurring');
  {
    await evalJs(c, "document.getElementById('recManual').scrollIntoView({block:'center'}); 1"); await sleep(300);
    const a = await rect(c, "document.querySelector('#recManual > .txrow[data-rid=r1] .txname')");
    await touchDrag(c, a.x, a.y, 0, 140, 8, 0);
    ok('a quick swipe on a row does not drag it', JSON.stringify(await manual(c)) === '["r1","r2","r3"]', JSON.stringify(await manual(c)));
    const a2 = await rect(c, "document.querySelector('#recManual > .txrow[data-rid=r1] .txname')");
    const z = await rect(c, "document.querySelector('#recManual > .txrow[data-rid=r2]')");
    // dragsort swaps once the LEADING edge passes a neighbour's middle; r1
    // carries a note, so it is taller than r2.
    await touchDrag(c, a2.x, a2.y, 0, z.h * 0.75, 16, 450);
    ok('a held finger drags the row', JSON.stringify(await manual(c)) === '["r2","r1","r3"]', JSON.stringify(await manual(c)));
  }
  {
    await evalJs(c, "document.getElementById('nav').scrollLeft=0; window.scrollTo(0,0); 1"); await sleep(200);
    const t0 = await tabs(c);
    const a = await rect(c, "document.querySelector('#nav .tab[data-view=transactions]')");
    const b = await rect(c, "document.querySelector('#nav .tab[data-view=accounts]')");
    // dragsort swaps once the dragged tab's LEADING edge passes a neighbour's middle.
    await touchDrag(c, a.x, a.y, b.left + b.w * 0.6 - (a.left + a.w), 0, 16, 450);
    const t1 = await tabs(c);
    ok('a held finger drags a tab', t1[0] === 'accounts' && t1[1] === 'transactions', JSON.stringify(t0) + ' -> ' + JSON.stringify(t1));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
