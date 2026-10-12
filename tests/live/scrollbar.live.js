/**
 * The one A1 scrollbar (scrollbar.js), in a real browser.
 *
 * Fixture: no native bar takes width anywhere (so nothing shifts), the overlay
 * rail appears on scroll, a fixed drawer holds its own rail, data-native-scroll
 * opts out, Veda's side switches the whole thing off live, and a touch phone
 * gets the finger-sized rail.
 *
 * Every program: with the page made taller than the window, no native bar
 * takes width, and none of the programs' older bars is drawn beside ours.
 *
 *   node tests/live/scrollbar.live.js
 */
const { connect, evalJs, sleep } = require('./cdp');

const BASE = 'https://anthonyn99.github.io/A1/';
const PAGES = ['index.html', 'magi.html', 'mylist.html', 'oneinbox.html', 'shield.html',
  'insight.html', 'tradehub.html', 'riftiq.html', 'everwell.html', 'vault.html'];

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra ? '  ' + JSON.stringify(extra) : '')); }
}

// Width every visible native bar takes: the document's, plus any scroller's.
const GUTTERS = `
  var out = { doc: innerWidth - document.documentElement.clientWidth, boxes: [] };
  document.querySelectorAll('*').forEach(function (e) {
    var cs = getComputedStyle(e);
    if (!/auto|scroll/.test(cs.overflowY) || e.scrollHeight - e.clientHeight < 2) return;
    var w = e.offsetWidth - e.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    if (w > 0.5 && e.offsetParent !== null) out.boxes.push((e.id || e.className || e.tagName) + ':' + w);
  });
  return out;`;
const OLD_BARS = `return ['.sbar.on', '.vsb', '#scroller.on', '.docx-scrollbar.on', '#pv-sbar']
  .filter(function (s) { var e = document.querySelector(s); return e && e.offsetParent !== null && getComputedStyle(e).display !== 'none' && getComputedStyle(e).opacity !== '0'; });`;

async function go(c, url, wait) {
  await c.send('Page.navigate', { url });
  await sleep(wait || 1500);
}

(async () => {
  const c = await connect();
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log('Fixture — desktop');
  await go(c, BASE + 'tests/live/fixtures/scrollbar.html', 800);
  let g = await evalJs(c, GUTTERS);
  ok('the document takes no bar width', g.doc === 0, g);
  ok('no scroller takes bar width (except the opted-out one)', g.boxes.length === 1 && /^own:/.test(g.boxes[0]), g.boxes);
  ok('A1Scrollbar is active', await evalJs(c, 'window.A1Scrollbar && window.A1Scrollbar.active()'));
  await evalJs(c, "window.scrollTo(0, 800); document.getElementById('box').scrollTop = 300; document.getElementById('drawer').scrollTop = 200; return 1;");
  await sleep(250);
  const rails = await evalJs(c, `return Array.prototype.map.call(document.querySelectorAll('.vc-rail.on'), function (r) {
    return { host: r.parentNode.id || r.parentNode.tagName, w: r.offsetWidth, h: r.offsetHeight }; });`);
  ok('scrolling shows rails for the page, the box and the drawer', rails.length === 3, rails);
  ok('the fixed drawer holds its own rail', rails.some((r) => r.host === 'drawer'), rails);
  await sleep(1700);
  ok('rails fade out when idle', (await evalJs(c, "document.querySelectorAll('.vc-rail.on').length")) === 0);
  // Drag the page thumb.
  await evalJs(c, "window.scrollTo(0, 0); return 1;");
  await sleep(100);
  await evalJs(c, "window.scrollBy(0, 1); return 1;");
  await sleep(200);
  const th = await evalJs(c, `var r = Array.prototype.find.call(document.querySelectorAll('.vc-rail.v'), function (x) { return x.parentNode === document.body && x.classList.contains('on') && x.offsetHeight > 800; });
    var t = r && r.querySelector('.vc-thumb').getBoundingClientRect(); return t ? { x: t.left + t.width / 2, y: t.top + t.height / 2 } : null;`);
  ok('the page thumb is on screen', !!th, th);
  if (th) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: th.x, y: th.y });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: th.x, y: th.y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: th.x, y: th.y + 300, button: 'left', buttons: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: th.x, y: th.y + 300, button: 'left', clickCount: 1 });
    ok('dragging the thumb scrolls the page', (await evalJs(c, 'window.scrollY')) > 500);
  }
  // Veda's side: off, live.
  await evalJs(c, "document.body.setAttribute('data-profile', 'veda'); return 1;");
  await sleep(100);
  g = await evalJs(c, GUTTERS);
  ok("Veda's side: the shared bar switches off", (await evalJs(c, 'window.A1Scrollbar.active()')) === false);
  ok("Veda's side: her native bars come back", g.doc > 0, g);
  await evalJs(c, "document.body.setAttribute('data-profile', 'tony'); return 1;");
  await sleep(100);
  ok("back to Tony: on again, no bar width", (await evalJs(c, GUTTERS)).doc === 0);

  console.log('Fixture — phone (touch)');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await go(c, BASE + 'tests/live/fixtures/scrollbar.html', 800);
  ok('pointer is coarse', await evalJs(c, "matchMedia('(pointer:coarse)').matches"));
  g = await evalJs(c, GUTTERS);
  ok('no bar width on the phone', g.doc === 0 && g.boxes.length <= 1, g);
  await evalJs(c, "window.scrollTo(0, 600); return 1;");
  await sleep(250);
  const pr = await evalJs(c, `var r = Array.prototype.find.call(document.querySelectorAll('.vc-rail.v.on'), function (x) { return x.parentNode === document.body; });
    return r ? { w: r.offsetWidth, pe: getComputedStyle(r).pointerEvents, thumbPe: getComputedStyle(r.querySelector('.vc-thumb')).pointerEvents } : null;`);
  ok('the phone rail is finger-sized (28px)', pr && pr.w === 28, pr);
  ok('only the thumb takes the finger (the rail never eats a tap)', pr && pr.pe === 'none' && pr.thumbPe === 'auto', pr);
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  for (const [label, metrics] of [['desktop', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }],
    ['phone', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }]]) {
    console.log('Every program — ' + label);
    await c.send('Emulation.setDeviceMetricsOverride', metrics);
    for (const p of PAGES) {
      await go(c, BASE + p, 3000);
      // Taller than the window, whatever state the page booted into.
      await evalJs(c, "var d = document.createElement('div'); d.style.height = '4000px'; d.id = 'sb-test-tall'; document.body.appendChild(d); window.scrollTo(0, 200); return 1;");
      await sleep(300);
      const r = await evalJs(c, GUTTERS);
      const active = await evalJs(c, '!!(window.A1Scrollbar ? window.A1Scrollbar.active() : document.documentElement.classList.contains("vc-on"))');
      const old = await evalJs(c, OLD_BARS);
      ok(`${p}: shared bar on, no native bar width, no second bar`,
        active && r.doc === 0 && r.boxes.length === 0 && old.length === 0, { active, doc: r.doc, boxes: r.boxes.slice(0, 5), old });
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
