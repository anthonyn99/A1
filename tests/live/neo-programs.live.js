// Neo's programs, in a real browser (docs/TaskHub/neo-assistant.md, "Programs").
//
// Real index.html on Veda's side; Firestore is the fake one and the Gemini
// route is answered here, so nothing touches her real data or quota. Expect:
//   · the registry lists every program linked from her TaskHub (header links,
//     her LifeHub list, Warden), each page once
//   · a Neo request carries them to the worker as state.programs
//   · "open Wellness" (open_program) opens it the way its tile does
//   · an unknown program is reported, not claimed
//   · Neo's Firestore helpers reach only her programs' documents, only on her side
// Run: node tests/live/neo-programs.live.js
'use strict';
process.env.CDP_PORT = process.env.CDP_PORT || '9349';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

(async () => {
  let reply = null, lastBody = null;
  const c = await connect({ mock: firebaseMock({
    patterns: ['https://personal-ai.av1.workers.dev/taskhub/parse*', 'https://orca.vedapatel05.workers.dev/*'],
    handle(req) {
      if (req.method === 'OPTIONS') return { status: 204, text: '' };
      if (/orca\.vedapatel05/.test(req.url)) return { status: 400, json: { error: { message: 'no voice in this test' } } };
      if (!/taskhub\/parse/.test(req.url)) return null;
      try { lastBody = JSON.parse(req.postData || '{}'); } catch (e) { lastBody = null; }
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

  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'local_storage,session_storage' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  const dash = { data: {}, habits: [], hc: {}, goals: [], monthlyGoals: [], rules: [], rulesDaily: {}, savedAt: Date.now(), rev: 1 };
  const docs = { 'dashboards/vedasdash': dash, 'dashboards/wellness': { categories: [{ id: 'water', name: 'Water' }] }, 'dashboards/main': { secret: 1 } };
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','veda'); localStorage.setItem('a1b_disabled','1');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify(${JSON.stringify(docs)})); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  if (await until('window._profileGoVeda && window._vdNeo && window._vdNeoPrograms', 30000)) await js(`window._profileGoVeda(); 1`);
  await until('window._activeProfile === "veda" && window._vdVoice', 20000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  ok('her LifeHub list has loaded', await until('window.LifeHub && LifeHub.list("veda").length > 0', 15000));

  console.log('\nthe list');
  const ids = await js(`return _vdNeoPrograms.list().map(p=>p.id);`);
  for (const id of ['studyos', 'mylist', 'wellness', 'magi', 'shruti', 'warden']) ok(`lists ${id}`, ids.includes(id), JSON.stringify(ids));
  ok('each page once, TaskHub itself left out', ids.length === new Set(ids).size && !ids.some(i => /taskhub/i.test(i)), JSON.stringify(ids));

  console.log('\na request carries them');
  reply = { ok: true, say: 'Opening Wellness.', transcript: 'Open Wellness', actions: [{ type: 'open_program', program: 'wellness' }, { type: 'open_program', program: 'netflix' }] };
  // Capture what opening does instead of opening real tabs.
  await js(`window.__opened=[]; window.open=function(u,n){ window.__opened.push([String(u),String(n||'')]); return {focus:function(){}, closed:false}; }; 1`);
  const res = await js(`return _THV.sendAudio('AAAA',{silent:true,extra:{mode:'neo'}}).then(function(r){ return r.results.map(function(x){ return {ok:x.ok, reason:x.reason||''}; }); });`);
  const sent = lastBody && lastBody.state && lastBody.state.programs;
  ok('state.programs went to the worker', Array.isArray(sent) && sent.some(p => p.id === 'wellness' && p.label === 'Wellness'), JSON.stringify(sent));
  ok('open_program opened Wellness', res && res[0] && res[0].ok === true, JSON.stringify(res));
  // LifeHub opens its named tab first, then sends that tab to the address.
  ok('…in its own named tab, as its tile does', await until(`window.__opened.some(function(o){ return /wellness/.test(o[1]); })`, 3000), await js(`return JSON.stringify(window.__opened);`));
  ok('an unknown program is not_found', res && res[1] && res[1].ok === false && res[1].reason === 'not_found', JSON.stringify(res));

  console.log('\nNeo\'s Firestore helpers');
  ok('read one of her programs\' documents', await js(`return _fbNeoGet('dashboards/wellness').then(function(d){ return !!(d && d.categories && d.categories[0].id==='water'); });`));
  ok('…never a document outside the list', await js(`return _fbNeoGet('dashboards/main').then(function(d){ return d === null; });`));
  ok('a field-path patch lands', await js(`return _fbNeoPatch('dashboards/wellness', {'settings.neo': true}).then(function(){ return _fbNeoGet('dashboards/wellness'); }).then(function(d){ return d.settings.neo === true && d.categories.length === 1; });`));
  ok('a transaction lands', await js(`return _fbNeoTx('dashboards/wellness', function(d){ return {'settings.n': (d.settings.n||0)+1}; }).then(function(v){ return _fbNeoGet('dashboards/wellness').then(function(d){ return v === true && d.settings.n === 1; }); });`));
  ok('an entry is added', await js(`return _fbNeoAdd('dashboards/wellness/entries', {timestamp: 1, values: {water: 2}}).then(function(id){ return !!id; });`));
  ok('off her side, nothing is reached', await js(`var was=window._activeProfile; window._activeProfile='tony'; var none=_vdNeoPrograms.list().length === 0; return _fbNeoGet('dashboards/wellness').then(function(d){ window._activeProfile=was; return d === null && none; });`));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  try { c.ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
