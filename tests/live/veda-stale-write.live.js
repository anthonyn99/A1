// The 2026-10-10 revert: a phone tab asleep since Oct 7 woke, took a tap before
// the fresh doc was applied, and pushed its 3-day-old state over two days of
// edits. Since 2026-10-19 every TaskHub save is versioned
// (docs/TaskHub/versioned-save.md): the doc carries `rev`, its head
// dashboards/vedasdash_head holds the current one, and a save built on an
// older version is never written over the newer doc. It is MERGED with it
// (both sides' changes kept), saved at a new version and shown. (Before that
// the save was refused and Veda was asked to redo her change.)
// tests/taskhub-sync.test.js runs the merge rules with two browsers; this is
// the sleeping-phone sequence on Veda's side, in one.
//
// Real index.html, fake Firestore. The sequence:
//   1. Veda's TaskHub opens on the cloud doc (rev 5)
//   2. the page is backgrounded (pagehide: teardown, listeners gone)
//   3. the PC saves a newer version (rev 6, a task added)
//   4. the phone adds a task of its own, on its stale copy, while still down
//   5. the page comes back
// Expect: the cloud and the page hold all three tasks, at a version above the
// PC's with the head matching, and nothing asks her to redo anything. Then a
// fresh edit saves normally.
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
  rules: [], rulesDaily: {}, weekKey: WEEK, savedAt: Date.now() - 3 * 86400000, rev: 5 };
const NEW = { ...OLD, data: { [TODAY]: [task('t_old', 'Old task'), task('t_new', 'Added on the PC')] }, savedAt: Date.now() - 60000, rev: 6 };

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 200; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(200); } return false; };
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','veda'); localStorage.setItem('a1b_disabled','1');
    localStorage.setItem('a1_sweep_day:index', ${JSON.stringify(TODAY)});
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/vedasdash': ${JSON.stringify(OLD)},
      'dashboards/vedasdash_head': { rev: 5, savedAt: ${OLD.savedAt}, by: 'phone' } })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  if (await until('window._profileGoVeda', 30000)) await js(`window._profileGoVeda(); 1`);
  await until(`window._vdVoice && window._vdVoice.getState && (window._vdVoice.getState().data || {})[${JSON.stringify(TODAY)}]`, 20000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  await sleep(1500);
  const vdWrites = () => js(`return __fakeFs.log.filter(l => l.path === 'dashboards/vedasdash' && !l.remote).length;`);
  const cloudIds = () => js(`return JSON.stringify((__fakeFs.docs['dashboards/vedasdash'].data[${JSON.stringify(TODAY)}]||[]).map(t=>t.id).sort());`).then(JSON.parse);
  const pageIds = () => js(`return JSON.stringify(((window._vdVoice.getState().data||{})[${JSON.stringify(TODAY)}]||[]).map(t=>t.id).sort());`).then(JSON.parse);
  const ALL = '["t_new","t_old","t_phone"]';

  console.log('\nLoad');
  ok('Veda\'s TaskHub is open on the cloud doc', JSON.stringify(await pageIds()) === '["t_old"]', JSON.stringify(await pageIds()));

  console.log('\nAsleep: the PC saves a newer version, the phone edits its stale copy');
  await js(`window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m)); 1`);
  let before = await vdWrites();
  await js(`window.dispatchEvent(new Event('pagehide')); 1`); await sleep(800);
  await js(`__fakeFs.remote('dashboards/vedasdash', ${JSON.stringify(NEW)}); __fakeFs.remote('dashboards/vedasdash_head', { rev: 6, savedAt: ${NEW.savedAt}, by: 'pc' }); 1`);
  await sleep(300);
  await js(`document.dispatchEvent(new PointerEvent('pointerdown'));
    window._vdVoice.mutateData(p => Object.assign({}, p, { ${JSON.stringify(TODAY)}: ((p || {})[${JSON.stringify(TODAY)}] || []).concat([${JSON.stringify(task('t_phone', 'Added on the phone'))}]) })); 1`);
  await sleep(1200);
  ok('nothing is written while the page is down', (await vdWrites()) === before, (await vdWrites()) - before);

  console.log('\nThe page comes back');
  await js(`Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow')); 1`);
  let cloud = [];
  for (let i = 0; i < 50; i++) { await sleep(200); cloud = await cloudIds(); if (JSON.stringify(cloud) === ALL) break; }
  ok('the stale copy never replaced the newer doc: the PC\'s task and the phone\'s are both in the cloud', JSON.stringify(cloud) === ALL, JSON.stringify(cloud));
  ok('the page shows all three', await until(`JSON.stringify(((window._vdVoice.getState().data||{})[${JSON.stringify(TODAY)}]||[]).map(t=>t.id).sort()) === ${JSON.stringify(ALL)}`, 8000),
    JSON.stringify(await pageIds()));
  ok('saved at a new version, above the PC\'s, its head matching', await js(`var d=__fakeFs.docs['dashboards/vedasdash'], h=__fakeFs.docs['dashboards/vedasdash_head']; return d.rev > 6 && h && h.rev === d.rev;`),
    await js(`return JSON.stringify([__fakeFs.docs['dashboards/vedasdash'].rev, __fakeFs.docs['dashboards/vedasdash_head']]);`));
  const alerts = JSON.parse(await js(`return JSON.stringify(window.__alerts);`));
  ok('nothing asks her to redo a change (the merge kept it)', alerts.length === 0, JSON.stringify(alerts));

  console.log('\nA fresh edit afterwards');
  before = await vdWrites();
  await js(`window._vdVoice.mutateData(p => Object.assign({}, p, { ${JSON.stringify(TODAY)}: ((p || {})[${JSON.stringify(TODAY)}] || []).concat([${JSON.stringify(task('t_after', 'Later'))}]) })); 1`);
  for (let i = 0; i < 40 && (await vdWrites()) === before; i++) await sleep(200);
  ok('it is written', (await vdWrites()) > before, (await vdWrites()) - before);
  ok('and the cloud holds all four tasks', await until(`(__fakeFs.docs['dashboards/vedasdash'].data[${JSON.stringify(TODAY)}]||[]).length === 4`, 8000), JSON.stringify(await cloudIds()));
  ok('no _base leaked into the doc', await js(`return !('_base' in __fakeFs.docs['dashboards/vedasdash']) && !('_baseRev' in __fakeFs.docs['dashboards/vedasdash']);`));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  try { c.ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
