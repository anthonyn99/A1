'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, WATCHLIST } = require('./quant-mock.js');
(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (m.method === 'Runtime.consoleAPICalled' && /warn|error/.test(m.params.type)) errs.push('console: ' + m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 200)); });
  const { js, until, size, boot, tab } = driver(c);
  await size(1280, 900);
  await boot({ quant: true, docs: { 'dashboards/tradeboard_watchlist': { tickers: WATCHLIST, trash: [], wl2: { follow: ['tradehub'], matchedOnce: 'test', selected: 'tradehub' } } } });
  await tab('charts');
  await until(`document.querySelectorAll('[data-ch-rail] .ch-row').length > 3`, 15000);
  await sleep(800);
  const st = await js(`var l=document.querySelector('[data-ch-rail]'); var r=document.querySelectorAll('[data-ch-rail] .ch-row'); var a=r[0].getBoundingClientRect(), b=r[2].getBoundingClientRect(); var hit=document.elementFromPoint(a.left+a.width/2,a.top+a.height/2); return JSON.stringify({drag:!!l._a1drag, axis:l._a1drag&&l._a1drag.o.axis, a:[a.left+a.width/2,a.top+a.height/2], b:[b.left+b.width/2,b.top+b.height/2], hit: hit && (hit.className||hit.tagName), hitInRow: !!(hit && hit.closest('.ch-row')), rows:[...r].slice(0,4).map(function(e){return e.dataset.sym;})});`);
  console.log(st);
  const S = JSON.parse(st);
  const mv = (type, x, y, buttons) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  await mv('mouseMoved', S.a[0], S.a[1], 0); await mv('mousePressed', S.a[0], S.a[1], 1);
  for (let i = 1; i <= 12; i++) { await mv('mouseMoved', S.a[0], S.a[1] + (S.b[1] + 10 - S.a[1]) * i / 12, 1); await sleep(30); }
  console.log('mid', await js(`return JSON.stringify({dragging: !!document.querySelector('.a1drag-ghost,.a1-drag-ghost,[data-a1drag-ghost],.is-dragging'), cls: document.documentElement.className});`));
  await mv('mouseReleased', S.b[0], S.b[1] + 10, 0);
  await sleep(1200);
  console.log('after', await js(`return [...document.querySelectorAll('[data-ch-rail] .ch-row')].slice(0,4).map(function(e){return e.dataset.sym;}).join();`));
  console.log('errs', errs.slice(0, 6).join(' | '));
  c.ws.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
