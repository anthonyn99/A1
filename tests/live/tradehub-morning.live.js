// TradeHub's morning, end to end (2026-11-03 audit). Real tradehub.html
// (TH_PAGE_FILE serves a work-in-progress copy), fake Firestore, fake workers.
//
//   1. The 6 AM Webull journal sync runs from the app-level orchestrator with
//      the Journal tab NEVER opened (it used to need the tab: the sync was only
//      registered by it, and the auto-launch opens Analysis). Phone-sized
//      devices still never sync.
//   2. The Analysis config the 6 AM launcher reads is pushed only once the CLOUD
//      copy has loaded: a device whose localStorage still says ChatGPT must not
//      overwrite the MAGI choice made elsewhere (2026-11-03 went to ChatGPT).
//   3. Catalysts prints ADP at 8:15 AM ET and the flash PMI at 9:45 AM ET (in
//      the viewer's zone), not the 8:30 / 10:00 of the broader rules.
//
// Run: node tests/live/tradehub-morning.live.js   (TH_PAGE_FILE=<copy> to test a copy)
'use strict';
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const URL_ = ORIGIN + '/A1/tradehub.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

const NOW = Date.now();
const six = new Date(); six.setHours(6, 0, 0, 0);
const SLOT = six.getTime() <= NOW ? six.getTime() : six.getTime() - 86400000;
const GEN = SLOT + 60000;
const ymd = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const TODAY = ymd(NOW);
const PROMPT = '## Daily Macro Report\n\nSummarize the overnight tape.';
const CAL = [
  { id: 'mc_macro_jobs_october-adp-employment_' + TODAY, date: TODAY, kind: 'macro', category: 'jobs', name: 'October ADP Employment', importance: 'medium' },
  { id: 'mc_macro_growth_november-s-p-global-flash-pmi_' + TODAY, date: TODAY, kind: 'macro', category: 'growth', name: 'November S&P Global Flash PMI', importance: 'medium' },
  { id: 'mc_macro_inflation_october-cpi-report_' + TODAY, date: TODAY, kind: 'macro', category: 'inflation', name: 'October CPI Report', importance: 'high' },
  { id: 'mc_earnings_NVDA_' + TODAY, date: TODAY, kind: 'earnings', category: 'earnings', name: 'NVDA Earnings', ticker: 'NVDA', when: 'amc', confirmed: true },
];
const EVENTS = [{ id: 'n1', primaryTicker: 'NVDA', sectors: ['Semiconductors'], impact: { tier: 'major', score: 70 }, sentiment: { label: 'bull', score: 0.5 }, eventType: 'earnings', aiAnalyzed: true, ts: NOW - 600000, summary: 'Nvidia up.', sources: [] }];
const WB_ORDER = { id: 'wb-o1', source: 'webull', ticker: 'NVDA', side: 'BUY', qty: 2, avgFill: 181.5, date: new Date(SLOT - 3600000).toISOString(),
  legs: [{ id: 'l1', action: 'BUY', datetime: new Date(SLOT - 3600000).toISOString(), qty: 2, price: 181.5, fee: 0 }] };

