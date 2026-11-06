// Neo on Tony's side, in a real browser (docs/TaskHub/neo-assistant.md, "Tony's Neo").
//
// Real index.html on Tony's TaskHub; Firestore is the fake one and the Gemini
// route is answered here, so nothing touches his real data or quota. Expect:
//   · his header has its own NEO button, and his switch is his own (Veda's
//     being on never turns his on, and his never turns hers on)
//   · Neo's request goes out as Tony, in Neo mode, with his PC apps and state
//   · a change lands on HIS TaskHub, with the spotlight (in his purple) moving to
//     the week, ringing the row and coming back
//   · his HUD wears MAGI's purple (.p-tony) and docks in his quote's slot
// Screenshots land in %TEMP%/magi-live-shots/neo-tony-*.png.
// Run: node tests/live/neo-tony.live.js
'use strict';
const fs = require('fs');
process.env.CDP_PORT = process.env.CDP_PORT || '9349';
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
  const bodies = [];
  const c = await connect({ mock: firebaseMock({
    patterns: ['https://personal-ai.av1.workers.dev/taskhub/parse*', 'https://orca.vedapatel05.workers.dev/*'],
    handle(req) {
      if (req.method === 'OPTIONS') return { status: 204, text: '' };
      if (/orca\.vedapatel05/.test(req.url)) return { status: 400, json: { error: { message: 'no voice in this test' } } };
      if (!/taskhub\/parse/.test(req.url)) return null;
      try { bodies.push(JSON.parse(req.postData || '{}')); } catch (e) {}
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
  const shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(shotPath('neo-tony-' + name), Buffer.from(r.result.data, 'base64')); };

  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'local_storage,session_storage' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  const dash = {
    data: { [TODAY]: [{ id: 't1', type: 'task', title: 'Buy milk', done: false, category: 'personal' }, { id: 't2', type: 'task', title: 'Review trades', done: false, category: 'finance' }] },
    habits: [{ id: 'h1', title: 'Read' }], hc: {}, goals: [{ id: 'g1', title: 'Run a 10k', done: false }], monthlyGoals: [{ id: 'm1', title: 'Ship Neo', done: false }],
    savedAt: Date.now(), rev: 1,
  };
  // Veda's Neo is switched on on this device; Tony's is not.
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','tony'); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('vd_neo_on','1');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/main': ${JSON.stringify(dash)} })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  if (await until('window._profileGoTony && window._vdNeo', 30000)) await js(`window._profileGoTony(); 1`);
  await until('window._activeProfile === "tony" && window._thVoice && document.querySelector(\'#root [data-dkey="t1"]\')', 20000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  await sleep(1500);

  console.log('\nhis button, his switch');
  ok('Tony\'s header has a NEO button', await js(`return !!document.querySelector('#root .vd-neo-btn');`));
  ok('Neo serves Tony now', await js(`return _vdNeo.who();`) === 'tony');
  ok('Veda\'s switch being on doesn\'t turn his on', await js(`return _vdNeo.isOn() === false && !document.querySelector('#root .vd-neo-btn.on');`));
  ok('…and nothing listens', await js(`return _vdNeo.mode();`) === 'off');

  console.log('\na command, as Neo sends it');
  const T = '_vdNeo._test';
  const week = () => js(`return (_thVoice.getState().week||[]).map(w=>w.date).join();`);
  const wk0 = await week();
  reply = { ok: true, say: 'Done, sir.', transcript: 'Add tax filing in two weeks', actions: [{ type: 'add_task', box: 'calendar', date: FAR, title: 'Tax filing', category: 'finance' }] };
  await js(`window.__done=false; _THV.sendAudio('AAAA',{extra:{mode:'neo'},silent:true,before:${T}.spotlightBefore}).then(function(res){ window.__res=res; return ${T}.spotlightAfter(res.results); }).then(function(){ window.__done=true; }); 1`);
  ok('the view moves to that week', await until(`(_thVoice.getState().week||[]).some(w=>w.date===${JSON.stringify(FAR)})`, 4000), await week());
  ok('the new row is ringed, in his colours', await until(`document.querySelector('.vn-spot.p-tony.on')`, 4000));
  await sleep(250);
  ok('his ring is MAGI purple', await js(`var e=document.querySelector('.vn-spot.p-tony'); return e && getComputedStyle(e).borderTopColor;`) === 'rgb(192, 174, 234)', await js(`var e=document.querySelector('.vn-spot'); return e && getComputedStyle(e).borderTopColor;`));
  await shot('add-ringed');
  ok('then it comes back to this week', await until(`window.__done && (_thVoice.getState().week||[]).join && (_thVoice.getState().week||[]).map(w=>w.date).join()===${JSON.stringify(wk0)}`, 8000), await week());
  ok('the task landed on HIS TaskHub', await js(`return (_thVoice.getState().data[${JSON.stringify(FAR)}]||[]).some(function(x){return x.title==='Tax filing';});`));
  const b = bodies[bodies.length - 1] || {};
  ok('the request went out as Tony, in Neo mode', b.profile === 'tony' && b.mode === 'neo', JSON.stringify({ profile: b.profile, mode: b.mode }));
  ok('…with his state (PC apps list, timer, goals tab)', b.state && Array.isArray(b.state.pcApps) && typeof b.state.timerOpen === 'boolean' && typeof b.state.goalTab === 'string', JSON.stringify(Object.keys(b.state || {})));

  console.log('\nhis bridge');
  reply = { ok: true, say: 'Done.', transcript: 'Collapse the week and open the timer', actions: [{ type: 'week_view', collapsed: true }, { type: 'timer_set', minutes: 25, start: true }, { type: 'goals_tab', target: 'long' }] };
  await js(`_THV.sendAudio('AAAA',{extra:{mode:'neo'},silent:true}).then(function(r){ window.__r2=r; }); 1`);
  ok('week, timer and goals tab all applied', await until(`window.__r2 && window.__r2.results.every(function(x){return x.ok;})`, 5000), await js(`return JSON.stringify(window.__r2 && window.__r2.results.map(function(x){return x.reason;}));`));
  ok('the timer is set to 25:00 and running', await until(`window._vdTimerState && window._vdTimerState.running && window._vdTimerState.total === 1500`, 5000), await js(`return JSON.stringify(window._vdTimerState);`));
  ok('the week collapsed and the long-term tab is up', await js(`var s=_thVoice.getState(); return s.weekCollapsed===true && s.goalTab==='long';`));
  await js(`_THV.runActions([{type:'timer_reset'},{type:'timer_close'},{type:'week_view',collapsed:false},{type:'goals_tab',target:'short'}]); 1`);
  await sleep(800);

  console.log('\nhis HUD');
  // Switching on asks for the mic; without one it shows its fault in the HUD,
  // which is enough to see his HUD's colours and place.
  const rowTop = () => js(`var e=document.querySelector('#root [data-dkey="t1"]'); return e ? Math.round(e.getBoundingClientRect().top*10)/10 : null;`);
  const top0 = await rowTop();
  await js(`_vdNeo.setOn(true); 1`);
  ok('his switch is saved as his', await js(`return localStorage.getItem('th_neo_on');`) === '1');
  ok('the HUD shows', await until(`document.getElementById('vd-neo-hud') && document.getElementById('vd-neo-hud').classList.contains('show')`, 8000));
  ok('the HUD wears his colours (.p-tony)', await js(`return document.getElementById('vd-neo-hud').classList.contains('p-tony');`));
  ok('docked in his quote\'s slot, the quote hidden', await js(`var h=document.getElementById('vd-neo-hud'); return h.classList.contains('vn-dock') ? !!h.closest('#root .thwx-band') && getComputedStyle(document.querySelector('#root .thwx-band > .thwx-bq')).display==='none' : 'floating';`) === true,
    await js(`var h=document.getElementById('vd-neo-hud'); return h.className + ' in ' + (h.parentNode && (h.parentNode.id || h.parentNode.className));`));
  await sleep(500);
  ok('docking never moves his week (zero pixel shift)', top0 !== null && (await rowTop()) === top0, top0 + ' → ' + (await rowTop()));
  await shot('hud');
  await js(`window.scrollTo(0, 1200); 1`); await sleep(600);
  await js(`_vdNeo.cancel && 1`);
  await js(`_vdNeo.setOn(false); 1`);
  ok('switching off clears his preference only', await js(`return localStorage.getItem('th_neo_on') === null && localStorage.getItem('vd_neo_on') === '1';`));
  ok('the quote is back', await until(`!document.body.classList.contains('vn-docked')`, 2000));
  await js(`window.scrollTo(0, 0); 1`);

  console.log('\nVeda\'s side');
  // This browser has no microphone, and Neo switches itself off when the mic is
  // refused. A mic whose permission prompt is still up keeps her switch as it is.
  await js(`navigator.mediaDevices.getUserMedia = function(){ return new Promise(function(){}); }; 1`);
  await js(`window._profileGoVeda && window._profileGoVeda(); 1`);
  await until('window._activeProfile === "veda"', 8000);
  await sleep(1500);
  ok('on her side Neo serves her, with her own switch (on)', await js(`return _vdNeo.who() === 'veda' && _vdNeo.isOn() === true;`), await js(`return JSON.stringify({p:window._activeProfile, who:_vdNeo.who(), on:_vdNeo.isOn(), ls:localStorage.getItem('vd_neo_on')});`));
  ok('her button shows on, his stays off', await js(`return !!document.querySelector('#vr-root .vd-neo-btn.on') && !document.querySelector('#root .vd-neo-btn.on');`));
  await js(`_vdNeo.setOn(false); 1`);

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  try { c.ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
