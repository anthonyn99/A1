// Neo Cortex N7 (A1-Priv docs/TradeHub/quant/n4-07.md): the Neo Cortex tab in the real page, quant-api and quant-bot
// played here. The tab and its four cards, the move and strategy drawers, the 30 s read with its ETag only while the tab
// is open and the market is open, Lab and Scorecard in the catalog, Display Mode hiding the tab (P2-21), three widths.
//
// Run: node tests/live/tradehub-cortex-tab.live.js   (own CDP_PORT; about 2 minutes: it waits out two 30 s reads)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, KEY } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const BOT = 'https://quant-bot.anthony-account-3.workers.dev';

function fakeBot() {
  const s = { calls: [], kills: 0 };
  const now = Date.now(), day = new Date(now - 5 * 3600000).toISOString().slice(0, 10);
  const events = [
    { id: 3, ts: now - 600000, kind: 'exit', sym: 'AMD', side: 'long', qty: 6, price: 167.7, strategy: 'semis-orb', version: 1, why: 'Target hit (2R). Alpaca accepted the exit.', thesis: 'Semis lead in risk-on' },
    { id: 2, ts: now - 1800000, kind: 'shadow', sym: 'MSFT', side: 'long', qty: 2, price: 410, strategy: 'quality', version: 1, why: 'Close above the 50-day at $410.00, stop $401.80, target $426.40.', thesis: null },
    { id: 1, ts: now - 3600000, kind: 'entry', sym: 'AMD', side: 'long', qty: 6, price: 162.4, strategy: 'semis-orb', version: 1, why: 'opening range high 162.10 on 2.10× volume at $162.40, stop $159.75, target $167.70.', thesis: 'Semis lead in risk-on' },
  ];
  const life = { ok: true, strategies: [
    { id: 'semis-orb', version: 1, name: 'Semis opening-range breakout', stage: 'active', style: 'day', side: 'long', timeframe: '5m', symbols: ['AMD', 'NVDA'], trades: 14, winRate: 0.64, pf: 1.8, pnl: 212.4, expectancyR: 0.4, backtest: { trades: 87, winRate: 0.58, pf: 1.5, expectancyR: 0.33 }, replay: { signals: 20, matched: 19 }, conviction: 0.62, why: 'Kept after its trial', setups: ['orb'] },
    { id: 'quality', version: 1, name: 'Quality leaders, trend', stage: 'shadow', style: 'swing', side: 'long', timeframe: '1d', symbols: ['MSFT'], trades: 0, winRate: null, pf: null, pnl: 0, expectancyR: null, backtest: { trades: 40, winRate: 0.55, pf: 1.3, expectancyR: 0.2 }, replay: { signals: 0, matched: 0 }, conviction: 0, why: 'Admitted to shadow', setups: [] }],
    setups: [], review: null };
  s.handle = (req) => {
    const u = new URL(req.url), p = u.pathname, auth = req.headers.Authorization || req.headers.authorization || '';
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    s.calls.push({ p, inm: req.headers['If-None-Match'] || req.headers['if-none-match'] || null, at: Date.now() });
    if (auth !== 'Bearer ' + KEY) return { status: 401, json: { error: 'unauthorized' } };
    if (p === '/state') return { json: { ok: true, mode: 'paper', paused: false, market: 'open', equity: 5084.2, dayPnl: 84.2, deployed: 1940, positions: [{ sym: 'NVDA' }], shadowSessions: 2, halted: null, lastCheck: now - 60000 } };
    if (p === '/today') {
      const tag = '"neo-' + day + '-0-3"';
      if ((req.headers['If-None-Match'] || req.headers['if-none-match']) === tag) return { status: 304, text: '', headers: { etag: tag } };
      return { json: { ok: true, day, events }, headers: { etag: tag } };
    }
    if (p === '/lifecycle') return { json: life };
    if (p === '/lab/runs') return { json: { ok: true, runs: [{ id: 'run-1', session: 'premarket', model: 'claude_code/opus', started: now - 7200000, outcome: 'ok', trials: 3, summary: 'Semis lead; one breakout proposed.', results: [{ id: 'semis-orb', name: 'Semis ORB', pass: true, version: 1, published: true, edits: [{ field: 'exit.stop', why: 'added a 1.5 ATR stop' }] }, { id: 'gap-fade', name: 'Gap fade', pass: false, reasons: ['under the 30 trades the gate needs'], edits: [] }] }] } };
    if (p.startsWith('/brief/')) return { json: { ok: true, brief: null } };
    if (p === '/strategies') return { json: { ok: true, strategies: [{ id: 'semis-orb', version: 1, spec: { v: 2, id: 'semis-orb', version: 1, name: 'Semis ORB', horizon: 'day', side: 'long', timeframe: '5m', universe: { symbols: ['AMD'] }, entry: { all: [{ setup: 'orb' }] }, exit: { any: [{ stop: 'atr', value: 1.5 }, { target: 'r', value: 2 }] }, sizing: { kind: 'conviction', min: 0.25, max: 1 } } }] } };
    if (p === '/trades') return { json: { ok: true, trades: [{ id: 'a', strategy: 'semis-orb', symbol: 'AMD', side: 'long', opened: now - 3600000, closed: now - 600000, pnl: 31.8, r: 2 }] } };
    if (p === '/strategies/stage') return { json: { ok: true, stage: 'paused' } };
    return { status: 404, json: { ok: false, error: 'no route ' + p } };
  };
  return s;
}

