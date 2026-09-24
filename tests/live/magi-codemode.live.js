// LIVE test -- drives the real engine on this PC (not run by run-all.js).
// Run: node tests/live/magi-codemode.live.js   Screenshots: %TEMP%/magi-live-shots
// Live: Code Mode against the real engine -- workspace, chips, a real run,
// the transcript, Accounts' coding section. Screenshots at desktop and phone.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
// Served by the engine: since Phase 14 a file:// page (Origin "null") is refused.
const URL = 'http://127.0.0.1:8000/';
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
    await sleep(300);
  }
  return false;
};

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
  await c.send('Page.navigate', { url: URL }); await sleep(3000);
  await evalJs(c, 'localStorage.clear(); sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "code"); localStorage.setItem(lsKey("code.project"), JSON.stringify("proj_60d8f14fbc1c")); return 1;');
  await c.send('Page.navigate', { url: URL });

  console.log('\nConnects and paints Code Mode from the engine');
  ok('engine online', await waitFor(c, 'online()', 25000));
  ok('state + agents loaded', await waitFor(c, '!!(CODE.state && CODE.agents)'));
  // A1 by id: since Phase 12 there is more than one project (magi-push-test).
  ok('A1 is the project', await evalJs(c, 'codeProject() && codeProject().name') === 'A1');
  ok('workspace row shows the path',
     (await evalJs(c, 'document.querySelector(".code-ws-path").textContent')).indexOf('A1') >= 0);
  const chips = JSON.parse(await evalJs(c, 'return JSON.stringify([...document.querySelectorAll(".code-chip")].map(b=>b.dataset.agent));'));
  ok('Claude CLI leads the chips', chips[0] === 'claude-cli', chips.join(','));
  ok('Codex CLI is second', chips[1] === 'codex-cli');
  ok('browser units follow', chips.includes('chatgpt') && chips.includes('claude-pro'));
  const cxNote = await evalJs(c, 'document.querySelector(\'.code-chip[data-agent="codex-cli"] .chip-unit\').textContent');
  ok('Codex chip shows its usage window', /\d+%/.test(cxNote), cxNote);
  const clNote = await evalJs(c, 'document.querySelector(\'.code-chip[data-agent="claude-cli"] .chip-unit\').textContent');
  ok('Claude chip shows 5h AND 7d', /5h \d+% · 7d \d+%/.test(clNote), clNote);
  ok('no number badges on the chips', await evalJs(c, 'document.querySelectorAll(".code-chip-n").length') === 0);
  ok('the Agents label sits above the chips', await evalJs(c,
     'const l=document.querySelector(".code-chain-lbl").getBoundingClientRect(), k=document.querySelector(".code-chip").getBoundingClientRect(); return l.bottom <= k.top + 1;'));
  ok('unit bar still hidden in Code Mode', await evalJs(c, 'document.getElementById("unitBar").hidden') === true);
  await shot(c, 'coderun-desktop-idle');

  console.log('\nTicking is per Code Mode, separate from Deliberation');
  const before = await evalJs(c, 'S.selected.size');
  await evalJs(c, 'document.querySelector(\'.code-chip[data-agent="grok"]\').click(); return 1;');
  ok('grok unticked in the chain', await evalJs(c, '!codeTicked().has("grok")'));
  ok('Deliberation selection untouched', await evalJs(c, 'S.selected.size') === before);
  ok('stored under code.units', (await evalJs(c, 'localStorage.getItem(lsKey("code.units"))') || '').indexOf('known') >= 0);
  await evalJs(c, 'document.querySelector(\'.code-chip[data-agent="grok"]\').click(); return 1;');

  console.log('\nRun is gated honestly');
  ok('Run disabled with an empty box', await evalJs(c, 'document.getElementById("btnSend").disabled') === true);
  await evalJs(c, 'const t=document.getElementById("composer"); t.value="In one sentence: what file defines the MAGI engine\'s FastAPI app?"; t.dispatchEvent(new Event("input")); return 1;');
  ok('Run enabled with words + workspace + agents', await evalJs(c, 'document.getElementById("btnSend").disabled') === false);
  ok('labelled Run', await evalJs(c, 'document.getElementById("btnSend").textContent') === 'Run');

  console.log('\nA real task, streamed');
  const t0 = Date.now();
  await evalJs(c, 'document.getElementById("btnSend").click(); return 1;');
  ok('task attached', await waitFor(c, '!!CODE.task', 8000));
  ok('Run shows Working while busy', await waitFor(c, 'document.getElementById("btnSend").textContent === "Working…"', 5000));
  ok('Halt offered while running', await waitFor(c, '!!document.querySelector(".code-task-acts .danger")', 5000));
  ok('an agent line appears', await waitFor(c, '!!document.querySelector(".code-ev.is-agent")', 15000));
  await shot(c, 'coderun-desktop-running');
  ok('finished', await waitFor(c, 'CODE.task && CODE.task.done', 120000), ((Date.now() - t0) / 1000).toFixed(1) + 's');
  const st = await evalJs(c, 'document.querySelector(".code-task-st").textContent');
  ok('status says done by Claude', /Done by Claude/.test(st), st);
  const ans = await evalJs(c, 'document.querySelector(".code-answer") ? document.querySelector(".code-answer").textContent : ""');
  ok('answer names app.py', /app\.py/.test(ans), ans.slice(0, 140));
  const tools = await evalJs(c, 'return JSON.stringify([...document.querySelectorAll(".code-ev-arg")].map(n=>n.textContent));');
  ok('tool targets are workspace-relative', !/C:\\\\Users/.test(tools), tools.slice(0, 200));
  ok('composer cleared after submit', await evalJs(c, 'document.getElementById("composer").value') === '');
  await shot(c, 'coderun-desktop-done');

  console.log('\nA reload reattaches and replays');
  await c.send('Page.navigate', { url: URL });
  ok('reattached after reload', await waitFor(c, 'CODE.task && CODE.task.done && CODE.task.events.length > 3', 25000));
  ok('answer replayed', await waitFor(c, '!!document.querySelector(".code-answer")', 5000));

  console.log('\nPhone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  const overflow = await evalJs(c, 'document.documentElement.scrollWidth - window.innerWidth');
  ok('no horizontal page scroll at 390', overflow <= 0, String(overflow));
  const offs = await evalJs(c, 'return JSON.stringify([...document.querySelectorAll(".code-chip, .code-ws, .code-task, #btnSend")].filter(n=>{const r=n.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1);}).map(n=>n.className));');
  ok('nothing sticks off-screen', offs === '[]', offs);
  await shot(c, 'coderun-phone-done');

  console.log('\nOrder sheet');
  await evalJs(c, 'openCodeOrder(); return 1;'); await sleep(300);
  ok('lists every member', await evalJs(c, 'document.querySelectorAll(".code-order-row").length') === chips.length);
  await evalJs(c, 'document.querySelectorAll(".code-order-mv")[3].click(); return 1;'); // move codex (row 2) down
  ok('moving changes the chain order', (await evalJs(c, 'codeMembers()[1].id')) !== 'codex-cli');
  await shot(c, 'coderun-phone-order');
  await evalJs(c, '[...document.querySelectorAll(".sheet .btn")].find(b=>b.textContent==="Default order").click(); return 1;');
  ok('default order restores', await evalJs(c, 'codeMembers()[1].id') === 'codex-cli');
  await evalJs(c, 'document.querySelector(".sheet").remove(); return 1;');

  console.log('\nFolder browser');
  await evalJs(c, 'openCodeBrowse("~"); return 1;');
  ok('lists folders under home', await waitFor(c, 'document.querySelectorAll(".code-dir").length > 2', 8000));
  await shot(c, 'coderun-phone-browse');
  await evalJs(c, 'document.querySelector(".sheet").remove(); return 1;');

  console.log('\nAccounts: coding agents');
  await evalJs(c, 'setView("accounts"); loadAccounts(); return 1;');
  // The CLI cards only: since Phase 10 the section also holds a GitHub card.
  ok('coding section drawn', await waitFor(c, '[...document.querySelectorAll(".acc-code .acc-card .acc-name")].filter(n=>/ CLI$/.test(n.textContent)).length === 2', 20000));
  const acc = await evalJs(c, 'document.querySelector(".acc-code").textContent');
  ok('Claude system slot shows the account', /anthonypn99@gmail\.com/.test(acc));
  const names = JSON.parse(await evalJs(c, 'return JSON.stringify([...document.querySelectorAll("input.acc-slot-name")].map(i=>i.placeholder));'));
  ok('Codex account is listed', names.includes('codex1'), names.join(','));
  ok('both slots can be renamed in place', names.length === 2);
  ok('Codex usage is shown with its reset', /30d used \d+%/.test(acc), (acc.match(/30d used[^·]*/) || [''])[0]);
  ok('Claude weekly is shown too', /7d used \d+%/.test(acc), (acc.match(/7d used[^·]*/) || [''])[0]);
  // Renaming a slot round-trips to the engine and back into the chips.
  await evalJs(c, 'const i=[...document.querySelectorAll(".acc-slot-name")].find(x=>x.placeholder==="codex1"); i.value="Tony free"; i.onblur(); return 1;');
  await sleep(2000);
  ok('the new name sticks', await evalJs(c, 'return CODE.agents.cli.find(x=>x.agent==="codex").slots[0].label === "Tony free";'));
  await evalJs(c, 'const i=[...document.querySelectorAll(".acc-slot-name")].find(x=>x.placeholder==="codex1"); i.value=""; i.onblur(); return 1;');
  await sleep(1500);
  ok('and can be cleared again', await evalJs(c, 'return !CODE.agents.cli.find(x=>x.agent==="codex").slots[0].label;'));
  await shot(c, 'coderun-phone-accounts');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await shot(c, 'coderun-desktop-accounts');

  ok('no uncaught exceptions', errs.length === 0, errs.join(' | ').slice(0, 300));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
