// TradeHub ▸ Analysis ▸ Debrief (2026-11-12), in the real page against the fake
// Firestore. Checks: every MAGI answer (verdict and each unit) is drawn by
// MAGI's own renderer (A1 magibrief.js) in Brief, the Brief / Text switch
// redraws all of them and is remembered; the dialog stays one size and in
// place while only its body scrolls, the header never moving; the News
// Summary tab and the News overlay show the build as mm/dd/'yy h:mm AM/PM and
// "x ago". Desktop, tablet and phone, with screenshots.
//
// Run: node tests/live/tradehub-debrief.live.js
'use strict';
const fs = require('fs');
const path = require('path');
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const SHOTS = process.env.SHOTS_DIR || path.join(require('os').tmpdir(), 'tradehub-debrief-shots');
fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};

const VERDICT = [
  'ANSWER',
  'Stocks rose as softer CPI revived December cut bets. The Nasdaq led and breadth was strong.',
  '',
  '### What moved the market',
  '- **CPI:** core rose 0.2% m/m, under the 0.3% expected',
  '- **Yields:** the 10-year fell 9 bp to 4.31%',
  '- **Breadth:** 80% of S&P members finished higher',
  '',
  '### Biggest movers',
  '1. **NVDA** +3.1% on data-center orders',
  '2. **TSLA** -2.4% after a delivery cut',
  '',
  '### Risks',
  '- A hot PPI tomorrow at 8:30 ET',
  '- Oil above $100',
  '',
  '### Bottom line',
  'The tape favours growth while yields fall.',
  '',
  'NOTES',
  '- PPI is tomorrow.',
  '',
  'CONFIDENCE',
  'HIGH — the data was unambiguous.',
].join('\n');
const long = (n) => Array.from({ length: n }, (_, i) => `### Section ${i + 1}\n- **Point:** detail ${i + 1} that runs on for a while to fill the line.\n- **Another:** more text here.`).join('\n\n');
const RUN = {
  for: '2026-11-12',
  run: { created_at: new Date(Date.now() - 3 * 3600e3).toISOString(), total_ms: 84000 },
  synthesis: { verdict_text: VERDICT + '\n\n' + long(10), chairman_provider: 'claude', model: 'claude-opus' },
  answers: [
    { provider_id: 'claude', display_name: 'Claude', ok: true, answer_text: '### Movers\n- **NVDA:** up 3%\n- **AMD:** up 2%\n\nCONFIDENCE\nMEDIUM — early read.' },
    { provider_id: 'chatgpt', display_name: 'ChatGPT', ok: true, answer_text: 'Markets were up.\n\n### Why\n1. CPI\n2. Yields' },
    { provider_id: 'gemini', display_name: 'Gemini', ok: false, error_detail: 'Timed out.' },
  ],
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
  const mount = (tab) => js(`
    localStorage.setItem('tb_debrief_tab', ${JSON.stringify(tab)});
    window._fbWatchDebriefAuto = function(cb){ cb(${JSON.stringify({ movers: RUN, weekly: null })}); return function(){}; };
    var host=document.getElementById('__dbr'); if(host&&host.__root){host.__root.unmount();host.remove();}
    host=document.createElement('div'); host.id='__dbr'; document.body.appendChild(host);
    host.__root=ReactDOM.createRoot(host);
    host.__root.render(React.createElement(window.tbDebrief.Debrief, {onClose:function(){window.__closed=1;}, magi:false, promptText:''}));
    1`);
  const geo = () => js(`
    var q=s=>document.querySelector(s), b=e=>{var r=e.getBoundingClientRect(); return [Math.round(r.top),Math.round(r.height),Math.round(r.width)];};
    return JSON.stringify({card:b(q('.dbr')), head:b(q('.dbr-head')), scroller:q('.dbr-scroll').scrollHeight>q('.dbr-scroll').clientHeight,
      overlayScrolls:q('.dbr-overlay').scrollHeight>q('.dbr-overlay').clientHeight+1, cardScrolls:q('.dbr').scrollHeight>q('.dbr').clientHeight+1,
      sideways:document.documentElement.scrollWidth>innerWidth+1, vw:innerWidth, vh:innerHeight});`).then(JSON.parse);

  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10)); 1`);

  for (const [w, h, tag] of [[1440, 1000, 'desktop'], [900, 1180, 'tablet'], [390, 844, 'mobile']]) {
    console.log(`\n${tag}`);
    await size(w, h);
    await c.send('Page.navigate', { url: ORIGIN + '/A1/tradehub.html' });
    if (!(await until("document.querySelector('.tb-navtab') && window.tbDebrief && window.MagiBrief", 25000))) { ok('TradeHub rendered with MagiBrief', false); continue; }
    await sleep(1200);
    await js(`window.MagiBrief.setView('brief'); 1`);
    await mount('movers');
    ok('the Debrief opens on Today’s Movers', await until("document.querySelector('.dbr .br-headline')", 6000));
    await sleep(400);
    const r = JSON.parse(await js(`
      var q=s=>document.querySelector(s), qa=s=>[...document.querySelectorAll(s)];
      return JSON.stringify({
        verdictBrief: !!q('.dbr-magi > section .mb .verdict-body.brief'),
        unitsBrief: qa('.dbr-unit .mb .verdict-body.brief').length,
        cards: qa('.dbr-magi > section .br-sec').length, conf: !!q('.dbr .br-conf.high'), notes: !!q('.dbr .br-notes'),
        tone: !!q('.dbr .br-sec.tone-bad'), seg: qa('.dbr .br-seg-btn').map(b=>b.textContent+(b.classList.contains('on')?'*':'')).join(','),
        headFont: getComputedStyle(q('.dbr .br-headline')).fontFamily, styled: getComputedStyle(q('.dbr .br-sec')).borderRadius,
        oldDoc: qa('.dbr .tb-pb-doc').length });`));
    ok('the verdict is drawn by MAGI’s Brief', r.verdictBrief && r.cards >= 4 && r.conf && r.notes && r.tone, JSON.stringify(r));
    ok('each unit that answered is drawn in Brief too', r.unitsBrief === 2, r.unitsBrief);
    ok('no answer is left in TradeHub’s old markdown', r.oldDoc === 0, r.oldDoc);
    ok('MAGI’s look reaches it (Manrope headline, rounded cards)', /Manrope/.test(r.headFont) && r.styled === '12px' || r.styled === '11px', r.headFont + ' ' + r.styled);
    ok('the Brief / Text switch shows Brief chosen', r.seg === 'Brief*,Text', r.seg);

    // Stays in place: one size; the overlay and card never scroll, the body does.
    const g1 = await geo();
    ok('only the body scrolls (not the overlay, not the card)', g1.scroller && !g1.overlayScrolls && !g1.cardScrolls, JSON.stringify(g1));
    ok('no sideways scroll', !g1.sideways);
    if (tag === 'mobile') ok('phone: full-bleed, one screen tall', g1.card[2] === g1.vw && g1.card[1] === g1.vh, JSON.stringify(g1.card));
    else ok(tag + ': centred with a margin, inside the screen', g1.card[0] >= 8 && g1.card[0] + g1.card[1] <= g1.vh - 8, JSON.stringify(g1.card));
    await shot(`debrief-${tag}-brief`);
    await js(`var s=document.querySelector('.dbr-scroll'); s.scrollTop=s.scrollHeight; 1`); await sleep(250);
    const g2 = await geo();
    ok('scrolled: the header and the dialog have not moved', g2.head[0] === g1.head[0] && g2.card[0] === g1.card[0] && g2.card[1] === g1.card[1], JSON.stringify([g1.head, g2.head, g1.card, g2.card]));
    await js(`document.querySelectorAll('.dbr-unit')[0].open=true; 1`); await sleep(150);
    await shot(`debrief-${tag}-bottom`);

    // Text: one click redraws every answer, and is remembered.
    await js(`[...document.querySelectorAll('.dbr .br-seg-btn')].find(b=>b.textContent==='Text').click(); 1`);
    await sleep(300);
    const t = JSON.parse(await js(`var qa=s=>[...document.querySelectorAll(s)];
      return JSON.stringify({brief: qa('.dbr .verdict-body.brief').length, text: qa('.dbr .verdict-body:not(.brief)').length, aside: !!document.querySelector('.dbr .v-aside'),
        key: localStorage.getItem('magi.verdict.view')});`));
    ok('Text redraws the verdict and every unit', t.brief === 0 && t.text === 3 && t.aside, JSON.stringify(t));
    ok('the choice is remembered under MAGI’s key', t.key === 'text');
    await js(`document.querySelector('.dbr-scroll').scrollTop=0; 1`); await sleep(150);
    await shot(`debrief-${tag}-text`);

    // Same size on another tab, and it starts at the top.
    await js(`[...document.querySelectorAll('.dbr-tabs button')].find(b=>/Catalysts/.test(b.textContent)).click(); 1`); await sleep(250);
    const g3 = await geo();
    ok('another tab: the dialog keeps its size and place', g3.card[0] === g1.card[0] && g3.card[1] === g1.card[1], JSON.stringify([g1.card, g3.card]));

    // The News overlay: the build time as mm/dd/'yy h:mm AM/PM and "x ago".
    await js(`var host=document.getElementById('__dbr'); host.__root.unmount(); host.remove();
      var h2=document.createElement('div'); h2.id='__sum'; document.body.appendChild(h2); h2.__root=ReactDOM.createRoot(h2);
      h2.__root.render(React.createElement(window.tbNewsSummary.Overlay,{onClose:function(){}, summary:null, loading:true, error:'', generatedAt:new Date(2026,10,12,13,48).getTime(), eventCount:42})); 1`);
    await sleep(300);
    const meta = await js(`return document.querySelector('.nhs-head .nhs-meta').textContent;`);
    ok("News Summary: Built Thursday, 11/12/'26, 1:48 PM and how long ago, no event count", meta.includes("Built Thursday, 11/12/'26, 1:48 PM") && /(\d+[mhd] ago|now)/.test(meta) && !/events/.test(meta), meta);
    await shot(`summary-${tag}-meta`);
    await js(`var h2=document.getElementById('__sum'); h2.__root.unmount(); h2.remove(); 1`);
    await js(`window.MagiBrief.setView('brief'); 1`);
  }

  const real = errs.filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|NetworkError|recaptcha|appCheck|App Check|finnhub|workers\.dev/i.test(e));
  ok('no page errors', !real.length, real.join(' | '));
  console.log(`\n  screenshots: ${SHOTS}`);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
