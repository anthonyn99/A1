// The "Backed up" chip used to float bottom-left over everything, and on a
// phone it covered Notebook's edit/view button and TaskHub rows (Tony,
// 2026-10-14). It now lives in each TaskHub's Settings as a "Backup" row that
// opens into this device's stats and closes again.
//
//   1. no floating chip anywhere on the page
//   2. Tony's and Veda's Settings both carry the Backup row, collapsed
//   3. a click opens it (stats grid), a second click closes it
//   4. off -> problem -> healthy, driven by the real backup.js
//   5. nothing spills sideways at 390px or 1280px
//
// Run: node tests/live/settings-backup.live.js
'use strict';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io';

async function load(c, w, h, mobile) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html' }); await sleep(800);
  await evalJs(c, "localStorage.clear(); localStorage.setItem('td6_mainDash','tony'); indexedDB.deleteDatabase && 1");
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  await sleep(9000);
  await evalJs(c, "var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
}
const click = async (c, sel) => {
  const r = JSON.parse(await evalJs(c, `const b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2});`));
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await sleep(500);
};
const shot = async (c, name) => {
  const s = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(s.result.data, 'base64'));
};
const state = (c) => evalJs(c, `const b=document.getElementById('thset-bk'); if(!b) return 'null';
  const body=b.querySelector('.thset-bk-body'), box=document.getElementById('thset-box');
  return JSON.stringify({ state:b.getAttribute('data-state'), sum:b.querySelector('.thset-bk-sum').textContent,
    expanded:b.querySelector('.thset-bk-head').getAttribute('aria-expanded'), hidden:body.hidden,
    shown: body.offsetHeight>0, stats: body.querySelectorAll('.thset-bk-stat').length,
    cols: body.querySelector('.thset-bk-grid') ? getComputedStyle(body.querySelector('.thset-bk-grid')).gridTemplateColumns.split(' ').length : 0,
    msg: (body.querySelector('.thset-bk-msg')||{}).textContent||'',
    on: !!body.querySelector('.thset-bk-on'),
    spill: box.scrollWidth - box.clientWidth,
    rowSpill: [...b.querySelectorAll('*')].some(e=>e.getBoundingClientRect().right>b.getBoundingClientRect().right+1) });`).then(JSON.parse);

async function run(c, w, h, mobile) {
  console.log(`\n${w}px`);
  await load(c, w, h, mobile);
  ok('backup.js loaded with summary()', await evalJs(c, "return !!(window.A1Backup&&A1Backup.summary);"));
  ok('no floating chip on the page', await evalJs(c, "return !document.getElementById('a1b-chip');"));

  for (const who of ['tony', 'veda']) {
    await evalJs(c, `window._openSettings('${who}'); 1`); await sleep(700);
    let s = await state(c);
    ok(`${who}: Backup row present, collapsed`, s && s.expanded === 'false' && s.hidden && !s.shown, JSON.stringify(s));
    ok(`${who}: off state says so`, s.state === 'off' && /Backups off/.test(s.sum), JSON.stringify(s));
    await click(c, '#thset-bk .thset-bk-head');
    s = await state(c);
    ok(`${who}: click opens it`, s.expanded === 'true' && s.shown, JSON.stringify(s));
    ok(`${who}: off -> offers Turn on backups`, s.on && /off on this device/.test(s.msg), JSON.stringify(s));
    await shot(c, `settings-backup-${who}-${w}-off`);
    await click(c, '#thset-bk .thset-bk-head');
    s = await state(c);
    ok(`${who}: second click closes it`, s.expanded === 'false' && !s.shown, JSON.stringify(s));
    await evalJs(c, "document.querySelector('.thset-close').click(); 1"); await sleep(300);
  }

  // Set up, nothing captured yet: a real problem state.
  await evalJs(c, "return A1Backup.unlock('test-pass-123').then(()=>1,()=>0);");
  await evalJs(c, "window._openSettings('tony'); 1"); await sleep(800);
  await click(c, '#thset-bk .thset-bk-head'); await sleep(300);
  let s = await state(c);
  ok('set up but never saved -> problem', s.state === 'warn' && /Problem/.test(s.msg), JSON.stringify(s));

  // A real capture, announced by backup.js, repaints the open panel.
  await evalJs(c, "A1Backup.observe('dashboards/test',{a:1}); return A1Backup.capture({force:true}).then(r=>JSON.stringify(r));");
  await sleep(800);
  s = await state(c);
  ok('after a capture -> healthy, open panel repainted live', s.state === 'ok' && /just now/.test(s.sum) && s.stats === 6, JSON.stringify(s));
  ok(`stats grid: ${mobile ? 2 : 3} columns`, s.cols === (mobile ? 2 : 3), s.cols);
  ok('nothing spills sideways', s.spill <= 0 && !s.rowSpill, JSON.stringify(s));
  await shot(c, `settings-backup-tony-${w}-ok`);
  await evalJs(c, "document.querySelector('.thset-close').click(); window._openSettings('veda'); 1"); await sleep(800);
  await click(c, '#thset-bk .thset-bk-head'); await sleep(300);
  s = await state(c);
  ok('veda: healthy too (same device backup)', s.state === 'ok' && s.stats === 6 && s.spill <= 0, JSON.stringify(s));
  await shot(c, `settings-backup-veda-${w}-ok`);
  await evalJs(c, "document.querySelector('.thset-close').click(); 1");
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
  await run(c, 390, 844, true);
  await run(c, 1280, 900, false);
  const mine = errs.filter((e) => /thset|bkAgo|refreshBackup|summary|announce/.test(e));
  ok('no page errors from this code', !mine.length, mine.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
