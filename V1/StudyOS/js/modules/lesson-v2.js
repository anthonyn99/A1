/* ============================================================================
 * StudyOS — v2 lessons: schema, prompt, validation, lint  (pure, no imports)
 * ============================================================================
 * A v2 lesson is 6-10 typed STEPS (hook, concept, diagram, code, walkthrough,
 * compare, check, trap, practice, recap — plus `figure`, a page of the
 * document) with diagrams as DATA that StudyOS draws itself (diagram.js) —
 * never SVG written by the model.
 *
 * Stored as topic.lesson = { version: 2, title, summary, whyItMatters,
 *   prerequisites, estMinutes, runningExample, steps, cheatSheet }.
 * A lesson with no `version` is a v1 lesson ({blocks}) and renders as before.
 *
 * Two shapes:
 *   WIRE   what the model sends: flat, every field present, unused ones empty
 *          ("" / [] / 0 / false, diagram kind "none"). Strict JSON-schema
 *          modes (OpenAI, Anthropic) need that; chat models may omit fields.
 *   STORED what validateLessonV2 returns: empty fields dropped, ids checked,
 *          answers matched, an empty diagram filled from the running example.
 * ------------------------------------------------------------------------- */

export const STEP_TYPES = ['hook', 'concept', 'diagram', 'code', 'walkthrough', 'compare', 'check', 'trap', 'practice', 'recap', 'figure'];
export const DIAGRAM_KINDS = ['tree', 'linkedlist', 'array', 'nodebox', 'stack', 'queue', 'table', 'flow', 'timeline'];
export const CALLOUT_KINDS = ['key', 'trap', 'analogy', 'exam', 'tip'];
export const CHECK_FORMATS = ['mcq', 'short', 'predict-output', 'order', 'fill-blank'];
export const CARD_TAGS = ['definition', 'code', 'trap', 'complexity'];
export const STEP_LABEL = { hook: 'Why it matters', concept: 'Concept', diagram: 'Diagram', code: 'Code', walkthrough: 'Walkthrough',
  compare: 'Compare', check: 'Check', trap: 'Trap', practice: 'Practice', recap: 'Recap', figure: 'Figure' };

export const MAX_STEPS = 10;
export const MAX_STEPS_FILLED = 14;       // after the gap follow-up adds steps
const BODY_FLAG = 80, BODY_REASK = 120;

