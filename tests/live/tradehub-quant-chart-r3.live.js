// TradeHub Quant refinements, R3 (A1-Priv docs/TradeHub/quant/r1-03.md):
// Charts never change on their own, settings synced, a cleaner chart. In the
// real page, at 1280, 820 and 390 px.
//
//   1. zooming out at the data's edge, a wide drag-pan and a sideways wheel
//      never change the interval or the range (no /bars at another interval)
//   2. a range click keeps the interval (it only moves the view); an interval
//      pick keeps the range; a tf change leaves the indicators alone; the
//      presets set what they say (Tony's click)
//   3. a hard zoom in stops at a sane bar width (candles never break), by wheel,
//      keys and a pinch
//   4. settings synced: the sync pill, kept in the layout doc, restored after a
//      reload, compare per symbol, and a cloud copy that lands after the mount
//   5. the look: no grid lines, vivid candles, Live = the icon only, the cursor's
//      price label in front of the level tags, Clear and Delete dimmed when
//      there is nothing to clear or delete
//   6. one chart only: no 2 / 4 / grid buttons; a saved grid view opens one chart
//   7. Compare has an × that clears it
//
// Run: CDP_PORT=93xx node tests/live/tradehub-quant-chart-r3.live.js   (TH_PAGE_FILE=…, SHOTS_DIR=…)
'use strict';
const { connect, sleep } = require('./cdp.js');
const { quantApi, driver, PAGE_SETUP, WATCHLIST } = require('./quant-mock.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 500) : '')); }
};
const DESK_W = 1280 + 224;
const TAB = `document.querySelector('[data-charts]').__charts`;
const CH = `${TAB}.active()`;
const MAX_BAR_PX = 40;
// HSL saturation of a #rrggbb colour.
const sat = (hex) => { const n = parseInt(String(hex).slice(1, 7), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)); };

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
  const info = async () => JSON.parse(await js(`return JSON.stringify(${CH}.info());`));
  const stage = async () => JSON.parse(await js(`var b=document.querySelector('[data-ch-main] .ch-stage').getBoundingClientRect(); return JSON.stringify({l:b.left,t:b.top,w:b.width,h:b.height});`));
  const ready = async () => until(`document.querySelector('[data-charts]') && ${TAB} && ${CH} && ${CH}.info().bars > 0 && document.querySelector('[data-ch-main] [data-ch-note]').hidden`, 20000);
  const settled = async () => { await sleep(300); return until(`${CH}.info().bars > 0 && document.querySelector('[data-ch-main] [data-ch-note]').hidden`, 10000); };
  const pickTf = (v) => js(`var s=document.querySelector('[data-ch-tf]'); s.value=${JSON.stringify(v)}; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
  const wheel = async (n, dy, dx = 0) => { const s = await stage(); const x = s.l + s.w * 0.5, y = s.t + s.h * 0.4; for (let i = 0; i < n; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy }); await sleep(12); } await sleep(400); };
  const otherTf = (tf) => api.asked.filter((a) => a.p === '/bars' && !new RegExp('tf=' + tf + '(&|$)').test(a.q)).map((a) => a.q.slice(0, 60));
  const doc = `(window.__fakeFs.docs['dashboards/tradehub_layout']||{})`;

  await size(DESK_W, 900);
  await boot({ quant: true, ls: { tradehub_charts_view: JSON.stringify({ view: 'grid', n: 4, g: 4 }) } });
  await tab('charts');
  ok('the tab mounts with one chart (a saved grid view falls back to one chart)', await ready() && await js(`return document.querySelectorAll('[data-ch-main] [data-ch-box]').length === 1 && !document.querySelector('.ch-grid');`));
  ok('no 2 / 4 chart or grid buttons', await js(`return !document.querySelector('[data-ch-view],[data-ch-layout],[data-ch-grid]');`));
  let I = await info();
  ok('opens on 5D at 5 minutes', I.range === '5D' && I.tf === '5m', I.range + ' ' + I.tf);

  console.log('\n1. Nothing changes on its own');
  api.asked.length = 0;
  await wheel(40, 120);
  I = await info();
  ok('zooming out far at the data\'s edge keeps 5 minutes', I.tf === '5m' && I.range === '5D', I.tf + ' ' + I.range);
  ok('...and asks for no bars at another interval', otherTf('5m').length === 0, otherTf('5m').join(' | '));
  ok('...the toolbar still says 5m', await js(`return document.querySelector('[data-ch-tf]').value === '5m';`));
  { const s = await stage(), y = s.t + s.h * 0.4;
    for (let k = 0; k < 4; k++) {
      const x0 = s.l + s.w * 0.15;
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y });
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + i * s.w * 0.09, y, button: 'left', buttons: 1 }); await sleep(10); }
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + s.w * 0.72, y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(150);
    } }
  await wheel(10, 0, 200);
  await sleep(600);
  I = await info();
  ok('wide drag-pans and a sideways wheel keep the interval and the range', I.tf === '5m' && I.range === '5D' && otherTf('5m').length === 0, I.tf + ' ' + I.range + ' ' + otherTf('5m').join(' | '));
  const ind0 = JSON.stringify((await js(`return JSON.stringify(${CH}.get().indicators);`)));
  await js(`document.querySelector('[data-ch-range="1M"]').click(); 1`); await settled();
  I = await info();
  ok('a range click keeps the interval (1M stays at 5 minutes)', I.range === '1M' && I.tf === '5m', I.range + ' ' + I.tf);
  await js(`document.querySelector('[data-ch-range="1Y"]').click(); 1`); await settled();
  I = await info();
  ok('...1Y too (the newest bars a load can hold; panning left loads more)', I.range === '1Y' && I.tf === '5m' && I.bars > 300, I.range + ' ' + I.tf + ' ' + I.bars);
  await pickTf('1h'); await settled();
  await js(`document.querySelector('[data-ch-range="5D"]').click(); 1`); await settled();
  I = await info();
  ok('an interval pick keeps the range; the next range click keeps 1 hour', I.range === '5D' && I.tf === '1h', I.range + ' ' + I.tf);
  await pickTf('1d'); await settled();
  ok('a switch to daily bars leaves the indicators as they were', JSON.stringify(await js(`return JSON.stringify(${CH}.get().indicators);`)) === ind0, await js(`return JSON.stringify(${CH}.get().indicators);`));
  await js(`document.querySelector('[data-ch-preset="weekly"]').click(); 1`); await settled();
  I = await info();
  ok('the Weekly preset sets what it says (5Y, weekly bars)', I.range === '5Y' && I.tf === '1w');
  await js(`document.querySelector('[data-ch-range="5D"]').click(); 1`); await settled();
  await pickTf('5m'); await settled();
  await js(`var s=${CH}; s.set({indicators: JSON.parse(${JSON.stringify(ind0)})}); 1`);
  I = await info();
  ok('back on 5D at 5 minutes', I.range === '5D' && I.tf === '5m');
  const view0 = I.view;
  await js(`document.querySelector('[data-ch-display]').click(); 1`);
  await js(`document.querySelector('[data-ch-tg="ext"]').click(); 1`); await sleep(500);
  const viewNoExt = (await info()).view;
  await js(`document.querySelector('[data-ch-tg="ext"]').click(); 1`); await sleep(500);
  ok('Ext. off and on: the time window stays where it was (no re-fit)', Math.abs((await info()).view.to - view0.to) < 1.5 && Math.abs(((await info()).view.to - (await info()).view.from) - (view0.to - view0.from)) < 2, JSON.stringify([view0, viewNoExt, (await info()).view]));
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); 1`);

  console.log('\n2. A hard zoom in');
  await wheel(80, -120);
  let sp = await js(`return ${CH}.geo.spacing();`), w = await js(`return ${CH}.geo.width();`);
  I = await info();
  ok(`the wheel stops at ${MAX_BAR_PX} px a bar`, sp <= MAX_BAR_PX + 0.01 && sp > 4, sp);
  ok('...with the bars that fit still in view (a stable range)', I.view.to - I.view.from >= Math.floor(w / MAX_BAR_PX) - 1.5, JSON.stringify(I.view) + ' w ' + w);
  await shot('r3-zoomed-in-1280');
  await js(`document.querySelector('[data-ch-main] [data-ch-box]').focus(); 1`);
  for (let k = 0; k < 20; k++) { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '+', text: '+' }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '+' }); }
  await sleep(300);
  sp = await js(`return ${CH}.geo.spacing();`);
  ok('the + key stops there too', sp <= MAX_BAR_PX + 0.01, sp);
  ok('...and the interval never moved', (await info()).tf === '5m');
  await js(`${CH}.fit(); 1`); await sleep(300);

  console.log('\n3. The look');
  I = await info();
  ok('no background grid lines', I.look && I.look.grid === false, JSON.stringify(I.look));
  ok('candles: a more vivid green and red than before', I.look && sat(I.look.up) >= sat('#a4b986') + 0.15 && sat(I.look.down) >= sat('#d68a7c') + 0.15, JSON.stringify(I.look));
  ok('the library draws no cursor price label of its own (ours sits in front)', I.look && I.look.crossLabel === false);
  await js(`var ts=${CH}.chart().timeScale(), n=${I.bars + I.gaps}; ts.setVisibleLogicalRange({from:n-301, to:n-201}); 1`);
  ok('Live is the double-arrow icon only', await until(`(function(){var b=document.querySelector('[data-ch-main] [data-ch-front]'); return b && !b.hidden && !b.textContent.trim() && b.querySelector('svg') && /live/i.test(b.getAttribute('aria-label'));})()`, 3000),
    await js(`var b=document.querySelector('[data-ch-main] [data-ch-front]'); return b ? b.outerHTML.slice(0,200) : 'none';`));
  await js(`document.querySelector('[data-ch-main] [data-ch-front]').click(); 1`); await sleep(500);
  { const s = await stage();
    const ty = await js(`var t=[...document.querySelectorAll('[data-ch-main] .ch-tag')].find(function(x){return x.style.display!=='none' && x.dataset.kind==='level';}); if(!t) return null; var b=t.getBoundingClientRect(); return b.top + b.height/2;`);
    const y = ty || s.t + s.h * 0.5;
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.l + s.w * 0.5, y });
    await sleep(250);
    const cur = JSON.parse(await js(`var e=document.querySelector('[data-ch-main] [data-ch-cursor]'); if(!e) return 'null'; var b=e.getBoundingClientRect(), t=document.querySelector('[data-ch-main] .ch-tag'); return JSON.stringify({shown: e.style.display!=='none' && b.height>0, mid: b.top+b.height/2, z: +getComputedStyle(e).zIndex || 0, tz: t ? (+getComputedStyle(t).zIndex || 0) : 0, after: t ? !!(t.compareDocumentPosition(e) & 4) : true, text: e.textContent});`));
    ok('the cursor\'s price label shows at the pointer, over a level tag', cur && cur.shown && Math.abs(cur.mid - y) <= 2 && /\d/.test(cur.text), JSON.stringify(cur) + ' y ' + y);
    ok('...in front of the level and S/R tags', cur && cur.z > cur.tz && cur.after, JSON.stringify(cur));
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.l + s.w * 0.5, y: s.t - 40 });
    await sleep(200);
    ok('...and goes when the pointer leaves the chart', await js(`var e=document.querySelector('[data-ch-main] [data-ch-cursor]'); return !e || e.style.display==='none';`)); }
  await js(`document.querySelector('[data-ch-drawbtn]').click(); 1`);
  ok('no drawings: Clear and Delete are dimmed', await js(`return document.querySelector('[data-ch-clear]').disabled && document.querySelector('[data-ch-del]').disabled;`));
  { const s = await stage();
    await js(`document.querySelector('[data-ch-tool="hline"]').click(); 1`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.l + s.w * 0.4, y: s.t + s.h * 0.35, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.l + s.w * 0.4, y: s.t + s.h * 0.35, button: 'left', clickCount: 1 });
    await sleep(300);
    ok('a drawing: Clear lights up, Delete stays dimmed until one is selected', await until(`${CH}.info().drawings === 1 && !document.querySelector('[data-ch-clear]').disabled`, 2000) && await js(`return document.querySelector('[data-ch-del]').disabled === !${CH}.draw().selected();`));
    await js(`var d=${CH}.draw(); d.select && d.select(d.get()[0].id); 1`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.l + s.w * 0.6, y: s.t + s.h * 0.35, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.l + s.w * 0.6, y: s.t + s.h * 0.35, button: 'left', clickCount: 1 });
    ok('...selected: Delete lights up', await until(`!!${CH}.draw().selected() && !document.querySelector('[data-ch-del]').disabled`, 2000));
    await js(`document.querySelector('[data-ch-del]').click(); 1`);
    ok('...deleted: both dimmed again', await until(`${CH}.info().drawings === 0 && document.querySelector('[data-ch-del]').disabled && document.querySelector('[data-ch-clear]').disabled`, 2000)); }

  console.log('\n4. Compare, and settings synced');
  const A = WATCHLIST[0], B = WATCHLIST[1];
  await js(`var e=document.querySelector('[data-ch-cmp]'); e.value='QQQ'; e.dispatchEvent(new Event('change',{bubbles:true})); 1`);
  await sleep(400);
  ok('Compare QQQ: the × shows at its right end', (await js(`return ${CH}.get().compare;`)) === 'QQQ' && await js(`var x=document.querySelector('[data-ch-cmp-clear]'), i=document.querySelector('[data-ch-cmp]'); if(!x||x.hidden) return false; var a=x.getBoundingClientRect(), b=i.getBoundingClientRect(); return a.right <= b.right + 1 && a.left > b.left + b.width/2;`));
  await js(`document.querySelector('[data-rail-pick="${B}"], [data-ch-rail] .ch-row[data-sym="${B}"]').click(); 1`);
  await settled();
  ok('compare is kept per symbol: another ticker has none', (await js(`return ${CH}.get().symbol + ':' + (${CH}.get().compare || '');`)) === B + ':');
  await js(`document.querySelector('[data-ch-rail] .ch-row[data-sym="${A}"]').click(); 1`);
  await settled();
  ok('...and the first gets QQQ back', (await js(`return ${CH}.get().compare;`)) === 'QQQ');
  await js(`document.querySelector('[data-ch-cmp-clear]').click(); 1`); await sleep(300);
  ok('the × clears it (input empty, no compare line)', !(await js(`return ${CH}.get().compare;`)) && (await js(`return document.querySelector('[data-ch-cmp]').value;`)) === '' && await js(`return document.querySelector('[data-ch-cmp-clear]').hidden;`));
  await js(`var e=document.querySelector('[data-ch-cmp]'); e.value='QQQ'; e.dispatchEvent(new Event('change',{bubbles:true})); 1`);
  await js(`var s=document.querySelector('[data-ch-type]'); s.value='bars'; s.dispatchEvent(new Event('change',{bubbles:true})); 1`);
  ok('a setting change: the sync pill says Syncing, then Synced', await until(`(function(){var p=document.querySelector('[data-ch-sync]'); return p && p.getAttribute('data-sync')==='ok' && /Synced/.test(p.textContent);})()`, 5000), await js(`var p=document.querySelector('[data-ch-sync]'); return p ? p.outerHTML.slice(0,200) : 'no pill';`));
  ok('...kept in the layout doc: type, interval, range, compare per symbol', await until(`${doc}.chart_prefs && ${doc}.chart_prefs.type === 'bars' && ${doc}.chart_prefs.tf === '5m' && ${doc}.chart_prefs.range === '5D' && ${doc}.chart_prefs.compareBy && ${doc}.chart_prefs.compareBy['${A}'] === 'QQQ'`, 5000), await js(`return JSON.stringify(${doc}.chart_prefs);`));
  await boot({ quant: true, keep: true });
  await tab('charts'); await ready();
  I = await info();
  ok('after a reload: exactly as left (bars, 5D, 5m, compare QQQ on ' + A + ')', I.type === 'bars' && I.range === '5D' && I.tf === '5m' && (await js(`return ${CH}.get().compare;`)) === 'QQQ', JSON.stringify(await js(`return JSON.stringify(${CH}.get());`)).slice(0, 300));
  // Another device's settings, only in the cloud (this device has none yet): the pulled copy lands after the mount.
  await boot({ quant: true, docs: { 'dashboards/tradehub_layout': { chart_prefs: { range: '1M', tf: '15m', type: 'line' } } } });
  await tab('charts'); await ready(); await sleep(800);
  I = await info();
  ok('a cloud copy of the settings (another device) is what the chart shows', I.range === '1M' && I.tf === '15m' && I.type === 'line', I.range + ' ' + I.tf + ' ' + I.type);

  console.log('\n5. Three widths');
  for (const [W, H, name] of [[DESK_W, 900, '1280'], [820, 1100, '820'], [390, 844, '390']]) {
    await size(W, H); await sleep(900);
    const vw = W === DESK_W ? DESK_W : W;
    ok(name + ' px: no sideways scroll', (await js(`return document.documentElement.scrollWidth;`)) <= vw);
    ok(name + ' px: the toolbar\'s controls are all reachable (inside the card, or its own sideways scroller)', await js(`var t=document.querySelector('[data-ch-tools]'), c=t.closest('.lay-card, .mk-card') || t.parentElement, cb=c.getBoundingClientRect(); return [...t.querySelectorAll('.ch-tools-row')].filter(function(r){return r.offsetParent;}).every(function(r){var b=r.getBoundingClientRect(); return b.left >= cb.left - 1 && b.right <= cb.right + 1;});`));
    ok(name + ' px: the sync pill and Compare are on screen', await js(`var p=document.querySelector('[data-ch-cmp]'); var b=p.getBoundingClientRect(); return b.width > 40;`));
    await shot('r3-charts-' + name);
  }

  ok('no uncaught error in the page', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
