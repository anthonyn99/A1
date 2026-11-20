// quant-api, Refinements Batch 2 BV (A1-Priv docs/TradeHub/quant/r2-0v.md): volume you can trust.
// Tony, 2026-11-20: SNDK's volume dropped off for the newest minutes (Alpaca's free edge is one
// exchange, IEX) and MU's Yahoo bars spiked and vanished (Yahoo's intraday volume: zeros in extended
// hours, a 25 M lump mid-day). Bars carry `vx: 'iex' | 'none'`; nothing is replaced by a guess.
//
// Run: node tests/quant-volume-api.test.js
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const MIN = 60_000;

(async () => {
  const base = path.join(__dirname, '..', 'workers2', 'quant-api');
  const V = await import(pathToFileURL(path.join(base, 'lib', 'volume.js')).href);
  const B = await import(pathToFileURL(path.join(base, 'lib', 'bars.js')).href);
  const T = await import(pathToFileURL(path.join(base, 'lib', 'time.js')).href);
  const A = await import(pathToFileURL(path.join(base, 'providers', 'alpaca.js')).href);

  console.log('\nYahoo\'s intraday volume (MU, 2026-11-20)');
  // 5-minute bars from 04:00 to 20:00 New York on Nov 20: extended hours 0 (as Yahoo sends), 600k in
  // session, the open 4.8 M, and the 11:40 lump of 25,118,076.
  const day = T.nyMidnight('2026-11-20'), bars = [];
  for (let m = 240; m < 1200; m += 5) {
    const reg = m >= 570 && m < 960;
    bars.push({ t: day + m * MIN, o: 600, h: 601, l: 599, c: 600, v: !reg ? 0 : m === 570 ? 4778407 : m === 700 ? 25118076 : 600000 + (m % 7) * 1000 });
  }
  V.markYahooVolume(bars);
  const at = (m) => bars.find((b) => b.t === day + m * MIN);
  ok('every extended-hours zero is "not known", never a real 0', [240, 400, 565, 960, 1195].every((m) => at(m).vx === 'none'));
  ok('the 25 M mid-day lump is "not known"', at(700).vx === 'none', JSON.stringify(at(700)));
  ok('the open\'s crowd (4.8 M at 09:30) is real, kept', !at(570).vx);
  ok('ordinary session bars are untouched', !at(600).vx && !at(900).vx && !at(955).vx);
  ok('...and the numbers are never changed (a mark only)', at(700).v === 25118076 && at(600).v === 600000 + (600 % 7) * 1000);

  console.log('\nThe mark through the chain');
  const four = B.toTimeframe([{ t: day + 600 * MIN, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }, { t: day + 660 * MIN, o: 1.5, h: 2, l: 1, c: 1.8, v: 5, vx: 'iex' }], '4h');
  ok('a 4-hour bar built with an IEX hour is IEX itself', four.length === 1 && four[0].vx === 'iex' && four[0].v === 15, JSON.stringify(four));
  ok('...and with an unknown hour, unknown', B.toTimeframe([{ t: day + 600 * MIN, o: 1, h: 1, l: 1, c: 1, v: 1, vx: 'iex' }, { t: day + 660 * MIN, o: 1, h: 1, l: 1, c: 1, v: 1, vx: 'none' }], '4h')[0].vx === 'none');
  ok('joinVx: unknown wins, then IEX, else whole', V.joinVx(undefined, undefined) === undefined && V.joinVx('iex', undefined) === 'iex' && V.joinVx('iex', 'none') === 'none');
  ok('unsplit keeps the mark (raw prices for adj=0)', B.unsplit([{ t: 1, o: 10, h: 10, l: 10, c: 10, v: 100, vx: 'iex' }], [{ t: 5, ratio: 10 }])[0].vx === 'iex');

  console.log('\nAlpaca: the newest 16 minutes are IEX');
  const now = day + 720 * MIN, seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url); seen.push(u);
    const feed = /feed=(\w+)/.exec(u)[1], from = Date.parse(decodeURIComponent(/start=([^&]+)/.exec(u)[1])), to = Date.parse(decodeURIComponent(/end=([^&]+)/.exec(u)[1]));
    const out = [];
    for (let t = Math.ceil(from / (5 * MIN)) * 5 * MIN; t <= to; t += 5 * MIN) out.push({ t: new Date(t).toISOString(), o: 80, h: 81, l: 79, c: 80, v: feed === 'sip' ? 500000 : 12000 });
    return new Response(JSON.stringify({ bars: out, next_page_token: null }), { status: 200 });
  };
  const L = { blocked: () => null, spend: () => true, note() {} };
  const got = await A.bars(L, { ALPACA_KEY: 'k', ALPACA_SECRET: 's' }, 'SNDK', '5m', now - 120 * MIN, now, true, now);
  const iex = got.filter((b) => b.vx === 'iex'), sip = got.filter((b) => !b.vx);
  ok('bars older than 16 minutes come from SIP, unmarked (the whole market)', sip.length > 0 && sip.every((b) => b.v === 500000 && b.t < now - A.SIP_LAG + 5 * MIN));
  ok('the newest 16 minutes come from IEX and are marked "iex" (a few percent of the volume)', iex.length >= 3 && iex.every((b) => b.v === 12000 && b.t >= now - A.SIP_LAG - 5 * MIN), JSON.stringify(iex.map((b) => [new Date(b.t).toISOString().slice(11, 16), b.v])));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
