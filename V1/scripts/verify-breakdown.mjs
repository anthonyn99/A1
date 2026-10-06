// Drives the topic breakdown in a real browser: the document row, the start
// sheet, the topics under the document, the lesson reader, its flashcards,
// and the AI settings view.
//
// The cases that earn their place:
//
//   "a lesson can never run script"
//       Lessons are model output. The unit test proves md.js escapes; this
//       proves the READER never bypasses it — an onerror payload in a lesson
//       must not fire in the real DOM.
//
//   "the flashcards reach the review"
//       The whole point of the last screen. "Review these now" must open a
//       review of THIS topic's cards, not every card in the class.
//
//   "nothing leaves the test"
//       The AI provider is stubbed in-page, the bridge is blocked by cdp.mjs,
//       and every Firestore save is stubbed before the fixture exists — an
//       earlier suite wrote its fixture to the live database, where it piled
//       up across runs (see verify-pipeline.mjs).
//
// Run:  node scripts/verify-breakdown.mjs      (after npm run build)
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
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await launch();
} catch (e) {
  if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); }
  throw e;
}
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Page.enable');

// The provider, stubbed before any app script runs. Answers by what the
// prompt asks for; records every request.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try {
      Object.keys(localStorage).filter(k => k.indexOf('studyos_cards_') === 0 || k === 'studyos_ai_v1')
        .forEach(k => localStorage.removeItem(k));
      localStorage.setItem('studyos_ai_v1', JSON.stringify({
        provider: 'openai', keys: { openai: 'sk-test' }, models: { openai: 'test-model' },
        baseUrl: { openai: 'https://ai.test/v1' } }));
    } catch (e) {}
    window.__aiCalls = [];
    const TOPICS = { topics: [
      { title: 'Candidate keys', summary: 'What makes a key minimal.', style: 'definitions', key_points: ['superkey', 'candidate key'], pages: '1-3' },
      { title: 'Inner joins', summary: 'Matching rows across tables.', style: 'procedure', key_points: ['join condition'], pages: '4-6' },
    ] };
    const LESSON1 = {
      blocks: [
        { kind: 'read', title: 'Keys', markdown: 'A **superkey** identifies a row. <img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script>', steps: [], questions: [], points: [] },
        { kind: 'steps', title: 'Finding a candidate key', markdown: '', questions: [], points: [],
          steps: [{ title: 'List the attributes', body: 'Write every column.' }, { title: 'Remove extras', body: 'Drop any attribute not needed.' }] },
        { kind: 'check', title: 'Check yourself', markdown: '', steps: [], points: [], questions: [
          { q: 'A minimal superkey is a…', choices: ['Foreign key', 'Candidate key', 'Composite key'], answer: 'Candidate key', explanation: 'Minimal by definition.' },
          { q: 'Can a superkey have extra attributes?', choices: ['Yes', 'No'], answer: 'Yes', explanation: 'Only candidate keys are minimal.' } ] },
        { kind: 'recap', title: 'Recap', markdown: '', steps: [], questions: [], points: ['Candidate keys are minimal superkeys.'] },
      ],
      flashcards: [
        { front: 'What is a superkey?', back: 'Any set of attributes that identifies a row.' },
        { front: 'What is a candidate key?', back: 'A minimal superkey.' },
        { front: 'Is every candidate key a superkey?', back: 'Yes.' },
      ] };
    const LESSON2 = {
      blocks: [{ kind: 'read', title: 'Joins', markdown: 'An inner join keeps matching rows.', steps: [], questions: [], points: [] }],
      flashcards: [{ front: 'What does an inner join keep?', back: 'Only rows that match.' }] };
    const realFetch = window.fetch;
    window.fetch = async (url, init) => {
      const u = String(url);
      if (u.indexOf('https://ai.test/') === 0) {
        const body = JSON.parse((init && init.body) || '{}');
        window.__aiCalls.push(body);
        const text = body.messages.find(m => m.role === 'user').content.map(p => p.text || '').join('');
        const out = /Break it into the TOPICS/.test(text) ? TOPICS : /title: Candidate keys/.test(text) ? LESSON1 : LESSON2;
        await new Promise(r => setTimeout(r, 150));
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }] }), { status: 200 });
      }
      return realFetch(url, init);
    };
  `,
});

await send('Page.navigate', { url: PAGE });
await wait(5000);

console.log('\nmodules loaded');
t('breakdown module', await evalJs('typeof (window.SOS && window.SOS.breakdown) === "object"'));
t('lesson reader', await evalJs('typeof (window.SOS && window.SOS.lessonUi) === "object"'));
t('row hook', await evalJs('typeof window.sosDecorateDocRow === "function"'));
t('AI nav entry', await evalJs('!!document.getElementById("nav-ai") && !!document.getElementById("sos-bn-ai")'));
t('the engagement upgrade is gone', await evalJs('!document.getElementById("nav-practice") && !document.getElementById("view-practice") && !window.sosStartNow'));

// ── Isolate, then seed ─────────────────────────────────────────────────────
const FID = 'bdf' + Date.now();
const seeded = await evalJs(`(function(){
  window._fbSaveStudyOs = function(){};
  window._fbSaveDoc = function(path, payload){ (window.__docSaves = window.__docSaves || []).push({ path: path, json: JSON.stringify(payload) }); };
  window._fbLoadDoc = async function(){ return {}; };
  window._fbSaveCards = function(){};
  window._sosBridge.resolveBlob = async function(){ return new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }); };
  for (var i = classes.length - 1; i >= 0; i--) if (classes[i].id === 'bd1') classes.splice(i, 1);
  var cls = { id:'bd1', name:'Database Processing', code:'CS 3410', color:'#9dc0ee', modules:[] };
  cls.modules.push({ id:'bdm1', name:'Lectures', type:'documents', prompts:[], notes:[], files:[
    { id:'${FID}', name:'Ch 2 Keys.pdf', size: 12, mime:'application/pdf', fileId:'${FID}' },
    { id:'${FID}x', name:'Ch 2.pptx', size: 12, mime:'application/vnd.openxmlformats-officedocument.presentationml.presentation', fileId:'${FID}x' },
    { id:'${FID}w', name:'Week 3 notes.docx', size: 12, mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileId:'${FID}w' },
  ]});
  cls.modules.push({ id:'bdp1', name:'Breakdown prompts', type:'prompts', files:[], notes:[],
    prompts:[{ id:'pp1', text:'Explain it like I am new to {{course_code}}.' }] });
  classes.push(cls);
  return window._sosBridge.revealModule('bd1', 'bdm1');
})()`);
t('seeded a class and opened its module', seeded === true, seeded);
await wait(700);

console.log('\nthe document row');
const rows = await evalJs(`(function(){
  var btns = Array.from(document.querySelectorAll('[data-act="breakdown"]'));
  return { n: btns.length, label: btns[0] && btns[0].textContent, file: btns[0] && btns[0].dataset.bdFile,
           file2: btns[1] && btns[1].dataset.bdFile, label2: btns[1] && btns[1].textContent,
           slides: document.querySelectorAll('[data-act="slides"]').length };
})()`);
t('a Break down button on the PDF', rows.n === 3 && rows.label === 'Break down' && rows.file === FID, rows);
t('...and on the .pptx', rows.file2 === FID + 'x' && rows.label2 === 'Break down', rows);
t('...and on the .docx', await evalJs(`(document.querySelector('[data-bd-file="${FID}w"]')||{}).textContent === 'Break down'`));

await evalJs(`document.querySelector('[data-bd-file="${FID}w"]').click(); true;`);
await wait(500);
const wordSheet = await evalJs(`(function(){
  var el = document.querySelector('.sos-ai-sheet.open');
  var txt = el ? el.textContent : '';
  var c = el && Array.from(el.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
  if (c) c.click();
  return txt;
})()`);
t('the .docx start sheet says Word converts it first', /Word on this PC/.test(wordSheet || '') && !/PowerPoint on this PC/.test(wordSheet || ''), (wordSheet || '').slice(0, 300));
await wait(400);

await evalJs(`document.querySelector('[data-bd-file="${FID}x"]').click(); true;`);
await wait(500);
const slidesSheet = await evalJs(`(function(){
  var el = document.querySelector('.sos-ai-sheet.open');
  var txt = el ? el.textContent : '';
  var c = el && Array.from(el.querySelectorAll('button')).find(b => b.textContent === 'Cancel');
  if (c) c.click();
  return txt;
})()`);
t('the .pptx start sheet says PowerPoint converts it first', /PowerPoint on this PC/.test(slidesSheet || ''), (slidesSheet || '').slice(0, 300));
await wait(400);

await evalJs(`document.querySelector('[data-act="breakdown"]').click(); true;`);
await wait(500);
const sheet = await evalJs(`(function(){
  var el = document.querySelector('.sos-ai-sheet.open');
  return el ? { text: el.textContent, go: !!el.querySelector('#sos-bd-go') } : null;
})()`);
t('the start sheet names the provider and model', sheet && /OpenAI-compatible/.test(sheet.text) && /test-model/.test(sheet.text), sheet && sheet.text.slice(0, 300));
t('...and what it will cost', sheet && /1 \+ one per topic/.test(sheet.text));

console.log('\nher prompt');
const picked = await evalJs(`(function(){
  var el = document.querySelector('.sos-ai-sheet.open');
  var mod = el.querySelector('#sos-bd-pmod'), ta = el.querySelector('#sos-bd-text');
  var opts = Array.from(mod.options).map(o => o.textContent);
  mod.value = 'bdp1'; mod.dispatchEvent(new Event('change'));
  var pre = ta.value;
  ta.value = pre + ' Focus on keys.'; ta.dispatchEvent(new Event('input'));
  var edited = el.querySelector('#sos-bd-edited').textContent;
  var vars = el.querySelector('#sos-bd-vars').textContent;
  el.querySelector('#sos-bd-save').click();
  var after = classes.find(c => c.id === 'bd1').modules.find(m => m.id === 'bdp1').prompts;
  return { opts, pre, edited, vars, saved: after.length, last: after[after.length - 1].text,
           selected: el.querySelector('#sos-bd-prompt').value === after[after.length - 1].id };
})()`);
t('the picker lists the class\'s prompts modules', picked.opts.some((o) => /Breakdown prompts \(1\)/.test(o)) && /None/.test(picked.opts[0]), picked.opts);
t('choosing a prompt fills the editable box', picked.pre === 'Explain it like I am new to {{course_code}}.', picked.pre);
t('editing it marks it edited for this document', /edited/.test(picked.edited), picked);
t('its variables are shown, resolved', /course_code/.test(picked.vars) && !/no value/.test(picked.vars), picked.vars);
t('"Save as a new prompt" adds it to the module and selects it',
  picked.saved === 2 && picked.last === 'Explain it like I am new to {{course_code}}. Focus on keys.' && picked.selected, picked);
await evalJs(`document.querySelector('#sos-bd-go').click(); true;`);
await wait(3000);
const mine = await evalJs(`window.__aiCalls.map(b => b.messages.find(m=>m.role==='user').content.map(p=>p.text||'').join('').includes('Explain it like I am new to CS 3410. Focus on keys.'))`);
t('every ask carried her prompt, variables filled', mine.length === 3 && mine.every(Boolean), mine);

console.log('\nthe breakdown');
const calls = await evalJs('window.__aiCalls.map(b => ({ file: b.messages.find(m=>m.role==="user").content.some(p=>p.type==="file"), fmt: b.response_format && b.response_format.type }))');
t('1 topics call + 1 lesson per topic', calls.length === 3, calls);
t('every call carries the PDF', calls.every((c) => c.file), calls);
t('every call asks for the JSON schema', calls.every((c) => c.fmt === 'json_schema'), calls);
const panel = await evalJs(`(function(){
  var p = document.querySelector('[data-bd-panel="${FID}"]');
  var b = document.querySelector('[data-act="breakdown"]');
  return { hidden: p && p.hidden, rows: p ? p.querySelectorAll('.bd-row').length : 0,
           titles: p ? Array.from(p.querySelectorAll('.bd-title')).map(e => e.textContent) : [],
           badges: p ? Array.from(p.querySelectorAll('.bd-badge')).map(e => e.textContent) : [],
           label: b && b.textContent, status: p && (p.querySelector('.bd-status')||{}).textContent };
})()`);
t('the topics appear under the document', panel.hidden === false && panel.rows === 2, panel);
t('in the document\'s order', panel.titles.join('|') === 'Candidate keys|Inner joins', panel.titles);
t('each shows its card count', panel.badges.join('|') === '3 cards|1 cards', panel.badges);
t('the row button now reads Topics · 2', panel.label === 'Topics · 2', panel.label);
t('the status line names the prompt used', /prompt: Explain it like I am new/.test(panel.status || ''), panel.status);
t('...and offers a redo with another one', await evalJs(`!!document.querySelector('[data-bd-panel="${FID}"] [data-redo]')`));
t('the cards joined the review deck', (await evalJs(`window.SOS.deck.byNotePrefix('bd1','topic_${FID}_').length`)) === 4);
t('the breakdown synced to its own doc', await evalJs(`(window.__docSaves||[]).some(s => s.path === 'studyos_topics/${FID}')`));
t('the file carries its summary', await evalJs(`(function(){
  var f = classes.find(c=>c.id==='bd1').modules[0].files.find(x=>x.id==='${FID}');
  return !!(f.study && f.study.total === 2 && f.study.done === 2 && f.study.status === 'ready');
})()`));

console.log('\nthe lesson reader');
await evalJs(`document.querySelector('[data-bd-panel="${FID}"] .bd-row').click(); true;`);
await wait(600);
const l1 = await evalJs(`(function(){
  var v = document.getElementById('view-lesson');
  var r = document.getElementById('sos-lesson-root');
  return { active: v.classList.contains('active'), title: (r.querySelector('.sl-title')||{}).textContent,
           count: (r.querySelector('.sl-count span')||{}).textContent, strong: !!r.querySelector('.sl-prose strong'),
           img: r.querySelectorAll('.sl-prose img').length, script: r.querySelectorAll('.sl-prose script').length,
           crumb: (r.querySelector('.sl-crumb')||{}).textContent };
})()`);
t('opens in the full-page reader', l1.active && l1.title === 'Candidate keys', l1);
t('one screen of five (4 blocks + flashcards)', l1.count === '1 of 5', l1.count);
t('says where it is: class and topic N of M', /CS 3410/.test(l1.crumb) && /Topic 1 of 2/.test(l1.crumb), l1.crumb);
t('markdown renders', l1.strong, l1);
await wait(300);
t('an onerror payload in a lesson never runs', (await evalJs('window.__pwned === undefined')) && l1.img === 0 && l1.script === 0, l1);

await evalJs(`document.querySelector('#sos-lesson-root [data-next]').click(); true;`);
await wait(200);
let steps = await evalJs(`document.querySelectorAll('#sos-lesson-root .sl-step').length`);
t('a step-through shows one step at a time', steps === 1, steps);
await evalJs(`document.querySelector('#sos-lesson-root [data-step]').click(); true;`);
await wait(150);
steps = await evalJs(`document.querySelectorAll('#sos-lesson-root .sl-step').length`);
t('...and reveals the next on request', steps === 2, steps);

// Keyboard: → moves on.
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
await wait(200);
const onCheck = await evalJs(`(function(){
  var b = document.querySelector('#sos-lesson-root [data-check]');
  return { count: document.querySelector('#sos-lesson-root .sl-count span').textContent, disabled: b && b.disabled,
           choices: document.querySelectorAll('#sos-lesson-root .sl-choice').length };
})()`);
t('the arrow key moved to the check', onCheck.count === '3 of 5', onCheck);
t('Check waits until every question is answered', onCheck.disabled === true, onCheck);
await evalJs(`(function(){
  var cs = Array.from(document.querySelectorAll('#sos-lesson-root .sl-choice'));
  cs.find(b => b.dataset.q === '0' && b.dataset.choice === 'Foreign key').click();
})(); true;`);
await wait(100);
await evalJs(`(function(){
  var cs = Array.from(document.querySelectorAll('#sos-lesson-root .sl-choice'));
  cs.find(b => b.dataset.q === '1' && b.dataset.choice === 'Yes').click();
  document.querySelector('#sos-lesson-root [data-check]').click();
})(); true;`);
await wait(150);
const checked = await evalJs(`(function(){
  var r = document.getElementById('sos-lesson-root');
  return { wrong: r.querySelectorAll('.sl-choice.wrong').length, right: r.querySelectorAll('.sl-choice.right').length,
           expl: r.querySelectorAll('.sl-expl').length, verdict: (r.querySelector('.sl-verdict')||{}).textContent || '',
           nextOk: !r.querySelector('[data-next]').disabled };
})()`);
t('a wrong pick is marked, the right answer shown', checked.wrong === 1 && checked.right === 2, checked);
t('every question explains itself', checked.expl === 2, checked);
t('the score is shown', /1 of 2 right/.test(checked.verdict), checked.verdict);
t('a check never blocks moving on', checked.nextOk, checked);

await evalJs(`document.querySelector('#sos-lesson-root [data-next]').click(); true;`);
await wait(100);
await evalJs(`document.querySelector('#sos-lesson-root [data-next]').click(); true;`);
await wait(200);
const cards = await evalJs(`(function(){
  var r = document.getElementById('sos-lesson-root');
  var f = r.querySelector('.sl-flip');
  return { count: r.querySelector('.sl-count span').textContent, flip: f && f.textContent, h: (r.querySelector('.sl-card h2')||{}).textContent,
           nextTopic: !!r.querySelector('.sl-nav [data-topic]') };
})()`);
t('the last screen is the flashcards', cards.count === '5 of 5' && /Flashcards · 3/.test(cards.h), cards);
t('it shows a question first', /Question/.test(cards.flip), cards.flip);
t('and offers the next topic', cards.nextTopic);
await evalJs(`document.querySelector('#sos-lesson-root .sl-flip').click(); true;`);
await wait(100);
t('tap flips to the answer', /Answer/.test(await evalJs(`document.querySelector('#sos-lesson-root .sl-flip').textContent`)));

await evalJs(`document.querySelector('#sos-lesson-root [data-review]').click(); true;`);
await wait(500);
const rv = await evalJs(`(function(){
  var o = document.querySelector('.sos-review');
  return o ? { count: (o.querySelector('[data-count]')||{}).textContent } : null;
})()`);
t('"Review these now" opens a review', !!rv, rv);
t('...of this topic\'s 3 cards only', rv && /\/3\b/.test(rv.count), rv);
await evalJs(`window.SOS.review.closeReview && window.SOS.review.closeReview(); true;`);
await wait(2200);

t('finishing the lesson is remembered', await evalJs(`(function(){
  var d = window.SOS.breakdown.peek('${FID}');
  return !!(d && d.topics[0].progress && d.topics[0].progress.done);
})()`));

console.log('\nback to the document');
await evalJs(`document.querySelector('#sos-lesson-root .sl-back').click(); true;`);
await wait(700);
const back = await evalJs(`(function(){
  var p = document.querySelector('[data-bd-panel="${FID}"]');
  return { modal: !!document.querySelector('#modal-module-detail.open'),
           done: p ? p.querySelectorAll('.bd-num.done').length : -1 };
})()`);
t('lands back on the module', back.modal, back);
t('the finished topic is ticked', back.done === 1, back);

// ── The document's text, through the real pdf.js ───────────────────────────
/* The unit tests stub the page reader (pdf.js is a browser build); this runs
 * the built app's own extraction on a PDF made here: a slide whose exponents
 * are smaller, raised text — the shape PowerPoint exports — plus a repeated
 * agenda page. Then the checks on what came out. */
console.log('\nthe document text (real pdf.js)');
const pdfText = await evalJs(`(async function(){
  var pages = [
    ['BT /F1 32 Tf 60 520 Td (Chapter 1 Objectives) Tj ET',
     'BT /F1 20 Tf 60 470 Td (Understand units of measure common to computer systems) Tj ET',
     'BT /F1 20 Tf 60 440 Td (Explain the von Neumann architecture and its components) Tj ET'],
    ['BT /F1 32 Tf 60 520 Td (The Measures of Capacity) Tj ET',
     'BT /F1 22 Tf 60 470 Td (Kilo = 1 thousand = 10) Tj ET', 'BT /F1 14 Tf 300 477 Td (3) Tj ET',
     'BT /F1 22 Tf 312 470 Td (and 2) Tj ET', 'BT /F1 14 Tf 372 477 Td (10) Tj ET',
     'BT /F1 22 Tf 60 430 Td (1KB = 1024 Bytes, not 1000 Bytes) Tj ET'],
    ['BT /F1 32 Tf 60 520 Td (Chapter 1 Objectives) Tj ET',
     'BT /F1 20 Tf 60 470 Td (Understand units of measure common to computer systems) Tj ET',
     'BT /F1 20 Tf 60 440 Td (Explain the von Neumann architecture and its components) Tj ET'],
    // A slide with a figure: a 200x200 raster image (drawn as an inline image).
    ['BT /F1 32 Tf 60 520 Td (The von Neumann Model) Tj ET',
     'q 300 0 0 300 60 60 cm BI /W 200 /H 200 /BPC 8 /CS /G /F /AHx ID ' + '80'.repeat(40000) + '> EI Q'],
  ];
  // A minimal PDF, offsets computed so no repair pass is needed.
  var objs = [], kids = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach(function (ops, i) {
    var stream = ops.join(String.fromCharCode(10));
    var pid = 4 + i * 2, cid = 5 + i * 2;
    objs[cid] = '<< /Length ' + stream.length + ' >>' + String.fromCharCode(10) + 'stream' + String.fromCharCode(10) + stream + String.fromCharCode(10) + 'endstream';
    objs[pid] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 540] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + cid + ' 0 R >>';
    kids.push(pid + ' 0 R');
  });
  objs[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>';
  var nl = String.fromCharCode(10), out = '%PDF-1.4' + nl, offs = [];
  for (var n = 1; n < objs.length; n++) { offs[n] = out.length; out += n + ' 0 obj' + nl + objs[n] + nl + 'endobj' + nl; }
  var xref = out.length;
  out += 'xref' + nl + '0 ' + objs.length + nl + '0000000000 65535 f ' + nl;
  for (n = 1; n < objs.length; n++) out += String(offs[n]).padStart(10, '0') + ' 00000 n ' + nl;
  out += 'trailer' + nl + '<< /Size ' + objs.length + ' /Root 1 0 R >>' + nl + 'startxref' + nl + xref + nl + '%%EOF';
  window.__testPdf = btoa(out);            // the figures section below reuses it
  var pp = await window.SOS.ai.pdfPages(btoa(out));
  var bd = window.SOS.breakdown, m = bd.sourceModel(pp);
  var econ = bd.groundTopics([{ title: 'Introduction to Demand and Supply', key_points: ['Market equilibrium where buyers and sellers meet', 'The demand curve and price elasticity'], pages: '1-3' }], m);
  var shots = await window.SOS.ai.pdfPageImages(btoa(out), [4]);
  return { lines: pp.map(function (p) { return p.lines.map(function (l) { return l.text; }); }), content: m.content,
           invented: econ.invented.length, figures: pp.map(function (p) { return !!p.figure; }),
           shot: shots.length === 1 && shots[0].n === 4 ? shots[0].url.slice(0, 23) + '…' + shots[0].url.length : null };
})()`);
t('pdf.js runs in the built app', !!pdfText && pdfText.lines.length === 4, pdfText);
t('exponents come out marked: 10^3 and 2^10', pdfText.lines[1].includes('Kilo = 1 thousand = 10^3 and 2^10'), pdfText.lines[1]);
t('the repeated agenda page is not material; the units page and the picture slide are', pdfText.content.join() === '2,4', pdfText.content);
t('an invented topic is caught against real extracted text', pdfText.invented === 1, pdfText);
t('only the slide with a picture is a figure page', pdfText.figures.join() === 'false,false,false,true', pdfText.figures);
t('a figure page renders to a JPEG for a text-only model', !!pdfText.shot && pdfText.shot.startsWith('data:image/jpeg;base64,'), pdfText.shot);

// ── Figures in the reader ──────────────────────────────────────────────────
/* A lesson stores only {page} for a document figure; the reader draws that
 * page from the PDF on the device. A drawn figure is model-written SVG, shown
 * as an <img> so nothing in it can run — proven here with a payload the
 * validator would have refused, injected straight into the stored lesson. */
console.log('\nfigures in the reader');
const until = async (expr, ms = 8000) => {
  for (let i = 0; i < ms / 100; i++) { if (await evalJs(expr)) return true; await wait(100); }
  return false;
};
const FIG = 'bdfig' + Date.now();
const figOpened = await evalJs(`(async function(){
  var cls = classes.find(function (c) { return c.id === 'bd1'; });
  cls.modules[0].files.push({ id:'${FIG}', name:'Ch 1 Intro.pdf', size: 12, mime:'application/pdf', fileId:'${FIG}' },
    { id:'${FIG}n', name:'Missing.pdf', size: 12, mime:'application/pdf', fileId:'${FIG}n' });
  var bin = atob(window.__testPdf), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var prevBlob = window._sosBridge.resolveBlob;
  window._sosBridge.resolveBlob = async function (f) {
    if (f && f.id === '${FIG}') return new Blob([bytes], { type: 'application/pdf' });
    if (f && f.id === '${FIG}n') return null;
    return prevBlob(f);
  };
  var SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" onload="window.__pwned=4">' +
    '<rect x="5" y="5" width="40" height="40" fill="#000"/><text x="55" y="30">CPU</text></svg>';
  var none = { steps: [], questions: [], points: [] };
  var doc = function (id) { return { fileId: id, classId: 'bd1', moduleId: 'bdm1', sourceName: 'Ch 1 Intro.pdf',
    status: 'ready', listedAt: 1, updatedAt: 1, topics: [{ id: 'tf', title: 'The von Neumann model', status: 'ready', updatedAt: 1,
      lesson: { blocks: [
        Object.assign({ kind: 'read', title: 'The model', markdown: 'A CPU, memory and I/O.' }, none),
        Object.assign({ kind: 'figure', title: '<img src=x onerror="window.__pwned=3">Model', markdown: 'Note the **bus**.', page: 4, svg: '' }, none),
        Object.assign({ kind: 'figure', title: 'The parts', markdown: '', page: 4, svg: SVG }, none),
        Object.assign({ kind: 'recap', title: 'Recap', markdown: '' }, none, { points: ['Three parts.'] }) ] } }] }; };
  var prevLoad = window._fbLoadDoc;
  window._fbLoadDoc = async function (path) {
    if (path === 'studyos_topics/${FIG}') return doc('${FIG}');
    if (path === 'studyos_topics/${FIG}n') return doc('${FIG}n');
    return prevLoad(path);
  };
  return await window.SOS.lessonUi.open('${FIG}', 'tf');
})()`);
t('a lesson with figures opens', figOpened === true, figOpened);
await evalJs(`document.querySelector('#sos-lesson-root [data-next]').click(); true;`);
const figLoaded = await until(`(function(){ var i = document.querySelector('#sos-lesson-root .sl-fig img'); return !!(i && i.complete && i.naturalWidth > 0); })()`);
const fig1 = await evalJs(`(function(){
  var r = document.getElementById('sos-lesson-root'), img = r.querySelector('.sl-fig img');
  var out = { label: r.querySelectorAll('.sl-count span')[1].textContent, h2: (r.querySelector('.sl-card h2')||{}).textContent,
    cap: (r.querySelector('.sl-fig figcaption')||{}).textContent, bold: !!r.querySelector('.sl-prose strong'),
    src: img ? img.src.slice(0, 23) : null, alt: img && img.alt };
  if (img && img.naturalWidth) {
    // Page 4 draws a mid-gray square at (60,60)-(360,360) of a 720x540 page.
    var c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    var g = c.getContext('2d'); g.drawImage(img, 0, 0);
    var px = g.getImageData(Math.round(c.width * 210 / 720), Math.round(c.height * 330 / 540), 1, 1).data;
    var white = g.getImageData(Math.round(c.width * 600 / 720), Math.round(c.height * 100 / 540), 1, 1).data;
    out.px = [px[0], px[1], px[2]]; out.white = [white[0], white[1], white[2]];
  }
  return out;
})()`);
t('the document figure loads, rendered from the PDF', figLoaded && fig1.src === 'data:image/jpeg;base64,', fig1);
t('...and it is page 4: mid-gray where its picture is, white elsewhere',
  !!fig1.px && fig1.px.every((v) => v >= 100 && v <= 160) && fig1.white.every((v) => v > 230), fig1);
t('it is labelled a figure, captioned with its page', fig1.label === 'Figure' && /From page 4 of Ch 1 Intro\.pdf/.test(fig1.cap), fig1);
t('the note under it renders as markdown', fig1.bold, fig1);
t('a hostile title shows as text', /<img src=x/.test(fig1.h2) && /<img src=x/.test(fig1.alt), fig1);

await evalJs(`document.querySelector('#sos-lesson-root [data-next]').click(); true;`);
const drawnLoaded = await until(`(function(){ var i = document.querySelector('#sos-lesson-root .sl-fig img'); return !!(i && i.complete && i.naturalWidth > 0); })()`);
const fig2 = await evalJs(`(function(){
  var r = document.getElementById('sos-lesson-root'), img = r.querySelector('.sl-fig img');
  return { src: img ? img.src.slice(0, 18) : null, drawn: !!(img && img.classList.contains('drawn')),
    cap: (r.querySelector('.sl-fig figcaption')||{}).textContent, svgInDom: !!r.querySelector('svg') };
})()`);
t('a drawn figure shows as an image of its SVG', drawnLoaded && fig2.src === 'data:image/svg+xml' && fig2.drawn && !fig2.svgInDom, fig2);
t('...captioned as drawn, naming the page it redraws', /Drawn for this lesson · redraws the figure on page 4/.test(fig2.cap), fig2.cap);
await wait(300);
t('nothing in a figure ever runs', await evalJs('window.__pwned === undefined'));
await evalJs(`document.querySelector('#sos-lesson-root [data-fig-orig]').click(); true;`);
const origShown = await until(`(function(){ var i = document.querySelector('#sos-lesson-root .sl-fig img'); return !!(i && i.src.indexOf('data:image/jpeg') === 0 && i.naturalWidth > 0); })()`);
t('"show the original" swaps in the document page', origShown,
  await evalJs(`(document.querySelector('#sos-lesson-root .sl-fig')||{}).outerHTML || null`));

await evalJs(`window.SOS.lessonUi.open('${FIG}n', 'tf').then(function(){ document.querySelector('#sos-lesson-root [data-next]').click(); }); true;`);
const missing = await until(`/couldn.t be loaded/.test((document.querySelector('#sos-lesson-root .sl-fig')||{}).textContent || '')`);
t('without the PDF on this device, the figure says so instead of breaking', missing
  && (await evalJs(`document.querySelectorAll('#sos-lesson-root .sl-fig img').length`)) === 0,
  await evalJs(`(document.querySelector('#sos-lesson-root .sl-fig')||{}).textContent || null`));

console.log('\nAI settings');
await evalJs(`document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open')); switchView('ai'); true;`);
await wait(300);
const set1 = await evalJs(`(function(){
  var r = document.getElementById('sos-ai-root');
  return { provs: r.querySelectorAll('[data-prov]').length, on: (r.querySelector('[data-prov].on')||{}).dataset.prov,
           note: r.textContent };
})()`);
t('five providers offered (ORCA included)', set1.provs === 5, set1);
t('the stored choice is selected', set1.on === 'openai', set1.on);
t('says keys stay in this browser', /in this browser only/.test(set1.note));
await evalJs(`document.querySelector('#sos-ai-root [data-prov="anthropic"]').click(); true;`);
await wait(150);
const set2 = await evalJs(`(function(){
  var k = document.getElementById('ais-key'), m = document.getElementById('ais-model');
  return { type: k && k.type, model: m && m.value };
})()`);
t('the key field is masked', set2.type === 'password', set2);
t('Anthropic defaults to the current Opus', set2.model === 'claude-opus-5-5', set2);
await evalJs(`document.getElementById('ais-key').value = 'sk-ant-verify'; document.querySelector('#sos-ai-root [data-save]').click(); true;`);
await wait(200);
const saved = await evalJs(`(function(){
  var s = JSON.parse(localStorage.getItem('studyos_ai_v1'));
  var synced = JSON.stringify(classes) + (window.__docSaves||[]).map(x => x.json).join('');
  return { provider: s.provider, key: s.keys.anthropic, kept: s.keys.openai,
           msg: document.getElementById('ais-msg').textContent, leaked: synced.indexOf('sk-ant-verify') >= 0 };
})()`);
t('saved on this device', saved.provider === 'anthropic' && saved.key === 'sk-ant-verify', saved);
t('the other provider\'s key is kept', saved.kept === 'sk-test', saved);
t('the save is confirmed on screen', /Saved/.test(saved.msg), saved.msg);
t('the key is in no synced data', saved.leaked === false);

// ORCA: one key; its models come from ORCA's own list (/v1/models), stubbed
// here so nothing reaches the real ORCA.
await evalJs(`(function(){
  var real = window.fetch;
  window.__orcaAsked = [];
  window.fetch = function(url, init){
    if (String(url).indexOf('/v1/models') >= 0) {
      window.__orcaAsked.push({ url: String(url), auth: init && init.headers && init.headers.Authorization });
      return Promise.resolve(new Response(JSON.stringify({ object: 'list', data: [
        { backend_key: 'claude/free', backend_type: 'browser', enabled: true, routable: true, provider_model_id: 'claude-web', display_name: 'Claude free (browser)' },
        { backend_key: 'deepseek/free', backend_type: 'browser', enabled: true, routable: true, provider_model_id: 'deepseek-web', display_name: 'DeepSeek (browser)' },
        { backend_key: 'perplexity/free', backend_type: 'browser', enabled: true, routable: false, provider_model_id: 'perplexity-web', display_name: 'Perplexity (browser)' },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return real.apply(this, arguments);
  };
  document.querySelector('#sos-ai-root [data-prov="orca"]').click();
})(); true;`);
await wait(150);
const o1 = await evalJs(`(function(){
  var s = document.getElementById('ais-pick');
  return { opts: s ? [...s.options].map(o => o.value) : null, model: !!document.getElementById('ais-model'),
           detect: !!document.querySelector('#sos-ai-root [data-detect]') };
})()`);
t('ORCA: one key, Auto, and a Detect models button', o1.opts && o1.opts.join() === 'auto' && o1.detect, o1);
t('...no free-text model field', o1.model === false, o1);
await evalJs(`(function(){ document.getElementById('ais-key').value = 'orca_sk_v'; document.querySelector('#sos-ai-root [data-detect]').click(); })(); true;`);
await wait(400);
const o2 = await evalJs(`(function(){
  var s = document.getElementById('ais-pick');
  return { opts: [...s.options].map(o => [o.value, o.disabled, o.textContent.trim()]), asked: window.__orcaAsked,
           note: (document.getElementById('ais-detected')||{}).textContent };
})()`);
t('Detect asks ORCA with the key', o2.asked.length === 1 && /\/v1\/models$/.test(o2.asked[0].url) && o2.asked[0].auth === 'Bearer orca_sk_v', o2.asked);
t('...and lists its models, usable first', o2.opts.map((o) => o[0]).join() === 'auto,claude/free,deepseek/free,perplexity/free', o2.opts);
t('...an unusable one greyed, saying why', o2.opts[3][1] === true && /not signed in/.test(o2.opts[3][2]), o2.opts[3]);
t('...and how many are usable', /2 of 3 models usable/.test(o2.note), o2.note);
await evalJs(`(function(){ var s = document.getElementById('ais-pick'); s.value = 'deepseek/free'; s.dispatchEvent(new Event('change')); })(); true;`);
await wait(150);
t('picking one offers what to do when it is busy', await evalJs(`!!document.getElementById('ais-busy')`));
await evalJs(`document.querySelector('#sos-ai-root [data-save]').click(); true;`);
await wait(200);
const o3 = await evalJs(`(function(){
  var s = JSON.parse(localStorage.getItem('studyos_ai_v1'));
  var synced = JSON.stringify(classes) + (window.__docSaves||[]).map(x => x.json).join('');
  return { pick: s.orcaPick, key: s.keys.orca, old: 'orcaKeys' in s,
           msg: document.getElementById('ais-msg').textContent, leaked: /orca_sk_v/.test(synced) };
})()`);
t('saved: one key, DeepSeek picked', o3.pick === 'deepseek/free' && o3.key === 'orca_sk_v' && !o3.old, o3);
t('the save names ORCA · DeepSeek (browser)', /ORCA · DeepSeek \(browser\)/.test(o3.msg), o3.msg);
t('no ORCA key in synced data', o3.leaked === false);

const errs = events
  .filter(e => e.method === 'Runtime.exceptionThrown')
  .map(e => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || '?')
  .filter(e => !/firebase|firestore|net::|Failed to load resource|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
t('no uncaught exceptions', errs.length === 0, errs.slice(0, 4));

// Leave nothing behind for the next run.
await evalJs(`(function(){
  for (var i = classes.length - 1; i >= 0; i--) if (classes[i].id === 'bd1') classes.splice(i, 1);
  localStorage.removeItem('studyos_cards_bd1'); localStorage.removeItem('studyos_ai_v1');
})(); true;`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
