/* ─────────────────────────────────────────────────────────────────────────────
 * vault-controls.js — themed replacements for every piece of browser UI
 *
 * Vault draws ALL of its own chrome. Nothing the browser renders natively is
 * left on screen: this module swaps each one for a theme-coloured equivalent,
 * for every section (Keychain, Passwords, Payments, ID Docs, API Keys,
 * Sensitive Info, Cloud, the lock screen, every modal) and for the Launcher
 * popup. It is self-installing and works on markup it has never seen:
 * a MutationObserver enhances controls as they're added, so a section module
 * just builds ordinary <select> / <input type=date> / <textarea> elements.
 *
 *   Scrollbars   native bars hidden everywhere; an overlay thumb fades in while
 *                a box scrolls (or the pointer nears its edge), fades out when
 *                idle, and can be dragged — mouse, pen or finger (the touch hit
 *                area is wider than the visible pill). Track clicks page.
 *   <select>     a themed button + listbox (keyboard, type-ahead, touch). The
 *                real <select> stays in the DOM, hidden, as the source of
 *                truth: code that reads/sets `.value` or listens for `change`
 *                keeps working unchanged (setting `.value` repaints the button).
 *   date inputs  a themed field + calendar popover (day / month / year views,
 *                Today, Clear, min/max, keyboard). Same hidden-source pattern.
 *   datalists    `<input list>` becomes a themed suggestion menu.
 *   checkbox / radio / range / number / search / autofill / focus ring /
 *   selection / placeholder — restyled in CSS.
 *   textarea     the native resize grip is replaced by a themed drag grip.
 *   title=""     native tooltips become themed ones (mouse / pen only).
 *
 * Opt out per element with `data-native` (and per subtree with
 * `data-native-scroll` for scrollbars).
 * ──────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';
  if (window.VaultControls) return;
  var doc = document;
  var root = doc.documentElement;
  var coarse = window.matchMedia ? window.matchMedia('(pointer:coarse)') : { matches: false };
  var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion:reduce)') : { matches: false };

  var ICON = {
    chev: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    cal: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
    left: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    grip: '<svg viewBox="0 0 16 16" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M14 6 6 14M14 10l-4 4"/></svg>',
  };

  // ── styles ─────────────────────────────────────────────────────────────────
  var CSS = [
    ':root{color-scheme:dark;--field:#19191c}',
    // Native scrollbars off everywhere — the overlay thumb below replaces them.
    'html.vc-on *:not([data-native-scroll]){scrollbar-width:none!important}',
    'html.vc-on :not([data-native-scroll])::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;background:transparent!important}',
    '::selection{background:rgba(224,184,116,.30);color:inherit}',
    'input,textarea{caret-color:var(--ac,#e0b874)}',
    'input::placeholder,textarea::placeholder{color:var(--txm,#8d8d94);opacity:1}',
    ':focus-visible{outline-color:var(--ac,#e0b874)}',
    // Browser autofill paints fields pale yellow/blue — keep them on-theme.
    'input:-webkit-autofill,input:-webkit-autofill:hover,input:-webkit-autofill:focus,textarea:-webkit-autofill,select:-webkit-autofill{',
    '  -webkit-box-shadow:0 0 0 1000px var(--field,#19191c) inset!important;-webkit-text-fill-color:var(--tx,#f4f3f0)!important;',
    '  caret-color:var(--ac,#e0b874);transition:background-color 99999s ease-out}',
    // Built-in widgets inside fields.
    'input::-ms-reveal,input::-ms-clear{display:none}',
    'input[type=search]::-webkit-search-cancel-button,input[type=search]::-webkit-search-decoration{-webkit-appearance:none;display:none}',
    'input[type=number]{-moz-appearance:textfield;appearance:textfield}',
    'input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}',
    'input::-webkit-calendar-picker-indicator{display:none!important;-webkit-appearance:none}',
    // Checkboxes + radios.
    'input[type=checkbox]:not([data-native]),input[type=radio]:not([data-native]){-webkit-appearance:none;appearance:none;width:18px;height:18px;margin:0;flex-shrink:0;',
    '  border:1.5px solid var(--bdl,#45454c);border-radius:5px;background:var(--field,#19191c);display:inline-grid;place-content:center;',
    '  cursor:pointer;vertical-align:middle;transition:background-color .15s,border-color .15s,box-shadow .15s}',
    'input[type=radio]:not([data-native]){border-radius:50%}',
    'input[type=checkbox]:not([data-native])::after{content:"";width:10px;height:10px;background:#1a1a1d;transform:scale(0);transition:transform .14s ease;',
    '  clip-path:polygon(14% 44%,0 65%,50% 100%,100% 16%,80% 0%,43% 62%)}',
    'input[type=radio]:not([data-native])::after{content:"";width:8px;height:8px;border-radius:50%;background:#1a1a1d;transform:scale(0);transition:transform .14s ease}',
    'input[type=checkbox]:not([data-native]):hover,input[type=radio]:not([data-native]):hover{border-color:var(--txd,#adadb2)}',
    'input[type=checkbox]:not([data-native]):checked,input[type=radio]:not([data-native]):checked{background:var(--ac,#e0b874);border-color:var(--ac,#e0b874)}',
    'input[type=checkbox]:not([data-native]):checked::after,input[type=radio]:not([data-native]):checked::after{transform:scale(1)}',
    'input[type=checkbox]:not([data-native]):focus-visible,input[type=radio]:not([data-native]):focus-visible{outline:none;box-shadow:0 0 0 3px rgba(224,184,116,.28)}',
    'input[type=checkbox]:not([data-native]):disabled,input[type=radio]:not([data-native]):disabled{opacity:.4;cursor:not-allowed}',
    '@media (pointer:coarse){input[type=checkbox]:not([data-native]),input[type=radio]:not([data-native]){width:20px;height:20px}}',
    // Range sliders. --vc-pct is kept current by JS so the filled part tracks.
    'input[type=range]:not([data-native]){-webkit-appearance:none;appearance:none;background:transparent;height:24px;cursor:pointer;margin:0;touch-action:pan-y}',
    'input[type=range]:not([data-native])::-webkit-slider-runnable-track{height:4px;border-radius:2px;',
    '  background:linear-gradient(to right,var(--ac,#e0b874) var(--vc-pct,50%),var(--bd,#34343a) var(--vc-pct,50%))}',
    'input[type=range]:not([data-native])::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;margin-top:-7px;',
    '  background:var(--ac,#e0b874);border:3px solid var(--s2,#2c2c31);box-shadow:0 0 0 1px var(--ac,#e0b874),0 2px 6px rgba(0,0,0,.4);transition:transform .12s}',
    'input[type=range]:not([data-native]):active::-webkit-slider-thumb{transform:scale(1.12)}',
    'input[type=range]:not([data-native])::-moz-range-track{height:4px;border-radius:2px;background:var(--bd,#34343a)}',
    'input[type=range]:not([data-native])::-moz-range-progress{height:4px;border-radius:2px;background:var(--ac,#e0b874)}',
    'input[type=range]:not([data-native])::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--ac,#e0b874);border:3px solid var(--s2,#2c2c31)}',
    'input[type=range]:not([data-native]):focus-visible{outline:none}',
    'input[type=range]:not([data-native]):focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 4px rgba(224,184,116,.3)}',
    // ── overlay scrollbar ──
    '.vc-rail{position:fixed;z-index:60;pointer-events:none;opacity:0;transition:opacity .35s ease;touch-action:none}',
    '.vc-rail.on{opacity:1;pointer-events:auto;transition-duration:.14s}',
    '.vc-rail.v{width:14px}.vc-rail.h{height:14px}',
    '.vc-thumb{position:absolute;border-radius:99px;background:rgba(173,173,178,.45);cursor:grab;',
    '  transition:background-color .15s,width .15s,height .15s;touch-action:none}',
    '.vc-rail.v .vc-thumb{right:3px;width:6px}.vc-rail.h .vc-thumb{bottom:3px;height:6px}',
    '.vc-thumb::before{content:"";position:absolute;inset:-6px -4px}',
    '.vc-rail:hover .vc-thumb,.vc-rail.drag .vc-thumb{background:var(--ac,#e0b874)}',
    '.vc-rail.v:hover .vc-thumb,.vc-rail.v.drag .vc-thumb{width:9px}.vc-rail.h:hover .vc-thumb,.vc-rail.h.drag .vc-thumb{height:9px}',
    '.vc-rail.drag .vc-thumb{cursor:grabbing}',
    '@media (pointer:coarse){',
    // Finger-sized grab area, thin visible pill.
    '  .vc-rail.v{width:28px}.vc-rail.h{height:28px}',
    '  .vc-rail.v .vc-thumb{width:5px;right:3px}.vc-rail.h .vc-thumb{height:5px;bottom:3px}',
    '  .vc-thumb::before{inset:-10px -12px -10px -20px}',
    // On touch only the thumb takes the finger: the rest of the rail must never
    // eat a tap meant for a row button at the edge of the list.
    '  .vc-rail.on{pointer-events:none}.vc-rail.on .vc-thumb{pointer-events:auto}',
    '  .vc-rail.v.drag .vc-thumb{width:8px}.vc-rail.h.drag .vc-thumb{height:8px}',
    '}',
    'html.vc-dragging,html.vc-dragging *{cursor:grabbing!important;user-select:none!important;-webkit-user-select:none!important}',
    // ── popovers (select menu, suggestions, calendar) ──
    '.vc-pop{position:fixed;z-index:2147483600;background:#323238;color:var(--tx,#f4f3f0);border:1px solid var(--bdl,#45454c);border-radius:10px;',
    '  box-shadow:0 18px 50px rgba(0,0,0,.55),0 0 0 1px rgba(224,184,116,.07);padding:5px;overflow-y:auto;overscroll-behavior:contain;',
    '  font-family:var(--sans,system-ui,sans-serif);font-size:13.5px;opacity:0;transform:translateY(-4px);transition:opacity .14s ease,transform .14s ease}',
    '.vc-pop.up{transform:translateY(4px)}.vc-pop.on{opacity:1;transform:none}',
    '.vc-opt{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:7px;cursor:pointer;min-height:36px;user-select:none;-webkit-user-select:none}',
    '.vc-opt .vc-otext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.vc-opt .vc-ocheck{flex-shrink:0;color:var(--ac,#e0b874);opacity:0;display:flex}',
    '.vc-opt.sel{color:var(--acs,#e0b874)}.vc-opt.sel .vc-ocheck{opacity:1}',
    '.vc-opt.act{background:rgba(224,184,116,.11)}',
    '.vc-opt[aria-disabled=true]{opacity:.38;cursor:not-allowed}',
    '.vc-grp{font-size:10px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:var(--txm,#8d8d94);padding:9px 11px 4px}',
    '.vc-empty{padding:10px 11px;color:var(--txm,#8d8d94)}',
    '@media (pointer:coarse){.vc-opt{min-height:44px}}',
    // hidden source elements
    '.vc-native{position:absolute!important;opacity:0!important;pointer-events:none!important;width:1px!important;height:1px!important;',
    '  min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;clip-path:inset(50%)!important;overflow:hidden!important}',
    // select / date buttons — they inherit the source's classes, so a
    // `.vault-input` select looks exactly like a `.vault-input` text field.
    '.vc-select,.vc-date{display:flex;align-items:center;gap:8px;text-align:left;cursor:pointer;-webkit-appearance:none;appearance:none;font:inherit;color:var(--tx,#f4f3f0);line-height:1.25}',
    '.vc-select .vc-lbl,.vc-date .vc-lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.vc-select .vc-ic,.vc-date .vc-ic{flex-shrink:0;display:flex;color:var(--txd,#adadb2);transition:transform .18s,color .18s}',
    '.vc-select[aria-expanded=true] .vc-ic{transform:rotate(180deg);color:var(--ac,#e0b874)}',
    '.vc-date[aria-expanded=true] .vc-ic{color:var(--ac,#e0b874)}',
    '.vc-select[aria-expanded=true],.vc-date[aria-expanded=true]{border-color:var(--ac,#e0b874)!important}',
    '.vc-select:disabled,.vc-date:disabled{opacity:.5;cursor:not-allowed}',
    '.vc-ph{color:var(--txm,#8d8d94)}',
    // calendar
    '.vc-cal{width:296px;padding:10px}',
    '.vc-cal-head{display:flex;align-items:center;gap:4px;margin-bottom:6px}',
    '.vc-cal-title{flex:1;background:transparent;border:1px solid transparent;color:var(--tx,#f4f3f0);font:inherit;font-weight:600;font-size:14px;padding:6px 8px;border-radius:7px;cursor:pointer;text-align:left}',
    '.vc-cal-title:hover{border-color:var(--bdl,#45454c)}',
    '.vc-cal-nav{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--bd,#34343a);color:var(--txd,#adadb2);border-radius:7px;cursor:pointer}',
    '.vc-cal-nav:hover{color:var(--ac,#e0b874);border-color:var(--ac,#e0b874)}',
    '.vc-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}',
    '.vc-cal-grid.m{grid-template-columns:repeat(3,1fr);gap:6px}',
    '.vc-cal-dow{font-size:10.5px;font-weight:600;color:var(--txm,#8d8d94);text-align:center;padding:4px 0;letter-spacing:.4px}',
    '.vc-cal-cell{height:36px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--tx,#f4f3f0);font:inherit;font-size:13px;cursor:pointer;font-variant-numeric:tabular-nums}',
    '.vc-cal-grid.m .vc-cal-cell{height:44px}',
    '.vc-cal-cell:hover{background:rgba(224,184,116,.10)}',
    '.vc-cal-cell.out{color:var(--txm,#8d8d94);opacity:.55}',
    '.vc-cal-cell.today{border-color:var(--bdl,#45454c)}',
    '.vc-cal-cell.sel{background:var(--ac,#e0b874);color:#1a1a1d;font-weight:700}',
    '.vc-cal-cell:disabled{opacity:.25;cursor:not-allowed;background:transparent}',
    '.vc-cal-cell:focus-visible{outline:2px solid var(--ac,#e0b874);outline-offset:-2px}',
    '.vc-cal-foot{display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid var(--bd,#34343a)}',
    '.vc-cal-link{background:transparent;border:none;color:var(--ac,#e0b874);font:inherit;font-size:12.5px;font-weight:600;padding:6px 8px;border-radius:6px;cursor:pointer}',
    '.vc-cal-link:hover{background:rgba(224,184,116,.10)}',
    '@media (pointer:coarse){.vc-cal-cell{height:40px}}',
    // tooltip
    '.vc-tip{position:fixed;z-index:2147483646;pointer-events:none;background:#3a3a41;color:var(--tx,#f4f3f0);border:1px solid var(--bdl,#45454c);',
    '  font-family:var(--sans,system-ui,sans-serif);font-size:11.5px;font-weight:500;line-height:1.35;padding:5px 9px;border-radius:6px;',
    '  box-shadow:0 8px 22px rgba(0,0,0,.45);max-width:260px;opacity:0;transform:translateY(3px);transition:opacity .12s,transform .12s}',
    '.vc-tip.on{opacity:1;transform:none}',
    // textarea grip
    '.vc-ta{position:relative;display:block;min-width:0}',
    'textarea.vc-has-grip{resize:none!important}',
    '.vc-grip{position:absolute;right:4px;bottom:4px;width:14px;height:14px;cursor:ns-resize;touch-action:none;color:var(--txm,#8d8d94);opacity:.75;z-index:1}',
    '.vc-grip:hover,.vc-grip.drag{color:var(--ac,#e0b874);opacity:1}',
    '@media (pointer:coarse){.vc-grip{width:22px;height:22px;right:2px;bottom:2px}}',
    '@media (prefers-reduced-motion:reduce){.vc-rail,.vc-pop,.vc-tip,.vc-thumb{transition:none!important}}',
  ].join('\n');

  function injectStyles() {
    if (doc.getElementById('vc-styles')) return;
    var s = doc.createElement('style'); s.id = 'vc-styles'; s.textContent = CSS;
    (doc.head || root).appendChild(s);
    root.classList.add('vc-on');
  }

  function h(tag, cls, html) { var e = doc.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function isNative(el) { return !!(el && el.closest && el.closest('[data-native]')); }

  // ── layering ───────────────────────────────────────────────────────────────
  // Floating UI must live in the same top layer as its anchor (a modal
  // overlay, the lock screen…), or it would paint under it. The host is the
  // nearest position:fixed ancestor; failing that, <body>.
  function layerOf(el) {
    for (var e = el && el.parentElement; e && e !== doc.body; e = e.parentElement) {
      if (getComputedStyle(e).position === 'fixed') return e;
    }
    return doc.body;
  }
  // A position:fixed child is positioned against the viewport UNLESS an
  // ancestor has a transform / filter / backdrop-filter, which makes that
  // ancestor the containing block. Measure instead of guessing.
  function fixedOrigin(node) {
    var prev = node.style.cssText;
    node.style.left = '0px'; node.style.top = '0px';
    var r = node.getBoundingClientRect();
    node.style.cssText = prev;
    return { x: r.left, y: r.top };
  }
  function vw() { return root.clientWidth || window.innerWidth; }
  function vh() { return window.innerHeight || root.clientHeight; }

  // Place a popover under (or over) its anchor, clamped inside the viewport.
  function place(pop, anchor, minWidth) {
    var r = anchor.getBoundingClientRect();
    var o = fixedOrigin(pop);
    var W = vw(), H = vh(), gap = 6, pad = 8;
    var width = Math.min(Math.max(r.width, minWidth || 0), W - pad * 2);
    pop.style.minWidth = width + 'px';
    pop.style.maxWidth = (W - pad * 2) + 'px';
    var below = H - r.bottom - gap - pad, above = r.top - gap - pad;
    var natural = Math.min(pop.scrollHeight + 2, 340);
    var up = below < Math.min(natural, 220) && above > below;
    var maxH = Math.max(120, Math.min(340, up ? above : below));
    pop.style.maxHeight = maxH + 'px';
    var pw = pop.offsetWidth || width;
    var left = Math.min(Math.max(pad, r.left), W - pad - pw);
    var top = up ? Math.max(pad, r.top - gap - Math.min(pop.offsetHeight || natural, maxH)) : r.bottom + gap;
    pop.style.left = (left - o.x) + 'px';
    pop.style.top = (top - o.y) + 'px';
    pop.classList.toggle('up', up);
  }

  // One open popover at a time.
  var openPop = null;
  function openPopover(pop, anchor, opts) {
    closePopover();
    opts = opts || {};
    var host = layerOf(anchor);
    host.appendChild(pop);
    place(pop, anchor, opts.minWidth);
    requestAnimationFrame(function () { pop.classList.add('on'); });
    var state = {
      pop: pop, anchor: anchor, onClose: opts.onClose,
      reposition: function () { if (pop.isConnected) place(pop, anchor, opts.minWidth); },
      outside: function (e) {
        if (pop.contains(e.target) || anchor.contains(e.target)) return;
        closePopover();
      },
      scroll: function (e) {
        if (pop.contains(e.target)) return;
        if (!anchor.isConnected) { closePopover(); return; }
        state.reposition();
      },
    };
    doc.addEventListener('pointerdown', state.outside, true);
    doc.addEventListener('scroll', state.scroll, true);
    window.addEventListener('resize', state.reposition);
    openPop = state;
    return state;
  }
  function closePopover() {
    var s = openPop; if (!s) return;
    openPop = null;
    doc.removeEventListener('pointerdown', s.outside, true);
    doc.removeEventListener('scroll', s.scroll, true);
    window.removeEventListener('resize', s.reposition);
    s.pop.classList.remove('on');
    var p = s.pop;
    setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, reduced.matches ? 0 : 140);
    if (s.onClose) try { s.onClose(); } catch (e) {}
  }

  // Keep a hidden source element's `.value` (and friends) observable, so code
  // that assigns it directly repaints the themed control without an event.
  function watchProp(el, proto, prop, after) {
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    try {
      Object.defineProperty(el, prop, {
        configurable: true, enumerable: true,
        get: function () { return d.get.call(this); },
        set: function (v) { d.set.call(this, v); after(); },
      });
    } catch (e) {}
  }
  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Mirror what makes the source visible/usable onto its themed stand-in.
  function mirrorState(src, btn) {
    var hidden = src.hidden || src.style.display === 'none';
    btn.style.display = hidden ? 'none' : '';
    btn.disabled = !!src.disabled;
  }
  function copyLook(src, btn, extra) {
    btn.className = (src.className || '').replace(/\bvc-native\b/g, '').trim() + ' ' + extra;
    var css = src.style.cssText.replace(/display\s*:[^;]+;?/i, '');
    if (css) btn.style.cssText = css;
    ['aria-label', 'aria-describedby', 'title'].forEach(function (a) { if (src.hasAttribute(a)) btn.setAttribute(a, src.getAttribute(a)); });
  }
  // A <label for=…> pointing at the hidden source should open its stand-in.
  function forwardLabel(src, btn) {
    src._vcBtn = btn;
    src.addEventListener('focus', function () { btn.focus(); });
  }
  // ONE delegated handler for every enhanced control (not one per control,
  // which would pile up with every modal ever opened).
  doc.addEventListener('click', function (e) {
    var l = e.target && e.target.closest && e.target.closest('label[for]');
    if (!l) return;
    var src = doc.getElementById(l.htmlFor);
    if (src && src._vcBtn && src.isConnected) { e.preventDefault(); src._vcBtn.focus(); src._vcBtn.click(); }
  });

  // ── <select> ───────────────────────────────────────────────────────────────
  function enhanceSelect(sel) {
    if (sel._vc || sel.multiple || (sel.size && sel.size > 1) || isNative(sel)) return;
    sel._vc = true;
    var btn = h('button', '');
    btn.type = 'button';
    copyLook(sel, btn, 'vc-select');
    btn.setAttribute('role', 'combobox');
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    var lbl = h('span', 'vc-lbl'), ic = h('span', 'vc-ic', ICON.chev);
    btn.appendChild(lbl); btn.appendChild(ic);
    sel.classList.add('vc-native');
    sel.setAttribute('tabindex', '-1');
    sel.setAttribute('aria-hidden', 'true');
    sel.parentNode.insertBefore(btn, sel.nextSibling);

    function sync() {
      var o = sel.options[sel.selectedIndex];
      lbl.textContent = o ? o.textContent : '';
      lbl.classList.toggle('vc-ph', !o || (o.value === '' && /^(select|choose|—|-|mm|yyyy)/i.test(o.textContent.trim())));
      mirrorState(sel, btn);
    }
    watchProp(sel, HTMLSelectElement.prototype, 'value', sync);
    watchProp(sel, HTMLSelectElement.prototype, 'selectedIndex', sync);
    sel.addEventListener('change', sync);
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'disabled', 'selected', 'label'] });
    forwardLabel(sel, btn);
    sync();

    var typed = '', typedAt = 0;
    function open() {
      if (btn.disabled) return;
      var pop = h('div', 'vc-pop');
      pop.setAttribute('role', 'listbox');
      var items = [];
      var opts = Array.prototype.slice.call(sel.options);
      var lastGroup = null;
      opts.forEach(function (o, i) {
        if (o.hidden) return;
        var g = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement : null;
        if (g && g !== lastGroup) { pop.appendChild(h('div', 'vc-grp')).textContent = g.label; }
        lastGroup = g;
        var it = h('div', 'vc-opt' + (i === sel.selectedIndex ? ' sel' : ''));
        it.setAttribute('role', 'option');
        it.setAttribute('aria-selected', i === sel.selectedIndex ? 'true' : 'false');
        if (o.disabled || (g && g.disabled)) it.setAttribute('aria-disabled', 'true');
        var t = h('span', 'vc-otext'); t.textContent = o.textContent;
        it.appendChild(t); it.appendChild(h('span', 'vc-ocheck', ICON.check));
        it._i = i;
        it.addEventListener('click', function () { choose(it); });
        it.addEventListener('pointermove', function () { setAct(items.indexOf(it)); });
        pop.appendChild(it); items.push(it);
      });
      if (!items.length) pop.appendChild(h('div', 'vc-empty')).textContent = 'No options';
      var act = Math.max(0, items.findIndex(function (x) { return x._i === sel.selectedIndex; }));
      function setAct(n) {
        if (n < 0 || n >= items.length) return;
        items.forEach(function (x, j) { x.classList.toggle('act', j === n); });
        act = n;
      }
      function scrollAct() { var x = items[act]; if (x) x.scrollIntoView({ block: 'nearest' }); }
      function choose(it) {
        if (!it || it.getAttribute('aria-disabled') === 'true') return;
        var changed = sel.selectedIndex !== it._i;
        sel.selectedIndex = it._i;
        closePopover();
        btn.focus();
        if (changed) fire(sel);
      }
      function key(e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); var n = act; do { n++; } while (items[n] && items[n].getAttribute('aria-disabled') === 'true'); setAct(n); scrollAct(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); var p = act; do { p--; } while (items[p] && items[p].getAttribute('aria-disabled') === 'true'); setAct(p); scrollAct(); }
        else if (e.key === 'Home') { e.preventDefault(); setAct(0); scrollAct(); }
        else if (e.key === 'End') { e.preventDefault(); setAct(items.length - 1); scrollAct(); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(items[act]); }
        else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } closePopover(); if (e.key === 'Escape') btn.focus(); }
        else if (e.key.length === 1) {
          var now = Date.now(); typed = (now - typedAt > 700 ? '' : typed) + e.key.toLowerCase(); typedAt = now;
          var hit = items.findIndex(function (x) { return x.textContent.trim().toLowerCase().indexOf(typed) === 0; });
          if (hit >= 0) { setAct(hit); scrollAct(); }
        }
      }
      btn.setAttribute('aria-expanded', 'true');
      openPopover(pop, btn, {
        onClose: function () { btn.setAttribute('aria-expanded', 'false'); btn.removeEventListener('keydown', key, true); },
      });
      btn.addEventListener('keydown', key, true);
      setAct(act); scrollAct();
    }
    btn.addEventListener('click', function () {
      if (openPop && openPop.anchor === btn) { closePopover(); return; }
      open();
    });
    btn.addEventListener('keydown', function (e) {
      if (openPop && openPop.anchor === btn) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  }

  // ── date picker ────────────────────────────────────────────────────────────
  var MONTHS = [];
  try { for (var mi = 0; mi < 12; mi++) MONTHS.push(new Date(2000, mi, 1).toLocaleDateString(undefined, { month: 'short' })); }
  catch (e) { MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function iso(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
  function parseIso(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; }
  function fmt(s) {
    var p = parseIso(s); if (!p) return '';
    try { return new Date(p.y, p.m, p.d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return s; }
  }

  function enhanceDate(inp) {
    if (inp._vc || isNative(inp)) return;
    inp._vc = true;
    var btn = h('button', '');
    btn.type = 'button';
    copyLook(inp, btn, 'vc-date');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    var lbl = h('span', 'vc-lbl'), ic = h('span', 'vc-ic', ICON.cal);
    btn.appendChild(lbl); btn.appendChild(ic);
    inp.classList.add('vc-native');
    inp.setAttribute('tabindex', '-1');
    inp.setAttribute('aria-hidden', 'true');
    inp.parentNode.insertBefore(btn, inp.nextSibling);
    function sync() {
      var v = inp.value;
      lbl.textContent = v ? fmt(v) : (inp.getAttribute('placeholder') || 'Select a date');
      lbl.classList.toggle('vc-ph', !v);
      btn.setAttribute('aria-label', (inp.getAttribute('aria-label') || 'Date') + (v ? ': ' + fmt(v) : ''));
      mirrorState(inp, btn);
    }
    watchProp(inp, HTMLInputElement.prototype, 'value', sync);
    watchProp(inp, HTMLInputElement.prototype, 'valueAsDate', sync);
    inp.addEventListener('change', sync);
    inp.addEventListener('input', sync);
    new MutationObserver(sync).observe(inp, { attributes: true, attributeFilter: ['style', 'hidden', 'disabled', 'value', 'placeholder'] });
    forwardLabel(inp, btn);
    sync();

    function set(v) {
      if (inp.value === v) { closePopover(); btn.focus(); return; }
      inp.value = v; closePopover(); btn.focus(); fire(inp);
    }
    function open() {
      if (btn.disabled) return;
      var now = new Date();
      var today = iso(now.getFullYear(), now.getMonth(), now.getDate());
      var cur = parseIso(inp.value);
      var min = parseIso(inp.min) ? inp.min : '', max = parseIso(inp.max) ? inp.max : '';
      var view = { y: cur ? cur.y : now.getFullYear(), m: cur ? cur.m : now.getMonth(), mode: 'days' };
      var focusDay = cur ? inp.value : today;
      var pop = h('div', 'vc-pop vc-cal');
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', 'Choose a date');
      function inRange(v) { return (!min || v >= min) && (!max || v <= max); }
      function navBtn(icon, label, fn) { var b = h('button', 'vc-cal-nav', icon); b.type = 'button'; b.setAttribute('aria-label', label); b.addEventListener('click', fn); return b; }
      function render() {
        pop.innerHTML = '';
        var head = h('div', 'vc-cal-head');
        var title = h('button', 'vc-cal-title'); title.type = 'button';
        var yStart = view.y - (view.y % 12);
        title.textContent = view.mode === 'days' ? new Date(view.y, view.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
          : view.mode === 'months' ? String(view.y) : yStart + ' – ' + (yStart + 11);
        title.addEventListener('click', function () { view.mode = view.mode === 'days' ? 'months' : 'years'; render(); });
        head.appendChild(title);
        head.appendChild(navBtn(ICON.left, 'Previous', function () { step(-1); }));
        head.appendChild(navBtn(ICON.right, 'Next', function () { step(1); }));
        pop.appendChild(head);
        var grid;
        if (view.mode === 'days') {
          grid = h('div', 'vc-cal-grid');
          grid.setAttribute('role', 'grid');
          var first = new Date(view.y, view.m, 1);
          var startDow = first.getDay();
          for (var d = 0; d < 7; d++) {
            var dw = h('div', 'vc-cal-dow');
            dw.textContent = new Date(2023, 0, 1 + d).toLocaleDateString(undefined, { weekday: 'narrow' });
            grid.appendChild(dw);
          }
          for (var c = 0; c < 42; c++) {
            var dt = new Date(view.y, view.m, 1 - startDow + c);
            var v = iso(dt.getFullYear(), dt.getMonth(), dt.getDate());
            var cell = h('button', 'vc-cal-cell' + (dt.getMonth() !== view.m ? ' out' : '') + (v === today ? ' today' : '') + (v === inp.value ? ' sel' : ''));
            cell.type = 'button'; cell.textContent = dt.getDate(); cell._v = v;
            cell.setAttribute('aria-label', dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
            if (v === inp.value) cell.setAttribute('aria-selected', 'true');
            cell.tabIndex = v === focusDay ? 0 : -1;
            if (!inRange(v)) cell.disabled = true;
            cell.addEventListener('click', (function (val) { return function () { set(val); }; })(v));
            grid.appendChild(cell);
          }
        } else if (view.mode === 'months') {
          grid = h('div', 'vc-cal-grid m');
          MONTHS.forEach(function (name, i) {
            var b = h('button', 'vc-cal-cell' + (cur && cur.y === view.y && cur.m === i ? ' sel' : ''));
            b.type = 'button'; b.textContent = name;
            b.addEventListener('click', function () { view.m = i; view.mode = 'days'; render(); });
            grid.appendChild(b);
          });
        } else {
          grid = h('div', 'vc-cal-grid m');
          for (var yy = yStart; yy < yStart + 12; yy++) {
            var yb = h('button', 'vc-cal-cell' + (cur && cur.y === yy ? ' sel' : '') + (yy === now.getFullYear() ? ' today' : ''));
            yb.type = 'button'; yb.textContent = yy;
            yb.addEventListener('click', (function (y) { return function () { view.y = y; view.mode = 'months'; render(); }; })(yy));
            grid.appendChild(yb);
          }
        }
        pop.appendChild(grid);
        var foot = h('div', 'vc-cal-foot');
        var clr = h('button', 'vc-cal-link'); clr.type = 'button'; clr.textContent = 'Clear';
        clr.addEventListener('click', function () { set(''); });
        var tod = h('button', 'vc-cal-link'); tod.type = 'button'; tod.textContent = 'Today';
        tod.disabled = !inRange(today);
        tod.addEventListener('click', function () { set(today); });
        foot.appendChild(inp.required ? h('span') : clr); foot.appendChild(tod);
        pop.appendChild(foot);
      }
      function step(dir) {
        if (view.mode === 'days') { var d = new Date(view.y, view.m + dir, 1); view.y = d.getFullYear(); view.m = d.getMonth(); }
        else if (view.mode === 'months') view.y += dir;
        else view.y += dir * 12;
        render();
      }
      function focusCell() { var c = pop.querySelector('.vc-cal-cell[tabindex="0"]'); if (c) c.focus(); }
      pop.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); btn.focus(); return; }
        if (view.mode !== 'days') return;
        var moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        if (!(e.key in moves) && e.key !== 'PageUp' && e.key !== 'PageDown') return;
        e.preventDefault();
        var p = parseIso(focusDay) || parseIso(today);
        var d = e.key === 'PageUp' ? new Date(p.y, p.m - 1, p.d) : e.key === 'PageDown' ? new Date(p.y, p.m + 1, p.d) : new Date(p.y, p.m, p.d + moves[e.key]);
        focusDay = iso(d.getFullYear(), d.getMonth(), d.getDate());
        view.y = d.getFullYear(); view.m = d.getMonth();
        render(); focusCell();
      });
      render();
      btn.setAttribute('aria-expanded', 'true');
      openPopover(pop, btn, { minWidth: 296, onClose: function () { btn.setAttribute('aria-expanded', 'false'); } });
      if (!coarse.matches) setTimeout(focusCell, 30);
    }
    btn.addEventListener('click', function () {
      if (openPop && openPop.anchor === btn) { closePopover(); return; }
      open();
    });
    btn.addEventListener('keydown', function (e) {
      if (openPop && openPop.anchor === btn) return;
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      if ((e.key === 'Backspace' || e.key === 'Delete') && inp.value && !inp.required) { e.preventDefault(); inp.value = ''; fire(inp); }
    });
  }

  // ── <input list> → themed suggestions ──────────────────────────────────────
  function enhanceDatalist(inp) {
    if (inp._vcList || isNative(inp)) return;
    var id = inp.getAttribute('list');
    if (!id) return;
    inp._vcList = true;
    inp.removeAttribute('list');           // the native dropdown must never show
    inp.setAttribute('data-vc-list', id);
    inp.setAttribute('role', 'combobox');
    inp.setAttribute('aria-autocomplete', 'list');
    inp.setAttribute('aria-expanded', 'false');
    inp.setAttribute('autocomplete', 'off');
    var act = -1, items = [];
    function values() {
      var dl = doc.getElementById(id);
      return dl ? Array.prototype.map.call(dl.querySelectorAll('option'), function (o) { return o.value || o.textContent; }) : [];
    }
    function show(all) {
      var q = all ? '' : inp.value.trim().toLowerCase();
      var list = values().filter(function (v) { return !q || v.toLowerCase().indexOf(q) >= 0; });
      list.sort(function (a, b) { return (a.toLowerCase().indexOf(q) === 0 ? 0 : 1) - (b.toLowerCase().indexOf(q) === 0 ? 0 : 1); });
      if (!list.length || (list.length === 1 && list[0].toLowerCase() === q)) { if (openPop && openPop.anchor === inp) closePopover(); return; }
      var pop = h('div', 'vc-pop');
      pop.setAttribute('role', 'listbox');
      items = list.slice(0, 50).map(function (v) {
        var it = h('div', 'vc-opt'); it.setAttribute('role', 'option');
        var t = h('span', 'vc-otext'); t.textContent = v; it.appendChild(t);
        // pointerdown, not click: the input must not blur first.
        it.addEventListener('pointerdown', function (e) { e.preventDefault(); pick(v); });
        pop.appendChild(it); return it;
      });
      act = -1;
      if (openPop && openPop.anchor === inp) {
        openPop.pop.innerHTML = ''; items.forEach(function (i) { openPop.pop.appendChild(i); }); openPop.reposition();
      } else {
        inp.setAttribute('aria-expanded', 'true');
        openPopover(pop, inp, { onClose: function () { inp.setAttribute('aria-expanded', 'false'); } });
      }
    }
    function pick(v) { inp.value = v; closePopover(); fire(inp); }
    function setAct(n) { if (!items.length) return; act = (n + items.length) % items.length; items.forEach(function (x, j) { x.classList.toggle('act', j === act); }); items[act].scrollIntoView({ block: 'nearest' }); }
    inp.addEventListener('input', function () { show(false); });
    inp.addEventListener('focus', function () { if (!inp.value) show(true); });
    inp.addEventListener('blur', function () { setTimeout(function () { if (openPop && openPop.anchor === inp && doc.activeElement !== inp) closePopover(); }, 120); });
    inp.addEventListener('keydown', function (e) {
      var isOpen = openPop && openPop.anchor === inp;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!isOpen) show(true); else setAct(act + 1); }
      else if (e.key === 'ArrowUp' && isOpen) { e.preventDefault(); setAct(act - 1); }
      else if (e.key === 'Enter' && isOpen && act >= 0) { e.preventDefault(); pick(items[act].textContent); }
      else if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); closePopover(); }
    });
  }

  // ── range fill ─────────────────────────────────────────────────────────────
  function paintRange(r) {
    var min = +r.min || 0, max = r.max === '' ? 100 : +r.max, v = +r.value;
    r.style.setProperty('--vc-pct', (max > min ? ((v - min) / (max - min)) * 100 : 0) + '%');
  }
  function enhanceRange(r) {
    if (r._vc || isNative(r)) return;
    r._vc = true;
    watchProp(r, HTMLInputElement.prototype, 'value', function () { paintRange(r); });
    r.addEventListener('input', function () { paintRange(r); });
    paintRange(r);
  }

  // ── textarea grip ──────────────────────────────────────────────────────────
  function enhanceTextarea(ta) {
    if (ta._vc || isNative(ta) || !ta.parentNode) return;
    var rs = getComputedStyle(ta).resize;
    if (rs === 'none') return;
    ta._vc = true;
    var wrap = h('span', 'vc-ta');
    var grip = h('span', 'vc-grip', ICON.grip);
    grip.setAttribute('aria-hidden', 'true');
    ta.parentNode.insertBefore(wrap, ta);
    wrap.appendChild(ta); wrap.appendChild(grip);
    ta.classList.add('vc-has-grip');
    var minH = parseFloat(getComputedStyle(ta).minHeight) || 40;
    grip.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      var startY = e.clientY, startH = ta.getBoundingClientRect().height;
      grip.classList.add('drag'); root.classList.add('vc-dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      function move(ev) { ta.style.height = Math.max(minH, startH + ev.clientY - startY) + 'px'; }
      function up() {
        grip.classList.remove('drag'); root.classList.remove('vc-dragging');
        grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      }
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
  }

  // ── overlay scrollbars ─────────────────────────────────────────────────────
  var bars = new Map();            // scroller -> bar
  var HIDE_MS = 1100;
  function scrollerFor(t) {
    if (t === doc || t === doc.documentElement || t === doc.body) return doc.scrollingElement || root;
    return t;
  }
  function canScroll(el, axis) {
    if (!el || el.nodeType !== 1 || el.closest('[data-native-scroll]')) return false;
    var isDoc = el === (doc.scrollingElement || root);
    if (axis === 'v') {
      if (el.scrollHeight - el.clientHeight < 2) return false;
      if (isDoc) return true;
      var oy = getComputedStyle(el).overflowY; return oy === 'auto' || oy === 'scroll';
    }
    if (el.scrollWidth - el.clientWidth < 2) return false;
    if (isDoc) return true;
    // A short horizontally-swiped strip (tab bar, chip row) hid its bar on
    // purpose — a rail along its bottom would sit on top of its buttons.
    if (el.clientHeight < 120) return false;
    var ox = getComputedStyle(el).overflowX; return ox === 'auto' || ox === 'scroll';
  }
  function makeRail(el, axis) {
    var rail = h('div', 'vc-rail ' + axis);
    var thumb = h('div', 'vc-thumb');
    rail.appendChild(thumb);
    rail.setAttribute('aria-hidden', 'true');
    return { rail: rail, thumb: thumb, axis: axis };
  }
  function barFor(el) {
    var b = bars.get(el);
    if (b) return b;
    b = { el: el, v: null, h: null, timer: 0, hover: false, drag: false };
    bars.set(el, b);
    return b;
  }
  function ensureRail(b, axis) {
    if (b[axis]) return b[axis];
    var r = makeRail(b.el, axis);
    b[axis] = r;
    bindDrag(b, r);
    r.rail.addEventListener('pointerenter', function () { b.hover = true; show(b); });
    r.rail.addEventListener('pointerleave', function () { b.hover = false; schedule(b); });
    return r;
  }
  function geometry(b, r) {
    var el = b.el, isDoc = el === (doc.scrollingElement || root);
    var rect = isDoc ? { left: 0, top: 0, right: vw(), bottom: vh(), width: vw(), height: vh() } : el.getBoundingClientRect();
    // Clip to the visible viewport so a box half off-screen doesn't draw its
    // bar over the page chrome.
    var top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, vh());
    var left = Math.max(rect.left, 0), right = Math.min(rect.right, vw());
    var border = isDoc ? { t: 0, r: 0, b: 0, l: 0 } : { t: el.clientTop, l: el.clientLeft, r: rect.width - el.clientWidth - el.clientLeft, b: rect.height - el.clientHeight - el.clientTop };
    return { top: top, bottom: bottom, left: left, right: right, rect: rect, border: border, isDoc: isDoc };
  }
  function layout(b) {
    ['v', 'h'].forEach(function (axis) {
      var r = b[axis]; if (!r) return;
      var el = b.el;
      if (!canScroll(el, axis) || !el.isConnected) { r.rail.style.display = 'none'; return; }
      r.rail.style.display = '';
      if (!r.rail.isConnected) layerOf(el === (doc.scrollingElement || root) ? doc.body : el).appendChild(r.rail);
      // A scroller inside a top layer gets a rail ABOVE that layer's content.
      var host = r.rail.parentNode;
      r.rail.style.zIndex = host === doc.body ? '60' : '2147483000';
      var g = geometry(b, r);
      var o = fixedOrigin(r.rail);
      var inset = 2;
      if (axis === 'v') {
        var H = Math.max(0, g.bottom - g.top - g.border.t - g.border.b - (b.h && canScroll(el, 'h') ? 14 : 0));
        var ratio = el.clientHeight / el.scrollHeight;
        var th = Math.max(coarse.matches ? 44 : 32, H * ratio);
        var maxScroll = el.scrollHeight - el.clientHeight;
        var ty = maxScroll > 0 ? (el.scrollTop / maxScroll) * (H - th - inset * 2) + inset : inset;
        r.rail.style.top = (g.top + g.border.t - o.y) + 'px';
        r.rail.style.height = H + 'px';
        r.rail.style.left = (Math.min(g.right, g.rect.right - g.border.r) - r.rail.offsetWidth - o.x) + 'px';
        r.thumb.style.height = Math.max(0, th - inset * 2) + 'px';
        r.thumb.style.top = ty + 'px';
        r.track = H - th; r.size = th;
      } else {
        var W = Math.max(0, g.right - g.left - g.border.l - g.border.r - (b.v && canScroll(el, 'v') ? 14 : 0));
        var rx = el.clientWidth / el.scrollWidth;
        var tw = Math.max(coarse.matches ? 44 : 32, W * rx);
        var maxX = el.scrollWidth - el.clientWidth;
        var tx = maxX > 0 ? (el.scrollLeft / maxX) * (W - tw - inset * 2) + inset : inset;
        r.rail.style.left = (g.left + g.border.l - o.x) + 'px';
        r.rail.style.width = W + 'px';
        r.rail.style.top = (Math.min(g.bottom, g.rect.bottom - g.border.b) - r.rail.offsetHeight - o.y) + 'px';
        r.thumb.style.width = Math.max(0, tw - inset * 2) + 'px';
        r.thumb.style.left = tx + 'px';
        r.track = W - tw; r.size = tw;
      }
    });
  }
  function show(b, axes) {
    (axes || ['v', 'h']).forEach(function (a) { if (canScroll(b.el, a)) ensureRail(b, a); });
    layout(b);
    ['v', 'h'].forEach(function (a) {
      var r = b[a];
      if (!r || r.rail.style.display === 'none' || r.rail.classList.contains('on')) return;
      // Coming back from display:none — give it one frame so the fade runs.
      void r.rail.offsetWidth;
      r.rail.classList.add('on');
    });
    schedule(b);
  }
  function schedule(b) {
    clearTimeout(b.timer);
    b.timer = setTimeout(function () {
      if (b.hover || b.drag) return schedule(b);
      ['v', 'h'].forEach(function (a) {
        var r = b[a]; if (!r) return;
        r.rail.classList.remove('on');
        // Out of layout entirely once faded, so an idle rail can never pin a
        // size (the Launcher popup sizes itself from its content).
        setTimeout(function () { if (!r.rail.classList.contains('on')) r.rail.style.display = 'none'; }, 400);
      });
      // Detached scroller (modal closed): drop its rails entirely.
      if (!b.el.isConnected) { ['v', 'h'].forEach(function (a) { if (b[a] && b[a].rail.parentNode) b[a].rail.parentNode.removeChild(b[a].rail); }); bars.delete(b.el); }
    }, HIDE_MS);
  }
  function bindDrag(b, r) {
    var vert = r.axis === 'v';
    r.rail.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      var el = b.el;
      var max = vert ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      if (e.target !== r.thumb && !r.thumb.contains(e.target)) {
        // Track click: page toward the pointer.
        var tr = r.thumb.getBoundingClientRect();
        var before = vert ? e.clientY < tr.top : e.clientX < tr.left;
        var page = (vert ? el.clientHeight : el.clientWidth) * 0.9 * (before ? -1 : 1);
        el.scrollBy(vert ? { top: page, behavior: reduced.matches ? 'auto' : 'smooth' } : { left: page, behavior: reduced.matches ? 'auto' : 'smooth' });
        show(b);
        return;
      }
      b.drag = true; r.rail.classList.add('drag'); root.classList.add('vc-dragging');
      var start = vert ? e.clientY : e.clientX;
      var startScroll = vert ? el.scrollTop : el.scrollLeft;
      var perPx = r.track > 0 ? max / r.track : 0;
      try { r.rail.setPointerCapture(e.pointerId); } catch (_) {}
      function move(ev) {
        var d = ((vert ? ev.clientY : ev.clientX) - start) * perPx;
        if (vert) el.scrollTop = startScroll + d; else el.scrollLeft = startScroll + d;
        layout(b);
      }
      function up() {
        b.drag = false; r.rail.classList.remove('drag'); root.classList.remove('vc-dragging');
        r.rail.removeEventListener('pointermove', move); r.rail.removeEventListener('pointerup', up); r.rail.removeEventListener('pointercancel', up);
        schedule(b);
      }
      r.rail.addEventListener('pointermove', move); r.rail.addEventListener('pointerup', up); r.rail.addEventListener('pointercancel', up);
    });
  }
  // Scrolling anywhere shows that box's bar.
  doc.addEventListener('scroll', function (e) {
    var el = scrollerFor(e.target);
    if (!el || el.nodeType !== 1) return;
    if (!canScroll(el, 'v') && !canScroll(el, 'h')) return;
    show(barFor(el));
  }, true);
  // Hovering near a scrollable box's edge shows its bar too, so it can be
  // grabbed before any scrolling happens (mouse / pen only).
  var hoverRaf = 0, lastMove = null;
  doc.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;
    lastMove = e;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(function () {
      hoverRaf = 0;
      var ev = lastMove; if (!ev) return;
      var t = ev.target;
      if (t && t.closest && t.closest('.vc-rail')) return;
      for (var el = t && t.nodeType === 1 ? t : null; el; el = el.parentElement) {
        if (el === doc.body) el = doc.scrollingElement || root;
        var v = canScroll(el, 'v');
        var hz = canScroll(el, 'h');
        if (v || hz) {
          var isDoc = el === (doc.scrollingElement || root);
          var rc = isDoc ? { right: vw(), bottom: vh() } : el.getBoundingClientRect();
          var nearV = v && rc.right - ev.clientX <= 24 && rc.right - ev.clientX >= -2;
          var nearH = hz && rc.bottom - ev.clientY <= 24 && rc.bottom - ev.clientY >= -2;
          if (nearV || nearH) { show(barFor(el), [nearV ? 'v' : null, nearH ? 'h' : null].filter(Boolean)); return; }
        }
        if (el === (doc.scrollingElement || root)) return;
      }
    });
  }, { passive: true });
  window.addEventListener('resize', function () { bars.forEach(function (b) { if (b.v && b.v.rail.classList.contains('on')) layout(b); }); });

  // ── tooltips ───────────────────────────────────────────────────────────────
  var tip = null, tipFor = null, tipTimer = 0;
  function hideTip() {
    clearTimeout(tipTimer); tipFor = null;
    if (tip) { tip.classList.remove('on'); var t = tip; setTimeout(function () { if (!t.classList.contains('on') && t.parentNode) t.parentNode.removeChild(t); }, 150); }
  }
  doc.addEventListener('pointerover', function (e) {
    if (e.pointerType === 'touch') return;
    var el = e.target && e.target.closest && e.target.closest('[title],[data-vtip]');
    if (!el || isNative(el) || el === tipFor) return;
    if (el.hasAttribute('title')) {
      var t = el.getAttribute('title');
      el.removeAttribute('title');
      if (!t) return;
      el.setAttribute('data-vtip', t);
      // Keep the accessible name the title used to provide.
      if (!el.hasAttribute('aria-label') && !(el.textContent || '').trim()) el.setAttribute('aria-label', t);
    }
    var text = el.getAttribute('data-vtip');
    if (!text) return;
    hideTip();
    tipFor = el;
    tipTimer = setTimeout(function () {
      if (tipFor !== el || !el.isConnected) return;
      tip = tip && !tip.classList.contains('on') ? tip : h('div', 'vc-tip');
      tip.textContent = text;
      tip.setAttribute('role', 'tooltip');
      layerOf(el).appendChild(tip);
      var r = el.getBoundingClientRect(), o = fixedOrigin(tip);
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var top = r.top - th - 8; if (top < 6) top = r.bottom + 8;
      var left = Math.min(Math.max(6, r.left + r.width / 2 - tw / 2), vw() - tw - 6);
      tip.style.left = (left - o.x) + 'px'; tip.style.top = (top - o.y) + 'px';
      requestAnimationFrame(function () { if (tip) tip.classList.add('on'); });
    }, 450);
  }, true);
  doc.addEventListener('pointerout', function (e) {
    if (!tipFor) return;
    if (e.relatedTarget && tipFor.contains(e.relatedTarget)) return;
    if (tipFor.contains(e.target)) hideTip();
  }, true);
  ['pointerdown', 'keydown', 'wheel'].forEach(function (ev) { doc.addEventListener(ev, hideTip, true); });
  doc.addEventListener('scroll', hideTip, true);

  // ── enhancement ────────────────────────────────────────────────────────────
  function enhance(scope) {
    scope = scope || doc;
    if (scope.nodeType !== 1 && scope !== doc) return;
    var one = scope.nodeType === 1 ? [scope] : [];
    function each(selector, fn) {
      one.forEach(function (n) { if (n.matches && n.matches(selector)) fn(n); });
      if (scope.querySelectorAll) Array.prototype.forEach.call(scope.querySelectorAll(selector), fn);
    }
    each('select', enhanceSelect);
    each('input[type=date]', enhanceDate);
    each('input[list]', enhanceDatalist);
    each('input[type=range]', enhanceRange);
    each('textarea', enhanceTextarea);
  }
  var pending = [], flushQueued = false;
  function flush() {
    flushQueued = false;
    var list = pending; pending = [];
    list.forEach(function (n) { if (n.isConnected) enhance(n); });
  }
  function start() {
    injectStyles();
    enhance(doc);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1 || n.classList.contains('vc-pop') || n.classList.contains('vc-rail') || n.classList.contains('vc-tip')) continue;
          pending.push(n);
        }
      }
      // Microtask: enhance after the code that built the node has finished
      // setting it up (values, options), but before the next paint.
      if (pending.length && !flushQueued) { flushQueued = true; Promise.resolve().then(flush); }
    }).observe(root, { childList: true, subtree: true });
  }
  if (doc.head) injectStyles();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();

  window.VaultControls = { enhance: enhance, close: closePopover, showScrollbar: function (el) { show(barFor(el)); } };
})();
