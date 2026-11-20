// quant-api's split adjustment (workers2/quant-api/lib/splits.js). Tony 2026-11-20: SNDK's 8-for-1 went
// ex that morning and Alpaca's history was still raw at the open (~$800 bars beside $80 live prices).
//
// Run: node tests/quant-splits.test.js
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};
const mod = (f) => import(pathToFileURL(path.join(__dirname, '..', f)).href);

(async () => {
  const S = await mod('workers2/quant-api/lib/splits.js'), T = await mod('workers2/quant-api/lib/time.js');
  const ex = T.nyMidnight('2026-11-20'), D = 86_400_000;
  const bar = (t, c, v = 1000) => ({ t, o: c, h: c * 1.01, l: c * 0.99, c, v });
  const raw = [bar(ex - 2 * D, 800), bar(ex - D, 776), bar(ex, 90), bar(ex + D, 82)];   // the old basis, then the ex-date
  const splits = [{ t: ex, ratio: 8, ex: '2026-11-20' }];

  console.log('resplit');
  const fixed = S.resplit(raw, splits);
  ok('bars before the ex-date are divided by the ratio (776 → 97), volume times it', Math.abs(fixed[1].c - 97) < 1e-9 && fixed[1].v === 8000 && Math.abs(fixed[0].c - 100) < 1e-9, JSON.stringify(fixed.slice(0, 2)));
  ok('bars on and after the ex-date are untouched', fixed[2] === raw[2] && fixed[3] === raw[3]);
  const adjusted = [bar(ex - 2 * D, 100), bar(ex - D, 97), bar(ex, 90), bar(ex + D, 82)];
  ok('history the provider already adjusted (no jump at the seam) is left alone: never split twice', S.resplit(adjusted, splits) === adjusted);
  ok('twice over is the same as once', JSON.stringify(S.resplit(S.resplit(raw, splits), splits)) === JSON.stringify(fixed));
  const before = [bar(ex - 3 * D, 800), bar(ex - 2 * D, 790)];
  ok('a range that ends before the ex-date has no seam: as the provider sent it', S.resplit(before, splits) === before);
  // B3, Tony's SNDK at 13:29: Nov 19 came already on the new basis, Nov 17-18 still raw, ex-date Nov 20.
  const early = [bar(ex - 3 * D, 830), bar(ex - 2 * D, 800), bar(ex - D, 94.4), bar(ex, 80)];
  const fe = S.resplit(early, splits);
  ok('a jump a day BEFORE the ex-date is found: Nov 17-18 come down (800 → 100), Nov 19 is left (already new)', Math.abs(fe[1].c - 100) < 1e-9 && Math.abs(fe[0].c - 103.75) < 1e-9 && fe[2] === early[2] && fe[3] === early[3], JSON.stringify(fe.map((b) => b.c)));
  const earlyNoEx = early.slice(0, 3);
  ok('...also in a range that ends before the ex-date (an older chunk loaded on a pan)', Math.abs(S.resplit(earlyNoEx, splits)[1].c - 100) < 1e-9);
  const far = [bar(ex - 20 * D, 800), bar(ex - 19 * D, 100), bar(ex, 95)];
  ok('a jump far from any ex-date (20 days) is never treated as the split', S.resplit(far, splits) === far);
  const intraday = [{ t: ex - 3600_000, o: 780, h: 781, l: 779, c: 780, v: 10 }, { t: ex + 9.5 * 3600_000, o: 92, h: 93, l: 91, c: 92, v: 100 }];
  ok('intraday: the last bar of the day before and the first of the ex-date make the seam', Math.abs(S.resplit(intraday, splits)[0].c - 97.5) < 1e-9);
  const rev = [bar(ex - D, 2), bar(ex, 20)];
  ok('a reverse split (1-for-10, ratio 0.1) multiplies the old bars', Math.abs(S.resplit(rev, [{ t: ex, ratio: 0.1 }])[0].c - 20) < 1e-9);
  const ex2 = T.nyMidnight('2025-06-02');
  const two = [bar(ex2 - D, 400), bar(ex2, 200), bar(ex - D, 776), bar(ex, 97)];
  const t2 = S.resplit(two, [{ t: ex2, ratio: 2 }, { t: ex, ratio: 8 }]);
  ok('two splits: each seam read on one basis (400 → 200 → 25)', Math.abs(t2[0].c - 25) < 1e-9 && Math.abs(t2[1].c - 25) < 1e-9 && Math.abs(t2[2].c - 97) < 1e-9, JSON.stringify(t2.map((b) => b.c)));
  const crash = [bar(ex - D, 100), bar(ex, 60)];
  ok('a big move that is not the ratio (−40% on an 8-for-1 day) is not "a split"', S.resplit(crash, splits) === crash);

  console.log('the sources');
  const alp = { corporate_actions: { forward_splits: [{ symbol: 'SNDK', new_rate: 8, old_rate: 1, ex_date: '2026-11-20', process_date: '2026-11-20' }], reverse_splits: [{ symbol: 'XYZ', new_rate: 1, old_rate: 10, ex_date: '2026-01-05' }] } };
  ok('Alpaca: forward split new_rate / old_rate, only the symbol asked', JSON.stringify(S.fromAlpaca(alp, 'SNDK')) === JSON.stringify([{ ex: '2026-11-20', ratio: 8 }]));
  const yh = { chart: { result: [{ events: { splits: { a: { date: Math.floor((ex + 14.5 * 3600_000) / 1000), numerator: 8, denominator: 1 } } } }] } };
  ok('Yahoo: numerator / denominator, on its New York date', JSON.stringify(S.fromYahoo(yh)) === JSON.stringify([{ ex: '2026-11-20', ratio: 8 }]));

  console.log('getSplits');
  const calls = [];
  const L = { blocked: () => null, spend: () => true, ok() {}, bad() {}, note() {}, health() {}, record() {}, latency() {} };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); return new Response(JSON.stringify(String(u).includes('alpaca') ? alp : yh), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const got = await S.getSplits(L, { ALPACA_KEY: 'k', ALPACA_SECRET: 's' }, 'sndk', ex + D, { cache: null });
    ok('Alpaca first: one call to its corporate actions, splits as { t: 00:00 New York on the ex-date, ratio }', calls.length === 1 && /data\.alpaca\.markets\/v1\/corporate-actions\?symbols=SNDK&types=forward_split,reverse_split/.test(calls[0]) && got.length === 1 && got[0].t === ex && got[0].ratio === 8, JSON.stringify({ calls, got }));
    calls.length = 0;
    const y = await S.getSplits(L, {}, 'SNDK', ex + D, { cache: null });
    ok('no Alpaca key: Yahoo\'s split events', calls.length === 1 && /finance\/chart\/SNDK/.test(calls[0]) && y.length === 1 && y[0].ratio === 8, JSON.stringify({ calls, y }));
    ok('a symbol that is not a ticker asks nobody', (await S.getSplits(L, {}, '^VIX', ex, { cache: null })).length === 0);
  } finally { globalThis.fetch = realFetch; }
  const fs = require('fs');
  const data = fs.readFileSync(path.join(__dirname, '..', 'workers2/quant-api/lib/data.js'), 'utf8'), worker = fs.readFileSync(path.join(__dirname, '..', 'workers2/quant-api/worker.js'), 'utf8');
  ok('every adjusted /bars answer goes through resplit with the sources\' splits', /if \(adj && base0\.length > 1\) \{ try \{ base0 = resplit\(base0, await getSplits\(/.test(data));
  ok('GET /splits is behind the key (after auth)', worker.indexOf("p === '/splits'") > worker.indexOf('await auth(req, env);'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
