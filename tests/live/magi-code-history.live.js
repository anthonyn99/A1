// LIVE test -- reads the real engine on this PC (starts no task, spends nothing).
// Run: node tests/live/magi-code-history.live.js   Screenshots: %TEMP%/magi-live-shots
// Code Mode as its own sidebar section: New session / History, per-mode
// drafts, the council-only controls hidden in Code Mode, and History's pin,
// rename, delete and 30-day expiry. Desktop and phone.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const URL = require('./cdp.js').PAGES_URL;
const STUB = `if (window.top === window) (()=>{const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
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
    await sleep(300);
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

  console.log('\nThe sidebar');
  ok('Code Mode section exists', await evalJs(c, '!!document.getElementById("codeSec")'));
  ok('composer mode switch is gone', await evalJs(c, '!document.getElementById("modeSw") && !document.querySelector(".mode-opt")'));
  ok('New deliberation lit on load', await evalJs(c, '$("navNew").classList.contains("active") && !$("navCodeNew").classList.contains("active")'));
  ok('Queue visible in Deliberation', await evalJs(c, vis('#btnQueue')));
  await shot(c, 'codehist-1-desktop-deliberation');

  console.log('\nNew session and the drafts');
  await evalJs(c, '$("composer").value = "a council question"; return 1;');
  await evalJs(c, '$("navCodeNew").click(); return 1;');
  ok('mode is code', await evalJs(c, 'MODE.cur') === 'code');
  ok('code view shown', await evalJs(c, vis('#codeView')));
  ok('Code New session lit, New deliberation not',
     await evalJs(c, '$("navCodeNew").classList.contains("active") && !$("navNew").classList.contains("active")'));
  ok('Queue/Refine/Attach hidden in Code Mode',
     await evalJs(c, `!${vis('#btnQueue')} && !${vis('#btnRefine')} && !${vis('#btnAttach')}`));
  ok('council draft not carried into code', await evalJs(c, '$("composer").value') === '');
  ok('header says Code Mode', await evalJs(c, 'document.querySelector(".council-title").textContent') === 'Code Mode');
  await evalJs(c, '$("composer").value = "a code task"; return 1;');
  await evalJs(c, '$("navNew").click(); return 1;');
  ok('back in Deliberation', await evalJs(c, 'MODE.cur') === 'deliberation');
  ok('New deliberation clears its box (as before)', await evalJs(c, '$("composer").value') === '');
  await evalJs(c, '$("navCodeNew").click(); return 1;');
  ok('code draft kept', await evalJs(c, '$("composer").value') === 'a code task');
  await waitFor(c, '!!CODE.state');
  await shot(c, 'codehist-2-desktop-code');

  console.log('\nHistory: rows, expiry, pins');
  const now = Date.now(), day = 864e5;
  await evalJs(c, `
    CODE_HIST.engine = [];
    codeSyncFromCloud({ tasks: [
      { id: "t_new", pid: "p1", project: "A1", prompt: "Fix the sidebar", outcome: "ok", by: "Claude CLI", write: true, at: new Date(${now - 3600e3}).toISOString(), device: "Tony PC" },
      { id: "t_mid", pid: "p2", project: "Other", prompt: "Explain the build", outcome: "task_failed", by: "Codex CLI", write: false, at: new Date(${now - 5 * day}).toISOString(), device: "Tony PC" },
      { id: "t_old", pid: "p1", project: "A1", prompt: "Ancient task", outcome: "ok", by: "Claude CLI", write: false, at: new Date(${now - 40 * day}).toISOString(), device: "Tony PC" },
      { id: "t_keep", pid: "p1", project: "A1", prompt: "Pinned ancient task", outcome: "ok", by: "Claude CLI", write: false, at: new Date(${now - 90 * day}).toISOString(), device: "Tony PC" },
    ]});
    CODE_PINS.add("t_keep");
    return 1;`);
  await evalJs(c, '$("navCodeHistory").click(); return 1;');
  ok('history drawer shown', await evalJs(c, vis('#codeHistoryDrawer')));
  ok('composer hidden on the list', !(await evalJs(c, vis('#qbar'))));
  ok('Code History lit', await evalJs(c, '$("navCodeHistory").classList.contains("active") && !$("navHistory").classList.contains("active")'));
  await waitFor(c, '!CODE_HIST.engineBusy');
  const ids = async () => JSON.parse(await evalJs(c, 'return JSON.stringify([...document.querySelectorAll("#codeHistoryRows .row")].map(r=>r.querySelector(".q").textContent));'));
  let rows = await ids();
  ok('expired unpinned row hidden', !rows.includes('Ancient task'), rows.join(' | '));
  ok('pinned old row kept, and first', rows[0] === 'Pinned ancient task');
  ok('newest unpinned next', rows[1] === 'Fix the sidebar');
  ok('count tag matches', await evalJs(c, 'Number($("navCodeHistoryTag").textContent)') === rows.length);
  ok('project filter shown (2 projects)', await evalJs(c, vis('#codeHistFilter')));
  await evalJs(c, '[...document.querySelectorAll(".code-hist-chip")].find(b=>b.textContent==="Other").click(); return 1;');
  rows = await ids();
  ok('filter narrows to Other', rows.length === 1 && rows[0] === 'Explain the build', rows.join(' | '));
  await evalJs(c, 'document.querySelector(".code-hist-chip").click(); return 1;');
  await shot(c, 'codehist-3-desktop-history');

  // Pin the mid row: it jumps above the unpinned one.
  await evalJs(c, '[...document.querySelectorAll("#codeHistoryRows .row")].find(r=>r.querySelector(".q").textContent==="Explain the build").querySelector(".row-act").click(); return 1;');
  rows = await ids();
  ok('pinning moves it up', rows.indexOf('Explain the build') < rows.indexOf('Fix the sidebar'), rows.join(' | '));
  ok('pin stored locally', await evalJs(c, 'JSON.parse(localStorage.getItem(lsKey("codepins"))).includes("t_mid")'));
  // Unpin a 90-day-old row: its 30 days restart, so it stays.
  await evalJs(c, '[...document.querySelectorAll("#codeHistoryRows .row")].find(r=>r.querySelector(".q").textContent==="Pinned ancient task").querySelector(".row-act").click(); return 1;');
  rows = await ids();
  ok('unpinned old row stays (clock restarted)', rows.includes('Pinned ancient task'));

  console.log('\nRename');
  await evalJs(c, '[...document.querySelectorAll("#codeHistoryRows .row")].find(r=>r.querySelector(".q").textContent==="Fix the sidebar").querySelectorAll(".row-act")[1].click(); return 1;');
  ok('rename sheet opens', await waitFor(c, '!!document.querySelector(".sheet .sheet-in")', 3000));
  await evalJs(c, 'const i=document.querySelector(".sheet .sheet-in"); i.value="Sidebar work"; document.querySelector(".sheet .btn.active").click(); return 1;');
  rows = await ids();
  ok('name shown instead of prompt', rows.includes('Sidebar work') && !rows.includes('Fix the sidebar'));

  console.log('\nDelete');
  await evalJs(c, '[...document.querySelectorAll("#codeHistoryRows .row")].find(r=>r.querySelector(".q").textContent==="Sidebar work").querySelector(".row-act.danger").click(); return 1;');
  ok('confirm sheet', await waitFor(c, '!!document.querySelector(".sheet .btn.active")', 3000));
  await evalJs(c, 'document.querySelector(".sheet .btn.active").click(); return 1;');
  await sleep(300);
  rows = await ids();
  ok('row gone', !rows.includes('Sidebar work'), rows.join(' | '));
  ok('tombstoned', await evalJs(c, 'CODE_GONE.has("t_new") && !CODE_NICKS.t_new'));
  ok('flush would drop it', await evalJs(c, 'codeHistRows().every(r => r.id !== "t_new")'));

  console.log('\nOpening an engine task and coming back');
  // A finished task the engine "still holds", replayed by a fake stream: the
  // real engine may have none, and starting one would spend a real account.
  await evalJs(c, `
    window.EventSource = class { constructor(u) { this.u = u; setTimeout(() => {
      for (const ev of [{ k: "start", prompt: "Replay me" }, { k: "note", text: "working" },
                        { k: "end", result: { outcome: "ok", by_label: "Claude CLI" } }]) {
        this.onmessage && this.onmessage({ data: JSON.stringify(ev) });
      } }, 50); } close() {} };
    CODE_HIST.engine = [{ id: "t_eng", pid: "", project: "", prompt: "Replay me", outcome: "ok",
      by: "Claude CLI", write: false, device: "Tony PC", engineOnly: true, at: new Date().toISOString() }];
    CODE_HIST.engineFrom = link.api; CODE_HIST.engineAt = Date.now();
    return 1;`);
  const engRows = await evalJs(c, 'CODE_HIST.engine.length');
  if (engRows) {
    await evalJs(c, 'const r = codeHistRows().find(x => x.engineOnly); codeOpenHistory(r); return 1;');
    ok('task card shown', await waitFor(c, '!!document.querySelector(".code-task")', 8000));
    ok('History stays lit while viewing', await evalJs(c, '$("navCodeHistory").classList.contains("active") && !$("navCodeNew").classList.contains("active")'));
    await waitFor(c, 'CODE.task && CODE.task.done', 8000);
    ok('back button', await evalJs(c, '[...document.querySelectorAll(".code-task-acts .navitem")].some(b=>/All code sessions/.test(b.textContent))'));
    await shot(c, 'codehist-4-desktop-opened');
    await evalJs(c, '[...document.querySelectorAll(".code-task-acts .navitem")].find(b=>/All code sessions/.test(b.textContent)).click(); return 1;');
    ok('back to the list', await evalJs(c, 'S.view') === 'codeHistory');
    await evalJs(c, '$("navCodeNew").click(); return 1;');
    ok('New session puts the task away', await evalJs(c, 'CODE.task === null && S.view === "council"'));
  } else {
    console.log('  (engine holds no finished tasks; open/back not exercised)');
  }

  console.log('\nDeliberation History still works');
  await evalJs(c, '$("navHistory").click(); return 1;');
  ok('deliberation history shown', await evalJs(c, vis('#historyDrawer')) && !(await evalJs(c, vis('#codeHistoryDrawer'))));
  ok('only deliberation History lit', await evalJs(c, '$("navHistory").classList.contains("active") && !$("navCodeHistory").classList.contains("active")'));

  console.log('\nPhone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evalJs(c, '$("navCodeHistory").click(); return 1;');
  await sleep(400);
  ok('no horizontal scroll', await evalJs(c, 'document.documentElement.scrollWidth <= window.innerWidth + 1'),
     String(await evalJs(c, 'document.documentElement.scrollWidth')));
  await shot(c, 'codehist-5-phone-history');
  await evalJs(c, '$("navBurger").click(); return 1;');
  await sleep(400);
  await shot(c, 'codehist-6-phone-drawer');
  await evalJs(c, '$("navCodeNew").click(); return 1;');
  await sleep(400);
  ok('drawer closes on tap', await evalJs(c, '$("navBurger").getAttribute("aria-expanded")') === 'false');
  ok('phone toolbar one row', await evalJs(c, 'return (()=>{const t=document.querySelector(".qbar-toolbar");return t.getBoundingClientRect().height < 60;})();'),
     String(await evalJs(c, 'document.querySelector(".qbar-toolbar").getBoundingClientRect().height')));
  await shot(c, 'codehist-7-phone-code');
  await evalJs(c, '$("navNew").click(); return 1;');
  await sleep(300);
  await shot(c, 'codehist-8-phone-deliberation');

  ok('no page errors', errs.length === 0, errs.join(' / '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
