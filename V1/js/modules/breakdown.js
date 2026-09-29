/* ============================================================================
 * StudyOS — topic breakdown  (topics → lessons → flashcards)
 * ============================================================================
 * One click on a document:
 *   1. ONE call lists the document's topics, covering all of it, in order.
 *   2. ONE call per topic writes its lesson and its flashcards.
 * Each topic is saved the moment it is written, so a closed tab loses at most
 * the topic in flight, and resume() picks the rest up at the next boot.
 *
 * The lesson format is SOLO-LEVELING's (worker/src/tutor.ts): an ordered list
 * of typed blocks, whose MIX adapts to the topic. SOLO picked the mix from a
 * stat's category; here the topic call labels each topic's `style` itself.
 *
 * ── STORAGE ───────────────────────────────────────────────────────────────
 *   studyos_topics/{fileId}   Firestore, one doc per source document, via
 *                             _fbSaveDoc/_fbLoadDoc. NOT the main StudyOS doc:
 *                             lessons are ~20 KB each, and that doc is one
 *                             whole-document write capped at 1 MB.
 *   IndexedDB sos_topics      the local copy — localStorage on this origin
 *                             is known to be full.
 *   FileEntry.study           a tiny summary on the file itself ({status,
 *                             done, total}) so a module's file list can show
 *                             "12 topics" without loading twelve lessons.
 *                             `study`, not `_study`: underscore keys are
 *                             stripped on save.
 *   Flashcards                the existing FSRS deck (deck.addExternal), under
 *                             noteId 'topic_<fileId>_<topicId>' — so they show
 *                             in Cards Due and every review, like any card.
 * ------------------------------------------------------------------------- */

import * as ai from './ai.js';
import * as deck from './deck.js';
import * as fsrs from './fsrs.js';
import * as pipeline from './pipeline.js';
import { store } from './store.js';

export const STYLES = ['concept', 'procedure', 'applied', 'definitions'];
export const KINDS = ['read', 'example', 'steps', 'check', 'recap'];
const MAX_TOPICS = 15;
const MAX_BLOCKS = 16;
const MAX_QUESTIONS = 6;
const DOC_LIMIT = 900 * 1024;       // Firestore's hard cap is 1 MiB per doc

export const noteIdFor = (fileId, topicId) => `topic_${fileId}_${topicId}`;
export const notePrefixFor = (fileId) => `topic_${fileId}_`;

// ── Schemas (JSON Schema; every provider gets the same one) ──────────────
/* Flat on purpose: a block carries EVERY field, and the unused ones are
 * empty. A oneOf-per-kind schema is what the shape "really" is, but strict
 * JSON-schema modes (OpenAI's, Anthropic's) handle a flat object everywhere,
 * and the validator below ignores the fields a kind does not use. */
const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });

export const TOPICS_SCHEMA = obj({
  topics: { type: 'array', items: obj({
    title: str, summary: str,
    style: { type: 'string', enum: STYLES },
    key_points: strArr, pages: str,
  }) },
});

export const LESSON_SCHEMA = obj({
  blocks: { type: 'array', items: obj({
    kind: { type: 'string', enum: KINDS },
    title: str,
    markdown: str,
    steps: { type: 'array', items: obj({ title: str, body: str }) },
    questions: { type: 'array', items: obj({
      q: str, choices: strArr, answer: str, explanation: str,
    }) },
    points: strArr,
  }) },
  flashcards: { type: 'array', items: obj({ front: str, back: str }) },
});

// ── Prompts ──────────────────────────────────────────────────────────────
const SYSTEM =
  'You are an expert university tutor. You turn course material into study ' +
  'material that is complete — nothing examinable left out — and easy to ' +
  'understand. You write in plain, direct language for a student who is ' +
  'seeing the material for the first time, and you stay faithful to the ' +
  'document: its notation, its terms, its examples.';

