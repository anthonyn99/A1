'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');
(async () => {
  const api = quantApi();
  api.state.tradeboard = (req) => (new URL(req.url).pathname === '/api/portfolio/watchlists' ? { json: { ok: true, lists: [{ id: 11, name: 'Main', tickers: [{ symbol: 'NVDA' }, { symbol: 'SNDK' }, { symbol: 'AMD' }] }], asOf: Date.now() } } : null);
  const c = await connect({ mock: api.mock });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  const { js, until, size, boot, tab } = driver(c);
  await size(1280, 900); await boot({ quant: true }); await tab('charts');
  await until(`document.querySelectorAll('[data-ch-rail] .ch-row').length===3`, 15000); await sleep(2500);
  await js(`document.querySelector('.lay-card[data-card="rail"]').scrollIntoView({block:'center'}); 1`); await sleep(300);
  const r = JSON.parse(await js(`var r=document.querySelectorAll('[data-ch-rail] .ch-row'); var a=r[0].getBoundingClientRect(), b=r[2].getBoundingClientRect(); var el=document.elementFromPoint(a.left+a.width/2,a.top+a.height/2); return JSON.stringify({ax:a.left+a.width/2, ay:a.top+a.height/2, by:b.top+b.height/2+4, hit: el && (el.className||el.tagName), drag: !!document.querySelector('[data-ch-rail]')._a1drag, axis: (document.querySelector('[data-ch-rail]')._a1drag||{o:{}}).o.axis});`));
  console.log(JSON.stringify(r));
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.ax, y: r.ay });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.ax, y: r.ay, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 12; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.ax, y: r.ay + (r.by - r.ay) * i / 12, button: 'left', buttons: 1 }); await sleep(16); }
  console.log('mid', await js(`return JSON.stringify({on: document.querySelector('[data-ch-rail]').classList.contains('dsort-on'), grab: document.documentElement.classList.contains('dsort-grabbing')});`));
  await sleep(150);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.ax, y: r.by, button: 'left', clickCount: 1 });
  await sleep(100);
  console.log('after100', await js(`return [...document.querySelectorAll('[data-ch-rail] .ch-row')].map(function(e){return e.dataset.sym;}).join();`));
  await sleep(1200);
  console.log('after1300', await js(`return [...document.querySelectorAll('[data-ch-rail] .ch-row')].map(function(e){return e.dataset.sym;}).join() + ' wl2=' + JSON.stringify((window.__fakeFs.docs['dashboards/tradeboard_watchlist']||{}).wl2||null);`));
  c.ws.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
