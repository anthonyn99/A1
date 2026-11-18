'use strict';
// Scratch debug for R1 (deleted after use).
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');
(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && /error|warn/.test(m.params.type)) console.log('console.' + m.params.type, m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300));
    if (m.method === 'Runtime.exceptionThrown') console.log('EXC', m.params.exceptionDetails.exception?.description);
  });
  const { js, until, size, boot, tab } = driver(c);
  await size(390, 844);
  await boot({ quant: true });
  await tab('market');
  await until(`document.querySelector('[data-mk-analogs]')`, 15000); await sleep(600);
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const centre = (sel) => js(`var b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2});`).then(JSON.parse);
  const a = await centre('.lay-card[data-card="regime"] .lay-title'), b = await centre('.lay-card[data-card="breadth"] .lay-title');
  console.log('a', a, 'b', b, await js(`var e=document.elementFromPoint(${a.x},${a.y}); return e.className + ' / ' + matchMedia('(pointer: coarse)').matches;`));
  await js(`window.__ev=[]; ['pointerdown','pointermove','pointerup','pointercancel'].forEach(function(t){ document.addEventListener(t,function(e){ if(window.__ev.length<12 || t!=='pointermove') window.__ev.push(t+':'+e.pointerType+':'+(e.target.className||e.target.tagName)); },true); }); 1`);
  const to = { x: a.x, y: b.y + (b.y - a.y) * 0.25 + 40 };
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
  await sleep(420);
  for (let i = 1; i <= 12; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x, y: a.y + (to.y - a.y) * i / 12 }] }); await sleep(16); }
  await sleep(120);
  console.log('mid', await js(`return JSON.stringify([...document.querySelectorAll('.lay-card')].map(function(e){return e.dataset.card+':'+e.className.replace('lay-card tb-card','')+':'+e.style.top;}));`));
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(600);
  console.log('events', await js(`return JSON.stringify(window.__ev.slice(0,30));`));
  console.log('order', await js(`return [...document.querySelectorAll('.lay-grid > .lay-card')].map(function(e){return e.dataset.card;}).join();`));
  c.ws.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
