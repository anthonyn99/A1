/* MyJournal (key tj, Tony's journal) as a Notebook app.
   Loaded by Notebook.mount({ app: 'myjournal', key: 'tj', store: 'tony_journal' }),
   which writes this script in where the host called it, while the page parses.
   It builds #tj-root right before its own <script> tag, then runs the app.
   How it opens inside TaskHub (showTonyJournal, the program nav) is the host's;
   its Firestore layer is core/fb.js. */
(function () {
var me = document.currentScript;
var html = `
<div id="tj-root">
<div id="tj-nav-header" style="background:var(--bg);border-bottom:1px solid var(--border);flex-shrink:0;">
  <div id="tj-nav-inner" style="max-width:2000px;margin:0 auto;padding:calc(env(safe-area-inset-top,0px) + 10px) clamp(12px,3vw,24px) 10px;display:flex;flex-direction:column;gap:6px;min-width:0;width:100%;">
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:30px;">
      <div id="tj-nav-btns" style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
      </div>
    </div>
    <div id="tj-nav-row2" style="display:none;align-items:center;justify-content:flex-end;gap:6px;">
    </div>
  </div>
</div>
<div id="tj-body">
<div id="tj-sidebar-backdrop"></div>
<!-- SIDEBAR -->
<div id="tj-sidebar">
  <div id="tj-sidebar-header" style="justify-content:flex-end;align-items:center;">
  </div>
  <button id="tj-new-entry-btn">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    New Entry
  </button>
  <div class="search-wrap">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input id="tj-search-box" type="text" placeholder="Search entries…" />
  </div>
  <div id="tj-entries-list"></div>
  <div id="tj-sidebar-stats">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
    <span id="tj-entry-count">0</span> entries
  </div>
</div>

<!-- MAIN -->
<div id="tj-main">
  <!-- Mobile header: lives inside main so it doesn't affect root flex layout -->
  <div id="tj-mobile-header">
    <button id="tj-hamburger" style="background:transparent;border:none;cursor:pointer;padding:8px;color:var(--purple);flex-shrink:0;touch-action:manipulation;" aria-label="Open sidebar">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <input id="tj-mobile-title" type="text" placeholder="Untitled entry…" style="flex:1;background:none;border:none;outline:none;font-family:var(--font);font-size:14px;font-weight:500;color:var(--text);min-width:0;padding:0 4px;" />
    <button id="tj-mobile-lock-btn" style="display:none;background:transparent;border:none;cursor:pointer;padding:6px 8px;flex-shrink:0;touch-action:manipulation;line-height:0;display:inline-flex;align-items:center;" aria-label="Lock entry"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg></button>
  </div>
  <div id="tj-toolbar">
    <button id="tj-fullscreen-btn" title="Toggle sidebar">
      <svg id="tj-fs-icon-show" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
      <svg id="tj-fs-icon-hide" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="9" x2="9" y2="9" opacity="0.5"/><line x1="15" y1="12" x2="9" y2="12" opacity="0.5"/><line x1="15" y1="15" x2="9" y2="15" opacity="0.5"/></svg>
    </button>
    <div class="toolbar-sep"></div>
    <input id="tj-entry-title-input" type="text" placeholder="Untitled entry…" />
    <div class="toolbar-sep"></div>
    <div class="mode-toggle-wrap">
      <span class="mode-toggle-label" id="tj-mode-label">VIEW</span>
      <label class="mode-toggle" title="Toggle Edit / View mode">
        <input type="checkbox" id="tj-btn-edit" />
        <div class="toggle-track"></div>
        <div class="toggle-knob"></div>
      </label>
    </div>
    <div class="toolbar-sep"></div>
    <button class="tb-btn" id="tj-btn-export-pdf" data-tip="Export as PDF" style="color:var(--ac);">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      Export PDF
    </button>
    <div class="toolbar-sep"></div>
    <button class="tb-btn lock-btn" id="tj-btn-lock" data-tip="Lock this entry" style="display:none;">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      Lock
    </button>
    <div class="toolbar-sep"></div>

    <!-- TAGS (moved into the toolbar — Batch 12 #3) -->
    <div id="tj-tags-row" style="display:none;">
      <span class="tags-label">Tags</span>
      <input id="tj-add-tag-input" type="text" placeholder="+ add tag" maxlength="20" />
    </div>

    <span id="tj-sync-pill" class="tj-sync-pill tj-sync-idle">
      <span class="tj-sync-dot"></span>
      <span id="tj-sync-text">Idle</span>
    </span>
  </div>

  <div id="tj-content-area">
    <!-- LOCK OVERLAY -->
    <div id="tj-lock-overlay" style="display:none;">
      <div class="tl-box" id="tj-lock-box">
        <div class="tl-icon" id="tj-lock-icon"></div>
        <div class="tl-title" id="tj-lock-title">Locked Entry</div>
        <div class="tl-sub" id="tj-lock-sub">Enter your password to unlock this entry.</div>
        <div id="tj-lock-bio" style="display:none;"></div>
        <div class="tl-menu" id="tj-lock-menu" style="display:none;"></div>
        <div class="tl-input-wrap" id="tj-lock-input-wrap">
          <input class="tl-pw-input" id="tj-lock-pw" type="password" placeholder="• • • •" autocomplete="current-password" />
          <div class="tl-err" id="tj-lock-err"></div>
          <div class="tl-row" id="tj-lock-row">
            <button class="tl-btn ghost" id="tj-lock-cancel">Cancel</button>
            <button class="tl-btn" id="tj-lock-submit">Unlock</button>
          </div>
        </div>
        <button class="tl-forgot" id="tj-lock-forgot">Forgot password?</button>
        <button class="tl-forgot" id="tj-lock-reset" style="margin-top:4px;">Reset password via email</button>
      </div>
    </div>

    <div id="tj-empty-state">
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      <h2>No Entry Selected</h2>
      <p>Create a new entry to start brainstorming, or select one from the sidebar.</p>
      <span class="empty-hint">Click "New Entry" to get started</span>
    </div>

    <!-- WHITEBOARD -->
    <div id="tj-wb-canvas-wrap" class="viz-shell">
      <div class="viz-mount" id="tj-wb-mount"></div>
    </div>

    <!-- MIND MAP — Mind Elixir. New to MyJournal; the same engine and the
         same document model as Veda's, wearing this profile's gold tokens. -->
    <div id="tj-mindmap-area" class="viz-shell">
      <div class="viz-mount" id="tj-mm-mount"></div>
    </div>

    <!-- PAGE -->
    <div id="tj-page-area">
      <div class="tj-drop-zone" id="tj-page-drop-zone"><div class="tj-drop-label"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>Drop files here</div></div>
      <div class="docx-toolbar" id="tj-page-toolbar">
        <!-- Block format -->
        <select class="pt-select docx-r1" id="tj-pt-block">
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
        <select class="pt-select docx-r1" id="tj-pt-fontsize" title="Font size" style="width:46px;padding:3px 2px;">
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
        <button class="pt-btn docx-r1" id="tj-pt-bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button class="pt-btn docx-r1" id="tj-pt-italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button class="pt-btn docx-r1" id="tj-pt-underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <button class="pt-btn docx-r2" id="tj-pt-strike" title="Strikethrough"><s>S</s></button>
        <button class="pt-btn docx-r2" id="tj-pt-code" title="Inline code">&lt;/&gt;</button>
        <div class="pt-sep"></div>
        <!-- Color -->
        <input type="color" class="docx-r1" id="tj-page-color-pick" value="#ECECEE" title="Text color">
        <div class="pt-sep"></div>
        <!-- Lists -->
        <button class="pt-btn docx-r1" id="tj-pt-ul" title="Bullet list">&#8226;&#8212;</button>
        <button class="pt-btn docx-r1" id="tj-pt-ol" title="Numbered list">1.</button>
        <div class="pt-sep"></div>
        <!-- Alignment -->
        <button class="pt-btn docx-r2" id="tj-pt-alignL" title="Align left"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h13"/></svg></button>
        <button class="pt-btn docx-r2" id="tj-pt-alignC" title="Center"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M7 12h10"/><path d="M5 18h14"/></svg></button>
        <button class="pt-btn docx-r2" id="tj-pt-alignR" title="Align right"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M10 12h10"/><path d="M7 18h13"/></svg></button>
        <div class="pt-sep"></div>
        <!-- Insert -->
        <button class="pt-btn docx-r2" id="tj-pt-link" title="Insert link"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg></button>
        <button class="pt-btn docx-r2" id="tj-pt-hr" title="Divider">&#8213;</button>
        <button class="pt-btn docx-r2" id="tj-pt-table" title="Insert table">&#9783;</button>
        <button class="pt-btn" id="tj-pt-md" title="Render Markdown — convert raw Markdown into formatted text" style="font-weight:700;font-size:11px;">Render Markdown</button>
        <button class="pt-btn docx-r1" id="tj-page-img-btn" title="Insert image / attach file">
          &#128247;
          <input type="file" id="tj-page-img-file" accept="*/*" multiple>
        </button>
        <div class="pt-sep"></div>
        <!-- Highlight colors -->
        <div class="pt-hl-wrap docx-r1" id="tj-pt-hl-wrap" title="Highlight text">
          <button class="pt-btn pt-hl-trigger" id="tj-pt-hl-trigger" title="Highlight">
            <span class="pt-hl-icon" id="tj-pt-hl-icon">&#9646;</span><span style="font-size:9px;margin-left:1px;">▾</span>
          </button>
          <div class="pt-hl-palette" id="tj-pt-hl-palette">
            <button class="pt-hl-swatch" data-color="#FFE066" style="background:#FFE066;" title="Yellow"></button>
            <button class="pt-hl-swatch" data-color="#A8F0B0" style="background:#A8F0B0;" title="Green"></button>
            <button class="pt-hl-swatch" data-color="#A8D8FF" style="background:#A8D8FF;" title="Blue"></button>
            <button class="pt-hl-swatch" data-color="#FFB3C6" style="background:#FFB3C6;" title="Pink"></button>
            <button class="pt-hl-swatch" data-color="#F9C784" style="background:#F9C784;" title="Orange"></button>
            <button class="pt-hl-swatch" data-color="#D4B0FF" style="background:#D4B0FF;" title="Purple"></button>
            <button class="pt-hl-swatch" data-color="none" style="background:transparent;border:1.5px solid var(--border);color:var(--red);font-size:11px;font-weight:700;" title="Remove highlight"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
          </div>
        </div>
        <div style="flex:1"></div>
        <!-- Clear -->
        <button class="pt-btn" id="tj-pt-clear" title="Clear all content" style="color:var(--red);">&#128465;</button>
      </div>
      <div id="tj-page-editor-wrap">
        <div id="tj-page-editor" contenteditable="false"></div>
      </div>
    </div>

    <!-- JOURNAL ENTRIES -->
    <div id="tj-je-area" style="display:none;flex-direction:column;flex:1;min-height:0;overflow:hidden;">
      <div class="tj-drop-zone" id="tj-je-drop-zone"><div class="tj-drop-label"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>Drop files here</div></div>
      <!-- Date strip: pills that scroll, with arrows + a jump menu once it overflows -->
      <div id="tj-je-tabs-bar">
        <button class="je-navbtn" id="tj-je-prev" title="Previous date" aria-label="Previous date"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button>
        <div id="tj-je-strip"><div id="tj-je-tabs"></div></div>
        <button class="je-navbtn" id="tj-je-next" title="Next date" aria-label="Next date"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
        <button id="tj-je-jump" title="Jump to a date"><span id="tj-je-jump-lbl">Dates</span><span class="je-jump-count" id="tj-je-jump-count"></span><span style="font-size:9px;opacity:.7;">&#9662;</span></button>
        <button id="tj-je-add-date" title="Add a new date entry">+ Date</button>
      </div>
      <div id="tj-je-menu"></div>
      <!-- Date editor toolbar — cloned from the Page template -->
      <div class="docx-toolbar" id="tj-je-toolbar">
        <!-- Block format -->
        <select class="pt-select docx-r1" id="tj-je-pt-block">
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
        <select class="pt-select docx-r1" id="tj-je-pt-fontsize" title="Font size" style="width:46px;padding:3px 2px;">
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
        <button class="pt-btn docx-r1" id="tj-je-pt-bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button class="pt-btn docx-r1" id="tj-je-pt-italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button class="pt-btn docx-r1" id="tj-je-pt-underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <button class="pt-btn docx-r2" id="tj-je-pt-strike" title="Strikethrough"><s>S</s></button>
        <button class="pt-btn docx-r2" id="tj-je-pt-code" title="Inline code">&lt;/&gt;</button>
        <div class="pt-sep"></div>
        <!-- Color -->
        <input type="color" class="docx-r1" id="tj-je-color-pick" value="#ECECEE" title="Text color">
        <div class="pt-sep"></div>
        <!-- Lists -->
        <button class="pt-btn docx-r1" id="tj-je-pt-ul" title="Bullet list">&#8226;&#8212;</button>
        <button class="pt-btn docx-r1" id="tj-je-pt-ol" title="Numbered list">1.</button>
        <div class="pt-sep"></div>
        <!-- Alignment -->
        <button class="pt-btn docx-r2" id="tj-je-pt-alignL" title="Align left"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h13"/></svg></button>
        <button class="pt-btn docx-r2" id="tj-je-pt-alignC" title="Center"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M7 12h10"/><path d="M5 18h14"/></svg></button>
        <button class="pt-btn docx-r2" id="tj-je-pt-alignR" title="Align right"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M10 12h10"/><path d="M7 18h13"/></svg></button>
        <div class="pt-sep"></div>
        <!-- Insert -->
        <button class="pt-btn docx-r2" id="tj-je-pt-link" title="Insert link"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg></button>
        <button class="pt-btn docx-r2" id="tj-je-pt-hr" title="Divider">&#8213;</button>
        <button class="pt-btn docx-r2" id="tj-je-pt-table" title="Insert table">&#9783;</button>
        <button class="pt-btn" id="tj-je-pt-md" title="Render Markdown — convert raw Markdown into formatted text" style="font-weight:700;font-size:11px;">Render Markdown</button>
        <button class="pt-btn docx-r1" id="tj-je-img-btn" title="Insert image / attach file">
          &#128247;
          <input type="file" id="tj-je-img-file" accept="*/*" multiple>
        </button>
        <div class="pt-sep"></div>
        <!-- Highlight colors -->
        <div class="pt-hl-wrap docx-r1" id="tj-je-pt-hl-wrap" title="Highlight text">
          <button class="pt-btn pt-hl-trigger" id="tj-je-pt-hl-trigger" title="Highlight">
            <span class="pt-hl-icon" id="tj-je-pt-hl-icon">&#9646;</span><span style="font-size:9px;margin-left:1px;">▾</span>
          </button>
          <div class="pt-hl-palette" id="tj-je-pt-hl-palette">
            <button class="pt-hl-swatch" data-color="#FFE066" style="background:#FFE066;" title="Yellow"></button>
            <button class="pt-hl-swatch" data-color="#A8F0B0" style="background:#A8F0B0;" title="Green"></button>
            <button class="pt-hl-swatch" data-color="#A8D8FF" style="background:#A8D8FF;" title="Blue"></button>
            <button class="pt-hl-swatch" data-color="#FFB3C6" style="background:#FFB3C6;" title="Pink"></button>
            <button class="pt-hl-swatch" data-color="#F9C784" style="background:#F9C784;" title="Orange"></button>
            <button class="pt-hl-swatch" data-color="#D4B0FF" style="background:#D4B0FF;" title="Purple"></button>
            <button class="pt-hl-swatch" data-color="none" style="background:transparent;border:1.5px solid var(--border);color:var(--red);font-size:11px;font-weight:700;" title="Remove highlight"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
          </div>
        </div>
        <div style="flex:1"></div>
        <!-- Clear -->
        <button class="pt-btn" id="tj-je-pt-clear" title="Clear this date’s content" style="color:var(--red);">&#128465;</button>
      </div>
      <!-- Editor area -->
      <div id="tj-je-editor-wrap" style="flex:1;overflow-y:auto;overflow-x:hidden;padding:0;">
        <div id="tj-je-editor" contenteditable="false" style="min-height:100%;padding:20px clamp(12px,3vw,32px);outline:none;font-family:var(--font);font-size:14px;line-height:1.75;color:var(--text);"></div>
      </div>
      <!-- Empty state when no dates exist -->
      <div id="tj-je-empty" style="flex:1;display:none;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:var(--text3);font-size:13px;text-align:center;padding:32px;">
        <div class="tj-empty-ico" style="line-height:0;"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/></svg></div>
        <div style="font-weight:700;color:var(--text2);">No dates yet</div>
        <div>Click <b style="color:var(--purple);">+ Date</b> to add your first journal entry date.</div>
      </div>
    </div>
  </div>
</div>

<!-- TEMPLATE MODAL -->
<div id="tj-template-modal">
  <div id="tj-template-panel">
    <div class="modal-header">
      <h2>Choose a Template</h2>
      <button class="modal-close" id="tj-close-modal" aria-label="Close"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
    </div>
    <p>Pick a format for this entry</p>
    <div class="template-grid">
      <div class="template-card" data-template="whiteboard">
        <div class="template-card-icon"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19H5a2 2 0 0 1 0-4h5a2 2 0 0 0 0-4H7"/><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L15 12l-4 1 1-4Z"/></svg></div>
        <h3>Whiteboard</h3>
        <p>Free-draw canvas with pen, shapes, text and undo.</p>
      </div>
      <div class="template-card" data-template="page">
        <div class="template-card-icon"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg></div>
        <h3>Page</h3>
        <p>Rich document: text, images, lists, tables, headings.</p>
      </div>
      <div class="template-card" data-template="mindmap">
        <div class="template-card-icon"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="9.5" width="7" height="5" rx="1.5"/><rect x="15" y="3" width="7" height="5" rx="1.5"/><rect x="15" y="16" width="7" height="5" rx="1.5"/><path d="M9 12h3v-6.5h3"/><path d="M12 12v6.5h3"/></svg></div>
        <h3>Mind Map</h3>
        <p>Branch one idea outwards: drag, fold and reorganise.</p>
      </div>
      <div class="template-card" data-template="journal-entries">
        <div class="template-card-icon"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/></svg></div>
        <h3>Journal Entries</h3>
        <p>Date-tabbed diary: each date is its own saved page.</p>
      </div>
    </div>
  </div>
</div>
</div><!-- end tj-body -->
<div id="tj-bottom-bar" style="display:none;">
  <button id="tj-bb-edit" style="flex:1;background:transparent;color:var(--text2);border:1px solid var(--border2);border-radius:5px;padding:7px 0;font-size:11px;font-weight:500;font-family:var(--font);text-transform:uppercase;letter-spacing:0.5px;cursor:pointer;touch-action:manipulation;">✏ Edit</button>
  <button id="tj-bb-new" style="flex:2;background:var(--purple);color:#1a1a1d;border:none;border-radius:5px;padding:7px 0;font-size:11px;font-weight:600;font-family:var(--font);text-transform:uppercase;letter-spacing:0.5px;cursor:pointer;touch-action:manipulation;">+ New</button>
  <span id="tj-bb-saved" style="font-size:11px;color:var(--green);font-family:var(--font);font-weight:500;opacity:0;transition:opacity 0.4s;white-space:nowrap;display:inline-flex;align-items:center;"><svg class="tji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></span>
</div>
</div>
`;
if (me && me.parentNode) me.insertAdjacentHTML('beforebegin', html);
else document.body.insertAdjacentHTML('beforeend', html);
})();

