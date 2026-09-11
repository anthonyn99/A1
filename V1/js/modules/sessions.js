/* ============================================================================
 * StudyOS — session log  (upgrade spec S-3)
 * ============================================================================
 * Records that studying actually happened.
 *
 * ── WHY THIS IS THE FOUNDATION OF PHASE 3 AND 4 ───────────────────────────
 * The pomodoro timer is drift-free, polished, and records NOTHING. Verified in
 * the source: no localStorage key, no persist* call, no Firestore field, and
 * `pomoSession` is an in-memory counter that wraps at 4 and resets on reload.
 * When the 25 minutes end, a chime plays and the evidence evaporates.
 *
 * That is why the app produces no sense of progress: there is nothing to look
 * back at. A session that logs nothing may as well not have happened. Streaks,
 * the heatmap, hours-by-class and the weekly review (Phase 4) are all views
 * over THIS data, so none of them can exist until sessions are written down.
 *
 * ── SAME SYNC SHAPE AS THE CARD STORE ─────────────────────────────────────
 * One Firestore document, written on a debounce, never folded into the main
 * whole-document save. Sessions are append-mostly and are written from whatever
 * device she happens to be studying on; a last-write-wins save from the laptop
 * would erase an afternoon logged on the phone. Merge is a union by id, which
 * for append-only data loses nothing.
 * ------------------------------------------------------------------------- */

import { store } from './store.js';

const LS_KEY = 'studyos_sessions_v1';
const DEBOUNCE_MS = 600;

/** Sessions shorter than this are noise — a timer started and abandoned. */
const MIN_LOGGED_MS = 60 * 1000;

/** Keep a year. Enough for the heatmap and the weekly review, bounded forever. */
const RETAIN_DAYS = 400;

let _list = null;
let _timer = null;

function emit() {
  try { window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity: 'sessions' } })); }
  catch (e) {}
}

function load() {
  if (_list) return _list;
  try {
    const raw = localStorage.getItem(LS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    _list = Array.isArray(v) ? v : [];
  } catch (e) {
    console.warn('[sessions] unreadable log, starting empty:', e);
    _list = [];
  }
  return _list;
}

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(_list || [])); }
  catch (e) { console.warn('[sessions] save failed:', e); }
  emit();

  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    _timer = null;
    try { if (window._fbSaveSessions) window._fbSaveSessions(_list || []); }
    catch (e) { console.warn('[sessions] cloud save failed:', e); }
  }, DEBOUNCE_MS);
}

/** YYYY-MM-DD in LOCAL time — a day boundary at midnight where she lives. */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Writing ────────────────────────────────────────────────────────────────
/**
 * Log a finished session.
 *
 * @param kind    'focus' (timer) | 'review' (cards) | 'task'
 * @param fields  { classId, taskId, durationMs, completed, cards, accuracy, note }
 * @returns the stored session, or null when it was too short to be real.
 */
export function log(kind, fields = {}) {
  load();
  const durationMs = Math.max(0, Math.round(fields.durationMs || 0));
  // A timer started and cancelled after ten seconds is not a study session, and
  // logging it would inflate every streak and total built on top of this.
  if (durationMs < MIN_LOGGED_MS) return null;

  const s = {
    id: 'ss_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    kind: kind || 'focus',
    classId: fields.classId || '',
    taskId: fields.taskId || '',
    startedAt: fields.startedAt || (Date.now() - durationMs),
    durationMs,
    day: dayKey(fields.startedAt || Date.now()),
    completed: fields.completed !== false,
    cards: fields.cards || 0,
    accuracy: fields.accuracy == null ? null : fields.accuracy,
    note: String(fields.note || '').slice(0, 500),
  };
  _list.push(s);
  prune();
  persist();
  return s;
}

/** Attach the "what did you get done?" line to the most recent session (S-3). */
export function annotate(sessionId, note) {
  load();
  const s = _list.find((x) => x.id === sessionId);
  if (!s) return null;
  s.note = String(note || '').slice(0, 500);
  persist();
  return s;
}

function prune() {
  const cutoff = Date.now() - RETAIN_DAYS * 86400000;
  const before = _list.length;
  _list = _list.filter((s) => (s.startedAt || 0) >= cutoff);
  return before - _list.length;
}

