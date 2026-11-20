// Scratch (deleted after use): screenshot SNDK 4H on the old basis.
'use strict';
const fs = require('fs'), path = require('path');
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, CLOCK } = require('./quant-mock.js');
const OUT = process.env.OUT;
(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  const { js, until, size, boot, tab } = driver(c);
  const F = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'A1-Priv', 'tests', 'fixtures', 'quant', 'sndk-split.json'), 'utf8'));
  const WEEK = 7 * 86_400_000, shift = -Math.ceil((F.now - CLOCK) / WEEK) * WEEK, mv = (b) => ({ ...b, t: b.t + shift });
  api.state.realBars = { SNDK: Object.fromEntries(['5m', '1h', '4h', '1d'].map((tf) => [tf, F[tf].map(mv)])) };
  api.state.splits = process.env.SPLITS ? { SNDK: [{ ...F.split, t: F.split.t + shift }] } : {};
  const TAB = `document.querySelector('[data-charts]').__charts`, CH = `${TAB}.active()`;
  for (const [w, h] of [[1504, 900], [390, 844]]) {
    await size(w, h);
    await boot({ quant: true }); await tab('charts');
    await until(`${TAB} && ${CH}`, 20000); await sleep(1500);
    if (process.env.SLOW) { api.state.barsDelay = { SNDK: 4000 }; }
    await js(`${CH}.set({ symbol: 'SNDK', range: '1D', tf: '4h' }); 1`);
    if (process.env.SLOW) { await sleep(1200); const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, `loading-${w}.png`), Buffer.from(s.result.data, 'base64')); }
    await sleep(process.env.SLOW ? 6000 : 3000);
    api.state.barsDelay = {};
    const box = JSON.parse(await js(`var b=document.querySelector('[data-ch-main]').getBoundingClientRect(); window.scrollTo(0, window.scrollY + b.top - 10); return JSON.stringify({x:b.left,y:10,w:b.width,h:Math.min(b.height, ${h} - 10)});`));
    await sleep(300);
    const s = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } });
    fs.writeFileSync(path.join(OUT, `sndk-4h-${w}.png`), Buffer.from(s.result.data, 'base64'));
    console.log(await js(`return JSON.stringify(${CH}.info().view) + ' ' + ${CH}.info().bars;`));
  }
  c.ws.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
