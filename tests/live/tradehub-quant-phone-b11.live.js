// Tony 2026-11-21, two phone fixes (A1-Priv TradeHub):
//   1. dragging a card's TOP edge down shrinks it from the top (its bottom stays put, the page scrolls by the change;
//      before, the top stayed and the bottom rose: "shrinks it from bottom up") (ui/layout.js)
//   2. in Neo Quant, a swipe down with nothing left to scroll never pulls the page to refresh: the page refuses
//      overscroll while Neo Quant is on screen, and its scrollers contain their own (neo/neo.css)
//
// Run: node tests/live/tradehub-quant-phone-b11.live.js   (own CDP_PORT)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};

(async () => {
  const api = quantApi();
  const c = await connect({ mock: api.mock });
  const errs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  const { js, until, size, boot, tab } = driver(c);
  await size(390, 844);
  await boot({ quant: true }); await tab('market'); await sleep(2500);
  const rect = (sel) => js(`var b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({t:b.top,b:b.bottom,h:b.height,x:b.left+b.width/2});`).then(JSON.parse);
  const touchDrag = async (from, to, steps = 10) => {
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    for (let i = 1; i <= steps; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps, id: 1 }] }); await sleep(40); }
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(400);
  };

  console.log('\n1. A card\'s top edge, dragged down on a phone');
  // A card well down the page, so there is page above it to scroll.
  const id = await js(`var cs=[...document.querySelectorAll('[data-mk] .lay-card')].filter(function(e){return e.offsetHeight>200;}); var c=cs[Math.min(3, cs.length-1)]; return c ? c.getAttribute('data-card') : '';`);
  const CARD = `[data-mk] .lay-card[data-card="${id}"]`;
  await js(`var e=document.querySelector('${CARD}'); var y=e.getBoundingClientRect().top + (document.scrollingElement.scrollTop) - 300; (document.querySelector('.tb-scroll-visible')||document.scrollingElement).scrollTop = Math.max(0, y); window.scrollTo(0, Math.max(0, y)); 1`); await sleep(400);
  const r0 = await rect(CARD), e0 = await rect(`${CARD} > .a1-edge[data-edge="n"]`);
  await touchDrag({ x: e0.x, y: e0.t + 3 }, { x: e0.x, y: e0.t + 3 + 120 });
  const r1 = await rect(CARD);
  ok(`${id}: it got shorter`, r1.h < r0.h - 40, JSON.stringify([r0, r1]));
  ok('...from the top: its bottom stayed where it was (within one grid row) and its top came down', Math.abs(r1.b - r0.b) <= 30 && r1.t > r0.t + 40, JSON.stringify([r0, r1]));

  console.log('\n2. Neo Quant never pulls the page to refresh');
  ok('Neo Quant shut: the page keeps its normal overscroll', await js(`return getComputedStyle(document.documentElement).overscrollBehaviorY !== 'none';`));
  await js(`document.querySelector('[data-nq-launch]').click(); 1`);
  await until(`!document.querySelector('[data-nq-dock]').hidden`, 8000); await sleep(500);
  ok('the dock open: the page refuses overscroll (no pull to refresh)', await js(`return getComputedStyle(document.documentElement).overscrollBehaviorY === 'none' && getComputedStyle(document.body).overscrollBehaviorY === 'none';`), await js(`return getComputedStyle(document.documentElement).overscrollBehaviorY;`));
  ok('...and its conversation keeps its own overscroll', await js(`return getComputedStyle(document.querySelector('[data-nq-dock] .nq-list')).overscrollBehaviorY === 'contain';`));
  await js(`var x=document.querySelector('[data-nq-dock] [data-nq-close]')||document.querySelector('[data-nq-launch]'); x.click(); 1`); await sleep(500);
  ok('the dock shut again: normal overscroll back', await js(`return document.querySelector('[data-nq-dock]').hidden ? getComputedStyle(document.documentElement).overscrollBehaviorY !== 'none' : true;`));
  await tab('neo'); await sleep(1500);
  ok('the Neo Quant tab: the page refuses overscroll too', await js(`return !!document.querySelector('[data-nq-shell]') && getComputedStyle(document.documentElement).overscrollBehaviorY === 'none';`), await js(`return getComputedStyle(document.documentElement).overscrollBehaviorY + ' / shell ' + !!document.querySelector('[data-nq-shell]');`));
  await tab('market'); await sleep(800);
  ok('...and back on Market, normal again', await js(`return getComputedStyle(document.documentElement).overscrollBehaviorY !== 'none';`));

  ok('no page errors', !errs.length, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
