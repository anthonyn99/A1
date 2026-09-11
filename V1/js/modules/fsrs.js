/* ============================================================================
 * StudyOS — FSRS scheduler  (upgrade spec R-2)
 * ============================================================================
 * Free Spaced Repetition Scheduler. Decides WHEN a card comes back.
 *
 * Chosen over SM-2 (the Anki classic) because it models memory with two
 * separate variables instead of one:
 *
 *   stability  — how many days until recall probability decays to 90%
 *   difficulty — how hard this particular card is for this particular person
 *
 * SM-2 collapses both into a single "ease factor", which is why it over-reviews
 * easy cards and under-reviews hard ones. FSRS gets measurably better retention
 * per review, which matters most in the case this app exists for: limited time
 * before an exam.
 *
 * ── EVERYTHING HERE IS A PURE FUNCTION ────────────────────────────────────
 * No DOM, no storage, no clock of its own — `now` is always passed in. That is
 * deliberate: scheduling bugs are invisible (a card silently comes back in 3
 * days instead of 30, and nothing looks broken), so this has to be testable
 * exhaustively without a browser. See scripts/test-fsrs.mjs.
 *
 * ── THE ALGORITHM ─────────────────────────────────────────────────────────
 * Retrievability after t days with stability S, using the FSRS-4.5 power curve:
 *
 *     R(t,S) = (1 + F · t/S) ^ C          F = 19/81, C = -0.5
 *
 * That curve fits human forgetting better than the exponential SM-2 assumes:
 * forgetting is fast at first, then flattens, and a power law captures the tail.
 *
 * The 17 weights `W` are the published FSRS-4.5 defaults, fitted against a very
 * large review corpus. They are NOT arbitrary and should not be hand-tuned —
 * FSRS optimises them per-user from review history, which is a later feature
 * (the review log this module's caller keeps is what would feed it).
 * ------------------------------------------------------------------------- */

/** Published FSRS-4.5 default weights. Do not hand-edit. */
export const DEFAULT_W = [
  0.4872, 1.4003, 3.7145, 13.8206,   // w0-w3   initial stability per grade
  5.1618, 1.2298, 0.8975, 0.031,     // w4-w7   initial + next difficulty
  1.6474, 0.1367, 1.0461,            // w8-w10  stability growth on success
  2.1072, 0.0793, 0.3246, 1.587,     // w11-w14 stability after a lapse
  0.2272, 2.8755,                    // w15-w16 hard penalty / easy bonus
];

const F = 19 / 81;
const C = -0.5;

/** Target recall probability when a card comes due. 0.9 is the FSRS default. */
export const DEFAULT_RETENTION = 0.9;

/**
 * Longest interval we will ever schedule, in days.
 *
 * Uncapped FSRS is mathematically right and practically useless here: a card
 * answered Good eight times lands 2,409 days out, and one answered Easy six
 * times reaches ~47,900 — well past the heat death of a semester. For a student
 * the honest ceiling is "some time next term": a year keeps genuinely-known
 * material out of the way without ever letting a card disappear for a decade.
 *
 * This is a product decision, not an algorithm change — the stability model is
 * untouched, only the emitted interval is clamped.
 */
export const MAX_INTERVAL_DAYS = 365;

export const GRADE = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };
export const STATE = { NEW: 'new', LEARNING: 'learning', REVIEW: 'review', RELEARNING: 'relearning' };

const clampD = (d) => Math.min(10, Math.max(1, d));
const clampS = (s) => Math.max(0.01, s);
const DAY = 86400000;

/** Probability of recall t days after a review of a card with stability s. */
export function retrievability(t, s) {
  if (!(s > 0)) return 0;
  return Math.pow(1 + F * (Math.max(0, t) / s), C);
}

/** Days until retrievability falls to `retention`. The inverse of the above. */
export function intervalFor(stability, retention = DEFAULT_RETENTION) {
  const s = clampS(stability);
  const days = (s / F) * (Math.pow(retention, 1 / C) - 1);
  // Never below a day (sub-day intervals belong to the learning steps, not the
  // long-term scheduler), never beyond the practical ceiling.
  return Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(days)));
}

/** A brand-new card, unseen. */
export function newCard(now = Date.now()) {
  return {
    stability: 0, difficulty: 0,
    due: now, lastReview: null,
    reps: 0, lapses: 0,
    state: STATE.NEW,
  };
}

// ── Initial values, for the first review of a card ──────────────────────────
const initialStability = (g, w) => clampS(w[g - 1]);
const initialDifficulty = (g, w) => clampD(w[4] - (g - 3) * w[5]);

// ── Updates, for every review after the first ───────────────────────────────
function nextDifficulty(d, g, w) {
  // Drift toward the "easy" anchor so a card that was once hard can recover
  // rather than staying difficult forever.
  const delta = d - w[6] * (g - 3);
  const anchor = initialDifficulty(GRADE.EASY, w);
  return clampD(w[7] * anchor + (1 - w[7]) * delta);
}

