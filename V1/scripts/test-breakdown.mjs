// Tests for js/modules/breakdown.js — topics → lessons → flashcards.
//
// The cases this file exists for:
//
//   "a model's lesson is untrusted"
//       A check whose answer is not one of its choices can never be marked
//       right; a lesson of only checks teaches nothing (SOLO's rule). Both are
//       caught here, not in front of her.
//
//   "a failed key stops the run"
//       A bad key fails every topic identically. Running the rest would spend
//       a request per topic to learn the same thing twelve times.
//
//   "two devices never lose each other's topics"
//       Merging is newest-wins PER TOPIC, not per document.
//
//   "flashcards land in the review deck, grouped per topic"
//       noteId 'topic_<fileId>_<topicId>' — so a topic's review, a document's
//       review, and a regenerate that keeps reviewed cards all work.
//
// Providers are stubbed at fetch — nothing here reaches a real API.
// Run with:  node scripts/test-breakdown.mjs
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
const FILE = { id: 'f1', name: 'Lecture 4.pdf', mime: 'application/pdf', fileId: 'f1' };
const classes = [{ id: 'c1', name: 'Databases', code: 'CS 3410',
  modules: [{ id: 'm1', name: 'Lectures', type: 'documents', files: [FILE], prompts: [], notes: [] }] }];
const docsSaved = [];
const summaries = [];
const listeners = {};
globalThis.window = {
  STUDYOS_CONFIG: { cloudflare: { ai: { enabled: false } } },
  addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
  removeEventListener() {},
  dispatchEvent(e) { (listeners[e.type] || []).forEach((fn) => fn(e)); return true; },
  _sosBridge: {
    getClasses: () => classes, getEvents: () => [], getTasks: () => [], getNotes: () => [],
    getKsu: () => ({ modules: [] }), getModules: () => [], getSnapshot: () => null, subscribe: () => () => {},
    resolveBlob: async () => new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' }),
    setFileStudy: (classId, moduleId, fileId, s) => summaries.push({ classId, moduleId, fileId, s }),
  },
  _fbSaveDoc: (path, payload) => docsSaved.push({ path, payload: JSON.parse(JSON.stringify(payload)) }),
  _fbSaveCards: () => {},
};
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } };
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = 'data:application/pdf;base64,' + Buffer.from(b).toString('base64');
      this.onload && this.onload();
    });
  }
};
// No IndexedDB in Node: the store must work without its local cache.
globalThis.indexedDB = { open() { const r = {}; setTimeout(() => r.onerror && r.onerror(), 0); return r; } };

let calls = [];
let responder = null;
globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body || '{}');
  calls.push({ url: String(url), body });
  return responder(body);
};
const reply = (obj) => new Response(JSON.stringify({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) }, finish_reason: 'stop' }] }), { status: 200 });

const bd = await import(new URL('../js/modules/breakdown.js', import.meta.url).href);
const ai = await import(new URL('../js/modules/ai.js', import.meta.url).href);
const deck = await import(new URL('../js/modules/deck.js', import.meta.url).href);

// ── Validation ────────────────────────────────────────────────────────────
console.log('\nvalidateTopics');
{
  const r = bd.validateTopics({ topics: [
    { title: 'Keys', summary: 's', style: 'definitions', key_points: ['superkey', ''], pages: '3-5' },
    { title: '', summary: 'untitled' },
    { title: 'Joins', style: 'weird' },
  ] });
  t('drops an untitled topic', r.value.topics.length === 2, r);
  t('an unknown style falls back to concept', r.value.topics[1].style === 'concept');
  t('empty key points are dropped', r.value.topics[0].key_points.length === 1);
  t('no topics is an error', !!bd.validateTopics({ topics: [] }).error);
  t('at most 15 topics', bd.validateTopics({ topics: Array.from({ length: 30 }, (_, i) => ({ title: 'T' + i })) }).value.topics.length === 15);
}