(function(){
'use strict';
const STORAGE_KEY = 'tony_journal_v3';
// ── The host's mount config (Notebook.mount; docs/Notebook/README.md) ──
// features: ourjournal / locks (both on unless a host turns them off).
// pinned:   [{ id, title, html }] pages kept first in the list, never trashed,
//           dragged or locked; created empty (updated 0, so the cloud copy wins)
//           when the store does not have them yet.
// onSave(entry) after the cloud confirms a save; onReady() after the first load.
const _tjCfg = (window.Notebook && window.Notebook.mounts && window.Notebook.mounts.tj) || {};
const _tjFeat = Object.assign({ ourjournal: true, locks: true }, _tjCfg.features || {});
const _tjPinned = Array.isArray(_tjCfg.pinned) ? _tjCfg.pinned : [];
function _tjIsPinned(id) { return _tjPinned.some(function (p) { return p.id === id; }); }
// For the host (e.g. in onReady): the entries as they stand, live and trashed.
_tjCfg.entries = function () { return state.entries; };
// Make every pinned page exist, out of the trash, at the top in its given order.
function _tjPinFirst() {
  if (!_tjPinned.length || _tjIsOJ()) return;
  var head = [];
  _tjPinned.forEach(function (p) {
    var e = state.entries.find(function (x) { return x.id === p.id; });
    if (!e) e = { id: p.id, title: p.title || 'Untitled', template: 'page', created: 0, updated: 0, tags: [], data: { html: p.html || '', attachments: [] }, rev: 0 };
    delete e.trashed; delete e.trashChangedAt;
    head.push(e);
  });
  state.entries = head.concat(state.entries.filter(function (x) { return head.indexOf(x) < 0; }));
}
const TJ_CANVAS_KEY = (id) => 'tj_canvas_' + id;
let state = { entries: [], activeId: null, deletedIds: [] };
// ── OurJournal (see the OJ engine) ───────────────────────────────────────────
// `state` is whichever collection is ON SCREEN — see the Brainstorm twin. With
// the OurJournal tab on it is the shared collection; Tony's own waits in
// _tjPersonal, and every persistence call routes by which one `state` is.
let _tjPersonal = null;
let _tjOJState  = null;
let _tjHidden   = false;
function _tjIsOJ() { return !!_tjOJState && state === _tjOJState; }
let saveTimer = null;
// ── Anti-regression state (see JGuard, Notebook/core/jguard.js) ──────────────
// _tjDomOwner: the entry id the editor DOM was last PAINTED for. The templates
//   share one set of nodes — a single #tj-page-editor serves every page entry —
//   so this is the only way saveCurrentEntry can tell "the
//   content on screen is this entry's" from "the content on screen belongs to
//   something else, or has not been painted yet".
// _tjUserEdited: set by autoSave(), which only ever runs off a real edit (input,
//   paste, toolbar command, undo). It is what distinguishes a user genuinely
//   clearing a page — which must be allowed to save — from a blank editor that was
//   never filled in, which must not.
let _tjDomOwner  = null;
let _tjUserEdited = false;
let tjSyncStatus = 'idle'; // idle | saving | saved | error
let _tjSavedOnce = false;   // idle reads "Saved" only after this session saved something

function _tjSetSync(status) {
  tjSyncStatus = status;
  var pill = document.getElementById('tj-sync-pill');
  var txt  = document.getElementById('tj-sync-text');
  var bb   = document.getElementById('tj-bb-saved');
  if (!pill || !txt) return;
  pill.className = 'tj-sync-pill tj-sync-' + status;
  if (status === 'syncing') _tjSavedOnce = true;
  // Before anything was saved here, idle only means the screen matches the cloud.
  var labels = { idle: _tjSavedOnce ? 'Saved' : 'Synced', syncing:'Saving…', synced:'Synced', error:'Sync Failed' };
  txt.textContent = labels[status] || status;
  // Bottom bar indicator on mobile
  if (bb) {
    if (status === 'syncing') { bb.textContent = 'Syncing…'; bb.style.color = 'var(--cyan)'; bb.style.opacity = '1'; }
    else if (status === 'synced') { bb.textContent = 'Synced'; bb.style.color = 'var(--green)'; bb.style.opacity = '1'; clearTimeout(bb._t); bb._t = setTimeout(() => { bb.style.opacity='0'; }, 3000); }
    else if (status === 'error') { bb.textContent = 'Failed'; bb.style.color = 'var(--red)'; bb.style.opacity = '1'; }
    else { bb.style.opacity = '0'; }
  }
  // Auto-reset synced → idle after 4s
  if (status === 'synced') {
    clearTimeout(_tjSyncResetTimer);
    _tjSyncResetTimer = setTimeout(() => _tjSetSync('idle'), 4000);
  }
}
var _tjSyncResetTimer = null;

function loadState() {
  try { const r = localStorage.getItem(STORAGE_KEY); if (r) state = JSON.parse(r); } catch(e) {}
  if (!Array.isArray(state.deletedIds)) state.deletedIds = [];
  // Restore canvas data from localStorage into whiteboard entries
  state.entries.forEach(entry => {
    if (entry.template === 'whiteboard') {
      const saved = localStorage.getItem(TJ_CANVAS_KEY(entry.id));
      if (saved && !entry.data.canvas) entry.data.canvas = saved;
    }
    // Migrate legacy localStorage locks to entry.lock (one-time)
    if (!entry.lock) {
      try {
        const legacyKey = 'tj_lock_' + entry.id;
        const legacyLock = JSON.parse(localStorage.getItem(legacyKey));
        if (legacyLock && legacyLock.hash) {
          entry.lock = { hash: legacyLock.hash, plain: legacyLock.plain || '' };
          localStorage.removeItem(legacyKey); // remove after migration
        }
      } catch(e) {}
    }
  });
}

// Write the local cache safely — mirror of _bjWriteCache. localStorage is ONLY a fast
// cache (Firebase is the real store); whiteboard canvases live under TJ_CANVAS_KEY(id)
// and are rehydrated by loadState, so omit them from the main blob to stay under the
// ~5MB quota, and swallow any QuotaExceededError so it can never break open/lock/sync.
function _tjOmitCanvas(k, v) {
  if (k === 'canvas' && typeof v === 'string' && v.length > 1024) return '';
  // Page images the cloud already holds are cached as their tj-fbimg://
  // placeholder rather than their bytes — loadActiveEntry rehydrates them on
  // paint, exactly as it does for an entry that arrived from Firebase. This is
  // most of the blob by size, and it is re-serialised on every autosave.
  if (k === 'html' && typeof v === 'string' && v.length > 8192 && v.indexOf('data-tjkey="') >= 0) return _tjSlimHtml(v);
  return v;
}
function _tjSlimHtml(h) {
  return h.replace(/<[^>]*\bdata-tjkey="([^"]+)"[^>]*>/g, function (tag, key) {
    return tag.replace(/\b(src|href)="data:[^"]*"/, '$1="tj-fbimg://' + key + '"');
  });
}
function _tjWriteCache() {
  if (_tjIsOJ()) { if (window.OJ) window.OJ.writeCache('tj'); return; }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state, _tjOmitCanvas)); }
  catch (e) { /* quota exceeded / private mode: keep last good cache; Firebase holds the full data */ }
}

function saveState() {
  if (_tjIsOJ()) { if (window.OJ) window.OJ.touched('tj'); return; }
  // Save full state to localStorage (minus bulky canvases) — instant, best-effort
  _tjWriteCache();
  state.entries.forEach(entry => {
    if (entry.template === 'whiteboard' && entry.data && entry.data.canvas) {
      try { localStorage.setItem(TJ_CANVAS_KEY(entry.id), entry.data.canvas); } catch(e) {}
    }
  });
  // Show syncing immediately — even before debounce fires
  _tjSetSync('syncing');
  if (window._fbSaveTonyJournal) {
    // Capture activeId NOW — see BJ saveState. Prevents an entry-switch inside the
    // debounce window from redirecting the save to the wrong (newly-active) entry.
    // The state object too: OurJournal may be on screen by the time this runs.
    var _tjSid = state.activeId, _tjSt = state;
    window._fbSaveTonyJournal(() => ({ entries: _tjSt.entries, activeId: _tjSid }));
  }
}

// Persistence routers — see the Brainstorm twins.
function _tjFbSaveEntry(e) {
  if (_tjIsOJ()) { if (window.OJ) window.OJ.touched('tj'); return; }
  if (window._fbSaveTonyJournalEntry) window._fbSaveTonyJournalEntry(e, state.entries);
}
function _tjFbDelete(id) {
  if (_tjIsOJ()) { if (window.OJ) window.OJ.hardDelete('tj', id); return; }
  if (window._fbDeleteTonyJournalEntry) window._fbDeleteTonyJournalEntry(id);
}
function _tjFbFlush() {
  if (_tjIsOJ()) return window.OJ ? window.OJ.flush('tj') : undefined;
  if (window._fbFlushTonyJournal) return window._fbFlushTonyJournal();
}
function _tjFbOrder() {
  if (_tjIsOJ()) { if (window.OJ) window.OJ.touched('tj'); return; }
  if (window._fbSaveTonyJournalOrder) window._fbSaveTonyJournalOrder(state.entries);
}
function _tjWithPersonal(fn) {
  if (!_tjIsOJ() || !_tjPersonal) return fn();
  var shown = state, keep = _tjPersonal.activeId;
  state = _tjPersonal; state.activeId = null; _tjHidden = true;
  try { return fn(); }
  finally {
    _tjPersonal = state; _tjPersonal.activeId = keep;
    _tjHidden = false; state = shown;
  }
}

// Merge remote state into local.
// With the new per-entry field storage model, each entry arrives independently.
// No collision is possible between two users editing different entries.
// For the same entry: remote wins if it's newer (last-write-wins), EXCEPT for
// the exact textarea/field the user is currently typing in — that field is protected.
function _tjApplyRemote(remote) {
  if (!remote || !Array.isArray(remote.entries)) return;
  // This is always the personal journal's own document. With OurJournal on
  // screen, apply it to the personal collection waiting off-screen.
  if (_tjIsOJ() && !_tjHidden) return _tjWithPersonal(function() { _tjApplyRemote(remote); });

  var focused = document.activeElement;

  // "Is the user actively editing something here that must not be yanked away?"
  // Focus alone is not the right test: an EMPTY field holds no cursor position and
  // no in-progress text worth protecting, and treating it as protected is what kept
  // an entry that came back blank from ever healing — the moment you clicked into it
  // to see what had happened, the repair was vetoed and the blank stayed.
  function _tjBusy(el) {
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
  if (activeEntry && _tjDomOwner === activeEntry.id) {
    // Capture ONLY the focused field — see _bjApplyRemote. Prevents opening an
    // entry on a phone from overwriting its title with the empty desktop input.
    var _fa = document.activeElement;
    var _titleEl = document.getElementById('tj-entry-title-input');
    if (_titleEl && _fa === _titleEl) activeEntry.title = _titleEl.value;
    if (activeEntry.template === 'page') {
      var _pe = document.getElementById('tj-page-editor');
      if (_pe && (_fa === _pe || _pe.contains(_fa))) activeEntry.data.html = _pe.innerHTML;
    } else if (activeEntry.template === 'journal-entries') {
      // Only flush when the user is actually editing (something focused) — on a
      // bare open, focus is body/null, so we must not snapshot empty fields.
      if (_fa && _fa !== document.body && window._jeSaveActiveDate) window._jeSaveActiveDate(activeEntry);
    }
    activeEntry.updated = activeEntry.updated || Date.now();
  }

  // Build lookup of local entries by id
  var localById = {};
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
        var lc = localStorage.getItem(TJ_CANVAS_KEY(remoteEntry.id));
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
    else                      _remoteWins = remoteUpdated > localUpdated;
    if (!_remoteWins) {
      if (!_localEmpty) return;
      console.warn('[JGuard] tj entry ' + remoteEntry.id + ' is empty locally but has content on the server — taking the server copy');
    }
    // Remote is about to replace local content. If it is SMALLER, keep the local
    // version in the rolling backup first — that is the last line of defence if a
    // wipe still reaches the cloud from some other device.
    if (window.JGuard) window.JGuard.backup('tj', local, remoteEntry.data);

    if (remoteEntry.template === 'whiteboard') {
      // A whiteboard entry carries only its fingerprint now; the board itself
      // lives in its own document with its own sync. Keep any legacy canvas the
      // remote copy has had stripped from it.
      var lc2 = local.data && local.data.canvas ? local.data.canvas : localStorage.getItem(TJ_CANVAS_KEY(local.id)) || '';
      localById[remoteEntry.id] = { ...remoteEntry, data: { ...remoteEntry.data, canvas: lc2 } };
      return;
    }

    if (local.id !== state.activeId) {
      // Inactive entry — remote wins outright, no typing to protect
      localById[remoteEntry.id] = remoteEntry;
      return;
    }

    // ── Active entry, remote is newer: apply per-field, skip focused element ──
    if (remoteEntry.template === 'page') {
      var pageEd = document.getElementById('tj-page-editor');
      var userInEditor = _tjBusy(pageEd);
      if (!userInEditor) {
        // Apply remote HTML, rehydrate images if needed
        localById[remoteEntry.id] = remoteEntry;
        var remoteHtml = remoteEntry.data && remoteEntry.data.html || '';
        if (pageEd) {
          if (remoteHtml.includes('tj-fbimg://') && window._fbRehydrateTonyPageImages) {
            window._fbRehydrateTonyPageImages(remoteHtml).then(function(rehydrated) {
              if (pageEd) { pageEd.innerHTML = rehydrated; }
              var ae = getActive(); if (ae) { ae.data.html = rehydrated; }
              if (pageEd && typeof _pgBindImgWrap !== 'undefined') pageEd.querySelectorAll('.pg-img-wrap').forEach(_pgBindImgWrap);
            });
          } else {
            pageEd.innerHTML = remoteHtml;
            if (typeof _pgBindImgWrap !== 'undefined') pageEd.querySelectorAll('.pg-img-wrap').forEach(_pgBindImgWrap);
          }
        }
      }
      // else: user is typing in page editor, skip to avoid disrupting cursor
    } else if (remoteEntry.template === 'journal-entries') {
      var jeEdR = document.getElementById('tj-je-editor');
      var userInJE = _tjBusy(jeEdR);
      // Always update localById with the remote entry so state stays in sync.
      // If user is currently typing in the editor, preserve ONLY the active date's
      // current editor content — all other dates come from remote (last-write-wins).
      if (userInJE) {
        // Flush current editor into local state first
        if (window._jeSaveActiveDate) {
          var localForJE = localById[remoteEntry.id] || local;
          if (localForJE) window._jeSaveActiveDate(localForJE);
        }
        var localForJE2 = localById[remoteEntry.id] || local;
        var currentActiveKey = localForJE2 && localForJE2.data && localForJE2.data.activeDateKey;
        var currentDateContent = (localForJE2 && localForJE2.data && localForJE2.data.dates && currentActiveKey)
          ? localForJE2.data.dates[currentActiveKey]
          : null;
        // Accept remote entry wholesale, then restore the date the user is editing
        var mergedForUser = remoteEntry;
        if (currentDateContent && currentActiveKey && remoteEntry.data && remoteEntry.data.dates) {
          var mergedDatesForUser = Object.assign({}, remoteEntry.data.dates);
          mergedDatesForUser[currentActiveKey] = currentDateContent;
          mergedForUser = Object.assign({}, remoteEntry, {
            data: Object.assign({}, remoteEntry.data, {
              dates: mergedDatesForUser,
              activeDateKey: currentActiveKey
            })
          });
        }
        localById[remoteEntry.id] = mergedForUser;
      } else {
        // Not editing — accept remote wholesale
        localById[remoteEntry.id] = remoteEntry;
      }
      // Refresh UI if this is the active entry
      if (remoteEntry.id === state.activeId) {
        // Commit to state.entries NOW so getActive() returns the merged entry
        state.entries = state.entries.map(function(e) {
          return e.id === remoteEntry.id ? localById[remoteEntry.id] : e;
        });
        var aeJE = getActive();
        if (aeJE && window._jeRenderTabs) {
          window._jeRenderTabs(aeJE, userInJE /* preserveEditorDOM when user is typing */);
        }
      }
    } else {
      localById[remoteEntry.id] = remoteEntry;
    }
  });

  // Apply the authoritative trash/recover winner to the merged entries so a
  // delete or recover on any device reflects live here, regardless of which
  // content-merge branch ran or how the content `updated` timestamps compared.
  // (Without this the `remoteUpdated <= localUpdated` guard above silently drops
  // a remote delete whenever this device's copy has a newer content timestamp.)
  Object.keys(_winnerTrashed).forEach(function(id) {
    var m = localById[id];
    if (!m) return;
    var w = _winnerTrashed[id];
    if (w.t) m.trashed = w.t; else if (m.trashed) delete m.trashed;
    if (w.c) m.trashChangedAt = w.c;   // converge the trash-action clock across devices
  });

  // Remove entries deleted on another device.
  // _allPresentIds from snapshot is the authoritative e_* key list. Absent + _fbPushed = remote delete.
  var remotePresentIds = new Set(remote.entries.map(function(e) { return e.id; }));
  var authorizedPresentIds = remote._allPresentIds
    ? new Set(remote._allPresentIds)
    : remotePresentIds;
  var ownDeletedSet = new Set(state.deletedIds || []);
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
  _tjForgetDeleted(_prunedRemotely);

  // Rebuild state.entries: if remote has _order, use it; else preserve local order + append new
  var existingIds = new Set(state.entries.map(function(e) { return e.id; }));
  var allEntries = state.entries.map(function(e) { return localById[e.id] || e; });
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
  var _activeGone = state.activeId && !state.entries.find(function(e) { return e.id === state.activeId; });
  var _activeTrashed = state.activeId && (state.entries.find(function(e){ return e.id === state.activeId; }) || {}).trashed;
  if (_activeGone || _activeTrashed) {
    state.activeId = (state.entries.find(function(e){ return !e.trashed; }) || {}).id || null;
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
      _tjFbSaveEntry(e);
    });
  }

  // NEVER override local activeId — each device stays on its own entry
  _tjWriteCache();
  renderSidebar();
  // Re-run lock check in case remote updated lock status on current entry
  if (window._tjLockCheck && !_tjHidden) window._tjLockCheck();
}

// The host's onSave: called with the entry the cloud just confirmed.
if (typeof _tjCfg.onSave === 'function') window.addEventListener('fb-tj-saved', function(ev) {
  var _sid = ev && ev.detail && ev.detail.id;
  var e = _sid && state.entries.find(function(x){ return x.id === _sid; });
  if (e) { try { _tjCfg.onSave(e); } catch (err) { console.warn('[Notebook] onSave failed:', err); } }
});
// Listen for Firebase sync events
window.addEventListener('fb-tj-saved', function(ev) {
  _tjSetSync('synced');
  // Confirmed in the cloud: record that it has been pushed and drop the unsynced
  // mark. Keyed by the id the event names, because the save that just landed is not
  // always for the entry that is active NOW.
  _tjWithPersonal(function() {
    var _sid = ev && ev.detail && ev.detail.id;
    var ae = _sid ? state.entries.find(function(x){ return x.id === _sid; }) : getActive();
    if (ae) { ae._fbPushed = true; delete ae._dirty; _tjWriteCache(); }
  });
});
window.addEventListener('fb-tj-synced', function() { _tjSetSync('synced'); });
window.addEventListener('fb-tj-error', function() { _tjSetSync('error'); });
window.addEventListener('fb-tj-prompt-saved', function() { _tjSetSync('synced'); });
window._tjSetSync = _tjSetSync;   // exposed so the AI-prompt save can drive the sync pill
window.addEventListener('fb-tj-remote-update', function(e) { _tjApplyRemote(e.detail); });

// Initial Firebase load when FB ready
function _tjInitFirebase() {
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
  if (window._fbLoadTonyJournal) {
    window._fbLoadTonyJournal().then(function (remote) {
      if (!remote || !remote._legacy) return;
      if (Array.isArray(remote.entries) && remote.entries.length > 0 && window._fbMigrateTonyJournalIfNeeded) {
        window._fbMigrateTonyJournalIfNeeded(remote.entries);
      }
    });
  }
  // The merge comes from the authoritative resync — a forced SERVER read applied as
  // the truth — so a cold launch shows the current document instead of this device's
  // cached memory of it. Safe to call repeatedly; that is the point.
  if (window._fbResyncTonyJournal) {
    var _rs = window._fbResyncTonyJournal();
    if (typeof _tjCfg.onReady === 'function' && !_tjCfg._readyFired && _rs && _rs.then) _rs.then(function () {
      if (_tjCfg._readyFired) return;
      _tjCfg._readyFired = true;
      try { _tjCfg.onReady(); } catch (err) { console.warn('[Notebook] onReady failed:', err); }
    });
  }
}
// Re-run on EVERY fb-ready, not just the first. The connection is torn down whenever
// the tab is hidden or the phone suspends the app, and re-established on the way
// back; before this, that reconnect re-attached the listeners but never re-read the
// document, so a device returning after days sat on its cache until something
// happened to change server-side.
if (window._fbReady) _tjInitFirebase();
window.addEventListener('fb-ready', _tjInitFirebase);

function getActive() { return state.entries.find(e => e.id === state.activeId) || null; }

function createEntry(template) {
  const id = 'e_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const entry = { id, title: '', template: template || 'page', created: Date.now(), updated: Date.now(), tags: [], data: {} };
  if (template === 'whiteboard') entry.data = { attachments: [] };
  if (template === 'mindmap') entry.data = { attachments: [] };
  if (template === 'page') entry.data = { html: '', attachments: [] };
  if (template === 'journal-entries') entry.data = { dates: {}, activeDateKey: '', dateOrder: [] };
  // Unsynced until the cloud confirms it — without this an authoritative resync
  // arriving in the next second would prune an entry the server has never seen.
  entry._dirty = true;
  // A shared entry records who made it (Tony, from here) and opens its live document.
  if (_tjIsOJ() && window.OJ) window.OJ.created('tj', entry);
  state.entries.unshift(entry);
  state.activeId = id;
  saveState(); renderSidebar(); loadActiveEntry();
}

