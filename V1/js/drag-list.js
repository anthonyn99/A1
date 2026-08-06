// ── Shared MotionCore-style pointer-event drag-to-reorder ──────────────────────
// thDragList(listEl, getArr, setArr, onDrop, accentColor, placeholderClass, ghostParentEl)
// Works for both mouse and touch via Pointer Events API — no separate touch handlers needed.
// Ported verbatim from TradeBoard/index.html (window.thDragList).
window.thDragList = function(listEl, getArr, setArr, onDrop, accentColor, placeholderClass, ghostParentEl) {
  if (!listEl) return;
  // Cancel any previous listener on this element without touching the DOM
  if (listEl._thDragAbort) { listEl._thDragAbort.abort(); }
  var controller = new AbortController();
  listEl._thDragAbort = controller;
  var c = listEl;

  c.addEventListener('pointerdown', function(e) {
    var handle = e.target.closest('.th-drag-handle');
    if (!handle) return;
    var item = handle.closest('[data-id]');
    if (!item || !c.contains(item)) return;
    e.preventDefault();

    var ac = accentColor || 'var(--ms-ac,#e0b874)';
    var rect = item.getBoundingClientRect();
    var offsetY = e.clientY - rect.top;
    var offsetX = e.clientX - rect.left;

    // Placeholder holds the space while item is flying
    var ph = document.createElement('div');
    ph.className = placeholderClass || 'th-drag-placeholder';
    ph.style.height = rect.height + 'px';
    ph.style.width = rect.width + 'px';
    ph.style.marginBottom = getComputedStyle(item).marginBottom;
    ph.style.marginTop = getComputedStyle(item).marginTop;
    ph.style.flexShrink = '0';

    // Ghost: real clone, fixed-position, slightly rotated + shadow ring.
    // Re-resolved HERE from `c` every time, ignoring any ghostParentEl the
    // caller passed at setup time — some callers build a list off-DOM and
    // wire thDragList before attaching it, so a scope lookup done then
    // returns document.body (a real, non-null element) and gets silently
    // locked in. A pointerdown can only fire on an already-attached,
    // rendered element, so `c` is guaranteed live at THIS point even when
    // it wasn't at setup, which callers can't know in advance — resolving
    // late is the only way this is ever reliably correct.
    var parent = c.closest('#study-root, .sos-modal') || document.body;
    var ghost = item.cloneNode(true);
    ghost.style.cssText = [
      'position:fixed',
      'left:' + rect.left + 'px',
      'top:' + rect.top + 'px',
      'width:' + rect.width + 'px',
      'margin:0',
      'pointer-events:none',
      'z-index:9999',
      'opacity:0.97',
      'transform:rotate(1.2deg) scale(1.012)',
      'box-shadow:0 12px 36px rgba(0,0,0,.55),0 0 0 1.5px ' + ac,
      'transition:none',
      'will-change:left,top',
      'border-radius:inherit',
    ].join(';');

    item.replaceWith(ph);
    parent.appendChild(ghost);
    c.setPointerCapture && c.setPointerCapture(e.pointerId);

    function isHeader(el) {
      return !el.dataset.id; // section labels and divider lines have no data-id
    }

    // A multi-column grid (module-card grids: repeat(auto-fill, minmax(...))) can
    // have two [data-id] siblings sharing the same row, side by side. The plain
    // vertical midpoint check below only compares clientY, so on a grid it can't
    // tell "drop before the card to the left" from "drop before the card to the
    // right" of the same row — it always resolves to whichever comes first in DOM
    // order once Y matches, silently ignoring X. Detect a grid once (before any
    // reflow the drag itself causes) by checking for two data-id items whose rows
    // vertically overlap, and switch the move handler to 2D nearest-neighbor.
    var isGrid = (function() {
      var real = Array.from(c.children).filter(function(el) { return el !== ph && el.dataset.id; });
      for (var gi = 0; gi < real.length - 1; gi++) {
        var a = real[gi].getBoundingClientRect(), b = real[gi + 1].getBoundingClientRect();
        if (a.top < b.bottom && b.top < a.bottom) return true; // rows overlap vertically -> same row
      }
      return false;
    })();

    function onMove(ev) {
      ghost.style.left = (ev.clientX - offsetX) + 'px';
      ghost.style.top  = (ev.clientY - offsetY) + 'px';

      if (isGrid) {
        onMoveGrid(ev);
      } else {
        onMoveList(ev);
      }
    }

    // Single-column list: original vertical-midpoint sweep (unchanged behavior).
    function onMoveList(ev) {
      var allChildren = Array.from(c.children).filter(function(el){ return el !== ph; });
      var placed = false;
      var seenItem = false; // have we passed at least one real [data-id] item?

      for (var i = 0; i < allChildren.length; i++) {
        var child = allChildren[i];
        var r = child.getBoundingClientRect();

        if (ev.clientY < r.top + r.height / 2) {
          if (isHeader(child)) {
            if (!seenItem) {
              // Above the very first category — clamp to first real item after headers
              var next = i + 1;
              while (next < allChildren.length && isHeader(allChildren[next])) next++;
              if (next < allChildren.length) {
                c.insertBefore(ph, allChildren[next]);
              } else {
                c.appendChild(ph);
              }
            } else {
              // Pointer is above a section header but after real items —
              // insert BEFORE the header block (= end of previous section)
              // Walk back to find the start of this header block
              var blockStart = i;
              while (blockStart > 0 && isHeader(allChildren[blockStart - 1])) blockStart--;
              c.insertBefore(ph, allChildren[blockStart]);
            }
          } else {
            c.insertBefore(ph, child);
          }
          placed = true;
          break;
        }

        if (!isHeader(child)) seenItem = true;
      }

      if (!placed) {
        c.appendChild(ph);
      }
    }

    // Multi-column grid: find the nearest real item by straight-line distance
    // from the pointer to each item's center, then insert before/after it
    // depending on which side of that item's center the pointer is on — this
    // is what correctly distinguishes "drop in this row, left card" from
    // "drop in this row, right card" that a Y-only check cannot.
    //
    // CSS Grid snaps every sibling to its new cell the instant the DOM order
    // changes, so without help every card the placeholder passes jump-cuts to
    // its new spot — this is the "awkward" feel on a grid (a single-column
    // list doesn't have the same problem: cards only ever shift by one row-
    // height, a much smaller, less jarring jump). FLIP-animate the real cards
    // on every reorder: read each one's position before the DOM move (First),
    // let the move happen (Last), then transform each card from where it WAS
    // to where it now IS and transition that back to identity (Invert+Play),
    // so cards glide into their new slot instead of snapping.
    function flip(mutate) {
      var real = Array.from(c.children).filter(function(el) { return el !== ph && el.dataset.id; });
      var before = new Map();
      real.forEach(function(el) { before.set(el, el.getBoundingClientRect()); });

      mutate();

      real.forEach(function(el) {
        var b = before.get(el);
        var a = el.getBoundingClientRect();
        var dx = b.left - a.left, dy = b.top - a.top;
        if (!dx && !dy) return;
        el.style.willChange = 'transform';
        el.style.transition = 'none';
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        // Force layout so the browser commits the pre-transform position
        // before the transition below is allowed to animate away from it.
        el.getBoundingClientRect();
        el.style.transition = 'transform 0.22s cubic-bezier(.2,.8,.2,1)';
        el.style.transform = '';
        el.addEventListener('transitionend', function te() {
          el.style.transition = '';
          el.style.willChange = '';
          el.removeEventListener('transitionend', te);
        });
      });
    }

    function onMoveGrid(ev) {
      var real = Array.from(c.children).filter(function(el) { return el !== ph && el.dataset.id; });
      if (real.length === 0) { c.appendChild(ph); return; }

      var nearest = null, nearestDist = Infinity;
      for (var i = 0; i < real.length; i++) {
        var r = real[i].getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var dist = Math.pow(ev.clientX - cx, 2) + Math.pow(ev.clientY - cy, 2);
        if (dist < nearestDist) { nearestDist = dist; nearest = real[i]; }
      }
      var nr = nearest.getBoundingClientRect();
      var insertAfter = ev.clientX > nr.left + nr.width / 2;
      var target = insertAfter ? nearest.nextSibling : nearest;
      if (target === ph) return; // already there, avoid needless reflow

      flip(function() { c.insertBefore(ph, target); });
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);

      ph.replaceWith(item);
      ghost.remove();

      // Reorder array to match new DOM order
      var newOrder = Array.from(c.querySelectorAll('[data-id]')).map(function(el){ return el.dataset.id; });
      var arr = getArr();
      var sorted = newOrder.map(function(id){ return arr.find(function(x){ return x.id === id; }); }).filter(Boolean);
      var missing = arr.filter(function(x){ return !newOrder.includes(x.id); });
      setArr(sorted.concat(missing));
      if (onDrop) onDrop();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }, { signal: controller.signal });
};
