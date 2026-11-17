// TradeHub Quant, Phase 12 in the real page (A1-Priv tradehub.html + TradeHub/ui/risk.js,
// edge.js, rules.js, neo/rules-ctx.js, neo/reg/risk.js): Portfolio ▸ Risk, Journal ▸ Edge,
// Control ▸ My rules and the heads-ups, on a played Webull portfolio and a seeded Journal.
//
//   1. Portfolio ▸ Risk: exposure by sector, concentration, VaR, the heat grid, open risk
//      to the Journal's stop, drawdown, the size calculator, the flags and the rules' heads-ups
//   2. display mode blurs every personal figure on the new cards
//   3. Journal ▸ Edge: the breakdown with its switch, small samples marked, the patterns,
//      the Monte Carlo fan (in the worker), the rule checks ("your 5th trade today")
//   4. a heads-up dismissed for today, a check muted ("don't warn me again") and back on
//   5. reconcile: the synced leg corrected (logged), the typed leg only flagged until
//      "Use Webull's value"; nothing else in the Journal written
//   6. Control ▸ My rules: a proposal checks nothing until Accept; Accept writes the doc
//   7. Neo Quant: "show risk", "my edge" and "my rules" are instant commands
//   8. 1504 / 820 / 390 px: the cards tile, no sideways scroll; no uncaught error
//
// Run: node tests/live/tradehub-quant-risk.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, CLOCK } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const MIN = 60000, DAY = 86400000;
// CLOCK is Thursday 2026-11-12, 12:50 PM New York (UTC−5).
const ny = (dayOffset, hh, mm) => new Date(Date.UTC(2026, 10, 12 + dayOffset, hh + 5, mm)).toISOString();

function journal() {
  const doc = { savedAt: CLOCK - 3600000 };
  let n = 0;
  const add = (t) => { doc['t_' + t.id] = t; };
  // Trades with a stop are 'manual': a stop is typed in the trade's edit box, and Webull
  // Sync rebuilds every 'webull' trade from its legs (new id, no stop): see quant-plan §0.
  // 40 closed trades over 8 weeks, with stops: mostly +2 R and −1 R.
  for (let i = 0; i < 40; i++) {
    const d = -(i + 3), win = i % 3 !== 0, sym = ['NVDA', 'AMD', 'TSLA', 'MU'][i % 4];
    add({ id: 'h' + i, source: 'manual', ticker: sym, createdAt: Date.parse(ny(d, 11, 0)), status: 'CLOSED', stopLoss: 99,
      legs: [{ action: 'BUY', qty: 100, price: 100, fee: 0.1, datetime: ny(d, 11, 0) }, { action: 'SELL', qty: 100, price: win ? 102 : 99, fee: 0.1, datetime: ny(d, 13, 0) }] });
    n++;
  }
  // Today: five trades (9:35, 10:00, 10:30, 11:00, 11:30), the last with no stop.
  [[9, 35], [10, 0], [10, 30], [11, 0], [11, 30]].forEach(([h, m], i) => add({ id: 'd' + i, source: 'manual', ticker: 'PLTR', createdAt: Date.parse(ny(0, h, m)), ...(i < 4 ? { stopLoss: 29 } : {}),
    legs: [{ action: 'BUY', qty: 10, price: 30, fee: 0, datetime: ny(0, h, m) }, { action: 'SELL', qty: 10, price: 30.5, fee: 0, datetime: ny(0, h, m + 15) }] }));
  // The open NVDA position's trade, with its stop at 260.
  add({ id: 'open1', source: 'manual', ticker: 'NVDA', createdAt: Date.parse(ny(-1, 10, 0)), stopLoss: 260, legs: [{ action: 'BUY', qty: 100, price: 265, fee: 0, datetime: ny(-1, 10, 0) }] });
  // Reconcile: a synced leg Webull filled at another price, and a typed leg that disagrees.
  add({ id: 'syn1', source: 'webull', ticker: 'AMD', createdAt: Date.parse(ny(-2, 10, 0)), legs: [{ action: 'BUY', qty: 5, price: 150.25, fee: 0, datetime: ny(-2, 10, 0), _wbOrder: 'w1' }, { action: 'SELL', qty: 5, price: 155, fee: 0, datetime: ny(-2, 14, 0), _wbOrder: 'w2' }] });
  add({ id: 'man1', source: 'manual', ticker: 'MU', createdAt: Date.parse(ny(-2, 10, 0)), legs: [{ action: 'BUY', qty: 7, price: 99, fee: 0, datetime: ny(-2, 10, 0), _wbOrder: 'w3' }, { action: 'SELL', qty: 7, price: 101, fee: 0, datetime: ny(-2, 15, 0) }] });
  return doc;
}
const PORTFOLIO = {
  account: { totalValue: 100000, cashBalance: 60000, buyingPower: 60000 },
  positions: [
    { ticker: 'NVDA', shares: 100, avgCost: 265, currentPrice: 270, marketValue: 27000, unrealizedPnL: 500 },
    { ticker: 'AMD', shares: 80, avgCost: 140, currentPrice: 150, marketValue: 12000, unrealizedPnL: 800 },
    { ticker: 'XOM', shares: -50, avgCost: 112, currentPrice: 110, marketValue: 5500, unrealizedPnL: 100 },
  ],
  orders: [],
  history: [
    { orderId: 'w1', symbol: 'AMD', action: 'BUY', filledQty: 5, avgFilledPrice: 150.5, status: 'FILLED', filledAt: ny(-2, 10, 0) },
    { orderId: 'w2', symbol: 'AMD', action: 'SELL', filledQty: 5, avgFilledPrice: 155, status: 'FILLED', filledAt: ny(-2, 14, 0) },
    { orderId: 'w3', symbol: 'MU', action: 'BUY', filledQty: 7, avgFilledPrice: 98.5, status: 'FILLED', filledAt: ny(-2, 10, 0) },
  ],
  activities: [], errors: {},
};
const RULES = { rules: [
  { id: 'maxTradesDay', kind: 'maxTradesDay', value: 4, on: true, status: 'active', source: 'tony' },
  { id: 'maxPositionPct', kind: 'maxPositionPct', value: 20, on: true, status: 'active', source: 'tony' },
  { id: 'stopRequired', kind: 'stopRequired', on: true, status: 'proposed', source: 'neo', quote: 'Always use a stop.' },
], muted: [], savedAt: CLOCK - DAY };

