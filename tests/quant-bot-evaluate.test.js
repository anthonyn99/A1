// Signal evaluation and sizing on the worker's closed-bar inputs. No broker writes.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const worker = import('../workers3/quant-bot/worker.js');
const evaluate = import('../workers3/quant-bot/lib/evaluate.js');
const context = import('../workers3/quant-bot/lib/context.js');
const market = import('../workers3/quant-bot/lib/market.js');
const strategy = import('../workers3/quant-bot/core/strategy.js');
const ny = (day, time) => Date.parse(day + 'T' + time + ':00-05:00');
const friday = '2026-11-27';

async function sessions() {
  const { synthBars } = await worker;
  const { nyMidnight } = await import('../workers3/quant-bot/core/clock.js');
  return synthBars(1, 78 * 25, ny('2026-11-25', '09:30')).S00.map((bar, i) => ({ ...bar,
    t: nyMidnight(new Date(bar.t).toISOString().slice(0, 10)) + (570 + 5 * (i % 78)) * 60000 }));
}

test('the daily baseline exactly reproduces the full-series relative-volume calculation', async () => {
  const { minuteVolume, withVolume, objects } = await market;
  const { relVolumeIntraday } = await import('../workers3/quant-bot/core/indicators.js');
  // A longer recording, excluding Thanksgiving and incomplete market bars.
  const closed = await sessions();
  const tuple = (b) => [b.t, b.o, b.h, b.l, b.c, b.v];
  const old = closed.map(tuple);
  const today = [0, 1, 2, 3, 4].map((i) => [ny(friday, '09:30') + i * 300000, 100, 101, 99, 100, 10000 + i]);
  const calculated = withVolume(objects(today), friday, minuteVolume(old, friday));
  const full = relVolumeIntraday(objects([...old, ...today]));
  assert.ok(calculated.every((b) => Number.isFinite(b.closedRvol)));
  assert.deepEqual(calculated.map((b) => b.closedRvol), full.slice(-today.length));
});

test('batches up to ten symbols and sizes a fresh signal against the common risk book', async () => {
  const { candidate, shardsFor, checkCandidate } = await evaluate;
  const { withDefaults } = await strategy;
  const session = { date: friday, minutes: 10 * 60 + 6, openMin: 570, closeMin: 780, half: true };
  const { synthBars } = await worker;
  const { S00: earlier } = synthBars(1, 90, ny('2026-11-25', '09:30'));
  const latest = Array.from({ length: 7 }, (_, i) => ({ ...earlier.at(-1), t: ny(friday, '09:30') + i * 300000, c: 51 }));
  const spec = withDefaults({ id: 'fixture', name: 'Fixture day', horizon: 'day', timeframe: '5m',
    universe: { symbols: ['AMD'] }, side: 'long', entry: { all: [{ ind: 'close', op: '>', than: 1 }] },
    exit: { any: [{ stop: 'percent', value: 2 }, { target: 'r', value: 2 }] } }, { today: friday }).spec;
  const now = ny(friday, '10:06');
  const row = { id: 'fixture', version: 1, stage: 'gated', spec };
  const input = { bars: { '5m': { AMD: [...earlier, ...latest] } } };
  const signal = candidate(row, 'AMD', input, { now, session });
  assert.equal(signal.price, 51);
  assert.equal(signal.stop, 49.98);
  assert.match(signal.why, /observed 51.*stop \$49\.98/);
  assert.deepEqual(shardsFor([{ spec: { universe: { symbols: Array.from({ length: 29 }, (_, i) => 'S' + i) } } }]).map((s) => s.length), [10, 10, 9]);
  const risk = { equity: 5000, peak: 5000, dayPnl: 0, positions: [] };
  // N5: a fixed-risk spec risks its own value (1% here, capped by the $1,500 position cap); a conviction spec risks
  // its band by the strategy's measured conviction (0 = the floor).
  assert.equal(checkCandidate(signal, risk, undefined, { session }).qty, 29);
  const band = { ...spec, sizing: { kind: 'conviction', min: 0.25, max: 1 } };
  assert.equal(checkCandidate(candidate({ ...row, spec: band, conviction: 0 }, 'AMD', input, { now, session }), risk, undefined, { session }).qty, 12);
  assert.equal(checkCandidate(candidate({ ...row, spec: band, conviction: 0.5 }, 'AMD', input, { now, session }), risk, undefined, { session }).qty, 29);
  assert.equal(candidate({ ...row, spec: band, conviction: 0.5 }, 'AMD', input, { now, session }).riskPct, 0.625);
  assert.equal(checkCandidate(signal, risk, undefined, { session, earningsSoon: true }).ok, false);
  assert.match(checkCandidate(signal, { ...risk, positions: [{ sym: 'AMD', strategy: 'someone-else', qty: 1, price: 51, style: 'day', side: 'long' }] }, undefined, { session }).why, /one strategy per symbol/);
  assert.match(candidate(row, 'AMD', input, { now: now + 15 * 60000, session }).skip, /No fresh/);
});

test('the calendar refuses unknown inputs and skips weekends between earnings and the next entry day', async () => {
  const { earningsGuard } = await context;
  const now = ny(friday, '10:00');
  const rows = { AMD: { asOf: now, next: '2026-11-30' }, NVDA: { asOf: now, next: '2026-12-01' }, SPY: { asOf: now, next: null } };
  assert.deepEqual(earningsGuard(rows, 'AMD', friday, now), { known: true, soon: true });
  assert.deepEqual(earningsGuard(rows, 'NVDA', friday, now), { known: true, soon: false });
  assert.deepEqual(earningsGuard(rows, 'SPY', friday, now), { known: true, soon: false });
  assert.equal(earningsGuard(rows, 'META', friday, now).known, false);
  assert.equal(earningsGuard(rows, 'AMD', friday, now + 37 * 3600000).known, false);
});


test('the cached opening-range decision agrees with the full evaluator across 25 prior sessions', async () => {
  const { minuteVolume, withVolume } = await market;
  const { evalLast } = await import('../workers3/quant-bot/core/live-eval.js');
  const historical = await sessions();
  const opening = [0, 1, 2, 3].map((i) => ({ t: ny(friday, '09:30') + i * 300000, o: 100, h: i < 3 ? 101 : 106, l: 99,
    c: i < 3 ? 100 : 105, v: i < 3 ? 10000 : 100000 }));
  const data = [...historical, ...opening];
  const volume = minuteVolume(historical.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]), friday);
  const spec = { timeframe: '5m', side: 'long', entry: { all: [{ setup: 'orb' }] } };
  const full = evalLast(spec, data, { side: 'long' });
  const increment = evalLast(spec, withVolume(data.slice(-120), friday, volume), { side: 'long', dayVolume: true });
  assert.equal(full.fire, true);
  assert.equal(increment.fire, full.fire);
});
