// TradeHub additions of 2026-11-03, end to end. Real tradehub.html (TH_PAGE_FILE
// serves a work-in-progress copy), fake Firestore, fake workers.
//
//   1. News: the market strip (futures, 10Y, oil, VIX, dollar) with sparklines;
//      a "Held" badge on stories about Webull positions, those stories first by
//      impact, and a Held filter; each ticker's earnings as a chip that opens
//      Catalysts; extended-hours moves; Webull asked for quotes once, then left
//      alone for 6 h after it says the account has no OpenAPI market data.
//   2. The intraday tick publishes a newer build to Firebase and the News tab.
//   3. Portfolio ▸ Activity: Webull cash activity, totals, filters, ranges, a
//      table on desktop and a list on a phone, and an honest error state.
//   4. Journal: Webull fees for past trades reach legs that were on $0.
//   5. 390 px: nothing scrolls sideways.
//
// Run: node tests/live/tradehub-news-market.live.js   (TH_PAGE_FILE=<copy>)
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
const ymd = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TODAY = ymd(NOW), TOMORROW = ymd(NOW + 86400000);
const six = new Date(); six.setHours(6, 0, 0, 0);
const SLOT = six.getTime() <= NOW ? six.getTime() : six.getTime() - 86400000;
const GEN = SLOT + 60000;

// The phase TradeHub will see (tbMktState): New York clock, weekdays.
const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
const etMin = ((+etParts.hour) % 24) * 60 + (+etParts.minute);
const weekday = !/Sat|Sun/.test(etParts.weekday);
const PHASE = !weekday ? 'closed' : etMin < 240 ? 'closed' : etMin < 570 ? 'pre' : etMin < 960 ? 'regular' : etMin < 1200 ? 'after' : 'closed';
const EXT_KIND = PHASE === 'pre' ? 'pre' : 'post';

const src = (h, m) => ({ headline: h, url: 'https://example.com/' + encodeURIComponent(h), name: 'Reuters', ts: NOW - m * 60000 });
const EVENTS = [
  { id: 'n-mu', primaryTicker: 'MU', sectors: ['Semiconductors'], impact: { tier: 'critical', score: 92 }, sentiment: { label: 'bear', score: -0.5 }, eventType: 'analyst', aiAnalyzed: true, ts: NOW - 50 * 60000, summary: 'Micron cut at two brokers.', sources: [src('Micron downgraded', 50)] },
  { id: 'n-nvda', primaryTicker: 'NVDA', sectors: ['Semiconductors'], impact: { tier: 'major', score: 70 }, sentiment: { label: 'bull', score: 0.6 }, eventType: 'earnings', aiAnalyzed: true, ts: NOW - 90 * 60000, summary: 'Nvidia guides above estimates.', sources: [src('Nvidia raises guidance', 90)] },
  { id: 'n-amd', primaryTicker: 'AMD', sectors: ['Semiconductors'], impact: { tier: 'notable', score: 40 }, sentiment: { label: 'neutral', score: 0 }, eventType: 'other', aiAnalyzed: true, ts: NOW - 120 * 60000, summary: 'AMD at a conference.', sources: [src('AMD conference', 120)] },
];
const NEWER = { id: 'n-new', primaryTicker: 'AMD', sectors: ['Semiconductors'], impact: { tier: 'major', score: 75 }, sentiment: { label: 'bull', score: 0.4 }, eventType: 'other', aiAnalyzed: true, ts: NOW - 60000, summary: 'AMD wins a hyperscaler deal (intraday).', sources: [src('AMD deal', 1)] };
const CAL = [
  { id: 'mc_earnings_NVDA_' + TOMORROW, date: TOMORROW, kind: 'earnings', category: 'earnings', name: 'NVDA Earnings', ticker: 'NVDA', when: 'amc', confirmed: true },
  { id: 'mc_macro_inflation_cpi_' + TODAY, date: TODAY, kind: 'macro', category: 'inflation', name: 'CPI Report', importance: 'high' },
];
const pts = (a, b) => Array.from({ length: 24 }, (_, i) => +(a + (b - a) * i / 23 + Math.sin(i) * 0.3).toFixed(2));
const MARKET = { ok: true, source: 'yahoo', asOf: NOW, context: [
  { key: 'es', sym: 'ES=F', label: 'S&P fut', price: 7561, dp: -0.47, points: pts(7590, 7561) },
  { key: 'nq', sym: 'NQ=F', label: 'Nasdaq fut', price: 28075.25, dp: -0.81, points: pts(28300, 28075) },
  { key: 'tnx', sym: '^TNX', label: '10Y yield', unit: '%', price: 4.952, dp: 1.19, points: pts(4.89, 4.95) },
  { key: 'cl', sym: 'CL=F', label: 'WTI oil', price: 96.69, dp: 0.62, points: pts(96, 96.7) },
  { key: 'vix', sym: '^VIX', label: 'VIX', price: 20.83, dp: -1.51, points: pts(21.2, 20.8) },
  { key: 'dxy', sym: 'DX-Y.NYB', label: 'Dollar', price: 101.734, dp: -0.13, points: pts(101.9, 101.7) },
], stocks: {
  NVDA: { c: 206.69, dp: 2.29, ext: { kind: EXT_KIND, price: 205.5, dp: -0.58 }, points: pts(202, 206.7) },
  MU: { c: 855.1, dp: -3.05, ext: { kind: EXT_KIND, price: 849.4, dp: -0.67 }, points: pts(880, 855) },
  AMD: { c: 160.1, dp: 0.4, ext: null, points: pts(159, 160) },
} };
const ACT = [
  { id: 'a1', type: 'DIVIDENDS', sub: 'INCOME', symbol: 'MSFT', date: ymd(NOW - 20 * 86400000), at: new Date(NOW - 20 * 86400000).toISOString(), amount: 4.2, currency: 'USD' },
  { id: 'a2', type: 'DEPOSIT', sub: 'ACH', symbol: '', date: ymd(NOW - 40 * 86400000), at: new Date(NOW - 40 * 86400000).toISOString(), amount: 500, currency: 'USD' },
  { id: 'a3', type: 'INTERESTS', sub: 'CREDIT', symbol: '', date: ymd(NOW - 5 * 86400000), at: new Date(NOW - 5 * 86400000).toISOString(), amount: 0.8, currency: 'USD' },
  { id: 'a4', type: 'FEES', sub: 'ADR', symbol: 'TSM', date: ymd(NOW - 100 * 86400000), at: new Date(NOW - 100 * 86400000).toISOString(), amount: -0.35, currency: 'USD' },
  { id: 'a5', type: 'WITHDRAW', sub: 'ACH', symbol: '', date: ymd(NOW - 200 * 86400000), at: new Date(NOW - 200 * 86400000).toISOString(), amount: -200, currency: 'USD' },
];

