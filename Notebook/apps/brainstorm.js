/* Veda's side of Notebook (key bj; Brainstorm Journal in the code) as an app.
   Loaded by Notebook.mount({ profile: 'veda' }), which writes this script in
   where the host called it, while the page parses. It builds #bj-root right
   before its own <script> tag, then runs the app. Its Firestore layer is
   core/fb.js. Under another key (an instance) notebook.js rewrites this source
   (rewriteBj) and gives it a store made from fb.js's @nb-store template. */
(function () {
var me = document.currentScript;
var html = `
<div id="bj-root" data-hoverfx="studyos">
<div id="bj-nav-header" class="veda-hdr-outer">
  <div class="veda-hdr-inner">
  <div class="veda-hdr-left">
    <div style="font-family:'Playfair Display',serif;font-size:22px;font-weight:900;color:#8D769A;letter-spacing:1px;text-transform:uppercase;line-height:1;"><span class="a1-app-ic" aria-hidden="true" style="display:inline-block;width:1em;height:1em;margin-right:.4em;vertical-align:-.15em;color:#8D769A;line-height:0"><svg viewBox="14 14 68 68" fill="none" stroke="currentColor" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%;display:block"><path d="M30 20h32a6 6 0 0 1 6 6v44a6 6 0 0 1-6 6H30Z"/><path d="M30 20a6 6 0 0 0-6 6v44a6 6 0 0 0 6 6"/><path d="M40 36h16"/><path d="M40 48h16"/></svg></span>V's Notebook</div>
  </div>
  <div class="veda-hdr-right">
    <div class="veda-hbtns">
      <button onclick="window._vedaNav&&window._vedaNav('taskhub')" onmouseenter="this.style.borderColor='#8D769A'" onmouseleave="this.style.borderColor='#4A4B51'" style="background:transparent;color:#8D769A;border:1px solid #4A4B51;border-radius:5px;padding:0 10px;height:28px;box-sizing:border-box;display:inline-flex;align-items:center;font-size:10px;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:1px;transition:all .15s;">TaskHub</button>
      <button onclick="window._vedaNav&&window._vedaNav('gita')" onmouseenter="this.style.borderColor='#8D769A'" onmouseleave="this.style.borderColor='#4A4B51'" style="background:transparent;color:#8D769A;border:1px solid #4A4B51;border-radius:5px;padding:0 10px;height:28px;box-sizing:border-box;display:inline-flex;align-items:center;font-size:10px;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:1px;transition:all .15s;">Gita</button>
      <button style="background:#8D769A;color:#1B1C1E;border:1px solid #8D769A;border-radius:5px;padding:0 10px;height:28px;box-sizing:border-box;display:inline-flex;align-items:center;font-size:10px;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:1px;">Notebook</button>
      <button id="al-btn-veda_journal" onclick="window.alManage&&window.alManage('veda_journal')" title="App Lock" style="background:transparent;border:1px solid rgba(141,118,154,0.45);border-radius:5px;padding:0 8px;height:28px;box-sizing:border-box;display:inline-flex;align-items:center;font-size:13px;cursor:pointer;transition:all .15s;color:#8D769A;flex-shrink:0;touch-action:manipulation;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg></button>
      <button onclick="window._profileGoSelect&&window._profileGoSelect()" onmouseenter="this.style.borderColor='#8D769A'" onmouseleave="this.style.borderColor='#4A4B51'" style="background:transparent;color:#8D769A;border:1px solid #4A4B51;border-radius:5px;padding:0 10px;height:28px;box-sizing:border-box;display:inline-flex;align-items:center;font-size:17px;line-height:1;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:0;transition:all .15s;">✦</button>
    </div>
    <div class="veda-hbtns" style="padding-top:4px;">
    </div>
  </div>
  </div>
</div>
<div id="bj-body">
<div id="bj-sidebar-backdrop"></div>
<!-- SIDEBAR -->
<div id="bj-sidebar">
  <div id="bj-sidebar-header" style="justify-content:flex-end;align-items:center;">
  </div>
  <button id="bj-new-entry-btn">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    New Entry
  </button>
  <div class="search-wrap">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input id="bj-search-box" type="text" placeholder="Search entries…" />
    <button type="button" class="search-clear" id="bj-search-clear" title="Clear search" aria-label="Clear search" data-noglow hidden><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  </div>
  <div id="bj-entries-list"></div>
</div>

<!-- MAIN -->
<div id="bj-main">
  <!-- Mobile header: lives inside main so it doesn't affect root flex layout -->
  <div id="bj-mobile-header">
    <button id="bj-hamburger" style="background:transparent;border:none;cursor:pointer;padding:8px;color:var(--purple);flex-shrink:0;touch-action:manipulation;" aria-label="Open sidebar">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <input id="bj-mobile-title" type="text" placeholder="Untitled entry…" style="flex:1;background:none;border:none;outline:none;font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:var(--text);min-width:0;padding:0 4px;" />
    <!-- The phone's sync word: top of the screen, beside the title (it was a
         small chip floating over the bottom bar). Same states as the desktop pill. -->
    <span id="bj-bb-saved" class="nb-msync" role="status" aria-live="polite"></span>
    <button id="bj-mobile-lock-btn" style="display:none;background:transparent;border:none;cursor:pointer;padding:6px 8px;flex-shrink:0;touch-action:manipulation;font-size:18px;line-height:0;display:inline-flex;align-items:center;" aria-label="Lock entry"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg></button>
  </div>
  <div id="bj-toolbar" data-sb-strip>
    <button id="bj-fullscreen-btn" title="Toggle sidebar">
      <svg id="bj-fs-icon-show" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
      <svg id="bj-fs-icon-hide" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="9" x2="9" y2="9" opacity="0.5"/><line x1="15" y1="12" x2="9" y2="12" opacity="0.5"/><line x1="15" y1="15" x2="9" y2="15" opacity="0.5"/></svg>
    </button>
    <div class="toolbar-sep"></div>
    <input id="bj-entry-title-input" type="text" placeholder="Untitled entry…" />
    <!-- The sync word sits in a fixed slot beside the title, so "Syncing…" /
         "Synced" / "Sync failed" never shift the controls on its right. -->
    <span id="bj-sync-pill" class="bj-sync-pill bj-sync-idle" role="status" aria-live="polite">
      <span class="bj-sync-dot"></span>
      <span id="bj-sync-text">Synced</span>
    </span>
    <div class="toolbar-sep"></div>
    <div class="mode-toggle-wrap">
      <span class="mode-toggle-label" id="bj-mode-label">VIEW</span>
      <label class="mode-toggle" title="Toggle Edit / View mode">
        <input type="checkbox" id="bj-btn-edit" data-native />
        <div class="toggle-track"></div>
        <div class="toggle-knob"></div>
      </label>
    </div>
    <div class="toolbar-sep"></div>
    <button class="tb-btn" id="bj-btn-export-pdf" style="color:var(--purple);border-color:rgba(141,118,154,0.3);">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      Export PDF
    </button>
    <div class="toolbar-sep"></div>
    <button class="tb-btn lock-btn" id="bj-btn-lock" style="display:none;" aria-label="Lock this entry">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.75-1.4"/></svg>
    </button>
  </div>

  <div id="bj-content-area">
    <!-- A locked entry's editor stays behind this until Guardian unlocks it. -->
    <div id="bj-locked-pane" style="display:none;">
      <div class="tl-pane-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
      <div class="tl-pane-title">Locked entry</div>
      <button class="tl-btn" type="button">Unlock</button>
    </div>

    <div id="bj-empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      <h2>No Entry Selected</h2>
      <p>Create a new entry to start brainstorming, or select one from the sidebar.</p>
      <span class="empty-hint">Click "New Entry" to get started</span>
    </div>

    <!-- PAGE -->
    <div id="bj-page-area">
      <div class="bj-drop-zone" id="bj-page-drop-zone"><div class="bj-drop-label"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>Drop files here</div></div>
      <div class="docx-toolbar" id="bj-page-toolbar">
        <!-- Block format -->
        <select class="pt-select docx-r1" id="bj-pt-block">
          <option value="p">Paragraph</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="pre">Code Block</option>
          <option value="blockquote">Quote</option>
        </select>
        <div class="pt-sep"></div>
        <!-- Inline formatting -->
        <!-- Font size -->
        <select class="pt-select docx-r1" id="bj-pt-fontsize" title="Font size" style="width:46px;padding:3px 2px;">
          <option value="">—</option>
          <option value="10">10</option>
          <option value="12">12</option>
          <option value="14">14</option>
          <option value="16">16</option>
          <option value="18">18</option>
          <option value="20">20</option>
          <option value="24">24</option>
          <option value="28">28</option>
          <option value="32">32</option>
          <option value="36">36</option>
          <option value="48">48</option>
          <option value="64">64</option>
        </select>
        <div class="pt-sep"></div>
        <button class="pt-btn docx-r1" id="bj-pt-bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button class="pt-btn docx-r1" id="bj-pt-italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button class="pt-btn docx-r1" id="bj-pt-underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <button class="pt-btn docx-r2" id="bj-pt-strike" title="Strikethrough"><s>S</s></button>
        <button class="pt-btn docx-r2" id="bj-pt-code" title="Inline code">&lt;/&gt;</button>
        <div class="pt-sep"></div>
        <!-- Color -->
        <input type="color" class="docx-r1" id="bj-page-color-pick" data-native value="#ECECEE" title="Text color">
        <div class="pt-sep"></div>
        <!-- Lists -->
        <button class="pt-btn docx-r1" id="bj-pt-ul" title="Bullet list">&#8226;&#8212;</button>
        <button class="pt-btn docx-r1" id="bj-pt-ol" title="Numbered list">1.</button>
        <div class="pt-sep"></div>
        <!-- Alignment -->
        <button class="pt-btn docx-r2" id="bj-pt-alignL" title="Align left" aria-label="Align left"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h13"/></svg></button>
        <button class="pt-btn docx-r2" id="bj-pt-alignC" title="Center" aria-label="Center"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M7 12h10"/><path d="M5 18h14"/></svg></button>
        <button class="pt-btn docx-r2" id="bj-pt-alignR" title="Align right" aria-label="Align right"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M10 12h10"/><path d="M7 18h13"/></svg></button>
        <div class="pt-sep"></div>
        <!-- Insert -->
        <button class="pt-btn docx-r2" id="bj-pt-link" title="Insert link" aria-label="Insert link"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg></button>
        <button class="pt-btn docx-r2" id="bj-pt-hr" title="Divider">&#8213;</button>
        <button class="pt-btn docx-r2" id="bj-pt-table" title="Insert table" aria-label="Insert table"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M3 15h18"/><path d="M9 10v10"/><path d="M15 10v10"/></svg></button>
        <button class="pt-btn" id="bj-pt-md" title="Render Markdown — convert raw Markdown into formatted text">Render Markdown</button>
        <button class="pt-btn docx-r1" id="bj-page-img-btn" title="Insert image / attach file" aria-label="Insert image / attach file">
          <svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"/><circle cx="12" cy="14" r="3.5"/></svg>
          <input type="file" id="bj-page-img-file" accept="*/*" multiple>
        </button>
        <div class="pt-sep"></div>
        <!-- Highlight colors -->
        <div class="pt-hl-wrap docx-r1" id="bj-pt-hl-wrap" title="Highlight text">
          <button class="pt-btn pt-hl-trigger" id="bj-pt-hl-trigger" title="Highlight">
            <span class="pt-hl-icon" id="bj-pt-hl-icon"></span><span class="bj-pt-caret" aria-hidden="true"></span>
          </button>
          <div class="pt-hl-palette" id="bj-pt-hl-palette">
            <button class="pt-hl-swatch" data-color="#FFE066" style="background:#FFE066;" title="Yellow"></button>
            <button class="pt-hl-swatch" data-color="#A8F0B0" style="background:#A8F0B0;" title="Green"></button>
            <button class="pt-hl-swatch" data-color="#A8D8FF" style="background:#A8D8FF;" title="Blue"></button>
            <button class="pt-hl-swatch" data-color="#FFB3C6" style="background:#FFB3C6;" title="Pink"></button>
            <button class="pt-hl-swatch" data-color="#F9C784" style="background:#F9C784;" title="Orange"></button>
            <button class="pt-hl-swatch" data-color="#D4B0FF" style="background:#D4B0FF;" title="Purple"></button>
            <button class="pt-hl-swatch" data-color="none" style="background:transparent;border:1.5px solid var(--border);color:var(--red);font-size:11px;font-weight:700;" title="Remove highlight" aria-label="Remove highlight"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
          </div>
        </div>
        <div style="flex:1"></div>
        <!-- Clear -->
        <button class="pt-btn" id="bj-pt-clear" title="Clear all content" aria-label="Clear all content" style="color:var(--red);"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>
      <div id="bj-page-editor-wrap">
        <div id="bj-page-editor" contenteditable="false"></div>
      </div>
    </div>
  </div>
</div>

<!-- TEMPLATE MODAL -->
<div id="bj-template-modal">
  <div id="bj-template-panel">
    <div class="modal-header">
      <h2>Choose a Template</h2>
      <button class="modal-close" id="bj-close-modal" title="Close" aria-label="Close"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
    </div>
    <p>Pick a format for this entry</p>
    <div class="template-grid">
      <div class="template-card" data-template="page">
        <div class="template-card-icon"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg></div>
        <h3>Page</h3>
        <p>Rich document: text, images, lists, tables, headings.</p>
      </div>
    </div>
  </div>
</div>
</div><!-- end bj-body -->
<div id="bj-bottom-bar" style="display:none;">
  <button id="bj-bb-edit" style="flex:1;background:transparent;color:var(--text2);border:1px solid var(--border2);border-radius:5px;padding:7px 0;font-size:10px;font-weight:700;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:1px;cursor:pointer;touch-action:manipulation;"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg><span>Edit</span></button>
  <button id="bj-bb-new" style="flex:2;background:var(--purple);color:#fff;border:none;border-radius:5px;padding:7px 0;font-size:10px;font-weight:700;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:1px;cursor:pointer;touch-action:manipulation;">+ New</button>
</div>
</div>
`;
if (me && me.parentNode) me.insertAdjacentHTML('beforebegin', html);
else document.body.insertAdjacentHTML('beforeend', html);
})();

