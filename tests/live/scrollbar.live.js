/**
 * The one A1 scrollbar (scrollbar.js), in a real browser.
 *
 * Fixture: no native bar takes width anywhere (so nothing shifts), the overlay
 * rail appears on scroll, a fixed drawer holds its own rail, data-native-scroll
 * opts out, Veda's side keeps it (in her mauve, live), and a touch phone
 * gets the finger-sized rail.
 *
 * Every program: with the page made taller than the window, no native bar
 * takes width, and none of the programs' older bars is drawn beside ours.
 *
 * Veda's side of every two-profile program: the same bar, her colours, and
 * no older bar beside it.
 *
 *   node tests/live/scrollbar.live.js
 */
const { connect, evalJs, sleep } = require('./cdp');

const BASE = 'https://anthonyn99.github.io/A1/';
const PAGES = ['index.html', 'magi.html', 'mylist.html', 'oneinbox.html', 'shield.html',
  'insight.html', 'tradehub.html', 'riftiq.html', 'everwell.html', 'vault.html', 'shruti.html'];

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

// The colour a thumb wears (a probe one when no rail is drawn yet: a page
// that scrolls an inner box rather than <body>).
const VEDA_THUMB = `var t = document.querySelector('.vc-rail .vc-thumb'), probe = !t;
  if (probe) { t = document.createElement('div'); t.className = 'vc-thumb'; document.body.appendChild(t); }
  var bg = getComputedStyle(t).backgroundColor; if (probe) t.remove(); return bg;`;
