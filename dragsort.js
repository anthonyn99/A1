/* dragsort.js — MAGI's drag to reorder, for every A1 program (window.A1Drag).
 *
 * A port of magi.html's dragSort / dragGrip / dropOrder / dragRefocus and its
 * CSS (theme overhaul, docs/theme-overhaul-plan.md §2 "Drag and drop"), plus
 * what A1 needs and MAGI never did: a horizontal or wrapping-grid axis, a
 * touch hold for rows without a grip (chip rows), and moves between lists that
 * share a `group`.
 *
 * Pointer events, so mouse, touch and pen are one code path. The lifted row
 * follows the pointer with a transform only -- nothing is laid out while you
 * drag, which is what keeps it smooth -- and the rows it passes slide out of
 * its way; on release it glides into its slot and onDrop runs once, for the
 * caller to redraw. On touch only the grip starts a drag (or, with `hold`, a
 * press held still that long), so the list still scrolls under a finger; a
 * mouse can also take the row by any part that is not a control inside it.
 * The grip is a real button: focus it and the arrow keys move the row.
 *
 *   A1Drag.sort(list, {
 *     row,                 selector for the rows: DIRECT children of `list`
 *     grip,                selector for the grips (default ".dsort-grip")
 *     axis,                "y" (default), "x", or "grid" (wrapping rows)
 *     hold,                ms a touch must stay still on a row with no grip
 *                          to pick it up (0 = grip only; chip rows use 300)
 *     group,               lists with the same group take each other's rows
 *     canDrag(row),        false leaves a row where it is
 *     ignore,              selector for parts of a row a press never drags
 *                          (an open row's body, so its text stays selectable)
 *     onDrop(from, to, fromList, toList),
 *                          indexes in the rows as drawn; called only when
 *                          something moved (a same-list drop has to != from)
 *     onKey(row, dir),     a focused grip's arrow key, dir -1 / +1
 *   })
 *   A1Drag.grip(label)     a grip button (⋮⋮) with that aria-label
 *   A1Drag.order(orders, from, to, step)
 *                          a moved row's new order number: the midpoint of its
 *                          new neighbours, so only that row changes (synced lists)
 *   A1Drag.refocus(list, key)
 *                          focus the grip of the row with data-dkey=key again
 *                          after a redraw (keyboard moves)
 *   A1Drag.active          true while a row is lifted or gliding
 *   A1Drag.later(fn)       run fn when the current drag has finished (or now):
 *                          a redraw must never land under a drag
 *
 * Colours come from --ds-ac / --ds-s2 / --ds-tx / --ds-txm / --ds-shadow, with
 * MAGI's values as the fallbacks, so a program can tint it.
 */
