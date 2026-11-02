/* ─────────────────────────────────────────────────────────────────────────────
 * controls.js — A1's own form controls. Shared by every program, both sides.
 *
 * Nothing the browser draws natively is left on screen. Vault's themed
 * controls (Vault/vault-controls.js), made to fit every program:
 *
 *   <select>     stays where it is, styled by its page, so React state, inline
 *                onchange="" and every page rule keep working. Only the
 *                browser's popup is stopped (mousedown / touchend / keys) and an
 *                A1 list opens instead: keyboard, type-ahead, touch. A select
 *                that still looked native also gets A1's chevron.
 *   date / time / datetime-local
 *                an A1 button + calendar / clock popover. The real input stays
 *                in the DOM, hidden, as the source of truth: its value setter is
 *                hooked on the prototype, so code (and React) that sets `.value`
 *                repaints the button, and a pick fires real input + change.
 *   <input list> an A1 suggestion menu in place of the datalist dropdown.
 *   checkbox / radio / range
 *                restyled, unless the page already draws its own (appearance
 *                none). A box keeps its page's accent-color (gold stays gold);
 *                otherwise it takes the side's accent.
 *   number spinners, search ✕, autofill colours, <details> markers — gone or
 *                restyled. title="" tooltips become A1 ones (mouse / pen).
 *
 * Popovers take their colours and font from the page around their control, so
 * a light page (Veda's light TaskHub) gets a light list. They open in the
 * browser's top layer, so a modal's overflow never clips them, but stay inside
 * the modal in the DOM, so its outside-click checks still count them as in.
 *
 * Side: Tony's accent is MAGI purple; Veda's side (data-profile or
 * data-th-profile = "veda" on <body> or <html>, or inside #veda-root) is her
 * mauve. A Veda-only page says so on its tag:
 *   <script src="controls.js" data-profile="veda"></script>
 * A page that has its own controls for the rest limits this file to a subtree:
 *   <script src="controls.js" data-scope=".sos-nb-host"></script>
 * A page or box can set --a1c-accent to change the popover accent.
 *
 * Add it with one tag in <head>, BEFORE React or any page code (the value
 * hooks must be in place before React tracks an input). Opt an element or
 * subtree out with `data-native`. Vault keeps vault-controls.js, so this file
 * stands down there.
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.A1Controls || window.VaultControls) return;
  var doc = document;
  var root = doc.documentElement;
  var tag = doc.currentScript;
  var vedaOnly = !!tag && tag.getAttribute('data-profile') === 'veda';
  var scopeSel = (tag && tag.getAttribute('data-scope')) || '';
  var coarse = window.matchMedia ? window.matchMedia('(pointer:coarse)') : { matches: false };
  var reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion:reduce)') : { matches: false };

  function svg(body, w, sw) {
    return '<svg viewBox="0 0 24 24" width="' + w + '" height="' + w + '" fill="none" stroke="currentColor" stroke-width="' + (sw || 2) +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  var ICON = {
    check: svg('<path d="M20 6 9 17l-5-5"/>', 14, 2.4),
    cal: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>', 15, 1.7),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 15, 1.7),
    left: svg('<path d="m15 18-6-6 6-6"/>', 15),
    right: svg('<path d="m9 18 6-6-6-6"/>', 15),
  };
  var CHEV_PATH = 'M6 9l6 6 6-6';

  // ── styles ─────────────────────────────────────────────────────────────────
  var CSS = [
    ':root{--a1c-side-ac:#c0aeea;--a1c-side-on:#1a1a1d}',
    'html.a1c-veda,[data-profile=veda],[data-th-profile=veda],#veda-root{--a1c-side-ac:#8D769A;--a1c-side-on:#fff}',
    // Built-in widgets inside fields.
    'input::-ms-reveal,input::-ms-clear{display:none}',
    'input[type=search]::-webkit-search-cancel-button,input[type=search]::-webkit-search-decoration{-webkit-appearance:none;display:none}',
    'input[type=number]:not([data-native]){-moz-appearance:textfield;appearance:textfield}',
    'input[type=number]:not([data-native])::-webkit-inner-spin-button,input[type=number]:not([data-native])::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}',
    // Browser autofill paints fields pale yellow/blue: keep the page's colours.
    'input:-webkit-autofill,input:-webkit-autofill:hover,input:-webkit-autofill:focus,textarea:-webkit-autofill,select:-webkit-autofill{',
    '  transition:background-color 600000s 0s,color 600000s 0s}',
    // ── checkbox / radio (JS marks them data-a1c; inside an editor, CSS alone) ──
    'input[data-a1c][type=checkbox],input[data-a1c][type=radio],[contenteditable] input[type=checkbox]:not([data-native]){',
    '  -webkit-appearance:none;appearance:none;width:16px;height:16px;flex-shrink:0;display:inline-grid;place-content:center;vertical-align:middle;',
    '  box-sizing:border-box;padding:0;cursor:pointer;border:1.5px solid color-mix(in srgb,currentColor 55%,transparent);border-radius:4px;',
    '  background:color-mix(in srgb,currentColor 9%,transparent);transition:background-color .15s,border-color .15s,box-shadow .15s}',
    'input[data-a1c][type=radio]{border-radius:50%}',
    'input[data-a1c][type=checkbox]::after,[contenteditable] input[type=checkbox]:not([data-native])::after{content:"";width:10px;height:10px;',
    '  background:var(--a1c-on,var(--a1c-side-on));transform:scale(0);transition:transform .14s ease;',
    '  -webkit-mask:var(--a1c-tick) center/contain no-repeat;mask:var(--a1c-tick) center/contain no-repeat}',
    'input[data-a1c][type=radio]::after{content:"";width:6px;height:6px;border-radius:50%;background:var(--a1c-on,var(--a1c-side-on));transform:scale(0);transition:transform .14s ease}',
    'input[data-a1c][type=checkbox]:hover,input[data-a1c][type=radio]:hover{border-color:color-mix(in srgb,currentColor 70%,transparent)}',
    'input[data-a1c][type=checkbox]:checked,input[data-a1c][type=radio]:checked,input[data-a1c][type=checkbox]:indeterminate,',
    '[contenteditable] input[type=checkbox]:not([data-native]):checked{background:var(--a1c-ac,var(--a1c-side-ac));border-color:var(--a1c-ac,var(--a1c-side-ac))}',
    'input[data-a1c]:checked::after,[contenteditable] input[type=checkbox]:not([data-native]):checked::after{transform:scale(1)}',
    'input[data-a1c][type=checkbox]:indeterminate::after{transform:scale(1);height:2px;width:8px;-webkit-mask:none;mask:none;border-radius:1px}',
    'input[data-a1c][type=checkbox]:focus-visible,input[data-a1c][type=radio]:focus-visible{outline:2px solid var(--a1c-ac,var(--a1c-side-ac));outline-offset:2px}',
    'input[data-a1c][type=checkbox]:disabled,input[data-a1c][type=radio]:disabled{opacity:.4;cursor:not-allowed}',
    // ── range ── --a1c-pct is kept current by JS so the filled part tracks.
    'input[data-a1c][type=range]{-webkit-appearance:none;appearance:none;background:transparent;height:22px;cursor:pointer;touch-action:pan-y}',
    'input[data-a1c][type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;',
    '  background:linear-gradient(to right,var(--a1c-ac,var(--a1c-side-ac)) var(--a1c-pct,50%),color-mix(in srgb,currentColor 20%,transparent) var(--a1c-pct,50%))}',
    'input[data-a1c][type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;margin-top:-6px;border:0;',
    '  background:var(--a1c-ac,var(--a1c-side-ac));box-shadow:0 1px 4px rgba(0,0,0,.35);transition:transform .12s}',
    'input[data-a1c][type=range]:active::-webkit-slider-thumb{transform:scale(1.15)}',
    'input[data-a1c][type=range]::-moz-range-track{height:4px;border-radius:2px;background:color-mix(in srgb,currentColor 20%,transparent)}',
    'input[data-a1c][type=range]::-moz-range-progress{height:4px;border-radius:2px;background:var(--a1c-ac,var(--a1c-side-ac))}',
    'input[data-a1c][type=range]::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:var(--a1c-ac,var(--a1c-side-ac))}',
    'input[data-a1c][type=range]:focus-visible{outline:none}',
    'input[data-a1c][type=range]:focus-visible::-webkit-slider-thumb{outline:2px solid var(--a1c-ac,var(--a1c-side-ac));outline-offset:2px}',
    // ── <select> in place ── "sel" looked native: A1's chevron. "own": the
    // page already draws it; only the popup changes.
    'select[data-a1c=sel]{-webkit-appearance:none!important;appearance:none!important;cursor:pointer;padding-right:24px!important;',
    '  background-image:var(--a1c-chev)!important;background-repeat:no-repeat!important;background-position:right 8px center!important;background-size:11px 11px!important}',
    'select[data-a1c=own]{cursor:pointer}',
    'select[data-a1c][aria-expanded=true]{border-color:var(--a1c-ac,var(--a1c-side-ac))!important}',
    // ── colour ── a visible colour input is a plain swatch; its dialog is A1's.
    'input[type=color]:not([data-native]){-webkit-appearance:none;appearance:none;width:28px;height:28px;padding:2px;box-sizing:border-box;cursor:pointer;',
    '  border:1px solid color-mix(in srgb,currentColor 30%,transparent);border-radius:6px;background:transparent}',
    'input[type=color]:not([data-native])::-webkit-color-swatch-wrapper{padding:0}',
    'input[type=color]:not([data-native])::-webkit-color-swatch{border:none;border-radius:4px}',
    'input[type=color]:not([data-native])::-moz-color-swatch{border:none;border-radius:4px}',
    '.a1c-color{width:236px;padding:10px}',
    '.a1c-sv{position:relative;height:150px;border-radius:6px;cursor:crosshair;touch-action:none;',
    '  background:linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,var(--a1c-hue))}',
    '.a1c-hue{position:relative;height:14px;margin-top:10px;border-radius:7px;cursor:pointer;touch-action:none;',
    '  background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)}',
    '.a1c-knob{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.45);pointer-events:none;box-sizing:border-box}',
    '.a1c-hue .a1c-knob{top:50%}',
    '.a1c-crow{display:flex;align-items:center;gap:8px;margin-top:10px}',
    '.a1c-cprev{width:28px;height:28px;border-radius:6px;flex-shrink:0;border:1px solid color-mix(in srgb,var(--p-tx) 20%,transparent)}',
    '.a1c-hex{flex:1;min-width:0;background:transparent;color:inherit;font:inherit;font-variant-numeric:tabular-nums;text-transform:uppercase;',
    '  border:1px solid color-mix(in srgb,var(--p-tx) 20%,transparent);border-radius:6px;padding:6px 8px;outline:none}',
    '.a1c-hex:focus{border-color:var(--p-ac)}',
    '.a1c-sws{display:grid;grid-template-columns:repeat(8,1fr);gap:5px;margin-top:10px}',
    '.a1c-sw{aspect-ratio:1;border-radius:5px;border:1px solid color-mix(in srgb,var(--p-tx) 18%,transparent);cursor:pointer;padding:0}',
    '.a1c-sw:hover{transform:scale(1.1)}',
    // ── <details> ──
    'summary[data-a1c]{list-style:none;cursor:pointer}',
    'summary[data-a1c]::-webkit-details-marker{display:none}',
    'summary[data-a1c]::before{content:"";display:inline-block;width:10px;height:10px;margin-right:7px;vertical-align:middle;background:currentColor;opacity:.7;',
    '  -webkit-mask:var(--a1c-chev-mask) center/contain no-repeat;mask:var(--a1c-chev-mask) center/contain no-repeat;transform:rotate(-90deg);transition:transform .15s}',
    'details[open]>summary[data-a1c]::before{transform:none}',
    // ── hidden source + its button ──
    '.a1c-src{display:none!important}',
    '.a1c-trig{display:inline-flex;align-items:center;gap:8px;text-align:left;cursor:pointer;-webkit-appearance:none;appearance:none;white-space:nowrap;',
    '  overflow:hidden;font-variant-numeric:tabular-nums}',
    '.a1c-trig .a1c-lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}',
    '.a1c-trig .a1c-ic{flex-shrink:0;display:flex;opacity:.65;transition:opacity .15s,color .15s}',
    '.a1c-trig:hover .a1c-ic{opacity:1}',
    '.a1c-trig[aria-expanded=true]{border-color:var(--a1c-ac,var(--a1c-side-ac))!important}',
    '.a1c-trig[aria-expanded=true] .a1c-ic{opacity:1;color:var(--a1c-ac,var(--a1c-side-ac))}',
    '.a1c-trig:disabled{opacity:.5;cursor:not-allowed}',
    '.a1c-ph{opacity:.55}',
    // ── popovers ── --p-bg / --p-tx / --p-ac / --p-on come from the page.
    '.a1c-pop{position:fixed;inset:auto;margin:0;z-index:2147483600;box-sizing:border-box;width:auto;height:auto;',
    '  background:color-mix(in srgb,var(--p-bg) 91%,var(--p-tx));color:var(--p-tx);border:1px solid color-mix(in srgb,var(--p-tx) 15%,transparent);',
    '  border-radius:8px;box-shadow:0 16px 44px rgba(0,0,0,.5);padding:4px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;',
    '  font-size:13px;line-height:1.3;font-weight:500;font-variant-numeric:tabular-nums;text-align:left;',
    '  opacity:0;transform:translateY(-4px);transition:opacity .13s ease,transform .13s ease}',
    '.a1c-pop.light{background:color-mix(in srgb,var(--p-bg) 30%,#fff);box-shadow:0 12px 34px rgba(0,0,0,.16)}',
    '.a1c-pop.up{transform:translateY(4px)}.a1c-pop.on{opacity:1;transform:none}',
    '.a1c-opt{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;min-height:34px;box-sizing:border-box;user-select:none;-webkit-user-select:none}',
    '.a1c-opt .a1c-otext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.a1c-opt .a1c-ocheck{flex-shrink:0;color:var(--p-ac);opacity:0;display:flex}',
    '.a1c-opt.sel{color:var(--p-ac);font-weight:600}.a1c-opt.sel .a1c-ocheck{opacity:1}',
    '.a1c-opt.act{background:color-mix(in srgb,var(--p-ac) 20%,transparent)}',
    '.a1c-opt.sel.act{background:color-mix(in srgb,var(--p-ac) 26%,transparent)}',
    '.a1c-opt[aria-disabled=true]{opacity:.38;cursor:not-allowed}',
    '.a1c-grp{font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;opacity:.55;padding:9px 10px 4px}',
    '.a1c-empty{padding:10px;opacity:.6}',
    '@media (pointer:coarse){.a1c-opt{min-height:44px}}',
    // calendar
    '.a1c-cal{width:292px;padding:10px}',
    '.a1c-cal-head{display:flex;align-items:center;gap:4px;margin-bottom:6px}',
    '.a1c-pop .a1c-btn{background:transparent!important;border:1px solid transparent!important;color:inherit!important;font:inherit!important;cursor:pointer;',
    '  border-radius:6px!important;margin:0!important;padding:0;min-width:0!important;min-height:0!important;box-shadow:none!important;filter:none!important;',
    '  transform:none!important;translate:none!important;text-transform:none!important;letter-spacing:normal!important;outline:none!important;line-height:1.2!important}',
    '.a1c-pop .a1c-cal-title{flex:1;font-weight:700;font-size:14px;padding:6px 8px;text-align:left}',
    '.a1c-pop .a1c-cal-title:hover{border-color:color-mix(in srgb,var(--p-tx) 22%,transparent)!important}',
    '.a1c-pop .a1c-cal-nav{width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border-color:color-mix(in srgb,var(--p-tx) 14%,transparent)!important;opacity:.8}',
    '.a1c-pop .a1c-cal-nav:hover{color:var(--p-ac)!important;border-color:var(--p-ac)!important;opacity:1}',
    '.a1c-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}',
    '.a1c-cal-grid.m{grid-template-columns:repeat(3,1fr);gap:6px}',
    '.a1c-cal-dow{font-size:10.5px;font-weight:700;opacity:.5;text-align:center;padding:4px 0;letter-spacing:.4px}',
    '.a1c-pop .a1c-cell{height:35px;font-size:13px;font-variant-numeric:tabular-nums}',
    '.a1c-pop .a1c-cal-grid.m .a1c-cell{height:44px}',
    '.a1c-pop .a1c-cell:hover{background:color-mix(in srgb,var(--p-ac) 20%,transparent)!important}',
    '.a1c-pop .a1c-cell.out{opacity:.4}',
    '.a1c-pop .a1c-cell.today{border-color:color-mix(in srgb,var(--p-tx) 30%,transparent)!important}',
    '.a1c-pop .a1c-cell.sel,.a1c-pop .a1c-cell.sel:hover{background:var(--p-ac)!important;color:var(--p-on)!important;font-weight:700!important;opacity:1}',
    '.a1c-pop .a1c-cell:disabled{opacity:.22;cursor:not-allowed;background:transparent!important}',
    '.a1c-pop .a1c-btn:focus-visible{outline:2px solid var(--p-ac)!important;outline-offset:-2px}',
    '.a1c-foot{display:flex;justify-content:space-between;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid color-mix(in srgb,var(--p-tx) 12%,transparent)}',
    '.a1c-pop .a1c-link{color:var(--p-ac)!important;font-size:12px!important;font-weight:700!important;padding:6px 10px}',
    '.a1c-pop .a1c-link:hover{background:color-mix(in srgb,var(--p-ac) 18%,transparent)!important}',
    '.a1c-link:disabled{opacity:.35;cursor:not-allowed}',
    '@media (pointer:coarse){.a1c-pop .a1c-cell{height:40px}}',
    // clock
    '.a1c-clock{width:256px;padding:10px}',
    '.a1c-cal .a1c-clock-in{margin-top:8px;padding-top:8px;border-top:1px solid color-mix(in srgb,var(--p-tx) 12%,transparent)}',
    '.a1c-now{font-size:20px;font-weight:700;text-align:center;padding:2px 0 6px;font-variant-numeric:tabular-nums}',
    '.a1c-now.empty{opacity:.4}',
    '.a1c-tlbl{font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;opacity:.55;margin:6px 2px 4px}',
    '.a1c-tgrid{display:grid;grid-template-columns:repeat(6,1fr);gap:3px}',
    '.a1c-tgrid.ap{grid-template-columns:1fr 1fr;margin-top:8px}',
    '.a1c-pop .a1c-tgrid .a1c-cell{height:32px}',
    '@media (pointer:coarse){.a1c-pop .a1c-tgrid .a1c-cell{height:38px}}',
    // tooltip
    '.a1c-tip{position:fixed;inset:auto;margin:0;z-index:2147483646;pointer-events:none;box-sizing:border-box;',
    '  background:color-mix(in srgb,var(--p-bg) 84%,var(--p-tx));color:var(--p-tx);border:1px solid color-mix(in srgb,var(--p-tx) 16%,transparent);',
    '  font-size:11.5px;font-weight:500;line-height:1.35;padding:5px 9px;border-radius:6px;white-space:normal;',
    '  box-shadow:0 8px 22px rgba(0,0,0,.42);max-width:280px;opacity:0;transform:translateY(3px);transition:opacity .12s,transform .12s}',
    '.a1c-tip.light{background:color-mix(in srgb,var(--p-bg) 20%,#fff);box-shadow:0 6px 18px rgba(0,0,0,.14)}',
    '.a1c-tip.on{opacity:1;transform:none}',
    '@media (prefers-reduced-motion:reduce){.a1c-pop,.a1c-tip,.a1c-trig .a1c-ic,summary[data-a1c]::before{transition:none!important}}',
  ].join('\n');

  function chevUri(color, rot) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + color +
      '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="' + CHEV_PATH + '"/></svg>';
    return 'url("data:image/svg+xml,' + encodeURIComponent(s) + '")';
  }
  function injectStyles() {
    if (doc.getElementById('a1c-styles')) return;
    var s = doc.createElement('style'); s.id = 'a1c-styles'; s.textContent = CSS;
    (doc.head || root).appendChild(s);
    root.style.setProperty('--a1c-chev-mask', chevUri('#000'));
    root.style.setProperty('--a1c-tick', 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>') + '")');
    if (vedaOnly) root.classList.add('a1c-veda');
  }

  function h(tag, cls, html) { var e = doc.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function skip(el) {
    if (!el || !el.closest) return true;
    if (el.closest('[data-native],.a1c-pop')) return true;
    return !!scopeSel && !el.closest(scopeSel);
  }
  function editable(el) { return !!(el.closest && el.closest('[contenteditable]:not([contenteditable=false])')); }

  // ── the value hooks ────────────────────────────────────────────────────────
  // Installed on the prototypes right away, before React mounts anything:
  // React's value tracker wraps whatever setter the prototype has when it
  // tracks an input, so ours sits underneath it and sees React's writes too.
  // A pick writes through the ORIGINAL setter, past React's tracker, so React
  // sees the change and calls onChange.
  function hook(proto, prop) {
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.configurable) return d;
    try {
      Object.defineProperty(proto, prop, {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) { d.set.call(this, v); if (this._a1cSync) this._a1cSync(); },
      });
    } catch (e) {}
    return d;
  }
  var inputValue = hook(HTMLInputElement.prototype, 'value');
  hook(HTMLInputElement.prototype, 'valueAsDate');
  hook(HTMLInputElement.prototype, 'valueAsNumber');
  function setRaw(el, v) { if (inputValue && inputValue.set) inputValue.set.call(el, v); else el.value = v; if (el._a1cSync) el._a1cSync(); }
  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── colours from the page ──────────────────────────────────────────────────
  function rgb(s) {
    var m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lum(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }
  function css(c) { return 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')'; }
  function groundOf(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      var c = rgb(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 26, g: 26, b: 29, a: 1 };
  }
  function isVeda(el) {
    if (vedaOnly) return true;
    if ([doc.body, root].some(function (e) { return e && (e.getAttribute('data-profile') === 'veda' || e.getAttribute('data-th-profile') === 'veda'); })) return true;
    return !!(el && el.closest && el.closest('#veda-root,[data-th-profile=veda]'));
  }
  // Everything a popover needs to look like it belongs where it opened.
  function palette(el) {
    var g = groundOf(el), dark = lum(g) < 0.5, cs = getComputedStyle(el);
    var tx = rgb(cs.color);
    if (!tx || Math.abs(lum(tx) - lum(g)) < 0.35) tx = dark ? { r: 244, g: 243, b: 240 } : { r: 34, g: 32, b: 38 };
    var custom = (cs.getPropertyValue('--a1c-accent') || '').trim();
    var ac = custom || (isVeda(el) ? (dark ? '#A892B0' : '#8D769A') : (dark ? '#c0aeea' : '#7a64b0'));
    var acRgb = rgb(ac) || hexRgb(ac);
    return { bg: css(g), tx: css(tx), ac: ac, on: acRgb && lum(acRgb) > 0.55 ? '#1a1a1d' : '#fff', dark: dark, font: cs.fontFamily };
  }
  function hexRgb(s) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s || '');
    if (!m) return null;
    var x = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16) };
  }
  function paint(node, p) {
    node.style.setProperty('--p-bg', p.bg);
    node.style.setProperty('--p-tx', p.tx);
    node.style.setProperty('--p-ac', p.ac);
    node.style.setProperty('--p-on', p.on);
    if (p.font) node.style.fontFamily = p.font;
    node.classList.toggle('light', !p.dark);
  }

  // ── layering ───────────────────────────────────────────────────────────────
  // In the DOM a popover lives in its control's nearest fixed layer (a modal),
  // so that modal's own outside-click test still counts a pick as inside. On
  // screen it is in the top layer (popover API) when the browser has one, so
  // no overflow or stacking context can cut it off.
  var TOP = typeof HTMLElement.prototype.showPopover === 'function';
  function layerOf(el) {
    for (var e = el && el.parentElement; e && e !== doc.body; e = e.parentElement) {
      if (getComputedStyle(e).position === 'fixed') return e;
    }
    return doc.body;
  }
  function mount(node, anchor) {
    if (TOP) node.setAttribute('popover', 'manual');
    layerOf(anchor).appendChild(node);
    if (TOP) try { node.showPopover(); } catch (e) {}
  }
  function unmount(node) {
    if (TOP) try { node.hidePopover(); } catch (e) {}
    if (node.parentNode) node.parentNode.removeChild(node);
  }
  // A fixed child is placed against the viewport unless an ancestor has a
  // transform or filter. The top layer never has one; otherwise measure.
  function fixedOrigin(node) {
    if (TOP) return { x: 0, y: 0 };
    var prev = node.style.cssText;
    node.style.left = '0px'; node.style.top = '0px';
    var r = node.getBoundingClientRect();
    node.style.cssText = prev;
    return { x: r.left, y: r.top };
  }
  function vw() { return root.clientWidth || window.innerWidth; }
  function vh() { return window.innerHeight || root.clientHeight; }
  function place(pop, anchor, minWidth) {
    var r = anchor.getBoundingClientRect();
    var o = fixedOrigin(pop);
    var W = vw(), H = vh(), gap = 6, pad = 8;
    var width = Math.min(Math.max(r.width, minWidth || 0), W - pad * 2);
    pop.style.minWidth = width + 'px';
    pop.style.maxWidth = (W - pad * 2) + 'px';
    var below = H - r.bottom - gap - pad, above = r.top - gap - pad;
    var natural = Math.min(pop.scrollHeight + 2, 360);
    var up = below < Math.min(natural, 230) && above > below;
    var maxH = Math.max(120, Math.min(360, up ? above : below));
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
    paint(pop, palette(anchor));
    // A popover lives inside the modal it opened from (see mount), so its
    // clicks would bubble on to the modal, and a tap that rebuilds or closes
    // the popover leaves a detached target that the modal's outside-click test
    // reads as "outside": the whole Add-task window closed on Clear or a day
    // (Tony, 2026-11-02). Its pointer and click events stop at the popover.
    // controls.js's own listeners are capture-phase on the document and still
    // see them first.
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'contextmenu'].forEach(function (t) {
      pop.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    pop.setAttribute('data-no-hoverfx', '');
    mount(pop, anchor);
    place(pop, anchor, opts.minWidth);
    requestAnimationFrame(function () { pop.classList.add('on'); });
    var state = {
      pop: pop, anchor: anchor, onClose: opts.onClose, onKey: opts.onKey,
      reposition: function () { if (pop.isConnected) place(pop, anchor, opts.minWidth); },
      outside: function (e) {
        if (pop.contains(e.target) || anchor.contains(e.target)) return;
        closePopover();
      },
      scroll: function (e) {
        if (pop.contains(e.target)) return;
        if (!anchor.isConnected || !anchor.getClientRects().length) { closePopover(); return; }
        state.reposition();
      },
    };
    doc.addEventListener('pointerdown', state.outside, true);
    doc.addEventListener('scroll', state.scroll, true);
    window.addEventListener('resize', state.reposition);
    anchor.setAttribute('aria-expanded', 'true');
    openPop = state;
    return state;
  }
  function closePopover() {
    var s = openPop; if (!s) return;
    openPop = null;
    doc.removeEventListener('pointerdown', s.outside, true);
    doc.removeEventListener('scroll', s.scroll, true);
    window.removeEventListener('resize', s.reposition);
    s.anchor.setAttribute('aria-expanded', 'false');
    s.pop.classList.remove('on');
    var p = s.pop;
    setTimeout(function () { unmount(p); }, reduced.matches ? 0 : 130);
    if (s.onClose) try { s.onClose(); } catch (e) {}
  }
  function isOpenFor(el) { return !!openPop && openPop.anchor === el; }
  // Keys go to the open popover first, before the page sees them, so Escape
  // closes the list and not the modal it sits in.
  window.addEventListener('keydown', function (e) {
    if (!openPop) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      var a = openPop.anchor; closePopover();
      try { a.focus({ preventScroll: true }); } catch (x) {}
      return;
    }
    if (openPop.onKey && (doc.activeElement === openPop.anchor || openPop.pop.contains(doc.activeElement))) openPop.onKey(e);
  }, true);

  // ── option lists (select + datalist) ───────────────────────────────────────
  // items: [{ text, disabled, selected, group, value }]
  function listbox(items, onPick) {
    var pop = h('div', 'a1c-pop');
    pop.setAttribute('role', 'listbox');
    var rows = [], lastGroup = null;
    items.forEach(function (it, i) {
      if (it.group !== undefined && it.group !== lastGroup && it.group !== null) pop.appendChild(h('div', 'a1c-grp')).textContent = it.group;
      lastGroup = it.group;
      var row = h('div', 'a1c-opt' + (it.selected ? ' sel' : ''));
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', it.selected ? 'true' : 'false');
      if (it.disabled) row.setAttribute('aria-disabled', 'true');
      var t = h('span', 'a1c-otext'); t.textContent = it.text;
      row.appendChild(t); row.appendChild(h('span', 'a1c-ocheck', ICON.check));
      row._i = i;
      // pointerdown + preventDefault: the control keeps focus (a datalist
      // input must not blur); the pick lands on click, so a scroll-drag on a
      // phone never picks.
      row.addEventListener('pointerdown', function (e) { e.preventDefault(); });
      row.addEventListener('click', function () { if (!it.disabled) onPick(i); });
      row.addEventListener('pointermove', function () { lb.setAct(rows.indexOf(row)); });
      pop.appendChild(row); rows.push(row);
    });
    if (!rows.length) pop.appendChild(h('div', 'a1c-empty')).textContent = 'No options';
    var typed = '', typedAt = 0;
    var lb = {
      pop: pop, rows: rows, act: -1,
      setAct: function (n) {
        if (n < 0 || n >= rows.length) return;
        rows.forEach(function (x, j) { x.classList.toggle('act', j === n); });
        lb.act = n;
      },
      // By hand, not scrollIntoView, which could scroll the page behind.
      scrollAct: function () {
        var x = rows[lb.act]; if (!x) return;
        if (x.offsetTop < pop.scrollTop) pop.scrollTop = x.offsetTop - 4;
        else if (x.offsetTop + x.offsetHeight > pop.scrollTop + pop.clientHeight) pop.scrollTop = x.offsetTop + x.offsetHeight - pop.clientHeight + 4;
      },
      move: function (dir) {
        var n = lb.act;
        do { n += dir; } while (rows[n] && rows[n].getAttribute('aria-disabled') === 'true');
        if (rows[n]) { lb.setAct(n); lb.scrollAct(); }
      },
      // Shared keys; returns true when handled.
      key: function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); lb.move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); lb.move(-1); }
        else if (e.key === 'Home') { e.preventDefault(); lb.act = -1; lb.move(1); }
        else if (e.key === 'End') { e.preventDefault(); lb.act = rows.length; lb.move(-1); }
        else if (e.key === 'Enter' || e.key === ' ') { if (lb.act < 0) return false; e.preventDefault(); onPick(rows[lb.act]._i); }
        else if (e.key === 'Tab') closePopover();
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          var now = Date.now(); typed = (now - typedAt > 700 ? '' : typed) + e.key.toLowerCase(); typedAt = now;
          var hit = rows.findIndex(function (x) { return x.textContent.trim().toLowerCase().indexOf(typed) === 0; });
          if (hit >= 0) { e.preventDefault(); lb.setAct(hit); lb.scrollAct(); }
        } else return false;
        return true;
      },
    };
    return lb;
  }

  // ── <select>, in place ─────────────────────────────────────────────────────
  function enhanceSelect(sel) {
    if (sel._a1c || sel.multiple || (sel.size && sel.size > 1) || skip(sel)) return;
    sel._a1c = true;
    var own = getComputedStyle(sel).appearance === 'none';
    sel.setAttribute('data-a1c', own ? 'own' : 'sel');
    sel.setAttribute('aria-haspopup', 'listbox');
    sel.setAttribute('aria-expanded', 'false');
    if (!own) {
      var tint = function () {
        var c = rgb(getComputedStyle(sel).color);
        sel.style.setProperty('--a1c-chev', chevUri(c ? 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',.7)' : '#8d8d94'));
      };
      tint();
      new MutationObserver(tint).observe(sel, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  }
  function openSelect(sel) {
    if (sel.disabled) return;
    var opts = Array.prototype.slice.call(sel.options);
    var shown = [], items = [];
    opts.forEach(function (o, i) {
      if (o.hidden) return;
      var g = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement : null;
      shown.push(i);
      items.push({ text: o.textContent, disabled: o.disabled || !!(g && g.disabled), selected: i === sel.selectedIndex, group: g ? g.label : null });
    });
    var lb = listbox(items, function (k) {
      var i = shown[k], changed = sel.selectedIndex !== i;
      closePopover();
      try { sel.focus({ preventScroll: true }); } catch (e) {}
      if (!changed) return;
      sel.selectedIndex = i;
      fire(sel);
    });
    openPopover(lb.pop, sel, {
      onKey: function (e) { lb.key(e); },
    });
    lb.setAct(Math.max(0, shown.indexOf(sel.selectedIndex)));
    lb.scrollAct();
  }
  function selectFrom(t) {
    var s = t && t.closest ? t.closest('select[data-a1c]') : null;
    return s && s._a1c ? s : null;
  }
  // Mouse: the popup opens on mousedown, so that is where it is stopped.
  doc.addEventListener('mousedown', function (e) {
    var sel = selectFrom(e.target);
    if (!sel || e.button !== 0) return;
    e.preventDefault();
    if (isOpenFor(sel)) { closePopover(); return; }
    try { sel.focus({ preventScroll: true }); } catch (x) {}
    openSelect(sel);
  }, true);
  // Touch: a tap's touchend, prevented, never becomes a mousedown, focus or
  // click, so neither Android's nor iOS's picker opens. A finger that moved
  // was scrolling, and is left alone.
  var touch = null;
  doc.addEventListener('touchstart', function (e) {
    var sel = selectFrom(e.target);
    touch = sel && e.touches.length === 1 ? { sel: sel, x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { capture: true, passive: true });
  doc.addEventListener('touchend', function (e) {
    var t = touch; touch = null;
    if (!t || selectFrom(e.target) !== t.sel) return;
    var c = e.changedTouches[0];
    if (!c || Math.abs(c.clientX - t.x) > 10 || Math.abs(c.clientY - t.y) > 10) return;
    e.preventDefault();
    if (isOpenFor(t.sel)) { closePopover(); return; }
    openSelect(t.sel);
  }, { capture: true, passive: false });
  // Keys that would open the browser's popup open ours.
  doc.addEventListener('keydown', function (e) {
    var sel = selectFrom(e.target);
    if (!sel || isOpenFor(sel)) return;
    var k = e.key;
    if (k === ' ' || k === 'Enter' || k === 'F4' || k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      openSelect(sel);
    }
  }, true);

  // ── date / time / datetime-local ───────────────────────────────────────────
  var MONTHS = [];
  try { for (var mi = 0; mi < 12; mi++) MONTHS.push(new Date(2000, mi, 1).toLocaleDateString(undefined, { month: 'short' })); }
  catch (e) { MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function iso(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
  function parseIso(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null; }
  function parseHM(s) { var m = /(?:^|T)(\d{2}):(\d{2})/.exec(s || ''); return m ? { h: +m[1], m: +m[2] } : null; }
  function fmtDate(s) {
    var p = parseIso(s); if (!p) return '';
    try { return new Date(p.y, p.m, p.d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return s; }
  }
  function fmtTime(s) {
    var t = parseHM(s); if (!t) return '';
    return (t.h % 12 || 12) + ':' + pad2(t.m) + ' ' + (t.h >= 12 ? 'PM' : 'AM');
  }
  function fmtValue(type, v) {
    if (type === 'time') return fmtTime(v);
    if (type === 'datetime-local') return v ? fmtDate(v) + ', ' + fmtTime(v) : '';
    return fmtDate(v);
  }
  function todayIso() { var n = new Date(); return iso(n.getFullYear(), n.getMonth(), n.getDate()); }

  // The button wears the input's look: its classes and inline style, then any
  // computed property a rule aimed at `input` gave the input but not a button.
  var LOOK = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'color', 'backgroundColor',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopStyle', 'borderRightStyle',
    'borderBottomStyle', 'borderLeftStyle', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'boxSizing', 'width', 'minWidth', 'maxWidth',
    'height', 'minHeight', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'boxShadow'];
  function copyLook(src, btn) {
    btn.className = String(src.className || '').replace(/\ba1c-src\b/g, '').trim() + ' a1c-trig';
    btn.style.cssText = src.style.cssText.replace(/(^|;)\s*display\s*:[^;]+/i, '$1');
    var s = getComputedStyle(src), b = getComputedStyle(btn);   // src is display:none, so it reports what its rules say
    LOOK.forEach(function (p) {
      var v = s[p];
      if (v && v !== b[p] && !(p === 'width' && v === 'auto') && !(p === 'height' && v === 'auto')) btn.style[p] = v;
    });
    btn._disp = s.display === 'block' || s.display === 'flex' || s.display === 'grid' ? 'flex' : '';
    ['aria-label', 'aria-describedby', 'title'].forEach(function (a) { if (src.hasAttribute(a)) btn.setAttribute(a, src.getAttribute(a)); });
  }
  function enhancePicker(inp) {
    if (inp._a1c || skip(inp)) return;
    var type = inp.type;
    inp._a1c = true;
    var btn = h('button', '');
    btn.type = 'button';
    var lbl = h('span', 'a1c-lbl'), ic = h('span', 'a1c-ic', type === 'time' ? ICON.clock : ICON.cal);
    btn.appendChild(lbl); btn.appendChild(ic);
    inp.classList.add('a1c-src');
    inp.parentNode.insertBefore(btn, inp.nextSibling);
    inp._a1cBtn = btn;
    var looking = false;
    function look() {
      if (looking) return;
      looking = true;
      // React rewrites className whole when the prop changes: hide it again.
      if (!inp.classList.contains('a1c-src')) inp.classList.add('a1c-src');
      var keep = btn.getAttribute('aria-expanded');
      copyLook(inp, btn);
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.setAttribute('aria-expanded', keep || 'false');
      looking = false;
      sync();
    }
    function sync() {
      var v = inp.value;
      lbl.textContent = v ? fmtValue(type, v) : (inp.getAttribute('placeholder') || (type === 'time' ? 'Pick a time' : 'Pick a date'));
      lbl.classList.toggle('a1c-ph', !v);
      btn.setAttribute('aria-label', (inp.getAttribute('aria-label') || (type === 'time' ? 'Time' : 'Date')) + (v ? ': ' + lbl.textContent : ''));
      btn.style.display = inp.hidden || inp.style.display === 'none' ? 'none' : (btn._disp || '');
      btn.disabled = !!inp.disabled;
    }
    inp._a1cSync = sync;
    inp.addEventListener('change', sync);
    inp.addEventListener('input', sync);
    new MutationObserver(function (m) {
      if (m.some(function (x) { return x.attributeName === 'style' || x.attributeName === 'class'; })) look(); else sync();
    }).observe(inp, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'disabled', 'value', 'placeholder', 'min', 'max'] });
    // A label for the hidden input opens its button.
    inp.addEventListener('focus', function () { btn.focus(); });
    look();
    btn.addEventListener('click', function () {
      if (isOpenFor(btn)) { closePopover(); return; }
      if (btn.disabled) return;
      if (type === 'time') openClock(inp, btn); else openCalendar(inp, btn, type === 'datetime-local');
    });
    btn.addEventListener('keydown', function (e) {
      if (isOpenFor(btn)) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); btn.click(); }
      if ((e.key === 'Backspace' || e.key === 'Delete') && inp.value && !inp.required) { e.preventDefault(); setRaw(inp, ''); fire(inp); }
    });
  }
  doc.addEventListener('click', function (e) {
    var l = e.target && e.target.closest && e.target.closest('label');
    if (!l) return;
    var src = l.htmlFor ? doc.getElementById(l.htmlFor) : l.querySelector('input.a1c-src');
    if (src && src._a1cBtn && src._a1cBtn.isConnected && e.target !== src._a1cBtn && !src._a1cBtn.contains(e.target)) {
      e.preventDefault(); src._a1cBtn.focus(); src._a1cBtn.click();
    }
  });

  function set(inp, btn, v, close) {
    var changed = inp.value !== v;
    setRaw(inp, v);
    if (close) { closePopover(); try { btn.focus({ preventScroll: true }); } catch (e) {} }
    if (changed) fire(inp);
  }

  // The time picked so far, then hour and minute grids and AM / PM. All of it
  // shows at once: nothing scrolls, so nothing moves under the pointer. Every
  // tap commits. With no time yet, the first tap fills the rest from now
  // (minute :00, this half of the day).
  function clockPanel(get, put) {
    var wrap = h('div', 'a1c-clock-in');
    function draw() {
      var cur = get(), has = !!cur, now = new Date();
      var t = cur || { h: now.getHours(), m: 0 };
      var pm = t.h >= 12, h12 = t.h % 12 || 12;
      wrap.innerHTML = '';
      var big = h('div', 'a1c-now' + (has ? '' : ' empty'));
      big.textContent = has ? fmtTime(pad2(t.h) + ':' + pad2(t.m)) : '–:–';
      wrap.appendChild(big);
      function grid(label, cls, list, isOn, pick) {
        if (label) wrap.appendChild(h('div', 'a1c-tlbl')).textContent = label;
        var g = h('div', 'a1c-tgrid ' + cls);
        g.setAttribute('role', 'group');
        if (label) g.setAttribute('aria-label', label);
        list.forEach(function (it) {
          var on = has && isOn(it);
          var b = h('button', 'a1c-btn a1c-cell' + (on ? ' sel' : ''));
          b.type = 'button'; b.textContent = it.label;
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          b.addEventListener('click', function () { pick(it); draw(); });
          g.appendChild(b);
        });
        wrap.appendChild(g);
      }
      var hours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(function (x) { return { label: String(x), v: x }; });
      var mins = [];
      for (var i = 0; i < 60; i += 5) mins.push({ label: ':' + pad2(i), v: i });
      grid('Hour', 'h', hours, function (it) { return it.v === h12; }, function (it) { put({ h: (it.v % 12) + (pm ? 12 : 0), m: t.m }); });
      grid('Minute', 'm', mins, function (it) { return it.v === t.m; }, function (it) { put({ h: t.h, m: it.v }); });
      grid('', 'ap', [{ label: 'AM', v: false }, { label: 'PM', v: true }], function (it) { return it.v === pm; },
        function (it) { put({ h: (t.h % 12) + (it.v ? 12 : 0), m: t.m }); });
    }
    draw();
    return wrap;
  }
  function openClock(inp, btn) {
    var pop = h('div', 'a1c-pop a1c-clock');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose a time');
    pop.appendChild(clockPanel(function () { return parseHM(inp.value); },
      function (t) { set(inp, btn, pad2(t.h) + ':' + pad2(t.m), false); }));
    var foot = h('div', 'a1c-foot');
    var clr = h('button', 'a1c-btn a1c-link'); clr.type = 'button'; clr.textContent = 'Clear';
    clr.addEventListener('click', function () { set(inp, btn, '', true); });
    var done = h('button', 'a1c-btn a1c-link'); done.type = 'button'; done.textContent = 'Done';
    done.addEventListener('click', function () { closePopover(); btn.focus(); });
    foot.appendChild(inp.required ? h('span') : clr); foot.appendChild(done);
    pop.appendChild(foot);
    openPopover(pop, btn, { minWidth: 256 });
  }

  function openCalendar(inp, btn, withTime) {
    var now = new Date(), today = todayIso();
    var cur = parseIso(inp.value);
    var min = parseIso(inp.min) ? inp.min.slice(0, 10) : '', max = parseIso(inp.max) ? inp.max.slice(0, 10) : '';
    var view = { y: cur ? cur.y : now.getFullYear(), m: cur ? cur.m : now.getMonth(), mode: 'days' };
    var focusDay = cur ? inp.value.slice(0, 10) : today;
    var pop = h('div', 'a1c-pop a1c-cal');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', withTime ? 'Choose a date and time' : 'Choose a date');
    function dayOf() { return (inp.value || '').slice(0, 10); }
    function timeOf() { var t = parseHM(inp.value); return t ? pad2(t.h) + ':' + pad2(t.m) : '09:00'; }
    function pickDay(v) {
      if (withTime) { set(inp, btn, v + 'T' + timeOf(), false); focusDay = v; render(); }
      else set(inp, btn, v, true);
    }
    function inRange(v) { return (!min || v >= min) && (!max || v <= max); }
    function navBtn(icon, label, fn) { var b = h('button', 'a1c-btn a1c-cal-nav', icon); b.type = 'button'; b.setAttribute('aria-label', label); b.addEventListener('click', fn); return b; }
    function render() {
      var sel = dayOf();
      pop.innerHTML = '';
      var head = h('div', 'a1c-cal-head');
      var title = h('button', 'a1c-btn a1c-cal-title'); title.type = 'button';
      var yStart = view.y - (view.y % 12);
      title.textContent = view.mode === 'days' ? new Date(view.y, view.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
        : view.mode === 'months' ? String(view.y) : yStart + ' – ' + (yStart + 11);
      title.addEventListener('click', function () { view.mode = view.mode === 'days' ? 'months' : view.mode === 'months' ? 'years' : 'days'; render(); });
      head.appendChild(title);
      head.appendChild(navBtn(ICON.left, 'Previous', function () { step(-1); }));
      head.appendChild(navBtn(ICON.right, 'Next', function () { step(1); }));
      pop.appendChild(head);
      var grid;
      if (view.mode === 'days') {
        grid = h('div', 'a1c-cal-grid');
        grid.setAttribute('role', 'grid');
        var startDow = new Date(view.y, view.m, 1).getDay();
        for (var d = 0; d < 7; d++) {
          grid.appendChild(h('div', 'a1c-cal-dow')).textContent = new Date(2023, 0, 1 + d).toLocaleDateString(undefined, { weekday: 'narrow' });
        }
        for (var c = 0; c < 42; c++) {
          var dt = new Date(view.y, view.m, 1 - startDow + c);
          var v = iso(dt.getFullYear(), dt.getMonth(), dt.getDate());
          var cell = h('button', 'a1c-btn a1c-cell' + (dt.getMonth() !== view.m ? ' out' : '') + (v === today ? ' today' : '') + (v === sel ? ' sel' : ''));
          cell.type = 'button'; cell.textContent = dt.getDate();
          cell.setAttribute('aria-label', dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
          if (v === sel) cell.setAttribute('aria-selected', 'true');
          cell.tabIndex = v === focusDay ? 0 : -1;
          if (!inRange(v)) cell.disabled = true;
          cell.addEventListener('click', (function (val) { return function () { pickDay(val); }; })(v));
          grid.appendChild(cell);
        }
      } else if (view.mode === 'months') {
        grid = h('div', 'a1c-cal-grid m');
        var cp = parseIso(sel);
        MONTHS.forEach(function (name, i) {
          var b = h('button', 'a1c-btn a1c-cell' + (cp && cp.y === view.y && cp.m === i ? ' sel' : ''));
          b.type = 'button'; b.textContent = name;
          b.addEventListener('click', function () { view.m = i; view.mode = 'days'; render(); });
          grid.appendChild(b);
        });
      } else {
        grid = h('div', 'a1c-cal-grid m');
        var cy = parseIso(sel);
        for (var yy = yStart; yy < yStart + 12; yy++) {
          var yb = h('button', 'a1c-btn a1c-cell' + (cy && cy.y === yy ? ' sel' : '') + (yy === now.getFullYear() ? ' today' : ''));
          yb.type = 'button'; yb.textContent = yy;
          yb.addEventListener('click', (function (y) { return function () { view.y = y; view.mode = 'months'; render(); }; })(yy));
          grid.appendChild(yb);
        }
      }
      pop.appendChild(grid);
      if (withTime) {
        pop.appendChild(clockPanel(function () { return parseHM(inp.value); }, function (t) {
          set(inp, btn, (dayOf() || today) + 'T' + pad2(t.h) + ':' + pad2(t.m), false);
          render();
        }));
      }
      var foot = h('div', 'a1c-foot');
      var clr = h('button', 'a1c-btn a1c-link'); clr.type = 'button'; clr.textContent = 'Clear';
      clr.addEventListener('click', function () { set(inp, btn, '', true); });
      var right = h('span');
      var tod = h('button', 'a1c-btn a1c-link'); tod.type = 'button'; tod.textContent = withTime ? 'Now' : 'Today';
      tod.disabled = !inRange(today);
      tod.addEventListener('click', function () {
        if (!withTime) { set(inp, btn, today, true); return; }
        var n = new Date();
        set(inp, btn, today + 'T' + pad2(n.getHours()) + ':' + pad2(n.getMinutes()), false);
        view.y = n.getFullYear(); view.m = n.getMonth(); view.mode = 'days'; render();
      });
      right.appendChild(tod);
      if (withTime) {
        var done = h('button', 'a1c-btn a1c-link'); done.type = 'button'; done.textContent = 'Done';
        done.addEventListener('click', function () { closePopover(); btn.focus(); });
        right.appendChild(done);
      }
      foot.appendChild(inp.required ? h('span') : clr); foot.appendChild(right);
      pop.appendChild(foot);
      if (openPop && openPop.pop === pop) openPop.reposition();
    }
    function step(dir) {
      if (view.mode === 'days') { var d = new Date(view.y, view.m + dir, 1); view.y = d.getFullYear(); view.m = d.getMonth(); }
      else if (view.mode === 'months') view.y += dir;
      else view.y += dir * 12;
      render();
    }
    function focusCell() { var c = pop.querySelector('.a1c-cal-grid .a1c-cell[tabindex="0"]'); if (c) c.focus(); }
    pop.addEventListener('keydown', function (e) {
      if (view.mode !== 'days' || !e.target.closest('.a1c-cal-grid')) return;
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
    openPopover(pop, btn, { minWidth: 292 });
    if (!coarse.matches) setTimeout(focusCell, 30);
  }

  // ── <input list> → A1 suggestions ──────────────────────────────────────────
  function enhanceDatalist(inp) {
    if (inp._a1cList || skip(inp)) return;
    var id = inp.getAttribute('list');
    if (!id) return;
    inp._a1cList = true;
    inp.removeAttribute('list');           // the native dropdown must never show
    inp.setAttribute('data-a1c-list', id);
    inp.setAttribute('role', 'combobox');
    inp.setAttribute('aria-autocomplete', 'list');
    inp.setAttribute('aria-expanded', 'false');
    inp.setAttribute('autocomplete', 'off');
    var lb = null;
    function values() {
      var dl = doc.getElementById(id);
      return dl ? Array.prototype.map.call(dl.querySelectorAll('option'), function (o) { return o.value || o.textContent; }) : [];
    }
    function show(all) {
      var q = all ? '' : inp.value.trim().toLowerCase();
      var list = values().filter(function (v) { return !q || v.toLowerCase().indexOf(q) >= 0; });
      list.sort(function (a, b) { return (a.toLowerCase().indexOf(q) === 0 ? 0 : 1) - (b.toLowerCase().indexOf(q) === 0 ? 0 : 1); });
      if (!list.length || (list.length === 1 && list[0].toLowerCase() === q)) { if (isOpenFor(inp)) closePopover(); return; }
      list = list.slice(0, 50);
      lb = listbox(list.map(function (v) { return { text: v }; }), function (i) { setRaw(inp, list[i]); closePopover(); fire(inp); });
      openPopover(lb.pop, inp, {
        onKey: function (e) {
          if (e.key === ' ' || (e.key.length === 1 && !e.altKey)) return;      // typing goes to the input
          if (e.key === 'Enter' && lb.act < 0) return;
          lb.key(e);
        },
      });
    }
    inp.addEventListener('input', function () { show(false); });
    inp.addEventListener('focus', function () { if (!inp.value) show(true); });
    inp.addEventListener('blur', function () { setTimeout(function () { if (isOpenFor(inp) && doc.activeElement !== inp) closePopover(); }, 120); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'ArrowDown' && !isOpenFor(inp)) { e.preventDefault(); show(true); } });
  }

  // ── checkbox / radio / range ───────────────────────────────────────────────
  function enhanceBox(el) {
    if (el._a1c || skip(el)) return;
    el._a1c = true;
    if (editable(el)) return;                         // CSS alone: never write into a document
    var cs = getComputedStyle(el);
    if (cs.appearance === 'none') return;             // the page draws its own
    var ac = cs.accentColor;
    if (ac && ac !== 'auto') {
      var c = rgb(ac);
      el.style.setProperty('--a1c-ac', ac);
      if (c) el.style.setProperty('--a1c-on', lum(c) > 0.55 ? '#1a1a1d' : '#fff');
    }
    el.setAttribute('data-a1c', '');
    if (el.type === 'range') {
      var paintRange = function () {
        var min = el.min === '' ? 0 : +el.min, max = el.max === '' ? 100 : +el.max, v = +el.value;
        el.style.setProperty('--a1c-pct', (max > min ? ((v - min) / (max - min)) * 100 : 0) + '%');
      };
      el._a1cSync = paintRange;
      el.addEventListener('input', paintRange);
      paintRange();
    }
  }

  // ── colour ─────────────────────────────────────────────────────────────────
  // A colour input's click (a user's, or code's `input.click()`) is cancelled,
  // so the system dialog never opens, and A1's picker opens at the input
  // instead: shade square, hue bar, hex field, swatches. Every move fires
  // `input`, closing fires `change` (once, if the colour moved), like the
  // system dialog does.
  var SWATCHES = ['#ffffff', '#d9d9de', '#9a9aa5', '#5c5c66', '#000000', '#c0aeea', '#8d769a', '#e0b874',
    '#d68a7c', '#e0b57c', '#e5c84a', '#a4b986', '#5daf6d', '#22d3ee', '#8fa6d8', '#a78bda'];
  function hexOf(r, g, b) { return '#' + [r, g, b].map(function (x) { return pad16(Math.round(x)); }).join(''); }
  function pad16(n) { var s = Math.max(0, Math.min(255, n)).toString(16); return s.length < 2 ? '0' + s : s; }
  function hsvToRgb(hh, s, v) {
    var f = function (n) { var k = (n + hh / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5) * 255, f(3) * 255, f(1) * 255];
  }
  function rgbToHsv(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, hh = 0;
    if (d) hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (hh * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx };
  }
  function enhanceColor(inp) {
    if (inp._a1c || skip(inp)) return;
    inp._a1c = true;
    inp.setAttribute('data-a1c', '');
  }
  doc.addEventListener('click', function (e) {
    var inp = e.target;
    if (!inp || inp.tagName !== 'INPUT' || inp.type !== 'color' || !inp._a1c || inp.disabled) return;
    e.preventDefault();
    if (isOpenFor(inp)) { closePopover(); return; }
    openColor(inp);
  }, true);
  function openColor(inp) {
    var start = (inp.value || '#000000').toLowerCase();
    var hsv = rgbToHsv(hexRgb(start) || { r: 0, g: 0, b: 0 });
    var pop = h('div', 'a1c-pop a1c-color');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose a colour');
    var sv = h('div', 'a1c-sv'), svK = h('span', 'a1c-knob'); sv.appendChild(svK);
    var hue = h('div', 'a1c-hue'), hueK = h('span', 'a1c-knob'); hue.appendChild(hueK);
    var row = h('div', 'a1c-crow'), prev = h('span', 'a1c-cprev'), hex = h('input', 'a1c-hex');
    hex.type = 'text'; hex.maxLength = 7; hex.spellcheck = false; hex.setAttribute('aria-label', 'Hex colour');
    row.appendChild(prev); row.appendChild(hex);
    var sws = h('div', 'a1c-sws');
    SWATCHES.forEach(function (c) {
      var b = h('button', 'a1c-sw'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', c);
      b.addEventListener('click', function () { hsv = rgbToHsv(hexRgb(c)); draw(true); });
      sws.appendChild(b);
    });
    var foot = h('div', 'a1c-foot'), done = h('button', 'a1c-btn a1c-link');
    done.type = 'button'; done.textContent = 'Done'; done.style.marginLeft = 'auto';
    done.addEventListener('click', function () { closePopover(); });
    foot.appendChild(done);
    [sv, hue, row, sws, foot].forEach(function (n) { pop.appendChild(n); });
    function draw(commit, fromHex) {
      var c = hsvToRgb(hsv.h, hsv.s, hsv.v), x = hexOf(c[0], c[1], c[2]);
      sv.style.setProperty('--a1c-hue', 'hsl(' + hsv.h + ',100%,50%)');
      svK.style.left = (hsv.s * 100) + '%'; svK.style.top = ((1 - hsv.v) * 100) + '%';
      hueK.style.left = (hsv.h / 360 * 100) + '%';
      prev.style.background = x;
      if (!fromHex) hex.value = x;
      if (commit && inp.value !== x) { setRaw(inp, x); inp.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    function drag(el, fn) {
      el.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch (x) {}
        var move = function (ev) { var r = el.getBoundingClientRect(); fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))); draw(true); };
        var up = function () { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
        move(e);
      });
    }
    drag(sv, function (x, y) { hsv.s = x; hsv.v = 1 - y; });
    drag(hue, function (x) { hsv.h = Math.min(359.9, x * 360); });
    hex.addEventListener('input', function () {
      var v = hex.value.trim(); if (v[0] !== '#') v = '#' + v;
      var c = hexRgb(v); if (c) { hsv = rgbToHsv(c); draw(true, true); }
    });
    hex.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); closePopover(); } });
    draw(false);
    openPopover(pop, inp, {
      minWidth: 236,
      onClose: function () { if (inp.value.toLowerCase() !== start) inp.dispatchEvent(new Event('change', { bubbles: true })); },
    });
  }

  // ── <details> markers ──────────────────────────────────────────────────────
  function enhanceSummary(s) {
    if (s._a1c || skip(s) || editable(s)) return;
    s._a1c = true;
    if (getComputedStyle(s).display === 'list-item') s.setAttribute('data-a1c', '');
  }

  // ── tooltips ───────────────────────────────────────────────────────────────
  // The title comes off while the pointer is over its element (so the
  // browser's own tooltip never shows) and goes back when it leaves, so code
  // and tests that read or select by title see the page as it was.
  var tip = null, tipFor = null, tipTimer = 0, stripped = [];
  function hideTip() {
    clearTimeout(tipTimer); tipFor = null;
    if (tip) { var t = tip; tip = null; t.classList.remove('on'); setTimeout(function () { unmount(t); }, 140); }
  }
  function restore(keepFor) {
    stripped = stripped.filter(function (el) {
      if (keepFor && el.contains(keepFor)) return true;
      if (!el.hasAttribute('title')) el.setAttribute('title', el._a1cTitle);
      el.removeAttribute('data-a1c-tip');
      if (el._a1cAria) { el.removeAttribute('aria-label'); el._a1cAria = false; }
      return false;
    });
  }
  doc.addEventListener('pointerover', function (e) {
    if (e.pointerType === 'touch') return;
    var el = e.target && e.target.closest && e.target.closest('[title],[data-a1c-tip]');
    if (!el || el === tipFor || el.tagName === 'IFRAME' || skip(el)) return;
    var text = el.hasAttribute('title') ? el.getAttribute('title') : el._a1cTitle;
    el.removeAttribute('title');
    if (!text) return;
    el._a1cTitle = text;
    el.setAttribute('data-a1c-tip', '');
    if (stripped.indexOf(el) < 0) stripped.push(el);
    // Keep the accessible name the title gave while it is off.
    if (!el.hasAttribute('aria-label') && !(el.textContent || '').trim()) { el.setAttribute('aria-label', text); el._a1cAria = true; }
    hideTip();
    tipFor = el;
    tipTimer = setTimeout(function () {
      if (tipFor !== el || !el.isConnected) return;
      tip = h('div', 'a1c-tip');
      tip.textContent = text;
      tip.setAttribute('role', 'tooltip');
      paint(tip, palette(el));
      mount(tip, el);
      var r = el.getBoundingClientRect(), o = fixedOrigin(tip);
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var top = r.top - th - 8; if (top < 6) top = r.bottom + 8;
      var left = Math.min(Math.max(6, r.left + r.width / 2 - tw / 2), vw() - tw - 6);
      tip.style.left = (left - o.x) + 'px'; tip.style.top = (top - o.y) + 'px';
      var mine = tip;
      requestAnimationFrame(function () { if (tip === mine) mine.classList.add('on'); });
    }, 450);
  }, true);
  doc.addEventListener('pointerout', function (e) {
    var to = e.relatedTarget;
    if (stripped.length) restore(to);
    if (!tipFor) return;
    if (to && tipFor.contains(to)) return;
    if (tipFor.contains(e.target)) hideTip();
  }, true);
  ['pointerdown', 'keydown', 'wheel'].forEach(function (ev) { doc.addEventListener(ev, hideTip, true); });
  doc.addEventListener('scroll', hideTip, true);

  // ── enhancement ────────────────────────────────────────────────────────────
  var SEL = 'select,input[type=date],input[type=time],input[type=datetime-local],input[list],input[type=checkbox],input[type=radio],input[type=range],input[type=color],summary';
  function one(n) {
    var t = n.tagName;
    // React moved an input it owns: its button goes with it.
    if (n._a1cBtn && n.nextSibling !== n._a1cBtn && n.parentNode) { n.parentNode.insertBefore(n._a1cBtn, n.nextSibling); return; }
    if (t === 'SELECT') enhanceSelect(n);
    else if (t === 'SUMMARY') enhanceSummary(n);
    else if (t === 'INPUT') {
      var ty = n.type;
      if (ty === 'date' || ty === 'time' || ty === 'datetime-local') enhancePicker(n);
      else if (ty === 'checkbox' || ty === 'radio' || ty === 'range') enhanceBox(n);
      else if (ty === 'color') enhanceColor(n);
      if (n.hasAttribute('list')) enhanceDatalist(n);
    }
  }
  function enhance(scope) {
    scope = scope || doc;
    if (scope.nodeType !== 1 && scope !== doc) return;
    if (scope.nodeType === 1 && scope.matches(SEL)) one(scope);
    if (scope.querySelectorAll) Array.prototype.forEach.call(scope.querySelectorAll(SEL), one);
  }
  var pending = [], gone = [], flushQueued = false;
  function flush() {
    flushQueued = false;
    var list = pending; pending = [];
    list.forEach(function (n) { if (n.isConnected) enhance(n); });
    // An input taken out on its own (React's `cond && <input>`) takes its
    // button with it.
    var g = gone; gone = [];
    g.forEach(function (n) {
      var srcs = n._a1cBtn ? [n] : (n.querySelectorAll ? Array.prototype.slice.call(n.querySelectorAll('input.a1c-src')) : []);
      srcs.forEach(function (s) { if (!s.isConnected && s._a1cBtn && s._a1cBtn.isConnected) s._a1cBtn.remove(); });
    });
  }
  function start() {
    injectStyles();
    enhance(doc);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'attributes') {
          // An input that turns into a date / checkbox… after it was added.
          if (m.target.tagName === 'INPUT' && !m.target._a1c) pending.push(m.target);
          continue;
        }
        for (var k = 0; k < m.removedNodes.length; k++) if (m.removedNodes[k].nodeType === 1) gone.push(m.removedNodes[k]);
        var added = m.addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1 || (n.classList && (n.classList.contains('a1c-pop') || n.classList.contains('a1c-tip') || n.classList.contains('a1c-trig')))) continue;
          pending.push(n);
        }
      }
      // Microtask: after the code that built the node has set it up (type,
      // value, options), but before the next paint.
      if ((pending.length || gone.length) && !flushQueued) { flushQueued = true; Promise.resolve().then(flush); }
    }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'list'] });
  }
  if (doc.head) injectStyles();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();

  window.A1Controls = { enhance: enhance, close: closePopover, formatDate: fmtDate, formatTime: fmtTime };
})();
