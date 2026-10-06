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
export const KINDS = ['read', 'example', 'steps', 'check', 'recap', 'figure'];
const MAX_TOPICS = 15;
const MAX_BLOCKS = 16;
const MAX_QUESTIONS = 6;
const MAX_DRAWN = 2;                // drawn figures per lesson
const MAX_SVG = 12 * 1024;
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
    page: { type: 'integer' },
    svg: str,
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

/** How the document reaches the model: its page text in the prompt (always,
 *  for text-only providers), and/or the PDF attached. */
function sourceIntro(sourceName, className, source, attached) {
  const what = `course material${className ? ` for ${className}` : ''}: "${sourceName}"`;
  if (!source) return `The attached PDF is ${what}.`;
  return `The document is ${what}. Its text is below, page by page${attached
    ? ' (the PDF itself is attached too — use it for diagrams and figures)' : ''}.

<document>
${source}
</document>`;
}

/** Her own prompt from a prompts module, ADDED to the built-in one, just
 *  before the reply format — never in place of it. The rules it cannot
 *  override are the ones the checks against the PDF depend on. Empty →
 *  nothing, so a plain breakdown's prompt is unchanged. */
function instructionsBlock(instructions) {
  const text = String(instructions || '').trim();
  if (!text) return '';
  return `
THE STUDENT'S OWN INSTRUCTIONS — follow them for what to emphasise and how to explain. They never override the rules above about covering the whole document, staying faithful to it, or the reply format.
<instructions>
${text}
</instructions>
`;
}

export function topicsPrompt({ className, sourceName, source = '', attached = true, feedback = '', instructions = '' }) {
  return `${sourceIntro(sourceName, className, source, attached)}

Break it into the TOPICS a student must learn, so that studying every topic covers the ENTIRE document.
${feedback ? `
YOUR PREVIOUS LIST WAS REJECTED — it did not match this document:
${feedback}
List the topics of THIS document only, from its text above.
` : ''}
RULES
- Cover the whole document with no gaps, in the order it presents the material. Every section, definition, formula, algorithm and worked example belongs to exactly one topic.
- Only what is IN the document. Never add a topic the document does not teach.${source ? `
- Every page with teaching content belongs to a topic. A title page, a repeated agenda/objectives slide and a closing slide need no topic of their own.` : ''}
- 3 to ${MAX_TOPICS} topics. Each topic is one sitting of study (10-25 minutes): big enough to be worth a lesson, small enough to master in one go. Split a long chapter; merge slides that only make sense together.
- Titles are concrete and specific. "Converting an ER diagram to tables" is a topic; "Databases" is not.
- summary: one or two sentences saying exactly what the topic covers.
- key_points: EVERY fact, definition, formula, rule and procedure this topic must teach. The lesson is written against this checklist, so leave nothing out.
- pages: where it is in the document, e.g. "4-9" or "4-9, 12" (slide or page numbers${source ? ' — the numbers of the "--- page N ---" markers' : ''}).
- style: what kind of learning the topic needs —
    concept      ideas and theory to understand: why and how things work
    procedure    a method, algorithm or calculation to carry out step by step
    applied      using knowledge on realistic problems or scenarios
    definitions  a set of terms and distinctions to get exactly right
- Skip course logistics (syllabus, grading, office hours) unless that is the whole document.
${instructionsBlock(instructions)}
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

/** The FIGURES section of a lesson ask: when to show one of the document's
 *  figure pages, when to draw a diagram instead, and how to draw it. */
function figureGuide(figurePages) {
  const list = figurePages.join(', ');
  return `FIGURES — a lesson can show pictures, where a picture genuinely helps.${figurePages.length ? `
- The document has a figure on ${figurePages.length === 1 ? `page ${list}` : `pages ${list}`} of this topic. Show one with
  {"kind": "figure", "page": <that page>, "svg": ""} right next to the block that explains it, when the document's own figure shows the idea well.` : ''}
- Draw a diagram — {"kind": "figure", "svg": "<svg ...>...</svg>"} — when a picture would teach something the
  document has no figure for (a process, a structure, a comparison, a graph)${figurePages.length
    ? ', or when a listed page\'s figure is cluttered, blurry or only half relevant and a cleaner one teaches better: then set "page" to the page you are redrawing' : ''}. Otherwise "page" is 0.
- ${figurePages.length ? 'Each listed page is shown or redrawn exactly once. ' : ''}At most ${MAX_DRAWN} drawn figures. Never a decorative one.
- "title": what the figure shows. "markdown": what to notice in it — its parts, labels, arrows (may be "").
- Drawing rules: one self-contained <svg> with a viewBox, under 10 KB. Only shapes, lines, paths and <text>:
  no scripts, no <image>, no <foreignObject>, no links, no external fonts or styles. Dark strokes and text on a
  white background. Every label uses the document's own terms and values — nothing the source does not say.`;
}

export function lessonPrompt({ className, sourceName, topic, index, all, source = '', attached = true, figures = [], figurePages = [], instructions = '' }) {
  const others = all.filter((t) => t.id !== topic.id).map((t) => `  - ${t.title}`).join('\n');
  const checklist = (topic.key_points || []).map((k) => `  - ${k}`).join('\n') || '  - (use the summary)';
  return `Write ONE lesson from ${source ? 'the course material below' : 'the attached course material'}${className ? ` for a student in ${className}` : ''}.
${source ? `
SOURCE — this topic's pages of "${sourceName}", verbatim${attached ? ' (the whole PDF is attached too, for its diagrams)' : ''}:
<source>
${source}
</source>
EVERY line of the source must be taught in this lesson: every fact, number, unit, term, example and list item.
You may add explanation, intuition and examples; you may never drop or shorten a detail from the source.
` : ''}${figures.length ? `
FIGURES — ${figures.length === 1 ? `page ${figures[0]} is` : `pages ${figures.join(', ')} are`} attached as ${figures.length === 1 ? 'an image' : 'images, in that order'}. They are part of the source: teach what each one shows (a diagram's parts, labels and arrows; a table's contents; what a picture illustrates), not only the text around it.
` : ''}
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
  figure   ${figurePages.length ? '"page": a figure page of the document, or ' : ''}"svg": a diagram you draw (below)
Every block has a short "title". Fields a block's kind does not use are empty ("", [] or 0).

${figureGuide(figurePages)}

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
${instructionsBlock(instructions)}
Reply with ONE JSON object and nothing else:
{"blocks": [{"kind": "read", "title": "...", "markdown": "...", "steps": [], "questions": [], "points": [], "page": 0, "svg": ""}],
 "flashcards": [{"front": "...", "back": "..."}]}`;
}

