// TradeHub Quant Refinements Batch 2, B6 (A1-Priv docs/TradeHub/quant/r2-06.md): every card's frame.
//   ask 43  watchlist rows never overlap or run off the card (Tony's Cryptos list, a narrow rail)
//   ask 16  the selected row's highlight fills the row
//   ask 30  no slanted grip in a card's corner
//   ask 35  Add card: no count, only what can be added
//   ask 39  Key Stats and Analysis are not Market's cards
//   ask 15/19  the cards that had a footer line carry it in their "?" instead
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-cards-b6.live.js
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const COINS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'AVAXUSD', 'LINKUSD', 'XRPUSD', 'DOGEUSD', 'SUIUSD', 'USDCUSD'];
const PRICES = { 'BTC-USD': 58243.61, 'ETH-USD': 1595.76, 'SOL-USD': 67.28, 'AVAX-USD': 6.41, 'LINK-USD': 8.29, 'XRP-USD': 0.8894, 'DOGE-USD': 0.10527, 'SUI-USD': 0.6321 };

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const { js, until, size, boot, tab } = driver(c);

  // Ask 43 + 16: the Cryptos list on a desktop rail narrowed to 205 px (Tony's card was ~235 px wide).
  await size(1700, 950);
  await boot({ quant: true, watchlist: COINS });
  await tab('charts');
  await until(`document.querySelectorAll('[data-ch-rail] .ch-row').length > 5`, 20000); await sleep(1200);
  for (const [k, v] of Object.entries(PRICES)) await js(`window.__ws.cbTick('${k}', ${v}, ${v * 1.06}); 1`);
  await sleep(1000);
  await js(`var l=document.querySelector('[data-ch-rail] .ch-rail-list')||document.querySelector('[data-ch-rail]'); l.style.width='205px'; document.querySelector('[data-ch-rail] .ch-row').click(); 1`); await sleep(800);
  const rows = JSON.parse(await js(`var out=[]; document.querySelectorAll('[data-ch-rail] .ch-row').forEach(function(r){ var q=function(s){return r.querySelector(s);}; var list=r.parentElement.getBoundingClientRect(), rb=r.getBoundingClientRect();
    var a=q('.ch-row-sym').getBoundingClientRect(), b=q('.ch-row-px').getBoundingClientRect(), cc=q('.ch-row-chg').getBoundingClientRect(), n=q('.ch-near'), nb=n?n.getBoundingClientRect():null;
    out.push({ s:r.dataset.sym, gap1:b.left-a.right, gap2:cc.left-b.right, out:Math.max(rb.right, cc.right, nb?nb.right:0)-list.right-0.5, on:r.classList.contains('is-on'), fill: r.classList.contains('is-on') ? Math.abs(rb.width-list.width) : 0,
      cut: [q('.ch-row-sym'), q('.ch-row-px'), q('.ch-row-chg')].filter(function(e){return e.scrollWidth>e.clientWidth+1;}).length }); }); return JSON.stringify(out);`));
  const bad = rows.filter((r) => r.gap1 < 4 || r.gap2 < 4 || r.out > 0);
  ok('Cryptos at 205 px: symbol, price and change never touch, nothing runs past the list edge (ask 43)', rows.length >= 8 && !bad.length, JSON.stringify(bad));
  ok('...symbols, prices and changes are shown whole (nothing cut to an ellipsis at this width)', rows.every((r) => !r.cut), JSON.stringify(rows.filter((r) => r.cut)));
  ok('the selected row\'s highlight fills the row, edge to edge (ask 16)', rows.some((r) => r.on) && rows.filter((r) => r.on).every((r) => r.fill < 1), JSON.stringify(rows.filter((r) => r.on)));

  // Ask 30: no hatch in any card's corner.
  const hatch = await js(`return [].slice.call(document.querySelectorAll('.lay-card > .a1-edge[data-edge="se"]')).filter(function(e){ return getComputedStyle(e,'::before').display !== 'none'; }).length;`);
  const cardsN = await js(`return document.querySelectorAll('.lay-card').length;`);
  ok('no slanted grip drawn in any card corner (ask 30), and the corner still resizes', cardsN > 0 && hatch === 0 && (await js(`return document.querySelectorAll('.lay-card > .a1-edge[data-edge="se"]').length;`)) > 0, `${hatch} of ${cardsN}`);

  // Asks 15/19: footers leave the card face and are read into its "?" (Charts' Key Stats and Analysis follow a stock).
  await boot({ quant: true }); await tab('charts');
  await until(`document.querySelector('.lay-card[data-card="stats"] .sk-src, .lay-card[data-card="analysis"] .sk-src')`, 20000); await sleep(800);
  const shown = await js(`return [].slice.call(document.querySelectorAll('.lay-card .lay-body .sk-src, .lay-card .lay-body [data-help-note]')).filter(function(e){ return e.offsetParent !== null; }).length;`);
  ok('no source or "updated" footer is shown on any Charts card (ask 19)', shown === 0, shown);
  const help = await js(`var b=document.querySelector('[data-lay-help="stats"]')||document.querySelector('[data-lay-help="analysis"]'); if(!b) return ''; b.click(); var t=document.querySelector('[data-lay-helptip]'); return t ? t.textContent : '';`);
  ok('...the card\'s "?" carries them under "Sources and updates"', /Sources and updates/.test(help) && /Source|follow the chart/i.test(help), help.slice(0, 200));
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); 1`);

  // Asks 35 and 39 on Market.
  await size(1280, 900); await tab('market'); await sleep(1500);
  const add = JSON.parse(await js(`var s=document.querySelector('[data-lay-add]'); return JSON.stringify(s ? { label: s.options[0].textContent, opts: [].slice.call(s.options).slice(1).map(function(o){return o.value;}), hidden: s.hidden } : null);`));
  ok('Add card says "Add card", no count (ask 35)', add && add.label === 'Add card', JSON.stringify(add));
  ok('...Key Stats and Analysis are not offered on Market (ask 39)', add && !add.opts.includes('stats') && !add.opts.includes('analysis'), JSON.stringify(add));
  // Batch 4 T9 (Tony 2026-11-22: any card from any tab): there is always something to add, so the button always shows; the select stays out of sight.
  ok('...Add card is always there (T9: every tab's cards), the old menu out of sight', add && await js(`var b=document.querySelector('[data-lay-add-open]'), s=document.querySelector('[data-lay-add]'); return !!b && !!b.offsetParent && b.textContent==='Add card' && getComputedStyle(s).opacity==='0';`), JSON.stringify(add));

  // §1 rule 1 (asks 15, 19): no card ends in explanatory text on its face (sources, method notes, "Updated …"):
  // those live in the card's "?". A data line (Chart's one-line read) or an empty state ("No conversations yet")
  // is not a footer. Every tab, three widths.
  for (const [w, hh] of [[1280, 900], [820, 1100], [390, 844]]) {
    await size(w, hh); await sleep(500);
    const found = [];
    for (const t of ['portfolio', 'journal', 'prompt', 'catalysts', 'news', 'analysis', 'market', 'charts', 'scanner', 'neo', 'paper']) {
      try { await tab(t); } catch (e) { continue; }
      await sleep(1800);
      found.push(...JSON.parse(await js(`
        var res=[];
        document.querySelectorAll('.lay-card .lay-body').forEach(function(body){
          body.querySelectorAll('.mk-note, .sk-src').forEach(function(n){
            if(n.closest('[data-help-note],[data-empty]') || n.matches('.ch-oneline') || !n.getClientRects().length || !n.textContent.trim()) return;
            var after=false, x=n; while(x && x!==body){ var s=x.nextElementSibling; while(s){ if(s.getClientRects().length && s.textContent.trim()){ after=true; break; } s=s.nextElementSibling; } if(after) break; x=x.parentElement; }
            if(!after) res.push(${JSON.stringify(t)}+': '+n.textContent.trim().replace(/\\s+/g,' ').slice(0,70));
          });
        });
        return JSON.stringify(res);`)));
    }
    ok(`${w} px: no card ends in a footer note on any tab (§1 rule 1)`, !found.length, found.join(' | '));
  }

  ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