// ── Wire schema ──────────────────────────────────────────────────────────
const str = { type: 'string' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const strArr = { type: 'array', items: str };
const arrOf = (items) => ({ type: 'array', items });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

const LABEL = obj({ target: str, text: str });
const NODE = obj({ id: str, value: str });
const EDGE = obj({ from: str, to: str, side: { type: 'string', enum: ['left', 'right'] } });
const LINK = obj({ from: str, to: str, dir: { type: 'string', enum: ['next', 'prev'] } });
const PATCH = obj({ nodes: arrOf(NODE), edges: arrOf(EDGE), links: arrOf(LINK), cells: strArr, items: strArr });
const FRAME = obj({ highlight: strArr, labels: arrOf(LABEL), note: str, patch: PATCH });
const DIAGRAM = obj({
  id: str, kind: { type: 'string', enum: ['none', ...DIAGRAM_KINDS] }, caption: str,
  highlight: strArr, dim: strArr, labels: arrOf(LABEL), frames: arrOf(FRAME),
  root: str, nodes: arrOf(NODE), edges: arrOf(EDGE), showNulls: bool,
  links: arrOf(LINK), pointers: arrOf(obj({ name: str, target: str, index: int })), circular: bool, doubly: bool,
  cells: strArr, capacity: int, indices: bool,
  className: str, fields: arrOf(obj({ name: str, value: str, pointsTo: str })),
  items: strArr, headers: strArr, rows: arrOf(strArr),
  boxes: arrOf(obj({ id: str, text: str, shape: { type: 'string', enum: ['rect', 'diamond', 'pill'] } })),
  arrows: arrOf(obj({ from: str, to: str, label: str })), direction: { type: 'string', enum: ['TB', 'LR'] },
  events: arrOf(obj({ id: str, date: str, label: str })),
});
const CODE = obj({ language: str, source: str, annotations: arrOf(obj({ line: int, note: str, highlight: strArr })) });
const CHECK = obj({ format: { type: 'string', enum: CHECK_FORMATS }, prompt: str, options: strArr, answer: strArr, explanation: str, diagram: DIAGRAM });
const PANEL = obj({ label: str, body: str, diagram: DIAGRAM, code: CODE });
const STEP = obj({
  type: { type: 'string', enum: STEP_TYPES }, heading: str, body: str,
  diagram: DIAGRAM, code: CODE, callouts: arrOf(obj({ kind: { type: 'string', enum: CALLOUT_KINDS }, text: str })),
  check: CHECK, compare: obj({ left: PANEL, right: PANEL }), takeaways: strArr, page: int,
});
export const LESSON_V2_SCHEMA = obj({
  title: str, summary: str, whyItMatters: str, prerequisites: strArr, estMinutes: int,
  runningExample: DIAGRAM, steps: arrOf(STEP),
  cheatSheet: obj({ diagram: DIAGRAM, bullets: strArr, code: CODE,
    complexities: arrOf(obj({ op: str, best: str, avg: str, worst: str })) }),
  flashcards: arrOf(obj({ front: str, back: str, tag: { type: 'string', enum: CARD_TAGS } })),
});
export const GAPS_V2_SCHEMA = obj({ steps: arrOf(STEP) });

// ── Prompt ───────────────────────────────────────────────────────────────
/* The shape, as the model reads it best: types, not a JSON Schema. */
export const LESSON_TYPES = `type Lesson = {
  title: string; summary: string;            // summary: one sentence
  whyItMatters: string;                      // <= 40 words: a real use + how exams test it
  prerequisites: string[];                   // short labels
  estMinutes: number;
  runningExample: Diagram;                   // the ONE example later steps reuse
  steps: Step[];                             // 6-10
  cheatSheet: { diagram: Diagram; bullets: string[] /* <= 6 */; code: CodeBlock;
                complexities: {op: string; best: string; avg: string; worst: string}[] };
  flashcards: {front: string; back: string; tag: "definition"|"code"|"trap"|"complexity"}[]; // 5-10
};
type Step = {
  type: "hook"|"concept"|"diagram"|"code"|"walkthrough"|"compare"|"check"|"trap"|"practice"|"recap"|"figure";
  heading: string;                           // <= 8 words
  body: string;                              // markdown, <= 80 words (code and diagrams don't count)
  diagram: Diagram; code: CodeBlock;
  callouts: {kind: "key"|"trap"|"analogy"|"exam"|"tip"; text: string /* <= 30 words */}[];  // max 2
  check: Check;                              // required for "check" and "practice"
  compare: {left: Panel; right: Panel};      // for "compare"
  takeaways: string[];                       // recap only
  page: number;                              // "figure" only: a figure page of the document
};
type CodeBlock = { language: "java"|"python"|"sql"|"c"|"pseudo"|string; source: string;
  annotations: {line: number /* 1-based */; note: string; highlight: string[] /* diagram ids that light up */}[] };
type Check = { format: "mcq"|"short"|"predict-output"|"order"|"fill-blank"; prompt: string;
  options: string[];                         // mcq choices, or the items to put in order
  answer: string[];                          // mcq: [the right option]; order: the items in the right order;
                                             // short/predict-output/fill-blank: accepted answers. fill-blank prompt has "___"
  explanation: string;                       // <= 40 words: WHY
  diagram: Diagram };
type Panel = { label: string; body: string; diagram: Diagram; code: CodeBlock };
type Diagram = {
  id: string; kind: "none"|"tree"|"linkedlist"|"array"|"nodebox"|"stack"|"queue"|"table"|"flow"|"timeline";
  caption: string;                           // <= 20 words
  highlight: string[]; dim: string[];        // element ids to accent / fade
  labels: {target: string; text: string}[];  // e.g. {target: "n60", text: "root"}
  frames: {highlight: string[]; labels: {target: string; text: string}[]; note: string /* <= 20 words */;
           patch: {nodes; edges; links; cells; items} /* replaces those fields from this frame on; [] = unchanged */}[];
  // tree:       root, nodes [{id, value}], edges [{from, to, side: "left"|"right"}], showNulls
  // linkedlist: nodes, links [{from, to /* "" = null */, dir: "next"|"prev"}], pointers [{name, target}], circular, doubly
  // array:      cells (string; "" = empty slot), capacity, indices, pointers [{name, index}]   — cell ids: c0, c1, …
  // nodebox:    className, fields [{name, value, pointsTo /* "" = null */}]                    — field ids: the field names
  // stack/queue: items (bottom→top / head→tail)                                               — item ids: i0, i1, …
  // table:      headers, rows (string[][])                                                     — row ids: r0, r1, …
  // flow:       boxes [{id, text, shape: "rect"|"diamond"|"pill"}], arrows [{from, to, label}], direction "TB"|"LR"
  // timeline:   events [{id, date, label}]
};
Every field is present; a field a step or diagram does not use is empty ("", [], 0, false; a diagram it does not have is kind "none").
A diagram that repeats the running example may be {"kind": "<same kind>", "nodes": [], ...}: StudyOS fills it from runningExample.`;

/**
 * The lesson ask. The caller supplies what breakdown.js already builds:
 * the source text, the checklist, her instructions block, the card rules.
 */
export function lessonV2Prompt({ className = '', sourceName = '', topic, index = 0, all = [], source = '', attached = true,
  figures = [], figurePages = [], instructionsBlock = '', budget = { min: 5, max: 10 }, written = [], carded = [], objectives = [], note = '' }) {
  const idx = all.findIndex((t) => t.id === topic.id);
  const at = idx < 0 ? index : idx;
  const prev = all.slice(Math.max(0, at - 2), at).map((t) => t.title);
  const next = all.slice(at + 1, at + 3).map((t) => t.title);
  const others = all.filter((t) => t.id !== topic.id).map((t) => `  - ${t.title}`).join('\n');
  const checklist = (topic.key_points || []).map((k) => `  - ${k}`).join('\n') || '  - (use the summary)';
  const owned = written.filter((t) => t.id !== topic.id).map((t) => `  - ${t.title}`).join('\n');
  const already = carded.slice(0, 60).map((f) => `  - ${String(f).slice(0, 160)}`).join('\n');
  const cards = { min: Math.max(3, Math.min(5, budget.min || 5)), max: Math.max(5, Math.min(10, budget.max || 10)) };
  return `You are an expert teacher writing one lesson for a university student who is a visual learner.
Turn the SOURCE (lecture slide text for one topic) into a lesson that is easy to understand,
quick to read and built for memory.

OUTPUT: a single JSON object matching the Lesson type below. No prose outside the JSON.
<schema>
${LESSON_TYPES}
</schema>

RULES
- Accuracy first. Use only facts in SOURCE or standard textbook knowledge for this course.
  Keep the course's exact names (class names, method names, notation).
- 6-10 steps. Step 1 = "hook", last = "recap".
- Each step: ONE idea, body <= 80 words. Short sentences. Define a term the first time it appears.
  No paragraph longer than 3 sentences. **Bold** only the 1-3 most important terms of a step.
- Never two text-only steps in a row. A step is text-only if it has no diagram, code, check or compare.
- Show, then tell: if a concept has a shape (tree, list, array, memory, flow, timeline, comparison), give it a diagram.
  Concrete before abstract: lead with an example, then the rule.
- Pick ONE running example early (store it in runningExample) and reuse it in later diagrams,
  checks and walkthroughs.
- Diagrams: output DATA only, using the Diagram type. Never output SVG or ASCII art.
- Choose diagram kinds that fit the subject; for non-technical topics prefer timeline, compare, flow and table.
- Algorithms: include a "walkthrough" with 3-8 frames tracing the running example
  (e.g. searching 57: frames highlight 60, then 55, then 57, notes like "57 < 60 → go left").
- Code: include the key code from SOURCE. Annotate the 2-5 most important lines and link them to
  diagram ids with \`highlight\`.
- Checks: at least one "check" or "practice" every 3 steps. Ask the student to PREDICT or RECALL
  (e.g. "what is root.left.right?", "what order does inorder visit?"), not "which statement is true".
  The explanation says WHY. A "practice" step is a worked example with ONE blank (format "fill-blank").
- Include a "trap" step for the most common mistake or edge case (null, empty, single element,
  off-by-one, duplicates, worst case).
- If the topic builds on an earlier one (${prev.length ? prev.join('; ') : 'none listed'}), add a "compare" step connecting them.
- Callouts: max 2 per step; use "analogy" once, early, with a concrete everyday analogy.
- whyItMatters: a real-world use + how it's tested on exams, <= 40 words.
- cheatSheet: the running-example diagram, <= 6 bullets, the single most important code snippet,
  and a Big-O table if relevant.
- flashcards: ${cards.min}-${cards.max}. One fact per card. Mix definition / code / trap / complexity.
  Front is a question, not a fill-in-the-blank of a whole sentence. Never a card about slides, pages or the textbook.${owned ? `
  Do not repeat a concept another topic of this document owns:
${owned}` : ''}${already ? `
  These cards already exist in this class — do not duplicate them:
${already}` : ''}
- Tone: clear, direct, a bit conversational. No filler ("In this lesson we will…"), no hype.
- Teach the subject, not the document: never mention pages, slides, "the document" or "the source"; no citation markers like [1].
${figurePages.length ? `- The document has a figure on ${figurePages.length === 1 ? 'page' : 'pages'} ${figurePages.join(', ')} of this topic. Where the document's own figure helps,
  show it with a step {"type": "figure", "page": <that page>, "heading": "...", "body": "what to notice"}.
` : ''}${figures.length ? `- ${figures.length === 1 ? `Page ${figures[0]} is` : `Pages ${figures.join(', ')} are`} attached as images: they are part of the source.
` : ''}
THE CHECKLIST — the lesson must teach every one of these:
${checklist}
${objectives.length ? `
LEARNING OBJECTIVES the course states — cover the ones that belong to this topic:
${objectives.slice(0, 20).map((o) => `  - ${o}`).join('\n')}
` : ''}
The other topics of this document are taught in their own lessons — do not teach them here:
${others || '  (none)'}
${note ? `
THE STUDENT ASKED FOR THIS REWRITE: ${String(note).slice(0, 300)}
` : ''}${instructionsBlock}
COURSE: ${className || '(not given)'}
TOPIC: ${topic.title} — ${topic.summary || ''}
NEIGHBOR TOPICS: prev=${prev.join('; ') || 'none'} next=${next.join('; ') || 'none'}
SOURCE${source ? '' : ` (the attached PDF "${sourceName}", ${topic.pages ? `pages ${topic.pages}` : 'this topic\'s pages'})`}:
<<<
${source || `(see the attached document${attached ? '' : ''})`}
>>>`;
}

/** The follow-up for a lesson that failed the lint: the lesson, the problems, no source. */
export function fixV2Prompt(lesson, problems) {
  return `This lesson JSON breaks some rules. Fix ONLY the problems listed and return the WHOLE corrected lesson as ONE JSON object of the same shape (the Lesson type below). Keep everything else as it is; never drop correct content.

PROBLEMS
${problems.map((p) => `- ${p.note}`).join('\n')}

<schema>
${LESSON_TYPES}
</schema>

<lesson>
${JSON.stringify(toWire(lesson)).slice(0, 100000)}
</lesson>`;
}

/** The gap follow-up for a v2 lesson: extra steps that teach the missing lines. */
export function gapsV2Prompt({ className = '', sourceName = '', topic, missing, source = '', instructionsBlock = '' }) {
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
Write ADDITIONAL steps that teach the missing lines: "concept", "diagram", "code", "trap" or "check" steps, the Step type below.
One idea per step, body <= 80 words, never two text-only steps in a row. No hook, no recap, no flashcards.
Teach the subject, not the document: never mention pages, slides or "the document", and no citation markers like [1].
<schema>
${LESSON_TYPES}
</schema>
${instructionsBlock}
Reply with ONE JSON object and nothing else: {"steps": [Step, ...]}`;
}

// ── Validation ───────────────────────────────────────────────────────────
const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const arr = (v) => (Array.isArray(v) ? v : []);
const ident = (v) => s(v, 60);
export const wordCount = (text) => {
  const t = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>|`-]+/g, ' ').trim();
  return t ? t.split(/\s+/).filter((w) => /\w/.test(w)).length : 0;
};
const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/\s+/g, ' ').trim();