/** Union by id — sessions are append-only, so nothing is ever lost this way. */
export function applyRemote(remoteList) {
  if (!Array.isArray(remoteList)) return false;
  load();
  const byId = new Map(_list.map((s) => [s.id, s]));
  for (const r of remoteList) {
    if (r && r.id && !byId.has(r.id)) byId.set(r.id, r);
  }
  _list = [...byId.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  prune();
  try { localStorage.setItem(LS_KEY, JSON.stringify(_list)); } catch (e) {}
  emit();
  return true;
}

// ── Reading ────────────────────────────────────────────────────────────────
export function all() { return load().slice(); }

export function forDay(day = dayKey()) {
  return load().filter((s) => s.day === day);
}

export function since(ts) {
  return load().filter((s) => (s.startedAt || 0) >= ts);
}

/** Totals for a day: minutes, sessions, cards. */
export function dayTotals(day = dayKey()) {
  const list = forDay(day);
  return {
    day,
    minutes: Math.round(list.reduce((n, s) => n + s.durationMs, 0) / 60000),
    sessions: list.length,
    cards: list.reduce((n, s) => n + (s.cards || 0), 0),
  };
}

/**
 * The streak: consecutive days ending today (or yesterday) with a session.
 *
 * Counting back from YESTERDAY when today is still empty is deliberate — a
 * streak that reads 0 every morning until the first session punishes her for
 * not having studied yet at 9am, which is the opposite of motivating.
 */
export function streak(now = Date.now()) {
  const days = new Set(load().map((s) => s.day));
  if (!days.size) return 0;

  const today = dayKey(now);
  const yesterday = dayKey(now - 86400000);
  let cursor = days.has(today) ? now : (days.has(yesterday) ? now - 86400000 : null);
  if (cursor === null) return 0;

  let n = 0;
  while (days.has(dayKey(cursor))) {
    n++;
    cursor -= 86400000;
  }
  return n;
}

/** Minutes per class over the last `days`, biggest first (M-3). */
export function byClass(days = 7, now = Date.now()) {
  const cutoff = now - days * 86400000;
  const totals = new Map();
  for (const s of load()) {
    // A WINDOW, not just a lower bound. Filtering only on `>= cutoff` meant a
    // session after `now` still counted, so "the last 7 days" ending three
    // months ago silently reported today's work. Harmless for the live
    // dashboard, wrong for any historical view (the weekly review in M-6 asks
    // exactly this question about a past week).
    const at = s.startedAt || 0;
    if (at < cutoff || at > now) continue;
    const key = s.classId || '';
    totals.set(key, (totals.get(key) || 0) + s.durationMs);
  }
  const classes = new Map(store.getClasses().map((c) => [c.id, c]));
  return [...totals.entries()]
    .map(([classId, ms]) => ({
      classId,
      name: (classes.get(classId) || {}).name || 'Unassigned',
      color: (classes.get(classId) || {}).color || '#76777C',
      minutes: Math.round(ms / 60000),
    }))
    .sort((a, b) => b.minutes - a.minutes);
}

/** Per-day minutes for the last `days`, oldest first — the heatmap (M-3). */
export function heatmap(days = 84, now = Date.now()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const ts = now - i * 86400000;
    const t = dayTotals(dayKey(ts));
    out.push({ day: t.day, minutes: t.minutes, sessions: t.sessions });
  }
  return out;
}

/** This week's totals against a goal, for the ring (M-1). */
export function weekProgress(goalMinutes = 600, now = Date.now()) {
  const d = new Date(now);
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);

  const list = since(monday.getTime());
  const minutes = Math.round(list.reduce((n, s) => n + s.durationMs, 0) / 60000);
  return {
    minutes,
    goalMinutes,
    pct: goalMinutes > 0 ? Math.min(100, Math.round((minutes / goalMinutes) * 100)) : 0,
    sessions: list.length,
    cards: list.reduce((n, s) => n + (s.cards || 0), 0),
  };
}

export default {
  log, annotate, applyRemote, all, forDay, since,
  dayTotals, dayKey, streak, byClass, heatmap, weekProgress,
};
