// LIVE test -- drives the real engine on this PC (not run by run-all.js).
// Run: node tests/live/magi-github.live.js       Screenshots: %TEMP%/magi-live-shots
//
// Phase 10 end to end, on SCRATCH repositories in %TEMP% -- never A1's files.
// No real GitHub token is needed; where GitHub itself must answer, a
// well-formed fake token is sent and GitHub's refusal is the thing checked.
//   1. accounts  Accounts > GitHub: the add-token sheet is masked, a malformed
//                token is refused before any request, a fake one is refused BY
//                GITHUB, the field is emptied, and no token is left in the page.
//   2. line      a local commit makes the line say "Push ↑1"; pressing it
//                pushes to the bare origin (desktop).
//   3. card      a real Claude write task at 390px: approve, commit, then Push
//                on the card -- thumb-sized, and the commit lands on origin.
//   4. https     a throwaway account is injected (public record + credential
//                store entry, never verified); with an https github.com remote
//                the line asks for an account, the Repository pill opens the
//                sheet, the choice is saved, and Push goes to GitHub through
//                askpass and comes back refused with a sentence. Remove in
//                Accounts deletes the credential.
// LIVE_ONLY=accounts,line,card,https picks sections.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The Pages console, served from this working copy (cdp.js): since Phase 14 a
// file:// page (Origin "null") is refused by the engine.
const URL = require('./cdp.js').PAGES_URL;
const API = 'http://127.0.0.1:8000/api/code';
const A1 = path.resolve(__dirname, '..', '..');
const PY = path.join(A1, 'magi', '.venv', 'Scripts', 'python.exe');
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
const py = (code) => execFileSync(PY, ['-c', code], { encoding: 'utf8' }).trim();
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);
const rnd = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

const BASE = path.join(os.tmpdir(), 'magi-github-live');
const BARE = path.join(BASE, 'origin.git');
const OURS = path.join(BASE, 'ours');
const CALC0 = 'def total(xs):\n    return sum(xs)\n\n\ndef mean(xs):\n    return total(xs) / len(xs)\n';
const ident = (d) => { git(d, 'config', 'user.name', 'magi-live'); git(d, 'config', 'user.email', 'magi-live@localhost'); };
function makeRepos() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', BARE]);
  const seed = path.join(BASE, 'seed');
  execFileSync('git', ['clone', '-q', BARE, seed], { stdio: 'ignore' });
  ident(seed);
  git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(seed, 'calc.py'), CALC0);
  git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'init'); git(seed, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', BARE, OURS], { stdio: 'ignore' });
  ident(OURS);
}
const gitLine = (c) => evalJs(c, '(document.querySelector(".code-git")||{}).textContent || ""');
const refreshLine = (c, pid) => evalJs(c, `codeGitLoad(${JSON.stringify(pid)}); return 1;`);

// The injected account: a public record in the profile's data folder and a
// credential-store entry, exactly as accounts.add() would leave them -- minus
// the verification, which a fake token cannot pass.
const FAKE_LOGIN = 'magi-live-fake';
const FAKE_TOKEN = 'github_pat_' + rnd(70);
const META = path.join(A1, 'magi', 'data', 'tony', 'github', 'accounts.json');
function injectAccount() {
  py(`import json, keyring, time, pathlib
p = pathlib.Path(r"${META}"); p.parent.mkdir(parents=True, exist_ok=True)
m = json.loads(p.read_text("utf-8")) if p.exists() else {}
m["${FAKE_LOGIN}"] = {"login": "${FAKE_LOGIN}", "name": "Live test", "avatar": "", "kind": "fine-grained",
  "scopes": [], "expires": "", "added": time.time(), "verified": time.time()}
p.write_text(json.dumps(m), "utf-8")
keyring.set_password("magi-github:tony:${FAKE_LOGIN}", "${FAKE_LOGIN}", "${FAKE_TOKEN}")`);
}
const fakeStored = () => py(`import keyring; print(bool(keyring.get_password("magi-github:tony:${FAKE_LOGIN}", "${FAKE_LOGIN}")))`) === 'True';

