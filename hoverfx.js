/**
 * hoverfx — one hover language for every A1 program.
 *
 * WHAT IT DOES
 * Every clickable control answers the cursor the same way: a dim control lifts a
 * step, a bright one settles a step. That is StudyOS's behaviour, ported out —
 * see V1/css/studyos.css, where `.btn` goes bg3 (#26272A) -> bg4 (#2e2f33) on
 * hover and `.btn.primary` goes to `opacity: .88`. Roughly +20% and -12%.
 *
 * WHY IT MEASURES INSTEAD OF DECLARING
 * StudyOS can spell those two rules out in CSS because its controls carry
 * classes. Nothing else here does. The TaskHubs are inline-styled React, the
 * journals and dialogs are hand-built DOM, and across the suite there are
 * thousands of controls — no class to hang a rule on, and no version of
 * "hand-write a hover onto each" that anyone could keep correct.
 *
 * So on hover this composites the control's own painted colour and picks the
 * direction from its luminance. One delegated listener therefore covers controls
 * that do not exist yet: a dialog's buttons, a row rendered three renders from
 * now, a chip on a panel someone adds next year. It also means the layer is
 * theme-agnostic by construction — a white card's chip darkens, a dark chip
 * lifts, with nothing to configure.
 *
 * WHY `filter` AND NOTHING ELSE
 * `filter` is the only property written, and it is written inline. React owns
 * background / border / box-shadow inline on the TaskHub nodes (the mic's glow,
 * the Timer chip's fill, a selected day's outline); clearing one of those on
 * mouseout would wipe whatever React last put there. Nothing in the suite sets
 * an inline filter, so this can never be in a fight over the property.
 *
 * USAGE
 *   <script src="hoverfx.js"></script>                      whole document
 *   <script src="hoverfx.js" data-roots="#a,#b"></script>   only inside #a / #b
 *
 * index.html needs the scoped form: its program nav already answers the cursor
 * with a gold outline plus glow, and stacking a second signal on a designed one
 * is how a hover language stops reading as one language.
 *
 * Opt a subtree out at any time with data-no-hoverfx.
 *
 * The extensions (Vault/, PriceWatch/, V1/Launcher/) cannot reach outside their
 * own folder, so each carries a byte-identical copy. tests/hoverfx-wiring.test.js
 * fails if a copy drifts.
 */
