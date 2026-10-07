// Tests for js/modules/migrate-cards-v2.js — the one-time card cleanup.
//
// The cases this file exists for:
//
//   "a reviewed card is never touched"
//       Her Data Structures deck has 101 reviewed cards. Their status and
//       their schedule must come out byte-for-byte as they went in.
//
//   "the dry run is what happens"
//       The modal shows a plan; apply writes exactly that plan.
//
//   "it runs once"
//       A class is marked v2 in its synced meta, so no device re-runs it and
//       re-ranks suggestions she has promoted since.
//
// Fixtures are the audit's real examples (§3.1).
// Run with:  node scripts/test-migrate.mjs
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const classes = [{ id: 'db', name: 'Intro to Database Systems', modules: [{ id: 'm1', files: [
  { id: 'kroenke', name: 'kroenke ch1.pdf', study: { status: 'ready' } },
  { id: 'sf_1788105252897_ymyw9h', name: 'Chapter1-Introduction.pdf', study: { status: 'ready' } },
] }] }];
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  _sosBridge: {
    getClasses: () => classes, getEvents: () => [], getTasks: () => [], getNotes: () => [],
    getKsu: () => ({ modules: [] }), getModules: () => [], getSnapshot: () => null, subscribe: () => () => {},
    setFileStudy() {},
  },
  _fbSaveCards() {}, _fbSaveDoc() {},
};
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } };

const deck = await import(new URL('../js/modules/deck.js', import.meta.url).href);
const bd = await import(new URL('../js/modules/breakdown.js', import.meta.url).href);
const mig = await import(new URL('../js/modules/migrate-cards-v2.js', import.meta.url).href);

// ── Fixtures ──────────────────────────────────────────────────────────────
const lesson = (md) => ({ blocks: [{ kind: 'read', title: 'R', markdown: md }, { kind: 'recap', title: 'Recap', points: ['p'] }] });
const docKroenke = {
  fileId: 'kroenke', classId: 'db', moduleId: 'm1', sourceName: 'kroenke ch1.pdf', status: 'ready',
  topics: [
    { id: 'thist', title: 'Historical eras of database processing', status: 'ready', style: 'concept',
      key_points: ['early file systems', 'relational model', 'the internet era'],     // budget: 4
      lesson: lesson('Databases grew from file systems [1]. The supplied page does not explain the dates. The relational model came next.') },
    { id: 'tcopy', title: 'Copyright and acknowledgements notice', status: 'ready', key_points: ['x'], lesson: lesson('Pearson.') },
  ],
};
const docGarbage = {
  fileId: 'sf_1788105252897_ymyw9h', classId: 'db', moduleId: 'm1', sourceName: 'Chapter1-Introduction.pdf', status: 'ready',
  topics: [{ id: 'tecon', title: 'Introduction to Demand and Supply', status: 'ready', key_points: [],
    lesson: lesson('No malformed JSON was provided to repair, so this is a placeholder matching the exact schema requirements.') }],
};

const T = (topicId, fileId = 'kroenke') => ({ noteId: bd.noteIdFor(fileId, topicId), title: topicId });
const hist = [
  { front: 'What is the heading on page 3?', back: 'Computer Organization and Architecture.' },                         // meta
  { front: 'Which textbook are these slides from?', back: 'Kroenke.' },                                                  // meta
  { front: 'What did early file processing systems lack?', back: 'Integration: each program owned its own files.' },
  { front: 'What did early file-processing systems lack?', back: 'Integration — each program owned its own files.' },  // near-dup
  { front: 'Who proposed the relational model?', back: 'E. F. Codd, in 1970.' },
  { front: 'Why did the relational model win over hierarchical databases?', back: 'It separates the logical view from storage.' },
  { front: 'What is a DBMS?', back: 'Software that defines, stores and controls access to a database.' },
  { front: 'When did personal computer databases appear?', back: 'In the 1980s, with products like dBase.' },
  { front: 'What changed in the internet era of databases?', back: 'Web applications made databases public-facing.' },
  { front: 'What is NoSQL?', back: 'Non-relational stores built for scale.' },
];
deck.addExternal('db', 'm1', hist, T('thist'));
deck.addExternal('db', 'm1', [{ front: 'Which organization is named in the copyright line?', back: 'Pearson.' },
  { front: 'Who published these lecture notes for the course?', back: 'Pearson Education.' }], T('tcopy'));
deck.addExternal('db', 'm1', [{ front: 'What is price elasticity of demand?', back: 'Responsiveness of quantity to price.' }],
  T('tecon', 'sf_1788105252897_ymyw9h'));
// One card from her own notes: never touched.
deck.generateFromNote('db', 'm1', { id: 'n1', title: 'Keys', body: '# Primary Key\nA column that uniquely identifies each row of a table.\n' });

// She has REVIEWED one breakdown card, and one card in the garbage breakdown.
const histCards = deck.forClass('db').filter((c) => c.sourceNoteId === bd.noteIdFor('kroenke', 'thist'));
const reviewed = histCards.find((c) => /relational model win/.test(c.q));
deck.gradeCard(reviewed.id, 3);
const econ = deck.forClass('db').find((c) => /elasticity/.test(c.q));
deck.gradeCard(econ.id, 3);
// A reviewed card that DUPLICATES an unseen one: the unseen one goes.
const dupOfReviewed = histCards.find((c) => /What is a DBMS/.test(c.q));
deck.addExternal('db', 'm1', [{ front: 'What is a DBMS exactly?', back: 'Software that defines, stores and controls access to a database.' }], T('tother'));
deck.gradeCard(deck.forClass('db').find((c) => c.sourceNoteId === bd.noteIdFor('kroenke', 'tother')).id, 3);

