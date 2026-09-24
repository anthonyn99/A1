// LIVE test -- drives the real engine on this PC (not run by run-all.js).
// Run: node tests/live/magi-autocommit.live.js     Screenshots: %TEMP%/magi-live-shots
//
// Phase 12 end to end, against SCRATCH repositories it creates in %TEMP% --
// never A1's files. A bare repository stands in for GitHub, and a second
// clone for the other machine that pushes while you are not looking.
//   1. switches: the pills read off, tapping one opens the sheet, Auto push
//      is greyed until Auto commit is on; both turned on, window 1 minute --
//      and the engine stored exactly that.
//   2. run: a real (small) Claude edit, approved. The card hands the commit
//      to the line; the line and the pill count down. An unrelated file is
//      staged by hand before the window ends, so the commit is REFUSED and
//      says why; unstaged, Try again commits exactly the applied file with a
//      `magi:` message, pulls (the other machine's commit arrives) and
//      pushes -- the bare repository has it.
//   3. watch: an auto push's SHA on a GitHub remote starts the Actions
//      watch, once (the local bare remote has no Actions, so a GitHub line is
//      fed to codeAutoFollow directly -- no network).
//   4. phone: at 390px the pills, the line and the sheet fit.
//   5. a1: A1's pills read "off · A1", the sheet is locked with the reason,
//      the route refuses, and the tree is not touched.
// LIVE_ONLY=switches,run,watch,phone,a1 picks sections (run needs switches).
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

const BASE = path.join(os.tmpdir(), 'magi-autocommit-live');
const BARE = path.join(BASE, 'origin.git');
const OTHER = path.join(BASE, 'other');
const OURS = path.join(BASE, 'ours');
const ident = (d) => { git(d, 'config', 'user.name', 'magi-live'); git(d, 'config', 'user.email', 'magi-live@localhost'); };
function makeRepos() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', BARE]);
  execFileSync('git', ['clone', '-q', BARE, OTHER], { stdio: 'ignore' });
  ident(OTHER);
  git(OTHER, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(OTHER, 'calc.py'), 'def total(xs):\n    return sum(xs)\n');
  fs.writeFileSync(path.join(OTHER, 'README.md'), '# scratch\n');
  fs.writeFileSync(path.join(OTHER, 'notes.txt'), 'notes\n');
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
const pills = (c) => evalJs(c, 'JSON.stringify([...document.querySelectorAll("#codeStrip .code-pill")].map(p=>p.textContent))').then(JSON.parse);
const pill = async (c, k) => (await pills(c)).find((t) => t.startsWith(k)) || '';

async function runTask(c, prompt, agents) {
  await evalJs(c, `CODE.picks = { on: ${JSON.stringify(agents)}, known: codeMembers().map(m=>m.id) }; CODE.task = null; renderCodeView(); return 1;`);
  await evalJs(c, '[...document.querySelectorAll(".code-rw-b")].find(b=>b.textContent==="Write").click(); return 1;');
  await evalJs(c, `const t=document.getElementById("composer"); t.value=${JSON.stringify(prompt)}; t.dispatchEvent(new Event("input")); return 1;`);
  await evalJs(c, 'document.getElementById("btnSend").click(); return 1;');
}
const openSheet = async (c) => {
  await evalJs(c, '[...document.querySelectorAll("#codeStrip .code-pill")].find(p=>p.textContent.startsWith("Auto commit")).click(); return 1;');
  return waitFor(c, '!!document.querySelector(".ac-sheet")', 3000);
};
const closeSheet = (c) => evalJs(c, '(document.querySelector(".ac-sheet")||{closest(){return null}}).closest(".sheet")?.remove(); return 1;');
const sw = (c, k) => evalJs(c, `return JSON.stringify((()=>{const b=document.querySelector('.ac-row[data-auto="${k}"]'); return b ? [b.getAttribute("aria-checked"), b.disabled] : null;})())`).then(JSON.parse);

