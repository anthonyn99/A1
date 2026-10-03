// Theme overhaul phase 4: TradeHub in MAGI's look, its page tabs and prompt
// chips on dragsort.js (MAGI's drag) and its resizable boxes on resizegrip.js
// (MAGI's corner grip). Real mouse and touch input over CDP, asserting the
// order TradeHub actually SAVES (localStorage tb_nav_order_v1 and
// tradeboard_prompts_v2), not just the DOM.
//
// Firebase stays blocked (cdp.js), so TradeHub runs on its local copies.
//
//   1. theme: MAGI tokens, purple wordmark, MAGI buttons, magi hover/press
//   2. desktop: mouse-drag a page tab, saved order changes, the drop's click
//      does not navigate, a plain click does
//   3. phone width: a held finger drags a tab; a quick swipe does not
//   4. Control: mouse-drag a prompt chip, saved order changes, the selected
//      prompt follows its chip; a plain click selects; a held finger drags
//   5. the prompt preview, the Quick Prompt box and the trade Notes box carry
//      MAGI's grip: drag, click toggle, reload keeps the height
//
// Run:          node tests/live/tradehub-drag.live.js
// Shots only:   node tests/live/tradehub-drag.live.js --shots <label>
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
const URL = ORIGIN + '/A1/tradehub.html';
const SHOTS = process.argv[2] === '--shots' ? (process.argv[3] || 'tradehub') : null;

const PROMPTS = [
  { id: 'pa', name: 'Alpha prompt', text: '# Alpha\n\nLine one of the alpha prompt.\n\n- a\n- b\n- c' },
  { id: 'pb', name: 'Bravo prompt', text: 'The bravo prompt.' },
  { id: 'pc', name: 'Charlie prompt', text: 'The charlie prompt.' },
];

const tabs = (c, sel) => evalJs(c, `return JSON.stringify([...document.querySelectorAll('${sel} .tb-navtab')].map(b=>b.dataset.navid));`).then(JSON.parse);
const savedNav = (c) => evalJs(c, "return localStorage.getItem('tb_nav_order_v1')||'null';").then(JSON.parse);
const chips = (c) => evalJs(c, "return JSON.stringify([...document.querySelectorAll('.tb-pchip')].map(b=>b.dataset.dkey));").then(JSON.parse);
const savedPrompts = (c) => evalJs(c, "return JSON.stringify((JSON.parse(localStorage.getItem('tradeboard_prompts_v2')||'[]')).map(p=>p.id));").then(JSON.parse);
const rect = async (c, js) => JSON.parse(await evalJs(c, `return JSON.stringify((() => { const e = (${js}); if (!e) return null; const b = e.getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, left: b.left, right: b.right, top: b.top, bottom: b.bottom}; })());`));
const css = (c, sel, prop) => evalJs(c, `var e=document.querySelector(${JSON.stringify(sel)}); return e?getComputedStyle(e)[${JSON.stringify(prop)}]:'(none)';`);
const DESK = '.tb-desktop-header', MOB = '.tb-mobile-header';
const tab = (scope, id) => `document.querySelector('${scope} .tb-navtab[data-navid="${id}"]')`;
const chip = (id) => `document.querySelector('.tb-pchip[data-dkey="${id}"]')`;

