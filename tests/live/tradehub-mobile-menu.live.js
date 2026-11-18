// TradeHub on a phone: its menu (the three lines) must not open a Playbook entry
// (Tony, 2026-11-18: "when I tap 3 lines to get the side panel, it goes into a
// journal entry"). The menu asks Notebook to close its drawer so the two never
// overlap; on a phone Notebook's list is a screen, not a drawer, and closing it
// opened the last entry.
//
//   1. the Playbook's list is up: the menu opens over it, and the list is still
//      there when the menu closes (no entry opened)
//   2. an entry is open: the menu leaves that entry open
//
// Run: node tests/live/tradehub-mobile-menu.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const worker = {
  patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'],
  handle(req) { return req.method === 'OPTIONS' ? { status: 204, text: '' } : { json: { ok: true } }; },
};

(async () => {
  const c = await connect({ mock: firebaseMock(worker) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 200; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(200); } return false; };
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10)); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/tradehub.html' });
  if (!(await until("document.querySelector('.tb-navtab')", 20000))) throw new Error('TradeHub did not render');
  await sleep(2000);
  await js(`var b=document.querySelector('.tb-navtab[data-navid="playbook"]'); if(b) b.click(); 1`);
  ok('the Playbook mounts', await until(`document.querySelector('#pb-root.nb-shell') && document.querySelectorAll('#pb-entries-list .entry-item').length`, 20000));
  await sleep(1000);

  const cls = () => js(`return document.getElementById('pb-root').className;`);
  const active = () => js(`var a=document.querySelector('#pb-entries-list .entry-item.active'); return a ? a.getAttribute('data-entry-id') : null;`);
  const menu = async () => {
    await js(`document.querySelector('.tb-mtop-burger').click(); 1`); await sleep(600);
    const open = await js(`return document.querySelector('.tb-mobile-header').classList.contains('is-open');`);
    const during = await cls();
    await js(`document.querySelector('.tb-mobile-header .tb-scrim').click(); 1`); await sleep(600);
    return { open, during };
  };

  // 1. the list is up
  await js(`var r=document.getElementById('pb-root'); if(!r.classList.contains('nb-mlist')) document.getElementById('pb-hamburger').click(); 1`);
  await sleep(600);
  ok('the list is on screen', /\bnb-mlist\b/.test(await cls()), await cls());
  let m = await menu();
  ok('the menu opens', m.open);
  ok('the list stays while the menu is open (no entry opens)', /\bnb-mlist\b/.test(m.during) && !/\bnb-mdoc\b/.test(m.during), m.during);
  ok('the list is still there after the menu closes', /\bnb-mlist\b/.test(await cls()), await cls());

  // 2. an entry is open
  await js(`document.querySelector('#pb-entries-list .entry-item').click(); 1`); await sleep(800);
  const id = await active();
  ok('an entry opens from the list', /\bnb-mdoc\b/.test(await cls()) && !!id, await cls());
  m = await menu();
  ok('the menu leaves that entry open', /\bnb-mdoc\b/.test(await cls()) && (await active()) === id, await cls());

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
