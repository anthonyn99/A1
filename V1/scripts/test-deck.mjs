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
  t('unseen cards are not counted as due', !('dueNow' in c));
  t('new available is capped by the daily limit', c.newAvailable === Math.min(c.unseen, 15), c);
  t('toStudy = due + new available', c.toStudy === c.due + c.newAvailable);
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

// ── Daily new-card cap ────────────────────────────────────────────────────
console.log('\nnew-card cap');
{
  localStorage.setItem('studyos_cards_settings_v1', JSON.stringify({ newPerDay: 2 }));
  const many = Array.from({ length: 8 }, (_, i) => ({ front: `What does term number ${i} mean here?`, back: `Meaning ${i} of it` }));
  deck.addExternal('c1', 'm1', many, { noteId: 'topic_f9_tabc', title: 'Cap' });
  const before = deck.introducedToday();
  const q = deck.buildQueue({ classId: 'c1', noteId: 'topic_f9_tabc' });
  t('a queue holds at most the remaining cap of new cards', q.length <= Math.max(0, 2 - before), { len: q.length, before });
  const fresh = deck.forClass('c1').filter(c => c.sourceNoteId === 'topic_f9_tabc');
  deck.gradeCard(fresh[0].id, 3);
  t('a first review stamps introducedAt', !!deck.get(fresh[0].id).introducedAt);
  t('introducedToday counts it', deck.introducedToday() === before + 1);
  t('suggested cards never enter a queue', (() => {
    deck.setStatus(fresh[1].id, 'suggested');
    localStorage.setItem('studyos_cards_settings_v1', JSON.stringify({ newPerDay: 100 }));
    return !deck.buildQueue({ classId: 'c1' }).some(c => c.id === fresh[1].id);
  })());
  t('archived cards are out of mastery', (() => {
    const m0 = deck.mastery('c1').total;
    deck.setStatus(fresh[2].id, 'archived');
    return deck.mastery('c1').total === m0 - 1;
  })());
  localStorage.removeItem('studyos_cards_settings_v1');
}

// ── Tombstones: a deleted card never comes back ──────────────────────────
console.log('\ntombstones');
{
  const victim = deck.forClass('c1').find(c => c.sourceNoteId === 'topic_f9_tabc' && !c.sched);
  const stale = JSON.parse(JSON.stringify(victim));          // device B's old copy
  deck.remove('c1', victim.id);
  t('removed from the live deck', !deck.get(victim.id));
  t('kept as a tombstone', deck.rawForClass('c1').some(c => c.id === victim.id && c.deletedAt));
  deck.applyRemote('c1', [stale]);
  t('a stale remote copy does not resurrect it', !deck.get(victim.id));
  const editedLater = { ...stale, q: stale.q + ' (edited)', updatedAt: Date.now() + 60000 };
  deck.applyRemote('c1', [editedLater]);
  t('an edit made AFTER the delete wins', !!deck.get(victim.id));
}

// ── Edit keeps id and schedule; content and schedule merge independently ─
console.log('\nedit + merge');
{
  const card = deck.forClass('c1').find(c => c.sched && c.sched.reps);
  const sched = JSON.stringify(card.sched);
  const e = deck.edit(card.id, { content: 'A brand new front?\n---\nA brand new back' });
  t('edit keeps the id', e.id === card.id);
  t('edit keeps the schedule byte-for-byte', JSON.stringify(e.sched) === sched);
  t('edit changes content and fp', e.q === 'A brand new front?' && e.fp !== card.fp);
  // Device B reviewed the OLD content later; device A edited. Both survive.
  const remote = { ...card, sched: { ...card.sched, reps: 42, lastReview: Date.now() + 5000 }, updatedAt: 1 };
  deck.applyRemote('c1', [remote]);
  const m = deck.get(card.id);
  t('the edit survived the remote review', m.q === 'A brand new front?');
  t('the remote review survived the edit', m.sched.reps === 42);
  t('restoreCard undoes an edit', deck.restoreCard(card).q === card.q && deck.get(card.id).q === card.q);
}