/** Every id a diagram's elements can be referred to by. */
export function idsOf(d) {
  if (!d) return new Set();
  const out = new Set();
  const add = (x) => x && out.add(String(x));
  switch (d.kind) {
    case 'tree': case 'linkedlist': (d.nodes || []).forEach((n) => add(n.id)); break;
    case 'array': (d.cells || []).forEach((_, i) => add('c' + i)); for (let i = (d.cells || []).length; i < (d.capacity || 0); i++) add('c' + i); break;
    case 'nodebox': (d.fields || []).forEach((f) => add(f.name)); break;
    case 'stack': case 'queue': (d.items || []).forEach((_, i) => add('i' + i)); break;
    case 'table': (d.rows || []).forEach((_, i) => add('r' + i)); break;
    case 'flow': (d.boxes || []).forEach((b) => add(b.id)); break;
    case 'timeline': (d.events || []).forEach((e) => add(e.id)); break;
  }
  (d.frames || []).forEach((f) => {
    if (!f.patch) return;
    (f.patch.nodes || []).forEach((n) => add(n.id));
    (f.patch.cells || []).forEach((_, i) => add('c' + i));
    (f.patch.items || []).forEach((_, i) => add('i' + i));
  });
  return out;
}

/** A binary tree: one parent per node, at most one left and one right child,
 *  every node reachable from the root. */
export function validTree(nodes, edges, root) {
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) return false;
  if (!nodes.length) return true;
  if (!ids.has(root)) return false;
  const parent = new Map(), sides = new Set(), kids = new Map();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) return false;
    if (e.side !== 'left' && e.side !== 'right') return false;
    if (parent.has(e.to)) return false;
    const k = e.from + ':' + e.side;
    if (sides.has(k)) return false;
    sides.add(k);
    parent.set(e.to, e.from);
    (kids.get(e.from) || kids.set(e.from, []).get(e.from)).push(e.to);
  }
  if (parent.has(root)) return false;
  const seen = new Set([root]);
  const todo = [root];
  while (todo.length) for (const c of kids.get(todo.pop()) || []) { if (seen.has(c)) return false; seen.add(c); todo.push(c); }
  return seen.size === ids.size;
}

