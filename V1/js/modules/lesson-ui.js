/* ============================================================================
 * StudyOS — lesson reader  (one topic of a broken-down document)
 * ============================================================================
 * SOLO-LEVELING's lesson player, adapted: one block per screen, a progress
 * bar, Back / Next and the arrow keys. The last screen is the topic's
 * flashcards — flip through them, then "Review these now" hands them to the
 * spaced-repetition review, where they keep coming back on schedule.
 *
 * Unlike SOLO, a check never blocks moving on: she is reading to learn, and a
 * gate on Next turns a lesson into a test she has to pass to continue.
 * ------------------------------------------------------------------------- */

import * as bd from './breakdown.js';
import * as deck from './deck.js';
import { renderMarkdown, escapeHtml as esc, inline } from './md.js';
import { ensureStyle } from './study-style.js';
import { findFile } from './breakdown-ui.js';

const LABEL = { read: 'Read', example: 'Worked example', steps: 'Step by step', check: 'Check yourself', recap: 'Recap',
  source: 'From the document', cards: 'Flashcards' };

/** The screens of a lesson: its blocks, then — when the check against the
 *  document found lines no lesson teaches — those lines, verbatim. What the
 *  model missed is still in front of her, never silently gone. */
function lessonBlocks(topic) {
  const blocks = topic.lesson.blocks;
  const gaps = topic.gaps || [];
  return gaps.length ? [...blocks, { kind: 'source', title: 'Also in the document', lines: gaps }] : blocks;
}

let S = null;          // { fileId, topicId, screen, answers, checked, shown, card, flipped }
let _saveTimer = null;

export async function open(fileId, topicId) {
  ensureStyle();
  const doc = await bd.load(fileId);
  const topic = doc && doc.topics.find((t) => t.id === topicId);
  if (!topic || topic.status !== 'ready') return false;
  flush();
  const blocks = lessonBlocks(topic);
  const resumeAt = topic.progress && !topic.progress.done ? Math.min(topic.progress.block || 0, blocks.length) : 0;
  S = { fileId, topicId, screen: resumeAt, answers: {}, checked: {}, shown: {}, card: 0, flipped: false };
  // A topic is opened from the list inside the module popup. Switching views
  // does not close a popup, so without this the lesson would open BEHIND it.
  try { if (document.querySelector('#modal-module-detail.open') && window.closeModuleDetail) window.closeModuleDetail(); }
  catch (e) {}
  if (window.switchView) window.switchView('lesson');
  render();
  window.scrollTo && window.scrollTo(0, 0);
  return true;
}

/** Called by switchView when leaving the lesson view: persist where she is. */
export function leave() { flush(); }

function cur() {
  const doc = S && bd.peek(S.fileId);
  const topic = doc && doc.topics.find((t) => t.id === S.topicId);
  return topic ? { doc, topic, blocks: lessonBlocks(topic) } : null;
}

function topicCards(doc) {
  const id = bd.noteIdFor(doc.fileId, S.topicId);
  return deck.forClass(doc.classId).filter((c) => c.sourceNoteId === id);
}

function render() {
  const root = document.getElementById('sos-lesson-root');
  const c = cur();
  if (!root || !c) return;
  const { doc, topic, blocks } = c;
  const total = blocks.length + 1;                    // + the flashcards screen
  const screen = Math.min(S.screen, total - 1);
  const block = blocks[screen];
  const kind = block ? block.kind : 'cards';
  const ready = doc.topics.filter((t) => t.status === 'ready');
  const at = ready.findIndex((t) => t.id === topic.id);
  const prevT = ready[at - 1], nextT = ready[at + 1];
  const where = findFile(doc.fileId);
  const clsName = where ? (where.cls.code || where.cls.name || '') : '';

  root.innerHTML = `
    <div class="sl-top">
      <button class="sl-back" data-back title="Back to the document">← ${esc(doc.sourceName || 'Document')}</button>
      <div class="sl-crumb">${esc(clsName)}${clsName ? ' · ' : ''}Topic ${doc.topics.indexOf(topic) + 1} of ${doc.topics.length}</div>
    </div>
    <h1 class="sl-title">${esc(topic.title)}</h1>
    ${topic.summary ? `<div class="sl-sub">${esc(topic.summary)}</div>` : ''}
    <div class="sl-bar"><div style="width:${Math.round(((screen + 1) / total) * 100)}%"></div></div>
    <div class="sl-count"><span>${screen + 1} of ${total}</span><span>${esc(LABEL[kind] || '')}</span></div>
    <div class="sl-card ${kind}">${block ? blockHtml(block, screen) : cardsHtml(doc)}</div>
    <div class="sl-nav">
      <button data-prev ${screen === 0 ? 'disabled' : ''}>← Back</button>
      ${block ? `<button class="primary" data-next>${screen === blocks.length - 1 ? 'Flashcards →' : 'Next →'}</button>`
              : (nextT ? `<button class="primary" data-topic="${esc(nextT.id)}">Next topic →</button>`
                       : `<button class="primary" data-back>Back to the document</button>`)}
    </div>
    <div class="sl-topicnav">
      <button data-topic="${prevT ? esc(prevT.id) : ''}" ${prevT ? '' : 'style="visibility:hidden"'}>‹ ${prevT ? esc(prevT.title) : ''}</button>
      <button data-topic="${nextT ? esc(nextT.id) : ''}" ${nextT ? '' : 'style="visibility:hidden"'}>${nextT ? esc(nextT.title) : ''} ›</button>
    </div>
    <div class="sl-row" style="justify-content:center;margin-top:18px">
      <button class="sl-link" data-rewrite>Rewrite this lesson</button>
    </div>`;

  wire(root, c, screen, total);
  // Reaching the flashcards is finishing the lesson.
  queueSave({ block: screen, ...(block ? {} : { done: true }) });
}

