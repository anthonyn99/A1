// LIVE test -- reads the real engine on this PC; starts NO task, spends nothing.
// Every POST is stubbed, the check endpoints are faked, and Code task streams
// are fake EventSources the test drives by hand.
// Run: node tests/live/magi-code-check.live.js   Screenshots: %TEMP%/magi-live-shots
//
// 1. The Check pill and sheet: suggestions, Try it now, Automatic warning, Save.
// 2. The approval card: Run check, clock held then released, result + output.
// 3. Copy: a code block copies exactly the command; an answer copies its markdown,
//    and the rich copy carries no button or language-label chrome.
// 4. The queue's Edit sheet uses the composer's type (council AND code rows).
// 5. Phone: nothing overflows; controls are fingertip-sized.
// 6. Veda's profile: the same UI, rendered the same way.
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const URL = require('./cdp.js').PAGES_URL;

const STUB = `if (window.top === window) (() => {
  const real = window.fetch;
  const json = (d, st = 200) => Promise.resolve(new Response(JSON.stringify(d),
    { status: st, headers: { 'Content-Type': 'application/json' } }));
  window.__cap = { posts: [], checkSet: [], tries: [], runCheck: [], clip: [] };
  window.__check = { command: '', auto: false, timeout_min: 10 };
  let n = 0;
  window.__fake = {};
  window.fetch = async (u, o) => {
    const s = String(u && u.url ? u.url : u);
    const m = ((o && o.method) || (u && u.method) || 'GET').toUpperCase();
    if (s.indexOf('/auth/journal/status') >= 0) return json({ ok: true, hasLock: false });
    if (s.indexOf('firebase') >= 0 || s.indexOf('googleapis') >= 0 || s.indexOf('gstatic') >= 0)
      return Promise.reject(new TypeError('blocked'));
    let mm;
    if ((mm = /\\/api\\/code\\/projects\\/([^/]+)\\/check\\/try$/.exec(s))) {
      const b = JSON.parse(o.body); window.__cap.tries.push(b);
      await new Promise((r) => setTimeout(r, 200));
      return json({ ok: true, result: { ok: false, code: 1, timed_out: false, stopped: false, secs: 1.2,
        output: 'FAIL tests/a.test.js\\n  expected 1 to be 2' } });
    }
    if ((mm = /\\/api\\/code\\/projects\\/([^/]+)\\/check$/.exec(s))) {
      if (m === 'POST') {
        const b = JSON.parse(o.body); window.__cap.checkSet.push(b);
        window.__check = { command: b.command, auto: !!b.auto && !!b.command, timeout_min: b.timeout_min };
        return json({ ok: true, check: window.__check });
      }
      return json({ ok: true, check: window.__check, local: true,
        suggestions: [{ command: 'npm test', why: 'package.json “test”: vitest run' },
                      { command: '.venv\\\\Scripts\\\\python.exe -m pytest -q', why: 'Python tests (pyproject.toml)' }],
        limits: { max_command: 500, max_timeout_min: 60 } });
    }
    if ((mm = /\\/api\\/code\\/tasks\\/([^/]+)\\/check$/.exec(s)) && m === 'POST') {
      window.__cap.runCheck.push(mm[1]);
      return json({ ok: true });
    }
    if (/\\/api\\/code\\/tasks(\\?|$)/.test(s) && m === 'POST') {
      const body = JSON.parse(o.body); const id = 'ck' + (++n);
      window.__fake[id] = { done: false, body };
      return json({ ok: true, task: { id, prompt: body.prompt } });
    }
    if (/\\/api\\/code\\/tasks(\\?|$)/.test(s)) {
      return json({ ok: true, tasks: Object.entries(window.__fake).map(([id, t]) => ({ id, done: t.done })) });
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
    }
    emit(ev) { if (this.readyState !== 2 && this.onmessage) this.onmessage({ data: JSON.stringify(ev) }); }
    close() { this.readyState = 2; }
  };
  // The clipboard, captured: headless Chrome has none worth reading back.
  const cap = (html, text) => { window.__cap.clip.push({ html, text }); return Promise.resolve(); };
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async (items) => {
        const it = items[0]; const t = await (await it.getType('text/plain')).text();
        const h = await (await it.getType('text/html')).text(); return cap(h, t); },
      writeText: (t) => cap('', t) } });
  } catch {}
})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 400) + ']' : '')); }
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
const noOverflow = 'document.documentElement.scrollWidth <= innerWidth + 1';
const font = (sel) => `return (() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const c = getComputedStyle(e); return [c.fontFamily, c.fontSize, c.fontWeight].join("|"); })()`;

const MD = [
  'Here is the ranking.', '',
  '| # | File | Size |', '|---|---|---|', '| 1 | `index.html` | 2.5 MB |', '| 2 | `magi.html` | 1.2 MB |', '',
  'Run this in PowerShell:', '',
  '```powershell',
  "Get-ChildItem -Recurse -File | Where-Object { $_.FullName -notmatch '\\\\profiles\\\\' } | Sort-Object Length -Descending | Select-Object -First 20 FullName, Length",
  '```', '', 'Done.'].join('\n');

