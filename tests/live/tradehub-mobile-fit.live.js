// TradeHub on a phone: nothing on a page may run off the right edge of the
// screen (Tony, 2026-10-02: Control's Trash button was cut off).
//
//   node tests/live/tradehub-mobile-fit.live.js            all pages, 360 + 390 + 430px
//   node tests/live/tradehub-mobile-fit.live.js --shots x  also a shot of each
//
// For every page in the nav it lists each visible button, input, chip and
// text block whose box ends past the viewport, or that is cut by an ancestor
// that clips (overflow hidden) without scrolling.
'use strict';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const ORIGIN = 'https://anthonyn99.github.io';
const URL = ORIGIN + '/A1/tradehub.html';
const SHOTS = process.argv[2] === '--shots' ? (process.argv[3] || 'th-fit') : null;
const PROMPTS = [
  { id: 'pa', name: 'Alpha prompt', text: '# Alpha\n\nLine one.' },
  { id: 'pb', name: 'Bravo prompt', text: 'The bravo prompt.' },
];

// Every visible control or leaf text box that ends past the screen's right
// edge (or starts left of 0). Horizontal scrollers are allowed to hold wider
// content: what they clip, you can scroll to.
const OVERFLOW = `
  const W = document.documentElement.clientWidth, out = [];
  const scrollsX = (n) => { for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p).overflowX; if ((s === 'auto' || s === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
  document.querySelectorAll('#tradeboard-root button, #tradeboard-root input, #tradeboard-root select, #tradeboard-root textarea, #tradeboard-root a, #tradeboard-root span, #tradeboard-root div').forEach((e) => {
    if (e.closest('[hidden]')) return;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return;
    if (cs.position === 'fixed' && r.top > innerHeight) return;
    const leaf = /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(e.tagName) || (!e.children.length && (e.textContent || '').trim());
    if (!leaf) return;
    if (r.right > W + 1 || r.left < -1) {
      if (scrollsX(e)) return;
      out.push(e.tagName + '.' + (e.className && e.className.baseVal === undefined ? String(e.className).split(' ')[0] : '') + ' "' + (e.textContent || e.value || '').trim().slice(0, 30) + '" ' + Math.round(r.left) + '..' + Math.round(r.right) + ' / ' + W);
    }
  });
  return JSON.stringify(out.slice(0, 12));
`;

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Network.setBypassServiceWorker', { bypass: true });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: URL + '?blank' }); await sleep(800);
  await evalJs(c, `localStorage.clear(); localStorage.setItem('tradeboard_prompts_v2', ${JSON.stringify(JSON.stringify(PROMPTS))}); 1`);

  for (const w of [360, 390, 430]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 860, deviceScaleFactor: 1, mobile: true });
    await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await c.send('Page.navigate', { url: URL });
    for (let i = 0; i < 40 && !(await evalJs(c, "return !!document.querySelector('.tb-navtab');")); i++) await sleep(250);
    await sleep(2500);
    const ids = JSON.parse(await evalJs(c, "return JSON.stringify([...new Set([...document.querySelectorAll('.tb-navtab')].map(b=>b.dataset.navid))]);"));
    for (const id of ids) {
      await evalJs(c, `const b=[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(x=>x.offsetParent); if(b) b.click(); 1`);
      await sleep(1200);
      const bad = JSON.parse(await evalJs(c, OVERFLOW));
      const pageW = await evalJs(c, 'return document.documentElement.scrollWidth;');
      ok(`${w}px ${id}: nothing runs off the screen`, !bad.length && pageW <= w + 1, JSON.stringify({ pageW, bad }));
      if (SHOTS) {
        const r = await c.send('Page.captureScreenshot', { format: 'png' });
        const f = shotPath(`${SHOTS}-${w}-${id}`);
        fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
      }
    }
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  c.close && c.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
