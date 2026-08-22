/* ============================================================================
 * warden-drag.js — reusable horizontal drag-to-reorder
 *
 * One implementation, mounted on every re-orderable strip in Warden: the tab bar
 * (#warden-tabs) and the header actions (#kc-hbar-actions). Ported from Insight's
 * nav drag so the two apps feel identical under the finger.
 *
 * Gestures, and why they differ by input:
 *   mouse — arms after 5px of movement. Precise device, no scroll to protect.
 *   touch — arms on a 320ms long press, and any real movement before that timer
 *           fires cancels it. Without this an ordinary swipe to scroll the strip
 *           would grab a tab instead, which is the single most annoying way to
 *           get this wrong on a phone.
 *
 * The strip scrolls horizontally when it overflows, so a drag near either edge
 * auto-scrolls — otherwise tabs off-screen on a phone are unreachable without
 * dropping and re-grabbing.
 *
 * Reordering is done by moving real DOM nodes and animating the displaced ones
 * with FLIP measured in LAYOUT coordinates (offsetLeft), never viewport rects:
 * scrollLeft shifts as items are reordered, and a viewport-based delta folds
 * that jump into the animation, which is what makes neighbours streak in from
 * the edges.
 *
 *   WardenDrag.enable(container, {
 *     item:    '[data-hk]',      // selector for a draggable child
 *     key:     'data-hk',        // attribute holding its stable id
 *     onDrop:  function(order){} // called with the new key order, on change only
 *   })
 *
 * enable() is idempotent per container.
 * ========================================================================== */
