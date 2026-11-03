// TradeHub ▸ Analysis ▸ Debrief (2026-11-03), in the real page against the fake
// Firestore and a fake newshub. MAGI is never opened: its answer is copied from
// the run MAGI synced (dashboards/magi + runs/{id}), seeded here.
//
//   1. The Debrief button: three tabs when the Analysis prompt goes to MAGI
//      (today's catalysts, the news summary, MAGI's verdict and each unit's
//      answer), two when it goes to a chat site
//   2. The backdrop wears popups.js's look (rgba(0,0,0,.6), blur 7px)
//   3. Desktop, tablet and phone: no sideways scroll; screenshots of each tab
//   4. The morning: tradehub.html#tbdebrief with everything in → Analysis with
//      the Debrief open; MAGI not back yet → it waits, and opens the moment the
//      run lands; no #tbdebrief → nothing happens
//
// Run: node tests/live/tradehub-debrief.live.js   (TH_PAGE_FILE=<copy>)
'use strict';
const fs = require('fs');
const path = require('path');
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const URL_ = ORIGIN + '/A1/tradehub.html';
const SHOTS = process.env.SHOTS_DIR || path.join(require('os').tmpdir(), 'tradehub-debrief-shots');
fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

const NOW = Date.now();
const six = new Date(); six.setHours(6, 0, 0, 0);
const SLOT = six.getTime() <= NOW ? six.getTime() : six.getTime() - 86400000;   // tbLastMorningSlot
const GEN = SLOT + 60000;
const ymd = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TODAY = ymd(NOW), LATER = ymd(NOW + 3 * 86400000);
const PROMPT = '## Daily Macro Report\n\nSummarize overnight macro, futures and the day ahead for my watchlist.';
const src = (h, m) => ({ headline: h, url: 'https://example.com/' + encodeURIComponent(h), name: 'Reuters', ts: NOW - m * 60000 });
const EVENTS = [
  { id: 'n1', primaryTicker: 'NVDA', sectors: ['Semiconductors'], impact: { tier: 'critical', score: 92 }, sentiment: { label: 'bull', score: 0.6 }, eventType: 'earnings', aiAnalyzed: true, ts: NOW - 600000, summary: 'Nvidia guides above estimates.', sources: [src('Nvidia raises guidance', 10)] },
  { id: 'n2', primaryTicker: 'MU', sectors: ['Semiconductors'], impact: { tier: 'major', score: 70 }, sentiment: { label: 'bear', score: -0.4 }, eventType: 'analyst', aiAnalyzed: true, ts: NOW - 3600000, summary: 'Micron cut at two brokers.', sources: [src('Micron downgraded', 60)] },
];
const CAL = [
  { id: 'c1', date: TODAY, kind: 'macro', category: 'inflation', name: 'CPI Report', importance: 'high' },
  { id: 'c2', date: TODAY, kind: 'macro', category: 'jobs', name: 'Jobless Claims', importance: 'medium' },
  { id: 'c3', date: TODAY, kind: 'earnings', category: 'earnings', name: 'NVDA Earnings', ticker: 'NVDA', when: 'amc', confirmed: true },
  { id: 'c4', date: LATER, kind: 'earnings', category: 'earnings', name: 'MU Earnings', ticker: 'MU', when: 'bmo', confirmed: true },
];
const SUMMARY = { headline: 'Chips split on guidance as yields hold', tone: 'mixed', toneScore: 0.1, overview: 'A split tape into CPI.',
  keyPoints: [{ text: 'NVDA guides above estimates.', stance: 'bull', tickers: ['NVDA'] }], tickers: [], themes: [], risks: ['A hot CPI print.'], watch: ['CPI at 8:30 ET'], model: 'gemini-2.5-flash' };
const RUN_ID = 'run-morning-1';
const CREATED = new Date(SLOT + 5 * 60000).toISOString();
const ROW = { id: RUN_ID, question: PROMPT.slice(0, 300), status: 'complete', created_at: CREATED, total_ms: 52000, responded_count: 2, attempted_count: 3, sid: RUN_ID, turn: 1 };
const BODY = {
  run: { id: RUN_ID, question: PROMPT, status: 'complete', created_at: CREATED, total_ms: 52000 },
  answers: [
    { provider_id: 'chatgpt', display_name: 'ChatGPT', ok: true, answer_text: '## Futures\n\n- **ES** up 0.4%\n- Yields flat', char_count: 1200, model: 'GPT-5' },
    { provider_id: 'claude', display_name: 'Claude', ok: true, answer_text: 'Risk-on into CPI.', char_count: 800, model: 'Sonnet 5.5' },
    { provider_id: 'gemini', display_name: 'Gemini', ok: false, failure_kind: 'timeout', error_detail: 'Gemini did not answer in time.' },
  ],
  synthesis: { ok: true, verdict_text: '## Verdict\n\n**Lean long** semis into CPI; hedge with a tight stop.\n\n| Ticker | Bias |\n|---|---|\n| NVDA | Long |\n| MU | Wait |', chairman_provider: 'claude', model: 'Sonnet 5.5', members_responded: 2, members_total: 3 },
};

