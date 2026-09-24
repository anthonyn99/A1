// LIVE test -- drives the real engine on this PC (not run by run-all.js).
// Run: node tests/live/magi-repo.live.js       Screenshots: %TEMP%/magi-live-shots
//
// Phase 11 end to end against the REAL A1 repository, read-only, as the
// account A1 is linked to (a Contents: Read-only token):
//   1. panel     the Repository pill opens the panel; every tab fills from
//                GitHub (overview, branches, commits, PRs, issues, Actions,
//                releases); a run opens to its jobs; asking twice is free
//                (GitHub answers 304, the hourly count does not move).
//   2. watch     "Watch <sha>" on the overview follows the latest commit's
//                runs to a verdict; then a watch on a commit whose Pages
//                deploy really failed names the job and step, and its Log
//                sheet shows the tail with "Ask the chain to diagnose".
//   3. phone     at 390px the panel is a bottom sheet with scrolling tabs,
//                44px rows, and nothing wider than the screen.
//   4. diagnose  (spends a little Claude usage) Diagnose starts a Read task
//                whose answer names the in-progress deployment.
// LIVE_ONLY=panel,watch,phone,diagnose picks sections (diagnose is opt-in).
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = 'file:///c:/Users/antho/Desktop/A1/magi.html';
const API = 'http://127.0.0.1:8000/api/code';
const A1_PID = 'proj_60d8f14fbc1c';
// A real Pages deploy that failed on 2026-09-21 ("in progress deployment").
const FAILED_SHA = 'ead362536949faf1d60520b1d133e3b8f9b5b08d';
const STUB = `(()=>{const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + d + ']' : '')); }
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(400);
  }
  return false;
};
const api = async (p) => (await fetch(API + p)).json();
const want = (k) => (process.env.LIVE_ONLY ? process.env.LIVE_ONLY.split(',').includes(k) : k !== 'diagnose');
const tab = (c, k) => evalJs(c, `document.querySelector('.repo-tab[data-tab="${k}"]').click(); return 1;`);
const bodyText = (c) => evalJs(c, '(document.querySelector(".repo-body")||{}).textContent || ""');
const loaded = '!document.querySelector(".repo-body .doctor-running")';

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: URL }); await sleep(3000);
  await evalJs(c, `localStorage.clear(); sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "code"); localStorage.setItem(lsKey("code.project"), JSON.stringify(${JSON.stringify(A1_PID)})); return 1;`);
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 25000));
  ok('Code Mode loaded with A1', await waitFor(c, '!!(CODE.state && CODE.agents && codeProject() && CODE.git && CODE.git.data)', 25000));

  try {
    if (want('panel')) {
      console.log('\nThe panel');
      const pill = await evalJs(c, '[...document.querySelectorAll(".code-pill")].find(p=>/Repository/.test(p.textContent)).textContent');
      ok('the pill names the repository', /anthonyn99\/A1/.test(pill), pill);
      await evalJs(c, '[...document.querySelectorAll(".code-pill")].find(p=>/Repository/.test(p.textContent)).click(); return 1;');
      ok('it opens the Repository panel', await waitFor(c, '!!document.querySelector(".repo-box")', 3000));
      ok('overview fills from GitHub', await waitFor(c, `${loaded} && /Latest runs on main/.test(document.querySelector(".repo-body").textContent)`, 20000), (await bodyText(c)).slice(0, 120));
      ok('the header says which account reads it', /as anthonyn99/.test(await evalJs(c, 'document.querySelector(".repo-acct").textContent')));
      ok('the overview lists runs with a status', await evalJs(c, 'document.querySelectorAll(".repo-body .repo-badge").length') > 0);
      await shot(c, 'repo-overview-desktop');
      const checks = [
        ['branches', /main/, 'branches: main with ↑↓'],
        ['commits', /auto:/, 'commits: A1 auto-commits'],
        ['pulls', /pull requests|#\d+/, 'pull requests answer (none open is fine)'],
        ['issues', /issues|#\d+/, 'issues answer'],
        ['actions', /pages build and deployment|Sync guard/, 'actions: real workflow runs'],
        ['releases', /shield-latest/, 'releases: shield-latest'],
      ];
      for (const [k, re, name] of checks) {
        await tab(c, k);
        const got = await waitFor(c, `${loaded} && ${re}.test(document.querySelector(".repo-body").textContent)`, 20000);
        ok(name, got, got ? '' : (await bodyText(c)).slice(0, 160));
      }
      ok('the branches tab shows ahead/behind', /↑\d+ ↓\d+/.test(await (async () => { await tab(c, 'branches'); await waitFor(c, loaded, 10000); return bodyText(c); })()));
      // A run opens to its jobs.
      await tab(c, 'actions');
      await waitFor(c, `${loaded} && document.querySelectorAll(".repo-body .repo-row").length > 0`, 15000);
      await evalJs(c, 'document.querySelector(".repo-body .repo-row").click(); return 1;');
      ok('a run opens to its jobs', await waitFor(c, `${loaded} && !!document.querySelector(".repo-back") && document.querySelectorAll(".repo-body .repo-card").length > 0`, 20000), (await bodyText(c)).slice(0, 120));
      await shot(c, 'repo-run-desktop');
      await evalJs(c, 'document.querySelector(".repo-back").click(); return 1;');
      ok('Back returns to the list', await waitFor(c, `${loaded} && !document.querySelector(".repo-back")`, 8000));
      // Asking again costs nothing: GitHub says 304 and the count stays put.
      const a = await api(`/projects/${A1_PID}/repo/releases`);
      const b = await api(`/projects/${A1_PID}/repo/releases`);
      ok('a repeat read is free (304: the hourly count does not move)', a.ok && b.ok && a.rate.used === b.rate.used, `${a.rate && a.rate.used} → ${b.rate && b.rate.used}`);
      // Esc closes.
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      ok('Esc closes the panel', await waitFor(c, '!document.querySelector(".repo-box")', 3000));
    }

    if (want('watch')) {
      console.log('\nThe Actions watch');
      await evalJs(c, 'codeRepoPanel(codeProject()); return 1;');
      await waitFor(c, `${loaded} && !!document.querySelector(".repo-watch")`, 20000);
      await evalJs(c, 'document.querySelector(".repo-watch").click(); return 1;');
      ok('Watch closes the panel and starts the watch', await waitFor(c, '!document.querySelector(".repo-box") && !!document.querySelector(".code-watch")', 5000));
      ok('the latest main commit reaches a verdict', await waitFor(c, '/passed|failed|No workflow ran/.test((document.querySelector(".code-watch")||{}).textContent||"")', 60000),
        await evalJs(c, '(document.querySelector(".code-watch")||{}).textContent||""'));
      ok('and the watch stops asking', await evalJs(c, '!CODE.watch.timer'));
      await shot(c, 'repo-watch-done');
      await evalJs(c, `codeWatchStart(codeProject(), ${JSON.stringify(FAILED_SHA)}); return 1;`);
      ok('a failed deploy is named by job and step', await waitFor(c, '/Actions failed on ead3625: deploy › Deploy to GitHub Pages/.test((document.querySelector(".code-watch")||{}).textContent||"")', 40000),
        await evalJs(c, '(document.querySelector(".code-watch")||{}).textContent||""'));
      await shot(c, 'repo-watch-failed');
      await evalJs(c, '[...document.querySelectorAll(".code-watch .code-git-act")].find(b=>b.textContent==="Log").click(); return 1;');
      ok('Log shows the tail with the real error', await waitFor(c, '/in progress deployment/.test((document.querySelector(".repo-log")||{}).textContent||"")', 5000));
      ok('the log starts scrolled to its end', await waitFor(c, 'return (()=>{const p=document.querySelector(".repo-log"); return p && p.scrollTop > 0 && p.scrollTop + p.clientHeight >= p.scrollHeight - 2;})()', 3000));
      ok('it offers the diagnosis', await evalJs(c, '!![...document.querySelectorAll(".repo-fail .code-approve")].find(b=>/diagnose/.test(b.textContent))'));
      await shot(c, 'repo-log-desktop');
      await evalJs(c, '[...document.querySelectorAll(".sheet .btn")].find(b=>b.textContent==="Close").click(); return 1;');
    }

    if (want('phone')) {
      console.log('\nPhone, 390px');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await sleep(600);
      ok('Code Mode fits', await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth') <= 0);
      if (await evalJs(c, '!!document.querySelector(".code-watch")')) {
        await shot(c, 'repo-watch-phone');
      }
      await evalJs(c, 'codeRepoPanel(codeProject(), "actions"); return 1;');
      ok('the panel opens as a bottom sheet', await waitFor(c, `${loaded} && document.querySelectorAll(".repo-body .repo-row").length > 0`, 20000));
      const geo = await evalJs(c, `return (()=>{const b=document.querySelector(".repo-box").getBoundingClientRect();
        return {bottom: Math.round(b.bottom), h: innerHeight, w: Math.round(b.width), vw: innerWidth};})()`);
      ok('it reaches the bottom edge and the full width', Math.abs(geo.bottom - geo.h) <= 1 && geo.w === geo.vw, JSON.stringify(geo));
      ok('nothing is wider than the screen', await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth') <= 0);
      ok('the tabs scroll sideways instead of wrapping', await evalJs(c, 'return (()=>{const t=document.querySelector(".repo-tabs"); return t.scrollWidth > t.clientWidth && getComputedStyle(t).overflowX==="auto";})()'));
      const minRow = await evalJs(c, 'Math.min(...[...document.querySelectorAll(".repo-body .repo-row")].map(r=>r.getBoundingClientRect().height))');
      ok('rows are thumb-sized (≥44px)', minRow >= 44, `${minRow}px`);
      ok('the selected tab is scrolled into view', await evalJs(c, 'return (()=>{const t=document.querySelector(".repo-tab.on").getBoundingClientRect(), b=document.querySelector(".repo-tabs").getBoundingClientRect(); return t.left >= b.left - 1 && t.right <= b.right + 1;})()'));
      await shot(c, 'repo-actions-phone');
      await evalJs(c, 'document.querySelector(".repo-body .repo-row").click(); return 1;');
      await waitFor(c, `${loaded} && !!document.querySelector(".repo-back")`, 20000);
      ok('run detail fits the phone', await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth') <= 0);
      await shot(c, 'repo-run-phone');
      await evalJs(c, 'document.querySelector(".repo-x").click(); return 1;');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
    }

    if (want('diagnose')) {
      console.log('\nDiagnose (a real Read task)');
      if (!await evalJs(c, 'CODE.watch && CODE.watch.fail ? 1 : 0')) {
        await evalJs(c, `codeWatchStart(codeProject(), ${JSON.stringify(FAILED_SHA)}); return 1;`);
        await waitFor(c, '!!(CODE.watch && CODE.watch.fail)', 40000);
      }
      await evalJs(c, '[...document.querySelectorAll(".code-watch .code-git-act")].find(b=>b.textContent==="Diagnose").click(); return 1;');
      ok('a Read task starts', await waitFor(c, '!!(CODE.task && CODE.task.id)', 10000));
      ok('it finishes', await waitFor(c, '!!(CODE.task && CODE.task.done)', 240000));
      // The ANSWER, not the page: the prompt itself quotes the log.
      const out = await evalJs(c, 'CODE.task.result ? CODE.task.result.outcome : ""');
      const said = await evalJs(c, '(CODE.task.result && CODE.task.result.text) || ""');
      ok('it succeeded', out === 'ok', out + ' ' + said.slice(0, 200));
      ok('the answer is about the deployment in progress', /in.progress|already|concurren|another deploy/i.test(said), said.slice(0, 240));
      await shot(c, 'repo-diagnosed');
    }

    ok('no uncaught exceptions', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    c.ws.close();
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(2); });
