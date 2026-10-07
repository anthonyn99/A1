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
 * one object but touched by different code paths: content changes when a note
 * is re-extracted or she edits the card, schedule changes on every review.
 * mergeCard() below picks each side independently, so an edit on one device
 * and a review on another both survive.
 *
 * ── DELETING IS A TOMBSTONE ───────────────────────────────────────────────
 * A deleted card stays as {id, fp, deletedAt}. A device still holding the old
 * card would otherwise push it back on its next save, and the merge — which
 * keeps anything either side has — would resurrect it.
 *
 * ── STATUS ────────────────────────────────────────────────────────────────
 *   active     in reviews (the default; old cards have no status field)
 *   suggested  generated but held back — she promotes the ones she wants
 *   archived   out of reviews, kept with its schedule, restorable
 * ------------------------------------------------------------------------- */

import { store } from './store.js';
import * as fsrs from './fsrs.js';
import * as cards from './cards.js';
import { cardSettings } from './card-settings.js';

const LS_PREFIX = 'studyos_cards_';
const DEBOUNCE_MS = 600;
const TOMBSTONE_DAYS = 60;
const DAY = 86400000;
const WARN_BYTES = 800 * 1024;     // Firestore's cap is 1 MiB per class doc

const _mem = new Map();          // classId -> card[] (tombstones included)
const _meta = new Map();         // classId -> { v, decks } — synced beside the cards
const _timers = new Map();
let _loaded = false;

const lsKey = (classId) => LS_PREFIX + classId;
const metaKey = (classId) => 'studyos_cardsmeta_' + classId;

function emit(entity = 'cards') {
  try { window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity } })); }
  catch (e) {}
}

// ── Card state ──────────────────────────────────────────────────────────────
export const isLive = (c) => !!c && !c.deletedAt;
export const statusOf = (c) => (c && c.status) || 'active';
export const isActive = (c) => isLive(c) && statusOf(c) === 'active';
export const isUnseen = (c) => !c.sched || c.sched.state === fsrs.STATE.NEW;
export const isReviewed = (c) => !!(c && c.sched && c.sched.state !== fsrs.STATE.NEW);

export function tombstone(c, now = Date.now()) {
  return { id: c.id, fp: c.fp, classId: c.classId || '', sourceNoteId: c.sourceNoteId || '',
    deletedAt: now, updatedAt: now };
}

function purgeTombstones(list, now = Date.now()) {
  const cut = now - TOMBSTONE_DAYS * DAY;
  return list.filter((c) => !c.deletedAt || c.deletedAt > cut);
}

const _warned = {};
function sizeGuard(classId, list) {
  try {
    const n = JSON.stringify(list).length;
    if (n > WARN_BYTES && !_warned[classId]) {
      _warned[classId] = true;
      console.warn(`[deck] class ${classId}: cards are ${Math.round(n / 1024)} KB, near the 1 MB sync cap`);
    }
  } catch (e) {}
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
  const list = purgeTombstones(_mem.get(classId) || []);
  _mem.set(classId, list);
  writeLocal(classId, list);
  sizeGuard(classId, list);
  emit();

  if (_timers.has(classId)) clearTimeout(_timers.get(classId));
  _timers.set(classId, setTimeout(() => {
    _timers.delete(classId);
    try {
      if (window._fbSaveCards) window._fbSaveCards(classId, _mem.get(classId) || [], metaOf(classId));
    } catch (e) { console.warn('[deck] cloud save failed for', classId, e); }
  }, DEBOUNCE_MS));
}

/** Load every class's cards from localStorage. Cheap; call before any read. */
export function load() {
  if (_loaded) return;
  _loaded = true;
  for (const cls of store.getClasses()) {
    if (cls && cls.id) {
      _mem.set(cls.id, readLocal(cls.id));
      try { const m = JSON.parse(localStorage.getItem(metaKey(cls.id)) || 'null'); if (m) _meta.set(cls.id, m); } catch (e) {}
    }
  }
}

