// LIVE test -- drives the real engine on this PC (not run by run-all.js).
// Run: node tests/live/magi-git.live.js          Screenshots: %TEMP%/magi-live-shots
//
// Phase 9 end to end, against SCRATCH repositories it creates in %TEMP% --
// never A1's files. A bare repository stands in for GitHub, and a second
// clone for the other machine that pushes while you are not looking.
//   1. The repository line: branch, upstream, "never fetched".
//   2. A write task pulls first (the pushed file arrives), a real Claude
//      edit is approved, then committed from the card: exactly calc.py, the
//      edited draft message, nothing pushed, the line shows ahead 1.
//   3. At 390px: the line and the commit field fit, the message survives a
//      redraw while typed, Commit works from the phone.
//   4. A pull that clashes stops the task before any agent starts.
//   5. A1 is fetched, never pulled (a task with no agents -- no usage spent).
// LIVE_ONLY=line,commit,phone,clash,a1 picks sections.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Served by the engine: since Phase 14 a file:// page (Origin "null") is refused.
const URL = 'http://127.0.0.1:8000/';
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
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);

// ── origin, the other machine, and ours ───────────────────────────────────
const BASE = path.join(os.tmpdir(), 'magi-git-live');
const BARE = path.join(BASE, 'origin.git');
const OTHER = path.join(BASE, 'other');
const OURS = path.join(BASE, 'ours');
const CALC0 = 'def total(xs):\n    return sum(xs)\n\n\ndef mean(xs):\n    return total(xs) / len(xs)\n';
const ident = (d) => { git(d, 'config', 'user.name', 'magi-live'); git(d, 'config', 'user.email', 'magi-live@localhost'); };
function makeRepos() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', BARE]);
  execFileSync('git', ['clone', '-q', BARE, OTHER], { stdio: 'ignore' });
  ident(OTHER);
  git(OTHER, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(OTHER, 'calc.py'), CALC0);
  fs.writeFileSync(path.join(OTHER, 'README.md'), '# scratch\n');
  git(OTHER, 'add', '-A'); git(OTHER, 'commit', '-qm', 'init'); git(OTHER, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', BARE, OURS], { stdio: 'ignore' });
  ident(OURS);
}
function pushFromOther(name, text, msg) {
  git(OTHER, 'pull', '-q', '--rebase');
  fs.writeFileSync(path.join(OTHER, name), text);
  git(OTHER, 'add', '--', name); git(OTHER, 'commit', '-qm', msg); git(OTHER, 'push', '-q');
}
const gitLine = (c) => evalJs(c, '(document.querySelector(".code-git")||{}).textContent || ""');

async function runTask(c, prompt, agents, write) {
  await evalJs(c, `CODE.picks = { on: ${JSON.stringify(agents)}, known: codeMembers().map(m=>m.id) }; CODE.task = null; renderCodeView(); return 1;`);
  if (write) await evalJs(c, '[...document.querySelectorAll(".code-rw-b")].find(b=>b.textContent==="Write").click(); return 1;');
  await evalJs(c, `const t=document.getElementById("composer"); t.value=${JSON.stringify(prompt)}; t.dispatchEvent(new Event("input")); return 1;`);
  await evalJs(c, 'document.getElementById("btnSend").click(); return 1;');
}

async function approveAndOpenCommit(c) {
  ok('an approval card appears', await waitFor(c, '!!document.querySelector(".code-appr.is-open")', 240000),
     await evalJs(c, '(document.querySelector(".code-task-st")||{}).textContent || ""'));
  await evalJs(c, 'document.querySelector(".code-approve").click(); return 1;');
  ok('applied', await waitFor(c, 'CODE.task && CODE.task.done && !!document.querySelector(".code-commit-open")', 60000));
  await evalJs(c, 'document.querySelector(".code-commit-open").click(); return 1;');
  return waitFor(c, '!!document.querySelector(".code-commit-msg")', 3000);
}

