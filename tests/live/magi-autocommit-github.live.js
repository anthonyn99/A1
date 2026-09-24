// LIVE test -- Phase 12 against REAL GitHub (not run by run-all.js).
// Run: node tests/live/magi-autocommit-github.live.js   Shots: %TEMP%/magi-live-shots
//
// Uses the throwaway private repo anthonyn99/magi-push-test (cloned at
// Desktop\magi-push-test, project proj_d8cd09a0b659), as the account MAGI
// holds a token for -- which needs Contents: Read and write on it. Three
// real (small) Claude edits:
//   1. window: Auto commit + Auto push on (1 min) from the sheet; an edit is
//      approved; while it counts down, "the other machine" (a second clone,
//      pushing with this PC's own git login -- test setup only) pushes to
//      GitHub. At zero MAGI commits exactly NOTES.md as `magi: ...`, pulls
//      that commit in, and pushes as the account; GitHub's main is our HEAD.
//      The Actions watch starts on the pushed SHA and reaches a verdict.
//   2. now: another edit, Commit now -> committed and pushed at once.
//   3. cancel: another edit, Cancel -> nothing committed, file left edited.
//   4. A1 is still refused.
// Every switch is turned back off in `finally`; the edits stay in the
// throwaway repo's history, which is what it is for.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const URL = 'file:///c:/Users/antho/Desktop/A1/magi.html';
const API = 'http://127.0.0.1:8000/api/code';
const PID = 'proj_d8cd09a0b659';
const OURS = 'C:\\Users\\antho\\Desktop\\magi-push-test';
const REMOTE = 'https://github.com/anthonyn99/magi-push-test.git';
const OTHER = path.join(os.tmpdir(), 'magi-push-test-other');
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
    await sleep(500);
  }
  return false;
};
const api = async (p, body, method) => {
  const r = await fetch(API + p, body || method ? {
    method: method || 'POST', headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined } : undefined);
  return r.json();
};
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a],
  { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const remoteMain = () => git(OURS, 'ls-remote', REMOTE, 'refs/heads/main').split(/\s/)[0];
const gitLine = (c) => evalJs(c, '(document.querySelector(".code-git")||{}).textContent || ""');
const autoBtns = (c) => evalJs(c, 'return [...document.querySelectorAll(".code-auto .code-git-act")].map(b=>b.textContent).join("|");');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

async function runTask(c, prompt) {
  await evalJs(c, 'CODE.picks = { on: ["claude-cli"], known: codeMembers().map(m=>m.id) }; CODE.task = null; renderCodeView(); return 1;');
  await evalJs(c, '[...document.querySelectorAll(".code-rw-b")].find(b=>b.textContent==="Write").click(); return 1;');
  await evalJs(c, `const t=document.getElementById("composer"); t.value=${JSON.stringify(prompt)}; t.dispatchEvent(new Event("input")); return 1;`);
  await evalJs(c, 'document.getElementById("btnSend").click(); return 1;');
  const card = await waitFor(c, '!!document.querySelector(".code-appr.is-open")', 300000);
  ok('an approval card appears', card, await evalJs(c, '(document.querySelector(".code-task-st")||{}).textContent || ""'));
  if (!card) return false;
  await evalJs(c, 'document.querySelector(".code-approve").click(); return 1;');
  const done = await waitFor(c, 'CODE.task && CODE.task.done && /Auto commit records it/.test((document.querySelector(".code-appr")||{}).textContent||"")', 90000);
  ok('applied; the card hands the commit to the line', done);
  return done;
}
const noteLine = (n) => `Add one line to the end of NOTES.md, exactly: "- auto commit test ${n} ${stamp}". Change nothing else.`;

(async () => {
  const st0 = await api('/state', null, 'GET');
  const proj = (st0.projects || []).find((p) => p.id === PID);
  if (!proj || !(proj.write || {}).ok) { console.error('magi-push-test is not set up here', proj); process.exit(2); }
  const acc = await api(`/projects/${PID}/github`, null, 'GET');
  if (!(acc.access && acc.access.push)) { console.error('the account cannot push magi-push-test', acc); process.exit(2); }
  git(OURS, 'pull', '-q', '--rebase');
  if (git(OURS, 'status', '--porcelain')) { console.error('magi-push-test has local changes; clean it first'); process.exit(2); }
  fs.rmSync(OTHER, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', REMOTE, OTHER], { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

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
  await evalJs(c, `localStorage.clear(); sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "code"); localStorage.setItem(lsKey("code.project"), JSON.stringify(${JSON.stringify(PID)})); return 1;`);
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 25000));
  ok('the line has read auto', await waitFor(c, '!!(CODE.git && CODE.git.auto)', 20000));
  ok('Repository pill names the GitHub repo', /Repositoryanthonyn99\/magi-push-test/.test(await evalJs(c, 'document.getElementById("codeStrip").textContent')));

  try {
    // ── switches, from the sheet ─────────────────────────────────────────
    console.log('\nSwitches');
    await evalJs(c, '[...document.querySelectorAll("#codeStrip .code-pill")].find(p=>p.textContent.startsWith("Auto commit")).click(); return 1;');
    ok('the sheet opens', await waitFor(c, '!!document.querySelector(".ac-sheet")', 3000));
    const sub = await evalJs(c, '(document.querySelector(\'.ac-row[data-auto="push"] .ac-row-s\')||{}).textContent || ""');
    ok('it names the repo and the account', /anthonyn99\/magi-push-test as anthonyn99/.test(sub), sub);
    for (const k of ['commit', 'push']) {
      await evalJs(c, `document.querySelector('.ac-row[data-auto="${k}"]').click(); return 1;`);
      ok(`Auto ${k} on`, await waitFor(c, `document.querySelector('.ac-row[data-auto="${k}"]').getAttribute("aria-checked")==="true"`, 8000));
    }
    await evalJs(c, '[...document.querySelectorAll(".ac-win .code-git-act")].find(b=>b.textContent==="1 min").click(); return 1;');
    ok('window 1 min', await waitFor(c, '[...document.querySelectorAll(".ac-win .code-git-act")].find(b=>b.textContent==="1 min").classList.contains("on")', 8000));
    await shot(c, 'gh-autocommit-sheet');
    await evalJs(c, 'document.querySelector(".ac-sheet").closest(".sheet").remove(); renderCodeView(); return 1;');

    // ── 1. the window runs out ───────────────────────────────────────────
    console.log('\n1. The window runs out; the other machine pushes meanwhile');
    const base = remoteMain();
    if (await runTask(c, noteLine(1))) {
      ok('the line counts down', await waitFor(c, '/magi: commit of 1 file \\+ push in 0:[0-5]\\d/.test((document.querySelector(".code-git")||{}).textContent||"")', 15000), await gitLine(c));
      await shot(c, 'gh-autocommit-countdown');
      // The other machine.
      fs.writeFileSync(path.join(OTHER, `other-${stamp}.txt`), 'pushed from the other machine\n');
      git(OTHER, 'add', '-A'); git(OTHER, 'commit', '-qm', `Other machine ${stamp}`); git(OTHER, 'push', '-q');
      const theirs = git(OTHER, 'rev-parse', 'HEAD');
      ok('GitHub moved on while the window ran', remoteMain() === theirs && theirs !== base);
      ok('committed and pushed at zero', await waitFor(c,
        '/Auto-committed [0-9a-f]{7} \\(1 file\\)\\. Pushed 1 commit to anthonyn99\\/magi-push-test \\(main\\) as anthonyn99\\./.test((document.querySelector(".code-git")||{}).textContent||"")', 120000), await gitLine(c));
      const head = git(OURS, 'rev-parse', 'HEAD');
      ok('GitHub main is our commit', remoteMain() === head, head.slice(0, 7));
      ok('a magi: message from what was asked', /^magi: Add one line to the end of NOTES\.md/.test(git(OURS, 'log', '-1', '--format=%s')), git(OURS, 'log', '-1', '--format=%s'));
      ok('exactly NOTES.md', git(OURS, 'show', '--name-only', '--format=', 'HEAD') === 'NOTES.md');
      ok('on top of the other machine\'s commit (pulled first)', git(OURS, 'rev-parse', 'HEAD~1') === theirs);
      ok('the working tree is clean', git(OURS, 'status', '--porcelain') === '');
      ok('the Actions watch follows the pushed SHA', await waitFor(c, `CODE.watch && CODE.watch.sha === ${JSON.stringify(head)}`, 10000),
         await evalJs(c, 'JSON.stringify(CODE.watch && {sha: CODE.watch.sha, state: CODE.watch.state})'));
      await shot(c, 'gh-autocommit-pushed');
      ok('the watch reaches a verdict', await waitFor(c, 'CODE.watch && !["none","pending"].includes(CODE.watch.state)', 330000),
         await evalJs(c, 'JSON.stringify(CODE.watch && {state: CODE.watch.state, err: CODE.watch.err})'));
      console.log('        watch: ' + await evalJs(c, '(document.querySelector(".code-watch")||{}).textContent || ""'));
      await shot(c, 'gh-autocommit-watch');
    }

    // ── 2. Commit now ────────────────────────────────────────────────────
    console.log('\n2. Commit now');
    if (await runTask(c, noteLine(2))) {
      ok('Commit now is offered', await waitFor(c, '/Commit now/.test((document.querySelector(".code-auto")||{}).textContent||"")', 15000));
      await evalJs(c, '[...document.querySelectorAll(".code-auto .code-git-act")].find(b=>b.textContent==="Commit now").click(); return 1;');
      ok('committed and pushed at once', await waitFor(c,
        '/Auto-committed [0-9a-f]{7} \\(1 file\\)\\. Pushed 1 commit to anthonyn99\\/magi-push-test/.test((document.querySelector(".code-git")||{}).textContent||"")', 60000), await gitLine(c));
      ok('GitHub main is our commit', remoteMain() === git(OURS, 'rev-parse', 'HEAD'));
      ok('the countdown is gone', !/ in \d:\d\d/.test(await gitLine(c)));
    }

    // ── 3. Cancel ────────────────────────────────────────────────────────
    console.log('\n3. Cancel');
    const before = remoteMain();
    if (await runTask(c, noteLine(3))) {
      ok('Cancel is offered', await waitFor(c, '/Cancel/.test((document.querySelector(".code-auto")||{}).textContent||"")', 15000), await autoBtns(c));
      await evalJs(c, '[...document.querySelectorAll(".code-auto .code-git-act")].find(b=>b.textContent==="Cancel").click(); return 1;');
      ok('it says cancelled, left uncommitted', await waitFor(c, '/Auto commit cancelled; 1 file left uncommitted\\./.test((document.querySelector(".code-git")||{}).textContent||"")', 15000), await gitLine(c));
      await sleep(70000);   // past the window it would have had
      ok('still nothing committed or pushed after the window', remoteMain() === before
         && /^ ?M NOTES\.md$/.test(git(OURS, 'status', '--porcelain')), git(OURS, 'status', '--porcelain'));
      git(OURS, 'checkout', '--', 'NOTES.md');
    }

    // ── 4. A1 ────────────────────────────────────────────────────────────
    console.log('\n4. A1');
    const r = await api('/projects/proj_60d8f14fbc1c/auto', { commit: true, push: true });
    ok('A1 is still refused (the new token can write A1; MAGI will not)', !r.ok && r.error === 'read_only_project', r.message);

    ok('no uncaught exceptions', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    const off = await api(`/projects/${PID}/auto`, { commit: false, push: false, window: 3 }).catch(() => ({}));
    console.log(`\nswitches restored off: ${!!(off.auto && !off.auto.commit && !off.auto.push)}`);
    try { fs.rmSync(OTHER, { recursive: true, force: true }); } catch {}
    console.log(`${pass} passed, ${fail} failed`);
    c.ws.close();
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(2); });
