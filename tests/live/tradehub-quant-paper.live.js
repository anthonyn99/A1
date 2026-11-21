// TradeHub Quant, Phase 9C: paper trading in the real page (A1-Priv tradehub.html
// + TradeHub/ui/paper.js, paper-ticket.js, data/paper.js), quant-api's /paper/…
// played here (quant-mock.js).
//
//   1. the Paper tab: the account with the PAPER badge, positions with P&L, working and
//      filled orders, the activity log, strategies on paper; its cards tile
//   2. the order ticket: a bad order says why and cannot be sent; every type changes the
//      fields; a bracket; Review reads it back (PAPER) before it goes; it lands as Tony's
//   3. a working order: a new price, Cancel
//   4. a Scanner signal's "Place on paper": the ticket with its bracket prefilled
//   5. the Backtest view's "Start on paper" → a run on the Paper tab; pause; live vs backtest
//   6. the kill switch: every order cancelled, every run paused, new orders refused
//   7. 1280, 820, 390 px: no sideways scroll; no task over 50 ms; no uncaught error
//
// Run: node tests/live/tradehub-quant-paper.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, CLOCK } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const MIN = 60000;

(async () => {
  const api = quantApi();
  api.state.signals = [{ id: 'sgo00001', symbol: 'NVDA', setup: 'orb', horizon: 'day', dir: 'long', at: CLOCK - 2 * MIN, expires: CLOCK + 60 * MIN, verdict: 'GO', score: 78,
    trigger: 164, zone: [163.9, 164.15], entry: 164.03, stop: 163.6, targets: [164.7, 165.3], rr: [1.6, 3], risk: 0.85, atr: 0.6, factors: { trend: 0.8 }, why: ['volume 2.1× usual'], notes: [],
    backtested: false, regime: 'Constructive', status: 'open', done: false, created: CLOCK - 60 * MIN }];
  api.state.pp.closed = [{ id: 'old1', symbol: 'AMD', side: 'buy', qty: '5', type: 'market', status: 'filled', filled_avg_price: '140.20', submitted_at: new Date(CLOCK - 86400000).toISOString() }];
  api.state.pp.log = [{ id: 'cold1', at: CLOCK - 86400000, who: 'run', reason: 'Dip: entry fired on the 2026-11-12 bar', symbol: 'AMD', side: 'buy', type: 'market', qty: 5, body: { symbol: 'AMD', side: 'buy', type: 'market', time_in_force: 'day', qty: '5' }, status: 'filled', alpaca_id: 'old1', run: null }];
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP + `;window.__long=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__long.push(Math.round(e.duration));});}).observe({type:'longtask',buffered:false});}catch(e){}
    window.uiConfirm=function(){return Promise.resolve(true);}; window.uiPrompt=function(t,o){return Promise.resolve(window.__promptAnswer!=null?window.__promptAnswer:(o&&o.value)||'');};` });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const pp = () => api.posted.pp || [];
  const posts = (path) => pp().filter(([m, p]) => m !== 'GET' && p === path);
  const T = `document.querySelector('[data-paper-ticket]')`;
  const setField = (k, v) => js(`var i=${T}.querySelector('[data-pt-${k}]'); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
  const press = (sel) => js(`var b=${T}.querySelector('${sel}'); b.click(); 1`);

  console.log('\nThe Paper tab');
  await size(1280, 900);
  await boot({ quant: true });
  // TradeHub installs its own in-page dialogs after boot: answer them here instead.
  const stubDialogs = () => js(`window.uiConfirm=function(){return Promise.resolve(true);}; window.uiPrompt=function(t,o){return Promise.resolve(window.__promptAnswer!=null?window.__promptAnswer:(o&&o.value)||'');}; 1`);
  await stubDialogs();
  ok('the nav has the Trading tab (was Paper)', await js(`return !!document.querySelector('.tb-navtab[data-navid="trading"]');`));
  await tab('trading');
  ok('the account: equity, today, cash, buying power, the PAPER badge', await until(`/\\$100,000\\.00/.test((document.querySelector('[data-pp-equity]')||{}).textContent||'')`, 15000) && await js(`var a=document.querySelector('[data-pp-account]').innerText; return /Today/.test(a) && /\\$400\\.00/.test(a) && /Buying power/.test(a) && !!document.querySelector('[data-paper-tab] .pt-badge');`));
  ok('positions with their P&L and a Close button', await js(`var r=document.querySelector('[data-pp-pos="NVDA"]'); return !!r && /\\$40\\.00/.test(r.innerText) && !!r.querySelector('[data-pp-close]');`));
  ok('filled orders and the activity log: who placed each and why', await js(`return !!document.querySelector('[data-pp-ord="old1"]') && /Strategy/.test(document.querySelector('[data-pp-log="cold1"]').innerText) && /entry fired/.test(document.querySelector('[data-pp-log="cold1"]').innerText);`));
  ok('the nine cards are there (the seven, and R7\'s Analysis and Key Stats)', (await js(`return document.querySelectorAll('[data-paper-tab] .lay-card').length;`)) === 9);
  await shot('paper-1280');

  console.log('\nThe order ticket');
  await js(`document.querySelector('[data-pp-new]').click(); 1`);
  ok('New order opens the ticket, marked PAPER', await until(`${T} && /PAPER/.test(${T}.innerText)`, 3000));
  await setField('symbol', 'AMD'); await setField('size', '0');
  ok('a bad order says why and cannot be sent', await js(`return /above zero/.test(${T}.querySelector('[data-pt-errors]').innerText) && ${T}.querySelector('[data-pt-go]').disabled;`));
  await press('[data-pt-type="limit"]');
  ok('a limit order asks for its limit', await js(`return !!${T}.querySelector('[data-pt-limit]');`));
  await press('[data-pt-type="stop_limit"]');
  ok('a stop-limit asks for both prices', await js(`return !!${T}.querySelector('[data-pt-limit]') && !!${T}.querySelector('[data-pt-stop]');`));
  await press('[data-pt-type="trailing_stop"]');
  ok('a trailing stop asks for its trail', await js(`return !!${T}.querySelector('[data-pt-trail]');`));
  await press('[data-pt-type="limit"]');
  await setField('size', '10'); await setField('limit', '140');
  await js(`var c=${T}.querySelector('[data-pt-bracket]'); c.click(); 1`);
  await setField('bTarget', '150'); await setField('bStop', '135');
  ok('a bracket: the read-back says the entry, the target and the stop, PAPER first', await until(`/^PAPER: Buy 10 shares of AMD with a limit at 140\\.00, then a target at 150\\.00 and a stop at 135\\.00, for today\\.$/.test(${T}.querySelector('[data-pt-readback]').textContent)`, 2000), await js(`return ${T}.querySelector('[data-pt-readback]').textContent;`));
  await press('[data-pt-go]');
  ok('Review asks once more before anything goes out', await js(`return ${T}.querySelector('[data-pt-go]').textContent === 'Place on paper';`) && posts('/paper/orders').length === 0);
  await press('[data-pt-go]');
  ok('Place on paper: one order to quant-api, as Tony\'s, the bracket with it', await until(`!${T}`, 5000) && posts('/paper/orders').length === 1 && posts('/paper/orders')[0][2].who === 'tony' && posts('/paper/orders')[0][2].order.order_class === 'bracket' && posts('/paper/orders')[0][2].order.take_profit.limit_price === 150);
  ok('...it shows as a working order', await until(`document.querySelector('[data-pp-ord="ord1"]')`, 8000));

  console.log('\nA working order');
  await js(`window.__promptAnswer='139.5'; document.querySelector('[data-pp-ord="ord1"] [data-pp-reprice]').click(); 1`);
  ok('a new price goes to quant-api', await until(`${JSON.stringify(1)} && true`, 100) && await (async () => { for (let k = 0; k < 30; k++) { if (pp().some(([m, p, b]) => m === 'PATCH' && p === '/paper/orders/ord1' && b.limit_price === 139.5)) return true; await sleep(100); } return false; })());
  await js(`window.__promptAnswer=null; document.querySelector('[data-pp-ord="ord1"] [data-pp-cancel]').click(); 1`);
  ok('Cancel moves it to the cancelled orders', await until(`!document.querySelector('[data-pp-working] [data-pp-ord="ord1"]') && document.querySelector('[data-pp-filled] [data-pp-ord="ord1"]')`, 8000));

  console.log('\nPlace on paper from a signal');
  await tab('scanner');
  await until(`document.querySelector('[data-sc-sig="sgo00001"]')`, 15000);
  await js(`document.querySelector('[data-sc-sig="sgo00001"]').click(); 1`);
  ok('a signal\'s detail has "Place on paper" and "Watch as an idea"', await until(`document.querySelector('[data-sc-place]') && document.querySelector('[data-sc-follow]')`, 8000));
  await js(`document.querySelector('[data-sc-place]').click(); 1`);
  ok('...the ticket opens with the signal\'s bracket: entry 164.03, stop 163.60, target 164.70', await until(`${T} && ${T}.querySelector('[data-pt-limit]') && ${T}.querySelector('[data-pt-limit]').value==='164.03' && ${T}.querySelector('[data-pt-bStop]').value==='163.6' && ${T}.querySelector('[data-pt-bTarget]').value==='164.7'`, 8000), await js(`return ${T} ? ${T}.innerText.slice(0,300) : 'no ticket';`));
  await js(`${T}.querySelector('[data-pt-cancel]').click(); 1`);

  console.log('\nStart on paper, live vs backtest');
  await js(`document.querySelector('[data-sc-view="backtest"]').click(); 1`);
  await until(`document.querySelector('[data-backtest] [data-bt-form]')`, 15000);
  await js(`document.querySelector('[data-backtest]').__backtest.builder.set({ v: 1, name: 'Live paper dip', horizon: 'swing', universe: { symbols: ['NVDA', 'AMD'] }, from: '2023-06-01', entry: { all: [{ ind: 'rsi', args: [14], op: '<', than: 45 }] }, exit: { any: [{ stop: 'atr', value: 2 }, { target: 'r', value: 2 }, { bars: 10 }] } }); document.querySelector('[data-bt-run]').click(); 1`);
  ok('a backtest\'s results offer "Start on paper"', await until(`document.querySelector('[data-bt-paper]')`, 60000));
  await js(`window.__promptAnswer='25000'; document.querySelector('[data-bt-paper]').click(); 1`);
  ok('...it starts a run with that capital and the spec', await until(`/On paper/.test(document.querySelector('[data-bt-paper]').textContent)`, 8000) && posts('/paper/runs').length === 1 && posts('/paper/runs')[0][2].capital === 25000 && posts('/paper/runs')[0][2].spec.name === 'Live paper dip');
  await tab('trading');
  ok('the Paper tab lists it, running, with its limits', await until(`(function(){var r=document.querySelector('[data-pp-run]'); return r && r.dataset.state==='running' && /Live paper dip/.test(r.innerText) && /Limits: 5 positions/.test(r.innerText);})()`, 8000));
  await js(`document.querySelector('[data-pp-run] [data-pp-pause]').click(); 1`);
  ok('Pause', await until(`document.querySelector('[data-pp-run]').dataset.state==='paused'`, 5000));
  await js(`window.__long=[]; document.querySelector('[data-pp-run] [data-pp-drift]').click(); 1`);
  ok('Live vs backtest: the same numbers on paper and on the backtest over the same days, the gap, the caveat', await until(`(function(){var d=document.querySelector('[data-pp-driftout]'); return d && /Paper/.test(d.innerText) && /Backtest/.test(d.innerText) && /Gap/.test(d.innerText) && /no queue position/.test(d.innerText);})()`, 60000), await js(`return (document.querySelector('[data-pp-drift]')||{}).innerText;`));
  const long1 = await js(`return JSON.stringify(window.__long);`).then(JSON.parse);
  ok('the page never froze while the backtest ran (no task over 50 ms)', long1.every((d) => d <= 50), JSON.stringify(long1));

  console.log('\nThe kill switch');
  await js(`document.querySelector('[data-pp-new]').click(); 1`);
  await until(`${T}`, 3000);
  await setField('symbol', 'MSFT'); await press('[data-pt-type="limit"]'); await setField('size', '2'); await setField('limit', '400');
  await press('[data-pt-go]'); await press('[data-pt-go]');
  await until(`!${T}`, 5000);
  await js(`document.querySelector('[data-pp-run] [data-pp-resume]') && document.querySelector('[data-pp-run] [data-pp-resume]').click(); 1`);
  await until(`document.querySelector('[data-pp-run]').dataset.state==='running'`, 5000);
  await js(`document.querySelector('[data-pp-kill]').click(); 1`);
  ok('on: every working order cancelled, every run paused, the button says it is on', await until(`/ON/.test(document.querySelector('[data-pp-kill]').textContent) && !document.querySelector('[data-pp-working] [data-pp-ord]') && document.querySelector('[data-pp-run]').dataset.state==='paused'`, 8000) && posts('/paper/kill').length === 1);
  await js(`document.querySelector('[data-pp-new]').click(); 1`);
  await until(`${T}`, 3000);
  ok('...a new order in the ticket says the kill switch is on', await js(`return /Kill switch on/.test(${T}.innerText);`) && await (async () => { await setField('symbol', 'MSFT'); await press('[data-pt-type="limit"]'); await setField('size', '2'); await setField('limit', '400'); return js(`return /kill switch is on/i.test(${T}.querySelector('[data-pt-errors]').innerText) && ${T}.querySelector('[data-pt-go]').disabled;`); })());
  await js(`${T}.querySelector('[data-pt-cancel]').click(); 1`);
  await js(`document.querySelector('[data-pp-kill]').click(); 1`);
  ok('...and off again', await until(`!/ON/.test(document.querySelector('[data-pp-kill]').textContent)`, 8000));

  console.log('\nThree widths');
  for (const [w, h] of [[1280, 900], [820, 1100], [390, 844]]) {
    await size(w, h); await sleep(500);
    ok(`${w} px: no sideways scroll; the account and positions are there`, await js(`return document.scrollingElement.scrollWidth <= innerWidth + 1 && !!document.querySelector('[data-pp-equity]') && !!document.querySelector('[data-pp-positions]');`));
    await js(`document.querySelector('[data-pp-new]').click(); 1`);
    ok(`${w} px: the ticket fits the screen`, await until(`${T} && ${T}.getBoundingClientRect().width <= innerWidth`, 3000));
    await shot('paper-ticket-' + w);
    await js(`${T}.querySelector('[data-pt-cancel]').click(); 1`);
    await shot('paper-' + w);
  }
  ok('no uncaught errors', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
