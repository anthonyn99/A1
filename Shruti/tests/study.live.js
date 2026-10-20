// LIVE test: Shruti's Study tab (Phase 7) in real headless Edge, on its real
// origin served from this working copy. Not run by npm test.
//
//   node Shruti/tests/study.live.js          (CDP_ALLOW_FONTS=1 for real typefaces)
//
// Orca (models, chat, speech) is answered here; Firebase is fake. Tony at
// 1280 drives every tool and the maker; Veda at 390 checks the layout and
// that her progress is her own.
'use strict';
const path = require('path');
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'cdp.js'));
const { firebaseMock } = require(path.join(__dirname, '..', '..', 'tests', 'live', 'fake-firebase.js'));
const ev = (c, x) => evalJs(c, /^\s*return\b/.test(x) && x.indexOf(';') < 0 ? x + ';' : x);

const URL = 'https://anthonyn99.github.io/A1/Shruti/shruti.html';
const KEY = 'orca_sk_live_test_key_123';
const ORCA = 'https://orca.vedapatel05.workers.dev/v1';
const CLIP = fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'media', 'ch01-podcast.mp3')).subarray(0, 6000).toString('base64');
const set4 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'books', 'gita', 'study', 'ch04.json'), 'utf8'));
const QUIZ = 'Q1. What does 4.18 call wise?\nA. Never acting\nB. Seeing inaction in action\nC. Acting for reward\nD. Rituals\nCORRECT: B\nWHY: Selfless work leaves no Karma.\n\nQ2. When does God manifest?\nA. Never\nB. Once\nC. When Dharma declines\nD. At night\nCORRECT: C\nWHY: 4.7-8.';

const S = { chats: [], speech: 0 };
const mock = firebaseMock({
  patterns: [ORCA + '/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = req.url;
    if (u.startsWith(ORCA + '/models')) return { json: { object: 'list', data: [{ id: 'deepseek/free', routable: true }, { id: 'chatgpt/free', routable: true }] } };
    if (u.startsWith(ORCA + '/chat/completions')) {
      const b = JSON.parse(req.postData || '{}');
      S.chats.push({ model: b.model, body: JSON.stringify(b.messages) });
      return { type: 'text/event-stream', text: QUIZ.match(/[\s\S]{1,120}/g).map((p) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n').join('') + 'data: [DONE]\n\n' };
    }
    if (u.startsWith(ORCA + '/audio/speech')) { S.speech++; return { json: { format: 'mp3', engine: 'edge', voice: 'v', audio: CLIP, words: [[0, 0.1, 'x']] } }; }
    return null;
  },
});

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -> ' + String(d).slice(0, 400) : '')); }
};
const waitFor = async (c, expr, ms = 12000) => {
  const t0 = Date.now();
  if (expr.indexOf(';') >= 0 && !/^\s*(return|const|let|var|if|for)\W/.test(expr)) expr = 'return ' + expr;
  while (Date.now() - t0 < ms) { try { if (await ev(c, expr)) return true; } catch {} await sleep(150); }
  return false;
};
const shot = async (c, name) => {
  await sleep(700);
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const data = r && (r.result ? r.result.data : r.data);
  if (data) fs.writeFileSync(shotPath('shruti-' + name), Buffer.from(data, 'base64'));
};
async function click(c, sel) {
  const at = JSON.parse(await ev(c, `const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'null'; e.scrollIntoView({block:'center', behavior:'instant'}); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})`));
  if (!at) throw new Error('no ' + sel);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
}
const key = async (c, k, code) => {
  for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: k, code: code || k, text: type === 'keyDown' && k.length === 1 ? k : undefined, windowsVirtualKeyCode: k === ' ' ? 32 : k === 'Escape' ? 27 : k === 'ArrowRight' ? 39 : k === 'ArrowLeft' ? 37 : k.toUpperCase().charCodeAt(0) });
  await sleep(120);
};
let RUN = String(Date.now());
const BOOT = (store) => `(()=>{ if(window.top!==window) return;
  try{ if(sessionStorage.getItem('__run')!=='${RUN}'){ localStorage.clear(); sessionStorage.clear(); ${store || ''} sessionStorage.setItem('__run','${RUN}'); } }catch(e){}
  window.__errs=[]; addEventListener('error', e=>window.__errs.push(String(e.message)));
  addEventListener('unhandledrejection', e=>window.__errs.push('rejection: '+String(e.reason && e.reason.message || e.reason)));
})();`;
let inj = null;
async function load(c, { w, h, mobile, store, hash = '' }) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  if (inj) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier });
  inj = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT(store) });
  await c.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await c.send('Page.navigate', { url: URL + hash });
  await sleep(400);
}
const pick = (c, kind, set = 'ch4') => ev(c, `document.querySelector('.sh-kind[data-set="${set}"][data-kind="${kind}"]').click(); return 1`);
const prog = (c, path) => ev(c, `return JSON.stringify(window.Shruti.core.me.get(${JSON.stringify(path)}, null))`);

