/* ============================================================================
 * warden-cloud-ui.js — the Cloud tab
 *
 * Renders Warden's Cloud section. Every cloud call goes through WardenCloud (see
 * warden-cloud.js); this file holds a provider *id* and never knows whether it is
 * driving Drive or Dropbox, which is what lets a third provider appear with no
 * edit here.
 *
 * Layout: a sticky toolbar, storage cards, an optional folder tree (desktop
 * only), and a file surface that renders as list / grid / compact. Modals are
 * all in-page — Warden never uses alert/confirm/prompt.
 * ========================================================================== */
(function () {
  'use strict';

  var VC = null;                       // WardenCloud, resolved on first render
  function vc() { return VC || (VC = window.WardenCloud); }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  // ── View state (not synced — this is "where am I looking right now") ──────
  var ST = {
    provider: null,      // active provider id; null = All clouds
    folder: null,        // current folder id within that provider
    trail: [],           // [{id,name}] breadcrumb, root first
    entries: [],         // what's on screen
    loading: false,
    err: '',
    query: '',
    aiMode: false,
    aiAnswer: '',
    sel: {},             // key -> true, for bulk actions
    filter: { kind: '', since: '', minSize: 0, provider: '' },
    treeOpen: {},        // provider|folderId -> bool
    pane: 'files'        // files | favorites | recent | activity | duplicates
  };
  function selKey(e) { return e.provider + ':' + e.id; }
  function selected() { return ST.entries.filter(function (e) { return ST.sel[selKey(e)]; }); }
  function clearSel() { ST.sel = {}; }

  var ICON = {
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    folderPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v3"/><path d="M17 15v6"/><path d="M14 18h6"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m23 7-7 5 7 5z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6"/><path d="M9 18h4"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/><path d="M8 9h3"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/><path d="m5.6 5.6 2.8 2.8"/><path d="m15.6 15.6 2.8 2.8"/><path d="m18.4 5.6-2.8 2.8"/><path d="m8.4 15.6-2.8 2.8"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    compact: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18"/><path d="M3 9h18"/><path d="M3 13h18"/><path d="M3 17h18"/><path d="M3 21h18"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>',
    cog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
  };
  function kindIcon(k) {
    return ICON[k] || (k === 'folder' ? ICON.folder : ICON.file);
  }

  /* ── Styles ───────────────────────────────────────────────────────────────
   * Everything is scoped under #warden-cloud-panel and uses only Warden's own
   * custom properties, so the Cloud tab re-themes with the rest of the app for
   * free. Breakpoints: >1080 shows the tree, <=760 is the phone layout. */
  var STYLE_ID = 'warden-cloud-styles';
  function injectStyles() {
    if ($(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '#warden-cloud-panel{padding:0 0 120px;}',
      /* The context menu, modals, upload dock, selection bar, toast and drop
         overlay all mount to <body>, NOT inside the panel — scoping this rule to
         #warden-cloud-panel left their icons with no width/height at all, so they
         painted at the SVG's natural size and swallowed the screen. Every Cloud
         surface has to be listed here, wherever it lives in the DOM. */
      '#warden-cloud-panel svg,.vcl-menu svg,.vcl-ov svg,.vcl-dock svg,.vcl-selbar svg,.vcl-toast svg,.vcl-drop svg,.vcl-ddp svg{width:1em;height:1em;display:block;flex:0 0 auto;}',
      '.vcl-menu button svg,.vcl-ov .vcl-ib svg,.vcl-dock svg,.vcl-selbar svg,.vcl-ddp svg{max-width:1em;max-height:1em;}',

      /* toolbar */
      '.vcl-bar{position:sticky;top:calc(var(--vhbar-h,0px) + var(--vtabs-h,0px));z-index:24;background:var(--bg);border-bottom:1px solid var(--bd);padding:10px 0 9px;display:flex;flex-direction:column;gap:9px;}',
      '.vcl-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}',
      '.vcl-row.scrollx{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;}',
      '.vcl-row.scrollx::-webkit-scrollbar{display:none;}',

      '.vcl-chip{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;padding:7px 12px;border:1px solid var(--bd);border-radius:var(--radius-sm);background:transparent;color:var(--txd);font:500 12px/1 var(--sans);cursor:pointer;transition:border-color .18s,color .18s,background .18s;white-space:nowrap;}',
      '.vcl-chip:hover{border-color:var(--bdl);color:var(--tx);}',
      '.vcl-chip.on{border-color:var(--ac);color:var(--ac);}',
      '.vcl-chip .dot{width:6px;height:6px;border-radius:50%;background:var(--txm);flex:0 0 auto;}',
      '.vcl-chip .dot.live{background:var(--grn);}',
      // Authorised on this device but the session lapsed. Amber, not grey: the
      // files are still there and one click brings them back — this is not the
      // same state as "never connected here".
      '.vcl-chip .dot.stale{background:var(--ac);}',
      '.vcl-chip svg{font-size:13px;}',
      '.vcl-chip[disabled]{opacity:.42;cursor:not-allowed;}',

      '.vcl-seg{display:inline-flex;border:1px solid var(--bd);border-radius:var(--radius-sm);overflow:hidden;flex:0 0 auto;}',
      '.vcl-seg button{appearance:none;background:transparent;border:0;border-right:1px solid var(--bd);color:var(--txd);padding:7px 9px;font-size:13px;cursor:pointer;display:flex;align-items:center;transition:color .18s,background .18s;}',
      '.vcl-seg button:last-child{border-right:0;}',
      '.vcl-seg button.on{color:var(--ac);background:var(--s1);}',
      '.vcl-seg button:hover{color:var(--tx);}',

      /* themed dropdown (replaces <select>) */
      '.vcl-ddw{flex:0 0 auto;display:inline-flex;}',
      '.vcl-dd{display:inline-flex;align-items:center;gap:7px;appearance:none;background:transparent;border:1px solid var(--bd);border-radius:var(--radius-sm);color:var(--txd);font:500 12px/1 var(--sans);padding:8px 10px;cursor:pointer;white-space:nowrap;transition:border-color .18s,color .18s;}',
      '.vcl-dd:hover{border-color:var(--bdl);color:var(--tx);}',
      '.vcl-dd.open{border-color:var(--ac);color:var(--ac);}',
      '.vcl-dd svg{font-size:13px;opacity:.75;transition:transform .18s;}',
      '.vcl-dd.open svg{transform:rotate(180deg);opacity:1;}',
      '.vcl-dd.sm{font-size:11.5px;padding:7px 9px;background:var(--s1);}',
      '.vcl-dd .lb{pointer-events:none;}',
      '.vcl-ddp{position:fixed;z-index:85;padding:5px;border:1px solid var(--bdl);border-radius:var(--radius);background:var(--s2);box-shadow:0 14px 38px var(--shadow);max-height:min(58vh,340px);overflow:auto;animation:vclddin .13s ease;}',
      '@keyframes vclddin{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}',
      '.vcl-ddp button{display:flex;align-items:center;gap:10px;width:100%;appearance:none;background:transparent;border:0;color:var(--txd);font:500 12.5px/1 var(--sans);padding:9px 10px;border-radius:5px;cursor:pointer;text-align:left;white-space:nowrap;transition:background .14s,color .14s;}',
      '.vcl-ddp button span{flex:1;}',
      '.vcl-ddp button:hover{background:var(--s3);color:var(--tx);}',
      '.vcl-ddp button.on{color:var(--ac);}',
      '.vcl-ddp button svg{font-size:13px;flex:0 0 auto;}',
      '@media(prefers-reduced-motion:reduce){.vcl-ddp{animation:none;}.vcl-dd svg{transition:none;}}',

      '.vcl-search{flex:1 1 190px;min-width:150px;display:flex;align-items:center;gap:7px;border:1px solid var(--bd);border-radius:var(--radius-sm);padding:0 10px;background:var(--s1);transition:border-color .18s;}',
      '.vcl-search:focus-within{border-color:var(--ac);}',
      '.vcl-search svg{font-size:14px;color:var(--txm);flex:0 0 auto;}',
      '.vcl-search input{flex:1;appearance:none;background:transparent;border:0;outline:0;color:var(--tx);font:400 13px/1 var(--sans);padding:9px 0;min-width:0;}',
      '.vcl-search input::placeholder{color:var(--txm);}',
      /* Chrome/Edge paint their own clear button on search fields — a blue ✕ that
         ignores the theme entirely. Suppressed here and replaced by .vcl-clear. */
      '.vcl-search input::-webkit-search-cancel-button,.vcl-search input::-webkit-search-decoration{-webkit-appearance:none;appearance:none;display:none;}',
      '.vcl-clear{flex:0 0 auto;appearance:none;border:0;background:transparent;color:var(--txm);cursor:pointer;font-size:13px;display:flex;padding:3px;border-radius:4px;transition:color .16s,background .16s;}',
      '.vcl-clear:hover{color:var(--ac);background:var(--s3);}',
      '.vcl-ai{flex:0 0 auto;border:0;background:transparent;color:var(--txm);cursor:pointer;font-size:14px;display:flex;padding:2px;transition:color .18s;}',
      '.vcl-ai.on{color:var(--ac);}',
      '.vcl-ai:hover{color:var(--tx);}',

      /* breadcrumb */
      '.vcl-crumbs{display:flex;align-items:center;gap:3px;flex-wrap:wrap;font:500 12px/1 var(--sans);color:var(--txm);}',
      '.vcl-crumbs button{appearance:none;background:transparent;border:0;color:var(--txd);cursor:pointer;font:inherit;padding:4px 5px;border-radius:4px;transition:color .18s,background .18s;}',
      '.vcl-crumbs button:hover{color:var(--ac);background:var(--s1);}',
      '.vcl-crumbs button:last-child{color:var(--tx);}',
      '.vcl-crumbs .sep{opacity:.5;font-size:11px;display:flex;}',
      '.vcl-crumbs .sep svg{font-size:11px;}',

      /* storage cards */
      '.vcl-stores{display:grid;grid-template-columns:repeat(auto-fit,minmax(238px,1fr));gap:10px;margin:12px 0 4px;}',
      '.vcl-store{border:1px solid var(--bd);border-radius:var(--radius);background:var(--s1);padding:13px 15px;}',
      '.vcl-store-h{display:flex;align-items:center;gap:8px;margin-bottom:10px;}',
      '.vcl-store-h .nm{font:600 13px/1 var(--display);color:var(--tx);letter-spacing:.2px;flex:1;}',
      '.vcl-store-h .ic{font-size:15px;}',
      '.vcl-store .pct{font:600 11px/1 var(--sans);color:var(--txd);}',
      '.vcl-track{height:6px;border-radius:4px;background:var(--s3);overflow:hidden;}',
      '.vcl-fill{height:100%;border-radius:4px;transition:width .45s cubic-bezier(.2,.8,.3,1);}',
      '.vcl-store .sub{margin-top:8px;font:400 11px/1.5 var(--sans);color:var(--txm);}',
      '.vcl-break{display:flex;gap:4px;margin-top:9px;}',
      '.vcl-break i{height:4px;border-radius:2px;flex:0 0 auto;min-width:2px;}',
      '.vcl-break-key{display:flex;flex-wrap:wrap;gap:8px;margin-top:7px;font:400 10px/1 var(--sans);color:var(--txm);}',
      '.vcl-break-key span{display:inline-flex;align-items:center;gap:4px;}',
      '.vcl-break-key i{width:6px;height:6px;border-radius:2px;}',

      /* body split */
      '.vcl-body{display:grid;grid-template-columns:1fr;gap:14px;margin-top:12px;align-items:start;}',
      '@media(min-width:1080px){.vcl-body.has-tree{grid-template-columns:236px 1fr;}}',
      '.vcl-tree{display:none;border:1px solid var(--bd);border-radius:var(--radius);background:var(--s1);padding:8px;max-height:min(66vh,620px);overflow:auto;position:sticky;top:calc(var(--vhbar-h,0px) + var(--vtabs-h,0px) + 118px);}',
      '@media(min-width:1080px){.vcl-body.has-tree .vcl-tree{display:block;}}',
      '.vcl-tnode{display:flex;align-items:center;gap:6px;padding:6px 7px;border-radius:5px;cursor:pointer;color:var(--txd);font:500 12px/1.2 var(--sans);transition:background .16s,color .16s;}',
      '.vcl-tnode:hover{background:var(--s2);color:var(--tx);}',
      '.vcl-tnode.on{color:var(--ac);background:var(--s2);}',
      '.vcl-tnode .tw{width:14px;flex:0 0 auto;display:flex;font-size:11px;color:var(--txm);transition:transform .18s;}',
      '.vcl-tnode .tw.open{transform:rotate(90deg);}',
      '.vcl-tnode .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.vcl-tnode svg{font-size:13px;}',
      '.vcl-tkids{margin-left:11px;border-left:1px solid var(--bd);padding-left:4px;}',

      /* file surface */
      '.vcl-files{min-width:0;}',
      '.vcl-list{border:1px solid var(--bd);border-radius:var(--radius);overflow:hidden;background:var(--s1);}',
      '.vcl-item{display:flex;align-items:center;gap:11px;padding:11px 13px;border-bottom:1px solid var(--bd);cursor:pointer;transition:background .16s;position:relative;}',
      '.vcl-item:last-child{border-bottom:0;}',
      '.vcl-item:hover{background:var(--s2);}',
      '.vcl-item.sel{background:var(--s2);box-shadow:inset 2px 0 0 var(--ac);}',
      '.vcl-item.dragover{box-shadow:inset 0 0 0 1px var(--ac);}',
      '.vcl-ic{width:32px;height:32px;flex:0 0 auto;border-radius:6px;background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--txd);overflow:hidden;}',
      '.vcl-ic img{width:100%;height:100%;object-fit:cover;}',
      '.vcl-ic.folder{color:var(--ac);}',
      '.vcl-meta{flex:1;min-width:0;}',
      '.vcl-nm{font:500 13px/1.3 var(--sans);color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.vcl-sub{font:400 11px/1.3 var(--sans);color:var(--txm);margin-top:2px;display:flex;gap:7px;flex-wrap:wrap;}',
      '.vcl-sub .why{color:var(--ac);font-style:italic;}',
      '.vcl-act{display:flex;align-items:center;gap:2px;flex:0 0 auto;}',
      '.vcl-ib{appearance:none;background:transparent;border:0;color:var(--txm);cursor:pointer;padding:6px;border-radius:5px;font-size:14px;display:flex;transition:color .16s,background .16s;}',
      '.vcl-ib:hover{color:var(--ac);background:var(--s3);}',
      '.vcl-ib.on{color:var(--ac);}',
      '.vcl-ib.on svg{fill:var(--ac);}',

      /* grid */
      '.vcl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;}',
      '@media(max-width:520px){.vcl-grid{grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:8px;}}',
      '.vcl-card{border:1px solid var(--bd);border-radius:var(--radius);background:var(--s1);overflow:hidden;cursor:pointer;transition:border-color .18s,transform .12s;position:relative;}',
      '.vcl-card:hover{border-color:var(--bdl);}',
      '.vcl-card:active{transform:scale(.985);}',
      '.vcl-card.sel{border-color:var(--ac);}',
      '.vcl-card.dragover{box-shadow:0 0 0 1px var(--ac);}',
      '.vcl-thumb{aspect-ratio:4/3;background:var(--s2);display:flex;align-items:center;justify-content:center;font-size:24px;color:var(--txm);overflow:hidden;}',
      '.vcl-thumb img{width:100%;height:100%;object-fit:cover;}',
      '.vcl-thumb.folder{color:var(--ac);}',
      '.vcl-cbody{padding:8px 10px 10px;}',
      '.vcl-cbody .vcl-nm{font-size:12px;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.vcl-cfav{position:absolute;top:6px;right:6px;font-size:13px;color:var(--ac);filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));}',
      '.vcl-cfav svg{fill:var(--ac);}',

      /* compact */
      '.vcl-comp .vcl-item{padding:6px 11px;gap:9px;}',
      '.vcl-comp .vcl-ic{width:20px;height:20px;border-radius:4px;font-size:12px;background:transparent;}',
      '.vcl-comp .vcl-sub{display:none;}',
      '.vcl-comp .vcl-nm{font-size:12px;}',
      '.vcl-comp .vcl-size{font:400 11px/1 var(--sans);color:var(--txm);flex:0 0 auto;}',

      /* states */
      '.vcl-empty{padding:44px 20px;text-align:center;color:var(--txm);font:400 13px/1.6 var(--sans);}',
      '.vcl-empty .big{font:600 15px/1.4 var(--display);color:var(--txd);margin-bottom:6px;}',
      '.vcl-err{border:1px solid rgba(214,138,124,.34);background:rgba(214,138,124,.07);color:var(--err);border-radius:var(--radius);padding:11px 14px;font:400 12px/1.5 var(--sans);margin:10px 0;}',
      '.vcl-skel{height:56px;border-bottom:1px solid var(--bd);background:linear-gradient(90deg,var(--s1) 25%,var(--s2) 50%,var(--s1) 75%);background-size:200% 100%;animation:vclsk 1.15s infinite;}',
      '@keyframes vclsk{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      '@media(prefers-reduced-motion:reduce){.vcl-skel{animation:none;}.vcl-fill{transition:none;}}',

      /* section heads */
      '.vcl-sh{display:flex;align-items:center;gap:8px;margin:16px 0 9px;}',
      '.vcl-sh .t{font:600 12px/1 var(--display);color:var(--txd);letter-spacing:1.1px;text-transform:uppercase;}',
      '.vcl-sh .ln{flex:1;height:1px;background:var(--bd);}',
      '.vcl-sh .ct{font:500 11px/1 var(--sans);color:var(--txm);}',

      /* selection bar */
      '.vcl-selbar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:60;display:flex;align-items:center;gap:6px;padding:8px 10px;border:1px solid var(--bdl);border-radius:999px;background:var(--s2);box-shadow:0 12px 34px var(--shadow);max-width:calc(100vw - 24px);overflow-x:auto;scrollbar-width:none;}',
      '.vcl-selbar::-webkit-scrollbar{display:none;}',
      '.vcl-selbar .ct{font:600 12px/1 var(--sans);color:var(--ac);padding:0 6px;white-space:nowrap;flex:0 0 auto;}',

      /* upload dock */
      '.vcl-dock{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:58;width:min(330px,calc(100vw - 32px));border:1px solid var(--bd);border-radius:var(--radius);background:var(--s1);box-shadow:0 16px 40px var(--shadow);overflow:hidden;}',
      '.vcl-dock-h{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--bd);background:var(--s2);}',
      '.vcl-dock-h .t{font:600 12px/1 var(--display);color:var(--tx);flex:1;letter-spacing:.3px;}',
      '.vcl-dock-b{max-height:238px;overflow:auto;}',
      '.vcl-up{padding:9px 12px;border-bottom:1px solid var(--bd);}',
      '.vcl-up:last-child{border-bottom:0;}',
      '.vcl-up-t{display:flex;align-items:center;gap:7px;}',
      '.vcl-up-t .nm{flex:1;min-width:0;font:500 12px/1.3 var(--sans);color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.vcl-up-t .st{font:400 10px/1 var(--sans);color:var(--txm);flex:0 0 auto;}',
      '.vcl-up-t .st.err{color:var(--err);}',
      '.vcl-up-t .st.ok{color:var(--grn);}',
      '.vcl-up-bar{height:3px;border-radius:2px;background:var(--s3);margin-top:7px;overflow:hidden;}',
      '.vcl-up-bar i{display:block;height:100%;background:var(--ac);border-radius:2px;transition:width .2s;}',

      /* drop overlay */
      '.vcl-drop{position:fixed;inset:0;z-index:70;background:rgba(26,26,29,.82);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;pointer-events:none;}',
      '.vcl-drop .in{border:2px dashed var(--ac);border-radius:16px;padding:34px 46px;text-align:center;color:var(--ac);font:600 15px/1.5 var(--display);}',
      '.vcl-drop .in svg{width:30px;height:30px;margin:0 auto 10px;}',

      /* context menu */
      '.vcl-menu{position:fixed;z-index:80;min-width:186px;border:1px solid var(--bdl);border-radius:var(--radius);background:var(--s2);box-shadow:0 14px 38px var(--shadow);padding:5px;overflow:hidden;}',
      '.vcl-menu button{display:flex;align-items:center;gap:9px;width:100%;appearance:none;background:transparent;border:0;color:var(--txd);font:500 12.5px/1 var(--sans);padding:9px 10px;border-radius:5px;cursor:pointer;text-align:left;transition:background .14s,color .14s;}',
      '.vcl-menu button:hover{background:var(--s3);color:var(--tx);}',
      '.vcl-menu button.danger{color:var(--err);}',
      '.vcl-menu button[disabled]{opacity:.4;cursor:not-allowed;}',
      '.vcl-menu button svg{font-size:14px;flex:0 0 auto;}',
      '.vcl-menu .div{height:1px;background:var(--bd);margin:4px 2px;}',

      /* modals — Warden never uses browser dialogs */
      '.vcl-ov{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.62);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;}',
      '.vcl-box{width:100%;max-width:432px;max-height:88vh;overflow:auto;border:1px solid var(--bdl);border-radius:14px;background:var(--s1);box-shadow:0 24px 60px var(--shadow);}',
      '.vcl-box.wide{max-width:760px;}',
      '.vcl-box-h{display:flex;align-items:center;gap:9px;padding:15px 18px;border-bottom:1px solid var(--bd);}',
      '.vcl-box-h .t{flex:1;font:700 15px/1.2 var(--display);color:var(--tx);letter-spacing:.2px;}',
      '.vcl-box-b{padding:16px 18px;}',
      '.vcl-box-f{display:flex;gap:8px;justify-content:flex-end;padding:13px 18px;border-top:1px solid var(--bd);flex-wrap:wrap;}',
      '.vcl-fld{margin-bottom:13px;}',
      '.vcl-fld label{display:block;font:600 10.5px/1 var(--sans);color:var(--txm);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;}',
      '.vcl-fld input,.vcl-fld select{width:100%;appearance:none;background:var(--s2);border:1px solid var(--bd);border-radius:var(--radius-sm);color:var(--tx);font:400 13px/1.3 var(--sans);padding:10px 11px;outline:0;transition:border-color .18s;}',
      '.vcl-fld input:focus,.vcl-fld select:focus{border-color:var(--ac);}',
      '.vcl-fld .hint{font:400 11px/1.5 var(--sans);color:var(--txm);margin-top:6px;}',
      '.vcl-fld .hint a{color:var(--ac);}',
      '.vcl-btn{appearance:none;border:1px solid var(--bd);background:transparent;color:var(--txd);font:600 12.5px/1 var(--sans);padding:10px 15px;border-radius:var(--radius-sm);cursor:pointer;transition:border-color .18s,color .18s,background .18s;}',
      '.vcl-btn:hover{border-color:var(--bdl);color:var(--tx);}',
      '.vcl-btn.gold{border-color:var(--acl);color:var(--ac);}',
      '.vcl-btn.gold:hover{border-color:var(--ac);}',
      '.vcl-btn.danger{color:var(--err);border-color:rgba(214,138,124,.32);}',
      '.vcl-btn[disabled]{opacity:.45;cursor:not-allowed;}',
      '.vcl-btn.sm{padding:8px 13px;font-size:12px;}',

      /* setup modal — fields first, instructions folded away */
      '.vcl-set-h{display:flex;align-items:center;gap:8px;margin:0 0 12px;padding-top:4px;}',
      '.vcl-set-h + .vcl-set-h{margin-top:22px;}',
      '.vcl-set-h .ic{font-size:15px;display:flex;}',
      '.vcl-set-h .nm{flex:1;font:700 13.5px/1 var(--display);color:var(--tx);letter-spacing:.2px;}',
      '.vcl-set-h .st{display:inline-flex;align-items:center;gap:5px;font:500 11px/1 var(--sans);color:var(--txm);}',
      '.vcl-set-h .st i{width:6px;height:6px;border-radius:50%;background:var(--txm);}',
      '.vcl-set-h .st.on{color:var(--grn);}.vcl-set-h .st.on i{background:var(--grn);}',
      '.vcl-set-act{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:2px 0 4px;}',
      '.vcl-link{appearance:none;background:transparent;border:0;color:var(--txm);font:500 11.5px/1 var(--sans);cursor:pointer;padding:6px 2px;text-decoration:underline;text-underline-offset:3px;transition:color .16s;}',
      '.vcl-link:hover{color:var(--ac);}',
      '.vcl-help{margin:4px 0 18px;padding:11px 13px;border:1px solid var(--bd);border-radius:var(--radius-sm);background:var(--s2);font:400 11.5px/1.65 var(--sans);color:var(--txm);}',
      '.vcl-help code{font:500 11px/1.4 var(--mono,"IBM Plex Mono",monospace);color:var(--txd);background:var(--s3);padding:1px 5px;border-radius:3px;word-break:break-all;}',
      '.vcl-help b{color:var(--txd);font-weight:600;}',
      '.vcl-set-sep{height:1px;background:var(--bd);margin:20px 0 0;}',

      /* preview */
      '.vcl-prev{background:var(--s2);border-radius:var(--radius);overflow:auto;max-height:64vh;display:flex;align-items:center;justify-content:center;}',
      '.vcl-prev img,.vcl-prev video{max-width:100%;max-height:64vh;display:block;}',
      '.vcl-prev iframe{width:100%;height:64vh;border:0;background:#fff;}',
      '.vcl-prev pre{margin:0;padding:15px;font:400 12px/1.65 var(--mono,"IBM Plex Mono",monospace);color:var(--tx);white-space:pre-wrap;word-break:break-word;width:100%;}',
      '.vcl-sheet{width:100%;align-self:stretch;overflow:auto;}',
      '.vcl-sheet table{border-collapse:collapse;font:400 12px/1.5 var(--sans);color:var(--tx);}',
      '.vcl-sheet th,.vcl-sheet td{border:1px solid var(--bd);padding:6px 10px;text-align:left;vertical-align:top;white-space:pre-wrap;max-width:340px;}',
      '.vcl-sheet thead th{position:sticky;top:0;z-index:1;background:var(--s3);font-weight:600;color:var(--txd);}',
      '.vcl-sheet .note{padding:9px 10px 3px;font:400 11px/1.5 var(--sans);color:var(--txm);}',

      /* properties + activity rows */
      '.vcl-prop{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--bd);font:400 12.5px/1.4 var(--sans);}',
      '.vcl-prop:last-child{border-bottom:0;}',
      '.vcl-prop .k{width:104px;flex:0 0 auto;color:var(--txm);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.7px;padding-top:1px;}',
      '.vcl-prop .v{flex:1;color:var(--tx);word-break:break-word;}',
      '.vcl-act-row{display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid var(--bd);}',
      '.vcl-act-row:last-child{border-bottom:0;}',
      '.vcl-act-row .ic{font-size:13px;color:var(--txm);flex:0 0 auto;}',
      '.vcl-act-row .tx{flex:1;font:400 12.5px/1.4 var(--sans);color:var(--tx);min-width:0;}',
      '.vcl-act-row .tx b{font-weight:600;color:var(--ac);}',
      '.vcl-act-row .at{font:400 11px/1 var(--sans);color:var(--txm);flex:0 0 auto;}',

      /* toast */
      '.vcl-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(78px + env(safe-area-inset-bottom,0px));z-index:100;padding:11px 17px;border:1px solid var(--bdl);border-radius:999px;background:var(--s2);color:var(--tx);font:500 12.5px/1 var(--sans);box-shadow:0 12px 30px var(--shadow);max-width:calc(100vw - 28px);text-align:center;animation:vclin .2s ease;}',
      '.vcl-toast.bad{color:var(--err);border-color:rgba(214,138,124,.4);}',
      '@keyframes vclin{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}',

      /* AI answer */
      '.vcl-aians{border:1px solid var(--acl);border-radius:var(--radius);background:rgba(141,118,154,.06);padding:12px 14px;margin:10px 0;font:400 12.5px/1.6 var(--sans);color:var(--txd);display:flex;gap:9px;}',
      '.vcl-aians svg{font-size:15px;color:var(--ac);flex:0 0 auto;margin-top:1px;}',

      /* phone tuning */
      '@media(max-width:760px){',
      '.vcl-stores{grid-template-columns:1fr;gap:8px;}',
      '.vcl-store{padding:11px 13px;}',
      '.vcl-item{padding:10px 11px;gap:9px;}',
      '.vcl-bar{padding:8px 0;gap:7px;}',
      '.vcl-box{max-height:92vh;}',
      '.vcl-dock{right:8px;left:8px;width:auto;}',
      '}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ── Small shared UI atoms ────────────────────────────────────────────────*/
  var toastTimer = null;
  function toast(msg, bad) {
    var old = document.querySelector('.vcl-toast'); if (old) old.remove();
    var t = el('div', { class: 'vcl-toast' + (bad ? ' bad' : ''), text: msg });
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, bad ? 4200 : 2400);
  }

  function closeOverlays() {
    document.querySelectorAll('.vcl-ov').forEach(function (o) { o.remove(); });
  }
  function modal(title, bodyNode, buttons, wide) {
    closeOverlays();
    var box = el('div', { class: 'vcl-box' + (wide ? ' wide' : '') }, [
      el('div', { class: 'vcl-box-h' }, [
        el('div', { class: 't', text: title }),
        el('button', { class: 'vcl-ib', html: ICON.x, onclick: closeOverlays, 'aria-label': 'Close' })
      ]),
      el('div', { class: 'vcl-box-b' }, [bodyNode]),
      buttons && buttons.length ? el('div', { class: 'vcl-box-f' }, buttons) : null
    ]);
    var ov = el('div', {
      class: 'vcl-ov',
      onclick: function (e) { if (e.target === ov) closeOverlays(); }
    }, [box]);
    document.body.appendChild(ov);
    return ov;
  }
  // Replaces window.confirm — same job, Warden's chrome.
  function confirmBox(title, msg, okLabel, onOk, danger) {
    modal(title, el('div', { style: 'font:400 13px/1.6 var(--sans);color:var(--txd)', text: msg }), [
      el('button', { class: 'vcl-btn', text: 'Cancel', onclick: closeOverlays }),
      el('button', {
        class: 'vcl-btn ' + (danger ? 'danger' : 'gold'), text: okLabel,
        onclick: function () { closeOverlays(); onOk(); }
      })
    ]);
  }
  // Replaces window.prompt.
  function promptBox(title, label, value, okLabel, onOk) {
    var input = el('input', { type: 'text', value: value || '' });
    var body = el('div', {}, [el('div', { class: 'vcl-fld' }, [el('label', { text: label }), input])]);
    function go() { var v = input.value.trim(); if (!v) { input.focus(); return; } closeOverlays(); onOk(v); }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    modal(title, body, [
      el('button', { class: 'vcl-btn', text: 'Cancel', onclick: closeOverlays }),
      el('button', { class: 'vcl-btn gold', text: okLabel, onclick: go })
    ]);
    setTimeout(function () { input.focus(); input.select(); }, 40);
  }

  /* ── Themed dropdown ──────────────────────────────────────────────────────
   * Replaces <select>. The native control's popup is rendered by the operating
   * system and can't be styled at all — no border-radius, no colours, no font —
   * so it landed as a white/blue OS list in the middle of a charcoal-and-gold UI.
   * This is a button plus a positioned panel: same keyboard behaviour, fully
   * themed, and it flips upward near the bottom of the viewport. */
  function dropdown(opts, value, label, onPick, small) {
    var current = opts.filter(function (o) { return String(o[0]) === String(value); })[0] || opts[0];
    var btn = el('button', {
      class: 'vcl-dd' + (small ? ' sm' : ''), type: 'button',
      'aria-haspopup': 'listbox', 'aria-label': label,
      html: '<span class="lb">' + esc(current[1]) + '</span>' + ICON.caret
    });
    var wrap = el('div', { class: 'vcl-ddw' }, [btn]);

    function close() {
      var p = document.querySelector('.vcl-ddp');
      if (p) p.remove();
      btn.classList.remove('open');
      document.removeEventListener('click', onDoc, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    }
    function onDoc(e) { if (!e.target.closest('.vcl-ddp') && e.target !== btn && !btn.contains(e.target)) close(); }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (btn.classList.contains('open')) { close(); return; }
      close();
      var panel = el('div', { class: 'vcl-ddp', role: 'listbox' });
      opts.forEach(function (o) {
        panel.appendChild(el('button', {
          type: 'button', role: 'option',
          class: String(o[0]) === String(value) ? 'on' : '',
          'aria-selected': String(o[0]) === String(value) ? 'true' : 'false',
          html: '<span>' + esc(o[1]) + '</span>' + (String(o[0]) === String(value) ? ICON.check : ''),
          onclick: function (ev) { ev.stopPropagation(); close(); onPick(o[0]); }
        }));
      });
      document.body.appendChild(panel);
      var r = btn.getBoundingClientRect();
      var ph = panel.offsetHeight;
      // Flip up when there isn't room below — otherwise the list is cut off by
      // the viewport on a phone.
      var top = (r.bottom + ph + 8 > window.innerHeight && r.top - ph - 6 > 0) ? r.top - ph - 6 : r.bottom + 6;
      panel.style.top = Math.max(8, top) + 'px';
      panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8)) + 'px';
      panel.style.minWidth = Math.max(r.width, 132) + 'px';
      btn.classList.add('open');
      setTimeout(function () {
        document.addEventListener('click', onDoc, true);
        window.addEventListener('resize', close);
        window.addEventListener('scroll', close, true);
      }, 0);
    });
    return wrap;
  }

  /* ── Data loading ─────────────────────────────────────────────────────────*/
  var loadSeq = 0;

  async function loadFolder(providerId, folderId, opts) {
    opts = opts || {};
    var seq = ++loadSeq;
    ST.loading = true; ST.err = ''; ST.aiAnswer = '';
    if (!opts.keepSel) clearSel();
    render();
    try {
      var entries;
      if (!providerId) {
        // "All clouds" root — every connected provider's top level, merged.
        var conn = vc().connected();
        if (!conn.length) { ST.entries = []; ST.loading = false; render(); return; }
        var lists = await Promise.all(conn.map(function (p) {
          return vc().list(p.id, p.rootId).catch(function () { return []; });
        }));
        entries = [].concat.apply([], lists);
      } else {
        entries = await vc().list(providerId, folderId, function (cached) {
          if (seq !== loadSeq) return;
          ST.entries = cached; render();     // paint the cache, keep loading
        });
      }
      if (seq !== loadSeq) return;           // a newer navigation won
      ST.entries = entries; ST.loading = false; render();
    } catch (e) {
      if (seq !== loadSeq) return;
      ST.loading = false; ST.err = vc().fmtErr(e); render();
    }
  }

  var POLL_MS = 45 * 1000;
  var refreshing = false;

  // Re-list the open folder in place. `quiet` skips the skeleton and only
  // repaints if something actually changed, so a background poll never flickers
  // the list or scrolls it.
  async function refreshCurrent(quiet) {
    if (refreshing || !vc().connected().length) return;
    refreshing = true;
    try {
      var entries;
      if (!ST.provider) {
        var conn = vc().connected();
        var lists = await Promise.all(conn.map(function (p) {
          return vc().list(p.id, p.rootId).catch(function () { return []; });
        }));
        entries = [].concat.apply([], lists);
      } else {
        entries = await vc().list(ST.provider, ST.folder);
      }
      if (quiet && sameEntries(entries, ST.entries)) return;
      ST.entries = entries; ST.err = '';
      renderFilesOnly();
    } catch (e) {
      if (!quiet) { ST.err = vc().fmtErr(e); renderFilesOnly(); }
    } finally { refreshing = false; }
  }

  // Cheap identity check — ids, names, sizes and mtimes. Enough to catch a new
  // upload, a rename, a delete or an edit from another device.
  function sameEntries(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    var key = function (e) { return e.provider + ':' + e.id + ':' + e.name + ':' + (e.size || 0) + ':' + (e.modified || 0); };
    var A = a.map(key).sort().join('|'), B = b.map(key).sort().join('|');
    return A === B;
  }

  function navTo(providerId, folderId, name, push) {
    ST.provider = providerId;
    ST.folder = folderId;
    ST.pane = 'files';
    ST.query = ''; ST.aiMode = false;
    if (push) ST.trail.push({ id: folderId, name: name, provider: providerId });
    loadFolder(providerId, folderId);
  }
  function navCrumb(i) {
    ST.trail = ST.trail.slice(0, i + 1);
    var last = ST.trail[ST.trail.length - 1];
    if (!last) { ST.provider = null; ST.folder = null; loadFolder(null, null); return; }
    ST.provider = last.provider; ST.folder = last.id;
    loadFolder(last.provider, last.id);
  }
  function goRoot() {
    ST.trail = []; ST.provider = null; ST.folder = null; ST.pane = 'files';
    ST.query = ''; ST.aiMode = false;
    loadFolder(null, null);
  }

  /* ── Sorting / filtering ──────────────────────────────────────────────────*/
  function sortedEntries(list) {
    var S = vc().settings();
    var k = S.sortKey, dir = S.sortDir === 'desc' ? -1 : 1;
    var out = list.slice();
    out.sort(function (a, b) {
      // Folders always lead, in both directions — a folder sorted into the
      // middle of a file list is never what anyone wants.
      if (a.folder !== b.folder) return a.folder ? -1 : 1;
      var r = 0;
      if (k === 'size') r = (a.size || 0) - (b.size || 0);
      else if (k === 'modified') r = (a.modified || 0) - (b.modified || 0);
      else if (k === 'created') r = (a.created || 0) - (b.created || 0);
      else if (k === 'type') r = String(vc().kindOf(a)).localeCompare(vc().kindOf(b)) || a.name.localeCompare(b.name);
      else r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return r * dir;
    });
    return out;
  }

  function filtered(list) {
    var f = ST.filter;
    return list.filter(function (e) {
      if (f.provider && e.provider !== f.provider) return false;
      if (f.kind && vc().kindOf(e) !== f.kind) return false;
      if (f.since && (e.modified || 0) < Number(f.since)) return false;
      if (f.minSize && (e.size || 0) < Number(f.minSize)) return false;
      if (ST.query && !ST.aiMode && e.name.toLowerCase().indexOf(ST.query.toLowerCase()) < 0) return false;
      return true;
    });
  }

  /* ── Render ───────────────────────────────────────────────────────────────*/
  var rendering = false;
  function render() {
    var panel = $('warden-cloud-panel');
    if (!panel || panel.style.display === 'none') return;
    // A locked warden owns this panel — warden-ui.js has drawn the unlock card
    // into it. Nothing here may paint over that, and the poll/event paths below
    // can fire with no user behind them, so the check lives at the paint point
    // rather than at every caller.
    if (locked()) return;
    if (rendering) return;
    rendering = true;
    // Belt and braces for the paths that still do a full rebuild (clearing the
    // last character, switching panes): if the search box had focus, put it back
    // with the caret where it was. Without this the mobile keyboard closes.
    var act = document.activeElement;
    var hadFocus = act && act.id === 'vcl-q';
    var caret = hadFocus ? act.selectionStart : 0;
    try { paint(panel); } finally { rendering = false; }
    if (hadFocus) {
      var q = $('vcl-q');
      if (q) { q.focus(); try { q.setSelectionRange(caret, caret); } catch (e) {} }
    }
  }

  function paint(panel) {
    var S = vc().settings();
    panel.innerHTML = '';
    panel.appendChild(buildBar(S));

    // No provider set up at all — the whole tab is a setup prompt.
    var anyConfigured = vc().all().some(function (p) { return p.configured(); });
    var anyConnected = vc().connected().length > 0;

    if (!anyConfigured) { panel.appendChild(setupEmpty()); return; }

    // Favorites, Recent and Activity are Warden's own synced data — they read
    // fine with no live connection, so the connect prompt and the storage cards
    // (both of which need one) stay on the files pane.
    if (ST.pane !== 'files') { panel.appendChild(buildPane(S)); return; }

    if (!anyConnected) panel.appendChild(connectEmpty());
    if (anyConnected) panel.appendChild(buildStores());

    if (ST.err) panel.appendChild(el('div', { class: 'vcl-err', text: ST.err }));
    if (ST.aiAnswer) {
      panel.appendChild(el('div', { class: 'vcl-aians' }, [
        el('span', { html: ICON.spark }), el('div', { text: ST.aiAnswer })
      ]));
    }

    var body = el('div', { class: 'vcl-body' + (ST.provider ? ' has-tree' : '') });
    if (ST.provider) body.appendChild(buildTree());
    body.appendChild(buildFiles(S));
    panel.appendChild(body);

    if (Object.keys(ST.sel).length) mountSelBar(); else unmountSelBar();
    renderDock();
  }

  function buildBar(S) {
    var bar = el('div', { class: 'vcl-bar' });

    // Row 1 — provider chips + panes
    var r1 = el('div', { class: 'vcl-row scrollx' });
    r1.appendChild(el('button', {
      class: 'vcl-chip' + (ST.pane === 'files' && !ST.provider ? ' on' : ''),
      html: '<span class="dot' + (vc().connected().length ? ' live' : '') + '"></span>All clouds',
      onclick: goRoot
    }));
    vc().all().forEach(function (p) {
      if (!p.configured()) return;
      // Reconnecting is only ever offered, never taken. The chip is where a
      // lapsed session shows up, and pressing it is the click that permits the
      // sign-in window — nothing else in the app is allowed to summon one.
      var stale = !!(p.needsReauth && p.needsReauth());
      r1.appendChild(el('button', {
        class: 'vcl-chip' + (ST.provider === p.id && ST.pane === 'files' ? ' on' : ''),
        title: stale ? 'Session expired — click to reconnect' + (p.account && p.account() ? ' as ' + p.account() : '') : '',
        html: '<span class="dot' + (p.connected() ? (stale ? ' stale' : ' live') : '') + '"></span>' + p.icon + esc(p.label),
        onclick: function () {
          if (!p.connected() || stale) { doConnect(p); return; }
          ST.trail = [{ id: p.rootId, name: p.label, provider: p.id }];
          navTo(p.id, p.rootId, p.label, false);
        }
      }));
    });
    [['favorites', 'Favorites', ICON.star], ['recent', 'Recent', ICON.clock],
     ['trash', 'Trash', ICON.trash], ['activity', 'Activity', ICON.activity]].forEach(function (t) {
      r1.appendChild(el('button', {
        class: 'vcl-chip' + (ST.pane === t[0] ? ' on' : ''),
        html: t[2] + esc(t[1]),
        onclick: function () {
          ST.pane = t[0]; clearSel(); render();
          if (t[0] === 'trash') loadTrash();
        }
      }));
    });
    r1.appendChild(el('button', { class: 'vcl-chip', html: ICON.cog + 'Setup', onclick: openSetup }));
    bar.appendChild(r1);

    // Row 2 — search + views + actions
    var r2 = el('div', { class: 'vcl-row' });
    // type=text, not type=search: the native search field paints its own clear
    // button, which Chrome/Edge render as a blue ✕ that ignores the theme. We
    // draw our own below.
    var input = el('input', {
      type: 'text', id: 'vcl-q', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
      placeholder: ST.aiMode ? 'Ask about your files…' : 'Search files and folders…',
      value: ST.query, 'aria-label': 'Search cloud files'
    });
    var clearBtn = el('button', {
      class: 'vcl-clear', html: ICON.x, title: 'Clear search', 'aria-label': 'Clear search',
      style: ST.query ? '' : 'display:none',
      onclick: function () {
        ST.query = ''; input.value = ''; ST.aiAnswer = '';
        clearBtn.style.display = 'none';
        paintFilters(); loadFolder(ST.provider, ST.folder);
        input.focus();
      }
    });
    var searchTimer = null;
    input.addEventListener('input', function () {
      ST.query = input.value;
      clearBtn.style.display = ST.query ? '' : 'none';
      if (ST.aiMode) return;                       // AI runs on Enter, not per keypress
      clearTimeout(searchTimer);
      // Repaint ONLY the filter row and the file list. A full render() rebuilds
      // this input, and replacing a focused field mid-word tears down the mobile
      // keyboard — which is what made typing here impossible on a phone.
      searchTimer = setTimeout(function () { runSearch(); }, 260);
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); runSearch(true); } });
    var search = el('div', { class: 'vcl-search' }, [
      el('span', { html: ICON.search }),
      input,
      clearBtn
    ]);
    r2.appendChild(search);
    // AI search used to be a glyph inside the field, where it read as an
    // anonymous circle. It's a labelled toggle now — same feature, legible.
    r2.appendChild(el('button', {
      class: 'vcl-chip' + (ST.aiMode ? ' on' : ''), html: ICON.spark + 'Ask AI',
      title: 'Search in plain English, e.g. "tax documents from last year"',
      'aria-pressed': ST.aiMode ? 'true' : 'false',
      onclick: function () { ST.aiMode = !ST.aiMode; render(); setTimeout(function () { var q = $('vcl-q'); if (q) q.focus(); }, 30); }
    }));

    var seg = el('div', { class: 'vcl-seg' });
    [['list', ICON.list, 'List view'], ['grid', ICON.grid, 'Grid view'], ['compact', ICON.compact, 'Compact view']].forEach(function (v) {
      seg.appendChild(el('button', {
        class: S.view === v[0] ? 'on' : '', html: v[1], title: v[2], 'aria-label': v[2],
        onclick: function () { S.view = v[0]; vc().save(); render(); }
      }));
    });
    r2.appendChild(seg);

    // A native <select> can't be themed — its popup is drawn by the OS, which is
    // why it showed up as a white/blue list against everything else here.
    r2.appendChild(dropdown(
      [['name', 'Name'], ['modified', 'Modified'], ['created', 'Created'], ['size', 'Size'], ['type', 'Type']],
      S.sortKey, 'Sort by',
      function (v) { S.sortKey = v; vc().save(); render(); }
    ));
    r2.appendChild(el('button', {
      class: 'vcl-chip', text: S.sortDir === 'asc' ? '↑' : '↓',
      title: S.sortDir === 'asc' ? 'Ascending' : 'Descending', 'aria-label': 'Toggle sort direction',
      onclick: function () { S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc'; vc().save(); render(); }
    }));

    if (ST.provider) {
      var prov = vc().get(ST.provider);
      r2.appendChild(el('button', { class: 'vcl-chip', html: ICON.upload + 'Upload', onclick: pickUpload }));
      r2.appendChild(el('button', { class: 'vcl-chip', html: ICON.folderPlus + 'New folder', onclick: newFolder }));
      var openUrl = (prov.cfg && prov.cfg().openUrl) || '';
      if (openUrl) {
        r2.appendChild(el('a', {
          class: 'vcl-chip', href: openUrl, target: '_blank', rel: 'noopener',
          html: ICON.ext + 'Open ' + esc(prov.label), style: 'text-decoration:none;'
        }));
      }
    }
    bar.appendChild(r2);

    // Row 3 — breadcrumb + filters
    if (ST.pane === 'files' && ST.trail.length) {
      var cr = el('div', { class: 'vcl-crumbs' });
      cr.appendChild(el('button', { text: 'All clouds', onclick: goRoot }));
      ST.trail.forEach(function (t, i) {
        cr.appendChild(el('span', { class: 'sep', html: ICON.chev }));
        cr.appendChild(el('button', { text: t.name, onclick: function () { navCrumb(i); } }));
      });
      bar.appendChild(cr);
    }
    // Always present, filled or emptied by paintFilters(). If this row were
    // added/removed by render() the toolbar would rebuild on the first keystroke
    // — taking the focused search box with it.
    bar.appendChild(el('div', { class: 'vcl-row scrollx', id: 'vcl-filters' }));
    setTimeout(paintFilters, 0);
    return bar;
  }

  function filtersActive() {
    return !!(ST.query || ST.filter.kind || ST.filter.since || ST.filter.minSize || ST.filter.provider);
  }
  function paintFilters() {
    var row = $('vcl-filters');
    if (!row) return;
    if (ST.pane !== 'files' || !filtersActive()) { row.innerHTML = ''; return; }
    row.innerHTML = '';
    buildFilters(row);
  }

  function buildFilters(row) {
    function sel(label, key, opts) {
      return dropdown(opts, ST.filter[key], label, function (v) {
        ST.filter[key] = v; renderFilesOnly();
      }, true);
    }
    var d = 86400000;
    row.appendChild(sel('File type', 'kind', [['', 'Any type'], ['folder', 'Folders'], ['image', 'Images'], ['video', 'Video'], ['audio', 'Audio'], ['pdf', 'PDF'], ['doc', 'Documents'], ['text', 'Text'], ['archive', 'Archives'], ['other', 'Other']]));
    row.appendChild(sel('Modified', 'since', [['', 'Any time'], [Date.now() - d, 'Past day'], [Date.now() - 7 * d, 'Past week'], [Date.now() - 30 * d, 'Past month'], [Date.now() - 365 * d, 'Past year']]));
    row.appendChild(sel('Size', 'minSize', [[0, 'Any size'], [1048576, '> 1 MB'], [10485760, '> 10 MB'], [104857600, '> 100 MB']]));
    var provOpts = [['', 'All clouds']].concat(vc().connected().map(function (p) { return [p.id, p.label]; }));
    row.appendChild(sel('Cloud', 'provider', provOpts));
    row.appendChild(el('button', {
      class: 'vcl-chip', text: 'Clear',
      onclick: function () {
        ST.filter = { kind: '', since: '', minSize: 0, provider: '' };
        ST.query = ''; ST.aiAnswer = '';
        var q = $('vcl-q'); if (q) q.value = '';
        paintFilters(); loadFolder(ST.provider, ST.folder);
      }
    }));
    return row;
  }

  // Swap ONLY the file surface. Used by every path that changes what's listed
  // without changing the toolbar — search, filters, background refresh — so the
  // search box is never torn down while someone is typing into it.
  function renderFilesOnly() {
    var panel = $('warden-cloud-panel');
    if (!panel || panel.style.display === 'none') return;
    // A listing already in flight when the idle lock fires would otherwise land
    // as file rows on top of the unlock card.
    if (locked()) return;
    var host = panel.querySelector('.vcl-files');
    if (!host) { render(); return; }
    host.parentNode.replaceChild(buildFiles(vc().settings()), host);
    paintFilters();
    if (Object.keys(ST.sel).length) mountSelBar(); else unmountSelBar();
  }

  /* ── Storage dashboard ───────────────────────────────────────────────────*/
  var quotaCache = {};
  var QUOTA_TTL = 90 * 1000;
  function buildStores() {
    var wrap = el('div', { class: 'vcl-stores' });
    vc().connected().forEach(function (p) {
      var card = el('div', { class: 'vcl-store' });
      var pctEl = el('span', { class: 'pct', text: '…' });
      var fill = el('div', { class: 'vcl-fill', style: 'width:0%;background:' + p.accent });
      var sub = el('div', { class: 'sub', text: 'Reading storage…' });
      card.appendChild(el('div', { class: 'vcl-store-h' }, [
        el('span', { class: 'ic', html: p.icon, style: 'color:' + p.accent }),
        el('span', { class: 'nm', text: p.label }),
        pctEl
      ]));
      card.appendChild(el('div', { class: 'vcl-track' }, [fill]));
      card.appendChild(sub);

      // Breakdown is computed from what's loaded, not fetched — a full scan of
      // every file just to color a bar isn't worth the API budget.
      var mine = ST.entries.filter(function (e) { return e.provider === p.id && !e.folder; });
      if (mine.length) {
        var buckets = { image: 0, video: 0, doc: 0, other: 0 };
        var colors = { image: '#8fb3d9', video: '#c49bd4', doc: '#8D769A', other: '#7d7d86' };
        mine.forEach(function (e) {
          var k = vc().kindOf(e);
          var b = (k === 'image') ? 'image' : (k === 'video' || k === 'audio') ? 'video' : (k === 'doc' || k === 'pdf' || k === 'text') ? 'doc' : 'other';
          buckets[b] += e.size || 0;
        });
        var tot = buckets.image + buckets.video + buckets.doc + buckets.other;
        if (tot > 0) {
          var brk = el('div', { class: 'vcl-break' });
          var key = el('div', { class: 'vcl-break-key' });
          [['image', 'Images'], ['video', 'Media'], ['doc', 'Documents'], ['other', 'Other']].forEach(function (b) {
            if (!buckets[b[0]]) return;
            brk.appendChild(el('i', { style: 'flex:' + buckets[b[0]] + ';background:' + colors[b[0]] }));
            key.appendChild(el('span', { html: '<i style="background:' + colors[b[0]] + '"></i>' + esc(b[1]) + ' · ' + vc().fmtSize(buckets[b[0]]) }));
          });
          card.appendChild(brk); card.appendChild(key);
        }
      }
      wrap.appendChild(card);

      function paintQuota(q) {
        if (!q || !q.total) { pctEl.textContent = '—'; sub.textContent = q && q.used ? vc().fmtSize(q.used) + ' used' : 'Storage unavailable'; return; }
        var pct = Math.min(100, (q.used / q.total) * 100);
        pctEl.textContent = pct.toFixed(pct < 10 ? 1 : 0) + '%';
        fill.style.width = pct + '%';
        if (pct > 90) fill.style.background = 'var(--err)';
        sub.textContent = vc().fmtSize(q.used) + ' of ' + vc().fmtSize(q.total) + ' used · ' + vc().fmtSize(Math.max(0, q.total - q.used)) + ' free';
      }
      // Quota used to be re-fetched on EVERY render — two provider API calls per
      // repaint, and render() runs on almost every interaction. Cached with a TTL
      // and invalidated on a real change, so a browsing session costs a couple of
      // calls a minute instead of hundreds.
      var hit = quotaCache[p.id];
      if (hit) paintQuota(hit.q);
      if (!hit || Date.now() - hit.at > QUOTA_TTL) {
        p.quota().then(function (q) { quotaCache[p.id] = { q: q, at: Date.now() }; paintQuota(q); })
          .catch(function () { if (!hit) { pctEl.textContent = '—'; sub.textContent = 'Storage unavailable'; } });
      }
    });
    return wrap;
  }

  /* ── Folder tree ──────────────────────────────────────────────────────────*/
  var treeCache = {};    // "provider|folder" -> entries (folders only)
  function buildTree() {
    var box = el('div', { class: 'vcl-tree' });
    var p = vc().get(ST.provider);
    if (!p) return box;
    box.appendChild(treeNode({ id: p.rootId, name: p.label, folder: true, provider: p.id }, 0, []));
    return box;
  }
  // `ancestors` is the real path from the provider root down to (not including)
  // this node. The breadcrumb is rebuilt from it on click rather than appended
  // to, because the tree already knows the full path — deriving it from whatever
  // trail happened to be current left stale crumbs behind (open a folder, then
  // click the tree root: you'd get "All clouds › <that folder> › Google Drive").
  function treeNode(entry, depth, ancestors) {
    var key = entry.provider + '|' + entry.id;
    var open = !!ST.treeOpen[key];
    var wrap = el('div', {});
    var tw = el('span', { class: 'tw' + (open ? ' open' : ''), html: ICON.chev });
    var node = el('div', {
      class: 'vcl-tnode' + (ST.folder === entry.id ? ' on' : ''),
      onclick: function (e) {
        if (e.target.closest('.tw')) {
          ST.treeOpen[key] = !open;
          if (!open && !treeCache[key]) {
            vc().list(entry.provider, entry.id).then(function (list) {
              treeCache[key] = list.filter(function (x) { return x.folder; });
              render();
            }).catch(function () { treeCache[key] = []; render(); });
          }
          render(); return;
        }
        ST.trail = ancestors.concat([{ id: entry.id, name: entry.name, provider: entry.provider }]);
        navTo(entry.provider, entry.id, entry.name, false);
      }
    }, [tw, el('span', { html: ICON.folder, style: 'font-size:13px;color:var(--ac);display:flex' }), el('span', { class: 'nm', text: entry.name })]);
    // Folders in the tree are drop targets too.
    makeDropTarget(node, entry);
    wrap.appendChild(node);
    if (open) {
      var kids = treeCache[key];
      var kw = el('div', { class: 'vcl-tkids' });
      if (!kids) kw.appendChild(el('div', { class: 'vcl-tnode', text: 'Loading…', style: 'color:var(--txm)' }));
      else if (!kids.length) kw.appendChild(el('div', { class: 'vcl-tnode', text: 'No folders', style: 'color:var(--txm)' }));
      else {
        var below = ancestors.concat([{ id: entry.id, name: entry.name, provider: entry.provider }]);
        kids.forEach(function (k) { kw.appendChild(treeNode(k, depth + 1, below)); });
      }
      wrap.appendChild(kw);
    }
    return wrap;
  }

  /* ── File surface ─────────────────────────────────────────────────────────*/
  function buildFiles(S) {
    var host = el('div', { class: 'vcl-files' });
    if (ST.loading && !ST.entries.length) {
      var sk = el('div', { class: 'vcl-list' });
      for (var i = 0; i < 6; i++) sk.appendChild(el('div', { class: 'vcl-skel' }));
      host.appendChild(sk);
      return host;
    }
    var list = sortedEntries(filtered(ST.entries));
    if (!list.length) {
      host.appendChild(el('div', { class: 'vcl-empty' }, [
        el('div', { class: 'big', text: ST.query ? 'Nothing matched' : 'This folder is empty' }),
        el('div', { text: ST.query ? 'Try different words, or switch on AI search to ask in plain English.' : 'Drop files anywhere on this page to upload them here.' })
      ]));
      return host;
    }
    host.appendChild(S.view === 'grid' ? gridOf(list) : listOf(list, S.view === 'compact'));
    if (ST.loading) host.appendChild(el('div', { class: 'vcl-empty', text: 'Refreshing…', style: 'padding:14px' }));
    return host;
  }

  function listOf(list, compact) {
    var box = el('div', { class: 'vcl-list' + (compact ? ' vcl-comp' : '') });
    list.forEach(function (e) { box.appendChild(rowOf(e, compact)); });
    return box;
  }

  function rowOf(e, compact) {
    var k = vc().kindOf(e);
    var fav = vc().isFav(e.provider, e.id);
    var ic = el('div', { class: 'vcl-ic' + (e.folder ? ' folder' : ''), html: kindIcon(k) });
    if (e.thumb && !compact) {
      var img = new Image();
      img.src = e.thumb; img.alt = '';
      img.onload = function () { ic.innerHTML = ''; ic.appendChild(img); };
    }
    var sub = el('div', { class: 'vcl-sub' });
    if (!compact) {
      var prov = vc().get(e.provider);
      sub.appendChild(el('span', { text: prov ? prov.label : e.provider }));
      if (!e.folder) sub.appendChild(el('span', { text: vc().fmtSize(e.size) }));
      sub.appendChild(el('span', { text: vc().fmtDate(e.modified) }));
      if (e._why) sub.appendChild(el('span', { class: 'why', text: e._why }));
    }
    var meta = el('div', { class: 'vcl-meta' }, [el('div', { class: 'vcl-nm', text: e.name }), compact ? null : sub]);
    var act = el('div', { class: 'vcl-act' }, [
      compact ? el('span', { class: 'vcl-size', text: e.folder ? '—' : vc().fmtSize(e.size) }) : null,
      el('button', {
        class: 'vcl-ib' + (fav ? ' on' : ''), html: ICON.star, title: fav ? 'Remove from favorites' : 'Add to favorites',
        'aria-label': 'Favorite', onclick: function (ev) { ev.stopPropagation(); vc().toggleFav(e); render(); }
      }),
      el('button', {
        class: 'vcl-ib', html: ICON.more, title: 'More', 'aria-label': 'More actions',
        onclick: function (ev) { ev.stopPropagation(); openMenu(ev, e); }
      })
    ]);
    var row = el('div', {
      class: 'vcl-item' + (ST.sel[selKey(e)] ? ' sel' : ''),
      onclick: function (ev) {
        // Ctrl/Cmd or an existing selection turns clicks into multi-select —
        // otherwise a plain click opens, which is what people expect first.
        if (ev.metaKey || ev.ctrlKey || Object.keys(ST.sel).length) { toggleSel(e); return; }
        openEntry(e);
      }
    }, [ic, meta, act]);
    wireItem(row, e);
    return row;
  }

  function gridOf(list) {
    var box = el('div', { class: 'vcl-grid' });
    list.forEach(function (e) {
      var k = vc().kindOf(e);
      var thumb = el('div', { class: 'vcl-thumb' + (e.folder ? ' folder' : ''), html: kindIcon(k) });
      if (e.thumb) {
        var img = new Image(); img.src = e.thumb; img.alt = '';
        img.onload = function () { thumb.innerHTML = ''; thumb.appendChild(img); };
      }
      var card = el('div', {
        class: 'vcl-card' + (ST.sel[selKey(e)] ? ' sel' : ''),
        onclick: function (ev) {
          if (ev.metaKey || ev.ctrlKey || Object.keys(ST.sel).length) { toggleSel(e); return; }
          openEntry(e);
        }
      }, [
        thumb,
        vc().isFav(e.provider, e.id) ? el('div', { class: 'vcl-cfav', html: ICON.star }) : null,
        el('div', { class: 'vcl-cbody' }, [
          el('div', { class: 'vcl-nm', text: e.name }),
          el('div', { class: 'vcl-sub' }, [el('span', { text: e.folder ? 'Folder' : vc().fmtSize(e.size) })])
        ])
      ]);
      wireItem(card, e);
      box.appendChild(card);
    });
    return box;
  }

  function toggleSel(e) {
    var k = selKey(e);
    if (ST.sel[k]) delete ST.sel[k]; else ST.sel[k] = true;
    render();
  }

  /* ── Item wiring: context menu, long-press, drag ──────────────────────────*/
  function wireItem(node, e) {
    node.addEventListener('contextmenu', function (ev) { ev.preventDefault(); openMenu(ev, e); });

    // Long press = right click on touch. Cancelled by any real movement so it
    // never fires mid-scroll.
    var lpTimer = null, lpX = 0, lpY = 0;
    node.addEventListener('touchstart', function (ev) {
      var t = ev.touches[0]; lpX = t.clientX; lpY = t.clientY;
      lpTimer = setTimeout(function () {
        lpTimer = null;
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (er) {} }
        openMenu({ clientX: lpX, clientY: lpY, preventDefault: function () {} }, e);
      }, 460);
    }, { passive: true });
    node.addEventListener('touchmove', function (ev) {
      var t = ev.touches[0];
      if (Math.abs(t.clientX - lpX) > 9 || Math.abs(t.clientY - lpY) > 9) { clearTimeout(lpTimer); lpTimer = null; }
    }, { passive: true });
    ['touchend', 'touchcancel'].forEach(function (n) {
      node.addEventListener(n, function () { clearTimeout(lpTimer); lpTimer = null; }, { passive: true });
    });

    // Drag a file onto a folder to move it.
    node.setAttribute('draggable', 'true');
    node.addEventListener('dragstart', function (ev) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', selKey(e));
      node._dragEntry = e;
      window._vclDragging = e;
    });
    node.addEventListener('dragend', function () { window._vclDragging = null; });
    if (e.folder) makeDropTarget(node, e);
  }

  function makeDropTarget(node, folder) {
    node.addEventListener('dragover', function (ev) {
      var d = window._vclDragging;
      if (!d || d.id === folder.id) return;
      ev.preventDefault(); ev.dataTransfer.dropEffect = 'move';
      node.classList.add('dragover');
    });
    node.addEventListener('dragleave', function () { node.classList.remove('dragover'); });
    node.addEventListener('drop', function (ev) {
      node.classList.remove('dragover');
      var d = window._vclDragging;
      if (!d) return;
      ev.preventDefault(); ev.stopPropagation();
      window._vclDragging = null;
      if (d.provider !== folder.provider) {
        toast('Moving between clouds isn’t supported yet — download and re-upload.', true);
        return;
      }
      doMove(d, folder.id, folder.name);
    });
  }

  /* ── Context menu ─────────────────────────────────────────────────────────*/
  function openMenu(ev, e) {
    closeMenu();
    var p = vc().get(e.provider) || { caps: {} };
    var fav = vc().isFav(e.provider, e.id);
    var m = el('div', { class: 'vcl-menu', role: 'menu' });
    function item(label, icon, fn, opts) {
      opts = opts || {};
      m.appendChild(el('button', {
        html: icon + '<span>' + esc(label) + '</span>',
        class: opts.danger ? 'danger' : '',
        disabled: opts.disabled ? 'disabled' : null,
        onclick: function () { closeMenu(); if (!opts.disabled) fn(); }
      }));
    }
    item(e.folder ? 'Open' : 'Open / preview', ICON.folder, function () { openEntry(e); });
    if (!e.folder) item('Download', ICON.upload, function () { doDownload(e); });
    m.appendChild(el('div', { class: 'div' }));
    item('Rename', ICON.text, function () {
      promptBox('Rename', 'New name', e.name, 'Rename', function (v) { doRename(e, v); });
    });
    item('Move to…', ICON.folder, function () { openMovePicker([e]); }, { disabled: !p.caps.move });
    item(fav ? 'Remove favorite' : 'Add to favorites', ICON.star, function () { vc().toggleFav(e); render(); });
    m.appendChild(el('div', { class: 'div' }));
    item('Copy link', ICON.copy, function () { doShare(e, true); }, { disabled: !p.caps.share });
    item('Share…', ICON.ext, function () { doShare(e, false); }, { disabled: !p.caps.share });
    item('Properties', ICON.file, function () { openProps(e); });
    m.appendChild(el('div', { class: 'div' }));
    item('Delete', ICON.x, function () {
      confirmBox('Delete ' + (e.folder ? 'folder' : 'file'),
        '"' + e.name + '" moves to ' + ((p && p.label) || 'the cloud') + '’s trash. You can put it back from Warden’s Trash tab.',
        'Delete', function () { doDelete(e); }, true);
    }, { danger: true });

    document.body.appendChild(m);
    // Keep the menu on screen — near the right or bottom edge it flips rather
    // than overflowing, which on a phone would put items off the viewport.
    var r = m.getBoundingClientRect();
    var x = Math.min(ev.clientX, window.innerWidth - r.width - 8);
    var y = Math.min(ev.clientY, window.innerHeight - r.height - 8);
    m.style.left = Math.max(8, x) + 'px';
    m.style.top = Math.max(8, y) + 'px';
    setTimeout(function () {
      document.addEventListener('click', closeMenu, { once: true });
      document.addEventListener('scroll', closeMenu, { once: true, capture: true });
    }, 10);
  }
  function closeMenu() { document.querySelectorAll('.vcl-menu').forEach(function (m) { m.remove(); }); }

  // A bare menu at the pointer, for callers with no entry behind them (the
  // Upload button). Same chrome and same edge-flipping as the entry menu.
  function menuAt(ev, items) {
    closeMenu();
    var m = el('div', { class: 'vcl-menu', role: 'menu' });
    items.forEach(function (it) {
      m.appendChild(el('button', {
        html: (it.icon || '') + '<span>' + esc(it.label) + '</span>',
        onclick: function () { closeMenu(); it.fn(); }
      }));
    });
    document.body.appendChild(m);
    var r = m.getBoundingClientRect();
    // No pointer position (keyboard activation) — anchor under the button itself.
    var t = ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect ? ev.currentTarget.getBoundingClientRect() : null;
    var px = (ev && ev.clientX) || (t ? t.left : 20);
    var py = (ev && ev.clientY) || (t ? t.bottom + 4 : 20);
    m.style.left = Math.max(8, Math.min(px, window.innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(py, window.innerHeight - r.height - 8)) + 'px';
    setTimeout(function () {
      document.addEventListener('click', closeMenu, { once: true });
      document.addEventListener('scroll', closeMenu, { once: true, capture: true });
    }, 10);
  }

  /* ── Operations ───────────────────────────────────────────────────────────*/
  function openEntry(e) {
    if (e.folder) {
      ST.trail.push({ id: e.id, name: e.name, provider: e.provider });
      navTo(e.provider, e.id, e.name, false);
      return;
    }
    vc().touchRecent(e, 'opened');
    openPreview(e);
  }

  async function doRename(e, name) {
    try {
      await vc().op(e.provider, 'rename', [e.id, name], 'Renamed', e.name + ' → ' + name);
      toast('Renamed');
      loadFolder(ST.provider, ST.folder);
    } catch (err) { toast(vc().fmtErr(err), true); }
  }
  async function doDelete(e) {
    try {
      await vc().op(e.provider, 'remove', [e.id], 'Deleted', e.name);
      toast('Deleted');
      loadFolder(ST.provider, ST.folder);
    } catch (err) { toast(vc().fmtErr(err), true); }
  }
  async function doMove(e, toParent, toName) {
    try {
      await vc().op(e.provider, 'move', [e.id, toParent, e.parent], 'Moved', e.name + ' → ' + (toName || 'folder'));
      toast('Moved to ' + (toName || 'folder'));
      loadFolder(ST.provider, ST.folder);
    } catch (err) { toast(vc().fmtErr(err), true); }
  }
  async function doShare(e, copyOnly) {
    try {
      toast('Creating link…');
      var url = await vc().op(e.provider, 'shareLink', [e.id], 'Shared', e.name);
      try { await navigator.clipboard.writeText(url); } catch (er) {}
      if (copyOnly) { toast('Link copied'); return; }
      if (navigator.share) { try { await navigator.share({ title: e.name, url: url }); return; } catch (er) {} }
      modal('Share link', el('div', {}, [
        el('div', { class: 'vcl-fld' }, [el('label', { text: 'Anyone with this link can view' }), el('input', { type: 'text', value: url, readonly: 'readonly' })]),
        el('div', { style: 'font:400 11.5px/1.5 var(--sans);color:var(--txm)', text: 'Copied to your clipboard.' })
      ]), [el('button', { class: 'vcl-btn gold', text: 'Done', onclick: closeOverlays })]);
    } catch (err) { toast(vc().fmtErr(err), true); }
  }
  async function doDownload(e) {
    try {
      toast('Preparing download…');
      var url = await vc().get(e.provider).downloadUrl(e);
      var a = el('a', { href: url, download: e.name, target: '_blank', rel: 'noopener' });
      document.body.appendChild(a); a.click(); a.remove();
      if (url.indexOf('blob:') === 0) setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      vc().logActivity('Downloaded', e.provider, e.name);
      vc().touchRecent(e, 'downloaded');
    } catch (err) { toast(vc().fmtErr(err), true); }
  }
  function newFolder() {
    if (!ST.provider) { toast('Pick a cloud first', true); return; }
    promptBox('New folder', 'Folder name', '', 'Create', async function (name) {
      try {
        await vc().op(ST.provider, 'mkdir', [name, ST.folder], 'Created folder', name);
        toast('Folder created');
        treeCache = {};
        loadFolder(ST.provider, ST.folder);
      } catch (err) { toast(vc().fmtErr(err), true); }
    });
  }

  /* ── Move picker — a folder browser in a modal ────────────────────────────*/
  function openMovePicker(entries) {
    var pid = entries[0].provider;
    var p = vc().get(pid);
    var cur = { id: p.rootId, name: p.label };
    var stack = [cur];
    var listBox = el('div', { class: 'vcl-list', style: 'max-height:46vh;overflow:auto' });
    var crumbs = el('div', { class: 'vcl-crumbs', style: 'margin-bottom:10px' });

    function draw() {
      crumbs.innerHTML = '';
      stack.forEach(function (s, i) {
        if (i) crumbs.appendChild(el('span', { class: 'sep', html: ICON.chev }));
        crumbs.appendChild(el('button', { text: s.name, onclick: function () { stack = stack.slice(0, i + 1); load(); } }));
      });
    }
    function load() {
      draw();
      listBox.innerHTML = '';
      listBox.appendChild(el('div', { class: 'vcl-empty', text: 'Loading…', style: 'padding:20px' }));
      vc().list(pid, stack[stack.length - 1].id).then(function (all) {
        listBox.innerHTML = '';
        var folders = all.filter(function (f) {
          return f.folder && !entries.some(function (e) { return e.id === f.id; });   // can't move a folder into itself
        });
        if (!folders.length) { listBox.appendChild(el('div', { class: 'vcl-empty', text: 'No sub-folders here', style: 'padding:20px' })); return; }
        folders.forEach(function (f) {
          listBox.appendChild(el('div', {
            class: 'vcl-item',
            onclick: function () { stack.push({ id: f.id, name: f.name }); load(); }
          }, [
            el('div', { class: 'vcl-ic folder', html: ICON.folder }),
            el('div', { class: 'vcl-meta' }, [el('div', { class: 'vcl-nm', text: f.name })]),
            el('span', { class: 'vcl-ib', html: ICON.chev })
          ]));
        });
      }).catch(function (e) {
        listBox.innerHTML = '';
        listBox.appendChild(el('div', { class: 'vcl-err', text: vc().fmtErr(e) }));
      });
    }

    modal('Move ' + (entries.length > 1 ? entries.length + ' items' : '"' + entries[0].name + '"'),
      el('div', {}, [crumbs, listBox]), [
        el('button', { class: 'vcl-btn', text: 'Cancel', onclick: closeOverlays }),
        el('button', {
          class: 'vcl-btn gold', text: 'Move here',
          onclick: async function () {
            var dest = stack[stack.length - 1];
            closeOverlays();
            var ok = 0;
            for (var i = 0; i < entries.length; i++) {
              try { await vc().op(entries[i].provider, 'move', [entries[i].id, dest.id, entries[i].parent], 'Moved', entries[i].name); ok++; }
              catch (e) { toast(vc().fmtErr(e), true); }
            }
            if (ok) toast('Moved ' + ok + ' item' + (ok > 1 ? 's' : '') + ' to ' + dest.name);
            clearSel(); loadFolder(ST.provider, ST.folder);
          }
        })
      ]);
    load();
  }

  /* ── Preview ──────────────────────────────────────────────────────────────*/
  // Sheets export as CSV (first tab only) — rendered as a real table so a
  // spreadsheet still reads like one. Quoted fields can hold commas, newlines
  // and doubled quotes, so this walks the text instead of splitting it.
  function parseCsv(text) {
    var rows = [], row = [], v = '', quoted = false;
    text = text.replace(/\r\n?/g, '\n');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) {
        if (c !== '"') { v += c; continue; }
        if (text[i + 1] === '"') { v += '"'; i++; } else quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(v); v = ''; }
      else if (c === '\n') { row.push(v); rows.push(row); row = []; v = ''; }
      else v += c;
    }
    if (v !== '' || row.length) { row.push(v); rows.push(row); }
    return rows;
  }

  var SHEET_ROWS = 400, SHEET_COLS = 40;
  function sheetRow(tag, cells) {
    var tr = el('tr');
    cells.slice(0, SHEET_COLS).forEach(function (c) { tr.appendChild(el(tag, { text: c })); });
    return tr;
  }
  function sheetTable(csv) {
    var rows = parseCsv(csv).filter(function (r) { return r.some(function (c) { return c !== ''; }); });
    var wrap = el('div', { class: 'vcl-sheet' });
    if (!rows.length) {
      wrap.appendChild(el('div', { class: 'note', text: 'This sheet is empty.' }));
      return wrap;
    }
    var shown = rows.slice(0, SHEET_ROWS);
    var head = el('thead', null, [sheetRow('th', shown[0])]);
    var body = el('tbody', null, shown.slice(1).map(function (r) { return sheetRow('td', r); }));
    wrap.appendChild(el('table', null, [head, body]));
    var note = 'first sheet only · open in cloud for the full file';
    if (rows.length > SHEET_ROWS) note = (rows.length - SHEET_ROWS) + ' more rows · ' + note;
    wrap.appendChild(el('div', { class: 'note', text: note }));
    return wrap;
  }

  async function openPreview(e) {
    var k = vc().kindOf(e);
    var host = el('div', { class: 'vcl-prev', style: 'min-height:180px' }, [
      el('div', { class: 'vcl-empty', text: 'Loading preview…' })
    ]);
    var buttons = [
      el('button', { class: 'vcl-btn', text: 'Properties', onclick: function () { openProps(e, true); } }),
      el('button', { class: 'vcl-btn', text: 'Download', onclick: function () { doDownload(e); } }),
      el('button', { class: 'vcl-btn gold', text: 'Close', onclick: closeOverlays })
    ];
    if (e.webUrl) {
      buttons.unshift(el('a', { class: 'vcl-btn', href: e.webUrl, target: '_blank', rel: 'noopener', text: 'Open in cloud', style: 'text-decoration:none;display:inline-block' }));
    }
    modal(e.name, host, buttons, true);

    var prov = vc().get(e.provider);
    var inlineKinds = ['image', 'video', 'audio', 'pdf', 'text'];

    // Google-native docs have no byte stream at all. Drive's own viewer renders
    // them, but that iframe authenticates with Google's third-party cookies —
    // which mobile Brave blocks, so it put up a "Sign in to your Google Account"
    // wall even while Warden itself was signed in. Export through the API on our
    // OAuth token instead, and keep the viewer only as the fallback.
    if (/application\/vnd\.google-apps\./.test(e.mime || '')) {
      var native = (e.mime || '').split('.').pop();
      if (prov && prov.exportBlob) {
        try {
          if (native === 'spreadsheet') {
            var csv = await (await prov.exportBlob(e, 'text/csv')).text();
            host.innerHTML = '';
            host.appendChild(sheetTable(csv));
            return;
          }
          if (native === 'document') {
            var docHtml = await (await prov.exportBlob(e, 'text/html')).text();
            host.innerHTML = '';
            host.appendChild(el('iframe', { sandbox: '', srcdoc: docHtml, title: e.name }));
            return;
          }
          if (native === 'drawing') {
            host.innerHTML = '';
            host.appendChild(el('img', { src: URL.createObjectURL(await prov.exportBlob(e, 'image/png')), alt: e.name }));
            return;
          }
          // Slides only export as PDF, which a phone browser won't render in a
          // frame — there the honest answer is Drive itself, one tap away below.
          if (native === 'presentation') {
            if (!matchMedia('(pointer: coarse)').matches) {
              host.innerHTML = '';
              host.appendChild(el('iframe', { src: URL.createObjectURL(await prov.exportBlob(e, 'application/pdf')), title: e.name }));
              return;
            }
            host.innerHTML = '';
            host.appendChild(el('div', { class: 'vcl-empty' }, [
              el('div', { class: 'big', text: 'Open it in Google Drive' }),
              el('div', { text: 'Slides don’t preview inside a phone browser — use "Open in cloud" below.' })
            ]));
            return;
          }
        } catch (err) { /* fall through to Drive's viewer */ }
      }
      host.innerHTML = '';
      host.appendChild(el('iframe', { src: 'https://drive.google.com/file/d/' + e.id + '/preview', allow: 'autoplay', title: e.name }));
      return;
    }

    // Decode it ourselves when we can — it's faster and works offline-ish.
    if (inlineKinds.indexOf(k) >= 0) {
      try {
        var url = await prov.downloadUrl(e);
        host.innerHTML = '';
        if (k === 'image') host.appendChild(el('img', { src: url, alt: e.name }));
        else if (k === 'video') host.appendChild(el('video', { src: url, controls: 'controls', playsinline: 'playsinline' }));
        else if (k === 'audio') host.appendChild(el('audio', { src: url, controls: 'controls', style: 'width:100%;padding:20px' }));
        else if (k === 'pdf') host.appendChild(el('iframe', { src: url, title: e.name }));
        else {
          var txt = await (await fetch(url)).text();
          host.appendChild(el('pre', { text: txt.slice(0, 200000) }));
        }
        return;
      } catch (err) { /* fall through to the provider's viewer */ }
    }

    // Everything else: ask the provider for an embeddable viewer. Drive renders
    // Office docs, archives, EPUB and more; Dropbox routes Office files through
    // the Office web viewer. Only when neither can do it do we say so.
    try {
      var embed = prov.embedUrl ? await prov.embedUrl(e) : null;
      if (embed) {
        host.innerHTML = '';
        host.appendChild(el('iframe', { src: embed, allow: 'autoplay', title: e.name }));
        return;
      }
    } catch (err) { /* fall through to the notice */ }

    host.innerHTML = '';
    host.appendChild(el('div', { class: 'vcl-empty' }, [
      el('div', { class: 'big', text: 'Can’t preview this one' }),
      el('div', { text: vc().fmtSize(e.size) + (e.mime ? ' · ' + e.mime : '') + '. Download it, or open it in ' + ((prov && prov.label) || 'the cloud') + '.' })
    ]));
  }

  // `back` = reopen the preview this was launched from. modal() tears down every
  // overlay, so without it "Close" from Properties dropped you all the way to the
  // file list — losing the file you were looking at.
  function openProps(e, back) {
    var p = vc().get(e.provider);
    var rows = [
      ['Name', e.name],
      ['Kind', e.folder ? 'Folder' : (vc().kindOf(e).charAt(0).toUpperCase() + vc().kindOf(e).slice(1))],
      ['Size', e.folder ? '—' : vc().fmtSize(e.size)],
      ['Modified', e.modified ? new Date(e.modified).toLocaleString() : '—'],
      ['Created', e.created ? new Date(e.created).toLocaleString() : '—'],
      ['Cloud', p ? p.label : e.provider],
      ['MIME type', e.mime || '—'],
      ['ID', e.id]
    ];
    var tags = (vc().settings().tags || {})[e.provider + ':' + e.id];
    if (tags && tags.length) rows.push(['Tags', tags.join(', ')]);
    var body = el('div', {});
    rows.forEach(function (r) {
      body.appendChild(el('div', { class: 'vcl-prop' }, [
        el('div', { class: 'k', text: r[0] }), el('div', { class: 'v', text: String(r[1]) })
      ]));
    });
    var btns = [];
    if (back) btns.push(el('button', { class: 'vcl-btn', text: '← Back to file', onclick: function () { openPreview(e); } }));
    btns.push(el('button', { class: 'vcl-btn gold', text: 'Close', onclick: closeOverlays }));
    modal('Properties', body, btns);
  }

  /* ── Search ───────────────────────────────────────────────────────────────*/
  async function runSearch(force) {
    var q = ST.query.trim();
    if (!q) { ST.aiAnswer = ''; loadFolder(ST.provider, ST.folder); return; }

    if (ST.aiMode) {
      if (!force) return;
      ST.loading = true; ST.err = ''; renderFilesOnly();
      try {
        // Search the whole connected surface, not just the open folder — "where
        // is my resume" has no useful answer scoped to one directory.
        var pool = await gatherAll();
        var res = await vc().aiSearch(q, pool);
        ST.entries = res.entries; ST.aiAnswer = res.answer; ST.loading = false; render();
      } catch (e) { ST.loading = false; ST.err = vc().fmtErr(e); renderFilesOnly(); }
      return;
    }

    // Plain search: providers do it server-side so it reaches beyond what's loaded.
    // Every repaint here is renderFilesOnly() — a full render() would rebuild the
    // search box the user is still typing into.
    var seq = ++loadSeq;
    ST.loading = true; ST.err = ''; renderFilesOnly();
    try {
      var targets = ST.provider ? [vc().get(ST.provider)] : vc().connected();
      var lists = await Promise.all(targets.map(function (p) { return p.search(q).catch(function () { return []; }); }));
      if (seq !== loadSeq) return;
      ST.entries = [].concat.apply([], lists);
      ST.loading = false; renderFilesOnly();
    } catch (e) {
      if (seq !== loadSeq) return;
      ST.loading = false; ST.err = vc().fmtErr(e); renderFilesOnly();
    }
  }

  // Breadth-first crawl, hard-capped. An unbounded walk of a real Drive is
  // thousands of calls; 6 folders deep and 1200 entries is enough to answer
  // "where is X" without hammering the API or the rate limit.
  async function gatherAll() {
    var out = [], seen = {};
    var conn = vc().connected();
    for (var i = 0; i < conn.length; i++) {
      var p = conn[i];
      var frontier = [p.rootId], depth = 0;
      while (frontier.length && depth < 6 && out.length < 1200) {
        var next = [];
        var lists = await Promise.all(frontier.slice(0, 12).map(function (f) {
          return vc().list(p.id, f).catch(function () { return []; });
        }));
        lists.forEach(function (l) {
          l.forEach(function (e) {
            var k = e.provider + ':' + e.id;
            if (seen[k]) return;
            seen[k] = 1; out.push(e);
            if (e.folder) next.push(e.id);
          });
        });
        frontier = next; depth++;
      }
    }
    return out;
  }

  /* ── Panes: favorites / recent / activity / duplicates ───────────────────*/
  function buildPane(S) {
    if (ST.pane === 'trash') return buildTrashPane();
    var host = el('div', { class: 'vcl-files', style: 'margin-top:12px' });
    if (ST.pane === 'favorites') {
      var favs = S.favorites || [];
      host.appendChild(sectionHead('Favorites', favs.length));
      if (!favs.length) return host.appendChild(emptyNote('Nothing pinned yet', 'Star a file or folder to keep it here.')), host;
      var box = el('div', { class: 'vcl-list' });
      favs.forEach(function (f) {
        box.appendChild(el('div', {
          class: 'vcl-item',
          onclick: function () {
            var p = vc().get(f.provider); if (!p) return;
            if (f.folder) { ST.trail = [{ id: p.rootId, name: p.label, provider: p.id }, { id: f.id, name: f.name, provider: f.provider }]; navTo(f.provider, f.id, f.name, false); }
            else openPreview({ id: f.id, name: f.name, provider: f.provider, folder: false, mime: vc().guessMime(f.name), size: 0 });
          }
        }, [
          el('div', { class: 'vcl-ic' + (f.folder ? ' folder' : ''), html: f.folder ? ICON.folder : ICON.file }),
          el('div', { class: 'vcl-meta' }, [
            el('div', { class: 'vcl-nm', text: f.name }),
            el('div', { class: 'vcl-sub' }, [el('span', { text: (vc().get(f.provider) || {}).label || f.provider })])
          ]),
          el('button', {
            class: 'vcl-ib on', html: ICON.star, title: 'Remove favorite',
            onclick: function (ev) { ev.stopPropagation(); vc().toggleFav({ provider: f.provider, id: f.id, name: f.name, folder: f.folder }); render(); }
          })
        ]));
      });
      host.appendChild(box);
      return host;
    }

    if (ST.pane === 'recent') {
      var rec = S.recents || [];
      host.appendChild(sectionHead('Recent', rec.length));
      if (!rec.length) return host.appendChild(emptyNote('No recent files', 'Files you open, upload or download show up here.')), host;
      var rbox = el('div', { class: 'vcl-list' });
      rec.forEach(function (r) {
        rbox.appendChild(el('div', {
          class: 'vcl-item',
          onclick: function () { openPreview({ id: r.id, name: r.name, provider: r.provider, folder: false, mime: vc().guessMime(r.name), size: 0 }); }
        }, [
          el('div', { class: 'vcl-ic', html: kindIcon(vc().kindOf({ name: r.name, mime: vc().guessMime(r.name) })) }),
          el('div', { class: 'vcl-meta' }, [
            el('div', { class: 'vcl-nm', text: r.name }),
            el('div', { class: 'vcl-sub' }, [
              el('span', { text: (vc().get(r.provider) || {}).label || r.provider }),
              el('span', { text: r.how }), el('span', { text: vc().fmtDate(r.at) })
            ])
          ])
        ]));
      });
      host.appendChild(rbox);
      return host;
    }

    if (ST.pane === 'activity') {
      var act = S.activity || [];
      host.appendChild(sectionHead('Activity', act.length));
      var abox = el('div', { class: 'vcl-list', style: 'padding:4px 14px' });
      if (!act.length) return host.appendChild(emptyNote('Nothing yet', 'Uploads, moves and deletions are logged here.')), host;
      act.forEach(function (a) {
        abox.appendChild(el('div', { class: 'vcl-act-row' }, [
          el('span', { class: 'ic', html: (vc().get(a.provider) || { icon: ICON.file }).icon }),
          el('span', { class: 'tx', html: esc(a.action) + ' <b>' + esc(a.name) + '</b>' }),
          el('span', { class: 'at', text: vc().fmtDate(a.at) })
        ]));
      });
      host.appendChild(abox);
      host.appendChild(el('div', { style: 'margin-top:12px;display:flex;justify-content:flex-end' }, [
        el('button', {
          class: 'vcl-btn', text: 'Clear history',
          onclick: function () {
            confirmBox('Clear activity', 'This removes the log on every device. Your files aren’t touched.', 'Clear', function () {
              vc().settings().activity = []; vc().save(); render();
            }, true);
          }
        })
      ]));
      return host;
    }

    if (ST.pane === 'duplicates') {
      var groups = vc().findDuplicates(ST.entries);
      host.appendChild(sectionHead('Possible duplicates', groups.length));
      if (!groups.length) return host.appendChild(emptyNote('No duplicates found', 'Nothing here shares a name and size.')), host;
      groups.forEach(function (g) {
        host.appendChild(el('div', { class: 'vcl-sh' }, [el('span', { class: 't', text: g[0].name }), el('span', { class: 'ln' }), el('span', { class: 'ct', text: vc().fmtSize(g[0].size) })]));
        host.appendChild(listOf(g, false));
      });
      return host;
    }
    return host;
  }
  /* ── Trash ────────────────────────────────────────────────────────────────
   * Both clouds keep deleted files for a while; this surfaces them in one place
   * so recovery doesn't mean opening drive.google.com and dropbox.com. Restore
   * is universal; permanent deletion is Drive-only (see caps.purge). */
  var trashState = { loading: false, entries: [], err: '', progress: '', skipped: 0 };

  async function loadTrash() {
    trashState.loading = true; trashState.err = ''; trashState.progress = ''; trashState.skipped = 0;
    render();
    try {
      var provs = vc().connected().filter(function (p) { return p.caps && p.caps.trash; });
      var lists = await Promise.all(provs.map(function (p) {
        return p.listTrash(function (done, total, found) {
          // Verifying Dropbox tombstones takes a few seconds; without this the
          // pane just sits there looking broken.
          trashState.progress = 'Checking ' + p.label + ' — ' + done + '/' + total + ', ' + found + ' recoverable';
          var head = document.querySelector('#warden-cloud-panel .vcl-sh .ct');
          if (head) head.textContent = trashState.progress;
        }).catch(function (e) { console.warn('trash', p.id, e); return []; });
      }));
      trashState.scanned = 0;
      lists.forEach(function (l) {
        if (!l) return;
        trashState.scanned += l.scanned || 0;
        if (l.tombstones > l.scanned) trashState.skipped += l.tombstones - l.scanned;
      });
      trashState.entries = [].concat.apply([], lists);
      trashState.loading = false; trashState.progress = ''; render();
    } catch (e) {
      trashState.loading = false; trashState.progress = ''; trashState.err = vc().fmtErr(e); render();
    }
  }

  function buildTrashPane() {
    var host = el('div', { class: 'vcl-files', style: 'margin-top:12px' });
    var provs = vc().connected().filter(function (p) { return p.caps && p.caps.trash; });

    var head = el('div', { class: 'vcl-sh' }, [
      el('span', { class: 't', text: 'Trash' }), el('span', { class: 'ln' }),
      el('span', { class: 'ct', text: trashState.loading ? (trashState.progress || 'Loading…') : trashState.entries.length + ' recoverable' })
    ]);
    host.appendChild(head);

    var tools = el('div', { class: 'vcl-row', style: 'margin-bottom:10px' });
    tools.appendChild(el('button', { class: 'vcl-chip', html: ICON.restore + 'Refresh', onclick: loadTrash }));
    provs.forEach(function (p) {
      if (!p.caps.emptyTrash) return;
      tools.appendChild(el('button', {
        class: 'vcl-chip', html: ICON.trash + 'Empty ' + esc(p.label),
        style: 'color:var(--err);border-color:rgba(214,138,124,.3)',
        onclick: function () {
          confirmBox('Empty ' + p.label + ' trash',
            'Every file in ' + p.label + '’s trash is deleted permanently. This cannot be undone — not from Warden, and not from ' + p.label + '.',
            'Delete permanently', async function () {
              try { await p.emptyTrash(); vc().logActivity('Emptied trash', p.id, p.label); toast(p.label + ' trash emptied'); loadTrash(); }
              catch (e) { toast(vc().fmtErr(e), true); }
            }, true);
        }
      }));
    });
    host.appendChild(tools);

    if (trashState.err) { host.appendChild(el('div', { class: 'vcl-err', text: trashState.err })); return host; }
    if (trashState.loading) {
      var sk = el('div', { class: 'vcl-list' });
      for (var i = 0; i < 4; i++) sk.appendChild(el('div', { class: 'vcl-skel' }));
      host.appendChild(sk); return host;
    }
    if (!provs.length) { host.appendChild(emptyNote('No cloud connected', 'Connect Google Drive or Dropbox to see deleted files.')); return host; }
    if (!trashState.entries.length) { host.appendChild(emptyNote('Nothing to recover', 'Deleted files show up here while they can still be put back.')); return host; }

    var box = el('div', { class: 'vcl-list' });
    sortedEntries(trashState.entries).forEach(function (e) {
      var p = vc().get(e.provider) || { caps: {}, label: e.provider };
      var sub = el('div', { class: 'vcl-sub' }, [
        el('span', { text: p.label }),
        e.size ? el('span', { text: vc().fmtSize(e.size) }) : null,
        el('span', { text: e.deletedAt ? 'Deleted ' + vc().fmtDate(e.deletedAt) : 'Deleted' })
      ]);
      var act = el('div', { class: 'vcl-act' }, [
        el('button', {
          class: 'vcl-ib', html: ICON.restore, title: 'Put back', 'aria-label': 'Restore',
          onclick: async function (ev) {
            ev.stopPropagation();
            try {
              await p.restore(e.id);
              vc().logActivity('Restored', e.provider, e.name);
              vc().cacheClear();
              toast('"' + e.name + '" restored');
              loadTrash();
            } catch (er) { toast(vc().fmtErr(er), true); }
          }
        }),
        p.caps.purge ? el('button', {
          class: 'vcl-ib del', html: ICON.trash, title: 'Delete permanently', 'aria-label': 'Delete permanently',
          style: 'color:var(--err)',
          onclick: function (ev) {
            ev.stopPropagation();
            confirmBox('Delete permanently',
              '"' + e.name + '" will be gone for good. This cannot be undone.',
              'Delete permanently', async function () {
                try { await p.purge(e.id); vc().logActivity('Permanently deleted', e.provider, e.name); toast('Deleted permanently'); loadTrash(); }
                catch (er) { toast(vc().fmtErr(er), true); }
              }, true);
          }
        }) : null
      ]);
      box.appendChild(el('div', { class: 'vcl-item' }, [
        el('div', { class: 'vcl-ic', html: kindIcon(vc().kindOf(e)), style: 'opacity:.6' }),
        el('div', { class: 'vcl-meta' }, [el('div', { class: 'vcl-nm', text: e.name }), sub]),
        act
      ]));
    });
    host.appendChild(box);

    var notes = [];
    // Dropbox can't permanently delete from a personal account, so say why the
    // button isn't there rather than leaving it looking half-built.
    if (provs.some(function (p) { return !p.caps.purge; })) {
      notes.push('Dropbox clears its own trash after 30 days and has no permanent-delete API on personal accounts, so its files only offer Put back.');
    }
    if (trashState.skipped) {
      // Be precise about the three groups: listed (verified recoverable), checked
      // and found unrecoverable, and not checked at all. Blurring them would
      // imply files are gone when Warden simply hasn't looked at them.
      notes.push('Dropbox keeps a permanent record of every file ever deleted, including ones purged long ago. ' +
        'Warden checked ' + (trashState.scanned || 0).toLocaleString() + ' of those entries and lists only the ones Dropbox can still restore. ' +
        trashState.skipped.toLocaleString() + ' were not checked — press Refresh to scan again. ' +
        'Anything past Dropbox’s 30-day window is unrecoverable here and on dropbox.com alike.');
    }
    if (notes.length) {
      host.appendChild(el('div', {
        style: 'margin-top:12px;font:400 11px/1.65 var(--sans);color:var(--txm)',
        html: notes.map(esc).join('<br><br>')
      }));
    }
    return host;
  }

  function sectionHead(t, n) {
    return el('div', { class: 'vcl-sh' }, [
      el('span', { class: 't', text: t }), el('span', { class: 'ln' }),
      el('span', { class: 'ct', text: n + (n === 1 ? ' item' : ' items') })
    ]);
  }
  function emptyNote(big, sub) {
    return el('div', { class: 'vcl-empty' }, [el('div', { class: 'big', text: big }), el('div', { text: sub })]);
  }

  /* ── Bulk selection bar ───────────────────────────────────────────────────*/
  function mountSelBar() {
    unmountSelBar();
    var sel = selected();
    if (!sel.length) return;
    var bar = el('div', { class: 'vcl-selbar', id: 'vcl-selbar' }, [
      el('span', { class: 'ct', text: sel.length + ' selected' }),
      el('button', { class: 'vcl-chip', html: ICON.upload + 'Download', onclick: function () { sel.forEach(function (e) { if (!e.folder) doDownload(e); }); } }),
      el('button', { class: 'vcl-chip', html: ICON.folder + 'Move', onclick: function () { openMovePicker(sel); } }),
      el('button', { class: 'vcl-chip', html: ICON.star + 'Favorite', onclick: function () { sel.forEach(function (e) { if (!vc().isFav(e.provider, e.id)) vc().toggleFav(e); }); clearSel(); render(); } }),
      el('button', {
        class: 'vcl-chip', html: ICON.x + 'Delete', style: 'color:var(--err);border-color:rgba(214,138,124,.3)',
        onclick: function () {
          confirmBox('Delete ' + sel.length + ' items', 'They move to each cloud’s trash. You can put them back from the Trash tab.', 'Delete', async function () {
            for (var i = 0; i < sel.length; i++) {
              try { await vc().op(sel[i].provider, 'remove', [sel[i].id], 'Deleted', sel[i].name); } catch (e) {}
            }
            toast('Deleted ' + sel.length + ' items');
            clearSel(); loadFolder(ST.provider, ST.folder);
          }, true);
        }
      }),
      el('button', { class: 'vcl-ib', html: ICON.x, title: 'Clear selection', onclick: function () { clearSel(); render(); } })
    ]);
    document.body.appendChild(bar);
  }
  function unmountSelBar() { var b = $('vcl-selbar'); if (b) b.remove(); }

  /* ── Upload ───────────────────────────────────────────────────────────────*/
  // A browser file dialog offers files OR a folder, never both — `webkitdirectory`
  // switches the OS dialog into folder mode — so the button asks which.
  function pickUpload(ev) {
    if (!ST.provider) { toast('Pick a cloud first', true); return; }
    menuAt(ev, [
      { label: 'Files…', icon: ICON.file, fn: function () { pickInput(false); } },
      { label: 'Folder…', icon: ICON.folder, fn: function () { pickInput(true); } }
    ]);
  }
  function pickInput(dir) {
    var attrs = { type: 'file', multiple: 'multiple', style: 'display:none' };
    if (dir) { attrs.webkitdirectory = 'webkitdirectory'; attrs.directory = 'directory'; }
    var inp = el('input', attrs);
    document.body.appendChild(inp);
    inp.addEventListener('change', function () {
      queueFiles(inp.files);
      inp.remove();
    });
    inp.click();
  }

  /* Everything that can be uploaded is normalised to {file, path} — `path` being
   * the folder chain the file sat in, outermost first, empty for a loose file.
   * Drops arrive already expanded (see expandDrop); the folder picker hands back
   * files that carry their own webkitRelativePath ("Trust/2024/deed.pdf"). */
  function toUploadList(files) {
    return Array.prototype.map.call(files || [], function (f) {
      if (f && f.file) return f;
      var rel = String(f.webkitRelativePath || '').split('/');
      rel.pop();                                   // drop the file's own name
      return { file: f, path: rel.filter(Boolean) };
    }).filter(function (it) { return it && it.file; });
  }

  function queueFiles(files) {
    var items = toUploadList(files);
    if (!items.length) return;
    var target = ST.provider;
    if (!target) {
      var conn = vc().connected();
      if (conn.length === 1) target = conn[0].id;
      else { toast('Open a cloud folder first, then drop files there', true); return; }
    }
    var parent = ST.provider ? ST.folder : vc().get(target).rootId;
    // Detect same-name collisions before queueing rather than after — a silent
    // overwrite of a real file is the one outcome worth a prompt. Only loose
    // files can clash: anything inside a dropped folder lands in a folder we are
    // about to create or merge into, where the provider's own autorename applies.
    var clashes = [];
    items.forEach(function (it) {
      if (it.path.length) return;
      var hit = ST.entries.filter(function (e) { return !e.folder && e.name === it.file.name && e.provider === target; })[0];
      if (hit) clashes.push({ file: it.file, existing: hit });
    });
    if (clashes.length) { openConflict(clashes, items, target, parent); return; }
    queueAll(items, target, parent);
  }

  function queueAll(items, target, parent) {
    items.forEach(function (it) { vc().enqueue(it.file, target, parent, it.path); });
    var folders = items.filter(function (it) { return it.path.length; }).length;
    toast('Queued ' + items.length + ' file' + (items.length > 1 ? 's' : '') + (folders ? ' (folders included)' : ''));
    renderDock();
  }

  function openConflict(clashes, items, target, parent) {
    var body = el('div', {});
    body.appendChild(el('div', { style: 'font:400 13px/1.6 var(--sans);color:var(--txd);margin-bottom:12px', text: clashes.length + ' file' + (clashes.length > 1 ? 's' : '') + ' here already have these names.' }));
    clashes.forEach(function (c) {
      body.appendChild(el('div', { class: 'vcl-prop' }, [
        el('div', { class: 'k', text: 'Conflict' }),
        el('div', { class: 'v', html: esc(c.file.name) + '<div style="color:var(--txm);font-size:11.5px;margin-top:3px">Cloud: ' + esc(vc().fmtSize(c.existing.size)) + ' · ' + esc(vc().fmtDate(c.existing.modified)) + '<br>Yours: ' + esc(vc().fmtSize(c.file.size)) + ' · ' + esc(vc().fmtDate(c.file.lastModified)) + '</div>' })
      ]));
    });
    modal('Conflict detected', body, [
      el('button', { class: 'vcl-btn', text: 'Cancel', onclick: closeOverlays }),
      el('button', {
        class: 'vcl-btn', text: 'Keep cloud copy',
        onclick: function () {
          closeOverlays();
          var skip = {}; clashes.forEach(function (c) { skip[c.file.name] = 1; });
          // Only loose files were ever compared, so only loose files can be skipped.
          var keep = items.filter(function (it) { return it.path.length || !skip[it.file.name]; });
          if (!keep.length) { toast('Nothing to upload'); renderDock(); return; }
          queueAll(keep, target, parent);
        }
      }),
      el('button', {
        class: 'vcl-btn gold', text: 'Keep both',
        onclick: function () {
          closeOverlays();
          // Both providers autorename on collision, so "keep both" is simply
          // "upload everything" — neither file is ever overwritten.
          queueAll(items, target, parent);
        }
      })
    ]);
  }

  // The dock used to be dismissed by "clear finished", which left it pinned open
  // forever once anything failed — the X did nothing and there was no other way
  // to close it. Now X always closes; in-flight uploads keep running in the
  // background, and a newly queued file brings the dock back.
  var dockDismissed = false;
  window.addEventListener('warden-cloud-enqueued', function () { dockDismissed = false; });

  function renderDock() {
    var q = vc().queue();
    var dock = $('vcl-dock');
    // The queue emits with no user behind it, so a lock has to be checked here
    // too or a finishing upload would re-post the dock over the lock screen.
    if (!q.length || dockDismissed || locked()) { if (dock) dock.remove(); return; }
    if (!dock) { dock = el('div', { class: 'vcl-dock', id: 'vcl-dock' }); document.body.appendChild(dock); }
    var active = q.filter(function (i) { return i.status === 'uploading' || i.status === 'queued'; }).length;
    var failed = q.filter(function (i) { return i.status === 'error'; }).length;
    dock.innerHTML = '';
    dock.appendChild(el('div', { class: 'vcl-dock-h' }, [
      el('span', { class: 't', text: active ? 'Uploading ' + active + ' file' + (active > 1 ? 's' : '') : failed ? failed + ' upload' + (failed > 1 ? 's' : '') + ' failed' : 'Uploads' }),
      failed || q.length > active
        ? el('button', { class: 'vcl-link', text: 'Clear', title: 'Remove finished and failed', onclick: function () { vc().qClearDone(); renderDock(); } })
        : null,
      el('button', {
        class: 'vcl-ib', html: ICON.x, title: 'Close', 'aria-label': 'Close uploads',
        onclick: function () { dockDismissed = true; renderDock(); }
      })
    ]));
    var b = el('div', { class: 'vcl-dock-b' });
    q.slice().reverse().forEach(function (i) {
      var pct = i.size ? Math.round((i.loaded / i.size) * 100) : 0;
      var statusText = i.status === 'done' ? 'Done' : i.status === 'error' ? (i.error || 'Failed')
        : i.status === 'paused' ? 'Paused' : i.status === 'cancelled' ? 'Cancelled'
        : i.status === 'queued' ? 'Waiting' : pct + '%';
      var acts = el('span', { style: 'display:flex;gap:2px;flex:0 0 auto' });
      if (i.status === 'uploading') acts.appendChild(el('button', { class: 'vcl-ib', text: '❙❙', title: 'Pause', style: 'font-size:9px', onclick: function () { vc().qPause(i.key); renderDock(); } }));
      if (i.status === 'paused') acts.appendChild(el('button', { class: 'vcl-ib', text: '▶', title: 'Resume', style: 'font-size:10px', onclick: function () { vc().qResume(i.key); renderDock(); } }));
      if (i.status === 'error' || i.status === 'cancelled') acts.appendChild(el('button', { class: 'vcl-ib', text: '↻', title: 'Retry', style: 'font-size:12px', onclick: function () { vc().qRetry(i.key); renderDock(); } }));
      if (i.status === 'uploading' || i.status === 'queued' || i.status === 'paused') acts.appendChild(el('button', { class: 'vcl-ib', html: ICON.x, title: 'Cancel', onclick: function () { vc().qCancel(i.key); renderDock(); } }));
      b.appendChild(el('div', { class: 'vcl-up' }, [
        el('div', { class: 'vcl-up-t' }, [
          el('span', { class: 'nm', text: i.label || i.name, title: i.label || i.name }),
          el('span', { class: 'st' + (i.status === 'error' ? ' err' : i.status === 'done' ? ' ok' : ''), text: statusText }),
          acts
        ]),
        (i.status === 'uploading' || i.status === 'queued')
          ? el('div', { class: 'vcl-up-bar' }, [el('i', { style: 'width:' + pct + '%' })]) : null
      ]));
    });
    dock.appendChild(b);
  }

  /* ── Page-wide drag & drop ────────────────────────────────────────────────*/
  var dropDepth = 0;
  function wireDrop() {
    if (window._vclDropWired) return;
    window._vclDropWired = true;
    function isFileDrag(e) {
      return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
    }
    window.addEventListener('dragenter', function (e) {
      if (!isFileDrag(e) || !isVisible()) return;
      dropDepth++;
      if (!$('vcl-drop')) {
        document.body.appendChild(el('div', { class: 'vcl-drop', id: 'vcl-drop' }, [
          el('div', { class: 'in', html: ICON.upload + 'Drop to upload' })
        ]));
      }
    });
    window.addEventListener('dragover', function (e) { if (isFileDrag(e) && isVisible()) e.preventDefault(); });
    window.addEventListener('dragleave', function (e) {
      if (!isFileDrag(e)) return;
      dropDepth = Math.max(0, dropDepth - 1);
      if (!dropDepth) { var d = $('vcl-drop'); if (d) d.remove(); }
    });
    window.addEventListener('drop', function (e) {
      if (!isFileDrag(e) || !isVisible()) return;
      e.preventDefault();
      dropDepth = 0;
      var d = $('vcl-drop'); if (d) d.remove();
      // BOTH must be read synchronously: a DataTransfer is neutered the moment
      // this handler returns, so nothing below may await before they're captured.
      var loose = Array.prototype.slice.call(e.dataTransfer.files || []);
      var entries = dropEntries(e.dataTransfer);
      if (!entries.length) { queueFiles(loose); return; }
      toast('Reading dropped items…');
      expandEntries(entries).then(function (items) {
        if (items.length) queueFiles(items);
        else toast('Nothing to upload — those folders are empty', true);
      }).catch(function (err) {
        console.warn('[cloud] drop expand failed', err);
        queueFiles(loose);
      });
    });
  }

  /* ── Folder drops ─────────────────────────────────────────────────────────
   * A dropped folder shows up in dataTransfer.files as a single File that is not
   * a file at all: reading it throws, which XHR reports as the opaque "Upload
   * failed — network error". The entries API is the only way to see inside one,
   * so a drop is expanded into real files — each carrying the folder chain it
   * came from — before anything reaches the upload queue. */
  var DROP_MAX = 2000;
  function dropEntries(dt) {
    var items = dt && dt.items ? Array.prototype.slice.call(dt.items) : [];
    return items.map(function (it) {
      return (it.kind === 'file' && it.webkitGetAsEntry) ? it.webkitGetAsEntry() : null;
    }).filter(Boolean);
  }
  function entryFile(entry) {
    return new Promise(function (res, rej) { entry.file(res, rej); });
  }
  function readBatch(reader) {
    return new Promise(function (res, rej) { reader.readEntries(res, rej); });
  }
  async function walkEntry(entry, path, out) {
    if (!entry || out.length >= DROP_MAX) return;
    if (entry.isFile) {
      try { out.push({ file: await entryFile(entry), path: path }); }
      catch (e) { console.warn('[cloud] unreadable', entry.name, e); }
      return;
    }
    if (!entry.isDirectory) return;
    var reader = entry.createReader(), batch, next = path.concat(entry.name);
    // readEntries answers at most 100 at a time and signals the end with an
    // empty array — a single call silently truncates any folder bigger than that.
    do {
      batch = await readBatch(reader);
      for (var i = 0; i < batch.length; i++) {
        if (out.length >= DROP_MAX) return;
        await walkEntry(batch[i], next, out);
      }
    } while (batch.length);
  }
  async function expandEntries(entries) {
    var out = [];
    for (var i = 0; i < entries.length; i++) await walkEntry(entries[i], [], out);
    if (out.length >= DROP_MAX) toast('Only the first ' + DROP_MAX + ' files were queued', true);
    return out;
  }
  function isVisible() {
    if (locked()) return false;
    var p = $('warden-cloud-panel');
    return !!p && p.style.display !== 'none' && p.offsetParent !== null;
  }

  /* ── Lock gate ────────────────────────────────────────────────────────────
   * Cloud sits behind the SAME master password as Passwords, Payments, ID Docs
   * and Sensitive Info. It stores no decrypted warden material of its own, but it
   * is a live window onto every connected drive — file names, previews,
   * downloads, deletions and the accounts themselves — so an idle-locked warden
   * that left this tab open handed anyone at the keyboard the lot.
   *
   * warden-ui.js owns the one session; this only asks. It fails CLOSED: no
   * session yet means locked, never "assume fine".
   *
   * Not a confidentiality boundary for the data at rest — provider tokens and
   * Cloud settings live in localStorage exactly as before, unencrypted. This
   * gates the surface, the same as the other four tabs. */
  function locked() {
    try {
      var s = window.Warden && window.Warden.session && window.Warden.session();
      return !s || !s.isUnlocked();
    } catch (e) { return true; }
  }

  /* Called by warden-ui.js the moment the warden locks. The panel itself is blanked
   * there, but half of Cloud's chrome lives on <body> — menu, modals, preview,
   * selection bar, upload dock, drop overlay — and would otherwise stay on
   * screen above the lock card. In-flight uploads deliberately keep running: a
   * 30-minute idle lock must not throw away a half-sent file. They just stop
   * being visible until you unlock. */
  function lock() {
    closeMenu();
    closeOverlays();
    unmountSelBar();
    ['vcl-dock', 'vcl-drop'].forEach(function (id) { var n = $(id); if (n) n.remove(); });
    document.querySelectorAll('.vcl-toast, .vcl-ddp').forEach(function (n) { n.remove(); });
    // Leave nothing behind that describes what is in the cloud. Re-mounting
    // after unlock reloads from the provider, so this costs one listing.
    ST.entries = []; ST.sel = {}; ST.query = ''; ST.aiMode = false; ST.aiAnswer = '';
    ST.err = ''; ST.loading = false; ST.trail = []; ST.pane = 'files';
    ST.provider = null; ST.folder = null;
    ST.filter = { kind: '', since: '', minSize: 0, provider: '' };
    trashState.entries = []; trashState.err = ''; trashState.progress = ''; trashState.loading = false; trashState.skipped = 0;
    var panel = $('warden-cloud-panel');
    // The panel is warden-ui.js's to draw on now; drop our contents so a stale
    // listing can't flash between the lock and the next paint.
    if (panel && !panel.querySelector('.warden-lock')) panel.innerHTML = '';
  }

  /* ── Setup / connect ──────────────────────────────────────────────────────*/
  function setupEmpty() {
    return el('div', { class: 'vcl-empty', style: 'padding:56px 20px' }, [
      el('div', { class: 'big', text: 'Connect a cloud to get started' }),
      el('div', { style: 'max-width:440px;margin:0 auto 18px', text: 'Warden talks to Google Drive and Dropbox directly from this page. You’ll need a client ID from each — it takes a minute and only has to be done once.' }),
      el('button', { class: 'vcl-btn gold', html: ICON.cog + ' Open setup', onclick: openSetup, style: 'display:inline-flex;gap:7px;align-items:center' })
    ]);
  }
  function connectEmpty() {
    var wrap = el('div', { class: 'vcl-empty', style: 'padding:26px 20px' });
    wrap.appendChild(el('div', { class: 'big', text: 'Not connected on this device' }));
    wrap.appendChild(el('div', { style: 'margin-bottom:14px', text: 'Your settings synced across, but each device signs in to the cloud itself — tokens are never shared.' }));
    var row = el('div', { style: 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap' });
    vc().all().forEach(function (p) {
      if (!p.configured() || p.connected()) return;
      row.appendChild(el('button', { class: 'vcl-btn gold', html: p.icon + ' Connect ' + esc(p.label), style: 'display:inline-flex;gap:7px;align-items:center', onclick: function () { doConnect(p); } }));
    });
    wrap.appendChild(row);
    return wrap;
  }

  async function doConnect(p) {
    try {
      toast('Opening ' + p.label + '…');
      await p.connect();
      toast(p.label + ' connected');
      quotaCache = {}; treeCache = {};
      ST.trail = [{ id: p.rootId, name: p.label, provider: p.id }];
      navTo(p.id, p.rootId, p.label, false);
    } catch (e) { toast(vc().fmtErr(e), true); render(); }
  }

  function openSetup() {
    var S = vc().settings();
    var body = el('div', {});

    // Field refs are collected per provider rather than read back by index, so a
    // third provider registering doesn't silently shift what "Save" writes where.
    var fields = [];

    var origin = esc(location.origin);
    var redirect = esc(location.origin + location.pathname);

    vc().all().forEach(function (p) {
      var cfg = (p.cfg && p.cfg()) || {};
      var su = p.setup || { field: 'clientId', label: 'Client ID', placeholder: '', openPlaceholder: '', hint: function () { return ''; } };
      var idField = el('input', { type: 'text', value: cfg[su.field] || '', placeholder: su.placeholder });
      var urlField = el('input', { type: 'url', value: cfg.openUrl || '', placeholder: su.openPlaceholder });

      var live = p.connected();
      var stale = !!(p.needsReauth && p.needsReauth());
      var acct = (p.account && p.account()) || '';
      var status = live
        ? (stale ? 'Session expired — reconnect' : 'Connected' + (acct ? ' as ' + acct : ''))
        : p.configured() ? 'Not connected' : 'Not set up';
      body.appendChild(el('div', { class: 'vcl-set-h' }, [
        el('span', { class: 'ic', html: p.icon, style: 'color:' + p.accent }),
        el('span', { class: 'nm', text: p.label }),
        el('span', { class: 'st' + (live && !stale ? ' on' : '') }, [
          el('i', {}), el('span', { text: status })
        ])
      ]));
      body.appendChild(el('div', { class: 'vcl-fld' }, [el('label', { text: su.label }), idField]));
      body.appendChild(el('div', { class: 'vcl-fld' }, [el('label', { text: 'Open link' }), urlField]));

      // Reconnecting repeatedly is the symptom of a missing redirect URI, and it
      // looks identical to an ordinary expired session — so when background
      // renewal has never once worked on this device, say which one it is
      // instead of letting the user press Reconnect every hour forever.
      if (live && p.renewalWorks && !p.renewalWorks() && p.redirectUri) {
        body.appendChild(el('div', {
          class: 'vcl-help',
          html: 'Background renewal hasn’t worked on this device yet, so the connection needs a manual Reconnect about once an hour. ' +
            'Add <code>' + esc(p.redirectUri()) + '</code> under <b>Authorized redirect URIs</b> on this OAuth client to fix it.'
        }));
      }

      // Instructions are collapsed by default. Once you're connected they're
      // pure clutter — but a new device or a second person setting this up from
      // scratch still needs them, so they stay one click away rather than gone.
      var help = el('div', { class: 'vcl-help', style: 'display:none' , html: su.hint(origin, redirect) });
      var helpBtn = el('button', {
        class: 'vcl-link', text: 'Setup help',
        onclick: function () {
          var open = help.style.display !== 'none';
          help.style.display = open ? 'none' : '';
          helpBtn.textContent = open ? 'Setup help' : 'Hide help';
        }
      });

      // One writer for both Save and Connect — they must never disagree.
      function commit() {
        var patch = { openUrl: urlField.value.trim() };
        patch[su.field] = idField.value.trim();
        vc().setCfg(p.id, patch);
      }
      fields.push(commit);

      var actions = el('div', { class: 'vcl-set-act' });
      actions.appendChild(el('button', {
        class: 'vcl-btn gold sm', text: live ? 'Reconnect' : 'Connect',
        onclick: function () { commit(); closeOverlays(); doConnect(p); }
      }));
      if (live) {
        actions.appendChild(el('button', {
          class: 'vcl-btn danger sm', text: 'Disconnect',
          onclick: function () { p.disconnect(); toast(p.label + ' disconnected'); closeOverlays(); render(); }
        }));
      }
      actions.appendChild(el('span', { style: 'flex:1' }));
      actions.appendChild(helpBtn);
      body.appendChild(actions);
      body.appendChild(help);
    });

    modal('Cloud setup', body, [
      el('button', { class: 'vcl-btn', text: 'Close', onclick: closeOverlays }),
      el('button', {
        class: 'vcl-btn gold', text: 'Save',
        onclick: function () {
          fields.forEach(function (commit) { commit(); });
          closeOverlays(); toast('Saved'); render();
        }
      })
    ], true);
  }

  /* ── Boot ─────────────────────────────────────────────────────────────────*/
  var booted = false;
  function mount() {
    // warden-ui.js only calls this once the warden is unlocked; the guard is here
    // so a future caller can't mount Cloud behind the lock screen by accident.
    if (locked()) return;
    injectStyles();
    wireDrop();
    if (!booted) {
      booted = true;
      vc().load().then(function () { render(); });
      vc().onChange(function () { if (isVisible()) render(); });
      vc().onQueue(function () { renderDock(); });
      // Any mutation anywhere — upload finishing, rename, delete, folder created,
      // a drag-drop move — re-lists the folder on screen. Previously the event
      // only cleared caches, so an upload landed in the cloud but the list you
      // were staring at kept showing the old contents until you left the tab and
      // came back.
      window.addEventListener('warden-cloud-changed', function (e) {
        quotaCache = {}; treeCache = {};
        if (!isVisible() || ST.pane !== 'files') return;
        var d = (e && e.detail) || {};
        // Only reload when the change touches what's actually displayed.
        var mine = !ST.provider || !d.provider || d.provider === ST.provider;
        if (mine) refreshCurrent();
      });

      // Changes made on ANOTHER device (or in drive.google.com / dropbox.com
      // directly) can't push to us — neither provider offers a browser-reachable
      // change feed. A light poll while the tab is actually visible is the honest
      // approximation: it stops entirely when the tab is hidden, so it costs
      // nothing in the background.
      setInterval(function () {
        if (!isVisible() || document.hidden) return;
        if (ST.pane !== 'files' || ST.query || ST.loading) return;
        if (document.querySelector('.vcl-ov') || document.querySelector('.vcl-menu')) return;  // don't yank a modal open
        if (Object.keys(ST.sel).length) return;                                                // nor an active selection
        refreshCurrent(true);
      }, POLL_MS);

      // A session lapsing is the one state change that arrives with no user
      // action behind it — repaint so the chip stops claiming to be live.
      window.addEventListener('warden-cloud-auth', function () { if (isVisible()) render(); });

      // Coming back to the tab is the moment a stale list is most obvious.
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && isVisible() && ST.pane === 'files') refreshCurrent(true);
      });
      window.addEventListener('focus', function () {
        if (isVisible() && ST.pane === 'files') refreshCurrent(true);
      });
      // Esc closes whatever is on top, innermost first.
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (document.querySelector('.vcl-menu')) { closeMenu(); return; }
        if (document.querySelector('.vcl-ov')) { closeOverlays(); return; }
        if (Object.keys(ST.sel).length) { clearSel(); render(); }
      });
    }
    if (!ST.entries.length && !ST.loading) loadFolder(ST.provider, ST.folder);
    render();
  }

  window.WardenCloudUI = { mount: mount, render: render, lock: lock, locked: locked, state: ST };
})();
