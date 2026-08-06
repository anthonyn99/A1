/* ============================================================================
 * StudyOS — pull-to-refresh (touch devices)
 * ============================================================================
 * Drag down at the top of a scrolled view to reload data from the cloud.
 *
 * Why this file exists rather than a browser-native gesture: StudyOS is a PWA
 * whose scrolling lives in `.view` elements, not on `document`. The browser's
 * own overscroll refresh never fires because the body itself never scrolls, so
 * the gesture has to be implemented against the active `.view`.
 *
 * Refresh here means "re-read from Firestore and repaint", NOT location.reload().
 * A hard reload would discard unsaved edits and re-run the App Lock gate; the
 * cloud read produces the same visible result without either cost. If the read
 * path is unavailable for any reason we fall back to a real reload so the
 * gesture is never a no-op.
 *
 * Load AFTER js/studyos.js — it calls window._fbLoadStudyOs and the renderers
 * that studyos.js defines.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* Pointer-based detection rather than a width breakpoint: a touchscreen
   * laptop should get the gesture, and a phone in desktop mode should not lose
   * it. `pointer:coarse` is the actual property that matters here. */
  if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return;

  /* Thresholds are deliberately conservative. On a mobile browser whose chrome
   * auto-hides (Brave, Chrome, Safari), the user's way to bring the address bar
   * BACK is an upward drag near the top of the page — the same region this
   * gesture watches. A twitchy pull-to-refresh hijacks that and reloads the app
   * when they only wanted the URL bar, so every ambiguous gesture must resolve
   * to "not a refresh". */
  var THRESHOLD   = 110;  // px of pull needed to commit a refresh
  var MAX_PULL    = 150;  // px the indicator can travel (past this it resists)
  var TOP_SLOP    = 0;    // must be exactly at the top to even consider a pull
  var DIRECTION_SLOP = 18;// px of travel before we classify the gesture
  var VERTICAL_BIAS  = 1.6;// dy must exceed dx by this factor to count as a pull
  var UP_CANCEL      = 6; // px of upward movement that permanently cancels

  var startY = 0, startX = 0, pulling = false, decided = false, committed = false;
  var maxDy = 0;          // furthest down the finger has been this gesture
  var scroller = null, indicator = null, refreshing = false;

  function makeIndicator() {
    if (indicator) return indicator;
    indicator = document.createElement('div');
    indicator.className = 'sos-ptr';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.innerHTML =
      '<div class="sos-ptr-spinner">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
             'stroke-linecap="round" width="18" height="18">' +
          '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>' +
        '</svg>' +
      '</div>';
    var root = document.getElementById('study-root') || document.body;
    root.appendChild(indicator);
    return indicator;
  }

  function activeView() {
    var v = document.querySelector('#study-root .view.active');
    // A modal owns the gesture while it is open — pulling inside a dialog must
    // scroll the dialog, not refresh the page behind it.
    if (document.querySelector('.modal.active, .modal-overlay.active, [data-modal-open="1"]')) return null;
    return v;
  }

  function setPull(px) {
    var i = makeIndicator();
    // Resist past MAX_PULL so the gesture feels bounded instead of unlimited.
    var shown = px > MAX_PULL ? MAX_PULL + (px - MAX_PULL) * 0.25 : px;
    i.style.transform = 'translateX(-50%) translateY(' + shown + 'px)';
    i.style.opacity = Math.min(1, px / THRESHOLD).toFixed(2);
    i.classList.toggle('sos-ptr-ready', px >= THRESHOLD);
    var sp = i.firstElementChild;
    if (sp) sp.style.transform = 'rotate(' + (px * 2.4) + 'deg)';
  }

  function reset(animate) {
    var i = indicator;
    if (!i) return;
    i.classList.remove('sos-ptr-ready', 'sos-ptr-spin');
    i.style.transition = animate ? 'transform .22s ease, opacity .22s ease' : '';
    i.style.transform = 'translateX(-50%) translateY(0)';
    i.style.opacity = '0';
    if (animate) setTimeout(function () { if (indicator) indicator.style.transition = ''; }, 240);
  }

  /* Re-read from the cloud and repaint. Resolves when the data is on screen. */
  function doRefresh() {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    var i = makeIndicator();
    i.classList.add('sos-ptr-spin');
    i.style.transition = 'transform .18s ease';
    i.style.transform = 'translateX(-50%) translateY(' + THRESHOLD + 'px)';
    i.style.opacity = '1';

    var done = function () {
      refreshing = false;
      reset(true);
    };

    // No cloud read available (Firebase disabled/offline boot) — fall back to a
    // genuine reload rather than pretending the gesture did something.
    if (typeof window._fbLoadStudyOs !== 'function') {
      setTimeout(function () { window.location.reload(); }, 300);
      return Promise.resolve();
    }

    return Promise.resolve()
      .then(function () { return window._fbLoadStudyOs(); })
      .then(function (remote) {
        // _fbLoadStudyOs resolves with the server document. Hand it to the same
        // path a live snapshot uses so there is exactly one merge+repaint
        // implementation, rather than a second copy that can drift from it.
        if (remote) {
          window.dispatchEvent(new CustomEvent('fb-sos-remote', { detail: remote }));
        }
        // Keep the spinner visible briefly so a fast refresh still reads as a
        // deliberate action rather than a flicker.
        return new Promise(function (r) { setTimeout(r, 350); });
      })
      .catch(function (e) {
        console.warn('[StudyOS] pull-to-refresh failed:', e);
      })
      .then(done, done);
  }

  document.addEventListener('touchstart', function (e) {
    if (refreshing || e.touches.length !== 1) return;
    scroller = activeView();
    // Strictly at rest at the very top. Anything else — even 1px of scroll —
    // means the user is reading, and an upward flick there is them chasing the
    // browser chrome, not asking for a refresh.
    if (!scroller || scroller.scrollTop > TOP_SLOP) { pulling = false; return; }
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    pulling = true; decided = false; committed = false; maxDy = 0;
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!pulling || refreshing) return;
    var dy = e.touches[0].clientY - startY;
    var dx = e.touches[0].clientX - startX;

    // Any meaningful upward travel ends the gesture for good — even after it
    // was classified as a pull. This is the case that was firing by mistake:
    // a downward wobble followed by the real upward drag used to keep the pull
    // alive, so releasing could still trigger a refresh.
    if (dy < -UP_CANCEL) {
      pulling = false; committed = false;
      reset(true);
      return;
    }

    if (!decided) {
      if (Math.abs(dy) < DIRECTION_SLOP && Math.abs(dx) < DIRECTION_SLOP) return;
      // Must be clearly downward AND clearly more vertical than horizontal.
      // Ambiguous drags fall through to the browser, which is the safe default.
      if (dy <= 0 || Math.abs(dy) < Math.abs(dx) * VERTICAL_BIAS) { pulling = false; return; }
      decided = true;
    }

    // The view scrolled away from the top mid-gesture: abandon quietly.
    if (scroller.scrollTop > TOP_SLOP) { pulling = false; reset(true); return; }

    if (dy > 0) {
      if (dy > maxDy) maxDy = dy;
      // Commit on the CURRENT position, not the furthest reached, so dragging
      // back up before releasing cancels — matching how native pull-to-refresh
      // behaves everywhere else.
      committed = dy >= THRESHOLD;
      setPull(dy);
      // Only preventable once we own the gesture; the listener is non-passive
      // for exactly this reason. Stops the page rubber-banding behind us.
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });

  function end() {
    if (!pulling) return;
    pulling = false;
    if (committed && !refreshing) doRefresh();
    else reset(true);
    committed = false;
  }

  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
})();
