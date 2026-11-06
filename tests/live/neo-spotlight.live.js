// Neo's spotlight, in a real browser (docs/TaskHub/neo-assistant.md, "Spotlight").
//
// Real index.html on Veda's side; Firestore is the fake one and the Gemini
// route is answered here, so nothing touches her real data or quota. Each
// command goes through the engine exactly as Neo sends it (sendAudio with the
// `before` hook, then the after-pass on the results). Expect:
//   · an add two weeks out: the view moves to that week, the new row is ringed,
//     then the view comes back to this week
//   · a remove this week: the row is ringed red before it goes, then the ring fades
//   · a goal edit: the goals tab switches to the right one, then back
//   · a tap mid-spotlight stops it where she is
// Screenshots land in %TEMP%/magi-live-shots/spot-*.png.
// Run: node tests/live/neo-spotlight.live.js
'use strict';
const fs = require('fs');
process.env.CDP_PORT = process.env.CDP_PORT || '9348';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const pad = (n) => ('0' + n).slice(-2);
const key = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const now = new Date();
const TODAY = key(now);
const far = new Date(now); far.setDate(far.getDate() + 14);
const FAR = key(far);

(async () => {
  let reply = null;
  const c = await connect({ mock: firebaseMock({
    patterns: ['https://personal-ai.av1.workers.dev/taskhub/parse*', 'https://orca.vedapatel05.workers.dev/*'],
    handle(req) {
      if (req.method === 'OPTIONS') return { status: 204, text: '' };
      if (/orca\.vedapatel05/.test(req.url)) return { status: 400, json: { error: { message: 'no voice in this test' } } };
      if (!/taskhub\/parse/.test(req.url)) return null;
      return { json: reply };
    },
  }) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 100; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(100); } return false; };
  const shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(shotPath('spot-' + name), Buffer.from(r.result.data, 'base64')); };

  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'local_storage,session_storage' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  const dash = {
    data: { [TODAY]: [{ id: 't1', type: 'task', title: 'Buy milk', done: false, category: 'personal' }, { id: 't2', type: 'task', title: 'Call Ashton', done: false, category: 'personal' }] },
    habits: [{ id: 'h1', title: 'Read' }], hc: {}, goals: [{ id: 'g1', title: 'Run a 10k', done: false }], monthlyGoals: [{ id: 'm1', title: 'Finish essay', done: false }],
    rules: [], rulesDaily: {}, savedAt: Date.now(), rev: 1,
  };
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','veda'); localStorage.setItem('a1b_disabled','1');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/vedasdash': ${JSON.stringify(dash)} })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  if (await until('window._profileGoVeda && window._vdNeo', 30000)) await js(`window._profileGoVeda(); 1`);
  await until('window._activeProfile === "veda" && window._vdVoice && document.querySelector(\'[data-dkey="t1"]\')', 20000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  await sleep(800);

  const T = '_vdNeo._test';
  const week = () => js(`return (_vdVoice.getState().week||[]).map(w=>w.date).join();`);
  // One command, the way Neo runs it: before → apply → after (not awaited by Neo; awaited here).
  const run = (r) => { reply = r; return js(`window.__done=false; return _THV.sendAudio('AAAA',{silent:true,before:${T}.spotlightBefore}).then(function(res){ window.__res=res; var p=${T}.spotlightAfter(res.results); window.__mid=true; return p; }).then(function(){ window.__done=true; return true; });`); };
  const rings = () => js(`return Array.from(document.querySelectorAll('.vn-spot')).map(function(e){return {cls:e.className, w:e.offsetWidth, h:e.offsetHeight, op:getComputedStyle(e).opacity};});`);

  console.log('\nadd, two weeks out');
  const wk0 = await week();
  ok('this week is on screen', wk0.includes(TODAY), wk0);
  reply = { ok: true, say: 'Done.', transcript: 'Add essay draft on the 20th', actions: [{ type: 'add_task', box: 'calendar', date: FAR, title: 'Essay draft', category: 'study' }] };
  await js(`window.__done=false; _THV.sendAudio('AAAA',{silent:true,before:${T}.spotlightBefore}).then(function(res){ window.__res=res; return ${T}.spotlightAfter(res.results); }).then(function(){ window.__done=true; }); 1`);
  ok('the view moves to that week', await until(`(_vdVoice.getState().week||[]).some(w=>w.date===${JSON.stringify(FAR)})`, 4000), await week());
  ok('the new row is ringed', await until(`document.querySelector('.vn-spot.on')`, 4000), JSON.stringify(await rings()));
  await sleep(300);   // past the ring's 180 ms fade-in
  const row = await js(`var e=document.querySelector('[data-dkey]'); var all=Array.from(document.querySelectorAll('[data-dkey]')).filter(function(x){return /Essay draft/.test(x.textContent);}); if(!all.length) return null; var a=all[0].getBoundingClientRect(), s=document.querySelector('.vn-spot').getBoundingClientRect(); return {dx:Math.abs(a.left-3-s.left), dy:Math.abs(a.top-3-s.top), dw:Math.abs(a.width+6-s.width)};`);
  ok('…and the ring sits on the row', row && row.dx < 2 && row.dy < 2 && row.dw < 2, JSON.stringify(row));
  await shot('add-ringed');
  ok('then it comes back to this week', await until(`window.__done && (_vdVoice.getState().week||[]).some(w=>w.date===${JSON.stringify(TODAY)})`, 8000), await week());
  ok('no ring is left behind', await until(`!document.querySelector('.vn-spot')`, 2000), JSON.stringify(await rings()));
  ok('the task really was added on that day', await js(`return (_vdVoice.getState().data[${JSON.stringify(FAR)}]||[]).some(function(x){return x.title==='Essay draft';});`));
  ok('the TaskHub view is fully opaque again', await js(`return getComputedStyle(document.getElementById('task-view')).opacity === '1';`));
  await shot('add-back');

  console.log('\nremove, this week');
  reply = { ok: true, say: 'Removed.', transcript: 'Remove buy milk', actions: [{ type: 'remove_task', match: { title: 'buy milk' } }] };
  await js(`window.__done=false; _THV.sendAudio('AAAA',{silent:true,before:${T}.spotlightBefore}).then(function(res){ return ${T}.spotlightAfter(res.results); }).then(function(){ window.__done=true; }); 1`);
  ok('the row is ringed red before it goes', await until(`document.querySelector('.vn-spot.vn-spot-gone.on') && document.querySelector('[data-dkey="t1"]')`, 3000), JSON.stringify(await rings()));
  await shot('remove-ringed');
  ok('the row goes and its ring fades', await until(`!document.querySelector('[data-dkey="t1"]') && !document.querySelector('.vn-spot')`, 5000), JSON.stringify(await rings()));
  ok('the week never moved', (await week()) === wk0);

  console.log('\ngoal on the other tab');
  const tab0 = await js(`return _vdVoice.getState().goalTab;`);
  const goal = tab0 === 'long' ? { box: 'shortTermGoals', id: 'm1', title: 'finish essay' } : { box: 'longTermGoals', id: 'g1', title: 'run a 10k' };
  reply = { ok: true, say: 'Done.', transcript: 'Rename the goal', actions: [{ type: 'edit_task', match: { box: goal.box, title: goal.title }, set: { title: 'Renamed goal' } }] };
  await js(`window.__done=false; _THV.sendAudio('AAAA',{silent:true,before:${T}.spotlightBefore}).then(function(res){ return ${T}.spotlightAfter(res.results); }).then(function(){ window.__done=true; }); 1`);
  ok('the goals tab switches to it', await until(`_vdVoice.getState().goalTab !== ${JSON.stringify(tab0)}`, 3000), await js(`return _vdVoice.getState().goalTab;`));
  ok('the goal is ringed', await until(`document.querySelector('.vn-spot.on')`, 3000));
  await shot('goal-ringed');
  ok('then the tab goes back', await until(`window.__done && _vdVoice.getState().goalTab === ${JSON.stringify(tab0)}`, 6000), await js(`return _vdVoice.getState().goalTab;`));

  console.log('\na tap stops it where she is');
  reply = { ok: true, say: 'Done.', transcript: 'Add another', actions: [{ type: 'add_task', box: 'calendar', date: FAR, title: 'Second thing', category: 'study' }] };
  await js(`window.__done=false; _THV.sendAudio('AAAA',{silent:true,before:${T}.spotlightBefore}).then(function(res){ return ${T}.spotlightAfter(res.results); }).then(function(){ window.__done=true; }); 1`);
  await until(`document.querySelector('.vn-spot.on')`, 4000);
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); 1`);
  ok('rings clear at once', await until(`!document.querySelector('.vn-spot')`, 1000));
  await sleep(2500);
  ok('the view stays on the week she was shown', (await week()).includes(FAR), await week());

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  try { c.ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
