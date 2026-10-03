// LIVE test -- A1's one numbers face on Tony's side (theme overhaul phase 10,
// docs/theme-overhaul-plan.md §2 "NUMBERS"): Inter, weight 500, tabular
// figures, in Tony's TaskHub + chrome, MyJournal, OneInbox, TradeHub, MyList
// (Tony), RiftIQ (WarRoom and ProView) and MAGI. Veda's sides keep theirs.
// Not run by run-all.js.
//
//   node tests/live/numbers-sweep.live.js
//
// Per page it checks three things:
//   1. body (and a button) carry font-variant-numeric: tabular-nums;
//   2. probes: an element built with each figure class the phase moved off
//      the mono face computes to Inter 500 tabular;
//   3. a scan: no visible, mostly-numeric text renders in IBM Plex Mono.
// Plus a source check for TradeHub's inline React styles, which only render
// with data behind them.
'use strict';
const fs = require('fs');
const path = require('path');
const { connect, evalJs, sleep } = require('./cdp.js');

const ORIGIN = 'https://anthonyn99.github.io';
const BASE = ORIGIN + '/A1/';
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  -> ' + String(d).slice(0, 400) : '')); }
};

// MyList waits for its Firebase module's hooks; hand it an empty Tony/Veda.
const MYLIST_BOOT = (profile) => `(()=>{ if(window.top!==window) return;
  try{ localStorage.setItem('ml_fav_profile', ${JSON.stringify(profile)}); }catch(e){}
  const L=[{id:'L1',name:'Shopping',stores:[],items:[{id:'i1',name:'Milk',qty:'2',store:'',desc:'',done:false}],createdAt:1}];
  window._mlLoad=()=>Promise.resolve({tony:{lists:L},veda:{lists:L},locks:{},lockV:{}});
  window._mlLoadOk=true; window._mlSave=()=>{};
  window._mlLoadEvents=()=>Promise.resolve([]); window._mlSaveEvents=()=>{};
  window._mlLoadPriceWatch=()=>Promise.resolve({items:[],stores:null,drops:[]}); window._mlSavePriceWatch=()=>{};
  window._mlLoadRecipes=()=>Promise.resolve([]); window._mlReady=true;
})();`;

let inj = null;
async function load(c, page, opts) {
  opts = opts || {};
  await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  if (inj) { await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier }); inj = null; }
  if (opts.boot) inj = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: opts.boot });
  if (opts.mainDash) {
    await c.send('Page.navigate', { url: BASE + 'oneinbox.html' }); await sleep(800);
    await evalJs(c, `localStorage.clear(); localStorage.setItem('td6_mainDash','${opts.mainDash}'); 1`);
  }
  await c.send('Page.navigate', { url: BASE + page });
  await sleep(opts.wait || 3500);
  await evalJs(c, "var l=document.getElementById('th-boot-loader'); if(l) l.remove(); 1");
}