console.log('\nvalidateLesson');
const GOOD = {
  blocks: [
    { kind: 'read', title: 'What a key is', markdown: 'A **key** identifies a row.', steps: [], questions: [], points: [] },
    { kind: 'steps', title: 'Find the key', markdown: '', steps: [{ title: 'List attributes', body: 'Write them down.' }, { title: '', body: '' }], questions: [], points: [] },
    { kind: 'check', title: 'Check', markdown: '', steps: [], points: [], questions: [
      { q: 'Which is minimal?', choices: ['Superkey', 'Candidate key', 'Candidate key'], answer: ' candidate  KEY ', explanation: 'Minimal by definition.' },
      { q: 'Answer not offered', choices: ['A', 'B'], answer: 'C', explanation: '' },
      { q: 'One choice only', choices: ['A'], answer: 'A', explanation: '' },
    ] },
    { kind: 'poem', title: 'x', markdown: 'nope' },
    { kind: 'recap', title: 'Recap', markdown: '', steps: [], questions: [], points: ['Keys identify rows.'] },
  ],
  flashcards: [
    { front: 'What is a candidate key?', back: 'A minimal superkey.' },
    { front: 'what is a candidate key?', back: 'dup' },
    { front: 'Same', back: 'same' },
    { front: '', back: 'x' },
  ],
};
{
  const r = bd.validateLesson(GOOD);
  const kinds = r.value.blocks.map((b) => b.kind);
  t('unknown kinds dropped, known kept in order', kinds.join() === 'read,steps,check,recap', kinds);
  t('empty steps dropped', r.value.blocks[1].steps.length === 1);
  const qs = r.value.blocks[2].questions;
  t('a question whose answer is not a choice is dropped', qs.length === 1, qs);
  t('duplicate choices collapse', qs[0].choices.length === 2, qs[0].choices);
  t('a loosely-typed answer is matched and stored EXACTLY', qs[0].answer === 'Candidate key', qs[0].answer);
  t('flashcards deduped, blank/self-answering ones dropped', r.value.flashcards.length === 1, r.value.flashcards);
  t('all checks and no teaching is rejected',
    !!bd.validateLesson({ blocks: [GOOD.blocks[2]], flashcards: GOOD.flashcards }).error);
  t('no flashcards is rejected', !!bd.validateLesson({ blocks: GOOD.blocks, flashcards: [] }).error);
}

console.log('\nprompts');
{
  const all = [{ id: 'a', title: 'Keys', style: 'procedure', key_points: ['find the closure'], summary: 's', pages: '3' },
               { id: 'b', title: 'Joins' }];
  const p = bd.lessonPrompt({ className: 'CS 3410', sourceName: 'L4.pdf', topic: all[0], index: 0, all });
  t('the style decides the shape', p.includes(bd.STYLE_GUIDE.procedure));
  t('the checklist is in the prompt', p.includes('find the closure'));
  t('the other topics are named so they are not taught twice', p.includes('- Joins'));
  t('flashcard rules are in the prompt', /Complete coverage/.test(p));
  t('the topics prompt asks for full coverage', /Cover the whole document with no gaps/.test(bd.topicsPrompt({ sourceName: 'x' })));
}

console.log('\nmergeDocs');
{
  const a = { fileId: 'f', updatedAt: 10, listedAt: 1, topics: [
    { id: 't1', title: 'A', status: 'ready', updatedAt: 9 }, { id: 't2', title: 'B', status: 'pending', updatedAt: 1 }] };
  const b = { fileId: 'f', updatedAt: 12, listedAt: 1, topics: [
    { id: 't1', title: 'A', status: 'writing', updatedAt: 5 }, { id: 't2', title: 'B', status: 'ready', updatedAt: 11 }] };
  const m = bd.mergeDocs(a, b);
  t('each topic keeps its newest copy', m.topics[0].status === 'ready' && m.topics[1].status === 'ready', m.topics);
  const relisted = { fileId: 'f', updatedAt: 20, listedAt: 15, topics: [{ id: 't9', title: 'New', updatedAt: 20 }] };
  t('a re-listed breakdown drops the old run\'s topics', bd.mergeDocs(a, relisted).topics.map((x) => x.id).join() === 't9');
}

