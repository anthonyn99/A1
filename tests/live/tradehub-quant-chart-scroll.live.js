// Tony 2026-11-20: dragging the chart back in time froze at the left edge until he paused, then jumped
// (older history waited for 350 ms with no button down before it merged). Thirty quick back-drags must
// never sit at the edge, nothing may stall a frame past 100 ms, and no page error.
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-chart-scroll.live.js
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');
const CH="document.querySelector('[data-charts]').__charts.active()";
(async()=>{ const api=quantApi(); const c=await connect({mock:api.mock}); const errs=[];
 await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Page.addScriptToEvaluateOnNewDocument',{source:PAGE_SETUP});
 c.ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='warning')errs.push(JSON.stringify(m.params.args.map(a=>a.value||a.description)).slice(0,300)); if(m.method==='Runtime.exceptionThrown')errs.push(m.params.exceptionDetails.exception?.description?.slice(0,200));});
 const {js,until,size,boot,tab}=driver(c); await size(1280,900); await boot({quant:true}); await tab('charts');
 await until(`${CH} && ${CH}.info().bars>0`,20000); await sleep(1000);
 await js(`${CH}.set({range:'1D', tf:'5m', indicators:[{type:'ema',n:200}]});1`); await sleep(2500);
 const box=JSON.parse(await js(`var b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return JSON.stringify({l:b.left,t:b.top,w:b.width,h:b.height});`));
 await js(`window.__gap=0; var last=performance.now(); (function f(){ var n=performance.now(); window.__gap=Math.max(window.__gap,n-last); last=n; requestAnimationFrame(f); })(); 1`);
 let stuck=0;
 for(let k=0;k<30;k++){ const v0=JSON.parse(await js(`return JSON.stringify(${CH}.info().view);`)); const y=box.t+box.h*0.4, x0=box.l+box.w*0.2, dx=box.w*0.5;
   await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x0,y}); await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:x0,y,button:'left',buttons:1,clickCount:1});
   for(let i=1;i<=10;i++){ await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x0+dx*i/10,y,button:'left',buttons:1}); await sleep(16);} await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x0+dx,y,button:'left',buttons:0,clickCount:1});
   await sleep(250); const v1=JSON.parse(await js(`return JSON.stringify(${CH}.info().view);`)); if(v0.from<2 && v1.from<2) stuck++; }
 const res = { bars: await js(`return ${CH}.info().bars;`), gap: Math.round(await js(`return window.__gap;`)), stuck };
 let fail = 0; const ok = (n, c, x) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  -> ' + x)); if (!c) fail++; };
 ok('thirty quick back-drags never sit at the left edge (older history merges as each drag ends)', stuck === 0, JSON.stringify(res));
 ok('...older history did load', res.bars > 1200, res.bars);
 ok('...no frame stalls past 100 ms', res.gap <= 100, res.gap);
 ok('no page errors', !errs.filter((e) => !/Babel/.test(e)).length, errs.join(' | '));
 process.exit(fail ? 1 : 0);})();
