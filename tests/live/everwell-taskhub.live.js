// Everwell → Tony's TaskHub (A1-Priv/docs/Everwell/plan.md, Phase 5), in the
// real index.html against the fake Firestore:
//
//   • the rotation in dashboards/everwell_tony becomes ONE Health task per day
//     (today + 6, rest days skipped), tagged _ewId, saved by TaskHub itself;
//   • past days are never touched; Tony's own tasks and habits never are;
//   • a rotation change re-titles the SAME item and keeps its `done`; a rest
//     day removes it; repeated runs never duplicate;
//   • Everwell's own "Prayer" row sits in Daily Habits; a tick here writes
//     dashboards/everwell_prayer (one date, merged) and a tick from Everwell
//     shows here; habits / hc in dashboards/main are never used for it;
//   • nothing of this exists on Veda's side.
//
// Run: node tests/live/everwell-taskhub.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const pad = (n) => ('0' + n).slice(-2);
const key = (dt) => dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
const now = new Date();
const day = (i) => key(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
const TODAY = day(0), YESTERDAY = day(-1);
const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
const WEEK = key(monday);
const task = (id, title, extra) => Object.assign({ id, title, type: 'task', done: false, category: '', repeat: 'none', notifyRepeat: 'none' }, extra || {});
const MAIN = {
  data: { [TODAY]: [task('t_own', 'My own task')], [YESTERDAY]: [task('ew_workout_' + YESTERDAY, 'Workout: Legs', { _ewId: 'ew_workout_' + YESTERDAY, category: 'health', done: true })] },
  habits: [{ id: 'h_pray', title: 'Prayer' }, { id: 'h_read', title: 'Read 20 pages' }], hc: { ['h_read-' + now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate()]: true },
  goals: [], monthlyGoals: [], weekKey: WEEK, savedAt: Date.now() - 60000,
};
const ROT = { steps: [{ id: 'a', name: 'Push' }, { id: 'b', name: 'Pull' }, { id: 'c', name: 'Rest', rest: true }], anchor: { date: TODAY, idx: 0 }, log: [] };

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','tony'); localStorage.setItem('a1b_disabled','1');
    localStorage.setItem('a1_sweep_day:index', ${JSON.stringify(TODAY)});
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/main': ${JSON.stringify(MAIN)}, 'dashboards/everwell_tony': { rotation: ${JSON.stringify(ROT)}, tabOrder: ['dashboard'] } })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  await sleep(10000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  await sleep(2500);
  const cloud = () => js(`return JSON.stringify(__fakeFs.docs['dashboards/main']);`).then(JSON.parse);
  const ew = (doc, dk) => (doc.data[dk] || []).filter((t) => t && t._ewId);

  console.log('\nWorkout tasks from the rotation');
  let m = await cloud();
  const titles = [0, 1, 2, 3, 4, 5, 6].map((i) => ew(m, day(i)).map((t) => t.title).join('+') || '-');
  ok('today + 6 days: Push, Pull, rest, Push, Pull, rest, Push', titles.join(',') === 'Workout: Push,Workout: Pull,-,Workout: Push,Workout: Pull,-,Workout: Push', titles.join(','));
  ok('each is a Health task tagged _ewId, id derived from the date', ew(m, TODAY).length === 1 && ew(m, TODAY)[0].id === 'ew_workout_' + TODAY && ew(m, TODAY)[0].category === 'health' && ew(m, TODAY)[0].type === 'task');
  ok("Tony's own task is untouched and keeps its place", m.data[TODAY][0].id === 't_own' && m.data[TODAY][0].title === 'My own task');
  ok('yesterday (history) is untouched, done kept', ew(m, YESTERDAY).length === 1 && ew(m, YESTERDAY)[0].done === true && ew(m, YESTERDAY)[0].title === 'Workout: Legs');
  ok('habits and their checks are untouched', JSON.stringify(m.habits) === JSON.stringify(MAIN.habits) && JSON.stringify(m.hc) === JSON.stringify(MAIN.hc));
  ok('the task shows in the week view', await js(`return document.body.innerText.indexOf('Workout: Push') >= 0;`));

  // Done is TaskHub's: tick it (as another device would), then change the rotation.
  m.data[TODAY] = m.data[TODAY].map((t) => (t._ewId ? Object.assign({}, t, { done: true }) : t));
  m.savedAt = Date.now() + 1000;
  await js(`__fakeFs.remote('dashboards/main', ${JSON.stringify(m)}); 1`); await sleep(1500);
  await js(`__fakeFs.remote('dashboards/everwell_tony', { rotation: Object.assign(${JSON.stringify(ROT)}, { anchor: { date: '${TODAY}', idx: 1 } }), savedAt: Date.now() }, { merge: true }); 1`);
  await sleep(2500);
  m = await cloud();
  ok("changing today's split re-titles the SAME item and keeps its done", ew(m, TODAY).length === 1 && ew(m, TODAY)[0].id === 'ew_workout_' + TODAY && ew(m, TODAY)[0].title === 'Workout: Pull' && ew(m, TODAY)[0].done === true,
    JSON.stringify(ew(m, TODAY)));
  ok('…and the following days shift with it (tomorrow is a rest day: no task)', ew(m, day(1)).length === 0 && ew(m, day(2))[0].title === 'Workout: Push');
  await js(`__fakeFs.remote('dashboards/everwell_tony', { rotation: Object.assign(${JSON.stringify(ROT)}, { anchor: { date: '${TODAY}', idx: 2 } }), savedAt: Date.now() + 5 }, { merge: true }); 1`);
  await sleep(2500);
  m = await cloud();
  ok('making today a rest day removes today\'s workout task', ew(m, TODAY).length === 0 && m.data[TODAY].some((t) => t.id === 't_own'));
  await js(`window.dispatchEvent(new CustomEvent('fb-ew-rotation')); window.dispatchEvent(new CustomEvent('fb-ew-rotation')); 1`); await sleep(1500);
  m = await cloud();
  const all = Object.keys(m.data).reduce((n, dk) => n + ew(m, dk).length, 0);
  ok('re-running never duplicates (one item per day at most)', Object.keys(m.data).every((dk) => ew(m, dk).length <= 1) && all === 5, all);

  console.log("\nEverwell's own Prayer row");
  ok('a Prayer row from Everwell is the first row of Daily Habits, with 7 day cells', await js(`const r = document.querySelector('tr[data-ew-prayer]'); return !!r && r.parentElement.firstElementChild === r && r.children.length === 9 && /Prayer/.test(r.children[0].textContent);`));
  ok("Tony's own Prayer habit is still there, separate", await js(`return [...document.querySelectorAll('tbody tr')].filter(r => /^Prayer/.test(r.children[0] && r.children[0].textContent || '')).length === 2;`));
  const col = (now.getDay() + 6) % 7;   // Monday-based column
  const cell = `document.querySelector('tr[data-ew-prayer]').children[${col + 1}].firstElementChild`;
  const checked = () => js(`const s = getComputedStyle(${cell}); return s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';`);
  ok('unticked to start', !(await checked()));
  const mainWritesBefore = await js(`return __fakeFs.log.filter(l => l.path === 'dashboards/main' && !l.remote).length;`);
  await js(`${cell}.click(); 1`); await sleep(1500);
  ok("a tick here writes today's date to dashboards/everwell_prayer", await js(`const d = __fakeFs.docs['dashboards/everwell_prayer']; return !!d && d.done['${TODAY}'] === true;`), await js(`return JSON.stringify(__fakeFs.docs['dashboards/everwell_prayer']);`));
  ok('…shows ticked', await checked());
  ok('…and never touches habits / hc in dashboards/main', await js(`const m = __fakeFs.docs['dashboards/main']; return JSON.stringify(m.hc) === ${JSON.stringify(JSON.stringify(MAIN.hc))} && m.habits.length === 2;`));
  ok('…nor writes dashboards/main at all for it', (await js(`return __fakeFs.log.filter(l => l.path === 'dashboards/main' && !l.remote).length;`)) === mainWritesBefore);
  await js(`__fakeFs.remote('dashboards/everwell_prayer', { done: { '${TODAY}': false, '${YESTERDAY}': true }, savedAt: Date.now() }, { merge: true }); 1`); await sleep(1200);
  ok('an untick from Everwell (another device) shows here', !(await checked()));
  ok('…and other days merge in, not over', await js(`const d = __fakeFs.docs['dashboards/everwell_prayer']; return d.done['${TODAY}'] === false && d.done['${YESTERDAY}'] === true;`));

  console.log("\nVeda's side");
  ok('the Prayer row and the workout reconcile exist only in Tony\'s TaskHub', await js(`return document.querySelectorAll('tr[data-ew-prayer]').length === 1;`));

  console.log('\nPage errors');
  ok('no uncaught exceptions', errs.length === 0, errs.join(' | '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