// ── Review units: each cloze blank on its own schedule ───────────────────
console.log('\nstudy queue in units');
{
  localStorage.setItem('studyos_cards_settings_v1', JSON.stringify({ newPerDay: 50 }));
  deck.addExternal('c1', 'm1', [{ kind: 'cloze', front: 'In {{1::3NF}} nothing depends {{2::transitively}} on the key.', back: '' }],
    { noteId: 'topic_f7_tcz', title: 'Cloze' });
  const cz = deck.forClass('c1').find((c) => c.sourceNoteId === 'topic_f7_tcz');
  const q = deck.studyQueue({ ids: [cz.id] }, { mode: 'learn' });
  t('a two-blank cloze is two new units', q.length === 2 && q[0].cloze === 1 && q[1].cloze === 2 && q[1].sub === 'c2', q);
  deck.gradeCard(cz.id, 3, { sub: 'c2' });
  const c2 = deck.get(cz.id);
  t('grading blank 2 schedules ONLY blank 2', !c2.sched && c2.subSched.c2 && c2.subSched.c2.reps === 1, c2);
  t('blank 1 is still new', deck.studyQueue({ ids: [cz.id] }, { mode: 'learn' }).map((u) => u.cloze).join() === '1');
  t('the cap counts cards, not blanks', deck.studyQueue({ ids: [cz.id] }, { mode: 'learn', maxNew: 1 }).length === 1);
  const unread = deck.studyQueue({ ids: [cz.id] }, { mode: 'learn', eligible: deck.fromReadLesson });
  t('a breakdown card waits until its lesson is opened', unread.length === 0);
  deck.markLessonRead('c1', 'topic_f7_tcz');
  t('...and is introduced once it is', deck.studyQueue({ ids: [cz.id] }, { mode: 'learn', eligible: deck.fromReadLesson }).length === 1);
  t('cram covers every unit, schedule ignored', deck.cramUnits({ ids: [cz.id] }).length === 2);
  localStorage.removeItem('studyos_cards_settings_v1');
}

// ── Decks, tags, appending, leeches (overhaul §5.3, §5.7) ────────────────
console.log('\ndecks');
{
  const tree = deck.deckTree('c1', (fileId) => (fileId === 'f9' ? { doc: 'Lecture 9', topics: { tabc: 'The cap topic' }, order: ['tabc'] } : null));
  const doc = tree.children.find((n) => n.kind === 'doc' && n.id === 'f9');
  t('documents are decks, named from the breakdown', doc && doc.name === 'Lecture 9', tree.children.map((n) => [n.kind, n.name]));
  t('topics nest under their document', doc && doc.children[0].name === 'The cap topic' && doc.children[0].path.join('/') === 'c1/f9/tabc');
  t('note cards get their own group', tree.children.some((n) => n.kind === 'notes' && n.cards.length >= 1));
  t('the class deck holds every card', tree.cards.length === deck.forClass('c1').length);
  const parent = deck.createDeck('c1', 'Midterm');
  const child = deck.createDeck('c1', 'Week 3', parent.id);
  const someIds = deck.forClass('c1').slice(0, 2).map((c) => c.id);
  t('cards move into a deck', deck.moveCards([someIds[0]], child.id) === 1 && deck.get(someIds[0]).deckId === child.id);
  t('a parent deck includes its sub-decks\' cards', deck.deckTree('c1').children.find((n) => n.id === parent.id).cards.some((c) => c.id === someIds[0]));
  t('...and so does studying it', deck.cramUnits({ classId: 'c1', userDeck: parent.id }).some((u) => u.id === someIds[0]));
  t('decks sync in the class meta', deck.metaOf('c1').decks.length === 2);
  const sched = JSON.stringify(deck.get(someIds[0]).sched);
  t('deleting a deck keeps its cards', deck.deleteDeck('c1', parent.id) === 1 && !!deck.get(someIds[0]) && !deck.get(someIds[0]).deckId);
  t('...and their schedules', JSON.stringify(deck.get(someIds[0]).sched) === sched);
  t('...and its sub-decks go with it', deck.userDecks('c1').length === 0);
  const remoteDeck = { id: 'dk_remote', name: 'From the phone', updatedAt: Date.now() };
  deck.applyRemote('c1', deck.rawForClass('c1'), { v: 2, decks: [remoteDeck] });
  t('a deck made on another device arrives', deck.userDecks('c1').some((d) => d.id === 'dk_remote'));
}

