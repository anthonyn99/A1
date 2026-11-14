// TradeHub Quant, Phase 7: Scanner ▸ Invest and the ticker dossier in the real
// page (A1-Priv tradehub.html + TradeHub/ui/invest.js, dossier.js), quant-api
// played here (quant-mock.js).
//
//   1. the horizon switch Day / Swing / Invest; Invest = three cards on the grid
//   2. Market stage: stage, depth, washout and its parts, dated evidence, sectors
//   3. Accumulate: the word, the tranches and their invalidation, the ledger's
//      invest signal with its 1/3/6-month marks, the measured rule WITH its sample
//   4. Ideas: 12 cards, each with why, warnings, where to start buying, the fit
//   5. the dossier: every fact with its source and time or "unavailable", a
//      disputed fact, the Street, warnings, sources; one correction logged
//   6. the Weekly / Monthly chart presets with the 40- and 200-week averages
//   7. the board still shows only day and swing setups
//   8. 1280, 820 and 390 px: no sideways scroll; no task over 50 ms; no error
//
// Run: node tests/live/tradehub-quant-invest.live.js   (SHOTS_DIR=… for screenshots)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, CLOCK } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const DAY = 86400000;
const day = (k) => new Date(CLOCK - k * DAY).toISOString().slice(0, 10);

function ideasDoc() {
  const item = (symbol, i, type = 'stock') => ({
    symbol, type, sector: type === 'etf' ? null : 'XLK', name: type === 'etf' ? null : symbol + ' Corp', score: 0.9 - i * 0.03,
    parts: type === 'etf' ? { trend: 0.8, rs: 0.7, drawdown: 0.1 } : { quality: 0.8, growth: 0.7, value: 0.6, trend: 0.9, drawdown: 0.2 }, missing: [],
    why: ['Operating margin 41%, more cash than debt', 'Revenue +24% a year over 3 years', 'Above a rising 200-day average; +35% over 12 months less the last'],
    warnings: i === 0 ? [{ code: 'earnings-soon', level: 'warn', text: 'Earnings in 3 sessions (2026-11-19)' }] : [],
    buy: { close: 180.5, support: { price: 171.2, name: 'S2', rank: 'Strong' }, ma200: 160.3 }, facts: {},
  });
  const syms = ['NVDA', 'MSFT', 'AVGO', 'META', 'GOOGL', 'COST', 'LLY', 'QQQ', 'V', 'MA', 'SOXX', 'ORCL'];
  return {
    v: 1, day: day(1), at: CLOCK - 14 * 3600000, universeDay: '2026-11-13', minutes: 6.2,
    universe: { stocks: 517, etfs: 25, ranked: 431, skipped: 111 },
    items: syms.map((s, i) => item(s, i, ['QQQ', 'SOXX'].includes(s) ? 'etf' : 'stock')),
    market: {
      index: 'SPY', t: CLOCK - DAY, day: day(1), stage: 'correction', depth: 0.123, washout: 61, inverted: true,
      parts: { low20: 0.5, below200: 0.7, vixRank: 0.9, inverted: 1, rsi: 0 }, missing: [],
      sectors: [{ sym: 'XLK', name: 'Technology', depth: 0.15 }, { sym: 'XLU', name: 'Utilities', depth: 0.03 }],
      evidence: [
        { id: 'ftd', n: 1, t: CLOCK - 3 * DAY, date: day(3), text: `Follow-through day ${day(3)}: day 5 of the rally, index +1.80% on higher volume` },
        { id: 'reclaim20', n: 4, t: CLOCK - 2 * DAY, date: day(2), text: `Back over the 20-day average ${day(2)} (600.10 over 598.20)` },
        { id: 'vix', n: 6, t: CLOCK - 4 * DAY, date: day(4), text: `VIX closed at 22.10, under its 10-day average (24.30) ${day(4)}, after its 31.20 spike on ${day(9)}` },
      ],
      trough: { t: CLOCK - 8 * DAY, date: day(8), low: 560.2 }, peak: { t: CLOCK - 60 * DAY, high: 640 },
      tranches: [{ n: 1, t: CLOCK - 3 * DAY, date: day(3), price: 590.4, share: 1 / 3, invalid: 560.2, invalidAt: null, why: 'Follow-through day; back over the 20-day', plan: 1 }],
      verdict: 'Accumulate', breadth: 'the S&P 100 (101 members)',
    },
  };
}
const fhAt = CLOCK - 3 * 3600000, secAt = CLOCK - 2 * DAY;
const DOSSIER = {
  symbol: 'NVDA', asOf: fhAt, calls: 0, pending: [], failed: { insiders: 'finnhub: HTTP 500' },
  parts: {
    metric: { src: 'finnhub', at: fhAt, facts: { high52: 212.2, low52: 120.1, beta: 1.8, marketCap: 4.5e12, pe: 48.2, ps: 25, eps: 3.9, epsFy: 3.7, grossMargin: 0.721, grossMarginFy: 0.70, operatingMargin: 0.61, netMargin: 0.53, roe: 1.1, revGrowth3y: 0.85, epsGrowth3y: 1.2, revGrowthYoy: 0.62, dividendYield: 0.0002, payoutRatio: 0.01, peHist: [{ d: '2025-01-31', v: 50 }, { d: '2025-04-30', v: 40 }, { d: '2025-07-31', v: 45 }, { d: '2025-10-31', v: 55 }] } },
    sec: { src: 'sec', at: secAt, facts: { name: 'NVIDIA CORP', fiscalYearEnd: '2026-01-25', revenue: 2e11, netIncome: 1e11, freeCashFlow: 8.5e10, totalDebt: 8e9, cash: 2e10, netDebtEbitda: -0.1, grossMarginFy: 0.701, epsFy: 4.0 } },
    recommendation: { src: 'finnhub', at: fhAt, facts: { ratings: { buy: 38, hold: 5, sell: 1 }, ratingTrend: 'up' } },
    target: { src: 'nasdaq', at: fhAt, facts: { targetLow: 170, targetMean: 247.58, targetHigh: 345, ratings: { buy: 37, hold: 6, sell: 1 } } },
    calendar: { src: 'finnhub', at: fhAt, facts: { nextEarnings: day(-5), earningsTime: 'after the close' } },
    surprises: { src: 'finnhub', at: fhAt, facts: { surprises: [{ period: '2026-07-31', actual: 1.05, estimate: 1.0, surprisePct: 0.05 }] } },
    estimates: { src: 'nasdaq', at: fhAt, facts: { revisions: { up: 1, down: 3, change: -0.012 } } },
  },
};

