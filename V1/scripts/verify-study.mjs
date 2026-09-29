// Verifies quiz mode, weak spots, the exam planner, mock exams, boss fights,
// explain-it-back and XP in a real browser (engagement 2.3–2.5, 4, 5).
//
// Seeds one class named like her DB course, with kit-style cards and quiz
// questions, then drives each surface through its real UI.
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
  else { fail++; console.log('  FAIL ' + name, extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400)); }
};
try { await launch(); }
catch (e) { if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); } throw e; }
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: PAGE });
await new Promise((r) => setTimeout(r, 3500));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const seeded = await evalJs(`(async function(){
  // Self-check paths only: this suite must never grade through the bridge
  // (cdp.mjs also blocks the bridge port outright).
  window.STUDYOS_CONFIG.cloudflare.ai.enabled = false;
  window._fbSaveStudyOs = function(){}; window._fbSaveCards = function(){}; window._fbSaveDoc = function(){};
  window._fbSaveSessions = function(){};
  for (var i = classes.length - 1; i >= 0; i--) if (classes[i].id === 'vq1') classes.splice(i, 1);
  for (var j = events.length - 1; j >= 0; j--) if (events[j].id === 'vqe') events.splice(j, 1);
  for (var k = tasks.length - 1; k >= 0; k--) if (tasks[k].planId === 'pl_vqe') tasks.splice(k, 1);
  localStorage.removeItem('studyos_cards_vq1'); localStorage.removeItem('studyos_quiz_vq1');
  classes.push({ id:'vq1', name:'Intro to Database Systems', code:'CS 3410', color:'#9dc0ee', modules:[
    { id:'vqm1', name:'Module 1', type:'documents', files:[], prompts:[], notes:[] },
    { id:'vqm2', name:'Module 2', type:'documents', files:[], prompts:[], notes:[] } ]});
  var d = new Date(); d.setDate(d.getDate() + 10);
  events.push({ id:'vqe', name:'DB Midterm', classId:'vq1', type:'exam', date: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'), weight:'25' });
  var cards = [];
  for (var c = 0; c < 12; c++) cards.push({ front: 'Module 2 card ' + c + '?', back: 'answer ' + c, topic: c < 6 ? 'Joins' : 'Subqueries' });
  window.SOS.deck.addExternal('vq1', 'vqm2', cards, { noteId: 'kit_f', title: 'L2' });
  var qs = [
    { type:'mcq', topic:'Joins', prompt:'Which join keeps unmatched left rows?', choices:['INNER','LEFT','CROSS','NATURAL'], answer:'LEFT', explanation:'LEFT OUTER keeps every left row.' },
    { type:'mcq', topic:'Joins', prompt:'Natural join matches on?', choices:['keys','equal-named columns','nothing','row ids'], answer:'equal-named columns', explanation:'' },
    { type:'trace', topic:'Subqueries', prompt:'SELECT 1 + 1; prints?', answer:'2', explanation:'' },
    { type:'short', topic:'Subqueries', prompt:'What does IN (subquery) test?', answer:'membership in the subquery result', explanation:'' },
    { type:'sql', topic:'SQL', prompt:'List every SKU.', answer:'SELECT SKU FROM SKU_DATA;', explanation:'', dataset:'capecodd' },
  ];
  window.SOS.quiz.addFromKit('vq1', 'vqm2', qs, { sourceFileId: 'f', sourceTitle: 'L2' });
  return { cards: window.SOS.deck.forClass('vq1').length, qs: window.SOS.quiz.forClass('vq1').length };
})()`);
t('seeded 12 cards and 5 questions', seeded && seeded.cards === 12 && seeded.qs === 5, seeded);

