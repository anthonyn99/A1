/* resizegrip.js — MAGI's corner resize grip, for every A1 program (window.A1Resize).
 *
 * Began as a port of magi.html's own prompt-box grip and its CSS (theme
 * overhaul, docs/theme-overhaul-plan.md §2 "Resize handles"); since phase 11
 * MAGI loads this file too, so it is the one copy. It replaces the
 * native `resize:` corner, which is ~14px on a desktop and absent on a phone.
 *
 * The grip is a real button pinned over the box's bottom-right corner: 38px
 * of invisible hit area under a small two-stroke hatch. Drag it (3px or more)
 * and the box takes that height, between 26px and max(160px, 60% of the
 * viewport). Click it, or press Enter / Space on it, and it toggles: a box at
 * its natural height expands (+120px, at least 260px); a box sized by hand
 * goes back to auto. A hand-chosen height overrides the box's own CSS min- and
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
  var CLICK_PX = 3;
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
    g.title = 'Drag to resize. Click to expand or compress.';
    g.setAttribute('aria-label', 'Resize ' + (label || 'the box'));
    return g;
  }

  function attach(box, g, key, onAuto) {
    if (!box || !g) return;
    injectCss();
    box.classList.add('a1-grip-box');

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
      if (moved < CLICK_PX) return;         // not a drag yet, just a press
      apply(Math.max(MIN, Math.min(h0 + dy, cap())));
    });
    var end = function (e) {
      if (e.pointerId !== id) return;
      try { g.releasePointerCapture(id); } catch (err) {}
      id = null;
      // A press that went nowhere is a click: toggle instead of resize.
      if (moved < CLICK_PX && e.type === 'pointerup') toggle(h0);
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    // A click the pointer path already handled must not toggle twice; a
    // keyboard Enter / Space arrives as keydown, below.
    g.addEventListener('click', function (e) { e.preventDefault(); });
    g.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggle(Math.round(box.getBoundingClientRect().height));
    });
  }

  window.A1Resize = { grip: grip, attach: attach, cap: cap };
})();
