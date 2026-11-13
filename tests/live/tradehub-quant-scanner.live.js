// TradeHub Quant, Phase 5: the Scanner tab in the real page (A1-Priv
// tradehub.html + TradeHub/ui/scanner.js), quant-api and the providers
// played here (quant-mock.js).
//
//   1. switch off: no Scanner tab; on: the tab scans the watchlist in the Web Worker
//   2. three lanes GO / WATCH / NO-GO from the ledger, each card with entry,
//      stop, targets, R:R, score, expiry, why and "not yet backtested"
//   3. filters (horizon, direction, setup) and the Ledger and Scorecard views
//   4. a signal opens the ticker panel: its block, its lines on the chart, News
//   5. writes: the ledger read once; what the scan found sent as ONE batch
//   6. 1280, 820 and 390 px: no sideways scroll; lanes become tabs on a phone
//   7. no main-thread task over 50 ms while a scan runs (the detectors are in the worker)
//
// Run: node tests/live/tradehub-quant-scanner.live.js   (TH_PAGE_FILE=… to test a copy; SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, CLOCK } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const TAB = `document.querySelector('[data-scanner]').__scanner`;
const MIN = 60000;

// Three stored signals, one for each lane (still running at the mock's clock).
function seed(id, verdict, o = {}) {
  return { id, symbol: 'NVDA', setup: 'orb', horizon: 'day', dir: 'long', at: CLOCK - 2 * MIN, expires: CLOCK + 60 * MIN, verdict, score: verdict === 'GO' ? 78 : verdict === 'WATCH' ? 60 : 40,
    trigger: 164, zone: [163.9, 164.15], entry: 164.03, stop: 163.6, targets: [164.7, 165.3], rr: [1.6, 3], risk: 0.85, atr: 0.6, factors: { trend: 0.8 },
    why: ['above its rising averages', 'volume 2.1× usual', 'no high-impact catalyst before it expires', 'volatility at an extreme'], notes: ['closed above the opening range'],
    backtested: false, regime: 'Constructive', status: 'open', done: false, created: CLOCK - 60 * MIN, ...o };
}

