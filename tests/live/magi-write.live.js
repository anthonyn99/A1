// LIVE test -- drives the real engine on this PC (not run by run-all.js).
// Run: node tests/live/magi-write.live.js        Screenshots: %TEMP%/magi-live-shots
//      LIVE_TIMEOUT=1 node tests/live/magi-write.live.js   (adds the 5-minute no-answer run)
//
// Phase 8 end to end, against a SCRATCH repository it creates in %TEMP% --
// never A1. Real agents edit a sandbox copy; the card shows the diff; the
// real file changes only after Approve, and not at all after Deny.
//   1. A1 offers Write greyed out, with the reason.
//   2. Claude CLI: approve on desktop  -> the file on disk changes.
//   3. Claude CLI: deny at 390px       -> the file on disk does not.
//   4. Codex CLI:  approve              -> Codex's own write sandbox works.
//   5. ChatGPT (browser unit): approve  -> the SEARCH/REPLACE path works.
//   6. (LIVE_TIMEOUT) no answer for 5 minutes -> nothing changes.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const URL = 'file:///c:/Users/antho/Desktop/A1/magi.html';
const API = 'http://127.0.0.1:8000/api/code';
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
const api = async (p, body, method) => {
  const r = await fetch(API + p, body || method ? {
    method: method || 'POST', headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined } : undefined);
  return r.json();
};
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

// ── the scratch repository ────────────────────────────────────────────────
const REPO = path.join(os.tmpdir(), 'magi-write-live');
const CALC = path.join(REPO, 'calc.py');
const CALC0 = 'def total(xs):\n    return sum(xs)\n\n\ndef mean(xs):\n    return total(xs) / len(xs)\n';
function makeRepo() {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, 'init', '-q');
  git(REPO, 'config', 'user.name', 'magi-live');
  git(REPO, 'config', 'user.email', 'magi-live@localhost');
  fs.writeFileSync(CALC, CALC0);
  fs.writeFileSync(path.join(REPO, 'README.md'), '# scratch\n\nA scratch repo for MAGI write-mode tests.\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-qm', 'init');
}
// Line endings normalised: autocrlf rewrites the file as CRLF on checkout,
// and "unchanged" means the same content, not the same bytes.
const calc = () => fs.readFileSync(CALC, 'utf8').replace(/\r\n/g, '\n');
// LIVE_ONLY=browser,codex runs just those sections (the A1 check always runs).
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);

async function runTask(c, prompt, agents) {
  await evalJs(c, `CODE.picks = { on: ${JSON.stringify(agents)}, known: codeMembers().map(m=>m.id) }; CODE.task = null; renderCodeView(); return 1;`);
  await evalJs(c, '[...document.querySelectorAll(".code-rw-b")].find(b=>b.textContent==="Write").click(); return 1;');
  await evalJs(c, `const t=document.getElementById("composer"); t.value=${JSON.stringify(prompt)}; t.dispatchEvent(new Event("input")); return 1;`);
  const label = await evalJs(c, 'document.getElementById("btnSend").textContent');
  await evalJs(c, 'document.getElementById("btnSend").click(); return 1;');
  return label;
}

