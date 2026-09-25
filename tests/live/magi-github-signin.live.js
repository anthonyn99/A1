// LIVE test -- drives the real engine on this PC (not run by run-all.js).
// Run: node tests/live/magi-github-signin.live.js   Screenshots: %TEMP%/magi-live-shots
//
// Sign in with GitHub and Clone from GitHub, in the real console against the
// real engine. Nothing is signed in and nothing is cloned: the setup screen
// and the repository list are the engine's real answers; the code screen and
// the "signed in" ending are the console's, fed a scripted flow in-page.
//   1. setup    with no client ID, Sign in shows the one-time registration.
//   2. code     a flow in progress shows the code big, copyable, and the link;
//               approval ends on "Signed in as ...".
//   3. clone    Workspaces offers Clone from GitHub; the sheet lists the
//               account's repositories and where it will clone.
//   4. phone    the same sheets at 390px.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = require('./cdp.js').PAGES_URL;
const API = 'http://127.0.0.1:8000/api/code';
const A1_PID = 'proj_60d8f14fbc1c';
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
const closeAll = (c) => evalJs(c, 'document.querySelectorAll(".sheet").forEach(s=>s.remove()); return 1;');
const fits = (c, sel) => evalJs(c, `(()=>{const b=document.querySelector(${JSON.stringify(sel)});if(!b)return false;const r=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth+1;})()`);

(async () => {
  const oauth = await (await fetch(API + '/github/oauth')).json();
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
    await evalJs(c, `localStorage.clear(); sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "code"); localStorage.setItem(lsKey("code.project"), JSON.stringify(${JSON.stringify(A1_PID)})); return 1;`);
    await c.send('Page.navigate', { url: URL });
    ok('engine online', await waitFor(c, 'online()', 25000));
    await waitFor(c, '!!CODE.state', 20000);

    // 1. setup (only when this engine has no client ID yet)
    if (!oauth.configured) {
      await evalJs(c, 'codeGhSignIn(); return 1;');
      ok('no client ID: the one-time setup is shown', await waitFor(c, '!!document.querySelector(".gh-steps")', 10000));
      ok('it links to New OAuth App', await evalJs(c, '!!document.querySelector(\'.gh-steps a[href="https://github.com/settings/applications/new"]\')'));
      ok('and fits', await fits(c, '.gh-in'));
      await shot(c, `gh-signin-setup-${tag}`);
      await closeAll(c);
    }

    // 2. the code screen, fed a scripted flow in the page
    await evalJs(c, `window.__realPost = codePost; window.__realGet = codeGet; let n = 0;
      codePost = async (p, b, m) => p === "/github/device/start" ? { ok: true, flow: { id: "f1", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", state: "pending" } }
        : m === "DELETE" ? { ok: true } : window.__realPost(p, b, m);
      codeGet = async (p) => p === "/github/device/f1" ? (++n < 3 ? { ok: true, flow: { id: "f1", user_code: "WDJB-MJHT", state: "pending" } } : { ok: true, flow: { id: "f1", state: "done", account: "veda-test" } }) : window.__realGet(p);
      codeGhSignIn(); return 1;`);
    ok('the code is shown big', await waitFor(c, '(document.querySelector(".gh-code")||{}).textContent === "WDJB-MJHT"', 8000));
    ok('with the github.com/login/device link', await evalJs(c, 'document.querySelector(".gh-open").href === "https://github.com/login/device"'));
    ok('and fits', await fits(c, '.gh-in'));
    await shot(c, `gh-signin-code-${tag}`);
    ok('approval ends on "Signed in as"', await waitFor(c, '/Signed in as veda-test/.test((document.querySelector(".gh-in .sheet-ok")||{}).textContent||"")', 12000));
    await shot(c, `gh-signin-done-${tag}`);
    await evalJs(c, 'codePost = window.__realPost; codeGet = window.__realGet; return 1;');
    await closeAll(c);

    // 3. clone
    await evalJs(c, 'openCodeProjects(); return 1;');
    ok('Workspaces offers Clone from GitHub', await waitFor(c, '[...document.querySelectorAll(".sheet .btn")].some(b=>b.textContent==="Clone from GitHub")', 5000));
    await evalJs(c, '[...document.querySelectorAll(".sheet .btn")].find(b=>b.textContent==="Clone from GitHub").click(); return 1;');
    const accts = ((await (await fetch(API + '/github/accounts')).json()).accounts || []).filter((a) => a.stored);
    if (accts.length) {
      ok('the clone sheet lists repositories', await waitFor(c, 'document.querySelectorAll(".gh-clone-row").length > 0', 20000));
      ok('Clone waits for a pick', await evalJs(c, '[...document.querySelectorAll(".gh-clone .btn")].find(b=>b.textContent==="Clone").disabled'));
      await evalJs(c, 'document.querySelector(".gh-clone-row").click(); return 1;');
      ok('picking one shows where it goes', await waitFor(c, '/\\\\|\\//.test((document.querySelector(".gh-clone-path")||{}).textContent||"")', 3000),
        await evalJs(c, '(document.querySelector(".gh-clone-path")||{}).textContent'));
      ok('and fits', await fits(c, '.gh-clone'));
      await shot(c, `gh-clone-${tag}`);
    } else {
      ok('with no account, Clone leads to Sign in', await waitFor(c, '!!document.querySelector(".gh-in")', 8000));
    }
    await closeAll(c);
  }
  ok('no uncaught exceptions', !errs.length, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
