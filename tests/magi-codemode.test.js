// Guards Code Mode's shell: the mode, the header, the strip, and — mostly —
// that Deliberation is untouched by any of it.
//
// Code Mode shares a screen and a composer with the council, which is the
// whole risk. The same textarea means two very different things depending on
// one piece of state, and the failure mode is not an error: it is a prompt
// going to the wrong place, or a council control sitting on a screen that
// cannot use it.
//
// What this pins:
//   1. Mode is not a view. Views are places you go and come back from; mode
//      is what the main screen IS. Making it a view would give History two
//      versions and make every nav button know which mode it returns to.
//   2. Code Mode hides the council's controls — the unit chips, the verdict,
//      the empty state, the caption — rather than leaving them to promise
//      choices it does not offer.
//   3. Convene, Queue and Refine are HELD in Code Mode, not hidden. A control
//      that vanishes teaches you the mode has fewer capabilities, when it
//      simply has not been built yet.
//   4. The strip repaints when the engine's state changes. Discovery finishes
//      after the first paint, so without that it sat on "offline" while the
//      sidebar said the engine was running on this PC.
//
// The behaviour is proved in a real browser over CDP (.claude/skills/verify);
// this is the static half that can run without one.
//
// Run: node tests/magi-codemode.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAGI = fs.readFileSync(path.join(ROOT, 'magi.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
function lift(name, n = 2600) {
  const i = MAGI.indexOf(name);
  return i < 0 ? '' : MAGI.slice(i, i + n);
}

console.log('\nThere are two modes, and Deliberation is the default');
ok('the modes are named', /const MODES = \{ deliberation: "Deliberation", code: "Code Mode" \}/.test(MAGI));
const mode = lift('const MODE = {');
ok('it falls back to deliberation', /return "deliberation";/.test(mode),
   'an unreadable or unknown stored value must not strand you in Code Mode');
ok('the choice is remembered', /const MODE_KEY = lsKey\("mode"\)/.test(MAGI));

console.log('\nMode is not a view');
ok('there is no setView("code")', !/setView\("code"\)/.test(MAGI),
   'views are places you leave and return to; mode is what the screen IS');
ok('Code Mode takes over the council screen',
   /const codeOpen = codeMode\(\) && v === "council" && !studioOpen;/.test(MAGI));
ok('and steps aside for a Studio card', /&& !studioOpen/.test(lift('const codeOpen =', 200)));

console.log('\nThe council\'s controls are not left lying around');
const sv = lift('function setView(v) {', 5200);
ok('the unit chips are hidden', /show\(\$\("unitBar"\)[^;]*&& !codeOpen\)/.test(sv),
   'a row of tick boxes promises a choice Code Mode does not offer');
ok('the grid is hidden', /show\(\$\("magi"\)[^;]*!codeOpen/.test(sv));
ok('the empty state is hidden', /&& !studioOpen && !codeOpen\)/.test(sv));
ok('the verdict is hidden', /if \(!codeOpen\) renderVerdict\(\); else show\(\$\("verdict"\), false\)/.test(sv));
ok('so is the council caption',
   /note\.hidden = !\(idle && S\.view === "council"\) \|\| coding/.test(MAGI));

console.log('\nThe send button becomes Run, gated on what a task needs');
const ue = lift('function updateEnabled()', 2600);
ok('it is labelled Run in Code Mode', /textContent = codeBusy\(\) \? "Working…" : CODE\.rw === "write" \? "Run edits" : "Run"/.test(ue));
ok('it needs the engine', /!up \? "The engine is offline"/.test(ue));
ok('it needs a workspace', /!codeProject\(\) \? "Choose a workspace first"/.test(ue));
ok('it needs at least one agent', /!codeChain\(\)\.length \? "Tick at least one agent"/.test(ue));
ok('one task at a time', /codeBusy\(\) \? "A task is already running"/.test(ue));
ok('and says why when it is held', /\$\("btnSend"\)\.title = why/.test(ue));
ok('Convene is unchanged in Deliberation',
   /\$\("btnSend"\)\.disabled = busy \|\| !q \|\| S\.selected\.size === 0 \|\| !up/.test(ue));
