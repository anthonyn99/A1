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

import * as ai from './ai.js';
import * as bd from './breakdown.js';
import * as deck from './deck.js';
import * as pipeline from './pipeline.js';
import { renderMarkdown, escapeHtml as esc, inline } from './md.js';
import { ensureStyle } from './study-style.js';
import { findFile } from './breakdown-ui.js';

const LABEL = { read: 'Read', example: 'Worked example', steps: 'Step by step', check: 'Check yourself', recap: 'Recap',
  figure: 'Figure', source: 'From the document', cards: 'Key cards', pretest: 'Warm up', retry: 'Retry' };
const addBtn = (text) => `<button class="sl-link sl-add" data-addcard="${esc(text)}" title="Make a flashcard from this">＋ card</button>`;

// ── Figures: the document's pages, re-rendered from the source PDF ─────────
/* Only {page} is stored with a lesson; the picture is drawn from the PDF on
 * the device that opens it. `${fileId}:${page}` -> Promise<JPEG data URL>,
 * kept because render() runs on every click. A failure is forgotten, so the
 * next open tries again. */
const _pageImg = new Map();

function figurePagesOf(topic) {
  return [...new Set((topic.lesson.blocks || []).filter((b) => b.kind === 'figure' && b.page).map((b) => b.page))];
}

/** Render every not-yet-cached figure page of a topic, in ONE pass over the PDF. */
function prefetchFigures(fileId, pages) {
  const todo = pages.filter((n) => !_pageImg.has(`${fileId}:${n}`));
  if (!todo.length) return;
  const where = findFile(fileId);
  const all = (async () => {
    const b64 = where ? await pipeline.pdfOf(where.file) : null;
    if (!b64) throw new Error('the PDF is not available on this device');
    return ai.pdfPageImages(b64, todo);
  })();
  for (const n of todo) {
    const key = `${fileId}:${n}`;
    const one = all.then((shots) => {
      const hit = shots.find((x) => x.n === n);
      if (!hit) throw new Error('no such page');
      return hit.url;
    });
    one.catch(() => { if (_pageImg.get(key) === one) _pageImg.delete(key); });
    _pageImg.set(key, one);
  }
}

function slotNote(slot, text) {
  const d = document.createElement('div');
  d.className = 'sl-fig-slot sl-muted';
  d.textContent = text;
  slot.replaceWith(d);
}

/** Put the pictures into the figure placeholders render() just wrote. The
 *  image is built as an element with src/alt set as properties — no model
 *  text reaches innerHTML, and an SVG shown as an <img> runs nothing. */
