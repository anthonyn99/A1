// TradeBoard ⇄ TradeHub parity (2026-11-09). What Veda's TradeBoard got from
// TradeHub that day, on the real page (V1/tradeboard.html) with a fake Firestore
// and a fake tradeboard-news worker that records every request:
//   · Journal: the curve's ranges (1M…All) re-base it, dates under it, a hover
//     tooltip; display mode hides the curve, its table, dates and tooltip; a
//     Hold column from the sync's entry date (`entryDate`)
//   · Portfolio: Day % from the live quote when Webull sends none
//   · News: movers lead with Pre before the open, show After and a sparkline,
//     and a dot on a held ticker; cards show Pre/After; a story is Held when any
//     of its tickers is held; the Held chip filters, Held stories come first in
//     Impact order; the intraday tick asks /news?intraday=1; a raw build is
//     retried once with a fresh build, never twice for the same build
// Screenshots: %TEMP%/magi-live-shots/tbpar-*.png.
// Run: node tests/live/tradeboard-parity.live.js   (TB_PAGE_FILE=<copy>)
'use strict';
const fs = require('fs');
process.env.CDP_PORT = process.env.CDP_PORT || '9352';
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
  broker: 'Webull', generated_at: new Date(NOW - 60000).toISOString(), equity: 30000,
  account: { net_liquidation: 30000, buying_power: 9000, cash: 5000, market_value: 25000 },
  positions: [
    { symbol: 'AMD', asset: 'stock', qty: 50, avg: 150, last: 160, market_value: 8000, unrealized: 500, unrealized_pct: 6.6 },   // no day_pct from Webull
    { symbol: 'MU', asset: 'stock', qty: 40, avg: 110, last: 100, market_value: 4000, unrealized: -400, unrealized_pct: -9.1, day_pct: -0.8 },
  ],
};
const trades = [
  { id: 't1', date: day(200), symbol: 'TSLA', side: 'long', qty: 10, entry: 100, exit: 110, fees: 0, tags: ['webull'], notes: '', entryDate: day(203) },
  { id: 't2', date: day(10), symbol: 'NVDA', side: 'long', qty: 10, entry: 180, exit: 190, fees: 0, tags: ['webull'], notes: '', entryDate: day(15) },
  { id: 't3', date: day(2), symbol: 'MU', side: 'long', qty: 20, entry: 105, exit: 100, fees: 0, tags: [], notes: '' },
  // A sync trade with fill times (wb_sync.py since 2026-11-09): 45 minutes held.
  { id: 't5', date: day(2), symbol: 'AMD', side: 'long', qty: 4, entry: 150, exit: 155, fees: 0, tags: ['webull', 'scalp'], notes: '', entryDate: day(2),
    entryTime: new Date(NOW - 2 * 86400000 - 3 * 3600000).toISOString(), exitTime: new Date(NOW - 2 * 86400000 - 3 * 3600000 + 45 * 60000).toISOString() },
];
const SEED = { [TBDOC]: { positions: JSON.stringify(positions), trades: JSON.stringify(trades), rulesDaily: JSON.stringify({ lastCompleted: null, enabled: false }),
  watchlist: JSON.stringify(['NVDA', 'AMD', 'MU']), _updated: NOW } };

const src = (h, n) => ({ name: n, headline: h, url: 'https://example.com/' + encodeURIComponent(h), ts: NOW - 600000 });
const EV = [
  { id: 'n1', primaryTicker: 'NVDA', additionalTickers: ['AMD'], ts: NOW - 2 * 3600000, summary: 'Nvidia and AMD sign a deal.', sources: [src('Deal', 'Reuters')],
    impact: { tier: 'major', score: 60 }, sentiment: { label: 'bull', score: 0.5 }, eventType: 'other', sectors: ['Semis'], aiAnalyzed: true },
  { id: 'n2', primaryTicker: 'NVDA', ts: NOW - 3 * 3600000, summary: 'Nvidia raises guidance.', sources: [src('Guide', 'CNBC')],
    impact: { tier: 'critical', score: 90 }, sentiment: { label: 'bull', score: 0.7 }, eventType: 'earnings', sectors: ['Semis'], aiAnalyzed: true },
];
let GEN = NOW - 60000, RAW = false;
const calls = [];