// Build `html` inside `host` (a selector; falls back to body), read its font.
async function probe(c, host, html, pick) {
  return JSON.parse(await evalJs(c, `return JSON.stringify((function(){
    var h=document.querySelector(${JSON.stringify(host)})||document.body;
    var w=document.createElement('div'); w.setAttribute('data-numprobe','1'); w.innerHTML=${JSON.stringify(html)};
    h.appendChild(w);
    var e=w.querySelector(${JSON.stringify(pick)})||w.firstElementChild;
    var cs=getComputedStyle(e);
    var r={ff:cs.fontFamily,fw:cs.fontWeight,fvn:cs.fontVariantNumeric};
    w.remove(); return r;
  })());`));
}
// MAGI's stack leads with its glyph-only "MAGI Symbols" face; Inter is the text.
const isNum = (r) => /^\s*(?:"MAGI Symbols",\s*)?['"]?Inter\b/.test(r.ff) && r.fw === '500' && /tabular-nums/.test(r.fvn);

async function bodyTabular(c, label, sel) {
  const r = JSON.parse(await evalJs(c, `return JSON.stringify((function(){
    var b=document.querySelector(${JSON.stringify(sel || 'body')}); var btn=document.createElement('button'); b.appendChild(btn);
    var o={body:getComputedStyle(b).fontVariantNumeric, btn:getComputedStyle(btn).fontVariantNumeric}; btn.remove(); return o; })());`));
  ok(label + ': body is tabular-nums', /tabular-nums/.test(r.body), r.body);
  ok(label + ': a button is tabular-nums', /tabular-nums/.test(r.btn), r.btn);
}

// Visible leaves whose text is a figure ("12", "$1,204.50", "+3.2%", "4:05")
// must not render in IBM Plex Mono. `skip` excludes Veda's roots on index.
async function scan(c, label, scope) {
  const r = JSON.parse(await evalJs(c, `return JSON.stringify((function(){
    var bad=[], n=0, root=document.querySelector(${JSON.stringify(scope || 'body')})||document.body;
    var all=root.querySelectorAll('*');
    for (var i=0;i<all.length;i++){ var e=all[i];
      if (e.closest('code,pre,kbd,samp,[data-numprobe],#veda-root,#bj-root,.veda-hdr-outer,#thset-box.veda')) continue;
      var t=''; for (var k=0;k<e.childNodes.length;k++){ var nd=e.childNodes[k]; if(nd.nodeType===3) t+=nd.textContent; }
      t=t.trim(); if(!t || !/\\d/.test(t) || !/^[\\s$€£%+\\-−▲▼#.,:\\/0-9kKmMxXhs()]+$/.test(t)) continue;
      var b=e.getBoundingClientRect(); if(!b.width||!b.height) continue;
      n++;
      if (/Plex Mono/i.test(getComputedStyle(e).fontFamily)) bad.push((e.className||e.tagName)+':'+t);
    }
    return {n:n,bad:bad.slice(0,8)};
  })());`));
  ok(label + ': no figure in IBM Plex Mono (' + r.n + ' figures seen)', r.bad.length === 0, r.bad.join(' | '));
}

(async () => {
  const c = await connect();
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });

  // ── index.html: Tony's TaskHub + chrome, MyJournal ─────────────────────
  console.log('index.html (Tony)');
  await load(c, 'index.html', { mainDash: 'tony', wait: 9000 });
  ok('index: Tony profile marked', (await evalJs(c, "document.body.getAttribute('data-th-profile')")) === 'tony');
  await bodyTabular(c, 'index Tony');
  for (const [sel, html] of [
    ['#tj-root', '<div class="char-count">1,204 chars</div>'],
    ['#tj-root', '<div id="tj-sidebar-header"><span class="version">v2.4</span></div>'],
  ]) {
    const r = await probe(c, sel, html, '.char-count,.version');
    ok('index MyJournal ' + html.match(/class="([^"]+)"/)[1] + ' is Inter 500 tabular', isNum(r), JSON.stringify(r));
  }
  const plan = await evalJs(c, 'typeof PLAN_PAL_TONY!=="undefined" ? PLAN_PAL_TONY.MONO : "(none)"');
  ok("index: Tony's Plans figures face is Inter", /^'Inter'/.test(plan), plan);
  await scan(c, 'index Tony', '#root');

  console.log('index.html (Veda, unchanged)');
  await load(c, 'index.html', { mainDash: 'veda', wait: 9000 });
  const vb = await evalJs(c, 'getComputedStyle(document.body).fontVariantNumeric');
  ok('index Veda: body figures untouched (normal)', vb === 'normal', vb);
  const vp = await evalJs(c, 'typeof PLAN_PAL_VEDA!=="undefined" ? PLAN_PAL_VEDA.MONO : "(none)"');
  ok("index Veda: her Plans keep IBM Plex Mono", /Plex Mono/.test(vp), vp);

  // ── OneInbox ───────────────────────────────────────────────────────────
  console.log('oneinbox.html');
  await load(c, 'oneinbox.html');
  await bodyTabular(c, 'oneinbox');
  for (const html of ['<div class="navitem"><span class="cnt">128</span></div>',
                      '<div class="attach"><span class="sz">2.4 MB</span></div>',
                      '<div class="achip"><span class="sz">340 KB</span></div>']) {
    const r = await probe(c, 'body', html, '.cnt,.sz');
    ok('oneinbox ' + html.match(/<div class="([^"]+)"/)[1] + ' figure is Inter 500 tabular', isNum(r), JSON.stringify(r));
  }
  const code = await probe(c, 'body', '<div class="afield"><div class="v mono">1Z999AA10123456784</div></div>', '.v');
  ok('oneinbox: tracking/coupon codes stay mono', /Plex Mono/.test(code.ff), code.ff);
  await scan(c, 'oneinbox');

  // ── TradeHub ───────────────────────────────────────────────────────────
  console.log('tradehub.html');
  await load(c, 'tradehub.html', { wait: 6000 });
  await bodyTabular(c, 'tradehub', '#tradeboard-root');
  const num = await evalJs(c, 'typeof TB_NUM!=="undefined" ? TB_NUM : "(none)"');
  ok('tradehub: TB_NUM is Inter', /^'Inter'/.test(num), num);
  await scan(c, 'tradehub');
  const src = fs.readFileSync(path.join(ROOT, 'tradehub.html'), 'utf8');
  const plex = src.split('\n').filter((l) => /Plex Mono/.test(l) && !/fonts\.googleapis/.test(l));
  ok('tradehub source: Plex Mono only on code blocks', plex.length === 2 && plex.every((l) => / code\{/.test(l)), plex.map((l) => l.trim().slice(0, 90)).join(' | '));

  // ── MyList: Tony's profile on Inter, Veda's untouched ──────────────────
  for (const who of ['tony', 'veda']) {
    console.log('mylist.html (' + who + ')');
    await load(c, 'mylist.html', { boot: MYLIST_BOOT(who), wait: 4500 });
    const prof = await evalJs(c, "document.body.getAttribute('data-profile')||''");
    ok('mylist: profile is ' + who, prof === who, prof);
    const r = await probe(c, '#lists-bar', '<span class="list-chip"><span class="cnt">12</span></span>', '.cnt');
    const p = await probe(c, 'body', '<div class="pw-price">$18.99</div>', '.pw-price');
    if (who === 'tony') {
      await bodyTabular(c, 'mylist Tony');
      ok('mylist Tony: list count is Inter 500 tabular', isNum(r), JSON.stringify(r));
      ok('mylist Tony: price is Inter 500 tabular', isNum(p), JSON.stringify(p));
      await scan(c, 'mylist Tony', '#app');
    } else {
      ok('mylist Veda: list count keeps her Plex Mono', /Plex Mono/.test(r.ff) && !/tabular/.test(r.fvn), JSON.stringify(r));
      const vb2 = await evalJs(c, 'getComputedStyle(document.body).fontVariantNumeric');
      ok('mylist Veda: body figures untouched', vb2 === 'normal', vb2);
    }
  }
  if (inj) { await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inj.identifier }); inj = null; }

  // ── RiftIQ: WarRoom and ProView share the --mono token ─────────────────
  console.log('riftiq.html');
  await load(c, 'riftiq.html', { wait: 5000 });
  await bodyTabular(c, 'riftiq');
  for (const html of ['<div class="match-row"><span class="kda-val">8 / 2 / 11</span></div>',
                      '<div class="stats-numbers"><div class="sn-sub">142 games</div></div>', '<div class="io-cost">3,100</div>',
                      '<div class="ranked-card"><span class="division">II 54 LP</span></div>']) {
    const r = await probe(c, 'body', html, '.stat-val,.kda-val,.sn-sub,.io-cost,.division');
    ok('riftiq ' + html.match(/class="([^"]+)"/g).pop().slice(7, -1) + ' is Inter 500 tabular', isNum(r), JSON.stringify(r));
  }
  const strong = await probe(c, 'body', '<span class="stat-val">7.4</span>', '.stat-val');
  ok('riftiq: a figure with its own weight keeps it (stat-val 700)', strong.fw === '700', strong.fw);
  await scan(c, 'riftiq');

  // ── MAGI: numbers Inter, code stays mono ───────────────────────────────
  console.log('magi.html');
  await load(c, 'magi.html', { wait: 5000 });
  await bodyTabular(c, 'magi');
  for (const cls of ['sd-count', 'repo-num', 'code-auto-cd', 'br-step-n', 'au-line-time', 'node-meta', 'core-count', 'fc-num']) {
    const r = await probe(c, 'body', '<span class="' + cls + '">12</span>', '.' + cls);
    ok('magi .' + cls + ' is Inter 500 tabular', isNum(r), JSON.stringify(r));
  }
  for (const cls of ['repo-sha', 'code-ws-path', 'md-code']) {
    const r = await probe(c, 'body', '<span class="' + cls + '">a1b2c3d</span>', '.' + cls);
    ok('magi .' + cls + ' stays mono', /Plex Mono/.test(r.ff), r.ff);
  }
  await scan(c, 'magi');

  console.log(`\n${pass} passed, ${fail} failed`);
  c.close && c.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