export function topicsPrompt({ className, sourceName }) {
  return `The attached PDF is course material${className ? ` for ${className}` : ''}: "${sourceName}".

Break it into the TOPICS a student must learn, so that studying every topic covers the ENTIRE document.

RULES
- Cover the whole document with no gaps, in the order it presents the material. Every section, definition, formula, algorithm and worked example belongs to exactly one topic.
- 3 to ${MAX_TOPICS} topics. Each topic is one sitting of study (10-25 minutes): big enough to be worth a lesson, small enough to master in one go. Split a long chapter; merge slides that only make sense together.
- Titles are concrete and specific. "Converting an ER diagram to tables" is a topic; "Databases" is not.
- summary: one or two sentences saying exactly what the topic covers.
- key_points: EVERY fact, definition, formula, rule and procedure this topic must teach. The lesson is written against this checklist, so leave nothing out.
- pages: where it is in the document, e.g. "4-9" (slide or page numbers).
- style: what kind of learning the topic needs —
    concept      ideas and theory to understand: why and how things work
    procedure    a method, algorithm or calculation to carry out step by step
    applied      using knowledge on realistic problems or scenarios
    definitions  a set of terms and distinctions to get exactly right
- Skip course logistics (syllabus, grading, office hours) unless that is the whole document.

Reply with ONE JSON object and nothing else:
{"topics": [{"title": "...", "summary": "...", "style": "concept", "key_points": ["..."], "pages": "1-4"}]}`;
}

export const STYLE_GUIDE = {
  concept:
    'This topic is CONCEPTUAL. Build real understanding: two or more `read` blocks that build on each ' +
    'other (the intuition first, then the precise version, then the edge cases), an `example` that makes ' +
    'it concrete, a `check` of 3-5 questions on understanding, then a `recap`.',
  procedure:
    'This topic is a PROCEDURE. Teach the method so they can DO it: a short `read` on what it is for and ' +
    'when to use it, a `steps` block that walks through the method one step at a time, a fully worked ' +
    '`example` with real values showing every intermediate result, a second harder `example` if the ' +
    'method has cases, a `check` of application questions, then a `recap`.',
  applied:
    'This topic is APPLIED. Lead with the problem: an `example` scenario first, then a `read` explaining ' +
    'the principle behind it and why it works, another `example` that varies the situation, a `check` of ' +
    'scenario questions, then a `recap`.',
  definitions:
    'This topic is about DEFINITIONS and distinctions. A `read` that defines each term precisely in plain ' +
    'words, a markdown comparison table wherever terms are easily confused, an `example` showing each in ' +
    'use, a `check` that tests the distinctions, then a `recap`.',
};

export function lessonPrompt({ className, sourceName, topic, index, all }) {
  const others = all.filter((t) => t.id !== topic.id).map((t) => `  - ${t.title}`).join('\n');
  const checklist = (topic.key_points || []).map((k) => `  - ${k}`).join('\n') || '  - (use the summary)';
  return `Write ONE lesson from the attached course material${className ? ` for a student in ${className}` : ''}.

THE TOPIC
  title: ${topic.title}
  what it covers: ${topic.summary || '(use the title)'}
  where: ${topic.pages ? `pages/slides ${topic.pages} of` : 'in'} "${sourceName}"
  it is topic ${index + 1} of ${all.length}. The others are taught in their own lessons — do not teach them here:
${others || '  (none)'}

THE CHECKLIST — the lesson must teach every one of these:
${checklist}

HOW TO SHAPE IT
${STYLE_GUIDE[topic.style] || STYLE_GUIDE.concept}

BLOCK TYPES — the lesson is an ordered list of these, at most ${MAX_BLOCKS}:
  read     "markdown": the explanation itself
  example  "markdown": a worked example or concrete scenario, step by step, with real values
  steps    "steps": [{"title", "body"}] — a procedure walked through one step at a time
  check    "questions": 3-5 multiple-choice checks (shape below)
  recap    "points": the key takeaways, one line each
Every block has a short "title". Fields a block's kind does not use are empty ("" or []).

CHECK QUESTIONS — every one is multiple choice:
  {"q": "...", "choices": ["...", "...", "...", "..."], "answer": "<exactly one of the choices>",
   "explanation": "why it is right, and why the most tempting wrong choice is wrong"}
Give 3-5 choices, all plausible — never throwaway options. Test understanding and application, not trivia.
Never test anything the lesson did not teach.

WRITING RULES
- Thorough: teach EVERY checklist item and every detail on those pages a student could be examined on —
  definitions, formulas, conditions, exceptions, edge cases. Do not summarise detail away.
- Clear and simple: plain words, short sentences and paragraphs. Define every term the first time it
  appears. Explain WHY, not only what. Build from what the student already knows.
- Use the document's own notation and terminology so the lesson matches the course.
- Markdown bodies may use ### headings, **bold**, lists, \`code\`, fenced code blocks and tables.
  Put formulas, SQL and code in code formatting.
- Write to the reader as "you". No filler, no "in today's world", no restating the title.
- Finish with a recap block.

FLASHCARDS — then write this topic's flashcards:
- Complete coverage: one card for every definition, fact, formula, rule, step, distinction and
  cause-and-effect in the lesson. A student who knows every card knows the topic.
- Atomic: one idea per card. Front: a specific question (never just "Explain X"). Back: the answer,
  at most two sentences.
- No duplicates, no yes/no fronts, no card whose answer is on its front.

Reply with ONE JSON object and nothing else:
{"blocks": [{"kind": "read", "title": "...", "markdown": "...", "steps": [], "questions": [], "points": []}],
 "flashcards": [{"front": "...", "back": "..."}]}`;
}

