// TradeBoard's Control and News tabs (V1/TradeBoard/tradeboard.html, Veda's),
// redesigned 2026-10-29 to TradeHub's layout in TradeBoard's own colours: one
// header per tab, the watchlist as tiles with one Trash button in the header,
// and News as a pulse strip, a toolbar with a Filters panel, a sideways ticker
// strip, a results line of removable tags and cards with a footer.
//
// Real TradeBoard page, fake Firestore, and a fake news worker (no build is
// ever spent). Desktop, then a 390px phone.
//
// Run: node tests/live/tradeboard-ui.live.js
//      TB_PAGE_FILE=<copy> node tests/live/tradeboard-ui.live.js   (a work-in-progress copy)
'use strict';
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');
const fs = require('fs');

const URL = 'https://anthonyn99.github.io/A1/V1/TradeBoard/tradeboard.html';
const ORIGIN = 'https://anthonyn99.github.io';
const WORKER = 'https://tradeboard-news.vedapatel05.workers.dev';
const TBDOC = 'tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

const NOW = Date.now(), MIN = 60000;
const src = (n, h, ago) => ({ name: n, headline: h, url: 'https://example.com/' + encodeURIComponent(h), ts: NOW - ago * MIN });
const EVENTS = [
  { id: 'e1', primaryTicker: 'NVDA', additionalTickers: ['AMD'], ts: NOW - 10 * MIN, summary: 'Nvidia guides above the street on data-centre demand.',
    impact: { tier: 'critical', score: 92 }, sentiment: { label: 'bull', score: 0.71 }, eventType: 'earnings', sectors: ['Semiconductor'], aiAnalyzed: true,
    sources: [src('Reuters', 'Nvidia beats', 12), src('Reuters', 'Nvidia beats again', 13), src('Bloomberg', 'Why Nvidia rose', 14), src('CNBC', 'Data-centre sales jump', 20),
      src('Yahoo', 'Chip stocks rally', 25), src('MarketWatch', 'Nvidia raises guide', 30), src('Barrons', 'What is driving Nvidia', 35), src('WSJ', 'Nvidia and the AI trade', 40)] },
  { id: 'e2', primaryTicker: 'MU', ts: NOW - 5 * 60 * MIN, summary: 'Micron flags memory price softness into next quarter.',
    impact: { tier: 'major', score: 74 }, sentiment: { label: 'bear', score: -0.52 }, eventType: 'guidance', sectors: ['Memory'], aiAnalyzed: true,
    sources: [src('Reuters', 'Micron warns', 300)] },
  { id: 'e3', primaryTicker: 'PLTR', ts: NOW - 20 * 60 * MIN, summary: 'Palantir wins a new defence contract.',
    impact: { tier: 'important', score: 60 }, sentiment: { label: 'bull', score: 0.4 }, eventType: 'contract', sectors: ['AI/Software'], aiAnalyzed: true,
    sources: [src('Defense News', 'Palantir contract', 1200)] },
  { id: 'e4', primaryTicker: 'AMD', ts: NOW - 30 * 60 * MIN, summary: 'AMD holds an analyst day.',
    impact: { tier: 'notable', score: 40 }, sentiment: { label: 'neutral', score: 0 }, eventType: 'other', sectors: ['Semiconductor'], aiAnalyzed: true,
    sources: [src('CNBC', 'AMD analyst day', 1800)] },
  { id: 'e5', primaryTicker: 'NVDA', ts: NOW - 60 * 60 * MIN, summary: 'Nvidia supplier notes longer lead times.',
    impact: { tier: 'minor', score: 20 }, sentiment: { label: 'neutral', score: 0 }, eventType: 'other', sectors: ['Semiconductor'], aiAnalyzed: true,
    sources: [src('Digitimes', 'Lead times stretch', 3600)] },
];
const SUMMARY = { headline: 'Chips lead, memory lags', tone: 'bull', toneScore: 0.35, overview: 'Semis carry the tape.',
  keyPoints: [{ text: 'Nvidia beat', stance: 'bull', tickers: ['NVDA'] }], tickers: [{ ticker: 'MU', stance: 'bear', note: 'Soft pricing' }],
  themes: [{ name: 'AI capex', stance: 'bull', note: 'Still rising' }], risks: ['Memory pricing'], watch: ['MU guide'], model: 'test' };
const WL = ['NVDA', 'MU', 'AMD', 'PLTR', 'ZQX'];
const SEED = { [TBDOC]: { watchlist: JSON.stringify(WL), watchlistTrash: JSON.stringify([{ t: 'INTC', trashed: NOW - 86400000 }]),
  watchlistSectors: JSON.stringify({ MU: 'Memory' }), rulesDaily: JSON.stringify({ lastCompleted: null, enabled: false }), _updated: NOW } };

