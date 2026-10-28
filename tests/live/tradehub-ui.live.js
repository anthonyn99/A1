// TradeHub's Control, Catalysts and News tabs (redesign, 2026-10-27). Real
// tradehub.html (TH_PAGE_FILE serves a work-in-progress copy), fake Firestore,
// fake newshub / trade-dashboard workers.
//
//   1. Control: the watchlist tiles and the prompt list render; Edit opens the
//      prompt in Notebook (instance prm) inside the Prompts card, seeded from its
//      Markdown; typing then Done writes Markdown back to the prompt; a new prompt
//      opens straight into the editor; a title typed in Notebook renames it;
//      leaving the tab mid-edit keeps the edit; the Playbook still opens beside it
//   2. Catalysts: day rows, the High tag in pastel red, the Earnings/Macro view
//   3. News: the feed, the pulse counts filter it, the Filters panel, Clear all
//   4. 390px: nothing scrolls sideways on any of the three; shots at both widths
//
// Run: node tests/live/tradehub-ui.live.js   (TH_PAGE_FILE=<copy> to test a copy)
'use strict';
const fs = require('fs');
const { connect, evalJs, sleep, shotPath } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const URL = ORIGIN + '/A1/tradehub.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const NOW = Date.now();
const day = (n) => { const d = new Date(NOW + n * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const PROMPTS = { savedAt: NOW - 60000, prompts: [
  { id: 'p_a', name: 'Morning Macro', text: '## Overview\n\n- **Rates** first\n- Then earnings' },
  { id: 'p_b', name: 'Quick', text: 'Be brief.' },
] };
const src = (h, n, m) => ({ headline: h, url: 'https://example.com/' + encodeURIComponent(h), name: n, ts: NOW - m * 60000 });
const EVENTS = [
  { id: 'n1', primaryTicker: 'NVDA', additionalTickers: ['AMD'], sectors: ['Semiconductors'], impact: { tier: 'critical', score: 92 }, sentiment: { label: 'bull', score: 0.62 }, eventType: 'earnings', aiAnalyzed: true, ts: NOW - 10 * 60000,
    summary: 'Nvidia guides data-center revenue well above estimates as Blackwell ramps.', sources: [src('Why Nvidia Stock Just Jumped', 'Yahoo', 12), src('Nvidia raises guidance', 'Reuters', 30), src('Blackwell demand', 'Bloomberg', 50)] },
  { id: 'n2', primaryTicker: 'MU', sectors: ['Semiconductors'], impact: { tier: 'major', score: 74 }, sentiment: { label: 'bear', score: -0.4 }, eventType: 'analyst', aiAnalyzed: true, ts: NOW - 5 * 3600000,
    summary: 'Micron cut at two brokers on memory pricing worries.', sources: [src('Micron downgraded', 'CNBC', 300)] },
  { id: 'n3', primaryTicker: 'AMD', sectors: ['Semiconductors'], impact: { tier: 'notable', score: 40 }, sentiment: { label: 'neutral', score: 0 }, eventType: 'other', aiAnalyzed: true, ts: NOW - 20 * 3600000,
    summary: 'AMD to present at an investor conference next week.', sources: [src('AMD at conference', 'MarketWatch', 1200)] },
];
const GEN = NOW - 15 * 60000;
const CAL = [
  { id: 'c1', date: day(0), kind: 'macro', category: 'inflation', name: 'CPI Report', importance: 'high' },
  { id: 'c2', date: day(0), kind: 'earnings', category: 'earnings', name: 'NVDA Earnings', ticker: 'NVDA', when: 'amc', confirmed: true },
  { id: 'c6', date: day(1), kind: 'macro', category: 'housing', name: 'New Home Sales', importance: 'low' },
  { id: 'c3', date: day(2), kind: 'macro', category: 'fed', name: 'FOMC Rate Decision', importance: 'high' },
  { id: 'c4', date: day(3), kind: 'earnings', category: 'earnings', name: 'MU Earnings', ticker: 'MU', when: 'bmo', confirmed: false },
  { id: 'c5', date: day(5), kind: 'macro', category: 'jobs', name: 'Jobless Claims', importance: 'medium' },
];

const worker = {
  patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    if (/\/news\?/.test(req.url)) return { json: { events: EVENTS, generatedAt: GEN, cached: true } };
    if (/\/quotes\?/.test(req.url)) return { json: { quotes: { NVDA: { c: 182.4, dp: 4.21 }, MU: { c: 101.2, dp: -3.05 }, AMD: { c: 160.1, dp: 0.4 } }, asOf: NOW } };
    if (/\/rate-status/.test(req.url)) return { json: { used: 2, cooldownSec: 0 } };
    if (/\/calendar\?/.test(req.url)) return { json: { events: CAL } };
    return { json: { ok: true } };
  },
};

(async () => {
  const c = await connect({ mock: firebaseMock(worker) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  const size = (w, h) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const shot = async (name) => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotPath(name), Buffer.from(s.result.data, 'base64')); };
  const tab = async (id) => { await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(b=>b.offsetParent); if(t) t.click(); 1`); await sleep(900); };
  const btn = (scope, text) => js(`var b=[...document.querySelectorAll('${scope} button')].find(x=>x.offsetParent&&x.innerText.trim()==='${text}'); if(b){b.click();return true;} return false;`);
  const prompts = () => js(`return JSON.stringify((__fakeFs.docs['dashboards/tradeboard_prompts']||{}).prompts||[]);`).then(JSON.parse);
  const store = () => js(`return JSON.stringify(__fakeFs.docs['dashboards/tradehub_prompts']||null);`).then(JSON.parse);
  const editorOpen = (needle) => until(`(function(){ var h=document.querySelector('#tradeboard-root .tb-pr-host'), r=document.getElementById('prm-root'), e=document.getElementById('prm-page-editor'); return h && r && h.contains(r) && e && e.getAttribute('contenteditable')==='true' && ${needle ? `e.innerText.indexOf(${JSON.stringify(needle)})>=0` : 'true'}; })()`, 20000);
  // Done lives in Notebook's own title row (the done mount option), on the phone in its header.
  const done = () => js(`var b=[...document.querySelectorAll('#prm-root .nb-done-btn')].find(x=>x.offsetParent); if(b){b.click();return true;} return false;`);
  const typeEnd = async (text) => {
    await js(`var e=document.getElementById('prm-page-editor'); e.focus(); var r=document.createRange(); r.selectNodeContents(e); r.collapse(false); var s=getSelection(); s.removeAllRanges(); s.addRange(r); 1`);
    await c.send('Input.insertText', { text });
  };

  await size(1280, 900);
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
  await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
    sessionStorage.setItem('__fakefs_docs', JSON.stringify({
      'dashboards/tradeboard_prompts': ${JSON.stringify(PROMPTS)},
      'dashboards/tradeboard_watchlist': { tickers: ['NVDA','MU','AMD'], trash: [], savedAt: ${NOW} },
      'dashboards/tradeboard_news': { events: ${JSON.stringify(EVENTS)}, generatedAt: ${GEN}, savedAt: ${GEN} },
      'dashboards/market_calendar': { events: ${JSON.stringify(CAL)}, generatedAt: ${NOW - 3600000}, savedAt: ${NOW - 3600000}, wlSig: 'AMD,MU,NVDA' }
    })); 1`);
  await c.send('Page.navigate', { url: URL });
  if (!(await until("document.querySelector('.tb-navtab')", 15000))) throw new Error('TradeHub did not render');
  await sleep(2500);

  console.log('\nControl');
  await tab('prompt');
  ok('the watchlist shows a tile per ticker', await until(`document.querySelectorAll('#tradeboard-root .ctl-tk').length===3`, 6000), await js(`return document.querySelectorAll('#tradeboard-root .ctl-tk').length;`));
  ok('the prompt list shows both prompts, the first selected', await until(`document.querySelectorAll('#tradeboard-root .tb-pchip').length===2 && document.querySelector('#tradeboard-root .tb-pchip.on').innerText.indexOf('Morning Macro')>=0`, 6000));
  ok('the preview renders its Markdown', await js(`var p=document.querySelector('#tradeboard-root .ctl-pr-preview'); return !!p && !!p.querySelector('h2') && /Rates/.test(p.innerText);`));
  await shot('tradehub-control');

  await btn('#tradeboard-root .ctl-pr-bar', 'EDIT');
  ok('Edit opens the prompt in Notebook inside the Prompts card, seeded from its Markdown', await editorOpen('Rates'));
  ok('"Editing in T\'s Notebook" and Done sit in Notebook title row, beside the title; no bar above it', await js(`var w=document.querySelector('#prm-toolbar .nb-done'), t=document.getElementById('prm-entry-title-input'); return !!w && t.nextSibling===w && /^Editing in T's Notebook/.test(w.innerText) && !document.querySelector('#tradeboard-root .ctl-pr-bar');`));
  ok('...as a Notebook instance without its sidebar', await js(`var s=document.getElementById('prm-sidebar'); return !s || getComputedStyle(s).display==='none' || s.getBoundingClientRect().width===0;`));
  ok('...and the watchlist steps aside for the editor', await js(`return getComputedStyle(document.querySelector('#tradeboard-root .ctl-wl')).display==='none';`));
  await shot('tradehub-control-edit');
  await typeEnd(' Watch yields.');
  await sleep(3500);
  await done();
  await sleep(1800);
  let P = await prompts();
  const pa = P.find((p) => p.id === 'p_a') || {};
  ok('Done writes the text back to the prompt, as Markdown', /Watch yields\./.test(pa.text) && /\*\*Rates\*\*/.test(pa.text) && /^## Overview/.test(pa.text), JSON.stringify(pa));
  ok('...stamped with the page\'s time', pa.nbAt > 0, pa.nbAt);
  ok('...and the preview shows it', await until(`/Watch yields/.test((document.querySelector('#tradeboard-root .ctl-pr-preview')||{}).innerText||'')`, 4000));
  let S = await store();
  ok('the page is saved in dashboards/tradehub_prompts', S && S.e_p_a && /Watch yields/.test(S.e_p_a.data.html), JSON.stringify(S && Object.keys(S)));

  await js(`[...document.querySelectorAll('#tradeboard-root .tb-pchip')].find(b=>/Quick/.test(b.innerText)).click(); 1`); await sleep(400);
  await btn('#tradeboard-root .ctl-pr-bar', 'EDIT');
  ok('switching prompts opens the other one', await editorOpen('Be brief.'));
  await done(); await sleep(1200);
  P = await prompts();
  ok('opening without typing leaves the prompt as it was', (P.find((p) => p.id === 'p_b') || {}).text === 'Be brief.', JSON.stringify(P.find((p) => p.id === 'p_b')));

  await btn('#tradeboard-root .ctl-prompts .ctl-card-head', 'NEW'); await sleep(300);
  await js(`var i=document.querySelector('#tradeboard-root .ctl-prompts .ctl-add input'); var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,'Earnings Recap'); i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
  await btn('#tradeboard-root .ctl-prompts .ctl-add', 'CREATE');
  ok('a new prompt opens straight into an empty editor', await editorOpen() && await js(`return document.getElementById('prm-page-editor').innerText.trim()==='' && document.querySelector('#tradeboard-root .tb-pchip.on').innerText.indexOf('Earnings Recap')>=0;`));
  await typeEnd('Focus on guidance.');
  await js(`var t=document.getElementById('prm-entry-title-input'); t.value='Earnings Debrief'; t.dispatchEvent(new Event('input',{bubbles:true})); 1`);
  await sleep(3500);
  await done(); await sleep(1800);
  P = await prompts();
  const pn = P.find((p) => /^p_\d+$/.test(p.id)) || {};
  ok('its text is saved to the prompt list', pn.text === 'Focus on guidance.', JSON.stringify(pn));
  ok('a title typed in Notebook renames the prompt', pn.name === 'Earnings Debrief' && await js(`return [...document.querySelectorAll('#tradeboard-root .tb-pchip')].some(b=>/Earnings Debrief/.test(b.innerText));`), pn.name);

  await js(`[...document.querySelectorAll('#tradeboard-root .tb-pchip')].find(b=>/Quick/.test(b.innerText)).click(); 1`); await sleep(300);
  await btn('#tradeboard-root .ctl-pr-bar', 'EDIT');
  await editorOpen('Be brief.');
  await typeEnd(' Short.');
  await sleep(400);
  await tab('playbook');
  ok('leaving the tab mid-edit keeps the edit', await until(`/Short\\./.test(((__fakeFs.docs['dashboards/tradeboard_prompts']||{}).prompts||[]).map(p=>p.text).join('|'))`, 6000), JSON.stringify(await prompts()));
  ok('the Playbook opens beside the prompts editor', await until(`(function(){ var r=document.getElementById('pb-root'), h=document.querySelector('#tradeboard-root .tb-pb-host'); return r && h && h.contains(r); })()`, 20000));
  await tab('prompt');
  ok('back on Control, the editor is closed and the preview shows the edit', await until(`!document.querySelector('#tradeboard-root .tb-pr-host') && /Short\\./.test((document.querySelector('#tradeboard-root .ctl-pr-preview')||{}).innerText||'')`, 4000));

  console.log('\nCatalysts');
  await tab('catalysts');
  ok('a row per day, today first', await until(`document.querySelectorAll('#tradeboard-root .cat-day').length===5 && document.querySelector('#tradeboard-root .cat-day').classList.contains('is-today')`, 6000), await js(`return document.querySelectorAll('#tradeboard-root .cat-day').length;`));
  ok('the High tag is pastel red', await js(`var t=[...document.querySelectorAll('#tradeboard-root .cat-imp')].find(x=>x.innerText==='High'); return !!t && getComputedStyle(t).color==='rgb(239, 154, 154)';`),
    await js(`var t=[...document.querySelectorAll('#tradeboard-root .cat-imp')].find(x=>x.innerText==='High'); return t?getComputedStyle(t).color:'none';`));
  ok('an earnings row says when it lands', await js(`return [...document.querySelectorAll('#tradeboard-root .cat-time')].some(x=>x.innerText==='After close');`));
  ok('every day label (TOMORROW too) stays clear of the times', await js(`return [...document.querySelectorAll('#tradeboard-root .cat-day')].every(d=>(function(e){var r=document.createRange();r.selectNodeContents(e);return r.getBoundingClientRect().right;})(d.querySelector('.cat-dow')) <= d.querySelector('.cat-events').getBoundingClientRect().left - 12);`), await js(`return JSON.stringify([...document.querySelectorAll('#tradeboard-root .cat-day')].map(d=>[Math.round((function(e){var r=document.createRange();r.selectNodeContents(e);return r.getBoundingClientRect().right;})(d.querySelector('.cat-dow'))), Math.round(d.querySelector('.cat-events').getBoundingClientRect().left)]));`));
  await shot('tradehub-catalysts');
  await js(`[...document.querySelectorAll('#tradeboard-root .cat-bar button')].find(b=>/^Earnings/.test(b.innerText)).click(); 1`); await sleep(300);
  ok('the Earnings view shows only earnings', await js(`return document.querySelectorAll('#tradeboard-root .cat-ev').length===2;`), await js(`return document.querySelectorAll('#tradeboard-root .cat-ev').length;`));
  await js(`[...document.querySelectorAll('#tradeboard-root .cat-bar button')].find(b=>/^All/.test(b.innerText)).click(); 1`);
  await btn('#tradeboard-root .tbx-actions', 'DEBRIEF');
  ok('Debrief opens its settings under the header', await until(`[...document.querySelectorAll('#tradeboard-root .cat-debrief')].length===1`, 3000));
  ok('its unit rows name each person’s MAGI', await js(`return [...document.querySelectorAll('#tradeboard-root .dbf-name')].map(x=>x.innerText).join('|')==="Tony’s MAGI|Veda’s MAGI";`));
  await sleep(300); await shot('tradehub-debrief');
  await btn('#tradeboard-root .tbx-actions', 'DEBRIEF');

  console.log('\nNews');
  await tab('news');
  ok('the feed shows every event', await until(`document.querySelectorAll('#tradeboard-root .nh-ev').length===3`, 8000), await js(`return document.querySelectorAll('#tradeboard-root .nh-ev').length;`));
  await sleep(800);
  await shot('tradehub-news');
  await js(`[...document.querySelectorAll('#tradeboard-root .nh-pulse button')].find(b=>/bullish/i.test(b.innerText)).click(); 1`); await sleep(300);
  ok('the Bullish count filters the feed', await js(`return document.querySelectorAll('#tradeboard-root .nh-ev').length===1 && /bullish/i.test(document.querySelector('#tradeboard-root .nh-results').innerText);`));
  await js(`[...document.querySelectorAll('#tradeboard-root .nh-tools button')].find(b=>/filters/i.test(b.innerText)).click(); 1`); await sleep(300);
  ok('Filters opens impact and sector', await js(`var p=document.querySelector('#tradeboard-root .nh-panel'); return !!p && /impact/i.test(p.innerText) && /sector/i.test(p.innerText);`));
  await js(`document.querySelector('#tradeboard-root .nh-clear').click(); 1`); await sleep(300);
  ok('Clear all brings the whole feed back', await js(`return document.querySelectorAll('#tradeboard-root .nh-ev').length===3;`));

  console.log('\nAnalysis');
  await tab('analysis');
  ok('Launch and Deploy sit in the header', await until(`(function(){ var h=document.querySelector('#tradeboard-root .ana-page .tbx-head'); return !!h && /launch analysis/i.test(h.innerText) && /deploy auto launch/i.test(h.innerText); })()`, 6000));
  ok('the prompt pills, the preview, Send to and Searches render', await js(`return document.querySelectorAll('#tradeboard-root .ana-pchip').length>=2 && !!document.querySelector('#tradeboard-root .ana-preview-doc h2') && /send to/i.test(document.querySelector('#tradeboard-root .ana-grid').innerText) && /searches/i.test(document.querySelector('#tradeboard-root .ana-grid').innerText);`));
  await shot('tradehub-analysis');
  // Tap Quick (not the starred one), then Edit in Control: Control opens on Quick.
  await js(`[...document.querySelectorAll('#tradeboard-root .ana-pchip')].find(x=>/Quick/.test(x.innerText)).click(); 1`); await sleep(80);
  await js(`[...document.querySelectorAll('#tradeboard-root .ana-chip')].find(x=>/edit in control/i.test(x.innerText)).click(); 1`); await sleep(900);
  ok('Edit in Control opens Control on that prompt', await until(`(function(){ var on=document.querySelector('#tradeboard-root .tb-pchip.on'); return !!on && /Quick/.test(on.innerText); })()`, 4000),
    await js(`var on=document.querySelector('#tradeboard-root .tb-pchip.on'); return on?on.innerText:'none';`));

  console.log('\nPhone width');
  await size(390, 844); await sleep(1000);
  for (const [id, name] of [['analysis', 'tradehub-analysis-phone'], ['news', 'tradehub-news-phone'], ['catalysts', 'tradehub-catalysts-phone'], ['prompt', 'tradehub-control-phone']]) {
    await tab(id); await sleep(600);
    if (id === 'catalysts') ok('catalysts: every day label (TOMORROW too) stays clear of the times',
      await js(`return [...document.querySelectorAll('#tradeboard-root .cat-day')].every(d=>{ var w=d.querySelector('.cat-dow').getBoundingClientRect(), e=d.querySelector('.cat-events').getBoundingClientRect(); return w.right <= e.left - 4; });`),
      await js(`return JSON.stringify([...document.querySelectorAll('#tradeboard-root .cat-day')].map(d=>[d.querySelector('.cat-dow').innerText, Math.round((function(e){var r=document.createRange();r.selectNodeContents(e);return r.getBoundingClientRect().right;})(d.querySelector('.cat-dow'))), Math.round(d.querySelector('.cat-events').getBoundingClientRect().left)]));`));
    ok(id + ': nothing scrolls sideways', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1 && [...document.querySelectorAll('#tradeboard-root .tbx-page')].every(p=>p.scrollWidth<=p.clientWidth+1);`), await js(`return document.documentElement.scrollWidth;`));
    await shot(name);
    if (id === 'catalysts') {
      await btn('#tradeboard-root .tbx-actions', 'DEBRIEF');
      ok('the debrief panel fits a phone', await until(`!!document.querySelector('#tradeboard-root .dbf') && document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('#tradeboard-root .dbf').scrollWidth <= document.querySelector('#tradeboard-root .dbf').clientWidth + 1`, 3000));
      await sleep(300); await shot('tradehub-debrief-phone');
      await btn('#tradeboard-root .tbx-actions', 'DEBRIEF');
    }
  }
  await btn('#tradeboard-root .ctl-pr-bar', 'EDIT');
  ok('the editor opens on a phone too', await editorOpen('Be brief.'));
  await sleep(500);
  await shot('tradehub-control-edit-phone');
  await done(); await sleep(800);
  console.log('  shots in ' + shotPath('tradehub-control').replace(/[^\\/]+$/, ''));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  c.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