// ── TRASH SYSTEM: delete = move to Trash (30 days), synced via entry.trashed ──
const TJ_TRASH_TTL = 30 * 24 * 60 * 60 * 1000;
function deleteEntry(id) {
  const entry = state.entries.find(e => e.id === id);
  if (!entry || _tjIsPinned(id)) return;
  var _bjDelTs = Date.now();
  entry.trashed = _bjDelTs;
  entry.trashChangedAt = _bjDelTs;   // trash-action clock (drives cross-device delete sync)
  entry.updated = _bjDelTs;
  if (state.activeId === id) state.activeId = (state.entries.find(e => !e.trashed) || {}).id || null;
  saveState(); renderSidebar(); loadActiveEntry();
  // Push the trashed entry itself (it isn't the active one, so the debounced save skips it)
  _tjFbSaveEntry(entry);
}
// Tombstone one or more ids that are gone for good — locally purged here, or
// purged on another device and pruned by the remote merge. Recording them in
// deletedIds is what stops a late in-flight write from any device resurrecting
// the entry, and clearing the per-entry lock/unlock keys stops a deleted-but-
// locked document from leaving a lock overlay that can never be satisfied.
function _tjForgetDeleted(ids) {
  if (!ids || !ids.length) return;
  if (!Array.isArray(state.deletedIds)) state.deletedIds = [];
  ids.forEach(function(id) {
    if (!state.deletedIds.includes(id)) state.deletedIds.push(id);
    try {
      localStorage.removeItem('tj_unlocked_' + id);
      localStorage.removeItem('tj_unlockedv_' + id);
      localStorage.removeItem('tj_unlockedat_' + id);
      sessionStorage.removeItem('tj_unlocked_' + id);
      sessionStorage.removeItem('tj_unlockedv_' + id);
      sessionStorage.removeItem('tj_unlockedat_' + id);
      localStorage.removeItem(TJ_CANVAS_KEY(id));
    } catch (e) {}
  });
  // Keep the tombstone list from growing without bound across years of use.
  if (state.deletedIds.length > 500) state.deletedIds = state.deletedIds.slice(-500);
}
// Permanent delete — used by the Trash UI and the 30-day auto-purge
function hardDeleteEntry(id) {
  if (_tjIsPinned(id)) return;
  _tjForgetDeleted([id]);
  _tjFbDelete(id);
  state.entries = state.entries.filter(e => e.id !== id);
  if (state.activeId === id) state.activeId = (state.entries.find(e => !e.trashed) || {}).id || null;
  saveState(); renderSidebar(); loadActiveEntry();
}
/* The MyJournal twin of the Brainstorm Journal purge guard — same bug, same
 * reasoning, and it must stay in step with it. See the long comment on the BJ
 * side: a boot-time purge decides a PERMANENT, cross-device delete from this
 * device's localStorage, which on a cold start can hold a `trashed` stamp that
 * another device has already reverted. _tjWhenServerSeen defers the write but
 * not the decision, so the delete fires as soon as the connection opens.
 *
 * Waits for an authoritative server read, then re-reads its own decision from
 * the reconciled state. */
let _tjPurgeDone = false, _tjPurgeScheduled = false;
function purgeExpiredTrash(opts) {
  if (!opts || !opts.authoritative) { _tjSchedulePurge(); return; }
  // Purges the personal journal only (OurJournal's trash is the OJ engine's).
  if (_tjIsOJ() && !_tjHidden) return _tjWithPersonal(function() { purgeExpiredTrash(opts); });
  if (_tjPurgeDone) return;
  _tjPurgeDone = true;
  const cutoff = Date.now() - TJ_TRASH_TTL;
  const doomed = state.entries.filter(e => e.trashed && e.trashed < cutoff).map(e => e.id);
  if (!doomed.length) return;
  console.warn('[TJ] purging ' + doomed.length + ' entr' + (doomed.length === 1 ? 'y' : 'ies') +
               ' past the ' + (TJ_TRASH_TTL / 86400000) + '-day trash limit');
  doomed.forEach(hardDeleteEntry);
}
/* Gated on an AUTHORITATIVE remote update, not fb-tj-synced — that event also
 * fires for cache-sourced snapshots, and purging off the cache is the very bug
 * being fixed. See the BJ twin. */
function _tjSchedulePurge() {
  if (_tjPurgeDone || _tjPurgeScheduled) return;
  _tjPurgeScheduled = true;
  window.addEventListener('fb-tj-remote-update', function _once(ev) {
    if (!ev || !ev.detail || !ev.detail._authoritative) return;   // cached view — keep waiting
    window.removeEventListener('fb-tj-remote-update', _once);
    setTimeout(() => purgeExpiredTrash({ authoritative: true }), 0);
  });
}
window._tjTrashAPI = {
  list: () => state.entries.filter(e => e.trashed).sort((a,b) => (b.trashed||0)-(a.trashed||0)),
  restore: (ids) => {
    (ids||[]).forEach(id => {
      const e = state.entries.find(x => x.id === id);
      if (e) { var _rTs = Date.now(); delete e.trashed; e.trashChangedAt = _rTs; e.updated = _rTs; _tjFbSaveEntry(e); }
    });
    saveState(); renderSidebar();
  },
  purge: (ids) => { (ids||[]).forEach(hardDeleteEntry); },
  ttlDays: 30
};

// ── Per-page margins (Batch 10 #3): stored on the active entry, synced to
// Firebase with it, so dragging a margin affects only that document. Both sheet
// templates — Page and Journal Entries — carry their own margins. ──
const _TJ_SHEET_TEMPLATES = ['page', 'journal-entries'];
window._tjGetPageMargins = function() {
  const e = state.entries.find(x => x.id === state.activeId);
  if (e && _TJ_SHEET_TEMPLATES.includes(e.template) && e.data && e.data.margins && typeof e.data.margins.ml === 'number') return e.data.margins;
  return null;
};
window._tjSetPageMargins = function(m) {
  const e = state.entries.find(x => x.id === state.activeId);
  if (e && _TJ_SHEET_TEMPLATES.includes(e.template)) { e.data.margins = m; e.updated = Date.now(); autoSave(); }
};

// ── UNIFIED SEARCH: title + full content + tags; multi-tag filter ──
let tjTagFilters = [];
function _tjEntryText(e) {
  const d = e.data || {};
  const parts = [e.title || '', (e.tags||[]).join(' ')];
  if (d.html) parts.push(String(d.html).replace(/<[^>]*>/g, ' '));
  if (d.dates) Object.values(d.dates).forEach(dd => { if (dd && dd.html) parts.push(String(dd.html).replace(/<[^>]*>/g, ' ')); });
  if (d.nodes) d.nodes.forEach(n => parts.push(n.label || ''));
  return parts.join(' ').toLowerCase();
}
function _tjHlTitle(text, q) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0,i)) + '<mark class="docx-hl">' + esc(text.slice(i, i+q.length)) + '</mark>' + esc(text.slice(i+q.length));
}
function _tjRenderTagChips(live) {
  let row = document.getElementById('tj-tagfilter-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'tj-tagfilter-row';
    row.className = 'docx-tagchips';
    const listEl = document.getElementById('tj-entries-list');
    listEl.parentNode.insertBefore(row, listEl);
  }
  const all = [...new Set(live.reduce((a,e) => a.concat(e.tags||[]), []))].sort((a,b)=>a.localeCompare(b));
  tjTagFilters = tjTagFilters.filter(t => all.includes(t));
  row.classList.toggle('on', all.length > 0);
  row.style.display = '';
  row.innerHTML = '';
  if (!all.length) return;
  const lbl = document.createElement('div');
  lbl.className = 'docx-tagchips-lbl';
  lbl.textContent = 'Filter by tag';
  row.appendChild(lbl);
  all.forEach(tag => {
    const chip = document.createElement('button');
    chip.className = 'docx-tagchip' + (tjTagFilters.includes(tag) ? ' on' : '');
    chip.textContent = tag;
    chip.title = tag;
    chip.onclick = () => {
      tjTagFilters = tjTagFilters.includes(tag) ? tjTagFilters.filter(t => t !== tag) : tjTagFilters.concat(tag);
      renderSidebar();
    };
    row.appendChild(chip);
  });
}
function _tjRenderTrashBtn() {
  let btn = document.getElementById('tj-trash-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'tj-trash-btn';
    btn.className = 'docx-trash-btn';
    btn.onclick = () => { if (window._docxOpenTrash) window._docxOpenTrash('tj'); };
    const stats = document.getElementById('tj-sidebar-stats');
    if (stats && stats.parentNode) stats.parentNode.insertBefore(btn, stats);
  }
  const n = state.entries.filter(e => e.trashed).length;
  btn.innerHTML = window.TNI.trash + '<span>Trash</span>' + (n ? ' <span class="docx-trash-count">' + n + '</span>' : '');
}

function renderSidebar() {
  if (_tjHidden) return;
  // A redraw never lands under a row that is being dragged.
  if (window.A1Drag && window.A1Drag.active) { window.A1Drag.later(renderSidebar); return; }
  _tjPinFirst();
  const list = document.getElementById('tj-entries-list');
  const search = document.getElementById('tj-search-box').value.toLowerCase().trim();
  const live = state.entries.filter(e => !e.trashed);
  const entries = live.filter(e => {
    // Locked entries: search title/tags only (never their hidden content)
    const isLocked = window._tjGetLock && window._tjGetLock(e.id) && !(window._tjIsUnlocked && window._tjIsUnlocked(e.id));
    const hay = isLocked ? ((e.title||'') + ' ' + (e.tags||[]).join(' ')).toLowerCase() : _tjEntryText(e);
    return (!search || hay.includes(search)) &&
           (tjTagFilters.length === 0 || tjTagFilters.every(t => (e.tags||[]).includes(t)));
  });
  list.innerHTML = '';
  if (entries.length === 0) {
    list.innerHTML = `<div class="list-empty">${search || tjTagFilters.length ? 'No entries match your search.' : (_tjIsOJ() ? 'Nothing shared yet.<br>Anything created here is visible to Tony and Veda.' : 'No entries yet.<br>Click "New Entry" to begin.')}</div>`;
  }
  // Reordering is MAGI's drag (dragsort.js, theme overhaul phase 2): a mouse
  // takes the row anywhere, a finger only by its grip, and the grip's arrow
  // keys move it one place. Off while a search or tag filter is narrowing the
  // list, because a move between two filtered rows has no clear meaning.
  const isDraggable = !search && tjTagFilters.length === 0;

  entries.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'entry-item' + (entry.id === state.activeId ? ' active' : '');
    div.dataset.entryId = entry.id;
    div.dataset.dkey = entry.id;
    const tmap = { whiteboard: 'BOARD', mindmap: 'MAP', page: 'PAGE', 'journal-entries': 'JOURNAL' };
    // A pinned page the store has not saved yet has no date (updated 0).
    const date = entry.updated ? new Date(entry.updated).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const titleClass = entry.title ? '' : ' untitled';
    div.innerHTML = `
      <div class="entry-item-title${titleClass}">${_tjHlTitle(entry.title || 'Untitled', search)}</div>
      <div class="entry-item-meta">
        <span class="template-badge">${tmap[entry.template]||'NOTE'}</span>
        <span>${date}</span>
        ${(entry.tags||[]).length ? `<span>· ${entry.tags.slice(0,2).join(', ')}${entry.tags.length > 2 ? '…' : ''}</span>` : ''}
        ${_tjIsOJ() && entry.creator && window.OJ ? `<span class="oj-by oj-by-${entry.creator}" title="Created by ${window.OJ.name(entry.creator)}">${window.OJ.name(entry.creator)}</span>` : ''}
      </div>
      <button class="entry-delete" data-id="${entry.id}" title="Move to Trash">${window.TNI.x}</button>
    `;
    if (_tjIsPinned(entry.id)) { div.classList.add('nb-pinned'); div.querySelector('.entry-delete').style.setProperty('display', 'none', 'important'); }
    div.addEventListener('click', e => {
      if (e.target.closest('.entry-delete')) return;
      // Flush the just-edited entry BEFORE changing activeId — see BJ sidebar handler.
      saveCurrentEntry(); _tjFbFlush(); state.activeId = entry.id; renderSidebar(); loadActiveEntry();
    });
    div.querySelector('.entry-delete').addEventListener('click', async e => {
      e.stopPropagation();
      // If entry is locked, require password before deleting
      var lock = window._tjGetLock && window._tjGetLock(entry.id);
      if (lock) {
        var alreadyUnlocked = window._tjIsUnlocked && window._tjIsUnlocked(entry.id);
        if (!alreadyUnlocked) {
          var pw = await window.uiPrompt('This entry is locked. Enter password to delete:', {title:'Locked entry', password:true});
          if (pw === null) return;
          // The lock's worker calls live inside the lock code below; it hands
          // them out through _tjLock.
          try {
            var data = await _tjLock.post('/auth/journal/verify', { journal: 'tj', entryId: entry.id, password: pw });
            if (!data.ok) { await window.uiAlert('Incorrect password. Entry not deleted.'); return; }
            if (await window.uiConfirm('Delete "' + (entry.title || 'Untitled') + '"?', {danger:true, okLabel:'Delete'})) {
              await _tjLock.post('/auth/journal/remove-lock', { journal: 'tj', entryId: entry.id, password: pw }).catch(function(){});
              deleteEntry(entry.id);
            }
          } catch(e) { await window.uiAlert(_tjLock.errText(e)); }
          return;
        }
      }
      if (await window.uiConfirm(`Delete "${entry.title || 'Untitled'}"?`, {danger:true, okLabel:'Delete'})) deleteEntry(entry.id);
    });
    list.appendChild(div);
  });
  if (window.A1Drag) {
    // Rows as drawn are `entries`; state.entries also holds the trashed ones,
    // so a move is "put this id before / after that id", not an index shift.
    const move = (from, to) => {
      if (from === to || !entries[from] || !entries[to]) return;
      const fi = state.entries.findIndex(x => x.id === entries[from].id);
      if (fi < 0) return;
      const [moved] = state.entries.splice(fi, 1);
      const ti = state.entries.findIndex(x => x.id === entries[to].id);
      state.entries.splice(to > from ? ti + 1 : ti, 0, moved);
      _tjPinFirst();
      saveState(); renderSidebar(); _tjFbOrder();
    };
    // A row: a mouse takes it anywhere, a finger after a 300ms hold (no grip: Tony, 2026-10-02).
    window.A1Drag.sort(list, {
      row: '.entry-item',
      hold: 300,
      canDrag: (row) => isDraggable && !_tjIsPinned(row.dataset.entryId),
      onDrop: move,
    });
  }
  const ec = document.getElementById('tj-entry-count');
  if (ec) ec.textContent = live.length;
  _tjRenderTagChips(live);
  _tjRenderTrashBtn();
}

function showTemplate(name) {
  // Leaving a board flushes it and drops its remote listener — see the BJ twin.
  if (name !== 'whiteboard' && _tjBoards.wb) _tjBoards.wb.close();
  if (name !== 'mindmap'    && _tjBoards.mm) _tjBoards.mm.close();
  document.getElementById('tj-wb-canvas-wrap').style.display = name === 'whiteboard' ? 'flex' : 'none';
  document.getElementById('tj-mindmap-area').style.display = name === 'mindmap' ? 'flex' : 'none';
  document.getElementById('tj-page-area').style.display = name === 'page' ? 'flex' : 'none';
  document.getElementById('tj-je-area').style.display = name === 'journal-entries' ? 'flex' : 'none';
  document.getElementById('tj-empty-state').style.display = name ? 'none' : 'flex';
  document.getElementById('tj-tags-row').style.display = name ? 'flex' : 'none';
  // Page toolbar edit-mode sync
  const pt = document.getElementById('tj-page-toolbar');
  if (pt) { if (name === 'page' && isEditMode) pt.classList.add('edit-mode'); else pt.classList.remove('edit-mode'); }
  // Journal Entries toolbar edit-mode sync
  const jet = document.getElementById('tj-je-toolbar');
  if (jet) { if (name === 'journal-entries' && isEditMode) jet.classList.add('edit-mode'); else jet.classList.remove('edit-mode'); }
}

function loadActiveEntry() {
  if (_tjHidden) return;
  const entry = getActive();
  // Nothing painted for any entry yet — see _tjDomOwner. Cleared BEFORE the early
  // returns below, so the blank editor they leave behind can never be read back as
  // an entry's new content.
  _tjDomOwner = null;
  if (!entry) { document.getElementById('tj-entry-title-input').value = ''; showTemplate(null); renderTags([]); if (_tjIsOJ() && window.OJ) window.OJ.painted('tj', null); return; }
  // A shared entry's content is fetched on first open (only the index is kept
  // live for the whole list). The engine calls back here once it has it.
  if (_tjIsOJ() && window.OJ && !window.OJ.isLoaded(entry)) {
    document.getElementById('tj-entry-title-input').value = entry.title || '';
    showTemplate(null); renderTags(entry.tags || []);
    window.OJ.open('tj', entry);
    return;
  }
  // Lock guard: if entry is locked and not yet unlocked this session, show lock screen — no content
  if (window._tjGetLock && window._tjGetLock(entry.id) && !(window._tjIsUnlocked && window._tjIsUnlocked(entry.id))) {
    document.getElementById('tj-entry-title-input').value = '';
    showTemplate(null);
    renderTags([]);
    if (window._tjLockCheck) window._tjLockCheck();
    return;
  }
  // An entry that has come back empty while a local copy of its content survives is
  // healed here, before it is painted — otherwise the blank paint is what the next
  // save would publish. Only ever fills an EMPTY entry, so it can never overwrite
  // anything the user still has. See JGuard.recover.
  if (window.JGuard && window.JGuard.recover('tj', entry)) { entry.updated = Date.now(); _tjWriteCache(); }
  document.getElementById('tj-entry-title-input').value = entry.title;
  showTemplate(entry.template);
  renderTags(entry.tags || []);
  if (entry.template === 'whiteboard') {
    _tjBoard('wb').open(entry).then(function () { _tjBoard('wb').setEditable(isEditMode); });
  }
  if (entry.template === 'mindmap') {
    _tjBoard('mm').open(entry).then(function () { _tjBoard('mm').setEditable(isEditMode); });
  }
  if (entry.template === 'page') {
    const ed = document.getElementById('tj-page-editor');
    const html = entry.data.html || '';
    ed.innerHTML = html;
    ed.contentEditable = isEditMode ? 'true' : 'false';
    updatePageToolbarState();
    if (window._docxOnLoad) window._docxOnLoad('tj-page-editor', entry.id);
    // Rebind image handlers lost when innerHTML was set
    ed.querySelectorAll('.pg-img-wrap').forEach(_pgBindImgWrap);
    if (html.includes('tj-fbimg://') && window._fbRehydrateTonyPageImages) {
      window._fbRehydrateTonyPageImages(html).then(rehydrated => {
        if (rehydrated !== html) {
          ed.innerHTML = rehydrated;
          entry.data.html = rehydrated;
          // Rebind again after rehydration replaces innerHTML
          ed.querySelectorAll('.pg-img-wrap').forEach(_pgBindImgWrap);
        }
      });
    }
  }
  if (entry.template === 'journal-entries') {
    if (!entry.data) entry.data = {};
    if (!entry.data.dates) entry.data.dates = {};
    if (!entry.data.dateOrder) entry.data.dateOrder = Object.keys(entry.data.dates).sort();
    _jeRenderTabs(entry);
  }
  // The DOM now genuinely shows THIS entry, so saveCurrentEntry may read it. Last
  // line on purpose: everything above either paints or bails, and a save that lands
  // mid-paint must find the editor still marked as nobody's.
  _tjDomOwner = entry.id;
  if (_tjIsOJ() && window.OJ) window.OJ.painted('tj', entry);
}