async function editSheetFonts(c, label) {
  // The composer's own chip and text, against the sheet's.
  // The composer's chip when it is drawn; offline (Veda's engine lives on her
  // PC), a probe chip built the way the composer builds one.
  let compChip = await evalJs(c, font('#unitChips .chip-model'));
  if (!compChip) {
    compChip = await evalJs(c, `const b = el("button", "chip"); b.id = "chipProbe"; b.append(el("span", "chip-model", "X"));
      $("unitChips").append(b); ${font('#chipProbe .chip-model').replace(/^return /, 'const r = ')}; b.remove(); return r;`);
  }
  await evalJs(c, `if (!S.selected.size) S.selected.add((S.providers[0] || knownUnits()[0]).id);
    QUEUES.council.items = [{ id: "fx1", q: "Compare all the A1 programs", units: [...S.selected], atts: [], status: "queued",
      order: 1000, dev: "PC", runId: null, err: null }]; renderQueue(); queueEdit("fx1"); return 1;`);
  await waitFor(c, '!!document.querySelector(".qedit")');
  const sheetChip = await evalJs(c, font('.qedit-units .chip-model'));
  const sheetText = await evalJs(c, font('.qedit-text'));
  const compText = await evalJs(c, font('#composer'));
  ok(`${label}: edit sheet chips use the composer's type`, !!sheetChip && sheetChip === compChip, `${sheetChip} vs ${compChip}`);
  ok(`${label}: edit sheet text uses the composer's type`, !!sheetText && sheetText === compText, `${sheetText} vs ${compText}`);
  ok(`${label}: no unstyled chip-name spans`, await evalJs(c, '!document.querySelector(".qedit .chip-name")'));
  await shot(c, `ck-${label}-edit-sheet`);
  await evalJs(c, 'document.querySelector(".qedit").closest(".sheet").remove(); QUEUES.council.items = []; queueChanged(QUEUES.council); return 1;');
}

