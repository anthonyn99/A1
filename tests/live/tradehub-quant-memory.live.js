// TradeHub Quant, Phase 8: Control ▸ Memory & Drive in the real page (A1-Priv
// tradehub.html + TradeHub/ui/memory.js), quant-api played here (quant-mock.js).
//
//   1. a Playbook page read through Notebook's API equals what the editor shows
//   2. four cards on the grid: Drive, Memory, History, Search
//   3. Drive: connected, its email, the newest backup; Disconnect, then Connect
//      opens Google's page; the Playbook snapshot goes to Drive on a day a page changed
//   4. Memory: Neo's proposal accepted (as Tony), a card added, edited, pinned, archived
//   5. History: grouped by day, ticker and verdict filters, pin, delete
//   6. Search: a card, a conversation and a Playbook page found; no task over 50 ms
//   7. 1280, 820 and 390 px: no sideways scroll; no uncaught error
//
// Run: node tests/live/tradehub-quant-memory.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, CLOCK } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const DAY = 86400000, MIN = 60000;
// The Playbook as its old document: Notebook moves it into the instance on the first open.
const PLAYBOOK = { savedAt: CLOCK - MIN, pages: [
  { id: 'daily-reminder', title: 'Daily Reminder', body: '<h2>Before I trade</h2><p>Keep <strong>discipline</strong> above all.</p>', createdAt: CLOCK - 9e6, updatedAt: CLOCK - 30 * MIN },
  { id: 'pb_rules', title: 'Rules', body: '<ul><li>Cut losers fast</li><li>Never average down on a gap</li></ul>', createdAt: CLOCK - 7e6, updatedAt: CLOCK - 20 * MIN },
] };