// ── Per-class meta: the card-model version, and her own decks ──────────────
/** { v, decks: [{id, name, parentId, updatedAt, deletedAt?}] } */
export function metaOf(classId) {
  load();
  const m = _meta.get(classId) || {};
  return { v: m.v || 1, decks: Array.isArray(m.decks) ? m.decks : [] };
}

/** Merge meta from two devices: the higher version; decks by id, newest wins. */
export function mergeMeta(a, b) {
  const A = a || {}, B = b || {};
  const byId = new Map();
  for (const d of [...(A.decks || []), ...(B.decks || [])]) {
    if (!d || !d.id) continue;
    const p = byId.get(d.id);
    if (!p || (d.updatedAt || 0) > (p.updatedAt || 0)) byId.set(d.id, d);
  }
  return { v: Math.max(A.v || 1, B.v || 1), decks: [...byId.values()] };
}

export function setMeta(classId, patch) {
  load();
  const next = { ...metaOf(classId), ...(patch || {}) };
  _meta.set(classId, next);
  try { localStorage.setItem(metaKey(classId), JSON.stringify(next)); } catch (e) {}
  persist(classId);
  return next;
}

function applyRemoteMeta(classId, meta) {
  if (!meta || typeof meta !== 'object') return;
  const next = mergeMeta(metaOf(classId), meta);
  _meta.set(classId, next);
  try { localStorage.setItem(metaKey(classId), JSON.stringify(next)); } catch (e) {}
}

// ── Merging two devices' copies ─────────────────────────────────────────────
/**
 * Merge two copies of one card (same id). Content by `updatedAt`, schedule by
 * `sched.lastReview`, chosen INDEPENDENTLY. A tombstone wins over any copy not
 * changed after it.
 */
export function mergeCard(a, b) {
  if (!a) return b;
  if (!b) return a;
  const touched = (c) => c.updatedAt || c.createdAt || 0;
  if (a.deletedAt || b.deletedAt) {
    const dead = a.deletedAt && (!b.deletedAt || a.deletedAt >= b.deletedAt) ? a : b;
    const other = dead === a ? b : a;
    if (other.deletedAt || touched(other) <= dead.deletedAt) return dead;
    return other;                    // edited after the delete: the edit wins
  }
  const content = touched(b) > touched(a) ? b : a;
  const la = (a.sched && a.sched.lastReview) || 0, lb = (b.sched && b.sched.lastReview) || 0;
  const sched = lb > la ? b : a;
  const out = { ...content, sched: sched.sched || null };
  const intro = sched.introducedAt || content.introducedAt || a.introducedAt || b.introducedAt;
  if (intro) out.introducedAt = intro;
  const subs = { ...(a.subSched || {}) };
  for (const [k, v] of Object.entries(b.subSched || {})) {
    if (!subs[k] || ((v && v.lastReview) || 0) > ((subs[k] && subs[k].lastReview) || 0)) subs[k] = v;
  }
  if (Object.keys(subs).length) out.subSched = subs;
  else delete out.subSched;
  return out;
}

/**
 * Union two card lists. By id first; then two LIVE cards with different ids
 * but the same content (two devices extracted the same note) collapse into
 * one — the one reviewed last, else the smaller id, so both devices keep the
 * same survivor.
 */
export function mergeLists(mine, theirs) {
  const byId = new Map();
  for (const c of mine || []) if (c && c.id && c.fp) byId.set(c.id, c);
  for (const r of theirs || []) {
    if (!r || !r.id || !r.fp) continue;
    byId.set(r.id, mergeCard(byId.get(r.id), r));
  }
  const dead = [];
  const byFp = new Map();
  for (const c of byId.values()) {
    if (c.deletedAt) { dead.push(c); continue; }
    const prev = byFp.get(c.fp);
    if (!prev) { byFp.set(c.fp, c); continue; }
    const lp = (prev.sched && prev.sched.lastReview) || 0, lc = (c.sched && c.sched.lastReview) || 0;
    if (lc > lp || (lc === lp && c.id < prev.id)) byFp.set(c.fp, c);
  }
  return [...byFp.values(), ...dead];
}

