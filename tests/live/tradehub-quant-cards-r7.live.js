// TradeHub Quant refinements R7 (A1-Priv docs/TradeHub/quant/r1-07.md): the
// three new cards in the real page, quant-api played here.
//
//   1. Charts: Analysis and Key Stats follow the open chart; the Heat Map waits in "Add card"
//   2. Market: the Heat Map (sized by cap, coloured by the day), by sector / industry, all / my
//      sectors, synced in market_prefs; a tile click opens Charts on it
//   3. Paper: the cards follow the position
//   4. Yahoo down: the heat map says so; the cards fall back or say there is no coverage
//   5. Neo Quant reads them and sets the heat map
//   6. 1280, 820 and 390 px: no sideways scroll, the cards inside the grid
//
// Run: node tests/live/tradehub-quant-cards-r7.live.js   (own CDP_PORT)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const DESK_W = 1280 + 224, TAB_W = 820 + 224;

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab } = driver(c);
  const card = (id) => `document.querySelector('.lay-card[data-card="${id}"]')`;
  const A = card('analysis'), K = card('stats'), H = card('heatmap');
  const addOpts = () => js(`var s=document.querySelector('[data-lay-add]'); return s ? [...s.options].map(function(o){return o.value;}).filter(Boolean).join(',') : '';`);
  const prefs = () => js(`return JSON.stringify((window.__fakeFs.docs['dashboards/tradehub_layout']||{}).market_prefs||null);`);

  console.log('\n1. Charts');
  await size(DESK_W, 1000);
  await boot({ quant: true });
  await tab('charts');
  ok('Analysis and Key Stats are on the tab', await until(`${A} && ${K}`, 15000));
  ok('Analysis: Strong Buy, 24 analysts, the five buckets', await until(`${A}.querySelector('[data-sk-rec="strong_buy"]') && ${A}.querySelectorAll('[data-sk-bucket]').length === 5 && /24 analysts/.test(${A}.innerText)`, 15000),
    await js(`return ${A} ? ${A}.innerText.slice(0, 300) : 'no card';`));
  ok('...the price target: low 870.00, average 2,047.38, high 3,000.00, and the price', await js(`return ${A}.querySelector('[data-sk-low]').innerText === '870.00' && ${A}.querySelector('[data-sk-mean]').innerText === '2,047.38' && ${A}.querySelector('[data-sk-high]').innerText === '3,000.00' && ${A}.querySelector('[data-sk-price]').innerText !== '—';`));
  ok('...its source and when it was read', await js(`return /Source: Yahoo Finance · updated .+ \\(2h ago\\)/.test(${A}.querySelector('[data-sk-src]').innerText);`), await js(`return ${A}.querySelector('[data-sk-src]').innerText;`));
  ok('Key Stats: market cap $109.80B, P/E 6.17, float 140.39M, next earnings', await js(`var g=function(k){var e=${K}.querySelector('[data-sk-stat="'+k+'"]'); return e ? e.innerText : '';}; return /\\$109\\.80B/.test(g('marketCap')) && /6\\.17/.test(g('peTtm')) && /140\\.39M/.test(g('float')) && /01\/28\//.test(g('nextEarnings'));`),
    await js(`return ${K} ? ${K}.innerText.slice(0, 400) : 'no card';`));
  ok('...the day from the chart\'s bars (open marked live), turnover worked out', await until(`(function(){var e=${K}.querySelector('[data-sk-stat="open"]'); var t=${K}.querySelector('[data-sk-stat="turnover"]'); return e && e.title === 'From live quote' && t && /\\$/.test(t.innerText);})()`, 15000),
    await js(`var e=${K}.querySelector('[data-sk-stat="open"]'); return e ? e.title + ' ' + e.innerText : 'none';`));
  ok('the Heat Map waits in "Add card"', /heatmap/.test(await addOpts()) && !(await js(`return !!${H};`)), await addOpts());
  const first = await js(`return window._tbOps.charts.get().symbol;`);
  await js(`window._tbOps.charts.open('AMD'); 1`);
  ok('another ticker on the chart: both cards follow it', await until(`/AMD Corporation/.test(${K}.innerText)`, 10000) && JSON.parse(await js(`return JSON.stringify(window._tbOps.charts.stock.analysis().symbol);`)) === 'AMD', first);
  ok('...each card has its "?"', await js(`return ['analysis','stats'].every(function(id){ var b=document.querySelector('.lay-card[data-card="'+id+'"] .lay-help'); return b && (b.title||b.getAttribute('aria-label')||'').length > 30; });`),
    await js(`var b=document.querySelector('.lay-card[data-card="analysis"] .lay-help'); return b ? b.outerHTML.slice(0,200) : 'no help button';`));

  console.log('\n2. Market');
  await tab('market');
  // R7 review (perf): the tiles are drawn on one canvas; the test reads the drawn boxes (el.__hm.tiles()) and the
  // card's state, and hovers / clicks with real mouse events at a tile's centre.
  const T = `${H}.querySelector('[data-hm]').__hm.tiles()`;
  const G = `window._tbOps.market.stock.heatmap().groups`;
  const centre = async (sym) => JSON.parse(await js(`var c=${H}.querySelector('[data-hm-canvas]').getBoundingClientRect(), t=${T}.find(function(x){return x.sym==='${sym}';}); return JSON.stringify(t ? { x: c.left + t.x + t.w / 2, y: c.top + t.y + t.h / 2 } : null);`));
  ok('the Heat Map is on Market, a tile for every stock (S&P 500 + the watchlist), on one canvas', await until(`${H} && ${H}.querySelector('[data-hm-canvas]') && ${T}.length > 480 && !${H}.querySelector('[data-hm-t]')`, 20000), await js(`return ${H} ? ${H}.innerText.slice(0, 200) : 'no card';`));
  ok('...asked in ONE request', JSON.stringify(api.state.heatAsked || []) === '[' + (api.state.heatAsked || [0])[0] + ']' && (api.state.heatAsked || [0])[0] > 500, JSON.stringify(api.state.heatAsked));
  ok('...grouped by sector, Technology first (NVDA and AAPL are the biggest tiles)', await js(`var g=${G}; return g.length === 11 && g[0].name === 'Technology';`), await js(`return ${G}.map(function(g){return g.name;}).join(',');`));
  ok('...sized by cap: NVDA\'s tile is the biggest', await js(`var t=${T}.sort(function(a,b){return b.w*b.h-a.w*a.h;}); return t[0].sym === 'NVDA';`));
  ok('...coloured green and red by the day (and the canvas really painted them)', await js(`var t=${T}; if (!(t.some(function(x){return /108,203,138/.test(x.color);}) && t.some(function(x){return /236,115,101/.test(x.color);}))) return false; var cv=${H}.querySelector('[data-hm-canvas]'), d=window.devicePixelRatio||1, n=t.find(function(x){return x.sym==='NVDA';}); var px=cv.getContext('2d').getImageData(Math.round((n.x+3)*d), Math.round((n.y+n.h-3)*d), 1, 1).data; return px[1] > px[0] && px[3] > 0;`));
  ok('...the tiles stay inside the card', await js(`var b=${H}.querySelector('[data-hm-box]').getBoundingClientRect(); return ${T}.every(function(t){ return t.x >= -1 && t.y >= -1 && t.x + t.w <= b.width + 1 && t.y + t.h <= b.height + 1; });`));
  await js(`${H}.scrollIntoView({ block: 'center' }); 1`); await sleep(300);
  { const p = await centre('NVDA'); await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await sleep(200); }
  ok('hovering a tile shows its numbers', await js(`return /NVDA/.test(${H}.querySelector('[data-hm-info]').innerText) && /market cap .4\.50T/.test(${H}.querySelector('[data-hm-info]').innerText);`), await js(`var i=${H}.querySelector('[data-hm-info]'), sp=i.querySelector('span'); return JSON.stringify([i.innerText, sp && getComputedStyle(sp).display, sp && sp.getBoundingClientRect().width, i.getBoundingClientRect().height, getComputedStyle(i).overflow]);`));
  await js(`${H}.querySelector('[data-hm-group="industry"]').click(); 1`);
  ok('Industries: many more groups, Semiconductors among them', await until(`${G}.length > 50 && ${G}.some(function(g){return g.name==='Semiconductors';})`, 3000));
  ok('...synced in the layout doc (market_prefs.heatGroup)', await until(`((window.__fakeFs.docs['dashboards/tradehub_layout']||{}).market_prefs||{}).heatGroup === 'industry'`, 5000), await prefs());
  await js(`${H}.querySelector('[data-hm-scope="mine"]').click(); 1`);
  ok('My sectors: fewer stocks, only the watchlist\'s sectors, with no new request', await until(`${T}.length > 0 && ${T}.length < 480`, 8000) && (api.state.heatAsked || []).length === 1, await js(`return ${T}.length;`) + ' / ' + JSON.stringify(api.state.heatAsked));
  await sleep(1200);
  await boot({ keep: true }); await tab('market');
  ok('...both picks kept after a reload', await until(`${H} && ${H}.querySelector('[data-hm-group="industry"]').getAttribute('aria-pressed') === 'true' && ${H}.querySelector('[data-hm-scope="mine"]').getAttribute('aria-pressed') === 'true'`, 15000));
  ok('B6 (ask 39): Analysis and Key Stats are not offered in Market\'s "Add card"', !/analysis/.test(await addOpts()) && !/stats/.test(await addOpts()), await addOpts());
  await until(`${T}.length > 0`, 10000);
  await js(`${H}.scrollIntoView({ block: 'center' }); 1`); await sleep(300);
  const someTile = await js(`return ${T}.sort(function(a,b){return b.w*b.h-a.w*a.h;})[0].sym;`);
  { const p = await centre(someTile); await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }); }
  ok('a click on a tile opens it on Charts', await until(`window._tbOps.charts && window._tbOps.charts.get().symbol === '${someTile}'`, 10000), someTile + ' / ' + await js(`return window._tbOps.charts ? window._tbOps.charts.get().symbol : 'charts not open';`));

  console.log('\n3. Paper');
  await tab('paper');
  ok('Analysis and Key Stats follow the open position (NVDA)', await until(`${K} && /NVDA Corporation/.test(${K}.innerText) && ${A}.querySelector('[data-sk-rec]')`, 15000), await js(`return ${K} ? ${K}.innerText.slice(0, 120) : 'no card';`));
  ok('...the position\'s ticker is a bordered button that picks it', await js(`var b=document.querySelector('[data-pp-sym="NVDA"]'); return b && b.tagName === 'BUTTON' && getComputedStyle(b).borderTopStyle === 'solid' && b.classList.contains('is-on');`));

  console.log('\n4. Yahoo down');
  api.state.heatDown = true; api.state.summaryDown = true;
  await boot({ keep: true }); await tab('market');
  ok('the heat map says Yahoo did not answer (nothing made up)', await until(`${H} && /could not be read: .*needs Yahoo/.test(${H}.innerText) && !${H}.querySelector('[data-hm-canvas]')`, 15000), await js(`return ${H} ? ${H}.innerText.slice(0, 200) : 'no card';`));
  await tab('charts');
  ok('Analysis with no Yahoo and no dossier: one plain line', await until(`${A} && /No analyst coverage found for/.test(${A}.innerText)`, 15000), await js(`return ${A} ? ${A}.innerText : 'no card';`));
  api.state.heatDown = false; api.state.summaryDown = false;

  console.log('\n5. Neo Quant');
  await boot({ keep: true }); await tab('charts');
  await until(`${A} && ${A}.querySelector('[data-sk-rec]')`, 15000);
  const rd = JSON.parse(await js(`var R=(await import('/A1/TradeHub/neo/registry.js')).Registry; return JSON.stringify(await R.get('stock').readers.analysis.read({}));`));
  ok('the analysis reader answers what the card shows', rd.rating && rd.rating.label === 'Strong Buy' && rd.target && rd.target.mean === 2047.375, JSON.stringify(rd).slice(0, 200));
  const ks = JSON.parse(await js(`var R=(await import('/A1/TradeHub/neo/registry.js')).Registry; return JSON.stringify(await R.get('stock').readers.keyStats.read({ symbol: 'MSFT' }));`));
  ok('...key stats for another ticker (read, not shown)', ks.symbol === 'MSFT' && ks.stats && ks.stats.peTtm === 6.17, JSON.stringify(ks).slice(0, 200));
  const said = JSON.parse(await js(`var R=(await import('/A1/TradeHub/neo/registry.js')).Registry; return JSON.stringify(await R.get('stock').actions.heatmap.run({ group: 'sector', scope: 'all' }));`));
  ok('"heat map by sector, all sectors" goes to Market and sets both', await until(`${H} && ${H}.querySelector('[data-hm-group="sector"]').getAttribute('aria-pressed') === 'true' && ${H}.querySelector('[data-hm-scope="all"]').getAttribute('aria-pressed') === 'true'`, 10000) && /by sector/.test(said.shown || ''), JSON.stringify(said).slice(0, 200));

  console.log('\n6. Every width');
  for (const [w, hgt, name] of [[DESK_W, 900, 'desktop'], [TAB_W, 1000, 'tablet'], [390, 844, 'phone']]) {
    await size(w, hgt); await sleep(900);
    for (const t of ['market', 'charts']) {
      await tab(t); await sleep(900);
      const ids = t === 'market' ? ['heatmap'] : ['analysis', 'stats'];
      await until(ids.map((id) => card(id)).join(' && '), 10000);
      ok(`${name} ${t}: no sideways scroll, ${ids.join(' + ')} inside the page`, await js(`var W=document.documentElement.clientWidth; return document.documentElement.scrollWidth <= W + 1 && ${JSON.stringify(ids)}.every(function(id){ var e=document.querySelector('.lay-card[data-card="'+id+'"]'); var r=e.getBoundingClientRect(); return r.width > 200 && r.right <= W + 1; });`),
        await js(`return document.documentElement.scrollWidth + ' / ' + document.documentElement.clientWidth;`));
      if (t === 'charts') ok(`${name}: the stats' values do not spill out of their cells`, await js(`return [...${K}.querySelectorAll('.sk-stat b')].every(function(b){ return b.scrollWidth <= b.clientWidth + 1 || b.clientWidth > 50; });`));
      if (t === 'market') ok(`${name}: the heat map has tiles and a real size`, await until(`${H}.querySelector('[data-hm]').__hm.tiles().length > 400 && ${H}.querySelector('[data-hm-box]').getBoundingClientRect().height >= 170`, 8000), await js(`return ${H}.querySelector('[data-hm-box]').getBoundingClientRect().height;`));
    }
  }

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
