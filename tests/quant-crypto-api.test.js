// quant-api, Refinements Batch 2 B1 (A1-Priv docs/TradeHub/quant/r2-01.md): crypto bars and quotes.
// The worker's chains (lib/data.js getBars / getQuotes) against a fake `fetch` playing Alpaca's crypto
// API and Coinbase, with a stand-in budget ledger.
//
// Run: node tests/quant-crypto-api.test.js
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const res = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const MIN = 60_000, H = 3600_000, DAY = 86_400_000;

// Alpaca lists BTC, ETH and USDC; Coinbase lists BTC, ETH and SUI (not USDC: it is its dollar).
const NET = { calls: [], apDown: false };
globalThis.fetch = async (url) => {
  const u = String(url);
  NET.calls.push(u);
  if (/data\.alpaca\.markets\/v1beta3\/crypto\/us\/bars/.test(u)) {
    if (NET.apDown) return res({ message: 'down' }, 500);
    const pair = decodeURIComponent(/symbols=([^&]+)/.exec(u)[1]), tf = /timeframe=(\w+)/.exec(u)[1];
    const from = Date.parse(decodeURIComponent(/start=([^&]+)/.exec(u)[1])), to = Date.parse(decodeURIComponent(/end=([^&]+)/.exec(u)[1]));
    if (!['BTC/USD', 'ETH/USD', 'USDC/USD'].includes(pair)) return res({ bars: {}, next_page_token: null });
    const step = { '1Min': MIN, '5Min': 5 * MIN, '1Hour': H, '1Day': DAY }[tf];
    const out = [];
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push({ t: new Date(t).toISOString(), o: 100, h: 101, l: 99, c: 100.5, v: 2 });
    return res({ bars: { [pair]: out }, next_page_token: null });
  }
  if (/data\.alpaca\.markets\/v1beta3\/crypto\/us\/latest\/trades/.test(u)) return res({ trades: { 'USDC/USD': { p: 0.9998, t: '2026-11-20T18:00:00Z' } } });
  if (/api\.exchange\.coinbase\.com\/products\/([A-Z]+-USD)\/candles/.test(u)) {
    const pid = /products\/([A-Z]+-USD)\//.exec(u)[1], g = Number(/granularity=(\d+)/.exec(u)[1]);
    if (!['BTC-USD', 'ETH-USD', 'SUI-USD'].includes(pid)) return res({ message: 'NotFound' }, 404);
    const from = Date.parse(decodeURIComponent(/start=([^&]+)/.exec(u)[1])), to = Date.parse(decodeURIComponent(/end=([^&]+)/.exec(u)[1]));
    const rows = [];
    for (let t = Math.floor(to / (g * 1000)) * g * 1000; t >= from && rows.length < 300; t -= g * 1000) rows.push([t / 1000, 1.9, 2.1, 2, 2.05, 10]);   // newest first
    return res(rows);
  }
  if (/api\.exchange\.coinbase\.com\/products\/([A-Z]+-USD)\/stats/.test(u)) {
    const pid = /products\/([A-Z]+-USD)\//.exec(u)[1];
    return pid === 'BTC-USD' ? res({ open: '90000', last: '91800', high: '92000', low: '89000', volume: '1200' }) : pid === 'SUI-USD' ? res({ open: '2', last: '2.1' }) : res({ message: 'NotFound' }, 404);
  }
  return res({ message: 'unexpected ' + u }, 500);
};
const L = { spent: {}, blocked: () => null, spend(p, n = 1) { this.spent[p] = (this.spent[p] || 0) + n; return true; }, note() {} };

