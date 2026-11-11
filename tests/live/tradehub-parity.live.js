// TradeHub ⇄ TradeBoard parity (2026-11-09). What TradeHub got from Veda's
// TradeBoard that day, on the real tradehub.html (TH_PAGE_FILE serves a copy)
// with a fake Firestore and fake workers:
//   · Journal stats: Expectancy beside the win rate, wins, losses, open and
//     profit factor, two across as before (largest win/loss and the streak
//     were dropped the same day); display mode: nothing blurred is green/red
//   · Journal filters: Side (Long/Short) and Source (Webull/Manual/CSV), with
//     Clear
// Screenshots: %TEMP%/magi-live-shots/thpar-*.png.
// Run: node tests/live/tradehub-parity.live.js   (TH_PAGE_FILE=<copy>)
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
    if (p === '/api/portfolio/summary') return { json: { ok: true, data: { account: { totalValue: 1000 }, positions: [], orders: [], history: [], activities: [], errors: {} } } };
    if (p === '/api/journal/sync') return { json: { ok: true, data: [], feesRemaining: 0 } };
    if (p === '/news') return { json: { events: [], generatedAt: NOW } };
    return { json: { ok: true } };
  },
};
const leg = (id, action, dt, qty, price) => ({ id, action, datetime: dt, qty: String(qty), price: String(price), fee: '0' });
// Oldest to newest close: AMD +100 (webull), MU −50 (csv), TSLA short +30 (manual), NVDA +20 (webull) → streak 2 W.
const JOURNAL = { savedAt: NOW - 86400000,
  t_a: { id: 'a', source: 'webull', ticker: 'AMD', createdAt: NOW - 9e8, status: 'CLOSED', legs: [leg('a1', 'BUY', '2026-10-01T10:00', 10, 100), leg('a2', 'SELL', '2026-10-02T10:00', 10, 110)] },
  t_b: { id: 'b', source: 'csv', ticker: 'MU', createdAt: NOW - 8e8, status: 'CLOSED', legs: [leg('b1', 'BUY', '2026-10-05T10:00', 10, 100), leg('b2', 'SELL', '2026-10-06T10:00', 10, 95)] },
  t_c: { id: 'c', source: 'manual', ticker: 'TSLA', createdAt: NOW - 7e8, status: 'CLOSED', direction: 'SHORT', legs: [leg('c1', 'SHORT', '2026-10-08T10:00', 3, 200), leg('c2', 'BUY', '2026-10-09T10:00', 3, 190)] },
  t_d: { id: 'd', source: 'webull', ticker: 'NVDA', createdAt: NOW - 6e8, status: 'CLOSED', legs: [leg('d1', 'BUY', '2026-10-12T10:00', 2, 100), leg('d2', 'SELL', '2026-10-13T10:00', 2, 110)] },
};

