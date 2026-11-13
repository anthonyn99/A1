// Shared by the TradeHub Quant live tests (tradehub-quant-market, -a1rules,
// tradehub-perf): quant-api played here, the page's clock moved to a market
// hour, the two providers' WebSockets faked, and a boot that opens TradeHub
// with the switch on or off.
//
// The snapshot served is A1-Priv tests/fixtures/quant/snapshot.json (a real
// one, recorded by tools/quant-runner.mjs --dry --out=). The page's clock is
// set 20 minutes after that snapshot's slot came due, so it is "current".
'use strict';
const fs = require('fs');
const path = require('path');
const { evalJs, sleep } = require('./cdp.js');
const { firebaseMock } = require('./fake-firebase.js');

const ORIGIN = 'https://anthonyn99.github.io';
const URL = ORIGIN + '/A1/tradehub.html';
const KEY = 'orca_sk_livetest_0123456789abcdef';
const PRIV = process.env.A1_PRIV ? path.resolve(process.env.A1_PRIV) : path.join(__dirname, '..', '..', '..', 'A1-Priv');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(PRIV, 'tests', 'fixtures', 'quant', 'snapshot.json'), 'utf8'));
const CLOCK = FIXTURE.due + 20 * 60_000;
const WATCHLIST = FIXTURE.watchlist.filter((s) => FIXTURE.rows[s]);

/** Daily bars for `sym` between two times: a seeded walk, weekdays only, stamped 05:00 UTC. */
function fakeBars(sym, from, to) {
  let x = [...sym].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) % 233280, c = 40 + (x % 300);
  const rnd = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  const out = [], DAY = 86_400_000, start = Date.UTC(2023, 0, 2, 5);
  for (let t = start; t <= to; t += DAY) {
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const o = c; c = Math.max(2, c * (1 + 0.0004 + (rnd() - 0.5) * 0.03));
    const v = Math.round(1e6 * (0.5 + rnd()));
    if (t >= from) out.push({ t, o: +o.toFixed(4), h: +(Math.max(o, c) * 1.004).toFixed(4), l: +(Math.min(o, c) * 0.996).toFixed(4), c: +c.toFixed(4), v });
  }
  return out;
}

/**
 * quant-api for a test → { mock, asked, posted, state }.
 *   state.snapshot   what GET /snapshot answers (null = none stored yet)
 *   state.watchlist  what it says the stored watchlist is
 * `asked` lists every request's path; `posted` the snapshots and watchlists sent.
 */
function quantApi() {
  const asked = [], posted = { snapshots: [], watchlists: [] };
  const state = { snapshot: FIXTURE, watchlist: WATCHLIST, quotes: true };
  const worker = {
    patterns: ['https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*', 'https://quant-api.av1-2.workers.dev/*'],
    handle(req) {
      if (req.method === 'OPTIONS') return { status: 204, text: '' };
      if (!req.url.includes('quant-api')) return { json: { ok: true } };
      const u = new global.URL(req.url), p = u.pathname, auth = req.headers.Authorization || req.headers.authorization || '';
      asked.push({ p, method: req.method, auth, q: u.search });
      if (auth !== 'Bearer ' + KEY) return { status: 401, json: { ok: false, error: 'an Orca key is needed' } };
      if (p === '/snapshot' && req.method === 'GET') return { json: { ok: true, snapshot: state.snapshot, watchlist: state.watchlist } };
      if (p === '/snapshot' && req.method === 'POST') { const s = JSON.parse(req.postData).snapshot; posted.snapshots.push(s); state.snapshot = s; return { json: { ok: true } }; }
      if (p === '/snapshot/claim') { posted.claims = (posted.claims || 0) + 1; return { json: { ok: true, granted: state.claim !== false } }; }
      if (p === '/watchlist') { const l = JSON.parse(req.postData).symbols; posted.watchlists.push(l); state.watchlist = l; return { json: { ok: true, symbols: l } }; }
      if (p === '/bars') {
        const sym = u.searchParams.get('symbol');
        return { json: { ok: true, symbol: sym, tf: '1d', bars: fakeBars(sym, Number(u.searchParams.get('from')), Number(u.searchParams.get('to'))), provider: 'alpaca', complete: true, known: null } };
      }
      if (p === '/quotes') {
        if (!state.quotes) return { status: 503, json: { ok: false, error: 'no provider answered', missing: {} } };
        const quotes = {};
        for (const s of u.searchParams.get('symbols').split(',')) {
          const row = FIXTURE.rows[s];
          if (row) quotes[s] = { symbol: s, price: +(row.c * 1.001).toFixed(2), t: CLOCK - 3000, heard: CLOCK - 1000, provider: 'alpaca', realtime: true, delayMs: 0 };
        }
        return { json: { ok: true, quotes, asOf: CLOCK, missing: {} } };
      }
      if (p === '/stream-keys') return { json: { ok: true, alpaca: { key: 'AK', secret: 'AS' }, finnhub: { key: 'FK' } } };
      if (p === '/usage') return { json: { ok: true, day: FIXTURE.day, usage: [], caps: {}, keys: { alpaca: true, yahoo: true }, health: [] } };
      if (p === '/corrections') return { json: { ok: true, corrections: [] } };
      return { status: 404, json: { ok: false } };
    },
  };
  return { mock: firebaseMock(worker), asked, posted, state };
}

