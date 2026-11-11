// quant-api (workers2/quant-api): who may call it, the budget ledger, CORS.
// The worker runs here against a small in-memory stand-in for D1.
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

// The few statements the worker uses, over plain maps.
function fakeDb() {
  const usage = new Map(), health = new Map();
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first() {
      if (/^SELECT 1/.test(sql)) return { one: 1 };
      if (/FROM usage WHERE day = \? AND service = \?/.test(sql)) { const n = usage.get(args[0] + '|' + args[1]); return n == null ? null : { n }; }
      throw new Error('fakeDb.first: ' + sql);
    },
    async all() {
      if (/FROM usage WHERE day = \?/.test(sql)) return { results: [...usage].filter(([k]) => k.startsWith(args[0] + '|')).map(([k, n]) => ({ service: k.split('|')[1], n })).sort((a, b) => a.service.localeCompare(b.service)) };
      if (/FROM provider_health/.test(sql)) return { results: [...health.values()] };
      throw new Error('fakeDb.all: ' + sql);
    },
    async run() {
      if (/^INSERT INTO usage/.test(sql)) { const k = args[0] + '|' + args[1]; usage.set(k, (usage.get(k) || 0) + args[2]); return {}; }
      if (/^INSERT INTO provider_health/.test(sql)) {
        const old = health.get(args[0]) || {};
        health.set(args[0], { provider: args[0], ok: args[1], status: args[2], latency_ms: args[3], detail: args[4], at: args[5], ok_at: args[6] == null ? (old.ok_at || null) : args[6] });
        return {};
      }
      throw new Error('fakeDb.run: ' + sql);
    },
  });
  return { prepare: (sql) => stmt(sql), usage, health };
}

(async () => {
  const W = await import(pathToFileURL(path.join(__dirname, '..', 'workers2', 'quant-api', 'worker.js')).href);
  const GOOD = 'orca_sk_test_good_key_0123456789', OTHER = 'orca_sk_test_other_key_987654321';
  const hash = crypto.createHash('sha256').update(GOOD).digest('hex');
  const call = async (env, p, { key, origin, method } = {}) => {
    const h = {}; if (key) h.authorization = 'Bearer ' + key; if (origin) h.origin = origin;
    const r = await W.default.fetch(new Request('https://quant-api.test' + p, { method: method || 'GET', headers: h }), env, {});
    let body = null; try { body = await r.json(); } catch (e) {}
    return { status: r.status, body, headers: r.headers };
  };

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
  ok('the hash matches Node\'s SHA-256', (await W.sha256Hex(GOOD)) === hash);
  r = await call(env, '/nope', { key: GOOD });
  ok('an unknown route: 404', r.status === 404);

  console.log('\nThe budget ledger');
  env = { DB: fakeDb(), ALLOWED_KEYS: hash };
  ok('a call under the cap is counted', (await W.spend(env, 'alphavantage')) === true && env.DB.usage.get(W.day() + '|alphavantage') === 1);
  for (let i = 0; i < W.CAPS.alphavantage - 1; i++) await W.spend(env, 'alphavantage');
  ok('up to the cap', env.DB.usage.get(W.day() + '|alphavantage') === W.CAPS.alphavantage);
  ok('the call past the cap is refused and not counted', (await W.spend(env, 'alphavantage')) === false && env.DB.usage.get(W.day() + '|alphavantage') === W.CAPS.alphavantage);
  ok('a service with no cap is always counted', (await W.spend(env, 'internal')) === true);
  ok('a model of a service shares the service\'s cap', (await W.spend(env, 'groq:gpt-oss-120b', W.CAPS.groq)) === true && (await W.spend(env, 'groq:gpt-oss-120b')) === false);
  await W.noteHealth(env, 'finnhub', true, 200, 120.4);
  const okAt = env.DB.health.get('finnhub').ok_at;
  await W.noteHealth(env, 'finnhub', false, 429, 80, 'rate limited');
  const h = env.DB.health.get('finnhub');
  ok('health keeps the last answer and when it last worked', h.ok === 0 && h.status === 429 && h.detail === 'rate limited' && h.ok_at === okAt && h.latency_ms === 80);
  r = await call(env, '/usage', { key: GOOD });
  ok('/usage lists today\'s counts with their caps, and health',
    r.status === 200 && r.body.usage.some((u) => u.service === 'alphavantage' && u.n === W.CAPS.alphavantage && u.cap === W.CAPS.alphavantage)
    && r.body.usage.some((u) => u.service === 'internal' && u.cap === null) && r.body.health.length === 1, JSON.stringify(r.body));
  ok('every cap is far under its free tier', W.CAPS.alphavantage < 25 && W.CAPS.fred < 1000 && W.CAPS.groq < 1000);

  console.log('\nCORS');
  r = await call(env, '/health', { origin: 'https://a1-priv.av1.workers.dev' });
  ok('TradeHub\'s origin is allowed', r.headers.get('access-control-allow-origin') === 'https://a1-priv.av1.workers.dev');
  r = await call(env, '/health', { origin: 'https://evil.example' });
  ok('another site gets no allow header', !r.headers.get('access-control-allow-origin'));
  r = await call(env, '/whoami', { origin: 'https://a1-priv.av1.workers.dev', method: 'OPTIONS' });
  ok('a preflight is answered without a key', r.status === 204 && /authorization/.test(r.headers.get('access-control-allow-headers') || ''));
  r = await call(env, '/whoami', { origin: 'https://a1-priv.av1.workers.dev' });
  ok('a refusal still carries the CORS header, so the page can read why', r.status === 401 && r.headers.get('access-control-allow-origin') === 'https://a1-priv.av1.workers.dev');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