(function () {
  'use strict';
  if (window.__hoverfx) return;          // a page may pull in more than one copy
  window.__hoverfx = true;

  /* Kept below the point where gold (#e0b874) clips its red channel: past ~1.2
     the lift stops reading as "brighter" and starts reading as a hue shift into
     neon yellow, which is loud next to the glow several controls already grow. */
  var LIFT_GHOST   = 'brightness(1.18)',  /* no fill, dark ground: lift the outline + label */
      LIFT_FILL    = 'brightness(1.22)',  /* dark fill: one step lighter, StudyOS's bg3 -> bg4 */
      SETTLE_GHOST = 'brightness(0.88)',  /* no fill, light ground: deepen the ink instead */
      SETTLE       = 'brightness(0.86)';  /* bright fill: StudyOS's .primary opacity .88 */

  var CONTROLS = 'button,select,summary,a[href],[role="button"]';
  var OPT_OUT  = '[data-no-hoverfx]';

  var self  = document.currentScript;
  var ROOTS = (self && self.getAttribute('data-roots')) || null;

  // ── style ────────────────────────────────────────────────────────────────
  // Makes the filter fade instead of snapping, in BOTH directions.
  // Only `transition-property` is overridden — never duration or easing — so a
  // control keeps the timing it was designed with and merely gains `filter` in
  // the set. That matters because these controls disagree: some carry an inline
  // `all .15s`, some a narrow `background .15s, border-color .15s`, some a
  // `width .35s cubic-bezier(...)` that would look wrong at any other speed, and
  // inline beats any stylesheet rule that is not !important. Listing properties
  // rather than saying `all` keeps a state change that was never animated from
  // suddenly sliding.
  // The class is added once and never removed: toggling it with the hover would
  // leave the mouse-out unanimated, since a transition needs the property
  // already declared in the after-change style.
  var css = document.createElement('style');
  css.textContent =
    '.hoverfx{transition-property:filter,background,background-color,border-color,' +
    'border-top-color,border-right-color,border-bottom-color,border-left-color,' +
    'box-shadow,color,opacity,transform,width,height,left,right,visibility,' +
    'border-radius,outline-color,fill,stroke,stroke-dashoffset,text-shadow!important}' +
    /* For controls whose FIRST transition-duration is 0s — either they declare
       no transition at all, or their list starts at 0s (`0s, 0.5s`) and
       `filter`, being first above, would pair with that zero and snap. */
    '.hoverfx-t{transition-duration:.15s!important;transition-timing-function:ease!important}';
  (document.head || document.documentElement).appendChild(css);

  // ── colour ───────────────────────────────────────────────────────────────
  function rgba(str) {
    var m = /rgba?\(([^)]+)\)/.exec(str || '');
    if (!m) return null;
    var p = m[1].split(',').map(parseFloat);
    if (p.length < 3 || p.slice(0, 3).some(isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  // The ground everything is painted on, for the rare control whose whole
  // ancestor chain is transparent. Read from the page rather than hard-coded, so
  // this file does not need to know each program's palette.
  var ground = null;
  function pageGround() {
    if (ground) return ground;
    var els = [document.body, document.documentElement];
    for (var i = 0; i < els.length; i++) {
      var c = els[i] && rgba(getComputedStyle(els[i]).backgroundColor);
      if (c && c.a > 0.9) return (ground = c);
    }
    return (ground = { r: 26, g: 26, b: 29 });   // #1a1a1d, the suite's dark
  }

  // What the control actually looks like on screen: its own background layered
  // over whatever shows through it. Without this a 12%-alpha gold chip measures
  // as gold and would get dimmed, when on screen it is a dark thing that lifts.
  function painted(el) {
    var stack = [], n = el, c;
    while (n && n.nodeType === 1) {
      c = rgba(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a > 0.99) break; }
      n = n.parentElement;
    }
    var out = pageGround();
    for (var i = stack.length - 1; i >= 0; i--) {
      c = stack[i];
      out = { r: c.r * c.a + out.r * (1 - c.a),
              g: c.g * c.a + out.g * (1 - c.a),
              b: c.b * c.a + out.b * (1 - c.a) };
    }
    return out;
  }

  // Direction always follows what the eye sees. A control with no fill of its
  // own is judged by the ground it sits on, so a chip on a white card deepens
  // instead of washing out — which is what makes this work on a light surface
  // without a theme flag to read.
  function effect(el) {
    var own   = rgba(getComputedStyle(el).backgroundColor);
    var ghost = !own || own.a < 0.06;
    var c     = painted(el);
    var bright = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 > 0.42;
    return bright ? (ghost ? SETTLE_GHOST : SETTLE)
                  : (ghost ? LIFT_GHOST   : LIFT_FILL);
  }

  // ── target ───────────────────────────────────────────────────────────────
  // A cursor:pointer surface only counts as a control if it is control-SIZED.
  // Excalidraw sets cursor:pointer on its whole board (that is how it shows the
  // active tool), and without this the drawing area lit up like a button the
  // moment the mouse entered it.
  // getBoundingClientRect, not offsetWidth/offsetHeight: the walk starts at the
  // deepest descendant, which on an icon button is an <svg>, and SVG elements
  // have no offset* at all — reading them returns undefined and rejects every
  // icon button in the app as "too big".
  function sized(el) {
    var r = el.getBoundingClientRect();
    return r.height <= 180 && r.width * r.height <= 0.2 * innerWidth * innerHeight;
  }

  // cursor:pointer is inherited, so a <span> inside a clickable <div> reports it
  // too — climb to the top of the run to find the element that actually owns the
  // click. A real control (<button>, <select>, ...) ends the walk outright, which
  // is what stops a button from lighting up the whole row it sits in. Too-large
  // means stop climbing, not skip: the answer is the last control-sized element
  // found on the way out, never something bigger further up.
  function control(from, root) {
    var best = null, n = from;
    while (n && n !== root && n.nodeType === 1) {
      if (n.matches(OPT_OUT)) return null;
      if (n.matches(CONTROLS)) return n;
      if (getComputedStyle(n).cursor === 'pointer') {
        if (!sized(n)) return best;
        best = n;
      } else if (best) return best;
      n = n.parentElement;
    }
    return best;
  }

  // ── wire ─────────────────────────────────────────────────────────────────
  var cur = null;
  function clear() { if (cur) { cur.style.filter = ''; cur = null; } }

  document.addEventListener('pointerover', function (e) {
    // A tap fires a synthetic hover that never gets a matching pointerout, which
    // would leave the control stuck lit until something else repaints it.
    if (e.pointerType && e.pointerType !== 'mouse') { clear(); return; }
    if (cur && cur.contains(e.target)) return;      // still inside the same control
    var t = e.target;
    if (!t || !t.closest) { clear(); return; }
    var root = ROOTS ? t.closest(ROOTS) : document;
    if (!root) { clear(); return; }
    var el = control(t, root);
    if (el === cur) return;
    clear();
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    // A control that already answers the cursor with a filter of its own keeps
    // that answer — an inline filter here would silently replace it.
    var cs = getComputedStyle(el);
    if (cs.filter && cs.filter !== 'none') return;
    cur = el;
    el.classList.add('hoverfx');
    // `filter` is first in the property list, so it pairs with the FIRST
    // duration in the element's list.
    if (!(parseFloat(cs.transitionDuration) > 0)) el.classList.add('hoverfx-t');
    el.style.filter = effect(el);
  }, true);

  document.addEventListener('pointerout', function (e) {
    if (cur && !cur.contains(e.relatedTarget)) clear();
  }, true);

  // Alt-tabbing away mid-hover never delivers a pointerout.
  window.addEventListener('blur', clear);
})();