/** The follow-up for a lesson that left source lines out. */
export function gapsPrompt({ className, sourceName, topic, missing, source = '', instructions = '' }) {
  const lines = missing.map((m) => `  - [page ${m.page}] ${m.text}`).join('\n');
  return `You wrote the lesson "${topic.title}" from "${sourceName}"${className ? ` (${className})` : ''}. Checked line by line against the document, it leaves out the source lines below — material a student could be examined on.

MISSING — teach every one of these exactly as the document states it (its numbers, units and terms):
${lines}
${source ? `
SOURCE — the topic's pages, verbatim, for context:
<source>
${source}
</source>
` : ''}
Write ADDITIONAL lesson blocks that teach the missing lines — "read", "example", "steps" or "check" blocks, the same shapes as before — plus a flashcard for every fact in them.
Do not repeat what the lesson already teaches. No recap block.
Every block has a short "title". Fields a block's kind does not use are empty ("" or []).
Check questions: {"q", "choices": 3-5 plausible choices, "answer": exactly one of the choices, "explanation"}.
Flashcards: atomic, one idea each; front a specific question, back at most two sentences.
${instructionsBlock(instructions)}
Reply with ONE JSON object and nothing else:
{"blocks": [{"kind": "read", "title": "...", "markdown": "...", "steps": [], "questions": [], "points": [], "page": 0, "svg": ""}],
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

/** A drawn figure's SVG, or '' when it is not one we will show. It is
 *  displayed through <img src="data:image/svg+xml,…">, where scripts and
 *  outside loads never run; these checks are a second line, plus a size cap. */
export function cleanSvg(v) {
  const svg = String(v == null ? '' : v).trim();
  if (!svg || svg.length > MAX_SVG) return '';
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) return '';
  if (/<script|<foreignObject|<image|<iframe|<embed|<object|@import|javascript:/i.test(svg)) return '';
  if (/\son[a-z]+\s*=/i.test(svg)) return '';
  if (/href\s*=\s*(?!["']?#)/i.test(svg)) return '';
  if (/url\(\s*(?!["']?#)/i.test(svg)) return '';
  return /^<svg[^>]*\sxmlns\s*=/i.test(svg) ? svg : svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

/**
 * The model's output, checked. `figurePages`: the topic's figure pages —
 * the only pages a figure may show or redraw. Without `allowFigures` every
 * figure block is dropped (a gap follow-up never adds one).
 */
export function validateLesson(o, { figurePages = [], allowFigures = false } = {}) {
  const blocks = [];
  const figSeen = new Set();
  let drawn = 0;
  for (const b of arr(o && o.blocks)) {
    if (!b || !KINDS.includes(b.kind)) continue;
    const base = { kind: b.kind, title: s(b.title, 140) };
    if (b.kind === 'figure') {
      if (!allowFigures) continue;
      const page = Number.isInteger(b.page) && figurePages.includes(b.page) ? b.page : 0;
      const svg = cleanSvg(b.svg);
      if (svg) {
        if (drawn >= MAX_DRAWN) continue;
      } else if (!page) continue;             // a page figure must be a real figure page
      if (page && figSeen.has(page)) continue;
      if (page) figSeen.add(page);
      if (svg) drawn++;
      blocks.push({ ...base, markdown: s(b.markdown, 6000), page, svg });
      continue;
    }
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

/** Every figure page of the topic is in its lesson: a page no figure block
 *  shows or redraws is added before the recap — never silently lost. */
export function placeFigures(blocks, figurePages) {
  const covered = new Set(blocks.filter((b) => b.kind === 'figure' && b.page).map((b) => b.page));
  const add = (figurePages || []).filter((n) => !covered.has(n))
    .map((n) => ({ kind: 'figure', title: `Figure from page ${n}`, markdown: '', page: n, svg: '' }));
  if (!add.length) return blocks;
  const recap = blocks.findIndex((b) => b.kind === 'recap');
  return recap < 0 ? [...blocks, ...add] : [...blocks.slice(0, recap), ...add, ...blocks.slice(recap)];
}

// ── Checking the output against the document ─────────────────────────────
/* A model's topics and lessons are checked against the PDF's own text, not
 * trusted. The case that made this necessary: a provider delivered only the
 * system prompt, and the model — having never seen the document — invented a
 * plausible economics course for a computer-architecture chapter, which was
 * saved as if it were real. Now:
 *   topics  must share their vocabulary with the document, point at real
 *           pages, and together cover every page that teaches something;
 *   lessons must teach every line of their pages — each number verbatim,
 *           most of each line's words — or a follow-up ask fills the gaps.
 * Matching is lexical and deliberately forgiving (stems, number words,
 * ² vs ^2): a paraphrase passes, an omission or an invention does not. */
const STOP = new Set(('about above after again against also among another because been before being below between both ' +
  'but called cannot come comes could does doing done down during each either else even every from further have having ' +
  'here into itself just like made make makes many more most much must need needs only other others ours over same ' +
  'shall should since some such than that their them then there these they this those through thus under until upon ' +
  'used uses using very want well were what when where whether which while whom whose will with within without would ' +
  'your yours cont slide page chapter the and for are not but can its has all any was you our how why who may use ' +
  'get got let see yes etc per via off out own too now new way she her his him').split(/\s+/));
const NUMWORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20 };
const SUPS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };

function stem(w) {
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w.slice(0, 6);
}

/** { words: Set<stem>, nums: Set<string> } of a text. 10³, 10^{3}, $10^3$
 *  and <sup>3</sup> all read as "10^3"; 1,048,576 as "1048576"; "seven" as 7. */
export function tokensOf(text) {
  const t = String(text || '').toLowerCase()
    .replace(/<sup>\s*/g, '^').replace(/<\/sup>/g, '')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (s) => '^' + [...s].map((c) => SUPS[c]).join(''))
    .replace(/[{}$\\]/g, '')
    .replace(/\s*\^\s*/g, '^')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g, (w) => String(NUMWORDS[w]));
  const nums = new Set();
  const rest = t.replace(/\d+(?:\.\d+)?(?:\^-?\d+(?:\.\d+)?)?/g, (n) => { nums.add(n); return ' '; });
  const words = new Set();
  for (const w of rest.match(/[a-z]{3,}/g) || []) if (!STOP.has(w)) words.add(stem(w));
  return { words, nums };
}

/** "4-9, 12" / "slides 4–9" / "p. 7" → sorted page numbers, and whether any
 *  number was outside 1..max (or nothing parsed). */
export function parsePages(str, max) {
  const out = new Set();
  let bad = false;
  for (const m of String(str || '').matchAll(/(\d+)\s*(?:-|–|—|to)\s*(\d+)|(\d+)/g)) {
    let a = Number(m[1] || m[3]), b = Number(m[2] || m[3]);
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > max) { bad = true; a = Math.max(1, a); b = Math.min(max, b); }
    for (let n = a; n <= b && n - a < 1000; n++) out.add(n);
  }
  if (!out.size) bad = true;
  return { pages: [...out].sort((x, y) => x - y), bad };
}

/** A page's logical items: bullet lines joined with their wrapped
 *  continuation lines. The slide title (its tallest line, when it stands out)
 *  is flagged: it names the material rather than being material. */
export function pageItems(page) {
  const lines = (page.lines || []).filter((l) => !/^\d{1,4}$/.test(l.text));
  if (!lines.length) return [];
  const maxH = Math.max(...lines.map((l) => l.h || 0));
  const hasBody = lines.some((l) => (l.h || 0) < maxH * 0.9);
  const items = [];
  let cur = null;
  for (const l of lines) {
    const title = hasBody && (l.h || 0) >= maxH * 0.95;
    const cont = cur && !l.bullet && !title && !cur.title && Math.abs((l.h || 0) - cur.h) <= 1;
    if (cont) cur.text += ' ' + l.text;
    else { cur = { page: page.n, text: l.text, h: l.h || 0, title }; items.push(cur); }
  }
  return items.map(({ page: p, text, title }) => ({ page: p, text, title }));
}

/**
 * Everything the checks need from the document's text:
 *   pages     [{ n, lines }] as extracted
 *   items     n → the page's items
 *   content   the pages that teach something: not near-empty, and not a
 *             repeat of an earlier page (an agenda slide shown four times)
 *   dupOf     n → the earlier page it repeats
 *   words     every word stem in the document
 */
export function sourceModel(pages) {
  const m = { pages, items: new Map(), content: [], dupOf: new Map(), words: new Set(), max: pages.length };
  const seen = new Map();
  for (const p of pages) {
    const items = pageItems(p);
    m.items.set(p.n, items);
    const tk = tokensOf(items.map((i) => i.text).join('\n'));
    tk.words.forEach((w) => m.words.add(w));
    const key = [...tk.words].sort().join(' ') + '|' + [...tk.nums].sort().join(' ');
    if (seen.has(key)) { m.dupOf.set(p.n, seen.get(key)); continue; }
    seen.set(key, p.n);
    // A picture teaches too: a slide that is only a title and a diagram is material.
    if (tk.words.size >= 4 || p.figure) m.content.push(p.n);
  }
  // A page shown more than once is an agenda — "Chapter 1 Objectives" before
  // each section — not material of its own; its first showing included.
  const repeated = new Set(m.dupOf.values());
  m.content = m.content.filter((n) => !repeated.has(n));
  return m;
}

/** The prompt text of some pages ("--- page N ---" markers); a repeated
 *  page is named, not repeated. */
export function sourceText(model, pageNums) {
  const want = pageNums ? new Set(pageNums) : null;
  return model.pages.filter((p) => !want || want.has(p.n)).map((p) => {
    if (model.dupOf.has(p.n)) return `--- page ${p.n} --- (same as page ${model.dupOf.get(p.n)})`;
    const body = ai.pageText(p);
    return `--- page ${p.n} ---${body ? '\n' + body : ''}`;
  }).join('\n\n');
}

/** How much of a topic's own wording is in the document at all. Measured on
 *  Chapter1-Introduction.pdf: its real topics score 0.92-0.96; the invented
 *  economics topics scored 0.00-0.38 (generic words like "introduction",
 *  "overview" and "model" match anything). */
function topicScore(topic, model) {
  const tk = tokensOf([topic.title, ...(topic.key_points || [])].join('\n'));
  if (tk.words.size < 3) return 1;
  let hit = 0;
  tk.words.forEach((w) => { if (model.words.has(w)) hit++; });
  return hit / tk.words.size;
}
const INVENTED_BELOW = 0.5;

/**
 * Check a topic list against the document.
 * @returns {{ invented: object[], badPages: object[], uncovered: number[], feedback: string }}
 */
export function groundTopics(topics, model) {
  const invented = [], badPages = [], covered = new Set();
  for (const t of topics) {
    if (topicScore(t, model) < INVENTED_BELOW) { invented.push(t); continue; }
    const r = parsePages(t.pages, model.max);
    if (r.bad) badPages.push(t);
    r.pages.forEach((n) => covered.add(n));
  }
  const uncovered = model.content.filter((n) => !covered.has(n));
  const fb = [];
  if (invented.length) fb.push(`- These topics are not in the document at all: ${invented.map((t) => `"${t.title}"`).join(', ')}.`);
  if (badPages.length) fb.push(`- These topics have missing or impossible page numbers (the document has ${model.max} pages): ${badPages.map((t) => `"${t.title}" (pages "${t.pages}")`).join(', ')}.`);
  if (uncovered.length) fb.push(`- No topic covers ${pageList(uncovered)}, which teach material.`);
  return { invented, badPages, uncovered, feedback: fb.join('\n') };
}

/** [3,4,5,9] → "pages 3–5, 9" */
function pageList(nums) {
  const runs = [];
  for (const n of nums) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else runs.push([n, n]);
  }
  return (nums.length === 1 ? 'page ' : 'pages ') + runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/** Topics for pages no topic covered: one per run of adjacent content pages,
 *  holding those pages' items as its checklist — so the whole document is
 *  always taught, even when the model's list skipped some of it. */
export function fallbackTopics(uncovered, model) {
  const runs = [];
  const order = model.content;
  for (const n of uncovered) {
    const last = runs[runs.length - 1];
    if (last && order.indexOf(n) === order.indexOf(last[last.length - 1]) + 1) last.push(n); else runs.push([n]);
  }
  return runs.map((run) => {
    const items = run.flatMap((n) => model.items.get(n) || []);
    const head = items.find((i) => i.title) || items[0];
    const name = String(head ? head.text : 'More material').replace(/\s*\(?['‘’]?\s*cont\.?\)?\s*$/i, '').slice(0, 120);
    const a = run[0], b = run[run.length - 1];
    return {
      title: name, style: 'concept',
      summary: `${a === b ? `Page ${a}` : `Pages ${a}–${b}`} of the document, which the topic list had not covered.`,
      key_points: items.filter((i) => !i.title).map((i) => i.text).slice(0, 40),
      pages: a === b ? String(a) : `${a}-${b}`,
      added: true,
    };
  });
}

/** Everything a lesson says, as one text: blocks, checks, recap, cards. */
export function lessonText(blocks, flashcards) {
  const out = [];
  for (const b of blocks || []) {
    out.push(b.title || '', b.markdown || '');
    for (const s of b.steps || []) out.push(s.title || '', s.body || '');
    for (const q of b.questions || []) out.push(q.q || '', ...(q.choices || []), q.explanation || '');
    out.push(...(b.points || []));
  }
  for (const c of flashcards || []) out.push(c.front || c.q || '', c.back || c.a || '');
  return out.join('\n');
}

/** A source item the lesson text does not teach: a number of it missing, or
 *  under 60% of its words. Titles are skipped — they name, not teach. */
export function itemMissing(item, lessonTokens) {
  if (item.title) return false;
  const tk = tokensOf(item.text);
  if (!tk.words.size && !tk.nums.size) return false;
  for (const n of tk.nums) if (!lessonTokens.nums.has(n)) return true;
  if (!tk.words.size) return false;
  let hit = 0;
  tk.words.forEach((w) => { if (lessonTokens.words.has(w)) hit++; });
  return tk.words.size === 1 ? hit === 0 : hit / tk.words.size < 0.6;
}

/** The share of a page set's vocabulary a lesson uses. A lesson written
 *  without seeing its pages scores near 0. */
export function lessonRecall(model, pageNums, lessonTokens) {
  const words = new Set();
  for (const n of pageNums) for (const i of model.items.get(n) || []) tokensOf(i.text).words.forEach((w) => words.add(w));
  if (words.size < 8) return 1;
  let hit = 0;
  words.forEach((w) => { if (lessonTokens.words.has(w)) hit++; });
  return hit / words.size;
}
const UNGROUNDED_BELOW = 0.15;

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

/* The document as a PDF. A slide deck or Word document is the PDF PowerPoint
 * or Word exports (via the bridge), so everything below — page text, checks,
 * figures — is unchanged. A conversion failure is a setup problem: it stops
 * the run before any ask. */
async function sourceOf(file) {
  const office = pipeline.isOfficeFile(file);
  let b64;
  try { b64 = await pipeline.pdfOf(file); }
  catch (e) { throw new ai.AIError((e && e.message) || String(e), { kind: office ? 'setup' : 'bad_input' }); }
  if (!b64) throw new ai.AIError('Could not read this file on this device.', { kind: 'bad_input' });
  const name = office ? (file.name || 'document').replace(/\.\w+$/, '') + '.pdf' : (file.name || 'source.pdf');
  return { b64, name, size: Math.floor(b64.length * 3 / 4) };
}

// Providers whose API takes no PDF: the document reaches them as page text.
const TEXT_ONLY = new Set(['orca']);
// ORCA's browser models (ChatGPT, Claude.ai, Gemini) also take the PDF itself
// as an OpenAI file part -- it rides along with the page text, so a site
// that reads the file sees its layout and figures too. Past this size the
// upload is too slow to be worth it (claude.ai's own cap is 30 MB).
const MAX_ATTACHED_PDF = 20 * 1024 * 1024;
// Page text put in a prompt when the PDF rides along too. Past this the PDF
// alone carries the document (the checks still run, locally).
const MAX_PROMPT_SOURCE = 150000;

/* The document's text. pdf.js runs in the page; the Node tests swap it. */
let _readPages = (b64) => ai.pdfPages(b64);
export function setPageReader(fn) { _readPages = fn || ((b64) => ai.pdfPages(b64)); }

/* A scan read by ORCA (page pictures -> text). The tests swap it. */
let _ocrPages = (b64) => ai.ocrPages(b64);
export function setPageOcr(fn) { _ocrPages = fn || ((b64) => ai.ocrPages(b64)); }

/* Pictures of pages, for a text-only provider: its models cannot read the
 * PDF, so a slide's diagram would otherwise never reach them. The tests swap
 * the renderer (it needs a canvas). */
let _renderPages = (b64, nums) => ai.pdfPageImages(b64, nums);
export function setPageRenderer(fn) { _renderPages = fn || ((b64, nums) => ai.pdfPageImages(b64, nums)); }
// Per lesson ask. Enough for a topic's diagrams; the chat sites cap a message
// at 10-20 files, and every image slows the upload.
const MAX_FIGURES = 6;

/** The figure pages of a topic's span: the pictures its lesson shows. */
function figuresIn(span, model) {
  if (!model) return [];
  const byN = new Map(model.pages.map((p) => [p.n, p]));
  return span.filter((n) => byN.get(n) && byN.get(n).figure && !model.dupOf.has(n)).slice(0, MAX_FIGURES);
}

/** The figure pages of a topic's span that a text-only provider should see. */
function figurePages(span, ctx) {
  return ctx.textOnly ? figuresIn(span, ctx.model) : [];
}

/**
 * What every ask of one run shares: the document as text (the source model
 * the checks run against, and the prompt text), and how the PDF travels.
 * No text: a text-only provider cannot run at all; one that reads the PDF
 * itself runs unchecked, and the breakdown says so.
 */
async function contextOf(pdf, active) {
  const textOnly = TEXT_ONLY.has(active.id);
  let pages = null, why = '';
  try { pages = await _readPages(pdf.b64); }
  catch (e) { why = 'its text could not be read'; }
  if (pages && !pages.some((p) => (p.lines || []).length)) { pages = null; why = 'it has no selectable text (a scan?)'; }
  if (!pages && textOnly) {
    // A scan: ORCA reads a picture of every page (its Worker transcribes them).
    try { pages = await _ocrPages(pdf.b64); }
    catch (e) {
      if (e && e.kind) throw e;
      throw new ai.AIError(`This PDF cannot be read as text — ${why} — and ORCA could not read its pages as pictures: ${(e && e.message) || e}`, { kind: 'bad_input' });
    }
    if (!pages.some((p) => (p.lines || []).length)) {
      throw new ai.AIError(`ORCA could not read any text from this PDF (${why}).`, { kind: 'bad_input' });
    }
    why = '';
  }
  const model = pages ? sourceModel(pages) : null;
  const full = model ? sourceText(model) : '';
  return {
    model, why, textOnly,
    // The PDF goes to every provider that reads files; for ORCA as an upload.
    sendsFile: textOnly && pdf.size <= MAX_ATTACHED_PDF,
    attached: !textOnly,
    who: active.id === 'bridge' ? 'Claude Pro' : [active.label, active.model].filter(Boolean).join(' / '),
    // The whole document, as prompt text, for the topic list.
    source: model && (textOnly || full.length <= MAX_PROMPT_SOURCE) ? full : '',
  };
}

/**
 * Ask with the document's attachments (ORCA: the PDF and figure images) when
 * there are any; if that ask fails for any reason but a rejected key -- most
 * often no model that takes files was free (ORCA: 404 no_eligible_backend) --
 * ask once more with the text alone. The lesson is still worth writing.
 * `make(withAttachments)` builds the ask. Resolves `{ data, attached }`.
 */
/* While ORCA's models are busy, the step waits (ai.js) — and says so on the
 * topic row instead of sitting at "writing…". In memory only: a wait is not
 * worth a cloud write, and a stale one must never sync. */
const _waits = new Map();          // `${fileId}:${topicId}` ('' = the topic list) -> {until, why}
const waitOn = (doc, topic) => (w) => {
  const k = `${doc.fileId}:${topic ? topic.id : ''}`;
  if (w) _waits.set(k, { until: w.until, why: String(w.why || '').slice(0, 200) });
  else _waits.delete(k);
  emit(doc.fileId);
};
/** The wait a step of this document is in, or null. */
export const waitingOf = (fileId, topicId = '') => _waits.get(`${fileId}:${topicId}`) || null;

/* A topic that failed for a reason that passes — busy, cut off, a reply
 * that did not parse or validate — is worth one more try at the end of the
 * run; a key or setup problem is not. */
const PASSING = new Set(['rate', 'network', 'bad_json', 'too_long', 'no_backend', 'invalid', 'bridge', 'timeout']);
const passes = (e) => !!(e && (e.retryable || PASSING.has(e.kind)) && e.kind !== 'setup' && e.kind !== 'auth');

async function withFallback(make, hasAttachments, what) {
  if (!hasAttachments) return { ...(await make(false)), attached: false };
  try {
    return { ...(await make(true)), attached: true };
  } catch (e) {
    if (e && e.kind === 'auth') throw e;
    console.warn(`[breakdown] ${what} with the PDF attached failed, asking with the text alone:`, e && e.message);
    return { ...(await make(false)), attached: false };
  }
}

/**
 * Break a document down: list its topics, then write every lesson, then fill
 * whatever the lessons left out.
 * Safe to call again — finished topics are kept, pending/failed ones run.
 * @param {{fresh?:boolean}} opts  fresh: re-list the topics from scratch
 */
export function run(classId, moduleId, file, opts = {}) {
  if (!file || !file.id) return Promise.reject(new Error('file required'));
  if (_running.has(file.id)) return _running.get(file.id);
  if (!pipeline.isBreakable(file)) return Promise.reject(new ai.AIError('Topic breakdown reads PDFs, Word documents and PowerPoint slides — convert this file to PDF first.', { kind: 'bad_input' }));
  const p = (async () => {
    try { return await runInner(classId, moduleId, file, opts); }
    finally { _running.delete(file.id); emit(file.id); }
  })();
  _running.set(file.id, p);
  emit(file.id);
  return p;
}

/** Her prompt for this document, kept on the doc so "Write the rest", Retry
 *  and resume() keep writing under the one she chose. */
const instructionsOf = (doc) => (doc.instructions && doc.instructions.text) || '';
// In the bridge cache key, so an answer written under one prompt is never
// handed back for another.
const instrKey = (doc) => (instructionsOf(doc) ? ':i' + ai.hash(instructionsOf(doc)).slice(1, 7) : '');

/** opts.instructions: {text, promptId, moduleId, name} sets her prompt for
 *  this document, null clears it, undefined (resume, "Write the rest") keeps
 *  the one already saved. */
async function runInner(classId, moduleId, file, { fresh = false, instructions } = {}) {
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
  if (instructions !== undefined) {
    const text = instructions && String(instructions.text || '').trim();
    if (text) {
      doc.instructions = { text, promptId: instructions.promptId || '', moduleId: instructions.moduleId || '',
        name: String(instructions.name || '').slice(0, 120) };
    } else doc.instructions = null;   // null, not delete: a merged remote write must clear it too
  }
  Object.assign(doc, { classId, moduleId, status: 'running', error: '',
    provider: active.id, model: active.model, runningOn: deviceId() });
  save(doc);

  const cls = store.getClass(classId);
  const className = cls ? [cls.code, cls.name].filter(Boolean).join(' — ') : '';
  let pdf, ctx;
  try { pdf = await sourceOf(file); ctx = await contextOf(pdf, active); }
  catch (e) { return fail(doc, e); }

  // 1. Topics — once. A re-run keeps the list it already has.
  if (!doc.topics.length) {
    try {
      const { topics, checks } = await listTopics(doc, pdf, className, ctx);
      const used = new Set();
      doc.topics = topics.map((t, i) => {
        let id = 't' + ai.hash(t.title).slice(1, 7);
        while (used.has(id)) id += i;
        used.add(id);
        return { id, ...t, status: 'pending', updatedAt: Date.now(), rev: 0 };
      });
      doc.checks = checks;
      doc.listedAt = Date.now();
      delete doc.topicsJobId;
      delete doc.topicsJobId2;
      save(doc);
    } catch (e) { return fail(doc, e); }
  }

  // 2. Lessons. The bridge, and ORCA (whose models run in one browser window
  // each), take one ask at a time anyway; an API gets two.
  const width = active.id === 'bridge' || active.id === 'orca' ? 1 : 2;
  let fatal = null;
  const pool = async (items, fn) => {
    const todo = [...items];
    const worker = async () => {
      while (todo.length && !fatal) {
        const item = todo.shift();
        try { await fn(item); }
        catch (e) {
          // A key/model/setup problem fails every topic identically: stop,
          // rather than spending a request per topic to learn the same thing.
          if (e && (e.kind === 'setup' || e.kind === 'auth')) fatal = e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, todo.length || 1) }, worker));
  };
  await pool(doc.topics.filter((t) => t.status !== 'ready'), (topic) => writeTopic(doc, topic, pdf, className, ctx));

  // 2b. One more try for topics that failed for a reason that passes (a busy
  // model, a cut-off or unusable reply), as a new version: a bridge cache
  // would otherwise hand the same failed answer back.
  const again = fatal ? [] : doc.topics.filter((t) => t.status === 'failed' && t.retryable);
  if (again.length) {
    again.forEach((t) => { t.rev = (t.rev || 0) + 1; });
    await pool(again, (topic) => writeTopic(doc, topic, pdf, className, ctx));
  }

  // 3. What the lessons left out of the document — one follow-up per topic.
  if (!fatal) await fillGaps(doc, className, ctx, pool);

  const failed = doc.topics.filter((t) => t.status === 'failed').length;
  doc.status = fatal ? 'failed' : failed ? 'partial' : 'ready';
  doc.error = fatal ? fatal.message : failed ? `${failed} topic${failed === 1 ? '' : 's'} failed — retry them from the list.` : '';
  summariseChecks(doc, ctx);
  delete doc.runningOn;
  save(doc);
  return doc;
}

/**
 * The topic list, checked against the document. A list that does not match
 * it is asked for ONCE more, with the document and what was wrong — a JSON
 * repair cannot fix content. Invented topics are dropped; if most of the list
 * was invented the run fails and saves nothing. Pages no topic covers get a
 * topic of their own.
 */
async function listTopics(doc, pdf, className, ctx) {
  const ask = (feedback, attempt) => withFallback((withFile) => ai.generateJSON({
    system: SYSTEM,
    prompt: topicsPrompt({ className, sourceName: doc.sourceName, source: ctx.source,
      attached: ctx.attached || withFile, feedback, instructions: instructionsOf(doc) }),
    pdf, docText: ctx.textOnly ? '' : undefined, attachFile: withFile,
    schema: TOPICS_SCHEMA, validate: validateTopics, maxTokens: 32000,
    key: `bd:${doc.fileId}:r${doc.rev}:topics${attempt ? ':g' + attempt : ''}${withFile ? ':file' : ''}${instrKey(doc)}`, fileId: doc.fileId,
    resumeJobId: attempt ? doc.topicsJobId2 : doc.topicsJobId,
    onJob: (id, main) => { if (main) { doc[attempt ? 'topicsJobId2' : 'topicsJobId'] = id; save(doc); } },
    onWait: waitOn(doc, null),
  }), ctx.sendsFile, 'the topic list');
  const listed = await ask('', 0);
  let { data } = listed;
  if (listed.servedBy) doc.listedBy = listed.servedBy;
  const pdfSent = { topics: listed.attached };
  if (!ctx.model) return { topics: data.topics, checks: { skipped: ctx.why || 'no text', pdfSent } };

  const badness = (g) => g.invented.length * 100 + g.badPages.length * 10 + g.uncovered.length;
  let g = groundTopics(data.topics, ctx.model);
  let asked = 1;
  if (g.feedback) {
    asked = 2;
    try {
      const again = (await ask(g.feedback, 1)).data;
      const g2 = groundTopics(again.topics, ctx.model);
      if (badness(g2) < badness(g)) { data = again; g = g2; }
    } catch (e) {
      if (e && (e.kind === 'setup' || e.kind === 'auth')) throw e;
    }
  }
  const real = data.topics.filter((t) => !g.invented.includes(t));
  if (!real.length || g.invented.length * 2 > data.topics.length) {
    throw new ai.AIError(`The topics ${ctx.who} listed don't match this document — the model probably never ` +
      'received its text. Nothing was saved and no cards were added.', { kind: 'ungrounded' });
  }
  const added = fallbackTopics(g.uncovered, ctx.model);
  // Document order: each added topic goes before the first topic that starts after it.
  const first = (t) => { const p = parsePages(t.pages, ctx.model.max).pages; return p.length ? p[0] : Infinity; };
  const topics = [...real];
  for (const t of added) {
    const at = topics.findIndex((x) => first(x) > first(t));
    topics.splice(at < 0 ? topics.length : at, 0, t);
  }
  return { topics, checks: {
    pages: ctx.model.max, content: ctx.model.content.length, asked,
    dropped: g.invented.map((t) => t.title), added: added.length, pdfSent,
  } };
}

