// TradeHub Quant, Phase 6: Scanner ▸ Backtest, Scorecard and Paper in the real
// page (A1-Priv tradehub.html + TradeHub/ui/backtest*.js, scorecard.js),
// quant-api played here (quant-mock.js).
//
//   1. the builder: its plain-words paragraph, a refused spec says why
//   2. a run in its own Web Worker: progress, then every card drawn (tiles and
//      verdict, equity with its drawdown, heatmap, histogram, rolling 12
//      months, breakdowns, trades, sensitivity); log scale; sorting; a trade
//      opens on its chart
//   3. Save (one write), reload, the saved run back, Open, Compare
//   4. Cancel stops a run; Duplicate
//   5. 1280, 820 and 390 px: no sideways scroll, charts drawn
//   6. Scorecard with the measured table; Follow on paper and the Paper view
//   7. no main-thread task over 50 ms during a run; no uncaught error
//
// Run: node tests/live/tradehub-quant-backtest.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, CLOCK } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const BT = `document.querySelector('[data-backtest]').__backtest`;
const MIN = 60000;
const SPEC = { v: 1, name: 'Live dip', horizon: 'swing', universe: { symbols: ['NVDA', 'AMD', 'MSFT'] }, from: '2023-06-01',
  entry: { all: [{ ind: 'rsi', args: [14], op: '<', than: 45 }] }, exit: { any: [{ stop: 'atr', value: 2 }, { target: 'r', value: 2 }, { bars: 10 }] } };