// Runs in the page before anything else: the clock, and the providers'
// WebSockets. window.__ws.tick(sym, price) sends a trade; .auto(ms) sends SPY
// and every subscribed symbol a trade every `ms` (the perf test's fake ticks).
const PAGE_SETUP = `(() => {
  const real = Date.now.bind(Date), shift = ${CLOCK} - real();
  Date.now = () => real() + shift;
  const Real = window.WebSocket;
  const state = { sent: [], sockets: [], subs: new Set(), timer: null };
  const emit = (o) => { for (const w of state.sockets) if (w.alpaca && w.readyState === 1 && w.onmessage) w.onmessage({ data: JSON.stringify(o) }); };
  window.__ws = { state,
    tick(sym, price) { emit([{ T: 't', S: sym, p: price, s: 1, t: new Date(Date.now()).toISOString() }]); },
    auto(ms) { clearInterval(state.timer); if (!ms) return; let n = 0; state.timer = setInterval(() => { n++; emit([...state.subs].map((S, i) => ({ T: 't', S, p: 100 + i + (n % 7) * 0.05, s: 1, t: new Date(Date.now()).toISOString() }))); }, ms); },
  };
  class FakeWS {
    constructor(url) {
      if (!/alpaca\\.markets|finnhub\\.io/.test(url)) return new Real(url);
      this.url = url; this.readyState = 0; this.alpaca = /alpaca/.test(url); state.sockets.push(this);
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); if (this.alpaca) this.onmessage && this.onmessage({ data: JSON.stringify([{ T: 'success', msg: 'connected' }]) }); }, 30);
    }
    send(s) {
      const m = JSON.parse(s); state.sent.push(m);
      if (m.action === 'auth') this.onmessage && this.onmessage({ data: JSON.stringify([{ T: 'success', msg: 'authenticated' }]) });
      if (m.action === 'subscribe') for (const x of m.trades || []) state.subs.add(x);
    }
    close() { this.readyState = 3; setTimeout(() => this.onclose && this.onclose({}), 0); }
  }
  window.WebSocket = FakeWS;
})();`;

/** A Journal document with `n` closed two-leg trades, one a day going back
 *  (for speed tests: Tony's real Journal has hundreds). */
function bigJournal(n = 800, now = CLOCK) {
  const doc = { savedAt: now - 3600000 }, syms = ['NVDA', 'AMD', 'TSLA', 'PLTR', 'MU', 'AAPL', 'META', 'AMZN', 'SOFI', 'COIN'];
  for (let i = 0; i < n; i++) {
    const t0 = now - (i * 0.9 + 1) * 86400000, px = 50 + (i * 7) % 300, q = 1 + (i % 9), long = i % 7 !== 0;
    doc['t_' + i] = { id: String(i), source: i % 5 ? 'webull' : 'manual', ticker: syms[i % syms.length], createdAt: t0, status: 'CLOSED', notes: 'note ' + i,
      legs: [{ id: 'a' + i, action: long ? 'BUY' : 'SELL', datetime: new Date(t0).toISOString(), qty: q, price: px, fee: 0.12 },
        { id: 'b' + i, action: long ? 'SELL' : 'BUY', datetime: new Date(t0 + 3600000).toISOString(), qty: q, price: +(px * (1 + ((i % 11) - 5) / 100)).toFixed(2), fee: 0.12 }] };
  }
  return doc;
}

/** Helpers bound to a connected page `c`. */
function driver(c) {
  const js = (e) => evalJs(c, e);
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 10000) / 100; i++) { if (await js(`return !!(${expr});`)) return true; await sleep(100); } return false; };
  const size = (w, h) => c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  /** Open TradeHub fresh. quant: the switch; docs: Firestore docs to seed; ls: extra localStorage. */
  const boot = async ({ quant = true, key = KEY, watchlist = WATCHLIST, docs = {}, ls = {}, keep = false } = {}) => {
    if (!keep) {
      await c.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
      await c.send('Page.navigate', { url: ORIGIN + '/A1/Shared/tni.js' }); await sleep(400);
      const seed = Object.assign({ 'dashboards/tradeboard_watchlist': { tickers: watchlist, trash: [] } }, docs);
      await js(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('a1_sweep_day:tradehub', new Date().toISOString().slice(0,10));
        ${key ? `localStorage.setItem('tradehub.orcaKey', ${JSON.stringify(key)});` : ''}
        ${quant ? `localStorage.setItem('tradehub_quant', '1');` : ''}
        localStorage.setItem('td6_watchlist', ${JSON.stringify(JSON.stringify(watchlist))});
        var extra = ${JSON.stringify(ls)}; Object.keys(extra).forEach(function(k){ localStorage.setItem(k, extra[k]); });
        sessionStorage.setItem('__fakefs_docs', ${JSON.stringify(JSON.stringify(seed))}); 1`);
    }
    await c.send('Page.navigate', { url: URL });
    if (!(await until("document.querySelector('.tb-navtab')", 20000))) throw new Error('TradeHub did not render');
    await sleep(800);
  };
  const tab = async (id) => { await js(`var t=[...document.querySelectorAll('.tb-navtab[data-navid="${id}"]')].find(function(b){return b.offsetParent;}); if(t) t.click(); return !!t;`); await sleep(350); };
  const shot = async (name) => {
    const dir = process.env.SHOTS_DIR;
    if (!dir) return;
    const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  return { js, until, size, boot, tab, shot };
}

module.exports = { quantApi, driver, bigJournal, PAGE_SETUP, FIXTURE, CLOCK, WATCHLIST, KEY, ORIGIN, URL };
