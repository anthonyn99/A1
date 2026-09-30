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
// These runs predate the document checks: no page text, so none apply.
bd.setPageReader(async () => null);
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

// ── Checked against the document ──────────────────────────────────────────
/* The case this section exists for: Chapter1-Introduction.pdf (computer
 * architecture) came back as "Demand and Supply" / "Price Elasticity" —
 * ORCA's browser backend had delivered only the system prompt, and nothing
 * checked the answer against the PDF. The fixture is that chapter's slides. */
const L = (text, h = 22, bullet = true) => ({ text, h, bullet });
const T = (text) => ({ text, h: 36, bullet: false });
const CH1 = [
  { n: 1, lines: [T('Chapter 1 - Introduction'), L('1', 12, false)] },
  { n: 2, lines: [T('Chapter 1 Objectives'), L('Know the concentration of computer organization and'), L('computer architecture', 22, false),
    L('Understand units of measure common to computer systems'), L('Understand the computer as a layered system'),
    L('Be able to explain the von Neumann architecture and the'), L('function of basic computer components.', 22, false), L('2', 12, false)] },
  { n: 3, lines: [T('Computer Organization and'), T('Architecture'), L('Computer organization', 28),
    L('It focuses on the working mechanism of all physical'), L('aspects of computer systems', 22, false),
    L('e.g., circuit design, control signals, memory types, etc.', 18), L('Try to answer the question: How does a computer work?'),
    L('Computer architecture', 28), L('It focuses on the structure and behavior of the computer'),
    L('systems. It affects the logical execution of programs.', 22, false),
    L('e.g., instruction sets, instruction formats, data types,', 18), L('addressing modes, etc.', 18, false),
    L('Try to answer the question: How do I design a'), L('computer?', 22, false), L('3', 12, false)] },
  { n: 4, lines: [T('Chapter 1 Objectives'), L('Know the concentration of computer organization and'), L('computer architecture', 22, false),
    L('Understand units of measure common to computer systems'), L('Understand the computer as a layered system'),
    L('Be able to explain the von Neumann architecture and the'), L('function of basic computer components.', 22, false), L('4', 12, false)] },
  { n: 5, lines: [T('The Measures of Speed and'), T('Capacity'),
    L('Kilo- (K) = 1 thousand = 10^3 and 2^10'), L('Mega- (M) = 1 million = 10^6 and 2^20'), L('Giga- (G) = 1 billion = 10^9 and 2^30'),
    L('Whether a metric refers to a power of ten or a', 24, false), L('power of two typically depends upon what is', 24, false),
    L('being measured.', 24, false), L('5', 12, false)] },
  { n: 6, lines: [T("Measures of Speed and Capacity ('cont.)"), L('A CPU operates at 133MHz', 28),
    L('What’s the duration of one cycle (in sec.)?'), L('1/ (133,000,000 cycles/second) = 7.52ns/cycle', 20, false), L('6', 12, false)] },
  { n: 7, lines: [T('Summery: Fetch-decode-execute Cycle'),
    L('The Control Unit (CU) fetches the next instruction from memory. It uses Program Counter (PC) to determine where the instruction is located.'),
    L('The CU decodes the fetched instruction into a language that the ALU can understand.'),
    L('Any data operands required to execute the instruction are fetched from memory and placed into the registers within the CPU.'),
    L('The ALU executes the instruction and places results in either in the registers or the memory.'), L('7', 12, false)] },
  { n: 8, lines: [L('End of Chapter 1', 20, false), L('8', 12, false)] },
];
const ECON = { topics: [
  { title: 'Introduction to Demand and Supply', summary: 'How buyers and sellers set the market price.', style: 'concept',
    key_points: ['The demand curve slopes downward', 'Market equilibrium is where supply meets demand', 'Price determination in microeconomic markets'], pages: '1-3' },
  { title: 'Calculating Price Elasticity of Demand', summary: 'The midpoint formula.', style: 'procedure',
    key_points: ['Elasticity is the percentage change in quantity demanded over percentage change in price', 'Use the midpoint formula'], pages: '4-6' },
  { title: 'Key Microeconomic Terminology', summary: 'Terms.', style: 'definitions',
    key_points: ['Scarcity, opportunity cost, marginal utility', 'Consumer surplus and producer surplus'], pages: '7' },
] };
const REAL = { topics: [
  { title: 'Computer organization versus computer architecture', summary: 'The two concentrations.', style: 'definitions',
    key_points: ['Computer organization: the working mechanism of the physical aspects — circuit design, control signals, memory types',
      'Computer architecture: structure and behavior — instruction sets, instruction formats, data types, addressing modes'], pages: '3' },
  { title: 'Units of speed and capacity', summary: 'Prefixes, powers of ten and two, cycle time.', style: 'procedure',
    key_points: ['Kilo, Mega, Giga as powers of ten and powers of two', 'A CPU at 133MHz has a cycle time of 7.52ns'], pages: '5-6' },
  // no topic for page 7 — the fetch-decode-execute cycle
] };

