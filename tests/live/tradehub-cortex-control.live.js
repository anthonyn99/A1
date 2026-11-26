// Neo Cortex N6 (A1-Priv docs/TradeHub/quant/n4-06.md): Control ▸ Neo Cortex in the real page, quant-api, quant-bot
// and ORCA played here. Groups, saving a limit, the ceiling, the strategist models, Research now, the kill switch's
// confirmation, Paper locked until two shadow sessions, History with Undo, at 1280, 820 and 390.
//
// Run: node tests/live/tradehub-cortex-control.live.js   (own CDP_PORT)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, KEY } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const BOT = 'https://quant-bot.anthony-account-3.workers.dev';
const LIMITS = { book: 5000, maxDeployed: 3000, riskMinPct: 0.25, riskMaxPct: 1.25, maxPosition: 1500, maxPositions: 6, dailyLossPct: 3, drawdownPct: 10, shortsAllowed: true, maxShortExposure: 1500, stopRequired: true, styleShare: { day: 0.5, swing: 0.35, invest: 0.15 } };
const LIFE = { shadowSessions: 1, maxLive: 6, matchMin: 90, trialMaxSessions: 20, keep: { minTrades: 15, minSessions: 5, minWinRate: 50, minPF: 1.1 }, kill: { wilsonUpper: 40, minTrades: 10, sleeveDD: 8, driftBand: 25, driftMinSignals: 10 } };

function fakeBot() {
  const s = { versions: [], posted: [], kills: 0, research: 0, shadowSessions: 0 };
  const current = () => s.versions.length ? s.versions[s.versions.length - 1] : { version: 0, at: null, author: null, reason: null, settings: { mode: 'shadow', paused: false, limits: LIMITS, strategist: { premarket: 'claude_code/opus', postclose: 'claude_code/sonnet', instructions: '' }, lifecycle: LIFE } };
  const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v; return o; };
  s.handle = (req) => {
    const u = new URL(req.url), p = u.pathname, m = req.method, auth = req.headers.Authorization || req.headers.authorization || '';
    if (m === 'OPTIONS') return { status: 204, text: '' };
    if (auth !== 'Bearer ' + KEY) return { status: 401, json: { error: 'unauthorized' } };
    const body = req.postData ? JSON.parse(req.postData) : null;
    if (body) s.posted.push({ p, m, body });
    if (p === '/settings' && m === 'GET') { const c = current(); return { json: { ok: true, ...c, ...(u.searchParams.get('history') === '1' ? { history: [...s.versions].reverse().slice(0, 20) } : {}) } }; }
    if (p === '/settings' && m === 'PUT') {
      const c = current();
      if (body.version !== c.version) return { status: 409, json: { ok: false, error: 'the settings changed, reload and retry' } };
      const next = merge(c.settings, body.settings);
      if (next.limits.book > 5000 || next.limits.maxDeployed > 3000) return { status: 400, json: { ok: false, error: 'invalid risk limits: book' } };
      if (next.mode === 'paper' && c.settings.mode !== 'paper' && (body.confirmPaper !== true || s.shadowSessions < 2)) return { status: 409, json: { ok: false, error: 'paper needs two shadow sessions and Tony’s confirmation' } };
      s.versions.push({ version: c.version + 1, at: Date.parse('2026-11-27T15:00:00Z') + s.versions.length * 60000, author: body.author, reason: body.reason, settings: next });
      return { json: { ok: true, version: c.version + 1, settings: next } };
    }
    if (p === '/state') return { json: { ok: true, mode: current().settings.mode, paused: current().settings.paused, shadowSessions: s.shadowSessions, halted: s.kills ? 'Tony pressed the kill switch' : null, killPending: false, lastCheck: Date.parse('2026-11-27T14:45:00Z') } };
    if (p === '/lab/runs') return { json: { ok: true, runs: [{ id: 'run-1', session: 'premarket', day: '2026-11-27', started: Date.parse('2026-11-27T12:50:00Z'), outcome: 'ok', count: 2 }] } };
    if (p === '/research/request') { s.research++; return { json: { ok: true, id: 1 } }; }
    if (p === '/bot/kill') { if (body.confirm !== true) return { status: 400, json: { ok: false } }; s.kills++; return { json: { ok: true, halted: true, canceled: 0, closing: [], positions: [], orders: [], problems: [] } }; }
    return { status: 404, json: { ok: false, error: 'no route ' + p } };
  };
  return s;
}

