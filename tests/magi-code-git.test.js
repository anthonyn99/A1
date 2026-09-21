// Guards Code Mode's git half in the console (Phase 9).
//
// What this pins, and why each matters:
//   1. The repository line is read on demand, never on a timer. It is a git
//      call on the engine; a screen left open on a phone must cost nothing.
//   2. Every task's pull is shown, and a failed pull says the task stopped
//      before any agent started -- otherwise a stopped task looks like an
//      agent that gave up.
//   3. Commit is a second, separate press after Approve, sends only the
//      message (the engine decides the files: exactly the applied ones), and
//      never goes through a native dialog.
//   4. A commit message being typed survives the once-a-minute redraw.
//
// The behaviour is proved against real repositories in
// magi/tests/test_code_git.py and test_code_write.py, and in the browser by
// tests/live/magi-git.live.js; this is the static half.
//
// Run: node tests/magi-code-git.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const MAGI = fs.readFileSync(path.join(__dirname, '..', 'magi.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
function lift(name, n = 4000) {
  const i = MAGI.indexOf(name);
  return i < 0 ? '' : MAGI.slice(i, i + n);
}
function fn(name) {
  // The body of a top-level function: up to the next line that starts a new one.
  const i = MAGI.indexOf(name);
  if (i < 0) return '';
  const rest = MAGI.slice(i + name.length);
  const j = rest.search(/\n(async )?function |\n\/\* ──|\nconst [A-Z_]+ = /);
  return MAGI.slice(i, i + name.length + (j < 0 ? 4000 : j));
}

console.log('The repository line');
const load = fn('async function codeGitLoad(pid)');
ok('it reads /projects/{id}/git', /codeGet\(`\/projects\/\$\{encodeURIComponent\(pid\)\}\/git`\)/.test(load));
ok('a late answer for another workspace is dropped', /CODE\.git\.pid !== pid\) return;/.test(load));
const timers = (MAGI.match(/set(Interval|Timeout)\([\s\S]{0,400}?\}, [\w.]+\)/g) || []).join('\n');
ok('never on a timer', !/codeGitLoad|codeGitEnsure/.test(timers) && !/codeGit/.test(fn('function codeUsagePoll(on)')));
ok('re-read on entering Code Mode', /if \(m === "code" && CODE\.git\) CODE\.git\.stale = true;/.test(fn('function setMode(')));
ok('re-read when a task ends', /if \(tp\) codeGitLoad\(tp\.id\);/.test(fn('function codeAttach(')));
ok('re-read after a commit', /codeGitLoad\(t\.projectId\)/.test(fn('async function codeCommit(t)')));
const row = fn('function renderCodeGit(proj)');
ok('it shows branch, ahead/behind, uncommitted', /↑\$\{d\.ahead\}/.test(row) && /↓\$\{d\.behind\}/.test(row) && /uncommitted/.test(row));
ok('ahead/behind admit they are as of the last fetch', /as of the last fetch/.test(row) && /never fetched/.test(row));
ok('detached HEAD and a half-done merge/rebase are named', /detached at/.test(row) && /in progress/.test(row));
ok('it hangs off the workspace, not a separate panel', /col\.append\(ws\);\s*\n\s*if \(proj && codeRoot\(proj\)\) \{\s*\n\s*codeGitEnsure\(proj\);\s*\n\s*col\.append\(renderCodeGit\(proj\)\);/.test(MAGI));

console.log('\nThe pull');
const task = fn('function renderCodeTask(t)');
ok('the transcript shows it', /ev\.k === "pull"/.test(task) && /is-err/.test(task));
ok('a failed pull says no agent started', /pull_failed: "Stopped before any agent started/.test(task));

console.log('\nCommit');
const card = fn('function renderCodeApproval(t, ev)');
ok('only an applied change offers it', /\} else if \(applied\) \{[\s\S]{0,500}renderCodeCommit\(t, applied, done\)/.test(card));
const commit = fn('function renderCodeCommit(t, applied, done)');
ok('it is its own button, not part of Approve', /"Commit these files"/.test(commit));
ok('the message starts as the engine\'s draft', /t\.commitMsg = applied\.draft/.test(commit));
ok('it says exactly which files, that hooks run, that nothing is pushed',
   /exactly the ones applied/.test(commit) && /hooks run/.test(commit) && /Nothing is pushed/.test(commit));
ok('a committed change shows its sha and says not pushed', /done\.short/.test(commit) && /Not pushed\./.test(commit));
const cc = fn('async function codeCommit(t)');
ok('only the message is sent -- the engine picks the files',
   /codePost\(`\/tasks\/\$\{t\.id\}\/commit`, \{ message \}\)/.test(cc));
ok('it cannot be sent twice', /if \(t\.committing\) return;/.test(cc));
ok('an empty message is not sent', /if \(!message\) return;/.test(cc));
ok('codeCommit is only called from the commit field', (MAGI.match(/codeCommit\(t\)/g) || []).length === 3);
ok('no native dialog in the git path', !/\b(window\.)?(alert|confirm|prompt)\s*\(/.test(commit + cc + row + load));
ok('Ctrl+Enter in the message commits and does not also Run', /e\.stopPropagation\(\);/.test(commit));

console.log('\nThe redraw');
const view = fn('function renderCodeView()');
ok('a message being typed keeps focus and caret', /code-commit-msg/.test(view) && /setSelectionRange/.test(view));

console.log('\nPhone');
ok('the commit field does not make iOS zoom',
   /@media \(max-width: 760px\)[\s\S]{0,600}\.code-commit-msg \{ font-size: 16px; \}/.test(MAGI));
ok('the repository line wraps rather than overflowing', /\.code-git \{[^}]*flex-wrap: wrap/.test(MAGI));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
