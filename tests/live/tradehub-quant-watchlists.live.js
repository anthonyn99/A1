// TradeHub Quant refinements, R2 (A1-Priv docs/TradeHub/quant/r1-02.md): the
// watchlists in the real page, at 1280, 820 and 390 px.
//
//   1. Charts' Watchlist card switches lists (Webull's Main by default), and
//      a drag in its rail KEEPS its new order (the snap-back, ask 5) and saves
//      it: the TradeHub list in `tickers`, a Webull list as wl2.order
//   2. crypto shows a quiet "no data" row that never breaks the rail
//   3. Control ▸ Watchlists: Webull lists locked (no add, no remove), empty
//      ones hidden until asked; New list, add, rename, delete to Trash and
//      restore; Match Webull's order; the sync pill
//   4. following Main changes the followed list (td6_followed, what News uses)
//   5. Webull failing never changes the followed list
//   6. another device's wl2 arrives through the listener
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-watchlists.live.js
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, WATCHLIST, CLOCK } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};

// Webull's lists as tradeboard-api returns them (R0's shape): SNDK has no fixture bars, BTCUSD is crypto.
// B2: these checks are R2's (the TradeHub list as Tony left it), so the one-time switch to Webull's Main
// (Refinements Batch 2) is marked done in the seeded doc; tradehub-quant-watchlists-b2 tests the switch.
const R2_DOC = () => ({ 'dashboards/tradeboard_watchlist': { tickers: WATCHLIST, trash: [], wl2: { follow: ['tradehub'], matchedOnce: 'test' } } });
const WB = [
  { id: 11, name: 'Main', sort: 9, tickers: [{ symbol: 'NVDA', exchange: 'NASDAQ' }, { symbol: 'SNDK', exchange: 'NASDAQ' }, { symbol: 'AMD', exchange: 'NASDAQ' }] },
  { id: 14, name: 'Trackers', sort: 8, tickers: ['VIX','DXY','SOXX'].map(symbol=>({symbol})) },
  { id: 12, name: 'My Positions', sort: 8, tickers: [] },
  { id: 13, name: 'Cryptos', sort: 7, tickers: [{ symbol: 'BTCUSD', exchange: 'CCC' }, { symbol: 'ETHUSD', exchange: 'CCC' }] },
];

