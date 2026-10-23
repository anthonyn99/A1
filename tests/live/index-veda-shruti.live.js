// LIVE: Shruti on Veda's TaskHub header (Tony, 2026-10-22). Fake Firestore
// (dashboards/navorder): added once when she has none, never doubled when she
// added her own, and a removal after the seed sticks.
//
//   node tests/live/index-veda-shruti.live.js
'use strict';
const path = require('path');
const A1 = path.join(__dirname, '..', '..');
const { connect, evalJs, sleep } = require(path.join(A1, 'tests', 'live', 'cdp.js'));
const { firebaseMock } = require(path.join(A1, 'tests', 'live', 'fake-firebase.js'));
const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -> ' + String(d).slice(0, 400) : '')); } };

async function run(c, label, vedaLinks, flag) {
  const nav = { tony: [], veda: [], vedaLinks, tonyLinks: [], tonyLinksMigrated: true, tonyLinksInLifeHub: true };
  if (flag) nav.vedaShrutiSeeded = true;
  await c.send('Page.navigate', { url: ORIGIN + '/A1/oneinbox.html' }); await sleep(800);
  await evalJs(c, `localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','veda'); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify({ 'dashboards/navorder': nav }))}); return 1;`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  await sleep(15000);
  const r = JSON.parse(await evalJs(c, `const d=(window.__fakeFs&&window.__fakeFs.docs['dashboards/navorder'])||{}; return JSON.stringify({links:(d.vedaLinks||[]).map(l=>l.label+'|'+l.url), flag:!!d.vedaShrutiSeeded, btn:[...document.querySelectorAll('button,a')].filter(b=>/^\\s*Shruti\\s*$/.test(b.textContent)).length});`));
  console.log(label, JSON.stringify(r));
  return r;
}
(async () => {
  const c = await connect({ mock: firebaseMock({}) });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const a = await run(c, 'no shruti yet:', [{ id: 'shield', label: 'Shield', url: ORIGIN + '/A1/shield.html' }], false);
  ok('Shruti is added to her links, once, and the flag is saved', a.links.filter((x) => /shruti\.html/i.test(x)).length === 1 && a.flag, JSON.stringify(a));
  ok('…and shows in her header', a.btn >= 1, a.btn);
  const b = await run(c, 'her own shruti:', [{ id: 'mine1', label: 'Shruti', url: ORIGIN + '/A1/Shruti/shruti.html?x=1' }], false);
  ok('a Shruti link she added herself is not doubled', b.links.filter((x) => /shruti/i.test(x)).length === 1 && b.flag, JSON.stringify(b));
  const d = await run(c, 'removed after seeding:', [], true);
  ok('once seeded, a removed Shruti stays removed', d.links.length === 0, JSON.stringify(d));
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
