// LIVE test -- a prompt TradeHub sends while a council runs becomes a row in
// MAGI's queue (2026-11-09), not an invisible "1 prompt queued" line. No
// deliberation runs: runOne is replaced. Nothing reaches an account.
//   · the row shows in the queue drawer, says "from TradeHub", carries the
//     units it was sent with, and can be edited (text and units) and removed
//   · the queue starts by itself and waits out the running council
//   · two sent back to back are two rows, in order
// Run: node tests/live/magi-handoff-queue.live.js
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');
const URL = require('./cdp.js').PAGES_URL;

const STUB = `if (window.top === window) (() => {
  const real = window.fetch;
  const json = (d, st = 200) => Promise.resolve(new Response(JSON.stringify(d),
    { status: st, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = async (u, o) => {
    const s = String(u && u.url ? u.url : u);
    const m = ((o && o.method) || (u && u.method) || 'GET').toUpperCase();
    if (s.indexOf('/auth/journal/status') >= 0) return json({ ok: true, hasLock: false });
    if (s.indexOf('firebase') >= 0 || s.indexOf('googleapis') >= 0 || s.indexOf('gstatic') >= 0)
      return Promise.reject(new TypeError('blocked'));
    if (m !== 'GET') return json({ ok: false, message: 'stubbed' });
    return real(u, o);
  };
})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 300) + ']' : '')); }
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await evalJs(c, expr)) return true; } catch {} await sleep(150); }
  return false;
};
const shot = async (c, name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64')); };
// TradeHub's link (tbMagiLink), built here.
const link = (q, units) => {
  const json = JSON.stringify({ v: 1, src: 'tradehub', q, units, run: 1, t: Date.now() + Math.random() });
  return '#tb=' + Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable');
  const errs = [];
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: URL }); await sleep(2500);
  // Storage is NOT cleared: it holds the engine's address, and the cloud lookup
  // that would find it again is blocked by the stub.
  await evalJs(c, 'sessionStorage.clear(); localStorage.setItem(lsKey("mode"), "deliberation"); return 1;');
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 25000));
  await evalJs(c, '$("navNew").click(); return 1;');
  await waitFor(c, 'S.providers.length > 1');
  const ids = await evalJs(c, 'S.providers.map(p => p.id)');

  // A council "running" by hand: the queue must wait for it. runOne records.
  await evalJs(c, `window.__runs = [];
    runOne = async ({ question, units }) => { window.__runs.push({ question, units }); if (onRunStart) onRunStart("run" + window.__runs.length);
      await new Promise((r) => setTimeout(r, 50)); return { runId: "run" + window.__runs.length, total: units.length, responded: units.length, ok: true }; };
    QUEUES.council.items = []; queueChanged(QUEUES.council); S.running = true; setView("council"); return 1;`);

  console.log('\nSent from TradeHub while a council runs');
  await evalJs(c, `location.hash = ${JSON.stringify(link('What moved the market today?', [ids[0], 'no-such-unit']))}; return 1;`);
  await waitFor(c, 'QUEUES.council.items.length === 1', 5000);
  await evalJs(c, `location.hash = ${JSON.stringify(link('Next week catalysts', [ids[1]]))}; return 1;`);
  ok('two rows in the queue, in the order sent', await waitFor(c, 'QUEUES.council.items.length === 2', 5000) && await evalJs(c, 'queueSorted(QUEUES.council).map(r => r.q).join("|")') === 'What moved the market today?|Next week catalysts',
    await evalJs(c, 'JSON.stringify(QUEUES.council.items.map(r => r.q))'));
  ok('the queue drawer shows them', await evalJs(c, '!$("queueDrawer").hidden && $("queueRows").querySelectorAll(".q-row").length === 2'));
  ok('each row says "from TradeHub"', await evalJs(c, '[...$("queueRows").querySelectorAll(".q-src")].map(e => e.textContent).join("|")') === 'from TradeHub|from TradeHub');
  ok('each keeps its units (minus one this engine lacks)', await evalJs(c, `queueSorted(QUEUES.council)[0].units.join() === ${JSON.stringify(ids[0])} && queueSorted(QUEUES.council)[1].units.join() === ${JSON.stringify(ids[1])}`));
  ok('the message says where to edit it', /Queued from TradeHub/.test(await evalJs(c, '$("refineError").textContent')));
  ok('nothing ran over the running council', await evalJs(c, 'window.__runs.length') === 0);
  ok('the queue is running (waiting for the council)', await evalJs(c, 'QUEUES.council.running === true'));
  await shot(c, 'mhq-1-queued');

  console.log('\nEdit, re-target, remove');
  await evalJs(c, 'queueEdit(queueSorted(QUEUES.council)[1].id); return 1;');
  ok('Edit opens the prompt with its unit chips', await waitFor(c, '!!document.querySelector(".qedit")', 3000));
  await shot(c, 'mhq-2-edit');
  await evalJs(c, 'var s=document.querySelector(".sheet"); s && s.remove(); return 1;');
  await evalJs(c, `var it=queueSorted(QUEUES.council)[1]; it.units=[${JSON.stringify(ids[0])}, ${JSON.stringify(ids[1])}]; it.q="Next week catalysts (edited)"; queueChanged(QUEUES.council); return 1;`);
  ok('an edited row keeps its edits', await evalJs(c, `queueSorted(QUEUES.council)[1].q === "Next week catalysts (edited)" && queueSorted(QUEUES.council)[1].units.length === 2`));

  console.log('\nThe council ends');
  await evalJs(c, 'S.running = false; return 1;');
  ok('the queue convenes both, in order, with their units', await waitFor(c, 'window.__runs.length === 2', 15000) && await evalJs(c, `window.__runs[0].question === "What moved the market today?" && window.__runs[1].question === "Next week catalysts (edited)" && window.__runs[1].units.length === 2`),
    await evalJs(c, 'JSON.stringify(window.__runs)'));
  ok('the rows read done', await waitFor(c, 'queueSorted(QUEUES.council).every(r => r.status === "done")', 5000));

  console.log('\nPhone');
  await evalJs(c, 'S.running = true; return 1;');
  await evalJs(c, `location.hash = ${JSON.stringify(link('Phone check', [ids[0]]))}; return 1;`);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  await evalJs(c, '$("queueDrawer").scrollIntoView(); return 1;');
  ok('phone: the drawer fits', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'));
  await shot(c, 'mhq-3-phone');
  await evalJs(c, 'queueStop(QUEUES.council); S.running = false; QUEUES.council.items = []; queueChanged(QUEUES.council); return 1;');

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
