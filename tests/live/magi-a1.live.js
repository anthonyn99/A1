// LIVE test -- Phase 14b: a real write task IN A1 (not run by run-all.js).
// Run: node tests/live/magi-a1.live.js        Screenshots: %TEMP%/magi-live-shots
//
// Tony's answers (2026-09-24): A1 takes writes; A1 commits and pushes itself
// (its always-on auto-commit pushes every change within minutes, so approving
// ships); MAGI only fetches it. On a throwaway probe file removed in
// `finally` -- A1's auto-commit may record it and its removal meanwhile, two
// small `auto:` commits, which is exactly the coexistence under test:
//   1. merge   a real Claude edit, while THIS test edits a line of the same
//              file inside the hunk's context in the real folder (a live
//              session would). The card says approving ships it. Approve:
//              merged, not refused; the card says A1's auto-commit records it
//              and offers no Commit; no `magi:` commit exists; A1 was fetched,
//              not pulled. Also at 390px.
//   2. engine  a change under magi/ carries the restart warning on the card,
//              and is DENIED, so nothing under magi/ changes.
// Spends two small Claude tasks. LIVE_ONLY=merge,engine picks sections.
'use strict';
const { connect, evalJs, sleep, shotPath, PAGES_URL } = require('./cdp.js');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const A1 = path.resolve(__dirname, '..', '..');
const A1_ID = 'proj_60d8f14fbc1c';
const PROBE_REL = 'docs/magi-a1-live-probe.md';
const PROBE = path.join(A1, PROBE_REL);
const ENGINE_REL = 'magi/requirements.txt';
const STUB = `(()=>{const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 return real(u,o);};})();`;
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '  [' + String(d).slice(0, 300) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  [' + String(d).slice(0, 300) + ']' : '')); }
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
const git = (...a) => execFileSync('git', ['-C', A1, ...a], { encoding: 'utf8' }).trim();
const probe = () => fs.readFileSync(PROBE, 'utf8').replace(/\r\n/g, '\n');
const cardText = (c) => evalJs(c, '(document.querySelector(".code-appr")||{}).textContent || ""');

async function runTask(c, prompt) {
  await evalJs(c, 'CODE.picks = { on: ["claude-cli"], known: codeMembers().map(m=>m.id) }; CODE.task = null; renderCodeView(); return 1;');
  await evalJs(c, '[...document.querySelectorAll(".code-rw-b")].find(b=>b.textContent==="Write").click(); return 1;');
  await evalJs(c, `const t=document.getElementById("composer"); t.value=${JSON.stringify(prompt)}; t.dispatchEvent(new Event("input")); return 1;`);
  await evalJs(c, 'document.getElementById("btnSend").click(); return 1;');
}

