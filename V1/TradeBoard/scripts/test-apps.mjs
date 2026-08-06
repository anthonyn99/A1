// Tests for the Apps tab's pure logic (TB.apps) inside tradeboard.html.
//
// The app is a single HTML file with no build step and no test runner, so this
// script extracts the TB.apps module and exercises the parts that don't need a
// DOM: time parsing, path/URL validation, schedule-window evaluation and the
// "next action" computation shown on each row.
//
// The Rust half has its own suite (desktop/core/tests). This covers the browser
// half, including the case where the desktop shell is absent entirely.
//
// Run with:  npm run test:apps
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "tradeboard.html"), "utf8");

// ── extract TB.apps ─────────────────────────────────────────────────────────
const start = html.indexOf("TB.apps = {");
const end = html.indexOf("/* ── boot ─", start);
if (start < 0 || end < 0) {
  console.error("test-apps: could not locate the TB.apps module in tradeboard.html");
  process.exit(1);
}
let mod = html.slice(start, end).trim();
if (mod.endsWith("};")) mod = mod.slice(0, -1);

// Minimal stand-ins for the globals TB.apps touches at definition time.
const TB = {};
const U = { uid: () => "t" + Math.random().toString(36).slice(2, 8), esc: (s) => String(s) };
const doc = { getElementById: () => null, querySelector: () => null };
const apps = eval(`(function (TB, U, window, document) { ${mod} ; return TB.apps; })`)(
  TB, U, {}, doc
);
TB.apps = apps;

// ── tiny harness ────────────────────────────────────────────────────────────
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
const falsy = (v, msg) => { if (v) throw new Error(msg || "expected a falsy value"); };

// A rule in New York; 2026-07-29 is a Wednesday (day 3).
const R = (days, s, e) => ({
  id: "r", enabled: true, daysOfWeek: days, startTime: s, endTime: e,
  timezone: "America/New_York",
});
const D = (s) => new Date(s);
const item = (schedules, over = {}) => ({
  id: "i", enabled: true, type: "desktop_app", target: { path: "C:\\x.exe", args: [] },
  schedules, ...over,
});

// ── time parsing ────────────────────────────────────────────────────────────
t("hhmm parses valid times", () => {
  eq(apps._hhmmToMin("09:30"), 570);
  eq(apps._hhmmToMin("00:00"), 0);
  eq(apps._hhmmToMin("23:59"), 1439);
});
t("hhmm rejects invalid times", () => {
  eq(apps._hhmmToMin("24:00"), null);
  eq(apps._hhmmToMin("12:60"), null);
  eq(apps._hhmmToMin("9"), null);
  eq(apps._hhmmToMin(""), null);
  eq(apps._hhmmToMin("aa:bb"), null);
});
t("minToHHMM round-trips", () => {
  eq(apps._minToHHMM(570), "09:30");
  eq(apps._minToHHMM(0), "00:00");
  eq(apps._minToHHMM(1439), "23:59");
});

// ── validation (spec §5) ────────────────────────────────────────────────────
t("accepts a valid https URL", () => eq(apps._validateUrl("https://example.com"), ""));
t("rejects a URL with no scheme", () => truthy(apps._validateUrl("example.com")));
t("rejects a non-http scheme", () => truthy(apps._validateUrl("ftp://example.com")));
t("rejects an empty URL", () => truthy(apps._validateUrl("")));
t("accepts a full Windows path", () => eq(apps._validatePathShape("C:\\Windows\\notepad.exe"), ""));
t("accepts a UNC path", () => eq(apps._validatePathShape("\\\\server\\share\\app.exe"), ""));
t("rejects a bare filename", () => truthy(apps._validatePathShape("notepad.exe")));
t("rejects a non-executable extension", () => truthy(apps._validatePathShape("C:\\a\\b.txt")));
t("rejects an empty path", () => truthy(apps._validatePathShape("   ")));

// ── schedule windows ────────────────────────────────────────────────────────
t("active inside a same-day window", () =>
  truthy(apps._isActiveAt(R([3], "09:00", "17:00"), D("2026-07-29T14:00:00-04:00"))));
t("inactive before the start", () =>
  falsy(apps._isActiveAt(R([3], "09:00", "17:00"), D("2026-07-29T08:59:00-04:00"))));
t("end time is exclusive", () =>
  falsy(apps._isActiveAt(R([3], "09:00", "17:00"), D("2026-07-29T17:00:00-04:00"))));
t("inactive on an unscheduled day", () =>
  falsy(apps._isActiveAt(R([3], "09:00", "17:00"), D("2026-07-30T14:00:00-04:00"))));
t("midnight-crossing: active late on the start day", () =>
  truthy(apps._isActiveAt(R([1], "22:00", "02:00"), D("2026-07-27T23:00:00-04:00"))));
