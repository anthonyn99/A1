/* ============================================================================
 * StudyOS — app shell
 * ============================================================================
 * Applies the configured title/accent, renders sibling-app links from
 * STUDYOS_CONFIG.shell.nav, and keeps the App Lock button and sync indicator in
 * whichever bar is actually on screen.
 *
 * The purple "STUDYOS" strip that used to sit above the app is gone — the
 * sidebar's own white wordmark is the only one now, and it carries the lock
 * button and the sync line. The #sos-shell-nav container went with that strip,
 * so shell.nav has nowhere to render until V1 gains sibling pages and a bar to
 * hold them; config §6 is empty, and the loop below no-ops without it.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  var CFG   = window.STUDYOS_CONFIG || {};
  var SHELL = CFG.shell || {};

  function start() {
    // The sidebar wordmark is deliberately left alone: it is a fixed "S StudyOS"
    // lockup, not a configurable label. Only the document title follows config.
    if (SHELL.title) document.title = SHELL.title;
    if (SHELL.accent) {
      var root = document.getElementById('study-root');
      if (root) {
        root.style.setProperty('--accent', SHELL.accent);
        root.style.setProperty('--accent2', SHELL.accent);
      }
    }

    // No container while StudyOS is standalone — see the file header.
    var nav = document.getElementById('sos-shell-nav');
    var links = Array.isArray(SHELL.nav) ? SHELL.nav : [];
    if (!nav || !links.length) return;

    // Insert before whatever already sits in the bar, so sibling links read
    // left-to-right ahead of the current app's own controls.
    var first = nav.firstElementChild;
    links.forEach(function (item) {
      if (!item || !item.label || !item.href) return;
      var a = document.createElement('a');
      a.className = 'sos-hbtn';
      a.href = item.href;
      a.textContent = item.label;
      if (item.newTab) { a.target = '_blank'; a.rel = 'noopener'; }
      nav.insertBefore(a, first);
    });
  }

  /* ── Lock + sync placement ───────────────────────────────────────────────
   * Both live in the sidebar logo block. Below 1024px the sidebar is either a
   * 60px icon rail (tablet) or gone entirely (phone), so neither has room —
   * park them in the topbar action row instead. Moving the single nodes keeps
   * their ids unique, which applock.js and _sosSetSync both look up by id. */
  var NARROW = window.matchMedia('(max-width: 1024px)');
  function placeChrome() {
    var lock = document.getElementById('sos-lock-btn');
    var sync = document.getElementById('sos-sync-status');
    var row  = document.querySelector('#study-root .sidebar-logo-row');
    var logo = document.querySelector('#study-root .sidebar-logo');
    var bar  = document.querySelector('#study-root .topbar-actions');
    if (!lock || !sync || !row || !logo || !bar) return;
    if (NARROW.matches) {
      bar.insertBefore(sync, bar.firstChild);
      bar.insertBefore(lock, bar.firstChild);
    } else {
      row.appendChild(lock);
      logo.appendChild(sync);
    }
  }

  function boot() {
    start();
    placeChrome();
    if (NARROW.addEventListener) NARROW.addEventListener('change', placeChrome);
    else if (NARROW.addListener) NARROW.addListener(placeChrome);   // older WebKit
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
