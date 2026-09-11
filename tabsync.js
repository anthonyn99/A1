/**
 * tabsync — one tab per destination, even after the browser has been closed.
 *
 * THE PROBLEM THIS SOLVES
 * Every button in TaskHub that leaves the page goes through _tnOpenTab
 * (index.html), which opens each destination in a window with a STABLE name —
 * 'a1tab_magi', 'a1tab_tradehub', 'a1tab_link_veda_<id>'. A second click calls
 * window.open('', NAME), which re-targets the tab that is already open instead
 * of stacking up another one. That works perfectly for as long as the browser
 * is running.
 *
 * It stops working the moment the browser is closed and reopened. Chrome
 * restores the tabs but NOT the opener relationships between them, and a named
 * window is only findable from inside the same browsing-context group — the
 * family of windows linked by opener. So after a restart the restored MAGI tab
 * is invisible to the restored TaskHub tab, the name lookup misses, and the
 * click opens a second MAGI beside the first.
 *
 * WHAT THIS FILE DOES
 * Gives those orphaned tabs a way to answer. Any A1 page opened through
 * _tnOpenTab carries its key in window.name, so on load it can say "I am the
 * tab for 'magi'": it writes a heartbeat to localStorage and listens on a
 * BroadcastChannel. Both are same-origin channels that do not care about opener
 * relationships, so they survive a restart exactly where window names do not.
 *
 * When TaskHub is about to open a destination and the name lookup gave it a
 * blank tab, it checks the heartbeat first. If some tab claims that key it asks
 * over the channel, and the answer decides what happens:
 *
 *   • the old tab managed to focus itself  → TaskHub closes the blank tab it
 *     just opened. One tab, still holding everything it had.
 *   • it could not                         → it is told to retire: it stops
 *     claiming the key and closes itself, and TaskHub navigates the blank tab.
 *     One tab again, freshly loaded.
 *   • nobody answers                       → ordinary open, same as before.
 *
 * TWO HONEST LIMITS
 *   • Chrome only lets a background tab call window.focus() on itself when it
 *     has recent user interaction, so the first branch is the lucky one and the
 *     retire-and-reopen branch is the usual outcome after a restart. Both end
 *     with exactly one tab, which is the point.
 *   • window.close() only works on a tab the browser considers script-closable:
 *     one it opened itself, or one whose session history holds a single entry.
 *     A tab opened the normal way qualifies — the destination replaces the
 *     initial empty document rather than pushing onto it, measured at
 *     history.length === 1 — but a page that pushes history entries as you use
 *     it (Solace does) can grow out of it. A retired tab that cannot close has
 *     already given up the key, so the next click is clean; that one time you
 *     are left with the old tab sitting there, which is the behaviour we had
 *     before and never worse.
 *
 * Cross-origin destinations (a custom link to gmail.com) cannot run any of
 * this. They keep the window-name pairing and nothing else, which is all a page
 * is allowed to know about another origin's tabs.
 *
 * Include it on every A1 page. A page opened directly — bookmark, typed URL,
 * the very first tab — has no key and this file does nothing at all.
 */
(function () {
  'use strict';

  var PREFIX = 'a1tab_';
  var CHANNEL = 'a1tabs';
  var LS_PREFIX = 'a1tab:';
  var BEAT_MS = 5000;

  // The key comes from window.name, which _tnOpenTab set when it opened this
  // tab. sessionStorage is the backup copy: it is per-tab and IS restored with
  // the tab, so the pairing survives even if the name does not come back.
  var key = null;
  var m = /^a1tab_(.+)$/.exec(String(window.name || ''));
  if (m) key = m[1];
  try {
    if (key) sessionStorage.setItem('a1TabKey', key);
    else {
      key = sessionStorage.getItem('a1TabKey') || null;
      if (key) window.name = PREFIX + key;
    }
  } catch (e) {}
  if (!key) return;

  var LS = LS_PREFIX + key;
  var ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var retired = false;

  function beat() {
    try { localStorage.setItem(LS, JSON.stringify({ id: ID, t: Date.now() })); } catch (e) {}
  }
  // Only ever clear OUR OWN claim. If a replacement tab has already written its
  // own id we would otherwise delete the live entry on the way out and the next
  // click would open a third tab.
  function release() {
    try {
      var r = JSON.parse(localStorage.getItem(LS) || 'null');
      if (!r || r.id === ID) localStorage.removeItem(LS);
    } catch (e) {}
  }

  beat();
  var hb = setInterval(beat, BEAT_MS);
  // pagehide (not unload) so the entry clears on a bfcache navigation too.
  window.addEventListener('pagehide', release);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') beat();
  });

  var bc = null;
  try { bc = new BroadcastChannel(CHANNEL); } catch (e) { bc = null; }
  if (!bc) return;   // heartbeat only: the opener's handshake times out and opens normally

  function retire() {
    if (retired) return;
    retired = true;
    clearInterval(hb);
    release();
    // Give up the key BEFORE trying to close, so a tab the browser refuses to
    // close is inert rather than a second claimant for the same destination.
    try { window.name = ''; } catch (e) {}
    try { sessionStorage.removeItem('a1TabKey'); } catch (e) {}
    try { bc.close(); } catch (e) {}
    try { window.close(); } catch (e) {}
  }

  bc.onmessage = function (ev) {
    var d = ev && ev.data;
    if (!d || d.k !== key || retired) return;
    if (d.t === 'retire') { retire(); return; }
    if (d.t !== 'claim') return;
    try { window.focus(); } catch (e) {}
    // Answer on the next frames, not immediately: the opener has just opened a
    // blank tab, so focus is still settling and an instant reading of
    // hasFocus() reports the state before our own focus() call landed.
    setTimeout(function () {
      var ok = false;
      try { ok = document.visibilityState === 'visible' && document.hasFocus(); } catch (e) {}
      try { bc.postMessage({ t: 'claimed', k: key, rid: d.rid, id: ID, ok: ok }); } catch (e) {}
    }, 90);
  };
})();
