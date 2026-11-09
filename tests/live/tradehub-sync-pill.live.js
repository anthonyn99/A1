// TradeHub's header never says "Sync failed" just because Firestore was put to
// sleep (2026-11-09). TradeHub tears its Firestore client down 1 s after the tab
// hides and after 5 idle minutes, and only rebuilt it on a tap. Its timers (the
// 5-minute morning check, the intraday news tick, the build watcher) kept saving
// through functions built over the dead client, so the save failed and the pill
// went red with nothing done. A save that started (news waits 1 s) just before
// the tab hid was cut off the same way.
//
// Real tradehub.html (TH_PAGE_FILE serves a work-in-progress copy), fake
// Firestore in strict mode: a terminated client refuses every read and write.
//
// Run: node tests/live/tradehub-sync-pill.live.js   (TH_PAGE_FILE=<copy>)
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const URL_ = ORIGIN + '/A1/tradehub.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const NOW = Date.now();
const worker = {
  patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const p = new URL(req.url).pathname;
    if (p === '/api/journal/sync') return { json: { ok: true, data: [] } };
    if (p === '/api/portfolio/summary') return { json: { ok: true, data: { account: { totalValue: 5000 }, positions: [], orders: [], history: [], activities: [], errors: {} } } };
    if (p === '/news') return { json: { events: [], generatedAt: NOW } };
    return { json: { ok: true } };
  },
};

// Strict terminate, a controllable document.hidden, and a log of sync errors.
const BOOT = `(function(){
  window.__fakeStrictTerminate = true;
  window.__hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: function(){ return window.__hidden; } });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: function(){ return window.__hidden ? 'hidden' : 'visible'; } });
  window.__syncErr = [];
  ['journal','prompts','news','analysis','watchlist','dash','marketcal'].forEach(function(k){
    window.addEventListener('fb-tb-' + k + '-error', function(){ window.__syncErr.push(k); });
  });
})();`;

(async () => {
  const c = await connect({ mock: firebaseMock(worker) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const js = (e) => evalJs(c, /^\s*return\b/.test(e) && !/;\s*$/.test(e) ? e + ';' : e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  const hide = async (h) => { await js(`window.__hidden=${h}; document.dispatchEvent(new Event('visibilitychange')); 1`); };
  const newsSavedAt = () => js(`var d=__fakeFs.docs['dashboards/tradeboard_news']; return d ? d.generatedAt||0 : 0;`);
  const pillRed = () => js(`return !!document.querySelector('.a1-sync.err');`);

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
    localStorage.setItem('td6_mainDash','tony'); localStorage.setItem('tb_page','control');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/tradeboard_journal': { savedAt: ${NOW - 86400000} } })); 1`);
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: BOOT });
  await c.send('Page.navigate', { url: URL_ });
  if (!(await until("document.querySelector('.tb-navtab') && window._fbReady", 20000))) throw new Error('TradeHub did not render');
  await sleep(2500);
  // The morning news watcher is still polling this fake worker's empty build, and
  // a running job rightly keeps Firestore awake (_tbJobs.holdFirestore). End it,
  // so the teardown under test is the only thing in play.
  await js(`Object.keys(window._tbJobs.active).forEach(function(k){ window._tbJobs.set(k,''); }); window.__syncErr=[]; 1`);

  console.log('\nA timer saves while Firestore is asleep');
  await hide(true);
  ok('the tab hides and Firestore is torn down', await until(`window._fbReady===false`, 6000));
  // What the morning check / intraday tick does on its own, nobody touching the page.
  const gen1 = NOW + 1111;
  await js(`window._fbSaveTBNews({ events: [{ id: 'e1' }], generatedAt: ${gen1} }); 1`);
  ok('the save lands anyway', await until(`(__fakeFs.docs['dashboards/tradeboard_news']||{}).generatedAt===${gen1}`, 8000), await newsSavedAt());
  ok('no sync error, the pill is not red', !(await js(`return window.__syncErr.length;`)) && !(await pillRed()), await js(`return window.__syncErr.join(',');`));
  ok('a read after the teardown works too', await js(`return window._fbLoadTBNews().then(function(d){ return !!d && d.generatedAt===${gen1}; });`));

  console.log('\nA save starts, then the tab hides before it is written');
  await hide(false); await until(`window._fbReady`, 6000); await sleep(500);
  const gen2 = NOW + 2222;
  await js(`window._fbSaveTBNews({ events: [{ id: 'e2' }], generatedAt: ${gen2} }); 1`);
  await hide(true);
  ok('the teardown waits for it, and it lands', await until(`(__fakeFs.docs['dashboards/tradeboard_news']||{}).generatedAt===${gen2}`, 8000), await newsSavedAt());
  ok('still no sync error', !(await js(`return window.__syncErr.length;`)) && !(await pillRed()), await js(`return window.__syncErr.join(',');`));
  ok('…and Firestore still goes to sleep afterwards', await until(`window._fbReady===false`, 10000));
  await hide(false);

  const real = errs.filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|NetworkError|recaptcha|appCheck|App Check|finnhub|workers\.dev|terminated/i.test(e));
  ok('no page errors', !real.length, real.join(' | '));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
