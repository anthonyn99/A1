// Guards Code Mode's auto commit / auto push in the console (Phase 12).
//
// What this pins, and why each matters:
//   1. The strip's "Auto commit" / "Auto push" pills show the project's real
//      switches (they were hard-coded "off" until Phase 12), count down a
//      pending commit, and open the switches when tapped.
//   2. The switches are drawn here (role=switch buttons), never a native
//      checkbox or dialog, and A1 is shown locked with its reason.
//   3. Nothing polls. The repository line is re-read once when a countdown
//      reaches zero, then every few seconds only while the engine says it is
//      committing or pushing.
//   4. An auto push starts the Actions watch -- once per SHA, not on every
//      re-read of the line.
//   5. The task card hands the commit to the line when auto commit took it,
//      rather than offering a second, manual commit of the same files.
//
// The behaviour is proved against real repositories in
// magi/tests/test_code_autocommit.py, and in the browser by
// tests/live/magi-autocommit.live.js; this is the static half.
//
// Run: node tests/magi-autocommit.test.js
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

console.log('The strip');
const strip = fn('function renderCodeStrip()');
ok('the pills are no longer hard-coded off', !/codePill\("Auto commit", "off", "muted"\)\);\s*\n\s*strip\.append\(codePill\("Auto push", "off"/.test(strip));
ok('they read the project\'s switches', /const a = codeAuto\(proj\)/.test(strip) && /a\.commit \? "on" : "off"/.test(strip));
ok('A1 reads as locked', /a\.locked \? codePill\("Auto commit", "off · A1"/.test(strip));
ok('a pending commit counts down', /code-auto-cd/.test(strip) && /dataset\.due = pend\.due/.test(strip));
ok('tapping a pill opens the switches', /pill\.onclick = \(\) => codeAutoSheet\(proj\)/.test(strip));

console.log('\nThe switches');
const sheet = fn('function codeAutoSheet(proj)');
ok('drawn here, as role=switch buttons', /setAttribute\("role", "switch"\)/.test(sheet) && /aria-checked/.test(sheet));
ok('no native checkbox anywhere in it', !/type = "checkbox"|input\[type=checkbox\]|"checkbox"/.test(sheet));
ok('locked with the reason on A1', /if \(a\.locked\) body\.append\(el\("div", "sheet-err", a\.locked\)\)/.test(sheet)
   && /a\.commit, !!a\.locked\)/.test(sheet));
ok('auto push needs auto commit', /a\.push, !!a\.locked \|\| !a\.commit\)/.test(sheet));
ok('the window choices', /\[1, 3, 5, 10\]/.test(sheet));
ok('it saves through the engine route', /codePost\(`\/projects\/\$\{encodeURIComponent\(proj\.id\)\}\/auto`, change\)/.test(sheet));

console.log('\nThe repository line');
const bits = fn('function codeAutoBits(proj, row)');
ok('Commit now and Cancel while waiting', /"Commit now"/.test(bits) && /"Cancel"/.test(bits) && /p\.state === "waiting"/.test(bits));
ok('a blocked commit says why and offers Try again', /p\.blocked \? "Try again"/.test(bits) && /code-git-bad", p\.blocked/.test(bits));
ok('it hangs off the git line', /codeGitPushBits\(proj, d, row\);\s*\n\s*codeAutoBits\(proj, row\);/.test(MAGI));
const act = fn('async function codeAutoAct(proj, what)');
ok('the buttons call the engine, not git', /\/auto\/\$\{what\}/.test(act));
ok('no native dialog in the auto path', !/\b(confirm|alert|prompt)\(/.test(sheet + bits + act));

console.log('\nNo polling');
const follow = fn('function codeAutoFollow(pid, a)');
ok('re-read only while committing or pushing', /p\.state === "committing" \|\| p\.state === "pushing"/.test(follow)
   && /setTimeout\(\(\) => codeGitLoad\(pid\), 3000\)/.test(follow));
ok('no interval of its own', !/setInterval/.test(follow + bits + sheet + act));
const tick = MAGI.slice(MAGI.indexOf('for (const n of document.querySelectorAll(".code-auto-cd[data-due]"))') - 400,
                        MAGI.indexOf('for (const n of document.querySelectorAll(".code-auto-cd[data-due]"))') + 700);
ok('the countdown rides the existing 1 s ticker', /setInterval\(\(\) => \{/.test(tick) && /codeAutoLeft\(\+n\.dataset\.due\)/.test(tick));
ok('zero triggers ONE re-read per countdown', /CODE\.autoReadFor !== due/.test(tick) && /CODE\.autoReadFor = due;/.test(tick));

console.log('\nThe Actions watch');
ok('an auto push starts it -- on GitHub only', /codeWatchStart\(proj, push\.sha, \{ branch: push\.branch \}\)/.test(follow)
   && /gh\.host === "github\.com"/.test(follow));
ok('once per SHA', /!AUTO_SEEN\.has\(push\.sha\)/.test(follow) && /AUTO_SEEN\.add\(push\.sha\)/.test(follow));
ok('only a recent push', /AUTO_WATCH_FRESH_MS/.test(follow));
ok('the line feeds it on every read', /codeAutoFollow\(pid, next\.auto\)/.test(fn('async function codeGitLoad(pid)')));

const wt = fn('async function codeWatchTick()');
ok('a refusal another try will not change stops the watch at once', /WATCH_FINAL\.has\(d\.error\)/.test(wt)
   && /w\.state = "noaccess"/.test(wt) && /if \(w\.state === "noaccess"\) \{[^}]*return; \}/.test(wt));
ok('and says which permission a private repo needs', /Actions: Read-only/.test(wt));
ok('forbidden / bad token / not found are final', /const WATCH_FINAL = new Set\(\["forbidden", "bad_token", "not_found"/.test(MAGI));

console.log('\nThe task card');
const card = fn('function renderCodeApproval(t, ev)');
ok('auto commit takes it: no second, manual commit', /const auto = t\.events\.find\(\(e\) => e\.k === "autocommit"\)/.test(card)
   && /if \(auto && !done\) \{[\s\S]{0,500}return box;/.test(card));

console.log('\nPhone');
ok('the window buttons are thumb-sized', /\.ac-win \.code-git-act \{ min-height: 36px/.test(MAGI));
ok('the switch rows are tall enough to tap', /\.ac-row \{[\s\S]{0,300}min-height: 52px/.test(MAGI));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
