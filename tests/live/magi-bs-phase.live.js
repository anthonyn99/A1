// LIVE test -- the real console against the real engine (not run by run-all.js).
// Run: node tests/live/magi-bs-phase.live.js   Screenshots: %TEMP%/magi-live-shots
//
// MAGI Phase S3: Brainstorm's step line. One REAL round on three units
// (UNITS=chatgpt,deepseek,claude-pro by default -- a short topic, ~1-2 min):
//   1. the line goes council -> critique -> merging, in that order, and never
//      jumps to "Merging" while the members are still at work (bug b)
//   2. a reload during critique or merge comes back on THAT step (init replays
//      it), at 390px, not on "thinking independently"
//   3. the round lands; the session is deleted afterwards
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = require('./cdp.js').PAGES_URL;
const UNITS = (process.env.UNITS || 'chatgpt,deepseek,claude-pro').split(',');
const STUB = `(()=>{if(window.top!==window)return;const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;
// Records every phase the console shows, from the moment the page loads.
const SAMPLER = 'window.__ph=window.__ph||[]; if(!window.__phT){window.__phT=setInterval(()=>{const p=(S.bs||{}).phase; if(p&&window.__ph[window.__ph.length-1]!==p) window.__ph.push(p);},100);} return 1;';

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); }
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(250);
  }
  return false;
};
const size = (c, w, h, phone) => c.send('Emulation.setDeviceMetricsOverride',
  { width: w, height: h, deviceScaleFactor: phone ? 2 : 1, mobile: phone });

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  // Any engine request that fails is printed with the browser's reason.
  await c.send('Network.enable');
  const reqs = {};
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('127.0.0.1')) reqs[m.params.requestId] = m.params.request.method + ' ' + m.params.request.url;
    if (m.method === 'Network.loadingFailed' && reqs[m.params.requestId] && !/stream/.test(reqs[m.params.requestId]))
      console.log('  net   ' + reqs[m.params.requestId] + ' -> ' + m.params.errorText + ' ' + JSON.stringify(m.params.corsErrorStatus || m.params.blockedReason || ''));
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await size(c, 1440, 900, false);
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 30000));
  await evalJs(c, SAMPLER);

  const started = Date.now();
  await evalJs(c, `S.selected = new Set(${JSON.stringify(UNITS)}); startBrainstorm("Name one quick, cheap way to keep houseplants alive while away for a week. Keep it short."); return 1;`);
  ok('the round starts on "thinking independently"',
    await waitFor(c, '/thinking about the plan independently/.test((document.querySelector(".bs-phase")||{}).textContent||"")', 10000));
  await shot(c, 'bs-phase-council');

  const critique = await waitFor(c, 'S.bs.phase === "critique"', 6 * 60000);
  ok('critique is shown', critique, `${Math.round((Date.now() - started) / 1000)}s`);
  await sleep(300); // let the 100 ms sampler record it
  const before = await evalJs(c, 'JSON.stringify(window.__ph)');
  ok('council came before critique, nothing in between', before === '["council","critique"]' || before === '["idle","council","critique"]', before);
  ok('the line reads "reviewing each other"', await evalJs(c, '/reviewing each other/.test((document.querySelector(".bs-phase")||{}).textContent||"")'));
  await shot(c, 'bs-phase-critique');
  const sid = await evalJs(c, 'S.bs.sessionId');

  // Reload mid-step, at phone width.
  await size(c, 390, 844, true);
  const phaseAtReload = await evalJs(c, 'S.bs.phase');
  await c.send('Page.navigate', { url: URL });
  ok('back online after reload', await waitFor(c, 'online()', 30000));
  await evalJs(c, SAMPLER);
  const resumed = await waitFor(c, 'S.bs && S.bs.sessionId && !!S.bs.es', 20000);
  ok('the round is picked back up', resumed);
  // init is the first frame, so within a second or two it must say where the job is.
  const replayed = await waitFor(c, '["critique","merging"].includes(S.bs.phase)', 5000);
  const now = await evalJs(c, 'S.bs.phase');
  ok('after reload it shows the real step, not "council"', replayed, `was ${phaseAtReload}, now ${now}`);
  const grid = await evalJs(c, 'JSON.stringify(S.panels.map(p => p.id).sort())');
  ok('the grid shows the round\'s own units, not every ticked one', grid === JSON.stringify([...UNITS].sort()), grid);
  ok('and their real state, not all STANDBY', await evalJs(c, 'S.panels.some(p => p.state !== "queued")'),
    await evalJs(c, 'S.panels.map(p => p.id + ":" + p.state).join(" ")'));
  await shot(c, 'bs-phase-reloaded-phone');
  ok('the line fits the phone width', await evalJs(c, 'return (()=>{const b=document.querySelector(".bs-phase");if(!b)return false;const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})();'));

  ok('merging is shown', await waitFor(c, 'S.bs.phase === "merging" || (!S.bs.busy && S.bs.phase === "idle")', 6 * 60000));
  const landed = await waitFor(c, '!S.bs.busy', 6 * 60000);
  ok('the round lands', landed && !(await evalJs(c, 'S.bs.error')), await evalJs(c, 'S.bs.error || ""'));
  const after = await evalJs(c, 'JSON.stringify(window.__ph)');
  ok('after the reload: critique/merging then idle, never back to council', !/council/.test(after), after);
  console.log(`  total ${Math.round((Date.now() - started) / 1000)}s`);
  await shot(c, 'bs-phase-done-phone');

  if (sid) {
    const del = await evalJs(c, `return fetch(link.api + "/api/brainstorm/${sid}", authed({ method: "DELETE" })).then(r => r.status);`);
    ok('the test session is deleted', del === 200 || del === 204, del);
  }
  ok('no uncaught exceptions', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
