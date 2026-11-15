// TradeHub Quant, Phase 11: Neo Quant operates TradeHub, in the real page (A1-Priv
// tradehub.html + TradeHub/neo/registry.js, actions.js, commands.js, session.js,
// canvas.js, reg/*), quant-api played here (quant-mock.js), Chrome's fake mic.
//
//   1. a SPOKEN session across every tab with no reload: each turn is the mic, the clip
//      heard (/ai/hear plays the transcript), an instant command run (no AI call), its line
//      spoken, the mic released; Market, Charts (a ticker, an interval, zoom), Scanner ▸ Ledger,
//      News for a ticker and its Summary, Portfolio ▸ Activity, Journal, Catalysts, Analysis ▸
//      Debrief, Playbook, Paper, Control, the Neo Quant tab, "go back"
//   2. typed in the dock: a watchlist change and its Undo; a confirm action (No leaves it, Yes
//      runs it); display mode; "what can you do here?"
//   3. a control ask through the fast lane: DO lines run step by step (Charts layout, Journal
//      search, News filter, Analysis units), each undone; a bad step fed back once; CANNOT goes
//      to the wanted list (quant-api /wanted)
//   4. the Neo canvas: a dossier card on Charts (marked with a Halo), a risk card in the dock
//      (Portfolio has no grid), pinned → survives a reload, dismissed → gone, at 1280, 820, 390
//   5. no sideways scroll at any width, no uncaught error, no order route ever called
//
// Run: node tests/live/tradehub-quant-control.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const WAV = path.join(os.tmpdir(), 'tradehub-voice-live-nvda.wav');
if (!fs.existsSync(WAV)) {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Speech; $syn=New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
    `$fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);` +
    `$syn.SetOutputToWaveFile('${WAV}',$fmt);` +
    `$syn.SpeakSsml('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><break time="1s"/>Is Nvidia a buy here?<break time="7s"/></speak>');$syn.Dispose()`]);
}
process.env.CDP_PORT = process.env.CDP_PORT || '9352';
process.env.CDP_EXTRA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--use-file-for-fake-audio-capture=' + WAV, '--autoplay-policy=no-user-gesture-required'].join('\n');

