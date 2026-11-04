// Plans, end to end in the real index.html against the fake Firestore, on BOTH
// TaskHubs. The other person's device is played by __fakeFs.remote, exactly as
// a second phone's write would arrive.
//
//   • proposing a plan WRITES dashboards/plans (it once threw a ReferenceError
//     on every save, so nothing ever reached the cloud) and pushes to the other
//     profile only;
//   • a plan the other person proposes reaches this side: the record, the
//     "waiting on you" chip, the in-app banner, and a card with Confirm;
//   • confirming makes it a plan on the grid of BOTH TaskHubs;
//   • a tapped Plans notification opens the Plans panel (it used to open the
//     app on whatever it was showing);
//   • all of it from Tony's side and from Veda's side.
//
// Run: node tests/live/plans.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const pad = (n) => ('0' + n).slice(-2);
const now = new Date();
const key = (dt) => dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
const day = (i) => key(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
const TOMORROW = day(1);
const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
const MAIN = { data: {}, habits: [], hc: {}, goals: [], monthlyGoals: [], weekKey: key(monday), savedAt: Date.now() - 60000 };

async function side(c, me) {
  const other = me === 'tony' ? 'veda' : 'tony';
  const ME = me === 'tony' ? 'Tony' : 'Veda', OTHER = me === 'tony' ? 'Veda' : 'Tony';
  const root = me === 'tony' ? '#root' : '#veda-root';
  const js = (e) => evalJs(c, e);
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('console.error: ' + m.params.args.map(a => a.value || a.description).join(' '));
  });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash', ${JSON.stringify(me)}); localStorage.setItem('td6_lastDash', ${JSON.stringify(me)}); localStorage.setItem('a1b_disabled','1');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/main': ${JSON.stringify(MAIN)}, 'dashboards/vedasdash': ${JSON.stringify(MAIN)} })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  await sleep(10000);
  await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1`);
  await js(`window._profileGo${ME}(); 1`); await sleep(2500);
  // Capture pushes instead of sending them.
  await js(`window.__push = []; window._fcmSendToProfile = function(to, title, body, key){ window.__push.push({to, title, body, key}); return Promise.resolve(); }; 1`);
  const plansDoc = () => js(`return JSON.stringify(__fakeFs.docs['dashboards/plans'] || null);`).then(JSON.parse);
  const recs = (d) => Object.keys(d || {}).filter(k => k.indexOf('p_') === 0).map(k => d[k]);

  console.log(`\n── ${ME}'s side ──`);
  console.log(`${ME} proposes a plan`);
  await js(`PlansCore.addIdea('Dinner at Rosa', 'bring cake', ${JSON.stringify(TOMORROW)}, '19:30'); 1`); await sleep(800);
  const idea = await js(`return (PlansCore.bucket().ideas[0] || {}).id || null;`);
  ok('the idea is created', !!idea);
  await js(`PlansCore.promote(${JSON.stringify(idea)}); 1`); await sleep(1500);
  let d = await plansDoc();
  const mine = recs(d).find(p => p.id === idea);
  ok('the proposal is WRITTEN to dashboards/plans', !!mine && mine.stage === 'proposed' && mine.proposedBy === me && !!mine.confirms[me], JSON.stringify(d));
  ok(`…and announces itself (lastBy ${me}, lastKind proposed)`, !!mine && mine.lastBy === me && mine.lastKind === 'proposed');
  const push = await js(`return JSON.stringify(window.__push);`).then(JSON.parse);
  ok(`a push goes to ${OTHER} only, saying it was proposed`, push.some(p => p.to === other && /proposed “Dinner at Rosa”/.test(p.body)) && push.every(p => p.to === other), JSON.stringify(push));
  ok(`it is listed under my proposals, waiting on ${OTHER}`, await js(`return PlansCore.bucket().proposed.some(p => p.id === ${JSON.stringify(idea)});`));
  ok('a reload keeps it (it lives in the cloud, not just this tab)', await (async () => {
    await js(`location.reload(); 1`); await sleep(9000);
    await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); window._profileGo${ME}(); 1`); await sleep(2500);
    await js(`window.__push = []; window._fcmSendToProfile = function(to, title, body, key){ window.__push.push({to, title, body, key}); return Promise.resolve(); }; 1`);
    return js(`return PlansCore.bucket().proposed.some(p => p.id === ${JSON.stringify(idea)});`);
  })());

  console.log(`${OTHER} proposes a plan from another device`);
  const pid = 'remote' + me;
  const t0 = Date.now();
  const rec = { id: pid, title: 'Movie night', notes: '', author: other, stage: 'proposed', date: TOMORROW, time: '20:00', tz: 'America/New_York',
    proposedBy: other, proposedAt: t0, confirms: { [other]: t0 }, confirmMeta: { [other]: { dev: 'otherdev', devName: 'Phone', at: t0, v: 'none' } },
    dones: {}, createdAt: t0, updatedAt: t0, lastBy: other, lastKind: 'proposed', lastExtra: '' };
  await js(`__fakeFs.remote('dashboards/plans', { ['p_${pid}']: ${JSON.stringify(rec)}, savedAt: Date.now() }, { merge: true }); 1`);
  await sleep(1500);
  ok('the record arrives', await js(`return !!PlansCore.get(${JSON.stringify(pid)});`));
  ok('it needs my response', await js(`return PlansCore.bucket().mine.some(p => p.id === ${JSON.stringify(pid)}) && PlansCore.waitingCount() >= 1;`));
  ok('the in-app banner says so', await js(`return document.body.innerText.indexOf('${OTHER} proposed “Movie night”') >= 0;`));
  ok(`the "waiting on you" chip shows on ${ME}'s Weekly header`, await js(`return [...document.querySelectorAll('${root} button[title*="waiting on you"]')].some(b => b.offsetParent);`));

  console.log('Tapping the notification');
  // What the service worker posts to the page on a notification tap.
  await js(`window.postMessage({ type: 'th-open-plans' }, '*'); 1`); await sleep(1200);
  const panelOpen = () => js(`return [...document.querySelectorAll('${root} button')].some(b => b.offsetParent && b.textContent.trim().toUpperCase() === 'CONFIRM');`);
  ok('a tap opens the Plans panel with the proposal and its Confirm button', await panelOpen());
  ok('the plan card is there', await js(`return document.body.innerText.indexOf('Movie night') >= 0;`));

  console.log('Confirming');
  await js(`[...document.querySelectorAll('${root} button')].find(b => b.offsetParent && b.textContent.trim().toUpperCase() === 'CONFIRM').click(); 1`);
  await sleep(1500);
  d = await plansDoc();
  const conf = recs(d).find(p => p.id === pid);
  ok('confirming writes both confirms and stage confirmed', !!conf && conf.stage === 'confirmed' && !!conf.confirms.veda && !!conf.confirms.tony, JSON.stringify(conf));
  const push2 = await js(`return JSON.stringify(window.__push);`).then(JSON.parse);
  ok(`${OTHER} is told it is now a plan`, push2.some(p => p.to === other && /confirmed “Movie night”/.test(p.body)), JSON.stringify(push2));
  await js(`[...document.querySelectorAll('button[title="Close"]')].filter(b => b.offsetParent).forEach(b => b.click()); 1`); await sleep(2500);
  const gridDoc = me === 'tony' ? 'dashboards/main' : 'dashboards/vedasdash';
  ok(`the confirmed plan lands on ${ME}'s grid for that day`, await js(`const m = __fakeFs.docs['${gridDoc}']; return !!m && (m.data['${TOMORROW}'] || []).some(t => t._planId === ${JSON.stringify(pid)});`),
    await js(`return JSON.stringify((__fakeFs.docs['${gridDoc}'] || {}).data || {});`));

  console.log('The banner\'s Open, and a cold open from a tapped notification');
  const t1 = Date.now();
  const rec2 = Object.assign({}, rec, { id: pid + 'b', title: 'Picnic', proposedAt: t1, confirms: { [other]: t1 }, createdAt: t1, updatedAt: t1 });
  await js(`__fakeFs.remote('dashboards/plans', { ['p_${pid}b']: ${JSON.stringify(rec2)}, savedAt: Date.now() }, { merge: true }); 1`);
  await sleep(1500);
  const openBtn = `[...document.querySelectorAll('.th-banner-item')].find(b => b.textContent.indexOf('“Picnic”') >= 0)`;
  ok('the banner carries an Open button', await js(`const b = ${openBtn}; return !!b && !!b.querySelector('.th-banner-action');`));
  await js(`${openBtn}.querySelector('.th-banner-action').click(); 1`); await sleep(1200);
  ok('…which opens the panel on that plan', await panelOpen() && await js(`return document.body.innerText.indexOf('Picnic') >= 0;`));
  await js(`[...document.querySelectorAll('button[title="Close"]')].filter(b => b.offsetParent).forEach(b => b.click()); 1`); await sleep(800);
  ok('Close closes the panel', !(await panelOpen()));
  // A real cold open: from a blank page, so it is not a same-document hash change.
  // This device was last on the OTHER profile, so the tap must switch to mine.
  await js(`localStorage.setItem('td6_lastDash', '${other}'); 1`);
  await c.send('Page.navigate', { url: 'about:blank' }); await sleep(500);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html#plans-' + me }); await sleep(10000);
  await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1`); await sleep(2500);
  ok(`./#plans-${me} (a cold open from the notification) lands on ${ME}'s Plans panel`, await js(`return window._activeProfile === '${me}';`) && await panelOpen());
  ok('…and clears the hash so a reload does not reopen it', await js(`return location.hash === '';`));

  ok('no page errors', errs.length === 0, errs.join(' | '));
}

// Every other step of a plan's life, both people taking turns on one device
// (the profile switcher), checking what lands in the cloud and who is told.
async function lifecycle(c) {
  const js = (e) => evalJs(c, e);
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  console.log('\n── The rest of a plan\'s life ──');
  await js(`[...document.querySelectorAll('button[title="Close"]')].filter(b => b.offsetParent).forEach(b => b.click()); 1`); await sleep(600);
  await js(`window.__push = []; window._fcmSendToProfile = function(to, title, body, key){ window.__push.push({to, title, body, key}); return Promise.resolve(); }; 1`);
  const rec = (id) => js(`return JSON.stringify((__fakeFs.docs['dashboards/plans'] || {})['p_' + ${JSON.stringify(id)}] || null);`).then(JSON.parse);
  const lastPush = () => js(`return JSON.stringify(window.__push[window.__push.length - 1] || null);`).then(JSON.parse);
  const as = async (who) => { await js(`window._profileGo${who === 'tony' ? 'Tony' : 'Veda'}(); 1`); await sleep(700); };
  const act = async (expr) => { await js(`return Promise.resolve(${expr}).then(() => 1);`); await sleep(900); };

  await as('tony');
  await act(`PlansCore.addIdea('Hike', '', ${JSON.stringify(TOMORROW)}, '09:00')`);
  const id = await js(`return PlansCore.bucket().ideas.find(p => p.title === 'Hike').id;`);
  await act(`PlansCore.promote(${JSON.stringify(id)})`);
  await as('veda');
  await act(`PlansCore.declinePlan(${JSON.stringify(id)}, 'busy')`);
  let r = await rec(id), p = await lastPush();
  ok('decline: stored, confirms cleared, Tony told with the reason', r.stage === 'declined' && r.declined.by === 'veda' && !r.confirms.tony && p.to === 'tony' && /declined “Hike”: busy/.test(p.body), JSON.stringify([r, p]));
  await act(`PlansCore.restorePlan(${JSON.stringify(id)})`);
  ok('restore: back to an idea', (await rec(id)).stage === 'idea');
  await act(`PlansCore.promote(${JSON.stringify(id)})`);
  await as('tony');
  await act(`PlansCore.confirmPlan(${JSON.stringify(id)})`);
  r = await rec(id);
  ok('Veda proposes, Tony confirms: a plan', r.stage === 'confirmed' && r.confirms.veda && r.confirms.tony);

  await act(`PlansCore.applyEdit(${JSON.stringify(id)}, 'Long hike', '', ${JSON.stringify(TOMORROW)}, PlansCore.toLocalHHMM(PlansCore.get(${JSON.stringify(id)}).time, PlansCore.get(${JSON.stringify(id)}).tz, ${JSON.stringify(TOMORROW)}))`);
  r = await rec(id); p = await lastPush();
  ok('a change to an agreed plan waits for approval (title unchanged), Veda asked', r.title === 'Hike' && r.pendingEdit && r.pendingEdit.title === 'Long hike' && p.to === 'veda' && /wants to change/.test(p.body), JSON.stringify([r.pendingEdit, p]));
  await as('veda');
  await act(`PlansCore.approveEdit(${JSON.stringify(id)})`);
  r = await rec(id);
  ok('approved: the change is the plan, still confirmed', r.title === 'Long hike' && !r.pendingEdit && r.stage === 'confirmed', JSON.stringify(r));

  const D2 = day(2);
  await act(`PlansCore.proposeReschedule(${JSON.stringify(id)}, ${JSON.stringify(D2)}, '10:00', 'rain')`);
  r = await rec(id); p = await lastPush();
  ok('reschedule: a request, Tony told from → to with the reason', r.date === TOMORROW && r.pendingEdit && r.pendingEdit.date === D2 && p.to === 'tony' && /wants to move “Long hike”.*rain/.test(p.body), JSON.stringify([r.pendingEdit, p]));
  await as('tony');
  await act(`PlansCore.approveEdit(${JSON.stringify(id)})`);
  ok('approved: the plan moves', (await rec(id)).date === D2);
  await sleep(1500);
  ok('…and moves on Tony\'s grid too', await js(`const m = __fakeFs.docs['dashboards/main']; return !(m.data['${TOMORROW}'] || []).some(t => t._planId === ${JSON.stringify(id)}) && (m.data['${D2}'] || []).some(t => t._planId === ${JSON.stringify(id)});`));
  ok('…and on Veda\'s', await js(`const m = __fakeFs.docs['dashboards/vedasdash']; return !!m && (m.data['${D2}'] || []).some(t => t._planId === ${JSON.stringify(id)});`),
    await js(`return JSON.stringify(Object.keys((__fakeFs.docs['dashboards/vedasdash'] || {}).data || {}));`));

  await act(`PlansCore.markDone(${JSON.stringify(id)})`);
  r = await rec(id); p = await lastPush();
  ok('done is two-sided: Tony\'s mark alone does not finish it, Veda asked', r.stage === 'confirmed' && r.dones.tony && p.to === 'veda' && /marked “Long hike” done/.test(p.body));
  await as('veda');
  await act(`PlansCore.markDone(${JSON.stringify(id)})`);
  ok('both marks: done', (await rec(id)).stage === 'done');

  await as('veda');
  await act(`PlansCore.addIdea('Concert', '', ${JSON.stringify(D2)}, null)`);
  const id2 = await js(`return PlansCore.bucket().ideas.find(p => p.title === 'Concert').id;`);
  await act(`PlansCore.promote(${JSON.stringify(id2)})`);
  await as('tony');
  await act(`PlansCore.confirmPlan(${JSON.stringify(id2)})`);
  await act(`PlansCore.requestCancel(${JSON.stringify(id2)}, 'sold out')`);
  r = await rec(id2);
  ok('cancel is two-sided: a request leaves it confirmed', r.stage === 'confirmed' && r.cancelReq && r.cancelReq.by === 'tony');
  await as('veda');
  await act(`PlansCore.agreeCancel(${JSON.stringify(id2)})`);
  ok('agreed: dropped', (await rec(id2)).stage === 'dropped');
  await act(`PlansCore.removePlan(${JSON.stringify(id2)})`);
  p = await lastPush();
  ok('delete removes it from the cloud and tells Tony', (await rec(id2)) === null && p.to === 'tony' && /deleted “Concert”/.test(p.body));
  ok('a failed save says so and sends no push', await (async () => {
    const before = await js(`return window.__push.length;`);
    await js(`window.__saveReal = window._fbSavePlan; window._fbSavePlan = () => Promise.resolve(false); 1`);
    await act(`PlansCore.addIdea('Offline idea', '', null, null)`);
    await js(`window._fbSavePlan = window.__saveReal; 1`);
    return (await js(`return window.__push.length;`)) === before;
  })());
  ok('no page errors', errs.length === 0, errs.join(' | '));
}

(async () => {
  const c = await connect({ mock: firebaseMock() });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await side(c, 'tony');
  await side(c, 'veda');
  await lifecycle(c);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