function successStability(d, s, r, g, w) {
  const hard = g === GRADE.HARD ? w[15] : 1;
  const easy = g === GRADE.EASY ? w[16] : 1;
  // Growth shrinks as difficulty and stability rise, and is largest when
  // retrievability was LOW — i.e. reviewing just before you would have
  // forgotten teaches the most. That is the spacing effect, in one line.
  const growth = Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9])
               * (Math.exp((1 - r) * w[10]) - 1) * hard * easy;
  return clampS(s * (1 + growth));
}

function lapseStability(d, s, r, w) {
  return clampS(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]));
}

/**
 * Apply one review.
 *
 * @param card   scheduling state (from newCard() or a previous review)
 * @param grade  1 Again · 2 Hard · 3 Good · 4 Easy
 * @param opts   { now, retention, w, dueBefore }
 * @returns a NEW card object — the input is never mutated, so a caller can
 *          preview an outcome (used by the review UI to show "next: 3d") and
 *          undo is a matter of keeping the old object.
 */
export function review(card, grade, opts = {}) {
  const now = opts.now ?? Date.now();
  const w = opts.w || DEFAULT_W;
  const retention = opts.retention ?? DEFAULT_RETENTION;
  const g = Math.min(4, Math.max(1, Math.round(grade)));

  const prev = card || newCard(now);
  let { stability, difficulty, reps, lapses, state } = prev;

  if (state === STATE.NEW || !prev.lastReview) {
    stability = initialStability(g, w);
    difficulty = initialDifficulty(g, w);
    state = g === GRADE.AGAIN ? STATE.LEARNING : STATE.REVIEW;
  } else {
    const elapsedDays = Math.max(0, (now - prev.lastReview) / DAY);
    const r = retrievability(elapsedDays, prev.stability);
    difficulty = nextDifficulty(prev.difficulty, g, w);
    if (g === GRADE.AGAIN) {
      stability = lapseStability(difficulty, prev.stability, r, w);
      lapses += 1;
      state = STATE.RELEARNING;
    } else {
      stability = successStability(difficulty, prev.stability, r, g, w);
      state = STATE.REVIEW;
    }
  }

  let interval = intervalFor(stability, retention);
  // A failed card must come back in this session, not tomorrow — that is the
  // whole point of grading it Again. The caller re-queues it; `due` is set to
  // now so any due-filter picks it up immediately.
  if (g === GRADE.AGAIN) interval = 0;

  // Exam-aware compression (R-2). When the card's topic has an exam coming up,
  // never schedule past it: a card first seen again the day AFTER the exam was
  // not studied at all. Compressed to land a day early, and to at least
  // tomorrow so it doesn't collapse into today's queue and cause churn.
  if (opts.dueBefore) {
    const maxDays = Math.floor((opts.dueBefore - now) / DAY) - 1;
    if (maxDays >= 1 && interval > maxDays) interval = maxDays;
  }

  return {
    stability, difficulty,
    due: now + interval * DAY,
    lastReview: now,
    reps: reps + 1,
    lapses,
    state,
    lastInterval: interval,
  };
}

/**
 * What each grade would do, without committing. Lets the review UI label its
 * buttons with the real next interval ("Good · 4d") instead of guessing.
 */
export function preview(card, opts = {}) {
  const out = {};
  for (const [name, g] of Object.entries(GRADE)) {
    const next = review(card, g, opts);
    out[name.toLowerCase()] = { days: next.lastInterval, due: next.due };
  }
  return out;
}

/** Is this card due at `now`? A card with no schedule is due immediately. */
export function isDue(card, now = Date.now()) {
  if (!card) return true;
  return (card.due ?? 0) <= now;
}

/**
 * Order a set of cards for study.
 *
 * Weakest first, not oldest first: with limited time before an exam, the cards
 * most likely to be forgotten are the ones worth the minutes. Overdue cards
 * with low retrievability sort to the front; brand-new cards are interleaved
 * rather than front-loaded, so a session never opens with a wall of unseen
 * material.
 */
export function sortForStudy(cards, now = Date.now()) {
  const scored = (cards || []).map((c) => {
    const s = c.sched || c;
    const elapsed = s.lastReview ? (now - s.lastReview) / DAY : 0;
    const r = s.state === STATE.NEW || !s.lastReview ? 1.5 : retrievability(elapsed, s.stability);
    return { card: c, r };
  });
  scored.sort((a, b) => a.r - b.r);
  return scored.map((x) => x.card);
}

export default {
  DEFAULT_W, DEFAULT_RETENTION, GRADE, STATE,
  newCard, review, preview, isDue, retrievability, intervalFor, sortForStudy,
};
