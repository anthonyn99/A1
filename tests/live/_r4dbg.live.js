'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');
(async () => {
  const api = quantApi(); const c = await connect({ mock: api.mock });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  const { js, until, size, boot, tab } = driver(c);
  const CH = `document.querySelector('[data-charts]').__charts.active()`;
  const r = () => js(`var b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(), t=document.querySelector('[data-ch-tools]').getBoundingClientRect(); return JSON.stringify({t:b.top,h:b.height,tb:t.height, rows:[...document.querySelectorAll('[data-ch-tools] .ch-tools-row')].map(function(x){return x.offsetParent?Math.round(x.getBoundingClientRect().height):0;})});`);
  await size(1504, 900); await boot({ quant: true }); await tab('charts');
  await until(`${CH} && ${CH}.info().bars > 0`, 20000);
  for (let i = 0; i < 6; i++) { console.log('settle', i, await r()); await sleep(500); }
  await js(`document.querySelector('[data-ch-drawbtn]').click(); 1`);
  for (let i = 0; i < 4; i++) { console.log('drawrow', i, await r()); await sleep(300); }
  await js(`document.querySelector('[data-ch-tool="ray"]').click(); 1`);
  for (let i = 0; i < 4; i++) { console.log('pick', i, await r()); await sleep(300); }
  process.exit(0);
})();
