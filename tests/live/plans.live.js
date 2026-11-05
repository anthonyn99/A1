// Plans, end to end in the real index.html against the fake Firestore, on BOTH
// TaskHubs. Plans live in Notebook (Notebook/core/plans.js): each person's
// writes go to their OWN side's document, both sides read both, and the newest
// copy of a plan wins. The other person's device is played by __fakeFs.remote
// writing into THEIR document, exactly as a second phone's write would arrive.
//
//   • proposing a plan writes the proposer's own Notebook document, and only it
//     (never the other side's, never the old shared dashboards/plans), and
//     pushes to the other profile only, after the save;
//   • a plan the other person proposes reaches this side: the record, the
//     "waiting on you" chip, the in-app banner, and a card with Confirm;
//   • confirming makes it a plan on the grid of BOTH TaskHubs;
//   • a tapped Plans notification, a banner's Open and a cold ./#plans-<who>
//     open the Plans panel;
//   • the old shared document: its plans carry over (each side copies its own
//     into its Notebook) and a tab still running an older page, writing there,
//     still reaches this one;
//   • a delete is a tombstone that beats the other side's copy; a device whose
//     clock runs behind still wins with its newer change; a save made while the
//     tab is torn down lands after it comes back;
//   • the whole lifecycle (decline, restore, edit approval, reschedule,
//     two-sided done and cancel, delete) with each action in its actor's document.
//
// Run: node tests/live/plans.live.js
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 700) : '')); }
};
const pad = (n) => ('0' + n).slice(-2);
const now = new Date();
const key = (dt) => dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
const day = (i) => key(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
const TOMORROW = day(1);
const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
const MAIN = { data: {}, habits: [], hc: {}, goals: [], monthlyGoals: [], weekKey: key(monday), savedAt: Date.now() - 60000 };
const DOC = { tony: 'dashboards/tony_journal_plans', veda: 'dashboards/journal_plans', legacy: 'dashboards/plans' };
const OLD_T = Date.now() - 30 * 864e5;
// Plans from before the move, in the old shared document: one each.
const LEGACY = {
  savedAt: OLD_T,
  p_oldtony: { id: 'oldtony', title: 'Old Tony plan', author: 'tony', stage: 'done', confirms: { tony: OLD_T, veda: OLD_T }, dones: { tony: OLD_T, veda: OLD_T }, createdAt: OLD_T, updatedAt: OLD_T },
  p_oldveda: { id: 'oldveda', title: 'Old Veda plan', author: 'veda', stage: 'dropped', confirms: { tony: OLD_T, veda: OLD_T }, createdAt: OLD_T, updatedAt: OLD_T },
};

const capturePush = `window.__push = []; window._fcmSendToProfile = function(to, title, body, key){ window.__push.push({to, title, body, key}); return Promise.resolve(); }; 1`;

async function boot(c, me, hash) {
  const js = (e) => evalJs(c, e);
  const ME = me === 'tony' ? 'Tony' : 'Veda';
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' + (hash || '') });
  await sleep(10000);
  await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1`);
  if (!hash) { await js(`window._profileGo${ME}(); 1`); }
  await sleep(2500);
  await js(capturePush);
}

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
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/main': ${JSON.stringify(MAIN)}, 'dashboards/vedasdash': ${JSON.stringify(MAIN)}, '${DOC.legacy}': ${JSON.stringify(LEGACY)} })); 1`);
  await boot(c, me);
  const docOf = (path) => js(`return JSON.stringify(__fakeFs.docs[${JSON.stringify(path)}] || null);`).then(JSON.parse);
  const recIn = async (path, id) => ((await docOf(path)) || {})['p_' + id] || null;
  const writesTo = (path) => js(`return __fakeFs.log.filter(l => l.path === ${JSON.stringify(path)} && !l.remote).length;`);
  const panelOpen = () => js(`return [...document.querySelectorAll('${root} button')].some(b => b.offsetParent && b.textContent.trim().toUpperCase() === 'CONFIRM');`);
  const closePanel = () => js(`[...document.querySelectorAll('button[title="Close"]')].filter(b => b.offsetParent).forEach(b => b.click()); 1`);

  console.log(`\n── ${ME}'s side ──`);
  console.log('The old shared document');
  ok('its plans show (both people\'s)', await js(`return !!PlansCore.get('oldtony') && !!PlansCore.get('oldveda');`));
  const mineOld = await recIn(DOC[me], 'old' + me);
  ok(`${ME}'s own old plan is copied into ${ME}'s Notebook, unchanged`, !!mineOld && mineOld.updatedAt === OLD_T && mineOld.title === 'Old ' + ME + ' plan', JSON.stringify(mineOld));
  ok(`${OTHER}'s old plan is NOT written by ${ME} (only ${OTHER} writes ${OTHER}'s Notebook)`, !(await recIn(DOC[me], 'old' + other)) && (await writesTo(DOC[other])) === 0);
  ok('the old document is never written', (await writesTo(DOC.legacy)) === 0);

  console.log(`${ME} proposes a plan`);
  await js(`PlansCore.addIdea('Dinner at Rosa', 'bring cake', ${JSON.stringify(TOMORROW)}, '19:30'); 1`); await sleep(800);
  const idea = await js(`return (PlansCore.bucket().ideas.find(p => p.title === 'Dinner at Rosa') || {}).id || null;`);
  ok('the idea is created', !!idea);
  await js(`PlansCore.promote(${JSON.stringify(idea)}); 1`); await sleep(1500);
  const mine = await recIn(DOC[me], idea);
  ok(`the proposal is saved in ${ME}'s Notebook (${DOC[me]})`, !!mine && mine.stage === 'proposed' && mine.proposedBy === me && !!mine.confirms[me], JSON.stringify(mine));
  ok(`…and nowhere else: not ${OTHER}'s document, not the old one`, !(await recIn(DOC[other], idea)) && !(await recIn(DOC.legacy, idea)) && (await writesTo(DOC[other])) === 0 && (await writesTo(DOC.legacy)) === 0);
  ok(`…and announces itself (lastBy ${me}, lastKind proposed)`, !!mine && mine.lastBy === me && mine.lastKind === 'proposed');
  const push = await js(`return JSON.stringify(window.__push);`).then(JSON.parse);
  ok(`a push goes to ${OTHER} only, saying it was proposed`, push.some(p => p.to === other && /proposed “Dinner at Rosa”/.test(p.body)) && push.every(p => p.to === other), JSON.stringify(push));
  ok(`it is listed under my proposals, waiting on ${OTHER}`, await js(`return PlansCore.bucket().proposed.some(p => p.id === ${JSON.stringify(idea)});`));
  await js(`location.reload(); 1`); await sleep(9000);
  await js(`var l=document.getElementById('th-boot-loader'); if(l) l.remove(); window._profileGo${ME}(); 1`); await sleep(2500);
  await js(capturePush);
  ok('a reload keeps it (it lives in the cloud, not just this tab)', await js(`return PlansCore.bucket().proposed.some(p => p.id === ${JSON.stringify(idea)});`));

  console.log(`${OTHER} proposes a plan from another device (into ${OTHER}'s Notebook)`);
  const pid = 'remote' + me;
  const t0 = Date.now();
  const rec = { id: pid, title: 'Movie night', notes: '', author: other, stage: 'proposed', date: TOMORROW, time: '20:00', tz: 'America/New_York',
    proposedBy: other, proposedAt: t0, confirms: { [other]: t0 }, confirmMeta: { [other]: { dev: 'otherdev', devName: 'Phone', at: t0, v: 'none' } },
    dones: {}, createdAt: t0, updatedAt: t0, lastBy: other, lastKind: 'proposed', lastExtra: '' };
  await js(`__fakeFs.remote('${DOC[other]}', { ['p_${pid}']: ${JSON.stringify(rec)}, savedAt: Date.now(), by: '${other}' }, { merge: true }); 1`);
  await sleep(1500);
  ok('the record arrives', await js(`return !!PlansCore.get(${JSON.stringify(pid)});`));
  ok('it needs my response', await js(`return PlansCore.bucket().mine.some(p => p.id === ${JSON.stringify(pid)}) && PlansCore.waitingCount() >= 1;`));
  ok('the in-app banner says so', await js(`return document.body.innerText.indexOf('${OTHER} proposed “Movie night”') >= 0;`));
  ok(`the "waiting on you" chip shows on ${ME}'s Weekly header`, await js(`return [...document.querySelectorAll('${root} button[title*="waiting on you"]')].some(b => b.offsetParent);`));

  console.log('Tapping the notification');
  await js(`window.postMessage({ type: 'th-open-plans' }, '*'); 1`); await sleep(1200);
  ok('a tap opens the Plans panel with the proposal and its Confirm button', await panelOpen());
  ok('the plan card is there', await js(`return document.body.innerText.indexOf('Movie night') >= 0;`));

  console.log('Confirming');
  await js(`[...document.querySelectorAll('${root} button')].find(b => b.offsetParent && b.textContent.trim().toUpperCase() === 'CONFIRM').click(); 1`);
  await sleep(1500);
  const conf = await recIn(DOC[me], pid);
  ok(`my confirm is saved in MY Notebook: both confirms, stage confirmed`, !!conf && conf.stage === 'confirmed' && !!conf.confirms.veda && !!conf.confirms.tony, JSON.stringify(conf));
  ok(`${OTHER}'s own copy is left as ${OTHER} wrote it`, ((await recIn(DOC[other], pid)) || {}).stage === 'proposed');
  const push2 = await js(`return JSON.stringify(window.__push);`).then(JSON.parse);
  ok(`${OTHER} is told it is now a plan`, push2.some(p => p.to === other && /confirmed “Movie night”/.test(p.body)), JSON.stringify(push2));
  await closePanel(); await sleep(2500);
  const gridDoc = me === 'tony' ? 'dashboards/main' : 'dashboards/vedasdash';
  ok(`the confirmed plan lands on ${ME}'s grid for that day`, await js(`const m = __fakeFs.docs['${gridDoc}']; return !!m && (m.data['${TOMORROW}'] || []).some(t => t._planId === ${JSON.stringify(pid)});`),
    await js(`return JSON.stringify((__fakeFs.docs['${gridDoc}'] || {}).data || {});`));

  console.log('The other side answers, deletes, and runs a slow clock');
  // The other device sees my confirm and marks it done, with a clock 10 minutes BEHIND
  // mine but stamped past my copy, as nextStamp makes every save.
  const myConf = await recIn(DOC[me], pid);
  const theirs = Object.assign({}, myConf, { dones: { [other]: Date.now() - 6e5 }, updatedAt: myConf.updatedAt + 1, lastBy: other, lastKind: 'doneReq' });
  await js(`__fakeFs.remote('${DOC[other]}', { ['p_${pid}']: ${JSON.stringify(theirs)}, savedAt: Date.now() }, { merge: true }); 1`); await sleep(1200);
  ok(`${OTHER}'s newer copy wins over mine`, await js(`const p = PlansCore.get(${JSON.stringify(pid)}); return !!p.dones.${other} && p.lastBy === '${other}';`));
  ok('…and the banner says they marked it done', await js(`return document.body.innerText.indexOf('${OTHER} marked “Movie night” done') >= 0;`));
  await js(`PlansCore.markDone(${JSON.stringify(pid)}); 1`); await sleep(1200);
  const fin = await recIn(DOC[me], pid);
  ok('my answer is stamped past theirs and finishes it', !!fin && fin.stage === 'done' && fin.updatedAt > theirs.updatedAt, JSON.stringify(fin));
  // A plan the other side deletes: a tombstone in THEIR document beats my copy in mine.
  await js(`PlansCore.addIdea('Bowling', '', null, null); 1`); await sleep(1000);
  const bid = await js(`return PlansCore.bucket().ideas.find(p => p.title === 'Bowling').id;`);
  const bRec = await recIn(DOC[me], bid);
  await js(`__fakeFs.remote('${DOC[other]}', { ['p_${bid}']: { id: '${bid}', deleted: true, title: 'Bowling', updatedAt: ${bRec.updatedAt + 1}, lastBy: '${other}', lastKind: 'deleted' }, savedAt: Date.now() }, { merge: true }); 1`);
  await sleep(1200);
  ok(`${OTHER}'s delete removes it here, though my copy is still in my document`, await js(`return !PlansCore.get(${JSON.stringify(bid)});`) && !!(await recIn(DOC[me], bid)));
  ok('…and the banner says so', await js(`return document.body.innerText.indexOf('${OTHER} deleted “Bowling”') >= 0;`));

  console.log('A tab still running the old page');
  const st = Date.now();
  const stale = { id: 'stale' + me, title: 'From an old tab', author: other, stage: 'proposed', date: TOMORROW, proposedBy: other, proposedAt: st, confirms: { [other]: st }, createdAt: st, updatedAt: st, lastBy: other, lastKind: 'proposed' };
  await js(`__fakeFs.remote('${DOC.legacy}', { ['p_stale${me}']: ${JSON.stringify(stale)}, savedAt: Date.now() }, { merge: true }); 1`); await sleep(1200);
  ok('a proposal it writes into the old document still reaches me, waiting on me', await js(`return PlansCore.bucket().mine.some(p => p.id === 'stale${me}');`));

  console.log('A save while the tab is torn down');
  await js(`document.dispatchEvent(new Event('freeze')); 1`); await sleep(800);
  await js(`PlansCore.addIdea('While frozen', '', null, null); 1`); await sleep(800);
  ok('nothing is written while there is no connection', !(Object.values((await docOf(DOC[me])) || {}).some(p => p && p.title === 'While frozen')));
  await js(`document.dispatchEvent(new Event('resume')); 1`); await sleep(3000);
  ok('it lands once the tab is back', Object.values((await docOf(DOC[me])) || {}).some(p => p && p.title === 'While frozen'));
  ok('…and still shows', await js(`return PlansCore.bucket().ideas.some(p => p.title === 'While frozen');`));

  console.log('The banner\'s Open, and a cold open from a tapped notification');
  const t1 = Date.now();
  const rec2 = Object.assign({}, rec, { id: pid + 'b', title: 'Picnic', proposedAt: t1, confirms: { [other]: t1 }, createdAt: t1, updatedAt: t1 });
  await js(`__fakeFs.remote('${DOC[other]}', { ['p_${pid}b']: ${JSON.stringify(rec2)}, savedAt: Date.now() }, { merge: true }); 1`);
  await sleep(1500);
  const openBtn = `[...document.querySelectorAll('.th-banner-item')].find(b => b.textContent.indexOf('“Picnic”') >= 0)`;
  ok('the banner carries an Open button', await js(`const b = ${openBtn}; return !!b && !!b.querySelector('.th-banner-action');`));
  await js(`${openBtn}.querySelector('.th-banner-action').click(); 1`); await sleep(1200);
  ok('…which opens the panel on that plan', await panelOpen() && await js(`return document.body.innerText.indexOf('Picnic') >= 0;`));
  await closePanel(); await sleep(800);
  ok('Close closes the panel', !(await panelOpen()));
  // A real cold open, from a blank page, on a device last used as the OTHER profile.
  await js(`localStorage.setItem('td6_lastDash', '${other}'); 1`);
  await c.send('Page.navigate', { url: 'about:blank' }); await sleep(500);
  await boot(c, me, '#plans-' + me);
  ok(`./#plans-${me} (a cold open from the notification) lands on ${ME}'s Plans panel`, await js(`return window._activeProfile === '${me}';`) && await panelOpen());
  ok('…and clears the hash so a reload does not reopen it', await js(`return location.hash === '';`));
  await closePanel(); await sleep(500);

  ok('no page errors', errs.length === 0, errs.join(' | '));
}

