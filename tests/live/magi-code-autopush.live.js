// LIVE test -- auto commit + auto push on by default, no wait (2026-10-08).
// On the REAL engine, a SCRATCH repository whose remote is a local bare
// repository standing in for GitHub (a path remote needs no account).
// Run: node tests/live/magi-code-autopush.live.js   (not run by run-all.js)
//
// A new project must arrive with both switches on and no wait; one approved
// write task must then reach the remote as a `magi:` commit within seconds of
// the task ending, with nothing pressed. UNIT=deepseek by default.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'http://127.0.0.1:8000/api/code';
const UNIT = process.env.UNIT || 'deepseek';
let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 300) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 600) + ']' : '')); }
};
const api = async (p, body, method) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(API + p, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return r.json().catch(() => ({}));
    } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 3000)); }
  }
};
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const BASE = path.join(os.tmpdir(), 'magi-sandbox', 'autopush');
const BARE = path.join(BASE, 'origin.git');
const DIR = path.join(BASE, 'work');

async function run(body, onEvent, ms = 600000) {
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
    fs.rmSync(BASE, { recursive: true, force: true });
    fs.mkdirSync(BASE, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', BARE]);
    fs.mkdirSync(DIR);
    git(DIR, 'init', '-q', '-b', 'main'); git(DIR, 'config', 'user.name', 'x'); git(DIR, 'config', 'user.email', 'x@x');
    git(DIR, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(DIR, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    git(DIR, 'add', '-A'); git(DIR, 'commit', '-qm', 'init');
    git(DIR, 'remote', 'add', 'origin', BARE); git(DIR, 'push', '-q', '-u', 'origin', 'main');

    const p = await api('/projects', { name: 'autopush', root: DIR });
    PID = p.project.id;
    const g0 = await api(`/projects/${PID}/git`);
    ok('a new project arrives with auto commit and push on, no wait',
      g0.auto && g0.auto.commit === true && g0.auto.push === true && g0.auto.window === 0, JSON.stringify(g0.auto));

    let card = null;
    const x = await run({ project_id: PID, mode: 'write', agents: [UNIT],
      prompt: 'Add a function mul(a, b) to calc.py that returns a times b.' },
    async (ev, task) => { if (ev.k === 'approval') { card = ev; await api(`/tasks/${task.id}/approve`, { approve: true }); } });
    const ended = Date.now();
    ok('the change was applied', !!card && x.result && x.result.write === 'applied', x.result && (x.result.write || x.result.detail));
    const auto = x.events.find((e) => e.k === 'autocommit');
    ok('the stream says an auto commit is coming', !!auto, JSON.stringify(auto || {}).slice(0, 200));

    let last = null;
    for (let i = 0; i < 30 && !(last && last.push); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const g = await api(`/projects/${PID}/git`);
      last = g.auto && g.auto.last;
    }
    const secs = ((Date.now() - ended) / 1000).toFixed(1);
    ok('committed and pushed with nothing pressed', last && last.ok && last.push && last.push.ok, JSON.stringify(last || {}).slice(0, 400));
    console.log(`        within ${secs} s of the task ending`);
    const remote = execFileSync('git', ['--git-dir', BARE, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' }).trim();
    ok('the remote has the magi: commit', /^magi: /.test(remote), remote);
    const files = execFileSync('git', ['--git-dir', BARE, 'show', '--name-only', '--format=', 'main'], { encoding: 'utf8' }).trim();
    ok('only the applied file is in it', files === 'calc.py', files);
  } catch (e) {
    fail++; console.log('  FAIL  crashed: ' + (e && e.stack || e));
  } finally {
    if (PID) await api(`/projects/${PID}`, null, 'DELETE').catch(() => {});
    fs.rmSync(BASE, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
