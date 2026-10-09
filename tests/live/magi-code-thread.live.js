// LIVE test -- the real console against the real engine (not run by run-all.js).
// Run: node tests/live/magi-code-thread.live.js   Screenshots: %TEMP%/magi-live-shots
//
// MAGI Track F, phase F4: Code Mode follow-ups in the console, through the UI.
// On a SCRATCH repository in %TEMP%\magi-sandbox -- never A1. One CLI agent
// (AGENT=codex by default: free, and Claude may be over your cap), about
// seven small requests:
//   1. turn 1 by Run: the box clears, the button becomes Send, the box docks
//   2. turn 2 by Follow up: same session, its CLI session resumed, remembers
//   3. a REAL mid-run message typed in the box: queued (the agent is not
//      stopped), edited through its bubble, then Interrupt now; the answer
//      follows the edited message
//   4. a Write turn: at the approval card, a message in the box = revise --
//      the first card resolves "sent back", a second card, Approve applies it
//   5. History: ONE entry, "n turns"; New session empties and undocks;
//      reopening brings every turn back with an EMPTY box labelled Follow up,
//      and a real follow-up from the reopened session remembers turn 1
//   6. a pre-Track-F entry (one row, no sid, no body anywhere) opens as a
//      one-turn session with "no longer stored"; a session loaded from the
//      CLOUD that another engine ran (fake Firestore) continues from its
//      transcript -- a real follow-up must use it
//   7. 390px: the docked box on screen, no horizontal scroll
// LIVE_ONLY=basic,midrun,revise,history,cloud,phone.
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const URL = require('./cdp.js').PAGES_URL;
const API = 'http://127.0.0.1:8000/api/code';
const WHO = (process.env.AGENT || 'codex').startsWith('claude') ? 'claude' : 'codex';
const want = (k) => !process.env.LIVE_ONLY || process.env.LIVE_ONLY.split(',').includes(k);
const STUB = `(()=>{if(window.top!==window)return;const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 200) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 400) + ']' : '')); }
};
const api = async (p, body, method) => {
  const r = await fetch(API + p, { method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(300);
  }
  return false;
};
const size = (c, w, h, phone) => c.send('Emulation.setDeviceMetricsOverride',
  { width: w, height: h, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
const type = (c, text) => evalJs(c, `$("composer").value = ${JSON.stringify(text)}; updateEnabled(); return 1;`);
const send = (c) => evalJs(c, 'codeRun(); return 1;');
const label = (c) => evalJs(c, '$("btnSend").textContent');
const docked = (c) => evalJs(c, '$("qbar").classList.contains("docked")');
const idle = '!!CODE.task && CODE.task.done';
const answer = (c) => evalJs(c, 'codeTaskText(CODE.task)');

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const REPO = path.join(os.tmpdir(), 'magi-sandbox', 'magi-thread-live');
function makeRepo() {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, 'init', '-q');
  git(REPO, 'config', 'user.name', 'magi-live');
  git(REPO, 'config', 'user.email', 'magi-live@localhost');
  git(REPO, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(REPO, 'README.md'), '# scratch\n\nA tiny project for a live test.\n');
  fs.writeFileSync(path.join(REPO, 'app.py'), 'x = 1\nprint(x)\n');
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-qm', 'init');
}

(async () => {
  let PID = null;
  const c = await connect();
  const errs = [];
  try {
    makeRepo();
    const made = await api('/projects', { name: 'magi-thread-live', root: REPO });
    if (!made.ok) throw new Error('could not register the scratch repo: ' + JSON.stringify(made));
    PID = made.project.id;

    await c.send('Page.enable'); await c.send('Runtime.enable');
    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
    await size(c, 1440, 900, false);
    await c.send('Page.navigate', { url: URL });
    ok('engine online', await waitFor(c, 'online()', 30000));
    await evalJs(c, 'setMode("code"); return 1;');
    ok('Code Mode loaded, with followup + steer',
       await waitFor(c, `!!CODE.state && codeEngineHas("followup") && codeEngineHas("steer") && CODE.state.projects.some(p => p.id === ${JSON.stringify(PID)})`, 30000));
    // This test's own browser profile: only the one CLI agent ticked. Not
    // codeToggle -- nothing here is Tony's choice to save.
    const agent = await evalJs(c, `return (() => { const m = codeMembers().find(x => x.kind === "cli" && x.id.startsWith(${JSON.stringify(WHO)}));
      if (!m) return ""; CODE.picks = { on: [m.id], known: codeMembers().map(x => x.id) };
      codeClearTask(); codeSetProject(${JSON.stringify(PID)}); CODE.rw = "read"; renderCodeView(); updateEnabled(); return m.id; })()`);
    ok(`one ${WHO} CLI agent ticked`, !!agent, agent);
    ok('an empty session: Run, box on top', (await label(c)) === 'Run' && !(await docked(c)));

    let T1 = null;
    if (want('basic') || want('history') || want('revise') || want('midrun')) {
      // -- 1. turn 1 ------------------------------------------------------------
      console.log('\n1. Turn 1');
      await type(c, 'Read README.md and tell me in one sentence what this project is. By the way, my favourite fruit is kiwi.');
      await send(c);
      ok('turn 1 starts', await waitFor(c, '!!CODE.task && !CODE.task.done', 15000));
      ok('the box is cleared on send', (await evalJs(c, '$("composer").value')) === '');
      await type(c, 'x');
      ok('while it runs the button says Send (a message to it)', (await label(c)) === 'Send');
      await type(c, '');
      ok('the box docks under the task', await docked(c));
      ok('turn 1 lands', await waitFor(c, idle, 6 * 60000));
      T1 = await evalJs(c, 'CODE.session.id');
      ok('one finished turn; the session id is the task id',
         await evalJs(c, 'CODE.session.turns.length === 1 && CODE.session.id === CODE.task.id'));
      ok('then the button says Follow up', (await label(c)) === 'Follow up');
      await shot(c, 'code-thread-turn1');

      // -- 2. turn 2 ------------------------------------------------------------
      console.log('\n2. Turn 2, a follow-up');
      await type(c, 'What did I say my favourite fruit is? Reply with the fruit only.');
      await send(c);
      ok('turn 2 starts as turn 2 of the session', await waitFor(c,
        `!!CODE.task && CODE.task.turn === 2 && CODE.task.sid === ${JSON.stringify(T1)}`, 20000));
      ok('turn 1 is a compact card above it', await evalJs(c, 'document.querySelectorAll(".code-thread .code-task.is-earlier").length === 1'));
      ok('turn 2 lands', await waitFor(c, idle, 6 * 60000));
      ok('it continued its own CLI session', await evalJs(c,
        'CODE.task.events.some(e => e.k === "note" && /continues its own session/.test(e.text || ""))'));
      const a2 = await answer(c);
      ok('it remembered (kiwi)', /kiwi/i.test(a2), a2);
    }

    if (want('midrun')) {
      // -- 3. a real mid-run message ---------------------------------------------
      console.log('\n3. A message while it runs');
      await type(c, 'Without reading any files, write a 1500-word essay on why READMEs matter, in twelve paragraphs.');
      await send(c);
      ok('turn 3 starts', await waitFor(c, '!!CODE.task && !CODE.task.done && CODE.task.turn === 3', 20000));
      ok('the agent is working', await waitFor(c,
        'CODE.task.events.some(e => e.k === "note" && /is reading the workspace/.test(e.text || ""))', 60000));
      await sleep(500);
      await type(c, 'Stop the essay. Instead reply with exactly one word: PELIKAN');
      ok('the button says Send', (await label(c)) === 'Send');
      await send(c);
      // Live steering (2026-10-09): queued -- the agent is not stopped.
      ok('the engine queued it', await waitFor(c,
        'CODE.task.events.some(e => e.k === "user" && e.how === "queued" && e.id)', 20000),
        await evalJs(c, 'JSON.stringify(CODE.task.events.filter(e => e.k === "user"))'));
      const BUB = 'document.querySelector(".code-thread .code-task:not(.is-earlier) .code-log .code-user")';
      ok('a queued bubble with Edit, ✕ and Interrupt now', await evalJs(c,
        `(() => { const b = ${BUB}; return !!b && /queued/.test(b.textContent)
          && [...b.querySelectorAll("button")].map(x => x.textContent).join("|") === "Edit|✕|Interrupt now"; })()`));
      await shot(c, 'code-thread-queued');
      // Edit it through the bubble: the typo becomes PELICAN.
      await evalJs(c, `[...${BUB}.querySelectorAll("button")].find(x => x.textContent === "Edit").click(); return 1;`);
      ok('Edit opens the text in place', await waitFor(c, `!!${BUB}.querySelector("textarea")`, 3000));
      await evalJs(c, `(() => { const ta = ${BUB}.querySelector("textarea");
        ta.value = "Stop the essay. Instead reply with exactly one word: PELICAN";
        ta.dispatchEvent(new Event("input"));
        [...${BUB}.querySelectorAll("button")].find(x => x.textContent === "Save").click(); return 1; })()`);
      ok('the edit reached the engine', await waitFor(c,
        'CODE.task.events.some(e => e.k === "msg_edit" && /PELICAN/.test(e.text))', 10000));
      await evalJs(c, `[...${BUB}.querySelectorAll("button")].find(x => x.textContent === "Interrupt now").click(); return 1;`);
      ok('Interrupt now stopped the current step', await waitFor(c,
        'CODE.task.events.some(e => e.k === "note" && /Interrupting/.test(e.text || ""))', 15000));
      ok('the bubble says it was sent', await waitFor(c,
        `/sent/.test(${BUB}.querySelector(".turn-note-tag").textContent) && !${BUB}.querySelector("button")`, 30000));
      await shot(c, 'code-thread-message');
      ok('turn 3 lands', await waitFor(c, idle, 6 * 60000));
      ok('no stop-and-resume: one attempt', await evalJs(c,
        '!CODE.task.events.some(e => e.k === "interrupt") && (CODE.task.result.attempts || []).length === 1'));
      const a3 = await answer(c);
      ok('the answer follows the edited message', /PELICAN/.test(a3) && a3.length < 400, a3.slice(0, 200));
    }

    if (want('revise')) {
      // -- 4. a Write turn, revised at the card ------------------------------------
      console.log('\n4. Write, and a message at the card revises it');
      await evalJs(c, 'CODE.rw = "write"; CODE.ap = "manual"; renderCodeView(); updateEnabled(); return 1;');
      ok('Write: the button says Follow up · edits', /edits/.test(await label(c)), await label(c));
      await type(c, 'Add one line `y = 2` at the end of app.py. Change nothing else.');
      await send(c);
      ok('the approval card comes up', await waitFor(c,
        'CODE.task && !CODE.task.done && CODE.task.events.some(e => e.k === "approval")', 6 * 60000));
      ok('the card says a message revises it', await evalJs(c, '/revises this diff/.test(document.querySelector(".code-appr.is-open").textContent)'));
      await type(c, 'Use `z = 3` instead of `y = 2`.');
      await send(c);
      ok('the message went to the card as a revision', await waitFor(c,
        'CODE.task.events.some(e => e.k === "user" && e.how === "revise")', 20000));
      ok('the first card resolves "sent back"', await waitFor(c,
        'CODE.task.events.some(e => e.k === "decision" && e.why === "revised")', 20000));
      ok('a second card comes up', await waitFor(c,
        'CODE.task.events.filter(e => e.k === "approval").length === 2 && !!document.querySelector(".code-appr.is-open")', 6 * 60000));
      ok('two rounds on screen, the first "sent back"', await evalJs(c,
        'document.querySelectorAll(".code-thread .code-task:not(.is-earlier) .code-appr").length === 2 && /Sent back with your message/.test(document.querySelector(".code-thread .code-task:not(.is-earlier)").textContent)'));
      await shot(c, 'code-thread-revise');
      await evalJs(c, 'document.querySelector(".code-appr.is-open .code-approve").click(); return 1;');
      ok('turn 4 lands, applied', await waitFor(c, idle + ' && CODE.task.result.write === "applied"', 60000),
         await evalJs(c, 'CODE.task && JSON.stringify(CODE.task.result && CODE.task.result.write)'));
      const app = fs.readFileSync(path.join(REPO, 'app.py'), 'utf8');
      ok('the revised line is in the folder, the first one is not', /z\s*=\s*3/.test(app) && !/y\s*=\s*2/.test(app), app);
      await evalJs(c, 'CODE.rw = "read"; renderCodeView(); updateEnabled(); return 1;');
    }

    if (want('history') && T1) {
      // -- 5. History -------------------------------------------------------------
      console.log('\n5. History is per session');
      const n = await evalJs(c, 'CODE.session.turns.length');
      await evalJs(c, 'codeHistEngineLoad(true); return 1;');
      ok(`History has ONE entry for the session, ${n} turns`, await waitFor(c,
        `codeHistRows().some(g => g.id === ${JSON.stringify(T1)} && g.n === ${n})`, 15000),
        await evalJs(c, 'JSON.stringify(codeHistRows().map(g => [g.id, g.n]))'));
      await evalJs(c, 'setView("codeHistory"); return 1;');
      ok('the row says n turns', await evalJs(c,
        `[...document.querySelectorAll("#codeHistoryRows .row .meta")].some(m => /${n} turns/.test(m.textContent))`));
      await evalJs(c, 'navNewCode(); return 1;');
      ok('New session: empty, undocked, Run', await waitFor(c,
        '!CODE.task && CODE.session.turns.length === 0 && !$("qbar").classList.contains("docked") && $("btnSend").textContent === "Run"', 5000));
      await evalJs(c, `codeOpenHistory(codeHistRows().find(g => g.id === ${JSON.stringify(T1)})); return 1;`);
      ok('reopening brings every turn back', await waitFor(c,
        `CODE.session.id === ${JSON.stringify(T1)} && CODE.session.turns.length === ${n} && !!CODE.task && CODE.task.done`, 30000));
      ok('the box is EMPTY and says Follow up', (await evalJs(c, '$("composer").value')) === '' && (await label(c)) === 'Follow up');
      ok('docked under the thread', await docked(c));
      ok('earlier turns compact above', await evalJs(c, `document.querySelectorAll(".code-thread .code-task.is-earlier").length === ${n - 1}`));
      await shot(c, 'code-thread-reopened');
      await type(c, 'What fruit did I mention at the very start of this session? Reply with the fruit only.');
      await send(c);
      ok('a follow-up from the reopened session is its next turn', await waitFor(c,
        `!!CODE.task && CODE.task.sid === ${JSON.stringify(T1)} && CODE.task.turn === ${n + 1}`, 20000));
      ok('it lands', await waitFor(c, idle, 6 * 60000));
      const a5 = await answer(c);
      ok('it remembers turn 1 (kiwi)', /kiwi/i.test(a5), a5);
    }

    if (want('cloud')) {
      // -- 6. old entry; a cloud session from another engine ---------------------
      console.log('\n6. A pre-Track-F entry, and a session from the cloud');
      await evalJs(c, `CODE_SYNC.tasks.push({ id: "oldtask0001", pid: ${JSON.stringify(PID)}, project: "magi-thread-live",
        prompt: "an old task from before follow-ups", outcome: "ok", by: "Codex", write: false,
        at: new Date(Date.now() - 3600e3).toISOString(), device: "Tony PC" }); return 1;`);
      await evalJs(c, 'codeOpenHistory(codeHistRows().find(g => g.id === "oldtask0001")); return 1;');
      ok('it opens as a one-turn session', await waitFor(c,
        'CODE.session.id === "oldtask0001" && CODE.session.turns.length === 1', 20000));
      ok('its lost answer says "no longer stored"', await evalJs(c, '/no longer stored/.test(document.querySelector(".code-thread").textContent)'));
      ok('...and it can still follow up', (await label(c)) === 'Follow up' && (await evalJs(c, '$("composer").value')) === '');
      await evalJs(c, 'CODE_SYNC.tasks = CODE_SYNC.tasks.filter(r => r.id !== "oldtask0001"); navNewCode(); return 1;');

      // The cloud, faked behind the real loader: one body, made by another engine.
      await evalJs(c, `window.__realCloud = { init: cloudInit, fs: CLOUD.fs };
        cloudInit = async () => true;
        CLOUD.fs = { ...(CLOUD.fs || {}), doc: () => ({}), getDoc: async () => ({ exists: () => true, data: () => ({
          prompt: "Remember this",
          events: JSON.stringify([{ k: "start", prompt: "Remember this: the secret word is ZEBRA. Just say OK.", mode: "read" },
                                  { k: "text", text: "OK." }, { k: "end", result: { outcome: "ok" } }]),
          result: JSON.stringify({ outcome: "ok", text: "OK.", by_label: "Codex",
                                   native: { agent: "codex:other", sid: "019a0000-0000-0000-0000-000000000000" } }) }) }) };
        CODE_SYNC.tasks.push({ id: "cloudtask001", sid: "cloudtask001", turn: 1, pid: ${JSON.stringify(PID)},
          project: "magi-thread-live", prompt: "Remember this", outcome: "ok", by: "Codex", write: false,
          at: new Date(Date.now() - 600e3).toISOString(), device: "Veda PC", eng: "eng_somewhere_else" });
        return 1;`);
      await evalJs(c, 'codeOpenHistory(codeHistRows().find(g => g.id === "cloudtask001")); return 1;');
      ok('the cloud session opens from its saved copy', await waitFor(c,
        'CODE.session.id === "cloudtask001" && !!CODE.task && !!CODE.task.archived', 20000));
      ok('another engine\'s CLI session is NOT sent', await evalJs(c,
        'Object.keys(codeSessionBody(CODE.session, codeEngineId()).native).length === 0'));
      await type(c, 'What is the secret word I gave you earlier in this session? Reply with the word only.');
      await send(c);
      ok('the follow-up is turn 2 of the cloud session', await waitFor(c,
        '!!CODE.task && CODE.task.sid === "cloudtask001" && CODE.task.turn === 2', 20000));
      ok('it lands', await waitFor(c, idle, 6 * 60000));
      const a6 = await answer(c);
      ok('it used the transcript (ZEBRA)', /zebra/i.test(a6), a6);
      await evalJs(c, `cloudInit = window.__realCloud.init; CLOUD.fs = window.__realCloud.fs;
        CODE_SYNC.tasks = CODE_SYNC.tasks.filter(r => r.id !== "cloudtask001"); return 1;`);
    }

    if (want('phone')) {
      // -- 7. 390px -----------------------------------------------------------------
      console.log('\n7. 390px');
      if (!(await evalJs(c, 'codeThreadOn()')) && T1) {
        await evalJs(c, `codeOpenHistory(codeHistRows().find(g => g.id === ${JSON.stringify(T1)})); return 1;`);
        await waitFor(c, '!!CODE.task', 20000);
      }
      await size(c, 390, 844, true);
      await sleep(600);
      await evalJs(c, '$("page").scrollTop = $("page").scrollHeight; return 1;');
      await sleep(300);
      ok('the box is docked', await docked(c));
      ok('...and on screen', await evalJs(c, 'return (() => { const r = $("qbar").getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top < innerHeight && r.width > 300; })()'));
      ok('no horizontal scroll', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1 && $("page").scrollWidth <= $("page").clientWidth + 1'),
         await evalJs(c, '[document.documentElement.scrollWidth, $("page").scrollWidth, innerWidth].join()'));
      await shot(c, 'code-thread-390');
      await size(c, 1440, 900, false);
    }

    ok('no page errors', errs.length === 0, errs.join(' | '));
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e.stack || e));
  } finally {
    try { await evalJs(c, 'navNewCode(); return 1;'); } catch {}
    if (PID) await api(`/projects/${PID}`, null, 'DELETE').catch(() => {});
    try { fs.rmSync(REPO, { recursive: true, force: true }); } catch {}
    try { c.close && c.close(); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
