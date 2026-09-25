// LIVE test -- the real console against the real engine (not run by run-all.js).
// Run: node tests/live/magi-bs-brief.live.js   Screenshots: %TEMP%/magi-live-shots
//
// Brainstorm's Brief / Text switch, on whatever session the engine has open.
// Read-only: nothing is sent to the council.
//   1. the plan renders as a Brief by default, with Brief/Text in its header
//   2. Text swaps it to the plain view IN PLACE -- a draft typed into a
//      question card survives the switch -- and the choice is remembered
//   3. the same at 390px
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = require('./cdp.js').PAGES_URL;
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
    await sleep(300);
  }
  return false;
};

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
    console.log(`\n${tag}`);
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: tag === 'phone' ? 2 : 1, mobile: tag === 'phone' });
    await c.send('Page.navigate', { url: URL }); await sleep(2500);
    await evalJs(c, 'localStorage.removeItem("magi.bs.view"); localStorage.setItem(lsKey("mode"), "deliberate"); return 1;');
    await c.send('Page.navigate', { url: URL });
    ok('engine online', await waitFor(c, 'online()', 25000));
    await evalJs(c, 'setView("brainstorm"); return 1;');
    const has = await waitFor(c, '!!document.querySelector(".bs-plan-view")', 25000);
    ok('a plan is on screen', has);
    if (!has) { await shot(c, `bs-brief-none-${tag}`); continue; }
    ok('it is a Brief by default', await evalJs(c, '!!document.querySelector(".bs-plan-view > .verdict-body.brief")'));
    ok('with Brief/Text in the header', await evalJs(c, 'document.querySelectorAll(".bs-view-seg .br-seg-btn").length >= 2'));
    await evalJs(c, 'document.querySelector(".bs-plan-view").scrollIntoView({block:"start"}); window.scrollBy(0,-120); document.querySelectorAll(".magi, main, .page").forEach(x=>x.scrollTop=Math.max(0,x.scrollTop-120)); return 1;');
    await shot(c, `bs-brief-${tag}`);
    // A draft in a question card must survive the switch.
    const draft = await evalJs(c, 'const t=document.querySelector(".bs-cards textarea, .bs-questions textarea"); if(!t) return "none"; t.value="half-typed answer"; t.dispatchEvent(new Event("input")); return "set";');
    await evalJs(c, 'document.querySelector(\'.bs-view-seg .br-seg-btn[data-view="text"]\').click(); return 1;');
    ok('Text swaps to the plain view', await waitFor(c, '!document.querySelector(".bs-plan-view > .verdict-body.brief") && !!document.querySelector(".bs-plan-view > .verdict-body")', 3000));
    ok('every switch on screen follows', await evalJs(c, '[...document.querySelectorAll(\'.bs-view-seg .br-seg-btn[data-view="text"]\')].every(b=>b.classList.contains("on"))'));
    if (draft === 'set') ok('a half-typed answer survives', await evalJs(c, '(document.querySelector(".bs-cards textarea, .bs-questions textarea")||{}).value === "half-typed answer"'));
    ok('the choice is remembered', await evalJs(c, 'BS_VIEW.get() === "text"'));
    await shot(c, `bs-text-${tag}`);
    ok('the plan fits the width', await evalJs(c, 'return (()=>{const b=document.querySelector(".bs-plan-view");const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})()'));
    await evalJs(c, 'const t=document.querySelector(".bs-cards textarea, .bs-questions textarea"); if(t){t.value="";t.dispatchEvent(new Event("input"));} document.querySelector(\'.bs-view-seg .br-seg-btn[data-view="brief"]\').click(); return 1;');
    ok('and back to Brief', await waitFor(c, '!!document.querySelector(".bs-plan-view > .verdict-body.brief")', 3000));
  }
  ok('no uncaught exceptions', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