// Veda's side of each two-profile program: how the page switches to her.
const VEDA = [
  ['index.html', "document.body.setAttribute('data-th-profile', 'veda')"],
  ['magi.html', "document.documentElement.setAttribute('data-profile', 'veda')"],
  ['mylist.html', "document.body.setAttribute('data-profile', 'veda')"],
  ['shield.html', "document.body.setAttribute('data-profile', 'veda')"],
  ['shruti.html', "document.body.setAttribute('data-profile', 'veda')"],
  ['V1/studyos.html', ''],
];

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
      ratio: +Math.max(view / se.scrollHeight, (matchMedia('(pointer:coarse)').matches ? 44 : 32) / rr.height).toFixed(3),
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
  // A blurred popup backdrop that is also the scroller (popups.js blurs every
  // backdrop): a backdrop-filter makes it the containing block of a fixed rail
  // inside it, so the compositor carried the rail with the content a frame
  // before the loop put it back, and the bar bounced on every wheel step
  // (TradeHub's Debrief, 2026-11-03). Its rail sits beside it instead.
  await evalJs(c, `var o = document.createElement('div'); o.id = 'scrim';
    o.style.cssText = 'position:fixed;inset:0;z-index:100001;overflow-y:auto;background:rgba(0,0,0,.6);backdrop-filter:blur(7px)';
    o.innerHTML = '<div style="height:4000px;margin:40px auto;width:600px;background:#222"></div>'; document.body.appendChild(o); return 1;`);
  await sleep(100);
  await evalJs(c, `window.__tops = []; (function f() {
    document.querySelectorAll('.vc-rail.v.on').forEach(function (r) { window.__tops.push(Math.round(r.getBoundingClientRect().top)); });
    if (window.__tops.length < 400) requestAnimationFrame(f); })(); return 1;`);
  for (let i = 0; i < 8; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 720, y: 450, deltaX: 0, deltaY: 120 }); await sleep(40); }
  await sleep(200);
  const scrim = await evalJs(c, `var r = Array.prototype.find.call(document.querySelectorAll('.vc-rail.v.on'), function (x) { return x.offsetHeight > 800; });
    var t = r && r.querySelector('.vc-thumb').getBoundingClientRect();
    return { scrolled: document.getElementById('scrim').scrollTop, tops: Array.from(new Set(window.__tops)),
      inside: !!r && document.getElementById('scrim').contains(r),
      onTop: !!t && r.contains(document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)) };`);
  ok('a blurred scrolling backdrop: its rail never moves while it scrolls (no bounce)', scrim.scrolled > 500 && scrim.tops.length === 1 && scrim.tops[0] === 0, scrim);
  ok('…the rail sits beside the backdrop, drawn above it', !scrim.inside && scrim.onTop, scrim);
  await evalJs(c, "document.getElementById('scrim').remove(); return 1;");
  await sleep(1700);
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
  // Veda's side: the same bar, in her mauve, live.
  await evalJs(c, "document.body.setAttribute('data-profile', 'veda'); return 1;");
  await sleep(100);
  g = await evalJs(c, GUTTERS);
  ok("Veda's side: the shared bar stays on, no bar width", (await evalJs(c, 'window.A1Scrollbar.active()')) === true && g.doc === 0, g);
  await evalJs(c, 'window.scrollBy(0, -50); return 1;');
  await sleep(200);
  ok("Veda's side: her mauve thumb", (await evalJs(c, VEDA_THUMB)) === 'rgba(168, 146, 176, 0.42)');
  await evalJs(c, "document.body.setAttribute('data-profile', 'tony'); return 1;");
  await sleep(100);
  ok("back to Tony: his grey thumb", (await evalJs(c, VEDA_THUMB)) === 'rgba(173, 173, 178, 0.45)');
  await evalJs(c, "document.documentElement.setAttribute('data-profile', 'veda'); return 1;");
  await sleep(100);
  ok("Veda on <html> (MAGI's way) counts too", await evalJs(c, "document.documentElement.classList.contains('vc-veda')"));
  await evalJs(c, "document.documentElement.removeAttribute('data-profile'); return 1;");

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

  console.log("Veda's side of every program — desktop");
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const [p, flip] of VEDA) {
    await go(c, BASE + p, 3000);
    if (flip) await evalJs(c, flip + '; return 1;');
    await evalJs(c, "var d = document.createElement('div'); d.style.height = '4000px'; d.id = 'sb-test-tall'; document.body.appendChild(d); window.scrollTo(0, 200); return 1;");
    await sleep(400);
    const r = await evalJs(c, GUTTERS);
    const st = await evalJs(c, "return { active: !!(window.A1Scrollbar && window.A1Scrollbar.active()), veda: document.documentElement.classList.contains('vc-veda') };");
    const old = await evalJs(c, OLD_BARS);
    const thumb = await evalJs(c, VEDA_THUMB);
    ok(`${p} (Veda): shared bar on in her mauve, no native bar width, no second bar`,
      st.active && st.veda && thumb === 'rgba(168, 146, 176, 0.42)' && r.doc === 0 && r.boxes.length === 0 && old.length === 0,
      { st, thumb, doc: r.doc, boxes: r.boxes.slice(0, 5), old });
  }
  // MyList's list strip (the one Tony saw missing): hovering it shows her bar.
  await go(c, BASE + 'mylist.html', 3000);
  // Past the picker and lock (no sign-in here): the app shell is enough.
  await evalJs(c, `document.body.setAttribute('data-profile', 'veda');
    document.getElementById('app').style.display = 'flex';
    document.querySelectorAll('#profile-overlay, guardian-lock, #lockScreen, .pp-overlay').forEach(function (e) { e.style.display = 'none'; });
    var b = document.getElementById('lists-bar');
    if (b && b.scrollWidth <= b.clientWidth) for (var i = 0; i < 12; i++) { var x = document.createElement('button'); x.textContent = 'Test list ' + i; x.style.cssText = 'flex:none;padding:8px 20px'; b.appendChild(x); }
    return 1;`);
  await sleep(200);
  const lb = await evalJs(c, "var e = document.getElementById('lists-bar'); if (!e) return null; var r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, over: e.scrollWidth - e.clientWidth, hit: e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };");
  if (lb) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lb.x - 5, y: lb.y });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lb.x, y: lb.y });
    await sleep(300);
  }
  const strip = await evalJs(c, `var r = Array.prototype.find.call(document.querySelectorAll('.vc-rail.h.on'), function (x) { return x.style.display !== 'none'; });
    return r ? { w: r.offsetWidth, vis: getComputedStyle(r).visibility, bg: getComputedStyle(r.querySelector('.vc-thumb')).backgroundColor } : null;`);
  // visibility: occlude() once hid every strip's bar (it sits under the strip,
  // so its own spot read as "covered") while .on stayed set.
  ok("mylist.html (Veda): hovering the lists strip shows her sideways bar", !!strip && strip.w > 50 && strip.vis !== 'hidden' && /168, 146, 176/.test(strip.bg), { strip, lb });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