async function copyChecks(c, label) {
  // An answer with a table and a PowerShell block, rendered as Code Mode does.
  await evalJs(c, `window.__cap.clip = []; const host = document.createElement("div"); host.id = "mdProbe";
    host.className = "code-answer"; host.style.cssText = "max-width:700px";
    const r = mdBody(${JSON.stringify(MD)}); host.append(r);
    host.append(copyButton(() => ({ node: r, md: ${JSON.stringify(MD)} })));
    document.querySelector("main, body").prepend(host); host.scrollIntoView(); return 1;`);
  ok(`${label}: the code block has a header with its language`, /powershell/i.test(await evalJs(c,
    'document.querySelector("#mdProbe .md-pre-hd .md-pre-lang").textContent')));
  ok(`${label}: and a Copy button`, await evalJs(c, vis('#mdProbe .md-pre-hd .copybtn')));
  await evalJs(c, 'document.querySelector("#mdProbe .md-pre-hd .copybtn").click(); return 1;');
  await waitFor(c, 'window.__cap.clip.length === 1', 3000);
  const clip1 = await evalJs(c, 'window.__cap.clip[0]');
  const cmd = MD.split('```powershell\n')[1].split('\n```')[0];
  ok(`${label}: the block copies exactly the command`, clip1 && clip1.text === cmd, clip1 && clip1.text);
  ok(`${label}: button says Copied`, /Copied/.test(await evalJs(c, 'document.querySelector("#mdProbe .md-pre-hd .copybtn").textContent')));
  await evalJs(c, '[...document.querySelectorAll("#mdProbe > .copybtn")].pop().click(); return 1;');
  await waitFor(c, 'window.__cap.clip.length === 2', 3000);
  const clip2 = await evalJs(c, 'window.__cap.clip[1]');
  ok(`${label}: the answer copies its markdown, unchanged`, clip2 && clip2.text === MD.trim(), clip2 && clip2.text.slice(0, 120));
  ok(`${label}: the rich copy keeps the table`, clip2 && /<table/i.test(clip2.html));
  ok(`${label}: and no chrome (label, buttons)`, clip2 && !/md-pre-hd|md-pre-lang|copybtn/.test(clip2.html) && !/<button/i.test(clip2.html)
     && /Run this in PowerShell/.test(clip2.html), clip2 && clip2.html.slice(0, 200));
  await shot(c, `ck-${label}-copy`);
  await evalJs(c, 'document.getElementById("mdProbe").remove(); return 1;');
}

