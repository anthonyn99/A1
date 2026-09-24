/* ============================================================================
 * vault-drag.js — reusable drag-to-reorder for a strip of buttons
 *
 * Mounted on every re-orderable strip in Vault: the tab bar (#vault-tabs) and
 * the header actions (#kc-hbar-actions).
 *
 * Gestures, and why they differ by input:
 *   mouse / pen — arms after 5px of movement. No scroll to protect.
 *   touch       — arms on a 260ms long press (with a haptic tick), and any real
 *                 movement before then cancels it, so an ordinary swipe still
 *                 scrolls the strip instead of grabbing a tab.
 *
 * Why it's smooth (the previous version wasn't):
 *   • Everything is computed in LAYOUT coordinates (offsetLeft/Top relative to
 *     the strip), never from getBoundingClientRect of the neighbours. Those
 *     rects include the neighbours' in-flight slide animations, so hit-testing
 *     them made swaps flicker back and forth mid-animation.
 *   • The dragged item is positioned from the pointer every frame as
 *     "where it should be" minus "where layout puts it", so a DOM reorder under
 *     it never makes it jump — there is no re-anchoring.
 *   • Neighbours glide with FLIP from their CURRENT on-screen position (read
 *     from the live transform), so a second swap during an animation continues
 *     smoothly instead of snapping.
 *   • Swaps use midpoint hysteresis: the dragged item's centre must cross a
 *     neighbour's centre, so a pointer resting on a boundary can't oscillate.
 *   • Pointer moves are coalesced to one update per animation frame.
 *   • Wrapped layouts (the header row on a phone) work: rows are compared by
 *     their vertical position as well.
 *   • Near either edge of an overflowing strip, it auto-scrolls.
 *
 *   VaultDrag.enable(container, {
 *     item:    '[data-hk]',      // selector for a draggable child
 *     key:     'data-hk',        // attribute holding its stable id
 *     onDrop:  function(order){} // called with the new key order, on change only
 *   })
 *
 * enable() is idempotent per container.
 * ========================================================================== */
