// Shared by the TradeHub Quant live tests (tradehub-quant-market, -a1rules,
// tradehub-perf): quant-api played here, the page's clock moved to a market
// hour, the two providers' WebSockets faked, and a boot that opens TradeHub
// with the switch on or off.
//
// Phase 6 adds /calibration, /paper and /backtests kept here.
//
// Phase 4 adds intraday bars (sessions 04:00 to 20:00 New York), /drawings
// and /alerts kept here, and the chart library (lightweight-charts) served
// from a copy kept in the OS temp folder, fetched once from jsdelivr.
//
// The snapshot served is A1-Priv tests/fixtures/quant/snapshot.json (a real
// one, recorded by tools/quant-runner.mjs --dry --out=). The page's clock is
// set 20 minutes after that snapshot's slot came due, so it is "current".
'use strict';
const fs = require('fs');
const path = require('path');
const { evalJs, sleep } = require('./cdp.js');
const os = require('os');
const https = require('https');
const { firebaseMock } = require('./fake-firebase.js');

const LWC = 'https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.mjs';
const LWC_FILE = path.join(os.tmpdir(), 'a1-lwc-5.2.1.mjs');
let lwcText = null;
/** The chart library's text: the temp copy, or jsdelivr once. */
function lwc() {
  if (lwcText) return Promise.resolve(lwcText);
  if (fs.existsSync(LWC_FILE) && fs.statSync(LWC_FILE).size > 100000) return Promise.resolve(lwcText = fs.readFileSync(LWC_FILE, 'utf8'));
  return new Promise((ok, no) => https.get(LWC, (r) => {
    if (r.statusCode !== 200) { no(new Error('jsdelivr ' + r.statusCode)); return; }
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => (b += c)); r.on('end', () => { fs.writeFileSync(LWC_FILE, b); ok(lwcText = b); });
  }).on('error', no));
}
const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3 };
/** Intraday bars between two times: weekdays, 04:00 to 20:00 New York (UTC-5 here), a seeded walk. */
function walkIntraday(sym, tf, from, to) {
  const step = TF_MS[tf], out = [];
  let x = [...sym].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 11) % 233280, c = 40 + (x % 300);
  const rnd = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  const start = Math.floor((CLOCK - 70 * 86_400_000) / step) * step;   // one walk for the symbol, whatever the window
  for (let t = start; t <= to; t += step) {
    const d = new Date(t - 5 * 3600e3), dow = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (dow === 0 || dow === 6 || m < 240 || m >= 1200) continue;
    const o = c; c = Math.max(2, c * (1 + (rnd() - 0.5) * 0.004));
    const v = Math.round(1e4 * (0.5 + rnd()) * (m >= 570 && m < 960 ? 5 : 1));   // drawn every bar, so the walk is the same whatever the window
    if (t >= from) out.push({ t, o: +o.toFixed(4), h: +(Math.max(o, c) * 1.001).toFixed(4), l: +(Math.min(o, c) * 0.999).toFixed(4), c: +c.toFixed(4), v });
  }
  return out;
}

const ORIGIN = 'https://anthonyn99.github.io';
const URL = ORIGIN + '/A1/tradehub.html';
const KEY = 'orca_sk_livetest_0123456789abcdef';
const PRIV = process.env.A1_PRIV ? path.resolve(process.env.A1_PRIV) : path.join(__dirname, '..', '..', '..', 'A1-Priv');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(PRIV, 'tests', 'fixtures', 'quant', 'snapshot.json'), 'utf8'));
const CLOCK = FIXTURE.due + 20 * 60_000;
const WATCHLIST = FIXTURE.watchlist.filter((s) => FIXTURE.rows[s]);

