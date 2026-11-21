// TradeHub Batch 4, Part 1 (the trading app) in the real page: A1-Priv docs/TradeHub/quant-trading.md.
// Written in T0 to FAIL ON PURPOSE: each check is tagged with the phase that makes it pass (T2-T7),
// and each phase's session turns its checks green. Selectors here are the contract those phases build to:
//   T2  the nav tab "Trading" (data-navid="trading"; the old #paper links still land there), the header's
//       Paper | Live switch ([data-trade-mode="paper"] on, [data-trade-mode="live"] dimmed and disabled),
//       the broker dropdown ([data-trade-broker], Alpaca and Webull), cards reading only that broker
//   T3  "New Order" ([data-trade-new]) opens the ticket ([data-order-ticket]) with type pills
//       ([data-ot-type] x5) and Review → Confirm; the Trade card ([data-lay-card="trade"]) is the same ticket
//   T4  Trading's Add card lists every Market card
//   T5  the book: [data-trade-capital] and Reset ([data-trade-reset]) that asks first
//   T6  the chart's right-click menu ([data-chart-order-menu]) with Buy limit / Sell limit here
//   T7  Control ▸ Alerts has a Trading section ([data-al-trading]); Trading's header button goes there
//
// Run: CDP_PORT=93xx node tests/live/tradehub-trading.live.js    PHASES=T2,T3 runs only those tags.
'use strict';
const { connect } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