const nodesOf = (v) => {
  const seen = new Set();
  return arr(v).map((n) => ({ id: ident(n && n.id), value: s(n && n.value, 40) }))
    .filter((n) => n.id && !seen.has(n.id) && seen.add(n.id)).slice(0, 40);
};
const edgesOf = (v) => arr(v).map((e) => ({ from: ident(e && e.from), to: ident(e && e.to), side: e && e.side === 'right' ? 'right' : (e && e.side === 'left' ? 'left' : '') }))
  .filter((e) => e.from && e.to && e.side).slice(0, 60);
const linksOf = (v) => arr(v).map((l) => ({ from: ident(l && l.from), to: ident(l && l.to) || null, dir: l && l.dir === 'prev' ? 'prev' : 'next' }))
  .filter((l) => l.from).slice(0, 60);
const labelsOf = (v) => arr(v).map((l) => ({ target: ident(l && l.target), text: s(l && l.text, 30) })).filter((l) => l.target && l.text).slice(0, 12);
const strsOf = (v, max = 40, n = 40) => arr(v).map((x) => s(x, max));

/** Empty structure: the model meant "the running example". */
function isEmptyDiagram(d) {
  switch (d.kind) {
    case 'tree': case 'linkedlist': return !d.nodes.length;
    case 'array': return !d.cells.length && !d.capacity;
    case 'nodebox': return !d.fields.length;
    case 'stack': case 'queue': return !d.items.length;
    case 'table': return !d.headers.length && !d.rows.length;
    case 'flow': return !d.boxes.length;
    case 'timeline': return !d.events.length;
  }
  return true;
}

const STRUCT = ['root', 'nodes', 'edges', 'showNulls', 'links', 'pointers', 'circular', 'doubly', 'cells', 'capacity', 'indices',
  'className', 'fields', 'items', 'headers', 'rows', 'boxes', 'arrows', 'direction', 'events'];

/** An empty diagram of the running example's kind takes its structure, and
 *  keeps its own id, caption, highlights, labels and frames. */
export function fillFromRunning(d, running) {
  if (!d || !running || d.kind !== running.kind || !d._empty) return d;
  const out = { ...d };
  for (const k of STRUCT) if (running[k] !== undefined) out[k] = running[k];
  if (!out.labels || !out.labels.length) out.labels = running.labels || [];
  delete out._empty;
  return out;
}

/**
 * One diagram, normalised, or null (no diagram / unusable).
 * `running`: the running example, to fill an empty diagram from.
 */
export function normDiagram(raw, running = null, fallbackId = 'd') {
  if (!raw || typeof raw !== 'object' || !DIAGRAM_KINDS.includes(raw.kind)) return null;
  const k = raw.kind;
  const d = { id: ident(raw.id) || fallbackId, kind: k };
  const cap = s(raw.caption, 200);
  if (cap) d.caption = cap;
  if (k === 'tree') {
    d.nodes = nodesOf(raw.nodes); d.edges = edgesOf(raw.edges);
    d.root = ident(raw.root) || (d.nodes.find((n) => !d.edges.some((e) => e.to === n.id)) || {}).id || '';
    if (raw.showNulls) d.showNulls = true;
  } else if (k === 'linkedlist') {
    d.nodes = nodesOf(raw.nodes); d.links = linksOf(raw.links);
    d.pointers = arr(raw.pointers).map((p) => ({ name: s(p && p.name, 20), target: ident(p && p.target) || null })).filter((p) => p.name).slice(0, 6);
    if (raw.circular) d.circular = true;
    if (raw.doubly) d.doubly = true;
  } else if (k === 'array') {
    d.cells = arr(raw.cells).slice(0, 24).map((c) => (c == null || String(c).trim() === '' ? null : s(c, 20)));
    const capn = Number.isInteger(raw.capacity) ? raw.capacity : 0;
    d.capacity = Math.min(24, Math.max(capn, 0));
    if (raw.indices || raw.indices === undefined) d.indices = raw.indices !== false;
    d.pointers = arr(raw.pointers).map((p) => ({ name: s(p && p.name, 20), index: Number.isInteger(p && p.index) ? p.index : -1 }))
      .filter((p) => p.name && p.index >= 0 && p.index < Math.max(d.cells.length, d.capacity)).slice(0, 6);
  } else if (k === 'nodebox') {
    d.className = s(raw.className, 60) || 'Node';
    d.fields = arr(raw.fields).map((f) => ({ name: s(f && f.name, 40), value: s(f && f.value, 40), pointsTo: s(f && f.pointsTo, 40) || null }))
      .filter((f) => f.name).slice(0, 8);
  } else if (k === 'stack' || k === 'queue') {
    d.items = strsOf(raw.items, 30).filter(Boolean).slice(0, 16);
  } else if (k === 'table') {
    d.headers = strsOf(raw.headers, 60).slice(0, 8);
    const w = d.headers.length;
    d.rows = arr(raw.rows).slice(0, 16).map((r) => { const row = strsOf(r, 120).slice(0, w || 8); while (w && row.length < w) row.push(''); return row; });
  } else if (k === 'flow') {
    const seen = new Set();
    d.boxes = arr(raw.boxes).map((b) => ({ id: ident(b && b.id), text: s(b && b.text, 80), shape: ['diamond', 'pill'].includes(b && b.shape) ? b.shape : 'rect' }))
      .filter((b) => b.id && b.text && !seen.has(b.id) && seen.add(b.id)).slice(0, 16);
    d.arrows = arr(raw.arrows).map((a) => ({ from: ident(a && a.from), to: ident(a && a.to), label: s(a && a.label, 30) }))
      .filter((a) => seen.has(a.from) && seen.has(a.to) && a.from !== a.to).slice(0, 30);
    d.direction = raw.direction === 'LR' ? 'LR' : 'TB';
  } else if (k === 'timeline') {
    const seen = new Set();
    d.events = arr(raw.events).map((e, i) => ({ id: ident(e && e.id) || 'e' + i, date: s(e && e.date, 30), label: s(e && e.label, 80) }))
      .filter((e) => (e.date || e.label) && !seen.has(e.id) && seen.add(e.id)).slice(0, 16);
  }
  if (isEmptyDiagram(d)) {
    if (!running || running.kind !== k) return null;
    d._empty = true;
  }
  d.highlight = strsOf(raw.highlight, 60).filter(Boolean);
  d.dim = strsOf(raw.dim, 60).filter(Boolean);
  d.labels = labelsOf(raw.labels);
  const frames = arr(raw.frames).slice(0, 12).map((f) => {
    const fr = { note: s(f && f.note, 200), highlight: strsOf(f && f.highlight, 60).filter(Boolean), labels: labelsOf(f && f.labels) };
    const p = f && f.patch;
    if (p && typeof p === 'object') {
      const patch = {};
      const nodes = nodesOf(p.nodes), edges = edgesOf(p.edges), links = linksOf(p.links);
      if (nodes.length) patch.nodes = nodes;
      if (edges.length) patch.edges = edges;
      if (links.length) patch.links = links;
      if (arr(p.cells).length) patch.cells = arr(p.cells).slice(0, 24).map((c) => (c == null || String(c).trim() === '' ? null : s(c, 20)));
      if (arr(p.items).length) patch.items = strsOf(p.items, 30).filter(Boolean).slice(0, 16);
      if (Object.keys(patch).length) fr.patch = patch;
    }
    return fr;
  }).filter((f) => f.note || f.highlight.length || f.patch);
  if (frames.length) d.frames = frames;
  let out = fillFromRunning(d, running);
  if (out._empty) delete out._empty;
  // A tree that is not a binary tree is dropped; a frame whose patch breaks it loses the patch.
  if (out.kind === 'tree') {
    if (!validTree(out.nodes, out.edges, out.root)) return null;
    let cur = { nodes: out.nodes, edges: out.edges };
    for (const f of out.frames || []) {
      if (!f.patch) continue;
      const next = { nodes: f.patch.nodes || cur.nodes, edges: f.patch.edges || cur.edges };
      const root = next.nodes.some((n) => n.id === out.root) ? out.root : (next.nodes.find((n) => !next.edges.some((e) => e.to === n.id)) || {}).id;
      if (!validTree(next.nodes, next.edges, root)) delete f.patch; else cur = next;
    }
  }
  if (out.kind === 'linkedlist') {
    const ids = new Set(out.nodes.map((n) => n.id));
    out.links = out.links.filter((l) => ids.has(l.from) && (l.to === null || ids.has(l.to)));
    out.pointers = out.pointers.filter((p) => p.target === null || ids.has(p.target));
  }
  // References to ids that do not exist are dropped (§6.2).
  const ids = idsOf(out);
  out.highlight = out.highlight.filter((x) => ids.has(x));
  out.dim = out.dim.filter((x) => ids.has(x));
  out.labels = out.labels.filter((l) => ids.has(l.target));
  for (const f of out.frames || []) { f.highlight = f.highlight.filter((x) => ids.has(x)); f.labels = f.labels.filter((l) => ids.has(l.target)); }
  for (const key of ['highlight', 'dim', 'labels']) if (!out[key].length) delete out[key];
  return out;
}

