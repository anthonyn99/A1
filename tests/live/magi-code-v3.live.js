// LIVE test -- Track V3: one Write task changes two workspaces. On the REAL
// engine, on two SCRATCH repositories in %TEMP%\magi-sandbox -- never A1.
// Run: node tests/live/magi-code-v3.live.js     (not run by run-all.js)
//
//   refused   writes that are unknown, a path, or the same repository refused
//   codex     Codex (elevated sandbox) edits both copies; one card, two
//             sections; approved, both real folders changed; Commit makes a
//             commit in each
//   unit      a browser unit (UNIT, default gemini) edits @other/... with its
//             blocks; the card shows @other/ paths; denied, nothing changes
//   ui        the console: Off|Read|Change in the sheet, what Run sends, the
//             card's sections, 390px. POST /tasks is stubbed here.
// Claude is NOT used (it may be at your cap; its flags are unit-tested).
// LIVE_ONLY=refused,codex,unit,ui
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'http://127.0.0.1:8000/api/code';
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);
const UNIT = process.env.UNIT || 'gemini';

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
const read = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null;

const BASE = path.join(os.tmpdir(), 'magi-sandbox');
const MAIN = path.join(BASE, 'v3-site');
const OTHER = path.join(BASE, 'v3-worker');

function makeRepo(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'magi-live');
  git(dir, 'config', 'user.email', 'magi-live@localhost');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}

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
const tools = (evs) => evs.filter((e) => e.k === 'tool').map((e) => `${e.name} ${e.target || ''}`);

const SITE_FILES = { 'README.md': '# v3 site\n', 'site/config.js': 'export const API_VERSION = 1;\n' };
const WORKER_FILES = { 'README.md': '# v3 worker\n', 'worker/version.py': 'API_VERSION = 1\n' };
const PROMPT = 'Bump API_VERSION from 1 to 2 in BOTH places: site/config.js in this project, '
  + 'and worker/version.py in the other workspace you may change (@v3-worker). Change nothing else.';

