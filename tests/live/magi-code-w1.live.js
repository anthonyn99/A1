// LIVE test -- Track W1: project instructions reach every agent. REAL
// engine, a SCRATCH repository whose CLAUDE.md sets one odd rule.
// Run: node tests/live/magi-code-w1.live.js   AGENTS=deepseek,claude-cli,codex-cli
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'http://127.0.0.1:8000/api/code';
const AGENTS = (process.env.AGENTS || 'deepseek,claude-cli,codex-cli').split(',');
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
const DIR = path.join(os.tmpdir(), 'magi-sandbox', 'w1-rules');

async function run(body, ms = 600000) {
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
        if (ev.k === 'end') return { events, result: ev.result };
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { clearTimeout(timer); }
  return { events, result: null };
}

(async () => {
  let PID = null;
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(DIR, 'docs'), { recursive: true });
    git(DIR, 'init', '-q'); git(DIR, 'config', 'user.name', 'x'); git(DIR, 'config', 'user.email', 'x@x');
    fs.writeFileSync(path.join(DIR, 'CLAUDE.md'),
      '# House rules\n\nEvery reply you give in this project must end with the exact code word given in @docs/codeword.md, on its own line.\n');
    fs.writeFileSync(path.join(DIR, 'docs', 'codeword.md'), 'The code word is MANGO-77.\n');
    fs.writeFileSync(path.join(DIR, 'app.py'), 'def add(a, b):\n    return a + b\n');
    git(DIR, 'add', '-A'); git(DIR, 'commit', '-qm', 'init');
    const p = await api('/projects', { name: 'w1-rules', root: DIR });
    PID = p.project.id;
    for (const agent of AGENTS) {
      console.log(`\n${agent}`);
      const x = await run({ project_id: PID, mode: 'read', agents: [agent], prompt: 'What does app.py do? One sentence.' });
      const tools = x.events.filter((e) => e.k === 'tool').map((e) => `${e.name} ${e.target || ''}`);
      const text = (x.result && x.result.text) || '';
      console.log('        answer: ' + text.replace(/\s+/g, ' ').slice(-160));
      if (x.result && x.result.outcome !== 'ok') console.log('        result: ' + JSON.stringify(x.result).slice(0, 300));
      ok('the transcript names the instructions file', tools.some((t) => /^Instructions CLAUDE\.md/.test(t)), tools.join(' | '));
      ok('it answered', x.result && x.result.outcome === 'ok');
      ok('and followed CLAUDE.md, via its @import', /MANGO-77\s*$/.test(text.trim()), text.slice(-80));
    }
  } catch (e) {
    fail++; console.log('  FAIL  crashed: ' + (e && e.stack || e));
  } finally {
    if (PID) await api(`/projects/${PID}`, null, 'DELETE').catch(() => {});
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
