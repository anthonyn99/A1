// TradeBoard's Portfolio and Journal (V1/tradeboard.html, Veda's), rebuilt on
// 2026-11-06 to TradeHub's 2026-11-04 layout in her own colours. Real page,
// fake Firestore seeded with a Webull sync (positions, open orders, history,
// cash activity) and a journal. Expect:
//   · Portfolio: header + meta, the market clock card with a live countdown, the
//     six account figures (Total Value first), Account details, four tabs, each
//     table inside a window-height box with a sticky header; Activity's range,
//     tiles and chips filter; an older sync without orders says where they come from
//   · Journal: header with the tool group, the curve beside the stats, the
//     equity table (pill toggle, newest first, best/worst), All/Wins/Losses/Open,
//     rows grouped by day with each day's net
//   · her colours only (accent #8D769A), and nothing wider than a 390px phone
// Screenshots: %TEMP%/magi-live-shots/tbpf-*.png.
// Run: node tests/live/tradeboard-portfolio.live.js   (TB_PAGE_FILE=<copy>)
'use strict';
const fs = require('fs');
process.env.CDP_PORT = process.env.CDP_PORT || '9351';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const URL_ = ORIGIN + '/A1/V1/tradeboard.html';
const TBDOC = 'tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const NOW = Date.now();
const day = (n) => { const d = new Date(NOW - n * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const positions = {
  broker: 'Webull', generated_at: new Date(NOW - 60000).toISOString(), equity: 52000,
  account: { net_liquidation: 52000, buying_power: 18000, cash: 9000, market_value: 43000, day_pnl: 312.5, day_pnl_pct: 0.6, settled_cash: 8800, unsettled_cash: 200 },
  positions: [
    { symbol: 'NVDA', asset: 'stock', qty: 100, avg: 120, last: 190, market_value: 19000, unrealized: 7000, unrealized_pct: 58.3, day_pct: 1.2 },
    { symbol: 'AAPL', asset: 'stock', qty: 80, avg: 230, last: 250, market_value: 20000, unrealized: 1600, unrealized_pct: 8.7 },
    { symbol: 'MU', asset: 'stock', qty: 40, avg: 110, last: 100, market_value: 4000, unrealized: -400, unrealized_pct: -9.1, day_pct: -0.8 },
  ],
  orders: [{ symbol: 'AMD', side: 'BUY', qty: 10, filled: 0, limit_price: 150, order_type: 'LIMIT', tif: 'DAY', status: 'SUBMITTED', placed_at: new Date(NOW - 3600000).toISOString() }],
  history: [
    { symbol: 'TSLA', side: 'BUY', qty: 5, avg_price: 300, fee: 0, status: 'FILLED', filled_at: new Date(NOW - 5 * 86400000).toISOString() },
    { symbol: 'TSLA', side: 'SELL', qty: 5, avg_price: 320, fee: 0.05, status: 'FILLED', filled_at: new Date(NOW - 2 * 86400000).toISOString() },
  ],
  activity: [
    { id: 'a1', type: 'DIVIDENDS', sub: 'CASH_DIVIDEND', symbol: 'AAPL', amount: 20.4, date: day(10), currency: 'USD' },
    { id: 'a2', type: 'DEPOSIT', sub: 'ACH', amount: 1000, date: day(20) },
    { id: 'a3', type: 'FEES', sub: 'ADR_FEE', symbol: 'TSM', amount: -1.2, date: day(4) },
  ],
};
const trades = [
  { id: 't1', date: day(1), symbol: 'NVDA', side: 'long', qty: 10, entry: 180, exit: 190, fees: 0, tags: ['momentum'], notes: '' },
  { id: 't2', date: day(1), symbol: 'MU', side: 'long', qty: 20, entry: 105, exit: 100, fees: 0, tags: [], notes: '' },
  { id: 't3', date: day(3), symbol: 'AAPL', side: 'short', qty: 5, entry: 255, exit: 250, fees: 0, tags: [], notes: 'fade' },
  { id: 't4', date: day(0), symbol: 'AMD', side: 'long', qty: 5, entry: 150, exit: null, fees: 0, tags: [], notes: '' },
];
const SEED = { [TBDOC]: { positions: JSON.stringify(positions), trades: JSON.stringify(trades), rulesDaily: JSON.stringify({ lastCompleted: null, enabled: false }), _updated: NOW } };

(async () => {
  const CTX = [['es', 'S&P fut'], ['nq', 'Nasdaq fut'], ['soxx', 'Semis'], ['tnx', '10Y'], ['cl', 'WTI'], ['bz', 'Brent'], ['vix', 'VIX'], ['dxy', 'Dollar']]
    .map(([key, label], i) => ({ key, label, sym: key.toUpperCase(), price: 100 + i, dp: i % 2 ? -0.4 : 0.6, unit: key === 'tnx' ? '%' : '', points: [1, 2, 1.5, 3, 2.5] }));
  const EV = [{ id: 'n1', primaryTicker: 'NVDA', ts: NOW - 600000, summary: 'Nvidia beats.', sources: [{ name: 'Reuters', headline: 'Nvidia beats', url: 'https://example.com', ts: NOW - 600000 }],
    impact: { tier: 'major', score: 70 }, sentiment: { label: 'bull', score: 0.5 }, eventType: 'earnings', sectors: ['Semis'], aiAnalyzed: true }];
  const c = await connect({ mock: firebaseMock({ patterns: ['https://tradeboard-news.vedapatel05.workers.dev/*'], handle: (req) => {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = new global.URL(req.url);
    if (u.pathname === '/market') return { json: { ok: true, context: CTX, stocks: {}, asOf: NOW } };
    if (u.pathname === '/news') return { json: { events: EV, generatedAt: NOW, watchlist: ['NVDA', 'AAPL', 'MU'] } };
    return { json: { ok: true } };
  } }) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 100; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(100); } return false; };
  const shot = async (n) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(shotPath('tbpf-' + n), Buffer.from(r.result.data, 'base64')); };

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(SEED))}); 1`);
  await c.send('Page.navigate', { url: URL_ });
  if (!(await until(`typeof TB !== 'undefined' && TB.pf && window._tbCloudSeen`, 15000))) { console.log('TradeBoard did not open'); process.exit(1); }
  await js(`TB.showSection('portfolio'); 1`);
  await until(`document.querySelector('#pf-hero .hero')`, 6000);
  await sleep(1200);

  console.log('\nPortfolio');
  ok('header and meta line', await js(`return document.querySelector('#view-portfolio .tbp-head h2').textContent === 'Portfolio' && /Synced/.test(document.getElementById('pf-meta').textContent);`), await js(`return document.getElementById('pf-meta').textContent;`));
  ok('the market clock card with a ticking countdown', await js(`return /OPEN|PRE-MARKET|AFTER HOURS|CLOSED/.test(document.querySelector('.tbmk-lbl').textContent) && /\\d/.test(document.getElementById('pf-mkt-cd').textContent);`));
  ok('…and upcoming market holidays', await js(`return document.querySelectorAll('.tbmk-hol .tag').length >= 1;`));
  ok('six account figures, Total Value first', await js(`var f=document.querySelectorAll('#pf-hero > div'); return f.length===6 && f[0].classList.contains('hero') && /Total Value/.test(f[0].textContent) && /52,000/.test(f[0].textContent);`));
  // From the Journal's round trips closed in the last 30 days (NVDA +100, MU -100,
  // the AAPL short +25), not the 30-day order history, which dropped shorts and
  // read TradeHub +$180 for a real +$19 (2026-11-09).
  ok('Realized P&L = the journal\'s closes in the last 30 days, shorts included', await js(`return /\\+\\$25\\.00/.test(document.querySelectorAll('#pf-hero > div')[5].textContent);`), await js(`return document.querySelectorAll('#pf-hero > div')[5].textContent;`));
  ok('…and the history fallback books a short and its cover', await js(`return Math.abs(TB.pf._realizedFromHistory([{symbol:'S',side:'SHORT',qty:1,avg_price:100,status:'FILLED',filled_at:'2026-11-01T15:00:00Z'},{symbol:'S',side:'BUY',qty:1,avg_price:90,status:'FILLED',filled_at:'2026-11-02T15:00:00Z'},{symbol:'S',side:'BUY',qty:1,avg_price:95,status:'FILLED',filled_at:'2026-11-03T15:00:00Z'},{symbol:'S',side:'SELL',qty:1,avg_price:96,status:'FILLED',filled_at:'2026-11-04T15:00:00Z'}]) - 11) < 1e-9;`));

  console.log('\nDisplay mode');
  const blurred = (sel) => js(`var e=document.querySelector(${JSON.stringify(sel)}); return !!e && /blur/.test(getComputedStyle(e).filter);`);
  ok('an eye button sits left of the lock', await js(`var e=document.getElementById('tb-display-btn'), l=document.getElementById('lock-now-btn'); return !!e && !!e.querySelector('svg') && e.nextElementSibling===l && e.getAttribute('aria-pressed')==='false';`));
  ok('off by default: nothing blurred', !(await blurred('#pf-hero .hero .v')));
  await js(`document.getElementById('tb-display-btn').click(); 1`); await sleep(200);
  ok('on: the account figures blur', await blurred('#pf-hero .hero .v') && await blurred('#pf-hero > div:nth-child(6) .v'));
  ok('on: qty, avg cost, value and P&L blur; Last and the stock\'s Day % stay readable',
    await blurred('.tbt-pos tbody td:nth-child(2)') && await blurred('.tbt-pos tbody td:nth-child(3)') && await blurred('.tbt-pos tbody td:nth-child(5)') && await blurred('.tbt-pos tbody td:nth-child(6)')
    && !(await blurred('.tbt-pos tbody td:nth-child(4)')) && !(await blurred('.tbt-pos tbody td:nth-child(7)')) && !(await blurred('.tbt-pos tbody td.sym')));
  ok('on: remembered on this device, button shows it', await js(`return localStorage.getItem('tradeboard_display_mode')==='1' && document.getElementById('tb-display-btn').getAttribute('aria-pressed')==='true' && document.getElementById('tb-display-btn').classList.contains('dm-on');`));
  await js(`TB.showSection('journal'); 1`); await sleep(400);
  ok('on: journal stats, P&L, entry/exit and day nets blur; symbols do not',
    await blurred('#jr-stats .t-val') && await blurred('#jr-body tr[data-id] td:nth-child(8)') && await blurred('#jr-body tr[data-id] td:nth-child(6)') && await blurred('#jr-body .jr-day b') && !(await blurred('#jr-body tr[data-id] td.sym')));
  await shot('display-mode');
  await js(`document.getElementById('tb-display-btn').click(); TB.showSection('portfolio'); 1`); await sleep(200);
  ok('off again: figures readable', !(await blurred('#pf-hero .hero .v')) && await js(`return localStorage.getItem('tradeboard_display_mode')==='0';`));
  console.log('\nPortfolio tabs');
  ok('Account details lists the extra figures', await js(`return /3 figures/.test(document.querySelector('.tbdet summary').textContent);`));
  ok('four tabs with counts', await js(`var b=[].map.call(document.querySelectorAll('#pf-tabs button'),x=>x.textContent); return b.length===4 && b[0]==='Positions3' && b[1]==='Open Orders1' && b[2]==='History2' && b[3]==='Activity';`), await js(`return [].map.call(document.querySelectorAll('#pf-tabs button'),x=>x.textContent).join('|');`));
  ok('positions: weight bars, day %, a totals row', await js(`return document.querySelectorAll('.tbt-pos tbody tr').length===3 && document.querySelectorAll('.tbt-w i b').length===3 && /\\+1\\.20%/.test(document.querySelector('.tbt-pos tbody').textContent) && !!document.querySelector('.tbt-pos tfoot');`));
  ok('the table scrolls inside a window-height box with a sticky header', await js(`var f=document.querySelector('#view-portfolio .tb-fit'); return !!f && parseInt(f.style.maxHeight)>=240 && getComputedStyle(document.querySelector('.tbt th')).position==='sticky';`), await js(`var f=document.querySelector('#view-portfolio .tb-fit'); return f && f.style.maxHeight;`));
  ok('her colours: the hero wears her accent', await js(`return getComputedStyle(document.querySelector('#pf-hero .hero')).borderTopColor;`) === 'rgb(141, 118, 154)');
  await shot('portfolio');
  await js(`TB.pf.setTab('orders'); 1`);
  ok('open orders', await js(`return /AMD/.test(document.querySelector('#pf-tab-host').textContent) && /\\$150\\.00/.test(document.querySelector('#pf-tab-host').textContent);`));
  await js(`TB.pf.setTab('history'); 1`);
  ok('history with fees', await js(`return document.querySelectorAll('#pf-tab-host tbody tr').length===2 && /\\$0\\.05/.test(document.querySelector('#pf-tab-host').textContent);`));
  await js(`TB.pf.setTab('activity'); TB.pf.setActRange('90'); 1`);
  ok('activity: tiles total each kind', await js(`var t=[].map.call(document.querySelectorAll('.tb-act-tile b'),x=>x.textContent); return t[0]==='+$20.40' && t[1]==='+$1,000.00' && t[3]==='-$1.20';`), await js(`return [].map.call(document.querySelectorAll('.tb-act-tile b'),x=>x.textContent).join('|');`));
  await js(`TB.pf.setActGroup('div'); 1`);
  ok('a tile filters the list', await js(`return document.querySelectorAll('.tb-act-table tbody tr').length===1;`));
  await shot('activity');
  await js(`TB.pf.setActGroup('div'); TB.pf.setTab('positions'); 1`);

  console.log('\nJournal');
  await js(`TB.showSection('journal'); 1`);
  await sleep(600);
  ok('header with the tool group', await js(`return document.querySelector('#view-journal .tbp-head h2').textContent==='Journal' && document.querySelectorAll('#view-journal .tbp-tools button').length===3;`));
  ok('the curve beside the stats', await js(`var a=document.querySelector('.tbj-top .curve-card').getBoundingClientRect(), b=document.getElementById('jr-stats').getBoundingClientRect(); return b.left>a.right-1 && Math.abs(a.top-b.top)<4;`));
  ok('All / Wins / Losses / Open', await js(`return [].map.call(document.querySelectorAll('#jr-seg button'),x=>x.textContent).join()==='All,Wins,Losses,Open';`));
  ok('rows grouped by day, each with its net', await js(`var d=document.querySelectorAll('#jr-body .jr-day'); return d.length===3 && /\\+\\$0\\.00|net/.test(d[1].textContent);`), await js(`return [].map.call(document.querySelectorAll('#jr-body .jr-day'),x=>x.textContent).join(' | ');`));
  await js(`TB.jr.setResult('loss'); 1`);
  ok('Losses shows the losing trade only', await js(`return document.querySelectorAll('#jr-body tr[data-id]').length===1 && document.getElementById('jr-shown').textContent==='1 trade';`));
  await js(`TB.jr.setResult('all'); document.querySelector('.tb-eq-tog').click(); 1`);
  ok('the equity table: newest first, chips, best/worst footer', await js(`var r=document.querySelectorAll('.tb-eq-tbl tbody tr'); return r.length===3 && !!document.querySelector('.tb-eq-chip.up') && /Best/.test(document.querySelector('.tb-eq-foot').textContent) && /Worst/.test(document.querySelector('.tb-eq-foot').textContent);`));
  await shot('journal');

  console.log('\nA sync from before orders/history/activity');
  await js(`var d=TB.pf.data(); delete d.orders; delete d.history; delete d.activity; TBStore.set(TBStore.KEYS.positions, d); TB.showSection('portfolio'); TB.pf.setTab('orders'); 1`);
  ok('says they arrive with the PC sync', await js(`return /appear after your PC's Webull sync/.test(document.getElementById('pf-tab-host').textContent);`));
  await js(`TB.pf.setTab('positions'); 1`);

  console.log('\nPhone (390px)');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700); await js(`TB.pf.render(); 1`); await sleep(300);
  const wide = (sec) => js(`var W=innerWidth,bad=[]; document.querySelectorAll('#${sec} *').forEach(function(el){ if(el.closest('.tb-fit,.tb-eq-scroll,.table-wrap')) return; var r=el.getBoundingClientRect(); if(r.width&&(r.right>W+1)) bad.push((el.className||el.tagName)+':'+Math.round(r.right)); }); return bad.slice(0,5).join(',');`);
  ok('Portfolio fits a phone', !(await wide('view-portfolio')), await wide('view-portfolio'));
  ok('positions as cards on a phone', await js(`return getComputedStyle(document.querySelector('.pf-m')).display==='block';`));
  await shot('phone-portfolio');
  await js(`TB.showSection('journal'); 1`); await sleep(400);
  ok('Journal fits a phone', !(await wide('view-journal')), await wide('view-journal'));
  await shot('phone-journal');

  console.log('\nNews (desktop)');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await js(`TB.showSection('news'); 1`);
  ok('the market strip: eight tiles with a move and a sparkline', await until(`document.querySelectorAll('.nh-mkt-t').length===8 && document.querySelectorAll('.nh-mkt .nh-spark').length===8`, 8000), await js(`return document.querySelectorAll('.nh-mkt-t').length;`));
  ok('four by two', await js(`var t=document.querySelectorAll('.nh-mkt-t'); return Math.abs(t[0].getBoundingClientRect().top-t[3].getBoundingClientRect().top)<2 && t[4].getBoundingClientRect().top>t[0].getBoundingClientRect().bottom-1;`));
  ok('a story about a ticker she holds says Held', await until(`document.querySelector('.nh-ev .nh-held')`, 6000), await js(`return document.querySelectorAll('.nh-ev').length + ' cards';`));
  await shot('news');

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  try { c.ws.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
