const { connect, evalJs, sleep } = require('./cdp.js');
(async () => {
  const c = await connect();
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send('Page.navigate', { url: 'https://orca.vedapatel05.workers.dev/profiles' }); await sleep(4000);
  console.log(await evalJs(c, 'return JSON.stringify({sw: document.documentElement.scrollWidth, iw: innerWidth, cards: [...document.querySelectorAll(".gate-card")].map(n => Math.round(n.getBoundingClientRect().left)+"/"+Math.round(n.getBoundingClientRect().width))});'));
  const s = await c.send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(process.argv[2], Buffer.from(s.result.data, 'base64')); process.exit(0);
})();
