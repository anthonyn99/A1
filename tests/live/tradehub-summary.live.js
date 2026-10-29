// TradeHub ▸ News ▸ Market Summary overlay (redesign, 2026-10-29), in the real
// page against the fake Firestore: the overlay is mounted straight from the
// page's own overlay (window.tbNewsSummary) with a full summary, so no newshub call is
// needed. Checks the parts are there, the theme rules (no tinted washes,
// Inter tabular numbers), that a phone gets one column with no sideways
// scroll, and screenshots both widths plus the loading state.
//
// Run: node tests/live/tradehub-summary.live.js
//      (TH_PAGE_FILE=../A1-Priv/.deploy/tradehub.html to test the shipped build)
'use strict';
const fs = require('fs');
const path = require('path');
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const SHOTS = process.env.SHOTS_DIR || path.join(require('os').tmpdir(), 'tradehub-summary-shots');
fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};

const SUMMARY = {
  headline: 'Memory Sector Surges on SK Hynix, While Google Disappoints and Microsoft Shines in Divergent Tech Earnings',
  tone: 'mixed', toneScore: 0.2,
  overview: 'The memory sector is experiencing a significant bullish surge, driven by SK Hynix’s record-breaking earnings and projections of a prolonged memory shortage. In contrast, Big Tech earnings are highly divergent, with Microsoft beating expectations and Google facing a historic sell-off over monetization concerns.',
  keyPoints: [
    { text: 'SK Hynix reported a massive 632% profit jump and a $45 billion shareholder return pledge, signalling a strong memory recovery and a bullish tailwind for MU and WDC.', stance: 'bull', tickers: ['SKHY', 'MU', 'WDC', 'SNDK'] },
    { text: 'Alphabet (GOOGL) shares dropped 10% premarket on disappointing search revenue, raising concerns about AI monetization despite high query volume.', stance: 'bear', tickers: ['GOOGL'] },
    { text: 'Microsoft beat Q1 revenue and EPS estimates with Azure growth at 48%.', stance: 'bull', tickers: ['MSFT'] },
    { text: 'Treasury yields were little changed ahead of the PCE print.', stance: 'neutral', tickers: [] },
  ],
  tickers: [
    { ticker: 'MU', stance: 'bull', note: 'Primary beneficiary of SK Hynix’s strong results and memory shortage warnings.' },
    { ticker: 'GOOGL', stance: 'bear', note: 'Historic 10% premarket drop on disappointing search revenue.' },
    { ticker: 'INTC', stance: 'neutral', note: 'Under pressure from the broader tech sell-off; Q3 earnings awaited.' },
  ],
  themes: [
    { name: 'Memory Super-Cycle', stance: 'bull', note: 'Shortage projections extend pricing power into 2027.' },
    { name: 'AI Monetization Doubts', stance: 'bear', note: 'Investors now demand free cash flow, not just capex.' },
  ],
  risks: ['A hot PCE print could reprice the December cut.', 'Memory pricing is cyclical; inventory build would cap the rally.'],
  watch: ['September PCE at 8:30 AM ET', 'AMZN and AAPL earnings after the close'],
  model: 'gemini-2.5-flash',
};

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  const size = (w, h) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const mount = (props) => js(`
    var host=document.getElementById('__sum'); if(host&&host.__root){host.__root.unmount();host.remove();}
    host=document.createElement('div'); host.id='__sum'; document.body.appendChild(host);
    host.__root=ReactDOM.createRoot(host);
    host.__root.render(React.createElement(window.tbNewsSummary.Overlay, Object.assign({onClose:function(){window.__closed=1;}, generatedAt:Date.now()-20*60000, eventCount:55}, ${JSON.stringify(props)})));
    1`);

  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10)); 1`);

  for (const [w, h, tag] of [[1440, 1000, 'desktop'], [390, 844, 'mobile']]) {
    console.log(`\n${tag}`);
    await size(w, h);
    await c.send('Page.navigate', { url: ORIGIN + '/A1/tradehub.html' });
    if (!(await until("document.querySelector('.tb-navtab') && window.tbNewsSummary", 25000))) { ok('TradeHub rendered', false); continue; }
    await sleep(1500);
    await mount({ summary: SUMMARY, loading: false, error: '' });
    ok('the overlay opens', await until("document.querySelector('.nhs .nhs-headline')", 5000));
    await sleep(400);
    const r = JSON.parse(await js(`
      var q=s=>document.querySelector(s), qa=s=>[...document.querySelectorAll(s)];
      var washes=qa('.nhs *').filter(e=>{var b=getComputedStyle(e).backgroundColor; var m=/rgba\\((\\d+), (\\d+), (\\d+), ([\\d.]+)\\)/.exec(b); return m && +m[4]>0 && +m[4]<1;}).map(e=>e.className);
      var grads=qa('.nhs, .nhs *').filter(e=>/gradient/.test(getComputedStyle(e).backgroundImage)).length;
      var sc=getComputedStyle(q('.nhs-score'));
      var card=q('.nhs').getBoundingClientRect();
      return JSON.stringify({
        headline:q('.nhs-headline').textContent, score:q('.nhs-score').textContent, tone:q('.nhs-tone-l').textContent,
        points:qa('.nhs-pt').length, nums:qa('.nhs-pt-n').map(e=>e.textContent).join(), tags:qa('.nhs-pt .nhs-st').map(e=>e.textContent).join(),
        chips:qa('.nhs-pt .nhs-tk').length, tickers:qa('.nhs-sym').length, themes:qa('.nhs-theme').length, risks:qa('.nhs-list li').length,
        foot:q('.nhs-foot').textContent, washes:washes, grads:grads,
        scoreFont:sc.fontFamily+'|'+sc.fontWeight+'|'+sc.fontVariantNumeric,
        dotLeft:q('.nhs-dot').style.left, fillW:q('.nhs-fill').style.width,
        tickCols:getComputedStyle(q('.nhs-grid')).gridTemplateColumns.split(' ').length,
        colsCols:getComputedStyle(q('.nhs-cols')).gridTemplateColumns.split(' ').length,
        cardW:card.width, vw:innerWidth, sideways:document.documentElement.scrollWidth>innerWidth+1,
        overflowing:qa('.nhs *').filter(e=>{var b=e.getBoundingClientRect(); return b.width && b.right>card.right+1;}).map(e=>e.className).slice(0,5),
        headSticky:getComputedStyle(q('.nhs-head')).position
      });`));
    ok('headline, tone and score', r.headline === SUMMARY.headline && r.tone === 'Mixed' && r.score === '+0.20', JSON.stringify([r.tone, r.score]));
    ok('the gauge marks +0.20 (60%), filled from the centre', r.dotLeft === '60%' && parseFloat(r.fillW) === 10, r.dotLeft + ' ' + r.fillW);
    ok('numbered key points with their stance and tickers', r.points === 4 && r.nums === '01,02,03,04' && /▲Bull,▼Bear,▲Bull,●Neutral/.test(r.tags) && r.chips === 6, JSON.stringify([r.nums, r.tags, r.chips]));
    ok('ticker and theme cards, risks and what to watch', r.tickers === 3 && r.themes === 2 && r.risks === 4, JSON.stringify([r.tickers, r.themes, r.risks]));
    ok('footer names the model', /55 analyzed events/.test(r.foot) && /gemini-2\.5-flash/.test(r.foot), r.foot);
    ok('no tinted washes and no gradients (MAGI theme)', !r.washes.length && !r.grads, JSON.stringify(r.washes) + ' grads=' + r.grads);
    ok('the score is Inter 500 tabular', /Inter/.test(r.scoreFont) && /\|500\|/.test(r.scoreFont) && /tabular-nums/.test(r.scoreFont), r.scoreFont);
    ok('the header stays put while it scrolls', r.headSticky === 'sticky');
    ok('nothing pokes out of the card, no sideways scroll', !r.sideways && !r.overflowing.length, JSON.stringify(r.overflowing));
    if (tag === 'desktop') {
      ok('desktop: a centred reading column', r.cardW <= 862 && r.cardW > 800, r.cardW);
      ok('desktop: tickers in columns, risks beside what to watch', r.tickCols >= 2 && r.colsCols === 2, r.tickCols + '/' + r.colsCols);
    } else {
      ok('phone: full-bleed', Math.abs(r.cardW - r.vw) <= 1, r.cardW + '/' + r.vw);
      ok('phone: one column everywhere', r.tickCols === 1 && r.colsCols === 1, r.tickCols + '/' + r.colsCols);
    }
    await shot(`summary-${tag}`);
    // Scroll down the digest for the lower half.
    await js(`var s=document.querySelector('${tag === 'mobile' ? '.nhs' : '.nhs-overlay'}'); s.scrollTop=s.scrollHeight; 1`);
    await sleep(300);
    await shot(`summary-${tag}-bottom`);
    await js(`var s=document.querySelector('${tag === 'mobile' ? '.nhs' : '.nhs-overlay'}'); s.scrollTop=0; 1`);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
    ok('Escape closes it', await js(`return window.__closed===1;`));
    await mount({ summary: null, loading: true, error: '' });
    await sleep(300);
    ok('loading shows the skeleton', await js(`return document.querySelectorAll('.nhs-sk').length>=5;`));
    await shot(`summary-${tag}-loading`);
    await mount({ summary: null, loading: false, error: 'AI quota exhausted. Try again in a minute.' });
    await sleep(200);
    ok('an error shows with Try again', await js(`return /AI quota exhausted/.test(document.querySelector('.nhs-error').textContent);`));
  }

  const real = errs.filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|NetworkError|recaptcha|appCheck|App Check|finnhub|workers\.dev/i.test(e));
  ok('no page errors', !real.length, real.join(' | '));
  console.log(`\n  screenshots: ${SHOTS}`);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