function saveCurrentEntry() {
  const entry = getActive(); if (!entry) return;
  clearTimeout(autoTimer); _tjAutoFirstAt = 0;   // this IS the save the pending timer was for
  const _userEdit = _tjUserEdited; _tjUserEdited = false;
  // GUARD: see BJ — do not persist a locked-but-not-unlocked entry's blank DOM.
  if (window._tjGetLock && window._tjGetLock(entry.id) && !(window._tjIsUnlocked && window._tjIsUnlocked(entry.id))) return;
  // GUARD (DOM ownership): every template shares one set of DOM nodes, and a cloud
  // document borrows the page editor outright. Reading that DOM for an entry it was
  // not painted for files someone else's content — or a blank, still-loading
  // editor — under this id, and the whole-entry cloud write then propagates it to
  // every device. loadActiveEntry() stamps the id it painted; anything else means
  // the DOM is not ours to read. See the JGuard block for the full list of ways
  // this used to happen.
  if (_tjDomOwner !== entry.id) return;

  // Read the DOM into a PROPOSED copy of data rather than straight into the entry,
  // so the two guards below can still refuse it. Nothing is committed until both pass.
  const _next = Object.assign({}, entry.data);
  // See the BJ twin: visual templates put a fingerprint on the entry and keep
  // their content in their own document.
  if (entry.template === 'whiteboard' || entry.template === 'mindmap') {
    var _vb = _tjBoards[entry.template === 'whiteboard' ? 'wb' : 'mm'];
    var _vs = (_vb && _vb.isOpen(entry.id)) ? _vb.stats() : null;
    if (_vs) { _next.vizRev = _vs.rev; _next.vizCount = _vs.count; _next.vizTitle = _vs.title; }
  }
  if (entry.template === 'page') { _next.html = document.getElementById('tj-page-editor').innerHTML; }
  if (entry.template === 'journal-entries') {
    // _jeSaveActiveDate writes into entry.data.dates, so give it a detached dates
    // map — otherwise the proposal would mutate the entry before it is vetted.
    _next.dates = Object.assign({}, entry.data && entry.data.dates);
    _jeSaveActiveDate({ template: 'journal-entries', data: _next });
  }

  // Auto-title: derive from content while the title is empty; a user-typed title
  // always wins. Read from the PROPOSED data above, not the stored data — see the BJ twin for why.
  let _title = document.getElementById('tj-entry-title-input').value;
  if (!_title.trim()) {
    const _auto = _tjAutoTitle(entry, _next);
    if (_auto) {
      _title = _auto;
      const _ti = document.getElementById('tj-entry-title-input');
      if (_ti && document.activeElement !== _ti) _ti.value = _auto;
    }
  }

  // GUARD (blank overwrite): never let an empty field replace stored content unless
  // this save came from a real edit. A blank editor here is almost never something
  // the user did — it is a load that has not painted, a lock screen, or a hidden
  // template area. A genuine select-all-and-delete goes
  // through autoSave (_userEdit === true) and is allowed straight through; its
  // previous version is kept locally first so even that is reversible.
  if (window.JGuard && window.JGuard.wouldLose(entry.template, entry.data, _next)) {
    if (!_userEdit) {
      console.warn('[JGuard] refused a blank overwrite of tj entry ' + entry.id + ' (editor was not user-edited)');
      return;
    }
    window.JGuard.backup('tj', entry, _next);
    // A deliberate clear must not be undone by recovery on the next open.
    if (window.JGuard.emptyData(entry.template, _next)) window.JGuard.markCleared('tj', entry.id);
  }

  // GUARD (no-op): only stamp `updated` when something ACTUALLY changed. The remote
  // merge resolves conflicts on that timestamp, so a no-op save on a session holding
  // stale content used to make the stale copy the permanent winner — the real remote
  // content was dropped on arrival and overwritten on the next write. This is the
  // root cause of content silently reverting after a background/refresh.
  if (window.JGuard && window.JGuard.sig(entry.template, entry.data, entry.title) ===
                       window.JGuard.sig(entry.template, _next, _title)) return;

  entry.title = _title;
  // Merged in place rather than reassigned: attachment lists, mindmap node arrays
  // and the whiteboard canvas are all held by reference elsewhere in this file.
  Object.assign(entry.data, _next);
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
function _tjAutoTitle(entry, dataOverride) {
  const d = dataOverride || entry.data || {};
  let src = '';
  if (entry.template === 'page') { const ed = document.getElementById('tj-page-editor'); src = ed && ed.innerText ? ed.innerText : String(d.html||'').replace(/<[^>]*>/g,'\n'); }
  else if (entry.template === 'journal-entries') {
    const k = d.activeDateKey || (d.dateOrder||[])[0];
    const dd = (k && d.dates) ? d.dates[k] : null;
    src = (dd && dd.html) ? String(dd.html).replace(/<[^>]*>/g,'\n') : '';
  }
  // The board reports its own title: a mind map's root topic, or the first text
  // written on a whiteboard.
  else if (entry.template === 'whiteboard' || entry.template === 'mindmap') src = d.vizTitle || '';
  const line = (src||'').split('\n').map(s=>s.trim()).find(s=>s.length > 1) || '';
  if (!line) return '';
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
}

/* TAGS */
function renderTags(tags) {
  const row = document.getElementById('tj-tags-row');
  row.querySelectorAll('.tag').forEach(t => t.remove());
  const input = document.getElementById('tj-add-tag-input');
  tags.forEach(tag => {
    const span = document.createElement('span');
    span.className = 'tag';
    const label = document.createElement('span');
    label.className = 'tag-txt';
    label.textContent = tag;
    span.appendChild(label);
    const delBtn = document.createElement('span');
    delBtn.className = 'tag-del';
    delBtn.innerHTML = window.TNI.x;
    delBtn.style.display = isEditMode ? '' : 'none';
    delBtn.onclick = () => {
      const e = getActive(); if (!e) return;
      e.tags = (e.tags||[]).filter(t => t !== tag);
      // A tag change is a real edit: bump the merge clock too, or the other device
      // resolves the incoming copy as older and silently drops it.
      e.updated = Date.now();
      saveState(); renderTags(e.tags); renderSidebar();
    };
    span.appendChild(delBtn);
    row.insertBefore(span, input);
  });
}
document.getElementById('tj-add-tag-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = e.target.value.trim().replace(/,/g,'');
    if (!val) return;
    const entry = getActive(); if (!entry) return;
    entry.tags = entry.tags || [];
    if (!entry.tags.includes(val)) entry.tags.push(val);
    entry.updated = Date.now();   // see the tag-delete handler above
    e.target.value = ''; saveState(); renderTags(entry.tags); renderSidebar();
  }
});

/* ── WHITEBOARD + MIND MAP ─────────────────────────────────────────────────
 * VizEngine boards, identical to Veda's except for the document prefix and the
 * tokens they inherit from #tj-root — which is the whole reason the engine is
 * parameterised rather than copied. New boards are OurJournal-only here: the
 * template modal hides and refuses them in MyJournal's own collection, and
 * Tony's older personal boards still open through this same code. See the VizEngine block for how a board is
 * stored and why it never touches the journal document.
 * ======================================================================== */
var _tjBoards = {};
function _tjBoard(kind) {
  if (_tjBoards[kind]) return _tjBoards[kind];
  var isWb = kind === 'wb';
  _tjBoards[kind] = window.VizEngine.createBoard({
    kind: kind,
    app: 'tj',
    // dashboards/tony_journal_viz_<id> and _vizf_<hash>, beside the legacy
    // tony_journal_canvas_<id> documents, which are read but never written.
    prefix: 'tony_journal',
    // A shared (OurJournal) entry's board lives in ourjournal_viz_<id> — the same
    // document Brainstorm Journal opens — and merges live with the other person.
    prefixFor: function (e) { return (_tjOJState && _tjOJState.entries.indexOf(e) >= 0 && window.OJ) ? window.OJ.NS : 'tony_journal'; },
    liveFor: function (e) { return !!(_tjOJState && _tjOJState.entries.indexOf(e) >= 0); },
    shell: document.getElementById(isWb ? 'tj-wb-canvas-wrap' : 'tj-mindmap-area'),
    mount: document.getElementById(isWb ? 'tj-wb-mount' : 'tj-mm-mount'),
    title: isWb ? 'Whiteboard' : 'Mind Map',
    setSync: function (s) { _tjSetSync(s); },
    entryTitle: function () { var e = getActive(); return (e && e.title) || 'Untitled Entry'; },
    onMeta: function () { autoSave(); },
    onPdf: function () { var e = getActive(); if (e) exportEntryAsPDF(e); }
  });
  return _tjBoards[kind];
}
window._tjFlushBoards = function () {
  return Promise.all(Object.keys(_tjBoards).map(function (k) { return _tjBoards[k].flush(); }));
};

