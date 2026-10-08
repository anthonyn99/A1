// LIVE test -- Track V7: the project map. REAL engine, a SCRATCH project of
// 60 files where the answer is in one the unit is never sent whole.
// Run: node tests/live/magi-code-v7.live.js   (UNIT=deepseek by default)
//
// The question names no file and none of the function's words, so ranking
// cannot attach the right file; the map lists `settle_accounts@<line>` and
// the unit should answer with the path and line (asking for those lines if
// it wants). The engine's Context note and the answer are checked.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'http://127.0.0.1:8000/api/code';
const UNIT = process.env.UNIT || 'deepseek';
let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 400) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 800) + ']' : '')); }
};
const api = async (p, body, method) => {
  const r = await fetch(API + p, { method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const DIR = path.join(os.tmpdir(), 'magi-sandbox', 'v7-map');

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
    fs.mkdirSync(DIR, { recursive: true });
    git(DIR, 'init', '-q'); git(DIR, 'config', 'user.name', 'x'); git(DIR, 'config', 'user.email', 'x@x');
    const filler = (i) => Array.from({ length: 30 }, (_, k) => `def helper_${i}_${k}(x):\n    return x + ${k}\n`).join('\n');
    for (let i = 0; i < 60; i++) {
      const dir = path.join(DIR, 'pkg', `area${i % 6}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `mod${i}.py`), filler(i));
    }
    // The one that matters, deep in the tree, its function well down the file.
    const target = path.join(DIR, 'pkg', 'area4', 'mod34.py');
    const body = filler(34) + '\n\nclass Books:\n    def settle_accounts(self, rows):\n        return sum(rows)\n';
    fs.writeFileSync(target, body);
    const line = body.split('\n').findIndex((l) => l.includes('def settle_accounts')) + 1;
    git(DIR, 'add', '-A'); git(DIR, 'commit', '-qm', 'init');
    const p = await api('/projects', { name: 'v7-map', root: DIR });
    PID = p.project.id;

    const x = await run({ project_id: PID, mode: 'read', agents: [UNIT],
      prompt: 'Which method in this project looks like it does the month-end bookkeeping for the books? Give its file path and line number as path:line, then one sentence on why you think so.' });
    const ctx = x.events.filter((e) => e.k === 'tool').map((e) => `${e.name} ${e.target || ''}`);
    console.log('        tools: ' + ctx.join(' | '));
    const text = (x.result && x.result.text) || '';
    console.log('        answer: ' + text.replace(/\s+/g, ' ').slice(0, 300));
    ok('it answered', x.result && x.result.outcome === 'ok', x.result && (x.result.detail || x.result.outcome));
    ok('with the right file', /pkg[\\/]area4[\\/]mod34\.py/.test(text), text.slice(0, 200));
    ok(`and the right line (${line})`, new RegExp(`\\b${line}\\b`).test(text), text.slice(0, 200));
    ok('and the method name', /settle_accounts/.test(text));
  } catch (e) {
    fail++; console.log('  FAIL  crashed: ' + (e && e.stack || e));
  } finally {
    if (PID) await api(`/projects/${PID}`, null, 'DELETE').catch(() => {});
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
