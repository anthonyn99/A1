// The ONE MAGI tab (Tony, 2026-11-03: "if MAGI tab is already open, just do it
// in there ... dont keep opening new MAGI tabs"). Runs against the LIVE site
// (two real tabs need the real pages; cdp.js serves only one page from disk),
// so run it after the change has deployed. Every prompt is sent with run:0, so
// nothing ever convenes on a real account: the console only takes it.
//
//   1. A TaskHub-origin ▶ (catdebrief.js openMagi) with a MAGI tab open: no new
//      tab is opened, the open console holds the prompt.
//   2. A second one while the first is still waiting: queued behind it, not
//      overwriting it.
//   3. A launch that has to open a tab (TradeHub is another origin): the new tab
//      hands its prompt to the open console and closes itself; the console
//      stays open (it used to be the one closed).
//   4. With no MAGI tab open, the ▶ opens one.
//
// Run: node tests/live/magi-one-tab.live.js
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const PORT = Number(process.env.CDP_PORT) || 9481;
const ORIGIN = 'https://anthonyn99.github.io';
const MAGI = ORIGIN + '/A1/magi.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (u, m) => new Promise((res, rej) => { const x = new URL(u); const r = http.request({ hostname: x.hostname, port: x.port, path: x.pathname + x.search, method: m || 'GET' }, (s) => { let b = ''; s.on('data', (c) => b += c); s.on('end', () => res(b)); }); r.on('error', rej); r.end(); });
const pages = async () => JSON.parse(await req(`http://127.0.0.1:${PORT}/json/list`)).filter((t) => t.type === 'page');

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const link = (q) => MAGI + '#tb=' + b64u(JSON.stringify({ v: 1, src: 'test', q, units: ['claude'], run: 0, p: 'tony', t: Date.now() + Math.random() }));

async function session(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
  return { ws, send, js, close: () => { try { ws.close(); } catch (e) {} } };
}
async function newPage(url) {
  await req(`http://127.0.0.1:${PORT}/json/new?${url}`, 'PUT');
  await sleep(300);
  const list = await pages();
  return list.find((t) => t.url.startsWith(url.split('#')[0])) || list[0];
}

(async () => {
  const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(fs.existsSync);
  const udd = path.join(os.tmpdir(), 'magi-one-tab-' + PORT);
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) {}
  const child = spawn(exe, [`--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu', '--mute-audio', `--user-data-dir=${udd}`, '--no-first-run', '--disable-popup-blocking', 'about:blank'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) { await sleep(250); try { await pages(); break; } catch (e) {} }

  // The console: a MAGI tab, opened by hand.
  const magiT = await newPage(MAGI);
  const magi = await session(magiT);
  await sleep(6000);
  const hb = await magi.js(`(function(){var r=JSON.parse(localStorage.getItem('a1tab:magi')||'null');return r&&r.id===window.a1TabId;})()`);
  ok('the MAGI tab holds the heartbeat', hb === true);

  // A TaskHub-origin page with catdebrief.js (the ▶'s code).
  const hostT = await newPage(ORIGIN + '/A1/Shared/tni.js');
  const host = await session(hostT);
  await sleep(1000);
  await host.js(`fetch('/A1/Shared/catdebrief.js?'+Date.now()).then(r=>r.text()).then(t=>{(0,eval)(t);return !!window.A1Debrief;})`);
  const before = (await pages()).length;

  console.log('\n1. ▶ with MAGI open: no new tab');
  await host.js(`A1Debrief.openMagi(${JSON.stringify(link('Debrief CPI'))})`);
  await sleep(2500);
  ok('no tab was opened', (await pages()).length === before, (await pages()).map((p) => p.url).join(' | '));
  const got1 = await magi.js(`JSON.stringify({h: HANDOFF && HANDOFF.q, box: (document.getElementById('composer')||{}).value, q: HANDOFF_QUEUE.map(x=>x.q)})`);
  ok('the open console took the prompt', /Debrief CPI/.test(got1), got1);

  console.log('\n2. A second one');
  // Make the console look busy so the first is still waiting when the second lands.
  await magi.js(`S.running = true; 1`);
  await host.js(`A1Debrief.openMagi(${JSON.stringify(link('Debrief NVDA'))})`);
  await sleep(2000);
  await host.js(`A1Debrief.openMagi(${JSON.stringify(link('Debrief MU'))})`);
  await sleep(2000);
  const got2 = JSON.parse(await magi.js(`JSON.stringify({h: HANDOFF && HANDOFF.q, q: HANDOFF_QUEUE.map(x=>x.q), err: (document.getElementById('refineError')||{}).textContent})`));
  ok('still no new tab', (await pages()).length === before);
  ok('queued in order behind the waiting one, nothing overwritten', [got2.h].concat(got2.q).join(',') === 'Debrief CPI,Debrief NVDA,Debrief MU', JSON.stringify(got2));
  ok('MAGI shows they are queued', /queued/.test(got2.err || ''), got2.err);

  console.log('\n3. A launch that has to open a tab (TradeHub, another origin)');
  await host.js(`window.open(${JSON.stringify(link('Morning report'))}, '_blank'); 1`);
  let peak = before, peakUrls = '';
  for (let i = 0; i < 24; i++) { await sleep(500); const l = await pages(); if (l.length > peak) { peak = l.length; peakUrls = l.map((p) => p.url.slice(0, 60)).join(' | '); } }
  const after = await pages();
  ok('the new tab opened…', peak === before + 1, before + ' -> ' + peak + ': ' + peakUrls);
  ok('…handed over and closed itself', after.length === before, after.map((p) => p.url).join(' | '));
  ok('the console that was open is still open', after.some((p) => p.id === magiT.id));
  const got3 = JSON.parse(await magi.js(`JSON.stringify({h: HANDOFF && HANDOFF.q, q: HANDOFF_QUEUE.map(x=>x.q)})`));
  ok('…and queued the report behind the others', [got3.h].concat(got3.q).join(',') === 'Debrief CPI,Debrief NVDA,Debrief MU,Morning report', JSON.stringify(got3));
  await magi.js(`S.running = false; 1`);

  console.log('\n4. No MAGI tab open: the ▶ opens one');
  magi.close();
  await req(`http://127.0.0.1:${PORT}/json/close/${magiT.id}`);
  await sleep(1500);
  await host.js(`localStorage.removeItem('a1tab:magi'); 1`);
  const n0 = (await pages()).length;
  const r4 = await host.js(`A1Debrief.openMagi(${JSON.stringify(link('Fresh one'))})`);
  await sleep(4000);
  ok('it opened a MAGI tab', r4 === true && (await pages()).length === n0 + 1 && (await pages()).some((p) => /magi\.html/.test(p.url)), (await pages()).map((p) => p.url).join(' | '));

  host.close();
  try { await req(`http://127.0.0.1:${PORT}/json/version`); } catch (e) {}
  try { process.kill(-child.pid); } catch (e) { try { child.kill(); } catch (e2) {} }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
