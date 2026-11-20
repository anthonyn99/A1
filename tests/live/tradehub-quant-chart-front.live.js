// TradeHub Quant, Charts: the newest bar stays in view (Tony 2026-11-20: "4H time frame, the latest data is
// all the way back in June. Should be up to date"). A chart showing its front (the newest bar) is still on
// its front after every interval, range and symbol switch; and a wheel zoom at the front centres on the
// cursor, never on the front (Tony: "it always zooms to front no matter where my cursor is").
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
  // The newest bar's logical index is bars + gaps - 1; "on the front" = it is inside the view.
  const front = (I) => I.view && I.view.to >= I.bars + I.gaps - 1.5 && I.view.from <= I.bars + I.gaps - 1;
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
    for (const s of steps) { await set(s); const I = await info(); seen.push(fmt(I)); if (!front(I)) all = false; }
    ok('every switch from a front view stays on the newest bar', all, seen.filter((x, i) => x).join(' | '));

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
    api.state.splits = { SNDK: [{ ...F.split, t: F.split.t + shift }] };
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
