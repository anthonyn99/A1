/* ═══════════════════════════════════════════════════════════════════════════
 * classify.js — turn raw VEVENTs into { courseKey, type } guesses.
 * ---------------------------------------------------------------------------
 * PURE, like ics.js, and for the same reason: this is the part most likely to
 * be wrong on a given Brightspace tenant, so it has to be cheap to test and
 * cheap to re-tune against a real feed.
 *
 * THE CENTRAL FACT: there is no specification for what a Brightspace calendar
 * feed puts in SUMMARY. It is generated from the tenant's own configuration.
 * "MATH 2202 - Exam 1", "Exam 1 (MATH 2202)" and a bare "Exam 1" are all
 * plausible, and which one you get is not knowable from outside.
 *
 * So this file is built to be WRONG SAFELY. Every guess carries the rule that
 * produced it and a confidence flag; the UI shows low-confidence rows
 * pre-flagged, defaults unrecognized courses to "skip", and lets the user
 * remap anything. A bad guess costs two clicks, never data.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* The only six values studyos.js will render. EVENT_COLORS (js/studyos.js:97)
 * is keyed on exactly these; anything else renders colorless. */
export const EVENT_TYPES = ['exam', 'quiz', 'hw', 'lecture', 'lab', 'other'];

/* Ordered — first match wins. The order encodes precedence between words that
 * legitimately co-occur: "Final Exam Review Quiz" is an exam, because the
 * high-stakes word is the one worth surfacing on the countdown. */
const TYPE_RULES = [
  ['exam',    /\b(final|finals|midterm|exam)\b/i],
  ['quiz',    /\b(quiz|quizzes)\b/i],
  ['hw',      /\b(hw|homework|assignment|due|submit|problem\s*set|pset|essay|paper|project|report|discussion\s*post|dropbox)\b/i],
  ['lab',     /\b(lab|laboratory)\b/i],
  ['lecture', /\b(lecture|class|seminar|recitation|discussion|session|meeting)\b/i],
];

/* Strip a known course prefix/suffix before type-matching.
 *
 * This is load-bearing, not cosmetic: a course literally named "Quiz Section"
 * or a code like "LAB 101" would otherwise type every one of its events by the
 * course name rather than the event name. Classify the event, not the course. */
function stripCourse(title, courseLabel) {
  let t = String(title || '');
  if (!courseLabel) return t.trim();
  const esc = String(courseLabel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  t = t.replace(new RegExp('^\\s*' + esc + '\\s*[-–—:]*\\s*', 'i'), '');
  t = t.replace(new RegExp('\\s*[\\(\\[]\\s*' + esc + '\\s*[\\)\\]]\\s*$', 'i'), '');
  return t.trim();
}

export function classifyType(title, courseLabel) {
  const t = stripCourse(title, courseLabel);
  for (const rule of TYPE_RULES) {
    if (rule[1].test(t)) return rule[0];
  }
  return 'other';
}

/* Normalize a course key for comparison: "MATH 2202" / "math-2202" / "Math2202"
 * all collapse to MATH2202. Used both to dedupe courses within a feed and, on
 * the client, to pre-match a detected course against an existing StudyOS class. */
export function normalizeKey(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const DASH = /^(.+?)\s*[-–—]\s*(.+)$/;
const TRAILING_PAREN = /^(.*?)[\(\[]\s*([^)\]]+?)\s*[\)\]]\s*$/;
const DESC_COURSE = /^\s*(?:course|class)\s*:\s*(.+)$/im;

/* Extract courses across the WHOLE feed, not per event.
 *
 * The cross-event view is what makes rule 1 safe. "MATH 2202 - Exam 1" and
 * "Read Ch. 3 - 5" are indistinguishable in isolation — both are
 * "<something> - <something>". But a real course prefix repeats across many
 * events, and an incidental dash does not. Requiring >= 2 occurrences turns an
 * unreliable regex into a reliable one.
 *
 * Returns { courses: [{key,label,count,confidence,rule}], assign: Map<uid, key> }. */
export function extractCourses(events) {
  const list = Array.isArray(events) ? events : [];

  // Pass 1 — tally every candidate prefix so rule 1 can check for repetition.
  const dashCount = new Map();
  list.forEach((e) => {
    const m = DASH.exec(String(e.summary || '').trim());
    if (!m) return;
    const k = normalizeKey(m[1]);
    if (!k) return;
    dashCount.set(k, (dashCount.get(k) || 0) + 1);
  });

  // Pass 2 — assign each event, first matching rule wins.
  const courses = new Map();
  const assign = new Map();

  const note = (key, label, rule, confidence) => {
    const k = key || '(unassigned)';
    if (!courses.has(k)) {
      courses.set(k, { key: k, label: label || k, count: 0, rule: rule, confidence: confidence });
    }
    const c = courses.get(k);
    c.count++;
    // A course seen many times is more trustworthy than a one-off, whatever
    // rule found it.
    if (c.count >= 3 && c.confidence === 'low') c.confidence = 'high';
    return k;
  };

  list.forEach((e) => {
    const summary = String(e.summary || '').trim();
    const desc = String(e.description || '');
    let key = null, label = null, rule = 0, confidence = 'low';

    // Rule 1 — "COURSE - Event", where COURSE repeats across >= 2 events.
    const dm = DASH.exec(summary);
    if (dm) {
      const cand = normalizeKey(dm[1]);
      if (cand && (dashCount.get(cand) || 0) >= 2) {
        key = cand; label = dm[1].trim(); rule = 1; confidence = 'high';
      }
    }

    // Rule 2 — "Event (COURSE)" trailing parenthetical.
    if (!key) {
      const pm = TRAILING_PAREN.exec(summary);
      if (pm && pm[2] && pm[2].length <= 60) {
        key = normalizeKey(pm[2]); label = pm[2].trim(); rule = 2; confidence = 'low';
      }
    }

    // Rule 3 — an explicit "Course:" line in the DESCRIPTION.
    if (!key) {
      const cm = DESC_COURSE.exec(desc);
      if (cm && cm[1]) {
        label = cm[1].trim().split(/\r|\n/)[0].trim();
        key = normalizeKey(label); rule = 3; confidence = 'high';
      }
    }

    // Rule 4 — CATEGORIES, or any X- property naming an org unit. Some tenants
    // put the course here and nowhere else.
    if (!key) {
      if (e.categories && e.categories.length) {
        label = String(e.categories[0]).trim();
        key = normalizeKey(label); rule = 4; confidence = 'low';
      } else if (e.xprops) {
        const xk = Object.keys(e.xprops).find(k => /ORGUNIT|COURSE|D2L/i.test(k));
        if (xk && e.xprops[xk]) {
          label = String(e.xprops[xk]).trim();
          key = normalizeKey(label); rule = 4; confidence = 'low';
        }
      }
    }

    // Rule 5 — give up. These land in one "(unassigned)" bucket the user can
    // map by hand or skip wholesale.
    if (!key) { key = '(unassigned)'; label = '(unassigned)'; rule = 5; confidence = 'low'; }

    assign.set(e.uid, note(key, label, rule, confidence));
  });

  return {
    courses: Array.from(courses.values()).sort((a, b) => b.count - a.count),
    assign: assign,
  };
}
