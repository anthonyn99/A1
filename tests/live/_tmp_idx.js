const { connect, evalJs, sleep } = require('./cdp.js');
(async () => { const c = await connect(); await c.send('Page.navigate', { url: 'https://anthonyn99.github.io/A1/index.html' }); await sleep(4500);
 console.log(await evalJs(c, 'return JSON.stringify({corner: document.querySelectorAll("#profile-overlay .pk-star").length, cards: document.querySelectorAll("#profile-overlay .pk-card").length});')); process.exit(0); })();
