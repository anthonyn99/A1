// Verifies priority score v2 (spec G-2) against the REAL function in the page.
//
// The spec's own example is the test: "A 5% quiz she's mastered should rank
// below a 25% exam she's weak on — today it won't." Lifting the formula into a
// standalone copy would prove nothing about what the dashboard actually ranks,
// so this drives _sosPriorityScore inside the running app.
//
// Run:  node scripts/verify-priority.mjs      (after npm run build)
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
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 300))); }
};

try {
  await launch();
} catch (e) {
  if (e.code === 'NO_BROWSER') { console.log('SKIP: ' + e.message); process.exit(0); }
  throw e;
}
const { send, evalJs, events } = await connect();
await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    Object.keys(localStorage).filter(k => k.indexOf('studyos_cards_') === 0)
      .forEach(k => localStorage.removeItem(k));
  } catch (e) {}`,
});
await send('Page.navigate', { url: PAGE });
await new Promise(r => setTimeout(r, 5000));

console.log('\nsetup');
t('the scorer is reachable', await evalJs('typeof _sosPriorityScore === "function"'));
t('the deck module is loaded', await evalJs('typeof (window.SOS && window.SOS.deck) === "object"'));

// Two classes: one she knows cold, one she does not. Real cards, real grades,
// so mastery comes from the actual model rather than a stubbed number.
const setup = await evalJs(`(async () => {
  const mk = (id, name) => {
    const cls = { id, name, color:'#888', modules:[{ id:id+'m', name:'Notes', type:'notes', files:[], prompts:[], notes:[
      { id:id+'n', title:'Topic', updated:Date.now(), body:
        '# Alpha\\nThe first concept is described here in a full sentence.\\n\\n# Beta\\nThe second concept is described here in a full sentence.\\n\\n# Gamma\\nThe third concept is described here in a full sentence.\\n' }
    ]}] };
    classes.push(cls);
    window.sosMakeCards(id, id+'m', id+'n', false);
    return window.SOS.deck.forClass(id);
  };
  const known = mk('pk_known', 'Known');
  mk('pk_weak', 'Weak');

  // Grade the "known" deck Easy several times so mastery is genuinely high.
  let now = Date.now();
  for (let round = 0; round < 5; round++) {
    for (const c of window.SOS.deck.forClass('pk_known')) {
      window.SOS.deck.gradeCard(c.id, 4, now);
    }
    now += 1000;
  }
  return {
    knownCards: known.length,
    knownPct: window.SOS.deck.mastery('pk_known').pct,
    weakPct: window.SOS.deck.mastery('pk_weak').pct,
  };
})()`);
t('both decks have cards', setup.knownCards >= 2, setup);
t('the studied class reads as mastered', setup.knownPct >= 60, setup);
t('the untouched class reads as weak', setup.weakPct <= 20, setup);

// ── The spec's example ────────────────────────────────────────────────────
console.log('\nG-2: the spec\'s own example');
const cmp = await evalJs(`(() => {
  const date = new Date(Date.now() + 5*86400000).toISOString().slice(0,10);
  const quiz = { classId:'pk_known', date, weight:5,  type:'quiz', name:'Quiz 1' };
  const exam = { classId:'pk_weak',  date, weight:25, type:'exam', name:'Midterm' };
  return { quiz: _sosPriorityScore(quiz), exam: _sosPriorityScore(exam),
           whyQuiz: _sosPriorityWhy(quiz), whyExam: _sosPriorityWhy(exam) };
})()`);
t('a weak 25% exam outranks a mastered 5% quiz', cmp.exam > cmp.quiz, cmp);
t('the reasoning names the deadline', /day/.test(cmp.whyExam), cmp.whyExam);
t('the reasoning names the grade weight', /% of the grade/.test(cmp.whyExam), cmp.whyExam);
t('the reasoning names mastery', /mastered/.test(cmp.whyQuiz), cmp.whyQuiz);

// ── Mastery must only ever discount ───────────────────────────────────────
console.log('\nmastery discounts, never inflates');
const bounds = await evalJs(`(() => {
  const date = new Date(Date.now() + 5*86400000).toISOString().slice(0,10);
  const base = { classId:'', date, weight:20 };             // no class -> no cards
  const weak = { classId:'pk_weak',  date, weight:20 };
  const known= { classId:'pk_known', date, weight:20 };
  return { base:_sosPriorityScore(base), weak:_sosPriorityScore(weak), known:_sosPriorityScore(known) };
})()`);
t('mastery never raises a score above the un-carded baseline',
  bounds.weak <= bounds.base && bounds.known <= bounds.base, bounds);
t('a mastered class scores lower than a weak one', bounds.known < bounds.weak, bounds);
t('a mastered class is still ranked, not zeroed', bounds.known > 0, bounds);
t('the discount is capped (never below 40% of baseline)',
  bounds.known >= Math.round(bounds.base * 0.4) - 1, bounds);

// ── Degradation ───────────────────────────────────────────────────────────
console.log('\ndegrades safely');
t('a class with no cards is not treated as 0% mastered', (await evalJs(`(() => {
  const date = new Date(Date.now() + 5*86400000).toISOString().slice(0,10);
  classes.push({ id:'pk_empty', name:'Empty', color:'#888', modules:[] });
  return _sosPriorityScore({ classId:'pk_empty', date, weight:20 })
       === _sosPriorityScore({ classId:'', date, weight:20 });
})()`)) === true);
t('an unknown class does not throw', (await evalJs(
  `typeof _sosPriorityScore({ classId:'nope', date:'2030-01-01', weight:10 }) === 'number'`)));
// A missing weight defaults to 10%, so this must score like any other item at
// the same distance. (My first version used 2030 and asserted > 0: urgency
// halves weekly, so three years out legitimately decays to zero — the test was
// wrong, not the formula.)
t('a missing weight defaults rather than zeroing', (await evalJs(`(() => {
  const soon = new Date(Date.now() + 3*86400000).toISOString().slice(0,10);
  return _sosPriorityScore({ classId:'', date: soon })
      === _sosPriorityScore({ classId:'', date: soon, weight: 10 });
})()`)) === true);
t('a far-future date decays toward nothing', (await evalJs(
  `_sosPriorityScore({ classId:'', date:'2030-01-01', weight:25 }) === 0`)));
// Urgency must still dominate. Comparing a 5%-weight item to a 25% one made
// this a near-tie (215 vs 200 with a 95%-mastered class) — a real property
// tested on a coin-flip margin, which would flake. Hold weight equal so the
// assertion is actually about TIME, which is what "urgency dominates" means.
t('urgency still dominates, even when mastered', (await evalJs(`(() => {
  const today = new Date().toISOString().slice(0,10);
  const far = new Date(Date.now() + 25*86400000).toISOString().slice(0,10);
  return _sosPriorityScore({ classId:'pk_known', date:today, weight:20 })
       > _sosPriorityScore({ classId:'pk_weak', date:far, weight:20 });
})()`)) === true);

// ── The live queue ────────────────────────────────────────────────────────
console.log('\nthe dashboard actually uses it');
const live = await evalJs(`(() => {
  const date = new Date(Date.now() + 5*86400000).toISOString().slice(0,10);
  for (let i = events.length-1; i >= 0; i--) if (String(events[i].id).indexOf('pk_') === 0) events.splice(i,1);
  events.push({ id:'pk_e1', classId:'pk_known', type:'quiz', name:'Mastered Quiz', date, weight:5 });
  events.push({ id:'pk_e2', classId:'pk_weak',  type:'exam', name:'Weak Exam',     date, weight:25 });
  switchView('home');
  renderPriorityQueue();
  const rows = Array.from(document.querySelectorAll('.sos-pq-item'))
    .map(r => (r.querySelector('.sos-pq-name')||{}).textContent || '');
  return { rows, weakFirst: rows.indexOf('Weak Exam') < rows.indexOf('Mastered Quiz'),
           title: (document.querySelector('.sos-pq-item')||{}).title || '' };
})()`);
t('both items are queued', live.rows.includes('Weak Exam') && live.rows.includes('Mastered Quiz'), live.rows);
t('the weak exam ranks first on screen', live.weakFirst === true, live.rows);
t('the row explains its ranking on hover', /mastered|% of the grade/.test(live.title), live.title);

const errs = events
  .filter(e => e.method === 'Runtime.exceptionThrown')
  .map(e => e.params.exceptionDetails?.exception?.description || '?')
  .filter(e => !/firebase|firestore|net::|Failed to load|recaptcha|appCheck|installations|FirebaseError|gstatic|ERR_/i.test(e));
t('no uncaught exceptions', errs.length === 0, errs.slice(0, 3));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
