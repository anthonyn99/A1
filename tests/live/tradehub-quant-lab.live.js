// TradeHub Quant, Phase 9B: Strategy Lab in the real page (A1-Priv tradehub.html
// + TradeHub/neo/strategist.js, lab.js, lab-view.js, ui/backtest.js), quant-api
// played here (quant-mock.js).
//
//   1. Scanner ▸ Backtest has "Ask Neo Quant" first; a typed request → ONE spec call
//      (job: spec, the rule language in its prompt) → the read-back with "(default)"
//      marks → the run (progress, the builder filled) → every result card → a checked read
//      (ONE more call) → saved with its words
//   2. a follow-up ("same on QQQ") is edited by code: no spec call, a chip, a new run
//   3. "save it as …" keeps it under that name (the auto-saved row removed)
//   4. the dock holds the same conversation; "compare with buy and hold" answers there
//   5. a request from the dock on another tab: a result card, "Open in Backtest" opens it
//   6. reload: the saved run is listed; "open …" brings it back; Run re-runs it
//   7. 1280, 820, 390 px: no sideways scroll; the page never froze (no task over 50 ms
//      while a run went); no uncaught error
//
// Run: node tests/live/tradehub-quant-lab.live.js   (SHOTS_DIR=… for screenshots;
//      TH_PAGE_FILE=… to drive a work-in-progress copy of tradehub.html)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const SPEC = { name: 'Live lab dip', universe: { symbols: ['NVDA', 'AMD', 'MSFT'] }, from: '2023-06-01',
  entry: { all: [{ ind: 'rsi', args: [14], op: '<', than: 45 }] }, exit: { any: [{ stop: 'atr', value: 2 }, { target: 'r', value: 2 }, { bars: 10 }] } };
