// Tests for js/modules/sessions.js — the study log (spec S-3, feeds Phase 4).
//
// The cases that earn their place:
//
//   "a streak does not read 0 every morning"
//       Counting only from today means the number resets at midnight and stays
//       0 until she studies. A streak that punishes her at 9am for not having
//       studied yet is the opposite of motivating — it counts back from
//       yesterday when today is still empty.
//
//   "a ten-second timer is not a session"
//       Logging it would inflate every streak, total and average built on this.
//
//   "remote merge never drops a local session"
//       Sessions are written from whichever device she studied on. Union by id.
//
// Run with:  npm run test:sessions
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 300))); }
};

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const classes = [
  { id: 'c1', name: 'Databases', color: '#9dc0ee' },
  { id: 'c2', name: 'Comp Org & Arch', color: '#ef9f9f' },
];
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  _sosBridge: {
    getClasses: () => classes, getEvents: () => [], getTasks: () => [],
    getNotes: () => [], getKsu: () => ({ modules: [] }), getModules: () => [],
    getSnapshot: () => null, subscribe: () => () => {},
  },
};
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } };

const S = await import(new URL('../js/modules/sessions.js', import.meta.url).href);

const MIN = 60000;
const DAY = 86400000;
const NOW = Date.now();

// ── Writing ───────────────────────────────────────────────────────────────
console.log('\nlogging');
{
  const s = S.log('focus', { classId: 'c1', durationMs: 25 * MIN, completed: true });
  t('a real session is logged', !!s && s.durationMs === 25 * MIN);
  t('it gets an id', !!s.id);
  t('it records the class', s.classId === 'c1');
  t('it records a local day key', /^\d{4}-\d{2}-\d{2}$/.test(s.day), s.day);
  t('it is readable back', S.all().length === 1);
  t('it persisted', mem.has('studyos_sessions_v1'));

  t('a ten-second timer is NOT a session', S.log('focus', { durationMs: 10000 }) === null);
  t('and was not stored', S.all().length === 1);
  t('a zero-length session is rejected', S.log('focus', { durationMs: 0 }) === null);
  t('a missing duration is rejected', S.log('focus', {}) === null);

  const r = S.log('review', { classId: 'c1', durationMs: 6 * MIN, cards: 23, accuracy: 78 });
  t('a review session records cards', r.cards === 23 && r.accuracy === 78);
  t('kind is preserved', r.kind === 'review');
}

// ── Day totals ────────────────────────────────────────────────────────────
console.log('\ndaily totals');
{
  const d = S.dayTotals();
  t('minutes are summed', d.minutes === 31, d);
  t('sessions are counted', d.sessions === 2, d);
  t('cards are summed', d.cards === 23, d);
  t('an empty day is zeroes, not NaN', S.dayTotals('1999-01-01').minutes === 0);
}

// ── Streaks: the one that is easy to get subtly wrong ─────────────────────
console.log('\nstreak');
{
  mem.clear();
  const fresh = await import(new URL('../js/modules/sessions.js?s1', import.meta.url).href);
  t('no sessions means no streak', fresh.streak(NOW) === 0);

  // Three consecutive days ending today.
  for (const back of [2, 1, 0]) {
    fresh.log('focus', { durationMs: 20 * MIN, startedAt: NOW - back * DAY });
  }
  t('three consecutive days counts 3', fresh.streak(NOW) === 3, fresh.streak(NOW));

  // A gap breaks it.
  fresh.log('focus', { durationMs: 20 * MIN, startedAt: NOW - 5 * DAY });
  t('a gap does not extend the streak', fresh.streak(NOW) === 3, fresh.streak(NOW));

  // The morning case: nothing today, but yesterday counted.
  mem.clear();
  const m2 = await import(new URL('../js/modules/sessions.js?s2', import.meta.url).href);
  for (const back of [2, 1]) {
    m2.log('focus', { durationMs: 20 * MIN, startedAt: NOW - back * DAY });
  }
  t('a streak survives an unstudied morning', m2.streak(NOW) === 2, m2.streak(NOW));

  // But two missed days really is over.
  mem.clear();
  const m3 = await import(new URL('../js/modules/sessions.js?s3', import.meta.url).href);
  m3.log('focus', { durationMs: 20 * MIN, startedAt: NOW - 3 * DAY });
  t('two missed days ends the streak', m3.streak(NOW) === 0, m3.streak(NOW));

  // Several sessions in one day must not inflate it.
  mem.clear();
  const m4 = await import(new URL('../js/modules/sessions.js?s4', import.meta.url).href);
  for (let i = 0; i < 5; i++) m4.log('focus', { durationMs: 20 * MIN, startedAt: NOW });
  t('five sessions in one day is a streak of 1', m4.streak(NOW) === 1, m4.streak(NOW));
}