/* PAGE EDITOR */
// Reflects the caret back into a ribbon. Both sheet templates run the same
// toolbar, so this takes the id prefix rather than hard-coding the Page one.
function updateSheetToolbarState(areaId, prefix) {
  const area = document.getElementById(areaId);
  if (!area || area.style.display === 'none') return;
  const cmds = ['bold','italic','underline','strikeThrough'];
  const names = ['bold','italic','underline','strike'];
  cmds.forEach((cmd,i) => {
    const btn = document.getElementById(prefix + names[i]);
    if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
  });
  // Sync block selector
  const sel = document.getElementById(prefix + 'block');
  if (!sel) return;
  const node = window.getSelection()?.anchorNode;
  if (!node) return;
  let el = node.nodeType === 3 ? node.parentElement : node;
  const tag = el.tagName ? el.tagName.toLowerCase() : 'p';
  const map = {h1:'h1',h2:'h2',h3:'h3',pre:'pre',blockquote:'blockquote'};
  sel.value = map[tag] || 'p';
  // Sync font-size selector: read computed size at cursor
  const fsSel = document.getElementById(prefix + 'fontsize');
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
function updatePageToolbarState() { updateSheetToolbarState('tj-page-area', 'tj-pt-'); }
function updateJeToolbarState()   { updateSheetToolbarState('tj-je-area', 'tj-je-pt-'); }

function pgCmd(cmd, val) {
  document.getElementById('tj-page-editor').focus();
  document.execCommand(cmd, false, val || null);
  autoSave();
}

function pgWrapBlock(tag) {
  const ed = document.getElementById('tj-page-editor');
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
function _tjCompressImage(src, callback) {
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
window._tjBindImg = function(w){ return _pgBindImgWrap(w); };
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
    var ed = document.getElementById('tj-page-editor');
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
    menu.style.cssText = 'position:fixed;z-index:99999;background:#232327;border:1px solid #45454c;border-radius:8px;padding:4px 0;box-shadow:0 8px 32px rgba(0,0,0,0.55);min-width:160px;font-family:Inter,system-ui,sans-serif;font-size:12px;';
    var copyBtn = document.createElement('div');
    copyBtn.innerHTML = window.TNI.copy + '<span>Copy Image</span>';
    copyBtn.style.cssText = 'padding:9px 16px;cursor:pointer;color:#f4f3f0;white-space:nowrap;';
    copyBtn.onmouseenter = function() { copyBtn.style.background='#2c2c31'; };
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
    dlBtn.style.cssText = 'padding:9px 16px;cursor:pointer;color:#f4f3f0;white-space:nowrap;';
    dlBtn.onmouseenter = function() { dlBtn.style.background='#2c2c31'; };
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
  _tjCompressImage(src, function(compressed) {
    const ed = document.getElementById('tj-page-editor');
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
    img.setAttribute('data-tjkey', 'tony_journal_img_' + entryId + '_' + nonce);
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
  var _tjBlkSel = null;
  var blkSel = document.getElementById('tj-pt-block');
  var tjEd2 = document.getElementById('tj-page-editor');
  function saveBlkSel() {
    var s = window.getSelection();
    if (s && s.rangeCount && tjEd2.contains(s.anchorNode)) _tjBlkSel = s.getRangeAt(0).cloneRange();
  }
  blkSel.addEventListener('mousedown', saveBlkSel);
  blkSel.addEventListener('touchstart', saveBlkSel, { passive: true });
  blkSel.addEventListener('change', function() {
    var tag = this.value;
    tjEd2.focus();
    if (_tjBlkSel) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(_tjBlkSel); }
    _tjBlkSel = null;
    pgWrapBlock(tag);
  });
})();

// Font size
// Save selection before font-size select steals focus (critical for iOS)
(function() {
  var _tjFsSel = null;
  var fsSel = document.getElementById('tj-pt-fontsize');
  var tjEd = document.getElementById('tj-page-editor');
  function saveSel() {
    var s = window.getSelection();
    if (s && s.rangeCount && !s.isCollapsed && tjEd.contains(s.anchorNode)) {
      _tjFsSel = s.getRangeAt(0).cloneRange();
    }
  }
  fsSel.addEventListener('mousedown', saveSel);
  fsSel.addEventListener('touchstart', saveSel, { passive: true });
  fsSel.addEventListener('change', function() {
    var px = this.value;
    this.value = '';
    if (!px) return;
    tjEd.focus();
    // Restore saved selection (iOS collapses it when select gets focus)
    if (_tjFsSel) {
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(_tjFsSel);
    }
    _tjFsSel = null;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    document.execCommand('fontSize', false, '7');
    tjEd.querySelectorAll('font[size="7"]').forEach(function(f) {
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
  var toolbar = document.getElementById('tj-page-toolbar');
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
document.getElementById('tj-pt-bold').addEventListener('click', () => pgCmd('bold'));
document.getElementById('tj-pt-italic').addEventListener('click', () => pgCmd('italic'));
document.getElementById('tj-pt-underline').addEventListener('click', () => pgCmd('underline'));
document.getElementById('tj-pt-strike').addEventListener('click', () => pgCmd('strikeThrough'));
document.getElementById('tj-pt-code').addEventListener('click', () => {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const code = document.createElement('code');
  try { range.surroundContents(code); } catch(e) { pgCmd('insertHTML', '<code>' + range.toString() + '</code>'); }
  autoSave();
});

// Text color
document.getElementById('tj-page-color-pick').addEventListener('input', function() {
  pgCmd('foreColor', this.value);
});

// Lists
document.getElementById('tj-pt-ul').addEventListener('click', () => pgCmd('insertUnorderedList'));
document.getElementById('tj-pt-ol').addEventListener('click', () => pgCmd('insertOrderedList'));

// Alignment
document.getElementById('tj-pt-alignL').addEventListener('click', () => pgCmd('justifyLeft'));
document.getElementById('tj-pt-alignC').addEventListener('click', () => pgCmd('justifyCenter'));
document.getElementById('tj-pt-alignR').addEventListener('click', () => pgCmd('justifyRight'));

// Link
document.getElementById('tj-pt-link').addEventListener('click', async () => {
  const url = await window.uiPrompt('Enter URL:', {title:'Insert link', placeholder:'https://…'});
  if (url) pgCmd('createLink', url);
});

// Divider
document.getElementById('tj-pt-md').addEventListener('click', () => {
  var ed = document.getElementById('tj-page-editor');
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

document.getElementById('tj-pt-hr').addEventListener('click', () => {
  pgCmd('insertHorizontalRule');
});

// Table
document.getElementById('tj-pt-table').addEventListener('click', () => {
  const cols = 3, rows = 3;
  let html = '<table><tr>' + '<th>Header</th>'.repeat(cols) + '</tr>';
  for (let r=0;r<rows-1;r++) { html += '<tr>' + '<td>Cell</td>'.repeat(cols) + '</tr>'; }
  html += '</table><p></p>';
  pgCmd('insertHTML', html);
});

// Image via file picker
document.getElementById('tj-page-img-file').addEventListener('change', function() {
  Array.from(this.files).forEach(function(file) {
    const reader = new FileReader();
    if (file.type.startsWith('image/')) {
      reader.onload = e => { pgInsertImage(e.target.result); };
      reader.readAsDataURL(file);
    } else {
      reader.onload = e => { _tjPageInsertFileChip(file.name, e.target.result, file.type); };
      reader.readAsDataURL(file);
    }
  });
  this.value = '';
});

// A file is kept as a data URL inside a Firestore document (a page's file chip
// in its own image document, an attachment inside the journal's), and a
// document over 1 MiB can never be written: the entry's every later save
// failed with no clear cause. So a file over 650 KB (about 870 KB once
// encoded, under the 900 KB write guard) is refused up front, saying why.
var TJ_FILE_MAX = 650 * 1024;
function _tjFileTooBig(name, dataURL) {
  var s = String(dataURL || '');
  var bytes = Math.floor((s.length - s.indexOf(',') - 1) * 3 / 4);
  if (bytes <= TJ_FILE_MAX) return false;
  window.uiAlert('"' + name + '" is ' + (bytes / 1048576).toFixed(1) + ' MB. Files up to 650 KB can be attached, so it was not added.', { title: 'File too large' });
  return true;
}

// Insert non-image file as downloadable chip in page editor
function _tjPageInsertFileChip(name, dataURL, mimeType) {
  if (_tjFileTooBig(name, dataURL)) return;
  const ed = document.getElementById('tj-page-editor');
  ed.focus();
  const escaped = _tjEsc(name);
  const clip = (window._docxPaperclipSVG || window.TNI.clip);
  const html = '<a class="tj-file-chip" href="' + dataURL + '" download="' + escaped + '" contenteditable="false" style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:var(--card2);border:1px solid var(--border);border-radius:4px;text-decoration:none;color:var(--text2);font-size:11px;font-weight:600;margin:2px 3px;cursor:pointer;">' + clip + '<span class="tj-file-name">' + escaped + '</span></a>';
  document.execCommand('insertHTML', false, html);
  autoSave();
}

// ── DRAG & DROP FILE UPLOAD (all templates) ─────────────────────────────────
(function() {
  var DROP_ZONES = [
    { areaId: 'tj-page-area',      zoneId: 'tj-page-drop-zone',    tmpl: 'page'       },
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
            if (typeof _tjPageInsertFileChip === 'function') _tjPageInsertFileChip(file.name, ev.target.result, file.type);
          }
          return;
        }
        // All other templates: use shared addAttachment
        if (typeof window._tjAddAttachment === 'function') {
          window._tjAddAttachment(file.name, file.type, ev.target.result);
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
        var ped = document.getElementById('tj-page-editor');
        if (ped && ped.getAttribute('contenteditable') === 'true' && document.caretRangeFromPoint) {
          var rng = document.caretRangeFromPoint(e.clientX, e.clientY);
          if (rng && ped.contains(rng.startContainer)) { ped.focus(); var s = window.getSelection(); s.removeAllRanges(); s.addRange(rng); }
        }
      }
      processFiles(files, tmpl);
    });
  });

  // Whiteboard drops still park the file on the entry; the Page template lands
  // it in the editor above and never reaches here.
  window._tjAddAttachment = function(name, mime, data) {
    var entry = (typeof getActive === 'function') ? getActive() : null;
    if (!entry) return;
    if (_tjFileTooBig(name, data)) return;
    if (!entry.data.attachments) entry.data.attachments = [];
    var id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    entry.data.attachments.push({ id: id, name: name, mime: mime, data: data });
    if (typeof autoSave === 'function') autoSave();
  };
})();

// Image paste from clipboard
document.getElementById('tj-page-editor').addEventListener('paste', function(e) {
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
    if (window._docxPasteListFix) _clean = window._docxPasteListFix(_clean, document.getElementById('tj-page-editor'));
    document.execCommand('insertHTML', false, _clean);
  } else {
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }
  autoSave();
});

// Update toolbar state on selection change — whichever sheet has the caret
document.addEventListener('selectionchange', () => {
  const ed = document.getElementById('tj-page-editor');
  if (ed && document.activeElement === ed) { updatePageToolbarState(); return; }
  const jeEd = document.getElementById('tj-je-editor');
  if (jeEd && document.activeElement === jeEd) updateJeToolbarState();
});

// Clear page
document.getElementById('tj-pt-clear').addEventListener('click', async () => {
  if (!(await window.uiConfirm('Clear all page content?', {danger:true, okLabel:'Clear'}))) return;
  document.getElementById('tj-page-editor').innerHTML = '';
  if (window._docxScrollToTop) window._docxScrollToTop('tj-page-editor');
  autoSave();
});

// Helper: walk up DOM to find a mark/highlighted ancestor within editor


// Highlight palette
(function() {
  var activeHlColor = '#FFE066';
  var palette = document.getElementById('tj-pt-hl-palette');
  var trigger = document.getElementById('tj-pt-hl-trigger');
  var icon = document.getElementById('tj-pt-hl-icon');
  var savedRange = null;

  function _tjSaveRange() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  }
  trigger.addEventListener('mousedown', function(e) {
    _tjSaveRange();
    e.preventDefault();
  });
  // touchstart: block blur so selection survives; do NOT read selection yet (iOS hasn't committed it)
  trigger.addEventListener('touchstart', function(e) {
    e.preventDefault();
  }, { passive: false });
  // Toggle-off: if the selection is already highlighted, clicking the trigger removes it.
  function _tjTriggerToggle() {
    var ed = document.getElementById('tj-page-editor');
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
    _tjSaveRange();
    if (_tjTriggerToggle()) return;
    palette.classList.add('open');
  }, { passive: false });
  trigger.addEventListener('click', function(e) {
    e.stopPropagation();
    // Desktop: toggle; touchend already handled palette open on mobile
    if ('ontouchend' in window) return;
    if (_tjTriggerToggle()) return;
    palette.classList.toggle('open');
  });

  palette.addEventListener('mousedown', function(e) { e.preventDefault(); });
  palette.addEventListener('touchstart', function(e) { e.preventDefault(); }, { passive: false });
  function _tjApplySwatch(swatch, e) {
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
    swatch.addEventListener('click', function(e) { _tjApplySwatch(swatch, e); });
    swatch.addEventListener('touchend', function(e) { e.preventDefault(); _tjApplySwatch(swatch, e); }, { passive: false });
  });
  // Close palette on outside click/touch
  document.addEventListener('click', function(e) {
    if (!document.getElementById('tj-pt-hl-wrap').contains(e.target)) {
      palette.classList.remove('open');
    }
  });
  document.addEventListener('touchend', function(e) {
    if (!document.getElementById('tj-pt-hl-wrap').contains(e.target)) {
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
    var ed = document.getElementById('tj-page-editor');
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
    mark.setAttribute('data-tj-hl', '1');
    mark.style.background = color;
    mark.style.color = textColor;
    mark.style.borderRadius = '2px';
    mark.style.padding = '0 1px';
    var insertedMark = null;
    try {
      range.surroundContents(mark);
      insertedMark = mark;
    } catch(ex) {
      var html = '<mark data-tj-hl="1" style="background:' + color + ';color:' + textColor + ';border-radius:2px;padding:0 1px">' + range.toString() + '</mark>';
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
  window._tjApplyHighlight = applyHighlight;
})();



// ══════════════════════════════════════════════════════
// JOURNAL ENTRIES TEMPLATE ENGINE
// ══════════════════════════════════════════════════════
(function() {

  // ── Helpers ──────────────────────────────────────────
  function _jeGetEntry() {
    return typeof getActive === 'function' ? getActive() : null;
  }

  function _jeDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function _jeFormatDateLabel(key) {
    // key = "YYYY-MM-DD"
    try {
      return _jeDate(key).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    } catch(e) { return key; }
  }

  // Menu / phone-chip label: weekday + date, year only when it is not this year.
  function _jeMediumLabel(key) {
    try {
      const y = Number(key.slice(0, 4));
      const opts = { weekday: 'short', month: 'short', day: 'numeric' };
      if (y !== new Date().getFullYear()) opts.year = 'numeric';
      return _jeDate(key).toLocaleDateString('en-US', opts);
    } catch(e) { return key; }
  }

  // Strip label. Inside a run of one month only the day number is shown — the run
  // is already introduced by its own month marker — so twenty dates in September
  // read as "SEP 1 2 3 …" instead of twenty copies of the word September.
  function _jeTabLabel(key, sameMonthAsPrev) {
    try {
      const y = Number(key.slice(0, 4));
      if (sameMonthAsPrev) return String(Number(key.slice(8, 10)));
      var s = _jeDate(key).toLocaleDateString('en-US', { day: 'numeric' });
      return (y !== new Date().getFullYear()) ? s + " '" + key.slice(2, 4) : s;
    } catch(e) { return key; }
  }

  function _jeMonthLabel(key) {
    try {
      const y = Number(key.slice(0, 4));
      const opts = { month: 'short' };
      if (y !== new Date().getFullYear()) opts.year = '2-digit';
      return _jeDate(key).toLocaleDateString('en-US', opts);
    } catch(e) { return key.slice(0, 7); }
  }

  function _jeTodayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  // ── Save currently-displayed editor content into entry.data.dates ──
  window._jeSaveActiveDate = function(entry) {
    if (!entry || entry.template !== 'journal-entries') return;
    const key = entry.data.activeDateKey;
    if (!key) return;
    const ed = document.getElementById('tj-je-editor');
    if (!ed) return;
    if (!entry.data.dates) entry.data.dates = {};
    entry.data.dates[key] = { html: ed.innerHTML };
  };

  // ── Date switching ──────────────────────────────────────────
  function _jeSwitchTo(key) {
    const cur = _jeGetEntry();
    if (!cur || !key || key === cur.data.activeDateKey) return;
    _jeSaveActiveDate(cur);
    cur.data.activeDateKey = key;
    _jeRenderTabs(cur);
    if (typeof autoSave === 'function') autoSave();
  }

  async function _jeDeleteDate(key) {
    const cur = _jeGetEntry();
    if (!cur) return;
    if (!(await window.uiConfirm('Delete entry for ' + _jeFormatDateLabel(key) + '?', {danger:true, okLabel:'Delete'}))) return;
    delete cur.data.dates[key];
    cur.data.dateOrder = cur.data.dateOrder.filter(function(k) { return k !== key; });
    if (cur.data.activeDateKey === key) cur.data.activeDateKey = '';
    _jeCloseMenu();
    _jeRenderTabs(cur);
    if (typeof autoSave === 'function') autoSave();
  }

  // ── Jump menu (all dates, newest first, grouped by month) ────
  function _jeCloseMenu() {
    const menu = document.getElementById('tj-je-menu');
    const btn  = document.getElementById('tj-je-jump');
    if (menu) menu.classList.remove('open');
    if (btn) btn.classList.remove('open');
  }

  function _jeOpenMenu() {
    const entry = _jeGetEntry();
    const menu = document.getElementById('tj-je-menu');
    const btn  = document.getElementById('tj-je-jump');
    if (!entry || !menu || !btn) return;
    const order = (entry.data.dateOrder || []).slice().reverse();   // newest first
    menu.innerHTML = '';
    let lastMonth = null;
    order.forEach(function(key) {
      const month = key.slice(0, 7);
      if (month !== lastMonth) {
        lastMonth = month;
        const h = document.createElement('div');
        h.className = 'je-menu-head';
        h.textContent = _jeDate(key).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        menu.appendChild(h);
      }
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'je-menu-item' + (key === entry.data.activeDateKey ? ' active' : '');
      it.dataset.dateKey = key;
      it.innerHTML = '<span class="je-menu-lbl"></span><span class="je-menu-del" title="Delete this date">' + window.TNI.x + '</span>';
      it.querySelector('.je-menu-lbl').textContent = _jeMediumLabel(key);
      menu.appendChild(it);
    });
    menu.classList.add('open');
    btn.classList.add('open');
    // Anchor under the button, clamped to the viewport (the menu is position:fixed
    // so a scrolled editor never drags it off-screen).
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    menu.style.top = (r.bottom + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
  }

  (function _jeWireMenu() {
    const menu = document.getElementById('tj-je-menu');
    const btn  = document.getElementById('tj-je-jump');
    if (!menu || !btn) return;
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (menu.classList.contains('open')) _jeCloseMenu(); else _jeOpenMenu();
    });
    menu.addEventListener('click', function(e) {
      const del = e.target.closest('.je-menu-del');
      const item = e.target.closest('.je-menu-item');
      if (!item) return;
      e.stopPropagation();
      if (del) { _jeDeleteDate(item.dataset.dateKey); return; }
      _jeCloseMenu();
      _jeSwitchTo(item.dataset.dateKey);
    });
    document.addEventListener('click', function(e) {
      if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) _jeCloseMenu();
    });
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') _jeCloseMenu(); });

    // Prev / next walk the ordered dates — the only way to move between them on a
    // phone, where the strip itself is hidden.
    function step(dir) {
      const cur = _jeGetEntry();
      if (!cur || !cur.data || !cur.data.dateOrder) return;
      const idx = cur.data.dateOrder.indexOf(cur.data.activeDateKey);
      const next = cur.data.dateOrder[idx + dir];
      if (next) _jeSwitchTo(next);
    }
    const prevB = document.getElementById('tj-je-prev');
    const nextB = document.getElementById('tj-je-next');
    if (prevB) prevB.addEventListener('click', function() { step(-1); });
    if (nextB) nextB.addEventListener('click', function() { step(1); });

    // Delegated once: the pills themselves are rebuilt on every render.
    const tabsEl = document.getElementById('tj-je-tabs');
    if (tabsEl) tabsEl.addEventListener('click', function(e) {
      const tab = e.target.closest('.je-tab');
      if (!tab) return;
      if (e.target.closest('.je-tab-del')) { e.stopPropagation(); _jeDeleteDate(tab.dataset.dateKey); return; }
      _jeSwitchTo(tab.dataset.dateKey);
    });

    // The arrows and the jump menu only earn their space once the strip overflows.
    if (window.ResizeObserver) {
      const strip = document.getElementById('tj-je-tabs');
      if (strip) new ResizeObserver(function() { _jeSyncOverflow(); }).observe(strip);
    }
    window.addEventListener('resize', _jeSyncOverflow);
  })();

  function _jeSyncOverflow() {
    const bar = document.getElementById('tj-je-tabs-bar');
    const tabs = document.getElementById('tj-je-tabs');
    if (!bar || !tabs) return;
    bar.classList.toggle('je-overflow', tabs.scrollWidth > tabs.clientWidth + 2);
  }

  // ── Render tabs + show active date's content ──
  window._jeRenderTabs = function(entry, preserveEditorDOM) {
    if (!entry || entry.template !== 'journal-entries') return;
    if (!entry.data) entry.data = {};
    if (!entry.data.dates) entry.data.dates = {};
    if (!entry.data.dateOrder) entry.data.dateOrder = Object.keys(entry.data.dates).sort();

    const tabsEl = document.getElementById('tj-je-tabs');
    const emptyEl = document.getElementById('tj-je-empty');
    const edWrap = document.getElementById('tj-je-editor-wrap');
    const ed = document.getElementById('tj-je-editor');
    const barEl = document.getElementById('tj-je-tabs-bar');
    const jumpLbl = document.getElementById('tj-je-jump-lbl');
    const jumpCount = document.getElementById('tj-je-jump-count');
    const prevB = document.getElementById('tj-je-prev');
    const nextB = document.getElementById('tj-je-next');
    if (!tabsEl || !ed) return;

    const order = entry.data.dateOrder;
    tabsEl.innerHTML = '';
    _jeCloseMenu();

    if (order.length === 0) {
      if (emptyEl) { emptyEl.style.display = 'flex'; }
      if (edWrap) { edWrap.style.display = 'none'; edWrap.classList.remove('active'); }
      if (barEl) barEl.classList.remove('je-overflow');
      if (jumpLbl) jumpLbl.textContent = 'Dates';
      if (jumpCount) jumpCount.textContent = '';
      if (prevB) prevB.disabled = true;
      if (nextB) nextB.disabled = true;
      entry.data.activeDateKey = '';
      ed.innerHTML = '';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (edWrap) edWrap.classList.add('active');
    if (edWrap) edWrap.style.display = 'block';

    // Ensure activeDateKey is valid
    if (!order.includes(entry.data.activeDateKey)) {
      entry.data.activeDateKey = order[order.length - 1];
    }

    let activeBtn = null, lastMonth = null;
    order.forEach(function(key) {
      const month = key.slice(0, 7);
      const sameMonth = month === lastMonth;
      if (!sameMonth) {
        lastMonth = month;
        const marker = document.createElement('span');
        marker.className = 'je-month';
        marker.textContent = _jeMonthLabel(key);
        tabsEl.appendChild(marker);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      const isActive = key === entry.data.activeDateKey;
      btn.className = 'je-tab' + (isActive ? ' active' : '');
      btn.dataset.dateKey = key;
      btn.title = _jeFormatDateLabel(key);
      btn.innerHTML = '<span></span><span class="je-tab-del" title="Delete this date">' + window.TNI.x + '</span>';
      btn.firstChild.textContent = _jeTabLabel(key, sameMonth);
      tabsEl.appendChild(btn);
      if (isActive) activeBtn = btn;
    });

    // Phone chip + the desktop jump button both name the date you are on.
    if (jumpLbl) jumpLbl.textContent = _jeMediumLabel(entry.data.activeDateKey);
    if (jumpCount) jumpCount.textContent = order.length > 1 ? '(' + order.length + ')' : '';
    const ai = order.indexOf(entry.data.activeDateKey);
    if (prevB) prevB.disabled = ai <= 0;
    if (nextB) nextB.disabled = ai < 0 || ai >= order.length - 1;

    // Load active date content
    if (!preserveEditorDOM) {
      _jeLoadDateContent(entry.data.activeDateKey, entry);
    }

    _jeSyncOverflow();
    requestAnimationFrame(_jeSyncOverflow);   // again once the strip has laid out
    if (activeBtn) {
      // Keep the date you are editing visible after a re-render or a prev/next step.
      requestAnimationFrame(function() {
        try { activeBtn.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (err) {}
      });
    }
  };

  // ── Load a specific date's HTML into the editor ──
  function _jeLoadDateContent(key, entry) {
    const ed = document.getElementById('tj-je-editor');
    if (!ed || !key) return;
    const dateData = (entry.data.dates || {})[key] || {};
    const html = dateData.html || '';
    ed.innerHTML = html;
    ed.contentEditable = (typeof isEditMode !== 'undefined' && isEditMode) ? 'true' : 'false';
    // Each date is a separate document — reseed the docx undo stack so undo never
    // reaches back across a date switch.
    if (window._docxOnLoad) window._docxOnLoad('tj-je-editor', (entry.id || 'je') + '::' + key);
    // Rebind image handles
    ed.querySelectorAll('.pg-img-wrap').forEach(function(w) {
      if (typeof _pgBindImgWrap === 'function') _pgBindImgWrap(w);
    });
    // Rehydrate Firebase images
    if (html.includes('tj-fbimg://') && window._fbRehydrateTonyPageImages) {
      window._fbRehydrateTonyPageImages(html).then(function(rehydrated) {
        if (rehydrated !== html) {
          ed.innerHTML = rehydrated;
          entry.data.dates[key].html = rehydrated;
          ed.querySelectorAll('.pg-img-wrap').forEach(function(w) {
            if (typeof _pgBindImgWrap === 'function') _pgBindImgWrap(w);
          });
        }
      });
    }
  }

  // ── Add Date button ──
  var addDateBtn = document.getElementById('tj-je-add-date');
  if (addDateBtn) {
    addDateBtn.addEventListener('click', async function() {
      var entry = _jeGetEntry();
      if (!entry || entry.template !== 'journal-entries') return;
      // Prompt for date; default today
      var defaultKey = _jeTodayKey();
      var input = await window.uiPrompt('Enter date (YYYY-MM-DD):', {title:'Add date', default:defaultKey});
      if (!input) return;
      input = input.trim();
      // Validate format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
        alert('Invalid date format. Use YYYY-MM-DD.');
        return;
      }
      if (!entry.data.dates) entry.data.dates = {};
      if (!entry.data.dateOrder) entry.data.dateOrder = [];
      if (entry.data.dates[input]) {
        // Just switch to it
        _jeSaveActiveDate(entry);
        entry.data.activeDateKey = input;
        _jeRenderTabs(entry);
        return;
      }
      _jeSaveActiveDate(entry);
      entry.data.dates[input] = { html: '' };
      entry.data.dateOrder.push(input);
      entry.data.dateOrder.sort();
      entry.data.activeDateKey = input;
      _jeRenderTabs(entry);
      if (typeof autoSave === 'function') autoSave();
    });
  }

  // ── JE Editor toolbar — mirrors TJ page toolbar ──
  var jeEd = document.getElementById('tj-je-editor');
  if (!jeEd) return;

  function jeCmd(cmd, val) {
    jeEd.focus();
    document.execCommand(cmd, false, val || null);
    if (typeof autoSave === 'function') autoSave();
  }

  function jeBlock(tag) {
    jeEd.focus();
    document.execCommand('formatBlock', false, tag);
    if (typeof autoSave === 'function') autoSave();
  }

  // Block format select
  var jeBlockSel = document.getElementById('tj-je-pt-block');
  if (jeBlockSel) {
    jeBlockSel.addEventListener('change', function() {
      jeBlock(jeBlockSel.value);
      jeBlockSel.value = 'p';
    });
  }

  // Font size select
  var jeFontSel = document.getElementById('tj-je-pt-fontsize');
  if (jeFontSel) {
    jeFontSel.addEventListener('change', function() {
      var sz = jeFontSel.value;
      if (!sz) return;
      jeEd.focus();
      document.execCommand('fontSize', false, '7');
      jeEd.querySelectorAll('font[size="7"]').forEach(function(el) {
        el.removeAttribute('size');
        el.style.fontSize = sz + 'px';
      });
      jeFontSel.value = '';
      if (typeof autoSave === 'function') autoSave();
    });
  }

  // Inline formatting
  document.getElementById('tj-je-pt-bold')      && document.getElementById('tj-je-pt-bold').addEventListener('click', function() { jeCmd('bold'); });
  document.getElementById('tj-je-pt-italic')    && document.getElementById('tj-je-pt-italic').addEventListener('click', function() { jeCmd('italic'); });
  document.getElementById('tj-je-pt-underline') && document.getElementById('tj-je-pt-underline').addEventListener('click', function() { jeCmd('underline'); });
  document.getElementById('tj-je-pt-strike')    && document.getElementById('tj-je-pt-strike').addEventListener('click', function() { jeCmd('strikeThrough'); });
  document.getElementById('tj-je-pt-code')      && document.getElementById('tj-je-pt-code').addEventListener('click', function() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    var code = document.createElement('code');
    try { range.surroundContents(code); } catch(ex) { document.execCommand('insertHTML', false, '<code>' + range.toString() + '</code>'); }
    if (typeof autoSave === 'function') autoSave();
  });
  document.getElementById('tj-je-pt-ul')       && document.getElementById('tj-je-pt-ul').addEventListener('click', function() { jeCmd('insertUnorderedList'); });
  document.getElementById('tj-je-pt-ol')       && document.getElementById('tj-je-pt-ol').addEventListener('click', function() { jeCmd('insertOrderedList'); });
  document.getElementById('tj-je-pt-alignL')   && document.getElementById('tj-je-pt-alignL').addEventListener('click', function() { jeCmd('justifyLeft'); });
  document.getElementById('tj-je-pt-alignC')   && document.getElementById('tj-je-pt-alignC').addEventListener('click', function() { jeCmd('justifyCenter'); });
  document.getElementById('tj-je-pt-alignR')   && document.getElementById('tj-je-pt-alignR').addEventListener('click', function() { jeCmd('justifyRight'); });
  document.getElementById('tj-je-pt-link')     && document.getElementById('tj-je-pt-link').addEventListener('click', async function() {
    // Read the selection first: the dialog takes focus and would lose it.
    var sel = window.getSelection(), range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    var url = await window.uiPrompt('Enter URL:', {title:'Insert link', placeholder:'https://…'});
    if (!url) return;
    if (range) { sel.removeAllRanges(); sel.addRange(range); }
    jeCmd('createLink', url);
  });
  document.getElementById('tj-je-pt-hr')       && document.getElementById('tj-je-pt-hr').addEventListener('click', function() {
    jeEd.focus(); document.execCommand('insertHTML', false, '<hr>');
    if (typeof autoSave === 'function') autoSave();
  });
  document.getElementById('tj-je-pt-table')    && document.getElementById('tj-je-pt-table').addEventListener('click', async function() {
    var _dims = await window.uiForm({ title:'Insert table', okLabel:'Insert', fields:[ {name:'rows',label:'Rows',value:'3'}, {name:'cols',label:'Columns',value:'3'} ] });
    if (!_dims) return;
    var rows = parseInt(_dims.rows, 10) || 3;
    var cols = parseInt(_dims.cols, 10) || 3;
    var th = Array.from({ length: cols }, function(_, i) { return '<th>Col ' + (i + 1) + '</th>'; }).join('');
    var td = Array.from({ length: cols }, function() { return '<td></td>'; }).join('');
    var tbody = Array.from({ length: rows }, function() { return '<tr>' + td + '</tr>'; }).join('');
    var tbl = '<table><thead><tr>' + th + '</tr></thead><tbody>' + tbody + '</tbody></table>';
    jeEd.focus(); document.execCommand('insertHTML', false, tbl);
    if (typeof autoSave === 'function') autoSave();
  });
  document.getElementById('tj-je-pt-clear')    && document.getElementById('tj-je-pt-clear').addEventListener('click', async function() {
    if (!(await window.uiConfirm('Clear content for this date?', {danger:true, okLabel:'Clear'}))) return;
    jeEd.innerHTML = '';
    var cur = _jeGetEntry();
    if (cur && cur.data.activeDateKey) {
      if (!cur.data.dates) cur.data.dates = {};
      cur.data.dates[cur.data.activeDateKey] = { html: '' };
    }
    if (typeof autoSave === 'function') autoSave();
  });

  // Text color
  var jeColorPick = document.getElementById('tj-je-color-pick');
  if (jeColorPick) {
    jeColorPick.addEventListener('input', function() { jeCmd('foreColor', jeColorPick.value); });
  }

  // Keyboard shortcuts in JE editor
  jeEd.addEventListener('keydown', function(e) {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'b') { e.preventDefault(); jeCmd('bold'); }
      if (e.key === 'i') { e.preventDefault(); jeCmd('italic'); }
      if (e.key === 'u') { e.preventDefault(); jeCmd('underline'); }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) { document.execCommand('insertParagraph'); if (typeof autoSave === 'function') autoSave(); return; }
      var editor = document.getElementById('tj-je-editor');
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
      } else {
        document.execCommand(e.shiftKey ? 'insertLineBreak' : 'insertParagraph');
      }
      if (typeof autoSave === 'function') autoSave();
    }
  });

  // Autosave on JE editor input
  jeEd.addEventListener('input', function() {
    if (typeof autoSave === 'function') autoSave();
  });

  // Clipboard: mirrors the Page editor — an image lands as a resizable wrapper,
  // anything else as sanitized rich HTML (Word / Docs / web keep their formatting).
  jeEd.addEventListener('paste', function(e) {
    const items = e.clipboardData ? e.clipboardData.items : null;
    if (items) {
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          const reader = new FileReader();
          reader.onload = ev => _jeInsertImage(ev.target.result);
          reader.readAsDataURL(blob);
          return;
        }
      }
    }
    e.preventDefault();
    const htmlData = e.clipboardData ? e.clipboardData.getData('text/html') : '';
    if (htmlData && window._docxCleanHTML) {
      var _clean = window._docxCleanHTML(htmlData);
      if (window._docxPasteListFix) _clean = window._docxPasteListFix(_clean, jeEd);
      document.execCommand('insertHTML', false, _clean);
    } else {
      document.execCommand('insertText', false, e.clipboardData ? e.clipboardData.getData('text/plain') : '');
    }
    if (typeof autoSave === 'function') autoSave();
  });

  // Shared by paste, the toolbar picker and drag-and-drop.
  function _jeInsertImage(src) {
    const put = function(data) {
      jeEd.focus();
      const wrap = document.createElement('span');
      wrap.className = 'pg-img-wrap';
      wrap.contentEditable = 'false';
      const img = document.createElement('img');
      img.src = data;
      img.alt = 'image';
      img.style.width = '320px';
      wrap.appendChild(img);
      const sel = window.getSelection();
      const range = sel && sel.rangeCount && jeEd.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
      if (range) { range.insertNode(wrap); range.collapse(false); }
      else { jeEd.appendChild(wrap); }
      if (typeof _pgBindImgWrap === 'function') _pgBindImgWrap(wrap);
      if (typeof autoSave === 'function') autoSave();
    };
    if (typeof _tjCompressImage === 'function') _tjCompressImage(src, put); else put(src);
  }
  window._jeInsertImage = _jeInsertImage;

  // Image / file insert
  var jeImgFile = document.getElementById('tj-je-img-file');
  if (jeImgFile) {
    jeImgFile.addEventListener('change', function() {
      var files = Array.from(jeImgFile.files);
      jeImgFile.value = '';
      files.forEach(function(file) {
        var reader = new FileReader();
        reader.onload = function(ev) { _jeInsertImage(ev.target.result); };
        reader.readAsDataURL(file);
      });
    });
  }

  // Drag-and-drop files into JE area
  var jeDropZone = document.getElementById('tj-je-drop-zone');
  var jeArea = document.getElementById('tj-je-area');
  if (jeArea && jeDropZone) {
    jeArea.addEventListener('dragover', function(e) { e.preventDefault(); jeDropZone.classList.add('active'); });
    jeArea.addEventListener('dragleave', function(e) { if (!jeArea.contains(e.relatedTarget)) jeDropZone.classList.remove('active'); });
    jeArea.addEventListener('drop', function(e) {
      e.preventDefault(); jeDropZone.classList.remove('active');
      var files = Array.from(e.dataTransfer.files).filter(function(f) { return f.type.startsWith('image/'); });
      files.forEach(function(file) {
        var reader = new FileReader();
        reader.onload = function(ev) { _jeInsertImage(ev.target.result); };
        reader.readAsDataURL(file);
      });
    });
  }

  // ── JE Highlight palette ──
  (function() {
    var HL_TEXT = { '#FFE066':'#111111','#A8F0B0':'#0a2a10','#A8D8FF':'#0a1a40','#FFB3C6':'#2a0010','#F9C784':'#1a0d00','#D4B0FF':'#1a0030' };
    var activeHlColor = '#FFE066';
    var palette = document.getElementById('tj-je-pt-hl-palette');
    var trigger = document.getElementById('tj-je-pt-hl-trigger');
    var icon = document.getElementById('tj-je-pt-hl-icon');
    var savedRange = null;

    function saveSel() {
      var sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) savedRange = sel.getRangeAt(0).cloneRange();
    }

    if (trigger) trigger.addEventListener('mousedown', saveSel);
    if (trigger) trigger.addEventListener('click', function(e) {
      e.stopPropagation();
      if (palette) palette.classList.toggle('open');
    });

    document.addEventListener('click', function(e) {
      if (palette && !palette.contains(e.target) && e.target !== trigger) palette.classList.remove('open');
    });

    if (palette) palette.querySelectorAll('.pt-hl-swatch').forEach(function(sw) {
      sw.addEventListener('mousedown', saveSel);
      sw.addEventListener('click', function(e) {
        e.stopPropagation();
        palette.classList.remove('open');
        var color = sw.dataset.color;
        if (!savedRange) return;
        jeEd.focus();
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
        savedRange = null;
        if (color === 'none') {
          document.execCommand('removeFormat', false, null);
        } else {
          activeHlColor = color;
          if (icon) { icon.style.background = color; }
          var textColor = HL_TEXT[color] || '#111111';
          var mark = document.createElement('mark');
          mark.setAttribute('data-tj-hl', '1');
          mark.style.background = color;
          mark.style.color = textColor;
          mark.style.borderRadius = '2px';
          mark.style.padding = '0 1px';
          try { sel.getRangeAt(0).surroundContents(mark); }
          catch(ex) { document.execCommand('insertHTML', false, '<mark data-tj-hl="1" style="background:' + color + ';color:' + textColor + ';border-radius:2px;padding:0 1px">' + sel.toString() + '</mark>'); }
        }
        if (typeof autoSave === 'function') autoSave();
      });
    });
  })();

})(); // end Journal Entries engine

