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
    } else if (msg.method === 'Fetch.requestPaused') {
      // See BRIDGE GUARD below: refuse, never forward.
      send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'ConnectionRefused' }).catch(() => {});
      events.push(msg);
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

  // BRIDGE GUARD. The StudyOS pipeline talks to the local browser bridge on
  // 127.0.0.1:8781, and every request that reaches it drives the REAL Claude /
  // NotebookLM accounts and spends Veda's quota. MEASURED 2026-09-28: with the
  // bridge running, verify-study's explain-it-back check sent a real grading
  // job — a paid Claude message spent by a test. So no test browser may reach
  // that port, ever: requests to it fail at the network layer. Suites that
  // exercise the pipeline stub window.fetch in-page, which never gets here.
  await send('Fetch.enable', { patterns: [
    { urlPattern: '*://127.0.0.1:8781/*' }, { urlPattern: '*://localhost:8781/*' },
  ] });

  // The one-time card cleanup (migrate-cards-v2) opens a modal a few seconds
  // after boot; a suite's fixture classes must not trigger it mid-test.
  // A suite that tests the migration calls it directly.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__sosNoCardMigration = true;' }).catch(() => {});

  return { send, evalJs, events, close: () => ws.close() };
}
