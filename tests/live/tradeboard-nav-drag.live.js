// TradeBoard's top-bar tabs drag to rearrange (TB.nav, 2026-11-06), on MAGI's
// drag (dragsort.js) like TradeHub's. Real mouse and touch input over CDP,
// asserting the order TradeBoard SAVES (settings.navOrder, which syncs with the
// rest of settings), not just the DOM.
//
//   1. desktop: mouse-drag a tab, saved order changes, the drop's click does
//      not open the tab, a plain click does, a reload keeps the order
//   2. phone width: a quick swipe does not reorder; a held finger does
//   3. a remote settings change with a new order redraws the bar
//
// Real TradeBoard page, fake Firestore.
// Run: node tests/live/tradeboard-nav-drag.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const URL = 'https://anthonyn99.github.io/A1/V1/tradeboard.html';
const ORIGIN = 'https://anthonyn99.github.io';
const TBDOC = 'tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12';
const SEED = { [TBDOC]: { rulesDaily: JSON.stringify({ lastCompleted: null, enabled: false }), _updated: Date.now() } };
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

(async () => {
  const c = await connect({ mock: firebaseMock({ patterns: [], handle: () => null }) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 8000) / 200; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(200); } return false; };
  const tabs = async () => JSON.parse(await js(`return JSON.stringify([...document.querySelectorAll('#section-nav > button')].map(b=>b.dataset.section));`));
  const saved = async () => JSON.parse(await js(`return JSON.stringify((JSON.parse(localStorage.getItem('tb.settings')||'{}')).navOrder||null);`));
  const active = () => js(`var b=document.querySelector('#section-nav > button.active'); return b ? b.dataset.section : null;`);
  const rect = async (id) => JSON.parse(await js(`var b=document.querySelector('#section-nav > button[data-section="${id}"]').getBoundingClientRect(); return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2,right:b.right});`));
  const boot = async (w, h, mobile, fresh) => {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
    if (fresh) {
      await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
      await c.send('Page.navigate', { url: 'https://anthonyn99.github.io/A1/Shared/tni.js' }); await sleep(400);
      await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(SEED))}); 1`);
    }
    await c.send('Page.navigate', { url: URL });
    if (!(await until(`typeof TB !== 'undefined' && TB.nav && window._tbCloudSeen`, 15000))) throw new Error('TradeBoard did not open');
    await sleep(800);
  };
  const mouseDrag = async (x, y, dx) => {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 16; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / 16, y, button: 'left', buttons: 1 }); await sleep(16); }
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y, button: 'left', clickCount: 1 });
    await sleep(600);
  };
  const click = async (x, y) => {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(500);
  };
  const touchDrag = async (x, y, dx, holdMs) => {
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    if (holdMs) await sleep(holdMs);
    for (let i = 1; i <= 16; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 16, y }] }); await sleep(16); }
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(600);
  };

  // ── 1. desktop ──
  console.log('desktop');
  await boot(1366, 800, false, true);
  const t0 = await tabs();
  ok('seven tabs', t0.length === 7, JSON.stringify(t0));
  ok('the bar is a dsort list', await js(`return document.getElementById('section-nav').classList.contains('dsort');`));
  const before = await active();
  const a = await rect('journal'), b = await rect('rules');
  await mouseDrag(a.x, a.y, b.right - a.x - 4);
  const want = t0.filter((x) => x !== 'journal'); want.splice(want.indexOf('rules') + 1, 0, 'journal');
  ok('mouse drag moves Journal after Rules', JSON.stringify(await tabs()) === JSON.stringify(want), JSON.stringify(await tabs()));
  ok('order saved (settings.navOrder)', JSON.stringify(await saved()) === JSON.stringify(want), JSON.stringify(await saved()));
  ok('the drop did not open Journal', (await active()) === before, await active());
  let D = null;
  for (let i = 0; i < 30; i++) { await sleep(200); D = await js(`return JSON.stringify(__fakeFs.docs[${JSON.stringify(TBDOC)}]||null);`).then(JSON.parse); if (D && /navOrder/.test(D.settings || '')) break; }
  ok('the order syncs to the cloud with settings', D && JSON.stringify(JSON.parse(D.settings).navOrder) === JSON.stringify(want), D && D.settings);
  const n = await rect('news');
  await click(n.x, n.y);
  ok('a plain click opens the tab', (await active()) === 'news' && await js(`return document.getElementById('view-news').classList.contains('active');`));
  await boot(1366, 800, false, false);
  ok('reload keeps the order', JSON.stringify(await tabs()) === JSON.stringify(want), JSON.stringify(await tabs()));

  // ── 2. phone ──
  console.log('phone');
  await boot(390, 844, true, true);
  const m0 = await tabs();
  const ma = await rect('journal'), mb = await rect('news');
  await touchDrag(ma.x, ma.y, mb.right - ma.x - 4, 0);
  ok('a quick swipe does not reorder', JSON.stringify(await tabs()) === JSON.stringify(m0), JSON.stringify(await tabs()));
  await js(`document.getElementById('section-nav').scrollLeft=0; 1`); await sleep(200);
  const ma2 = await rect('journal'), mb2 = await rect('news');
  await touchDrag(ma2.x, ma2.y, mb2.right - ma2.x - 4, 420);
  const mwant = m0.filter((x) => x !== 'journal'); mwant.splice(mwant.indexOf('news') + 1, 0, 'journal');
  ok('a held finger drags Journal after News', JSON.stringify(await tabs()) === JSON.stringify(mwant), JSON.stringify(await tabs()));
  ok('phone order saved', JSON.stringify(await saved()) === JSON.stringify(mwant));

  // ── 3. remote ──
  console.log('remote');
  const remote = ['control', 'portfolio', 'journal', 'news', 'strats', 'rules', 'apps'];
  await js(`var s=JSON.parse(localStorage.getItem('tb.settings')||'{}'); s.navOrder=${JSON.stringify(remote)}; localStorage.setItem('tb.settings', JSON.stringify(s)); TB.nav.apply(); 1`);
  ok('a new order from settings redraws the bar', JSON.stringify(await tabs()) === JSON.stringify(remote), JSON.stringify(await tabs()));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