(async () => {
  makeRepos();
  pushFromOther('pushed.py', 'p = 1\n', 'pushed from the other machine');
  const made = await api('/projects', { name: 'magi-git-live', root: OURS });
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
  await evalJs(c, `localStorage.clear(); sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "code"); localStorage.setItem(lsKey("code.project"), JSON.stringify(${JSON.stringify(PID)})); return 1;`);
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 25000));
  ok('state + agents loaded', await waitFor(c, '!!(CODE.state && CODE.agents)'));

  try {
    // ── 1. the line ────────────────────────────────────────────────────────
    if (want('line')) {
      console.log('\nThe repository line');
      ok('it appears under the workspace', await waitFor(c, '/main/.test((document.querySelector(".code-git")||{}).textContent||"")', 15000));
      const line = await gitLine(c);
      ok('branch, upstream, ahead/behind, clean', /main/.test(line) && /origin\/main/.test(line) && /↑0/.test(line) && /clean/.test(line), line);
      ok('it admits it has never fetched', /never fetched/.test(line), line);
      await shot(c, 'git-line-desktop');
    }

    // ── 2. pull, edit, approve, commit ─────────────────────────────────────
    if (want('commit')) {
      console.log('\nPull first, then commit what was approved');
      fs.writeFileSync(path.join(OURS, 'scratch-notes.txt'), 'mine, untracked, never committed by MAGI\n');
      await runTask(c, 'In calc.py, make total() ignore None values in xs. Change only that function.', ['claude-cli'], true);
      ok('the transcript opens with the pull', await waitFor(c, '/Pulled 1 commit from origin\\/main/.test((document.querySelector(".code-log")||{}).textContent||"")', 60000),
         await evalJs(c, '(document.querySelector(".code-log")||{}).textContent.slice(0,200) || ""'));
      ok('the pushed file arrived before the agent looked', fs.existsSync(path.join(OURS, 'pushed.py')));
      ok('the commit field opens', await approveAndOpenCommit(c));
      const draft = await evalJs(c, 'document.querySelector(".code-commit-msg").value');
      ok('with a draft from what was asked', /^In calc\.py, make total\(\) ignore None values/.test(draft), draft.split('\n')[0]);
      await shot(c, 'git-commit-form-desktop');
      await evalJs(c, `const t=document.querySelector(".code-commit-msg"); t.value="Make total() skip None\\n\\nLive test commit."; t.dispatchEvent(new Event("input")); return 1;`);
      await evalJs(c, '[...document.querySelectorAll(".code-commit .code-approve")][0].click(); return 1;');
      ok('the card says committed, not pushed', await waitFor(c, '/Committed [0-9a-f]{7} — Make total\\(\\) skip None\\. Not pushed\\./.test(document.querySelector(".code-appr").textContent)', 30000),
         await evalJs(c, 'document.querySelector(".code-appr").textContent.slice(-200)'));
      ok('the commit holds exactly calc.py', git(OURS, 'show', '--name-only', '--format=', 'HEAD') === 'calc.py');
      ok('with the edited message', git(OURS, 'log', '-1', '--format=%B') === 'Make total() skip None\n\nLive test commit.');
      ok('your untracked file is left alone', /\?\? scratch-notes\.txt/.test(git(OURS, 'status', '--porcelain')));
      ok('nothing was pushed', git(BARE, 'log', '-1', '--format=%s', 'main') === 'pushed from the other machine');
      ok('the line now shows ahead 1', await waitFor(c, '/↑1/.test((document.querySelector(".code-git")||{}).textContent||"")', 10000), await gitLine(c));
      ok('and when it last fetched', /fetched (just now|\dm ago)/.test(await gitLine(c)), await gitLine(c));
      await shot(c, 'git-committed-desktop');
      fs.rmSync(path.join(OURS, 'scratch-notes.txt'), { force: true });
    }

    // ── 3. the phone ───────────────────────────────────────────────────────
    if (want('phone')) {
      console.log('\nAt 390px');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await sleep(600);
      await evalJs(c, 'renderCodeView(); return 1;');
      ok('no horizontal page scroll with the line showing', await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth') <= 0);
      await shot(c, 'git-line-phone');
      await runTask(c, 'Add a one-line docstring to mean() in calc.py. Nothing else.', ['claude-cli'], true);
      ok('the commit field opens on the phone', await approveAndOpenCommit(c));
      const fit = JSON.parse(await evalJs(c, 'const t=document.querySelector(".code-commit-msg"); const r=t.getBoundingClientRect(); return JSON.stringify([r.left>=0 && r.right<=innerWidth, getComputedStyle(t).fontSize]);'));
      ok('the field fits and will not zoom iOS', fit[0] && fit[1] === '16px', JSON.stringify(fit));
      ok('no horizontal page scroll with the form open', await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth') <= 0);
      // Typing, then the once-a-minute redraw: focus and text must survive.
      await evalJs(c, 'const t=document.querySelector(".code-commit-msg"); t.focus(); t.value="Docstring for mean"; t.dispatchEvent(new Event("input")); t.setSelectionRange(4,4); return 1;');
      await evalJs(c, 'renderCodeView(); return 1;');
      await sleep(50);
      const kept = JSON.parse(await evalJs(c, 'const a=document.activeElement; return JSON.stringify([a.className, a.value, a.selectionStart]);'));
      ok('a redraw keeps the message, its focus and caret', kept[0] === 'code-commit-msg' && kept[1] === 'Docstring for mean' && kept[2] === 4, JSON.stringify(kept));
      const btns = JSON.parse(await evalJs(c, 'return JSON.stringify([...document.querySelectorAll(".code-commit .code-appr-acts button")].map(b=>Math.round(b.getBoundingClientRect().height)));'));
      ok('Cancel and Commit are thumb-sized', btns.length === 2 && btns.every((h) => h >= 44), JSON.stringify(btns));
      await shot(c, 'git-commit-form-phone');
      await evalJs(c, '[...document.querySelectorAll(".code-commit .code-approve")][0].click(); return 1;');
      ok('committed from the phone', await waitFor(c, '/Committed [0-9a-f]{7}/.test(document.querySelector(".code-appr").textContent)', 30000));
      ok('the line shows ahead 2', await waitFor(c, '/↑2/.test((document.querySelector(".code-git")||{}).textContent||"")', 10000), await gitLine(c));
      await shot(c, 'git-committed-phone');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
    }

    // ── 4. a pull that clashes ─────────────────────────────────────────────
    if (want('clash')) {
      console.log('\nA pull that clashes stops the task');
      pushFromOther('calc.py', 'def total(xs):\n    return 42  # theirs\n', 'theirs, clashing');
      const mine = fs.readFileSync(path.join(OURS, 'calc.py'), 'utf8').replace(/return .*/, 'return -1  # mine');
      fs.writeFileSync(path.join(OURS, 'calc.py'), mine);
      git(OURS, 'commit', '-qam', 'mine, clashing');
      const head = git(OURS, 'rev-parse', 'HEAD');
      await runTask(c, 'What does total() return?', ['claude-cli'], false);
      ok('the task ends', await waitFor(c, 'CODE.task && CODE.task.done', 60000));
      const st = await evalJs(c, 'document.querySelector(".code-task-st").textContent');
      ok('it says it stopped before any agent started', /Stopped before any agent started/.test(st), st);
      const log = await evalJs(c, 'document.querySelector(".code-log").textContent');
      ok('the reason names the file', /clashed with your local commits in calc\.py/.test(log), log.slice(0, 200));
      ok('no agent ran', !/is on it/.test(log));
      ok('the pull was undone', git(OURS, 'rev-parse', 'HEAD') === head && !fs.existsSync(path.join(OURS, '.git', 'rebase-merge')));
      await shot(c, 'git-pull-clash');
    }

    // ── 5. A1 ──────────────────────────────────────────────────────────────
    if (want('a1')) {
      console.log('\nA1 is fetched, never pulled');
      const a1 = await api('/state', null, 'GET');
      const A1ID = ((a1.projects || []).find((p) => p.name === 'A1') || {}).id;
      const A1 = path.resolve(__dirname, '..', '..');
      const headBefore = git(A1, 'rev-parse', 'HEAD');
      const r = await api('/tasks', { project_id: A1ID, prompt: 'noop', agents: ['none'] });
      ok('a task with no agents starts', r.ok, JSON.stringify(r).slice(0, 200));
      let pull = null;
      for (let i = 0; i < 60 && !pull; i++) {
        await sleep(1000);
        const t = await api(`/tasks`, null, 'GET');
        const mine = (t.tasks || []).find((x) => x.id === r.task.id);
        if (mine && mine.done) {
          const res = await fetch(`${API}/tasks/${r.task.id}/stream`);
          const txt = await res.text();
          const evs = txt.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
          pull = evs.find((e) => e.k === 'pull') || {};
        }
      }
      ok('its pull event is fetch-only', pull && pull.skipped === true && /Up to date|not pulled/.test(pull.text || ''), pull && pull.text);
      ok('A1\'s HEAD did not move', git(A1, 'rev-parse', 'HEAD') === headBefore);
      const g = await api(`/projects/${A1ID}/git`, null, 'GET');
      ok('A1\'s line reads', g.ok && g.git.branch === 'main', JSON.stringify(g).slice(0, 200));
    }

    ok('no uncaught exceptions', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    await api(`/projects/${PID}`, null, 'DELETE').catch(() => {});
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`);
    c.ws.close();
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(2); });
