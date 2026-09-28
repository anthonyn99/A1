// Tests for js/modules/startnow.js rank() — the "Start now" choice (engagement 5.3).
//
//   "due cards first, then weak spots, then new material" — within one class
//   "…weighted by the nearest exam" — across classes, pressure wins
//   "never pick what this build cannot run" — a missing module is not a choice
//   "three days out, practise the exam format" — quizzes outrank review
//
// Run with:  npm run test:startnow
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 300))); }
};
globalThis.window = {};
const { rank } = await import(new URL('../js/modules/startnow.js', import.meta.url).href);

const ALL = { review: true, new: true, quiz: true, weak: true };
const cls = (o) => ({ id: 'c', name: 'DB', pressure: 0, examInDays: null, due: 0, unseen: 0,
  quizOpen: 0, weakTopic: null, launchers: ALL, ...o });

console.log('\nwithin one class');
t('due cards beat everything else',
  rank([cls({ due: 5, unseen: 30, quizOpen: 9, weakTopic: 'Joins' })]).kind === 'review');
t('then weak spots', rank([cls({ unseen: 30, quizOpen: 9, weakTopic: 'Joins' })]).kind === 'weak');
t('then a practice quiz', rank([cls({ unseen: 30, quizOpen: 9 })]).kind === 'quiz');
t('then new material', rank([cls({ unseen: 30 })]).kind === 'new');
t('nothing to do is null', rank([cls({})]) === null);
t('no classes is null', rank([]) === null);
const w = rank([cls({ weakTopic: 'Joins' })]);
t('a weak pick names the topic', w.topic === 'Joins' && /Joins/.test(w.reason), w);

console.log('\nacross classes');
const calm = cls({ id: 'calm', name: 'Art', due: 20, pressure: 0 });
const hot = cls({ id: 'hot', name: 'DS', unseen: 10, pressure: 900, examInDays: 5 });
t('an exam class with only new cards outranks due cards in a calm class',
  rank([calm, hot]).classId === 'hot', rank([calm, hot]));
t('the reason names the exam', /exam in 5 days/.test(rank([calm, hot]).reason));
t('equal pressure falls back to the tier order',
  rank([cls({ id: 'a', unseen: 10 }), cls({ id: 'b', due: 3 })]).classId === 'b');
t('more due cards rank a little higher, all else equal',
  rank([cls({ id: 'a', due: 2 }), cls({ id: 'b', due: 20 })]).classId === 'b');

console.log('\ncrunch');
t('three days out, the quiz outranks review',
  rank([cls({ due: 10, quizOpen: 5, examInDays: 2, pressure: 800 })]).kind === 'quiz');
t('a week out, review still leads',
  rank([cls({ due: 10, quizOpen: 5, examInDays: 7, pressure: 400 })]).kind === 'review');
t('exam today reads naturally', /exam today/.test(rank([cls({ due: 1, examInDays: 0 })]).reason));

console.log('\nonly what can run');
t('no quiz module -> no quiz pick',
  rank([cls({ quizOpen: 9, unseen: 3, launchers: { review: true, new: true } })]).kind === 'new');
t('no weak-spot module -> no weak pick',
  rank([cls({ weakTopic: 'X', launchers: { review: true, new: true } })]) === null);
t('launchers default to review+new only',
  rank([cls({ quizOpen: 3, launchers: undefined })]) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