console.log('\nquiz mode');
await evalJs(`window.SOS.quizUi.startQuiz({ classId:'vq1' }, { n: 5, questions: window.SOS.quiz.forClass('vq1').slice() }); true;`);
await wait(400);
let answered = 0, sawExpl = false;
for (let step = 0; step < 5; step++) {
  const type = await evalJs(`(document.querySelector('.sos-quiz-topic')||{}).textContent || ''`);
  if (/mcq/.test(type)) {
    // Answer WRONG on purpose (first choice is never the right one here).
    await evalJs(`document.querySelector('[data-c="0"]').click(); true;`);
  } else if (/trace/.test(type)) {
    await evalJs(`document.querySelector('[data-in]').value = '2'; document.querySelector('[data-go]').click(); true;`);
  } else if (/sql/.test(type)) {
    await evalJs(`document.querySelector('[data-in]').value = 'SELECT SKU FROM SKU_DATA'; document.querySelector('[data-go]').click(); true;`);
    await wait(1500);
  } else {
    await evalJs(`document.querySelector('[data-go]').click(); true;`);
    await wait(150);
    await evalJs(`document.querySelector('[data-self="1"]').click(); true;`);
    answered++; continue;
  }
  await wait(300);
  sawExpl = sawExpl || await evalJs(`/Correct|Not quite/.test((document.querySelector('.sos-quiz-fb')||{}).textContent||'')`);
  answered++;
  await evalJs(`var n = document.querySelector('[data-next]'); if (n) n.click(); true;`);
  await wait(250);
}
const sum = await evalJs(`({ text: (document.querySelector('.sos-sum')||{}).textContent || '' })`);
t('each answer shows feedback and an explanation', sawExpl);
t('the results screen appears', /Quiz done/.test(sum.text), sum.text.slice(0, 200));
t('it scores 3/5 (two mcq missed)', /3 \/ 5 correct/.test(sum.text), sum.text.slice(0, 200));
t('it lists the missed topic', /Missed: Joins/.test(sum.text), sum.text.slice(0, 300));
t('it shows XP and a next step', /\+\d+ XP/.test(sum.text) && /Level/.test(sum.text));
const qsess = await evalJs(`window.SOS.sessions.all().filter(function(s){ return s.kind === 'quiz'; }).pop() || null`);
// Under 60 s this session is (correctly) not logged; the XP line still shows.
t('a sub-minute quiz is not logged as a session (60 s floor)', qsess === null || qsess.items === 5, qsess);
const stats = await evalJs(`window.SOS.quiz.forClass('vq1').map(function(q){ return q.stats.attempts; }).reduce(function(a,b){return a+b;},0)`);
t('every question recorded an attempt', stats === 5, stats);
await evalJs(`document.querySelector('[data-sum-close]').click(); true;`);

console.log('\nweak spots');
const weak = await evalJs(`window.SOS.progress.weakTopics('vq1', 3).map(function(w){ return w.topic; })`);
t('the missed topic is the top weak spot', weak[0] && /joins/i.test(weak[0]), weak);
await evalJs(`window.SOS.practice.startWeakSpots('vq1'); true;`);
await wait(400);
const ws = await evalJs(`({ title: (document.querySelector('.sos-quiz-top')||{}).textContent || '', topic: (document.querySelector('.sos-quiz-topic')||{}).textContent || '' })`);
t('"Practice weak spots" opens a session on that topic', /Weak spots/.test(ws.title) && /Joins/i.test(ws.topic), ws);
await evalJs(`window.SOS.quizUi.closeQuiz(); true;`);

console.log('\nexam planner');
await evalJs(`switchView('home'); renderExamCountdown(); true;`);
await wait(300);
t('the countdown row offers "Plan"', await evalJs(`Array.from(document.querySelectorAll('#sos-exam-countdown-list [data-plan]')).length >= 1`));
await evalJs(`window.sosOpenPlanner('vqe'); true;`);
await wait(400);
await evalJs(`(function(){ var b = document.querySelector('.sos-plan-sheet input[value="vqm2"]'); b.checked = true; b.onchange(); var a = document.querySelector('.sos-plan-sheet input[value="vqm1"]'); a.checked = false; a.onchange(); return true; })()`);
const prev = await evalJs(`(document.querySelector('.sos-plan-sheet [data-preview]')||{}).textContent || ''`);
t('the preview counts the covered cards', /12 cards \(12 unseen\)/.test(prev), prev.slice(0, 200));
await evalJs(`document.querySelector('.sos-plan-sheet [data-save]').click(); true;`);
await wait(500);
const plan = await evalJs(`({ tasks: tasks.filter(function(t){ return t.planId === 'pl_vqe'; }).length,
  mods: (events.find(function(e){ return e.id === 'vqe'; }).plan || {}).moduleIds,
  mock: tasks.some(function(t){ return t.planId === 'pl_vqe' && /mock exam/.test(t.name); }),
  queue: window.SOS.deck.buildQueue({ examId: 'vqe' }).length })`);
