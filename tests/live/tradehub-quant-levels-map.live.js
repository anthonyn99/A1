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

  ok('no page errors', !errs.length, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
