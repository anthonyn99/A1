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

console.log('\nfigures in a lesson');
{
  const fig = (page, svg = '', title = 'A figure') => ({ kind: 'figure', title, markdown: '', steps: [], questions: [], points: [], page, svg });
  const SVG = '<svg viewBox="0 0 10 10"><rect width="5" height="5" fill="#000"/><text x="1" y="9">CPU</text></svg>';
  const lesson = (...figs) => ({ blocks: [GOOD.blocks[0], ...figs, GOOD.blocks[4]], flashcards: GOOD.flashcards });
  const kept = (o, opts) => bd.validateLesson(o, opts).value.blocks.filter((b) => b.kind === 'figure');

  const pages = kept(lesson(fig(6), fig(9), fig('6'), fig(6, '', 'again')), { figurePages: [6], allowFigures: true });
  t('a figure page is kept; a non-figure page, a string page and a second copy are dropped',
    pages.length === 1 && pages[0].page === 6 && pages[0].title === 'A figure', pages);
  t('without allowFigures every figure is dropped (a gap follow-up adds none)',
    kept(lesson(fig(6), fig(0, SVG)), { figurePages: [6] }).length === 0 && kept(lesson(fig(6)), undefined).length === 0);

  const drawn = kept(lesson(fig(0, SVG)), { allowFigures: true });
  t('a clean drawing is kept, with an xmlns added', drawn.length === 1 && drawn[0].svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox'), drawn);
  for (const [name, bad] of [
    ['<script>', '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>'],
    ['an onload= handler', '<svg viewBox="0 0 1 1" onload="alert(1)"></svg>'],
    ['an outside <image>', '<svg viewBox="0 0 1 1"><image href="http://evil.test/x.png"/></svg>'],
    ['an outside href', '<svg viewBox="0 0 1 1"><a href="http://evil.test"><rect/></a></svg>'],
    ['<foreignObject>', '<svg viewBox="0 0 1 1"><foreignObject><div>x</div></foreignObject></svg>'],
    ['an outside url()', '<svg viewBox="0 0 1 1"><rect fill="url(http://evil.test/p)"/></svg>'],
    ['a non-SVG', '<div>not a drawing</div>'],
    ['an SVG over 12 KB', '<svg viewBox="0 0 1 1">' + '<rect/>'.repeat(2000) + '</svg>'],
  ]) t(`a drawing with ${name} is dropped`, kept(lesson(fig(0, bad)), { allowFigures: true }).length === 0);
  t('an internal reference (#id) is fine',
    kept(lesson(fig(0, '<svg viewBox="0 0 1 1"><defs><marker id="a"/></defs><path marker-end="url(#a)"/><use href="#a"/></svg>')), { allowFigures: true }).length === 1);
  t('at most 2 drawings', kept(lesson(fig(0, SVG), fig(0, SVG), fig(0, SVG)), { allowFigures: true }).length === 2);
  const redraw = kept(lesson(fig(9, SVG), fig(6, SVG)), { figurePages: [6], allowFigures: true });
  t('a drawing that claims a non-figure page keeps no page; one that redraws a figure page keeps it',
    redraw.length === 2 && redraw[0].page === 0 && redraw[1].page === 6, redraw);
  t('figures are not teaching: figures + checks alone are rejected',
    !!bd.validateLesson({ blocks: [fig(6), GOOD.blocks[2]], flashcards: GOOD.flashcards }, { figurePages: [6], allowFigures: true }).error);

  const base = [GOOD.blocks[0], { kind: 'recap', points: ['x'] }];
  const placed = bd.placeFigures(base, [3, 6]);
  t('a figure page the lesson did not show is added before the recap',
    placed.map((b) => b.kind + (b.page || '')).join() === 'read,figure3,figure6,recap', placed.map((b) => b.kind));
  t('a page the lesson shows is not added again',
    bd.placeFigures([fig(6), ...base], [6]).filter((b) => b.kind === 'figure').length === 1);
  t('a drawing that redraws page 6 covers it', bd.placeFigures([{ ...fig(6, SVG) }, ...base], [6]).filter((b) => b.kind === 'figure').length === 1);
  t('no figure pages, nothing added', bd.placeFigures(base, []) === base);
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
  t('without figure pages, a lesson may still draw — but is offered no page to show',
    /Draw a diagram/.test(p) && !/"page": a figure page/.test(p) && !/has a figure on page/.test(p));
  const pf = bd.lessonPrompt({ className: '', sourceName: 'L4.pdf', topic: all[0], index: 0, all, figurePages: [3, 6] });
  t('with figure pages, the lesson is told which pages to show or redraw',
    /"page": a figure page/.test(pf) && /has a figure on pages 3, 6 of this topic/.test(pf) && /the page you are redrawing/.test(pf));
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
try { await bd.run('c1', 'm1', { id: 'f4', name: 'essay.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }); } catch (e) { threw = e; }
t('a non-PDF, non-slides file is refused with a clear message', threw && /PDF/.test(threw.message), threw && threw.message);

console.log('\nslide decks go through the bridge as a PDF');
{
  const pipeline = await import(new URL('../js/modules/pipeline.js', import.meta.url).href);
  const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  t('.pptx / .ppt are breakable, a .docx is not',
    pipeline.isBreakable({ name: 'Ch 2.pptx', mime: PPTX }) && pipeline.isBreakable({ name: 'old.ppt', mime: '' })
    && !pipeline.isBreakable({ name: 'essay.docx', mime: '' }));
  t('a PDF is not treated as slides', !pipeline.isSlidesFile({ name: 'x.pdf', mime: 'application/pdf' }));

  ai.saveSettings({ provider: 'openai', keys: { openai: 'sk' }, models: { openai: 'm' }, baseUrl: { openai: 'https://x.test/v1' } });
  // No local bridge configured: refused before any request.
  calls = [];
  threw = null;
  const S1 = { id: 'fs1', name: 'Ch 2.pptx', mime: PPTX };
  classes[0].modules[0].files.push(S1);
  try { await bd.run('c1', 'm1', S1); } catch (e) { threw = e; }
  t('no bridge: a setup error naming the bridge', threw && threw.kind === 'setup' && /bridge/i.test(threw.message), threw && threw.message);
  t('...with no request at all', calls.length === 0, calls);

  const realFetch = globalThis.fetch;
  window.STUDYOS_CONFIG.cloudflare.ai.baseUrl = 'http://127.0.0.1:8781';
  const converts = [];
  let convertReply = () => new Response('%PDF-1.7 converted', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  globalThis.fetch = async (url, init = {}) => {
    if (/\/api\/convert\/pdf$/.test(String(url))) { converts.push(JSON.parse(init.body)); return convertReply(); }
    return realFetch(url, init);
  };
  try {
    // PowerPoint missing on this PC: the bridge's error, and nothing asked.
    convertReply = () => new Response(JSON.stringify({ ok: false, error: 'PowerPoint is not installed on this PC' }), { status: 422 });
    calls = []; threw = null;
    try { await bd.run('c1', 'm1', S1); } catch (e) { threw = e; }
    t('a failed conversion stops the run with the bridge\'s reason', threw && threw.kind === 'setup' && /PowerPoint/.test(threw.message), threw && threw.message);
    t('...before any model request', calls.length === 0, calls.length);
    t('...and the deck was sent to the bridge', converts.length === 1 && converts[0].sourceName === 'Ch 2.pptx' && converts[0].fileB64);

    // Converted: the model gets the PDF, named as one.
    convertReply = () => new Response('%PDF-1.7 converted', { status: 200 });
    calls = [];
    responder = () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
    const S2 = { id: 'fs2', name: 'Ch 3.pptx', mime: PPTX };
    classes[0].modules[0].files.push(S2);
    try { await bd.run('c1', 'm1', S2); } catch (e) { /* the key is rejected; the attachment is what is checked */ }
    const filePart = calls.length && calls[0].body.messages.find((m) => m.role === 'user').content.find((p) => p.type === 'file');
    t('the converted PDF is what the model receives', filePart && filePart.file.filename === 'Ch 3.pdf'
      && Buffer.from(filePart.file.file_data.split(',')[1], 'base64').toString() === '%PDF-1.7 converted', filePart && filePart.file.filename);
    const n = converts.length;
    await pipeline.pdfOf(S2);
    t('a second use of the same deck does not convert again', converts.length === n);
  } finally {
    globalThis.fetch = realFetch;
    delete window.STUDYOS_CONFIG.cloudflare.ai.baseUrl;
  }
}

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
  const userOf = (c) => c.body.messages.find((m) => m.role === 'user').content;
  const generation = calls.filter((c) => /Break it into the TOPICS|Write ONE lesson/.test(userText(c.body)));
  t('topic and lesson asks carry the PDF itself, as a file part after the text',
    generation.every((c) => Array.isArray(userOf(c)) && userOf(c)[0].type === 'text' && userOf(c)[1].type === 'file'
      && userOf(c)[1].file.filename === 'Chapter1-Introduction.pdf' && userOf(c)[1].file.file_data.startsWith('data:application/pdf;base64,')),
    generation.map((c) => (Array.isArray(userOf(c)) ? userOf(c).map((p) => p.type) : typeof userOf(c))));
  t('the gap-fill ask is one string: its lines are verbatim, no upload needed',
    calls.filter((c) => /leaves out the source lines below/.test(userText(c.body))).every((c) => typeof userOf(c) === 'string'));
  t('the prompt says the PDF is attached too', /the PDF itself is attached too/.test(userText(calls[0].body)));
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
    if (refuseImages && Array.isArray(user)) {  // no model that takes files or images is free
      return new Response(JSON.stringify({ error: { message: 'no eligible backend: input_modality:file', type: 'no_eligible_backend' } }), { status: 404 });
    }
    if (/Break it into the TOPICS/.test(text)) return reply({ topics: [...REAL.topics, { ...bd.fallbackTopics([7], M)[0] }] });
    return reply(echoLesson(text));
  };
  const d = await bd.run('c1', 'm1', F);
  const lessonCalls = calls.filter((c) => /Write ONE lesson/.test(userText(c.body)));
  const partsOf = (c) => c.body.messages.find((m) => m.role === 'user').content;
  const withImages = lessonCalls.filter((c) => partsOf(c).some((p) => p.type === 'image_url'));
  t('only the topics whose pages hold figures send images', withImages.length === 2, lessonCalls.map((c) => partsOf(c).map((p) => p.type)));
  const parts = withImages.map(partsOf);
  t('text, then the PDF, then one image part per figure page',
    parts.every((p) => p[0].type === 'text' && p[1].type === 'file' && p.slice(2).every((x) => x.type === 'image_url'))
      && parts.flat().filter((x) => x.type === 'image_url').length === 2, parts.map((p) => p.map((x) => x.type)));
  t('the image is the rendered page', parts.flat().some((x) => x.image_url && x.image_url.url === 'data:image/jpeg;base64,PAGE6'));
  t('the prompt names the attached figure pages', /FIGURES — page 6 is attached as an image/.test(userText(withImages.find((c) => /title: Units of speed/.test(userText(c.body))).body)));
  t('only figure pages are rendered, per topic', JSON.stringify(rendered) === '[[3],[6]]', rendered);
  t('a topic records which figures it saw', d.topics.find((x) => x.title.startsWith('Units')).figures.join() === '6');
  t('the topics ask sends no images (the text and the PDF list them fine)', !partsOf(calls[0]).some((p) => p.type === 'image_url'), partsOf(calls[0]).map((p) => p.type));
  t('every lesson records that it had the PDF', d.topics.every((x) => x.pdfSent === true) && d.checks.pdfMissed === 0 && d.checks.pdfSent.topics === true, d.checks);
  const figsOf = (x) => x.lesson.blocks.filter((b) => b.kind === 'figure').map((b) => b.page);
  t('a figure page the lesson left out is shown anyway, before the recap',
    figsOf(d.topics[0]).join() === '3' && figsOf(d.topics[1]).join() === '6'
      && d.topics[1].lesson.blocks.map((b) => b.kind).slice(-2).join() === 'figure,recap', d.topics.map((x) => x.lesson.blocks.map((b) => b.kind)));
  t('a topic with no figure pages gets none', figsOf(d.topics[2]).length === 0);
  t('the doc counts its figures', d.checks.figures === 2 && d.checks.drawn === 0, d.checks);

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
  t('...nor the PDF, anywhere', d2.checks.pdfSent.topics === false && d2.checks.pdfMissed === 3, d2.checks);
  t('each refused ask was retried once, as text', calls.filter((c) => typeof c.body.messages.find((m) => m.role === 'user').content === 'string'
    && /Break it into the TOPICS|Write ONE lesson/.test(userText(c.body))).length === 4, calls.length);
  t('...but its figures are still shown from the PDF', d2.checks.figures === 2, d2.checks);

  /* A provider that reads the PDF itself gets no images, but its lessons
   * show the document's figures all the same — and may draw their own. */
  console.log('\n...and with a provider that reads the PDF itself');
  ai.saveSettings({ provider: 'openai', keys: { openai: 'sk' }, models: { openai: 'm' }, baseUrl: { openai: 'https://x.test/v1' } });
  const F3 = { id: 'ch1fig3', name: 'Chapter1-Introduction.pdf', mime: 'application/pdf' };
  classes[0].modules[0].files.push(F3);
  calls = [];
  rendered.length = 0;
  refuseImages = false;
  const SVG = '<svg viewBox="0 0 100 40"><rect x="2" y="2" width="40" height="20" fill="none" stroke="#000"/><text x="5" y="15">CPU</text></svg>';
  const figBlock = (page, svg = '') => ({ kind: 'figure', title: 'The figure', markdown: '', steps: [], questions: [], points: [], page, svg });
  responder = (body) => {
    const text = userText(body);
    if (/Break it into the TOPICS/.test(text)) return reply({ topics: [...REAL.topics, { ...bd.fallbackTopics([7], M)[0] }] });
    const l = echoLesson(text);
    // Organization: shows a page that is no figure. Units: redraws page 6.
    // Fetch-decode: draws a figure of its own.
    if (/title: Computer organization/.test(text)) l.blocks.splice(1, 0, figBlock(9));
    else if (/title: Units/.test(text)) l.blocks.splice(1, 0, figBlock(6, SVG));
    else l.blocks.splice(1, 0, figBlock(0, SVG));
    return reply(l);
  };
  const d3 = await bd.run('c1', 'm1', F3);
  const lessonAsks = calls.filter((c) => /Write ONE lesson/.test(userText(c.body)));
  t('no images are sent or rendered', rendered.length === 0 && !lessonAsks.some((c) => partsOf(c).some((p) => p.type === 'image_url')));
  t('the prompt lists the topic\'s figure pages', /has a figure on page 3 of this topic/.test(userText(lessonAsks.find((c) => /title: Computer organization/.test(userText(c.body))).body)));
  const [org, un, fde] = d3.topics.map((x) => x.lesson.blocks.filter((b) => b.kind === 'figure'));
  t('a figure on a wrong page is dropped, and the right page is added', org.length === 1 && org[0].page === 3 && !org[0].svg, org);
  t('a drawing that redraws page 6 stands in for it', un.length === 1 && un[0].page === 6 && un[0].svg.includes('CPU'), un);
  t('a lesson with no figure pages may draw its own', fde.length === 1 && fde[0].page === 0 && fde[0].svg.startsWith('<svg xmlns='), fde);
  t('the doc counts both kinds', d3.checks.figures === 1 && d3.checks.drawn === 2, d3.checks);
  ai.saveSettings({ provider: 'orca', keys: { orca: 'orca_sk_test' }, models: { orca: '' }, baseUrl: { orca: 'https://orca.test/v1' } });
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
