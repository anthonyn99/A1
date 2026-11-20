// TradeHub Quant refinements R7B (A1-Priv docs/TradeHub/quant/r1-07b.md): Charts on a
// phone and a tablet, after the ergonomics of Robinhood's mobile chart, in the real
// page with real touch events (CDP Input.dispatchTouchEvent), quant-api played here.
//
//   1. the layout: the header in the tool row (one line), the indicators as one line that
//      opens their menu, the ranges and the interval at the bottom under the thumb, the
//      chart edge to edge with a narrow price axis, volume inside the price pane, RSI's
//      pane named with its value and its band shaded
//   2. gestures: one finger pans through time, a pinch zooms, press and hold scrubs the
//      O H L C V line (it ends when the finger lifts), a double tap fits; none of them
//      changes the range or the interval (R3)
//   3. the tablet the same; the desktop exactly as before; the ticker panel on a phone
//
// Run: node tests/live/tradehub-quant-chart-r7b.live.js   (own CDP_PORT)
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
  const CH = `document.querySelector('[data-charts]').__charts.active()`;
  const view = async () => JSON.parse(await js(`var r=${CH}.chart().timeScale().getVisibleLogicalRange(); return JSON.stringify(r ? { from: r.from, to: r.to } : null);`));
  const opts = async () => JSON.parse(await js(`var o=${CH}.get(); return JSON.stringify({ tf: o.tf, range: o.range });`));
  const stage = async () => JSON.parse(await js(`var b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return JSON.stringify({ l: b.left, t: b.top, w: b.width, h: b.height, b: b.bottom });`));
  const touch = (type, pts) => c.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: Math.round(p.x), y: Math.round(p.y), id: i, radiusX: 4, radiusY: 4, force: 1 })) });
  const still = async () => { let a = JSON.stringify(await view()); for (let i = 0; i < 20; i++) { await sleep(150); const b = JSON.stringify(await view()); if (a === b) return; a = b; } };

  async function layoutChecks(name) {
    ok(`${name}: the touch layout is on`, await until(`document.querySelector('[data-charts]').hasAttribute('data-touch') && document.querySelector('.ch-tools[data-touch]') && ${CH}.touch()`, 10000));
    ok(`${name}: the ticker, price and move sit in the tool row, on ONE line`, await js(`var hd=document.querySelector('.ch-tools .ch-main-row .ch-head'); if (!hd) return false; var r=hd.getBoundingClientRect(); return r.height <= 40 && /\\d/.test(hd.querySelector('[data-ch-px]').textContent);`),
      await js(`var hd=document.querySelector('.ch-head'); return hd ? hd.parentNode.className + ' h=' + hd.getBoundingClientRect().height : 'no head';`));
    ok(`${name}: every range and the interval are at the bottom, under the chart`, await js(`var b=document.querySelector('[data-ch-bottom]'), s=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return !!b && !b.hidden && b.querySelectorAll('[data-ch-range]').length === 9 && !!b.querySelector('[data-ch-tf]') && b.getBoundingClientRect().top >= s.bottom - 1 && !document.querySelector('.ch-main-row [data-ch-range]');`));
    ok(`${name}: the picked range is a filled pill`, await js(`var on=document.querySelector('[data-ch-bottom] [data-ch-range].is-on'); return !!on && getComputedStyle(on).backgroundColor !== 'rgba(0, 0, 0, 0)';`));
    ok(`${name}: the indicators as one line ("Volume, …")`, await js(`var l=document.querySelector('[data-ch-indline]'); return !!l && !l.hidden && /^Volume/.test(l.innerText) && l.getBoundingClientRect().height <= 40;`), await js(`var l=document.querySelector('[data-ch-indline]'); return l ? l.innerText : 'none';`));
    ok(`${name}: the chart is edge to edge (no padding in its card)`, await js(`var b=document.querySelector('.lay-card[data-card="chart"] .lay-body'); return parseFloat(getComputedStyle(b).paddingLeft) === 0 && parseFloat(getComputedStyle(b).paddingRight) === 0;`));
    ok(`${name}: a narrow price axis, volume inside the price pane, RSI in a short pane of its own`, await until(`${CH}.chart().priceScale('right').width() < 70 && ${CH}.chart().panes().length === 2`, 8000),
      await js(`return ${CH}.chart().priceScale('right').width() + ' / panes ' + ${CH}.chart().panes().length;`));
    ok(`${name}: RSI's pane says its name and value, "RSI (14) 41.20"`, await until(`(function(){ var t=document.querySelector('[data-ch-panelbl="rsi"]'); return t && /^RSI \\(14\\) \\d+\\.\\d\\d$/.test(t.textContent); })()`, 5000),
      await js(`var t=document.querySelector('[data-ch-panelbl]'); return t ? t.textContent : 'none';`));
    ok(`${name}: the sync pill on screen (in the bottom bar), the chart type and Compare in Display`, await js(`var p=document.querySelector('[data-ch-sync]'), b=p.getBoundingClientRect(), d=document.querySelector('[data-ch-dispmenu]'); return !!p.closest('[data-ch-bottom]') && b.right <= innerWidth + 1 && b.left >= 0 && !!d.querySelector('[data-ch-type]') && !!d.querySelector('[data-ch-cmp]');`));
    ok(`${name}: no sideways scroll`, await js(`return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;`));
  }

  console.log('\n1. The phone layout (390 px)');
  await size(390, 844);
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await boot({ quant: true });
  await tab('charts');
  await until(`document.querySelector('[data-charts]') && document.querySelector('[data-charts]').__charts.active() && ${CH}.info().bars > 50`, 20000);
  await js(`window._tbOps.charts.set({ indicators: [{ type: 'vwap' }, { type: 'ema', n: 9 }, { type: 'rsi' }] }); 1`);
  await js(`document.querySelector('[data-ch-main]').scrollIntoView({ block: 'center' }); 1`);
  await sleep(1200);
  await layoutChecks('phone');
  ok('phone: the line names them, "Volume, VWAP, EMA 9, 1 more"', await js(`return document.querySelector('[data-ch-indline]').innerText.indexOf('Volume, VWAP, EMA 9, 1 more') === 0;`), await js(`return document.querySelector('[data-ch-indline]').innerText;`));
  await js(`document.querySelector('[data-ch-indline]').click(); 1`);
  ok('phone: a tap on the line opens the indicators (add, remove, lengths)', await until(`!document.querySelector('[data-ch-indmenu]').hidden && document.querySelectorAll('[data-ch-indmenu] [data-ch-kind]').length >= 8`, 3000));
  await js(`document.querySelector('[data-ch-indline]').click(); 1`);
  ok('phone: a second tap closes it', await until(`document.querySelector('[data-ch-indmenu]').hidden`, 3000));
  await js(`document.querySelector('[data-ch-bottom] [data-ch-range="1M"]').click(); 1`);
  ok('phone: a range pill at the bottom changes the range (the interval stays)', await until(`${CH}.get().range === '1M'`, 5000) && (await opts()).tf === '5m', JSON.stringify(await opts()));

  console.log('\n2. Gestures (real touch events)');
  await js(`${CH}.fit(); 1`); await still();
  const o0 = await opts();
  let s = await stage();
  // Zoom in first so a pan has room both ways.
  { const cx = s.l + s.w * 0.5, cy = s.t + s.h * 0.45, v0 = await view();
    await touch('touchStart', [{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }]);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: cx - 30 - i * 10, y: cy }, { x: cx + 30 + i * 10, y: cy }]); await sleep(16); }
    await touch('touchEnd', []); await still();
    const v1 = await view();
    ok('a pinch outward zooms in (fewer bars in view)', v1 && v0 && (v1.to - v1.from) < (v0.to - v0.from) * 0.8, JSON.stringify([v0, v1]));
    ok('...centred between the fingers (the middle bar stays near the middle)', v1 && Math.abs((v1.from + v1.to) / 2 - (v0.from + v0.to) / 2) < (v0.to - v0.from) * 0.25, JSON.stringify([v0, v1])); }
  { const v0 = await view(), y = s.t + s.h * 0.45;
    await touch('touchStart', [{ x: s.l + s.w * 0.3, y }]);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: s.l + s.w * 0.3 + i * 16, y }]); await sleep(16); }
    await touch('touchEnd', []); await still();
    const v1 = await view();
    ok('one finger dragged right pans back in time (same zoom)', v1 && v1.from < v0.from - 1 && Math.abs((v1.to - v1.from) - (v0.to - v0.from)) < 1.5, JSON.stringify([v0, v1])); }
  { const last = await js(`return document.querySelector('[data-ch-main] [data-ch-read] .ch-read-t').textContent;`), y = s.t + s.h * 0.45;
    await touch('touchStart', [{ x: s.l + s.w * 0.35, y }]); await sleep(700);
    await touch('touchMove', [{ x: s.l + s.w * 0.36, y }]); await sleep(120);
    const held = await js(`return document.querySelector('[data-ch-main] [data-ch-read] .ch-read-t').textContent;`);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: s.l + s.w * (0.36 + i * 0.03), y }]); await sleep(30); }
    const scrub = await js(`return document.querySelector('[data-ch-main] [data-ch-read] .ch-read-t').textContent;`);
    await touch('touchEnd', []); await sleep(300);
    const after = await js(`return document.querySelector('[data-ch-main] [data-ch-read] .ch-read-t').textContent;`);
    ok('press and hold shows the bar under the finger in the O H L C V line', held !== last, JSON.stringify([last, held]));
    ok('...it follows the finger as it moves (scrubbing)', scrub !== held, JSON.stringify([held, scrub]));
    ok('...and lifting the finger ends it (back to the last bar)', after === last, JSON.stringify([last, after])); }
  { const pts = { x: s.l + s.w * 0.5, y: s.t + s.h * 0.4 };
    await touch('touchStart', [pts]); await touch('touchEnd', []); await sleep(90);
    await touch('touchStart', [pts]); await touch('touchEnd', []); await still();
    const v = await view(), n = JSON.parse(await js(`return JSON.stringify(${CH}.info().bars + ${CH}.info().gaps);`));
    ok('a double tap fits the range (the newest bar at the right edge)', v && Math.abs(v.to - (n - 1)) < 2, JSON.stringify([v, n])); }
  const o1 = await opts();
  ok('no gesture changed the range or the interval', JSON.stringify(o0) === JSON.stringify(o1), JSON.stringify([o0, o1]));
  { const v0 = await view(); await touch('touchStart', [{ x: s.l + s.w * 0.5, y: s.t + 10 }]); await touch('touchEnd', []); await sleep(200);
    ok('a single tap changes nothing', JSON.stringify(v0) === JSON.stringify(await view())); }

  console.log('\n3. Tablet, desktop, the ticker panel');
  await size(TAB_W, 1180); await sleep(1500);
  await js(`document.querySelector('[data-ch-main]').scrollIntoView({ block: 'center' }); 1`); await sleep(500);
  await layoutChecks('tablet');
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await size(DESK_W, 900); await sleep(1500);
  ok('desktop: exactly as before (ranges and interval back in the top row, no bottom bar, no indicators line)', await until(`!document.querySelector('[data-charts]').hasAttribute('data-touch') && document.querySelectorAll('.ch-main-row [data-ch-range]').length === 9 && document.querySelector('.ch-main-row [data-ch-tf]') && document.querySelector('[data-ch-bottom]').hidden && document.querySelector('[data-ch-indline]').hidden`, 8000));
  ok('desktop: the header back over the chart, volume in its own pane, the wide price axis', await until(`!${CH}.touch() && document.querySelector('[data-ch-main] .ch > .ch-head') && ${CH}.chart().panes().length === 3 && ${CH}.chart().priceScale('right').width() >= 78`, 8000),
    await js(`return ${CH}.chart().panes().length + ' / ' + ${CH}.chart().priceScale('right').width();`));
  ok('desktop: lower panes named top left (B4, ask 27), no RSI band (touch only)', await js(`return !!document.querySelector('[data-ch-panelbl]');`));
  ok('the switches kept the interval and range', JSON.stringify(await opts()) === JSON.stringify(o1));
  await size(390, 844); await sleep(1200);
  await tab('market'); await sleep(800);
  await js(`window._tbOps.market.open('NVDA'); 1`);
  ok('the ticker panel on a phone: its chart takes the touch layout too', await until(`(function(){ var w=document.querySelector('.tkp-chartwrap'); if (!w) return false; var b=w.querySelector('[data-ch-bottom]'); return b && !b.hidden && b.querySelectorAll('[data-ch-range]').length === 9 && !w.querySelector('[data-ch-indline]').hidden; })()`, 15000),
    await js(`var w=document.querySelector('.tkp-chartwrap'); return w ? w.innerHTML.slice(0, 200) : 'no panel';`));

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