bd.saveDoc(JSON.parse(JSON.stringify(docKroenke)));
bd.saveDoc(JSON.parse(JSON.stringify(docGarbage)));

const before = deck.rawForClass('db');
const reviewedBefore = before.filter(deck.isReviewed).map((c) => JSON.stringify(c));

// ── Plan ──────────────────────────────────────────────────────────────────
console.log('\nplan');
const plan = mig.planMigration({ classes: [classes[0]], cardsByClass: { db: before }, docs: [docKroenke, docGarbage] });
const after = plan.lists.db;
const live = after.filter(deck.isLive);
const s = plan.perClass.db;
t('the plan changes something', plan.changed);
t('meta cards are deleted', !live.some((c) => /heading on page|textbook/i.test(c.q)) && s.reasons.meta === 2, s.reasons);
t('the copyright topic\'s cards are deleted', !live.some((c) => c.sourceNoteId === bd.noteIdFor('kroenke', 'tcopy')) && s.reasons.boilerplate === 2, s.reasons);
t('the near-duplicate is deleted, one copy kept', live.filter((c) => /early file.processing systems lack/i.test(c.q)).length === 1);
t('an unseen card duplicating a reviewed one is deleted', !live.some((c) => c.id === dupOfReviewed.id));
t('deletions are tombstones', after.filter((c) => c.deletedAt).length === s.deleted);
t('reviewed cards are byte-for-byte unchanged', after.filter(deck.isReviewed).map((c) => JSON.stringify(c)).join('|') === reviewedBefore.join('|'));
t('even a reviewed card in the garbage breakdown survives', live.some((c) => c.id === econ.id && JSON.stringify(c.sched) === JSON.stringify(econ.sched) || c.id === econ.id));
const histLive = live.filter((c) => c.sourceNoteId === bd.noteIdFor('kroenke', 'thist'));
const histActive = histLive.filter((c) => deck.statusOf(c) === 'active');
t('the topic keeps its budget (4) active, counting the reviewed card', histActive.length === 4, histActive.map((c) => c.q));
t('the rest are suggestions, not deleted', histLive.filter((c) => deck.statusOf(c) === 'suggested').length === histLive.length - 4);
t('her own notes\' cards are untouched', JSON.stringify(after.find((c) => c.sourceNoteId === 'n1')) === JSON.stringify(before.find((c) => c.sourceNoteId === 'n1')));
const rm = plan.docOps.find((o) => o.action === 'remove');
t('the garbage breakdown is removed', rm && rm.fileId === 'sf_1788105252897_ymyw9h');
const clean = plan.docOps.find((o) => o.action === 'clean' && o.fileId === 'kroenke');
t('lessons lose [n] markers and meta sentences', clean && !/\[1\]|supplied page/.test(clean.topics.thist[0].markdown) && clean.stripped === 1, clean);
t('topic counts follow the new statuses', clean && clean.counts.thist && clean.counts.thist.cardCount === 4, clean && clean.counts);
t('the summary adds up', s.active + s.suggested === live.length, s);

// ── Apply = the plan ──────────────────────────────────────────────────────
console.log('\napply');
await mig.applyMigration(plan, ['db']);
const applied = deck.rawForClass('db');
t('apply writes exactly the planned cards', JSON.stringify(applied) === JSON.stringify(after));
t('the class is marked v2 in its synced meta', deck.metaOf('db').v === 2);
t('the garbage breakdown doc is removed', bd.peek('sf_1788105252897_ymyw9h').status === 'removed');
t('the cleaned lesson is saved', !/\[1\]/.test(bd.peek('kroenke').topics[0].lesson.blocks[0].markdown));
t('reviewed schedules still byte-for-byte', applied.filter(deck.isReviewed).map((c) => JSON.stringify(c)).join('|') === reviewedBefore.join('|'));
t('the dashboard no longer counts unseen as due', deck.countsFor('db').due === 0 && deck.countsFor('db').newAvailable <= 15);

// ── Runs once ─────────────────────────────────────────────────────────────
console.log('\nonce');
{
  // She promotes a suggestion; a second run must not demote it.
  const sug = deck.forClass('db').find((c) => deck.statusOf(c) === 'suggested');
  deck.setStatus(sug.id, 'active');
  const r = await mig.maybeRun({});
  t('a migrated class is not planned again', r === null);
  t('her promotion stands', deck.statusOf(deck.get(sug.id)) === 'active');
  const again = mig.planMigration({ classes: [classes[0]], cardsByClass: { db: deck.rawForClass('db') }, docs: [bd.peek('kroenke')] });
  t('a plan on clean data deletes nothing', again.perClass.db.deleted === 0, again.perClass.db);
  t('a remote copy with an older meta keeps v2', (deck.applyRemote('db', deck.rawForClass('db'), { v: 1 }), deck.metaOf('db').v === 2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
