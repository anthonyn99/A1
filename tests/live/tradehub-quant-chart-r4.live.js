// TradeHub Quant refinements, R4 (A1-Priv docs/TradeHub/quant/r1-04.md):
// Charts' drawing tools done right. In the real page, with real mouse and touch
// input, at 1280, 820 and 390 px.
//
//   1. Ray: drawn finite (saved extend:false), its end handle under the mouse,
//      a drag on it changes length and angle, Extend makes it infinite and back
//   2. Fibonacci: handles on its two anchors (= its line ends), a handle drag
//      follows the mouse exactly, still on the anchors after a zoom and a pan
//   3. Rectangle: four corner handles; a third-corner drag moves its two sides
//   4. Text: added through the in-UI prompt, its handle clear of the letters,
//      its corner grows the font, a double-click and the Edit button edit it
//   5. Every tool: handles on the anchors at every width; Delete / Edit /
//      Extend dimmed when they do not apply; saved and back after a reload
//   6. Touch (390 px): a finger 11 px off a line selects it, a finger drags a
//      handle
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-chart-r4.live.js   (TH_PAGE_FILE=…, SHOTS_DIR=…)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const DESK_W = 1280 + 224;
const TAB = `document.querySelector('[data-charts]').__charts`;
const CH = `${TAB}.active()`;
const DR = `${CH}.draw()`;
// 2 px: CDP rounds a fractional mouse position to a whole pixel (each end can be up to a pixel off).
const near = (a, b, e = 2) => Math.abs(a - b) <= e;
// The page's in-UI prompt, answered by the test: a new text says Breakout, an edit says Edited (the options are kept).
const PROMPT = `window.__prompts=[]; window.uiPrompt=function(m,o){ window.__prompts.push(o||{}); return Promise.resolve(o&&o.default!=null&&o.default!==''?'Edited':'Breakout'); }; 1`;

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
  const { js, until, size, boot, tab, shot } = driver(c);
  const stage = async () => JSON.parse(await js(`var b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return JSON.stringify({l:b.left,t:b.top,w:${CH}.geo.width(),h:${CH}.geo.height()});`));
  const ready = async () => until(`document.querySelector('[data-charts]') && ${TAB} && ${CH} && ${CH}.info().bars > 0 && document.querySelector('[data-ch-main] [data-ch-note]').hidden`, 20000);
  const list = async () => JSON.parse(await js(`return JSON.stringify(${DR}.get());`));
  const handles = async (id) => JSON.parse(await js(`return JSON.stringify(${DR}.handles(${JSON.stringify(id)}));`));
  const pick = (t) => js(`var b=document.querySelector('[data-ch-tool="${t}"]'); if (!b.offsetParent) document.querySelector('[data-ch-drawbtn]').click(); b.click(); 1`);
  const mouse = async (type, x, y, extra = {}) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  async function drag(a, b, steps = 8) {
    await mouse('mouseMoved', a.x, a.y, { button: 'none' });
    await mouse('mousePressed', a.x, a.y, { buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, { buttons: 1 }); await sleep(14); }
    await mouse('mouseReleased', b.x, b.y, { clickCount: 1 });
    await sleep(150);
  }
  async function click(p, n = 1) { await mouse('mousePressed', p.x, p.y, { buttons: 1, clickCount: n }); await mouse('mouseReleased', p.x, p.y, { clickCount: n }); await sleep(60); }
  async function finger(a, b, steps = 8) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
    if (b) for (let i = 1; i <= steps; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }] }); await sleep(16); }
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(150);
  }
  // A point of the stage, in page px, from fractions of the plot.
  const P = (s, fx, fy) => ({ x: s.l + s.w * fx, y: s.t + s.h * fy });
  const onPage = (s, h) => ({ x: s.l + h.x, y: s.t + h.y });
  const savedKinds = () => (api.posted.drawings || []).slice(-1).map((d) => d.drawings.map((x) => x.kind + (x.extend != null ? ':' + x.extend : '') + (x.size ? ':' + x.size : '')).join()).join();

  await size(DESK_W, 900);
  await boot({ quant: true });
  await tab('charts');
  ok('the Charts tab is up', await ready());
  await js(PROMPT);
  await js(`document.querySelector('[data-ch-drawbtn]').click(); 1`);
  ok('Extend and Edit are in the Draw row, dimmed with nothing selected', await js(`var e=document.querySelector('[data-ch-extend]'), d=document.querySelector('[data-ch-edit]'); return !!(e && d && e.disabled && d.disabled && e.offsetParent && d.offsetParent);`));

  console.log('\n1. Ray');
  let s = await stage();
  await pick('ray');
  const ra = P(s, 0.25, 0.3), rb = P(s, 0.45, 0.45);
  await drag(ra, rb);
  let L = await list();
  const ray = L.find((d) => d.kind === 'ray');
  ok('a ray drawn by a drag is finite (saved extend:false)', ray && ray.extend === false, JSON.stringify(L).slice(0, 200));
  let H = await handles(ray.id);
  ok('its handles sit on the press and the let-go points', H.length === 2 && near(s.l + H[0].x, ra.x) && near(s.t + H[0].y, ra.y) && near(s.l + H[1].x, rb.x) && near(s.t + H[1].y, rb.y), JSON.stringify(H));
  ok('...and Extend lights up for it (off), Edit stays dimmed', await js(`var e=document.querySelector('[data-ch-extend]'); return !e.disabled && e.getAttribute('aria-pressed')==='false' && document.querySelector('[data-ch-edit]').disabled;`));
  const rc = P(s, 0.55, 0.25);
  await drag(onPage(s, H[1]), rc);
  H = await handles(ray.id);
  ok('dragging its end handle moves the end under the mouse (length and angle), the start stays', near(s.l + H[1].x, rc.x) && near(s.t + H[1].y, rc.y) && near(s.l + H[0].x, ra.x) && near(s.t + H[0].y, ra.y), JSON.stringify(H));
  await js(`document.querySelector('[data-ch-extend]').click(); 1`);
  ok('Extend makes it infinite, the button shows it', (await list()).find((d) => d.id === ray.id).extend === true && await js(`return document.querySelector('[data-ch-extend]').getAttribute('aria-pressed')==='true';`));
  ok('...saved to quant-api with it', await until(`true`, 50) && await (async () => { for (let i = 0; i < 40; i++) { if (/ray:true/.test(savedKinds())) return true; await sleep(100); } return false; })(), savedKinds());
  await shot('r4-ray-extended-1280');
  await js(`document.querySelector('[data-ch-extend]').click(); 1`);
  ok('...and a second click makes it finite again', (await list()).find((d) => d.id === ray.id).extend === false);

  console.log('\n2. Fibonacci');
  await js(`${DR}.clear(); 1`);
  // The price axis can rescale while the page settles (the handles follow their anchors then, by design): draw on a still chart.
  for (let k = 0, a = null; k < 12; k++) { const b = await js(`return ${CH}.geo.p(100);`); if (b === a) break; a = b; await sleep(500); }
  s = await stage();
  await pick('fib');
  const fa = P(s, 0.2, 0.7), fb = P(s, 0.5, 0.25);
  await drag(fa, fb);
  const fib = (await list()).find((d) => d.kind === 'fib');
  H = await handles(fib.id);
  ok('a new Fibonacci, saved with extend off; its handles on the two anchors', fib && fib.extend === false && near(s.l + H[0].x, fa.x) && near(s.t + H[0].y, fa.y) && near(s.l + H[1].x, fb.x) && near(s.t + H[1].y, fb.y), JSON.stringify(H));
  const fc = P(s, 0.6, 0.15);
  await drag(onPage(s, H[1]), fc, 16);
  H = await handles(fib.id);
  ok('a handle drag follows the mouse exactly (and the other stays)', near(s.l + H[1].x, fc.x) && near(s.t + H[1].y, fc.y) && near(s.l + H[0].x, fa.x) && near(s.t + H[0].y, fa.y), JSON.stringify(H));
  await shot('r4-fib-1280');
  // A zoom (wheel) and a pan (a drag on empty chart): the handles are worked out again from time and price.
  for (let i = 0; i < 4; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: s.l + s.w * 0.85, y: s.t + s.h * 0.9, deltaX: 0, deltaY: -120 }); await sleep(30); }
  await sleep(400);
  const z = JSON.parse(await js(`var d=${DR}.get()[0], g=${CH}.geo; return JSON.stringify({h:${DR}.handles(d.id), p:d.pts.map(function(p){return {x:g.x(p.t), y:g.y(p.p)};})});`));
  ok('after a zoom the handles are still on the anchors', z.h.length === 2 && z.h.every((h, i) => z.p[i].x != null && near(h.x, z.p[i].x, 0.5) && near(h.y, z.p[i].y, 0.5)), JSON.stringify(z));

  console.log('\n3. Rectangle');
  await js(`${DR}.clear(); ${CH}.fit && ${CH}.fit(); 1`); await sleep(300); s = await stage();
  await pick('rect');
  const qa = P(s, 0.3, 0.3), qb = P(s, 0.5, 0.5);
  await drag(qa, qb);
  const rect = (await list()).find((d) => d.kind === 'rect');
  H = await handles(rect.id);
  ok('a rectangle has four corner handles, one on each corner', H.length === 4 && [[qa.x, qa.y], [qb.x, qb.y], [qa.x, qb.y], [qb.x, qa.y]].every(([x, y]) => H.some((h) => near(s.l + h.x, x) && near(s.t + h.y, y))), JSON.stringify(H));
  const bl = H.find((h) => h.role === 'c01'), qd = P(s, 0.22, 0.6);
  await drag(onPage(s, bl), qd);
  H = await handles(rect.id);
  const tr = H.find((h) => h.role === 'c10');
  ok('dragging the bottom-left corner moves it under the mouse; the top-right stays', near(s.l + H.find((h) => h.role === 'c01').x, qd.x) && near(s.t + H.find((h) => h.role === 'c01').y, qd.y) && near(s.l + tr.x, qb.x) && near(s.t + tr.y, qa.y), JSON.stringify(H));

  console.log('\n4. Text');
  await js(`${DR}.clear(); 1`);
  await pick('text');
  const ta = P(s, 0.35, 0.35);
  await click(ta);
  ok('a text is added through the in-UI prompt', await until(`${DR}.get().some(function(d){return d.kind==='text' && d.text==='Breakout' && d.size===12;})`, 3000), JSON.stringify(await list()));
  const txt = (await list()).find((d) => d.kind === 'text');
  H = await handles(txt.id);
  const w = await js(`var c=document.createElement('canvas').getContext('2d'); c.font='500 12px Inter, system-ui, sans-serif'; return c.measureText('Breakout').width;`);
  ok('its one handle is past the last letter and below the text, never on the first letter', H.length === 1 && s.l + H[0].x > ta.x + w && s.t + H[0].y > ta.y + 6, JSON.stringify(H) + ' w=' + w);
  const grow = { x: ta.x + (s.l + H[0].x - ta.x) * 2, y: ta.y + (s.t + H[0].y - ta.y) * 2 };
  await drag(onPage(s, H[0]), grow);
  const big = (await list()).find((d) => d.id === txt.id);
  ok('dragging that corner twice as far doubles the font (anchor kept)', big.size >= 22 && big.size <= 26, String(big.size));
  await shot('r4-text-1280');
  await click({ x: ta.x + 10, y: ta.y }, 1); await mouse('mousePressed', ta.x + 10, ta.y, { buttons: 1, clickCount: 2 }); await mouse('mouseReleased', ta.x + 10, ta.y, { clickCount: 2 });
  ok('a double-click edits it, the prompt filled with its words', await until(`${DR}.get().some(function(d){return d.kind==='text' && d.text==='Edited';})`, 3000) && await js(`return window.__prompts.some(function(o){return o.default==='Breakout';});`));
  await js(`${DR}.set(${DR}.get().map(function(d){return Object.assign({}, d, {text:'Breakout'});})); ${DR}.select(${DR}.get()[0].id); 1`);
  ok('...and so does the Edit button (lit while a text is selected; Extend dimmed)', await js(`return !document.querySelector('[data-ch-edit]').disabled && document.querySelector('[data-ch-extend]').disabled;`) && await js(`document.querySelector('[data-ch-edit]').click(); return 1;`) && await until(`${DR}.get()[0].text==='Edited'`, 3000));

  console.log('\n5. Saved, and back after a reload');
  await pick('ray'); await drag(P(s, 0.6, 0.6), P(s, 0.7, 0.7));
  ok('both saved (text with its size, ray finite)', await (async () => { for (let i = 0; i < 40; i++) { const k = savedKinds(); if (/text:2\d/.test(k) && /ray:false/.test(k)) return true; await sleep(100); } return false; })(), savedKinds());
  await boot({ quant: true, keep: true });
  await tab('charts'); await ready(); await js(PROMPT);
  ok('after a reload the text keeps its size and the ray stays finite', await until(`${DR}.get().length === 2`, 8000) && await js(`var l=${DR}.get(); return l.some(function(d){return d.kind==='text'&&d.size>=22;}) && l.some(function(d){return d.kind==='ray'&&d.extend===false;});`), JSON.stringify(await list()).slice(0, 300));
  // A drawing saved before R4 (no extend, no size) looks as it did: the ray infinite, the text 11 px.
  ok('a ray saved before R4 is still infinite', await js(`${DR}.set([{id:'old',kind:'ray',pts:${DR}.get().find(function(d){return d.kind==='ray';}).pts}]); ${DR}.select('old'); return document.querySelector('[data-ch-extend]').getAttribute('aria-pressed')==='true';`));

  console.log('\n6. Three widths, and touch');
  for (const [W, Hh, name] of [[DESK_W, 900, '1280'], [820, 1100, '820'], [390, 844, '390']]) {
    await size(W, Hh); await sleep(900);
    s = await stage();
    await js(`${DR}.clear(); 1`);
    const a = P(s, 0.2, 0.3), b = P(s, 0.6, 0.55);
    const all = {};
    for (const t of ['trend', 'ray', 'rect', 'fib']) {
      await js(`${DR}.use('${t}'); 1`);
      if (name === '390') { await finger(a, b); } else await drag(a, b);
      const d = (await list()).slice(-1)[0];
      const hh = d ? await handles(d.id) : [];
      all[t] = d && d.kind === t && [a, b].every((p) => hh.some((h) => near(s.l + h.x, p.x, 2) && near(s.t + h.y, p.y, 2)));
      await js(`${DR}.clear(); 1`);
    }
    ok(name + ' px: trend, ray, rectangle and Fibonacci each drawn' + (name === '390' ? ' by a finger' : '') + ', handles on the press and let-go points', Object.values(all).every(Boolean), JSON.stringify(all));
    ok(name + ' px: no sideways scroll; the Draw row reachable', (await js(`return document.documentElement.scrollWidth;`)) <= W && await js(`var r=document.querySelector('.ch-draw-row'); return !!r && r.scrollWidth >= r.clientWidth && !!document.querySelector('[data-ch-extend]');`));
    if (name === '390') {
      // A line, then a finger 11 px below it: a finger's hit area is bigger than a mouse's.
      await js(`var g=${CH}.geo; ${DR}.set([{id:'t1',kind:'trend',pts:[{t:g.t(${s.w * 0.2}),p:g.p(${s.h * 0.5})},{t:g.t(${s.w * 0.8}),p:g.p(${s.h * 0.5})}]}]); 1`);
      await finger({ x: s.l + s.w * 0.5, y: s.t + s.h * 0.5 + 11 });
      ok('390 px: a finger 11 px off a line selects it', await js(`return ${DR}.selected()==='t1';`));
      const h1 = (await handles('t1'))[1], to = { x: s.l + s.w * 0.7, y: s.t + s.h * 0.35 };
      await finger({ x: s.l + h1.x - 9, y: s.t + h1.y + 8 }, to);
      const h2 = (await handles('t1'))[1];
      ok('390 px: a finger near its end drags that handle to where the finger lifts', near(s.l + h2.x, to.x, 2) && near(s.t + h2.y, to.y, 2), JSON.stringify(h2));
    }
    await shot('r4-draw-' + name);
  }

  ok('no uncaught error in the page', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
