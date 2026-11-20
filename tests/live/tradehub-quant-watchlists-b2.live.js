// TradeHub Quant Refinements Batch 2, B2 (A1-Priv docs/TradeHub/quant/r2-02.md): the TradeHub list
// matched to a Webull list, in the real page. The one-time switch to Webull's Main on the first real
// read (what Main lacks goes to Trash; kept matched; News follows its stocks only), Control ▸
// Watchlists' "Make this my TradeHub list" with its read-back and Undo, and "Stop matching". At 1280,
// 820 and 390 px.
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-watchlists-b2.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const WB = [
  { id: 11, name: 'Main', sort: 9, tickers: [{ symbol: 'NVDA', exchange: 'NASDAQ' }, { symbol: 'MU', exchange: 'NASDAQ' }, { symbol: 'SNDK', exchange: 'NASDAQ' }, { symbol: 'BTCUSD', exchange: 'CCC' }] },
  { id: 14, name: 'Semis', sort: 7, tickers: [{ symbol: 'AMD', exchange: 'NASDAQ' }, { symbol: 'NVDA', exchange: 'NASDAQ' }] },
];

(async () => {
  const api = quantApi();
  api.state.tradeboard = (req) => (new URL(req.url).pathname === '/api/portfolio/watchlists' ? { json: { ok: true, lists: WB, asOf: Date.now() } } : null);
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Page.javascriptDialogOpening') c.send('Page.handleJavaScriptDialog', { accept: true });
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const DOC = `(window.__fakeFs.docs['dashboards/tradeboard_watchlist']||{})`;
  const tiles = () => js(`return [...document.querySelectorAll('[data-wlm-tiles] .ctl-tk')].map(function(e){return e.dataset.sym;}).join();`);
  const openList = (id) => js(`var s=document.querySelector('[data-wlm-pick]'); s.value=${JSON.stringify(id)}; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);

  for (const [w, h, name] of [[1504, 900, 'desktop'], [820, 1100, 'tablet'], [390, 844, 'phone']]) {
    console.log(`\n${name} (${w === 1504 ? 1280 : w} px)`);
    await size(w, h);
    await boot({ quant: true, watchlist: ['NVDA', 'TSLA', 'PLTR'] });
    console.log('  the one-time switch to Webull\'s Main');
    ok('on the first real Webull read the TradeHub list becomes Main, in Main\'s order', await until(`${DOC}.tickers && ${DOC}.tickers.join()==='NVDA,MU,SNDK,BTCUSD'`, 15000), await js(`return JSON.stringify(${DOC}.tickers);`));
    ok('...what Main lacks (TSLA, PLTR) is in the TradeHub Trash, restorable', await js(`return JSON.stringify((${DOC}.trash||[]).map(function(x){return x.t;}).sort())==='["PLTR","TSLA"]';`), await js(`return JSON.stringify(${DOC}.trash);`));
    ok('...kept matched to Main and marked done, in wl2', await until(`${DOC}.wl2 && ${DOC}.wl2.match==='wb:11' && !!${DOC}.wl2.matchedOnce`, 5000), await js(`return JSON.stringify(${DOC}.wl2);`));
    ok('...News and the workers follow its stocks (the coin left out)', await until(`JSON.stringify((window.__fakeFs.docs['dashboards/tradeboard_watchlist']||{}).followed||null)==='["NVDA","MU","SNDK"]' || (window.__tbFollowed && window.__tbFollowed.join()==='NVDA,MU,SNDK')`, 4000)
      || JSON.stringify(api.posted.watchlists[api.posted.watchlists.length - 1]) === '["NVDA","MU","SNDK"]', JSON.stringify(api.posted.watchlists.slice(-2)));
    await tab('prompt'); await js(`window.tbControlShow && window.tbControlShow('watchlists'); 1`);
    ok('Control ▸ Watchlists: the TradeHub list shows Main\'s tickers', await until(`document.querySelector('[data-wlm-tiles]')`, 8000) && (await tiles()) === 'NVDA,MU,SNDK,BTCUSD', await tiles());
    ok('...and says it is matched to Main, with Stop matching', await until(`document.querySelector('[data-wlm-matched]') && /Main/.test(document.querySelector('[data-wlm-matched]').textContent)`, 4000));
    console.log('  Make this my TradeHub list');
    await openList('wb:14');
    ok('a Webull list offers "Make this my TradeHub list" and "Keep matched"', await until(`document.querySelector('[data-wlm-use]') && document.querySelector('[data-wlm-keep]')`, 4000));
    await js(`document.querySelector('[data-wlm-use]').click(); 1`);
    ok('...it reads back first: what is added and what goes to Trash', await until(`document.getElementById('uim-msg') && /Semis/.test(document.getElementById('uim-msg').textContent) && /AMD/.test(document.getElementById('uim-msg').textContent) && /MU/.test(document.getElementById('uim-msg').textContent)`, 4000),
      await js(`var m=document.getElementById('uim-msg'); return m ? m.textContent : 'no dialog';`));
    await shot('b2-readback-' + name);
    await js(`document.getElementById('uim-ok').click(); 1`);
    ok('...then the TradeHub list is Semis', await until(`${DOC}.tickers && ${DOC}.tickers.join()==='AMD,NVDA'`, 6000), await js(`return JSON.stringify(${DOC}.tickers);`));
    ok('...matching to Main stopped (not kept: the box was unticked)', await until(`${DOC}.wl2 && ${DOC}.wl2.match===null`, 4000), await js(`return JSON.stringify(${DOC}.wl2);`));
    ok('...and an Undo shows on the TradeHub list', await until(`document.querySelector('[data-wlm-undo]')`, 4000));
    await shot('b2-undo-' + name);
    await js(`document.querySelector('[data-wlm-undo]').click(); 1`);
    ok('Undo puts the list back as it was (Main\'s tickers)', await until(`${DOC}.tickers && ${DOC}.tickers.join()==='NVDA,MU,SNDK,BTCUSD'`, 6000), await js(`return JSON.stringify(${DOC}.tickers);`));
    ok('no sideways scroll', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`));
  }
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
