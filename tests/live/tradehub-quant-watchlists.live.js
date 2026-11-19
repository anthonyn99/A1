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
const { quantApi, driver, PAGE_SETUP, WATCHLIST } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};

// Webull's lists as tradeboard-api returns them (R0's shape): SNDK has no fixture bars, BTCUSD is crypto.
const WB = [
  { id: 11, name: 'Main', sort: 9, tickers: [{ symbol: 'NVDA', exchange: 'NASDAQ' }, { symbol: 'SNDK', exchange: 'NASDAQ' }, { symbol: 'AMD', exchange: 'NASDAQ' }] },
  { id: 12, name: 'My Positions', sort: 8, tickers: [] },
  { id: 13, name: 'Cryptos', sort: 7, tickers: [{ symbol: 'BTCUSD', exchange: 'CCC' }, { symbol: 'ETHUSD', exchange: 'CCC' }] },
];

(async () => {
  const api = quantApi();
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
  /** Drag rail row `from` past row `past` (along the rail's axis), wait out A1Drag's 600 ms timer. */
  async function railDrag(from, past, axis) {
    await js(`document.querySelector('.lay-card[data-card="rail"]').scrollIntoView({block:'start'}); document.querySelector('[data-ch-rail]').scrollTo(0,0); 1`); await sleep(200);
    const a = await box('[data-ch-rail] .ch-row', from), b = await box('[data-ch-rail] .ch-row', past);
    const to = axis === 'x' ? { x: b.x + b.w * 0.35, y: a.y } : { x: a.x, y: b.y + b.h * 0.35 };
    await mouseDrag(a, to);
    await sleep(1200);
  }
  const mgr = (sel) => `document.querySelector('[data-wlm] ${sel}')`;
  const pickMgr = async (id) => { await js(`var s=${mgr('[data-wlm-pick]')}; s.value=${JSON.stringify(id)}; s.dispatchEvent(new Event('change',{bubbles:true})); 1`); await sleep(300); };
  const tiles = () => js(`return [...document.querySelectorAll('[data-wlm] .ctl-tk')].map(function(e){return e.dataset.sym;}).join();`);
  const typeIn = (sel, v) => js(`var i=${mgr(sel)}; var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,${JSON.stringify(v)}); i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
  const press = (sel) => js(`var b=${mgr(sel)}; if(!b) return false; b.click(); return true;`);
  const followed = () => js(`return localStorage.getItem('td6_followed')||'';`);

  console.log('\n1280: Charts\' Watchlist card');
  await size(1280, 900);
  await boot({ quant: true });
  await tab('charts');
  ok('the rail shows Webull\'s Main by default', await until(`[...document.querySelectorAll('[data-ch-rail] .ch-row')].map(function(e){return e.dataset.sym;}).join()==='NVDA,SNDK,AMD'`, 15000), await rail());
  ok('the picker lists Webull\'s lists and Mine (My Positions is empty: hidden)', await js(`var s=document.querySelector('[data-ch-list]'); var o=[...s.options].map(function(x){return x.textContent;}); return !s.hidden && o.some(function(t){return /^Main \\(3\\)/.test(t);}) && o.some(function(t){return /^Cryptos/.test(t);}) && o.some(function(t){return /^TradeHub/.test(t);}) && !o.some(function(t){return /My Positions/.test(t);});`));
  ok('Webull was read once for the visit', webullCalls === 1, webullCalls);
  await pickRail('tradehub');
  ok('picking TradeHub shows the TradeHub list in its order', (await rail()) === WATCHLIST.join(), await rail());
  ok('...and the pick is saved (wl2.selected)', await until(`${DOC}.wl2 && ${DOC}.wl2.selected==='tradehub'`, 4000), await js(`return JSON.stringify(${DOC}.wl2||null);`));
  await railDrag(0, 2, 'y');
  const want1 = [WATCHLIST[1], WATCHLIST[2], WATCHLIST[0], ...WATCHLIST.slice(3)].join();
  ok('a rail drag KEEPS its new order after the drop (no snap back, ask 5)', (await rail()) === want1, await rail());
  ok('...and the TradeHub list is saved in that order (tickers)', await until(`(${DOC}.tickers||[]).join()===${JSON.stringify(want1)}`, 4000), await js(`return (${DOC}.tickers||[]).join();`));
  await pickRail('wb:11');
  await railDrag(2, 0, 'y');
  ok('a Webull list reorders too (AMD to the top), and stays', (await rail()) === 'AMD,NVDA,SNDK', await rail());
  ok('...kept as TradeHub\'s order over it (wl2.order), Webull untouched', await until(`${DOC}.wl2 && JSON.stringify(${DOC}.wl2.order)===JSON.stringify([{id:'wb:11',syms:['AMD','NVDA','SNDK']}])`, 4000), await js(`return JSON.stringify((${DOC}.wl2||{}).order);`));
  await pickRail('wb:13');
  ok('Cryptos: quiet "no data" rows', await js(`var r=[...document.querySelectorAll('[data-ch-rail] .ch-row')]; return r.length===2 && r.every(function(e){return e.classList.contains('is-nodata') && /no data/.test(e.textContent);});`));
  const symBefore = await js(`return document.querySelector('[data-charts]').__charts.active() ? document.querySelector('[data-charts]').__charts.active().get().symbol : '';`);
  await js(`document.querySelector('[data-ch-rail] .ch-row').click(); 1`); await sleep(300);
  ok('...a click on one leaves the chart alone (no chart for crypto yet)', (await js(`return document.querySelector('[data-charts]').__charts.active().get().symbol;`)) === symBefore);
  ok('...and the chart shows a stock, not BTCUSD', symBefore && symBefore !== 'BTCUSD', symBefore);

  console.log('\n1280: Control ▸ Watchlists');
  await tab('prompt');
  ok('the manager is there, the TradeHub list open, one tile per ticker in its order', await until(`document.querySelector('[data-wlm] .ctl-tk')`, 8000) && (await tiles()) === want1, await tiles());
  await pickMgr('wb:11');
  ok('a Webull list: the lock note, no add row, no remove buttons', await js(`return !${mgr('[data-wlm-note]')}.hidden && /Read-only from Webull/.test(${mgr('[data-wlm-note]')}.textContent) && ${mgr('[data-wlm-add]')}.hidden && !document.querySelector('[data-wlm] [data-wlm-remove]');`));
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
  ok('the sync pill says Synced', await until(`(function(){ var p=document.querySelector('[data-wlm-sync]'); return p && p.getAttribute('data-sync')==='ok'; })()`, 4000));
  await js(`document.querySelector('[data-wlm] [data-wlm-remove="MU"]').click(); 1`); await sleep(300);
  ok('remove on a custom list', (await tiles()) === 'AMD');
  await press('[data-wlm-act="rename"]'); await sleep(150);
  await js(`var i=document.querySelector('[data-wlm] .wlm-name input'); var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,'Chips'); i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
  await press('[data-wlm-name-ok]'); await sleep(300);
  ok('Rename: Chips', await js(`return /^Chips/.test(${mgr('[data-wlm-pick]')}.selectedOptions[0].textContent);`));
  await press('[data-wlm-act="delete"]'); await sleep(400);
  ok('Delete: the list leaves, TradeHub opens, the list waits in wl2.listTrash', await js(`return ![...${mgr('[data-wlm-pick]')}.options].some(function(o){return /Chips/.test(o.textContent);}) && ${mgr('[data-wlm-pick]')}.value==='tradehub';`) && await until(`((${DOC}.wl2||{}).listTrash||[]).some(function(l){return l.name==='Chips';})`, 4000));
  await js(`[...document.querySelectorAll('button')].find(function(b){return /Trash/.test(b.textContent) && b.offsetParent;}).click(); 1`); await sleep(400);
  ok('Trash has a Lists section with Chips (1)', await js(`return /Lists/.test(document.body.innerText) && /Chips \\(1\\)/.test(document.body.innerText);`));
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
  await js(`document.querySelector('[data-wlm] [data-wlm-follow-id="wb:13"]').click(); 1`); await sleep(600);
  ok('ticking Cryptos adds nothing (stocks only)', (await followed()) === JSON.stringify(f1), await followed());
  await js(`document.querySelector('[data-wlm] [data-wlm-follow-id="wb:13"]').click(); 1`); await sleep(400);

  console.log('\n1280: another device, and Webull down');
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

  for (const [w, hgt, axis] of [[820, 1000, 'x'], [390, 844, 'x']]) {
    console.log(`\n${w}: the rail and the manager`);
    await size(w, hgt);
    await boot({ quant: true });
    await tab('charts');
    ok(`${w}: the rail shows Main`, await until(`[...document.querySelectorAll('[data-ch-rail] .ch-row')].map(function(e){return e.dataset.sym;}).join()==='NVDA,SNDK,AMD'`, 15000), await rail());
    ok(`${w}: the picker is on screen and inside the card`, await js(`var s=document.querySelector('[data-ch-list]'), c=s.closest('.lay-card'); var a=s.getBoundingClientRect(), b=c.getBoundingClientRect(); return !s.hidden && a.width>0 && a.left>=b.left-1 && a.right<=b.right+1;`));
    await railDrag(0, 1, axis);
    ok(`${w}: a sideways drag in the strip keeps its new order`, (await rail()) === 'SNDK,NVDA,AMD', await rail());
    await tab('prompt');
    ok(`${w}: the manager fits (no sideways scroll)`, await until(`document.querySelector('[data-wlm] .ctl-tk')`, 8000) && await js(`return document.documentElement.scrollWidth<=window.innerWidth+1 && document.querySelector('[data-wlm]').getBoundingClientRect().right<=window.innerWidth+1;`), await js(`return document.documentElement.scrollWidth+' vs '+window.innerWidth;`));
  }

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
