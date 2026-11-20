// TradeHub memory, every tab (Refinements Batch 2, A1-Priv docs/TradeHub/quant/r2-00.md
// and r2-05.md). Tony saw the Market tab pass 600 MB and Charts 750 MB (2026-11-20).
//
//   1. Each tab alone: open it, warm up with fake live ticks (10 a second on every
//      streamed symbol), force a GC, then LEAK_MIN more minutes of ticks, force a GC:
//      heap, DOM nodes, listeners, canvases. A tab passes when its heap after GC
//      grows less than 10% (quant §1 rule 6, Phase 15's bar) and its nodes and
//      listeners stay within 10%.
//   2. The Charts work-out: CYCLES rounds of ticker, interval, chart type, range and
//      indicator changes through the toolbar, as Tony works. Heap snapshots before
//      and after count objects by constructor, so the retainers are named
//      ("Detached HTMLDivElement", "LineSeries", ...): the top growers are printed.
//
// LEAK_MIN (default 3), WARM_S (default 45), CYCLES (default 40), TABS=market,charts (default all).
// Run: CDP_PORT=93xx node tests/live/tradehub-leaks.live.js
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const ALL = ['portfolio', 'market', 'charts', 'scanner', 'neo', 'paper', 'journal', 'catalysts', 'playbook', 'prompt', 'news', 'analysis'];
const TABS = process.env.TABS ? process.env.TABS.split(',') : ALL;
const LEAK_MIN = Number(process.env.LEAK_MIN) || 3, WARM_S = Number(process.env.WARM_S) || 45, CYCLES = Number(process.env.CYCLES) || 40;