async function mouseDrag(c, x, y, dx, dy, steps = 16) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
  await sleep(600);
}
async function click(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(500);
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
async function load(c, w, h, mobile, keepStorage) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  if (!keepStorage) {
    await c.send('Page.navigate', { url: URL + '?blank' }); await sleep(800);
    await evalJs(c, `localStorage.clear(); localStorage.setItem('tradeboard_prompts_v2', ${JSON.stringify(JSON.stringify(PROMPTS))}); 1`);
  }
  await c.send('Page.navigate', { url: URL });
  // Babel compiles TradeHub in-page (~3s), then Portfolio's auto-connect
  // attempt settles.
  for (let i = 0; i < 40 && !(await evalJs(c, "return !!document.querySelector('.tb-navtab');")); i++) await sleep(250);
  await sleep(2500);
}
// Scroll a thing into the middle of the view before measuring it.
const see = (c, js) => evalJs(c, `var e=(${js}); if(e) e.scrollIntoView({block:'center'}); 1`).then(() => sleep(300));
async function goTo(c, scope, id) {
  const r = await rect(c, tab(scope, id));
  if (r) await click(c, r.x, r.y);
  await sleep(600);
}
async function shot(c, name, w, h) {
  if (w) { await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 }); await sleep(500); }
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const f = shotPath(SHOTS + '-' + name);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log('shot', f);
}
// A grip under a box: drag it down 60px, click it twice, reload.
async function gripChecks(c, name, boxJs, key, reopen) {
  await see(c, boxJs);
  const g = await rect(c, `(${boxJs}) && (${boxJs}).parentElement.querySelector(':scope > .a1-grip')`);
  ok(name + ': has MAGI\'s grip button', !!g);
  if (!g) return;
  ok(name + ': no native resize corner', (await evalJs(c, `return getComputedStyle(${boxJs}).resize;`)) === 'none');
  const h0 = (await rect(c, boxJs)).h;
  await mouseDrag(c, g.x - 8, g.y - 8, 0, 60);
  const h1 = (await rect(c, boxJs)).h;
  ok(name + ': grip drag grows the box ~60px', Math.abs(h1 - h0 - 60) <= 6, h0 + ' -> ' + h1);
  ok(name + ': height stored as a1.h.' + key, (await evalJs(c, `return localStorage.getItem('a1.h.${key}');`)) === String(Math.round(h1)),
    await evalJs(c, `return localStorage.getItem('a1.h.${key}');`));
  await reopen(true);
  await see(c, boxJs);
  const h2 = (await rect(c, boxJs)).h;
  ok(name + ': reload keeps the height', Math.abs(h2 - h1) <= 2, h1 + ' -> ' + h2);
  const g2 = await rect(c, `(${boxJs}).parentElement.querySelector(':scope > .a1-grip')`);
  await click(c, g2.x - 8, g2.y - 8);
  ok(name + ': a click hands it back to auto', (await evalJs(c, `return (${boxJs}).getAttribute('data-user-h');`)) === null
    && (await evalJs(c, `return localStorage.getItem('a1.h.${key}');`)) === null);
  const g3 = await rect(c, `(${boxJs}).parentElement.querySelector(':scope > .a1-grip')`);
  await click(c, g3.x - 8, g3.y - 8);
  const h4 = (await rect(c, boxJs)).h;
  ok(name + ': a second click expands it (>= 260px)', h4 >= 259, h4);
}

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Network.setBypassServiceWorker', { bypass: true });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });

  if (SHOTS) {
    await load(c, 1440, 900, false);
    await shot(c, 'portfolio');
    for (const t of ['journal', 'prompt', 'analysis', 'news', 'playbook', 'catalysts']) {
      await goTo(c, DESK, t);
      await shot(c, t);
    }
    await goTo(c, DESK, 'prompt');
    await evalJs(c, "window.uiConfirm&&window.uiConfirm('Move this prompt to the Trash?',{title:'Move to Trash'}); 1");
    await sleep(400); await shot(c, 'confirm');
    await evalJs(c, "var b=document.getElementById('uim-cancel'); if(b) b.click(); 1");
    await load(c, 400, 860, true);
    await shot(c, 'phone');
    await goTo(c, MOB, 'prompt'); await shot(c, 'phone-prompt');
    c.ws.close(); process.exit(0);
  }

  // ── 1. theme ─────────────────────────────────────────────────────────────
  console.log('theme');
  await load(c, 1440, 900, false);
  ok('--ac is MAGI purple', (await evalJs(c, "return getComputedStyle(document.getElementById('tradeboard-root')).getPropertyValue('--ac').trim();")) === '#c0aeea');
  ok('--gold is still real gold', (await evalJs(c, "return getComputedStyle(document.getElementById('tradeboard-root')).getPropertyValue('--gold').trim();")) === '#e0b874');
  ok('wordmark is #dbd0f5', (await css(c, '.tb-desktop-header .suite-title', 'color')) === 'rgb(219, 208, 245)');
  ok('no Fraunces / DM fonts loaded', (await evalJs(c, "return [...document.querySelectorAll('link[href*=\"fonts.googleapis\"]')].map(l=>l.href).join(' ');")).search(/Fraunces|DM\+Sans|Bebas/) < 0);
  ok('body is data-hoverfx="magi"', (await evalJs(c, "return document.body.dataset.hoverfx;")) === 'magi');
  ok('active tab is purple', (await evalJs(c, `return getComputedStyle(${tab(DESK, 'portfolio')}).color;`)) === 'rgb(192, 174, 234)');
  ok('Connect button: solid purple, dark label, no halo', await evalJs(c, `var b=[...document.querySelectorAll('button')].find(b=>/Connect to Webull/.test(b.textContent)); if(!b) return false; var s=getComputedStyle(b); return s.backgroundColor==='rgb(192, 174, 234)'&&s.color==='rgb(26, 26, 29)'&&s.boxShadow==='none';`));
  const pb = await rect(c, tab(DESK, 'journal'));
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pb.x, y: pb.y }); await sleep(300);
  ok('hover lift is brightness(1.15)', (await evalJs(c, `return ${tab(DESK, 'journal')}.style.filter;`)) === 'brightness(1.15)');
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 700 }); await sleep(300);

  // ── 2. desktop tab drag ──────────────────────────────────────────────────
  console.log('desktop tabs');
  const t0 = await tabs(c, DESK);
  ok('seven tabs', t0.length === 7, JSON.stringify(t0));
  ok('tabs are a dsort list', await evalJs(c, "return document.querySelector('.tb-desktop-header nav').classList.contains('dsort');"));
  const a = await rect(c, tab(DESK, 'journal')), b = await rect(c, tab(DESK, 'playbook'));
  await mouseDrag(c, a.x, a.y, b.right - a.x - 4, 0);
  const t1 = await tabs(c, DESK);
  const want = t0.filter((x) => x !== 'journal'); want.splice(want.indexOf('playbook') + 1, 0, 'journal');
  ok('mouse drag moves Journal after Playbook', JSON.stringify(t1) === JSON.stringify(want), JSON.stringify(t1));
  ok('order saved (tb_nav_order_v1)', JSON.stringify(await savedNav(c)) === JSON.stringify(want), JSON.stringify(await savedNav(c)));
  ok('the drop did not navigate', (await evalJs(c, `return getComputedStyle(${tab(DESK, 'portfolio')}).color;`)) === 'rgb(192, 174, 234)');
  ok('phone tabs follow the new order', JSON.stringify(await tabs(c, MOB)) === JSON.stringify(want));
  const n = await rect(c, tab(DESK, 'news'));
  await click(c, n.x, n.y);
  ok('a plain click navigates', (await evalJs(c, `return getComputedStyle(${tab(DESK, 'news')}).color;`)) === 'rgb(192, 174, 234)');
  await load(c, 1440, 900, false, true);
  ok('reload keeps the order', JSON.stringify(await tabs(c, DESK)) === JSON.stringify(want));

  // ── 3. phone tab drag ────────────────────────────────────────────────────
  console.log('phone tabs');
  await load(c, 400, 860, true);
  const m0 = await tabs(c, MOB);
  const ma = await rect(c, tab(MOB, 'journal')), mb = await rect(c, tab(MOB, 'catalysts'));
  await touchDrag(c, ma.x, ma.y, mb.right - ma.x - 4, 0, 0);
  ok('a quick swipe does not reorder', JSON.stringify(await tabs(c, MOB)) === JSON.stringify(m0), JSON.stringify(await tabs(c, MOB)));
  const ma2 = await rect(c, tab(MOB, 'journal')), mb2 = await rect(c, tab(MOB, 'catalysts'));
  await touchDrag(c, ma2.x, ma2.y, mb2.right - ma2.x - 4, 0, 420);
  const m1 = await tabs(c, MOB);
  const mwant = m0.filter((x) => x !== 'journal'); mwant.splice(mwant.indexOf('catalysts') + 1, 0, 'journal');
  ok('a held finger drags Journal after Catalysts', JSON.stringify(m1) === JSON.stringify(mwant), JSON.stringify(m1));
  ok('phone order saved', JSON.stringify(await savedNav(c)) === JSON.stringify(mwant));

  // ── 4. prompt chips ──────────────────────────────────────────────────────
  console.log('prompt chips');
  await load(c, 1440, 900, false);
  await goTo(c, DESK, 'prompt');
  await see(c, chip('pa'));
  ok('three chips', JSON.stringify(await chips(c)) === '["pa","pb","pc"]', JSON.stringify(await chips(c)));
  ok('selected chip is solid purple with a dark label', await evalJs(c, `var s=getComputedStyle(${chip('pa')}); return s.backgroundColor==='rgb(192, 174, 234)'&&s.color==='rgb(26, 26, 29)';`));
  const ca = await rect(c, chip('pa')), cc = await rect(c, chip('pc'));
  // Lifted, the selected chip sits on s2: its dark label went black (Tony, 2026-10-02).
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ca.x, y: ca.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ca.x, y: ca.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 4; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ca.x + i * 5, y: ca.y, button: 'left', buttons: 1 }); await sleep(16); }
  const liftC = await evalJs(c, `var e=${chip('pa')}; return e.classList.contains('dsort-drag')+' '+getComputedStyle(e).color;`);
  ok('lifted selected chip keeps a light label', liftC === 'true rgb(244, 243, 240)', liftC);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ca.x + 20, y: ca.y, button: 'left', clickCount: 1 });
  await sleep(600);
  await mouseDrag(c, ca.x, ca.y, cc.right - ca.x - 6, 0);
  ok('mouse drag moves Alpha to the end', JSON.stringify(await chips(c)) === '["pb","pc","pa"]', JSON.stringify(await chips(c)));
  ok('order saved (tradeboard_prompts_v2)', JSON.stringify(await savedPrompts(c)) === '["pb","pc","pa"]', JSON.stringify(await savedPrompts(c)));
  ok('the selection follows Alpha', await evalJs(c, `return getComputedStyle(${chip('pa')}).backgroundColor==='rgb(192, 174, 234)';`));
  await see(c, chip('pb'));
  const cb = await rect(c, chip('pb'));
  await click(c, cb.x, cb.y);
  ok('a plain click selects Bravo', await evalJs(c, `return getComputedStyle(${chip('pb')}).backgroundColor==='rgb(192, 174, 234)' && /bravo prompt/.test(document.querySelector('.tb-prompt-render').textContent);`));

  // ── 5. grips ─────────────────────────────────────────────────────────────
  console.log('grips');
  await see(c, chip('pa'));
  const ca2 = await rect(c, chip('pa'));
  await click(c, ca2.x, ca2.y);   // the long one
  await gripChecks(c, 'prompt preview', "document.querySelector('.tb-prompt-render')", 'th.prompt',
    async () => { await load(c, 1440, 900, false, true); await goTo(c, DESK, 'prompt'); });
  await goTo(c, DESK, 'analysis');
  await gripChecks(c, 'quick prompt', "document.querySelector('textarea.tb-quick-box')", 'th.quick',
    async () => { await load(c, 1440, 900, false, true); await goTo(c, DESK, 'analysis'); });
  // Deploy: leaving the button used to fade its purple fill under hoverfx's
  // dropped brightness and flash (Tony, 2026-10-02). The fill swaps at once.
  const depJs = "[...document.querySelectorAll('button')].find(b=>/Deploy Trading Auto Launch/.test(b.textContent))";
  await see(c, depJs);
  const dp = await rect(c, depJs);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dp.x, y: dp.y }); await sleep(300);
  const depOn = await evalJs(c, `var s=getComputedStyle(${depJs}); return s.backgroundColor+' '+s.color;`);
  ok('Deploy hover: solid purple, dark label', depOn === 'rgb(192, 174, 234) rgb(26, 26, 29)', depOn);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dp.x, y: dp.bottom + 120 });
  const depOff = await evalJs(c, `var s=getComputedStyle(${depJs}); return s.backgroundColor+' | '+s.transitionProperty;`);
  // Set Password kept an old inline transparent background over the solid
  // purple, so its dark label read black on charcoal (Tony, 2026-10-02).
  const setPw = await evalJs(c, `window._tbManageLock(); var b=document.getElementById('applock-submit'), s=getComputedStyle(b); var r=b.textContent+' | '+s.backgroundColor+' | '+s.color; document.getElementById('applock-cancel').click(); return r;`);
  ok('Set Password: solid purple with a dark label', setPw === 'Set Password | rgb(192, 174, 234) | rgb(26, 26, 29)', setPw);
  ok('Deploy leave: the fill is gone at once (no background fade)', /^rgba\(0, 0, 0, 0\) \| /.test(depOff) && !/\b(all|background)/.test(depOff.split('|')[1]), depOff);
  const openTrade = async () => {
    await goTo(c, DESK, 'journal');
    await evalJs(c, "var b=[...document.querySelectorAll('button')].find(b=>/Manual Trade/i.test(b.textContent)); if(b) b.click(); 1");
    await sleep(600);
    await evalJs(c, "var b=[...document.querySelectorAll('.tb-modal-inner button')].find(b=>/^Journal$/.test(b.textContent.trim())); if(b) b.click(); 1");
    await sleep(400);
  };
  await openTrade();
  await gripChecks(c, 'trade notes', "document.querySelector('textarea.tb-notes-box')", 'th.trade-notes',
    async () => { await load(c, 1440, 900, false, true); await openTrade(); });

  // ── phone: a held finger drags a chip ──
  console.log('phone chips');
  await load(c, 400, 860, true);
  await goTo(c, MOB, 'prompt');
  await see(c, chip('pa'));
  const pa = await rect(c, chip('pa')), pbb = await rect(c, chip('pb'));
  await touchDrag(c, pa.x, pa.y, pbb.right - pa.x - 4, pbb.y - pa.y, 0);
  ok('phone: a quick swipe does not move a chip', JSON.stringify(await chips(c)) === '["pa","pb","pc"]', JSON.stringify(await chips(c)));
  const pa2 = await rect(c, chip('pa')), pb2 = await rect(c, chip('pb'));
  await touchDrag(c, pa2.x, pa2.y, pb2.right - pa2.x - 4, pb2.y - pa2.y, 420);
  ok('phone: a held finger moves Alpha after Bravo', JSON.stringify(await chips(c)) === '["pb","pa","pc"]', JSON.stringify(await chips(c)));
  ok('phone: chip order saved', JSON.stringify(await savedPrompts(c)) === '["pb","pa","pc"]');

  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