(async () => {
  const api = quantApi();
  const yields = Array.from({length:60},(_,i)=>{
    const t=Date.UTC(2026,10,1+i-59,5), c=4+i/100;
    return {t,o:c,h:c,l:c,c,v:0,vx:'none'};
  }).filter(b=>b.t<CLOCK&&new Date(b.t).getUTCDay()%6!==0);
  api.state.realBars={US2Y:{'1d':yields},US10Y:{'1d':yields}};
  api.state.barsProviders={US2Y:'fred',US10Y:'fred'};
  let webullDown = false, webullCalls = 0;
  api.state.tradeboard = (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/api/portfolio/watchlists') { webullCalls++; return webullDown ? { status: 503, json: { ok: false, error: 'Webull 503' } } : { json: { ok: true, lists: WB, asOf: Date.now() } }; }
    return null;
  };
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Page.javascriptDialogOpening') c.send('Page.handleJavaScriptDialog', { accept: true });
  });
  const { js, until, size, boot, tab } = driver(c);
  const DOC = `(window.__fakeFs.docs['dashboards/tradeboard_watchlist']||{})`;
  const rail = () => js(`return [...document.querySelectorAll('[data-ch-rail] .ch-row')].map(function(e){return e.dataset.sym;}).join();`);
  // A pick redraws the rail at once and again when its bars and levels land: wait for both before a drag.
  const pickRail = async (id) => { await js(`var s=document.querySelector('[data-ch-list]'); s.value=${JSON.stringify(id)}; s.dispatchEvent(new Event('change',{bubbles:true})); 1`); await sleep(2000); };
  const box = (sel, i) => js(`var e=document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if(!e) return 'null'; var b=e.getBoundingClientRect(); return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2,w:b.width,h:b.height});`).then(JSON.parse);
  async function mouseDrag(from, to) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 16; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / 16, y: from.y + (to.y - from.y) * i / 16, button: 'left', buttons: 1 }); await sleep(18); }
    await sleep(120);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  }
  /** Drag rail row `from` past row `past` along the rail's axis (a column, or a sideways strip when the
   *  grid is tablet or phone sized), then wait out A1Drag's 600 ms timer. → the axis it used. */
  async function railDrag(from, past) {
    await js(`document.querySelector('.lay-card[data-card="rail"]').scrollIntoView({block:'center'}); document.querySelector('[data-ch-rail]').scrollTo(0,0); 1`); await sleep(200);
    const a = await box('[data-ch-rail] .ch-row', from), b = await box('[data-ch-rail] .ch-row', past);
    const axis = Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? 'x' : 'y';
    const dir = past > from ? 1 : -1;
    // Just past the target's centre: further, and a phone's strip auto-scrolls at the screen's edge.
    const to = axis === 'x' ? { x: b.x + dir * 10, y: a.y } : { x: a.x, y: b.y + dir * 10 };
    await mouseDrag(a, to);
    await sleep(1200);
    return axis;
  }
  /** The drag axis A1Drag was given matches the rail's layout (a strip drags sideways). */
  const axisRight = () => js(`var l=document.querySelector('[data-ch-rail]'); var row=getComputedStyle(l).flexDirection==='row'; return (l._a1drag.o.axis==='x')===row;`);
  const mgr = (sel) => `document.querySelector('[data-wlm] ${sel}')`;
  const pickMgr = async (id) => { await js(`var s=${mgr('[data-wlm-pick]')}; s.value=${JSON.stringify(id)}; s.dispatchEvent(new Event('change',{bubbles:true})); 1`); await sleep(300); };
  const tiles = () => js(`return [...document.querySelectorAll('[data-wlm] .ctl-tk')].map(function(e){return e.dataset.sym;}).join();`);
  const typeIn = (sel, v) => js(`var i=${mgr(sel)}; var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,${JSON.stringify(v)}); i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
  const press = (sel) => js(`var b=${mgr(sel)}; if(!b) return false; b.click(); return true;`);
  const followed = () => js(`return localStorage.getItem('td6_followed')||'';`);

  console.log('\n1280: Charts\' Watchlist card');
  await size(1280, 900);
  await boot({ quant: true, docs: R2_DOC() });
  await tab('charts');
  ok('the rail shows Webull\'s Main by default', await until(`[...document.querySelectorAll('[data-ch-rail] .ch-row')].map(function(e){return e.dataset.sym;}).join()==='NVDA,SNDK,AMD'`, 15000), await rail());
  ok('the picker lists Webull\'s lists and Mine (My Positions is empty: hidden)', await js(`var s=document.querySelector('[data-ch-list]'); var o=[...s.options].map(function(x){return x.textContent;}); return !s.hidden && o.some(function(t){return /^Main \\(3\\)/.test(t);}) && o.some(function(t){return /^Cryptos/.test(t);}) && o.some(function(t){return /^TradeHub/.test(t);}) && !o.some(function(t){return /My Positions/.test(t);});`));
  ok('Webull was read once for the visit', webullCalls === 1, webullCalls);
  await pickRail('wb:14');
  ok('Trackers retains all nine symbols in Webull app order', (await rail()) === 'US2Y,US10Y,CLMAIN,BZMAIN,VIX,DXY,SOXX,NQMAIN,HGMAIN', await rail());
  await js(`var c=document.querySelector('[data-charts]').__charts.active(); c.set({type:'candles',volume:true}); document.querySelector('[data-ch-rail] [data-sym="US2Y"]').click(); 1`);
  ok('Treasury yield opens a daily chart, with intraday choices disabled', await until(`document.querySelector('[data-charts]').__charts.active().get().symbol==='US2Y' && document.querySelector('[data-ch-tf]').value==='1d' && document.querySelector('[data-ch-tf] option[value="5m"]').disabled`));
  ok('yields default to a line with candle types unavailable', await until(`document.querySelector('[data-charts]').__charts.active().get().type==='line' && !document.querySelector('[data-charts]').__charts.active().get().volume && document.querySelector('[data-ch-type] option[value="candles"]').disabled`));
  await js(`document.querySelector('[data-ch-rail] [data-sym="US10Y"]').click(); 1`);
  ok('the second Treasury yield also uses a line', await until(`document.querySelector('[data-charts]').__charts.active().get().symbol==='US10Y' && document.querySelector('[data-charts]').__charts.active().get().type==='line'`));
  ok('published FRED yield history supplies the header if its quote is missing', await until(`document.querySelector('.ch-head [data-ch-src]').textContent.includes('daily observation') && document.querySelector('.ch-head [data-ch-label]').textContent==='HISTORICAL' && document.querySelector('[data-ch-read]').textContent.includes('Yield')`));
  await js(`document.querySelector('[data-ch-rail] [data-sym="VIX"]').click(); 1`);
  ok('switching away restores candles and volume', await until(`document.querySelector('[data-charts]').__charts.active().get().type==='candles' && document.querySelector('[data-charts]').__charts.active().get().volume && !document.querySelector('[data-ch-type] option[value="candles"]').disabled`));
  ok('VIX opens the index chart', await until(`document.querySelector('[data-charts]').__charts.active().get().symbol==='VIX'`));
  await pickRail('tradehub');
  ok('picking TradeHub shows the TradeHub list in its order', (await rail()) === WATCHLIST.join(), await rail());
  ok('...and the pick is saved (wl2.selected)', await until(`${DOC}.wl2 && ${DOC}.wl2.selected==='tradehub'`, 4000), await js(`return JSON.stringify(${DOC}.wl2||null);`));
  ok('the rail drags along its own axis (a column, or sideways as a strip)', await axisRight());
  await railDrag(0, 2);
  const want1 = [WATCHLIST[1], WATCHLIST[2], WATCHLIST[0], ...WATCHLIST.slice(3)].join();
  ok('a rail drag KEEPS its new order after the drop (no snap back, ask 5)', (await rail()) === want1, await rail());
  ok('...and the TradeHub list is saved in that order (tickers)', await until(`(${DOC}.tickers||[]).join()===${JSON.stringify(want1)}`, 4000), await js(`return (${DOC}.tickers||[]).join();`));
  await pickRail('wb:11');
  await railDrag(2, 0);
  ok('a Webull list reorders too (AMD to the top), and stays', (await rail()) === 'AMD,NVDA,SNDK', await rail());
  ok('...kept as TradeHub\'s order over it (wl2.order), Webull untouched', await until(`${DOC}.wl2 && JSON.stringify(${DOC}.wl2.order)===JSON.stringify([{id:'wb:11',syms:['AMD','NVDA','SNDK']}])`, 4000), await js(`return JSON.stringify((${DOC}.wl2||{}).order);`));
  await pickRail('wb:13');
  // Batch 2 B1 (Tony 2026-11-20): crypto has data now: full rows, and a click charts the coin.
  ok('Cryptos: full rows (B1: no more "no data")', await js(`var r=[...document.querySelectorAll('[data-ch-rail] .ch-row')]; return r.length===2 && r.every(function(e){return !e.classList.contains('is-nodata') && !/no data/.test(e.textContent);});`));
  const coin = await js(`return document.querySelectorAll('[data-ch-rail] .ch-row')[1].dataset.sym;`);
  await js(`document.querySelectorAll('[data-ch-rail] .ch-row')[1].click(); 1`); await sleep(400);
  ok('...a click on one charts that coin', (await js(`return document.querySelector('[data-charts]').__charts.active().get().symbol;`)) === coin, coin);

  console.log('\n1280: Control ▸ Watchlists');
  await tab('prompt');
  ok('the manager is there, the TradeHub list open, one tile per ticker in its order', await until(`document.querySelector('[data-wlm] .ctl-tk')`, 8000) && (await tiles()) === want1, await tiles());
  // Tony 2026-11-20: the refresh arrow broke up on lower-density screens; it draws thicker than the 1.5 icons
  // (2.5 on this 1x headless screen), on Control (ui/dom.js) and on Portfolio's React head alike.
  const arrowW = (sel) => js(`var p=document.querySelector(${JSON.stringify(sel + ' svg path')}); return p ? getComputedStyle(p).strokeWidth : 'none';`);
  ok('the refresh arrow is thicker (Control): 2.5px on a 1x screen', (await arrowW('[data-wlm] .tb-refresh')) === '2.5px', await arrowW('[data-wlm] .tb-refresh'));
  await tab('portfolio');
  await until(`document.querySelector('#tradeboard-root .tb-refresh-ic svg path')`, 8000);
  ok('…and on Portfolio\'s top-right refresh', (await arrowW('#tradeboard-root .tb-refresh-ic')) === '2.5px', await arrowW('#tradeboard-root .tb-refresh-ic'));
  await tab('prompt');
  await until(`document.querySelector('[data-wlm] .ctl-tk')`, 8000);
  {
    // A tile drag reorders the open list too (A1Drag's grid axis), and stays.
    const a = await box('[data-wlm] .ctl-tk', 0), b = await box('[data-wlm] .ctl-tk', 1);
    await mouseDrag(a, { x: b.x + 10, y: b.y }); await sleep(1200);
    const want2 = [want1.split(',')[1], want1.split(',')[0], ...want1.split(',').slice(2)].join();
    ok('a tile drag in the manager reorders the TradeHub list, and stays', (await tiles()) === want2, await tiles());
    ok('...saved in that order', await until(`(${DOC}.tickers||[]).join()===${JSON.stringify(want2)}`, 4000), await js(`return (${DOC}.tickers||[]).join();`));
    await mouseDrag(await box('[data-wlm] .ctl-tk', 0), (await box('[data-wlm] .ctl-tk', 1)) && { x: (await box('[data-wlm] .ctl-tk', 1)).x + 10, y: (await box('[data-wlm] .ctl-tk', 1)).y }); await sleep(1200);
    ok('...and back', (await tiles()) === want1, await tiles());
  }
  await pickMgr('wb:11');
  // "…never changed.null" (2026-11-20): replaceChildren(null) printed the missing button as "null".
  ok('a Webull list: the lock note (no stray "null"), no add row, no remove buttons', await js(`return !${mgr('[data-wlm-note]')}.hidden && /Read-only from Webull/.test(${mgr('[data-wlm-note]')}.textContent) && !/null/.test(${mgr('[data-wlm-note]')}.textContent) &&${mgr('[data-wlm-add]')}.hidden && !document.querySelector('[data-wlm] [data-wlm-remove]');`));
  ok('Rename and Delete are off for a Webull list', await js(`return ${mgr('[data-wlm-act="rename"]')}.disabled && ${mgr('[data-wlm-act="delete"]')}.disabled;`));
  ok('"Match Webull\'s order" shows (the list was reordered)', await js(`return !!${mgr('[data-wlm-match]')};`));
  await press('[data-wlm-match]'); await sleep(400);
  ok('...pressed: Webull\'s order back, the overlay gone from the doc', (await tiles()) === 'NVDA,SNDK,AMD' && await until(`JSON.stringify((${DOC}.wl2||{}).order)==='[]'`, 4000), await tiles());
  ok('empty Webull lists hidden...', await js(`return ![...${mgr('[data-wlm-pick]')}.options].some(function(o){return /My Positions/.test(o.textContent);});`));
  await js(`var b=${mgr('[data-wlm-show-empty]')}; b.click(); 1`); await sleep(300);
  ok('...until "Show empty Webull lists"', await js(`return [...${mgr('[data-wlm-pick]')}.options].some(function(o){return /My Positions/.test(o.textContent);});`));
  await js(`var b=${mgr('[data-wlm-show-empty]')}; b.click(); 1`); await sleep(200);
  await press('[data-wlm-act="new"]'); await sleep(150);
  await js(`var i=document.querySelector('[data-wlm] .wlm-name input'); var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,'Semis'); i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
  await press('[data-wlm-name-ok]'); await sleep(300);
  ok('New list: "Semis" made and opened, empty', await js(`return /^Semis/.test(${mgr('[data-wlm-pick]')}.selectedOptions[0].textContent) && !document.querySelector('[data-wlm] .ctl-tk');`));
  await typeIn('[data-wlm-add] input', 'mu, amd');
  await press('[data-wlm-add] .tb-btn-primary'); await sleep(300);
  ok('add two at once: MU, AMD', (await tiles()) === 'MU,AMD', await tiles());
  ok('...saved as a custom list in wl2.lists', await until(`(${DOC}.wl2||{}).lists && ${DOC}.wl2.lists.some(function(l){return l.name==='Semis' && l.tickers.join()==='MU,AMD';})`, 4000), await js(`return JSON.stringify((${DOC}.wl2||{}).lists);`));
  // B7 (ask 10): Watchlists report to TradeHub's ONE sync pill under the title.
  ok('the one sync pill says Synced', await until(`(function(){var p=[].slice.call(document.querySelectorAll('.a1-sync')).find(function(e){return e.offsetParent;}); return !!p && p.getAttribute('data-sync')==='ok';})()`, 5000));
  await js(`document.querySelector('[data-wlm] [data-wlm-remove="MU"]').click(); 1`); await sleep(300);
  ok('remove on a custom list', (await tiles()) === 'AMD');
  await press('[data-wlm-act="rename"]'); await sleep(150);
  await js(`var i=document.querySelector('[data-wlm] .wlm-name input'); var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,'Chips'); i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
  await press('[data-wlm-name-ok]'); await sleep(300);
  ok('Rename: Chips', await js(`return /^Chips/.test(${mgr('[data-wlm-pick]')}.selectedOptions[0].textContent);`));
  await press('[data-wlm-act="delete"]'); await sleep(400);
  ok('Delete: the list leaves, TradeHub opens, the list waits in wl2.listTrash', await js(`return ![...${mgr('[data-wlm-pick]')}.options].some(function(o){return /Chips/.test(o.textContent);}) && ${mgr('[data-wlm-pick]')}.value==='tradehub';`) && await until(`((${DOC}.wl2||{}).listTrash||[]).some(function(l){return l.name==='Chips';})`, 4000));
  await js(`[...document.querySelectorAll('button')].find(function(b){return /Trash/.test(b.textContent) && b.offsetParent;}).click(); 1`); await sleep(400);
  ok('Trash has a Lists section with Chips (1)', await js(`return /\\bLists\\b/i.test(document.body.innerText) && /Chips \\(1\\)/.test(document.body.innerText);`));
  await js(`var row=[...document.querySelectorAll('button')].filter(function(b){return b.textContent==='Restore';}).find(function(b){return /Chips/.test(b.parentNode.parentNode.textContent);}); row.click(); 1`); await sleep(500);
  ok('Restore: Chips is back with AMD', await js(`return [...${mgr('[data-wlm-pick]')}.options].some(function(o){return /^Chips \\(1\\)/.test(o.textContent);});`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`); await sleep(300);

  console.log('\n1280: the followed list (News, Catalysts, every Quant tab)');
  const f0 = await followed();
  ok('by default the TradeHub list only', f0 === JSON.stringify(want1.split(',')), f0);
  await js(`document.querySelector('[data-wlm] [data-wlm-follow-id="wb:11"]').click(); 1`); await sleep(600);
  const f1 = JSON.parse((await followed()) || '[]');
  ok('ticking Main adds its stocks (SNDK) after the TradeHub list', f1.join() === [...want1.split(','), 'SNDK'].join(), f1.join());
  ok('...saved as wl2.follow', await until(`JSON.stringify((${DOC}.wl2||{}).follow)==='["tradehub","wb:11"]'`, 4000));
  ok('the parser and the workers\' push use the followed list (TB_WL has SNDK)', await until(`tbGetWatchlist().indexOf('SNDK')>=0`, 4000), await js(`return tbGetWatchlist().join();`));
  await pickMgr('tradehub');
  await typeIn('[data-wlm-add] input', 'ZQX');
  await press('[data-wlm-add] .tb-btn-primary'); await sleep(900);
  ok('a TradeHub-list edit while following Main: the workers still get the followed list (ZQX added, SNDK kept)', await until(`tbGetWatchlist().indexOf('SNDK')>=0 && tbGetWatchlist().indexOf('ZQX')>=0`, 4000), await js(`return tbGetWatchlist().join();`));
  await js(`document.querySelector('[data-wlm] [data-wlm-remove="ZQX"]').click(); 1`); await sleep(600);
  ok('Cryptos is not offered to follow (no stocks in it: News and Quant use stocks only)', await js(`return !document.querySelector('[data-wlm] [data-wlm-follow-id="wb:13"]') && !!document.querySelector('[data-wlm] [data-wlm-follow-id="tradehub"]');`));

  console.log('\n1280: another device, and Webull down');
  await sleep(8500);   // the page skips its own echo for 8 s after a save (tradehub.html's watchlist listener)
  await js(`__fakeFs.remote('dashboards/tradeboard_watchlist', { wl2: { lists: [{ id: 'c:phone', name: 'From the phone', tickers: ['TSLA'] }], order: [], follow: ['tradehub', 'wb:11'], selected: 'wb:11', showEmpty: false, listTrash: [] }, savedAt: Date.now() + 60000 }, { merge: true }); 1`);
  ok('another device\'s new list arrives through the listener', await until(`[...document.querySelector('[data-wlm] [data-wlm-pick]').options].some(function(o){return /From the phone/.test(o.textContent);})`, 12000));
  webullDown = true;
  await js(`localStorage.removeItem('tb_wb_watchlists'); 1`);
  const fBefore = await followed();
  await boot({ quant: true, keep: true });
  await tab('prompt');
  await until(`document.querySelector('[data-wlm-meta]') && /could not be read/.test(document.querySelector('[data-wlm-meta]').textContent)`, 10000);
  ok('Webull down: the manager says so', await js(`return /could not be read/.test(document.querySelector('[data-wlm-meta]').textContent);`), await js(`return (document.querySelector('[data-wlm-meta]')||{}).textContent;`));
  ok('...and the followed list is unchanged (Main is followed but not loaded: the last good list is kept)', (await followed()) === fBefore, await followed());
  ok('...the followed-lists note says it is waiting', await js(`return /Waiting for Webull/.test(document.querySelector('[data-wlm-followed]').textContent);`));
  webullDown = false;
  await js(`localStorage.setItem('tradehub_quant','0'); 1`);   // keep: the saved followed copy (with SNDK) stays
  await boot({ quant: false, keep: true });
  await sleep(1500);
  ok('TradeHub Quant off: News and the workers use the TradeHub list (as before Phase 1), not the saved followed copy', await until(`tbGetWatchlist().indexOf('SNDK')<0 && tbGetWatchlist().length>0`, 6000) && /SNDK/.test(fBefore), await js(`return tbGetWatchlist().join();`));
  await tab('prompt');
  // Beacon's TradeHub/data/push.js loads on every open (alerts' devices, 2026-11-21); the shared date formatter also serves the legacy page.
  ok('...and Control has the old single-list editor, only shared page modules load', await until(`document.querySelector('.ctl-wl .ctl-tk')`, 8000) && await js(`return !document.querySelector('[data-wlm]') && !performance.getEntriesByType('resource').some(function(r){return /\\/TradeHub\\//.test(r.name) && r.name.indexOf('/TradeHub/data/push.js') < 0 && r.name.indexOf('/TradeHub/core/when.js') < 0;});`));

  for (const [w, hgt] of [[820, 1000], [390, 844]]) {
    console.log(`\n${w}: the rail and the manager`);
    await size(w, hgt);
    await boot({ quant: true, docs: R2_DOC() });
    await tab('charts');
    ok(`${w}: the rail shows Main`, await until(`[...document.querySelectorAll('[data-ch-rail] .ch-row')].map(function(e){return e.dataset.sym;}).join()==='NVDA,SNDK,AMD'`, 15000), await rail());
    ok(`${w}: the picker is on screen and inside the card`, await js(`var s=document.querySelector('[data-ch-list]'), c=s.closest('.lay-card'); var a=s.getBoundingClientRect(), b=c.getBoundingClientRect(); return !s.hidden && a.width>0 && a.left>=b.left-1 && a.right<=b.right+1;`));
    ok(`${w}: the strip drags sideways`, await axisRight());
    await railDrag(1, 0);   // leftward: the strip sits at its start, so it cannot auto-scroll under the pointer
    ok(`${w}: a drag in the strip keeps its new order`, (await rail()) === 'SNDK,NVDA,AMD', await rail());
    await tab('prompt');
    ok(`${w}: the manager fits (no sideways scroll)`, await until(`document.querySelector('[data-wlm] .ctl-tk')`, 8000) && await js(`return document.documentElement.scrollWidth<=window.innerWidth+1 && document.querySelector('[data-wlm]').getBoundingClientRect().right<=window.innerWidth+1;`), await js(`return document.documentElement.scrollWidth+' vs '+window.innerWidth;`));
  }

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
