// Worker integration for the Trackers feeds and the shared Debrief refresh claim.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const WORKER = '../workers2/quant-api/';
const load = (file) => import(WORKER + file);
const now = Date.parse('2026-11-24T18:00:00Z');
const ledger = () => ({ blocked: () => '', spend: () => true, note() {} });
const csv = 'observation_date,DGS2,DGS10\n2026-11-20,4.50,4.80\n2026-11-23,.,4.90\n2026-11-24,4.65,4.88';
const article = (title, url, date) => '<item><title>' + title + '</title><link>' + url + '</link><source>Wire</source><pubDate>' + date + '</pubDate></item>';

test('Trackers bypass stock feeds and preserve original symbol, delay and source', async (t) => {
  const { getQuotes, getBars } = await load('lib/data.js');
  const { YAHOO_TRACKERS } = await load('providers/trackers.js');
  t.mock.method(globalThis, 'fetch', async (raw) => {
    const u = new URL(raw);
    if (u.hostname === 'fred.stlouisfed.org') return new Response(csv);
    assert.equal(u.hostname, 'query1.finance.yahoo.com');
    if (u.pathname.includes('/chart/')) {
      assert.equal(decodeURIComponent(u.pathname.split('/').at(-1)), 'DX-Y.NYB');
      return Response.json({ chart: { result: [{ timestamp: [now / 1000], indicators: { quote: [{ open: [104], high: [105], low: [103], close: [104], volume: [0] }] } }] } });
    }
    assert.deepEqual(u.searchParams.get('symbols').split(','), Object.values(YAHOO_TRACKERS));
    const result = Object.values(YAHOO_TRACKERS).map((symbol) => ({ symbol, response: [{ meta: { regularMarketPrice: 42, chartPreviousClose: 41, regularMarketTime: (now - 600_000) / 1000 } }] }));
    return Response.json({ spark: { result } });
  });
  const requested = [...Object.keys(YAHOO_TRACKERS), 'US2Y', 'US10Y'];
  const result = await getQuotes(ledger(), { ALPACA_KEY: 'fixture' }, requested, now);
  assert.deepEqual(Object.keys(result.quotes).sort(), requested.sort());
  assert.ok(Object.values(result.quotes).every((q) => !q.realtime));
  assert.equal(result.quotes.VIX.delayMs, 900_000);
  assert.equal(result.quotes.DXY.prevClose, 41);
  assert.equal(result.quotes.US2Y.price, 4.65);
  assert.equal(result.quotes.US2Y.prevClose, 4.50);
  assert.equal(result.quotes.US10Y.provider, 'fred');
  assert.equal(result.quotes.US10Y.daily, true);
  assert.equal((await getBars(ledger(), {}, 'US2Y', '1d', now - 5 * 86_400_000, now, true, now)).bars.length, 2);
  assert.equal(await getBars(ledger(), {}, 'US2Y', '5m', now - 86_400_000, now, true, now), null);
  assert.equal((await getBars(ledger(), {}, 'DXY', '5m', now - 86_400_000, now, true, now)).bars[0].vx, 'none');
});

test('news rejects stale and invalid sources, deduplicates and checks numbers against cited headlines', async () => {
  const { readNewsRss, parseUpdates } = await load('lib/debrief-search.js');
  const date = new Date(now).toUTCString();
  const sources = readNewsRss('<rss>' + article('Two ships &amp; 3 sailors - Wire', 'https://example.com/1', date) +
    article('Two ships &amp; 3 sailors - Wire', 'https://example.com/2', date) +
    article('Old story', 'https://example.com/3', '2020-01-01') + article('Bad article', 'javascript:alert(1)', date) + '</rss>', now);
  assert.deepEqual(sources.map((x) => x.title), ['Two ships & 3 sailors']);
  const update = (text, refs) => JSON.stringify({ updates: [{ text, refs }] });
  assert.equal(parseUpdates(update('Wire reports 3 sailors.', [1]), sources).length, 1);
  assert.deepEqual(parseUpdates(update('Wire reports 60 sailors.', [1]), sources), []);
  assert.deepEqual(parseUpdates(update('Wire reports 3 sailors.', [2]), sources), []);
});

test('overlapping Debrief requests share one refresh and subsequent reads use the cache', async (t) => {
  const { debriefSearch } = await load('lib/debrief-search.js');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT,at INTEGER); CREATE TABLE usage(day TEXT,service TEXT,n INTEGER); CREATE TABLE provider_health(provider TEXT)');
  const DB = { prepare(sql) { return { bind(...args) { return statement(sql, args); }, ...statement(sql, []) }; } };
  function statement(sql, args) {
    return { async run() { return { meta: db.prepare(sql).run(...args) }; },
      async first() { return db.prepare(sql).get(...args); },
      async all() { return { results: db.prepare(sql).all(...args) }; } };
  }
  let calls = 0, respond, started;
  const gate = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /^https:\/\/news\.google\.com\/rss\/search\?/);
    calls++;
    started();
    return new Promise((resolve) => { respond = resolve; });
  });
  const req = (q) => new Request('https://worker.example/debrief/search', { method: 'POST', body: JSON.stringify({ query: q }) });
  const pending = debriefSearch({ DB }, req('Hormuz'));
  await gate;
  const second = await (await debriefSearch({ DB }, req('hormuz'))).json();
  assert.equal(second.pending, true);
  respond(new Response('<rss>' + article('Shipping update - Wire', 'https://example.com/1', new Date().toUTCString()) + '</rss>'));
  const first = await (await pending).json();
  assert.equal(first.result.sources.length, 1);
  const cached = await (await debriefSearch({ DB }, req('Hormuz'))).json();
  assert.deepEqual(cached.result, first.result);
  assert.equal(calls, 1);
});