(function(){
'use strict';
const STORAGE_KEY = 'brainstorm_journal_v3';
// ── The host's mount config (Notebook.mount; docs/Notebook/README.md) ──
// The same contract as MyJournal's (its _tjCfg):
// features: ourjournal / locks (both on unless a host turns them off).
// pinned:   [{ id, title, html }] pages kept first in the list, never trashed,
//           dragged or locked; created empty (updated 0, so the cloud copy wins)
//           when the store does not have them yet.
// onSave(entry) after the cloud confirms a save; onReady() after the first load.
const _bjCfg = (window.Notebook && window.Notebook.mounts && window.Notebook.mounts.bj) || {};
const _bjFeat = Object.assign({ ourjournal: true, locks: true }, _bjCfg.features || {});
const _bjPinned = Array.isArray(_bjCfg.pinned) ? _bjCfg.pinned : [];
function _bjIsPinned(id) { return _bjPinned.some(function (p) { return p.id === id; }); }
// For the host (e.g. in onReady): the entries as they stand, live and trashed.
_bjCfg.entries = function () { return state.entries; };
// folder: a host that files its pages in groups (StudyOS: one per Notes
// module) shows one group at a time. A page carries the folder it was made in
// (entry.folder); the list, its search and tags, the Trash and New Entry all
// work inside the folder on screen. null (the default) is every page, as
// before. Notebook.folder(key, id) switches it. Pinned pages show in every
// folder; OurJournal has none.
let _bjFolder = (_bjCfg.folder == null || _bjCfg.folder === '') ? null : String(_bjCfg.folder);
const _bjFolderActive = {};   // folder -> the page last open in it (this session)
function _bjInFolder(e) { return _bjFolder === null || _bjIsOJ() || !e || e.folder === _bjFolder || _bjIsPinned(e.id); }
// The first live page on screen, for when the open one goes away.
function _bjFirstLive() { return (state.entries.find(function (e) { return !e.trashed && _bjInFolder(e); }) || {}).id || null; }
// Make every pinned page exist, out of the trash, at the top in its given order.
function _bjPinFirst() {
  if (!_bjPinned.length || _bjIsOJ()) return;
  var head = [];
  _bjPinned.forEach(function (p) {
    var e = state.entries.find(function (x) { return x.id === p.id; });
    if (!e) e = { id: p.id, title: p.title || 'Untitled', template: 'page', created: 0, updated: 0, tags: [], data: { html: p.html || '', attachments: [] }, rev: 0 };
    delete e.trashed; delete e.trashChangedAt;
    head.push(e);
  });
  state.entries = head.concat(state.entries.filter(function (x) { return head.indexOf(x) < 0; }));
}
const BJ_CANVAS_KEY = (id) => 'bj_canvas_' + id;
let state = { entries: [], activeId: null, deletedIds: [] };
// ── OurJournal (see the OJ engine) ───────────────────────────────────────────
// `state` is whichever collection is ON SCREEN. With the OurJournal tab on it is
// the shared collection the OJ engine owns, and Veda's own journal waits in
// _bjPersonal. Every persistence call routes by which one `state` is (_bjIsOJ),
// never by a flag, so a write can only ever reach the collection it belongs to.
let _bjPersonal = null;   // Veda's own state while OurJournal is shown
let _bjOJState  = null;   // the shared collection (window.OJ.state('bj'))
let _bjHidden   = false;  // a remote update is being applied to the collection NOT on screen
function _bjIsOJ() { return !!_bjOJState && state === _bjOJState; }
let saveTimer = null;
// ── Anti-regression state — the MyJournal twins, same reasons (see Notebook/core/jguard.js) ──
// _bjDomOwner: the entry id the editor DOM was last PAINTED for. Every template
//   shares one set of nodes, so this is the only way saveCurrentEntry can tell "the
//   content on screen is this entry's" from "it belongs to the entry we just left,
//   or has not been painted yet".
// _bjUserEdited: set by autoSave(), which only runs off a real edit. It separates a
//   user genuinely clearing a page from a blank editor that was never filled in.
let _bjDomOwner   = null;
let _bjUserEdited = false;
let bjSyncStatus = 'idle'; // idle | saving | saved | error

function _bjSetSync(status) {
  bjSyncStatus = status;
  var pill = document.getElementById('bj-sync-pill');
  var txt  = document.getElementById('bj-sync-text');
  var bb   = document.getElementById('bj-bb-saved');
  if (!pill || !txt) return;
  // Everwell's pill (apphead.js): "Synced" fades after two seconds, "Sync
  // failed" stays. Offline, a success reads "Offline".
  var shown = status === 'synced' && navigator.onLine === false ? 'offline' : status;
  pill.className = 'bj-sync-pill bj-sync-' + shown;
  var labels = { syncing:'Syncing…', synced:'Synced', error:'Sync failed', offline:'Offline' };
  // Idle keeps the last word, so it fades out rather than changing first.
  if (labels[shown]) txt.textContent = labels[shown];
  // The phone header's copy: the same dot and word.
  if (bb) {
    var dot = { syncing:'#e0b874', synced:'#a4b986', error:'#d68a7c', offline:'#8d8d94' }[shown];
    clearTimeout(bb._t);
    if (dot) {
      bb.innerHTML = '<span class="bj-sync-dot" style="background:' + dot + '"></span><span>' + labels[shown] + '</span>';
      bb.style.color = shown === 'error' ? '#d68a7c' : '#adadb2';
      bb.style.opacity = '1'; bb.classList.add('on');
      if (shown === 'synced' || shown === 'offline') bb._t = setTimeout(() => { bb.style.opacity = '0'; bb.classList.remove('on'); }, 2000);
    }
    else { bb.style.opacity = '0'; bb.classList.remove('on'); }
  }
  // "Synced" fades to idle after two seconds. Any other state cancels that:
  // a save starting inside those two seconds used to be faded out mid-Syncing.
  if (status !== 'idle') clearTimeout(_bjSyncResetTimer);
  if (status === 'synced') _bjSyncResetTimer = setTimeout(() => _bjSetSync('idle'), 2000);
}
var _bjSyncResetTimer = null;


/* ── Legacy whiteboard PNGs live in IndexedDB, not localStorage ─────────────
 * (Kept for the page-only conversion, core/convert.js: an old whiteboard is read
 * from here when it is turned into a page.)
 * Pre-VizEngine whiteboards were one base64 PNG each, cached under
 * BJ_CANVAS_KEY(id). On Veda's Brave (2026-09-30) 17 of them held 2.4 MB, half
 * of the 5 MB localStorage EVERY A1 page shares, and the full store made saves
 * fail silently across the suite. None belonged to a live whiteboard: the
 * entries had been purged, mostly from another device, which never ran
 * _bjForgetDeleted here, so the keys stayed forever. 16 of the 17 were
 * byte-identical to their dashboards/journal_canvas_<id> cloud documents.
 * They now go to VizStore's IndexedDB (a far larger quota). _bjCanvasMem is the
 * synchronous copy the load and merge paths read, because IndexedDB is async. */
const _bjCanvasMem = {};
function _bjCanvasIdbKey(id) { return 'bjcanvas:' + id; }
function _bjCanvasGet(id) { return _bjCanvasMem[id] || ''; }
function _bjCanvasPut(id, dataURL) {
  if (!dataURL || _bjCanvasMem[id] === dataURL) return;
  _bjCanvasMem[id] = dataURL;
  if (window.VizStore) window.VizStore.idbPut(_bjCanvasIdbKey(id), dataURL);
}
function _bjCanvasDel(id) {
  delete _bjCanvasMem[id];
  try { localStorage.removeItem(BJ_CANVAS_KEY(id)); } catch (e) {}
  if (window.VizStore && window.VizStore.idbDel) window.VizStore.idbDel(_bjCanvasIdbKey(id));
}
// Move every BJ_CANVAS_KEY into IndexedDB. A key is removed only after its
// IndexedDB copy reads back identical, so a failed or blocked write leaves the
// drawing where it was.
function _bjCanvasMoveOut() {
  const VS = window.VizStore;
  if (!VS) return Promise.resolve();
  const keys = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf('bj_canvas_') === 0) keys.push(k); } } catch (e) {}
  return Promise.all(keys.map(function (k) {
    const id = k.slice('bj_canvas_'.length);
    let v = null; try { v = localStorage.getItem(k); } catch (e) {}
    if (!v) return null;
    _bjCanvasMem[id] = v;
    return VS.idbPut(_bjCanvasIdbKey(id), v)
      .then(function (ok) { return ok ? VS.idbGet(_bjCanvasIdbKey(id)) : null; })
      .then(function (back) { if (back === v) { try { localStorage.removeItem(k); } catch (e) {} } });
  }));
}
// Load the PNGs of this device's legacy whiteboards back into their entries.
function _bjCanvasHydrate() {
  const VS = window.VizStore;
  if (!VS) return Promise.resolve();
  return Promise.all(state.entries.map(function (entry) {
    if (entry.template !== 'whiteboard' || (entry.data && entry.data.canvas)) return null;
    return VS.idbGet(_bjCanvasIdbKey(entry.id)).then(function (v) {
      if (!v) return;
      _bjCanvasMem[entry.id] = v;
      if (entry.data && !entry.data.canvas) entry.data.canvas = v;
    });
  }));
}

function loadState() {
  try { const r = localStorage.getItem(STORAGE_KEY); if (r) state = JSON.parse(r); } catch(e) {}
  if (!Array.isArray(state.deletedIds)) state.deletedIds = [];
  // Restore canvas data from localStorage into whiteboard entries (any key the
  // move below has not reached yet), then from IndexedDB.
  state.entries.forEach(entry => {
    if (entry.template === 'whiteboard') {
      let saved = null; try { saved = localStorage.getItem(BJ_CANVAS_KEY(entry.id)); } catch (e) {}
      if (saved && !entry.data.canvas) entry.data.canvas = saved;
    }
  });
  _bjCanvasMoveOut().then(_bjCanvasHydrate).catch(function (e) { console.warn('[BJ] canvas move failed:', e); });
}

// Write the local cache safely. localStorage is ONLY a fast cache — Firebase is the
// real store. Whiteboard canvases are large base64 PNGs already saved in IndexedDB
// (_bjCanvasPut) and rehydrated by loadState, so omit them from the main blob to
// stay under the ~5MB quota. A thrown QuotaExceededError here previously broke EVERY
// document open + password lock (saveState runs inside saveCurrentEntry and the lock
// system) and stalled Firebase sync — so swallow any storage error too.
function _bjOmitCanvas(k, v) {
  if (k === 'canvas' && typeof v === 'string' && v.length > 1024) return '';
  // Page images the cloud already holds are cached as their bj-fbimg://
  // placeholder rather than their bytes — loadActiveEntry rehydrates them on
  // paint, exactly as it does for an entry that arrived from Firebase. This is
  // most of the blob by size, and it is re-serialised on every autosave.
  if (k === 'html' && typeof v === 'string' && v.length > 8192 && v.indexOf('data-bjkey="') >= 0) return _bjSlimHtml(v);
  return v;
}
function _bjSlimHtml(h) {
  return h.replace(/<[^>]*\bdata-bjkey="([^"]+)"[^>]*>/g, function (tag, key) {
    return tag.replace(/\b(src|href)="data:[^"]*"/, '$1="bj-fbimg://' + key + '"');
  });
}
function _bjWriteCache() {
  if (_bjIsOJ()) { if (window.OJ) window.OJ.writeCache('bj'); return; }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state, _bjOmitCanvas)); }
  catch (e) { /* quota exceeded / private mode: keep last good cache; Firebase holds the full data */ }
}

function saveState() {
  if (_bjIsOJ()) { if (window.OJ) window.OJ.touched('bj'); return; }
  // Save full state to localStorage (minus bulky canvases) — instant, best-effort
  _bjWriteCache();
  state.entries.forEach(entry => {
    if (entry.template === 'whiteboard' && entry.data && entry.data.canvas) {
      _bjCanvasPut(entry.id, entry.data.canvas);
    }
  });
  // Show syncing immediately — even before debounce fires
  _bjSetSync('syncing');
  if (window._fbSaveJournal) {
    // Capture activeId NOW (not lazily at debounce-fire time). Switching entries
    // within the 300ms window used to make the debounced save write whichever entry
    // was active when the timer fired — silently dropping the edit to the one we left.
    // The state OBJECT is captured too: the getter runs up to 300ms later, and by
    // then OurJournal may be on screen — it must still read Veda's own entries.
    var _bjSid = state.activeId, _bjSt = state;
    window._fbSaveJournal(() => ({ entries: _bjSt.entries, activeId: _bjSid }));
  }
}

// Persistence routers: the shared collection goes to the OJ engine, Veda's own
// to her Firebase document — decided by which collection `state` is right now.
function _bjFbSaveEntry(e) {
  if (_bjIsOJ()) { if (window.OJ) window.OJ.touched('bj'); return; }
  if (window._fbSaveJournalEntry) window._fbSaveJournalEntry(e, state.entries);
}
function _bjFbDelete(id) {
  if (_bjIsOJ()) { if (window.OJ) window.OJ.hardDelete('bj', id); return; }
  if (window._fbDeleteJournalEntry) window._fbDeleteJournalEntry(id);
}
function _bjFbFlush() {
  if (_bjIsOJ()) return window.OJ ? window.OJ.flush('bj') : undefined;
  if (window._fbFlushJournal) return window._fbFlushJournal();
}
function _bjFbOrder() {
  if (_bjIsOJ()) { if (window.OJ) window.OJ.touched('bj'); return; }
  if (window._fbSaveJournalOrder) window._fbSaveJournalOrder(state.entries);
}
// Run fn against Veda's OWN journal even while OurJournal is on screen — used
// for her Firebase listener's updates. The active id is parked for the duration
// so the merge treats every entry as off-screen and never touches the editor
// (which is showing a shared entry), and nothing re-renders.
function _bjWithPersonal(fn) {
  if (!_bjIsOJ() || !_bjPersonal) return fn();
  var shown = state, keep = _bjPersonal.activeId;
  state = _bjPersonal; state.activeId = null; _bjHidden = true;
  try { return fn(); }
  finally {
    _bjPersonal = state; _bjPersonal.activeId = keep;
    _bjHidden = false; state = shown;
  }
}

