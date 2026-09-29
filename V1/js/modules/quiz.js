/* ============================================================================
 * StudyOS — quiz bank  (engagement upgrade 1.1 / 2.4)
 * ============================================================================
 * Practice questions per class: filled by study kits, drawn on by quiz mode,
 * mock exams and "Start now".
 *
 * Storage: localStorage `studyos_quiz_<classId>` + Firestore
 * `studyos_quiz/{classId}` through synced.js — one document per class, for the
 * same reason cards are (see deck.js).
 *
 * Question:
 *   { id, fp, classId, moduleId, topic, type: 'mcq'|'short'|'trace'|'sql',
 *     prompt, choices?, answer, explanation, dataset?,
 *     source: { kind, jobId, sourceFileId, sourceTitle },
 *     stats: { attempts, correct, lastAt, lastCorrect }, updatedAt }
 *
 * The id is a CONTENT fingerprint (like a card's `fp`), so a re-run kit that
 * produces the same question keeps its answer history instead of resetting it.
 * ------------------------------------------------------------------------- */

import { syncedList } from './synced.js';
import { fingerprint } from './cards.js';

export const TYPES = ['mcq', 'short', 'trace', 'sql'];
const _stores = new Map();

function storeFor(classId) {
  if (!_stores.has(classId)) {
    _stores.set(classId, syncedList({
      kind: 'quiz',
      lsKey: 'studyos_quiz_' + classId,
      docPath: 'studyos_quiz/' + classId,
    }));
  }
  return _stores.get(classId);
}

/** Load each class's bank from the cloud and keep it current. */
export function connect(classIds) {
  for (const id of classIds || []) if (id) storeFor(id).connect();
}

export function forClass(classId) {
  return classId ? storeFor(classId).all() : [];
}

export function get(classId, id) {
  return storeFor(classId).get(id);
}

export function countsFor(classId) {
  const list = forClass(classId);
  return {
    total: list.length,
    unattempted: list.filter((q) => !(q.stats && q.stats.attempts)).length,
    missedLast: list.filter((q) => q.stats && q.stats.attempts && !q.stats.lastCorrect).length,
  };
}

/**
 * File a study kit's questions. Questions already held (same fingerprint) keep
 * their stats; genuinely new ones are added. Unattempted questions from an
 * earlier run of the SAME source that this run no longer produces are dropped,
 * so regenerating a kit does not stack two question sets.
 */
export function addFromKit(classId, moduleId, items, src = {}) {
  if (!classId) return { added: [], kept: [], dropped: [] };
  const st = storeFor(classId);
  const existing = st.all();
  const byId = new Map(existing.map((q) => [q.id, q]));
  const added = [], kept = [];
  const freshIds = new Set();

  for (const it of items || []) {
    if (!it || !TYPES.includes(it.type) || !it.prompt || !it.answer) continue;
    const fp = fingerprint('quiz:' + it.type, it.prompt, it.answer);
    const id = 'qz_' + fp;
    if (freshIds.has(id)) continue;
    freshIds.add(id);
    const prior = byId.get(id);
    const q = {
      id, fp, classId, moduleId: moduleId || '',
      topic: String(it.topic || src.sourceTitle || '').trim(),
      type: it.type,
      prompt: String(it.prompt),
      ...(it.type === 'mcq' ? { choices: (it.choices || []).map(String) } : {}),
      answer: String(it.answer),
      explanation: String(it.explanation || ''),
      ...(it.dataset ? { dataset: it.dataset } : {}),
      source: {
        kind: src.kind || 'kit', jobId: src.jobId || '',
        sourceFileId: src.sourceFileId || '', sourceTitle: src.sourceTitle || '',
      },
      stats: (prior && prior.stats) || { attempts: 0, correct: 0, lastAt: 0, lastCorrect: null },
    };
    (prior ? kept : added).push(q);
  }

  const dropped = src.sourceFileId
    ? existing.filter((q) => q.source && q.source.sourceFileId === src.sourceFileId
        && !freshIds.has(q.id) && !(q.stats && q.stats.attempts))
    : [];
  if (dropped.length) st.remove(dropped.map((q) => q.id));
  st.upsert([...kept, ...added]);
  return { added, kept, dropped };
}

