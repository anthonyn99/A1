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

console.log('\nCouncil actions are held, not hidden');
const ue = lift('function updateEnabled()', 2200);
ok('Convene is disabled', /\$\("btnSend"\)\.disabled = coding \|\|/.test(ue));
ok('and relabelled to what it will do', /coding \? "Run"/.test(ue));
ok('with a reason on it', /Code Mode cannot run anything yet/.test(ue));
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
