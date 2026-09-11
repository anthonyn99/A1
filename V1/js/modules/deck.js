/* ============================================================================
 * StudyOS — card store  (upgrade spec R-1 / R-2 / R-5)
 * ============================================================================
 * Where flashcards and their scheduling state live, and the queue-building on
 * top of them.
 *
 * ── WHY NOT IN THE MAIN SYNC DOCUMENT ─────────────────────────────────────
 * The obvious move is to add `cards` to the payload in _sosFirebaseSave()
 * alongside classes/events/tasks. That would be a serious bug.
 *
 * That document is written with a whole-document setDoc on a 400ms debounce.
 * Review state is the most write-heavy data in the app — one write per card
 * graded, dozens per session — and it is exactly the data most likely to be
 * changed on two devices at once (phone between classes, laptop at night).
 * Whole-document last-write-wins would mean the laptop's save silently erasing
 * a phone session's entire review history. Losing a week of scheduling is worse
 * than losing a note, because nothing on screen would look wrong.
 *
 * So this follows the precedent js/notes-sync.js already set for per-module
 * notes: ONE DOCUMENT PER CLASS, written through its own debounced path, with
 * the same "never write before the server copy has been seen" guard that keeps
 * a cold start from clobbering another device (firebase-sync.js
 * _notesWhenServerSeen). Two classes studied on two devices never touch the
 * same document at all.
 *
 * localStorage mirrors each class under studyos_cards_<classId> so a review
 * session works offline and survives a reload.
 *
 * ── CARD vs SCHEDULE ──────────────────────────────────────────────────────
 * A card's CONTENT (from cards.js) and its SCHEDULE (from fsrs.js) are kept in
 * one object but touched by different code paths: content changes only when a
 * note is re-extracted, schedule changes on every review. mergeCards() in
 * cards.js is what keeps the two from stepping on each other.
 * ------------------------------------------------------------------------- */

import { store } from './store.js';
import * as fsrs from './fsrs.js';
import * as cards from './cards.js';

const LS_PREFIX = 'studyos_cards_';
const DEBOUNCE_MS = 600;

const _mem = new Map();          // classId -> card[]
const _timers = new Map();
let _loaded = false;

const lsKey = (classId) => LS_PREFIX + classId;

function emit(entity = 'cards') {
  try { window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity } })); }
  catch (e) {}
}

// ── Local persistence ───────────────────────────────────────────────────────
function readLocal(classId) {
  try {
    const raw = localStorage.getItem(lsKey(classId));
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v : [];
  } catch (e) {
    console.warn('[deck] unreadable card store for', classId, e);
    return [];
  }
}

function writeLocal(classId, list) {
  try { localStorage.setItem(lsKey(classId), JSON.stringify(list)); }
  catch (e) { console.warn('[deck] could not save cards for', classId, e); }
}

/**
 * Persist a class's cards: localStorage immediately (so a reload never loses a
 * review), Firestore on a debounce (so grading twenty cards is one write, not
 * twenty).
 */
function persist(classId) {
  const list = _mem.get(classId) || [];
  writeLocal(classId, list);
  emit();

  if (_timers.has(classId)) clearTimeout(_timers.get(classId));
  _timers.set(classId, setTimeout(() => {
    _timers.delete(classId);
    try {
      if (window._fbSaveCards) window._fbSaveCards(classId, list);
    } catch (e) { console.warn('[deck] cloud save failed for', classId, e); }
  }, DEBOUNCE_MS));
}

/** Load every class's cards from localStorage. Cheap; call before any read. */
export function load() {
  if (_loaded) return;
  _loaded = true;
  for (const cls of store.getClasses()) {
    if (cls && cls.id) _mem.set(cls.id, readLocal(cls.id));
  }
}

/**
 * Apply a remote copy for one class.
 *
 * Union by fingerprint, keeping whichever side reviewed a card LAST. A plain
 * overwrite would discard whichever device synced second — the exact data loss
 * this whole module is arranged to avoid. Reviewing the same card on two
 * devices within one sync window is the only case that can lose anything, and
 * then it loses one grade rather than a session.
 */