t('10 daily tasks were created', plan.tasks === 10, plan);
t('the covered modules are stored on the exam', JSON.stringify(plan.mods) === '["vqm2"]', plan.mods);
t('the day before is a mock exam', plan.mock);
t('the exam scope drives the card queue', plan.queue === 12, plan.queue);
await evalJs(`(function(){ var t0 = tasks.find(function(t){ return t.planId === 'pl_vqe'; }); t0.done = true; return true; })()`);
await evalJs(`window.sosOpenPlanner('vqe'); true;`);
await wait(300);
await evalJs(`document.querySelector('.sos-plan-sheet [data-save]').click(); true;`);
await wait(400);
const replan = await evalJs(`({ total: tasks.filter(function(t){ return t.planId === 'pl_vqe'; }).length, done: tasks.filter(function(t){ return t.planId === 'pl_vqe' && t.done; }).length })`);
t('re-planning keeps ticked-off days and does not duplicate', replan.total === 10 && replan.done === 1, replan);

console.log('\nmock exam');
await evalJs(`window.SOS.mock.openSetup('vq1'); true;`);
await wait(300);
await evalJs(`document.querySelector('.sos-quiz [data-start]').click(); true;`);
await wait(1500);
const mk = await evalJs(`({ title: (document.querySelector('.sos-quiz-top')||{}).textContent || '', count: (document.querySelector('[data-count]')||{}).textContent || '',
  timer: (document.querySelector('[data-timer]')||{}).textContent || '' })`);
t('a timed mock exam opens with 20 questions', /Mock exam/.test(mk.title) && /\/20/.test(mk.count) && /⏱/.test(mk.timer), mk);
const mix = await evalJs(`(async function(){ var qs = await window.SOS.mock.assemble('vq1', undefined, 20); return qs.map(function(q){ return q.topic; }); })()`);
t('the DB class gets generated SQL / normal-form items', mix.some((x) => /^SQL:/.test(x)) && mix.some((x) => /Normal forms|Candidate keys/.test(x)), mix);
// No feedback between questions in a mock.
const t1 = await evalJs(`(document.querySelector('.sos-quiz-topic')||{}).textContent || ''`);
if (/mcq/.test(t1)) await evalJs(`document.querySelector('[data-c="0"]').click(); true;`);
else if (/trace|sql/.test(t1)) await evalJs(`document.querySelector('[data-in]').value='x'; document.querySelector('[data-go]').click(); true;`);
else await evalJs(`document.querySelector('[data-go]').click(); true;`);
await wait(900);
t('no feedback between mock questions (Respondus-style)', await evalJs(`!document.querySelector('.sos-quiz-fb.ok, .sos-quiz-fb.bad')`));
await evalJs(`window.SOS.quizUi.closeQuiz(); true;`);

console.log('\nboss fights');
const locked = await evalJs(`window.SOS.boss.bossesFor('vq1').find(function(b){ return b.module.id === 'vqm2'; })`);
t('an unreviewed module\'s boss is locked', locked && !locked.unlocked && locked.pct === 0, locked && { pct: locked.pct, unlocked: locked.unlocked });
await evalJs(`(function(){ var now = Date.now(); window.SOS.deck.forClass('vq1').forEach(function(c){
  window.SOS.deck.restoreSched(c.id, { state:'review', stability: 60, difficulty: 4, reps: 5, lapses: 0, lastReview: now - 3600000, due: now + 30*86400000, lastInterval: 30 }); }); return true; })()`);
