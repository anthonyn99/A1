// TradeHub Quant, Phase 14 in the real page (A1-Priv tradehub.html + TradeHub/ui/alerts.js),
// quant-api played here (quant-mock.js):
//   1. the bell: in the sidebar's foot (1280, 820) and the phone bar (390), with the unseen
//      count; it opens the list of recent alerts (who received each, or why not); opening it
//      marks them seen; a press on one opens what it is about (#alert=chart:NVDA → Charts)
//   2. Control ▸ Alerts: the eight kinds (Batch 4 T7 added "Your paper orders", N8 "Neo Cortex") with "market hours only" and "TaskHub card", quiet
//      hours, mute a ticker, the rules list, a new rule, delete asks first, Send test names
//      the devices
//   3. a notification's link (#alert=market) opens the Market tab and leaves the address clean
//   4. the catalysts are sent at most once (they did not change); with Quant off there is no bell
//   5. no sideways scroll at any width
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-alerts.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, CLOCK } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};

(async () => {
  const api = quantApi();
  const now = Date.now();
  let DAY3 = '';
  const seedState = () => {
    api.state.alerts = [
      { id: 'r1', symbol: 'NVDA', kind: 'price', price: 170.6, params: { dir: 'above', holds: true }, note: 'set by Neo Quant', created: now - 5000 },
      { id: 'r2', symbol: 'AMD', kind: 'level', price: 150.25, level: 'R1 Strong', created: now - 4000 },
      { id: 'r3', symbol: null, kind: 'signal', params: { setup: 'orb' }, created: now - 3000 },
    ];
    // C3: today (NVDA twice, a kept test send), yesterday, and a day before that. ids = arrival order; two unread (6, 4).
    const U = 'https://a1-priv.av1.workers.dev/tradehub.html#alert=';
    api.state.alertFires = [
      { id: 6, rule_id: 'test', at: CLOCK - 60000, kind: 'signal', symbol: 'AMD', title: '[Test] New GO: AMD breakout', body: 'long swing, entry 162.50', url: U + 'scanner', pushed: 1, devices: ['Tony PC', 'Pixel 9'], seen: false },
      { id: 5, rule_id: 'r1', at: CLOCK - 90000, kind: 'price', symbol: 'NVDA', title: 'NVDA crossed below 166.40', body: 'NVDA 166.31', url: U + 'chart:NVDA', pushed: 1, devices: ['Tony PC', 'Pixel 9'], seen: true },
      { id: 4, rule_id: 'r1', at: CLOCK - 120000, kind: 'price', symbol: 'NVDA', title: 'NVDA crossed above 170.60', body: 'NVDA 171.02, held for two checks', url: U + 'chart:NVDA', pushed: 1, devices: ['Tony PC', 'Pixel 9'], seen: false },
      { id: 3, rule_id: 'r3', at: CLOCK - 3600000, kind: 'signal', symbol: 'MU', title: 'New GO: MU orb', body: 'long day', url: U + 'signal:s0001', pushed: null, why: 'quiet hours', devices: [], seen: true },
      { id: 2, rule_id: 'std:data', at: CLOCK - 86400000, kind: 'data', symbol: null, title: 'alpaca is down for 12 min', body: '', url: U + 'status', pushed: 1, devices: ['Tony PC'], seen: true },
      { id: 1, rule_id: 'std:regime', at: CLOCK - 2 * 86400000, kind: 'regime', symbol: null, title: 'Regime: Constructive → Risk-off', body: 'At the midday snapshot', url: U + 'market', pushed: 1, devices: ['Tony PC'], seen: true },
    ];
    DAY3 = new Date(CLOCK - 2 * 86400000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
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
    ok('the center opens from the bell with every alert, days grouped', await until(`document.querySelectorAll('[data-tal-list] [data-tal-fire]').length + document.querySelectorAll('[data-tal-list] [data-tal-stack]').length >= 5`, 5000)
      && await js(`return [...document.querySelectorAll('[data-tal-day] .tac-dayname')].map(function(e){return e.textContent;}).join('|') === 'Today|Yesterday|' + ${JSON.stringify(DAY3)};`),
      await js(`return [...document.querySelectorAll('[data-tal-day] .tac-dayname')].map(function(e){return e.textContent;}).join('|');`));
    const text = await js(`return document.querySelector('[data-tal-list]').innerText;`);
    ok('each says who received it, or why not', /Tony PC, Pixel 9/.test(text) && /Quiet hours · not pushed/.test(text), text);
    ok('time of day on each row, and "ago" on today\'s', /\d{1,2}:\d{2} [AP]M/.test(text) && /\dm ago|\dh ago/.test(text));
    ok('test sends are kept, marked Test', await js(`return !!document.querySelector('[data-tal-fire="6"] [data-tal-test]');`));
    ok('repeats of NVDA today fold into one row with their count', await js(`var s=document.querySelector('[data-tal-stack]'); return !!s && /NVDA/.test(s.innerText) && s.querySelector('[data-tal-stack-n]').textContent === '2';`));
    await js(`document.querySelector('[data-tal-stack]').click(); 1`);
    ok('…a tap opens the stack: both NVDA alerts', await until(`document.querySelector('[data-tal-stack]').getAttribute('aria-expanded') === 'true' && !!document.querySelector('[data-tal-fire="4"]') && !!document.querySelector('[data-tal-fire="5"]')`, 3000));
    ok('the center fits the screen (no sideways scroll)', await noSideScroll() && await js(`var b=document.querySelector('[data-tal-list]').getBoundingClientRect(); return b.left >= 0 && b.right <= window.innerWidth + 0.5;`));
    if (w < 600) {
      ok('phone: a full-height sheet', await js(`var b=document.querySelector('[data-tal-list]').getBoundingClientRect(); return b.top <= 1 && b.height >= innerHeight - 2;`));
      ok('phone: rows and clear buttons are finger-sized (≥ 36 px), the clear always shown', await js(`return [...document.querySelectorAll('.tac-row > [data-tal-clear]')].every(function(b){var r=b.getBoundingClientRect(); return r.height >= 36 && getComputedStyle(b).visibility === 'visible';}) && [...document.querySelectorAll('.tac-open')].every(function(b){return b.getBoundingClientRect().height >= 44;});`));
      ok('phone: the day heads stay on top while the list scrolls', await js(`return getComputedStyle(document.querySelector('.tac-dayhead')).position === 'sticky';`));
    } else {
      ok('desktop: a centred sheet' + (w > 820 ? ' with the filters in a rail beside the list' : ' with the filters over the list'), await js(`var b=document.querySelector('[data-tal-list]').getBoundingClientRect(), f=document.querySelector('.tac-filters').getBoundingClientRect(), m=document.querySelector('[data-tal-scroll]').getBoundingClientRect(); return Math.abs((b.left + b.right) / 2 - innerWidth / 2) < 2 && (${w > 820} ? f.right <= m.left + 1 : f.bottom <= m.top + 1);`));
    }
    await shot(`alerts-center-${w}`);
    const seen0 = api.posted.seen || 0, clears0 = (api.posted.clears || []).length;
    ok('opening it no longer marks everything read (the count stays until Mark all read)', await js(`var n=document.querySelector('${bell} [data-tal-count]'); return n && !n.hidden;`) && (api.posted.seen || 0) === seen0);
    await js(`document.querySelector('[data-tal-filter="signal"]').click(); 1`);
    ok('filter Signals: only the signal alerts, asked of quant-api', await until(`document.querySelectorAll('[data-tal-list] [data-tal-fire]').length === 2 && document.querySelector('[data-tal-filter="signal"]').getAttribute('aria-pressed') === 'true'`, 4000) && api.posted.firesAsked.some((s) => /kinds=signal/.test(s)));
    await js(`document.querySelector('[data-tal-filter="all"]').click(); 1`); await until(`document.querySelectorAll('[data-tal-day]').length === 3`, 4000);
    await js(`document.querySelector('[data-tal-unread]').click(); 1`);
    ok('Unread: only what is unread', await until(`document.querySelector('[data-tal-unread]').getAttribute('aria-pressed') === 'true' && !document.querySelector('[data-tal-fire="2"]') && !!document.querySelector('[data-tal-fire="6"]')`, 4000));
    await js(`document.querySelector('[data-tal-unread]').click(); 1`); await until(`!!document.querySelector('[data-tal-fire="2"]')`, 4000);
    // Clear: one, after a confirm; "No" keeps it.
    await js(`window.__asked=[]; window.uiConfirm=function(m,o){ window.__asked.push([m,o&&o.title]); return Promise.resolve(false); }; document.querySelector('.tac-row[data-tal-row="2"] [data-tal-clear]').click(); 1`);
    await sleep(300);
    ok('clear one asks first; "No" keeps it', await js(`return window.__asked.length === 1 && /Clear "/.test(window.__asked[0][0]) && !!document.querySelector('[data-tal-fire="2"]');`) && (api.posted.clears || []).length === clears0);
    await js(`window.uiConfirm=function(m,o){ window.__asked.push([m,o&&o.title]); return Promise.resolve(true); }; document.querySelector('.tac-row[data-tal-row="2"] [data-tal-clear]').click(); 1`);
    ok('"Yes" clears just that one', await until(`!document.querySelector('[data-tal-fire="2"]')`, 4000) && JSON.stringify(api.posted.clears.slice(-1)[0]) === JSON.stringify({ ids: [2] }));
    await js(`document.querySelector('[data-tal-day]:last-of-type [data-tal-clearday]').click(); 1`);
    ok('Clear on a day head clears that day (after a confirm naming it)', await until(`document.querySelectorAll('[data-tal-day]').length === 1`, 4000) && /from /.test(await js(`return window.__asked[window.__asked.length-1][0];`)));
    await js(`document.querySelector('[data-tal-readall]').click(); 1`);
    ok('Mark all read: the bell\'s count goes, nothing unread is left', await until(`(function(){var n=document.querySelector('${bell} [data-tal-count]'); return n && n.hidden && !document.querySelector('.tac-row.is-unread'); })()`, 4000));
    await js(`document.querySelector('[data-tal-fire="4"]') || document.querySelector('[data-tal-stack]').click(); 1`); await until(`!!document.querySelector('[data-tal-fire="4"]')`, 3000);
    await js(`document.querySelector('[data-tal-fire="4"]').click(); 1`);
    ok('a press on an alert opens what it is about (Charts, NVDA)', await until(`!document.querySelector('[data-tal-list]')`, 3000) && await until(`window._tbOps && window._tbOps.app && window._tbOps.app.page() === 'charts'`, 8000), await page());
    ok('… with NVDA on the chart', await until(`window._tbOps.charts && window._tbOps.charts.get().symbol === 'NVDA'`, 8000));
    await js(`document.querySelector('${bell}').click(); 1`); await until(`(function(){ var b=document.querySelector('[data-tal-clearall]'); return b && !b.disabled; })()`, 4000);
    await js(`document.querySelector('[data-tal-clearall]').click(); 1`);
    ok('Clear all asks first, then empties the center (the empty state shows)', await until(`!!document.querySelector('[data-tal-empty]')`, 4000) && /every alert/.test(await js(`return window.__asked[window.__asked.length-1][0];`)) && JSON.stringify(api.posted.clears.slice(-1)[0]) === JSON.stringify({ all: true }));
    await js(`document.querySelector('[data-tal-close]').click(); 1`);
  }

  console.log('\nControl ▸ Alerts (1280)');
  seedState();
  await size(1280, 900);
  await boot({ quant: true });
  await js(`window.tbControlShow('alerts'); 1`);   // R9: Control ▸ Alerts is its own section
  await tab('prompt');
  ok('the card is there', await until(`document.querySelector('[data-tal-control] [data-tal-group]')`, 15000));
  ok('eight kinds (T7: your paper orders, N8: Neo Cortex), each with "market hours only" and "TaskHub card"', await js(`return document.querySelectorAll('[data-tal-kind]').length === 8 && document.querySelectorAll('[data-tal-market]').length === 8 && document.querySelectorAll('[data-tal-card]').length === 8;`));
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
  ok('Beacon loads from TradeHub\'s own site (/a1/dm/core.js): Brave Shields blocks a third-party beacon.js', await js(`return [...document.scripts].some(function(s){return s.getAttribute('src') === '/a1/dm/core.js';}) && ![...document.scripts].some(function(s){return /github\\.io\\/A1\\/Beacon\\/beacon\\.js/.test(s.src);});`));
  ok('Beacon is mounted as tradehub', await until(`window.Beacon && window.Beacon.deviceId && !!window.Beacon.deviceId()`, 15000));
  await js(`document.querySelector('[data-tal-devices-panel]').click(); 1`);
  const PANEL = `(document.querySelector('beacon-panel') && document.querySelector('beacon-panel').shadowRoot)`;
  ok('…it opens Beacon\'s panel with TradeHub\'s alerts at the top: this device not registered, a Register button', await until(`${PANEL} && ${PANEL}.querySelector('[data-alerts-head] [data-alerts-reg]')`, 15000)
    && /not registered for TradeHub alerts/.test(await js(`return ${PANEL}.querySelector('[data-alerts-head]').textContent;`)), await js(`var r=${PANEL}; return r ? r.querySelector('[data-body]').innerText.slice(0,300) : 'no panel';`));
  ok('…each device carries its TradeHub alerts line', await js(`var r=${PANEL}; return r.querySelectorAll('[data-dev]').length === 0 || r.querySelectorAll('[data-alerts-dev]').length === r.querySelectorAll('[data-dev]').length;`));
  await shot('alerts-beacon-1280');
  await js(`${PANEL}.querySelector('[data-x]').click(); 1`); await sleep(300);
  // 2026-11-21: a tap on an alert with TradeHub already open (on Portfolio) only focused the tab. The push worker now
  // posts the alert's link; the page goes there itself.
  await tab('portfolio'); await sleep(500);
  await js(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'tb-alert-open', url: location.origin + location.pathname + '#alert=chart:AMD' } })); 1`);
  ok('a tapped alert, TradeHub already open on Portfolio: the open tab goes to the alert\'s place (Charts, AMD)', await until(`window._tbOps && window._tbOps.app && window._tbOps.app.page() === 'charts' && window._tbOps.charts && window._tbOps.charts.get().symbol === 'AMD'`, 10000), await js(`return window._tbOps && window._tbOps.app ? window._tbOps.app.page() : 'no ops';`));
  await js(`window.tbControlShow('alerts'); 1`); await tab('prompt'); await until(`document.querySelector('[data-tal-test]')`, 10000);
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