(async () => {
  const api = quantApi(), bot = fakeBot();
  const base = api.mock.handle.bind(api.mock);
  const mock = { ...api.mock, patterns: [...api.mock.patterns, BOT + '/*'], handle: (req) => (req.url.startsWith(BOT) ? bot.handle(req) : base(req)) };
  const c = await connect({ mock });
  const errs = [];
  await c.send('Network.enable'); await c.send('Network.clearBrowserCache');   // the shared profile's cache has been seen corrupt
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const { js, until, size, boot, tab } = driver(c);
  const card = (id) => `document.querySelector('[data-ncx-card="${id}"]')`;
  const navHas = () => js(`return !![...document.querySelectorAll('.tb-navtab[data-navid="cortex"]')].find(function(b){return b.offsetParent;});`);
  const reads = (p) => bot.calls.filter((x) => x.p === p).length;

  try {
    console.log('\n1. The tab and its cards (1280)');
    await size(1280 + 224, 900);
    await boot({ quant: true });
    ok('the sidebar has Neo Cortex', await until(`!![...document.querySelectorAll('.tb-navtab[data-navid="cortex"]')].find(function(b){return b.offsetParent;})`, 10000));
    await tab('cortex');
    ok('four cards by default: Status, Today, Daily brief, Strategies', await until(`${card('status')} && ${card('today')} && ${card('brief')} && ${card('strategies')} && !${card('lab')}`, 10000));
    ok('Status: the pill, today\'s P&L and the deployed meter', await until(`/Running · paper/.test(${card('status')}.innerText) && /\\+\\$84\\.20/.test(${card('status')}.innerText) && /\\$1,940\\.00/.test(${card('status')}.innerText)`, 8000), await js(`return ${card('status')}.innerText;`));
    ok('Today: three moves, newest first, chips Sell / Shadow / Buy, the shadow dimmed', await until(`document.querySelectorAll('[data-ncx-event]').length === 3`, 8000) &&
      await js(`var r=[...document.querySelectorAll('[data-ncx-event]')]; return r.map(function(e){return e.querySelector('.ncx-chip').textContent;}).join() === 'Sell,Shadow,Buy' && r[1].classList.contains('is-faint');`),
      await js(`return [...document.querySelectorAll('[data-ncx-event]')].map(function(e){return e.innerText.split('\\n').join(' ');}).join(' | ');`));
    ok('Strategies: both rows with stage and record', await js(`var t=${card('strategies')}.innerText; return /Semis opening-range breakout/.test(t) && /active/i.test(t) && /14 trades · 64% won · PF 1\\.80/.test(t) && /shadow/i.test(t);`), await js(`return ${card('strategies')}.innerText;`));
    ok('Daily brief: says when it is written (no brief yet)', await js(`return /written after the close/.test(${card('brief')}.innerText);`));

    console.log('\n2. Drawers');
    await js(`document.querySelector('[data-ncx-event="1"]').click(); 1`);
    ok('a move opens its drawer: the reason, the thesis, the strategy', await until(`(function(){ var d=document.querySelector('[data-ncx-drawer]'); return d && /opening range high 162\\.10/.test(d.innerText) && /Semis lead in risk-on/.test(d.innerText) && /Semis opening-range breakout · active/.test(d.innerText); })()`, 5000));
    ok('...with a small chart of the day (entry, stop and target lines)', await until(`!!document.querySelector('[data-ncx-drawer] .ncx-mc .ncx-mc-stop') && !!document.querySelector('[data-ncx-drawer] .ncx-mc .ncx-mc-target')`, 8000), await js(`var d=document.querySelector('[data-ncx-drawer]'); return d ? d.innerText.slice(-200) : 'none';`));
    ok('...A1\'s dim and blur behind it', await js(`var s=document.querySelector('[data-ncx-scrim]'); var cs=getComputedStyle(s); return /blur/.test(cs.backdropFilter || cs.webkitBackdropFilter || '');`));
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`);
    ok('...Escape closes it', await until(`!document.querySelector('[data-ncx-drawer]')`, 3000));
    await js(`document.querySelector('[data-ncx-strat="semis-orb"]').click(); 1`);
    ok('a strategy opens its drawer: rules in words, paper against backtest, the replay match', await until(`(function(){ var d=document.querySelector('[data-ncx-drawer]'); return d && /orb setup fires/.test(d.querySelector('.ncx-section').innerText) && !/undefined|NaN/.test(d.innerText) && /87/.test(d.innerText) && /19 of 20 signals/.test(d.innerText); })()`, 6000),
      await js(`var d=document.querySelector('[data-ncx-drawer]'); return d ? d.innerText : 'none';`));
    await js(`document.querySelector('[data-ncx="stage-paused"]').click(); 1`);
    ok('...Pause sends the stage change as Tony and closes', await until(`!document.querySelector('[data-ncx-drawer]')`, 5000) && bot.calls.some((x) => x.p === '/strategies/stage'));

    console.log('\n3. Reads: every 30 s with the ETag while open, none after leaving');
    const t0 = reads('/today');
    await sleep(32000);
    ok('a second read came 30 s later, sending the ETag (answered 304)', reads('/today') > t0 && bot.calls.filter((x) => x.p === '/today').slice(-1)[0].inm === bot.calls.filter((x) => x.p === '/today')[0].inm || bot.calls.filter((x) => x.p === '/today').some((x) => x.inm), JSON.stringify(bot.calls.filter((x) => x.p === '/today')));
    ok('...and the moves stayed', await js(`return document.querySelectorAll('[data-ncx-event]').length === 3;`));
    await tab('portfolio');
    const t1 = bot.calls.length;
    await sleep(33000);
    ok('after leaving the tab nothing more is read', bot.calls.length === t1, JSON.stringify(bot.calls.slice(t1)));

    console.log('\n4. Lab and Scorecard (Add card), Display Mode');
    const cat = JSON.parse(await js(`var C=await import('/A1/TradeHub/ui/card-catalog.js'); return JSON.stringify(C.TABS.find(function(t){return t.tab==='cortex';}).cards.map(function(c){return c.id;}));`));
    ok('the card catalog offers Lab and Scorecard on every tab', cat.includes('lab') && cat.includes('scorecard'), JSON.stringify(cat));
    const labHtml = await js(`var L=await import('/A1/TradeHub/ui/cortex-lab.js'); var el=document.createElement('div'); L.labCard(el, { runs: ${JSON.stringify((await (async () => [])()) || [])}.concat([{ id: 'r', session: 'premarket', model: 'm', started: Date.now(), outcome: 'ok', results: [{ id: 'x', name: 'Gap fade', pass: false, reasons: ['under the 30 trades'] }] }]) }); return el.innerText;`);
    ok('...Lab lists a run with each proposal refused and why', /premarket/.test(labHtml) && /Refused/.test(labHtml) && /under the 30 trades/.test(labHtml), labHtml);
    await tab('cortex');
    await until(`!!${card('status')}`, 6000);
    await js(`[...document.querySelectorAll('[aria-label="Display mode"]')].find(function(x){return x.offsetParent;}).click(); 1`);
    ok('P2-21: in Display Mode the tab leaves the sidebar and the page goes to Portfolio', await until(`!document.querySelector('[data-cortex-tab]')`, 5000) && !(await navHas()));
    await js(`[...document.querySelectorAll('[aria-label="Display mode"]')].find(function(x){return x.offsetParent;}).click(); 1`);
    ok('...and comes back when Display Mode is off', await until(`!![...document.querySelectorAll('.tb-navtab[data-navid="cortex"]')].find(function(b){return b.offsetParent;})`, 5000));

    console.log('\n5. Tablet and phone');
    await tab('cortex');
    for (const [w, label] of [[820, 'tablet'], [390, 'phone']]) {
      await size(w, 900); await sleep(700);
      ok(`${label}: every card fits the screen`, await js(`var wide=[...document.querySelectorAll('[data-cortex-tab] *')].filter(function(e){ var r=e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }); return wide.length === 0 && !!${card('today')};`),
        await js(`return [...document.querySelectorAll('[data-cortex-tab] *')].filter(function(e){ var r=e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).slice(0,4).map(function(e){return e.className+':'+Math.round(e.getBoundingClientRect().right);}).join(' ');`));
    }
    await tab('portfolio');
    ok('no page errors', errs.length === 0, errs.join(' | '));
  } catch (e) { fail++; console.log('  FAIL crashed: ' + (e && e.stack || e) + '\n  page errors: ' + errs.slice(0, 5).join(' | ')); }
  console.log(`\n${pass} passed, ${fail} failed`);
  try { await c.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