(async () => {
  const api = quantApi();
  api.state.ideas = ideasDoc();
  api.state.dossier.NVDA = DOSSIER;
  api.state.calibration = { v: 1, at: CLOCK - 5 * DAY, setups: {}, invest: { n: 11, small: true, from: '2006-01-03', to: day(1), breadthFrom: 'the S&P 100 over the last 5 years only',
    by: { 1: { n: 11, invalidated: 5, m1: { n: 11, median: 0, hit: 0.45 }, m3: { n: 11, median: 0.005, hit: 0.55 }, m6: { n: 11, median: 0.051, hit: 0.64 } }, 2: { n: 9, invalidated: 3 }, 3: { n: 7, invalidated: 2 } }, rows: [] } };
  api.state.signals = [{ id: 'sinv0001', symbol: 'SPY', setup: 'accumulate', horizon: 'invest', dir: 'long', at: CLOCK - 40 * DAY, expires: CLOCK + 140 * DAY, verdict: 'GO', word: 'Accumulate', tranche: 1, score: 100,
    entry: 580, stop: 540, zone: [574, 586], targets: [660, 700], rr: [2, 3], why: ['Follow-through day'], status: 'triggered', done: false, m1: 0.034, m3: null, m6: null, created: CLOCK - 40 * DAY, backtested: true }];
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP + `;window.__long=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__long.push([Math.round(e.startTime), Math.round(e.duration)]);});}).observe({type:'longtask',buffered:false});}catch(e){}` });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab, shot } = driver(c);
  const asked = (p, method) => api.asked.filter((x) => x.p === p && (!method || x.method === method)).length;
  const noSideScroll = () => js(`return document.scrollingElement.scrollWidth <= window.innerWidth + 1;`);
  const text = (sel) => js(`var e=document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : '';`);

  console.log('\nThe horizon switch');
  await size(1280, 900);
  await boot({ quant: true, ls: { tradehub_scanner_view: JSON.stringify({ view: 'board', horizon: 'all' }) } });
  await tab('scanner');
  ok('the Scanner mounts', await until(`document.querySelector('[data-scanner]')`, 20000));
  ok('Day / Swing / Invest (and All) on the horizon switch', (await js(`return [...document.querySelectorAll('[data-sc-horizon]')].map(function(b){return b.textContent;}).join();`)) === 'All,Day,Swing,Invest');
  await until(`document.querySelector('[data-sc-lane="go"]')`, 8000);
  ok('the board shows day and swing setups only: the invest signal is not on a lane', !(await js(`return !!document.querySelector('[data-sc-sig="sinv0001"]');`)));
  await js(`window.__long=[]; document.querySelector('[data-sc-horizon="invest"]').click(); return 1;`);
  ok('Invest: three cards on the fluid grid (Market stage, Accumulate, Ideas)', await until(`document.querySelector('[data-invest]') && ['stage','plan','ideas'].every(function(id){return !!document.querySelector('.lay-card[data-card="'+id+'"]');})`, 8000));
  ok('...the direction and setup filters step aside', !(await js(`return !!document.querySelector('[data-sc-dir]') || !!document.querySelector('[data-sc-setup]');`)));
  ok('the ideas are read once (GET /ideas)', await until(`document.querySelector('[data-iv-idea]')`, 8000) && asked('/ideas', 'GET') === 1);
  await shot('invest-1280');

  console.log('\nMarket stage');
  const st = await text('[data-iv-stage]');
  ok('stage, depth under the 252-day high and the close it is from', /Correction/.test(st) && /12\.3% under the 252-day high/.test(st) && /SPY/.test(st));
  ok('the washout and every part of it', /Washout[\s\S]*61 of 100/.test(st) && /Members at 20-day lows[\s\S]*50 of 100/.test(st) && /VIX over its 3-month[\s\S]*yes/.test(st) && /Index RSI under 30[\s\S]*no/.test(st));
  ok('the reversal evidence, each item dated', (await js(`return document.querySelectorAll('[data-iv-ev]').length;`)) === 3 && st.includes(day(3)) && /Follow-through day/.test(st) && /since the/i.test(st), st);
  ok('the sector funds\' depth', /Technology[\s\S]*15\.0%/.test(st));

  console.log('\nAccumulate');
  const pl = await text('[data-iv-plan]');
  ok('the word "Accumulate" and why', (await js(`return document.querySelector('[data-iv-word]').dataset.ivWord;`)) === 'Accumulate' && /A tranche fired/.test(pl));
  ok('the tranche: a third, its date and price, invalid under the reversal low', /Tranche 1 \(a third\)[\s\S]*590\.40/.test(pl) && /Invalid on a close under 560\.20/.test(pl));
  ok('the ledger\'s invest signal with its 1-month mark (3 and 6 still to come)', /SPY tranche 1/i.test(pl) && /1 month \+3\.4% · 3 months — · 6 months —/.test(pl), pl);
  ok('the rule measured on history, its sample stated plainly', /11 first tranches on SPY, 2006 to 20\d\d/.test(pl) && /6 months: median \+5\.1%, up in 7 of 11/.test(pl) && !!(await js(`return document.querySelector('[data-iv-small]');`)) && /Small sample \(11, under 30\)/.test(pl));

  console.log('\nIdeas');
  ok('12 idea cards, best first', (await js(`return [...document.querySelectorAll('[data-iv-idea]')].map(function(x){return x.dataset.ivIdea;}).join();`)) === 'NVDA,MSFT,AVGO,META,GOOGL,COST,LLY,QQQ,V,MA,SOXX,ORCL');
  const card = await text('[data-iv-idea="NVDA"]');
  ok('each: score, why (three facts), what could go wrong, where to start buying, how it fits', /90 of 100/.test(card) && (await js(`return document.querySelectorAll('[data-iv-idea="NVDA"] [data-iv-why] li').length;`)) === 3 && /Earnings in 3 sessions/.test(card) && /Strong support 171\.20 \(S2\) · 200-day 160\.30 · last close 180\.50/.test(card) && /How it fits/i.test(card), card);
  ok('...no holdings loaded: the fit says so', await until(`/No holdings to compare with/.test(document.querySelector('[data-iv-idea="NVDA"] [data-iv-fit]').textContent)`, 8000));
  ok('...an ETF card says ETF and has no fundamentals parts', /ETF/i.test(await text('[data-iv-idea="QQQ"]')) && /Rel\. strength/.test(await text('[data-iv-idea="QQQ"]')));
  ok('the universe and that nothing here acts', /Top 12 of 431 ranked: the S&P 500, the Nasdaq-100 and 25 ETFs/.test(await text('[data-iv-universe]')) && /never acted on/.test(await text('[data-iv-universe]')));
  const long1 = await js(`return JSON.stringify(window.__long||[]);`).then(JSON.parse);
  ok('no main-thread task over 50 ms while Invest draws', long1.every((x) => x[1] <= 50), JSON.stringify(long1));

  console.log('\nThe dossier');
  await js(`document.querySelector('[data-iv-dossier="NVDA"]').click(); return 1;`);
  ok('"Dossier" opens the ticker panel with the dossier', await until(`document.querySelector('[data-dossier="NVDA"]')`, 10000) && asked('/dossier', 'GET') === 1);
  const facts = await js(`return JSON.stringify([...document.querySelectorAll('[data-dossier] [data-dz-fact]')].map(function(f){var s=f.querySelector('[data-dz-src]'); return [f.dataset.dzFact, s ? s.textContent : '', f.classList.contains('is-missing') ? f.querySelector('b').textContent : ''];}));`).then(JSON.parse);
  ok('every fact shows its source and time, or "unavailable"', facts.length >= 30 && facts.every(([, src, miss]) => /^(Finnhub|SEC filings|Nasdaq|FINRA|Alpha Vantage) · \w+day, \w+ \d+, \d+:\d\d/.test(src) || miss === 'unavailable'), JSON.stringify(facts.filter(([, s, m]) => !s && m !== 'unavailable')));
  ok('...EPS for the fiscal year is disputed (Finnhub 3.70, SEC 4.00)', /disputed: SEC filings says 4\.00/.test(await text('[data-dz-fact="epsFy"]')));
  ok('...insiders failed: unavailable, and the Sources say why', /unavailable/.test(await text('[data-dz-fact="insiders"]')) && /insiders: not available now \(finnhub: HTTP 500\)/.test(await text('[data-dz-sources]')));
  const dz = await text('[data-dossier="NVDA"]');
  ok('the Street: counts and the bar, the trend, low / mean / high targets', /38 buy · 5 hold · 1 sell/.test(dz) && !!(await js(`return document.querySelector('.dz-ratebar');`)) && /More buys than 3 months ago/i.test(dz) && /247\.58/.test(dz) && /345\.00/.test(dz), dz.slice(0, 1200));
  ok('warnings from the facts: earnings within 5 sessions, estimates falling', !!(await js(`return document.querySelector('[data-dz-warn="earnings-soon"]') && document.querySelector('[data-dz-warn="estimates-falling"]');`)));
  ok('sources with their times', /Finnhub: \w+day/.test(await text('[data-dz-sources]')) && /SEC filings: \w+day/.test(await text('[data-dz-sources]')));
  ok('the dispute went to the data doctor\'s log once', await until(`true`, 500) && asked('/corrections', 'POST') === 1 && api.posted.corrections[0].items.some((i) => i.field === 'epsFy'));
  await shot('dossier-1280');

  console.log('\nChart presets');
  await js(`document.querySelector('[data-tkp] [data-ch-preset="weekly"]').click(); return 1;`);
  ok('"Weekly": weekly bars with the 40- and 200-week averages', await until(`document.querySelector('[data-tkp] [data-ch-tf]').value === '1w' && document.querySelector('[data-tkp] [data-ch-preset="weekly"]').classList.contains('is-on')`, 5000)
    && /wsma:40, wsma:200/.test(await js(`return document.querySelector('[data-tkp] [data-ch-ind]').title;`)));
  await js(`document.querySelector('[data-tkp] [data-ch-preset="monthly"]').click(); return 1;`);
  ok('"Monthly": monthly bars, the same averages', await until(`document.querySelector('[data-tkp] [data-ch-tf]').value === '1mo' && document.querySelector('[data-tkp] [data-ch-preset="monthly"]').classList.contains('is-on')`, 5000));
  await js(`document.querySelector('[data-tkp-close]').click(); return 1;`);
  ok('the Dossier button is on the ticker panel from anywhere (the board\'s signal)', await (async () => { await js(`document.querySelector('[data-iv-open="MSFT"]').click(); return 1;`); const r = await until(`document.querySelector('[data-tkp-dossier]')`, 5000); await js(`document.querySelector('[data-tkp-close]').click(); return 1;`); return r; })());

  console.log('\nLayouts');
  for (const [w, hgt] of [[1280, 900], [820, 1100], [390, 844]]) {
    await size(w, hgt); await sleep(500);
    ok(`${w} px: no sideways scroll, every card and all 12 ideas there`, (await noSideScroll()) && (await js(`return document.querySelectorAll('[data-iv-idea]').length;`)) === 12 && ['stage', 'plan', 'ideas'].every(Boolean));
    await shot('invest-' + w);
  }
  await size(1280, 900);
  await js(`document.querySelector('[data-sc-horizon="swing"]').click(); return 1;`);
  ok('back to Swing: the lanes come back', await until(`document.querySelector('[data-sc-lane="go"]') && !document.querySelector('[data-invest]')`, 5000));
  await js(`document.querySelector('[data-sc-horizon="invest"]').click(); return 1;`);
  ok('...and Invest again (kept, no second GET of the ideas)', await until(`document.querySelector('[data-invest]')`, 5000) && asked('/ideas', 'GET') === 1);
  ok('no uncaught errors', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
