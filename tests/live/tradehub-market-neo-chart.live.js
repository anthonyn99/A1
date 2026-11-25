// Regression for cached Market cards, offscreen Neo reads/navigation and chart studies.
'use strict';
const assert = require('node:assert/strict');
const { connect } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, CLOCK, FIXTURE } = require('./quant-mock.js');

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  const errors = [];
  c.ws.addEventListener('message', (ev) => {
    const event = JSON.parse(ev.data);
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text + ': ' + (event.params.exceptionDetails.exception?.description || ''));
  });
  const { boot, size, tab, js, until } = driver(c);
  const dock = "document.querySelector('[data-nq-dock]')";
  const answer = "Array.from(document.querySelectorAll('[data-nq-dock] [data-nq-a]')).at(-1)";
  const send = (q) => js("var i=" + dock + ".querySelector('[data-nq-input]'); i.value=" + JSON.stringify(q) + "; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})); 1");
  try {
    for (const width of [1504, 1044, 390]) {
      const day = new Date(CLOCK + 86400000).toISOString().slice(0, 10);
      api.state.snapshot = FIXTURE;
      await size(width, 900);
      await boot({ quant: true });
      await tab('portfolio');
      await js("window.dispatchEvent(new CustomEvent('fb-tb-marketcal-remote',{detail:{generatedAt:Date.now(),events:[{name:'Test CPI release',date:" + JSON.stringify(day) + ",kind:'macro',time:'08:30'}]}})); 1");
      await until("document.querySelector('[data-nq-launch]')", 10000);
      await js("if(" + dock + ".hidden) document.querySelector('[data-nq-launch]').click(); 1");
      assert.ok(await until(dock + ".querySelector('[data-nq-input]')", 10000), 'Neo opens');
      await send('What is the market regime and upcoming macros?');
      assert.ok(await until(answer + "?.dataset.state === 'done'", 13000), 'Neo answers from offscreen stores');
      const asked = api.posted.ai?.filter((a) => a.p === '/ai/chat').at(-1);
      assert.ok(asked?.body?.facts?.some((x) => /Market regime/i.test(x.text)), 'regime is in the fact sheet');
      assert.ok(asked.body.facts.some((x) => /Test CPI release/i.test(x.text)), 'macro event is in the same fact sheet');
      assert.ok(await js("var d=" + answer + ".querySelector('.nq-details'); return !!d && !d.open && !!d.querySelector('[data-nq-pieces]');"), 'answer evidence is collapsed');
      await send('go to Control -> Alerts');
      assert.ok(await until("document.querySelector('[data-ctl-sub-on=alerts]')", 10000), 'qualified subtab opens');
      await js(dock + ".querySelector('[data-nq-close]')?.click(); 1");
      await tab('market');
      assert.ok(await until("document.querySelector('[data-mk-score]')", 9000), 'Market renders');
      await tab('charts');
      const chart = "document.querySelector('[data-charts]')?.__charts?.active()";
      assert.ok(await until(chart + '?.info().bars > 0', 12000), 'chart bars load');
      const active = JSON.parse(await js('return JSON.stringify(' + chart + '.get());'));
      const countBars = () => api.asked.filter((a) => {
        if (a.p !== '/bars') return false;
        const params = new URLSearchParams(a.q);
        return params.get('symbol') === active.symbol && params.get('tf') === active.tf;
      }).length;
      const bars = countBars();
      await js(chart + ".set({indicators:[{type:'fvg'},{type:'candle'}]}); 1");
      assert.ok(await until("document.querySelector('[data-ch-candle]:not([hidden])')?.textContent.includes('% body')", 4000), 'candle readout renders');
      assert.equal(countBars(), bars, 'the indicators use loaded bars');
      if (width === 1044) assert.ok(await js("var a=document.querySelector('[data-ch-rail]'); return a.classList.contains('tb-scroll-thin') && getComputedStyle(a).overflowX === 'auto' && a.scrollWidth > a.clientWidth;"), 'desktop pointer can reach the horizontal scrollbar');
      await tab('market');
      assert.ok(await until("document.querySelector('[data-mk-score]') && !document.querySelector('[data-mk] .mk-empty')?.textContent.includes('Reading the market')", 4000), 'Market returns with cached figures');
      console.log('Market, Neo and Charts passed at ' + width + ' px');
    }
    assert.deepEqual(errors, []);
  } finally { c.ws.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
