// Neo Cortex N8 (A1-Priv docs/TradeHub/quant/n4-08.md): the daily brief and Neo Cortex's alerts in the real page,
// quant-api and quant-bot played here. The Daily brief card (numbers, Claude's review, tomorrow, the week) and its
// history picker; the deep links a push carries (cortex:brief:<day>, cortex:today:<day>:<id>); Control ▸ Alerts ▸ Neo
// Cortex and the Status card's Alerts button; the bell's Neo Cortex filter; Analysis ▸ Debrief ▸ Neo Cortex; three widths.
//
// Run: node tests/live/tradehub-cortex-brief.live.js   (own CDP_PORT; TH_PAGE_FILE=<copy> to try an unshipped page)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, KEY } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const BOT = 'https://quant-bot.anthony-account-3.workers.dev';
const FRI = '2026-11-20';

function fakeBot() {
  const s = { calls: [] };
  const now = Date.now(), today = new Date(now - 5 * 3600000).toISOString().slice(0, 10);
  const events = [{ id: 7, ts: now - 600000, kind: 'entry', sym: 'NVDA', side: 'short', qty: 5, price: 168.6, strategy: 'vwap-rej', version: 1, why: 'Rejected at VWAP for the third time; stop $169.40.', thesis: 'Weak names fade at VWAP' }];
  const brief = (day) => ({
    day, at: now - 3600000, mode: 'paper', book: 5000, maxDeployed: 3000, equity: 5084.2, pnl: 84.2, pnlPct: 1.68, spyPct: 0.41, vsSpy: 1.27,
    trades: 7, wins: 5, winRate: 5 / 7, pf: 2.3, best: { symbol: 'AMD', pnl: 31.8, r: 2 }, worst: { symbol: 'TSLA', pnl: -12.5, r: -1 },
    perStrategy: [{ id: 'semis-orb', trades: 4, wins: 3, pnl: 61.2, stage: 'active', total: { trades: 15, winRate: 0.64, pf: 1.8, pnl: 212.4 } }],
    changes: [{ id: 'gap-fade', stage: 'killed', why: 'Killed: best case 38% won at 90% confidence after 11 trades' }],
    deployedPeak: 1940, riskUsedPct: 64.67, shadow: { decisions: 0 },
    headline: 'Up $84.20 (+1.68%) vs SPY +0.41% · 7 trades, 5 won.', commentary: 'The semis breakout keeps working while semis lead. CPI tomorrow: half size until 10:00.',
    claude: true, lineup: [{ id: 'orb2', name: 'Semis ORB v2' }], retired: [], ready: true, readyAt: now - 3000000,
    ...(day === FRI ? { week: { from: '2026-11-16', to: FRI, days: 5, pnl: 240.5, trades: 22, wins: 14, winRate: 14 / 22, pf: 1.9, best: { symbol: 'MU', pnl: 48, day: '2026-11-18' }, worst: { symbol: 'TSLA', pnl: -20, day: '2026-11-17' } } } : {}),
  });
  s.handle = (req) => {
    const u = new URL(req.url), p = u.pathname, auth = req.headers.Authorization || req.headers.authorization || '';
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    s.calls.push(p + u.search);
    if (auth !== 'Bearer ' + KEY) return { status: 401, json: { error: 'unauthorized' } };
    if (p === '/state') return { json: { ok: true, mode: 'paper', paused: false, market: 'closed', equity: 5084.2, dayPnl: 84.2, deployed: 0, positions: [], shadowSessions: 2, halted: null, lastCheck: now - 60000, limits: { book: 5000, maxDeployed: 3000 } } };
    if (p === '/today') return { json: { ok: true, day: u.searchParams.get('day'), events: u.searchParams.get('day') === today ? events : events }, headers: { etag: '"x-' + u.searchParams.get('day') + '"' } };
    if (p === '/lifecycle') return { json: { ok: true, strategies: [], setups: [], review: null } };
    if (p === '/lab/runs') return { json: { ok: true, runs: [] } };
    if (p === '/briefs') return { json: { ok: true, briefs: [{ day: today, ready: true, headline: 'h', week: false }, { day: FRI, ready: true, headline: 'h', week: true }] } };
    if (p.startsWith('/brief/')) return { json: { ok: true, day: p.slice(7), brief: brief(p.slice(7)) } };
    if (p === '/settings') return { json: { ok: true, version: 1, settings: { mode: 'paper', paused: false } } };
    return { status: 404, json: { ok: false, error: 'no route ' + p } };
  };
  s.today = today;
  return s;
}

