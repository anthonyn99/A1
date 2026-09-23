// Edge cases the happy-path runs never touch, driven against the real app.
//
// Written after the documents-module bug (a write that succeeded and then
// rendered nowhere) to look for more of the same shape: silent misfiling,
// collapsing notes that should stay separate, and paths that only throw with
// real data. Also pins the F-3 escaping against hostile names.
//
// Run with:  npm run verify:edges     (after npm run build)
// Probe the edges the happy-path runs never touch. Looking for more of the
// same class of fault as the documents-module bug: a write that succeeds and
// then renders nowhere, or a path that throws only with real data.
import { launch, connect } from './cdp.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist/studyos/index.html');
if (!existsSync(dist)) { console.error('Build first:  npm run build'); process.exit(2); }
const PAGE = 'file:///' + dist.split(String.fromCharCode(92)).join('/');

try {
  await launch();
} catch (e) {
  if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); }
  throw e;
}
const { send, evalJs, events } = await connect();
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Page.navigate', { url: PAGE });
await new Promise(r => setTimeout(r, 4000));

let pass = 0, fail = 0;
const t = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n, x == null ? '' : '\n       ' + JSON.stringify(x)); } };

// Start from a known state. A previous run may have left 'e1' behind in this
// browser profile's localStorage, and a test that only passes on a fresh
// profile is a test that will fail confusingly later.
await evalJs(`(function(){
  for (var i = classes.length - 1; i >= 0; i--) if (classes[i].id === 'e1') classes.splice(i, 1);
  if (typeof ksuData !== 'undefined' && ksuData.modules) {
    ksuData.modules = ksuData.modules.filter(function(m){ return m.name !== 'Generated'; });
  }
  // Notes live in the EDITOR's store, not on the module, so dropping the class
  // does not drop its notes. Those keys survive in this profile's
  // localStorage, and the next run's assertions then counted entries left by
  // the previous one — 4 notes where the test had just written 2, with
  // notes[0] belonging to a run that finished minutes ago.
  Object.keys(localStorage)
    .filter(function(k){ return k.indexOf('studyos_notes_') === 0; })
    .forEach(function(k){ localStorage.removeItem(k); });
  return true;
})()`);

console.log('\nedge: regenerate replaces in the REAL app');
const regen = await evalJs(`(function(){
  var cls = { id:'e1', name:'E', modules:[
    { id:'g1', name:'Generated', type:'notes', files:[], prompts:[], notes:[] } ] };
  classes.push(cls);
  var B = window._sosBridge;
  var a = B.addGeneratedNote({ classId:'e1', title:'v1', body:'body v1',
    meta:{ sourceFileId:'same', promptId:'p1', promptVersion:1 } });
  var b = B.addGeneratedNote({ classId:'e1', title:'v2', body:'body v2',
    meta:{ sourceFileId:'same', promptId:'p2', promptVersion:3 } });
  var g = cls.modules.find(m=>m.name==='Generated');
  // A type:'notes' module renders from the EDITOR's own store
  // (localStorage['studyos_notes_<moduleId>']), not from mod.notes — see the
  // comment in addGeneratedNote. Asserting on mod.notes read an array the
  // editor never writes, so notes[0] was undefined and this crashed with
  // "Cannot read properties of undefined (reading 'body')" — which looked
  // like a filing bug when the note had in fact been filed correctly.
  var st = JSON.parse(localStorage.getItem('studyos_notes_' + g.id) || '{}');
  var es = st.entries || [];
  return { count: es.length, sameId: a.id === b.id,
           body: es[0] && es[0].data && es[0].data.html,
           version: es[0] && es[0]._sos && es[0]._sos.promptVersion };
})()`);
t('one note, not two', regen.count === 1, regen);
t('id is stable', regen.sameId === true, regen);
t('body is the new one', /body v2/.test(regen.body || ''), regen);
t('provenance updated to v3', regen.version === 3, regen);

console.log('\nedge: a second source adds, not replaces');
const two = await evalJs(`(function(){
  var B = window._sosBridge;
  B.addGeneratedNote({ classId:'e1', title:'other', body:'other body',
    meta:{ sourceFileId:'different' } });
  var g = classes.find(c=>c.id==='e1').modules.find(m=>m.name==='Generated');
  var st = JSON.parse(localStorage.getItem('studyos_notes_' + g.id) || '{}');
  return (st.entries || []).length;
})()`);
t('two distinct sources -> two notes', two === 2, two);