function normCode(raw, allIds) {
  if (!raw || typeof raw !== 'object') return null;
  const source = String(raw.source == null ? '' : raw.source).replace(/\r\n?/g, '\n').replace(/\s+$/, '').slice(0, 4000);
  if (!source.trim()) return null;
  const lines = source.split('\n').length;
  const seen = new Set();
  const annotations = arr(raw.annotations).map((a) => ({
    line: Number.isInteger(a && a.line) ? a.line : parseInt(a && a.line, 10),
    note: s(a && a.note, 300),
    highlight: strsOf(a && a.highlight, 60).filter((x) => x && (!allIds || allIds.has(x))),
  })).filter((a) => a.line >= 1 && a.line <= lines && a.note && !seen.has(a.line) && seen.add(a.line)).slice(0, 8)
    .map((a) => (a.highlight.length ? a : { line: a.line, note: a.note }));
  const out = { language: s(raw.language, 20).toLowerCase() || 'pseudo', source };
  if (annotations.length) out.annotations = annotations.sort((a, b) => a.line - b.line);
  return out;
}

function normCheck(raw, running) {
  if (!raw || typeof raw !== 'object') return null;
  const format = CHECK_FORMATS.includes(raw.format) ? raw.format : (arr(raw.options).length >= 2 ? 'mcq' : 'short');
  const prompt = s(raw.prompt || raw.q || raw.question, 600);
  if (!prompt) return null;
  const options = [...new Set(strsOf(raw.options, 240).filter(Boolean))].slice(0, 8);
  let answer = Array.isArray(raw.answer) ? strsOf(raw.answer, 240).filter(Boolean) : (raw.answer != null && String(raw.answer).trim() ? [s(raw.answer, 240)] : []);
  if (!answer.length) return null;
  const out = { format, prompt, explanation: s(raw.explanation, 500) };
  if (format === 'mcq') {
    if (options.length < 2) return null;
    const hit = options.find((o) => norm(o) === norm(answer[0]));
    if (!hit) return null;
    out.options = options; out.answer = hit;
  } else if (format === 'order') {
    const items = answer.length >= 2 ? answer : options;
    const pool = options.length ? options : items;
    if (items.length < 2 || pool.length !== items.length || !items.every((x) => pool.some((o) => norm(o) === norm(x)))) return null;
    out.options = pool; out.answer = items.map((x) => pool.find((o) => norm(o) === norm(x)));
  } else {
    if (format === 'fill-blank' && !/_{3,}|\{\{blank\}\}/.test(prompt)) out.prompt = prompt + ' ___';
    out.answer = answer.length === 1 ? answer[0] : answer.slice(0, 6);
  }
  const d = normDiagram(raw.diagram, running, 'q');
  if (d) out.diagram = d;
  return out;
}

