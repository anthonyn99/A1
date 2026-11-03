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
  // Plus two boxes built here with the page's own A1Resize, the way every
  // program builds its own (many only appear once a panel opens): a textarea
  // and a scrolling div beside its grip in a positioned frame (MAGI's sent
  // prompt, the box Tony reported).
  if (window.A1Resize) ['textarea', 'div'].forEach(function (tag, k) {
    var frame = document.createElement('div');
    frame.style.cssText = 'position:fixed;left:40px;top:' + (120 + k * 140) + 'px;width:360px;z-index:2147482999;background:#222';
    var b = document.createElement(tag);
    b.setAttribute('aria-label', 'test ' + tag);
    b.style.cssText = 'display:block;box-sizing:border-box;width:100%;overflow-y:auto;white-space:pre-wrap;padding:8px';
    var g = window.A1Resize.grip('test');
    frame.append(b, g);
    document.body.appendChild(frame);
    window.A1Resize.attach(b, g, null);
    boxes.push(b);
  });
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
    'shruti.html', 'V1/studyos.html', 'V1/wellness.html', 'oneinbox.html', 'tradehub.html', 'insight.html',
    'vault.html', 'everwell.html', 'riftiq.html'];
  let boxes = 0;
  for (const p of PAGES) {
    await c.send('Page.navigate', { url: BASE + p });
    await sleep(5000);
    let list;
    try { list = JSON.parse(await evalJs(c, AUDIT)); } catch (e) { ok(p + ': audit ran', false, String(e).slice(0, 200)); continue; }
    if (!list.length) { console.log('  · ' + p + ': no resizegrip.js, so no grips'); continue; }
    for (const x of list) {
      boxes++;
      if (!x.rail) { ok(p + ' "' + x.label + '": bar drawn', !x.scrolls, x); continue; }
      ok(p + ' "' + x.label + '": bar ends above the grip', x.railBottom <= x.hatchTop && x.thumbBottom <= x.hatchTop, x);
    }
  }
  ok('at least one grip box was checked', boxes > 0, boxes);

  // Control: the same box with its grip unknown to scrollbar.js draws its bar
  // to the corner, across the strokes, so the check above can fail.
  await c.send('Page.navigate', { url: BASE + 'magi.html' });
  await sleep(5000);
  const ctl = await evalJs(c, `
    var b = document.querySelector('.a1-grip-box'); if (!b) return 'no box';
    var gp = b.__a1Grip; b.__a1Grip = null;
    var cs = getComputedStyle(gp, '::before'), gr0 = gp.getBoundingClientRect();
    var hatchTop = gr0.bottom - parseFloat(cs.bottom) - parseFloat(cs.height);
    var keep = document.createElement('span'); gp.parentNode.insertBefore(keep, gp); document.body.appendChild(gp);
    gp.style.cssText = 'position:fixed;left:' + gr0.left + 'px;top:' + gr0.top + 'px';
    b.value = Array(60).join('line of text\\n'); b.style.height = b.style.maxHeight = b.style.minHeight = '90px';
    await new Promise(function (r) { setTimeout(r, 60); });
    b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll'));
    await new Promise(function (r) { setTimeout(r, 400); });
    var br = b.getBoundingClientRect();
    var rail = Array.prototype.find.call(document.querySelectorAll('.vc-rail.v.on'), function (r) { return Math.abs(r.getBoundingClientRect().right - br.right) < 20; });
    return rail ? Math.round(rail.getBoundingClientRect().bottom - (br.bottom - 18)) : 'no rail';`);
  ok('control: without the grip link the bar runs past where the strokes start', typeof ctl === 'number' && ctl > 0, ctl);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