function fillFigures(root, blocks) {
  root.querySelectorAll('[data-fig-screen]').forEach((fig) => {
    const i = Number(fig.dataset.figScreen);
    const b = blocks[i];
    const slot = fig.querySelector('.sl-fig-slot');
    if (!b || !slot) return;
    const img = document.createElement('img');
    img.alt = b.title || 'Figure';
    if (b.svg && !S.orig[i]) {
      img.onerror = () => { if (img.isConnected) slotNote(img, 'This drawing couldn’t be displayed.'); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(b.svg);
      img.className = 'drawn';
      slot.replaceWith(img);
      return;
    }
    const fileId = S.fileId;
    prefetchFigures(fileId, [b.page]);
    const p = _pageImg.get(`${fileId}:${b.page}`);
    if (!p) return slotNote(slot, 'This figure couldn’t be loaded on this device (the document isn’t available here).');
    p.then((url) => {
      if (!slot.isConnected || !S || S.fileId !== fileId) return;
      img.src = url;
      slot.replaceWith(img);
    }, () => {
      if (slot.isConnected) slotNote(slot, 'This figure couldn’t be loaded on this device (the document isn’t available here).');
    });
  });
}

/** The screens of a lesson: its blocks, then — when the check against the
 *  document found lines no lesson teaches — those lines, verbatim. What the
 *  model missed is still in front of her, never silently gone. */
function lessonBlocks(topic) {
  const blocks = topic.lesson.blocks;
  const gaps = topic.gaps || [];
  return gaps.length ? [...blocks, { kind: 'source', title: 'Also in the document', lines: gaps }] : blocks;
}

/* Screens BEFORE the lesson (overhaul §7.4, §7.8), fixed when it opens:
 *   retry    check questions she got wrong in an earlier sitting, the day after
 *   pretest  the first time: two of the lesson's own check questions, to try
 *            before learning — a guess primes what the lesson then answers.
 *            Never graded, never recorded.
 * Progress is saved in LESSON block numbers (screen − pre-screens), so a
 * pre-screen appearing or not never shifts where she resumes. */
function preScreens(topic, now = Date.now()) {
  const blocks = topic.lesson.blocks;
  const p = topic.progress || {};
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  if ((p.wrong || []).length && (p.wrongAt || 0) < today.getTime()) {
    const questions = p.wrong.map((w) => {
      const b = blocks[w.b];
      const q = b && b.kind === 'check' && b.questions[w.q];
      return q ? { ...q, _ref: w } : null;
    }).filter(Boolean);
    if (questions.length) return [{ kind: 'retry', title: 'Questions you missed last time', questions }];
  }
  if (!topic.progress) {
    const chk = blocks.find((b) => b.kind === 'check' && (b.questions || []).length >= 2);
    if (chk) return [{ kind: 'pretest', title: 'Warm up — guess before you learn', questions: chk.questions.slice(0, 2) }];
  }
  return [];
}

let S = null;          // { fileId, topicId, screen, answers, checked, shown, orig, pre, preScreens, openedAt }
let _saveTimer = null;

export async function open(fileId, topicId, opts = {}) {
  ensureStyle();
  const doc = await bd.load(fileId);
  const topic = doc && doc.topics.find((t) => t.id === topicId);
  if (!topic || topic.status !== 'ready') return false;
  flush();
  // Opening the lesson is what lets its cards be introduced ("only introduce
  // cards from lessons I've read"): understanding first, then memory.
  deck.markLessonRead(doc.classId, bd.noteIdFor(fileId, topicId));
  const blocks = lessonBlocks(topic);
  let resumeAt = topic.progress && !topic.progress.done ? Math.min(topic.progress.block || 0, blocks.length) : 0;
  if (opts.block != null) resumeAt = Math.max(0, Math.min(blocks.length - 1, opts.block));
  else if (opts.page != null) {
    // The block nearest a source page: the figure block of that page, or the
    // last figure before it. Lessons carry no other page marks.
    let at = -1;
    blocks.forEach((b, k) => { if (b.kind === 'figure' && b.page && b.page <= opts.page) at = k; });
    if (at >= 0) resumeAt = at;
  }
  const pre = opts.block != null || opts.page != null ? [] : preScreens(topic);
  // A retry starts the sitting; a warm-up only ever shows on a first open.
  const screen = pre.length ? 0 : resumeAt;
  S = { fileId, topicId, screen, answers: {}, checked: {}, shown: {}, orig: {}, pre: pre.length, preScreens: pre,
    openedAt: Date.now(), logged: false };
  prefetchFigures(fileId, figurePagesOf(topic).filter((n) => blocks.some((b) => b.kind === 'figure' && b.page === n && !b.svg)));
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
  return topic ? { doc, topic, blocks: [...(S.preScreens || []), ...lessonBlocks(topic)] } : null;
}

function topicCards(doc) {
  const id = bd.noteIdFor(doc.fileId, S.topicId);
  return deck.forClass(doc.classId).filter((c) => c.sourceNoteId === id);
}

/** A lesson block number from a screen number (pre-screens come first). */
const blockOf = (screen) => screen - (S.pre || 0);

function render() {
  const root = document.getElementById('sos-lesson-root');
  const c = cur();
  if (!root || !c) return;
  const { doc, topic, blocks } = c;
  const total = blocks.length + 1;                    // + the key-cards screen
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
    <div class="sl-card ${kind}">${block ? blockHtml(block, screen, doc) : cardsHtml(doc)}</div>
    <div class="sl-nav">
      <button data-prev ${screen === 0 ? 'disabled' : ''}>← Back</button>
      ${block ? `<button class="primary" data-next>${screen === blocks.length - 1 ? 'Key cards →'
                : block.kind === 'pretest' || block.kind === 'retry' ? (S.checked[screen] ? 'Start the lesson →' : 'Skip →') : 'Next →'}</button>`
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
  fillFigures(root, blocks);
  // Reaching the key cards is finishing the lesson. A pre-screen is not a
  // place in the lesson, so it never moves the saved position.
  if (block && (block.kind === 'pretest' || block.kind === 'retry')) return;
  if (!block) logLesson(doc);
  queueSave({ block: Math.max(0, blockOf(screen)), ...(block ? {} : { done: true }) });
}

/** Reading a lesson is studying: it counts toward the day, like a review
 *  (overhaul §7.9). Once per sitting, when she reaches its end. */
function logLesson(doc) {
  if (!S || S.logged) return;
  S.logged = true;
  try {
    const sessions = window.SOS && window.SOS.sessions;
    if (sessions) sessions.log('lesson', { classId: doc.classId, startedAt: S.openedAt, durationMs: Date.now() - S.openedAt, completed: true });
  } catch (e) {}
}

function blockHtml(b, i, doc) {
  const title = b.title ? `<h2>${esc(b.title)}</h2>` : '';
  if (b.kind === 'figure') {
    const n = Number(b.page) || 0;
    const from = `page ${n} of ${esc(doc.sourceName || 'the document')}`;
    const cap = b.svg
      ? `Drawn for this lesson${n ? ` · redraws the figure on ${from} · <button class="sl-link" data-fig-orig>${
          S.orig[i] ? 'show the drawing' : 'show the original'}</button>` : ''}`
      : `From ${from}`;
    const note = b.svg && !S.orig[i] ? 'Drawing the figure…' : 'Loading the figure…';
    return `${title}<figure class="sl-fig" data-fig-screen="${i}"><div class="sl-fig-slot sl-muted">${note}</div>
      <figcaption class="sl-muted">${cap}</figcaption></figure>${b.markdown ? `<div class="sl-prose">${renderMarkdown(b.markdown)}</div>` : ''}`;
  }
  if (b.kind === 'read' || b.kind === 'example') {
    return `${title}<div class="sl-prose">${renderMarkdown(b.markdown)}</div>`;
  }
  if (b.kind === 'source') {
    return `${title}<div class="sl-muted" style="margin-bottom:10px">The lesson above does not fully teach these lines of the document, so here they are exactly as the document has them.</div>
      <div class="sl-prose"><ul>${b.lines.map((g) => `<li><span class="sl-muted">p.${esc(String(g.page))}</span> ${esc(g.text)} ${addBtn(g.text)}</li>`).join('')}</ul></div>`;
  }
  if (b.kind === 'recap') {
    return `${title || '<h2>Recap</h2>'}<div class="sl-prose"><ul>${b.points.map((p) => `<li>${inline(esc(p))} ${addBtn(p)}</li>`).join('')}</ul></div>`;
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
  if (b.kind === 'check' || b.kind === 'pretest' || b.kind === 'retry') {
    const intro = b.kind === 'pretest'
      ? '<div class="sl-muted" style="margin-bottom:12px">Two questions from this lesson, before you read it. Guess — it is not graded, and trying first makes the answers stick.</div>'
      : b.kind === 'retry' ? '<div class="sl-muted" style="margin-bottom:12px">You got these wrong last time. Try them again before the lesson.</div>' : '';
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
    return `${title || '<h2>Check yourself</h2>'}${intro}${qs}${foot}`;
  }
  return '';
}

/** The topic's cards that a "Learn the key cards" step introduces: its core
 *  (priority 1) unseen cards, or every unseen active one when none is marked. */
function keyCards(list) {
  const fresh = list.filter((c) => deck.statusOf(c) === 'active' && deck.isUnseen(c));
  const core = fresh.filter((c) => c.priority === 1);
  return core.length ? core : fresh;
}

/** The end of a lesson: move what she just understood into memory now —
 *  not a flip-through of 80 cards (overhaul §7.1). */
function cardsHtml(doc) {
  const list = topicCards(doc);
  const key = keyCards(list);
  const c = deck.deckCounts(list);
  const inReviews = list.filter((x) => deck.statusOf(x) === 'active' && !deck.isUnseen(x)).length;
  const sugg = list.filter((x) => deck.statusOf(x) === 'suggested').length;
  return `
    <h2>${key.length ? `Learn the key cards (${key.length})` : 'Key cards'}</h2>
    <div class="sl-muted" style="margin-bottom:14px">${key.length
      ? 'You just learned this topic. Lock in what matters most: flip each card, then add it to your reviews — they come back on a spaced schedule.'
      : list.length ? 'Every key card of this topic is already in your reviews.' : 'This topic has no flashcards yet. Make one from anything in the lesson: select text, or use ＋ card on the recap.'}</div>
    <div class="sl-row" style="flex-wrap:wrap;gap:8px">
      ${key.length ? `<button class="sl-inline-btn primary" data-learn>Learn ${key.length} card${key.length === 1 ? '' : 's'} now</button>` : ''}
      ${c.due ? `<button class="sl-inline-btn" data-due>Review ${c.due} due</button>` : ''}
      ${sugg ? `<button class="sl-inline-btn" data-triage title="Cards held back — add the ones you want">${sugg} suggested</button>` : ''}
      <button class="sl-inline-btn" data-newcard>＋ Card</button>
      ${list.length ? `<button class="sl-link" data-browse>see all ${list.length}</button>` : ''}
    </div>
    ${inReviews ? `<div class="sl-muted" style="margin-top:12px">${inReviews} in your reviews · ${c.mastery}% mastered</div>` : ''}`;
}

/** Record the check questions she got wrong (and clear the ones now right),
 *  so they come back as a retry the next day — no cards made. */
function recordChecks(c, screen) {
  const b = c.blocks[screen];
  if (!b || b.kind === 'pretest') return;
  const picks = S.answers[screen] || {};
  const prev = (c.topic.progress && c.topic.progress.wrong) || [];
  let wrong = prev.slice();
  if (b.kind === 'retry') {
    b.questions.forEach((q, qi) => {
      if (picks[qi] === q.answer) wrong = wrong.filter((w) => !(w.b === q._ref.b && w.q === q._ref.q));
    });
  } else {
    const bi = blockOf(screen);
    b.questions.forEach((q, qi) => {
      wrong = wrong.filter((w) => !(w.b === bi && w.q === qi));
      if (picks[qi] !== q.answer) wrong.push({ b: bi, q: qi });
    });
  }
  bd.setProgress(S.fileId, S.topicId, { wrong: wrong.slice(-20), wrongAt: Date.now() });
}

function wire(root, c, screen, total) {
  const go = (n) => { S.screen = Math.max(0, Math.min(total - 1, n)); render(); window.scrollTo && window.scrollTo(0, 0); };
  const on = (sel, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener('click', fn));

  on('[data-prev]', () => go(screen - 1));
  on('[data-next]', () => go(screen + 1));
  on('[data-back]', () => backToDocument(c.doc));
  on('[data-topic]', (e) => { const id = e.currentTarget.dataset.topic; if (id) { flush(); open(c.doc.fileId, id); } });
  on('[data-step]', () => { S.shown[screen] = (S.shown[screen] || 1) + 1; render(); });
  on('[data-allsteps]', () => { S.shown[screen] = 999; render(); });
  on('[data-fig-orig]', () => { S.orig[screen] = !S.orig[screen]; render(); });
  on('[data-choice]', (e) => {
    const b = e.currentTarget;
    (S.answers[screen] || (S.answers[screen] = {}))[b.dataset.q] = b.dataset.choice;
    render();
  });
  on('[data-check]', () => { S.checked[screen] = true; recordChecks(c, screen); render(); });
  on('[data-retry]', () => { S.checked[screen] = false; S.answers[screen] = {}; render(); });
  const noteId = bd.noteIdFor(c.doc.fileId, c.topic.id);
  const R = () => window.SOS && window.SOS.review;
  const C = () => window.SOS && window.SOS.cardsUi;
  on('[data-learn]', () => {
    // She chose to learn these now: the topic's key cards, past today's cap.
    const n = keyCards(topicCards(c.doc)).length;
    if (R()) R().startReview({ classId: c.doc.classId, noteId }, { mode: 'learn', anyNew: true, maxNew: n });
  });
  on('[data-due]', () => { if (R()) R().startReview({ classId: c.doc.classId, noteId }, { mode: 'review' }); });
  on('[data-triage]', () => { if (C()) C().openTriage({ classId: c.doc.classId, noteId, onClose: () => render() }); });
  on('[data-browse]', () => { if (C()) C().openBrowse({ classId: c.doc.classId, noteId, title: c.topic.title }); });
  on('[data-newcard]', () => newCard(c, ''));
  on('[data-addcard]', (e) => { e.stopPropagation(); newCard(c, e.currentTarget.dataset.addcard + '\n---\n'); });
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

/** The card editor, filed under this topic. */
function newCard(c, prefill) {
  const C = window.SOS && window.SOS.cardsUi;
  if (!C) return;
  C.openEditor({ classId: c.doc.classId, noteId: bd.noteIdFor(c.doc.fileId, c.topic.id), title: c.topic.title, prefill,
    onSave: (card) => {
      if (card) window.showNotif && window.showNotif('🃏', 'Card added', 'It joins your reviews with today\'s new cards.');
      render();
    } });
}

// ── "＋ Card" / "＋ Cloze" on a selection in the reader (overhaul §7.2) ────
/* Select any text in a lesson: a small bar offers a card (the selection as
 * its front, to finish) or a cloze (the sentence around it, with the
 * selection as the blank). */
let _selBar = null;
function hideSelBar() { if (_selBar) { _selBar.remove(); _selBar = null; } }

function selectionInLesson() {
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = String(sel).replace(/\s+/g, ' ').trim();
  if (text.length < 2 || text.length > 400) return null;
  const range = sel.getRangeAt(0);
  const host = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const card = host && host.closest && host.closest('#sos-lesson-root .sl-card');
  if (!card) return null;
  const block = host.closest('p, li, td, th, blockquote, .sl-step, .sl-q-stem, .sl-expl') || host;
  return { text, rect: range.getBoundingClientRect(), context: String(block.textContent || '').replace(/\s+/g, ' ').trim() };
}

/** The sentence of `context` that holds `text`, with `text` as blank 1. */
export function clozeFrom(context, text) {
  const sentences = String(context || '').split(/(?<=[.!?])\s+/);
  const s = sentences.find((x) => x.includes(text)) || context || text;
  const at = s.indexOf(text);
  return at < 0 ? `{{1::${text}}}` : `${s.slice(0, at)}{{1::${text}}}${s.slice(at + text.length)}`;
}

function onSelect() {
  if (!S) return;
  const view = document.getElementById('view-lesson');
  if (!view || !view.classList.contains('active')) return hideSelBar();
  const s = selectionInLesson();
  if (!s) return hideSelBar();
  hideSelBar();
  const bar = document.createElement('div');
  bar.className = 'sl-selbar';
  bar.style.cssText = `position:fixed;z-index:9000;left:${Math.max(8, Math.min(window.innerWidth - 190, s.rect.left))}px;` +
    `top:${Math.max(8, s.rect.top - 44)}px;display:flex;gap:4px;background:var(--bg4,#2e2f33);border:1px solid var(--border,rgba(255,255,255,.09));` +
    'border-radius:8px;padding:4px;box-shadow:0 4px 14px rgba(0,0,0,.35)';
  bar.innerHTML = '<button data-sel="card" class="sl-inline-btn" style="padding:6px 10px">＋ Card</button><button data-sel="cloze" class="sl-inline-btn" style="padding:6px 10px">＋ Cloze</button>';
  bar.addEventListener('mousedown', (e) => e.preventDefault());       // keep the selection
  bar.querySelectorAll('[data-sel]').forEach((b) => b.addEventListener('click', () => {
    const c = cur();
    hideSelBar();
    if (!c) return;
    newCard(c, b.dataset.sel === 'cloze' ? clozeFrom(s.context, s.text) : `${s.text}\n---\n`);
  }));
  document.body.appendChild(bar);
  _selBar = bar;
}
document.addEventListener('mouseup', () => setTimeout(onSelect, 0));
document.addEventListener('touchend', () => setTimeout(onSelect, 250));
document.addEventListener('scroll', hideSelBar, true);

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