async function cardRender(c, label) {
  // The check section, drawn from events alone (no engine needed).
  const exp = await evalJs(c, 'Date.now() / 1000 + 280');
  await evalJs(c, `const t = { id: "x", events: [
      { k: "approval", files: [{ path: "a.js", status: "M", adds: 1, dels: 1, hunks: [] }], adds: 1, dels: 1,
        expires_at: ${exp}, check: { command: "npm test", auto: false, timeout_min: 10 } },
      { k: "check", state: "done", ok: false, code: 1, secs: 3.4, command: "npm test",
        output: "FAIL a.test.js\\n  expected 1 to be 2", linked: ["node_modules"] } ], done: false };
    const box = renderCodeApproval(t, t.events[0]); box.id = "cardProbe"; box.style.maxWidth = "700px";
    document.querySelector("main, body").prepend(box); box.scrollIntoView(); return 1;`);
  ok(`${label}: the card shows the failed check`, /failed · exit 1/.test(await evalJs(c,
    'document.querySelector("#cardProbe .code-check-st").textContent')));
  ok(`${label}: a failure opens its output`, await evalJs(c, 'document.querySelector("#cardProbe .code-check-out").open'));
  ok(`${label}: says the deps were linked, then removed`, /node_modules/.test(await evalJs(c,
    'document.querySelector("#cardProbe .code-check-note").textContent')));
  ok(`${label}: offers Run again`, /Run again/.test(await evalJs(c, 'document.querySelector("#cardProbe .code-check-run").textContent')));
  await shot(c, `ck-${label}-card`);
  await evalJs(c, 'document.getElementById("cardProbe").remove(); return 1;');
}

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
  await evalJs(c, 'localStorage.clear(); sessionStorage.clear(); return 1;');
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 25000));

  // ── 1. The Check pill and sheet ───────────────────────────────────────
  console.log('\nThe Check pill and sheet');
  await evalJs(c, '$("navCodeNew").click(); return 1;');
  ok('code state loaded', await waitFor(c, '!!CODE.state && !!CODE.agents', 25000));
  await evalJs(c, 'if (!codeProject()) codeSetProject(CODE.state.projects[0].id); renderCodeView(); return 1;');
  ok('a Check pill on the strip', await waitFor(c, '[...document.querySelectorAll("#codeStrip .code-pill")].some((p) => /Check/.test(p.textContent))'));
  ok('it says off', /Checkoff/.test(await evalJs(c, '[...document.querySelectorAll("#codeStrip .code-pill")].find((p) => /Check/.test(p.textContent)).textContent')));
  await evalJs(c, '[...document.querySelectorAll("#codeStrip .code-pill")].find((p) => /Check/.test(p.textContent)).click(); return 1;');
  ok('the sheet opens', await waitFor(c, '!!document.querySelector(".ck-sheet")'));
  ok('suggestions from the folder', await evalJs(c, 'document.querySelectorAll(".ck-sug-b").length') === 2);
  ok('Save waits for a command', await evalJs(c, '[...document.querySelectorAll(".ck-sheet .sheet-bar .btn")][0].disabled'));
  await evalJs(c, 'document.querySelector(".ck-sug-b").click(); return 1;');
  ok('a suggestion fills the command', await evalJs(c, 'document.querySelector(".ck-cmd").value') === 'npm test');
  await evalJs(c, '[...document.querySelectorAll(".ck-sheet .code-git-act")].find((b) => b.textContent === "Automatically").click(); return 1;');
  ok('Automatic says what it risks', /before anyone has looked at it/.test(await evalJs(c, 'document.querySelector(".ck-sheet").textContent')));
  await evalJs(c, '[...document.querySelectorAll(".ck-sheet .code-git-act")].find((b) => b.textContent === "On the card").click(); return 1;');
  await evalJs(c, '[...document.querySelectorAll(".ck-sheet .navitem")].find((b) => /Try it now/.test(b.textContent)).click(); return 1;');
  ok('Try it now shows the result', await waitFor(c, '/failed · exit 1/.test((document.querySelector(".ck-res-hd")||{}).textContent||"")'));
  ok('with the output', /expected 1 to be 2/.test(await evalJs(c, 'document.querySelector(".ck-res .code-check-pre").textContent')));
  await shot(c, 'ck-1-sheet');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  ok('phone: the sheet fits', await evalJs(c, noOverflow) && await evalJs(c,
    'document.querySelector(".ck-sheet").getBoundingClientRect().right <= innerWidth + 1'));
  ok('phone: Try is a fingertip target', (await evalJs(c,
    '[...document.querySelectorAll(".ck-sheet .navitem")].find((b) => /Try/.test(b.textContent)).getBoundingClientRect().height')) >= 38);
  await shot(c, 'ck-2-sheet-phone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evalJs(c, '[...document.querySelectorAll(".ck-sheet .sheet-bar .btn")][0].click(); return 1;');
  ok('Save posts the command', await waitFor(c, 'window.__cap.checkSet.length === 1'));
  const set = await evalJs(c, 'window.__cap.checkSet[0]');
  ok('as typed, on the card, with its timeout', set.command === 'npm test' && set.auto === false && set.timeout_min === 10, JSON.stringify(set));
  ok('the pill follows', await waitFor(c, '[...document.querySelectorAll("#codeStrip .code-pill")].some((p) => /on the card/.test(p.textContent))'));

  // ── 2. The approval card ──────────────────────────────────────────────
  console.log('\nThe approval card');
  await evalJs(c, 'codeClearTask(); CODE.rw = "write"; renderCodeView(); setQuestion("edit something"); $("btnSend").click(); return 1;');
  ok('task started', await waitFor(c, 'CODE.task && CODE.task.id === "ck1" && !!window.__es.ck1'));
  const exp = await evalJs(c, 'Date.now() / 1000 + 290');
  await evalJs(c, `window.__es.ck1.emit({ k: "start", prompt: "edit something", mode: "write", chain: [] });
    window.__es.ck1.emit({ k: "approval", files: [{ path: "a.js", status: "M", adds: 1, dels: 1, hunks: [] }],
      adds: 1, dels: 1, expires_at: ${exp}, timeout: 300, check: { command: "npm test", auto: false, timeout_min: 10 } });
    return 1;`);
  ok('the card offers Run check', await waitFor(c, '/Run check/.test((document.querySelector(".code-check-run")||{}).textContent||"")'));
  ok('and says look at the diff first', /look at the diff first/.test(await evalJs(c, 'document.querySelector(".code-check").textContent')));
  ok('the approval rings: tab marked', await waitFor(c, '/Approve\\?/.test(document.title)', 4000));
  await evalJs(c, 'document.querySelector(".code-check-run").click(); return 1;');
  ok('Run check posts to the task', await waitFor(c, 'window.__cap.runCheck[0] === "ck1"'));
  await evalJs(c, `window.__es.ck1.emit({ k: "deadline", expires_at: Date.now() / 1000 + 900, held: true });
    window.__es.ck1.emit({ k: "check", state: "running", command: "npm test", auto: false, timeout_min: 10 }); return 1;`);
  ok('running shows a spinner', await waitFor(c, '/running/.test(document.querySelector(".code-check-st").textContent)'));
  ok('the clock says it is held', /clock held/.test(await evalJs(c, 'document.querySelector(".code-appr-cd").textContent')));
  ok('no Run button while it runs', await evalJs(c, '!document.querySelector(".code-check-run")'));
  await shot(c, 'ck-3-card-running');
  await evalJs(c, `window.__es.ck1.emit({ k: "check", state: "done", ok: true, code: 0, secs: 4.1, command: "npm test",
      output: "PASS 12 tests", linked: [] });
    window.__es.ck1.emit({ k: "deadline", expires_at: Date.now() / 1000 + 300, held: false }); return 1;`);
  ok('a pass shows as passed', await waitFor(c, '/passed · 4.1s/.test(document.querySelector(".code-check-st").textContent)'));
  ok('its output starts folded', await evalJs(c, '!document.querySelector(".code-check-out").open'));
  ok('the countdown is back, a full window', /[45]:\d\d/.test(await evalJs(c, 'document.querySelector(".code-appr-cd").textContent')),
     await evalJs(c, 'document.querySelector(".code-appr-cd").textContent'));
  ok('Run again offered', /Run again/.test(await evalJs(c, 'document.querySelector(".code-check-run").textContent')));
  await shot(c, 'ck-4-card-passed');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  ok('phone: the card fits', await evalJs(c, noOverflow), await evalJs(c, 'document.documentElement.scrollWidth'));
  ok('phone: Run again is tappable', (await evalJs(c, 'document.querySelector(".code-check-run").getBoundingClientRect().height')) >= 38);
  await evalJs(c, 'document.querySelector(".code-check").scrollIntoView({block:"center"}); return 1;');
  await shot(c, 'ck-5-card-phone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evalJs(c, 'window.__es.ck1.emit({ k: "decision", approved: false, why: "denied" }); window.__es.ck1.emit({ k: "end", result: { outcome: "ok", write: "denied" } }); return 1;');
  ok('the decision clears the tab mark', await waitFor(c, '!/Approve\\?/.test(document.title)', 4000));

  // A Code answer: its own Copy works (it passed a string, and did nothing).
  console.log('\nThe answer Copy (was broken)');
  await evalJs(c, `codeClearTask(); CODE.rw = "read"; setQuestion("rank"); $("btnSend").click(); return 1;`);
  await waitFor(c, '!!window.__es.ck2');
  await evalJs(c, `window.__cap.clip = []; window.__es.ck2.emit({ k: "start", prompt: "rank", mode: "read", chain: [] });
    window.__es.ck2.emit({ k: "text", text: ${JSON.stringify(MD)} });
    window.__es.ck2.emit({ k: "end", result: { outcome: "ok" } }); return 1;`);
  ok('the answer renders', await waitFor(c, '!!document.querySelector(".code-answer .code-answer-foot .copybtn")'));
  await evalJs(c, 'document.querySelector(".code-answer .code-answer-foot .copybtn").click(); return 1;');
  ok('pressing it copies', await waitFor(c, 'window.__cap.clip.length === 1', 3000));
  const clipA = await evalJs(c, 'window.__cap.clip[0]');
  ok('the markdown, exactly', clipA && clipA.text === MD.trim(), clipA && clipA.text.slice(0, 80));
  ok('the code block inside it has its own Copy', await evalJs(c, '!!document.querySelector(".code-answer .md-pre-hd .copybtn")'));
  await shot(c, 'ck-6-answer');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  ok('phone: the answer and its code block fit', await evalJs(c, noOverflow));
  ok('phone: the block Copy is tappable', (await evalJs(c, 'document.querySelector(".code-answer .md-pre-hd .copybtn").getBoundingClientRect().height')) >= 32);
  await evalJs(c, 'document.querySelector(".code-answer .md-pre-wrap").scrollIntoView({block:"center"}); return 1;');
  await shot(c, 'ck-7-answer-phone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evalJs(c, 'codeClearTask(); return 1;');

  // ── 3/4. Copy + edit sheet, Tony ──────────────────────────────────────
  console.log('\nCopy buttons (Tony)');
  await evalJs(c, '$("navNew").click(); return 1;');
  await sleep(500);
  await copyChecks(c, 'tony');
  console.log('\nEdit sheet type (Tony, council row)');
  await editSheetFonts(c, 'tony');
  console.log('\nEdit sheet type (Tony, code row)');
  await evalJs(c, '$("navCodeNew").click(); return 1;');
  await sleep(400);
  const codeComp = await evalJs(c, font('.code-chip .chip-model'));
  await evalJs(c, `QUEUES.code.items = [{ id: "fx2", q: "code row", units: [], atts: [], status: "queued", order: 1000, dev: "PC",
    runId: null, err: null, kind: "code", agents: codeChain().map((m) => m.id), pid: codeProject().id,
    pname: codeProject().name, rw: "read" }]; queueChanged(QUEUES.code); queueEdit("fx2"); return 1;`);
  await waitFor(c, '!!document.querySelector(".qedit")');
  const codeSheet = await evalJs(c, font('.qedit-units .chip-model'));
  ok('code row: sheet chips match the Code composer', !!codeSheet && codeSheet === codeComp, `${codeSheet} vs ${codeComp}`);
  ok('code row: chips carry code-chip', await evalJs(c, '!!document.querySelector(".qedit-units .chip.code-chip")'));
  await shot(c, 'ck-8-edit-code');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  ok('phone: the edit sheet fits', await evalJs(c, noOverflow) && await evalJs(c,
    'document.querySelector(".qedit").getBoundingClientRect().right <= innerWidth + 1'));
  await shot(c, 'ck-9-edit-phone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evalJs(c, 'document.querySelector(".qedit").closest(".sheet").remove(); QUEUES.code.items = []; queueChanged(QUEUES.code); return 1;');

  // ── 6. Veda ───────────────────────────────────────────────────────────
  console.log('\nVeda\'s profile');
  await evalJs(c, 'sessionStorage.setItem(PICK_SS, "veda"); return 1;');
  await c.send('Page.navigate', { url: URL });
  await waitFor(c, 'typeof PROFILE === "object" && PROFILE.id === "veda"', 15000);
  ok('the page is Veda\'s', await evalJs(c, 'PROFILE.id') === 'veda');
  ok('her storage is her own', await evalJs(c, 'lsKey("queue")') === 'magi.veda.queue');
  await waitFor(c, 'typeof S === "object" && Array.isArray(S.providers) && S.providers.length > 0', 15000);
  await evalJs(c, '$("navNew").click(); return 1;');
  await sleep(500);
  await copyChecks(c, 'veda');
  await cardRender(c, 'veda');
  await editSheetFonts(c, 'veda');
  // The hold banner renders the same for her.
  await evalJs(c, `QUEUES.council.items = [{ id: "h1", q: "held", units: [], atts: [], status: "queued", order: 1000, dev: "PC", runId: null, err: null }];
    QUEUES.council.running = true; QUEUES.council.hold = { until: Date.now() + 30 * 60000, known: true, why: "The council is rate limited." };
    renderQueue(); return 1;`);
  ok('veda: the hold banner renders', /runs again when the limit lifts/.test(await evalJs(c, '$("queueHoldTxt").textContent')));
  await evalJs(c, 'QUEUES.council.hold = null; QUEUES.council.running = false; QUEUES.council.items = []; queueChanged(QUEUES.council); sessionStorage.removeItem(PICK_SS); return 1;');

  console.log('\nNothing else reached the engine');
  ok('no unstubbed write', (await evalJs(c, 'window.__cap.posts')).length === 0, JSON.stringify(await evalJs(c, 'window.__cap.posts')));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