/** Record one answer. Returns the updated question. */
export function recordAnswer(classId, id, correct, now = Date.now()) {
  const st = storeFor(classId);
  const q = st.get(id);
  if (!q) return null;
  const s = q.stats || { attempts: 0, correct: 0 };
  const next = {
    ...q,
    stats: {
      attempts: (s.attempts || 0) + 1,
      correct: (s.correct || 0) + (correct ? 1 : 0),
      lastAt: now,
      lastCorrect: !!correct,
    },
  };
  st.upsert(next);
  return next;
}

export function remove(classId, ids) { return storeFor(classId).remove(ids); }

// ── Grading ──────────────────────────────────────────────────────────────────
/** Output comparison for trace questions: exact characters, forgiving spacing. */
export function normalizeOutput(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .trim()
    // A typed answer wrapped in quotes means the same output.
    .replace(/^["'`]+|["'`]+$/g, '');
}

/** Short and output-like (a number, a list, a line or two of printed text). */
export function isLiteralOutput(answer) {
  const a = normalizeOutput(answer);
  if (!a || a.length > 60) return false;
  // Prose markers: parentheses with words, "returns", "rows", sentences.
  return !/\b(returns?|rows?|all|the|which|because)\b/i.test(a) && !/[a-z]{3,}\s[a-z]{3,}\s[a-z]{3,}/i.test(a);
}

/**
 * Grade a response synchronously where that is possible.
 * Returns { correct: boolean|null, expected } — null means "needs a human"
 * (short answers are self-graded after reveal; SQL goes through drills/db).
 */
export function gradeSync(q, response) {
  if (!q) return { correct: null, expected: '' };
  if (q.type === 'mcq') return { correct: String(response) === q.answer, expected: q.answer };
  if (q.type === 'trace') {
    if (normalizeOutput(response) === normalizeOutput(q.answer)) return { correct: true, expected: q.answer };
    // A long or prose answer ("SKUs 100100, 100200 … (all bought by Pete
    // Hansen)") is a DESCRIPTION of the output, not the output — seen in the
    // first real study kit. Exact matching would mark almost any correct
    // answer wrong, so it goes to self-grading instead of an automatic miss.
    return { correct: isLiteralOutput(q.answer) ? false : null, expected: q.answer };
  }
  return { correct: null, expected: q.answer };
}

// ── Building a quiz ─────────────────────────────────────────────────────────
/**
 * Pick `n` questions for a scope, weakest first:
 *   1. last answered WRONG, oldest miss first
 *   2. never attempted
 *   3. the rest, least-recently seen first
 * then shuffled within that order's first `n` so the same quiz twice in a row
 * does not repeat question-for-question.
 *
 * scope: { classId, moduleIds?, topics?, types?, sourceFileId? }
 */
export function buildQuiz(scope = {}, n = 10, rand = Math.random) {
  let pool = forClass(scope.classId);
  if (scope.moduleIds && scope.moduleIds.length) {
    const m = new Set(scope.moduleIds);
    pool = pool.filter((q) => m.has(q.moduleId));
  }
  if (scope.topics && scope.topics.length) {
    const ts = scope.topics.map((t) => String(t).toLowerCase());
    pool = pool.filter((q) => ts.some((t) => (q.topic || '').toLowerCase().includes(t)));
  }
  if (scope.types && scope.types.length) pool = pool.filter((q) => scope.types.includes(q.type));
  if (scope.sourceFileId) pool = pool.filter((q) => q.source && q.source.sourceFileId === scope.sourceFileId);

  const missed = [], fresh = [], rest = [];
  for (const q of pool) {
    const s = q.stats || {};
    if (s.attempts && s.lastCorrect === false) missed.push(q);
    else if (!s.attempts) fresh.push(q);
    else rest.push(q);
  }
  missed.sort((a, b) => (a.stats.lastAt || 0) - (b.stats.lastAt || 0));
  rest.sort((a, b) => (a.stats.lastAt || 0) - (b.stats.lastAt || 0));
  const chosen = [...missed, ...fresh, ...rest].slice(0, n);
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
  }
  return chosen;
}

export default {
  TYPES, connect, forClass, get, countsFor, addFromKit, recordAnswer, remove,
  normalizeOutput, isLiteralOutput, gradeSync, buildQuiz,
};
