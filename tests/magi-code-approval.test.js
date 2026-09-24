// Guards Code Mode's write half in the console: the Read/Write switch and the
// approval card.
//
// What this pins, and why each matters:
//   1. Write is per task. Every task starts in Read and the switch falls back
//      to Read after a run -- a mode left on from yesterday is how an agent
//      gets to edit a folder you only meant to ask about. So the choice is
//      never written to storage.
//   2. The engine hears the choice. The mode travels in the POST body; the
//      console's switch is a request, the engine decides (the folder may be
//      refused there, whatever the page sends).
//   3. Only a button approves. The answer is posted from the two buttons and
//      nowhere else, with no native dialog in the path.
//   4. The countdown never redraws the view -- it rewrites its own text. A
//      once-a-second re-render would snap every open diff shut while you
//      read it.
//   5. Every way of not applying says so: denied, timed out, halted, refused,
//      conflict each has its own sentence, and each says the folder is
//      unchanged (or, for a conflict, where the change was kept).
//
// The behaviour is proved against the real engine in
// tests/live/magi-write.live.js; this is the static half.
//
// Run: node tests/magi-code-approval.test.js
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

console.log('Write is chosen per task');
ok('the switch starts in Read', /rw: "read",/.test(MAGI));
ok('the choice is never stored', !/lsWrite\([^)]*rw/.test(MAGI) && !/CODE_RW_KEY/.test(MAGI));
const run = lift('async function codeRun()', 1400);
ok('the mode goes to the engine', /codePost\("\/tasks", \{[^}]*mode: CODE\.rw/.test(run));
ok('and falls back to Read once the task starts', /CODE\.rw = "read";/.test(run));
const rw = lift('function renderCodeRw(proj)', 1400);
ok('Write is disabled where the engine says no', /b\.disabled = k === "write" && !w\.ok/.test(rw));
ok('with the engine\'s reason on screen', /code-rw-note", w\.why/.test(rw));
ok('a disallowed Write cannot linger as the choice', /if \(!w\.ok && CODE\.rw === "write"\) CODE\.rw = "read";/.test(rw));
ok('it is a radio group to assistive tech', /role", "radiogroup"/.test(rw) && /"aria-checked"/.test(rw));

console.log('\nOnly a button approves');
const decide = lift('async function codeDecide(t, approve)', 900);
ok('the answer is posted to /approve', /codePost\(`\/tasks\/\$\{t\.id\}\/approve`, \{ approve \}\)/.test(decide));
ok('it cannot be sent twice', /if \(t\.deciding != null\) return;/.test(decide));
ok('another device answering first is not an error', /d\.error !== "not_waiting"/.test(decide));
const card = lift('function renderCodeApproval(t, ev)', 4200);
ok('Approve and Deny are the only callers', (MAGI.match(/codeDecide\(t, (true|false)\)/g) || []).length === 2);
ok('both disable while the answer is in flight', /deny\.disabled = ok\.disabled = t\.deciding != null/.test(card));
ok('no native dialog in the write path',
   !/\b(window\.)?(alert|confirm|prompt)\s*\(/.test(card + decide + rw + lift('function renderCodeRefused(ev)', 600)));

console.log('\nReading the diff');
ok('open files survive a re-render', /t\.openFiles = t\.openFiles \|\|/.test(card) && /ontoggle/.test(card));
const tickAll = lift('/* One ticker for every countdown on screen.', 800);
const tick = tickAll.slice(0, tickAll.indexOf('}, 1000);'));
ok('the countdown rewrites its own text', /\.code-appr-cd\[data-expires\]/.test(tick));
ok('and never redraws the view', !/renderCodeView/.test(tick));
const diff = lift('function codeDiffEl(f)', 1100);
ok('a truncated diff says Approve still applies all of it', /still part of what Approve applies/.test(diff));
ok('binary files are named, not dumped', /Binary file — not shown/.test(diff));

console.log('\nEvery way of not applying says so');
const outs = lift('const CODE_WRITE_OUT = {', 700);
for (const k of ['applied', 'none', 'denied', 'timeout', 'halted', 'refused', 'conflict', 'discarded']) {
  ok(`"${k}" has its own words`, new RegExp(`\\b${k}: \\{ ok: (true|false), txt: "`).test(outs));
}
ok('a refusal lists every refused path', /for \(const r of ev\.refused\)/.test(lift('function renderCodeRefused(ev)', 700)));
ok('while waiting, the status says nothing has changed yet',
   /Waiting for your approval — nothing has changed yet/.test(MAGI));

console.log('
A1 (Phase 14b): writable; it commits and pushes itself');
{
  const whole = lift('function renderCodeApproval(t, ev)', 7000);
  const hookAt = whole.indexOf('if (applied.by_hook)');
  ok('an A1 change says A1 commits and pushes it itself', hookAt > 0 && /auto-commit records it and "\s*\+ "pushes it to main/.test(whole));
  ok('...and returns before the Commit button is drawn',
     hookAt > 0 && hookAt < whole.indexOf('renderCodeCommit(t, applied, done)')
     && /Code Mode does not commit here\."\)\);\s*return box;/.test(whole));
  ok('approving in A1 says it ships, and names what deploys',
     /if \(ev\.ships && open\)/.test(whole) && /Approving ships this/.test(whole) && /ev\.deploy_files/.test(whole));
  ok('a change under magi/ warns that the engine must restart',
     /ev\.engine_files && ev\.engine_files\.length/.test(whole) && /MAGI never "\s*\+ "restarts itself/.test(whole));
  ok('the repository line offers no Push where the engine will not push',
     /proj\.write\.push !== false/.test(lift('function codeGitPushBits(proj, d, row)', 900)));
  ok('the Write switch shows the A1 note',
     /else if \(w\.ok && w\.note\) box\.append\(el\("div", "code-rw-note", w\.note\)\)/.test(MAGI));
}

console.log('\nPhone');
ok('the buttons go full width under the thumb',
   /@media \(max-width: 760px\)[\s\S]{0,300}\.code-appr-acts button \{ flex: 1 1 0; min-height: 46px; \}/.test(MAGI));
ok('a long diff line scrolls inside its box, not the page',
   /\.code-diff \{[^}]*overflow: auto/.test(MAGI) && /\.code-diff > div \{[^}]*white-space: pre/.test(MAGI));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