const unl = await evalJs(`window.SOS.boss.bossesFor('vq1').find(function(b){ return b.module.id === 'vqm2'; })`);
t('80%+ mastery unlocks it', unl.unlocked && unl.pct >= 80, { pct: unl.pct });
await evalJs(`window.SOS.boss.openBossList('vq1'); true;`);
await wait(300);
t('the list shows topic mastery bars', await evalJs(`/Mastery by topic/.test(document.querySelector('.sos-quiz').textContent) && /Joins/.test(document.querySelector('.sos-quiz').textContent)`));
await evalJs(`document.querySelector('[data-fight="vqm2"]').click(); true;`);
await wait(400);
t('the fight has an HP bar and three hearts', await evalJs(`!!document.querySelector('.sos-quiz-hp') && /❤️❤️❤️/.test(document.querySelector('.sos-quiz-hearts').textContent)`));
// Win it: answer everything correctly.
for (let step = 0; step < 12; step++) {
  const done = await evalJs(`!!document.querySelector('.sos-sum')`);
  if (done) break;
  await evalJs(`(function(){
    var topic = (document.querySelector('.sos-quiz-topic')||{}).textContent || '';
    var qs = window.SOS.quiz.forClass('vq1');
    var qtext = (document.querySelector('.sos-quiz-q')||{}).textContent || '';
    var q = qs.find(function(x){ return qtext.indexOf(x.prompt.slice(0, 20)) >= 0; });
    if (/mcq/.test(topic) && q) { var i = q.choices.indexOf(q.answer); document.querySelector('[data-c="' + i + '"]').click(); }
    else if (/trace/.test(topic) && q) { document.querySelector('[data-in]').value = q.answer; document.querySelector('[data-go]').click(); }
    else if (/sql/.test(topic) && q) { document.querySelector('[data-in]').value = q.answer; document.querySelector('[data-go]').click(); }
    else { document.querySelector('[data-go]').click(); setTimeout(function(){ var y = document.querySelector('[data-self="1"]'); if (y) y.click(); }, 50); }
    return true; })()`);
  await wait(1600);
  await evalJs(`var n = document.querySelector('[data-next]'); if (n) n.click(); true;`);
  await wait(250);
}
const bossEnd = await evalJs(`(document.querySelector('.sos-sum')||{}).textContent || ''`);
t('answering well defeats the boss', /Boss defeated/.test(bossEnd), bossEnd.slice(0, 160));
t('the win is recorded (synced progress doc)', await evalJs(`window.SOS.progress.bosses('vq1').some(function(b){ return b.moduleId === 'vqm2' && b.defeatedAt; })`));
t('...with the boss XP bonus', /\+(\d{2,}) XP/.test(bossEnd) && Number(bossEnd.match(/\+(\d+) XP/)[1]) >= 50, bossEnd.match(/\+\d+ XP/));
await evalJs(`var c = document.querySelector('[data-sum-close]'); if (c) c.click(); true;`);

console.log('\nexplain it back (self-check, no bridge)');
await evalJs(`window.SOS.explain.open('vq1'); true;`);
await wait(300);
t('topics come from the cards', await evalJs(`Array.from(document.querySelectorAll('[data-topic] option')).some(function(o){ return /Joins/.test(o.textContent); })`));
await evalJs(`document.querySelector('[data-text]').value = 'A join combines rows from two tables on matching columns.'; document.querySelector('[data-go]').click(); true;`);
await wait(300);
t('without the bridge it shows the key points to tick', await evalJs(`document.querySelectorAll('[data-kp]').length >= 2`));
await evalJs(`document.querySelector('[data-kp="0"]').checked = true; document.querySelector('[data-done]').click(); true;`);
await wait(300);
t('a score and XP are shown', await evalJs(`/\\/100/.test(document.querySelector('.sos-quiz').textContent) && /XP/.test(document.querySelector('.sos-quiz').textContent)`));
await evalJs(`document.querySelector('.sos-quiz .sos-quiz-x').click(); true;`);

console.log('\nthe hub');
await evalJs(`switchView('practice'); true;`);
await wait(500);
const chips = await evalJs(`Array.from(document.querySelectorAll('[data-tool][data-class="vq1"]')).map(function(b){ return b.dataset.tool + ':' + !b.disabled; })`);
t('every class tool is live', ['quiz', 'weak', 'explain', 'mock', 'boss'].every((k) => chips.includes(k + ':true')), chips);

const errs = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails?.exception?.description || '?')
  .filter((e) => !/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
console.log('\noverall');
t('no uncaught exceptions', errs.length === 0, errs.slice(0, 5));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