(async () => {
  const api = quantApi(), bot = fakeBot();
  const base = api.mock.handle.bind(api.mock);
  const mock = { ...api.mock, patterns: [...api.mock.patterns, BOT + '/*'], handle: (req) => (req.url.startsWith(BOT) ? bot.handle(req) : base(req)) };
  const c = await connect({ mock });
  const errs = [];
  await c.send('Network.enable'); await c.send('Network.clearBrowserCache');
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  const cons = [];   // console errors: React reports a render failure there, with the component
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') cons.push(m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 600));
  });
  const { js, until, size, boot, tab } = driver(c);
  const card = (id) => `document.querySelector('[data-ncx-card="${id}"]')`;
  const route = (r) => js(`var A=await import('/A1/TradeHub/ui/alerts.js'); A.routeAlert(${JSON.stringify(r)}); return 1;`);

  try {
    console.log('\n1. The Daily brief card (1280)');
    await size(1280 + 224, 900);
    await boot({ quant: true });
    await tab('cortex');
    ok('the brief: Ready, the day\'s P&L against SPY, trades, risk used', await until(`${card('brief')} && /Ready/i.test(${card('brief')}.innerText) && /\\+\\$84\\.20/.test(${card('brief')}.innerText) && /SPY \\+0\\.41%/.test(${card('brief')}.innerText) && /\\$1,940\\.00/.test(${card('brief')}.innerText)`, 10000), await js(`return ${card('brief')} && ${card('brief')}.innerText;`));
    ok('...best and worst, what changed, each strategy', await js(`var t=${card('brief')}.innerText; return /AMD · \\+\\$31\\.80 \\(2\\.0R\\)/.test(t) && /gap-fade/.test(t) && /killed/i.test(t) && /semis-orb/.test(t) && /4 today/.test(t);`), await js(`return ${card('brief')}.innerText;`));
    ok('...Claude\'s review and tomorrow\'s line-up', await js(`var t=${card('brief')}.innerText; return /Claude's review/i.test(t) && /half size until 10:00/.test(t) && /Semis ORB v2/.test(t);`));
    ok('...no week block on an ordinary day', await js(`return !${card('brief')}.querySelector('[data-ncx-week]');`));
    await js(`var s=${card('brief')}.querySelector('[data-ncx-briefday]'); s.value=${JSON.stringify(FRI)}; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
    ok('the history picker: Friday\'s brief carries the week', await until(`!!${card('brief')}.querySelector('[data-ncx-week]') && /This week/i.test(${card('brief')}.innerText) && /\\+\\$240\\.50/.test(${card('brief')}.innerText)`, 8000), await js(`return ${card('brief')}.innerText;`));
    ok('...and Today moved to that day too (one day for the tab)', await js(`return document.querySelector('[data-ncx-day]').value === ${JSON.stringify(FRI)};`));

    console.log('\n2. Deep links from a push');
    await tab('portfolio');
    await route('cortex:brief:' + bot.today);
    ok('cortex:brief:<day> opens the tab on that day\'s brief', await until(`!!document.querySelector('[data-cortex-tab]') && document.querySelector('[data-ncx-brief]') && document.querySelector('[data-ncx-brief]').getAttribute('data-ncx-brief') === ${JSON.stringify(bot.today)}`, 10000));
    await tab('portfolio');
    await route('cortex:today:' + bot.today + ':7');
    ok('cortex:today:<day>:<id> opens that move\'s drawer', await until(`(function(){ var d=document.querySelector('[data-ncx-drawer]'); return d && /Rejected at VWAP/.test(d.innerText); })()`, 10000));
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`);
    await until(`!document.querySelector('[data-ncx-drawer]')`, 3000);

    console.log('\n3. Control ▸ Alerts ▸ Neo Cortex');
    await tab('cortex');
    await until(`!!${card('status')} && !!${card('status')}.querySelector('[data-ncx="alerts"]')`, 8000);
    await js(`${card('status')}.querySelector('[data-ncx="alerts"]').click(); 1`);
    ok('the Status card\'s Alerts button lands on the Neo Cortex section', await until(`(function(){ var b=document.querySelector('[data-al-cortex]'); if(!b) return false; var r=b.getBoundingClientRect(); return r.height>0 && r.top < innerHeight && r.bottom > 0; })()`, 8000));
    ok('...its five switches, all on by default', await js(`var x=[...document.querySelectorAll('[data-al-cortex-on]')]; return x.length===5 && x.every(function(i){return i.checked;}) && x.map(function(i){return i.getAttribute('data-al-cortex-on');}).join()==='trades,changes,guards,research,brief';`));
    ok('...and the kind itself is under its own heading', await js(`return !!document.querySelector('[data-tal-group="neo-cortex"] [data-tal-kind="cortex"]');`));
    ok('Add alert does not offer Neo Cortex (it has switches, not rules)', await js(`var s=document.querySelector('[data-tal-newkind]'); return !!s && ![...s.options].some(function(o){return o.value==='cortex';});`));
    await js(`document.querySelector('[data-al-cortex-on="trades"]').click(); 1`);
    ok('unticking Trades saves cortex.trades = false', await until(`true`, 100) && await (async () => { for (let i = 0; i < 30; i++) { const p = api.posted && api.posted.alertCfg; if (p && p.length && p[p.length - 1].cortex && p[p.length - 1].cortex.trades === false) return true; await sleep(200); } return false; })(), JSON.stringify(api.posted && api.posted.alertCfg && api.posted.alertCfg.slice(-1)));
    const filters = await js(`var A=await import('/A1/TradeHub/data/alerts.js'); return JSON.stringify(A.FILTERS.find(function(f){return f.k==='cortex';}));`);
    ok('the bell\'s notification center has a Neo Cortex filter', /"kinds":\["cortex"\]/.test(filters), filters);

    console.log('\n4. Analysis ▸ Debrief ▸ Neo Cortex');
    await until('window.tbDebrief && window.MagiBrief', 20000);   // as tradehub-debrief.live.js: Debrief draws MAGI's answer with MagiBrief
    await js(`window.MagiBrief.setView('brief'); 1`);
    await js(`
      window.__errs=[]; window.addEventListener('error',function(e){window.__errs.push(String(e.error&&e.error.stack||e.message));});
      localStorage.setItem('tb_debrief_tab', 'cortex');
      window._fbWatchDebriefAuto = function(cb){ cb({}); return function(){}; };
      window._fbLoadMarketCal=async()=>({events:[],generatedAt:Date.now()});
      window._fbLoadTBNews=async()=>({events:[{aiAnalyzed:false}],generatedAt:Date.now()});
      var host=document.createElement('div'); host.id='__dbr'; document.body.appendChild(host);
      host.__root=ReactDOM.createRoot(host);
      host.__root.render(React.createElement(window.tbDebrief.Debrief, {onClose:function(){}, promptText:'', searches:[]}));
      1`);
    ok('Debrief has a Neo Cortex tab', await until(`!!document.querySelector('.dbr-tabs [data-dkey="cortex"]')`, 8000), await js('return JSON.stringify(window.__errs) + " dbr:" + !!document.querySelector(".dbr");') + ' console: ' + cons.slice(-3).join(' || '));
    await js(`document.querySelector('.dbr-tabs [data-dkey="cortex"]').click(); 1`);
    ok('...it draws the newest ready brief with its own day picker', await until(`(function(){ var b=document.querySelector('[data-dbr-cortex] [data-ncx-brief]'); return b && /Claude's review/i.test(b.innerText) && !!b.querySelector('[data-ncx-briefday]'); })()`, 10000),
      await js(`var b=document.querySelector('[data-dbr-cortex]'); return b ? b.innerText : 'none';`));

    console.log('\n5. Tablet and phone');
    await js(`var h=document.getElementById('__dbr'); if(h&&h.__root){h.__root.unmount();h.remove();} 1`);
    await tab('cortex');
    for (const [w, label] of [[820, 'tablet'], [390, 'phone']]) {
      await size(w, 900); await sleep(700);
      ok(`${label}: the brief card fits the screen`, await js(`var wide=[...document.querySelectorAll('[data-ncx-card="brief"] *')].filter(function(e){ var r=e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }); return wide.length === 0 && !!${card('brief')};`),
        await js(`return [...document.querySelectorAll('[data-ncx-card="brief"] *')].filter(function(e){ var r=e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).slice(0,4).map(function(e){return e.className+':'+Math.round(e.getBoundingClientRect().right);}).join(' ');`));
    }
    await tab('portfolio');
    ok('no page errors', errs.length === 0, errs.join(' | '));
  } catch (e) { fail++; console.log('  FAIL crashed: ' + (e && e.stack || e) + '\n  page errors: ' + errs.slice(0, 5).join(' | ')); }
  console.log(`\n${pass} passed, ${fail} failed`);
  try { await c.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
