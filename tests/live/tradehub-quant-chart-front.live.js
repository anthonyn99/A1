// TradeHub Quant, Charts: the newest bar stays in view (Tony 2026-11-20: "4H time frame, the latest data is
// all the way back in June. Should be up to date"). A chart showing its front (the newest bar) is still on
// its front after every interval, range and symbol switch; and a wheel zoom at the front centres on the
// cursor, never on the front (Tony: "it always zooms to front no matter where my cursor is"), in AND out (2026-11-21).
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-chart-front.live.js
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
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab } = driver(c);
  const info = async () => JSON.parse(await js(`return JSON.stringify(${CH}.info());`));
  const settled = async () => { await sleep(300); return until(`${CH}.info().bars > 0 && document.querySelector('[data-ch-main] [data-ch-note]').hidden`, 15000); };
  const set = async (patch) => { await js(`${CH}.set(${JSON.stringify(patch)}); 1`); await settled(); await sleep(500); };
  // The newest bar's logical index is bars + gaps - 1; "on the front" = it is inside the view, near its right
  // edge (at most a sixth of the view, or 3 bars, of empty room after it: never a screen of blank).
  const front = (I) => { const n = I.bars + I.gaps, v = I.view; return !!v && v.to >= n - 1.5 && v.from <= n - 1 && v.to <= n - 1 + Math.max(3, (v.to - v.from) / 6); };
  const fmt = (I) => `${I.symbol} ${I.range} ${I.tf} n=${I.bars + I.gaps} view=${I.view && I.view.from.toFixed(1)}..${I.view && I.view.to.toFixed(1)}`;

  for (const [w, h] of [[1504, 900], [820, 1100], [390, 844]]) {
    await size(w, h);
    await boot({ quant: true });
    await tab('charts');
    await until(`${TAB} && ${CH}`, 20000); await settled();
    console.log(`\n${w} px (opens on ${fmt(await info())})`);
    const steps = [{ range: '1D', tf: '5m' }, { tf: '4h' }, { tf: '5m' }, { tf: '1h' }, { tf: '4h' }, { range: '1Y', tf: '1d' }, { tf: '4h' }, { range: '6M' }, { tf: '1d' }, { tf: '4h' }, { symbol: 'MU' }, { tf: '15m' }];
    const seen = [];
    let all = true;
    for (const s of steps) { await set(s); const I = await info(); seen.push((front(I) ? "" : "BAD ") + fmt(I)); if (!front(I)) all = false; }
    ok("every switch from a front view stays on the newest bar", all, seen.filter((x) => /^BAD/.test(x)).join(" | "));

    // B8 (asks 14, 20): after a ticker switch, "Now" sits in the middle of the Levels card; each detail is short
    // ("3 touches · 04/11/25 · 2.3 ATR turn"), wraps, carries the full sentence as its tooltip, and a press opens it.
    await set({ symbol: 'AMD' }); await sleep(900);
    const lv = JSON.parse(await js(`var n=document.querySelector('[data-ch-levels] .ch-lv-now'); if(!n) return 'null'; var box=n.parentElement; while(box && box!==document.body){ var o=getComputedStyle(box).overflowY; if((o==='auto'||o==='scroll') && box.scrollHeight>box.clientHeight+1) break; box=box.parentElement; } var why=document.querySelector('[data-ch-levels] .ch-lv-why'); if(!box||box===document.body) return JSON.stringify({noScroll:true, why: why && why.textContent, title: why && why.title}); var b=box.getBoundingClientRect(), r=n.getBoundingClientRect(); return JSON.stringify({off: Math.abs((r.top+r.height/2)-(b.top+b.height/2)), h:b.height, top: box.scrollTop, max: box.scrollHeight-box.clientHeight, why: why && why.textContent, title: why && why.title});`));
    ok(`${w} px: after a ticker switch, "Now" is in the middle of the Levels card (or the list fits without scrolling)`, lv && (lv.noScroll || lv.off <= 24 || lv.top === 0 || lv.top >= lv.max - 1), JSON.stringify(lv));
    ok(`${w} px: a level's detail is short (touches · mm/dd/yy …) with the full sentence as its tooltip`, lv && /touch(es)? · \d\d\/\d\d\/\d\d/.test(lv.why || '') && /, last on /.test(lv.title || ''), JSON.stringify(lv));
    ok(`${w} px: pressing the detail opens the full sentence under the row`, await js(`var w=document.querySelector('[data-ch-levels] .ch-lv-why'); if(!w) return false; w.click(); var f=w.parentElement.querySelector('.ch-lv-full'); var shown=f && !f.hidden; w.click(); return !!shown && f.hidden;`));
    // B8 (ask 2): Key Stats never cuts a value off.
    const cut = await js(`var c=document.querySelector('[data-sk-stats]'); if(!c) return 'no card'; return [...c.querySelectorAll('.sk-stat b, .sk-stat small')].filter(function(e){return e.scrollWidth>e.clientWidth+1 || e.getBoundingClientRect().right>c.getBoundingClientRect().right+1;}).map(function(e){return e.textContent;}).join(' | ');`);
    ok(`${w} px: no Key Stats value or label is cut off or runs out of its card`, cut === '' || cut === 'no card', cut);

    if (w > 800) {
      // The zoom: at the front, the cursor at 30% across the plot, one wheel step in.
      await set({ range: '6M', tf: '4h' });
      const st = JSON.parse(await js(`var b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return JSON.stringify({l:b.left,t:b.top,w:b.width,h:b.height});`));
      const x = st.l + st.w * 0.3, y = st.t + st.h * 0.4;
      const at = async () => Number(await js(`var ch=${CH}.chart(), b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return ch.timeScale().coordinateToLogical(${x} - b.left);`));
      const L0 = await at(), I0 = await info();
      await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -240 });
      await sleep(800);
      const L1 = await at(), I1 = await info();
      ok('a wheel zoom-in at the front keeps the bar under the cursor under it', Math.abs(L1 - L0) < 1.5 && (I1.view.to - I1.view.from) < (I0.view.to - I0.view.from), `bar ${L0.toFixed(1)} -> ${L1.toFixed(1)}; view ${fmt(I0)} -> ${fmt(I1)}`);
      // Tony 2026-11-21: zoom OUT pins to the cursor too ("like how zooming in zooms into my cursor"), Webull's way.
      // Three steps out from the zoomed-in front view, the cursor at 70% across (the newest bar on screen).
      const x2 = st.l + st.w * 0.7;
      const at2 = async () => Number(await js(`var ch=${CH}.chart(), b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return ch.timeScale().coordinateToLogical(${x2} - b.left);`));
      const L2 = await at2(), I2 = await info();
      for (let i = 0; i < 3; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x2, y, deltaX: 0, deltaY: 240 }); await sleep(250); }
      await sleep(800);
      const L3 = await at2(), I3 = await info();
      ok('Tony 2026-11-21: a wheel zoom-OUT at the front keeps the bar under the cursor under it', Math.abs(L3 - L2) < 1.5 && (I3.view.to - I3.view.from) > (I2.view.to - I2.view.from), `bar ${L2.toFixed(1)} -> ${L3.toFixed(1)}; view ${fmt(I2)} -> ${fmt(I3)}`);
      ok('...and the newest bar is still on screen, with no screen of blank after it', front(I3), fmt(I3));
      // Tony 2026-11-21: "if I'm already max zoomed out, and continue to scroll out, don't do anything, don't keep
      // moving the chart to the left". Zoom out all the way (1D on 5 minute bars, as his screenshot), then five more.
      await set({ range: '1D', tf: '5m' }); await sleep(600);
      const span = async () => JSON.parse(await js(`var ts=${CH}.chart().timeScale(), r=ts.getVisibleRange(), l=ts.getVisibleLogicalRange(); return JSON.stringify({from:r&&r.from, to:r&&r.to, lf:l&&l.from, lt:l&&l.to});`));
      for (let i = 0; i < 40; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x2, y, deltaX: 0, deltaY: 240 }); await sleep(60); }
      await sleep(1500);
      const M0 = await span();
      for (let i = 0; i < 5; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x2, y, deltaX: 0, deltaY: 240 }); await sleep(250); }
      await sleep(1500);
      const M1 = await span();
      ok('Tony 2026-11-21: fully zoomed out, five more zoom-outs move nothing (same bars in view, same place)', M0.from === M1.from && M0.to === M1.to && Math.abs(M0.lf - M1.lf) < 0.01 && Math.abs(M0.lt - M1.lt) < 0.01, JSON.stringify([M0, M1]));
    }
  }
  // SNDK's real 8-for-1 (ex 2026-11-20), served on the OLD basis as Alpaca did (A1-Priv fixture), moved by
  // whole weeks to end before the mock's clock. Tony: "loading SNDK again loaded back the chart BEFORE the
  // price cut, showing a steep drop", and at 4H "the latest data is all the way back in June".
  {
    const fs = require('fs'), path = require('path');
    const F = JSON.parse(fs.readFileSync(path.join(process.env.A1_PRIV || path.join(__dirname, '..', '..', '..', 'A1-Priv'), 'tests', 'fixtures', 'quant', 'sndk-split.json'), 'utf8'));
    const { CLOCK } = require('./quant-mock.js'), WEEK = 7 * 86_400_000;
    const shift = -Math.ceil((F.now - CLOCK) / WEEK) * WEEK, mv = (b) => ({ ...b, t: b.t + shift });
    api.state.realBars = { SNDK: Object.fromEntries(['5m', '1h', '4h', '1d'].map((tf) => [tf, F[tf].map(mv)])) };
    api.state.splits = process.env.NO_SPLITS ? {} : { SNDK: [{ ...F.split, t: F.split.t + shift }] };
    const last = F['5m'][F['5m'].length - 1].c;   // the new basis (~$81)
    await size(1504, 900);
    for (const round of [1, 2]) {   // round 2 = the device's month store already holds SNDK (Tony's "loading again")
      await boot({ quant: true });
      await tab('charts');
      await until(`${TAB} && ${CH}`, 20000); await settled();
      for (const tf of ['5m', '1h', '4h', '1d']) {
        await set({ symbol: 'SNDK', range: tf === '1d' ? '1Y' : tf === '4h' ? '6M' : '5D', tf });
        const I = await info();
        const hi = Number(await js(`var ch=${CH}.chart(), s=ch.panes()[0].getSeries()[0], d=s.data(); var m=0; for (var i=0;i<d.length;i++) if (d[i].high>m) m=d[i].high; return m;`));
        ok(`round ${round}, SNDK ${tf}: every bar on today's basis (highest ${hi.toFixed(2)}, last ${last})`, hi > 0 && hi < last * 4, fmt(I));
        ok(`round ${round}, SNDK ${tf}: the view is on the newest bar`, front(I), fmt(I));
      }
    }
    api.state.realBars = null;
  }
  ok('no page errors', !errs.length, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  try { c.ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