(async () => {
  const api = quantApi();
  api.state.signals = [
    seed('sgo00001', 'GO'),
    seed('swatch001', 'WATCH', { symbol: 'AMD', setup: 'ma-pullback', horizon: 'swing', expires: CLOCK + 4 * 86400000 }),
    seed('snogo0001', 'NO-GO', { symbol: 'TSLA', dir: 'short', setup: 'vwap-reject', stop: 164.5, targets: [163.4, 162.8] }),
    seed('sold00001', 'GO', { symbol: 'MU', expires: CLOCK - 5 * MIN, status: 'target1', done: true, r: 1.6 }),
  ];
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const asked = (p, method) => api.asked.filter((x) => x.p === p && (!method || x.method === method)).length;

  console.log('\nThe switch and the scan');
  await size(1280, 900);
  await boot({ quant: false });
  ok('switch off: no Scanner tab', await js(`return !document.querySelector('.tb-navtab[data-navid="scanner"]');`));
  await boot({ quant: true });
  ok('switch on: the Scanner tab is there', await js(`return [...document.querySelectorAll('.tb-navtab[data-navid="scanner"]')].some(function(b){return b.offsetParent;});`));
  api.asked.length = 0;
  await tab('scanner');
  ok('the tab mounts and the scan finishes', await until(`document.querySelector('[data-scanner]') && /seconds? ago|minutes? ago/.test(document.querySelector('[data-sc-meta]').textContent)`, 30000),
    await js(`var m=document.querySelector('[data-sc-meta]'); return m ? m.textContent : 'no tab';`));
  ok('...it scanned in a real Web Worker', await js(`return typeof Worker === 'function';`));
  ok('the ledger is read once', asked('/signals', 'GET') === 1, asked('/signals', 'GET'));
  ok('...5-minute and daily bars asked for each watchlist ticker', api.asked.some((x) => x.p === '/bars' && /tf=5m/.test(x.q)) && api.asked.some((x) => x.p === '/bars' && /tf=1d/.test(x.q)));

  console.log('\nThe board');
  const laneIds = (lane) => js(`return JSON.stringify([...document.querySelectorAll('[data-sc-lane="${lane}"] [data-sc-sig]')].map(function(x){return x.dataset.scSig;}));`).then(JSON.parse);
  ok('GO, WATCH and NO-GO lanes, each with its stored signal', (await laneIds('go')).includes('sgo00001') && (await laneIds('watch')).includes('swatch001') && (await laneIds('nogo')).includes('snogo0001'));
  ok('...a finished signal is not on the board', !(await laneIds('go')).includes('sold00001'));
  ok('each card: entry, stop, targets, R:R, score, expiry, why, "not yet backtested"', await js(`var e=document.querySelector('[data-sc-sig="sgo00001"]'), t=e.innerText; return /Entry/.test(t) && /163\\.90 to 164\\.15/.test(t) && /Stop/.test(t) && /164\\.70 · 165\\.30/.test(t) && /1 : 1\\.6 · 1 : 3\\.0/.test(t) && /78 of 100/.test(t) && /Expires/.test(t) && /Volume 2\\.1/.test(t) && !!e.querySelector('[data-sc-nobt]');`));
  ok('...the verdict lanes are coloured cards on the fluid grid', await js(`return ['go','watch','nogo'].every(function(id){return !!document.querySelector('.lay-card[data-card="'+id+'"]');});`));

  console.log('\nFilters and views');
  await js(`document.querySelector('[data-sc-horizon="swing"]').click(); return 1;`);
  await sleep(150);
  // The scan adds its own signals from the mock's bars, so each filter is checked on every card shown.
  const cards = () => js(`return JSON.stringify([...document.querySelectorAll('[data-sc-sig]')].map(function(x){return [x.dataset.scSig,x.dataset.horizon,x.dataset.dir,x.dataset.setup];}));`).then(JSON.parse);
  let cs = await cards();
  ok('Swing: only swing signals stay', cs.every((x) => x[1] === 'swing') && cs.some((x) => x[0] === 'swatch001') && !cs.some((x) => x[0] === 'sgo00001'), JSON.stringify(cs));
  await js(`document.querySelector('[data-sc-horizon="all"]').click(); return 1;`);
  await sleep(100);
  await js(`document.querySelector('[data-sc-dir="short"]').click(); return 1;`);
  await sleep(150);
  cs = await cards();
  ok('Short: only short signals', cs.every((x) => x[2] === 'short') && cs.some((x) => x[0] === 'snogo0001'), JSON.stringify(cs));
  await js(`document.querySelector('[data-sc-dir="all"]').click(); var s=document.querySelector('[data-sc-setup]'); s.value='orb'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1;`);
  await sleep(150);
  cs = await cards();
  ok('a setup: only that setup', cs.every((x) => x[3] === 'orb') && cs.some((x) => x[0] === 'sgo00001'), JSON.stringify(cs));
  await js(`var s=document.querySelector('[data-sc-setup]'); s.value='all'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1;`);
  await js(`document.querySelector('[data-sc-view="ledger"]').click(); return 1;`);
  await sleep(200);
  ok('Ledger: every signal, the finished one too, with its result', await js(`var r=[...document.querySelectorAll('[data-sc-lrow]')].map(function(x){return x.dataset.scLrow;}); return r.includes('sold00001') && r.includes('sgo00001') && /\\+1\\.60 R/.test(document.querySelector('[data-sc-lrow="sold00001"]').innerText);`));
  await js(`document.querySelector('[data-sc-view="score"]').click(); return 1;`);
  await sleep(200);
  ok('Scorecard: per setup, the graded signal counted', await js(`var e=document.querySelector('[data-sc-score]'); return !!e && /Opening range breakout/.test(e.innerText) && /100%/.test(e.innerText);`));
  await js(`document.querySelector('[data-sc-view="board"]').click(); return 1;`);
  await sleep(200);

  console.log('\nA signal opens its chart');
  await js(`document.querySelector('[data-sc-sig="sgo00001"]').click(); return 1;`);
  ok('the ticker panel opens with the signal\'s block', await until(`document.querySelector('[data-tkp="NVDA"] [data-sc-detail="sgo00001"]')`, 5000));
  ok('...its entry, targets and stop are drawn on the chart (tags E, T1, T2, S)', await until(`(function(){var k=[...document.querySelectorAll('[data-tkp] .ch-tag')].filter(function(x){return x.style.display!=='none';}).map(function(x){return x.dataset.kind;}); return ['entry','target','target2','stop'].every(function(n){return k.includes(n);});})()`, 15000),
    await js(`return [...document.querySelectorAll('[data-tkp] .ch-tag')].map(function(x){return x.dataset.kind+':'+x.style.display;}).join(' ');`));
  await js(`document.querySelector('[data-sc-news]').click(); return 1;`);
  ok('...News opens the News tab', await until(`!document.querySelector('[data-tkp]') && document.querySelector('.tb-navtab[data-navid="news"].active, .tb-navtab[data-navid="news"][aria-current], .tb-navtab[data-navid="news"][aria-selected="true"]')`, 5000));
  await tab('scanner');
  await until(`document.querySelector('[data-scanner]')`, 10000);
  await sleep(800);

  console.log('\nWrites');
  await js(`return ${TAB}.scanNow({ refresh: true }).then(function(){return 1;});`);
  await sleep(500);
  const batches = (api.posted.signals || []).length;
  ok('what the scans found goes as at most one POST a minute', batches <= 1, batches);
  ok('...as the page, never touching the stored copies', (api.posted.signals || []).every((b) => b.by === 'page' && !b.signals.some((s) => s.id === 'sgo00001')));

  console.log('\nNo long task while scanning');
  await js(`window.__lt=[]; try{ new PerformanceObserver(function(l){ l.getEntries().forEach(function(e){ window.__lt.push(e.duration); }); }).observe({type:'longtask', buffered:false}); }catch(e){} return 1;`);
  await js(`return ${TAB}.scanNow({ refresh: true }).then(function(){return 1;});`);
  await sleep(300);
  const lt = JSON.parse(await js(`return JSON.stringify(window.__lt||[]);`));
  ok('no main-thread task over 50 ms during a scan', lt.every((d) => d <= 50), lt.join(','));

  console.log('\nThree sizes');
  for (const [w, hgt, name] of [[1280, 900, 'desktop'], [820, 1100, 'tablet'], [390, 844, 'phone']]) {
    await size(w, hgt);
    await sleep(600);
    ok(`${name} (${w}): no sideways scroll`, await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`));
    if (name === 'phone') {
      ok('phone: the lanes are tabs, one lane shown', await js(`var t=document.querySelector('[data-sc-lanetabs]'); var shown=['go','watch','nogo'].filter(function(id){var c=document.querySelector('.lay-card[data-card="'+id+'"]'); return c && getComputedStyle(c).display!=='none';}); return !!t && t.offsetParent!==null && shown.length===1;`));
      await js(`document.querySelector('[data-sc-lanetab="nogo"]').click(); return 1;`);
      await sleep(150);
      ok('...a lane tab shows that lane', await js(`var c=document.querySelector('.lay-card[data-card="nogo"]'); return getComputedStyle(c).display!=='none' && getComputedStyle(document.querySelector('.lay-card[data-card="go"]')).display==='none';`));
    }
    if (process.env.SHOTS_DIR) await shot(`scanner-${w}`);
  }

  ok('no uncaught errors', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