// ── A full run against a stubbed provider ─────────────────────────────────
console.log('\nrun — end to end');
ai.saveSettings({ provider: 'openai', keys: { openai: 'sk' }, models: { openai: 'm' }, baseUrl: { openai: 'https://x.test/v1' } });
const TOPICS = { topics: [
  { title: 'Keys', summary: 'Superkeys and candidate keys', style: 'definitions', key_points: ['superkey'], pages: '1-3' },
  { title: 'Joins', summary: 'Inner and outer joins', style: 'procedure', key_points: ['inner join'], pages: '4-6' },
] };
const lessonFor = (title) => ({
  blocks: [{ kind: 'read', title, markdown: `All about ${title}.`, steps: [], questions: [], points: [] }],
  flashcards: [{ front: `Define ${title}?`, back: `${title} explained.` }, { front: `Why ${title}?`, back: 'Because.' }],
});
let broke = false;
responder = (body) => {
  const text = body.messages.find((m) => m.role === 'user').content.map((p) => p.text || '').join('');
  if (/Break it into the TOPICS/.test(text)) return reply(TOPICS);
  if (/malformed|could not be used/.test(text)) return reply(lessonFor('Joins'));
  if (/title: Joins/.test(text) && !broke) { broke = true; return reply('{"blocks": [oops'); }
  const m = text.match(/title: (\w+)/);
  return reply(lessonFor(m ? m[1] : 'X'));
};
calls = [];
const doc = await bd.run('c1', 'm1', FILE);
t('the breakdown finished', doc.status === 'ready', { status: doc.status, error: doc.error });
t('two topics, both written', doc.topics.length === 2 && doc.topics.every((x) => x.status === 'ready'), doc.topics.map((x) => x.status));
t('topics keep the document\'s order', doc.topics.map((x) => x.title).join() === 'Keys,Joins');
t('1 topics call + 2 lessons + 1 repair', calls.length === 4, calls.length);
const fileParts = calls.map((c) => c.body.messages.find((m) => m.role === 'user').content.some((p) => p.type === 'file'));
t('every generation call carries the PDF (each is stand-alone)', fileParts.filter(Boolean).length === 3, fileParts);
t('the repair call does not', fileParts.filter((x) => !x).length === 1, fileParts);
const keysCards = deck.forClass('c1').filter((c) => c.sourceNoteId === bd.noteIdFor('f1', doc.topics[0].id));
t('flashcards landed in the review deck, per topic', keysCards.length === 2, deck.forClass('c1').map((c) => c.sourceNoteId));
t('cards belong to the source file\'s module', keysCards.every((c) => c.moduleId === 'm1'));
t('the whole document\'s cards are reachable by prefix', deck.byNotePrefix('c1', bd.notePrefixFor('f1')).length === 4);
t('card count recorded on the topic', doc.topics[0].cardCount === 2);
const lastSaved = docsSaved.filter((d) => d.path === 'studyos_topics/f1').pop();
t('synced to its OWN Firestore doc', !!lastSaved && lastSaved.payload.topics.length === 2, docsSaved.map((d) => d.path));
t('the synced doc holds the lessons', lastSaved.payload.topics[1].lesson.blocks[0].markdown === 'All about Joins.');
const lastSum = summaries.filter((s) => s.fileId === 'f1').pop();
t('the file gets a tiny summary for its row', lastSum && lastSum.s.status === 'ready' && lastSum.s.done === 2 && lastSum.s.total === 2, lastSum);
t('the summary is only written when it changes', summaries.length <= 6, summaries.map((s) => JSON.stringify(s.s)));

console.log('\nrun again — nothing is re-spent');
calls = [];
await bd.run('c1', 'm1', FILE);
t('a finished breakdown makes no requests', calls.length === 0, calls.length);

console.log('\nprogress');
bd.setProgress('f1', doc.topics[0].id, { block: 3, done: true });
t('progress is saved on the topic', bd.peek('f1').topics[0].progress.done === true);

console.log('\na bad key stops the run');
const FILE2 = { id: 'f2', name: 'L5.pdf', mime: 'application/pdf' };
classes[0].modules[0].files.push(FILE2);
calls = [];
responder = (body) => {
  const text = body.messages.find((m) => m.role === 'user').content.map((p) => p.text || '').join('');
  if (/Break it into the TOPICS/.test(text)) {
    return reply({ topics: ['A', 'B', 'C', 'D', 'E'].map((x) => ({ title: 'Topic ' + x, summary: '', style: 'concept', key_points: [], pages: '' })) });
  }
  return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
};
const d2 = await bd.run('c1', 'm1', FILE2);
t('the run is marked failed with the reason', d2.status === 'failed' && /key/i.test(d2.error), { s: d2.status, e: d2.error });
t('it stopped instead of trying every topic', calls.length <= 3, calls.length);

console.log('\nsetup problems never spend');
ai.saveSettings({ provider: 'openai', keys: { openai: '' } });
calls = [];
let threw = null;
try { await bd.run('c1', 'm1', { id: 'f3', name: 'x.pdf', mime: 'application/pdf' }); } catch (e) { threw = e; }
t('no key: refused with a setup error', threw && threw.kind === 'setup', threw && threw.message);
t('...before any request', calls.length === 0);
threw = null;
try { await bd.run('c1', 'm1', { id: 'f4', name: 'slides.pptx', mime: 'application/vnd.ms-powerpoint' }); } catch (e) { threw = e; }
t('a non-PDF is refused with a clear message', threw && /PDF/.test(threw.message), threw && threw.message);

console.log('\nremove');
ai.saveSettings({ provider: 'openai', keys: { openai: 'sk' } });
const before = deck.byNotePrefix('c1', bd.notePrefixFor('f1')).length;
await bd.remove('f1');
t('unreviewed cards are removed with the breakdown', before === 4 && deck.byNotePrefix('c1', bd.notePrefixFor('f1')).length === 0);
t('the doc is marked removed and emptied', bd.peek('f1').status === 'removed' && bd.peek('f1').topics.length === 0);
t('the file summary is cleared', summaries.filter((s) => s.fileId === 'f1').pop().s === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