/**
 * Apply a remote copy for one class. A plain overwrite would discard whichever
 * device synced second — the exact data loss this module is arranged to avoid.
 * Reviewing the same card on two devices within one sync window is the only
 * case that can lose anything, and then it loses one grade.
 */
export function applyRemote(classId, remoteList, remoteMeta) {
  if (!classId || !Array.isArray(remoteList)) return false;
  load();
  applyRemoteMeta(classId, remoteMeta);
  const merged = mergeLists(_mem.get(classId) || [], remoteList);
  _mem.set(classId, merged);
  writeLocal(classId, merged);
  emit();
  return true;
}

// ── Reads ───────────────────────────────────────────────────────────────────
/** Every live card of a class (tombstones are storage, not cards). */
export function forClass(classId) {
  load();
  return (_mem.get(classId) || []).filter(isLive);
}

/** Including tombstones — for the migration and the tests. */
export function rawForClass(classId) {
  load();
  return (_mem.get(classId) || []).slice();
}

function allRaw() {
  load();
  const out = [];
  for (const list of _mem.values()) out.push(...list);
  return out;
}

export function all() {
  return allRaw().filter(isLive);
}

export function get(cardId) {
  return all().find((c) => c.id === cardId) || null;
}

/** Local midnight of `now`'s day. */
function dayStart(now) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }

/** New cards introduced today, across every class (the cap is global).
 *  Derived from the cards, so every device agrees once they have synced. */
export function introducedToday(now = Date.now()) {
  const from = dayStart(now);
  let n = 0;
  for (const c of all()) if ((c.introducedAt || 0) >= from && (c.introducedAt || 0) <= now + DAY) n++;
  return n;
}

/** How many more new cards today's cap lets in. */
export function newRemaining(now = Date.now()) {
  return Math.max(0, cardSettings().newPerDay - introducedToday(now));
}

/**
 * What a class (or everything) holds. `due` is reviews owed; `newAvailable`
 * is how many unseen cards today's cap still lets in. Unseen cards are NOT
 * due — counting them as due is what made the dashboard say 1,976.
 * `toStudy` is the number a "cards due" tile should show.
 */