const worker = {
  patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    if (/\/news\?/.test(req.url)) return { json: { events: EVENTS, generatedAt: GEN, cached: true } };
    if (/\/calendar\?/.test(req.url)) return { json: { events: CAL, generatedAt: GEN } };
    if (/\/summary\?/.test(req.url)) { const g = +((/[?&]gen=(\d+)/.exec(req.url) || [])[1] || 0); return { json: { ok: true, summary: SUMMARY, generatedAt: g } }; }
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
  const size = (w, h) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const tab = async (id) => { await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(b=>b.offsetParent); if(t) t.click(); 1`); await sleep(700); };
  const dTab = async (label) => { await js(`var b=[...document.querySelectorAll('.dbr-tabs button')].find(x=>x.textContent.indexOf(${JSON.stringify(label)})===0); if(b) b.click(); 1`); await sleep(500); };
  const tabs = () => js(`return [...document.querySelectorAll('.dbr-tabs button')].map(b=>b.textContent).join('|');`);
  const isOpen = "document.querySelector('.dbr')";
  const onAnalysis = "document.querySelector('#tradeboard-root .ana-page')";

  async function seed({ aiSite = 'magi', magiRow = true, digest = true } = {}) {
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
      localStorage.setItem('td6_analysis_cfg', JSON.stringify({aiSite:${JSON.stringify(aiSite)}, magiUnits:['chatgpt','claude','gemini'], analysisPromptId:'p1', magiMigrated:1}));
      ${digest ? `localStorage.setItem('tb_news_summary', JSON.stringify({gen:${GEN}, data:${JSON.stringify(SUMMARY)}}));` : ''}
      sessionStorage.setItem('__fakefs_docs', JSON.stringify({
        'dashboards/tradeboard_prompts': { savedAt: ${NOW}, prompts: [{ id: 'p1', name: 'Daily Macro Report', text: ${JSON.stringify(PROMPT)} }] },
        'dashboards/tradeboard_watchlist': { tickers: ['NVDA','MU'], trash: [], savedAt: ${NOW} },
        'dashboards/tradeboard_news': { events: ${JSON.stringify(EVENTS)}, generatedAt: ${GEN}, savedAt: ${GEN} },
        'dashboards/market_calendar': { events: ${JSON.stringify(CAL)}, generatedAt: ${GEN}, savedAt: ${GEN}, watchlist: ['NVDA','MU'] },
        'dashboards/magi': { runs: ${magiRow ? JSON.stringify([ROW]) : '[]'} },
        'dashboards/magi/runs/${RUN_ID}': ${JSON.stringify(BODY)}
      })); 1`);
  }
  async function open(hash) {
    await c.send('Page.navigate', { url: URL_ + (hash || '') });
    if (!(await until("document.querySelector('.tb-navtab')", 20000))) throw new Error('TradeHub did not render');
  }

  console.log('\n1. The Debrief button (MAGI)');
  await size(1440, 1000);
  await seed();
  await open('');
  await sleep(2500);
  await tab('analysis');
  const btn = await js(`var b=[...document.querySelectorAll('#tradeboard-root .ana-page .tbx-actions button')].find(x=>x.textContent.trim()==='Debrief'); if(b){b.click();return true;} return false;`);
  ok('Analysis has a Debrief button, and it opens the popup', btn && await until(isOpen, 5000));
  ok('three tabs: Catalysts (with today\'s count), News Summary, MAGI', (await tabs()) === 'Catalysts3|News Summary|MAGI', await tabs());
  ok('Catalysts shows only today\'s cards, as Catalysts draws them', await until(`document.querySelectorAll('.dbr-cats .cat-card').length>=2`, 6000) &&
    await js(`var t=document.querySelector('.dbr-cats').innerText; return /CPI Report/.test(t)&&/NVDA/.test(t)&&!/\\bMU\\b/.test(t);`), await js(`return (document.querySelector('.dbr-cats')||{}).innerText;`));
  const bd = JSON.parse(await js(`var o=document.querySelector('.dbr').parentElement, cs=getComputedStyle(o); return JSON.stringify({bg:cs.backgroundColor, bf:cs.backdropFilter||cs.webkitBackdropFilter, tag:o.hasAttribute('data-a1-scrim')});`));
  ok('the backdrop wears the shared popup look (popups.js)', bd.bg === 'rgba(0, 0, 0, 0.6)' && /blur\(7px\)/.test(bd.bf) && bd.tag, JSON.stringify(bd));
  await shot('debrief-desktop-catalysts');
  await dTab('News Summary');
  ok('News Summary shows the latest build\'s digest', await until(`(document.querySelector('.dbr .nhs-headline')||{}).textContent===${JSON.stringify(SUMMARY.headline)}`, 6000));
  await shot('debrief-desktop-summary');
  await dTab('MAGI');
  ok('MAGI shows the council\'s verdict, copied from the synced run', await until(`/Lean long/.test((document.querySelector('.dbr-magi .dbr-doc')||{}).innerText||'')`, 6000));
  const m = JSON.parse(await js(`var q=s=>document.querySelector(s); return JSON.stringify({meta:q('.dbr-magi-meta').innerText, table:!!q('.dbr-magi .dbr-doc table'), units:[...document.querySelectorAll('.dbr-unit summary')].map(s=>s.innerText.replace(/\\s+/g,' '))});`));
  ok('…with who answered and who synthesised it, as MAGI says it', /2 of 3 units responded · synthesised by Claude/.test(m.meta) && /52s/.test(m.meta), m.meta);
  ok('…rendered as Markdown (its table too)', m.table);
  ok('…and each unit\'s own answer, a failed one marked', m.units.length === 3 && /ChatGPT/.test(m.units[0]) && /no answer/.test(m.units[2]), JSON.stringify(m.units));
  await js(`document.querySelector('.dbr-unit summary').click(); 1`); await sleep(200);
  ok('a unit opens to its full answer, inside its own row', await js(`var u=document.querySelector('.dbr-unit[open]'), d=u.querySelector('.dbr-doc'), a=u.getBoundingClientRect(), b=d.getBoundingClientRect();
    return /ES/.test(d.innerText) && b.top>=a.top && b.bottom<=a.bottom+1 && b.left>=a.left;`));
  await shot('debrief-desktop-magi');

  for (const [w, h, tag] of [[820, 1180, 'tablet'], [390, 844, 'phone']]) {
    await size(w, h); await sleep(600);
    for (const t of ['Catalysts', 'News Summary', 'MAGI']) {
      await dTab(t);
      const r = JSON.parse(await js(`var card=document.querySelector('.dbr').getBoundingClientRect(); return JSON.stringify({w:card.width, vw:innerWidth, side:document.documentElement.scrollWidth>innerWidth+1,
        out:[...document.querySelectorAll('.dbr *')].filter(e=>{var b=e.getBoundingClientRect(); return b.width&&b.right>card.right+1&&!e.closest('table');}).map(e=>e.className||e.tagName).slice(0,4)});`));
      ok(`${tag} · ${t}: fits, nothing pokes out`, !r.side && !r.out.length && (tag !== 'phone' || Math.abs(r.w - r.vw) <= 1), JSON.stringify(r));
      await shot(`debrief-${tag}-${t.toLowerCase().replace(' ', '-')}`);
    }
  }
  await size(1440, 1000);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`); await sleep(300);
  ok('Escape closes it', !(await js(`return !!(${isOpen});`)));
  await js(`[...document.querySelectorAll('#tradeboard-root .ana-page .tbx-actions button')].find(x=>x.textContent.trim()==='Debrief').click(); 1`);
  ok('reopened, it is back on the tab it was closed on (MAGI)', await until(isOpen, 5000) && await js(`return (document.querySelector('.dbr-tabs button.on')||{}).textContent==='MAGI';`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`); await sleep(300);

  console.log('\n2. A chat site instead of MAGI');
  await seed({ aiSite: 'chatgpt' });
  await open('');
  await sleep(2000);
  await tab('analysis');
  await js(`[...document.querySelectorAll('#tradeboard-root .ana-page .tbx-actions button')].find(x=>x.textContent.trim()==='Debrief').click(); 1`);
  ok('two tabs: Catalysts and News Summary', await until(isOpen, 5000) && (await tabs()) === 'Catalysts3|News Summary', await tabs());

  console.log('\n3. The morning');
  await seed();
  await open('#tbdebrief');
  ok('everything in: Analysis with the Debrief open', await until(`${onAnalysis} && ${isOpen}`, 20000));
  ok('#tbdebrief is gone from the address and the request is used up', await js(`return location.hash==='' && sessionStorage.getItem('tb_debrief_wait')===null;`));
  await open('');
  await sleep(4000);
  ok('a reload afterwards opens TradeHub normally', !(await js(`return !!(${isOpen});`)));

  await seed({ magiRow: false });
  await open('#tbdebrief');
  await sleep(6000);
  ok('MAGI not back yet: it waits (no popup, no tab switch)', !(await js(`return !!(${isOpen}) || !!(${onAnalysis});`)));
  await js(`__fakeFs.remote('dashboards/magi', { runs: [${JSON.stringify(ROW)}] }); 1`);
  ok('the run lands: Analysis with the Debrief open, on its own', await until(`${onAnalysis} && ${isOpen}`, 10000));
  await dTab('MAGI');
  ok('…with MAGI\'s answer in it', await until(`/Lean long/.test((document.querySelector('.dbr-magi .dbr-doc')||{}).innerText||'')`, 6000));

  await seed();
  await open('');
  await sleep(5000);
  ok('without #tbdebrief nothing opens by itself', !(await js(`return !!(${isOpen});`)));

  const real = errs.filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|NetworkError|recaptcha|appCheck|App Check|finnhub|workers\.dev/i.test(e));
  ok('no page errors', !real.length, real.join(' | '));
  console.log(`\n  screenshots: ${SHOTS}`);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