// Keyboard shortcuts inside page editor
document.getElementById('tj-page-editor').addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey)) {
    if (e.key==='b') { e.preventDefault(); pgCmd('bold'); }
    if (e.key==='i') { e.preventDefault(); pgCmd('italic'); }
    if (e.key==='u') { e.preventDefault(); pgCmd('underline'); }
  }
    if (e.key === 'Enter') {
      e.preventDefault();
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) { document.execCommand('insertParagraph'); if (typeof autoSave === 'function') autoSave(); return; }
      var editor = document.getElementById('tj-page-editor');
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
let _tjAutoFirstAt = 0;   // when the current unsaved burst of edits began
function autoSave() {
  // Only real editing reaches here (input, paste, toolbar command, undo), which is
  // what makes this the signal that a blank editor is a deliberate clear rather
  // than an unpainted one — see the blank-overwrite guard in saveCurrentEntry.
  _tjUserEdited = true;
  _tjSetSync('syncing');
  const _now = Date.now();
  if (!_tjAutoFirstAt) _tjAutoFirstAt = _now;
  clearTimeout(autoTimer);
  // MAX WAIT. The 500ms debounce restarts on every keystroke, so a long
  // uninterrupted burst of typing reached neither localStorage nor the cloud until
  // the user paused — a crash or a closed lid in the middle of a paragraph lost all
  // of it. However long the burst runs, the entry is now persisted at least every 1.5s.
  autoTimer = setTimeout(saveCurrentEntry, (_now - _tjAutoFirstAt >= 1500) ? 0 : 500);
}
// Persist the current entry synchronously RIGHT NOW — see _bjPersistNow.
window._tjPersistNow = function() {
  try { if (window._tjFlushBoards) window._tjFlushBoards(); } catch(e) {}
  try { clearTimeout(autoTimer); if (getActive()) saveCurrentEntry(); } catch(e) {}
  try { return _tjFbFlush(); } catch(e) {}
};
document.getElementById('tj-entry-title-input').addEventListener('input', autoSave);
document.getElementById('tj-page-editor').addEventListener('input', autoSave);
// Journal Entries editor (contenteditable) — must listen for input to catch paste, typing, etc.
const _jeEdEl = document.getElementById('tj-je-editor');
if (_jeEdEl) _jeEdEl.addEventListener('input', autoSave);

/* KEYBOARD SHORTCUTS */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault(); saveCurrentEntry();
    if (window._tjFlushBoards) window._tjFlushBoards();
  }
  // Undo/redo inside a board belong to the board — see the BJ twin.
});

/* EDIT MODE */
let isEditMode = false;
function setEditMode(enabled) {
  isEditMode = enabled;
  const checkbox = document.getElementById('tj-btn-edit');
  checkbox.checked = enabled;
  const modeLabel = document.getElementById('tj-mode-label');
  if (modeLabel) {
    modeLabel.textContent = enabled ? 'EDIT' : 'VIEW';
    modeLabel.classList.toggle('edit-active', enabled);
  }
  // View mode hands Excalidraw its own viewModeEnabled and Mind Elixir
  // disableEdit(): still pannable and readable, but nothing can change.
  if (_tjBoards.wb) _tjBoards.wb.setEditable(enabled);
  if (_tjBoards.mm) _tjBoards.mm.setEditable(enabled);
  ['tj-entry-title-input','tj-add-tag-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.readOnly = !enabled;
  });
  // Page editor
  const pgEd = document.getElementById('tj-page-editor');
  if (pgEd) pgEd.contentEditable = enabled ? 'true' : 'false';
  const pgTb = document.getElementById('tj-page-toolbar');
  if (pgTb) {
    const activeEntry = getActive();
    const isPage = activeEntry && activeEntry.template === 'page';
    if (enabled && isPage) pgTb.classList.add('edit-mode');
    else pgTb.classList.remove('edit-mode');
  }
  // Journal Entries editor
  const jeEd = document.getElementById('tj-je-editor');
  if (jeEd) jeEd.contentEditable = enabled ? 'true' : 'false';
  const jeTb = document.getElementById('tj-je-toolbar');
  if (jeTb) {
    const activeEntry = getActive();
    if (enabled && activeEntry && activeEntry.template === 'journal-entries') jeTb.classList.add('edit-mode');
    else jeTb.classList.remove('edit-mode');
  }
  document.querySelectorAll('.tag-del').forEach(el => {
    el.style.display = enabled ? '' : 'none';
  });
  const addTagInput = document.getElementById('tj-add-tag-input');
  if (addTagInput) addTagInput.style.display = enabled ? '' : 'none';
  // Sync bottom bar edit button label
  const bbEdit = document.getElementById('tj-bb-edit');
  if (bbEdit) bbEdit.textContent = enabled ? 'Done' : 'Edit';
  if (enabled && window._docxRefreshRulers) window._docxRefreshRulers('tj');
}

/* ── Fast touch response for all TJ toolbar controls ──
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
  var modeLabel = document.querySelector('#tj-root .mode-toggle');
  if (modeLabel) {
    var pending = false;
    modeLabel.addEventListener('touchstart', function(e) {
      e.preventDefault();
      pending = true;
      var cb = document.getElementById('tj-btn-edit');
      cb.checked = !cb.checked;
      setEditMode(cb.checked);
    }, { passive: false });
    // Suppress the ghost click that would double-toggle
    modeLabel.addEventListener('click', function(e) {
      if (pending) { pending = false; e.preventDefault(); return; }
      // mouse click path — let change event on checkbox fire normally
    });
  }

  /* tj-btn-export-pdf */
  (function() {
    var tjExportBtn = document.getElementById('tj-btn-export-pdf');
    if (tjExportBtn) tjExportBtn.onclick = function() {
      var entry = getActive();
      if (!entry) { alert('No entry selected.'); return; }
      if (window._tjGetLock && window._tjGetLock(entry.id) && !(window._tjIsUnlocked && window._tjIsUnlocked(entry.id))) { return; }
      saveCurrentEntry();
      exportEntryAsPDF(getActive());
    };
  })();

  /* tj-fullscreen-btn */
  fastTouch(document.getElementById('tj-fullscreen-btn'), function() {
    var root = document.getElementById('tj-root');
    var isFs = root.classList.toggle('tj-fullscreen');
    var show = document.getElementById('tj-fs-icon-show');
    var hide = document.getElementById('tj-fs-icon-hide');
    if (show) show.style.display = isFs ? '' : 'none';
    if (hide) hide.style.display = isFs ? 'none' : '';
  });

  /* tj-new-entry-btn */
  fastTouch(document.getElementById('tj-new-entry-btn'), function() {
    document.getElementById('tj-new-entry-btn')._creating = true;
    document.getElementById('tj-template-modal').classList.add('open');
  });

  /* Bottom bar buttons */
  var tjBbEditBtn = document.getElementById('tj-bb-edit');
  fastTouch(tjBbEditBtn, function() {
    var checkbox = document.getElementById('tj-btn-edit');
    if (checkbox) {
      checkbox.checked = !checkbox.checked;
      setEditMode(checkbox.checked);
      tjBbEditBtn.textContent = checkbox.checked ? 'Done' : 'Edit';
    }
  });

  fastTouch(document.getElementById('tj-bb-new'), function() {
    document.getElementById('tj-new-entry-btn')._creating = true;
    document.getElementById('tj-template-modal').classList.add('open');
  });
})();

/* TOOLBAR — mouse/keyboard change handler (touchstart path handled above) */
document.getElementById('tj-btn-edit').addEventListener('change', function() { setEditMode(this.checked); });
document.getElementById('tj-close-modal').addEventListener('click', () => {
  document.getElementById('tj-new-entry-btn')._creating=false;
  document.getElementById('tj-template-modal').classList.remove('open');
});
document.getElementById('tj-template-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('tj-template-modal')) {
    document.getElementById('tj-new-entry-btn')._creating=false;
    document.getElementById('tj-template-modal').classList.remove('open');
    return;
  }
  const card=e.target.closest('.template-card'); if (!card) return;
  const tmpl=card.dataset.template;
  // Boards are OurJournal-only in MyJournal. The CSS hides their cards; this
  // stops a stray click (or a stale DOM) from creating one anyway.
  if ((tmpl === 'whiteboard' || tmpl === 'mindmap') && !_tjIsOJ()) return;
  document.getElementById('tj-template-modal').classList.remove('open');
  document.getElementById('tj-new-entry-btn')._creating=false;
  // Always create a new entry — never mutate/wipe the current one. Flush the entry
  // we're leaving BEFORE createEntry reschedules the debounce onto the new one.
  saveCurrentEntry(); _tjFbFlush(); createEntry(tmpl); saveState(); renderSidebar(); loadActiveEntry();
  setEditMode(true);
});
document.getElementById('tj-new-entry-btn').addEventListener('click', () => {
  document.getElementById('tj-new-entry-btn')._creating=true;
  document.getElementById('tj-template-modal').classList.add('open');
});
document.getElementById('tj-search-box').addEventListener('input', renderSidebar);

loadState(); purgeExpiredTrash(); renderSidebar(); loadActiveEntry(); setEditMode(false);

/* ── OurJournal tab ──────────────────────────────────────────────────────────
 * Sits first in the sidebar's rail (OurJournal · Journal). The rail module
 * (MJDocsUI) builds that rail, so the tab is added when the rail appears; until
 * then a stand-in rail carries it. Choosing the Journal button always returns
 * to Tony's own journal first. */
function _tjModeUI() {
  var on = _tjIsOJ();
  var root = document.getElementById('tj-root');
  if (root) root.classList.toggle('oj-on', on);
  var nav = document.getElementById('mjd-nav');
  if (nav) {
    if (on) {
      // OurJournal lists natively, like the Journal tab — never under #mjd-panel.
      var panel = document.getElementById('mjd-panel');
      var pages = nav.querySelector('[data-sec="pages"]');
      if (panel && panel.classList.contains('on') && pages) { _tjRailBusy = true; try { pages.click(); } finally { _tjRailBusy = false; } }
      nav.querySelectorAll('[data-sec]').forEach(function(b) { b.classList.remove('on'); });
    } else if (!nav.querySelector('[data-sec].on')) {
      var pg = nav.querySelector('[data-sec="pages"]'); if (pg) pg.classList.add('on');
    }
  }
  document.querySelectorAll('#tj-root .oj-tab').forEach(function(b) {
    var mine = b.getAttribute('data-oj') === '1';
    b.classList.toggle('on', mine === on);
    b.setAttribute('aria-selected', mine === on ? 'true' : 'false');
  });
  var sb = document.getElementById('tj-search-box');
  if (sb) sb.placeholder = on ? 'Search OurJournal…' : 'Search entries…';
}
var _tjRailBusy = false;
function _tjOJEnter() {
  if (_tjIsOJ() || !window.OJ) return;
  if (window._tjCloudMode && window.MJDocsUI && window.MJDocsUI.release) { try { window.MJDocsUI.release(); } catch (e) {} }
  try { saveCurrentEntry(); } catch (e) {}
  try { _tjFbFlush(); } catch (e) {}
  _tjPersonal = state;
  _tjOJState = window.OJ.state('tj');
  state = _tjOJState;
  tjTagFilters = [];
  var sb = document.getElementById('tj-search-box'); if (sb) sb.value = '';
  window.OJ.enter('tj');
  _tjModeUI();
  renderSidebar(); loadActiveEntry();
}
function _tjOJLeave() {
  if (!_tjIsOJ()) return;
  try { saveCurrentEntry(); } catch (e) {}
  try { if (window._tjFlushBoards) window._tjFlushBoards(); } catch (e) {}
  state = _tjPersonal; _tjPersonal = null;
  if (window.OJ) window.OJ.leave('tj');
  tjTagFilters = [];
  var sb = document.getElementById('tj-search-box'); if (sb) sb.value = '';
  if (state.activeId && !state.entries.some(function(e) { return e.id === state.activeId && !e.trashed; })) {
    state.activeId = (state.entries.find(function(e) { return !e.trashed; }) || {}).id || null;
  }
  _tjModeUI();
  renderSidebar(); loadActiveEntry();
}
window._tjOJ = { enter: _tjOJEnter, leave: _tjOJLeave, active: _tjIsOJ };
(function() {
  if (!window.OJ || !_tjFeat.ourjournal) return;
  _tjOJState = window.OJ.register('tj', {
    shown: function() { return _tjIsOJ(); },
    render: function() { if (_tjIsOJ()) renderSidebar(); },
    reload: function() { if (_tjIsOJ()) loadActiveEntry(); },
    editor: function() { return document.getElementById('tj-page-editor'); },
    pageOwned: function(id) { var e = _tjIsOJ() && !window._tjCloudMode ? getActive() : null; return !!(e && e.id === id && e.template === 'page' && _tjDomOwner === id); },
    titleInput: function() { return document.getElementById('tj-entry-title-input'); },
    renderTags: function(t) { if (_tjIsOJ()) renderTags(t); },
    setSync: function(st) { if (_tjIsOJ()) _tjSetSync(st); },
    rebind: function(ed) { ed.querySelectorAll('.pg-img-wrap').forEach(_pgBindImgWrap); },
    pageSetup: function() { if (window._docxApplyPageSetup) window._docxApplyPageSetup('tj'); }
  });
  var ICON_OJ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.2c3 .2 5.5 2.6 5.5 5.8"/></svg>';
  var ICON_J = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2.5Z"/><path d="M8 7h7"/></svg>';
  function onTab(ev) {
    var b = ev.target.closest('.oj-tab'); if (!b) return;
    if (b.getAttribute('data-oj') === '1') {
      // If #mjd-panel is showing, come back to the native list first, then go shared.
      var pages = document.querySelector('#mjd-nav [data-sec="pages"]');
      var panel = document.getElementById('mjd-panel');
      if (pages && panel && panel.classList.contains('on')) { _tjRailBusy = true; try { pages.click(); } finally { _tjRailBusy = false; } }
      _tjOJEnter();
    } else _tjOJLeave();
  }
  function standIn() {
    var side = document.getElementById('tj-sidebar'), nb = document.getElementById('tj-new-entry-btn');
    if (!side || !nb || document.getElementById('tj-oj-rail') || document.getElementById('mjd-nav')) return;
    var rail = document.createElement('div');
    rail.id = 'tj-oj-rail'; rail.className = 'oj-rail'; rail.setAttribute('role', 'tablist');
    rail.innerHTML = '<button class="oj-tab" data-oj="1" role="tab" title="OurJournal — shared with Veda">' + ICON_OJ + '<span class="oj-lbl">OurJournal</span></button>' +
                     '<button class="oj-tab" data-oj="0" role="tab" title="MyJournal — your own entries">' + ICON_J + '<span class="oj-lbl">Journal</span></button>';
    side.insertBefore(rail, nb);
    rail.addEventListener('click', onTab);
  }
  function intoMjd() {
    var nav = document.getElementById('mjd-nav');
    var rail = nav && nav.querySelector('.mjd-rail');
    if (!rail || rail.querySelector('.oj-tab')) return !!rail;
    var own = document.getElementById('tj-oj-rail'); if (own) own.remove();
    var b = document.createElement('button');
    b.className = 'mjd-rail-btn oj-tab';
    b.setAttribute('data-oj', '1'); b.setAttribute('role', 'tab');
    b.title = 'OurJournal — shared with Veda';
    b.innerHTML = ICON_OJ + '<span class="mjd-lbl">OurJournal</span>';
    rail.insertBefore(b, rail.firstChild);
    rail.classList.add('oj-has-tab');
    b.addEventListener('click', onTab);
    // The Journal button is Tony's own: leave OurJournal before the rail
    // acts on the click (capture phase).
    nav.addEventListener('click', function(ev) {
      if (_tjRailBusy || ev.target.closest('.oj-tab')) return;
      if (ev.target.closest('[data-sec]') && _tjIsOJ()) _tjOJLeave();
    }, true);
    _tjModeUI();
    return true;
  }
  standIn();
  if (!intoMjd()) {
    var side = document.getElementById('tj-sidebar');
    if (side && window.MutationObserver) {
      var mo = new MutationObserver(function() { if (intoMjd()) mo.disconnect(); });
      mo.observe(side, { childList: true, subtree: true });
    }
  }
  _tjModeUI();
  if (window.OJ.wasOn('tj')) _tjOJEnter();
})();