// Merge remote state into local.
// With the new per-entry field storage model, each entry arrives independently.
// No collision is possible between two users editing different entries.
// For the same entry: remote wins if it's newer (last-write-wins), EXCEPT for
// the exact textarea/field the user is currently typing in — that field is protected.
function _bjApplyRemote(remote) {
  if (!remote || !Array.isArray(remote.entries)) return;
  // This is always the personal journal's own document. With OurJournal on
  // screen, apply it to the personal collection waiting off-screen.
  if (_bjIsOJ() && !_bjHidden) return _bjWithPersonal(function() { _bjApplyRemote(remote); });

  var focused = document.activeElement;

  // "Is the user actively editing something here that must not be yanked away?"
  // Focus alone is not the right test: an EMPTY field holds no cursor position and
  // no in-progress text worth protecting, and treating it as protected is what kept
  // an entry that came back blank from ever healing — the moment you clicked into it
  // to see what had happened, the repair was vetoed and the blank stayed.
  function _bjBusy(el) {
    if (!el) return false;
    if (focused !== el && !(el.contains && el.contains(focused))) return false;
    return !(window.JGuard && window.JGuard.emptyHtml(el.value !== undefined ? el.value : el.innerHTML));
  }

  // Flush active entry DOM → state before merging so local updated timestamp is current.
  // Gated on DOM ownership for the same reason saveCurrentEntry is: if the editor was
  // not painted for this entry there is nothing here worth flushing, only the previous
  // entry's content or a blank field waiting to be mistaken for one.
  // An AUTHORITATIVE update is a forced (or server-sourced) read of the real
  // document, not this device's cached memory of it — see _fbResync* in the Firebase
  // module. In that mode the server decides every entry except ones this device has
  // edited and not yet uploaded, which is what makes re-opening a journal after days
  // away show the current state instead of the copy this device fell asleep holding.
  var _auth = !!(remote && remote._authoritative);

  var activeEntry = getActive();
  if (activeEntry && _bjDomOwner === activeEntry.id) {
    // Capture ONLY the field the user is actively editing (focused). Blindly
    // snapshotting every input here wiped titles on phones: when this listener
    // fired during entry open, the (hidden) desktop title input could still be
    // empty and overwrote the real title with '' → "Untitled", which then synced
    // out. The per-field merge below already protects the focused field, so
    // capturing only that is sufficient — and opening now never mutates content.
    var _fa = document.activeElement;
    var _titleEl = document.getElementById('bj-entry-title-input');
    if (_titleEl && _fa === _titleEl) activeEntry.title = _titleEl.value;
    if (activeEntry.template === 'page') {
      var _pe = document.getElementById('bj-page-editor');
      if (_pe && (_fa === _pe || _pe.contains(_fa))) activeEntry.data.html = _pe.innerHTML;
    }
    activeEntry.updated = activeEntry.updated || Date.now();
  }

  // Build lookup of local entries by id
  var localById = {};
  var _activeWasUpdated = false;
  state.entries.forEach(function(e) { localById[e.id] = e; });

  // Upsert each remote entry into local state
  var remoteById = {};
  var _deletedSet = new Set(state.deletedIds || []);
  // Authoritative trash/recover state per entry, resolved independently of the
  // content-merge `updated` guard below. Delete (trash) and recover (restore)
  // are explicit user actions that must sync LIVE to every device; the content
  // guard can otherwise let a stale local copy keep a remotely-trashed entry
  // visible (or hide a remotely-restored one) under clock skew or a concurrent
  // edit. Applied after the loop so it wins no matter which merge branch ran.
  var _winnerTrashed = {};
  remote.entries.forEach(function(remoteEntry) {
    remoteById[remoteEntry.id] = true;
    if (_deletedSet.has(remoteEntry.id)) return;
    var local = localById[remoteEntry.id];
    var remoteUpdated = remoteEntry.updated || 0;
    var localUpdated  = local ? (local.updated || 0) : 0;

    if (local) {
      // Resolve trash vs recover by an explicit trash-action clock (trashChangedAt)
      // that ONLY changes on delete/restore — never on content edits. This makes a
      // delete or recover authoritative and immune to the content `updated` guard,
      // to cross-device clock skew, and to a later content edit on a device that
      // missed the action (which would otherwise resurrect a deleted entry).
      var _rT = remoteEntry.trashed || 0;
      var _lT = local.trashed || 0;
      if (_rT !== _lT) {
        var _rC = remoteEntry.trashChangedAt || 0;
        var _lC = local.trashChangedAt || 0;
        var _rHas = _rC || _rT;   // remote has a trash-action signal (legacy: trashed w/o meta)
        var _lHas = _lC || _lT;
        var _win;
        if (_rHas && _lHas)  _win = ((_rC || _rT) >= (_lC || _lT)) ? { t:_rT, c:_rC||_rT } : { t:_lT, c:_lC||_lT };
        else if (_rHas)      _win = { t:_rT, c:_rC||_rT };   // only remote acted → it wins
        else if (_lHas)      _win = { t:_lT, c:_lC||_lT };   // only local acted → keep local
        else                 _win = (remoteUpdated >= localUpdated) ? { t:_rT, c:0 } : { t:_lT, c:0 };
        _winnerTrashed[remoteEntry.id] = _win;
      }
    }

    if (!local) {
      // Brand new entry from other device — add it
      if (remoteEntry.template === 'whiteboard') {
        var lc = _bjCanvasGet(remoteEntry.id);
        localById[remoteEntry.id] = { ...remoteEntry, data: { ...remoteEntry.data, canvas: lc || remoteEntry.data && remoteEntry.data.canvas || '' } };
      } else {
        localById[remoteEntry.id] = remoteEntry;
      }
      return;
    }

    // ── Which copy of this entry wins? Resolved in this order, and the order is
    // the whole point:
    //
    //  1. AN UNSYNCED LOCAL EDIT always wins. `_dirty` marks an entry this device
    //     has changed but not yet managed to upload; it is about to be written, and
    //     nothing arriving now may erase it.
    //  2. AN AUTHORITATIVE SNAPSHOT otherwise wins outright. This is what stops a
    //     device that has been away for a week from insisting on its own copy.
    //  3. REVISION. `rev` counts committed content changes, so it orders two copies
    //     WITHOUT consulting a clock. Device clocks disagree by minutes, and a phone
    //     whose clock ran fast used to win every conflict on nothing but that.
    //  4. `updated`, the legacy fallback for entries written before `rev` existed.
    //  5. And regardless of all of it: an EMPTY local copy never beats a remote one
    //     that still has content. Emptiness is not an edit worth defending, and
    //     without this a session that once stamped a timestamp from a blank editor
    //     would reject the real content forever, then publish its blank over it.
    //     The reverse — remote blank, local full — is deliberately left alone: that
    //     is what this device's pending write is about to correct.
    var _rRev = remoteEntry.rev || 0, _lRev = local.rev || 0;
    var _localEmpty = !!(window.JGuard && window.JGuard.emptyEntry(local) && !window.JGuard.emptyEntry(remoteEntry));
    var _remoteWins;
    if (local._dirty)         _remoteWins = false;
    else if (_auth)           _remoteWins = true;
    else if (_rRev !== _lRev) _remoteWins = _rRev > _lRev;
    else                      _remoteWins = remoteUpdated >= localUpdated;
    if (!_remoteWins) {
      if (!_localEmpty) return;
      console.warn('[JGuard] bj entry ' + remoteEntry.id + ' is empty locally but has content on the server — taking the server copy');
    }
    // Remote is about to replace local content. If it is SMALLER, keep the local
    // version in the rolling backup first — the last line of defence if a wipe still
    // reaches the cloud from some other device.
    if (window.JGuard) window.JGuard.backup('bj', local, remoteEntry.data);

    if (remoteEntry.template === 'whiteboard') {
      // A whiteboard entry carries only its fingerprint now; the board itself
      // lives in its own document with its own sync. Keep any legacy canvas the
      // remote copy has had stripped from it.
      var lc2 = local.data && local.data.canvas ? local.data.canvas : _bjCanvasGet(local.id);
      localById[remoteEntry.id] = { ...remoteEntry, data: { ...remoteEntry.data, canvas: lc2 } };
      return;
    }

    if (local.id !== state.activeId) {
      // Inactive entry — remote wins outright, no typing to protect
      localById[remoteEntry.id] = remoteEntry;
      return;
    }

    // ── Active entry, remote is newer: apply per-field, skip focused element ──
    _activeWasUpdated = true;
    if (remoteEntry.template === 'page') {
      var pageEd = document.getElementById('bj-page-editor');
      var userInEditor = _bjBusy(pageEd);
      if (!userInEditor) {
        // Apply remote HTML, rehydrate images if needed
        localById[remoteEntry.id] = remoteEntry;
        var remoteHtml = remoteEntry.data && remoteEntry.data.html || '';
        if (pageEd) {
          if (remoteHtml.includes('bj-fbimg://') && window._fbRehydratePageImages) {
            window._fbRehydratePageImages(remoteHtml).then(function(rehydrated) {
              if (pageEd) { pageEd.innerHTML = rehydrated; if (window._docxUnnestHeadings) window._docxUnnestHeadings(pageEd); }
              var ae = getActive(); if (ae) { ae.data.html = rehydrated; }
              if (pageEd && typeof _pgBindImgWrap !== 'undefined') pageEd.querySelectorAll('.pg-img-wrap').forEach(_pgBindImgWrap);
            });
          } else {
            pageEd.innerHTML = remoteHtml; if (window._docxUnnestHeadings) window._docxUnnestHeadings(pageEd);
            if (typeof _pgBindImgWrap !== 'undefined') pageEd.querySelectorAll('.pg-img-wrap').forEach(_pgBindImgWrap);
          }
        }
      }
      // else: user is typing in page editor, skip to avoid disrupting cursor
    } else {
      localById[remoteEntry.id] = remoteEntry;
    }
  });

  // Apply the authoritative trash/recover winner to the merged entries so a
  // delete or recover on any device reflects live here, regardless of which
  // content-merge branch ran or how the content `updated` timestamps compared.
  Object.keys(_winnerTrashed).forEach(function(id) {
    var m = localById[id];
    if (!m) return;
    var w = _winnerTrashed[id];
    if (w.t) m.trashed = w.t; else if (m.trashed) delete m.trashed;
    if (w.c) m.trashChangedAt = w.c;   // converge the trash-action clock across devices
  });

  // Remove entries deleted on another device.
  // _allPresentIds (from the snapshot) is the authoritative list of e_* fields in Firestore.
  // An entry absent from that set WAS in Firebase (e._fbPushed) and is now gone = remote delete.
  // When _allPresentIds is not available (legacy path), fall back to remotePresentIds from entries[].
  var remotePresentIds = new Set(remote.entries.map(function(e) { return e.id; }));
  var authorizedPresentIds = remote._allPresentIds
    ? new Set(remote._allPresentIds)
    : remotePresentIds; // fallback: same as before
  var ownDeletedSet = new Set(state.deletedIds || []);
  // Only prune when we know Firebase actually responded (_fbHasData:true prevents pruning
  // on a stale/empty initial load before Firebase data arrives).
  var canPrune = !!remote._fbHasData;
  // In AUTHORITATIVE mode the server's key list is the truth: an entry missing from
  // it was deleted somewhere else, whether or not this device ever got round to
  // marking it _fbPushed. That missing mark is exactly why entries deleted days ago
  // kept reappearing on a phone. Gated on the server actually having entries, so a
  // read of an empty/not-yet-written document can never wipe a populated device.
  var _authPrune = _auth && authorizedPresentIds.size > 0;
  var _prunedRemotely = [];
  state.entries = state.entries.filter(function(e) {
    if (ownDeletedSet.has(e.id)) return false;
    if (authorizedPresentIds.has(e.id)) return true;
    // Unsynced local work is protected from a remote view's key list ONLY while the
    // server has never seen this entry — i.e. it was created here and has not been
    // uploaded yet. An entry the server DID have and no longer does was deleted on
    // another device; that deletion wins, or a stalled upload here would resurrect it
    // and we are back to "entries I deleted days ago keep coming back".
    if (e._dirty && !e._fbPushed) return true;
    if (_authPrune) { _prunedRemotely.push(e.id); return false; }
    if (canPrune && e._fbPushed) { _prunedRemotely.push(e.id); return false; }  // was in Firebase, now gone = remote delete
    return true;
  });
  // Remember remote hard-deletes as our own, so a late in-flight write from any
  // device can never resurrect the entry here, and drop its lock state with it.
  _bjForgetDeleted(_prunedRemotely);

  // Rebuild state.entries: if remote has _order, use it; else preserve local order + append new
  var existingIds = new Set(state.entries.map(function(e) { return e.id; }));
  var allEntries = state.entries.map(function(e) { return localById[e.id] || e; });
  // Append new entries from remote
  var newEntries = [];
  Object.keys(remoteById).forEach(function(id) {
    if (!existingIds.has(id) && localById[id] && !ownDeletedSet.has(id)) newEntries.push(localById[id]);
  });
  newEntries.sort(function(a,b){ return (b.created||0)-(a.created||0); });
  allEntries = newEntries.concat(allEntries);

  // If remote sent _order, reorder to match it (remote order wins for cross-device reorder sync)
  if (remote._order && Array.isArray(remote._order) && remote._order.length > 0) {
    var orderMap = {}; remote._order.forEach(function(id, i) { orderMap[id] = i; });
    allEntries.sort(function(a, b) {
      var ia = orderMap[a.id] != null ? orderMap[a.id] : 9999;
      var ib = orderMap[b.id] != null ? orderMap[b.id] : 9999;
      return ia !== ib ? ia - ib : (b.created||0)-(a.created||0);
    });
  }
  state.entries = allEntries;

  // If the active entry was deleted OR trashed on another device, switch to first available
  var _bjActiveGone = state.activeId && !state.entries.find(function(e) { return e.id === state.activeId; });
  var _bjActiveTrashed = state.activeId && (state.entries.find(function(e){ return e.id === state.activeId; }) || {}).trashed;
  var _bjActiveAway = _bjFolder !== null && !_bjHidden && !_bjIsOJ() && (!state.activeId || !_bjInFolder(getActive()));
  if (_bjActiveGone || _bjActiveTrashed || (_bjActiveAway && _bjFirstLive())) {
    state.activeId = _bjFirstLive();
    loadActiveEntry();
  }

  // Mark all entries present in remote as confirmed synced
  state.entries.forEach(function(e) { if (remotePresentIds.has(e.id)) e._fbPushed = true; });

  // Anything still marked dirty after an authoritative reconcile has local work the
  // server has not got. The debounced save only ever writes the ACTIVE entry, so a
  // failed or interrupted upload of some other entry would otherwise sit unsynced
  // forever. Push them now — this is the "everything ends up saved" half of the
  // resync, and it is a no-op in the normal case where nothing is dirty.
  if (_auth) {
    state.entries.forEach(function(e) {
      if (!e._dirty || e.id === state.activeId) return;
      _bjFbSaveEntry(e);
    });
  }

  // NEVER override local activeId — each device stays on its own entry
  _bjWriteCache();
  renderSidebar();
  // Re-run the lock check so an entry deleted (or unlocked) on another device
  // can't leave a lock overlay stranded over a document that no longer exists.
  if (window._bjLockCheck && !_bjHidden) window._bjLockCheck();
  // An entry made with an old template (from a device that had not updated
  // yet) becomes a page here too.
  _bjConvertAll();
}

// The host's onSave: called with the entry the cloud just confirmed.
if (typeof _bjCfg.onSave === 'function') window.addEventListener('fb-bj-saved', function(ev) {
  var _sid = ev && ev.detail && ev.detail.id;
  var e = _sid && state.entries.find(function(x){ return x.id === _sid; });
  if (e) { try { _bjCfg.onSave(e); } catch (err) { console.warn('[Notebook] onSave failed:', err); } }
});
// Listen for Firebase sync events
window.addEventListener('fb-bj-saved', function(ev) {
  _bjSetSync('synced');
  // Confirmed in the cloud: record that it has been pushed and drop the unsynced
  // mark. Keyed by the id the event names, because the save that just landed is not
  // always for the entry that is active NOW.
  _bjWithPersonal(function() {
    var _sid = ev && ev.detail && ev.detail.id;
    var ae = _sid ? state.entries.find(function(x){ return x.id === _sid; }) : getActive();
    if (ae) { ae._fbPushed = true; delete ae._dirty; _bjWriteCache(); }
  });
});
window.addEventListener('fb-bj-synced', function() { _bjSetSync('synced'); });
window.addEventListener('fb-bj-error', function() { _bjSetSync('error'); });
window.addEventListener('fb-bj-prompt-saved', function() { _bjSetSync('synced'); });
window._bjSetSync = _bjSetSync;   // exposed so the AI-prompt save can drive the sync pill
window.addEventListener('fb-bj-remote-update', function(e) { _bjApplyRemote(e.detail); });

// Initial Firebase load when FB ready
function _bjInitFirebase() {
  // MIGRATION — only for a genuinely legacy document: one `entries` array and no
  // e_* fields. The old test asked whether any key of the LOADER'S RETURN VALUE
  // started with "e_", but that value is { entries, activeId } — it never has such a
  // key, so the answer was always "legacy" and the migration ran on EVERY page load,
  // on every device. It wrote with a bare setDoc (a whole-document replace), so each
  // launch deleted _order and activeId and republished every entry from whatever
  // that device had just read. When the read had fallen back to the IndexedDB cache
  // — routine on a phone waking up on a slow connection — a week-old local copy was
  // published over the live document, restoring entries deleted elsewhere and
  // reverting page content. The loader now says so itself.
  if (window._fbLoadJournal) {
    window._fbLoadJournal().then(function (remote) {
      if (!remote || !remote._legacy) return;
      if (Array.isArray(remote.entries) && remote.entries.length > 0 && window._fbMigrateJournalIfNeeded) {
        window._fbMigrateJournalIfNeeded(remote.entries);
      }
    });
  }
  // The merge comes from the authoritative resync — a forced SERVER read applied as
  // the truth — so a cold launch shows the current document instead of this device's
  // cached memory of it. Safe to call repeatedly; that is the point.
  if (window._fbResyncJournal) {
    var _rs = window._fbResyncJournal();
    if (typeof _bjCfg.onReady === 'function' && !_bjCfg._readyFired && _rs && _rs.then) _rs.then(function () {
      if (_bjCfg._readyFired) return;
      _bjCfg._readyFired = true;
      try { _bjCfg.onReady(); } catch (err) { console.warn('[Notebook] onReady failed:', err); }
    });
  }
}
// Re-run on EVERY fb-ready, not just the first. The connection is torn down whenever
// the tab is hidden or the phone suspends the app, and re-established on the way
// back; before this, that reconnect re-attached the listeners but never re-read the
// document, so a device returning after days sat on its cache until something
// happened to change server-side.
if (window._fbReady) _bjInitFirebase();
window.addEventListener('fb-ready', _bjInitFirebase);

function getActive() { return state.entries.find(e => e.id === state.activeId) || null; }

function createEntry(template) {
  const id = 'e_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  // Page is the one template (2026-11-17).
  const entry = { id, title: '', template: 'page', created: Date.now(), updated: Date.now(), tags: [], data: { html: '', attachments: [] } };
  // Unsynced until the cloud confirms it — without this an authoritative resync
  // arriving in the next second would prune an entry the server has never seen.
  entry._dirty = true;
  // A shared entry records who made it (Veda, from here) and opens its live document.
  if (_bjIsOJ() && window.OJ) window.OJ.created('bj', entry);
  // Made in the folder on screen (OurJournal has none).
  else if (_bjFolder !== null) entry.folder = _bjFolder;
  state.entries.unshift(entry);
  state.activeId = id;
  return entry;
}

// ── TRASH SYSTEM: delete = move to Trash (30 days), synced via entry.trashed ──
const BJ_TRASH_TTL = 30 * 24 * 60 * 60 * 1000;
function deleteEntry(id) {
  const entry = state.entries.find(e => e.id === id);
  if (!entry || _bjIsPinned(id)) return;
  var _bjDelTs = Date.now();
  entry.trashed = _bjDelTs;
  entry.trashChangedAt = _bjDelTs;   // trash-action clock (drives cross-device delete sync)
  entry.updated = _bjDelTs;
  if (state.activeId === id) state.activeId = _bjFirstLive();
  saveState(); renderSidebar(); loadActiveEntry();
  // Push the trashed entry itself (it isn't the active one, so the debounced save skips it)
  _bjFbSaveEntry(entry);
}
// Tombstone one or more ids that are gone for good — locally purged here, or
// purged on another device and pruned by the remote merge. Recording them in
// deletedIds is what stops a late in-flight write from any device resurrecting
// the entry, and clearing the per-entry lock/unlock keys stops a deleted-but-
// locked document from leaving a lock overlay that can never be satisfied.
function _bjForgetDeleted(ids) {
  if (!ids || !ids.length) return;
  if (!Array.isArray(state.deletedIds)) state.deletedIds = [];
  ids.forEach(function(id) {
    if (!state.deletedIds.includes(id)) state.deletedIds.push(id);
    if (window._bjLockForget) window._bjLockForget(id);
    _bjCanvasDel(id);
  });
  // Keep the tombstone list from growing without bound across years of use.
  if (state.deletedIds.length > 500) state.deletedIds = state.deletedIds.slice(-500);
}
// Permanent delete — used by the Trash UI and the 30-day auto-purge
function hardDeleteEntry(id) {
  if (_bjIsPinned(id)) return;
  _bjForgetDeleted([id]);
  _bjFbDelete(id);
  state.entries = state.entries.filter(e => e.id !== id);
  if (state.activeId === id) state.activeId = _bjFirstLive();
  saveState(); renderSidebar(); loadActiveEntry();
}
/* The 30-day trash purge is the ONE automatic, irreversible delete in this app:
 * it calls deleteField() on the server, which removes the entry for every device
 * at once, and tombstones the id locally so nothing can bring it back.
 *
 * It used to run at BOOT, straight off localStorage, before Firebase had said a
 * word — `loadState(); purgeExpiredTrash();`. That is a permanent delete decided
 * from this device's cached memory of the journal, and the cache is exactly what
 * cannot be trusted on a cold start:
 *
 *   - a `trashed` stamp that was already REVERTED on another device (restored
 *     from the Trash there) still sits in this cache until a sync arrives;
 *   - a cache written before this device went stale can be weeks behind;
 *   - _bjWhenServerSeen does NOT save us. It defers the WRITE until the server
 *     connects, but the DECISION was already made from stale data, so the delete
 *     fires the instant the connection opens — with no re-check against what the
 *     server actually holds.
 *
 * So the purge now waits for an authoritative server read and re-reads its own
 * decision from the reconciled state. The TTL is 30 days; nothing is lost by
 * waiting seconds for the truth, and what was lost by not waiting was real work.
 *
 * Ordering note: _bjApplyRemote is what reconciles state with the server, so
 * running after it means `state.entries` here is the merged truth — an entry
 * restored elsewhere has had its `trashed` cleared before we look at it. */
let _bjPurgeDone = false, _bjPurgeScheduled = false;
function purgeExpiredTrash(opts) {
  // Never decide a permanent delete from the cache. Anything but an explicit
  // authoritative call is a request to schedule the purge, not to run it.
  if (!opts || !opts.authoritative) { _bjSchedulePurge(); return; }
  // Purges the personal journal only (OurJournal's trash is the OJ engine's).
  if (_bjIsOJ() && !_bjHidden) return _bjWithPersonal(function() { purgeExpiredTrash(opts); });
  if (_bjPurgeDone) return;
  _bjPurgeDone = true;
  const cutoff = Date.now() - BJ_TRASH_TTL;
  const doomed = state.entries.filter(e => e.trashed && e.trashed < cutoff).map(e => e.id);
  if (!doomed.length) return;
  console.warn('[BJ] purging ' + doomed.length + ' entr' + (doomed.length === 1 ? 'y' : 'ies') +
               ' past the ' + (BJ_TRASH_TTL / 86400000) + '-day trash limit');
  doomed.forEach(hardDeleteEntry);
}
/* Run the purge once, against server-reconciled state.
 *
 * The signal has to be an AUTHORITATIVE remote update, not fb-bj-synced. That
 * event also fires for cache-sourced snapshots (`_fromCache`), and purging off
 * a cached snapshot is precisely the bug above wearing a different hat. The
 * `_authoritative` flag on fb-bj-remote-update is set only for a forced server
 * read or a genuine server-sourced snapshot — see _bjBuildRemote.
 *
 * If Firebase never connects, the purge simply never runs. A deferred purge is
 * harmless — the entry stays in the Trash, visible and restorable, until some
 * later session can check properly. A wrong purge is not recoverable. */