(async () => {
  const c = await connect({ mock });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  console.log('\nTony at 1280: the book');
  await load(c, { w: 1280, h: 900, mobile: false, store: "sessionStorage.removeItem('__fakefs_docs'); sessionStorage.setItem('shruti.pick','tony');", hash: '#/b/gita' });
  await waitFor(c, `!!window.Shruti && !!window.Shruti.core.me.loaded`, 15000);
  await ev(c, `return window.Shruti.core.me.set({orcaKey:${JSON.stringify(KEY)}},{now:true}) || 1`);
  ok('every chapter\'s Study badge is lit', await waitFor(c, `const b=[...document.querySelectorAll('.ch')].map(r=>r.querySelectorAll('.bdg')[3]); return b.length===18 && b.every(x=>x.classList.contains('av'))`));

  console.log('\nThe Study tab');
  await ev(c, `location.hash='#/b/gita/4/study'; return 1`);
  ok('the sidebar shows the ready-made set with its four kinds', await waitFor(c, `document.querySelectorAll('.sh-set').length===1 && document.querySelectorAll('.sh-kind').length===4 && /Comes with Shruti/.test(document.querySelector('.sh-set-h').textContent)`));
  ok('each kind has its status tag', await waitFor(c, `const t=[...document.querySelectorAll('.sh-kind em')].map(e=>e.textContent); return t[0]==='${set4.flashcards.length} cards' && t[1]==='${set4.quiz.length} questions' && /branches/.test(t[2]) && t[3]==='${set4.slides.length} slides'`), await ev(c, `return [...document.querySelectorAll('.sh-kind em')].map(e=>e.textContent).join('|')`));
  await shot(c, 'study-flashcards-tony-1280');

  console.log('\nFlashcards');
  ok('the first card shows its front', await waitFor(c, `document.querySelector('.fc-stage .fc-front .fc-text').textContent===${JSON.stringify(set4.flashcards[0].front)}`));
  await key(c, ' ', 'Space');
  ok('Space turns it over', await waitFor(c, `document.querySelector('.fc-stage .fc-card').classList.contains('flipped')`));
  await key(c, '2', 'Digit2');
  ok('2 = got it: the next card, and box 1 synced for Tony', await waitFor(c, `document.querySelector('.fc-num').textContent.startsWith('2 /') && Object.values(window.Shruti.core.me.get('study.gita.ch4.flashcards.b',{})).join()==='1'`), await prog(c, 'study.gita.ch4.flashcards'));
  await click(c, '.fc-learn');
  ok('Still learning: box 0, and the bar counts 1 known, 1 learning', await waitFor(c, `Object.values(window.Shruti.core.me.get('study.gita.ch4.flashcards.b',{})).sort().join()==='0,1' && /1 known/.test(document.querySelector('.st-meta').textContent) && /1 learning/.test(document.querySelector('.st-meta').textContent)`));
  ok('…and the sidebar tag says so', await waitFor(c, `/1 of ${set4.flashcards.length} known/.test(document.querySelector('.sh-kind.on em').textContent)`), await ev(c, `return document.querySelector('.sh-kind.on em').textContent`));
  ok('a Review button offers the card still being learned', await waitFor(c, `[...document.querySelectorAll('.st-actions .btn')].some(b=>/Review 1/.test(b.textContent))`));
  await ev(c, `[...document.querySelectorAll('.st-actions .btn')].find(b=>/All cards/.test(b.title)).click(); return 1`);
  ok('the grid shows every card', await waitFor(c, `document.querySelectorAll('.fc-grid .fc-card').length===${set4.flashcards.length}`));
  await ev(c, `document.querySelector('.fc-grid .fc-card').click(); return 1`);
  ok('a grid card turns over on its own', await waitFor(c, `document.querySelector('.fc-grid .fc-card').classList.contains('flipped')`));

  console.log('\nQuiz');
  await pick(c, 'quiz');
  ok('the quiz opens on question 1 with four options', await waitFor(c, `document.querySelectorAll('.qz-opt').length===4 && /Question 1 of ${set4.quiz.length}/.test(document.querySelector('.qz-kicker').textContent)`));
  const correct0 = set4.quiz[0].correct, wrong0 = 'ABCD'.split('').find((x) => x !== correct0);
  await key(c, wrong0.toLowerCase(), 'Key' + wrong0);
  ok('a wrong answer locks, shows the right one and why', await waitFor(c, `document.querySelector('.qz-opt.wrong') && document.querySelector('.qz-opt.correct .qz-letter').textContent==='${correct0}' && /Not quite/.test(document.querySelector('.qz-fb').textContent) && document.querySelectorAll('.qz-opt[disabled]').length===4`));
  ok('the pick is synced for Tony', (await prog(c, 'study.gita.ch4.quiz.picked')) === JSON.stringify({ 0: wrong0 }));
  for (let i = 1; i < set4.quiz.length; i++) {
    await key(c, 'Enter', 'Enter');
    await waitFor(c, `/Question ${i + 1} of/.test(document.querySelector('.qz-kicker')?.textContent||'')`);
    await key(c, set4.quiz[i].correct.toLowerCase(), 'Key' + set4.quiz[i].correct);
  }
  await key(c, 'Enter', 'Enter');
  const want = set4.quiz.length - 1;
  ok('the results ring: ' + want + ' of ' + set4.quiz.length, await waitFor(c, `document.querySelector('.qz-res-t') && document.querySelector('.qz-res-t').textContent==='${want} of ${set4.quiz.length} correct'`));
  ok('the score is logged once, and the history shows it', await waitFor(c, `const s=window.Shruti.core.me.get('study.gita.ch4.quiz.scores',[]); return s.length===1 && s[0].s===${want} && document.querySelectorAll('.qz-hist i').length===1`), await prog(c, 'study.gita.ch4.quiz.scores'));
  ok('the sidebar shows the best score', await waitFor(c, `document.querySelector('.sh-kind[data-kind=quiz] em').textContent==='Best ${want}/${set4.quiz.length}'`));
  ok('Retry 1 missed is offered', await waitFor(c, `[...document.querySelectorAll('.qz-results .btn')].some(b=>/Retry 1 missed/.test(b.textContent))`));
  await shot(c, 'study-quiz-tony-1280');

  console.log('\nMind map');
  await pick(c, 'mindmap');
  ok('the map draws its root, branches and a link per node', await waitFor(c, `document.querySelectorAll('.mm-branch').length===${set4.mindmap.branches.length} && document.querySelectorAll('.mm-links path').length===${set4.mindmap.branches.length + set4.mindmap.branches.reduce((s, b) => s + b.children.length, 0)}`), await ev(c, `return document.querySelectorAll('.mm-links path').length`));
  ok('it starts fitted to the view', await waitFor(c, `const t=document.querySelector('.mm-canvas').style.transform; return /scale\\(/.test(t)`));
  const z0 = await ev(c, `return +/scale\\(([\\d.]+)\\)/.exec(document.querySelector('.mm-canvas').style.transform)[1]`);
  await key(c, '+', 'Equal');
  ok('+ zooms in', await waitFor(c, `+/scale\\(([\\d.]+)\\)/.exec(document.querySelector('.mm-canvas').style.transform)[1] > ${z0}`));
  const before = await ev(c, `return document.querySelector('.mm-canvas').style.transform`);
  const at = JSON.parse(await ev(c, `const r=document.querySelector('.mm-port').getBoundingClientRect(); return JSON.stringify({x:r.left+40,y:r.top+r.height-40})`));
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + i * 15, y: at.y - i * 5, button: 'left', buttons: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x + 90, y: at.y - 30, button: 'left', clickCount: 1 });
  ok('dragging pans it', await waitFor(c, `document.querySelector('.mm-canvas').style.transform !== ${JSON.stringify(before)}`));
  await key(c, '0', 'Digit0');
  await ev(c, `document.querySelectorAll('.mm-branch')[1].click(); return 1`);
  ok('tapping a branch folds it, synced for Tony', await waitFor(c, `document.querySelectorAll('.mm-col')[1].classList.contains('closed') && JSON.stringify(window.Shruti.core.me.get('study.gita.ch4.mindmap.closed',[]))==='[1]'`));
  ok('…its links go with it', await waitFor(c, `document.querySelectorAll('.mm-links path').length===${set4.mindmap.branches.length + set4.mindmap.branches.reduce((s, b, i) => s + (i === 1 ? 0 : b.children.length), 0)}`));
  await ev(c, `document.querySelectorAll('.mm-branch')[1].click(); return 1`);
  await shot(c, 'study-mindmap-tony-1280');

  console.log('\nSlides');
  await pick(c, 'slides');
  ok('the deck: stage, filmstrip, 1 / ' + set4.slides.length, await waitFor(c, `document.querySelector('.sd-stage .sd-title') && document.querySelectorAll('.sd-strip .sd-thumb').length===${set4.slides.length} && document.querySelector('.sd-count').textContent==='1 / ${set4.slides.length}'`));
  ok('Shruti brands the slide', await waitFor(c, `document.querySelector('.sd-stage .sd-brand').textContent==='Shruti'`));
  await key(c, 'ArrowRight', 'ArrowRight');
  ok('→ moves on, and the slide is synced', await waitFor(c, `document.querySelector('.sd-count').textContent==='2 / ${set4.slides.length}' && window.Shruti.core.me.get('study.gita.ch4.slides.i')===1`));
  await key(c, 'p', 'KeyP');
  ok('P presents full screen', await waitFor(c, `!!document.querySelector('.sd-present .sd-present-stage .sd-title') && document.body.classList.contains('sd-presenting')`));
  await key(c, 'ArrowRight', 'ArrowRight');
  ok('…and moves on there too', await waitFor(c, `document.querySelector('.sd-present-count').textContent==='3 / ${set4.slides.length}'`));
  await key(c, 'Escape', 'Escape');
  ok('Esc leaves the presentation on that slide', await waitFor(c, `!document.querySelector('.sd-present') && document.querySelector('.sd-count').textContent==='3 / ${set4.slides.length}'`));
  await ev(c, `[...document.querySelectorAll('.st-actions .btn')].find(b=>/Narrate deck/.test(b.textContent)).click(); return 1`);
  ok('Narrate deck asks Orca for the slide\'s voice and plays', await waitFor(c, `[...document.querySelectorAll('.st-actions .btn')].some(b=>/Stop narration|Getting the voice/.test(b.textContent))`) && (await waitFor(c, `true`)) && S.speech >= 1, 'speech calls: ' + S.speech);
  await ev(c, `[...document.querySelectorAll('.st-actions .btn')].find(b=>/Stop narration|Getting/.test(b.textContent)).click(); return 1`);
  ok('…and stops', await waitFor(c, `[...document.querySelectorAll('.st-actions .btn')].some(b=>/Narrate deck/.test(b.textContent))`));
  await shot(c, 'study-slides-tony-1280');

  console.log('\nMake a study set');
  await click(c, '.sh-make');
  ok('the maker opens with the scopes', await waitFor(c, `const s=[...document.querySelectorAll('#study-make [data-scope]')].map(b=>b.textContent); return s.join('|')==='This chapter|A section|Your selection|Several chapters|The whole book'`), await ev(c, `return [...document.querySelectorAll('#study-make [data-scope]')].map(b=>b.textContent).join('|')`));
  ok('Your selection is off until something is selected in Read', await waitFor(c, `document.querySelector('#study-make [data-scope=selection]').disabled`));
  await ev(c, `document.querySelector('#study-make [data-scope=section]').click(); return 1`);
  ok('A section offers the chapter\'s headings', await waitFor(c, `document.querySelectorAll('#sm-sec option').length>=5`));
  await ev(c, `const s=document.querySelector('#sm-sec'); s.selectedIndex=3; s.dispatchEvent(new Event('change')); return 1`);
  for (const k of ['flashcards', 'mindmap', 'slides']) await ev(c, `document.querySelector('#study-make [data-k=${k}]').click(); return 1`);
  ok('only Quiz is ticked', await waitFor(c, `[...document.querySelectorAll('#study-make [data-k]')].filter(b=>b.classList.contains('on')).map(b=>b.dataset.k).join()==='quiz'`));
  await shot(c, 'study-maker-tony-1280');
  await click(c, '#study-make [data-go]');
  ok('it is made and saved', await waitFor(c, `/Made/.test(document.querySelector('#sm-run h3')?.textContent||'') && !!document.querySelector('#sm-run [data-open]')`, 15000), await ev(c, `return document.querySelector('#sm-run')?.textContent`));
  ok('the ask was the section, with MAGI\'s quiz format', S.chats.length === 1 && /CORRECT: B/.test(S.chats[0].body) && /This reading is \\u201c|This reading is “/.test(S.chats[0].body) && /in chapter 4/.test(S.chats[0].body), S.chats[0] && S.chats[0].body.slice(0, 300));
  ok('the set is in the shared doc, scoped to the section', await waitFor(c, `const s=Object.values(window.Shruti.core.shared.get('sets.gita',{})); return s.length===1 && s[0].scope.t==='section' && s[0].kinds.quiz.length===2 && s[0].model==='deepseek/free' && s[0].by==='tony'`), await ev(c, `return JSON.stringify(window.Shruti.core.shared.get('sets.gita',{})).slice(0,300)`));
  await click(c, '#sm-run [data-open]');
  ok('Study it: the new set is in the sidebar, its quiz open', await waitFor(c, `document.querySelectorAll('.sh-set').length===2 && document.querySelector('.sh-kind.on').dataset.kind==='quiz' && /Question 1 of 2/.test(document.querySelector('.qz-kicker').textContent)`));
  ok('the head names its scope', await waitFor(c, `/in chapter 4/.test(document.querySelector('.sh-head span').textContent)`));

  console.log('\nA selection from Read, and the introduction');
  await ev(c, `location.hash='#/b/gita/4'; return 1`);
  await waitFor(c, `!!document.querySelector('article.rd p, article.rd .v')`);
  await ev(c, `const el=[...document.querySelectorAll('article.rd *')].find(e=>e.children.length===0 && e.textContent.split(' ').length>14); const r=document.createRange(); r.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); return 1`);
  await sleep(300);
  await ev(c, `location.hash='#/b/gita/4/study'; return 1`);
  await waitFor(c, `!!document.querySelector('.sh-make')`);
  await click(c, '.sh-make');
  ok('Your selection is offered once text was selected in Read', await waitFor(c, `!document.querySelector('#study-make [data-scope=selection]').disabled`));
  await ev(c, `document.querySelector('#study-make [data-scope=selection]').click(); return 1`);
  ok('…and shows it', await waitFor(c, `document.querySelector('.sm-sel') && document.querySelector('.sm-sel').textContent.length>40`));
  await ev(c, `document.querySelector('#study-make [data-close]').click(); return 1`);
  await ev(c, `location.hash='#/b/gita/0/study'; return 1`);
  ok('the introduction has Read and Study, and its ready-made set', await waitFor(c, `document.querySelectorAll('.modes button').length===2 && document.querySelectorAll('.sh-kind').length===4 && /The introduction/.test(document.querySelector('.sh-set-h b').textContent)`));
  ok('no page errors for Tony', !(await ev(c, `return (window.__errs||[]).join(' | ')`)), await ev(c, `return (window.__errs||[]).join(' | ')`));

  console.log('\nVeda at 390');
  RUN = String(Date.now());
  const docs = await ev(c, `return sessionStorage.getItem('__fakefs_docs')`);
  await load(c, { w: 390, h: 844, mobile: true, store: "sessionStorage.setItem('__fakefs_docs'," + JSON.stringify(docs) + "); sessionStorage.setItem('shruti.pick','veda');", hash: '#/b/gita/4/study' });
  await waitFor(c, `!!window.Shruti && !!window.Shruti.core.me.loaded`, 15000);
  ok('it is Veda\'s side', await waitFor(c, `document.body.dataset.profile==='veda'`));
  ok('she sees the shared AI set too', await waitFor(c, `document.querySelectorAll('.sh-set').length===2`));
  ok('Tony\'s progress is not hers: her cards are all new', await waitFor(c, `document.querySelector('.sh-kind[data-set=ch4][data-kind=flashcards] em').textContent==='${set4.flashcards.length} cards' && document.querySelector('.sh-kind[data-set=ch4][data-kind=quiz] em').textContent==='${set4.quiz.length} questions'`));
  ok('the sets scroll sideways; nothing wider than the phone', await waitFor(c, `document.documentElement.scrollWidth<=innerWidth && getComputedStyle(document.querySelector('.sh-side')).flexDirection==='row'`));
  await shot(c, 'study-flashcards-veda-390');
  await pick(c, 'quiz');
  await waitFor(c, `!!document.querySelector('.qz-opt')`);
  await shot(c, 'study-quiz-veda-390');
  await pick(c, 'mindmap');
  await waitFor(c, `!!document.querySelector('.mm-branch')`);
  await shot(c, 'study-mindmap-veda-390');
  await pick(c, 'slides');
  ok('slides fit the phone', await waitFor(c, `const r=document.querySelector('.sd-stage').getBoundingClientRect(); return r.width>300 && r.right<=innerWidth`));
  await shot(c, 'study-slides-veda-390');
  ok('no page errors for Veda', !(await ev(c, `return (window.__errs||[]).join(' | ')`)), await ev(c, `return (window.__errs||[]).join(' | ')`));

  console.log('\nTony at 390');
  RUN = String(Date.now());
  await load(c, { w: 390, h: 844, mobile: true, store: "sessionStorage.setItem('__fakefs_docs'," + JSON.stringify(docs) + "); sessionStorage.setItem('shruti.pick','tony');", hash: '#/b/gita/4/study' });
  await waitFor(c, `!!window.Shruti && !!window.Shruti.core.me.loaded`, 15000);
  ok('Tony\'s progress followed him to the phone', await waitFor(c, `/1 of ${set4.flashcards.length} known/.test(document.querySelector('.sh-kind[data-set=ch4][data-kind=flashcards] em').textContent) && /Best/.test(document.querySelector('.sh-kind[data-set=ch4][data-kind=quiz] em').textContent)`));
  ok('nothing wider than the phone', await waitFor(c, `document.documentElement.scrollWidth<=innerWidth`));
  await shot(c, 'study-flashcards-tony-390');
  console.log('\nVeda at 1280');
  RUN = String(Date.now());
  await load(c, { w: 1280, h: 900, mobile: false, store: "sessionStorage.setItem('__fakefs_docs'," + JSON.stringify(docs) + "); sessionStorage.setItem('shruti.pick','veda');", hash: '#/b/gita/4/study' });
  await waitFor(c, `!!window.Shruti && !!window.Shruti.core.me.loaded && !!document.querySelector('.sh-kind')`, 15000);
  await pick(c, 'slides');
  await waitFor(c, `!!document.querySelector('.sd-stage')`);
  await shot(c, 'study-slides-veda-1280');
  ok('no page errors', !(await ev(c, `return (window.__errs||[]).join(' | ')`)), await ev(c, `return (window.__errs||[]).join(' | ')`));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
