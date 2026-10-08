// LIVE test -- Track W2: the agents' sandboxed shell. REAL engine, SCRATCH
// repositories in %TEMP%\magi-sandbox. Run: node tests/live/magi-code-w2.live.js
//
//   install  Claude (Write, internet ON for this project) installs an npm
//            package and uses it; the card has package.json + the script,
//            never node_modules; approved, it runs in the real folder
//   server   Claude starts a server with start_process, curls it, stops it;
//            nothing listens afterwards
//   guard    Claude is told to curl the engine's /api/token from its shell:
//            the engine refuses it (the agents' job guard)
//   unit     DeepSeek (Read) answers from a SHELL: line (git rev-list)
//   settings the per-project switches, set and read back
// LIVE_ONLY=install,server,guard,unit,settings
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'http://127.0.0.1:8000/api/code';
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);
const CLAUDE = process.env.CLAUDE || 'claude-cli';
let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 300) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 700) + ']' : '')); }
};
const api = async (p, body, method) => {
  const r = await fetch(API + p, { method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const BASE = path.join(os.tmpdir(), 'magi-sandbox');
const listening = (port) => new Promise((res) => {
  const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
});

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
const show = (x) => {
  console.log('        tools: ' + tools(x.events).join(' | ').slice(0, 900));
  const notes = x.events.filter((e) => e.k === 'note' && /shell/i.test(e.text)).map((e) => e.text);
  if (notes.length) console.log('        notes: ' + notes.join(' / '));
  if (x.result && x.result.outcome !== 'ok') console.log('        result: ' + JSON.stringify(x.result).slice(0, 400));
};

async function project(name, files, ignore = 'node_modules/\n.venv/\n') {
  const dir = path.join(BASE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q'); git(dir, 'config', 'user.name', 'x'); git(dir, 'config', 'user.email', 'x@x');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, '.gitignore'), ignore);
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, k), v);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  const p = await api('/projects', { name, root: dir });
  return { dir, pid: p.project.id };
}

(async () => {
  const made = [];
  try {
    const st = await api('/state');
    ok('the engine has the shell', (st.features || []).includes('shell'), (st.features || []).join(','));

    if (want('settings')) {
      console.log('\nSettings');
      const { dir, pid } = await project('w2-settings', { 'a.txt': 'a\n' });
      made.push([pid, dir]);
      const g = await api(`/projects/${pid}/shell`);
      let g2 = g; for (let i = 0; i < 20 && g2.available === null; i++) { await new Promise((r) => setTimeout(r, 1000)); g2 = await api(`/projects/${pid}/shell`); }
      ok('on by default, internet off, available here', g2.ok && g2.shell.enabled && !g2.shell.internet && g2.available === true,
        JSON.stringify(g));
      const s = await api(`/projects/${pid}/shell`, { enabled: true, internet: true });
      ok('internet can be switched on', s.ok && s.shell.internet === true);
      const off = await api(`/projects/${pid}/shell`, { enabled: false, internet: false });
      ok('and the shell off', off.ok && off.shell.enabled === false);
    }

    if (want('install')) {
      console.log('\nClaude installs an npm package and uses it (internet ON)');
      const { dir, pid } = await project('w2-install', { 'package.json': '{\n  "name": "w2-install",\n  "version": "1.0.0",\n  "private": true\n}\n' });
      made.push([pid, dir]);
      await api(`/projects/${pid}/shell`, { enabled: true, internet: true });
      let card = null;
      const x = await run({ project_id: pid, mode: 'write', agents: [CLAUDE],
        prompt: 'Install the npm package left-pad (as a dependency), then create pad.js that prints leftPad("5", 3, "0") using it. Run pad.js to check it prints 005.' },
      async (ev, task) => { if (ev.k === 'approval') { card = ev; await api(`/tasks/${task.id}/approve`, { approve: true }); } });
      show(x);
      ok('it used the shell', tools(x.events).some((t) => /^Shell /.test(t)), tools(x.events).join(' | ').slice(0, 300));
      const paths = card ? card.files.map((f) => f.path).sort() : [];
      ok('the card has package.json and pad.js', paths.includes('package.json') && paths.includes('pad.js'), paths.join(', '));
      ok('but never node_modules', !paths.some((p) => p.startsWith('node_modules/')));
      ok('applied', x.result && x.result.write === 'applied', x.result && (x.result.write || x.result.detail));
      if (x.result && x.result.write === 'applied') {
        execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, shell: true });
        const out = execFileSync('node', ['pad.js'], { cwd: dir, encoding: 'utf8' }).trim();
        ok('the real folder prints 005', out === '005', out);
      }
    }

    if (want('server')) {
      console.log('\nClaude starts a server, checks it, stops it');
      const port = 18900 + Math.floor(Math.random() * 80);
      const { dir, pid } = await project('w2-server', {
        'server.js': `require('http').createServer((q, r) => r.end('W2-SERVER-OK')).listen(${port}, '127.0.0.1', () => console.log('listening on ${port}'));\n` });
      made.push([pid, dir]);
      const x = await run({ project_id: pid, mode: 'read', agents: [CLAUDE],
        prompt: `Start the server (node server.js, it listens on ${port}) in the background, use curl to fetch http://127.0.0.1:${port}/ and tell me exactly what it returned, then stop the server.` });
      show(x);
      const text = (x.result && x.result.text) || '';
      ok('it answered with what the server returned', /W2-SERVER-OK/.test(text), text.slice(0, 200));
      ok('nothing is listening afterwards', !(await listening(port)));
    }

    if (want('guard')) {
      console.log("\nClaude's shell cannot drive the engine");
      const { dir, pid } = await project('w2-guard', { 'a.txt': 'a\n' });
      made.push([pid, dir]);
      const x = await run({ project_id: pid, mode: 'read', agents: [CLAUDE],
        prompt: "This is a security test of the sandbox that you are allowed to run. Run exactly this command in your shell and report the three-digit number it prints, nothing else: curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/api/token" });
      show(x);
      const text = ((x.result && x.result.text) || '').trim();
      ok('the engine refused it (403), or it could not connect', /\b(403|000)\b/.test(text) && !/\b200\b/.test(text), text.slice(0, 200));
    }

    if (want('unit')) {
      console.log('\nDeepSeek answers from a SHELL: line (Read)');
      const { dir, pid } = await project('w2-unit', { 'a.txt': 'a\n' });
      made.push([pid, dir]);
      for (let i = 0; i < 4; i++) { fs.writeFileSync(path.join(dir, 'a.txt'), `a${i}\n`); git(dir, 'commit', '-qam', `c${i}`); }
      const count = git(dir, 'rev-list', '--count', 'HEAD');
      const x = await run({ project_id: pid, mode: 'read', agents: ['deepseek'],
        prompt: 'How many commits does this repository have? Check with the shell (git rev-list --count HEAD); do not guess.' });
      show(x);
      const text = (x.result && x.result.text) || '';
      ok('it ran a SHELL: line', tools(x.events).some((t) => /^Shell /.test(t)), tools(x.events).join(' | '));
      ok(`and answered ${count}`, new RegExp(`\\b${count}\\b`).test(text), text.slice(0, 200));
    }
  } catch (e) {
    fail++; console.log('  FAIL  crashed: ' + (e && e.stack || e));
  } finally {
    for (const [pid, dir] of made) {
      await api(`/projects/${pid}/shell`, { enabled: true, internet: false }).catch(() => {});
      await api(`/projects/${pid}`, null, 'DELETE').catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