function _bjSchedulePurge() {
  if (_bjPurgeDone || _bjPurgeScheduled) return;
  _bjPurgeScheduled = true;
  window.addEventListener('fb-bj-remote-update', function _once(ev) {
    if (!ev || !ev.detail || !ev.detail._authoritative) return;   // cached view — keep waiting
    window.removeEventListener('fb-bj-remote-update', _once);
    // One turn late, so the merge that this event triggers has finished writing
    // state.entries before the purge reads it.
    setTimeout(() => purgeExpiredTrash({ authoritative: true }), 0);
  });
}
window._bjTrashAPI = {
  list: () => state.entries.filter(e => e.trashed && _bjInFolder(e)).sort((a,b) => (b.trashed||0)-(a.trashed||0)),
  restore: (ids) => {
    (ids||[]).forEach(id => {
      const e = state.entries.find(x => x.id === id);
      if (e) { var _rTs = Date.now(); delete e.trashed; e.trashChangedAt = _rTs; e.updated = _rTs; _bjFbSaveEntry(e); }
    });
    saveState(); renderSidebar();
  },
  purge: (ids) => { (ids||[]).forEach(hardDeleteEntry); },
  ttlDays: 30
};

// ── Per-page margins (Batch 10 #3): stored on the active PAGE entry, synced to
// Firebase with the entry, so dragging a margin affects only that page. ──
// A dragged margin waits here, not on the entry, until saveCurrentEntry commits
// it like any edit (updated, rev, dirty, cloud). Written straight onto the entry
// it made the save's no-op guard see nothing new, and the pill sat at Syncing.
// Both hooks deal in COPIES: the ruler edits what Get returns in place, and
// handing it the entry's own object changed the entry before the save looked.
let _bjPendingMargins = null;   // { id, m }
window._bjGetPageMargins = function() {
  const e = state.entries.find(x => x.id === state.activeId);
  if (!e || e.template !== 'page') return null;
  if (_bjPendingMargins && _bjPendingMargins.id === e.id) return Object.assign({}, _bjPendingMargins.m);
  if (e.data && e.data.margins && typeof e.data.margins.ml === 'number') return Object.assign({}, e.data.margins);
  return null;
};
window._bjSetPageMargins = function(m) {
  const e = state.entries.find(x => x.id === state.activeId);
  if (e && e.template === 'page') { _bjPendingMargins = { id: e.id, m: Object.assign({}, m) }; autoSave(); }
};

// ── SEARCH: title + full content (tags were retired 2026-11-17) ──
function _bjEntryText(e) {
  const d = e.data || {};
  const parts = [e.title || ''];
  if (d.html) parts.push(String(d.html).replace(/<[^>]*>/g, ' '));
  return parts.join(' ').toLowerCase();
}
function _bjHlTitle(text, q) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0,i)) + '<mark class="docx-hl">' + esc(text.slice(i, i+q.length)) + '</mark>' + esc(text.slice(i+q.length));
}
function _bjRenderTrashBtn() {
  let btn = document.getElementById('bj-trash-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'bj-trash-btn';
    btn.className = 'docx-trash-btn';
    btn.onclick = () => { if (window._docxOpenTrash) window._docxOpenTrash('bj'); };
    const sidebar = document.getElementById('bj-sidebar');
    if (sidebar) sidebar.appendChild(btn);
  }
  const n = state.entries.filter(e => e.trashed && _bjInFolder(e)).length;
  btn.innerHTML = window.TNI.trash + '<span>Trash</span>' + (n ? ' <span class="docx-trash-count">' + n + '</span>' : '');
}

function renderSidebar() {
  if (_bjHidden) return;
  _bjPinFirst();
  const list = document.getElementById('bj-entries-list');
  const search = document.getElementById('bj-search-box').value.toLowerCase().trim();
  const live = state.entries.filter(e => !e.trashed && _bjInFolder(e));
  const entries = live.filter(e => {
    // Locked entries: search the title only (never their hidden content)
    const isLocked = window._bjGetLock && window._bjGetLock(e.id) && !(window._bjIsUnlocked && window._bjIsUnlocked(e.id));
    const hay = isLocked ? (e.title || '').toLowerCase() : _bjEntryText(e);
    return !search || hay.includes(search);
  });
  list.innerHTML = '';
  if (entries.length === 0) {
    list.innerHTML = `<div class="list-empty">${search ? 'No entries match your search.' : (_bjIsOJ() ? 'Nothing shared yet.<br>Anything created here is visible to Tony and Veda.' : 'No entries yet.<br>Click "New Entry" to begin.')}</div>`;
  }
  const isDraggable = !search;
  let dragSrcId = null;

  entries.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'entry-item' + (entry.id === state.activeId ? ' active' : '');
    div.dataset.entryId = entry.id;
    // A pinned page stays first: it is never dragged, nor dropped onto.
    const pinned = _bjIsPinned(entry.id);
    const rowDrag = isDraggable && !pinned;
    if (rowDrag) div.draggable = true;
    const tmap = { whiteboard: 'BOARD', notes: 'NOTES', cornell: 'CORNELL', mindmap: 'MAP', 'mindmap-legacy': 'MAP', page: 'PAGE', 'journal-entries': 'JOURNAL' };
    // A pinned page the store has not saved yet has no date (updated 0).
    const date = entry.updated ? new Date(entry.updated).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const titleClass = entry.title ? '' : ' untitled';
    div.innerHTML = `
      ${rowDrag ? `<div class="entry-drag-handle" title="Drag to reorder"><span></span><span></span><span></span></div>` : ''}
      <div class="entry-item-title${titleClass}">${_bjHlTitle(entry.title || 'Untitled', search)}</div>
      <div class="entry-item-meta">
        <span class="template-badge">${tmap[entry.template]||'NOTE'}</span>
        <span>${date}</span>
        ${_bjIsOJ() && entry.creator && window.OJ ? `<span class="oj-by oj-by-${entry.creator}" title="Created by ${window.OJ.name(entry.creator)}">${window.OJ.name(entry.creator)}</span>` : ''}
      </div>
      <button class="entry-delete" data-id="${entry.id}" title="Move to Trash" aria-label="Move to Trash">${window.TNI.x}</button>
    `;
    if (pinned) { div.classList.add('nb-pinned'); div.querySelector('.entry-delete').style.setProperty('display', 'none', 'important'); 
      // A pin where the x would be: this page stays first and is never trashed.
      div.insertAdjacentHTML('beforeend', `<span class="entry-pin" title="Pinned: always first, can't be moved to Trash" aria-label="Pinned">${(window.TNI.pin || '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>')}</span>`);
    }
    div.addEventListener('click', e => {
      if (e.target.classList.contains('entry-delete') || e.target.closest('.entry-delete')) return;
      if (e.target.classList.contains('entry-drag-handle') || e.target.closest('.entry-drag-handle')) return;
      // Flush the just-edited entry to Firebase BEFORE changing activeId, so its
      // pending debounced save can't be redirected to (or dropped in favour of) the
      // entry we're switching to.
      saveCurrentEntry(); _bjFbFlush(); state.activeId = entry.id; renderSidebar(); loadActiveEntry();
    });
    div.querySelector('.entry-delete').addEventListener('click', async e => {
      e.stopPropagation();
      // A locked entry this device has not opened takes its password first
      // (Guardian's verify screen); the lock record goes with the entry.
      // No lock helper must never mean no password: a locked entry then stays.
      var pw = window._bjLockDeleteAsk ? await window._bjLockDeleteAsk(entry.id) : (entry.lock ? null : '');
      if (pw === null) return;
      if (await window.uiConfirm(`Delete "${entry.title || 'Untitled'}"?`, {danger:true, okLabel:'Delete'})) {
        if (pw && window._bjLockForget) await window._bjLockForget(entry.id, pw);
        deleteEntry(entry.id);
      }
    });
    if (rowDrag) {
      div.addEventListener('dragstart', e => {
        dragSrcId = entry.id;
        div.classList.add('bj-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', entry.id);
      });
      div.addEventListener('dragend', () => {
        div.classList.remove('bj-dragging');
        list.querySelectorAll('.bj-drag-over').forEach(el => el.classList.remove('bj-drag-over'));
      });
      div.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        list.querySelectorAll('.bj-drag-over').forEach(el => el.classList.remove('bj-drag-over'));
        if (dragSrcId !== entry.id) div.classList.add('bj-drag-over');
      });
      div.addEventListener('dragleave', () => div.classList.remove('bj-drag-over'));
      div.addEventListener('drop', e => {
        e.preventDefault();
        div.classList.remove('bj-drag-over');
        if (!dragSrcId || dragSrcId === entry.id) return;
        const fromIdx = state.entries.findIndex(x => x.id === dragSrcId);
        const toIdx   = state.entries.findIndex(x => x.id === entry.id);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = state.entries.splice(fromIdx, 1);
        state.entries.splice(toIdx, 0, moved);
        dragSrcId = null;
        _bjPinFirst();
        saveState(); renderSidebar();
      });
      // Touch drag for mobile
      const bjHandle = div.querySelector('.entry-drag-handle');
      if (bjHandle && window._attachJournalTouchDrag) {
        window._attachJournalTouchDrag(bjHandle, div, entry, list, state, 'bj-drag-over', 'bj-dragging', () => { _bjPinFirst(); saveState(); renderSidebar(); _bjFbOrder(); });
      }
    }
    list.appendChild(div);
  });
  _bjRenderTrashBtn();
}

function showTemplate(name) {
  // name: 'page', 'converting' (an old template's entry turning into a page,
  // core/convert.js) or null (nothing open).
  document.getElementById('bj-page-area').style.display = name === 'page' ? 'flex' : 'none';
  document.getElementById('bj-empty-state').style.display = name ? 'none' : 'flex';
  _bjConvertPane(name === 'converting');
  // Nothing open (the empty state): View / Edit and Export PDF have nothing to
  // act on (Export only said "No entry selected."); dimmed until an entry opens.
  var _nbRoot = document.getElementById('bj-root'); if (_nbRoot) _nbRoot.classList.toggle('nb-noentry', !name);
  // Page toolbar edit-mode sync
  const pt = document.getElementById('bj-page-toolbar');
  if (pt) { if (name === 'page' && isEditMode) pt.classList.add('edit-mode'); else pt.classList.remove('edit-mode'); }
}

function loadActiveEntry() {
  if (_bjHidden) return;
  const entry = getActive();
  // Nothing painted for any entry yet — see _bjDomOwner. Cleared BEFORE the early
  // returns below, so the blank editor they leave behind can never be read back as
  // an entry's new content.
  _bjDomOwner = null;
  if (!entry) { document.getElementById('bj-entry-title-input').value = ''; showTemplate(null); if (_bjIsOJ() && window.OJ) window.OJ.painted('bj', null); return; }
  // A shared entry's content is fetched on first open (only the index is kept
  // live for the whole list). The engine calls back here once it has it.
  if (_bjIsOJ() && window.OJ && !window.OJ.isLoaded(entry)) {
    document.getElementById('bj-entry-title-input').value = entry.title || '';
    showTemplate(null);
    window.OJ.open('bj', entry);
    return;
  }
  // Lock guard: if entry is locked and not yet unlocked this session, show lock screen — no content
  if (window._bjGetLock && window._bjGetLock(entry.id) && !(window._bjIsUnlocked && window._bjIsUnlocked(entry.id))) {
    document.getElementById('bj-entry-title-input').value = '';
    showTemplate(null);
    if (window._bjLockCheck) window._bjLockCheck();
    return;
  }
  // An entry that has come back empty while a local copy of its content survives is
  // healed here, before it is painted — otherwise the blank paint is what the next
  // save would publish. Only ever fills an EMPTY entry. See JGuard.recover.
  if (window.JGuard && window.JGuard.recover('bj', entry)) { entry.updated = Date.now(); _bjWriteCache(); }
  document.getElementById('bj-entry-title-input').value = entry.title;
  // Made with a template that is gone: it becomes a page first (core/convert.js),
  // then opens as one.
  if (window.NotebookConvert && window.NotebookConvert.legacy(entry)) {
    showTemplate('converting');
    _bjConvertOne(entry).then(function (ok) { if (state.activeId === entry.id && getActive() === entry && (ok || !window.NotebookConvert.legacy(entry))) loadActiveEntry(); });
    return;
  }
  showTemplate(entry.template);
  if (entry.template === 'page') {
    const ed = document.getElementById('bj-page-editor');
    const html = entry.data.html || '';
    ed.innerHTML = html;
    ed.contentEditable = isEditMode ? 'true' : 'false';
    updatePageToolbarState();
    if (window._docxOnLoad) window._docxOnLoad('bj-page-editor', entry.id);
    // Rebind image handlers lost when innerHTML was set
    ed.querySelectorAll('.pg-img-wrap').forEach(_pgBindImgWrap);
    if (html.includes('bj-fbimg://') && window._fbRehydratePageImages) {
      window._fbRehydratePageImages(html).then(rehydrated => {
        if (rehydrated !== html) {
          ed.innerHTML = rehydrated; if (window._docxUnnestHeadings) window._docxUnnestHeadings(ed);
          entry.data.html = rehydrated;
          // Rebind again after rehydration replaces innerHTML
          ed.querySelectorAll('.pg-img-wrap').forEach(_pgBindImgWrap);
        }
      });
    }
  }
  // The DOM now genuinely shows THIS entry, so saveCurrentEntry may read it. Last
  // line on purpose: everything above either paints or bails, and a save that lands
  // mid-paint must find the editor still marked as nobody's.
  _bjDomOwner = entry.id;
  if (_bjIsOJ() && window.OJ) window.OJ.painted('bj', entry);
}

function saveCurrentEntry() {
  const entry = getActive(); if (!entry) return;
  clearTimeout(autoTimer); _bjAutoFirstAt = 0;   // this IS the save the pending timer was for
  const _userEdit = _bjUserEdited; _bjUserEdited = false;
  // GUARD: a locked entry not yet unlocked on THIS device has its inputs blanked
  // (or showing another entry's content). Persisting that DOM would erase the
  // real content and sync the wipe to every device. Skip entirely — unlocking
  // re-renders from the intact synced state.
  if (window._bjGetLock && window._bjGetLock(entry.id) && !(window._bjIsUnlocked && window._bjIsUnlocked(entry.id))) return;
  // GUARD (DOM ownership): the templates share one set of DOM nodes, so reading
  // them for an entry they were not painted for files the previous entry's content
  // — or a blank, still-loading editor — under this id, and the whole-entry cloud
  // write then propagates it everywhere. loadActiveEntry() stamps the id it painted.
  if (_bjDomOwner !== entry.id) return;

  // Read the DOM into a PROPOSED copy of data rather than straight into the entry,
  // so the two guards below can still refuse it. Nothing is committed until both pass.
  const _next = Object.assign({}, entry.data);
  if (_bjPendingMargins && _bjPendingMargins.id === entry.id) _next.margins = _bjPendingMargins.m;
  // Only a page is ever painted (an old template's entry is converted first).
  if (entry.template !== 'page') return;
  _next.html = document.getElementById('bj-page-editor').innerHTML;

  // Auto-title: derive from content while the title is empty; a user-typed title
  // always wins. Read from the PROPOSED data above, not the stored data — otherwise a title taken from the
  // editor is always one save out of date.
  let _title = document.getElementById('bj-entry-title-input').value;
  if (!_title.trim()) {
    const _auto = _bjAutoTitle(entry, _next);
    if (_auto) {
      _title = _auto;
      const _ti = document.getElementById('bj-entry-title-input');
      if (_ti && document.activeElement !== _ti) _ti.value = _auto;
    }
  }

  // GUARD (blank overwrite): never let an empty field replace stored content unless
  // this save came from a real edit. A genuine select-all-and-delete goes through
  // autoSave (_userEdit === true) and passes straight through — with the previous
  // version kept locally first, so even that stays reversible.
  if (window.JGuard && window.JGuard.wouldLose(entry.template, entry.data, _next)) {
    if (!_userEdit) {
      console.warn('[JGuard] refused a blank overwrite of bj entry ' + entry.id + ' (editor was not user-edited)');
      return;
    }
    window.JGuard.backup('bj', entry, _next);
    // A deliberate clear must not be undone by recovery on the next open.
    if (window.JGuard.emptyData(entry.template, _next)) window.JGuard.markCleared('bj', entry.id);
  }

  // GUARD (no-op): only stamp `updated` when something ACTUALLY changed — the remote
  // merge resolves conflicts on that timestamp, so a no-op save on a session holding
  // stale content used to make the stale copy the permanent winner.
  if (window.JGuard && window.JGuard.sig(entry.template, entry.data, entry.title) ===
                       window.JGuard.sig(entry.template, _next, _title)) {
    // Nothing new to save: autoSave already said Syncing, so say Synced again
    // unless some entry is still waiting for the cloud to confirm it.
    if (!state.entries.some(function (x) { return x._dirty; })) _bjSetSync('synced');
    return;
  }

  entry.title = _title;
  // Merged in place rather than reassigned (the entry's data object is shared by reference).
  Object.assign(entry.data, _next);
  if (_bjPendingMargins && _bjPendingMargins.id === entry.id) _bjPendingMargins = null;
  entry.updated = Date.now();
  // rev counts committed content changes, which is how two copies of an entry get
  // ordered WITHOUT trusting a device clock — see the merge rules in applyRemote.
  entry.rev = (entry.rev || 0) + 1;
  // Unsynced until the cloud confirms it. Nothing arriving from a remote view may
  // overwrite an entry in this state, and an authoritative resync will push it.
  entry._dirty = true;
  saveState(); renderSidebar();
}