console.log('\nedge: a note with NO sourceFileId never collapses others');
const nometa = await evalJs(`(function(){
  var B = window._sosBridge;
  B.addGeneratedNote({ classId:'e1', title:'nometa1', body:'x' });
  B.addGeneratedNote({ classId:'e1', title:'nometa2', body:'y' });
  var g = classes.find(c=>c.id==='e1').modules.find(m=>m.name==='Generated');
  // The editor's store, not mod.notes — same reason as the regenerate check
  // above: a type:'notes' module renders from localStorage, so mod.notes is
  // legitimately empty and reading it reported 0 for a correct write.
  var st = JSON.parse(localStorage.getItem('studyos_notes_' + g.id) || '{}');
  return (st.entries || []).length;
})()`);
t('both appended (2 + 2 = 4)', nometa === 4, nometa);

console.log('\nedge: the KSU pseudo-class');
const ksu = await evalJs(`(function(){
  try {
    var B = window._sosBridge;
    var n = B.addGeneratedNote({ classId:'ksu', title:'k', body:'kb',
      meta:{ sourceFileId:'kf' } });
    var k = (typeof ksuData!=='undefined') ? ksuData.modules.map(function(m){return m.name+'['+m.type+']';}) : null;
    return { note: !!n, modules: k };
  } catch(e) { return { err: String(e) }; }
})()`);
t('KSU does not throw', !ksu.err, ksu);
t('KSU got a Generated notes module', !!ksu.modules && ksu.modules.some(m=>/Generated\[notes\]/.test(m)), ksu);

console.log('\nedge: setModuleDefaultPrompt on a missing module');
const dflt = await evalJs(`(function(){
  var B = window._sosBridge;
  return { badClass: B.setModuleDefaultPrompt('nope','x','p'),
           badModule: B.setModuleDefaultPrompt('e1','nope','p') };
})()`);
t('unknown class returns false', dflt.badClass === false, dflt);
t('unknown module returns false', dflt.badModule === false, dflt);

console.log('\nedge: getSnapshot really is a deep copy in the app');
const snap = await evalJs(`(function(){
  var s = window._sosBridge.getSnapshot();
  if (!s || !s.classes.length) return { skipped:true };
  var before = s.classes[0].name;
  s.classes[0].name = 'MUTATED';
  var live = window._sosBridge.getClasses()[0].name;
  return { mutatedCopy: s.classes[0].name, live: live, isolated: live !== 'MUTATED' };
})()`);
if (snap.skipped) console.log('  --   no classes to snapshot');
else t('mutating a snapshot cannot touch live data', snap.isolated === true, snap);

console.log('\nedge: subscribe fires on a real persist');
const sub = await evalJs(`(async function(){
  var hits = [];
  var off = window._sosBridge.subscribe(function(entity, origin){ hits.push(entity+':'+origin); });
  var cls = classes.find(c=>c.id==='e1');
  // Go through the REAL persist path.
  if (typeof persistForCls === 'function') persistForCls(cls);
  await new Promise(r=>setTimeout(r,300));
  off();
  var afterOff = hits.length;
  if (typeof persistForCls === 'function') persistForCls(cls);
  await new Promise(r=>setTimeout(r,300));
  return { hits: hits, stoppedAfterOff: hits.length === afterOff };
})()`);
t('a real persist notifies subscribers', (sub.hits||[]).length > 0, sub);
t('the notification names the entity and origin',
  (sub.hits||[]).some(h=>/^(classes|ksu):local$/.test(h)), sub.hits);
t('unsubscribe really detaches', sub.stoppedAfterOff === true, sub);

console.log('\nedge: escHtml against nasty real-world names');
const nasty = await evalJs(`(function(){
  var out = {};
  ['A & B', '<img src=x onerror=alert(1)>', "O'Brien \\"quoted\\"", 'Tom & Jerry & Co']
    .forEach(function(s,i){ out['c'+i] = escHtml(s); });
  return out;
})()`);
t('ampersands escaped', nasty.c0 === 'A &amp; B', nasty.c0);
t('an img-onerror payload is neutered', !/<img/.test(nasty.c1), nasty.c1);
t('multiple ampersands all escaped', (nasty.c3.match(/&amp;/g)||[]).length === 2, nasty.c3);

// Clean up so we do not leave junk in localStorage.
await evalJs(`(function(){
  var i = classes.findIndex(c=>c.id==='e1');
  if (i>=0) classes.splice(i,1);
  if (typeof ksuData!=='undefined') {
    ksuData.modules = ksuData.modules.filter(function(m){ return m.name!=='Generated'; });
  }
  return true;
})()`);

const errs = events.filter(e=>e.method==='Runtime.exceptionThrown')
  .map(e=>e.params.exceptionDetails?.exception?.description||'?')
  .filter(e=>!/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
t('no uncaught exceptions across all edges', errs.length === 0, errs.slice(0,5));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (errs.length) console.log(errs.join('\n'));
process.exit(fail ? 1 : 0);
