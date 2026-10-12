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

const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0.02);
// Where a scroller is (frac) against where its thumb says it is (thumb), and
// its visible share (ratio) against the thumb's length (size). The rail is the
// shown one in `host` taller than minH (and shorter than maxH, when given).
function TRACK(scroller, host, minH, maxH) {
  return `var r = Array.prototype.find.call(document.querySelectorAll('.vc-rail.v'), function (x) {
      var hh = x.getBoundingClientRect().height;
      return x.parentNode === ${host} && x.style.display !== 'none' && hh > ${minH || 0} && hh < ${maxH || 1e9}; });
    if (!r) return null;
    var t = r.querySelector('.vc-thumb'), rr = r.getBoundingClientRect(), tr = t.getBoundingClientRect();
    var se = ${scroller}, view = se === document.scrollingElement ? innerHeight : se.clientHeight;
    return { frac: +(se.scrollTop / (se.scrollHeight - view)).toFixed(3),
      thumb: +((tr.top - rr.top - 2) / Math.max(1, rr.height - tr.height - 4)).toFixed(3),
      ratio: +Math.max(view / se.scrollHeight, (${'\'ontouchstart\' in window'} || matchMedia('(pointer:coarse)').matches ? 44 : 32) / rr.height).toFixed(3),
      size: +((tr.height + 4) / rr.height).toFixed(3),
      railTop: Math.round(rr.top), boxTop: Math.round(se.getBoundingClientRect().top),
      inside: tr.top >= rr.top - 0.5 && tr.bottom <= rr.bottom + 0.5 };`;
}

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
  // A fling: sampled mid-flight, the thumb is where the page is.
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 700 }] });
    for (let y = 700; y >= 300; y -= 40) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] }); await sleep(8); }
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    for (let k = 0; k < 4; k++) {
      await sleep(60);
      const q = await evalJs(c, TRACK('document.scrollingElement', 'document.body', 800));
      if (q) worst = Math.max(worst, Math.abs(q.thumb - q.frac));
    }
  }
  ok('touch fling: the thumb never strays from the page (≤2%)', worst <= 0.02, { worst });
  // Finger-drag the thumb (the fixture's drawer covers the right edge of a phone).
  await sleep(1500);
  await evalJs(c, "document.getElementById('drawer').style.display = 'none'; window.scrollTo(0, 0); return 1;");
  await sleep(60);
  await evalJs(c, 'window.scrollBy(0, 1); return 1;');
  await sleep(150);
  const ft = await evalJs(c, `var r = Array.prototype.find.call(document.querySelectorAll('.vc-rail.v.on'), function (x) { return x.parentNode === document.body && x.offsetHeight > 800; });
    var t = r && r.querySelector('.vc-thumb').getBoundingClientRect(); return t ? { x: t.left + t.width / 2, y: t.top + t.height / 2 } : null;`);
  if (ft) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ft.x, y: ft.y }] });
    for (let d = 20; d <= 300; d += 20) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: ft.x, y: ft.y + d }] }); await sleep(10); }
    await sleep(60);
    const q = await evalJs(c, TRACK('document.scrollingElement', 'document.body', 800));
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    ok('finger-dragging the thumb scrolls the page, thumb under the finger', q && q.frac > 0.2 && near(q.thumb, q.frac), q);
  } else ok('the phone thumb is on screen', false);
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  for (const [label, metrics] of [['desktop', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }],
    ['phone', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }]]) {
    console.log('Fixture — the thumb tracks the content (' + label + ')');
    await c.send('Emulation.setDeviceMetricsOverride', metrics);
    await go(c, BASE + 'tests/live/fixtures/scrollbar.html', 800);
    const PAGE = TRACK('document.scrollingElement', 'document.body', 700);
    for (const y of [400, 1300, 99999]) {
      await evalJs(c, `window.scrollTo(0, ${y}); return 1;`);
      await sleep(120);
      const s = await evalJs(c, PAGE);
      ok(`scrolled to ${y}: thumb position and length match the page`, s && near(s.thumb, s.frac) && near(s.size, s.ratio, 0.01) && s.inside, s);
    }
    // The page grows while its bar shows: no scroll event, the thumb still follows.
    await evalJs(c, 'window.scrollTo(0, 800); return 1;');
    await sleep(120);
    await evalJs(c, "var d = document.createElement('div'); d.id = 'grow'; d.style.height = '6000px'; document.body.appendChild(d); return 1;");
    await sleep(120);
    let s = await evalJs(c, PAGE);
    ok('the page grew: the thumb shrinks and moves with no scroll', s && near(s.thumb, s.frac) && near(s.size, s.ratio, 0.01), s);
    await evalJs(c, "document.getElementById('grow').remove(); return 1;");
    await sleep(120);
    s = await evalJs(c, PAGE);
    ok('the page shrank: the thumb stays on its track', s && s.inside, s);
    // A box inside the page: its rail moves with it as the page scrolls.
    await evalJs(c, "window.scrollTo(0, 0); document.getElementById('box').scrollTop = 500; return 1;");
    await sleep(120);
    await evalJs(c, 'window.scrollTo(0, 60); return 1;');
    await sleep(120);
    s = await evalJs(c, TRACK("document.getElementById('box')", 'document.body', 0, 300));
    ok("a box's rail follows the box as the page scrolls", s && s.railTop === Math.max(0, s.boxTop) && near(s.thumb, s.frac), s);
  }

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
