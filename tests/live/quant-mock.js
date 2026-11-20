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

/* ── Phase 9: Neo Quant's AI routes ───────────────────────────────────────
   state.ai.plan: a queue of answers for /ai/chat and /ai/gemini, used in order:
     { text }                     streamed as two chunks, then done
     { fail: [{provider, why}] }  a fail event (nobody answered)
   With the queue empty, the answer is built from the request's own facts (so
   every number in it is on the sheet): the first fact naming a number. */
const sseChunk = (t) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n';
const sseEv = (name, data) => '\n\nevent: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n';
function autoReply(body) {
  const facts = (body && body.facts) || [];
  const f = facts.find((x) => /ticker/.test(x.pack || '') && /\d/.test(x.text)) || facts.find((x) => x.pack !== 'now' && /\d/.test(x.text)) || facts[0];
  const g = facts.find((x) => x.pack === 'market' && x !== f);
  return `VERDICT: WATCH. The engine has no GO here yet [${f ? f.id : 'F1'}].\nWHY: ${f ? f.text + ' [' + f.id + ']' : 'No facts.'}${g ? '\n' + g.text + ' [' + g.id + ']' : ''}\nRISK: The setup can fail at the open.\nWATCH: A close back above the first resistance.`;
}
/* ── Phase 9C: quant-api's paper routes (lib/paper.js), Alpaca paper played here ── */
function paperRoutes(pp, posted, req, u, p) {
  const m = req.method, body = () => { try { return JSON.parse(req.postData || 'null'); } catch (e) { return null; } };
  (posted.pp = posted.pp || []).push([m, p, m === 'GET' ? null : body()]);
  if (p === '/paper/account' && m === 'GET') return { json: { ok: true, paper: true, kill: pp.kill, account: pp.account, clock: { is_open: true, next_open: '2026-11-16T09:30:00-05:00' } } };
  if (p === '/paper/positions' && m === 'GET') return { json: { ok: true, paper: true, positions: pp.positions } };
  if (p === '/paper/orders' && m === 'GET') return { json: { ok: true, paper: true, orders: u.searchParams.get('status') === 'closed' ? pp.closed : pp.orders } };
  if (p === '/paper/activities' && m === 'GET') return { json: { ok: true, fills: pp.fills } };
  if (p === '/paper/log' && m === 'GET') return { json: { ok: true, orders: pp.log } };
  if (p === '/paper/runs' && m === 'GET') return { json: { ok: true, runs: pp.runs } };
  if (p === '/paper/orders' && m === 'POST') {
    const b = body();
    if (pp.kill && !b.closing) return { status: 422, json: { ok: false, error: 'the kill switch is on: only closing orders and cancels go out' } };
    const id = 'ord' + (pp.next++), o = { id, status: 'accepted', submitted_at: new Date(CLOCK).toISOString(), ...b.order };
    pp.orders.unshift(o);
    pp.log.unshift({ id: 'c' + id, at: CLOCK, who: b.who, reason: b.reason || null, symbol: o.symbol, side: o.side, type: o.type, qty: o.qty, body: b.order, status: 'accepted', alpaca_id: id, run: b.run || null });
    return { json: { ok: true, paper: true, order: o } };
  }
  const o = /^\/paper\/orders\/([\w-]+)$/.exec(p);
  if (o && m === 'DELETE') { const x = pp.orders.find((y) => y.id === o[1]); pp.orders = pp.orders.filter((y) => y.id !== o[1]); if (x) pp.closed.unshift({ ...x, status: 'canceled' }); return { json: { ok: true, canceled: o[1] } }; }
  if (o && m === 'PATCH') { const x = pp.orders.find((y) => y.id === o[1]); Object.assign(x, body()); return { json: { ok: true, order: x } }; }
  const ps = /^\/paper\/positions\/([A-Z.]+)$/.exec(p);
  if (ps && m === 'DELETE') { pp.positions = pp.positions.filter((y) => y.symbol !== ps[1]); return { json: { ok: true, order: { symbol: ps[1] } } }; }
  if (p === '/paper/kill' && m === 'POST') { const b = body(); pp.kill = b.on !== false; let n = 0; if (pp.kill) { n = pp.orders.length; pp.closed.unshift(...pp.orders.map((x) => ({ ...x, status: 'canceled' }))); pp.orders = []; pp.runs.forEach((r) => { if (r.state === 'running') r.state = 'paused'; }); } return { json: { ok: true, kill: pp.kill, canceled: n } }; }
  if (p === '/paper/runs' && m === 'POST') { const b = body(), run = { id: 'rlive' + (pp.next++) + 'x', name: b.name, created: CLOCK - 30 * 86400000, spec: b.spec, capital: b.capital, limits: { maxPositions: 5, maxPositionPct: 20, maxOrdersDay: 20, dailyLossPct: 3, maxDrawdownPct: 15, ...(b.limits || {}) }, state: 'running', by: b.who || 'tony', equity: [], stats: null }; pp.runs.unshift(run); return { json: { ok: true, run } }; }
  const rn = /^\/paper\/runs\/([\w]+)$/.exec(p);
  if (rn && m === 'PATCH') { const b = body(), r = pp.runs.find((x) => x.id === rn[1]); if (b.state) r.state = b.state; return { json: { ok: true, run: r } }; }
  return null;
}
/* ── Phase 13: options, macro and earnings context (lib/context.js) ─────── */
// A compact chain around the fixture's price: 2 expiries, 9 strikes, calls heavier above, puts below.
function fakeChain(sym) {
  const row = FIXTURE.rows[sym];
  if (!row) return null;
  const spot = row.c, step = spot > 200 ? 5 : spot > 50 ? 2.5 : 1, mid0 = Math.round(spot / step) * step;
  const day = (n) => new Date(CLOCK + n * 86400000).toISOString().slice(0, 10);
  const exp = (n, iv) => {
    const c = [], p = [];
    for (let i = -4; i <= 4; i++) {
      const k = mid0 + i * step, intr = (x) => Math.max(0, x), tv = spot * iv * Math.sqrt(n / 365) * 0.4 * Math.exp(-(i * i) / 8);
      const cm = intr(spot - k) + tv, pm = intr(k - spot) + tv;
      c.push([k, +(cm - 0.05).toFixed(2), +(cm + 0.05).toFixed(2), iv, i > 0 ? 3000 - i * 200 : 800, 200, +(0.5 - i * 0.1).toFixed(2), 0.02]);
      p.push([k, +(pm - 0.05).toFixed(2), +(pm + 0.05).toFixed(2), iv + 0.02, i < 0 ? 3000 + i * 200 : 700, 150, +(-0.5 - i * 0.1).toFixed(2), 0.02]);
    }
    return { exp: day(n), c, p };
  };
  return { symbol: sym, spot, iv30: 0.34, at: CLOCK - 60000, delayed: true, expiries: [exp(4, 0.33), exp(32, 0.35)] };
}
function contextRoutes(state, u, p) {
  if (p === '/options') { const sym = u.searchParams.get('symbol'); state.optionsAsked = (state.optionsAsked || 0) + 1; return { json: { ok: true, chain: fakeChain(sym), ivLog: [{ day: '2026-11-10', iv: 0.3 }], calls: 1, cached: false, label: '15 min delayed' } }; }
  if (p === '/macro') {
    const ser = (base, slope) => Array.from({ length: 40 }, (_, i) => [new Date(CLOCK - (40 - i) * 86400000).toISOString().slice(0, 10), +(base + slope * i).toFixed(3)]);
    return { json: { ok: true, at: CLOCK - 3600000, names: {}, series: { DGS2: ser(3.6, 0), DGS10: ser(4.1, 0.002), DGS3MO: ser(4.3, 0), DFII10: ser(1.9, 0), BAMLH0A0HYM2: ser(3.1, 0.004), DTWEXBGS: ser(121, 0.05), DCOILWTICO: ser(64, -0.1),
      // The releases' own series (actual vs previous): 24 months of CPI and payrolls, a Fed target change.
      CPIAUCSL: Array.from({ length: 24 }, (_, i) => [`${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`, +(310 * (1 + 0.0025 * i)).toFixed(3)]),
      PAYEMS: Array.from({ length: 24 }, (_, i) => [`${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`, 158000 + 150 * i + (i === 23 ? 50 : 0)]),
      DFEDTARU: [['2026-09-16', 4.5], ['2026-09-17', 4.25], ['2026-11-12', 4.25]] } } };
  }
  // R7: Yahoo's analysts / key stats (state.summaryDown = Yahoo failing) and the heat map's batch quote.
  if (p === '/summary') {
    const sym = u.searchParams.get('symbol');
    state.summaryAsked = (state.summaryAsked || []).concat(sym);
    if (state.summaryDown) return { json: { ok: true, symbol: sym, src: 'yahoo', at: null, facts: null, failed: 'yahoo: HTTP 429' } };
    return { json: { ok: true, symbol: sym, src: 'yahoo', at: CLOCK - 2 * 3600000, facts: {
      analysis: { targetHigh: 3000, targetMean: 2047.375, targetLow: 870, analysts: 24, recKey: 'strong_buy', recMean: 1.48, price: 805, trend: [{ period: '0m', strongBuy: 4, buy: 17, hold: 4, sell: 0, strongSell: 0 }],
        upgrades: [{ day: '2026-11-12', firm: 'Rosenblatt', to: 'Buy', from: 'Buy', action: 'main', target: 2400 }, { day: '2026-11-10', firm: 'Fox Advisors', to: 'Equal-Weight', from: 'Overweight', action: 'down' }] },
      stats: { open: 805.87, prevClose: 797.24, dayHigh: 820, dayLow: 790, volume: 9e6, avgVol3m: 10.56e6, high52: 2354.39, low52: 183, marketCap: 109.8e9, peTtm: 6.17, peFwd: 2.67, pb: 6.13, ps: 3.79, epsTtm: 125.12, bps: 125.93,
        shares: 142.29e6, float: 140.39e6, nextEarnings: '2027-01-28', name: sym + ' Corporation', exchange: 'NasdaqGS' } } } };
  }
  if (p === '/heatmap') {
    const syms = String(u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    state.heatAsked = (state.heatAsked || []).concat([syms.length]);
    if (state.heatDown) return { status: 503, json: { ok: false, error: 'the heat map needs Yahoo, which did not answer (HTTP 429)' } };
    const items = Object.fromEntries(syms.map((s, i) => [s, { cap: (s === 'NVDA' ? 4500 : s === 'AAPL' ? 4000 : 20 + ((i * 37) % 300)) * 1e9, chg: (((i * 13) % 11) - 5) / 100, price: 50 + (i % 200), t: CLOCK - 60000, name: s + ' Inc' }]));
    return { json: { ok: true, items, asOf: CLOCK - 60000, src: 'yahoo', missing: [], cached: false } };
  }
  if (p === '/macro/dates') return { json: { ok: true, dates: { cpi: ['2025-12-10', '2026-01-13', '2026-02-11', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-12', '2026-09-11', '2026-10-15'] }, from: 2025 } };
  if (p === '/earnings') { const syms = String(u.searchParams.get('symbols') || '').split(','); return { json: { ok: true, reports: Object.fromEntries(syms.map((s) => [s, [{ day: '2026-08-26', time: 'amc', eps: 1.0, est: 0.9 }]])), asked: null } }; }
  return null;
}
function aiRoutes(state, posted, req, u, p) {
  const body = () => { try { return JSON.parse(req.postData || 'null'); } catch (e) { return null; } };
  if ((p === '/ai/chat' || p === '/ai/gemini') && req.method === 'POST') {
    const b = body();
    (posted.ai = posted.ai || []).push({ p, body: b });
    const next = state.ai.plan.length ? state.ai.plan.shift() : { text: autoReply(b) };
    const provider = p === '/ai/gemini' ? 'gemini' : (b.provider || 'groq'), model = p === '/ai/gemini' ? 'gemini-test-flash' : 'llama-test';
    if (next.fail) return { text: sseEv('fail', { tried: next.fail, fallback: next.fallback || null }), type: 'text/event-stream' };
    const t = next.text, half = Math.ceil(t.length / 2);
    return { text: sseEv('meta', { provider, model }) + sseChunk(t.slice(0, half)) + sseChunk(t.slice(half)) + 'data: [DONE]\n\n' + sseEv('done', { provider, model, firstMs: 320, ms: 900, tried: [] }), type: 'text/event-stream' };
  }
  if (p === '/brief' && req.method === 'GET') return { json: { ok: true, brief: state.ai.brief } };
  if (p === '/brief' && req.method === 'POST') { const b = body(); (posted.briefs = posted.briefs || []).push(b); if (b.kind === 'daily') state.ai.brief = { day: b.day, kind: b.kind, at: CLOCK, ...b.body }; return { json: { ok: true } }; }
  if (p === '/ai/models') return { json: { ok: true, keys: { groq: true, gemini: true }, models: [], evals: [], bar: { numeric: 0.85, verdict: 0.8 } } };
  // Phase 11: the wanted list (state.wanted rows; posted.wanted the POST bodies).
  if (p === '/wanted') {
    state.wanted = state.wanted || [];
    if (req.method === 'GET') return { json: { ok: true, wanted: state.wanted.slice() } };
    if (req.method === 'POST') { const b = body() || {}; (posted.wanted = posted.wanted || []).push(b); const old = state.wanted.find((x) => x.what === b.what); if (old) { old.count++; old.words = b.words; old.at = CLOCK; } else state.wanted.unshift({ what: b.what, words: b.words, kind: b.kind, at: CLOCK, count: 1 }); return { json: { ok: true, what: b.what } }; }
    if (req.method === 'DELETE') { state.wanted = []; return { json: { ok: true } }; }
  }
  // Phase 10: hearing. state.ai.heard = the transcript (a list: used in order, the last repeats), or { fail: tried }.
  if (p === '/ai/hear' && req.method === 'POST') {
    const b = body() || {};
    (posted.hear = posted.hear || []).push({ mime: b.mime, bytes: Math.floor(String(b.audio || '').length * 3 / 4), watchlist: b.watchlist });
    const list = state.ai.heard || ['Is NVDA a buy here?'];
    const next = list.length > 1 ? list.shift() : list[0];
    if (next && next.fail) return { status: 503, json: { ok: false, error: 'nothing could transcribe that', tried: next.fail } };
    return { json: { ok: true, text: next, provider: 'groq', model: 'whisper-large-v3-turbo', ms: 420, tried: [] } };
  }
  return null;
}
/** A short quiet tone as WAV (what the fake ORCA speaks): `sec` seconds at 16 kHz. */
function toneWav(sec) {
  const n = Math.floor(16000 * sec), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 16000) * 1500), 44 + i * 2);
  return b;
}
const TONE = toneWav(0.45).toString('base64');

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
  if (hc && req.method === 'GET') { const c = state.convs.find((x) => x.id === hc[1]); return c ? { json: { ok: true, conversation: { id: c.id, title: c.title, created: c.created, pinned: !!c.pinned }, turns: c.turns } } : { status: 404, json: { ok: false } }; }
  if (p === '/history/turn' && req.method === 'POST') { const b = body(); (posted.turns = posted.turns || []).push(b); let c = state.convs.find((x) => x.id === b.conv); if (!c) state.convs.push(c = { id: b.conv, title: b.title || b.turn.text.slice(0, 80), created: CLOCK, pinned: false, turns: [] }); c.turns.push({ id: 't' + c.turns.length + b.conv, at: b.turn.at || CLOCK, ...b.turn }); return { json: { ok: true, id: 't1', conv: b.conv } }; }
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
// quant-api's default alert config (workers2/quant-api/lib/alerts.js DEFAULT_CFG).
const ALERT_CFG = () => ({
  kinds: { price: true, signal: true, graded: true, regime: true, catalyst: true, data: true },
  quiet: { on: false, from: '22:00', to: '07:00', tz: 'America/Denver' },
  marketOnly: { price: true, signal: false, graded: false, regime: false, catalyst: false, data: true },
  mute: {}, cards: { price: false, signal: false, graded: true, regime: false, catalyst: true, data: false }, speak: true,
});
function quantApi() {
  const asked = [], posted = { snapshots: [], watchlists: [] };
  const state = { snapshot: FIXTURE, watchlist: WATCHLIST, quotes: true, drawings: {}, alerts: [], signals: [], calibration: null, paper: [], backtests: [], ideas: null, dossier: {},
    // Phase 8: memory cards, conversations ({ id, title, created, pinned, turns: [] }), Drive.
    cards: [], convs: [], drive: { configured: true, connected: false, email: null, files: [] },
    // Phase 9: Neo Quant's planned answers, the stored brief, the snapshot before (What changed?), the browser units.
    ai: { plan: [], brief: null }, prevSnapshot: null,
    // Phase 9C: quant-api's /paper/… over Alpaca paper, played here.
    pp: { kill: false, account: { equity: 100000, last_equity: 99600, cash: 98000, buying_power: 392000, daytrade_count: 0 }, positions: [{ symbol: 'NVDA', qty: 10, side: 'long', avg: 160, price: 164, value: 1640, pnl: 40, pnlPct: 0.025, dayPnl: 12 }],
      orders: [], closed: [], log: [], runs: [], fills: [], next: 1 }, orca: { models: [{ id: 'deepseek/free', routable: true }, { id: 'perplexity/free', routable: true }, { id: 'chatgpt/free', routable: false }] } };
  const worker = {
    patterns: [LWC, 'https://trade-dashboard.av1-2.workers.dev/*', 'https://tradeboard-api.av1.workers.dev/*', 'https://newshub-api.av1.workers.dev/*', 'https://quant-api.av1-2.workers.dev/*', 'https://orca.vedapatel05.workers.dev/*'],
    handle(req) {
      if (req.method === 'OPTIONS') return { status: 204, text: '' };
      if (req.url === LWC) return lwc().then((text) => ({ text, type: 'text/javascript' }), () => ({ status: 503, text: '' }));
      if (req.url.includes('orca.vedapatel05')) {
        const ou = new global.URL(req.url);
        (posted.orca = posted.orca || []).push({ p: ou.pathname, method: req.method, body: req.postData || null });
        if (ou.pathname === '/v1/models') return { json: { object: 'list', data: state.orca.models } };
        if (ou.pathname === '/v1/chat/completions') return { json: { choices: [{ message: { content: 'VERDICT: WAIT. From a browser unit.\nWHY: Nothing more to add.' } }] } };
        // Phase 10: the voice (Edge with word timings; Aura without).
        if (ou.pathname === '/v1/audio/speech') { const b = JSON.parse(req.postData || '{}'), w = String(b.input || '').split(/\s+/).filter(Boolean); return { json: { format: 'mp3', engine: b.model === 'aura' ? 'aura' : 'edge', voice: b.voice, words: b.model === 'aura' ? null : w.map((x, i) => [i * 0.04, 0.04, x]), audio: TONE } }; }
        return { status: 404, json: {} };
      }
      // A test can play tradeboard-api (Webull, read-only) itself: Phase 12's Portfolio ▸ Risk and reconcile.
      if (state.tradeboard && req.url.includes('tradeboard-api')) { const r = state.tradeboard(req); if (r) return r; }
      if (!req.url.includes('quant-api')) return { json: { ok: true } };
      const u = new global.URL(req.url), p = u.pathname, auth = req.headers.Authorization || req.headers.authorization || '';
      asked.push({ p, method: req.method, auth, q: u.search });
      if (auth !== 'Bearer ' + KEY) return { status: 401, json: { ok: false, error: 'an Orca key is needed' } };
      // A day before the snapshot's own: the one before it (What changed?).
      if (p === '/snapshot' && req.method === 'GET' && state.prevSnapshot && u.searchParams.get('day') && u.searchParams.get('day') < (state.snapshot || {}).day) return { json: { ok: true, snapshot: state.prevSnapshot, watchlist: state.watchlist } };
      if (p === '/snapshot' && req.method === 'GET') return { json: { ok: true, snapshot: state.snapshot, watchlist: state.watchlist } };
      if (p === '/snapshot' && req.method === 'POST') { const s = JSON.parse(req.postData).snapshot; posted.snapshots.push(s); state.snapshot = s; return { json: { ok: true } }; }
      if (p === '/snapshot/claim') { posted.claims = (posted.claims || 0) + 1; return { json: { ok: true, granted: state.claim !== false } }; }
      if (p === '/watchlist') { const l = JSON.parse(req.postData).symbols; posted.watchlists.push(l); state.watchlist = l; return { json: { ok: true, symbols: l } }; }
      if (p === '/bars') {
        const sym = u.searchParams.get('symbol'), tf = u.searchParams.get('tf') || '1d', from = Number(u.searchParams.get('from')), to = Number(u.searchParams.get('to'));
        // Batch 2 (B0): a test can make one symbol's bars fail (state.barsFail) or arrive late (state.barsDelay ms).
        if (state.barsFail && state.barsFail.includes(sym)) return { status: 404, json: { ok: false, error: 'no bars for ' + sym } };
        const bars = TF_MS[tf] ? fakeIntraday(sym, tf, from, to) : fakeBars(sym, from, to);
        const out = { json: { ok: true, symbol: sym, tf, bars, provider: 'alpaca', complete: true, known: null } };
        const late = state.barsDelay && state.barsDelay[sym];
        return late ? new Promise((ok) => setTimeout(() => ok(out), late)) : out;
      }
      if (p === '/drawings' && req.method === 'GET') { const sym = u.searchParams.get('symbol'); return { json: { ok: true, symbol: sym, drawings: state.drawings[sym] || [], at: state.drawings[sym] ? 1 : null } }; }
      if (p === '/drawings' && req.method === 'PUT') { const b = JSON.parse(req.postData); state.drawings[b.symbol] = b.drawings; (posted.drawings = posted.drawings || []).push(b); return { json: { ok: true, n: b.drawings.length, at: CLOCK } }; }
      // Phase 14: GET answers rules as quant-api's ruleOf does (kind, params, enabled, cooldownMin) and the config;
      // /alerts/… plays the bell's fires, the config, the catalysts, Send test and the order.
      if (p === '/alerts' && req.method === 'GET') {
        const sym = u.searchParams.get('symbol');
        const out = state.alerts.filter((a) => !sym || a.symbol === sym).map((a) => {
          const legacy = !a.kind || a.kind === 'level' || a.kind === 'price';
          return { ...a, kind: legacy ? 'price' : a.kind, symbol: a.symbol || null, enabled: a.enabled !== false && a.active !== 0, cooldownMin: a.cooldownMin == null ? 30 : a.cooldownMin, quiet: !!a.quiet,
            params: legacy ? { ...(a.params || {}), price: a.price ?? (a.params || {}).price ?? null, lo: a.lo ?? null, hi: a.hi ?? null, dir: (a.params && a.params.dir) || (a.price == null && a.lo != null ? 'enter' : 'cross'), holds: !!(a.params && a.params.holds) } : (a.params || {}) };
        });
        return { json: { ok: true, alerts: out, config: state.alertCfg || ALERT_CFG() } };
      }
      if (p === '/alerts/fires') return { json: { ok: true, fires: state.alertFires || [], unseen: (state.alertFires || []).filter((f) => !f.seen).length } };
      if (p === '/alerts/seen') { (state.alertFires || []).forEach((f) => { f.seen = true; }); posted.seen = (posted.seen || 0) + 1; return { json: { ok: true } }; }
      if (p === '/alerts/config' && req.method === 'PUT') { state.alertCfg = JSON.parse(req.postData).config; (posted.alertCfg = posted.alertCfg || []).push(state.alertCfg); return { json: { ok: true, config: state.alertCfg } }; }
      if (p === '/alerts/config') return { json: { ok: true, config: state.alertCfg || ALERT_CFG() } };
      if (p === '/alerts/catalysts') { (posted.catalysts = posted.catalysts || []).push(JSON.parse(req.postData).items); return { json: { ok: true } }; }
      if (p === '/alerts/test') { posted.tests = (posted.tests || 0) + 1; return { json: state.pushTest || { ok: true, sent: 2, failed: 0, devices: ['Tony PC', 'Pixel 9'] } }; }
      if (p === '/alerts/order') { const ids = JSON.parse(req.postData).ids; state.alerts = ids.map((id) => state.alerts.find((a) => a.id === id)).filter(Boolean).concat(state.alerts.filter((a) => !ids.includes(a.id))); (posted.orders = posted.orders || []).push(ids); return { json: { ok: true } }; }
      if (p === '/alerts' && req.method === 'POST') { const a = JSON.parse(req.postData).alert, id = a.id || 'a' + (state.alerts.length + 1) + '_' + Math.round(Math.random() * 1e6); state.alerts = state.alerts.filter((x) => x.id !== id).concat([{ ...a, id, active: 1 }]); (posted.alerts = posted.alerts || []).push({ ...a, id }); return { json: { ok: true, id } }; }
      if (p === '/alerts' && req.method === 'DELETE') { const id = u.searchParams.get('id'); state.alerts = state.alerts.filter((x) => x.id !== id); return { json: { ok: true, id } }; }
      if (p === '/signals' && req.method === 'GET') return { json: { ok: true, signals: state.signals } };
      if (p === '/signals' && req.method === 'POST') { const b = JSON.parse(req.postData); (posted.signals = posted.signals || []).push(b); for (const x of b.signals) if (!state.signals.some((y) => y.id === x.id)) state.signals.push({ ...x, done: false }); return { json: { ok: true, sent: b.signals.length } }; }
      // Phase 6: calibration, paper trades, saved backtests.
      if (p === '/calibration' && req.method === 'GET') return { json: { ok: true, calibration: state.calibration } };
      if (p.startsWith('/paper/')) { const r = paperRoutes(state.pp, posted, req, u, p); if (r) return r; }
      if (p === '/paper' && req.method === 'GET') return { json: { ok: true, paper: state.paper } };
      if (p === '/paper' && req.method === 'POST') { const s = JSON.parse(req.postData).signal; (posted.paper = posted.paper || []).push(s); if (!state.paper.some((x) => x.id === s.id)) state.paper.unshift({ ...s, followed: CLOCK, paper: true }); return { json: { ok: true, id: s.id } }; }
      if (p === '/paper' && req.method === 'DELETE') { const id = u.searchParams.get('id'); state.paper = state.paper.filter((x) => x.id !== id); return { json: { ok: true } }; }
      if (p === '/backtests' && req.method === 'GET') return { json: { ok: true, backtests: state.backtests.map(({ curve, ...x }) => x) } };
      // Saved run ids from a running count (after a delete, the list's length would hand out an id twice).
      if (p === '/backtests' && req.method === 'POST') { const b = JSON.parse(req.postData), id = 'b' + (1000 + (state.btSeq = (state.btSeq || 0) + 1)) + 'live'; (posted.backtests = posted.backtests || []).push(b); state.backtests.unshift({ id, name: b.name, created: CLOCK, spec: b.spec, summary: b.summary, curve: { equity: b.curve, bench: b.bench } }); return { json: { ok: true, id, created: CLOCK } }; }
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
          // B1: a coin answers as the worker does, from Coinbase with its 24-hour open.
          else if (/^(BTC|ETH|SOL|SUI|XRP|DOGE)USD$/.test(s)) quotes[s] = { symbol: s, price: 100, open24: 95, t: CLOCK - 3000, heard: CLOCK - 1000, provider: 'coinbase', realtime: true, delayMs: 0 };
        }
        return { json: { ok: true, quotes, asOf: CLOCK, missing: {} } };
      }
      if (p === '/stream-keys') return { json: { ok: true, alpaca: { key: 'AK', secret: 'AS' }, finnhub: { key: 'FK' } } };
      if (p === '/usage') return { json: { ok: true, day: FIXTURE.day, usage: [], caps: {}, keys: { alpaca: true, yahoo: true }, health: [] } };
      if (p === '/corrections' && req.method === 'POST') { (posted.corrections = posted.corrections || []).push(JSON.parse(req.postData)); return { json: { ok: true } }; }
      if (p === '/corrections') return { json: { ok: true, corrections: [] } };
      if (p === '/ideas') return { json: { ok: true, ideas: state.ideas, at: state.ideas ? state.ideas.at : null } };
      const phase13 = contextRoutes(state, u, p);
      if (phase13) return phase13;
      const phase9 = aiRoutes(state, posted, req, u, p);
      if (phase9) return phase9;
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
  // Only Date.now() moves (faking new Date() too unsettled unrelated steps,
  // tried 2026-11-15). Page code that needs "today" under this clock reads it
  // through Date.now() (tradehub.html tbLocalDate does).
  const real = Date.now.bind(Date), shift = ${CLOCK} - real();
  Date.now = () => real() + shift;
  const Real = window.WebSocket;
  const state = { sent: [], sockets: [], subs: new Set(), timer: null };
  const emit = (o) => { for (const w of state.sockets) if (w.alpaca && w.readyState === 1 && w.onmessage) w.onmessage({ data: JSON.stringify(o) }); };
  window.__ws = { state,
    tick(sym, price) { emit([{ T: 't', S: sym, p: price, s: 1, t: new Date(Date.now()).toISOString() }]); },
    auto(ms) { clearInterval(state.timer); if (!ms) return; let n = 0; state.timer = setInterval(() => { n++; emit([...state.subs].map((S, i) => ({ T: 't', S, p: 100 + i + (n % 7) * 0.05, s: 1, t: new Date(Date.now()).toISOString() }))); }, ms); },
    // Batch 2 B1: Coinbase's ticker channel (crypto), faked like the others. cbTick('BTC-USD', 91800, 90000).
    cbSubs: new Set(),
    cbTick(pid, price, open24) { for (const w of state.sockets) if (w.coinbase && w.readyState === 1 && w.onmessage) w.onmessage({ data: JSON.stringify({ type: 'ticker', product_id: pid, price: String(price), open_24h: String(open24 || price), last_size: '0.01', time: new Date(Date.now()).toISOString() }) }); },
  };
  class FakeWS {
    constructor(url) {
      if (!/alpaca\\.markets|finnhub\\.io|coinbase\\.com/.test(url)) return new Real(url);
      this.url = url; this.readyState = 0; this.alpaca = /alpaca/.test(url); this.coinbase = /coinbase/.test(url); state.sockets.push(this);
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); if (this.alpaca) this.onmessage && this.onmessage({ data: JSON.stringify([{ T: 'success', msg: 'connected' }]) }); }, 30);
    }
    send(s) {
      const m = JSON.parse(s); state.sent.push(m);
      if (m.action === 'auth') this.onmessage && this.onmessage({ data: JSON.stringify([{ T: 'success', msg: 'authenticated' }]) });
      if (m.action === 'subscribe') for (const x of m.trades || []) state.subs.add(x);
      if (m.type === 'subscribe' && this.coinbase) for (const x of m.product_ids || []) window.__ws.cbSubs.add(x);
      if (m.type === 'unsubscribe' && this.coinbase) for (const x of m.product_ids || []) window.__ws.cbSubs.delete(x);
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
        localStorage.setItem('tradehub_quant', '${quant ? '1' : '0'}');
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