function blockHtml(b, i) {
  const title = b.title ? `<h2>${esc(b.title)}</h2>` : '';
  if (b.kind === 'read' || b.kind === 'example') {
    return `${title}<div class="sl-prose">${renderMarkdown(b.markdown)}</div>`;
  }
  if (b.kind === 'source') {
    return `${title}<div class="sl-muted" style="margin-bottom:10px">The lesson above does not fully teach these lines of the document, so here they are exactly as the document has them.</div>
      <div class="sl-prose"><ul>${b.lines.map((g) => `<li><span class="sl-muted">p.${esc(String(g.page))}</span> ${esc(g.text)}</li>`).join('')}</ul></div>`;
  }
  if (b.kind === 'recap') {
    return `${title || '<h2>Recap</h2>'}<div class="sl-prose"><ul>${b.points.map((p) => `<li>${inline(esc(p))}</li>`).join('')}</ul></div>`;
  }
  if (b.kind === 'steps') {
    const shown = S.shown[i] || 1;
    const steps = b.steps.slice(0, shown).map((st, k) => `
      <div class="sl-step">
        <div class="sl-step-n">${k + 1}</div>
        <div style="flex:1;min-width:0">
          ${st.title ? `<div class="sl-step-t">${inline(esc(st.title))}</div>` : ''}
          <div class="sl-prose">${renderMarkdown(st.body)}</div>
        </div>
      </div>`).join('');
    const more = shown < b.steps.length
      ? `<div class="sl-row"><button class="sl-inline-btn primary" data-step>Show step ${shown + 1} of ${b.steps.length}</button>
         <button class="sl-link" data-allsteps>show all</button></div>`
      : '';
    return `${title}${steps}${more}`;
  }
  if (b.kind === 'check') {
    const picks = S.answers[i] || {};
    const checked = !!S.checked[i];
    const qs = b.questions.map((q, qi) => {
      const choices = q.choices.map((ch) => {
        let cls = '';
        if (checked) cls = ch === q.answer ? 'right' : (picks[qi] === ch ? 'wrong' : '');
        else if (picks[qi] === ch) cls = 'picked';
        return `<button class="sl-choice ${cls}" data-q="${qi}" data-choice="${esc(ch)}" ${checked ? 'disabled' : ''}>${inline(esc(ch))}</button>`;
      }).join('');
      const expl = checked
        ? `<div class="sl-expl">${picks[qi] === q.answer ? '✓ ' : '✗ '}${inline(esc(q.explanation || ('The answer is: ' + q.answer)))}</div>`
        : '';
      return `<div class="sl-q"><div class="sl-q-stem">${qi + 1}. ${inline(esc(q.q))}</div>${choices}${expl}</div>`;
    }).join('');
    const answered = b.questions.every((_, qi) => picks[qi] != null);
    const right = b.questions.filter((q, qi) => picks[qi] === q.answer).length;
    const foot = checked
      ? `<div class="sl-verdict">${right} of ${b.questions.length} right${right === b.questions.length ? ' — nicely done.' : ' — the explanations above say why.'}
         <button class="sl-link" data-retry style="margin-left:8px">try again</button></div>`
      : `<div class="sl-row"><button class="sl-inline-btn primary" data-check ${answered ? '' : 'disabled'}>Check answers</button>
         <span class="sl-muted">${answered ? '' : 'Answer every question to check.'}</span></div>`;
    return `${title || '<h2>Check yourself</h2>'}${qs}${foot}`;
  }
  return '';
}

