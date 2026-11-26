// Neo Cortex N8 (A1-Priv docs/TradeHub/quant/n4-08.md): the daily brief, against the real quant-bot schema in SQLite.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const worker = import('../workers3/quant-bot/worker.js');
const brief = import('../workers3/quant-bot/lib/brief.js');
const key = 'orca_sk_fixture_n8_brief';
const MON = '2026-11-30', TUE = '2026-12-01', FRI = '2026-12-04', HALF = '2026-11-27';
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
    batch: async (statements) => { conn.exec('BEGIN'); try { const out = []; for (const s of statements) out.push(await s.run()); conn.exec('COMMIT'); return out; } catch (e) { conn.exec('ROLLBACK'); throw e; } },
  };
  const { default: app, sha256Hex } = await worker;
  const env = { DB, ALLOWED_KEYS: await sha256Hex(key) };
  const request = async (p) => { const r = await app.fetch(new Request('https://example.com' + p, { headers: { authorization: 'Bearer ' + key } }), env); return { status: r.status, ...(await r.json()) }; };
  return { conn, DB, env, request };
}
const setMode = (conn, mode) => conn.prepare('INSERT INTO bot_settings (version, at, author, reason, body) VALUES (?,?,?,?,?)').run(1, 1, 'tony', 'fixture', JSON.stringify({ mode }));
const snapshot = (conn, s) => conn.prepare('UPDATE bot_state SET snapshot = ? WHERE id = 1').run(JSON.stringify(s));
function addTrade(conn, id, sym, pnl, at, side = 'long') {
  const cid = `nc-${id}-1-${sym}-${at}`;
  conn.prepare("INSERT INTO bot_order_intents (client_id,symbol,strategy,version,side,style,qty,entry_price,stop,target,bar_time,requested,status,why,spec) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(cid, sym, id, 1, side, 'day', 1, 100, 90, 120, at, at, 'closed', 'fixture', '{}');
  const open = side === 'long' ? 'buy' : 'sell', close = side === 'long' ? 'sell' : 'buy';
  conn.prepare('INSERT INTO bot_fills (id,client_id,ts,qty,price,side) VALUES (?,?,?,?,?,?)').run('o' + cid, cid, at, 1, 100, open);
  conn.prepare('INSERT INTO bot_fills (id,client_id,ts,qty,price,side) VALUES (?,?,?,?,?,?)').run('c' + cid, cid, at + 60000, 1, side === 'long' ? 100 + pnl : 100 - pnl, close);
}
const spyBroker = (prev, close, day) => ({ bars: async () => ({ SPY: [[Date.parse(`${'2026-11-27'}T05:00:00Z`), 1, 1, 1, prev, 1], [Date.parse(`${day}T05:00:00Z`), 1, 1, 1, close, 1]] }) });
const read = (conn, day) => { const r = conn.prepare('SELECT body FROM bot_briefs WHERE day = ?').get(day); return r ? JSON.parse(r.body) : null; };

test('numbers wait for the close + 20 and come from code: P&L, SPY, trades, best and worst, risk used, changes', async (t) => {
  const { briefTick } = await brief;
  const { conn, env } = await fixture(t);
  setMode(conn, 'paper');
  snapshot(conn, { date: MON, equity: 5084.2, dayPnl: 84.2, deployed: 0, deployedPeak: 1940 });
  addTrade(conn, 'orb', 'AMD', 31.8, ny(MON, '09:47'));
  addTrade(conn, 'orb', 'NVDA', -12.5, ny(MON, '11:00'));
  addTrade(conn, 'vwap', 'XOM', 12.4, ny(MON, '10:12'), 'short');
  addTrade(conn, 'orb', 'MU', 50, ny(TUE, '10:00'));   // another day: not counted
  conn.prepare("INSERT INTO bot_events (event_key, ts, day, kind, strategy, version, why) VALUES (?,?,?,?,?,?,?)").run('stage-gap-fade-1-killed-' + ny(MON, '16:05'), ny(MON, '16:05'), MON, 'stage', 'gap-fade', 1, 'Killed: best case 38% won');
  conn.prepare("INSERT INTO bot_events (event_key, ts, day, kind, strategy, version, why) VALUES (?,?,?,?,?,?,?)").run('conviction-orb-1-' + MON, ny(MON, '16:05'), MON, 'stage', 'orb', 1, 'Conviction 0.10 → 0.30');
  const opts = { broker: spyBroker(600, 602.46, MON) };
  assert.equal(await briefTick(env, ny(MON, '16:19'), opts), null);
  assert.equal(read(conn, MON), null);
  assert.equal(await briefTick(env, ny(MON, '16:20'), opts), 'numbers');
  const b = read(conn, MON);
  assert.equal(b.pnl, 84.2); assert.equal(b.pnlPct, 1.68); assert.equal(b.spyPct, 0.41); assert.equal(b.vsSpy, 1.27);
  assert.equal(b.trades, 3); assert.equal(b.wins, 2); assert.equal(b.pf, 3.5);
  assert.equal(b.best.symbol, 'AMD'); assert.equal(b.worst.symbol, 'NVDA');
  assert.equal(b.deployedPeak, 1940); assert.equal(b.riskUsedPct, 64.67);
  assert.deepEqual(b.changes, [{ id: 'gap-fade', stage: 'killed', why: 'Killed: best case 38% won' }]);   // conviction updates are not changes
  assert.deepEqual(b.perStrategy.map((s) => [s.id, s.trades, s.pnl]).sort(), [['orb', 2, 19.3], ['vwap', 1, 12.4]]);
  assert.equal(b.ready, false);
  assert.match(b.headline, /^Up \$84\.20 \(\+1\.68%\) vs SPY \+0\.41% · 3 trades, 2 won\.$/);
  assert.equal(await briefTick(env, ny(MON, '16:21'), opts), null);   // waiting for Claude: no write
});

test('Claude\'s post-close run merges in and makes it ready; a failed or missing run gives the template at 17:15', async (t) => {
  const { briefTick } = await brief;
  const { conn, env } = await fixture(t);
  setMode(conn, 'paper');
  snapshot(conn, { date: MON, equity: 5000, dayPnl: 0 });
  const opts = { broker: spyBroker(600, 600, MON) };
  await briefTick(env, ny(MON, '16:20'), opts);
  conn.prepare("INSERT INTO lab_runs (id, session, day, model, started, ended, outcome, summary, results) VALUES (?,?,?,?,?,?,?,?,?)")
    .run('r1', 'postclose', MON, 'claude_code/sonnet', ny(MON, '16:25'), ny(MON, '16:31'), 'ok', 'Semis lead; CPI tomorrow, half size until 10:00.',
      JSON.stringify([{ id: 'orb2', name: 'Semis ORB v2', pass: true }, { id: 'bad', pass: false }, { retire: 'gap-fade', why: 'no edge' }]));
  assert.equal(await briefTick(env, ny(MON, '16:32'), opts), 'ready');
  const b = read(conn, MON);
  assert.equal(b.ready, true); assert.equal(b.claude, true);
  assert.equal(b.commentary, 'Semis lead; CPI tomorrow, half size until 10:00.');
  assert.deepEqual(b.lineup, [{ id: 'orb2', name: 'Semis ORB v2' }]);
  assert.deepEqual(b.retired, [{ id: 'gap-fade', why: 'no edge' }]);
  assert.equal(await briefTick(env, ny(MON, '16:40'), opts), null);   // ready: nothing more

  const two = await fixture(t);
  setMode(two.conn, 'paper');
  await briefTick(two.env, ny(TUE, '16:20'), opts);
  two.conn.prepare("INSERT INTO lab_runs (id, session, day, started, ended, outcome, summary) VALUES (?,?,?,?,?,?,?)").run('r2', 'postclose', TUE, 1, ny(TUE, '16:26'), 'failed', 'Strategist did not run: ORCA is not answering');
  assert.equal(await briefTick(two.env, ny(TUE, '17:14'), opts), null);   // a failed run waits for the deadline too
  assert.equal(await briefTick(two.env, ny(TUE, '17:15'), opts), 'ready');
  const f = read(two.conn, TUE);
  assert.equal(f.claude, false);
  assert.match(f.commentary, /^Strategist did not run \(ORCA is not answering\)\./);

  const three = await fixture(t);
  setMode(three.conn, 'shadow');
  three.conn.prepare("INSERT INTO bot_events (event_key, ts, day, kind, why) VALUES (?,?,?,?,?)").run('s1', ny(TUE, '10:00'), TUE, 'shadow', 'would buy');
  assert.equal(await briefTick(three.env, ny(TUE, '17:20'), opts), 'ready');   // past the deadline at once: numbers and template together
  const s = read(three.conn, TUE);
  assert.equal(s.pnl, null); assert.equal(s.shadow.decisions, 1);
  assert.equal(s.headline, 'Shadow day: 1 decision logged, no orders sent.');
  assert.match(s.commentary, /no post-close run reached the bot/);
});

test('a half day writes at 13:20; Friday carries the week; GET /briefs lists the history', async (t) => {
  const { briefTick, lastOfWeek, rollup } = await brief;
  assert.equal(lastOfWeek(FRI), true); assert.equal(lastOfWeek(TUE), false);
  assert.equal(lastOfWeek('2026-12-24'), true);   // Christmas Friday closed: Thursday ends the week
  const { conn, env, request } = await fixture(t);
  setMode(conn, 'paper');
  const opts = { broker: spyBroker(600, 600, HALF) };
  assert.equal(await briefTick(env, ny(HALF, '13:19'), opts), null);
  assert.equal(await briefTick(env, ny(HALF, '13:20'), opts), 'numbers');
  for (const [day, pnl, trades, wins, gw, gl] of [[MON, 40, 2, 1, 50, 10], [TUE, -20, 1, 0, 0, 20]]) {
    conn.prepare('INSERT INTO bot_briefs (day, at, body) VALUES (?,?,?)').run(day, 1, JSON.stringify({ day, pnl, trades, wins, grossWin: gw, grossLoss: gl, ready: true, headline: 'h ' + day,
      best: { symbol: 'AMD', pnl: 50 }, worst: { symbol: 'NVDA', pnl: -20 }, perStrategy: [{ id: 'orb', trades, wins, pnl }] }));
  }
  snapshot(conn, { date: FRI, dayPnl: 10 });
  addTrade(conn, 'orb', 'AMD', 10, ny(FRI, '10:00'));
  await briefTick(env, ny(FRI, '17:15'), { broker: spyBroker(600, 600, FRI) });
  const w = read(conn, FRI).week;
  assert.equal(w.from, MON); assert.equal(w.to, FRI); assert.equal(w.days, 3);
  assert.equal(w.pnl, 30); assert.equal(w.trades, 4); assert.equal(w.wins, 2); assert.equal(w.pf, 2);
  assert.equal(w.best.pnl, 50); assert.equal(w.worst.pnl, -20);
  assert.deepEqual(w.perStrategy, [{ id: 'orb', trades: 4, wins: 2, pnl: 30 }]);
  assert.equal(rollup([]).winRate, null);
  const list = await request('/briefs?limit=10');
  assert.equal(list.status, 200);
  assert.deepEqual(list.briefs.map((x) => x.day), [FRI, TUE, MON, HALF]);
  assert.equal(list.briefs[0].week, true);
  assert.equal((await request('/brief/' + FRI)).brief.week.trades, 4);
});

test('the snapshot keeps the day\'s deployed peak and resets it on a new day', async () => {
  const { deployedOf } = await import('../workers3/quant-bot/lib/reconcile.js');
  const book = (usd) => ({ positions: usd ? [{ sym: 'AMD', side: 'long', qty: 1, price: usd }] : [], pending: [] });
  assert.deepEqual(deployedOf(book(500), { date: MON, deployedPeak: 900 }, MON), { deployed: 500, deployedPeak: 900 });
  assert.deepEqual(deployedOf(book(1200), { date: MON, deployedPeak: 900 }, MON), { deployed: 1200, deployedPeak: 1200 });
  assert.deepEqual(deployedOf(book(0), { date: MON, deployedPeak: 900 }, TUE), { deployed: 0, deployedPeak: 0 });
});
