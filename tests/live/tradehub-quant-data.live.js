// TradeHub Quant, Phase 1: Control ▸ Data & AI status in the real page
// (A1-Priv tradehub.html + TradeHub/ui/status.js), with quant-api and the two
// market-data WebSockets played here.
//
//   1. the Orca key comes from Shruti's doc when the device has none (one read, no write)
//   2. the card shows every provider with its state, the streams, and SPY/QQQ
//      with provider, time and a LIVE label from the stream
//   3. it fits at 1280, 820 and 390 px with no sideways scroll
//   4. killing the stream turns LIVE into STALE by time alone (DELAYED after 20 s, STALE after 90 s)
//   5. no key anywhere: a field to paste it, and pasting it brings the card up
//
// The page's clock is moved to a Tuesday at 10:00 New York, so "the market is
// open" whenever this runs. Run: node tests/live/tradehub-quant-data.live.js
'use strict';
const fs = require('fs');
const path = require('path');
const { connect, evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const URL = ORIGIN + '/A1/tradehub.html';
const KEY = 'orca_sk_livetest_0123456789abcdef';
const SHOTS = process.env.SHOTS_DIR || '';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

const asked = [];
const worker = {
  patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*', 'https://quant-api.av1-2.workers.dev/*'],
  handle(req) {
    if (req.method === 'OPTIONS') return { status: 204, text: '' };
    if (!req.url.includes('quant-api')) return { json: { ok: true } };
    const p = new global.URL(req.url).pathname;
    asked.push({ p, auth: (req.headers.Authorization || req.headers.authorization || '') });
    if (!/Bearer orca_sk_livetest/.test(req.headers.Authorization || req.headers.authorization || '')) return { status: 401, json: { ok: false, error: 'an Orca key is needed' } };
    if (p === '/usage') {
      const t = Date.now();
      return { json: { ok: true, day: '2026-11-10', usage: [{ service: 'alpaca', n: 120, cap: 30000 }, { service: 'yahoo', n: 5000, cap: 5000 }],
        caps: { alpaca: 30000, public: 5000, finnhub: 20000, yahoo: 5000, tiingo: 400, groq: 800 },
        keys: { alpaca: true, public: false, finnhub: true, yahoo: true, tiingo: false, groq: true },
        health: [
          { provider: 'alpaca', ok: 1, ok_at: t - 4000, median_ms: 180, fails: 0 },
          { provider: 'finnhub', ok: 0, ok_at: t - 900000, fails: 3, skip_until: t + 200000, detail: 'HTTP 500' },
          { provider: 'groq', ok: 1, ok_at: t - 60000, median_ms: 2600, fails: 0 },
        ] } };
    }
    if (p === '/corrections') return { json: { ok: true, corrections: [{ id: 1, at: Date.now() - 60000, kind: 'quote', symbol: 'NVDA', field: 'price', old_v: '190', new_v: '168.9', source: 'finnhub', note: 'outlier' }] } };
    if (p === '/stream-keys') return { json: { ok: true, alpaca: { key: 'AK', secret: 'AS' }, finnhub: { key: 'FK' } } };
    if (p === '/quotes') return { status: 503, json: { ok: false, error: 'no provider answered', missing: {} } };
    return { status: 404, json: { ok: false } };
  },
};

// Runs in the page before anything else: a fixed market-hours clock and the
// two providers' WebSockets. window.__ws.kill() leaves the socket open but silent.
const PAGE_SETUP = `(() => {
  const real = Date.now.bind(Date), shift = Date.UTC(2026, 10, 10, 15, 0, 0) - real();
  Date.now = () => real() + shift;
  const Real = window.WebSocket;
  const state = { live: true, sent: [], opened: [] };
  window.__ws = { state, kill() { state.live = false; }, revive() { state.live = true; } };
  class FakeWS {
    constructor(url) {
      if (!/alpaca\\.markets|finnhub\\.io/.test(url)) return new Real(url);
      this.url = url; this.readyState = 0; state.opened.push(url);
      this.alpaca = /alpaca/.test(url);
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); if (this.alpaca) this.emit([{ T: 'success', msg: 'connected' }]); }, 30);
    }
    emit(o) { if (this.readyState === 1) this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
    send(s) {
      const m = JSON.parse(s); state.sent.push(m);
      if (m.action === 'auth') this.emit([{ T: 'success', msg: 'authenticated' }]);
      if (m.action === 'subscribe' && !this.timer) this.timer = setInterval(() => {
        if (!state.live) return;
        const t = new Date(Date.now()).toISOString();
        this.emit([{ T: 't', S: 'SPY', p: 600 + Math.random(), s: 3, t }, { T: 't', S: 'QQQ', p: 520 + Math.random(), s: 2, t }]);
      }, 1000);
    }
    close() { clearInterval(this.timer); this.readyState = 3; setTimeout(() => this.onclose && this.onclose({}), 0); }
  }
  window.WebSocket = FakeWS;
})();`;

(async () => {
  const c = await connect({ mock: firebaseMock(worker) });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 200; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(200); } return false; };
  const size = (w, h) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  const boot = async ({ lsKey, shrutiKey }) => {
    await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
    // Since Phase 3 the status card shows only while TradeHub Quant is switched on.
    await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10)); localStorage.setItem('tradehub_quant', '1');
      ${lsKey ? `localStorage.setItem('tradehub.orcaKey', ${JSON.stringify(lsKey)});` : ''}
      sessionStorage.setItem('__fakefs_docs', JSON.stringify(${shrutiKey ? `{ 'dashboards/shruti': { orcaKey: ${JSON.stringify(shrutiKey)}, units: {} } }` : '{}'})); 1`);
    await c.send('Page.navigate', { url: URL });
    if (!(await until("document.querySelector('.tb-navtab')", 15000))) throw new Error('TradeHub did not render');
    await sleep(1200);
    await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="prompt"]')].find(b=>b.offsetParent); if(t) t.click(); 1`);
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };

  console.log('\nThe key comes from Shruti\'s doc');
  await size(1280, 900);
  await boot({ shrutiKey: KEY });
  ok('the status card appears in Control', await until(`document.querySelector('#tradeboard-root .ctl-status [data-qs]')`, 15000));
  ok('...with every provider listed', await until(`document.querySelectorAll('[data-qs-providers] [data-provider]').length === 6`, 15000),
    await js(`var e=document.querySelector('.ctl-status'); return e ? e.innerText.slice(0,300) : 'none';`));
  ok('the key was read from dashboards/shruti and kept on this device', await js(`return localStorage.getItem('tradehub.orcaKey') === ${JSON.stringify(KEY)};`));
  ok('...and nothing was written to Shruti\'s doc', await js(`return !window.__fakeFs.log.some(function(w){ return /shruti/.test(w.path); });`));
  ok('every quant-api request carried the key', asked.length > 0 && asked.every((a) => a.auth === 'Bearer ' + KEY));

  console.log('\nWhat the card says');
  const st = await js(`var o={}; document.querySelectorAll('[data-qs-providers] [data-provider]').forEach(function(r){ o[r.dataset.provider]=r.dataset.state; }); return JSON.stringify(o);`);
  const s = JSON.parse(st);
  ok('each provider\'s chip: Working, Down, At its cap, Slow, No key', s.alpaca === 'Working' && s.finnhub === 'Down' && s.yahoo === 'At its cap' && s.groq === 'Slow' && s.public === 'No key' && s.tiingo === 'No key', st);
  ok('today\'s calls against the cap, with a thin bar', await js(`var r=document.querySelector('[data-provider="alpaca"]'); return /120 \\/ 30,000 today/.test(r.innerText) && !!r.querySelector('.qs-bar i');`));
  ok('median answer time shown', await js(`return /median 180 ms/.test(document.querySelector('[data-provider="alpaca"]').innerText);`));
  ok('the corrections log', await js(`return /NVDA price: 190 → 168.9 \\(finnhub, outlier\\)/.test(document.querySelector('.ctl-status').innerText);`));
  ok('the Alpaca stream authenticated and subscribed SPY and QQQ first', await until(`window.__ws.state.sent.some(function(m){ return m.action==='subscribe' && m.trades[0]==='SPY' && m.trades[1]==='QQQ'; })`, 8000));
  ok('SPY shows a price from the stream, labelled LIVE', await until(`(document.querySelector('[data-qs-prices] [data-sym="SPY"]')||{}).dataset && document.querySelector('[data-qs-prices] [data-sym="SPY"]').dataset.label === 'LIVE'`, 8000));
  const spyText = await js(`return document.querySelector('[data-qs-prices] [data-sym="SPY"]').innerText;`);
  ok('...with its provider and time', /alpaca/.test(spyText) && /\d{1,2}:\d{2}:\d{2}/.test(spyText) && /600\.\d\d/.test(spyText), spyText);
  ok('the stream row says Live', await until(`(document.querySelector('[data-stream="alpaca"]')||{}).dataset && document.querySelector('[data-stream="alpaca"]').dataset.state === 'live'`, 5000));

  console.log('\nLayouts');
  for (const [w, h] of [[1280, 900], [820, 1180], [390, 844]]) {
    await size(w, h); await sleep(700);
    const fit = await js(`var c=document.querySelector('.ctl-status'), r=c.getBoundingClientRect();
      var over=[...c.querySelectorAll('*')].filter(function(e){ var b=e.getBoundingClientRect(); return b.width>0 && (b.right>r.right+1 || b.left<r.left-1); }).length;
      return JSON.stringify({ sw: document.documentElement.scrollWidth, iw: innerWidth, w: Math.round(r.width), over: over });`);
    const f = JSON.parse(fit);
    ok(`${w} px: no sideways scroll, nothing spills out of the card`, f.sw <= f.iw && f.over === 0, fit);
    await js(`document.querySelector('.ctl-status').scrollIntoView({block:'start'}); 1`); await sleep(300);
    await shot('quant-status-' + w);
  }
  await size(1280, 900);

  console.log('\nThe stream goes silent');
  await js(`window.__ws.kill(); 1`);
  const t0 = Date.now();
  ok('not LIVE once the feed has been silent past 20 s', await until(`document.querySelector('[data-sym="SPY"]').dataset.label === 'DELAYED'`, 30000));
  const tDelayed = Date.now() - t0;
  ok('...STALE once silent past 90 s', await until(`document.querySelector('[data-sym="SPY"]').dataset.label === 'STALE'`, 100000));
  const tStale = Date.now() - t0;
  ok(`timings: DELAYED after ${Math.round(tDelayed / 1000)} s, STALE after ${Math.round(tStale / 1000)} s (rule: 20 s / 90 s)`, tDelayed >= 19000 && tDelayed <= 24000 && tStale >= 89000 && tStale <= 94000);
  await js(`window.__ws.revive(); 1`);
  ok('the feed speaks again: LIVE again', await until(`document.querySelector('[data-sym="SPY"]').dataset.label === 'LIVE'`, 5000));

  console.log('\nNo key anywhere');
  asked.length = 0;
  await boot({});
  ok('a field to paste the key, and no request sent without it', await until(`document.querySelector('[data-qs-keyform] input')`, 15000) && asked.length === 0);
  await js(`var i=document.querySelector('[data-qs-keyform] input'); i.value='not-a-key'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); 1`);
  ok('a wrong key is refused with a reason', await until(`/orca_sk_/.test(document.querySelector('[data-qs-keyform] .qs-err').textContent)`, 3000));
  await js(`var i=document.querySelector('[data-qs-keyform] input'); i.value=${JSON.stringify(KEY)}; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); 1`);
  ok('pasting the key brings the card up and keeps the key on this device', await until(`document.querySelectorAll('[data-qs-providers] [data-provider]').length === 6`, 10000)
    && await js(`return localStorage.getItem('tradehub.orcaKey') === ${JSON.stringify(KEY)};`));

  console.log('\nSide effects');
  const used = asked.reduce((m, a) => { m[a.p] = (m[a.p] || 0) + 1; return m; }, {});
  ok('a minute on the card costs a handful of quant-api requests', asked.length <= 6, JSON.stringify(used));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
