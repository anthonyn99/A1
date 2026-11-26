// scratch: why TradeHub does not render in the live harness (deleted after use)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');
(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const logs = [];
  await c.send('Network.enable'); await c.send('Network.clearBrowserCache'); await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400));
    if (m.method === 'Log.entryAdded') logs.push('LOG ' + m.params.entry.level + ': ' + m.params.entry.text.slice(0, 200) + ' ' + (m.params.entry.url || ''));
  });
  const { js, size, boot } = driver(c);
  await size(1504, 900);
  try { await boot({ quant: true }); console.log('rendered'); } catch (e) { console.log('boot:', e.message); }
  console.log(await js(`return document.title + ' | ' + location.href + ' | ' + document.body.innerText.slice(0,300);`));
  console.log(logs.slice(0, 40).join('\n'));
  try { await c.close(); } catch (e) {}
  process.exit(0);
})();