console.log('\ntokens — a paraphrase matches, a different number does not');
{
  const a = bd.tokensOf('Kilo = 10³ and 2¹⁰; 1,048,576 bytes; seven levels; $10^{-3}$ and 10<sup>6</sup>');
  t('superscripts read as ^', a.nums.has('10^3') && a.nums.has('2^10') && a.nums.has('10^6'), [...a.nums]);
  t('a negative exponent survives LaTeX', a.nums.has('10^-3'), [...a.nums]);
  t('thousands separators are dropped', a.nums.has('1048576'), [...a.nums]);
  t('number words are numbers', a.nums.has('7'), [...a.nums]);
  t('plurals stem to one word', bd.tokensOf('computers').words.has('comput') && bd.tokensOf('computer').words.has('comput'));
  t('acronyms count', bd.tokensOf('the CPU and ALU').words.has('cpu') && bd.tokensOf('the CPU and ALU').words.has('alu'));
}

console.log('\nparsePages');
{
  t('ranges and singles', bd.parsePages('4-9, 12', 36).pages.join() === '4,5,6,7,8,9,12');
  t('an en dash and words', bd.parsePages('slides 4–6', 36).pages.join() === '4,5,6');
  t('past the end is bad', bd.parsePages('30-40', 36).bad === true);
  t('nothing is bad', bd.parsePages('', 36).bad === true);
  t('a fine range is not bad', bd.parsePages('3', 36).bad === false);
}

console.log('\nthe source model');
const M = bd.sourceModel(CH1);
{
  t('the title slide, the agenda slide (both showings) and the closing slide are not material',
    M.content.join() === '3,5,6,7', M.content);
  t('a repeated page is known as a repeat', M.dupOf.get(4) === 2);
  const withFig = bd.sourceModel([...CH1.slice(0, 7), { n: 8, lines: [T('Computer Organization and Architecture'), L('8', 12, false)], figure: true }]);
  t('a slide that is only a title and a diagram is material', withFig.content.includes(8), withFig.content);
  const items = bd.pageItems(CH1[2]);
  t('wrapped lines join their bullet', items.some((i) => i.text === 'It focuses on the working mechanism of all physical aspects of computer systems'), items.map((i) => i.text));
  t('the slide title is flagged', items[0].title === true && items[0].text === 'Computer Organization and');
  t('the page number is not an item', !items.some((i) => i.text === '3'));
  const src = bd.sourceText(M, [4, 5]);
  t('source text is marked by page', src.includes('--- page 5 ---') && src.includes('Kilo- (K) = 1 thousand = 10^3 and 2^10'), src);
  t('a repeated page is named, not repeated', src.includes('--- page 4 --- (same as page 2)'));
}

console.log('\ngroundTopics');
{
  const g = bd.groundTopics(bd.validateTopics(ECON).value.topics, M);
  t('an invented course is caught — every topic', g.invented.length === 3, g.invented.map((x) => x.title));
  t('the feedback names them', /not in the document at all/.test(g.feedback) && g.feedback.includes('Demand and Supply'));
  const r = bd.groundTopics(bd.validateTopics(REAL).value.topics, M);
  t('real topics pass, even paraphrased', r.invented.length === 0, r);
  t('the page no topic covers is found', r.uncovered.join() === '7', r.uncovered);
  const bad = bd.groundTopics([{ ...REAL.topics[0], pages: '40-44' }], M);
  t('impossible pages are caught', bad.badPages.length === 1 && /impossible page numbers/.test(bad.feedback));
  const add = bd.fallbackTopics([7], M);
  t('an uncovered page becomes its own topic, named by its title', add.length === 1 && add[0].title === 'Summery: Fetch-decode-execute Cycle' && add[0].pages === '7', add);
  t('...holding every line of the page as its checklist', add[0].key_points.length === 4 && add[0].key_points[1].startsWith('The CU decodes'), add[0].key_points);
  t('adjacent uncovered pages make one topic', bd.fallbackTopics([5, 6], M).length === 1 && bd.fallbackTopics([5, 6], M)[0].title === 'The Measures of Speed and');
}

