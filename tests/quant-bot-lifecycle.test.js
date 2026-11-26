// Neo Cortex N5 (A1-Priv docs/TradeHub/quant/n4-05.md): strategy lifecycle and the learning loop, against the
// real quant-bot schema in SQLite (the D1 stand-in of quant-bot-state.test.js).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const worker = import('../workers3/quant-bot/worker.js');
const life = import('../workers3/quant-bot/lib/lifecycle.js');
const key = 'orca_sk_fixture_n5_life';
const FRI = '2026-11-27', MON = '2026-11-30';
const ny = (day, hhmm) => Date.parse(`${day}T${hhmm}:00-05:00`);

async function fixture(t) {
  const conn = new DatabaseSync(':memory:');
  t.after(() => conn.close());
  const dir = path.join(__dirname, '..', 'workers3/quant-bot/migrations');
  for (const sql of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) conn.exec(fs.readFileSync(path.join(dir, sql), 'utf8'));
  function bind(sql, ...args) {
    const query = conn.prepare(sql);
    return { bind: (...values) => bind(sql, ...values), first: async () => query.get(...args), all: async () => ({ results: query.all(...args) }), run: async () => ({ meta: query.run(...args) }) };
  }
  const DB = {
    prepare: bind,
    batch: async (statements) => {
      conn.exec('BEGIN');
      try { const out = []; for (const s of statements) out.push(await s.run()); conn.exec('COMMIT'); return out; } catch (e) { conn.exec('ROLLBACK'); throw e; }
    },
  };
  const { default: app, sha256Hex } = await worker;
  const env = { DB, ALLOWED_KEYS: await sha256Hex(key) };
  const request = async (p, { method = 'GET', body } = {}) => {
    const r = await app.fetch(new Request('https://example.com' + p, { method, headers: { authorization: 'Bearer ' + key }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: r.status, ...(await r.json()) };
  };
  return { conn, DB, env, request };
}

function spec(id, version = 1, extra = {}) {
  return { v: 2, id, version, name: id, thesis: 'fixture', horizon: 'day', timeframe: '5m', side: 'long', maxPositions: 2,
    universe: { symbols: ['AMD'] }, entry: { all: [{ ind: 'close', op: '>', than: { ind: 'vwap' } }] },
    exit: { any: [{ stop: 'atr', value: 1.5 }, { target: 'r', value: 2 }] }, sizing: { kind: 'conviction', min: 0.25, max: 1 },
    window: { start: '09:35', end: '15:30' }, flattenBy: null, earningsBlackout: true, from: 'max', to: FRI, rebalance: 'none',
    costs: { slippageCents: 1, fees: 'webull' }, benchmark: 'SPY', ...extra };
}
function addStrategy(conn, id, { version = 1, stage = 'gated', at = 1, report = { expectancyR: 0.3, trades: 80 } } = {}) {
  const s = spec(id, version);
  conn.prepare('INSERT INTO strategies (id, version, hash, name, stage, spec, gate, edits, report, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, version, 'h-' + id + version, id, stage, JSON.stringify(s), '{"pass":true}', '[]', JSON.stringify(report), at, at);
}
const stageOf = (conn, id, version = 1) => conn.prepare('SELECT stage FROM strategies WHERE id = ? AND version = ?').get(id, version).stage;
/** One closed paper trade: risk $10 a share x 1 share, P&L `pnl`. */
function addTrade(conn, id, n, pnl, { version = 1, at = ny(FRI, '10:00') } = {}) {
  const cid = `nc-${id}-${version}-AMD-${at + n}`;
  conn.prepare("INSERT INTO bot_order_intents (client_id,symbol,strategy,version,side,style,qty,entry_price,stop,target,bar_time,requested,status,why,spec) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(cid, 'AMD', id, version, 'long', 'day', 1, 100, 90, 120, at + n, at + n, 'closed', 'fixture', '{}');
  conn.prepare('INSERT INTO bot_fills (id,client_id,ts,qty,price,side) VALUES (?,?,?,?,?,?)').run('f-o-' + cid, cid, at + n, 1, 100, 'buy');
  conn.prepare('INSERT INTO bot_fills (id,client_id,ts,qty,price,side) VALUES (?,?,?,?,?,?)').run('f-c-' + cid, cid, at + n + 1, 1, 100 + pnl, 'sell');
}

test('wilson bound, conviction and the trial rules are pure numbers', async () => {
  const { wilsonUpper, convictionOf, trialVerdict, lifeSettings } = await life;
  assert.ok(Math.abs(wilsonUpper(1, 12) - 0.297) < 0.01);
  assert.equal(wilsonUpper(0, 0), 1);
  assert.deepEqual(convictionOf({ rTrades: 0, sumR: 0 }, 0.3), { conviction: 0, e: 0.15, ePaper: null });
  const c = convictionOf({ rTrades: 15, sumR: 6 }, 0.3);
  assert.equal(c.e, 0.257); assert.equal(c.conviction, 0.643);
  assert.equal(convictionOf({ rTrades: 40, sumR: 40 }, 0.3).conviction, 1);
  assert.equal(convictionOf({ rTrades: 20, sumR: -10 }, 0.3).conviction, 0);
  const L = lifeSettings();
  assert.equal(trialVerdict({ trades: 4, wins: 3, winRate: 0.75, pf: 3 }, 4, L), null);
  assert.equal(trialVerdict({ trades: 15, wins: 9, winRate: 0.6, pf: 1.4 }, 6, L).stage, 'active');
  assert.equal(trialVerdict({ trades: 6, wins: 2, winRate: 0.33, pf: 0.7 }, 5, L).stage, 'retired');
  assert.match(trialVerdict({ trades: 2, wins: 1, winRate: 0.5, pf: 1 }, 20, L).why, /too rare/);
});

test('admission: slots, newest first, a newer version replaces the older, idempotent, reshadow without a verdict', async (t) => {
  const { conn, env } = await fixture(t);
  const { admit, liveStrategies } = await life;
  for (let i = 0; i < 7; i++) addStrategy(conn, 'strat-' + i, { at: 100 + i });
  const moved = await admit(env, ny(FRI, '09:05'));
  assert.equal(moved.length, 6);
  assert.equal(stageOf(conn, 'strat-0'), 'gated');           // the oldest waits: six slots
  assert.equal(stageOf(conn, 'strat-6'), 'shadow');
  assert.deepEqual(await admit(env, ny(FRI, '09:06')), []);  // idempotent
  const live = await liveStrategies(env.DB);
  assert.equal(live.length, 6);
  assert.ok(live.every((r) => r.stage === 'shadow' && r.conviction === 0));
  // a new version of a running strategy takes its slot without waiting
  conn.prepare("UPDATE strategies SET stage = 'paper' WHERE id = 'strat-6'").run();
  addStrategy(conn, 'strat-6', { version: 2, at: 500 });
  const next = await admit(env, ny(MON, '09:10'));
  assert.deepEqual(next.filter((m) => m[0] === 'strat-6'), [['strat-6', 1, 'retired'], ['strat-6', 2, 'shadow']]);
  assert.ok(next.some((m) => m[2] === 'shadow again'));        // Friday's shadows had no verdict
  assert.equal(stageOf(conn, 'strat-0'), 'gated');
  const ev = conn.prepare("SELECT why FROM bot_events WHERE kind = 'stage' AND strategy = 'strat-6' ORDER BY id").all().map((r) => r.why);
  assert.match(ev.at(-2), /Replaced by version 2/);
  // a gated version under a newer gated version is superseded
  addStrategy(conn, 'strat-x', { version: 1, at: 600 }); addStrategy(conn, 'strat-x', { version: 2, at: 601 });
  conn.prepare("UPDATE strategies SET stage = 'retired' WHERE id = 'strat-5'").run();
  const third = await admit(env, ny(MON, '09:20'));
  assert.ok(third.some((m) => m[0] === 'strat-x' && m[1] === 1 && m[2] === 'retired'));
  assert.equal(stageOf(conn, 'strat-x', 2), 'shadow');
});

test('replay: a matching shadow day goes to paper, a disagreement shadows again, a second one retires, an error day fails', async (t) => {
  const { conn, env, request } = await fixture(t);
  const { admit } = await life;
  for (const id of ['good-one', 'bad-one', 'err-one']) addStrategy(conn, id);
  await admit(env, ny(FRI, '09:05'));
  const res = await request('/lifecycle/replay', { method: 'POST', body: { day: FRI, results: [
    { id: 'good-one', version: 1, signals: 10, matched: 9, missedLive: 1, extraLive: 0 },
    { id: 'bad-one', version: 1, signals: 10, matched: 5, missedLive: 3, extraLive: 2 },
  ] } });
  assert.equal(res.status, 200);
  assert.equal(stageOf(conn, 'good-one'), 'paper');
  assert.equal(stageOf(conn, 'bad-one'), 'shadow');
  assert.equal((await request('/lifecycle/replay', { method: 'POST', body: { day: FRI, results: [{ id: 'good-one', version: 1, signals: 0, matched: 0, missedLive: 0, extraLive: 0 }] } })).results[0].already, true);
  await admit(env, ny(MON, '09:05'));
  await request('/lifecycle/replay', { method: 'POST', body: { day: MON, results: [{ id: 'bad-one', version: 1, signals: 4, matched: 1, missedLive: 3, extraLive: 0 }] } });
  assert.equal(stageOf(conn, 'bad-one'), 'retired');
  // a broker error that day fails the shadow even when the decisions agree
  conn.prepare("INSERT INTO bot_events (event_key, ts, day, kind, why) VALUES ('broker-guard-2026-11-30-1', 1, ?, 'guard', 'three errors')").run(MON);
  await request('/lifecycle/replay', { method: 'POST', body: { day: MON, results: [{ id: 'err-one', version: 1, signals: 0, matched: 0, missedLive: 0, extraLive: 0 }] } });
  assert.equal(stageOf(conn, 'err-one'), 'shadow');
  assert.equal(conn.prepare("SELECT shadow_fails FROM strategy_life WHERE id = 'err-one'").get().shadow_fails, 1);
  assert.equal((await request('/lifecycle/replay', { method: 'POST', body: { day: MON, results: [{ id: 'x', version: 1, signals: 1, matched: 2, missedLive: 0, extraLive: 0 }] } })).status, 400);
});

test('review: keep, retire, three kill rules, conviction logged, once a day and only after the close', async (t) => {
  const { conn, env, request } = await fixture(t);
  const { review } = await life;
  for (const id of ['keeper', 'loser', 'coldhand', 'deepdd', 'drifter']) { addStrategy(conn, id, { stage: 'paper' }); }
  conn.prepare("UPDATE strategies SET stage = 'active' WHERE id = 'drifter'").run();
  for (let i = 0; i < 15; i++) addTrade(conn, 'keeper', i, i < 10 ? 10 : -5);       // 67%, PF 4, +0.50 R a trade
  for (let i = 0; i < 15; i++) addTrade(conn, 'loser', i, i < 6 ? 5 : -5);         // 40%, PF 0.67: Wilson upper 61% (no kill)
  for (let i = 0; i < 12; i++) addTrade(conn, 'coldhand', i, i < 1 ? 5 : -2);      // 1 of 12: upper 30% < 40%
  for (let i = 0; i < 3; i++) addTrade(conn, 'deepdd', i, -45);                    // -$135 > 8% of the $1,500 day sleeve
  assert.equal(await review(env, ny(FRI, '12:59')), null);   // before the half day's close + 5
  const out = await review(env, ny(FRI, '13:06'));
  assert.equal(out.strategies.length, 5);
  assert.equal(stageOf(conn, 'keeper'), 'active');
  assert.equal(stageOf(conn, 'loser'), 'retired');
  assert.equal(stageOf(conn, 'coldhand'), 'killed');
  assert.equal(stageOf(conn, 'deepdd'), 'killed');
  assert.equal(stageOf(conn, 'drifter'), 'active');
  assert.equal(await review(env, ny(FRI, '13:30')), null);   // once a day
  const keeper = conn.prepare("SELECT * FROM strategy_life WHERE id = 'keeper'").get();
  assert.equal(keeper.trades, 15); assert.equal(keeper.wins, 10); assert.equal(keeper.paper_days, 1);
  assert.ok(keeper.conviction > 0.5);
  const why = conn.prepare("SELECT why FROM bot_events WHERE kind = 'stage' AND strategy = 'keeper' ORDER BY id").all().map((r) => r.why);
  assert.match(why[0], /Conviction 0\.00 → 0\.\d\d: 15 paper trades at 0\.50 R, backtest 0\.30 R, shrunk to 0\.30 R/);
  assert.match(why[1], /Kept after its trial/);
  assert.match(conn.prepare("SELECT why FROM strategy_life WHERE id = 'coldhand'").get().why, /90% upper bound 29\.\d%/);
  assert.match(conn.prepare("SELECT why FROM strategy_life WHERE id = 'deepdd'").get().why, /\$135\.00 from its peak, over 8% of its \$1500 sleeve/);
  // the drift rule: an active strategy whose live decisions disagree on over 25% of 10+ signals
  await request('/lifecycle/replay', { method: 'POST', body: { day: FRI, results: [{ id: 'drifter', version: 1, signals: 12, matched: 8, missedLive: 4, extraLive: 0 }] } });
  assert.equal(stageOf(conn, 'drifter'), 'killed');
  const view = await request('/lifecycle');
  const k = view.strategies.find((s) => s.id === 'keeper');
  assert.equal(k.trades, 15); assert.ok(Math.abs(k.winRate - 2 / 3) < 1e-9); assert.equal(k.pf, 4); assert.equal(k.backtest.expectancyR, 0.3);
  assert.equal(view.review.day, FRI);
  assert.ok(view.setups.length >= 1);
});

test('stage route: Tony any, Claude retire only, Neo pause only; resume returns to the prior stage', async (t) => {
  const { conn, request } = await fixture(t);
  addStrategy(conn, 'mover', { stage: 'active' });
  const stage = (author, s, why = 'fixture') => request('/strategies/stage', { method: 'POST', body: { id: 'mover', stage: s, why, author } });
  assert.equal((await stage('claude', 'paused')).status, 403);
  assert.equal((await stage('neo', 'retired')).status, 403);
  assert.equal((await stage('neo', 'paused', 'Tony asked in chat')).status, 200);
  assert.equal(stageOf(conn, 'mover'), 'paused');
  assert.equal((await stage('neo', 'paused')).status, 409);
  assert.equal((await stage('tony', 'resume')).stage, 'active');
  assert.equal(stageOf(conn, 'mover'), 'active');
  assert.equal((await stage('tony', 'resume')).status, 409);
  assert.equal((await stage('claude', 'retired', 'thesis broken: regime turned risk-off')).status, 200);
  assert.equal(stageOf(conn, 'mover'), 'retired');
  assert.match(conn.prepare("SELECT why FROM strategy_life WHERE id = 'mover'").get().why, /Claude: thesis broken/);
  assert.equal((await stage('tony', 'killed')).status, 404);
  assert.equal((await request('/strategies/stage', { method: 'POST', body: { id: 'mover', stage: 'paused', author: 'bob', why: 'x' } })).status, 400);
});

test('settings: Tony changes the lifecycle rules inside their ranges; Claude cannot', async (t) => {
  const { request } = await fixture(t);
  const put = (author, lifecycle, version) => request('/settings', { method: 'PUT', body: { version, author, reason: 'fixture', settings: { lifecycle } } });
  const before = await request('/settings');
  assert.equal(before.settings.lifecycle.keep.minPF, 1.1);
  assert.equal((await put('tony', { maxLive: 7 }, 0)).status, 400);
  assert.equal((await put('tony', { keep: { minTrades: 2.5 } }, 0)).status, 400);
  assert.equal((await put('claude', { maxLive: 4 }, 0)).status, 403);
  const ok = await put('tony', { maxLive: 4, kill: { sleeveDD: 6 } }, 0);
  assert.equal(ok.status, 200);
  const after = await request('/settings');
  assert.equal(after.settings.lifecycle.maxLive, 4);
  assert.equal(after.settings.lifecycle.kill.sleeveDD, 6);
  assert.equal(after.settings.lifecycle.kill.wilsonUpper, 40);
});

test('fires: shadow and post-fire skip events and paper intents, by bar, for the PC replay', async (t) => {
  const { conn, DB, request } = await fixture(t);
  const { logEvent } = await import('../workers3/quant-bot/lib/state.js');
  const bar = ny(FRI, '10:00');
  await logEvent(DB, { key: 'a', ts: bar + 360000, kind: 'shadow', strategy: 's-one', version: 1, symbol: 'AMD', why: 'fired', barTime: bar, fired: true });
  await logEvent(DB, { key: 'b', ts: bar + 360000, kind: 'skip', strategy: 's-one', version: 1, symbol: 'NVDA', why: 'cap', barTime: bar, fired: true });
  await logEvent(DB, { key: 'c', ts: bar + 360000, kind: 'skip', strategy: 's-one', version: 1, symbol: 'TSLA', why: 'No fresh closed 5m bar', barTime: bar, fired: false });
  addTrade(conn, 's-two', 0, 5, { at: bar });
  const { fires } = await request('/lifecycle/fires?day=' + FRI);
  assert.deepEqual(fires.map((f) => f.strategy + ':' + f.symbol).sort(), ['s-one:AMD', 's-one:NVDA', 's-two:AMD']);
  assert.equal((await request('/lifecycle/fires?day=nope')).status, 400);
});
