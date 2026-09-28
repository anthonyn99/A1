// Verifies the STUDY KIT path end to end in a real browser (engagement 1.1/1.2).
//
// The bridge is stubbed at fetch() level with a finished kit job; everything
// after that is the shipping code: the Run sheet, preset seeding, filing cards
// into the deck, questions into the quiz bank, the cheat sheet into a notes
// module the notes editor actually renders, and the rewritten deck as a PDF.
//
// Why a browser and not just test-kit.mjs: the two worst StudyOS filing bugs
// both passed their unit tests — a note written to an array no editor reads,
// and a deck filed correctly that nothing repainted. "Stored" is not "visible".
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
  else { fail++; console.log('  FAIL ' + name, extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 500)); }
};

try { await launch(); }
catch (e) { if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); } throw e; }
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Page.enable');

// A finished kit job, shaped exactly like the bridge's (see server.py
// _run_kit_job): 16 cards, 2 key terms, 9 questions, a cheat sheet.
const KIT = {
  flashcards: Array.from({ length: 16 }, (_, i) => ({ topic: i < 8 ? 'Keys' : 'Normalization',
    front: `Kit card question number ${i}?`, back: `Kit answer ${i}`, slide: i + 1 })),
  key_terms: [{ term: 'Superkey', definition: 'a set of attributes that uniquely identifies a row', topic: 'Keys' },
              { term: 'BCNF', definition: 'every determinant is a candidate key', topic: 'Normalization' }],
  quiz: Array.from({ length: 9 }, (_, i) => ({ topic: 'Keys', type: 'mcq', prompt: `Kit quiz ${i}?`,
    choices: ['w', 'x', 'y', 'z'], answer: 'x', explanation: 'because x' })),
  cheatsheet_md: '# Cheat sheet\n- **Candidate key**: minimal superkey',
};

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__posted = [];
    window.__kit = ${JSON.stringify(KIT)};
    const realFetch = window.fetch;
    window.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/api/ai/')) {
        var body = null;
        try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) {}
        window.__posted.push({ url: u, body: body });
        if (body && body.outputModuleId) window.__lastDest = body.outputModuleId;
        if (body && 'kitRewrite' in body) window.__rewrite = body.kitRewrite;
        if (u.endsWith('/api/ai/budget')) return new Response(JSON.stringify({ ok:true, spend:0, cap:0 }));
        if (u.endsWith('/api/ai/jobs') && init && init.method === 'POST') {
          return new Response(JSON.stringify({ ok:true, job:{ id:'kj1', status:'queued', mode:'kit', sourceName:'Lecture 4.pdf' } }));
        }
        if (u.endsWith('/api/ai/jobs')) return new Response(JSON.stringify({ ok:true, jobs: [] }));
        if (/\\/api\\/ai\\/jobs\\/[^/]+\\/pdf$/.test(u)) {
          var pdf = '%PDF-1.4\\n1 0 obj<</Type/Catalog>>endobj\\ntrailer<</Root 1 0 R>>\\n%%EOF';
          return new Response(new Blob([pdf], {type:'application/pdf'}), {headers:{'Content-Type':'application/pdf'}});
        }
        if (/\\/api\\/ai\\/jobs\\/[^/]+$/.test(u)) {
          return new Response(JSON.stringify({ ok:true, job:{
            id:'kj1', mode:'kit', status:'done', progress:100, classId: 'vk1',
            outputModuleId: window.__lastDest || '', sourceName:'Lecture 4.pdf', fileId:'kf1',
            promptId:'p', promptVersion:1, finishedAt: Date.now(),
            kit: window.__kit, kitWarnings: [], kitRewrite: !!window.__rewrite,
            result: '## Slide 1\\nrewritten', hasPdf: true, sections:[{from:1,to:1}],
          }}));
        }
        return new Response(JSON.stringify({ ok:true }));
      }
      if (u.indexOf('https://files/') === 0) {
        var src = '%PDF-1.4\\n1 0 obj<</Type/Catalog>>endobj\\ntrailer<</Root 1 0 R>>\\n%%EOF';
        return new Response(new Blob([src], {type:'application/pdf'}), {headers:{'Content-Type':'application/pdf'}});
      }
      return realFetch(url, init);
    };
  `,
});

await send('Page.navigate', { url: PAGE });
await new Promise((r) => setTimeout(r, 3000));
await evalJs(`window.STUDYOS_CONFIG.cloudflare.ai.enabled = true;
  window.STUDYOS_CONFIG.cloudflare.ai.baseUrl = 'http://127.0.0.1:8781';
  window.STUDYOS_CONFIG.cloudflare.ai.site = 'claude';
  window._fbAppCheckToken = async () => 'tok'; true;`);
// Record toasts: they auto-dismiss after 4s, faster than filing completes.
await evalJs(`window.__toasts = []; var _sn = window.showNotif;
  window.showNotif = function(i, t, b){ window.__toasts.push(t + ' :: ' + b); return _sn.apply(this, arguments); }; true;`);
await evalJs(`import('./js/modules/boot.js?enabled=1').then(()=>'ok')`);
await new Promise((r) => setTimeout(r, 2500));

// Isolate from the real Firestore project — see verify-pipeline.mjs.
await evalJs(`(function(){
  window._fbSaveStudyOs = function(){};
  window._fbSaveCards = function(){};
  window._fbSaveDoc = function(){};
  window._fbSaveJournal = function(){};
  for (var i = classes.length - 1; i >= 0; i--) if (classes[i].id === 'vk1') classes.splice(i, 1);
  ['studyos_cards_vk1','studyos_quiz_vk1','studyos_kit_prompt_vk1'].forEach(function(k){ localStorage.removeItem(k); });
  return true;
})()`);

const seeded = await evalJs(`(function(){
  var cls = { id:'vk1', name:'Intro to Databases', code:'CS 3410', color:'#9dc0ee', modules:[
    { id:'vkm1', name:'Module 1', type:'documents', prompts:[], notes:[],
      files:[{ id:'kf1', name:'Lecture 4.pdf', size:1234, mime:'application/pdf', fileId:'kf1', storageUrl:'https://files/kf1' }] },
    { id:'vkm2', name:'Generated', type:'documents', prompts:[], notes:[], files:[] },
  ]};
  classes.push(cls);
  return true;
})()`);
t('seeded a class', seeded === true);

console.log('\nthe Run sheet');
await evalJs(`window.sosRunPrompt('vk1','kf1','vkm1'); true;`);
await new Promise((r) => setTimeout(r, 700));
const sheet = await evalJs(`(function(){
  var el = document.querySelector('.sos-ai-sheet');
  if (!el) return { missing:true };
  var sel = el.querySelector('#sos-ai-prompt');
  return {
    kitChecked: !!el.querySelector('input[value="kit"]:checked'),
    rewrite: el.querySelector('#sos-ai-rewrite') && el.querySelector('#sos-ai-rewrite').checked,
    options: Array.from(sel.options).map(function(o){ return o.textContent; }),
    selected: sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].textContent,
    cost: (el.querySelector('#sos-ai-cost')||{}).textContent || '',
  };
})()`);
t('sheet opened', !sheet.missing, sheet);
t('study kit is the default', sheet.kitChecked, sheet);
t('rewrite is on for a PDF', sheet.rewrite === true, sheet);
t('the five presets are offered', ['Standard', 'Explain like I know Python', 'Analogy-heavy', 'Exam-focused', 'Worked-examples-first']
  .every((n) => sheet.options.some((o) => o.startsWith(n))), sheet.options);
t('a preset is preselected', /^Standard/.test(sheet.selected || ''), sheet.selected);
t('the cost is stated before running', /Claude messages/.test(sheet.cost), sheet.cost);
const presetMod = await evalJs(`(function(){
  var m = classes.find(function(c){return c.id==='vk1';}).modules.find(function(m){ return m.name==='Study Kit Presets'; });
  return m ? { type: m.type, n: m.prompts.length } : null;
})()`);
t('presets live in an ordinary prompts module', presetMod && presetMod.type === 'prompts' && presetMod.n === 5, presetMod);

// Re-opening must not seed a second copy.
await evalJs(`document.querySelectorAll('.sos-ai-sheet').forEach(function(e){e.remove();}); window.sosRunPrompt('vk1','kf1','vkm1'); true;`);
await new Promise((r) => setTimeout(r, 400));
t('re-opening does not seed twice', await evalJs(`classes.find(function(c){return c.id==='vk1';}).modules.filter(function(m){return m.name==='Study Kit Presets';}).length === 1`));

console.log('\nrunning it');
await evalJs(`(function(){
  var sel = document.querySelector('#sos-ai-prompt');
  var opt = Array.from(sel.options).find(function(o){ return /^Exam-focused/.test(o.textContent); });
  sel.value = opt.value;
  Array.from(document.querySelectorAll('.sos-ai-sheet .modal-footer button')).find(function(b){ return /Generate/.test(b.textContent); }).click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 1500));
