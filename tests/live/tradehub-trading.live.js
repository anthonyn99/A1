// TradeHub Batch 4, Part 1 (the trading app) in the real page: A1-Priv docs/TradeHub/quant-trading.md.
// Written in T0 to FAIL ON PURPOSE: each check is tagged with the phase that makes it pass (T2-T7),
// and each phase's session turns its checks green. Selectors here are the contract those phases build to:
//   T2  the nav tab "Trading" (data-navid="trading"; the old #paper links still land there), the header's
//       Paper | Live switch ([data-trade-mode="paper"] on, [data-trade-mode="live"] dimmed and disabled),
//       the broker dropdown ([data-trade-broker], Alpaca and Webull), cards reading only that broker
//   T3  "New Order" ([data-trade-new]) opens the ticket ([data-order-ticket]) with type pills
//       ([data-ot-type] x5) and Review → Confirm; the Trade card (.lay-card[data-card="trade"], Add card ▸ Trade) is the same ticket
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
  const { js, until, size, boot, tab, shot } = driver(c);
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
    const OT = `document.querySelector('.ot-scrim [data-order-ticket]')`;
    const otSet = (k, v, root = OT) => js(`var i=${root}.querySelector('[data-ot-${k}]'); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
    const otPress = (sel, root = OT) => js(`var b=${root}.querySelector('${sel}'); b.click(); 1`);
    const setBrokerTo = (b) => js(`var s=document.querySelector('[data-trade-broker]'); if (s.value!=='${b}') { s.value='${b}'; s.dispatchEvent(new Event('change',{bubbles:true})); } 1`);
    if (want('T3')) { await tab('trading'); await setBrokerTo('alpaca'); await until(`(document.querySelector('[data-pp-equity]')||{}).textContent==='$100,000.00'`, 6000); }
    ok('T3', '"New Order" opens the redesigned ticket with five type pills', await js(`var b=document.querySelector('[data-trade-new]'); if(!b) return false; b.click(); return true;`)
      && await until(`document.querySelectorAll('[data-order-ticket] [data-ot-type]').length === 5`, 3000));
    if (want('T3')) {
      ok('T3', 'Buy | Sell, the symbol with Bid / Ask / Last, PAPER · Alpaca', await js(`var t=${OT}; return !!t.querySelector('[data-ot-side="buy"]') && !!t.querySelector('[data-ot-side="sell"]') && /Bid/.test(t.querySelector('[data-ot-quote]').innerText) && /Last/.test(t.querySelector('[data-ot-quote]').innerText) && /PAPER · Alpaca/.test(t.querySelector('[data-ot-paper]').textContent);`));
      ok('T3', 'the popup fits the screen' + (w < 600 ? ' as a bottom sheet' : ', centred'), await js(`var r=${OT}.getBoundingClientRect(); return r.width <= innerWidth && ${w < 600 ? 'Math.abs(r.bottom - innerHeight) < 2 && r.width >= innerWidth - 1' : 'r.left > 0 && r.bottom < innerHeight'};`), await js(`return JSON.stringify(${OT}.getBoundingClientRect());`));
      await otSet('symbol', 'AMD'); await otPress('[data-ot-type="limit"]'); await otSet('limit', '140'); await otSet('size', '10');
      await otPress('[data-ot-tp]'); await otPress('[data-ot-sl]'); await otSet('tpPrice', '150'); await otSet('slPrice', '135');
      await otPress('[data-ot-step="limit+"]'); const up1 = await js(`return ${OT}.querySelector('[data-ot-limit]').value;`);
      await otPress('[data-ot-step="limit-"]'); const dn1 = await js(`return ${OT}.querySelector('[data-ot-limit]').value;`);
      ok('T3', 'price steppers move the limit a cent', up1 === '140.01' && dn1 === '140.00', up1 + ' / ' + dn1);
      ok('T3', 'Take profit / Stop loss show the $ at each and the reward to risk; cost and buying power after', await js(`var t=${OT}; return t.querySelector('[data-ot-tpgain]').textContent==='+$100.00' && t.querySelector('[data-ot-slloss]').textContent==='−$50.00' && t.querySelector('[data-ot-rr]').textContent==='Reward to risk 2.00' && t.querySelector('[data-ot-cost]').textContent==='$1,400.00' && /\\$/.test(t.querySelector('[data-ot-bp]').textContent);`), await js(`return ${OT}.innerText.slice(0, 500);`));
      await shot('t3-ticket-' + w);
      const before = (api.posted.pp || []).filter(([m, p]) => m === 'POST' && /orders$/.test(p)).length;
      await otPress('[data-ot-go]');
      ok('T3', 'Review reads it back (PAPER · Alpaca) and sends nothing yet', await js(`return /^PAPER · Alpaca: Buy 10 shares of AMD with a limit at 140\\.00, then a target at 150\\.00 and a stop at 135\\.00/.test(${OT}.querySelector('[data-ot-readback]').textContent) && ${OT}.querySelector('[data-ot-go]').textContent==='Place on paper · Alpaca';`)
        && (api.posted.pp || []).filter(([m, p]) => m === 'POST' && /orders$/.test(p)).length === before, await js(`return ${OT}.querySelector('[data-ot-readback]').textContent;`));
      await otPress('[data-ot-go]');
      ok('T3', 'Confirm: one bracket order to Alpaca paper, as Tony\'s; the popup closes', await until(`!${OT}`, 5000) && (() => { const o = (api.posted.pp || []).filter(([m, p]) => m === 'POST' && /orders$/.test(p)); const last = o[o.length - 1]; return o.length === before + 1 && last[2].who === 'tony' && last[2].order.order_class === 'bracket' && last[2].order.qty === 10; })(), JSON.stringify((api.posted.pp || []).slice(-2)));
      // Webull: what it lacks is not offered.
      await setBrokerTo('webull'); await until(`(document.querySelector('[data-pp-equity]')||{}).textContent==='$1,000,000.00'`, 6000);
      await js(`document.querySelector('[data-trade-new]').click(); 1`); await until(`!!${OT}`, 3000);
      ok('T3', 'Webull: PAPER · Webull; no $ size on a market order', await js(`return /PAPER · Webull/.test(${OT}.querySelector('[data-ot-paper]').textContent) && !${OT}.querySelector('[data-ot-sizeKind="dollars"]') && !!${OT}.querySelector('[data-ot-sizeKind="shares"]');`));
      await otPress('[data-ot-type="trailing_stop"]');
      ok('T3', '...a trailing stop: GTC not pressable, Day chosen, no Take profit / Stop loss', await js(`var g=${OT}.querySelector('[data-ot-tif="gtc"]'); return g.disabled && ${OT}.querySelector('[data-ot-tif="day"]').getAttribute('aria-pressed')==='true' && !${OT}.querySelector('[data-ot-tp]');`));
      await otPress('[data-ot-type="limit"]'); await otSet('symbol', 'AAPL'); await otSet('limit', '50'); await otSet('size', '1');
      const wbBefore = ((api.posted.wb && api.posted.wb.pp) || []).filter(([m, p]) => m === 'POST' && /orders$/.test(p)).length;
      await otPress('[data-ot-go]'); await otPress('[data-ot-go]');
      ok('T3', '...an order placed under Webull goes to Webull only', await until(`!${OT}`, 5000) && ((api.posted.wb && api.posted.wb.pp) || []).filter(([m, p]) => m === 'POST' && /orders$/.test(p)).length === wbBefore + 1);
      await setBrokerTo('alpaca'); await until(`(document.querySelector('[data-pp-equity]')||{}).textContent==='$100,000.00'`, 6000);
      // The Trade card: Add card ▸ Trade.
      ok('T3', 'Add card offers Trade', await js(`var s=document.querySelector('[data-trading-tab] [data-lay-add]'); return !!s && [].some.call(s.options, function(o){return o.value==='trade';});`));
      await js(`var s=document.querySelector('[data-trading-tab] [data-lay-add]'); s.value='trade'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
    }
    const CARD = `document.querySelector('.lay-card[data-card="trade"] [data-order-ticket]')`;
    ok('T3', 'the Trade card can be added to Trading and is the same ticket', await until(`!!${CARD} && ${CARD}.querySelectorAll('[data-ot-type]').length === 5`, 3000));
    if (want('T3')) {
      await otSet('symbol', 'MSFT', CARD); await otPress('[data-ot-type="limit"]', CARD); await otSet('limit', '400', CARD); await otSet('size', '2', CARD);
      const n0 = (api.posted.pp || []).filter(([m, p]) => m === 'POST' && /orders$/.test(p)).length;
      await otPress('[data-ot-go]', CARD); await otPress('[data-ot-go]', CARD);
      await js(`${CARD}.scrollIntoView({block:'center'}); 1`); await shot('t3-card-' + w);
      ok('T3', '...it places to Alpaca paper and stays open, saying so', await until(`/Sent to Alpaca paper/.test(${CARD}.querySelector('[data-ot-msg]').textContent)`, 5000) && (api.posted.pp || []).filter(([m, p]) => m === 'POST' && /orders$/.test(p)).length === n0 + 1);
      await setBrokerTo('webull');
      ok('T3', '...it follows the broker dropdown (PAPER · Webull)', await until(`/PAPER · Webull/.test(${CARD}.querySelector('[data-ot-paper]').textContent)`, 4000));
      await setBrokerTo('alpaca');
      ok('T3', 'no sideways scroll with the card', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`));
      // Leave the layout as it was for the next width.
      await js(`var b=document.querySelector('.lay-card[data-card="trade"] [data-act="hide"]'); if (b) b.click(); 1`);
    }

    // T4: Market cards on Trading
    // (T3's note: the layout id stays `paper`; Add card is the header's select.)
    const ADD = `document.querySelector('[data-trading-tab] [data-lay-add]')`;
    const MARKET_IDS = ['regime', 'breadth', 'sectors', 'rotation', 'streaks', 'strength', 'volume', 'analogs', 'macro', 'heatmap'];
    if (want('T4')) {
      await tab('market'); await until(`!!document.querySelector('.lay-card[data-card="regime"]') && !/Reading the market/.test(document.querySelector('.lay-card[data-card="regime"]').innerText)`, 8000);
      await tab('trading'); await until(`!!document.querySelector('[data-trading-tab]')`, 4000);
    }
    const snapReads = () => api.asked.filter((a) => a.p === '/snapshot' && a.method === 'GET').length;
    const reads0 = snapReads();
    ok('T4', 'Add card on Trading lists every Market card (Regime … Macro, Heat Map)', await js(`var s=${ADD}; if(!s) return false; var v=[].map.call(s.options, function(o){return o.value;}); return ${JSON.stringify(MARKET_IDS)}.every(function(id){return v.indexOf(id)>=0;});`),
      await js(`var s=${ADD}; return s ? [].map.call(s.options, function(o){return o.value;}).join() : 'no select';`));
    ok('T4', '...none of them shows until added (no clutter; nothing read for them)', await js(`return !document.querySelector('[data-trading-tab] .lay-card[data-card="regime"]') && !document.querySelector('[data-trading-tab] .lay-card[data-card="macro"]');`) && snapReads() === reads0);
    if (want('T4')) {
      await js(`var s=${ADD}; s.value='regime'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
      const RG = `document.querySelector('[data-trading-tab] .lay-card[data-card="regime"]')`;
      ok('T4', 'Regime added to Trading draws the market snapshot', await until(`!!${RG} && ${RG}.innerText.length > 40 && !/Reading the market|could not be drawn/.test(${RG}.innerText)`, 6000), await js(`return ${RG} ? ${RG}.innerText.slice(0, 200) : 'none';`));
      ok('T4', '...from the snapshot Market already read (no second /snapshot)', snapReads() === reads0, snapReads() - reads0);
      ok('T4', '...its "?" says the universe is picked on Market', await js(`var b=${RG}.querySelector('[data-lay-help]'); return !!b && /picked on Market/.test(b.title);`));
      await js(`var s=${ADD}; s.value='sectors'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
      const SC = `document.querySelector('[data-trading-tab] .lay-card[data-card="sectors"]')`;
      ok('T4', 'Sectors added too: its tiles, live prices on the shared feed', await until(`!!${SC} && ${SC}.querySelectorAll('[data-sym]').length >= 11`, 5000));
      ok('T4', 'no sideways scroll with Market cards on Trading', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`));
      await js(`${RG}.scrollIntoView({block:'center'}); 1`); await shot('t4-market-cards-' + w);
      // Leave the layout as it was for the next width.
      await js(`['regime','sectors'].forEach(function(id){var b=document.querySelector('[data-trading-tab] .lay-card[data-card="'+id+'"] [data-act="hide"]'); if (b) b.click();}); 1`);
    }

    // T5: capital per broker
    const EQ = `(document.querySelector('[data-pp-equity]')||{}).textContent`;
    const ACC = `(document.querySelector('[data-pp-account]')||{innerText:''}).innerText`;
    const DLG = (m) => `document.querySelector('.ot-scrim [data-book-dialog="${m}"]')`;
    const typeIn = (sel, v) => js(`var i=document.querySelector('${sel}'); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
    const keep = JSON.parse(JSON.stringify({ positions: api.state.pp.positions, orders: api.state.pp.orders }));
    if (want('T5')) {
      await tab('trading'); await setBrokerTo('alpaca');
      await js(`if (window._tbOps.trading) window._tbOps.trading.refresh(); 1`);
      await until(`${EQ}==='$100,000.00'`, 6000);
    }
    ok('T5', 'the Account card shows the starting capital ($100,000, Alpaca\'s default) with Capital… and Reset…', await until(`(document.querySelector('[data-trade-capital]')||{}).getAttribute && document.querySelector('[data-trade-capital]').getAttribute('data-trade-capital')==='100000'`, 4000)
      && await js(`return !!document.querySelector('[data-trade-reset]') && !!document.querySelector('[data-trade-capital-edit]') && !document.querySelector('[data-trade-broker-equity]');`));
    if (want('T5')) {
      await js(`document.querySelector('[data-trade-capital-edit]').click(); 1`);
      ok('T5', 'Capital… opens its dialog (PAPER), the capital filled in' + (w < 600 ? ', a bottom sheet' : ''), await until(`!!${DLG('edit')}`, 3000)
        && await js(`var d=${DLG('edit')}, r=d.getBoundingClientRect(); return d.querySelector('[data-book-capital]').value==='100000' && /PAPER/.test(d.innerText) && r.width <= innerWidth && ${w < 600 ? 'Math.abs(r.bottom - innerHeight) < 2' : 'r.left > 0'};`));
      await typeIn('[data-book-capital]', '50');
      await js(`document.querySelector('[data-book-go]').click(); 1`);
      ok('T5', '...under $1,000 is refused there, in words, and nothing is sent', await until(`/between/.test(document.querySelector('[data-book-errors]').textContent)`, 2000) && !(api.posted.pp || []).some(([m, p]) => p === '/paper/book'));
      await typeIn('[data-book-capital]', '25000');
      await shot('t5-capital-' + w);
      await js(`document.querySelector('[data-book-go]').click(); 1`);
      ok('T5', 'Save: $25,000 shown as equity; the capital says $25,000; Alpaca\'s own $100,000 is said beside it', await until(`${EQ}==='$25,000.00' && !${DLG('edit')}`, 5000)
        && await js(`return document.querySelector('[data-trade-capital]').getAttribute('data-trade-capital')==='25000' && /\\$100,000\\.00/.test(document.querySelector('[data-trade-broker-equity]').textContent);`), await js(`return ${EQ};`));
      const put = (api.posted.pp || []).filter(([m, p]) => m === 'PUT' && p === '/paper/book').pop();
      ok('T5', '...one PUT to the Alpaca book, as Tony\'s', !!put && put[2].capital === 25000 && put[2].who === 'tony', JSON.stringify(put));
      ok('T5', '...buying power scaled to the capital (392,000 × ¼ = $98,000)', await js(`return /\\$98,000\\.00/.test(${ACC});`), await js(`return ${ACC};`));
      // A buying-power cap the ticket enforces.
      await js(`document.querySelector('[data-trade-capital-edit]').click(); 1`); await until(`!!${DLG('edit')}`, 3000);
      await typeIn('[data-book-bpcap]', '5000'); await js(`document.querySelector('[data-book-go]').click(); 1`);
      ok('T5', 'a $5,000 buying-power cap: shown on the card', await until(`!!document.querySelector('[data-trade-bpcap]') && /\\$5,000/.test(document.querySelector('[data-trade-bpcap]').textContent)`, 5000));
      await js(`document.querySelector('[data-trade-new]').click(); 1`); await until(`!!${OT}`, 3000);
      await otSet('symbol', 'AAPL'); await otPress('[data-ot-type="limit"]'); await otSet('limit', '100'); await otSet('size', '60');
      await otPress('[data-ot-go]');
      ok('T5', 'the ticket refuses $6,000 over the $5,000 buying power, and sends nothing', await until(`/More than the buying power/.test(${OT}.querySelector('[data-ot-errors]').textContent)`, 3000)
        && !(api.posted.pp || []).some(([m, p, b]) => m === 'POST' && /orders$/.test(p) && b && b.order && b.order.symbol === 'AAPL' && b.order.qty === 60), await js(`return ${OT}.querySelector('[data-ot-errors]').textContent;`));
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
      // Each broker its own book.
      await setBrokerTo('webull');
      ok('T5', 'Webull keeps its own book: $1,000,000 (its default), no cap, untouched by Alpaca\'s', await until(`${EQ}==='$1,000,000.00' && (document.querySelector('[data-trade-capital]')||{getAttribute:function(){}}).getAttribute('data-trade-capital')==='1000000'`, 6000)
        && await js(`return !document.querySelector('[data-trade-bpcap]') && !document.querySelector('[data-trade-broker-equity]');`));
      await js(`document.querySelector('[data-trade-reset]').click(); 1`); await until(`!!${DLG('reset')}`, 3000);
      ok('T5', '...its Reset says Webull\'s own balance resets only on its website', await js(`return /My Account/.test(${DLG('reset')}.innerText) && /Webull/.test(${DLG('reset')}.innerText);`));
      await js(`document.querySelector('[data-book-cancel]').click(); 1`);
      await setBrokerTo('alpaca'); await until(`${EQ}==='$25,000.00'`, 6000);
      // Reset.
      await js(`document.querySelector('[data-trade-reset]').click(); 1`);
      ok('T5', 'Reset… asks first: what it does, the capital ($25,000) and "Reset to $25,000"', await until(`!!${DLG('reset')}`, 3000)
        && await js(`var d=${DLG('reset')}; return /Cancels every open Alpaca paper order, closes every position/.test(d.innerText) && d.querySelector('[data-book-capital]').value==='25000' && d.querySelector('[data-book-go]').textContent==='Reset to $25,000';`));
      await typeIn('[data-book-capital]', '50000'); await typeIn('[data-book-bpcap]', '');
      ok('T5', '...the button follows the capital typed ("Reset to $50,000")', await js(`return document.querySelector('[data-book-go]').textContent==='Reset to $50,000';`));
      await shot('t5-reset-' + w);
      await js(`document.querySelector('[data-book-go]').click(); 1`);
      const rs = () => (api.posted.pp || []).filter(([m, p]) => m === 'POST' && p === '/paper/book/reset').pop();
      ok('T5', 'Reset: one POST with confirm; $50,000 to start; NVDA closed; the card says what happened', await until(`${EQ}==='$50,000.00' && !document.querySelector('[data-pp-pos="NVDA"]')`, 6000)
        && !!rs() && rs()[2].confirm === true && rs()[2].capital === 50000 && rs()[2].bpCap === null && await js(`return /Reset: \\$50,000 to start/.test(document.querySelector('[data-pp-msg]').textContent);`), await js(`return (document.querySelector('[data-pp-msg]')||{}).textContent;`));
      ok('T5', 'no sideways scroll', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`));
      // Leave the paper accounts as they were for the next width.
      Object.assign(api.state.pp, JSON.parse(JSON.stringify(keep)), { book: null });
      await js(`window._tbOps.trading.refresh(); 1`); await until(`${EQ}==='$100,000.00'`, 6000);
    }

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
