// TradeHub Quant, Phase 3: the new screens follow A1's shared UI rules, at
// 1280, 820 and 390 px (quant-plan §1 rule 8; quant-design.md "All new UI
// follows A1's shared rules").
//
//   1. A1's scrollbar is on, and every scroller inside a card hides its native bar
//   2. no native control: selects are A1's, no date/time input, no native dialog
//   3. every button is bordered
//   4. a drag by the title bar reorders the cards (mouse; touch after a 300 ms hold) and persists across a reload
//   5. the corner grip resizes a card in whole grid units, by mouse and by keyboard, and persists
//   6. the page stays inside the 2000 px cap
//
// Run: node tests/live/tradehub-quant-a1rules.live.js
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
  const errs = [], dialogs = [];
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SETUP });
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); c.send('Page.handleJavaScriptDialog', { accept: true }); }
  });
  const { js, until, size, boot, tab } = driver(c);
  const order = () => js(`return [...document.querySelectorAll('.lay-grid > .lay-card')].map(function(e){return e.dataset.card;}).join();`);
  const centre = (sel) => js(`var b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2,l:b.left,t:b.top,w:b.width,h:b.height});`).then(JSON.parse);
  async function mouseDrag(from, to, steps = 12) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps, button: 'left', buttons: 1 }); await sleep(16); }
    await sleep(120);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    await sleep(500);
  }
  async function touchDrag(from, to, hold, steps = 12) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    await sleep(hold);
    for (let i = 1; i <= steps; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }] }); await sleep(16); }
    await sleep(120);
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
  }
  const open = async () => { await tab('market'); if (!(await until(`document.querySelector('[data-mk-score]') && document.querySelector('[data-mk-analogs]')`, 15000))) throw new Error('Market did not draw'); await sleep(600); };

  for (const [w, h] of [[1280, 900], [820, 1180], [390, 844]]) {
    console.log(`\n${w} px`);
    await size(w, h);
    await boot({ quant: true });
    await open();
    ok('A1\'s scrollbar is running', await js(`return !!(window.A1Scrollbar && window.A1Scrollbar.active());`));
    const sc = JSON.parse(await js(`var bad=[], n=0; document.querySelectorAll('[data-mk] *').forEach(function(e){ var cs=getComputedStyle(e); if(!/auto|scroll/.test(cs.overflowY+cs.overflowX)) return; n++;
        if(e.closest('[data-native-scroll]')) bad.push('native:'+e.className); if(e.offsetWidth-e.clientWidth>2||e.offsetHeight-e.clientHeight>2) bad.push('bar:'+e.className); });
      return JSON.stringify({n:n,bad:bad});`));
    ok(`every scroller in the tab (${sc.n}) hides its native bar and leaves A1's on`, sc.n >= 8 && sc.bad.length === 0, sc.bad.join());
    ok('a card that overflows scrolls inside itself, and gets A1\'s thumb', await js(`var b=document.querySelector('.lay-card[data-card="streaks"] .lay-body'); b.scrollTop=40; await new Promise(function(r){setTimeout(r,250);}); return b.scrollHeight>b.clientHeight && b.scrollTop>0;`));
    const nat = JSON.parse(await js(`var r=document.querySelector('[data-mk]'); return JSON.stringify({ sel:[...r.querySelectorAll('select')].filter(function(s){return s.closest('[data-native]');}).length, selN:r.querySelectorAll('select').length,
        dates:r.querySelectorAll('input[type=date],input[type=time],input[type=datetime-local],input[type=color]').length, ctl:!!window.A1Controls });`));
    ok('no native control: the one select is A1\'s, no date or time input', nat.ctl && nat.selN === 1 && nat.sel === 0 && nat.dates === 0, JSON.stringify(nat));
    const btn = JSON.parse(await js(`var bad=[]; document.querySelectorAll('[data-mk] button, [data-mk] select').forEach(function(b){ if(b.classList.contains('a1-grip')) return; var cs=getComputedStyle(b); if(parseFloat(cs.borderTopWidth)<1||cs.borderTopStyle==='none'||/rgba\\(0, 0, 0, 0\\)|transparent/.test(cs.borderTopColor)) bad.push(b.className||b.textContent); });
      return JSON.stringify({ n: document.querySelectorAll('[data-mk] button').length, bad: bad });`));
    ok(`every button (${btn.n}) is bordered`, btn.n >= 18 && btn.bad.length === 0, btn.bad.join());
    ok('tickers are links, not buttons', await js(`return document.querySelectorAll('[data-mk] a[data-ticker]').length > 20 && !document.querySelector('[data-mk] button[data-ticker]');`));
    const cap = JSON.parse(await js(`var r=document.getElementById('tradeboard-root').getBoundingClientRect(), m=document.querySelector('[data-mk]').getBoundingClientRect(); return JSON.stringify({ w:r.width, in:m.left>=r.left&&m.right<=r.right+0.5, sw:document.documentElement.scrollWidth, iw:innerWidth });`));
    ok('inside the 2000 px cap, with no sideways scroll', cap.w <= 2000 && cap.in && cap.sw <= cap.iw, JSON.stringify(cap));
    const leak = JSON.parse(await js(`var out=[]; document.querySelectorAll('.lay-card .lay-body').forEach(function(b){ var th=b.querySelector('.mk-table th'); if(!th||b.scrollHeight<=b.clientHeight) return;
        b.scrollTop=Math.min(150,b.scrollHeight-b.clientHeight); var r=b.getBoundingClientRect(), t=th.getBoundingClientRect();
        for (var y=r.top+0.5; y<t.bottom-1; y+=2) { var e=document.elementFromPoint(r.left+r.width/2, y); if(e && b.contains(e) && !e.closest('thead')) { out.push(b.parentNode.dataset.card+' at +'+Math.round(y-r.top)+'px: '+(e.textContent||'').trim().slice(0,20)); break; } }
        if (t.top > r.top + 0.5) out.push(b.parentNode.dataset.card+': header '+Math.round(t.top-r.top)+'px below the top'); b.scrollTop=0; }); return JSON.stringify(out);`));
    ok('scrolled, no row shows above a table header: it sits flush at the top', leak.length === 0, leak.join(' | '));
    const grip = JSON.parse(await js(`var out=[]; document.querySelectorAll('.lay-grid > .lay-card:not(.is-collapsed)').forEach(function(c){ var g=c.querySelector('.a1-grip'), b=c.querySelector('.lay-body'); if(!g||!b) return;
        var gr=g.getBoundingClientRect(), br=b.getBoundingClientRect(); var strokes={ l:gr.right-18, t:gr.bottom-18, r:gr.right-7, b:gr.bottom-7 };
        if (strokes.t < br.bottom && strokes.l < br.right) out.push(c.dataset.card); }); return JSON.stringify(out);`));
    ok('the resize grip sits in its own strip, never over a card\'s content', grip.length === 0, grip.join());
    await js(`document.querySelector('.lay-card[data-card="streaks"] .lay-body').scrollTop=0; document.querySelector('.tb-scroll-visible').scrollTop=0; 1`); await sleep(200);

    if (w === 1280) {
      console.log('\nDrag to reorder (mouse)');
      const before = await order();
      const a = await centre('.lay-card[data-card="regime"] .lay-title'), b = await centre('.lay-card[data-card="sectors"] .lay-title');
      await mouseDrag({ x: a.x, y: a.y }, { x: b.x + 60, y: b.y + 6 });
      const after = await order();
      ok('dragging Regime by its title bar past Sectors reorders the cards', after !== before && after.split(',').indexOf('regime') > 0, before + ' -> ' + after);
      ok('...written once to the layout doc', await until(`window.__fakeFs.log.filter(function(w){ return /tradehub_layout/.test(w.path); }).length === 1`, 4000));
      ok('...in the order on screen', (await js(`return window.__fakeFs.docs['dashboards/tradehub_layout'].market.desktop.order.join();`)) === after);
      const body = await centre('.lay-card[data-card="breadth"] .lay-body');
      const b2 = await centre('.lay-card[data-card="sectors"] .lay-title');
      await mouseDrag({ x: body.x, y: body.y }, { x: b2.x + 80, y: b2.y });
      ok('a drag that starts in a card\'s body moves nothing (its text stays selectable)', (await order()) === after);
      await boot({ keep: true }); await open();
      ok('the order survives a reload', (await order()) === after, await order());

      console.log('\nResize by the corner grip');
      const span = () => js(`var e=document.querySelector('.lay-card[data-card="breadth"]'); return e.dataset.w+'x'+e.dataset.h;`);
      const s0 = await span();
      const unit = JSON.parse(await js(`var g=document.querySelector('.lay-grid'); return JSON.stringify({ x:(g.clientWidth-14*11)/12+14, y:58 });`));
      const g0 = await centre('.lay-card[data-card="breadth"] .a1-grip');
      ok('each card carries A1\'s grip', await js(`return document.querySelectorAll('.lay-grid .lay-card .a1-grip').length === 8 && document.querySelector('.lay-card .a1-grip').getAttribute('aria-label').indexOf('Resize ')===0;`));
      await mouseDrag({ x: g0.x, y: g0.y }, { x: g0.x + unit.x * 2 + 6, y: g0.y + unit.y * 2 + 5 });
      const s1 = await span();
      const [w0, h0] = s0.split('x').map(Number), [w1, h1] = s1.split('x').map(Number);
      ok('dragging it two units right and two down grows the card by exactly 2 x 2', w1 === w0 + 2 && h1 === h0 + 2, s0 + ' -> ' + s1);
      const px = await centre('.lay-card[data-card="breadth"]');
      ok('...snapped to the grid: its width is a whole number of columns', Math.abs(px.w - (w1 * unit.x - 14)) < 1.5 && Math.abs(px.h - (h1 * 58 - 14)) < 1.5, JSON.stringify(px));
      await mouseDrag({ x: g0.x, y: g0.y }, { x: g0.x + 2, y: g0.y + 2 });
      await js(`var g=document.querySelector('.lay-card[data-card="breadth"] .a1-grip'); g.focus(); g.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})); g.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true})); 1`);
      await sleep(300);
      ok('the arrow keys resize it a unit at a time', (await span()) === (w1 - 1) + 'x' + (h1 - 1), await span());
      const tiny = await centre('.lay-card[data-card="breadth"] .a1-grip');
      await mouseDrag({ x: tiny.x, y: tiny.y }, { x: tiny.x - 900, y: tiny.y - 700 });
      ok('it never goes under the card\'s minimum', (await span()) === '3x5', await span());
      await sleep(1800);
      await boot({ keep: true }); await open();
      ok('the size survives a reload', (await span()) === '3x5', await span());
      const before2 = JSON.parse(await js(`return JSON.stringify([...document.querySelectorAll('.lay-grid > .lay-card')].map(function(e){ var b=e.getBoundingClientRect(); return [e.dataset.card, Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }));`));
      await js(`window.__ws.auto(120); 1`); await sleep(1500); await js(`window.__ws.auto(0); 1`);
      const after2 = JSON.parse(await js(`return JSON.stringify([...document.querySelectorAll('.lay-grid > .lay-card')].map(function(e){ var b=e.getBoundingClientRect(); return [e.dataset.card, Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }));`));
      ok('live ticks never move or resize a card', JSON.stringify(before2) === JSON.stringify(after2));
    }
    if (w === 390) {
      console.log('\nDrag to reorder (touch)');
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      const before = await order();
      const a = await centre('.lay-card[data-card="regime"] .lay-title'), b = await centre('.lay-card[data-card="breadth"] .lay-title');
      const top0 = await js(`return document.querySelector('.tb-scroll-visible').scrollTop;`);
      await touchDrag({ x: a.x, y: a.y }, { x: a.x, y: a.y + 180 }, 40);
      ok('a quick swipe on a title bar moves no card (the page scrolls)', (await order()) === before);
      await js(`document.querySelector('.tb-scroll-visible').scrollTop=${top0}; 1`); await sleep(200);
      const a2 = await centre('.lay-card[data-card="regime"] .lay-title');
      await touchDrag({ x: a2.x, y: a2.y }, { x: a2.x, y: b.y + (b.y - a.y) * 0.25 + 40 }, 420);
      const after = await order();
      ok('a press held 300 ms picks the card up and drops it below Breadth', after !== before && after.split(',').indexOf('regime') >= 1, before + ' -> ' + after);
      ok('...kept as the phone\'s own layout', await until(`(window.__fakeFs.docs['dashboards/tradehub_layout']||{}).market && window.__fakeFs.docs['dashboards/tradehub_layout'].market.phone && window.__fakeFs.docs['dashboards/tradehub_layout'].market.phone.order.join() === ${JSON.stringify(after)}`, 4000));
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
  }

  console.log('\nDialogs and side effects');
  ok('no native alert, confirm or prompt was opened', dialogs.length === 0, dialogs.join(' | '));
  ok('no page errors', errs.length === 0, errs.join(' | '));

  console.log(`\n${pass} passed, ${fail} failed`);
  c.ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
