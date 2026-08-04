/* ============================================================================
 * StudyOS — app shell
 * ============================================================================
 * Renders the header's sibling-app links from STUDYOS_CONFIG.shell.nav, and
 * applies the configured title/accent.
 *
 * Standalone, shell.nav is empty and the header shows just the title, the
 * active "Study" pill and the App Lock button. Once V1 has sibling pages, add
 * entries to config §6 and they appear here — no markup changes.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  var CFG   = window.STUDYOS_CONFIG || {};
  var SHELL = CFG.shell || {};

  function start() {
    var title = document.querySelector('.sos-hdr-title');
    if (title && SHELL.title) {
      title.textContent = SHELL.title;
      document.title = SHELL.title;
    }
    if (SHELL.accent) {
      if (title) title.style.color = SHELL.accent;
      var root = document.getElementById('study-root');
      if (root) {
        root.style.setProperty('--accent', SHELL.accent);
        root.style.setProperty('--accent2', SHELL.accent);
      }
    }

    var nav = document.getElementById('sos-shell-nav');
    var links = Array.isArray(SHELL.nav) ? SHELL.nav : [];
    if (!nav || !links.length) return;

    // Insert before the "Study" pill so sibling links read left-to-right and
    // the current app stays adjacent to the lock button.
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
