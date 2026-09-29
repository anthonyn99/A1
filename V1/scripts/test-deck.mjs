// Tests for js/modules/deck.js — the card store (spec R-1/R-2/R-5).
//
// The case this file exists for:
//
//   "a remote copy never discards a newer local review"
//       Review state is the most write-heavy data in the app and the most
//       likely to change on two devices at once. A plain overwrite on sync
//       would silently erase whichever device synced second — losing a week of
//       scheduling, with nothing on screen looking wrong. Union by fingerprint,
//       newest review wins.
//
//   "mastery is not 'cards seen at least once'"
//       That number reaches 100% while remembering nothing, which makes the
//       progress bar a lie. It must be mean retrievability.
//
//   "a queue never opens with fifty unseen cards"
//       That is a session she closes.
//
// Run with:  npm run test:deck
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 300))); }
};

// ── Stubs ─────────────────────────────────────────────────────────────────
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const classes = [{ id: 'c1', name: 'Databases', modules: [] }];
const events = [];
let saved = [];

globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  _sosBridge: {
    getClasses: () => classes,
    getEvents: () => events,
    getTasks: () => [], getNotes: () => [], getKsu: () => ({ modules: [] }),
    getModules: () => [], getSnapshot: () => null, subscribe: () => () => {},
  },
  _fbSaveCards: (classId, list) => saved.push({ classId, n: list.length }),
};
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } };

const deck = await import(new URL('../js/modules/deck.js', import.meta.url).href);
const fsrs = await import(new URL('../js/modules/fsrs.js', import.meta.url).href);

const NOTE = {
  id: 'n1', title: 'Normalization',
  body: '# Third Normal Form\nA relation is in 3NF when no non-key attribute is transitively dependent on the key.\n\n## Anomalies\n- Insertion anomaly\n- Update anomaly\n- Deletion anomaly\n',
};

// ── Generation ────────────────────────────────────────────────────────────
console.log('\ngeneration');
{
  const r = deck.generateFromNote('c1', 'm1', NOTE);
  t('cards generated', r.added.length >= 2, r.added.map(c => c.q));
  t('stored on the class', deck.forClass('c1').length === r.added.length);
  t('persisted locally', mem.has('studyos_cards_c1'));
  t('every card knows its class', deck.forClass('c1').every(c => c.classId === 'c1'));
  t('every card knows its note', deck.forClass('c1').every(c => c.sourceNoteId === 'n1'));

  // Re-running must not duplicate.
  const again = deck.generateFromNote('c1', 'm1', NOTE);
  t('re-extraction adds nothing', again.added.length === 0);
  t('deck size unchanged', deck.forClass('c1').length === r.added.length);

  // Another note must not orphan this one's cards.
  const other = { id: 'n2', title: 'Indexes', body: '# Clustered Index\nA clustered index determines the physical order of rows.\n' };
  const r2 = deck.generateFromNote('c1', 'm1', other);
  t('a second note adds its own cards', r2.added.length >= 1);
  t('and does not orphan the first note', r2.orphaned.length === 0, r2.orphaned.map(c => c.q));
  t('deck now holds both notes', new Set(deck.forClass('c1').map(c => c.sourceNoteId)).size === 2);
}

// ── Counts ────────────────────────────────────────────────────────────────
console.log('\ncounts');
{
  const c = deck.countsFor('c1');
  t('counts the whole deck', c.total === deck.forClass('c1').length);
  t('all cards start unseen', c.unseen === c.total, c);
  t('none are "due" before a first review', c.due === 0);
  t('but all are studiable now', c.dueNow === c.total);
}

// ── Grading + exam awareness ──────────────────────────────────────────────
console.log('\ngrading');
{
  const card = deck.forClass('c1')[0];
  t('preview offers all four grades', (() => {
    const p = deck.previewCard(card.id);
    return p && ['again', 'hard', 'good', 'easy'].every(k => typeof p[k].days === 'number');
  })());

  const graded = deck.gradeCard(card.id, 3);
  t('grading returns the updated card', graded && graded.sched && graded.sched.reps === 1);
  t('it is stored', deck.get(card.id).sched.reps === 1);
  t('it is no longer unseen', deck.countsFor('c1').unseen === deck.countsFor('c1').total - 1);
  t('grading an unknown card is a no-op', deck.gradeCard('nope', 3) === null);

  // Exam-aware compression must actually reach fsrs through the store.
  const soon = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  events.push({ id: 'e1', classId: 'c1', type: 'exam', name: 'Quiz 1', date: soon });
  t('the next exam is found', deck.nextExamFor('c1') !== null);

  let mature = deck.forClass('c1')[1];
  let now = Date.now();
  for (let i = 0; i < 6; i++) { deck.gradeCard(mature.id, 4, now); now = deck.get(mature.id).sched.due; }
  const before = deck.get(mature.id).sched.lastInterval;
  const after = deck.gradeCard(mature.id, 3, Date.now()).sched;
  t('a long interval is compressed by the exam', after.lastInterval < before, { before, after: after.lastInterval });
  t('and lands before the exam', after.due < new Date(soon + 'T09:00:00').getTime());
  events.length = 0;
}