(async () => {
  const api = quantApi(), bot = fakeBot();
  api.state.orca.models = [...api.state.orca.models,
    { id: 'claude_code/opus', backend_type: 'cli', resolved_label: 'Opus 5.5', needs_credits: false, routable: true },
    { id: 'claude_code/sonnet', backend_type: 'cli', resolved_label: 'Sonnet 5.5', needs_credits: false, routable: true },
    { id: 'claude_code/haiku', backend_type: 'cli', resolved_label: 'Haiku 5.5', needs_credits: false, routable: true },
    { id: 'claude_code/fable', backend_type: 'cli', resolved_label: 'Fable 5.2', needs_credits: true, routable: true }];
  const base = api.mock.handle.bind(api.mock);
  const mock = Object.assign(Object.create(Object.getPrototypeOf(api.mock)), api.mock, { patterns: [...api.mock.patterns, BOT + '/*'], handle: (req) => (req.url.startsWith(BOT) ? bot.handle(req) : base(req)) });
  const c = await connect({ mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const { js, until, size, boot, tab } = driver(c);
  const q = (sel) => `document.querySelector('[data-ctl-pane="cortex"] ${sel}')`;
  const setField = (key, v) => js(`var i=${q(`[data-ncx-field="${key}"]`)}; i.value='${v}'; i.dispatchEvent(new Event('change',{bubbles:true})); 1`);

  try {
    console.log('\n1. The sub-tab and its groups (1280)');
    await size(1280 + 224, 900);
    await boot({ quant: true });
    await tab('prompt');
    ok('Control has a Neo Cortex sub-tab', await until(`!!document.querySelector('[data-ctl-sub="cortex"]')`, 10000));
    await js(`document.querySelector('[data-ctl-sub="cortex"]').click(); 1`);
    ok('...it draws its groups: Status, Money, Styles, Shorts, Strategist, Lifecycle, Alerts, History', await until(`[...document.querySelectorAll('[data-ctl-pane="cortex"] [data-ncx-group]')].map(function(g){return g.dataset.ncxGroup;}).join(',') === 'status,money,styles,shorts,strategist,lifecycle,alerts,history'`, 10000),
      await js(`return [...document.querySelectorAll('[data-ctl-pane="cortex"] [data-ncx-group]')].map(function(g){return g.dataset.ncxGroup;}).join(',') + ' | ' + (document.querySelector('[data-ctl-pane="cortex"]')||{}).innerText;`));
    ok('...two columns on a wide screen', await js(`var c=${q('.ncx-col')}, d=document.querySelectorAll('[data-ctl-pane="cortex"] .ncx-col')[1]; return !!d && Math.abs(c.getBoundingClientRect().top - d.getBoundingClientRect().top) < 2 && d.getBoundingClientRect().left > c.getBoundingClientRect().right;`));
    ok('...mode Shadow pressed; Paper locked with the reason (0 of 2 shadow sessions)', await js(`var p=${q('[data-ncx-mode="paper"]')}; return ${q('[data-ncx-mode="shadow"]')}.getAttribute('aria-checked') === 'true' && p.disabled && /0 of 2/.test(${q('[data-ncx-group="status"]')}.innerText);`));
    ok('...the money fields show the plan\'s values and their ceilings', await js(`return ${q('[data-ncx-field="limits.book"]')}.value === '5000' && /up to \\$5,000/.test(${q('[data-ncx-group="money"]')}.innerText) && /\\$12\\.50 to \\$62\\.50/.test(${q('[data-ncx-group="money"]')}.innerText);`));

    console.log('\n2. Saving');
    await setField('limits.book', 4000);
    ok('a changed limit is saved as Tony with its reason, and the page shows the new version', await until(`/Settings version 1/.test(${q('[data-ncx-group="status"]')}.innerText)`, 6000) && bot.posted.some((x) => x.p === '/settings' && x.body.author === 'tony' && x.body.settings.limits && x.body.settings.limits.book === 4000 && /book/.test(x.body.reason)),
      JSON.stringify(bot.posted.slice(-1)));
    ok('...the risk line follows the new book ($10.00 to $50.00)', await until(`/\\$10\\.00 to \\$50\\.00/.test(${q('[data-ncx-group="money"]')}.innerText)`, 4000));
    const before = bot.posted.length;
    await setField('limits.book', 9000);
    await sleep(500);
    ok('a value over the ceiling is refused on the page, nothing sent, the field restored', bot.posted.length === before && await js(`return ${q('[data-ncx-field="limits.book"]')}.value === '4000';`));
    await setField('limits.styleShare.invest', 0);
    ok('a style at 0% is saved as a share of 0 (long-term off)', await until(`/Settings version 2/.test(${q('[data-ncx-group="status"]')}.innerText)`, 6000) && bot.posted.some((x) => x.body.settings && x.body.settings.limits && x.body.settings.limits.styleShare && x.body.settings.limits.styleShare.invest === 0));
    await setField('lifecycle.kill.sleeveDD', 6);
    ok('a lifecycle rule saves as a nested patch', await until(`/Settings version 3/.test(${q('[data-ncx-group="status"]')}.innerText)`, 6000) && bot.posted.some((x) => x.body.settings && x.body.settings.lifecycle && x.body.settings.lifecycle.kill && x.body.settings.lifecycle.kill.sleeveDD === 6));

    console.log('\n3. The strategist');
    ok('the model lists show today\'s model per unit, Fable marked', await until(`/Latest Opus · Opus 5\\.5/.test(${q('[data-ncx-field="strategist.premarket"]')}.innerText) && /Latest Fable · Fable 5\\.2 · needs credits/.test(${q('[data-ncx-field="strategist.premarket"]')}.innerText)`, 6000),
      await js(`return ${q('[data-ncx-field="strategist.premarket"]')}.innerText;`));
    ok('...the last run is shown', await js(`return /Last run: premarket .* ok, 2 proposals/.test(${q('[data-ncx-lastrun]')}.innerText);`), await js(`return ${q('[data-ncx-lastrun]')}.innerText;`));
    await setField('strategist.postclose', 'claude_code/opus');
    ok('...picking a model saves it', await until(`/Settings version 4/.test(${q('[data-ncx-group="status"]')}.innerText)`, 6000) && bot.posted.some((x) => x.body.settings && x.body.settings.strategist && x.body.settings.strategist.postclose === 'claude_code/opus'));
    await js(`${q('[data-ncx="research"]')}.click(); 1`);
    ok('Research now asks quant-bot for a run', await until(`true`, 100) && await (async () => { for (let i = 0; i < 30 && !bot.research; i++) await sleep(100); return bot.research === 1; })());

    console.log('\n4. The kill switch and History');
    await js(`${q('[data-ncx="kill"]')}.click(); 1`);
    ok('Kill asks first, in the pane', await until(`!!${q('[data-ncx-confirm="kill"]')}`, 3000) && bot.kills === 0);
    await js(`${q('[data-ncx-confirm="kill"] [data-ncx="cancel"]')}.click(); 1`);
    ok('...Cancel sends nothing', await until(`!${q('[data-ncx-confirm="kill"]')}`, 3000) && bot.kills === 0);
    await js(`${q('[data-ncx="kill"]')}.click(); 1`); await until(`!!${q('[data-ncx-confirm="kill"] [data-ncx="yes"]')}`, 3000);
    await js(`${q('[data-ncx-confirm="kill"] [data-ncx="yes"]')}.click(); 1`);
    ok('...Kill now sends the confirmed kill and shows the halt and the report', await until(`/Halted: Tony pressed the kill switch/.test(${q('[data-ncx-group="status"]')}.innerText) && !!${q('[data-ncx-killreport]')}`, 6000) && bot.kills === 1);
    ok('History lists the changes, newest first, by you', await js(`var t=${q('[data-ncx-group="history"]')}.innerText; return /v4/.test(t) && t.indexOf('v4') < t.indexOf('v1') && /You ·/.test(t);`));
    await js(`${q('[data-ncx="undo"]')}.click(); 1`);
    ok('Undo saves the previous version\'s settings as a new version', await until(`/Settings version 5/.test(${q('[data-ncx-group="status"]')}.innerText)`, 6000) && (() => { const x = bot.posted.filter((y) => y.p === '/settings').pop(); return /undo v4/.test(x.body.reason) && x.body.settings.strategist.postclose === 'claude_code/sonnet'; })());

    console.log('\n5. Tablet and phone');
    for (const [w, label] of [[820, 'tablet'], [390, 'phone']]) {
      await size(w, 900); await sleep(500);
      ok(`${label}: one column, nothing wider than the screen`, await js(`var cols=document.querySelectorAll('[data-ctl-pane="cortex"] .ncx-col'); var a=cols[0].getBoundingClientRect(), b=cols[1].getBoundingClientRect(); var wide=[...document.querySelectorAll('[data-ctl-pane="cortex"] *')].filter(function(e){ var r=e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }); return b.top > a.bottom - 1 && wide.length === 0;`),
        await js(`return [...document.querySelectorAll('[data-ctl-pane="cortex"] *')].filter(function(e){ var r=e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).slice(0,4).map(function(e){return e.className+':'+Math.round(e.getBoundingClientRect().right);}).join(' ');`));
    }
    ok('no page errors', errs.length === 0, errs.join(' | '));
  } catch (e) { fail++; console.log('  FAIL crashed: ' + (e && e.stack || e) + '
  page errors: ' + errs.slice(0, 5).join(' | ')); }
  console.log(`\n${pass} passed, ${fail} failed`);
  try { await c.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
