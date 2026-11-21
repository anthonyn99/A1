// B11 (ask 17, carried from B6): every scroller INSIDE a card at 390 px, worked with a finger. On each tab, each
// box in a card that scrolls (Scanner's and Paper's tables, the Levels list, Edge's breakdown, …) is swiped; A1's
// scrollbar (Shared/scrollbar.js) must then show on it, and its rail must not sit on any text in that box: the
// thumb's strip is checked against every text line under it.
//
// Run: node tests/live/tradehub-quant-scrollers-390.live.js   (own CDP_PORT)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, bigJournal } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 600) : '')); }
};
const TABS = (process.env.TABS || 'market,charts,scanner,paper,portfolio,journal,catalysts,control').split(',');

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const { js, size, boot, tab } = driver(c);
  await size(390, 844);
  await boot({ quant: true, ...(bigJournal ? { journal: bigJournal(60) } : {}) });
  let seenAny = 0;
  for (const t of TABS) {
    try { await tab(t); } catch (e) { console.log(`  (skip ${t}: ${e.message || e})`); continue; }
    await sleep(2500);
    // Every box inside a card that scrolls on its own (not the page), marked so each can be found again.
    const boxes = JSON.parse(await js(`var out=[]; document.querySelectorAll('.lay-card .lay-body, .lay-card .lay-body *').forEach(function(e,i){ var cs=getComputedStyle(e); var v=/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 4, hz=/(auto|scroll)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 4; if(!(v||hz)) return; var r=e.getBoundingClientRect(); if(r.width < 60 || r.height < 40) return; e.setAttribute('data-sc390', t + i); var card=e.closest('.lay-card'); out.push({id: t + i, v: v, h: hz, card: card && card.getAttribute('data-card'), cls: String(e.className).slice(0, 40)}); }); return JSON.stringify(out);`.replace(/\bt \+ i\b/g, `'${t}-' + i`)));
    console.log(`\n${t}: ${boxes.length} inner scroller(s)`);
    for (const b of boxes) {
      const sel = `document.querySelector('[data-sc390="${b.id}"]')`;
      await js(`${sel}.scrollIntoView({block:'center'}); 1`); await sleep(250);
      const r = JSON.parse(await js(`var r=${sel}.getBoundingClientRect(); return JSON.stringify({l:r.left,t:r.top,w:r.width,h:r.height});`));
      if (r.t < 0 || r.t + r.h > 844 + r.h) continue;
      // A finger swipe inside it: up for a vertical scroller, left for a horizontal one.
      const x0 = r.l + r.w * 0.5, y0 = Math.max(r.t + 10, Math.min(r.t + r.h * 0.6, 800)), dx = b.v ? 0 : -60, dy = b.v ? -60 : 0;
      await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
      for (let i = 1; i <= 6; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dx * i / 6, y: y0 + dy * i / 6, id: 1 }] }); await sleep(16); }
      await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(180);
      const res = JSON.parse(await js(`var el=${sel}, er=el.getBoundingClientRect(), axis=${b.v ? "'v'" : "'h'"};
        var rails=[...document.querySelectorAll('.vc-rail.' + axis)].filter(function(x){ return x.classList.contains('on') && getComputedStyle(x).display !== 'none'; }).map(function(x){ return x.getBoundingClientRect(); })
          .filter(function(q){ return axis==='v' ? (q.left >= er.left - 2 && q.right <= er.right + 14 && q.bottom > er.top && q.top < er.bottom) : (q.top >= er.top - 2 && q.bottom <= er.bottom + 14 && q.right > er.left && q.left < er.right); });
        if (!rails.length) return JSON.stringify({ shown:false, scrolled: el.scrollTop || el.scrollLeft });
        var q=rails[0], hits=[]; var w=document.createTreeWalker(el, NodeFilter.SHOW_TEXT); var n;
        while ((n = w.nextNode())) { if (!n.textContent.trim()) continue; var rg=document.createRange(); rg.selectNodeContents(n); [...rg.getClientRects()].forEach(function(t){ if (t.width < 1 || t.bottom < er.top || t.top > er.bottom) return; var over = axis==='v' ? (t.right > q.left + 0.5 && t.left < q.right - 0.5 && t.bottom > q.top && t.top < q.bottom) : (t.bottom > q.top + 0.5 && t.top < q.bottom - 0.5 && t.right > q.left && t.left < q.right); if (over) hits.push(n.textContent.trim().slice(0, 20)); }); }
        return JSON.stringify({ shown:true, rail:[Math.round(q.left), Math.round(q.top), Math.round(q.width), Math.round(q.height)], hits: hits.slice(0, 5) });`));
      seenAny++;
      ok(`${t} · ${b.card || '?'} (${b.v ? 'vertical' : 'sideways'}, ${b.cls || 'box'}): a swipe shows A1's bar, and it sits on no text`, res.shown && !res.hits.length, JSON.stringify(res));
    }
  }
  ok('at least one inner scroller was found and swiped', seenAny > 0);
  ok('no page errors', !errs.length, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
