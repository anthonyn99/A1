/* ─────────────────────────────────────────────────────────────────────────────
 * popups.js — how every A1 popup sits on the page. Shared by every program.
 *
 * Tony, 2026-11-03: "Apply this EXACT effect to ALL popups ... Update the
 * defaults so that this is how background behaves for all popups in A1 in the
 * future too. For all popups, allow me to click OUTSIDE the popup to close it,
 * but if I'm highlighting text and my cursor goes out of the popup and then I
 * let go of the click, don't close the popup."
 *
 * 1. The look. The backdrop behind any popup is TaskHub's "New — <date>"
 *    window's: rgba(0,0,0,.6) under blur(7px) saturate(.9), both sides.
 *    A backdrop is found by what it is, not by its class: a position:fixed
 *    element covering the viewport whose background is see-through (not
 *    clear, not solid) or that already blurs. It gets data-a1-scrim, and the
 *    rule below wins over the program's own colour and blur. A clear layer
 *    (a menu's click-catcher), a solid one (a page, a title screen) and one
 *    with pointer-events:none (a glow) are left alone.
 *
 * 2. Click outside closes. A click that both starts and ends on the backdrop
 *    closes the popup. If the program already closes on that click, nothing
 *    more happens; if it doesn't, Escape is sent to the popup, and if it is
 *    still open, its Close / Cancel / × button is pressed. A popup with none of
 *    those stays open.
 *
 * 3. A drag never closes. A press inside the popup that is let go on the
 *    backdrop (selecting text, dragging a slider) — or the other way round —
 *    is stopped before the program's own backdrop handler sees it.
 *
 * Add it with one tag in <head>, before the page's own code:
 *   <script src="popups.js"></script>
 * New popup code needs nothing: a fixed, see-through, full-screen backdrop is
 * picked up on its own. `class="a1-scrim"` forces the look on one that isn't
 * found (e.g. a backdrop drawn by a sibling). `data-a1-popup="keep"` on a
 * backdrop (or anything around it) keeps it open on an outside click;
 * `data-a1-popup="off"` opts a subtree out of both the look and the closing.
 * Guardian's lock lives in a shadow root and is never touched here (it carries
 * the same look in its own CSS and never closes on a click).
 *
 * Prove behaviour with: node tests/live/popups.live.js
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.A1Popups) return;
  var doc = document;

  var DIM = 'rgba(0,0,0,.6)';
  var BLUR = 'blur(7px) saturate(.9)';
  var LOOK = 'background:' + DIM + '!important;background-image:none!important;' +
    '-webkit-backdrop-filter:' + BLUR + '!important;backdrop-filter:' + BLUR + '!important';
  // Doubled attribute: beats a program's own `#id.class` backdrop rule even
  // when that rule carries !important too.
  var CSS = 'html [data-a1-scrim][data-a1-scrim],html .a1-scrim.a1-scrim{' + LOOK + '}';

  function addStyle() {
    if (doc.getElementById('a1-popups-css')) return;
    var s = doc.createElement('style');
    s.id = 'a1-popups-css';
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  // ── What a backdrop is ──────────────────────────────────────────────────
  function alpha(c) {
    if (!c || c === 'transparent') return 0;
    var m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return 1;
    var p = m[1].split(/[\s,\/]+/).filter(Boolean);
    if (p.length < 4) return 1;
    var a = p[3];
    return /%$/.test(a) ? parseFloat(a) / 100 : parseFloat(a);
  }
  function px(v) { return v === 'auto' ? NaN : parseFloat(v); }
  function optedOut(el) {
    return !!(el.closest && el.closest('[data-a1-popup="off"]'));
  }
  // Covers the viewport: measured when it is on screen, read from its inset
  // when it is hidden (display:none has no box), so a popup is tagged before
  // it ever opens.
  function covers(el, cs) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var r = el.getBoundingClientRect();
    if (r.width && r.height) return r.width >= vw * 0.95 && r.height >= vh * 0.9 && r.left <= vw * 0.05 && r.top <= vh * 0.1;
    var t = px(cs.top), b = px(cs.bottom), l = px(cs.left), rt = px(cs.right);
    var w = px(cs.width), h = px(cs.height);
    var wide = l <= 1 && (rt <= 1 || cs.width === '100%' || w >= vw * 0.95);
    var tall = t <= 1 && (b <= 1 || cs.height === '100%' || h >= vh * 0.9);
    return wide && tall;
  }
  function isScrim(el) {
    if (!el || el.nodeType !== 1 || el === doc.body || el === doc.documentElement) return false;
    if (el.classList.contains('a1-scrim')) return true;
    if (el.shadowRoot) return false;
    var cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.pointerEvents === 'none') return false;
    var a = alpha(cs.backgroundColor);
    var blurs = cs.backdropFilter && cs.backdropFilter !== 'none' || cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none';
    if (!((a > 0.04 && a < 0.97) || (blurs && a < 0.97))) return false;
    if (!covers(el, cs)) return false;
    return !optedOut(el);
  }

  function tag(el) {
    if (el.nodeType !== 1 || el.hasAttribute('data-a1-scrim')) return;
    if (isScrim(el)) el.setAttribute('data-a1-scrim', '');
  }
  // A tagged element whose class or style changed is checked again with the
  // tag off, so the look it is judged by is its own, not ours.
  function untagIfGone(el) {
    el.removeAttribute('data-a1-scrim');
    if (isScrim(el)) el.setAttribute('data-a1-scrim', '');
  }
  function scanTree(root, maxDepth) {
    tag(root);
    var kids = root.children;
    if (!kids || maxDepth <= 0) return;
    for (var i = 0; i < kids.length; i++) scanTree(kids[i], maxDepth - 1);
  }
  function scanAll() {
    if (!doc.body) return;
    var all = doc.body.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) tag(all[i]);
  }

  // Newly added subtrees and elements whose class / style changed are looked
  // at once a frame. A big subtree (a program's first render) is read in full
  // only when small; the full-page scans after load catch the rest.
  var pendingAdd = [], pendingAttr = [], queued = false;
  function flush() {
    queued = false;
    var add = pendingAdd, attr = pendingAttr;
    pendingAdd = []; pendingAttr = [];
    if (attr.length > 1) attr = Array.from(new Set(attr));
    for (var i = 0; i < add.length; i++) {
      var n = add[i];
      if (!n.isConnected) continue;
      var size = n.getElementsByTagName ? n.getElementsByTagName('*').length : 0;
      scanTree(n, size <= 600 ? 64 : 4);
    }
    for (var j = 0; j < attr.length; j++) {
      var el = attr[j];
      if (!el.isConnected) continue;
      if (el.hasAttribute('data-a1-scrim')) untagIfGone(el);
      else scanTree(el, 1);
    }
  }
  function queue() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(flush);
  }
  var mo = new MutationObserver(function (list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === 'childList') {
        for (var k = 0; k < m.addedNodes.length; k++) if (m.addedNodes[k].nodeType === 1) pendingAdd.push(m.addedNodes[k]);
      } else if (m.attributeName !== 'data-a1-scrim') {
        pendingAttr.push(m.target);
      }
    }
    if (pendingAdd.length || pendingAttr.length) queue();
  });

  // ── Click outside ───────────────────────────────────────────────────────
  function scrimOf(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute('data-a1-scrim') || isScrim(n)) return n;
    }
    return null;
  }
  // The point is on the backdrop: the backdrop itself, or a clear wrapper that
  // fills it (a centring layer between it and the window).
  function onBackdrop(target, scrim) {
    if (!scrim) return false;
    var sr = scrim.getBoundingClientRect();
    for (var n = target; n && n !== scrim; n = n.parentElement) {
      if (n.nodeType !== 1) return false;
      var cs = getComputedStyle(n), r = n.getBoundingClientRect();
      if (alpha(cs.backgroundColor) > 0.04 || cs.backgroundImage !== 'none') return false;
      if (r.width < sr.width * 0.9 || r.height < sr.height * 0.9) return false;
    }
    return n === scrim;
  }
  function backdropAt(target) {
    var s = target && target.nodeType === 1 ? scrimOf(target) : null;
    return s && onBackdrop(target, s) ? s : null;
  }

  var down = null;   // { scrim, inside } for the press in progress
  var up = null;
  function onDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') { down = null; return; }
    var s = backdropAt(e.target);
    down = { scrim: s, target: e.target };
    up = null;
  }
  function onUp(e) {
    up = { scrim: backdropAt(e.target) };
  }

  function snapshot(el) {
    var out = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      out.push((n.getAttribute('class') || '') + '|' + (n.getAttribute('style') || '') + '|' +
        n.hasAttribute('hidden') + '|' + n.hasAttribute('open') + '|' + (n.getAttribute('aria-hidden') || ''));
    }
    return out.join('\n');
  }
  function stillOpen(el, before) {
    if (!el.isConnected || !el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return snapshot(el) === before;
  }
  var CLOSE_WORDS = /^(×|✕|✖|╳|x|close|cancel|dismiss|back|not now|no thanks)$/i;
  function closeButton(scrim) {
    var root = scrim.children.length ? scrim : scrim.parentElement;
    if (!root) return null;
    var c = root.querySelectorAll('button,[role="button"],a[href="#"],a:not([href])');
    var best = null, bestRank = 9;
    for (var i = 0; i < c.length; i++) {
      var b = c[i];
      if (b.disabled || !b.getClientRects().length) continue;
      var words = [b.getAttribute('aria-label'), b.getAttribute('title'), (b.textContent || '').trim()];
      for (var w = 0; w < words.length; w++) {
        var t = (words[w] || '').trim();
        if (!t || !CLOSE_WORDS.test(t)) continue;
        var rank = /^(×|✕|✖|╳|x|close)$/i.test(t) ? 0 : /^cancel$/i.test(t) ? 1 : 2;
        if (rank < bestRank) { best = b; bestRank = rank; }
      }
    }
    return best;
  }
  function closeIt(scrim, before) {
    setTimeout(function () {
      if (!stillOpen(scrim, before)) return;           // the program closed it
      var at = scrim.contains(doc.activeElement) ? doc.activeElement : (scrim.firstElementChild || scrim);
      var esc = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
      try { at.dispatchEvent(new KeyboardEvent('keydown', esc)); } catch (_) {}
      setTimeout(function () {
        if (!stillOpen(scrim, before)) return;
        var b = closeButton(scrim);
        if (b) b.click();
      }, 60);
    }, 60);
  }

  function onClick(e) {
    if (!e.isTrusted || e.button !== 0) return;
    var d = down, u = up;
    down = null; up = null;
    if (!d) return;
    var s = backdropAt(e.target);
    if (!s) return;
    if (d.scrim === s && u && u.scrim === s) {
      if (s.closest('[data-a1-popup="keep"]')) return;
      closeIt(s, snapshot(s));
      return;
    }
    // Pressed inside the popup and let go outside (or the reverse): not a
    // click on the backdrop, whatever the browser says.
    e.stopImmediatePropagation();
    e.preventDefault();
  }

  // ── Start ───────────────────────────────────────────────────────────────
  addStyle();
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('click', onClick, true);
  function start() {
    addStyle();
    scanAll();
    mo.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    setTimeout(scanAll, 1500);
    setTimeout(scanAll, 5000);
  }
  if (doc.body) start();
  else doc.addEventListener('DOMContentLoaded', start);

  window.A1Popups = {
    DIM: DIM,
    BLUR: BLUR,
    isScrim: isScrim,
    scan: scanAll,
    _backdropAt: backdropAt
  };
})();
