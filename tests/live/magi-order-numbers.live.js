// LIVE test -- reads the real engine on this PC, starts no task.
// Run: node tests/live/magi-order-numbers.live.js   Screenshots: %TEMP%/magi-live-shots
// Agent order sheet: each row shows a clean 1/2/3 position number.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const URL = require('./cdp.js').PAGES_URL;
const STUB = `if (window.top === window) (()=>{const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); }
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(300);
  }
  return false;
};

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: URL }); await sleep(2500);
  await evalJs(c, 'localStorage.clear(); sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "code"); return 1;');
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 25000));
  await waitFor(c, '!!(CODE.state && CODE.agents)');

  await evalJs(c, 'openCodeOrder(); return 1;');
  await sleep(200);
  ok('sheet open', await evalJs(c, '!!document.querySelector(".code-order")'));
  const nums = JSON.parse(await evalJs(c,
    'return JSON.stringify([...document.querySelectorAll(".code-order-num")].map(n=>n.textContent));'));
  ok('numbers are 1..N in order', nums.every((v, i) => v === String(i + 1)), nums.join(','));
  ok('no stray swatch dot', await evalJs(c, '!document.querySelector(".code-order-sw")'));
  const badgeColor = await evalJs(c,
    'getComputedStyle(document.querySelector(".code-order-num")).color');
  ok('badge is tinted, not plain text', !!badgeColor && badgeColor !== 'rgb(0, 0, 0)', badgeColor);
  await shot(c, 'order-numbers-1-desktop');

  // Reorder and confirm numbers follow the new positions, not the agent.
  const firstName = await evalJs(c, 'document.querySelector(".code-order-name").textContent');
  await evalJs(c, 'const g = document.querySelector(".code-order-row .dsort-grip"); g.focus(); g.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true})); return 1;');
  await sleep(150);
  const rows = JSON.parse(await evalJs(c,
    'return JSON.stringify([...document.querySelectorAll(".code-order-row")].map(r=>({n:r.querySelector(".code-order-num").textContent,name:r.querySelector(".code-order-name").textContent})));'));
  ok('after moving row 1 down, it now shows 2', rows[1].name === firstName && rows[1].n === '2', JSON.stringify(rows.slice(0,2)));
  ok('numbers still sequential after reorder', rows.every((r, i) => r.n === String(i + 1)));
  await shot(c, 'order-numbers-2-after-reorder');

  await evalJs(c, 'document.querySelector(".sheet-bar .btn").click(); return 1;');
  await sleep(150);
  ok('sheet closes', !(await evalJs(c, '!!document.querySelector(".code-order")')));

  console.log('\nPhone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evalJs(c, 'openCodeOrder(); return 1;');
  await sleep(300);
  await shot(c, 'order-numbers-3-phone');
  ok('no horizontal scroll', await evalJs(c, 'document.documentElement.scrollWidth <= window.innerWidth + 1'));

  ok('no page errors', errs.length === 0, errs.join(' / '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