const hits = [];
const worker = {
  patterns: [WORKER + '/*'],
  handle(req) {
    if (!req.url.startsWith(WORKER)) return null;
    const u = new global.URL(req.url);
    hits.push(u.pathname + u.search);
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    if (u.pathname === '/news') return { json: { events: EVENTS, generatedAt: NOW - 3 * MIN } };
    if (u.pathname === '/quotes') return { json: { asOf: NOW, quotes: { NVDA: { c: 141.2, dp: 4.1 }, MU: { c: 98.5, dp: -3.2 }, AMD: { c: 160, dp: 1.1 }, PLTR: { c: 42, dp: 0.4 }, ZQX: { c: 10, dp: -0.2 } } } };
    if (u.pathname === '/rate-status') return { json: { usedToday: 3, cooldownSec: 0 } };
    if (u.pathname === '/summary') return { json: { ok: true, generatedAt: NOW - 3 * MIN, summary: SUMMARY } };
    if (u.pathname === '/sectors') {
      const out = {}; (u.searchParams.get('tickers') || '').split(',').forEach((t) => { if (t) out[t] = t === 'ZQX' ? 'Quantum' : 'Diversified'; });
      return { json: { sectors: out } };
    }
    if (u.pathname === '/watchlist') return { json: { ok: true } };
    return { status: 404, json: {} };
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
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 8000) / 200; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(200); } return false; };
  const doc = async (p) => JSON.parse(await js(`return JSON.stringify(__fakeFs.docs[${JSON.stringify(p)}] || null);`));
  const click = (sel) => js(`var el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.click(); return true;`);
  const shot = async (n) => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotPath(n), Buffer.from(s.result.data, 'base64')); console.log('  shot ' + shotPath(n)); };
  // Anything in the tab sticking out past the viewport (a phone must never scroll sideways).
  const overflow = (host) => js(`var W=innerWidth, bad=[];
    document.querySelectorAll('#${host} *').forEach(function(el){ if(el.closest('[data-strip]') && !el.matches('[data-strip]')) return;
      var r=el.getBoundingClientRect(); if(r.width && (r.right>W+1 || r.left<-1)) bad.push((el.className||el.tagName)+':'+Math.round(r.left)+'-'+Math.round(r.right)); });
    return JSON.stringify({ doc: document.documentElement.scrollWidth > W + 1, bad: bad.slice(0,6) });`);
  const boot = async () => {
    await c.send('Page.navigate', { url: URL });
    if (!(await until(`typeof TB !== 'undefined' && TB.wl && TB.news && window._tbCloudSeen`, 15000))) throw new Error('TradeBoard did not open');
    await sleep(800);
  };

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: 'https://anthonyn99.github.io/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(SEED))}); 1`);
  await boot();

  // ── Control ──
  console.log('\nControl');
  await js(`TB.showSection('control'); 1`);
  ok('one header: the title and the Trash button with its count', await until(`document.querySelector('#wl-host .tbx-head .tbx-title')`, 5000)
    && await js(`var h=document.querySelector('#wl-host .tbx-head'); return h.querySelector('.tbx-title').textContent==='Control' && h.querySelector('[data-act="trash"] .tbx-count').textContent==='1';`));
  ok('the old section label and per-card buttons are gone', await js(`return !document.querySelector('#wl-host .section-label, #wl-host .wl-acts, #wl-host .wl-chip');`));
  ok('one tile per ticker, sorted', await js(`return [...document.querySelectorAll('#wl-host .ctl-tk b')].map(b=>b.textContent).join()==='AMD,MU,NVDA,PLTR,ZQX';`),
    await js(`return [...document.querySelectorAll('#wl-host .ctl-tk b')].map(b=>b.textContent).join();`));
  ok('a ticker outside the table gets its sector from the worker', await until(`[...document.querySelectorAll('#wl-host .ctl-tk')].some(t=>t.querySelector('b').textContent==='ZQX' && t.querySelector('span').textContent==='Quantum')`, 6000));
  ok('the auto-derived sectors list it', await js(`return [...document.querySelectorAll('#wl-host .ctl-sectors span')].some(s=>s.textContent==='Quantum');`));
  ok('Add is disabled until something is typed', await js(`return document.querySelector('#wl-host [data-act="add"]').disabled;`));
  await js(`var i=document.getElementById('wl-input'); i.focus(); i.value='aapl, tsla'; i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
  ok('...and enabled once it is', await js(`return !document.querySelector('#wl-host [data-act="add"]').disabled;`));
  await js(`document.getElementById('wl-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); 1`);
  ok('Enter adds every ticker typed', await until(`[...document.querySelectorAll('#wl-host .ctl-tk b')].map(b=>b.textContent).join()==='AAPL,AMD,MU,NVDA,PLTR,TSLA,ZQX'`, 3000));
  let D = null;
  for (let i = 0; i < 30; i++) { await sleep(200); D = await doc(TBDOC); if (D && /TSLA/.test(D.watchlist || '')) break; }
  ok('...and the list syncs to the cloud', D && JSON.parse(D.watchlist).includes('AAPL') && JSON.parse(D.watchlist).includes('TSLA'), D && D.watchlist);
  await click('#wl-host .ctl-tk button[data-t="TSLA"]');
  ok('removing a tile sends it to the trash (count 2)', await until(`!document.querySelector('#wl-host button[data-t="TSLA"]') && document.querySelector('#wl-host [data-act="trash"] .tbx-count').textContent==='2'`, 3000));
  ok('the copy box shows the list in [A, B] form', await js(`return document.querySelector('#wl-host .ctl-bracket').textContent.trim()==='[NVDA, MU, AMD, PLTR, ZQX, AAPL]';`),
    await js(`return document.querySelector('#wl-host .ctl-bracket').textContent.trim();`));
  ok('Reset to default is on (the list is not the default)', await js(`return !document.querySelector('#wl-host [data-act="reset"]').disabled;`));
  await click('#wl-host [data-act="default"]');
  ok('Set current as default makes Reset and itself go quiet', await until(`document.querySelector('#wl-host [data-act="reset"]').disabled && document.querySelector('#wl-host [data-act="default"]').disabled`, 3000));
  await click('#wl-host [data-act="trash"]');
  ok('Trash opens the trash with both tickers', await until(`document.getElementById('wl-trash-modal').classList.contains('open') && document.querySelectorAll('#wl-trash-list .trash-row').length===2`, 3000));
  await js(`document.querySelector('#wl-trash-list [data-act="restore"][data-t="TSLA"]').click(); 1`);
  ok('Restore brings TSLA back', await until(`document.querySelector('#wl-host button[data-t="TSLA"]')`, 3000));
  await js(`TB.wl.closeTrash(); 1`);
  await shot('tradeboard-ui-control');

  // ── News ──
  console.log('\nNews');
  await js(`TB.showSection('news'); 1`);
  ok('the feed loads from the worker cache', await until(`document.querySelectorAll('#nh-host .nh-ev').length >= 4`, 10000),
    await js(`return document.getElementById('nh-host').innerText.slice(0,300);`));
  ok('one header: Summary, Force and Refresh', await js(`var a=[...document.querySelectorAll('#nh-host .tbx-head .tbx-actions [data-act]')].map(b=>b.dataset.act).join(); return a==='summary,force,refresh';`));
  ok('the meta line has the build age and refreshes left', await js(`var t=document.querySelector('#nh-host .tbx-sub').textContent; return /Updated/.test(t) && /9\\/12 refreshes left today/.test(t);`),
    await js(`return document.querySelector('#nh-host .tbx-sub').textContent;`));
  ok('the pulse has six counts', await js(`return document.querySelectorAll('#nh-host .nh-pulse > button').length===6;`));
  ok('Top movers, biggest move first', await until(`document.querySelector('#nh-host .nh-mover b') && document.querySelector('#nh-host .nh-mover b').textContent==='NVDA'`, 6000));
  const nAll = await js(`return document.querySelectorAll('#nh-host .nh-ev').length;`);
  await click('#nh-host .nh-pulse [data-act="p-crit"]');
  ok('Critical in the pulse filters to critical and shows a tag', await until(`document.querySelectorAll('#nh-host .nh-ev').length===1 && document.querySelector('#nh-host .nh-results .nh-tag')`, 3000)
    && await js(`return document.querySelector('#nh-host .nh-pulse [data-act="p-crit"]').classList.contains('on');`));
  await click('#nh-host .nh-pulse [data-act="p-crit"]');
  ok('...tapping it again clears it', await until(`document.querySelectorAll('#nh-host .nh-ev').length===${nAll} && !document.querySelector('#nh-host .nh-results .nh-tag')`, 3000));
  ok('the toolbar: sentiment, order, window, Filters', await js(`var t=document.querySelector('#nh-host .nh-tools'); return t.querySelectorAll('.tbx-seg').length===3 && !!t.querySelector('[data-act="filters"]');`));
  ok('Impact and Sector stay behind Filters', await js(`return !document.querySelector('#nh-host .nh-panel');`));
  await click('#nh-host [data-act="filters"]');
  ok('Filters opens the panel', await until(`document.querySelector('#nh-host .nh-panel [data-k="impFilter"]') && document.querySelector('#nh-host .nh-panel [data-act="sec"]')`, 3000));
  await click('#nh-host .nh-panel [data-act="sec"][data-v="Memory"]');
  ok('a sector chip filters and the Filters badge counts it', await until(`document.querySelectorAll('#nh-host .nh-ev').length===1 && document.querySelector('#nh-host [data-act="filters"] .tbx-count') && document.querySelector('#nh-host [data-act="filters"] .tbx-count').textContent==='1'`, 3000));
  ok('...the panel stays open across the repaint', await js(`return !!document.querySelector('#nh-host .nh-panel');`));
  await click('#nh-host .nh-results .nh-clear');
  ok('Clear all clears it', await until(`document.querySelectorAll('#nh-host .nh-ev').length===${nAll} && !document.querySelector('#nh-host .nh-clear')`, 3000));
  await click('#nh-host [data-act="filters"]');
  ok('the ticker strip holds the whole watchlist, quiet ones dimmed', await js(`var c=[...document.querySelectorAll('#nh-host .nh-strip [data-act="tick"]')]; return c.length===TB.news.tickers().length && c.length===7 && c.find(x=>x.dataset.v==='ZQX').classList.contains('dim') && !c.find(x=>x.dataset.v==='NVDA').classList.contains('dim');`),
    await js(`return [...document.querySelectorAll('#nh-host .nh-strip [data-act="tick"]')].map(x=>x.dataset.v+(x.classList.contains('dim')?'~':'')).join();`));
  await click('#nh-host .nh-strip [data-act="tick"][data-v="MU"]');
  ok('a ticker chip filters to that ticker', await until(`document.querySelectorAll('#nh-host .nh-ev').length===1 && document.querySelector('#nh-host .nh-ev .nh-tk').textContent==='MU'`, 3000));
  await click('#nh-host .nh-results .nh-tag button');
  ok('its tag\'s x removes it', await until(`document.querySelectorAll('#nh-host .nh-ev').length===${nAll}`, 3000));
  console.log('\nThe event card');
  const card = `document.querySelector('#nh-host .nh-ev')`;
  ok('the top line: ticker, move, other tickers, time', await js(`var c=${card}; return c.querySelector('.nh-tk').textContent==='NVDA' && /4\\.10%/.test(c.querySelector('.nh-move').textContent) && /AMD/.test(c.querySelector('.nh-alt').textContent) && !!c.querySelector('.nh-ago');`));
  ok('Breaking on a fresh story, with its amber edge', await js(`var c=${card}; return !!c.querySelector('.nh-breaking') && /amber/.test(c.getAttribute('style'));`));
  ok('the footer: tier, sentiment, type, sector pills and the outlets', await js(`var c=${card}; var p=[...c.querySelectorAll('.nh-ev-foot .nh-pill')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()); return p[0].indexOf('Critical')===0 && p[1].indexOf('Bullish')===0 && p[2]==='earnings' && p[3]==='Semiconductor' && c.querySelectorAll('.nh-src a').length===3;`),
    await js(`var c=${card}; return [...c.querySelectorAll('.nh-ev-foot .nh-pill')].map(x=>x.textContent).join('|') + ' / ' + c.querySelectorAll('.nh-src a').length;`));
  ok('up to 4 headlines, with "+N more"', await js(`var c=${card}; return c.querySelectorAll('.nh-hl a').length===4 && /\\+ 4 more headlines/.test(c.querySelector('.nh-hl .more').textContent);`),
    await js(`var c=${card}; return c.querySelectorAll('.nh-hl a').length + ' ' + (c.querySelector('.nh-hl .more')||{}).textContent;`));
  await js(`${card}.querySelector('.nh-hl .more').click(); 1`);
  ok('...which opens them all', await until(`${card}.querySelectorAll('.nh-hl a').length===8`, 3000));

  console.log('\nRepaints keep their place');
  await js(`document.querySelector('#nh-host .nh-tools [data-k="hours"][data-v="48"]').focus(); TB.news.render(); 1`);
  ok('...and keyboard focus', await js(`var a=document.activeElement; return a && a.dataset.k==='hours' && a.dataset.v==='48';`));

  console.log('\nSummary');
  ok('Summary is marked ready once the digest is in', await until(`document.querySelector('#nh-host .nh-sum-btn.ready .dot')`, 6000));
  await click('#nh-host [data-act="summary"]');
  ok('Summary opens the market read', await until(`document.getElementById('nh-sum-modal').classList.contains('open') && /Chips lead, memory lags/.test(document.getElementById('nh-sum-host').textContent)`, 5000));
  await js(`TB.news.closeSummary(); document.querySelector('#view-news').scrollTop=0; 1`);
  await shot('tradeboard-ui-news');

  console.log('\nRemoving a ticker in Control prunes News');
  await js(`TB.news.setFilter({ selSectors: ['Memory'] }); TB.wl.remove('MU'); 1`);
  ok('its events and the stale sector filter go', await js(`return !TB.news.events.some(e=>e.primaryTicker==='MU') && TB.news.f.selSectors.length===0;`),
    await js(`return JSON.stringify(TB.news.f.selSectors);`));

  // ── Phone ──
  console.log('\nOn a phone (390px)');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await boot();
  await js(`TB.showSection('control'); 1`);
  await until(`document.querySelector('#wl-host .ctl-tk')`, 5000);
  let o = JSON.parse(await overflow('wl-host'));
  ok('Control fits the width', !o.doc && !o.bad.length, JSON.stringify(o));
  ok('tiles sit two or more to a row; each remove button is a real target', await js(`var t=[...document.querySelectorAll('#wl-host .ctl-tk')]; var b=t[0].querySelector('button').getBoundingClientRect(); return t.length>1 && Math.abs(t[0].getBoundingClientRect().top - t[1].getBoundingClientRect().top) < 2 && b.width >= 28 && b.height >= 28;`));
  await shot('tradeboard-ui-control-phone');
  await js(`TB.showSection('news'); 1`);
  await until(`document.querySelectorAll('#nh-host .nh-ev').length >= 3`, 8000);
  await sleep(500);
  o = JSON.parse(await overflow('nh-host'));
  ok('News fits the width', !o.doc && !o.bad.length, JSON.stringify(o));
  ok('the three header actions share one full-width row', await js(`var b=[...document.querySelectorAll('#nh-host .tbx-actions > .btn')].map(x=>x.getBoundingClientRect()); return b.length===3 && b.every(r=>Math.abs(r.top-b[0].top)<2) && b[2].right - b[0].left > 330;`),
    await js(`return JSON.stringify([...document.querySelectorAll('#nh-host .tbx-actions > .btn')].map(x=>{var r=x.getBoundingClientRect(); return [Math.round(r.left),Math.round(r.top),Math.round(r.width)];}));`));
  ok('the pulse is two rows of three', await js(`var b=[...document.querySelectorAll('#nh-host .nh-pulse > button')].map(x=>x.getBoundingClientRect().top); return b[0]===b[2] && b[3]>b[0] && b[3]===b[5];`));
  ok('sentiment takes the full width; order, window and Filters share the next row', await js(`var t=document.querySelector('#nh-host .nh-tools'), s=t.querySelectorAll('.tbx-seg'), f=t.querySelector('[data-act="filters"]').getBoundingClientRect(); return s[0].getBoundingClientRect().width > 340 && Math.abs(s[1].getBoundingClientRect().top - f.top) < 4;`),
    await js(`var t=document.querySelector('#nh-host .nh-tools'); return JSON.stringify([...t.children].map(x=>{var r=x.getBoundingClientRect(); return [x.className, Math.round(r.top), Math.round(r.width)];}));`));
  await shot('tradeboard-ui-news-phone');
  await js(`document.querySelector('#nh-host .nh-strip').scrollLeft=80; document.querySelector('#nh-host .nh-movers').scrollLeft=150; 1`);
  const sl = JSON.parse(await js(`return JSON.stringify([document.querySelector('#nh-host .nh-strip').scrollLeft, document.querySelector('#nh-host .nh-movers').scrollLeft]);`));
  await js(`TB.news.render(); 1`);
  const sl2 = JSON.parse(await js(`return JSON.stringify([document.querySelector('#nh-host .nh-strip').scrollLeft, document.querySelector('#nh-host .nh-movers').scrollLeft]);`));
  ok('the ticker strip and the movers keep their scroll through a repaint', sl[0] > 0 && sl[1] > 0 && sl2[0] === sl[0] && sl2[1] === sl[1], JSON.stringify([sl, sl2]));

  console.log('\nThe worker');
  ok('no build was ever forced (only cache reads)', !hits.some((h) => /fresh=1/.test(h)), hits.filter((h) => /news/.test(h)).join(' '));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