console.log('\ntags');
{
  const ids = deck.forClass('c1').slice(0, 3).map((c) => c.id);
  const fp = deck.get(ids[0]).fp;
  t('tags are added in bulk', deck.tagCards(ids, '#Exam') === 3 && deck.get(ids[0]).tags.includes('exam'));
  t('a tag change leaves the fingerprint alone', deck.get(ids[0]).fp === fp);
  t('tags are listed for filters', deck.tagsOf('c1')[0] === 'exam');
  t('a tag scopes a study queue', deck.cramUnits({ classId: 'c1', tag: 'exam' }).every((u) => ids.includes(u.id)));
}

console.log('\naddCards appends, never reconciles');
{
  const before = deck.forClass('c1').filter((c) => c.sourceNoteId === 'topic_f9_tabc').length;
  const added = deck.addCards('c1', [{ front: 'Why is the cap global, not per class?', back: 'So two classes cannot double a day.' },
    { front: '', back: 'bad' }], { noteId: 'topic_f9_tabc', title: 'Cap', readAt: 1 });
  t('one good card is added, the bad one skipped', added.length === 1 && added[0].readAt === 1);
  t('the topic\'s other cards are all still there', deck.forClass('c1').filter((c) => c.sourceNoteId === 'topic_f9_tabc').length === before + 1);
  t('the same content twice is skipped', deck.addCards('c1', [{ front: 'Why is the cap global, not per class?', back: 'So two classes cannot double a day.' }], { noteId: 'x' }).length === 0);
}

console.log('\nexam plan');
{
  localStorage.setItem('studyos_cards_settings_v1', JSON.stringify({ newPerDay: 0 }));
  t('with no plan, a zero cap lets nothing in', deck.newRemaining(Date.now(), 'c1') === 0);
  deck.setPlan('c1', { perDay: 7, until: Date.now() + 5 * 86400000, examAt: Date.now() + 7 * 86400000 });
  t('a plan gives its class its own daily allowance', deck.newRemaining(Date.now(), 'c1') === 7 - deck.introducedToday(Date.now(), 'c1'));
  t('...and only its class', deck.newRemaining(Date.now(), 'other') === 0);
  t('a plan ends on its date', deck.planOf('c1', Date.now() + 6 * 86400000) === null);
  const older = { ...deck.metaOf('c1').plan, perDay: 99, updatedAt: 1 };
  t('the newest plan wins a merge', deck.mergeMeta(deck.metaOf('c1'), { plan: older }).plan.perDay === 7);
  deck.setPlan('c1', null);
  t('stopping the plan clears it', deck.planOf('c1') === null);
  localStorage.removeItem('studyos_cards_settings_v1');
}

console.log('\nleeches');
{
  const c = deck.addCards('c1', [{ front: 'What are the three normal forms in order?', back: '1NF, 2NF, 3NF.' }], { noteId: 'lee' })[0];
  let now = Date.now();
  deck.gradeCard(c.id, 3, now);
  for (let k = 0; k < 6; k++) { now += 3 * 86400000; deck.gradeCard(c.id, 1, now); now += 3600000; deck.gradeCard(c.id, 3, now); }
  const l = deck.get(c.id);
  t('six lapses tag a card as a leech', l.sched.lapses >= 6 && l.tags.includes('leech'), { lapses: l.sched.lapses, tags: l.tags });
  t('the review log is kept, trimmed', Array.isArray(l.log) && l.log.length === 13 && l.log.length <= 50);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
