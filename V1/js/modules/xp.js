/* ============================================================================
 * StudyOS — XP and levels  (engagement upgrade 5.1)
 * ============================================================================
 * XP is stored ON SESSIONS (sessions.js `xp`), never as a separate running
 * total. Sessions are append-only and already synced, so the total is simply
 * their sum: it survives every device, cannot drift from the history that
 * earned it, and a union merge can never double- or under-count it.
 *
 * One table of weights, here, so tuning the economy is a one-line change.
 * Harder work earns more; correct answers earn more than attempts, but an
 * attempt is never worth zero — showing up is the behaviour being built.
 * ------------------------------------------------------------------------- */

export const WEIGHTS = {
  reviewCard: 1,          // per card graded
  reviewRecalled: 1,      // bonus per card not graded Again
  quizAttempt: 1,
  quizCorrect: 3,
  drillAttempt: 1,
  drillCorrect: 2,        // × difficulty (1–3)
  explainPer10: 1,        // score 80 -> 8 XP
  mockMultiplier: 1.5,    // on top of quiz rates
  bossWin: 50,
};

export const forReview = ({ cards = 0, again = 0 } = {}) =>
  cards * WEIGHTS.reviewCard + Math.max(0, cards - again) * WEIGHTS.reviewRecalled;

export const forQuiz = ({ items = 0, correct = 0, mock = false } = {}) =>
  Math.round((items * WEIGHTS.quizAttempt + correct * WEIGHTS.quizCorrect) * (mock ? WEIGHTS.mockMultiplier : 1));

export const forDrillItem = ({ correct, difficulty = 1 } = {}) =>
  WEIGHTS.drillAttempt + (correct ? WEIGHTS.drillCorrect * Math.max(1, Math.min(3, difficulty)) : 0);

export const forExplain = (score = 0) => Math.round((Math.max(0, Math.min(100, score)) / 10) * WEIGHTS.explainPer10);

/** Level L starts at 25·(L−1)² XP: quick early levels, steadily longer later. */
export function levelFor(total) {
  const level = Math.floor(Math.sqrt(Math.max(0, total) / 25)) + 1;
  const start = 25 * (level - 1) ** 2;
  const next = 25 * level ** 2;
  return { level, xp: total, into: total - start, span: next - start };
}

export function totalXp(list) {
  const sessions = list || (window.SOS && window.SOS.sessions ? window.SOS.sessions.all() : []);
  return sessions.reduce((n, s) => n + (s.xp || 0), 0);
}

export function levelInfo(list) {
  return levelFor(totalXp(list));
}

/** XP earned today (for the session summary and the home tile). */
export function todayXp(now = Date.now(), list) {
  const sessions = list || (window.SOS && window.SOS.sessions ? window.SOS.sessions.all() : []);
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  return sessions.filter((s) => (s.startedAt || 0) >= d.getTime()).reduce((n, s) => n + (s.xp || 0), 0);
}

// ── Streak with one forgiving freeze (5.1) ──────────────────────────────────
/* Missing ONE day does not reset the streak if no freeze was used in the
 * previous 7 days: the gap day is recorded as a freeze (synced, in
 * progress.js) and counts as studied. Missing two days in a row still ends
 * it — a freeze forgives a slip, not a break.
 *
 * Pure core (planFreeze) + an app wrapper (streakInfo) that persists it. */
export const FREEZE_EVERY_DAYS = 7;

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The day to freeze now, or null. `studied` = Set of day keys with sessions. */
export function planFreeze(studied, freezes, now = Date.now()) {
  const y1 = dayKey(now - 86400000), y2 = dayKey(now - 2 * 86400000);
  const has = (d) => studied.has(d) || freezes.includes(d);
  // The gap must be exactly yesterday: studied the day before, not yesterday.
  if (has(y1) || !has(y2)) return null;
  const recent = freezes.some((f) => (now - new Date(f + 'T12:00:00').getTime()) / 86400000 < FREEZE_EVERY_DAYS);
  return recent ? null : y1;
}

export function streakInfo(now = Date.now()) {
  const S = window.SOS || {};
  if (!S.sessions) return { streak: 0, froze: null, freezeReady: true };
  const studied = new Set(S.sessions.all().map((s) => s.day));
  let freezes = S.progress ? S.progress.freezes() : [];
  // Not in the first seconds after load: yesterday's session on ANOTHER
  // device may still be syncing, and spending the week's freeze on a day that
  // was actually studied cannot be undone.
  const settled = typeof performance === 'undefined' || performance.now() > 8000;
  const f = settled ? planFreeze(studied, freezes, now) : null;
  if (f && S.progress) { S.progress.addFreeze(f); freezes = [...freezes, f]; }
  const last = freezes.length ? freezes[freezes.length - 1] : null;
  const freezeReady = !freezes.some((x) => (now - new Date(x + 'T12:00:00').getTime()) / 86400000 < FREEZE_EVERY_DAYS);
  return { streak: S.sessions.streak(now, freezes), froze: f || null, lastFreeze: last, freezeReady };
}

export default { WEIGHTS, forReview, forQuiz, forDrillItem, forExplain, levelFor, totalXp, levelInfo, todayXp, planFreeze, streakInfo };
