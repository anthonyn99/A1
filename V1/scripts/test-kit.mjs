// Tests for study-kit filing: js/modules/{synced,quiz,kit}.js + deck.addExternal.
//
// The cases this file exists for:
//
//   "a re-run keeps history and does not stack"
//       Regenerating a lecture's kit words things differently. Cards and
//       questions with review/answer history must survive; untouched leftovers
//       from the previous run must go, or every re-run doubles the set.
//
//   "a deletion stays deleted across devices"
//       A union merge resurrects anything the other device still holds. The
//       synced store keeps tombstones for exactly this.
//
//   "nothing that must persist hides under an underscore key"
//       _sosSerializeClasses strips _-prefixed keys on save (see memory:
//       studyos-underscore-keys-stripped). Kit provenance must use plain keys.
//
//   "cards and questions carry the SOURCE lecture's module"
//       That is what "quiz me on Module 2" and an exam's covered modules use.
//
// Run with:  npm run test:kit
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};

// ── Stubs ─────────────────────────────────────────────────────────────────
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const classes = [{
  id: 'c1', name: 'Databases',
  modules: [
    { id: 'm1', name: 'Module 1', type: 'documents', files: [{ id: 'f1', name: 'L1.pdf' }], prompts: [], notes: [] },
    { id: 'm2', name: 'Module 2', type: 'documents', files: [{ id: 'f2', name: 'L2.pdf' }], prompts: [], notes: [] },
  ],
}];
const docSaves = [];
const notes = [];
const listeners = {};
globalThis.window = {
  addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  removeEventListener() {}, dispatchEvent() { return true; },
  _sosBridge: {
    getClasses: () => classes, getEvents: () => [], getTasks: () => [], getNotes: () => [],
    getKsu: () => ({ modules: [] }), getModules: () => [], getSnapshot: () => null, subscribe: () => () => {},
    addGeneratedNote: (spec) => {
      notes.push(spec);
      let mod = classes[0].modules.find((m) => m.type === 'notes' && m.name === (spec.moduleName || 'Generated'));
      if (!mod) { mod = { id: 'nm', name: spec.moduleName, type: 'notes', files: [], prompts: [], notes: [] }; classes[0].modules.push(mod); }
      return { id: 'e1' };
    },
  },
  _fbSaveCards: () => {},
  _fbSaveDoc: (path, doc) => docSaves.push({ path, doc: JSON.parse(JSON.stringify(doc)) }),
};
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } };

const imp = (p) => import(new URL(p, import.meta.url).href);
const { syncedList } = await imp('../js/modules/synced.js');
const quiz = await imp('../js/modules/quiz.js');
const deck = await imp('../js/modules/deck.js');
const kit = await imp('../js/modules/kit.js');
const prompts = await imp('../js/modules/prompts.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── synced list ───────────────────────────────────────────────────────────
console.log('\nsynced list');
{
  const s = syncedList({ kind: 'quiz', lsKey: 'tk_a', docPath: 'x/a' });
  s.upsert([{ id: 'a', v: 1 }, { id: 'b', v: 1 }]);
  t('upsert stores records', s.all().length === 2);
  t('stored with a schema version', JSON.parse(mem.get('tk_a')).v === 1);
  s.remove('a');
  t('remove hides the record', s.all().map((r) => r.id).join() === 'b');
  t('...but keeps a tombstone', JSON.parse(mem.get('tk_a')).items.some((r) => r.id === 'a' && r.deleted));
  // The other device still has 'a' (older) — it must NOT come back.
  s.applyRemote({ v: 1, items: [{ id: 'a', v: 1, updatedAt: 1 }, { id: 'b', v: 1, updatedAt: 1 }] });
  t('a stale remote copy does not resurrect a deletion', !s.get('a'));
  // A genuinely newer remote edit wins.
  s.applyRemote({ v: 1, items: [{ id: 'b', v: 2, updatedAt: Date.now() + 1000 }] });
  t('a newer remote copy wins', s.get('b').v === 2);
  // A remote record we have never seen is added.
  s.applyRemote({ v: 1, items: [{ id: 'c', v: 1, updatedAt: 5 }] });
  t('an unseen remote record is added', !!s.get('c'));
  t('a bare-array legacy document is upgraded, not dropped',
    (() => { mem.set('tk_b', JSON.stringify([{ id: 'z' }])); return syncedList({ kind: 'quiz', lsKey: 'tk_b', docPath: 'x/b' }).all().length === 1; })());

  docSaves.length = 0;
  const s2 = syncedList({ kind: 'quiz', lsKey: 'tk_c', docPath: 'x/c' });
  s2.upsert({ id: 'mine', v: 1 });
  await sleep(700);
  const n = docSaves.length;
  s2.applyRemote({ v: 1, items: [{ id: 'mine', v: 1, updatedAt: s2.get('mine').updatedAt }] });
  await sleep(700);
  t('an identical remote copy does not trigger a write-back (no ping-pong)', docSaves.length === n, docSaves.length - n);
  s2.applyRemote({ v: 1, items: [] });
  await sleep(700);
  t('a remote missing our record DOES trigger a write-back', docSaves.length === n + 1, docSaves.length - n);
}

// ── quiz bank ─────────────────────────────────────────────────────────────
const Q = (i, extra = {}) => ({ topic: 'SQL', type: 'mcq', prompt: `Question ${i}?`,
  choices: ['a', 'b', 'c', 'd'], answer: 'b', explanation: 'x', ...extra });

console.log('\nquiz bank');
{
  const src = { sourceFileId: 'f1', sourceTitle: 'L1', jobId: 'j1' };
  const r1 = quiz.addFromKit('c1', 'm1', [Q(1), Q(2), Q(3), Q(3)], src);
  t('adds questions, collapsing duplicates', r1.added.length === 3 && quiz.forClass('c1').length === 3);
  const q1 = quiz.forClass('c1').find((q) => q.prompt === 'Question 1?');
  t('tagged with the lecture module', q1.moduleId === 'm1');
  t('provenance is under a plain key', q1.source && q1.source.sourceFileId === 'f1');
  quiz.recordAnswer('c1', q1.id, false);
  const r2 = quiz.addFromKit('c1', 'm1', [Q(1), Q(4)], { ...src, jobId: 'j2' });
  const ids = quiz.forClass('c1').map((q) => q.prompt).sort();
  t('a re-run keeps the answered question with its stats',
    quiz.get('c1', q1.id).stats.attempts === 1, quiz.get('c1', q1.id));
  t('...adds the new one and drops the unanswered leftovers',
    ids.join('|') === 'Question 1?|Question 4?', ids);
  t('...and reports what it dropped', r2.dropped.length === 2);
  quiz.addFromKit('c1', 'm2', [Q(9)], { sourceFileId: 'f2', sourceTitle: 'L2' });
  t('another lecture\'s run leaves this one alone', quiz.forClass('c1').length === 3);

  const qz = quiz.buildQuiz({ classId: 'c1' }, 10, () => 0.5);
  t('the missed question is in the quiz', qz.some((q) => q.id === q1.id));
  t('module scope filters', quiz.buildQuiz({ classId: 'c1', moduleIds: ['m2'] }).length === 1);
  t('topic scope filters (case-insensitive)', quiz.buildQuiz({ classId: 'c1', topics: ['sql'] }).length === 3);

  t('mcq grades by exact choice', quiz.gradeSync(q1, 'b').correct === true && quiz.gradeSync(q1, 'a').correct === false);
  const tr = { type: 'trace', answer: '1\n2\n3' };
  t('trace forgives spacing and blank edges', quiz.gradeSync(tr, '  1 \n2\n 3\n\n').correct === true);
  t('trace is still exact on content', quiz.gradeSync(tr, '1 2 3').correct === false);
  t('trace forgives surrounding quotes', quiz.gradeSync({ type: 'trace', answer: 'hello' }, '"hello"').correct === true);
  t('short answers need a human', quiz.gradeSync({ type: 'short', answer: 'x' }, 'x').correct === null);

  const stored = mem.get('studyos_quiz_c1');
  t('no underscore-prefixed keys in the stored bank', !/"_[a-zA-Z]/.test(stored), stored.match(/"_[a-zA-Z]\w*/g));
}

