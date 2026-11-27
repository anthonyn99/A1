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
// B5 (r2-05.md): REAL=1 is the realistic-volume mode: Tony's 35-ticker Main as the watchlist and a 1-minute
// pan to the chart's cap. Every sample also prints the committed heap (JSHeapTotalSize, closer to the
// browser's figure Tony read) beside the used heap, and the work-out counts the stream connections made.
// SOAK_MIN=60 runs the TR8 Trading / Charts / Market loop with a snapshot every 15 minutes.
// LEAK_MIN=60 TABS=cortex runs the N10 journal polling and card cleanup check.
// Run: CDP_PORT=93xx node tests/live/tradehub-leaks.live.js
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, bigJournal, PAGE_SETUP, WATCHLIST, CLOCK } = require('./quant-mock.js');
const SOAK_MIN = Number(process.env.SOAK_MIN) || 0;
const REAL = !!process.env.REAL || SOAK_MIN > 0;
// Tony's Main had 35 tickers (R0); the mock answers bars and quotes for any symbol.
const MAIN35 = [...new Set([...WATCHLIST, 'MU', 'SNDK', 'AMD', 'NVDA', 'TSLA', 'PLTR', 'AAPL', 'META', 'AMZN', 'MSFT', 'GOOGL', 'AVGO', 'TSM', 'SMCI', 'COIN', 'HOOD', 'SOFI', 'RKLB', 'IONQ', 'ARM', 'NFLX', 'CRWD', 'SHOP', 'UBER', 'INTC', 'MRVL', 'ANET', 'DELL', 'ORCL', 'LRCX', 'AMAT', 'KLAC', 'QCOM', 'ADBE', 'CRM'])].slice(0, 35);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const ALL = ['portfolio', 'market', 'charts', 'scanner', 'neo', 'trading', 'journal', 'catalysts', 'playbook', 'prompt', 'news', 'analysis'];
const TABS = process.env.TABS ? process.env.TABS.split(',') : ALL;
const LEAK_MIN = Number(process.env.LEAK_MIN) || 3, WARM_S = Number(process.env.WARM_S) || 45, CYCLES = Number(process.env.CYCLES) || 40;
const BOT = 'https://quant-bot.anthony-account-3.workers.dev';

function cortexMock(api, settings) {
  let today = 0;
  // Match the worker's 200-row window, with a new event replacing the oldest on every read.
  const events = Array.from({ length: 200 }, (_, i) => event(200 - i));
  function event(id) { return { id, ts: CLOCK - 60000, kind: 'shadow', sym: 'NVDA', side: 'long', qty: 4, price: 130, strategy: 'test', version: 1, why: 'Trade signal recorded in shadow.' }; }
  const values = {
    '/state': { market: 'open', mode: 'shadow', positions: [], lastCheck: CLOCK, shadowSessions: 1 },
    '/settings': { version: 0, history: [], settings },
    '/lifecycle': { strategies: [] }, '/lab/runs': { runs: [{ id: 'r1', session: 'premarket', started: CLOCK, outcome: 'ok' }] },
    '/briefs': { briefs: [] }, '/trades': { trades: [{ strategy: 'test', symbol: 'NVDA', opened: CLOCK, pnl: 12, r: 0.5 }] },
  };
  const mock = { ...api.mock, patterns: [...api.mock.patterns, BOT + '/*'], handle(req) {
    if (!req.url.startsWith(BOT + '/')) return api.mock.handle(req);
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = new URL(req.url), p = u.pathname;
    if (p === '/today') {
      events.unshift(event(200 + ++today)); events.pop();
      return { json: { ok: true, day: u.searchParams.get('day'), events }, headers: { etag: '"journal-' + today + '"' } };
    }
    if (p.startsWith('/brief/')) return { json: { ok: true, brief: null } };
    if (values[p]) return { json: { ok: true, ...values[p] } };
    return { status: 404, json: { error: 'Unexpected request ' + p } };
  } };
  return { mock, today: () => today };
}

