/* ─────────────────────────────────────────────────────────────────────────────
 * scrollbar.js — A1's one scrollbar. Shared by every program.
 *
 * The scrollbar Vault has always had (Vault/vault-controls.js), pulled out on
 * its own: native bars are hidden, so a page never shifts sideways when one
 * appears, and a thin overlay thumb fades in while a box scrolls (or the
 * pointer nears its edge), fades out when idle, and can be dragged — mouse,
 * pen or finger. Track clicks page.
 *
 * Add it with one tag, anywhere in the page:
 *   <script src="scrollbar.js"></script>
 * Opt a subtree out with `data-native-scroll`.
 *
 * Vault itself keeps loading vault-controls.js (which carries the same code
 * plus its select/date/tooltip controls), so this file stands down when that
 * one is present. Keep the two scrollbar halves in step.
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.A1Scrollbar || window.VaultControls) return;
  var doc = document;
  var root = doc.documentElement;
  var coarse = window.matchMedia ? window.matchMedia('(pointer:coarse)') : { matches: false };
  var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion:reduce)') : { matches: false };

  var CSS = [
    // Native scrollbars off everywhere — the overlay thumb below replaces them.
    // `html.vc-on` itself too: the page's own bar belongs to <html>, not to
    // anything inside it.
    'html.vc-on:not([data-native-scroll]),html.vc-on *:not([data-native-scroll]){scrollbar-width:none!important}',
    'html.vc-on:not([data-native-scroll])::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;background:transparent!important}',
    'html.vc-on :not([data-native-scroll])::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;background:transparent!important}',
    // ── overlay scrollbar ──
    '.vc-rail{position:fixed;z-index:60;pointer-events:none;opacity:0;transition:opacity .35s ease;touch-action:none}',
    '.vc-rail.on{opacity:1;pointer-events:auto;transition-duration:.14s}',
    '.vc-rail.v{width:14px}.vc-rail.h{height:14px}',
    '.vc-thumb{position:absolute;border-radius:99px;background:rgba(173,173,178,.45);cursor:grab;',
    '  transition:background-color .15s,width .15s,height .15s;touch-action:none}',
    '.vc-rail.v .vc-thumb{right:3px;width:6px}.vc-rail.h .vc-thumb{bottom:3px;height:6px}',
    '.vc-thumb::before{content:"";position:absolute;inset:-6px -4px}',
    '.vc-rail:hover .vc-thumb,.vc-rail.drag .vc-thumb{background:var(--ac,#c0aeea)}',
    '.vc-rail.v:hover .vc-thumb,.vc-rail.v.drag .vc-thumb{width:9px}.vc-rail.h:hover .vc-thumb,.vc-rail.h.drag .vc-thumb{height:9px}',
    '.vc-rail.drag .vc-thumb{cursor:grabbing}',
    '@media (pointer:coarse){',
    // Finger-sized grab area, thin visible pill.
    '  .vc-rail.v{width:28px}.vc-rail.h{height:28px}',
    '  .vc-rail.v .vc-thumb{width:5px;right:3px}.vc-rail.h .vc-thumb{height:5px;bottom:3px}',
    '  .vc-thumb::before{inset:-10px -12px -10px -20px}',
    // On touch only the thumb takes the finger: the rest of the rail must never
    // eat a tap meant for a row button at the edge of the list.
    '  .vc-rail.on{pointer-events:none}.vc-rail.on .vc-thumb{pointer-events:auto}',
    '  .vc-rail.v.drag .vc-thumb{width:8px}.vc-rail.h.drag .vc-thumb{height:8px}',
    '}',
    'html.vc-dragging,html.vc-dragging *{cursor:grabbing!important;user-select:none!important;-webkit-user-select:none!important}',
    '@media (prefers-reduced-motion:reduce){.vc-rail,.vc-thumb{transition:none!important}}',
  ].join('\n');

  function injectStyles() {
    if (doc.getElementById('vc-styles') || doc.getElementById('a1sb-styles')) return;
    var s = doc.createElement('style'); s.id = 'a1sb-styles'; s.textContent = CSS;
    (doc.head || root).appendChild(s);
    root.classList.add('vc-on');
  }

  function h(tag, cls, html) { var e = doc.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  // ── layering ───────────────────────────────────────────────────────────────
  // Floating UI must live in the same top layer as its anchor (a modal
  // overlay, the lock screen…), or it would paint under it. The host is the
  // nearest position:fixed ancestor; failing that, <body>.
  function layerOf(el) {
    for (var e = el && el.parentElement; e && e !== doc.body; e = e.parentElement) {
      if (getComputedStyle(e).position === 'fixed') return e;
    }
    return doc.body;
  }
  // A position:fixed child is positioned against the viewport UNLESS an
  // ancestor has a transform / filter / backdrop-filter, which makes that
  // ancestor the containing block. Measure instead of guessing.
  function fixedOrigin(node) {
    var prev = node.style.cssText;
    node.style.left = '0px'; node.style.top = '0px';
    var r = node.getBoundingClientRect();
    node.style.cssText = prev;
    return { x: r.left, y: r.top };
  }
  function vw() { return root.clientWidth || window.innerWidth; }
  function vh() { return window.innerHeight || root.clientHeight; }

  // ── overlay scrollbars ─────────────────────────────────────────────────────
  var bars = new Map();            // scroller -> bar
  var HIDE_MS = 1100;
  // A page whose <html> is overflow:hidden scrolls <body> instead; every other
  // page scrolls the document, whichever of the two the event names.
  function bodyScrolls() {
    var b = doc.body;
    if (!b || b.scrollHeight - b.clientHeight < 2) return false;
    var oy = getComputedStyle(b).overflowY;
    return (oy === 'auto' || oy === 'scroll') && getComputedStyle(root).overflowY !== 'visible';
  }
  function scrollerFor(t) {
    if (t === doc.body && bodyScrolls()) return doc.body;
    if (t === doc || t === doc.documentElement || t === doc.body) return doc.scrollingElement || root;
    return t;
  }
  function canScroll(el, axis) {
    if (!el || el.nodeType !== 1 || el.closest('[data-native-scroll]')) return false;
    // A scroller that draws its own overlay bar (MAGI's [data-sbar], RiftIQ's
    // ProView) keeps it; a second rail would sit on top of the first.
    if (el.hasAttribute('data-sbar')) return false;
    var isDoc = el === (doc.scrollingElement || root);
    if (axis === 'v') {
      if (el.scrollHeight - el.clientHeight < 2) return false;
      if (isDoc) return true;
      var oy = getComputedStyle(el).overflowY; return oy === 'auto' || oy === 'scroll';
    }
    if (el.scrollWidth - el.clientWidth < 2) return false;
    if (isDoc) return true;
    // A short horizontally-swiped strip (tab bar, chip row) hid its bar on
    // purpose — a rail along its bottom would sit on top of its buttons.
    if (el.clientHeight < 120) return false;
    var ox = getComputedStyle(el).overflowX; return ox === 'auto' || ox === 'scroll';
  }
  function makeRail(el, axis) {
    var rail = h('div', 'vc-rail ' + axis);
    var thumb = h('div', 'vc-thumb');
    rail.appendChild(thumb);
    rail.setAttribute('aria-hidden', 'true');
    return { rail: rail, thumb: thumb, axis: axis };
  }
  function barFor(el) {
    var b = bars.get(el);
    if (b) return b;
    b = { el: el, v: null, h: null, timer: 0, hover: false, drag: false };
    bars.set(el, b);
    return b;
  }
  function ensureRail(b, axis) {
    if (b[axis]) return b[axis];
    var r = makeRail(b.el, axis);
    b[axis] = r;
    bindDrag(b, r);
    r.rail.addEventListener('pointerenter', function () { b.hover = true; show(b); });
    r.rail.addEventListener('pointerleave', function () { b.hover = false; schedule(b); });
    return r;
  }
  function geometry(b, r) {
    var el = b.el, isDoc = el === (doc.scrollingElement || root);
    var rect = isDoc ? { left: 0, top: 0, right: vw(), bottom: vh(), width: vw(), height: vh() } : el.getBoundingClientRect();
    // Clip to the visible viewport so a box half off-screen doesn't draw its
    // bar over the page chrome.
    var top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, vh());
    var left = Math.max(rect.left, 0), right = Math.min(rect.right, vw());
    var border = isDoc ? { t: 0, r: 0, b: 0, l: 0 } : { t: el.clientTop, l: el.clientLeft, r: rect.width - el.clientWidth - el.clientLeft, b: rect.height - el.clientHeight - el.clientTop };
    return { top: top, bottom: bottom, left: left, right: right, rect: rect, border: border, isDoc: isDoc };
  }
  function layout(b) {
    ['v', 'h'].forEach(function (axis) {
      var r = b[axis]; if (!r) return;
      var el = b.el;
      if (!canScroll(el, axis) || !el.isConnected) { r.rail.style.display = 'none'; return; }
      r.rail.style.display = '';
      if (!r.rail.isConnected) layerOf(el === (doc.scrollingElement || root) ? doc.body : el).appendChild(r.rail);
      // A scroller inside a top layer gets a rail ABOVE that layer's content.
      var host = r.rail.parentNode;
      r.rail.style.zIndex = host === doc.body ? '60' : '2147483000';
      var g = geometry(b, r);
      var o = fixedOrigin(r.rail);
      var inset = 2;
      if (axis === 'v') {
        var H = Math.max(0, g.bottom - g.top - g.border.t - g.border.b - (b.h && canScroll(el, 'h') ? 14 : 0));
        var ratio = el.clientHeight / el.scrollHeight;
        var th = Math.max(coarse.matches ? 44 : 32, H * ratio);
        var maxScroll = el.scrollHeight - el.clientHeight;
        var ty = maxScroll > 0 ? (el.scrollTop / maxScroll) * (H - th - inset * 2) + inset : inset;
        r.rail.style.top = (g.top + g.border.t - o.y) + 'px';
        r.rail.style.height = H + 'px';
        r.rail.style.left = (Math.min(g.right, g.rect.right - g.border.r) - r.rail.offsetWidth - o.x) + 'px';
        r.thumb.style.height = Math.max(0, th - inset * 2) + 'px';
        r.thumb.style.top = ty + 'px';
        r.track = H - th; r.size = th;
      } else {
        var W = Math.max(0, g.right - g.left - g.border.l - g.border.r - (b.v && canScroll(el, 'v') ? 14 : 0));
        var rx = el.clientWidth / el.scrollWidth;
        var tw = Math.max(coarse.matches ? 44 : 32, W * rx);
        var maxX = el.scrollWidth - el.clientWidth;
        var tx = maxX > 0 ? (el.scrollLeft / maxX) * (W - tw - inset * 2) + inset : inset;
        r.rail.style.left = (g.left + g.border.l - o.x) + 'px';
        r.rail.style.width = W + 'px';
        r.rail.style.top = (Math.min(g.bottom, g.rect.bottom - g.border.b) - r.rail.offsetHeight - o.y) + 'px';
        r.thumb.style.width = Math.max(0, tw - inset * 2) + 'px';
        r.thumb.style.left = tx + 'px';
        r.track = W - tw; r.size = tw;
      }
    });
  }
  function show(b, axes) {
    (axes || ['v', 'h']).forEach(function (a) { if (canScroll(b.el, a)) ensureRail(b, a); });
    layout(b);
    ['v', 'h'].forEach(function (a) {
      var r = b[a];
      if (!r || r.rail.style.display === 'none' || r.rail.classList.contains('on')) return;
      // Coming back from display:none — give it one frame so the fade runs.
      void r.rail.offsetWidth;
      r.rail.classList.add('on');
    });
    schedule(b);
  }
  function schedule(b) {
    clearTimeout(b.timer);
    b.timer = setTimeout(function () {
      if (b.hover || b.drag) return schedule(b);
      ['v', 'h'].forEach(function (a) {
        var r = b[a]; if (!r) return;
        r.rail.classList.remove('on');
        // Out of layout entirely once faded, so an idle rail can never pin a
        // size (the Launcher popup sizes itself from its content).
        setTimeout(function () { if (!r.rail.classList.contains('on')) r.rail.style.display = 'none'; }, 400);
      });
      // Detached scroller (modal closed): drop its rails entirely.
      if (!b.el.isConnected) { ['v', 'h'].forEach(function (a) { if (b[a] && b[a].rail.parentNode) b[a].rail.parentNode.removeChild(b[a].rail); }); bars.delete(b.el); }
    }, HIDE_MS);
  }
  function bindDrag(b, r) {
    var vert = r.axis === 'v';
    r.rail.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      var el = b.el;
      var max = vert ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      if (e.target !== r.thumb && !r.thumb.contains(e.target)) {
        // Track click: page toward the pointer.
        var tr = r.thumb.getBoundingClientRect();
        var before = vert ? e.clientY < tr.top : e.clientX < tr.left;
        var page = (vert ? el.clientHeight : el.clientWidth) * 0.9 * (before ? -1 : 1);
        el.scrollBy(vert ? { top: page, behavior: reduced.matches ? 'auto' : 'smooth' } : { left: page, behavior: reduced.matches ? 'auto' : 'smooth' });
        show(b);
        return;
      }
      b.drag = true; r.rail.classList.add('drag'); root.classList.add('vc-dragging');
      var start = vert ? e.clientY : e.clientX;
      var startScroll = vert ? el.scrollTop : el.scrollLeft;
      var perPx = r.track > 0 ? max / r.track : 0;
      try { r.rail.setPointerCapture(e.pointerId); } catch (_) {}
      function move(ev) {
        var d = ((vert ? ev.clientY : ev.clientX) - start) * perPx;
        if (vert) el.scrollTop = startScroll + d; else el.scrollLeft = startScroll + d;
        layout(b);
      }
      function up() {
        b.drag = false; r.rail.classList.remove('drag'); root.classList.remove('vc-dragging');
        r.rail.removeEventListener('pointermove', move); r.rail.removeEventListener('pointerup', up); r.rail.removeEventListener('pointercancel', up);
        schedule(b);
      }
      r.rail.addEventListener('pointermove', move); r.rail.addEventListener('pointerup', up); r.rail.addEventListener('pointercancel', up);
    });
  }
  // Scrolling anywhere shows that box's bar.
  doc.addEventListener('scroll', function (e) {
    var el = scrollerFor(e.target);
    if (!el || el.nodeType !== 1) return;
    if (!canScroll(el, 'v') && !canScroll(el, 'h')) return;
    show(barFor(el));
  }, true);
  // Hovering near a scrollable box's edge shows its bar too, so it can be
  // grabbed before any scrolling happens (mouse / pen only).
  var hoverRaf = 0, lastMove = null;
  doc.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;
    lastMove = e;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(function () {
      hoverRaf = 0;
      var ev = lastMove; if (!ev) return;
      var t = ev.target;
      if (t && t.closest && t.closest('.vc-rail')) return;
      for (var el = t && t.nodeType === 1 ? t : null; el; el = el.parentElement) {
        if (el === doc.body && !bodyScrolls()) el = doc.scrollingElement || root;
        var v = canScroll(el, 'v');
        var hz = canScroll(el, 'h');
        if (v || hz) {
          var isDoc = el === (doc.scrollingElement || root);
          var rc = isDoc ? { right: vw(), bottom: vh() } : el.getBoundingClientRect();
          var nearV = v && rc.right - ev.clientX <= 24 && rc.right - ev.clientX >= -2;
          var nearH = hz && rc.bottom - ev.clientY <= 24 && rc.bottom - ev.clientY >= -2;
          if (nearV || nearH) { show(barFor(el), [nearV ? 'v' : null, nearH ? 'h' : null].filter(Boolean)); return; }
        }
        if (el === (doc.scrollingElement || root)) return;
      }
    });
  }, { passive: true });
  window.addEventListener('resize', function () { bars.forEach(function (b) { if (b.v && b.v.rail.classList.contains('on')) layout(b); }); });

  function start() {
    injectStyles();
  }
  if (doc.head) injectStyles();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();

  window.A1Scrollbar = { show: function (el) { show(barFor(el)); } };
})();
