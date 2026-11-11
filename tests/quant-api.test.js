// quant-api (workers2/quant-api): who may call it, the budget ledger, CORS,
// and the data gateway (quotes, bars, stream keys, corrections) against mocked
// providers. The worker runs here against a small in-memory stand-in for D1
// and a fake `fetch` that plays every outside service.
//
// Run: node tests/quant-api.test.js
'use strict';
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

// The statements the worker uses, over plain maps.
function fakeDb() {
  const usage = new Map(), health = new Map(), meta = new Map(), corrections = [];
  const SKIP = 5 * 60000;
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first() {
      if (/^SELECT 1/.test(sql)) return { one: 1 };
      if (/FROM usage WHERE day = \? AND service = \?/.test(sql)) { const n = usage.get(args[0] + '|' + args[1]); return n == null ? null : { n }; }
      if (/FROM bars_meta/.test(sql)) return meta.get(args[0] + '|' + args[1]) || null;
      throw new Error('fakeDb.first: ' + sql);
    },
    async all() {
      if (/FROM usage WHERE day = \?/.test(sql)) return { results: [...usage].filter(([k]) => k.startsWith(args[0] + '|')).map(([k, n]) => ({ service: k.split('|')[1], n })).sort((a, b) => a.service.localeCompare(b.service)) };
      if (/FROM provider_health/.test(sql)) return { results: [...health.values()].map((h) => ({ ...h })) };
      if (/FROM corrections/.test(sql)) return { results: corrections.slice().reverse().slice(0, args[0]) };
      throw new Error('fakeDb.all: ' + sql);
    },
    async run() {
      if (/^INSERT INTO usage/.test(sql)) { const k = args[0] + '|' + args[1]; usage.set(k, (usage.get(k) || 0) + args[2]); return {}; }
      if (/^INSERT INTO provider_health/.test(sql)) {
        const old = health.get(args[0]);
        const okNow = args[1] === 1, at = args[5];
        const fails = okNow ? 0 : old ? (old.fails || 0) + 1 : 1;
        const skip = args[8] != null ? args[8] : okNow ? null : old && fails >= 3 ? at + SKIP : old ? old.skip_until : null;
        health.set(args[0], { provider: args[0], ok: args[1], status: args[2], latency_ms: args[3], detail: args[4], at, ok_at: args[6] == null ? ((old && old.ok_at) || null) : args[6], fails, skip_until: skip });
        return {};
      }
      if (/^INSERT INTO bars_meta/.test(sql)) { meta.set(args[0] + '|' + args[1], { first_t: args[2], last_t: args[3], provider: args[4] }); return {}; }
      if (/^INSERT INTO corrections/.test(sql)) { corrections.push({ id: corrections.length + 1, at: args[0], kind: args[1], symbol: args[2], field: args[3], old_v: args[4], new_v: args[5], source: args[6], note: args[7] }); return {}; }
      throw new Error('fakeDb.run: ' + sql);
    },
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; }, usage, health, meta, corrections };
}

