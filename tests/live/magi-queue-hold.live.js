// LIVE test -- the queue's usage-limit hold on COUNCIL rows, the guess cap,
// the attention chime (incl. the one-minute approval reminder and mute), and
// Run again on a council row. No deliberation runs: runOne is replaced, and
// /api/units/usage is faked. Nothing reaches an account.
// Run: node tests/live/magi-queue-hold.live.js
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const URL = require('./cdp.js').PAGES_URL;

const STUB = `if (window.top === window) (() => {
  const real = window.fetch;
  const json = (d, st = 200) => Promise.resolve(new Response(JSON.stringify(d),
    { status: st, headers: { 'Content-Type': 'application/json' } }));
  window.__cap = { posts: [], usage: 0 };
  window.__limitUntil = null;
  window.fetch = async (u, o) => {
    const s = String(u && u.url ? u.url : u);
    const m = ((o && o.method) || (u && u.method) || 'GET').toUpperCase();
    if (s.indexOf('/auth/journal/status') >= 0) return json({ ok: true, hasLock: false });
    if (s.indexOf('firebase') >= 0 || s.indexOf('googleapis') >= 0 || s.indexOf('gstatic') >= 0)
      return Promise.reject(new TypeError('blocked'));
    if (s.indexOf('/api/units/usage') >= 0) {
      window.__cap.usage++;
      const r = await real(u, o); const d = await r.json();
      for (const x of d.units || []) {
        if (window.__limitUntil) { x.state = 'limited'; x.limit = { resets_at: window.__limitUntil, detail: 'limit' }; }
      }
      return json(d);
    }
    if (m !== 'GET') { window.__cap.posts.push(m + ' ' + s); return json({ ok: false, message: 'stubbed' }); }
    return real(u, o);
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
  await waitFor(c, 'S.providers.length > 0');

  // A fake council: every call is recorded; the outcome is whatever the test
  // sets next. strike() is counted so the chime can be heard in a test.
  await evalJs(c, `window.__runs = []; window.__next = [];
    runOne = async ({ question, units }) => {
      window.__runs.push(question);
      const o = window.__next.shift() || { ok: true };
      if (onRunStart) onRunStart("run" + window.__runs.length);
      await new Promise((r) => setTimeout(r, 50));
      return { runId: "run" + window.__runs.length, total: units.length, responded: o.ok ? units.length : 0, ...o };
    };
    window.__strikes = 0; strike = () => { window.__strikes++; };
    S.muted = false;
    S.selected = new Set([S.providers[0].id, S.providers[1].id]); return 1;`);
  const LIMITED = `{ ok: false, answers: [{ failure: "FailureKind.RATE_LIMITED" }, { failure: "rate limited" }] }`;

  console.log('\nA council limit holds until the Units sheet\'s reset');
  const resetIso = await evalJs(c, 'new Date(Date.now() + 40 * 60000).toISOString()');
  await evalJs(c, `window.__limitUntil = ${JSON.stringify(resetIso)};
    S.queue = []; ["q one", "q two"].forEach((q) => { setQuestion(q); $("btnQueue").click(); });
    window.__next = [${LIMITED}]; queueStart(); return 1;`);
  ok('it asked the engine for the units\' limits', await waitFor(c, 'window.__cap.usage > 0 && !!S.queueHold'));
  const h = await evalJs(c, 'S.queueHold');
  const want = Date.parse(resetIso) + 60000;
  ok('held until that reset plus a minute', h && h.known && Math.abs(h.until - want) < 3000, JSON.stringify(h));
  ok('the row waits, first, not failed', await evalJs(c, 'queueSorted()[0].status === "queued" && queueSorted()[0].q === "q one"'));
  ok('its note says why', /usage limit/.test(await evalJs(c, 'queueSorted()[0].err || ""')));
  ok('the second never started', await evalJs(c, 'window.__runs.length') === 1);
  ok('the banner says the council', /council is rate limited/.test(await evalJs(c, '$("queueHoldTxt").textContent')));
  ok('a hold is not a stop: no chime', await evalJs(c, '!ATTN.keys.has("queue:stopped")'));
  await shot(c, 'qh-1-council-hold');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  ok('phone: the hold banner fits', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'));
  ok('phone: Try now is tappable', (await evalJs(c, '$("queueHoldNow").getBoundingClientRect().height')) >= 28);
  await evalJs(c, '$("queueDrawer").scrollIntoView(); return 1;');
  await shot(c, 'qh-2-hold-phone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await evalJs(c, 'window.__limitUntil = null; $("queueHoldNow").click(); return 1;');
  ok('Try now runs it again, then the rest', await waitFor(c, 'window.__runs.length === 3 && !S.queueRunning'));
  ok('both rows done, in order', await evalJs(c, 'JSON.stringify(window.__runs)') === '["q one","q one","q two"]'
     && await evalJs(c, 'queueSorted().every((it) => it.status === "done")'));

  console.log('\nRun again on a council row');
  await evalJs(c, `[...document.querySelectorAll("#queueRows .q-row")][1].querySelector('.q-act[title^="Run this again"]').click(); return 1;`);
  ok('it runs from the front', await waitFor(c, 'window.__runs.length === 4 && !S.queueRunning'));
  ok('the same prompt', await evalJs(c, 'window.__runs[3]') === 'q two');

  console.log('\nGuessing has a limit');
  await evalJs(c, `S.queue = []; setQuestion("q guess"); $("btnQueue").click();
    window.__next = Array.from({ length: 20 }, () => (${LIMITED})); window.__strikes = 0; queueStart(); return 1;`);
  for (let i = 0; i < 14; i++) {
    if (!(await waitFor(c, '!!S.queueHold || !S.queueRunning', 5000))) break;
    if (!(await evalJs(c, 'S.queueRunning'))) break;
    const g = await evalJs(c, 'S.queueHold && S.queueHold.known');
    if (i === 0) ok('no reset anywhere: a 15-minute guess', g === false);
    await evalJs(c, '$("queueHoldNow").click(); return 1;');
    await sleep(250);
  }
  ok('it stops after 12 guesses in a row', await waitFor(c, '!S.queueRunning', 5000) && await evalJs(c, 'window.__runs.length') === 4 + 13,
     await evalJs(c, 'window.__runs.length'));
  ok('the row is failed, saying so', /still limited/.test(await evalJs(c, 'S.queue[0].err || ""')) && await evalJs(c, 'S.queue[0].status') === 'failed');
  ok('the stop is said in words', /still rate limited/.test(await evalJs(c, '$("refineError").textContent')));
  ok('and it rang, and marked the tab', await evalJs(c, 'ATTN.keys.has("queue:stopped") && window.__strikes > 0 && /Queue stopped/.test(document.title)'));
  await evalJs(c, 'document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return 1;');
  ok('the next touch clears the mark', await waitFor(c, '!ATTN.keys.has("queue:stopped") && !/Queue stopped/.test(document.title)', 3000));

  console.log('\nThe approval reminder, and mute');
  await evalJs(c, `window.__strikes = 0;
    const t = { id: "rem1", events: [], done: false };
    codeApprovalAlarm(t, { expires_at: Date.now() / 1000 + 62.5 }); window.__remT = t; return 1;`);
  ok('the card rings once', await waitFor(c, 'window.__strikes > 0', 3000));
  const first = await evalJs(c, 'window.__strikes');
  ok('and again with a minute left', await waitFor(c, `window.__strikes > ${first}`, 6000));
  await evalJs(c, 'codeApprovalQuiet(window.__remT); return 1;');
  ok('quiet clears it', await evalJs(c, '!ATTN.keys.size && !/Approve/.test(document.title)'));
  await evalJs(c, `S.muted = true; window.__strikes = 0;
    const t2 = { id: "rem2", events: [], done: false }; codeApprovalAlarm(t2, { expires_at: Date.now() / 1000 + 300 });
    window.__remT2 = t2; return 1;`);
  await sleep(1200);
  ok('muted: silent', await evalJs(c, 'window.__strikes') === 0);
  ok('muted: the tab is still marked', await evalJs(c, '/Approve/.test(document.title)'));
  await evalJs(c, 'codeApprovalQuiet(window.__remT2); S.muted = false; return 1;');
  await evalJs(c, `const t3 = { id: "rem3", events: [], done: false };
    codeApprovalAlarm(t3, { expires_at: Date.now() / 1000 - 5 }); return 1;`);
  await sleep(1000);
  ok('an already-expired card never rings', await evalJs(c, '!ATTN.keys.has("approval:rem3")'));

  console.log('\nThe engine goes away mid-queue');
  await evalJs(c, `S.queue = []; setQuestion("q lost"); $("btnQueue").click();
    const realOnline = online; window.__realOnline = realOnline; online = () => false;
    S.queueRunning = false; queueDrain(++_queueGen).then(() => { online = window.__realOnline; }); return 1;`);
  ok('lost engine: it stops and rings', await waitFor(c, 'ATTN.keys.has("queue:stopped")', 4000));
  await evalJs(c, 'attnClear("queue:stopped"); S.queue = []; queueChanged(); return 1;');

  console.log('\nNothing else');
  ok('no stubbed writes attempted', (await evalJs(c, 'window.__cap.posts')).length === 0, JSON.stringify(await evalJs(c, 'window.__cap.posts')));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