/** Object counts by constructor name from a heap snapshot (CDP HeapProfiler). */
async function census(c) {
  let buf = '';
  const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.method === 'HeapProfiler.addHeapSnapshotChunk') buf += m.params.chunk; };
  c.ws.addEventListener('message', onMsg);
  await c.send('HeapProfiler.collectGarbage');
  await c.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  c.ws.removeEventListener('message', onMsg);
  const snap = JSON.parse(buf), meta = snap.snapshot.meta, F = meta.node_fields, nf = F.length;
  const iType = F.indexOf('type'), iName = F.indexOf('name'), iSize = F.indexOf('self_size'), types = meta.node_types[0];
  const counts = new Map();
  for (let i = 0; i < snap.nodes.length; i += nf) {
    const t = types[snap.nodes[i + iType]];
    if (t !== 'object' && t !== 'native' && t !== 'closure') continue;
    const name = (t === 'closure' ? 'closure ' : '') + snap.strings[snap.nodes[i + iName]];
    const e = counts.get(name) || { n: 0, size: 0 };
    e.n++; e.size += snap.nodes[i + iSize]; counts.set(name, e);
  }
  return counts;
}

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Performance.enable'); await c.send('HeapProfiler.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Page.javascriptDialogOpening') c.send('Page.handleJavaScriptDialog', { accept: true });
  });
  const { js, until, size, boot, tab } = driver(c);
  const sample = async () => {
    await c.send('HeapProfiler.collectGarbage'); await sleep(400); await c.send('HeapProfiler.collectGarbage');
    const m = Object.fromEntries((await c.send('Performance.getMetrics')).result.metrics.map((x) => [x.name, x.value]));
    const canv = await js(`return document.querySelectorAll('canvas').length;`);
    return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, canvases: canv };
  };
  await size(1504, 900);
  await boot({ quant: true });
  ok('the app is up with Quant on', await until(`document.querySelector('.tbq-on')`, 10000));
  await js(`window.__ws.auto(100); 1`);

  console.log(`\n1. Each tab alone (${WARM_S} s warm-up, then ${LEAK_MIN} min of ticks)`);
  const table = [];
  for (const id of TABS) {
    await tab(id); await sleep(WARM_S * 1000);
    const a = await sample();
    await sleep(LEAK_MIN * 60_000);
    const z = await sample();
    const g = (z.heapMB - a.heapMB) / a.heapMB;
    table.push({ id, a, z });
    console.log(`    ${id.padEnd(10)} heap ${a.heapMB} → ${z.heapMB} MB (${(g * 100).toFixed(1)}%), nodes ${a.nodes} → ${z.nodes}, listeners ${a.listeners} → ${z.listeners}, canvases ${a.canvases} → ${z.canvases}`);
    ok(`${id}: heap after GC grows under 10% over ${LEAK_MIN} min`, g < 0.1, `${a.heapMB} → ${z.heapMB}`);
    ok(`${id}: DOM nodes within 10%`, z.nodes <= a.nodes * 1.1, `${a.nodes} → ${z.nodes}`);
    ok(`${id}: listeners within 10%`, z.listeners <= a.listeners * 1.1, `${a.listeners} → ${z.listeners}`);
  }

  if (TABS.includes('charts')) {
    console.log(`\n2. The Charts work-out (${CYCLES} rounds)`);
    await tab('charts');
    await until(`document.querySelector('[data-charts]') && document.querySelector('[data-charts]').__charts.active().info().bars > 0`, 20000);
    const step = async (k) => js(`
      var q=function(s){return document.querySelector(s);}, k=${k};
      var rows=[].slice.call(document.querySelectorAll('[data-ch-rail] > *')); if(rows.length) rows[k % rows.length].click();
      var tf=q('[data-ch-tf]'); if(tf){ tf.value=['5m','15m','1h','4h','1d','5m'][k%6]; tf.dispatchEvent(new Event('change',{bubbles:true})); }
      var ty=q('[data-ch-type]'); if(ty){ ty.value=ty.options[k % ty.options.length].value; ty.dispatchEvent(new Event('change',{bubbles:true})); }
      var r=document.querySelectorAll('[data-ch-range]'); if(r.length) r[k % r.length].click();
      q('[data-ch-ind]').click();
      var boxes=[].slice.call(document.querySelectorAll('[data-ch-kind]')); if(boxes.length){ boxes[k % boxes.length].click(); } 1`);
    // Each round puts the indicator back as it was (the menu rebuilds its rows on a tick), so the chart
    // ends every round showing what it started with: whatever is left over is held, not shown.
    const undo = async (k) => js(`var boxes=[].slice.call(document.querySelectorAll('[data-ch-kind]')); if(boxes.length){ boxes[${k} % boxes.length].click(); }
      document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); 1`);
    const round = async (k) => { await step(k); await sleep(500); await undo(k); await sleep(400); };
    for (let k = 0; k < 6; k++) await round(k);   // warm: every kind of object made once
    const a = await sample(), before = await census(c);
    for (let k = 6; k < 6 + CYCLES; k++) await round(k);
    // Back to where the warm-up ended (the same ticker, interval, type and range), so only what is held differs.
    await round(5);
    await sleep(1500);
    const z = await sample(), after = await census(c);
    console.log(`    heap ${a.heapMB} → ${z.heapMB} MB, nodes ${a.nodes} → ${z.nodes}, listeners ${a.listeners} → ${z.listeners}, canvases ${a.canvases} → ${z.canvases}`);
    const grow = [...after].map(([name, e]) => ({ name, dn: e.n - ((before.get(name) || {}).n || 0), dkb: Math.round((e.size - ((before.get(name) || {}).size || 0)) / 1024) }))
      .filter((x) => x.dn > 0).sort((x, y) => y.dkb - x.dkb || y.dn - x.dn).slice(0, 25);
    console.log('    top growers (count, KB):');
    for (const x of grow) console.log(`      ${String(x.dn).padStart(7)} ${String(x.dkb).padStart(7)}  ${x.name.slice(0, 90)}`);
    const detached = [...after].filter(([n]) => /^Detached /.test(n)).reduce((s, [, e]) => s + e.n, 0);
    const detached0 = [...before].filter(([n]) => /^Detached /.test(n)).reduce((s, [, e]) => s + e.n, 0);
    console.log(`    detached DOM objects ${detached0} → ${detached}`);
    ok('the Charts work-out: heap after GC grows under 10%', z.heapMB < a.heapMB * 1.1, `${a.heapMB} → ${z.heapMB}`);
    ok('...canvases do not pile up', z.canvases <= a.canvases + 2, `${a.canvases} → ${z.canvases}`);
    ok('...listeners within 10%', z.listeners <= a.listeners * 1.1, `${a.listeners} → ${z.listeners}`);
    ok('...detached DOM does not grow', detached <= detached0 * 1.1 + 50, `${detached0} → ${detached}`);
  }
  await js(`window.__ws.auto(0); 1`);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
