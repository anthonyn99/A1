/**
 * LifeHub — the A1 app switcher. Built once, used by every program.
 *
 * WHAT IT IS
 * A launcher (three app tiles and an accent diamond) that sits in a program's header and opens a grid of every
 * A1 app. Tap one and it opens — or, if it is already open in another tab,
 * that tab comes forward instead of a duplicate appearing. The list is data,
 * not code: names, links, icons, order and visibility are edited inside the
 * popup and live in ONE Firestore document, so a change made on the desktop
 * shows up in every program on every device.
 *
 * HOW A PROGRAM USES IT (the whole integration — see LifeHub/README.md)
 *
 *   <a1-lifehub></a1-lifehub>                         ← in the header, where the icon goes
 *   <script src="LifeHub/lifehub.js" defer
 *           data-lock="#applock-overlay"></script>    ← once, before </body>
 *
 *   data-lock          CSS selector for the program's existing lock screen.
 *                      While that element is on screen the launcher is not
 *                      rendered at all (display:none — no empty slot).
 *   data-profile-attr  For programs with Tony AND Veda profiles: the <body>
 *                      attribute that holds the active profile ("tony" or
 *                      "veda"). Each profile has its OWN list (its own doc),
 *                      and the launcher follows the attribute live. Omit it
 *                      for Tony-only programs.
 *   data-accent        The program's accent colour (default A1 gold).
 *   data-accent-veda   Veda's accent in a profile program (default #A892B0).
 *
 * A program whose Firebase starts lazily (MAGI) sets window.LifeHubFirebase to
 * an async function returning { db, fs } so LifeHub borrows that instance
 * instead of racing it to initializeFirestore.
 *
 * LOCAL PROGRAMS
 * An app's link can be a Windows path (C:\…\app.exe, \\server\share\…)
 * instead of a URL. A browser cannot start a program, so — exactly like
 * TaskHub's External Links (index.html _doOpen) — the click hands off to the
 * Shield desktop agent as `shieldopen:lh:<profile>:<id>`. The path itself
 * never travels in the link: the agent resolves the opaque id against the
 * map shield.html pushes it from this list (LifeHub.localLinks). Inside the
 * agent's own window the host launches it directly (configure({ openLocal })).
 * Devices that cannot launch local programs (phones, Macs) don't show those
 * tiles outside edit mode.
 *
 * WHY A CUSTOM ELEMENT
 * Half the hosts render their header with React, which rebuilds nodes as it
 * pleases. A custom element upgrades itself whenever and wherever it is
 * inserted, so a React header, a hand-written one and a future one all get the
 * same launcher with nothing to re-wire. Everything inside lives in shadow DOM:
 * no host stylesheet can bend it and none of its styles can leak out.
 *
 * FIREBASE (Spark plan — every read and write counts)
 *   • Nothing touches Firestore until the launcher is hovered, focused or
 *     tapped. A program that is opened and never used for switching costs 0.
 *   • Then ONE onSnapshot on ONE document (~2 KB) — 1 read to attach, 1 per
 *     real change after that. Unchanged data is never downloaded again.
 *   • No new Firebase app or connection: the host's modules are imported by
 *     the same URL, so the browser hands back the very same instances.
 *   • Drag, typing and toggling are local. A change becomes an OPERATION
 *     ("move these ids into this order", "rename x"); operations are batched
 *     for 350 ms and committed in a single transaction that re-applies them to
 *     whatever the server holds. That costs one read per save, and is what
 *     makes two devices editing at once merge instead of one silently erasing
 *     the other. Identical results are never written.
 *   • Tabs in the same browser share a localStorage mirror, so they update each
 *     other through the `storage` event for free.
 *   • A remote update that lands mid-drag or mid-edit is held until the
 *     gesture ends, then rebased under the local change — never mid-gesture.
 *
 * TABS
 * openTab() below is a port of index.html's _tnOpenTab (same window names,
 * same tab keys, same tabsync.js handshake), so a tab opened from TaskHub and
 * one opened from LifeHub are the SAME tab. The limits documented there apply
 * here unchanged: a tab the user opened by hand (bookmark, typed url) carries
 * no name and cannot be found by any web API; cross-origin links keep the
 * window-name pairing only.
 */
