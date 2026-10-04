// LIVE test -- Track V: every agent moves/copies/deletes/searches, reads other
// workspaces ("Also read"), and may run the project's check. On the REAL
// engine, on two SCRATCH repositories in %TEMP%\magi-sandbox -- never A1.
// Run: node tests/live/magi-code-v.live.js     (not run by run-all.js)
//
//   refused   refs that are not registered workspaces here are refused
//   check     the "agents" switch on a project's check is stored and read back
//   find      a browser unit (Gemini) answers from a reference folder, via
//             NEED @name/... or FIND, and the transcript names it @name/...
//   codex     Codex answers from a reference folder at its path
//   ops       a browser unit renames + deletes with MOVE/DELETE blocks; the card
//             shows deleted + added; approved, the real folder has the move
//   ui        the console: Also read pill + sheet, what Run sends, the Check
//             sheet's "While agents work", 390px. POST /tasks is stubbed here.
// Claude is NOT used (it may be at your cap; its side is proven offline by
// magi/tests/test_claude_cli_offline.py on the real CLI). Spends a few small
// requests on Gemini and one on Codex. LIVE_ONLY=refused,check,find,codex,ops,ui
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

const BASE = path.join(os.tmpdir(), 'magi-sandbox');
const MAIN = path.join(BASE, 'vtrack-main');
const REF = path.join(BASE, 'vtrack-ref');
const SECRET = 'PLUM-' + Math.floor(1000 + Math.random() * 9000);

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