(function () {
  'use strict';

  function enable(nav, opts) {
    if (!nav || nav._vdragOn) return;
    nav._vdragOn = true;

    var ITEM = opts.item, KEY = opts.key;
    var onDrop = opts.onDrop || function () {};

    function items() { return Array.prototype.slice.call(nav.querySelectorAll(ITEM)); }
    function order() { return items().map(function (n) { return n.getAttribute(KEY); }); }

    var d = null, holdTimer = null, autoRaf = null;

    // FLIP the displaced element so a swap reads as motion rather than a jump.
    function flipX(mutate, node) {
      var before = node.offsetLeft;
      mutate();
      var after = node.offsetLeft;
      var dx = before - after;
      if (!dx) return;
      node.style.transition = 'none';
      node.style.transform = 'translateX(' + dx + 'px)';
      requestAnimationFrame(function () {
        node.style.transition = 'transform .16s cubic-bezier(.2,.8,.3,1)';
        node.style.transform = '';
      });
    }

    // Include the scroll delta since grab, so the dragged item stays pinned to
    // the finger even while auto-scroll is moving the strip underneath it.
    function follow(x) {
      d.node.style.transform = 'translateX(' + ((x - d.grabX) + (nav.scrollLeft - d.grabScroll)) + 'px)';
    }

    function checkSwap(x) {
      var kids = items();
      for (var i = 0; i < kids.length; i++) {
        var other = kids[i];
        if (other === d.node) continue;
        var r = other.getBoundingClientRect();
        if (x < r.left || x > r.right) continue;
        var mid = r.left + r.width / 2;
        var otherIsBefore = !!(d.node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING);
        if (x < mid && otherIsBefore) flipX(function () { nav.insertBefore(d.node, other); }, other);
        else if (x > mid && !otherIsBefore) flipX(function () { nav.insertBefore(d.node, other.nextSibling); }, other);
        else continue;
        // Re-anchor so the dragged item stays under the pointer after reflow.
        d.grabX = x;
        d.grabScroll = nav.scrollLeft;
        d.node.style.transform = 'translateX(0px)';
        break;
      }
    }

    function autoScroll() {
      if (!d || !d.dragging) { autoRaf = null; return; }
      var r = nav.getBoundingClientRect();
      var EDGE = 44, SPEED = 9, step = 0;
      if (d.lastX < r.left + EDGE) step = -SPEED;
      else if (d.lastX > r.right - EDGE) step = SPEED;
      if (step) {
        var was = nav.scrollLeft;
        nav.scrollLeft += step;
        if (nav.scrollLeft !== was) { follow(d.lastX); checkSwap(d.lastX); }
      }
      autoRaf = requestAnimationFrame(autoScroll);
    }

    function startDrag(e) {
      d.dragging = true;
      d.grabX = e.clientX;
      d.grabScroll = nav.scrollLeft;
      d.lastX = e.clientX;
      d.node.style.transition = '';          // never lag behind the finger
      d.node.classList.add('vdrag');
      try { d.node.setPointerCapture(d.id); } catch (er) {}
      if (!autoRaf) autoRaf = requestAnimationFrame(autoScroll);
    }

    function cleanup() {
      if (!d) return;
      var n = d.node;
      n.style.transition = 'transform .16s cubic-bezier(.2,.8,.3,1)';   // settle, don't snap
      n.style.transform = '';
      setTimeout(function () { n.style.transition = ''; }, 180);
      n.classList.remove('vdrag');
      clearTimeout(holdTimer); holdTimer = null;
      if (autoRaf) { cancelAnimationFrame(autoRaf); autoRaf = null; }
      d = null;
    }

    nav.addEventListener('pointerdown', function (e) {
      var node = e.target.closest(ITEM);
      if (!node || !nav.contains(node) || e.button > 0) return;
      d = { node: node, id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX,
            dragging: false, moved: false, touch: e.pointerType === 'touch' };
      if (d.touch) holdTimer = setTimeout(function () { holdTimer = null; if (d) startDrag(e); }, 320);
    });

    nav.addEventListener('pointermove', function (e) {
      if (!d || e.pointerId !== d.id) return;
      if (!d.dragging) {
        var dx = Math.abs(e.clientX - d.startX), dy = Math.abs(e.clientY - d.startY);
        if (d.touch) { if (dx > 8 || dy > 8) cleanup(); return; }   // a swipe — let it scroll
        if (dx < 5) return;
        startDrag(e);
      }
      d.moved = true;
      d.lastX = e.clientX;
      follow(e.clientX);
      checkSwap(e.clientX);
    });

    // Non-passive so an armed drag can stop the strip scrolling under the finger.
    nav.addEventListener('touchmove', function (e) { if (d && d.dragging) e.preventDefault(); }, { passive: false });

    function endDrag(e) {
      if (!d || (e && e.pointerId !== d.id)) return;
      var wasDrag = d.dragging && d.moved;
      var node = d.node;
      var before = d.startOrder;
      cleanup();
      if (!wasDrag) return;
      // Swallow the click that follows the drop — otherwise releasing over a tab
      // both reorders AND switches to it.
      node.addEventListener('click', function swallow(ev) {
        ev.stopPropagation(); ev.preventDefault();
        node.removeEventListener('click', swallow, true);
      }, true);
      var next = order();
      if (before && next.join() === before.join()) return;
      onDrop(next);
    }
    // Snapshot the order at grab time so onDrop only fires on a real change.
    nav.addEventListener('pointerdown', function () { if (d) d.startOrder = order(); });
    nav.addEventListener('pointerup', endDrag);
    nav.addEventListener('pointercancel', endDrag);
  }

  // Apply a saved order to the DOM. Unknown keys are skipped and any item the
  // saved order doesn't mention is appended, so an order written by a build with
  // more (or fewer) items can never hide one.
  function applyOrder(nav, itemSel, keyAttr, saved) {
    if (!nav || !Array.isArray(saved) || !saved.length) return;
    var have = {};
    Array.prototype.forEach.call(nav.querySelectorAll(itemSel), function (n) { have[n.getAttribute(keyAttr)] = n; });
    saved.forEach(function (k) { if (have[k]) { nav.appendChild(have[k]); delete have[k]; } });
    Object.keys(have).forEach(function (k) { nav.appendChild(have[k]); });
  }

  window.WardenDrag = { enable: enable, applyOrder: applyOrder };
})();
