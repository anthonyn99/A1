// Verifies the ENABLED pipeline path in a real browser. This path has never
// run outside Node stubs, and it is the one that will be live once the
// Cloudflare setup is done — so a fault here would surface for the first time
// in front of the user.
//
// The Worker is stubbed at fetch() level: the point is to prove the browser
// code (module imports, the Run sheet, the ⚡ button, the jobs panel, the
// generated-PDF write-back) works, not to re-test the Worker.
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
        try {
          var b = init && init.body ? JSON.parse(init.body) : null;
          if (b && b.outputModuleId) window.__lastDest = b.outputModuleId;
        } catch (e) {}
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
        // The generated deck's BYTES, served from their own endpoint. A real
        // minimal PDF so the client's %PDF- magic check sees what it would in
        // production; a JSON blob here would (correctly) be refused.
        if (/\\/api\\/ai\\/jobs\\/[^/]+\\/pdf$/.test(u)) {
          var pdf = '%PDF-1.4\\n1 0 obj<</Type/Catalog>>endobj\\ntrailer<</Root 1 0 R>>\\n%%EOF';
          return new Response(new Blob([pdf], {type:'application/pdf'}),
            {status:200, headers:{'Content-Type':'application/pdf'}});
        }
        if (/\\/api\\/ai\\/jobs\\/[^/]+$/.test(u)) {
          return new Response(JSON.stringify({ ok:true, job:{
            id:'jx1', status:'done', progress:100, classId: window.__clsId,
            // Echoed back the way the real bridge does: _create stores
            // outputModuleId on the job, and fileResult reads it to decide
            // where the deck lands. Hard-coding '' here meant the destination
            // was always empty no matter what the sheet sent.
            outputModuleId: window.__lastDest || '', sourceName:'Lecture 3.pdf', fileId:'f1',
            promptId:'p1', promptVersion:1, costUsd:0.02, finishedAt:Date.now(),
            sections:[{from:1,to:3,model:'claude-opus-5'}],
            result:'## Slide 1\\nrewritten body',
            hasPdf:true, pdfBytes:64,
          }}), {status:200});
        }
        return new Response(JSON.stringify({ok:true}), {status:200});
      }
      // The SOURCE file's bytes. The local bridge cannot reach studyos-files,
      // so pipeline.js resolves the blob and attaches it as base64; the fixture
      // file is cloud-only, so that resolution comes through here. Without it
      // runPrompt throws "could not read the file to attach" before posting.
      if (u.indexOf('https://files/') === 0) {
        var src = '%PDF-1.4\\n1 0 obj<</Type/Catalog>>endobj\\ntrailer<</Root 1 0 R>>\\n%%EOF';
        return new Response(new Blob([src], {type:'application/pdf'}),
          {status:200, headers:{'Content-Type':'application/pdf'}});
      }
      return realFetch(url, init);
    };
  `,
});

await send('Page.navigate', { url: PAGE });
await new Promise(r => setTimeout(r, 3000));

// Flip the flag and re-run boot, since config.js already evaluated.
await evalJs(`window.STUDYOS_CONFIG.cloudflare.ai.enabled = true;
              // A LOCALHOST url on purpose: deck generation drives NotebookLM
              // in a browser on this machine, so openRunSheet refuses a Worker
              // baseUrl outright. Requests are stubbed below either way.
              window.STUDYOS_CONFIG.cloudflare.ai.baseUrl = 'http://127.0.0.1:8781';
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
// Isolate this run from every other one.
//
// persistForCls() calls _fbSaveStudyOs(), so without this the test WRITES ITS
// FIXTURE to the real Firestore project and the next run syncs it straight back.
// Generated decks then piled up across runs — nine copies of one deck — and the
// assertions below read the oldest survivor instead of what this run just filed.
// Stub the cloud save and drop any leftover copy of this fixture's class.
const isolated = await evalJs(`(function(){
  window._fbSaveStudyOs = function(){};
  var n = 0;
  for (var i = classes.length - 1; i >= 0; i--) {
    if (classes[i].id === 'vt1') { classes.splice(i, 1); n++; }
  }
  return n;
})()`);
if (isolated) console.log('  --   cleared ' + isolated + ' leftover fixture class(es)');

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
// The deck must be filable into a module the user already has, not forced into
// a new one. The fixture class carries "Source Material" (documents).
t('offers a destination picker', (sheet.bodyHtml||'').includes('sos-ai-dest'));
// NotebookLM generates the whole deck in one pass and never reads a slide
// count, so the field that used to collect one is gone. A visible input for a
// value nothing reads is a lie the UI tells.
t('no slide-count field (NotebookLM ignores it)',
  !(sheet.bodyHtml || '').includes('sos-ai-slides'));

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
  t('sent a destination module', !!body.outputModuleId, body.outputModuleId);
  // Deck generation goes to NotebookLM, and the bridge forces the site to match
  // — a job carrying the configured chat site would send the driver to
  // load_deck_site('claude'), which exits.
  t('sent mode=notebooklm', body.mode === 'notebooklm', body.mode);
  t('sent site=notebooklm, not the configured chat site',
    body.site === 'notebooklm', body.site);
  // The local bridge has no access to studyos-files, so the bytes ride along.
  t('attached the source bytes for the local bridge',
    typeof body.fileB64 === 'string' && body.fileB64.length > 0);
  t('did not send a slide count', !('slideCount' in body));
  t('attached the App Check token',
    posted[posted.length - 1].headers['X-Firebase-AppCheck'] === 'tok-live',
    posted[posted.length - 1].headers);
}

