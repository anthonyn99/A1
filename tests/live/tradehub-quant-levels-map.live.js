// Tony 2026-11-21: the Levels card's "Full chart" (A1-Priv TradeHub/ui/levels-map.js) in the real page, quant-api
// played here: the button at the card's top, a popup with ONE daily chart over all the history read, every level
// the card holds as a line with its name and price, the touches marked, the years before the levels' window
// shaded, the list beside it (under it on a phone), a press on a level picks it out, Escape / × / a press outside
// close it and the chart goes with it; 1280, 820 and 390 px.
//
// Run: node tests/live/tradehub-quant-levels-map.live.js   (own CDP_PORT)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const { js, until, size, boot, tab } = driver(c);
  const BTN = `document.querySelector('.lay-card[data-card="levels"] .lay-head [data-ch-lv-map]')`, BOX = `document.querySelector('[data-levels-map]')`;
  const nLevels = () => js(`return document.querySelectorAll('[data-ch-levels] [data-ch-level]').length;`);
  const openMap = async () => { await until(BTN, 15000); await js(`${BTN}.click(); 1`); return until(`${BOX} && ${BOX}.dataset.lvmReady === '1'`, 20000); };

  await size(1280 + 224, 900);
  await boot({ quant: true }); await tab('charts');
  ok('the full-chart button is in the Levels card\'s header, just left of ↑, the four corners alone (no words)', await until(`${BTN} && document.querySelectorAll('[data-ch-levels] [data-ch-level]').length > 0`, 20000)
    && await js(`var b=${BTN}, up=b.parentElement.querySelector('[data-act="collapse"]'); return !!up && b.nextElementSibling === up && b.textContent.trim() === '' && !!b.querySelector('svg') && /Full chart/.test(b.getAttribute('aria-label'));`),
    await js(`var b=${BTN}; return b ? b.parentElement.outerHTML.slice(0, 300) : 'no button';`));
  const want = await nLevels();

  console.log('\n1. The full chart');
  ok('a press opens the popup and its chart draws', await openMap(), await js(`return ${BOX} ? JSON.stringify(${BOX}.dataset) : 'no popup';`));
  const d = JSON.parse(await js(`return JSON.stringify(${BOX}.dataset);`));
  ok(`every level the card holds is in the list (${want})`, await js(`return ${BOX}.querySelectorAll('[data-lvm-level]').length;`) === want);
  ok('every level is a line on the chart (zones two), plus "Now"', Number(d.lvmLines) >= want + 1, d.lvmLines);
  ok('the touches are marked on their bars', Number(d.lvmMarks) >= want, d.lvmMarks);
  ok('the chart covers more than the levels\' 3 years, the older years shaded', Number(d.lvmBars) > 800 && d.lvmShaded === '1', JSON.stringify({ bars: d.lvmBars, first: d.lvmFirst, shaded: d.lvmShaded }));
  ok('the header says what the levels were found on', /found on the last 3 years of daily bars/.test(await js(`return ${BOX}.querySelector('[data-lvm-sub]').textContent;`)));
  const first = await js(`return ${BOX}.querySelector('[data-lvm-level]').getAttribute('data-lvm-level');`);
  await js(`${BOX}.querySelector('[data-lvm-level="${first}"]').click(); 1`); await sleep(300);
  ok(`a press on ${first} picks it out (only its touches marked)`, await js(`var r=${BOX}.querySelector('[data-lvm-level="${first}"]'); return r.getAttribute('aria-pressed') === 'true';`) && Number(await js(`return ${BOX}.dataset.lvmMarks;`)) < Number(d.lvmMarks));
  await js(`${BOX}.querySelector('[data-lvm-level="${first}"]').click(); 1`); await sleep(200);
  ok('...a second press puts every level back', await js(`return ${BOX}.dataset.lvmMarks;`) === d.lvmMarks);
  // Tony 2026-11-21: ⟲ back to the whole chart; zones across the whole plot (they stopped at the last bar); the
  // shade faint (it read as a white block); the ranks coloured as on the card.
  const view = () => js(`return ${BOX}.dataset.lvmView || '';`).then((v) => v.split('..').map(Number));
  const v0 = await view();
  const pr = JSON.parse(await js(`var r=${BOX}.querySelector('[data-lvm-plot]').getBoundingClientRect(); return JSON.stringify({x:r.left+r.width*0.6,y:r.top+r.height/2});`));
  for (let i = 0; i < 8; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pr.x, y: pr.y, deltaX: 0, deltaY: -400 }); await sleep(60); }
  await sleep(300);
  const v1 = await view();
  ok('the wheel zooms in (fewer bars in view)', v1[1] - v1[0] < (v0[1] - v0[0]) * 0.7, JSON.stringify([v0, v1]));
  await js(`${BOX}.querySelector('[data-lvm-reset]').click(); 1`); await sleep(300);
  const v2 = await view();
  ok('⟲ snaps back to the whole chart', v2[0] <= 0 && v2[1] >= Number(d.lvmBars) - 1, JSON.stringify([v1, v2, d.lvmBars]));
  // The shade (Tony 2026-11-21: "no soft gray area"): its edge was computed as 0, so nothing was drawn. On the whole
  // chart the edge must sit well inside the plot (the mock's history starts about a year before the window).
  await sleep(300);
  const sx = Number(await js(`return ${BOX}.dataset.lvmShadeX || -1;`)), pw = await js(`return ${BOX}.querySelector('[data-lvm-plot]').getBoundingClientRect().width;`);
  ok('the years not used for levels are shaded: the band\'s edge is inside the plot, not at 0', sx > 20 && sx < pw - 50, JSON.stringify({ sx, pw }));
  // Tony 2026-11-21: "Now" (the latest trade) read as wrong beside the last candle; when it differs from the newest
  // bar's close, the close is named under it and drawn as its own line.
  const nc = JSON.parse(await js(`var b=${BOX}, c=b.querySelector('[data-lvm-close-px]'); return JSON.stringify({ shown: !!c && !c.hidden, text: c ? c.textContent : '', lines: Number(b.dataset.lvmLines) });`));
  ok('"Now" carries the last close when they differ (and never a blank one)', !nc.shown || /close .* \d/.test(nc.text) && /latest trade/.test(nc.text), JSON.stringify(nc));
  ok('...the ⟲ is centred in its button too (a drawn arrow)', await js(`var x=${BOX}.querySelector('[data-lvm-reset]'), s=x.querySelector('svg'); if (!s) return false; var a=x.getBoundingClientRect(), c=s.getBoundingClientRect(); return Math.abs((a.left+a.right)/2-(c.left+c.right)/2) < 1 && Math.abs((a.top+a.bottom)/2-(c.top+c.bottom)/2) < 1;`));
  ok("levels in the theme's soft green and red (--tbb / --tbr)",await js(`return getComputedStyle(${BOX}.querySelector('.lvm-row.lvm-s')).getPropertyValue('--lvm-c').trim() !== '#8fbf7f' || !getComputedStyle(document.querySelector('#tradeboard-root')).getPropertyValue('--tbb').trim();`));
  ok('...the X is centred in its button (a drawn cross)', await js(`var x=${BOX}.querySelector('[data-lvm-close]'), s=x.querySelector('svg'); if (!s) return false; var a=x.getBoundingClientRect(), c=s.getBoundingClientRect(); return Math.abs((a.left+a.right)/2-(c.left+c.right)/2) < 1 && Math.abs((a.top+a.bottom)/2-(c.top+c.bottom)/2) < 1;`));
  ok('...the ⟲ sits beside ×',await js(`var r=${BOX}.querySelector('[data-lvm-reset]'); return !!r && r.nextElementSibling === ${BOX}.querySelector('[data-lvm-close]');`));
  // A zone's colour at the plot's right edge, past the last bar (the canvas under the candles).
  const zoneEdge = await js(`var b=${BOX}; if (b.dataset.lvmZones === '0') return 'no zones';
    var cs=[...b.querySelectorAll('[data-lvm-plot] canvas')], pl=b.querySelector('[data-lvm-plot]').getBoundingClientRect(), hit=0;
    for (const cv of cs) { var r=cv.getBoundingClientRect(); if (r.width < pl.width*0.5) continue; var g=cv.getContext('2d'), sx=cv.width/r.width, x=Math.floor((r.width-6)*sx);
      for (let y=0; y<cv.height; y+=2) { var p=g.getImageData(x,y,1,1).data; if (p[3] > 0 && p[0] !== p[2]) { hit++; } } }
    return hit;`);
  ok('a zone box reaches the plot\'s right edge, past the last bar', zoneEdge === 'no zones' || zoneEdge > 0, zoneEdge);
  const chips = JSON.parse(await js(`var o={}; for (const c of ${BOX}.querySelectorAll('.lvm-rank')) o[c.dataset.rank]=getComputedStyle(c).color; return JSON.stringify(o);`));
  const kinds = Object.keys(chips);
  ok('the rank chips coloured as on the Levels card (one colour per rank)', kinds.length >= 1 && new Set(Object.values(chips)).size === kinds.length
    && await js(`return [...${BOX}.querySelectorAll('.lvm-rank')].every((c) => /\\bmk-(good|warn|off)\\b/.test(c.className));`), JSON.stringify(chips));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`); await sleep(200);
  ok('Escape closes it, and its chart is gone from the page', await js(`return !${BOX} && !document.querySelector('[data-lvm-plot]');`));
  await openMap();
  await js(`document.querySelector('[data-lvm-close]').click(); 1`); await sleep(200);
  ok('× closes it', await js(`return !${BOX};`));
  await openMap();
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 }); await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 }); await sleep(200);
  ok('a press outside the box closes it', await js(`return !${BOX};`));

  // Tony 2026-11-21 (memory): opening and closing it leaves nothing behind: no canvas, no growth of the heap.
  const gc = async () => { await c.send('HeapProfiler.enable'); await c.send('HeapProfiler.collectGarbage'); await sleep(300); };
  await gc();
  const m0 = JSON.parse(await js(`return JSON.stringify({ canvases: document.querySelectorAll('canvas').length, heap: performance.memory ? performance.memory.usedJSHeapSize : 0, nodes: document.getElementsByTagName('*').length });`));
  for (let i = 0; i < 6; i++) { await openMap(); await js(`document.querySelector('[data-lvm-close]').click(); 1`); await sleep(200); }
  await gc();
  const m1 = JSON.parse(await js(`return JSON.stringify({ canvases: document.querySelectorAll('canvas').length, heap: performance.memory ? performance.memory.usedJSHeapSize : 0, nodes: document.getElementsByTagName('*').length });`));
  ok('six opens and closes leave no canvas or element behind, and the heap within 3 MB', m1.canvases === m0.canvases && m1.nodes <= m0.nodes + 20 && m1.heap - m0.heap < 3e6, JSON.stringify([m0, m1]));

  console.log('\n2. Every width');
  for (const [w, hgt, name] of [[1280 + 224, 900, 'desktop'], [820 + 224, 1000, 'tablet'], [390, 844, 'phone']]) {
    await size(w, hgt); await sleep(800); await tab('charts'); await sleep(500);
    ok(`${name}: it opens and draws`, await openMap());
    const g = JSON.parse(await js(`var b=${BOX}.getBoundingClientRect(), p=${BOX}.querySelector('[data-lvm-plot]').getBoundingClientRect(), l=${BOX}.querySelector('[data-lvm-list]').getBoundingClientRect(); return JSON.stringify({b:[b.left,b.top,b.right,b.bottom], p:[p.left,p.top,p.width,p.height], l:[l.left,l.top,l.width,l.height], W:innerWidth, H:innerHeight, sx: document.documentElement.scrollWidth - document.documentElement.clientWidth});`));
    ok(`${name}: the box inside the screen, no sideways scroll`, g.b[0] >= -1 && g.b[1] >= -1 && g.b[2] <= g.W + 1 && g.b[3] <= g.H + 1 && g.sx <= 1, JSON.stringify(g));
    ok(`${name}: a real chart (at least 250 px tall, most of the width${name === 'phone' ? '' : ' beside the list'})`, g.p[3] >= 250 && g.p[2] >= (name === 'phone' ? g.W - 40 : g.W * 0.45), JSON.stringify(g));
    const beside = g.W > 820;   // the list goes under the chart only on a narrow screen (levels-map.css)
    ok(`${name}: the list ${beside ? 'beside' : 'under'} the chart, with room to read`, beside ? g.l[0] >= g.p[0] + g.p[2] - 1 && g.l[3] > 200 : g.l[1] >= g.p[1] + g.p[3] - 1 && g.l[3] > 80, JSON.stringify(g));
    await js(`document.querySelector('[data-lvm-close]').click(); 1`); await sleep(200);
  }

  // Ask 60 (Tony 2026-11-21): an Indicators checkbox clicked twice (ticked, unticked) kept the text fields' purple
  // focus ring. Real mouse clicks, then the mouse away: no accent border, no ring.
  await size(1280 + 224, 900); await sleep(600); await tab('charts');
  await until(`document.querySelector('[data-ch-ind]')`, 15000);
  await js(`var m=document.querySelector('[data-ch-indmenu]'); if (!m || m.hidden) document.querySelector('[data-ch-ind]').click(); 1`); await sleep(400);
  const rv = JSON.parse(await js(`var r=document.querySelector('[data-ch-kind="rvol"]').getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});`));
  for (let i = 0; i < 2; i++) { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: rv.x, y: rv.y, button: 'left', clickCount: 1 }); await sleep(400); }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 650 }); await sleep(400);
  const cb = JSON.parse(await js(`var b=document.querySelector('[data-ch-kind="rvol"]'), s=getComputedStyle(b), o=getComputedStyle(document.querySelector('[data-ch-kind="atr"]')); return JSON.stringify({checked:b.checked, focus:document.activeElement===b, shadow:s.boxShadow, border:s.borderColor, other:o.borderColor});`));
  ok('ask 60: Relative volume ticked then unticked, mouse away: no ring, its border like the others', !cb.checked && cb.shadow === 'none' && cb.border === cb.other, JSON.stringify(cb));
  // A text field keeps its focus ring.
  await js(`document.querySelector('[data-ch-len="ema"]').focus(); 1`); await sleep(100);
  ok('...a text field still gets its focus ring', /3px/.test(await js(`return getComputedStyle(document.querySelector('[data-ch-len="ema"]')).boxShadow;`)));

  console.log('\n3. Treasury yield series');
  for (const sym of ['US2Y', 'US10Y', 'SOXX']) {
    const got = await js(`return (async () => {
      const { openLevelsMap } = await import('./TradeHub/ui/levels-map.js');
      const isStock = ${JSON.stringify(sym)} === 'SOXX';
      const t = Date.UTC(2026, 10, 20), c = 4.25;
      const bars = [{ t, c }, { t: t + 3 * 86400000, c: 4.31 }];
      if (isStock) for (const point of bars) Object.assign(point, { o: point.c - 0.01, h: point.c + 0.02, l: point.c - 0.02 });
      const lv = { supports: [{ name: 'S1', kind: 'zone', lo: 4.22, hi: 4.25, rank: 'Medium', touches: 1, pts: [[t, c, 'low']] }] };
      const map = openLevelsMap({ sym: ${JSON.stringify(sym)}, lv, price: 4.31, gateway: { bars: async () => ({ bars }) }, now: Date.UTC(2026, 10, 24) });
      try {
        await map.ready;
        const series = map.chart()?.panes()[0].getSeries()[0];
        const { lvmLines, lvmMarks, lvmZones } = map.el.querySelector('[data-levels-map]').dataset;
        return { type: series?.seriesType(), values: series?.data().map(point => isStock ? point.close : point.value), lvmLines, lvmMarks, lvmZones };
      } finally { map.close(); }
    })();`);
    ok(`${sym} full history uses ${sym === 'SOXX' ? 'candles' : 'a line'} and keeps both observations`,
      got?.type === (sym === 'SOXX' ? 'Candlestick' : 'Line') && got.values?.join(',') === '4.25,4.31', JSON.stringify(got));
    ok(`${sym} draws the support zone, touch marker and current value`,
      got?.lvmLines === '3' && got.lvmMarks === '1' && got.lvmZones === '1', JSON.stringify(got));
  }

  ok('no page errors', !errs.length, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
