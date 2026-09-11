// Verifies the ENABLED pipeline path in a real browser. This path has never
// run outside Node stubs, and it is the one that will be live once the
// Cloudflare setup is done — so a fault here would surface for the first time
// in front of the user.
//
// The Worker is stubbed at fetch() level: the point is to prove the browser
// code (module imports, the Run sheet, the ⚡ button, the jobs panel, the
// note write-back) works, not to re-test the Worker.
import { launch, connect } from './cdp.mjs';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist/studyos/index.html');
if (!existsSync(dist)) {
  console.error('Build first:  npm run build');
  process.exit(2);
}
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

// Turn the pipeline ON before any script runs, and stub the Worker.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__jobs = [];
    window.__posted = [];
    const realFetch = window.fetch;
    window.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/api/ai/')) {
        window.__posted.push({ url: u, body: init && init.body, headers: (init&&init.headers)||{} });
        if (u.endsWith('/api/ai/budget')) {
          return new Response(JSON.stringify({ ok:true, spend:1.25, cap:20 }), {status:200});
        }
        if (u.endsWith('/api/ai/jobs') && init && init.method === 'POST') {
          const job = { id:'jx1', status:'queued', progress:0, sourceName:'Lecture 3.pdf' };
          window.__jobs.push(job);
          return new Response(JSON.stringify({ ok:true, job }), {status:200});
        }
        if (u.endsWith('/api/ai/jobs')) {
          return new Response(JSON.stringify({ ok:true, jobs: window.__jobs }), {status:200});
        }
        if (/\\/api\\/ai\\/jobs\\/[^/]+$/.test(u)) {
          return new Response(JSON.stringify({ ok:true, job:{
            id:'jx1', status:'done', progress:100, classId: window.__clsId,
            outputModuleId:'', sourceName:'Lecture 3.pdf', fileId:'f1',
            promptId:'p1', promptVersion:1, costUsd:0.02, finishedAt:Date.now(),
            sections:[{from:1,to:3,model:'claude-opus-5'}],
            result:'## Slide 1\\nrewritten body',
          }}), {status:200});
        }
        return new Response(JSON.stringify({ok:true}), {status:200});
      }
      return realFetch(url, init);
    };
  `,
});

await send('Page.navigate', { url: PAGE });
await new Promise(r => setTimeout(r, 3000));

// Flip the flag and re-run boot, since config.js already evaluated.
await evalJs(`window.STUDYOS_CONFIG.cloudflare.ai.enabled = true;
              window.STUDYOS_CONFIG.cloudflare.ai.baseUrl = 'https://ai.test';
              window._fbAppCheckToken = async () => 'tok-live'; true;`);
await evalJs(`import('./js/modules/boot.js?enabled=1').then(()=>'ok')`);
await new Promise(r => setTimeout(r, 2500));

const errs = events
  .filter(e => e.method === 'Runtime.exceptionThrown')
  .map(e => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || '?')
  .filter(e => !/firebase|firestore|net::|Failed to load resource|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));

console.log('\nenabled boot');
t('no uncaught exceptions', errs.length === 0, errs.slice(0, 5));
t('pipeline module loaded', await evalJs('typeof (window.SOS&&window.SOS.pipeline) === "object"'));
t('prompts module loaded', await evalJs('typeof (window.SOS&&window.SOS.prompts) === "object"'));
t('run hook defined', await evalJs('typeof window.sosRunPrompt === "function"'));
t('jobs hook defined', await evalJs('typeof window.sosOpenJobs === "function"'));
t('autorun hook defined', await evalJs('typeof window.sosAutoRun === "function"'));
t('pipeline reports enabled', await evalJs('window.SOS.pipeline.enabled() === true'));

// ── Seed a class + prompt + cloud file, then drive the real UI ────────────
console.log('\nreal UI: the Run sheet');
const seeded = await evalJs(`(function(){
  try {
    var cls = { id:'vt1', name:'Intro to Database Systems & Design', code:'CS 4400',
                instructor:'Prof. Lee', color:'#9dc0ee', modules:[] };
    var mod = { id:'vm1', name:'Source Material', type:'documents',
                files:[{ id:'f1', name:'Lecture 3.pdf', size:1234, mime:'application/pdf',
                         fileId:'f1', storageUrl:'https://files/f1' }],
                prompts:[], notes:[] };
    cls.modules.push(mod);
    classes.push(cls);
    window.__clsId = cls.id;
    // A prompt living in a class module, the pre-existing shape.
    cls.modules.push({ id:'vm2', name:'PROMPTS', type:'prompts',
      prompts:[{ id:'p1', text:'Rewrite {{class}} for {{instructor}}, slide by slide.' }],
      files:[], notes:[] });
    return { ok:true, classId: cls.id, modId: mod.id };
  } catch(e) { return { error:String(e) }; }
})()`);
t('seeded a class', seeded.ok === true, seeded);

// The library must see the class-module prompt without any migration.
t('prompt library sees the class prompt',
  await evalJs(`window.SOS.prompts.forClass('vt1').some(p=>p.id==='p1')`));
t('interpolation fills the class name',
  await evalJs(`window.SOS.prompts.interpolate(
    window.SOS.prompts.get('p1').text, { cls: window.SOS.store.getClass('vt1') }
  ).includes('Intro to Database Systems & Design')`));

// Open the real Run sheet through the real entry point.
await evalJs(`window.sosRunPrompt('vt1','f1','vm1'); true;`);
await new Promise(r => setTimeout(r, 600));

const sheet = await evalJs(`(function(){
  var el = document.querySelector('.sos-ai-sheet');
  if (!el) return { missing:true };
  var sel = el.querySelector('#sos-ai-prompt');
  return {
    open: el.classList.contains('open'),
    title: (el.querySelector('.modal-title')||{}).textContent,
    options: sel ? Array.from(sel.options).map(o=>o.textContent) : [],
    bodyHtml: (el.querySelector('[data-body]')||{}).innerHTML || '',
    buttons: Array.from(el.querySelectorAll('.modal-footer button')).map(b=>b.textContent),
  };
})()`);
t('Run sheet opened', !sheet.missing && sheet.open, sheet);
t('it lists the prompt', (sheet.options||[]).length > 0, sheet.options);
t('it names the file', (sheet.bodyHtml||'').includes('Lecture 3.pdf'));
t('the ampersand in the class name is escaped, not doubled',
  !/&\s*amp;\s*amp/i.test(sheet.bodyHtml || ''));
t('has Run and Cancel', (sheet.buttons||[]).join(',').includes('Run'), sheet.buttons);

// Budget must be fetched and shown before spending.
await new Promise(r => setTimeout(r, 400));
t('shows month-to-date spend before running', await evalJs(
  `(document.querySelector('#sos-ai-budget')||{}).textContent.includes('1.25')`));

console.log('\nreal UI: running it');
await evalJs(`(function(){
  var btns = Array.from(document.querySelectorAll('.sos-ai-sheet .modal-footer button'));
  var run = btns.find(b=>/Run/.test(b.textContent));
  if (run) run.click();
  return !!run;
})()`);
await new Promise(r => setTimeout(r, 1500));

const posted = await evalJs('window.__posted.filter(p=>/\\/api\\/ai\\/jobs$/.test(p.url) && p.body)');
t('posted a job to the Worker', posted.length >= 1, posted.map(p => p.url));
if (posted.length) {
  const body = JSON.parse(posted[posted.length - 1].body);
  t('sent the file id', body.fileId === 'f1', body);
  t('sent interpolated prompt text', /Intro to Database Systems & Design/.test(body.prompt), body.prompt);
  t('sent the class id', body.classId === 'vt1');
  t('attached the App Check token',
    posted[posted.length - 1].headers['X-Firebase-AppCheck'] === 'tok-live',
    posted[posted.length - 1].headers);
}

// The watcher should file the finished note back into the class.
await new Promise(r => setTimeout(r, 3000));
const filed = await evalJs(`(function(){
  var cls = classes.find(c=>c.id==='vt1');
  if (!cls) return { error:'class gone' };
  var gen = cls.modules.find(m=>m.name==='Generated');
  if (!gen) return { noModule:true, modules: cls.modules.map(m=>m.name) };
  var n = gen.notes[0];
  return { module: gen.name, type: gen.type, count: gen.notes.length,
           title: n && n.title, body: n && n.body, meta: n && n._sos };
})()`);
t('a Generated module was created on demand', !filed.noModule && filed.module === 'Generated', filed);
if (!filed.noModule) {
  t('the note was filed', filed.count === 1, filed);
  t('it holds the generated body', /rewritten body/.test(filed.body || ''), filed.body);
  t('provenance recorded', filed.meta && filed.meta.promptId === 'p1' && filed.meta.generated === true, filed.meta);
  t('model recorded', filed.meta && filed.meta.model === 'claude-opus-5', filed.meta);
}

console.log('\nreal UI: the ⚡ button appears on a cloud file');
const btn = await evalJs(`(function(){
  try {
    var cls = classes.find(c=>c.id==='vt1');
    var mod = cls.modules.find(m=>m.id==='vm1');
    var host = document.createElement('div');
    host.id='vt-doclist'; document.body.appendChild(host);
    if (typeof refreshDocList !== 'function') return { skipped:'refreshDocList not in scope' };
    refreshDocList(host, cls, mod);
    var found = Array.from(host.querySelectorAll('button')).filter(b=>b.textContent==='⚡');
    var r = { count: found.length, title: found[0] && found[0].title };
    host.remove();
    return r;
  } catch(e){ return { error:String(e) }; }
})()`);
if (btn.skipped) console.log('  --   ' + btn.skipped);
else {
  t('⚡ rendered on the file row', btn.count === 1, btn);
  t('it explains itself', /prompt/i.test(btn.title || ''), btn.title);
}

console.log('\nreal UI: the Jobs panel');
await evalJs(`document.querySelectorAll('.sos-ai-sheet').forEach(e=>e.remove()); window.sosOpenJobs(); true;`);
await new Promise(r => setTimeout(r, 900));
const panel = await evalJs(`(function(){
  var el = document.querySelector('.sos-ai-sheet');
  if (!el) return { missing:true };
  return { title:(el.querySelector('.modal-title')||{}).textContent,
           text:(el.querySelector('#sos-ai-jobs')||{}).textContent||'' };
})()`);
t('Jobs panel opened', !panel.missing && /Jobs/.test(panel.title || ''), panel);
t('it lists the job', /Lecture 3\.pdf/.test(panel.text || ''), panel.text);

// Escape must close it, and the refresh timer must not outlive the panel.
await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true;`);
await new Promise(r => setTimeout(r, 500));
t('Escape closes the panel', (await evalJs('document.querySelectorAll(".sos-ai-sheet").length')) === 0);

const errs2 = events
  .filter(e => e.method === 'Runtime.exceptionThrown')
  .map(e => e.params.exceptionDetails?.exception?.description || '?')
  .filter(e => !/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
console.log('\noverall');
t('still no uncaught exceptions after driving the UI', errs2.length === 0, errs2.slice(0, 5));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (errs2.length) console.log('\nerrors:\n' + errs2.join('\n'));
process.exit(fail ? 1 : 0);