// Every other step of a plan's life, both people taking turns on one device
// (the profile switcher), checking that each action lands in its actor's own
// document and who is told.
async function lifecycle(c) {
  const js = (e) => evalJs(c, e);
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  console.log('\n── The rest of a plan\'s life ──');
  await js(capturePush);
  const recIn = (who, id) => js(`return JSON.stringify((__fakeFs.docs['${DOC[who]}'] || {})['p_' + ${JSON.stringify(id)}] || null);`).then(JSON.parse);
  // The plan as both sides see it: the newer of the two copies.
  const rec = async (id) => { const a = await recIn('tony', id), b = await recIn('veda', id); if (!a) return b; if (!b) return a; return (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b; };
  const lastPush = () => js(`return JSON.stringify(window.__push[window.__push.length - 1] || null);`).then(JSON.parse);
  const as = async (who) => { await js(`window._profileGo${who === 'tony' ? 'Tony' : 'Veda'}(); 1`); await sleep(700); };
  const act = async (expr) => { await js(`return Promise.resolve(${expr}).then(() => 1);`); await sleep(900); };
  const by = async (who, id, test) => { const r = await recIn(who, id); return !!r && test(r); };

  await as('tony');
  await act(`PlansCore.addIdea('Hike', '', ${JSON.stringify(TOMORROW)}, '09:00')`);
  const id = await js(`return PlansCore.bucket().ideas.find(p => p.title === 'Hike').id;`);
  await act(`PlansCore.promote(${JSON.stringify(id)})`);
  ok("Tony's proposal is in Tony's Notebook", await by('tony', id, r => r.stage === 'proposed'));
  await as('veda');
  await act(`PlansCore.declinePlan(${JSON.stringify(id)}, 'busy')`);
  let r = await rec(id), p = await lastPush();
  ok("decline: in Veda's Notebook, confirms cleared, Tony told with the reason", await by('veda', id, x => x.stage === 'declined') && r.declined.by === 'veda' && !r.confirms.tony && p.to === 'tony' && /declined “Hike”: busy/.test(p.body), JSON.stringify([r, p]));
  ok("…Tony's Notebook still holds Tony's own last copy", await by('tony', id, x => x.stage === 'proposed'));
  await act(`PlansCore.restorePlan(${JSON.stringify(id)})`);
  ok('restore: back to an idea', (await rec(id)).stage === 'idea');
  await act(`PlansCore.promote(${JSON.stringify(id)})`);
  await as('tony');
  ok('Tony sees Veda\'s proposal waiting on him', await js(`return PlansCore.bucket().mine.some(p => p.id === ${JSON.stringify(id)});`));
  await act(`PlansCore.confirmPlan(${JSON.stringify(id)})`);
  r = await rec(id);
  ok('Veda proposes, Tony confirms: a plan', r.stage === 'confirmed' && r.confirms.veda && r.confirms.tony && await by('tony', id, x => x.stage === 'confirmed'));

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
  ok("delete: a tombstone in Veda's Notebook, gone for both, Tony told", await by('veda', id2, x => x.deleted === true) && !(await js(`return !!PlansCore.get(${JSON.stringify(id2)});`)) && p.to === 'tony' && /deleted “Concert”/.test(p.body), JSON.stringify(p));
  await as('tony');
  ok('…gone on Tony\'s side too, though Tony\'s document still has his last copy', !(await js(`return !!PlansCore.get(${JSON.stringify(id2)});`)) && await by('tony', id2, x => !x.deleted));
  ok('a failed save says so and sends no push', await (async () => {
    const before = await js(`return window.__push.length;`);
    await js(`window.__up = null; 1`);
    // Fail the next write to Tony's document at the Firestore layer.
    await js(`window.__fakeFs.failNext = ${JSON.stringify(DOC.tony)}; 1`);
    await act(`PlansCore.addIdea('Doomed idea', '', null, null)`);
    await sleep(1500);
    return (await js(`return window.__push.length;`)) === before && await js(`return document.body.innerText.indexOf('Plan not saved') >= 0;`);
  })());
  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log('One document unreadable');
  await js(`sessionStorage.setItem('__fakefs_fail', JSON.stringify({ '${DOC.legacy}': 1 })); 1`);
  await boot(c, 'tony');
  ok("the old document's listener failing does not blank Plans: the Notebooks' plans show", await js(`return !!PlansCore.get(${JSON.stringify(id)}) && PlansCore.get(${JSON.stringify(id)}).stage === 'done';`));
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
