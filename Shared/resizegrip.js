/* resizegrip.js — MAGI's corner resize grip, for every A1 program (window.A1Resize).
 *
 * Began as a port of magi.html's own prompt-box grip and its CSS (theme
 * overhaul, docs/Theme/theme-overhaul-plan.md §2 "Resize handles"); since phase 11
 * MAGI loads this file too, so it is the one copy. It replaces the
 * native `resize:` corner, which is ~14px on a desktop and absent on a phone.
 *
 * The grip is a real button pinned over the box's bottom-right corner: 38px
 * of invisible hit area under a small two-stroke hatch. Drag it (3px or more)
 * and the box takes that height, between 26px and max(160px, 60% of the
 * viewport). A click does nothing: it used to toggle expand / compress, and a
 * drag that barely moved kept snapping the box (Tony, 2026-10-14). Enter /
 * Space on it still toggle, so a keyboard can resize: a box at its natural
 * height expands (+120px, at least 260px); a box sized by hand goes back to
 * auto. A hand-chosen height overrides the box's own CSS min- and
 * max-height, so the drag never stops halfway, and is remembered per box in
 * localStorage.
 *
 *   A1Resize.grip(label)    the grip button, aria-label "Resize <label>"
 *   A1Resize.attach(box, grip, key, onAuto)
 *                           wire a grip to a box. `key` names the stored
 *                           height ("a1.h.<key>"; none = not stored). onAuto
 *                           runs when the box is handed back to auto, for a
 *                           box that sizes itself to its content.
 *   A1Resize.cap()          the current height ceiling
 *   A1Resize.edges(box, o)  resize from every edge and corner (see below and
 *                           docs/Shared/resizegrip.md)
 *
 * The box's parent must be positioned (the grip is absolute). A hand-sized box
 * carries data-user-h, so an auto-grow routine can leave it alone.
 * Colours come from --ds-ac / --ds-tx / --ds-txd with MAGI's values as the
 * fallbacks, the same tint variables as dragsort.js.
 */
