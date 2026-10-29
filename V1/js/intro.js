/* ============================================================================
 * StudyOS — the cover page
 * ============================================================================
 * Shown on every launch, the way Everwell opens (Tony, 2026-10-29): the
 * mortarboard, "StudyOS", one line under it, and "Tap to continue". The mark
 * in the sidebar brings it back (window.sosShowIntro).
 *
 * Behind it, one canvas: three slow pools of light (Veda's lavender, pastel
 * pink, a deeper mauve) and fine motes rising. Drawn after Everwell's
 * backdrop, much reduced: the light is redrawn 4 times a second, the motes at
 * 30fps (12 without focus), nothing at all while the cover is hidden or the
 * page is, and a still frame under prefers-reduced-motion.
 *
 * A lock sits ABOVE the cover (Guardian's card is on top of everything), so a
 * locked StudyOS asks for its password over this page, never over her data.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  var el = document.getElementById('sos-intro');
  var cv = document.getElementById('sos-intro-canvas');
  if (!el || !cv) return;
  var ctx = cv.getContext('2d');

  var BASE = [19, 18, 22];
  var GLOWS = [[201, 180, 216, .2], [240, 179, 203, .14], [141, 118, 154, .18]];
  var MOTE = [236, 222, 244];
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var coarse = window.matchMedia('(pointer: coarse)').matches;
  var focused = document.hasFocus();
  window.addEventListener('focus', function () { focused = true; });
  window.addEventListener('blur', function () { focused = false; });

  var W = 0, H = 0, dpr = 1, motes = [], running = false, raf = 0, wake = 0, prev = 0;
  var glowCanvas = document.createElement('canvas'), gctx = glowCanvas.getContext('2d', { alpha: false }), glowAt = -1e9;

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a == null ? c[3] : a).toFixed(3) + ')'; }
  function newMote(anywhere) {
    return { x: Math.random() * W, y: anywhere ? Math.random() * H : H + 10, r: .5 + Math.pow(Math.random(), 2.2) * 2,
             v: .006 + Math.random() * .016, ph: Math.random() * 6.28, tw: .0008 + Math.random() * .0016, pink: Math.random() < .3 };
  }
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
    if (W * H * dpr * dpr > 5.2e6) dpr = Math.sqrt(5.2e6 / (W * H));
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glowCanvas.width = Math.max(16, Math.round(W / 2)); glowCanvas.height = Math.max(16, Math.round(H / 2));
    gctx.setTransform(glowCanvas.width / W, 0, 0, glowCanvas.height / H, 0, 0);
    glowAt = -1e9;
    var want = Math.round(Math.min(coarse ? 36 : 70, (W * H) / 16000));
    while (motes.length < want) motes.push(newMote(true));
    if (motes.length > want) motes.length = want;
    draw(performance.now());
  }
  function drawGlows(now) {
    gctx.fillStyle = rgba(BASE, 1); gctx.fillRect(0, 0, W, H);
    var big = Math.min(Math.max(W, H), Math.sqrt(W * H) * 1.15);
    var tall = H > W * 1.2, ax = tall ? .3 : .38, ay = tall ? .38 : .3;
    for (var i = 0; i < GLOWS.length; i++) {
      var g = GLOWS[i], k = i + 1;
      var gx = W * (.5 + ax * Math.sin(now * .00004 * k + i * 2.1));
      var gy = H * ((tall ? .45 : .42) + ay * Math.cos(now * .000033 * k + i * 1.3));
      var r = big * (.55 - i * .08);
      var grd = gctx.createRadialGradient(gx, gy, 0, gx, gy, r);
      grd.addColorStop(0, rgba(g)); grd.addColorStop(1, rgba(g, 0));
      gctx.fillStyle = grd; gctx.fillRect(0, 0, W, H);
    }
  }
  function draw(now) {
    if (!running || now - glowAt >= 250) { glowAt = now; drawGlows(now); }
    ctx.drawImage(glowCanvas, 0, 0, W, H);
    // Three faint strands drifting across the lower half.
    ctx.lineWidth = 1.1;
    for (var j = 0; j < 3; j++) {
      ctx.strokeStyle = rgba(j === 1 ? [240, 179, 203] : [201, 180, 216], .08 * (1 - j * .22));
      ctx.beginPath();
      for (var x = -20; x <= W + 20; x += 18) {
        var y = H * (.62 + j * .07) + Math.sin(x * .0035 + now * .00022 * (j + 1) + j) * H * .05 + Math.sin(x * .011 + now * .0004) * 6;
        if (x === -20) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    var dt = Math.min(64, now - (prev || now)); prev = now;
    for (var m = 0; m < motes.length; m++) {
      var p = motes[m];
      if (running) {
        p.y -= p.v * .9 * dt;
        p.x += Math.sin(now * .0003 + p.ph) * .012 * dt;
        if (p.y < -12) { motes[m] = p = newMote(false); }
      }
      var a = .18 + .5 * (.5 + .5 * Math.sin(now * p.tw + p.ph));
      var c = p.pink ? [246, 200, 220] : MOTE;
      if (p.r > 1.5) { ctx.fillStyle = rgba(c, a * .1); ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 3.2, 0, 6.283); ctx.fill(); }
      ctx.fillStyle = rgba(c, a); ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
    }
  }
  function loop(now) {
    raf = 0;
    if (!running) return;
    draw(now);
    var every = focused ? 33 : 83, spent = performance.now() - now;
    wake = setTimeout(function () { wake = 0; if (running) raf = requestAnimationFrame(loop); }, Math.max(0, every - spent - 8));
  }
  function visible() { return !el.hidden && !el.classList.contains('leave'); }
  function start() {
    if (running || !visible() || document.hidden) return;
    if (reduce.matches) { draw(performance.now()); return; }
    running = true; prev = performance.now(); raf = requestAnimationFrame(loop);
  }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; if (wake) clearTimeout(wake); wake = 0; }

  var leaving = false;
  function hide() {
    if (leaving || el.hidden) return;
    leaving = true;
    el.classList.add('leave');
    setTimeout(function () { el.hidden = true; el.classList.remove('leave'); leaving = false; stop(); }, 420);
  }
  function show() {
    stop();
    // Replay the entrance: the word, the rule and the line rise in again.
    var inner = el.querySelector('.sos-intro-inner'), foot = el.querySelector('.sos-intro-foot');
    [inner, foot].forEach(function (n) { if (!n) return; var c = n.cloneNode(true); n.parentNode.replaceChild(c, n); });
    el.hidden = false;
    resize();
    start();
    try { el.focus({ preventScroll: true }); } catch (e) {}
  }
  window.sosShowIntro = show;
  window.sosHideIntro = hide;

  el.addEventListener('click', hide);
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') { e.preventDefault(); hide(); }
  });
  window.addEventListener('resize', function () { if (!el.hidden) resize(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });

  // A deep link (?class=…) or a file being shared in goes straight to work.
  if (/[?&](class|ingest)=/.test(location.search) || /\/(share|open-file)/.test(location.pathname)) {
    el.hidden = true;
  } else {
    resize();
    start();
    try { el.focus({ preventScroll: true }); } catch (e) {}
  }
})();