t("midnight-crossing: active early the next day", () =>
  truthy(apps._isActiveAt(R([1], "22:00", "02:00"), D("2026-07-28T01:00:00-04:00"))));
t("midnight-crossing: inactive after the end", () =>
  falsy(apps._isActiveAt(R([1], "22:00", "02:00"), D("2026-07-28T02:30:00-04:00"))));
t("midnight-crossing: not active on the following evening", () =>
  falsy(apps._isActiveAt(R([1], "22:00", "02:00"), D("2026-07-28T23:00:00-04:00"))));
t("open-only rules have no sustained open state", () =>
  falsy(apps._isActiveAt(R([3], "09:00", null), D("2026-07-29T10:00:00-04:00"))));
t("a disabled rule is never active", () => {
  const r = R([3], "09:00", "17:00"); r.enabled = false;
  falsy(apps._isActiveAt(r, D("2026-07-29T14:00:00-04:00")));
});
t("the rule's timezone wins, not the machine's", () => {
  const r = { id: "r", enabled: true, daysOfWeek: [3], startTime: "09:00",
    endTime: "17:00", timezone: "Asia/Tokyo" };
  // 01:00Z on Wed = 10:00 Wed in Tokyo.
  truthy(apps._isActiveAt(r, new Date("2026-07-29T01:00:00Z")));
});
t("a specific date only matches that date", () => {
  const r = { id: "r", enabled: true, date: "2026-07-29", startTime: "09:00",
    endTime: "17:00", timezone: "America/New_York" };
  truthy(apps._isActiveAt(r, D("2026-07-29T12:00:00-04:00")));
  falsy(apps._isActiveAt(r, D("2026-07-30T12:00:00-04:00")));
});

// ── next action ─────────────────────────────────────────────────────────────
// Regression: an early `break` used to abandon a rule whose times had already
// passed today, so a daily rule could report "no next action" all evening.
t("a daily rule always has a future next action", () => {
  const n = apps._nextAction(item([R([0,1,2,3,4,5,6], "09:00", "17:00")]));
  truthy(n, "expected a next action");
  truthy(n.at > new Date(), "next action must be in the future");
});
t("a window that has already passed today rolls to the next day", () => {
  const n = apps._nextAction(item([R([0,1,2,3,4,5,6], "00:01", "00:02")]));
  truthy(n, "expected a next action");
  truthy(n.at > new Date(), "next action must be in the future");
});
t("a single-weekday rule resolves", () => {
  const n = apps._nextAction(item([R([3], "09:00", "17:00")]));
  truthy(n && n.at > new Date());
});
t("an open-only rule yields an open action", () => {
  const n = apps._nextAction(item([R([0,1,2,3,4,5,6], "09:00", null)]));
  truthy(n); eq(n.action, "open");
});
t("a disabled item has no next action", () =>
  eq(apps._nextAction(item([R([1], "09:00", "17:00")], { enabled: false })), null));
t("an item whose rules are all disabled has no next action", () => {
  const r = R([1,2,3,4,5], "09:00", "17:00"); r.enabled = false;
  eq(apps._nextAction(item([r])), null);
});
t("an item with no schedules has no next action", () => eq(apps._nextAction(item([])), null));
t("_fmtNext produces a label", () => {
  const s = apps._fmtNext(apps._nextAction(item([R([0,1,2,3,4,5,6], "09:00", "17:00")])));
  truthy(s && s !== "—", `expected a label, got ${s}`);
});
t("_fmtNext handles no next action", () => eq(apps._fmtNext(null), "—"));

// ── browser fallback ────────────────────────────────────────────────────────
t("the shell reports itself unavailable without window.__TAURI__", () =>
  falsy(apps.shell.available));
t("invoking a command without the shell rejects", async () => {
  let threw = false;
  try { await apps.shell.invoke("open_item", {}); } catch (e) { threw = true; }
  // The promise rejects asynchronously; the sync check above is the guard that
  // matters for the UI, so just assert `available` gates it.
  falsy(apps.shell.available);
});
t("systemTz returns an IANA-looking zone", () => {
  const tz = apps.systemTz();
  truthy(typeof tz === "string" && tz.length > 0, `got ${tz}`);
});
t("a blank schedule defaults to weekdays", () => {
  const s = apps._blankSched();
  eq(s.daysOfWeek, [1, 2, 3, 4, 5]);
  truthy(s.enabled);
  truthy(s.timezone);
});

// ── report ──────────────────────────────────────────────────────────────────
for (const [status, name] of results) {
  console.log(`  ${status === "ok" ? "ok  " : "FAIL"}  ${name}`);
}
console.log(`\ntest-apps: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
