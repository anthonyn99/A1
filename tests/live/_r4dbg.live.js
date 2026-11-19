'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');
(async () => {
  const api = quantApi(); const c = await connect({ mock: api.mock });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  const { js, until, size, boot, tab } = driver(c);
  const CH = `document.querySelector('[data-charts]').__charts.active()`;
  const r = () => js(`var b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return JSON.stringify({t:b.top,h:b.height,ph:${CH}.geo.height(), p:${CH}.geo.p(100), rows:[...document.querySelectorAll('[data-ch-tools] .ch-tools-row')].map(function(x){return x.offsetParent?Math.round(x.getBoundingClientRect().height):0;}), pill:(document.querySelector('[data-ch-sync]')||{}).textContent});`);
  await size(1504, 900); await boot({ quant: true }); await tab('charts');
  await until(`${CH} && ${CH}.info().bars > 0`, 20000);
  await sleep(3000);
  await js(`document.querySelector('[data-ch-drawbtn]').click(); 1`);
  await sleep(1500);
  console.log('before', await r());
  await js(`document.querySelector('[data-ch-tool="ray"]').click(); 1`);
  const b = JSON.parse(await js(`var b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return JSON.stringify({l:b.left,t:b.top,w:${CH}.geo.width(),h:${CH}.geo.height()});`));
  const a = { x: b.l + b.w * 0.25, y: b.t + b.h * 0.3 }, z = { x: b.l + b.w * 0.45, y: b.t + b.h * 0.45 };
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
  console.log('pressed', await r());
  for (let i = 1; i <= 8; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (z.x - a.x) * i / 8, y: a.y + (z.y - a.y) * i / 8, button: 'left', buttons: 1 }); await sleep(14); }
  console.log('moved', await r());
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: z.x, y: z.y, button: 'left', clickCount: 1 });
  for (let i = 0; i < 6; i++) { console.log('after', i, await r()); await sleep(300); }
  process.exit(0);
})();
