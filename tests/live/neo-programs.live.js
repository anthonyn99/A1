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
  const lockCalls = [], slLogged = [];
  const slToken = String(Math.floor(Date.now() / 1000) + 3600) + '.abc';
  let wardenDoc = { connections: [{ name: 'School', items: [{ type: 'link', name: 'Canvas', url: 'https://canvas.example' }] }], colmap: [[0]] };
  const c = await connect({ mock: firebaseMock({
    patterns: ['https://personal-ai.av1.workers.dev/taskhub/parse*', 'https://orca.vedapatel05.workers.dev/*',
      'https://tradeboard-auth.vedapatel05.workers.dev/*', 'https://studyos-api.vedapatel05.workers.dev/*',
      'https://solo-leveling.vedapatel05.workers.dev/*', 'https://warden-links.vedapatel05.workers.dev/*'],
    handle(req) {
      if (req.method === 'OPTIONS') return { status: 204, text: '' };
      // The programs' own lock workers: never the real ones. Here no password is set anywhere.
      // SYSTEM (Solo-Leveling) and Warden's links: never the real ones.
      if (/solo-leveling/.test(req.url)) {
        let b = {}; try { b = JSON.parse(req.postData || '{}'); } catch (e) {}
        if (/\/api\/login$/.test(req.url)) return b.password === 'pw' ? { json: { ok: true, token: slToken } } : { status: 401, json: { error: 'wrong password' } };
        if ((req.headers.Authorization || req.headers.authorization) !== 'Bearer ' + slToken) return { status: 401, json: { error: 'not signed in' } };
        if (/\/api\/session$/.test(req.url)) return { json: { authenticated: true } };
        if (/\/api\/stats$/.test(req.url)) return { json: { stats: [{ id: 5, name: 'Fitness', level: 2 }] } };
        if (/\/api\/stats\/5\/log$/.test(req.url)) { slLogged.push(b); return { json: { result: { xp_gained: b.xp || 10, leveled_up: false } } }; }
        return { status: 404, json: { error: 'not found' } };
      }
      if (/warden-links/.test(req.url)) {
        if (req.method === 'PUT') { wardenDoc = JSON.parse(req.postData || '{}'); return { json: { ok: true } }; }
        return { json: wardenDoc };
      }
      if (/tradeboard-auth|studyos-api/.test(req.url)) { lockCalls.push(req.url); return { json: /hint/.test(req.url) ? { noLock: true } : { ok: false, noLock: true } }; }
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
  const docs = { 'dashboards/vedasdash': dash, 'dashboards/studyos_lock': { locks: {} }, 'tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12': { _applock: '{}' }, 'dashboards/mylist': { veda: { lists: [{ id: 'g', name: 'Groceries' }] }, tony: { lists: [] } }, 'dashboards/main': { secret: 1 } };
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

  console.log('\nphase 3: MyList in the real page');
  await js(`__fakeFs.docs['dashboards/mylist'] = {tony:{lists:[{id:'T',name:'Tony groceries',items:[{id:'x',name:'Steak',done:false}]}]}, veda:{lists:[{id:'g',name:'Groceries',type:'shopping',stores:[],items:[{id:'i1',name:'Milk',done:false}]}]}}; 1`);
  ok('add_item lands on her list, Tony\'s untouched', await js(`return _vdNeoPrograms.run('mylist','add_item',{list:'groceries', item:'Bread'}).then(function(v){ return _fbNeoGet('dashboards/mylist').then(function(d){ return v === true && d.veda.lists[0].items.length === 2 && d.tony.lists[0].items[0].name === 'Steak'; }); });`));
  ok('check_item ticks it', await js(`return _vdNeoPrograms.run('mylist','check_item',{item:'milk'}).then(function(v){ return _fbNeoGet('dashboards/mylist').then(function(d){ return v === true && d.veda.lists[0].items[0].done === true; }); });`));
  ok('read_list reads what is left', (await js(`return _vdNeoPrograms.run('mylist','read_list',{}).then(function(r){ return r.say; });`)) === 'Groceries: Bread.');

  console.log('\nphase 4: TRADE, FINANCE and the programs\' own locks, in the real page');
  ok('every lock Neo leans on is declared to Guardian, on its own record', await js(`var ids=['mylist:profile_veda','veda_shruti','veda_magi','veda_studyos','veda_finance','veda_tradeboard','veda_tradeboard_portfolio','veda_tradeboard_journal','veda_tradeboard_control'];
    var L=_vdNeoConnectors.LOCKDEFS; return ids.every(function(i){ return !!L[i]; }) && L['mylist:profile_veda'].entryId==='profile_veda' && L.veda_studyos.journal==='studyos_applock';`));
  await js(`__fakeFs.docs['tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12'] = {watchlist:'["NVDA"]', watchlistTrash:'[]', trades:'[]', positions:'{"account":{"net_liquidation":100}}', _applock:'{}'};
    __fakeFs.docs['finance/meta/sub/ledger'] = {budgets:[], cash:5}; __fakeFs.docs['dashboards/studyos_lock'] = {locks:{}}; 1`);
  // Her header has TRADE and FINANCE links (Settings); this fake profile has none, so add them as her links.
  await js(`var g=window._navGetLinks; window._navGetLinks=function(p){ var l=g(p)||[]; return p==='veda' ? l.concat([{id:'tr',label:'TRADE',url:'https://tradeboard.vedapatel05.workers.dev/'},{id:'fi',label:'FINANCE',url:'https://tradeboard.vedapatel05.workers.dev/finance/'}]) : l; }; 1`);
  await js(`return Guardian.refresh(['veda_tradeboard','veda_tradeboard_control','veda_finance','veda_studyos'], true);`);
  ok('…asked of their own lock workers (mocked here)', lockCalls.some(u => /tradeboard-auth/.test(u)), JSON.stringify(lockCalls));
  const wa = await js(`return Promise.resolve(_vdNeoPrograms.run('tradeboard','watch_add',{tickers:'AMD'})).then(function(v){ return _fbTbGet('tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12').then(function(d){ return { v: v, wl: d && d.watchlist, trades: d && d.trades }; }); });`);
  ok('TRADE: watch_add lands in TradeBoard\'s doc through the second app', wa.v === true && JSON.parse(wa.wl).join() === 'NVDA,AMD' && wa.trades === '[]', JSON.stringify(wa));
  ok('FINANCE: add_expense makes a manual entry', await js(`return Promise.resolve(_vdNeoPrograms.run('finance','add_expense',{amount:'9.99', name:'Coffee'})).then(function(v){ return _fbTbList('finance/meta/manual_transactions','date',10).then(function(l){ return v === true && l.length === 1 && l[0].amount === 9.99 && l[0].source === 'manual'; }); });`));
  ok('…the second app never reaches a document outside its list', await js(`return _fbTbGet('tradeboard/someone_else').then(function(d){ return d === null; });`));

  console.log('\nphase 5: SYSTEM, WARDEN in the real page');
  await js(`var g=window._navGetLinks; window._navGetLinks=function(p){ var l=g(p)||[]; return p==='veda' ? l.concat([{id:'sy',label:'SYSTEM (SOLO-LEVELING)',url:'https://solo-leveling.vedapatel05.workers.dev/'},{id:'wd2',label:'WARDEN',url:'https://vedacpatel.github.io/warden/warden.html'}]) : l; }; 1`);
  ok('SYSTEM: its own password gives Neo a token, kept on this device', await js(`return _vdNeoConnectors.LOCKDEFS.veda_system.backend.verify({}, 'pw').then(function(r){ return r.ok === true && localStorage.getItem('neo.tok.system') === ${JSON.stringify(slToken)}; });`));
  const sl = await js(`return Guardian.refresh(['veda_system'], true).then(function(){ return Promise.resolve(_vdNeoPrograms.run('system','log_activity',{stat:'fitness', xp:'15'})); }).then(function(r){ return r; });`);
  ok('SYSTEM: log_activity reaches it with that token', sl && sl.ok === true && slLogged.length === 1 && slLogged[0].xp === 15, JSON.stringify(sl));
  ok('WARDEN: add_link writes her whole list back with the link added', await js(`return Promise.resolve(_vdNeoPrograms.run('warden','add_link',{connection:'school', name:'Library', url:'library.example'})).then(function(v){ return v === true; });`)
    && wardenDoc.connections[0].items.length === 2 && wardenDoc.connections[0].items[1].url === 'https://library.example' && JSON.stringify(wardenDoc.colmap) === '[[0]]', JSON.stringify(wardenDoc));
  await js(`try{ localStorage.removeItem('neo.tok.system'); }catch(e){} 1`);

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  try { c.ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