async function run(body, onEvent, ms = 480000) {
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

(async () => {
  let MPID = null, RPID = null;
  try {
    makeRepo(MAIN, { 'README.md': '# vtrack main\n', 'notes.txt': 'my notes\n', 'old.txt': 'old\n',
                     'app.py': 'print("main")\n' });
    makeRepo(REF, { 'README.md': '# vtrack reference project\n',
                    'lib/zebra.py': `def zebra_quux():\n    return "${SECRET}"\n`,
                    'lib/other.py': 'def unrelated():\n    return 0\n' });
    const m = await api('/projects', { name: 'vtrack-main', root: MAIN });
    const r = await api('/projects', { name: 'vtrack-ref', root: REF });
    if (!m.ok || !r.ok) { console.error('could not register the scratch repos', m, r); process.exit(2); }
    MPID = m.project.id; RPID = r.project.id;
    const st = await api('/state');
    ok('the engine takes refs', (st.features || []).includes('refs'), (st.features || []).join(','));

    if (want('refused')) {
      console.log('\nOnly registered workspaces can be read alongside');
      for (const [label, refs] of [['an unknown id', ['proj_nope']], ['a path', [REF]],
                                   ['not a list', RPID], ['too many', Array(9).fill(RPID)]]) {
        const x = await api('/tasks', { project_id: MPID, prompt: 'x', agents: [UNIT], refs });
        ok(`${label} is refused`, x.ok === false && x.error === 'refs', x.message);
      }
    }

    if (want('check')) {
      console.log('\nThe check: "Agents may run it"');
      const set = await api(`/projects/${MPID}/check`, { command: 'git status', auto: false, timeout_min: 5, agents: true });
      ok('stored on', set.ok && set.check.agents === true, JSON.stringify(set.check));
      const got = await api(`/projects/${MPID}/check`);
      ok('read back on', got.check && got.check.agents === true);
      const truthy = await api(`/projects/${MPID}/check`, { command: 'git status', agents: 'yes' });
      ok('only a real true turns it on', truthy.check && truthy.check.agents === false);
      await api(`/projects/${MPID}/check`, { command: '' });
    }

    const q = `The reference folder has a function named zebra_quux. What exact string does it `
      + `return? Reply with the string only.`;

    if (want('find')) {
      console.log(`\n${UNIT} answers from a reference folder`);
      const x = await run({ project_id: MPID, prompt: q, agents: [UNIT], mode: 'read', refs: [RPID] });
      const said = (x.result && x.result.text) || '';
      ok('it answered', x.result && x.result.outcome === 'ok', x.result && (x.result.detail || x.result.outcome));
      ok('with the value from the reference folder', said.includes(SECRET), said.slice(0, 200));
      ok('the transcript says it is reading @vtrack-ref',
        x.events.some((e) => e.k === 'note' && /@vtrack-ref/.test(e.text || '')));
      const asked = tools(x.events).filter((t) => /@vtrack-ref|Search/.test(t));
      console.log('        tools: ' + tools(x.events).join(' | '));
      ok('if it asked for more, it named @vtrack-ref/... or searched',
        asked.length > 0 || said.includes(SECRET), asked.join(' | ') || '(answered from the index and context)');
    }

    if (want('codex')) {
      console.log('\nCodex answers from a reference folder at its path');
      const x = await run({ project_id: MPID, prompt: q, agents: ['codex-cli'], mode: 'read', refs: [RPID] });
      const said = (x.result && x.result.text) || '';
      ok('it answered', x.result && x.result.outcome === 'ok', x.result && (x.result.detail || x.result.outcome));
      ok('with the value from the reference folder', said.includes(SECRET), said.slice(0, 200));
      console.log('        tools: ' + tools(x.events).slice(0, 8).join(' | '));
    }

    if (want('ops')) {
      console.log(`\n${UNIT} moves and deletes with MOVE / DELETE blocks`);
      let card = null;
      const x = await run({ project_id: MPID, mode: 'write', agents: [UNIT],
        prompt: 'Rename notes.txt to docs/notes.md and delete old.txt. Change nothing else.' },
      async (ev, task) => {
        if (ev.k === 'approval') {
          card = ev;
          await api(`/tasks/${task.id}/approve`, { approve: true });
        }
      });
      console.log('        tools: ' + tools(x.events).join(' | '));
      ok('a card came up', !!card, x.result && (x.result.detail || x.result.outcome));
      const files = card ? card.files.map((f) => `${f.status} ${f.path}`).sort() : [];
      ok('the card shows the move as deleted + added, and the delete',
        JSON.stringify(files) === JSON.stringify(['added docs/notes.md', 'deleted notes.txt', 'deleted old.txt']),
        files.join(', '));
      ok('applied', x.result && x.result.write === 'applied', x.result && x.result.write);
      ok('the real folder has the move',
        fs.existsSync(path.join(MAIN, 'docs', 'notes.md')) && !fs.existsSync(path.join(MAIN, 'notes.txt'))
        && !fs.existsSync(path.join(MAIN, 'old.txt')));
      ok('the content moved intact',
        fs.existsSync(path.join(MAIN, 'docs', 'notes.md'))
        && fs.readFileSync(path.join(MAIN, 'docs', 'notes.md'), 'utf8').replace(/\r\n/g, '\n') === 'my notes\n');
      ok('the reference folder is untouched', git(REF, 'status', '--porcelain') === '');
    }

    if (want('ui')) await ui(MPID, RPID);
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e && e.stack || e));
  } finally {
    if (MPID) await api(`/projects/${MPID}`, null, 'DELETE').catch(() => {});
    if (RPID) await api(`/projects/${RPID}`, null, 'DELETE').catch(() => {});
    for (const d of [MAIN, REF]) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

// ── the console ──────────────────────────────────────────────────────────

async function ui(MPID, RPID) {
  const { connect, evalJs, sleep, shotPath, PAGES_URL } = require('./cdp.js');
  console.log('\nThe console: Also read, what Run sends, the Check sheet, 390px');
  // POST /tasks is captured and refused: this part spends nothing.
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
    await evalJs(c, `codeSetProject(${JSON.stringify(MPID)}); renderCodeView(); return 1;`);
    const pill = '[...document.querySelectorAll("#codeStrip .code-pill")].find((p) => /Also read/.test(p.textContent))';
    ok('an Also read pill on the strip', await waitFor(`!!${pill}`));
    ok('it says none', /Also readnone/.test(await evalJs(c, `${pill}.textContent`)));
    await evalJs(c, `${pill}.click(); return 1;`);
    ok('the sheet opens', await waitFor('!!document.querySelector(".refs-sheet")'));
    const btn = `[...document.querySelectorAll(".refs-sheet .code-git-act")].find((b) => b.textContent === "vtrack-ref")`;
    ok('it lists the other workspace', await evalJs(c, `!!${btn}`));
    ok('but not this one', await evalJs(c, '![...document.querySelectorAll(".refs-sheet .code-git-act")].some((b) => b.textContent === "vtrack-main")'));
    await evalJs(c, `${btn}.click(); return 1;`);
    ok('ticking it marks it', await evalJs(c, `${btn}.getAttribute("aria-checked")`) === 'true');
    await shot('v-refs-sheet');
    await evalJs(c, '[...document.querySelectorAll(".refs-sheet .sheet-bar .btn")].find((b) => b.textContent === "Save").click(); return 1;');
    ok('the pill names it', await waitFor(`/Also readvtrack-ref/.test(${pill}.textContent)`));
    ok('kept on this device', await evalJs(c, `JSON.stringify(lsRead(CODE_REFS_KEY, {})[${JSON.stringify(MPID)}])`) === JSON.stringify([RPID]));

    // What Run sends.
    const ids = await evalJs(c, 'JSON.stringify(codeChain().map((m) => m.id))');
    await evalJs(c, `$("composer").value = "compare the two"; updateEnabled(); return 1;`);
    await evalJs(c, 'codeRun(); return 1;');
    ok('Run sent the refs', await waitFor('window.__sent.length > 0'));
    const sent = await evalJs(c, 'JSON.stringify(window.__sent[0])');
    ok('as the ids of the ticked workspaces', JSON.parse(sent || '{}').refs && JSON.parse(sent).refs[0] === RPID, sent);
    console.log('        chain: ' + ids);
    // A queued task sends them too.
    ok('a queued task carries them', await evalJs(c, `JSON.stringify(codeRefsBody(${JSON.stringify(MPID)}))`) === JSON.stringify({ refs: [RPID] }));

    // The Check sheet's new switch (the real engine's GET; nothing saved).
    const ck = '[...document.querySelectorAll("#codeStrip .code-pill")].find((p) => /Check/.test(p.textContent))';
    ok('a Check pill', await waitFor(`!!${ck}`));
    await evalJs(c, `${ck}.click(); return 1;`);
    ok('the check sheet opens', await waitFor('!!document.querySelector(".ck-sheet")'));
    ok('it offers "While agents work"', await waitFor('[...document.querySelectorAll(".ck-sheet .sheet-lbl")].some((l) => l.textContent === "While agents work")'));
    await evalJs(c, '[...document.querySelectorAll(".ck-sheet .code-git-act")].find((b) => b.textContent === "Agents may run it").click(); return 1;');
    ok('choosing it warns what it means', await waitFor('[...document.querySelectorAll(".ck-sheet .sheet-err")].some((e) => /runs code the agent just wrote/.test(e.textContent))'));
    await shot('v-check-sheet');
    await evalJs(c, 'document.querySelector(".ck-sheet").closest(".sheet").remove(); return 1;');

    // Phone.
    await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    ok('390px: nothing overflows', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'));
    await evalJs(c, `${pill}.click(); return 1;`);
    ok('390px: the sheet opens', await waitFor('!!document.querySelector(".refs-sheet")'));
    await sleep(700);             // the sheet's opening animation scales it
    const box = 'document.querySelector(".refs-sheet").getBoundingClientRect()';
    ok('390px: the sheet fits', await evalJs(c, `return (() => { const r = ${box}; return r.left >= 0 && r.right <= innerWidth + 1; })();`),
      await evalJs(c, `return (() => { const r = ${box}; return Math.round(r.left) + ".." + Math.round(r.right) + " of " + innerWidth; })();`));
    ok('390px: the buttons are fingertip-sized', await evalJs(c, `${btn}.getBoundingClientRect().height >= 28`),
      await evalJs(c, `${btn}.getBoundingClientRect().height`));
    await shot('v-refs-sheet-390');
    ok('no page errors', errs.length === 0, errs.join(' | '));
  } finally {
    await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sc.result.identifier }).catch(() => {});
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    c.ws.close();
  }
}
