// Tests for the D2L import's pure logic: the ICS parser and the course/type
// heuristics in workers/studyos-d2l/src/.
//
// Unlike test-apps.mjs, this needs no source extraction — ics.js and
// classify.js are real ESM modules with no Workers-runtime dependency, which
// is precisely why they were kept free of fetch/crypto/env. That makes the
// riskiest part of the integration testable without deploying anything.
//
// Every case here is a bug that would otherwise reach production silently:
// a mangled course name, a phantom 1970 event, or — worst — an expired token
// returning an HTML login page that parses to zero events and looks exactly
// like "the semester ended".
//
// Run with:  npm run test:d2l
import { parseICS, unfold, unescapeText, parseLine, parseDateValue }
  from "../workers/studyos-d2l/src/ics.js";
import { classifyType, extractCourses, normalizeKey }
  from "../workers/studyos-d2l/src/classify.js";

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(["ok", name]); }
  catch (e) { fail++; results.push(["FAIL", `${name} — ${e.message}`]); }
}
const eq = (got, want, msg) => {
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(`${msg || ""} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const truthy = (v, msg) => { if (!v) throw new Error(msg || "expected a truthy value"); };

// Wrap VEVENT bodies in a minimal VCALENDAR.
const cal = (...bodies) =>
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" +
  bodies.map(b => "BEGIN:VEVENT\r\n" + b + "\r\nEND:VEVENT\r\n").join("") +
  "END:VCALENDAR\r\n";
const ev = (over = {}) => {
  const o = { UID: "u1@d2l", SUMMARY: "Thing", DTSTART: "20260114T093000", ...over };
  return Object.keys(o).map(k => `${k}:${o[k]}`).join("\r\n");
};

// ── 1-2. Line folding ───────────────────────────────────────────────────────
// Brightspace folds at 75 octets. A fold landing mid-course-code is the most
// likely cause of a garbled import, and the bare-\n variant shows up whenever
// a proxy normalizes line endings in transit.
t("1. unfolds CRLF + space", () => {
  const r = parseICS(cal(ev({ SUMMARY: "MATH 2202 - Introduction to Diff\r\n erential Equations" })));
  eq(r.events[0].summary, "MATH 2202 - Introduction to Differential Equations");
});

t("2. unfolds bare LF + space (proxy-normalized)", () => {
  const src = cal(ev({ SUMMARY: "CS 3510 - Algorithms" })).replace(/\r\n/g, "\n")
    .replace("Algorithms", "Algo\n rithms");
  const r = parseICS(src);
  eq(r.events[0].summary, "CS 3510 - Algorithms");
});

t("2b. unfolds CRLF + TAB", () => {
  const r = parseICS(cal(ev({ SUMMARY: "Long title\r\n\tcontinued" })));
  eq(r.events[0].summary, "Long titlecontinued");
});

// ── 3-6. The three DTSTART shapes ───────────────────────────────────────────
t("3. VALUE=DATE is all-day", () => {
  const r = parseICS(cal("UID:u\r\nSUMMARY:Essay due\r\nDTSTART;VALUE=DATE:20260114"));
  const s = r.events[0].start;
  eq([s.date, s.time, s.allDay], ["2026-01-14", "", true]);
});

t("4. UTC is flagged, NOT converted server-side", () => {
  const r = parseICS(cal(ev({ DTSTART: "20260114T143000Z" })));
  const s = r.events[0].start;
  eq([s.date, s.time, s.isUtc, s.allDay], ["2026-01-14", "14:30", true, false]);
  eq(s.dtRaw, "20260114T143000Z", "raw value must survive for client-side tz work");
});

t("5. TZID keeps wall-clock time unchanged", () => {
  const r = parseICS(cal("UID:u\r\nSUMMARY:Lecture\r\nDTSTART;TZID=America/New_York:20260114T093000"));
  const s = r.events[0].start;
  eq([s.date, s.time, s.tzid, s.isUtc], ["2026-01-14", "09:30", "America/New_York", false]);
});

t("6. quoted TZID param is unquoted", () => {
  const r = parseICS(cal('UID:u\r\nSUMMARY:Lecture\r\nDTSTART;TZID="America/New_York":20260114T093000'));
  eq(r.events[0].start.tzid, "America/New_York");
});

// ── 7. Colon handling ───────────────────────────────────────────────────────
// URL:https://... is a real property in D2L feeds; a naive split(':') mangles it.
t("7. splits on the first unquoted colon only", () => {
  const r = parseICS(cal(ev({ URL: "https://x.brightspace.com/d2l/le/1:2" })));
  eq(r.events[0].url, "https://x.brightspace.com/d2l/le/1:2");
});

t("7b. parseLine handles a quoted colon inside a param", () => {
  const p = parseLine('DTSTART;TZID="Weird:Zone":20260114T093000');
  eq([p.name, p.params.TZID, p.value], ["DTSTART", "Weird:Zone", "20260114T093000"]);
});

// ── 8-9. TEXT escaping ──────────────────────────────────────────────────────
t("8. unescapes commas, semicolons and newlines", () => {
  eq(unescapeText("Read Ch. 3\\, 4 \\; done\\nNext line"), "Read Ch. 3, 4 ; done\nNext line");
});

t("9. backslash is unescaped LAST (the ordering bug)", () => {
  // "C:\\path\\to" in ICS source is a literal C:\path\to — the "\\t" must NOT
  // become a tab, and "\\n" must NOT become a newline.
  eq(unescapeText("C:\\\\path\\\\to"), "C:\\path\\to");
  eq(unescapeText("A\\\\nB"), "A\\nB", "escaped backslash then literal n");
});

// ── 10-12. Component nesting ────────────────────────────────────────────────
// VTIMEZONE sub-components carry their own DTSTART, dated 1970. A flat scan
// for BEGIN:VEVENT invents phantom epoch events.
t("10. VTIMEZONE with its own DTSTART yields 0 phantom events", () => {
  const src = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VTIMEZONE", "TZID:America/New_York",
    "BEGIN:DAYLIGHT", "DTSTART:19700308T020000", "TZNAME:EDT", "END:DAYLIGHT",
    "BEGIN:STANDARD", "DTSTART:19701101T020000", "TZNAME:EST", "END:STANDARD",
    "END:VTIMEZONE", "END:VCALENDAR",
  ].join("\r\n");
  eq(parseICS(src).events.length, 0);
});

t("10b. a real VEVENT still parses alongside a VTIMEZONE", () => {
  const src = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTIMEZONE", "TZID:X", "BEGIN:STANDARD", "DTSTART:19701101T020000", "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT", "UID:real@d2l", "SUMMARY:Exam 1", "DTSTART:20260114T093000", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const r = parseICS(src);
  eq(r.events.length, 1);
  eq(r.events[0].uid, "real@d2l");
});

t("11. VTODO components are ignored", () => {
  const src = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO", "UID:todo@d2l", "SUMMARY:A task", "DTSTART:20260114T093000", "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n");
  eq(parseICS(src).events.length, 0);
});

t("12. a VEVENT with no UID is dropped, not crashed on", () => {
  const r = parseICS(cal("SUMMARY:No identity\r\nDTSTART:20260114T093000"));
  eq(r.events.length, 0, "no UID means no stable reconcile key");
});

// ── 13. RRULE captured but not expanded ─────────────────────────────────────
t("13. RRULE is retained verbatim and yields exactly one item", () => {
  const r = parseICS(cal(ev({ SUMMARY: "Lecture", RRULE: "FREQ=WEEKLY;COUNT=14;BYDAY=MO,WE" })));
  eq(r.events.length, 1, "recurrence is deliberately not expanded");
  eq(r.events[0].rrule, "FREQ=WEEKLY;COUNT=14;BYDAY=MO,WE");
});

// ── 14-16. Course + type heuristics ─────────────────────────────────────────
t("14. a repeating dash prefix is a course; a one-off dash is not", () => {
  const evs = [
    { uid: "a", summary: "MATH 2202 - Exam 1" },
    { uid: "b", summary: "MATH 2202 - Quiz 2" },
    { uid: "c", summary: "MATH 2202 - Lecture 3" },
    { uid: "d", summary: "Read Ch. 3 - 5" },
  ];
  const { courses, assign } = extractCourses(evs);
  const keys = courses.map(c => c.key);
  truthy(keys.includes("MATH2202"), "MATH 2202 should be detected");
  truthy(!keys.includes("READCH3"), "an incidental dash must not mint a course");
  eq(assign.get("d"), "(unassigned)", "the stray-dash event falls through to unassigned");
});

t("14b. trailing parenthetical is rule 2", () => {
  const { courses, assign } = extractCourses([{ uid: "a", summary: "Exam 1 (CS 3510)" }]);
  eq(assign.get("a"), "CS3510");
  eq(courses[0].rule, 2);
});

t("14c. a Course: line in DESCRIPTION is rule 3", () => {
  const { courses, assign } = extractCourses([
    { uid: "a", summary: "Exam 1", description: "Course: PHYS 2211\r\nBring a calculator" },
  ]);
  eq(assign.get("a"), "PHYS2211");
  eq([courses[0].rule, courses[0].confidence], [3, "high"]);
});

t("15. the course name never drives the type", () => {
  // Classifying the raw title would call this a quiz; stripping the course
  // prefix first correctly makes it a lecture.
  eq(classifyType("Quiz Section - Lecture 4", "Quiz Section"), "lecture");
  eq(classifyType("LAB 101 - Final Exam", "LAB 101"), "exam");
});

t("16. type keywords map to the six legal values", () => {
  eq(classifyType("Final Exam"), "exam");
  eq(classifyType("Midterm 2"), "exam");
  eq(classifyType("Pop Quiz"), "quiz");
  eq(classifyType("Problem Set 3"), "hw");
  eq(classifyType("Essay 1 due"), "hw");
  eq(classifyType("Lab 4"), "lab");
  eq(classifyType("Lecture 12"), "lecture");
  eq(classifyType("Office hours"), "other");
});

t("16b. exam outranks quiz when both words appear", () => {
  eq(classifyType("Final Exam Review Quiz"), "exam");
});

// ── 17-18. The dangerous inputs ─────────────────────────────────────────────
t("17. an empty feed parses clean (the CALLER must refuse it)", () => {
  const r = parseICS("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n");
  eq(r.events.length, 0);
});

t("18. an HTML login page yields 0 events and does not throw", () => {
  // This is the sharpest edge in the whole feature: an expired Brightspace
  // token returns a login page, not an error. It parses to zero events, which
  // reconciles to "D2L deleted everything" unless the caller's zero-guard
  // catches it. The parser's only job here is to not explode.
  const html = "<!DOCTYPE html>\n<html><head><title>Login</title></head>\n" +
               "<body><form action=\"/d2l/login\">user:pass</form></body></html>";
  const r = parseICS(html);
  eq(r.events.length, 0);
});

t("18b. garbage input does not throw", () => {
  [null, undefined, "", "\x00\x01", "BEGIN:VEVENT"].forEach((junk) => {
    parseICS(junk);
  });
  eq(unfold(null), "");
});

// ── misc ────────────────────────────────────────────────────────────────────
t("normalizeKey collapses spacing and punctuation", () => {
  eq(normalizeKey("MATH 2202"), "MATH2202");
  eq(normalizeKey("math-2202"), "MATH2202");
  eq(normalizeKey("Math2202"), "MATH2202");
});

t("parseDateValue rejects a malformed date", () => {
  eq(parseDateValue("not-a-date", {}), null);
});

t("X-WR-CALNAME is captured", () => {
  const src = "BEGIN:VCALENDAR\r\nX-WR-CALNAME:My Courses\r\nEND:VCALENDAR\r\n";
  eq(parseICS(src).calName, "My Courses");
});

// ── report ──────────────────────────────────────────────────────────────────
results.forEach(([s, n]) => console.log(`${s === "ok" ? "  ok  " : "  FAIL"}  ${n}`));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
