// LIVE test -- Track W3: Problems. REAL engine, SCRATCH projects in
// %TEMP%\magi-sandbox (typescript installed locally by this test).
// Run: node tests/live/magi-code-w3.live.js     AGENT=claude-cli by default
//      PORT=8001 for an engine on another port (Veda's)
//
//   folder  Problems on your real folder: TypeScript runs read-only, finds
//           the one type error at line 2, and writes nothing
//   fix     the agent (Write) is given the list, fixes it; the approval card
//           says the change moved Problems from 1 to 0
//   python  a project with no ruff/pyright: Python's own syntax check finds
//           a broken file
// LIVE_ONLY=folder,fix,python
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const API = `http://127.0.0.1:${process.env.PORT || 8000}/api/code`;
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);
const AGENT = process.env.AGENT || 'claude-cli';
let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 300) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 700) + ']' : '')); }
};
const api = async (p, body, method, again = true) => {
  try {
    const r = await fetch(API + p, { method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return r.json().catch(() => ({}));
  } catch (e) {
    if (again && /ECONNRESET|other side closed/.test(String(e.cause || e))) return api(p, body, method, false);
    throw e;
  }
};
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const BASE = path.join(os.tmpdir(), 'magi-sandbox');
const snapshot = (dir) => {
  const out = {};
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const s = String(f).replace(/\\/g, '/');
    if (s.startsWith('node_modules') || s.startsWith('.git')) continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) out[s] = fs.readFileSync(p, 'utf8');
  }
  return JSON.stringify(out);
};

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
const tools = (evs) => evs.filter((e) => e.k === 'tool').map((e) => `${e.name} ${e.target || ''}`);

async function project(name, files, ignore = 'node_modules/\n') {
  const dir = path.join(BASE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q'); git(dir, 'config', 'user.name', 'x'); git(dir, 'config', 'user.email', 'x@x');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, '.gitignore'), ignore);
  for (const [k, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true });
    fs.writeFileSync(path.join(dir, k), v);
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  const p = await api('/projects', { name, root: dir });
  return { dir, pid: p.project.id };
}

const TS = {
  'package.json': '{\n  "name": "w3-ts",\n  "version": "1.0.0",\n  "private": true\n}\n',
  'tsconfig.json': '{\n  "compilerOptions": { "strict": true, "target": "es2020", "module": "commonjs", "noEmit": true },\n  "include": ["src"]\n}\n',
  'src/total.ts': 'export function total(prices: number[]): number {\n  let sum: number = "0";\n  for (const p of prices) sum += p;\n  return sum;\n}\n',
};

(async () => {
  const made = [];
  try {
    const st = await api('/state');
    ok('the engine has Problems', (st.features || []).includes('problems'), (st.features || []).join(','));
    let ts = null;
    if (want('folder') || want('fix')) {
      ts = await project('w3-ts', TS);
      made.push([ts.pid, ts.dir]);
      execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', 'typescript@5'],
        { cwd: ts.dir, shell: true });
      git(ts.dir, 'add', '-A'); git(ts.dir, 'commit', '-qm', 'typescript');
    }

    if (want('folder')) {
      console.log('\nProblems on the folder (read-only)');
      const before = snapshot(ts.dir);
      const r = await api(`/projects/${ts.pid}/problems?refresh=1`);
      ok('TypeScript ran', r.ok && (r.ran || []).some((x) => x.name === 'TypeScript'), JSON.stringify(r).slice(0, 300));
      const p = (r.problems || [])[0] || {};
      ok('it found the type error at line 2', r.total === 1 && p.file === 'src/total.ts' && p.line === 2 && p.code === 'TS2322',
        JSON.stringify(r.problems));
      ok('nothing was written to the folder', snapshot(ts.dir) === before);
      const c = await api(`/projects/${ts.pid}/problems`);
      ok('the next read is the cached list', c.ok && c.cached === true && c.total === 1);
    }

    if (want('fix')) {
      console.log(`\n${AGENT} fixes it; the card says 1 -> 0`);
      let card = null;
      const x = await run({ project_id: ts.pid, mode: 'write', agents: [AGENT],
        prompt: 'Fix the problem the project reports in src/total.ts. Change nothing else.' },
      async (ev, task) => {
        if (ev.k === 'approval') { card = ev; await api(`/tasks/${task.id}/approve`, { approve: true }); }
      });
      console.log('        tools: ' + tools(x.events).join(' | ').slice(0, 600));
      if (x.refused || (x.result && x.result.outcome !== 'ok')) console.log('        result: ' + JSON.stringify(x.refused || x.result).slice(0, 600));
      const prob = card && card.problems;
      ok('the card has Problems', !!prob, card ? Object.keys(card).join(',') : 'no card');
      ok('moved from 1 to 0, none new', prob && prob.before === 1 && prob.after === 0 && prob.fixed === 1 && !prob.new.length,
        JSON.stringify(prob));
      ok('applied', x.result && x.result.write === 'applied', x.result && (x.result.write || x.result.detail));
      if (x.result && x.result.write === 'applied') {
        const r = await api(`/projects/${ts.pid}/problems?refresh=1`);
        ok('your folder now has no problems', r.ok && r.total === 0, JSON.stringify(r.problems));
      }
    }

    if (want('python')) {
      console.log('\nPython syntax (no ruff/pyright in the project)');
      const py = await project('w3-py', { 'good.py': 'print(1)\n', 'pkg/bad.py': 'def f(:\n    return 1\n' });
      made.push([py.pid, py.dir]);
      const r = await api(`/projects/${py.pid}/problems?refresh=1`);
      const names = (r.ran || []).map((x) => x.name);
      ok('a Python checker ran', r.ok && names.length > 0, JSON.stringify(r).slice(0, 300));
      ok('it found pkg/bad.py line 1', (r.problems || []).some((p) => p.file === 'pkg/bad.py' && p.line === 1),
        JSON.stringify(r.problems));
      ok('and nothing in good.py', !(r.problems || []).some((p) => p.file === 'good.py'));
    }
  } catch (e) {
    fail++; console.log('  FAIL  crashed: ' + (e && e.stack || e) + (e && e.cause ? '  CAUSE: ' + (e.cause.stack || e.cause) : ''));
  } finally {
    for (const [pid, dir] of made) {
      await api(`/projects/${pid}`, null, 'DELETE').catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
