// TradeHub Quant's soak (quant Phase 15, step 8): hours of live ticks in the
// real page with Quant on, an 800-trade Journal, a tab change every 3 s and
// fake trades 10 times a second on every streamed symbol. Every SAMPLE_MIN
// minutes it forces a garbage collection and records the JS heap, DOM nodes
// and listeners. Passes when the heap after GC at the end is within 10% of
// the first sample taken after warm-up, DOM nodes and listeners stay flat,
// no main-thread task runs over 50 ms after warm-up (switches excluded: the
// perf test owns those) and frames hold 55 a second.
//
// SOAK_MIN (default 120) sets the length, SAMPLE_MIN (default 10) the sampling.
// Run: CDP_PORT=93xx node tests/live/tradehub-soak.live.js
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, bigJournal, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const TABS = ['portfolio', 'market', 'journal', 'catalysts', 'playbook', 'prompt', 'news', 'analysis'];
const MIN = Number(process.env.SOAK_MIN) || 120;
const SAMPLE = Number(process.env.SAMPLE_MIN) || 10;

const PROBE = `(() => {
  const P = window.__perf = { long: [], frames: 0, sum: 0, slow: 0, on: false, switching: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (P.on) P.long.push({ ms: Math.round(e.duration), sw: performance.now() - P.switching < 600 }); }).observe({ entryTypes: ['longtask'] }); } catch (e) {}
  let last = 0;
  const frame = (t) => { if (P.on && last) { const d = t - last; P.frames++; P.sum += d; if (d > 34) P.slow++; } last = t; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  window.__go = (id) => { const b = [...document.querySelectorAll('.tb-navtab[data-navid="' + id + '"]')].find((x) => x.offsetParent); if (b) { P.switching = performance.now(); b.click(); } };
})();`;

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Performance.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot } = driver(c);
  await size(1280, 900);
  await boot({ quant: true, docs: { 'dashboards/tradeboard_journal': bigJournal(800) } });
  ok('the app is up with Quant on', await until(`document.querySelector('.tbq-on')`, 10000));
  for (const id of TABS) { await js(`window.__go('${id}'); 1`); await sleep(900); }

  // Always sampled on the same tab: DOM nodes differ by tab (2,300 to 4,200), so samples taken
  // on whichever tab was open read as growth that was not there (first 2-hour run, 2026-11-17).
  const sample = async () => {
    await js(`window.__go('portfolio'); 1`); await sleep(1500);
    await c.send('HeapProfiler.collectGarbage'); await sleep(500); await c.send('HeapProfiler.collectGarbage');
    const m = Object.fromEntries((await c.send('Performance.getMetrics')).result.metrics.map((x) => [x.name, x.value]));
    return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, docs: m.Documents };
  };
  await js(`window.__ws.auto(100); 1`);
  // Warm-up: 5 minutes of ticks and switches before the baseline.
  const t0 = Date.now(); let i = 0;
  const run = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { await js(`window.__go('${TABS[i++ % TABS.length]}'); 1`); await sleep(3000); } };
  await run(5 * 60_000);
  const samples = [await sample()];
  console.log(`    after warm-up: ${JSON.stringify(samples[0])}`);
  await js(`window.__perf.on = true; 1`);
  for (let k = SAMPLE; k <= MIN; k += SAMPLE) {
    await run(SAMPLE * 60_000);
    const s = await sample(); samples.push(s);
    console.log(`    ${k} min: ${JSON.stringify(s)}  (${Math.round((Date.now() - t0) / 60000)} min wall)`);
  }
  const r = JSON.parse(await js(`window.__perf.on = false; window.__ws.auto(0); var P = window.__perf;
    return JSON.stringify({ long: P.long.filter(function(x){return !x.sw;}).map(function(x){return x.ms;}), swLong: P.long.filter(function(x){return x.sw;}).map(function(x){return x.ms;}), fps: P.frames ? 1000 * P.frames / P.sum : 0, slow: P.slow, frames: P.frames });`));
  const a = samples[0], z = samples[samples.length - 1];
  const maxHeap = Math.max(...samples.map((s) => s.heapMB));
  console.log(`    heap ${a.heapMB} → ${z.heapMB} MB (peak after GC ${maxHeap}), nodes ${a.nodes} → ${z.nodes}, listeners ${a.listeners} → ${z.listeners}`);
  console.log(`    ${r.frames} frames, ${r.fps.toFixed(1)} fps, ${r.slow} over 34 ms; long tasks outside switches: ${r.long.length ? r.long.join(', ') : 'none'}; during switches: ${r.swLong.length} (worst ${Math.max(0, ...r.swLong)} ms)`);
  ok(`the heap after GC ends within 10% of where it started (${MIN} min)`, z.heapMB <= a.heapMB * 1.1, `${a.heapMB} → ${z.heapMB}`);
  ok('DOM nodes stay flat (within 10%)', z.nodes <= a.nodes * 1.1, `${a.nodes} → ${z.nodes}`);
  ok('listeners stay flat (within 10%)', z.listeners <= a.listeners * 1.1, `${a.listeners} → ${z.listeners}`);
  ok('no main-thread task over 50 ms outside tab switches', r.long.every((x) => x <= 50), r.long.join(', '));
  ok('at least 55 frames a second', r.fps >= 55, r.fps.toFixed(1));
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