/* ── MOBILE UI LOGIC ─────────────────────────────────────────────── */
var tjIsMobile = false;

function tjCheckMobile() {
  tjIsMobile = window.innerWidth <= 768;
}
tjCheckMobile();
window.addEventListener('resize', tjCheckMobile);

/* Hamburger: toggle sidebar */
var tjHamburger = document.getElementById('tj-hamburger');
var tjBackdrop = document.getElementById('tj-sidebar-backdrop');
var tjSidebar = document.getElementById('tj-sidebar');
// One place that owns drawer state. The root class is what lifts #tj-root above
// the body-level #tony-app-nav (z-index 10001) — without it the app header
// paints on top of the open drawer instead of being covered by its scrim.
function tjSetDrawer(open) {
  if (!tjSidebar || !tjBackdrop) return;
  tjSidebar.classList.toggle('tj-open', open);
  tjBackdrop.classList.toggle('tj-open', open);
  var root = document.getElementById('tj-root');
  if (root) root.classList.toggle('tj-drawer-open', open);
  document.body.classList.toggle('tj-drawer-open', open);
}
window._tjSetDrawer = tjSetDrawer;
if (tjHamburger) {
  tjHamburger.addEventListener('click', function() {
    tjSetDrawer(!tjSidebar.classList.contains('tj-open'));
  });
}
if (tjBackdrop) {
  tjBackdrop.addEventListener('click', function() { tjSetDrawer(false); });
}

/* Close sidebar after entry selected on mobile */
var _origRenderSidebar = renderSidebar;
renderSidebar = function() {
  _origRenderSidebar();
  // Re-attach click handlers to close sidebar on mobile
  document.querySelectorAll('#tj-entries-list .entry-item').forEach(function(el) {
    el.addEventListener('click', function() {
      if (tjIsMobile) tjSetDrawer(false);
    });
  });
};

/* Sync mobile title input with desktop title input */
var tjMobileTitle = document.getElementById('tj-mobile-title');
var tjDesktopTitle = document.getElementById('tj-entry-title-input');
if (tjMobileTitle && tjDesktopTitle) {
  tjMobileTitle.addEventListener('input', function() {
    tjDesktopTitle.value = this.value;
    autoSave();
  });
}

/* Patch loadActiveEntry to sync mobile title */
var _origLoadActive = loadActiveEntry;
loadActiveEntry = function() {
  _origLoadActive();
  if (tjMobileTitle) {
    var entry = getActive();
    tjMobileTitle.value = entry ? (entry.title || '') : '';
  }
};

/* Patch saveState to show mobile saved indicator */
var tjBbSaved = document.getElementById('tj-bb-saved');
var _origSaveState = saveState;
saveState = function() {
  _origSaveState();
  if (tjBbSaved) {
    tjBbSaved.style.opacity = '1';
    clearTimeout(tjBbSaved._t);
    tjBbSaved._t = setTimeout(function() { tjBbSaved.style.opacity = '0'; }, 2000);
  }
};

/* iOS: prevent bounce scroll inside content area */
var tjContent = document.getElementById('tj-content-area');
if (tjContent) {
  tjContent.addEventListener('touchmove', function(e) {
    e.stopPropagation();
  }, { passive: true });
}

/* ── PDF EXPORT ── */
/* tj-btn-export-pdf handled by fastTouch above */

// The saved PDF is named after the printed page's <title>, so that title carries the
// filename (underscored, illegal characters removed) rather than the entry title itself.
function _tjPdfName(t) {
  return window._pdfFileName ? window._pdfFileName(t) : (t || 'Untitled_Entry');
}

function _tjOpenPrintBlob(htmlStr) {
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
  var tags = (entry.tags || []).length ? entry.tags.join(', ') : '';

  // Visual templates: ask the live board to render itself — see the BJ twin.
  if (entry.template === 'whiteboard' || entry.template === 'mindmap') {
    var _vbrd = _tjBoards[entry.template === 'whiteboard' ? 'wb' : 'mm'];
    if (!_vbrd || !_vbrd.isOpen(entry.id)) {
      window.uiAlert('Open this ' + (entry.template === 'whiteboard' ? 'whiteboard' : 'mind map') + ' before exporting it to PDF.', { title: 'Nothing to export' });
      return;
    }
    _vbrd.toPngDataUrl().then(function (dataURL) {
      var vHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + _tjEsc(_tjPdfName(title)) + '</title>'
        + '<style>body{margin:0;background:#fff;}img{max-width:100%;display:block;}h1{font-family:sans-serif;font-size:18px;margin:16px;}p{font-family:sans-serif;font-size:12px;color:#666;margin:0 16px 12px;}@media print{h1,p{display:block;}}</style>'
        + '</head><body>'
        + '<h1>' + _tjEsc(title) + '</h1>'
        + '<p>' + _tjEsc(date) + (tags ? ' &middot; ' + _tjEsc(tags) : '') + '</p>'
        + (dataURL ? '<img src="' + dataURL + '" />' : '<p style="color:#aaa;font-style:italic;padding:16px;">This board is empty.</p>')
        + '</body></html>';
      _tjOpenPrintBlob(vHtml);
    });
    return;
  }

  // Text-based templates: build styled HTML print page
  var bodyHTML = '';
  if (entry.template === 'page') {
    bodyHTML = '<div class="page-content">' + (window._docxPdfBlackText ? window._docxPdfBlackText(entry.data.html || '') : (entry.data.html || '')) + '</div>';
  } else if (entry.template === 'journal-entries') {
    var activeKey = entry.data.activeDateKey;
    var dateLabel = '';
    if (activeKey) {
      var parts = activeKey.split('-');
      if (parts.length === 3) {
        var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      } else {
        dateLabel = activeKey;
      }
    }
    var pageHtml = (activeKey && entry.data.dates && entry.data.dates[activeKey]) ? (entry.data.dates[activeKey].html || '') : '';
    bodyHTML = (dateLabel ? '<div class="je-date-label">' + _tjEsc(dateLabel) + '</div>' : '')
      + '<div class="page-content">' + pageHtml + '</div>';
  }

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + _tjEsc(_tjPdfName(title)) + '</title><style>'
    + 'body{font-family:Georgia,serif;max-width:750px;margin:32px auto;color:#1a1a2e;font-size:14px;line-height:1.7;padding:0 24px;}'
    + 'h1{font-size:22px;font-weight:700;margin:0 0 6px;color:#1a1a1d;}'
    + '.meta{font-size:11px;color:#888;font-family:sans-serif;margin-bottom:20px;}'
    + '.tag{background:#f0f0f2;color:#45454c;border-radius:4px;padding:2px 8px;margin-left:4px;font-size:10px;font-weight:700;}'
    + '.section{margin-bottom:18px;}'
    + '.section-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#6b6b73;margin-bottom:6px;font-family:sans-serif;border-bottom:1px solid #e4e4e8;padding-bottom:4px;}'
    + '.section-body{white-space:pre-wrap;word-break:break-word;}'
    + '.page-content{line-height:1.7;}'
    + 'table{border-collapse:collapse;width:100%;margin:10px 0;}th,td{border:1px solid #dcdce0;padding:6px 10px;text-align:left;}th{background:#f5f5f7;}'
    + 'ul.docx-checklist{list-style:none;padding-left:8px;}li.docx-cl-item{list-style:none;}.docx-cl-box{margin-right:8px;}li.docx-cl-item.done .docx-cl-text{text-decoration:line-through;opacity:.6;}'
    + 'hr.docx-pagebreak{page-break-after:always;break-after:page;border:none;margin:0;}'
    + '.je-date-label{font-family:sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#6b6b73;margin-bottom:14px;}'
    + 'hr{border:none;border-top:1px solid #e4e4e8;margin:20px 0;}'
    + '@media print{body{margin:0;padding:16px;}}'
    + '</style>'
    + ((entry.template === 'page' && window._docxExportPageCss) ? '<style>' + window._docxExportPageCss('tj') + '</style>' : '')
    + (/docx-math/.test(bodyHTML) && window._docxExportMathHead ? window._docxExportMathHead() : '')
    + '</head><body>'
    + '<h1>' + _tjEsc(title) + '</h1>'
    + '<div class="meta">' + _tjEsc(date)
    + (tags ? tags.split(',').map(function(t){ return '<span class="tag">' + _tjEsc(t.trim()) + '</span>'; }).join('') : '')
    + '</div><hr/>'
    + bodyHTML
    + (/docx-math/.test(bodyHTML) && window._docxExportMathScript ? window._docxExportMathScript() : '')
    + '</body></html>';

  _tjOpenPrintBlob(html);
}