(async () => {
  const c = await connect({ mock: firebaseMock(worker) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  const shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotPath('thpar-' + name), Buffer.from(r.result.data, 'base64')); };
  const nav = (id) => js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(b=>b.offsetParent); t&&t.click(); return 1;`);

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
    localStorage.setItem('td6_mainDash','tony');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/tradeboard_journal': ${JSON.stringify(JOURNAL)} })); return 1;`);
  await c.send('Page.navigate', { url: URL_ });
  if (!(await until("document.querySelector('.tb-navtab')", 20000))) { console.log('TradeHub did not render'); process.exit(1); }
  await sleep(600);
  await nav('journal');
  await until(`document.querySelectorAll('.tbf-j > *').length >= 6`, 10000);

  console.log('\nJournal stats');
  const cell = (label) => js(`var c=[...document.querySelectorAll('.tbf-j > *')].find(x=>(x.querySelector('.k')||{}).textContent===${JSON.stringify(label)}); return c ? c.querySelector('.v').textContent : null;`);
  ok('six figures: win rate, wins, losses, open, profit factor, expectancy (no largest win/loss, no streak)',
    await js(`return [...document.querySelectorAll('.tbf-j > * .k')].map(x=>x.textContent).join('|');`) === 'Win rate|Wins|Losses|Open|Profit factor|Expectancy',
    await js(`return [...document.querySelectorAll('.tbf-j > * .k')].map(x=>x.textContent).join('|');`));
  ok('Expectancy = net ÷ closed (+100 −50 +30 +20 = +100 over 4 → $25.00)', /\$25\.00/.test(await cell('Expectancy') || ''), await cell('Expectancy'));
  ok('two across on desktop, as before; Expectancy takes the last row whole', await js(`var g=document.querySelector('.tbf-j'); var e=[...g.children].pop(); return getComputedStyle(g).gridTemplateColumns.split(' ').length===2 && e.getBoundingClientRect().width > g.getBoundingClientRect().width*0.9;`));
  ok('the stats card is no taller than the curve beside it', await js(`var s=document.querySelector('.tbf-j').getBoundingClientRect(), t=document.querySelector('.tbj-top > .tb-card').getBoundingClientRect(); return s.height <= t.height + 2;`),
    await js(`return document.querySelector('.tbf-j').getBoundingClientRect().height+' vs '+document.querySelector('.tbj-top > .tb-card').getBoundingClientRect().height;`));
  await shot('journal');

  console.log('\nJournal filters');
  const rows = () => js(`return [...document.querySelectorAll('.tbt-card tbody tr')].filter(r=>!r.classList.contains('tbj-dayrow')&&r.querySelector('td.side')).map(r=>r.querySelector('.tbj-tk,.tk,td:nth-child(2)').textContent.trim()).join(',');`);
  const setSel = (label, v) => js(`var s=document.querySelector('select[aria-label="${label}"]'); var set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,'${v}'); s.dispatchEvent(new Event('change',{bubbles:true})); return 1;`);
  ok('Side and Source dropdowns sit in the bar', await js(`return !!document.querySelector('.tbj-bar select[aria-label="Side"]') && !!document.querySelector('.tbj-bar select[aria-label="Source"]');`));
  ok('all four trades to start', (await js(`return document.querySelector('.tbj-count').textContent;`)) === '4 trades');
  await setSel('Side', 'short'); await sleep(300);
  ok('Side: Short → the TSLA short only', (await js(`return document.querySelector('.tbj-count').textContent;`)) === '1 trade' && /TSLA/.test(await js(`return document.querySelector('.tbt-card tbody').textContent;`)));
  await setSel('Side', 'all'); await setSel('Source', 'webull'); await sleep(300);
  ok('Source: Webull → AMD and NVDA', (await js(`return document.querySelector('.tbj-count').textContent;`)) === '2 trades' && await js(`var t=document.querySelector('.tbt-card tbody').textContent; return /AMD/.test(t)&&/NVDA/.test(t)&&!/TSLA/.test(t)&&!/MU/.test(t);`));
  await setSel('Source', 'csv'); await sleep(300);
  ok('Source: CSV → MU', (await js(`return document.querySelector('.tbj-count').textContent;`)) === '1 trade' && /MU/.test(await js(`return document.querySelector('.tbt-card tbody').textContent;`)));
  ok('a Clear button appears with a filter on', await js(`return !!document.querySelector('.tbj-clear');`));
  await js(`document.querySelector('.tbj-clear').click(); return 1;`); await sleep(300);
  ok('Clear brings every trade back and hides itself', (await js(`return document.querySelector('.tbj-count').textContent;`)) === '4 trades' && !(await js(`return !!document.querySelector('.tbj-clear');`)));

  console.log('\nDisplay mode');
  await js(`var b=[...document.querySelectorAll('[aria-label="Display mode"]')].find(x=>x.offsetParent); b.click(); return 1;`); await sleep(300);
  // Since 2026-11-10 the blur is a text-shadow in the text colour over
  // transparent glyphs (no filter: it lagged scroll), as tradehub-display-mode pins.
  // Nothing under the blur may say win or loss by its colour (2026-11-09).
  const textCol = `(function(){var t=document.createElement('span'); t.style.color='var(--tx)'; document.querySelector('#tradeboard-root').appendChild(t); var w=getComputedStyle(t).color; t.remove(); return w;})()`;
  const blurredIn = `function(e,want){var cs=getComputedStyle(e); return cs.color==='rgba(0, 0, 0, 0)' && cs.textShadow.indexOf(want)===0;}`;
  ok('Expectancy blurs too', await js(`var want=${textCol}, isB=${blurredIn}; var c=[...document.querySelectorAll('.tbf-j > *')].find(x=>(x.querySelector('.k')||{}).textContent==='Expectancy'); var v=c&&c.querySelector('.tb-money'); return !!v && isB(v,want);`));
  ok('no blurred figure is green or red: each blurs in the text colour', await js(`var want=${textCol}, isB=${blurredIn}; return [...document.querySelectorAll('#tradeboard-root .tb-money')].filter(e=>e.offsetParent&&e.tagName!=='INPUT'&&e.textContent.trim()).every(e=>isB(e,want));`),
    await js(`var want=${textCol}, isB=${blurredIn}; return want+' vs '+[...document.querySelectorAll('#tradeboard-root .tb-money')].filter(e=>e.offsetParent&&e.tagName!=='INPUT'&&e.textContent.trim()&&!isB(e,want)).slice(0,4).map(e=>e.textContent+':'+getComputedStyle(e).color+' / '+getComputedStyle(e).textShadow).join(', ');`));
  ok('Win / Loss results blur and lose their colour', await js(`var want=${textCol}, isB=${blurredIn}; var r=[...document.querySelectorAll('.tbj-st')].filter(e=>/^(win|loss)$/i.test(e.textContent)); return r.length===4 && r.every(e=>isB(e,want));`));
  ok('the win-rate bar is one grey, not green and red', await js(`var b=[...document.querySelectorAll('.tbf-split b')]; return b.length===2 && getComputedStyle(b[0]).backgroundColor===getComputedStyle(b[1]).backgroundColor;`));
  await shot('journal-display');
  await js(`var b=[...document.querySelectorAll('[aria-label="Display mode"]')].find(x=>x.offsetParent); b.click(); return 1;`); await sleep(200);
  ok('display mode off: the colours are back', await js(`var r=[...document.querySelectorAll('.tbj-st')].find(e=>/^loss$/i.test(e.textContent)); return !!r && getComputedStyle(r).color!==${textCol};`));

  console.log('\nPhone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  ok('two across on a phone, nothing scrolls sideways', await js(`return getComputedStyle(document.querySelector('.tbf-j')).gridTemplateColumns.split(' ').length===2 && document.documentElement.scrollWidth<=391;`),
    await js(`return getComputedStyle(document.querySelector('.tbf-j')).gridTemplateColumns + ' / ' + document.documentElement.scrollWidth;`));
  await shot('journal-phone');

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
