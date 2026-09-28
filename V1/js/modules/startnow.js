/* ============================================================================
 * StudyOS — "Start now"  (engagement upgrade 5.3)
 * ============================================================================
 * One button that picks the single best ten minutes and starts it: a timer
 * behind, a study session in front. No questions asked — every decision put
 * between her and starting is a place to stop.
 *
 * ── HOW IT CHOOSES ────────────────────────────────────────────────────────
 * Candidates, per class, in the order the spec gives:
 *
 *   review   cards due today (inside the daily cap)          factor 1.0
 *   weak     her most-missed topic (progress.js)              factor 0.85
 *   quiz     practice questions she has not answered/missed   factor 0.7
 *   new      cards she has never seen                          factor 0.6
 *
 * each multiplied by that class's PRESSURE: the highest priority score
 * (studyos.js _sosPriorityScore — urgency × weight × readiness) among its
 * exams/quizzes/homework in the next 30 days, or a small baseline when
 * nothing is due. So "due cards first" holds within a class, but a class with
 * an exam in two days outranks due cards in a class with nothing coming.
 *
 * Inside three days of an exam the quiz factor is raised above review: that
 * close in, practising the exam format beats spaced review.
 *
 * rank() is pure — every input is passed in — so the choice is testable
 * without a browser. pick() gathers the inputs from the app; start() runs it.
 * ------------------------------------------------------------------------- */

const FACTOR = { review: 1.0, weak: 0.85, quiz: 0.7, new: 0.6 };
const BASELINE_PRESSURE = 50;          // = urgency 5 × default weight 10
const EXAM_CRUNCH_DAYS = 3;

/**
 * @param {Array<object>} classes  [{ id, name, pressure, examInDays, due, unseen,
 *                                    quizOpen, weakTopic, launchers }]
 *        launchers: which kinds this build can actually run (a missing module
 *        must never be picked, or the button would do nothing)
 * @returns {object|null} { kind, classId, className, score, reason }
 */
export function rank(classes) {
  const out = [];
  for (const c of classes || []) {
    const p = c.pressure > 0 ? c.pressure : BASELINE_PRESSURE;
    const can = c.launchers || { review: true, new: true };
    const crunch = c.examInDays != null && c.examInDays <= EXAM_CRUNCH_DAYS;
    const f = { ...FACTOR, ...(crunch ? { quiz: 1.1 } : {}) };
    const when = c.examInDays == null ? '' : c.examInDays === 0 ? ' — exam today'
      : ` — exam in ${c.examInDays} day${c.examInDays === 1 ? '' : 's'}`;

    if (can.review && c.due > 0) {
      // 0.9–1.0: a bigger pile ranks a little higher, but even ONE due card
      // stays above the weak-spot tier (0.85) — "due first" is the spec order.
      out.push({ kind: 'review', score: p * f.review * (0.9 + Math.min(c.due, 25) / 250),
        reason: `${c.due} card${c.due === 1 ? '' : 's'} due in ${c.name}${when}` });
    }
    if (can.weak && c.weakTopic) {
      out.push({ kind: 'weak', topic: c.weakTopic, score: p * f.weak,
        reason: `Your weakest spot in ${c.name}: ${c.weakTopic}${when}` });
    }
    if (can.quiz && c.quizOpen > 0) {
      out.push({ kind: 'quiz', score: p * f.quiz,
        reason: `Practice quiz for ${c.name}${when}` });
    }
    if (can.new && c.unseen > 0) {
      out.push({ kind: 'new', score: p * f.new,
        reason: `New material in ${c.name}: ${Math.min(c.unseen, 15)} fresh cards${when}` });
    }
    for (const o of out) if (!o.classId) { o.classId = c.id; o.className = c.name; }
  }
  out.sort((a, b) => b.score - a.score);
  return out[0] || null;
}

// ── Gathering inputs from the app ───────────────────────────────────────────
function daysUntil(dateStr, now) {
  const d = new Date(dateStr + 'T12:00:00').getTime();
  return Math.max(0, Math.ceil((d - now) / 86400000));
}

export function gather(now = Date.now()) {
  const S = window.SOS || {};
  const store = S.store;
  if (!store || !S.deck) return [];
  const items = typeof window._sosScheduleItemsPublic === 'function' ? window._sosScheduleItemsPublic() : [];
  const today = new Date(now).toISOString().slice(0, 10);
  const in30 = new Date(now + 30 * 86400000).toISOString().slice(0, 10);
  const daily = S.deck.dueToday(now);
  const launchers = {
    review: !!S.review,
    new: !!S.review,
    quiz: !!(S.quizUi && S.quiz),
    weak: !!(S.progress && S.practice),
  };

  const out = [];
  for (const cls of store.getClasses()) {
    if (!cls || !cls.id) continue;
    const upcoming = items.filter((e) => e.classId === cls.id && ['exam', 'hw', 'quiz'].includes(e.type)
      && e.date >= today && e.date <= in30);
    const pressure = upcoming.reduce((m, e) => Math.max(m, window._sosUrgencyOf ? window._sosUrgencyOf(e) : 0), 0);
    const exams = upcoming.filter((e) => e.type === 'exam' || e.type === 'quiz');
    const examInDays = exams.length ? Math.min(...exams.map((e) => daysUntil(e.date, now))) : null;

    const c = S.deck.countsFor(cls.id);
    // Due is bounded by what is left of TODAY's cap, so the button never
    // promises a review the daily queue would then refuse.
    const due = Math.min(c.due, daily.left);
    const q = S.quiz ? S.quiz.countsFor(cls.id) : { unattempted: 0, missedLast: 0 };
    const weak = S.progress ? (S.progress.weakTopics(cls.id, 1)[0] || null) : null;
    out.push({
      id: cls.id, name: cls.name || 'Class', pressure, examInDays,
      due, unseen: daily.left > 0 ? c.unseen : 0,
      quizOpen: (q.unattempted || 0) + (q.missedLast || 0),
      weakTopic: weak ? weak.topic : null,
      launchers,
    });
  }
  return out;
}

export function pick(now = Date.now()) {
  return rank(gather(now));
}

// ── Running it ──────────────────────────────────────────────────────────────
export const MINUTES = 10;

/**
 * Pick and start. Returns the choice (or null when there is nothing to do).
 * The timer starts first so a session that errors still leaves her in a
 * running focus block rather than nowhere.
 */
export function start({ minutes = MINUTES } = {}) {
  const S = window.SOS || {};
  const choice = pick();
  const notify = (i, t, b) => { try { window.showNotif && window.showNotif(i, t, b); } catch (e) {} };
  if (!choice) {
    notify('✅', 'All caught up', 'Nothing due, no weak spots, no new material. Add a study kit to a lecture to get more.');
    return null;
  }
  try { if (window.sosStartPomoFor) window.sosStartPomoFor(choice.classId, minutes); } catch (e) {}

  const scope = { classId: choice.classId };
  if (choice.kind === 'review') S.review.startReview(scope, { daily: true, limit: 25 });
  else if (choice.kind === 'new') S.review.startReview(scope, { maxNew: 15, limit: 15 });
  else if (choice.kind === 'quiz') S.quizUi.startQuiz({ ...scope }, { n: 8, source: 'startnow' });
  else if (choice.kind === 'weak') S.practice.startWeakSpots(choice.classId, { topic: choice.topic });

  notify('▶', `Started · ${minutes} min`, esc(choice.reason));
  return choice;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export default { rank, gather, pick, start, MINUTES };
