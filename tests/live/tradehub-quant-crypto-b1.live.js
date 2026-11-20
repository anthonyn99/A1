// TradeHub Quant Refinements Batch 2, B1 (A1-Priv docs/TradeHub/quant/r2-01.md): crypto in the real page.
// A coin on the TradeHub list (BTCUSD) and one typed as BTC-USD style both become full Charts rows:
// a price and its 24-hour change, a chart with bars and no session shading, live ticks from Coinbase
// (faked here like Alpaca and Finnhub), never on the stock streams; Analysis and Key Stats say they are
// for stocks. At 1280, 820 and 390 px.
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-crypto-b1.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, WATCHLIST } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const TAB = `document.querySelector('[data-charts]').__charts`, CH = `${TAB}.active()`;

(async () => {
  const api = quantApi();
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
  const row = (s) => `document.querySelector('[data-ch-rail] [data-sym="${s}"]')`;

  for (const [w, h, name] of [[1504, 900, 'desktop'], [820, 1100, 'tablet'], [390, 844, 'phone']]) {
    console.log(`\n${name} (${w === 1504 ? 1280 : w} px)`);
    await size(w, h);
    await boot({ quant: true, watchlist: [...WATCHLIST.slice(0, 6), 'BTCUSD', 'BTC-USD', 'SUIUSD'] });
    await tab('charts');
    await until(`${TAB} && ${CH} && ${CH}.info().bars > 0`, 20000);
    ok('the coin is a full rail row, not a "no data" row', await until(`${row('BTCUSD')} && !${row('BTCUSD')}.classList.contains('is-nodata')`, 8000), await js(`var r=${row('BTCUSD')}; return r ? r.className + ' ' + r.textContent : 'none';`));
    ok('...BTC-USD typed by hand is the same coin (one row, BTCUSD)', await js(`return document.querySelectorAll('[data-ch-rail] [data-sym="BTCUSD"]').length === 1 && !document.querySelector('[data-ch-rail] [data-sym="BTC-USD"]');`));
    ok('...it has a price and its 24-hour change from the snapshot (100 against 95 = +5.26%)', await until(`/100/.test(${row('BTCUSD')}.querySelector('[data-ch-px]').textContent) && /5\\.26/.test(${row('BTCUSD')}.querySelector('[data-ch-chg]').textContent)`, 8000),
      await js(`var r=${row('BTCUSD')}; return r && r.textContent;`));
    ok('Coinbase is subscribed for both coins; no coin on the stock streams', await until(`window.__ws.cbSubs.has('BTC-USD') && window.__ws.cbSubs.has('SUI-USD')`, 8000) && await js(`return ![...window.__ws.state.subs].some(function(s){ return /USD$/.test(s); }) && !window.__ws.state.sent.some(function(m){ return m.type==='subscribe' && /USD$/.test(m.symbol||''); });`),
      await js(`return JSON.stringify({ cb: [...window.__ws.cbSubs], alpaca: [...window.__ws.state.subs] });`));
    await js(`${row('BTCUSD')}.click(); 1`);
    ok('a press shows the coin in the chart, with bars', await until(`${CH}.info().symbol === 'BTCUSD' && ${CH}.info().bars > 0 && document.querySelector('[data-ch-main] [data-ch-note]').hidden`, 10000), JSON.stringify(JSON.parse(await js(`return JSON.stringify(${CH}.info());`))).slice(0, 200));
    ok('...and no session shading (crypto trades all day)', await js(`return ${CH}.info().bands === 0;`));
    await js(`window.__ws.cbTick('BTC-USD', 101, 95); 1`);
    ok('a Coinbase tick moves the rail price and the 24-hour change (101 against 95 = +6.32%)', await until(`/101/.test(${row('BTCUSD')}.querySelector('[data-ch-px]').textContent) && /6\\.32/.test(${row('BTCUSD')}.querySelector('[data-ch-chg]').textContent)`, 5000),
      await js(`return ${row('BTCUSD')}.textContent;`));
    ok('...and the chart head', await until(`/101/.test((document.querySelector('[data-ch-main] .ch-head')||document.body).textContent)`, 5000));
    const card = await until(`document.querySelectorAll('[data-sk-crypto]').length >= 2`, 15000);
    ok('Analysis and Key Stats say they are for stocks', card && await js(`return [].slice.call(document.querySelectorAll('[data-sk-crypto]')).every(function(e){ return /is a coin/.test(e.textContent); });`), await js(`return [].slice.call(document.querySelectorAll('[data-card=analysis],[data-card=stats]')).map(function(e){return e.textContent.slice(0,90);}).join(' || ');`));
    await shot('b1-crypto-' + name);
  }
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
