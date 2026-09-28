// Tests for the engagement upgrade's bookkeeping: progress.js (weak spots),
// xp.js (XP, levels, streak freeze) and planner.js (exam back-planning).
//
//   "two devices' misses both count"      — the per-device grow-only counter
//   "the weakest topic is the recent, frequent miss, not one old slip"
//   "a freeze forgives one day, not two, and not twice a week"
//   "new cards finish two days out; the last day is a mock exam"
//
// Run with:  npm run test:progress
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.window = { addEventListener() {}, dispatchEvent() { return true; },
  _sosBridge: { getClasses: () => [], getEvents: () => [], getTasks: () => [], getNotes: () => [], getKsu: () => ({ modules: [] }),
    getModules: () => [], getSnapshot: () => null, subscribe: () => () => {} } };
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } };
const imp = (p) => import(new URL(p, import.meta.url).href);
const progress = await imp('../js/modules/progress.js');
const xp = await imp('../js/modules/xp.js');
const planner = await imp('../js/modules/planner.js');

console.log('\nweak spots');
{
  const now = Date.now();
  for (let i = 0; i < 4; i++) progress.recordAttempt('c1', 'Joins', i < 3 ? 1 : 0, now);
  for (let i = 0; i < 20; i++) progress.recordAttempt('c1', 'SELECT', i < 2 ? 1 : 0, now - 40 * 86400000);
  progress.recordAttempt('c1', 'Keys', 0.5, now);
  progress.recordAttempt('c2', 'Heaps', 1, now);
  const weak = progress.weakTopics('c1', 3, now);
  t('the frequent recent miss ranks first', weak[0].topic === 'Joins', weak);
  t('a Hard (half) miss counts half', progress.topicStats('c1').find((s) => s.topic === 'Keys').misses === 0.5);
  t('scoped by class', !weak.some((w) => w.topic === 'Heaps'));
  t('topics are case-insensitive', (progress.recordAttempt('c1', 'joins', 1, now), progress.topicStats('c1').filter((s) => /joins/i.test(s.topic)).length === 1));

  // Another device's counter for the same topic arrives from the cloud.
  const st = progress._store();
  const rec = st.get('tp|c1|joins');
  const remote = { ...rec, dev: { ...rec.dev, dOTHER: { a: 3, m: 3, t: now } }, updatedAt: now + 5 };
  st.applyRemote({ v: 1, items: [remote] });
  const joins = progress.topicStats('c1').find((s) => /joins/i.test(s.topic));
  t('two devices\' misses both count (grow-only merge)', joins.attempts === 5 + 3 && joins.misses === 4 + 3, joins);
  // A STALE copy of our own device must not roll our count back.
  const stale = { ...rec, dev: { [progress.deviceId()]: { a: 1, m: 1, t: 0 } }, updatedAt: now + 99 };
  st.applyRemote({ v: 1, items: [stale] });
  t('a stale copy never lowers a counter', progress.topicStats('c1').find((s) => /joins/i.test(s.topic)).attempts === 8);
}

console.log('\nXP and levels');
{
  t('level 1 at 0 XP', xp.levelFor(0).level === 1);
  t('level 2 at 25 XP', xp.levelFor(25).level === 2 && xp.levelFor(24).level === 1);
  t('level 3 at 100 XP', xp.levelFor(100).level === 3);
  t('into/span add up', (() => { const l = xp.levelFor(60); return l.into === 35 && l.span === 75; })());
  t('an attempt is never worth 0', xp.forDrillItem({ correct: false }) > 0);
  t('harder drills pay more', xp.forDrillItem({ correct: true, difficulty: 3 }) > xp.forDrillItem({ correct: true, difficulty: 1 }));
  t('mock exams pay more than quizzes', xp.forQuiz({ items: 10, correct: 8, mock: true }) > xp.forQuiz({ items: 10, correct: 8 }));
  t('total XP is the sum over sessions', xp.totalXp([{ xp: 5 }, { xp: 7 }, {}]) === 12);
}

console.log('\nstreak freeze');
{
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  const now = noon.getTime();
  const key = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const day = (n) => key(now - n * 86400000);
  t('missed yesterday after studying the day before -> freeze yesterday',
    xp.planFreeze(new Set([day(2), day(3)]), [], now) === day(1));
  t('studied yesterday -> no freeze needed', xp.planFreeze(new Set([day(1), day(2)]), [], now) === null);
  t('missed two days -> no freeze (the streak is over)', xp.planFreeze(new Set([day(3)]), [], now) === null);
  t('a freeze used 3 days ago -> none available', xp.planFreeze(new Set([day(2)]), [day(4)], now) === null);
  t('a freeze used 9 days ago -> available again', xp.planFreeze(new Set([day(2)]), [day(9)], now) === day(1));
}

console.log('\nplanner');
{
  const exam = { id: 'e1', name: 'DB Midterm', date: '2026-10-14', classId: 'c1' };
  const p = planner.compute({ exam, unseen: 40, questions: 20, today: '2026-10-04' });
  t('one day per day until the exam (10)', p.days.length === 10, p.days.map((d) => d.date));
  t('the last day is the day before the exam', p.days.at(-1).date === '2026-10-13');
  t('the last day is a mock exam', p.days.at(-1).mock === true && /mock exam/.test(p.tasks.at(-1).name));
  t('all 40 new cards are scheduled', p.days.reduce((n, d) => n + d.newCards, 0) === 40);
  t('...finishing two days out', p.days.slice(-2).every((d) => d.newCards === 0), p.days.map((d) => d.newCards));
  t('a practice quiz every third day', p.days.filter((d) => d.quiz).length === 3, p.days.filter((d) => d.quiz).map((d) => d.date));
  t('tasks are high priority in the last 3 days', p.tasks.slice(-3).every((x) => x.priority === 'high') && p.tasks[0].priority === 'medium');
  t('tasks carry the class and a stable id', p.tasks.every((x) => x.classId === 'c1' && x.id.startsWith('pt_e1_')));
  t('no quiz questions -> no quiz days', planner.compute({ exam, unseen: 5, questions: 0, today: '2026-10-04' }).days.every((d) => !d.quiz));
  t('an exam today plans nothing', planner.compute({ exam, unseen: 5, questions: 5, today: '2026-10-14' }).days.length === 0);
  t('a far exam plans at most 21 days', planner.compute({ exam, unseen: 5, questions: 5, today: '2026-08-01' }).days.length === 21);
  t('one day out: just the mock', (() => { const q = planner.compute({ exam, unseen: 10, questions: 5, today: '2026-10-13' }); return q.days.length === 1 && q.days[0].mock && q.days[0].newCards === 10; })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