console.log('\nitemMissing');
{
  const item = { page: 6, text: '1/ (133,000,000 cycles/second) = 7.52ns/cycle', title: false };
  t('a lesson without the number misses the line', bd.itemMissing(item, bd.tokensOf('A cycle is short: about seven nanoseconds.')));
  t('a lesson with it covers the line', !bd.itemMissing(item, bd.tokensOf('One cycle takes 1 / 133,000,000 cycles per second = 7.52 ns per cycle.')));
  const k = { page: 5, text: 'Kilo- (K) = 1 thousand = 10^3 and 2^10', title: false };
  t('10³ in a lesson covers 10^3 in the source', !bd.itemMissing(k, bd.tokensOf('**Kilo (K)** means one thousand: 10³ in decimal, 2¹⁰ in binary.')));
  t('a title is never a gap', !bd.itemMissing({ page: 3, text: 'Architecture', title: true }, bd.tokensOf('')));
}

// ── End to end, through ORCA ──────────────────────────────────────────────
/* The stub's lessons echo their <source> section — a model that read it —
 * minus any line matching `drop`, so a gap is exactly what the test says. */
const sourceOfPrompt = (text) => {
  const m = text.match(/<source>\n([\s\S]*?)\n<\/source>/);
  return m ? m[1].split('\n').filter((l) => l && !l.startsWith('---')).map((l) => l.replace(/^- /, '')) : [];
};
const echoLesson = (text, drop) => {
  const lines = sourceOfPrompt(text).filter((l) => !(drop && drop.test(l)));
  return {
    blocks: [{ kind: 'read', title: 'The material', markdown: lines.join('\n\n'), steps: [], questions: [], points: [] },
      { kind: 'recap', title: 'Recap', markdown: '', steps: [], questions: [], points: ['Know it.'] }],
    flashcards: lines.slice(0, 3).map((l, i) => ({ front: `Question ${i} about the slide?`, back: l.slice(0, 200) })),
  };
};
const userText = (body) => {
  const c = body.messages.find((m) => m.role === 'user').content;
  return typeof c === 'string' ? c : c.map((p) => p.text || '').join('');
};
const CH1_FILE = { id: 'ch1', name: 'Chapter1-Introduction.pdf', mime: 'application/pdf' };
classes[0].modules[0].files.push(CH1_FILE);
bd.setPageReader(async () => CH1);
ai.saveSettings({ provider: 'orca', keys: { orca: 'orca_sk_test' }, models: { orca: '' }, baseUrl: { orca: 'https://orca.test/v1' } });

console.log('\nrun — invented topics are rejected, then the real list is used');
{
  calls = [];
  let topicAsks = 0;
  responder = (body) => {
    const text = userText(body);
    if (/Break it into the TOPICS/.test(text)) return reply(topicAsks++ === 0 ? ECON : REAL);
    if (/leaves out the source lines below/.test(text)) {
      const missing = [...text.matchAll(/\[page \d+\] (.*)/g)].map((m) => m[1]);
      return reply({ blocks: [{ kind: 'example', title: 'Cycle time', markdown: missing.join('\n\n'), steps: [], questions: [], points: [] }],
        flashcards: [{ front: 'How long is one cycle at 133MHz?', back: '1/(133,000,000 cycles/second) = 7.52ns/cycle.' }] });
    }
    // The units lesson leaves out the cycle-time lines.
    return reply(echoLesson(text, /133|cycle/i));
  };
  const d = await bd.run('c1', 'm1', CH1_FILE);
  const asks = calls.map((c) => userText(c.body));
  t('ORCA gets ONE string, never content parts', calls.every((c) => typeof c.body.messages.find((m) => m.role === 'user').content === 'string'),
    calls.map((c) => typeof c.body.messages.find((m) => m.role === 'user').content));
  t('the topics ask carries the document, page by page', asks[0].includes('--- page 5 ---') && asks[0].includes('Kilo- (K) = 1 thousand = 10^3 and 2^10'));
  t('...and not twice (no separate extracted copy)', asks[0].split('--- page 5 ---').length === 2);
  t('an invented list is asked for again, saying why', topicAsks === 2 && /PREVIOUS LIST WAS REJECTED/.test(asks[1]) && asks[1].includes('Demand and Supply'), asks[1] && asks[1].slice(0, 200));
  t('the breakdown finished', d.status === 'ready', { status: d.status, error: d.error, topics: d.topics.map((x) => [x.title, x.status, x.error]) });
  t('no invented topic survived', !d.topics.some((x) => /Demand|Elasticity|Microeconomic/.test(x.title)), d.topics.map((x) => x.title));
  t('the page the model skipped got its own topic, in document order',
    d.topics.map((x) => x.title).join(' | ') === 'Computer organization versus computer architecture | Units of speed and capacity | Summery: Fetch-decode-execute Cycle',
    d.topics.map((x) => x.title));
  const lessonAsk = asks.find((a) => /title: Units of speed and capacity/.test(a));
  t('a lesson ask carries its pages verbatim', !!lessonAsk && lessonAsk.includes('SOURCE —') && lessonAsk.includes('7.52ns/cycle'), lessonAsk && lessonAsk.slice(0, 300));
  t('...and only its pages', !!lessonAsk && !lessonAsk.includes('--- page 3 ---'));
  const gapAsk = asks.find((a) => /leaves out the source lines below/.test(a));
  t('the lines a lesson left out are asked for, verbatim', !!gapAsk && gapAsk.includes('[page 6] 1/ (133,000,000 cycles/second) = 7.52ns/cycle'), gapAsk && gapAsk.slice(0, 400));
  t('only the topic that left lines out gets a follow-up', asks.filter((a) => /leaves out the source lines below/.test(a)).length === 1);
  const units = d.topics[1];
  t('the extra blocks go in before the recap', units.lesson.blocks.map((b) => b.kind).join() === 'read,example,recap', units.lesson.blocks.map((b) => b.kind));
  t('nothing is left untaught', d.topics.every((x) => x.gapChecked && x.gaps.length === 0), d.topics.map((x) => x.gaps));
  const cardsNow = deck.forClass('c1').filter((c) => c.sourceNoteId === bd.noteIdFor('ch1', units.id));
  t('the follow-up\'s cards join the topic\'s, none lost', cardsNow.length === 4 && units.cardCount === 4, cardsNow.map((c) => c.q));
  t('the checks are recorded', d.checks && d.checks.pages === 8 && d.checks.content === 4 && d.checks.gaps === 0 && d.checks.added === 1, d.checks);
  t('1 + 1 topic asks, 3 lessons, 1 follow-up', calls.length === 6, calls.length);
}

