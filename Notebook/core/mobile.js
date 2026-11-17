/* Notebook on phones and tablets (Tony, 2026-11-17): one layer for both sides
   and every host, styled at the end of notebook.css ("Phones and tablets").

   Samsung Notes was the model: the page gets the screen.
     - Phones and portrait tablets (≤900px) get two screens. The LIST (the
       entry list, full screen, a + button at the bottom right) is home: it
       shows when nothing is open and when the back arrow is tapped. The
       EDITOR is the page, edge to edge, under one bar: back, the title, the
       sync word, then Edit/Reading, New and ⋮ (lock, PDF).
       In index.html the editor covers the program nav; the list shows it.
       Reading mode adds a pencil button at the bottom right.
     - Editing a page on any touch screen up to 1366px (a landscape tablet
       too) makes the ribbon ONE row of icons right under the header, so it
       works the same on every screen and keyboard. It scrolls sideways; its
       first button swaps it for the menus (File, Edit, View...), where
       everything the row leaves out lives. (It sat above the keyboard first;
       browsers disagree on where the keyboard is, Tony, 2026-11-17.)
   A host never calls this: Notebook wires each app it mounts (wire(key)).
   The app's own controls stay the source of truth: every button here clicks
   the app's (bottom bar, lock, export), so nothing is done twice.
   tests/live/notebook-mobile.live.js proves it on both sides. */