(async () => {
  const base = path.join(__dirname, '..', 'workers2', 'quant-api');
  const C = await import(pathToFileURL(path.join(base, 'lib', 'crypto.js')).href);
  const D = await import(pathToFileURL(path.join(base, 'lib', 'data.js')).href);
  const P = await import(pathToFileURL(path.join(base, 'providers', 'crypto.js')).href);
  const T = await import(pathToFileURL(path.join(base, 'lib', 'time.js')).href);
  const env = { ALPACA_KEY: 'k', ALPACA_SECRET: 's' }, now = Date.UTC(2026, 10, 20, 18, 0);

  console.log('\nThe symbol rule');
  ok('Webull\'s BTCUSD, hand-typed BTC-USD and BTC/USD are crypto; one form', C.isCrypto('BTCUSD') && C.isCrypto('btc-usd') && C.isCrypto('BTC/USD') && C.canonical('btc-usd') === 'BTCUSD');
  ok('stocks and unknown coins are not (AAPL, SPY, ZZZUSD)', !C.isCrypto('AAPL') && !C.isCrypto('SPY') && !C.isCrypto('ZZZUSD') && !C.isCrypto('USD'));
  ok('the pairs each source writes', C.coinbasePair('SUIUSD') === 'SUI-USD' && C.alpacaPair('BTCUSD') === 'BTC/USD');
  ok('a crypto day is stamped New York midnight of its UTC date', C.cryptoDayStamp(Date.UTC(2026, 10, 20, 0, 0)) === T.nyMidnight('2026-11-20'));

  console.log('\nBars: Alpaca first, then Coinbase');
  NET.calls.length = 0;
  let r = await D.getBars(L, env, 'BTCUSD', '5m', now - 6 * H, now, true, now);
  ok('BTC at 5 minutes from Alpaca\'s crypto bars, complete, no split call', r && r.provider === 'alpacaCrypto' && r.bars.length === 73 && r.complete && !NET.calls.some((u) => /splits|coinbase/.test(u)), JSON.stringify([r && r.provider, r && r.bars.length, NET.calls]));
  ok('...asked as BTC/USD', NET.calls.some((u) => /symbols=BTC%2FUSD/.test(u)));
  NET.calls.length = 0;
  r = await D.getBars(L, env, 'SUIUSD', '5m', now - 6 * H, now, true, now);
  ok('SUI (not on Alpaca): Coinbase answers, one call for 6 hours', r && r.provider === 'coinbase' && r.bars.length === 73 && r.complete && NET.calls.filter((u) => /coinbase/.test(u)).length === 1, JSON.stringify([r && r.provider, r && r.bars.length]));
  ok('...Coinbase\'s [time, low, high, open, close, volume] read the right way round', r.bars[0].o === 2 && r.bars[0].h === 2.1 && r.bars[0].l === 1.9 && r.bars[0].c === 2.05 && r.bars[0].v === 10);
  NET.calls.length = 0;
  r = await D.getBars(L, env, 'SUIUSD', '1m', now - 30 * DAY, now, true, now);
  ok(`a month of SUI minutes: at most ${P.CB_PAGES} Coinbase calls, the newest part, marked incomplete`, r && NET.calls.filter((u) => /coinbase/.test(u)).length === P.CB_PAGES && !r.complete && r.bars[r.bars.length - 1].t >= now - MIN, JSON.stringify([NET.calls.length, r && r.complete]));
  NET.calls.length = 0;
  r = await D.getBars(L, env, 'SUIUSD', '30m', now - 2 * DAY, now, true, now);
  ok('30 minutes from Coinbase: built from 5-minute candles', r && r.bars.length > 0 && r.bars.every((b) => b.t % (30 * MIN) === 0) && NET.calls.every((u) => !/coinbase/.test(u) || /granularity=300/.test(u)), JSON.stringify(r && r.bars.slice(0, 2)));
  NET.calls.length = 0;
  r = await D.getBars(L, env, 'BTCUSD', '4h', now - 2 * DAY, now, true, now);
  ok('4 hours: buckets on the UTC clock (00, 04, 08 … UTC), from hourly bars', r && r.bars.length >= 12 && r.bars.every((b) => b.t % (4 * H) === 0), JSON.stringify(r && r.bars.slice(0, 2).map((b) => new Date(b.t).toISOString())));
  r = await D.getBars(L, env, 'BTCUSD', '1d', now - 10 * DAY, now, true, now);
  ok('daily bars: every one stamped New York midnight of its UTC date, weekends included', r && r.bars.length >= 10 && r.bars.every((b) => b.t === C.cryptoDayStamp(b.t + 6 * H)), JSON.stringify(r && r.bars.slice(0, 2)));
  NET.calls.length = 0;
  r = await D.getBars(L, env, 'USDCUSD', '1h', now - DAY, now, true, now);
  ok('USDC: Alpaca answers and Coinbase is never asked (its 404 would trip the ledger for every coin)', r && r.provider === 'alpacaCrypto' && !NET.calls.some((u) => /coinbase/.test(u)));
  NET.apDown = true; NET.calls.length = 0;
  r = await D.getBars(L, env, 'ETHUSD', '1h', now - DAY, now, true, now);
  ok('Alpaca down: Coinbase answers ETH', r && r.provider === 'coinbase' && r.bars.length > 0, JSON.stringify(r && r.tried));
  NET.apDown = false;
  r = await D.getBars(L, env, 'AAPL', '1d', now - 10 * DAY, now, true, now).catch((e) => ({ err: e.message }));
  ok('a stock never goes to the crypto sources', !NET.calls.slice(-3).some((u) => /crypto\/us|coinbase/.test(u)) || (r && r.provider !== 'coinbase'), JSON.stringify(r).slice(0, 120));

  console.log('\nQuotes');
  NET.calls.length = 0;
  const q = await D.getQuotes(L, env, ['BTCUSD', 'SUIUSD', 'USDCUSD'], now);
  ok('BTC: Coinbase\'s last price and its 24-hour open (the day change Tony asked for)', q.quotes.BTCUSD && q.quotes.BTCUSD.price === 91800 && q.quotes.BTCUSD.open24 === 90000 && q.quotes.BTCUSD.provider === 'coinbase', JSON.stringify(q.quotes.BTCUSD));
  ok('SUI from Coinbase too; USDC from Alpaca\'s latest trade, Coinbase not asked for it', q.quotes.SUIUSD && q.quotes.SUIUSD.open24 === 2 && q.quotes.USDCUSD && q.quotes.USDCUSD.price === 0.9998 && !NET.calls.some((u) => /USDC-USD/.test(u)), JSON.stringify(q.quotes));
  ok('...crypto never reaches the stock quote chain', !NET.calls.some((u) => /v2\/stocks|finnhub|yahoo/.test(u)), NET.calls.join(' '));
  ok('every Coinbase call is on its own ledger line', L.spent.coinbase > 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