// ── Validation (the model's output is untrusted) ─────────────────────────
const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const arr = (v) => (Array.isArray(v) ? v : []);

export function validateTopics(o) {
  const topics = [];
  for (const t of arr(o && o.topics).slice(0, MAX_TOPICS + 5)) {
    const title = s(t && t.title, 160);
    if (!title) continue;
    const style = STYLES.includes(t.style) ? t.style : 'concept';
    topics.push({
      title, style,
      summary: s(t.summary, 600),
      key_points: arr(t.key_points).map((k) => s(k, 400)).filter(Boolean).slice(0, 40),
      pages: s(t.pages, 40),
    });
  }
  if (!topics.length) return { error: 'no topics were listed' };
  return { value: { topics: topics.slice(0, MAX_TOPICS) } };
}

export function validateQuestions(list) {
  const out = [];
  for (const q of arr(list)) {
    const stem = s(q && (q.q || q.question || q.prompt), 500);
    const choices = [...new Set(arr(q && q.choices).map((c) => s(c, 240)).filter(Boolean))].slice(0, 6);
    if (!stem || choices.length < 2) continue;
    // The answer must BE one of the choices. Matched loosely (case, spacing),
    // then stored as the choice's exact text so grading is a plain ===.
    const want = s(q.answer, 240).toLowerCase().replace(/\s+/g, ' ');
    const answer = choices.find((c) => c.toLowerCase().replace(/\s+/g, ' ') === want);
    if (!answer) continue;
    out.push({ q: stem, choices, answer, explanation: s(q.explanation, 1200) });
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

export function validateLesson(o) {
  const blocks = [];
  for (const b of arr(o && o.blocks)) {
    if (!b || !KINDS.includes(b.kind)) continue;
    const base = { kind: b.kind, title: s(b.title, 140) };
    if (b.kind === 'read' || b.kind === 'example') {
      const markdown = s(b.markdown, 24000);
      if (markdown) blocks.push({ ...base, markdown });
    } else if (b.kind === 'steps') {
      const steps = arr(b.steps).map((x) => ({ title: s(x && x.title, 200), body: s(x && x.body, 6000) }))
        .filter((x) => x.title || x.body).slice(0, 24);
      if (steps.length) blocks.push({ ...base, steps });
    } else if (b.kind === 'check') {
      const questions = validateQuestions(b.questions);
      if (questions.length) blocks.push({ ...base, questions });
    } else if (b.kind === 'recap') {
      const points = arr(b.points).map((p) => s(p, 500)).filter(Boolean).slice(0, 24);
      if (points.length) blocks.push({ ...base, points });
    }
    if (blocks.length >= MAX_BLOCKS) break;
  }
  if (!blocks.length) return { error: 'the lesson had no usable blocks' };
  // "All quiz and no teaching" — SOLO's rule. A lesson must explain something.
  if (!blocks.some((b) => b.kind === 'read' || b.kind === 'example' || b.kind === 'steps')) {
    return { error: 'the lesson had checks but no teaching' };
  }
  const seen = new Set();
  const flashcards = [];
  for (const c of arr(o && o.flashcards)) {
    const front = s(c && c.front, 400), back = s(c && c.back, 800);
    const key = front.toLowerCase();
    if (!front || !back || seen.has(key) || front.toLowerCase() === back.toLowerCase()) continue;
    seen.add(key);
    flashcards.push({ front, back });
  }
  if (!flashcards.length) return { error: 'the lesson came with no flashcards' };
  return { value: { blocks, flashcards } };
}

// ── Store ────────────────────────────────────────────────────────────────
const _mem = new Map();          // fileId -> doc
const pathOf = (fileId) => 'studyos_topics/' + fileId;

function emit(fileId) {
  try { window.dispatchEvent(new CustomEvent('sos-breakdown', { detail: { fileId } })); } catch (e) {}
}

/* IndexedDB, its own database: sos_file_store's open() rejects on `blocked`,
 * so adding a store there would mean a version bump that breaks every file
 * read while a second tab is open. */
let _idb = null;
function idb() {
  if (_idb) return _idb;
  _idb = new Promise((resolve) => {
    try {
      const r = indexedDB.open('sos_topics', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'fileId' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
  return _idb;
}
async function idbGet(fileId) {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const q = db.transaction('docs').objectStore('docs').get(fileId);
      q.onsuccess = () => resolve(q.result || null);
      q.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
async function idbPut(doc) {
  const db = await idb();
  if (!db) return;
  try { db.transaction('docs', 'readwrite').objectStore('docs').put(doc); } catch (e) {}
}

/** Newest wins per TOPIC, not per document: two devices can each finish a
 *  different topic of the same breakdown, and both must survive. */
export function mergeDocs(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const newer = (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
  const byId = new Map();
  for (const t of [...(a.topics || []), ...(b.topics || [])]) {
    const prev = byId.get(t.id);
    if (!prev || (t.updatedAt || 0) > (prev.updatedAt || 0)) byId.set(t.id, t);
  }
  // Topic ORDER is the document's order: take it from the newer doc's list.
  const order = (newer.topics || []).map((t) => t.id);
  const rest = [...byId.keys()].filter((id) => !order.includes(id));
  // A doc whose topic list was REPLACED (a re-run) must not resurrect the old
  // run's topics: keep only the newer doc's ids when it re-listed.
  const ids = newer.listedAt && newer.listedAt >= ((newer === a ? b : a).listedAt || 0) ? order : [...order, ...rest];
  return { ...newer, topics: ids.map((id) => byId.get(id)).filter(Boolean) };
}

export async function load(fileId) {
  if (!fileId) return null;
  // Once loaded, memory IS current: _fbLoadDoc starts a snapshot listener,
  // and every remote change arrives through fb-doc-remote below. Reading
  // Firestore again on each repaint would be a read per save during a run.
  if (_mem.has(fileId)) return _mem.get(fileId);
  let doc = await idbGet(fileId);
  if (typeof window._fbLoadDoc === 'function') {
    const remote = await window._fbLoadDoc(pathOf(fileId)).catch(() => null);
    if (remote && remote.fileId) doc = mergeDocs(doc, remote);
  }
  if (doc) { _mem.set(fileId, doc); idbPut(doc); }
  return doc;
}

export const peek = (fileId) => _mem.get(fileId) || null;

function save(doc) {
  doc.updatedAt = Date.now();
  _mem.set(doc.fileId, doc);
  idbPut(doc);
  const size = JSON.stringify(doc).length;
  if (size > DOC_LIMIT) {
    // Kept locally, but it cannot sync. Say so rather than letting Firestore
    // reject every write with nothing on screen.
    console.warn('[breakdown] too large to sync:', doc.fileId, size);
    doc.syncError = 'This breakdown is too large to sync to your other devices.';
  } else {
    delete doc.syncError;
    if (typeof window._fbSaveDoc === 'function') window._fbSaveDoc(pathOf(doc.fileId), doc);
  }
  summarise(doc);
  emit(doc.fileId);
}

/** The tiny FileEntry.study summary, written only when it CHANGES — every
 *  write of it is a whole-document save of the main StudyOS doc. */
function summarise(doc) {
  const B = window._sosBridge;
  if (!B || typeof B.setFileStudy !== 'function') return;
  const total = (doc.topics || []).length;
  const done = (doc.topics || []).filter((t) => t.status === 'ready').length;
  const next = doc.status === 'removed' ? null : { status: doc.status, done, total };
  const key = JSON.stringify(next);
  if (summarise._last && summarise._last[doc.fileId] === key) return;
  (summarise._last || (summarise._last = {}))[doc.fileId] = key;
  B.setFileStudy(doc.classId, doc.moduleId, doc.fileId, next);
}

window.addEventListener('fb-doc-remote', (e) => {
  const d = (e && e.detail) || {};
  if (!d.path || !String(d.path).startsWith('studyos_topics/') || !d.data || !d.data.fileId) return;
  const merged = mergeDocs(_mem.get(d.data.fileId), d.data);
  _mem.set(merged.fileId, merged);
  idbPut(merged);
  emit(merged.fileId);
});

// ── Running ──────────────────────────────────────────────────────────────
const _running = new Map();       // fileId -> Promise
export const isRunning = (fileId) => _running.has(fileId);

const DEVICE_KEY = 'studyos_device_id';
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = 'd' + Math.random().toString(36).slice(2, 10); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch (e) { return 'd-unknown'; }
}

const isPdf = (f) => /pdf/i.test(f && f.mime || '') || /\.pdf$/i.test(f && f.name || '');

async function sourceOf(file) {
  const b64 = await pipeline.fileB64Of(file);
  if (!b64) throw new ai.AIError('Could not read this file on this device.', { kind: 'bad_input' });
  return { b64, name: file.name || 'source.pdf', size: Math.floor(b64.length * 3 / 4) };
}

/**
 * Break a document down: list its topics, then write every lesson.
 * Safe to call again — finished topics are kept, pending/failed ones run.
 * @param {{fresh?:boolean}} opts  fresh: re-list the topics from scratch
 */
export function run(classId, moduleId, file, opts = {}) {
  if (!file || !file.id) return Promise.reject(new Error('file required'));
  if (_running.has(file.id)) return _running.get(file.id);
  if (!isPdf(file)) return Promise.reject(new ai.AIError('Topic breakdown reads PDFs — convert this file to PDF first.', { kind: 'bad_input' }));
  const p = (async () => {
    try { return await runInner(classId, moduleId, file, opts); }
    finally { _running.delete(file.id); emit(file.id); }
  })();
  _running.set(file.id, p);
  emit(file.id);
  return p;
}

async function runInner(classId, moduleId, file, { fresh = false } = {}) {
  const active = ai.active();
  if (active.problem) throw new ai.AIError(active.problem, { kind: 'setup' });

  let doc = await load(file.id);
  if (!doc || fresh || doc.status === 'removed') {
    doc = {
      fileId: file.id, classId, moduleId, sourceName: file.name || '',
      status: 'running', error: '', topics: [], createdAt: Date.now(), listedAt: 0, rev: (doc && doc.rev || 0) + 1,
    };
  }
  doc.rev = doc.rev || 1;
  Object.assign(doc, { classId, moduleId, status: 'running', error: '',
    provider: active.id, model: active.model, runningOn: deviceId() });
  save(doc);

  const cls = store.getClass(classId);
  const className = cls ? [cls.code, cls.name].filter(Boolean).join(' — ') : '';
  let pdf;
  try { pdf = await sourceOf(file); }
  catch (e) { return fail(doc, e); }

  // 1. Topics — once. A re-run keeps the list it already has.
  if (!doc.topics.length) {
    try {
      const { data } = await ai.generateJSON({
        system: SYSTEM, prompt: topicsPrompt({ className, sourceName: doc.sourceName }),
        pdf, schema: TOPICS_SCHEMA, validate: validateTopics, maxTokens: 32000,
        key: `bd:${file.id}:r${doc.rev}:topics`, fileId: file.id,
        resumeJobId: doc.topicsJobId,
        onJob: (id, main) => { if (main) { doc.topicsJobId = id; save(doc); } },
      });
      const used = new Set();
      doc.topics = data.topics.map((t, i) => {
        let id = 't' + ai.hash(t.title).slice(1, 7);
        while (used.has(id)) id += i;
        used.add(id);
        return { id, ...t, status: 'pending', updatedAt: Date.now(), rev: 0 };
      });
      doc.listedAt = Date.now();
      delete doc.topicsJobId;
      save(doc);
    } catch (e) { return fail(doc, e); }
  }

  // 2. Lessons. The bridge runs one ask at a time anyway; an API gets two.
  const todo = doc.topics.filter((t) => t.status !== 'ready');
  const width = active.id === 'bridge' ? 1 : 2;
  let fatal = null;
  const worker = async () => {
    while (todo.length && !fatal) {
      const topic = todo.shift();
      try { await writeTopic(doc, topic, pdf, className); }
      catch (e) {
        // A key/model/setup problem fails every topic identically: stop,
        // rather than spending a request per topic to learn the same thing.
        if (e && (e.kind === 'setup' || e.kind === 'auth')) fatal = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, todo.length || 1) }, worker));

  const failed = doc.topics.filter((t) => t.status === 'failed').length;
  doc.status = fatal ? 'failed' : failed ? 'partial' : 'ready';
  doc.error = fatal ? fatal.message : failed ? `${failed} topic${failed === 1 ? '' : 's'} failed — retry them from the list.` : '';
  delete doc.runningOn;
  save(doc);
  return doc;
}

function fail(doc, e) {
  doc.status = 'failed';
  doc.error = (e && e.message) || String(e);
  delete doc.runningOn;
  save(doc);
  throw e;
}

async function writeTopic(doc, topic, pdf, className) {
  topic.status = 'writing';
  topic.error = '';
  topic.updatedAt = Date.now();
  save(doc);
  try {
    const { data } = await ai.generateJSON({
      system: SYSTEM,
      prompt: lessonPrompt({ className, sourceName: doc.sourceName, topic,
        index: doc.topics.indexOf(topic), all: doc.topics }),
      pdf, schema: LESSON_SCHEMA, validate: validateLesson, maxTokens: 64000,
      key: `bd:${doc.fileId}:r${doc.rev}:${topic.id}:v${topic.rev || 0}`, fileId: doc.fileId,
      resumeJobId: topic.jobId,
      onJob: (id, main) => { if (main) { topic.jobId = id; save(doc); } },
    });
    const r = deck.addExternal(doc.classId, doc.moduleId, data.flashcards,
      { noteId: noteIdFor(doc.fileId, topic.id), title: topic.title });
    topic.lesson = { blocks: data.blocks };
    topic.cardCount = data.flashcards.length;
    topic.cardsAdded = r.added.length;
    topic.status = 'ready';
    delete topic.jobId;
  } catch (e) {
    topic.status = 'failed';
    topic.error = (e && e.message) || String(e);
    delete topic.jobId;
    throw e;
  } finally {
    topic.updatedAt = Date.now();
    save(doc);
  }
}

/** Rewrite one topic (a new version: never answered from the bridge cache). */
export async function regenerate(fileId, topicId, file) {
  const doc = await load(fileId);
  const topic = doc && doc.topics.find((t) => t.id === topicId);
  if (!doc || !topic) return null;
  if (_running.has(fileId)) return _running.get(fileId);
  const active = ai.active();
  if (active.problem) throw new ai.AIError(active.problem, { kind: 'setup' });
  topic.rev = (topic.rev || 0) + 1;
  const job = (async () => {
    const pdf = await sourceOf(file);
    const cls = store.getClass(doc.classId);
    try { await writeTopic(doc, topic, pdf, cls ? [cls.code, cls.name].filter(Boolean).join(' — ') : ''); }
    finally {
      const failed = doc.topics.filter((t) => t.status === 'failed').length;
      doc.status = failed ? 'partial' : 'ready';
      doc.error = failed ? doc.error : '';
      save(doc);
    }
  })();
  _running.set(fileId, job);
  emit(fileId);
  try { return await job; } finally { _running.delete(fileId); emit(fileId); }
}

/** Delete a breakdown: its topics everywhere, and its cards that were never
 *  reviewed. Reviewed cards keep their scheduling — weeks of spacing are not
 *  thrown away as a side effect. */
export async function remove(fileId) {
  const doc = await load(fileId);
  if (!doc) return;
  const cards = deck.byNotePrefix(doc.classId, notePrefixFor(fileId));
  const unreviewed = cards.filter((c) => !c.sched || c.sched.state === fsrs.STATE.NEW);
  if (unreviewed.length) deck.remove(doc.classId, unreviewed.map((c) => c.id));
  doc.topics = [];
  doc.status = 'removed';
  doc.error = '';
  doc.listedAt = Date.now();
  save(doc);
}

/** Record where she is in a topic (debounced by the caller). */
export function setProgress(fileId, topicId, progress) {
  const doc = _mem.get(fileId);
  const topic = doc && doc.topics.find((t) => t.id === topicId);
  if (!topic) return;
  topic.progress = { ...(topic.progress || {}), ...progress };
  topic.updatedAt = Date.now();
  save(doc);
}

/**
 * Continue breakdowns this device left running (the tab closed mid-run).
 * Only this device's: another device may be running its own right now, and
 * two runners on one document would pay for every lesson twice.
 */
export async function resume() {
  const me = deviceId();
  for (const cls of store.getClasses() || []) {
    for (const mod of cls.modules || []) {
      for (const f of mod.files || []) {
        if (!f || !f.study || f.study.status !== 'running' || _running.has(f.id)) continue;
        const doc = await load(f.id);
        if (!doc || doc.runningOn !== me) continue;
        run(cls.id, mod.id, f).catch((e) => console.warn('[breakdown] resume failed:', f.name, e && e.message));
      }
    }
  }
}

export default {
  STYLES, KINDS, TOPICS_SCHEMA, LESSON_SCHEMA, topicsPrompt, lessonPrompt, STYLE_GUIDE,
  validateTopics, validateLesson, validateQuestions, mergeDocs,
  load, peek, run, regenerate, remove, setProgress, resume, isRunning, noteIdFor, notePrefixFor,
};