(async () => {
  makeRepo();
  const made = await api('/projects', { name: 'magi-write-live', root: REPO });
  if (!made.ok) { console.error('could not register the scratch repo', made); process.exit(2); }
  const PID = made.project.id;

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
  await evalJs(c, 'localStorage.clear(); sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "code"); return 1;');
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 25000));
  ok('state + agents loaded', await waitFor(c, '!!(CODE.state && CODE.agents)'));

  try {
    console.log('\nA1 cannot be written');
    const a1 = await evalJs(c, 'return (CODE.state.projects.find(p=>p.name==="A1")||{}).id;');
    await evalJs(c, `codeSetProject(${JSON.stringify(a1)}); renderCodeView(); return 1;`);
    ok('Write is greyed out for A1', await evalJs(c,
      '[...document.querySelectorAll(".code-rw-b")].find(b=>b.textContent==="Write").disabled') === true);
    const why = await evalJs(c, '(document.querySelector(".code-rw-note")||{}).textContent || ""');
    ok('with the reason', /read-only/.test(why), why);
    const forced = await api('/tasks', { project_id: a1, prompt: 'x', mode: 'write', agents: ['claude-cli'] });
    ok('and the engine refuses it even if asked directly', forced.ok === false && forced.error === 'read_only_project');
    await shot(c, 'write-a1-readonly');

    await evalJs(c, `codeSetProject(${JSON.stringify(PID)}); renderCodeView(); return 1;`);
    ok('Write is offered for a scratch repo', await evalJs(c,
      '[...document.querySelectorAll(".code-rw-b")].find(b=>b.textContent==="Write").disabled') === false);

    // ── 2. Claude CLI, approve ─────────────────────────────────────────────
    if (want('claude')) {
    console.log('\nClaude CLI edits a copy; Approve applies it');
    const label = await runTask(c, 'In calc.py, make total() ignore None values in xs. Change only that function.', ['claude-cli']);
    ok('the button said Run edits', label === 'Run edits', label);
    ok('an approval card appears', await waitFor(c, '!!document.querySelector(".code-appr.is-open")', 180000));
    ok('the real file has NOT changed yet', calc() === CALC0);
    const files = JSON.parse(await evalJs(c, 'return JSON.stringify([...document.querySelectorAll(".code-file-path")].map(n=>n.textContent));'));
    ok('the card lists calc.py', files.includes('calc.py'), files.join(','));
    ok('the diff is drawn', await evalJs(c, 'document.querySelectorAll(".code-diff .l-add").length') > 0);
    ok('a countdown runs', /\d:\d\d left/.test(await evalJs(c, 'document.querySelector(".code-appr-cd").textContent')));
    ok('the Write switch resets to Read for the next task', await evalJs(c, 'CODE.rw') === 'read');
    ok('the status says nothing has changed yet', /nothing has changed yet/.test(await evalJs(c, 'document.querySelector(".code-task-st").textContent')));
    ok('no sandbox leaked into the repo view', !/magi-sandbox/.test(await evalJs(c, 'document.querySelector(".code-task").textContent')));
    await shot(c, 'write-desktop-approval');
    await evalJs(c, 'document.querySelector(".code-approve").click(); return 1;');
    ok('the task finishes', await waitFor(c, 'CODE.task && CODE.task.done', 60000));
    const after = calc();
    ok('the real file changed', after !== CALC0 && /None/.test(after), after.split('\n').slice(0, 3).join(' | '));
    ok('the status says applied', /applied to your folder/.test(await evalJs(c, 'document.querySelector(".code-task-st").textContent')));
    ok('nothing is staged', git(REPO, 'diff', '--cached', '--name-only') === '');
    ok('the sandbox is gone', git(REPO, 'worktree', 'list').split('\n').length === 1);
    await shot(c, 'write-desktop-applied');
    git(REPO, 'checkout', '--', 'calc.py');
    }

    // ── 3. Claude CLI, deny, on a phone ────────────────────────────────────
    if (want('deny')) {
    console.log('\nDeny at 390px leaves the folder alone');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    await runTask(c, 'Add a one-line docstring to mean() in calc.py. Nothing else.', ['claude-cli']);
    ok('the approval card appears on the phone', await waitFor(c, '!!document.querySelector(".code-appr.is-open")', 180000));
    const overflow = await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth');
    ok('no horizontal page scroll at 390', overflow <= 0, String(overflow));
    const btns = JSON.parse(await evalJs(c, 'return JSON.stringify([...document.querySelectorAll(".code-appr-acts button")].map(b=>{const r=b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), r.right <= innerWidth];}));'));
    ok('Approve and Deny are big enough to thumb', btns.length === 2 && btns.every(([w, h, inside]) => w >= 120 && h >= 44 && inside), JSON.stringify(btns));
    await evalJs(c, 'document.querySelector(".code-appr .code-file > summary").scrollIntoView(); return 1;');
    await shot(c, 'write-phone-approval');
    await evalJs(c, '[...document.querySelectorAll(".code-appr-acts button")].find(b=>b.textContent==="Deny").click(); return 1;');
    ok('the task finishes', await waitFor(c, 'CODE.task && CODE.task.done', 30000));
    ok('the real file is unchanged', calc() === CALC0);
    ok('the card says denied', /Denied\. Your folder is unchanged/.test(await evalJs(c, 'document.querySelector(".code-appr").textContent')));
    await shot(c, 'write-phone-denied');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    }

    // ── 4. Codex CLI ───────────────────────────────────────────────────────
    if (want('codex')) {
    console.log('\nCodex CLI in its own write sandbox');
    await runTask(c, 'In calc.py, make mean() return 0.0 for an empty list instead of raising. Change only mean().', ['codex-cli']);
    ok('Codex reaches the approval card', await waitFor(c, '!!document.querySelector(".code-appr.is-open")', 300000),
       await evalJs(c, '(document.querySelector(".code-task-st")||{}).textContent || ""'));
    ok('the agent was Codex', /Codex/.test(await evalJs(c, 'document.querySelector(".code-log").textContent')));
    await evalJs(c, 'document.querySelector(".code-approve") && document.querySelector(".code-approve").click(); return 1;');
    ok('the task finishes', await waitFor(c, 'CODE.task && CODE.task.done', 60000));
    ok('Codex\'s edit reached the file', /0\.0|if not xs|len\(xs\) == 0/.test(calc()), calc().split('\n').slice(4, 9).join(' | '));
    await shot(c, 'write-codex-applied');
    git(REPO, 'checkout', '--', 'calc.py');
    }

    // ── 5. A browser unit, through SEARCH/REPLACE ──────────────────────────
    if (want('browser')) {
    console.log('\nA browser unit edits through the fixed format');
    await runTask(c, 'In calc.py, rename the parameter xs to values in total() only (both its uses inside total). Nothing else.', ['chatgpt']);
    ok('ChatGPT reaches the approval card', await waitFor(c, '!!document.querySelector(".code-appr.is-open") || (CODE.task && CODE.task.done)', 300000));
    const got = await evalJs(c, '!!document.querySelector(".code-appr.is-open")');
    ok('with a diff, not an error', got, await evalJs(c, '(document.querySelector(".code-task")||{}).textContent.slice(-300)'));
    if (got) {
      await evalJs(c, 'document.querySelector(".code-approve").click(); return 1;');
      ok('the task finishes', await waitFor(c, 'CODE.task && CODE.task.done', 60000));
      ok('the browser unit\'s edit reached the file', /def total\(values\)/.test(calc()), calc().split('\n')[0]);
    }
    await shot(c, 'write-browser-applied');
    git(REPO, 'checkout', '--', 'calc.py');
    }

    // ── 6. No answer ───────────────────────────────────────────────────────
    if (process.env.LIVE_TIMEOUT) {
      console.log('\nNo answer for five minutes is a No');
      await runTask(c, 'Add a trailing comment "# end" as the last line of calc.py.', ['claude-cli']);
      ok('approval card', await waitFor(c, '!!document.querySelector(".code-appr.is-open")', 180000));
      ok('it times out on its own', await waitFor(c, 'CODE.task && CODE.task.done', 330000));
      ok('the real file is unchanged', calc() === CALC0);
      ok('the card says why', /Not approved within 5 minutes/.test(await evalJs(c, 'document.querySelector(".code-appr").textContent')));
    }

    ok('no uncaught exceptions', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    await api(`/projects/${PID}`, null, 'DELETE').catch(() => {});
    try { fs.rmSync(REPO, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`);
    c.ws.close();
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(2); });
