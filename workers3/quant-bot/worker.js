// Neo Cortex's bot worker (A1-Priv docs/TradeHub/quant-trading.md §N4), account 3.
// N0 (docs/TradeHub/quant/n4-00.md): PROBES ONLY. No cron, no order route; every
// route is read-only. The bot itself (cron, risk book, journal, kill switch) is N4.
//
//   GET /health                       { ok, phase }
//   GET /probe/cpu?n=40&keep=400&parse=1   one bot tick on synthetic 5-min bars (CPU is read from Cloudflare's analytics)
//   GET /probe/d1                     the quantbot database answers
//   GET /probe/alpaca?symbols=A,B     the bot's Alpaca paper account: account, clock, calendar, IEX 5-min bars, shortable
// Auth: Authorization: Bearer <PROBE_KEY> (a secret set by the session; N4 replaces it with ALLOWED_KEYS).
import { withDefaults } from './core/strategy.js';
import { buildContexts } from './core/simulate.js';
import { decide } from './core/pilot.js';

// Order code may call only these (quant-trading.md §1 rule 2); N0 calls only read paths.
export const ALPACA_PAPER = 'https://paper-api.alpaca.markets';
export const ALPACA_DATA = 'https://data.alpaca.markets';

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 1), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export const PROBE_SPEC = {
  name: 'probe', horizon: 'day', timeframe: '5m', side: 'both', universe: { symbols: [] },
  entry: { all: [{ ind: 'close', op: '>', than: { ind: 'vwap' } }, { ind: 'rsi', args: [14], op: '<', than: 70 }, { ind: 'relVolume', args: [20], op: '>', than: 1.5 }, { ind: 'ema', args: [9], op: '>', than: { ind: 'ema', args: [20] } }] },
  exit: { any: [{ stop: 'atr', value: 1.5 }, { target: 'r', value: 2 }, { bars: 24 }] },
  sizing: { kind: 'fixedRisk', value: 1 }, maxPositions: 6,
};

/** Synthetic 5-min sessions: a seeded random walk per symbol, 78 bars a day, ending now. */
export function synthBars(n, keep, now = Date.UTC(2026, 10, 25, 20, 0)) {
  const out = {};
  for (let k = 0; k < n; k++) {
    let s = 7 + k, p = 50 + k * 9;
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const bars = [];
    for (let i = keep - 1; i >= 0; i--) {
      const day = Math.floor(i / 78), slot = 77 - (i % 78), t = now - day * 86_400_000 - (77 - slot) * 300_000;
      const o = p, c = o * (1 + (rnd() - 0.5) * 0.004), h = Math.max(o, c) * (1 + rnd() * 0.001), l = Math.min(o, c) * (1 - rnd() * 0.001);
      bars.push({ t, o, h, l, c, v: Math.round(5000 + rnd() * 20000) });
      p = c;
    }
    out['S' + String(k).padStart(2, '0')] = bars;
  }
  return out;
}

export function tick({ n = 40, keep = 400, parse = false } = {}) {
  let bars = synthBars(n, keep);
  // parse=1 also pays what reading Alpaca's reply costs: the same bars as a JSON body, parsed.
  if (parse) { const body = JSON.stringify({ bars: Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.map((x) => ({ t: new Date(x.t).toISOString(), o: x.o, h: x.h, l: x.l, c: x.c, v: x.v, n: 1200, vw: x.c }))])) });
    const back = JSON.parse(body).bars; bars = Object.fromEntries(Object.entries(back).map(([s, b]) => [s, b.map((x) => ({ ...x, t: Date.parse(x.t) }))])); }
  const spec = withDefaults({ ...PROBE_SPEC }, { today: '2026-11-25' });
  const r = decide(spec, { contexts: buildContexts(spec, { bars, daily: {} }), capital: 5000, equity: 5000, at: Date.now() });
  return { symbols: n, barsEach: keep, parse: !!parse, orders: r.orders.length, notes: r.notes.length };
}