function cardsHtml(doc) {
  const cards = topicCards(doc);
  if (!cards.length) return `<h2>Flashcards</h2><div class="sl-muted">No flashcards for this topic.</div>`;
  const i = Math.min(S.card, cards.length - 1);
  const c = cards[i];
  return `
    <h2>Flashcards · ${cards.length}</h2>
    <div class="sl-muted" style="margin-bottom:12px">These are already in your reviews — they come back on a spaced schedule.
      Flip through them now, or start a review to rate yourself.</div>
    <div class="sl-flip${S.flipped ? ' back' : ''}" data-flip role="button" tabindex="0">
      <div class="side">${S.flipped ? 'Answer' : 'Question'} · ${i + 1} / ${cards.length}</div>
      <div>${inline(esc(S.flipped ? c.a : c.q))}</div>
    </div>
    <div class="sl-row" style="justify-content:space-between">
      <div class="sl-row" style="margin:0">
        <button class="sl-inline-btn" data-card="-1" ${i === 0 ? 'disabled' : ''}>‹</button>
        <button class="sl-inline-btn" data-card="1" ${i === cards.length - 1 ? 'disabled' : ''}>›</button>
      </div>
      <button class="sl-inline-btn primary" data-review>Review these now</button>
    </div>`;
}

function wire(root, c, screen, total) {
  const go = (n) => { S.screen = Math.max(0, Math.min(total - 1, n)); S.card = 0; S.flipped = false; render(); window.scrollTo && window.scrollTo(0, 0); };
  const on = (sel, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener('click', fn));

  on('[data-prev]', () => go(screen - 1));
  on('[data-next]', () => go(screen + 1));
  on('[data-back]', () => backToDocument(c.doc));
  on('[data-topic]', (e) => { const id = e.currentTarget.dataset.topic; if (id) { flush(); open(c.doc.fileId, id); } });
  on('[data-step]', () => { S.shown[screen] = (S.shown[screen] || 1) + 1; render(); });
  on('[data-allsteps]', () => { S.shown[screen] = 999; render(); });
  on('[data-choice]', (e) => {
    const b = e.currentTarget;
    (S.answers[screen] || (S.answers[screen] = {}))[b.dataset.q] = b.dataset.choice;
    render();
  });
  on('[data-check]', () => { S.checked[screen] = true; render(); });
  on('[data-retry]', () => { S.checked[screen] = false; S.answers[screen] = {}; render(); });
  on('[data-flip]', () => { S.flipped = !S.flipped; render(); });
  on('[data-card]', (e) => { S.card += Number(e.currentTarget.dataset.card); S.flipped = false; render(); });
  on('[data-review]', () => {
    const R = window.SOS && window.SOS.review;
    if (R) R.startReview({ classId: c.doc.classId, noteId: bd.noteIdFor(c.doc.fileId, c.topic.id) });
  });
  on('[data-rewrite]', async () => {
    if (!confirm('Write this lesson again from the document? It replaces the current one (one more AI request). Flashcards you have reviewed keep their schedule.')) return;
    const where = findFile(c.doc.fileId);
    if (!where) return;
    const topicId = c.topic.id;
    backToDocument(c.doc);
    try { await bd.regenerate(c.doc.fileId, topicId, where.file); }
    catch (e) { window.showNotif && window.showNotif('⚠️', 'Rewrite failed', (e && e.message) || String(e)); }
  });
}

function backToDocument(doc) {
  flush();
  const B = window._sosBridge;
  if (B && B.revealModule && doc.classId && doc.moduleId && B.revealModule(doc.classId, doc.moduleId)) return;
  if (window.switchView) window.switchView('class', doc.classId);
}

// ── Keyboard: ← → move between screens while the reader is showing ─────────
document.addEventListener('keydown', (e) => {
  if (!S) return;
  const view = document.getElementById('view-lesson');
  if (!view || !view.classList.contains('active')) return;
  if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
  if (document.querySelector('.modal-overlay.open, .sos-modal.open')) return;
  const next = document.querySelector('#sos-lesson-root [data-next]');
  const prev = document.querySelector('#sos-lesson-root [data-prev]');
  if (e.key === 'ArrowRight' && next) { e.preventDefault(); next.click(); }
  if (e.key === 'ArrowLeft' && prev && !prev.disabled) { e.preventDefault(); prev.click(); }
});

// A regenerate or a remote edit changes the lesson under her: repaint.
window.addEventListener('sos-breakdown', (e) => {
  if (!S || !e.detail || e.detail.fileId !== S.fileId) return;
  const view = document.getElementById('view-lesson');
  if (view && view.classList.contains('active') && cur()) render();
});

// ── Progress: where she is in each topic, synced, debounced ───────────────
let _pending = null;
function queueSave(progress) {
  if (!S) return;
  const c = cur();
  const prev = (c && c.topic.progress) || {};
  // Never un-finish a topic by paging back through it.
  _pending = { fileId: S.fileId, topicId: S.topicId, progress: { ...progress, done: !!(prev.done || progress.done) } };
  if (prev.block === _pending.progress.block && !!prev.done === _pending.progress.done) { _pending = null; return; }
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flush, 1500);
}
function flush() {
  clearTimeout(_saveTimer);
  if (!_pending) return;
  const p = _pending;
  _pending = null;
  bd.setProgress(p.fileId, p.topicId, p.progress);
}
window.addEventListener('pagehide', flush);

export default { open, leave };
