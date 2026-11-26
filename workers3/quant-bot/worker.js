// Neo Cortex's bot worker (A1-Priv docs/TradeHub/quant-trading.md §N4), account 3.
// N0 (docs/TradeHub/quant/n4-00.md): the probes. N3 (n4-03.md): the strategist's lab and
// strategies (lib/lab.js). N4 adds the shadow cron, portfolio risk checks and journal.
//   /settings, /state, /today, /brief/:date                     lib/state.js (Tony’s key)
// N5 (n4-05.md): /lifecycle, /lifecycle/fires, /lifecycle/replay, /strategies/stage           lib/lifecycle.js
//
//   GET /health                       { ok, phase }
//   /lab/runs, /strategies, /research/request, /research/claim   lib/lab.js (Tony's key)
//   GET /probe/cpu?n=40&keep=400&stage=full  one bot tick on synthetic 5-min bars (CPU is read from Cloudflare's analytics)
//   GET /probe/d1                     the quantbot database answers
//   GET /probe/alpaca?symbols=A,B     the bot's Alpaca paper account: account, clock, calendar, IEX 5-min bars, shortable
// Auth: Authorization: Bearer <Tony's Orca key>; the worker holds only its SHA-256 (secret ALLOWED_KEYS, as
// quant-api). The probes also take PROBE_KEY (N0's session key).
import { withDefaults } from './core/strategy.js';
import { getRuns, postRun, getStrategies, postStrategy, getRequest, postRequest, claimRequest } from './lib/lab.js';
import { getSettings, putSettings, getState, getToday, getBrief } from './lib/state.js';
import { putMarketContext } from './lib/context.js';
import { killBot } from './lib/kill.js';
import { getLifecycle, getFires, postReplay, postStage, getTrades } from './lib/lifecycle.js';
import { ALPACA_PAPER, ALPACA_DATA } from './lib/alpaca.js';
import { buildContexts } from './core/simulate.js';
import { decide } from './core/pilot.js';

// Order code may call only these (quant-trading.md §1 rule 2); N0 calls only read paths.
export { ALPACA_PAPER, ALPACA_DATA };

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 1), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export const PROBE_SPEC = {
  name: 'probe', horizon: 'day', timeframe: '5m', side: 'both', universe: { symbols: [] },
  entry: { all: [{ ind: 'close', op: '>', than: { ind: 'vwap' } }, { ind: 'rsi', args: [14], op: '<', than: 70 }, { ind: 'relVolume', args: [20], op: '>', than: 1.5 }, { ind: 'ema', args: [9], op: '>', than: { ind: 'ema', args: [20] } }] },
  exit: { any: [{ stop: 'atr', value: 1.5 }, { target: 'r', value: 2 }, { bars: 24 }] },
  sizing: { kind: 'fixedRisk', value: 1 }, maxPositions: 6,
};

/** Synthetic 5-min sessions: a seeded random walk per symbol, 78 bars a weekday (09:30-15:55 New York, EST), the
 *  last session on `lastOpen` (a Wednesday 14:30 UTC = 09:30 EST). */
export function synthBars(n, keep, lastOpen = Date.UTC(2026, 10, 25, 14, 30)) {
  const opens = [];
  for (let back = 0; opens.length * 78 < keep; back++) { const t = lastOpen - back * 86_400_000, wd = new Date(t).getUTCDay(); if (wd !== 0 && wd !== 6) opens.push(t); }
  const out = {};
  for (let k = 0; k < n; k++) {
    let s = 7 + k, p = 50 + k * 9;
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const bars = [];
    for (let i = keep - 1; i >= 0; i--) {
      const day = Math.floor(i / 78), slot = 77 - (i % 78), t = opens[day] + slot * 300_000;
      const o = p, c = o * (1 + (rnd() - 0.5) * 0.004), h = Math.max(o, c) * (1 + rnd() * 0.001), l = Math.min(o, c) * (1 - rnd() * 0.001);
      bars.push({ t, o, h, l, c, v: Math.round(5000 + rnd() * 20000) });
      p = c;
    }
    out['S' + String(k).padStart(2, '0')] = bars;
  }
  return out;
}

