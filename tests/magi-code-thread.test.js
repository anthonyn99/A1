// Code Mode follow-ups, console (MAGI Track F, phase F4, 2026-09-30).
//
// A Code Mode task is a turn of a session: the box follows up with the
// session's memory, and while a task runs it MESSAGES it. This runs the pure
// pieces for real -- what the send button does (codeSend), what a turn tells
// the next one (codeTurnOf: a denied diff must not read as applied), the
// `session` field a follow-up sends (codeSessionBody: native resume only on
// the engine that ran it), a revision's rounds (codeRounds), History grouped
// by session (codeGroupRows) -- and statically checks that every History open
// path leaves the box empty with the session set, that a workspace switch
// starts a new session, and that nothing is written to the cloud mid-task.
// Also the console half of F4's Gemini fix: parseVerdict un-gluing headings.
//
// Run: node tests/magi-code-thread.test.js
'use strict';
const fs = require('fs');
const path = require('path');

// MAGI_HTML points it at a mutated COPY when mutation-checking this test.
const MAGI = fs.readFileSync(process.env.MAGI_HTML || path.join(__dirname, '..', 'magi.html'), 'utf8')
  .replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

function lift(name) {
  const at = MAGI.search(new RegExp('(^|\\n)(async )?function ' + name + '\\('));
  if (at < 0) throw new Error('not found: ' + name);
  let i = MAGI.indexOf('{', MAGI.indexOf(')', at)), depth = 0;
  for (let j = i; j < MAGI.length; j++) {
    if (MAGI[j] === '{') depth++;
    else if (MAGI[j] === '}' && --depth === 0) return MAGI.slice(at, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}
const constLine = (name) => {
  const m = new RegExp('const ' + name + ' = [^;]+;').exec(MAGI);
  if (!m) throw new Error('no const ' + name);
  return m[0];
};

const env = [
  constLine('MAX_TASK_MESSAGES'), constLine('CODE_SESSION_MAX_CHARS'),
  constLine('CODE_SESSION_MAX_TURNS'), constLine('codeSessKey'),
  lift('codeNewSession'), lift('codeSend'), lift('codeTaskText'), lift('codeTurnOf'),
  lift('codeSessionBody'), lift('codeRounds'), lift('codeGroupRows'), lift('codeLatestBySession'),
].join('\n');
const F = new Function(env + '\nreturn { codeNewSession, codeSend, codeTurnOf, codeSessionBody, codeRounds, codeGroupRows, codeLatestBySession, codeSessKey };')();

// ── the send button's matrix ────────────────────────────────────────────
console.log('\nWhat the send button does');
const base = { running: false, rw: 'read', turns: 0, up: true, project: true, agents: 2,
               steer: true, followup: true, halting: false, msgs: 0, away: '' };
const send = (o) => F.codeSend({ ...base, ...o });
let s = send({});
ok('empty session, idle -> Run', s.act === 'run' && s.label === 'Run' && s.why === '');
s = send({ rw: 'write' });
ok('...Run edits in Write', s.act === 'run' && s.label === 'Run edits');
s = send({ turns: 2 });
ok('a session with turns, idle -> Follow up', s.act === 'followup' && s.label === 'Follow up' && !s.why);
s = send({ turns: 2, rw: 'write' });
ok('...and says it edits in Write', s.act === 'followup' && /edits/.test(s.label));
s = send({ running: true });
ok('a task running -> Send (a message to it), not a second task', s.act === 'message' && s.label === 'Send' && !s.why);
s = send({ running: true, turns: 3 });
ok('...on any turn', s.act === 'message' && !s.why);
s = send({ running: true, steer: false });
ok('an engine without steer holds Send and says update', s.act === 'message' && /Update the engine/.test(s.why));
s = send({ turns: 1, followup: false });
ok('an engine without followup holds Follow up and says update', s.act === 'followup' && /Update the engine/.test(s.why));
s = send({ followup: false });
ok('...but a first turn still runs on it', s.act === 'run' && !s.why);
s = send({ running: true, msgs: 20 });
ok('at 20 messages Send is held', /At most 20/.test(s.why));
s = send({ running: true, halting: true });
ok('halting holds it', s.why === 'Halting');
s = send({ running: true, project: false, agents: 0 });
ok('a message needs no workspace or agents (the task has its own)', s.act === 'message' && !s.why);
s = send({ turns: 1, away: 'X has no folder on this engine' });
ok('a session whose folder is not here is held, with the reason', /no folder on this engine/.test(s.why));
s = send({ project: false });
ok('no workspace holds Run', /Choose a workspace/.test(s.why));
s = send({ agents: 0, turns: 1 });
ok('no agents holds Follow up', /Tick at least one agent/.test(s.why));
s = send({ up: false, running: true });
ok('offline holds everything', /offline/.test(s.why));

// ── what a turn tells the next one ──────────────────────────────────────
console.log('\nA turn, as the next turn\'s memory');
const denied = { prompt: 'add a line', events: [{ k: 'start', mode: 'write' }, { k: 'text', text: 'Added it.' }],
                 result: { outcome: 'ok', write: 'denied', by_label: 'Codex', text: 'Added it.' } };
let tt = F.codeTurnOf(denied);
ok('a denied write turn says denied, with no files', tt.mode === 'write' && tt.write === 'denied' && tt.files.length === 0);
ok('...and keeps what the agent said', tt.text === 'Added it.' && tt.by === 'Codex');
const applied = { prompt: 'fix', events: [{ k: 'start', mode: 'write' }],
                  result: { outcome: 'ok', write: 'applied', files: ['a.py', 'b.py'], text: 'done' } };
tt = F.codeTurnOf(applied);
ok('an applied write turn lists its files', tt.write === 'applied' && tt.files.join() === 'a.py,b.py');
const fromEvent = { prompt: 'fix', events: [{ k: 'start', mode: 'write' },
  { k: 'applied', files: [{ path: 'c.py' }] }], result: { outcome: 'ok', write: 'applied' } };
ok('...from the applied event when the result has none', F.codeTurnOf(fromEvent).files.join() === 'c.py');
const read = { prompt: 'what is it?', events: [{ k: 'start', mode: 'read' }, { k: 'text', text: 'a' }, { k: 'text', text: 'b' }],
               result: { outcome: 'ok' } };
tt = F.codeTurnOf(read);
ok('a read turn has no write outcome', tt.mode === 'read' && tt.write === '');
ok('...and its text is what streamed when the result has none', tt.text === 'a\n\nb');
const halted = { prompt: 'edit', events: [{ k: 'start', mode: 'write' }], result: { outcome: 'cancelled' } };
ok('a write turn that ended with no write says discarded, never applied',
   F.codeTurnOf(halted).write === 'discarded');
ok('a gone turn carries its prompt alone', F.codeTurnOf({ prompt: 'p', gone: true, events: [] }).text === ''
   && F.codeTurnOf({ prompt: 'p', gone: true, events: [] }).prompt === 'p');

// ── the session field ───────────────────────────────────────────────────
console.log('\nThe `session` field a follow-up sends');
const t1 = { id: 'aaa111', prompt: 'one', turn: 1, engine: 'eng_A', events: [{ k: 'start', mode: 'read' }],
             result: { outcome: 'ok', text: 'first', native: { agent: 'claude:system', sid: 'sid-1111' } } };
const t2 = { id: 'bbb222', prompt: 'two', turn: 2, engine: 'eng_A', events: [{ k: 'start', mode: 'read' }],
             result: { outcome: 'ok', text: 'second', native: { agent: 'codex:c1', sid: 'th-22222' } } };
const sess = { id: 'aaa111', projectId: 'p1', turns: [t1, t2], pending: [] };
let body = F.codeSessionBody(sess, 'eng_A');
ok('id is the first task\'s', body.id === 'aaa111');
ok('turn is the next one', body.turn === 3);
ok('every earlier turn goes, oldest first', body.turns.map((x) => x.prompt).join() === 'one,two');
ok('native is the LAST turn\'s CLI session', body.native.agent === 'codex:c1' && body.native.sid === 'th-22222');
body = F.codeSessionBody(sess, 'eng_B');
ok('...but only on the engine that ran it', Object.keys(body.native).length === 0);
body = F.codeSessionBody({ ...sess, turns: [t1, { ...t2, result: { outcome: 'ok', text: 'x' } }] }, 'eng_A');
ok('a browser unit\'s last turn sends no native', Object.keys(body.native).length === 0);
body = F.codeSessionBody({ ...sess, turns: [{ ...t1, prompt: '  ' }, t2] }, 'eng_A');
ok('a turn with no prompt is left out', body.turns.length === 1);
const big = Array.from({ length: 5 }, (_, i) => ({ id: 't' + i, prompt: 'q' + i, turn: i + 1, events: [],
  result: { outcome: 'ok', text: 'x'.repeat(60000) } }));
body = F.codeSessionBody({ id: 't0', turns: big }, '');
const size = body.turns.reduce((n, t) => n + t.prompt.length + t.text.length, 0);
ok('a session over the cap is cut under it', size <= 190000, size);
ok('...the newest turn kept whole', body.turns[body.turns.length - 1].text.length === 60000);
ok('...the oldest shortened first', body.turns[0].text.length <= 2000);

// ── a revision's rounds ─────────────────────────────────────────────────
console.log('\nA revision at the card is a second round');
const rounds = F.codeRounds([{ k: 'start' }, { k: 'approval' }, { k: 'user', how: 'revise' },
  { k: 'decision', why: 'revised' }, { k: 'note' }, { k: 'agent' }, { k: 'approval' },
  { k: 'decision', why: 'approved' }, { k: 'applied' }, { k: 'end' }]);
ok('two rounds', rounds.length === 2);
ok('the revised decision closes the first', rounds[0][rounds[0].length - 1].why === 'revised');
ok('the second has its own card and outcome',
   rounds[1].filter((e) => e.k === 'approval').length === 1 && rounds[1].some((e) => e.k === 'applied'));
ok('no revision -> one round', F.codeRounds([{ k: 'start' }, { k: 'end' }]).length === 1);

// ── History by session ──────────────────────────────────────────────────
console.log('\nHistory, grouped by session');
const rows = [
  { id: 'old1', prompt: 'before follow-ups', at: '2026-09-20T10:00:00Z', outcome: 'ok' },
  { id: 's1', sid: 's1', turn: 1, prompt: 'first', at: '2026-09-30T10:00:00Z', outcome: 'ok', pid: 'p1', project: 'A' },
  { id: 's1b', sid: 's1', turn: 2, prompt: 'second', at: '2026-09-30T10:05:00Z', outcome: 'task_failed', write: true },
  { id: 's1c', session_id: 's1', turn: 3, prompt: 'third', at: '2026-09-30T10:09:00Z', outcome: 'ok', engineOnly: true },
];
const groups = F.codeGroupRows(rows);
const g = groups.find((x) => x.id === 's1');
ok('a task from before follow-ups is its own session', groups.some((x) => x.id === 'old1' && x.n === 1));
ok('engine rows (session_id) and cloud rows (sid) join one session', g && g.n === 3);
ok('title = the first prompt', g.prompt === 'first');
ok('time = the latest turn', g.at === '2026-09-30T10:09:00Z');
ok('outcome = the latest turn\'s', g.outcome === 'ok');
ok('Write if any turn wrote', g.write === true);
ok('turns in order', g.turns.map((x) => x.id).join() === 's1,s1b,s1c');
ok('project from the first turn', g.pid === 'p1' && g.project === 'A');
const latest = F.codeLatestBySession(rows);
ok('a session\'s expiry clock is its latest turn', latest.get('s1') === '2026-09-30T10:09:00Z');

// ── statically: the open paths, the workspace rule, no writes mid-task ──
console.log('\nOpening a session, and what starts a new one');
const open = lift('codeOpenHistory');
ok('opening accepts a session entry or a single row', /r && r\.turns \? r : codeGroupRows\(\[r\]\)\[0\]/.test(open));
ok('it loads EVERY turn', /g\.turns\.filter\([^)]*\)[^;]*\.map\(codeLoadTurn\)/.test(open));
ok('it leaves the box EMPTY', /\$\("composer"\)\.value = "";/.test(open));
ok('it sets the session to the opened one', /sess\.id = g\.id;/.test(open) && /CODE\.session = sess;/.test(open)
   && /codeAttach\(live\.id[^;]*session: sess/.test(open));
ok('a turn still running here opens attached', /!x\.done && String\(x\.session_id \|\| x\.id\) === g\.id/.test(open));
const loadTurn = lift('codeLoadTurn');
ok('a turn loads from the engine, then the cloud, then is "gone"',
   /codeReplay\(r\.id\)/.test(loadTurn) && /_codeTaskDoc\(r\.id\)/.test(loadTurn) && /gone: true/.test(loadTurn));
ok('the queue opens a finished task through the same path',
   /codeHistRows\(\)\.find\(\(g\) => g\.turns\.some\(\(x\) => x\.id === id\)\)[\s\S]{0,60}codeOpenHistory\(r\)/.test(lift('codeQueueOpen')));
ok('choosing another workspace starts a new session',
   /sess\.projectId !== id && !codeBusy\(\)[\s\S]{0,300}CODE\.session = codeNewSession\(id\)/.test(lift('codeSetProject')));
ok('Clear / New session starts a new session', /CODE\.session = codeNewSession\(/.test(lift('codeClearTask')));
const attach = lift('codeAttach');
ok('a task not in this session (queue, Diagnose, reattach) is a session of its own',
   /: codeNewSession\(projectId \|\| CODE\.projectId\)/.test(attach));
ok('a finished turn joins its session', /sess\.turns = \[\.\.\.sess\.turns\.filter\(\(x\) => x\.id !== t\.id\), t\]/.test(attach));
ok('only the tab that started or messaged it carries its messages on', /ev\.k === "end" && t\.mine\) codeCarry\(t\)/.test(attach));
const startTurn = lift('codeStartTurn');
ok('a follow-up sends the session', /if \(followup\) base\.session = codeSessionBody\(sess, codeEngineId\(\)\)/.test(startTurn));
ok('a message goes to /message, not /tasks', /codePost\(`\/tasks\/\$\{t\.id\}\/message`/.test(lift('codeMessage')));
const carry = lift('codeCarry');
ok('unsent messages are always a draft', /draft\(unsent\)/.test(carry));
ok('held ones auto-send only here, not after a Halt, not while the queue runs',
   /r\.outcome !== "cancelled" && !t\.halting && here\(\)\s*&& !QUEUES\.code\.running/.test(carry));

console.log('\nSync: one row per turn, nothing mid-task');
const end = lift('codeSyncTaskEnd');
ok('the row carries sid, turn and the engine', /sid: String\(/.test(end) && /turn: \+t\.turn \|\| 1/.test(end) && /eng: String\(/.test(end));
ok('nothing is written while a task runs', /if \(codeBusy\(\)\) \{ CODE_SYNC\.held = true; return; \}/.test(lift('codeFlush')));
ok('expiry is per session in the flush', /codeExpired\(r, latest\.get\(codeSessKey\(r\)\)\)/.test(lift('codeFlush')));
const del = lift('codeDeleteTask');
ok('delete removes every turn\'s body', /for \(const id of ids\)[\s\S]{0,80}deleteDoc\(_codeTaskDoc\(id\)\)/.test(del));
ok('marks are keyed by session', /const codePinned = \(r\) => CODE_PINS\.has\(codeSessKey\(r\)\)/.test(MAGI));

// ── queued messages: edit, remove, delivered (live steering, 2026-10-09) ─
console.log('\nA queued message, from the stream');
const MS = new Function(lift('codeMsgState') + '\nreturn codeMsgState;')();
const evs = [
  { k: 'user', id: 'm1', text: 'use pytest', how: 'queued' },
  { k: 'user', id: 'm2', text: 'and docs', how: 'queued' },
  { k: 'msg_edit', id: 'm1', text: 'use pytest, not unittest' },
  { k: 'msg_drop', id: 'm2' },
  { k: 'msg_sent', ids: ['m1'], how: 'live' },
];
let ms = MS(evs, 'm1');
ok('an edit is the text shown', ms.text === 'use pytest, not unittest');
ok('delivered: no longer the person\'s to change', ms.sent === 'live' && !ms.dropped);
ms = MS(evs, 'm2');
ok('a removed one is dropped, never sent', ms.dropped && !ms.sent);
ms = MS(evs.slice(0, 2), 'm1');
ok('before delivery it is still queued', ms.sent === '' && ms.text === null);
ok('an old engine\'s message (no id) is never open', MS(evs, undefined).sent === '' && MS(evs, '').text === null);
const bub = lift('codeUserBubble');
ok('the bubble offers Edit and remove only while open',
   /if \(!open\) \{[\s\S]{0,120}return b;\s*\}[\s\S]*"✕"[\s\S]*"Edit"/.test(bub));
ok('an edit in progress survives a redraw (draft and caret on the task)',
   /t\.editing && t\.editing\.id === ev\.id/.test(bub) && /ed\.draft = ta\.value/.test(bub));
ok('Interrupt now only on an engine that steers live', /codeEngineHas\("steer_live"\)[\s\S]{0,80}"Interrupt now"|codeEngineHas\("steer_live"\)[\s\S]*Interrupt now/.test(bub));
ok('a removed message is not drawn', /if \(!codeMsgState\(t\.events, ev\.id\)\.dropped\) log\.append\(codeUserBubble\(t, ev\)\)/.test(MAGI));
ok('a removed message frees its place in the cap', /- t\.events\.filter\(\(e\) => e\.k === "msg_drop"\)\.length/.test(MAGI));
const nb = lift('noteBubble');
ok('a deliberation note is editable only until the chairman has it',
   /live\.notesOpen === false/.test(nb) && /engineHas\("note_edit"\)/.test(nb));
ok('Interrupt now on a note only once, while units still answer',
   /!live\.interrupted && liveStillAnswering\(live\)/.test(nb));

// ── parseVerdict: headings glued to a sentence (F4 step 6) ──────────────
console.log('\nA verdict whose headings lost their line breaks');
const PV = new Function([
  "const SECTION = /^\\s*(?:#{1,4}\\s*)?(ANSWER|NOTES|CONFIDENCE|VERDICT|AGREEMENTS|DISAGREEMENTS|CAVEATS)\\b\\s*:?\\s*$/i;",
  constLine('CONF'), constLine('CONF_LEAD'),
  "const MD = { fence: /^(\\s*)(`{3,}|~{3,})\\s*([\\w+#.-]*)\\s*$/ };",
  // Paragraphs only: what is under test is which bucket each line lands in.
  "function mdParse(t) { return String(t).split(/\\n\\s*\\n/).map((p) => p.trim()).filter(Boolean).map((p) => ({ kind: 'p', text: p.replace(/\\n/g, ' ') })); }",
  lift('parseVerdict'), 'return parseVerdict;'].join('\n'))();
const gv = PV("ANSWER\nIt is named after Miranda, and the ship is the *Dream*.NOTES None.CONFIDENCE HIGH -- well documented.");
ok('the answer ends at its own sentence', gv.main.length === 1 && /\*Dream\*\.$/.test(gv.main[0].text), JSON.stringify(gv.main));
ok('"None." notes are dropped as noise', gv.notes.length === 0, JSON.stringify(gv.notes));
ok('the confidence is read as a rating', gv.conf.length === 1 && gv.conf[0].level === 'HIGH', JSON.stringify(gv.conf));
const prose = PV('Keep notes. NOTES-style headers are fine.');
ok('prose mentioning NOTES is left alone', prose.main.length === 1 && prose.notes.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
