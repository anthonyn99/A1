// Guards Code Mode's GitHub half in the console (Phase 10).
//
// What this pins, and why each matters:
//   1. A token goes in through a masked field MAGI draws itself, is emptied
//      as soon as it is sent, and nothing on the page ever reads one back:
//      the engine returns only the account's public record.
//   2. Push is a third, separate press -- after Commit on the card, or from
//      the repository line when the branch is ahead -- and the console sends
//      no files and no refspec; the engine decides what goes.
//   3. An HTTPS remote with no account chosen offers "Choose account", not
//      Push: MAGI never pushes as whatever login the PC remembers.
//   4. The Repository pill is a button onto the repository (Phase 11) and
//      from there the account choice.
//   5. No native dialog anywhere on the path.
//
// Behaviour is proved against real repositories and a real credential store
// in magi/tests/test_github_push.py, and in the browser by
// tests/live/magi-github.live.js; this is the static half.
//
// Run: node tests/magi-code-github.test.js
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

console.log('\nAdding a token');
const add = fn('function codeGhAddSheet(done)');
ok('the field is masked and not autofilled', /inp\.type = "password"/.test(add) && /autocomplete = "off"/.test(add));
ok('it is emptied once sent, whatever happens', /inp\.value = "";\s*\n\s*if \(d\.ok\)/.test(add));
ok('closing the sheet empties it too', /const close = \(\) => \{ inp\.value = ""; sheet\.remove\(\); \}/.test(add));
ok('it posts the token once, to the account route', /codePost\("\/github\/accounts", \{ token \}\)/.test(add));
ok('Enter in the field does not reach the composer', /e\.stopPropagation\(\)/.test(add));
ok('it says how to make a narrow token', /personal-access-tokens\/new/.test(add) && /Read and write/.test(add));
ok('the token is only ever in that one function',
   (MAGI.match(/\{ token \}/g) || []).length === 1);

console.log('\nAccounts');
const accts = fn('function renderGhAccounts()');
ok('Accounts shows the GitHub section', /renderGhAccounts\(\)/.test(fn('function renderAccounts()')));
ok('rows show public fields only', /a\.login/.test(accts) && !/\.token\b/.test(accts));
ok('a token missing from the store is called out', /a\.stored/.test(accts));
ok('remove asks in-page and says the token still works on GitHub',
   /uiConfirmMagi\(/.test(accts) && /revoke/.test(accts));
ok('the hourly limit is shown', /a\.rate\.remaining/.test(accts));

console.log('\nThe repository and its account');
const pill = fn('function codeRepoPill(proj)');
ok('the pill shows owner/repo from the remote', /\$\{gh\.owner\}\/\$\{gh\.repo\}/.test(pill));
// Phase 11: on GitHub the pill opens the Repository panel (whose header
// holds the account); anywhere else it is still the account sheet.
ok('the pill opens the panel on GitHub, the account sheet elsewhere',
   /pill\.onclick = \(\) => \(gh && gh\.owner && gh\.host === "github\.com"\s*\? codeRepoPanel\(proj\) : codeRepoSheet\(proj\)\)/.test(pill));
ok('the panel header opens the account sheet',
   /acct\.onclick = \(\) => \{ close\(\); codeRepoSheet\(proj\); \}/.test(fn('async function codeRepoPanel(proj')));
ok('the pill works from the keyboard', /pill\.tabIndex = 0/.test(pill) && /e\.key === "Enter"/.test(pill));
const sheet = fn('async function codeRepoSheet(proj)');
ok('the choice is saved by login, never a token',
   /codePost\(`\/projects\/\$\{encodeURIComponent\(proj\.id\)\}\/github`, \{ account: pick \}\)/.test(sheet));
ok('"No account" is an explicit choice', /opt\("", "No account"/.test(sheet));
ok('it says whether the account can push', /acc\.push/.test(sheet) && /but not push to it/.test(sheet));
ok('with no account, it offers Sign in with GitHub', /codeGhSignIn\(/.test(sheet));

console.log('\nPush');
const bits = fn('function codeGitPushBits(proj, d, row)');
ok('the line offers Push only where writes are allowed (never A1)', /proj\.write && proj\.write\.ok/.test(bits));
ok('↑n is the push target', /`Push ↑\$\{n\}`/.test(bits));
ok('an HTTPS remote with no account offers Choose account, not Push',
   /if \(needsAcct && !acct\) \{[\s\S]{0,120}Choose account/.test(bits));
ok('Push is disabled while behind, mid-merge, or while a task runs',
   /d\.behind > 0/.test(bits) && /!!d\.state/.test(bits) && /codeBusy\(\)/.test(bits));
const pp = fn('async function codePushProject(proj)');
ok('the line sends nothing but the request', /codePost\(`\/projects\/\$\{encodeURIComponent\(proj\.id\)\}\/push`, \{\}\)/.test(pp));
ok('it cannot be pressed twice', /if \(CODE\.push && CODE\.push\.busy\) return;/.test(pp));
ok('the line is re-read afterwards', /codeGitLoad\(proj\.id\)/.test(pp));
const card = fn('function renderCodeCommit(t, applied, done)');
ok('Push appears only after Commit', /if \(done\) \{[\s\S]{0,700}renderCodePush\(t, pushed\)/.test(card));
const push = fn('function renderCodePush(t, pushed)');
ok('the card says never forced', /Never forced\./.test(push));
ok('the card will not push HTTPS without an account', /go\.disabled = !!t\.pushing \|\| \(needsAcct && !acct\)/.test(push));
const pt = fn('async function codePushTask(t)');
ok('the card sends nothing but the request', /codePost\(`\/tasks\/\$\{t\.id\}\/push`, \{\}\)/.test(pt));
ok('it cannot be pressed twice', /if \(t\.pushing\) return;/.test(pt));
ok('a pushed event from another device marks it pushed', /if \(ev\.k === "pushed"\) t\.pushed = ev;/.test(MAGI));

console.log('\nNo native dialogs');
ok('none on the GitHub path', !NATIVE.test(add + accts + pill + sheet + bits + pp + push + pt));

console.log('\nPhone');
ok('push buttons get a thumb-sized target',
   /@media \(max-width: 760px\) \{\s*\.code-git-act \{ min-height: 32px/.test(MAGI)
   && /\.code-push \.code-appr-acts > \* \{ flex: 1 1 auto; min-height: 44px; \}/.test(MAGI));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
