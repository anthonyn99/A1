// TradeHub Quant Refinements Batch 2: the bugs B0 reproduced (A1-Priv docs/TradeHub/quant/r2-00.md).
// Written in B0, where EVERY check here failed on purpose: each one is a bug Tony reported, caught in
// the real page. The phase in [brackets] fixes it and makes it pass; B11 needs all of them green.
//
//   [B3] a chart type switch with no price-pane indicator keeps price in its own pane (ask 13)
//   [B3] a Compare that fails says so beside the box, never in the chart, and names the symbol (ask 12)
//   [B3] a Compare cleared while its bars load leaves no line and no error (ask 12)
//   [B3] a zoom-out at 4 hours asks for at most a few bars requests (ask 34: "back to January")
//   [B3] session shading holds through every interval switch (ask 34)
//   [B4] Weeks average draws, or its row says why not, on 5 minutes (ask 26)
//   [B4] Relative volume draws on 5D at 5 minutes (ask 28)
//   [B4] typing an EMA length with EMA unticked leaves it off (ask 25)
//   [B4] a drawing moved across a night follows the pointer (ask 31)
//   [B7] ticking one indicator does not touch the other checkboxes (asks 24, 41)
//   [B8] a live tick does not replace the Analysis card's average marker (ask 21)
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-batch2.live.js   (ONLY=B3 runs one phase's checks)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ONLY = process.env.ONLY || '';
const ok = (phase, name, cond, extra) => {
  if (ONLY && phase !== ONLY) return;
  if (cond) { pass++; console.log(`  ok   [${phase}] ${name}`); }
  else { fail++; console.log(`  FAIL [${phase}] ${name}` + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const want = (phase) => !ONLY || ONLY === phase;
const TAB = `document.querySelector('[data-charts]').__charts`, CH = `${TAB}.active()`;

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Page.javascriptDialogOpening') c.send('Page.handleJavaScriptDialog', { accept: true });
  });
  const { js, until, size, boot, tab } = driver(c);
  const info = async () => JSON.parse(await js(`return JSON.stringify(${CH}.info());`));
  const settled = async () => { await sleep(300); return until(`${CH}.info().bars > 0 && document.querySelector('[data-ch-main] [data-ch-note]').hidden`, 15000); };
  const pick = async (sel, v) => { await js(`var s=document.querySelector('${sel}'); s.value=${JSON.stringify(v)}; s.dispatchEvent(new Event('change',{bubbles:true})); 1`); await settled(); await sleep(300); };
  const setInd = async (list) => { await js(`${CH}.set({ indicators: ${JSON.stringify(list)} }); 1`); await sleep(500); };
  const stage = async () => JSON.parse(await js(`var b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return JSON.stringify({l:b.left,t:b.top,w:b.width,h:b.height});`));
  const note = () => js(`var n=document.querySelector('[data-ch-main] [data-ch-note]'); return n && !n.hidden ? n.textContent : '';`);

  await size(1504, 900);
  await boot({ quant: true });
  await tab('charts');
  await until(`${TAB} && ${CH}`, 20000); await settled();
  const start = await info();
  console.log(`  (opens on ${start.symbol} ${start.range} ${start.tf})`);

  if (want('B3')) {
    // Ask 13: Tony's MU chart had two indicators, both in their own panes, and Bars left only volume.
    await setInd([{ type: 'rsi' }, { type: 'macd' }]);
    await pick('[data-ch-type]', 'bars');
    const panes = JSON.parse(await js(`var ch=${CH}.chart(); return JSON.stringify(ch.panes().map(function(p){return p.getSeries().map(function(s){return s.seriesType();});}));`));
    ok('B3', 'a type switch with no price-pane indicator keeps price alone in the first pane', panes[0] && panes[0].length === 1 && panes[0][0] === 'Bar', JSON.stringify(panes));
    ok('B3', '...and volume keeps its own pane', panes[1] && panes[1].includes('Histogram') && !panes[0].includes('Histogram'), JSON.stringify(panes));
    await pick('[data-ch-type]', 'candles');
    await setInd(start.series.length ? [{ type: 'vwap' }, { type: 'ema', n: 9 }, { type: 'ema', n: 21 }] : []);

    // Ask 12: a Compare that cannot be read.
    api.state.barsFail = ['ZZZQ'];
    await js(`var b=document.querySelector('[data-ch-cmp]'); b.focus(); b.value='ZZZQ'; b.dispatchEvent(new Event('input',{bubbles:true})); b.dispatchEvent(new Event('change',{bubbles:true})); 1`);
    await sleep(1200);
    const inChart = await note();
    const beside = await js(`var w=document.querySelector('.ch-cmp-wrap'); var n=w && w.querySelector('[data-ch-cmp-note]'); return n && !n.hidden ? n.textContent : '';`);
    ok('B3', 'a Compare that fails is not reported inside the chart', !inChart, inChart);
    ok('B3', '...it is named beside the Compare box', /ZZZQ/.test(beside), beside || '(nothing beside the box)');
    await js(`document.querySelector('[data-ch-cmp-clear]').click(); 1`); await sleep(400);
    api.state.barsFail = [];
    // ...and one cleared while its bars are still on the way.
    api.state.barsDelay = { XOM: 1500 };
    await js(`var b=document.querySelector('[data-ch-cmp]'); b.value='XOM'; b.dispatchEvent(new Event('change',{bubbles:true})); 1`);
    await sleep(200);
    await js(`document.querySelector('[data-ch-cmp-clear]').click(); 1`);
    await sleep(2200);
    const I = await info(), n2 = await note();
    ok('B3', 'a Compare cleared while it loads leaves no line', !I.compare, JSON.stringify({ compare: I.compare }));
    ok('B3', '...and no "null could not be read"', !/null/.test(n2), n2);
    api.state.barsDelay = {};

    // Ask 34: one zoom-out at 4 hours.
    await pick('[data-ch-tf]', '4h');
    api.asked.length = 0;
    const s = await stage();
    for (let i = 0; i < 25; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: s.l + s.w / 2, y: s.t + s.h * 0.4, deltaX: 0, deltaY: 120 }); await sleep(30); }
    await sleep(2500);
    const asked = api.asked.filter((a) => a.p === '/bars' && /tf=4h/.test(a.q));
    ok('B3', 'a zoom-out at 4 hours asks for at most 6 bars requests', asked.length <= 6, asked.length + ' requests');
    // Session shading through every switch (bands > 0 on every intraday interval).
    const seen = [];
    for (const tf of ['5m', '1d', '5m', '4h', '1h', '5m']) { await pick('[data-ch-tf]', tf); seen.push(tf + ':' + (await info()).bands); }
    ok('B3', 'session shading holds through every interval switch', seen.every((x) => /^1d:/.test(x) || !/:0$/.test(x)), seen.join(' '));
    // The switch matrix: the window Tony looks at stays put (Tony: "preserve EXACT position").
    await pick('[data-ch-tf]', '5m');
    await js(`var ch=${CH}, n=ch.info().bars; ch.chart().timeScale().setVisibleLogicalRange({ from: n - 300, to: n - 100 }); 1`); await sleep(500);
    const win = async () => JSON.parse(await js(`var r=${CH}.chart().timeScale().getVisibleRange(); return JSON.stringify(r ? [r.from, r.to] : null);`));
    const w0 = await win(), drift = [];
    for (const ty of ['bars', 'line', 'area', 'hollow', 'ha', 'candles']) { await pick('[data-ch-type]', ty); const w = await win(); if (!w || Math.abs(w[0] - w0[0]) > 600 || Math.abs(w[1] - w0[1]) > 600) drift.push(ty + ':' + JSON.stringify(w)); }
    ok('B3', 'every chart type keeps the exact window (within a bar)', drift.length === 0, JSON.stringify({ w0, drift }));
    const tfDrift = [];
    for (const tf of ['15m', '1h', '5m']) { await pick('[data-ch-tf]', tf); const w = await win(); const tol = { '15m': 1800, '1h': 7200, '5m': 900 }[tf]; if (!w || Math.abs(w[0] - w0[0]) > tol || Math.abs(w[1] - w0[1]) > tol) tfDrift.push(tf + ':' + JSON.stringify(w)); }
    ok('B3', 'an interval switch keeps the same stretch of time (within a bar of the new interval)', tfDrift.length === 0, JSON.stringify({ w0, tfDrift }));
    // Tony, 13:29: after a big price range the candles stayed squashed when he zoomed back in.
    await js(`var ch=${CH}; ch.center(ch.info().bars ? 1 : 1); ch.chart().priceScale('right').applyOptions({ autoScale: false }); 1`);
    const sc = await stage();
    for (let i = 0; i < 4; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: sc.l + sc.w * 0.7, y: sc.t + sc.h * 0.4, deltaX: 0, deltaY: -120 }); await sleep(40); }
    await sleep(500);
    ok('B3', 'a zoom by hand fits the prices again (auto scale back on), so candles never stay squashed', await js(`return ${CH}.chart().priceScale('right').options().autoScale === true;`));
  }

  if (want('B4')) {
    await pick('[data-ch-tf]', '5m');
    await setInd([{ type: 'wsma', n: 40 }]);
    const ws = (await info()).series.some((x) => /^wsma/.test(x.id));
    await js(`document.querySelector('[data-ch-ind]').click(); 1`); await sleep(300);
    const wsRow = await js(`var b=document.querySelector('[data-ch-kind="wsma"]'); var r=b && b.closest('.ch-menu-row'); return r ? (r.getAttribute('title')||'') + ' ' + (r.dataset.chOff||'') : '';`);
    ok('B4', 'Weeks average draws on 5 minutes, or its row says why not', ws || /daily|week|interval/i.test(wsRow), JSON.stringify({ drawn: ws, row: wsRow }));
    await js(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); 1`);
    await setInd([{ type: 'rvol' }]);
    const rv = JSON.parse(await js(`var ch=${CH}.chart(); var p=ch.panes(); var last=p[p.length-1].getSeries()[0]; var d=last?last.data():[]; return JSON.stringify({n:d.length, vals:d.filter(function(v){return v.value!=null;}).length});`));
    ok('B4', 'Relative volume draws on 5D at 5 minutes', rv.vals > 0, JSON.stringify(rv));
    await setInd([]);
    await js(`document.querySelector('[data-ch-ind]').click(); 1`); await sleep(300);
    await js(`var l=document.querySelector('[data-ch-len="ema"]'); l.value='12'; l.dispatchEvent(new Event('change',{bubbles:true})); 1`); await sleep(500);
    const after = (await info()).series.map((x) => x.id);
    ok('B4', 'typing an EMA length with EMA unticked leaves it off', !after.includes('ema:12'), JSON.stringify(after));
    await js(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); 1`);

    // Ask 31: a trend line moved across a night. Zoom in so a bar is several pixels wide.
    await setInd([]);
    const geo = JSON.parse(await js(`var ch=${CH}, items=ch.chart().timeScale(); var n=ch.info().bars; ch.chart().timeScale().setVisibleLogicalRange({from:n-150,to:n+5}); return JSON.stringify({n:n});`));
    await sleep(500);
    // The last bar of the day before the newest session, and the bar 12 before it.
    const pts = JSON.parse(await js(`var ch=${CH}, c=ch.chart(), ts=c.timeScale(); var n=${geo.n};
      var ser=c.panes()[0].getSeries()[0], d=ser.data(); var times=d.map(function(x){return x.time;});
      var gapAt=-1; for(var i=times.length-1;i>0;i--){ if(times[i]-times[i-1]>3600){ gapAt=i; break; } }
      return JSON.stringify({gapAt:gapAt, total:times.length});`));
    let moved = null;
    if (pts.gapAt > 20) {
      const res = JSON.parse(await js(`var ch=${CH}, d=ch.draw(), g=ch.geo; var c=ch.chart(), ser=c.panes()[0].getSeries()[0], data=ser.data();
        // chart time -> the bar's own time: ask the geometry at the bar's x
        // Both ends before the night, the pointer carried 15 bars, across it: the left end must stop short of the night.
        var ts=c.timeScale(); var xa=ts.logicalToCoordinate(${pts.gapAt}-20), xb=ts.logicalToCoordinate(${pts.gapAt}-10);
        var a={t:g.t(xa), p:g.p(200)}, b={t:g.t(xb), p:g.p(260)};
        d.set([{ id:'b0-trend', kind:'trend', pts:[a,b] }]);
        return JSON.stringify({ax:g.x(a.t), ay:g.y(a.p), bx:g.x(b.t), by:g.y(b.p), spacing:g.spacing()});`));
      const s2 = await stage();
      const mx = s2.l + (res.ax + res.bx) / 2, my = s2.t + (res.ay + res.by) / 2, dx = res.spacing * 15;
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my });
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mx, y: my, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 12; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx + dx * i / 12, y: my, button: 'left', buttons: 1 }); await sleep(16); }
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mx + dx, y: my, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(300);
      moved = JSON.parse(await js(`var ch=${CH}, d=ch.draw().get().find(function(x){return x.id==='b0-trend';}), g=ch.geo; return JSON.stringify(d ? {ax:g.x(d.pts[0].t), bx:g.x(d.pts[1].t)} : null);`));
      const errA = moved ? Math.abs(moved.ax - (res.ax + dx)) : 999, errB = moved ? Math.abs(moved.bx - (res.bx + dx)) : 999;
      ok('B4', 'a trend line moved across a night follows the pointer (both ends within 3 px)', errA <= 3 && errB <= 3, `off by ${errA.toFixed(1)} and ${errB.toFixed(1)} px (bar ${res.spacing.toFixed(1)} px)`);
      await js(`${CH}.draw().set([]); 1`);
    } else ok('B4', 'a trend line moved across a night follows the pointer (the mock has a night in view)', false, JSON.stringify(pts));
  }

  if (want('B7')) {
    await js(`document.querySelector('[data-ch-ind]').click(); 1`); await sleep(300);
    // Watch every other row's checkbox for the next 300 ms after one is ticked.
    const r = JSON.parse(await js(`return new Promise(function(done){
      var boxes=[].slice.call(document.querySelectorAll('[data-ch-kind]')); var target=boxes[boxes.length-1];
      var others=boxes.slice(0,-1).map(function(b){ return { b:b, kind:b.dataset.chKind, bg:getComputedStyle(b).backgroundColor }; });
      target.click();
      var replaced=0, changed=new Set(), t0=performance.now();
      (function look(){
        var now=[].slice.call(document.querySelectorAll('[data-ch-kind]'));
        others.forEach(function(o){ var cur=now.find(function(x){return x.dataset.chKind===o.kind;}); if(cur!==o.b) replaced++; if(cur && getComputedStyle(cur).backgroundColor!==o.bg) changed.add(o.kind); });
        if(performance.now()-t0<300) requestAnimationFrame(look); else done(JSON.stringify({ replaced: replaced>0, changed: [...changed] }));
      })();
    });`));
    ok('B7', 'ticking one indicator leaves the other checkboxes untouched (not rebuilt, no colour change)', !r.replaced && !r.changed.length, JSON.stringify(r));
    await js(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); 1`);
  }

  if (want('B8')) {
    const has = await until(`document.querySelector('.sk-mean')`, 8000);
    if (has) {
      const sym = (await info()).symbol;
      const same = await js(`window.__b0mean=document.querySelector('.sk-mean'); window.__ws.tick(${JSON.stringify(sym)}, 999.5); return new Promise(function(done){ setTimeout(function(){ done(document.querySelector('.sk-mean')===window.__b0mean && window.__b0mean.isConnected); }, 400); });`);
      ok('B8', 'a live tick does not replace the Analysis card\'s average marker (its tooltip stays)', same);
    } else ok('B8', 'a live tick does not replace the Analysis card\'s average marker (the card is on Charts)', false, 'no .sk-mean');
  }

  ok(ONLY || 'B0', 'no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