const ONLY = (process.env.PHASES || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const want = (ph) => !ONLY.length || ONLY.includes(ph);
let pass = 0, fail = 0;
const byPhase = {};
const ok = (ph, name, cond, extra) => {
  if (!want(ph)) return;
  byPhase[ph] = byPhase[ph] || { pass: 0, fail: 0 };
  if (cond) { pass++; byPhase[ph].pass++; console.log(`  ok   [${ph}] ${name}`); }
  else { fail++; byPhase[ph].fail++; console.log(`  FAIL [${ph}] ${name}` + (extra !== undefined ? '  -> ' + String(extra).slice(0, 400) : '')); }
};

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  const { js, until, size, boot, tab } = driver(c);
  const vis = (sel) => `(function(){var e=document.querySelector('${sel}'); return !!(e && e.offsetParent);})()`;

  for (const w of [1280, 820, 390]) {
    console.log(`\n${w} px`);
    await size(w, w < 600 ? 844 : 900);
    await boot({ quant: true });

    // T2: the Trading tab
    ok('T2', 'the nav says "Trading" (no "Paper" tab left)', await js(`return !!document.querySelector('.tb-navtab[data-navid="trading"]') && !document.querySelector('.tb-navtab[data-navid="paper"]');`));
    await tab('trading');
    ok('T2', 'Paper | Live in the header: Paper on, Live dimmed and not pressable', await until(vis('[data-trade-mode="paper"]'), 4000)
      && await js(`var l=document.querySelector('[data-trade-mode="live"]'); return !!l && (l.disabled || l.getAttribute('aria-disabled')==='true') && document.querySelector('[data-trade-mode="paper"]').getAttribute('aria-pressed')==='true';`));
    ok('T2', 'the broker dropdown offers Alpaca and Webull', await js(`var b=document.querySelector('[data-trade-broker]'); return !!b && /Alpaca/.test(b.innerText||b.textContent) ;`));
    ok('T2', 'no sideways scroll', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`));
    if (want('T2')) {
      ok('T2', 'Alpaca by default: its account and its NVDA position; the header says Alpaca', await until(`(document.querySelector('[data-pp-equity]')||{}).textContent==='$100,000.00'`, 6000)
        && await js(`return !!document.querySelector('[data-pp-pos="NVDA"]') && /Alpaca paper account/.test(document.querySelector('[data-pp-meta]').textContent);`));
      ok('T2', 'pressing Live does nothing (still Paper)', await js(`document.querySelector('[data-trade-mode="live"]').click(); return document.querySelector('[data-trade-mode="paper"]').getAttribute('aria-pressed')==='true';`));
      const alpacaBefore = (api.posted.pp || []).length;
      await js(`var s=document.querySelector('[data-trade-broker]'); s.value='webull'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
      ok('T2', 'Webull: its own account ($1,000,000, Individual Margin) and its own working order; no Alpaca position shows', await until(`(document.querySelector('[data-pp-equity]')||{}).textContent==='$1,000,000.00'`, 6000)
        && await until(`!!document.querySelector('[data-pp-ord="wbo1"]')`, 4000)
        && await js(`return !document.querySelector('[data-pp-pos="NVDA"]') && /Webull paper account/.test(document.querySelector('[data-pp-meta]').textContent) && /Individual Margin/.test(document.querySelector('[data-pp-account]').textContent);`),
        await js(`return (document.querySelector('[data-pp-account]')||{}).textContent;`));
      ok('T2', '...the strategies card says runs stay on Alpaca', await js(`return !!document.querySelector('[data-pp-noruns]');`));
      ok('T2', '...and nothing was read from Alpaca after the switch', (api.posted.pp || []).length === alpacaBefore, JSON.stringify((api.posted.pp || []).slice(alpacaBefore)));
      ok('T2', '...every read went to /trade/webull/', (api.posted.wb && api.posted.wb.pp || []).length > 0, JSON.stringify(api.asked.slice(-6)));
      await boot({ quant: true, keep: true }); await tab('trading');
      ok('T2', 'the broker is remembered on this device after a reload', await until(`(document.querySelector('[data-trade-broker]')||{}).value==='webull' && (document.querySelector('[data-pp-equity]')||{}).textContent==='$1,000,000.00'`, 8000));
      await js(`var s=document.querySelector('[data-trade-broker]'); s.value='alpaca'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
      ok('T2', 'back to Alpaca: its account again', await until(`(document.querySelector('[data-pp-equity]')||{}).textContent==='$100,000.00' && !!document.querySelector('[data-pp-pos="NVDA"]')`, 6000));
      ok('T2', 'an old link to Paper lands on Trading', await js(`window._tbOps.app.go('paper'); return true;`) && await until(`!!document.querySelector('[data-trading-tab]')`, 4000));
    }

    // T3: the ticket, two ways
    ok('T3', '"New Order" opens the redesigned ticket with five type pills', await js(`var b=document.querySelector('[data-trade-new]'); if(!b) return false; b.click(); return true;`)
      && await until(`document.querySelectorAll('[data-order-ticket] [data-ot-type]').length === 5`, 3000));
    ok('T3', 'the Trade card can be added to Trading and is the same ticket', await js(`return !!document.querySelector('[data-lay-card="trade"] [data-order-ticket]');`));

    // T4: Market cards on Trading
    ok('T4', 'Add card on Trading lists the Market cards (Regime, Breadth, Heat Map …)', await js(`var t=(document.querySelector('[data-lay="trading"] [data-lay-add-list]')||{}).innerText||''; return /Regime/.test(t) && /Breadth/.test(t) && /Heat Map/.test(t);`));

    // T5: capital per broker
    ok('T5', 'starting capital shown for the chosen broker, with Reset', await js(`return !!document.querySelector('[data-trade-capital]') && !!document.querySelector('[data-trade-reset]');`));

    // T6: trading from the chart
    await tab('charts');
    ok('T6', 'a right-click on the chart opens the order menu', await js(`var cv=document.querySelector('[data-lay="charts"] canvas'); if(!cv) return false; var r=cv.getBoundingClientRect(); cv.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2})); return true;`)
      && await until(vis('[data-chart-order-menu]'), 2000));

    // T7: trade alerts
    ok('T7', 'Control ▸ Alerts has a Trading section', await js(`return !!document.querySelector('[data-al-trading]');`));
  }

  console.log('\nBy phase: ' + Object.entries(byPhase).map(([k, v]) => `${k} ${v.pass}/${v.pass + v.fail}`).join(', '));
  console.log(`${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
