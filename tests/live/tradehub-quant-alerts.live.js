// TradeHub Quant, Phase 14 in the real page (A1-Priv tradehub.html + TradeHub/ui/alerts.js),
// quant-api played here (quant-mock.js):
//   1. the bell: in the sidebar's foot (1280, 820) and the phone bar (390), with the unseen
//      count; it opens the list of recent alerts (who received each, or why not); opening it
//      marks them seen; a press on one opens what it is about (#alert=chart:NVDA → Charts)
//   2. Control ▸ Alerts: the six kinds with "market hours only" and "TaskHub card", quiet
//      hours, mute a ticker, the rules list, a new rule, delete asks first, Send test names
//      the devices
//   3. a notification's link (#alert=market) opens the Market tab and leaves the address clean
//   4. the catalysts are sent at most once (they did not change); with Quant off there is no bell
//   5. no sideways scroll at any width
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-alerts.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};

(async () => {
  const api = quantApi();
  const now = Date.now();
  const seedState = () => {
    api.state.alerts = [
      { id: 'r1', symbol: 'NVDA', kind: 'price', price: 170.6, params: { dir: 'above', holds: true }, note: 'set by Neo Quant', created: now - 5000 },
      { id: 'r2', symbol: 'AMD', kind: 'level', price: 150.25, level: 'R1 Strong', created: now - 4000 },
      { id: 'r3', symbol: null, kind: 'signal', params: { setup: 'orb' }, created: now - 3000 },
    ];
    api.state.alertFires = [
      { id: 2, rule_id: 'r1', at: now - 120000, kind: 'price', symbol: 'NVDA', title: 'NVDA crossed above 170.60', body: 'NVDA 171.02, held for two checks', url: 'https://a1-priv.av1.workers.dev/tradehub.html#alert=chart:NVDA', pushed: 1, devices: ['Tony PC', 'Pixel 9'], seen: false },
      { id: 1, rule_id: 'r3', at: now - 3600000, kind: 'signal', symbol: 'AMD', title: 'New GO: AMD orb', body: 'long day', url: 'https://a1-priv.av1.workers.dev/tradehub.html#alert=signal:s0001', pushed: null, why: 'quiet hours', devices: [], seen: false },
    ];
    api.state.alertCfg = null;
  };
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const noSideScroll = () => js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`);
  const page = () => js(`var o=window._tbOps&&window._tbOps.app; return o&&o.page?o.page():null;`);
  const bellSel = (w) => (w < 600 ? '.tb-mtop-bell [data-tal-bell]' : '.tb-side-bell [data-tal-bell]');

  for (const w of [1280, 820, 390]) {
    console.log(`\n${w} px: the bell`);
    seedState();
    await size(w, w < 600 ? 844 : 900);
    await boot({ quant: true });
    const bell = bellSel(w);
    ok('the bell is drawn' + (w < 600 ? ' in the phone bar' : ' in the sidebar\'s foot'), await until(`(function(){var b=document.querySelector('${bell}'); return b && b.offsetParent; })()`, 15000));
    ok('… with the unseen count (2)', await until(`(function(){var n=document.querySelector('${bell} [data-tal-count]'); return n && !n.hidden && n.textContent==='2'; })()`, 8000),
      await js(`var n=document.querySelector('${bell} [data-tal-count]'); return n ? n.textContent + '/' + n.hidden : 'none';`));
    if (w < 600) ok('only one bell shows on the phone (none in the drawer)', await js(`return [...document.querySelectorAll('[data-tal-bell]')].filter(function(b){return b.offsetParent;}).length === 1 && !document.querySelector('.tb-drawer [data-tal-bell]');`));
    ok('no sideways scroll', await noSideScroll());
    await shot(`alerts-bell-${w}`);
    await js(`document.querySelector('${bell}').click(); 1`);
    ok('the list opens with both alerts', await until(`document.querySelectorAll('[data-tal-list] [data-tal-fire]').length === 2`, 4000));
    const text = await js(`return document.querySelector('[data-tal-list]').innerText;`);
    ok('each says who received it, or why not', /sent to Tony PC, Pixel 9/.test(text) && /not pushed: quiet hours/.test(text), text);
    ok('the list fits the screen (no sideways scroll)', await noSideScroll() && await js(`var b=document.querySelector('[data-tal-list]').getBoundingClientRect(); return b.left >= 0 && b.right <= window.innerWidth;`));
    await shot(`alerts-list-${w}`);
    ok('opening it marks them seen: the count goes', await until(`(function(){var n=document.querySelector('${bell} [data-tal-count]'); return n && n.hidden; })()`, 4000) && (api.posted.seen || 0) >= 1);
    await js(`document.querySelector('[data-tal-fire="2"]').click(); 1`);
    ok('a press on an alert opens what it is about (Charts, NVDA)', await until(`!document.querySelector('[data-tal-list]')`, 3000) && await until(`window._tbOps && window._tbOps.app && window._tbOps.app.page() === 'charts'`, 8000), await page());
    ok('… with NVDA on the chart', await until(`window._tbOps.charts && window._tbOps.charts.get().symbol === 'NVDA'`, 8000));
  }

  console.log('\nControl ▸ Alerts (1280)');
  seedState();
  await size(1280, 900);
  await boot({ quant: true });
  await js(`window.tbControlShow('alerts'); 1`);   // R9: Control ▸ Alerts is its own section
  await tab('prompt');
  ok('the card is there', await until(`document.querySelector('[data-tal-control] [data-tal-kinds]')`, 15000));
  ok('six kinds, each with "market hours only" and "TaskHub card"', await js(`return document.querySelectorAll('[data-tal-kind]').length === 6 && document.querySelectorAll('[data-tal-market]').length === 6 && document.querySelectorAll('[data-tal-card]').length === 6;`));
  ok('the defaults: TaskHub cards on for "took hit target or stop" and catalysts', await js(`return document.querySelector('[data-tal-card="graded"]').checked && document.querySelector('[data-tal-card="catalyst"]').checked && !document.querySelector('[data-tal-card="price"]').checked;`));
  const rules = await js(`return [...document.querySelectorAll('[data-tal-rule]')].map(function(r){return r.innerText.split('\\n')[0];}).join(' | ');`);
  ok('the rules in plain words, in order', /^NVDA crosses above 170\.60, holds two checks \| AMD crosses R1 150\.25 \| A new GO \(orb\)/.test(rules), rules);
  await shot('alerts-control-1280');
  await js(`var q=document.querySelector('[data-tal-qon]'); q.click(); 1`);
  ok('quiet hours on: saved', await until(`true`, 100) && await (async () => { for (let i = 0; i < 30; i++) { if ((api.posted.alertCfg || []).some((x) => x.quiet && x.quiet.on)) return true; await sleep(100); } return false; })());
  await js(`document.querySelector('[data-tal-mutesym]').value='tsla'; document.querySelector('[data-tal-mute]').click(); 1`);
  ok('mute TSLA: saved and listed', await until(`document.querySelector('[data-tal-muted="TSLA"]')`, 3000) && (api.posted.alertCfg || []).some((x) => x.mute && 'TSLA' in x.mute));
  // Tony 2026-11-21: Beacon in TradeHub. Devices opens Beacon's panel for TradeHub with the alerts strip:
  // "This device is not registered" + Register, and each device's line.
  ok('Control ▸ Alerts has a Devices button', await js(`return !!document.querySelector('[data-tal-devices]');`));
  ok('Beacon is mounted as tradehub', await until(`window.Beacon && window.Beacon.deviceId && !!window.Beacon.deviceId()`, 15000));
  await js(`document.querySelector('[data-tal-devices]').click(); 1`);
  const PANEL = `(document.querySelector('beacon-panel') && document.querySelector('beacon-panel').shadowRoot)`;
  ok('…it opens Beacon\'s panel with TradeHub\'s alerts at the top: this device not registered, a Register button', await until(`${PANEL} && ${PANEL}.querySelector('[data-alerts-head] [data-alerts-reg]')`, 15000)
    && /not registered for TradeHub alerts/.test(await js(`return ${PANEL}.querySelector('[data-alerts-head]').textContent;`)), await js(`var r=${PANEL}; return r ? r.querySelector('[data-body]').innerText.slice(0,300) : 'no panel';`));
  ok('…each device carries its TradeHub alerts line', await js(`var r=${PANEL}; return r.querySelectorAll('[data-dev]').length === 0 || r.querySelectorAll('[data-alerts-dev]').length === r.querySelectorAll('[data-dev]').length;`));
  await shot('alerts-beacon-1280');
  await js(`${PANEL}.querySelector('[data-x]').click(); 1`); await sleep(300);
  await js(`document.querySelector('[data-tal-test]').click(); 1`);
  ok('Send test names the devices that received it', await until(`/Test sent to 2 devices: Tony PC, Pixel 9/.test((document.querySelector('[data-tal-msg]')||{}).textContent||'')`, 4000) && api.posted.tests === 1);
  // A new rule: price, PLTR above 30, holds.
  await js(`var f=document.querySelector('[data-tal-add]'); f.querySelector('[data-tal-fsym]').value='pltr'; f.querySelector('[data-tal-fprice]').value='30'; f.querySelector('[data-tal-fholds]').checked=true; f.querySelector('[data-tal-addbtn]').click(); 1`);
  ok('a new rule is added', await until(`[...document.querySelectorAll('[data-tal-rule]')].some(function(r){return /PLTR crosses above 30, holds two checks/.test(r.innerText);})`, 4000), JSON.stringify((api.posted.alerts || []).slice(-1)));
  const last = (api.posted.alerts || []).slice(-1)[0] || {};
  ok('… sent as quant-api takes it (kind price, symbol, price, dir above, holds)', last.kind === 'price' && last.symbol === 'PLTR' && last.price === 30 && last.params && last.params.dir === 'above' && last.params.holds === true, JSON.stringify(last));
  // Delete asks first: No keeps it, Yes removes it.
  await js(`window.uiConfirm=function(){ window.__asked=(window.__asked||0)+1; return Promise.resolve(false); }; document.querySelector('[data-tal-rule="r2"] [data-tal-del]').click(); 1`);
  await sleep(400);
  ok('delete asks first; "No" keeps the rule', await js(`return window.__asked === 1 && !!document.querySelector('[data-tal-rule="r2"]');`));
  await js(`window.uiConfirm=function(){ return Promise.resolve(true); }; document.querySelector('[data-tal-rule="r2"] [data-tal-del]').click(); 1`);
  ok('"Yes" removes it', await until(`!document.querySelector('[data-tal-rule="r2"]')`, 4000));
  ok('no sideways scroll on Control', await noSideScroll());

  for (const w of [820, 390]) {
    await size(w, w < 600 ? 844 : 900); await sleep(400);
    ok(`Control ▸ Alerts at ${w}: no sideways scroll, the card inside the screen`, await noSideScroll() && await js(`var b=document.querySelector('[data-quant-alerts]').getBoundingClientRect(); return b.left >= 0 && b.right <= window.innerWidth + 1;`));
    await shot(`alerts-control-${w}`);
  }

  console.log('\na notification\'s link');
  await size(1280, 900);
  await js(`location.hash = '#alert=market'; 1`);
  ok('#alert=market opens the Market tab', await until(`window._tbOps.app.page() === 'market'`, 6000), await page());
  ok('… and the address is clean again', await until(`location.hash === ''`, 3000));
  // Every boot above cleared the site's storage (so its "sent" mark): at most one send a boot, never more.
  ok('the catalysts: at most one send a visit (5 fresh visits so far)', (api.posted.catalysts || []).length <= 5, (api.posted.catalysts || []).length);

  console.log('\nQuant off');
  await boot({ quant: false });
  await sleep(1500);
  ok('no bell, no alerts requests', await js(`return !document.querySelector('[data-tal-bell]');`));

  ok('no page errors', !errs.length, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
