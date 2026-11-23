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
//   T6  the chart's right-click menu ([data-chart-order-menu]), order lines ([data-cho-line]) dragged or typed with a confirmation
//       ([data-chart-order-dialog]), exits on a position, each broker its own lines, press and hold on a phone
//   T9  Add card opens a popup with every tab's cards ([data-card-picker]); another tab's card runs on the grid as x-<tab>-<card>
//   T8  Neo Quant's trading readers (each broker by name, the chart's order lines, the trade alerts' switches); no order action
//   TR3 positions, working orders (brackets with their legs), fills and the activity as boxes; squeezed narrow
//   TR2 the ticket's solid sides, drag, the confirmation (Don't remind me, Turn on), the chart's market buy, the Account card
//   TR1 a waiting take profit dropped from the chart (only that leg; the line goes at once)
//   T7  Control ▸ Alerts has a Trading section ([data-al-trading]: events + brokers); Trading's Alerts button ([data-trade-alerts])
//       goes there; an order alert's link (#alert=trading:<broker>) opens Trading on that broker
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
    // TR2: the send button opens the one order confirmation (ui/order-confirm.js); its own button places.
    const OC = `document.querySelector('[data-order-confirm]')`;
    const ocGo = async () => { await until(`!!${OC} && !${OC}.querySelector('[data-oc-go]').disabled`, 3000); return js(`${OC}.querySelector('[data-oc-go]').click(); 1`); };
    const setBrokerTo = (b) => js(`var s=document.querySelector('[data-trade-broker]'); if (s.value!=='${b}') { s.value='${b}'; s.dispatchEvent(new Event('change',{bubbles:true})); } 1`);
    if (want('T3')) { await tab('trading'); await setBrokerTo('alpaca'); await until(`(document.querySelector('[data-pp-equity]')||{}).textContent==='$100,000.00'`, 6000); }
    ok('T3', '"New Order" opens the redesigned ticket with five type pills', await js(`var b=document.querySelector('[data-trade-new]'); if(!b) return false; b.click(); return true;`)
      && await until(`document.querySelectorAll('[data-order-ticket] [data-ot-type]').length === 5`, 3000));
    if (want('T3')) {
      ok('T3', 'Buy | Sell | Short (TR1), the symbol with Bid / Ask / Last, PAPER · Alpaca', await js(`var t=${OT}; return [...t.querySelectorAll('[data-ot-side]')].map(function(b){return b.textContent;}).join()==='Buy,Sell,Short' && /Bid/.test(t.querySelector('[data-ot-quote]').innerText) && /Last/.test(t.querySelector('[data-ot-quote]').innerText) && /PAPER · Alpaca/.test(t.querySelector('[data-ot-paper]').textContent);`));
      // Tony 2026-11-22 "I can't short": the symbol box's hint is not a ticker. TR1 (#9): three sides, each one meaning.
      ok('T3', 'the symbol\'s hint is "Ticker" (never a real symbol that looks typed in)', await js(`return ${OT}.querySelector('[data-ot-symbol]').placeholder==='Ticker';`));
      await otSet('symbol', 'TSLA'); await otPress('[data-ot-side="sell"]');
      ok('T3', 'Sell with no TSLA held is refused in words (use Short)', await until(`/use Short to sell short/.test(${OT}.querySelector('[data-ot-errors]').textContent)`, 2000), await js(`return ${OT}.querySelector('[data-ot-errors]').textContent;`));
      await otSet('symbol', 'NVDA');
      ok('T3', '10 NVDA held: Sell starts at the 10 shares and is an exit (no legs offered)', await until(`${OT}.querySelector('[data-ot-size]').value==='10' && !${OT}.querySelector('[data-ot-leg]')`, 2000), await js(`return ${OT}.querySelector('[data-ot-size]').value;`));
      await otSet('symbol', 'TSLA'); await otPress('[data-ot-side="short"]'); await otSet('size', '1'); await otPress('[data-ot-go]');
      ok('T3', 'Short on TSLA: the confirmation reads back "PAPER · Alpaca: Sell short 1 share of TSLA", its button "Short" in coral', await until(`!!${OC} && /Sell short 1 share of TSLA/.test(${OC}.querySelector('[data-oc-readback]').textContent)`, 3000)
        && await js(`var g=${OC}.querySelector('[data-oc-go]'); return g.textContent==='Short' && g.dataset.tone==='short';`), await js(`return (${OC}||${OT}).innerText;`));
      await js(`${OC}.querySelector('[data-oc-cancel]').click(); 1`);
      await otSet('symbol', ''); await otPress('[data-ot-side="buy"]');
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
      ok('T3', 'TR2: "Buy AMD" opens the confirmation (Webull\'s rows, the read-back, Don\'t remind me) and sends nothing yet', await until(`!!${OC}`, 2000) && await js(`var d=${OC}; return /^PAPER · Alpaca: Buy 10 shares of AMD with a limit at 140\\.00, then a target at 150\\.00 and a stop at 135\\.00/.test(d.querySelector('[data-oc-readback]').textContent) && /Quantity/.test(d.innerText) && /Take profit/.test(d.innerText) && !!d.querySelector('[data-oc-noremind]') && d.querySelector('[data-oc-go]').textContent==='Buy';`)
        && (api.posted.pp || []).filter(([m, p]) => m === 'POST' && /orders$/.test(p)).length === before, await js(`return (${OC}||{}).innerText;`));
      await shot('tr2-confirm-' + w);
      await ocGo();
      ok('T3', 'Confirm: one bracket order to Alpaca paper, as Tony\'s; the popup closes', await until(`!${OT}`, 5000) && (() => { const o = (api.posted.pp || []).filter(([m, p]) => m === 'POST' && /orders$/.test(p)); const last = o[o.length - 1]; return o.length === before + 1 && last[2].who === 'tony' && last[2].order.order_class === 'bracket' && last[2].order.qty === 10; })(), JSON.stringify((api.posted.pp || []).slice(-2)));
      // Webull: what it lacks is not offered.
      await setBrokerTo('webull'); await until(`(document.querySelector('[data-pp-equity]')||{}).textContent==='$1,000,000.00'`, 6000);
      await js(`document.querySelector('[data-trade-new]').click(); 1`); await until(`!!${OT}`, 3000);
      ok('T3', 'Webull: PAPER · Webull; no $ size on a market order', await js(`return /PAPER · Webull/.test(${OT}.querySelector('[data-ot-paper]').textContent) && !${OT}.querySelector('[data-ot-sizeKind="dollars"]') && !!${OT}.querySelector('[data-ot-sizeKind="shares"]');`));
      await otPress('[data-ot-type="trailing_stop"]');
      ok('T3', '...a trailing stop: GTC not pressable, Day chosen, no Take profit / Stop loss', await js(`var g=${OT}.querySelector('[data-ot-tif="gtc"]'); return g.disabled && ${OT}.querySelector('[data-ot-tif="day"]').getAttribute('aria-pressed')==='true' && !${OT}.querySelector('[data-ot-tp]');`));
      await otPress('[data-ot-type="limit"]'); await otSet('symbol', 'AAPL'); await otSet('limit', '50'); await otSet('size', '1');
      const wbBefore = ((api.posted.wb && api.posted.wb.pp) || []).filter(([m, p]) => m === 'POST' && /orders$/.test(p)).length;
      await otPress('[data-ot-go]'); await ocGo();
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
      await otPress('[data-ot-go]', CARD); await ocGo();
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
        && await js(`var d=${DLG('edit')}, r=d.getBoundingClientRect(); return d.querySelector('[data-book-capital]').value==='$100,000' && /PAPER/.test(d.innerText) && d.querySelector('[data-book-go]').textContent==='Save' && !d.querySelector('[data-book-bpcap]').offsetParent && r.width <= innerWidth && ${w < 600 ? 'Math.abs(r.bottom - innerHeight) < 2' : 'r.left > 0'};`));
      const puts = () => (api.posted.pp || []).filter(([m, p]) => p === '/paper/book').length, puts0 = puts();
      await typeIn('[data-book-capital]', '50');
      await js(`document.querySelector('[data-book-go]').click(); 1`);
      ok('T5', '...under $1,000 is refused there, in words, and nothing is sent', await until(`/between/.test(document.querySelector('[data-book-errors]').textContent)`, 2000) && puts() === puts0);
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
      await js(`document.querySelector('[data-book-more]').click(); 1`);
      ok('T5', '+ Buying-power cap shows the cap field', await js(`return !!document.querySelector('[data-book-bpcap]').offsetParent && document.querySelector('[data-book-more]').hidden;`));
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
      ok('T5', '...its Reset: one line, says Alpaca is not touched and that it needs market hours', await js(`var d=${DLG('reset')}; return /Alpaca is not touched/.test(d.innerText) && /Needs market hours/.test(d.innerText) && d.querySelectorAll('p').length===1;`));
      await js(`document.querySelector('[data-book-cancel]').click(); 1`);
      await setBrokerTo('alpaca'); await until(`${EQ}==='$25,000.00'`, 6000);
      // Reset.
      await js(`document.querySelector('[data-trade-reset]').click(); 1`);
      ok('T5', 'Reset… asks first: one line of what it does, the capital ($25,000), the cap shown (one is set), a plain Reset button', await until(`!!${DLG('reset')}`, 3000)
        && await js(`var d=${DLG('reset')}; return /Closes every position and cancels every order, then starts fresh\\. Webull is not touched\\./.test(d.innerText) && d.querySelector('[data-book-capital]').value==='$25,000' && !!d.querySelector('[data-book-bpcap]').offsetParent && d.querySelector('[data-book-go]').textContent==='Reset';`), await js(`return ${DLG('reset')}.innerText;`));
      await typeIn('[data-book-capital]', '50000'); await typeIn('[data-book-bpcap]', '');
      ok('T5', '...the Reset button is readable (dark text on red)', await js(`var b=document.querySelector('[data-book-go]'); return getComputedStyle(b).color==='rgb(24, 24, 27)';`), await js(`return getComputedStyle(document.querySelector('[data-book-go]')).color;`));
      await shot('t5-reset-' + w);
      await js(`document.querySelector('[data-book-go]').click(); 1`);
      const rs = () => (api.posted.pp || []).filter(([m, p]) => m === 'POST' && p === '/paper/book/reset').pop();
      ok('T5', 'Reset: one POST with confirm; $50,000 to start; NVDA closed; the card says what happened', await until(`${EQ}==='$50,000.00' && !document.querySelector('[data-pp-pos="NVDA"]')`, 6000)
        && !!rs() && rs()[2].confirm === true && rs()[2].capital === 50000 && rs()[2].bpCap === null && await js(`return /Reset to \\$50,000\\./.test(document.querySelector('[data-pp-msg]').textContent);`), await js(`return (document.querySelector('[data-pp-msg]')||{}).textContent;`));
      ok('T5', 'no sideways scroll', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`));
      // Leave the paper accounts as they were for the next width.
      Object.assign(api.state.pp, JSON.parse(JSON.stringify(keep)), { book: null });
      await js(`window._tbOps.trading.refresh(); 1`); await until(`${EQ}==='$100,000.00'`, 6000);
    }

    // T6: trading from the chart (A1-Priv TradeHub/ui/chart-orders.js, chart-order-menu.js)
    const CH = `document.querySelector('[data-lay="charts"] .ch')`;
    const LINE = (k) => `${CH}.querySelector('[data-cho-line="${k}"]')`;
    const CDLG = (k) => `document.querySelector('.ot-scrim [data-chart-order-dialog="${k}"]')`;
    const ppPosts = () => (api.posted.pp || []).filter(([m, p]) => m === 'POST' && p === '/paper/orders');
    const ppCalls = (m, re) => (api.posted.pp || []).filter(([mm, p]) => mm === m && re.test(p));
    const keepT6 = JSON.parse(JSON.stringify({ positions: api.state.pp.positions, orders: api.state.pp.orders }));
    // Drag a line by its tag from its height by dy px (pointer events, as a mouse or a finger sends them).
    const dragLine = (k, dy, type = 'mouse') => js(`var l=${LINE(k)}, t=l.querySelector('.cho-name'), r=t.getBoundingClientRect(), x=r.left+4, y=r.top+r.height/2;
      function ev(n, yy){ return new PointerEvent(n,{bubbles:true,cancelable:true,composed:true,pointerId:7,pointerType:'${type}',isPrimary:true,button:0,buttons:n==='pointerup'?0:1,clientX:x,clientY:yy}); }
      t.dispatchEvent(ev('pointerdown', y)); l.dispatchEvent(ev('pointermove', y + ${dy} / 2)); l.dispatchEvent(ev('pointermove', y + ${dy})); l.dispatchEvent(ev('pointerup', y + ${dy})); return true;`);
    if (want('T6')) {
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);   // an older phase's ticket left open
      await tab('trading'); await setBrokerTo('alpaca'); await until(`${EQ}==='$100,000.00'`, 6000);
      await tab('charts');
      await js(`window._tbOps.charts.open('NVDA'); 1`);
      await until(`!!${CH} && ${CH}.dataset.ch==='NVDA' && !!${CH}.__orders && !!${CH}.querySelector('canvas')`, 8000);
      await until(`!!${LINE('pos')}`, 6000);
    } else await tab('charts');
    ok('T6', 'a right-click on the chart opens the order menu', await js(`var cv=document.querySelector('[data-lay="charts"] canvas'); if(!cv) return false; var r=cv.getBoundingClientRect(); cv.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2})); return true;`)
      && await until(`(function(){var e=document.querySelector('[data-chart-order-menu]'); return !!e && e.getBoundingClientRect().width>0;})()`, 2000));
    if (want('T6')) {
      const M = `document.querySelector('[data-chart-order-menu]')`;
      ok('T6', '...Buy and Sell at this price (a limit on the passive side, a stop past the price), Bracket, Open ticket, Alert; PAPER · Alpaca', await js(`var m=${M}; var c=[].map.call(m.querySelectorAll('[data-com]'),function(b){return b.dataset.com;}).join(); return /^buy-market,buy-(limit|stop),sell-market,sell-(limit|stop),bracket,ticket,alert$/.test(c) && /PAPER · Alpaca/.test(m.innerText);`), await js(`return ${M}.innerText;`));
      ok('T6', '...the menu stays on the screen', await js(`var r=${M}.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;`));
      await shot('t6-menu-' + w);
      const menuPx = await js(`return Number(${M}.querySelector('.cho-menu-head span').textContent);`);
      const buyKind = await js(`return ${M}.querySelector('[data-com="buy-limit"],[data-com="buy-stop"]').dataset.com;`);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
      ok('T6', 'Escape closes the menu', await until(`!document.querySelector('[data-chart-order-menu]')`, 1500));
      ok('T6', 'the NVDA position shows as a line: Long 10, its P&L, + TP/SL', await until(`!!${LINE('pos')} && !${LINE('pos')}.hidden`, 6000)
        && await js(`var t=${LINE('pos')}.innerText; return /Long 10/.test(t) && /160\\.00/.test(t) && !!${LINE('pos')}.querySelector('[data-cho-protect]');`), await js(`return (${LINE('pos')}||{}).innerText;`));
      // A quick order from the menu.
      await js(`var cv=document.querySelector('[data-lay="charts"] canvas'), r=cv.getBoundingClientRect(); cv.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2})); 1`);
      await until(`(function(){var e=document.querySelector('[data-chart-order-menu]'); return !!e && e.getBoundingClientRect().width>0;})()`, 2000);
      await js(`document.querySelector('[data-chart-order-menu] [data-com="${buyKind}"]').click(); 1`);
      ok('T6', `${buyKind}: the order confirmation first (PAPER · Alpaca, the read-back), nothing sent yet` + (w < 600 ? ', a bottom sheet' : ''), await until(`!!${OC}`, 2000)
        && await js(`var d=${OC}, r=d.getBoundingClientRect(); return /PAPER · Alpaca/.test(d.querySelector('[data-oc-paper]').textContent) && /^PAPER · Alpaca: Buy 1 share of NVDA/.test(d.querySelector('[data-oc-readback]').textContent) && ${w < 600 ? 'Math.abs(r.bottom - innerHeight) < 2' : 'r.left > 0'};`), await js(`return ${OC} && ${OC}.innerText;`));
      const posts0 = ppPosts().length, placedPx = await js(`return Number(${OC}.querySelector('[data-oc-price]').value);`);   // this menu's price (the scale may have moved a cent)
      await js(`var i=${OC}.querySelector('[data-oc-qty]'); i.value='2'; i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
      await ocGo();
      await until(`!${OC}`, 4000);
      const sent = ppPosts().slice(posts0).pop();
      const field = buyKind === 'buy-limit' ? 'limit_price' : 'stop_price';
      ok('T6', '...Place: one order to Alpaca paper at the menu\'s price, 2 shares, good till cancelled, as Tony', !!sent && sent[2].order.side === 'buy' && sent[2].order.qty === 2 && sent[2].order[field] === placedPx && sent[2].order.time_in_force === 'gtc' && sent[2].who === 'tony', JSON.stringify(sent));
      const oid = api.state.pp.orders[0] && api.state.pp.orders[0].id;
      ok('T6', '...and it shows on the chart as a line: "Buy ' + (field === 'limit_price' ? 'LMT' : 'STP') + ' 2"', await until(`!!${LINE(oid)} && !${LINE(oid)}.hidden`, 5000) && await js(`return /Buy (LMT|STP) 2/.test(${LINE(oid)}.innerText);`), await js(`return [].map.call(${CH}.querySelectorAll('[data-cho-line]'),function(e){return e.dataset.choLine+':'+e.innerText;}).join(' | ');`));
      // Drag it: a confirmation (was → new, the P&L) before anything changes.
      const y0 = await js(`return ${CH}.__orders.yOf('${oid}');`);
      await dragLine(oid, -30, w < 600 ? 'touch' : 'mouse');
      ok('T6', 'dragging the order\'s line asks first: Change …, Was ' + placedPx.toFixed(2) + ', the new price above it', await until(`!!${CDLG('edit')}`, 2000)
        && await js(`var d=${CDLG('edit')}; return d.querySelector('[data-cho-was]').textContent==='${placedPx.toFixed(2)}' && Number(d.querySelector('[data-cho-price]').value) > ${placedPx} && /^Change buy/.test(d.querySelector('.ot-head b').textContent);`), await js(`return ${CDLG('edit')} && ${CDLG('edit')}.innerText;`));
      await shot('t6-edit-' + w);
      const patches0 = ppCalls('PATCH', /^\/paper\/orders\//).length;
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
      ok('T6', '...Escape: nothing sent, the line snaps back', await until(`!${CDLG('edit')}`, 1500) && ppCalls('PATCH', /^\/paper\/orders\//).length === patches0
        && await js(`var l=${LINE(oid)}; return Math.abs(new DOMMatrix(getComputedStyle(l).transform).m42 - ${Math.round(y0)}) <= 1;`), await js(`return getComputedStyle(${LINE(oid)}).transform + ' vs ${y0}';`));
      await dragLine(oid, -30, w < 600 ? 'touch' : 'mouse');
      await until(`!!${CDLG('edit')}`, 2000);
      const newPx = await js(`return Number(${CDLG('edit')}.querySelector('[data-cho-price]').value);`);
      await js(`${CDLG('edit')}.querySelector('[data-cho-go]').click(); 1`);
      await until(`!${CDLG('edit')}`, 4000);
      const pt = ppCalls('PATCH', /^\/paper\/orders\//).pop();
      ok('T6', '...Confirm change: one change to that order, the new price, as Tony; the line stays there', !!pt && pt[1] === '/paper/orders/' + oid && pt[2][field] === newPx && pt[2].who === 'tony'
        && await until(`${CH}.__orders.lines().some(function(l){return l.key==='${oid}' && l.price===${newPx};})`, 3000), JSON.stringify(pt));
      // Typed from the tag.
      await js(`${LINE(oid)}.querySelector('[data-cho-px]').click(); 1`);
      await until(`!!${CDLG('edit')}`, 2000);
      const typed = +(placedPx - 1).toFixed(2);
      await js(`var i=${CDLG('edit')}.querySelector('[data-cho-price]'); i.value='${typed}'; i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
      ok('T6', 'a price typed from the line\'s tag: the same confirmation', await js(`return !${CDLG('edit')}.querySelector('[data-cho-go]').disabled;`));
      await js(`${CDLG('edit')}.querySelector('[data-cho-go]').click(); 1`);
      await until(`!${CDLG('edit')}`, 4000);
      ok('T6', '...sent as typed', (ppCalls('PATCH', /^\/paper\/orders\//).pop() || [])[2][field] === typed);
      // Cancel from the line.
      await js(`${LINE(oid)}.querySelector('[data-cho-cancel]').click(); 1`);
      ok('T6', '× asks before it cancels', await until(`!!${CDLG('cancel')}`, 2000) && !ppCalls('DELETE', new RegExp('/paper/orders/' + oid)).length);
      await js(`${CDLG('cancel')}.querySelector('[data-cho-go]').click(); 1`);
      ok('T6', '...Cancel order: that order cancelled, its line gone', await until(`!${LINE(oid)}`, 5000) && ppCalls('DELETE', new RegExp('/paper/orders/' + oid)).length === 1);
      // Exits on the position, then dragging the stop after the fill (trail it).
      await js(`${LINE('pos')}.querySelector('[data-cho-protect]').click(); 1`);
      ok('T6', '+ TP/SL on the position: take profit and stop loss with the P&L at each', await until(`!!${CDLG('protect')}`, 2000) && await js(`var d=${CDLG('protect')}; return Number(d.querySelector('[data-cho-tp]').value) > 160 && Number(d.querySelector('[data-cho-sl]').value) > 0 && /\\+\\$/.test(d.querySelector('[data-cho-tpgain]').textContent);`), await js(`return ${CDLG('protect')} && ${CDLG('protect')}.innerText;`));
      const posts1 = ppPosts().length;
      await js(`${CDLG('protect')}.querySelector('[data-cho-go]').click(); 1`);
      await until(`!${CDLG('protect')}`, 4000);
      const oco = ppPosts().slice(posts1).pop();
      ok('T6', '...both go as one OCO to sell the 10 shares', !!oco && oco[2].order.order_class === 'oco' && oco[2].order.side === 'sell' && oco[2].order.qty === 10 && oco[2].order.take_profit.limit_price > 160, JSON.stringify(oco));
      // The broker's OCO comes back as the limit with its stop as a leg (Alpaca's nested shape).
      const o1 = api.state.pp.orders[0];
      if (o1) { o1.legs = [{ id: o1.id + 'sl', symbol: 'NVDA', side: 'sell', type: 'stop', qty: 10, stop_price: o1.stop_loss.stop_price, status: 'new' }]; }
      await js(`window._tbOps.trading ? window._tbOps.trading.refresh() : 0; 1`);
      await js(`(function(){ var c=document.querySelector('[data-lay="charts"] .ch'); return c && c.__orders; })(); 1`);
      await tab('trading'); await tab('charts');
      ok('T6', '...on the chart: TP 10 and SL 10 lines, the + TP/SL gone', await until(`!!${CH}.querySelector('[data-cho-line][data-role="tp"]') && !!${CH}.querySelector('[data-cho-line][data-role="sl"]') && !${LINE('pos')}.querySelector('[data-cho-protect]')`, 6000),
        await js(`return [].map.call(${CH}.querySelectorAll('[data-cho-line]'),function(e){return e.dataset.role+':'+e.innerText;}).join(' | ');`));
      const slKey = await js(`return ${CH}.querySelector('[data-cho-line][data-role="sl"]').dataset.choLine;`);
      const slWas = await js(`return ${CH}.__orders.lines().find(function(l){return l.key==='${slKey}';}).price;`);
      await dragLine(slKey, -20, w < 600 ? 'touch' : 'mouse');
      ok('T6', 'the stop dragged up after the fill (trailing it): the confirmation shows the P&L at the new level', await until(`!!${CDLG('edit')}`, 2000) && await js(`var d=${CDLG('edit')}; return /^Change stop loss/.test(d.querySelector('.ot-head b').textContent) && Number(d.querySelector('[data-cho-price]').value) > ${slWas} && /\\$/.test(d.querySelector('[data-cho-newpnl]').textContent);`), await js(`return ${CDLG('edit')} && ${CDLG('edit')}.innerText;`));
      await js(`${CDLG('edit')}.querySelector('[data-cho-cancel-dlg]').click(); 1`);
      ok('T6', '...Cancel: the stop back where it was, nothing sent', await until(`!${CDLG('edit')}`, 1500) && await js(`return ${CH}.__orders.lines().find(function(l){return l.key==='${slKey}';}).price === ${slWas};`));
      // Each broker its own lines.
      await tab('trading'); await setBrokerTo('webull'); await until(`${EQ}==='$1,000,000.00'`, 6000);
      await tab('charts'); await js(`window._tbOps.charts.open('AAPL'); 1`);
      ok('T6', 'Webull: its own AAPL order shows on AAPL\'s chart; no Alpaca line', await until(`!!${LINE('wbo1')}`, 6000) && await js(`return !${CH}.querySelector('[data-cho-line="pos"]');`));
      await js(`window._tbOps.charts.open('NVDA'); 1`);
      ok('T6', '...NVDA on Webull: no position, no Alpaca orders', await until(`${CH}.dataset.ch==='NVDA'`, 4000) && await js(`return new Promise(function(r){setTimeout(function(){r(!${CH}.querySelector('[data-cho-line]'));},800);});`));
      await tab('trading'); await setBrokerTo('alpaca'); await until(`${EQ}==='$100,000.00'`, 6000);
      Object.assign(api.state.pp, JSON.parse(JSON.stringify(keepT6)));
      await js(`window._tbOps.trading.refresh(); 1`);
      await tab('charts');
      if (w < 600) {
        await js(`window._tbOps.charts.open('NVDA'); 1`);
        await until(`!!${CH} && ${CH}.dataset.ch==='NVDA' && !!${CH}.__orders`, 8000);
        await js(`var cv=document.querySelector('[data-lay="charts"] canvas'), r=cv.getBoundingClientRect(); cv.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:9,pointerType:'touch',isPrimary:true,button:0,buttons:1,clientX:r.left+r.width/2,clientY:r.top+r.height/2})); 1`);
        ok('T6', 'press and hold on a phone opens the same menu', await until(`(function(){var e=document.querySelector('[data-chart-order-menu]'); return !!e && e.getBoundingClientRect().width>0;})()`, 2000));
        await js(`var cv=document.querySelector('[data-lay="charts"] canvas'), r=cv.getBoundingClientRect(); cv.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:9,pointerType:'touch',isPrimary:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2})); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
      }
      ok('T6', 'no sideways scroll', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`));
    }
    // TR3 (quant-trading-refine-1.md): positions, working orders, fills and the activity as boxes, at any card size.
    if (want('TR3')) {
      const tk0 = await js(`return document.querySelectorAll('.ot-scrim [data-order-ticket]').length;`);
      await js(`window.__sp=[]; ['stopPropagation','stopImmediatePropagation'].forEach(function(m){ var o=Event.prototype[m]; Event.prototype[m]=function(){ if(this.type==='keydown') window.__sp.push(m+': '+String(new Error().stack||'').slice(0,500)); return o.call(this); }; }); 1`);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`);   // the opening check's ticket
      console.log('    SP:', await js(`return JSON.stringify(window.__sp);`));
      ok('TR3', 'Escape closes an open ticket', await until(`!document.querySelector('.ot-scrim [data-order-ticket]')`, 1500), tk0 + ' open before; ' + await js(`return document.querySelectorAll('.ot-scrim [data-order-ticket]').length + ' after; active=' + (document.activeElement && (document.activeElement.tagName + '.' + document.activeElement.className));`));
      await tab('trading'); await setBrokerTo('alpaca'); await until(`${EQ}==='$100,000.00'`, 6000);
      const keep3 = JSON.parse(JSON.stringify(api.state.pp.orders));
      api.state.pp.orders = [
        { id: 'w1', symbol: 'AMD', side: 'buy', type: 'limit', qty: 2, limit_price: 140, status: 'new', order_class: 'bracket', time_in_force: 'gtc', submitted_at: '2026-11-23T15:00:00Z',
          legs: [{ id: 'w1tp', symbol: 'AMD', side: 'sell', type: 'limit', qty: 2, limit_price: 150, status: 'held' }, { id: 'w1sl', symbol: 'AMD', side: 'sell', type: 'stop', qty: 2, stop_price: 135, status: 'held' }] },
        { id: 'f1', symbol: 'NVDA', side: 'buy', type: 'market', qty: 10, status: 'filled', filled_qty: 10, filled_avg_price: 160, order_class: 'bracket', time_in_force: 'gtc',
          legs: [{ id: 'f1tp', symbol: 'NVDA', side: 'sell', type: 'limit', qty: 10, limit_price: 180, status: 'new' }, { id: 'f1sl', symbol: 'NVDA', side: 'sell', type: 'stop', qty: 10, stop_price: 150, status: 'held' }] },
        { id: 's1', symbol: 'TSLA', side: 'sell', type: 'limit', qty: 1, limit_price: 320, status: 'new', order_class: 'simple', time_in_force: 'day', submitted_at: '2026-11-23T15:01:00Z' }];
      await js(`window._tbOps.trading.refresh(); 1`);
      const W = `document.querySelector('[data-pp-working]')`;
      ok('TR3', 'Working orders: one box per order; the bracket carries its take profit and stop inside, marked as waiting', await until(`!!${W} && !!${W}.querySelector('[data-pp-ord="w1"]')`, 6000)
        && await js(`var b=${W}.querySelector('[data-pp-ord="w1"]'); return b.classList.contains('pp-box') && b.querySelectorAll('[data-pp-leg]').length===2 && /waits for the entry/.test(b.innerText) && /Limit 140\\.00/.test(b.innerText) && !!b.querySelector('[data-pp-cancel]') && !!b.querySelector('[data-pp-reprice]');`), await js(`return ${W}.innerText;`));
      ok('TR3', 'a filled bracket shows as the exits left on the position (no "working buy")', await js(`var b=${W}.querySelector('[data-pp-ord="f1"]'); return !!b && /Exits/.test(b.innerText) && b.querySelectorAll('[data-pp-leg]').length===2 && !b.querySelector('[data-pp-cancel]') && !/waits for the entry/.test(b.innerText);`), await js(`var b=${W}.querySelector('[data-pp-ord="f1"]'); return b && b.innerText;`));
      ok('TR3', 'a sell with no long held reads Short', await js(`var b=${W}.querySelector('[data-pp-ord="s1"]'); return !!b && /Short/.test(b.querySelector('.pp-chip').textContent);`));
      ok('TR3', 'Positions: a box with Long, size @ average, P&L, Last / Value / Today, Order and Close', await js(`var b=document.querySelector('[data-pp-pos="NVDA"]'); return !!b && b.classList.contains('pp-box') && /Long/.test(b.innerText) && /10 @ \\$160\\.00/.test(b.innerText) && !!b.querySelector('[data-pp-close]') && !!b.querySelector('[data-pp-order]');`), await js(`return (document.querySelector('[data-pp-pos="NVDA"]')||{}).innerText;`));
      await js(`${W}.querySelector('[data-pp-ord="w1"] [data-pp-leg="w1tp"] [data-pp-legx]').click(); 1`);
      const d0 = ppCalls('POST', /\/paper\/orders\/w1tp\/drop$/).length;
      ok('TR3', 'x on a leg asks "Remove take profit" (the chart\'s dialog)', await until(`!!${CDLG('cancel')}`, 2000) && await js(`return /^Remove take profit/.test(${CDLG('cancel')}.querySelector('.ot-head b').textContent);`));
      await js(`${CDLG('cancel')}.querySelector('[data-cho-go]').click(); 1`);
      ok('TR3', '...one drop call; the stop stays', await until(`!${W}.querySelector('[data-pp-leg="w1tp"]')`, 3000) && ppCalls('POST', /\/paper\/orders\/w1tp\/drop$/).length === d0 + 1 && await js(`return !!${W}.querySelector('[data-pp-leg="w1sl"]');`));
      // Every order card fits its width, also squeezed narrow.
      const fits = () => js(`return ['[data-pp-working]','[data-pp-positions]','[data-pp-filled]','[data-pp-log]'].every(function(s){ var c=document.querySelector(s); return !c || c.scrollWidth <= c.clientWidth + 1; });`);
      ok('TR3', 'no order card runs past its edge', await fits());
      await js(`var c=document.querySelector('.lay-card[data-card="working"]'); c.dataset.w0=c.style.width; c.style.width='290px'; 1`);
      await new Promise((r) => setTimeout(r, 120));
      ok('TR3', '...squeezed to 290 px: the buttons take their own full-width line, nothing cut off', await js(`var c=document.querySelector('[data-pp-working]'); var a=c.querySelector('[data-pp-ord="w1"] .pp-sub .pp-acts'); return c.scrollWidth <= c.clientWidth + 1 && !!a && Math.abs(a.getBoundingClientRect().width - a.parentElement.getBoundingClientRect().width) < 2;`), await js(`var c=document.querySelector('[data-pp-working]'); return c.scrollWidth + '/' + c.clientWidth;`));
      await shot('tr3-working-narrow-' + w);
      await js(`var c=document.querySelector('.lay-card[data-card="working"]'); c.style.width=c.dataset.w0||''; c.scrollIntoView({block:'center'}); 1`);
      await shot('tr3-cards-' + w);
      api.state.pp.orders = keep3;
      await js(`window._tbOps.trading.refresh(); 1`);
    }
    // TR2 (quant-trading-refine-1.md): the ticket's look, the confirmation, dragging, the Account card.
    if (want('TR2')) {
      await tab('trading'); await setBrokerTo('alpaca'); await until(`${EQ}==='$100,000.00'`, 6000);
      await js(`localStorage.removeItem('tb_order_confirm'); document.querySelector('[data-trade-new]').click(); 1`); await until(`!!${OT}`, 3000);
      const bg = (sel) => js(`var e=${OT}.querySelector('${sel}'); return e ? getComputedStyle(e).backgroundColor + '|' + getComputedStyle(e).backgroundImage : '';`);
      await otPress('[data-ot-side="buy"]'); const cBuy = await bg('[data-ot-side="buy"]');
      await otPress('[data-ot-side="sell"]'); const cSell = await bg('[data-ot-side="sell"]');
      await otPress('[data-ot-side="short"]'); const cShort = await bg('[data-ot-side="short"]');
      ok('TR2', 'Buy, Sell and Short fill solid (no gradient), each its own colour: green, red, coral', [cBuy, cSell, cShort].every((c) => /\|none$/.test(c) && !/rgba\(0, 0, 0, 0\)/.test(c)) && new Set([cBuy, cSell, cShort]).size === 3, [cBuy, cSell, cShort].join(' ; '));
      await otSet('symbol', 'AMD'); await otSet('size', '1');
      ok('TR2', 'the send button says what it does in the side\'s colour: "Short AMD"', await until(`${OT}.querySelector('[data-ot-go]').textContent==='Short AMD' && ${OT}.querySelector('[data-ot-go]').dataset.tone==='short'`, 2000), await js(`return ${OT}.querySelector('[data-ot-go]').textContent;`));
      await otPress('[data-ot-side="buy"]');
      if (w >= 600) {
        const r0 = await js(`return JSON.stringify(${OT}.getBoundingClientRect());`);
        const dragBy = (dx, dy) => js(`var t=${OT}, hd=t.querySelector('[data-drag-handle] b'), r=hd.getBoundingClientRect(), x=r.left+5, y=r.top+5;
          function ev(n,xx,yy){ return new PointerEvent(n,{bubbles:true,cancelable:true,composed:true,pointerId:11,pointerType:'mouse',isPrimary:true,button:0,buttons:n==='pointerup'?0:1,clientX:xx,clientY:yy}); }
          hd.dispatchEvent(ev('pointerdown',x,y)); t.dispatchEvent(ev('pointermove',x+${dx}/2,y+${dy}/2)); t.dispatchEvent(ev('pointermove',x+${dx},y+${dy})); t.dispatchEvent(ev('pointerup',x+${dx},y+${dy})); return JSON.stringify(t.getBoundingClientRect());`);
        const r1 = JSON.parse(await dragBy(-60, 40)), a = JSON.parse(r0);
        ok('TR2', 'the ticket is dragged by its head', Math.abs(r1.left - (a.left - 60)) < 2 && Math.abs(r1.top - (a.top + 40)) < 2, r0 + ' -> ' + JSON.stringify(r1));
        const r2 = JSON.parse(await dragBy(-3000, -3000));
        const side = await js(`var s=document.querySelector('#tradeboard-root .tb-sidebar'); return s && s.offsetParent ? s.getBoundingClientRect().right : 0;`);
        ok('TR2', '...never past the window or over the sidebar', Math.abs(r2.left - side) < 2 && Math.abs(r2.top) < 2, JSON.stringify(r2) + ' sidebar ' + side);
        await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); document.querySelector('[data-trade-new]').click(); 1`); await until(`!!${OT}`, 3000);
        ok('TR2', '...and opens centred again', await js(`var r=${OT}.getBoundingClientRect(); return !${OT}.style.translate && Math.abs((r.left + r.right) / 2 - (innerWidth / 2)) < 4;`), await js(`return JSON.stringify(${OT}.getBoundingClientRect()) + ' ' + innerWidth;`));
      }
      // Don't remind me again, then the way back.
      await otSet('symbol', 'AMD'); await otPress('[data-ot-type="limit"]'); await otSet('limit', '100'); await otSet('size', '1');
      await otPress('[data-ot-go]'); await until(`!!${OC}`, 2000);
      await js(`${OC}.querySelector('[data-oc-noremind]').click(); 1`);
      const n0 = ppPosts().length;
      await ocGo();
      ok('TR2', '"Don\'t remind me again" + Buy: placed, and confirmations are off on this device', await until(`!${OC} && !${OT}`, 4000) && ppPosts().length === n0 + 1 && await js(`return localStorage.getItem('tb_order_confirm')==='off';`));
      await js(`document.querySelector('[data-trade-new]').click(); 1`); await until(`!!${OT}`, 3000);
      ok('TR2', '...the ticket says "Confirm off · Turn on"', await js(`return !!${OT}.querySelector('[data-ot-confirmoff]');`));
      await otSet('symbol', 'AMD'); await otPress('[data-ot-type="limit"]'); await otSet('limit', '101'); await otSet('size', '1'); await otPress('[data-ot-go]');
      ok('TR2', '...one more order sent, no confirmation shown, a note', await until(`!document.querySelector('[data-order-confirm]') && !!document.querySelector('[data-oc-note]')`, 3000) && ppPosts().length === n0 + 2);
      await js(`document.querySelector('[data-trade-new]').click(); 1`); await until(`!!${OT}`, 3000);
      await js(`${OT}.querySelector('[data-ot-confirmoff]').click(); 1`);
      ok('TR2', '...Turn on brings confirmations back', await until(`!${OT}.querySelector('[data-ot-confirmoff]')`, 1500) && await js(`return localStorage.getItem('tb_order_confirm')===null;`));
      await js(`document.querySelector('[data-trade-new]').click(); document.querySelector('[data-trade-new]').click(); 1`);
      ok('TR2', 'New order twice: one ticket, never two stacked', await until(`document.querySelectorAll('.ot-scrim [data-order-ticket]').length === 1`, 1500), await js(`return document.querySelectorAll('.ot-scrim [data-order-ticket]').length;`));
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
      // The chart's market buy: the confirmation with its live price.
      await tab('charts'); await js(`window._tbOps.charts.open('NVDA'); 1`);
      await until(`!!${CH} && ${CH}.dataset.ch==='NVDA' && !!${CH}.__orders && !!${CH}.querySelector('canvas')`, 8000);
      await js(`var cv=document.querySelector('[data-lay="charts"] canvas'), r=cv.getBoundingClientRect(); cv.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2})); 1`);
      await until(`!!document.querySelector('[data-chart-order-menu] [data-com="buy-market"]')`, 2000);
      await js(`document.querySelector('[data-chart-order-menu] [data-com="buy-market"]').click(); 1`);
      ok('TR2', 'Market buy from the chart: the confirmation with the market price, Shares | $, nothing sent yet', await until(`!!${OC}`, 2000) && await js(`var d=${OC}; return !!d.querySelector('[data-oc-mkt]') && !!d.querySelector('[data-oc-kind="dollars"]') && !d.querySelector('[data-oc-price]') && /Market/.test(d.innerText);`), await js(`return (${OC}||{}).innerText;`));
      await js(`${OC}.querySelector('[data-oc-kind="dollars"]').click(); var i=${OC}.querySelector('[data-oc-qty]'); i.value='1000'; i.dispatchEvent(new Event('input',{bubbles:true})); 1`);
      ok('TR2', '...$1,000 turns into whole shares, said under the box', await until(`/= \\d+ shares?/.test(${OC}.querySelector('[data-oc-shares]').textContent)`, 1500), await js(`return ${OC}.querySelector('[data-oc-shares]').textContent;`));
      await js(`${OC}.querySelector('[data-oc-cancel]').click(); 1`);
      await tab('trading');
      // The Account card: headings, no dots, the kill switch never squashed.
      ok('TR2', 'Account: "Capital" and "Reset" without dots; headings brighter than the notes', await js(`var c=document.querySelector('[data-trade-capital-edit]').textContent, r=document.querySelector('[data-trade-reset]').textContent; var hd=getComputedStyle(document.querySelector('[data-pp-account] .pp-fact small')).color, nt=getComputedStyle(document.querySelector('[data-pp-account] .mk-note')||document.body).color; return c==='Capital' && r==='Reset' && hd!==nt;`));
      await js(`var c=document.querySelector('.lay-card[data-card="account"]'); c.dataset.h0=c.style.height; c.style.height='160px'; 1`);
      ok('TR2', '...a short card scrolls; the kill switch keeps its height', await js(`var k=document.querySelector('[data-pp-kill]'); return k.getBoundingClientRect().height >= 28;`), await js(`return document.querySelector('[data-pp-kill]').getBoundingClientRect().height;`));
      await js(`var c=document.querySelector('.lay-card[data-card="account"]'); c.style.height=c.dataset.h0||''; 1`);
      ok('TR2', 'selected text keeps TradeHub\'s colours (never black on a phone)', await js(`return [].some.call(document.styleSheets, function(ss){ try { return [].some.call(ss.cssRules, function(r){ return /::selection/.test(r.selectorText||'') && /tradeboard-root/.test(r.selectorText); }); } catch(e){ return false; } });`));
    }
    // TR1 (A1-Priv docs/TradeHub/quant-trading-refine-1.md): x on a waiting take profit drops that leg only; its line goes at once.
    if (want('TR1')) {
      await tab('trading'); await setBrokerTo('alpaca'); await until(`${EQ}==='$100,000.00'`, 6000);
      api.state.pp.orders.unshift({ id: 'trb', symbol: 'AMD', side: 'buy', type: 'limit', qty: 1, limit_price: 100, status: 'new', order_class: 'bracket', time_in_force: 'gtc',
        legs: [{ id: 'trbtp', symbol: 'AMD', side: 'sell', type: 'limit', qty: 1, limit_price: 110, status: 'held' }, { id: 'trbsl', symbol: 'AMD', side: 'sell', type: 'stop', qty: 1, stop_price: 95, status: 'held' }] });
      await js(`window._tbOps.trading.refresh(); 1`);
      await tab('charts'); await js(`window._tbOps.charts.open('AMD'); 1`);
      ok('TR1', 'a bracket waiting to fill: entry, take profit and stop loss lines, the legs marked held', await until(`!!${LINE('trbtp')} && !!${LINE('trbsl')} && !!${LINE('trb')}`, 8000) && await js(`return ${LINE('trbtp')}.classList.contains('is-held');`));
      ok('TR1', 'its take profit may move below the market but above the entry (Tony #36): no refusal', await js(`var l=${CH}.__orders.lines().find(function(x){return x.key==='trbtp';}); return !!l && l.basis===100 && l.parent==='trb';`));
      await js(`${LINE('trbtp')}.querySelector('[data-cho-cancel]').click(); 1`);
      ok('TR1', 'x on the take profit asks "Remove take profit", saying only it goes', await until(`!!${CDLG('cancel')}`, 2000) && await js(`var d=${CDLG('cancel')}; return /^Remove take profit/.test(d.querySelector('.ot-head b').textContent) && /only the take profit goes/.test(d.innerText);`), await js(`return ${CDLG('cancel')} && ${CDLG('cancel')}.innerText;`));
      const drops0 = ppCalls('POST', /\/paper\/orders\/trbtp\/drop$/).length;
      await js(`${CDLG('cancel')}.querySelector('[data-cho-go]').click(); 1`);
      const t0 = Date.now();
      ok('TR1', '...Remove: one drop call for that leg of that order (no cancel of the bracket)', await until(`!${CDLG('cancel')}`, 3000) && ppCalls('POST', /\/paper\/orders\/trbtp\/drop$/).length === drops0 + 1 && !ppCalls('DELETE', /\/paper\/orders\/trb$/).length, JSON.stringify(api.posted.pp && api.posted.pp.slice(-3)));
      ok('TR1', '...its line is gone at once; the entry and the stop stay', await until(`!${LINE('trbtp')}`, 1500) && await js(`return !!${LINE('trb')} && !!${LINE('trbsl')};`), Date.now() - t0);
      api.state.pp.orders = api.state.pp.orders.filter((x) => x.id !== 'trb');
      await tab('trading'); await until(`!!(window._tbOps && window._tbOps.trading)`, 4000);
      await js(`window._tbOps.trading.refresh(); 1`);
    }

    // T7: trade alerts (quant-api lib/order-watch.js; A1-Priv ui/alerts.js Trading section)
    if (want('T7')) { await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`); await tab('trading'); await until(`!!document.querySelector('[data-trade-alerts]')`, 4000); await js(`document.querySelector('[data-trade-alerts]').click(); 1`); }
    ok('T7', 'Control ▸ Alerts has a Trading section', await until(`!!document.querySelector('[data-al-trading]')`, 6000));
    if (want('T7')) {
      const TR = `document.querySelector('[data-al-trading]')`;
      ok('T7', 'Trading\'s Alerts button lands there: the section on screen', await until(`(function(){var r=${TR}.getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight - 40;})()`, 3000), await js(`return JSON.stringify(${TR}.getBoundingClientRect());`));
      ok('T7', '...When: Filled, Partly filled, Cancelled, Rejected; Broker: Alpaca, Webull', await js(`var t=${TR}.innerText; return /Filled/.test(t) && /Partly filled/.test(t) && /Cancelled/.test(t) && /Rejected/.test(t) && /Alpaca/.test(t) && /Webull/.test(t);`));
      await shot('t7-trading-' + w);
      ok('T7', '...defaults: everything on except his own cancels', await js(`var g=function(k){return ${TR}.querySelector('[data-al-trading-on="'+k+'"]').checked;}; return g('filled') && g('partial') && !g('canceled') && g('rejected') && g('alpaca') && g('webull');`));
      ok('T7', 'Kinds lists "Your paper orders"', await js(`return /Your paper orders/.test((document.querySelector('[data-tal-kind="order"]')||{}).textContent||'');`));
      const n0 = (api.posted.alertCfg || []).length;
      await js(`var c=${TR}.querySelector('[data-al-trading-on="canceled"]'); c.click(); 1`);
      ok('T7', 'switching Cancelled on saves it (trading.canceled true, the rest kept)', await until(`${(api.posted.alertCfg || []).length} >= 0`, 100) && await new Promise((r) => setTimeout(r, 1200)).then(() => { const c = (api.posted.alertCfg || []).slice(n0).pop(); return !!c && c.trading && c.trading.canceled === true && c.kinds.price === true; }), JSON.stringify((api.posted.alertCfg || []).slice(-1)));
      await js(`var c=document.querySelector('[data-al-trading] [data-al-trading-on="webull"]'); c.click(); 1`);
      await new Promise((r) => setTimeout(r, 1200));
      ok('T7', '...and Webull off', ((api.posted.alertCfg || []).slice(-1)[0] || {}).trading.webull === false);
      await js(`document.querySelector('[data-tal-kind-on="order"]').click(); 1`);
      ok('T7', 'the kind off: the Trading switches dim and say why', await until(`/Off: switch on/.test(document.querySelector('[data-al-trading]').innerText) && document.querySelector('[data-al-trading] [data-al-trading-on="filled"]').disabled`, 3000));
      await js(`document.querySelector('[data-tal-kind-on="order"]').click(); 1`); await until(`!document.querySelector('[data-al-trading] [data-al-trading-on="filled"]').disabled`, 3000);
      await js(`document.querySelector('[data-al-trading] [data-al-trading-on="webull"]').click(); 1`); await new Promise((r) => setTimeout(r, 800));
      await js(`document.querySelector('[data-al-trading] [data-al-trading-on="canceled"]').click(); 1`); await new Promise((r) => setTimeout(r, 800));
      // A fill's notification opens Trading on its broker.
      await js(`location.hash = '#alert=trading:webull'; 1`);
      ok('T7', 'an order alert\'s link opens Trading on that broker (Webull)', await until(`!!document.querySelector('[data-trading-tab]') && (document.querySelector('[data-trade-broker]')||{}).value==='webull'`, 8000));
      await js(`history.replaceState(null, '', location.pathname + location.search); 1`);
      await setBrokerTo('alpaca'); await until(`${EQ}==='$100,000.00'`, 6000);
      ok('T7', 'no sideways scroll', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`));
    }

    // T8: Neo Quant knows the trading app (A1-Priv TradeHub/neo/reg/trading.js), and places nothing.
    const REG = (expr) => js(`var R=(await import('/A1/TradeHub/neo/registry.js')).Registry; return JSON.stringify(await (${expr}));`).then((s) => { try { return JSON.parse(s); } catch (e) { return { error: String(s) }; } });
    if (want('T8')) {
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
      await tab('trading'); await setBrokerTo('alpaca'); await until(`${EQ}==='$100,000.00'`, 6000);
      const st = await REG(`R.get('trading').readers.status.read()`);
      ok('T8', 'Neo reads the chosen broker: Alpaca, its account ($100,000) and its NVDA position', st.broker === 'alpaca' && st.account && st.account.equity === 100000 && st.positions.some((p) => p.symbol === 'NVDA' && p.qty === 10), JSON.stringify(st).slice(0, 300));
      const wb = await REG(`R.get('trading').readers.broker.read({ broker: 'webull' })`);
      ok('T8', '...and Webull by name: its own account and its AAPL order, no Alpaca position', wb.broker === 'webull' && wb.account.equity === 1000000 && wb.orders.some((o) => o.id === 'wbo1' && o.price === 50) && !wb.positions.some((p) => p.symbol === 'NVDA'), JSON.stringify(wb).slice(0, 300));
      ok('T8', '...the broker shown did not change (reading is not switching)', await js(`return document.querySelector('[data-trade-broker]').value==='alpaca';`));
      await tab('charts'); await js(`window._tbOps.charts.open('NVDA'); 1`);
      await until(`!!document.querySelector('[data-lay="charts"] .ch [data-cho-line="pos"]')`, 8000);
      const ln = await REG(`R.get('trading').readers.lines.read()`);
      ok('T8', 'Neo reads the chart\'s order lines: NVDA, the long position at 160', ln.symbol === 'NVDA' && ln.lines.some((l) => l.role === 'pos' && l.price === 160 && l.qty === 10), JSON.stringify(ln));
      const al = await REG(`R.get('trading').readers.alerts.read()`);
      ok('T8', 'Neo reads the trade alerts\' switches (cancelled off by default)', al.on === true && al.switches.filled === true && al.switches.canceled === false, JSON.stringify(al));
      const posts = (api.posted.pp || []).filter(([m]) => m !== 'GET').length;
      const did = await REG(`R.get('alerts').actions.trading.run({ what: 'rejected', on: false })`);
      ok('T8', 'Neo switches a trade alert off (rejected): saved; no order went anywhere', /rejected off/.test(did.shown) && ((api.posted.alertCfg || []).slice(-1)[0] || {}).trading.rejected === false && (api.posted.pp || []).filter(([m]) => m !== 'GET').length === posts, JSON.stringify(did));
      await REG(`R.get('alerts').actions.trading.run({ what: 'rejected', on: true })`);
      ok('T8', 'the trading entry has no order, cancel, book or kill action', await REG(`Object.keys(R.get('trading').actions)`).then((k) => k.join() === 'refresh,broker,alerts'));
      await REG(`R.get('trading').actions.alerts.run({})`);
      ok('T8', 'Neo opens Control ▸ Alerts ▸ Trading', await until(`(function(){var e=document.querySelector('[data-al-trading]'); if(!e) return false; var r=e.getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight - 40;})()`, 5000));
      ok('T8', 'no sideways scroll', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`));
    }

    // T9: Add card = every card of every tab (A1-Priv TradeHub/ui/card-picker.js, card-catalog.js, layout-foreign.js)
    const PK = `document.querySelector('.cpk-scrim [data-card-picker]')`;
    const openPk = (scope) => js(`var b=document.querySelector('${scope} [data-lay-add-open]'); if(!b) return false; b.click(); return true;`);
    const pkTab = (t) => js(`${PK}.querySelector('[data-cpk-tab="${t}"]').click(); 1`);
    const pkAdd = (k) => js(`var b=${PK}.querySelector('[data-cpk-add="${k}"]'); if(!b||b.disabled) return false; b.click(); return true;`);
    if (want('T9')) {
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
      await tab('trading'); await setBrokerTo('alpaca'); await until(`${EQ}==='$100,000.00'`, 6000);
      ok('T9', 'Add card is a button that opens the popup', await openPk('[data-trading-tab]') && await until(`!!${PK}`, 3000));
      ok('T9', '...a section per tab: Trading first ("This tab"), then Market, Charts, Scanner, Invest, Neo Quant, Risk, Edge, Memory', await js(`var t=[].map.call(${PK}.querySelectorAll('[data-cpk-tab]'),function(b){return b.dataset.cpkTab;}).join(); return t==='trading,market,charts,scanner,invest,neo,risk,edge,memory' && /This tab/.test(${PK}.querySelector('[data-cpk-tab="trading"]').textContent);`),
        await js(`return [].map.call(${PK}.querySelectorAll('[data-cpk-tab]'),function(b){return b.dataset.cpkTab;}).join();`));
      ok('T9', '...each card with one line on what it shows; the ones on the grid say so', await js(`var a=${PK}.querySelector('[data-cpk-item="trading:account"]'); return !!a && /On this tab/.test(a.textContent) && a.querySelector('.cpk-txt span').textContent.length > 20;`));
      ok('T9', '...the popup fits the screen' + (w < 600 ? ' as a bottom sheet, tabs as chips' : ', centred'), await js(`var r=${PK}.getBoundingClientRect(); return r.width <= innerWidth && ${w < 600 ? 'Math.abs(r.bottom - innerHeight) < 2 && getComputedStyle(' + PK + '.querySelector(".cpk-nav")).flexDirection==="row"' : 'r.left > 0 && r.top > 0'};`), await js(`return JSON.stringify(${PK}.getBoundingClientRect());`));
      await shot('t9-picker-' + w);
      ok('T9', 'Trading\'s own hidden card (Trade) comes back', await pkAdd('trading:trade') && await until(`!!document.querySelector('[data-trading-tab] .lay-card[data-card="trade"]')`, 3000));
      await pkTab('risk');
      ok('T9', 'Risk ▸ Exposure added to Trading: the Risk card itself, drawn inside', await pkAdd('risk:exposure') && await until(`!!document.querySelector('[data-trading-tab] .lay-card[data-card="x-risk-exposure"] [data-rk-exposure]')`, 8000));
      ok('T9', 'a second Risk card (Drawdown) is drawn by the same Risk module: one holder, two cards', await pkAdd('risk:drawdown') && await until(`!!document.querySelector('[data-trading-tab] .lay-card[data-card="x-risk-drawdown"] [data-rk-drawdown]')`, 8000)
        && await js(`return document.querySelectorAll('.lay-portal-holder[data-portal-tab="risk"]').length === 1;`), await js(`return document.querySelectorAll('.lay-portal-holder').length;`));
      await pkTab('charts');
      ok('T9', 'Charts ▸ Chart added: a live chart on Trading', await pkAdd('charts:chart') && await until(`!!document.querySelector('[data-trading-tab] .lay-card[data-card="x-charts-chart"] canvas')`, 10000));
      await pkTab('market');
      ok('T9', 'a Market card Trading already has (Regime) is shown in place, not added twice', await pkAdd('market:regime') && await until(`!!document.querySelector('[data-trading-tab] .lay-card[data-card="regime"]') && !document.querySelector('[data-card="x-market-regime"]')`, 4000));
      ok('T9', '...and the popup now says each is on this tab', await js(`return ['market:regime'].every(function(k){return /Added|On this tab/.test(${PK}.querySelector('[data-cpk-add="'+k+'"]').textContent);});`));
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
      ok('T9', 'Escape closes it', await until(`!${PK}`, 1500));
      ok('T9', 'a card from another tab never takes over Neo Quant\'s hook for its tab (no _tbOps.risk while Risk is not open)', await js(`return !(window._tbOps && window._tbOps.risk);`));
      ok('T9', '...each added card shows its home tab\'s title', await js(`var c=document.querySelector('[data-card="x-risk-exposure"]'); return /Exposure/.test(c.querySelector('.lay-title').textContent);`));
      await js(`document.querySelectorAll('.ot-scrim').forEach(function(s){s.remove();}); document.querySelector('[data-card="x-risk-exposure"]').scrollIntoView({block:'start'}); 1`); await new Promise((r) => setTimeout(r, 1500));
      await shot('t9-cards-' + w);
      await boot({ quant: true, keep: true }); await tab('trading');
      ok('T9', 'after a reload the cards from other tabs are still there (saved with the layout)', await until(`!!document.querySelector('[data-trading-tab] .lay-card[data-card="x-risk-exposure"] [data-rk-exposure]') && !!document.querySelector('[data-trading-tab] .lay-card[data-card="x-charts-chart"]')`, 10000));
      await js(`var d=document.querySelector('[data-card="x-risk-drawdown"] [data-act="hide"]'); if(d) d.click(); 1`);
      await js(`var b=document.querySelector('[data-card="x-risk-exposure"] [data-act="hide"]'); b.click(); 1`);
      ok('T9', '× takes a card from another tab off this tab (gone, not parked)', await until(`!document.querySelector('[data-card="x-risk-exposure"]')`, 3000));
      ok('T9', '...the last Risk card gone: the Risk module goes too', await until(`!document.querySelector('.lay-portal-holder[data-portal-tab="risk"]')`, 3000));
      await openPk('[data-trading-tab]'); await until(`!!${PK}`, 3000); await pkTab('risk');
      ok('T9', '...and the popup offers it again', await js(`var b=${PK}.querySelector('[data-cpk-add="risk:exposure"]'); return !!b && !b.disabled && b.textContent==='Add';`));
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
      await js(`var b=document.querySelector('[data-card="x-charts-chart"] [data-act="hide"]'); if(b) b.click(); var t=document.querySelector('[data-trading-tab] .lay-card[data-card="trade"] [data-act="hide"]'); if(t) t.click(); var g=document.querySelector('[data-trading-tab] .lay-card[data-card="regime"] [data-act="hide"]'); if(g) g.click(); 1`);
      // Another tab: Trading's Account on Market.
      await tab('market');
      ok('T9', 'on Market: Trading ▸ Account adds the paper account ($100,000)', await openPk('.mk-page') && await until(`!!${PK}`, 3000) && await pkTab('trading').then(() => pkAdd('trading:account'))
        && await until(`/\\$100,000\\.00/.test((document.querySelector('[data-lay="market"] .lay-card[data-card="x-trading-account"]')||{}).textContent||'')`, 8000));
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 1`);
      await js(`var b=document.querySelector('[data-card="x-trading-account"] [data-act="hide"]'); if(b) b.click(); 1`);
      ok('T9', 'no sideways scroll', await js(`return document.documentElement.scrollWidth <= window.innerWidth + 1;`));
    }
  }

  console.log('\nBy phase: ' + Object.entries(byPhase).map(([k, v]) => `${k} ${v.pass}/${v.pass + v.fail}`).join(', '));
  console.log(`${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