function fail(doc, e) {
  doc.status = 'failed';
  doc.error = (e && e.message) || String(e);
  delete doc.runningOn;
  save(doc);
  throw e;
}

const pagesOf = (topic, ctx) => (ctx.model ? parsePages(topic.pages, ctx.model.max).pages : []);

async function writeTopic(doc, topic, pdf, className, ctx) {
  topic.status = 'writing';
  topic.error = '';
  delete topic.retryable;
  topic.startedAt = topic.updatedAt = Date.now();
  save(doc);
  try {
    const span = pagesOf(topic, ctx);
    const src = span.length ? sourceText(ctx.model, span) : '';
    const figs = figurePages(span, ctx);
    const figPages = figuresIn(span, ctx.model);
    let images = [];
    if (figs.length) {
      try { images = await _renderPages(pdf.b64, figs); }
      catch (e) { console.warn('[breakdown] could not render figures:', e && e.message); images = []; }
    }
    const ask = (withAtt) => {
      const imgs = withAtt ? images : [];
      const withFile = withAtt && ctx.sendsFile;
      return ai.generateJSON({
        system: SYSTEM,
        prompt: lessonPrompt({ className, sourceName: doc.sourceName, topic,
          index: doc.topics.indexOf(topic), all: doc.topics, source: src, attached: ctx.attached || withFile,
          figures: imgs.map((i) => i.n), figurePages: figPages, instructions: instructionsOf(doc) }),
        // Text-only: the topic's pages are in the prompt; without them, send the whole text.
        pdf, docText: ctx.textOnly ? (src ? '' : ctx.source) : undefined,
        attachFile: withFile, images: imgs.map((i) => i.url),
        schema: LESSON_SCHEMA, validate: (o) => validateLesson(o, { figurePages: figPages, allowFigures: true }), maxTokens: 64000,
        key: `bd:${doc.fileId}:r${doc.rev}:${topic.id}:v${topic.rev || 0}${withAtt ? ':att' : ''}${instrKey(doc)}`, fileId: doc.fileId,
        resumeJobId: topic.jobId,
        onJob: (id, main) => { if (main) { topic.jobId = id; save(doc); } },
        onWait: waitOn(doc, topic),
      });
    };
    const { data, attached, servedBy } = await withFallback(ask, images.length > 0 || ctx.sendsFile, 'the lesson');
    topic.servedBy = servedBy || '';
    topic.pdfSent = attached && ctx.sendsFile;
    topic.figures = attached ? images.map((i) => i.n) : [];
    topic.figuresSkipped = figs.filter((n) => !topic.figures.includes(n));
    if (span.length) {
      const recall = lessonRecall(ctx.model, span, tokensOf(lessonText(data.blocks, data.flashcards)));
      if (recall < UNGROUNDED_BELOW) {
        throw new ai.AIError(`The lesson does not match ${pageList(span)} of the document (it uses ${Math.round(recall * 100)}% ` +
          'of their words), so it was not saved.', { kind: 'ungrounded', retryable: true });
      }
    }
    const r = deck.addExternal(doc.classId, doc.moduleId, data.flashcards,
      { noteId: noteIdFor(doc.fileId, topic.id), title: topic.title });
    topic.lesson = { blocks: placeFigures(data.blocks, figPages) };
    topic.cardCount = data.flashcards.length;
    topic.cardsAdded = r.added.length;
    topic.gapChecked = false;
    topic.gaps = [];
    topic.status = 'ready';
    delete topic.jobId;
  } catch (e) {
    topic.status = 'failed';
    topic.error = (e && e.message) || String(e);
    topic.retryable = passes(e);
    delete topic.jobId;
    throw e;
  } finally {
    _waits.delete(`${doc.fileId}:${topic.id}`);
    topic.updatedAt = Date.now();
    save(doc);
  }
}

