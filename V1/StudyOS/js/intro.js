/* ============================================================================
 * StudyOS — the cover page
 * ============================================================================
 * Shown on every launch, the way Everwell opens (Tony, 2026-10-29): the
 * mortarboard, "StudyOS", one line under it, and "Click to continue" ("Tap" on a touch screen). The mark
 * in the sidebar brings it back (window.sosShowIntro).
 *
 * Behind it, one canvas of its own (not Everwell's motes): a slow
 * constellation. Points drift, and two that come near each other are joined by
 * a fine line that fades in as they close and out as they part: ideas finding
 * each other. A few points are brighter "stars" with a soft halo, and one in
 * pink, like the tassel. Under it, the cover's own light: a deep plum ground
 * and three pools of soft mauve light orbiting very slowly (redrawn 4 times a
 * second, at half resolution).
 *
 * Cheap on purpose: at most ~60 points (36 on a phone), 30fps (12 without
 * focus), nothing at all while the cover or the page is hidden, and a still
 * frame under prefers-reduced-motion.
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
  var GLOWS = [[168, 146, 176, .16], [141, 118, 154, .16], [120, 100, 132, .12]];
  var NODE = [214, 200, 226], PINK = [240, 179, 203], LINE = [184, 162, 198];
  var LINK = 150;                       // px: points closer than this are joined
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var coarse = window.matchMedia('(pointer: coarse)').matches;
  // Tap on a touch screen, click everywhere else.
  var cta = el.querySelector('.sos-intro-cta');
  if (cta) cta.textContent = coarse ? 'Tap to continue' : 'Click to continue';
  var focused = document.hasFocus();
  window.addEventListener('focus', function () { focused = true; });
  window.addEventListener('blur', function () { focused = false; });

  var W = 0, H = 0, dpr = 1, pts = [], running = false, raf = 0, wake = 0, prev = 0;
  var glowCanvas = document.createElement('canvas'), gctx = glowCanvas.getContext('2d', { alpha: false }), glowAt = -1e9;

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a == null ? c[3] : a).toFixed(3) + ')'; }
  function drawGlows(now) {
    gctx.fillStyle = rgba(BASE, 1); gctx.fillRect(0, 0, W, H);
    var big = Math.min(Math.max(W, H), Math.sqrt(W * H) * 1.15);
    var tall = H > W * 1.2, ax = tall ? .3 : .38, ay = tall ? .38 : .3;
    for (var i = 0; i < GLOWS.length; i++) {
      var g = GLOWS[i], k = i + 1;
      var gx = W * (.5 + ax * Math.sin(now * .00004 * k + i * 2.1));
      var gy = H * ((tall ? .45 : .42) + ay * Math.cos(now * .000033 * k + i * 1.3));
      var grd = gctx.createRadialGradient(gx, gy, 0, gx, gy, big * (.55 - i * .08));
      grd.addColorStop(0, rgba(g)); grd.addColorStop(1, rgba(g, 0));
      gctx.fillStyle = grd; gctx.fillRect(0, 0, W, H);
    }
  }
  function newPoint(i) {
    var ang = Math.random() * 6.283, sp = .006 + Math.random() * .012;   // px per ms
    return { x: Math.random() * W, y: Math.random() * H, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
             r: .9 + Math.random() * 1.3, star: i % 9 === 0, pink: i === 4, ph: Math.random() * 6.283 };
  }
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    // Fine points and hairlines: 1.5x is sharp enough, and the buffer is a
    // quarter of a 2x one (a 4K screen is capped at ~3.5M pixels).
    dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.25 : 1.5);
    if (W * H * dpr * dpr > 3.5e6) dpr = Math.sqrt(3.5e6 / (W * H));
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glowCanvas.width = Math.max(16, Math.round(W / 2)); glowCanvas.height = Math.max(16, Math.round(H / 2));
    gctx.setTransform(glowCanvas.width / W, 0, 0, glowCanvas.height / H, 0, 0);
    glowAt = -1e9;
    var want = Math.round(Math.min(coarse ? 36 : 60, (W * H) / 20000));
    while (pts.length < want) pts.push(newPoint(pts.length));
    if (pts.length > want) pts.length = want;
    draw(performance.now());
  }
  function draw(now) {
    if (!running || now - glowAt >= 250) { glowAt = now; drawGlows(now); }
    ctx.drawImage(glowCanvas, 0, 0, W, H);

    var dt = Math.min(64, now - (prev || now)); prev = now;
    var i, j, p, q;
    if (running) for (i = 0; i < pts.length; i++) {
      p = pts[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      // Wrap softly round the edges, so the field never thins out.
      if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;
      if (p.y < -20) p.y = H + 20; else if (p.y > H + 20) p.y = -20;
    }
    // Lines between near points, fading with distance.
    ctx.lineWidth = .8;
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      for (j = i + 1; j < pts.length; j++) {
        q = pts[j];
        var dx = p.x - q.x, dy = p.y - q.y;
        if (dx > LINK || dx < -LINK || dy > LINK || dy < -LINK) continue;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d >= LINK) continue;
        ctx.strokeStyle = rgba(LINE, .16 * (1 - d / LINK));
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
    }
    // The points; stars breathe and carry a halo.
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      var c = p.pink ? PINK : NODE;
      var a = p.star ? .55 + .3 * Math.sin(now * .0012 + p.ph) : .35;
      if (p.star) { ctx.fillStyle = rgba(c, a * .14); ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 4.5, 0, 6.283); ctx.fill(); }
      ctx.fillStyle = rgba(c, a); ctx.beginPath(); ctx.arc(p.x, p.y, p.star ? p.r + .6 : p.r, 0, 6.283); ctx.fill();
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
    setTimeout(function () {
      el.hidden = true; el.classList.remove('leave'); leaving = false; stop();
      // Give the drawing buffer back: a hidden full-screen canvas still holds it.
      cv.width = 0; cv.height = 0; glowCanvas.width = 0; glowCanvas.height = 0;
    }, 420);
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

  // A deep link (?class=…), a file being shared in, or a pull-to-refresh
  // (js/pulltorefresh.js) goes straight to work.
  var skip = /[?&]fresh=1/.test(location.search);
  if (skip) try { var fu = new URL(location.href); fu.searchParams.delete('fresh'); history.replaceState(history.state, '', fu.toString()); } catch (e) {}
  if (skip || /[?&](class|ingest)=/.test(location.search) || /\/(share|open-file)/.test(location.pathname)) {
    el.hidden = true;
  } else {
    resize();
    start();
    try { el.focus({ preventScroll: true }); } catch (e) {}
  }
})();
