// Shruti's Study (Phase 7), offline:
//  - every study module parses; parse.js and the tools' logic load in Node;
//  - MAGI Studio's labelled-text parsers read MAGI-style replies, including
//    ones that lost their newlines or bolded their labels;
//  - spaced review (Leitner boxes), the review order, quiz scores;
//  - every ready-made set (the introduction and all 18 chapters): flashcards,
//    a quiz, a mind map and slides, sized sensibly, four options and a valid
//    answer per question, verse refs that exist in the book, every lesson of
//    the chapter covered by the flashcards, the slides and the mind map, and
//    study.json listing exactly what ships;
//  - the study prompts (MAGI's, for "this reading", with the readers' lessons).
//
// Run: node Shruti/tests/study.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DIR = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
const words = (s) => String(s || '').split(/\s+/).filter(Boolean).length;

(async () => {
  console.log('\nThe files');
  const babel = require('@babel/parser');
  for (const f of ['study/parse.js', 'study/ui.js', 'study/flashcards.js', 'study/quiz.js', 'study/mindmap.js', 'study/slides.js', 'study/hub.js', 'pdf.js']) {
    let err = null; try { babel.parse(read(f), { sourceType: 'module' }); } catch (e) { err = e.message; }
    ok(f + ' parses as a module', !err, err);
  }
  global.window = { SHRUTI_PROFILES: { tony: { label: 'Tony', doc: 'shruti' }, veda: { label: 'Veda', doc: 'shruti_veda' } }, SHRUTI_PROFILE: 'tony' };
  global.addEventListener = () => {};
  const P = await import(pathToFileURL(path.join(DIR, 'study/parse.js')).href);
  const FC = await import(pathToFileURL(path.join(DIR, 'study/flashcards.js')).href);
  const QZ = await import(pathToFileURL(path.join(DIR, 'study/quiz.js')).href);
  ok('the library and chapter page use the hub', /H\.renderStudy\(/.test(read('library.js')) && /H\.hasStudy\(/.test(read('library.js')));

  console.log('\nMAGI\'s parsers');
  const fc = P.studioParseFlashcards('CARD 1\nFRONT: Karma-yoga\nBACK: Selfless action.\n\nCARD 2\n**FRONT:** Dharma\n**BACK:** Right order.');
  ok('flashcards: two cards, bold labels forgiven', fc.length === 2 && fc[1].front === 'Dharma' && fc[1].back === 'Right order.', JSON.stringify(fc));
  const glued = P.studioParseFlashcards('CARD 1 FRONT: A BACK: one.CARD 2 FRONT: B BACK: two.');
  ok('flashcards: a reply that lost its newlines still splits', glued.length === 2 && glued[1].front === 'B', JSON.stringify(glued));
  const twice = P.studioParseFlashcards('CARD 1\nFRONT: draft\nBACK: x\nCARD 1\nFRONT: final\nBACK: y\nCARD 2\nFRONT: two\nBACK: z');
  ok('flashcards: only the last numbered run counts (a draft then the answer)', twice.length === 2 && twice[0].front === 'final');
  const qz = P.studioParseQuiz('Q1. What is 2.47 about? Plan B. is not an option here\nA. Results\nB. Duty only\nC. Fame\nD. Wealth\nCORRECT: B\nWHY: You control the work, not the fruit.\n\nQ2. Which is lower nature?\nA. Matter\nB. Spirit\nCORRECT: A\nWHY: 7.5');
  ok('quiz: questions, options, answer and why', qz.length === 2 && qz[0].correct === 'B' && qz[0].options.D === 'Wealth' && /Plan B/.test(qz[0].text) && qz[1].why === '7.5', JSON.stringify(qz[0]));
  const sl = P.studioParseSlides('SLIDE 1\nTITLE: Intro\n- one\n- two\nSLIDE 2 TITLE: Close - a - b');
  ok('slides: titles and bullets, one-line slides too', sl.length === 2 && sl[0].bullets.join() === 'one,two' && sl[1].title === 'Close' && sl[1].bullets.join() === 'a,b', JSON.stringify(sl));
  const mm = P.studioParseMindmap('ROOT: Karma-yoga\n- Action\n  - unavoidable\n    - deeper\n- Detachment\n  - from results');
  ok('mind map: root, branches, deeper levels flattened onto the second', mm[0].root === 'Karma-yoga' && mm[0].branches.length === 2 && mm[0].branches[0].children.length === 2, JSON.stringify(mm));
  ok('items() reads labelled text and Shruti\'s JSON alike', P.items('flashcards', 'CARD 1\nFRONT: a\nBACK: b').length === 1 && P.items('quiz', [{ text: 't', options: { A: 'x', B: 'y' }, correct: 'b' }])[0].correct === 'B');
  ok('items() drops a question whose answer is not an option', P.items('quiz', [{ text: 't', options: { A: 'x', B: 'y' }, correct: 'C' }]).length === 0);

  console.log('\nSpaced review and scores');
  const t = 1e12, DAY = 86400000;
  ok('got it moves a card up a box and out by its interval', JSON.stringify(FC.answer(0, true, t)) === JSON.stringify({ box: 1, due: t + DAY }) && FC.answer(3, true, t).due === t + 16 * DAY);
  ok('still learning sends it back to box 0, due now', JSON.stringify(FC.answer(4, false, t)) === JSON.stringify({ box: 0, due: t }));
  ok('the top box stays the top box', FC.answer(5, true, t).box === 5);
  const cards = [{ front: 'a' }, { front: 'b' }, { front: 'c' }, { front: 'd' }];
  const k = cards.map(FC.cardKey);
  const p = { b: { [k[0]]: 2, [k[1]]: 0, [k[3]]: 1 }, d: { [k[0]]: t + DAY, [k[1]]: t, [k[3]]: t - DAY } };
  ok('a card is new, learning, due or known', ['known', 'learning', 'new', 'due'].join() === k.map((x) => FC.stateOf(p, x, t)).join());
  ok('review order: due, then learning, then new, known last', FC.reviewOrder(cards, p, t).join() === '3,1,2,0');
  ok('the summary counts each state', JSON.stringify(FC.summary(cards, p, t)) === JSON.stringify({ new: 1, learning: 1, due: 1, known: 1 }));
  ok('card keys survive punctuation and case', FC.cardKey({ front: 'What is Dharma?' }) === FC.cardKey({ front: 'what is dharma' }));
  ok('quiz score and best attempt', QZ.score([{ correct: 'A' }, { correct: 'B' }], { 0: 'A', 1: 'C' }) === 1 && QZ.best([{ s: 3, n: 8 }, { s: 7, n: 8 }, { s: 5, n: 8 }]).s === 7);

  console.log('\nThe ready-made sets');
  const lessons = JSON.parse(read('books/gita/lessons.json'));
  const book = JSON.parse(read('books/gita/book.json'));
  const files = fs.readdirSync(path.join(DIR, 'books/gita/study')).filter((f) => /^ch\d\d\.json$/.test(f)).sort();
  ok('the introduction and all 18 chapters have a set', files.length === 19 && files[0] === 'ch00.json' && files[18] === 'ch18.json', files.join());
  const index = JSON.parse(read('books/gita/study.json'));
  for (const f of files) {
    const n = Number(f.slice(2, 4)), raw = JSON.parse(read('books/gita/study/' + f));
    const chFile = n === 0 ? book.intro.file : book.chapters.find((c) => c.n === n).file;
    const ch = JSON.parse(read('books/gita/' + chFile));
    const verses = new Set(ch.blocks.flatMap((b) => (b.s || []).map((s) => s.v).filter(Boolean)));
    const L = ((lessons[n] || {}).lessons || []).map((l) => l.id);
    const it = Object.fromEntries(P.KINDS.map((kd) => [kd, P.items(kd, raw[kd])]));
    const tag = n ? 'ch ' + n : 'intro';
    const raws = { flashcards: (raw.flashcards || []).length, quiz: (raw.quiz || []).length, slides: (raw.slides || []).length };
    ok(tag + ': nothing is dropped when read', it.flashcards.length === raws.flashcards && it.quiz.length === raws.quiz && it.slides.length === raws.slides, JSON.stringify(raws));
    ok(tag + ': ' + it.flashcards.length + ' cards, ' + it.quiz.length + ' questions, ' + (it.mindmap ? it.mindmap.branches.length : 0) + ' branches, ' + it.slides.length + ' slides',
      it.flashcards.length >= Math.max(8, L.length) && it.quiz.length >= 6 && it.mindmap && it.mindmap.branches.length >= 3 && it.slides.length >= 5);
    ok(tag + ': every question has four options and a valid answer, and a why', it.quiz.every((q) => Object.keys(q.options).join('') === 'ABCD' && q.correct in q.options && q.why));
    ok(tag + ': answers are spread over the letters', new Set(it.quiz.map((q) => q.correct)).size >= 3, it.quiz.map((q) => q.correct).join(''));
    const badRefs = it.flashcards.filter((c) => c.ref && !verses.has(c.ref)).map((c) => c.ref);
    ok(tag + ': every verse ref is in the book', !badRefs.length, badRefs.join());
    const badIds = P.KINDS.flatMap((kd) => P.lessonsIn(kd, it[kd])).filter((id) => !L.includes(id));
    ok(tag + ': lesson tags name real lessons', !badIds.length, badIds.join());
    for (const kd of ['flashcards', 'slides', 'mindmap']) {
      const have = new Set(P.lessonsIn(kd, it[kd])), miss = L.filter((id) => !have.has(id));
      ok(tag + ': the ' + kd + ' cover every lesson (' + L.length + ')', !miss.length, miss.join());
    }
    const qL = new Set(P.lessonsIn('quiz', it.quiz));
    ok(tag + ': the quiz tests ' + qL.size + ' lessons', qL.size >= Math.min(L.length, 6), [...qL].join());
    const long = [...it.flashcards.filter((c) => words(c.back) > 45).map((c) => c.front), ...it.slides.flatMap((s) => s.bullets).filter((b) => words(b) > 16), ...it.mindmap.branches.flatMap((b) => [b, ...b.children]).filter((x) => words(x.text) > 9).map((x) => x.text)];
    ok(tag + ': concise (card backs ≤ 45 words, bullets ≤ 16, map lines ≤ 9)', !long.length, long.join(' | '));
    ok(tag + ': study.json lists it with its counts', JSON.stringify(index[String(n)]) === JSON.stringify({ flashcards: it.flashcards.length, quiz: it.quiz.length, mindmap: it.mindmap.branches.length, slides: it.slides.length }), JSON.stringify(index[String(n)]));
  }
  ok('study.json lists nothing else', Object.keys(index).length === files.length);

  console.log('\nThe study prompts');
  global.fetch = async () => { throw new Error('no network'); };
  global.document = undefined;
  const G = await import(pathToFileURL(path.join(DIR, 'generate.js')).href).catch((e) => ({ err: e }));
  if (G.err) ok('generate.js loads', false, G.err.message);
  else {
    const L4 = lessons[4];
    const msgs = G.studyPrompt({ kind: 'quiz', book: 'gita', scope: { label: 'chapter 4' }, text: '[4.1] text', lessons: L4, length: 'standard' });
    const u = JSON.stringify(msgs[1].content);
    ok('a quiz prompt: MAGI\'s format, sized, for this reading, with the lessons', /CORRECT: B/.test(u) && /8 questions/.test(u) && /This reading is chapter 4/.test(u) && /L13: /.test(u));
    ok('…concise and true is asked for', /concise, true and to the point/.test(msgs[0].content));
    const mm2 = G.studyPrompt({ kind: 'mindmap', book: 'gita', scope: { label: 'a passage' }, text: 'x', length: 'deep' });
    ok('a mind map prompt for a selection carries no lessons', /ROOT:/.test(JSON.stringify(mm2[1].content)) && !/<lessons>/.test(JSON.stringify(mm2[1].content)));
    let n = 0;
    const chat = async ({ models, onModel }) => { n++; onModel && onModel(models[0]); return { text: n === 1 ? 'sorry, I cannot' : 'CARD 1\nFRONT: a\nBACK: b', model: models[0] }; };
    global.window.SHRUTI_PROFILE = 'tony';
    const C = await import(pathToFileURL(path.join(DIR, 'core.js')).href);
    C.me.set({ orcaKey: 'orca_sk_test_key_12345' });
    const res = await G.runStudy({ kinds: ['flashcards'], book: 'gita', scope: { label: 'chapter 4' }, text: 'x', length: 'concise', models: ['deepseek/free'] }, {}, { chat, parse: P });
    ok('runStudy asks once more when nothing can be read, then keeps the set', n === 2 && res.kinds.flashcards.length === 1 && res.model === 'deepseek/free');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