const seen = [];   // every worker request, as {method, path, body}
const worker = {
  patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    let body = null; try { body = req.postData ? JSON.parse(req.postData) : null; } catch (e) {}
    seen.push({ method: req.method, path: new URL(req.url).pathname, body, t: Date.now() });
    if (/\/api\/journal\/sync/.test(req.url)) return { json: { ok: true, data: [WB_ORDER] } };
    if (/\/api\/portfolio\/summary/.test(req.url)) return { json: { ok: true, data: { account: { totalValue: 1000, cashBalance: 100 }, positions: [], orders: [], history: [], activities: [], errors: {} } } };
    if (/\/news\?/.test(req.url)) return { json: { events: EVENTS, generatedAt: GEN, cached: true } };
    if (/\/calendar\?/.test(req.url)) return { json: { events: CAL, generatedAt: GEN } };
    if (/\/summary\?/.test(req.url)) return { json: { ok: false } };
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
  const tab = async (id) => { await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(b=>b.offsetParent); if(t) t.click(); 1`); await sleep(900); };

  async function seed({ mainDash = 'tony' } = {}) {
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
      localStorage.setItem('td6_mainDash', ${JSON.stringify(mainDash)});
      // This device's own copy is STALE: it still says ChatGPT.
      localStorage.setItem('td6_analysis_cfg', JSON.stringify({aiSite:'chatgpt', analysisPromptId:'p1', magiMigrated:1, searches:['old search']}));
      localStorage.setItem('td6_watchlist', JSON.stringify(['NVDA','MU']));
      sessionStorage.setItem('__fakefs_docs', JSON.stringify({
        'dashboards/tradeboard_prompts': { savedAt: ${NOW}, prompts: [{ id: 'p1', name: 'Daily Macro Report', text: ${JSON.stringify(PROMPT)} }] },
        'dashboards/tradeboard_analysis': { cfg: { aiSite: 'magi', magiUnits: ['chatgpt','gemini'], analysisPromptId: 'p1', magiMigrated: 1, searches: ['Iran Hormuz latest updates'] } },
        'dashboards/tradeboard_watchlist': { tickers: ['NVDA','MU'], trash: [], savedAt: ${NOW} },
        'dashboards/tradeboard_news': { events: ${JSON.stringify(EVENTS)}, generatedAt: ${GEN}, savedAt: ${GEN} },
        'dashboards/market_calendar': { events: ${JSON.stringify(CAL)}, generatedAt: ${GEN}, savedAt: ${GEN}, watchlist: ['NVDA','MU'] },
        'dashboards/tradeboard_journal': { savedAt: ${NOW - 86400000}, 't_m1': { id: 'm1', source: 'manual', ticker: 'AAPL', createdAt: ${NOW - 86400000 * 3}, status: 'CLOSED',
          legs: [{ id: 'a', action: 'BUY', datetime: '2026-10-01T10:00', qty: '1', price: '200', fee: '0' }, { id: 'b', action: 'SELL', datetime: '2026-10-02T10:00', qty: '1', price: '210', fee: '0' }] } }
      })); 1`);
  }

  console.log('\n1. The morning journal sync, Journal tab never opened');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await seed();
  seen.length = 0;
  await c.send('Page.navigate', { url: URL_ });
  if (!(await until("document.querySelector('.tb-navtab')", 20000))) throw new Error('TradeHub did not render');
  ok('it opens on Portfolio', await js(`return !document.querySelector('#tradeboard-root .tb-journal-page') && /Portfolio/.test(document.querySelector('#tradeboard-root').innerText);`));
  const synced = await until(`Object.keys((__fakeFs.docs['dashboards/tradeboard_journal']||{})).some(k=>k.startsWith('t_')&&__fakeFs.docs['dashboards/tradeboard_journal'][k].ticker==='NVDA')`, 20000);
  ok('the worker was asked to sync', seen.some(r => r.method === 'POST' && r.path === '/api/journal/sync'), JSON.stringify(seen.map(r => r.method + ' ' + r.path)));
  ok('the Webull fill reached the journal document', synced);
  ok('the hand-entered trade is still there', await js(`return !!(__fakeFs.docs['dashboards/tradeboard_journal']||{}).t_m1;`));
  ok('this morning is stamped as synced', await js(`return +localStorage.getItem('tb_last_webull_sync') >= ${SLOT};`));
  const syncs = seen.filter(r => r.path === '/api/journal/sync').length;
  await sleep(3000);
  ok('…exactly once', seen.filter(r => r.path === '/api/journal/sync').length === syncs && syncs === 1, syncs);

  console.log('\n2. The launcher\'s Analysis config waits for the cloud copy');
  const pushes = seen.filter(r => r.method === 'POST' && r.path === '/analysis-config');
  ok('it was pushed', pushes.length >= 1, pushes.length);
  ok('never with this device\'s stale ChatGPT copy', pushes.every(p => p.body && /\/magi\.html$/.test(p.body.aiUrl || '')), JSON.stringify(pushes.map(p => p.body && p.body.aiUrl)));
  ok('…carrying the cloud\'s units and searches', pushes.length && JSON.stringify(pushes[pushes.length - 1].body.magiUnits) === '["chatgpt","gemini"]'
    && JSON.stringify(pushes[pushes.length - 1].body.searches) === '["Iran Hormuz latest updates"]', pushes.length && JSON.stringify(pushes[pushes.length - 1].body));

  console.log('\n3. Release times');
  await tab('catalysts');
  await until(`/ADP Employment/.test(document.querySelector('#tradeboard-root').innerText)`, 8000);
  const times = JSON.parse(await js(`
    // The instant New York's wall clock reads hh:mm today, in this viewer's zone.
    var D=${JSON.stringify(TODAY)}, f=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit'});
    function at(hh,mm){ for(var t=Date.parse(D+'T00:00:00Z');t<Date.parse(D+'T00:00:00Z')+36*3600e3;t+=15*60e3){ var p=f.format(new Date(t)).replace(/^24/,'00'); if(p===String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0')) return new Date(t).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}); } return '?'; }
    var rows=[...document.querySelectorAll('#tradeboard-root *')].filter(e=>e.children.length<8&&/ADP Employment|Flash PMI|CPI Report/.test(e.innerText||'')&&e.innerText.length<160);
    function rowOf(re){ var r=rows.filter(e=>re.test(e.innerText)).sort((a,b)=>a.innerText.length-b.innerText.length); return r.length?r[r.length-1].innerText.replace(/\\s+/g,' '):''; }
    return JSON.stringify({adp:rowOf(/ADP/), pmi:rowOf(/Flash PMI/), cpi:rowOf(/CPI Report/), want:{adp:at(8,15), pmi:at(9,45), cpi:at(8,30)}});`));
  ok('ADP at 8:15 AM ET', times.adp.includes(times.want.adp), JSON.stringify(times));
  ok('S&P Global flash PMI at 9:45 AM ET', times.pmi.includes(times.want.pmi), JSON.stringify(times));
  ok('CPI still at 8:30 AM ET', times.cpi.includes(times.want.cpi), JSON.stringify(times));

  console.log('\n4. A phone never syncs');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await seed({ mainDash: 'veda' });
  seen.length = 0;
  await c.send('Page.navigate', { url: URL_ });
  await until("document.querySelector('.tb-navtab')", 20000);
  await sleep(7000);
  ok('no journal sync from a device that is not the main one', !seen.some(r => r.path === '/api/journal/sync'), JSON.stringify(seen.map(r => r.method + ' ' + r.path)));

  const real = errs.filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|NetworkError|recaptcha|appCheck|App Check|finnhub|workers\.dev/i.test(e));
  ok('no page errors', !real.length, real.join(' | '));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
