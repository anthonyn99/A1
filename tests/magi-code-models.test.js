// Guards the console halves of Phase 11 (the Repository panel and the
// Actions watch) and Phase 11B (models, Auto, usage, caps, the popup).
//
// What this pins, and why each matters:
//   1. The panel only READS: every request it makes is a GET, fetched when a
//      tab opens, and an answer for a tab you already left is dropped.
//   2. The watch is the only thing that repeats, and only while a run is
//      pending (or has not appeared yet), with a hard stop.
//   3. Model choice, effort, caps and the warning line go to the ENGINE --
//      never localStorage, never Firestore -- so the phone and the desk agree
//      and each profile's engine keeps its own.
//   4. The Auto preview is debounced and drops stale answers.
//   5. The usage popup shows each alert once per reset, never as a modal,
//      and the stops (cap, limit) stay until dismissed.
//   6. No native dialogs; phone-sized targets.
//
// Behaviour is proved in magi/tests/test_code_models.py and
// test_github_repo.py, and in the browser by tests/live/magi-models.live.js
// and magi-repo.live.js; this is the static half.
//
// Run: node tests/magi-code-models.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const MAGI = fs.readFileSync(path.join(__dirname, '..', 'magi.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
function fn(name) {
  const i = MAGI.indexOf(name);
  if (i < 0) return '';
  const rest = MAGI.slice(i + name.length);
  const j = rest.search(/\n(async )?function |\n\/\* ──|\nconst [A-Z_]+ = /);
  return MAGI.slice(i, i + name.length + (j < 0 ? 4000 : j));
}
const NATIVE = /\b(window\.)?(alert|confirm|prompt)\s*\(/;

console.log('\nThe Repository panel');
const panel = fn('async function codeRepoPanel(proj');
ok('it exists and opens on a tab', panel.length > 1000 && /REPO_TABS/.test(panel));
ok('every read is a GET through codeGet', /codeGet\(repoPath\(proj, path\)\)/.test(panel) && !/codePost\(/.test(panel));
ok('answers are cached per open panel', /if \(key && d\.ok\) cache\[key\] = d;/.test(panel));
ok('a stale answer is dropped, not drawn', /if \(mine !== seq \|\| !sheet\.isConnected\) throw STALE;/.test(panel)
   && /if \(e !== STALE\)/.test(panel));
ok('no timer in the panel', !/setInterval|setTimeout\(/.test(panel));
ok('Esc and ✕ close it', /e\.key === "Escape"/.test(panel) && /x\.onclick = close/.test(panel));
ok('rows are buttons or links, never bare divs with handlers', /el\(onclick \? "button" : "div", "repo-row"\)/.test(panel));
ok('external links open safely', /rel = "noopener"/.test(fn('function repoLink(')));

console.log('\nThe Actions watch');
const tick = fn('async function codeWatchTick()');
const start = fn('function codeWatchStart(');
ok('it follows one full commit SHA', /if \(!sha \|\| sha\.length < 40\) return;/.test(start));
ok('only one watch at a time', /codeWatchStop\(\);/.test(start));
ok('it repeats only while pending, or briefly while no run exists',
   /const going = w\.state === "pending" \|\| \(w\.state === "none" && age < WATCH_NONE_MS\);/.test(tick));
ok('with a hard stop', /if \(going && age < WATCH_MAX_MS\) w\.timer = setTimeout\(codeWatchTick, WATCH_EVERY_MS\);/.test(tick));
ok('a hidden tab skips the read', /if \(!document\.hidden && online\(\)\)/.test(tick));
ok('the failing log is fetched once', /if \(w\.state === "failure" && !w\.fail\)/.test(tick));
ok('a push starts it (line and card)', /codeWatchStart\(proj, d\.push\.sha/.test(fn('async function codePushProject(proj)'))
   && /codeWatchStart\(proj, d\.push\.sha, \{ taskId: t\.id/.test(fn('async function codePushTask(t)')));
const dx = fn('async function codeDiagnose(');
ok('Diagnose is a READ task', /mode: "read"/.test(dx) && !/mode: "write"/.test(dx));
ok('and not while another task runs', /if \(codeBusy\(\)\) return;/.test(dx));

console.log('\nModels, effort, caps: stored on the engine');
const sheetM = fn('async function codeModelSheet(agent)');
ok('choices go to the engine', /save\("\/models\/choice"/.test(sheetM));
ok('caps go to the engine', /save\("\/models\/cap", \{ agent, window: w\.id, percent: pc \}\)/.test(sheetM));
ok('the warning line goes to the engine', /save\("\/models\/warn"/.test(sheetM));
ok('none of it touches localStorage', !/localStorage/.test(sheetM));
ok('none of it touches Firestore', !/cloudSave|setDoc|updateDoc|firestore/i.test(sheetM + fn('function renderCodeModels()')));
ok('a model that cannot run is disabled, with its reason', /b\.disabled = !ok;/.test(sheetM) && /model-opt-why/.test(sheetM));
ok('efforts the model does not support are disabled', /b\.disabled = e !== "auto" && !allowed\.has\(e\);/.test(sheetM));
ok('Off is a cap choice', /for \(const pc of \[null, \.\.\.presets\]\)/.test(sheetM));
ok('a capped agent is said first', /if \(slot\.capped\) body\.append\(el\("div", "sheet-err model-capped"/.test(sheetM));
ok('Re-check asks the provider again', /codeModelsLoad\(true\)/.test(sheetM));
ok('Accounts links to the same sheet', /codeModelSheet\(c\.agent\)/.test(fn('function renderCodeAccounts()')));

console.log('\nAuto preview');
const soon = fn('function codePreviewSoon()');
const pv = fn('async function codePreview()');
ok('debounced', /clearTimeout\(_previewTimer\);/.test(soon) && /setTimeout\(codePreview, 350\)/.test(soon));
ok('stale answers dropped', /if \(mine !== _previewSeq \|\| !d\.ok\) return;/.test(pv));
ok('the composer drives it', /if \(typeof codePreviewSoon === "function"\) codePreviewSoon\(\);/.test(MAGI));
ok('it redraws the row only, not the whole view', /codeModelsRedraw\(\);/.test(pv) && !/renderCodeView\(\)/.test(pv));

console.log('\nThe popup');
const alerts = fn('function codeUsageAlerts(alerts)');
const toast = fn('function usageToast(a)');
ok('once per alert key', /!seen\.has\(a\.key\)/.test(alerts) && /usageMarkSeen\(a\.key\);/.test(toast));
ok('the seen list is bounded', /seen\.slice\(-60\)/.test(fn('function usageMarkSeen(key)')));
ok('the most serious first, one at a time', /fresh\.sort/.test(alerts) && /usageToast\(fresh\[0\]\);/.test(alerts));
ok('it is a status, not a dialog', /setAttribute\("role", "status"\)/.test(toast) && /aria-live/.test(toast));
ok('warnings fade; stops stay', /if \(a\.level === "warn" \|\| a\.level === "near_cap"\) setTimeout/.test(toast));
ok('it links to the sheet', /codeModelSheet\(a\.agent\)/.test(toast));
ok('the usage poll feeds it', /codeUsageAlerts\(d\.alerts\);/.test(fn('async function codeUsageRefresh()')));

console.log('\nThe chips and the transcript');
ok('a capped account is not free', /const heldUntil = \(s\) => Math\.max\(s\.limited_until \|\| 0, \(s\.capped && s\.capped\.until\) \|\| 0\);/.test(MAGI));
ok('the transcript names the model and why', /ev\.k === "model"/.test(MAGI) && /Auto: \$\{ev\.why\}/.test(MAGI));
ok('a cap hand-off says it was your cap', /\/\^Stopped at your\/\.test\(ev\.detail/.test(MAGI));

console.log('\nNo native dialogs');
ok('none in the panel, the watch, the sheet or the popup',
   !NATIVE.test(panel + tick + start + dx + sheetM + alerts + toast + fn('function renderCodeWatch(proj)')));

console.log('\nPhone');
ok('the panel is a bottom sheet on a phone', /\.sheet\.repo-sheet \{ padding: 5vh 0 0; align-items: flex-end; \}/.test(MAGI));
ok('rows and model options are 44px targets', /\.repo-row \{[^}]*min-height: 44px/.test(MAGI) && /\.model-opt \{[^}]*min-height: 44px/.test(MAGI));
ok('the model row goes full width', /\.code-model \{ flex: 1 1 100%; \}/.test(MAGI));
ok('the popup spans the phone above the home indicator', /\.usage-toasts \{ right: 12px; left: 12px; width: auto; bottom: max\(12px, env\(safe-area-inset-bottom\)\); \}/.test(MAGI));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
