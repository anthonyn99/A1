// Minimal CDP driver (per .claude/skills/verify). Reused by the StudyOS checks.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9344;

async function portAlive() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

// Both Edge install locations, then Chrome. Whichever exists first wins — a
// hardcoded path works on exactly one machine.
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowser() {
  return BROWSERS.find(p => existsSync(p)) || null;
}

export async function launch() {
  if (await portAlive()) return null;
  const exe = findBrowser();
  if (!exe) {
    const e = new Error('no Edge or Chrome found — skipping browser verification');
    e.code = 'NO_BROWSER';
    throw e;
  }
  const dir = mkdtempSync(join(tmpdir(), 'sos-cdp-'));
  const p = spawn(exe, [
    `--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu',
    '--window-size=1440,900', `--user-data-dir=${dir}`, '--no-first-run',
    '--allow-file-access-from-files', 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  p.unref();
  for (let i = 0; i < 60; i++) {
    if (await portAlive()) return p;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('browser did not expose the debugging port');
}

export async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)); } }, 30000);
  });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  return { send, evalJs, events, close: () => ws.close() };
}