export function countsFor(classId, now = Date.now()) {
  const list = classId ? forClass(classId) : all();
  const gated = cardSettings().onlyReadLessons;
  let due = 0, unseen = 0, ready = 0, archived = 0, suggested = 0, active = 0;
  for (const c of list) {
    const st = statusOf(c);
    if (st === 'archived') { archived++; continue; }
    if (st === 'suggested') { suggested++; continue; }
    active++;
    if (isUnseen(c)) { unseen++; if (!gated || fromReadLesson(c)) ready++; }
    else if (fsrs.isDue(c.sched, now)) due++;
  }
  // `waiting`: new cards held until she opens their lesson.
  const newAvailable = Math.min(ready, newRemaining(now));
  return { total: list.length, active, due, unseen, waiting: unseen - ready, newAvailable, archived, suggested,
    toStudy: due + newAvailable };
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
  // class would report every other note's cards as orphaned. A card she
  // deleted stays deleted: its tombstone's fp is never re-added.
  const mine = existing.filter((c) => c.sourceNoteId === note.id && isLive(c));
  const dead = new Set(existing.filter((c) => c.deletedAt).map((c) => c.fp));
  const others = existing.filter((c) => c.sourceNoteId !== note.id || !isLive(c));

  const { merged, added, kept, orphaned } = cards.mergeCards(mine, fresh.filter((c) => !dead.has(c.fp)));
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

/**
 * Merge structured cards (a topic's flashcards) into a class.
 *
 * `src.noteId` groups them: a topic uses 'topic_<fileId>_<topicId>', so
 * regenerating one topic reconciles against THAT topic's cards only.
 * An item may carry `status` ('active' | 'suggested') and `priority`.
 *
 * Unlike note extraction, orphans that were NEVER REVIEWED are dropped (as
 * tombstones). A regenerated topic words its cards differently, so every
 * re-run would otherwise stack a second full set beside the first. An orphan
 * with review history is kept — weeks of scheduling are never thrown away
 * without asking. A card already held keeps its own status: she may have
 * archived it, or promoted a suggestion.
 */
export function addExternal(classId, moduleId, items, src = {}) {
  if (!classId) return { added: [], kept: [], dropped: [] };
  load();
  const now = Date.now();
  const noteId = src.noteId || ('ext_' + now);
  const fresh = cards.fromItems(items, { classId, moduleId, noteId, title: src.title || '' });
  const existing = _mem.get(classId) || [];
  const dead = new Set(existing.filter((c) => c.deletedAt && c.sourceNoteId === noteId).map((c) => c.fp));
  const mine = existing.filter((c) => c.sourceNoteId === noteId && isLive(c));
  const others = existing.filter((c) => c.sourceNoteId !== noteId || !isLive(c));

  const { added, kept, orphaned } = cards.mergeCards(mine, fresh.filter((c) => !dead.has(c.fp)));
  const keepOrphans = orphaned.filter(isReviewed);
  const dropped = orphaned.filter((c) => !isReviewed(c));
  _mem.set(classId, [...others, ...kept, ...added, ...keepOrphans, ...dropped.map((c) => tombstone(c, now))]);
  persist(classId);
  return { added, kept, dropped };
}

/** Cards whose sourceNoteId starts with `prefix` — e.g. every topic of one
 *  document ('topic_<fileId>_'). */
export function byNotePrefix(classId, prefix) {
  return forClass(classId).filter((c) => String(c.sourceNoteId || '').startsWith(prefix));
}

/** Delete cards, by id: each becomes a tombstone so no device brings it back. */
export function remove(classId, cardIds) {
  load();
  const ids = new Set(Array.isArray(cardIds) ? cardIds : [cardIds]);
  const list = _mem.get(classId) || [];
  let hit = 0;
  const now = Date.now();
  const next = list.map((c) => {
    if (!ids.has(c.id) || !isLive(c)) return c;
    hit++;
    return tombstone(c, now);
  });
  if (!hit) return false;
  _mem.set(classId, next);
  persist(classId);
  return true;
}

/** Find a card's class and index; null when it is not held (or dead). */
function locate(cardId) {
  load();
  for (const [classId, list] of _mem.entries()) {
    const i = list.findIndex((c) => c.id === cardId);
    if (i >= 0) return { classId, list, i };
  }
  return null;
}

function writeAt(at, card) {
  const copy = at.list.slice();
  copy[at.i] = card;
  _mem.set(at.classId, copy);
  persist(at.classId);
  return card;
}

/** Set `status` on cards ('active' | 'suggested' | 'archived'). */
export function setStatus(cardIds, status) {
  if (!['active', 'suggested', 'archived'].includes(status)) return 0;
  load();
  const ids = new Set(Array.isArray(cardIds) ? cardIds : [cardIds]);
  const now = Date.now();
  let n = 0;
  for (const [classId, list] of _mem.entries()) {
    let touched = false;
    const next = list.map((c) => {
      if (!ids.has(c.id) || !isLive(c) || statusOf(c) === status) return c;
      touched = true; n++;
      return { ...c, status, updatedAt: now };
    });
    if (touched) { _mem.set(classId, next); persist(classId); }
  }
  return n;
}

/**
 * Change a card's content. The id and the schedule stay — editing a typo
 * must not turn a card she has reviewed for weeks into a new one.
 * `patch` holds content fields (content, q, a, kind, tags, priority).
 */
export function edit(cardId, patch) {
  const at = locate(cardId);
  if (!at || !isLive(at.list[at.i])) return null;
  const prev = at.list[at.i];
  const next = cards.withContent(prev, patch || {});
  return writeAt(at, { ...next, updatedAt: Date.now() });
}

/** Put a card back exactly as a snapshot had it — undo for edit, archive and
 *  delete. The snapshot's own timestamps are bumped so the restore syncs. */
export function restoreCard(snapshot) {
  if (!snapshot || !snapshot.id) return null;
  load();
  const at = locate(snapshot.id);
  const card = { ...snapshot, updatedAt: Date.now() };
  delete card.deletedAt;
  if (at) return writeAt(at, card);
  const classId = snapshot.classId;
  if (!classId) return null;
  _mem.set(classId, [...(_mem.get(classId) || []), card]);
  persist(classId);
  return card;
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
/** The schedule of one review unit of a card: '' is the card itself; a
 *  multi-cloze card's other blanks and a reverse side live in subSched. */
export function schedOf(card, sub = '') {
  if (!card) return null;
  return sub ? ((card.subSched && card.subSched[sub]) || null) : (card.sched || null);
}

/**
 * Grade a card (or one unit of it) and reschedule it.
 *
 * The exam lookup happens HERE rather than in fsrs.js: the scheduler stays a
 * pure function of its inputs, and everything that needs app state lives on
 * this side of the line.
 */
export function gradeCard(cardId, grade, now = Date.now(), opts = {}) {
  if (typeof now === 'object' && now) { opts = now; now = opts.now ?? Date.now(); }
  const at = locate(cardId);
  if (!at || !isLive(at.list[at.i])) return null;
  const card = at.list[at.i];
  const sub = opts.sub || '';
  const prev = schedOf(card, sub);
  const next = fsrs.review(prev, grade, {
    now,
    retention: opts.retention ?? cardSettings().retention,
    dueBefore: nextExamFor(at.classId, now),
  });
  const updated = sub
    ? { ...card, subSched: { ...(card.subSched || {}), [sub]: next } }
    : { ...card, sched: next };
  if (!card.introducedAt && (!prev || prev.state === fsrs.STATE.NEW)) updated.introducedAt = now;
  // A trimmed review log: what a future per-user FSRS optimiser would need.
  const log = (card.log || []).concat([{ t: now, g: grade, s: sub || undefined }]);
  updated.log = log.slice(-50);
  return writeAt(at, updated);
}

/**
 * Put a card's scheduling state back to exactly what it was.
 *
 * The review surface's undo. A mis-tap on a phone is common and would
 * otherwise silently corrupt a card's schedule with no way back. This is a
 * direct write rather than a "reverse grade", because there is no inverse of
 * an FSRS update — only the previous object, which fsrs.review() hands back
 * untouched precisely because it is pure.
 */
export function restoreSched(cardId, sched, extra = {}) {
  const at = locate(cardId);
  if (!at) return null;
  const card = at.list[at.i];
  const sub = extra.sub || '';
  const next = sub
    ? { ...card, subSched: { ...(card.subSched || {}), [sub]: sched ? { ...sched } : null } }
    : { ...card, sched: sched ? { ...sched } : null };
  if ('introducedAt' in extra) {
    if (extra.introducedAt) next.introducedAt = extra.introducedAt; else delete next.introducedAt;
  }
  if ('log' in extra) { if (extra.log) next.log = extra.log; else delete next.log; }
  return writeAt(at, next);
}

/** What each grade would do, for the review buttons. */
export function previewCard(cardId, now = Date.now(), sub = '') {
  const card = get(cardId);
  if (!card) return null;
  return fsrs.preview(schedOf(card, sub), {
    now, retention: cardSettings().retention, dueBefore: nextExamFor(card.classId, now),
  });
}

/** Restrict a pool to a scope. */
function scoped(scope) {
  let pool = scope.classId ? forClass(scope.classId) : all();
  if (scope.topic) {
    const t = String(scope.topic).toLowerCase();
    pool = pool.filter((c) => (c.topic || '').toLowerCase().includes(t));
  }
  if (scope.noteId) pool = pool.filter((c) => c.sourceNoteId === scope.noteId);
  if (scope.notePrefix) pool = pool.filter((c) => String(c.sourceNoteId || '').startsWith(scope.notePrefix));
  if (scope.ids) { const ids = new Set(scope.ids); pool = pool.filter((c) => ids.has(c.id)); }
  if (scope.tag) pool = pool.filter((c) => (c.tags || []).includes(scope.tag));
  if (scope.deck) {
    const want = scope.deck;
    pool = pool.filter((c) => {
      const p = c.deckPath || cards.deckPathOf(c);
      return want.every((x, i) => p[i] === x) || (c.deckId && c.deckId === want[want.length - 1]);
    });
  }
  return pool;
}

/** Unseen cards in introduction order: document order, core cards first. */
export function newOrder(list) {
  return list.slice().sort((a, b) =>
    String(a.sourceNoteId || '').localeCompare(String(b.sourceNoteId || ''))
    || (a.priority || 2) - (b.priority || 2)
    || (a.order ?? 0) - (b.order ?? 0)
    || (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * Build a study queue.
 *
 * `scope` is { classId } | { topic } | { noteId } | { notePrefix } | { ids }
 * | { tag } | { deck } | {} for everything.
 * Only ACTIVE cards. Due cards first (weakest first), then unseen ones up to
 * today's new-card cap — a session that opens with fifty brand-new cards is
 * one she closes. `opts.eligible(card)` filters the unseen ones (e.g. only
 * cards from lessons she has read).
 */
export function buildQueue(scope = {}, opts = {}) {
  load();
  const now = opts.now ?? Date.now();
  const maxNew = opts.maxNew ?? newRemaining(now);
  const limit = opts.limit ?? cardSettings().reviewsPerDay;

  const pool = scoped(scope).filter((c) => statusOf(c) === 'active');
  let unseen = pool.filter(isUnseen);
  if (opts.eligible) unseen = unseen.filter(opts.eligible);
  const due = pool.filter((c) => !isUnseen(c) && fsrs.isDue(c.sched, now));

  return [...fsrs.sortForStudy(due, now), ...newOrder(unseen).slice(0, maxNew)].slice(0, limit);
}

/**
 * The study queue in REVIEW UNITS — what the review surface walks. A basic
 * card is one unit; a cloze card with blanks 1 and 2 is two, each with its
 * own schedule; a reverse pair is front→back and back→front.
 *   mode 'study'  due units, then new ones within today's cap (default)
 *   mode 'learn'  only new units
 *   mode 'review' only due units
 * A unit: { id, sub, cloze, reverse, isNew }.
 * opts.eligible(card) gates NEW cards (e.g. lessons she has read).
 */
export function studyQueue(scope = {}, opts = {}) {
  load();
  const now = opts.now ?? Date.now();
  const mode = opts.mode || 'study';
  const maxNew = opts.maxNew ?? newRemaining(now);
  const limit = opts.limit ?? cardSettings().reviewsPerDay;
  const due = [], fresh = [];
  for (const card of scoped(scope)) {
    if (statusOf(card) !== 'active') continue;
    const units = cards.unitsOf(card);
    units.forEach((u, k) => {
      const s = schedOf(card, u.key);
      const item = { id: card.id, sub: u.key, cloze: u.cloze || 0, reverse: !!u.reverse };
      if (!s || s.state === fsrs.STATE.NEW) {
        if (!opts.eligible || opts.eligible(card)) fresh.push({ ...item, isNew: true, _card: card, _k: k });
      } else if (fsrs.isDue(s, now)) due.push({ ...item, isNew: false, sched: s });
    });
  }
  const order = new Map(newOrder([...new Set(fresh.map((x) => x._card))]).map((c, i) => [c, i]));
  fresh.sort((a, b) => order.get(a._card) - order.get(b._card) || a._k - b._k);
  // The cap counts CARDS: a card's second blank is not a second new card.
  const allowed = new Set();
  const newUnits = [];
  for (const x of fresh) {
    if (!allowed.has(x.id)) { if (allowed.size >= maxNew) continue; allowed.add(x.id); }
    const { _card, _k, ...unit } = x;
    newUnits.push(unit);
  }
  const dueUnits = fsrs.sortForStudy(due, now).map(({ sched, ...u }) => u);
  const out = mode === 'learn' ? newUnits : mode === 'review' ? dueUnits : [...dueUnits, ...newUnits];
  return out.slice(0, limit);
}

/** Cram: every unit of a scope, schedule ignored, weakest first. Archived and
 *  suggested cards stay out — cram is the material she chose. */
export function cramUnits(scope = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const list = [];
  for (const card of scoped(scope)) {
    if (statusOf(card) !== 'active') continue;
    for (const u of cards.unitsOf(card)) {
      list.push({ id: card.id, sub: u.key, cloze: u.cloze || 0, reverse: !!u.reverse, isNew: false, sched: schedOf(card, u.key) || {} });
    }
  }
  const sorted = fsrs.sortForStudy(list, now).map(({ sched, ...u }) => u);
  return opts.limit ? sorted.slice(0, opts.limit) : sorted;
}

/** Mark a topic's cards as coming from a lesson she has opened — the gate
 *  for "only introduce cards from lessons I've read". One write. */
export function markLessonRead(classId, noteId, now = Date.now()) {
  load();
  const list = _mem.get(classId) || [];
  let n = 0;
  const next = list.map((c) => {
    if (c.sourceNoteId !== noteId || !isLive(c) || c.readAt) return c;
    n++;
    return { ...c, readAt: now };
  });
  if (!n) return 0;
  _mem.set(classId, next);
  persist(classId);
  return n;
}

/** May a NEW card be introduced? Not a breakdown card, or one whose lesson
 *  she has opened. */
export function fromReadLesson(card) {
  return !/^topic_/.test(String(card.sourceNoteId || '')) || !!card.readAt;
}

/** Every card of a scope regardless of schedule — cram mode. Weakest first. */
export function cramQueue(scope = {}, opts = {}) {
  const pool = scoped(scope).filter((c) => statusOf(c) !== 'suggested');
  const sorted = fsrs.sortForStudy(pool, opts.now ?? Date.now());
  return opts.limit ? sorted.slice(0, opts.limit) : sorted;
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
 * Only ACTIVE cards count: a suggestion she never chose, or a card she
 * archived, is not material she is meant to know. Unseen active cards count
 * as 0. They are part of the material.
 */
export function retrievabilityOf(c, now = Date.now()) {
  const s = c.sched;
  if (!s || !s.lastReview || s.state === fsrs.STATE.NEW) return 0;
  return fsrs.retrievability((now - s.lastReview) / DAY, s.stability);
}

export function masteryOf(list, now = Date.now()) {
  const act = (list || []).filter(isActive);
  if (!act.length) return { pct: 0, total: 0, mastered: 0, weakest: null };
  let sum = 0, mastered = 0;
  let weakest = null, weakestR = 2;
  for (const c of act) {
    const r = retrievabilityOf(c, now);
    sum += r;
    if (r >= 0.9) mastered++;
    if (r < weakestR) { weakestR = r; weakest = c; }
  }
  return {
    pct: Math.round((sum / act.length) * 100),
    total: act.length,
    mastered,
    weakest: weakest ? { topic: weakest.topic, id: weakest.id } : null,
  };
}

export function mastery(classId, now = Date.now()) {
  return masteryOf(classId ? forClass(classId) : all(), now);
}

/** Per-topic mastery, worst first — answers "what should I study?". */
export function topicBreakdown(classId, now = Date.now()) {
  const byTopic = new Map();
  for (const c of forClass(classId).filter(isActive)) {
    const key = c.topic || 'Untitled';
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(c);
  }
  const out = [];
  for (const [topic, list] of byTopic) {
    let sum = 0;
    for (const c of list) sum += retrievabilityOf(c, now);
    out.push({ topic, pct: Math.round((sum / list.length) * 100), count: list.length });
  }
  return out.sort((a, b) => a.pct - b.pct);
}

/** Replace a class's whole list (the migration's apply step). */
export function replaceClass(classId, list) {
  load();
  _mem.set(classId, list);
  persist(classId);
}

export default {
  load, applyRemote, mergeCard, mergeLists, metaOf, setMeta, mergeMeta, forClass, rawForClass, all, get, countsFor,
  introducedToday, newRemaining, isLive, isActive, statusOf, isUnseen, isReviewed, tombstone,
  generateFromNote, generateFromSelection, addExternal, byNotePrefix, remove, setStatus, edit, restoreCard,
  gradeCard, previewCard, restoreSched, schedOf, buildQueue, cramQueue, newOrder,
  studyQueue, cramUnits, markLessonRead, fromReadLesson,
  mastery, masteryOf, retrievabilityOf, topicBreakdown, nextExamFor, replaceClass,
};
