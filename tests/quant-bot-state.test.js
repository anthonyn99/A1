// Neo Cortex N4 authenticated control and journal routes against a SQLite D1 stand-in.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const worker = import('../workers3/quant-bot/worker.js');
const state = import('../workers3/quant-bot/lib/state.js');
const key = 'orca_sk_fixture_n4_state';
const now = Date.parse('2026-11-27T17:00:00Z');

async function fixture(t) {
  const conn = new DatabaseSync(':memory:');
  t.after(() => conn.close());
  const dir = path.join(__dirname, '..', 'workers3/quant-bot/migrations');
  for (const sql of ['0001_lab.sql', '0002_bot_state.sql', '0002_bot_state.sql', '0003_market_context.sql', '0004_kill_latch.sql', '0005_order_intents.sql', '0006_lifecycle.sql', '0007_session_slots.sql']) conn.exec(fs.readFileSync(path.join(dir, sql), 'utf8'));
  function bind(sql, ...args) {
    const query = conn.prepare(sql);
    return {
      bind: (...values) => bind(sql, ...values),
      first: async () => query.get(...args),
      all: async () => ({ results: query.all(...args) }),
      run: async () => ({ meta: query.run(...args) }),
    };
  }
  const DB = {
    prepare: bind,
    batch: async (statements) => {
      conn.exec('BEGIN');
      try {
        const pending = statements.map((statement) => statement.run());
        const result = await Promise.all(pending);
        conn.exec('COMMIT');
        return result;
      } catch (e) {
        conn.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const { default: app, sha256Hex } = await worker;
  const env = { DB, ALLOWED_KEYS: await sha256Hex(key) };
  const request = (p, { secret = key, method = 'GET', body, headers = {} } = {}) =>
    app.fetch(new Request('https://example.com' + p, { method, headers: { ...headers, authorization: 'Bearer ' + secret }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { conn, DB, request };
}

test('requires Tony’s key on worker routes and defaults to shadow', async (t) => {
  const { request } = await fixture(t);
  for (const p of ['/settings', '/state', '/today?day=2026-11-27', '/brief/2026-11-27']) {
    assert.equal((await request(p, { secret: 'no' })).status, 401);
  }
  const settings = await (await request('/settings')).json();
  assert.equal(settings.version, 0);
  assert.equal(settings.settings.mode, 'shadow');
  assert.equal(settings.settings.limits.maxDeployed, 3000);
  assert.equal((await (await request('/state')).json()).shadowSessions, 0);
  assert.equal((await (await request('/brief/2026-11-27')).json()).brief, null);
});

test('Trading reads the dedicated paper account with nested orders, and caches only after authorization', async (t) => {
  const { DB, conn } = await fixture(t);
  const { default: app, sha256Hex } = await worker;
  const { mock } = t;
  const entries = new Map(), expiry = [];
  mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(new URL(url).origin, 'https://paper-api.alpaca.markets');
    assert.equal(opts.method, 'GET');
    assert.equal(opts.headers['APCA-API-KEY-ID'], 'paper-fixture');
    const bodies = {
      '/v2/account': { equity: '100045', last_equity: '100015', cash: '99500', buying_power: '90000' },
      '/v2/positions': [{ symbol: 'NVDA', side: 'long', qty: '4', avg_entry_price: '130', current_price: '135', market_value: '540', unrealized_pl: '20', unrealized_plpc: '0.038', unrealized_intraday_pl: '10' }],
      '/v2/orders?status=open&nested=true&limit=500': [{ id: 'group', symbol: 'NVDA', side: 'buy', status: 'filled', legs: [{ id: 'stop', type: 'stop', stop_price: '120', side: 'sell', status: 'new' }] },
        { id: 'entry', symbol: 'AMD', side: 'buy', type: 'limit', limit_price: '100', qty: '6', filled_qty: '0', status: 'new' }],
    };
    const route = new URL(url);
    assert.ok(Object.hasOwn(bodies, route.pathname + route.search));
    return Response.json(bodies[route.pathname + route.search]);
  });
  mock.property(globalThis, 'caches', { default: {
    async match(req) { return entries.get(req.url)?.clone(); },
    async put(req, res) { expiry.push(res.headers.get('cache-control')); entries.set(req.url, res.clone()); },
  } });
  conn.prepare('UPDATE bot_state SET snapshot = ? WHERE id = 1').run(JSON.stringify({ startingEquity: 100000 }));
  const changes = () => conn.prepare('SELECT total_changes() AS n').get().n;
  const before = changes();
  const env = { DB, ALLOWED_KEYS: await sha256Hex(key), PROBE_KEY: 'probe', BOT_ALPACA_KEY: 'paper-fixture', BOT_ALPACA_SECRET: 'secret-fixture' };
  const read = (secret) => app.fetch(new Request('https://quant-bot.test/account', { headers: secret ? { authorization: 'Bearer ' + secret } : {} }), env);
  assert.equal((await read()).status, 401);
  assert.equal((await read('probe')).status, 401);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  const response = await read(key), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(body.book, { capital: 5000, bp_cap: 3000 });
  assert.deepEqual(body.account, { equity: 5045, cash: 4500, buying_power: 1860, day_pnl: 30, deployed: 1140, booked: true, broker_equity: 100045 });
  assert.deepEqual(body.positions, [{ symbol: 'NVDA', side: 'long', qty: 4, avg: 130, price: 135, value: 540, pnl: 20, pnlPct: 0.038, dayPnl: 10 }]);
  assert.equal(body.orders[0].legs[0].id, 'stop');
  assert.equal((await read()).status, 401);
  assert.deepEqual(await (await read(key)).json(), body);
  assert.equal(globalThis.fetch.mock.callCount(), 3);
  assert.deepEqual(expiry, ['public, max-age=20']);
  assert.equal(changes(), before);
});

test('audits each valid settings version and rejects a stale update or unsafe limit', async (t) => {
  const { DB, request } = await fixture(t);
  const { putSettings } = await state;
  const update = (version, settings, author = 'tony') => ({ version, settings, author, reason: 'Fixture update' });
  assert.equal((await putSettings({ DB }, update(0, { limits: { maxDeployed: 2500 } }), now)).status, 200);
  assert.equal((await putSettings({ DB }, update(0, { paused: true }), now)).status, 409);
  assert.equal((await putSettings({ DB }, update(1, { limits: { maxDeployed: 2800 } }, 'claude'), now)).status, 403);
  // Tony 2026-11-26: the plan's numbers are defaults, not a ceiling; only incoherent limits are refused.
  assert.equal((await putSettings({ DB }, update(1, { limits: { maxDeployed: 6000 } }), now)).status, 400);   // over the $5,000 book
  assert.equal((await putSettings({ DB }, update(1, { limits: { styleShare: { day: -0.2 } } }), now)).status, 400);
  assert.equal((await putSettings({ DB }, update(1, { strategist: { premarket: 'claude_code/haiku' } }), now)).status, 200);
  const read = await (await request('/settings?history=1')).json();
  assert.deepEqual(read.history.map((saved) => saved.version), [2, 1]);
  assert.equal(read.settings.limits.maxDeployed, 2500);
  assert.equal(read.settings.strategist.premarket, 'claude_code/haiku');
  assert.equal((await (await request('/today?day=2026-11-27')).json()).events.length, 2);
});

test('paper needs two shadow sessions and explicit approval from Tony', async (t) => {
  const { DB, conn, request } = await fixture(t);
  const { putSettings } = await state;
  const body = { version: 0, author: 'tony', reason: 'Fixture confirmation', settings: { mode: 'paper' }, confirmPaper: true };
  assert.equal((await putSettings({ DB }, body, now)).status, 409);
  conn.exec("INSERT INTO bot_shadow_sessions (day, checked) VALUES ('2026-11-25', 1), ('2026-11-27', 1)");
  assert.equal((await putSettings({ DB }, { ...body, confirmPaper: false }, now)).status, 409);
  assert.equal((await putSettings({ DB }, { ...body, author: 'claude' }, now)).status, 403);
  assert.equal((await putSettings({ DB }, body, now)).status, 200);
  assert.equal((await (await request('/state')).json()).mode, 'paper');
});

test('journal deduplicates events, filters by time and honors ETags', async (t) => {
  const { DB, request } = await fixture(t);
  const { logEvent } = await state;
  const entry = { kind: 'shadow', key: 'fixture-1', ts: now, symbol: 'NVDA', strategy: 'fixture', version: 1, why: 'The rule fired.' };
  await logEvent(DB, entry);
  await logEvent(DB, entry);
  const url = '/today?day=2026-11-27&since=' + now;
  const first = await request(url);
  const tag = first.headers.get('etag');
  assert.deepEqual((await first.json()).events.map((e) => e.sym), ['NVDA']);
  assert.equal((await request(url, { headers: { 'If-None-Match': tag } })).status, 304);
  await logEvent(DB, { ...entry, key: 'older', ts: now - 60000, symbol: 'AMD' });
  assert.equal((await request(url, { headers: { 'If-None-Match': tag } })).status, 304);
  await logEvent(DB, { ...entry, key: 'newer', ts: now + 60000, symbol: 'AMD' });
  const next = await request(url, { headers: { 'If-None-Match': tag } });
  assert.equal(next.status, 200);
  assert.deepEqual((await next.json()).events.map((e) => e.sym), ['AMD', 'NVDA']);
});

test('N9: /today keeps only the asked kinds, counts the whole day and tags bookkeeping rows', async (t) => {
  const { DB, request } = await fixture(t);
  const now = Date.parse('2026-11-27T15:00:00Z');
  const { logEvent } = await state;
  for (let i = 0; i < 3; i++) await logEvent(DB, { kind: 'shadow', key: 'sh-' + i, ts: now + i, symbol: 'AMD', strategy: 's', version: 1, why: 'would short' });
  await logEvent(DB, { kind: 'entry', key: 'fill-1', ts: now - 5, symbol: 'NVDA', strategy: 's', version: 1, why: 'ORB' });
  await logEvent(DB, { kind: 'stage', key: 'conviction-s-1-2026-11-27', ts: now + 9, strategy: 's', version: 1, why: 'conviction 0.4' });
  await logEvent(DB, { kind: 'stage', key: 'stage-s-1-shadowpass-2026-11-27', ts: now + 10, strategy: 's', version: 1, why: 'passed' });
  const r = await (await request('/today?day=2026-11-27&kinds=entry,stage&counts=1')).json();
  assert.deepEqual(r.events.map((e) => [e.kind, e.tag]), [['stage', null], ['stage', 'conviction'], ['entry', null]]);
  assert.deepEqual(r.counts, { shadow: 3, entry: 1, stage: 2 });
  assert.equal((await request('/today?day=2026-11-27&kinds=entry,bogus')).status, 400);
  const plain = await (await request('/today?day=2026-11-27')).json();
  assert.equal(plain.events.length, 6); assert.equal(plain.counts, undefined);
});


test('a scheduled half-day shadow replay journals the signal and counts one completed session', async (t) => {
  const { DB, conn, request } = await fixture(t);
  conn.exec(fs.readFileSync(path.join(__dirname, '../workers3/quant-bot/migrations/0003_market_context.sql'), 'utf8'));
  const { withDefaults } = await import('../workers3/quant-bot/core/strategy.js');
  const { runShadow } = await import('../workers3/quant-bot/lib/shadow.js');
  const spec = withDefaults({ v: 2, id: 'amd-swing', version: 1, name: 'AMD swing', thesis: 'Fixture thesis',
    horizon: 'swing', timeframe: '1d', side: 'long', maxPositions: 6, universe: { symbols: ['AMD'] },
    entry: { all: [{ ind: 'close', op: '>', than: 100 }] },
    exit: { any: [{ stop: 'percent', value: 2 }, { target: 'r', value: 2 }, { bars: 3 }] },
    sizing: { kind: 'fixedRisk', value: 0.25 } }, { today: '2026-11-27' }).spec;
  conn.prepare('INSERT INTO strategies (id, version, hash, name, stage, spec, gate, edits, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(spec.id, spec.version, 'fixture', spec.name, 'gated', JSON.stringify(spec), '{}', '[]', now, now);
  // N5: a gated strategy is admitted to shadow before the open (09:00-09:30 New York), then evaluated.
  const { admit } = await import('../workers3/quant-bot/lib/lifecycle.js');
  assert.deepEqual(await admit({ DB }, Date.parse('2026-11-27T14:10:00Z')), [['amd-swing', 1, 'shadow']]);
  const open = Date.parse('2026-11-27T14:30:00Z'), close = Date.parse('2026-11-27T18:00:00Z');
  const contextUpdate = { earnings: { AMD: { asOf: open, next: null } } };
  const { putMarketContext } = await import('../workers3/quant-bot/lib/context.js');
  assert.equal((await putMarketContext({ DB }, contextUpdate, open)).status, 200);
  let stamp = open;
  const broker = {
    clock: async () => ({ timestamp: new Date(stamp).toISOString(), is_open: stamp < close }),
    calendar: async () => [{ date: '2026-11-27', open: '09:30', close: '13:00' }],
    account: async () => ({ equity: '100000', last_equity: '100000', buying_power: '100000' }),
    positions: async () => [], orders: async () => [],
  };
  const dispatch = async () => stamp === open + 60000 ? [{ symbol: 'AMD', strategy: spec.id, version: spec.version,
    side: 'long', style: 'swing', stage: 'gated', maxPositions: spec.maxPositions, price: 101, stop: 99,
    why: 'Close above 100 (observed 101).', thesis: spec.thesis, barTime: open - 2 * 86400000 }] : [];
  const replay = (at) => { stamp = at; return runShadow({ DB }, at, dispatch, { broker }); };
  for (let minute = 1; minute < 210; minute += 15) await replay(open + minute * 60000);
  await replay(close);
  await replay(close + 60000);
  const final = await (await request('/state')).json();
  assert.equal(final.mode, 'shadow');
  assert.equal(final.market, 'closed');
  assert.equal(final.equity, 5000);
  assert.equal(final.shadowSessions, 1);
  const all = (await (await request('/today?day=2026-11-27')).json()).events;
  assert.deepEqual(all.map((e) => e.kind), ['shadow', 'stage']);
  const events = all.filter((e) => e.kind === 'shadow');
  assert.equal(events[0].kind, 'shadow');
  assert.equal(events[0].qty, 6);
  assert.match(events[0].why, /observed 101/);
});


test('kill latches before contacting Alpaca and reports every surviving order and position', async (t) => {
  const { DB, request } = await fixture(t);
  const { killBot } = await import('../workers3/quant-bot/lib/kill.js');
  const { putSettings, readBotState } = await state;
  assert.equal((await request('/bot/kill', { method: 'POST', body: { confirm: true }, secret: 'no' })).status, 401);
  assert.equal((await request('/bot/kill', { method: 'POST', body: {} })).status, 400);
  const calls = [];
  let retry = false;
  const broker = {
    cancelAll: async () => {
      calls.push('cancel');
      assert.equal((await readBotState(DB)).killPending, true);
      return [{ status: 200, id: 'canceled' }];
    },
    closeAll: async () => {
      calls.push('close');
      return retry ? [{ status: 200, symbol: 'AMD' }] : [{ status: 500, symbol: 'AMD' }];
    },
    positions: async () => retry ? [] : [{ symbol: 'AMD', qty: '2', side: 'long' }],
    orders: async () => retry ? [] : [{ id: 'still-open', symbol: 'AMD', status: 'accepted' }],
  };
  const failed = await killBot({ DB }, { confirm: true }, { now, broker });
  assert.equal(failed.status, 502);
  const partial = await failed.json();
  assert.deepEqual(calls, ['cancel', 'close']);
  assert.equal(partial.halted, true);
  assert.deepEqual(partial.positions, [{ symbol: 'AMD', qty: '2', side: 'long' }]);
  assert.equal(partial.orders[0].id, 'still-open');
  assert.match(partial.problems[0], /Closing AMD returned 500/);
  const resume = { version: 0, author: 'tony', reason: 'Fixture resume', settings: {}, resume: true };
  assert.equal((await putSettings({ DB }, resume, now)).status, 409);
  retry = true;
  const recovered = await killBot({ DB }, { confirm: true }, { now: now + 60000, broker });
  assert.equal(recovered.status, 200);
  assert.equal((await readBotState(DB)).killPending, false);
  assert.match((await readBotState(DB)).halted, /kill switch/);
  assert.equal((await putSettings({ DB }, resume, now + 120000)).status, 200);
  assert.equal((await readBotState(DB)).halted, null);
});

async function enableFixturePaper(conn, at) {
  const { DEFAULTS } = await state;
  conn.prepare('INSERT INTO bot_settings (version, at, author, reason, body) VALUES (1, ?, ?, ?, ?)').run(at, 'tony', 'Fixture paper mode', JSON.stringify({ ...DEFAULTS, mode: 'paper' }));
}

test('paper submissions use a stable id, reserve the symbol once and stop on the durable latch', async (t) => {
  const { DB, conn } = await fixture(t);
  const { submitEntry, clientId, liveIntents } = await import('../workers3/quant-bot/lib/orders.js');
  const calls = [];
  const venue = {
    submit: async (order) => { calls.push(order); return { id: 'accepted', status: 'new', filled_qty: '0', legs: [] }; },
  };
  const plan = { strategy: 'amd-day', version: 1, symbol: 'AMD', price: 101, stop: 99, target: 105,
    barTime: now - 360000, why: 'Fixture entry condition', thesis: 'Fixture', style: 'day', side: 'long' };
  const row = { spec: { id: plan.strategy } };
  assert.equal((await submitEntry(DB, venue, plan, row, 3, now)).ok, false);
  assert.equal(calls.length, 0);
  await enableFixturePaper(conn, now);
  const first = await submitEntry(DB, venue, plan, row, 3, now);
  assert.deepEqual(first, { ok: true, why: null, id: clientId(plan) });
  assert.equal((await submitEntry(DB, venue, plan, row, 3, now)).ok, false);
  assert.equal((await submitEntry(DB, venue, { ...plan, strategy: 'another-day' }, row, 3, now)).ok, false);
  assert.equal((await liveIntents(DB)).length, 1);
  assert.deepEqual(calls[0], { symbol: 'AMD', qty: '3', side: 'buy', position_intent: 'buy_to_open',
    type: 'limit', time_in_force: 'gtc', client_order_id: clientId(plan), limit_price: '101.00',
    order_class: 'bracket', stop_loss: { stop_price: '99.00' }, take_profit: { limit_price: '105.00' } });
  conn.exec("UPDATE bot_state SET halted = 'stopped' WHERE id = 1");
  assert.equal((await submitEntry(DB, venue, { ...plan, symbol: 'NVDA' }, row, 3, now)).ok, false);
  assert.equal(calls.length, 1);
});

test('reconciles a transport-uncertain entry and records one fill on repeat polling', async (t) => {
  const { DB, conn, request } = await fixture(t);
  await enableFixturePaper(conn, now);
  const { submitEntry, syncIntents, liveIntents } = await import('../workers3/quant-bot/lib/orders.js');
  const plan = { strategy: 'amd-day', version: 1, symbol: 'AMD', price: 101, stop: 99, target: null,
    barTime: now - 300000, why: 'Fixture entry', thesis: 'Fixture', style: 'day', side: 'long' };
  let transportReady = false;
  const venue = {
    submit: async () => { throw new Error('The response was lost'); },
    orderByClient: async () => transportReady ? { id: 'entry', status: 'filled', filled_qty: '1', filled_at: new Date(now).toISOString(), legs: [{ id: 'stop-id' }] } : null,
    fills: async () => [{ id: 'fill-id', symbol: 'AMD', side: 'buy', qty: '1', price: '101', order_id: 'entry', transaction_time: new Date(now).toISOString() }],
  };
  assert.equal((await submitEntry(DB, venue, plan, { spec: { id: 'amd-day' } }, 1, now)).uncertain, true);
  assert.equal((await liveIntents(DB))[0].status, 'reserved');
  transportReady = true;
  await syncIntents(DB, venue, await liveIntents(DB), [{ symbol: 'AMD' }], [], now + 30000);
  await syncIntents(DB, venue, await liveIntents(DB), [{ symbol: 'AMD' }], [], now + 60000);
  assert.equal((await liveIntents(DB))[0].status, 'held');
  const { events } = await (await request('/today?day=2026-11-27')).json();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'entry');
  assert.equal(events[0].price, 101);
});

test('a half-day short flattens at 12:50 even when an evaluation shard fails', async (t) => {
  const { DB, conn, request } = await fixture(t);
  conn.exec(fs.readFileSync(path.join(__dirname, '../workers3/quant-bot/migrations/0003_market_context.sql'), 'utf8'));
  const { submitEntry, liveIntents } = await import('../workers3/quant-bot/lib/orders.js');
  const { paperCycle } = await import('../workers3/quant-bot/lib/paper-cycle.js');
  const at = Date.parse('2026-11-27T17:50:00Z');
  const plan = { strategy: 'amd-short', version: 1, symbol: 'AMD', price: 101, stop: 104, target: null,
    barTime: at - 30 * 60000, why: 'Fixture short', thesis: 'Fixture', style: 'day', side: 'short' };
  const spec = { id: plan.strategy, horizon: 'day', side: 'short' };
  await enableFixturePaper(conn, at);
  await submitEntry(DB, { submit: async () => ({ id: 'parent', status: 'filled', filled_qty: '3', filled_at: new Date(at - 20 * 60000).toISOString(), legs: [] }) }, plan, { spec }, 3, at - 25 * 60000);
  const calls = [];
  const broker = {
    account: async () => ({ equity: '100010', last_equity: '100000', buying_power: '100000' }),
    positions: async () => [{ symbol: 'AMD', side: 'short', qty: '-3', current_price: '100' }],
    orders: async () => [], fills: async () => [],
    close: async (symbol) => { calls.push(symbol); return { id: 'closing' }; },
    submit: async () => assert.fail('the stale research path must not open a new order'),
  };
  const inputs = { now: at, session: { date: '2026-11-27', minutes: 12 * 60 + 50, open: true, half: true, closeMin: 780 },
    rows: [], outcomes: [], exits: [], dataError: 'fixture bars unavailable' };
  const result = await paperCycle({ DB }, inputs, broker, () => at);
  assert.equal(result.skipped, 'stale-data');
  assert.deepEqual(calls, ['AMD']);
  assert.equal((await liveIntents(DB))[0].status, 'closing');
  const { events } = await (await request('/today?day=2026-11-27')).json();
  assert.match(events[0].why, /flatten time/);
});