// ── deck.addExternal ─────────────────────────────────────────────────────
console.log('\ndeck.addExternal');
{
  const cards = (n, off = 0) => Array.from({ length: n }, (_, i) => ({
    front: `What is concept ${i + off}?`, back: `Definition ${i + off}`, topic: 'Keys', slide: i + 1 }));
  const r = deck.addExternal('c1', 'm1', cards(5), { noteId: 'kit_f1', title: 'L1' });
  t('adds kit cards', r.added.length === 5);
  const c0 = deck.forClass('c1').find((c) => c.q === 'What is concept 0?');
  t('card carries topic, slide and module', c0.topic === 'Keys' && c0.sourceSlide === 1 && c0.moduleId === 'm1');
  deck.gradeCard(c0.id, 3);
  // Re-run with different wording for 1-4, same for 0.
  const r2 = deck.addExternal('c1', 'm1', [cards(1)[0], ...cards(3, 10)], { noteId: 'kit_f1', title: 'L1' });
  const qs = deck.forClass('c1').map((c) => c.q).sort();
  t('the reviewed card keeps its schedule', deck.get(c0.id).sched && deck.get(c0.id).sched.reps === 1);
  t('unreviewed leftovers are dropped, not stacked', r2.dropped.length === 4 && qs.length === 4, qs);
  deck.addExternal('c1', 'm2', cards(2, 50), { noteId: 'kit_f2', title: 'L2' });
  t('another source is untouched', deck.forClass('c1').length === 6);
  const bad = deck.addExternal('c1', 'm1', [{ front: 'Hi', back: 'x' }, { front: 'What is X?', back: '' }], { noteId: 'kit_x' });
  t('malformed items are skipped', bad.added.length === 0);
}

// ── fileKit ──────────────────────────────────────────────────────────────
console.log('\nfileKit');
{
  const flash = Array.from({ length: 16 }, (_, i) => ({ front: `Kit question ${i}?`, back: `ans ${i}`, topic: 'Joins', slide: i + 1 }));
  const job = {
    id: 'j9', classId: 'c1', fileId: 'f2', sourceName: 'L2.pdf', status: 'done', mode: 'kit', promptId: 'p',
    kit: { flashcards: flash, key_terms: [{ term: 'Natural join', definition: 'joins on equal-named columns', topic: 'Joins' }],
           quiz: [Q(20), Q(21, { type: 'trace', prompt: 'print(1)', answer: '1', choices: undefined })],
           cheatsheet_md: '# Joins\n- inner' },
    kitRewrite: false,
  };
  let pdfCalls = 0;
  const res = await kit.fileKit(job, { filePdf: async () => { pdfCalls++; return { moduleId: 'g' }; } });
  t('17 cards (16 + 1 key term)', res.cards === 17, res);
  t('2 questions', res.questions === 2, res);
  const kc = deck.forClass('c1').find((c) => c.q === 'Kit question 0?');
  t('kit cards carry the SOURCE module (Module 2)', kc && kc.moduleId === 'm2');
  t('key terms become "Define:" cards', deck.forClass('c1').some((c) => c.q === 'Define: Natural join'));
  const n = notes.at(-1);
  t('cheat sheet goes to the Study Kit module', n && n.moduleName === 'Study Kit');
  t('...with the key terms appended', n.body.includes('## Key terms') && n.body.includes('**Natural join**'));
  t('...keyed by sourceFileId so a re-run replaces it', n.meta.sourceFileId === 'f2');
  t('...with no underscore keys in its provenance', !Object.keys(n.meta).some((k) => k.startsWith('_')));
  t('no rewrite -> no PDF filing', pdfCalls === 0);
  t('the toast target is the Study Kit module', res.moduleName === 'Study Kit' && res.moduleId === 'nm');

  const res2 = await kit.fileKit({ ...job, kitRewrite: true, hasPdf: true }, { filePdf: async (j, mode) => { pdfCalls++; t('the kit deck is filed as a rewrite', mode === 'rewrite'); return { moduleId: 'g' }; } });
  t('with the rewrite -> the PDF is filed', pdfCalls === 1 && res2.deck);
  const res3 = await kit.fileKit({ ...job, kitRewrite: true, hasPdf: false, pdfError: 'boom' }, { filePdf: async () => { pdfCalls++; } });
  t('a failed layout is a warning, not a crash', pdfCalls === 1 && res3.warnings.some((w) => w.includes('boom')));
  const un = await kit.fileKit({ ...job, classId: 'gone' }, {});
  t('a missing class is reported unfiled', un.unfiled === true);
}

// ── presets ──────────────────────────────────────────────────────────────
console.log('\npresets');
{
  const { PRESETS, MODULE_NAME } = await imp('../js/modules/presets.js');
  t('five presets', PRESETS.length === 5);
  t('each names itself with a heading', PRESETS.every((p) => /^# \S/.test(p)));
  t('no preset uses a variable that may be unset', PRESETS.every((p) => !/\{\{(?!class\}\})/.test(p)));
  classes[0].modules.push({ id: 'pm', name: MODULE_NAME, type: 'prompts', files: [], notes: [],
    prompts: PRESETS.map((text, i) => ({ id: 'pm_' + i, text })) });
  const names = prompts.forClass('c1').map((p) => p.name);
  t('the Run sheet shows the heading text, without the #', names.includes('Exam-focused') && names.includes('Explain like I know Python'), names);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