export function applyRemote(classId, remoteList) {
  if (!classId || !Array.isArray(remoteList)) return false;
  load();
  const mine = _mem.get(classId) || [];
  const byFp = new Map(mine.map((c) => [c.fp, c]));

  for (const r of remoteList) {
    if (!r || !r.fp) continue;
    const local = byFp.get(r.fp);
    if (!local) { byFp.set(r.fp, r); continue; }
    const lt = (local.sched && local.sched.lastReview) || 0;
    const rt = (r.sched && r.sched.lastReview) || 0;
    if (rt > lt) byFp.set(r.fp, r);
  }

  const merged = [...byFp.values()];
  _mem.set(classId, merged);
  writeLocal(classId, merged);
  emit();
  return true;
}

// ── Reads ───────────────────────────────────────────────────────────────────
export function forClass(classId) {
  load();
  return _mem.get(classId) || [];
}

export function all() {
  load();
  const out = [];
  for (const list of _mem.values()) out.push(...list);
  return out;
}

export function get(cardId) {
  return all().find((c) => c.id === cardId) || null;
}

export function countsFor(classId) {
  const list = classId ? forClass(classId) : all();
  const now = Date.now();
  let due = 0, unseen = 0;
  for (const c of list) {
    if (!c.sched || c.sched.state === fsrs.STATE.NEW) unseen++;
    else if (fsrs.isDue(c.sched, now)) due++;
  }
  return { total: list.length, due, unseen, dueNow: due + unseen };
}

// ── Extraction ──────────────────────────────────────────────────────────────
/**
 * Generate cards from one note and merge them into the class's deck.
 *
 * Returns { added, kept, orphaned } so the caller can tell her what happened
 * — "12 new cards" is useful, a silent change is not.
 */
export function generateFromNote(classId, moduleId, note, { html = false } = {}) {
  if (!classId || !note) return { added: [], kept: [], orphaned: [] };
  load();

  const src = {
    classId, moduleId,
    noteId: note.id,
    title: note.title || '',
  };
  const body = html ? (note.data && note.data.html) || '' : note.body || '';
  const fresh = html ? cards.fromHtml(body, src) : cards.fromPlainText(body, src);

  const existing = _mem.get(classId) || [];
  // Only reconcile against cards from THIS note. Merging against the whole
  // class would report every other note's cards as orphaned.
  const mine = existing.filter((c) => c.sourceNoteId === note.id);
  const others = existing.filter((c) => c.sourceNoteId !== note.id);

  const { merged, added, kept, orphaned } = cards.mergeCards(mine, fresh);
  _mem.set(classId, [...others, ...merged]);
  persist(classId);
  return { added, kept, orphaned };
}

/** "Make cards from this selection" (R-1). */
export function generateFromSelection(classId, moduleId, fragment, title = '') {
  if (!classId || !fragment) return [];
  load();
  const fresh = cards.fromSelection(fragment, {
    classId, moduleId, noteId: 'sel_' + Date.now(), title,
  });
  const existing = _mem.get(classId) || [];
  const seen = new Set(existing.map((c) => c.fp));
  const added = fresh.filter((c) => !seen.has(c.fp));
  if (added.length) {
    _mem.set(classId, [...existing, ...added]);
    persist(classId);
  }
  return added;
}

/** Remove cards, by id. Used by the review surface's "delete this card". */
export function remove(classId, cardIds) {
  load();
  const ids = new Set(Array.isArray(cardIds) ? cardIds : [cardIds]);
  const list = _mem.get(classId) || [];
  const next = list.filter((c) => !ids.has(c.id));
  if (next.length === list.length) return false;
  _mem.set(classId, next);
  persist(classId);
  return true;
}

// ── Exam-aware scheduling (R-2) ─────────────────────────────────────────────
/**
 * The next exam for a class, as a timestamp, or null.
 *
 * Drives interval compression: a card tied to a class with an exam in 8 days
 * must not be scheduled 30 days out. Reads events and tasks through the store
 * so it sees exactly what the dashboard sees.
 */
export function nextExamFor(classId, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  let best = null;
  for (const e of store.getEvents()) {
    if (!e || e.classId !== classId) continue;
    if (e.type !== 'exam' && e.type !== 'quiz') continue;
    if (!e.date || e.date < today) continue;
    const ts = new Date(e.date + 'T09:00:00').getTime();
    if (!best || ts < best) best = ts;
  }
  return best;
}

// ── Review ──────────────────────────────────────────────────────────────────
/**
 * Grade a card and reschedule it.
 *
 * The exam lookup happens HERE rather than in fsrs.js: the scheduler stays a
 * pure function of its inputs, and everything that needs app state lives on
 * this side of the line.
 */
