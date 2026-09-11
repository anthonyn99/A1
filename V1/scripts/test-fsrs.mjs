// Tests for js/modules/fsrs.js — the spaced-repetition scheduler (spec R-2).
//
// Scheduling bugs are INVISIBLE. A card that should return in 30 days silently
// coming back in 3 looks like nothing at all: no error, no wrong pixel, just
// wasted study time and worse retention. So this leans on properties that must
// hold for every input rather than a handful of worked examples.
//
// The cases that earn their place:
//
//   "Again always shortens, Easy always lengthens"
//       If a grade ever moved the interval the wrong way the whole thing is
//       backwards, and the only symptom is studying feeling unproductive.
//
//   "exam compression never schedules past the exam"
//       A card first seen again the day AFTER the exam was not studied. This is
//       the feature that makes the scheduler exam-aware, and it silently does
//       nothing if the arithmetic is off by a day.
//
//   "review() never mutates its input"
//       The UI previews all four outcomes before committing one. If preview
//       mutated, looking at a card would reschedule it.
//
// Run with:  npm run test:fsrs
import * as F from '../js/modules/fsrs.js';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra))); }
};

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 11);

// ── Retrievability curve ──────────────────────────────────────────────────
console.log('\nretrievability');
t('perfect recall at t=0', F.retrievability(0, 10) === 1);
t('decays with time', F.retrievability(20, 10) < F.retrievability(5, 10));
t('higher stability decays slower', F.retrievability(10, 50) > F.retrievability(10, 5));
t('never negative', F.retrievability(100000, 1) >= 0);
t('zero stability is not recallable', F.retrievability(1, 0) === 0);
{
  // The defining property: at exactly one interval, recall is the target.
  const s = 12;
  const i = F.intervalFor(s, 0.9);
  const r = F.retrievability(i, s);
  t('interval lands near 90% recall', Math.abs(r - 0.9) < 0.02, { i, r });
}
t('a higher retention target means shorter gaps',
  F.intervalFor(20, 0.95) < F.intervalFor(20, 0.85));
t('interval never drops below a day', F.intervalFor(0.001) >= 1);

// ── First review ──────────────────────────────────────────────────────────
console.log('\nfirst review of a new card');
{
  const c = F.newCard(NOW);
  t('starts as new', c.state === 'new' && c.reps === 0);

  const grades = [1, 2, 3, 4].map(g => F.review(c, g, { now: NOW }));
  t('every grade produces a schedule', grades.every(x => x.stability > 0 && x.difficulty >= 1));
  t('stability rises with the grade',
    grades[0].stability < grades[1].stability &&
    grades[1].stability < grades[2].stability &&
    grades[2].stability < grades[3].stability,
    grades.map(g => +g.stability.toFixed(2)));
  t('difficulty falls as the grade rises', grades[0].difficulty > grades[3].difficulty,
    grades.map(g => +g.difficulty.toFixed(2)));
  t('Again keeps it in learning', grades[0].state === 'learning');
  t('Good moves it to review', grades[2].state === 'review');
  t('Again is due immediately (same session)', grades[0].due <= NOW);
  t('Easy is pushed furthest out', grades[3].due > grades[2].due);
  t('reps increments', grades[2].reps === 1);
  t('no lapse on a first-time Again', grades[0].lapses === 0);
  t('difficulty stays in 1..10', grades.every(g => g.difficulty >= 1 && g.difficulty <= 10));
}

// ── Purity ────────────────────────────────────────────────────────────────
console.log('\npurity');
{
  const c = F.newCard(NOW);
  const snapshot = JSON.stringify(c);
  F.review(c, 3, { now: NOW });
  F.preview(c, { now: NOW });
  t('review() does not mutate its input', JSON.stringify(c) === snapshot);
  t('preview() does not mutate its input', JSON.stringify(c) === snapshot);
  const p = F.preview(c, { now: NOW });
  t('preview reports all four grades',
    ['again', 'hard', 'good', 'easy'].every(k => typeof p[k].days === 'number'));
  t('preview matches what review would do',
    p.good.days === F.review(c, 3, { now: NOW }).lastInterval);
}

// ── Grades move intervals the right way, at every maturity ────────────────
console.log('\ngrade ordering holds as a card matures');
{
  let card = F.newCard(NOW);
  let now = NOW;
  let bad = [];
  for (let step = 0; step < 12; step++) {
    card = F.review(card, 3, { now });                 // answer Good repeatedly
    now = card.due;
    const p = F.preview(card, { now });
    if (!(p.again.days <= p.hard.days && p.hard.days <= p.good.days && p.good.days <= p.easy.days)) {
      bad.push({ step, ...p });
    }
  }
  t('Again <= Hard <= Good <= Easy at every step', bad.length === 0, bad.slice(0, 2));
  t('a well-known card reaches a long interval', card.lastInterval > 30, card.lastInterval);
  t('stability grew monotonically under Good', card.stability > 10, +card.stability.toFixed(1));
}

// ── Lapses ────────────────────────────────────────────────────────────────
console.log('\nlapses');
{
  let card = F.newCard(NOW);
  let now = NOW;
  for (let i = 0; i < 6; i++) { card = F.review(card, 3, { now }); now = card.due; }
  const before = { s: card.stability, d: card.difficulty, lapses: card.lapses };
  const after = F.review(card, 1, { now });
  t('stability collapses on a lapse', after.stability < before.s, { before: before.s, after: after.stability });
  t('difficulty rises on a lapse', after.difficulty > before.d);
  t('lapse counter increments', after.lapses === before.lapses + 1);
  t('enters relearning', after.state === 'relearning');
  t('comes back this session', after.due <= now);
  t('stability stays positive', after.stability > 0);

  // Recovery: a lapsed card must be able to become easy again, or one bad day
  // marks it hard forever.
  let rec = after, n2 = now;
  for (let i = 0; i < 8; i++) { rec = F.review(rec, 4, { now: n2 }); n2 = rec.due; }
  t('a lapsed card can recover', rec.difficulty < after.difficulty, {
    afterLapse: +after.difficulty.toFixed(2), recovered: +rec.difficulty.toFixed(2) });
}

