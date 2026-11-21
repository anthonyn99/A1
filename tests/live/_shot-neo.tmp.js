'use strict';
const fs = require('fs'), path = require('path');
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');
const OUT = process.env.OUT;
(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  const { js, until, size, boot, tab } = driver(c);
  for (const [w, h] of [[1504, 900], [390, 844]]) {
    await size(w, h); await boot({ quant: true }); await tab('market'); await sleep(1200);
    await js(`var d=document.querySelector('[data-nq-dock]'); if(d.hidden) document.querySelector('[data-nq-launch]').click(); 1`);
    await until(`document.querySelector('[data-nq-dock] [data-nq-input]')`, 8000); await sleep(400);
    await js(`var i=document.querySelector('[data-nq-dock] [data-nq-input]'); var d=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value'); d.set.call(i,'Is NVDA a buy here?'); i.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-nq-dock] [data-nq-send]').click(); 1`);
    await until(`[...document.querySelectorAll('[data-nq-dock] [data-nq-a]')].some(function(e){return e.dataset.state==='done' || e.dataset.state==='failed';})`, 20000);
    await sleep(800);
    if (w < 800) { await js(`var b=document.querySelector('[data-nq-dock] [data-nq-side-btn]'); if(b && b.getAttribute('aria-expanded')==='false') b.click(); 1`); await sleep(300); }
    const s = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `neo-${w}.png`), Buffer.from(s.result.data, 'base64'));
  }
  c.ws.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