const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const untilNode = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(100); } return !!f(); };

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [], urls = [];
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP + `;window.__streams=[];(function(){ var md=navigator.mediaDevices; if(!md||!md.getUserMedia) return; var g=md.getUserMedia.bind(md); md.getUserMedia=function(cn){ return g(cn).then(function(s){ window.__streams.push(s); return s; }); }; })();` });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Network.requestWillBeSent') urls.push(m.params.request.method + ' ' + m.params.request.url);
  });
  const { js, until, size, boot, shot } = driver(c);
  const hear = () => api.posted.hear || [];
  const ai = () => api.posted.ai || [];
  const speech = () => (api.posted.orca || []).filter((x) => x.p === '/v1/audio/speech').map((x) => JSON.parse(x.body || '{}'));
  const micLive = () => js(`return window.__streams.some(function(s){ return s.getTracks().some(function(t){ return t.readyState === 'live'; }); });`);
  const page = () => js(`return window._tbOps && window._tbOps.app ? window._tbOps.app.page() : null;`);
  const opsGet = (name) => js(`var o=window._tbOps&&window._tbOps.${name}; return o ? JSON.stringify(o.get()) : 'null';`).then(JSON.parse);
  const lastDo = () => js(`var t=window.__neo().neo.conversation().turns.filter(function(x){return x.role==='a';}).pop(); return t ? JSON.stringify({ kind: t.kind, state: t.state, text: t.text, dos: (t.dos||[]).map(function(d){return d.shown;}) }) : 'null';`).then(JSON.parse);
  const noScroll = () => js(`return document.documentElement.scrollWidth <= innerWidth + 1;`);
  const MIC = '[data-neo-tab] [data-nq-talk], [data-nq-mic], [data-nq-dock] [data-nq-talk]';

  /** One spoken turn: the transcript `said` is what /ai/hear hears. → { heard, spoke, released, ai } */
  async function speak(said) {
    api.state.ai.heard = [said];
    const h0 = hear().length, a0 = ai().length, s0 = speech().length;
    await js(`[...document.querySelectorAll(${JSON.stringify(MIC)})].find(function(b){ return b.getClientRects().length && !b.hidden; }).click(); 1`);
    const heard = await untilNode(() => hear().length > h0, 16000);
    const spoke = await untilNode(() => speech().length > s0, 10000);
    const released = await until(`(function(){ var m=[...document.querySelectorAll(${JSON.stringify(MIC)})].find(function(b){ return b.getClientRects().length; }); return !m || (m.dataset.mode||'off')==='off'; })()`, 12000);
    await sleep(250);
    return { heard, spoke, released, ai: ai().length - a0, said: speech().slice(s0).map((b) => b.input).join(' ') };
  }

  console.log('\nA spoken session across every tab (no reload)');
  await size(1280, 900);
  await boot({ quant: true });
  ok('Neo Quant\'s hooks are up: TradeHub\'s own and the open tab\'s', await until(`window._tbOps && window._tbOps.app && window._tbOps.portfolio`, 15000));
  await until(`document.querySelector('[data-nq-mic]') && !document.querySelector('[data-nq-mic]').hidden`, 15000);
  await js(`window.__neo = function(){ return window.__tbNeoApp; }; 1`);
  // The app is the one getNeoApp made; reach it through the dock's chat (the module keeps one).
  await js(`import('./TradeHub/neo/app.js').then(function(m){ window.__tbNeoApp = m.getNeoApp(); }); 1`);
  await until(`window.__tbNeoApp && window.__tbNeoApp.session`, 10000);
  const steps = [
    ['go to Market', async () => (await page()) === 'market'],
    ['open the charts', async () => (await page()) === 'charts'],
    ['show AMD', async () => (await until(`window._tbOps.charts && window._tbOps.charts.get().symbol==='AMD'`, 6000))],
    ['15 minute', async () => (await until(`window._tbOps.charts.get().tf==='15m'`, 6000))],
    ['zoom in', async () => /Zoomed in|loading/.test((await lastDo()).dos.join())],
    ['open the ledger', async () => (await page()) === 'scanner' && (await until(`window._tbOps.scanner && window._tbOps.scanner.get().view==='ledger'`, 8000))],
    ['news for NVDA', async () => (await page()) === 'news' && (await until(`window._tbOps.news && window._tbOps.news.get().tickers.indexOf('NVDA')>=0`, 8000))],
    ['open the summary', async () => /Opened the Summary/.test((await lastDo()).dos.join())],
    ['show me my activity', async () => (await page()) === 'portfolio' && (await until(`window._tbOps.portfolio && window._tbOps.portfolio.get().view==='activity'`, 8000))],
    ['go to journal', async () => (await page()) === 'journal'],
    ['open the calendar', async () => (await page()) === 'catalysts'],
    ['debrief', async () => (await page()) === 'analysis'],
    ['open my playbook', async () => (await page()) === 'playbook'],
    ['go to paper trading', async () => (await page()) === 'paper'],
    ['open settings', async () => (await page()) === 'prompt'],
    ['go to neo quant', async () => (await page()) === 'neo'],
    ['go back', async () => (await page()) === 'prompt'],
  ];
  const visited = new Set();
  let aiCalls = 0;
  for (const [said, check] of process.env.SKIP_SPOKEN ? [] : steps) {
    const r = await speak(said);
    const done = await check();
    visited.add(await page());
    aiCalls += r.ai;
    ok(`"${said}": heard, done, its line spoken, the mic released`, r.heard && done && r.spoke && r.released && !(await micLive()), JSON.stringify({ ...r, page: await page(), last: await lastDo() }));
  }
  if (!process.env.SKIP_SPOKEN) ok('every tab was visited by voice (12 tabs)', ['market', 'charts', 'scanner', 'news', 'portfolio', 'journal', 'catalysts', 'analysis', 'playbook', 'paper', 'prompt', 'neo'].every((t) => visited.has(t)), [...visited].join());
  if (!process.env.SKIP_SPOKEN) ok('...and not one AI call: every turn was an instant command', aiCalls === 0, aiCalls);
  if (!process.env.SKIP_SPOKEN) ok('spoken lines are the actions\' own words ("Opened Charts", "Opened Control", "Back to Control")', speech().some((b) => /Opened Charts/.test(b.input)) && speech().some((b) => /Opened Control/.test(b.input)) && speech().some((b) => /Back to Control/.test(b.input)), JSON.stringify(speech().map((b) => b.input)));

  console.log('\nTyped in the dock');
  const dockAsk = (q) => js(`var i=[...document.querySelectorAll('[data-nq-dock] [data-nq-input], [data-neo-tab] [data-nq-input]')].find(function(x){return x.getClientRects().length;}); i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})); 1`);
  await js(`window.__tbNeoApp.session.say('go to charts'); 1`);
  await until(`window._tbOps.charts`, 8000);
  await js(`var d=document.querySelector('[data-nq-dock]'); if(d.hidden) document.querySelector('[data-nq-launch]').click(); 1`);
  await until(`!document.querySelector('[data-nq-dock]').hidden`, 4000);
  await dockAsk('add IBM to the watchlist');
  ok('"add IBM to the watchlist": the watchlist has it; the turn lists it with an Undo', await until(`window._tbOps.app.watchlist().indexOf('IBM')>=0 && [...document.querySelectorAll('[data-nq-dock] [data-nq-dos] li')].some(function(l){return /Added IBM/.test(l.textContent);}) && document.querySelector('[data-nq-dock] [data-nq-undo]')`, 6000),
    await js(`return JSON.stringify({ wl: window._tbOps.app.watchlist(), dock: !document.querySelector('[data-nq-dock]').hidden, inputs: document.querySelectorAll('[data-nq-dock] [data-nq-input]').length, last: (([...document.querySelectorAll('[data-nq-dock] [data-nq-a]')].pop()||{}).innerText||'').slice(0,300), page: window._tbOps.app.page() });`));
  await js(`[...document.querySelectorAll('[data-nq-dock] [data-nq-undo]')].pop().click(); 1`);
  ok('...Undo takes it off again', await until(`window._tbOps.app.watchlist().indexOf('IBM')<0`, 6000));
  const wl0 = await js(`return window._tbOps.app.watchlist().join();`);
  await dockAsk('remove AMD from the watchlist');
  ok('a confirm action (a trash) asks Yes / No in the dock', await until(`document.querySelector('[data-nq-dock] [data-nq-confirm="asking"]')`, 6000));
  await js(`document.querySelector('[data-nq-dock] [data-nq-confirm-no]').click(); 1`);
  ok('...No: nothing changed', await until(`document.querySelector('[data-nq-dock] [data-nq-confirm="no"]')`, 4000) && (await js(`return window._tbOps.app.watchlist().join();`)) === wl0);
  await dockAsk('remove AMD from the watchlist');
  await until(`document.querySelector('[data-nq-dock] [data-nq-confirm="asking"]')`, 6000);
  await js(`document.querySelector('[data-nq-dock] [data-nq-confirm-yes]').click(); 1`);
  ok('...Yes: AMD goes (to Control\'s Trash)', await until(`window._tbOps.app.watchlist().indexOf('AMD')<0`, 6000));
  await dockAsk('undo');
  ok('..."undo" brings it back', await until(`window._tbOps.app.watchlist().indexOf('AMD')>=0`, 6000));
  await dockAsk('display mode on');
  ok('"display mode on" blurs the figures (html.tb-privacy); "off" brings them back', await until(`document.documentElement.classList.contains('tb-privacy')`, 4000) && (await dockAsk('display mode off'), await until(`!document.documentElement.classList.contains('tb-privacy')`, 4000)));
  await dockAsk('what can you do here?');
  ok('"what can you do here?" answers from the registry, the open tab first', await until(`/Here I can: Charts/.test([...document.querySelectorAll('[data-nq-dock] [data-nq-a]')].pop().innerText)`, 4000));

  console.log('\nA control ask through the fast lane');
  const a0 = ai().length;
  api.state.ai.plan.push({ text: 'DO: layout.hide card=levels\nDO: charts.set range=1Y\nSAY: Levels hidden, a year of bars.' });
  await dockAsk('hide the levels card and give me a year of bars');
  ok('ONE AI call (the control prompt: every action listed), then each step run and listed', await until(`window._tbOps.charts.get().range==='1Y' && !document.querySelector('[data-lay="charts"] [data-card="levels"]')`, 10000) && ai().length === a0 + 1 && /ACTIONS[\s\S]*layout\.hide/.test(ai()[a0].body.system), JSON.stringify(await lastDo()));
  await dockAsk('undo'); await dockAsk('undo');
  ok('...two undos: the range and the card come back', await until(`window._tbOps.charts.get().range!=='1Y' && document.querySelector('[data-lay="charts"] [data-card="levels"]')`, 8000));
  api.state.ai.plan.push({ text: 'DO: news.filter sentiment=happy' }, { text: 'DO: news.filter sentiment=bullish\nDO: analysis.tick unit=gemini on=yes' });
  const a1 = ai().length;
  await dockAsk('show only bullish news and tick Gemini');
  ok('a bad step is fed back once (two calls), then the fixed steps run (News filter, Analysis unit)', await until(`(function(){ var c=window._tbOps.app.analysisCfg(); return (c.magiUnits||[]).indexOf('gemini')>=0; })()`, 10000) && ai().length === a1 + 2 && /could not run/.test(ai()[a1 + 1].body.messages.slice(-1)[0].content));
  api.state.ai.plan.push({ text: 'CANNOT: options chains' });
  await dockAsk('show me the options chain for NVDA');
  ok('CANNOT: said plainly, and sent to the wanted list (quant-api /wanted)', await until(`/can't do that yet \\(options chains\\)/.test([...document.querySelectorAll('[data-nq-dock] [data-nq-a]')].pop().innerText)`, 8000) && (api.posted.wanted || []).some((w) => w.what === 'options chains' && w.kind === 'control'));

  console.log('\nThe Neo canvas');
  for (const [w, h] of [[1504, 900], [820, 1000], [390, 844]]) {
    await size(w, h);
    await js(`window.__tbNeoApp.session.say('go to charts'); 1`);
    await until(`window._tbOps.charts`, 8000);
    const before = await js(`return document.querySelectorAll('[data-lay="charts"] .nq-cv-host').length;`);
    api.state.ai.plan.push({ text: 'DO: canvas.show type=facts reader=charts.info where=dossier title="Chart now"' });
    await js(`window.__tbNeoApp.session.say('put what the chart shows on a card'); 1`);
    const placed = await until(`document.querySelectorAll('[data-lay="charts"] .nq-cv-host').length > ${before}`, 10000);
    const card = await js(`var c=[...document.querySelectorAll('[data-lay="charts"] .nq-cv-host')].pop(); return c ? JSON.stringify({ halo: !!c.querySelector('.nq-halo'), facts: !!c.querySelector('[data-nq-cv="facts"]'), w: Math.round(c.getBoundingClientRect().width), vw: innerWidth }) : 'null';`).then(JSON.parse);
    ok(`${w} px: a dossier card goes on Charts' grid, marked with a Halo, its facts drawn, inside the screen`, placed && card && card.halo && card.facts && card.w <= card.vw, JSON.stringify(card));
    ok(`${w} px: no sideways scroll`, await noScroll());
    await shot('control-canvas-' + w);
  }
  await size(1504, 900);
  const cards = await js(`return JSON.stringify(window.__tbNeoApp.canvas.cards());`).then(JSON.parse);
  const keep = cards[cards.length - 1];
  await js(`document.querySelector('[data-nq-cv-pin="${keep.id}"]').click(); 1`);
  ok('Pin: the card says Pinned and its spec is kept with the layout (reader, not data)', await until(`document.querySelector('[data-nq-cv-pin="${keep.id}"]').getAttribute('aria-pressed')==='true'`, 4000) && await js(`var d=JSON.parse(localStorage.getItem('tradehub_layout')||'{}'); return !!(d.neo_canvas && d.neo_canvas.cards.some(function(c){ return c.id==='${keep.id}' && c.reader==='charts.info' && !('data' in c); }));`));
  api.state.ai.plan.push({ text: 'DO: canvas.show type=table reader=portfolio.risk where=risk' });
  await js(`window.__tbNeoApp.session.say('show my risk as a table'); 1`);
  ok('a risk card belongs on Portfolio, which has no grid: it is drawn in the dock', await until(`document.querySelector('[data-nq-dock] [data-nq-cv-docked] [data-nq-cv="table"], [data-nq-dock] [data-nq-cv-docked] [data-nq-cv="note"]')`, 10000));
  await boot({ quant: true, keep: true });
  await js(`import('./TradeHub/neo/app.js').then(function(m){ window.__tbNeoApp = m.getNeoApp(); }); 1`);
  await js(`window.__tbNeoApp && window.__tbNeoApp.session && window.__tbNeoApp.session.say('go to charts'); 1`);
  await until(`window.__tbNeoApp && window.__tbNeoApp.session`, 10000);
  await js(`window.__tbNeoApp.session.say('go to charts'); 1`);
  ok('after a reload only the pinned card comes back on Charts (the session\'s others cleared)', await until(`document.querySelectorAll('[data-lay="charts"] .nq-cv-host').length===1 && document.querySelector('[data-nq-cv-pin="${keep.id}"]')`, 15000), await js(`return document.querySelectorAll('[data-lay="charts"] .nq-cv-host').length;`));
  await js(`document.querySelector('[data-nq-cv-dismiss="${keep.id}"]').click(); 1`);
  ok('Dismiss: gone from the grid and from the saved layout', await until(`!document.querySelector('[data-lay="charts"] .nq-cv-host')`, 4000) && await js(`var d=JSON.parse(localStorage.getItem('tradehub_layout')||'{}'); return !(d.neo_canvas && d.neo_canvas.cards.length);`));

  console.log('\nThe whole run');
  ok('no order route was ever called (no Alpaca order, no Webull write)', !urls.some((u) => /\/v2\/orders|\/paper\/orders|\/api\/order/i.test(u)), urls.filter((u) => /order/i.test(u)).join(' '));
  ok('no uncaught error', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  c.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