(async () => {
  let MPID = null, OPID = null, SUBPID = null;
  try {
    makeRepo(MAIN, SITE_FILES);
    makeRepo(OTHER, WORKER_FILES);
    const m = await api('/projects', { name: 'v3-site', root: MAIN });
    const o = await api('/projects', { name: 'v3-worker', root: OTHER });
    const sub = await api('/projects', { name: 'v3-site-sub', root: path.join(MAIN, 'site') });
    if (!m.ok || !o.ok || !sub.ok) { console.error('could not register the scratch repos', m, o, sub); process.exit(2); }
    MPID = m.project.id; OPID = o.project.id; SUBPID = sub.project.id;
    const st = await api('/state');
    ok('the engine takes writes', (st.features || []).includes('writes'), (st.features || []).join(','));

    if (want('refused')) {
      console.log('\nOnly registered workspaces, each its own repository');
      for (const [label, writes] of [['an unknown id', ['proj_nope']], ['a path', [OTHER]],
                                     ['a folder in the same repository', [SUBPID]]]) {
        const x = await api('/tasks', { project_id: MPID, prompt: 'x', agents: [UNIT], mode: 'write', writes });
        ok(`${label} is refused`, x.ok === false && x.error === 'writes', x.message);
      }
    }

    if (want('codex')) {
      console.log('\nCodex, Write, in its elevated sandbox: one change across two repositories');
      let card = null;
      const x = await run({ project_id: MPID, mode: 'write', agents: ['codex-cli'], writes: [OPID], prompt: PROMPT },
        async (ev, task) => {
          if (ev.k === 'approval') {
            card = ev;
            ok('nothing changed before the approval',
              read(path.join(MAIN, 'site/config.js')).includes('= 1') && read(path.join(OTHER, 'worker/version.py')).includes('= 1'));
            await api(`/tasks/${task.id}/approve`, { approve: true });
          }
        });
      console.log('        tools: ' + tools(x.events).slice(0, 10).join(' | '));
      ok('a card came up', !!card, x.result && (x.result.detail || x.result.outcome));
      const paths = card ? card.files.map((f) => f.path).sort() : [];
      ok('one card, both workspaces', JSON.stringify(paths) === JSON.stringify(['@v3-worker/worker/version.py', 'site/config.js']), paths.join(', '));
      ok('with a section each', card && (card.sections || []).map((s) => s.name).join('|') === '|v3-worker',
        card && JSON.stringify(card.sections || []).slice(0, 200));
      ok('applied', x.result && x.result.write === 'applied', x.result && (x.result.write + ' ' + (x.result.detail || '')));
      ok('the site changed', /API_VERSION = 2/.test(read(path.join(MAIN, 'site/config.js')) || ''));
      ok('the worker changed', /API_VERSION = 2/.test(read(path.join(OTHER, 'worker/version.py')) || ''));
      if (x.result && x.result.write === 'applied') {
        const c = await api(`/tasks/${x.task.id}/commit`, { message: 'Bump API_VERSION to 2' });
        ok('Commit makes one commit in each repository', c.ok && (c.commits || []).length === 2, c.message || JSON.stringify(c).slice(0, 200));
        ok('...in the site', git(MAIN, 'log', '-1', '--format=%s') === 'Bump API_VERSION to 2');
        ok('...and in the worker', git(OTHER, 'log', '-1', '--format=%s') === 'Bump API_VERSION to 2');
      }
      ok('no copies left behind', !fs.readdirSync(path.join(BASE, 'tony'), { withFileTypes: true })
        .some((d) => x.task && d.name.startsWith(x.task.id)));
    }

    if (want('unit')) {
      console.log(`\n${UNIT} edits the other workspace with @name/ blocks; denied`);
      let card = null;
      const before = read(path.join(OTHER, 'worker/version.py'));
      const x = await run({ project_id: MPID, mode: 'write', agents: [UNIT], writes: [OPID],
        prompt: 'In the other workspace you may change (@v3-worker), add a file worker/NOTES.md containing '
          + 'the single line "version notes". Change nothing in this project.' },
      async (ev, task) => {
        if (ev.k === 'approval') { card = ev; await api(`/tasks/${task.id}/approve`, { approve: false }); }
      });
      console.log('        tools: ' + tools(x.events).slice(0, 8).join(' | '));
      ok('a card came up', !!card, x.result && (x.result.detail || x.result.outcome));
      const f = card && card.files.find((y) => y.path === '@v3-worker/worker/NOTES.md');
      ok('it adds @v3-worker/worker/NOTES.md', !!f && f.status === 'added', card && card.files.map((y) => y.path).join(','));
      ok('never a folder called @v3-worker in the site', !fs.existsSync(path.join(MAIN, '@v3-worker')));
      ok('denied: the worker is unchanged', read(path.join(OTHER, 'worker/version.py')) === before
        && !fs.existsSync(path.join(OTHER, 'worker/NOTES.md')));
    }

    if (want('ui')) await ui(MPID, OPID);
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e && e.stack || e));
  } finally {
    for (const id of [MPID, OPID, SUBPID]) if (id) await api(`/projects/${id}`, null, 'DELETE').catch(() => {});
    for (const d of [MAIN, OTHER]) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

// ── the console ──────────────────────────────────────────────────────────

async function ui(MPID, OPID) {
  const { connect, evalJs, sleep, shotPath, PAGES_URL } = require('./cdp.js');
  console.log('\nThe console: Off | Read | Change, what Run sends, the card, 390px');
  const STUB = `if (window.top === window) (() => {
    const real = window.fetch;
    window.__sent = [];
    window.fetch = async (u, o) => {
      const s = String(u && u.url ? u.url : u);
      const m = ((o && o.method) || 'GET').toUpperCase();
      if (s.indexOf('/auth/journal/status') >= 0)
        return new Response(JSON.stringify({ ok: true, hasLock: false }), { headers: { 'Content-Type': 'application/json' } });
      if (/\\/api\\/code\\/tasks$/.test(s) && m === 'POST') {
        window.__sent.push(JSON.parse(o.body));
        return new Response(JSON.stringify({ ok: false, message: 'stubbed by the test' }),
          { headers: { 'Content-Type': 'application/json' } });
      }
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
    ok('code state loaded', await waitFor('!!CODE.state && !!CODE.agents'));
    ok('the console sees the writes feature', await waitFor('codeCanWrites()'));
    await evalJs(c, `codeSetProject(${JSON.stringify(MPID)}); CODE.rw = "write"; renderCodeView(); return 1;`);
    const pill = '[...document.querySelectorAll("#codeStrip .code-pill")].find((p) => /Also read/.test(p.textContent))';
    ok('the Also read pill', await waitFor(`!!${pill}`));
    await evalJs(c, `${pill}.click(); return 1;`);
    ok('the sheet opens', await waitFor('!!document.querySelector(".refs-sheet")'));
    const row = `[...document.querySelectorAll(".refs-sheet .refs-row")].find((r) => r.querySelector(".refs-row-name").textContent === "v3-worker")`;
    ok('a row for the other workspace with Off | Read | Change', await evalJs(c,
      `[...${row}.querySelectorAll(".code-rw-b")].map((b) => b.textContent).join("|")`) === 'Off|Read|Change');
    ok('Off is chosen to start', await evalJs(c, `${row}.querySelector(".code-rw-b.on").textContent`) === 'Off');
    await evalJs(c, `[...${row}.querySelectorAll(".code-rw-b")][2].click(); return 1;`);
    ok('Change is chosen', await evalJs(c, `${row}.querySelector(".code-rw-b.on").textContent`) === 'Change');
    await shot('v3-sheet');
    await evalJs(c, '[...document.querySelectorAll(".refs-sheet .sheet-bar .btn")].find((b) => b.textContent === "Save").click(); return 1;');
    ok('the pill says it changes', await waitFor(`/v3-worker \\(changes\\)/.test(${pill}.textContent)`),
      await evalJs(c, `${pill}.textContent`));
    ok('kept on this device', await evalJs(c, `JSON.stringify(lsRead(CODE_WRITES_KEY, {})[${JSON.stringify(MPID)}])`) === JSON.stringify([OPID]));

    await evalJs(c, `$("composer").value = "bump both"; updateEnabled(); return 1;`);
    await evalJs(c, 'codeRun(); return 1;');
    ok('Run sent', await waitFor('window.__sent.length > 0'));
    const sent = JSON.parse(await evalJs(c, 'JSON.stringify(window.__sent[0])') || '{}');
    ok('writes: the ticked workspace, mode write', JSON.stringify(sent.writes) === JSON.stringify([OPID]) && sent.mode === 'write',
      JSON.stringify(sent).slice(0, 200));

    // The card, drawn from a real-shaped approval event (nothing is sent).
    const EV = {
      k: 'approval', adds: 2, dels: 2, expires_at: Date.now() / 1000 + 300, timeout: 300,
      files: [
        { path: 'site/config.js', status: 'modified', adds: 1, dels: 1, diff: '@@ -1 +1 @@\n-export const API_VERSION = 1;\n+export const API_VERSION = 2;\n' },
        { path: '@v3-worker/worker/version.py', ws: 'v3-worker', status: 'modified', adds: 1, dels: 1, diff: '@@ -1 +1 @@\n-API_VERSION = 1\n+API_VERSION = 2\n' }],
      sections: [
        { name: '', main: true, project_id: MPID, paths: ['site/config.js'], adds: 1, dels: 1 },
        { name: 'v3-worker', main: false, project_id: OPID, paths: ['@v3-worker/worker/version.py'], adds: 1, dels: 1 }],
    };
    await evalJs(c, `return (() => {
      const t = { id: "fake", projectId: ${JSON.stringify(MPID)}, events: [${JSON.stringify(EV)}], done: false };
      const host = document.createElement("div"); host.id = "v3card";
      host.style.cssText = "position:fixed;left:0;top:0;width:100%;max-height:100vh;overflow:auto;z-index:9999;background:var(--bg)";
      host.append(renderCodeApproval(t, t.events[0])); document.body.append(host); return 1; })();`);
    const heads = await evalJs(c, 'JSON.stringify([...document.querySelectorAll("#v3card .code-appr-sec")].map((h) => h.textContent))');
    ok('the card has a section per workspace, main first', /v3-site · 1 file/.test(heads) && /@v3-worker · 1 file/.test(heads)
      && heads.indexOf('v3-site') < heads.indexOf('@v3-worker'), heads);
    ok('one Approve for both', await evalJs(c, 'document.querySelectorAll("#v3card .code-approve").length') === 1);
    await shot('v3-card');

    await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    ok('390px: the card fits', await evalJs(c, 'document.querySelector("#v3card").scrollWidth <= innerWidth + 1'));
    await shot('v3-card-390');
    await evalJs(c, 'document.querySelector("#v3card").remove(); return 1;');
    ok('390px: nothing overflows', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'));
    await evalJs(c, `${pill}.click(); return 1;`);
    ok('390px: the sheet opens', await waitFor('!!document.querySelector(".refs-sheet")'));
    await sleep(700);
    ok('390px: the sheet fits', await evalJs(c, 'return (() => { const r = document.querySelector(".refs-sheet").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; })();'));
    ok('390px: Off | Read | Change are fingertip-sized', await evalJs(c,
      `[...${row}.querySelectorAll(".code-rw-b")].every((b) => b.getBoundingClientRect().height >= 28)`));
    await shot('v3-sheet-390');
    ok('no page errors', errs.length === 0, errs.join(' | '));
  } finally {
    await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sc.result.identifier }).catch(() => {});
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    c.ws.close();
  }
}