ok('the one box routes to the chain in Code Mode',
   /if \(typeof codeMode === "function" && codeMode\(\)\) return codeRun\(\);/.test(lift('async function start()', 300)));

console.log('\nThe agent chain');
const cm = lift('function codeMembers()', 1900);
ok('CLI agents come from the engine, one chip per agent', /id: `\$\{c\.agent\}-cli`/.test(cm));
ok('only enabled browser units are offered', /if \(!b\.enabled\) continue;/.test(cm));
ok('saved order first, then the engine default', /\.\.\.\(CODE\.order \|\| \[\]\), \.\.\.\(a\.order \|\| \[\]\)/.test(cm));
ok('its ticks are Code Mode\'s own, not the council\'s',
   /const CODE_PICK_KEY = lsKey\("code\.units"\);/.test(MAGI)
   && !/S\.selected/.test(lift('function codeToggle(id)', 400)));
ok('a new agent arrives ticked, an unticked one stays off',
   /p\.on\.includes\(m\.id\) \|\| !known\.has\(m\.id\)/.test(lift('function codeTicked()', 500)));
ok('the order is set with arrows, one-handed', /function openCodeOrder\(\)/.test(MAGI));

console.log('\nA task streams, and survives a reload');
const run = lift('async function codeRun()', 1000);
ok('it posts the ticked chain in order', /agents = codeChain\(\)\.map\(\(m\) => m\.id\)/.test(run));
ok('the stream carries the token the SSE way',
   /new EventSource\(streamUrl\(`\/api\/code\/tasks\/\$\{id\}\/stream`\)\)/.test(MAGI));
ok('the watched task is remembered per tab', /sessionStorage\.setItem\(CODE_TASK_SS, id\)/.test(MAGI));
ok('a dropped stream says the task was lost, not still running',
   /t\.lost = true/.test(lift('function codeAttach(id, prompt)', 2400)));
ok('hand-offs are shown, with who takes over',
   /handing over to \$\{ev\.to_label\}/.test(lift('function renderCodeTask(t)', 3000)));