// First meaningful content line → title (max 60 chars)
function _bjAutoTitle(entry, dataOverride) {
  const d = dataOverride || entry.data || {};
  let src = '';
  if (entry.template === 'page') { const ed = document.getElementById('bj-page-editor'); src = ed && ed.innerText ? ed.innerText : String(d.html||'').replace(/<[^>]*>/g,'\n'); }
  const line = (src||'').split('\n').map(s=>s.trim()).find(s=>s.length > 1) || '';
  if (!line) return '';
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
}

/* ── PAGE ONLY (2026-11-17) ──────────────────────────────────────────────────
 * Every entry made with a template that is gone (Whiteboard, Mind Map, the old
 * canvas Mind Map, Notes, Cornell) becomes a page: core/convert.js builds its
 * page and backs the entry up first (dashboards/journal_legacy_<id>); here it
 * is saved like any edit. Veda's own entries convert as soon as they are
 * loaded; an OurJournal entry when it is opened (its content arrives then). */
var _bjConverting = {};
function _bjConvertPane(on) {
  var pane = document.getElementById('bj-convert-pane');
  if (!pane && on) {
    pane = document.createElement('div');
    pane.id = 'bj-convert-pane';
    pane.className = 'nb-convert-pane';
    pane.innerHTML = '<div class="nb-convert-spin" aria-hidden="true"></div><div class="nb-convert-t">Turning this into a page…</div><div class="nb-convert-s">Whiteboards and mind maps become a picture with their words. The original is kept as a backup.</div>';
    var area = document.getElementById('bj-content-area'); if (area) area.appendChild(pane);
  }
  if (pane) pane.style.display = on ? 'flex' : 'none';
}
function _bjConvertOne(e) {
  var C = window.NotebookConvert;
  if (!C || !C.legacy(e) || _bjIsPinned(e.id)) return Promise.resolve(false);
  if (_bjConverting[e.id]) return _bjConverting[e.id];
  var shared = !!(_bjOJState && _bjOJState.entries.indexOf(e) >= 0);
  var prefix = shared && window.OJ ? window.OJ.NS : 'journal';
  var p = C.backup(prefix, e).then(function (backedUp) {
    if (!backedUp) return false;
    return C.page(e, { app: 'bj', prefix: 'journal', prefixFor: function () { return prefix; }, chipClass: 'bj-file-chip' }).then(function (html) {
      if (html == null || !C.legacy(e)) return false;
      // Still in the collection it was converted for? (a remote copy may have
      // replaced the object meanwhile: convert that one on the next pass.)
      var coll = shared ? _bjOJState : null;
      var write = function () {
        var cur = state.entries.find(function (x) { return x.id === e.id; });
        if (cur !== e) return false;
        e.template = 'page';
        e.data = { html: html, attachments: [] };
        delete e.vizRev; delete e.vizCount; delete e.vizKind; delete e.vizTitle;
        e.updated = Date.now(); e.rev = (e.rev || 0) + 1; e._dirty = true;
        saveState(); renderSidebar();
        if (state.activeId === e.id && !_bjHidden) loadActiveEntry();
        _bjFbSaveEntry(e);
        return true;
      };
      if (shared) return (coll && state === coll) ? write() : false;   // OurJournal writes only while it is on screen
      return _bjWithPersonal(write);
    });
  }).catch(function (err) { console.warn('[BJ] conversion failed, entry left as it is:', e.id, err); return false; })
    .then(function (r) { delete _bjConverting[e.id]; return r; });
  _bjConverting[e.id] = p;
  return p;
}
// Veda's own entries, one after another, in the background.
var _bjConvertRun = null;
function _bjConvertAll() {
  if (_bjConvertRun || !window.NotebookConvert || !window._fbViz) return;
  var todo = [];
  _bjWithPersonal(function () { state.entries.forEach(function (e) { if (window.NotebookConvert.legacy(e)) todo.push(e); }); });
  if (!todo.length) return;
  _bjConvertRun = todo.reduce(function (p, e) { return p.then(function () { return _bjConvertOne(e); }); }, Promise.resolve())
    .then(function () { _bjConvertRun = null; }, function () { _bjConvertRun = null; });
}
window._bjConvertAll = _bjConvertAll;

/* PAGE EDITOR */
function updatePageToolbarState() {
  if (!document.getElementById('bj-page-area') || document.getElementById('bj-page-area').style.display === 'none') return;
  const cmds = ['bold','italic','underline','strikeThrough'];
  const ids   = ['bj-pt-bold','bj-pt-italic','bj-pt-underline','bj-pt-strike'];
  cmds.forEach((cmd,i) => {
    const btn = document.getElementById(ids[i]);
    if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
  });
  // Sync block selector
  const sel = document.getElementById('bj-pt-block');
  if (!sel) return;
  const node = window.getSelection()?.anchorNode;
  if (!node) return;
  let el = node.nodeType === 3 ? node.parentElement : node;
  const tag = el.tagName ? el.tagName.toLowerCase() : 'p';
  const map = {h1:'h1',h2:'h2',h3:'h3',pre:'pre',blockquote:'blockquote'};
  sel.value = map[tag] || 'p';
  // Sync font-size selector: read computed size at cursor
  const fsSel = document.getElementById('bj-pt-fontsize');
  if (fsSel) {
    const computedPx = parseFloat(window.getComputedStyle(el).fontSize);
    const rounded = Math.round(computedPx);
    const SIZES = ['10','12','14','16','18','20','24','28','32','36','48','64'];
    // Find closest matching size option
    const match = SIZES.reduce(function(best, s) {
      return Math.abs(parseInt(s) - rounded) < Math.abs(parseInt(best) - rounded) ? s : best;
    }, SIZES[0]);
    fsSel.value = (Math.abs(parseInt(match) - rounded) <= 2) ? match : '';
  }
}

function pgCmd(cmd, val) {
  document.getElementById('bj-page-editor').focus();
  document.execCommand(cmd, false, val || null);
  autoSave();
}

function pgWrapBlock(tag) {
  const ed = document.getElementById('bj-page-editor');
  ed.focus();
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  // Find block ancestor inside editor
  let node = sel.anchorNode;
  while (node && node !== ed) {
    if (node.nodeType === 1 && ['P','H1','H2','H3','PRE','BLOCKQUOTE','LI','DIV'].includes(node.tagName)) break;
    node = node.parentNode;
  }
  if (!node || node === ed) {
    document.execCommand('formatBlock', false, tag);
  } else {
    const newEl = document.createElement(tag);
    node.parentNode.replaceChild(newEl, node);
    newEl.appendChild(node.childNodes.length ? node : document.createTextNode('\u200B'));
    const r2 = document.createRange();
    r2.selectNodeContents(newEl);
    r2.collapse(false);
    sel.removeAllRanges(); sel.addRange(r2);
  }
  updatePageToolbarState(); autoSave();
}

// Compress an image dataURL to JPEG at max 1200px wide, quality 0.82
function _bjCompressImage(src, callback) {
  const MAX_W = 1200, QUALITY = 0.82;
  const img = new Image();
  img.onload = function() {
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > MAX_W) { h = Math.round(h * MAX_W / w); w = MAX_W; }
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    callback(cv.toDataURL('image/jpeg', QUALITY));
  };
  img.onerror = function() { callback(src); }; // fallback: use original
  img.src = src;
}