(function () {
  'use strict';
  if (window.A1Resize) return;

  var MIN = 26;
  var DRAG_PX = 3;
  var STORE = 'a1.h.';

  var CSS = [
    '.a1-grip {',
    '  position: absolute; right: 0; bottom: 0; z-index: 3;',
    '  width: 38px; height: 38px; padding: 0; margin: 0;',
    '  background: transparent; border: 0; border-radius: 0 0 8px 0;',
    '  color: var(--ds-txd, #adadb2); cursor: nwse-resize; touch-action: none;',
    '  display: block; transition: color .15s;',
    '}',
    // Two diagonal strokes, bottom-right, like the native handle.
    '.a1-grip::before {',
    '  content: ""; position: absolute; right: 7px; bottom: 7px; width: 11px; height: 11px;',
    '  background:',
    '    linear-gradient(135deg, transparent 45%, currentColor 45%, currentColor 55%, transparent 55%) no-repeat right bottom / 11px 11px,',
    '    linear-gradient(135deg, transparent 45%, currentColor 45%, currentColor 55%, transparent 55%) no-repeat right bottom / 6px 6px;',
    '}',
    '.a1-grip:hover, .a1-grip:focus-visible { color: var(--ds-tx, #f4f3f0); }',
    '.a1-grip.on, .a1-grip:active { color: var(--ds-ac, #c0aeea); }',
    '.a1-grip:focus-visible { outline: 1px solid var(--ds-ac, #c0aeea); outline-offset: -4px; border-radius: 8px; }',
    // The grip draws the corner now; the native one would be a second handle.
    '.a1-grip-box { resize: none !important; }'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('a1-resizegrip-css')) return;
    var s = document.createElement('style');
    s.id = 'a1-resizegrip-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function cap() { return Math.max(160, Math.round(window.innerHeight * 0.6)); }

  // Veda's Brave throws on every storage call; a grip must still work there.
  function load(key) {
    try { return parseInt(window.localStorage.getItem(STORE + key) || '', 10); } catch (e) { return NaN; }
  }
  function save(key, h) {
    try {
      if (h) window.localStorage.setItem(STORE + key, String(h));
      else window.localStorage.removeItem(STORE + key);
    } catch (e) {}
  }

  function grip(label) {
    injectCss();
    var g = document.createElement('button');
    g.type = 'button';
    g.className = 'a1-grip';
    g.title = 'Drag to resize.';
    g.setAttribute('aria-label', 'Resize ' + (label || 'the box'));
    // Only the strokes answer the cursor (they light up, see the CSS). Without
    // this, index.html's "every button glows on hover" rule drew a 38px ring
    // around the whole hit area (Tony, 2026-10-15).
    g.setAttribute('data-noglow', '');
    return g;
  }

  function attach(box, g, key, onAuto) {
    if (!box || !g) return;
    injectCss();
    box.classList.add('a1-grip-box');
    // scrollbar.js reads this to end the box's bar above the grip.
    box.__a1Grip = g;

    // A hand-chosen height overrides the box's own CSS min- and max-height
    // (MAGI lifts its 45vh cap for the same reason): otherwise the drag stops
    // halfway and the grip looks broken. Handing back to auto restores both.
    var apply = function (h) {
      box.style.height = h ? h + 'px' : '';
      box.style.maxHeight = h ? h + 'px' : '';
      box.style.minHeight = h ? h + 'px' : '';
      if (h) box.setAttribute('data-user-h', String(h));
      else box.removeAttribute('data-user-h');
      g.classList.toggle('on', !!h);
      if (key) save(key, h);
      if (!h && onAuto) onAuto();
    };

    // A height chosen on an earlier visit is still the height that was wanted.
    if (key) {
      var saved = load(key);
      if (isFinite(saved) && saved > MIN) apply(Math.min(saved, cap()));
    }

    var toggle = function (h0) {
      if (box.getAttribute('data-user-h')) apply(0);
      else apply(Math.min(cap(), Math.max(h0 + 120, 260)));
    };

    var id = null, y0 = 0, h0 = 0, moved = 0;
    g.addEventListener('pointerdown', function (e) {
      if (e.button) return;
      id = e.pointerId; y0 = e.clientY; moved = 0;
      h0 = Math.round(box.getBoundingClientRect().height);
      try { g.setPointerCapture(id); } catch (err) {}
      e.preventDefault();
    });
    g.addEventListener('pointermove', function (e) {
      if (e.pointerId !== id) return;
      var dy = e.clientY - y0;
      moved = Math.max(moved, Math.abs(dy));
      if (moved < DRAG_PX) return;         // not a drag yet, just a press
      apply(Math.max(MIN, Math.min(h0 + dy, cap())));
    });
    var end = function (e) {
      if (e.pointerId !== id) return;
      try { g.releasePointerCapture(id); } catch (err) {}
      id = null;
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    // A click is not a resize; a keyboard Enter / Space arrives as keydown,
    // below.
    g.addEventListener('click', function (e) { e.preventDefault(); });
    g.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggle(Math.round(box.getBoundingClientRect().height));
    });
  }

  // ── edges: resize from every side (TradeHub's card grid, R1) ──────────────
  // Eight handles on a positioned box: thin bands on the four edges and hot
  // spots on the four corners, each with its resize cursor, larger on a coarse
  // pointer. They only REPORT the drag; the caller decides the size (a grid
  // snaps to units). The se corner is a real button: focus it and the arrow
  // keys call onKey(dx, dy) with -1 / 0 / +1.
  //   A1Resize.edges(box, { label, onStart(edge), onMove({ edge, dx, dy }),
  //                         onEnd(edge), onKey(dx, dy) }) → { handles, destroy }
  // dx / dy are px from the press. A press stops there (a drag that moves the
  // box never starts from a handle).
  var EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  var CURSOR = { n: 'ns', s: 'ns', e: 'ew', w: 'ew', ne: 'nesw', sw: 'nesw', nw: 'nwse', se: 'nwse' };
  var ECSS = [
    '.a1-edge { position: absolute; z-index: 4; padding: 0; margin: 0; border: 0; background: transparent; touch-action: none; }',
    '.a1-edge[data-edge="n"], .a1-edge[data-edge="s"] { left: 12px; right: 12px; height: 7px; }',
    '.a1-edge[data-edge="e"], .a1-edge[data-edge="w"] { top: 12px; bottom: 12px; width: 7px; }',
    '.a1-edge[data-edge="n"] { top: 0; } .a1-edge[data-edge="s"] { bottom: 0; }',
    '.a1-edge[data-edge="e"] { right: 0; } .a1-edge[data-edge="w"] { left: 0; }',
    '.a1-edge[data-edge$="e"][data-edge^="n"], .a1-edge[data-edge$="w"][data-edge^="n"], .a1-edge[data-edge$="e"][data-edge^="s"], .a1-edge[data-edge$="w"][data-edge^="s"] { width: 14px; height: 14px; }',
    '.a1-edge[data-edge="ne"] { top: 0; right: 0; } .a1-edge[data-edge="nw"] { top: 0; left: 0; }',
    '.a1-edge[data-edge="se"] { bottom: 0; right: 0; border-radius: 0 0 8px 0; color: var(--ds-txd, #adadb2); }',
    '.a1-edge[data-edge="sw"] { bottom: 0; left: 0; }',
    // The se corner keeps a faint hatch so the handles can be found at all.
    '.a1-edge[data-edge="se"]::before { content: ""; position: absolute; right: 4px; bottom: 4px; width: 7px; height: 7px; opacity: .55;',
    '  background: linear-gradient(135deg, transparent 45%, currentColor 45%, currentColor 60%, transparent 60%) no-repeat right bottom / 7px 7px; }',
    '.a1-edges-box:hover > .a1-edge[data-edge="se"]::before, .a1-edge[data-edge="se"]:focus-visible::before { opacity: 1; }',
    '.a1-edge[data-edge="se"]:focus-visible { outline: 1px solid var(--ds-ac, #c0aeea); outline-offset: -2px; }',
    '.a1-edge.on { background: color-mix(in srgb, var(--ds-ac, #c0aeea) 22%, transparent); }',
    '@media (pointer: coarse) {',
    '  .a1-edge[data-edge="n"], .a1-edge[data-edge="s"] { height: 14px; left: 22px; right: 22px; }',
    '  .a1-edge[data-edge="e"], .a1-edge[data-edge="w"] { width: 14px; top: 22px; bottom: 22px; }',
    '  .a1-edge[data-edge$="e"][data-edge^="n"], .a1-edge[data-edge$="w"][data-edge^="n"], .a1-edge[data-edge$="e"][data-edge^="s"], .a1-edge[data-edge$="w"][data-edge^="s"] { width: 24px; height: 24px; }',
    '}'
  ].join('\n') + '\n' + EDGES.map(function (e) { return '.a1-edge[data-edge="' + e + '"] { cursor: ' + CURSOR[e] + '-resize; }'; }).join('\n');

  function injectEdgeCss() {
    if (document.getElementById('a1-resizeedge-css')) return;
    var s = document.createElement('style');
    s.id = 'a1-resizeedge-css';
    s.textContent = ECSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function edges(box, o) {
    o = o || {};
    injectEdgeCss();
    box.classList.add('a1-edges-box');
    var handles = EDGES.map(function (edge) {
      var el = document.createElement(edge === 'se' ? 'button' : 'div');
      el.className = 'a1-edge';
      el.setAttribute('data-edge', edge);
      el.setAttribute('data-noglow', '');
      if (edge === 'se') {
        el.type = 'button';
        el.title = 'Drag any edge or corner to resize; arrow keys when focused.';
        el.setAttribute('aria-label', 'Resize ' + (o.label || 'the box'));
      } else el.setAttribute('aria-hidden', 'true');
      var id = null, x0 = 0, y0 = 0;
      el.addEventListener('pointerdown', function (e) {
        if (e.button) return;
        id = e.pointerId; x0 = e.clientX; y0 = e.clientY;
        try { el.setPointerCapture(id); } catch (err) {}
        el.classList.add('on');
        e.preventDefault(); e.stopPropagation();
        if (o.onStart) o.onStart(edge);
      });
      el.addEventListener('pointermove', function (e) {
        if (e.pointerId !== id) return;
        if (o.onMove) o.onMove({ edge: edge, dx: e.clientX - x0, dy: e.clientY - y0 });
      });
      var end = function (e) {
        if (e.pointerId !== id) return;
        try { el.releasePointerCapture(id); } catch (err) {}
        id = null; el.classList.remove('on');
        if (o.onEnd) o.onEnd(edge);
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      // Only the se button swallows its click. A click listener on the bands made Chrome's touch
      // adjustment snap a finger pressed on a card's title (7px away) onto the n band: a resize
      // instead of the card drag (TradeHub, 390 px, 2026-11-18).
      if (edge === 'se') el.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
      if (edge === 'se') el.addEventListener('keydown', function (e) {
        var d = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
        if (!d || !o.onKey) return;
        e.preventDefault();
        o.onKey(d[0], d[1]);
      });
      box.appendChild(el);
      return el;
    });
    return {
      handles: handles,
      destroy: function () { handles.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); }); box.classList.remove('a1-edges-box'); }
    };
  }

  window.A1Resize = { grip: grip, attach: attach, cap: cap, edges: edges };
})();
