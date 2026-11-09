// Tony's Neo AI in a real browser (TaskHub/tony-neo.js; docs/TaskHub/neo-assistant.md).
//
// Real index.html on Tony's TaskHub; Firestore is the fake one and the Gemini
// route is answered here, so nothing touches his real data or quota. Expect:
//   · his header: Talk, Type and the NEO switch (no device button: the mic is
//     in Settings → Tony's Neo AI); Veda's Neo never runs on his side
//   · a typed request goes out as Tony (his key), in Neo mode, lands on HIS
//     TaskHub with the spotlight in his purple, and is shown exactly
//   · docked in his quote's slot at the quote's height (zero pixel shift), a
//     long reply or many changes never run out of the slot, on a desktop or a
//     phone; the details button lists everything
//   · "undo" shows what it undid; his settings render and save
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

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'local_storage,session_storage' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  const dash = {
    data: { [TODAY]: [{ id: 't1', type: 'task', title: 'Buy milk', done: false, category: 'personal' }, { id: 't2', type: 'task', title: 'Review trades', done: false, category: 'finance' }] },
    habits: [{ id: 'h1', title: 'Read' }], hc: {}, goals: [{ id: 'g1', title: 'Run a 10k', done: false }], monthlyGoals: [{ id: 'm1', title: 'Ship Neo', done: false }],
    savedAt: Date.now(), rev: 1,
  };
  // Veda's Neo is switched on on this device; Tony's is not. Typed replies on screen only (no voice in a test).
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','tony'); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('vd_neo_on','1');
    localStorage.setItem('th_neo_settings', JSON.stringify({voice:'en-GB-RyanNeural', micLabel:'', speakTyped:false, at:1}));
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/main': ${JSON.stringify(dash)} })); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  if (await until('window._profileGoTony && window._thNeo', 30000)) await js(`window._profileGoTony(); 1`);
  await until('window._activeProfile === "tony" && window._thVoice && document.querySelector(\'#root [data-dkey="t1"]\')', 20000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  await sleep(1500);

  console.log('\nhis header, his switch');
  ok('Talk, Type and NEO in his header', await js(`return !!document.querySelector('#root .th-neo-talk') && !!document.querySelector('#root [title="Type to Neo"]') && !!document.querySelector('#root .th-neo-btn');`));
  ok('no device button in his header (it moved to Settings)', await js(`return !document.querySelector('#root [title="Input device"]') && !document.querySelector('#root [title="Voice control"]');`));
  ok('his switch is off, and Veda\'s Neo (on, on this device) doesn\'t run on his side', await js(`return _thNeo.isOn() === false && _thNeo.mode() === 'off' && !document.querySelector('#root .th-neo-btn.on') && _vdNeo.mode() === 'off';`));

  console.log('\na typed request, as Tony');
  const week = () => js(`return (_thVoice.getState().week||[]).map(w=>w.date).join();`);
  const wk0 = await week();
  const rowTop = () => js(`var e=document.querySelector('#root [data-dkey="t1"]'); return e ? Math.round(e.getBoundingClientRect().top*10)/10 : null;`);
  const top0 = await rowTop();
  reply = { ok: true, say: 'Added Tax filing.', transcript: 'Add tax filing in two weeks', actions: [{ type: 'add_task', box: 'calendar', date: FAR, title: 'Tax filing', category: 'finance' }] };
  await js(`_thNeo.openAsk(); 1`);
  ok('Type opens Neo\'s composer', await until(`document.getElementById('tn-ask') && document.getElementById('tn-ask').classList.contains('show')`, 3000));
  await js(`var ta=document.querySelector('#tn-ask textarea'); ta.value='add tax filing in two weeks'; ta.dispatchEvent(new Event('input')); document.querySelector('#tn-ask .tn-ask-send').click(); 1`);
  ok('…and closes on send', await until(`!document.getElementById('tn-ask').classList.contains('show')`, 2000));
  ok('the view moves to that week', await until(`(_thVoice.getState().week||[]).some(w=>w.date===${JSON.stringify(FAR)})`, 5000), await week());
  ok('the new row is ringed, in his purple', await until(`document.querySelector('.tn-spot.on')`, 4000));
  await sleep(250);
  ok('his ring is MAGI purple', await js(`var e=document.querySelector('.tn-spot'); return e && getComputedStyle(e).borderTopColor;`) === 'rgb(192, 174, 234)');
  ok('then it comes back to this week', await until(`(_thVoice.getState().week||[]).map(w=>w.date).join()===${JSON.stringify(wk0)}`, 9000), await week());
  ok('the task landed on HIS TaskHub', await js(`return (_thVoice.getState().data[${JSON.stringify(FAR)}]||[]).some(function(x){return x.title==='Tax filing';});`));
  const b = bodies[bodies.length - 1] || {};
  ok('the request went out as Tony (his key), in Neo mode, with his words', b.profile === 'tony' && b.mode === 'neo' && b.transcript === 'add tax filing in two weeks', JSON.stringify({ profile: b.profile, mode: b.mode, transcript: b.transcript }));
  ok('…with his state (PC apps, timer, goals tab)', b.state && Array.isArray(b.state.pcApps) && typeof b.state.timerOpen === 'boolean' && typeof b.state.goalTab === 'string');
  ok('the HUD shows exactly what changed', await until(`document.querySelector('#th-neo-hud .tn-say') && /^Task added · Tax filing · /.test(document.querySelector('#th-neo-hud .tn-say').textContent.trim())`, 3000), await js(`var s=document.querySelector('#th-neo-hud .tn-say'); return s && s.textContent;`));
  ok('docked in his quote\'s slot, the quote hidden', await js(`var h=document.getElementById('th-neo-hud'); return h.classList.contains('tn-dock') && !!h.closest('#root .thwx-band') && getComputedStyle(document.querySelector('#root .thwx-band > .thwx-bq')).display==='none';`),
    await js(`var h=document.getElementById('th-neo-hud'); return h.className + ' in ' + (h.parentNode && (h.parentNode.id || h.parentNode.className));`));
  await js(`window.scrollTo(0,0); 1`); await sleep(400);
  ok('docking never moves his week (zero pixel shift)', top0 !== null && (await rowTop()) === top0, top0 + ' → ' + (await rowTop()));

  // The fit: everything inside the slot, whatever the reply.
  const fits = () => js(`var h=document.getElementById('th-neo-hud'); if(!h||!h.classList.contains('show')) return 'hidden';
    var r=h.getBoundingClientRect(), q=h.parentNode.getBoundingClientRect(), bad=[];
    if (Math.abs(r.height - parseFloat(h.style.height)) > 0.5) bad.push('height ' + r.height + ' vs ' + h.style.height);
    if (r.right > innerWidth + 0.5 || r.left < -0.5) bad.push('off screen ' + r.left + '..' + r.right);
    if (document.documentElement.scrollWidth > innerWidth + 1) bad.push('page scrolls sideways');
    h.querySelectorAll('.tn-you,.tn-say,.tn-side,.tn-orb').forEach(function(e){ var x=e.getBoundingClientRect(); if (getComputedStyle(e).display==='none') return;
      if (x.bottom > r.bottom + 0.5 || x.top < r.top - 0.5 || x.right > r.right + 0.5) bad.push(e.className + ' spills ' + JSON.stringify([x.top|0,x.bottom|0,x.right|0]) + ' of ' + JSON.stringify([r.top|0,r.bottom|0,r.right|0])); });
    return bad.length ? bad.join('; ') : true;`);
  ok('a short reply fits the slot', (await fits()) === true, await fits());
  await shot('add');

  console.log('\na long answer, many changes');
  const LONG = 'Morning, Tony. Seven tasks left today; next, Review trades at 10 AM, then Buy milk. Two of three habits ticked. Overdue: Email the landlord from Friday. Dinner with Veda is waiting on you. NVDA reports after the close, and CPI is out at 8:30. ' +
    'That is everything on the board for today and the next few days, sir, as far as I can see.';
  reply = { ok: true, say: LONG, transcript: 'Brief me', actions: [] };
  await js(`window.__r=null; _thNeo.ask('brief me').then(function(r){window.__r=r;}); 1`);
  await until('window.__r', 6000); await sleep(400);
  ok('a long answer stays inside the slot', (await fits()) === true, await fits());
  ok('…with the details button to read it all', await js(`var m=document.querySelector('#th-neo-hud .tn-more'); return !!m && !m.hidden;`));
  await js(`document.querySelector('#th-neo-hud .tn-more').click(); 1`);
  ok('details show the whole answer', await until(`document.querySelector('.tn-pop.on') && document.querySelector('.tn-pop').textContent.indexOf('as far as I can see') >= 0`, 2000));
  ok('…inside the window', await js(`var p=document.querySelector('.tn-pop').getBoundingClientRect(); return p.left >= 0 && p.right <= innerWidth && p.top >= 0 && p.bottom <= innerHeight;`));
  await shot('long-details');
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); 1`);
  ok('a click elsewhere closes them', await until(`!document.querySelector('.tn-pop')`, 1500));

  const SIX = ['Gym', 'Call mom', 'Pay rent', 'Dentist', 'Groceries', 'Read 20 pages'].map(t => ({ type: 'add_task', box: 'calendar', date: TODAY, title: t, category: 'personal' }));
  reply = { ok: true, say: 'Added six.', transcript: 'add six things', actions: SIX };
  await js(`window.__r=null; _thNeo.ask('add six things').then(function(r){window.__r=r;}); 1`);
  await until('window.__r', 6000); await sleep(1600);
  ok('six changes: two named, the rest counted', await js(`return /; \\+4 more$/.test(document.querySelector('#th-neo-hud .tn-say').textContent.trim());`), await js(`return document.querySelector('#th-neo-hud .tn-say').textContent;`));
  ok('…the count on the details button', await js(`return document.querySelector('#th-neo-hud .tn-more').textContent.replace(/\\s/g,'') === '✓6';`), await js(`return document.querySelector('#th-neo-hud .tn-more').textContent;`));
  ok('…and still inside the slot', (await fits()) === true, await fits());
  await js(`window.scrollTo(0,0); document.querySelector('#th-neo-hud .tn-more').click(); 1`);
  ok('details list all six', await until(`document.querySelectorAll('.tn-pop li').length === 6`, 2000), await js(`return document.querySelectorAll('.tn-pop li').length;`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
  ok('Escape closes them', await until(`!document.querySelector('.tn-pop')`, 1500));

  console.log('\nundo shows what it undid');
  await sleep(900);   // TaskHub's history settles the last change (600 ms debounce)
  await js(`window.__r=null; _thNeo.ask('undo').then(function(r){window.__r=r;}); 1`);
  await until('window.__r', 5000); await sleep(500);
  const undoLine = await js(`return document.querySelector('#th-neo-hud .tn-say').textContent.trim();`);
  ok('"undo" names what it took away', /^Undone: removed /.test(undoLine) && /×|\+\d+ more|Gym|Read 20 pages/.test(undoLine), undoLine);
  ok('…and it really did', await js(`return !(_thVoice.getState().data[${JSON.stringify(TODAY)}]||[]).some(function(x){return x.title==='Gym';});`));

  console.log('\nhis bridge');
  reply = { ok: true, say: 'Done.', transcript: 'Collapse the week and open the timer', actions: [{ type: 'week_view', collapsed: true }, { type: 'timer_set', minutes: 25, start: true }, { type: 'goals_tab', target: 'long' }] };
  await js(`_THV.sendAudio('AAAA',{extra:{mode:'neo',profile:'tony'},silent:true}).then(function(r){ window.__r2=r; }); 1`);
  ok('week, timer and goals tab all applied', await until(`window.__r2 && window.__r2.results.every(function(x){return x.ok;})`, 5000), await js(`return JSON.stringify(window.__r2 && window.__r2.results.map(function(x){return x.reason;}));`));
  ok('the timer is set to 25:00 and running', await until(`window._vdTimerState && window._vdTimerState.running && window._vdTimerState.total === 1500`, 5000), await js(`return JSON.stringify(window._vdTimerState);`));
  await js(`_THV.runActions([{type:'timer_reset'},{type:'timer_close'},{type:'week_view',collapsed:false},{type:'goals_tab',target:'short'}]); 1`);
  await sleep(800);

  console.log('\nSettings → Tony\'s Neo AI');
  await js(`_thNeo.cancel(); window._openSettings('tony'); 1`);
  ok('the section is there: microphone, voice, typed replies', await until(`document.getElementById('tns-mic') && document.getElementById('tns-voice') && document.getElementById('tns-typed')`, 3000));
  ok('…with Shruti\'s voices, his current one selected', await js(`var s=document.getElementById('tns-voice'); return s.options.length === 20 && s.value === 'en-GB-RyanNeural';`));
  await js(`var s=document.getElementById('tns-voice'); s.value='en-GB-SoniaNeural'; s.dispatchEvent(new Event('change',{bubbles:true})); document.getElementById('tns-typed').click(); 1`);
  ok('a change is saved (and synced: dashboards/neo_tony)', await js(`var o=JSON.parse(localStorage.getItem('th_neo_settings')); return o.voice==='en-GB-SoniaNeural' && o.speakTyped===true && typeof window._fbSaveNeoTony==='function';`));
  await shot('settings');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  ok('on a phone the section fits (no sideways scroll)', await js(`var b=document.getElementById('thset-box'), n=document.getElementById('thset-neo'); return n.scrollWidth <= n.clientWidth + 1 && b.getBoundingClientRect().right <= innerWidth + 0.5;`));
  await shot('settings-phone');
  await js(`document.querySelector('#thset-box .thset-close').click(); 1`);
  await js(`_thNeo.setSettings({speakTyped:false}); window.scrollTo(0,0); 1`);
  await sleep(500);

  console.log('\non a phone');
  reply = { ok: true, say: LONG, transcript: 'Brief me', actions: [] };
  await js(`window.__r=null; _thNeo.ask('brief me').then(function(r){window.__r=r;}); 1`);
  await until('window.__r', 6000); await sleep(500);
  ok('the HUD docks in the phone\'s quote row', await js(`return document.getElementById('th-neo-hud').classList.contains('tn-dock');`));
  ok('a long answer stays inside it on a phone', (await fits()) === true, await fits());
  await shot('phone-long');
  await js(`_thNeo.cancel(); 1`);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);

  console.log('\nhis switch');
  await js(`_thNeo.setOn(true); 1`);
  ok('his switch is saved as his', await js(`return localStorage.getItem('th_neo_on');`) === '1');
  ok('the HUD shows (here: the no-microphone notice)', await until(`document.getElementById('th-neo-hud') && document.getElementById('th-neo-hud').classList.contains('show')`, 8000));
  await js(`_thNeo.setOn(false); 1`);
  ok('switching off clears his preference only', await js(`return localStorage.getItem('th_neo_on') === null && localStorage.getItem('vd_neo_on') === '1';`));
  await js(`_thNeo.cancel(); 1`);
  ok('the quote is back', await until(`!document.body.classList.contains('tn-docked')`, 6000));

  console.log('\nVeda\'s side');
  await js(`navigator.mediaDevices.getUserMedia = function(){ return new Promise(function(){}); }; 1`);
  await js(`window._profileGoVeda && window._profileGoVeda(); 1`);
  await until('window._activeProfile === "veda"', 8000);
  await sleep(1500);
  ok('on her side her own Neo serves her, with her own switch (on)', await js(`return _vdNeo.who() === 'veda' && _vdNeo.isOn() === true;`));
  ok('her button shows on; his Neo stays off and quiet', await js(`return !!document.querySelector('#vr-root .vd-neo-btn.on') && !document.querySelector('#root .th-neo-btn.on') && _thNeo.mode() === 'off';`));
  ok('Talk and Type do nothing on her side', await js(`return _thNeo.talk() === false && _thNeo.openAsk() === false;`));
  await js(`_vdNeo.setOn(false); 1`);

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  try { c.ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
