// LIVE test -- drag to reorder, with REAL pointer input (CDP Input events),
// in the real page against the real engine (not run by run-all.js). Sends no
// question. Run: node tests/live/magi-drag-sort.live.js
//
//   1. Agent order, mouse: lift a row by its body, pass two rows (they slide
//      aside while it moves), drop -> it sits there, numbers 1..N; frames
//      stay smooth during the drag; dragged back.
//   2. Agent order, touch at 390px: a finger on the GRIP drags; a finger on
//      the row's text does not (the list scrolls instead).
//   3. Queue (Deliberation and Code Mode lanes): a waiting row dragged to the
//      top lands there, only its own order number changes; a finished row
//      will not lift.
//   4. Escape mid-drag puts it back; the first click after a drop works.
// The test browser's own profile; its queue rows are put back after.
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const fs = require('fs');

const URL = require('./cdp.js').PAGES_URL;
const STUB = `(()=>{if(window.top!==window)return;const real=window.fetch;window.fetch=(u,o)=>{const s=String(u&&u.url?u.url:u);
 if(s.indexOf('/auth/journal/status')>=0)return Promise.resolve(new Response(JSON.stringify({ok:true,hasLock:false}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(s.indexOf('firebase')>=0||s.indexOf('googleapis')>=0||s.indexOf('gstatic')>=0)return Promise.reject(new TypeError('x'));
 return real(u,o);};})();`;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 200) + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  [' + String(d).slice(0, 300) + ']' : '')); }
};
const waitFor = async (c, expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await evalJs(c, expr)) return true; } catch {} await sleep(200); }
  return false;
};
const shot = async (c, name) => {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64'));
};
const rect = async (c, js) => JSON.parse(await evalJs(c, `return JSON.stringify((() => { const b = (${js}).getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.top + b.height / 2, l: b.left, t: b.top, w: b.width, h: b.height}; })())`));

async function mouseDrag(c, x, y, dy, { steps = 14, mid = null, cancel = false } = {}) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y + (dy * i) / steps, button: 'left', buttons: 1 });
    await sleep(16);
    if (mid && i === Math.round(steps * 0.7)) await mid();
  }
  if (cancel) await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: y + dy, button: 'left', clickCount: 1 });
  await sleep(320);
}

async function touchDrag(c, x, y, dy, steps = 14) {
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / steps }] });
    await sleep(16);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(320);
}

const orderNames = (c) => evalJs(c, 'return JSON.stringify([...document.querySelectorAll(".code-order-row")].map(r => r.querySelector(".code-order-name").textContent));').then(JSON.parse);

