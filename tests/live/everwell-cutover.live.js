// Everwell Phase 9 (A1-Priv docs/Everwell/plan.md): Tony's TaskHub button for
// Solace becomes Everwell's. Real index.html, fake Firestore.
//
//   1. a saved order with the 'solace' button in slot 3 is migrated once: same
//      slot, id/label/url Everwell's, one write; Veda's untouched
//   2. the button opens Everwell in its own named tab, gated on tony_everwell
//   3. a reload writes nothing more
//
// Run: node tests/live/everwell-cutover.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const EW = 'https://a1-priv.av1.workers.dev/everwell.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const LINKS = [
  { id: 'myjournal', label: 'MyJournal', url: 'https://anthonyn99.github.io/A1/#myjournal', color: '' },
  { id: 'tradehub', label: 'TradeHub', url: 'https://a1-priv.av1.workers.dev/tradehub.html', color: '' },
  { id: 'solace', label: 'Solace', url: 'https://a1-priv.av1.workers.dev/solace.html', color: '' },
  { id: 'warroom', label: 'RiftIQ', url: 'https://a1-priv.av1.workers.dev/riftiq.html', color: '' },
];
const NAV = { tony: ['taskhub', 'custom:myjournal', 'custom:solace', 'custom:tradehub', 'custom:warroom'],
  veda: ['taskhub', 'gita', 'journal'], tonyLinks: LINKS, vedaLinks: [], tonyLinksMigrated: true, savedAt: Date.now() - 60000 };

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const js = (e) => evalJs(c, e);
  const boot = async (seed) => {
    if (seed) {
      await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
      await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
      await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','tony'); localStorage.setItem('a1b_disabled','1');
        localStorage.setItem('nb_myjournal_link','1');
        var d=new Date(); localStorage.setItem('a1_sweep_day:index', d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2));
        sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/navorder': ${JSON.stringify(NAV)} })); 1`);
    }
    await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
    await sleep(10000);
    await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
    await sleep(1500);
  };
  const navWrites = () => js(`return JSON.stringify(__fakeFs.log.filter(l => l.path === 'dashboards/navorder'));`).then(JSON.parse);
  const btns = () => js(`return JSON.stringify([...document.querySelectorAll('#tony-app-nav-inner .tn-btn')].map(b => b.getAttribute('data-app') + '=' + b.textContent.trim()));`).then(JSON.parse);

  await boot(true);
  console.log('\nThe Solace button becomes Everwell\'s, once');
  const doc = JSON.parse(await js(`return JSON.stringify(__fakeFs.docs['dashboards/navorder']);`));
  const ew = doc.tonyLinks.filter((l) => l.id === 'everwell');
  ok('the cloud link is Everwell: id, label and address', ew.length === 1 && ew[0].label === 'Everwell' && ew[0].url === EW, JSON.stringify(doc.tonyLinks));
  ok('no Solace link is left', !doc.tonyLinks.some((l) => l.id === 'solace' || /solace/i.test(l.url + l.label)));
  ok('...in the slot Solace had', JSON.stringify(doc.tony.slice(0, 4)) === JSON.stringify(['taskhub', 'custom:myjournal', 'custom:everwell', 'custom:tradehub']), JSON.stringify(doc.tony));
  ok('the other links are untouched', JSON.stringify(doc.tonyLinks.filter((l) => l.id !== 'everwell')) === JSON.stringify(LINKS.filter((l) => l.id !== 'solace')));
  ok("Veda's order and links are untouched", JSON.stringify(doc.veda) === JSON.stringify(NAV.veda) && JSON.stringify(doc.vedaLinks) === '[]');
  const w1 = await navWrites();
  ok('it took one write', w1.length === 1, w1.length);
  const B = await btns();
  ok('the header shows "Everwell" third', B[2] === 'custom:everwell=Everwell' && !B.some((b) => /solace/i.test(b)), JSON.stringify(B));

  console.log('\nIt opens Everwell');
  ok('the button is gated on tony_everwell', await js(`return window._navLinkLockId('tony','everwell') === 'tony_everwell';`));
  await js(`window.__tabs = []; window._tnOpenTab = function(u, k){ window.__tabs.push([u, k]); return { closed: false }; }; 1`);
  await js(`document.querySelector('#tony-app-nav-inner .tn-btn[data-app="custom:everwell"]').click(); 1`); await sleep(1500);
  const tabs = JSON.parse(await js(`return JSON.stringify(window.__tabs);`));
  ok('a click opens Everwell in its named tab', tabs.length === 1 && tabs[0][0] === EW && tabs[0][1] === 'everwell', JSON.stringify(tabs));

  console.log('\nOnce only');
  await boot(false);
  ok('a reload writes nothing more', (await navWrites()).length === 0, JSON.stringify(await navWrites()));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