// Every series of a symbol is scaled so it ends near the snapshot's close (the
// price the quotes report), so bars, levels and the live price agree.
const scales = new Map();
function scaled(key, sym, gen, from, to) {
  if (!scales.has(key)) { const all = gen(sym, 0, CLOCK), last = all.length ? all[all.length - 1].c : 1, row = FIXTURE.rows[sym]; scales.set(key, row && row.c ? row.c / last : 1); }
  const k = scales.get(key), r = (x) => +(x * k).toFixed(4);
  return gen(sym, from, to).map((b) => ({ ...b, o: r(b.o), h: r(b.h), l: r(b.l), c: r(b.c) }));
}
/** Daily bars for `sym` between two times: a seeded walk, weekdays only, stamped 05:00 UTC. */
const fakeBars = (sym, from, to) => scaled('1d|' + sym, sym, walkDaily, from, to);
const fakeIntraday = (sym, tf, from, to) => scaled(tf + '|' + sym, sym, (s, a, b) => walkIntraday(s, tf, a, b), from, to);
function walkDaily(sym, from, to) {
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

/** Phase 8's routes over `state` (memory cards, conversations, Drive), or null for another path. */
function memoryRoutes(state, posted, req, u, p) {
  const body = () => { try { return JSON.parse(req.postData || 'null'); } catch (e) { return null; } };
  const conv = (c) => ({ id: c.id, title: c.title, created: c.created, pinned: !!c.pinned, updated: Math.max(c.created, ...c.turns.map((t) => t.at)), turns: c.turns.length,
    tickers: [...new Set(c.turns.flatMap((t) => t.tickers || []))], verdicts: [...new Set(c.turns.map((t) => t.verdict).filter(Boolean))] });
  if (p === '/memory' && req.method === 'GET') return { json: { ok: true, cards: state.cards } };
  if (p === '/memory' && req.method === 'POST') { const c = body().card, id = 'm' + Date.now().toString(36) + state.cards.length; (posted.cards = posted.cards || []).push(c); state.cards.push({ id, kind: c.kind, text: c.text, source: c.source || 'tony', created: CLOCK, lastUsed: null, pinned: false, state: c.source === 'neo' ? 'proposed' : 'active' }); return { json: { ok: true, id } }; }
  const mc = /^\/memory\/([\w-]+)$/.exec(p);
  if (mc && req.method === 'PATCH') { const b = body(), c = state.cards.find((x) => x.id === mc[1]); if (b.state === 'active' && b.by !== 'tony') return { status: 403, json: { ok: false, error: 'only Tony can make a card active' } }; if (b.text != null) c.text = b.text; if (b.pinned != null) c.pinned = !!b.pinned; if (b.state) c.state = b.state; (posted.patches = posted.patches || []).push(b); return { json: { ok: true } }; }
  if (mc && req.method === 'DELETE') { state.cards = state.cards.filter((x) => x.id !== mc[1]); return { json: { ok: true } }; }
  if (p === '/history' && req.method === 'GET') return { json: { ok: true, conversations: state.convs.map(conv).sort((a, b) => b.updated - a.updated) } };
  if (p === '/history' && req.method === 'DELETE') { state.convs = []; return { json: { ok: true } }; }
  if (p === '/history/turns') {
    const after = Number(u.searchParams.get('after')) || 0;
    const all = state.convs.flatMap((c) => c.turns.map((t) => ({ ...t, conv: c.id, title: c.title, pinned: !!c.pinned }))).sort((a, b) => a.at - b.at).map((t, i) => ({ ...t, seq: i + 1 }));
    return { json: { ok: true, turns: all.filter((t) => t.seq > after), more: false } };
  }
  const hc = /^\/history\/([\w-]+)$/.exec(p);
  if (hc && req.method === 'PATCH') { const b = body(), c = state.convs.find((x) => x.id === hc[1]); if (b.pinned != null) c.pinned = !!b.pinned; return { json: { ok: true } }; }
  if (hc && req.method === 'DELETE') { state.convs = state.convs.filter((x) => x.id !== hc[1]); return { json: { ok: true } }; }
  if (p === '/drive/health') return { json: { ok: true, ...state.drive, files: state.drive.files.length } };
  if (p === '/drive/connect') { posted.connect = (posted.connect || 0) + 1; return { json: { ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' } }; }
  if (p === '/drive/disconnect') { state.drive.connected = false; state.drive.email = null; return { json: { ok: true } }; }
  if (p === '/drive/list') { const pre = 'TradeHub/' + (u.searchParams.get('prefix') || ''); return { json: { ok: true, files: state.drive.files.filter((f) => f.path.startsWith(pre)) } }; }
  if (p === '/drive/f' && req.method === 'PUT') { const path = 'TradeHub/' + u.searchParams.get('path'); (posted.drive = posted.drive || []).push({ path, body: req.postData }); state.drive.files.push({ path, id: 'f' + state.drive.files.length + 'xxxxxxxxxx', size: (req.postData || '').length, at: CLOCK }); return { json: { ok: true, path, skipped: false } }; }
  return null;
}

/**
 * quant-api for a test → { mock, asked, posted, state }.
 *   state.snapshot   what GET /snapshot answers (null = none stored yet)
 *   state.watchlist  what it says the stored watchlist is
 *   state.ideas      what GET /ideas answers (Phase 7); state.dossier: symbol → GET /dossier's answer
 * `asked` lists every request's path; `posted` the snapshots and watchlists sent.
 */
function quantApi() {
  const asked = [], posted = { snapshots: [], watchlists: [] };
  const state = { snapshot: FIXTURE, watchlist: WATCHLIST, quotes: true, drawings: {}, alerts: [], signals: [], calibration: null, paper: [], backtests: [], ideas: null, dossier: {},
    // Phase 8: memory cards, conversations ({ id, title, created, pinned, turns: [] }), Drive.
    cards: [], convs: [], drive: { configured: true, connected: false, email: null, files: [] } };
  const worker = {
    patterns: [LWC, 'https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*', 'https://quant-api.av1-2.workers.dev/*'],
    handle(req) {
      if (req.method === 'OPTIONS') return { status: 204, text: '' };
      if (req.url === LWC) return lwc().then((text) => ({ text, type: 'text/javascript' }), () => ({ status: 503, text: '' }));
      if (!req.url.includes('quant-api')) return { json: { ok: true } };
      const u = new global.URL(req.url), p = u.pathname, auth = req.headers.Authorization || req.headers.authorization || '';
      asked.push({ p, method: req.method, auth, q: u.search });
      if (auth !== 'Bearer ' + KEY) return { status: 401, json: { ok: false, error: 'an Orca key is needed' } };
      if (p === '/snapshot' && req.method === 'GET') return { json: { ok: true, snapshot: state.snapshot, watchlist: state.watchlist } };
      if (p === '/snapshot' && req.method === 'POST') { const s = JSON.parse(req.postData).snapshot; posted.snapshots.push(s); state.snapshot = s; return { json: { ok: true } }; }
      if (p === '/snapshot/claim') { posted.claims = (posted.claims || 0) + 1; return { json: { ok: true, granted: state.claim !== false } }; }
      if (p === '/watchlist') { const l = JSON.parse(req.postData).symbols; posted.watchlists.push(l); state.watchlist = l; return { json: { ok: true, symbols: l } }; }
      if (p === '/bars') {
        const sym = u.searchParams.get('symbol'), tf = u.searchParams.get('tf') || '1d', from = Number(u.searchParams.get('from')), to = Number(u.searchParams.get('to'));
        const bars = TF_MS[tf] ? fakeIntraday(sym, tf, from, to) : fakeBars(sym, from, to);
        return { json: { ok: true, symbol: sym, tf, bars, provider: 'alpaca', complete: true, known: null } };
      }
      if (p === '/drawings' && req.method === 'GET') { const sym = u.searchParams.get('symbol'); return { json: { ok: true, symbol: sym, drawings: state.drawings[sym] || [], at: state.drawings[sym] ? 1 : null } }; }
      if (p === '/drawings' && req.method === 'PUT') { const b = JSON.parse(req.postData); state.drawings[b.symbol] = b.drawings; (posted.drawings = posted.drawings || []).push(b); return { json: { ok: true, n: b.drawings.length, at: CLOCK } }; }
      if (p === '/alerts' && req.method === 'GET') { const sym = u.searchParams.get('symbol'); return { json: { ok: true, alerts: state.alerts.filter((a) => !sym || a.symbol === sym) } }; }
      if (p === '/alerts' && req.method === 'POST') { const a = JSON.parse(req.postData).alert, id = a.id || 'a' + (state.alerts.length + 1) + '_' + Math.round(Math.random() * 1e6); state.alerts = state.alerts.filter((x) => x.id !== id).concat([{ ...a, id, active: 1 }]); (posted.alerts = posted.alerts || []).push({ ...a, id }); return { json: { ok: true, id } }; }
      if (p === '/alerts' && req.method === 'DELETE') { const id = u.searchParams.get('id'); state.alerts = state.alerts.filter((x) => x.id !== id); return { json: { ok: true, id } }; }
      if (p === '/signals' && req.method === 'GET') return { json: { ok: true, signals: state.signals } };
      if (p === '/signals' && req.method === 'POST') { const b = JSON.parse(req.postData); (posted.signals = posted.signals || []).push(b); for (const x of b.signals) if (!state.signals.some((y) => y.id === x.id)) state.signals.push({ ...x, done: false }); return { json: { ok: true, sent: b.signals.length } }; }
      // Phase 6: calibration, paper trades, saved backtests.
      if (p === '/calibration' && req.method === 'GET') return { json: { ok: true, calibration: state.calibration } };
      if (p === '/paper' && req.method === 'GET') return { json: { ok: true, paper: state.paper } };
      if (p === '/paper' && req.method === 'POST') { const s = JSON.parse(req.postData).signal; (posted.paper = posted.paper || []).push(s); if (!state.paper.some((x) => x.id === s.id)) state.paper.unshift({ ...s, followed: CLOCK, paper: true }); return { json: { ok: true, id: s.id } }; }
      if (p === '/paper' && req.method === 'DELETE') { const id = u.searchParams.get('id'); state.paper = state.paper.filter((x) => x.id !== id); return { json: { ok: true } }; }
      if (p === '/backtests' && req.method === 'GET') return { json: { ok: true, backtests: state.backtests.map(({ curve, ...x }) => x) } };
      if (p === '/backtests' && req.method === 'POST') { const b = JSON.parse(req.postData), id = 'b' + (1000 + state.backtests.length) + 'live'; (posted.backtests = posted.backtests || []).push(b); state.backtests.unshift({ id, name: b.name, created: CLOCK, spec: b.spec, summary: b.summary, curve: { equity: b.curve, bench: b.bench } }); return { json: { ok: true, id, created: CLOCK } }; }
      const bt = /^\/backtests\/(\w+)$/.exec(p);
      if (bt && req.method === 'GET') { const x = state.backtests.find((y) => y.id === bt[1]); return x ? { json: { ok: true, backtest: x } } : { status: 404, json: { ok: false } }; }
      if (bt && req.method === 'DELETE') { state.backtests = state.backtests.filter((y) => y.id !== bt[1]); return { json: { ok: true } }; }
      if (p === '/grades' && req.method === 'POST') { (posted.grades = posted.grades || []).push(JSON.parse(req.postData)); return { json: { ok: true } }; }
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
      if (p === '/corrections' && req.method === 'POST') { (posted.corrections = posted.corrections || []).push(JSON.parse(req.postData)); return { json: { ok: true } }; }
      if (p === '/corrections') return { json: { ok: true, corrections: [] } };
      if (p === '/ideas') return { json: { ok: true, ideas: state.ideas, at: state.ideas ? state.ideas.at : null } };
      const phase8 = memoryRoutes(state, posted, req, u, p);
      if (phase8) return phase8;
      if (p === '/dossier') { const sym = u.searchParams.get('symbol'), d = state.dossier[sym]; return d ? { json: { ok: true, ...d } } : { json: { ok: true, symbol: sym, asOf: null, parts: {}, failed: { metric: 'finnhub: HTTP 500' }, pending: [], calls: 1 } }; }
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

module.exports = { quantApi, driver, bigJournal, PAGE_SETUP, FIXTURE, CLOCK, WATCHLIST, KEY, ORIGIN, URL, fakeBars, fakeIntraday, lwc };