(async () => {
  const api = quantApi();
  api.state.tradeboard = (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/api/portfolio/summary') return { json: { ok: true, data: PORTFOLIO } };
    if (p === '/api/journal/sync') return { json: { ok: true, data: [], feesRemaining: 0 } };
    return null;
  };
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP + `;window.__long=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__long.push(Math.round(e.duration));});}).observe({type:'longtask',buffered:false});}catch(e){}` });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const docs = { 'dashboards/tradeboard_journal': journal(), 'dashboards/tradehub_rules': RULES };
  const R = `document.querySelector('[data-risk-view]')`, E = `document.querySelector('[data-edge-view]')`;
  const text = (sel) => js(`var e=document.querySelector('${sel}'); return e ? e.innerText : null;`);

  console.log('\nPortfolio ▸ Risk');
  await size(1504, 950);
  await boot({ quant: true, docs });
  await sleep(1500);
  await js(`window.__long=[]; 1`);   // the page's own boot (the in-browser JSX compile) is not this phase's
  await tab('portfolio');
  ok('Portfolio has a Risk tab while Quant is on', await until(`[...document.querySelectorAll('.tbtabs [role=tab]')].some(function(b){return /^Risk/.test(b.textContent);})`, 10000));
  await js(`[...document.querySelectorAll('.tbtabs [role=tab]')].find(function(b){return /^Risk/.test(b.textContent);}).click(); 1`);
  ok('the Risk view draws its eight cards', await until(`${R} && ${R}.querySelectorAll('.lay-card').length === 8`, 10000), await js(`return ${R} ? ${R}.querySelectorAll('.lay-card').length : 'none';`));
  ok('exposure: Semiconductors 39% (NVDA, AMD), Energy, the stacked bar', await until(`/Semiconductors/.test((document.querySelector('[data-rk-exposure]')||{}).innerText||'') && /39\\.0%/.test(document.querySelector('[data-rk-sector="Semiconductors"]').innerText) && document.querySelectorAll('[data-rk-stack] i').length === 2`, 10000), await text('[data-rk-exposure]'));
  ok('concentration: NVDA the largest at 27%', /NVDA\s*27\.0%/.test(await text('[data-rk-concentration]')), await text('[data-rk-concentration]'));
  ok('value at risk, both readings, the larger leading', await until(`/Parametric/.test(document.querySelector('[data-rk-vol]').innerText) && /Historical/.test(document.querySelector('[data-rk-vol]').innerText)`, 8000), await text('[data-rk-vol]'));
  ok('the correlation heat grid, 3 × 3, one hue', await js(`var t=document.querySelector('[data-rk-heat]'); return !!t && t.querySelectorAll('tbody tr').length === 3 && t.querySelectorAll('tbody td').length === 9;`));
  ok('open risk: NVDA to the Journal\'s stop (260, $1,000), the others at 1.5 ATR', await js(`var r=document.querySelector('[data-rk-risk="NVDA"]'); return !!r && /your stop/.test(r.innerText) && /\\$1,000\\.00/.test(r.innerText) && /1\\.5 ATR/.test(document.querySelector('[data-rk-risk="AMD"]').innerText);`), await text('[data-rk-openrisk]'));
  ok('drawdown from the closed trades', /Worst/.test(await text('[data-rk-drawdown]')) && /Under water/.test(await text('[data-rk-drawdown]')));
  await js(`var set=function(k,v){var i=document.querySelector('[data-rk-size="'+k+'"]'); i.value=v; i.dispatchEvent(new Event('input',{bubbles:true}));}; set('symbol','TSLA'); set('entry','100'); set('stop','95'); 1`);
  ok('the size calculator: half-Kelly on his record, at most 1% ($1,000 on a $5 stop = 200 shares), its sector', await until(`/Shares\\s*200\\b/.test(document.querySelector('[data-rk-size-out]').innerText) && /Half-Kelly on your own record/.test(document.querySelector('[data-rk-size-out]').innerText) && /Consumer Discretionary/.test(document.querySelector('[data-rk-size-out]').innerText)`, 3000), await text('[data-rk-size-out]'));
  await js(`var set=function(k,v){var i=document.querySelector('[data-rk-size="'+k+'"]'); i.value=v; i.dispatchEvent(new Event('input',{bubbles:true}));}; set('entry','400'); set('stop','390'); 1`);
  ok('...a tight stop on a dear stock stops at 20% of the account (50 shares)', await until(`/Shares\\s*50\\b/.test(document.querySelector('[data-rk-size-out]').innerText) && /Capped at 20%/.test(document.querySelector('[data-rk-size-out]').innerText)`, 3000), await text('[data-rk-size-out]'));
  ok('flags: NVDA over 20%, Semiconductors over 35%', await js(`var f=[...document.querySelectorAll('[data-rk-flag]')].map(function(x){return x.dataset.rkFlag;}).sort().join(); return f === 'position,sector';`), await text('[data-rk-flags]'));
  ok('his rule as a heads-up: "NVDA is 27% of the account; your rule says 20% max."', await until(`[...document.querySelectorAll('[data-rk-flags] [data-rw-head]')].some(function(x){return /Heads up: NVDA is 27% of the account; your rule says 20% max\\./.test(x.innerText);})`, 8000), await text('[data-rk-flags]'));
  await shot('risk-1504');

  console.log('\nDisplay mode');
  await js(`window._tbOps.app.display(true); 1`);
  await sleep(300);
  // Every text with a $, % or R figure is blurred, except TradeHub's own limits ("the 1% risk cap", "95%").
  const LEAKS = (root) => `var out=[]; var isBlur=function(e){var cs=getComputedStyle(e); return cs.color==='rgba(0, 0, 0, 0)'&&cs.textShadow!=='none';};
    var policy=/^(1-day 95% VaR|A 10% drawdown|A 20% drawdown)$|1% risk cap|Capped at 20%|sector 35%, a cluster 40%|bands hold half and 90%|at most 1% risk|^(no position over|no sector over|open risk to stops under|no trade risking over) \\d/;
    var w=document.createTreeWalker(${root},NodeFilter.SHOW_TEXT), n; while((n=w.nextNode())){ var e=n.parentElement, t=n.textContent; if(!e||!e.offsetParent||e.closest('input,select,option,.lay-head')) continue; if(/\\$\\d|\\d%|\\d R\\b/.test(t) && !policy.test(t) && !isBlur(e)) out.push(t.slice(0,50)); }
    return out;`;
  const leaks = await js(LEAKS(R));
  ok('every personal $, % and R figure on the Risk cards is blurred', leaks.length === 0, JSON.stringify(leaks.slice(0, 8)));
  ok('the sparkline hides too (tb-money-svg)', await js(`var s=document.querySelector('[data-rk-drawdown] .rk-spark'); return !s || getComputedStyle(s).opacity === '0';`));
  await js(`window._tbOps.app.display(false); 1`);

  console.log('\nJournal ▸ Edge');
  await tab('journal');
  ok('the Journal has a Trades | Edge switch', await until(`document.querySelector('[data-journal-view]')`, 6000));
  // At the very right of the header in both views (Tony, 2026-11-17).
  const swRight = () => js(`var s=document.querySelector('[data-journal-view]'), a=s && s.closest('.tbp-acts'); return s ? JSON.stringify({ last: !!a && a.lastElementChild === s || (a && [...a.children].filter(function(c){ return c.offsetParent && c.tagName !== 'INPUT'; }).pop() === s), right: Math.round(s.getBoundingClientRect().right) }) : 'null';`).then(JSON.parse);
  const swTrades = await swRight();
  await js(`[...document.querySelectorAll('[data-journal-view] button')].find(function(b){return b.textContent==='Edge';}).click(); 1`);
  await until(`document.querySelector('[data-journal-edge]')`, 6000);
  const swEdge = await swRight();
  ok('...on Trades it is the last thing at the right, where it sits on Edge', swTrades && swTrades.last && swEdge && Math.abs(swTrades.right - swEdge.right) <= 1, JSON.stringify({ swTrades, swEdge }));
  ok('Edge draws its six cards', await until(`${E} && ${E}.querySelectorAll('.lay-card').length === 6`, 10000));
  ok('the breakdown: overall over his closed trades', await until(`document.querySelector('[data-ed-row="All trades"]')`, 8000), await text('[data-ed-breakdown]'));
  await js(`var s=document.querySelector('[data-ed-by]'); s.value='ticker'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
  ok('by ticker: every group under 20 trades is marked small', await until(`document.querySelectorAll('[data-ed-row]').length >= 4 && [...document.querySelectorAll('[data-ed-row]')].every(function(r){return r.classList.contains('is-small');})`, 3000), await text('[data-ed-table]'));
  await js(`var s=document.querySelector('[data-ed-by]'); s.value='tod'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
  ok('by time of day: New York half hours', await until(`document.querySelector('[data-ed-row="11:00 AM to 11:30 AM"]')`, 3000), await text('[data-ed-table]'));
  ok('patterns: each a plain sentence, none reported under 10 trades', await until(`document.querySelector('[data-ed-patterns] [data-ed-quiet], [data-ed-patterns] [data-ed-pattern]')`, 8000), await text('[data-ed-patterns]'));
  ok('Monte Carlo: the fan and the three numbers (computed in the worker)', await until(`document.querySelector('[data-ed-montecarlo] .rk-fan') && /A 10% drawdown/.test(document.querySelector('[data-ed-montecarlo]').innerText) && /Ruin at/.test(document.querySelector('[data-ed-montecarlo]').innerText)`, 15000), await text('[data-ed-montecarlo]'));
  await js(`window._tbOps.app.display(true); 1`); await sleep(300);
  const eLeaks = await js(LEAKS(E));
  ok('every personal figure on the Edge cards is blurred too', eLeaks.length === 0, JSON.stringify(eLeaks.slice(0, 8)));
  await js(`window._tbOps.app.display(false); 1`);
  ok('rule checks: "this is your 5th trade today; your rule says 4."', await until(`[...document.querySelectorAll('[data-ed-rules] [data-rw-head]')].some(function(x){return /this is your 5th trade today; your rule says 4\\./.test(x.innerText);})`, 8000), await text('[data-ed-rules]'));
  ok('the proposed "stop required" rule checks nothing yet (no heads-up for the trade without a stop)', !(await js(`return [...document.querySelectorAll('[data-rw-head]')].some(function(x){return /has no stop/.test(x.innerText);});`)));
  ok('how often each rule was broken, with those trades against the rest', await until(`document.querySelector('[data-ed-histrow="maxTradesDay"]')`, 3000), await text('[data-ed-rules]'));
  await shot('edge-1504');

  console.log('\nDismiss and mute');
  const pressOn = (scope, re, btnSel) => until(`(function(){var h=[...document.querySelectorAll('${scope} [data-rw-head]')].find(function(x){return ${re}.test(x.textContent);}); if(!h) return false; h.querySelector('${btnSel}').click(); return true;})()`, 8000);
  ok('the 5th-trade heads-up has Dismiss', await pressOn('[data-ed-rules]', '/5th trade/', '[data-rw-dismiss]'), await text('[data-ed-rules]'));
  ok('dismissed: gone for today', await until(`![...document.querySelectorAll('[data-ed-rules] [data-rw-head]')].some(function(x){return /5th trade/.test(x.innerText);})`, 3000));
  ok('...and no data changed (the rules doc untouched)', await js(`return JSON.stringify(window.__fakeFs.docs['dashboards/tradehub_rules'].rules.map(function(r){return r.id+r.status;})) === JSON.stringify(['maxTradesDayactive','maxPositionPctactive','stopRequiredproposed']) && !window.__fakeFs.log.some(function(l){return /tradehub_rules/.test(l.path);});`));
  await tab('portfolio');
  await js(`var b=[...document.querySelectorAll('.tbtabs [role=tab]')].find(function(b){return /^Risk/.test(b.textContent);}); if(b) b.click(); 1`);
  ok('the NVDA heads-up has "Don\'t warn me about this again"', await pressOn('[data-rk-flags]', '/NVDA is 27%/', '[data-rw-mute]'), await text('[data-rk-flags]'));
  ok('"Don\'t warn me about this again": that check goes quiet', await until(`![...document.querySelectorAll('[data-rk-flags] [data-rw-head]')].some(function(x){return /NVDA is 27%/.test(x.innerText);})`, 3000));
  ok('...the plain flag stays (information, not the rule)', await js(`return !!document.querySelector('[data-rk-flag="position"]');`));
  ok('...and the muted check is saved (one debounced write)', await until(`(window.__fakeFs.docs['dashboards/tradehub_rules'].muted||[]).indexOf('maxPositionPct') >= 0`, 5000));

  console.log('\nJournal vs Webull');
  await tab('journal');
  await until(`document.querySelector('[data-ed-reconcile] [data-ed-recsum]')`, 10000);
  const trade = (id) => js(`var d=window.__fakeFs.docs['dashboards/tradeboard_journal']; var t=Object.values(d).find(function(x){return x&&x.id===${JSON.stringify(id)};}); return JSON.stringify(t||null);`);
  const SYN = `(function(){var d=window.__fakeFs.docs['dashboards/tradeboard_journal']; return Object.values(d).find(function(x){return x&&x.legs&&x.legs.some(function(l){return l._wbOrder==='w1';});});})()`;
  ok('the synced leg is corrected to Webull\'s price (150.50) and logged on the trade', await until(`(function(){var t=${SYN}, l=t&&t.legs.find(function(x){return x._wbOrder==='w1';}); return l && l.price === 150.5 && t.corrections && t.corrections.length === 1 && t.corrections[0].from === 150.25 && l._corr && l._corr.length === 1;})()`, 10000), await js(`return JSON.stringify(${SYN});`));
  ok('the typed leg is only flagged, with "Use Webull\'s value"', await js(`return !!document.querySelector('[data-ed-flag="man1:0:price"] [data-ed-usewb]');`) && JSON.parse(await trade('man1')).legs[0].price === 99, await text('[data-ed-reconcile]'));
  const writesBefore = await js(`return window.__fakeFs.log.filter(function(l){return /tradeboard_journal$/.test(l.path);}).length;`);
  await js(`document.querySelector('[data-ed-flag="man1:0:price"] [data-ed-usewb]').click(); 1`);
  ok('"Use Webull\'s value": the typed leg now reads 98.50, logged as Tony\'s', await until(`(function(){var d=window.__fakeFs.docs['dashboards/tradeboard_journal']; var t=Object.values(d).find(function(x){return x&&x.id==='man1';}); return t && t.legs[0].price === 98.5 && t.corrections && t.corrections[0].by === 'tony';})()`, 6000), await trade('man1'));
  ok('...one write, and every other trade unchanged', await js(`var d=window.__fakeFs.docs['dashboards/tradeboard_journal']; return Object.values(d).filter(function(x){return x&&x.corrections;}).length === 2 && !!d && Object.values(d).filter(function(x){return x&&x.corrections;}).some(function(x){return x.id==='man1';});`) && (await js(`return window.__fakeFs.log.filter(function(l){return /tradeboard_journal$/.test(l.path);}).length;`)) - writesBefore <= 1);

  console.log('\nControl ▸ My rules');
  await tab('prompt');
  ok('the My rules card lists the rules, the proposal and the muted check', await until(`document.querySelector('[data-my-rules] [data-rw-rule="maxTradesDay"]') && document.querySelector('[data-rw-proposed] [data-rw-rule="stopRequired"]') && document.querySelector('[data-rw-mutedrow="maxPositionPct"]')`, 10000), await text('[data-my-rules]'));
  await js(`document.querySelector('[data-rw-mutedrow="maxPositionPct"] [data-rw-unmute]').click(); 1`);
  ok('Turn back on: unmuted', await until(`!document.querySelector('[data-rw-mutedrow="maxPositionPct"]')`, 3000));
  await js(`document.querySelector('[data-rw-rule="stopRequired"] [data-rw-accept]').click(); 1`);
  ok('Accept: the rule is active and written to the doc', await until(`(window.__fakeFs.docs['dashboards/tradehub_rules'].rules.find(function(r){return r.id==='stopRequired';})||{}).status === 'active' && (window.__fakeFs.docs['dashboards/tradehub_rules'].muted||[]).length === 0`, 6000), await js(`return JSON.stringify(window.__fakeFs.docs['dashboards/tradehub_rules']);`));
  await tab('journal');
  ok('...and now it checks: the 11:30 trade has no stop', await until(`[...document.querySelectorAll('[data-ed-rules] [data-rw-head]')].some(function(x){return /PLTR trade from 11:30 AM has no stop/.test(x.innerText);})`, 8000), await text('[data-ed-rules]'));

  console.log('\nNeo Quant');
  await js(`import('./TradeHub/neo/app.js').then(function(m){ window.__tbNeoApp = m.getNeoApp(); }); 1`);
  await until(`window.__tbNeoApp && window.__tbNeoApp.session`, 10000);
  await js(`window.__tbNeoApp.session.say('show risk'); 1`);
  ok('"show risk" → Portfolio ▸ Risk, no AI call', await until(`window._tbOps.app.page()==='portfolio' && document.querySelector('[data-risk-view]')`, 8000));
  await js(`window.__tbNeoApp.session.say('my edge'); 1`);
  ok('"my edge" → Journal ▸ Edge', await until(`window._tbOps.app.page()==='journal' && document.querySelector('[data-edge-view]')`, 8000));
  await js(`window.__tbNeoApp.session.say('my rules'); 1`);
  ok('"my rules" → Control ▸ My rules', await until(`window._tbOps.app.page()==='prompt' && document.querySelector('[data-my-rules]')`, 8000));
  ok('the registry lists Risk, edge and my rules', await js(`return window.__tbNeoApp.registry.list().some(function(e){return e.id==='risk' && e.actions.propose && e.readers.warnings;});`));

  console.log('\nWidths');
  for (const [w, hgt] of [[1504, 950], [820, 1100], [390, 844]]) {
    await size(w, hgt);
    await sleep(300);
    const drawer = w < 600;
    const go = async (id) => { if (drawer) await js(`var m=document.querySelector('[data-tb-drawer-btn], .tb-nav-menu, [aria-label="Menu"]'); if(m&&m.offsetParent) m.click(); 1`); await tab(id); await sleep(drawer ? 400 : 200); };
    await go('portfolio');
    await js(`var b=[...document.querySelectorAll('.tbtabs [role=tab]')].find(function(b){return /^Risk/.test(b.textContent);}); if(b) b.click(); 1`);
    await until(`${R} && ${R}.querySelectorAll('.lay-card').length === 8`, 8000);
    const overlap = (root) => `(function(){var r=[...${root}.querySelectorAll('.lay-card')].filter(function(c){return c.offsetParent;}).map(function(c){return c.getBoundingClientRect();}); for(var i=0;i<r.length;i++)for(var j=i+1;j<r.length;j++){var a=r[i],b=r[j]; if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1) return true;} return false;})()`;
    ok(`${w} px: Risk's cards tile (none overlap) and nothing scrolls sideways`, !(await js(`return ${overlap(R)};`)) && (await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`)), await js(`return document.documentElement.scrollWidth + ' / ' + window.innerWidth;`));
    await shot('risk-' + w);
    await go('journal');
    await until(`${E} && ${E}.querySelectorAll('.lay-card').length === 6`, 8000);
    ok(`${w} px: Edge's cards tile and nothing scrolls sideways`, !(await js(`return ${overlap(E)};`)) && (await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`)));
    await shot('edge-' + w);
  }

  console.log('\nSide effects');
  const long = await js(`return window.__long.filter(function(x){return x>200;});`);
  ok('no main-thread task over 200 ms (Monte Carlo runs in the worker)', long.length === 0, JSON.stringify(long));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  c.close && c.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