(async () => {
  const c = await connect({ mock: firebaseMock({ patterns: ['https://tradeboard-news.vedapatel05.workers.dev/*'], handle: (req) => {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const u = new global.URL(req.url);
    calls.push(u.pathname + u.search);
    if (u.pathname === '/market') return { json: { ok: true, context: [], asOf: NOW, stocks: {
      NVDA: { c: 190, dp: 2.5, ext: { kind: 'post', price: 191, dp: 0.53 }, points: [1, 2, 3, 2.5, 4] },
      AMD: { c: 160, dp: -1.25, ext: null, points: [3, 2, 2.5, 1] },
    } } };
    if (u.pathname === '/quotes') return { json: { ok: true, quotes: { MU: { c: 100, dp: -0.9 } }, asOf: NOW } };
    if (u.pathname === '/news') {
      const evs = RAW ? EV.map(e => ({ ...e, aiAnalyzed: false })) : EV;
      return { json: { events: evs, generatedAt: GEN, degraded: false } };
    }
    if (u.pathname === '/rate-status') return { json: { usedToday: 1, cooldownSec: 0 } };
    return { json: { ok: true } };
  } }) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 100; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(100); } return false; };
  const shot = async (n) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); if (r.result && r.result.data) fs.writeFileSync(shotPath('tbpar-' + n), Buffer.from(r.result.data, 'base64')); };

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(SEED))}); 1`);
  await c.send('Page.navigate', { url: URL_ });
  if (!(await until(`typeof TB !== 'undefined' && TB.pf && window._tbCloudSeen`, 15000))) { console.log('TradeBoard did not open'); process.exit(1); }

  console.log('\nJournal');
  await js(`TB.showSection('journal'); 1`);
  await until(`document.querySelector('#curve-svg')`, 6000);
  const meta = () => js(`return document.getElementById('jr-curve-meta').textContent;`);
  ok('range chips: 1M 3M 6M YTD 1Y All, All selected', await js(`var b=[...document.querySelectorAll('#jr-curve-range button')]; return b.map(x=>x.textContent).join(' ')==='1M 3M 6M YTD 1Y All' && b[5].classList.contains('on');`));
  ok('All: every close (4)', /over 4 closed/.test(await meta()), await meta());
  await js(`[...document.querySelectorAll('#jr-curve-range button')].find(b=>b.textContent==='1M').click(); 1`); await sleep(150);
  ok('1M: only the last month, re-based (NVDA +100, MU −100, AMD +20 → +$20.00 over 3)', /\+\$20\.00/.test(await meta()) && /over 3 closed/.test(await meta()), await meta());
  ok('the tooltip is not shown until the curve is hovered', await js(`var t=document.querySelector('.jr-curve-tip'), d=document.querySelector('.jr-curve-dot'); return !!t && getComputedStyle(t).display==='none' && getComputedStyle(d).display==='none';`));
  ok('dates sit under the curve', await js(`var d=document.querySelectorAll('.jr-curve-dates span'); return d.length===2 && /\\w{3} \\d+/.test(d[0].textContent);`));
  await js(`var s=document.getElementById('curve-svg').getBoundingClientRect(); document.getElementById('curve-svg').dispatchEvent(new MouseEvent('mousemove',{clientX:s.right-2,clientY:s.top+20,bubbles:true})); 1`);
  ok('hover shows the nearest trade: equity, date · symbol, trade P&L', await js(`var t=document.querySelector('.jr-curve-tip'); return !!t && !t.hidden && /AMD/.test(t.textContent) && /trade \\+\\$20\\.00/.test(t.textContent);`), await js(`var t=document.querySelector('.jr-curve-tip'); return t&&t.textContent;`));
  await js(`[...document.querySelectorAll('#jr-curve-range button')].find(b=>b.textContent==='All').click(); 1`); await sleep(150);
  ok('Hold column: entry to exit in days, "—" without an entry date', await js(`var h=[...document.querySelectorAll('#view-journal thead th')].findIndex(x=>x.textContent==='Hold'); if(h<0) return false; var cell=id=>document.querySelector('#jr-body tr[data-id="'+id+'"]').children[h].textContent; return cell('t2')==='5 days' && cell('t1')==='3 days' && cell('t3')==='—';`),
    await js(`var h=[...document.querySelectorAll('#view-journal thead th')].findIndex(x=>x.textContent==='Hold'); return h+' '+[...document.querySelectorAll('#jr-body tr[data-id]')].map(r=>r.dataset.id+':'+(r.children[h]||{}).textContent).join(',');`));
  ok('the sync\'s _entry_date is kept as entryDate by normalize', await js(`return TB.jr.normalize({symbol:'X',qty:1,entry:1,exit:2,date:'2026-11-05',_entry_date:'2026-11-01'}).entryDate==='2026-11-01' && !('entryDate' in TB.jr.normalize({symbol:'X',qty:1,entry:1}));`));
  ok('a trade that only gained an entry date still counts as changed (mergeBroker)', await js(`var keep=TB.jr.trades.slice(); TB.jr.trades=[{id:'z',date:'2026-11-05',symbol:'X',side:'long',qty:1,entry:1,exit:2,fees:0,tags:['webull'],notes:''}]; var r=TB.jr.mergeBroker([{date:'2026-11-05',symbol:'X',side:'long',qty:1,entry:1,exit:2,fees:0,tags:['webull'],notes:'',entryDate:'2026-11-01'}]); var got=TB.jr.trades[0].entryDate; TB.jr.trades=keep; TB.jr.save(); TB.jr.render(); return r.changed===true && got==='2026-11-01';`));
  // TradeHub's columns, identical (2026-11-09).
  ok('the journal columns are TradeHub\'s: Time … Src', await js(`return [...document.querySelectorAll('#view-journal thead th')].map(x=>x.textContent.trim()).filter(Boolean).join('|');`)
    === 'Time|Symbol|Result|Side|Qty|Entry|Exit|Ent Tot|Ext Tot|Hold|Realized P&L|P&L %|Setup|Notes|Src',
    await js(`return [...document.querySelectorAll('#view-journal thead th')].map(x=>x.textContent.trim()).filter(Boolean).join('|');`));
  const row = (id) => js(`var hs=[...document.querySelectorAll('#view-journal thead th')].map(x=>x.textContent.trim()); var r=document.querySelector('#jr-body tr[data-id="${id}"]'); var o={}; hs.forEach((h,i)=>{ if(h) o[h]=r.children[i].textContent.trim(); }); return o;`);
  const r5 = await row('t5'), r3 = await row('t3');
  ok('a synced trade with fill times: its close time, Hold 45 min', /\d{1,2}:\d{2}\s?(AM|PM)/.test(r5.Time) && r5.Hold === '45 min', JSON.stringify(r5));
  ok('…Result Win, Ent Tot / Ext Tot = price × qty, Realized P&L, P&L %, Setup without the webull tag, Src W',
    r5.Result === 'Win' && r5['Ent Tot'] === '$600.00' && r5['Ext Tot'] === '$620.00' && r5['Realized P&L'] === '+$20.00' && r5['P&L %'] === '+3.33%' && r5.Setup === 'scalp' && r5.Src === 'W', JSON.stringify(r5));
  ok('a trade logged by date only: Time "—", Result Loss, Src M', r3.Time === '—' && r3.Result === 'Loss' && r3.Src === 'M', JSON.stringify(r3));
  ok('minute-level hold: 45 min, 3 hr, 2 days', await js(`var h=t=>TB.jr.holdLabel(Object.assign({exit:1,entry:1,qty:1},t)); var a='2026-11-05T14:00:00Z'; return h({entryTime:a,exitTime:'2026-11-05T14:45:00Z'})==='45 min' && h({entryTime:a,exitTime:'2026-11-05T17:00:00Z'})==='3 hr' && h({entryTime:a,exitTime:'2026-11-07T14:00:00Z'})==='2 days' && h({entryTime:a,exitTime:'2026-11-06T14:00:00Z'})==='1 day';`));
  ok('the sync\'s fill times are kept by normalize and count as a change in mergeBroker', await js(`var n=TB.jr.normalize({symbol:'X',qty:1,entry:1,exit:2,date:'2026-11-05',tags:['webull'],entryTime:'2026-11-05T14:00:00Z',exitTime:'2026-11-05T15:00:00Z'}); var keep=TB.jr.trades.slice(); TB.jr.trades=[{id:'z',date:'2026-11-05',symbol:'X',side:'long',qty:1,entry:1,exit:2,fees:0,tags:['webull'],notes:''}]; var r=TB.jr.mergeBroker([Object.assign({tags:['webull'],side:'long',fees:0,notes:''},n)]); var got=TB.jr.trades[0].exitTime; TB.jr.trades=keep; TB.jr.save(); TB.jr.render(); return n.entryTime==='2026-11-05T14:00:00Z' && r.changed===true && got==='2026-11-05T15:00:00Z';`));
  // The Manual trade form's Save was also named save(), replacing the journal's
  // own: nothing was stored, and logging a trade re-entered itself.
  const stored = () => js(`return (TBStore.get(TBStore.KEYS.trades, []) || []).length;`);
  const n0 = await stored();
  await js(`TB.jr.openAdd(); var v=(id,x)=>{document.getElementById(id).value=x;}; v('jr-f-symbol','PLTR'); v('jr-f-qty','3'); v('jr-f-entry','40'); v('jr-f-exit','44'); v('jr-f-opened','2026-11-05T09:30'); v('jr-f-closed','2026-11-05T11:00'); TB.jr.saveForm(); 1`); await sleep(200);
  ok('Manual trade: logging one adds exactly ONE trade, and it is stored', await stored() === n0 + 1 && await js(`return TB.jr.trades.filter(t=>t.symbol==='PLTR').length===1;`), (await stored()) + ' vs ' + n0);
  ok('…with its times: 90 minutes held reads 2 hr (TradeHub rounds hours), day = the close day', await js(`var t=TB.jr.trades.find(t=>t.symbol==='PLTR'); return t.date==='2026-11-05' && !!t.entryTime && !!t.exitTime && TB.jr.holdLabel(t)==='2 hr';`), await js(`var t=TB.jr.trades.find(t=>t.symbol==='PLTR'); return JSON.stringify(t)+' '+TB.jr.holdLabel(t);`));
  await js(`window.confirm=()=>true; TB.jr.remove(TB.jr.trades.find(t=>t.symbol==='PLTR').id); 1`); await sleep(150);
  ok('Delete is stored too (save() is the journal\'s again)', await stored() === n0 && !(await js(`return (TBStore.get(TBStore.KEYS.trades, [])||[]).some(t=>t.symbol==='PLTR');`)));
  ok('TB.jr has no method defined twice', await js(`return typeof TB.jr.save==='function' && TB.jr.save.toString().indexOf('TBStore')>=0 && typeof TB.jr.saveForm==='function';`));
  await js(`document.getElementById('tb-display-btn').click(); 1`); await sleep(200);
  // Nothing under the blur may say win or loss by its colour (2026-11-09).
  const textCol = `(function(){var t=document.createElement('span'); t.style.color='var(--text)'; document.body.appendChild(t); var w=getComputedStyle(t).color; t.remove(); return w;})()`;
  ok('display mode: no blurred journal figure is green or red', await js(`var want=${textCol}; var els=[...document.querySelectorAll('#jr-body .tbm, #jr-stats .t-val, #jr-curve-meta > span, #jr-body .jr-day b')].filter(e=>e.offsetParent); return els.length>5 && els.every(e=>getComputedStyle(e).color===want);`),
    await js(`var want=${textCol}; return want+' vs '+[...document.querySelectorAll('#jr-body .tbm, #jr-stats .t-val, #jr-curve-meta > span, #jr-body .jr-day b')].filter(e=>e.offsetParent&&getComputedStyle(e).color!==want).slice(0,4).map(e=>e.textContent+':'+getComputedStyle(e).color).join(', ');`));
  ok('…Win / Loss blur and lose their colour, Open does not blur', await js(`var want=${textCol}; var r=[...document.querySelectorAll('#jr-body .jr-res')]; var res=r.filter(e=>!e.classList.contains('open')); return res.length>=3 && res.every(e=>/blur/.test(getComputedStyle(e).filter) && getComputedStyle(e).color===want);`));
  await js(`document.getElementById('tb-display-btn').click(); 1`); await sleep(200);
  ok('display mode off: the colours are back', await js(`var r=document.querySelector('#jr-body .jr-res.loss'); return !!r && getComputedStyle(r).color!==${textCol};`));
  await js(`document.getElementById('tb-display-btn').click(); 1`); await sleep(200);
  const vis = (sel) => js(`var e=document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display!=='none';`);
  ok('display mode: the curve, its dates and the table toggle are gone', !(await vis('#curve-svg')) && !(await vis('.jr-curve-dates')) && !(await vis('.tb-eq-tog')));
  ok('…a placeholder of the same box says so', await js(`return /Chart hidden in display mode/.test(getComputedStyle(document.getElementById('jr-curve-host'),'::before').content);`));
  await shot('journal-display');
  await js(`document.getElementById('tb-display-btn').click(); 1`); await sleep(200);
  ok('display mode off: the curve is back', await vis('#curve-svg'));
  await shot('journal');

  console.log('\nPortfolio');
  await js(`TB.showSection('portfolio'); 1`);
  ok('Day %: the live quote for AMD (Webull sent none)', await until(`/−?-1\\.25%/.test((document.querySelector('.tbt-pos tbody tr') ? [...document.querySelectorAll('.tbt-pos tbody tr')].find(r=>/AMD/.test(r.textContent)) : {textContent:''}).textContent)`, 6000),
    await js(`return [...document.querySelectorAll('.tbt-pos tbody tr')].map(r=>r.textContent.replace(/\\s+/g,' ')).join(' | ');`));
  ok('…MU from Finnhub /quotes (Yahoo had none), over Webull\'s -0.80%', await js(`var r=[...document.querySelectorAll('.tbt-pos tbody tr')].find(r=>/MU/.test(r.textContent)); return !!r && /-0\\.90%/.test(r.lastElementChild.textContent);`),
    await js(`var r=[...document.querySelectorAll('.tbt-pos tbody tr')].find(r=>/MU/.test(r.textContent)); return r&&r.lastElementChild.textContent;`));

  console.log('\nNews');
  await js(`TB.showSection('news'); 1`);
  await until(`document.querySelector('.nh-ev')`, 8000);
  await until(`document.querySelector('.nh-mover-mid')`, 6000);
  ok('movers: a sparkline and the after-hours move', await js(`var m=[...document.querySelectorAll('.nh-mover')].find(x=>/NVDA/.test(x.textContent)); return !!m && !!m.querySelector('.nh-spark') && /After\\s*\\+0\\.53%/.test(m.textContent);`),
    await js(`return [...document.querySelectorAll('.nh-mover')].map(x=>x.textContent.replace(/\\s+/g,' ')).join(' | ');`));
  ok('movers: a dot on a ticker she holds (AMD), none on NVDA', await js(`var m=t=>[...document.querySelectorAll('.nh-mover')].find(x=>x.querySelector('b').textContent===t); return !!m('AMD').querySelector('.nh-held-dot') && !m('NVDA').querySelector('.nh-held-dot');`));
  ok('a story naming a held ticker (AMD) among others is Held', await js(`var c=[...document.querySelectorAll('.nh-ev')].find(x=>/sign a deal/.test(x.textContent)); return !!c && !!c.querySelector('.nh-held');`));
  ok('cards show the after-hours move', await js(`return [...document.querySelectorAll('.nh-ev')].some(x=>/After\\s*\\+0\\.53%/.test(x.textContent));`));
  ok('Impact order: the held story (60) before the bigger unheld one (90)', await js(`var c=[...document.querySelectorAll('.nh-ev .nh-sum')].map(x=>x.textContent); return c[0]==='Nvidia and AMD sign a deal.' && c[1]==='Nvidia raises guidance.';`));
  ok('a Held chip in the ticker strip with its count', await js(`var b=[...document.querySelectorAll('.nh-strip .nh-chip')].find(x=>/^Held/.test(x.textContent)); return !!b && /1/.test(b.textContent);`));
  await js(`[...document.querySelectorAll('.nh-strip .nh-chip')].find(x=>/^Held/.test(x.textContent)).click(); 1`); await sleep(150);
  ok('…it filters to held stories, with a removable tag', await js(`return document.querySelectorAll('.nh-ev').length===1 && [...document.querySelectorAll('.nh-tag')].some(t=>/Held/.test(t.textContent));`));
  await shot('news-held');
  await js(`document.querySelector('.nh-clear').click(); 1`); await sleep(150);
  ok('Clear all drops it', await js(`return document.querySelectorAll('.nh-ev').length===2;`));
  // Pre-market: Yahoo's pre price leads before the open.
  await js(`tbMktState = (function(orig){ return function(d){ var s=orig(d); s.phase='pre'; return s; }; })(tbMktState); TB.news.mq.NVDA = {c:190,dp:2.5,ext:{kind:'pre',price:195,dp:2.63},points:[1,2]}; TB.news.render(); 1`);
  ok('before the open the pre-market move leads, marked Pre', await js(`var m=[...document.querySelectorAll('.nh-mover')].find(x=>x.querySelector('b').textContent==='NVDA'); return !!m && /Pre\\s*▲ \\+2\\.63%/.test(m.textContent) && /\\$195\\.00/.test(m.textContent);`),
    await js(`var m=[...document.querySelectorAll('.nh-mover')].find(x=>x.querySelector('b').textContent==='NVDA'); return m&&m.textContent.replace(/\\s+/g,' ');`));

  console.log('\nIntraday and raw builds');
  calls.length = 0;
  GEN = NOW + 1000;
  await js(`TB.news._intraday(true); 1`);
  ok('the intraday tick asks /news?intraday=1', await until(`true`, 100) && await (async () => { for (let i = 0; i < 30; i++) { if (calls.some(x => /^\/news\?intraday=1/.test(x))) return true; await sleep(100); } return false; })(), calls.join(' '));
  ok('…and adopts the newer build', await until(`TB.news.generatedAt===${NOW + 1000}`, 3000));
  ok('outside the session the tick stays quiet', await js(`return typeof tbnIntradayWindow==='function';`) && await js(`var real=tbMktState; tbMktState=function(){return {phase:'closed',t:0,regClose:960};}; var w=tbnIntradayWindow(); tbMktState=real; return w===false;`));
  calls.length = 0;
  RAW = true; GEN = NOW + 2000;
  await js(`localStorage.removeItem('tradeboard_news_raw_retry'); TB.news._kickedAt = 0; TB.news._applyBuild({events:${JSON.stringify(EV.map(e => ({ ...e, aiAnalyzed: false })))},generatedAt:${NOW + 2000}}); 1`);
  ok('a raw build is retried once with a fresh build', await (async () => { for (let i = 0; i < 40; i++) { if (calls.some(x => /^\/news\?.*fresh=1/.test(x))) return true; await sleep(100); } return false; })(), calls.join(' '));
  await js(`TB.news._stopWatch(); 1`);
  const freshN = calls.filter(x => /fresh=1/.test(x)).length;
  await js(`TB.news._kickedAt = 0; TB.news._applyBuild({events:${JSON.stringify(EV.map(e => ({ ...e, aiAnalyzed: false })))},generatedAt:${NOW + 2000}}); 1`); await sleep(2000);
  ok('…never twice for the same build', calls.filter(x => /fresh=1/.test(x)).length === freshN, calls.join(' '));

  console.log('\nPhone');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  ok('nothing scrolls sideways on News at 390px', await js(`return document.documentElement.scrollWidth<=391;`), await js(`return document.documentElement.scrollWidth;`));
  await shot('news-phone');
  await js(`TB.showSection('journal'); 1`); await sleep(300);
  ok('nothing scrolls sideways on the Journal at 390px', await js(`return document.documentElement.scrollWidth<=391;`), await js(`return document.documentElement.scrollWidth;`));
  await shot('journal-phone');

  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
