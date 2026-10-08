// LIVE test -- Track V4: branches and pull requests. On the REAL engine.
// Run: node tests/live/magi-code-v4.live.js     (not run by run-all.js)
//
//   local   a scratch repository with a bare local origin: a Codex Write
//           task proposes COMMIT:/BRANCH:; Commit on a new branch; Push sets
//           its upstream on origin; the branch list; switch back; a switch
//           that would overwrite work is refused; A1 refuses; a non-GitHub
//           remote cannot get a pull request
//   github  a clone of anthonyn99/magi-push-test in %TEMP%: make a branch,
//           commit, push, Open pull request (a REAL one), press again (the
//           same one comes back); then the pull request is CLOSED and the
//           branch DELETED on GitHub, and the clone removed
//   ui      the console: the Branch sheet, the commit form's branch choice,
//           the card's Open pull request; 390px
// LIVE_ONLY=local,github,ui
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'http://127.0.0.1:8000/api/code';
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);
const A1 = path.resolve(__dirname, '..', '..');
const PY = path.join(A1, 'magi', '.venv', 'Scripts', 'python.exe');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 300) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 600) + ']' : '')); }
};
const api = async (p, body, method) => {
  const r = await fetch(API + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const BASE = path.join(os.tmpdir(), 'magi-sandbox');
const LOCAL = path.join(BASE, 'v4-local');
const ORIGIN = path.join(BASE, 'v4-origin.git');
const GHPARENT = path.join(BASE, 'v4-gh');

async function run(body, onEvent, ms = 600000) {
  const r = await api('/tasks', body);
  if (!r.ok) return { refused: r, events: [], result: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const events = [];
  try {
    const s = await fetch(`${API}/tasks/${r.task.id}/stream`, { signal: ctl.signal });
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of s.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        events.push(ev);
        if (onEvent) await onEvent(ev, r.task, events);
        if (ev.k === 'end') return { task: r.task, events, result: ev.result };
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally { clearTimeout(timer); }
  return { task: r.task, events, result: null };
}

// GitHub cleanup, as the account MAGI holds (the token never leaves Python).
function ghCleanup(repo, number, branch) {
  const code = `
import httpx, sys
from magi.github import accounts as A
tok = A.token("anthonyn99")
h = {"Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10"}
out = []
if ${Number(number) || 0}:
    r = httpx.patch("https://api.github.com/repos/${repo}/pulls/${Number(number) || 0}", headers=h, json={"state": "closed"})
    out.append(f"close {r.status_code}")
r = httpx.delete("https://api.github.com/repos/${repo}/git/refs/heads/${branch}", headers=h)
out.append(f"delete {r.status_code}")
print(" ".join(out))
`;
  return execFileSync(PY, ['-c', code], { encoding: 'utf8', cwd: A1, env: { ...process.env, PYTHONPATH: A1 } }).trim();
}

(async () => {
  const made = [];
  try {
    const st = await api('/state');
    ok('the engine has branches', (st.features || []).includes('branches'), (st.features || []).join(','));

    if (want('local')) {
      console.log('\nA scratch repository with a bare local origin');
      fs.rmSync(LOCAL, { recursive: true, force: true }); fs.rmSync(ORIGIN, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', ORIGIN]);
      fs.mkdirSync(LOCAL, { recursive: true });
      git(LOCAL, 'init', '-q', '-b', 'main');
      git(LOCAL, 'config', 'user.name', 'magi-live'); git(LOCAL, 'config', 'user.email', 'magi-live@localhost');
      git(LOCAL, 'config', 'core.autocrlf', 'false');
      fs.writeFileSync(path.join(LOCAL, 'limits.py'), 'MAX_ITEMS = 10\n');
      git(LOCAL, 'add', '-A'); git(LOCAL, 'commit', '-qm', 'init');
      git(LOCAL, 'remote', 'add', 'origin', ORIGIN); git(LOCAL, 'push', '-q', '-u', 'origin', 'main');
      const p = await api('/projects', { name: 'v4-local', root: LOCAL });
      made.push(p.project && p.project.id);
      const PID = p.project.id;

      let card = null;
      const x = await run({ project_id: PID, mode: 'write', agents: ['codex-cli'],
        prompt: 'Raise MAX_ITEMS in limits.py from 10 to 25. Change nothing else.' },
      async (ev, task) => { if (ev.k === 'approval') { card = ev; await api(`/tasks/${task.id}/approve`, { approve: true }); } });
      ok('applied', x.result && x.result.write === 'applied', x.result && (x.result.write || x.result.detail));
      const sug = x.result || {};
      ok('the agent proposed a branch', /^[a-z0-9][a-z0-9/._-]*$/.test(sug.branch || ''), sug.branch);
      ok('and a commit subject (the draft starts with it, not the prompt)',
        !!sug.draft && !/^Raise MAX_ITEMS in limits\.py from 10 to 25/.test(sug.draft), (sug.draft || '').split('\n')[0]);
      ok('the lines are out of the summary', !/^\s*(COMMIT|BRANCH)\s*:/im.test(sug.text || ''), (sug.text || '').slice(-120));
      const br = sug.branch || 'raise-max-items';
      const c = await api(`/tasks/${x.task.id}/commit`, { message: (sug.draft || 'Raise MAX_ITEMS').split('\n')[0], branch: br });
      ok('committed on the new branch', c.ok && c.commit && c.commit.branch === br, c.message || JSON.stringify(c).slice(0, 200));
      ok('the folder is on it now', git(LOCAL, 'branch', '--show-current') === br);
      ok('main is untouched', git(LOCAL, 'log', '-1', '--format=%s', 'main') === 'init');
      const pu = await api(`/tasks/${x.task.id}/push`, {});
      ok('pushed, upstream set', pu.ok && pu.push && pu.push.branch === br, pu.message || JSON.stringify(pu).slice(0, 200));
      ok('origin has the branch', git(ORIGIN, 'rev-parse', '--verify', '-q', `refs/heads/${br}`).length === 40);
      const pr = await api(`/tasks/${x.task.id}/pr`, {});
      ok('a non-GitHub remote cannot get a pull request, and says why', pr.ok === false && pr.error === 'not_github', pr.message);

      const bl = await api(`/projects/${PID}/branches`);
      ok('the branch list has both, the new one current',
        bl.ok && bl.branches.some((b) => b.name === 'main') && bl.branches.find((b) => b.current).name === br,
        JSON.stringify((bl.branches || []).map((b) => b.name)));
      const back = await api(`/projects/${PID}/branch`, { name: 'main' });
      ok('switch back to main', back.ok && git(LOCAL, 'branch', '--show-current') === 'main', back.message);
      fs.writeFileSync(path.join(LOCAL, 'limits.py'), 'MAX_ITEMS = 99\n');
      const dirty = await api(`/projects/${PID}/branch`, { name: br });
      ok('a switch that would overwrite your work is refused',
        dirty.ok === false && dirty.error === 'dirty' && git(LOCAL, 'branch', '--show-current') === 'main', dirty.message);
      ok('...and your work is still there', fs.readFileSync(path.join(LOCAL, 'limits.py'), 'utf8') === 'MAX_ITEMS = 99\n');
      const bad = await api(`/projects/${PID}/branch`, { name: '-x', create: true });
      ok('a bad name is refused', bad.ok === false && bad.error === 'bad_branch', bad.message);
      const a1 = (st.projects || []).find((q) => q.name === 'A1');
      if (a1) {
        const r = await api(`/projects/${a1.id}/branch`, { name: 'never', create: true });
        ok('A1 never switches branch', r.ok === false && r.error === 'read_only_project', r.message);
      }
    }

    if (want('github')) {
      console.log('\nA real pull request on anthonyn99/magi-push-test (closed and deleted after)');
      fs.rmSync(GHPARENT, { recursive: true, force: true });
      fs.mkdirSync(GHPARENT, { recursive: true });
      const cl = await api('/github/clone', { account: 'anthonyn99', full_name: 'anthonyn99/magi-push-test',
                                              parent: GHPARENT, name: 'v4-gh' });
      ok('cloned and registered', cl.ok && cl.project, cl.message);
      if (cl.ok) {
        made.push(cl.project.id);
        const PID = cl.project.id;
        const ROOT = path.join(GHPARENT, 'magi-push-test');
        git(ROOT, 'config', 'user.name', 'magi-live'); git(ROOT, 'config', 'user.email', 'magi-live@localhost');
        const BR = 'magi-v4-live-' + Date.now().toString(36);
        let number = 0;
        try {
          const mk = await api(`/projects/${PID}/branch`, { name: BR, create: true });
          ok('made a branch', mk.ok && mk.created, mk.message);
          fs.writeFileSync(path.join(ROOT, 'v4-live.txt'), `MAGI V4 live test ${new Date().toISOString()}\n`);
          git(ROOT, 'add', 'v4-live.txt'); git(ROOT, 'commit', '-qm', 'MAGI V4 live test: a throwaway change');
          const pu = await api(`/projects/${PID}/push`, {});
          ok('pushed as the project\'s account', pu.ok && pu.push && pu.push.by === 'anthonyn99', pu.message || (pu.push && pu.push.text));
          const pr = await api(`/projects/${PID}/pr`, { body: 'Opened by MAGI\'s V4 live test; closed straight after.' });
          ok('a pull request was opened', pr.ok && pr.pr && /\/pull\/\d+$/.test(pr.pr.url || ''), pr.message || JSON.stringify(pr).slice(0, 300));
          number = pr.ok ? pr.pr.number : 0;
          ok('into the default branch, from the new one', pr.ok && pr.pr.base === 'main' && pr.pr.head === BR,
            pr.ok && `${pr.pr.head} -> ${pr.pr.base}`);
          const again = await api(`/projects/${PID}/pr`, {});
          ok('pressing again returns the same one', again.ok && again.pr.number === number && again.pr.existing === true,
            again.message || (again.pr && again.pr.number));
          await api(`/projects/${PID}/branch`, { name: 'main' });
          const fromMain = await api(`/projects/${PID}/pr`, {});
          ok('the default branch itself is never proposed', fromMain.ok === false && fromMain.error === 'default_branch', fromMain.message);
        } finally {
          let res = '';
          try { res = ghCleanup('anthonyn99/magi-push-test', number, BR); } catch (e) { res = String(e).slice(0, 200); }
          ok('cleaned up on GitHub (PR closed, branch deleted)', /delete 204/.test(res) && (!number || /close 200/.test(res)), res);
        }
      }
    }

    if (want('ui')) await ui();
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e && e.stack || e));
  } finally {
    for (const id of made) if (id) await api(`/projects/${id}`, null, 'DELETE').catch(() => {});
    for (const d of [LOCAL, ORIGIN, GHPARENT]) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

// ── the console ──────────────────────────────────────────────────────────

async function ui() {
  const { connect, evalJs, sleep, shotPath, PAGES_URL } = require('./cdp.js');
  console.log('\nThe console: Branch sheet, the commit form, Open pull request, 390px');
  // A scratch project for the sheet (registered for real; the sheet reads it).
  const dir = path.join(BASE, 'v4-ui');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.name', 'x'); git(dir, 'config', 'user.email', 'x@x');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  git(dir, 'branch', 'feature-x');
  const p = await api('/projects', { name: 'v4-ui', root: dir });
  const PID = p.project.id;
  const STUB = `if (window.top === window) (() => {
    const real = window.fetch;
    window.fetch = async (u, o) => {
      const s = String(u && u.url ? u.url : u);
      if (s.indexOf('/auth/journal/status') >= 0)
        return new Response(JSON.stringify({ ok: true, hasLock: false }), { headers: { 'Content-Type': 'application/json' } });
      return real(u, o);
    };
  })();`;
  const c = await connect();
  const waitFor = async (expr, ms = 25000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (await evalJs(c, expr)) return true; } catch {} await sleep(250); }
    return false;
  };
  const shot = async (name) => {
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
  };
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const mm = JSON.parse(ev.data);
    if (mm.method === 'Runtime.exceptionThrown') errs.push(mm.params.exceptionDetails.exception?.description || mm.params.exceptionDetails.text);
  });
  const sc = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  try {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: PAGES_URL }); await sleep(2500);
    await evalJs(c, 'localStorage.clear(); sessionStorage.clear(); return 1;');
    await c.send('Page.navigate', { url: PAGES_URL });
    ok('engine online', await waitFor('online()'));
    await evalJs(c, '$("navCodeNew").click(); return 1;');
    ok('code state loaded', await waitFor('!!CODE.state && codeEngineHas("branches")'));
    await evalJs(c, `codeSetProject(${JSON.stringify(PID)}); renderCodeView(); return 1;`);
    ok('the branch name is a button', await waitFor('!!document.querySelector("#codeView button.code-git-br, button.code-git-br")'));
    await evalJs(c, 'document.querySelector("button.code-git-br").click(); return 1;');
    ok('the Branch sheet opens', await waitFor('!!document.querySelector(".br-sheet")'));
    ok('it lists both branches, main current', await waitFor(
      '[...document.querySelectorAll(".br-sheet .br-row")].length === 2 && /you are here/.test([...document.querySelectorAll(".br-sheet .br-row")].find((r) => r.querySelector(".br-name").textContent === "main").textContent)'));
    await shot('v4-branch-sheet');
    await evalJs(c, '[...document.querySelectorAll(".br-sheet .br-row")].find((r) => r.querySelector(".br-name").textContent === "feature-x").querySelector("button").click(); return 1;');
    ok('Switch moves the folder', await waitFor('/you are here/.test([...document.querySelectorAll(".br-sheet .br-row")].find((r) => r.querySelector(".br-name").textContent === "feature-x").textContent)'));
    ok('...really', git(dir, 'branch', '--show-current') === 'feature-x');
    await evalJs(c, 'const i = document.querySelector(".br-sheet .sheet-in"); i.value = "made-in-sheet"; [...document.querySelectorAll(".br-sheet .btn")].find((b) => b.textContent === "Make and switch").click(); return 1;');
    ok('Make and switch makes one', await waitFor('[...document.querySelectorAll(".br-sheet .br-name")].some((n) => n.textContent === "made-in-sheet")'));
    ok('...really', git(dir, 'branch', '--show-current') === 'made-in-sheet');
    await evalJs(c, 'document.querySelector(".br-sheet").closest(".sheet").remove(); return 1;');

    // The commit form and the PR button, from real-shaped events.
    const card = await evalJs(c, `return (() => {
      const t = { id: "fake", projectId: ${JSON.stringify(PID)}, done: true, events: [], result: { write: "applied" } };
      const applied = { k: "applied", files: ["a.txt"], how: "clean", draft: "Raise the limit", branch: "raise-the-limit" };
      t.commitOpen = true; t.commitMsg = applied.draft;
      const host = document.createElement("div"); host.id = "v4card";
      host.style.cssText = "position:fixed;left:0;top:0;width:100%;z-index:9999;background:var(--bg)";
      host.append(renderCodeCommit(t, applied, null));
      host.append(renderCodePr(t, { branch: "raise-the-limit", text: "Pushed." }));
      document.body.append(host);
      window.__t4 = t;
      return [...host.querySelectorAll(".code-rw-b")].map((b) => b.textContent).join("|") + " / "
        + [...host.querySelectorAll(".code-approve")].map((b) => b.textContent).join("|"); })();`);
    ok('the commit form offers this branch or a new one', /^On made-in-sheet\|On a new branch/.test(card), card);
    ok('and Open pull request after a push', /Open pull request/.test(card), card);
    await evalJs(c, `return (() => { const t = window.__t4; t.commitBrMode = "new";
      const host = document.querySelector("#v4card"); host.textContent = "";
      host.append(renderCodeCommit(t, { files: ["a.txt"], draft: "x", branch: "raise-the-limit" }, null)); return 1; })();`);
    ok('choosing a new branch fills in the agent\'s name',
      await evalJs(c, 'document.querySelector("#v4card .code-commit-brname").value') === 'raise-the-limit');
    await shot('v4-commit-form');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    ok('390px: the commit form fits', await evalJs(c, 'document.querySelector("#v4card").scrollWidth <= innerWidth + 1'));
    await shot('v4-commit-form-390');
    await evalJs(c, 'document.querySelector("#v4card").remove(); return 1;');
    ok('390px: nothing overflows', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'));
    await evalJs(c, 'document.querySelector("button.code-git-br").click(); return 1;');
    ok('390px: the Branch sheet opens', await waitFor('!!document.querySelector(".br-sheet")'));
    await sleep(700);
    ok('390px: it fits', await evalJs(c, 'return (() => { const r = document.querySelector(".br-sheet").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; })();'));
    ok('390px: rows are fingertip-sized', await evalJs(c, '[...document.querySelectorAll(".br-sheet .br-row")].every((r) => r.getBoundingClientRect().height >= 36)'));
    await shot('v4-branch-sheet-390');
    ok('no page errors', errs.length === 0, errs.join(' | '));
  } finally {
    await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sc.result.identifier }).catch(() => {});
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    c.ws.close();
    await api(`/projects/${PID}`, null, 'DELETE').catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