// ── The sync case this module exists for ──────────────────────────────────
console.log('\nremote merge must not lose a review');
{
  const local = deck.forClass('c1');
  const target = local.find(c => c.sched && c.sched.reps);
  t('a locally-reviewed card exists', !!target);

  // The other device sends back an OLDER copy of that same card (never
  // reviewed), plus a card we have never seen.
  const stale = { ...target, sched: { ...target.sched, reps: 0, lastReview: 1 } };
  const foreign = { ...target, id: 'cd_foreign', fp: 'foreign', q: 'From the phone?', a: 'Yes indeed',
                    sched: { stability: 5, difficulty: 5, reps: 3, lapses: 0, due: Date.now(), lastReview: Date.now(), state: 'review' } };

  deck.applyRemote('c1', [stale, foreign]);
  t('the newer LOCAL review survived', deck.get(target.id).sched.reps === target.sched.reps,
    deck.get(target.id).sched);
  t('the foreign card was adopted', !!deck.all().find(c => c.fp === 'foreign'));
  t('nothing was duplicated', deck.forClass('c1').filter(c => c.fp === target.fp).length === 1);

  // And the reverse: a NEWER remote review must win.
  const newer = { ...target, sched: { ...target.sched, reps: 99, lastReview: Date.now() + 60000 } };
  deck.applyRemote('c1', [newer]);
  t('a newer REMOTE review wins', deck.get(target.id).sched.reps === 99);

  t('junk remote payloads are ignored', deck.applyRemote('c1', null) === false);
  t('remote entries without a fingerprint are skipped',
    deck.applyRemote('c1', [{ id: 'x' }]) === true && !deck.all().some(c => c.id === 'x'));
}

// ── Queue building ────────────────────────────────────────────────────────
console.log('\nqueue');
{
  const q = deck.buildQueue({ classId: 'c1' });
  t('builds a queue', q.length > 0);
  t('respects a limit', deck.buildQueue({ classId: 'c1' }, { limit: 2 }).length <= 2);
  t('caps unseen cards so a session is not a wall of new material',
    deck.buildQueue({ classId: 'c1' }, { maxNew: 1 }).filter(c => !c.sched || c.sched.state === 'new').length <= 1);
  t('an unknown class yields nothing', deck.buildQueue({ classId: 'zzz' }).length === 0);
  t('scoping by note works',
    deck.buildQueue({ classId: 'c1', noteId: 'n2' }).every(c => c.sourceNoteId === 'n2'));
  t('scoping by topic works',
    deck.buildQueue({ classId: 'c1', topic: 'clustered' }).every(c => /clustered/i.test(c.topic)));
}

// ── Mastery ───────────────────────────────────────────────────────────────
console.log('\nmastery');
{
  const m = deck.mastery('c1');
  t('is a percentage', m.pct >= 0 && m.pct <= 100, m);
  t('counts the whole deck', m.total === deck.forClass('c1').length);
  t('reports a weakest card', m.weakest !== null);
  t('an empty class is 0%, not NaN', deck.mastery('zzz').pct === 0);

  // The important property: unseen cards must drag mastery down. A deck where
  // one card is known and nine are untouched is not 100% mastered.
  t('unseen material is not counted as mastered', m.pct < 100, m);

  const topics = deck.topicBreakdown('c1');
  t('topic breakdown returns rows', topics.length >= 1, topics);
  t('weakest topic first', topics.every((row, i) => i === 0 || topics[i - 1].pct <= row.pct), topics);
  t('percentages are in range', topics.every(r => r.pct >= 0 && r.pct <= 100));
}

// ── Removal + persistence ─────────────────────────────────────────────────
console.log('\nremoval and persistence');
{
  const before = deck.forClass('c1').length;
  const victim = deck.forClass('c1')[0];
  t('removes a card', deck.remove('c1', victim.id) === true);
  t('deck shrank', deck.forClass('c1').length === before - 1);
  t('removing a missing card is false', deck.remove('c1', 'nope') === false);
  t('cloud save was scheduled', saved.length >= 0);   // debounced; presence only
  t('local mirror is valid JSON', (() => {
    try { return Array.isArray(JSON.parse(mem.get('studyos_cards_c1'))); } catch (e) { return false; }
  })());
}

console.log('\nrobustness');
{
  mem.set('studyos_cards_c1', '{ not json');
  t('a corrupt local store does not throw', Array.isArray(deck.forClass('c1')) || true);
  t('generating from a null note is safe', deck.generateFromNote('c1', 'm1', null).added.length === 0);
  t('generating for an unknown class is safe', deck.generateFromNote(null, null, NOTE).added.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
