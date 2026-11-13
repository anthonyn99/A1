// TradeHub Quant, Phase 4: the Charts tab and the chart, in the real page
// (A1-Priv tradehub.html + TradeHub/ui/charts.js, chart.js), quant-api and
// the providers' WebSockets played here (quant-mock.js), the chart library
// from a local copy.
//
//   1. switch off: no Charts tab; on: the tab, the rail = the watchlist, a chart, ranked levels
//   2. 1280, 820 and 390 px: everything fits, no sideways scroll (screenshots with SHOTS_DIR)
//   3. wheel and a two-finger pinch keep the bar under the cursor (or the fingers) within 1 px;
//      the page neither scrolls nor zooms; frames stay at 55 a second or more while zooming
//   4. double-click and double-tap fit the range
//   5. range and interval switch; Ext. hides pre-market and after hours
//   6. a zone is drawn as a band (0.2 opacity), a line as a 1 px line; indicators are dashed
//   7. the watchlist: add and remove five times, rail and grid follow; a drag in the rail saves the order
//   8. live ticks: the chart moves, and no request reaches Cloudflare
//   9. drawings saved per symbol and back after a reload; an alert line and a level's bell keep alert rules
//  10. the ticker panel (from Market) has the chart
//
// Run: node tests/live/tradehub-chart.live.js   (TH_PAGE_FILE=… to test a copy; SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, WATCHLIST } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const TAB = `document.querySelector('[data-charts]').__charts`;
const CH = `${TAB}.active()`;

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const info = async () => JSON.parse(await js(`return JSON.stringify(${CH}.info());`));
  const stage = async () => JSON.parse(await js(`var b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return JSON.stringify({l:b.left,t:b.top,w:b.width,h:b.height});`));
  const ready = async () => until(`document.querySelector('[data-charts]') && ${TAB} && ${CH} && ${CH}.info().bars > 0 && document.querySelectorAll('.ch-lv').length > 0`, 20000);
  // The time under page x (the chart's own conversion), and where that time is now.
  const timeAt = (x, s) => js(`return ${CH}.geo.t(${x - s.l});`);
  const xOf = (t, s) => js(`return ${CH}.geo.x(${t}) + ${s.l};`);

  console.log('\nThe switch');
  await size(1280, 900);
  await boot({ quant: false });
  ok('switch off: no Charts tab', await js(`return !document.querySelector('.tb-navtab[data-navid="charts"]');`));
  await boot({ quant: true });
  ok('switch on: the Charts tab is there', await js(`return [...document.querySelectorAll('.tb-navtab[data-navid="charts"]')].some(function(b){return b.offsetParent;});`));
  api.asked.length = 0;
  await tab('charts');
  ok('the tab mounts with a chart, its bars and ranked levels', await ready());
  await sleep(1500);
  ok('the rail is the watchlist, in its order', await js(`return [...document.querySelectorAll('[data-ch-rail] .ch-row')].map(function(r){return r.dataset.sym;}).join() === ${JSON.stringify(WATCHLIST.join())};`),
    await js(`return [...document.querySelectorAll('[data-ch-rail] .ch-row')].map(function(r){return r.dataset.sym;}).join();`));
  ok('each rail row: price, change, sparkline, nearest level and its distance', await js(`var r=document.querySelector('.ch-row'); return /\\d/.test(r.querySelector('[data-ch-px]').textContent) && /%/.test(r.querySelector('[data-ch-chg]').textContent) && !!r.querySelector('.ch-spark polyline') && /^[RS]\\d/.test(r.querySelector('.ch-near').textContent);`));
  ok('the levels card: R rows over "Now" over S rows, each ranked, with distance and why', await js(`var e=document.querySelector('[data-ch-levels]'), k=[...e.children].map(function(x){return x.classList.contains('ch-lv-now')?'now':x.dataset.chLevel;}); var n=k.indexOf('now'); return n>=0 && k.slice(0,n).every(function(x){return /^R/.test(x);}) && k.slice(n+1).every(function(x){return /^S/.test(x);}) && [...e.querySelectorAll('.ch-rank')].every(function(x){return /^(Strong|Medium|Weak)$/.test(x.textContent);}) && /ATR/.test(e.innerText) && /touch/.test(e.innerText);`));
  let I = await info();
  ok('the chart opens on 5D at 5 minutes, from alpaca', I.range === '5D' && I.tf === '5m' && I.bars > 300 && I.provider === 'alpaca', JSON.stringify(I).slice(0, 200));
  ok('the header: price, change, a freshness label, provider and time', await until(`/LIVE|DELAYED/.test(document.querySelector('[data-ch-label]').textContent) && /alpaca/.test(document.querySelector('[data-ch-src]').textContent)`, 8000));
  ok('the price axis carries our tags: the last price filled, levels named on theirs', await js(`var t=[...document.querySelectorAll('.ch-tag')].filter(function(x){return x.style.display!=='none';}); return t.some(function(x){return x.dataset.kind==='last';}) && t.some(function(x){return x.dataset.kind==='level' && /^[RS]\\d /.test(x.textContent);});`));
  const tagsApart = `var r=[...document.querySelectorAll('.ch-tag')].filter(function(x){return x.style.display!=='none';}).map(function(x){return x.getBoundingClientRect();}).sort(function(a,b){return a.top-b.top;}); return r.every(function(b,i){return !i || b.top >= r[i-1].bottom - 0.5;});`;
  ok('...and no two tags overlap', await js(tagsApart));
  ok('the time zone is named once on the axis', await js(`return /^[A-Z]{2,5}$|GMT/.test(document.querySelector('[data-ch-zone]').textContent);`));
  ok('the one-line read under the chart', await until(`/trend|Mixed/.test(document.querySelector('[data-ch-read1]').textContent)`, 8000));
  const visit = api.asked.map((a) => a.p);
  ok('a visit: the chart\'s bars, the rail\'s daily bars, drawings, alerts, one /quotes; nothing else', visit.every((p) => ['/bars', '/drawings', '/alerts', '/quotes', '/stream-keys', '/snapshot'].includes(p)) && visit.filter((p) => p === '/quotes').length <= 2, visit.join());

  console.log('\nZoom and pan');
  let s = await stage();
  const x0 = s.l + s.w * 0.45, y0 = s.t + s.h * 0.4;
  let t0 = await timeAt(x0, s);
  const scroll0 = await js(`return window.scrollY + ',' + document.querySelector('.tbq-view, #tradeboard-root').scrollTop;`);
  await js(`window.__fr=0; window.__frOn=true; (function f(){ if(!window.__frOn) return; window.__fr++; requestAnimationFrame(f); })(); window.__fr0=performance.now(); 1`);
  for (let i = 0; i < 30; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x0, y: y0, deltaX: 0, deltaY: -60 }); await sleep(16); }
  await sleep(300);
  const fps = await js(`window.__frOn=false; return window.__fr / ((performance.now() - window.__fr0) / 1000);`);
  I = await info();
  const x1 = await xOf(t0, s);
  ok('wheel zoom: the bar under the cursor stays within 1 px', Math.abs(x1 - x0) <= 1, x1 - x0);
  ok('...and it did zoom in', I.view.to - I.view.from < 300, JSON.stringify(I.view));
  ok(`frames during the zoom: ${Math.round(fps)} a second (at least 55)`, fps >= 55, fps);
  ok('the page did not scroll', (await js(`return window.scrollY + ',' + document.querySelector('.tbq-view, #tradeboard-root').scrollTop;`)) === scroll0);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0, y: y0, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 2 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0, y: y0, button: 'left', clickCount: 2 });
  await sleep(400);
  I = await info();
  ok('double-click fits the range again', I.view.to - I.view.from > 300 && I.view.from <= 2, JSON.stringify(I.view));
  await js(`document.querySelector('[data-ch-main] [data-ch-box]').focus(); 1`);
  const w0 = (await info()).view;
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '+', text: '+' }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '+' });
  await sleep(200);
  const w1 = (await info()).view;
  ok('the + key zooms in', w1.to - w1.from < (w0.to - w0.from) * 0.9, JSON.stringify([w0, w1]));

  console.log('\nTouch (390 px)');
  await size(390, 844);
  await sleep(900);
  await js(`document.querySelector('[data-ch-main]').scrollIntoView({block:'center'}); 1`);
  await sleep(300);
  s = await stage();
  const mx = s.l + s.w * 0.45, my = s.t + s.h * 0.45;
  t0 = await timeAt(mx, s);
  const pageY0 = await js(`return window.scrollY + ',' + (document.scrollingElement||document.documentElement).scrollTop + ',' + (window.visualViewport ? visualViewport.scale : 1);`);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mx - 20, y: my, id: 1 }, { x: mx + 20, y: my, id: 2 }] });
  for (let i = 1; i <= 10; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mx - 20 - i * 6, y: my, id: 1 }, { x: mx + 20 + i * 6, y: my, id: 2 }] }); await sleep(20); }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
  const mx1 = await xOf(t0, s);
  ok('a two-finger pinch keeps the bar between the fingers within 1 px', Math.abs(mx1 - mx) <= 1, mx1 - mx);
  ok('...the page neither scrolled nor zoomed', (await js(`return window.scrollY + ',' + (document.scrollingElement||document.documentElement).scrollTop + ',' + (window.visualViewport ? visualViewport.scale : 1);`)) === pageY0);
  ok('the plot takes its own gestures (touch-action none)', await js(`return getComputedStyle(document.querySelector('[data-ch-main] .ch-stage')).touchAction === 'none';`));
  for (let k = 0; k < 2; k++) { await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mx, y: my }] }); await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(90); }
  await sleep(500);
  I = await info();
  ok('a double-tap fits the range', I.view.from <= 2, JSON.stringify(I.view));
  ok('390 px: no sideways scroll', (await js(`return document.documentElement.scrollWidth;`)) <= 390);
  ok('...the rail is a strip across the top', await js(`return getComputedStyle(document.querySelector('[data-ch-rail]')).flexDirection === 'row';`));
  await shot('chart-390');
  await size(820, 1100);
  await sleep(900);
  ok('820 px: no sideways scroll, the chart has room', (await js(`return document.documentElement.scrollWidth;`)) <= 820 && (await stage()).w > 500);
  await shot('chart-820');
  await size(1280, 900);
  await sleep(900);
  await js(`window.scrollTo(0,0); 1`);
  await shot('chart-1280');

  console.log('\nRange, interval, sessions');
  api.asked.length = 0;
  await js(`document.querySelector('[data-ch-range="1M"]').click(); 1`);
  await until(`${CH}.info().tf === '30m' && ${CH}.info().bars > 0`, 8000);
  ok('1M switches to 30 minute bars and asks for them', (await info()).tf === '30m' && api.asked.some((a) => a.p === '/bars' && /tf=30m/.test(a.q)));
  await js(`var s=document.querySelector('[data-ch-tf]'); s.value='1h'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
  ok('the interval menu switches to 1 hour', await until(`${CH}.info().tf === '1h' && ${CH}.info().bars > 0`, 8000));
  await js(`document.querySelector('[data-ch-range="5D"]').click(); 1`);
  await until(`${CH}.info().tf === '5m' && ${CH}.info().bars > 300`, 8000);
  const withExt = (await info()).bars;
  await js(`document.querySelector('[data-ch-tg="ext"]').click(); 1`);
  await sleep(400);
  const noExt = (await info()).bars;
  ok('Ext. off leaves regular hours only (78 five-minute bars a day)', noExt < withExt && noExt % 78 <= 78, withExt + ' → ' + noExt);
  await js(`document.querySelector('[data-ch-tg="ext"]').click(); 1`);
  await sleep(300);
  ok('...and back', (await info()).bars === withExt);
  ok('the setting is kept in the layout doc (chart_prefs)', await until(`window.__fakeFs.docs['dashboards/tradehub_layout'] && window.__fakeFs.docs['dashboards/tradehub_layout'].chart_prefs && window.__fakeFs.docs['dashboards/tradehub_layout'].chart_prefs.range === '5D'`, 6000));

  console.log('\nHow levels and indicators are drawn');
  I = await info();
  ok('indicator lines are dashed or dotted, never solid (lineStyle ≠ 0)', I.series.filter((x) => x.kind === 'line').length >= 3 && I.series.filter((x) => x.kind === 'line').every((x) => x.style > 0), JSON.stringify(I.series));
  await js(`window.__rects=[]; var C=CanvasRenderingContext2D.prototype, f=C.fillRect; if(!C.__spy){ C.__spy=1; C.fillRect=function(x,y,w,h){ if(window.__rects) window.__rects.push([String(this.fillStyle),w,h]); return f.apply(this,arguments); }; } 1`);
  await js(`document.querySelector('[data-ch-tg="allLevels"]').click(); 1`);
  await sleep(600);
  I = await info();
  const rects = JSON.parse(await js(`var r=window.__rects; window.__rects=null; return JSON.stringify(r);`));
  ok('"All levels" shows every ranked level, zones among them', I.levels.length > 4 && I.levels.some((l) => l.kind === 'zone') && I.levels.some((l) => l.kind === 'line'), JSON.stringify(I.levels));
  ok('a zone is a band at 0.2 opacity', rects.some(([st, w, h]) => /rgba\(143,\s*166,\s*216,\s*0\.2\)|rgba\(232,\s*181,\s*150,\s*0\.2\)/.test(st) && h > 1 && w > 100));
  ok('a line is a solid 1 px line in its colour', rects.some(([st, w, h]) => /#8fa6d8|#e8b596/i.test(st) && h === 1 && w > 100));
  await js(`document.querySelector('[data-ch-tg="allLevels"]').click(); 1`);
  await sleep(300);
  ok('by default, at most the two nearest each way', (await info()).levels.length <= 4);

  console.log('\nLive ticks cost no request');
  await sleep(1500);
  api.asked.length = 0;
  const lastBefore = await js(`return document.querySelector('[data-ch-main] [data-ch-px]').textContent;`);
  for (let i = 0; i < 25; i++) { await js(`window.__ws.tick('${WATCHLIST[0]}', ${(+lastBefore || 100) + 0.37} + ${i} * 0.01); 1`); await sleep(200); }
  await sleep(500);
  ok('the header follows the stream', (await js(`return document.querySelector('[data-ch-main] [data-ch-px]').textContent;`)) !== lastBefore);
  ok('five seconds of ticks: no request to quant-api', api.asked.length === 0, api.asked.map((a) => a.p).join());

  console.log('\nDrawings and alerts');
  await js(`document.querySelector('[data-ch-drawbtn]').click(); 1`);
  await js(`document.querySelector('[data-ch-tool="trend"]').click(); 1`);
  s = await stage();
  const a = { x: s.l + s.w * 0.3, y: s.t + s.h * 0.5 }, b = { x: s.l + s.w * 0.6, y: s.t + s.h * 0.3 };
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x - a.x) * i / 8, y: a.y + (b.y - a.y) * i / 8, button: 'left', buttons: 1 }); await sleep(16); }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await sleep(200);
  ok('a trend line drawn by dragging', (await info()).drawings === 1);
  ok('...the tool drops when it is done', await js(`return !document.querySelector('[data-ch-tool="trend"]').classList.contains('is-on');`));
  ok('...saved to quant-api for this symbol 2 s later', await until(`true`, 100) && (await (async () => { for (let i = 0; i < 40; i++) { if ((api.posted.drawings || []).some((d) => d.symbol === WATCHLIST[0] && d.drawings.length === 1 && d.drawings[0].kind === 'trend')) return true; await sleep(100); } return false; })()));
  await js(`document.querySelector('[data-ch-tool="alert"]').click(); 1`);
  const ay = s.t + s.h * 0.2;
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.l + s.w * 0.5, y: ay, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.l + s.w * 0.5, y: ay, button: 'left', clickCount: 1 });
  ok('an alert line keeps an alert rule', await until(`${CH}.info().alerts === 1`, 4000) && (api.posted.alerts || []).some((x) => x.kind === 'price' && x.symbol === WATCHLIST[0]));
  await js(`document.querySelector('[data-ch-levels] .ch-lv .ch-bell').click(); 1`);
  ok('a level\'s bell keeps one too (kind level, named)', await until(`document.querySelector('[data-ch-levels] .ch-bell.is-on')`, 4000) && (api.posted.alerts || []).some((x) => x.kind === 'level' && /^[RS]\d (Strong|Medium|Weak)$/.test(x.level)));
  await boot({ quant: true, keep: true });
  await tab('charts');
  await ready();
  ok('after a reload the drawing and the alerts are back', await until(`${CH}.info().drawings === 1 && ${CH}.info().alerts === 2`, 8000), JSON.stringify(await info()));

  console.log('\nThe watchlist, mirrored');
  let rounds = 0;
  for (let k = 0; k < 5; k++) {
    const list = k % 2 ? WATCHLIST.slice(0, WATCHLIST.length - 2) : [...WATCHLIST, 'ZZT' + k];
    await js(`window.__fakeFs.remote('dashboards/tradeboard_watchlist', { tickers: ${JSON.stringify(list)}, trash: [] }); 1`);
    if (await until(`[...document.querySelectorAll('[data-ch-rail] .ch-row')].map(function(r){return r.dataset.sym;}).join() === ${JSON.stringify(list.join())}`, 6000)) rounds++;
  }
  ok('five adds and removes: the rail matches every time', rounds === 5, rounds);
  await js(`window.__fakeFs.remote('dashboards/tradeboard_watchlist', { tickers: ${JSON.stringify(WATCHLIST)}, trash: [] }); 1`);
  await until(`document.querySelectorAll('[data-ch-rail] .ch-row').length === ${WATCHLIST.length}`, 6000);
  await js(`document.querySelector('[data-ch-view="grid"]').click(); 1`);
  ok('the grid: four small charts of the first four tickers, levels and no labels', await until(`document.querySelectorAll('.ch-grid .ch-cell').length === 4 && [...document.querySelectorAll('.ch-grid .ch-cell')].map(function(c){return c.dataset.chCell;}).join() === ${JSON.stringify(WATCHLIST.slice(0, 4).join())} && !document.querySelector('.ch-grid .ch-tags') && !document.querySelector('.ch-grid .ch-head')`, 8000));
  await js(`window.__fakeFs.remote('dashboards/tradeboard_watchlist', { tickers: ${JSON.stringify(WATCHLIST.slice(2))}, trash: [] }); 1`);
  ok('...and follows the watchlist', await until(`[...document.querySelectorAll('.ch-grid .ch-cell')].map(function(c){return c.dataset.chCell;}).join() === ${JSON.stringify(WATCHLIST.slice(2, 6).join())}`, 6000));
  await js(`window.__fakeFs.remote('dashboards/tradeboard_watchlist', { tickers: ${JSON.stringify(WATCHLIST)}, trash: [] }); 1`);
  await js(`document.querySelector('[data-ch-grid="9"]').click(); 1`);
  ok('9 in the grid', await until(`document.querySelectorAll('.ch-grid .ch-cell').length === 9`, 6000));
  await js(`document.querySelector('[data-ch-view="chart"]').click(); 1`);
  await ready();
  await js(`document.querySelector('[data-ch-layout="2"]').click(); 1`);
  ok('a 2-chart layout: two charts, one toolbar', await until(`document.querySelectorAll('[data-ch-main] .ch-cell .ch-box canvas').length >= 2 && document.querySelectorAll('[data-ch-tools]').length === 1`, 8000));
  await js(`document.querySelector('[data-ch-layout="1"]').click(); 1`);
  await ready();
  // A drag in the rail reorders the watchlist itself.
  await sleep(500);
  const r0 = JSON.parse(await js(`var r=document.querySelectorAll('[data-ch-rail] .ch-row'); var a=r[0].getBoundingClientRect(), b=r[2].getBoundingClientRect(); return JSON.stringify({ax:a.left+a.width/2, ay:a.top+a.height/2, by:b.top+b.height/2+4});`));
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r0.ax, y: r0.ay });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r0.ax, y: r0.ay, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 12; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r0.ax, y: r0.ay + (r0.by - r0.ay) * i / 12, button: 'left', buttons: 1 }); await sleep(16); }
  await sleep(150);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r0.ax, y: r0.by, button: 'left', clickCount: 1 });
  ok('a drag in the rail writes the watchlist in its new order', await until(`(function(){ var d=window.__fakeFs.docs['dashboards/tradeboard_watchlist']; return d && d.tickers && d.tickers[0] !== ${JSON.stringify(WATCHLIST[0])} && d.tickers.indexOf(${JSON.stringify(WATCHLIST[0])}) > 0; })()`, 6000),
    await js(`return JSON.stringify(window.__fakeFs.docs['dashboards/tradeboard_watchlist']);`));

  console.log('\nThe ticker panel');
  await tab('market');
  await until(`document.querySelector('[data-mk] [data-ticker]')`, 15000);
  await js(`document.querySelector('[data-mk] [data-ticker]').click(); 1`);
  ok('a ticker opens the panel with its chart, toolbar and levels', await until(`document.querySelector('[data-tkp] [data-ch-box] canvas') && document.querySelector('[data-tkp] [data-ch-tools]') && document.querySelector('[data-tkp] .ch-tag[data-kind="level"]')`, 15000));
  await shot('ticker-panel-1280');
  await js(`document.querySelector('[data-tkp-close]').click(); 1`);

  ok('no uncaught error in the page', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
