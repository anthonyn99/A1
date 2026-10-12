/* ─────────────────────────────────────────────────────────────────────────────
 * scrollbar.js — A1's one scrollbar. Shared by every program.
 *
 * The scrollbar Vault has always had (Vault/vault-controls.js), pulled out on
 * its own: native bars are hidden, so a page never shifts sideways when one
 * appears, and a thin overlay thumb fades in while a box scrolls (or the
 * pointer nears its edge), fades out when idle, and can be dragged — mouse,
 * pen or finger. Track clicks page.
 *
 * Add it with one tag in <head>, so it is there before the page's own code:
 *   <script src="scrollbar.js"></script>
 * Opt a subtree out with `data-native-scroll`.
 *
 * Tony's side only. Veda's side of a two-profile page (body data-profile or
 * data-th-profile = "veda") keeps the bars it always had: this file switches
 * itself off there, live, and A1Scrollbar.active() says which is in force. A
 * program's older bar (the journal editor's, Shield's, MAGI's, OneInbox's,
 * ProView's) checks active() and stands down while this one is on.
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
    // The thumb's length and offset are redrawn every frame, so only its
    // thickness (the hover grow) animates — never where it is or how long.
    '.vc-thumb{position:absolute;border-radius:99px;background:rgba(173,173,178,.45);cursor:grab;touch-action:none;will-change:transform}',
    '.vc-rail.v .vc-thumb{top:0;right:3px;width:6px;transition:background-color .15s,width .15s}',
    '.vc-rail.h .vc-thumb{left:0;bottom:3px;height:6px;transition:background-color .15s,height .15s}',
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
    sync();
  }
  function veda() {
    var b = doc.body;
    return !!b && (b.getAttribute('data-profile') === 'veda' || b.getAttribute('data-th-profile') === 'veda');
  }
  function sync() {
    var on = !veda();
    if (root.classList.contains('vc-on') === on) return;
    root.classList.toggle('vc-on', on);
    if (!on) bars.forEach(function (b) { b.live = false; ['v', 'h'].forEach(function (a) { if (b[a]) hideRail(b[a]); }); });
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
  function vw() { return root.clientWidth || window.innerWidth; }
  function vh() { return window.innerHeight || root.clientHeight; }

  // ── overlay scrollbars ─────────────────────────────────────────────────────
  // While a rail shows, one animation-frame loop re-reads every shown scroller
  // and redraws its thumb, so the thumb follows the content frame by frame:
  // through a phone's momentum fling, a toolbar sliding away, content that
  // grows or shrinks, and a box that moves because its page scrolled. Scroll
  // events only wake it. Each frame reads everything first and writes after,
  // so drawing never forces an extra layout.
  var bars = new Map();            // scroller -> bar
  var HIDE_MS = 1100;
  var INSET = 2;
  var loop = 0;
  function docScroller() { return doc.scrollingElement || root; }
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
    if (t === doc || t === doc.documentElement || t === doc.body) return docScroller();
    return t;
  }
  // How much of a scroller shows, where it is, and how far it can go. The
  // page shows the window's height, which on a phone grows and shrinks as the
  // browser's toolbar slides away. The range never ends short of where the
  // scroller actually is, so the thumb can't run off its track.
  function extent(el, axis) {
    var v = axis === 'v';
    var view = el === docScroller() ? (v ? vh() : vw()) : (v ? el.clientHeight : el.clientWidth);
    var pos = Math.abs(v ? el.scrollTop : el.scrollLeft);
    var max = Math.max((v ? el.scrollHeight : el.scrollWidth) - view, pos, 0);
    return { view: view, pos: pos, max: max };
  }
  function canScroll(el, axis) {
    if (!el || el.nodeType !== 1 || !root.classList.contains('vc-on') || el.closest('[data-native-scroll]')) return false;
    var isDoc = el === docScroller();
    if (axis === 'v') {
      if (extent(el, 'v').max < 2) return false;
      if (isDoc) return true;
      var oy = getComputedStyle(el).overflowY; return oy === 'auto' || oy === 'scroll';
    }
    if (extent(el, 'h').max < 2) return false;
    if (isDoc) return true;
    // A short horizontally-swiped strip (tab bar, chip row) hid its bar on
    // purpose — a rail along its bottom would sit on top of its buttons.
    if (el.clientHeight < 120) return false;
    var ox = getComputedStyle(el).overflowX; return ox === 'auto' || ox === 'scroll';
  }
  // Where a scroller's rail lives: the top layer it is in. A scroller that is
  // ITSELF a fixed layer (a drawer, a modal sheet) holds its own rail, or the
  // rail would paint underneath it.
  function railHost(el) {
    if (el === docScroller()) return doc.body;
    if (el !== doc.body && !/^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName) && getComputedStyle(el).position === 'fixed') return el;
    return layerOf(el);
  }
  function makeRail(el, axis) {
    var rail = h('div', 'vc-rail ' + axis);
    var thumb = h('div', 'vc-thumb');
    rail.appendChild(thumb);
    rail.setAttribute('aria-hidden', 'true');
    rail.style.left = '0px'; rail.style.top = '0px';
    return { rail: rail, thumb: thumb, axis: axis, drawn: {} };
  }
  function barFor(el) {
    var b = bars.get(el);
    if (b) return b;
    b = { el: el, v: null, h: null, timer: 0, hover: false, drag: false, live: false };
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
  function hideRail(r) { if (r.rail.style.display !== 'none') { r.rail.style.display = 'none'; r.drawn = {}; } }
  // Writes only: the rails that should show are in the page and displayed.
  function prepare(b) {
    ['v', 'h'].forEach(function (axis) {
      var r = b[axis]; if (!r) return;
      if (!b.el.isConnected || !canScroll(b.el, axis)) { hideRail(r); return; }
      if (!r.rail.isConnected) {
        var host = railHost(b.el);
        host.appendChild(r.rail);
        // A scroller inside a top layer gets a rail ABOVE that layer's content.
        r.rail.style.zIndex = host === doc.body ? '60' : '2147483000';
      }
      if (r.rail.style.display === 'none') r.rail.style.display = '';
    });
  }
  // Reads only.
  function measure(b) {
    var el = b.el, isDoc = el === docScroller(), m = { v: null, h: null };
    ['v', 'h'].forEach(function (axis) {
      var r = b[axis];
      if (!r || r.rail.style.display === 'none' || !r.rail.isConnected) return;
      // Where the rail's left/top really start: the viewport, unless an
      // ancestor with a transform / filter is its containing block.
      var rr = r.rail.getBoundingClientRect();
      m[axis] = {
        x: extent(el, axis),
        o: { x: rr.left - (parseFloat(r.rail.style.left) || 0), y: rr.top - (parseFloat(r.rail.style.top) || 0) },
        w: r.rail.offsetWidth, hgt: r.rail.offsetHeight,
      };
    });
    if (!m.v && !m.h) return m;
    var rect = isDoc ? { left: 0, top: 0, right: vw(), bottom: vh(), width: vw(), height: vh() } : el.getBoundingClientRect();
    // Clipped to the viewport, so a box half off-screen doesn't draw its bar
    // over the page chrome.
    m.g = {
      top: Math.max(rect.top, 0), bottom: Math.min(rect.bottom, vh()),
      left: Math.max(rect.left, 0), right: Math.min(rect.right, vw()), rect: rect,
      border: isDoc ? { t: 0, r: 0, b: 0, l: 0 } : { t: el.clientTop, l: el.clientLeft, r: rect.width - el.clientWidth - el.clientLeft, b: rect.height - el.clientHeight - el.clientTop },
    };
    return m;
  }
  function put(r, node, prop, val) {
    var k = (node === r.rail ? 'r.' : 't.') + prop;
    if (r.drawn[k] === val) return;
    r.drawn[k] = val; node.style[prop] = val;
  }
  // Writes only, from what measure() read.
  function draw(b, m) {
    var g = m.g;
    ['v', 'h'].forEach(function (axis) {
      var r = b[axis], s = m[axis]; if (!r || !s) return;
      var vert = axis === 'v';
      var len = vert
        ? g.bottom - g.top - g.border.t - g.border.b - (m.h ? 14 : 0)
        : g.right - g.left - g.border.l - g.border.r - (m.v ? 14 : 0);
      len = Math.max(0, len);
      var x = s.x;
      var size = Math.min(len, Math.max(coarse.matches ? 44 : 32, len * (x.view / (x.view + x.max))));
      var travel = Math.max(0, len - size - INSET * 2);
      var at = x.max > 0 ? Math.min(1, x.pos / x.max) * travel + INSET : INSET;
      r.travel = travel;
      if (vert) {
        put(r, r.rail, 'top', Math.round(g.top + g.border.t - s.o.y) + 'px');
        put(r, r.rail, 'height', Math.round(len) + 'px');
        put(r, r.rail, 'left', Math.round(Math.min(g.right, g.rect.right - g.border.r) - s.w - s.o.x) + 'px');
        put(r, r.thumb, 'height', Math.max(0, size - INSET * 2).toFixed(1) + 'px');
        put(r, r.thumb, 'transform', 'translateY(' + at.toFixed(1) + 'px)');
      } else {
        put(r, r.rail, 'left', Math.round(g.left + g.border.l - s.o.x) + 'px');
        put(r, r.rail, 'width', Math.round(len) + 'px');
        put(r, r.rail, 'top', Math.round(Math.min(g.bottom, g.rect.bottom - g.border.b) - s.hgt - s.o.y) + 'px');
        put(r, r.thumb, 'width', Math.max(0, size - INSET * 2).toFixed(1) + 'px');
        put(r, r.thumb, 'transform', 'translateX(' + at.toFixed(1) + 'px)');
      }
    });
  }
  function update(list) {
    list.forEach(prepare);
    var ms = list.map(measure);
    list.forEach(function (b, i) { draw(b, ms[i]); });
  }
  function frame() {
    loop = 0;
    var live = [];
    bars.forEach(function (b) { if (b.live) live.push(b); });
    if (!live.length) return;
    update(live);
    loop = requestAnimationFrame(frame);
  }
  function wake() { if (!loop) loop = requestAnimationFrame(frame); }
  function show(b, axes) {
    (axes || ['v', 'h']).forEach(function (a) { if (canScroll(b.el, a)) ensureRail(b, a); });
    b.live = true;
    var fresh = ['v', 'h'].filter(function (a) { return b[a] && !b[a].rail.classList.contains('on'); });
    if (fresh.length) {
      // Drawn in place now, so it fades in where it belongs.
      update([b]);
      fresh.forEach(function (a) {
        var r = b[a];
        if (r.rail.style.display === 'none') return;
        // Coming back from display:none — give it one frame so the fade runs.
        void r.rail.offsetWidth;
        r.rail.classList.add('on');
      });
    }
    wake();
    schedule(b);
  }
  function schedule(b) {
    clearTimeout(b.timer);
    b.timer = setTimeout(function () {
      if (b.hover || b.drag) return schedule(b);
      ['v', 'h'].forEach(function (a) { if (b[a]) b[a].rail.classList.remove('on'); });
      // Out of layout entirely once faded, so an idle rail can never pin a
      // size (the Launcher popup sizes itself from its content).
      b.timer = setTimeout(function () {
        if (['v', 'h'].some(function (a) { return b[a] && b[a].rail.classList.contains('on'); })) return;
        b.live = false;
        ['v', 'h'].forEach(function (a) { if (b[a]) hideRail(b[a]); });
        // Detached scroller (modal closed): drop its rails entirely.
        if (!b.el.isConnected) { ['v', 'h'].forEach(function (a) { if (b[a] && b[a].rail.parentNode) b[a].rail.parentNode.removeChild(b[a].rail); }); bars.delete(b.el); }
      }, 400);
    }, HIDE_MS);
  }
  function bindDrag(b, r) {
    var vert = r.axis === 'v';
    r.rail.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      var el = b.el;
      if (e.target !== r.thumb && !r.thumb.contains(e.target)) {
        // Track click: page toward the pointer.
        var tr = r.thumb.getBoundingClientRect();
        var before = vert ? e.clientY < tr.top : e.clientX < tr.left;
        var page = extent(el, r.axis).view * 0.9 * (before ? -1 : 1);
        el.scrollBy(vert ? { top: page, behavior: reduced.matches ? 'auto' : 'smooth' } : { left: page, behavior: reduced.matches ? 'auto' : 'smooth' });
        show(b);
        return;
      }
      b.drag = true; r.rail.classList.add('drag'); root.classList.add('vc-dragging');
      var start = vert ? e.clientY : e.clientX;
      var startScroll = vert ? el.scrollTop : el.scrollLeft;
      var perPx = r.travel > 0 ? extent(el, r.axis).max / r.travel : 0;
      try { r.rail.setPointerCapture(e.pointerId); } catch (_) {}
      function move(ev) {
        var d = ((vert ? ev.clientY : ev.clientX) - start) * perPx;
        if (vert) el.scrollTop = startScroll + d; else el.scrollLeft = startScroll + d;
        update([b]);
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
    var b = bars.get(el);
    // Already showing: the frame loop draws it; just keep it awake.
    if (b && b.live && ['v', 'h'].some(function (a) { return b[a] && b[a].rail.classList.contains('on'); })) { wake(); schedule(b); return; }
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
        if (el === doc.body && !bodyScrolls()) el = docScroller();
        var v = canScroll(el, 'v');
        var hz = canScroll(el, 'h');
        if (v || hz) {
          var isDoc = el === docScroller();
          var rc = isDoc ? { right: vw(), bottom: vh() } : el.getBoundingClientRect();
          var nearV = v && rc.right - ev.clientX <= 24 && rc.right - ev.clientX >= -2;
          var nearH = hz && rc.bottom - ev.clientY <= 24 && rc.bottom - ev.clientY >= -2;
          if (nearV || nearH) { show(barFor(el), [nearV ? 'v' : null, nearH ? 'h' : null].filter(Boolean)); return; }
        }
        if (el === docScroller()) return;
      }
    });
  }, { passive: true });
  // The window or a phone's visual viewport changing size: redraw what shows.
  window.addEventListener('resize', wake);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', wake);

  function start() {
    injectStyles();
    // The profile can change after load (Index and Shield switch it live).
    if (doc.body) new MutationObserver(sync).observe(doc.body, { attributes: true, attributeFilter: ['data-profile', 'data-th-profile'] });
  }
  if (doc.head) injectStyles();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();

  window.A1Scrollbar = {
    show: function (el) { show(barFor(el)); },
    active: function () { return root.classList.contains('vc-on'); },
  };
})();
