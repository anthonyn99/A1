// Deliberation follow-ups, console (MAGI Track F, phase F2, 2026-09-29).
//
// A deliberation is a session: the prompt box follows up with the session's
// memory, and while a run is going it ADDS TO the run. This checks the pure
// pieces -- what the send button does (councilSend), the context a follow-up
// carries (sessionContext), History grouped by session (groupRuns), which
// held notes go out next (carriedNotes) -- and, statically, that every
// History open path leaves the composer empty in follow-up mode with the
// session set, and that nothing is written to the cloud mid-run.
//
// Run: node tests/magi-thread.test.js
'use strict';
const fs = require('fs');
const path = require('path');

// MAGI_HTML points it at a mutated COPY when mutation-checking this test.
const MAGI = fs.readFileSync(process.env.MAGI_HTML || path.join(__dirname, '..', 'magi.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

function lift(src, name) {
  const at = src.search(new RegExp('(^|\\n)(async )?function ' + name + '\\('));
  if (at < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}
const constLine = (name) => {
  const m = new RegExp('const ' + name + ' = [^;]+;').exec(MAGI);
  if (!m) throw new Error('no const ' + name);
  return m[0];
};

const env = [
  constLine('MAX_RUN_NOTES'), constLine('CONTEXT_MAX_CHARS'), constLine('sessionKey'),
  lift(MAGI, 'councilSend'), lift(MAGI, 'turnAnswer'), lift(MAGI, 'sessionContext'),
  lift(MAGI, 'groupRuns'), lift(MAGI, 'carriedNotes'), lift(MAGI, 'foldedQuestion'),
].join('\n');
const F = new Function(env + '\nreturn { councilSend, turnAnswer, sessionContext, groupRuns, carriedNotes, foldedQuestion, sessionKey };')();

// ── the send button's matrix ────────────────────────────────────────────────
console.log('\nWhat the send button does');
const base = { running: false, liveShown: false, turns: 0, up: true, busy: false,
               steer: true, halting: false, notes: 0, units: 2 };
const send = (o) => F.councilSend({ ...base, ...o });
let s = send({});
ok('empty session, idle -> Convene', s.act === 'convene' && s.label === 'Convene' && s.why === '');
s = send({ turns: 2 });
ok('a session with turns, idle -> Follow up', s.act === 'followup' && s.label === 'Follow up' && !s.why);
s = send({ running: true, liveShown: true, turns: 0 });
ok('running and on screen -> Add to run (turn 1)', s.act === 'note' && s.label === 'Add to run' && !s.why);
s = send({ running: true, liveShown: true, turns: 3 });
ok('running and on screen -> Add to run (turn 4)', s.act === 'note' && !s.why);
s = send({ running: true, liveShown: true, steer: false });
ok('an engine without steer holds Add to run and says update',
   s.act === 'note' && /Update the engine/.test(s.why));
s = send({ running: true, liveShown: true, notes: 10 });
ok('at the note cap it is held', s.act === 'note' && /At most 10/.test(s.why));
s = send({ running: true, liveShown: true, halting: true });
ok('halting holds it', s.why === 'Halting');
s = send({ running: true, liveShown: false, turns: 1 });
ok('another run going while reading a session -> Follow up, held with the reason',
   s.act === 'followup' && /Another deliberation is running/.test(s.why));
s = send({ running: true, liveShown: false, turns: 0 });
ok('another run going on an empty session -> Convene, held', s.act === 'convene' && !!s.why);
s = send({ units: 0 });
ok('no units ticked holds Convene', /Tick at least one unit/.test(s.why));
s = send({ running: true, liveShown: true, units: 0 });
ok('no units does NOT hold Add to run (the run has its own)', s.act === 'note' && !s.why);
s = send({ up: false, turns: 1 });
ok('offline holds everything', /offline/.test(s.why));
s = send({ busy: true, turns: 1 });
ok('refining/brainstorm busy holds it', !!s.why);

// ── the context a follow-up carries ───────────────────────────────────────
console.log('\nThe context a follow-up carries');
const turn = (q, v, extra = {}) => ({ runId: 'r' + q, q, verdict: { synthesis_ok: true, verdict: v }, panels: [], ...extra });
let ctx = JSON.parse(F.sessionContext([turn('one', 'ANSWER\nMiranda\nNOTES\nx'), turn('two', 'Shakespeare')]));
ok('oldest first, {q, answer}', ctx.length === 2 && ctx[0].q === 'one' && ctx[1].answer === 'Shakespeare');
ok('the verdict goes raw (the engine strips NOTES/CONFIDENCE)', /NOTES/.test(ctx[0].answer));
ctx = JSON.parse(F.sessionContext([{ runId: 'a', q: 'lost one', gone: true, panels: [] }]));
ok('a turn whose body is gone goes as its question alone', ctx[0].q === 'lost one' && ctx[0].answer === '');
ctx = JSON.parse(F.sessionContext([{ runId: 'b', q: 'merge failed',
  verdict: { synthesis_ok: false, verdict: '' },
  panels: [{ ok: false, text: 'nope' }, { ok: true, text: 'the unit answer' }] }]));
ok('a failed merge carries the first unit that answered', ctx[0].answer === 'the unit answer');
const big = 'x'.repeat(80000);
const many = [turn('a', big), turn('b', big), turn('c', big), turn('d', 'newest')];
const raw = F.sessionContext(many);
ctx = JSON.parse(raw);
ok('kept under the engine cap', raw.length <= 190000, raw.length);
ok('the newest turn is kept whole', ctx[ctx.length - 1].answer === 'newest');
ok('the oldest are shortened first', ctx[0].answer.length <= 2000);
const huge = JSON.parse(F.sessionContext([turn('a', 'y'.repeat(10000)), turn('b', 'y'.repeat(10000)),
                                           turn('c', 'n'.repeat(187000))]));
ok('even when the newest alone nearly fills the cap, it stays whole',
   huge[huge.length - 1].answer.length === 187000 && huge[0].answer === '');
ok('an empty question is not a turn', F.sessionContext([{ q: '  ', panels: [] }]) === '[]');
const folded = F.foldedQuestion('Who is it named after?', [turn('Name a moon', 'Miranda')]);
ok('an old engine gets the turns folded into the question',
   /CONVERSATION SO FAR/.test(folded) && /Miranda/.test(folded) && /NEW MESSAGE:\nWho is it named after\?$/.test(folded));

// ── History, one entry per session ─────────────────────────────────────────
console.log('\nHistory groups by session');
const rows = [
  { id: 'aaa', question: 'first q', created_at: '2026-09-29T10:00:00+00:00', responded_count: 2, attempted_count: 2 },
  { id: 'bbb', session_id: 'aaa', turn: 2, question: 'second q', created_at: '2026-09-29T10:05:00+00:00', responded_count: 1, attempted_count: 2 },
  { id: 'ccc', sid: 'aaa', turn: 3, question: 'third q', created_at: '2026-09-29T10:09:00+00:00', responded_count: 2, attempted_count: 2, cloudOnly: true },
  { id: 'old', question: 'a run from before follow-ups', created_at: '2026-09-01T09:00:00+00:00' },
];
const groups = F.groupRuns(rows);
const g = groups.find((x) => x.id === 'aaa');
ok('two entries: the session and the old run', groups.length === 2);
ok('the session is keyed by its first run id (marks keep working)', !!g && g.session_id === 'aaa');
ok('engine session_id and cloud sid both group', g.n === 3);
ok('turns are in order', g.turns.map((t) => t.id).join() === 'aaa,bbb,ccc');
ok('title = the first question', g.question === 'first q');
ok('time = the latest turn', g.created_at === '2026-09-29T10:09:00+00:00');
ok('counts = the latest turn', g.responded_count === 2);
ok('cloud-only only when every turn is', g.cloudOnly === false);
const old = groups.find((x) => x.id === 'old');
ok('a pre-Track-F run is a one-turn session under its own id', old && old.n === 1 && old.session_id === 'old');
ok('sessionKey: session_id, then sid, then id',
   F.sessionKey({ id: 'x', session_id: 's' }) === 's' && F.sessionKey({ id: 'x', sid: 't' }) === 't' && F.sessionKey({ id: 'x' }) === 'x');

// ── held notes ─────────────────────────────────────────────────────────────
console.log('\nWhat a finished run hands to the next turn');
const sess = { pending: [{ text: 'edited held note', mine: true }, { text: 'from the other tab', mine: false }] };
const live = { sess, notes: [
  { text: 'mine late', applied: 'followup', mine: true },
  { text: 'mine lost', applied: 'verdict', mine: true },
  { text: 'theirs lost', applied: 'verdict' },
] };
const msg = { followup_notes: ['mine late', 'from the other tab'], unapplied_notes: ['mine lost', 'theirs lost'] };
const watched = F.carriedNotes(live, msg, false);
ok('the watching tab sends its own held notes as edited', watched.includes('edited held note'));
ok('...and its own notes the verdict could not apply', watched.includes('mine lost'));
ok('...but not another tab\'s', !watched.includes('from the other tab') && !watched.includes('theirs lost'));
const attached = F.carriedNotes(live, msg, true);
ok('an attached tab gets everything the engine held (as a draft)',
   attached.length === 4 && attached.includes('from the other tab'));

// ── static: the paths ──────────────────────────────────────────────────────
console.log('\nEvery History open path');
const showSession = lift(MAGI, 'showSession');
ok('showSession empties the composer', /setQuestion\(""\)/.test(showSession));
ok('showSession sets the session to the opened one', /S\.session = sess;/.test(showSession));
ok('the History row opens the session', /row\.onclick = \(\) => openSession\(r\);/.test(MAGI));
ok('openRun (the queue) opens its session', /function openRun\(id\) \{ return openSession\(historyGroupOf\(id\)\); \}/.test(MAGI));
ok('cloudOpenRun opens its session', /function cloudOpenRun\(id\) \{ return openSession\(historyGroupOf\(id\)\); \}/.test(MAGI));
const openSession = lift(MAGI, 'openSession');
ok('openSession ends in showSession, or attaches with an empty composer',
   /showSession\(sess\)/.test(openSession) && /setQuestion\(""\);\s*watchRun\(last\.runId, last\.q, sess\)/.test(openSession));
ok('the old question is never put back in the box',
   !/setQuestion\((data\.run|live)\.question/.test(MAGI));
const backToLive = lift(MAGI, 'backToLive');
ok('back to the running prompt brings its session back', /S\.session = live\.sess/.test(backToLive));
ok('New deliberation starts a new session', /S\.session = newSession\(\);/.test(lift(MAGI, 'newRun')));

console.log('\nSending');
const start = lift(MAGI, 'start');
ok('start clears the composer (Convene used to leave it)', /setQuestion\(""\)/.test(start));
ok('start adds to the run when that is what the button says', /s\.act === "note"\) return addNote\(q\)/.test(start));
ok('a hand-off always starts a new session', /start\(\{ fresh: true \}\)/.test(lift(MAGI, 'applyHandoff')));
const runOne = lift(MAGI, 'runOne');
ok('a follow-up POST carries session, turn and context',
   /form\.append\("session", sess\.id\)/.test(runOne) && /form\.append\("turn"/.test(runOne)
   && /form\.append\("context", sessionContext\(sess\.turns\)\)/.test(runOne));
ok('...only when the engine says it can', /follow && engineHas\("followup"\)/.test(runOne));
ok('the note frame is handled', /msg\.type === "note"/.test(runOne));
ok('init carries the session to an attaching tab', /msg\.session_id && !sess\.id/.test(runOne));
ok('ONE cloud write per turn, in the done frame only',
   (runOne.match(/cloudPushRun\(/g) || []).length === 1
   && runOne.indexOf('cloudPushRun(') > runOne.indexOf('msg.type === "done"'));
ok('nothing in the note path writes to the cloud', !/cloud[A-Z]\w*\(/.test(lift(MAGI, 'addNote')));
ok('the note goes to the run\'s own route', /\/api\/runs\/\$\{live\.runId\}\/note/.test(lift(MAGI, 'addNote')));
ok('the index row carries sid and turn', /sid: run\.session_id \|\| runId,\s*turn: run\.turn \|\| 1/.test(lift(MAGI, 'cloudPushRun')));

console.log('\nHistory keeps and deletes whole sessions');
ok('pins are the session\'s', /const isPinned = \(r\) => PINS\.has\(sessionKey\(r\)\);/.test(MAGI));
ok('names are the session\'s', /const nickOf = \(r\) => \(NICKS\[sessionKey\(r\)\]/.test(MAGI));
ok('expiry runs from the latest turn', /clockStart\(sessionKey\(r\), sessionLatestAt\(r\)\)/.test(lift(MAGI, 'expired')));
const del = lift(MAGI, 'deleteRun');
ok('delete removes every turn\'s body', /for \(const id of ids\) await CLOUD\.fs\.deleteDoc\(_runDoc\(id\)\)/.test(del));
ok('...and every turn\'s engine row', /for \(const x of rows\)/.test(del) && /\/api\/runs\/\$\{x\.id\}/.test(del));
ok('History is grouped', /S\.historyMerged = groupRuns\(/.test(MAGI));

console.log('\nThe docked composer');
const place = lift(MAGI, 'placeComposer');
ok('it docks after the verdict when the thread is on', /dock \? \$\("verdict"\) : \$\("councilHd"\)/.test(place));
ok('sticky, not fixed (the 2000px cap holds)', /\.qbar\.docked \{\s*position: sticky; bottom: 0;/.test(MAGI));
ok('it keeps the caret when it moves', /focus\(\{ preventScroll: true \}\)/.test(place));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
