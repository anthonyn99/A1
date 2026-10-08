// LIVE test -- Track W4: what's open. REAL engine, a SCRATCH project in
// %TEMP%\magi-sandbox. Run: node tests/live/magi-code-w4.live.js
//      PORT=8001 for an engine on another port (Veda's); AGENTS=claude-cli,codex-cli,deepseek
//
//   viewer  the file list leaves secrets out; a file opens; a secret, a
//           climb out and a binary are refused
//   select  each agent (Read) is told the open file and ONE selected line
//           among 60 alike -- the prompt names neither -- and answers with
//           that line's token
//   open    no selection: "which file do I have open?" -> its path
// LIVE_ONLY=viewer,select,open
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const API = `http://127.0.0.1:${process.env.PORT || 8000}/api/code`;
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);
const AGENTS = (process.env.AGENTS || 'claude-cli,codex-cli,deepseek').split(',');
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

async function run(body, ms = 900000) {
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
        if (ev.k === 'end') return { task: r.task, events, result: ev.result };
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { clearTimeout(timer); }
  return { task: r.task, events, result: null };
}
const tools = (evs) => evs.filter((e) => e.k === 'tool').map((e) => `${e.name} ${e.target || ''}`);

(async () => {
  const dir = path.join(BASE, 'w4-open');
  let pid = null;
  try {
    const st = await api('/state');
    ok('the engine has the viewer', (st.features || []).includes('editor'), (st.features || []).join(','));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    git(dir, 'init', '-q'); git(dir, 'config', 'user.name', 'x'); git(dir, 'config', 'user.email', 'x@x');
    const toks = [];
    let body = '"""Sixty codes, alike on purpose."""\n\n';
    for (let i = 1; i <= 60; i++) {
      const t = 'tok-' + crypto.randomBytes(4).toString('hex');
      toks.push(t);
      body += `CODE_${String(i).padStart(2, '0')} = "${t}"\n`;
    }
    fs.writeFileSync(path.join(dir, 'src', 'codes.py'), body);
    fs.writeFileSync(path.join(dir, 'src', 'other.py'), 'X = 1\n');
    fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=do-not-show\n');
    fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
    pid = (await api('/projects', { name: 'w4-open', root: dir })).project.id;
    const lineOf = (k) => 2 + k;          // CODE_k sits on line 2 + k

    if (want('viewer')) {
      console.log('\nThe viewer');
      const f = await api(`/projects/${pid}/files`);
      ok('lists the files', f.ok && f.files.includes('src/codes.py') && f.files.includes('src/other.py'), (f.files || []).join(', '));
      ok('but never .env', f.ok && !f.files.includes('.env'));
      const r = await api(`/projects/${pid}/file?path=${encodeURIComponent('src/codes.py')}`);
      ok('opens a file', r.ok && r.lines === 62 && r.text.includes(toks[36]), r.lines);
      for (const bad of ['.env', '../w4-open/.env', '../../outside.txt', 'logo.png', 'C:/Windows/win.ini']) {
        const x = await api(`/projects/${pid}/file?path=${encodeURIComponent(bad)}`);
        ok(`refuses ${bad}`, x.ok === false && !('text' in x), x.message);
      }
      const bad = await api('/tasks', { project_id: pid, prompt: 'x', agents: [AGENTS[0]], open: 'src/codes.py' });
      ok('a malformed open field is refused', bad.ok === false && bad.error === 'open', JSON.stringify(bad));
    }

    if (want('select')) {
      for (const a of AGENTS) {
        const k = 20 + Math.floor(Math.random() * 30);
        console.log(`\n${a}: the selected line (CODE_${k}, line ${lineOf(k)})`);
        const x = await run({ project_id: pid, mode: 'read', agents: [a],
          open: { path: 'src/codes.py', start: lineOf(k), end: lineOf(k) },
          prompt: 'What string is assigned on the line I have selected? Reply with just that string, nothing else.' });
        const text = ((x.result && x.result.text) || '').trim();
        console.log('        tools: ' + tools(x.events).join(' | ').slice(0, 300));
        if (x.refused || (x.result && x.result.outcome !== 'ok')) console.log('        result: ' + JSON.stringify(x.refused || x.result).slice(0, 400));
        ok('the transcript shows Open in editor', tools(x.events).includes(`Open in editor src/codes.py:${lineOf(k)}`));
        ok(`answered ${toks[k - 1]}`, text.includes(toks[k - 1]) && toks.filter((t) => text.includes(t)).length === 1, text.slice(0, 200));
      }
    }

    if (want('open')) {
      const a = AGENTS[AGENTS.length - 1];
      console.log(`\n${a}: no selection, which file is open`);
      const x = await run({ project_id: pid, mode: 'read', agents: [a], open: { path: 'src/other.py' },
        prompt: 'Which file do I have open right now? Reply with just its path.' });
      const text = ((x.result && x.result.text) || '').trim();
      ok('answered src/other.py', /src[\\/]other\.py/.test(text), text.slice(0, 200));
    }
  } catch (e) {
    fail++; console.log('  FAIL  crashed: ' + (e && e.stack || e) + (e && e.cause ? '  CAUSE: ' + (e.cause.stack || e.cause) : ''));
  } finally {
    if (pid) await api(`/projects/${pid}`, null, 'DELETE').catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