console.log('\nNothing in Code Mode writes to Firestore');
const block = MAGI.slice(MAGI.indexOf('const CODE_PROJ_KEY'), MAGI.indexOf('function setView(v)'));
ok('the block is found', block.length > 5000, String(block.length));
ok('no setDoc / updateDoc / onSnapshot in it', !/\b(setDoc|updateDoc|onSnapshot|addDoc)\s*\(/.test(block),
   'a transcript is SSE and is never stored; ticks and project are this browser\'s');
ok('no native dialog in it', !/\b(window\.)?(alert|confirm|prompt)\s*\(/.test(block));
ok('no native file picker', !/showDirectoryPicker|type\s*=\s*["']file/.test(block));

console.log('\nThe chips are readable, and say what is left');
ok('every usage window is shown, not just the first',
   /\.map\(\(\[k, v\]\) => `\$\{USAGE_WINDOWS\[k\] \|\| k\} \$\{Math\.round\(v\.utilization \* 100\)\}%`\)/.test(MAGI),
   'a 5h window at 40% and a weekly one at 96% are different situations');
ok('shortest window first', /\.sort\(\(a, b\) => winMinutes\(a\[0\]\) - winMinutes\(b\[0\]\)\)/.test(block));
ok('Codex\'s minute-named windows are understood', /\^\(\\d\+\)\(\[mhd\]\)\$/.test(block));
ok('the second line is not 8px uppercase any more',
   /\.code-chip \.chip-unit \{[^}]*font-size: 10px[^}]*text-transform: none/.test(MAGI));
ok('no number badges', !/code-chip-n/.test(MAGI));
ok('the Agents label is above the row, not beside it',
   /\.code-chain \{ display: flex; flex-direction: column; align-items: center;/.test(MAGI));

console.log('\nUsage stays current, cheaply');
ok('the timer uses the process-free endpoint', /codeGet\("\/usage"\)/.test(block));
ok('a live usage frame updates the chips', /if \(ev\.k === "usage"\) codeApplyUsageEvent\(ev\);/.test(block));
ok('the timer pauses when the tab is hidden', /if \(document\.hidden \|\| !online\(\) \|\| !CODE\.agents\) return;/.test(block));
ok('it only runs while Code Mode is on screen', /codeUsagePoll\(codeOpen\);/.test(MAGI));
ok('a full reload only when sign-in state may have changed',
   /if \(out === "unauthed" \|\| out === "limited" \|\| out === "unavailable"\) codeLoad\(true\);\s*else codeUsageRefresh\(\);/.test(block));

console.log('\nCoding accounts');
ok('renaming reports on the sync line', /setSync\("error", _syncFail\("saving an account name", e\)\)/.test(block));
ok('an account can be renamed', /\/label`,\s*\{ label: title\.value \}/.test(block));
ok('renaming does not touch the login',
   /Renaming it does not touch the login/.test(block));
ok('Codex sign-in shows the device code', /code-login-code/.test(block));
ok('with a phishing warning', /Device codes are a common phishing trick/.test(block));
ok('Codex is not tied to the ChatGPT unit', /separate from the ChatGPT unit/.test(block));
ok('this PC\'s Claude login cannot be removed from here', /if \(s\.slot !== "system"\)/.test(block));
ok('Queue is disabled', /\$\("btnQueue"\)\.disabled = coding \|\|/.test(ue));
ok('Refine is disabled', /\$\("btnRefine"\)\.disabled = coding \|\|/.test(ue));
ok('changing mode repaints them', /updateEnabled\(\);/.test(lift('function setMode(m,', 900)),
   'nothing else would call it, so the buttons kept the other mode\'s state');

console.log('\nThe header can never be ambiguous');
ok('it is set from the mode', /t\.textContent = MODES\[MODE\.cur\]/.test(MAGI));
ok('and the composer says what it wants', /Describe what to build, fix or look at/.test(MAGI));

console.log('\nThe strip tells the truth about the engine');
ok('there is a strip', /function renderCodeStrip\(\)/.test(MAGI));
const strip = lift('function renderCodeStrip()');
for (const k of ['Profile', 'Engine', 'Workspace', 'Repository', 'Auto commit', 'Auto push']) {
  ok(`it carries ${k}`, strip.indexOf(`"${k}"`) >= 0);
}
// Fields that do not exist yet are shown empty rather than omitted: a strip
// that hides them teaches a shape that is about to change.
ok('the fields still to come are shown as empty', /"none", "muted"/.test(strip));
ok('it repaints when the engine changes',
   /if \(typeof renderCodeView === "function" && codeMode\(\)\) renderCodeView\(\);/.test(MAGI),
   'discovery finishes after the first paint');
ok('and repaints the whole view, not just the pills',
   !/renderCodeStrip\(\);\s*\n\s*if \(typeof syncMobileLink/.test(MAGI),
   'repainting half of it moved the contradiction further down the screen');

console.log('\nThe switch is ours, and reachable');
ok('two options, in the composer toolbar', /class="mode-sw" id="modeSw"/.test(MAGI));
ok('it is inside the toolbar', /qbar-toolbar[\s\S]{0,400}mode-sw/.test(MAGI));
ok('no native dialog anywhere in Code Mode',
   !/\b(window\.)?(alert|confirm|prompt)\s*\(/.test(
     lift('function setMode(m,') + lift('function renderCodeView()') + lift('function renderCodeStrip()')));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
