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
  for (const sql of ['0001_lab.sql', '0002_bot_state.sql', '0002_bot_state.sql']) conn.exec(fs.readFileSync(path.join(dir, sql), 'utf8'));
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
