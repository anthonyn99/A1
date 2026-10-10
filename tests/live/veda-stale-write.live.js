// The 2026-10-10 revert: a phone tab asleep since Oct 7 woke, took a tap before
// the fresh doc was applied, and pushed its 3-day-old state over two days of edits.
// Real index.html, fake Firestore. The sequence:
//
//   1. Veda's TaskHub loads the cloud doc (base = its savedAt)
//   2. the page is backgrounded (pagehide → teardown, listeners gone)
//   3. another device writes a newer doc
//   4. a save is built from this tab's stale state and parked
//   5. the page comes back: the listener confirms the server, the parked save replays
//
// Expect: the stale save is refused, the cloud keeps the other device's doc, and
// the page repaints with it. Then a fresh edit saves normally.
//
// Run: node tests/live/veda-stale-write.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

const pad = (n) => ('0' + n).slice(-2);
const d = new Date();
const TODAY = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
const WEEK = monday.getFullYear() + '-' + pad(monday.getMonth() + 1) + '-' + pad(monday.getDate());
const task = (id, title) => ({ id, title, type: 'task', done: false, category: '', repeat: 'none', notifyRepeat: 'none' });
const OLD = { data: { [TODAY]: [task('t_old', 'Old task')] }, habits: [], hc: {}, goals: [], monthlyGoals: [],
  rules: [], rulesDaily: {}, weekKey: WEEK, savedAt: Date.now() - 3 * 86400000 };
const NEW = { ...OLD, data: { [TODAY]: [task('t_old', 'Old task'), task('t_new', 'Added on the PC')] }, savedAt: Date.now() - 60000 };

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','veda'); localStorage.setItem('a1b_disabled','1');
    localStorage.setItem('a1_sweep_day:index', ${JSON.stringify(TODAY)});
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/vedasdash': ${JSON.stringify(OLD)} })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  await sleep(10000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  await sleep(1500);
  const vdWrites = () => js(`return __fakeFs.log.filter(l => l.path === 'dashboards/vedasdash' && !l.remote).length;`);
  const cloudIds = () => js(`return JSON.stringify((__fakeFs.docs['dashboards/vedasdash'].data[${JSON.stringify(TODAY)}]||[]).map(t=>t.id));`).then(JSON.parse);
  const localIds = () => js(`return JSON.stringify((JSON.parse(localStorage.getItem('td_data')||'{}')[${JSON.stringify(TODAY)}]||[]).map(t=>t.id));`).then(JSON.parse);

  console.log('\nLoad');
  ok('Veda\'s TaskHub is mounted with the cloud doc', JSON.stringify(await localIds()) === '["t_old"]', JSON.stringify(await localIds()));
  ok('the base is the loaded doc', Number(await js(`return localStorage.getItem('td_base_saved_at');`)) === OLD.savedAt,
    await js(`return localStorage.getItem('td_base_saved_at');`));

  console.log('\nResume with a save built on the stale copy');
  await js(`window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m)); 1`);
  const before = await vdWrites();
  await js(`window.dispatchEvent(new Event('pagehide')); 1`); await sleep(800);
  await js(`__fakeFs.remote('dashboards/vedasdash', ${JSON.stringify(NEW)}); 1`); await sleep(300);
  await js(`document.dispatchEvent(new PointerEvent('pointerdown')); 1`);
  // A save built from this tab's state, which still holds only the old task.
  await js(`window._fbSaveVeda(window._vdRebuildPayload()); 1`); await sleep(1200);
  ok('the save is parked while the connection is down', (await vdWrites()) === before, (await vdWrites()) - before);
  await js(`Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); 1`);
  await sleep(4000);
  ok('the stale save never reached the cloud', (await vdWrites()) === before, (await vdWrites()) - before);
  ok('the cloud keeps the other device\'s task', JSON.stringify(await cloudIds()) === '["t_old","t_new"]', JSON.stringify(await cloudIds()));
  ok('the page repainted with the cloud copy', JSON.stringify(await localIds()) === '["t_old","t_new"]', JSON.stringify(await localIds()));
  ok('the base moved to the cloud doc', Number(await js(`return localStorage.getItem('td_base_saved_at');`)) === NEW.savedAt);
  const alerts = JSON.parse(await js(`return JSON.stringify(window.__alerts);`));
  ok('she is told to redo her last change', alerts.length === 1 && /out of date/.test(alerts[0]), JSON.stringify(alerts));

  console.log('\nA fresh save afterwards');
  await js(`window._fbSaveVeda(window._vdRebuildPayload()); 1`); await sleep(1500);
  ok('it is written', (await vdWrites()) === before + 1, (await vdWrites()) - before);
  ok('and it still holds both tasks', JSON.stringify(await cloudIds()) === '["t_old","t_new"]', JSON.stringify(await cloudIds()));
  ok('no _base leaked into the doc', await js(`return !('_base' in __fakeFs.docs['dashboards/vedasdash']);`));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  try { c.ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
