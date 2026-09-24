// LIVE test -- drives the real engine on this PC (not run by run-all.js).
// Run: node tests/live/magi-codex-login.live.js   Screenshots: %TEMP%/magi-live-shots
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
// The Pages console, served from this working copy (cdp.js): since Phase 14 a
// file:// page (Origin "null") is refused by the engine.
const URL = require('./cdp.js').PAGES_URL;
const STUB = `(()=>{const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;
let pass = 0, fail = 0;
const ok = (n, c, d) => { (c ? pass++ : fail++); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d ? '  [' + d + ']' : '')); };
(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send('Page.navigate', { url: URL }); await sleep(5000);
  // Stub only the sign-in: a real device code would start a real login.
  await evalJs(c, `
    window.__polls = 0;
    const realPost = codePost, realGet = codeGet;
    codePost = async (p, b, m) => p.endsWith('/login')
      ? { ok: true, job: { id: 'j1', state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'OSLG-JBDK2', where: 'any device' } }
      : p.startsWith('/login/') ? { ok: true } : realPost(p, b, m);
    codeGet = async (p) => {
      if (p === '/login/j1') { window.__polls++; return { ok: true, job: { id: 'j1', state: window.__polls > 1 ? 'done' : 'waiting', account: 'someone@example.com', url: 'https://auth.openai.com/codex/device', code: 'OSLG-JBDK2' } }; }
      return realGet(p);
    };
    codeLogin('codex', 'codex1'); return 1;`);
  await sleep(800);
  ok('device code shown', (await evalJs(c, 'document.querySelector(".code-login-code") && document.querySelector(".code-login-code").textContent')) === 'OSLG-JBDK2');
  ok('link to OpenAI shown', await evalJs(c, '!!document.querySelector(".code-login-steps a[href^=\\"https://auth.openai.com\\"]")'));
  ok('phishing warning shown', /phishing/.test(await evalJs(c, 'document.querySelector(".code-login").textContent')));
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath('codex-login-phone'), Buffer.from(r.result.data, 'base64'));
  await sleep(5500);
  ok('reports signed in when the slot does', /Signed in as someone@example\.com/.test(await evalJs(c, 'document.querySelector(".code-login") ? document.querySelector(".code-login").textContent : ""')));
  console.log(`${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