(async () => {
  const api = quantApi();
  api.state.cards = [
    { id: 'mpinned001', kind: 'preference', text: 'Swing entries only after 10 AM', source: 'tony', created: CLOCK - 5 * DAY, lastUsed: CLOCK - DAY, pinned: true, state: 'active' },
    { id: 'mpropose01', kind: 'lesson', text: 'Volume must confirm a breakout before GO', source: 'neo', created: CLOCK - DAY, lastUsed: null, pinned: false, state: 'proposed' },
  ];
  api.state.convs = [
    { id: 'ctoday0001', title: 'Is NVDA a buy here?', created: CLOCK - 2 * 3600000, pinned: false, turns: [
      { id: 'tq1', at: CLOCK - 2 * 3600000, role: 'q', text: 'Is NVDA a buy here?', tickers: ['NVDA'] },
      { id: 'ta1', at: CLOCK - 2 * 3600000 + 5000, role: 'a', text: 'WATCH: the base breakout needs volume to confirm.', verdict: 'WATCH', tickers: ['NVDA'] }] },
    { id: 'cyday00001', title: 'Market open plan', created: CLOCK - DAY - 3600000, pinned: false, turns: [
      { id: 'tq2', at: CLOCK - DAY - 3600000, role: 'q', text: 'What is SPY doing into the open?', tickers: ['SPY'] },
      { id: 'ta2', at: CLOCK - DAY - 3500000, role: 'a', text: 'GO on the opening range breakout.', verdict: 'GO', tickers: ['SPY'] }] },
  ];
  api.state.drive = { configured: true, connected: true, email: 'tony@example.com', files: [{ path: 'TradeHub/backup/d1-2026-11-12.json.gz', id: 'fbackup0001xx', size: 52_000, at: CLOCK - 6 * 3600000 }] };
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP + `;window.__long=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__long.push([Math.round(e.startTime), Math.round(e.duration)]);});}).observe({type:'longtask',buffered:false});}catch(e){}
    window.__opened=[]; window.open=function(u){ window.__opened.push(String(u)); return null; };` });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const asked = (p, method) => api.asked.filter((x) => x.p === p && (!method || x.method === method)).length;
  const text = (sel) => js(`var e=document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : '';`);
  const stubDialogs = (promptAnswer) => js(`window.uiConfirm=function(){return Promise.resolve(true);}; window.uiPrompt=function(){return Promise.resolve(${JSON.stringify(promptAnswer)});}; 1`);

  console.log('\nThe Playbook through Notebook\'s API');
  await size(1280, 900);
  await boot({ quant: true, docs: { 'dashboards/tradeboard_playbook': PLAYBOOK } });
  await tab('playbook');
  ok('the Playbook opens (Notebook instance pb)', await until(`document.querySelectorAll('#pb-entries-list .entry-item').length > 0`, 20000));
  await js(`document.querySelector('#pb-entries-list .entry-item[data-entry-id="pb_rules"] .entry-item-title').click(); 1`);
  await sleep(800);
  const both = await js(`return Notebook.page('pb','pb_rules').then(function(p){ var e=document.getElementById('pb-page-editor'); return JSON.stringify({ api: p && p.text, editor: e ? e.innerText : null, title: p && p.title }); });`).then(JSON.parse);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  ok('a page read through Notebook.page equals what the editor shows', both.api && norm(both.api) === norm(both.editor) && /Never average down on a gap/.test(both.api) && both.title === 'Rules', JSON.stringify(both));

  console.log('\nThe four cards');
  await tab('control');
  ok('Control mounts Memory & Drive', await until(`document.querySelector('[data-memory]') && document.querySelector('[data-me-drive-state]')`, 20000));
  ok('four cards on the grid: Drive, Memory, History, Search', await js(`return ['drive','memory','history','search'].every(function(id){return !!document.querySelector('[data-memory] .lay-card[data-card="'+id+'"]');});`));
  ok('...with Add card and Reset layout in its header', await js(`var r=document.querySelector('[data-memory]'); return !!r.querySelector('[data-lay-reset]') && !!r.querySelector('[data-lay-add]');`));
  await shot('memory-1280');

  console.log('\nDrive');
  const dv = await text('[data-me-drive]');
  ok('connected, the account, the newest backup', /Connected/i.test(dv) && /tony@example\.com/.test(dv) && /d1-2026-11-12\.json\.gz \(51 KB\)/.test(dv), dv);
  ok('the Playbook snapshot goes to Drive on a day a page changed (once)', await until(`true`, 1500) && (api.posted.drive || []).some((x) => /^TradeHub\/playbook\/\d{4}-\d{2}-\d{2}\.json$/.test(x.path) && /Never average down/.test(x.body)) && (api.posted.drive || []).length === 1, JSON.stringify((api.posted.drive || []).map((x) => x.path)));
  await stubDialogs('');
  await js(`document.querySelector('[data-me-disconnect]').click(); 1`);
  ok('Disconnect (after an in-page confirm): the card says Not connected', await until(`/Not connected/i.test(document.querySelector('[data-me-drive]').innerText)`, 5000) && asked('/drive/disconnect', 'POST') === 1);
  await js(`document.querySelector('[data-me-connect]').click(); 1`);
  ok('Connect Drive opens Google\'s consent page in a new tab', await until(`window.__opened.length === 1`, 5000) && /accounts\.google\.com/.test(await js(`return window.__opened[0];`)));

  console.log('\nMemory');
  ok('Neo\'s proposal is listed apart, with Accept', !!(await js(`return document.querySelector('[data-me-proposed] [data-me-card="mpropose01"] [data-me-accept]');`)));
  await js(`document.querySelector('[data-me-accept="mpropose01"]').click(); 1`);
  ok('Accept makes it active, as Tony', await until(`document.querySelector('[data-me-active] [data-me-card="mpropose01"]')`, 5000) && (api.posted.patches || []).some((b) => b.state === 'active' && b.by === 'tony'));
  await js(`document.querySelector('[data-me-text]').value='Earnings week: half size'; document.querySelector('[data-me-kind]').value='lesson'; document.querySelector('[data-me-addbtn]').click(); 1`);
  ok('a card of Tony\'s own: active at once', await until(`[...document.querySelectorAll('[data-me-active] [data-me-card]')].some(function(e){return /Earnings week: half size/.test(e.innerText);})`, 5000) && api.posted.cards.some((x) => x.source === 'tony'));
  await stubDialogs('Earnings week: quarter size');
  const newId = api.state.cards.find((x) => /Earnings week/.test(x.text)).id;
  await js(`document.querySelector('[data-me-edit="${newId}"]').click(); 1`);
  ok('edit (in-page prompt)', await until(`/quarter size/.test(document.querySelector('[data-me-card="${newId}"]').innerText)`, 5000));
  await js(`document.querySelector('[data-me-pin="${newId}"]').click(); 1`);
  ok('pin', await until(`document.querySelector('[data-me-card="${newId}"]').classList.contains('is-pinned')`, 5000));
  await js(`document.querySelector('[data-me-archive="mpropose01"]').click(); 1`);
  ok('archive: out of the active list, back with "Show archived"', await until(`!document.querySelector('[data-me-active] [data-me-card="mpropose01"]')`, 5000) && await (async () => { await js(`document.querySelector('[data-me-showarch]').click(); 1`); return until(`document.querySelector('[data-me-archived] [data-me-card="mpropose01"]')`, 3000); })());

  console.log('\nHistory');
  ok('conversations grouped by day: Today, Yesterday', /TODAY[\s\S]*Is NVDA a buy here\?[\s\S]*YESTERDAY[\s\S]*Market open plan/i.test(await text('[data-me-hlist]')));
  await js(`var i=document.querySelector('[data-me-htk]'); i.value='nvda'; i.dispatchEvent(new Event('input')); 1`);
  ok('ticker filter', await until(`document.querySelectorAll('[data-me-conv]').length === 1 && document.querySelector('[data-me-conv="ctoday0001"]')`, 3000));
  await js(`var i=document.querySelector('[data-me-htk]'); i.value=''; i.dispatchEvent(new Event('input')); var s=document.querySelector('[data-me-hv]'); s.value='GO'; s.dispatchEvent(new Event('change')); 1`);
  ok('verdict filter', await until(`document.querySelectorAll('[data-me-conv]').length === 1 && document.querySelector('[data-me-conv="cyday00001"]')`, 3000));
  await js(`var s=document.querySelector('[data-me-hv]'); s.value=''; s.dispatchEvent(new Event('change')); document.querySelector('[data-me-hpin="cyday00001"]').click(); 1`);
  ok('pin a conversation', await until(`/Pinned/.test(document.querySelector('[data-me-conv="cyday00001"]').innerText)`, 5000));
  ok('no "Continue" until Neo Quant exists (Phase 9)', !(await js(`return !!document.querySelector('[data-me-hcont]');`)));
  await js(`document.querySelector('[data-me-hdel="ctoday0001"]').click(); 1`);
  ok('delete one (after an in-page confirm)', await until(`!document.querySelector('[data-me-conv="ctoday0001"]')`, 5000));

  console.log('\nSearch');
  const search = async (q) => {
    await js(`window.__long=[]; var i=document.querySelector('[data-me-q]'); i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); 1`);
    await until(`document.querySelector('[data-me-results] [data-me-hit], [data-me-nohit]')`, 8000); await sleep(250);
    return js(`return JSON.stringify([...document.querySelectorAll('[data-me-hit]')].map(function(e){return [e.dataset.kind, e.innerText];}));`).then(JSON.parse);
  };
  let hits = await search('discipline');
  ok('a Playbook page is found (read through Notebook\'s API)', hits.some(([k, t]) => k === 'playbook' && /discipline/i.test(t)), JSON.stringify(hits));
  hits = await search('breakout volume');
  ok('a memory card is found', hits.some(([k]) => k === 'card'), JSON.stringify(hits));
  hits = await search('SPY');
  ok('a conversation turn is found by its ticker', hits.some(([k, t]) => k === 'turn' && /Market open plan/.test(t)), JSON.stringify(hits));
  hits = await search('zebra quantum');
  ok('nothing found says so', hits.length === 0 && !!(await js(`return document.querySelector('[data-me-nohit]');`)));
  const long = await js(`return JSON.stringify(window.__long||[]);`).then(JSON.parse);
  ok('no main-thread task over 50 ms while searching', long.every((x) => x[1] <= 50), JSON.stringify(long));

  console.log('\nLayouts');
  for (const [w, hgt] of [[1280, 900], [820, 1100], [390, 844]]) {
    await size(w, hgt); await sleep(500);
    ok(`${w} px: no sideways scroll, the four cards there`, (await js(`return document.scrollingElement.scrollWidth <= window.innerWidth + 1;`)) && (await js(`return document.querySelectorAll('[data-memory] .lay-card').length;`)) === 4);
    await shot('memory-' + w);
  }
  ok('no uncaught errors', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