// ── Exam-aware compression (the R-2 feature) ──────────────────────────────
console.log('\nexam-aware compression');
{
  let card = F.newCard(NOW);
  let now = NOW;
  for (let i = 0; i < 8; i++) { card = F.review(card, 4, { now }); now = card.due; }
  const uncompressed = F.review(card, 3, { now }).lastInterval;
  t('the card is long-interval to begin with', uncompressed > 20, uncompressed);

  const exam = now + 10 * DAY;
  const out = F.review(card, 3, { now, dueBefore: exam });
  t('compressed to fit before the exam', out.lastInterval < uncompressed, out.lastInterval);
  t('due strictly before the exam', out.due < exam, { due: out.due, exam });
  t('leaves at least a day of margin', exam - out.due >= DAY);

  // A short interval must NOT be stretched just because an exam is far away.
  const near = F.newCard(NOW);
  const short = F.review(near, 1, { now: NOW });
  const shortExam = F.review(near, 1, { now: NOW, dueBefore: NOW + 60 * DAY });
  t('a distant exam does not stretch a short interval',
    short.lastInterval === shortExam.lastInterval);

  // An exam tomorrow cannot produce a negative or zero-day schedule.
  const tight = F.review(card, 3, { now, dueBefore: now + 1.5 * DAY });
  t('an imminent exam never yields a negative interval', tight.lastInterval >= 0, tight.lastInterval);
  t('an exam in the past is ignored rather than breaking',
    F.review(card, 3, { now, dueBefore: now - 5 * DAY }).lastInterval > 0);
}

// ── Due filtering and study order ─────────────────────────────────────────
console.log('\ndue + ordering');
{
  t('a card with no schedule is due', F.isDue(null, NOW));
  t('a new card is due now', F.isDue(F.newCard(NOW), NOW));
  const c = F.review(F.newCard(NOW), 4, { now: NOW });
  t('a scheduled card is not due yet', !F.isDue(c, NOW));
  t('and is due once the time arrives', F.isDue(c, c.due));

  // Weakest first: the cards most likely to be forgotten are worth the minutes.
  const strong = { id: 'strong', sched: F.review(F.newCard(NOW), 4, { now: NOW }) };
  let weakSched = F.newCard(NOW);
  weakSched = F.review(weakSched, 1, { now: NOW });
  const weak = { id: 'weak', sched: weakSched };
  const fresh = { id: 'fresh', sched: F.newCard(NOW) };
  const order = F.sortForStudy([strong, fresh, weak], NOW + 2 * DAY).map(x => x.id);
  t('weakest sorts before strongest', order.indexOf('weak') < order.indexOf('strong'), order);
  t('new cards are not front-loaded', order[0] !== 'fresh', order);
  t('sortForStudy handles an empty set', F.sortForStudy([], NOW).length === 0);
  t('sortForStudy tolerates junk', F.sortForStudy([{ id: 'x' }], NOW).length === 1);
}

// ── Robustness ────────────────────────────────────────────────────────────
console.log('\nrobustness');
{
  t('a null card still schedules', F.review(null, 3, { now: NOW }).stability > 0);
  t('grade 0 clamps to Again', F.review(F.newCard(NOW), 0, { now: NOW }).state === 'learning');
  t('grade 9 clamps to Easy',
    F.review(F.newCard(NOW), 9, { now: NOW }).stability === F.review(F.newCard(NOW), 4, { now: NOW }).stability);
  t('a fractional grade rounds', F.review(F.newCard(NOW), 2.6, { now: NOW }).stability > 0);

  // Long-horizon sanity: 50 Goods must not overflow, go negative, or NaN.
  let c = F.newCard(NOW), n = NOW, ok = true;
  for (let i = 0; i < 50; i++) {
    c = F.review(c, 3, { now: n });
    n = c.due;
    if (!Number.isFinite(c.stability) || !Number.isFinite(c.due) || c.stability <= 0) { ok = false; break; }
  }
  t('50 consecutive reviews stay finite and positive', ok, { s: c.stability, d: c.difficulty });
  t('difficulty never escapes 1..10 over a long run', c.difficulty >= 1 && c.difficulty <= 10);
}

console.log('\ninterval ceiling');
{
  // Uncapped FSRS reaches 2,409 days after eight Goods and ~47,900 after six
  // Easys. Mathematically right, useless for a semester — and a card that
  // vanishes for a decade is indistinguishable from a lost one.
  let c = F.newCard(NOW), now = NOW, maxSeen = 0;
  for (let i = 0; i < 15; i++) {
    c = F.review(c, 4, { now });
    maxSeen = Math.max(maxSeen, c.lastInterval);
    now = c.due;
  }
  t('never schedules past the ceiling', maxSeen <= F.MAX_INTERVAL_DAYS, maxSeen);
  t('but still reaches a long interval', maxSeen >= 300, maxSeen);
  t('the ceiling is about a year', F.MAX_INTERVAL_DAYS === 365);
  t('short intervals are untouched by the cap',
    F.review(F.newCard(NOW), 3, { now: NOW }).lastInterval < 30);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
