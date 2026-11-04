// Webull fees for past trades reach the journal (2026-11-03). Real tradehub.html
// (TH_PAGE_FILE serves a work-in-progress copy), fake Firestore, fake worker.
//
// The journal already holds a round trip whose legs came from Webull on $0. The
// sync reports fees still unread; TradeHub asks /api/journal/fees until none are
// left, then the merge copies each fee onto its leg by Webull id. A fee typed by
// hand is never overwritten, and a second sync changes nothing.
//
// Run: node tests/live/tradehub-fees.live.js   (TH_PAGE_FILE=<copy>)
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
const kvEntry = (id, legId, action, price, fee, dt) => ({ id, source: 'webull', ticker: 'NVDA', side: action, qty: 2, avgFill: price, commission: fee, date: dt,
  legs: [{ id: legId, action, datetime: dt, qty: 2, price, fee }] });
const BUY_DT = '2026-10-20T14:00:00.000Z', SELL_DT = '2026-10-21T15:00:00.000Z', HAND_DT = '2026-10-22T15:00:00.000Z';
const before = () => [kvEntry('wb-b1', 'lb', 'BUY', 180, 0, BUY_DT), kvEntry('wb-s1', 'ls', 'SELL', 190, 0, SELL_DT), kvEntry('wb-s2', 'lh', 'SELL', 191, 0, HAND_DT)];
const after = () => [kvEntry('wb-b1', 'lb', 'BUY', 180, 0.01, BUY_DT), kvEntry('wb-s1', 'ls', 'SELL', 190, 0.03, SELL_DT), kvEntry('wb-s2', 'lh', 'SELL', 191, 0.02, HAND_DT)];
const S = { feeCalls: 0, synced: 0, remaining: 3 };
const worker = {
  patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const p = new URL(req.url).pathname;
    if (p === '/api/journal/sync') { S.synced++; return { json: { ok: true, data: S.remaining ? before() : after(), feesRemaining: S.remaining } }; }
    if (p === '/api/journal/fees') {
      S.feeCalls++;
      if (S.feeCalls === 1) return { json: { ok: true, phase: 'ids', idsFound: 3, updated: 0, remaining: 3, data: before() } };
      S.remaining = 0;
      return { json: { ok: true, phase: 'fees', checked: 3, updated: 3, remaining: 0, stopped: false, data: after() } };
    }
    if (p === '/api/portfolio/summary') return { json: { ok: true, data: { account: { totalValue: 1 }, positions: [], orders: [], history: [], activities: [], errors: {} } } };
    if (p === '/news') return { json: { events: [], generatedAt: NOW } };
    return { json: { ok: true } };
  },
};

(async () => {
  const c = await connect({ mock: firebaseMock(worker) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const js = (e) => evalJs(c, /^\s*return\b/.test(e) && !/;\s*$/.test(e) ? e + ';' : e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  const legs = () => js(`var d=__fakeFs.docs['dashboards/tradeboard_journal']||{}, out={}; Object.keys(d).filter(k=>k.startsWith('t_')).forEach(k=>(d[k].legs||[]).forEach(l=>{ out[l._wbId||l.id]=l.fee; })); return JSON.stringify(out);`).then(JSON.parse);

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
    localStorage.setItem('td6_mainDash','tony');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({
      'dashboards/tradeboard_journal': { savedAt: ${NOW - 86400000},
        't_rt': { id: 'rt', source: 'webull', ticker: 'NVDA', createdAt: ${Date.parse(BUY_DT)}, status: 'CLOSED', legs: [
          { id: 'x1', _wbId: 'wb-b1#lb', action: 'BUY', datetime: '2026-10-20T08:00', qty: '2', price: '180', fee: '0' },
          { id: 'x2', _wbId: 'wb-s1#ls', action: 'SELL', datetime: '2026-10-21T09:00', qty: '2', price: '190', fee: '0' } ] },
        't_hand': { id: 'hand', source: 'manual', ticker: 'NVDA', createdAt: ${Date.parse(HAND_DT)}, status: 'CLOSED', legs: [
          { id: 'h1', _wbId: 'wb-s2#lh', action: 'SELL', datetime: '2026-10-22T09:00', qty: '2', price: '191', fee: '0.50' } ] }
      }
    })); 1`);
  await c.send('Page.navigate', { url: URL_ });
  if (!(await until("document.querySelector('.tb-navtab')", 20000))) throw new Error('TradeHub did not render');

  console.log('\nThe morning sync reads the unread fees, then merges them');
  ok('it asked /api/journal/fees until none were left', await until(`true`, 100) && (await (async () => { for (let i = 0; i < 80 && S.feeCalls < 2; i++) await sleep(250); return S.feeCalls === 2; })()), S.feeCalls);
  ok('both Webull legs now carry their fee', await until(`(function(){var d=__fakeFs.docs['dashboards/tradeboard_journal']||{};var l=[];Object.keys(d).filter(k=>k.startsWith('t_')).forEach(k=>(d[k].legs||[]).forEach(x=>l.push(x)));var b=l.find(x=>x._wbId==='wb-b1#lb'),s=l.find(x=>x._wbId==='wb-s1#ls');return b&&s&&b.fee==='0.01'&&s.fee==='0.03';})()`, 15000), JSON.stringify(await legs()));
  ok('a fee typed by hand is left as it was', (await legs())['wb-s2#lh'] === '0.50', JSON.stringify(await legs()));
  ok('nothing was added or lost', await js(`var d=__fakeFs.docs['dashboards/tradeboard_journal'];var n=0;Object.keys(d).filter(k=>k.startsWith('t_')).forEach(k=>n+=(d[k].legs||[]).length);return n===3;`));
  await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="journal"]')].find(b=>b.offsetParent); t&&t.click(); 1`); await sleep(1000);
  ok('the Journal says what the sync did', await until(`/2 fees from Webull/.test(document.querySelector('#tradeboard-root').innerText)`, 5000), await js(`return (document.querySelector('#tradeboard-root').innerText.match(/Webull sync[^\\n]*/)||[''])[0];`));

  const real = errs.filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|NetworkError|recaptcha|appCheck|App Check|finnhub|workers\.dev/i.test(e));
  ok('no page errors', !real.length, real.join(' | '));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