(async () => {
  makeRepos();
  const made = await api('/projects', { name: 'magi-autocommit-live', root: OURS });
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
  ok('the line has read auto', await waitFor(c, '!!(CODE.git && CODE.git.auto)', 15000));

  try {
    // ── 1. the switches ───────────────────────────────────────────────────
    if (want('switches') || want('run')) {
      console.log('\nThe switches');
      ok('pills read off for a new project', /^Auto commitoff$/.test(await pill(c, 'Auto commit')) && /^Auto pushoff$/.test(await pill(c, 'Auto push')),
         JSON.stringify(await pills(c)));
      ok('tapping the pill opens the sheet', await openSheet(c));
      let s = await sw(c, 'push');
      ok('Auto push is greyed until Auto commit is on', s && s[0] === 'false' && s[1] === true, JSON.stringify(s));
      await shot(c, 'autocommit-sheet-off');
      await evalJs(c, 'document.querySelector(\'.ac-row[data-auto="commit"]\').click(); return 1;');
      ok('Auto commit switches on', await waitFor(c, 'document.querySelector(\'.ac-row[data-auto="commit"]\').getAttribute("aria-checked")==="true"', 8000));
      s = await sw(c, 'push');
      ok('and Auto push becomes available', s && s[1] === false, JSON.stringify(s));
      await evalJs(c, 'document.querySelector(\'.ac-row[data-auto="push"]\').click(); return 1;');
      ok('Auto push switches on', await waitFor(c, 'document.querySelector(\'.ac-row[data-auto="push"]\').getAttribute("aria-checked")==="true"', 8000));
      await evalJs(c, '[...document.querySelectorAll(".ac-win .code-git-act")].find(b=>b.textContent==="1 min").click(); return 1;');
      ok('window 1 min', await waitFor(c, '[...document.querySelectorAll(".ac-win .code-git-act")].find(b=>b.textContent==="1 min").classList.contains("on")', 8000));
      await shot(c, 'autocommit-sheet-on');
      const st = await api('/state', null, 'GET');
      const pr = ((st.projects || []).find((p) => p.id === PID) || {}).prefs || {};
      ok('the engine stored exactly that', pr.autoCommit === true && pr.autoPush === true && pr.batchWindowMin === 1, JSON.stringify(pr));
      await closeSheet(c);
      await evalJs(c, 'renderCodeView(); return 1;');
      ok('pills read on', /on$/.test(await pill(c, 'Auto commit')) && /on$/.test(await pill(c, 'Auto push')), JSON.stringify(await pills(c)));
    }

    // ── 2. a real task, blocked, then committed and pushed ────────────────
    if (want('run')) {
      console.log('\nA write task, auto-committed and pushed');
      pushFromOther('from-other.py', 'o = 1\n', 'pushed from the other machine meanwhile');
      await runTask(c, 'In calc.py, make total() ignore None values in xs. Change only that function.', ['claude-cli']);
      ok('an approval card appears', await waitFor(c, '!!document.querySelector(".code-appr.is-open")', 240000),
         await evalJs(c, '(document.querySelector(".code-task-st")||{}).textContent || ""'));
      // The other machine pushes AFTER the task's own pull: only the auto
      // push's pull can bring this one in.
      pushFromOther('later.py', 'l = 1\n', 'pushed while the window ran');
      await evalJs(c, 'document.querySelector(".code-approve").click(); return 1;');
      ok('applied, and the task ends', await waitFor(c, 'CODE.task && CODE.task.done', 60000));
      const card = await evalJs(c, '(document.querySelector(".code-appr")||{}).textContent || ""');
      ok('the card hands the commit to the line', /Auto commit records it/.test(card) && !document_has_commit_button(card), card.slice(-160));
      ok('the line counts down', await waitFor(c, '/magi: commit of 1 file \\+ push in 0:[0-5]\\d/.test((document.querySelector(".code-git")||{}).textContent||"")', 15000), await gitLine(c));
      ok('so does the pill', /Auto commitin 0:[0-5]\d/.test(await pill(c, 'Auto commit')), await pill(c, 'Auto commit'));
      ok('Commit now and Cancel are offered', await evalJs(c, 'return [...document.querySelectorAll(".code-auto .code-git-act")].map(b=>b.textContent).join("|");') === 'Commit now|Cancel');
      await shot(c, 'autocommit-countdown-desktop');
      ok('nothing is committed yet', git(OURS, 'log', '-1', '--format=%s').indexOf('magi:') !== 0);

      // Something ELSE staged by hand before the window ends.
      fs.writeFileSync(path.join(OURS, 'notes.txt'), 'notes, staged by you\n');
      git(OURS, 'add', 'notes.txt');
      ok('when the window ends it is refused, and says why', await waitFor(c,
        '/Not auto-committed: 1 file you staged yourself \\(notes\\.txt\\)/.test((document.querySelector(".code-git")||{}).textContent||"")', 90000), await gitLine(c));
      ok('Try again is offered', await evalJs(c, 'return [...document.querySelectorAll(".code-auto .code-git-act")].map(b=>b.textContent).join("|");') === 'Try again|Cancel');
      ok('the pill says blocked', /blocked$/.test(await pill(c, 'Auto commit')), await pill(c, 'Auto commit'));
      ok('nothing was committed or pushed', git(OURS, 'log', '-1', '--format=%s').indexOf('magi:') !== 0
         && git(BARE, 'log', '-1', '--format=%s', 'main') === 'pushed while the window ran');
      await shot(c, 'autocommit-blocked-desktop');

      git(OURS, 'restore', '--staged', 'notes.txt');
      await evalJs(c, '[...document.querySelectorAll(".code-auto .code-git-act")].find(b=>b.textContent==="Try again").click(); return 1;');
      ok('Try again commits and pushes', await waitFor(c,
        '/Auto-committed [0-9a-f]{7} \\(1 file\\)\\. Pushed \\d commits? to/.test((document.querySelector(".code-git")||{}).textContent||"")', 90000), await gitLine(c));
      const subj = git(OURS, 'log', '-1', '--format=%s');
      ok('with a magi: message from what was asked', /^magi: In calc\.py, make total\(\) ignore None values/.test(subj), subj);
      ok('exactly the applied file', git(OURS, 'show', '--name-only', '--format=', 'HEAD') === 'calc.py');
      ok('your hand-edited file stays out of it', /(^|\s)M notes\.txt/.test(git(OURS, 'status', '--porcelain')), git(OURS, 'status', '--porcelain'));
      ok('the pull brought in the other machine\'s commit first', fs.existsSync(path.join(OURS, 'later.py')));
      ok('GitHub (the bare repo) has it', git(BARE, 'rev-parse', 'main') === git(OURS, 'rev-parse', 'HEAD'));
      ok('the line shows in sync', await waitFor(c, '/↑0/.test((document.querySelector(".code-git")||{}).textContent||"")', 10000), await gitLine(c));
      ok('no Actions watch for a non-GitHub remote', await evalJs(c, '!CODE.watch'));
      await shot(c, 'autocommit-pushed-desktop');
      git(OURS, 'checkout', '--', 'notes.txt');
    }

    // ── 3. the watch follows an auto push (on GitHub) ─────────────────────
    if (want('watch')) {
      console.log('\nThe Actions watch');
      const r = JSON.parse(await evalJs(c, `
        const sha = "a".repeat(40); const pid = ${JSON.stringify(PID)};
        const calls = []; const real = window.codeWatchStart;
        codeWatchStart = (p, s, o) => calls.push(s);
        const keep = CODE.git.data.github;
        CODE.git.data.github = { host: "github.com", owner: "o", repo: "r", scheme: "https" };
        const a = { last: { at: Date.now()/1000, ok: true, push: { ok: true, sha, branch: "main" } } };
        codeAutoFollow(pid, a); codeAutoFollow(pid, a);
        const other = { last: { at: Date.now()/1000, ok: true, push: { ok: true, sha: "b".repeat(40), branch: "main" } } };
        CODE.git.data.github = keep; codeAutoFollow(pid, other);
        codeWatchStart = real;
        return JSON.stringify(calls);`));
      ok('an auto push on GitHub starts the watch, once per SHA', r.length === 1 && r[0] === 'a'.repeat(40), JSON.stringify(r));
    }

    // ── 4. the phone ──────────────────────────────────────────────────────
    if (want('phone')) {
      console.log('\nAt 390px');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await sleep(600);
      await evalJs(c, 'renderCodeView(); return 1;');
      ok('no horizontal page scroll', await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth') <= 0);
      await shot(c, 'autocommit-line-phone');
      ok('the sheet opens', await openSheet(c));
      const fit = JSON.parse(await evalJs(c, 'return JSON.stringify([...document.querySelectorAll(".ac-row, .ac-win .code-git-act")].map(b=>{const r=b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.height)];}));'));
      ok('switches and window buttons fit and are tappable', fit.length === 6 && fit.every(([l, r, h]) => l >= 0 && r <= 390 && h >= 36), JSON.stringify(fit));
      ok('no horizontal page scroll with the sheet', await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth') <= 0);
      await shot(c, 'autocommit-sheet-phone');
      await closeSheet(c);
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
    }

    // ── 5. A1 ─────────────────────────────────────────────────────────────
    if (want('a1')) {
      console.log('\nA1 stays off');
      const st = await api('/state', null, 'GET');
      const A1ID = ((st.projects || []).find((p) => p.name === 'A1') || {}).id;
      const A1 = path.resolve(__dirname, '..', '..');
      const head = git(A1, 'rev-parse', 'HEAD');
      await evalJs(c, `codeSetProject(${JSON.stringify(A1ID)}); CODE.git = null; renderCodeView(); return 1;`);
      ok('the line reads', await waitFor(c, '!!(CODE.git && CODE.git.pid === ' + JSON.stringify(A1ID) + ' && CODE.git.auto)', 20000));
      ok('pills read off · A1', /off · A1$/.test(await pill(c, 'Auto commit')) && /off · A1$/.test(await pill(c, 'Auto push')), JSON.stringify(await pills(c)));
      ok('the sheet opens locked', await openSheet(c));
      const lk = JSON.parse(await evalJs(c, 'return JSON.stringify([(document.querySelector(".ac-sheet .sheet-err")||{}).textContent||"", [...document.querySelectorAll(".ac-row")].every(b=>b.disabled)]);'));
      ok('with the reason, both switches disabled', /Stop hook already commits and pushes/.test(lk[0]) && lk[1], JSON.stringify(lk));
      await shot(c, 'autocommit-a1-locked');
      await closeSheet(c);
      const r = await api(`/projects/${A1ID}/auto`, { commit: true, push: true });
      ok('the route refuses it in words', !r.ok && r.error === 'read_only_project', JSON.stringify(r).slice(0, 160));
      const g = await api(`/projects/${A1ID}/git`, null, 'GET');
      ok('and nothing was stored or scheduled', g.auto && !g.auto.commit && !g.auto.push && !g.auto.pending);
      ok('A1\'s HEAD did not move', git(A1, 'rev-parse', 'HEAD') === head);
      await evalJs(c, `codeSetProject(${JSON.stringify(PID)}); return 1;`);
    }

    ok('no uncaught exceptions', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    await api(`/projects/${PID}/auto`, { commit: false }).catch(() => {});
    await api(`/projects/${PID}`, null, 'DELETE').catch(() => {});
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`);
    c.ws.close();
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(2); });

function document_has_commit_button(cardText) { return /Commit these files/.test(cardText); }
