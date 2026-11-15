// Beacon in every other host, real headless Edge, fake Firestore: MyList, MAGI,
// Shield, Shruti and StudyOS. For each one:
//   1. the page loads Beacon and mounts under its own app id
//   2. with a profile chosen, this device checks in to that profile's document
//      (StudyOS: always Veda's), with the program's entry and no page errors
//   3. the program's own Devices button opens the panel, in that profile's theme
// (TaskHub, with the full panel walk-through, is tests/live/beacon.live.js.)
//
// Run: node tests/live/beacon-hosts.live.js
'use strict';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const SR = "(document.querySelector('beacon-panel') && document.querySelector('beacon-panel').shadowRoot)";
const shot = async (c, name) => {
  const s = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(s.result.data, 'base64'));
};

// page, app, the profile to use, how to choose it, how to press the program's button.
const HOSTS = [
  { page: 'mylist.html', app: 'mylist', who: 'veda',
    choose: "chooseProfile('veda'); 1",
    press: "document.getElementById('devices-btn').click(); 1" },
  { page: 'magi.html', app: 'magi', who: 'tony',
    choose: "1",
    press: "document.getElementById('devBtn').click(); 1" },
  { page: 'shield.html', app: 'shield', who: 'tony',
    choose: "enterProfile('tony'); 1",
    press: "(function(){ var b=[].slice.call(document.querySelectorAll('[data-view=\"devices\"]'))[0]; if(b) b.click(); })(); 1",
    press2: "var x=document.getElementById('a-beacon'); if(!x) throw new Error('no All A1 devices button'); x.click(); 1" },
  { page: 'shruti.html', app: 'shruti', who: 'tony', pick: "sessionStorage.setItem('shruti.pick','tony');",
    choose: "1",
    press: "document.getElementById('settings-btn').click(); 1",
    press2: "var x=document.querySelector('#settings [data-devices]'); if(!x) throw new Error('no Devices button in Settings'); x.click(); 1" },
  { page: 'V1/studyos.html', app: 'studyos', who: 'veda',
    choose: "1",
    press: "document.getElementById('sos-devices-btn').click(); 1" },
];

async function host(c, h, errs) {
  console.log('\n' + h.page);
  errs.length = 0;
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await evalJs(c, "localStorage.clear(); sessionStorage.clear(); localStorage.setItem('th_device_id','dev_host1'); localStorage.setItem('a1b_disabled','1'); " + (h.pick || '') + " 1");
  await c.send('Page.navigate', { url: ORIGIN + '/A1/' + h.page });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { await sleep(500); ready = await evalJs(c, "return !!(window.Beacon && Beacon.apps && Beacon.apps().length);"); }
  ok('Beacon loaded and mounted', ready);
  ok("mounted as '" + h.app + "'", await evalJs(c, "return Beacon.apps().indexOf(" + JSON.stringify(h.app) + ") >= 0;"));
  await sleep(4500);
  if (h.choose !== '1') ok('nothing is recorded while the picker is up', await evalJs(c, "return !Object.keys((window.__fakeFs||{docs:{}}).docs).some(function(k){ return /beacon_/.test(k); });"));
  await evalJs(c, h.choose);
  // Wait for this device in the profile's document.
  let rec = null;
  for (let i = 0; i < 40 && !rec; i++) {
    await sleep(500);
    rec = JSON.parse(await evalJs(c, "return JSON.stringify((((window.__fakeFs||{docs:{}}).docs['dashboards/beacon_" + h.who + "']||{}).devices||{}).dev_host1||null);"));
    if (rec && !(rec.apps && rec.apps[h.app])) rec = null;
  }
  ok('checks in to ' + h.who + '’s document under ' + h.app, !!rec, JSON.stringify(rec));
  const other = h.who === 'tony' ? 'veda' : 'tony';
  ok('and not to ' + other + '’s', await evalJs(c, "return !((((window.__fakeFs||{docs:{}}).docs['dashboards/beacon_" + other + "']||{}).devices||{}).dev_host1);"));
  ok('with the program’s profile recorded', !!(rec && rec.apps[h.app].profs && rec.apps[h.app].profs[h.who]), rec && JSON.stringify(rec.apps[h.app]));
  await evalJs(c, h.press);
  await sleep(900);
  if (h.press2) { await evalJs(c, h.press2); await sleep(900); }
  let open = false;
  for (let i = 0; i < 20 && !open; i++) { open = await evalJs(c, 'return !!' + SR + ' && !!' + SR + ".querySelector('[data-dev]');"); if (!open) await sleep(300); }
  ok('its Devices button opens the panel, with this device in it', open);
  const theme = await evalJs(c, 'return ' + SR + " ? " + SR + ".querySelector('.ov').getAttribute('data-theme') : null;");
  ok('in ' + h.who + '’s theme', theme === h.who, theme);
  ok('the panel shows ' + h.page.replace(/^V1\//, '').replace('.html', '') + '’s own tab', await evalJs(c, 'return !!' + SR + " && !!" + SR + ".querySelector('[data-scope=\"app\"]');"));
  await shot(c, 'beacon-host-' + h.app);
  await evalJs(c, 'var R=' + SR + "; if (R) R.querySelector('[data-x]').click(); 1");
  const mine = errs.filter((e) => /beacon|Beacon/.test(e));
  ok('no page errors from Beacon', !mine.length, mine.join(' | '));
}

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text);
  });
  const only = process.env.BEACON_HOST;
  for (const h of HOSTS) if (!only || h.app === only) await host(c, h, errs);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