const posted = await evalJs(`window.__posted.filter(function(p){ return /\\/api\\/ai\\/jobs$/.test(p.url) && p.body; })`);
t('posted one job', posted.length === 1, posted.length);
if (posted.length) {
  const b = posted[0].body;
  t('mode=kit', b.mode === 'kit', b.mode);
  t('kitRewrite sent', b.kitRewrite === true, b.kitRewrite);
  t('the configured chat site, not notebooklm', b.site === 'claude', b.site);
  t('the chosen preset text was sent, interpolated', /Optimise for the exam/.test(b.prompt) && /Intro to Databases/.test(b.prompt), b.prompt.slice(0, 120));
  t('no literal {{variables}} left in the prompt', !/\{\{/.test(b.prompt));
  t('the source bytes ride along', typeof b.fileB64 === 'string' && b.fileB64.length > 0);
}
t('the chosen style is remembered for next time',
  await evalJs(`localStorage.getItem('studyos_kit_prompt_vk1') !== null`));

console.log('\nfiling');
await new Promise((r) => setTimeout(r, 4500));
const filed = await evalJs(`(function(){
  var cards = window.SOS.deck.forClass('vk1');
  var qs = window.SOS.quiz.forClass('vk1');
  var cls = classes.find(function(c){return c.id==='vk1';});
  var kitMod = cls.modules.find(function(m){ return m.name==='Study Kit'; });
  var raw = kitMod ? localStorage.getItem('studyos_notes_' + kitMod.id) : null;
  var st = raw ? JSON.parse(raw) : null;
  var entry = st && st.entries && st.entries[0];
  var gen = cls.modules.find(function(m){ return (m.files||[]).some(function(f){ return f.gen && f.gen.generated; }); });
  var gf = gen && gen.files.find(function(f){ return f.gen && f.gen.generated; });
  return {
    cards: cards.length,
    cardModules: Array.from(new Set(cards.map(function(c){ return c.moduleId; }))),
    defineCard: cards.some(function(c){ return c.q === 'Define: Superkey'; }),
    questions: qs.length,
    qModules: Array.from(new Set(qs.map(function(q){ return q.moduleId; }))),
    kitMod: kitMod ? kitMod.type : null,
    entryTitle: entry && entry.title,
    entryHtml: entry && entry.data && entry.data.html,
    deckName: gf && gf.name, deckModule: gen && gen.name, deckMode: gf && gf.gen && gf.gen.mode,
    toast: window.__toasts.join(' | '),
  };
})()`);
t('18 cards in the deck (16 + 2 key terms)', filed.cards === 18, filed);
t('cards carry the lecture module', filed.cardModules.length === 1 && filed.cardModules[0] === 'vkm1', filed.cardModules);
t('key terms became Define: cards', filed.defineCard);
t('9 questions in the quiz bank', filed.questions === 9, filed.questions);
t('questions carry the lecture module', filed.qModules.join() === 'vkm1', filed.qModules);
t('a notes-type Study Kit module exists', filed.kitMod === 'notes', filed.kitMod);
t('the cheat sheet is in the editor\'s own store', /Cheat sheet/.test(filed.entryTitle || ''), filed.entryTitle);
t('...rendered to HTML with the key terms', /<strong>Superkey<\/strong>/.test(filed.entryHtml || ''), (filed.entryHtml || '').slice(0, 200));
t('the rewritten deck was filed as a PDF', /Rewritten\.pdf$/.test(filed.deckName || ''), filed);
t('...recorded as a rewrite for the dedup key', filed.deckMode === 'rewrite', filed.deckMode);
t('...into the chosen documents module', filed.deckModule === 'Generated', filed.deckModule);
t('a "Study kit ready" toast names what landed', /Study kit ready/.test(filed.toast) && /18 cards/.test(filed.toast) && /9 quiz/.test(filed.toast), filed.toast);

console.log('\nvisible, not just stored');
const visible = await evalJs(`(async function(){
  switchView('class', 'vk1');
  await new Promise(function(r){ setTimeout(r, 600); });
  var names = Array.from(document.querySelectorAll('#modules-grid .module-card, #modules-grid [data-mod-id], #modules-grid .module-name'))
    .map(function(e){ return e.textContent; }).join(' | ');
  return { grid: (document.getElementById('modules-grid')||{}).textContent || '', names: names };
})()`);
t('the Study Kit module shows on the class page', /Study Kit/.test(visible.grid), visible.grid.slice(0, 300));
const rev = await evalJs(`(async function(){
  window.SOS.review.startReview({ classId: 'vk1' });
  await new Promise(function(r){ setTimeout(r, 300); });
  var q = (document.querySelector('.sos-review-q')||{}).textContent || '';
  window.SOS.review.closeReview();
  return q;
})()`);
t('kit cards are reviewable right away', /Kit card question|Define:/.test(rev), rev);

console.log('\nre-running the same lecture');
await evalJs(`window.__kit.flashcards = window.__kit.flashcards.slice(0, 10); true;`);
await evalJs(`(async function(){ var j = await window.SOS.pipeline.getJob('kj1'); await window.SOS.pipeline.fileResult(j); return true; })()`);
await new Promise((r) => setTimeout(r, 2500));
const rerun = await evalJs(`(function(){
  var cls = classes.find(function(c){return c.id==='vk1';});
  var kitMod = cls.modules.filter(function(m){ return m.name==='Study Kit'; });
  var st = JSON.parse(localStorage.getItem('studyos_notes_' + kitMod[0].id));
  var gen = cls.modules.find(function(m){ return m.name==='Generated'; });
  return { cards: window.SOS.deck.forClass('vk1').length, kitMods: kitMod.length, pages: st.entries.length,
           decks: gen.files.filter(function(f){ return f.gen && f.gen.generated; }).length,
           questions: window.SOS.quiz.forClass('vk1').length };
})()`);
t('unreviewed cards the new run lacks are dropped (10 + 2 terms)', rerun.cards === 12, rerun);
t('still one Study Kit module', rerun.kitMods === 1, rerun);
t('the cheat sheet page is replaced, not stacked', rerun.pages === 1, rerun);
t('the rewritten deck is replaced, not stacked', rerun.decks === 1, rerun);
t('questions are not duplicated', rerun.questions === 9, rerun);

const errs = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails?.exception?.description || '?')
  .filter((e) => !/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
console.log('\noverall');
t('no uncaught exceptions', errs.length === 0, errs.slice(0, 5));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