// ── By class / heatmap / week ─────────────────────────────────────────────
console.log('\nrollups');
{
  mem.clear();
  const m = await import(new URL('../js/modules/sessions.js?s5', import.meta.url).href);
  m.log('focus', { classId: 'c1', durationMs: 60 * MIN, startedAt: NOW });
  m.log('focus', { classId: 'c2', durationMs: 30 * MIN, startedAt: NOW - DAY });
  m.log('focus', { classId: '', durationMs: 15 * MIN, startedAt: NOW });

  const by = m.byClass(7, NOW);
  t('classes are rolled up', by.length === 3, by);
  t('biggest first', by[0].minutes >= by[1].minutes, by.map(x => x.minutes));
  t('names are resolved', by[0].name === 'Databases', by[0]);
  t('an unassigned session is labelled, not dropped',
    by.some(x => x.name === 'Unassigned'), by.map(x => x.name));
  t('class names with & are untouched here',
    by.some(x => x.name === 'Comp Org & Arch'), by.map(x => x.name));
  // `now` in the past means every session is in the future and outside the
  // window. (The first version of this passed `days: 0` with a past `now`,
  // which puts the cutoff even further back and correctly includes everything
  // — my assertion was wrong, not the rollup.)
  t('a window that excludes everything is empty', m.byClass(7, NOW - 90 * DAY).length === 0);

  const h = m.heatmap(7, NOW);
  t('heatmap has one cell per day', h.length === 7);
  t('oldest first', h[0].day < h[6].day, [h[0].day, h[6].day]);
  t('today carries minutes', h[6].minutes === 75, h[6]);
  t('an empty day is 0, not missing', h.every(d => typeof d.minutes === 'number'));

  const w = m.weekProgress(600, NOW);
  t('week progress totals minutes', w.minutes > 0, w);
  t('pct is bounded', w.pct >= 0 && w.pct <= 100, w);
  t('a zero goal does not divide by zero', m.weekProgress(0, NOW).pct === 0);
  t('exceeding the goal caps at 100', m.weekProgress(1, NOW).pct === 100);
}

// ── Remote merge ──────────────────────────────────────────────────────────
console.log('\nremote merge');
{
  mem.clear();
  const m = await import(new URL('../js/modules/sessions.js?s6', import.meta.url).href);
  const mine = m.log('focus', { classId: 'c1', durationMs: 25 * MIN, startedAt: NOW });

  const foreign = { id: 'ss_phone', kind: 'review', classId: 'c2', startedAt: NOW - 3600000,
                    durationMs: 20 * MIN, day: m.dayKey(NOW - 3600000), cards: 14, completed: true };
  m.applyRemote([foreign]);
  t('the foreign session was adopted', m.all().some(s => s.id === 'ss_phone'));
  t('the local session survived', m.all().some(s => s.id === mine.id));
  t('nothing was duplicated', m.all().length === 2, m.all().length);

  m.applyRemote([foreign, foreign]);
  t('re-applying the same payload changes nothing', m.all().length === 2);
  t('junk is ignored', m.applyRemote(null) === false);
  t('sorted oldest first', m.all()[0].startedAt <= m.all()[1].startedAt);
}

// ── Annotation + robustness ───────────────────────────────────────────────
console.log('\nannotation and robustness');
{
  mem.clear();
  const m = await import(new URL('../js/modules/sessions.js?s7', import.meta.url).href);
  const s = m.log('focus', { durationMs: 25 * MIN });
  t('a note can be attached', m.annotate(s.id, 'Finished HW3 problem 1').note === 'Finished HW3 problem 1');
  t('annotating an unknown session is null', m.annotate('nope', 'x') === null);
  t('a very long note is truncated', m.annotate(s.id, 'x'.repeat(900)).note.length === 500);

  mem.set('studyos_sessions_v1', '{ not json');
  const m2 = await import(new URL('../js/modules/sessions.js?s8', import.meta.url).href);
  t('a corrupt log does not throw', Array.isArray(m2.all()));
  t('and starts empty rather than crashing', m2.all().length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
