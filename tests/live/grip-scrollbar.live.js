/**
 * A text box with A1's corner resize grip (resizegrip.js) ends its scrollbar
 * right above the grip's strokes: the thumb never sits on the handle (Tony,
 * 2026-11-03, MAGI's prompt box). scrollbar.js (and Vault's copy in
 * vault-controls.js) read the grip through box.__a1Grip.
 *
 * Every program: each grip box on screen is filled until it scrolls, scrolled
 * to the bottom, and its bar's rail and thumb must end above the strokes.
 *
 *   node tests/live/grip-scrollbar.live.js
 */
const { connect, evalJs, sleep } = require('./cdp');

const BASE = 'https://anthonyn99.github.io/A1/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

// In the page: every visible grip box, filled, scrolled to the end; then the
// rail drawn beside it is compared with where the strokes start.
const AUDIT = `
  document.querySelectorAll('#profile-overlay, .a1-pk, guardian-lock, #lockScreen').forEach(function (e) { e.style.display = 'none'; });
  var out = [];
  // A box inside a closed panel is brought on screen: each hidden ancestor
  // shown, the panel pinned to the top-left. The bar and grip are measured
  // against each other, so where the panel lands doesn't matter.
  Array.prototype.forEach.call(document.querySelectorAll('.a1-grip-box'), function (b) {
    if (b.getClientRects().length && b.getBoundingClientRect().width > 40) return;
    for (var n = b; n && n !== document.body; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (cs.display === 'none') n.style.setProperty('display', n.tagName === 'TEXTAREA' ? 'block' : 'flex', 'important');
      if (cs.visibility === 'hidden') n.style.setProperty('visibility', 'visible', 'important');
      if (cs.opacity === '0') n.style.setProperty('opacity', '1', 'important');
    }
    if (b.getBoundingClientRect().width < 60) b.style.width = '320px';
  });
  var boxes = Array.prototype.filter.call(document.querySelectorAll('.a1-grip-box'), function (b) {
    var r = b.getBoundingClientRect();
    return r.width > 40 && r.height > 20 && r.bottom > 0 && r.top < innerHeight && b.__a1Grip && b.__a1Grip.getClientRects().length;
  }).slice(0, 6);
  // Control: with the grip hidden from scrollbar.js the bar must reach the
  // corner, or this test could never fail.
  if (window.__control && boxes[0]) {
    var g0 = boxes[0].__a1Grip; boxes[0].__a1Grip = null; g0.classList.remove('a1-grip'); g0.style.cssText += ';position:absolute;right:0;bottom:0;width:38px;height:38px';
    window.__restore = function () { boxes[0].__a1Grip = g0; g0.classList.add('a1-grip'); };
    boxes[0].__a1GripCtl = g0;
  }
  for (var i = 0; i < boxes.length; i++) {
    var b = boxes[i];
    var long = Array(60).join('line of text to make this box scroll\\n');
    if ('value' in b && b.tagName === 'TEXTAREA') b.value = long; else b.textContent = long;
    b.style.height = '90px'; b.style.maxHeight = '90px'; b.style.minHeight = '90px';
    await new Promise(function (r) { setTimeout(r, 60); });
    b.scrollTop = b.scrollHeight;
    b.dispatchEvent(new Event('scroll'));
    await new Promise(function (r) { setTimeout(r, 400); });
    var br = b.getBoundingClientRect(), gp = b.__a1Grip, gr = gp.getBoundingClientRect();
    var cs = getComputedStyle(gp, '::before');
    var hatchTop = gr.bottom - parseFloat(cs.bottom) - parseFloat(cs.height);
    var rails = Array.prototype.filter.call(document.querySelectorAll('.vc-rail.v.on'), function (r) {
      var rr = r.getBoundingClientRect();
      return Math.abs(rr.right - br.right) < 20 && rr.top >= br.top - 4 && rr.top < br.bottom;
    });
    var rail = rails[0];
    var label = (b.getAttribute('aria-label') || b.placeholder || b.id || b.className || b.tagName).toString().slice(0, 40);
    if (!rail) { out.push({ label: label, rail: false, scrolls: b.scrollHeight > b.clientHeight }); continue; }
    var rr = rail.getBoundingClientRect(), tr = rail.querySelector('.vc-thumb').getBoundingClientRect();
    out.push({ label: label, rail: true, railBottom: Math.round(rr.bottom), thumbBottom: Math.round(tr.bottom), hatchTop: Math.round(hatchTop) });
  }
  return JSON.stringify(out);
`;

(async () => {
  const c = await connect();
  await c.send('Runtime.enable');
  const PAGES = ['magi.html', 'index.html?profile=tony', 'index.html?profile=veda', 'mylist.html', 'shield.html',
    'Shruti/shruti.html', 'V1/studyos.html', 'V1/wellness.html', 'oneinbox.html', 'tradehub.html', 'insight.html',
    'vault.html', 'everwell.html', 'riftiq.html'];
  let boxes = 0;
  for (const p of PAGES) {
    await c.send('Page.navigate', { url: BASE + p });
    await sleep(5000);
    let list;
    try { list = JSON.parse(await evalJs(c, AUDIT)); } catch (e) { ok(p + ': audit ran', false, String(e).slice(0, 200)); continue; }
    if (!list.length) { console.log('  · ' + p + ': no grip box on screen'); continue; }
    for (const x of list) {
      boxes++;
      if (!x.rail) { ok(p + ' "' + x.label + '": bar drawn', !x.scrolls, x); continue; }
      ok(p + ' "' + x.label + '": bar ends above the grip', x.railBottom <= x.hatchTop && x.thumbBottom <= x.hatchTop, x);
    }
  }
  ok('at least one grip box was checked', boxes > 0, boxes);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