function _tjEsc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// ══════════════════════════════════════════
// TJ LOCK SYSTEM
// ══════════════════════════════════════════
// What the rest of the app needs from the lock code (the sidebar's delete).
var _tjLock = null;
(function() {
  // Lock data stored on entry.lock = {hash, plain} → syncs to Firebase via saveState()
  // Per-device unlock session stored in localStorage (not synced — each device must unlock once)
  var TJ_AUTH = 'https://taskhub-reminders.av1.workers.dev';
  var _tjUnlocked = {};
  function tlGetLock(id) {
    var entry = state.entries.find(function(e) { return e.id === id; });
    return (entry && entry.lock) ? entry.lock : null;
  }
  function tlLockVersion(id) {
    var entry = state.entries.find(function(e) { return e.id === id; });
    return (entry && entry.lock && entry.lock.v) || 0;
  }
  function tlSetLock(id, v) {
    var entry = state.entries.find(function(e) { return e.id === id; });
    if (!entry) return;
    entry.lock = { locked: true, v: v || Date.now() };
    entry.updated = Date.now();
    saveState();
  }
  function tlRemoveLock(id) {
    var entry = state.entries.find(function(e) { return e.id === id; });
    if (!entry) return;
    delete entry.lock;
    entry.updated = Date.now();
    saveState();
  }
  
  // Once per device, forever — monotonic version comparison, same reasoning as
  // blIsUnlocked / alIsUnlocked: entry.lock.v arrives via Firebase sync and can
  // read stale or absent mid-flight, and an exact match turned that into a
  // spurious password prompt. Only a strictly newer version re-locks.
  function _tlUnlockAt(id) {
    var best = (_tjUnlocked[id] !== undefined) ? _tjUnlocked[id] : -1;
    var read = function(store, key) {
      try {
        var raw = store.getItem(key); if (raw === null) return;
        var s = String(raw), n = parseInt(s.charAt(0)==='v' ? s.slice(1) : s, 10);
        if (!isNaN(n)) { if (n > best) best = n; }
        else if (best < 0) best = 0;
      } catch(e) {}
    };
    read(localStorage,'tj_unlockedat_'+id); read(sessionStorage,'tj_unlockedat_'+id);
    read(localStorage,'tj_unlockedv_'+id);  read(sessionStorage,'tj_unlockedv_'+id);
    try { if ((localStorage.getItem('tj_unlocked_'+id)==='1'||sessionStorage.getItem('tj_unlocked_'+id)==='1') && best < 0) best = 0; } catch(e) {}
    return best;
  }
  function tlIsUnlocked(id) {
    var at = _tlUnlockAt(id);
    if (at < 0) return false;
    return at >= tlLockVersion(id);
  }
  function tlMarkUnlocked(id) {
    var v = tlLockVersion(id), prev = _tlUnlockAt(id);
    if (prev > v) v = prev;
    _tjUnlocked[id] = v;
    try{localStorage.setItem('tj_unlockedat_'+id,String(v));}catch(e){}
    try{sessionStorage.setItem('tj_unlockedat_'+id,String(v));}catch(e){}
    try{localStorage.setItem('tj_unlockedv_'+id,'v'+v);}catch(e){}
    try{localStorage.setItem('tj_unlocked_'+id,'1');}catch(e){}
  }
  function tlMarkLocked(id) {
    delete _tjUnlocked[id];
    try{localStorage.removeItem('tj_unlocked_'+id);localStorage.removeItem('tj_unlockedv_'+id);localStorage.removeItem('tj_unlockedat_'+id);}catch(e){}
    try{sessionStorage.removeItem('tj_unlocked_'+id);sessionStorage.removeItem('tj_unlockedv_'+id);sessionStorage.removeItem('tj_unlockedat_'+id);}catch(e){}
  }

  // Simple hash (SHA-256 via subtle crypto)
  

  var overlay = document.getElementById('tj-lock-overlay');
  var lockBtn = document.getElementById('tj-btn-lock');
  var mobileLockBtn = document.getElementById('tj-mobile-lock-btn');
  var pwInput = document.getElementById('tj-lock-pw');
  var submitBtn = document.getElementById('tj-lock-submit');
  var errEl = document.getElementById('tj-lock-err');
  var forgotBtn = document.getElementById('tj-lock-forgot');
  var resetBtn = document.getElementById('tj-lock-reset');
  var lockIcon = document.getElementById('tj-lock-icon');
  var lockTitle = document.getElementById('tj-lock-title');
  var lockSub = document.getElementById('tj-lock-sub');
  var cancelBtn = document.getElementById('tj-lock-cancel');
  var boxEl = document.getElementById('tj-lock-box');
  var menuEl = document.getElementById('tj-lock-menu');
  var inputWrap = document.getElementById('tj-lock-input-wrap');
  var bioEl = document.getElementById('tj-lock-bio');
  var tlMode = 'unlock';
  var _tlRemoveBioId = null;   // when set to an entry id, a successful unlock removes that entry's biometric

  // ── BIOMETRICS (Face ID / Touch ID / fingerprint / Windows Hello) ──
  // Primary unlock per entry; password stays as the fallback. Keyed by entry id
  // under the 'tj' namespace so each entry keeps its own isolated device credential.
  function tlBioShowInput(show) {
    pwInput.style.display = show ? '' : 'none';
    submitBtn.style.display = show ? '' : 'none';
    forgotBtn.style.display = show ? '' : 'none';
    if (resetBtn) resetBtn.style.display = show ? '' : 'none';
    if (show) setTimeout(function() { pwInput.focus(); }, 60);
  }
  var _tlBioSeq = 0;   // newest render wins: two quick opens used to draw the buttons twice
  function tlBioRender() {
    if (!bioEl) return; bioEl.innerHTML = ''; bioEl.style.display = 'none';
    var seq = ++_tlBioSeq;
    if (!window.Bio || tlMode !== 'unlock') return;
    var entry = getActive(); if (!entry) return; var id = entry.id;
    window.Bio.available().then(function(avail) {
      var cur = getActive();
      if (tlMode !== 'unlock' || !cur || cur.id !== id) return;
      if (seq !== _tlBioSeq) return;
      bioEl.innerHTML = '';
      var had = window.Bio.isRegistered('tj', id);
      if (!(avail && window.Bio.isRegistered('tj', id, tlLockVersion(id)))) { if (avail && had) tlBioStaleMsg(); return; }
      bioEl.style.display = 'flex'; bioEl.style.flexDirection = 'column'; bioEl.style.gap = '8px'; bioEl.style.marginBottom = '10px';
      var b = document.createElement('button'); b.className = 'tl-btn';
      b.innerHTML = TNI.unlock + '<span>Unlock with ' + window.Bio.label() + '</span>';
      b.onclick = function() { tlBioUnlock(); };
      bioEl.appendChild(b);
      // The password field stays visible alongside it: biometrics run ONLY when
      // this button is pressed, so either route is available at all times.
      tlBioShowInput(true);
    });
  }
  function tlBioUnlock() {
    errEl.textContent = '';
    var entry = getActive(); if (!entry || !window.Bio) return; var id = entry.id;
    window.Bio.authenticate('tj', id, { v: tlLockVersion(id) }).then(function(r) {
      if (r.ok) {
        if (_tlRemoveBioId === id) { tlDoRemoveBio(id); return; }
        tlMarkUnlocked(id); tlHideOverlay(); tlUpdateLockBtn(); try { loadActiveEntry(); renderSidebar(); } catch(e) {}
      }
      else if (r.error === 'stale') { tlBioStaleMsg(); }
      else if (r.error === 'notregistered') { tlBioShowInput(true); }
      else { errEl.textContent = 'Biometric check failed — use your password.'; tlBioShowInput(true); }
    });
  }
  // The password changed since this device enrolled, so its biometric no longer
  // opens the entry (Bio drops it): say why, and fall back to the password.
  function tlBioStaleMsg() {
    if (bioEl) { bioEl.innerHTML = ''; bioEl.style.display = 'none'; }
    errEl.textContent = 'The password changed — enter the new one. ' + window.Bio.label() + ' needs registering again on this device.';
    tlBioShowInput(true);
  }
  // After the password proves who this is: if a password change dropped this
  // device's biometric (or this device just changed it), offer to enrol again.
  function tlBioAfterPw(id, hadBio) {
    if (!window.Bio) return;
    if (window.Bio.takeStale('tj', id) || hadBio) tlMaybeOfferBio(id);
  }
  function tlHadBio(id) { return !!(window.Bio && window.Bio.isRegistered('tj', id)); }
  // Verify identity (biometric OR password) before removing this entry's biometric.
  function tlBioRemovePrompt(id) {
    tlShowOverlay('unlock');
    _tlRemoveBioId = id;
    lockIcon.innerHTML = TNI.user;
    lockSub.textContent = 'Verify with ' + window.Bio.label() + ' or your password to remove biometrics from this device.';
  }
  function tlDoRemoveBio(id) {
    _tlRemoveBioId = null;
    window.Bio.unregister('tj', id);
    tlHideOverlay(); tlUpdateLockBtn();
    window.uiAlert('Biometrics removed from this device.');
  }
  function tlBioRegister(id, closeAfter) {
    if (!window.Bio) return;
    window.Bio.register('tj', id, { rpName: 'MyJournal', userName: 'tj-' + id, displayName: 'Journal entry — MyJournal', v: tlLockVersion(id) }).then(function(r) {
      if (r.ok) { tlMarkUnlocked(id); if (closeAfter) { tlHideOverlay(); tlUpdateLockBtn(); try { loadActiveEntry(); renderSidebar(); } catch(e) {} } alert('Biometrics registered on this device. You can now unlock this entry with ' + window.Bio.label() + '.'); }
      else if (!(r.error === 'cancelled' || r.error === 'NotAllowedError')) alert('Could not register biometrics on this device.');
    });
  }
  function tlMaybeOfferBio(id) {
    if (!window.Bio) return;
    window.Bio.available().then(function(avail) {
      if (!avail || window.Bio.isRegistered('tj', id, tlLockVersion(id))) return;
      window.uiConfirm('Register ' + window.Bio.label() + ' to unlock this entry on this device? Your password still works as a fallback.', { title: 'Register ' + window.Bio.label(), okLabel: 'Register' }).then(function(ok) { if (ok) tlBioRegister(id, false); });
    });
  }

  // modes: 'setpw' | 'unlock' | 'remove' | 'changepw'
  function tlShowOverlay(mode) {
    tlMode = mode;
    overlay.style.display = 'flex';
    if (menuEl) { menuEl.innerHTML = ''; menuEl.style.display = 'none'; }
    if (inputWrap) inputWrap.style.display = '';
    if (bioEl) { bioEl.innerHTML = ''; bioEl.style.display = 'none'; }
    _tlRemoveBioId = null;   // cleared on any normal open; tlBioRemovePrompt re-sets it after
    errEl.textContent = '';
    pwInput.value = '';
    pwInput.style.display = '';   // restore in case a prior biometric prompt hid it
    pwInput.classList.remove('error');
    submitBtn.style.display = '';
    cancelBtn.style.display = '';
    forgotBtn.style.display = '';
    if (resetBtn) resetBtn.style.display = '';
    if (mode === 'setpw') {
      lockIcon.innerHTML = TNI.shield;
      lockTitle.textContent = 'Set a Password';
      lockSub.textContent = 'Choose a password for this entry. Unlock once on this device — it stays unlocked here until you re-lock it.';
      submitBtn.textContent = 'Set Password';
      forgotBtn.style.display = 'none';
      if (resetBtn) resetBtn.style.display = 'none';
    } else if (mode === 'remove') {
      lockIcon.innerHTML = TNI.unlock;
      lockTitle.textContent = 'Remove Lock';
      lockSub.textContent = 'Enter the password to remove the lock.';
      submitBtn.textContent = 'Remove Lock';
    } else if (mode === 'changepw') {
      lockIcon.innerHTML = TNI.key;
      lockTitle.textContent = 'Change Password';
      lockSub.textContent = 'Enter your current password first.';
      submitBtn.textContent = 'Verify';
    } else {
      lockIcon.innerHTML = TNI.lock;
      lockTitle.textContent = 'Locked Entry';
      lockSub.textContent = 'Enter your password to unlock this entry.';
      submitBtn.textContent = 'Unlock';
    }
    setTimeout(function() { pwInput.focus(); }, 80);
    tlBioRender();
  }

  function tlHideOverlay() {
    overlay.style.display = 'none';
    if (menuEl) { menuEl.innerHTML = ''; menuEl.style.display = 'none'; }
    if (inputWrap) inputWrap.style.display = '';
    if (bioEl) { bioEl.innerHTML = ''; bioEl.style.display = 'none'; }
    _tlRemoveBioId = null;
  }

  function tlLockErr(msg) {
    errEl.textContent = msg;
    pwInput.value = '';
    pwInput.classList.add('error');
    if (boxEl) { boxEl.classList.remove('shake'); void boxEl.offsetWidth; boxEl.classList.add('shake'); }
    setTimeout(function() { pwInput.classList.remove('error'); }, 450);
  }

  function _tlMenuBtn(parent, label, cls, fn, beforeEl) {
    var b = document.createElement('button');
    b.className = 'tl-btn' + (cls ? ' ' + cls : '');
    // Callers pass icon markup + a <span> label, so this must be innerHTML —
    // textContent printed the raw <svg …> source into the button.
    b.innerHTML = label;
    b.onclick = fn;
    if (beforeEl) parent.insertBefore(b, beforeEl); else parent.appendChild(b);
    return b;
  }

  // Manage menu shown when the entry is already locked (mirrors MyList)
  function tlShowMenu(entry) {
    overlay.style.display = 'flex';
    errEl.textContent = '';
    pwInput.value = '';
    pwInput.classList.remove('error');
    if (bioEl) { bioEl.innerHTML = ''; bioEl.style.display = 'none'; }
    lockIcon.innerHTML = TNI.lock;
    lockTitle.textContent = 'Locked Entry';
    lockSub.textContent = 'Manage lock for this entry.';
    if (inputWrap) inputWrap.style.display = 'none';
    forgotBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';
    var m = menuEl; m.innerHTML = ''; m.style.display = 'flex';
    if (!tlIsUnlocked(entry.id)) {
      _tlMenuBtn(m, TNI.unlock + '<span>Unlock this entry</span>', '', function() { tlShowOverlay('unlock'); });
    } else {
      _tlMenuBtn(m, TNI.lock + '<span>Lock this entry now</span>', '', function() { tlMarkLocked(entry.id); tlHideOverlay(); tlUpdateLockBtn(); tlCheckEntry(); });
    }
    var changeBtn = _tlMenuBtn(m, TNI.key + '<span>Change password</span>', 'ghost', function() { tlShowOverlay('changepw'); });
    _tlMenuBtn(m, TNI.trash + '<span>Remove lock</span>', 'danger', function() { tlShowOverlay('remove'); });
    _tlMenuBtn(m, 'Close', 'ghost', function() { tlDismiss(); });
    if (window.Bio) window.Bio.available().then(function(avail) {
      var cur = getActive();
      if (!avail || !cur || cur.id !== entry.id) return;
      if (window.Bio.isRegistered('tj', entry.id, tlLockVersion(entry.id)))
        _tlMenuBtn(m, TNI.user + '<span>Remove biometrics</span>', 'ghost', function() { tlBioRemovePrompt(entry.id); }, changeBtn);
      else
        _tlMenuBtn(m, TNI.user + '<span>Register ' + window.Bio.label() + '</span>', '', function() { tlBioRegister(entry.id, true); }, changeBtn);
    });
  }

  // Dismiss the overlay — but if the entry is still locked & not unlocked on this
  // device, stay gated (never expose content) by falling back to the unlock prompt.
  function tlDismiss() {
    var entry = getActive();
    if (entry && tlGetLock(entry.id) && !tlIsUnlocked(entry.id)) { tlShowOverlay('unlock'); }
    else { tlHideOverlay(); }
  }

  function tlManage() {
    var entry = getActive();
    if (!entry) return;
    var lock = tlGetLock(entry.id);
    if (!lock) { tlShowOverlay('setpw'); return; }
    tlShowMenu(entry);
  }

  cancelBtn && cancelBtn.addEventListener('click', function() { tlDismiss(); });

  function tlUpdateLockBtn() {
    var entry = getActive();
    if (!entry || !_tjFeat.locks || _tjIsPinned(entry.id)) {
      lockBtn.style.display = 'none';
      if (mobileLockBtn) mobileLockBtn.style.display = 'none';
      return;
    }
    lockBtn.style.display = '';
    if (mobileLockBtn) mobileLockBtn.style.display = '';
    var lock = tlGetLock(entry.id);
    if (lock) {
      lockBtn.classList.add('locked');
      lockBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Locked';
      // Class, not an inline colour — the unlocked branch used to clear the
      // inline colour and fall back to the UA's black buttontext.
      if (mobileLockBtn) { mobileLockBtn.innerHTML = TNI.lock; mobileLockBtn.classList.add('tl-locked'); mobileLockBtn.style.color = ''; }
    } else {
      lockBtn.classList.remove('locked');
      lockBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Lock';
      if (mobileLockBtn) { mobileLockBtn.innerHTML = TNI.unlock; mobileLockBtn.classList.remove('tl-locked'); mobileLockBtn.style.color = ''; }
    }
  }

  // Lock button (desktop + mobile) opens the manage flow
  function _tlHandleLockClick() { tlManage(); }
  mobileLockBtn && mobileLockBtn.addEventListener('click', _tlHandleLockClick);

  // Called by loadActiveEntry wrapper below
  function tlCheckEntry() {
    var entry = getActive();
    tlUpdateLockBtn();
    if (!entry) { tlHideOverlay(); return; }
    var lock = tlGetLock(entry.id);
    if (lock && !tlIsUnlocked(entry.id)) {
      tlShowOverlay('unlock');
    } else {
      tlHideOverlay();
    }
  }

  // Lock button click (desktop) — same logic as mobile via shared handler
  lockBtn && lockBtn.addEventListener('click', _tlHandleLockClick);

  // Every lock call went through a bare fetch+res.json() inside one try/catch
  // that reported "Network error" for anything that threw — including a server
  // that answered with an HTML error page. Tag the failure so the message can
  // tell the truth about what actually went wrong.
  async function tlAuthPost(path, body) {
    if (navigator.onLine === false) { var offErr = new Error('offline'); offErr._offline = true; throw offErr; }
    var res;
    try { res = await fetch(TJ_AUTH + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { var netErr = new Error('unreachable'); netErr._offline = true; throw netErr; }
    var txt = await res.text();
    try { return JSON.parse(txt); }
    catch (e) { var srvErr = new Error('bad response'); srvErr._status = res.status; throw srvErr; }
  }  // The message for a lock call that threw (see tlAuthPost).
  function tlErrText(e) {
    return e && e._offline
      ? 'No connection. Check your network and try again.'
      : (e && e._status ? 'Lock server error (' + e._status + '). Try again.' : 'Could not reach the lock server. Try again.');
  }
  _tjLock = { post: tlAuthPost, errText: tlErrText };

  // The server is the source of truth for locks. If it reports no lock for this
  // entry, the local marker is stale (typically the entry was deleted and
  // re-synced) — clear it and let the user in rather than trapping them behind
  // a password that nothing on the server can verify.
  function tlDropStaleLock(entry) {
    tlRemoveLock(entry.id); tlMarkUnlocked(entry.id);
    tlHideOverlay(); tlUpdateLockBtn();
    try { loadActiveEntry(); renderSidebar(); } catch (e) {}
  }

  // Submit button
  submitBtn && submitBtn.addEventListener('click', async function() {
    var entry = getActive(); if (!entry) return;
    var pw = pwInput.value.trim();
    if (!pw) { pwInput.classList.add('error'); errEl.textContent = 'Password required.'; return; }
    submitBtn.disabled = true; var _prev = submitBtn.textContent; submitBtn.textContent = 'Checking…';
    var lock = tlGetLock(entry.id);
    try {
      if (!lock || tlMode === 'setpw') {
        var hint = (await window.uiPrompt('Optional: enter a password hint (sent in the recovery email, never the password). Leave blank to skip.', {title:'Password hint'})) || '';
        var data = await tlAuthPost('/auth/journal/set-lock', { journal: 'tj', entryId: entry.id, password: pw, hint: hint });
        if (data.ok) { tlSetLock(entry.id); tlMarkUnlocked(entry.id); tlHideOverlay(); tlUpdateLockBtn(); renderSidebar(); tlMaybeOfferBio(entry.id); }
        else errEl.textContent = 'Failed to set lock. Try again.';
      } else if (tlMode === 'remove') {
        var data2 = await tlAuthPost('/auth/journal/remove-lock', { journal: 'tj', entryId: entry.id, password: pw });
        if (data2.ok) { tlRemoveLock(entry.id); tlMarkLocked(entry.id); tlHideOverlay(); tlUpdateLockBtn(); renderSidebar(); }
        else tlLockErr('Wrong password.');
      } else if (tlMode === 'changepw') {
        var data3 = await tlAuthPost('/auth/journal/verify', { journal: 'tj', entryId: entry.id, password: pw });
        if (data3.ok) {
          var chg = await window.uiForm({ title:'Change password', okLabel:'Change password',
            fields:[ {name:'password',label:'New password',type:'password',required:true}, {name:'hint',label:'New password hint (optional)'} ] });
          var np = chg ? chg.password : '';
          if (np && np.trim()) {
            var nh = (chg.hint) || '';
            // One call: the worker checks `current` and swaps the password, so
            // the entry is never left without one if the new password fails.
            var sd = await tlAuthPost('/auth/journal/set-lock', { journal: 'tj', entryId: entry.id, password: np.trim(), hint: nh, current: pw });
            if (sd.ok) { var hadBio = tlHadBio(entry.id); tlSetLock(entry.id); tlMarkUnlocked(entry.id); tlHideOverlay(); tlUpdateLockBtn(); renderSidebar(); tlBioAfterPw(entry.id, hadBio); }
            else errEl.textContent = 'Failed to set new password.';
          } else errEl.textContent = 'New password empty.';
        } else tlLockErr('Wrong password.');
      } else {
        var data4 = await tlAuthPost('/auth/journal/verify', { journal: 'tj', entryId: entry.id, password: pw });
        if (data4.ok) {
          if (_tlRemoveBioId === entry.id) { tlDoRemoveBio(entry.id); }
          else { tlMarkUnlocked(entry.id); tlHideOverlay(); tlUpdateLockBtn(); try { loadActiveEntry(); renderSidebar(); } catch(e) {} tlBioAfterPw(entry.id, false); }
        } else if (data4.noLock) {
          tlDropStaleLock(entry);
        } else tlLockErr('Wrong password.');
      }
    } catch(e) {
      errEl.textContent = tlErrText(e);
    }
    submitBtn.disabled = false; submitBtn.textContent = _prev;
  });

  pwInput && pwInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') submitBtn.click();
    if (e.key === 'Escape') {
      // If unlock prompt — revert to previous entry or keep overlay up (can't dismiss lock)
      // Just clear error state; can't bypass lock with Escape
      errEl.textContent = '';
      pwInput.classList.remove('error');
    }
  });

  // Forgot password — fetches hint from Worker KV, emails via Formspree from client
  forgotBtn && forgotBtn.addEventListener('click', async function() {
    var entry = getActive(); if (!entry) return;
    var lock = tlGetLock(entry.id);
    if (!lock) { errEl.textContent = 'No lock set on this entry.'; return; }
    forgotBtn.textContent = 'Sending...';
    forgotBtn.disabled = true;
    try {
      // The worker mails the hint and no longer returns its text. journal:'tj'
      // is what routes this to Tony's inbox — the entry id is random and names
      // no owner (see JOURNAL_OWNER in the worker).
      var hintRes = await fetch(TJ_AUTH + '/auth/journal/hint', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          journal: 'tj', entryId: entry.id, owner: 'tony',
          appName: 'MyJournal',
          label: 'entry "' + (entry.title || 'Untitled') + '"'
        })
      });
      var hintData = await hintRes.json();
      if (hintData.noLock) {
        errEl.textContent = 'No lock found on server. Try re-locking the entry.';
        forgotBtn.disabled = false; forgotBtn.textContent = 'Forgot password?';
        return;
      }
      // `hintData.ok` is not delivery. With no server-side sender the worker
      // returns a relay envelope for THIS BROWSER to post, because Formspree
      // files worker-sent mail as spam. _mailRelay reports what went out.
      if (await window._mailRelay(hintData)) {
        forgotBtn.textContent = 'Hint sent!';
        setTimeout(function() { forgotBtn.textContent = 'Forgot password?'; forgotBtn.disabled = false; }, 3000);
      } else {
        forgotBtn.textContent = 'Failed - try again';
        forgotBtn.disabled = false;
      }
    } catch(e) {
      forgotBtn.textContent = 'Failed - try again';
      forgotBtn.disabled = false;
    }
  });

  // Reset password via emailed security code (MyJournal → Tony's email).
  resetBtn && resetBtn.addEventListener('click', async function() {
    var entry = state.entries.find(function(e) { return e.id === state.activeId; });
    if (!entry) return;
    if (!tlGetLock(entry.id)) { errEl.textContent = 'No lock set on this entry.'; return; }
    var prev = resetBtn.textContent; resetBtn.textContent = 'Sending code…'; resetBtn.disabled = true;
    await window._pwReset({
      worker: TJ_AUTH,
      reqBody: { journal: 'tj', entryId: entry.id },
      // The worker picks the mailbox; `owner` states it outright rather than
      // leaning on the journal lookup. `email` is now only display text.
      owner: 'tony',
      email: 'anthonypn99@gmail.com',
      appName: 'MyJournal',
      label: 'entry "' + (entry.title || 'Untitled') + '"',
      onSuccess: function() {
        var hadBio = tlHadBio(entry.id);
        tlSetLock(entry.id); tlMarkUnlocked(entry.id); tlHideOverlay(); tlUpdateLockBtn();
        tlBioAfterPw(entry.id, hadBio);
        try { loadActiveEntry(); renderSidebar(); } catch(e) {}
      }
    });
    resetBtn.textContent = prev; resetBtn.disabled = false;
  });

  // Patch loadActiveEntry to run lock check after loading
  var _origLoadActive = loadActiveEntry;
  loadActiveEntry = function() {
    _origLoadActive.apply(this, arguments);
    tlCheckEntry();
  };

  // Run immediately so the first entry loaded before this patch executes is also gated
  tlCheckEntry();

  // Patch renderSidebar to show lock badge
  var _origRenderSidebar = renderSidebar;
  renderSidebar = function() {
    _origRenderSidebar.apply(this, arguments);
    // Add lock badges after render
    document.querySelectorAll('#tj-entries-list .entry-item').forEach(function(div) {
      var id = div.dataset.entryId;
      if (!id) return;
      var titleEl = div.querySelector('.entry-item-title');
      if (!titleEl) return;
      var existing = titleEl.querySelector('.tl-badge');
      if (existing) existing.remove();
      if (tlGetLock(id)) {
        var badge = document.createElement('span');
        badge.className = 'tl-badge';
        badge.innerHTML = TNI.lock;
        titleEl.appendChild(badge);
      }
    });
  };

  // Expose for external use
  window._tjLockCheck = tlCheckEntry;
  window._tjLockUpdateBtn = tlUpdateLockBtn;
  window._tjGetLock = tlGetLock;
  window._tjIsUnlocked = tlIsUnlocked;
})();

// ── TJ THEME TOGGLE ──────────────────────────────────────────────────
(function() {

  function tjApplyTheme() {
    var titleEl = document.getElementById('tj-nav-title');
    var mark = titleEl && titleEl.querySelector('.suite-title');
    if (mark) mark.classList.add('th-wordmark');
  }


  window._tjApplyTheme = tjApplyTheme;
  document.addEventListener('DOMContentLoaded', tjApplyTheme);
})();

})();

// The DOCX editor config for this app (core/docx.js reads Notebook.docxApps).
Notebook.registerDocx('tj', {
  root: 'tj-root', lightClass: 'tj-light',
  ctxs: [
    // Both rich-text templates run the same editor: the Page template, and the
    // Journal Entries template (one docx context per date-tabbed editor).
    { ed: 'tj-page-editor', tb: 'tj-page-toolbar', wrap: 'tj-page-editor-wrap', area: 'tj-page-area', img: 'tj-page-img-file', md: 'tj-pt-md' },
    { ed: 'tj-je-editor',   tb: 'tj-je-toolbar',   wrap: 'tj-je-editor-wrap',   area: 'tj-je-area',   img: 'tj-je-img-file',   md: 'tj-je-pt-md' }
  ],
  mainToolbar: 'tj-toolbar', syncPill: 'tj-sync-pill', newBtn: 'tj-new-entry-btn',
  exportBtn: 'tj-btn-export-pdf', sidebarBtn: 'tj-fullscreen-btn', trashAPI: '_tjTrashAPI',
  aiProfile: 'tony', bindImg: '_tjBindImg',
  name: 'MyJournal', side: 'tony'
});

/* ══════════════════════════════════════════════════════════════════════════
     MyJournal sidebar rail  (Tony's MyJournal only)
     Brainstorm Journal (#bj-root, Veda's profile) is not touched by any of this.

     The rail at the top of MyJournal's sidebar. It holds one Journal button;
     OurJournal adds its own tab to it (see _tjModeUI / intoMjd), so the rail,
     #mjd-panel, the [data-sec="pages"] button and MJDocsUI.release must stay.
     ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.MJDocsUI) return;
  // The rail exists for OurJournal's tab; a host without OurJournal has no rail.
  var _cfg = (window.Notebook && window.Notebook.mounts && window.Notebook.mounts.tj) || {};
  if (_cfg.features && _cfg.features.ourjournal === false) return;

  // MyJournal and OurJournal still read this flag. Nothing sets it any more.
  window._tjCloudMode = false;
  // What the removed rail features left in localStorage is swept by sweep.js
  // (cleanup-rules.json, item mjd-rail-leftovers).

  var ICON_J = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M8 7h7"/><path d="M8 11h7"/><path d="M8 15h4"/></svg>';
  function el(id) { return document.getElementById(id); }

  function buildNav() {
    var sidebar = el('tj-sidebar');
    if (!sidebar || el('mjd-nav')) return;

    var nav = document.createElement('div');
    nav.id = 'mjd-nav';
    nav.innerHTML =
      '<div class="mjd-rail" role="tablist">' +
        '<button class="mjd-rail-btn" data-sec="pages" title="MyJournal">' + ICON_J + '<span class="mjd-lbl">Journal</span></button>' +
      '</div>';
    sidebar.insertBefore(nav, el('tj-new-entry-btn'));

    var panel = document.createElement('div');
    panel.id = 'mjd-panel';
    var list = el('tj-entries-list');
    list.parentNode.insertBefore(panel, list.nextSibling);

    nav.addEventListener('click', function (e) {
      if (e.target.closest('[data-sec]')) setSection('pages');
    });
    setSection('pages');
  }

  // Journal is the only section left.
  function setSection() {
    document.querySelectorAll('#mjd-nav [data-sec]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-sec') === 'pages');
    });
  }

  // MyJournal and OurJournal call this when they take the editor back. There
  // is nothing left to release, so it only clears the flag.
  function releaseEditor() {
    window._tjCloudMode = false;
  }

  function boot() {
    if (!el('tj-sidebar')) return;
    buildNav();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // MyJournal is created lazily on first open in some paths; retry once the app
  // is actually shown so the nav is never missing.
  var _origShow = window.showTonyJournal;
  if (typeof _origShow === 'function') {
    window.showTonyJournal = function () {
      var r = _origShow.apply(this, arguments);
      setTimeout(boot, 0);
      return r;
    };
  }

  window.MJDocsUI = { section: setSection, release: releaseEditor };
})();
