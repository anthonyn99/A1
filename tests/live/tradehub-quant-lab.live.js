// Read-only Strategy Lab history through the real Neo Quant dock.
'use strict';
const assert = require('node:assert/strict');
const { connect } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, CLOCK } = require('./quant-mock.js');

(async () => {
  const api = quantApi();
  api.state.backtests = [{ id: 'bfixture1', name: 'Semis dip', created: CLOCK,
    spec: { name: 'Semis dip', universe: { symbols: ['NVDA', 'AMD'] }, entry: { all: [{ ind: 'rsi', op: '<', than: 30 }] } },
    summary: { cagr: 0.12, dd: -0.06, trades: 42, words: 'Test buying the dip on semiconductors.' },
    curve: { equity: [[CLOCK - 86400000, 100], [CLOCK, 112]] } }];
  const c = await connect({ mock: api.mock });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  const { js, until, size, boot, tab, shot } = driver(c);
  const answer = "[...document.querySelectorAll('[data-nq-dock] [data-nq-a]')].pop()";
  async function ask(q, expected) {
    const before = await js("return document.querySelectorAll('[data-nq-dock] [data-nq-a]').length;");
    await js("var i=document.querySelector('[data-nq-dock] [data-nq-input]'); i.value=" + JSON.stringify(q) + "; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})); 1");
    assert.ok(await until("document.querySelectorAll('[data-nq-dock] [data-nq-a]').length > " + before + " && " + answer + ".dataset.state==='done' && " + answer + ".innerText.includes(" + JSON.stringify(expected) + ")", 8000), q);
  }
  for (const w of [1280, 820, 390]) {
    await size(w, w < 600 ? 844 : 900);
    await boot({ quant: true });
    await tab('market');
    assert.ok(await until("document.querySelector('[data-nq-launch]:not([hidden])')", 8000));
    await js("document.querySelector('[data-nq-launch]').click(); 1");
    assert.ok(await until("document.querySelector('[data-nq-dock]:not([hidden]) [data-nq-input]')", 8000));
    await ask('saved backtests', 'Semis dip');
    await ask('open saved backtest Semis dip', '42');
    assert.ok(await js("return !!document.querySelector('[data-nq-lab-opened]') && !document.querySelector('[data-nq-labrun], [data-nq-labopen]');"));
    await shot('strategy-lab-history-' + w);
    await ask('Backtest RSI on SPY', 'Neo Cortex runs new strategy research');
    console.log('  ok   ' + w + ' px: saved results open and new manual runs are retired');
  }
  assert.equal((api.posted.backtests || []).length, 0);
  assert.equal((api.posted.ai || []).length, 0);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
