// TradeHub Quant, Phase 9: Neo Quant in the real page (A1-Priv tradehub.html +
// TradeHub/neo/), quant-api and ORCA played here (quant-mock.js).
//
//   1. the dock on every tab: the Halo launcher, Ctrl+K, a panel beside the tab on a desktop
//   2. a question streams in: verdict chip, labelled sections, cited facts (a tap shows one);
//      the request carried the asked-for packs; the conversation kept one row per turn
//   3. a number not on the sheet: one retry with the same model, then struck with a note
//   4. every provider failing: what was tried and why, never a made-up reply
//   5. the browser units are never called without a press; a press lists them, another asks one
//   6. research goes to Gemini with search, with no account figure on its sheet
//   7. Deep dive hands the question to MAGI
//   8. the Neo Quant tab: the same conversation, the brief, What changed?, recent conversations;
//      the dock steps aside there; its cards tile
//   9. Control ▸ Memory & Drive ▸ History: Continue opens the conversation in the dock
//  10. the pink only on Neo Quant's surfaces; 1280, 820, 390 px (panel, slide-over, sheet);
//      no task over 50 ms while an answer streams; no uncaught error
//
// Run: node tests/live/tradehub-quant-neo.live.js   (SHOTS_DIR=… for screenshots;
//      TH_PAGE_FILE=… to drive a work-in-progress copy of tradehub.html)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, CLOCK, FIXTURE } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};

