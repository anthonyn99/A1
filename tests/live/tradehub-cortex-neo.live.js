// Neo Cortex N9 (A1-Priv docs/TradeHub/quant/n4-09.md): Neo Quant reads Neo Cortex and takes its two actions in the
// real page, quant-api and quant-bot played here. The page's own registry answers status, today, why, brief and
// strategy from the bot; "what did Neo Cortex do today?" brings the journal into the fact sheet; pause and the kill
// switch ask Yes / No in the dock first, No sends nothing, Yes sends the pause as Neo Quant's and the kill confirmed.
//
// Run: node tests/live/tradehub-cortex-neo.live.js   (own CDP_PORT; TH_PAGE_FILE=<copy> to try an unshipped page)
'use strict';
const { connect } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, KEY } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const BOT = 'https://quant-bot.anthony-account-3.workers.dev';

function fakeBot() {
  const s = { calls: [], posts: [] };
  const now = Date.now();
  const events = [
    { id: 7, ts: now - 900000, kind: 'entry', sym: 'NVDA', side: 'short', qty: 5, price: 168.6, strategy: 'vwap-rej', version: 1, why: 'Rejected at VWAP for the third time; stop $169.40.', thesis: 'Weak names fade at VWAP' },
    { id: 8, ts: now - 300000, kind: 'exit', sym: 'NVDA', side: 'short', qty: 5, price: 166.1, strategy: 'vwap-rej', version: 1, why: 'Target 2R hit.', thesis: 'Weak names fade at VWAP' },
  ];
  const life = { ok: true, strategies: [{ id: 'vwap-rej', version: 1, name: 'VWAP rejection', stage: 'paper', style: 'day', side: 'short', trades: 4, pnl: 31.5, conviction: 0.3 }], setups: [], review: null };
  s.handle = (req) => {
    const u = new URL(req.url), p = u.pathname, auth = req.headers.Authorization || req.headers.authorization || '';
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    s.calls.push(req.method + ' ' + p + u.search);
    if (auth !== 'Bearer ' + KEY) return { status: 401, json: { error: 'unauthorized' } };
    if (req.method === 'POST') { const body = JSON.parse(req.postData || '{}'); s.posts.push([p, body]);
      if (p === '/strategies/stage') return { json: { ok: true, id: body.id, version: body.version, stage: body.stage } };
      if (p === '/bot/kill') return { json: { ok: true, halted: true, positions: [], orders: [], problems: [] } };
    }
    if (p === '/state') return { json: { ok: true, mode: 'paper', paused: false, market: 'open', date: '2026-11-30', equity: 5031.5, dayPnl: 31.5, deployed: 0, positions: [], shadowSessions: 2, halted: null, lastCheck: now - 60000, limits: { book: 5000, maxDeployed: 3000 } } };
    if (p === '/today') return { json: { ok: true, day: u.searchParams.get('day'), events: events.slice().reverse() }, headers: { etag: '"x"' } };
    if (p === '/lifecycle') return { json: life };
    if (p === '/strategies') return { json: { ok: true, strategies: [] } };
    if (p === '/lab/runs') return { json: { ok: true, runs: [] } };
    if (p === '/briefs') return { json: { ok: true, briefs: [{ day: '2026-11-27', ready: true, headline: 'Up $31.50' }] } };
    if (p.startsWith('/brief/')) return { json: { ok: true, day: p.slice(7), brief: { day: p.slice(7), headline: 'Up $31.50 (+0.63%) · 2 trades', commentary: 'VWAP rejections worked in a weak tape.', claude: true, lineup: [{ id: 'vwap-rej', name: 'VWAP rejection' }], perStrategy: [], changes: [], ready: true } } };
    if (p === '/settings') return { json: { ok: true, version: 1, settings: { mode: 'paper', paused: false } } };
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
  await c.send('Network.enable'); await c.send('Network.clearBrowserCache');
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot } = driver(c);
  const read = (id, args = {}) => js(`var r=window.__tbNeoApp.registry.reader(${JSON.stringify(id)}); return JSON.stringify(await r.def.read(${JSON.stringify(args)}));`).then((t) => JSON.parse(t));
  const asking = `document.querySelector('[data-nq-dock] [data-nq-confirm="asking"]')`;

  try {
    for (const w of [1280, 820, 390]) {
      console.log(`\n${w}px`);
      await size(w + (w > 1000 ? 224 : 0), 900);
      await boot({ quant: true });
      await js(`import('./TradeHub/neo/app.js').then(function(m){ window.__tbNeoApp = m.getNeoApp(); }); 1`);
      ok('Neo Quant is up', await until(`window.__tbNeoApp && window.__tbNeoApp.session && window.__tbNeoApp.registry.get('cortex')`, 15000));
      if (w === 1280) {
        const reg = await js(`var e=window.__tbNeoApp.registry.get('cortex'); return JSON.stringify({ r: Object.keys(e.readers).sort(), a: Object.keys(e.actions).sort(), c: [e.actions.pause.confirm, e.actions.kill.confirm] });`);
        ok('the page\'s entry: six readers, four actions, pause and kill ask first', reg === JSON.stringify({ r: ['brief', 'settings', 'status', 'strategy', 'today', 'why'], a: ['kill', 'open', 'pause', 'research'], c: [true, true] }), reg);
        const st = await read('cortex.status');
        ok('status: mode, the bot\'s day, day P&L, no positions, shadow sessions', st.mode === 'paper' && st.day === '2026-11-30' && st.dayPnl === 31.5 && st.positions === 'none' && st.shadowSessions === 2, JSON.stringify(st));
        const t = await read('cortex.today');
        ok('today: the summary first, the trades with their reasons, the brief\'s headline', /made 2 moves: 1 entry, 1 exit\. Brief: Up \$31\.50/.test(t.summary) && t.trades.length === 2 && /Target 2R/.test(t.trades[1].why), JSON.stringify(t));
        const why = await read('cortex.why', { symbol: 'NVDA' });
        ok('why NVDA: the exit\'s reason, the strategy\'s name and thesis', why.why === 'Target 2R hit.' && why.strategy === 'VWAP rejection' && /fade at VWAP/.test(why.thesis), JSON.stringify(why));
        const b = await read('cortex.brief');
        ok('brief: the latest, with Claude\'s commentary and the line-up', b.day === '2026-11-27' && /weak tape/.test(b.commentary) && b.lineup[0] === 'VWAP rejection', JSON.stringify(b));
        const s = await read('cortex.strategy', { name: 'vwap rejection' });
        ok('strategy by name', s.id === 'vwap-rej' && s.stage === 'paper', JSON.stringify(s));
        const facts = await js(`var m=await import('./TradeHub/neo/registry-facts.js'); var f=await m.registryFacts('what did Neo Cortex do today?', { tickers: [] }, Date.now()); return JSON.stringify(f.map(function(x){return x.text;}));`);
        ok('"what did Neo Cortex do today?": the journal is in the fact sheet', /Neo Cortex · today, summary/.test(facts) && /Rejected at VWAP|Target 2R/.test(facts), facts);
      }
      // The dock shows the Yes / No.
      await js(`var d=document.querySelector('[data-nq-dock]'); if(d && d.hidden) document.querySelector('[data-nq-launch]').click(); 1`);
      ok('the dock opens', await until(`document.querySelector('[data-nq-dock]') && !document.querySelector('[data-nq-dock]').hidden`, 5000));
      bot.posts.length = 0;
      await js(`window.__tbKill = window.__tbNeoApp.session.actions.run('cortex.kill', {}, { who: 'tony' }); 1`);
      ok('the kill switch asks Yes / No first', await until(asking, 6000) && /kill switch/i.test(await js(`return ${asking}.innerText;`)));
      await js(`document.querySelector('[data-nq-dock] [data-nq-confirm-no]').click(); 1`);
      const no = await js(`return JSON.stringify(await window.__tbKill);`);
      ok('...No: nothing reached the bot', JSON.parse(no).ok === false && !bot.posts.length, no + ' ' + JSON.stringify(bot.posts));
      await js(`window.__tbPause = window.__tbNeoApp.session.actions.run('cortex.pause', { name: 'vwap rejection', why: 'news risk' }, { who: 'neo' }); 1`);
      await until(asking, 6000);
      await js(`document.querySelector('[data-nq-dock] [data-nq-confirm-yes]').click(); 1`);
      const pz = JSON.parse(await js(`return JSON.stringify(await window.__tbPause);`));
      const sent = bot.posts.find((x) => x[0] === '/strategies/stage');
      ok('pause, Yes: sent as Neo Quant\'s with the version, no Undo', pz.ok && !pz.undoable && sent && sent[1].author === 'neo' && sent[1].stage === 'paused' && sent[1].version === 1 && sent[1].id === 'vwap-rej', JSON.stringify([pz, sent]));
      if (w === 1280) {
        await js(`window.__tbKill = window.__tbNeoApp.session.actions.run('cortex.kill', {}, { who: 'tony' }); 1`);
        await until(asking, 6000);
        await js(`document.querySelector('[data-nq-dock] [data-nq-confirm-yes]').click(); 1`);
        const k = JSON.parse(await js(`return JSON.stringify(await window.__tbKill);`));
        ok('kill, Yes (the played bot): confirmed, halted and flat in words', k.ok && /halted and flat/.test(k.shown) && bot.posts.some((x) => x[0] === '/bot/kill' && x[1].confirm === true), JSON.stringify(k));
      }
    }
    ok('no page errors', !errs.length, errs.join(' | '));
  } catch (e) {
    fail++; console.log('  FAIL threw: ' + (e && e.stack || e));
  } finally {
    try { await c.close(); } catch (e) { /* closed */ }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
