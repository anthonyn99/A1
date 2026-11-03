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
ok('resumeBrainstorm no longer guesses "writing" from the kind of job', !/\?\s*"writing"/.test(resume));

// ── surviving a reload (found by the S3 live test) ──────────────────────────
// A reload closes the stream with readyState CLOSED BEFORE pagehide; its
// onerror clean-up dropped the pin, so the round never came back.
{
  const store = new Map();
  const sessionStorage = { removeItem: (k) => store.delete(k), setItem: (k, v) => store.set(k, v) };
  const make = new Function('sessionStorage', 'let PAGE_LEAVING = false;\n' + lift(MAGI, 'unpinLive') +
    '\nreturn { unpinLive, leave: () => { PAGE_LEAVING = true; } };');
  const u = make(sessionStorage);
  store.set('k', 'pin'); u.unpinLive('k');
  ok('unpinLive drops a pin normally', !store.has('k'));
  store.set('k', 'pin'); u.leave(); u.unpinLive('k');
  ok('but never while the page is leaving', store.get('k') === 'pin');
}
ok('PAGE_LEAVING is set on beforeunload (pagehide is too late)',
  /addEventListener\("beforeunload", \(\) => \{\s*PAGE_LEAVING = true;/.test(MAGI));
ok('and cleared if the navigation never happened',
  /setTimeout\(\(\) => \{ PAGE_LEAVING = false; \}, 10000\)/.test(MAGI) && /addEventListener\("pageshow", \(\) => \{ PAGE_LEAVING = false; \}\)/.test(MAGI));

const close = lift(MAGI, 'closeBsStream');
ok('closeBsStream unpins only when there was a round here', /if \(had\) unpinLive\(LIVE_BS_SS\)/.test(close));
{
  let unpinned = 0;
  const S = { bs: { es: null, jobId: null } };
  const f = new Function('S', 'unpinLive', 'LIVE_BS_SS', close + '\nreturn closeBsStream;')(S, () => unpinned++, 'k');
  f();
  ok('a fresh page (no stream, no job) keeps the pin', unpinned === 0);
  S.bs.es = { close() {} }; S.bs.jobId = 'j'; f();
  ok('a live round drops it', unpinned === 1 && S.bs.es === null && S.bs.jobId === null);
}

const resume2 = lift(MAGI, 'resumeBrainstorm');
ok('resume retries a failed open', /for \(let i = 0; ; i\+\+\)/.test(resume2) && /if \(i >= 2\) return;/.test(resume2));
ok('and forgets a session the engine does not know', /"Session not found\."\) \{ unpinLive\(LIVE_BS_SS\); return; \}/.test(resume2));
ok('resume opens on the pinned step', /BS_PHASES\.includes\(pin\.phase\) \? pin\.phase : "council"/.test(resume2));
ok('listenBs keeps the step in the pin', /pinLive\(LIVE_BS_SS, \{ sessionId: sid, jobId, kind, phase: next \}\)/.test(listen)
  && /pinLive\(LIVE_BS_SS, \{ sessionId: sid, jobId, kind, phase: S\.bs\.phase \}\)/.test(listen));
ok('a stream blip does not end the round', /if \(es\.readyState !== EventSource\.CLOSED\) \{/.test(listen));

// init rebuilds the grid from the job's own units.
{
  const S = { panels: [{ id: 'chatgpt' }, { id: 'claude' }, { id: 'gemini' }] };
  let rendered = 0; const updated = [];
  const on = new Function('S', 'byId', 'renderGrid', 'updateNode', 'updateCore', 'drawLinks', 'WORKING',
    lift(MAGI, 'onBrainstormEvent') + '\nreturn onBrainstormEvent;')(
    S, (id) => S.panels.find((p) => p.id === id), () => rendered++, (p) => updated.push(p.id), () => {}, () => {}, new Set());
  on({ type: 'init', providers: [
    { id: 'chatgpt', display_name: 'ChatGPT', accent: '#1', state: 'done', text: 'hi', chars: 2 },
    { id: 'deepseek', display_name: 'DeepSeek', accent: '#2', state: 'streaming', text: '', chars: 0 }] });
  ok('init with other units rebuilds the grid', rendered === 1 && S.panels.map((p) => p.id).join() === 'chatgpt,deepseek'
    && S.panels[0].state === 'done' && S.panels[0].text === 'hi');
  on({ type: 'init', providers: [
    { id: 'chatgpt', state: 'done', text: '', chars: 0 }, { id: 'deepseek', state: 'done', text: 'yo', chars: 2 }] });
  ok('init with the same units folds in, keeping text', rendered === 1 && S.panels[0].text === 'hi'
    && S.panels[1].state === 'done' && updated.length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