console.log('\nrun — a model that never saw the document saves nothing');
{
  const F = { id: 'ch1b', name: 'Chapter1-Introduction.pdf', mime: 'application/pdf' };
  classes[0].modules[0].files.push(F);
  calls = [];
  responder = () => reply(ECON);
  let threw = null;
  try { await bd.run('c1', 'm1', F); } catch (e) { threw = e; }
  t('the run fails, saying the topics do not match', threw && threw.kind === 'ungrounded' && /don't match this document/.test(threw.message), threw && threw.message);
  t('asked twice, then stopped', calls.length === 2, calls.length);
  t('no topics were saved', bd.peek('ch1b').topics.length === 0 && bd.peek('ch1b').status === 'failed');
  t('no cards were added', deck.byNotePrefix('c1', bd.notePrefixFor('ch1b')).length === 0);
}

console.log('\nrun — an invented lesson is not saved');
{
  const F = { id: 'ch1c', name: 'Chapter1-Introduction.pdf', mime: 'application/pdf' };
  classes[0].modules[0].files.push(F);
  calls = [];
  responder = (body) => {
    const text = userText(body);
    if (/Break it into the TOPICS/.test(text)) return reply({ topics: [REAL.topics[0]] });
    return reply({ blocks: [{ kind: 'read', title: 'Supply and demand', markdown: 'Buyers and sellers meet at the market equilibrium price, where quantity supplied equals quantity demanded.', steps: [], questions: [], points: [] }],
      flashcards: [{ front: 'What is market equilibrium?', back: 'Where supply meets demand.' }] });
  };
  const d = await bd.run('c1', 'm1', F);
  const org = d.topics.find((x) => x.title.startsWith('Computer organization'));
  t('the topic fails, naming its pages', org.status === 'failed' && /does not match page 3/.test(org.error), org.error);
  t('its cards were not added', deck.byNotePrefix('c1', bd.noteIdFor('ch1c', org.id)).length === 0);
}

// ── Figures: ORCA's models read text, so slides' pictures go as images ────
/* ORCA now takes standard image parts (its browser models attach them). A
 * figure page in a topic's span is rendered and sent with that lesson's ask;
 * when no image-capable model is free (ORCA answers 404 no_eligible_backend)
 * the lesson is written from the text instead of failing. */
console.log('\nfigures ride along with ORCA lesson asks');
{
  const FIG = CH1.map((p) => (p.n === 3 || p.n === 6 ? { ...p, figure: true } : p));
  bd.setPageReader(async () => FIG);
  const rendered = [];
  bd.setPageRenderer(async (b64, nums) => { rendered.push(nums); return nums.map((n) => ({ n, url: `data:image/jpeg;base64,PAGE${n}` })); });
  ai.saveSettings({ provider: 'orca', keys: { orca: 'orca_sk_test' }, models: { orca: '' }, baseUrl: { orca: 'https://orca.test/v1' } });
  const F = { id: 'ch1fig', name: 'Chapter1-Introduction.pdf', mime: 'application/pdf' };
  classes[0].modules[0].files.push(F);
  calls = [];
  let refuseImages = false;
  responder = (body) => {
    const user = body.messages.find((m) => m.role === 'user').content;
    const text = userText(body);
    if (/Break it into the TOPICS/.test(text)) return reply({ topics: [...REAL.topics, { ...bd.fallbackTopics([7], M)[0] }] });
    if (refuseImages && Array.isArray(user)) {
      return new Response(JSON.stringify({ error: { message: 'no eligible backend: input_modality:image', type: 'no_eligible_backend' } }), { status: 404 });
    }
    return reply(echoLesson(text));
  };
  const d = await bd.run('c1', 'm1', F);
  const lessonCalls = calls.filter((c) => /Write ONE lesson/.test(userText(c.body)));
  const withImages = lessonCalls.filter((c) => Array.isArray(c.body.messages.find((m) => m.role === 'user').content));
  t('only the topics whose pages hold figures send images', withImages.length === 2, lessonCalls.map((c) => typeof c.body.messages.find((m) => m.role === 'user').content));
  const parts = withImages.map((c) => c.body.messages.find((m) => m.role === 'user').content);
  t('text first, then one image part per figure page',
    parts.every((p) => p[0].type === 'text' && p.slice(1).every((x) => x.type === 'image_url')) && parts.flat().filter((x) => x.type === 'image_url').length === 2, parts.map((p) => p.map((x) => x.type)));
  t('the image is the rendered page', parts.flat().some((x) => x.image_url && x.image_url.url === 'data:image/jpeg;base64,PAGE6'));
  t('the prompt names the attached figure pages', /FIGURES — page 6 is attached as an image/.test(userText(withImages.find((c) => /title: Units of speed/.test(userText(c.body))).body)));
  t('only figure pages are rendered, per topic', JSON.stringify(rendered) === '[[3],[6]]', rendered);
  t('a topic records which figures it saw', d.topics.find((x) => x.title.startsWith('Units')).figures.join() === '6');
  t('the topics ask sends no images (the text lists them fine)', typeof calls[0].body.messages.find((m) => m.role === 'user').content === 'string');

  console.log('\n...and when no image-capable model is free');
  const F2 = { id: 'ch1fig2', name: 'Chapter1-Introduction.pdf', mime: 'application/pdf' };
  classes[0].modules[0].files.push(F2);
  calls = [];
  refuseImages = true;
  const d2 = await bd.run('c1', 'm1', F2);
  t('the breakdown still finishes', d2.status === 'ready', { s: d2.status, e: d2.error, t: d2.topics.map((x) => [x.title, x.status, x.error]) });
  const units = d2.topics.find((x) => x.title.startsWith('Units'));
  t('the lesson was written from the text instead', units.status === 'ready' && units.figures.length === 0 && units.figuresSkipped.join() === '6', units);
  t('the doc says figures were not seen', d2.checks.figuresSkipped === 2, d2.checks);
  bd.setPageRenderer(null);
  bd.setPageReader(async () => null);
}

console.log('\na PDF with no text');
{
  bd.setPageReader(async () => [{ n: 1, lines: [] }]);
  let threw = null;
  try { await bd.run('c1', 'm1', { id: 'scan', name: 'scan.pdf', mime: 'application/pdf' }); } catch (e) { threw = e; }
  t('ORCA (text only) refuses a scan clearly', threw && threw.kind === 'bad_input' && /no selectable text/.test(threw.message), threw && threw.message);
  ai.saveSettings({ provider: 'openai', keys: { openai: 'sk' }, models: { openai: 'm' }, baseUrl: { openai: 'https://x.test/v1' } });
  calls = [];
  responder = (body) => reply(/Break it into the TOPICS/.test(userText(body)) ? TOPICS : lessonFor('Keys'));
  const d = await bd.run('c1', 'm1', { id: 'scan2', name: 'scan.pdf', mime: 'application/pdf' });
  t('a provider that reads the PDF runs unchecked, and says so', d.status === 'ready' && d.checks && /no selectable text/.test(d.checks.skipped), d.checks);
  bd.setPageReader(async () => null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
