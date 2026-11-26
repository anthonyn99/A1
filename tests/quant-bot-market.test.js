// Neo Cortex N4's pinned paper broker requests, calendar and incremental IEX bars.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const alpaca = import('../workers3/quant-bot/lib/alpaca.js');
const market = import('../workers3/quant-bot/lib/market.js');
const date = '2026-11-27';
const at = (time) => Date.parse(date + 'T' + time + ':00-05:00');
const keys = { BOT_ALPACA_KEY: 'fixture-key', BOT_ALPACA_SECRET: 'fixture-secret' };
const memoryCache = () => {
  const store = new Map();
  return { match: async (req) => store.get(req.url)?.clone(), put: async (req, response) => store.set(req.url, response.clone()) };
};

test('sends paper account reads only to the paper host and bars only to data', async () => {
  const { paperBroker, ALPACA_PAPER, ALPACA_DATA } = await alpaca;
  const requests = [];
  const data = { t: '2026-11-27T14:30:00Z', o: 110, h: 112, l: 109, c: 111, v: 10 };
  const client = paperBroker(keys, async (str, opts) => {
    const url = new URL(str);
    requests.push(url);
    assert.equal(opts.headers['APCA-API-KEY-ID'], keys.BOT_ALPACA_KEY);
    assert.equal(opts.redirect, 'error');
    if (url.origin === ALPACA_PAPER) return Response.json({});
    assert.equal(url.origin, ALPACA_DATA);
    assert.equal(url.searchParams.get('feed'), 'iex');
    assert.equal(url.searchParams.get('timeframe'), '5Min');
    const second = url.searchParams.has('page_token');
    return Response.json({ bars: { [second ? 'NVDA' : 'SPY']: [data] }, next_page_token: second ? null : 'fixture-page' });
  });
  await Promise.all([client.clock(), client.account(), client.positions(), client.orders(), client.fills(at('10:00')), client.asset('AMD')]);
  assert.ok(requests.every((url) => url.origin === ALPACA_PAPER));
  assert.throws(() => client.asset('../orders'), /Invalid asset symbol/);
  const bars = await client.bars(['SPY', 'NVDA'], '5m', at('09:30'), at('10:00'));
  assert.equal(bars.SPY[0][4], 111);
  assert.equal(bars.NVDA[0][5], 10);
  assert.equal(requests.at(-1).searchParams.get('page_token'), 'fixture-page');
});

test('broker clock and calendar distinguish half days, stale clocks and holidays', async () => {
  const { marketClock } = await market;
  let stamp = at('12:51'), read = 0, open = true;
  const broker = {
    clock: async () => ({ is_open: open, timestamp: new Date(stamp).toISOString() }),
    calendar: async () => { read++; return [{ date, open: '09:30', close: '13:00' }]; },
  };
  const cache = memoryCache();
  const half = await marketClock(broker, stamp, cache);
  assert.deepEqual({ open: half.open, half: half.half, close: half.closeMin }, { open: true, half: true, close: 780 });
  stamp = at('13:01'); open = false;
  assert.equal((await marketClock(broker, stamp, cache)).open, false);
  assert.equal(read, 1);
  await assert.rejects(marketClock(broker, at('13:06'), cache), /stale/);
  const holiday = await marketClock({}, Date.parse('2026-11-26T16:00:00Z'), cache);
  assert.equal(holiday.closedForDay, true);
});

test('caches compact bars, requests only the increment and excludes premarket and partial bars', async () => {
  const { loadBars, objects, isFresh } = await market;
  const cache = memoryCache(), starts = [];
  const tuple = (time, v) => [at(time), 1, 2, 1, 2, v];
  const broker = {
    bars: async (symbols, tf, start) => {
      starts.push(start);
      assert.deepEqual(symbols, ['AMD', 'SPY']);
      assert.equal(tf, '5m');
      return { AMD: [tuple('09:25', 10), tuple('09:30', 20), tuple('09:35', 30), tuple('09:40', 40)], SPY: [tuple('09:30', 20), tuple('09:35', 30), tuple('09:40', 40)] };
    },
  };
  const session = { date, closeMin: 780 };
  const first = await loadBars(broker, ['SPY', 'AMD'], '5m', at('09:36'), session, cache);
  assert.deepEqual(first.AMD.map((b) => b[0]), [at('09:30')]);
  assert.equal(isFresh(objects(first.AMD).at(-1), '5m', at('09:36'), session), true);
  await loadBars(broker, ['AMD', 'SPY'], '5m', at('09:37'), session, cache);
  assert.equal(starts.length, 1);
  const later = await loadBars(broker, ['AMD', 'SPY'], '5m', at('09:41'), session, cache);
  assert.equal(starts[1], at('09:30'));
  assert.deepEqual(later.AMD.map((b) => b[0]), [at('09:30'), at('09:35')]);
  assert.equal(isFresh(objects(later.AMD).at(-1), '5m', at('09:45'), session), false);
});
