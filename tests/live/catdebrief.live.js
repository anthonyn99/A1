// The Catalysts debrief ▶ end to end, in the real pages against the fake
// Firestore (catdebrief.js, tests/catdebrief.test.js for the unit half):
//
//   • Tony's and Veda's TaskHubs: a catalyst that came out shows ▶, one that
//     has not does not, a holiday never does, a day of 2+ earnings shows ONE;
//     pressing it hands MAGI a debrief of that event, in that TaskHub's
//     profile, with that profile's units from dashboards/catalyst_debrief;
//   • magi.html: a link naming Veda opens in Veda's profile, and an open Tony
//     console that receives one switches to Veda with the prompt kept;
//   • TradeHub ▸ Catalysts: the settings card writes that doc (units per
//     profile, templates stored empty when default).
//
// Run: node tests/live/catdebrief.live.js
'use strict';
const fs = require('fs');
const path = require('path');
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const SHOTS = process.env.SHOTS_DIR || path.join(require('os').tmpdir(), 'catdebrief-shots');
fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const pad = (n) => ('0' + n).slice(-2);
const key = (dt) => dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
const now = new Date();
const dow = (now.getDay() + 6) % 7;                                   // 0 = Monday
const day = (i) => key(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
// A day of THIS week that is over (yesterday; Monday's run uses today, whose
// 4:40 PM ET may not have passed, so the due checks are then skipped) and one
// still ahead (Sunday, or tomorrow on a Sunday... which is next week: skip).
const PAST = dow > 0 ? day(-1) : null;
const FUTURE = dow < 6 ? day(6 - dow) : null;
const decode = (url) => JSON.parse(Buffer.from(/#tb=([^&]+)/.exec(url)[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

const EVENTS = [];
if (PAST) EVENTS.push(
  { id: 'mc_cpi_' + PAST, kind: 'macro', category: 'inflation', name: 'September CPI Report', date: PAST, importance: 'high' },
  { id: 'mc_hol_' + PAST, kind: 'holiday', category: 'holiday', name: 'Market Holiday', date: PAST },
  { id: 'earn_TSM_' + PAST, kind: 'earnings', ticker: 'TSM', name: 'TSM Earnings', date: PAST, category: 'earnings', when: 'bmo', epsEst: 2.6 },
  { id: 'earn_NFLX_' + PAST, kind: 'earnings', ticker: 'NFLX', name: 'NFLX Earnings', date: PAST, category: 'earnings', when: 'amc' },
  // Three releases at 10:00 ET: ONE card, ONE ▶ (grouped releases, 2026-10-29).
  { id: 'mc_um_' + PAST, kind: 'macro', category: 'sentiment', name: 'UMich Consumer Sentiment', date: PAST, importance: 'medium' },
  { id: 'mc_ism_' + PAST, kind: 'macro', category: 'growth', name: 'ISM Services PMI', date: PAST, importance: 'high' },
  { id: 'mc_jolts_' + PAST, kind: 'macro', category: 'jobs', name: 'JOLTS Job Openings', date: PAST, importance: 'low' });
if (FUTURE) EVENTS.push({ id: 'mc_ppi_' + FUTURE, kind: 'macro', category: 'inflation', name: 'September PPI Report', date: FUTURE, importance: 'medium' });
const CFG = { tony: { units: ['grok'] }, veda: { units: ['gemini', 'claude'] }, templates: { earnings: '', macro: '' }, savedAt: Date.now() - 60000 };

(async () => {
  const c = await connect({ mock: firebaseMock() });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 250; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(250); } return false; };
  const size = (w, h) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const shot = async (name) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const seed = async (extra) => {
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: ORIGIN + '/A1/tni.js' }); await sleep(400);
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1b_disabled','1');
      ${extra || ''}
      sessionStorage.setItem('__fakefs_docs', JSON.stringify({ 'dashboards/market_calendar': { events: ${JSON.stringify(EVENTS)}, savedAt: Date.now() }, 'dashboards/catalyst_debrief': ${JSON.stringify(CFG)} })); 1`);
  };
  // window.open is replaced so a press is recorded, not a real tab opened
  // (a new tab would escape this harness and load the live site).
  const STUB = `window.__opened = []; window.open = function(u, n){ window.__opened.push({u:u, n:n}); var t = { name:n||'', focus:function(){}, location:{ href:'about:blank', replace:function(x){ window.__opened.push({nav:x}); this.href=x; } } }; return t; }; 1`;

  for (const who of ['tony', 'veda']) {
    console.log(`\n${who === 'tony' ? 'Tony' : 'Veda'}'s TaskHub`);
    await size(1440, 1000);
    await seed(`localStorage.setItem('td6_mainDash','${who}'); localStorage.setItem('a1_sweep_day:index', ${JSON.stringify(day(0))});`);
    await c.send('Page.navigate', { url: ORIGIN + '/A1/index.html' });
    await sleep(10000);
    await js("var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
    await sleep(1500);
    ok('catdebrief.js loaded and took the settings doc', await js(`return !!window.A1Debrief && window.A1Debrief.config().${who}.units.join() === ${JSON.stringify(CFG[who].units.join())};`),
      await js(`return window.A1Debrief ? JSON.stringify(window.A1Debrief.config()) : 'missing';`));
    const btns = () => js(`return JSON.stringify([...document.querySelectorAll('.mc-debrief')].filter(b=>b.offsetParent).map(b=>b.getAttribute('aria-label')));`).then(JSON.parse);
    const b = await btns();
    if (PAST) {
      ok('the CPI print that came out has ▶', b.some((l) => /September CPI Report/.test(l)), b);
      ok('a day of two earnings shows ONE ▶, for both reports', b.filter((l) => /earnings/.test(l)).length === 1 && b.some((l) => /TSM, NFLX earnings/.test(l)), b);
      ok('a market holiday never does', !b.some((l) => /Holiday/.test(l)), b);
      ok('three 10:00 releases show ONE ▶ for all of them', b.filter((l) => /UMich|ISM|JOLTS/.test(l)).length === 1 && b.some((l) => /UMich Consumer Sentiment, ISM Services PMI, JOLTS Job Openings/.test(l)), b);
      const card = JSON.parse(await js(`var c=[...document.querySelectorAll('[data-mc-group]')].find(x=>x.offsetParent); return JSON.stringify(c?{n:c.getAttribute('data-mc-group'),t:c.innerText,stray:[...document.querySelectorAll('span')].filter(d=>d.offsetParent&&!d.closest('[data-mc-group]')&&/^ISM Services PMI$/.test(d.textContent.trim())).length}:null);`));
      ok('…on one card listing each release with its impact', card && card.n === '3' && /3 releases/.test(card.t) && /High/.test(card.t) && /UMich Consumer Sentiment/.test(card.t) && /JOLTS Job Openings/.test(card.t) && card.stray === 0, JSON.stringify(card));
      ok('…and the CPI print at 8:30 keeps its own card', b.some((l) => /^Debrief September CPI Report in MAGI$/.test(l)), b);
    }
    if (FUTURE) ok('a release still ahead has none yet', !b.some((l) => /PPI/.test(l)), b);
    await js(`document.querySelector('.mc-debrief') && document.querySelector('.mc-debrief').scrollIntoView({block:'center'}); 1`);
    await sleep(400);
    await shot(`taskhub-${who}-desktop`);
    await js(`var c=[...document.querySelectorAll('[data-mc-group]')].find(x=>x.offsetParent); c && c.scrollIntoView({block:'center'}); 1`);
    await sleep(300);
    await shot(`taskhub-${who}-group`);
    if (PAST) {
      await js(STUB);
      await js(`[...document.querySelectorAll('.mc-debrief')].find(b=>b.offsetParent&&/CPI/.test(b.getAttribute('aria-label'))).click(); 1`);
      await sleep(400);
      const o = JSON.parse(await js(`return JSON.stringify(window.__opened);`));
      const nav = o.find((x) => x.nav);
      ok('the press opens the one MAGI tab', o[0] && o[0].n === 'a1tab_magi', JSON.stringify(o).slice(0, 200));
      const p = nav && decode(nav.nav);
      ok(`in ${who}'s profile`, p && p.p === who, p && p.p);
      ok(`with ${who}'s units from the settings doc`, p && p.units.join() === CFG[who].units.join(), p && p.units);
      ok('debriefing that release, by name and time', p && /^The September CPI Report just came out \(8:30 AM ET, /.test(p.q), p && p.q.slice(0, 80));
      ok('and it asks MAGI to run it', p && p.run === 1 && nav.nav.startsWith(ORIGIN + '/A1/magi.html#tb='));
      await js(`window.__opened.length = 0; [...document.querySelectorAll('.mc-debrief')].find(b=>b.offsetParent&&/earnings/.test(b.getAttribute('aria-label'))).click(); 1`);
      await sleep(400);
      const e = decode(JSON.parse(await js(`return JSON.stringify(window.__opened.find(x=>x.nav));`)).nav);
      await js(`window.__opened.length = 0; [...document.querySelectorAll('.mc-debrief')].find(b=>b.offsetParent&&/JOLTS/.test(b.getAttribute('aria-label'))).click(); 1`);
      await sleep(400);
      const gq = decode(JSON.parse(await js(`return JSON.stringify(window.__opened.find(x=>x.nav));`)).nav);
      ok('the group ▶ debriefs all three in one prompt', /^These 3 releases just came out together \(10:00 AM ET, /.test(gq.q) && /- UMich Consumer Sentiment \(Sentiment, 10:00 AM ET\)/.test(gq.q) && /- JOLTS Job Openings/.test(gq.q) && gq.p === who, gq.q.slice(0, 200));
      ok('the earnings ▶ debriefs each report on the card', /^Debrief each of these 2 reports separately \(TSM, NFLX\)/.test(e.q) && /TSM just reported earnings \(before the open/.test(e.q) && /consensus was \$2\.60/.test(e.q), e.q.slice(0, 120));
    }
    // Phone width: one day shows (today). Put a release on it and treat it as
    // out, so the button is drawn there; the button must not push the card
    // off its column.
    await js(`window.A1Debrief.isDue = function(){ return true; }; __fakeFs.remote('dashboards/market_calendar', { events: ${JSON.stringify(EVENTS.concat([{ id: 'mc_gdp_today', kind: 'macro', category: 'growth', name: 'GDP Second Estimate', date: day(0), importance: 'high' }]))}, savedAt: Date.now() }); 1`);
    await size(390, 844);
    await sleep(1200);
    await js(`document.querySelector('.mc-debrief') && document.querySelector('.mc-debrief').scrollIntoView({block:'center'}); 1`);
    await sleep(300);
    {
      const fit = JSON.parse(await js(`var b=[...document.querySelectorAll('.mc-debrief')].find(x=>x.offsetParent&&/GDP/.test(x.getAttribute('aria-label'))); if(!b) return 'null'; var r=b.getBoundingClientRect(), card=b.parentElement.parentElement.getBoundingClientRect(); return JSON.stringify({ inCard: r.right <= card.right + 0.5 && r.left >= card.left, w: r.width, vw: innerWidth, pageScroll: document.documentElement.scrollWidth > innerWidth + 1 });`));
      ok('on a phone the ▶ sits inside its card', fit && fit.inCard && fit.w >= 18, JSON.stringify(fit));
    }
    await shot(`taskhub-${who}-mobile`);
  }

  console.log('\nMAGI opens in the profile the link names');
  await size(1440, 900);
  const D_LINK = await js(`return window.A1Debrief.link('Debrief the September CPI Report', ['gemini'], 'veda');`);
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: D_LINK });
  await sleep(5000);
  ok('a fresh load lands in Veda’s profile', await js(`return PROFILE.id;`) === 'veda', await js(`return PROFILE.id;`));
  ok('…with the fragment stripped from the url', await js(`return !/tb=/.test(location.hash);`));
  ok('…and the debrief held for her console', await js(`return (HANDOFF && HANDOFF.q === 'Debrief the September CPI Report') || document.getElementById('composer').value === 'Debrief the September CPI Report';`));
  // An open Tony console receives Veda's link: it switches, prompt kept.
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Page.navigate', { url: ORIGIN + '/A1/magi.html' });
  await sleep(4000);
  ok('the console starts as Tony', await js(`return PROFILE.id;`) === 'tony');
  await js(`location.hash = ${JSON.stringify(D_LINK.slice(D_LINK.indexOf('#')))}; 1`);
  await sleep(5000);
  ok('Veda’s link switches it to Veda', await js(`return PROFILE.id;`) === 'veda', await js(`return PROFILE.id;`));
  ok('…carrying the debrief across the reload', await js(`return (HANDOFF && HANDOFF.q === 'Debrief the September CPI Report') || document.getElementById('composer').value === 'Debrief the September CPI Report';`));

  console.log('\nTradeHub ▸ Catalysts ▸ Debrief in MAGI');
  for (const [w, h, tag] of [[1440, 1000, 'desktop'], [390, 844, 'mobile']]) {
    await size(w, h);
    await seed(`localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));`);
    await c.send('Page.navigate', { url: ORIGIN + '/A1/tradehub.html' });
    if (!(await until("document.querySelector('.tb-navtab')", 20000))) { ok('TradeHub rendered', false); continue; }
    await sleep(2000);
    await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="catalysts"]')].find(b=>b.offsetParent); if(t) t.click(); 1`);
    ok(`(${tag}) the settings card is on Catalysts`, await until(`[...document.querySelectorAll('button')].some(b=>/^Debrief in MAGI/.test(b.title||''))`, 10000));
    ok(`(${tag}) its summary reads the stored units`, await js(`var b=[...document.querySelectorAll('button')].find(b=>/^Debrief in MAGI/.test(b.title||'')); return !!b && /Tony: 1 unit · Veda: 2 units/.test(b.title);`), await js(`var b=[...document.querySelectorAll('button')].find(b=>/^Debrief in MAGI/.test(b.title||'')); return b && b.title;`));
    await js(`[...document.querySelectorAll('button')].find(b=>/^Debrief in MAGI/.test(b.title||'')).click(); 1`);
    await sleep(500);
    const fits = await js(`return document.documentElement.scrollWidth <= innerWidth + 1;`);
    ok(`(${tag}) no sideways scroll when open`, fits);
    await shot(`tradehub-${tag}`);
    if (tag !== 'desktop') continue;
    // The template box wears the suite's grip (resizegrip.js), not the
    // native corner, and a drag on it resizes the box.
    ok('the template box has MAGI’s corner grip', await js(`var ta=document.querySelector('textarea.tb-debrief-tpl'); return !!ta && !!ta.parentElement.querySelector('.a1-grip') && getComputedStyle(ta).resize === 'none';`));
    {
      const g = JSON.parse(await js(`var ta=document.querySelector('textarea.tb-debrief-tpl'); ta.scrollIntoView({block:'center'}); var r=ta.parentElement.querySelector('.a1-grip').getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,h:ta.getBoundingClientRect().height});`));
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 8; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x, y: g.y + i * 10, button: 'left', buttons: 1 }); await sleep(16); }
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y + 80, button: 'left', clickCount: 1 });
      await sleep(300);
      const h2 = await js(`return document.querySelector('textarea.tb-debrief-tpl').getBoundingClientRect().height;`);
      ok('dragging the grip makes the box taller', h2 > g.h + 50, g.h + ' → ' + h2);
      await js(`var ta=document.querySelector('textarea.tb-debrief-tpl'); ta.style.height='120px'; ta.scrollTop=60; ta.dispatchEvent(new Event('scroll')); 1`);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x - 60, y: g.y - 40 });
      await sleep(400);
      await shot('tradehub-template-grip');
      await js(`var ta=document.querySelector('textarea.tb-debrief-tpl'); ta.style.height=''; 1`);
    }
    // Tick Grok for Veda: the doc gets it, in the canonical order.
    await js(`var rows=[...document.querySelectorAll('#tradeboard-root .dbf-name')].filter(d=>/^Veda’s MAGI/.test(d.textContent)); var sec=rows[0].parentElement; [...sec.querySelectorAll('button')].find(b=>/Grok/.test(b.textContent)).click(); 1`);
    await sleep(1800);
    let d = JSON.parse(await js(`return JSON.stringify(__fakeFs.docs['dashboards/catalyst_debrief']);`));
    ok('ticking a unit for Veda writes her list', d.veda.units.join() === 'claude,gemini,grok', JSON.stringify(d.veda));
    ok('…and leaves Tony’s alone', d.tony.units.join() === 'grok');
    // Edit the earnings template the way React hears typing.
    await js(`var ta=document.querySelector('textarea[aria-label="Earnings debrief template"]'); var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(ta,'{ticker} earnings just came out. Give me the results, consensus, expected market movement'); ta.dispatchEvent(new Event('input',{bubbles:true})); 1`);
    await sleep(1800);
    d = JSON.parse(await js(`return JSON.stringify(__fakeFs.docs['dashboards/catalyst_debrief']);`));
    ok('a custom template is stored', d.templates.earnings === '{ticker} earnings just came out. Give me the results, consensus, expected market movement', d.templates.earnings);
    ok('the default one stays empty (so a better default reaches it)', d.templates.macro === '');
    await js(`[...document.querySelectorAll('button')].find(b=>/^Preview/.test(b.textContent.trim())).click(); 1`);
    await sleep(300);
    ok('the preview fills the template in', await js(`var p=document.querySelector('pre'); return !!p && /^[A-Z]+ earnings just came out\\. Give me the results/.test(p.textContent);`), await js(`var p=document.querySelector('pre'); return p && p.textContent.slice(0,80);`));
    await shot('tradehub-desktop-edited');
    await js(`[...document.querySelectorAll('button')].find(b=>/Reset to default/.test(b.textContent)).click(); 1`);
    await sleep(1800);
    d = JSON.parse(await js(`return JSON.stringify(__fakeFs.docs['dashboards/catalyst_debrief']);`));
    ok('Reset to default stores it empty again', d.templates.earnings === '', d.templates.earnings);

    // "Set as default" (2026-10-14): the prompt becomes what Reset restores.
    const type = (v) => js(`var ta=document.querySelector('textarea[aria-label="Earnings debrief template"]'); var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(ta,${JSON.stringify(v)}); ta.dispatchEvent(new Event('input',{bubbles:true})); 1`);
    const press = (re) => js(`var b=[...document.querySelectorAll('button')].find(b=>${re}.test(b.textContent)); if(b) b.click(); return !!b && !b.disabled;`);
    const tplVal = () => js(`return document.querySelector('textarea[aria-label="Earnings debrief template"]').value;`);
    ok('Set as default is held while the prompt IS the default', await js(`return [...document.querySelectorAll('button')].find(b=>/Set as default/.test(b.textContent)).disabled;`));
    await type('My default for {ticker}');
    await sleep(300);
    await press('/Set as default/');
    await sleep(1800);
    d = JSON.parse(await js(`return JSON.stringify(__fakeFs.docs['dashboards/catalyst_debrief']);`));
    ok('Set as default stores the prompt as the default', d.defaults && d.defaults.earnings === 'My default for {ticker}', JSON.stringify(d.defaults));
    ok('…and the template, now equal to it, is stored empty', d.templates.earnings === '', d.templates.earnings);
    ok('…and the macro default stays the built-in one (empty)', d.defaults.macro === '');
    await shot('tradehub-set-default');
    await type('A one-off edit');
    await sleep(300);
    await press('/Reset to default/');
    await sleep(1800);
    ok('Reset to default restores the one Tony set', await tplVal() === 'My default for {ticker}', await tplVal());
    ok('…then offers Reset to built-in', await js(`return [...document.querySelectorAll('button')].some(b=>/Reset to built-in/.test(b.textContent)&&!b.disabled);`));
    await press('/Reset to built-in/');
    await sleep(1800);
    d = JSON.parse(await js(`return JSON.stringify(__fakeFs.docs['dashboards/catalyst_debrief']);`));
    // Releases together: the window and the Together prompt.
    ok('the Together prompt has its own tab', await press('/^Together$/'));
    await sleep(300);
    ok('…with the group template and its blanks', await js(`var ta=document.querySelector('textarea[aria-label="Together debrief template"]'); return !!ta && ta.value === window.A1Debrief.TEMPLATES.group && document.querySelector('.dbf-tokens').textContent.indexOf('{events}') >= 0;`));
    ok('…and a preview of releases together', await js(`var p=document.querySelector('pre'); return !!p && p.textContent.indexOf('releases just came out together') > 0;`), await js(`var p=document.querySelector('pre'); return p && p.textContent.slice(0,80);`));
    await js(`[...document.querySelectorAll('.dbf-grp button')].find(b=>b.textContent.trim()==='30 min').click(); 1`);
    await sleep(1800);
    d = JSON.parse(await js(`return JSON.stringify(__fakeFs.docs['dashboards/catalyst_debrief']);`));
    ok('the grouping window is stored', d.groupMin === 30, d.groupMin);
    await shot('tradehub-together');
    await press('/^Earnings$/');
    await sleep(300);
    ok('Reset to built-in brings back the built-in prompt', await tplVal() === await js(`return window.A1Debrief.TEMPLATES.earnings;`));
    ok('…and clears the stored default', d.defaults.earnings === '' && d.templates.earnings === '', JSON.stringify(d));
  }

  const real = errs.filter((e) => !/firebase|gstatic|googleapis|Failed to fetch|NetworkError|recaptcha|appCheck|App Check/i.test(e));
  ok('no page errors', !real.length, real.join(' | '));
  console.log(`\n  screenshots: ${SHOTS}`);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
