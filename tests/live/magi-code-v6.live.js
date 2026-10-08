// LIVE test -- Track V6: named commands agents may run. REAL engine, a
// SCRATCH repository. Run: node tests/live/magi-code-v6.live.js
//
// build.py calls util.slugify(), which does not exist. The task: run the
// project's build command, fix what it reports. Each agent must RUN it
// (DeepSeek with a RUN: line, Claude with run_command), read the error and
// fix util.py; approved, the real folder's build passes.
// AGENTS=deepseek,claude-cli by default (Claude only if it is not capped).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'http://127.0.0.1:8000/api/code';
const AGENTS = (process.env.AGENTS || 'deepseek,claude-cli').split(',');
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

function makeRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q'); git(dir, 'config', 'user.name', 'x'); git(dir, 'config', 'user.email', 'x@x');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'util.py'), 'def shout(s):\n    return s.upper()\n');
  fs.writeFileSync(path.join(dir, 'build.py'),
    'import util\nassert util.slugify("Hello World") == "hello-world", util.slugify("Hello World")\nprint("BUILD OK")\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
}

(async () => {
  const st = await api('/state');
  ok('the engine has commands', (st.features || []).includes('commands'), (st.features || []).join(','));
  for (const agent of AGENTS) {
    const dir = path.join(os.tmpdir(), 'magi-sandbox', `v6-${agent}`);
    let PID = null;
    try {
      console.log(`\n${agent}: run the build, fix what it reports`);
      makeRepo(dir);
      const p = await api('/projects', { name: `v6-${agent}`, root: dir });
      PID = p.project.id;
      const set = await api(`/projects/${PID}/commands`, { commands: [
        { name: 'build', command: `"${PY}" build.py`, arg: false, timeout_min: 2 }] });
      ok('the command is set', set.ok && set.commands.length === 1, set.message);
      const bad = await api(`/projects/${PID}/commands`, { commands: [{ name: 'Bad Name', command: 'x' }] });
      ok('a bad name is refused', bad.ok === false, bad.message);
      let card = null;
      const x = await run({ project_id: PID, mode: 'write', agents: [agent],
        prompt: "First run the project's build command (do not guess) to see what fails, then fix the code so the build passes." },
      async (ev, task) => { if (ev.k === 'approval') { card = ev; await api(`/tasks/${task.id}/approve`, { approve: true }); } });
      const tools = x.events.filter((e) => e.k === 'tool').map((e) => `${e.name} ${e.target || ''}`);
      console.log('        tools: ' + tools.join(' | '));
      if (x.result && x.result.outcome !== 'ok') console.log('        result: ' + JSON.stringify(x.result).slice(0, 400));
      ok('it ran the named command', tools.some((t) => /^Run\b/.test(t) && /build/.test(t)), tools.join(' | '));
      ok('a card came up and was applied', !!card && x.result && x.result.write === 'applied', x.result && (x.result.write || x.result.detail || x.result.outcome));
      let out = '';
      try { out = execFileSync(PY, ['build.py'], { cwd: dir, encoding: 'utf8' }).trim(); } catch (e) { out = String(e.stdout || e.message); }
      ok('the real folder\'s build passes', /BUILD OK/.test(out), out.slice(0, 200));
    } catch (e) {
      fail++; console.log('  FAIL  crashed: ' + (e && e.stack || e));
    } finally {
      if (PID) { await api(`/projects/${PID}/commands`, { commands: [] }).catch(() => {}); await api(`/projects/${PID}`, null, 'DELETE').catch(() => {}); }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
