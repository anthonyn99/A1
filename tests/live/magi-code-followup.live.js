// LIVE test -- Track F, F3: Code Mode follow-ups on the real engine and a
// real CLI agent (not run by run-all.js). Talks to the engine's REST API
// directly: the console side is F4. Run: node tests/live/magi-code-followup.live.js
//
// On a SCRATCH repository in %TEMP% -- never A1:
//   1. resume   turn 1 (read) mentions a fact that is in no file; turn 2 is a
//               follow-up with `session` + `native`: the agent resumes the SAME
//               CLI session (same session id) and answers from it.
//   2. midrun   a read task gets a message at its first tool call: it is
//               "queued", the agent takes it WITHOUT stopping (msg_sent "live",
//               no interrupt, one attempt), and the answer follows it.
//   2b. now     a long essay gets a message and Interrupt now: the turn stops,
//               the message starts the next one in the same run, one attempt.
//   3. denied   a write task's diff is DENIED; the write follow-up (resumed)
//               is told so and must not assume the edit exists: it says NO,
//               and its new diff does not contain the denied line.
//   4. revise   a message at the approval card: accepted "revise", nothing
//               applied, a second card with the revised diff, approved.
// Spends about eight small requests on the chosen agent (Codex by default).
// LIVE_ONLY=resume,midrun,now,unit,denied,revise. (unit: UNIT=grok by default)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'http://127.0.0.1:8000/api/code';
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);
// Codex by default: it is free, and Claude may be under your cap (a capped
// agent gets no requests -- this test must not try to get round that).
// AGENT=claude-cli to run it on Claude.
const AGENT = process.env.AGENT || 'codex-cli';
const AGENTS = [AGENT];
const WHO = AGENT.startsWith('claude') ? 'claude' : 'codex';

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 300) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 400) + ']' : '')); }
};
const api = async (p, body, method) => {
  const r = await fetch(API + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

// Under magi-sandbox: Codex's restricted user cannot read a mkdtemp folder,
// and the same rule is kept for every live test (Hard-won facts, 14).
const REPO = path.join(os.tmpdir(), 'magi-sandbox', 'magi-followup-live');
function makeRepo() {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, 'init', '-q');
  git(REPO, 'config', 'user.name', 'magi-live');
  git(REPO, 'config', 'user.email', 'magi-live@localhost');
  git(REPO, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(REPO, 'README.md'), '# scratch\n\nA tiny project for a live test.\n');
  fs.writeFileSync(path.join(REPO, 'app.py'), 'x = 1\nprint(x)\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-qm', 'init');
}

/** Start a task and follow its stream; onEvent(ev, task) may act. */
async function run(body, onEvent, ms = 420000) {
  const r = await api('/tasks', { agents: AGENTS, ...body });
  if (!r.ok) throw new Error('task refused: ' + JSON.stringify(r));
  const task = r.task;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const events = [];
  try {
    const s = await fetch(`${API}/tasks/${task.id}/stream`, { signal: ctl.signal });
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of s.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        events.push(ev);
        if (onEvent) await onEvent(ev, task, events);
        if (ev.k === 'end') return { task, events, result: ev.result };
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally { clearTimeout(timer); }
  return { task, events, result: null };
}

/** What the console will send as the earlier turns (F4 builds the same). */
const turnOf = (prompt, mode, r, files) => ({
  prompt, mode, text: (r.result && r.result.text) || '', outcome: r.result && r.result.outcome,
  write: (r.result && r.result.write) || '', files: files || (r.result && r.result.files) || [],
  by: r.result && r.result.by_label });

(async () => {
  let PID = null;
  try {
    makeRepo();
    const made = await api('/projects', { name: 'magi-followup-live', root: REPO });
    if (!made.ok) { console.error('could not register the scratch repo', made); process.exit(2); }
    PID = made.project.id;
    const st = await api('/state');
    ok('the engine advertises followup and steer',
      ['followup', 'steer'].every((f) => (st.features || []).includes(f)), (st.features || []).join(','));

    if (want('resume')) {
      console.log(`\n1. A follow-up resumes the same ${WHO} session`);
      const p1 = 'Read README.md and tell me in one sentence what this project is. '
        + 'By the way, my favourite fruit is kiwi.';
      const r1 = await run({ project_id: PID, mode: 'read', prompt: p1 });
      ok('turn 1 finished', r1.result && r1.result.outcome === 'ok', r1.result && r1.result.text);
      const native = (r1.result || {}).native || {};
      ok('turn 1 reports its CLI session', native.agent && native.agent.startsWith(WHO + ':') && !!native.sid, JSON.stringify(native));
      const p2 = 'What did I say my favourite fruit is? Reply with the fruit only.';
      const r2 = await run({ project_id: PID, mode: 'read', prompt: p2,
        session: { id: r1.task.id, turn: 2, turns: [turnOf(p1, 'read', r1)], native } });
      const start = r2.events.find((e) => e.k === 'start') || {};
      ok('turn 2 is turn 2 of the same session', start.session_id === r1.task.id && start.turn === 2,
        `${start.session_id} ${start.turn}`);
      ok('it said it continues its own session',
        r2.events.some((e) => e.k === 'note' && /continues its own session/.test(e.text || '')));
      ok('the same CLI session carried on', ((r2.result || {}).native || {}).sid === native.sid,
        JSON.stringify((r2.result || {}).native));
      ok('it remembered', /kiwi/i.test((r2.result || {}).text || ''), (r2.result || {}).text);
    }

    if (want('midrun')) {
      console.log('\n2. A message mid-run joins the running turn, nothing is stopped');
      let sent = null;
      const r = await run({ project_id: PID, mode: 'read',
        prompt: 'Read README.md, then read app.py, then describe this project in two sentences.' },
      async (ev, task) => {
        if (!sent && ev.k === 'tool') {
          sent = 'pending';
          sent = await api(`/tasks/${task.id}/message`,
            { text: 'Also: end your final answer with the single word PELICAN.' });
        }
      });
      ok('the message was queued, not an interrupt', sent && sent.accepted === 'queued' && sent.id, JSON.stringify(sent));
      ok('every viewer saw it, with its id', r.events.some((e) => e.k === 'user' && e.how === 'queued' && e.id));
      const got = r.events.find((e) => e.k === 'msg_sent');
      ok('the agent took it live', got && got.how === 'live', JSON.stringify(got));
      ok('nothing was interrupted', !r.events.some((e) => e.k === 'interrupt'));
      const attempts = ((r.result || {}).attempts || []).map((a) => a.outcome);
      ok('one attempt', attempts.join(',') === 'ok', attempts.join(','));
      ok('the answer follows the message', /PELICAN/.test((r.result || {}).text || ''), (r.result || {}).text);
      const edit = await api(`/tasks/${r.task.id}/message/${(sent || {}).id}/edit`, { text: 'x' });
      ok('a delivered message can no longer be edited', edit.error === 'delivered' || edit.error === 'no_task', JSON.stringify(edit));
    }

    if (want('now')) {
      console.log('\n2b. Interrupt now stops the turn and the message goes next');
      let sent = null, intr = null;
      const r = await run({ project_id: PID, mode: 'read',
        prompt: 'Without reading any files, write a 600-word essay on why READMEs matter, '
          + 'in six paragraphs.' },
      async (ev, task) => {
        if (!sent && ev.k === 'note' && /is reading the workspace/.test(ev.text || '')) {
          sent = 'pending';
          await new Promise((res) => setTimeout(res, 3000));
          sent = await api(`/tasks/${task.id}/message`,
            { text: 'Stop the essay. Instead reply with exactly one word: PELICAN' });
          intr = await api(`/tasks/${task.id}/interrupt`, {});
        }
      });
      ok('queued, then Interrupt now', sent && sent.accepted === 'queued' && intr && intr.ok, JSON.stringify([sent, intr]));
      ok('the agent said it was interrupting', r.events.some((e) => e.k === 'note' && /Interrupting/.test(e.text || '')));
      const attempts = ((r.result || {}).attempts || []).map((a) => a.outcome);
      ok('one attempt, same process', attempts.join(',') === 'ok', attempts.join(','));
      ok('the answer follows the message', /PELICAN/.test((r.result || {}).text || ''), (r.result || {}).text);
    }

    if (want('unit')) {
      const UNIT = process.env.UNIT || 'grok';
      console.log(`\n2c. Interrupt now on a browser unit (${UNIT}): its reply stops, it is asked again`);
      let sent = null, intr = null;
      const r = await run({ project_id: PID, mode: 'read', agents: [UNIT],
        prompt: 'Without reading any files, write a 600-word essay on why READMEs matter, '
          + 'in six paragraphs.' },
      async (ev, task) => {
        if (!sent && ev.k === 'note' && /^Asking /.test(ev.text || '')) {
          sent = 'pending';
          await new Promise((res) => setTimeout(res, 15000));
          sent = await api(`/tasks/${task.id}/message`,
            { text: 'Stop the essay. Instead reply with exactly one word: PELICAN' });
          intr = await api(`/tasks/${task.id}/interrupt`, {});
        }
      }, 600000);
      ok('queued after its reply, then Interrupt now',
        sent && sent.accepted === 'after_reply' && intr && intr.how === 'browser', JSON.stringify([sent, intr]));
      ok('its reply was stopped', r.events.some((e) => e.k === 'note' && /^Stopped /.test(e.text || '')));
      ok('it was asked again with the message', r.events.some((e) => e.k === 'interrupt'));
      ok('the answer follows the message', /PELICAN/.test((r.result || {}).text || ''), (r.result || {}).text);
    }

    if (want('denied')) {
      console.log('\n3. A write follow-up after a DENIED diff');
      const p1 = 'In app.py, change the first line to x = 2. Nothing else.';
      const r1 = await run({ project_id: PID, mode: 'write', prompt: p1 }, async (ev, task) => {
        if (ev.k === 'approval') await api(`/tasks/${task.id}/approve`, { approve: false });
      });
      ok('turn 1 was denied', (r1.result || {}).write === 'denied', (r1.result || {}).write);
      ok('the folder is unchanged', fs.readFileSync(path.join(REPO, 'app.py'), 'utf8') === 'x = 1\nprint(x)\n');
      const native = (r1.result || {}).native || {};
      let card = null;
      const p2 = 'Before you change anything: does the first line of app.py currently say x = 2? '
        + 'Start your reply with YES or NO. Then add a new last line to app.py: y = 3';
      const r2 = await run({ project_id: PID, mode: 'write', prompt: p2,
        session: { id: r1.task.id, turn: 2, native,
          turns: [turnOf(p1, 'write', r1, ['app.py'])] } },
      async (ev, task) => {
        if (ev.k === 'approval') {
          card = ev;
          await api(`/tasks/${task.id}/approve`, { approve: false });
        }
      });
      const text = ((r2.result || {}).text || '').trim();
      ok('it was resumed', r2.events.some((e) => e.k === 'note' && /continues its own session/.test(e.text || '')));
      // Any of its messages may be the answer: Codex sometimes says what it
      // is about to do first ("I'll read app.py's first line, then…"), and
      // the result joins every message (2026-09-30).
      ok('it knows the denied edit is not there (NO)', /(^|\n)\W*NO\b/i.test(text), text.slice(0, 300));
      ok('its diff is app.py only', card && card.files.length === 1 && card.files[0].path === 'app.py',
        card && JSON.stringify(card.files.map((f) => f.path)));
      ok('and it did not re-add the denied line on the way', card && !card.files.some((f) =>
        /^\+\s*x = 2\s*$/m.test(f.diff || f.patch || '')), card && JSON.stringify(card.files[0]).slice(0, 300));
      ok('the folder is still unchanged', fs.readFileSync(path.join(REPO, 'app.py'), 'utf8') === 'x = 1\nprint(x)\n');
    }

    if (want('revise')) {
      console.log('\n4. A message at the approval card revises the diff');
      const cards = [];
      let answer = null;
      const r = await run({ project_id: PID, mode: 'write',
        prompt: 'Create a file hello.txt whose whole content is the word hi.' },
      async (ev, task) => {
        if (ev.k !== 'approval') return;
        cards.push(ev);
        if (cards.length === 1) {
          ok('nothing applied at the first card', !fs.existsSync(path.join(REPO, 'hello.txt')));
          answer = await api(`/tasks/${task.id}/message`,
            { text: 'Make the content the word hello instead of hi.' });
        } else {
          await api(`/tasks/${task.id}/approve`, { approve: true });
        }
      });
      ok('the message was a revision', answer && answer.accepted === 'revise', JSON.stringify(answer));
      const why = r.events.filter((e) => e.k === 'decision').map((e) => e.why);
      ok('decisions: revised, then approved', why.join(',') === 'revised,approved', why.join(','));
      ok('a second card came', cards.length === 2, cards.length);
      const hello = fs.existsSync(path.join(REPO, 'hello.txt'))
        ? fs.readFileSync(path.join(REPO, 'hello.txt'), 'utf8').trim() : null;
      ok('the revised file was applied', /^hello$/i.test(hello || ''), hello);
      ok('the task ended applied', (r.result || {}).write === 'applied', (r.result || {}).write);
    }
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e && e.stack || e));
  } finally {
    if (PID) await api(`/projects/${PID}`, null, 'DELETE').catch(() => {});
    try { fs.rmSync(REPO, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
