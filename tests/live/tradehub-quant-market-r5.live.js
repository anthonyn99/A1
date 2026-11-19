// TradeHub Quant refinements R5 (A1-Priv docs/TradeHub/quant/r1-05.md): the
// Market tab's universe picker in the real page, quant-api played here.
//
//   1. the tab says what it measures; Regime shows a row of universes
//   2. picking one the snapshot lacks measures it here: one /bars per member, once
//   3. one the snapshot holds costs no request
//   4. the choice is synced (market_prefs in the layout doc, the sync pill) and kept across a reload
//   5. Sectors: All / My sectors, tied to the picker; Streaks follows it
//   6. Neo Quant picks a universe by name
//   7. 1280, 820 and 390 px: no sideways scroll, the row stays in its card
//
// Run: node tests/live/tradehub-quant-market-r5.live.js   (own CDP_PORT)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, FIXTURE } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const DESK_W = 1280 + 224, TAB_W = 820 + 224;
// Nasdaq 100's numbers as a runner's snapshot would carry them (core/universe-snap.js measureUniverse).
const day = (i) => `2025-0${1 + i}-1${i}`;
const NDX = { id: 'ndx', name: 'Nasdaq 100', bench: 'QQQ', n: 101, have: 101,
  regime: { label: 'Risk-on uptrend', score: 71.4, since: 3, missing: [], vix: 15.2, parts: { trend: 82, breadth: 70, vol: 61, credit: 50 } },
  breadth: { members: 101, above20: 0.61, above50: 0.62, above200: 0.7, adv: 60, dec: 40, unch: 1, highs: 5, lows: 1, mcclellan: 12.4, thrust: null },
  analogs: { used: ['trend', 'breadth', 'vol'], avg: { 1: 0.001, 5: 0.004, 20: 0.01 }, up: { 1: 0.6, 5: 0.6, 20: 0.8 },
    days: [0, 1, 2, 3, 4].map((i) => ({ date: day(i), label: 'Constructive', score: 55 + i, next: { 1: 0.002 * i, 5: 0.004, 20: -0.01 + 0.005 * i } })) } };

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const { js, until, size, boot, tab } = driver(c);
  const bars = () => api.asked.filter((a) => a.p === '/bars').map((a) => new URLSearchParams(a.q || '').get('symbol'));
  const pick = (id) => js(`var s=document.querySelector('[data-mk-universe]'); s.value='${id}'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
  const text = (sel) => js(`var e=document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : '';`);
  const layoutDoc = () => js(`return JSON.stringify((window.__fakeFs.docs['dashboards/tradehub_layout']||{}).market_prefs||null);`);

  console.log('\nWhat the tab measures');
  await size(DESK_W, 900);
  await boot({ quant: true });
  await tab('market');
  ok('the picker sits above the cards, on the S&P 100 by default', await until(`document.querySelector('[data-mk-score]') && document.querySelector('[data-mk-universe]') && document.querySelector('[data-mk-universe]').value === 'sp100'`, 15000));
  ok('...grouped Indexes / S&P 500 sectors / Mine, 15 choices', await js(`var s=document.querySelector('[data-mk-universe]'); return s.options.length === 15 && [...s.querySelectorAll('optgroup')].map(function(g){return g.label;}).join() === 'Indexes,S&P 500 sectors,Mine';`));
  ok('the line says it: "Measuring S&P 100: 101 stocks …, trend of SPY"', /^Measuring S&P 100: \d+ stocks .*trend of SPY$/.test(await text('[data-mk-uni-line]')), await text('[data-mk-uni-line]'));
  ok('Regime: a row of S&P 100, Nasdaq 100 and Semis, the S&P 100 picked', await js(`var b=[...document.querySelectorAll('[data-mk-uni-row] [data-uni]')]; return b.map(function(x){return x.dataset.uni;}).join() === 'sp100,ndx,semis' && b[0].classList.contains('is-on') && /\\d/.test(b[0].querySelector('b').textContent) && b[1].querySelector('b').textContent === '—';`));
  ok('...and says what it is measured on, VIX and credit market-wide', /Measured on S&P 100: the trend of SPY, the breadth of its \d+ stocks; the VIX and credit are market-wide\./.test(await text('[data-mk-measured]')), await text('[data-mk-measured]'));
  ok('Breadth and Days like today name the universe', /^S&P 100 · \d+ stocks/.test(await text('[data-mk-breadth-of]')) && /^SPY after the 5 past days when S&P 100 looked most like today/.test(await text('[data-mk-analogs-of]')));

  console.log('\nPicking one the snapshot lacks');
  api.asked.length = 0;
  await pick('semis');
  ok('the line says it is reading the stocks\' histories while it measures', await until(`/reading \\d+ daily histories/.test(document.querySelector('[data-mk-uni-line]').innerText) || /measured on this device/.test(document.querySelector('[data-mk-uni-line]').innerText)`, 3000));
  ok('Semis is measured here: Regime, Breadth and Days like today follow', await until(`/measured on this device/.test(document.querySelector('[data-mk-uni-line]').innerText) && /^Semis · \\d+ stocks/.test((document.querySelector('[data-mk-breadth-of]')||{}).innerText||'')`, 20000), await text('[data-mk-uni-line]'));
  const semisAsked = bars();
  ok('...from one /bars per member, the SOXX fund and the VIX (about 27), nothing else', semisAsked.length >= 25 && semisAsked.length <= 2 * 27 && semisAsked.includes('SOXX') && semisAsked.includes('NVDA') && semisAsked.includes('^VIX') && !semisAsked.includes('AKAM'), semisAsked.length + ' ' + semisAsked.slice(0, 8).join());
  ok('Regime: measured on Semis, the trend of SOXX; its chip picked and scored', /Measured on Semis: the trend of SOXX/.test(await text('[data-mk-measured]')) && await js(`var b=document.querySelector('[data-mk-uni-row] [data-uni="semis"]'); return b.classList.contains('is-on') && /\\d/.test(b.querySelector('b').textContent);`));
  ok('Days like today: SOXX after the days Semis looked like today', /^SOXX after the 5 past days when Semis looked most like today/.test(await text('[data-mk-analogs-of]')), await text('[data-mk-analogs-of]'));
  ok('Sectors marks the SOXX tile', await js(`return document.querySelector('[data-mk-sectors] .mk-tile[data-sym="SOXX"]').classList.contains('is-picked') && document.querySelectorAll('[data-mk-sectors] .mk-tile.is-picked').length === 1;`));
  const n1 = bars().length;
  await pick('sp100'); await sleep(300); await pick('semis');
  ok('picking it again costs no request (measured once per snapshot bar)', await until(`/^Semis/.test((document.querySelector('[data-mk-breadth-of]')||{}).innerText||'')`, 5000) && bars().length === n1, bars().length - n1);

  console.log('\nSynced');
  ok('the pill says Syncing…, then Synced', await until(`document.querySelector('[data-mk-sync]').classList.contains('ok') || /Synced/.test(document.querySelector('[data-mk-sync]').innerText)`, 6000), await js(`return document.querySelector('[data-mk-sync]').className + ' ' + document.querySelector('[data-mk-sync]').innerText;`));
  ok('...market_prefs in the ONE layout doc says semis', await until(`((window.__fakeFs.docs['dashboards/tradehub_layout']||{}).market_prefs||{}).universe === 'semis'`, 5000), await layoutDoc());
  await boot({ keep: true }); await tab('market');
  ok('after a reload the tab still measures Semis', await until(`document.querySelector('[data-mk-universe]') && document.querySelector('[data-mk-universe]').value === 'semis' && /^Semis/.test((document.querySelector('[data-mk-breadth-of]')||{}).innerText||'')`, 20000), await text('[data-mk-uni-line]'));
  // The layout doc is read once a load (like Charts' settings): another device's pick shows at the next open.
  await js(`window.__fakeFs.remote('dashboards/tradehub_layout', Object.assign({}, window.__fakeFs.docs['dashboards/tradehub_layout'], { market_prefs: { universe: 'XLE' } })); localStorage.removeItem('tradehub_layout'); 1`);
  await boot({ keep: true }); await tab('market');
  ok('picked on another device: this one opens on it (Energy)', await until(`document.querySelector('[data-mk-universe]').value === 'XLE' && /^Measuring Energy/.test(document.querySelector('[data-mk-uni-line]').innerText)`, 15000), await text('[data-mk-uni-line]'));

  console.log('\nOne the snapshot holds');
  api.state.snapshot = { ...FIXTURE, universes: { ndx: NDX } };
  await boot({ keep: true }); await tab('market');
  await until(`document.querySelector('[data-mk-score]')`, 15000);
  api.asked.length = 0;
  await js(`document.querySelector('[data-mk-uni-row] [data-uni="ndx"]').click(); 1`);
  ok('a regime chip picks it; the stored numbers show at once', await until(`document.querySelector('[data-mk-universe]').value === 'ndx' && document.querySelector('[data-mk-regime]').dataset.mkRegime === 'Risk-on uptrend'`, 5000));
  ok('...with no request, and no "measured on this device"', bars().length === 0 && !/measured on this device/.test(await text('[data-mk-uni-line]')), bars().join());
  ok('...its chip already showed its score before it was picked', await js(`return document.querySelector('[data-mk-uni-row] [data-uni="ndx"] b').textContent === '71';`));

  console.log('\nSectors and Streaks');
  await js(`document.querySelector('[data-mk-sectors-mode="mine"]').click(); 1`);
  ok('My sectors keeps only the sectors of the watchlist\'s stocks', await until(`document.querySelector('[data-mk-sectors="mine"]') && document.querySelectorAll('[data-mk-sectors] .mk-tile').length < 12 && document.querySelectorAll('[data-mk-sectors] .mk-tile').length > 0`, 3000), await js(`return document.querySelectorAll('[data-mk-sectors] .mk-tile').length;`));
  ok('...Streaks\' Sectors section follows (My sectors)', /My sectors/i.test(await text('[data-mk-streak-sec="sectors"]')) && await js(`return document.querySelectorAll('[data-mk-streak-group="sectors"] tr[data-sym]').length === document.querySelectorAll('[data-mk-sectors] .mk-tile').length;`));
  ok('...and is synced too', await until(`((window.__fakeFs.docs['dashboards/tradehub_layout']||{}).market_prefs||{}).sectors === 'mine'`, 5000), await layoutDoc());
  await js(`document.querySelector('[data-mk-sectors-mode="all"]').click(); 1`);
  ok('All sectors brings the 12 back', await until(`document.querySelectorAll('[data-mk-sectors="all"] .mk-tile').length === 12`, 3000));

  console.log('\nMy watchlist, and Neo Quant');
  api.asked.length = 0;
  await pick('mine');
  ok('My watchlist is measured from its own stocks against SPY', await until(`/^My watchlist · \\d+ stocks/.test((document.querySelector('[data-mk-breadth-of]')||{}).innerText||'') && /trend of SPY/.test(document.querySelector('[data-mk-uni-line]').innerText)`, 20000), await text('[data-mk-uni-line]'));
  ok('...no crypto or index symbol asked as a member', !bars().some((s) => /USD$|^\^(?!VIX)/.test(s)), bars().join());
  const said = JSON.parse(await js(`var R = (await import('/A1/TradeHub/neo/registry.js')).Registry; var r = await R.get('market').actions.universe.run({ name: 'health care' }); return JSON.stringify(r);`));
  ok('Neo Quant: "health care" → the tab measures Health Care', await until(`document.querySelector('[data-mk-universe]').value === 'XLV'`, 5000) && /Health Care/.test(said.shown || ''), JSON.stringify(said));
  const reader = JSON.parse(await js(`var R = (await import('/A1/TradeHub/neo/registry.js')).Registry; return JSON.stringify(await R.get('market').readers.universe.read());`));
  ok('...and can read what is measured', reader.id === 'XLV' && reader.bench === 'XLV' && reader.members > 50, JSON.stringify(reader).slice(0, 200));
  const bad = JSON.parse(await js(`var R = (await import('/A1/TradeHub/neo/registry.js')).Registry; return JSON.stringify(await R.get('market').actions.universe.run({ name: 'bananas' }));`));
  ok('...an unknown name gets the list of choices, the pick unchanged', /No universe called bananas\. Choices: S&P 100, Nasdaq 100, Semis/.test(bad.error || '') && await js(`return document.querySelector('[data-mk-universe]').value === 'XLV';`));

  console.log('\nEvery width');
  for (const [w, hgt, name] of [[DESK_W, 900, 'desktop'], [TAB_W, 1000, 'tablet'], [390, 844, 'phone']]) {
    await size(w, hgt); await sleep(700);
    ok(`${name}: the picker and its line are on screen, no sideways scroll`, await js(`var s=document.querySelector('[data-mk-universe]').getBoundingClientRect(); return s.width > 60 && s.right <= innerWidth + 1 && document.scrollingElement.scrollWidth <= innerWidth + 1 && document.querySelector('[data-mk-uni-line]').getBoundingClientRect().right <= innerWidth + 1;`),
      await js(`return document.scrollingElement.scrollWidth + ' / ' + innerWidth;`));
    ok(`${name}: the regime row stays inside its card`, await js(`var card=document.querySelector('.lay-card[data-card="regime"]').getBoundingClientRect(); return [...document.querySelectorAll('[data-mk-uni-row] [data-uni]')].every(function(b){var r=b.getBoundingClientRect(); return r.left >= card.left - 1 && r.right <= card.right + 1;});`));
  }

  console.log('\nSide effects');
  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
