// TradeHub Quant, Phase 3: the switch and the Market tab in the real page
// (A1-Priv tradehub.html + TradeHub/ui/market.js), with quant-api and the
// providers' WebSockets played here (quant-mock.js).
//
//   1. switch off (the default): no Market tab, no TradeHub module fetched, no quant-api call
//   2. ticking the switch in Control brings the tab, on this device and in the dash doc
//   3. every card draws from the snapshot, for at most 3 quant-api requests
//   4. it fits at 1280, 820 and 390 px, each with its own grid
//   5. a live tick moves a sector tile; a ticker opens the shared panel
//   6. a layout change is kept across a reload and written once to ONE Firestore doc
//   7. no snapshot stored: the page builds it in the Web Worker and posts it
//   8. with the switch on, the morning check has the snapshot ready with no clicks
//
// Run: node tests/live/tradehub-quant-market.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, FIXTURE, WATCHLIST, KEY } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const CARDS = ['regime', 'breadth', 'sectors', 'rotation', 'streaks', 'strength', 'volume', 'analogs'];

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
  const { js, until, size, boot, tab, shot } = driver(c);
  const modules = () => js(`return performance.getEntriesByType('resource').map(function(r){return r.name;}).filter(function(n){return /\\/A1\\/TradeHub\\//.test(n);}).length;`);
  const paths = () => api.asked.map((a) => a.p);

  console.log('\nSwitch off (the default)');
  await size(1280, 900);
  await boot({ quant: false });
  ok('no Market tab', await js(`return !document.querySelector('.tb-navtab[data-navid="market"]');`));
  await tab('prompt');
  ok('Control has the switch, unticked', await until(`document.querySelector('.ctl-quant input[type=checkbox]') && !document.querySelector('.ctl-quant input[type=checkbox]').checked`, 8000));
  ok('...and no data status card', await js(`return !document.querySelector('.ctl-status');`));
  await sleep(1500);
  ok('no TradeHub module was fetched', (await modules()) === 0, await modules());
  ok('no quant-api call was made', api.asked.length === 0, paths().join());
  ok('tabs change with no motion class on the app', await js(`return !document.querySelector('.tbq-on');`));

  console.log('\nTurning it on');
  await js(`document.querySelector('.ctl-quant input[type=checkbox]').click(); 1`);
  ok('the Market tab appears', await until(`[...document.querySelectorAll('.tb-navtab[data-navid="market"]')].some(function(b){return b.offsetParent;})`, 5000));
  ok('the switch is kept on this device', await js(`return localStorage.getItem('tradehub_quant') === '1';`));
  ok('...and in the dash doc, as a merge', await until(`window.__fakeFs.docs['dashboards/tradeboard_dashboard'] && window.__fakeFs.docs['dashboards/tradeboard_dashboard'].quant === true`, 5000));
  ok('the data status card comes with it', await until(`document.querySelector('.ctl-status [data-qs]')`, 10000));

  console.log('\nThe Market tab');
  api.asked.length = 0;
  await boot({ quant: true });
  // The morning check reads the snapshot once at start; count the visit on its own.
  await until(`localStorage.getItem('tb_morning_market_slot')`, 15000);
  const before = api.asked.length;
  await tab('market');
  ok('the tab mounts', await until(`document.querySelector('[data-mk]')`, 10000));
  ok('every card renders from the snapshot', await until(`document.querySelector('[data-mk-score]') && document.querySelector('[data-mk-sectors]') && document.querySelector('[data-mk-streaks]') && document.querySelector('[data-mk-analogs]')`, 10000));
  await sleep(1200);
  const drawn = JSON.parse(await js(`var o={}; ${JSON.stringify(CARDS)}.forEach(function(id){ var b=document.querySelector('.lay-card[data-card="'+id+'"] .lay-body'); o[id]=b?b.innerText.replace(/\\s+/g,' ').slice(0,160):null; }); return JSON.stringify(o);`));
  ok('eight cards, none empty', CARDS.every((id) => drawn[id] && drawn[id].length > 20), JSON.stringify(drawn).slice(0, 400));
  ok('Regime: the score, the label and the day count', drawn.regime.includes(String(Math.round(FIXTURE.regime.score))) && drawn.regime.includes(FIXTURE.regime.label) && drawn.regime.includes('Day ' + FIXTURE.regime.since), drawn.regime);
  ok('...its four parts, credit marked as having no data', await js(`return document.querySelectorAll('.mk-part').length === 4 && document.querySelector('.mk-part[data-part="credit"]').classList.contains('is-missing') && /no data/.test(document.querySelector('.mk-part[data-part="credit"]').innerText);`));
  ok('Breadth: named for what it measures, three shares, advancers and decliners', /S&P 100/.test(drawn.breadth) && drawn.breadth.includes(Math.round(FIXTURE.breadth.above50 * 100) + '%') && drawn.breadth.includes(FIXTURE.breadth.adv + ' up'), drawn.breadth);
  ok('Sectors: 12 tiles', await js(`return document.querySelectorAll('[data-mk-sectors] .mk-tile').length === 12;`));
  ok('...a strong move is a filled tile, a small one tinted text', await js(`var t=[...document.querySelectorAll('.mk-tile')]; return t.every(function(e){ var v=Math.abs(parseFloat(e.querySelector('.mk-d1').textContent)); return isNaN(v) || (v>=1)===e.classList.contains('is-solid'); });`));
  ok('Rotation: 12 trails in four named, tinted quadrants', await js(`return document.querySelectorAll('.mk-rot .mk-rot-s').length === 12 && document.querySelectorAll('.mk-rot .mk-rot-q').length === 4 && document.querySelectorAll('.mk-rot .mk-rot-qf').length === 4;`));
  ok('...its legend lists every sector once, by quadrant', await js(`var c=[...document.querySelectorAll('[data-mk-rotlg] .mk-rotlg-chip')].map(function(e){return e.dataset.sym;}); return c.length === 12 && new Set(c).size === 12 && document.querySelectorAll('[data-mk-rotlg] .mk-rotlg-g').length === 4;`));
  const overlap = await js(`var r=[...document.querySelectorAll('.mk-rot .mk-rot-l')].map(function(e){return e.getBoundingClientRect();}), n=0; for (var i=0;i<r.length;i++) for (var j=i+1;j<r.length;j++) if (r[i].left<r[j].right-1&&r[j].left<r[i].right-1&&r[i].top<r[j].bottom-1&&r[j].top<r[i].bottom-1) n++; return n;`);
  ok('...no two sector names overlap', overlap === 0, overlap);
  await js(`document.querySelector('[data-mk-rotlg] .mk-rotlg-chip[data-sym="XLK"]').dispatchEvent(new PointerEvent('pointerover',{bubbles:true})); 1`);
  ok('...hovering a legend chip picks that sector out of the chart', await js(`return document.querySelector('.mk-rotwrap').classList.contains('has-focus') && document.querySelector('.mk-rot-s[data-sym="XLK"]').classList.contains('is-focus') && !document.querySelector('.mk-rot-s[data-sym="XLF"]').classList.contains('is-focus');`));
  await js(`document.querySelector('.mk-rotwrap').dispatchEvent(new PointerEvent('pointerleave')); 1`);
  ok('Streaks: indexes, sectors and the watchlist', await js(`var r=document.querySelectorAll('[data-mk-streaks] tbody tr'); return r.length === ${4 + 12 + WATCHLIST.length} && !!document.querySelector('[data-mk-streaks] tr[data-sym="SPY"]') && !!document.querySelector('[data-mk-streaks] tr[data-sym="${WATCHLIST[0]}"]');`),
    await js(`return document.querySelectorAll('[data-mk-streaks] tbody tr').length;`));
  ok('Relative strength: the watchlist, strongest first', await js(`var r=[...document.querySelectorAll('[data-mk-strength] tbody tr')]; var v=r.map(function(x){return parseFloat(x.children[2].textContent);}); return r.length === ${WATCHLIST.length} && v.every(function(x,i){return i===0||x<=v[i-1];});`));
  ok('Days like today: five days, an average and a count', await js(`return document.querySelectorAll('[data-mk-analogs] tbody tr[data-day]').length === 5 && /Average/.test(document.querySelector('[data-mk-analogs]').innerText) && /of 5/.test(document.querySelector('[data-mk-analogs]').innerText);`));
  const meta = await js(`return document.querySelector('[data-mk-meta]').innerText;`);
  ok('the meta line: as of, who built it, the bars\' day', /As of \d/.test(meta) && /scheduled runner/.test(meta) && /bars to/.test(meta), meta);
  ok('...with a freshness chip from the live stream, LIVE', await until(`document.querySelector('[data-mk-label]').dataset.mkLabel === 'LIVE'`, 6000), await js(`return document.querySelector('[data-mk-label]').dataset.mkLabel;`));
  const visit = api.asked.slice(before).map((a) => a.p);
  ok('the visit cost at most 3 quant-api requests', visit.length <= 3 && visit.includes('/snapshot') === false || (visit.length <= 3), visit.join());
  ok('...the snapshot was not read twice (the morning check already had it)', visit.filter((p) => p === '/snapshot').length === 0 && visit.includes('/quotes'), visit.join());
  ok('every request carried the key', api.asked.every((a) => a.auth === 'Bearer ' + KEY));

  console.log('\nLayouts');
  for (const [w, h, cls, cols] of [[1280, 900, 'desktop', 12], [820, 1180, 'tablet', 8], [390, 844, 'phone', 4]]) {
    await size(w, h); await sleep(700);
    const f = JSON.parse(await js(`var L=document.querySelector('.lay'), g=L.querySelector('.lay-grid'), r=g.getBoundingClientRect();
      var cards=[...g.children]; var spill=cards.filter(function(e){ var b=e.getBoundingClientRect(); return b.right>r.right+1||b.left<r.left-1; }).length;
      var inner=cards.filter(function(e){ var b=e.getBoundingClientRect(); return [...e.querySelectorAll('.lay-head *')].some(function(x){ var q=x.getBoundingClientRect(); return q.width>0&&(q.right>b.right+1||q.left<b.left-1); }); }).length;
      return JSON.stringify({ cls:L.dataset.cls, cols:getComputedStyle(g).gridTemplateColumns.split(' ').length, sw:document.documentElement.scrollWidth, iw:innerWidth, n:cards.length, spill:spill, inner:inner, widths:[...new Set(cards.map(function(e){return e.dataset.w;}))].join() });`));
    ok(`${w} px: the ${cls} grid, ${cols} columns, all 8 cards`, f.cls === cls && f.cols === cols && f.n === 8, JSON.stringify(f));
    ok(`${w} px: no sideways scroll, nothing spills`, f.sw <= f.iw && f.spill === 0 && f.inner === 0, JSON.stringify(f));
    if (cls === 'phone') ok('on a phone every card is one full-width column', f.widths === '4', f.widths);
    await js(`document.querySelector('.tb-scroll-visible').scrollTop = 0; 1`); await sleep(200);
    await shot('quant-market-' + w);
    await js(`document.querySelector('.lay-card[data-card="rotation"]').scrollIntoView({block:'start'}); 1`); await sleep(300);
    await shot('quant-market-' + w + '-b');
    await js(`document.querySelector('.lay-card[data-card="strength"]').scrollIntoView({block:'start'}); 1`); await sleep(300);
    await shot('quant-market-' + w + '-c');
  }
  await size(1280, 900); await sleep(600);
  await js(`document.querySelector('.tb-scroll-visible').scrollTop = 0; 1`);

  console.log('\nLive prices and the ticker panel');
  ok('the sector funds ride the stream', await until(`window.__ws.state.subs.has('XLK') && window.__ws.state.subs.has('SOXX')`, 6000), await js(`return [...window.__ws.state.subs].join();`));
  const xlk = FIXTURE.rows.XLK, base = FIXTURE.partial ? xlk.p : xlk.c;
  await js(`window.__ws.tick('XLK', ${(base * 1.025).toFixed(2)}); 1`);
  ok('a live tick moves the tile to +2.5% and fills it', await until(`/\\+2\\.5\\d%/.test(document.querySelector('.mk-tile[data-sym="XLK"] .mk-d1').textContent) && document.querySelector('.mk-tile[data-sym="XLK"]').classList.contains('is-solid') && document.querySelector('.mk-tile[data-sym="XLK"]').classList.contains('mk-up')`, 4000),
    await js(`return document.querySelector('.mk-tile[data-sym="XLK"]').outerHTML.slice(0,300);`));
  const box0 = await js(`var b=document.querySelector('.lay-card[data-card="sectors"]').getBoundingClientRect(); return b.left+','+b.top+','+b.width+','+b.height;`);
  await js(`window.__ws.tick('XLK', ${(base * 0.97).toFixed(2)}); window.__ws.tick('XLE', ${(FIXTURE.rows.XLE.p * 1.04).toFixed(2)}); 1`); await sleep(600);
  ok('...and nothing moved: the card is where it was, to the pixel', box0 === await js(`var b=document.querySelector('.lay-card[data-card="sectors"]').getBoundingClientRect(); return b.left+','+b.top+','+b.width+','+b.height;`));
  await js(`document.querySelector('[data-mk-streaks] tr[data-sym="SPY"] .mk-tk').click(); 1`);
  ok('a ticker opens the shared panel', await until(`document.querySelector('[data-tkp="SPY"] [data-tkp-price]')`, 4000));
  const panel = await js(`return document.querySelector('[data-tkp="SPY"]').innerText;`);
  ok('...with its price, provider, time and label', /\d+\.\d\d/.test(panel) && /alpaca/.test(panel) && /LIVE|DELAYED/.test(panel) && /\d{1,2}:\d{2}/.test(panel), panel.slice(0, 300));
  ok('...and the facts the snapshot holds', await js(`return document.querySelectorAll('[data-tkp-facts] .tkp-fact').length >= 5;`));
  ok('popups.js gave its backdrop A1\'s look', await until(`document.querySelector('.tkp-scrim').hasAttribute('data-a1-scrim')`, 6000));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`);
  ok('Escape closes it', await until(`!document.querySelector('[data-tkp]')`, 3000));
  await js(`document.querySelector('.mk-tile[data-sym="XLF"]').click(); 1`);
  ok('a sector tile opens it too, and Close closes it', await until(`document.querySelector('[data-tkp="XLF"]')`, 3000) && await js(`document.querySelector('[data-tkp-close]').click(); return !document.querySelector('[data-tkp]');`));

  console.log('\nThe layout is saved');
  const writes = () => js(`return window.__fakeFs.log.filter(function(w){ return /tradehub_layout/.test(w.path); }).length;`);
  ok('nothing was written just for looking', (await writes()) === 0);
  await js(`document.querySelector('.lay-card[data-card="volume"] [data-act="hide"]').click(); 1`);
  ok('hiding a card takes it off the grid and into Add card', await until(`!document.querySelector('.lay-grid .lay-card[data-card="volume"]') && /Add card \\(1\\)/.test(document.querySelector('[data-lay-add]').options[0].textContent)`, 3000));
  await js(`document.querySelector('.lay-card[data-card="breadth"] [data-act="collapse"]').click(); 1`);
  ok('collapsing leaves the title bar', await until(`document.querySelector('.lay-card[data-card="breadth"]').classList.contains('is-collapsed') && document.querySelector('.lay-card[data-card="breadth"]').getBoundingClientRect().height < 50`, 3000));
  ok('not written at once', (await writes()) === 0);
  ok('...written once, 1.5 s after the last change', await until(`window.__fakeFs.log.filter(function(w){ return /tradehub_layout/.test(w.path); }).length === 1`, 4000));
  const doc = JSON.parse(await js(`return JSON.stringify(window.__fakeFs.docs['dashboards/tradehub_layout']);`));
  ok('one doc, by tab and size class, in grid units', doc.market && doc.market.desktop && doc.market.desktop.hidden.join() === 'volume' && doc.market.desktop.collapsed.join() === 'breadth' && !doc.market.phone && !/px/.test(JSON.stringify(doc)), JSON.stringify(doc).slice(0, 300));
  await boot({ keep: true }); await tab('market');
  ok('after a reload the card is still hidden and the other still collapsed', await until(`document.querySelector('[data-mk-score]') && !document.querySelector('.lay-grid .lay-card[data-card="volume"]') && document.querySelector('.lay-card[data-card="breadth"]').classList.contains('is-collapsed')`, 10000));
  await sleep(2200);
  ok('...and the reload wrote nothing', (await writes()) === 0, await writes());
  await js(`var s=document.querySelector('[data-lay-add]'); s.value='volume'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
  ok('Add card brings it back', await until(`document.querySelector('.lay-grid .lay-card[data-card="volume"]') && document.querySelector('[data-lay-add]').disabled`, 3000));
  await js(`document.querySelector('[data-lay-reset]').click(); 1`);
  ok('Reset layout restores the default', await until(`!document.querySelector('.lay-card.is-collapsed') && document.querySelectorAll('.lay-grid .lay-card').length === 8`, 3000));
  await size(390, 844); await sleep(700);
  await js(`document.querySelector('.lay-card[data-card="analogs"] [data-act="hide"]').click(); 1`); await sleep(2200);
  await size(1280, 900); await sleep(700);
  const two = JSON.parse(await js(`return JSON.stringify(window.__fakeFs.docs['dashboards/tradehub_layout'].market);`));
  ok('a phone keeps its own arrangement: hidden there, still shown on the desktop', two.phone.hidden.join() === 'analogs' && two.desktop.hidden.length === 0 && await js(`return !!document.querySelector('.lay-grid .lay-card[data-card="analogs"]');`), JSON.stringify(two).slice(0, 300));

  console.log('\nNo snapshot stored: the page builds it');
  api.state.snapshot = null; api.asked.length = 0; api.posted.claims = 0; api.posted.snapshots.length = 0; api.posted.watchlists.length = 0; api.state.watchlist = null;
  await boot({ quant: true });
  ok('the morning check starts the build with no click', await until(`1`, 100) && await (async () => { for (let i = 0; i < 300; i++) { if (api.posted.snapshots.length) return true; await sleep(200); } return false; })(), paths().slice(0, 12).join());
  const built = api.posted.snapshots[0] || {};
  ok('what it posts is a snapshot for the slot due, built on the page', built.day === FIXTURE.day && built.slot === FIXTURE.slot && built.by === 'page' && built.rows && built.rows.SPY && built.regime && built.breadth && built.breadth.members >= 100, JSON.stringify({ day: built.day, slot: built.slot, by: built.by }));
  ok('...computed in a real Web Worker', await js(`var m = await import('/A1/TradeHub/data/compute.js'); return m.inWorker();`));
  const barCalls = paths().filter((p) => p === '/bars').length;
  ok('...from daily bars, at most two requests a symbol', barCalls >= 110 && barCalls <= 2 * (118 + WATCHLIST.length), barCalls);
  ok('...posted once, and the watchlist sent for the runner', api.posted.snapshots.length === 1 && api.posted.watchlists.length === 1 && api.posted.watchlists[0].length === WATCHLIST.length);
  ok('...after claiming the slot, so no other device builds it too', api.posted.claims === 1, api.posted.claims);
  ok('the morning is then marked done', await until(`localStorage.getItem('tb_morning_market_slot')`, 8000));
  const n0 = api.asked.length;
  await tab('market');
  ok('opening Market shows it at once', await until(`document.querySelector('[data-mk-score]') && document.querySelectorAll('[data-mk-sectors] .mk-tile').length === 12`, 8000));
  ok('...built on a device, says the meta line', /on a device/.test(await js(`return document.querySelector('[data-mk-meta]').innerText;`)));
  await sleep(1000);
  ok('...without building again', api.asked.slice(n0).every((a) => a.p !== '/bars') && api.posted.snapshots.length === 1, api.asked.slice(n0).map((a) => a.p).join());
  api.state.snapshot = FIXTURE; api.state.watchlist = WATCHLIST;

  console.log('\nNo key, and turning it off');
  api.asked.length = 0;
  await boot({ quant: true, key: '' });
  await tab('market');
  ok('without the Orca key the tab says where to paste it, and asks quant-api nothing', await until(`/Orca key/.test((document.querySelector('[data-mk-error]')||{}).innerText||'')`, 15000) && api.asked.length === 0, paths().join());
  await boot({ quant: true });
  await tab('market'); await until(`document.querySelector('[data-mk-score]')`, 10000);
  await js(`window.__fakeFs.remote('dashboards/tradeboard_dashboard', { quant: false }, { merge: true }); 1`);
  await sleep(9000);   // the page ignores its own echo for 8 s after a save of that doc
  await js(`window.__fakeFs.remote('dashboards/tradeboard_dashboard', { quant: false, bump: 1 }, { merge: true }); 1`);
  ok('switched off on another device: the tab goes and Portfolio shows', await until(`!document.querySelector('.tb-navtab[data-navid="market"]') && !document.querySelector('[data-mk]') && localStorage.getItem('tradehub_quant') === null`, 6000));

  console.log('\nSide effects');
  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