// Bind all interactive handlers to a pg-img-wrap element.
// Called both when inserting a new image AND after ed.innerHTML = html (rebind).
window._bjBindImg = function(w){ return _pgBindImgWrap(w); };
function _pgBindImgWrap(wrap) {
  // Avoid double-binding
  if (wrap._pgBound) return;
  wrap._pgBound = true;
  var img = wrap.querySelector('img');
  var rsz = wrap.querySelector('.pg-img-resize-handle');
  var del = wrap.querySelector('.pg-img-del-handle');
  if (!img || !rsz || !del) return;
  // Resize handle
  rsz.addEventListener('pointerdown', function(e) {
    e.preventDefault(); e.stopPropagation();
    rsz.setPointerCapture(e.pointerId);
    var startX = e.clientX, startW = img.offsetWidth;
    function onMove(ev) {
      var nw = Math.max(60, startW + (ev.clientX - startX));
      img.style.width = nw + 'px';
      img.style.height = '';
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      autoSave();
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
  // Delete handle
  del.addEventListener('pointerdown', function(e) {
    e.preventDefault(); e.stopPropagation();
    wrap.parentNode && wrap.parentNode.removeChild(wrap);
    autoSave();
  });
  // Tap to select (iPad: no hover)
  wrap.addEventListener('pointerdown', function(e) {
    if (e.target === del || e.target === rsz) return;
    var ed = document.getElementById('bj-page-editor');
    ed.querySelectorAll('.pg-img-wrap').forEach(function(w) { w.classList.remove('selected'); });
    wrap.classList.add('selected');
    function onOutside(ev) {
      if (!wrap.contains(ev.target)) { wrap.classList.remove('selected'); document.removeEventListener('pointerdown', onOutside, true); }
    }
    document.addEventListener('pointerdown', onOutside, true);
  });
  // Right-click / long-press: copy image
  wrap.addEventListener('contextmenu', function(e) {
    e.preventDefault(); e.stopPropagation();
    var existing = document.getElementById('_pg_ctx_menu');
    if (existing) existing.remove();
    var menu = document.createElement('div');
    menu.id = '_pg_ctx_menu';
    menu.style.cssText = 'position:fixed;z-index:99999;background:#26272A;border:1px solid #4A4B51;border-radius:7px;padding:4px 0;box-shadow:0 8px 32px rgba(0,0,0,0.55);min-width:160px;font-family:IBM Plex Mono,monospace;font-size:12px;';
    var copyBtn = document.createElement('div');
    copyBtn.innerHTML = window.TNI.copy + '<span>Copy Image</span>';
    copyBtn.style.cssText = 'padding:9px 16px;cursor:pointer;color:#ECECEE;white-space:nowrap;';
    copyBtn.onmouseenter = function() { copyBtn.style.background='rgba(141,118,154,0.15)'; };
    copyBtn.onmouseleave = function() { copyBtn.style.background=''; };
    copyBtn.addEventListener('pointerdown', function(ev) {
      ev.preventDefault();
      menu.remove();
      try {
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        var ctx2 = canvas.getContext('2d'); ctx2.drawImage(img, 0, 0);
        canvas.toBlob(function(blob) {
          if (!blob) return;
          try { navigator.clipboard.write([new ClipboardItem({'image/png': blob})]); } catch(err) { console.warn('Copy failed', err); }
        }, 'image/png');
      } catch(err) { console.warn('Copy failed', err); }
    });
    menu.appendChild(copyBtn);
    var dlBtn = document.createElement('div');
    dlBtn.innerHTML = window.TNI.download + '<span>Download</span>';
    dlBtn.style.cssText = 'padding:9px 16px;cursor:pointer;color:#ECECEE;white-space:nowrap;';
    dlBtn.onmouseenter = function() { dlBtn.style.background='rgba(141,118,154,0.15)'; };
    dlBtn.onmouseleave = function() { dlBtn.style.background=''; };
    dlBtn.addEventListener('pointerdown', function(ev) {
      ev.preventDefault();
      menu.remove();
      try {
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        canvas.toBlob(function(blob) {
          if (!blob) return;
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = (img.getAttribute('alt') || 'image') + '.png';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
        }, 'image/png');
      } catch(err) { console.warn('Download failed', err); }
    });
    menu.appendChild(dlBtn);
    var mx = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : window.innerWidth/2);
    var my = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : window.innerHeight/2);
    menu.style.left = Math.min(mx, window.innerWidth - 180) + 'px';
    menu.style.top  = Math.min(my, window.innerHeight - 60) + 'px';
    document.body.appendChild(menu);
    function dismiss(ev) { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', dismiss, true); } }
    setTimeout(function() { document.addEventListener('pointerdown', dismiss, true); }, 50);
  });
}

function pgInsertImage(src) {
  _bjCompressImage(src, function(compressed) {
    const ed = document.getElementById('bj-page-editor');
    ed.focus();
    const wrap = document.createElement('span');
    wrap.className = 'pg-img-wrap';
    wrap.contentEditable = 'false';
    const img = document.createElement('img');
    img.src = compressed;
    img.alt = 'image';
    img.style.width = '320px';
    const entryId = (state && state.activeId) ? state.activeId : 'noid';
    const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    img.setAttribute('data-bjkey', 'journal_img_' + entryId + '_' + nonce);
    const rsz = document.createElement('span');
    rsz.className = 'pg-img-resize-handle';
    rsz.title = 'Drag to resize';
    const del = document.createElement('span');
    del.className = 'pg-img-del-handle';
    del.innerHTML = window.TNI.x;
    del.title = 'Remove image';
    wrap.appendChild(img);
    wrap.appendChild(rsz);
    wrap.appendChild(del);
    _pgBindImgWrap(wrap);
    const sel = window.getSelection();
    if (sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.insertNode(wrap);
      range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
    } else { ed.appendChild(wrap); }
    autoSave();
  });
}

// Block format selector
(function() {
  var _bjBlkSel = null;
  var blkSel = document.getElementById('bj-pt-block');
  var bjEd2 = document.getElementById('bj-page-editor');
  function saveBlkSel() {
    var s = window.getSelection();
    if (s && s.rangeCount && bjEd2.contains(s.anchorNode)) _bjBlkSel = s.getRangeAt(0).cloneRange();
  }
  blkSel.addEventListener('mousedown', saveBlkSel);
  blkSel.addEventListener('touchstart', saveBlkSel, { passive: true });
  blkSel.addEventListener('change', function() {
    var tag = this.value;
    bjEd2.focus();
    if (_bjBlkSel) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(_bjBlkSel); }
    _bjBlkSel = null;
    pgWrapBlock(tag);
  });
})();

// Font size
// Save selection before font-size select steals focus (critical for iOS)
(function() {
  var _bjFsSel = null;
  var fsSel = document.getElementById('bj-pt-fontsize');
  var bjEd = document.getElementById('bj-page-editor');
  function saveSel() {
    var s = window.getSelection();
    if (s && s.rangeCount && !s.isCollapsed && bjEd.contains(s.anchorNode)) {
      _bjFsSel = s.getRangeAt(0).cloneRange();
    }
  }
  fsSel.addEventListener('mousedown', saveSel);
  fsSel.addEventListener('touchstart', saveSel, { passive: true });
  fsSel.addEventListener('change', function() {
    var px = this.value;
    this.value = '';
    if (!px) return;
    bjEd.focus();
    // Restore saved selection (iOS collapses it when select gets focus)
    if (_bjFsSel) {
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(_bjFsSel);
    }
    _bjFsSel = null;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    document.execCommand('fontSize', false, '7');
    bjEd.querySelectorAll('font[size="7"]').forEach(function(f) {
      var span = document.createElement('span');
      span.style.fontSize = px + 'px';
      span.innerHTML = f.innerHTML;
      f.parentNode.replaceChild(span, f);
      var li = span.closest('li');
      if (li) li.style.fontSize = px + 'px';
    });
    autoSave();
  });
})();

// Prevent toolbar from stealing editor focus/selection on tap (critical for iOS)
// All toolbar buttons use mousedown prevention; color picker and file input exempt
(function() {
  var toolbar = document.getElementById('bj-page-toolbar');
  if (toolbar) {
    toolbar.addEventListener('mousedown', function(e) {
      var t = e.target;
      // Allow color picker and file inputs to receive focus normally
      if (t.type === 'color' || t.type === 'file' || t.type === 'range') return;
      // Allow selects to receive focus (they need it; we handle selection save separately)
      if (t.tagName === 'SELECT') return;
      e.preventDefault();
    });
  }
})();

// Inline format buttons
document.getElementById('bj-pt-bold').addEventListener('click', () => pgCmd('bold'));
document.getElementById('bj-pt-italic').addEventListener('click', () => pgCmd('italic'));
document.getElementById('bj-pt-underline').addEventListener('click', () => pgCmd('underline'));
document.getElementById('bj-pt-strike').addEventListener('click', () => pgCmd('strikeThrough'));
document.getElementById('bj-pt-code').addEventListener('click', () => {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const code = document.createElement('code');
  try { range.surroundContents(code); } catch(e) { pgCmd('insertHTML', '<code>' + range.toString() + '</code>'); }
  autoSave();
});

// Text color
document.getElementById('bj-page-color-pick').addEventListener('input', function() {
  pgCmd('foreColor', this.value);
});

// Lists
document.getElementById('bj-pt-ul').addEventListener('click', () => pgCmd('insertUnorderedList'));
document.getElementById('bj-pt-ol').addEventListener('click', () => pgCmd('insertOrderedList'));

// Alignment
document.getElementById('bj-pt-alignL').addEventListener('click', () => pgCmd('justifyLeft'));
document.getElementById('bj-pt-alignC').addEventListener('click', () => pgCmd('justifyCenter'));
document.getElementById('bj-pt-alignR').addEventListener('click', () => pgCmd('justifyRight'));

// Link
document.getElementById('bj-pt-link').addEventListener('click', async () => {
  const url = await window.uiPrompt('Enter URL:', {title:'Insert link', placeholder:'https://…'});
  if (url) pgCmd('createLink', url);
});

// Divider
// (Paste-markdown modal removed — MD now renders the editor's own text in place.)

document.getElementById('bj-pt-md').addEventListener('click', () => {
  var ed = document.getElementById('bj-page-editor');
  var raw = ed.innerText.trim();
  var html = ed.innerHTML;
  var alreadyRendered = /<(h[1-6]|ul|ol|blockquote|table|pre)\b/i.test(html);
  if (raw.length > 0 && !alreadyRendered) {
    ed.innerHTML = window._mdToHtml(raw);
    if (window._docxRenderMath) window._docxRenderMath(ed);
    autoSave();
  } else {
    // already rendered: convert any raw markdown tables left behind
    var before = ed.innerHTML;
    window._renderMdTables(ed);
    if (window._docxRenderMath) window._docxRenderMath(ed);
    if (ed.innerHTML !== before) { autoSave(); }
  }
});

document.getElementById('bj-pt-hr').addEventListener('click', () => {
  pgCmd('insertHorizontalRule');
});

// Table
document.getElementById('bj-pt-table').addEventListener('click', () => {
  const cols = 3, rows = 3;
  let html = '<table><tr>' + '<th>Header</th>'.repeat(cols) + '</tr>';
  for (let r=0;r<rows-1;r++) { html += '<tr>' + '<td>Cell</td>'.repeat(cols) + '</tr>'; }
  html += '</table><p></p>';
  pgCmd('insertHTML', html);
});

// Image via file picker
document.getElementById('bj-page-img-file').addEventListener('change', function() {
  Array.from(this.files).forEach(function(file) {
    const reader = new FileReader();
    if (file.type.startsWith('image/')) {
      reader.onload = e => { pgInsertImage(e.target.result); };
      reader.readAsDataURL(file);
    } else {
      reader.onload = e => { _bjPageInsertFileChip(file.name, e.target.result, file.type); };
      reader.readAsDataURL(file);
    }
  });
  this.value = '';
});

// A file is kept as a data URL inside a Firestore document (a page's file chip
// in its own image document, an attachment inside the journal's), and a
// document over 1 MiB can never be written: every later save of the entry
// failed with no clear cause. So a file over 650 KB (about 870 KB once
// encoded, under the 900 KB write guard) is refused up front, saying why.
var BJ_FILE_MAX = 650 * 1024;
function _bjFileTooBig(name, dataURL) {
  var s = String(dataURL || '');
  var bytes = Math.floor((s.length - s.indexOf(',') - 1) * 3 / 4);
  if (bytes <= BJ_FILE_MAX) return false;
  window.uiAlert('"' + name + '" is ' + (bytes / 1048576).toFixed(1) + ' MB. Files up to 650 KB can be attached, so it was not added.', { title: 'File too large' });
  return true;
}

// Insert non-image file as downloadable chip in page editor
function _bjPageInsertFileChip(name, dataURL, mimeType) {
  if (_bjFileTooBig(name, dataURL)) return;
  const ed = document.getElementById('bj-page-editor');
  ed.focus();
  const escaped = _bjEsc(name);
  const clip = (window._docxPaperclipSVG || window.TNI.clip);
  const html = '<a class="bj-file-chip" href="' + dataURL + '" download="' + escaped + '" contenteditable="false" style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:var(--card2);border:1px solid var(--border);border-radius:4px;text-decoration:none;color:var(--text2);font-size:11px;font-weight:600;margin:2px 3px;cursor:pointer;">' + clip + '<span class="tj-file-name">' + escaped + '</span></a>';
  document.execCommand('insertHTML', false, html);
  autoSave();
}

// ── DRAG & DROP FILE UPLOAD (pages) ─────────────────────────────────
(function() {
  var DROP_ZONES = [
    { areaId: 'bj-page-area',      zoneId: 'bj-page-drop-zone',    tmpl: 'page'       },
  ];

  

  function processFiles(files, tmpl) {
    Array.from(files).forEach(function(file) {
      var reader = new FileReader();
      reader.onload = function(ev) {
        if (tmpl === 'page') {
          // Mirror existing page file input behavior
          if (file.type.startsWith('image/')) {
            if (typeof pgInsertImage === 'function') pgInsertImage(ev.target.result);
          } else {
            if (typeof _bjPageInsertFileChip === 'function') _bjPageInsertFileChip(file.name, ev.target.result, file.type);
          }
          return;
        }
      };
      reader.readAsDataURL(file);
    });
  }

  DROP_ZONES.forEach(function(cfg) {
    var area = document.getElementById(cfg.areaId);
    var zone = document.getElementById(cfg.zoneId);
    if (!area || !zone) return;

    var dragCount = 0;

    area.addEventListener('dragenter', function(e) {
      if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      dragCount++;
      zone.classList.add('active');
    });

    area.addEventListener('dragover', function(e) {
      if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    area.addEventListener('dragleave', function(e) {
      dragCount--;
      if (dragCount <= 0) { dragCount = 0; zone.classList.remove('active'); }
    });

    area.addEventListener('drop', function(e) {
      e.preventDefault();
      dragCount = 0;
      zone.classList.remove('active');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      var tmpl = cfg.tmpl;
      // Page template: land the dropped file/image at the EXACT drop point (item 10).
      if (tmpl === 'page') {
        var ped = document.getElementById('bj-page-editor');
        if (ped && ped.getAttribute('contenteditable') === 'true' && document.caretRangeFromPoint) {
          var rng = document.caretRangeFromPoint(e.clientX, e.clientY);
          if (rng && ped.contains(rng.startContainer)) { ped.focus(); var s = window.getSelection(); s.removeAllRanges(); s.addRange(rng); }
        }
      }
      processFiles(files, tmpl);
    });
  });

})();

// Image paste from clipboard
document.getElementById('bj-page-editor').addEventListener('paste', function(e) {
  const items = e.clipboardData.items;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      const reader = new FileReader();
      reader.onload = ev => pgInsertImage(ev.target.result);
      reader.readAsDataURL(blob);
      return;
    }
  }
  // Rich paste: preserve formatting (fonts, sizes, colors, lists, tables, links)
  // from Word / Google Docs / web pages via sanitized HTML insertion.
  e.preventDefault();
  const htmlData = e.clipboardData.getData('text/html');
  if (htmlData && window._docxCleanHTML) {
    var _clean = window._docxCleanHTML(htmlData);
    if (window._docxPasteListFix) _clean = window._docxPasteListFix(_clean, document.getElementById('bj-page-editor'));
    document.execCommand('insertHTML', false, _clean);
  } else {
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }
  autoSave();
});

// Update toolbar state on selection change
document.addEventListener('selectionchange', () => {
  const ed = document.getElementById('bj-page-editor');
  if (ed && document.activeElement === ed) updatePageToolbarState();
});

// Clear page
document.getElementById('bj-pt-clear').addEventListener('click', async () => {
  if (!(await window.uiConfirm('Clear all page content?', {danger:true, okLabel:'Clear'}))) return;
  document.getElementById('bj-page-editor').innerHTML = '';
  if (window._docxScrollToTop) window._docxScrollToTop('bj-page-editor');
  autoSave();
});

// Helper: walk up DOM to find a mark/highlighted ancestor within editor


// Highlight palette
(function() {
  var activeHlColor = '#FFE066';
  var palette = document.getElementById('bj-pt-hl-palette');
  var trigger = document.getElementById('bj-pt-hl-trigger');
  var icon = document.getElementById('bj-pt-hl-icon');
  var savedRange = null;

  function _bjSaveRange() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  }
  trigger.addEventListener('mousedown', function(e) {
    _bjSaveRange();
    e.preventDefault();
  });
  // touchstart: block blur so selection survives; do NOT read selection yet (iOS hasn't committed it)
  trigger.addEventListener('touchstart', function(e) {
    e.preventDefault();
  }, { passive: false });
  // Toggle-off: if the selection is already highlighted, clicking the trigger removes it.
  function _bjTriggerToggle() {
    var ed = document.getElementById('bj-page-editor');
    if (savedRange) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
    if (savedRange && !savedRange.collapsed && window._docxSelectionHighlighted && window._docxSelectionHighlighted(ed)) {
      applyHighlight('none', savedRange.cloneRange());
      savedRange = null;
      return true;
    }
    return false;
  }
  // touchend: selection IS committed by now — save it, then toggle-off or open palette
  trigger.addEventListener('touchend', function(e) {
    e.preventDefault(); e.stopPropagation();
    _bjSaveRange();
    if (_bjTriggerToggle()) return;
    palette.classList.add('open');
  }, { passive: false });
  trigger.addEventListener('click', function(e) {
    e.stopPropagation();
    // Desktop: toggle; touchend already handled palette open on mobile
    if ('ontouchend' in window) return;
    if (_bjTriggerToggle()) return;
    palette.classList.toggle('open');
  });

  palette.addEventListener('mousedown', function(e) { e.preventDefault(); });
  palette.addEventListener('touchstart', function(e) { e.preventDefault(); }, { passive: false });
  function _bjApplySwatch(swatch, e) {
    e.stopPropagation();
    var color = swatch.getAttribute('data-color');
    palette.classList.remove('open');
    var rangeToUse = savedRange;
    savedRange = null;
    if (rangeToUse) {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(rangeToUse);
    }
    applyHighlight(color, rangeToUse);
    if (color !== 'none') {
      activeHlColor = color;
      icon.style.background = color;
      palette.querySelectorAll('.pt-hl-swatch').forEach(function(s) {
        s.classList.toggle('active', s.getAttribute('data-color') === color);
      });
    }
  }
  palette.querySelectorAll('.pt-hl-swatch').forEach(function(swatch) {
    swatch.addEventListener('click', function(e) { _bjApplySwatch(swatch, e); });
    swatch.addEventListener('touchend', function(e) { e.preventDefault(); _bjApplySwatch(swatch, e); }, { passive: false });
  });
  // Close palette on outside click/touch
  document.addEventListener('click', function(e) {
    if (!document.getElementById('bj-pt-hl-wrap').contains(e.target)) {
      palette.classList.remove('open');
    }
  });
  document.addEventListener('touchend', function(e) {
    if (!document.getElementById('bj-pt-hl-wrap').contains(e.target)) {
      palette.classList.remove('open');
    }
  }, { passive: true });

  // Dark text color for each highlight bg to ensure contrast
  var HL_TEXT = {
    '#FFE066': '#2a2000',
    '#A8F0B0': '#082b0e',
    '#A8D8FF': '#052240',
    '#FFB3C6': '#3a0012',
    '#F9C784': '#2d1a00',
    '#D4B0FF': '#1e0050'
  };

  function applyHighlight(color, rangeArg) {
    var ed = document.getElementById('bj-page-editor');
    // Use passed range if available (avoids ed.focus() collapsing selection)
    var range = rangeArg;
    if (!range) {
      ed.focus();
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      range = sel.getRangeAt(0).cloneRange();
    }
    if (color === 'none') {
      // Robust removal (handles <mark> AND background-color spans) via the shared stripper.
      if (window._docxStripHighlight) {
        window._docxStripHighlight(ed, range.cloneRange());
      }
      window.getSelection().removeAllRanges();
      autoSave();
      return;
    }
    // Apply highlight — need focus + live selection for execCommand fallback
    ed.focus();
    var liveSel = window.getSelection();
    // Re-apply the range so it's the live selection
    liveSel.removeAllRanges();
    liveSel.addRange(range);
    var textColor = HL_TEXT[color] || '#111111';
    var mark = document.createElement('mark');
    mark.setAttribute('data-bj-hl', '1');
    mark.style.background = color;
    mark.style.color = textColor;
    mark.style.borderRadius = '2px';
    mark.style.padding = '0 1px';
    var insertedMark = null;
    try {
      range.surroundContents(mark);
      insertedMark = mark;
    } catch(ex) {
      var html = '<mark data-bj-hl="1" style="background:' + color + ';color:' + textColor + ';border-radius:2px;padding:0 1px">' + range.toString() + '</mark>';
      document.execCommand('insertHTML', false, html);
    }
    // Collapse cursor AFTER mark so continued typing is unhighlighted
    liveSel = window.getSelection();
    if (insertedMark && insertedMark.parentNode) {
      var afterRange = document.createRange();
      afterRange.setStartAfter(insertedMark);
      afterRange.collapse(true);
      liveSel.removeAllRanges();
      liveSel.addRange(afterRange);
    } else if (liveSel.rangeCount) {
      liveSel.getRangeAt(0).collapse(false);
    }
    autoSave();
  }
  window._bjApplyHighlight = applyHighlight;
})();

// Keyboard shortcuts inside page editor
document.getElementById('bj-page-editor').addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey)) {
    if (e.key==='b') { e.preventDefault(); pgCmd('bold'); }
    if (e.key==='i') { e.preventDefault(); pgCmd('italic'); }
    if (e.key==='u') { e.preventDefault(); pgCmd('underline'); }
  }
    if (e.key === 'Enter') {
      e.preventDefault();
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) { document.execCommand('insertParagraph'); if (typeof autoSave === 'function') autoSave(); return; }
      var editor = document.getElementById('bj-page-editor');
      var n = sel.getRangeAt(0).commonAncestorContainer;
      var codeEl = null, preEl = null, bqEl = null;
      while (n && n !== editor) {
        if (n.nodeName === 'CODE') codeEl = n;
        if (n.nodeName === 'BLOCKQUOTE') bqEl = n;
        if (n.nodeName === 'PRE') { preEl = n; break; }
        n = n.parentNode;
      }
      if (preEl && !e.shiftKey) {
        // Exit <pre> block: DOM-insert a new <p> after it, place caret inside
        var r = sel.getRangeAt(0); if (!r.collapsed) r.deleteContents();
        var newP = document.createElement('p');
        newP.appendChild(document.createElement('br'));
        if (preEl.parentNode) preEl.parentNode.insertBefore(newP, preEl.nextSibling);
        var nr = document.createRange();
        nr.setStart(newP, 0); nr.collapse(true);
        sel.removeAllRanges(); sel.addRange(nr);
        newP.focus && newP.focus();
      } else if (preEl && e.shiftKey) {
        // Stay in <pre>: insert newline; execCommand handles trailing-newline rendering correctly
        var r = sel.getRangeAt(0); if (!r.collapsed) r.deleteContents();
        document.execCommand('insertText', false, '\n');
      } else if (codeEl && !e.shiftKey) {
        // Exit inline <code>: DOM-insert new <p> after its block parent
        var r = sel.getRangeAt(0); if (!r.collapsed) r.deleteContents();
        var newP = document.createElement('p');
        newP.appendChild(document.createElement('br'));
        if (codeEl.parentNode) codeEl.parentNode.insertBefore(newP, codeEl.nextSibling);
        var nr = document.createRange();
        nr.setStart(newP, 0); nr.collapse(true);
        sel.removeAllRanges(); sel.addRange(nr);
      } else if (bqEl && !e.shiftKey) {
        // Exit blockquote: Enter escapes the box (new <p> after it) — never leaves a blank line inside
        var r = sel.getRangeAt(0); if (!r.collapsed) r.deleteContents();
        var newP = document.createElement('p');
        newP.appendChild(document.createElement('br'));
        if (bqEl.parentNode) bqEl.parentNode.insertBefore(newP, bqEl.nextSibling);
        var nr = document.createRange();
        nr.setStart(newP, 0); nr.collapse(true);
        sel.removeAllRanges(); sel.addRange(nr);
      } else if (bqEl && e.shiftKey) {
        // Stay inside the box: soft line break
        document.execCommand('insertLineBreak');
      } else {
        document.execCommand(e.shiftKey ? 'insertLineBreak' : 'insertParagraph');
      }
      if (typeof autoSave === 'function') autoSave();
    }
});

