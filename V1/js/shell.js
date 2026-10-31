/* ============================================================================
 * StudyOS — app shell
 * ============================================================================
 * Applies the configured title and keeps the lock button and sync line in
 * whichever bar is on screen.
 *
 * The sidebar has no collapse (Tony, 2026-10-31: "Sidebar should always be
 * showing"): a desktop always shows it whole, a tablet always shows the icon
 * rail (CSS), a phone uses the bottom nav.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  var CFG   = window.STUDYOS_CONFIG || {};
  var SHELL = CFG.shell || {};

  /* ── Lock + sync placement ───────────────────────────────────────────────
   * Both live in the sidebar logo block (the lock in the tool row, with
   * LifeHub). Below 1024px the sidebar is either a rail (tablet) or gone
   * (phone), so neither has room: park them in the topbar action row. Moving the single nodes keeps their ids unique, which
   * applock.js and _sosSetSync both look up by id. */
  var NARROW = window.matchMedia('(max-width: 1024px)');
  function placeChrome() {
    // #sos-sb-tools = the lock and the LifeHub launcher, moved as one.
    var tools = document.getElementById('sos-sb-tools');
    var sync  = document.getElementById('sos-sync-status');
    var row   = document.querySelector('#study-root .sb-tool-row');
    var home  = document.querySelector('#study-root .sidebar-logo');
    var bar   = document.querySelector('#study-root .topbar-actions');
    if (!tools || !sync || !row || !home || !bar) return;
    if (NARROW.matches) {
      bar.insertBefore(sync, bar.firstChild);
      bar.insertBefore(tools, bar.firstChild);
    } else {
      row.appendChild(tools);
      home.appendChild(sync);
    }
  }

  function boot() {
    if (SHELL.title) document.title = SHELL.title;
    placeChrome();
    if (NARROW.addEventListener) NARROW.addEventListener('change', placeChrome);
    else if (NARROW.addListener) NARROW.addListener(placeChrome);   // older WebKit
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
