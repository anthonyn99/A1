// Verifies P-4 auto-run end to end in a real browser.
//
// This is the ticket the spec calls "the real win": she drops a deck and never
// opens a job panel. It is also the only path that spends money without a
// second click, so the failure modes matter more than elsewhere:
//
//   - it must fire only when the module HAS a default prompt
//   - it must fire after the CLOUD upload, not the local save (the Worker
//     fetches the source from studyos-files; earlier would 404)
//   - a pipeline failure must never break the upload -- the file is already
//     stored, and a failed auto-run is a notification, not a lost file
//
// Run with:  npm run verify:autorun     (after npm run build)
import { launch, connect } from './cdp.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist/studyos/index.html');
if (!existsSync(dist)) { console.error('Build first:  npm run build'); process.exit(2); }
const PAGE = 'file:///' + dist.split(String.fromCharCode(92)).join('/');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name, extra == null ? '' : '\n       ' + JSON.stringify(extra)); }
};

try {
  await launch();
} catch (e) {
  if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); }
  throw e;
}
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__posted = [];
    window.__failNext = false;
    const realFetch = window.fetch;
    window.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/api/ai/')) {
        window.__posted.push({ url:u, body: init && init.body });
        if (window.__failNext && /\\/api\\/ai\\/jobs$/.test(u) && init && init.method === 'POST') {
          return new Response(JSON.stringify({ ok:false, error:'monthly_cap' }), {status:402});
        }
        if (u.endsWith('/api/ai/budget')) return new Response(JSON.stringify({ok:true,spend:0,cap:20}),{status:200});
        if (/\\/api\\/ai\\/jobs$/.test(u) && init && init.method === 'POST') {
          return new Response(JSON.stringify({ ok:true, job:{ id:'ja1', status:'queued' } }), {status:200});
        }
        if (/\\/api\\/ai\\/jobs\\/[^/]+$/.test(u)) {
          return new Response(JSON.stringify({ ok:true, job:{
            id:'ja1', status:'done', progress:100, classId:'at1', outputModuleId:'am1',
            sourceName:'Auto.pdf', fileId:'af1', promptId:'ap1', promptVersion:1,
            finishedAt:Date.now(), sections:[{from:1,to:2,model:'claude-opus-5'}],
            result:'## Slide 1\\nauto body' }}), {status:200});
        }
        return new Response(JSON.stringify({ok:true, jobs:[]}), {status:200});
      }
      return realFetch(url, init);
    };
  `,
});

await send('Page.navigate', { url: PAGE });
await new Promise(r => setTimeout(r, 3000));
await evalJs(`window.STUDYOS_CONFIG.cloudflare.ai.enabled = true;
              window.STUDYOS_CONFIG.cloudflare.ai.baseUrl = 'https://ai.test';
              window._fbAppCheckToken = async () => 'tok-auto'; true;`);
await evalJs(`import('./js/modules/boot.js?autorun=1').then(()=>'ok')`);
await new Promise(r => setTimeout(r, 2000));

console.log('\nsetup');
t('boot enabled the pipeline', await evalJs('typeof window.sosRunPrompt === "function"'));

const seeded = await evalJs(`(function(){
  var cls = { id:'at1', name:'Auto Class', code:'', instructor:'', color:'#888', modules:[] };
  cls.modules.push({ id:'am1', name:'Source Material', type:'documents', files:[], prompts:[], notes:[] });
  cls.modules.push({ id:'am2', name:'PROMPTS', type:'prompts',
    prompts:[{ id:'ap1', text:'Rewrite {{class}}.' }], files:[], notes:[] });
  classes.push(cls);
  return true;
})()`);
t('seeded a class with a prompt', seeded === true);

// ── No default set: dropping a file must NOT spend ────────────────────────
console.log('\nno default prompt -> nothing runs');
await evalJs(`window.__posted.length = 0;
  window.dispatchEvent(new CustomEvent('sos-file-added', { detail: {
    classId:'at1', moduleId:'am1', file:{ id:'af0', name:'NoDefault.pdf' }
  }})); true;`);
await new Promise(r => setTimeout(r, 800));
t('no job posted without a promptId',
  (await evalJs(`window.__posted.filter(p=>/\\/jobs$/.test(p.url)).length`)) === 0);

// ── Setting the default through the real bridge ───────────────────────────
console.log('\nsetting a default prompt');
t('bridge sets it', await evalJs(`window._sosBridge.setModuleDefaultPrompt('at1','am1','ap1')`));
t('stored on the module', await evalJs(
  `classes.find(c=>c.id==='at1').modules.find(m=>m.id==='am1').defaultPromptId === 'ap1'`));
t('turning it off deletes the key', await evalJs(`
  window._sosBridge.setModuleDefaultPrompt('at1','am1',null);
  !('defaultPromptId' in classes.find(c=>c.id==='at1').modules.find(m=>m.id==='am1'))`));
await evalJs(`window._sosBridge.setModuleDefaultPrompt('at1','am1','ap1'); true;`);

// ── The real trigger: studyos.js fires this after the cloud upload ────────
console.log('\na file lands -> it runs itself');
await evalJs(`window.__posted.length = 0;
  window.dispatchEvent(new CustomEvent('sos-file-added', { detail: {
    classId:'at1', moduleId:'am1', promptId:'ap1',
    file:{ id:'af1', name:'Auto.pdf', storageUrl:'https://files/af1' }
  }})); true;`);
await new Promise(r => setTimeout(r, 1500));

const posted = await evalJs(`window.__posted.filter(p=>/\\/jobs$/.test(p.url) && p.body)`);
t('a job was queued automatically', posted.length === 1, posted.map(p => p.url));
if (posted.length) {
  const b = JSON.parse(posted[0].body);
  t('for the dropped file', b.fileId === 'af1', b);
  t('with the interpolated prompt', b.prompt === 'Rewrite Auto Class.', b.prompt);
  t('filed to the right module', b.outputModuleId === 'am1', b);
}

// The watcher should file the result without anyone opening a panel.
await new Promise(r => setTimeout(r, 3000));
const filed = await evalJs(`(function(){
  var cls = classes.find(c=>c.id==='at1');
  var gen = cls.modules.find(m=>m.name==='Generated');
  if (!gen) return { noModule:true, modules: cls.modules.map(m=>m.name) };
  return { count: gen.notes.length, body: gen.notes[0] && gen.notes[0].body,
           meta: gen.notes[0] && gen.notes[0]._sos };
})()`);
t('the note was filed with no user action', !filed.noModule && filed.count === 1, filed);
if (!filed.noModule) {
  t('holds the generated body', /auto body/.test(filed.body || ''), filed.body);
  t('provenance recorded', !!(filed.meta && filed.meta.generated), filed.meta);
}

// ── A pipeline failure must not break the upload ──────────────────────────
console.log('\na failed auto-run is survivable');
await evalJs(`window.__failNext = true; window.__posted.length = 0; true;`);
const before = await evalJs(`classes.find(c=>c.id==='at1').modules.find(m=>m.id==='am1').files.length`);
await evalJs(`
  // Mimic what studyos.js does: the file is ALREADY stored before the event.
  classes.find(c=>c.id==='at1').modules.find(m=>m.id==='am1').files.push({ id:'af2', name:'Fails.pdf' });
  window.dispatchEvent(new CustomEvent('sos-file-added', { detail: {
    classId:'at1', moduleId:'am1', promptId:'ap1', file:{ id:'af2', name:'Fails.pdf' }
  }})); true;`);
await new Promise(r => setTimeout(r, 1500));
const after = await evalJs(`classes.find(c=>c.id==='at1').modules.find(m=>m.id==='am1').files.length`);
t('the file survived the failed run', after === before + 1, { before, after });
t('the file is still listed', await evalJs(
  `classes.find(c=>c.id==='at1').modules.find(m=>m.id==='am1').files.some(f=>f.id==='af2')`));

const errs = events
  .filter(e => e.method === 'Runtime.exceptionThrown')
  .map(e => e.params.exceptionDetails?.exception?.description || '?')
  .filter(e => !/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
t('a rejected job raised no uncaught exception', errs.length === 0, errs.slice(0, 5));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (errs.length) console.log('\nerrors:\n' + errs.join('\n'));
process.exit(fail ? 1 : 0);