const WORDS = 'test buying NVDA, AMD and MSFT when RSI is under 45 since June 2023, 2 ATR stop, 2R target, out after 10 days';

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP + `;window.__long=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__long.push(Math.round(e.duration));});}).observe({type:'longtask',buffered:false});}catch(e){}` });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const ai = () => api.posted.ai || [];
  const specCalls = () => ai().filter((x) => x.body && x.body.job === 'spec');
  const sayInBox = (q) => js(`var i=document.querySelector('[data-bt-lab-input]'); i.value=${JSON.stringify(q)}; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})); 1`);
  let nA = 0;
  const countA = (sel) => js(`return document.querySelectorAll('${sel}').length;`);
  const boxDone = async (kind) => until(`(function(){var a=[...document.querySelectorAll('[data-bt-lab-a]')]; var l=a[a.length-1]; return a.length > ${nA} && l && l.dataset.state==='done' && !!l.querySelector('[data-nq-lab${kind ? '="' + kind + '"' : ''}]');})()`, 60000);
  const lastBox = `[...document.querySelectorAll('[data-bt-lab-a]')].pop()`;
  const openBacktest = async () => {
    await tab('scanner');
    await until(`document.querySelector('[data-sc-view="backtest"]')`, 15000);
    await js(`var b=document.querySelector('[data-sc-view="backtest"]'); if (b.getAttribute('aria-pressed')!=='true') b.click(); 1`);
    return until(`document.querySelector('[data-bt-lab] [data-bt-lab-input]')`, 15000);
  };

  console.log('\nA request typed in Scanner ▸ Backtest');
  await size(1280, 900);
  await boot({ quant: true });
  ok('Scanner ▸ Backtest has the "Ask Neo Quant" card, first, with a hint', await openBacktest() && await js(`var cards=[...document.querySelectorAll('[data-backtest] .lay-card')]; return cards[0] && cards[0].dataset.card==='lab' && /Say a strategy in your own words/.test(document.querySelector('[data-bt-lab]').innerText);`));
  ok('nothing asked of the AI yet', ai().length === 0);
  api.state.ai.plan.push({ text: JSON.stringify(SPEC) });
  await js('window.__long=[]; 1');
  nA = await countA('[data-bt-lab-a]');
  await sayInBox(WORDS);
  ok('the run finishes and the Lab card shows the result', await boxDone('result'), await js(`var a=${lastBox}; return a ? a.innerText.slice(0,400) : 'none';`));
  const sc = specCalls()[0];
  ok('ONE spec call: job spec, the rule language and the worked examples in its prompt, the words as the message', specCalls().length === 1 && /INDICATORS/.test(sc.body.system) && /SETUPS/.test(sc.body.system) && /EXAMPLES/.test(sc.body.system) && sc.body.messages[0].content === WORDS);
  ok('...and ONE read call (two in all for the request)', ai().length === 2 && ai()[1].body.job === undefined && ai()[1].body.facts.some((f) => f.pack === 'backtest'));
  const card = await js(`var a=${lastBox}; return JSON.stringify({ rb: (a.querySelector('[data-nq-readback]')||{}).innerText||'', defs: a.querySelectorAll('[data-nq-default]').length, tiles: a.querySelectorAll('[data-nq-tiles] .nq-lab-tile').length, read: !!a.querySelector('[data-nq-read]'), saved: /Saved with its words/.test(a.innerText) });`).then(JSON.parse);
  ok('the read-back in plain words, what was not said marked "(default)"', /buy when RSI \(14\) is below 45/.test(card.rb) && /NVDA, AMD, MSFT/.test(card.rb) && card.defs >= 1 && /\(default/.test(card.rb), JSON.stringify(card));
  ok('...the headline tiles, the checked read, "saved with its words"', card.tiles === 6 && card.read && card.saved, JSON.stringify(card));
  ok('the builder holds the same spec (Neo Quant filled it)', /RSI \(14\) is below 45/.test(await js(`return document.querySelector('[data-bt-desc]').textContent;`)));
  ok('every result card drew: tiles, equity chart, monthly heatmap, trades', await until(`document.querySelector('[data-bt-tile="cagr"]') && document.querySelector('.bt-eq canvas') && document.querySelectorAll('[data-bt-heat] .bt-hc').length > 6 && document.querySelectorAll('[data-bt-trow]').length > 0`, 8000));
  const save1 = (api.posted.backtests || [])[0];
  ok('every run is saved once, with its words and spec', (api.posted.backtests || []).length === 1 && save1.summary.words === WORDS && save1.summary.lab === true && save1.spec.universe.symbols.length === 3);
  const long1 = await js(`return JSON.stringify(window.__long);`).then(JSON.parse);
  ok('the page never froze while it ran (no task over 50 ms)', long1.every((d) => d <= 50), JSON.stringify(long1));
  await shot('lab-result-1280');

  console.log('\nA follow-up edited by code');
  const ai0 = ai().length;
  nA = await countA('[data-bt-lab-a]');
  await sayInBox('same on QQQ');
  ok('"same on QQQ" runs again', await boxDone('result'));
  ok('...no spec call (code edited it), one read call', specCalls().length === 1 && ai().length === ai0 + 1);
  ok('...the change shows as a chip, the builder and the read-back say QQQ', await js(`var a=${lastBox}; return /universe/.test((a.querySelector('[data-nq-chips]')||{}).innerText||'') && /QQQ/.test(a.querySelector('[data-nq-readback]').innerText);`) && /QQQ/.test(await js(`return document.querySelector('[data-bt-desc]').textContent;`)));

  console.log('\nSave as');
  nA = await countA('[data-bt-lab-a]');
  await sayInBox('save it as Live lab QQQ');
  ok('"save it as Live lab QQQ": kept under that name', await boxDone('saved') && api.state.backtests.some((b) => b.name === 'Live lab QQQ'));
  ok('...the auto-saved row of that run removed (a rename, not a duplicate)', api.state.backtests.filter((b) => b.summary && b.summary.words === WORDS).length === 2 && !api.state.backtests.some((b) => b.name === 'Live lab dip' && b.spec.universe.symbols && b.spec.universe.symbols[0] === 'QQQ'), JSON.stringify(api.state.backtests.map((b) => [b.name, b.spec.universe])));
  ok('the Saved runs card lists it', await until(`[...document.querySelectorAll('[data-bt-srow]')].some(function(r){return /Live lab QQQ/.test(r.innerText);})`, 5000));

  console.log('\nThe dock: one conversation');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); 1`);
  ok('the dock shows the same Lab turns', await until(`document.querySelector('[data-nq-dock]') && !document.querySelector('[data-nq-dock]').hidden && document.querySelectorAll('[data-nq-dock] [data-nq-lab]').length >= 3`, 5000));
  const dockAsk = (q) => js(`var i=document.querySelector('[data-nq-dock] [data-nq-input]'); i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})); 1`);
  let nDock = await countA('[data-nq-dock] [data-nq-a]');
  await dockAsk('compare with buy and hold');
  ok('"compare with buy and hold" in the dock: the strategy, the benchmark and buy and hold, by code (no AI call)', await until(`(function(){var a=[...document.querySelectorAll('[data-nq-dock] [data-nq-a]')]; var l=a[a.length-1]; return a.length > ${nDock} && l.dataset.state==='done' && /Buy and hold/.test(l.innerText) && /SPY/.test(l.innerText);})()`, 8000) && ai().length === ai0 + 1);

  console.log('\nFrom the dock on another tab');
  await tab('market');
  await js(`var d=document.querySelector('[data-nq-dock]'); if(d.hidden) document.querySelector('[data-nq-launch]').click(); 1`);
  api.state.ai.plan.push({ text: JSON.stringify({ ...SPEC, name: 'Dock dip', universe: { symbols: ['AMD'] } }) });
  nDock = await countA('[data-nq-dock] [data-nq-a]');
  await dockAsk('backtest buying AMD when RSI is under 45 since June 2023 with a 2 ATR stop, a 2R target, out after 10 days');
  ok('a backtest asked in the dock on the Market tab: a result card there', await until(`(function(){var a=[...document.querySelectorAll('[data-nq-dock] [data-nq-a]')]; var l=a[a.length-1]; return a.length > ${nDock} && l.dataset.state==='done' && l.querySelector('[data-nq-lab="result"]') && l.querySelector('[data-nq-labopen]');})()`, 60000));
  await js(`[...document.querySelectorAll('[data-nq-dock] [data-nq-labopen]')].pop().click(); 1`);
  ok('"Open in Backtest" opens Scanner ▸ Backtest with that run in the builder and the results', await until(`document.querySelector('[data-backtest]') && /AMD/.test((document.querySelector('[data-bt-desc]')||{}).textContent||'') && document.querySelector('[data-bt-tile="cagr"]')`, 15000));
  await js(`var i=document.querySelector('[data-nq-dock] [data-nq-input]'); if(i){ i.focus(); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); } 1`);

  console.log('\nReload, open, re-run');
  await boot({ quant: true, keep: true });
  await openBacktest();
  ok('after a reload the saved runs are listed (with the renamed one)', await until(`[...document.querySelectorAll('[data-bt-srow]')].some(function(r){return /Live lab QQQ/.test(r.innerText);})`, 15000));
  nA = await countA('[data-bt-lab-a]');
  await sayInBox('open Live lab QQQ');
  ok('"open Live lab QQQ": its spec back in the builder, a Run button, the words it was asked in', await boxDone('opened') && /QQQ/.test(await js(`return document.querySelector('[data-bt-desc]').textContent;`)) && await js(`var a=${lastBox}; return !!a.querySelector('[data-nq-labrun]') && a.innerText.indexOf(${JSON.stringify(WORDS.slice(0, 30))}) >= 0;`));
  nA = await countA('[data-bt-lab-a]');
  await js(`${lastBox}.querySelector('[data-nq-labrun]').click(); 1`);
  ok('Run re-runs it on fresh data', await boxDone('result'));

  console.log('\nThree widths');
  for (const [w, h] of [[1280, 900], [820, 1100], [390, 844]]) {
    await size(w, h); await sleep(500);
    ok(`${w} px: no sideways scroll; the Lab card is there with its box`, await js(`return document.scrollingElement.scrollWidth <= innerWidth + 1 && !!document.querySelector('[data-bt-lab-input]') && document.querySelector('[data-bt-lab]').getBoundingClientRect().width > 200;`));
    await js(`document.querySelector('[data-card="lab"]').scrollIntoView(); 1`);
    await shot('lab-' + w);
  }
  ok('no uncaught errors', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