(async () => {
  const engineBefore = fs.readFileSync(path.join(A1, ENGINE_REL));
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: PAGES_URL }); await sleep(3000);
  await evalJs(c, `localStorage.clear(); sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "code"); localStorage.setItem(lsKey("code.project"), JSON.stringify(${JSON.stringify(A1_ID)})); return 1;`);
  await c.send('Page.navigate', { url: PAGES_URL });
  ok('engine online', await waitFor(c, 'online()', 25000));
  ok('A1 is the project', await waitFor(c, 'codeProject() && codeProject().name === "A1"', 20000));
  ok('Write is offered for A1', await evalJs(c,
    '[...document.querySelectorAll(".code-rw-b")].find(b=>b.textContent==="Write").disabled') === false);

  try {
    if (want('merge')) {
      console.log('\n1. A real edit in A1, while the same file is edited in the folder');
      fs.writeFileSync(PROBE, '# MAGI live probe (deleted by the test)\n\nalpha\nbeta\ngamma\n');
      const head0 = git('rev-parse', 'HEAD');
      await runTask(c, `In ${PROBE_REL}, change the line "alpha" to "ALPHA". Change nothing else and no other file.`);
      // The sandbox has its snapshot once the agent is working: edit the real
      // file now, the way a live session would.
      const working = await waitFor(c, 'CODE.task && CODE.task.events.some(e => e.k === "tool" || e.k === "text" || e.k === "model")', 120000);
      ok('the agent is working in the copy', working);
      // Inside the hunk's context (two lines below "alpha"), so `git apply`
      // cannot take it as is and the three-way merge has to.
      fs.writeFileSync(PROBE, probe().replace('\ngamma\n', '\ngamma (edited in the folder mid-task)\n'));
      ok('an approval card appears', await waitFor(c, '!!document.querySelector(".code-appr.is-open")', 300000),
         await evalJs(c, '(document.querySelector(".code-task-st")||{}).textContent || ""'));
      const pull = await evalJs(c, 'return JSON.stringify(CODE.task.events.find(e => e.k === "pull") || {});');
      ok('A1 was fetched, not pulled', /"skipped":true/.test(pull), pull);
      ok('no engine warning for a docs file', !/MAGI’s own engine/.test(await cardText(c)));
      ok('the card says approving ships it', /Approving ships this/.test(await cardText(c)), await cardText(c));
      ok('the folder still has only the mid-task edit', /\nalpha\n/.test(probe()) && /mid-task/.test(probe()));
      await evalJs(c, 'document.querySelector(".code-approve").click(); return 1;');
      ok('applied, merged with the mid-task edit', await waitFor(c,
        '/merged with edits you made meanwhile/.test((document.querySelector(".code-appr")||{}).textContent||"")', 60000),
        await cardText(c));
      const text = await cardText(c);
      ok('the card says A1 records and pushes it itself', /auto-commit records it/.test(text), text);
      ok('...and offers no Commit', await evalJs(c, '!document.querySelector(".code-commit-open")'));
      ok('both edits are in the file', /\nALPHA\n/.test(probe()) && /gamma \(edited in the folder mid-task\)/.test(probe()), probe());
      const since = git('log', '--format=%s', `${head0}..HEAD`);
      ok('MAGI committed nothing (A1\'s own auto: commits may have)', !/^magi:/m.test(since), since);
      await shot(c, 'a1-applied-desktop');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await sleep(600);
      ok('at 390px the card fits', await evalJs(c,
        'const b=document.querySelector(".code-appr").getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 1;'));
      await shot(c, 'a1-applied-phone');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      fs.rmSync(PROBE, { force: true });
    }

    if (want('engine')) {
      console.log('\n2. A change to the engine itself is flagged, then denied');
      await runTask(c, `Add one comment line "# live probe" at the end of ${ENGINE_REL}. Change nothing else.`);
      ok('an approval card appears', await waitFor(c, '!!document.querySelector(".code-appr.is-open")', 300000));
      const text = await cardText(c);
      ok('the card warns the engine must restart', /MAGI’s own engine/.test(text) && /never restarts itself/.test(text), text);
      await shot(c, 'a1-engine-warning');
      await evalJs(c, '[...document.querySelectorAll(".code-appr-acts button")].find(b=>b.textContent==="Deny").click(); return 1;');
      ok('denied', await waitFor(c, '/Denied\\. Your folder is unchanged\\./.test((document.querySelector(".code-appr")||{}).textContent||"")', 30000));
      ok('nothing under magi/ changed', fs.readFileSync(path.join(A1, ENGINE_REL)).equals(engineBefore));
    }
    ok('no uncaught exceptions', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    fs.rmSync(PROBE, { force: true });
    if (!fs.readFileSync(path.join(A1, ENGINE_REL)).equals(engineBefore)) {
      fs.writeFileSync(path.join(A1, ENGINE_REL), engineBefore);
      console.log('  (restored ' + ENGINE_REL + ')');
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    c.ws.close();
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { fs.rmSync(PROBE, { force: true }); console.error(e); process.exit(2); });
