// Minimal CDP driver — recreated from .claude/skills/verify/SKILL.md
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = 9333;
const UDD = path.join(os.tmpdir(), 'magi-cdp-profile');

function req(url, method) {
  return new Promise((res, rej) => {
    const u = new global.URL(url);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET' },
      (resp) => {
        let b = '';
        resp.on('data', (c) => (b += c));
        resp.on('end', () => res(b));
      });
    r.on('error', rej);
    r.end();
  });
}
const get = (url) => req(url, 'GET');

async function portAlive() {
  try { await get(`http://127.0.0.1:${PORT}/json/version`); return true; }
  catch { return false; }
}

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

async function launch() {
  if (await portAlive()) return;
  const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('no Edge/Chrome found');
  const child = spawn(exe, [
    `--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu',
    '--window-size=1440,900', `--user-data-dir=${UDD}`, '--no-first-run',
    '--no-default-browser-check', 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portAlive()) return;
  }
  throw new Error('browser did not come up');
}

async function connect() {
  await launch();
  // Close every stray page first. file:// is ONE origin, so a page left over
  // from an earlier run shares this one's localStorage -- and MAGI reconnects
  // on a backoff timer, so that stale page keeps writing tokens underneath the
  // test. Cost an hour to find; never share the browser with a previous run.
  let list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const pages = list.filter((t) => t.type === 'page');
  // Keep the first, close the rest, then park the keeper on about:blank. Every
  // closed page takes its timers with it, and the keeper gets navigated away
  // before the test starts, which does the same to its own.
  for (const t of pages.slice(1)) {
    try { await get(`http://127.0.0.1:${PORT}/json/close/${t.id}`); } catch {}
  }
  await new Promise((r) => setTimeout(r, 300));
  list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  if (!list.some((t) => t.type === 'page')) {
    // Every page was closed (by an earlier run, or by the loop above leaving
    // none). /json/new is a PUT on current Edge/Chrome, not a GET.
    try { await req(`http://127.0.0.1:${PORT}/json/new?about:blank`, 'PUT'); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  }
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ws, send };
}

async function evalJs(c, expr) {
  // Every eval shares one global scope, so a bare `const x` in two separate
  // calls is a redeclaration SyntaxError. Wrapping gives each its own scope.
  const hasStatements = expr.indexOf(';') >= 0 || expr.indexOf('\n') >= 0;
  const r = await c.send('Runtime.evaluate', {
    expression: hasStatements
      ? `(async () => { ${expr} })()`
      : `(async () => { return (${expr}); })()`,
    returnByValue: true, awaitPromise: true,
  });
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  if (r.result && r.result.result && r.result.result.subtype === 'error') {
    throw new Error(r.result.result.description);
  }
  return r.result ? r.result.result.value : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Screenshots land in the OS temp dir, never in the repo.
const SHOTS = path.join(os.tmpdir(), 'magi-live-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const shotPath = (name) => path.join(SHOTS, name + '.png');

module.exports = { connect, evalJs, sleep, PORT, shotPath, SHOTS };