/* AUTO-SAVE */
let autoTimer=null;
let _bjAutoFirstAt = 0;   // when the current unsaved burst of edits began
function autoSave() {
  // Only real editing reaches here (input, paste, toolbar command, undo), which is
  // what makes this the signal that a blank editor is a deliberate clear rather
  // than an unpainted one — see the blank-overwrite guard in saveCurrentEntry.
  _bjUserEdited = true;
  _bjSetSync('syncing');
  const _now = Date.now();
  if (!_bjAutoFirstAt) _bjAutoFirstAt = _now;
  clearTimeout(autoTimer);
  // MAX WAIT. The debounce restarts on every keystroke, so a long uninterrupted
  // burst of typing reached neither localStorage nor the cloud until the user
  // paused — a crash mid-paragraph lost all of it. However long the burst runs, the
  // entry is now persisted at least every 1.5s.
  autoTimer = setTimeout(saveCurrentEntry, (_now - _bjAutoFirstAt >= 1500) ? 0 : 700);
}
// Persist the current entry synchronously RIGHT NOW: flush the pending autoSave
// (DOM→state), then flush the pending Firebase write. Called on tab-hide/close so the
// last few hundred ms of typing (still inside the debounce) can't be lost.
window._bjPersistNow = function() {
  try { clearTimeout(autoTimer); if (getActive()) saveCurrentEntry(); } catch(e) {}
  try { return _bjFbFlush(); } catch(e) {}
};
// Open an entry from outside (Notebook.open): what a click on its sidebar row
// does, then edit or view mode if asked. Waits for the entry to arrive from the
// server (a host may ask before the first load). Resolves false if it never does,
// or if a newer open call took over while it waited.
// Notebook.putPage: a host writes one page of its own (StudyOS's generated
// notes). A page the store lacks is made (in p.folder, else the folder on
// screen); one it has takes the new title, html, tags, folder and host data
// that are given, as an edit would: a new revision, saved and synced like any
// edit, out of the Trash if it was there. The page being edited is saved
// first and repainted after. A pinned page, or one that is not a plain page,
// is refused (null). Returns a copy of the page as stored.
window._bjPutEntry = function(p) {
  if (!p || !p.id || /[.\/~*\[\]]/.test(String(p.id)) || _bjIsPinned(p.id)) return null;
  return _bjWithPersonal(function() {
    var now = Date.now(), e = state.entries.find(function(x) { return x.id === p.id; });
    if (e && e.template !== 'page') return null;
    var open = !_bjHidden && state.activeId === p.id;
    if (open) { try { clearTimeout(autoTimer); saveCurrentEntry(); } catch (err) {} }
    if (!e) {
      e = { id: String(p.id), title: '', template: 'page', created: p.created || now, updated: now, tags: [], data: { html: '', attachments: [] }, rev: 0 };
      var f = p.folder !== undefined ? p.folder : _bjFolder;
      if (f != null && f !== '') e.folder = String(f);
      state.entries.unshift(e);
      // Made again on purpose: no longer a page this device purged.
      if (Array.isArray(state.deletedIds)) state.deletedIds = state.deletedIds.filter(function(id) { return id !== e.id; });
    } else if (p.folder !== undefined) {
      if (p.folder == null || p.folder === '') delete e.folder; else e.folder = String(p.folder);
    }
    if (p.title !== undefined) e.title = String(p.title == null ? '' : p.title);
    if (Array.isArray(p.tags)) e.tags = p.tags.map(String);
    if (p.data && typeof p.data.html === 'string') e.data = Object.assign({ attachments: [] }, e.data || {}, { html: p.data.html });
    if (p.host && typeof p.host === 'object') e.host = JSON.parse(JSON.stringify(p.host));
    if (e.trashed) { delete e.trashed; e.trashChangedAt = now; }
    e.updated = now; e.rev = (e.rev || 0) + 1; e._dirty = true;
    saveState(); renderSidebar();
    if (open) loadActiveEntry();
    _bjFbSaveEntry(e);
    var out = JSON.parse(JSON.stringify(e)); delete out._dirty; delete out._fbPushed;
    return out;
  });
};
// Notebook.pages / Notebook.page: the pages, read from outside (Neo answers
// questions about them). The personal journal's, even with OurJournal on
// screen. A page with its own lock, not opened in this session, is listed
// with locked: true and never gives its words.
function _bjPageMeta(e) {
  var locked = !!(window._bjGetLock && window._bjGetLock(e.id)) && !(window._bjIsUnlocked && window._bjIsUnlocked(e.id));
  return { id: e.id, title: e.title || '', template: e.template || 'page', folder: e.folder || null, tags: (e.tags || []).slice(),
    created: e.created || 0, updated: e.updated || 0, pinned: _bjIsPinned(e.id), locked: locked };
}
window._bjPages = function() {
  return _bjWithPersonal(function() { return state.entries.filter(function(e) { return e && !e.trashed; }).map(_bjPageMeta); });
};
window._bjGetPage = function(id) {
  return _bjWithPersonal(function() {
    var e = state.entries.find(function(x) { return x && x.id === id && !x.trashed; });
    if (!e) return null;
    var m = _bjPageMeta(e);
    if (!m.locked) m.data = JSON.parse(JSON.stringify(e.data || {}));
    return m;
  });
};
let _bjOpenSeq = 0;
window._bjOpenEntry = function(id, opts) {
  opts = opts || {};
  const seq = ++_bjOpenSeq;
  return new Promise(function(resolve) {
    var tries = 0;
    (function attempt() {
      if (seq !== _bjOpenSeq) { resolve(false); return; }
      // A page pinned since the mount (Notebook.pin) is made here, as the list would.
      if (_bjIsPinned(id) && !state.entries.some(function(x) { return x.id === id; })) _bjPinFirst();
      var e = state.entries.find(function(x) { return x.id === id && !x.trashed; });
      if (!e) { if (++tries < 80) setTimeout(attempt, 100); else resolve(false); return; }
      if (state.activeId !== id) { saveCurrentEntry(); _bjFbFlush(); state.activeId = id; renderSidebar(); loadActiveEntry(); }
      if (opts.edit !== undefined && !!opts.edit !== isEditMode) setEditMode(!!opts.edit);
      resolve(true);
    })();
  });
};
document.getElementById('bj-entry-title-input').addEventListener('input', autoSave);
document.getElementById('bj-page-editor').addEventListener('input', autoSave);

/* KEYBOARD SHORTCUTS */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault(); saveCurrentEntry();
  }
});

/* EDIT MODE */
let isEditMode = false;
function setEditMode(enabled) {
  isEditMode = enabled;
  const checkbox = document.getElementById('bj-btn-edit');
  checkbox.checked = enabled;
  const modeLabel = document.getElementById('bj-mode-label');
  if (modeLabel) {
    modeLabel.textContent = enabled ? 'EDIT' : 'VIEW';
    modeLabel.classList.toggle('edit-active', enabled);
  }
  const titleIn = document.getElementById('bj-entry-title-input');
  if (titleIn) titleIn.readOnly = !enabled;
  // Page editor
  const pgEd = document.getElementById('bj-page-editor');
  if (pgEd) pgEd.contentEditable = enabled ? 'true' : 'false';
  const pgTb = document.getElementById('bj-page-toolbar');
  if (pgTb) {
    const activeEntry = getActive();
    if (enabled && activeEntry && activeEntry.template === 'page') pgTb.classList.add('edit-mode');
    else pgTb.classList.remove('edit-mode');
  }
  // Sync bottom bar edit button label
  const bbEdit = document.getElementById('bj-bb-edit');
  if (bbEdit) bbEdit.innerHTML = enabled ? window.TNI.check + '<span>Done</span>' : window.TNI.pencil + '<span>Edit</span>';
  if (enabled && window._docxRefreshRulers) window._docxRefreshRulers('bj');
}

/* ── Fast touch response for all BJ toolbar controls ──
   iOS/iPadOS adds ~300ms delay to click/change events even with touch-action:manipulation
   on label elements. We intercept touchstart, act immediately, and preventDefault to
   stop the ghost click from double-firing. A simple flag guards each handler. */
(function() {
  function fastTouch(el, handler) {
    if (!el) return;
    var pending = false;
    el.addEventListener('touchstart', function(e) {
      e.preventDefault(); // kill 300ms delay + ghost click
      pending = true;
      handler.call(el, e);
    }, { passive: false });
    el.addEventListener('click', function(e) {
      if (pending) { pending = false; return; } // already handled by touchstart
      handler.call(el, e);
    });
  }

  /* Mode toggle label — touchstart fires setEditMode instantly */
  var modeLabel = document.querySelector('#bj-root .mode-toggle');
  if (modeLabel) {
    var pending = false;
    modeLabel.addEventListener('touchstart', function(e) {
      e.preventDefault();
      pending = true;
      var cb = document.getElementById('bj-btn-edit');
      cb.checked = !cb.checked;
      setEditMode(cb.checked);
    }, { passive: false });
    // Suppress the ghost click that would double-toggle
    modeLabel.addEventListener('click', function(e) {
      if (pending) { pending = false; e.preventDefault(); return; }
      // mouse click path — let change event on checkbox fire normally
    });
  }

  /* bj-btn-export-pdf */
  (function() {
    var bjExportBtn = document.getElementById('bj-btn-export-pdf');
    if (bjExportBtn) bjExportBtn.onclick = function() {
      var entry = getActive();
      if (!entry) { (window.uiAlert || window.alert)('No entry selected.'); return; }
      if (window._bjGetLock && window._bjGetLock(entry.id) && !(window._bjIsUnlocked && window._bjIsUnlocked(entry.id))) { return; }
      exportEntryAsPDF(entry);
    };
  })();

  /* bj-fullscreen-btn */
  fastTouch(document.getElementById('bj-fullscreen-btn'), function() {
    var root = document.getElementById('bj-root');
    var isFs = root.classList.toggle('bj-fullscreen');
    var show = document.getElementById('bj-fs-icon-show');
    var hide = document.getElementById('bj-fs-icon-hide');
    if (show) show.style.display = isFs ? '' : 'none';
    if (hide) hide.style.display = isFs ? 'none' : '';
  });

  /* bj-new-entry-btn */
  fastTouch(document.getElementById('bj-new-entry-btn'), function() {
    document.getElementById('bj-new-entry-btn')._creating = true;
    document.getElementById('bj-template-modal').classList.add('open');
  });

  /* Bottom bar buttons */
  var bjBbEditBtn = document.getElementById('bj-bb-edit');
  fastTouch(bjBbEditBtn, function() {
    var checkbox = document.getElementById('bj-btn-edit');
    if (checkbox) {
      checkbox.checked = !checkbox.checked;
      setEditMode(checkbox.checked);
      bjBbEditBtn.innerHTML = checkbox.checked ? window.TNI.check + '<span>Done</span>' : window.TNI.pencil + '<span>Edit</span>';
    }
  });

  fastTouch(document.getElementById('bj-bb-new'), function() {
    document.getElementById('bj-new-entry-btn')._creating = true;
    document.getElementById('bj-template-modal').classList.add('open');
  });
})();

/* TOOLBAR — mouse/keyboard change handler (touchstart path handled above) */
document.getElementById('bj-btn-edit').addEventListener('change', function() { setEditMode(this.checked); });
// Escape closes the template picker (it only closed on X or a click outside).
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  var m = document.getElementById('bj-template-modal');
  if (!m || !m.classList.contains('open')) return;
  e.preventDefault(); e.stopPropagation();
  document.getElementById('bj-close-modal').click();
}, true);
document.getElementById('bj-close-modal').addEventListener('click', () => {
  document.getElementById('bj-new-entry-btn')._creating=false;
  document.getElementById('bj-template-modal').classList.remove('open');
});
document.getElementById('bj-template-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('bj-template-modal')) {
    document.getElementById('bj-new-entry-btn')._creating=false;
    document.getElementById('bj-template-modal').classList.remove('open');
    return;
  }
  const card=e.target.closest('.template-card'); if (!card) return;
  const tmpl=card.dataset.template;
  document.getElementById('bj-template-modal').classList.remove('open');
  document.getElementById('bj-new-entry-btn')._creating=false;
  // Always create a new entry — never mutate/wipe the current one. Flush the entry
  // we're leaving BEFORE createEntry reschedules the debounce onto the new one.
  saveCurrentEntry(); _bjFbFlush(); createEntry(tmpl); saveState(); renderSidebar(); loadActiveEntry();
  setEditMode(true);
});
document.getElementById('bj-new-entry-btn').addEventListener('click', () => {
  document.getElementById('bj-new-entry-btn')._creating=true;
  document.getElementById('bj-template-modal').classList.add('open');
});
// One template on this side (Page): + makes a page straight away, no picker.
// (A host's templates option can still offer more; then the picker shows.)
new MutationObserver(function () {
  var m = document.getElementById('bj-template-modal');
  if (!m.classList.contains('open')) return;
  var cards = Array.prototype.filter.call(m.querySelectorAll('.template-card'), function (c) { return getComputedStyle(c).display !== 'none'; });
  if (cards.length === 1) cards[0].click();
}).observe(document.getElementById('bj-template-modal'), { attributes: true, attributeFilter: ['class'] });
document.getElementById('bj-search-box').addEventListener('input', renderSidebar);
// The search box's clear button: shown only while there is text; one click
// empties it, re-lists every entry and leaves the cursor in the box.
(function() {
  var box = document.getElementById('bj-search-box'), x = document.getElementById('bj-search-clear');
  if (!box || !x) return;
  var sync = function() { x.hidden = !box.value; };
  box.addEventListener('input', sync);
  // Code that empties the box (a folder change, OurJournal) sets .value and
  // fires nothing: re-check whenever the list redraws.
  new MutationObserver(sync).observe(document.getElementById('bj-entries-list'), { childList: true });
  box.addEventListener('keydown', function(e) { if (e.key === 'Escape' && box.value) { e.preventDefault(); e.stopPropagation(); box.value = ''; sync(); renderSidebar(); } });
  x.addEventListener('pointerdown', function(e) { e.preventDefault(); });   // keep the box focused
  x.addEventListener('click', function() { box.value = ''; sync(); renderSidebar(); box.focus(); });
})();

loadState(); purgeExpiredTrash();
// Mounted on a folder: open that folder's page, not the last one open anywhere.
if (_bjFolder !== null && !_bjInFolder(getActive())) state.activeId = _bjFirstLive();
renderSidebar(); loadActiveEntry(); setEditMode(false);

// Notebook.folder(key, id): show folder id (null: every page). The page being
// edited is saved first; the folder's last open page (or its first) opens.
window._bjSetFolder = function(folder) {
  folder = (folder == null || folder === '') ? null : String(folder);
  if (folder === _bjFolder) return true;
  if (_bjIsOJ()) _bjOJLeave();
  try { saveCurrentEntry(); } catch (e) {}
  try { _bjFbFlush(); } catch (e) {}
  if (_bjFolder !== null && state.activeId) _bjFolderActive[_bjFolder] = state.activeId;
  _bjFolder = folder; _bjCfg.folder = folder;
  var sb = document.getElementById('bj-search-box'); if (sb) sb.value = '';
  var back = folder !== null && _bjFolderActive[folder];
  if (back && state.entries.some(function(e) { return e.id === back && !e.trashed; })) state.activeId = back;
  else if (!getActive() || getActive().trashed || !_bjInFolder(getActive())) state.activeId = _bjFirstLive();
  renderSidebar(); loadActiveEntry();
  return true;
};

/* ── OurJournal tab ──────────────────────────────────────────────────────────
 * Two tabs at the top of the sidebar: OurJournal (shared with Tony) and Journal
 * (Veda's own). Switching flushes whatever is being edited, then swaps which
 * collection `state` is; the templates, editor and theme are this app's own. */
function _bjModeUI() {
  var on = _bjIsOJ();
  var root = document.getElementById('bj-root');
  if (root) root.classList.toggle('oj-on', on);
  document.querySelectorAll('#bj-oj-rail .oj-tab').forEach(function(b) {
    var mine = b.getAttribute('data-oj') === '1';
    b.classList.toggle('on', mine === on);
    b.setAttribute('aria-selected', mine === on ? 'true' : 'false');
  });
  var sb = document.getElementById('bj-search-box');
  if (sb) sb.placeholder = on ? 'Search OurJournal…' : 'Search entries…';
}
function _bjOJEnter() {
  if (_bjIsOJ() || !window.OJ) return;
  try { saveCurrentEntry(); } catch (e) {}
  try { _bjFbFlush(); } catch (e) {}
  _bjPersonal = state;
  _bjOJState = window.OJ.state('bj');
  state = _bjOJState;
  var sb = document.getElementById('bj-search-box'); if (sb) sb.value = '';
  window.OJ.enter('bj');
  _bjModeUI();
  renderSidebar(); loadActiveEntry();
}
function _bjOJLeave() {
  if (!_bjIsOJ()) return;
  try { saveCurrentEntry(); } catch (e) {}
  state = _bjPersonal; _bjPersonal = null;
  if (window.OJ) window.OJ.leave('bj');
  var sb = document.getElementById('bj-search-box'); if (sb) sb.value = '';
  // The entry that was open may have been deleted elsewhere in the meantime.
  if (state.activeId && !state.entries.some(function(e) { return e.id === state.activeId && !e.trashed; })) {
    state.activeId = _bjFirstLive();
  }
  _bjModeUI();
  renderSidebar(); loadActiveEntry();
}
window._bjOJ = { enter: _bjOJEnter, leave: _bjOJLeave, active: _bjIsOJ };
(function() {
  if (!window.OJ || !_bjFeat.ourjournal) return;
  _bjOJState = window.OJ.register('bj', {
    shown: function() { return _bjIsOJ(); },
    render: function() { if (_bjIsOJ()) renderSidebar(); },
    reload: function() { if (_bjIsOJ()) loadActiveEntry(); },
    editor: function() { return document.getElementById('bj-page-editor'); },
    pageOwned: function(id) { var e = _bjIsOJ() ? getActive() : null; return !!(e && e.id === id && e.template === 'page' && _bjDomOwner === id); },
    titleInput: function() { return document.getElementById('bj-entry-title-input'); },
    setSync: function(st) { if (_bjIsOJ()) _bjSetSync(st); },
    rebind: function(ed) { ed.querySelectorAll('.pg-img-wrap').forEach(_pgBindImgWrap); },
    pageSetup: function() { if (window._docxApplyPageSetup) window._docxApplyPageSetup('bj'); }
  });
  var side = document.getElementById('bj-sidebar'), nb = document.getElementById('bj-new-entry-btn');
  if (side && nb && !document.getElementById('bj-oj-rail')) {
    var rail = document.createElement('div');
    rail.id = 'bj-oj-rail';
    rail.className = 'oj-rail';
    rail.setAttribute('role', 'tablist');
    rail.innerHTML =
      '<button class="oj-tab" data-oj="1" role="tab" title="OurJournal — shared with Tony">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.2c3 .2 5.5 2.6 5.5 5.8"/></svg>' +
        '<span class="oj-lbl">OurJournal</span></button>' +
      '<button class="oj-tab" data-oj="0" role="tab" title="MyJournal — your own entries">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2.5Z"/><path d="M8 7h7"/></svg>' +
        '<span class="oj-lbl">MyJournal</span></button>';
    side.insertBefore(rail, nb);
    rail.addEventListener('click', function(ev) {
      var b = ev.target.closest('.oj-tab'); if (!b) return;
      if (b.getAttribute('data-oj') === '1') _bjOJEnter(); else _bjOJLeave();
    });
  }
  _bjModeUI();
  if (window.OJ.wasOn('bj')) _bjOJEnter();
})();

