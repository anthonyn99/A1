/* apphead.js — the two pieces every A1 program's header shares.

   1. The app mark beside the title, the way Shield draws it: a line glyph in
      the accent colour, one title-height square, a small gap before the word.
        <span class="a1-app-ic" data-a1-app="mylist"></span>MyList
      The span is filled on load (and by A1Head.fill(root) for markup added
      later). Its size is 1em and its gap .4em, so it follows whatever size
      the title is set in: Shield's 20px title gets a 20px mark 8px away.
      The glyphs are each program's favicon mark without its tile.

   2. The sync status, Everwell's design (Tony, 2026-10-13): a dot and a word,
      no outline. "Syncing…" pulses gold, "Synced" is green and fades after
      two seconds, "Sync failed" is red and stays, "Offline" is grey.
        A1Head.sync(el, 'busy' | 'ok' | 'err' | 'off' | 'idle')
      el gets the dot and the word the first time; later calls only change
      the state. 'ok' while the browser is offline reads "Offline".

   One file for every page. The browser extensions and the Shield desktop UI
   cannot load a file from outside their own folder, so each carries a
   byte-identical copy (tests/apphead-wiring.test.js holds them to it). */
(function () {
  'use strict';
  if (window.A1Head) return;

  // viewBox 14 14 68 68 crops each favicon's 96-unit tile to its mark; the
  // stroke matches Shield's 1.6 on 24 at that scale.
  var G = {
    oneinbox: '<path d="M66 28H26a6 6 0 0 0-6 6v28a6 6 0 0 0 6 6h44a6 6 0 0 0 6-6V36"/><path d="M20 33 48 54 72.5 35.6"/><circle cx="75" cy="27" r="5.5" fill="currentColor" stroke="none"/>',
    tradehub: '<path d="M24 22v50a2 2 0 0 0 2 2h48"/><path d="M34 62l12-14 10 9 16-21"/><path d="M60 36h12v12"/>',
    mylist: '<path d="M42 32h30"/><path d="M42 48h30"/><path d="M42 64h30"/><circle cx="28" cy="32" r="3.5" fill="currentColor" stroke="none"/><circle cx="28" cy="48" r="3.5" fill="currentColor" stroke="none"/><circle cx="28" cy="64" r="3.5" fill="currentColor" stroke="none"/>',
    insight: '<path d="M48 24a24 24 0 1 0 24 24H48Z"/><path d="M60 20a20 20 0 0 1 16 16H60Z"/>',
    vault: '<rect x="22" y="42" width="52" height="34" rx="7"/><path d="M33 42v-9a15 15 0 0 1 30 0v9"/><path d="M48 55v8"/>',
    everwell: '<path d="M28 72 48 52 68 72"/><path d="M28 54 48 34 68 54"/><circle cx="48" cy="20" r="5.5" fill="currentColor" stroke="none"/>',
    shield: '<path d="M48 18 24 26.5v19.5c0 16 12 26 24 32 12-6 24-16 24-32V26.5Z"/><circle cx="48" cy="44" r="6.5"/><path d="M48 50.5v10"/>',
    riftiq: '<path d="M48 19 73 33.5v29L48 77 23 62.5v-29Z" stroke-width="4"/><path d="M48 26l5 12v18H43V38Z" fill="currentColor" stroke="none"/><rect x="33" y="56" width="30" height="6" rx="3" fill="currentColor" stroke="none"/><rect x="45" y="62" width="6" height="11" rx="3" fill="currentColor" stroke="none"/>',
    magi: '<circle cx="48" cy="35.3" r="14.5" stroke-width="4.2"/><circle cx="36.4" cy="54.4" r="14.5" stroke-width="4.2"/><circle cx="59.6" cy="54.4" r="14.5" stroke-width="4.2"/><circle cx="48" cy="47.7" r="5.4" fill="currentColor" stroke="none"/>',
    taskhub: '<path d="M26 34l7 7 12-13"/><path d="M56 36h16"/><path d="M26 58h46"/><path d="M26 72h46"/>',
    journal: '<path d="M30 20h32a6 6 0 0 1 6 6v44a6 6 0 0 1-6 6H30Z"/><path d="M30 20a6 6 0 0 0-6 6v44a6 6 0 0 0 6 6"/><path d="M40 36h16"/><path d="M40 48h16"/>',
    brainstorm: '<path d="M48 20a18 18 0 0 0-10 33v7h20v-7a18 18 0 0 0-10-33Z"/><path d="M40 68h16"/><path d="M43 76h10"/>',
    pricewatch: '<path d="M22 46V24a2 2 0 0 1 2-2h22l28 28a3 3 0 0 1 0 4L54 74a3 3 0 0 1-4 0Z"/><circle cx="35" cy="35" r="4" fill="currentColor" stroke="none"/>',
    launcher: '<rect x="22" y="22" width="20" height="20" rx="5"/><rect x="54" y="22" width="20" height="20" rx="5"/><rect x="22" y="54" width="20" height="20" rx="5"/><rect x="54" y="54" width="20" height="20" rx="5"/>',
    wellness: '<path d="M26 52c0-10 8-18 18-18s18 8 18 18"/><path d="M22 62h12l5-10 6 20 5-10h24"/>'
  };
  function icon(name) {
    var g = G[name];
    if (!g) return '';
    return '<svg viewBox="14 14 68 68" fill="none" stroke="currentColor" stroke-width="4.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + g + '</svg>';
  }

  var CSS =
    '.a1-app-ic{display:inline-block;width:1em;height:1em;margin-right:.4em;vertical-align:-.15em;flex-shrink:0;' +
      'color:var(--a1-app-ic,var(--ac,var(--accent,#c0aeea)));line-height:0}' +
    '.a1-app-ic svg{width:100%;height:100%;display:block}' +
    // Inside a flex title the gap is the title's own; the margin is dropped.
    '.a1-app-ic.a1-flex{margin-right:0}' +
    '.a1-sync{display:inline-flex;align-items:center;gap:6px;font-family:Inter,system-ui,-apple-system,sans-serif;' +
      'font-size:10.5px;font-weight:700;letter-spacing:0;text-transform:none;line-height:1.2;color:var(--a1-sync-tx,#adadb2);' +
      'padding:0 4px;white-space:nowrap;transition:opacity .45s;border:0;background:transparent}' +
    '.a1-sync.idle{opacity:0;pointer-events:none}' +
    '.a1-sync .a1-sync-dot{width:7px;height:7px;border-radius:50%;background:#8d8d94;flex-shrink:0}' +
    '.a1-sync.ok .a1-sync-dot{background:#a4b986}' +
    '.a1-sync.busy .a1-sync-dot{background:#e0b874;animation:a1SyncPulse 1s infinite}' +
    '.a1-sync.err{color:#d68a7c}.a1-sync.err .a1-sync-dot{background:#d68a7c}' +
    '.a1-sync.off .a1-sync-dot{background:#8d8d94}' +
    '@keyframes a1SyncPulse{0%,100%{opacity:1}50%{opacity:.35}}';

  function addStyle() {
    if (document.getElementById('a1-apphead-css')) return;
    var s = document.createElement('style');
    s.id = 'a1-apphead-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  addStyle();

  function fill(root) {
    var els = (root || document).querySelectorAll('.a1-app-ic[data-a1-app]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], name = el.getAttribute('data-a1-app');
      if (el.getAttribute('data-a1-filled') === name) continue;
      el.innerHTML = icon(name);
      el.setAttribute('data-a1-filled', name);
      el.setAttribute('aria-hidden', 'true');
    }
  }

  var WORD = { busy: 'Syncing…', ok: 'Synced', err: 'Sync failed', off: 'Offline' };
  var timers = typeof WeakMap === 'function' ? new WeakMap() : null;
  function sync(el, kind) {
    if (!el) return;
    if (!el.querySelector('.a1-sync-dot')) {
      el.innerHTML = '<span class="a1-sync-dot"></span><span class="a1-sync-text"></span>';
      if (!el.hasAttribute('role')) el.setAttribute('role', 'status');
      if (!el.hasAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
    }
    el.classList.add('a1-sync');
    if (timers) clearTimeout(timers.get(el));
    ['idle', 'ok', 'busy', 'err', 'off'].forEach(function (k) { el.classList.remove(k); });
    if (kind === 'idle') { el.classList.add('idle'); return; }
    if (!WORD[kind]) kind = 'ok';
    if (kind === 'ok' && navigator.onLine === false) kind = 'off';
    el.classList.add(kind);
    el.querySelector('.a1-sync-text').textContent = WORD[kind];
    el.setAttribute('data-sync', kind);
    if (kind === 'ok' && timers) {
      timers.set(el, setTimeout(function () { el.classList.add('idle'); }, 2000));
    }
  }

  window.A1Head = { icon: icon, fill: fill, sync: sync, names: Object.keys(G) };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { addStyle(); fill(); });
  } else fill();
})();