(function () {
  'use strict';
  var BOOT = document.currentScript;
  var FRESH = /[?&]lhfresh=/.test((BOOT && BOOT.src) || '');
  if (window.LifeHub || (window.__lifehubBoot && !FRESH)) return;
  window.__lifehubBoot = true;

  /* ── Always the deployed version ─────────────────────────────────────────
     GitHub Pages serves this file with max-age=600, so a plain refresh of a
     program reloads the PAGE but may run LifeHub from the HTTP cache for up to
     ten minutes after a deploy. So before running, ask the server whether this
     copy is still current: a conditional request (If-None-Match), which is a
     bodiless 304 when nothing changed — and which, when something did,
     replaces the cached copy as a side effect. If the server's text no longer
     contains this very code (main.toString()), the new version is loaded under
     a one-off URL with the same data-* attributes and this copy never runs.
     Bounded: offline, blocked or slow (> 1.5 s), the cached copy runs as
     before. Hosts that need LifeHub after load listen for `lifehub:ready`. */
  if (FRESH || !BOOT || !BOOT.src || typeof fetch !== 'function') { main(BOOT); return; }
  var started = false;
  function runCached() { if (!started) { started = true; main(BOOT); } }
  var guard = setTimeout(runCached, 1500);
  fetch(BOOT.src, { cache: 'no-cache', credentials: 'same-origin' }).then(function (r) {
    return r.ok ? r.text() : null;
  }).then(function (txt) {
    if (started) return;
    if (!txt || txt.indexOf(String(main)) !== -1) { clearTimeout(guard); runCached(); return; }
    clearTimeout(guard);
    started = true;
    var s = document.createElement('script');
    for (var i = 0; i < BOOT.attributes.length; i++) {
      var at = BOOT.attributes[i];
      if (at.name !== 'src' && at.name !== 'defer' && at.name !== 'async') s.setAttribute(at.name, at.value);
    }
    s.onerror = function () { main(BOOT); };
    s.src = BOOT.src.split('#')[0] + (BOOT.src.indexOf('?') < 0 ? '?' : '&') + 'lhfresh=' + Date.now();
    (document.body || document.head || document.documentElement).appendChild(s);
  }).catch(runCached);

  function main(SCRIPT) {
  if (window.LifeHub) return;
  function sattr(n) { return (SCRIPT && SCRIPT.getAttribute(n)) || ''; }

  var CFG = {
    lock: sattr('data-lock'),
    profileAttr: sattr('data-profile-attr'),
    accent: sattr('data-accent'),
    accentVeda: sattr('data-accent-veda') || '#A892B0',
    locked: null,     // optional fn, via LifeHub.configure
    profile: null,    // optional fn, via LifeHub.configure
    openLocal: null   // optional fn(path, app) → true if the host launched it
  };

  var VERSION = '1.3.0';
  var DOC_COLL = 'dashboards';
  var FB_VER = '12.12.0';
  var FB_CONFIG = {
    apiKey: 'AIzaSyC2aKunOKj5WS8NpgZhpyMzOYecBr5t2_4',
    authDomain: 'task-dashboard-d2b53.firebaseapp.com',
    projectId: 'task-dashboard-d2b53',
    storageBucket: 'task-dashboard-d2b53.firebasestorage.app',
    messagingSenderId: '982539604706',
    appId: '1:982539604706:web:e93da1aef499fcee2044bb'
  };
  var APPCHECK_KEY = '6LeUyAstAAAAAEciRypd1i4Akq6ueFUYfXLaLaUX';
  var CLIENT = Math.random().toString(36).slice(2, 10);

  /* ── Icons ────────────────────────────────────────────────────────────────
     Each program's own favicon, verbatim from its <link rel="icon">, so the
     launcher shows exactly the mark the browser tab already shows. Referenced
     from data as "a1:<key>"; any other icon is a url or data:image. */
  var ICONS = {
    oneinbox: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#1a1a1d'/><g fill='none' stroke='#e0b874' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'><rect x='20' y='28' width='56' height='40' rx='6'/><path d='M20 33 48 54 76 33'/></g><circle cx='75' cy='27' r='9' fill='#1a1a1d'/><circle cx='75' cy='27' r='5.5' fill='#e0b874'/></svg>",
    tradehub: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#1a1a1d'/><g fill='none' stroke='#e0b874' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'><path d='M24 22v50a2 2 0 0 0 2 2h48'/><path d='M34 62l12-14 10 9 16-21'/><path d='M60 36h12v12'/></g></svg>",
    mylist: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#1a1a1d'/><g fill='none' stroke='#e0b874' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'><path d='M42 32h30'/><path d='M42 48h30'/><path d='M42 64h30'/><circle cx='28' cy='32' r='3.5' fill='#e0b874' stroke='none'/><circle cx='28' cy='48' r='3.5' fill='#e0b874' stroke='none'/><circle cx='28' cy='64' r='3.5' fill='#e0b874' stroke='none'/></g></svg>",
    insight: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#1a1a1d'/><g fill='none' stroke='#e0b874' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'><path d='M48 24a24 24 0 1 0 24 24H48Z'/><path d='M60 20a20 20 0 0 1 16 16H60Z'/></g></svg>",
    vault: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#1a1a1d'/><g fill='none' stroke='#e0b874' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'><rect x='22' y='42' width='52' height='34' rx='7'/><path d='M33 42v-9a15 15 0 0 1 30 0v9'/><path d='M48 55v8'/></g></svg>",
    solace: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#1a1a1d'/><g fill='none' stroke='#e0b874' stroke-linecap='round' stroke-linejoin='round'><path d='M48 70C33.5 59.5 25 51 25 41.5 25 34 30.5 28.5 37.5 28.5 42.5 28.5 46 31.5 48 34.5 50 31.5 53.5 28.5 58.5 28.5 65.5 28.5 71 34 71 41.5 71 51 62.5 59.5 48 70Z' stroke-width='5'/><path d='M34 45h6l4-8.5 5.5 16 4-7.5h8.5' stroke-width='4'/></g></svg>",
    shield: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#1a1a1d'/><g fill='none' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'><path d='M48 14 22 23v24c0 17 13 28 26 35' stroke='#e0b874'/><path d='M48 14 74 23v24c0 17-13 28-26 35' stroke='#8D769A'/><circle cx='48' cy='42' r='7' stroke='#adadb2'/><path d='M48 49v11' stroke='#adadb2'/></g></svg>",
    // The desktop agent: Shield's two-tone mark on a monitor, so the app and
    // its web page are told apart at a glance.
    'shield-desktop': "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#1a1a1d'/><g fill='none' stroke-width='4.5' stroke-linecap='round' stroke-linejoin='round'><rect x='16' y='20' width='64' height='44' rx='7' stroke='#adadb2'/><path d='M38 76h20M48 64v12' stroke='#adadb2'/><path d='M48 29 36 33.5v9c0 7 5.5 11.5 12 14.5' stroke='#e0b874'/><path d='M48 29 60 33.5v9c0 7-5.5 11.5-12 14.5' stroke='#8D769A'/></g></svg>",
    riftiq: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#16161c'/><path d='M48 19 73 33.5v29L48 77 23 62.5v-29Z' fill='none' stroke='#5a5a68' stroke-width='4' stroke-linejoin='round'/><path d='M48 26l5 12v18H43V38Z' fill='#c0aeea'/><rect x='33' y='56' width='30' height='6' rx='3' fill='#dbd0f5'/><rect x='45' y='62' width='6' height='11' rx='3' fill='#83838f'/></svg>",
    magi: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#1a1a1d'/><g fill='none' stroke='#c0aeea' stroke-width='4.2'><circle cx='48' cy='35.3' r='14.5'/><circle cx='36.4' cy='54.4' r='14.5'/><circle cx='59.6' cy='54.4' r='14.5'/></g><circle cx='48' cy='47.7' r='5.4' fill='#dbd0f5'/></svg>",
    taskhub: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#1a1a1d'/><g fill='none' stroke='#e0b874' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'><path d='M26 34l7 7 12-13'/><path d='M56 36h16'/><path d='M26 58h46'/><path d='M26 72h46'/></g></svg>",
    link: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' rx='22' fill='#1a1a1d'/><g fill='none' stroke='#e0b874' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'><circle cx='48' cy='48' r='24'/><path d='M24 48h48'/><path d='M48 24c7 7 10 15 10 24s-3 17-10 24c-7-7-10-15-10-24s3-17 10-24z'/></g></svg>"
  };
  var ICON_KEYS = Object.keys(ICONS);

  /* ── Initial configuration ────────────────────────────────────────────────
     Seed data only — written to Firestore once, the first time the document is
     found missing, and editable from then on. Nothing in the UI reads these
     names; it reads the synced list.

     `tab` is the named-window key. The ones TaskHub already uses are kept
     identical (tradehub, warroom, vault, solace, magi, shield_tony) so both
     launchers land on one tab per program. */
  var BASE = 'https://anthonyn99.github.io/A1/';
  var SHIELD_EXE = {
    tony: 'C:\\Users\\antho\\AppData\\Local\\Shield\\shield-agent.exe',
    veda: 'C:\\Users\\vedap\\AppData\\Local\\Shield\\shield-agent.exe'
  };
  // The link the Shield tile carried before local paths existed. Lists that
  // still hold it are moved to the real path once, on first sync.
  var LEGACY_SHIELD_LINK = 'shieldopen:show';
  var DEFAULT_APPS = [
    { id: 'oneinbox', name: 'OneInbox', url: BASE + 'oneinbox.html', icon: 'a1:oneinbox', tab: 'oneinbox' },
    { id: 'tradehub', name: 'TradeHub', url: BASE + 'tradehub.html', icon: 'a1:tradehub', tab: 'tradehub' },
    { id: 'mylist', name: 'MyList', url: BASE + 'mylist.html', icon: 'a1:mylist', tab: 'mylist' },
    { id: 'insight', name: 'Insight', url: BASE + 'insight.html', icon: 'a1:insight', tab: 'insight' },
    { id: 'vault', name: 'Vault', url: BASE + 'vault.html', icon: 'a1:vault', tab: 'vault' },
    { id: 'solace', name: 'Solace', url: BASE + 'solace.html', icon: 'a1:solace', tab: 'solace' },
    // The desktop agent, by its installed path (per-user NSIS install). It is
    // a local program like any other: the click goes through shieldopen:lh:…,
    // and the agent starting its own exe is a second launch, which surfaces
    // the running agent's window (lib.rs single-instance handler).
    { id: 'shield', name: 'Shield', url: SHIELD_EXE.tony, icon: 'a1:shield-desktop', tab: 'shield_app' },
    { id: 'shield_html', name: 'Shield (HTML)', url: BASE + 'shield.html', icon: 'a1:shield', tab: 'shield_tony' },
    { id: 'riftiq', name: 'RiftIQ', url: BASE + 'riftiq.html', icon: 'a1:riftiq', tab: 'warroom' },
    { id: 'magi', name: 'MAGI', url: BASE + 'magi.html', icon: 'a1:magi', tab: 'magi' }
  ];
  // Veda's own list: the programs that carry a Veda profile. Tab keys follow
  // TaskHub's per-profile ones (shield_veda), so both open the same tab.
  var VEDA_APPS = [
    { id: 'mylist', name: 'MyList', url: BASE + 'mylist.html', icon: 'a1:mylist', tab: 'mylist' },
    { id: 'shield', name: 'Shield', url: SHIELD_EXE.veda, icon: 'a1:shield-desktop', tab: 'shield_app' },
    { id: 'shield_html', name: 'Shield (HTML)', url: BASE + 'shield.html', icon: 'a1:shield', tab: 'shield_veda' }
  ];

  // One list per profile, each its own document and its own local mirror.
  // Tony's keeps the original names so nothing existing moves.
  var PROFILES = {
    tony: { doc: 'lifehub', ls: 'lifehub:v1', defaults: DEFAULT_APPS },
    veda: { doc: 'lifehub_veda', ls: 'lifehub:v1:veda', defaults: VEDA_APPS }
  };
  function isProfile(p) { return p === 'tony' || p === 'veda'; }

  /* ── Small helpers ────────────────────────────────────────────────────── */
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function cleanApp(a) {
    if (!a || typeof a !== 'object') return null;
    var id = String(a.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
    if (!id) return null;
    return {
      id: id,
      name: String(a.name || '').trim().slice(0, 40) || id,
      url: String(a.url || '').trim().slice(0, 2048),
      icon: String(a.icon || '').slice(0, 60000),
      tab: String(a.tab || ('lh_' + id)).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64),
      hidden: !!a.hidden
    };
  }
  function cleanList(list) {
    if (!Array.isArray(list)) return null;
    var seen = {}, out = [];
    list.forEach(function (a) {
      var c = cleanApp(a);
      if (c && !seen[c.id]) { seen[c.id] = 1; out.push(c); }
    });
    return out;
  }

  // Anything a page must never navigate to on the strength of synced data.
  var BAD_SCHEME = /^(javascript|data|vbscript|blob|file|about):/i;
  // A local Windows path (C:\…, C:/… or a \\server\share UNC path). MUST match
  // index.html's _isLocalPath and shield.html's isLocalPath exactly — the
  // agent only ever accepts what that same test accepts.
  function isLocalPath(u) {
    return typeof u === 'string' && !/^https?:\/\//i.test(u) && (/^[A-Za-z]:[\\/]/.test(u) || /^\\\\/.test(u));
  }
  // Only Windows can launch one (through the Shield agent). Elsewhere those
  // tiles would be dead buttons, so they are left out of the grid.
  var CAN_LOCAL = /Windows NT/i.test(navigator.userAgent || '') && !/Windows Phone/i.test(navigator.userAgent || '');
  function localKey(profile, id) { return 'lh:' + profile + ':' + id; }
  function normUrl(u) {
    u = String(u || '').trim();
    // Explorer's "Copy as path" wraps the path in quotes.
    if (/^"[^"]*"$/.test(u)) u = u.slice(1, -1).trim();
    if (!u) return '';
    // file:///C:/x.exe → C:\x.exe, the only form of file: worth keeping.
    var fm = /^file:\/\/\/([A-Za-z]:\/.*)$/i.exec(u);
    if (fm) { try { u = decodeURIComponent(fm[1]).replace(/\//g, '\\'); } catch (e) { return ''; } }
    // No control characters or characters Windows forbids in a path — they
    // could only be a mistake or an attempt to split the agent's command line.
    if (isLocalPath(u)) return /[\x00-\x1f"<>|?*]/.test(u) || /:/.test(u.slice(2)) ? '' : u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z]:[\\/]/i.test(u)) return BAD_SCHEME.test(u) ? '' : u;
    if (/^\/\//.test(u)) return 'https:' + u;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([\/?#]|$)/.test(u)) return 'https://' + u;
    return '';
  }
  function isWeb(u) { return /^https?:\/\//i.test(u); }
  // Same program? Origin + path, ignoring query/hash, a trailing index.html
  // and trailing slashes — the rule index.html uses for StudyOS.
  function destKey(u) {
    try {
      var x = new URL(u, location.href);
      return (x.origin + x.pathname.replace(/\/index\.html?$/i, '/').replace(/\/+$/, '')).toLowerCase();
    } catch (e) { return ''; }
  }
  function isHere(u) { return isWeb(u) && destKey(u) === destKey(location.href); }

  /* ── Named tabs — ported from index.html's _tnOpenTab ─────────────────────
     Keep in step with that function and with tabsync.js (the destination
     side). tests/lifehub-wiring.test.js pins the shared protocol. */
  function tabName(key) { return 'a1tab_' + String(key).replace(/[^A-Za-z0-9_]/g, '_'); }
  function storeKey(key) { return tabName(key).slice(6); }
  function atDest(cur, url) {
    var c = String(cur).split('#')[0], u = String(url).split('#')[0];
    return c === u || c.indexOf(u) === 0;
  }
  function go(w, url) {
    try { w.location.replace(url); } catch (e) { try { w.location.href = url; } catch (e2) {} }
    try { w.focus(); } catch (e) {}
  }
  function claimedElsewhere(key) {
    try {
      var r = JSON.parse(localStorage.getItem('a1tab:' + key) || 'null');
      return !!(r && r.t && (Date.now() - r.t) < 20000);
    } catch (e) { return false; }
  }
  // A tab restored after a browser restart still claims this key but is
  // invisible to window.open(name). Ask it over the channel: it either comes
  // forward (we close the blank tab we hold) or retires (we use ours).
  function handOver(w, url, key) {
    var bc = null;
    try { bc = new BroadcastChannel('a1tabs'); } catch (e) { bc = null; }
    if (!bc) { go(w, url); return; }
    var rid = Math.random().toString(36).slice(2);
    var settled = false, answered = false;
    var timer = setTimeout(function () { finish(false); }, 300);
    function finish(focused) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (focused) { try { w.close(); } catch (e) {} }
      else {
        if (answered) { try { bc.postMessage({ t: 'retire', k: key }); } catch (e) {} }
        go(w, url);
      }
      setTimeout(function () { try { bc.close(); } catch (e) {} }, 1500);
    }
    bc.onmessage = function (ev) {
      var d = ev && ev.data;
      if (!d || d.t !== 'claimed' || d.k !== key || d.rid !== rid) return;
      answered = true;
      // busy / not closable: retiring would lose a run or leave two tabs.
      finish(!!d.ok || !!d.busy || d.closable === false);
    };
    try { bc.postMessage({ t: 'claim', k: key, rid: rid }); } catch (e) { finish(false); }
  }
  // Must run synchronously inside the click: opening the tab is what spends
  // the user gesture. Deliberately never 'noopener' — the opener link is what
  // keeps the named tab findable (see index.html).
  function openTab(url, key) {
    var name = tabName(key);
    var w = null;
    try { w = window.open('', name); } catch (e) { w = null; }
    if (!w) return null;
    var cur = null;
    try { cur = w.location.href; } catch (e) { cur = null; }
    if (cur === null) { try { w.focus(); } catch (e) {} return w; }
    if (cur !== '' && cur !== 'about:blank') {
      if (atDest(cur, url)) { try { w.focus(); } catch (e) {} } else { go(w, url); }
      return w;
    }
    var sk = storeKey(key);
    try { w.name = name; } catch (e) {}
    if (claimedElsewhere(sk)) handOver(w, url, sk);
    else go(w, url);
    return w;
  }

  /* ══ Store ═════════════════════════════════════════════════════════════════
     One per profile (see PROFILES), made on first use. Each holds:
     base  — the last list the server was known to hold
     ops   — local changes not yet committed, as functions over a list
     apps  — what is shown: ops replayed on top of base

     A remote snapshot replaces base and re-derives apps, so a local change
     that has not reached the server yet is never lost under it.

     `S` is the store of the profile on screen; the UI only ever reads S.
     Everything that crosses an await takes its store explicitly, so a profile
     switch mid-save can never land one profile's list in the other's doc. */
  var stores = {};
  var S = null;
  function storeFor(p) {
    if (!stores[p]) stores[p] = makeStore(p);
    return stores[p];
  }
  function makeStore(p) {
    var P = PROFILES[p];
    var st = {
      profile: p, doc: P.doc, lsKey: P.ls, defaults: P.defaults,
      base: null, apps: null, ops: [],
      busy: 0, stale: false, needSeed: false,
      inflight: false, again: false, wt: 0,
      unsub: null, subscribing: false, gen: 0, status: '',
      retryT: 0, retryN: 0, watched: false
    };
    var c = null;
    try { c = JSON.parse(localStorage.getItem(st.lsKey) || 'null'); } catch (e) { c = null; }
    var base = c && cleanList(c.base);
    var apps = c && cleanList(c.apps);
    st.base = base || clone(st.defaults);
    st.apps = apps || clone(st.base);
    // Edits made while offline that never reached the server survive a reload
    // as one "make it look like this" operation.
    if (c && c.pending && apps && !same(apps, st.base)) st.ops = [replaceOp(apps)];
    return st;
  }

  function saveCache(st) {
    try {
      localStorage.setItem(st.lsKey, JSON.stringify({ base: st.base, apps: st.apps, pending: st.ops.length > 0 }));
    } catch (e) {}
  }

  function replay(ops, list) {
    return ops.reduce(function (acc, op) { return cleanList(op(clone(acc))) || acc; }, list);
  }
  function setApps(st, next) {
    if (same(next, st.apps)) return;
    st.apps = next;
    saveCache(st);
    if (st === S) render();
  }
  function refreshFromBase(st) {
    st.stale = false;
    setApps(st, replay(st.ops, st.base));
    saveCache(st);
  }
  function receiveBase(st, list) {
    st.base = list;
    notifyLocal();
    if (st.busy) { st.stale = true; saveCache(st); return; }
    refreshFromBase(st);
  }
  function beginBusy() { S.busy++; }
  function endBusy() {
    S.busy = Math.max(0, S.busy - 1);
    if (!S.busy && S.stale) refreshFromBase(S);
  }
  function commit(st, op) {
    if (st.stale) refreshFromBase(st);
    st.ops.push(op);
    setApps(st, replay([op], st.apps));
    saveCache(st);
    scheduleWrite(st);
  }

  /* Operations. Each is applied to whatever list is current when it lands,
     so it names ids, never positions. */
  function replaceOp(list) { list = clone(list); return function () { return clone(list); }; }
  function patchOp(id, patch) {
    return function (list) {
      return list.map(function (a) { return a.id === id ? Object.assign({}, a, patch) : a; });
    };
  }
  function addOp(app) {
    return function (list) { return byId(list, app.id) ? list : list.concat([app]); };
  }
  function removeOp(id) {
    return function (list) { return list.filter(function (a) { return a.id !== id; }); };
  }
  // `order` is the ids that were on screen, in their new order. Only the slots
  // those ids occupy are refilled, so apps that were hidden (or added by
  // another device meanwhile) keep their places.
  function reorderOp(order) {
    return function (list) {
      var map = {};
      list.forEach(function (a) { map[a.id] = a; });
      var ids = order.filter(function (id) { return map[id]; });
      var set = {};
      ids.forEach(function (id) { set[id] = 1; });
      var k = 0;
      return list.map(function (a) { return set[a.id] ? map[ids[k++]] : a; });
    };
  }
  // The Shield tile used to hand off with shieldopen:show. Move a list that
  // still carries it to the agent's real path — once, as an ordinary patch,
  // so it merges and is never written twice (an identical result is skipped).
  function migrate(st, list) {
    var a = byId(list, 'shield'), d = byId(st.defaults, 'shield');
    if (a && d && a.url === LEGACY_SHIELD_LINK && !st.migrated) {
      st.migrated = true;
      commit(st, patchOp('shield', { url: d.url }));
    }
  }

  /* ── Firebase ───────────────────────────────────────────────────────────── */
  function fbVersion() {
    try {
      var r = performance.getEntriesByType('resource');
      for (var i = 0; i < r.length; i++) {
        var m = /firebasejs\/([\d.]+)\/firebase-app\.js/.exec(r[i].name);
        if (m) return m[1];
      }
      var ss = document.querySelectorAll('script[type="module"]');
      for (var j = 0; j < ss.length; j++) {
        var m2 = /firebasejs\/([\d.]+)\/firebase-app\.js/.exec(ss[j].textContent || '');
        if (m2) return m2[1];
      }
    } catch (e) {}
    return FB_VER;
  }
  function waitFor(fn, ms) {
    return new Promise(function (res) {
      var t0 = Date.now();
      (function poll() {
        var v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v || Date.now() - t0 >= ms) return res(v || null);
        setTimeout(poll, 150);
      })();
    });
  }

  var conn = null;
  function connect() {
    if (!conn) {
      conn = openFirestore();
      conn.catch(function () { conn = null; });
    }
    return conn;
  }
  function docRef(c, st) { return c.fs.doc(c.db, DOC_COLL, st.doc); }
  // Forget this store's listener and the cached connection. Bumping `gen`
  // orphans any attach still in flight, so a retry can never leave two
  // listeners on one document (two reads per change, forever).
  function dropConnection(st) {
    st.gen++;
    if (st.unsub) { try { st.unsub(); } catch (e) {} }
    st.unsub = null;
    st.subscribing = false;
    conn = null;
  }

  async function openFirestore() {
    // A host whose Firebase starts on demand hands over its own instance.
    if (typeof window.LifeHubFirebase === 'function') {
      var h = await window.LifeHubFirebase();
      if (!h || !h.db) throw new Error('host Firebase unavailable');
      var hfs = h.fs || await import('https://www.gstatic.com/firebasejs/' + fbVersion() + '/firebase-firestore.js');
      return { db: h.db, fs: hfs };
    }
    var V = 'https://www.gstatic.com/firebasejs/' + fbVersion();
    var mods = await Promise.all([
      import(V + '/firebase-app.js'),
      import(V + '/firebase-auth.js'),
      import(V + '/firebase-firestore.js')
    ]);
    var appM = mods[0], authM = mods[1], fs = mods[2];
    function defApp() {
      var a = appM.getApps();
      for (var i = 0; i < a.length; i++) if (a[i].name === '[DEFAULT]') return a[i];
      return null;
    }
    // Normally the host has long since initialised everything by the time
    // anyone reaches for the launcher; the waits only matter on a cold start.
    var app = await waitFor(defApp, 4000);
    var own = false, db = null;
    if (!app) {
      // A program with no Firebase of its own: bring up the suite's, exactly
      // as the others do (same config, same App Check key, anonymous auth).
      own = true;
      app = appM.initializeApp(FB_CONFIG);
      try {
        var ac = await import(V + '/firebase-app-check.js');
        ac.initializeAppCheck(app, { provider: new ac.ReCaptchaV3Provider(APPCHECK_KEY), isTokenAutoRefreshEnabled: true });
      } catch (e) {}
      db = fs.initializeFirestore(app, { localCache: fs.memoryLocalCache() });
    } else {
      // Never call getFirestore before the host's initializeFirestore — ours
      // would claim the instance with default settings and the host's own
      // call would then throw. Wait until the host has made it.
      var ready = typeof appM._getProvider === 'function'
        ? await waitFor(function () { return appM._getProvider(app, 'firestore').isInitialized(); }, 6000)
        : true;
      if (ready) db = fs.getFirestore(app);
      else {
        try { db = fs.initializeFirestore(app, { localCache: fs.memoryLocalCache() }); }
        catch (e) { db = fs.getFirestore(app); }
      }
    }
    var auth = authM.getAuth(app);
    try { if (auth.authStateReady) await auth.authStateReady(); } catch (e) {}
    if (!auth.currentUser && !own) {
      await new Promise(function (res) {
        var t = setTimeout(done, 5000), off = null;
        function done() { clearTimeout(t); try { off && off(); } catch (e) {} res(); }
        off = authM.onAuthStateChanged(auth, function (u) { if (u) done(); });
      });
    }
    if (!auth.currentUser) await authM.signInAnonymously(auth);
    return { db: db, fs: fs };
  }

  // Idempotent: the one listener per profile, attached on first use and kept.
  function ensureSync(st) {
    if (st.unsub || st.subscribing) return;
    st.subscribing = true;
    var gen = st.gen;
    connect().then(function (c) {
      if (gen !== st.gen) return;
      st.unsub = c.fs.onSnapshot(docRef(c, st), function (snap) { onSnap(st, snap); }, function () {
        if (gen !== st.gen) return;
        dropConnection(st);
        goOffline(st);
      });
    }).catch(function () {
      if (gen === st.gen) goOffline(st);
    }).then(function () { if (gen === st.gen) st.subscribing = false; });
  }

  function onSnap(st, snap) {
    if (snap.metadata.hasPendingWrites) return;
    if (st.status === 'offline' || st.status === 'retry' || st.status === 'refresh') setStatus(st, '');
    clearTimeout(st.retryT); st.retryT = 0; st.retryN = 0;
    if (!snap.exists()) {
      // Only trust "missing" from the server, never from an empty cache.
      if (!snap.metadata.fromCache) { st.needSeed = true; scheduleWrite(st); }
      return;
    }
    var list = cleanList((snap.data() || {}).apps);
    if (!list) return;
    if (!same(list, st.base)) receiveBase(st, list);
    migrate(st, list);
    if (st.ops.length) scheduleWrite(st);
  }

  /* ── Offline, and getting back ─────────────────────────────────────────────
     "Offline" used to be sticky: one failed attach (a cold host still signing
     in, a blip while the tab opened in the background) and nothing ever tried
     again until the panel was reopened. Now a failure retries on its own with
     a backoff, the moment the browser reports it is online or the tab comes
     back to the front, and on demand from the refresh button beside the label.
     Failed attempts cost nothing; a successful one is the single read the
     listener needed anyway. Retries only run while someone can use the result
     — the panel is open on this profile, there are unsaved changes, or a host
     is watching the list (the Shield agent) — so an idle program never polls. */
  var RETRY_MS = [2000, 5000, 15000, 30000, 60000];
  function wanted(st) { return (ui.open && st === S) || st.ops.length > 0 || st.needSeed || st.watched; }
  function goOffline(st) {
    setStatus(st, 'offline');
    clearTimeout(st.retryT);
    st.retryT = 0;
    if (!wanted(st)) return;
    var ms = RETRY_MS[Math.min(st.retryN, RETRY_MS.length - 1)];
    st.retryN++;
    st.retryT = setTimeout(function () {
      st.retryT = 0;
      // Re-checked at fire time: the panel may have closed since.
      if (wanted(st) && (document.visibilityState === 'visible' || st.watched)) retry(st);
    }, ms);
  }
  function retry(st, manual) {
    clearTimeout(st.retryT);
    st.retryT = 0;
    if (manual) st.retryN = 0;
    if (st.inflight) { st.again = true; return; }
    dropConnection(st);
    // 'retry' says "Connecting…" (we were offline); 'refresh' is a manual
    // re-sync while online: the button spins, no label.
    setStatus(st, st.status === 'offline' || st.status === 'retry' ? 'retry' : 'refresh');
    ensureSync(st);
    if (st.ops.length || st.needSeed) scheduleWrite(st);
  }
  function retryAllOffline() {
    Object.keys(stores).forEach(function (p) {
      var st = stores[p];
      if (st.status === 'offline' && wanted(st)) retry(st);
      else if (st.ops.length || st.needSeed) scheduleWrite(st);
    });
  }

  function scheduleWrite(st) {
    clearTimeout(st.wt);
    st.wt = setTimeout(function () { flush(st); }, 350);
  }

  async function flush(st) {
    st.wt = 0;
    if (!st.ops.length && !st.needSeed) return;
    if (st.inflight) { st.again = true; return; }
    st.inflight = true;
    setStatus(st, 'saving');
    var n = st.ops.length, ops = st.ops.slice(0, n), fallback = clone(st.base), failed = false;
    try {
      var c = await connect();
      var ref = docRef(c, st);
      var result = null;
      await c.fs.runTransaction(c.db, async function (tx) {
        var snap = await tx.get(ref);
        var exists = snap.exists();
        var server = (exists && cleanList((snap.data() || {}).apps)) || fallback;
        var next = replay(ops, server);
        result = next;
        if (exists && same(next, server)) return;   // nothing to write
        tx.set(ref, { v: 1, apps: next, rev: Date.now(), by: CLIENT });
      });
      st.ops.splice(0, n);
      st.needSeed = false;
      st.retryN = 0;
      setStatus(st, '');
      if (result) receiveBase(st, result);
      saveCache(st);
      ensureSync(st);
    } catch (e) {
      // Kept, not dropped: the ops stay queued and go out on the next attempt.
      failed = true;
      dropConnection(st);
    }
    st.inflight = false;
    if (failed) { st.again = false; goOffline(st); return; }
    if (st.again || st.ops.length) { st.again = false; scheduleWrite(st); }
  }

  window.addEventListener('online', retryAllOffline);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') retryAllOffline();
  });
  // Another A1 tab in this browser saved — adopt it without touching Firebase.
  window.addEventListener('storage', function (e) {
    if (!e.newValue) return;
    Object.keys(stores).forEach(function (p) {
      var st = stores[p];
      if (e.key !== st.lsKey) return;
      try {
        var c = JSON.parse(e.newValue);
        var list = cleanList(c && c.base);
        if (list && !same(list, st.base)) receiveBase(st, list);
      } catch (err) {}
    });
  });

  /* ── Local programs for the Shield agent ───────────────────────────────────
     LifeHub.localLinks(cb) — used by shield.html inside the desktop agent, and
     only there. Watches BOTH profiles' lists (the agent serves whichever
     profile's browser clicks) and reports { 'lh:<profile>:<id>': path } for
     every app whose link is a local path, from the server-confirmed list —
     at once from the local mirror, then on every real change. */
  var localWatchers = [];
  function localMap() {
    var out = {};
    Object.keys(stores).forEach(function (p) {
      stores[p].base.forEach(function (a) {
        var u = normUrl(a.url);
        if (isLocalPath(u)) out[localKey(p, a.id)] = u;
      });
    });
    return out;
  }
  var lastLocalSig = '';
  function notifyLocal() {
    if (!localWatchers.length) return;
    var m = localMap(), sig = JSON.stringify(m);
    if (sig === lastLocalSig) return;
    lastLocalSig = sig;
    localWatchers.forEach(function (cb) { try { cb(clone(m)); } catch (e) {} });
  }
  function watchLocal(cb) {
    if (typeof cb !== 'function') return;
    localWatchers.push(cb);
    ['tony', 'veda'].forEach(function (p) {
      var st = storeFor(p);
      st.watched = true;
      ensureSync(st);
    });
    lastLocalSig = '';
    notifyLocal();
  }

  /* ══ Visibility: locked / profile ═════════════════════════════════════════ */
  var launchers = new Set();
  var lastVis = null, watchT = 0, watching = false;

  // The profile on screen: 'tony', 'veda', or null (unknown — no launcher).
  function readProfile() {
    try {
      var p;
      if (typeof CFG.profile === 'function') p = CFG.profile();
      else if (!CFG.profileAttr) p = 'tony';
      else p = document.body && document.body.getAttribute(CFG.profileAttr);
      return isProfile(p) ? p : null;
    } catch (e) { return null; }
  }
  function lockedNow() {
    try {
      if (typeof CFG.locked === 'function') return !!CFG.locked();
      if (!CFG.lock) return false;
      var n = document.querySelectorAll(CFG.lock);
      for (var i = 0; i < n.length; i++) if (n[i].getClientRects().length) return true;
      return false;
    } catch (e) { return false; }
  }
  function computeVisible() { return !!readProfile() && !lockedNow(); }

  // Follow the host's profile: its own list, its own accent. A switch closes
  // the panel (it was showing the other person's apps) and drops the tiles,
  // since both lists use some of the same ids.
  var AP = null;
  function accentFor(p, l) { return p === 'veda' ? CFG.accentVeda : (CFG.accent || (l && l._hostAc) || ''); }
  function paintAccent(l) {
    var ac = accentFor(AP, l);
    if (ac) l.style.setProperty('--lh-ac', ac); else l.style.removeProperty('--lh-ac');
  }
  function useProfile(p) {
    if (p === AP && S) return;
    var had = !!S;
    AP = p;
    S = storeFor(p);
    launchers.forEach(paintAccent);
    if (!had || !ui.host) return;
    if (ui.open) close(true);
    var ac = accentFor(p, null);
    if (ac) ui.host.style.setProperty('--lh-ac', ac); else ui.host.style.removeProperty('--lh-ac');
    Object.keys(ui.tiles).forEach(function (id) { var t = ui.tiles[id]; if (t.parentNode) t.parentNode.removeChild(t); });
    ui.tiles = {};
    setStatus(S, S.status);
  }
  function applyVisible(force) {
    var p = readProfile();
    if (p && p !== AP) useProfile(p);
    var v = !!p && !lockedNow();
    if (v === lastVis && !force) return;
    lastVis = v;
    launchers.forEach(function (l) { if (l.hidden === v) l.hidden = !v; });
    if (!v) close();
  }
  function tick() { if (document.visibilityState === 'visible') applyVisible(false); }
  // A cheap local check twice a second — no DOM writes unless the answer
  // flips — which catches every host's lock/unlock without hooking each one.
  function startWatch() {
    if (!watchT) {
      watchT = setInterval(function () {
        if (!launchers.size) { clearInterval(watchT); watchT = 0; return; }
        tick();
      }, 500);
    }
    if (watching) return;
    watching = true;
    document.addEventListener('visibilitychange', tick);
    if (CFG.profileAttr && document.body) {
      try { new MutationObserver(tick).observe(document.body, { attributes: true, attributeFilter: [CFG.profileAttr] }); } catch (e) {}
    }
  }

  /* ══ Launcher element ═════════════════════════════════════════════════════ */
  // Three outlined app tiles and one solid diamond in the program's accent —
  // "your apps, and the one that moves you between them". The diamond turns
  // a quarter on hover and while the panel is open.
  var GRID_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="3.5" y="3.5" width="7" height="7" rx="2.2"/>' +
    '<rect x="3.5" y="13.5" width="7" height="7" rx="2.2"/>' +
    '<rect x="13.5" y="13.5" width="7" height="7" rx="2.2"/>' +
    '<rect class="core" x="14" y="4" width="6" height="6" rx="1.5"/>' +
    '</svg>';

  var LAUNCHER_CSS =
    ':host{display:inline-flex;flex:none;vertical-align:middle;line-height:0}' +
    ':host([hidden]){display:none!important}' +
    'button{all:unset;box-sizing:border-box;position:relative;width:var(--lh-size,34px);height:var(--lh-size,34px);' +
    'display:inline-grid;place-items:center;border-radius:10px;cursor:pointer;color:var(--lh-fg,#a3a1a6);' +
    '-webkit-tap-highlight-color:transparent;transition:background-color .15s,color .15s,transform .12s}' +
    'button svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linejoin:round;overflow:visible}' +
    'button svg .core{fill:var(--lh-ac,#e0b874);stroke:none;transform-box:fill-box;transform-origin:center;transform:rotate(45deg);' +
    'transition:transform .35s cubic-bezier(.2,.8,.2,1)}' +
    '@media (hover:hover){button:hover{background:rgba(128,128,128,.14);color:var(--lh-fg-hover,#ecebe8)}' +
    'button:hover svg .core{transform:rotate(135deg)}}' +
    'button[aria-expanded="true"] svg .core{transform:rotate(135deg)}' +
    'button:active{transform:scale(.9);background:rgba(128,128,128,.2)}' +
    'button[aria-expanded="true"]{background:rgba(128,128,128,.18);color:var(--lh-fg-hover,#ecebe8)}' +
    'button:focus-visible{outline:2px solid var(--lh-ac,#e0b874);outline-offset:2px}' +
    '@media (pointer:coarse){button::after{content:"";position:absolute;inset:-5px}}';

  class LauncherEl extends HTMLElement {
    connectedCallback() { launcherConnected(this); }
    disconnectedCallback() { launcherDisconnected(this); }
  }
  function launcherConnected(self) {
    if (!self.shadowRoot) {
      var root = self.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>' + LAUNCHER_CSS + '</style>' +
        '<button type="button" part="button" aria-label="A1 apps" aria-haspopup="dialog" aria-expanded="false" title="A1 apps">' + GRID_SVG + '</button>';
      var b = root.querySelector('button');
      self._btn = b;
      // Warm the one listener while the pointer is still on its way.
      b.addEventListener('pointerenter', warm);
      b.addEventListener('focus', warm);
      b.addEventListener('touchstart', warm, { passive: true });
      b.addEventListener('click', function () {
        if (!computeVisible()) { applyVisible(true); return; }
        if (ui.open && ui.anchor === self) close(); else open(self);
      });
    }
    self.setAttribute('data-no-hoverfx', '');
    // An accent the host wrote on the element itself is Tony's accent.
    if (self._hostAc === undefined) self._hostAc = self.style.getPropertyValue('--lh-ac');
    var p = readProfile();
    if (p) useProfile(p);
    paintAccent(self);
    launchers.add(self);
    var v = !!p && !lockedNow();
    if (self.hidden === v) self.hidden = !v;
    lastVis = v;
    startWatch();
  }
  // The listener of the profile on screen, and only that one.
  function warm() {
    var p = readProfile();
    if (!p) return;
    useProfile(p);
    ensureSync(S);
  }
  function launcherDisconnected(self) {
    launchers.delete(self);
    if (ui.open && ui.anchor === self) close();
  }

  /* ══ Panel ═════════════════════════════════════════════════════════════════ */
  var PANEL_CSS =
    ':host{all:initial}' +
    '*{box-sizing:border-box}' +
    '[hidden]{display:none!important}' +
    '.wrap{--bg:#1c1c20;--bg2:#242428;--bd:#2e2f33;--bd2:#3b3c42;--tx:#ecebe8;--tx2:#d2d0cc;--dim:#8f8e94;' +
    '--hov:rgba(255,255,255,.055);--act:rgba(255,255,255,.09);--in:#141417;--bad:#d68a7c;--ac:var(--lh-ac,#e0b874);' +
    'font:13px/1.35 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--tx);-webkit-font-smoothing:antialiased}' +
    '.bd{position:fixed;inset:0;background:transparent;touch-action:none;-webkit-tap-highlight-color:transparent}' +
    '.pop{position:fixed;display:flex;flex-direction:column;overflow:hidden;background:var(--bg);border:1px solid var(--bd);' +
    'border-radius:20px;box-shadow:0 24px 64px -12px rgba(0,0,0,.7),0 2px 10px rgba(0,0,0,.3);outline:none;' +
    'transform-origin:top right;animation:lh-in .16s cubic-bezier(.2,.8,.2,1)}' +
    '.pop.up{transform-origin:bottom right}.pop.left{transform-origin:top left}.pop.up.left{transform-origin:bottom left}' +
    '@keyframes lh-in{from{opacity:0;transform:scale(.95) translateY(-4px)}to{opacity:1;transform:none}}' +
    '@keyframes lh-rise{from{transform:translateY(100%)}to{transform:none}}' +
    '@keyframes lh-fade{from{opacity:0}to{opacity:1}}' +
    '.grab{display:none}' +
    '.m .bd{background:rgba(6,6,8,.52);animation:lh-fade .2s;will-change:opacity}' +
    // will-change: the sheet and dim get their own GPU layers up front, so the
    // dismiss animation starts on the first frame instead of after a layer is
    // built mid-gesture. A tighter shadow keeps that layer cheap on phones.
    '.m .pop{left:0!important;right:0;bottom:0;top:auto!important;width:auto!important;border-radius:22px 22px 0 0;border-bottom:0;' +
    'padding-bottom:env(safe-area-inset-bottom,0px);animation:lh-rise .26s cubic-bezier(.2,.8,.2,1);will-change:transform;' +
    'box-shadow:0 -8px 32px -10px rgba(0,0,0,.6)}' +
    '.m .grab{display:block;width:38px;height:4px;border-radius:2px;background:var(--bd2);margin:9px auto 0;flex:none}' +
    '.m .hd{touch-action:none}' +
    // Exit curves that move from the first frame (a plain ease-in barely
    // moves at the start, which reads as a hesitation after the tap).
    '.closing .pop{opacity:0;transform:scale(.97);transition:opacity .14s ease-out,transform .14s ease-out}' +
    '.m.closing .pop{opacity:1;transform:translateY(100%);transition:transform .18s cubic-bezier(.4,0,.2,1)}' +
    '.closing .bd{opacity:0;transition:opacity .18s cubic-bezier(.4,0,.2,1)}' +
    '.hd{display:flex;align-items:center;gap:8px;padding:14px 12px 6px 18px;flex:none}' +
    '.ttl{flex:1;min-width:0;font-size:15px;font-weight:600;letter-spacing:.1px;color:var(--tx)}' +
    '.st{font-size:11px;color:var(--dim);white-space:nowrap}.st.bad{color:var(--bad)}' +
    '.ib.rf{margin-right:-6px}.ib.rf svg{width:16px;height:16px}.ib.rf:disabled{cursor:default}' +
    '.rf.spin svg{animation:lh-spin .8s linear infinite}@keyframes lh-spin{to{transform:rotate(360deg)}}' +
    '.ib{all:unset;box-sizing:border-box;width:34px;height:34px;display:grid;place-items:center;border-radius:50%;cursor:pointer;' +
    'color:var(--dim);transition:background-color .15s,color .15s;-webkit-tap-highlight-color:transparent}' +
    '.ib svg{width:17px;height:17px}.ib:hover{background:var(--hov);color:var(--tx)}.ib:active{background:var(--act)}' +
    '.ib:focus-visible,.t:focus-visible,.b:focus-visible,.chip:focus-visible{outline:2px solid var(--ac);outline-offset:-2px}' +
    '.done{all:unset;box-sizing:border-box;height:32px;padding:0 14px;border-radius:16px;cursor:pointer;font-weight:600;font-size:12.5px;' +
    'color:var(--ac);border:1px solid color-mix(in srgb,var(--ac) 45%,transparent);-webkit-tap-highlight-color:transparent}' +
    '.done:hover{background:color-mix(in srgb,var(--ac) 10%,transparent)}' +
    '.sc{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:4px 10px 10px;scrollbar-width:thin;scrollbar-color:var(--bd2) transparent}' +
    '.grid{position:relative;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px}' +
    '.m .grid{grid-template-columns:repeat(4,minmax(0,1fr))}' +
    '@media (max-width:359px){.m .grid{grid-template-columns:repeat(3,minmax(0,1fr))}}' +
    '.t{all:unset;box-sizing:border-box;position:relative;min-width:0;display:flex;flex-direction:column;align-items:center;gap:8px;' +
    'padding:14px 4px 12px;border-radius:16px;cursor:pointer;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;' +
    '-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
    '@media (hover:hover){.t:hover{background:var(--hov)}.t:hover .ic{transform:translateY(-1px)}}' +
    '.t:active{background:var(--act)}' +
    '.ic{position:relative;width:48px;height:48px;border-radius:12px;display:grid;place-items:center;overflow:hidden;flex:none;' +
    'transition:transform .18s cubic-bezier(.2,.8,.2,1);pointer-events:none}' +
    '.ic::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);pointer-events:none}' +
    '.ic svg{width:100%;height:100%;display:block}.ic img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.ic.site,.ic.mono{background:var(--bg2);border:1px solid var(--bd)}.ic.site img{width:26px;height:26px;object-fit:contain}' +
    '.ic.mono{font-size:20px;font-weight:600;color:var(--ac)}' +
    '.nm{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--tx2);pointer-events:none}' +
    '.t.here .ic{box-shadow:0 0 0 2px var(--bg),0 0 0 3.5px var(--ac)}' +
    '.t.off .ic,.t.off .nm{opacity:.35}' +
    '.eb{display:none;position:absolute;top:7px;right:calc(50% - 34px);width:20px;height:20px;border-radius:50%;background:var(--bg2);' +
    'border:1px solid var(--bd2);color:var(--tx2);place-items:center;pointer-events:none}.eb svg{width:11px;height:11px}' +
    '.edit .t:not(.add) .eb{display:grid}' +
    '.edit .t:not(.add):not(.ph){animation:lh-wig .28s ease-in-out}' +
    '@keyframes lh-wig{0%,100%{transform:none}35%{transform:rotate(-1.2deg)}70%{transform:rotate(1.2deg)}}' +
    '.add .ic{border:1.5px dashed var(--bd2);color:var(--dim)}.add .ic svg{width:20px;height:20px}.add .nm{color:var(--dim)}' +
    '.t.ph{background:transparent!important}.t.ph>*{visibility:hidden}' +
    '.t.ph::before{content:"";position:absolute;inset:6px;border-radius:14px;border:1.5px dashed var(--bd2);background:rgba(255,255,255,.02)}' +
    '.ghost{position:fixed;margin:0;pointer-events:none;z-index:3;background:var(--bg2);border-radius:16px;' +
    'box-shadow:0 18px 40px -8px rgba(0,0,0,.65),0 0 0 1px var(--bd2);transition:box-shadow .15s;will-change:transform}' +
    '.dragging .t:not(.ph){cursor:grabbing}' +
    '.empty{padding:28px 12px;text-align:center;color:var(--dim);font-size:12.5px;grid-column:1/-1}' +
    '.ft{flex:none;display:flex;align-items:center;gap:10px;padding:8px 16px 14px;border-top:1px solid var(--bd);color:var(--dim);font-size:11.5px}' +
    '.ft .hint{flex:1;min-width:0}' +
    '.lnk{all:unset;cursor:pointer;color:var(--dim);font-size:11.5px;padding:4px 2px;border-radius:4px}.lnk:hover{color:var(--tx)}.lnk.warn{color:var(--bad)}' +
    '.ed{display:flex;flex-direction:column;gap:14px;padding:2px 6px 6px}' +
    '.fld{display:flex;flex-direction:column;gap:6px}' +
    '.lbl{font-size:10.5px;font-weight:600;letter-spacing:1.1px;text-transform:uppercase;color:var(--dim)}' +
    '.in{all:unset;box-sizing:border-box;width:100%;background:var(--in);border:1px solid var(--bd);border-radius:10px;color:var(--tx);' +
    'padding:10px 12px;font-size:14px;line-height:1.3;transition:border-color .15s;cursor:text;user-select:text;-webkit-user-select:text}' +
    '.in:focus{border-color:var(--ac)}.in.err{border-color:var(--bad)}' +
    '.msg{font-size:11.5px;color:var(--bad);min-height:0}' +
    '.note{font-size:11.5px;color:var(--dim);line-height:1.35}' +
    '.chips{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}' +
    '.chip{all:unset;box-sizing:border-box;aspect-ratio:1;border-radius:11px;padding:3px;cursor:pointer;border:1.5px solid transparent;' +
    'display:grid;place-items:center;font-size:10px;font-weight:600;color:var(--dim);-webkit-tap-highlight-color:transparent}' +
    '.chip svg{width:100%;height:100%;display:block;border-radius:8px}' +
    '.chip.txt{background:var(--bg2);border-color:var(--bd)}' +
    '.chip:hover{border-color:var(--bd2)}.chip.on{border-color:var(--ac);color:var(--ac)}' +
    '.row{display:flex;align-items:center;gap:10px}' +
    '.sw{all:unset;box-sizing:border-box;position:relative;width:38px;height:22px;border-radius:11px;background:var(--bd2);cursor:pointer;flex:none;transition:background-color .15s}' +
    '.sw::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s}' +
    '.sw[aria-checked="true"]{background:var(--ac)}.sw[aria-checked="true"]::after{transform:translateX(16px)}' +
    '.sw:focus-visible{outline:2px solid var(--ac);outline-offset:2px}' +
    '.btns{display:flex;gap:8px;align-items:center;padding-top:2px}.btns .sp{flex:1}' +
    '.b{all:unset;box-sizing:border-box;height:36px;padding:0 15px;border-radius:10px;border:1px solid var(--bd2);cursor:pointer;' +
    'font-weight:600;font-size:13px;color:var(--tx);display:inline-flex;align-items:center;-webkit-tap-highlight-color:transparent;transition:background-color .15s,border-color .15s}' +
    '.b:hover{background:var(--hov)}.b.pri{color:var(--ac);border-color:color-mix(in srgb,var(--ac) 55%,transparent)}' +
    '.b.pri:hover{background:color-mix(in srgb,var(--ac) 10%,transparent)}' +
    '.b.dng{color:var(--bad);border-color:rgba(214,138,124,.35)}.b.dng.sure{background:rgba(214,138,124,.14);border-color:var(--bad)}' +
    '@media (pointer:coarse){.t{padding:16px 4px 14px}.in{font-size:16px}.ib{width:40px;height:40px}.b{height:42px}}' +
    '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}';

  var SVG_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var SVG_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
  var SVG_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5A8 8 0 1 0 17.7 17.2"/><path d="M20 4.5v7h-7"/></svg>';
  var SVG_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

  var ui = {
    host: null, root: null, wrap: null, pop: null, sc: null, grid: null, ed: null, ft: null,
    ttl: null, st: null, btnEdit: null, btnDone: null, btnBack: null, btnRetry: null,
    open: false, edit: false, view: 'grid', anchor: null, tiles: {}, addTile: null,
    closeT: 0, noClickUntil: 0, lastFocus: null, placeRaf: 0
  };

  function build() {
    var host = el('div');
    host.id = 'a1-lifehub-panel';
    host.setAttribute('data-no-hoverfx', '');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147482600;display:none;pointer-events:none;';
    var ac0 = accentFor(AP, null);
    if (ac0) host.style.setProperty('--lh-ac', ac0);
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + PANEL_CSS + '</style>' +
      '<div class="wrap">' +
        '<div class="bd" style="pointer-events:auto"></div>' +
        '<div class="pop" role="dialog" aria-label="A1 apps" tabindex="-1" style="pointer-events:auto">' +
          '<div class="grab"></div>' +
          '<div class="hd">' +
            '<button class="ib back" type="button" aria-label="Back" hidden>' + SVG_BACK + '</button>' +
            '<div class="ttl">LifeHub</div><span class="st" aria-live="polite"></span>' +
            '<button class="ib rf" type="button" aria-label="Retry connection" title="Retry now" hidden>' + SVG_REFRESH + '</button>' +
            '<button class="ib edit-btn" type="button" aria-label="Edit apps" title="Edit apps">' + SVG_PENCIL + '</button>' +
            '<button class="done" type="button" hidden>Done</button>' +
          '</div>' +
          '<div class="sc"><div class="grid"></div><div class="ed" hidden></div></div>' +
          '<div class="ft" hidden><span class="hint">Drag to reorder · tap to edit · v' + VERSION + '</span><button class="lnk reset" type="button">Reset</button></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(host);

    ui.host = host; ui.root = root;
    ui.wrap = root.querySelector('.wrap');
    ui.pop = root.querySelector('.pop');
    ui.sc = root.querySelector('.sc');
    ui.grid = root.querySelector('.grid');
    ui.ed = root.querySelector('.ed');
    ui.ft = root.querySelector('.ft');
    ui.ttl = root.querySelector('.ttl');
    ui.st = root.querySelector('.st');
    ui.btnRetry = root.querySelector('.rf');
    ui.btnRetry.addEventListener('click', function () { retry(S, true); });
    ui.btnEdit = root.querySelector('.edit-btn');
    ui.btnDone = root.querySelector('.done');
    ui.btnBack = root.querySelector('.back');

    // Nothing inside LifeHub reaches the program underneath: its document
    // listeners ("click outside closes my menu", shortcuts) never see these.
    ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend',
     'keydown', 'keyup', 'keypress', 'contextmenu', 'input', 'change', 'focusin', 'focusout'].forEach(function (t) {
      host.addEventListener(t, function (e) { e.stopPropagation(); });
    });

    var bd = root.querySelector('.bd');
    // Dismissed the instant the finger (or button) goes DOWN outside — waiting
    // for the lift, or worse for the synthesized click, is the delay that read
    // as lag. The backdrop, now invisible, stays hit-testable until that same
    // pointer is released and its click has fired (see settleClose), so the
    // tap still can never reach whatever is underneath.
    bd.addEventListener('pointerdown', function (e) { e.preventDefault(); close(false, true); });
    function release() { if (ui.holdBd) setTimeout(function () { ui.holdBd = false; settleClose(); }, 80); }
    bd.addEventListener('pointerup', release);
    bd.addEventListener('pointercancel', release);
    // Belt and braces: an invisible backdrop left catching touches would freeze
    // the program, so the release is also heard on window (capture phase, ahead
    // of anything that could stop it) and there is a hard cap.
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    bd.addEventListener('click', function (e) { e.preventDefault(); close(); });
    bd.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
    bd.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });

    ui.btnEdit.addEventListener('click', function () { setEdit(true); });
    ui.btnDone.addEventListener('click', function () { setEdit(false); });
    ui.btnBack.addEventListener('click', function () { closeEditor(); });
    var reset = root.querySelector('.reset');
    reset.addEventListener('click', function () {
      if (!reset.classList.contains('warn')) {
        reset.classList.add('warn'); reset.textContent = 'Reset to A1 defaults?';
        setTimeout(function () { reset.classList.remove('warn'); reset.textContent = 'Reset'; }, 3500);
        return;
      }
      reset.classList.remove('warn'); reset.textContent = 'Reset';
      commit(S, replaceOp(S.defaults));
    });

    ui.pop.addEventListener('keydown', onKey);
    armSheetSwipe();
  }

  function setStatus(st, s) {
    st.status = s;
    if (st !== S || !ui.st) return;
    ui.st.textContent = s === 'saving' ? 'Saving…' : s === 'offline' ? 'Offline' : s === 'retry' ? 'Connecting…' : '';
    ui.st.classList.toggle('bad', s === 'offline');
    ui.st.title = s === 'offline' ? 'Changes are kept here and sync when the connection is back.' : '';
    // The refresh button appears next to the pencil only while offline (and
    // while the retry it started is running), and spins during an attempt —
    // for at least one full turn, so a fast reconnect doesn't flicker.
    var busy = s === 'retry' || s === 'refresh';
    var b = ui.btnRetry;
    b.hidden = !(s === 'offline' || s === 'retry') || ui.view === 'ed';
    b.title = s === 'offline' ? 'Retry now' : 'Refresh';
    b.setAttribute('aria-label', s === 'offline' ? 'Retry connection' : 'Refresh apps');
    b.disabled = busy;
    clearTimeout(ui.spinT);
    if (busy) {
      if (!b.classList.contains('spin')) ui.spinAt = Date.now();
      b.classList.add('spin');
    } else {
      ui.spinT = setTimeout(function () { b.classList.remove('spin'); }, Math.max(0, 800 - (Date.now() - (ui.spinAt || 0))));
    }
  }

  function isSheet() { return window.innerWidth < 600; }

  function place() {
    ui.placeRaf = 0;
    if (!ui.open) return;
    var sheet = isSheet(), pop = ui.pop, vw = window.innerWidth, vh = window.innerHeight;
    ui.wrap.classList.toggle('m', sheet);
    if (sheet) {
      pop.style.cssText = 'pointer-events:auto;max-height:' + Math.round(vh * 0.84) + 'px';
      return;
    }
    var r = ui.anchor ? ui.anchor.getBoundingClientRect() : { left: vw - 44, right: vw - 8, top: 8, bottom: 44 };
    var w = Math.min(336, vw - 16);
    var alignLeft = (r.left + r.right) / 2 < vw / 2;
    var left = alignLeft ? r.left - 6 : r.right - w + 6;
    left = Math.max(8, Math.min(left, vw - w - 8));
    var below = vh - r.bottom - 20, above = r.top - 20;
    var up = below < 300 && above > below;
    var maxH = Math.max(160, Math.min(580, up ? above : below));
    pop.classList.toggle('up', up);
    pop.classList.toggle('left', alignLeft);
    pop.style.cssText = 'pointer-events:auto;left:' + Math.round(left) + 'px;width:' + Math.round(w) + 'px;max-height:' + Math.round(maxH) + 'px;' +
      (up ? 'bottom:' + Math.round(vh - r.top + 8) + 'px;top:auto;' : 'top:' + Math.round(r.bottom + 8) + 'px;');
  }
  function queuePlace() { if (!ui.placeRaf) ui.placeRaf = requestAnimationFrame(place); }

  function onDocKey(e) {
    if (e.key === 'Escape' && ui.open) { e.stopPropagation(); e.preventDefault(); if (ui.view === 'ed') closeEditor(); else close(); }
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); if (ui.view === 'ed') closeEditor(); else close(); return; }
    if (ui.view !== 'grid') return;
    var keys = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 'd', ArrowUp: 'u' };
    if (!(e.key in keys)) return;
    var tiles = Array.prototype.slice.call(ui.grid.querySelectorAll('.t'));
    var i = tiles.indexOf(ui.root.activeElement);
    if (i < 0) return;
    var cols = getComputedStyle(ui.grid).gridTemplateColumns.split(' ').length || 3;
    var step = keys[e.key] === 'd' ? cols : keys[e.key] === 'u' ? -cols : keys[e.key];
    var j = Math.max(0, Math.min(tiles.length - 1, i + step));
    e.preventDefault();
    tiles[j].focus();
  }

  function open(anchor) {
    if (!ui.host) build();
    clearTimeout(ui.closeT);
    ui.wrap.classList.remove('closing');
    ui.holdBd = false;
    ui.anchor = anchor || ui.anchor;
    ui.lastFocus = document.activeElement;
    ui.host.style.display = '';
    ui.open = true;
    launchers.forEach(function (l) { if (l._btn) l._btn.setAttribute('aria-expanded', l === ui.anchor ? 'true' : 'false'); });
    setEdit(false, true);
    place();
    render();
    setStatus(S, S.status);
    // Reopening while offline is itself a reason to try again right away.
    if (S.status === 'offline') retry(S); else ensureSync(S);
    window.addEventListener('resize', queuePlace);
    window.addEventListener('scroll', queuePlace, true);
    document.addEventListener('keydown', onDocKey, true);
    try { ui.pop.focus({ preventScroll: true }); } catch (e) {}
  }

  // `instant` skips the exit animation — used when leaving for another tab,
  // where the page is backgrounded and its timers throttled. `byPointer`: the
  // close came from a press on the backdrop, which must keep catching that
  // press until it is released (see the backdrop listeners in build()).
  function settleClose() {
    if (ui.open || ui.holdBd || !ui.animDone) return;
    ui.host.style.display = 'none';
    ui.wrap.classList.remove('closing');
  }
  function close(instant, byPointer) {
    if (!ui.open) return;
    if (D) endDrag(true);
    if (ui.view === 'ed') closeEditor(true);
    ui.open = false;
    launchers.forEach(function (l) { if (l._btn) l._btn.setAttribute('aria-expanded', 'false'); });
    window.removeEventListener('resize', queuePlace);
    window.removeEventListener('scroll', queuePlace, true);
    document.removeEventListener('keydown', onDocKey, true);
    // Focus goes back to the launcher only for keyboard users; after a tap it
    // is pointless work (and on some phones a visible focus flash).
    var hadFocus = !byPointer && ui.root.activeElement != null;
    ui.holdBd = !!byPointer;
    if (ui.holdBd) setTimeout(function () { ui.holdBd = false; settleClose(); }, 1500);
    if (instant === true || document.visibilityState !== 'visible') {
      ui.holdBd = false;
      ui.host.style.display = 'none';
    } else {
      ui.animDone = false;
      ui.wrap.classList.add('closing');
      ui.closeT = setTimeout(function () { ui.animDone = true; settleClose(); }, 190);
    }
    if (hadFocus && ui.anchor && ui.anchor._btn && ui.anchor.isConnected && !ui.anchor.hidden) {
      try { ui.anchor._btn.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  function setEdit(on, quiet) {
    ui.edit = !!on;
    if (ui.view === 'ed' && !quiet) closeEditor(true);
    ui.wrap.classList.toggle('edit', ui.edit);
    ui.btnEdit.hidden = ui.edit || ui.view === 'ed';
    ui.btnDone.hidden = !ui.edit || ui.view === 'ed';
    ui.ft.hidden = !ui.edit || ui.view === 'ed';
    ui.ttl.textContent = ui.edit ? 'Edit apps' : 'LifeHub';
    ui.tiles = ui.tiles || {};
    render();
  }

  /* ── Grid ────────────────────────────────────────────────────────────── */
  function a1IconFor(url) {
    var m = /\/([a-z0-9_-]+)\.html?(?:[?#]|$)/i.exec(String(url || ''));
    if (m && ICONS[m[1].toLowerCase()] && destKey(url).indexOf(destKey(BASE)) === 0) return m[1].toLowerCase();
    return '';
  }
  function iconNode(a, cls) {
    var d = el('span', cls || 'ic');
    var ic = a.icon || '';
    var key = /^a1:/.test(ic) ? ic.slice(3) : '';
    if (!ic || ic === 'auto') key = a1IconFor(a.url);
    if (key && ICONS[key]) { d.innerHTML = ICONS[key]; return d; }
    var src = '';
    if (/^https?:\/\//i.test(ic) || /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(ic)) src = ic;
    else if ((!ic || ic === 'auto') && isWeb(a.url)) {
      try { src = 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(new URL(a.url).hostname); d.classList.add('site'); } catch (e) {}
    }
    if (src) {
      var img = new Image();
      img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'no-referrer'; img.draggable = false;
      img.onerror = function () { d.className = (cls || 'ic') + ' mono'; d.textContent = initial(a); };
      img.src = src;
      d.appendChild(img);
      return d;
    }
    d.classList.add('mono');
    d.textContent = initial(a);
    return d;
  }
  function initial(a) { return (String(a.name || '?').trim().charAt(0) || '?').toUpperCase(); }

  function makeTile(id) {
    var t = el('button', 't');
    t.type = 'button';
    t.dataset.id = id;
    t.draggable = false;
    armTile(t);
    return t;
  }
  function paintTile(t, a) {
    t.textContent = '';
    t.appendChild(iconNode(a));
    t.appendChild(el('span', 'nm', a.name));
    var eb = el('span', 'eb'); eb.innerHTML = SVG_PENCIL; t.appendChild(eb);
    var here = isHere(normUrl(a.url));
    t.classList.toggle('here', here);
    t.classList.toggle('off', !!a.hidden);
    t.title = ui.edit ? 'Edit ' + a.name : here ? a.name + ' — you are here' : a.name;
    t.setAttribute('aria-label', (ui.edit ? 'Edit ' : 'Open ') + a.name + (a.hidden ? ' (hidden)' : ''));
  }

  function render() {
    if (!ui.open || D || ui.view !== 'grid') return;
    var list = S.apps.filter(function (a) { return ui.edit || (!a.hidden && (CAN_LOCAL || !isLocalPath(normUrl(a.url)))); });
    var grid = ui.grid, keep = {}, i = 0;
    list.forEach(function (a) {
      var t = ui.tiles[a.id];
      if (!t) t = ui.tiles[a.id] = makeTile(a.id);
      var sig = [a.name, a.icon, a.url, a.hidden, ui.edit].join('');
      if (t._sig !== sig) { paintTile(t, a); t._sig = sig; }
      keep[a.id] = 1;
      if (grid.children[i] !== t) grid.insertBefore(t, grid.children[i] || null);
      i++;
    });
    Object.keys(ui.tiles).forEach(function (id) {
      if (!keep[id]) { var t = ui.tiles[id]; if (t.parentNode) t.parentNode.removeChild(t); if (!byId(S.apps, id)) delete ui.tiles[id]; }
    });
    var empty = grid.querySelector('.empty');
    if (!list.length && !ui.edit) {
      if (!empty) { empty = el('div', 'empty', 'No apps yet — tap the pencil to add one.'); grid.appendChild(empty); }
    } else if (empty) empty.remove();
    if (ui.edit) {
      if (!ui.addTile) {
        var at = el('button', 't add');
        at.type = 'button';
        at.setAttribute('aria-label', 'Add an app');
        var ic = el('span', 'ic'); ic.innerHTML = SVG_PLUS;
        at.appendChild(ic); at.appendChild(el('span', 'nm', 'Add'));
        at.addEventListener('click', function () { openEditor(null); });
        ui.addTile = at;
      }
      grid.appendChild(ui.addTile);
    } else if (ui.addTile && ui.addTile.parentNode) ui.addTile.parentNode.removeChild(ui.addTile);
  }

  function onTileClick(e) {
    var t = e.currentTarget;
    if (Date.now() < ui.noClickUntil || D) { e.preventDefault(); return; }
    var a = byId(S.apps, t.dataset.id);
    if (!a) return;
    if (ui.edit) openEditor(a.id);
    else launch(a);
  }

  function launch(a) {
    var url = normUrl(a.url);
    if (!url) { openEditor(a.id); return; }
    if (isHere(url)) { close(); return; }
    if (isLocalPath(url)) { close(true); openLocal(a, url); return; }
    if (!isWeb(url)) {
      // Another program's protocol (shieldopen:, …): hand it to the OS, the
      // same way TaskHub hands local paths to Shield.
      close(true);
      try { location.href = url; } catch (e) {}
      return;
    }
    var key = a.tab || ('lh_' + a.id);
    var w = null;
    try { w = openTab(url, key); } catch (e) { w = null; }
    if (!w) {
      // Blocked: a real anchor with the SAME target name, so even this path
      // lands in the paired tab (no rel=noopener — it would break the name).
      try {
        var an = document.createElement('a');
        an.href = url; an.target = tabName(key);
        document.body.appendChild(an); an.click(); document.body.removeChild(an);
      } catch (e) {}
    }
    close(true);
  }

  // A program on this PC. Inside the Shield agent the host starts it itself;
  // anywhere else it goes to the agent as an opaque id, exactly as TaskHub's
  // local-path buttons do (index.html _doOpen). If Shield isn't installed or
  // running, nothing visible happens — the same as any unhandled protocol.
  function openLocal(a, path) {
    if (typeof CFG.openLocal === 'function') {
      try { if (CFG.openLocal(path, clone(a))) return; } catch (e) {}
    }
    try { location.href = 'shieldopen:' + localKey(S.profile, a.id); } catch (e) {}
  }

  /* ── Drag to reorder ──────────────────────────────────────────────────────
     Mouse/pen: press and move 6px. Touch: hold 280ms, then drag — a finger
     that moves first is scrolling, and scrolling is left alone. Everything
     happens in the DOM; the store hears about it once, on drop. */
  var D = null, P = null, T = null;

  function armTile(t) {
    t.addEventListener('click', onTileClick);
    t.addEventListener('pointerdown', onPD);
    t.addEventListener('touchstart', onTS, { passive: true });
    t.addEventListener('touchmove', onTM, { passive: false });
    t.addEventListener('touchend', onTE, { passive: false });
    t.addEventListener('touchcancel', onTC);
    t.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    t.addEventListener('dragstart', function (e) { e.preventDefault(); });
  }

  // Move/up are heard on window in the CAPTURE phase: the dragged tile is
  // re-inserted as it travels, which silently drops pointer capture, and the
  // panel stops bubbling events at its edge — capture on window sees them
  // before either can get in the way.
  function onPD(e) {
    if (e.pointerType === 'touch' || e.button !== 0 || D) return;
    var t = e.currentTarget;
    P = { t: t, x: e.clientX, y: e.clientY, id: e.pointerId };
    window.addEventListener('pointermove', onPM, true);
    window.addEventListener('pointerup', onPU, true);
    window.addEventListener('pointercancel', onPU, true);
  }
  function onPM(e) {
    if (!P || e.pointerId !== P.id) return;
    if (!D) {
      if (Math.abs(e.clientX - P.x) + Math.abs(e.clientY - P.y) < 6) return;
      beginDrag(P.t, P.x, P.y);
    }
    e.preventDefault();
    moveDrag(e.clientX, e.clientY);
  }
  function onPU(e) {
    if (!P || e.pointerId !== P.id) return;
    window.removeEventListener('pointermove', onPM, true);
    window.removeEventListener('pointerup', onPU, true);
    window.removeEventListener('pointercancel', onPU, true);
    P = null;
    if (D) { endDrag(e.type === 'pointercancel'); ui.noClickUntil = Date.now() + 350; }
  }

  function onTS(e) {
    if (e.touches.length !== 1 || D) { cancelPress(); return; }
    var p = e.touches[0], t = e.currentTarget;
    T = { t: t, x: p.clientX, y: p.clientY };
    T.timer = setTimeout(function () {
      if (!T || T.moved) return;
      T.timer = 0;
      beginDrag(T.t, T.x, T.y);
      try { navigator.vibrate && navigator.vibrate(8); } catch (err) {}
    }, 280);
  }
  function onTM(e) {
    if (!T) return;
    var p = e.touches[0];
    if (D) { e.preventDefault(); moveDrag(p.clientX, p.clientY); return; }
    if (Math.abs(p.clientX - T.x) + Math.abs(p.clientY - T.y) > 10) { T.moved = true; cancelPress(); }
  }
  function onTE(e) {
    var had = !!D;
    cancelPress();
    if (had) { e.preventDefault(); endDrag(false); ui.noClickUntil = Date.now() + 350; }
  }
  function onTC() { var had = !!D; cancelPress(); if (had) endDrag(false); }
  function cancelPress() { if (T && T.timer) clearTimeout(T.timer); T = null; }

  function gridTiles() { return Array.prototype.slice.call(ui.grid.querySelectorAll('.t:not(.add)')); }
  function gridOrder() { return gridTiles().map(function (t) { return t.dataset.id; }); }

  function beginDrag(t, x, y) {
    if (ui.view !== 'grid') return;
    beginBusy();
    var r = t.getBoundingClientRect();
    var g = t.cloneNode(true);
    g.className = 't ghost';
    g.removeAttribute('title');
    g.style.left = r.left + 'px'; g.style.top = r.top + 'px';
    g.style.width = r.width + 'px'; g.style.height = r.height + 'px';
    ui.wrap.appendChild(g);
    D = { t: t, g: g, ox: x - r.left, oy: y - r.top, l0: r.left, t0: r.top, x: x, y: y, start: gridOrder(), raf: 0 };
    t.classList.add('ph');
    ui.pop.classList.add('dragging');
    g.style.transform = 'scale(1.06)';
    autoScroll();
  }

  function moveDrag(x, y) {
    if (!D) return;
    D.x = x; D.y = y;
    D.g.style.transform = 'translate(' + (x - D.ox - D.l0) + 'px,' + (y - D.oy - D.t0) + 'px) scale(1.06)';
    retarget();
  }

  // Hit-test against each tile's LAYOUT slot (offsetLeft/Top ignore
  // transforms), not where it is drawn: mid-slide a neighbour is still painted
  // under the pointer, and testing that would bounce the order back and forth.
  function retarget() {
    var g = ui.grid.getBoundingClientRect();
    var px = D.x - g.left, py = D.y - g.top;
    var tiles = gridTiles(), over = null;
    for (var i = 0; i < tiles.length; i++) {
      var n = tiles[i];
      if (px >= n.offsetLeft && px < n.offsetLeft + n.offsetWidth && py >= n.offsetTop && py < n.offsetTop + n.offsetHeight) { over = n; break; }
    }
    if (!over || over === D.t) return;
    var from = tiles.indexOf(D.t), to = tiles.indexOf(over);
    if (from < 0 || to < 0) return;
    flip(function () { ui.grid.insertBefore(D.t, to > from ? over.nextSibling : over); });
  }

  // FLIP: remember where every tile was, move one, then animate each from its
  // old spot to its new one — so the grid slides rather than jumps.
  function flip(mutate) {
    var tiles = gridTiles(), first = [];
    tiles.forEach(function (n) { first.push(n.getBoundingClientRect()); });
    mutate();
    tiles.forEach(function (n, i) {
      var a = first[i], b = n.getBoundingClientRect();
      var dx = a.left - b.left, dy = a.top - b.top;
      if (!dx && !dy) return;
      n.style.transition = 'none';
      n.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      void n.offsetWidth;
      n.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)';
      n.style.transform = '';
      clearTimeout(n._ft);
      n._ft = setTimeout(function () { n.style.transition = ''; }, 220);
    });
  }

  function autoScroll() {
    if (!D) return;
    var r = ui.sc.getBoundingClientRect(), edge = 44, v = 0;
    if (D.y < r.top + edge) v = -Math.ceil((r.top + edge - D.y) / 4);
    else if (D.y > r.bottom - edge) v = Math.ceil((D.y - (r.bottom - edge)) / 4);
    if (v) { var before = ui.sc.scrollTop; ui.sc.scrollTop += v; if (ui.sc.scrollTop !== before) retarget(); }
    D.raf = requestAnimationFrame(autoScroll);
  }

  function endDrag(cancelled) {
    var d = D;
    if (!d) return;
    D = null;
    cancelAnimationFrame(d.raf);
    ui.pop.classList.remove('dragging');
    var order = gridOrder();
    if (cancelled) {
      // Put the tiles back as they were; nothing is saved.
      d.start.forEach(function (id) { var t = ui.tiles[id]; if (t) ui.grid.appendChild(t); });
      if (ui.addTile && ui.addTile.parentNode) ui.grid.appendChild(ui.addTile);
    }
    var r = d.t.getBoundingClientRect();
    d.g.style.transition = 'transform .16s cubic-bezier(.2,.8,.2,1),box-shadow .16s';
    d.g.style.transform = 'translate(' + (r.left - d.l0) + 'px,' + (r.top - d.t0) + 'px) scale(1)';
    d.g.style.boxShadow = 'none';
    setTimeout(function () {
      if (d.g.parentNode) d.g.parentNode.removeChild(d.g);
      d.t.classList.remove('ph');
    }, 170);
    if (!cancelled && order.join('\n') !== d.start.join('\n')) commit(S, reorderOp(order));
    endBusy();
    render();
  }

  /* ── Sheet: swipe the header down to dismiss ─────────────────────────── */
  function armSheetSwipe() {
    var hd = ui.root.querySelector('.hd'), grab = ui.root.querySelector('.grab'), y0 = null, dy = 0;
    function start(e) { if (!isSheet() || e.touches.length !== 1 || (e.target.closest && e.target.closest('button'))) return; y0 = e.touches[0].clientY; dy = 0; ui.pop.style.transition = 'none'; }
    function move(e) {
      if (y0 == null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      ui.pop.style.transform = 'translateY(' + dy + 'px)';
      e.preventDefault();
    }
    function end() {
      if (y0 == null) return;
      y0 = null;
      ui.pop.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)';
      ui.pop.style.transform = '';
      if (dy > 70) close();
      setTimeout(function () { ui.pop.style.transition = ''; }, 220);
    }
    [hd, grab].forEach(function (n) {
      n.addEventListener('touchstart', start, { passive: true });
      n.addEventListener('touchmove', move, { passive: false });
      n.addEventListener('touchend', end);
      n.addEventListener('touchcancel', end);
    });
  }

  /* ── Editor ──────────────────────────────────────────────────────────── */
  function openEditor(id) {
    var a = id ? byId(S.apps, id) : null;
    if (id && !a) return;
    beginBusy();
    ui.view = 'ed';
    ui.editingId = id;
    var cur = a ? clone(a) : { id: '', name: '', url: '', icon: '', hidden: false };
    var iconSel = cur.icon && /^a1:/.test(cur.icon) && ICONS[cur.icon.slice(3)] ? cur.icon
      : (!cur.icon || cur.icon === 'auto') ? 'auto' : 'custom';

    var ed = ui.ed;
    ed.textContent = '';
    function field(label, input) {
      var f = el('label', 'fld');
      f.appendChild(el('span', 'lbl', label));
      f.appendChild(input);
      return f;
    }
    var nameIn = el('input', 'in'); nameIn.type = 'text'; nameIn.maxLength = 40; nameIn.value = cur.name;
    nameIn.placeholder = 'Name'; nameIn.autocomplete = 'off'; nameIn.spellcheck = false;
    var urlIn = el('input', 'in'); urlIn.type = 'text'; urlIn.value = cur.url; urlIn.placeholder = 'https://…  or  C:\\…\\app.exe';
    // No inputmode=url: phone URL keyboards have no backslash for a path.
    urlIn.autocomplete = 'off'; urlIn.spellcheck = false; urlIn.setAttribute('autocapitalize', 'off');
    var urlNote = el('div', 'note', 'A program on a Windows PC — opens through the Shield desktop app.');
    function syncNote() { urlNote.hidden = !isLocalPath(normUrl(urlIn.value)); }
    urlIn.addEventListener('input', syncNote);
    syncNote();
    var imgIn = el('input', 'in'); imgIn.type = 'text'; imgIn.placeholder = 'Image link (https://… or data:image/…)';
    imgIn.value = iconSel === 'custom' ? cur.icon : ''; imgIn.autocomplete = 'off'; imgIn.spellcheck = false;
    imgIn.setAttribute('autocapitalize', 'off');
    var msg = el('div', 'msg');

    ed.appendChild(field('Name', nameIn));
    var linkF = field('Link', urlIn);
    linkF.appendChild(urlNote);
    ed.appendChild(linkF);

    var iconF = el('div', 'fld');
    iconF.appendChild(el('span', 'lbl', 'Icon'));
    var chips = el('div', 'chips');
    function chip(value, content, label) {
      var c = el('button', 'chip');
      c.type = 'button';
      c.dataset.v = value;
      c.setAttribute('aria-label', label);
      c.title = label;
      if (typeof content === 'string') { c.classList.add('txt'); c.textContent = content; } else c.appendChild(content);
      c.addEventListener('click', function () { iconSel = value; syncChips(); if (value === 'custom') imgIn.focus(); });
      chips.appendChild(c);
    }
    chip('auto', 'Auto', 'Automatic — the program’s own icon, or the site’s');
    ICON_KEYS.forEach(function (k) {
      var s = el('span'); s.innerHTML = ICONS[k];
      chip('a1:' + k, s.firstChild, k);
    });
    chip('custom', 'URL', 'Use an image link');
    iconF.appendChild(chips);
    iconF.appendChild(imgIn);
    ed.appendChild(iconF);
    function syncChips() {
      Array.prototype.forEach.call(chips.children, function (c) {
        var on = c.dataset.v === iconSel;
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      imgIn.hidden = iconSel !== 'custom';
    }
    syncChips();

    var showRow = el('div', 'row');
    var sw = el('button', 'sw'); sw.type = 'button'; sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', cur.hidden ? 'false' : 'true');
    sw.setAttribute('aria-label', 'Show in LifeHub');
    sw.addEventListener('click', function () { sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); });
    showRow.appendChild(sw);
    showRow.appendChild(el('span', null, 'Show in LifeHub'));
    ed.appendChild(showRow);
    ed.appendChild(msg);

    var btns = el('div', 'btns');
    if (a) {
      var del = el('button', 'b dng', 'Delete'); del.type = 'button';
      del.addEventListener('click', function () {
        if (!del.classList.contains('sure')) {
          del.classList.add('sure'); del.textContent = 'Tap to confirm';
          setTimeout(function () { del.classList.remove('sure'); del.textContent = 'Delete'; }, 3500);
          return;
        }
        commit(S, removeOp(a.id));
        closeEditor();
      });
      btns.appendChild(del);
    }
    btns.appendChild(el('span', 'sp'));
    var cancel = el('button', 'b', 'Cancel'); cancel.type = 'button';
    cancel.addEventListener('click', function () { closeEditor(); });
    var save = el('button', 'b pri', a ? 'Save' : 'Add'); save.type = 'button';
    btns.appendChild(cancel); btns.appendChild(save);
    ed.appendChild(btns);

    function doSave() {
      msg.textContent = '';
      nameIn.classList.remove('err'); urlIn.classList.remove('err'); imgIn.classList.remove('err');
      var name = nameIn.value.trim();
      var url = normUrl(urlIn.value);
      if (!name) { nameIn.classList.add('err'); msg.textContent = 'Give it a name.'; nameIn.focus(); return; }
      if (!url) { urlIn.classList.add('err'); msg.textContent = 'Enter a link such as https://example.com, or a program path such as C:\\Apps\\app.exe.'; urlIn.focus(); return; }
      var icon = iconSel === 'auto' ? '' : iconSel;
      if (iconSel === 'custom') {
        icon = imgIn.value.trim();
        if (!/^https?:\/\//i.test(icon) && !/^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(icon)) {
          imgIn.classList.add('err'); msg.textContent = 'The image link must start with https:// or data:image/.'; imgIn.focus(); return;
        }
      }
      var hidden = sw.getAttribute('aria-checked') !== 'true';
      if (a) {
        var patch = {}, n = 0;
        if (name !== a.name) { patch.name = name; n++; }
        if (url !== a.url) { patch.url = url; n++; }
        if (icon !== a.icon) { patch.icon = icon; n++; }
        if (hidden !== a.hidden) { patch.hidden = hidden; n++; }
        if (n) commit(S, patchOp(a.id, patch));
      } else {
        var base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'app';
        var nid = base + '-' + Math.random().toString(36).slice(2, 6);
        commit(S, addOp({ id: nid, name: name, url: url, icon: icon, tab: 'lh_' + nid.replace(/-/g, '_'), hidden: hidden }));
      }
      closeEditor();
    }
    save.addEventListener('click', doSave);
    [nameIn, urlIn, imgIn].forEach(function (i) {
      i.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
    });

    ui.grid.hidden = true;
    ui.ed.hidden = false;
    ui.ft.hidden = true;
    ui.btnBack.hidden = false;
    ui.btnRetry.hidden = true;
    ui.btnEdit.hidden = true;
    ui.btnDone.hidden = true;
    ui.ttl.textContent = a ? 'Edit app' : 'Add app';
    ui.sc.scrollTop = 0;
    setTimeout(function () { try { nameIn.focus({ preventScroll: true }); if (!a) nameIn.select(); } catch (e) {} }, 30);
  }

  function closeEditor(silent) {
    if (ui.view !== 'ed') return;
    ui.view = 'grid';
    ui.ed.textContent = '';
    ui.ed.hidden = true;
    ui.grid.hidden = false;
    ui.btnBack.hidden = true;
    setStatus(S, S.status);
    endBusy();
    if (!silent) { setEdit(ui.edit, true); try { ui.pop.focus({ preventScroll: true }); } catch (e) {} }
  }

  /* ══ Public API ════════════════════════════════════════════════════════════ */
  window.LifeHub = {
    version: VERSION,
    // Code-level alternative to the script attributes:
    //   LifeHub.configure({ locked: () => bool, profile: () => 'tony'|'veda', accent: '#hex' })
    configure: function (o) {
      o = o || {};
      if ('locked' in o) CFG.locked = o.locked;
      if ('profile' in o) CFG.profile = o.profile;
      if ('lock' in o) CFG.lock = o.lock;
      if ('profileAttr' in o) CFG.profileAttr = o.profileAttr;
      if ('openLocal' in o) CFG.openLocal = o.openLocal;
      if (o.accentVeda) CFG.accentVeda = o.accentVeda;
      if (o.accent || o.accentVeda) {
        if (o.accent) CFG.accent = o.accent;
        launchers.forEach(paintAccent);
        var ac = accentFor(AP, null);
        if (ui.host && ac) ui.host.style.setProperty('--lh-ac', ac);
      }
      applyVisible(true);
    },
    // Call after the host locks or unlocks to update at once instead of within
    // the next half-second check.
    refresh: function () { applyVisible(true); },
    open: function (anchor) {
      if (!computeVisible()) return;
      var a = anchor || Array.from(launchers).filter(function (l) { return !l.hidden && l.getClientRects().length; })[0];
      open(a || null);
    },
    close: close,
    apps: function () { return clone(S.apps); },
    // Which profile's list is on screen ('tony' | 'veda').
    profile: function () { return AP; },
    // Retry the connection now (what the refresh button does).
    retry: function () { retry(S, true); },
    // For the Shield desktop agent: cb({ 'lh:<profile>:<id>': path }) now and
    // on every change. See "Local programs for the Shield agent" above.
    localLinks: watchLocal
  };

  useProfile(readProfile() || 'tony');

  if (!customElements.get('a1-lifehub')) customElements.define('a1-lifehub', LauncherEl);
  try { window.dispatchEvent(new Event('lifehub:ready')); } catch (e) {}
  }
})();
