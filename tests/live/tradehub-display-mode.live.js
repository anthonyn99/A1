// TradeHub Display mode (2026-11-07, after Insight's). Real tradehub.html
// (TH_PAGE_FILE serves a work-in-progress copy), fake Firestore, fake worker.
//
// The eye button sits just left of the app lock on desktop and phone. On, it
// blurs the personal figures on Portfolio (account tiles, position qty/value/
// P&L, avg cost, percentages, history totals) and Journal (row P&L, totals,
// qty, entry/exit, %, the stats card, the equity hero) but leaves the live
// market price (Last) readable. It survives a reload, and off again
// clears every blur.
//
// Run: node tests/live/tradehub-display-mode.live.js   (TH_PAGE_FILE=<copy>)
'use strict';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
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
    if (p === '/api/portfolio/summary') return { json: { ok: true, data: {
      account: { totalValue: 48213.55, cashBalance: 9120.4, buyingPower: 9120.4, dayPnL: 312.2, unrealizedPnL: 1404.1 },
      positions: [{ ticker: 'NVDA', shares: 40, avgCost: 150, currentPrice: 185.1, marketValue: 7404, unrealizedPnL: 1404, unrealizedPct: 23.4 }],
      orders: [], history: [{ symbol: 'NVDA', action: 'BUY', filledQty: 40, avgFilledPrice: 150, status: 'FILLED', filledAt: '2026-10-20T14:00:00Z', fee: 0.4 }],
      activities: [], errors: {} } } };
    if (p === '/api/journal/sync') return { json: { ok: true, data: [], feesRemaining: 0 } };
    if (p === '/news') return { json: { events: [], generatedAt: NOW } };
    return { json: { ok: true } };
  },
};

(async () => {
  const c = await connect({ mock: firebaseMock(worker) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const js = (e) => evalJs(c, /^\s*return\b/.test(e) && !/;\s*$/.test(e) ? e + ';' : e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  const shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotPath(name), Buffer.from(r.result.data, 'base64')); console.log('  shot ' + shotPath(name)); };
  const nav = (id) => js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(b=>b.offsetParent); t&&t.click(); 1`);
  // Is the visible element whose text matches `re` blurred?
  const blurred = (re) => js(`var re=${re}; var el=[...document.querySelectorAll('#tradeboard-root *')].filter(e=>e.offsetParent&&e.children.length===0&&re.test(e.textContent))[0];
    if(!el) return 'missing'; for(var n=el;n&&n!==document.body;n=n.parentElement){ if(/blur/.test(getComputedStyle(n).filter)) return true; } return false;`);
  const btn = () => js(`var b=[...document.querySelectorAll('[aria-label="Display mode"]')].find(x=>x.offsetParent); if(!b) return null;
    var lock=b.nextElementSibling; return {pressed:b.getAttribute('aria-pressed'), nextIsLock:!!lock&&/^tb-lock-btn/.test(lock.id), left:b.getBoundingClientRect().right<=lock.getBoundingClientRect().left+1};`);

  const load = async (w, h, mobile) => {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await c.send('Page.navigate', { url: URL_ });
    if (!(await until("document.querySelector('.tb-navtab')", 20000))) throw new Error('TradeHub did not render');
    await sleep(600);
  };

  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
    localStorage.setItem('td6_mainDash','tony');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({
      'dashboards/tradeboard_journal': { savedAt: ${NOW - 86400000},
        't_rt': { id: 'rt', source: 'manual', ticker: 'AMD', createdAt: ${NOW - 3 * 86400000}, status: 'CLOSED', legs: [
          { id: 'x1', action: 'BUY', datetime: '2026-10-20T08:00', qty: '37', price: '100', fee: '0' },
          { id: 'x2', action: 'SELL', datetime: '2026-10-21T09:00', qty: '37', price: '111', fee: '0' } ] } } })); 1`);

  for (const [label, w, h, mobile] of [['desktop', 1440, 1000, false], ['phone', 390, 844, true]]) {
    console.log(`\n${label}`);
    await load(w, h, mobile);
    const b = await btn();
    ok('the Display mode button is visible', !!b, JSON.stringify(b));
    ok('it sits just left of the app lock', b && b.nextIsLock && b.left, JSON.stringify(b));
    ok('it starts off', b && b.pressed === 'false');

    await nav('portfolio');
    ok('Portfolio rendered', await until(`/48,213\\.55/.test(document.querySelector('#tradeboard-root').innerText)`, 10000));
    ok('off: Total Value is readable', (await blurred('/^\\$48,213\\.55$/')) === false);
    await js(`[...document.querySelectorAll('[aria-label="Display mode"]')].find(x=>x.offsetParent).click(); 1`); await sleep(300);
    ok('on: the button reads pressed', (await btn()).pressed === 'true');
    ok('on: Total Value is blurred', (await blurred('/^\\$48,213\\.55$/')) === true);
    ok('on: Cash Balance is blurred', (await blurred('/^\\$9,120\\.40$/')) === true);
    if (!mobile) {
      ok('on: position market value is blurred', (await blurred('/^\\$7,404\\.00$/')) === true);
      ok('on: position qty is blurred', (await blurred('/^40$/')) === true);
      ok('on: the last price stays readable', (await blurred('/^\\$185\\.10$/')) === false);
      ok('on: the P&L percentage is blurred', (await blurred('/^\\+23\\.40%$/')) === true);
      ok('on: the average cost is blurred', (await blurred('/^\\$150\\.00$/')) === true);
      ok('on: the share of total is blurred', (await blurred('/% of total$/')) === true);
    }
    ok('on: the market strip is untouched', (await blurred('/^US markets/')) === false);
    await shot(`th-display-${label}-portfolio`);

    await nav('journal');
    ok('Journal rendered', await until(`/AMD/.test(document.querySelector('#tradeboard-root').innerText)`, 10000));
    ok('on: the trade P&L is blurred', (await blurred('/^\\$407\\.00$/')) === true, await blurred('/^\\$407\\.00$/'));
    ok('on: the equity hero is blurred', (await blurred('/^\\+\\$407\\.00$/')) === true, await blurred('/^\\+\\$407\\.00$/'));
    ok('on: the trade % is blurred', (await blurred('/^\\+11\\.00%$/')) === true);
    ok('on: the win rate is blurred', (await blurred('/^100%$/')) === true);
    ok('on: the wins count is blurred', (await blurred('/^1$/')) === true);
    if (!mobile) {
      ok('on: the entry price is blurred', (await blurred('/^\\$100\\.00$/')) === true);
      ok('on: the exit price is blurred', (await blurred('/^\\$111\\.00$/')) === true);
    }
    await shot(`th-display-${label}-journal`);

    await load(w, h, mobile);
    ok('it is still on after a reload', (await btn()).pressed === 'true' && await js(`return document.documentElement.classList.contains('tb-privacy')`));
    await js(`[...document.querySelectorAll('[aria-label="Display mode"]')].find(x=>x.offsetParent).click(); 1`); await sleep(300);
    await nav('journal'); await sleep(500);
    ok('off again: nothing is blurred', (await blurred('/^\\$407\\.00$/')) === false && await js(`return ![...document.querySelectorAll('.tb-money')].some(e=>/blur/.test(getComputedStyle(e).filter))`));
    await nav('portfolio'); await sleep(800);
    await shot(`th-display-${label}-market-strip`);
  }

  const real = errs.filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|NetworkError|recaptcha|appCheck|App Check|finnhub|workers\.dev/i.test(e));
  ok('no page errors', !real.length, real.join(' | '));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