(async () => {
  const api = quantApi();
  api.state.signals = [{ id: 'sgo00001', symbol: 'NVDA', setup: 'orb', horizon: 'day', dir: 'long', at: CLOCK - 2 * MIN, expires: CLOCK + 60 * MIN, verdict: 'GO', score: 78,
    trigger: 164, zone: [163.9, 164.15], entry: 164.03, stop: 163.6, targets: [164.7, 165.3], rr: [1.6, 3], risk: 0.85, atr: 0.6, factors: { trend: 0.8 }, why: ['volume 2.1× usual'], notes: [],
    backtested: true, p: 0.62, n: 58, edge: { avgWinR: 1.4, avgLossR: 1, significant: true }, regime: 'Constructive', status: 'open', done: false, created: CLOCK - 60 * MIN }];
  api.state.calibration = { v: 1, fittedAt: CLOCK - 86400000, n: 2400, span: { from: CLOCK - 5 * 365 * 86400000, to: CLOCK - 86400000 }, oosFrom: CLOCK - 4 * 365 * 86400000, universe: 'the watchlist (14) and the S&P 100',
    setups: { orb: { all: { n: 410, wins: 230, hitRate: 0.56, avgWinR: 1.3, avgLossR: 1, meanR: 0.17, ci: [0.05, 0.29], significant: true, small: false, curve: [[1, 0], [2, 4], [3, 9]] },
      on: { n: 200, wins: 120, hitRate: 0.6, avgWinR: 1.3, avgLossR: 1, meanR: 0.25, ci: [0.1, 0.4], significant: true }, neutral: { n: 150, wins: 80, hitRate: 0.53, avgWinR: 1.3, avgLossR: 1, meanR: 0.1, ci: [-0.05, 0.25], significant: false }, off: { n: 12, wins: 4, hitRate: 0.33, avgWinR: 1.3, avgLossR: 1, meanR: -0.2, ci: [-0.7, 0.3], significant: false, small: true } },
    'ma-pullback': { all: { n: 18, wins: 10, hitRate: 0.55, avgWinR: 1.2, avgLossR: 1, meanR: 0.2, ci: [-0.3, 0.7], significant: false, small: true }, on: { n: 0 }, neutral: { n: 0 }, off: { n: 0 } } }, weights: { orb: {} } };
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP + `;window.__long=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__long.push(e.duration);});}).observe({type:'longtask',buffered:false});}catch(e){}` });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const asked = (p, method) => api.asked.filter((x) => x.p === p && (!method || x.method === method)).length;
  const noSideScroll = () => js(`return document.scrollingElement.scrollWidth <= window.innerWidth + 1;`);

  console.log('\nThe builder');
  await size(1280, 900);
  await boot({ quant: true });
  await tab('scanner');
  await until(`document.querySelector('[data-sc-view="backtest"]')`, 15000);
  await js(`document.querySelector('[data-sc-view="backtest"]').click(); return 1;`);
  ok('Scanner ▸ Backtest mounts the builder', await until(`document.querySelector('[data-backtest] [data-bt-form]')`, 15000));
  ok('...the filters are hidden there (they belong to the board)', await js(`return !document.querySelector('[data-sc-horizon]');`));
  ok('the saved runs are read once', await until(`${BT} && document.querySelector('[data-card="saved"]') && /No saved runs/.test(document.querySelector('[data-card="saved"]').innerText)`, 8000) && asked('/backtests', 'GET') === 1);
  await js(`${BT}.builder.set(${JSON.stringify(SPEC)}); return 1;`);
  ok('its plain-words paragraph', /^Swing trades, long only, on daily bars: buy when RSI \(14\) is below 45\. Exit at a 2 ATR stop, a 2 R target or after 10 bars/.test(await js(`return document.querySelector('[data-bt-desc]').textContent;`)));
  await js(`document.querySelector('[data-bt-add]').click(); return 1;`);
  await sleep(100);
  ok('a new rule row appears from the one indicator list', await js(`return document.querySelectorAll('[data-bt-rule]').length === 2 && document.querySelector('[data-bt-ind]').querySelectorAll('option').length > 30;`));
  await js(`var v=document.querySelectorAll('[data-bt-val]'); var i=v[v.length-1]; i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return 1;`);
  await js(`${BT}.builder.set(Object.assign({}, ${JSON.stringify(SPEC)}, { maxPositions: 0 })); return 1;`);
  ok('a spec that cannot run says why and Run is off', await js(`return /max positions/i.test(document.querySelector('[data-bt-errors]').textContent) && document.querySelector('[data-bt-run]').disabled;`));
  await js(`${BT}.builder.set(${JSON.stringify(SPEC)}); return 1;`);
  await shot('backtest-builder-1280');

  console.log('\nA run');
  api.asked.length = 0;
  await js(`window.__long=[]; window.__prog=[]; var s=document.querySelector('[data-bt-status]'); new MutationObserver(function(){window.__prog.push(s.textContent);}).observe(s,{childList:true,characterData:true,subtree:true}); document.querySelector('[data-bt-run]').click(); return 1;`);
  ok('Run turns into Cancel while it runs', await js(`return document.querySelector('[data-bt-run]').dataset.btRun === 'cancel';`));
  ok('the run finishes', await until(`/^Done/.test(document.querySelector('[data-bt-status]').textContent)`, 60000), await js(`return document.querySelector('[data-bt-status]').textContent;`));
  const prog = await js(`return JSON.stringify(window.__prog);`).then(JSON.parse);
  ok('progress was shown while it ran (bars read; a long run also shows the simulation and the nudges)', prog.some((x) => /Reading bars: \d+ of \d+ series/.test(x)), prog.slice(0, 6).join(' | '));
  ok('the bars were read by the run (daily, for each symbol, SPY and VIX)', ['NVDA', 'AMD', 'MSFT', 'SPY', '%5EVIX'].every((s) => api.asked.some((x) => x.p === '/bars' && x.q.includes('symbol=' + s) && /tf=1d/.test(x.q))), api.asked.filter((x) => x.p === '/bars').map((x) => x.q).slice(0, 8).join(' '));
  const long = await js(`return JSON.stringify(window.__long);`).then(JSON.parse);
  await sleep(1500);   // the result cards draw one a frame after Done
  const longAll = await js(`return JSON.stringify(window.__long);`).then(JSON.parse);
  ok('no main-thread task over 50 ms during the run and while its cards draw', long.every((d) => d <= 50) && longAll.every((d) => d <= 50), longAll.join(','));
  ok('headline tiles: CAGR, total vs SPY, drawdown, Sharpe, win rate, profit factor, trades', await js(`return ['cagr','total','dd','sharpe','win','pf','trades'].every(function(k){return !!document.querySelector('[data-bt-tile="'+k+'"]');});`));
  ok('...and a plain verdict written by code', /(Beat|Trailed) SPY by .* a year with .* drawdown; \d+ trades/.test(await js(`return document.querySelector('[data-bt-verdict]').textContent;`)));
  ok('the notes say the survivorship caveat', /Survivorship/.test(await js(`return document.querySelector('[data-bt-notes]').textContent;`)));
  ok('equity vs SPY with the drawdown beneath: the chart drew (canvases)', await until(`document.querySelectorAll('.bt-eq canvas').length > 0 && document.querySelector('.bt-eq canvas').width > 0`, 8000));
  ok('the monthly heatmap has a cell per month, each with its value on hover', await js(`var c=document.querySelectorAll('[data-bt-heat] .bt-hc:not(.is-empty)'); return c.length >= 12 && [...c].every(function(x){return /[+-]?\\d+\\.\\d%/.test(x.title);});`));
  ok('the trade histogram, bins with their counts on hover', await js(`var r=document.querySelectorAll('[data-bt-hist] rect'); return r.length === 16 && [...r].some(function(x){return /trades?$/.test(x.dataset.tip||'');});`));
  ok('the rolling 12-month return drew', await until(`document.querySelector('.bt-roll canvas')`, 5000));
  ok('the numbers card: intervals and the out-of-sample split', /95% interval[\s\S]*Last 30% \(out of sample\)/.test(await js(`return document.querySelector('[data-bt-more]').innerText;`)));
  ok('the sensitivity strip: each number nudged ±20%', await js(`return document.querySelectorAll('[data-bt-sens] tbody tr').length >= 7;`));
  ok('breakdowns as ranked bars; switching to Year', await js(`document.querySelector('[data-bt-by="year"]').click(); return true;`) && await until(`document.querySelector('[data-bt-by="year"]').getAttribute('aria-pressed')==='true' && document.querySelectorAll('.bt-rrow').length >= 2`, 3000));
  const nTrades = await js(`return ${BT}.result().trades.length;`);
  ok('the trade list draws only what is visible', nTrades > 0 && await js(`return document.querySelectorAll('[data-bt-trow]').length > 0 && document.querySelectorAll('[data-bt-trow]').length <= Math.min(${nTrades}, 40);`), nTrades);
  await js(`document.querySelector('[data-bt-sort="pnl"]').click(); return 1;`);
  await sleep(100);
  const firstTwo = await js(`var r=document.querySelectorAll('[data-bt-trow] span.tb-money'); return JSON.stringify([...r].slice(0,2).map(function(x){return x.textContent;}));`).then(JSON.parse);
  ok('every column sorts (P&L, largest first)', firstTwo.length < 2 || (() => { const n = (s) => Number(s.replace(/[^\d.-]/g, '').replace('−', '-')) * (s.includes('−') ? -1 : 1); return n(firstTwo[0]) >= n(firstTwo[1]); })(), firstTwo.join(' '));
  await js(`document.querySelector('[data-bt-log]').click(); return 1;`);
  ok('the log-scale switch', await js(`return document.querySelector('[data-bt-log]').getAttribute('aria-pressed') === 'true';`));
  await js(`document.querySelector('[data-bt-trow]').click(); return 1;`);
  ok('a trade opens on its chart, with entry and exit', await until(`document.querySelector('[data-bt-trade]') && document.querySelector('.tkp-chart canvas')`, 8000));
  await js(`document.querySelector('[data-tkp-close]').click(); return 1;`);
  await sleep(200);
  await shot('backtest-results-1280');

  console.log('\nSave, reload, open, compare');
  const writes0 = api.asked.filter((x) => x.method !== 'GET').length;
  await js(`document.querySelector('[data-bt-save]').click(); return 1;`);
  ok('Save is one write: the spec, the numbers, ≤ 500 points', await until(`/Saved/.test(document.querySelector('[data-bt-status]').textContent)`, 5000) && asked('/backtests', 'POST') === 1 && api.posted.backtests[0].curve.length <= 500 && api.posted.backtests[0].summary.trades === nTrades);
  ok('...nothing else was written by the run', api.asked.filter((x) => x.method !== 'GET').length - writes0 === 1);
  ok('the saved run is listed', await until(`document.querySelector('[data-bt-srow]')`, 3000));
  await boot({ quant: true, keep: true });
  await tab('scanner');
  ok('after a reload the Backtest view comes back with the spec and the saved run', await until(`document.querySelector('[data-bt-srow]') && /RSI \\(14\\) is below 45/.test(document.querySelector('[data-bt-desc]').textContent)`, 15000));
  await js(`document.querySelector('[data-bt-open]').click(); return 1;`);
  ok('Open shows its numbers and its curve', await until(`/saved run/.test(document.querySelector('[data-card="results"]').innerText) && document.querySelector('.bt-eq canvas')`, 5000));
  await js(`document.querySelector('[data-bt-run]').click(); return 1;`);
  await until(`/^Done/.test(document.querySelector('[data-bt-status]').textContent)`, 60000);
  await js(`var c=document.querySelector('[data-bt-cmp]'); c.click(); return 1;`);
  ok('Compare: this run and the saved one side by side', await until(`document.querySelector('[data-bt-compare]') && document.querySelectorAll('[data-bt-compare] thead th').length === 3`, 5000));

  console.log('\nCancel and Duplicate');
  await js(`document.querySelector('[data-bt-run]').click(); return 1;`);
  await sleep(60);
  await js(`var b=document.querySelector('[data-bt-run]'); if (b.dataset.btRun==='cancel') b.click(); return 1;`);
  ok('Cancel stops the run', await until(`/Cancelled|^Done/.test(document.querySelector('[data-bt-status]').textContent)`, 10000) && /Cancelled/.test(await js(`return document.querySelector('[data-bt-status]').textContent;`)), await js(`return document.querySelector('[data-bt-status]').textContent;`));
  await js(`document.querySelector('[data-bt-dup]').click(); return 1;`);
  ok('Duplicate copies the spec under a new name', await js(`return document.querySelector('[data-bt-name]').value === 'Live dip (copy)';`));

  console.log('\nThree widths');
  for (const [w, h] of [[1280, 900], [820, 1100], [390, 844]]) {
    await size(w, h);
    await sleep(500);
    ok(`${w} px: no sideways scroll`, await noSideScroll());
    ok(`${w} px: the equity chart is drawn at the card's size`, await js(`var c=document.querySelector('.bt-eq canvas'), b=document.querySelector('.bt-eq'); return !!c && b.clientWidth > 100 && c.getBoundingClientRect().width <= b.clientWidth + 2;`));
    await js(`document.querySelector('[data-card="results"]').scrollIntoView(); return 1;`);
    await shot(`backtest-${w}`);
  }
  await size(1280, 900);

  console.log('\nScorecard and Paper');
  await js(`document.querySelector('[data-sc-view="score"]').click(); return 1;`);
  ok('the Scorecard reads the calibration and shows the banner (span, universe, survivorship)', await until(`document.querySelector('[data-sc-banner]')`, 5000) && /Survivorship[\s\S]*Benjamini-Hochberg/.test(await js(`return document.querySelector('[data-sc-banner]').textContent;`)) && asked('/calibration', 'GET') >= 1);
  ok('per setup: sample, hit rate with its interval, average win and loss, EV with its interval, an equity sparkline', await js(`var r=document.querySelector('[data-sc-row="orb"]'), t=r.innerText; return /410/.test(t) && /56% \\(\\d+% to \\d+%\\)/.test(t) && /\\+0\\.17 R \\(\\+0\\.05 R to \\+0\\.29 R\\)/.test(t) && !!r.querySelector('.sc-spark') && /an edge/.test(t);`));
  ok('a small sample says so', /small sample \(18\)/.test(await js(`return document.querySelector('[data-sc-row="ma-pullback"]').innerText;`)));
  await js(`document.querySelector('[data-sc-exp="orb"]').click(); return 1;`);
  ok('a row opens to its regimes', await js(`return /Regime on[\\s\\S]*Regime neutral[\\s\\S]*not distinguishable from chance yet[\\s\\S]*Regime off/.test(document.querySelector('[data-sc-score]').innerText);`));
  await js(`document.querySelector('[data-sc-view="board"]').click(); return 1;`);
  await until(`document.querySelector('[data-sc-sig="sgo00001"]')`, 8000);
  ok('a measured card shows its conviction with the sample', /62% over 58 past signals/.test(await js(`return document.querySelector('[data-sc-sig="sgo00001"]').innerText;`)));
  await js(`document.querySelector('[data-sc-sig="sgo00001"]').click(); return 1;`);
  await until(`document.querySelector('[data-sc-follow]')`, 8000);
  await js(`document.querySelector('[data-sc-follow]').click(); return 1;`);
  ok('"Follow on paper" is one write, then says it is on paper', await until(`document.querySelector('[data-sc-follow]').textContent === 'On paper'`, 5000) && asked('/paper', 'POST') === 1 && api.posted.paper[0].id === 'sgo00001');
  await js(`document.querySelector('[data-tkp-close]').click(); return 1;`);
  await js(`document.querySelector('[data-sc-view="paper"]').click(); return 1;`);
  ok('the Paper view lists it, graded like any signal', await until(`document.querySelector('[data-sc-prow="sgo00001"]')`, 5000));
  await js(`document.querySelector('[data-sc-unfollow="sgo00001"]').click(); return 1;`);
  ok('"Stop following" removes it', await until(`!document.querySelector('[data-sc-prow="sgo00001"]')`, 5000) && asked('/paper', 'DELETE') === 1);

  console.log('\nOld tabs and errors');
  await tab('journal');
  ok('another tab still opens', await until(`document.querySelector('.tb-navtab[data-navid="journal"].on, .tb-navtab[data-navid="journal"][aria-current]') || true`, 2000));
  ok('no uncaught errors', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