function normPanel(raw, running, allIds, id) {
  if (!raw || typeof raw !== 'object') return null;
  const p = { label: s(raw.label, 80) };
  const body = s(raw.body, 1200);
  if (body) p.body = body;
  const d = normDiagram(raw.diagram, running, id);
  if (d) p.diagram = d;
  const c = normCode(raw.code, allIds);
  if (c) p.code = c;
  return p.label && (p.body || p.diagram || p.code) ? p : null;
}

/** A step is text-only when it has no diagram, code, check, compare or figure. */
export const isTextOnly = (st) => !st.diagram && !st.code && !st.check && !st.compare && st.type !== 'figure';

/** Every diagram id in a raw lesson, before references are checked. */
function rawIds(o, running) {
  const all = new Set(running ? idsOf(running) : []);
  const visit = (d) => { const n = normDiagram(d, running); if (n) idsOf(n).forEach((x) => all.add(x)); };
  for (const st of arr(o && o.steps)) {
    if (!st) continue;
    visit(st.diagram);
    if (st.check) visit(st.check.diagram);
    if (st.compare) { visit(st.compare.left && st.compare.left.diagram); visit(st.compare.right && st.compare.right.diagram); }
  }
  return all;
}

/**
 * The model's steps, checked. `clean`: text hygiene (citations, sentences
 * about the document); returns [text, strippedCount].
 */
export function validateSteps(list, { running = null, allIds = null, figurePages = [], clean = (t) => [t, 0] } = {}) {
  let stripped = 0;
  const c = (t, max) => { const [v, n] = clean(s(t, max)); stripped += n; return v; };
  const ids = allIds || rawIds({ steps: list }, running);
  const steps = [];
  const figSeen = new Set();
  arr(list).forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    let type = STEP_TYPES.includes(raw.type) ? raw.type : (raw.type === 'example' || raw.type === 'read' ? 'concept' : '');
    if (!type) return;
    const st = { type, heading: s(raw.heading || raw.title, 120) };
    const body = c(raw.body || raw.markdown, 2400);
    if (body) st.body = body;
    if (type === 'figure') {
      const page = Number.isInteger(raw.page) ? raw.page : parseInt(raw.page, 10);
      if (!figurePages.includes(page) || figSeen.has(page)) return;
      figSeen.add(page);
      st.page = page;
      steps.push(st);
      return;
    }
    const d = normDiagram(raw.diagram, running, 's' + i);
    if (d) st.diagram = d;
    const code = normCode(raw.code, ids);
    if (code) st.code = code;
    const callouts = arr(raw.callouts).map((x) => ({ kind: CALLOUT_KINDS.includes(x && x.kind) ? x.kind : '', text: c(x && x.text, 400) }))
      .filter((x) => x.kind && x.text).slice(0, 2);
    if (callouts.length) st.callouts = callouts;
    if (type === 'check' || type === 'practice') {
      const chk = normCheck(raw.check, running);
      if (!chk) {
        // A check with no usable question still teaches if it has a body.
        if (!body && !d && !code) return;
        st.type = 'concept';
      } else st.check = chk;
    }
    if (type === 'compare') {
      const cmp = raw.compare || {};
      const left = normPanel(cmp.left, running, ids, 's' + i + 'L'), right = normPanel(cmp.right, running, ids, 's' + i + 'R');
      if (left && right) st.compare = { left, right };
      else if (!body && !d && !code) return;
      else st.type = 'concept';
    }
    if (type === 'recap') {
      const takeaways = arr(raw.takeaways || raw.points).map((x) => c(x, 400)).filter(Boolean).slice(0, 10);
      if (takeaways.length) st.takeaways = takeaways;
      else if (!body) return;
    }
    if (type === 'walkthrough' && !(st.diagram && (st.diagram.frames || []).length >= 2)) st.type = st.diagram ? 'diagram' : 'concept';
    if (st.type === 'diagram' && !st.diagram) st.type = 'concept';
    if (st.type === 'code' && !st.code) st.type = 'concept';
    if (!st.body && isTextOnly(st) && st.type !== 'recap') return;
    steps.push(st);
  });
  return { steps, stripped };
}

/**
 * The model's lesson, checked: { value: Lesson } or { error }.
 * The lint (word counts, sequence rules) is separate — lintLessonV2 — so a
 * lesson that breaks a style rule is still usable while it is fixed.
 */
export function validateLessonV2(o, { figurePages = [], clean = (t) => [t, 0], cards = true, maxSteps = MAX_STEPS + 2 } = {}) {
  if (!o || typeof o !== 'object') return { error: 'the answer was not a lesson object' };
  const running = normDiagram(o.runningExample, null, 'ex');
  if (running && running._empty) delete running._empty;
  const allIds = rawIds(o, running);
  const { steps: all, stripped } = validateSteps(o.steps, { running, allIds, figurePages, clean });
  // The recap stays last whatever the cap cuts.
  const recapAt = all.findIndex((x) => x.type === 'recap');
  const recap = recapAt >= 0 ? all[recapAt] : null;
  let steps = all.filter((x) => x !== recap);
  steps = steps.slice(0, maxSteps - (recap ? 1 : 0));
  if (recap) steps.push(recap);
  if (steps.length < 3) return { error: `the lesson had only ${steps.length} usable steps` };
  if (!steps.some((x) => x.type !== 'check' && x.type !== 'practice' && x.type !== 'recap' && (x.body || x.diagram || x.code || x.compare))) {
    return { error: 'the lesson had checks but no teaching' };
  }
  const lesson = {
    version: 2,
    title: s(o.title, 160),
    summary: s(o.summary, 400),
    whyItMatters: s(o.whyItMatters, 400),
    prerequisites: strsOf(o.prerequisites, 60).filter(Boolean).slice(0, 5),
    estMinutes: 0,
    steps,
  };
  if (running) lesson.runningExample = running;
  const cs = o.cheatSheet || {};
  const sheet = { bullets: strsOf(cs.bullets, 240).filter(Boolean).slice(0, 6) };
  const sd = normDiagram(cs.diagram, running, 'cs') || running;
  if (sd) sheet.diagram = sd;
  const scode = normCode(cs.code, null);
  if (scode) { delete scode.annotations; sheet.code = scode; }
  const cx = arr(cs.complexities).map((x) => ({ op: s(x && x.op, 60), best: s(x && x.best, 30), avg: s(x && x.avg, 30), worst: s(x && x.worst, 30) }))
    .filter((x) => x.op && x.worst).slice(0, 8);
  if (cx.length) sheet.complexities = cx;
  if (!sheet.bullets.length) {
    const r = steps.find((x) => x.type === 'recap');
    sheet.bullets = ((r && r.takeaways) || []).slice(0, 6);
  }
  lesson.cheatSheet = sheet;
  const est = Number.isFinite(+o.estMinutes) ? Math.round(+o.estMinutes) : 0;
  lesson.estMinutes = est >= 1 && est <= 60 ? est : estimateMinutes(lesson);
  if (!cards) return { value: { lesson, flashcards: [], stripped } };
  const seen = new Set();
  const flashcards = [];
  for (const f of arr(o.flashcards)) {
    const front = c0(clean, f && f.front, 400), back = c0(clean, f && f.back, 800);
    const key = norm(front);
    if (!front || !back || seen.has(key) || key === norm(back)) continue;
    seen.add(key);
    flashcards.push({ front, back, tag: CARD_TAGS.includes(f && f.tag) ? f.tag : 'definition' });
    if (flashcards.length >= 12) break;
  }
  if (!flashcards.length) return { error: 'the lesson came with no flashcards' };
  return { value: { lesson, flashcards, stripped } };
}
const c0 = (clean, t, max) => clean(s(t, max))[0];

