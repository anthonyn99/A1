// LIVE test -- reads the real engine on this PC; starts NO task, spends nothing.
// Every POST is stubbed (task start, refine) and every Code task stream is a
// fake EventSource the test ends by hand.
// Run: node tests/live/magi-code-queue.live.js   Screenshots: %TEMP%/magi-live-shots
//
// 1. Brainstorm: a centred button hides / shows Past sessions, remembered.
// 2. Code Mode: attach (text only), Refine (kind=code), Undo, per-mode files.
// 3. Code Mode: Run sends the files; an old engine gets them folded in.
// 4. The queue takes Code tasks: add, render, edit, drain in order, HOLD on a
//    limit (reported reset / 15-min guess, Try now, Cancel wait), write-mode
//    outcomes, run a finished row again, the approval chime + tab mark, pause
//    while a hand-started task runs, reload.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const URL = require('./cdp.js').PAGES_URL;

const STUB = `if (window.top === window) (() => {
  const real = window.fetch;
  const json = (d, st = 200) => Promise.resolve(new Response(JSON.stringify(d),
    { status: st, headers: { 'Content-Type': 'application/json' } }));
  window.__cap = { tasks: [], refine: [], posts: [] };
  // A fake engine that outlives a reload in this tab, as the real one does.
  try { window.__fake = JSON.parse(sessionStorage.getItem('__fakeSeed') || '{}'); } catch { window.__fake = {}; }
  window.__features = true;
  let n = 0;
  window.fetch = async (u, o) => {
    const s = String(u && u.url ? u.url : u);
    const m = ((o && o.method) || (u && u.method) || 'GET').toUpperCase();
    if (s.indexOf('/auth/journal/status') >= 0) return json({ ok: true, hasLock: false });
    if (s.indexOf('firebase') >= 0 || s.indexOf('googleapis') >= 0 || s.indexOf('gstatic') >= 0)
      return Promise.reject(new TypeError('blocked'));
    if (s.indexOf('/api/refine') >= 0) {
      const f = o.body;
      window.__cap.refine.push({ q: f.get('question'), providers: f.get('providers'), kind: f.get('kind') });
      await new Promise((r) => setTimeout(r, 150));
      return json({ refined: 'REFINED: ' + f.get('question') });
    }
    if (/\\/api\\/code\\/tasks(\\?|$)/.test(s) && m === 'POST') {
      const body = JSON.parse(o.body);
      window.__cap.tasks.push(body);
      const id = 'fake' + (++n);
      window.__fake[id] = { done: false, body };
      return json({ ok: true, task: { id, prompt: body.prompt } });
    }
    if (/\\/api\\/code\\/tasks(\\?|$)/.test(s)) {
      return json({ ok: true, tasks: Object.entries(window.__fake).map(([id, t]) =>
        ({ id, done: t.done, outcome: t.outcome || null, write: t.write || null })) });
    }
    if (s.indexOf('/api/code/state') >= 0) {
      const r = await real(u, o); const d = await r.json();
      if (window.__features) d.features = ['attachments']; else delete d.features;
      return json(d);
    }
    // Nothing else may change anything on the real engine.
    if (m !== 'GET') { window.__cap.posts.push(m + ' ' + s); return json({ ok: false, message: 'stubbed' }); }
    return real(u, o);
  };
  const RealES = window.EventSource;
  window.__es = {};
  window.EventSource = class {
    constructor(u, opts) {
      const mm = /\\/api\\/code\\/tasks\\/([^/]+)\\/stream/.exec(String(u));
      if (!mm) return new RealES(u, opts);
      this.id = mm[1]; this.readyState = 1; this.onmessage = null; this.onerror = null;
      window.__es[this.id] = this;
      const t = window.__fake[this.id] || { body: {} };
      setTimeout(() => this._emit({ k: 'start', prompt: t.body.prompt || '', mode: t.body.mode || 'read',
        attachments: (t.body.attachments || []).map((a) => a.name),
        chain: [{ id: 'claude-cli', label: 'Claude', kind: 'cli' }] }), 40);
      if (t.done) setTimeout(() => this._emit({ k: 'end', result: { outcome: t.outcome, write: t.write } }), 80);
    }
    _emit(ev) { if (this.readyState !== 2 && this.onmessage) this.onmessage({ data: JSON.stringify(ev) }); }
    close() { this.readyState = 2; }
  };
  window.__end = (id, result) => {
    const t = window.__fake[id]; if (t) { t.done = true; t.outcome = result.outcome; t.write = result.write; }
    const es = window.__es[id]; if (es) es._emit({ k: 'end', result });
  };
})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 300) + ']' : '')); }
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(200);
  }
  return false;
};
const vis = (sel) => `((e) => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0)(document.querySelector(${JSON.stringify(sel)}))`;

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: URL }); await sleep(2500);
  await evalJs(c, 'localStorage.clear(); sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "deliberation"); return 1;');
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 25000));

  // ── 1. Brainstorm ──────────────────────────────────────────────────────
  console.log('\nBrainstorm: hide / show Past sessions');
  const seed = `S.bs.sessions = [
      { id: "s1", topic: "A plan for the garage", status: "active", rounds: 4, created_at: new Date().toISOString() },
      { id: "s2", topic: "Kitchen remodel", status: "complete", rounds: 6, created_at: new Date(Date.now()-864e5).toISOString() }];
    setView("brainstorm"); renderBsView(); return 1;`;
  await evalJs(c, seed);
  ok('toggle shown', await evalJs(c, vis('#bsPastToggle')));
  ok('list shown by default', await evalJs(c, vis('#bsPast')));
  ok('says Hide, with the count', await evalJs(c, '$("bsPastToggle").textContent'), undefined);
  ok('aria-expanded true', await evalJs(c, '$("bsPastToggle").getAttribute("aria-expanded")') === 'true');
  const centred = await evalJs(c, `return (() => { const b = $("bsPastToggle").getBoundingClientRect(), d = $("bsPast").getBoundingClientRect();
    return Math.abs((b.left + b.width / 2) - (d.left + d.width / 2)); })()`);
  ok('toggle is centred over the list', centred < 2, centred);
  ok('toggle sits above the list', await evalJs(c,
    '$("bsPastToggle").getBoundingClientRect().bottom <= $("bsPast").getBoundingClientRect().top'));
  await shot(c, 'cq-1-bs-shown');
  await evalJs(c, '$("bsPastToggle").click(); return 1;');
  ok('list hidden after click', await evalJs(c, '!document.getElementById("bsPast")'));
  ok('label says Show', /Show past sessions/.test(await evalJs(c, '$("bsPastToggle").textContent')));
  ok('aria-expanded false', await evalJs(c, '$("bsPastToggle").getAttribute("aria-expanded")') === 'false');
  ok('focus stays on the toggle', await evalJs(c, 'document.activeElement && document.activeElement.id') === 'bsPastToggle');
  ok('remembered per profile', await evalJs(c, 'localStorage.getItem(lsKey("bs.pastHidden"))') === 'true');
  await shot(c, 'cq-2-bs-hidden');
  await c.send('Page.navigate', { url: URL });
  await waitFor(c, 'online()', 25000);
  await evalJs(c, seed);
  ok('still hidden after a reload', await evalJs(c, '!document.getElementById("bsPast") && /Show/.test($("bsPastToggle").textContent)'));
  await evalJs(c, '$("bsPastToggle").click(); return 1;');
  ok('shown again', await evalJs(c, vis('#bsPast')));
  ok('the rows still open / act', await evalJs(c, 'document.querySelectorAll("#bsPast .row").length') === 2);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  ok('phone: toggle is still tappable', (await evalJs(c, '$("bsPastToggle").getBoundingClientRect().height')) >= 28);
  ok('phone: no horizontal overflow', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'));
  await evalJs(c, '$("bsPastToggle").scrollIntoView({block:"center"}); return 1;');
  await shot(c, 'cq-3-bs-phone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // ── 2. Code Mode composer ──────────────────────────────────────────────
  console.log('\nCode Mode: attach, refine, per-mode files');
  await evalJs(c, '$("navCodeNew").click(); return 1;');
  ok('code state loaded', await waitFor(c, '!!CODE.state && !!CODE.agents', 25000));
  ok('features read', await evalJs(c, 'JSON.stringify(CODE.state.features)') === '["attachments"]');
  await evalJs(c, 'if (!codeProject()) codeSetProject(CODE.state.projects[0].id); renderCodeView(); updateEnabled(); return 1;');
  ok('a workspace is chosen', await evalJs(c, '!!codeProject()'), await evalJs(c, 'codeProject() && codeProject().name'));
  ok('Attach visible', await evalJs(c, vis('#btnAttach')));
  ok('Refine visible', await evalJs(c, vis('#btnRefine')));
  ok('Queue visible', await evalJs(c, vis('#btnQueue')));
  ok('Queue held with no text', await evalJs(c, '$("btnQueue").disabled'));
  await evalJs(c, `addFiles([new File(["line one\\nline two\\n"], "notes.txt", { type: "text/plain" })]); return 1;`);
  ok('a text file becomes a chip', await waitFor(c, 'document.querySelectorAll("#qbarChips .chipfile").length === 1'));
  ok('it is Code Mode\'s, not the council\'s', await evalJs(c, 'CODE.attachments.length === 1 && S.attachments.length === 0'));
  await evalJs(c, `addFiles([new File([new Uint8Array([137,80,78,71])], "shot.png", { type: "image/png" })]); return 1;`);
  ok('an image is refused, with a reason', await waitFor(c, '!$("attachError").hidden && /not a text file/.test($("attachError").textContent)'));
  await evalJs(c, `addFiles([new File(["abc\\u0000def"], "blob.dat", { type: "" })]); return 1;`);
  ok('a binary file is refused too', await waitFor(c, '/blob\\.dat is not a text file/.test($("attachError").textContent)'));
  ok('still one chip', await evalJs(c, 'CODE.attachments.length') === 1);
  await evalJs(c, `addFiles([new File(["x".repeat(100001)], "huge.log", { type: "text/plain" })]); return 1;`);
  ok('too long is refused', await waitFor(c, '/huge\\.log is too long/.test($("attachError").textContent)'));
  await evalJs(c, 'setQuestion("fix the sidebar toggle"); return 1;');
  ok('Queue enabled with text', await evalJs(c, '!$("btnQueue").disabled'));
  await shot(c, 'cq-4-code-composer');

  await evalJs(c, '$("navNew").click(); return 1;');
  ok('Deliberation does not show Code\'s files', await evalJs(c, '$("qbarChips").hidden && !document.querySelector("#qbarChips .chipfile")'));
  ok('Deliberation keeps its own controls', await evalJs(c, `${vis('#btnQueue')} && ${vis('#btnRefine')} && ${vis('#btnAttach')}`));
  await evalJs(c, '$("navCodeNew").click(); return 1;');
  ok('Code\'s files come back', await evalJs(c, 'document.querySelectorAll("#qbarChips .chipfile").length') === 1);
  ok('and its draft', await evalJs(c, '$("composer").value') === 'fix the sidebar toggle');

  await evalJs(c, '$("btnRefine").click(); return 1;');
  ok('refine lands', await waitFor(c, '$("composer").value === "REFINED: fix the sidebar toggle"'));
  const rf = await evalJs(c, 'window.__cap.refine[window.__cap.refine.length - 1]');
  ok('refine asked for a coding rewrite', rf && rf.kind === 'code', JSON.stringify(rf));
  ok('refine never names a CLI as a unit', rf && !/-cli/.test(rf.providers || ''), rf && rf.providers);
  ok('refine names some unit', rf && !!rf.providers, rf && rf.providers);
  ok('Undo offered', await evalJs(c, vis('#btnUndo')));
  await evalJs(c, '$("btnUndo").click(); return 1;');
  ok('Undo restores', await evalJs(c, '$("composer").value') === 'fix the sidebar toggle');

  // Refine that lands after a mode switch goes to its own mode's draft.
  await evalJs(c, '$("btnRefine").click(); $("navNew").click(); return 1;');
  await sleep(500);
  ok('a late rewrite does not land in the other mode', await evalJs(c, '$("composer").value') === '');
  await evalJs(c, '$("navCodeNew").click(); return 1;');
  ok('it waits in its own mode', await evalJs(c, '$("composer").value') === 'REFINED: fix the sidebar toggle');
  await evalJs(c, 'setQuestion("fix the sidebar toggle"); return 1;');

  // ── 3. Run sends the files ─────────────────────────────────────────────
  console.log('\nCode Mode: Run sends the files');
  await evalJs(c, '$("btnSend").click(); return 1;');
  ok('task posted', await waitFor(c, 'window.__cap.tasks.length === 1'));
  const t1 = await evalJs(c, 'window.__cap.tasks[0]');
  ok('prompt is only what was typed', t1.prompt === 'fix the sidebar toggle', t1.prompt);
  ok('files ride separately', JSON.stringify(t1.attachments) === JSON.stringify([{ name: 'notes.txt', text: 'line one\nline two\n' }]), JSON.stringify(t1.attachments));
  ok('chips cleared after Run', await waitFor(c, 'CODE.attachments.length === 0 && $("qbarChips").hidden'));
  ok('the task card names its files', await waitFor(c, '/notes\\.txt/.test((document.querySelector(".code-task-hd")||{}).textContent||"")'));
  await evalJs(c, 'window.__end("fake1", { outcome: "ok" }); return 1;');
  ok('task ends', await waitFor(c, '!codeBusy()'));

  // An engine that predates attachments: the files are folded into the prompt.
  await evalJs(c, 'window.__features = false; await codeLoad(true); return 1;');
  await waitFor(c, '!CODE.loading && !(CODE.state.features||[]).length');
  await evalJs(c, `codeClearTask(); addFiles([new File(["E1"], "err.txt", { type: "text/plain" })]); return 1;`);
  await waitFor(c, 'CODE.attachments.length === 1');
  await evalJs(c, 'setQuestion("why does it fail"); $("btnSend").click(); return 1;');
  ok('old engine: posted', await waitFor(c, 'window.__cap.tasks.length === 2'));
  const t2 = await evalJs(c, 'window.__cap.tasks[1]');
  ok('old engine: files folded into the prompt', !t2.attachments && /ATTACHED: err\.txt/.test(t2.prompt) && /^why does it fail/.test(t2.prompt), t2.prompt);
  await evalJs(c, 'window.__end("fake2", { outcome: "ok" }); return 1;');
  await waitFor(c, '!codeBusy()');
  await evalJs(c, 'window.__features = true; await codeLoad(true); return 1;');
  await waitFor(c, '!CODE.loading && (CODE.state.features||[]).length === 1');

  // ── 4. The queue ───────────────────────────────────────────────────────
  console.log('\nThe queue takes Code tasks');
  await evalJs(c, 'codeClearTask(); S.queue = []; queueChanged(); return 1;');
  await evalJs(c, `addFiles([new File(["TRACE"], "trace.log", { type: "text/plain" })]); return 1;`);
  await waitFor(c, 'CODE.attachments.length === 1');
  await evalJs(c, 'setQuestion("task one"); $("btnQueue").click(); return 1;');
  const q1 = await evalJs(c, 'S.queue[0]');
  ok('queued as a code task', q1 && q1.kind === 'code', JSON.stringify(q1));
  ok('with the workspace', q1 && q1.pid === await evalJs(c, 'codeProject().id') && !!q1.pname);
  ok('with the ticked agents in order', q1 && JSON.stringify(q1.agents) === JSON.stringify(await evalJs(c, 'codeChain().map((m) => m.id)')), JSON.stringify(q1 && q1.agents));
  ok('with Read', q1 && q1.rw === 'read');
  ok('with its file', q1 && q1.atts.length === 1 && q1.atts[0].n === 'trace.log');
  ok('composer and chips cleared', await evalJs(c, '$("composer").value === "" && CODE.attachments.length === 0'));
  ok('the queue shows in Code Mode', await evalJs(c, vis('#queueDrawer')));
  ok('the row names its workspace', await evalJs(c, '!!document.querySelector("#queueRows .q-ws")'));
  ok('the row has agent dots', await evalJs(c, 'document.querySelectorAll("#queueRows .q-unit").length') >= 1);
  ok('no kind tag while all rows are code', await evalJs(c, '!document.querySelector("#queueRows .q-kind")'));
  await evalJs(c, 'setQuestion("task two"); $("btnQueue").click(); setQuestion("task three"); $("btnQueue").click(); return 1;');
  ok('three rows', await evalJs(c, 'S.queue.length') === 3);
  // A council prompt alongside them: tags appear.
  await evalJs(c, '$("navNew").click(); if (!S.selected.size) S.selected.add(S.providers[0].id); setQuestion("a council question"); $("btnQueue").click(); return 1;');
  ok('council prompt queued as before', await evalJs(c, 'S.queue.length === 4 && !S.queue[3].kind && S.queue[3].units.length > 0'));
  ok('mixed queue tags every row', await evalJs(c, 'document.querySelectorAll("#queueRows .q-kind").length') === 4);
  await evalJs(c, '$("navCodeNew").click(); return 1;');
  await shot(c, 'cq-5-queue-mixed');
  // Only code rows run in this test: the council row would start a real run.
  await evalJs(c, 'S.queue = S.queue.filter((it) => it.kind === "code"); queueChanged(); return 1;');

  console.log('\nSync shape');
  const cloud = await evalJs(c, 'queueForCloud()');
  ok('code fields carried to the cloud', cloud[0].kind === 'code' && cloud[0].pid && cloud[0].agents.length && cloud[0].rw === 'read', JSON.stringify(cloud[0]));
  ok('no undefined anywhere', !JSON.stringify(cloud).includes('undefined') && cloud.every((r) => Object.values(r).every((v) => v !== undefined)));
  ok('an identical incoming copy is not a change', await evalJs(c, 'queueFromCloud(JSON.parse(JSON.stringify(queueForCloud()))) === false'));

  console.log('\nEditing a code row');
  await evalJs(c, 'queueEdit(S.queue[1].id); return 1;');
  ok('sheet says Edit task', await waitFor(c, '/Edit task/.test((document.querySelector(".qedit .sheet-hd")||{}).textContent||"")'));
  ok('it offers agents', await evalJs(c, '/Agents/.test(document.querySelector(".qedit-lbl").textContent)'));
  const nAgents = await evalJs(c, 'document.querySelectorAll(".qedit-units .chip").length');
  ok('one chip per agent', nAgents === await evalJs(c, 'codeQueuePool(S.queue[1]).length'), nAgents);
  await evalJs(c, `const inp = document.querySelector(".qedit input[type=file]");
    const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([1,2])], "pic.jpg", { type: "image/jpeg" }));
    inp.files = dt.files; inp.dispatchEvent(new Event("change")); return 1;`);
  ok('the editor refuses a non-text file for a task', await evalJs(c, '/not a text file/.test(document.querySelector(".qedit .qbar-error").textContent)'));
  await evalJs(c, `document.querySelector(".qedit-text").value = "task two, edited"; document.querySelector(".qedit-text").dispatchEvent(new Event("input"));
    [...document.querySelectorAll(".qedit-units .chip.on")].slice(1).forEach((b) => b.click()); return 1;`);
  await shot(c, 'cq-6-edit-task');
  await evalJs(c, '[...document.querySelectorAll(".qedit-bar .btn")].find((b) => b.textContent === "Save").click(); return 1;');
  const e2 = await evalJs(c, 'S.queue[1]');
  ok('edit saved', e2.q === 'task two, edited' && e2.agents.length === 1 && e2.kind === 'code', JSON.stringify(e2));

  console.log('\nThe queue drains code tasks in order');
  await evalJs(c, 'queueStart(); return 1;');
  ok('first task posted', await waitFor(c, 'window.__cap.tasks.length === 3'));
  const p3 = await evalJs(c, 'window.__cap.tasks[2]');
  ok('with its own workspace, agents, mode and file', p3.prompt === 'task one' && p3.project_id === q1.pid
     && JSON.stringify(p3.agents) === JSON.stringify(q1.agents) && p3.mode === 'read'
     && p3.attachments && p3.attachments[0].text === 'TRACE', JSON.stringify(p3));
  ok('row running with its task id', await waitFor(c, 'S.queue[0].status === "running" && S.queue[0].runId === "fake3"'));
  ok('the task is on the Code screen', await waitFor(c, 'CODE.task && CODE.task.id === "fake3"'));
  ok('Run is held while it works', await evalJs(c, '$("btnSend").disabled'));
  await shot(c, 'cq-7-draining');
  await evalJs(c, 'window.__end("fake3", { outcome: "ok" }); return 1;');
  ok('row done', await waitFor(c, 'S.queue[0].status === "done"'));
  ok('second task posted after the first ended', await waitFor(c, 'window.__cap.tasks.length === 4 && window.__cap.tasks[3].prompt === "task two, edited"'));
  // A usage limit HOLDS the queue (from Claude Queue): the row goes back to
  // waiting and the queue sleeps until the reset the chain reported.
  const back = await evalJs(c, 'Math.floor(Date.now() / 1000) + 120');
  await evalJs(c, `window.__es.fake4._emit({ k: "handoff", from: "claude-cli", from_label: "Claude",
    reason: "limited", detail: "out", resets_at: ${back}, to_label: null });
    window.__end("fake4", { outcome: "limited" }); return 1;`);
  ok('a limited task goes back to waiting, not failed', await waitFor(c, 'S.queue[1].status === "queued"'));
  ok('the row says why', /usage limit/.test(await evalJs(c, 'S.queue[1].err || ""')), await evalJs(c, 'S.queue[1].err'));
  ok('the queue is still running, held', await evalJs(c, 'S.queueRunning && !!S.queueHold'));
  const hold = await evalJs(c, 'S.queueHold');
  ok('held until the reported reset plus a minute', hold && hold.known
     && Math.abs(hold.until - (back * 1000 + 60000)) < 2000, JSON.stringify(hold));
  ok('the hold is on screen', await evalJs(c, vis('#queueHold')));
  ok('and says when', /runs again when the limit lifts/.test(await evalJs(c, '$("queueHoldTxt").textContent')));
  ok('Pause reads Cancel wait', await evalJs(c, '$("queueRunBtn").textContent') === 'Cancel wait');
  ok('nothing else started meanwhile', await evalJs(c, 'window.__cap.tasks.length') === 4);
  await shot(c, 'cq-7b-hold');
  await evalJs(c, '$("queueHoldNow").click(); return 1;');
  ok('Try now runs the held row again', await waitFor(c,
    'window.__cap.tasks.length === 5 && window.__cap.tasks[4].prompt === "task two, edited"'));
  ok('the hold is gone', await evalJs(c, '!S.queueHold && $("queueHold").hidden'));
  await evalJs(c, 'window.__end("fake5", { outcome: "ok" }); return 1;');
  ok('then it finishes', await waitFor(c, 'S.queue[1].status === "done"'));

  // No reset time: a fifteen-minute guess, and Cancel wait leaves it queued.
  ok('third posted', await waitFor(c, 'window.__cap.tasks.length === 6'));
  const t0 = await evalJs(c, 'Date.now()');
  await evalJs(c, 'window.__end("fake6", { outcome: "limited" }); return 1;');
  ok('held on a guess', await waitFor(c, '!!S.queueHold && S.queueHold.known === false'));
  const g = await evalJs(c, 'S.queueHold.until');
  ok('fifteen minutes out', Math.abs(g - t0 - 15 * 60000) < 5000, g - t0);
  ok('and says no reset time was given', /no reset time was given/.test(await evalJs(c, '$("queueHoldTxt").textContent')));
  await evalJs(c, '$("queueRunBtn").click(); return 1;');
  ok('Cancel wait stops the queue', await waitFor(c, '!S.queueRunning && !S.queueHold && $("queueHold").hidden'));
  ok('the row is still waiting', await evalJs(c, 'S.queue[2].status') === 'queued');

  console.log('\nWrite-mode outcomes');
  await evalJs(c, 'queueStart(); return 1;');
  ok('third posted again', await waitFor(c, 'window.__cap.tasks.length === 7'));
  await evalJs(c, 'window.__end("fake7", { outcome: "ok", write: "timeout" }); return 1;');
  ok('an unapproved diff is a failed row', await waitFor(c, 'S.queue[2].status === "failed"'));
  ok('that says so', /not approved in time/.test(await evalJs(c, 'S.queue[2].err')), await evalJs(c, 'S.queue[2].err'));
  ok('queue idle when empty', await waitFor(c, '!S.queueRunning'));

  console.log('\nRun again, and the approval chime');
  ok('a finished row offers run-again', await evalJs(c,
    '!!document.querySelectorAll("#queueRows .q-row")[0].querySelector(".q-act[title^=\\"Run this again\\"]")'));
  await evalJs(c, 'document.querySelectorAll("#queueRows .q-row")[0].querySelector(".q-act[title^=\\"Run this again\\"]").click(); return 1;');
  ok('it runs again, from the front', await waitFor(c,
    'window.__cap.tasks.length === 8 && window.__cap.tasks[7].prompt === "task one"'));
  await waitFor(c, 'CODE.task && CODE.task.id === "fake8"');
  await evalJs(c, `window.__es.fake8._emit({ k: "approval", files: [], adds: 1, dels: 0,
    expires_at: Date.now() / 1000 + 300, timeout: 300 }); return 1;`);
  ok('an approval card marks the tab', await waitFor(c, 'ATTN.keys.has("approval:fake8") && /^\\u25CF Approve\\?/.test(document.title)', 4000),
     await evalJs(c, 'document.title'));
  await evalJs(c, 'window.__es.fake8._emit({ k: "decision", approved: false, why: "denied" }); return 1;');
  ok('its decision clears it', await waitFor(c, '!ATTN.keys.size && !/\\u25CF/.test(document.title)', 4000));
  // A replayed card that was already answered stays silent.
  await evalJs(c, `window.__es.fake8._emit({ k: "approval", files: [], expires_at: Date.now() / 1000 + 300 });
    window.__es.fake8._emit({ k: "decision", approved: true, why: "approved" }); return 1;`);
  await sleep(1200);
  ok('an answered card never rings', await evalJs(c, '!ATTN.keys.size'));
  await evalJs(c, 'window.__end("fake8", { outcome: "ok" }); return 1;');
  ok('and it finishes', await waitFor(c, 'S.queue[0].status === "done" && !S.queueRunning'));

  console.log('\nA hand-started task goes first; Pause leaves the row waiting');
  await evalJs(c, 'codeClearTask(); setQuestion("manual"); $("btnSend").click(); return 1;');
  ok('manual task running', await waitFor(c, 'codeBusy() && CODE.task.id === "fake9"'));
  await evalJs(c, 'setQuestion("queued behind it"); $("btnQueue").click(); queueStart(); return 1;');
  await sleep(2500);
  ok('queued task not started while one runs', await evalJs(c, 'window.__cap.tasks.length') === 9);
  await evalJs(c, 'queueStop(); return 1;');
  await sleep(2500);
  ok('paused before it started: back to waiting', await evalJs(c, 'S.queue[S.queue.length - 1].status') === 'queued');
  await evalJs(c, 'queueStart(); return 1;');
  await sleep(500);
  await evalJs(c, 'window.__end("fake9", { outcome: "ok" }); return 1;');
  ok('then it starts once the manual task ends', await waitFor(c, 'window.__cap.tasks.length === 10', 8000));

  console.log('\nA reload picks the running task back up');
  await sleep(300);
  // fake10 is still running on the (fake) engine across the reload.
  await evalJs(c, 'sessionStorage.setItem("__fakeSeed", JSON.stringify({ fake10: { done: false, body: { prompt: "queued behind it" } } })); return 1;');
  await c.send('Page.navigate', { url: URL });
  await waitFor(c, 'online()', 25000);
  ok('queue kept locally, as code rows', await evalJs(c, 'S.queue.filter((it) => it.kind === "code").length') === 4);
  ok('the running row is resumed', await waitFor(c, 'S.queue.some((it) => it.runId === "fake10" && it.status === "running")', 15000));
  await evalJs(c, 'window.__end("fake10", { outcome: "ok" }); sessionStorage.removeItem("__fakeSeed"); return 1;');
  ok('and finishes when the task does', await waitFor(c, 'S.queue.some((it) => it.runId === "fake10" && it.status === "done")', 15000));

  console.log('\nPhone');
  await evalJs(c, '$("navCodeNew").click(); addFiles([new File(["a"], "a-very-long-file-name-for-a-phone-screen.ts", { type: "text/plain" })]); setQuestion("phone task"); return 1;');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  ok('phone: no horizontal overflow', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'),
     await evalJs(c, 'document.documentElement.scrollWidth'));
  const rects = await evalJs(c, `return JSON.stringify(["btnAttach","btnRefine","btnSend","btnQueue"].map((id) => {
    const r = $(id).getBoundingClientRect(); return [id, Math.round(r.left), Math.round(r.right), Math.round(r.width)]; }).concat([["vw", innerWidth]]))`);
  ok('phone: toolbar buttons all on screen', await evalJs(c, `return ["btnAttach","btnRefine","btnSend","btnQueue"].every((id) => {
    const r = $(id).getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= document.documentElement.clientWidth; })`), rects);
  await shot(c, 'cq-8-phone-composer');
  await evalJs(c, '$("queueDrawer").scrollIntoView(); return 1;');
  await shot(c, 'cq-9-phone-queue');

  console.log('\nNothing else reached the engine');
  const posts = await evalJs(c, 'window.__cap.posts');
  ok('no unstubbed write', true, JSON.stringify(posts));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await evalJs(c, 'S.queue = []; saveQueueLocal(); return 1;');
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
