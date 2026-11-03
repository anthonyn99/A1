// TradeHub's morning hand-off (2026-11-03): Trading Auto Launch opens
// tradehub.html#tbsummary, and once this morning's news build AND its summary
// are in, TradeHub goes to News and opens the Summary overlay by itself.
// Real tradehub.html, fake Firestore, fake newshub.
//
//   1. digest already in when TradeHub opens → News + overlay at once, the
//      #tbsummary is gone from the address, and a reload does not do it again
//   2. no #tbsummary (any ordinary open) → TradeHub stays where it opens
//   3. only yesterday's build when it opens → it waits on Portfolio; this
//      morning's build lands (seen on a reload: the request survives it) → News
//      + overlay
//
// Run: node tests/live/tradehub-morning-summary.live.js   (TH_PAGE_FILE=<copy>)
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const URL = ORIGIN + '/A1/tradehub.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

// Today's 6 AM slot as TradeHub computes it (tbLastMorningSlot).
const NOW = Date.now();
const six = new Date(); six.setHours(6, 0, 0, 0);
const SLOT = six.getTime() <= NOW ? six.getTime() : six.getTime() - 86400000;
const GEN = SLOT + 60000;              // this morning's build
const OLD = SLOT - 20 * 3600000;       // yesterday's
const src = (h, m) => ({ headline: h, url: 'https://example.com/' + encodeURIComponent(h), name: 'Reuters', ts: NOW - m * 60000 });
const EVENTS = [
  { id: 'n1', primaryTicker: 'NVDA', sectors: ['Semiconductors'], impact: { tier: 'critical', score: 92 }, sentiment: { label: 'bull', score: 0.6 }, eventType: 'earnings', aiAnalyzed: true, ts: NOW - 600000,
    summary: 'Nvidia guides above estimates.', sources: [src('Nvidia raises guidance', 10)] },
  { id: 'n2', primaryTicker: 'MU', sectors: ['Semiconductors'], impact: { tier: 'major', score: 70 }, sentiment: { label: 'bear', score: -0.4 }, eventType: 'analyst', aiAnalyzed: true, ts: NOW - 3600000,
    summary: 'Micron cut at two brokers.', sources: [src('Micron downgraded', 60)] },
];
const SUMMARY = { headline: 'Chips split on guidance', tone: 'mixed', toneScore: 0.1, overview: 'A split tape.', keyPoints: [{ text: 'NVDA up.', stance: 'bull', tickers: ['NVDA'] }],
  tickers: [], themes: [], risks: [], watch: [], model: 'gemini-2.5-flash' };

let newsGen = GEN;   // what newshub's cache holds right now
const worker = {
  patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    if (/\/news\?/.test(req.url)) return { json: { events: EVENTS, generatedAt: newsGen, cached: true } };
    if (/\/summary\?/.test(req.url)) {
      const g = +new URL(req.url).searchParams.get('gen');
      return { json: { ok: true, summary: SUMMARY, generatedAt: g } };
    }
    if (/\/rate-status/.test(req.url)) return { json: { used: 0, cooldownSec: 0 } };
    return { json: { ok: true } };
  },
};

(async () => {
  const c = await connect({ mock: firebaseMock(worker) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const onNews = "document.querySelector('#tradeboard-root .nh-page')";
  const overlay = "document.querySelector('.nhs .nhs-headline')";
  async function fresh(newsDocGen, digestGen) {
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
      ${digestGen ? `localStorage.setItem('tb_news_summary', JSON.stringify({gen:${digestGen}, data:${JSON.stringify(SUMMARY)}}));` : ''}
      sessionStorage.setItem('__fakefs_docs', JSON.stringify({
        'dashboards/tradeboard_watchlist': { tickers: ['NVDA','MU'], trash: [], savedAt: ${NOW} },
        'dashboards/tradeboard_news': { events: ${JSON.stringify(EVENTS)}, generatedAt: ${newsDocGen}, savedAt: ${newsDocGen} }
      })); 1`);
  }
  async function open(hash) {
    await c.send('Page.navigate', { url: URL + (hash || '') });
    if (!(await until("document.querySelector('.tb-navtab')", 20000))) throw new Error('TradeHub did not render');
  }

  console.log('\n1. Digest already in');
  newsGen = GEN;
  await fresh(GEN, GEN);
  await open('#tbsummary');
  ok('it goes to News', await until(onNews, 15000));
  ok('…and opens the Summary overlay with this morning\'s digest', await until(overlay, 8000) && await js(`return document.querySelector('.nhs-headline').textContent===${JSON.stringify(SUMMARY.headline)};`));
  ok('#tbsummary is gone from the address', await js(`return location.hash==='' && /tradehub\\.html$/.test(location.pathname);`), await js(`return location.href;`));
  ok('the request is used up', await js(`return sessionStorage.getItem('tb_morning_summary')===null;`));
  await open('');
  await sleep(4000);
  ok('a reload afterwards opens TradeHub normally (no News, no overlay)', !(await js(`return !!(${onNews}) || !!(${overlay});`)));

  console.log('\n2. An ordinary open');
  await fresh(GEN, GEN);
  await open('');
  await sleep(5000);
  ok('without #tbsummary it stays where it opens', !(await js(`return !!(${onNews}) || !!(${overlay});`)));

  console.log('\n3. Only yesterday\'s build when it opens');
  newsGen = OLD;
  await fresh(OLD, OLD);
  await open('#tbsummary');
  await sleep(5000);
  ok('it waits: still on its first tab, no overlay', !(await js(`return !!(${onNews}) || !!(${overlay});`)));
  ok('…holding the request', await js(`return +sessionStorage.getItem('tb_morning_summary')>Date.now();`));
  newsGen = GEN;   // this morning's build lands in newshub
  await open('');  // a reload: the morning orchestrator picks the build up and warms its digest
  ok('when the build and its summary land, it goes to News', await until(onNews, 20000));
  ok('…and opens the overlay', await until(overlay, 8000));

  const real = errs.filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|NetworkError|recaptcha|appCheck|App Check|finnhub|workers\.dev/i.test(e));
  ok('no page errors', !real.length, real.join(' | '));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