/** ~minutes to read the lesson and answer its checks. */
export function estimateMinutes(lesson) {
  const words = (lesson.steps || []).reduce((n, st) => n + wordCount(st.body) + (st.code ? 20 : 0) + (st.diagram ? 15 : 0), 0);
  const checks = (lesson.steps || []).filter((x) => x.check).length;
  return Math.max(2, Math.round(words / 180 + checks * 0.6 + (lesson.steps || []).length * 0.15));
}

// ── Lint (§2 sequence rules, §6 repair) ──────────────────────────────────
/**
 * What breaks the rules. Each problem: { step (1-based, 0 = the lesson),
 * note (what to fix, for the fix ask), reask (worth a fix ask) }.
 */
export function lintLessonV2(lesson) {
  const steps = (lesson && lesson.steps) || [];
  const out = [];
  const add = (step, note, reask) => out.push({ step, note, reask });
  if (!steps.length) { add(0, 'the lesson has no steps', true); return out; }
  if (steps[0].type !== 'hook') add(1, 'step 1 must be a "hook" step (why care / analogy / what you will be able to do)', true);
  if (steps[steps.length - 1].type !== 'recap') add(steps.length, 'the last step must be a "recap" step with takeaways', true);
  const n = steps.length;
  if (n < 6) add(0, `the lesson has ${n} steps; it needs 6-10`, n < 5);
  steps.forEach((st, i) => {
    const w = wordCount(st.body);
    if (w > BODY_REASK) add(i + 1, `step ${i + 1} ("${st.heading}") has ${w} words of body; cut it to at most 80 (split it into two steps if needed)`, true);
    else if (w > BODY_FLAG) add(i + 1, `step ${i + 1} ("${st.heading}") has ${w} words of body; at most 80`, false);
    const hw = wordCount(st.heading);
    if (hw > 8) add(i + 1, `step ${i + 1}'s heading has ${hw} words; at most 8`, false);
    if (i > 0 && isTextOnly(st) && isTextOnly(steps[i - 1]) && st.type !== 'recap') {
      add(i + 1, `steps ${i} and ${i + 1} are both text-only: add a diagram or check to step ${i + 1}`, true);
    }
  });
  const checks = steps.filter((x) => x.check).length;
  const need = Math.floor((n - 1) / 3);
  if (checks < Math.max(1, need)) add(0, `the lesson has ${checks} check/practice steps; it needs at least one every 3 steps (${Math.max(1, need)})`, true);
  return out;
}

/** True when a fix ask is worth making. */
export const needsFix = (problems) => problems.some((p) => p.reask);
/** A lesson's lint, as a single number: fewer is better. */
export const badness = (problems) => problems.reduce((k, p) => k + (p.reask ? 10 : 1), 0);

// ── For the checks against the document ──────────────────────────────────
function diagramText(d) {
  if (!d) return [];
  return [d.caption || '', ...(d.nodes || []).map((x) => x.value), ...(d.cells || []).map((x) => x || ''), ...(d.items || []),
    d.className || '', ...(d.fields || []).flatMap((f) => [f.name, f.value]), ...(d.headers || []), ...(d.rows || []).flat(),
    ...(d.boxes || []).map((b) => b.text), ...(d.arrows || []).map((a) => a.label), ...(d.events || []).flatMap((e) => [e.date, e.label]),
    ...(d.frames || []).map((f) => f.note)];
}
const codeText = (c) => (c ? [c.source, ...(c.annotations || []).map((a) => a.note)] : []);

/** The lesson as v1-shaped blocks — for the checks that read lessons
 *  (sanityProblem, lessonText, the gap pass). Teaching steps become `read`
 *  blocks, checks `check`-like text, the recap `recap`. */
export function asBlocks(lesson) {
  const out = [];
  if (!lesson) return out;
  if (lesson.whyItMatters) out.push({ kind: 'read', title: '', markdown: lesson.whyItMatters });
  for (const st of lesson.steps || []) {
    const text = [st.body || '', ...(st.callouts || []).map((c) => c.text), ...codeText(st.code), ...diagramText(st.diagram)];
    if (st.compare) for (const p of [st.compare.left, st.compare.right]) text.push(p.label, p.body || '', ...codeText(p.code), ...diagramText(p.diagram));
    if (st.type === 'recap') { out.push({ kind: 'recap', title: st.heading, points: st.takeaways || [], markdown: st.body || '' }); continue; }
    if (st.type === 'figure') { out.push({ kind: 'figure', title: st.heading, markdown: st.body || '', page: st.page, svg: '' }); continue; }
    if (st.check) {
      const q = st.check;
      out.push({ kind: 'check', title: st.heading, markdown: '', questions: [{ q: q.prompt, choices: q.options || [],
        answer: Array.isArray(q.answer) ? q.answer.join(' ') : q.answer, explanation: q.explanation || '' }] });
      if (text.join('').trim()) out.push({ kind: 'read', title: '', markdown: text.join('\n') });
      continue;
    }
    out.push({ kind: 'read', title: st.heading, markdown: text.filter(Boolean).join('\n') });
  }
  const cs = lesson.cheatSheet;
  if (cs) out.push({ kind: 'read', title: '', markdown: [...(cs.bullets || []), ...codeText(cs.code), ...(cs.complexities || []).map((x) => `${x.op} ${x.worst}`)].join('\n') });
  return out;
}

