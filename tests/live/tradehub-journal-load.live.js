// The Journal loads even when something asks for it before Firebase is up
// (2026-11-09). Portfolio, the first tab, reads the journal on open for its
// Realized P&L. When that ran before Firebase had started, the load failed with
// "firebase not ready", the Journal tab's own load was handed that same failed
// attempt, and it showed "Could not load your journal" for good.
//
// Real tradehub.html (TH_PAGE_FILE serves a work-in-progress copy), fake
// Firestore and worker. Firebase's journal loader and its fb-ready signal are
// held back 3 s, so TradeHub opens on Portfolio before Firebase is ready.
//
// Run: node tests/live/tradehub-journal-load.live.js   (TH_PAGE_FILE=<copy>)
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
const iso = (d) => new Date(NOW - d * 86400000).toISOString().slice(0, 16);
const worker = {
  patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    const p = new URL(req.url).pathname;
    if (p === '/api/journal/sync') return { json: { ok: true, data: [] } };
    if (p === '/api/portfolio/summary') return { json: { ok: true, data: { account: { totalValue: 5000 }, positions: [], orders: [], history: [], activities: [], errors: {} } } };
    if (p === '/news') return { json: { events: [], generatedAt: NOW } };
    return { json: { ok: true } };
  },
};

// Hold Firebase's journal loader and its fb-ready event back by 3 s.
const DELAY_FB = `(function(){
  var held=null;
  Object.defineProperty(window,'_fbLoadTBJournal',{configurable:true,get:function(){return undefined;},set:function(v){held=v;}});
  var orig=window.dispatchEvent.bind(window);
  window.dispatchEvent=function(e){
    if(e&&e.type==='fb-ready'&&!window.__fbReleased){
      setTimeout(function(){window.__fbReleased=true;
        Object.defineProperty(window,'_fbLoadTBJournal',{configurable:true,writable:true,value:held});
        orig(e);},3000);
      return true;
    }
    return orig(e);
  };
})();`;

(async () => {
  const c = await connect({ mock: firebaseMock(worker) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const js = (e) => evalJs(c, /^\s*return\b/.test(e) && !/;\s*$/.test(e) ? e + ';' : e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };

  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1'); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
    localStorage.setItem('td6_mainDash','tony'); localStorage.setItem('tb_page','portfolio');
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({
      'dashboards/tradeboard_journal': { savedAt: ${NOW - 86400000},
        't_a': { id: 'a', source: 'manual', ticker: 'NVDA', createdAt: ${NOW - 5 * 86400000}, status: 'CLOSED', legs: [
          { id: 'a1', action: 'BUY', datetime: '${iso(5)}', qty: '2', price: '100', fee: '0' },
          { id: 'a2', action: 'SELL', datetime: '${iso(1)}', qty: '2', price: '110', fee: '0' } ] },
        't_b': { id: 'b', source: 'manual', ticker: 'MU', createdAt: ${NOW - 2 * 86400000}, status: 'OPEN', legs: [
          { id: 'b1', action: 'BUY', datetime: '${iso(2)}', qty: '1', price: '90', fee: '0' } ] }
      }
    })); 1`);
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: DELAY_FB });
  await c.send('Page.navigate', { url: URL_ });
  if (!(await until("document.querySelector('.tb-navtab')", 20000))) throw new Error('TradeHub did not render');

  console.log('\nTradeHub opens on Portfolio before Firebase is ready');
  ok('Firebase was really held back at first', await js(`return !window.__fbReleased;`));
  await until(`window.__fbReleased`, 8000); await sleep(1500);
  await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="journal"]')].find(b=>b.offsetParent); t&&t.click(); 1`);
  ok('the Journal shows its trades, not "Could not load your journal"',
    await until(`document.querySelectorAll('.tbj-tbl tbody tr:not(.tbj-day)').length===2`, 10000)
    && !(await js(`return /Could not load your journal/.test(document.querySelector('#tradeboard-root').innerText);`)),
    await js(`return (document.querySelector('#tradeboard-root').innerText.match(/Could not load[^\\n]*\\n[^\\n]*/)||[document.querySelectorAll('.tbj-tbl tbody tr').length+' rows'])[0];`));
  await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="portfolio"]')].find(b=>b.offsetParent); t&&t.click(); 1`);
  ok('Portfolio\'s Realized P&L reads the journal (+$20.00)', await until(`/Realized P&L\\s*\\+?\\$20\\.00/i.test(document.querySelector('#tradeboard-root').innerText)`, 8000),
    await js(`return (document.querySelector('#tradeboard-root').innerText.match(/Realized P&L[^\\n]*\\n?[^\\n]*/i)||[''])[0];`));

  const real = errs.filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|NetworkError|recaptcha|appCheck|App Check|finnhub|workers\.dev/i.test(e));
  ok('no page errors', !real.length, real.join(' | '));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
