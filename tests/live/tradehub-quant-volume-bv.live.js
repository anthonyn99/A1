// TradeHub Quant Refinements Batch 2, BV (A1-Priv docs/TradeHub/quant/r2-0v.md): volume you can trust,
// in the real page. quant-api marks the newest bars as one exchange's volume (IEX) and Yahoo's unknown
// volume as such (played here by the mock); the chart draws partial volume faint, unknown volume as no
// bar, the read-out says which, and the volume average leaves both out. At 1280 and 390 px.
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-volume-bv.live.js
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const TAB = `document.querySelector('[data-charts]').__charts`, CH = `${TAB}.active()`;

(async () => {
  const api = quantApi();
  api.state.barsVx = { NVDA: { iex: 3, none: [10] } };
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const { js, until, size, boot, tab } = driver(c);
  for (const [w, h, name] of [[1504, 900, 'desktop'], [390, 844, 'phone']]) {
    console.log(`\n${name}`);
    await size(w, h);
    await boot({ quant: true });
    await tab('charts');
    await until(`${TAB} && ${CH} && ${CH}.info().symbol === 'NVDA' && ${CH}.info().bars > 0 && document.querySelector('[data-ch-main] [data-ch-note]').hidden`, 20000);
    await sleep(600);
    const v = JSON.parse(await js(`var ch=${CH}.chart(); var s=null; ch.panes().forEach(function(p){ p.getSeries().forEach(function(x){ if(!s && x.seriesType()==='Histogram' && x.options().priceFormat.type==='volume') s=x; }); });
      var d=s?s.data():[]; var n=d.length; return JSON.stringify({ n:n, bars: ${CH}.info().bars, last3: d.slice(-3).map(function(p){return p.color;}), before: d[n-4] && d[n-4].color, beforeT: d[n-4] && d[n-4].time });`));
    // The library's data() leaves blank points out: the unknown bar is the one missing.
    v.unknown = v.n === v.bars - 1 ? false : true;
    ok('the newest 3 bars (IEX only) are drawn faint', v.last3.length === 3 && v.last3.every((col) => /0\.2\)?$/.test(col) || /,\s*0\.2\)/.test(col)), JSON.stringify(v));
    ok('...the bar before them (whole) at full strength', v.before && !/0\.2\)/.test(v.before) && /0\.(6|32)\)/.test(v.before), v.before);
    ok('a bar whose volume is not known has no volume bar (a gap, not a 0)', v.unknown === false, JSON.stringify(v));
    const avg = JSON.parse(await js(`var ch=${CH}.chart(); var out=null; ch.panes().forEach(function(p){ p.getSeries().forEach(function(x){ if(x.seriesType()==='Line' && x.options().priceFormat && x.options().priceFormat.type==='volume') out=x.data(); }); }); if(!out) return 'null'; return JSON.stringify(out.length ? out[out.length-1].time : null);`));
    if (name === 'desktop') ok('the volume average stops at the last whole bar (never dragged down by the partial ones)', avg === v.beforeT, JSON.stringify([avg, v.beforeT]));
    // the read-out on the newest bar (crosshair at the right edge)
    const box = JSON.parse(await js(`var b=document.querySelector('[data-ch-main] [data-ch-box]').getBoundingClientRect(); return JSON.stringify({x:b.left,y:b.top,w:b.width,h:b.height});`));
    const lx = await js(`var ts=${CH}.chart().timeScale(); var n=${CH}.info().bars; return ts.logicalToCoordinate(n-1);`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + lx, y: box.y + box.h * 0.3 });
    await sleep(300);
    const read = await js(`var r=document.querySelector('[data-ch-main] .ch-read'); return r ? r.textContent : '';`);
    ok('the read-out on the newest bar says its volume is IEX only', /IEX only/.test(read), read.slice(0, 200));
  }
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