async function alpaca(env, base, p) {
  const t0 = Date.now();
  const r = await fetch(base + p, { headers: { 'APCA-API-KEY-ID': env.BOT_ALPACA_KEY, 'APCA-API-SECRET-KEY': env.BOT_ALPACA_SECRET } });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { status: r.status, ms: Date.now() - t0, bytes: text.length, body };
}

async function probeAlpaca(env, url) {
  if (!env.BOT_ALPACA_KEY || !env.BOT_ALPACA_SECRET) return json({ ok: false, error: 'BOT_ALPACA_KEY / BOT_ALPACA_SECRET are not set on quant-bot' }, 503);
  const syms = (url.searchParams.get('symbols') || 'SPY,QQQ,NVDA,AMD,TSLA').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 40);
  const today = new Date().toISOString().slice(0, 10), until = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  const [acct, clock, cal, bars] = await Promise.all([
    alpaca(env, ALPACA_PAPER, '/v2/account'), alpaca(env, ALPACA_PAPER, '/v2/clock'),
    alpaca(env, ALPACA_PAPER, `/v2/calendar?start=${today}&end=${until}`),
    alpaca(env, ALPACA_DATA, `/v2/stocks/bars?symbols=${syms.join(',')}&timeframe=5Min&feed=iex&limit=10000&start=${new Date(Date.now() - 3 * 86_400_000).toISOString()}`),
  ]);
  const assets = await Promise.all(syms.slice(0, 20).map((s) => alpaca(env, ALPACA_PAPER, '/v2/assets/' + s)));
  const a = acct.body || {};
  return json({
    ok: acct.status === 200,
    account: { status: acct.status, ms: acct.ms, state: a.status, equity: a.equity, cash: a.cash, buying_power: a.buying_power, shorting_enabled: a.shorting_enabled, multiplier: a.multiplier, pdt: a.pattern_day_trader, daytrade_count: a.daytrade_count, number_tail: String(a.account_number || '').slice(-4) },
    clock: { status: clock.status, ms: clock.ms, body: clock.body },
    calendar: { status: cal.status, ms: cal.ms, days: Array.isArray(cal.body) ? cal.body.map((d) => `${d.date} ${d.open}-${d.close}`) : cal.body },
    bars: { status: bars.status, ms: bars.ms, bytes: bars.bytes, next: bars.body && bars.body.next_page_token, perSymbol: bars.body && bars.body.bars ? Object.fromEntries(Object.entries(bars.body.bars).map(([s, b]) => [s, { n: b.length, last: b.length ? b[b.length - 1].t : null }])) : bars.body },
    assets: assets.map((x, i) => ({ sym: syms[i], status: x.status, shortable: x.body && x.body.shortable, easy_to_borrow: x.body && x.body.easy_to_borrow, fractionable: x.body && x.body.fractionable, tradable: x.body && x.body.tradable })),
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true, worker: 'quant-bot', phase: 'N0 probes' });
    if (!env.PROBE_KEY || req.headers.get('authorization') !== 'Bearer ' + env.PROBE_KEY) return json({ error: 'unauthorized' }, 401);
    if (req.method !== 'GET') return json({ error: 'read-only' }, 405);
    try {
      if (url.pathname === '/probe/cpu') {
        const n = Math.min(+url.searchParams.get('n') || 40, 80), keep = Math.min(+url.searchParams.get('keep') || 400, 2000);
        return json(tick({ n, keep, parse: url.searchParams.get('parse') === '1' }));
      }
      if (url.pathname === '/probe/d1') { const r = await env.DB.prepare('select 1 as one, sqlite_version() as v').first(); return json({ ok: true, d1: r }); }
      if (url.pathname === '/probe/alpaca') return await probeAlpaca(env, url);
      return json({ error: 'not found' }, 404);
    } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
  },
};