async function runTask(c, prompt, agents) {
  await evalJs(c, `CODE.picks = { on: ${JSON.stringify(agents)}, known: codeMembers().map(m=>m.id) }; CODE.task = null; renderCodeView(); return 1;`);
  await evalJs(c, '[...document.querySelectorAll(".code-rw-b")].find(b=>b.textContent==="Write").click(); return 1;');
  await evalJs(c, `const t=document.getElementById("composer"); t.value=${JSON.stringify(prompt)}; t.dispatchEvent(new Event("input")); return 1;`);
  await evalJs(c, 'document.getElementById("btnSend").click(); return 1;');
}

(async () => {
  makeRepos();
  const made = await api('/projects', { name: 'magi-github-live', root: OURS });
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
  ok('state, agents and GitHub accounts loaded', await waitFor(c, '!!(CODE.state && CODE.agents && CODE.gh)'));

  try {
    // ── 1. adding a token ──────────────────────────────────────────────────
    if (want('accounts')) {
      console.log('\nAccounts > GitHub');
      await evalJs(c, 'setView("accounts"); loadAccounts(); return 1;');
      ok('the GitHub section is there', await waitFor(c, '[...document.querySelectorAll(".acc-name")].some(n=>n.textContent==="GitHub accounts")', 15000));
      const addBtn = '[...document.querySelectorAll(".acc-actions .navitem")].find(b=>/token/.test(b.textContent))';
      await evalJs(c, `${addBtn}.click(); return 1;`);
      ok('the add sheet opens', await waitFor(c, '!!document.querySelector(".code-gh-token")', 3000));
      ok('the field is masked', await evalJs(c, 'document.querySelector(".code-gh-token").type') === 'password');
      await shot(c, 'github-add-desktop');
      const type = (v) => evalJs(c, `const i=document.querySelector(".code-gh-token"); i.value=${JSON.stringify(v)}; return 1;`);
      const go = () => evalJs(c, '[...document.querySelectorAll(".sheet .btn.active")].pop().click(); return 1;');
      const errText = () => evalJs(c, '(document.querySelector(".sheet .sheet-err")||{}).textContent || ""');
      await type('not a token'); await go();
      ok('a malformed token is refused with a sentence', await waitFor(c, '/does not look like a GitHub token/.test((document.querySelector(".sheet .sheet-err")||{}).textContent||"")', 8000), await errText());
      const bogus = 'github_pat_' + rnd(70);
      await type(bogus); await go();
      ok('GitHub itself refuses a fake token', await waitFor(c, '/did not accept this token/.test((document.querySelector(".sheet .sheet-err")||{}).textContent||"")', 20000), await errText());
      ok('the field was emptied when it was sent', await evalJs(c, 'document.querySelector(".code-gh-token").value') === '');
      ok('the token is nowhere in the page', !(await evalJs(c, 'document.documentElement.outerHTML')).includes(bogus));
      ok('and was not stored', !(await api('/github/accounts', null, 'GET')).accounts.some((a) => a.login === FAKE_LOGIN));
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await sleep(500);
      ok('the sheet fits a phone', await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth') <= 0);
      const fs16 = await evalJs(c, 'getComputedStyle(document.querySelector(".code-gh-token")).fontSize');
      ok('the field will not zoom iOS', fs16 === '16px', fs16);
      await shot(c, 'github-add-phone');
      await evalJs(c, '[...document.querySelectorAll(".sheet .btn")].find(b=>b.textContent==="Cancel").click(); return 1;');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await evalJs(c, 'setView("council"); return 1;');
      await sleep(500);
    }

    // ── 2. push from the repository line ───────────────────────────────────
    if (want('line')) {
      console.log('\nPush ↑n from the repository line');
      fs.writeFileSync(path.join(OURS, 'line.txt'), 'pushed from the line\n');
      git(OURS, 'add', '--', 'line.txt'); git(OURS, 'commit', '-qm', 'line push');
      await refreshLine(c, PID);
      ok('the line offers Push ↑1', await waitFor(c, '[...document.querySelectorAll(".code-git-act")].some(b=>b.textContent==="Push ↑1")', 10000), await gitLine(c));
      ok('the Repository pill says it is not on GitHub', /not on GitHub/.test(await evalJs(c, 'document.getElementById("codeStrip").textContent')));
      await shot(c, 'github-line-ahead');
      await evalJs(c, '[...document.querySelectorAll(".code-git-act")].find(b=>/Push/.test(b.textContent)).click(); return 1;');
      ok('it says what it pushed', await waitFor(c, '/Pushed 1 commit to origin \\(main\\)/.test((document.querySelector(".code-git")||{}).textContent||"")', 30000), await gitLine(c));
      ok('origin has the commit', git(BARE, 'rev-parse', 'main') === git(OURS, 'rev-parse', 'HEAD'));
      ok('the line is back to ↑0 with no Push', await waitFor(c, '/↑0/.test((document.querySelector(".code-git")||{}).textContent||"") && !document.querySelector(".code-git-act")', 10000), await gitLine(c));
    }

    // ── 3. push from the card, on a phone ──────────────────────────────────
    if (want('card')) {
      console.log('\nApprove, commit, push -- at 390px');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await sleep(500);
      await runTask(c, 'In calc.py, make total() ignore None values in xs. Change only that function.', ['claude-cli']);
      ok('an approval card appears', await waitFor(c, '!!document.querySelector(".code-appr.is-open")', 240000),
         await evalJs(c, '(document.querySelector(".code-task-st")||{}).textContent || ""'));
      await evalJs(c, 'document.querySelector(".code-approve").click(); return 1;');
      ok('applied', await waitFor(c, 'CODE.task && CODE.task.done && !!document.querySelector(".code-commit-open")', 60000));
      await evalJs(c, 'document.querySelector(".code-commit-open").click(); return 1;');
      await waitFor(c, '!!document.querySelector(".code-commit-msg")', 3000);
      await evalJs(c, '[...document.querySelectorAll(".code-commit .code-approve")][0].click(); return 1;');
      ok('committed, and Push is offered', await waitFor(c, '!!document.querySelector(".code-push .code-approve")', 30000));
      const card = await evalJs(c, 'document.querySelector(".code-push").textContent');
      ok('it says where, and never forced', /to origin/.test(card) && /Never forced/.test(card), card);
      const h = await evalJs(c, 'Math.round(document.querySelector(".code-push .code-approve").getBoundingClientRect().height)');
      ok('Push is thumb-sized', h >= 44, String(h));
      ok('no horizontal page scroll', await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth') <= 0);
      await shot(c, 'github-card-push-phone');
      const head = git(OURS, 'rev-parse', 'HEAD');
      await evalJs(c, 'document.querySelector(".code-push .code-approve").click(); return 1;');
      ok('the card says it pushed', await waitFor(c, '/Pushed 1 commit to origin/.test(document.querySelector(".code-appr").textContent)', 30000),
         await evalJs(c, 'document.querySelector(".code-appr").textContent.slice(-160)'));
      ok('origin has exactly that commit', git(BARE, 'rev-parse', 'main') === head);
      ok('the status line says pushed', /pushed/.test(await evalJs(c, 'document.querySelector(".code-task-st").textContent')));
      await shot(c, 'github-card-pushed-phone');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await evalJs(c, 'codeClearTask(); return 1;');
      await sleep(400);
    }

    // ── 4. an https remote needs an account, and the token goes to GitHub ──
    if (want('https')) {
      console.log('\nHTTPS: choose an account, push through askpass');
      git(OURS, 'remote', 'set-url', 'origin', 'https://github.com/magi-live-nobody-zz/nothing.git');
      fs.writeFileSync(path.join(OURS, 'https.txt'), 'x\n');
      git(OURS, 'add', '--', 'https.txt'); git(OURS, 'commit', '-qm', 'https push');
      await refreshLine(c, PID);
      ok('with no account the line asks for one instead of pushing',
         await waitFor(c, '[...document.querySelectorAll(".code-git-act")].some(b=>b.textContent==="Choose account to push")', 10000), await gitLine(c));
      ok('the pill shows owner/repo', /magi-live-nobody-zz\/nothing/.test(await evalJs(c, 'document.getElementById("codeStrip").textContent')));
      const direct = await api(`/projects/${PID}/push`, {});
      ok('the engine refuses it too', direct.error === 'no_account', direct.message);

      injectAccount();
      await evalJs(c, 'codeGhLoad().then(()=>renderCodeView()); return 1;');
      await sleep(600);
      // Since Phase 11 the pill on a github.com remote opens the Repository
      // panel; with no account chosen, the line's button is the way in.
      await evalJs(c, '[...document.querySelectorAll(".code-git-act")].find(b=>b.textContent==="Choose account to push").click(); return 1;');
      ok('"Choose account to push" opens the GitHub sheet', await waitFor(c, '!!document.querySelector(".code-gh-sheet")', 3000));
      ok('it names the repository', await waitFor(c, '/magi-live-nobody-zz\\/nothing on github\\.com/.test(document.querySelector(".code-gh-sheet").textContent)', 10000));
      await evalJs(c, `[...document.querySelectorAll(".code-gh-opt")].find(b=>b.textContent.startsWith(${JSON.stringify(FAKE_LOGIN)})).click(); return 1;`);
      await evalJs(c, '[...document.querySelectorAll(".sheet .btn.active")].pop().click(); return 1;');
      ok('saving asks GitHub what the account can do -- and GitHub refuses the fake token',
         await waitFor(c, '/did not accept this token/.test(document.querySelector(".code-gh-sheet").textContent)', 20000),
         await evalJs(c, 'document.querySelector(".code-gh-sheet").textContent.slice(-200)'));
      ok('the project remembers the login', (await api('/state', null, 'GET')).projects.find((p) => p.id === PID).prefs.github === FAKE_LOGIN);
      await shot(c, 'github-sheet');
      await evalJs(c, '[...document.querySelectorAll(".sheet .btn")].find(b=>b.textContent==="Close").click(); return 1;');
      await refreshLine(c, PID);
      ok('now the line offers Push, as that account',
         await waitFor(c, `[...document.querySelectorAll(".code-git-act")].some(b=>b.textContent==="Push ↑1") && /as ${FAKE_LOGIN}/.test(document.querySelector(".code-git").textContent)`, 10000), await gitLine(c));
      await evalJs(c, '[...document.querySelectorAll(".code-git-act")].find(b=>/Push/.test(b.textContent)).click(); return 1;');
      ok('GitHub refuses the fake token, and the line says so in words',
         await waitFor(c, `/GitHub refused ${FAKE_LOGIN} for magi-live-nobody-zz\\/nothing/.test(document.querySelector(".code-git").textContent)`, 60000), await gitLine(c));
      const cfg = fs.readFileSync(path.join(OURS, '.git', 'config'), 'utf8');
      ok('the token is not in .git/config', !cfg.includes(FAKE_TOKEN));
      ok('nor anywhere in the page', !(await evalJs(c, 'document.documentElement.outerHTML')).includes(FAKE_TOKEN));
      const gcm = execFileSync('cmdkey', ['/list'], { encoding: 'utf8' });
      ok('Git Credential Manager was not handed it', !/magi-live-nobody-zz/.test(gcm));
      await shot(c, 'github-https-refused');

      console.log('\nRemove');
      await evalJs(c, 'setView("accounts"); loadAccounts(); return 1;');
      await waitFor(c, `[...document.querySelectorAll(".acc-slot-name")].some(n=>n.textContent===${JSON.stringify(FAKE_LOGIN)})`, 10000);
      await evalJs(c, `[...document.querySelectorAll(".acc-slot")].find(r=>r.textContent.includes(${JSON.stringify(FAKE_LOGIN)})).querySelector(".navitem.danger").click(); return 1;`);
      ok('removal is confirmed in-page', await waitFor(c, '/Remove GitHub account/.test((document.querySelector(".sheet .sheet-hd")||{}).textContent||"")', 3000));
      await evalJs(c, '[...document.querySelectorAll(".sheet .btn.active")].pop().click(); return 1;');
      ok('the row goes', await waitFor(c, `![...document.querySelectorAll(".acc-slot-name")].some(n=>n.textContent===${JSON.stringify(FAKE_LOGIN)})`, 10000));
      ok('and the credential is deleted from the store', !fakeStored());
    }

    ok('no uncaught exceptions', errs.length === 0, errs.join(' | ').slice(0, 300));
  } finally {
    await api(`/github/accounts/${FAKE_LOGIN}`, null, 'DELETE').catch(() => {});
    await api(`/projects/${PID}`, null, 'DELETE').catch(() => {});
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`);
    c.ws.close();
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(2); });