(function () {
  'use strict';

  var EASE = 'cubic-bezier(.2,.8,.2,1)';
  var SLIDE_MS = 190, SETTLE_MS = 220, HOLD_MS = 260;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches;

  (function injectCss() {
    if (document.getElementById('vdrag-styles')) return;
    var s = document.createElement('style');
    s.id = 'vdrag-styles';
    s.textContent =
      '.vdrag-strip>*{-webkit-touch-callout:none}' +
      // Dragged item: above its neighbours, no transition on its own movement
      // (it must track the pointer exactly), lifted look via the caller's
      // .vdrag rule plus a slight scale here.
      '.vdrag-strip .vdrag{position:relative;z-index:5;transition:none!important;will-change:transform;cursor:grabbing!important}' +
      '.vdrag-strip.vdrag-live>*{will-change:transform}' +
      'html.vdrag-active,html.vdrag-active *{cursor:grabbing!important;user-select:none!important;-webkit-user-select:none!important}';
    (document.head || document.documentElement).appendChild(s);
  })();

  function enable(nav, opts) {
    if (!nav || nav._vdragOn) return;
    nav._vdragOn = true;
    nav.classList.add('vdrag-strip');
    // Items must measure against the strip itself.
    if (getComputedStyle(nav).position === 'static') nav.style.position = 'relative';

    var ITEM = opts.item, KEY = opts.key;
    var onDrop = opts.onDrop || function () {};

    function items() { return Array.prototype.slice.call(nav.querySelectorAll(ITEM)); }
    function order() { return items().map(function (n) { return n.getAttribute(KEY); }); }

    var d = null, holdTimer = null, frame = null, autoRaf = null;

    // Pointer position in the strip's content coordinates (what offsetLeft/Top use).
    function toLocal(cx, cy) {
      var r = nav.getBoundingClientRect();
      return { x: cx - r.left - nav.clientLeft + nav.scrollLeft, y: cy - r.top - nav.clientTop + nav.scrollTop };
    }
    function box(n) { return { x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight }; }
    function liveShift(n) {
      var t = getComputedStyle(n).transform;
      if (!t || t === 'none') return { x: 0, y: 0 };
      try { var m = new DOMMatrixReadOnly(t); return { x: m.m41, y: m.m42 }; } catch (e) { return { x: 0, y: 0 }; }
    }

    // Reorder the DOM and glide every displaced sibling from wherever it is on
    // screen right now to its new slot.
    function moveWithFlip(mutate) {
      var others = items().filter(function (n) { return n !== d.node; });
      var before = others.map(function (n) { var b = box(n), s = liveShift(n); return { x: b.x + s.x, y: b.y + s.y }; });
      mutate();
      others.forEach(function (n, i) {
        var b = box(n);
        var dx = before[i].x - b.x, dy = before[i].y - b.y;
        if (!dx && !dy) return;
        n.style.transition = 'none';
        n.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      });
      // One reflow for all of them, then let them slide home together.
      void nav.offsetWidth;
      others.forEach(function (n) {
        if (!n.style.transform) return;
        n.style.transition = reduced ? 'none' : 'transform ' + SLIDE_MS + 'ms ' + EASE;
        n.style.transform = '';
      });
    }

    function place() {
      frame = null;
      if (!d || !d.dragging) return;
      var p = toLocal(d.lastX, d.lastY);
      var wantX = p.x - d.gx, wantY = p.y - d.gy;           // where the item's top-left should be
      var b = box(d.node);
      var cx = wantX + b.w / 2, cy = wantY + b.h / 2;       // its centre
      // Find the sibling under the dragged centre, and swap past it only once
      // the centre crosses that sibling's centre.
      var kids = items();
      var from = kids.indexOf(d.node);
      for (var i = 0; i < kids.length; i++) {
        var o = kids[i];
        if (o === d.node) continue;
        var ob = box(o);
        var sameRow = Math.abs((ob.y + ob.h / 2) - (b.y + b.h / 2)) < Math.max(ob.h, b.h) / 2;
        var inside = cx >= ob.x && cx <= ob.x + ob.w && cy >= ob.y - 4 && cy <= ob.y + ob.h + 4;
        if (!inside) continue;
        var omx = ob.x + ob.w / 2, omy = ob.y + ob.h / 2;
        if (i < from && (sameRow ? cx < omx : cy < omy)) { moveWithFlip(function () { nav.insertBefore(d.node, o); }); recapture(); }
        else if (i > from && (sameRow ? cx > omx : cy > omy)) { moveWithFlip(function () { nav.insertBefore(d.node, o.nextSibling); }); recapture(); }
        break;
      }
      // Re-read layout AFTER any move: the item's slot may have changed, the
      // wanted position hasn't, so the difference is exactly the new transform.
      var nb = box(d.node);
      d.node.style.transform = 'translate(' + (wantX - nb.x) + 'px,' + (wantY - nb.y) + 'px) scale(1.04)';
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(place); }
    // Moving a node in the DOM silently releases its pointer capture — take it
    // back, or the rest of the drag is lost the moment the pointer leaves it.
    function recapture() { d.moving = true; try { d.node.setPointerCapture(d.id); } catch (e) {} d.moving = false; }

    // Overflowing strip: scroll while the pointer sits near an edge.
    function autoScroll() {
      autoRaf = null;
      if (!d || !d.dragging) return;
      if (nav.scrollWidth > nav.clientWidth + 1) {
        var r = nav.getBoundingClientRect();
        var EDGE = 48, step = 0;
        if (d.lastX < r.left + EDGE) step = -Math.ceil((r.left + EDGE - d.lastX) / 5);
        else if (d.lastX > r.right - EDGE) step = Math.ceil((d.lastX - (r.right - EDGE)) / 5);
        if (step) { var was = nav.scrollLeft; nav.scrollLeft += step; if (nav.scrollLeft !== was) place(); }
      }
      autoRaf = requestAnimationFrame(autoScroll);
    }

    function arm() {
      if (!d || d.dragging) return;
      d.dragging = true;
      d.startOrder = order();
      // Grab point = where the press happened on the item, so once armed the
      // item snaps to follow the pointer exactly (not trailing by the arming
      // distance).
      var b = box(d.node);
      var p = toLocal(d.startX, d.startY);
      d.gx = p.x - b.x; d.gy = p.y - b.y;
      d.node.classList.add('vdrag');
      nav.classList.add('vdrag-live');
      document.documentElement.classList.add('vdrag-active');
      try { d.node.setPointerCapture(d.id); } catch (e) {}
      if (d.touch && navigator.vibrate) { try { navigator.vibrate(10); } catch (e) {} }
      place();
      if (!autoRaf) autoRaf = requestAnimationFrame(autoScroll);
    }

    function finish(commit) {
      if (!d) return null;
      var st = d;
      d = null;
      clearTimeout(holdTimer); holdTimer = null;
      if (frame) { cancelAnimationFrame(frame); frame = null; }
      if (autoRaf) { cancelAnimationFrame(autoRaf); autoRaf = null; }
      if (!st.dragging) return st;
      var n = st.node;
      // Settle into the slot from wherever it was let go.
      n.classList.remove('vdrag');
      n.style.transition = reduced ? 'none' : 'transform ' + SETTLE_MS + 'ms ' + EASE;
      n.style.transform = '';
      setTimeout(function () {
        n.style.transition = '';
        items().forEach(function (x) { if (!x.style.transform) x.style.transition = ''; });
        nav.classList.remove('vdrag-live');
      }, SETTLE_MS + 30);
      document.documentElement.classList.remove('vdrag-active');
      try { n.releasePointerCapture(st.id); } catch (e) {}
      // The click that follows a drop must not also activate the item.
      // Expires on its own: a touch drop often produces no click at all, and a
      // lingering swallower would eat the NEXT real tap on this item.
      function swallow(ev) { ev.stopPropagation(); ev.preventDefault(); n.removeEventListener('click', swallow, true); }
      n.addEventListener('click', swallow, true);
      setTimeout(function () { n.removeEventListener('click', swallow, true); }, 350);
      if (commit) {
        var next = order();
        if (next.join() !== st.startOrder.join()) onDrop(next);
      }
      return st;
    }

    nav.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      if (d) {
        // A live drag keeps its pointer. An un-armed leftover (a swipe the
        // browser turned into a scroll sends no move/cancel to clear it) must
        // not block the next press.
        if (d.dragging && d.id !== e.pointerId) return;
        finish(false);
      }
      var node = e.target.closest && e.target.closest(ITEM);
      if (!node || !nav.contains(node)) return;
      d = {
        node: node, id: e.pointerId, startX: e.clientX, startY: e.clientY,
        lastX: e.clientX, lastY: e.clientY, dragging: false,
        touch: e.pointerType === 'touch',
      };
      if (d.touch) holdTimer = setTimeout(function () { holdTimer = null; arm(); }, HOLD_MS);
    });

    nav.addEventListener('pointermove', function (e) {
      if (!d || e.pointerId !== d.id) return;
      d.lastX = e.clientX; d.lastY = e.clientY;
      if (!d.dragging) {
        var dx = Math.abs(e.clientX - d.startX), dy = Math.abs(e.clientY - d.startY);
        if (d.touch) { if (dx > 8 || dy > 8) finish(false); return; }   // a swipe — let it scroll
        if (dx < 5 && dy < 5) return;
        arm();
        return;
      }
      schedule();
    });

    // Non-passive so an armed drag can stop the strip (or page) scrolling.
    nav.addEventListener('touchmove', function (e) { if (d && d.dragging && e.cancelable) e.preventDefault(); }, { passive: false });
    // A long press would otherwise open the OS context menu / text selection.
    nav.addEventListener('contextmenu', function (e) { if (d) e.preventDefault(); });

    function up(e) { if (d && e.pointerId === d.id) finish(true); }
    nav.addEventListener('pointerup', up);
    nav.addEventListener('pointercancel', function (e) { if (d && e.pointerId === d.id) finish(true); });
    // Capture lost for a reason other than our own reorder (the node left the
    // DOM, the browser took the gesture): end cleanly rather than stay stuck.
    nav.addEventListener('lostpointercapture', function (e) {
      if (!d || !d.dragging || e.pointerId !== d.id) return;
      setTimeout(function () {
        if (!d || !d.dragging) return;
        var still = false; try { still = d.node.hasPointerCapture(d.id); } catch (er) {}
        if (!still && !d.node.isConnected) finish(true);
      }, 0);
    });
    window.addEventListener('blur', function () { if (d) finish(true); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !d || !d.dragging) return;
      // Escape puts everything back where it started.
      var start = d.startOrder;
      moveWithFlip(function () { applyOrder(nav, ITEM, KEY, start); });
      finish(false);
    });
  }

  // Apply a saved order to the DOM. Unknown keys are skipped, and an item the
  // saved order predates (added since) keeps its default neighbour instead of
  // piling up at the end.
  function applyOrder(nav, itemSel, keyAttr, saved) {
    if (!nav || !Array.isArray(saved) || !saved.length) return;
    var have = {};
    var nodes = Array.prototype.slice.call(nav.querySelectorAll(itemSel));
    nodes.forEach(function (n) { have[n.getAttribute(keyAttr)] = n; });
    var fresh = nodes.filter(function (n) { return saved.indexOf(n.getAttribute(keyAttr)) < 0; });
    var prevOf = {};
    fresh.forEach(function (n) { var i = nodes.indexOf(n); prevOf[n.getAttribute(keyAttr)] = i > 0 ? nodes[i - 1] : null; });
    // Already in this order? Touch nothing (no reflow, no focus loss).
    var target = saved.filter(function (k) { return have[k]; });
    var current = nodes.map(function (n) { return n.getAttribute(keyAttr); }).filter(function (k) { return saved.indexOf(k) >= 0; });
    if (target.join() === current.join()) return;
    saved.forEach(function (k) { if (have[k]) { nav.appendChild(have[k]); delete have[k]; } });
    fresh.forEach(function (n) {
      var p = prevOf[n.getAttribute(keyAttr)];
      if (p && p.parentNode === nav && p !== n) nav.insertBefore(n, p.nextSibling);
      else if (!p && nodes[0] && nodes[0] !== n) nav.insertBefore(n, nav.querySelector(itemSel));
      else nav.appendChild(n);
    });
  }

  window.VaultDrag = { enable: enable, applyOrder: applyOrder };
})();
