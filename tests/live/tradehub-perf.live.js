// TradeHub's speed budgets, old tabs and new (quant-plan §1 rule 10;
// quant/phase-03.md), measured in the real page with TradeHub Quant on:
//
//   1. a tab switch puts the new tab on screen in under 150 ms, every tab
//   2. during a scripted minute (live ticks 10 times a second on every
//      streamed symbol, a tab change every 3 s) no main-thread task runs over
//      50 ms and frames stay at or above 55 a second
//   3. the same at 4x CPU throttle (a phone), with relaxed limits:
//      a switch under 450 ms, no task over 200 ms, 30 frames a second
//   4. a tab change is a quick settle, transform only: nothing fades, and a
//      click on the tab already open plays nothing at all
//   5. an 800-trade Journal opens in under 150 ms, draws more rows as it is
//      scrolled (all 800 by the end) and runs nothing while it sits still
//
// PERF_SECONDS shortens the scripted minute while working on the test.
// Run: node tests/live/tradehub-perf.live.js
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, bigJournal, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const TABS = ['portfolio', 'market', 'journal', 'catalysts', 'playbook', 'prompt', 'news', 'analysis'];
const SECONDS = Number(process.env.PERF_SECONDS) || 60;

// In the page: long tasks and frame times, recorded from the start.
const PROBE = `(() => {
  const P = window.__perf = { long: [], frames: [], on: false, mark: '' };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (P.on) P.long.push({ ms: Math.round(e.duration), at: Math.round(e.startTime), mark: P.mark }); }).observe({ entryTypes: ['longtask'] }); } catch (e) { P.unsupported = true; }
  let last = 0;
  const frame = (t) => { if (P.on && last) P.frames.push(t - last); last = t; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  // Click a tab and resolve with the ms until it is the one on screen (active, drawn, one frame later).
  window.__switch = (id) => new Promise((done) => {
    const b = [...document.querySelectorAll('.tb-navtab[data-navid="' + id + '"]')].find((x) => x.offsetParent);
    if (!b) return done(-1);
    const t0 = performance.now();
    P.mark = id;
    b.click();
    const check = () => {
      const a = [...document.querySelectorAll('.tb-navtab.active')].find((x) => x.offsetParent);
      if (a && a.dataset.navid === id && document.querySelector('.tbq-pane > *')) requestAnimationFrame(() => done(performance.now() - t0));
      else if (performance.now() - t0 > 5000) done(5000);
      else requestAnimationFrame(check);
    };
    check();
  });
})();`;

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot } = driver(c);
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  await size(1280, 900);
  await boot({ quant: true, docs: { 'dashboards/tradeboard_journal': bigJournal(800) } });
  ok('the app is marked for Quant\'s motion', await until(`document.querySelector('.tbq-on')`, 10000));
  ok('long tasks can be observed here', !(await js(`return !!window.__perf.unsupported;`)));
  // Visit every tab once so each has loaded what it loads on first open.
  for (const id of TABS) { await js(`return window.__switch('${id}');`); await sleep(900); }
  await until(`document.querySelector('[data-mk-score]') || true`, 100);
  await sleep(1500);

  async function switches(label, limit) {
    const times = {};
    for (let round = 0; round < 3; round++) for (const id of TABS) {
      const ms = await js(`return window.__switch('${id}');`);
      (times[id] = times[id] || []).push(ms);
      await sleep(350);
    }
    const med = Object.fromEntries(TABS.map((id) => [id, Math.round(median(times[id]))]));
    const worst = Object.fromEntries(TABS.map((id) => [id, Math.round(Math.max(...times[id]))]));
    console.log('    switch to (median ms): ' + TABS.map((id) => id + ' ' + med[id]).join(', '));
    console.log('    switch to (worst ms):  ' + TABS.map((id) => id + ' ' + worst[id]).join(', '));
    ok(`${label}: every tab switch is on screen in under ${limit} ms (median of 3)`, TABS.every((id) => med[id] >= 0 && med[id] < limit), JSON.stringify(med));
    return med;
  }
  async function minute(label, seconds, longLimit, fpsLimit) {
    await js(`window.__perf.long.length = 0; window.__perf.frames.length = 0; window.__perf.on = true; window.__ws.auto(100); 1`);
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < seconds * 1000) {
      await js(`window.__switch('${TABS[i++ % TABS.length]}'); 1`);
      await sleep(3000);
    }
    const r = JSON.parse(await js(`window.__perf.on = false; window.__ws.auto(0); var P = window.__perf, f = P.frames, sum = f.reduce(function(a,b){return a+b;},0);
      return JSON.stringify({ long: P.long, frames: f.length, fps: f.length ? 1000 * f.length / sum : 0, slow: f.filter(function(x){return x>34;}).length, worst: Math.round(Math.max.apply(null, f.concat([0]))) });`));
    const over = r.long.filter((x) => x.ms > longLimit);
    console.log(`    ${seconds} s: ${r.frames} frames, ${r.fps.toFixed(1)} fps, ${r.slow} frames over 34 ms (worst ${r.worst} ms), long tasks: ${r.long.length ? r.long.map((x) => x.ms + ' ms on ' + x.mark).join(', ') : 'none'}`);
    ok(`${label}: no main-thread task over ${longLimit} ms`, over.length === 0, over.map((x) => x.ms + ' ms on ' + x.mark).join(', '));
    ok(`${label}: at least ${fpsLimit} frames a second`, r.fps >= fpsLimit, r.fps.toFixed(1));
    return r;
  }

  console.log('\nFull speed');
  await switches('full speed', 150);
  ok('the streams carry the watchlist and the sector funds for the fake ticks', await js(`return window.__ws.state.subs.size >= 20;`), await js(`return window.__ws.state.subs.size;`));
  await minute('full speed', SECONDS, 50, 55);

  console.log('\n4x CPU throttle (a phone)');
  await c.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await switches('throttled', 450);
  await minute('throttled', Math.max(12, Math.round(SECONDS / 3)), 200, 30);
  await c.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  console.log('\nWhat moves');
  const anim = JSON.parse(await js(`var out = []; var id = 'journal';
    var b = [...document.querySelectorAll('.tb-navtab[data-navid="' + id + '"]')].find(function(x){return x.offsetParent;}); b.click();
    await new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); });
    document.getAnimations().forEach(function(a){ var k = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : []; var props = {}; k.forEach(function(f){ Object.keys(f).forEach(function(p){ if(['offset','easing','composite','computedOffset'].indexOf(p)<0) props[p]=1; }); });
      var t = a.effect && a.effect.target; var pe = a.effect && a.effect.pseudoElement; out.push({ on: pe || (t && (t.className||t.tagName)) || '', props: Object.keys(props), ms: a.effect.getComputedTiming().duration }); });
    return JSON.stringify(out);`));
  const moving = anim.filter((a) => /view-transition|tbq|tb-fade-in/.test(String(a.on)));
  ok('a tab change settles into place', moving.length > 0, JSON.stringify(anim).slice(0, 300));
  ok('...with a transform only, nothing fading, in under 200 ms', moving.every((a) => a.props.length && a.props.every((p) => p === 'transform') && a.ms <= 200), JSON.stringify(moving));
  ok('...and no view transition', !anim.some((a) => /view-transition/.test(String(a.on))));
  await sleep(400);
  const again = JSON.parse(await js(`var b = [...document.querySelectorAll('.tb-navtab[data-navid="journal"]')].find(function(x){return x.offsetParent;}); var first = document.querySelector('.tbq-pane > *');
    var before = new Set(document.getAnimations());
    b.click(); b.click();
    await new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); });
    var started = document.getAnimations().filter(function(a){ return !before.has(a); });
    return JSON.stringify({ same: document.querySelector('.tbq-pane > *') === first, anims: started.length, what: started.map(function(a){ return String(a.animationName || '') + ' on ' + String((a.effect.target && a.effect.target.className) || ''); }) });`));
  ok('clicking the tab already open redraws nothing and plays nothing', again.same && again.anims === 0, JSON.stringify(again));
  await sleep(500);
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const calm = JSON.parse(await js(`var b = [...document.querySelectorAll('.tb-navtab[data-navid="market"]')].find(function(x){return x.offsetParent;}); b.click();
    await new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); });
    return JSON.stringify(document.getAnimations().map(function(a){ var k=a.effect.getKeyframes(); var p={}; k.forEach(function(f){ Object.keys(f).forEach(function(x){ p[x]=1; }); }); return { t: !!p.transform, ms: a.effect.getComputedTiming().duration, on: String(a.effect.pseudoElement || (a.effect.target && a.effect.target.className) || '') }; }).filter(function(a){ return /view-transition|tbq|tb-fade-in|lay-card/.test(a.on); }));`));
  ok('with "reduce motion" nothing slides: at most a 120 ms fade', calm.every((a) => !a.t && a.ms <= 120), JSON.stringify(calm));
  await c.send('Emulation.setEmulatedMedia', { features: [] });

  console.log('\nThe Journal, 800 trades');
  await js(`return window.__switch('portfolio');`); await sleep(500);
  const jt = [];
  for (let i = 0; i < 3; i++) { jt.push(await js(`return window.__switch('journal');`)); await sleep(1500); await js(`return window.__switch('portfolio');`); await sleep(400); }
  console.log('    Journal on screen (ms): ' + jt.map(Math.round).join(', '));
  ok('it is on screen in under 150 ms', Math.max(...jt) < 150, jt.join());
  await js(`return window.__switch('journal');`); await sleep(300);
  const rows = () => js(`return document.querySelectorAll('.tbj-tbl tbody tr:not(.tbj-day)').length;`);
  const first = await rows();
  await js(`window.__perf.long.length = 0; window.__perf.on = true; 1`);
  await sleep(2000);
  const idle = JSON.parse(await js(`window.__perf.on = false; return JSON.stringify(window.__perf.long.map(function(x){return x.ms;}));`));
  ok(`it opens with the first ${first} rows and runs nothing while it sits still`, first >= 50 && first < 200 && idle.length === 0 && (await rows()) === first, first + ' rows; ' + idle.join());
  await js(`window.__perf.long.length = 0; window.__perf.on = true; 1`);
  for (let k = 0; k < 40 && (await rows()) < 800; k++) { await js(`var p=document.querySelector('.tbj-tbl').closest('.tb-scroll-thin'); p.scrollTop=p.scrollHeight; 1`); await sleep(150); }
  const jl = JSON.parse(await js(`window.__perf.on = false; return JSON.stringify(window.__perf.long.map(function(x){return x.ms;}));`));
  ok('scrolling to the end draws all 800 rows', (await rows()) === 800, await rows());
  ok('...with no main-thread task over 50 ms on the way', jl.every((x) => x <= 50), jl.join());
  ok('"Show all" is gone once every row is drawn', await js(`return !document.querySelector('[data-tbj-more]');`));

  console.log('\nSide effects');
  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
