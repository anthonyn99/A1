/* ============================================================================
 * StudyOS — filing a study kit  (engagement upgrade 1.1)
 * ============================================================================
 * A finished `kit` job from the bridge carries:
 *
 *   job.kit = { flashcards[], key_terms[], quiz[], cheatsheet_md }
 *   job.kitRewrite + a PDF on the bridge, when the rewrite stage ran
 *
 * This files each part where it is USED, not in one blob:
 *
 *   flashcards + key terms -> the class deck (deck.addExternal), so they are
 *                             scheduled by FSRS like every other card
 *   quiz                   -> the class quiz bank (quiz.js)
 *   cheat sheet + terms    -> ONE page in a notes-type "Study Kit" module
 *   rewritten deck         -> the documents path every generated PDF takes
 *
 * Cards and questions are tagged with the module the SOURCE lecture lives in,
 * so "quiz me on Module 2" and an exam's covered modules find them.
 *
 * ── RE-RUNS ───────────────────────────────────────────────────────────────
 * Idempotent per source file: cards reconcile against 'kit_<fileId>', quiz
 * questions against their sourceFileId, the note replaces by sourceFileId.
 * Anything with review/answer history survives a re-run; untouched leftovers
 * from the previous run are dropped so sets do not stack.
 * ------------------------------------------------------------------------- */

import { store } from './store.js';
import * as deck from './deck.js';
import * as quiz from './quiz.js';

/** The module holding a file, so kit items share the lecture's module. */
function moduleOfFile(cls, fileId) {
  for (const m of (cls && cls.modules) || []) {
    if ((m.files || []).some((f) => f && f.id === fileId)) return m;
  }
  return null;
}

export function keyTermCards(terms) {
  return (terms || [])
    .filter((t) => t && t.term && t.definition)
    .map((t) => ({ front: `Define: ${t.term}`, back: t.definition, topic: t.topic || '' }));
}

export function cheatsheetMarkdown(k) {
  const parts = [];
  if (k.cheatsheet_md) parts.push(String(k.cheatsheet_md).trim());
  const terms = (k.key_terms || []).filter((t) => t && t.term);
  if (terms.length) {
    parts.push('## Key terms\n' + terms.map((t) => `- **${t.term}**: ${t.definition}`).join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * @param {object} job   a finished kit job (GET /api/ai/jobs/:id)
 * @param {{filePdf:Function}} io  pipeline.js's PDF filer, injected to avoid
 *        a circular import
 * @returns {Promise<object>} { classId, moduleId, moduleName, cards, questions,
 *          warnings, deck } or { unfiled: true }
 */
export async function fileKit(job, { filePdf } = {}) {
  const k = job.kit || {};
  const cls = store.getClass(job.classId);
  if (!cls) return { unfiled: true };

  const base = (job.sourceName || 'Lecture').replace(/\.[a-z0-9]+$/i, '');
  const srcMod = moduleOfFile(cls, job.fileId);
  const moduleId = srcMod ? srcMod.id : '';
  const warnings = [...(job.kitWarnings || [])];

  const cardRes = deck.addExternal(cls.id, moduleId,
    [...(k.flashcards || []), ...keyTermCards(k.key_terms)],
    { noteId: 'kit_' + job.fileId, title: base });

  const quizRes = quiz.addFromKit(cls.id, moduleId, k.quiz || [], {
    kind: 'kit', jobId: job.id, sourceFileId: job.fileId, sourceTitle: base,
  });

  let note = null;
  const body = cheatsheetMarkdown(k);
  const B = window._sosBridge;
  if (body && B && typeof B.addGeneratedNote === 'function') {
    note = B.addGeneratedNote({
      classId: cls.id,
      moduleName: 'Study Kit',
      title: base + ' — Cheat sheet',
      body,
      // `sourceFileId` is what makes a re-run replace this page (notes-sync
      // matches on it); plain keys only — see the underscore-strip trap.
      meta: { sourceFileId: job.fileId, mode: 'kit', jobId: job.id,
              promptId: job.promptId, generatedAt: job.finishedAt || Date.now() },
    });
  }

  let deckDoc = null;
  if (job.kitRewrite && job.hasPdf !== false && typeof filePdf === 'function') {
    try { deckDoc = await filePdf(job, 'rewrite'); }
    catch (e) { warnings.push('the rewritten deck could not be filed: ' + (e.message || e)); }
  } else if (job.kitRewrite && job.hasPdf === false) {
    warnings.push('the rewritten deck was not built: ' + (job.pdfError || 'unknown reason'));
  }

  const kitMod = (cls.modules || []).find((m) => m.type === 'notes' && m.name === 'Study Kit');
  return {
    classId: cls.id,
    moduleId: kitMod ? kitMod.id : moduleId,
    moduleName: kitMod ? kitMod.name : (srcMod && srcMod.name) || '',
    cards: cardRes.added.length + cardRes.kept.length,
    newCards: cardRes.added.length,
    questions: quizRes.added.length + quizRes.kept.length,
    note: !!note,
    deck: deckDoc,
    warnings,
  };
}

export default { fileKit, keyTermCards, cheatsheetMarkdown };