/** Back to the wire shape, for a fix ask (every field present). */
export function toWire(lesson) {
  const D = (d) => ({ id: '', kind: 'none', caption: '', highlight: [], dim: [], labels: [], frames: [], root: '', nodes: [], edges: [], showNulls: false,
    links: [], pointers: [], circular: false, doubly: false, cells: [], capacity: 0, indices: false, className: '', fields: [], items: [],
    headers: [], rows: [], boxes: [], arrows: [], direction: 'TB', events: [],
    ...(d || {}),
    ...(d && d.links ? { links: d.links.map((l) => ({ ...l, to: l.to || '' })) } : {}),
    ...(d && d.fields ? { fields: d.fields.map((f) => ({ ...f, pointsTo: f.pointsTo || '' })) } : {}),
    ...(d && d.cells ? { cells: d.cells.map((c) => c || '') } : {}),
    ...(d && d.pointers ? { pointers: d.pointers.map((p) => ({ name: p.name, target: p.target || '', index: p.index == null ? 0 : p.index })) } : {}),
    ...(d && d.frames ? { frames: d.frames.map((f) => ({ highlight: f.highlight || [], labels: f.labels || [], note: f.note || '',
      patch: { nodes: [], edges: [], links: [], cells: [], items: [], ...(f.patch || {}) } })) } : {}) });
  const C = (c) => ({ language: '', source: '', annotations: [], ...(c || {}),
    ...(c && c.annotations ? { annotations: c.annotations.map((a) => ({ highlight: [], ...a })) } : {}) });
  const P = (p) => ({ label: '', body: '', ...(p || {}), diagram: D(p && p.diagram), code: C(p && p.code) });
  return {
    title: lesson.title || '', summary: lesson.summary || '', whyItMatters: lesson.whyItMatters || '',
    prerequisites: lesson.prerequisites || [], estMinutes: lesson.estMinutes || 0,
    runningExample: D(lesson.runningExample),
    steps: (lesson.steps || []).map((st) => ({
      type: st.type, heading: st.heading || '', body: st.body || '', diagram: D(st.diagram), code: C(st.code), callouts: st.callouts || [],
      check: st.check ? { format: st.check.format, prompt: st.check.prompt, options: st.check.options || [],
        answer: Array.isArray(st.check.answer) ? st.check.answer : [st.check.answer], explanation: st.check.explanation || '', diagram: D(st.check.diagram) }
        : { format: 'short', prompt: '', options: [], answer: [], explanation: '', diagram: D(null) },
      compare: st.compare ? { left: P(st.compare.left), right: P(st.compare.right) } : { left: P(null), right: P(null) },
      takeaways: st.takeaways || [], page: st.page || 0,
    })),
    cheatSheet: { diagram: D(lesson.cheatSheet && lesson.cheatSheet.diagram), bullets: (lesson.cheatSheet && lesson.cheatSheet.bullets) || [],
      code: C(lesson.cheatSheet && lesson.cheatSheet.code), complexities: (lesson.cheatSheet && lesson.cheatSheet.complexities) || [] },
    flashcards: lesson.flashcards || [],
  };
}

// ── Cards ────────────────────────────────────────────────────────────────
export const normFront = (f) => String(f || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** v2 cards → the deck's items (filterCards / addExternal). The first ~60%
 *  are core. Cards whose normalised front a topic already holds are skipped. */
export function cardItems(flashcards, existingFronts = []) {
  const have = new Set(existingFronts.map(normFront));
  const list = (flashcards || []).filter((c) => !have.has(normFront(c.front)));
  const core = Math.ceil(list.length * 0.6);
  return list.map((c, i) => ({ kind: 'basic', front: c.front, back: c.back, extra: '', priority: i < core ? 1 : 2, tags: c.tag ? [c.tag] : [] }));
}

/** A card from a check she got wrong. */
export function cardFromCheck(check) {
  if (!check) return null;
  const ans = Array.isArray(check.answer) ? (check.format === 'order' ? check.answer.join(' → ') : check.answer[0]) : check.answer;
  if (!check.prompt || !ans) return null;
  return { kind: 'basic', front: check.prompt.replace(/\{\{blank\}\}/g, '___'), back: String(ans), extra: check.explanation || '', priority: 1 };
}

/** Steps added by the gap pass go before the recap; at most MAX_STEPS_FILLED. */
export function insertSteps(lesson, add) {
  const steps = lesson.steps || [];
  const extra = (add || []).filter((x) => x.type !== 'recap' && x.type !== 'hook');
  const r = steps.findIndex((x) => x.type === 'recap');
  const joined = r < 0 ? [...steps, ...extra] : [...steps.slice(0, r), ...extra, ...steps.slice(r)];
  if (joined.length <= MAX_STEPS_FILLED) return { ...lesson, steps: joined };
  const recap = joined.find((x) => x.type === 'recap');
  const body = joined.filter((x) => x !== recap).slice(0, MAX_STEPS_FILLED - (recap ? 1 : 0));
  return { ...lesson, steps: recap ? [...body, recap] : body };
}

export const isV2 = (lesson) => !!lesson && lesson.version === 2 && Array.isArray(lesson.steps);

export default {
  STEP_TYPES, DIAGRAM_KINDS, CALLOUT_KINDS, CHECK_FORMATS, STEP_LABEL, LESSON_V2_SCHEMA, GAPS_V2_SCHEMA, LESSON_TYPES,
  lessonV2Prompt, fixV2Prompt, gapsV2Prompt, validateLessonV2, validateSteps, normDiagram, validTree, idsOf, fillFromRunning,
  lintLessonV2, needsFix, badness, asBlocks, toWire, cardItems, cardFromCheck, insertSteps, isV2, wordCount, estimateMinutes, isTextOnly,
};
