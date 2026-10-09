// Notebook Phase 5: in Tony's TaskHub, MyJournal is no longer a built-in program
// but an External-Link entry (LEGACY_PROGRAMS 'myjournal', lock tony_myjournal)
// that still opens INSIDE TaskHub. Real index.html, fake Firestore.
//
//   1. a saved order from before (built-in 'brainstormjournal' in slot 2) is
//      migrated once: MyJournal's link, same slot, one write; Veda's untouched
//   2. the MyJournal button opens MyJournal in this page and lights up
//   3. Settings: not under Internal Programs, listed under External Links
//   4. a reload writes nothing more; a deleted MyJournal link stays deleted
//
// Run: node tests/live/myjournal-external.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const LINKS = [
  { id: 'tradehub', label: 'TradeHub', url: 'https://anthonyn99.github.io/A1/tradehub.html', color: '' },
  { id: 'vault', label: 'Vault', url: 'https://anthonyn99.github.io/A1/vault.html', color: '' },
  { id: 'warroom', label: 'RiftIQ', url: 'https://anthonyn99.github.io/A1/riftiq.html', color: '' },
];
const NAV = { tony: ['taskhub', 'brainstormjournal', 'custom:tradehub', 'custom:vault', 'custom:warroom'],
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
        var d=new Date(); localStorage.setItem('a1_sweep_day:index', d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2));
        sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/navorder': ${JSON.stringify(NAV)} })); 1`);
    }
    await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
    await sleep(10000);
    await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
    await sleep(1500);
  };
  const navWrites = () => js(`return JSON.stringify(__fakeFs.log.filter(l => l.path === 'dashboards/navorder'));`).then(JSON.parse);
  const btns = () => js(`return JSON.stringify([...document.querySelectorAll('#tony-app-nav-inner .tn-btn')].map(b => b.getAttribute('data-app')));`).then(JSON.parse);

  await boot(true);
  console.log('\nThe saved order is migrated once');
  const doc = JSON.parse(await js(`return JSON.stringify(__fakeFs.docs['dashboards/navorder']);`));
  ok('MyJournal\'s link is in the cloud', doc.tonyLinks.some((l) => l.id === 'myjournal' && l.label === 'MyJournal'), JSON.stringify(doc.tonyLinks));
  ok('...in the slot the built-in button had', JSON.stringify(doc.tony.slice(0, 3)) === JSON.stringify(['taskhub', 'custom:myjournal', 'custom:tradehub']), JSON.stringify(doc.tony));
  ok('no built-in brainstormjournal left in the order', doc.tony.indexOf('brainstormjournal') < 0);
  ok('Veda\'s order and links are untouched', JSON.stringify(doc.veda) === JSON.stringify(NAV.veda) && JSON.stringify(doc.vedaLinks) === '[]');
  const w1 = await navWrites();
  ok('it took one write', w1.length === 1, w1.length);
  const B = await btns();
  ok('the header shows it second, as a link button', B[0] === 'taskhub' && B[1] === 'custom:myjournal' && B.indexOf('brainstormjournal') < 0, JSON.stringify(B));

  console.log('\nIt opens inside TaskHub');
  await js(`window.__opened = 0; var _o = window.open; window.open = function(){ window.__opened++; return _o.apply(this, arguments); };
    var _t = window._tnOpenTab; window._tnOpenTab = function(){ window.__opened++; return _t.apply(this, arguments); }; 1`);
  await js(`document.querySelector('#tony-app-nav-inner .tn-btn[data-app="custom:myjournal"]').click(); 1`); await sleep(1500);
  ok('MyJournal is on screen, in this page', await js(`var r=document.getElementById('tj-root'); return !!r && getComputedStyle(r).display !== 'none' && getComputedStyle(document.getElementById('root')).display === 'none';`));
  ok('the in-page app id is unchanged', (await js('return window._tnCurApp;')) === 'brainstormjournal');
  ok('its button is lit, and only it', await js(`return [...document.querySelectorAll('#tony-app-nav-inner .tn-btn.tn-active')].map(b=>b.getAttribute('data-app')).join() === 'custom:myjournal';`),
    await js(`return [...document.querySelectorAll('#tony-app-nav-inner .tn-btn.tn-active')].map(b=>b.getAttribute('data-app')).join();`));
  ok('no tab was opened for it', (await js(`return window.__opened;`)) === 0);
  await js(`document.querySelector('#tony-app-nav-inner .tn-btn[data-app="taskhub"]').click(); 1`); await sleep(800);
  ok('TaskHub comes back', await js(`return getComputedStyle(document.getElementById('root')).display !== 'none' && getComputedStyle(document.getElementById('tj-root')).display === 'none';`));

  console.log('\nSettings');
  await js(`window._openSettings && window._openSettings('tony'); 1`); await sleep(800);
  const internal = await js(`return (document.getElementById('thset-locklist')||{}).innerText || '';`);
  const external = await js(`return (document.getElementById('thset-linklist')||{}).innerText || '';`);
  ok('MyJournal is not an Internal Program', !/MyJournal/.test(internal), internal);
  ok('it is listed under External Links', /MyJournal/.test(external), external);
  ok('...with its existing lock (tony_myjournal)', await js(`return window._navLinkLockId('tony','myjournal') === 'tony_myjournal';`));
  await js(`var x=document.querySelector('.thset-close'); if(x) x.click(); 1`);

  console.log('\nOnce only');
  await boot(false);
  ok('a reload writes nothing more', (await navWrites()).length === 0, JSON.stringify(await navWrites()));
  await js(`window._navRemoveLink('tony','myjournal'); 1`); await sleep(1500);
  await boot(false);
  const d2 = JSON.parse(await js(`return JSON.stringify(__fakeFs.docs['dashboards/navorder']);`));
  ok('a deleted MyJournal link stays deleted', !d2.tonyLinks.some((l) => l.id === 'myjournal') && d2.tony.indexOf('custom:myjournal') < 0 && (await btns()).indexOf('custom:myjournal') < 0, JSON.stringify(d2.tony));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