/* ── MOBILE UI LOGIC ─────────────────────────────────────────────── */
var bjIsMobile = false;

function bjCheckMobile() {
  // The phone/tablet shell's breakpoint (notebook.css, core/mobile.js): up to
  // 900px the entry list is a screen of its own, closed by opening an entry.
  bjIsMobile = window.innerWidth <= 900;
  // Fix wb size slider: vertical on desktop, horizontal on mobile
  var slider = document.getElementById('bj-wb-size');
  if (slider) {
    if (window.innerWidth <= 768) {
      slider.style.writingMode = 'horizontal-tb';
      slider.style.direction = 'ltr';
      slider.style.width = '72px';
      slider.style.height = '18px';
    } else {
      slider.style.writingMode = 'vertical-lr';
      slider.style.direction = 'rtl';
      slider.style.width = '18px';
      slider.style.height = '70px';
    }
  }
}
bjCheckMobile();
window.addEventListener('resize', bjCheckMobile);

/* Hamburger: toggle sidebar */
var bjHamburger = document.getElementById('bj-hamburger');
var bjBackdrop = document.getElementById('bj-sidebar-backdrop');
var bjSidebar = document.getElementById('bj-sidebar');
// One place that owns drawer state, so the root/body classes that lift the
// drawer above any app-level header can never drift out of sync.
function bjSetDrawer(open) {
  if (!bjSidebar || !bjBackdrop) return;
  bjSidebar.classList.toggle('bj-open', open);
  bjBackdrop.classList.toggle('bj-open', open);
  var root = document.getElementById('bj-root');
  if (root) root.classList.toggle('bj-drawer-open', open);
  document.body.classList.toggle('bj-drawer-open', open);
  // The host hears it (Notebook README, "Drawers"): a phone host with its own
  // drawer closes that one, so the two never lie on top of each other.
  try { window.dispatchEvent(new CustomEvent('notebook-drawer', { detail: { key: 'bj', open: !!open } })); } catch (e) {}
}
window._bjSetDrawer = bjSetDrawer;
if (bjHamburger) {
  bjHamburger.addEventListener('click', function() {
    bjSetDrawer(!bjSidebar.classList.contains('bj-open'));
  });
}
if (bjBackdrop) {
  bjBackdrop.addEventListener('click', function() { bjSetDrawer(false); });
}

/* Close sidebar after entry selected on mobile */
var _origRenderSidebar = renderSidebar;
renderSidebar = function() {
  _origRenderSidebar();
  // Re-attach click handlers to close sidebar on mobile
  document.querySelectorAll('#bj-entries-list .entry-item').forEach(function(el) {
    el.addEventListener('click', function() {
      if (bjIsMobile) bjSetDrawer(false);
    });
  });
};

/* Sync mobile title input with desktop title input */
var bjMobileTitle = document.getElementById('bj-mobile-title');
var bjDesktopTitle = document.getElementById('bj-entry-title-input');
if (bjMobileTitle && bjDesktopTitle) {
  bjMobileTitle.addEventListener('input', function() {
    bjDesktopTitle.value = this.value;
    autoSave();
  });
}

/* Patch loadActiveEntry to sync mobile title */
var _origLoadActive = loadActiveEntry;
loadActiveEntry = function() {
  _origLoadActive();
  if (bjMobileTitle) {
    var entry = getActive();
    bjMobileTitle.value = entry ? (entry.title || '') : '';
  }
};


/* Whiteboard: Apple Pencil — use pointer type to distinguish */
/* Palm rejection handled in main pointerdown handler above */

/* iOS: prevent bounce scroll inside content area */
var bjContent = document.getElementById('bj-content-area');
if (bjContent) {
  bjContent.addEventListener('touchmove', function(e) {
    e.stopPropagation();
  }, { passive: true });
}

/* Visual viewport resize — canvas has fixed logical size (1400×900) so no resize needed */

/* ── PDF EXPORT ── */
/* bj-btn-export-pdf handled by fastTouch above */

// The saved PDF is named after the printed page's <title>, so that title carries the
// filename (underscored, illegal characters removed) rather than the entry title itself.
function _bjPdfName(t) {
  return window._pdfFileName ? window._pdfFileName(t) : (t || 'Untitled_Entry');
}

function _bjOpenPrintBlob(htmlStr) {
  // Use a hidden iframe inside the current page — never blocked by popup blockers
  var iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:none;';
  document.body.appendChild(iframe);
  var doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(htmlStr);
  doc.close();
  var printed = false;
  function go() {
    if (printed) return; printed = true;
    // Some browsers seed the "Save as PDF" filename from the printed frame's title and
    // others from the host page's, so wear both while the dialog is being built.
    var hostTitle = document.title, frameTitle = '';
    try { frameTitle = (iframe.contentDocument && iframe.contentDocument.title) || ''; } catch (e) {}
    if (frameTitle) { try { document.title = frameTitle; } catch (e) {} }
    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) {}
    setTimeout(function() {
      try { document.title = hostTitle; } catch (e) {}
      try { document.body.removeChild(iframe); } catch (e) {}
    }, 2000);
  }
  // Wait for KaTeX CSS/JS + web fonts so rendered math prints accurately (item 8); hard fallback at 4s.
  iframe.onload = function() {
    var d = iframe.contentDocument;
    var fonts = (d && d.fonts && d.fonts.ready) ? d.fonts.ready : Promise.resolve();
    Promise.resolve(fonts).then(function() { setTimeout(go, 250); });
  };
  setTimeout(go, 4000);
}

function exportEntryAsPDF(entry) {
  var title = entry.title || 'Untitled Entry';
  var date = new Date(entry.updated || entry.created).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

  // The page, as a styled HTML print page
  var bodyHTML = '';
  if (entry.template === 'page') {
    bodyHTML = '<div class="page-content">' + (window._docxPdfBlackText ? window._docxPdfBlackText(entry.data.html || '') : (entry.data.html || '')) + '</div>';
  }

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + _bjEsc(_bjPdfName(title)) + '</title><style>'
    + 'body{font-family:Georgia,serif;max-width:750px;margin:32px auto;color:#1a1a2e;font-size:14px;line-height:1.7;padding:0 24px;}'
    + 'h1{font-size:22px;font-weight:700;margin:0 0 6px;color:#2d1b4e;}'
    + '.meta{font-size:11px;color:#888;font-family:sans-serif;margin-bottom:20px;}'
    + '.section{margin-bottom:18px;}'
    + '.section-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#9b7ec8;margin-bottom:6px;font-family:sans-serif;border-bottom:1px solid #ede9f4;padding-bottom:4px;}'
    + '.section-body{white-space:pre-wrap;word-break:break-word;}'
    + '.page-content{line-height:1.7;}'
    + 'table{border-collapse:collapse;width:100%;margin:10px 0;}th,td{border:1px solid #d8d0e8;padding:6px 10px;text-align:left;}th{background:#f3effa;}'
    + 'ul.docx-checklist{list-style:none;padding-left:8px;}li.docx-cl-item{list-style:none;}.docx-cl-box{margin-right:8px;}li.docx-cl-item.done .docx-cl-text{text-decoration:line-through;opacity:.6;}'
    + 'hr.docx-pagebreak{page-break-after:always;break-after:page;border:none;margin:0;}'
    + 'hr{border:none;border-top:1px solid #ede9f4;margin:20px 0;}'
    + '@media print{body{margin:0;padding:16px;}}'
    + '</style>'
    + ((entry.template === 'page' && window._docxExportPageCss) ? '<style>' + window._docxExportPageCss('bj') + '</style>' : '')
    + (/docx-math/.test(bodyHTML) && window._docxExportMathHead ? window._docxExportMathHead() : '')
    + '</head><body>'
    + '<h1>' + _bjEsc(title) + '</h1>'
    + '<div class="meta">' + _bjEsc(date)
    + '</div><hr/>'
    + bodyHTML
    + (/docx-math/.test(bodyHTML) && window._docxExportMathScript ? window._docxExportMathScript() : '')
    + '</body></html>';

  _bjOpenPrintBlob(html);
}

function _bjEsc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.showBrainstormJournal = function(caller) {
  window._bjCalledFrom = caller || (document.getElementById('veda-root') && document.getElementById('veda-root').style.display !== 'none' ? 'veda' : 'tony');
  ['root','veda-root','tj-root'].forEach(function(id){
    var el = document.getElementById(id); if(el) el.style.display = 'none';
  });
  var bj = document.getElementById('bj-root');
  bj.style.position='fixed'; bj.style.inset='0'; bj.style.zIndex='9999';
  bj.style.display='flex'; bj.style.flexDirection='column';
  // Always re-check lock state when journal becomes visible
  if (window._bjLockCheck) window._bjLockCheck();
  // Opening the journal re-reads the real document from the server — see the
  // MyJournal twin.
  if (window._fbResyncJournal) window._fbResyncJournal();
};
window.hideBrainstormJournal = function() {
  document.getElementById('bj-root').style.display = 'none';
  var from = window._bjCalledFrom;
  window._bjCalledFrom = null;
  if (from === 'veda' && window._switchToVeda) {
    window._switchToVeda();
  } else if (from === 'tony') {
    var root = document.getElementById('root');
    if (root) root.style.display = '';
  } else if (window._switchToVeda) {
    window._switchToVeda();
  }
};

// ══════════════════════════════════════════
// BJ LOCK SYSTEM → Guardian (Veda's Brainstorm Journal)
// ══════════════════════════════════════════
// A locked entry is a Guardian lock (Guardian/guardian.js, docs/Guardian/README.md):
// id 'bj:<entryId>', worker record jlock:bj:<entryId>. Guardian owns the screens,
// passwords, biometrics and hint/reset mail. This block only keeps entry.lock —
// the synced "this entry is locked" marker the sidebar and the load/save guards
// read without a network call — and the pane that covers a locked entry's editor.
(function() {
  var G = window.Guardian;
  var lockBtn = document.getElementById('bj-btn-lock');
  var mobileLockBtn = document.getElementById('bj-mobile-lock-btn');
  var pane = document.getElementById('bj-locked-pane');

  function blEntry(id) { return state.entries.find(function(e) { return e.id === id; }); }
  function blGetLock(id) { var e = blEntry(id); return (e && e.lock) ? e.lock : null; }
  function gid(id) { return 'bj:' + id; }
  // Declare the entry's lock to Guardian (idempotent; keeps the label current).
  function blDefine(id) {
    var e = blEntry(id);
    return G.define(gid(id), {
      journal: 'bj', entryId: id, kind: 'entry', owner: 'veda',
      label: (e && e.title) || 'Untitled entry', appName: _bjCfg.title || 'Journal',
      // First sight on this device: the old per-entry unlock marker decides.
      legacy: {
        locked: function() { return !!blGetLock(id); },
        open: G.legacy.marker('bj_', id, (blGetLock(id) || {}).v || 0, 'bj').open,
        bio: G.legacy.marker('bj_', id, (blGetLock(id) || {}).v || 0, 'bj').bio
      },
      onChange: function(_g, what) {
        var en = blEntry(id); if (!en) return;
        if (what === 'remove') delete en.lock;
        else en.lock = { locked: true, v: Date.now() };
        en.updated = Date.now();
        saveState();
        blUpdateLockBtn(); try { renderSidebar(); } catch (e) {}
      },
      // Locked here again (lock now, or a new password elsewhere): reload the
      // entry so the load guard blanks its editor behind the pane.
      onBlock: function() { if (state.activeId === id) { try { loadActiveEntry(); } catch (e) { blCheckEntry(); } } }
    });
  }
  function blIsUnlocked(id) { return !blGetLock(id) || G.isUnlocked(blDefine(id)); }

  function blShowPane(show) { if (pane) pane.style.display = show ? 'flex' : 'none'; }
  function blOpened(id) {
    blShowPane(false); blUpdateLockBtn();
    try { loadActiveEntry(); renderSidebar(); } catch (e) {}
  }
  // Ask for the active entry's password (Cancel leaves the pane over it).
  function blAsk() {
    var entry = getActive(); if (!entry || !blGetLock(entry.id)) return;
    var id = entry.id;
    G.gate(blDefine(id)).then(function(ok) {
      // The server reported no lock: the marker was stale (deleted + re-synced).
      if (ok && G.status(gid(id)).hasLock === false && blGetLock(id)) { var en = blEntry(id); delete en.lock; en.updated = Date.now(); saveState(); }
      if (ok && state.activeId === id) blOpened(id);
    });
  }
  pane && pane.querySelector('button') && pane.querySelector('button').addEventListener('click', blAsk);

  function blManage() {
    var entry = getActive(); if (!entry) return;
    var id = entry.id;
    G.manage(blDefine(id)).then(function() { if (state.activeId === id) blCheckEntry(); });
  }

  function blUpdateLockBtn() {
    var entry = getActive();
    if (!entry || !_bjFeat.locks || _bjIsPinned(entry.id)) {
      lockBtn.style.display = 'none';
      if (mobileLockBtn) mobileLockBtn.style.display = 'none';
      return;
    }
    lockBtn.style.display = '';
    if (mobileLockBtn) mobileLockBtn.style.display = '';
    var lock = blGetLock(entry.id);
    if (lock) {
      lockBtn.classList.add('locked');
      lockBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
      lockBtn.setAttribute('aria-label', 'Entry locked: manage its lock');
      // Class, not an inline colour — the unlocked branch used to clear the
      // inline colour and fall back to the UA's black buttontext.
      if (mobileLockBtn) { mobileLockBtn.innerHTML = TNI.lock; mobileLockBtn.classList.add('tl-locked'); mobileLockBtn.style.color = ''; }
    } else {
      lockBtn.classList.remove('locked');
      lockBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.75-1.4"/></svg>';
      lockBtn.setAttribute('aria-label', 'Lock this entry');
      if (mobileLockBtn) { mobileLockBtn.innerHTML = TNI.unlock; mobileLockBtn.classList.remove('tl-locked'); mobileLockBtn.style.color = ''; }
    }
  }
  lockBtn && lockBtn.addEventListener('click', blManage);
  mobileLockBtn && mobileLockBtn.addEventListener('click', blManage);

  // Gate the active entry: a locked entry this device has not opened shows the
  // pane (never its content) and asks.
  function blCheckEntry() {
    var entry = getActive();
    blUpdateLockBtn();
    if (!entry || !blGetLock(entry.id)) { blShowPane(false); return; }
    if (!blIsUnlocked(entry.id)) {
      blShowPane(true);
      if (!G.isOpen()) blAsk();
    } else {
      blShowPane(false);
    }
  }

  // Run the lock check after every entry load.
  var _origLoadActive = loadActiveEntry;
  loadActiveEntry = function() {
    _origLoadActive.apply(this, arguments);
    blCheckEntry();
  };
  // …and right now, so an entry loaded before this patch is gated too.
  blCheckEntry();

  // Lock badges in the sidebar.
  var _origRenderSidebar = renderSidebar;
  renderSidebar = function() {
    _origRenderSidebar.apply(this, arguments);
    document.querySelectorAll('#bj-entries-list .entry-item').forEach(function(div) {
      var id = div.dataset.entryId;
      if (!id) return;
      var titleEl = div.querySelector('.entry-item-title');
      if (!titleEl) return;
      var existing = titleEl.querySelector('.tl-badge');
      if (existing) existing.remove();
      if (blGetLock(id)) {
        var badge = document.createElement('span');
        badge.className = 'tl-badge';
        badge.innerHTML = TNI.lock;
        titleEl.appendChild(badge);
      }
    });
  };

  // Resolves '' (no password needed), the verified password, or null (cancelled).
  window._bjLockDeleteAsk = function(id) {
    if (!blGetLock(id)) return Promise.resolve('');
    var g = blDefine(id);
    if (G.isUnlocked(g)) return Promise.resolve('');
    return G.verify(g, { title: 'Delete entry', message: 'This entry is locked. Enter its password to delete it.' });
  };
  // The entry is gone: drop its lock here, and on the server when the password is known.
  window._bjLockForget = function(id, pw) { return G.forget(gid(id), pw || undefined); };

  window._bjLockCheck = blCheckEntry;
  window._bjLockUpdateBtn = blUpdateLockBtn;
  window._bjGetLock = blGetLock;
  window._bjIsUnlocked = blIsUnlocked;
})();

})();

// The DOCX editor config for this app (core/docx.js reads Notebook.docxApps).
Notebook.registerDocx('bj', {
  root: 'bj-root', lightClass: null,
  ctxs: [
    { ed: 'bj-page-editor', tb: 'bj-page-toolbar', wrap: 'bj-page-editor-wrap', area: 'bj-page-area', img: 'bj-page-img-file', md: 'bj-pt-md' }
  ],
  mainToolbar: 'bj-toolbar', syncPill: 'bj-sync-pill', newBtn: 'bj-new-entry-btn',
  exportBtn: 'bj-btn-export-pdf', sidebarBtn: 'bj-fullscreen-btn', trashAPI: '_bjTrashAPI',
  aiProfile: 'veda', bindImg: '_bjBindImg',
  name: (Notebook.mounts.bj && Notebook.mounts.bj.title) || 'Journal', side: 'veda'
});
