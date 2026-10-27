const { connect, evalJs, sleep } = require('./cdp.js');
(async () => { const c = await connect();
  for (const w of [1280, 390]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 500 });
    await c.send('Page.navigate', { url: 'https://orca.vedapatel05.workers.dev/profiles?_=' + Date.now() }); await sleep(3500);
    console.log('orca', w, await evalJs(c, 'return JSON.stringify([...document.querySelectorAll(".gate-card")].map(n => n.dataset.profile + " " + Math.round(n.getBoundingClientRect().width) + "x" + Math.round(n.getBoundingClientRect().height)));'));
  }
  process.exit(0); })();