const seen = [];
const S = { activityFails: false, intradayGen: 0, wbMarket: 0 };
const worker = {
  patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = new URL(req.url);
    seen.push(req.method + ' ' + u.pathname + u.search);
    if (u.pathname === '/api/market/quotes') { S.wbMarket++; return { json: { ok: false, code: 'NO_MARKET_DATA', status: 403, error: 'No market data permission' } }; }
    if (u.pathname === '/api/portfolio/summary') return { json: { ok: true, data: { account: { totalValue: 25000, cashBalance: 900, buyingPower: 900 }, positions: [{ ticker: 'NVDA', shares: 10, avgCost: 180, currentPrice: 206.69, marketValue: 2066.9, unrealizedPnL: 266.9 }], orders: [], history: [], activities: [], errors: {} } } };
    if (u.pathname === '/api/portfolio/activities') return S.activityFails ? { status: 502, json: { ok: false, error: 'Webull API unavailable' } } : { json: { ok: true, days: 400, items: ACT, asOf: new Date().toISOString() } };
    if (u.pathname === '/market') return { json: MARKET };
    if (u.pathname === '/news' && u.searchParams.get('intraday') === '1') return { json: { events: [NEWER, ...EVENTS], generatedAt: S.intradayGen || GEN, cached: false } };
    if (u.pathname === '/news') return { json: { events: EVENTS, generatedAt: GEN, cached: true } };
    if (u.pathname === '/calendar') return { json: { events: CAL, generatedAt: GEN } };
    if (u.pathname === '/summary') return { json: { ok: false } };
    if (u.pathname === '/rate-status') return { json: { used: 0, cooldownSec: 0 } };
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
  // evalJs treats a snippet without a semicolon as an expression.
  const js = (e) => evalJs(c, /^\s*return\b/.test(e) && !/;\s*$/.test(e) ? e + ';' : e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  const size = (w, h) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const shot = async (name) => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotPath(name), Buffer.from(s.result.data, 'base64')); };
  const tab = async (id) => { await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(b=>b.offsetParent); if(t) t.click(); 1`); await sleep(900); };
  const page = () => js(`var n=document.querySelector('.tb-navtab.on,.tb-navtab[aria-current="page"]'); return n?n.getAttribute('data-navid'):'';`);
  // '' when nothing pokes past the right edge, else what does (class|tag|right).
  const sideways = () => js(`var out=[...document.querySelectorAll('#tradeboard-root *')].filter(e=>{var b=e.getBoundingClientRect();return b.width&&b.right>innerWidth+1&&!e.closest('[data-sb-strip],table,.tb-scroll-x,.tb-navtab')&&getComputedStyle(e).position!=='fixed';}).slice(0,6).map(e=>String(e.className&&e.className.baseVal!==undefined?e.className.baseVal:e.className)+'|'+e.tagName+'|'+Math.round(e.getBoundingClientRect().right)); if(document.documentElement.scrollWidth>innerWidth+1)out.push('page '+document.documentElement.scrollWidth); return out.join(' ; ');`);

  async function seed() {
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
      localStorage.setItem('td6_mainDash','veda'); localStorage.setItem('td6_watchlist', JSON.stringify(['NVDA','MU','AMD']));
      localStorage.setItem('tb_morning_news_slot', String(${SLOT}));
      sessionStorage.setItem('__fakefs_docs', JSON.stringify({
        'dashboards/tradeboard_watchlist': { tickers: ['NVDA','MU','AMD'], trash: [], savedAt: ${NOW} },
        'dashboards/tradeboard_news': { events: ${JSON.stringify(EVENTS)}, generatedAt: ${GEN}, savedAt: ${GEN}, settings: { keep: 1 } },
        'dashboards/market_calendar': { events: ${JSON.stringify(CAL)}, generatedAt: ${GEN}, savedAt: ${GEN}, watchlist: ['NVDA','MU','AMD'] }
      })); 1`);
  }

  console.log('\n1. News (desktop) · phase ' + PHASE);
  await size(1440, 1000);
  await seed();
  await c.send('Page.navigate', { url: URL_ });
  if (!(await until("document.querySelector('.tb-navtab')", 20000))) throw new Error('TradeHub did not render');
  await tab('news');
  ok('the market strip: six tiles', await until(`document.querySelectorAll('.nh-mkt-t').length===6`, 10000), await js(`return document.querySelectorAll('.nh-mkt-t').length`));
  const strip = await js(`return [...document.querySelectorAll('.nh-mkt-t')].map(t=>t.innerText.replace(/\\s+/g,' ')).join(' | ');`);
  ok('…labels, values and changes', /S&P fut -0\.47% 7,561\.00/i.test(strip) && /10Y yield \+1\.19% 4\.95%/i.test(strip) && /WTI oil \+0\.62% \$96\.69/i.test(strip), strip);
  ok('…each with a sparkline', await js(`return [...document.querySelectorAll('.nh-mkt-t')].every(t=>t.querySelector('svg.nh-spark polyline'))`));
  ok('…coloured by the move (down = red)', await js(`return document.querySelector('.nh-mkt-t .d').style.color.indexOf('tbr')>=0`));
  await until(`document.querySelector('.nh-held')`, 8000);
  const order = await js(`return [...document.querySelectorAll('.nh-ev .nh-tk')].map(x=>x.textContent).join(',');`);
  ok('the held story (NVDA, major) comes before a bigger one about MU', order.startsWith('NVDA,MU'), order);
  ok('…marked Held, and only it', await js(`return [...document.querySelectorAll('.nh-ev')].filter(a=>a.querySelector('.nh-held')).map(a=>a.querySelector('.nh-tk').textContent).join()==='NVDA'`));
  ok('Latest order stays by time', await js(`var b=[...document.querySelectorAll('.nh-tools .tbx-seg button')].find(x=>x.textContent==='Latest'); b.click(); return true;`) && await until(`[...document.querySelectorAll('.nh-ev .nh-tk')].map(x=>x.textContent).join()==='MU,NVDA,AMD'`, 3000));
  await js(`[...document.querySelectorAll('.nh-tools .tbx-seg button')].find(x=>x.textContent==='Impact').click(); 1`);
  const chip = await js(`var e=[...document.querySelectorAll('.nh-ev')].find(a=>a.querySelector('.nh-tk').textContent==='NVDA'); var b=e&&e.querySelector('.nh-earn'); return b?b.textContent:'';`);
  ok('NVDA carries its earnings: tomorrow, after the close', chip === 'Earnings tomorrow · after close', chip);
  ok('…and nobody else gets one', await js(`return document.querySelectorAll('.nh-earn').length===1`));
  const lm = await js(`var e=[...document.querySelectorAll('.nh-ev')].find(a=>a.querySelector('.nh-tk').textContent==='NVDA'); return e.querySelector('.nh-ev-top').innerText.replace(/\\s+/g,' ');`);
  if (PHASE === 'pre') ok('pre-market: the pre move leads', /Pre\s?▼ -0\.58%/.test(lm), lm);
  else ok('today\'s move, then the after-hours move', /▲ \+2\.29%/.test(lm) && /After\s?-0\.58%/.test(lm), lm);
  ok('top movers carry sparklines', await js(`return [...document.querySelectorAll('.nh-mover')].filter(m=>m.querySelector('svg.nh-spark')).length>=2`));
  ok('…and a dot on the one you hold', await js(`var m=[...document.querySelectorAll('.nh-mover')].find(x=>x.querySelector('b').textContent==='NVDA'); return !!(m&&m.querySelector('.nh-held-dot'));`));
  ok('Webull was asked for quotes once…', S.wbMarket === 1, S.wbMarket);
  ok('…and its "no market data" answer is remembered', await js(`return +localStorage.getItem('tb_wb_md_off')>${NOW - 1000}`));
  await js(`var b=[...document.querySelectorAll('.nh-strip .nh-chip')].find(x=>/^Held/.test(x.textContent)); b.click(); 1`);
  ok('the Held filter shows only held stories', await until(`[...document.querySelectorAll('.nh-ev .nh-tk')].map(x=>x.textContent).join()==='NVDA'`, 3000) && await js(`return /Held/.test(document.querySelector('.nh-results').innerText)`));
  await shot('news-market-desktop');
  await js(`document.querySelector('.nh-clear').click(); 1`);
  await js(`document.querySelector('.nh-earn').click(); 1`); await sleep(900);
  ok('the earnings chip opens Catalysts', await js(`return !!document.querySelector('#tradeboard-root .cat-col, #tradeboard-root .cat-card') || /Catalysts/.test(document.querySelector('.tbx-title')?document.querySelector('.tbx-title').textContent:'')`));

  console.log('\n2. The intraday tick');
  await tab('news');
  S.intradayGen = GEN + 45 * 60000;
  const settingsBefore = await js(`return JSON.stringify(__fakeFs.docs['dashboards/tradeboard_news'].settings||null);`);
  await js(`window.tbNewsIntradayTick(true); 1`);
  ok('a newer intraday build reaches Firebase', await until(`(__fakeFs.docs['dashboards/tradeboard_news']||{}).generatedAt===${S.intradayGen}`, 8000));
  ok('…keeping the saved filters', settingsBefore !== 'null' && await js(`return JSON.stringify(__fakeFs.docs['dashboards/tradeboard_news'].settings||null);`) === settingsBefore, settingsBefore);
  ok('…and the News tab shows it', await until(`/hyperscaler deal/.test(document.querySelector('.nh-feed').innerText)`, 5000));
  const writes = await js(`return __fakeFs.log.filter(l=>l.path==='dashboards/tradeboard_news').length`);
  await js(`window.tbNewsIntradayTick(true); 1`); await sleep(1500);
  ok('the same build again writes nothing', await js(`return __fakeFs.log.filter(l=>l.path==='dashboards/tradeboard_news').length`) === writes);

  console.log('\n3. Portfolio ▸ Activity');
  await tab('portfolio');
  // Webull's positions carry no daily change; Day % comes from the live quote.
  ok('Positions: Day % from the live quote, not a fake +0.00%', await until(`[...document.querySelectorAll('#tradeboard-root table tbody tr')].some(r=>r.cells[0].textContent==='NVDA'&&r.cells[7].textContent==='+2.29%')`, 8000),
    await js(`return [...document.querySelectorAll('#tradeboard-root table tbody tr')].map(r=>r.cells[0].textContent+' '+(r.cells[7]||{}).textContent).join();`));
  await js(`var b=[...document.querySelectorAll('#tradeboard-root .ana-chip')].find(x=>/^Activity/.test(x.textContent)); b.click(); 1`);
  ok('it loads Webull\'s cash activity', await until(`document.querySelector('.tb-act-table')`, 8000));
  const tiles = () => js(`return [...document.querySelectorAll('.tb-act-tile')].map(t=>t.innerText.replace(/\\s+/g,' ')).join(' | ')`);
  await js(`[...document.querySelectorAll('.tb-act-bar .tbx-seg button')].find(x=>x.textContent==='1Y').click(); 1`); await sleep(300);
  const t1 = await tiles();
  ok('1Y totals: dividends, net deposits, interest, fees & tax', /Dividends \+\$4\.20/i.test(t1) && /Net deposits \+\$300\.00/i.test(t1) && /Interest \+\$0\.80/i.test(t1) && /Fees & tax -\$0\.35/i.test(t1), t1);
  ok('every row in the table, newest first', await js(`return [...document.querySelectorAll('.tb-act-table tbody tr')].map(r=>r.children[1].textContent).join()==='Interest,Dividend,Deposit,Fee,Withdrawal'`), await js(`return [...document.querySelectorAll('.tb-act-table tbody tr')].map(r=>r.children[1].textContent).join()`));
  await js(`[...document.querySelectorAll('.tb-act-bar .tbx-seg button')].find(x=>x.textContent==='30D').click(); 1`); await sleep(300);
  ok('30D keeps only the last month', await js(`return document.querySelectorAll('.tb-act-table tbody tr').length===2`));
  await js(`[...document.querySelectorAll('.tb-act-tile')].find(x=>/Dividends/.test(x.textContent)).click(); 1`); await sleep(300);
  ok('a total filters to its kind', await js(`return [...document.querySelectorAll('.tb-act-table tbody tr')].map(r=>r.children[2].textContent).join()==='MSFT'`));
  ok('the amounts are signed and coloured', await js(`var a=document.querySelector('.tb-act-table .am'); return a.textContent==='+$4.20' && a.style.color.indexOf('tbb')>=0`));
  await shot('activity-desktop');

  console.log('\n4. Phone');
  await size(390, 844); await sleep(700);
  ok('Activity: a list, not a table, at 390 px', await js(`return !!document.querySelector('.tb-act-list') && !document.querySelector('.tb-act-table')`));
  ok('Activity: the tiles go two by two', await js(`var t=[...document.querySelectorAll('.tb-act-tile')].map(e=>Math.round(e.getBoundingClientRect().top)); return t[0]===t[1]&&t[2]>t[0]`));
  { const sw = await sideways(); ok('Activity: nothing scrolls sideways', !sw, sw); }
  await js(`document.querySelector('.tb-act').scrollIntoView(); 1`); await sleep(300);
  await shot('activity-phone');
  await tab('news'); await sleep(500);
  ok('News: no market value is cut off', await js(`return [...document.querySelectorAll('.nh-mkt-t b, .nh-mkt-t .l')].every(e=>e.scrollWidth<=e.clientWidth+1);`), await js(`return [...document.querySelectorAll('.nh-mkt-t b, .nh-mkt-t .l')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent).join();`));
  ok('News: the market strip goes three across', await js(`var t=[...document.querySelectorAll('.nh-mkt-t')].map(e=>Math.round(e.getBoundingClientRect().top)); return t[0]===t[2]&&t[3]>t[0]`));
  { const sw = await sideways(); ok('News: nothing scrolls sideways', !sw, sw); }
  await js(`var p=document.querySelector('.tb-scroll-visible'); if(p) p.scrollTop=0; 1`); await sleep(300);
  await shot('news-market-phone');
  await size(1440, 1000);

  console.log('\n5. Webull is down');
  S.activityFails = true;
  await js(`window.location.reload(); 1`);
  await until("document.querySelector('.tb-navtab')", 20000);
  await tab('portfolio');
  await js(`var b=[...document.querySelectorAll('#tradeboard-root .ana-chip')].find(x=>/^Activity/.test(x.textContent)); b.click(); 1`);
  ok('Activity says what failed, with a retry', await until(`/did not return account activity/.test((document.querySelector('.tb-act-empty.is-err')||{}).innerText||'') && document.querySelector('.tb-act-empty.is-err button')`, 8000));
  S.activityFails = false;
  await js(`document.querySelector('.tb-act-empty.is-err button').click(); 1`);
  ok('…and the retry loads it', await until(`document.querySelector('.tb-act-table')`, 8000));
  ok('Webull is not asked for quotes again within 6 h', S.wbMarket === 1, S.wbMarket);

  const real = errs.filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|NetworkError|recaptcha|appCheck|App Check|finnhub|workers\.dev/i.test(e));
  ok('no page errors', !real.length, real.join(' | '));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
