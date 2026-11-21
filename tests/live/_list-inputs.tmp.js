'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');
(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  const { js, size, boot, tab } = driver(c);
  await size(1504, 900); await boot({ quant: true });
  for (const t of ['portfolio', 'journal', 'playbook', 'prompt', 'catalysts', 'news', 'analysis', 'market', 'charts', 'scanner', 'neo', 'paper']) {
    try { await tab(t); } catch (e) { console.log(t, 'no tab'); continue; }
    await sleep(1200);
    console.log(t, await js(`return JSON.stringify([...document.querySelectorAll('#tradeboard-root input, #tradeboard-root textarea')].filter(function(e){var r=e.getBoundingClientRect(); return r.width>0 && r.height>0;}).map(function(e){ return (e.tagName+'/'+(e.type||'')+(Object.keys(e).some(function(k){return k.indexOf('__react')===0;})?'/R':'')+' '+(e.className||'')+' '+(e.getAttribute('aria-label')||e.placeholder||'')).slice(0,80);}));`));
  }
  c.ws.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