(async () => {
  const c = await connect();
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: URL });
  ok('engine online', await waitFor(c, 'online()', 30000));
  await evalJs(c, 'setMode("code"); return 1;');
  ok('Code Mode agents loaded', await waitFor(c, '!!(CODE.state && CODE.agents) && codeMembers().length >= 4', 30000));
  const savedOrder = await evalJs(c, 'return JSON.stringify(CODE.order || []);');

  try {
    // ── 1. agent order, mouse ───────────────────────────────────────────
    console.log('\n1. Agent order, mouse');
    await evalJs(c, 'openCodeOrder(); return 1;');
    await waitFor(c, '!!document.querySelector(".code-order-row")');
    const before = await orderNames(c);
    const r0 = await rect(c, 'document.querySelectorAll(".code-order-row")[0].querySelector(".code-order-name")');
    const r1 = await rect(c, 'document.querySelectorAll(".code-order-row")[1]');
    const pitch = r1.t - (r0.t - (r0.h > 0 ? 0 : 0)) ;
    const rowH = (await rect(c, 'document.querySelectorAll(".code-order-row")[0]')).h;
    const step = (await rect(c, 'document.querySelectorAll(".code-order-row")[1]')).t - (await rect(c, 'document.querySelectorAll(".code-order-row")[0]')).t;
    // A frame clock in the page: the worst gap between frames during the drag.
    await evalJs(c, 'window.__gaps = []; let last = performance.now(); (function f(t){ window.__gaps.push(t - last); last = t; if (window.__gaps.length < 600) requestAnimationFrame(f); })(performance.now()); return 1;');
    let mid = null;
    await mouseDrag(c, r0.x, r0.y, step * 2 + 4, {
      mid: async () => {
        mid = JSON.parse(await evalJs(c, `return JSON.stringify({
          lifted: !!document.querySelector(".code-order-row.dsort-drag"),
          moved: [...document.querySelectorAll(".code-order-row")].slice(1, 3).every(r => /translate3d\\(0px, -/.test(r.style.transform)),
          grabbing: document.documentElement.classList.contains("dsort-grabbing") })`));
        await shot(c, 'drag-agent-mid');
      },
    });
    ok('while dragging, the row is lifted', mid && mid.lifted, JSON.stringify(mid));
    ok('...and the two rows it passed slid up out of its way', mid && mid.moved);
    ok('...with the grabbing cursor', mid && mid.grabbing);
    const after = await orderNames(c);
    ok('dropped two places down', after[2] === before[0] && after[0] === before[1] && after[1] === before[2],
       JSON.stringify(after.slice(0, 3)));
    const nums = await evalJs(c, 'return JSON.stringify([...document.querySelectorAll(".code-order-num")].map(n => n.textContent));').then(JSON.parse);
    ok('numbers are 1..N again', nums.every((n, i) => n === String(i + 1)));
    ok('saved as the chain order', (await evalJs(c, 'codeMembers()[2].label')) + '' !== '' &&
       JSON.parse(await evalJs(c, 'return JSON.stringify(CODE.order);'))[2] === JSON.parse(await evalJs(c, 'return JSON.stringify(codeMembers().map(m => m.id));'))[2]);
    ok('nothing left lifted or shifted', await evalJs(c, '![...document.querySelectorAll(".code-order-row")].some(r => r.style.transform || r.classList.contains("dsort-drag")) && !document.documentElement.classList.contains("dsort-grabbing")'));
    const gaps = JSON.parse(await evalJs(c, 'return JSON.stringify(window.__gaps.slice(2));'));
    const worst = Math.max(...gaps);
    ok('smooth: no frame gap over 50 ms during the drag', worst < 50, `${worst.toFixed(1)} ms worst of ${gaps.length}`);
    // Back where it was.
    const back = await rect(c, 'document.querySelectorAll(".code-order-row")[2].querySelector(".code-order-name")');
    await mouseDrag(c, back.x, back.y, -(step * 2 + 4));
    ok('dragged back up: the original order', JSON.stringify(await orderNames(c)) === JSON.stringify(before));

    // ── 4. Escape cancels; the next click works ─────────────────────────
    console.log('\n4. Escape and the click after');
    const rx = await rect(c, 'document.querySelectorAll(".code-order-row")[1].querySelector(".code-order-name")');
    await mouseDrag(c, rx.x, rx.y, step * 2, { cancel: true });
    ok('Escape mid-drag: nothing moved', JSON.stringify(await orderNames(c)) === JSON.stringify(before));
    const done = await rect(c, '[...document.querySelectorAll(".sheet .btn")].find(b => b.textContent === "Done")');
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: done.x, y: done.y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: done.x, y: done.y, button: 'left', clickCount: 1 });
    ok('the first click after a drag still works (Done closes)', await waitFor(c, '!document.querySelector(".code-order")', 3000));

    // ── 2. agent order, touch at 390px ──────────────────────────────────
    console.log('\n2. Agent order, touch, 390px');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await evalJs(c, 'openCodeOrder(); return 1;');
    await waitFor(c, '!!document.querySelector(".code-order-row")');
    const tStep = (await rect(c, 'document.querySelectorAll(".code-order-row")[1]')).t - (await rect(c, 'document.querySelectorAll(".code-order-row")[0]')).t;
    const g0 = await rect(c, 'document.querySelectorAll(".code-order-row")[0].querySelector(".dsort-grip")');
    ok('the grip is a real touch target (≥ 28 x 36)', g0.w >= 27 && g0.h >= 35, `${g0.w}x${g0.h}`);
    const txt = await rect(c, 'document.querySelectorAll(".code-order-row")[0].querySelector(".code-order-name")');
    await touchDrag(c, txt.x, txt.y, tStep * 2);
    ok('a finger on the row text does not drag (it scrolls)', JSON.stringify(await orderNames(c)) === JSON.stringify(before));
    await touchDrag(c, g0.x, g0.y, tStep + 4);
    const tAfter = await orderNames(c);
    ok('a finger on the grip drags it one place down', tAfter[1] === before[0] && tAfter[0] === before[1], JSON.stringify(tAfter.slice(0, 2)));
    await shot(c, 'drag-agent-phone');
    ok('no horizontal scroll at 390', await evalJs(c, 'document.documentElement.scrollWidth <= innerWidth + 1'));
    const g1 = await rect(c, 'document.querySelectorAll(".code-order-row")[1].querySelector(".dsort-grip")');
    await touchDrag(c, g1.x, g1.y, -(tStep + 4));
    ok('and back', JSON.stringify(await orderNames(c)) === JSON.stringify(before));
    await evalJs(c, 'document.querySelector(".sheet") && document.querySelector(".sheet").remove(); return 1;');
    await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── 3. the queues ───────────────────────────────────────────────────
    for (const lane of ['council', 'code']) {
      console.log(`\n3. Queue: ${lane === 'code' ? 'Code Mode' : 'Deliberation'}`);
      await evalJs(c, `setMode(${JSON.stringify(lane === 'code' ? 'code' : 'deliberation')}); setView("council"); return 1;`);
      await evalJs(c, `const L = QUEUES[${JSON.stringify(lane)}]; window.__savedQ = JSON.stringify(L.items);
        L.items = [
          { id: "dq1", q: "first waiting", status: "queued", order: 1000, units: [], agents: [], pid: "", rw: "read" },
          { id: "dq2", q: "already finished", status: "done", order: 2000, units: [], agents: [], pid: "", rw: "read" },
          { id: "dq3", q: "second waiting", status: "queued", order: 3000, units: [], agents: [], pid: "", rw: "read" },
          { id: "dq4", q: "third waiting", status: "queued", order: 4000, units: [], agents: [], pid: "", rw: "read" },
        ];
        renderQueue(); return 1;`);
      ok('the queue is drawn with grips', await waitFor(c, 'document.querySelectorAll("#queueRows .q-row .dsort-grip").length === 4', 5000));
      const q = (s) => `document.querySelector('#queueRows .q-row[data-dkey="${s}"]')`;
      const qStep = (await rect(c, q('dq2'))).t - (await rect(c, q('dq1'))).t;
      const ids = () => evalJs(c, `return JSON.stringify(queueSorted(QUEUES[${JSON.stringify(lane)}]).map(x => x.id));`).then(JSON.parse);
      const g4 = await rect(c, q('dq4') + '.querySelector(".dsort-grip")');
      await mouseDrag(c, g4.x, g4.y, -(qStep * 3 + 6));
      const got = await ids();
      ok('the last waiting row dragged to the top lands first', got[0] === 'dq4', JSON.stringify(got));
      const orders = JSON.parse(await evalJs(c, `return JSON.stringify(Object.fromEntries(QUEUES[${JSON.stringify(lane)}].items.map(x => [x.id, x.order])));`));
      ok('only its own order number changed', orders.dq1 === 1000 && orders.dq2 === 2000 && orders.dq3 === 3000 && orders.dq4 < 1000,
         JSON.stringify(orders));
      const gDone = await rect(c, q('dq2'));
      await mouseDrag(c, gDone.l + 40, gDone.y, qStep * 2);
      ok('a finished row does not lift', (await ids()).indexOf('dq2') === got.indexOf('dq2'));
      await shot(c, `drag-queue-${lane}`);
      await evalJs(c, `QUEUES[${JSON.stringify(lane)}].items = JSON.parse(window.__savedQ); queueChanged(QUEUES[${JSON.stringify(lane)}]); renderQueue(); return 1;`);
    }
  } catch (e) {
    fail++;
    console.log('  FAIL  crashed: ' + (e.stack || e));
  } finally {
    try {
      await evalJs(c, `CODE.order = ${savedOrder}; lsWrite(CODE_ORDER_KEY, CODE.order); document.querySelectorAll(".sheet").forEach(s => s.remove()); return 1;`);
    } catch {}
    ok('no page errors', errs.length === 0, errs.join(' | '));
    try { c.close && c.close(); } catch {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
