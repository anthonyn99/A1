'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');
(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  const { js, size, boot, tab } = driver(c);
  await size(1504, 900); await boot({ quant: true });
  for (const t of ['portfolio', 'journal', 'prompt', 'catalysts', 'news', 'analysis', 'market', 'charts', 'scanner', 'neo', 'paper']) {
    try { await tab(t); } catch (e) { continue; }
    await sleep(2500);
    const out = await js(`
      var res=[];
      document.querySelectorAll('.lay-card').forEach(function(card){
        var body=card.querySelector('.lay-body'); if(!body) return;
        var name=(card.querySelector('.lay-title, .lay-head h2, .lay-head h3, [data-lay-title]')||{}).textContent||card.getAttribute('data-card')||'?';
        body.querySelectorAll('.mk-note, .sk-src, small, .mk-foot, .mk-src').forEach(function(n){
          if(n.closest('[data-help-note]') || !n.getClientRects().length) return;
          // at the bottom: nothing visible after it inside the body
          var after=false, x=n; while(x && x!==body){ var s=x.nextElementSibling; while(s){ if(s.getClientRects().length && s.textContent.trim()) { after=true; break; } s=s.nextElementSibling; } if(after) break; x=x.parentElement; }
          if(!after) res.push(name.trim().slice(0,24)+' | '+(n.className||n.tagName)+' | '+n.textContent.trim().replace(/\\s+/g,' ').slice(0,110));
        });
      });
      return JSON.stringify(res);`);
    console.log('== ' + t); for (const r of JSON.parse(out)) console.log('   ' + r);
  }
  c.ws.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
