// LIVE test -- the real console against the real engine (not run by run-all.js).
// Run: node tests/live/magi-model-chip.live.js   Screenshots: %TEMP%/magi-live-shots
//
// MAGI Phase U2: the model chip. One REAL short question on two units
// (UNITS=claude,chatgpt by default, ~30-60s):
//   1. while the run is live, Claude's chip appears from the state events
//      (its label is read before typing), and ChatGPT's once it has answered
//   2. the run reopened from history shows the same chips (stored on answers)
//   3. at 390px the chip stays inside its card
//   4. amber "fell back to X" renders when an answer carries a fallback
//      (set in-page on the loaded run: a real fallback cannot be ordered up)
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = require('./cdp.js').PAGES_URL;
const UNITS = (process.env.UNITS || 'claude,chatgpt').split(',');
const STUB = `(()=>{if(window.top!==window)return;const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;

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
// One line on purpose: evalJs only returns the value of a multi-line
// expression that says `return`.
const CHIP = (id) => `((p) => p && p.dom && p.dom.chip && !p.dom.chip.hidden ? p.dom.chip.textContent : "")(S.panels.find(x => x.id === ${JSON.stringify(id)}))`;

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await size(c, 1440, 900, false);
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 30000));

  // -- 1. live --------------------------------------------------------------
  const started = Date.now();
  await evalJs(c, `runOne({ question: "What is the capital of Australia? One sentence.", units: ${JSON.stringify(UNITS)} }); return 1;`);
  ok('the run starts', await waitFor(c, 'S.running && !!S.runId', 15000));
  if (UNITS.includes('claude')) {
    const early = await waitFor(c, `${CHIP('claude')} !== "" && S.running`, 120000);
    ok("Claude's chip shows while the run is still going", early, await evalJs(c, CHIP('claude')));
  }
  ok('the run finishes', await waitFor(c, '!S.running', 5 * 60000), `${Math.round((Date.now() - started) / 1000)}s`);
  const runId = await evalJs(c, 'S.runId');
  const live = {};
  for (const u of UNITS) live[u] = await evalJs(c, CHIP(u));
  console.log('  chips ' + JSON.stringify(live));
  if (UNITS.includes('claude')) ok('Claude names model + effort', /^[A-Z][a-z]+ \d/.test(live.claude), live.claude);
  if (UNITS.includes('chatgpt')) ok('ChatGPT names its slug', /^gpt-/.test(live.chatgpt), live.chatgpt);
  await shot(c, 'model-chip-live');

  // -- 2. from history ------------------------------------------------------
  await evalJs(c, `openRun(${JSON.stringify(runId)}); return 1;`);
  ok('history loads', await waitFor(c, `S.fromHistory && S.panels.length === ${UNITS.length} && S.panels.every(p => p.dom)`, 15000));
  for (const u of UNITS) {
    const h = await evalJs(c, CHIP(u));
    ok(`history chip for ${u} matches the live one`, !!h && h === live[u], h);
  }

  // -- 4. amber -------------------------------------------------------------
  await evalJs(c, `const p = S.panels[0]; p.model_fallback = "Started on Sonnet 5.5 Medium"; updateNode(p); return 1;`);
  const amber = await evalJs(c, `return (() => { const ch = S.panels[0].dom.chip; return ch.classList.contains("fell-back") + "|" + ch.textContent + "|" + getComputedStyle(ch).color; })()`);
  ok('a fallback renders amber, "fell back to X"', /^true\|fell back to /.test(amber), amber);
  await shot(c, 'model-chip-amber');

  // -- 3. phone ------------------------------------------------------------
  await size(c, 390, 844, true);
  await sleep(400);
  const fits = await evalJs(c, `return S.panels.every(p => { const ch = p.dom.chip; if (ch.hidden) return true;
    const r = ch.getBoundingClientRect(), n = p.dom.node.getBoundingClientRect();
    return r.width > 0 && r.left >= n.left - 1 && r.right <= n.right + 1; })`);
  ok('at 390px every chip stays inside its card', fits);
  ok('no horizontal page scroll at 390px', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'));
  await shot(c, 'model-chip-phone');

  ok('no uncaught exceptions', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
