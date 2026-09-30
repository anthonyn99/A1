// LIVE test -- Deliberation and Code Mode have SEPARATE queues. Reads the real
// engine on this PC; starts NO deliberation and NO task: runOne is replaced by
// a fake the test finishes by hand, every Code task POST is stubbed, and every
// task stream is a fake EventSource. Nothing reaches an account.
// Run: node tests/live/magi-queue-split.live.js   Screenshots: %TEMP%/magi-live-shots
//
// 1. Queue adds to the queue of the mode you are in; each drawer shows its own.
// 2. Both queues run AT ONCE: a council prompt and a coding task in flight together.
// 3. Pausing one leaves the other running.
// 4. A usage-limit hold on one does not hold the other; its banner is its own.
// 5. A queued deliberation waits for one started by hand.
// 6. Sync: an incoming snapshot fills each queue from its own field, moves a
//    legacy Code row out of `queue`, and reads two separate leases.
// 7. Each queue's stop marks the tab with its own name.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const URL = require('./cdp.js').PAGES_URL;

const STUB = `if (window.top === window) (() => {
  const real = window.fetch;
  const json = (d, st = 200) => Promise.resolve(new Response(JSON.stringify(d),
    { status: st, headers: { 'Content-Type': 'application/json' } }));
  window.__cap = { tasks: [], posts: [] };
  window.__fake = {};
  let n = 0;
  window.fetch = async (u, o) => {
    const s = String(u && u.url ? u.url : u);
    const m = ((o && o.method) || (u && u.method) || 'GET').toUpperCase();
    if (s.indexOf('/auth/journal/status') >= 0) return json({ ok: true, hasLock: false });
    if (s.indexOf('firebase') >= 0 || s.indexOf('googleapis') >= 0 || s.indexOf('gstatic') >= 0)
      return Promise.reject(new TypeError('blocked'));
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
        chain: [{ id: 'claude-cli', label: 'Claude', kind: 'cli' }] }), 40);
    }
    _emit(ev) { if (this.readyState !== 2 && this.onmessage) this.onmessage({ data: JSON.stringify(ev) }); }
    close() { this.readyState = 2; }
  };
  window.__end = (id, result) => {
    const t = window.__fake[id]; if (t) { t.done = true; t.outcome = result.outcome; }
    const es = window.__es[id]; if (es) es._emit({ k: 'end', result });
  };
})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 300) + ']' : '')); }
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(c, expr)) return true; } catch {}
    await sleep(150);
  }
  return false;
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const vis = (sel) => `((e) => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0)(document.querySelector(${JSON.stringify(sel)}))`;
const C = 'QUEUES.council', K = 'QUEUES.code';

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
  await evalJs(c, '$("navNew").click(); return 1;');
  await waitFor(c, 'S.providers.length > 1');

  // A fake council the test finishes by hand: window.__finish(result).
  await evalJs(c, `window.__runs = []; window.__open = null;
    runOne = ({ question, units }) => new Promise((resolve) => {
      window.__runs.push(question);
      const id = "run" + window.__runs.length;
      if (onRunStart) onRunStart(id);
      window.__open = (o) => { window.__open = null;
        resolve({ runId: id, total: units.length, responded: o.ok ? units.length : 0, ...o }); };
    });
    window.__finish = (o) => window.__open && window.__open(o || { ok: true });
    window.__strikes = 0; strike = () => { window.__strikes++; }; S.muted = false;
    S.selected = new Set([S.providers[0].id, S.providers[1].id]); return 1;`);
  const LIMITED = `{ ok: false, answers: [{ failure: "FailureKind.RATE_LIMITED" }, { failure: "rate limited" }] }`;

  // ── 1. each mode queues into its own list ─────────────────────────────
  console.log('\nQueue adds to the queue of the mode you are in');
  await evalJs(c, '["council A", "council B"].forEach((q) => { setQuestion(q); $("btnQueue").click(); }); return 1;');
  ok('two council rows', await evalJs(c, `${C}.items.length === 2 && ${K}.items.length === 0`));
  ok('the council drawer shows them', await evalJs(c, `${vis('#queueDrawer')} && document.querySelectorAll("#queueRows .q-row").length === 2`));
  ok('titled Queue', await evalJs(c, '$("queueTitle").textContent') === 'Queue');
  await evalJs(c, '$("navCodeNew").click(); return 1;');
  ok('code state loaded', await waitFor(c, '!!CODE.state && !!CODE.agents', 25000));
  await evalJs(c, 'if (!codeProject()) codeSetProject(CODE.state.projects[0].id); renderCodeView(); updateEnabled(); return 1;');
  ok('Code Mode starts with an empty drawer', await evalJs(c, '$("queueDrawer").hidden'));
  await evalJs(c, '["task A", "task B"].forEach((q) => { setQuestion(q); $("btnQueue").click(); }); return 1;');
  ok('two code rows, council untouched', await evalJs(c, `${K}.items.length === 2 && ${C}.items.length === 2`));
  ok('the code drawer shows only tasks', await evalJs(c,
    'document.querySelectorAll("#queueRows .q-row").length === 2 && document.querySelectorAll("#queueRows .q-row.code").length === 2'));
  ok('titled Task queue', await evalJs(c, '$("queueTitle").textContent') === 'Task queue');

  // ── 2. both run at once ────────────────────────────────────────────────
  console.log('\nBoth queues run at once');
  await evalJs(c, `queueStart(${C}); queueStart(${K}); return 1;`);
  ok('a council prompt is in flight', await waitFor(c, 'window.__runs.length === 1 && !!window.__open'));
  ok('AND a coding task is in flight', await waitFor(c, 'window.__cap.tasks.length === 1 && codeBusy()'));
  ok('each row is running in its own queue', await evalJs(c,
    `${C}.items[0].status === "running" && ${K}.items[0].status === "running" && ${K}.items[0].runId === "fake1"`));
  ok('the code Run button says Pause', await evalJs(c, '$("queueRunBtn").textContent') === 'Pause');
  await shot(c, 'qs-1-both-running-code');
  await evalJs(c, '$("navNew").click(); return 1;');
  ok('the council Run button says Pause too', await evalJs(c, '$("queueRunBtn").textContent') === 'Pause');
  await shot(c, 'qs-2-both-running-council');

  // The coding task finishing moves only the code queue on.
  await evalJs(c, 'window.__end("fake1", { outcome: "ok" }); return 1;');
  ok('task B starts while council A is still running', await waitFor(c,
    'window.__cap.tasks.length === 2 && window.__cap.tasks[1].prompt === "task B"') && await evalJs(c, 'window.__runs.length === 1 && !!window.__open'));

  // ── 3. pausing one leaves the other ─────────────────────────────────────
  console.log('\nPausing one leaves the other running');
  await evalJs(c, `queueStop(${C}); return 1;`);
  ok('council paused', await evalJs(c, `!${C}.running`));
  ok('code still running', await evalJs(c, `${K}.running`));
  await evalJs(c, 'window.__finish({ ok: true }); return 1;');
  await sleep(600);
  ok('the prompt in flight is recorded, and B is not started', await evalJs(c,
    `${C}.items.find((it) => it.q === "council A").status === "done" && window.__runs.length === 1`));
  await evalJs(c, 'window.__end("fake2", { outcome: "ok" }); return 1;');
  ok('the code queue finishes on its own', await waitFor(c, `!${K}.running && ${K}.items.every((it) => it.status === "done")`));
  ok('the council queue is still waiting on B', await evalJs(c, `${C}.items.find((it) => it.q === "council B").status === "queued"`));

  // ── 4. a hold on one does not hold the other ────────────────────────────
  console.log('\nA usage-limit hold is per queue');
  await evalJs(c, `queueStart(${C}); return 1;`);
  ok('council B runs', await waitFor(c, 'window.__runs.length === 2 && !!window.__open'));
  await evalJs(c, `window.__finish(${LIMITED}); return 1;`);
  ok('the council holds', await waitFor(c, `${C}.running && !!${C}.hold`));
  ok('the code queue has no hold', await evalJs(c, `!${K}.hold`));
  ok('the council banner shows', await evalJs(c, vis('#queueHold')) && /council is rate limited/.test(await evalJs(c, '$("queueHoldTxt").textContent')));
  await evalJs(c, '$("navCodeNew").click(); setQuestion("task C"); $("btnQueue").click(); return 1;');
  ok('Code Mode does not show the council\'s hold', await evalJs(c, '$("queueHold").hidden'));
  ok('its button is Run queue, not Cancel wait', await evalJs(c, '$("queueRunBtn").textContent') === 'Run queue');
  await evalJs(c, `queueStart(${K}); return 1;`);
  ok('task C runs while the council holds', await waitFor(c, 'window.__cap.tasks.length === 3 && window.__cap.tasks[2].prompt === "task C"'));
  await evalJs(c, 'window.__end("fake3", { outcome: "ok" }); return 1;');
  ok('and finishes', await waitFor(c, `!${K}.running`));
  ok('the council is still holding', await evalJs(c, `${C}.running && !!${C}.hold`));
  await shot(c, 'qs-3-code-while-council-holds');
  await evalJs(c, '$("navNew").click(); return 1;');
  ok('back on the council screen: Cancel wait', await evalJs(c, '$("queueRunBtn").textContent') === 'Cancel wait');
  await evalJs(c, '$("queueRunBtn").click(); return 1;');
  ok('cancelled', await waitFor(c, `!${C}.running && !${C}.hold && $("queueHold").hidden`, 2000));

  // The other way round: a code limit does not hold the council.
  await evalJs(c, `$("navCodeNew").click(); setQuestion("task D"); $("btnQueue").click(); queueStart(${K}); return 1;`);
  ok('task D runs', await waitFor(c, 'window.__cap.tasks.length === 4'));
  await evalJs(c, 'window.__end("fake4", { outcome: "limited" }); return 1;');
  ok('the code queue holds', await waitFor(c, `${K}.running && !!${K}.hold`));
  await evalJs(c, '$("navNew").click(); return 1;');
  ok('the council does not', await evalJs(c, `!${C}.hold && $("queueHold").hidden`));
  await evalJs(c, `queueStart(${C}); return 1;`);
  ok('council B runs while the code queue holds', await waitFor(c, 'window.__runs.length === 3 && !!window.__open'));
  await evalJs(c, 'window.__finish({ ok: true }); return 1;');
  ok('and the council queue finishes', await waitFor(c, `!${C}.running`));
  await evalJs(c, `queueStop(${K}); return 1;`);
  ok('code hold cancelled', await waitFor(c, `!${K}.running && !${K}.hold`));

  // ── 5. a hand-started deliberation goes first ───────────────────────────
  console.log('\nA queued deliberation waits for one started by hand');
  await evalJs(c, `S.running = true; setQuestion("council C"); $("btnQueue").click(); queueStart(${C}); return 1;`);
  await sleep(2500);
  ok('not started while one runs', await evalJs(c, 'window.__runs.length') === 3);
  await evalJs(c, `queueStop(${C}); return 1;`);
  await sleep(2500);
  ok('paused before it started: back to waiting', await evalJs(c, `${C}.items.find((it) => it.q === "council C").status`) === 'queued');
  await evalJs(c, `queueStart(${C}); return 1;`);
  await sleep(500);
  await evalJs(c, 'S.running = false; return 1;');
  ok('then it starts', await waitFor(c, 'window.__runs.length === 4', 6000));
  await evalJs(c, 'window.__finish({ ok: true }); return 1;');
  ok('and ends', await waitFor(c, `!${C}.running`));

  // ── 6. sync ─────────────────────────────────────────────────────────────
  console.log('\nSync: two fields, two leases, a legacy row moved');
  const now = await evalJs(c, 'Date.now()');
  // Firebase is blocked here, so no save ever lands and both lanes stay
  // "dirty" -- which is the guard doing its job: a lane with an edit on the
  // way up ignores incoming copies. Checked, then cleared as a landed save would.
  ok('a lane with an edit in flight ignores an incoming copy', await evalJs(c,
    `${C}.dirty = true; const before = ${C}.items.length;
     queuesFromCloud({ queue: [] }); return ${C}.items.length === before;`));
  await evalJs(c, `for (const L of LANES) { clearTimeout(L.saveT); L.dirty = false; } return 1;`);
  await evalJs(c, `const row = (id, code) => ({ id, q: id, units: code ? [] : [S.providers[0].id], atts: [],
      status: "queued", order: 1000, dev: "PC", runId: null, err: null,
      ...(code ? { kind: "code", agents: ["claude-cli"], pid: "p", pname: "ws", rw: "read", ap: "manual" } : {}) });
    queuesFromCloud({ queue: [row("c1", false), row("legacy", true)], codeQueue: [row("k1", true)],
      queueLease: { device: "other", name: "Phone", at: ${now} }, codeQueueLease: null }); return 1;`);
  ok('the council gets only its own row', await evalJs(c, `JSON.stringify(${C}.items.map((it) => it.id))`) === '["c1"]');
  ok('the code queue gets its field plus the legacy row', await evalJs(c,
    `JSON.stringify(${K}.items.map((it) => it.id).sort())`) === '["k1","legacy"]');
  ok('the council lease is read from queueLease', await evalJs(c, `${C}.lease && ${C}.lease.name === "Phone"`));
  ok('the code lease is separate', await evalJs(c, `${K}.lease === null`));
  ok('each saved under its own key', await evalJs(c,
    'JSON.parse(localStorage.getItem(QUEUE_KEY)).length === 1 && JSON.parse(localStorage.getItem(CODE_QUEUE_KEY)).length === 2'));
  ok('an identical snapshot changes nothing', await evalJs(c,
    `!queueFromCloud(${C}, JSON.parse(JSON.stringify(queueForCloud(${C})))) && !queueFromCloud(${K}, JSON.parse(JSON.stringify(queueForCloud(${K}))))`));

  // ── 7. attention ────────────────────────────────────────────────────────
  console.log('\nEach queue stops under its own name');
  await evalJs(c, `${C}.items = []; ${K}.items = []; queueChanged(${C}); queueChanged(${K});
    setQuestion("council lost"); $("btnQueue").click();
    window.__where = link.where; link.where = "gone";
    queueDrain(${C}, ++${C}.gen).then(() => { link.where = window.__where; }); return 1;`);
  ok('council: "Queue stopped"', await waitFor(c, 'ATTN.keys.has("queue:stopped") && /Queue stopped/.test(document.title)', 4000));
  await waitFor(c, 'online()', 4000);
  await evalJs(c, `attnClear("queue:stopped"); $("navCodeNew").click(); setQuestion("code lost"); $("btnQueue").click();
    window.__where = link.where; link.where = "gone";
    queueDrain(${K}, ++${K}.gen).then(() => { link.where = window.__where; }); return 1;`);
  ok('code: "Code queue stopped"', await waitFor(c, 'ATTN.keys.has("codequeue:stopped") && /Code queue stopped/.test(document.title)', 4000));
  await waitFor(c, 'online()', 4000);
  await evalJs(c, 'document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return 1;');
  ok('a touch clears both', await waitFor(c, '!ATTN.keys.has("queue:stopped") && !ATTN.keys.has("codequeue:stopped")', 3000));

  console.log('\nPhone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  ok('phone: no horizontal overflow', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'));
  await evalJs(c, '$("queueDrawer").scrollIntoView(); return 1;');
  await shot(c, 'qs-4-phone-code-queue');

  console.log('\nNothing else');
  ok('no unstubbed writes', (await evalJs(c, 'window.__cap.posts')).length === 0, JSON.stringify(await evalJs(c, 'window.__cap.posts')));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await evalJs(c, `${C}.items = []; ${K}.items = []; saveQueueLocal(${C}); saveQueueLocal(${K}); return 1;`);
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