/** A topic's cards as {front, back}, from the deck (the lesson's own list is
 *  not stored), so a follow-up can add to them without dropping any. */
function cardsOf(doc, topic) {
  const id = noteIdFor(doc.fileId, topic.id);
  return deck.forClass(doc.classId).filter((c) => c.sourceNoteId === id).map((c) => ({ front: c.q, back: c.a }));
}

/**
 * Every line of the document, checked against every written lesson. A line
 * no lesson teaches is owed by the topic whose pages hold it; each topic with
 * such lines gets ONE follow-up ask for extra blocks and cards. Lines still
 * untaught after it are kept on the topic (`gaps`) and shown with the lesson,
 * verbatim from the document — never silently lost.
 */
async function fillGaps(doc, className, ctx, pool, onlyId = null) {
  const m = ctx.model;
  if (!m) return;
  const ready = () => doc.topics.filter((t) => t.status === 'ready' && t.lesson);
  const taught = () => tokensOf(ready().map((t) => lessonText(t.lesson.blocks, cardsOf(doc, t))).join('\n'));
  const spans = new Map(doc.topics.map((t) => [t.id, pagesOf(t, ctx)]));
  const wordsOf = new Map(doc.topics.map((t) => [t.id, tokensOf([t.title, ...(t.key_points || [])].join('\n')).words]));
  const owner = (item) => {
    const claim = doc.topics.filter((t) => spans.get(t.id).includes(item.page));
    if (claim.length === 1) return claim[0];
    if (!claim.length) {
      // Nearest topic by page — only when the checks' page parse lost it.
      let best = null, dist = Infinity;
      for (const t of doc.topics) for (const n of spans.get(t.id)) {
        if (Math.abs(n - item.page) < dist) { dist = Math.abs(n - item.page); best = t; }
      }
      return best;
    }
    const w = tokensOf(item.text).words;
    let best = claim[0], score = -1;
    for (const t of claim) {
      let s = 0;
      w.forEach((x) => { if (wordsOf.get(t.id).has(x)) s++; });
      if (s > score) { score = s; best = t; }
    }
    return best;
  };

  let known = taught();
  const owed = new Map();
  for (const n of m.content) {
    for (const item of m.items.get(n) || []) {
      if (!itemMissing(item, known)) continue;
      const t = owner(item);
      if (!t) continue;
      if (!owed.has(t.id)) owed.set(t.id, []);
      owed.get(t.id).push(item);
    }
  }

  const todo = ready().filter((t) => !t.gapChecked && (!onlyId || t.id === onlyId));
  await pool(todo, async (topic) => {
    const items = owed.get(topic.id) || [];
    if (items.length) {
      try { await askGaps(doc, topic, items, className, ctx); }
      catch (e) {
        if (e && (e.kind === 'setup' || e.kind === 'auth')) throw e;
        console.warn('[breakdown] gap fill failed:', topic.title, e && e.message);
      }
    }
    known = taught();
    topic.gaps = items.filter((i) => itemMissing(i, known)).map((i) => ({ page: i.page, text: i.text }));
    topic.gapChecked = true;
    topic.updatedAt = Date.now();
    save(doc);
  });
}