export function gradeCard(cardId, grade, now = Date.now()) {
  load();
  for (const [classId, list] of _mem.entries()) {
    const i = list.findIndex((c) => c.id === cardId);
    if (i < 0) continue;
    const card = list[i];
    const next = fsrs.review(card.sched, grade, {
      now,
      dueBefore: nextExamFor(classId, now),
    });
    const updated = { ...card, sched: next };
    const copy = list.slice();
    copy[i] = updated;
    _mem.set(classId, copy);
    persist(classId);
    return updated;
  }
  return null;
}

/** What each grade would do, for the review buttons. */
export function previewCard(cardId, now = Date.now()) {
  const card = get(cardId);
  if (!card) return null;
  return fsrs.preview(card.sched, { now, dueBefore: nextExamFor(card.classId, now) });
}

/**
 * Build a study queue.
 *
 * `scope` is { classId } | { examId } | { topic } | {} for everything.
 * Due cards first (weakest first), then a bounded number of unseen ones — a
 * session that opens with fifty brand-new cards is one she closes.
 */
export function buildQueue(scope = {}, opts = {}) {
  load();
  const now = opts.now ?? Date.now();
  const maxNew = opts.maxNew ?? 20;
  const limit = opts.limit ?? 60;

  let pool = scope.classId ? forClass(scope.classId) : all();
  if (scope.topic) {
    const t = String(scope.topic).toLowerCase();
    pool = pool.filter((c) => (c.topic || '').toLowerCase().includes(t));
  }
  if (scope.noteId) pool = pool.filter((c) => c.sourceNoteId === scope.noteId);

  const unseen = pool.filter((c) => !c.sched || c.sched.state === fsrs.STATE.NEW);
  const due = pool.filter((c) => c.sched && c.sched.state !== fsrs.STATE.NEW
                                 && fsrs.isDue(c.sched, now));

  return [...fsrs.sortForStudy(due, now), ...unseen.slice(0, maxNew)].slice(0, limit);
}

// ── Mastery (R-5) ───────────────────────────────────────────────────────────
/**
 * Mastery as a percentage, per class or per topic.
 *
 * Defined as mean retrievability across the deck — the model's own estimate of
 * how much would be recalled right now. Deliberately NOT "cards reviewed at
 * least once", which reaches 100% while remembering nothing, and is the kind of
 * number that makes a progress bar a lie.
 *
 * Unseen cards count as 0. They are part of the material.
 */
export function mastery(classId, now = Date.now()) {
  const list = classId ? forClass(classId) : all();
  if (!list.length) return { pct: 0, total: 0, mastered: 0, weakest: null };

  let sum = 0, mastered = 0;
  let weakest = null, weakestR = 2;
  for (const c of list) {
    const s = c.sched;
    let r = 0;
    if (s && s.lastReview && s.state !== fsrs.STATE.NEW) {
      r = fsrs.retrievability((now - s.lastReview) / 86400000, s.stability);
    }
    sum += r;
    if (r >= 0.9) mastered++;
    if (r < weakestR) { weakestR = r; weakest = c; }
  }
  return {
    pct: Math.round((sum / list.length) * 100),
    total: list.length,
    mastered,
    weakest: weakest ? { topic: weakest.topic, id: weakest.id } : null,
  };
}

/** Per-topic mastery, worst first — answers "what should I study?". */
export function topicBreakdown(classId, now = Date.now()) {
  const byTopic = new Map();
  for (const c of forClass(classId)) {
    const key = c.topic || 'Untitled';
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(c);
  }
  const out = [];
  for (const [topic, list] of byTopic) {
    let sum = 0;
    for (const c of list) {
      const s = c.sched;
      sum += (s && s.lastReview && s.state !== fsrs.STATE.NEW)
        ? fsrs.retrievability((now - s.lastReview) / 86400000, s.stability)
        : 0;
    }
    out.push({ topic, pct: Math.round((sum / list.length) * 100), count: list.length });
  }
  return out.sort((a, b) => a.pct - b.pct);
}

export default {
  load, applyRemote, forClass, all, get, countsFor,
  generateFromNote, generateFromSelection, remove,
  gradeCard, previewCard, buildQueue,
  mastery, topicBreakdown, nextExamFor,
};
