/* ============================================================================
 * StudyOS — app shell
 * ============================================================================
 * Applies the configured title, keeps the lock button and sync line in
 * whichever bar is on screen, and owns the sidebar's collapse.
 *
 * Sidebar collapse (Tony, 2026-10-29: "the same way MAGI's does"): the toggle
 * folds the sidebar to an icon rail and the choice is remembered per device
 * (sos_side_collapsed, a convenience: blocked storage just means it starts
 * open). With no stored choice, a tablet starts collapsed and a desktop open.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  var CFG   = window.STUDYOS_CONFIG || {};
  var SHELL = CFG.shell || {};
  var KEY   = 'sos_side_collapsed';

  /* ── Lock + sync placement ───────────────────────────────────────────────
   * Both live in the sidebar logo block. Below 1024px the sidebar is either a
   * rail (tablet) or gone (phone), so neither has room: park them in the
   * topbar action row. Moving the single nodes keeps their ids unique, which
   * applock.js and _sosSetSync both look up by id. */
  var NARROW = window.matchMedia('(max-width: 1024px)');
  function placeChrome() {
    var lock  = document.getElementById('sos-lock-btn');
    var sync  = document.getElementById('sos-sync-status');
    var row   = document.querySelector('#study-root .sidebar-logo-row');
    var brand = document.querySelector('#study-root .sb-brand');
    var bar   = document.querySelector('#study-root .topbar-actions');
    if (!lock || !sync || !row || !brand || !bar) return;
    if (NARROW.matches) {
      bar.insertBefore(sync, bar.firstChild);
      bar.insertBefore(lock, bar.firstChild);
    } else {
      row.appendChild(lock);
      brand.appendChild(sync);
    }
  }

  /* ── Sidebar collapse ─────────────────────────────────────────────────── */
  var TABLET = window.matchMedia('(min-width: 641px) and (max-width: 1024px)');
  function stored() { try { var v = localStorage.getItem(KEY); return v === null ? null : v === '1'; } catch (e) { return null; } }
  function remember(on) { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {} }
  function applyCollapse(on) {
    var app = document.getElementById('sos-app');
    var t = document.getElementById('sos-side-toggle');
    if (!app) return;
    app.classList.toggle('sb-collapsed', !!on);
    if (t) {
      var label = on ? 'Expand the sidebar' : 'Collapse the sidebar';
      t.title = label; t.setAttribute('aria-label', label);
      t.setAttribute('aria-expanded', on ? 'false' : 'true');
    }
  }

  function boot() {
    if (SHELL.title) document.title = SHELL.title;
    placeChrome();
    var s = stored();
    applyCollapse(s === null ? TABLET.matches : s);
    if (NARROW.addEventListener) NARROW.addEventListener('change', placeChrome);
    else if (NARROW.addListener) NARROW.addListener(placeChrome);   // older WebKit
    if (TABLET.addEventListener) TABLET.addEventListener('change', function () { if (stored() === null) applyCollapse(TABLET.matches); });
    var t = document.getElementById('sos-side-toggle');
    if (t) t.addEventListener('click', function () {
      var app = document.getElementById('sos-app');
      var on = !(app && app.classList.contains('sb-collapsed'));
      applyCollapse(on); remember(on);
    });
    // The mark beside the wordmark (and its twin in a phone's header) returns
    // to the cover page (js/intro.js).
    ['sos-mark-btn', 'sos-mark-btn-top'].forEach(function (id) {
      var mark = document.getElementById(id);
      if (mark) mark.addEventListener('click', function () { if (window.sosShowIntro) window.sosShowIntro(); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
