// Brainstorm's phase line (MAGI Phase S3, 2026-09-28).
//
// The line under a running round used to flip to "Merging…" on ANY state event
// that carried a message -- a member's "Opening browser" was enough -- never
// showed the critique step, and went back to "council" on reload. The engine
// now sends a `phase` event at each step and the current step in `init`;
// bsPhaseFrom reads those, plus (for an older engine) only the chairman's own
// "… is merging / is writing / is checking" line.
//
// Run: node tests/magi-bs-phase.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const MAGI = fs.readFileSync(path.join(__dirname, '..', 'magi.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

function lift(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}

const phasesDecl = /const BS_PHASES = \[[^\]]*\];/.exec(MAGI);
ok('BS_PHASES is declared', !!phasesDecl);
const bsPhaseFrom = new Function(phasesDecl[0] + '\n' + lift(MAGI, 'bsPhaseFrom') + '\nreturn bsPhaseFrom;')();

// The engine's own word.
ok('phase event: critique', bsPhaseFrom({ type: 'phase', phase: 'critique' }, 'council') === 'critique');
ok('phase event: reviewing', bsPhaseFrom({ type: 'phase', phase: 'reviewing' }, 'writing') === 'reviewing');
ok('init replays the phase', bsPhaseFrom({ type: 'init', providers: [], phase: 'merging' }, 'council') === 'merging');
ok('init from an old engine keeps the current phase', bsPhaseFrom({ type: 'init', providers: [] }, 'council') === 'council');
ok('an unknown phase is ignored', bsPhaseFrom({ type: 'phase', phase: 'bogus' }, 'critique') === 'critique');

// Bug (b): member messages no longer move the line.
ok('a member message does not flip to merging',
  bsPhaseFrom({ type: 'state', provider_id: 'grok', state: 'launching', message: 'Opening browser' }, 'council') === 'council');
ok('a critique member message stays critique',
  bsPhaseFrom({ type: 'state', provider_id: 'gemini', state: 'waiting', message: 'Waiting for the reply' }, 'critique') === 'critique');

// Fallback for an engine without phase events: only the chairman's line.
const chair = (m) => ({ type: 'state', provider_id: 'claude', state: 'waiting', chars: 0, text: '', message: m });
ok('chairman is merging', bsPhaseFrom(chair('Claude is merging the round'), 'council') === 'merging');
ok('chairman is writing', bsPhaseFrom(chair('Claude is writing the plan'), 'critique') === 'writing');
ok('chairman is checking -> reviewing', bsPhaseFrom(chair('Claude is checking the document'), 'writing') === 'reviewing');

// The line itself has text for every phase.
const note = lift(MAGI, 'phaseNote');
for (const p of ['council', 'critique', 'merging', 'writing', 'reviewing']) {
  ok('phaseNote has text for ' + p, new RegExp('\\b' + p + ':\\s*"').test(note));
}
ok('critique wording', /critique: "Units are reviewing each other's proposals…"/.test(note));
ok('reviewing wording', /reviewing: "Checking the finished document…"/.test(note));

// Wiring: the stream handler routes init/phase/state through it, and a reload
// no longer guesses "writing" for a finalise.
const listen = lift(MAGI, 'listenBs');
ok('listenBs uses bsPhaseFrom', /bsPhaseFrom\(msg, S\.bs\.phase\)/.test(listen));
ok('listenBs no longer flips on any message', !/if \(msg\.message\)/.test(listen));
const resume = lift(MAGI, 'resumeBrainstorm');
ok('resumeBrainstorm starts at council and lets init correct it', /phase: "council"/.test(resume) && !/\?\s*"writing"/.test(resume));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