// Count timer IDs without retaining callbacks or DOM. Tab exit can then be compared to the warmed baseline.
const TRACK_TIMERS = `(() => {
  const active = new Set();
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
  const ct = window.clearTimeout.bind(window), ci = window.clearInterval.bind(window);
  window.setTimeout = (fn, ms, ...args) => {
    if (typeof fn !== 'function') return st(fn, ms, ...args);
    const id = st((...a) => { active.delete(id); fn(...a); }, ms, ...args);
    active.add(id); return id;
  };
  window.setInterval = (...args) => { const id = si(...args); active.add(id); return id; };
  window.clearTimeout = (id) => { active.delete(id); ct(id); };
  window.clearInterval = (id) => { active.delete(id); ci(id); };
  window.__activeTimers = () => active.size;
})();`;

/** Object counts by constructor name from a heap snapshot (CDP HeapProfiler). */
async function census(c) {
  let buf = '';
  const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.method === 'HeapProfiler.addHeapSnapshotChunk') buf += m.params.chunk; };
  c.ws.addEventListener('message', onMsg);
  await c.send('HeapProfiler.collectGarbage');
  await c.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  c.ws.removeEventListener('message', onMsg);
  const snap = JSON.parse(buf), meta = snap.snapshot.meta, F = meta.node_fields, nf = F.length;
  const iType = F.indexOf('type'), iName = F.indexOf('name'), iSize = F.indexOf('self_size'), iDetached = F.indexOf('detachedness'), types = meta.node_types[0];
  const counts = new Map();
  for (let i = 0; i < snap.nodes.length; i += nf) {
    const t = types[snap.nodes[i + iType]];
    if (t !== 'object' && t !== 'native' && t !== 'closure') continue;
    let name = (t === 'closure' ? 'closure ' : '') + snap.strings[snap.nodes[i + iName]];
    if (t === 'native' && iDetached >= 0 && snap.nodes[i + iDetached] === 2 && !name.startsWith('Detached ')) name = 'Detached ' + name;
    const e = counts.get(name) || { n: 0, size: 0 };
    e.n++; e.size += snap.nodes[i + iSize]; counts.set(name, e);
  }
  return counts;
}