/* ── the outside world, played here ─────────────────────────────────────── */
const DAY = 86400000;
const NOW = Date.now();
// Daily bars every weekday between two dates, priced from the date so two sources agree.
function weekdays(from, to) { const out = []; for (let t = Date.UTC(...from); t <= Date.UTC(...to); t += DAY) { const d = new Date(t).getUTCDay(); if (d > 0 && d < 6) out.push(t); } return out; }
const px = (t) => 100 + (Math.floor(t / DAY) % 50);
const W = {
  down: new Set(),          // providers answering 500
  calls: [],                // every URL asked
  status: {},               // provider -> forced status once
  retryAfter: null,
  reset() { this.down.clear(); this.calls.length = 0; this.status = {}; this.retryAfter = null; },
  count(host) { return this.calls.filter((u) => u.includes(host)).length; },
};
const res = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function providerOf(u) {
  if (u.includes('data.alpaca.markets')) return 'alpaca';
  if (u.includes('api.public.com')) return 'public';
  if (u.includes('finnhub.io')) return 'finnhub';
  if (u.includes('finance.yahoo.com')) return 'yahoo';
  if (u.includes('api.tiingo.com')) return 'tiingo';
  return 'other';
}
// New York midnight for a UTC date at 00:00 (standard time is close enough for the fakes).
const nyMid = (t) => t + 5 * 3600000;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), p = providerOf(u);
  W.calls.push(u);
  if (W.down.has(p)) return res({ error: 'down' }, 500);
  if (W.status[p]) { const s = W.status[p]; delete W.status[p]; return res({ error: 'x' }, s, W.retryAfter != null ? { 'retry-after': String(W.retryAfter) } : {}); }
  const q = new URL(u).searchParams;
  if (p === 'alpaca' && u.includes('/snapshots')) {
    const out = {};
    for (const s of q.get('symbols').split(',')) out[s] = { latestTrade: { p: 50 + s.length, t: new Date(NOW - 1000).toISOString(), s: 10 }, latestQuote: { bp: 49, ap: 51 } };
    return res(out);
  }
  if (p === 'alpaca' && u.includes('/bars')) {
    const tf = q.get('timeframe'), start = Date.parse(q.get('start')), end = Date.parse(q.get('end'));
    let ts;
    if (tf === '1Day') ts = weekdays([new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate()], [new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), new Date(end).getUTCDate()]).map(nyMid).filter((t) => t >= start - DAY && t <= end);
    else { const step = { '1Min': 60000, '5Min': 300000, '1Hour': 3600000 }[tf] || 60000; ts = []; for (let t = Math.ceil(start / step) * step; t <= end; t += step) ts.push(t); }
    return res({ bars: ts.map((t) => ({ t: new Date(t).toISOString(), o: px(t), h: px(t) + 1, l: px(t) - 1, c: px(t) + 0.5, v: q.get('feed') === 'iex' ? 7 : 1000 })), next_page_token: null });
  }
  if (p === 'public' && u.includes('access-tokens')) return res({ accessToken: 'tok' });
  if (p === 'public' && u.includes('/trading/account')) return res({ accounts: [{ accountId: 'acct1' }] });
  if (p === 'public' && u.includes('/quotes')) {
    const body = JSON.parse(init.body);
    return res({ quotes: body.instruments.map((i) => ({ instrument: i, outcome: 'SUCCESS', last: '60.5', lastTimestamp: new Date(NOW - 2000).toISOString(), bid: '60.4', ask: '60.6' })) });
  }
  if (p === 'finnhub') return res({ c: 70.25, t: Math.floor((NOW - 3000) / 1000) });
  if (p === 'yahoo' && u.includes('/spark')) {
    return res({ spark: { result: q.get('symbols').split(',').map((s) => ({ symbol: s, response: [{ meta: { regularMarketPrice: 80, regularMarketTime: Math.floor((NOW - 60000) / 1000) }, timestamp: [Math.floor((NOW - 30000) / 1000)], indicators: { quote: [{ close: [80.5] }] } }] })) } });
  }
  if (p === 'yahoo' && u.includes('/chart/')) {
    const a = Number(q.get('period1')) * 1000, b = Number(q.get('period2')) * 1000, iv = q.get('interval');
    let ts;
    if (iv === '1d') ts = weekdays([new Date(a).getUTCFullYear(), new Date(a).getUTCMonth(), new Date(a).getUTCDate()], [new Date(b).getUTCFullYear(), new Date(b).getUTCMonth(), new Date(b).getUTCDate()]).map((t) => t + 14.5 * 3600000).filter((t) => t >= a && t <= b);
    else { const step = { '1m': 60000, '5m': 300000, '60m': 3600000 }[iv] || 60000; ts = []; for (let t = Math.ceil(a / step) * step; t <= b; t += step) ts.push(t); }
    const base = ts.map((t) => px(t - 14.5 * 3600000 + 5 * 3600000));
    return res({ chart: { result: [{ timestamp: ts.map((t) => Math.floor(t / 1000)), indicators: { quote: [{ open: base, high: base.map((x) => x + 1), low: base.map((x) => x - 1), close: base.map((x) => x + 0.5), volume: base.map(() => 500) }] },
      events: { splits: { s1: { date: Math.floor(Date.UTC(2014, 5, 9, 13, 30) / 1000), numerator: 7, denominator: 1 } } } }] } });
  }
  if (p === 'tiingo') return res([{ date: '2015-01-02T00:00:00Z', open: 10, high: 11, low: 9, close: 10.5, volume: 100, splitFactor: 1 }]);
  return res({ error: 'unknown ' + u }, 404);
};

