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
  for (const sql of ['0001_lab.sql', '0002_bot_state.sql', '0002_bot_state.sql', '0004_kill_latch.sql', '0005_order_intents.sql']) conn.exec(fs.readFileSync(path.join(dir, sql), 'utf8'));
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

test('audits each valid settings version and rejects a stale update or unsafe limit', async (t) => {
  const { DB, request } = await fixture(t);
  const { putSettings } = await state;
  const update = (version, settings, author = 'tony') => ({ version, settings, author, reason: 'Fixture update' });
  assert.equal((await putSettings({ DB }, update(0, { limits: { maxDeployed: 2500 } }), now)).status, 200);
  assert.equal((await putSettings({ DB }, update(0, { paused: true }), now)).status, 409);
  assert.equal((await putSettings({ DB }, update(1, { limits: { maxDeployed: 2800 } }, 'claude'), now)).status, 403);
  assert.equal((await putSettings({ DB }, update(1, { limits: { maxDeployed: 3100 } }), now)).status, 400);
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
  const { events } = await (await request('/today?day=2026-11-27')).json();
  assert.equal(events.length, 1);
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
  const { DB, request } = await fixture(t);
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