(async () => {
  const api = quantApi();
  const bot = TABS.includes('cortex') ? cortexMock(api, (await import('../../workers3/quant-bot/lib/state.js')).DEFAULTS) : null;
  const c = await connect({ mock: bot ? bot.mock : api.mock });
  try {
  const errs = [];
  await c.send('Network.enable'); await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Performance.enable'); await c.send('HeapProfiler.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  if (bot) await c.send('Page.addScriptToEvaluateOnNewDocument', { source: TRACK_TIMERS });
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
    return { heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), committedMB: +(m.JSHeapTotalSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, canvases: canv,
      ...(bot ? { timers: await js('return window.__activeTimers();') } : {}) };
  };
  await size(1504, 900);
  try {
    await boot({
      quant: true,
      ...(REAL ? { watchlist: MAIN35 } : {}),
      ...(SOAK_MIN > 0 ? { docs: { 'dashboards/tradeboard_journal': bigJournal(800) } } : {}),
    });
  } catch (error) {
    if (errs.length) console.error(errs.slice(0, 3).join('\n'));
    throw error;
  }
  if (REAL) console.log(`  (REAL: ${MAIN35.length} tickers on the watchlist)`);
  ok('the app is up with Quant on', await until(`document.querySelector('.tbq-on')`, 10000));
  await js(`window.__ws.auto(100); 1`);

  if (SOAK_MIN > 0) {
    const settle = async (id) => {
      await tab(id);
      if (!(await until("window._tbOps.app.page()==='" + id + "'", 8000))) throw new Error('Could not open ' + id);
    };
    const charts = "document.querySelector('[data-charts]')?.__charts?.active()";
    const tour = async (round, pause) => {
      await settle('trading');
      await until("document.querySelector('[data-trade-broker]')", 6000);
      await js("const e=document.querySelector('[data-trade-broker]'); e.value='" + (round % 2 ? 'alpaca' : 'webull') + "'; e.dispatchEvent(new Event('change',{bubbles:true})); 1");
      await pause();
      await settle('charts');
      await until(charts + '?.info().bars > 0', 8000);
      const sym = ['SPY', 'WMT', 'NVDA', 'AAPL'][round % 4];
      await js(charts + ".set({symbol:'" + sym + "',tf:'" + (round % 2 ? '5m' : '15m') + "'}); 1");
      await pause();
      await settle('market');
      await until("document.querySelector('[data-lay=market]')", 8000);
      await pause();
    };
    const detached = (snapshot) => [...snapshot].filter(([name]) => name.startsWith('Detached ')).reduce((total, [, e]) => total + e.n, 0);
    console.log('TR8: warming Trading, Charts and Market with 35 tickers');
    for (let i = 0; i < 4; i++) await tour(i, () => sleep(1200));
    await settle('trading');
    await sleep(1500);
    const first = await sample(), heapFirst = await census(c);
    const started = Date.now(), deadline = started + SOAK_MIN * 60_000;
    let nextSample = started + (deadline - started) / 4;
    console.log('TR8: baseline ' + JSON.stringify(first) + '; detached objects ' + detached(heapFirst));
    for (let round = 0; Date.now() < deadline; round++) {
      await tour(round, () => sleep(Math.max(0, Math.min(15000, deadline - Date.now()))));
      if (Date.now() >= nextSample && Date.now() < deadline) {
        nextSample += (deadline - started) / 4;
        await settle('trading');
        await sleep(1500);
        const mid = await sample();
        console.log('TR8: ' + ((Date.now() - started) / 60000).toFixed(1) + ' min ' + JSON.stringify(mid) + '; detached objects ' + detached(await census(c)));
      }
    }
    await settle('trading');
    await sleep(1500);
    const last = await sample(), heapLast = await census(c);
    const d0 = detached(heapFirst), d1 = detached(heapLast);
    console.log('TR8: ' + ((Date.now() - started) / 60000).toFixed(1) + ' min ' + JSON.stringify(last) + '; detached objects ' + d1);
    const growth = [...heapLast].map(([name, e]) => [name, e.size - (heapFirst.get(name)?.size || 0)])
      .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, bytes]) => [name, Math.round(bytes / 1024)]);
    console.log('TR8: largest increases by constructor (KB) ' + JSON.stringify(growth));
    ok('[TR8] heap after GC grows under 10% across the session', last.heapMB < first.heapMB * 1.1, [first.heapMB, last.heapMB]);
    ok('[TR8] DOM nodes and listeners stay within 10%', last.nodes <= first.nodes * 1.1 && last.listeners <= first.listeners * 1.1);
    ok('[TR8] detached objects stay within the warm baseline allowance', d1 <= d0 * 1.1 + 50, [d0, d1]);
    ok('[TR8] no uncaught errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    await js("window.__ws.auto(0); 1");
    console.log(pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0;
    return;
  }

  if (bot) {
    const app = (id) => `window._tbOps.app.page() === '${id}'`;
    const click = (s) => js(`document.querySelector(${JSON.stringify(s)}).click(); 1`);
    const must = async (expr) => { if (!await until(expr, 8000)) throw new Error('Missing: ' + expr); };
    const detached = (snap) => [...snap].filter(([n]) => n.startsWith('Detached ')).reduce((n, [, e]) => n + e.n, 0);
    const open = async () => {
      await tab('cortex');
      await must(`document.querySelector('[data-ncx-event]')`);
      for (const id of ['lab', 'scorecard']) {
        await js(`const s = document.querySelector('[data-cortex-tab] [data-lay-add]'); if (Array.from(s.options).some(o => o.value === '${id}')) { s.value = '${id}'; s.dispatchEvent(new Event('change', { bubbles: true })); } 1`);
        await must(`document.querySelector('[data-ncx-card=${id}]')`);
      }
      await must(`document.querySelector('[data-ncx-runs]') && document.querySelector('[data-ncx-vs]')`);
    };
    const exercise = async () => {
      for (const id of ['lab', 'scorecard']) {
        const s = `[data-cortex-tab] [data-card=${id}] [data-act=collapse]`;
        await click(s); await sleep(400); await click(s);
      }
      await tab('prompt');
      await must(`document.querySelector('[data-ctl-sub=cortex]')`);
      await click('[data-ctl-sub=cortex]');
      await must(`document.querySelector('[data-cortex-control] [data-ncx-group=money]')`);
    };
    const park = async () => { await tab('portfolio'); await must(app('portfolio')); await sleep(2500); };
    await open(); await exercise(); await open(); await park();
    const parked0 = await sample(), detached0 = detached(await census(c));
    await open(); await sleep(WARM_S * 1000);
    const start = await sample(), startReads = bot.today();
    const deadline = Date.now() + LEAK_MIN * 60_000;
    console.log('N10 Cortex baseline ' + JSON.stringify({ open: start, parked: parked0, detached: detached0, reads: startReads }));
    let cycles = 0, polls = 0;
    while (Date.now() < deadline) {
      const before = bot.today();
      await sleep(Math.min(60_000, deadline - Date.now()));
      polls += bot.today() - before;
      await exercise(); await open();
      if (++cycles % 15 === 0) console.log(`N10 Cortex cycle ${cycles}, journal reads ${bot.today()}`);
    }
    const end = await sample();
    const reads = bot.today() - startReads;
    await park();
    const parked1 = await sample(), detached1 = detached(await census(c));
    const subscribers = await js(`const m = await import('/A1/TradeHub/data/cortex.js'); return m.getCortexStore().subscriberCount();`);
    const afterExit = bot.today(); await sleep(31_000);
    console.log('N10 Cortex final ' + JSON.stringify({ open: end, parked: parked1, detached: detached1, reads, polls, cycles, subscribers }));
    ok('Cortex heap after GC stays within 10%', end.heapMB <= start.heapMB * 1.1);
    ok('Cortex journal keeps polling through the run', polls >= Math.max(1, Math.floor(LEAK_MIN)));
    ok('No extra detached DOM after leaving Cortex', detached1 <= detached0, `${detached0} → ${detached1}`);
    ok('Listeners and timers return to baseline', parked1.listeners <= parked0.listeners && parked1.timers <= parked0.timers);
    ok('Cortex unsubscribes and stops polling after leaving', subscribers === 0 && bot.today() === afterExit);
  }

  console.log(`\n1. Each tab alone (${WARM_S} s warm-up, then ${LEAK_MIN} min of ticks)`);
  const table = [];
  for (const id of TABS) {
    if (id === 'cortex') continue;
    await tab(id); await sleep(WARM_S * 1000);
    const a = await sample();
    await sleep(LEAK_MIN * 60_000);
    const z = await sample();
    const g = (z.heapMB - a.heapMB) / a.heapMB;
    table.push({ id, a, z });
    console.log(`    ${id.padEnd(10)} heap ${a.heapMB} → ${z.heapMB} MB (${(g * 100).toFixed(1)}%, committed ${a.committedMB} → ${z.committedMB}), nodes ${a.nodes} → ${z.nodes}, listeners ${a.listeners} → ${z.listeners}, canvases ${a.canvases} → ${z.canvases}`);
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
    const ws0 = await js(`return window.__ws.state.sockets.length;`);
    for (let k = 6; k < 6 + CYCLES; k++) await round(k);
    // Back to where the warm-up ended (the same ticker, interval, type and range), so only what is held differs.
    await round(5);
    await sleep(1500);
    const z = await sample(), after = await census(c);
    const wsMade = (await js(`return window.__ws.state.sockets.length;`)) - ws0;
    console.log(`    stream connections opened during the work-out: ${wsMade}`);
    ok('...a ticker switch never closes and reopens a stream (at most 3 connections over the rounds)', wsMade <= 3, wsMade);
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
  if (REAL && TABS.includes('charts')) {
    console.log('\n3. A 1-minute pan to the cap (REAL)');
    await js(`var ch=document.querySelector('[data-charts]').__charts.active(); ch.set({ tf: '1m' }); 1`); await sleep(2500);
    const barCount = () => js(`return document.querySelector('[data-charts]').__charts.active().info().bars;`);
    const initial = await barCount();
    for (let i = 0; i < 25; i++) {
      await js(`var root=document.querySelector('[data-charts]'), chart=root.__charts.active(), ts=chart.chart().timeScale(), r=ts.getVisibleLogicalRange();
        const dx=-(Math.max(0,r.from)+5)*ts.width()/Math.max(1,r.to-r.from);
        root.querySelector('[data-ch-box]').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaX:dx})); 1`);
      await sleep(1800);
    }
    const held = await barCount();
    const s1 = await sample();
    console.log(`    1-minute bars held after 25 pans back: ${held}; heap ${s1.heapMB} MB, committed ${s1.committedMB} MB`);
    ok('the pan actually loads older one-minute bars', held > initial, [initial, held]);
    ok('a 1-minute chart never holds more than ~8,000 bars (B5 cap, plus one older step)', held <= 8000 + 3600, held);
  }
  await js(`window.__ws.auto(0); 1`);
  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
  } finally {
    try { await c.send('Page.navigate', { url: 'about:blank' }); } finally { c.ws.close(); }
  }
})().catch((e) => { console.error(e); process.exit(1); });