async function askGaps(doc, topic, items, className, ctx) {
  const span = pagesOf(topic, ctx);
  const { data } = await ai.generateJSON({
    system: SYSTEM,
    prompt: gapsPrompt({ className, sourceName: doc.sourceName, topic, missing: items.slice(0, 80),
      source: span.length ? sourceText(ctx.model, span) : '', instructions: instructionsOf(doc) }),
    // The missing lines are in the prompt, verbatim: no need to send the PDF again.
    pdf: null, docText: '',
    schema: LESSON_SCHEMA, validate: validateLesson, maxTokens: 64000,
    key: `bd:${doc.fileId}:r${doc.rev}:${topic.id}:v${topic.rev || 0}:gaps${instrKey(doc)}`, fileId: doc.fileId,
    resumeJobId: topic.gapJobId,
    onJob: (id, main) => { if (main) { topic.gapJobId = id; save(doc); } },
    onWait: waitOn(doc, topic),
  });
  delete topic.gapJobId;
  const blocks = topic.lesson.blocks;
  const add = data.blocks.filter((b) => b.kind !== 'recap');
  const recap = blocks.findIndex((b) => b.kind === 'recap');
  topic.lesson = { blocks: recap < 0 ? [...blocks, ...add] : [...blocks.slice(0, recap), ...add, ...blocks.slice(recap)] };
  const seen = new Set();
  const cards = [...cardsOf(doc, topic), ...data.flashcards].filter((c) => {
    const k = String(c.front).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const r = deck.addExternal(doc.classId, doc.moduleId, cards, { noteId: noteIdFor(doc.fileId, topic.id), title: topic.title });
  topic.cardCount = cards.length;
  topic.cardsAdded = (topic.cardsAdded || 0) + r.added.length;
}

/** doc.checks: what was checked, for the status line. */
function summariseChecks(doc, ctx) {
  const c = doc.checks || {};
  if (!ctx.model) { doc.checks = { ...c, skipped: c.skipped || ctx.why || 'no text' }; return; }
  const gaps = doc.topics.reduce((n, t) => n + ((t.gaps && t.gaps.length) || 0), 0);
  const figuresSkipped = doc.topics.reduce((n, t) => n + ((t.figuresSkipped && t.figuresSkipped.length) || 0), 0);
  const pdfMissed = ctx.sendsFile ? doc.topics.filter((t) => t.status === 'ready' && !t.pdfSent).length : 0;
  const figBlocks = doc.topics.filter((t) => t.status === 'ready' && t.lesson)
    .flatMap((t) => t.lesson.blocks.filter((b) => b.kind === 'figure'));
  const figures = figBlocks.filter((b) => !b.svg).length, drawn = figBlocks.length - figures;
  doc.checks = { ...c, pages: ctx.model.max, content: ctx.model.content.length, gaps, figuresSkipped, pdfMissed, figures, drawn };
  delete doc.checks.skipped;
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
    const ctx = await contextOf(pdf, active);
    const cls = store.getClass(doc.classId);
    const className = cls ? [cls.code, cls.name].filter(Boolean).join(' — ') : '';
    const pool = async (items, fn) => { for (const x of items) await fn(x); };
    try {
      await writeTopic(doc, topic, pdf, className, ctx);
      await fillGaps(doc, className, ctx, pool, topic.id);
    } finally {
      const failed = doc.topics.filter((t) => t.status === 'failed').length;
      doc.status = failed ? 'partial' : 'ready';
      doc.error = failed ? doc.error : '';
      summariseChecks(doc, ctx);
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
  STYLES, KINDS, TOPICS_SCHEMA, LESSON_SCHEMA, topicsPrompt, lessonPrompt, gapsPrompt, STYLE_GUIDE,
  validateTopics, validateLesson, validateQuestions, cleanSvg, placeFigures, mergeDocs,
  tokensOf, parsePages, pageItems, sourceModel, sourceText, groundTopics, fallbackTopics, lessonText, itemMissing,
  lessonRecall, setPageReader, setPageRenderer,
  load, peek, run, regenerate, remove, setProgress, resume, isRunning, waitingOf, noteIdFor, notePrefixFor,
};