(function () {
  'use strict';
  if (window.A1Drag) return;

  var HOLD_PX = 4;          // movement before a mouse press becomes a drag
  var TOUCH_SLOP = 8;       // movement that turns a touch hold into a scroll
  var SETTLE_MS = 170;      // the glide into place; matches the CSS
  var EDGE = 48;            // auto-scroll zone at a scroller's edges
  var CONTROLS = 'button, a, input, select, textarea, [contenteditable]';

  var state = { active: false, pending: [] };
  var groups = {};          // group name -> [{ list, o }]

  var CSS = [
    '.dsort > * { transition: transform .17s cubic-bezier(.2, .8, .2, 1); }',
    // !important: themed rows carry their own `transition: all` and inline
    // backgrounds, and a lifted row that eases after the pointer lags behind it.
    '.dsort-drag {',
    '  transition: none !important; position: relative; z-index: 5 !important; cursor: grabbing !important;',
    '  box-shadow: 0 10px 28px -8px var(--ds-shadow, rgba(0,0,0,.55)), 0 0 0 1px color-mix(in srgb, var(--ds-ac, #c0aeea) 55%, transparent) !important;',
    '  background: var(--ds-s2, #2c2c31) !important;',
    // The lifted row is always on s2, so its label must be light: a selected
    // chip's dark-on-accent label would otherwise go black on charcoal.
    '  color: var(--ds-tx, #f4f3f0) !important;',
    '}',
    '.dsort-drag.dsort-chip { scale: 1.06; }',
    '.dsort-settle { transition: transform .17s cubic-bezier(.2, .8, .2, 1), box-shadow .17s, scale .17s !important; }',
    '.dsort-on > :not(.dsort-drag) { pointer-events: none; }',
    'html.dsort-grabbing, html.dsort-grabbing * { cursor: grabbing !important; -webkit-user-select: none !important; user-select: none !important; }',
    '.dsort-grip {',
    '  flex: 0 0 auto; width: 28px; height: 36px; margin: -4px 0 -4px -4px; padding: 0;',
    '  display: inline-flex; align-items: center; justify-content: center;',
    '  background: none; border: 0; border-radius: 7px; color: var(--ds-txm, #8d8d94); fill: currentColor;',
    '  cursor: grab; touch-action: none;',
    '}',
    '.dsort-grip:hover, .dsort-grip:focus-visible { color: var(--ds-tx, #f4f3f0); background: var(--ds-s2, #2c2c31); outline: none; }',
    '.dsort-grip:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ds-ac, #c0aeea) 60%, transparent); }',
    '.dsort-grip[hidden] { display: inline-flex; visibility: hidden; }',
    '@media (prefers-reduced-motion: reduce) {',
    '  .dsort > *, .dsort-settle { transition: none !important; }',
    '}'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('a1-dragsort-css')) return;
    var st = document.createElement('style');
    st.id = 'a1-dragsort-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /** The new order number for a row moved from `from` to `to` among rows whose
   *  order numbers are `orders` (sorted): the midpoint of its new neighbours,
   *  so only the moved row changes -- what keeps a synced list's merge simple. */
  function order(orders, from, to, step) {
    if (step === undefined) step = 1000;
    var rest = orders.filter(function (_, i) { return i !== from; });
    var prev = rest[to - 1], next = rest[to];
    if (prev !== undefined && next !== undefined) return (prev + next) / 2;
    if (prev !== undefined) return prev + step;
    if (next !== undefined) return next - step;
    return orders[from];
  }

  /** A grip: the handle a finger can drag, and the focus stop the arrows act on. */
  function grip(label) {
    var g = document.createElement('button');
    g.className = 'dsort-grip';
    g.type = 'button';
    g.setAttribute('aria-label', label);
    g.title = 'Drag to reorder (or focus and press the arrow keys)';
    g.innerHTML = '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">'
      + '<circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/>'
      + '<circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/>'
      + '<circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';
    return g;
  }

  /** Focus a row's grip again after the list was redrawn (keyboard moves). */
  function refocus(list, key) {
    requestAnimationFrame(function () {
      var r = list.querySelector('[data-dkey="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
      var g = r && r.querySelector('.dsort-grip');
      if (g) g.focus();
    });
  }

  function later(fn) {
    if (state.active) state.pending.push(fn); else fn();
  }

  function rowsOf(list, sel) {
    return Array.prototype.filter.call(list.children, function (n) { return n.matches(sel); });
  }

  function sort(list, o) {
    o = Object.assign({ grip: '.dsort-grip', axis: 'y', hold: 0, canDrag: function () { return true; } }, o || {});
    if (list._a1drag) { list._a1drag.o = o; return; }   // re-wired: new options, same listeners
    var me = { list: list, o: o };
    list._a1drag = me;
    injectCss();
    list.classList.add('dsort');
    // A page that redraws its lists registers new ones every render; the old
    // ones leave the group as they leave the page.
    if (o.group) {
      groups[o.group] = (groups[o.group] || []).filter(function (g) { return g.list.isConnected; });
      groups[o.group].push(me);
    }

    var keys = me.o.axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    list.addEventListener('keydown', function (e) {
      var ko = me.o;
      var dir = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0;
      if (!ko.onKey || !dir || (ko.axis !== 'grid' && keys.indexOf(e.key) < 0)) return;
      var g = e.target.closest(ko.grip);
      var r = g && g.closest(ko.row);
      if (!r || !list.contains(r) || !ko.canDrag(r)) return;
      e.preventDefault();
      ko.onKey(r, dir);
    });

    // Only while actually dragging, so a plain swipe still scrolls.
    list.addEventListener('touchmove', function (e) {
      if (state.active && e.cancelable) e.preventDefault();
    }, { passive: false });

    list.addEventListener('pointerdown', function (e) {
      var po = me.o;
      if (state.active || e.a1DragClaimed || (e.pointerType === 'mouse' && e.button !== 0)) return;
      var r = e.target.closest(po.row);
      if (!r || r.parentElement !== list || !po.canDrag(r)) return;
      // A list inside a row of another list (links inside a card): the
      // innermost list that takes the press keeps it.
      e.a1DragClaimed = true;
      var ig = po.ignore && e.target.closest(po.ignore);
      if (ig && r.contains(ig)) return;
      if (!e.target.closest(po.grip)) {
        // A press on a control inside the row is that control's (the row
        // itself may be a button: a nav button is its own handle).
        var c = e.target.closest(CONTROLS);
        if (c && c !== r && r.contains(c)) return;
        if (e.pointerType !== 'mouse') {
          // A finger anywhere but the grip is scrolling -- unless the row has
          // no grip and opted into a hold.
          if (!po.hold || r.querySelector(po.grip)) return;
          return holdThenBegin(e, r);
        }
        // Or the first pixels of a drag start selecting the row's text.
        e.preventDefault();
      }
      begin(e, r, false);
    });

    function holdThenBegin(e, r) {
      var x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
      var t = setTimeout(function () { done(); begin(e, r, true); }, me.o.hold);
      function mv(ev) {
        if (ev.pointerId !== pid) return;
        if (Math.abs(ev.clientX - x0) > TOUCH_SLOP || Math.abs(ev.clientY - y0) > TOUCH_SLOP) { clearTimeout(t); done(); }
      }
      function end(ev) { if (ev.pointerId === pid) { clearTimeout(t); done(); } }
      function done() {
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      }
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    }

    // What scrolls under a drag: the list itself when it is the scroller (a
    // tab strip), else the nearest scrolling ancestor, else the page.
    function scroller(n, axis) {
      for (var p = n; p; p = p.parentElement) {
        var cs = getComputedStyle(p);
        var s = axis === 'x' ? cs.overflowX : cs.overflowY;
        var big = axis === 'x' ? p.scrollWidth > p.clientWidth : p.scrollHeight > p.clientHeight;
        if ((s === 'auto' || s === 'scroll') && big) return p;
      }
      return document.scrollingElement || document.documentElement;
    }

    // Boxes relative to the list's CONTENT (its own scroll added back), so
    // scrolling mid-drag -- the page's or the list's own -- cannot skew them.
    function measure(l, sel) {
      var rs = rowsOf(l, sel);
      var lb = l.getBoundingClientRect();
      var bx = rs.map(function (r) {
        var b = r.getBoundingClientRect();
        return { x: b.left - lb.left + l.scrollLeft, y: b.top - lb.top + l.scrollTop, w: b.width, h: b.height };
      });
      return { list: l, rows: rs, boxes: bx };
    }

    function begin(e, row, held) {
      var ax = me.o.axis, grid = ax === 'grid', X = ax === 'x';
      var P = X ? 'x' : 'y', S = X ? 'w' : 'h';
      var src = measure(list, me.o.row);
      var rows = src.rows, boxes = src.boxes;
      var from = rows.indexOf(row);
      var n = rows.length;
      var gap = function (bx) {
        return bx.length > 1 ? Math.max(0, bx[1][P] - (bx[0][P] + bx[0][S])) : 0;
      };
      var shift = boxes[from][S] + gap(boxes);
      var lb0 = list.getBoundingClientRect();
      var px0 = e.clientX - lb0.left + list.scrollLeft, py0 = e.clientY - lb0.top + list.scrollTop;   // pointer, in list content
      var pid = e.pointerId, touch = e.pointerType !== 'mouse';
      var sc = scroller(list, X ? 'x' : 'y');
      var live = false, to = from, lastX = e.clientX, lastY = e.clientY, raf = 0, cancelled = false;
      var tgt = null, tTo = 0;     // cross-list: the list hovered and the slot in it

      var coord = function (b) { return { x: b.x, y: b.y }; };
      var pos1 = function (r, v) { return X ? 'translate3d(' + v + 'px, 0, 0)' : 'translate3d(0, ' + v + 'px, 0)'; };
      var pos2 = function (dx, dy) { return 'translate3d(' + dx + 'px, ' + dy + 'px, 0)'; };

      // Where the dragged row would sit, list-relative, unclamped.
      var drag = function () {
        var lb = list.getBoundingClientRect();
        return { dx: (lastX - lb.left + list.scrollLeft) - px0, dy: (lastY - lb.top + list.scrollTop) - py0 };
      };

      var groupLists = function () {
        return me.o.group ? (groups[me.o.group] || []).filter(function (g) { return g.list !== list && g.list.isConnected; }) : [];
      };
      var over = function () {
        var gl = groupLists();
        for (var i = 0; i < gl.length; i++) {
          var b = gl[i].list.getBoundingClientRect();
          if (lastX >= b.left && lastX <= b.right && lastY >= b.top && lastY <= b.bottom) return gl[i];
        }
        return null;
      };

      // Same-list placement: MAGI's, along the axis; nearest slot in a grid.
      var placeHome = function () {
        var d = drag(), t = from;
        if (grid) {
          row.style.transform = pos2(d.dx, d.dy);
          var cx = boxes[from].x + boxes[from].w / 2 + d.dx, cy = boxes[from].y + boxes[from].h / 2 + d.dy, best = Infinity;
          boxes.forEach(function (b, i) {
            var dd = Math.pow(b.x + b.w / 2 - cx, 2) + Math.pow(b.y + b.h / 2 - cy, 2);
            if (dd < best) { best = dd; t = i; }
          });
        } else {
          var lo = boxes[0][P] - boxes[from][P];
          var hi = boxes[n - 1][P] + boxes[n - 1][S] - (boxes[from][P] + boxes[from][S]);
          var v = Math.max(lo, Math.min(hi, X ? d.dx : d.dy));
          row.style.transform = pos1(row, v);
          // A neighbour gives way once the dragged row's LEADING edge passes
          // its middle -- by the dragged row's own middle, the first and last
          // slots were out of reach at the list's clamped ends.
          var lead = boxes[from][P] + v, trail = lead + boxes[from][S];
          for (var i = 0; i < from; i++) if (lead < boxes[i][P] + boxes[i][S] / 2) { t = i; break; }
          if (t === from) for (var j = n - 1; j > from; j--) if (trail > boxes[j][P] + boxes[j][S] / 2) { t = j; break; }
        }
        if (t !== to || tgt) {
          to = t;
          rows.forEach(function (r, i) {
            if (r === row) return;
            if (grid) {
              var k = from < to && i > from && i <= to ? i - 1 : from > to && i >= to && i < from ? i + 1 : i;
              r.style.transform = k === i ? '' : pos2(boxes[k].x - boxes[i].x, boxes[k].y - boxes[i].y);
            } else {
              var s = from < to && i > from && i <= to ? -shift : from > to && i >= to && i < from ? shift : 0;
              r.style.transform = s ? pos1(r, s) : '';
            }
          });
        }
      };

      // The slot a row would take in another list, and where it is (list-relative).
      var slotIn = function (m, cx, cy) {
        var bx = m.boxes, k = bx.length;
        if (grid) {
          var best = Infinity;
          bx.forEach(function (b, i) {
            var dd = Math.pow(b.x + b.w / 2 - cx, 2) + Math.pow(b.y + b.h / 2 - cy, 2);
            if (dd < best) { best = dd; k = (X ? cx : cx) > b.x + b.w / 2 && i === bx.length - 1 ? i + 1 : i; }
          });
          return k;
        }
        for (var i = 0; i < bx.length; i++) if ((X ? cx : cy) < bx[i][P] + bx[i][S] / 2) return i;
        return bx.length;
      };
      var slotPos = function (m, k) {
        var bx = m.boxes;
        if (k < bx.length) return coord(bx[k]);
        if (!bx.length) {
          // An empty list: under whatever it already holds (a group's header).
          var kids = m.list.children, lastKid = kids[kids.length - 1];
          if (lastKid) {
            var kb = lastKid.getBoundingClientRect(), mb = m.list.getBoundingClientRect();
            return X ? { x: kb.right - mb.left + m.list.scrollLeft + (parseFloat(getComputedStyle(lastKid).marginRight) || 0), y: kb.top - mb.top + m.list.scrollTop }
              : { x: kb.left - mb.left + m.list.scrollLeft, y: kb.bottom - mb.top + m.list.scrollTop + (parseFloat(getComputedStyle(lastKid).marginBottom) || 0) };
          }
          var cs = getComputedStyle(m.list);
          return { x: parseFloat(cs.paddingLeft) || 0, y: parseFloat(cs.paddingTop) || 0 };
        }
        var last = bx[bx.length - 1], g = gap(bx) || 0;
        return X || grid ? { x: last.x + last.w + g, y: last.y } : { x: last.x, y: last.y + last.h + g };
      };

      var placeAway = function (g) {
        if (!tgt || tgt.list !== g.list) {
          clearTarget();
          tgt = measure(g.list, g.o.row);
          tgt.o = g.o;
          tgt.list.classList.add('dsort-on');
          // The source closes the gap the row left.
          rows.forEach(function (r, i) {
            if (r === row) return;
            if (grid) r.style.transform = i > from ? pos2(boxes[i - 1].x - boxes[i].x, boxes[i - 1].y - boxes[i].y) : '';
            else r.style.transform = i > from ? pos1(r, -shift) : '';
          });
          to = -1;
        }
        var d = drag();
        row.style.transform = pos2(d.dx, d.dy);
        var tb = tgt.list.getBoundingClientRect();
        var cx = lastX - tb.left + tgt.list.scrollLeft, cy = lastY - tb.top + tgt.list.scrollTop;
        var k = slotIn(tgt, cx, cy);
        if (k === tTo && tgt._placed) return;
        tTo = k; tgt._placed = true;
        var ts = boxes[from][S] + (gap(tgt.boxes) || gap(boxes));
        tgt.rows.forEach(function (r, i) {
          if (i < k) { r.style.transform = ''; return; }
          if (grid) {
            var nx = i + 1 < tgt.boxes.length ? tgt.boxes[i + 1] : slotPos(tgt, tgt.boxes.length);
            r.style.transform = pos2(nx.x - tgt.boxes[i].x, nx.y - tgt.boxes[i].y);
          } else r.style.transform = pos1(r, ts);
        });
      };
      var clearTarget = function () {
        if (!tgt) return;
        tgt.rows.forEach(function (r) { r.style.transform = ''; });
        tgt.list.classList.remove('dsort-on');
        tgt = null; tTo = 0;
      };

      var place = function () {
        var g = over();
        if (g) return placeAway(g);
        if (tgt) { clearTarget(); to = -1; }
        placeHome();
      };

      // Near the edges of what scrolls, scroll -- a long list on a phone is
      // taller than the screen.
      var edge = function () {
        raf = 0;
        if (!live) return;
        var root = sc === document.scrollingElement || sc === document.documentElement;
        var b = root ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth } : sc.getBoundingClientRect();
        var p = X ? lastX : lastY, lo = X ? b.left : b.top, hi = X ? b.right : b.bottom;
        var v = p < lo + EDGE ? -(lo + EDGE - p) : p > hi - EDGE ? p - (hi - EDGE) : 0;
        if (v) {
          var step = Math.max(-16, Math.min(16, v / 3));
          if (X) sc.scrollLeft += step; else sc.scrollTop += step;
          place();
          raf = requestAnimationFrame(edge);
        }
      };
      var start = function () {
        live = true;
        state.active = true;
        row.classList.add('dsort-drag');
        if (me.o.axis !== 'y') row.classList.add('dsort-chip');
        list.classList.add('dsort-on');
        document.documentElement.classList.add('dsort-grabbing');
        try { row.setPointerCapture(pid); } catch (err) {}
        if (touch && navigator.vibrate) { try { navigator.vibrate(held ? 12 : 8); } catch (err) {} }
      };
      var move = function (ev) {
        if (ev.pointerId !== pid) return;
        lastX = ev.clientX; lastY = ev.clientY;
        if (!live) {
          var lb = list.getBoundingClientRect();
          var dd = Math.max(Math.abs(ev.clientX - (px0 - list.scrollLeft + lb.left)), Math.abs(ev.clientY - (py0 - list.scrollTop + lb.top)));
          if (dd < HOLD_PX) return;
          start();
        }
        ev.preventDefault();
        place();
        if (!raf) raf = requestAnimationFrame(edge);
      };
      // Escape puts the row back -- and is used up doing it, or the sheet the
      // list sits in would close too.
      var key = function (ev) {
        if (ev.key !== 'Escape' || !live) return;
        ev.stopPropagation();
        ev.preventDefault();
        cancelled = true;
        up(ev);
      };
      var up = function (ev) {
        if (ev.pointerId !== undefined && ev.pointerId !== pid) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        window.removeEventListener('keydown', key, true);
        if (raf) cancelAnimationFrame(raf);
        if (!live) return;                                  // a click, not a drag
        if (ev.type === 'pointercancel') cancelled = true;
        if (cancelled) { clearTarget(); to = from; }
        // The click a drag's release may fire is not a click on the row. Only
        // that one: released on the next tick, or a drag ending off the row
        // (no click at all) would eat your next real click.
        var swallow = function (c) { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener('click', swallow, true);
        setTimeout(function () { window.removeEventListener('click', swallow, true); }, 0);
        // Into its slot: relative to its own place in the list, which moves
        // with the list if it scrolled meanwhile.
        var cross = !!tgt, land;
        if (cross) {
          var sp = slotPos(tgt, tTo);
          var tb = tgt.list.getBoundingClientRect(), lb = list.getBoundingClientRect();
          land = pos2(sp.x - tgt.list.scrollLeft + tb.left - (boxes[from].x - list.scrollLeft + lb.left),
            sp.y - tgt.list.scrollTop + tb.top - (boxes[from].y - list.scrollTop + lb.top));
        } else if (grid) {
          land = to === from || to < 0 ? '' : pos2(boxes[to].x - boxes[from].x, boxes[to].y - boxes[from].y);
        } else {
          var v = to === from || to < 0 ? 0 : to > from
            ? (boxes[to][P] + boxes[to][S]) - (boxes[from][P] + boxes[from][S])
            : boxes[to][P] - boxes[from][P];
          land = pos1(row, v);
        }
        if (to < 0 && !cross) to = from;
        row.classList.add('dsort-settle');
        row.classList.remove('dsort-chip');
        row.style.transform = land || '';
        if (!cross && to === from) rows.forEach(function (r) { if (r !== row) r.style.transform = ''; });
        var tl = cross ? tgt : null, tk = tTo, onDrop = me.o.onDrop;
        setTimeout(function () {
          rows.forEach(function (r) { r.style.transform = ''; r.classList.remove('dsort-drag', 'dsort-settle', 'dsort-chip'); });
          if (tl) { tl.rows.forEach(function (r) { r.style.transform = ''; }); tl.list.classList.remove('dsort-on'); }
          list.classList.remove('dsort-on');
          document.documentElement.classList.remove('dsort-grabbing');
          state.active = false;
          try {
            if (tl) { if (onDrop) onDrop(from, tk, list, tl.list); }
            else if (to !== from && onDrop) onDrop(from, to, list, list);
          } finally {
            var q = state.pending.splice(0);
            q.forEach(function (fn) { try { fn(); } catch (err) { console.error(err); } });
          }
        }, SETTLE_MS);
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      window.addEventListener('keydown', key, true);
      // A hold has already waited out its threshold: it is a drag now.
      if (held) start();
    }
  }

  window.A1Drag = {
    sort: sort, grip: grip, order: order, refocus: refocus, later: later,
    get active() { return state.active; }
  };
})();
