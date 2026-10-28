// LIVE test -- the real console's Refine button against the real personal-ai
// worker (not run by run-all.js). Sends NO council question.
// Run: node tests/live/magi-refine.live.js   (PROFILES=tony,veda by default;
//      CDP_PORT=9417 if another session may be running live tests)
//
// Checks, per profile:
//   1. with Gemini ticked, Refine goes to personal-ai /prompt/refine with THIS
//      profile's id (so the person's own Notebook Gemini key) -- not the engine
//   2. it lands in the composer in seconds, keeps every number/link/name in
//      the request, and Undo puts the original back
const { connect, evalJs, sleep } = require('./cdp.js');

const URL = require('./cdp.js').PAGES_URL;
const PROFILES = (process.env.PROFILES || 'tony,veda').split(',');
const Q = 'plan a 4 day trip to Kyoto in April for 2 people, budget $3,000, we hate crowds. is the JR pass worth it? see https://www.japan-guide.com/e/e2361.html';
const FACTS = ['4', 'Kyoto', 'April', '2', '3,000', 'JR', 'https://www.japan-guide.com/e/e2361.html'];
const STUB = `(()=>{if(window.top!==window)return;const real=window.fetch;window.__refineCalls=[];window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 if(s.indexOf('refine')>=0)window.__refineCalls.push({url:s,body:o&&typeof o.body==='string'?o.body:'(form)'});
 return real(u,o);};})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); }
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(200);
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
  for (const profile of PROFILES) {
    console.log(`\n${profile}`);
    await c.send('Page.navigate', { url: URL + '?profile=' + profile });
    ok('profile is ' + profile, await waitFor(c, `typeof PROFILE !== 'undefined' && PROFILE.id === '${profile}' && typeof refineText === 'function'`, 30000));
    await waitFor(c, 'S.providers && S.providers.length > 0', 15000);
    const up = await evalJs(c, 'online()');
    console.log('  engine ' + (up ? 'online' : 'offline'));
    const had = await evalJs(c, 'S.selected.has("gemini")');
    await evalJs(c, `(() => { S.selected.add("gemini"); const t = $("composer"); t.value = ${JSON.stringify(Q)}; t.dispatchEvent(new Event("input", { bubbles: true })); updateEnabled(); })()`);
    ok('Refine is offered with Gemini ticked' + (up ? '' : ' and the engine offline'), await evalJs(c, '!$("btnRefine").disabled'));
    const t0 = Date.now();
    await evalJs(c, '$("btnRefine").click()');
    await waitFor(c, 'S.refining', 3000);
    const done = await waitFor(c, '!S.refining', 60000);
    const ms = Date.now() - t0;
    const out = await evalJs(c, '$("composer").value');
    const calls = JSON.parse(await evalJs(c, 'JSON.stringify(window.__refineCalls)'));
    ok('refined in seconds', done && ms < 15000, ms + 'ms');
    ok('went to personal-ai with profile ' + profile, calls.length === 1 && calls[0].url.includes('personal-ai') && JSON.parse(calls[0].body).profile === profile, JSON.stringify(calls).slice(0, 200));
    ok('the composer holds a rewrite', out && out !== Q, out.slice(0, 160));
    const lost = FACTS.filter((f) => !out.toLowerCase().includes(f.toLowerCase()));
    ok('nothing in the request was lost', !lost.length, lost.join('|'));
    ok('no error under the box', !(await evalJs(c, '$("refineError").hidden === false && $("refineError").textContent')));
    await evalJs(c, '$("btnUndo").click()');
    ok('Undo puts the original back', (await evalJs(c, '$("composer").value')) === Q);
    if (!had) await evalJs(c, 'S.selected.delete("gemini"); updateEnabled();');
    await evalJs(c, '(() => { const t = $("composer"); t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); })()');
  }
  ok('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
