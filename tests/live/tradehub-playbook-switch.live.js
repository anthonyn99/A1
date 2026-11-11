// The Playbook must open however its tab is reached (Tony, 2026-11-10: "sometimes
// I open Playbook and the journals don't load; I have to reload TradeHub").
//
// Notebook takes a moment to mount (it fetches its engines), and it builds its
// markup inside the box the host gave it when the mount began. TradeHub's box
// is React's and goes away with the tab, so leaving the tab during that moment
// used to leave Notebook's script in a box that was no longer on the page: it
// never ran, no Playbook was ever built, and only a reload brought it back.
//
//   1. leave the tab the instant the mount begins, come back: the Playbook is there
//   2. the same for Control's prompt editor (instance prm)
//   3. hop between tabs many times, fast: still there, exactly one of it
//   4. a mount that fails says so and offers Retry, and Retry opens it
//
// Run: node tests/live/tradehub-playbook-switch.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const URL = ORIGIN + '/A1/tradehub.html';
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
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 200; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(200); } return false; };
  const boot = async () => {
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10)); 1`);
    await c.send('Page.navigate', { url: URL });
    if (!(await until("document.querySelector('.tb-navtab')", 15000))) throw new Error('TradeHub did not render');
    await sleep(2000);
  };
  const TAB = (id) => `[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(b=>b.offsetParent)`;
  const go = (id) => js(`var t=${TAB(id)}; if(t) t.click(); 1`);
  const shown = `(function(){ var r=document.getElementById('pb-root'), h=document.querySelector('#tradeboard-root .tb-pb-host'); return !!(r && h && h.contains(r) && document.querySelectorAll('#pb-entries-list .entry-item').length > 0); })()`;
  // Leave for `away` the instant Notebook is told to mount `key`: mount() records
  // the instance (mounts[key] = cfg) right after the host's box was handed over.
  const leaveWhenMountBegins = (key, away) => js(`
    var m = window.Notebook.mounts, v;
    Object.defineProperty(m, '${key}', { configurable: true, enumerable: true,
      get: function () { return v; },
      set: function (x) { v = x; window.__left = (window.__left || 0) + 1; var t = ${TAB(away)}; if (t) t.click(); } });
    1`);

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log('\nLeaving the Playbook tab the instant it starts to open');
  await boot();
  await leaveWhenMountBegins('pb', 'journal');
  await go('playbook');
  ok('the tab was left while Notebook was mounting', await until('window.__left === 1', 8000));
  await sleep(4000);
  await go('playbook');
  ok('coming back, the Playbook is there with its pages', await until(shown, 15000),
    await js(`var h=document.querySelector('#tradeboard-root .tb-pb-host'); return 'host: ' + (h ? h.innerHTML.slice(0,120) : 'none') + ' | root: ' + !!document.getElementById('pb-root');`));
  ok('one Playbook, not two', await js(`return document.querySelectorAll('[id="pb-root"]').length === 1;`));

  console.log('\nComing back before the mount has finished');
  await boot();
  await leaveWhenMountBegins('pb', 'journal');
  await go('playbook');
  await until('window.__left === 1', 8000);
  await go('playbook');
  ok('the Playbook opens in the new box', await until(shown, 15000),
    await js(`var h=document.querySelector('#tradeboard-root .tb-pb-host'); return 'host: ' + (h ? h.innerHTML.slice(0,120) : 'none') + ' | root: ' + !!document.getElementById('pb-root');`));

  console.log('\nHopping between tabs, fast');
  await boot();
  for (const t of ['playbook', 'news', 'playbook', 'journal', 'playbook', 'control', 'playbook', 'catalysts']) { await go(t); await sleep(60); }
  await go('playbook');
  ok('the Playbook is there at the end', await until(shown, 15000));
  ok('one Playbook, not two', await js(`return document.querySelectorAll('[id="pb-root"]').length === 1;`));
  for (let i = 0; i < 6; i++) { await go(i % 2 ? 'playbook' : 'portfolio'); await sleep(120); }
  await go('playbook');
  ok('and after more hops once it is open', await until(shown, 8000));

  console.log("\nControl's prompt editor, left as it starts to open");
  await boot();
  await go('control');
  ok('Control shows a prompt with Edit', await until(`[...document.querySelectorAll('#tradeboard-root button')].some(b=>/^\\s*edit\\s*$/i.test(b.textContent)&&b.offsetParent)`, 10000));
  await leaveWhenMountBegins('prm', 'journal');
  await js(`var b=[...document.querySelectorAll('#tradeboard-root button')].find(b=>/^\\s*edit\\s*$/i.test(b.textContent)&&b.offsetParent); if(b) b.click(); 1`);
  ok('Control was left while the editor was mounting', await until('window.__left === 1', 8000));
  await sleep(4000);
  await go('control');
  await sleep(800);
  await js(`var b=[...document.querySelectorAll('#tradeboard-root button')].find(b=>/^\\s*edit\\s*$/i.test(b.textContent)&&b.offsetParent); if(b) b.click(); 1`);
  ok('back in Control, Edit opens the editor', await until(`(function(){ var r=document.getElementById('prm-root'), h=document.querySelector('#tradeboard-root .tb-pr-host'); return !!(r && h && h.contains(r)); })()`, 15000),
    await js(`var h=document.querySelector('#tradeboard-root .tb-pr-host'); return 'host: ' + (h ? h.innerHTML.slice(0,120) : 'none') + ' | root: ' + !!document.getElementById('prm-root');`));

  console.log('\nA mount that fails says so, and Retry opens it');
  await boot();
  await js(`window.__realMount = window.Notebook.mount; window.Notebook.mount = function () { return Promise.reject(new Error('test: offline')); }; 1`);
  await go('playbook');
  ok('the failure is shown with a Retry button', await until(`(function(){ var h=document.querySelector('#tradeboard-root .tb-pb-host'); return !!(h && h.querySelector('button.tb-pb-retry')); })()`, 10000),
    await js(`var h=document.querySelector('#tradeboard-root .tb-pb-host'); return h ? h.innerHTML.slice(0,200) : 'none';`));
  await js(`window.Notebook.mount = window.__realMount; var b=document.querySelector('#tradeboard-root .tb-pb-host button.tb-pb-retry'); if(b) b.click(); 1`);
  ok('Retry opens the Playbook', await until(shown, 15000));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
