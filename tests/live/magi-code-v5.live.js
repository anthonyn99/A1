// LIVE test -- Track V5: a browser unit's edits are checked by MAGI and a
// failure goes back to it. On the REAL engine, a SCRATCH repository.
// Run: node tests/live/magi-code-v5.live.js     (not run by run-all.js)
//
// The project's add() is wrong and its check tests add AND mul. The task
// only asks for mul -- so the first edit fails the check, and the unit must
// fix add from the check's output. UNIT=deepseek by default.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'http://127.0.0.1:8000/api/code';
const UNIT = process.env.UNIT || 'deepseek';
const PY = path.resolve(__dirname, '..', '..', 'magi', '.venv', 'Scripts', 'python.exe');
let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 300) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 600) + ']' : '')); }
};
const api = async (p, body, method) => {
  const r = await fetch(API + p, { method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const DIR = path.join(os.tmpdir(), 'magi-sandbox', 'v5-calc');

async function run(body, onEvent, ms = 900000) {
  const r = await api('/tasks', body);
  if (!r.ok) return { refused: r, events: [], result: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const events = [];
  try {
    const s = await fetch(`${API}/tasks/${r.task.id}/stream`, { signal: ctl.signal });
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
        if (onEvent) await onEvent(ev, r.task, events);
        if (ev.k === 'end') return { task: r.task, events, result: ev.result };
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { clearTimeout(timer); }
  return { task: r.task, events, result: null };
}

(async () => {
  let PID = null;
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    git(DIR, 'init', '-q'); git(DIR, 'config', 'user.name', 'x'); git(DIR, 'config', 'user.email', 'x@x');
    git(DIR, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(DIR, 'calc.py'), 'def add(a, b):\n    return a - b\n');
    fs.writeFileSync(path.join(DIR, 'check.py'),
      'import calc\nok = True\nif calc.add(2, 3) != 5:\n    print("FAIL: add(2, 3) returned", calc.add(2, 3), "expected 5"); ok = False\n'
      + 'if not hasattr(calc, "mul") or calc.mul(4, 5) != 20:\n    print("FAIL: mul(4, 5) should be 20"); ok = False\n'
      + 'print("all good" if ok else "check failed")\nraise SystemExit(0 if ok else 1)\n');
    git(DIR, 'add', '-A'); git(DIR, 'commit', '-qm', 'init');
    const p = await api('/projects', { name: 'v5-calc', root: DIR });
    PID = p.project.id;
    const ck = await api(`/projects/${PID}/check`, { command: `"${PY}" check.py`, auto: false, timeout_min: 2, agents: true });
    ok('the check is set, agents may run it', ck.ok && ck.check && ck.check.agents === true, ck.message);

    let card = null;
    const x = await run({ project_id: PID, mode: 'write', agents: [UNIT],
      prompt: 'Add a function mul(a, b) to calc.py that returns a times b.' },
    async (ev, task) => { if (ev.k === 'approval') { card = ev; await api(`/tasks/${task.id}/approve`, { approve: true }); } });
    const notes = x.events.filter((e) => e.k === 'note').map((e) => e.text);
    const tools = x.events.filter((e) => e.k === 'tool').map((e) => `${e.name} ${e.target || ''}`);
    console.log('        tools: ' + tools.join(' | '));
    for (const n of notes.filter((t) => /Check|check/.test(t))) console.log('        note: ' + n);
    ok('MAGI ran the check on the unit\'s edits', tools.some((t) => t.startsWith('Run check')));
    // Since Track W a unit can run the check itself (SHELL:) and often fixes
    // the hidden add() bug in its first answer: then there is nothing to send
    // back. Either way the last check must pass; a failure must go back.
    const failedFirst = notes.some((t) => /^Check FAILED/.test(t));
    console.log('        first check: ' + (failedFirst ? 'failed (the loop ran)' : 'passed at once'));
    ok('a failed check went back to the unit',
      !failedFirst || notes.some((t) => /The check failed; sending/.test(t)));
    ok('and the final change passed', notes.filter((t) => /^Check (passed|FAILED)/.test(t)).slice(-1)
      .some((t) => /^Check passed/.test(t)), notes.slice(-3).join(' / '));
    ok('a card came up and was applied', !!card && x.result && x.result.write === 'applied', x.result && (x.result.write || x.result.detail));
    const out = execFileSync(PY, ['check.py'], { cwd: DIR, encoding: 'utf8' }).trim();
    ok('the real folder now passes the check', /all good/.test(out), out);
  } catch (e) {
    fail++; console.log('  FAIL  crashed: ' + (e && e.stack || e));
  } finally {
    if (PID) { await api(`/projects/${PID}/check`, { command: '' }).catch(() => {}); await api(`/projects/${PID}`, null, 'DELETE').catch(() => {}); }
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
