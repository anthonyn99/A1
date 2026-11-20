// The live tests' watchdog (started detached by cdp.js armReaper). A run that is KILLED (a timeout, a
// stopped background task) never runs its exit hook, so its headless browser stayed open with its last
// page polling the REAL workers; on 2026-11-19 that is how Cloudflare account 2 ran out of its 100,000
// requests a day. This outlives the run: once the run's process is gone it kills the browser on the
// run's own port, or, on the shared 9333, closes that browser's pages (their timers go with them).
//
//   node cdp-reaper.js <run pid> <port> <own: 1|0>
'use strict';
const http = require('http');
const { execSync } = require('child_process');
const [parent, port, own] = process.argv.slice(2).map(Number);

const get = (u) => new Promise((res) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b)); }).on('error', () => res(''));
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function browserPids() {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'remote-debugging-port=${port}( |$)' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.ProcessId }`;
  try {
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    return out.split(/\s+/).map(Number).filter((n) => n > 0);
  } catch (e) { return []; }
}

async function reap() {
  if (own) {
    for (const pid of browserPids()) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 10000 }); } catch (e) {}
    }
  } else {
    let list = [];
    try { list = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`)); } catch (e) {}
    for (const t of list) if (t.type === 'page') await get(`http://127.0.0.1:${port}/json/close/${t.id}`);
  }
}

if (!parent || !port) process.exit(2);
setInterval(async () => {
  if (alive(parent)) return;
  await reap();
  process.exit(0);
}, 3000);