// The watcher should file the finished deck back into the class AS A PDF FILE.
// Fetching the bytes is async, so this needs longer than the note path did.
await new Promise(r => setTimeout(r, 4000));
const filed = await evalJs(`(function(){
  var cls = classes.find(c=>c.id==='vt1');
  if (!cls) return { error:'class gone' };
  // Find the module holding the GENERATED FILE, rather than one with a fixed
  // name. The deck now lands wherever the Run sheet's destination picker says,
  // which is the point — hard-coding 'Generated' asserted the old behaviour
  // where spec.moduleId was ignored and a new module was forced into being.
  var gen = cls.modules.find(m=>m.type==='documents'
    && (m.files||[]).some(f=>f && f.gen && f.gen.generated));
  if (!gen) return { noModule:true, modules: cls.modules.map(m=>m.name+':'+m.type) };
  // The GENERATED file, not files[0] — the destination module already holds
  // the source lecture, so index 0 is the input, not the output.
  var f = (gen.files||[]).find(x=>x && x.gen && x.gen.generated);
  return { module: gen.name, type: gen.type,
           fileCount: (gen.files||[]).length, noteCount: (gen.notes||[]).length,
           name: f && f.name, mime: f && f.mime, size: f && f.size,
           fileId: f && f.fileId, meta: f && f.gen };
})()`);
t('the deck was filed into a documents module', !filed.noModule, filed);
if (!filed.noModule) {
  // A documents module, not a notes one — a notes module would render this
  // nowhere at all.
  t('the Generated module is type documents', filed.type === 'documents', filed);
  // A FILE, not a note. fileCount is 2, not 1: the destination module already
  // holds the source lecture, and the deck is filed alongside it rather than
  // into a module of its own.
  t('the deck was filed as a FILE, not a note',
    filed.fileCount >= 1 && filed.noteCount === 0 && !!filed.fileId, filed);
  t('it is stored as a PDF', filed.mime === 'application/pdf', filed);
  t('provenance recorded', filed.meta && filed.meta.promptId === 'p1' && filed.meta.generated === true, filed.meta);
  t('model recorded', filed.meta && filed.meta.model === 'claude-opus-5', filed.meta);

  // The bytes themselves must be a real PDF in IndexedDB. Without this the
  // whole thing can "succeed" while storing an error page under a .pdf name.
  const bytes = await evalJs(`(async function(){
    var cls = classes.find(c=>c.id==='vt1');
    var gen = cls.modules.find(m=>m.type==='documents'
      && (m.files||[]).some(x=>x && x.gen && x.gen.generated));
    var f = (gen.files||[]).find(x=>x && x.gen && x.gen.generated);
    var blob = await window._sosBridge.resolveBlob(f);
    if (!blob) return { none:true };
    var head = new Uint8Array(await blob.slice(0,5).arrayBuffer());
    return { magic: String.fromCharCode.apply(null, head), size: blob.size };
  })()`);
  t('the stored blob really is a PDF', bytes && bytes.magic === '%PDF-', bytes);

  // Filed into the module that was CHOSEN. addGeneratedDoc used to ignore
  // spec.moduleId and force every deck into a module named 'Generated', so a
  // class with its own documents module got a second, near-duplicate one.
  const dest = await evalJs(`(function(){
    var cls = classes.find(c=>c.id==='vt1');
    var src = cls.modules.find(m=>m.id==='vm1');
    return { inChosen: (src.files||[]).some(f=>f.gen && f.gen.generated),
             generatedModules: cls.modules.filter(m=>m.name==='Generated').length,
             names: cls.modules.map(m=>m.name) };
  })()`);
  t('filed into the module that was chosen', dest.inChosen, dest);
  t('did not invent a second module', dest.generatedModules === 0, dest.names);
  t('the stored blob is not empty', bytes && bytes.size > 0, bytes);
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
  // One per file row. The module now holds the source AND the generated deck,
  // so two rows each carry their own button.
  t('⚡ rendered on the file row', btn.count >= 1, btn);
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
