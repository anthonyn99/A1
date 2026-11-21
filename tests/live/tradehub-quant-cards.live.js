// TradeHub Quant refinements, R1 (A1-Priv docs/TradeHub/quant/r1-01.md): the
// card system v2 in the real page, at 1280, 820 and 390 px.
//
//   1. desktop / tablet: no card displaces another (Tony, 2026-11-19): over a
//      card the outline is red, nothing moves, the drop is refused; into a free
//      hole the card lands exactly on its outline. Phone: the stack's preview
//      is the landing (A1Drag)
//   2. every edge and corner resizes (A1Resize.edges): whole units, a left or
//      top drag grows the card without moving it in the order
//   3. Layout ▸ Save as my default / Reset to my default / Reset to original,
//      kept in dashboards/tradehub_layout[tab].mine[cls]
//   4. a "?" on every card of every card tab (Market, Charts, Scanner board,
//      Invest, Backtest, Neo, Memory, Paper, Risk, Edge): hover title, tap bubble
//   5. refresh buttons are the icon, labelled
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-cards.live.js
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
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Page.javascriptDialogOpening') c.send('Page.handleJavaScriptDialog', { accept: true });
  });
  const { js, until, size, boot, tab } = driver(c);
  const G = `document.querySelector('[data-mk] .lay-grid')`;
  const order = () => js(`return [...${G}.querySelectorAll(':scope > .lay-card')].map(function(e){return e.dataset.card;}).join();`);
  const centre = (sel) => js(`var b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2,l:b.left,t:b.top,r:b.right,b:b.bottom,w:b.width,h:b.height});`).then(JSON.parse);
  // Every card's rect, relative to the grid (so a page scroll between two reads cancels out).
  const rects = () => js(`var g=${G}.getBoundingClientRect(), o={}; ${G}.querySelectorAll(':scope > .lay-card').forEach(function(e){ var b=e.getBoundingClientRect(); o[e.dataset.card]=[b.left-g.left,b.top-g.top,b.width,b.height].map(function(v){return Math.round(v*10)/10;}); }); return JSON.stringify(o);`).then(JSON.parse);
  const span = (id) => js(`var e=document.querySelector('[data-mk] .lay-card[data-card="${id}"]'); return e.dataset.w+'x'+e.dataset.h;`);
  const press = (x, y) => c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  const moveTo = async (from, to, steps = 14) => { for (let i = 1; i <= steps; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps, button: 'left', buttons: 1 }); await sleep(16); } };
  const release = (x, y) => c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  async function mouseDrag(from, to) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await press(from.x, from.y); await moveTo(from, to); await sleep(120);
    await release(to.x, to.y); await sleep(600);
  }
  const menu = (v) => js(`var m=document.querySelector('[data-mk] [data-lay-reset]'); m.value='${v}'; m.dispatchEvent(new Event('change',{bubbles:true})); 1`);
  const open = async () => { await tab('market'); if (!(await until(`document.querySelector('[data-mk-score]') && document.querySelector('[data-mk-analogs]')`, 15000))) throw new Error('Market did not draw'); await sleep(500); };
  const scrollTo = (id) => js(`document.querySelector('[data-mk] .lay-card[data-card="${id}"]').scrollIntoView({block:'center'}); 1`).then(() => sleep(250));

  // A drag held over its target: the preview's rects, then the drop's.
  async function previewVsDrop(id, target, dx = 0, dy = 0) {
    await scrollTo(target);
    const t = await centre(`[data-mk] .lay-card[data-card="${target}"] .lay-title`);
    await scrollTo(id);
    const a = await centre(`[data-mk] .lay-card[data-card="${id}"] .lay-title`);
    const t2 = await centre(`[data-mk] .lay-card[data-card="${target}"] .lay-title`);
    const before = await order(), was = (await rects())[id];
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
    await press(a.x, a.y);
    await moveTo(a, { x: t2.x + dx, y: t2.y + dy });
    await sleep(450);   // the slides (.17 s) have finished
    const mid = await rects();
    // Desktop and tablet (free placement, 2026-11-19): the dashed outline where the card will land.
    const ghost = await js(`var g=${G}.querySelector('.lay-ghost'); if(!g) return 'null'; var b=g.getBoundingClientRect(), gr=${G}.getBoundingClientRect(); return JSON.stringify([Math.round(b.left-gr.left), Math.round(b.top-gr.top), Math.round(b.width), Math.round(b.height)]);`).then(JSON.parse);
    await release(t2.x + dx, t2.y + dy);
    await sleep(800);
    const after = await rects(), now = await order();
    const off = Object.keys(after).filter((k) => k !== id && mid[k] && after[k].some((v, i) => Math.abs(v - mid[k][i]) > 1.5)).map((k) => k + ' ' + mid[k] + ' → ' + after[k]);
    // Phone: the stack's order changed. Desktop and tablet: the card is somewhere else, exactly on the outline.
    const moved = ghost ? after[id].some((v, i) => Math.abs(v - was[i]) > 1.5) : now !== before;
    const onGhost = !ghost || after[id].every((v, i) => Math.abs(v - ghost[i]) <= 2);
    if (!onGhost) off.push(id + ' landed ' + after[id] + ', outline ' + ghost);
    return { moved, off, before, now, ghost };
  }

  for (const [w, h] of [[1280, 900], [820, 1180], [390, 844]]) {
    console.log(`\n${w} px: the drop preview is the landing`);
    await size(w === 1280 ? 1504 : w, h);
    await boot({ quant: true });
    await open();
    if (w === 390) {
      // The phone stack: A1Drag reorders it, and the preview is the landing.
      for (const [id, target, dx, dy] of [['regime', 'breadth', 0, 60], ['volume', 'regime']]) {
        const r = await previewVsDrop(id, target, dx || 0, dy || 0);
        ok(`${id} over ${target}: it moved, and every other card sat in the preview exactly where it landed`, r.moved && r.off.length === 0, (r.moved ? '' : 'not moved; ') + r.off.join(' | '));
      }
    } else {
      // Desktop and tablet (Tony, 2026-11-19): no card ever displaces another. Over a card the outline is red,
      // nothing else moves during the drag, and the drop is refused.
      const moves = w === 1280 ? [['volume', 'regime'], ['regime', 'streaks', 40], ['analogs', 'sectors']] : [['regime', 'sectors'], ['volume', 'regime']];
      for (const [id, target, dx, dy] of moves) {
        const before = await rects();
        await scrollTo(target);
        const t = await centre(`[data-mk] .lay-card[data-card="${target}"] .lay-title`);
        await scrollTo(id);
        const a = await centre(`[data-mk] .lay-card[data-card="${id}"] .lay-title`), t2 = await centre(`[data-mk] .lay-card[data-card="${target}"] .lay-title`);
        await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
        await press(a.x, a.y); await moveTo(a, { x: t2.x + (dx || 0), y: t2.y + (dy || 0) }); await sleep(300);
        const red = await js(`var g=${G}.querySelector('.lay-ghost'); return !!g && g.classList.contains('is-blocked');`);
        const mid = await rects();
        await release(t2.x + (dx || 0), t2.y + (dy || 0)); await sleep(700);
        const after = await rects();
        const still = (x) => Object.keys(before).every((k) => (k === id && x === mid) || before[k].every((v, i) => Math.abs(v - x[k][i]) <= 1.5));
        ok(`${id} over ${target}: a red outline, no other card moves, and the drop is refused`, red && still(mid) && still(after), JSON.stringify({ red, t: !!t }));
      }
      // A free spot takes the card, exactly on its outline: hide Regime, then drag Breadth into its hole.
      await js(`document.querySelector('[data-mk] .lay-card[data-card="regime"] [data-act="hide"]').click(); 1`); await sleep(500);
      const unitX = await js(`var g=${G}; var cols=${w === 1280 ? 12 : 8}; return (g.clientWidth-14*(cols-1))/cols+14;`);
      await scrollTo('breadth');
      const bt = await centre('[data-mk] .lay-card[data-card="breadth"] .lay-title'), b0 = await rects();
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bt.x, y: bt.y });
      await press(bt.x, bt.y); await moveTo(bt, { x: bt.x - 4 * unitX, y: bt.y }); await sleep(300);
      const ghost = await js(`var g=${G}.querySelector('.lay-ghost'); if(!g) return 'null'; var b=g.getBoundingClientRect(), gr=${G}.getBoundingClientRect(); return JSON.stringify({ red: g.classList.contains('is-blocked'), r: [Math.round(b.left-gr.left), Math.round(b.top-gr.top), Math.round(b.width), Math.round(b.height)] });`).then(JSON.parse);
      await release(bt.x - 4 * unitX, bt.y); await sleep(700);
      const b1 = await rects();
      ok('into a free hole: the outline is not red, the card lands exactly on it, the others stay', ghost && !ghost.red && b1.breadth.every((v, i) => Math.abs(v - ghost.r[i]) <= 2) && b1.breadth[0] < b0.breadth[0] - 50
        && Object.keys(b0).every((k) => k === 'breadth' || b0[k].every((v, i) => Math.abs(v - b1[k][i]) <= 1.5)), JSON.stringify({ ghost, was: b0.breadth, now: b1.breadth }));
      await menu('orig'); await sleep(500);
    }
    ok('no card overlaps another after the moves', await js(`var a=[...${G}.querySelectorAll(':scope > .lay-card')].map(function(e){return e.getBoundingClientRect();}), bad=0;
      for (var i=0;i<a.length;i++) for (var j=i+1;j<a.length;j++) { var p=a[i], q=a[j]; if (p.left < q.right-1 && q.left < p.right-1 && p.top < q.bottom-1 && q.top < p.bottom-1) bad++; } return bad===0;`));
    if (w !== 390) {
      // Free placement reaches a spot off screen: held at the top edge, the page scrolls and the outline climbs.
      const sc = `(function(){ var p=${G}.parentElement; while(p && p!==document.body){ var o=getComputedStyle(p).overflowY; if((o==='auto'||o==='scroll') && p.scrollHeight>p.clientHeight+1) return p; p=p.parentElement; } return document.scrollingElement; })()`;
      await js(`document.querySelector('[data-mk] .lay-card[data-card="macro"]').scrollIntoView({block:'end'}); 1`); await sleep(300);
      const top0 = (await rects()).macro[1], s0 = await js(`return ${sc}.scrollTop;`);
      const m = await centre('[data-mk] .lay-card[data-card="macro"] .lay-title');
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x, y: m.y });
      await press(m.x, m.y);
      await moveTo(m, { x: m.x, y: 8 });
      await sleep(1600);
      const s1 = await js(`return ${sc}.scrollTop;`);
      const g1 = await js(`var g=${G}.querySelector('.lay-ghost'), gr=${G}.getBoundingClientRect(); return g ? Math.round(g.getBoundingClientRect().top - gr.top) : null;`);
      const red = await js(`var g=${G}.querySelector('.lay-ghost'); return !!g && g.classList.contains('is-blocked');`);
      await release(m.x, 8); await sleep(800);
      const top1 = (await rects()).macro[1];
      // Up there every spot is another card's: the outline climbs (red) and the drop is refused (2026-11-19).
      ok(w + ' px: a card held at the top edge scrolls the page up and its outline climbs; over the cards there it is red and stays put', s1 < s0 - 100 && g1 != null && g1 < top0 && red && Math.abs(top1 - top0) <= 2, JSON.stringify({ s0, s1, top0, g1, top1, red }));
    }

    console.log(`${w} px: "?" on every card`);
    ok('every Market card has a "?" with its text', await js(`return [...document.querySelectorAll('[data-mk] .lay-card')].every(function(e){ var q=e.querySelector('[data-lay-help]'); return q && ((q.getAttribute('title')||q._a1cTitle||'').length > 12) && /^About /.test(q.getAttribute('aria-label')); });`));
    if (w === 390) await c.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await scrollTo('breadth');
    const q = await centre('[data-mk] .lay-card[data-card="breadth"] [data-lay-help]');
    if (w === 390) { await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: q.x, y: q.y }] }); await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
    else { await press(q.x, q.y); await release(q.x, q.y); }
    await sleep(250);
    const bub = await js(`var b=document.querySelector('[data-mk] [data-lay-helptip="breadth"]'); if(!b) return '{}'; var r=b.getBoundingClientRect(), c=document.querySelector('[data-mk] .lay-card[data-card="breadth"]').getBoundingClientRect(), top=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
      return JSON.stringify({ shown: r.height > 20 && b.contains(top), text: b.textContent, inside: r.left >= c.left - 0.5 && r.right <= c.right + 0.5, under: r.top >= c.top + 30 });`).then(JSON.parse);
    ok((w === 390 ? 'a tap' : 'a click') + ' on the "?" opens its bubble under the title, within the card\'s width, on top', bub.shown && /take part/.test(bub.text) && bub.inside && bub.under, JSON.stringify(bub));
    ok('...the card did not move (the "?" is no drag handle)', !(await js(`return !!document.querySelector('.dsort-drag');`)));
    if (w === 390) { await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 10, y: 400 }] }); await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
    else { await press(5, 400); await release(5, 400); }
    await sleep(200);
    ok('a press anywhere else closes it', await js(`return !document.querySelector('[data-mk] [data-lay-helptip]');`));
    if (w === 1280) {
      // A collapsed card is one row tall and clips its content: the bubble must not live in it.
      const fold = await centre('[data-mk] .lay-card[data-card="breadth"] .lay-ib[data-act="collapse"]');
      await press(fold.x, fold.y); await release(fold.x, fold.y); await sleep(400);
      const q2 = await centre('[data-mk] .lay-card[data-card="breadth"] [data-lay-help]');
      await press(q2.x, q2.y); await release(q2.x, q2.y); await sleep(250);
      ok('on a collapsed card the bubble shows whole (it sits outside the card)', await js(`var b=document.querySelector('[data-mk] [data-lay-helptip="breadth"]'); if(!b) return false; var r=b.getBoundingClientRect(); return r.height > 40 && b.contains(document.elementFromPoint(r.left+r.width/2, r.bottom-6));`));
      await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 1`); await sleep(150);
      ok('Escape closes it', await js(`return !document.querySelector('[data-mk] [data-lay-helptip]');`));
      await press(fold.x, fold.y); await release(fold.x, fold.y); await sleep(400);
    }
    if (w === 390) await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });

    console.log(`${w} px: refresh is the icon`);
    ok('Market\'s refresh: an icon, no word, labelled and titled', await js(`var b=document.querySelector('[data-mk-refresh]'); return !!b.querySelector('svg') && !b.textContent.trim() && b.getAttribute('aria-label')==='Refresh the market' && !!(b.getAttribute('title')||b._a1cTitle);`));
  }

  console.log('\n1280 px: resize from every edge and corner');
  await size(1504, 900);
  await boot({ quant: true });
  await open();
  ok('eight handles on every card, the se one a labelled button', await js(`return [...document.querySelectorAll('[data-mk] .lay-card')].every(function(e){ return e.querySelectorAll(':scope > .a1-edge').length === 8; }) && document.querySelector('[data-mk] .a1-edge[data-edge="se"]').tagName==='BUTTON';`));
  const unit = await js(`var g=${G}; return JSON.stringify({ x:(g.clientWidth-14*11)/12+14, y:58 });`).then(JSON.parse);
  const grab = async (edge) => {
    await scrollTo('breadth');
    const b = await centre(`[data-mk] .lay-card[data-card="breadth"] .a1-edge[data-edge="${edge}"]`);
    return { x: b.x, y: b.y };
  };
  // Room on every side first (no card is pushed any more, 2026-11-19): its neighbours are hidden, then the
  // card is dragged (free placement) one column right and three rows down.
  for (const n of ['regime', 'sectors', 'rotation', 'streaks']) { await js(`document.querySelector('[data-mk] .lay-card[data-card="${n}"] [data-act="hide"]').click(); 1`); await sleep(250); }
  { await scrollTo('breadth'); const tt = await centre('[data-mk] .lay-card[data-card="breadth"] .lay-title'); await mouseDrag(tt, { x: tt.x + unit.x, y: tt.y + 3 * unit.y }); }
  const cases = [['e', 1, 0, [1, 0]], ['w', -1, 0, [1, 0]], ['s', 0, 1, [0, 1]], ['n', 0, -1, [0, 1]], ['se', -1, -1, [-1, -1]], ['nw', 1, 1, [-1, -1]], ['ne', 1, -1, [1, 1]], ['sw', -1, 1, [1, 1]]];
  for (const [edge, ux, uy, [dw, dh]] of cases) {
    const s0 = (await span('breadth')).split('x').map(Number), o0 = await order();
    const p = await grab(edge);
    const r0 = await centre('[data-mk] .lay-card[data-card="breadth"]');
    await mouseDrag(p, { x: p.x + ux * unit.x + Math.sign(ux) * 5, y: p.y + uy * unit.y + Math.sign(uy) * 5 });
    const s1 = (await span('breadth')).split('x').map(Number), r1 = await centre('[data-mk] .lay-card[data-card="breadth"]');
    ok(`${edge}: ${dw >= 0 ? '+' : ''}${dw} wide, ${dh >= 0 ? '+' : ''}${dh} tall, in whole units`, s1[0] === s0[0] + dw && s1[1] === s0[1] + dh && (await order()) === o0, s0.join('x') + ' → ' + s1.join('x'));
    // 2026-11-19 (Tony): the edge dragged moves; the opposite edge stays put.
    const near = (a, b) => Math.abs(a - b) <= 2;
    const keep = [edge.includes('w') ? near(r1.r, r0.r) : edge.includes('e') ? near(r1.l, r0.l) : near(r1.l, r0.l) && near(r1.r, r0.r),
      edge[0] === 'n' ? near(r1.b, r0.b) : edge[0] === 's' ? near(r1.t, r0.t) : near(r1.t, r0.t) && near(r1.b, r0.b)];
    ok(`${edge}: the opposite edge${edge.length > 1 ? 's stay' : ' stays'} where ${edge.length > 1 ? 'they were' : 'it was'}`, keep.every(Boolean), JSON.stringify({ r0, r1 }));
  }
  ok('a handle press never started a card drag', !(await js(`return !!document.querySelector('.dsort-drag');`)));

  console.log('\nMy default and Original');
  await menu('orig'); await sleep(400);
  const orig = await rects();
  await scrollTo('volume');
  const hide = await centre('[data-mk] .lay-card[data-card="volume"] .lay-ib[data-act="hide"]');
  await press(hide.x, hide.y); await release(hide.x, hide.y); await sleep(400);
  ok('(Hide took Unusual volume off the grid)', !(await js(`return !!document.querySelector('[data-mk] .lay-card[data-card="volume"]');`)));
  await scrollTo('regime');
  const e1 = await grab('e');
  await mouseDrag(e1, { x: e1.x + unit.x + 5, y: e1.y });
  const mineOrder = await order(), mineSpan = await span('breadth');
  ok('"Reset to my default" is off until one is saved', await js(`return document.querySelector('[data-mk] [data-lay-reset] option[value="mine"]').disabled;`));
  await menu('save'); await sleep(300);
  // B7 (ask 10): the menu no longer says "Saved as my default"; the save reports to TradeHub's ONE pill.
  ok('Save as my default: "Reset to my default" turns on, and the menu says nothing of its own', await js(`return !document.querySelector('[data-mk] [data-lay-reset] option[value="mine"]').disabled && !/Saved as my default/.test(document.querySelector('[data-mk] [data-lay-reset] option[value=""]').textContent);`));
  ok('...and the one sync pill says Synced (B7)', await until(`(function(){var p=[].slice.call(document.querySelectorAll('.a1-sync')).find(function(e){return e.offsetParent;}); return !!p && p.getAttribute('data-sync')==='ok' && /Synced/.test(p.textContent);})()`, 5000), await js(`var p=document.querySelector('[data-mk] [data-lay-sync]'); return p ? p.outerHTML.slice(0,200) : 'no pill';`));
  ok('...and is kept beside the layouts in dashboards/tradehub_layout (market.mine.desktop)', await until(`(function(){ var d=(window.__fakeFs.docs['dashboards/tradehub_layout']||{}).market; return d && d.mine && d.mine.desktop && d.mine.desktop.hidden.indexOf('volume')>=0 && d.mine.desktop.span.breadth.w===${Number(mineSpan.split('x')[0])}; })()`, 5000), await js(`return JSON.stringify((window.__fakeFs.docs['dashboards/tradehub_layout']||{}).market||null).slice(0,600);`) + ' want ' + mineSpan + ' ' + mineOrder);
  await menu('orig'); await sleep(500);
  ok('Reset to original: every card back at its first spot and size', JSON.stringify(await rects()) === JSON.stringify(orig));
  await menu('mine'); await sleep(500);
  ok('Reset to my default: the saved layout again', (await order()) === mineOrder && (await span('breadth')) === mineSpan && !(await js(`return !!document.querySelector('[data-mk] .lay-card[data-card="volume"]');`)));
  await sleep(1800);
  await boot({ quant: true, keep: true }); await open();
  ok('after a reload my default can still be restored', await js(`return !document.querySelector('[data-mk] [data-lay-reset] option[value="mine"]').disabled;`));

  console.log('\nA "?" on every card of every card tab');
  const allHelp = (root) => js(`var r=document.querySelector(${JSON.stringify(root)}); if(!r) return 'no ' + ${JSON.stringify(root)}; var cs=[...r.querySelectorAll('.lay-card')]; if(!cs.length) return 'no cards'; var bad=cs.filter(function(e){ var q=e.querySelector('[data-lay-help]'); return !q || (q.getAttribute('title')||q._a1cTitle||'').length < 12; }).map(function(e){return e.dataset.card;}); return bad.length ? 'missing: '+bad.join() : 'ok '+cs.length;`);
  const views = [
    ['Charts', async () => { await tab('charts'); }, '[data-charts]', 3],
    ['Scanner board', async () => { await tab('scanner'); await js(`var b=document.querySelector('[data-sc-view="board"]'); if(b) b.click(); 1`); }, '.sc-board', 3],
    ['Scanner ▸ Invest', async () => { await js(`document.querySelector('[data-sc-horizon="invest"]').click(); 1`); }, '[data-sc-horizon] ~ * .lay-grid, .sc-iv', 3],
    ['Scanner ▸ Backtest', async () => { await js(`var i=document.querySelector('[data-sc-horizon="swing"]'); if(i) i.click(); var b=document.querySelector('[data-sc-view="backtest"]'); if(b) b.click(); 1`); }, '[data-backtest]', 13],
    ['Neo', async () => { await tab('neo'); }, '[data-lay="neo"]', 4],
    ['Control ▸ Memory', async () => { await tab('prompt'); }, '[data-memory]', 4],
    ['Paper', async () => { await tab('paper'); }, '[data-lay="paper"]', 7],
    ['Portfolio ▸ Risk', async () => { await tab('portfolio'); await until(`[...document.querySelectorAll('.tbtabs [role=tab]')].some(function(b){return /^Risk/.test(b.textContent);})`, 8000); await js(`[...document.querySelectorAll('.tbtabs [role=tab]')].find(function(b){return /^Risk/.test(b.textContent);}).click(); 1`); }, '[data-risk-view]', 8],
    ['Journal ▸ Edge', async () => { await tab('journal'); await until(`[...document.querySelectorAll('[data-journal-view] button')].some(function(b){return b.textContent==='Edge';})`, 8000); await js(`[...document.querySelectorAll('[data-journal-view] button')].find(function(b){return b.textContent==='Edge';}).click(); 1`); }, '[data-edge-view]', 6],
  ];
  for (const [name, go, root, n] of views) {
    await go();
    await until(`(function(){ var r=document.querySelector(${JSON.stringify(root)}); return r && r.querySelectorAll('.lay-card').length >= ${n}; })()`, 15000);
    const r = await allHelp(root);
    ok(`${name}: every card has a "?" (${r})`, /^ok /.test(r) && Number(r.split(' ')[1]) >= n, r);
  }

  console.log('\nSide effects');
  ok('no page errors', errs.length === 0, errs.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