(async () => {
  const Wk = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'worker.js')).href);
  const T = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'lib', 'time.js')).href);
  const B = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'lib', 'bars.js')).href);
  const PO = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'providers', 'others.js')).href);
  const GOOD = 'orca_sk_test_good_key_0123456789', OTHER = 'orca_sk_test_other_key_987654321';
  const hash = crypto.createHash('sha256').update(GOOD).digest('hex');
  const call = async (env, p, { key, origin, method, body } = {}) => {
    const h = {}; if (key) h.authorization = 'Bearer ' + key; if (origin) h.origin = origin;
    if (body) h['content-type'] = 'application/json';
    const r = await Wk.default.fetch(new Request('https://quant-api.test' + p, { method: method || 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }), env, {});
    let b = null; try { b = await r.json(); } catch (e) {}
    return { status: r.status, body: b, headers: r.headers };
  };
  const KEYS = { ALPACA_KEY: 'ak', ALPACA_SECRET: 'as', PUBLIC_KEY: 'pk', FINNHUB_KEY: 'fk', TIINGO_KEY: 'tk' };
  const fullEnv = () => ({ DB: fakeDb(), ALLOWED_KEYS: hash, ...KEYS });

  console.log('\nWho may call it');
  let env = { DB: fakeDb(), ALLOWED_KEYS: hash };
  let r = await call(env, '/health');
  ok('/health answers without a key, and says the database is there', r.status === 200 && r.body.ok && r.body.db === true);
  r = await call(env, '/whoami');
  ok('no key: 401', r.status === 401);
  r = await call(env, '/whoami', { key: 'not-an-orca-key' });
  ok('something that is not an Orca key: 401', r.status === 401);
  r = await call(env, '/whoami', { key: OTHER });
  ok("someone else's Orca key: 403", r.status === 403);
  r = await call(env, '/whoami', { key: GOOD });
  ok('the allowed key: 200', r.status === 200 && r.body.ok);
  r = await call({ DB: fakeDb(), ALLOWED_KEYS: 'abc, ' + hash.toUpperCase() + ' ' }, '/whoami', { key: GOOD });
  ok('a list of allowed hashes, any case, spaces around', r.status === 200);
  r = await call({ DB: fakeDb() }, '/whoami', { key: GOOD });
  ok('no ALLOWED_KEYS set: everything but /health is refused (503)', r.status === 503);
  r = await call({ DB: fakeDb() }, '/health');
  ok('...and /health still answers', r.status === 200);
  ok('the hash matches Node\'s SHA-256', (await Wk.sha256Hex(GOOD)) === hash);
  r = await call(env, '/nope', { key: GOOD });
  ok('an unknown route: 404', r.status === 404);

  console.log('\nThe budget ledger');
  env = { DB: fakeDb(), ALLOWED_KEYS: hash };
  ok('a call under the cap is counted', (await Wk.spend(env, 'alphavantage')) === true && env.DB.usage.get(Wk.day() + '|alphavantage') === 1);
  for (let i = 0; i < Wk.CAPS.alphavantage - 1; i++) await Wk.spend(env, 'alphavantage');
  ok('up to the cap', env.DB.usage.get(Wk.day() + '|alphavantage') === Wk.CAPS.alphavantage);
  ok('the call past the cap is refused and not counted', (await Wk.spend(env, 'alphavantage')) === false && env.DB.usage.get(Wk.day() + '|alphavantage') === Wk.CAPS.alphavantage);
  ok('a service with no cap is always counted', (await Wk.spend(env, 'internal')) === true);
  ok('a model of a service shares the service\'s cap', (await Wk.spend(env, 'groq:gpt-oss-120b', Wk.CAPS.groq)) === true && (await Wk.spend(env, 'groq:gpt-oss-120b')) === false);
  await Wk.noteHealth(env, 'finnhub', true, 200, 120.4);
  const okAt = env.DB.health.get('finnhub').ok_at;
  await Wk.noteHealth(env, 'finnhub', false, 429, 80, 'rate limited');
  const h = env.DB.health.get('finnhub');
  ok('health keeps the last answer and when it last worked', h.ok === 0 && h.status === 429 && h.detail === 'rate limited' && h.ok_at === okAt && h.latency_ms === 80);
  r = await call(env, '/usage', { key: GOOD });
  ok('/usage lists today\'s counts with their caps, and health',
    r.status === 200 && r.body.usage.some((u) => u.service === 'alphavantage' && u.n === Wk.CAPS.alphavantage && u.cap === Wk.CAPS.alphavantage)
    && r.body.usage.some((u) => u.service === 'internal' && u.cap === null) && r.body.health.length === 1, JSON.stringify(r.body));
  ok('every cap is far under its free tier', Wk.CAPS.alphavantage < 25 && Wk.CAPS.fred < 1000 && Wk.CAPS.groq < 1000 && Wk.CAPS.tiingo < 1000);
  ok('/usage says which keys are set (and never shows them)', r.body.keys && r.body.keys.yahoo === true && r.body.keys.alpaca === false && !JSON.stringify(r.body).includes('"ak"'));

  console.log('\nCORS');
  r = await call(env, '/health', { origin: 'https://a1-priv.av1.workers.dev' });
  ok('TradeHub\'s origin is allowed', r.headers.get('access-control-allow-origin') === 'https://a1-priv.av1.workers.dev');
  r = await call(env, '/health', { origin: 'https://evil.example' });
  ok('another site gets no allow header', !r.headers.get('access-control-allow-origin'));
  r = await call(env, '/whoami', { origin: 'https://a1-priv.av1.workers.dev', method: 'OPTIONS' });
  ok('a preflight is answered without a key', r.status === 204 && /authorization/.test(r.headers.get('access-control-allow-headers') || ''));
  r = await call(env, '/whoami', { origin: 'https://a1-priv.av1.workers.dev' });
  ok('a refusal still carries the CORS header, so the page can read why', r.status === 401 && r.headers.get('access-control-allow-origin') === 'https://a1-priv.av1.workers.dev');

  console.log('\nQuotes: the fallback chain');
  W.reset(); PO.publicCom.reset();
  env = fullEnv();
  r = await call(env, '/quotes?symbols=nvda,AMD,nvda', { key: GOOD });
  ok('Alpaca answers first; symbols upper-cased and de-duplicated', r.status === 200 && Object.keys(r.body.quotes).sort().join() === 'AMD,NVDA' && r.body.quotes.NVDA.provider === 'alpaca', JSON.stringify(r.body));
  const qa = r.body.quotes.NVDA;
  ok('a quote is exactly the contract: price, t, heard, provider, realtime, delayMs (+ bid/ask/size)',
    qa.price > 0 && qa.t < NOW + 5000 && qa.heard >= NOW && qa.realtime === true && qa.delayMs === 0 && qa.bid === 49 && qa.ask === 51 && qa.size === 10 && !('label' in qa));
  ok('only Alpaca was asked', W.count('alpaca') === 1 && W.count('finnhub') === 0 && W.count('yahoo') === 0);
  W.reset(); env = fullEnv(); W.down.add('alpaca');
  r = await call(env, '/quotes?symbols=NVDA', { key: GOOD });
  ok('Alpaca down: Public.com answers', r.status === 200 && r.body.quotes.NVDA.provider === 'public' && r.body.quotes.NVDA.price === 60.5 && r.body.quotes.NVDA.realtime === true);
  W.down.add('public');
  r = await call(env, '/quotes?symbols=NVDA', { key: GOOD });
  ok('Public.com down too: Finnhub answers', r.status === 200 && r.body.quotes.NVDA.provider === 'finnhub' && r.body.quotes.NVDA.t === Math.floor((NOW - 3000) / 1000) * 1000);
  W.down.add('finnhub');
  r = await call(env, '/quotes?symbols=NVDA', { key: GOOD });
  const qy = r.body && r.body.quotes && r.body.quotes.NVDA;
  ok('only Yahoo left: it answers, and says it is not real-time', r.status === 200 && qy.provider === 'yahoo' && qy.realtime === false && qy.delayMs === 0);
  ok('Yahoo\'s newest minute (after hours too) beats its older regular price', qy.price === 80.5);
  W.down.add('yahoo');
  r = await call(env, '/quotes?symbols=NVDA', { key: GOOD });
  ok('everyone down: 503 with the list tried, and no quote at all', r.status === 503 && !r.body.quotes
    && r.body.tried.map((t) => t.provider).join() === 'alpaca,public,finnhub,yahoo', JSON.stringify(r.body));
  W.reset();
  r = await call({ DB: fakeDb(), ALLOWED_KEYS: hash }, '/quotes?symbols=NVDA', { key: GOOD });
  ok('no keys set: the keyed sources are passed over as "no key", Yahoo answers', r.status === 200 && r.body.quotes.NVDA.provider === 'yahoo'
    && r.body.tried.filter((t) => t.error === 'no key').length === 3 && W.count('alpaca') === 0);
  W.reset(); env = fullEnv();
  r = await call(env, '/quotes?symbols=NVDA,%5EVIX', { key: GOOD });
  ok('an index (^VIX) goes to Yahoo while the stock stays with Alpaca', r.body.quotes['^VIX'].provider === 'yahoo' && r.body.quotes.NVDA.provider === 'alpaca');
  r = await call(env, '/quotes?symbols=' + Array.from({ length: 61 }, (_, i) => 'S' + i).join(','), { key: GOOD });
  ok('more than 60 symbols: 400', r.status === 400);
  r = await call(env, '/quotes?symbols=NV%3BDA', { key: GOOD });
  ok('a symbol that is not one: 400', r.status === 400);
  r = await call(env, '/quotes?symbols=NVDA');
  ok('/quotes needs the key', r.status === 401);

  console.log('\nThe skip window, caps and retries');
  W.reset(); PO.publicCom.reset(); env = fullEnv(); W.down.add('alpaca');
  for (let i = 0; i < 3; i++) await call(env, '/quotes?symbols=NVDA', { key: GOOD });
  ok('Alpaca failed three times in a row', W.count('alpaca') === 3 && env.DB.health.get('alpaca').fails === 3 && env.DB.health.get('alpaca').skip_until > NOW);
  await call(env, '/quotes?symbols=NVDA', { key: GOOD });
  ok('...so the fourth request does not ask it at all', W.count('alpaca') === 3);
  W.down.delete('alpaca');
  env.DB.health.get('alpaca').skip_until = Date.now() - 1;
  r = await call(env, '/quotes?symbols=NVDA', { key: GOOD });
  ok('after the five minutes it is asked again, and an answer clears its failures', r.body.quotes.NVDA.provider === 'alpaca' && env.DB.health.get('alpaca').fails === 0 && env.DB.health.get('alpaca').skip_until === null);
  W.reset(); env = fullEnv();
  env.DB.usage.set(Wk.day() + '|alpaca', Wk.CAPS.alpaca);
  r = await call(env, '/quotes?symbols=NVDA', { key: GOOD });
  ok('Alpaca at its daily cap: not asked, the next source answers', W.count('alpaca') === 0 && r.body.quotes.NVDA.provider === 'public'
    && /cap/.test(r.body.tried[0].error));
  W.reset(); env = fullEnv(); W.status.alpaca = 429; W.retryAfter = 0;
  r = await call(env, '/quotes?symbols=NVDA', { key: GOOD });
  ok('a 429 with Retry-After is tried once more, and that answer is used', W.count('alpaca') === 2 && r.body.quotes.NVDA.provider === 'alpaca');
  W.reset(); env = fullEnv(); W.status.alpaca = 429; W.retryAfter = 30;
  r = await call(env, '/quotes?symbols=NVDA', { key: GOOD });
  ok('a Retry-After over 2 s is not waited for: straight to the next source', W.count('alpaca') === 1 && r.body.quotes.NVDA.provider === 'public');
  W.reset(); PO.publicCom.reset(); env = fullEnv(); W.down.add('alpaca');
  await call(env, '/quotes?symbols=NVDA', { key: GOOD });
  await call(env, '/quotes?symbols=AMD', { key: GOOD });
  ok('Public.com\'s access token and account are fetched once and kept', W.count('access-tokens') === 1 && W.count('/trading/account') === 1 && W.count('/marketdata/acct1/quotes') === 2);
  ok('every call was counted in the ledger', env.DB.usage.get(Wk.day() + '|public') === 4 && env.DB.usage.get(Wk.day() + '|alpaca') === 2);

  console.log('\nStream keys');
  env = fullEnv();
  r = await call(env, '/stream-keys');
  ok('refused without the key', r.status === 401 && !JSON.stringify(r.body).includes('"as"'));
  r = await call(env, '/stream-keys', { key: OTHER });
  ok('refused with another key', r.status === 403);
  r = await call(env, '/stream-keys', { key: GOOD });
  ok('with the key: the Alpaca paper key and the Finnhub key, never cached', r.status === 200 && r.body.alpaca.key === 'ak' && r.body.alpaca.secret === 'as' && r.body.finnhub.key === 'fk'
    && r.headers.get('cache-control') === 'no-store');
  r = await call({ DB: fakeDb(), ALLOWED_KEYS: hash }, '/stream-keys', { key: GOOD });
  ok('a key not set comes back as null', r.body.alpaca === null && r.body.finnhub === null);

  console.log('\nBars');
  W.reset(); env = fullEnv();
  r = await call(env, '/bars?symbol=NVDA&tf=1d&from=2015-06-01&to=2016-03-01', { key: GOOD });
  const yUrls = W.calls.filter((u) => u.includes('/chart/'));
  ok('daily before 2016 comes from Yahoo, after from Alpaca, joined', r.status === 200 && r.body.provider === 'yahoo+alpaca' && r.body.complete === true, JSON.stringify(r.body).slice(0, 300));
  ok('a Yahoo daily request always carries period1 and period2 (never range=max)', yUrls.length > 0 && yUrls.every((u) => /period1=\d+/.test(u) && /period2=\d+/.test(u) && !/range=/.test(u)));
  const bs = r.body.bars;
  ok('no doubles, oldest first, every bar stamped 00:00 New York', bs.every((b, i) => i === 0 || b.t > bs[i - 1].t) && bs.every((b) => T.nyClock(b.t).minutes === 0));
  ok('the join has no gap at the seam', bs.some((b) => T.nyDate(b.t) === '2015-12-31') && bs.some((b) => T.nyDate(b.t) === '2016-01-04'));
  ok('bars_meta records what history is known', env.DB.meta.get('NVDA|1d').first_t === bs[0].t && r.body.known.last_t === bs[bs.length - 1].t);
  W.reset(); W.down.add('alpaca');
  r = await call(env, '/bars?symbol=NVDA&tf=1d&from=2024-01-01&to=2024-03-01', { key: GOOD });
  ok('Alpaca down: Yahoo serves the whole range', r.status === 200 && r.body.provider === 'yahoo' && r.body.bars.length > 30);
  W.down.add('yahoo');
  r = await call(env, '/bars?symbol=NVDA&tf=1d&from=2024-01-01&to=2024-03-01', { key: GOOD });
  ok('Alpaca and Yahoo down: Tiingo, the second source for history', r.status === 200 && r.body.provider === 'tiingo');
  W.down.add('tiingo');
  r = await call(env, '/bars?symbol=NVDA&tf=1d&from=2024-01-01&to=2024-03-01', { key: GOOD });
  ok('everyone down: 503', r.status === 503);
  W.reset(); env = fullEnv();
  r = await call(env, '/bars?symbol=NVDA&tf=1w&from=2024-01-01&to=2024-03-01', { key: GOOD });
  ok('weekly bars are built from daily ones, each stamped on its Monday', r.status === 200 && r.body.bars.length >= 8 && r.body.bars.every((b) => T.nyClock(b.t).dow === 1));
  r = await call(env, '/bars?symbol=NVDA&tf=1mo&from=2023-01-01&to=2024-01-01', { key: GOOD });
  ok('monthly bars start on the 1st', r.body.bars.length >= 12 && r.body.bars.every((b) => T.nyDate(b.t).endsWith('-01')));
  const wk = r.body.bars[0];
  ok('an aggregated bar keeps first open, highest high, lowest low, last close, total volume', wk.h >= wk.o && wk.l <= wk.c && wk.v > 1000);
  W.reset();
  r = await call(env, `/bars?symbol=NVDA&tf=1m&from=${NOW - 3600000}&to=${NOW}`, { key: GOOD });
  const feeds = W.calls.filter((u) => u.includes('alpaca')).map((u) => new URL(u).searchParams.get('feed'));
  ok('intraday up to now: SIP for history, IEX for the newest 15 minutes', r.status === 200 && feeds.includes('sip') && feeds.includes('iex') && r.body.provider === 'alpaca');
  ok('...and the two meet without doubles', r.body.bars.every((b, i, a) => i === 0 || b.t > a[i - 1].t));
  W.reset();
  r = await call(env, `/bars?symbol=NVDA&tf=4h&from=${NOW - 3 * DAY}&to=${NOW}`, { key: GOOD });
  ok('4-hour bars are built from hourly ones on 04:00/08:00/12:00/16:00 New York', r.status === 200 && r.body.bars.length > 0
    && r.body.bars.every((b) => [240, 480, 720, 960].includes(T.nyClock(b.t).minutes)), JSON.stringify(r.body.bars.slice(0, 3).map((b) => T.nyClock(b.t))));
  W.reset(); W.down.add('alpaca');
  r = await call(env, `/bars?symbol=NVDA&tf=1m&from=${NOW - 40 * DAY}&to=${NOW}`, { key: GOOD });
  ok('Yahoo keeps 30 days of 1-minute bars: asked further back, it says the answer is incomplete', r.status === 200 && r.body.provider === 'yahoo' && r.body.complete === false);
  ok('...and asks at most 8 days a request', W.calls.filter((u) => u.includes('/chart/')).every((u) => { const q = new URL(u).searchParams; return q.get('period2') - q.get('period1') <= 7 * 86400 + 1; }));
  r = await call(env, '/bars?symbol=NVDA&tf=2h', { key: GOOD });
  ok('an unknown timeframe: 400', r.status === 400);
  r = await call(env, `/bars?symbol=NVDA&tf=1m&from=${NOW - 90 * DAY}`, { key: GOOD });
  ok('more 1-minute bars than one request may ask for: 400', r.status === 400);
  W.reset(); env = fullEnv();
  const adj = await call(env, '/bars?symbol=NVDA&tf=1d&from=2014-06-01&to=2014-06-20', { key: GOOD });
  const raw = await call(env, '/bars?symbol=NVDA&tf=1d&from=2014-06-01&to=2014-06-20&adj=0', { key: GOOD });
  const before = (x) => x.body.bars.find((b) => T.nyDate(b.t) === '2014-06-06'), after = (x) => x.body.bars.find((b) => T.nyDate(b.t) === '2014-06-10');
  ok('raw bars (adj=0) undo the split before it, and leave bars after it alone', Math.abs(before(raw).c / before(adj).c - 7) < 1e-9 && after(raw).c === after(adj).c);
  ok('closed history is cacheable for good; the open month is not', adj.headers.get('cache-control').includes('immutable')
    && !(await call(env, `/bars?symbol=NVDA&tf=1d&from=${NOW - 5 * DAY}`, { key: GOOD })).headers.get('cache-control').includes('immutable'));

  console.log('\nThe worker\'s bar helpers');
  ok('New York midnight in winter and summer', T.nyMidnight('2026-01-15') === Date.UTC(2026, 0, 15, 5) && T.nyMidnight('2026-07-15') === Date.UTC(2026, 6, 15, 4));
  ok('...and on both days the clocks change', T.nyMidnight('2026-03-08') === Date.UTC(2026, 2, 8, 5) && T.nyMidnight('2026-11-01') === Date.UTC(2026, 10, 1, 4));
  ok('the New York month starts where it should', T.nyMonthStart(Date.UTC(2026, 10, 1, 3)) === T.nyMidnight('2026-10-01'));
  ok('mergeBars keeps the later source for a time', B.mergeBars([{ t: 1, c: 1 }], [{ t: 1, c: 2 }, { t: 0, c: 0 }]).map((b) => b.c).join() === '0,2');
  ok('a bar with a missing price is dropped; missing volume is 0', B.bar(1, 1, 2, 0.5, null, 5) === null && B.bar(1, 1, 2, 0.5, 1.5, null).v === 0);

  console.log('\nCorrections');
  env = fullEnv();
  r = await call(env, '/corrections', { key: GOOD, method: 'POST', body: { items: [{ kind: 'quote', symbol: 'NVDA', field: 'price', old_v: 190, new_v: 168.9, source: 'finnhub', note: 'outlier' }] } });
  ok('a batch of corrections is written', r.status === 200 && r.body.added === 1 && env.DB.corrections.length === 1 && env.DB.corrections[0].source === 'finnhub');
  r = await call(env, '/corrections', { key: GOOD, method: 'POST', body: { items: Array.from({ length: 51 }, () => ({ kind: 'quote' })) } });
  ok('more than 50 at once: 400', r.status === 400);
  r = await call(env, '/corrections', { key: GOOD });
  ok('the log reads back, newest first', r.status === 200 && r.body.corrections.length === 1 && r.body.corrections[0].symbol === 'NVDA');
  r = await call(env, '/corrections', { method: 'POST', body: { items: [{ kind: 'quote' }] } });
  ok('writing corrections needs the key', r.status === 401);

  console.log('\nRead-only toward the broker');
  const fs = require('fs');
  const src = ['worker.js', 'lib/data.js', 'lib/net.js', 'providers/alpaca.js', 'providers/others.js', 'providers/yahoo.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'workers2', 'quant-api', f), 'utf8')).join('\n');
  ok('no order, trading-API or paper-api URL anywhere in the worker', !/\/v2\/orders|paper-api\.alpaca|api\.alpaca\.markets|\/order\b|placeOrder|\/trading\/[^a"]/.test(src));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