// stage (each includes the ones before it, so CPU differences isolate a step):
//   synth   the synthetic bars only (the probe's own overhead)
//   body    + the bars as an Alpaca-shaped JSON body (still overhead: the real bot receives it)
//   parse   + JSON.parse of that body (what reading Alpaca's reply costs)
//   full    + buildContexts + decide (one bot tick)
//   engine  synth + buildContexts + decide, no JSON
export function tick({ n = 40, keep = 400, stage = 'full' } = {}) {
  let bars = synthBars(n, keep);
  if (stage === 'synth') return { n, keep, stage };
  if (stage !== 'engine') {
    const body = JSON.stringify({ bars: Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.map((x) => ({ t: new Date(x.t).toISOString(), o: x.o, h: x.h, l: x.l, c: x.c, v: x.v, n: 1200, vw: x.c }))])) });
    if (stage === 'body') return { n, keep, stage, bytes: body.length };
    const back = JSON.parse(body).bars; bars = Object.fromEntries(Object.entries(back).map(([s, b]) => [s, b.map((x) => ({ ...x, t: Date.parse(x.t) }))]));
    if (stage === 'parse') return { n, keep, stage, bytes: body.length };
  }
  const { spec } = withDefaults({ ...PROBE_SPEC }, { today: '2026-11-25' });
  const r = decide(spec, { contexts: buildContexts(spec, { bars, daily: {} }), capital: 5000, equity: 5000, at: Date.now() });
  return { n, keep, stage, orders: r.orders.length, notes: r.notes.length };
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
  const syms = (url.searchParams.get('symbols') || 'SPY,QQQ,NVDA,AMD,TSLA').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(s)).slice(0, 40);
  if (!syms.length) return json({ ok: false, error: 'no valid symbols' }, 400);
  const today = new Date().toISOString().slice(0, 10), until = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  const [acct, clock, cal, bars] = await Promise.all([
    alpaca(env, ALPACA_PAPER, '/v2/account'), alpaca(env, ALPACA_PAPER, '/v2/clock'),
    alpaca(env, ALPACA_PAPER, `/v2/calendar?start=${today}&end=${until}`),
    alpaca(env, ALPACA_DATA, `/v2/stocks/bars?symbols=${encodeURIComponent(syms.join(','))}&timeframe=5Min&feed=iex&limit=10000&start=${encodeURIComponent(new Date(Date.now() - 3 * 86_400_000).toISOString())}`),
  ]);
  const assets = await Promise.all(syms.slice(0, 20).map((s) => alpaca(env, ALPACA_PAPER, '/v2/assets/' + encodeURIComponent(s))));
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

export async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** Tony's key? Compared by hash, every allowed hash checked (no early stop). */
export async function keyOk(req, env) {
  const allowed = String(env.ALLOWED_KEYS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const key = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!allowed.length || !/^orca_sk_[\w-]{8,}$/.test(key)) return false;
  const h = await sha256Hex(key);
  let ok = 0;
  for (const a of allowed) ok |= a.length === h.length && [...a].every((c, i) => c === h[i]) ? 1 : 0;
  return ok === 1;
}

const ROUTES = {
  'POST /bot/kill': async (req, env) => killBot(env, await req.json().catch(() => null)),
  'PUT /market/context': async (req, env) => putMarketContext(env, await req.json().catch(() => null)),
  'GET /settings': (req, env, url) => getSettings(env, url), 'PUT /settings': async (req, env) => putSettings(env, await req.json().catch(() => null)),
  'GET /state': (req, env) => getState(env), 'GET /today': getToday,
  'GET /lab/runs': (req, env, url) => getRuns(env, url), 'POST /lab/runs': async (req, env) => postRun(env, await req.json()),
  'GET /strategies': (req, env, url) => getStrategies(env, url), 'POST /strategies': async (req, env) => postStrategy(env, await req.json()),
  'GET /research/request': (req, env) => getRequest(env), 'POST /research/request': async (req, env) => postRequest(env, await req.json().catch(() => ({}))),
  'POST /research/claim': async (req, env) => claimRequest(env, await req.json()),
  'GET /lifecycle': (req, env) => getLifecycle(env), 'GET /trades': (req, env, url) => getTrades(env, url), 'GET /lifecycle/fires': (req, env, url) => getFires(env, url),
  'POST /lifecycle/replay': async (req, env) => postReplay(env, await req.json().catch(() => null)),
  'POST /strategies/stage': async (req, env) => postStage(env, await req.json().catch(() => null)),
};

// N6: TradeHub's page calls quant-bot directly (Control ▸ Neo Cortex, N7's tab); the same origins as quant-api.
const ORIGINS = [/^https:\/\/a1-priv\.av1\.workers\.dev$/, /^https:\/\/anthonyn99\.github\.io$/, /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/];
export function corsHeaders(req) {
  const o = req.headers.get('origin') || '';
  if (!ORIGINS.some((re) => re.test(o))) return { vary: 'Origin' };
  return { 'access-control-allow-origin': o, 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, if-none-match',
    'access-control-expose-headers': 'etag', 'access-control-max-age': '86400', vary: 'Origin' };
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try { res = await handle(req, env); } catch (e) { res = json({ error: String(e && e.message || e) }, 500); }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

async function handle(req, env) {
  {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true, worker: 'quant-bot', phase: 'N5 lifecycle' });
    const tony = await keyOk(req, env);
    const brief = req.method === 'GET' && /^\/brief\/([^\/]+)$/.exec(url.pathname);
    const route = (brief && ((_req, bindings) => getBrief(bindings, brief[1]))) || ROUTES[`${req.method} ${url.pathname}`];
    if (route) {
      if (!tony) return json({ error: 'unauthorized' }, 401);
      try { return await route(req, env, url); } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
    }
    if (!tony && !(env.PROBE_KEY && req.headers.get('authorization') === 'Bearer ' + env.PROBE_KEY)) return json({ error: 'unauthorized' }, 401);
    if (req.method !== 'GET') return json({ error: 'read-only' }, 405);
    try {
      if (url.pathname === '/probe/cpu') {
        const n = Math.min(+url.searchParams.get('n') || 40, 80), keep = Math.min(+url.searchParams.get('keep') || 400, 2000);
        return json(tick({ n, keep, stage: url.searchParams.get('stage') || 'full' }));
      }
      if (url.pathname === '/probe/d1') { const r = await env.DB.prepare('select 1 as one').first(); return json({ ok: true, d1: r }); }
      if (url.pathname === '/probe/alpaca') return await probeAlpaca(env, url);
      return json({ error: 'not found' }, 404);
    } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
  }
}