(function () {
'use strict';
if (window.NotebookMobile) return;

var SHELL = '(max-width: 900px)';
var TOUCH = '(max-width: 900px), (pointer: coarse) and (max-width: 1366px)';
var mqShell = window.matchMedia(SHELL), mqTouch = window.matchMedia(TOUCH);

function sv(p, cls) { return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; }
var IC = {
  back: sv('<path d="m15 18-6-6 6-6"/>'),
  pencil: sv('<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>', 'nb-i-pencil'),
  book: sv('<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2Z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7Z"/>', 'nb-i-book'),
  plus: sv('<path d="M12 5v14"/><path d="M5 12h14"/>', 'nb-i-plus'),
  more: sv('<circle cx="12" cy="5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>'),
  menus: sv('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>', 'nb-i-menus'),
  tools: sv('<path d="M4 20h4"/><path d="M6 20 11.5 5h1L18 20"/><path d="M8.2 14h7.6"/><path d="M16 20h4"/>', 'nb-i-tools'),
  lock: sv('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  unlock: sv('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.75-1.4"/>'),
  pdf: sv('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>')
};

var wired = {};
function $(id) { return document.getElementById(id); }
function shown(el) { return !!el && el.getClientRects().length > 0; }
// Onscreen keyboard height: what the visual viewport lost at the bottom. A
// pinch zoom shrinks it too, so a zoomed page reports none.
function keyboard() {
  var vv = window.visualViewport;
  if (!vv || vv.scale > 1.01) return 0;
  var k = window.innerHeight - (vv.height + vv.offsetTop);
  return k > 80 ? Math.round(k) : 0;
}
function vvBottom() {
  var vv = window.visualViewport;
  return vv && vv.scale <= 1.01 ? vv.offsetTop + vv.height : window.innerHeight;
}

function button(cls, label, html) {
  var b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.innerHTML = html;
  b.setAttribute('aria-label', label); b.setAttribute('data-noglow', '');
  return b;
}

function wire(K) {
  var root = $(K + '-root'), head = $(K + '-mobile-header');
  if (wired[K] || !root || !head) return false;
  wired[K] = true;
  var cfg = (window.Notebook && window.Notebook.mounts && window.Notebook.mounts[K]) || {};
  var hasList = !(cfg.features && cfg.features.sidebar === false);
  var overlay = !cfg.mode || cfg.mode === 'overlay';
  var sidebar = $(K + '-sidebar');
  root.classList.toggle('nb-nolist', !hasList);

  // ── The editor's bar: back · title · sync · Edit/Reading · New · ⋮ ──
  var back = $(K + '-hamburger');
  if (back) { back.innerHTML = IC.back; back.setAttribute('aria-label', 'All entries'); back.setAttribute('data-noglow', ''); }
  var mode = button('nb-mh-btn nb-mh-mode', 'Edit', IC.pencil + IC.book);
  var add = button('nb-mh-btn nb-mh-new', 'New entry', IC.plus);
  var more = button('nb-mh-btn nb-mh-more', 'More', IC.more);
  head.appendChild(mode);
  if (hasList) head.appendChild(add);
  head.appendChild(more);

  // The round button: + on the list, the pencil while reading a page.
  var fab = button('nb-fab', 'New entry', IC.plus + IC.pencil);
  root.appendChild(fab);

  function editing() { var cb = $(K + '-btn-edit'); return !!(cb && cb.checked); }
  function toggleEdit() {
    if (root.classList.contains('nb-noentry')) return;
    var bb = $(K + '-bb-edit');
    if (bb) bb.click();
    else { var cb = $(K + '-btn-edit'); if (!cb) return; cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    schedule();
  }
  function newEntry() { closeMenus(); var b = $(K + '-bb-new'); if (b) b.click(); }
  mode.addEventListener('click', function () { closeMenus(); toggleEdit(); });
  add.addEventListener('click', newEntry);
  fab.addEventListener('click', function () {
    if (fab.classList.contains('nb-fab-new')) newEntry(); else toggleEdit();
  });
  more.addEventListener('click', function () { if (menu) closeMenus(); else openMore(); });

  // ── ⋮ : what the desktop title bar holds and the phone bar has no room for ──
  var menu = null;
  function item(icon, label, fn) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'docx-mi nb-mmi'; b.setAttribute('data-noglow', '');
    b.innerHTML = '<span class="nb-mmi-ic">' + icon + '</span><span>' + label + '</span>';
    b.addEventListener('click', function () { closeMenus(); fn(); });
    return b;
  }
  function place(pop, anchor) {
    var r = anchor.getBoundingClientRect(), pw = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8)) + 'px';
    pop.style.top = (r.bottom + 4) + 'px';
  }
  function openPop(cls) {
    closeMenus();
    var pop = document.createElement('div');
    pop.className = 'docx-pop nb-mpop ' + cls;
    pop.setAttribute('data-nb-key', K);
    // Inside the root, so the side's own rules reach what it holds.
    root.appendChild(pop);
    menu = pop;
    return pop;
  }
  function openMore() {
    var noentry = root.classList.contains('nb-noentry');
    var pop = openPop('nb-mmenu');
    var lockBtn = $(K + '-mobile-lock-btn');
    if (lockBtn && lockBtn.style.display !== 'none' && !noentry && !(cfg.features && cfg.features.locks === false)) {
      var locked = lockBtn.classList.contains('tl-locked');
      pop.appendChild(item(locked ? IC.lock : IC.unlock, locked ? 'Locked: manage lock' : 'Lock entry', function () { lockBtn.click(); }));
    }
    var pdf = $(K + '-btn-export-pdf');
    if (pdf && !noentry) pop.appendChild(item(IC.pdf, 'Export PDF', function () { pdf.click(); }));
    if (!pop.children.length) { closeMenus(); return; }
    more.classList.add('open');
    place(pop, more);
  }
  function closeMenus() {
    if (menu) { menu.remove(); menu = null; }
    more.classList.remove('open');
  }
  document.addEventListener('pointerdown', function (e) {
    if (menu && !menu.contains(e.target) && !more.contains(e.target)) closeMenus();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menu) { e.stopPropagation(); closeMenus(); }
  }, true);

  // ── The ribbon, one row under the header (its swap button) ──
  var tb = null, tog = null;
  function dockParts() {
    tb = $(K + '-page-toolbar');
    if (!tb || tog || !tb.querySelector(':scope > .docx-ribbonrow')) return;
    tog = button('nb-dock-tog', 'Menus', IC.menus + IC.tools);
    tb.insertBefore(tog, tb.firstChild);
    tog.addEventListener('mousedown', function (e) { e.preventDefault(); });
    tog.addEventListener('click', function () {
      var on = tb.classList.toggle('nb-dock-menus');
      tog.setAttribute('aria-label', on ? 'Formatting' : 'Menus');
      schedule();
    });
    // A tap on a docked button keeps the keyboard up and the caret where it was
    // (the editor never loses focus). Selects and inputs still take it.
    tb.addEventListener('mousedown', function (e) {
      if (!root.classList.contains('nb-mdock')) return;
      var t = e.target.closest('button, .pt-btn');
      if (t && !e.target.closest('select, input, textarea')) e.preventDefault();
    }, true);
  }

  // While the onscreen keyboard is up, the page gets that much room under its
  // last line, so every line can be scrolled above the keyboard.
  function kbSpace() {
    var kb = keyboard();
    root.classList.toggle('nb-kb', kb > 0);
    // A screen fitted to the visible area (fitRoot) already ends at the keyboard.
    root.style.setProperty('--nb-kb-space', (root.classList.contains('nb-fit') ? 0 : kb) + 'px');
  }

  // index.html, a page open on a phone: the screen follows the VISIBLE area.
  // With the keyboard up, browsers pan the whole page to show the caret (a
  // re-render near the bottom was enough), which pushed the header up under the
  // address bar (Tony, 2026-11-17). The root's top tracks the visual viewport's
  // offset and its height ends at the keyboard, so the header stays put and the
  // page scrolls inside its own box. An instance lives in its host's layout and
  // is left alone.
  function fitRoot(on) {
    var vv = window.visualViewport;
    on = on && overlay && !!vv && vv.scale <= 1.01 && (vv.offsetTop > 0.5 || window.innerHeight - vv.height > 1);
    if (on) {
      // Written only when they change: the root's style is observed (sync).
      var t = Math.round(vv.offsetTop) + 'px', h = Math.round(vv.height) + 'px';
      if (root.style.getPropertyValue('top') !== t) root.style.setProperty('top', t, 'important');
      if (root.style.getPropertyValue('bottom') !== 'auto') root.style.setProperty('bottom', 'auto', 'important');
      if (root.style.getPropertyValue('height') !== h) root.style.setProperty('height', h, 'important');
      if (!root.classList.contains('nb-fit')) root.classList.add('nb-fit');
    } else if (root.classList.contains('nb-fit')) {
      root.style.removeProperty('top'); root.style.removeProperty('bottom'); root.style.removeProperty('height');
      root.classList.remove('nb-fit');
    }
  }

  // Typing on the last visible line: keep the caret above the keyboard.
  var caretRaf = 0;
  function keepCaret() {
    if (caretRaf) return;
    caretRaf = requestAnimationFrame(function () {
      caretRaf = 0;
      if (!root.classList.contains('nb-mdock') || !tb) return;
      var ed = $(K + '-page-editor'), wrap = $(K + '-page-editor-wrap');
      var sel = window.getSelection();
      if (!ed || !wrap || !sel || !sel.rangeCount || !ed.contains(sel.focusNode)) return;
      var rg = sel.getRangeAt(0).cloneRange(); rg.collapse(false);
      var rect = rg.getClientRects()[0];
      if (!rect) { var n = sel.focusNode; n = n && n.nodeType === 1 ? n : n && n.parentElement; if (!n) return; rect = n.getBoundingClientRect(); }
      var limit = Math.min(vvBottom(), wrap.getBoundingClientRect().bottom) - 16, top = wrap.getBoundingClientRect().top + 8;
      if (rect.bottom > limit) wrap.scrollTop += rect.bottom - limit;
      else if (rect.top < top && rect.bottom > 0) wrap.scrollTop -= top - rect.top;
    });
  }
  // Only while typing. On every selection change, or when the browser's bars
  // resized, it scrolled back to the caret while Tony was scrolling up to read
  // (2026-11-17).
  root.addEventListener('input', function (e) { if (e.target && e.target.id === K + '-page-editor') keepCaret(); }, true);
  root.addEventListener('keydown', function (e) { if (e.target && e.target.id === K + '-page-editor' && /^(Enter|ArrowDown|ArrowUp)$/.test(e.key)) keepCaret(); }, true);

  // ── State: one pass sets every class the stylesheet reads ──
  var raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; sync(); }); }
  // The open entry changed while the list was up (a new page from +, a host's
  // Notebook.open): the list steps aside for it.
  var lastActive = null;
  function activeId() { var a = document.querySelector('#' + K + '-entries-list .entry-item.active'); return a ? a.getAttribute('data-entry-id') : null; }
  // OurJournal <-> MyJournal from the list: the other tab's last page must not
  // open by itself; the list stays, on the other tab (Tony, 2026-11-17).
  var holdList = 0;
  root.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.oj-tab') && root.classList.contains('nb-mlist')) holdList = Date.now() + 1200;
  }, true);
  function sync() {
    var shell = mqShell.matches, touch = mqTouch.matches;
    var noentry = root.classList.contains('nb-noentry');
    var act = activeId();
    var holding = holdList > Date.now() && shell && hasList;
    if (holding && !noentry && sidebar && !sidebar.classList.contains(K + '-open')) {
      var openL = window['_' + K + 'SetDrawer']; if (typeof openL === 'function') openL(true);
    }
    if (act !== lastActive) {
      var was = lastActive; lastActive = act;
      if (!holding && was !== null && act && shell && sidebar && sidebar.classList.contains(K + '-open')) {
        var close = window['_' + K + 'SetDrawer']; if (typeof close === 'function') close(false);
      }
    }
    var listOpen = shell && hasList && (noentry || !!(sidebar && sidebar.classList.contains(K + '-open')));
    var doc = shell && !listOpen;
    var ed = editing();
    var pa = $(K + '-page-area');
    var page = !noentry && !!pa && pa.style.display === 'flex';
    var locked = shown($(K + '-locked-pane'));
    dockParts();
    var dock = touch && !!tb && tb.classList.contains('edit-mode') && page && !locked && (!shell || doc);
    if (!dock && tb && tb.classList.contains('nb-dock-menus')) { tb.classList.remove('nb-dock-menus'); if (tog) tog.setAttribute('aria-label', 'Menus'); }
    var set = { 'nb-m': touch, 'nb-shell': shell, 'nb-mlist': listOpen, 'nb-mdoc': doc, 'nb-medit': ed, 'nb-mpage': page, 'nb-mdock': dock };
    Object.keys(set).forEach(function (c) { if (root.classList.contains(c) !== !!set[c]) root.classList.toggle(c, !!set[c]); });
    mode.setAttribute('aria-label', ed ? 'Reading mode' : 'Edit');
    var fabNew = listOpen, fabEdit = doc && page && !ed && !locked;
    fab.classList.toggle('on', !!(fabNew || fabEdit));
    fab.classList.toggle('nb-fab-new', fabNew);
    fab.setAttribute('aria-label', fabNew ? 'New entry' : 'Edit');
    fitRoot(doc && shown(root));
    if (dock) kbSpace(); else { root.classList.remove('nb-kb'); root.style.removeProperty('--nb-kb-space'); }
    if (!doc && menu) closeMenus();
    // index.html: the open page covers the program nav (the list shows it).
    var de = document.documentElement, mine = de.getAttribute('data-nb-doc') === K;
    var cover = overlay && doc && shown(root);
    if (cover && !mine) de.setAttribute('data-nb-doc', K);
    else if (!cover && mine) de.removeAttribute('data-nb-doc');
  }

  var mo = new MutationObserver(schedule);
  mo.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
  if (sidebar) mo.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
  var list = $(K + '-entries-list');
  if (list) mo.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  ['page-area', 'locked-pane'].forEach(function (s) { var el = $(K + '-' + s); if (el) mo.observe(el, { attributes: true, attributeFilter: ['style'] }); });
  // The page toolbar may be built later (the editor starts on first open).
  function watchTb() {
    var t = $(K + '-page-toolbar');
    if (t && !t._nbWatched) { t._nbWatched = true; mo.observe(t, { attributes: true, attributeFilter: ['class'] }); }
  }
  watchTb();
  root.addEventListener('change', function (e) { if (e.target && e.target.id === K + '-btn-edit') schedule(); });
  root.addEventListener('click', function () { watchTb(); schedule(); });
  [mqShell, mqTouch].forEach(function (m) { if (m.addEventListener) m.addEventListener('change', schedule); else m.addListener(schedule); });
  window.addEventListener('resize', schedule);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', schedule);
    window.visualViewport.addEventListener('scroll', schedule);
  }
  sync();
  return true;
}

window.NotebookMobile = { wire: wire, SHELL: SHELL, TOUCH: TOUCH, keyboard: keyboard };
// index.html mounts its two sides before this file loads: wire what is built.
['tj', 'bj'].forEach(function (k) { if ($(k + '-root')) wire(k); });
})();
