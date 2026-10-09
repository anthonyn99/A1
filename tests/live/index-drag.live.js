// Theme overhaul phase 1b: Tony's chrome drags in index.html run on dragsort.js
// (MAGI's drag). Real mouse and touch input over CDP, asserting the order the
// nav actually saves (window._navGetOrder) -- not just what the DOM shows.
//
//   1. desktop: mouse-drag a program-nav button sideways
//   2. desktop: the nav sits still under the cursor, and a plain click navigates
//   3. phone width: a held finger drags a dropdown row (no grips: Tony, 2026-10-02)
//   4. phone width: a quick swipe on a dropdown row does not drag
//   5. Settings → External links: mouse-drag a row
//   6. Veda's dropdown still carries her own grip (untouched)
//
// Run: node tests/live/index-drag.live.js
'use strict';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io';
const order = (c) => evalJs(c, "return JSON.stringify(window._navGetOrder('tony'));").then(JSON.parse);
const rect = async (c, js) => JSON.parse(await evalJs(c, `return JSON.stringify((() => { const b = (${js}).getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height}; })());`));

async function mouseDrag(c, x, y, dx, dy, steps = 16) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
  await sleep(400);
}
async function touchDrag(c, x, y, dy, steps = 16, holdMs = 0) {
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  if (holdMs) await sleep(holdMs);
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / steps }] });
    await sleep(16);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
}
async function load(c, who, w, h, mobile) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html' }); await sleep(800);
  await evalJs(c, `localStorage.clear(); localStorage.setItem('td6_mainDash','${who}'); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  await sleep(9000);
  await evalJs(c, "var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
}

(async () => {
  const c = await connect();
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });

  console.log('\nDesktop: the program nav');
  await load(c, 'tony', 1440, 900, false);
  ok('dragsort.js loaded', await evalJs(c, 'return !!window.A1Drag;'));
  ok('the nav row is an A1Drag list', await evalJs(c, "return document.getElementById('tony-app-nav-inner').classList.contains('dsort');"));
  ok('no HTML5 draggable left on Tony\'s nav', await evalJs(c, "return !document.querySelector('#tony-app-nav-inner .tn-btn[draggable]');"));
  const before = await order(c);
  const vis = JSON.parse(await evalJs(c, "return JSON.stringify([...document.querySelectorAll('#tony-app-nav-inner .tn-btn')].map(b=>b.getAttribute('data-app')));"));
  const b0 = await rect(c, `document.querySelector('#tony-app-nav-inner .tn-btn[data-app="${vis[0]}"]')`);
  const b2 = await rect(c, `document.querySelector('#tony-app-nav-inner .tn-btn[data-app="${vis[2]}"]')`);
  // The dragged button's leading (right) edge ends just past the third's middle.
  await mouseDrag(c, b0.x, b0.y, (b2.x + 4) - (b0.x + b0.w / 2), 0);
  const after = await order(c);
  const exp = before.slice(); exp.splice(exp.indexOf(vis[0]), 1); exp.splice(before.indexOf(vis[2]), 0, vis[0]);
  ok('mouse: first button dragged past the third lands third (saved order)', JSON.stringify(after) === JSON.stringify(exp), JSON.stringify({ before, after }));
  ok('nothing left lifted', await evalJs(c, "return !document.querySelector('.dsort-drag') && !document.documentElement.classList.contains('dsort-grabbing');"));
  ok('the drag did not navigate (its click was swallowed)', await evalJs(c, "return (window._tnCurApp||'taskhub')==='taskhub';"), await evalJs(c, 'return window._tnCurApp;'));
  await c.send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(shotPath('p1b-nav-after'), Buffer.from(r.result.data, 'base64')));

  // The nav must sit still under a resting cursor: a render loop once rebuilt
  // the buttons every ~100ms (hover flicker, clicks lost).
  const mj = await rect(c, `document.querySelector('#tony-app-nav-inner .tn-btn[data-app="custom:myjournal"]')`);
  await evalJs(c, "window._tnMut=0; new MutationObserver(function(m){ window._tnMut+=m.length; }).observe(document.getElementById('tony-app-nav-inner'),{childList:true}); 1");
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mj.x, y: mj.y });
  await sleep(1500);
  ok('the nav is not re-rendered while the cursor rests on it', (await evalJs(c, 'return window._tnMut;')) === 0, await evalJs(c, 'return window._tnMut;'));
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mj.x, y: mj.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mj.x, y: mj.y, button: 'left', clickCount: 1 });
  await sleep(1200);
  ok('a plain click on MyJournal opens MyJournal', (await evalJs(c, 'return window._tnCurApp;')) === 'brainstormjournal', await evalJs(c, 'return window._tnCurApp;'));

  console.log('\nPhone width: the dropdown');
  await load(c, 'tony', 390, 844, true);
  await evalJs(c, "document.getElementById('tn-dd-trigger').click(); 1");
  await sleep(400);
  ok('dropdown rows show no grip', await evalJs(c, "return document.querySelectorAll('#tn-dd-panel .tn-dd-item').length>3 && !document.querySelector('#tn-dd-panel .dsort-grip');"));
  const o1 = await order(c);
  const r1 = await rect(c, "document.querySelectorAll('#tn-dd-panel .tn-dd-item')[1]");
  // a quick swipe on the row: the list scrolls, nothing moves
  const l0 = await rect(c, "document.querySelector('#tn-dd-panel .tn-dd-item .dd-text')");
  await touchDrag(c, l0.x, l0.y, r1.h * 2);
  ok('a quick swipe on a row does not reorder', JSON.stringify(await order(c)) === JSON.stringify(o1));
  if (!(await evalJs(c, "return getComputedStyle(document.getElementById('tn-dd-panel')).display!=='none';"))) {
    await evalJs(c, "document.getElementById('tn-dd-trigger').click(); 1"); await sleep(400);
  }
  await touchDrag(c, l0.x, l0.y, r1.h * 2 + 4, 16, 400);
  const o2 = await order(c);
  const e2 = o1.slice(); const m = e2.splice(0, 1)[0]; e2.splice(2, 0, m);
  ok('a held finger: row 0 dragged two rows down lands at 2 (saved order)', JSON.stringify(o2) === JSON.stringify(e2), JSON.stringify({ o1, o2 }));
  await c.send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(shotPath('p1b-dd-after'), Buffer.from(r.result.data, 'base64')));

  console.log('\nSettings: external link rows');
  await load(c, 'tony', 1440, 900, false);
  await evalJs(c, "window._openSettings('tony'); 1");
  await sleep(800);
  const ids = () => evalJs(c, "return JSON.stringify([...document.querySelectorAll('#thset-linklist .thset-link-row')].map(r=>r.getAttribute('data-link-id')));").then(JSON.parse);
  const i1 = await ids();
  ok('Settings rows show no grip', await evalJs(c, "return !document.querySelector('#thset-linklist .dsort-grip, #thset-linklist .thset-grip');") && i1.length > 1, i1.length);
  if (i1.length > 1) {
    await evalJs(c, "document.querySelector('#thset-linklist .thset-link-row').scrollIntoView({block:'center'}); 1");
    await sleep(300);
    const sg = await rect(c, "document.querySelector('#thset-linklist .thset-link-row .thset-label')");
    const sr = await rect(c, "document.querySelectorAll('#thset-linklist .thset-link-row')[1]");
    await mouseDrag(c, sg.x, sg.y, 0, sr.y - sg.y + 6);
    await sleep(500);
    const i2 = await ids();
    const e3 = i1.slice(); const mm = e3.splice(0, 1)[0]; e3.splice(1, 0, mm);
    ok('mouse: first link row dragged one down lands at 1 (re-rendered from the saved order)', JSON.stringify(i2) === JSON.stringify(e3), JSON.stringify({ i1, i2 }));
  }

  console.log('\nVeda: untouched');
  await load(c, 'veda', 390, 844, true);
  ok('Veda\'s nav is not an A1Drag list', await evalJs(c, "return !document.querySelector('#veda-root .dsort, .vd-dd-item .dsort-grip');"));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
