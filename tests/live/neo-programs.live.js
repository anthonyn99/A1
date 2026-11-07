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
  const docs = { 'dashboards/vedasdash': dash, 'dashboards/mylist': { veda: { lists: [{ id: 'g', name: 'Groceries' }] }, tony: { lists: [] } }, 'dashboards/main': { secret: 1 } };
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('td6_mainDash','veda'); localStorage.setItem('a1b_disabled','1');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify(${JSON.stringify(docs)})); 1`);
  await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
  if (await until('window._profileGoVeda && window._vdNeo && window._vdNeoPrograms', 30000)) await js(`window._profileGoVeda(); 1`);
  await until('window._activeProfile === "veda" && window._vdVoice', 20000);
  await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
  ok('her LifeHub list has loaded', await until('window.LifeHub && LifeHub.list("veda").length > 0', 15000));

  console.log('\nthe list');
  const ids = await js(`return _vdNeoPrograms.list().map(p=>p.id);`);
  for (const id of ['studyos', 'mylist', 'magi', 'shruti', 'notebook', 'plans']) ok(`lists ${id}`, ids.includes(id), JSON.stringify(ids));
  ok('Wellness is left out', !ids.includes('wellness') && !ids.some(i => /wellness/i.test(i)), JSON.stringify(ids));
  ok('each page once, TaskHub itself left out', ids.length === new Set(ids).size && !ids.some(i => /taskhub/i.test(i)), JSON.stringify(ids));

  console.log('\na request carries them');
  reply = { ok: true, say: 'Opening MyList.', transcript: 'Open MyList', actions: [{ type: 'open_program', program: 'mylist' }, { type: 'open_program', program: 'netflix' }] };
  // Capture what opening does instead of opening real tabs.
  await js(`window.__opened=[]; window.open=function(u,n){ window.__opened.push([String(u),String(n||'')]); return {focus:function(){}, closed:false}; }; 1`);
  const res = await js(`return _THV.sendAudio('AAAA',{silent:true,extra:{mode:'neo'}}).then(function(r){ return r.results.map(function(x){ return {ok:x.ok, reason:x.reason||''}; }); });`);
  const sent = lastBody && lastBody.state && lastBody.state.programs;
  ok('state.programs went to the worker', Array.isArray(sent) && sent.some(p => p.id === 'mylist' && p.label === 'MyList') && !sent.some(p => /wellness/i.test(p.id)), JSON.stringify(sent));
  ok('open_program opened MyList', res && res[0] && res[0].ok === true, JSON.stringify(res));
  // LifeHub opens its named tab first, then sends that tab to the address.
  ok('…in its own named tab, as its tile does', await until(`window.__opened.some(function(o){ return /mylist/.test(o[1]); })`, 3000), await js(`return JSON.stringify(window.__opened);`));
  ok('an unknown program is not_found', res && res[1] && res[1].ok === false && res[1].reason === 'not_found', JSON.stringify(res));

  console.log('\nNeo\'s Firestore helpers');
  ok('read one of her programs\' documents', await js(`return _fbNeoGet('dashboards/mylist').then(function(d){ return !!(d && d.veda && d.veda.lists[0].id==='g'); });`));
  ok('…never a document outside the list', await js(`return _fbNeoGet('dashboards/main').then(function(d){ return d === null; });`));
  ok('a field-path patch lands', await js(`return _fbNeoPatch('dashboards/mylist', {'veda.neo': true}).then(function(){ return _fbNeoGet('dashboards/mylist'); }).then(function(d){ return d.veda.neo === true && d.veda.lists.length === 1; });`));
  ok('a transaction lands', await js(`return _fbNeoTx('dashboards/mylist', function(d){ return {'veda.n': (d.veda.n||0)+1}; }).then(function(v){ return _fbNeoGet('dashboards/mylist').then(function(d){ return v === true && d.veda.n === 1 && Array.isArray(d.tony.lists); }); });`));
  ok('Wellness is out of reach', await js(`return _fbNeoGet('dashboards/wellness').then(function(d){ return d === null; });`));
  ok('off her side, nothing is reached', await js(`var was=window._activeProfile; window._activeProfile='tony'; var none=_vdNeoPrograms.list().length === 0; return _fbNeoGet('dashboards/mylist').then(function(d){ window._activeProfile=was; return d === null && none; });`));

  console.log('\nphase 1: Notebook, Shruti, MAGI (T) in the real page');
  ok('her Notebook is mounted', await until('window.Notebook && Notebook.mounts && Notebook.mounts.bj', 20000));
  const nb = await js(`return Notebook.putPage('bj', {id:'neolive1', title:'Trip to Goa', data:{html:'<p>Beaches and a fort.</p>'}, tags:[], folder:null})
    .then(function(){ return Notebook.page('bj','neolive1'); }).then(function(p){ return Notebook.pages('bj').then(function(ps){ return {n: ps.some(function(x){return x.id==='neolive1';}), text: p && p.text, html: p && p.html}; }); });`);
  ok('Notebook.pages / Notebook.page read the real store', nb && nb.n && nb.text === 'Beaches and a fort.' && /fort/.test(nb.html), JSON.stringify(nb));
  const rp = await js(`return _vdNeoPrograms.run('notebook','read_page',{title:'goa trip'});`);
  ok('read_page reads it out', rp && rp.say === 'Trip to Goa. Beaches and a fort.', JSON.stringify(rp));
  ok('append lands in the page', await js(`return _vdNeoPrograms.run('notebook','append',{title:'Trip to Goa', text:'Ate fish.'}).then(function(v){ return Notebook.page('bj','neolive1').then(function(p){ return v === true && /Ate fish\\./.test(p.text); }); });`));
  await js(`return _vdNeoPrograms.refreshAll(true);`);
  ok('her state carries the Notebook summary', await until(`(_vdNeoPrograms.state().find(function(p){return p.id==='notebook';})||{}).summary && /Trip to Goa/.test(_vdNeoPrograms.state().find(function(p){return p.id==='notebook';}).summary)`, 5000),
    await js(`return JSON.stringify(_vdNeoPrograms.state().find(function(p){return p.id==='notebook';}));`));
  // Shruti and MAGI (T): their documents, in the fake store.
  await js(`window.__fakeFs && (__fakeFs.docs['dashboards/shruti_veda'] = {last:{book:'gita',n:2,at:1}, progress:{gita:{ch1:{done:true,f:1}}}}); window.__fakeFs && (__fakeFs.docs['dashboards/magi_veda'] = {runs:[{id:'r1',question:'Best laptop for school',status:'complete',created_at:'2026-11-01T10:00:00Z'}]}); window.__fakeFs && (__fakeFs.docs['dashboards/magi_veda/runs/r1'] = {synthesis:{synthesis_ok:true, verdict:'A MacBook Air.'}}); 1`);
  ok('the fake store took the seeds', await js(`return _fbNeoGet('dashboards/shruti_veda').then(function(d){ return !!(d && d.last); });`));
  ok('Shruti mark_read patches her progress', await js(`return _vdNeoPrograms.run('shruti','mark_read',{chapter:'3'}).then(function(v){ return _fbNeoGet('dashboards/shruti_veda').then(function(d){ return v === true && d.progress.gita.ch3.done === true && d.progress.gita.ch1.done === true && d.last.n === 3; }); });`));
  ok('MAGI read_answer reads her verdict', (await js(`return _vdNeoPrograms.run('magi','read_answer',{question:'laptop'}).then(function(r){ return r.say; });`)) === 'On "Best laptop for school": A MacBook Air.');
  const mg = await js(`window.__magi=[]; A1Debrief.openMagi=function(u){ window.__magi.push(u); return true; }; return Promise.resolve(_vdNeoPrograms.run('magi','ask',{question:'Plan my week'})).then(function(v){ return {v:v, u:window.__magi[0]||''}; });`);
  ok('MAGI ask hands the question to MAGI (T)', mg.v === true && /\/A1\/magi\.html#tb=/.test(mg.u), JSON.stringify(mg));
  ok('…and Neo asks first', await js(`return /ask the MAGI council/.test((_vdNeo._test.needsConfirm([{type:'program',program:'magi',op:'ask',args:[{k:'question',v:'Plan my week'}]}],{})||{}).question||'');`));

  console.log('\nphase 2: StudyOS in the real page');
  await js(`__fakeFs.docs['dashboards/studyos'] = {classes:[{id:'c1',name:'Biology',modules:[{id:'m2',name:'Lecture notes',type:'notes',files:[],prompts:[],notes:[]}]}], tasks:[{id:'t1',name:'Lab report',dueDate:'2099-01-01',done:false,classId:'c1'}], events:[], notes:[], ksu:{modules:[]}, d2l:{}};
    __fakeFs.docs['studyos_cards/c1'] = {cards:[], meta:{v:2}, savedAt:1}; __fakeFs.docs['dashboards/studyos_notebook'] = {_order:['old'], e_old:{id:'old',title:'x'}}; 1`);
  ok('add_task lands in StudyOS\'s tasks', await js(`return _vdNeoPrograms.run('studyos','add_task',{title:'Problem set 4', class:'biology', date:'2099-01-02'}).then(function(v){ return _fbNeoGet('dashboards/studyos').then(function(d){ return v === true && d.tasks.length === 2 && d.tasks[1].classId === 'c1' && d.classes.length === 1; }); });`));
  ok('complete_task ticks it', await js(`return _vdNeoPrograms.run('studyos','complete_task',{title:'lab report'}).then(function(v){ return _fbNeoGet('dashboards/studyos').then(function(d){ return v === true && d.tasks[0].done === true; }); });`));
  ok('add_note lands in the Notes module\'s folder', await js(`return _vdNeoPrograms.run('studyos','add_note',{class:'biology', text:'Cells make ATP'}).then(function(r){ return _fbNeoGet('dashboards/studyos_notebook').then(function(d){ var k=Object.keys(d).filter(function(x){return /^e_neo/.test(x);})[0]; return r.ok === true && d[k].folder === 'm2' && d._order[0] === d[k].id && d._order[1] === 'old'; }); });`));
  ok('add_card lands in the deck', await js(`return _vdNeoPrograms.run('studyos','add_card',{class:'biology', question:'What makes ATP?', answer:'Mitochondria'}).then(function(v){ return _fbNeoGet('studyos_cards/c1').then(function(d){ return v === true && d.cards.length === 1 && d.meta.v === 2; }); });`));
  await js(`return _vdNeoPrograms.refreshAll(true);`);
  ok('her state carries the StudyOS summary', await until(`/Classes: Biology, notes modules: Lecture notes/.test((_vdNeoPrograms.state().find(function(p){return p.id==='studyos';})||{}).summary||'')`, 5000),
    await js(`return JSON.stringify(_vdNeoPrograms.state().find(function(p){return p.id==='studyos';}));`));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  try { c.ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