(async () => {
  const api = quantApi();
  // The snapshot before (What changed?): a day earlier, a weaker regime.
  api.state.prevSnapshot = { ...FIXTURE, day: '2026-11-11', slot: 'close', at: FIXTURE.at - 86400000, due: FIXTURE.due - 86400000, regime: { ...FIXTURE.regime, label: 'Choppy', score: 44.5 } };
  api.state.ai.brief = { day: FIXTURE.day, kind: 'daily', at: CLOCK - 3600000, text: 'VERDICT: Constructive into the open [F2].\nWHY: Breadth is firm [F3].\nRISK: VIX could lift.\nWATCH: SPY at its first resistance.', provider: 'groq', struck: [] };
  api.state.convs = [{ id: 'cold000001', title: 'AMD into earnings', created: CLOCK - 86400000, pinned: false, turns: [
    { id: 'to1', at: CLOCK - 86400000, role: 'q', text: 'AMD into earnings?', tickers: ['AMD'] },
    { id: 'to2', at: CLOCK - 86400000 + 4000, role: 'a', text: 'VERDICT: WAIT until the report.\nWHY: Event risk.', verdict: 'WAIT', tickers: ['AMD'] }] }];
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP + `;window.__long=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__long.push([Math.round(e.startTime), Math.round(e.duration)]);});}).observe({type:'longtask',buffered:false});}catch(e){}
    window.__opened=[]; window.open=function(u,n){ window.__opened.push([String(u||''), String(n||'')]); return null; };` });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const ai = () => api.posted.ai || [];
  const orca = () => api.posted.orca || [];
  // Each ask waits for ITS answer: one more answer than before, finished.
  let asked = 0;
  const ask = async (q) => {
    asked = await js(`return document.querySelectorAll('[data-nq-a]').length;`);
    await js(`var i=document.querySelector('[data-nq-dock] [data-nq-input]')||document.querySelector('[data-nq-input]'); i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})); 1`);
  };
  const lastA = (sel = '') => `[...document.querySelectorAll('${sel}[data-nq-a]')].pop()`;
  const doneA = (sel = '') => until(`(function(){var all=document.querySelectorAll('${sel}[data-nq-a]'), a=all[all.length-1]; return all.length > ${'${asked}'} && a && /done|failed/.test(a.dataset.state);})()`, 10000);

  console.log('\nThe dock on every tab');
  await size(1280, 900);
  await boot({ quant: true });
  await tab('market');
  ok('the Halo launcher is there on the Market tab', await until(`document.querySelector('[data-nq-launch]') && !document.querySelector('[data-nq-launch]').hidden`, 15000));
  ok('the nav has a Neo Quant tab', await js(`return !!document.querySelector('.tb-navtab[data-navid="neo"]');`));
  ok('no AI call, no ORCA call before anything is asked', ai().length === 0 && orca().length === 0);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); 1`);
  ok('Ctrl+K opens it: a panel beside the tab on a desktop (the page narrows)', await until(`document.querySelector('[data-nq-dock]') && !document.querySelector('[data-nq-dock]').hidden && document.querySelector('[data-nq-dock]').dataset.size==='desktop' && document.documentElement.classList.contains('nq-docked')`, 5000)
    && await js(`return parseFloat(getComputedStyle(document.querySelector('#tradeboard-root .tb-scroll-visible')).marginRight) > 300 && document.querySelector('[data-nq-scrim]').hidden;`));
  ok('...the empty conversation offers questions to start with', await js(`return document.querySelectorAll('[data-nq-dock] [data-nq-tip]').length >= 3;`));

  console.log('\nA question');
  await js('window.__long=[]; 1');
  await ask('Is NVDA a buy here?');
  ok('the answer streams in and finishes', await doneA());
  const req = ai()[0] && ai()[0].body;
  ok('one fast-lane call, with the system prompt and the packs the question needs', ai().length === 1 && ai()[0].p === '/ai/chat' && /You are Neo Quant/.test(req.system) && req.facts.some((f) => f.pack === 'ticker' && /NVDA/.test(f.text)) && req.facts.some((f) => f.pack === 'market') && req.facts.some((f) => f.pack === 'now'), JSON.stringify(req && req.facts.map((f) => f.pack)));
  ok('...the question is the last message', req.messages[req.messages.length - 1].content === 'Is NVDA a buy here?');
  const a1 = await js(`var a=${lastA()}; return JSON.stringify({ chip: (a.querySelector('[data-nq-verdict]')||{}).textContent, secs: [...a.querySelectorAll('.nq-sec')].map(function(s){return s.dataset.sec;}), cites: a.querySelectorAll('[data-nq-cite]').length, struck: !!a.querySelector('[data-nq-struck]') });`).then(JSON.parse);
  ok('verdict chip WATCH, the four labelled sections, cited facts, nothing struck', a1.chip === 'WATCH' && a1.secs.join() === 'VERDICT,WHY,RISK,WATCH' && a1.cites >= 2 && !a1.struck, JSON.stringify(a1));
  await js(`${lastA()}.querySelector('[data-nq-cite]').click(); 1`);
  ok('a tap on a cited fact shows it, its source and how fresh it is', await until(`(function(){var f=${lastA()}.querySelector('[data-nq-fact]'); return f && /NVDA/.test(f.innerText) && f.querySelector('.nq-label');})()`, 3000));
  const turns = api.posted.turns || [];
  ok('the conversation is kept: one row per turn, the question and the reply in one conversation', turns.length === 2 && turns[0].turn.role === 'q' && turns[1].turn.role === 'a' && turns[0].conv === turns[1].conv && turns[1].turn.verdict === 'WATCH' && turns[1].turn.tickers.includes('NVDA'), JSON.stringify(turns.map((t) => [t.conv, t.turn.role])));
  const long1 = await js(`return JSON.stringify(window.__long||[]);`).then(JSON.parse);
  ok('no main-thread task over 50 ms while it answered', long1.every((x) => x[1] <= 50), JSON.stringify(long1));
  await shot('neo-dock-1280');

  console.log('\nThe number checker');
  const n0 = ai().length;
  api.state.ai.plan.push({ text: 'VERDICT: GO. NVDA trades at 999.99 [F1].\nWHY: It will hit 1234.56.\nRISK: none.\nWATCH: nothing.' }, { text: 'VERDICT: GO. NVDA is at 999.99 and heads to 1234.56.\nWHY: momentum.\nRISK: none.\nWATCH: nothing.' });
  await ask('And for a swing?');
  await doneA();
  const retry = ai()[n0 + 1] && ai()[n0 + 1].body;
  ok('a made-up number: one retry, the same model, quoting the numbers', ai().length === n0 + 2 && retry.provider === 'groq' && /999\.99/.test(retry.messages[retry.messages.length - 1].content));
  const st = await js(`var a=${lastA()}; return JSON.stringify({ s: [...a.querySelectorAll('s.nq-struck')].map(function(x){return x.textContent;}), note: (a.querySelector('[data-nq-struck]')||{}).textContent||'' });`).then(JSON.parse);
  ok('...failing again: shown with those numbers struck, and a note', st.s.includes('999.99') && st.s.includes('1234.56') && /not on the fact sheet/.test(st.note), JSON.stringify(st));
  ok('...and the follow-up carried the conversation so far', ai()[n0].body.messages.length === 3);

  console.log('\nAll failed');
  api.state.ai.plan.push({ fail: [{ provider: 'groq', why: 'HTTP 503' }, { provider: 'cerebras', why: 'no first token in 8 s' }] });
  await ask('What about AMD?');
  await doneA();
  const fl = await js(`var a=${lastA()}; return JSON.stringify({ state: a.dataset.state, text: a.innerText, chip: !!a.querySelector('[data-nq-verdict]') });`).then(JSON.parse);
  ok('every provider failing: what was tried and why, no reply text, no verdict', fl.state === 'failed' && /Groq: HTTP 503/.test(fl.text) && /Cerebras: no first token/.test(fl.text) && !fl.chip && !/VERDICT/.test(fl.text), JSON.stringify(fl));
  ok('...with Try again and Ask the units', await js(`var a=${lastA()}; return !!a.querySelector('[data-nq-retry]') && !!a.querySelector('[data-nq-askunits]');`));

  console.log('\nThe browser units: only on a press');
  ok('no ORCA call so far (three answers, a retry and a failure)', orca().length === 0, JSON.stringify(orca()));
  await js(`${lastA()}.querySelector('[data-nq-askunits]').click(); 1`);
  ok('a press lists the units that are up (not the offline one)', await until(`${lastA()}.querySelectorAll('[data-nq-unit]').length === 2`, 5000) && orca().length === 1 && orca()[0].p === '/v1/models');
  await js(`${lastA()}.querySelector('[data-nq-unit="deepseek/free"]').click(); 1`);
  ok('another press asks that unit; its reply is shown as the browser unit\'s', await until(`(function(){var a=${lastA()}; return a.dataset.state==='done' && /browser unit/i.test(a.innerText);})()`, 8000) && orca().some((x) => x.p === '/v1/chat/completions' && JSON.parse(x.body).model === 'deepseek/free'));

  console.log('\nResearch and Deep dive');
  const n1 = ai().length;
  await ask('Why is TSLA down today?');
  await doneA();
  const g = ai()[n1];
  ok('research goes to Gemini with search', g && g.p === '/ai/gemini' && g.body.job === 'search');
  ok('...with no account figure on its sheet', g && !g.body.facts.some((f) => f.private || f.pack === 'portfolio' || f.pack === 'journal'));
  await js(`window.__opened=[]; ${lastA()}.querySelector('[data-nq-deep]').click(); 1`);
  ok('Deep dive hands the question to MAGI (#tb=)', await until(`window.__opened.some(function(o){return /#tb=/.test(o[0]) || /magi/i.test(o[1]);})`, 3000), await js(`return JSON.stringify(window.__opened);`));

  console.log('\nThe Neo Quant tab');
  await tab('neo');
  ok('the tab mounts its four cards', await until(`['chat','brief','changed','recent'].every(function(id){return document.querySelector('[data-neo-tab] .lay-card[data-card="'+id+'"]');})`, 15000));
  ok('the dock steps aside there (the tab is the same conversation)', await js(`return document.querySelector('[data-nq-dock]').hidden && document.querySelector('[data-nq-launch]').hidden && !document.documentElement.classList.contains('nq-docked');`));
  ok('...which already holds the questions asked in the dock', await until(`document.querySelectorAll('[data-neo-tab] [data-nq-q]').length >= 4`, 3000));
  ok('the daily brief, its day and age, its sections', await until(`/Constructive into the open/.test((document.querySelector('[data-nq-brief]')||{}).innerText||'') && document.querySelector('[data-nq-briefday]')`, 5000));
  await js(`document.querySelector('[data-nq-changed-go]').click(); 1`);
  ok('What changed?: code finds the changes, the AI words them', await until(`/VERDICT|WATCH/.test(document.querySelector('[data-nq-changed]').innerText) && /Choppy to Constructive/.test(document.querySelector('[data-nq-changed] details').innerText)`, 8000), await js(`return document.querySelector('[data-nq-changed]').innerText;`));
  const ch = ai()[ai().length - 1].body;
  ok('...its sheet holds only code-made differences', ch.facts.every((f) => f.pack === 'changed') && /score 44\.5 → 63\.3/.test(ch.facts.map((f) => f.text).join(' ')), JSON.stringify(ch.facts.map((f) => f.text)));
  ok('recent conversations, each with Continue', await until(`document.querySelector('[data-nq-recent] [data-nq-continue="cold000001"]')`, 5000));
  await shot('neo-tab-1280');

  console.log('\nContinue from History');
  await tab('prompt');
  ok('Control ▸ Memory & Drive ▸ History now has Continue', await until(`document.querySelector('[data-me-hcont="cold000001"]')`, 15000));
  await js(`document.querySelector('[data-me-hcont="cold000001"]').click(); 1`);
  ok('Continue opens the dock with that conversation', await until(`!document.querySelector('[data-nq-dock]').hidden && /AMD into earnings/.test(document.querySelector('[data-nq-dock] [data-nq-list]').innerText) && /WAIT/.test(document.querySelector('[data-nq-dock] [data-nq-list]').innerText)`, 5000));
  const n2 = ai().length;
  await ask('Has anything changed for it?');
  await doneA();
  ok('...and a question there continues it (its turns in the messages, the same conversation id)', ai()[n2].body.messages.some((m) => /AMD into earnings/.test(m.content)) && (api.posted.turns || []).slice(-1)[0].conv === 'cold000001');

  console.log('\nThe pink, the layouts');
  const pink = await js(`var bad=[]; document.querySelectorAll('body *').forEach(function(e){ var s=getComputedStyle(e); var hit=[s.color,s.backgroundColor,s.borderTopColor,s.borderLeftColor,s.outlineColor].some(function(v){return /240, 179, 203/.test(v);}) && !(s.borderTopStyle==='none' && !/240, 179, 203/.test(s.color+s.backgroundColor+s.borderLeftColor)); if(hit && !e.closest('.nq-dock-root,[data-neo-tab],.nq-halo')) bad.push(e.tagName+'.'+e.className); }); return JSON.stringify(bad.slice(0,8));`).then(JSON.parse);
  ok('the pink appears only on Neo Quant\'s surfaces', pink.length === 0, JSON.stringify(pink));
  for (const [w, hgt, kind] of [[1280, 900, 'desktop'], [820, 1100, 'tablet'], [390, 844, 'phone']]) {
    await size(w, hgt); await sleep(400);
    await tab('market');
    await js(`var d=document.querySelector('[data-nq-dock]'); if(d.hidden) document.querySelector('[data-nq-launch]').click(); 1`);
    await sleep(300);
    const geo = await js(`var d=document.querySelector('[data-nq-dock]'), r=d.getBoundingClientRect(); return JSON.stringify({ size: d.dataset.size, w: Math.round(r.width), right: Math.round(r.right), bottom: Math.round(r.bottom), scrim: !document.querySelector('[data-nq-scrim]').hidden, sx: document.scrollingElement.scrollWidth <= innerWidth + 1 });`).then(JSON.parse);
    ok(`${w} px: the dock is a ${kind === 'desktop' ? 'panel beside the tab' : kind === 'tablet' ? 'slide-over' : 'bottom sheet'}${kind === 'desktop' ? '' : ' over a backdrop'}; no sideways scroll`, geo.size === kind && geo.scrim === (kind !== 'desktop') && geo.sx && geo.right <= w + 1 && (kind !== 'phone' || (geo.w >= w - 2 && geo.bottom >= hgt - 2)), JSON.stringify(geo));
    await shot('neo-dock-' + w);
    await js(`var i=document.querySelector('[data-nq-dock] [data-nq-input]'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`);
    ok(`${w} px: Escape closes it`, await until(`document.querySelector('[data-nq-dock]').hidden && !document.querySelector('[data-nq-launch]').hidden`, 2000));
    await tab('neo'); await sleep(400);
    ok(`${w} px: the Neo Quant tab, its four cards, no sideways scroll`, (await js(`return document.querySelectorAll('[data-neo-tab] .lay-card').length;`)) === 4 && (await js(`return document.scrollingElement.scrollWidth <= innerWidth + 1;`)));
    await shot('neo-tab-' + w);
  }
  ok('no uncaught errors', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
