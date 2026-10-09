/* Brainstorm Journal (key bj, Veda's journal) as a Notebook app.
   Loaded by Notebook.mount({ app: 'brainstorm', key: 'bj', store: 'journal' }),
   which writes this script in where the host called it, while the page parses.
   It builds #bj-root right before its own <script> tag, then runs the app.
   Its Firestore layer (window._fbLoadJournal and friends) is still the host's
   until it moves with MyJournal's (docs/Notebook/plan.md). */
(function () {
var me = document.currentScript;
var html = `
<div id="bj-root">
<div id="bj-nav-header" class="veda-hdr-outer">
  <div class="veda-hdr-inner">
  <div class="veda-hdr-left">
    <div style="font-family:'Playfair Display',serif;font-size:22px;font-weight:900;color:#8D769A;letter-spacing:1px;text-transform:uppercase;line-height:1;">Brainstorm Journal</div>
  </div>
  <div class="veda-hdr-right">
    <div class="veda-hbtns">
      <button onclick="window._vedaNav&&window._vedaNav('taskhub')" onmouseenter="this.style.borderColor='#8D769A'" onmouseleave="this.style.borderColor='#4A4B51'" style="background:transparent;color:#8D769A;border:1px solid #4A4B51;border-radius:5px;padding:0 10px;height:28px;box-sizing:border-box;display:inline-flex;align-items:center;font-size:10px;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:1px;transition:all .15s;">TaskHub</button>
      <button onclick="window._vedaNav&&window._vedaNav('gita')" onmouseenter="this.style.borderColor='#8D769A'" onmouseleave="this.style.borderColor='#4A4B51'" style="background:transparent;color:#8D769A;border:1px solid #4A4B51;border-radius:5px;padding:0 10px;height:28px;box-sizing:border-box;display:inline-flex;align-items:center;font-size:10px;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:1px;transition:all .15s;">Gita</button>
      <button style="background:#8D769A;color:#1B1C1E;border:1px solid #8D769A;border-radius:5px;padding:0 10px;height:28px;box-sizing:border-box;display:inline-flex;align-items:center;font-size:10px;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:1px;">Journal</button>
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
  </div>
  <div id="bj-entries-list"></div>
  <div id="bj-sidebar-stats">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
    <span id="bj-entry-count">0</span> entries
  </div>
</div>

<!-- MAIN -->
<div id="bj-main">
  <!-- Mobile header: lives inside main so it doesn't affect root flex layout -->
  <div id="bj-mobile-header">
    <button id="bj-hamburger" style="background:transparent;border:none;cursor:pointer;padding:8px;color:var(--purple);flex-shrink:0;touch-action:manipulation;" aria-label="Open sidebar">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <input id="bj-mobile-title" type="text" placeholder="Untitled entry…" style="flex:1;background:none;border:none;outline:none;font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:var(--text);min-width:0;padding:0 4px;" />
    <button id="bj-mobile-lock-btn" style="display:none;background:transparent;border:none;cursor:pointer;padding:6px 8px;flex-shrink:0;touch-action:manipulation;font-size:18px;line-height:0;display:inline-flex;align-items:center;" aria-label="Lock entry"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg></button>
  </div>
  <div id="bj-toolbar">
    <button id="bj-fullscreen-btn" title="Toggle sidebar">
      <svg id="bj-fs-icon-show" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
      <svg id="bj-fs-icon-hide" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="9" x2="9" y2="9" opacity="0.5"/><line x1="15" y1="12" x2="9" y2="12" opacity="0.5"/><line x1="15" y1="15" x2="9" y2="15" opacity="0.5"/></svg>
    </button>
    <div class="toolbar-sep"></div>
    <input id="bj-entry-title-input" type="text" placeholder="Untitled entry…" />
    <div class="toolbar-sep"></div>
    <div class="mode-toggle-wrap">
      <span class="mode-toggle-label" id="bj-mode-label">VIEW</span>
      <label class="mode-toggle" title="Toggle Edit / View mode">
        <input type="checkbox" id="bj-btn-edit" />
        <div class="toggle-track"></div>
        <div class="toggle-knob"></div>
      </label>
    </div>
    <div class="toolbar-sep"></div>
    <button class="tb-btn" id="bj-btn-template" data-tip="Change template">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      Templates
    </button>
    <div class="toolbar-sep"></div>
    <button class="tb-btn" id="bj-btn-export-pdf" data-tip="Export as PDF" style="color:var(--purple);border-color:rgba(141,118,154,0.3);">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      Export PDF
    </button>
    <div class="toolbar-sep"></div>
    <button class="tb-btn lock-btn" id="bj-btn-lock" data-tip="Lock this entry" style="display:none;">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      Lock
    </button>
    <div class="toolbar-sep"></div>

    <!-- TAGS (moved into the toolbar — Batch 12 #3) -->
    <div id="bj-tags-row" style="display:none;">
      <span class="tags-label">Tags</span>
      <input id="bj-add-tag-input" type="text" placeholder="+ add tag" maxlength="20" />
    </div>

    <span id="bj-sync-pill" class="bj-sync-pill bj-sync-idle">
      <span class="bj-sync-dot"></span>
      <span id="bj-sync-text">Idle</span>
    </span>
  </div>

  <div id="bj-content-area">
    <!-- LOCK OVERLAY -->
    <div id="bj-lock-overlay" style="display:none;">
      <div class="tl-box" id="bj-lock-box">
        <div class="tl-icon" id="bj-lock-icon"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
        <div class="tl-title" id="bj-lock-title">Locked Entry</div>
        <div class="tl-sub" id="bj-lock-sub">Enter your password to unlock this entry.</div>
        <div id="bj-lock-bio" style="display:none;"></div>
        <div class="tl-menu" id="bj-lock-menu" style="display:none;"></div>
        <div class="tl-input-wrap" id="bj-lock-input-wrap">
          <input class="tl-pw-input" id="bj-lock-pw" type="password" placeholder="• • • •" autocomplete="current-password" />
          <div class="tl-err" id="bj-lock-err"></div>
          <div class="tl-row" id="bj-lock-row">
            <button class="tl-btn ghost" id="bj-lock-cancel">Cancel</button>
            <button class="tl-btn" id="bj-lock-submit">Unlock</button>
          </div>
        </div>
        <button class="tl-forgot" id="bj-lock-forgot">Forgot password?</button>
        <button class="tl-forgot" id="bj-lock-reset" style="margin-top:4px;">Reset password via email</button>
      </div>
    </div>

    <div id="bj-empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      <h2>No Entry Selected</h2>
      <p>Create a new entry to start brainstorming, or select one from the sidebar.</p>
      <span class="empty-hint">Click "New Entry" to get started</span>
    </div>

    <!-- WHITEBOARD — Excalidraw, wired by VizEngine (Notebook/core/viz.js).
         The shell keeps its old id so showTemplate() and the lock/edit-mode
         plumbing that reference it are untouched; everything inside it is new. -->
    <div id="bj-wb-canvas-wrap" class="viz-shell">
      <div class="viz-mount" id="bj-wb-mount"></div>
    </div>

    <!-- NOTES -->
    <div id="bj-notes-area">
      <div class="bj-drop-zone" id="bj-notes-drop-zone"><div class="bj-drop-label"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>Drop files here</div></div>
      <div class="bj-attach-bar" id="bj-notes-attach-bar">
        <button class="bj-attach-btn" id="bj-notes-attach-btn" title="Attach files"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11 12.3 20a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.9-2.9l8.5-8.5"/></svg><span>Attach Files</span><input type="file" id="bj-notes-attach-input" multiple accept="*/*" style="position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0;"></button>
        <div class="bj-attach-chips" id="bj-notes-attach-chips"></div>
      </div>
      <div class="notes-section">
        <div class="notes-section-header">Main Ideas</div>
        <textarea class="notes-text" id="bj-notes-main" placeholder="Write your main ideas here…" rows="5"></textarea>
      </div>
      <div class="notes-section">
        <div class="notes-section-header">Connections &amp; Links</div>
        <textarea class="notes-text" id="bj-notes-links" placeholder="How do these ideas connect?…" rows="4"></textarea>
      </div>
      <div class="notes-section">
        <div class="notes-section-header">Questions &amp; Next Steps</div>
        <textarea class="notes-text" id="bj-notes-questions" placeholder="Open questions and next actions…" rows="4"></textarea>
      </div>
      <div class="bj-attach-images" id="bj-notes-attach-images"></div>
    </div>

    <!-- CORNELL -->
    <div id="bj-cornell-area">
      <div class="bj-drop-zone" id="bj-cornell-drop-zone"><div class="bj-drop-label"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>Drop files here</div></div>
      <div class="bj-attach-bar" id="bj-cornell-attach-bar">
        <button class="bj-attach-btn" id="bj-cornell-attach-btn" title="Attach files"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11 12.3 20a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.9-2.9l8.5-8.5"/></svg><span>Attach Files</span><input type="file" id="bj-cornell-attach-input" multiple accept="*/*" style="position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0;"></button>
        <div class="bj-attach-chips" id="bj-cornell-attach-chips"></div>
      </div>
      <div class="bj-attach-images" id="bj-cornell-attach-images"></div>
      <div class="cornell-grid">
        <div class="cornell-topic">
          <input type="text" id="bj-cornell-topic" placeholder="Topic / Subject…" />
        </div>
        <div class="cornell-cues">
          <span class="section-label">Cue Column</span>
          <textarea class="cornell-ta" id="bj-cornell-cues-ta" placeholder="Key terms, questions, prompts…" style="min-height:300px;"></textarea>
        </div>
        <div class="cornell-notes">
          <span class="section-label">Notes Column</span>
          <textarea class="cornell-ta" id="bj-cornell-notes-ta" placeholder="Main content, details, facts…" style="min-height:300px;"></textarea>
        </div>
        <div class="cornell-summary">
          <span class="section-label">Summary</span>
          <textarea class="cornell-ta" id="bj-cornell-summary-ta" placeholder="Summarize the key ideas in 2–3 sentences…" rows="3"></textarea>
        </div>
      </div>
    </div>

    <!-- MIND MAP — Mind Elixir. The attach bar and drop zone are kept as they
         were: existing entries have file attachments hanging off them. -->
    <div id="bj-mindmap-area" class="viz-shell">
      <div class="bj-drop-zone" id="bj-mm-drop-zone"><div class="bj-drop-label"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>Drop files here</div></div>
      <div class="bj-attach-bar" id="bj-mm-attach-bar">
        <button class="bj-attach-btn" id="bj-mm-attach-btn" title="Attach files"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11 12.3 20a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.9-2.9l8.5-8.5"/></svg><span>Attach Files</span><input type="file" id="bj-mm-attach-input" multiple accept="*/*" style="position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0;"></button>
        <div class="bj-attach-chips" id="bj-mm-attach-chips"></div>
      </div>
      <div class="bj-attach-images" id="bj-mm-attach-images"></div>
      <div class="viz-mount" id="bj-mm-mount"></div>
    </div>

    <!-- MIND MAP LEGACY — the original canvas mind map, restored verbatim.
         Every mind map made before the Mind Elixir rebuild opens here (see
         _bjLegacyTemplate), so nothing that existed has changed hands. -->
    <div id="bj-mml-area">
      <div class="bj-drop-zone" id="bj-mml-drop-zone"><div class="bj-drop-label"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>Drop files here</div></div>
      <div class="bj-attach-bar" id="bj-mml-attach-bar">
        <button class="bj-attach-btn" id="bj-mml-attach-btn" title="Attach files"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11 12.3 20a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.9-2.9l8.5-8.5"/></svg><span>Attach Files</span><input type="file" id="bj-mml-attach-input" multiple accept="*/*" style="position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0;"></button>
        <div class="bj-attach-chips" id="bj-mml-attach-chips"></div>
      </div>
      <div class="bj-attach-images" id="bj-mml-attach-images"></div>
      <div id="bj-mml-toolbar">
          <button class="wb-btn" id="bj-mml-add-node"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg><span>Add Node</span></button>
          <button class="wb-btn" id="bj-mml-connect-mode"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="12" r="2.5"/><path d="M7.5 12h9"/></svg><span>Connect</span></button>
          <button class="wb-btn" id="bj-mml-delete-node"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg><span>Delete</span></button>
          <div class="mml-action-sep"></div>
          <div class="mml-palette-sep"></div>
          <span class="mml-palette-label">Color</span>
          <div class="mml-color-btn active" data-fill="#26272A" data-stroke="#4A4B51" style="background:#4A4B51;" title="Default"></div>
          <div class="mml-color-btn" data-fill="#2E2535" data-stroke="#8D769A" style="background:#8D769A;" title="Purple"></div>
          <div class="mml-color-btn" data-fill="#1a3a2a" data-stroke="#5DAF6D" style="background:#5DAF6D;" title="Green"></div>
          <div class="mml-color-btn" data-fill="#0d2a35" data-stroke="#22d3ee" style="background:#22d3ee;" title="Cyan"></div>
          <div class="mml-color-btn" data-fill="#3a1f1a" data-stroke="#E74C3C" style="background:#E74C3C;" title="Red"></div>
          <div class="mml-color-btn" data-fill="#2d1f0a" data-stroke="#fb923c" style="background:#fb923c;" title="Orange"></div>
          <div class="mml-color-btn" data-fill="#2a2510" data-stroke="#e5c84a" style="background:#e5c84a;" title="Yellow"></div>
          <div class="mml-color-btn" data-fill="#1a2035" data-stroke="#6da8f5" style="background:#6da8f5;" title="Blue"></div>
          <span class="mml-hint">Dbl-click to rename · Drag to move</span>
          <div style="flex:1"></div>
          <button class="wb-btn" id="bj-mml-img-btn" title="Add image to selected node" style="position:relative;overflow:hidden;"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg><span>Image</span><input type="file" id="bj-mml-img-file" accept="image/*" style="position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0;"></button>
          <button class="wb-btn" id="bj-mml-reset"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg><span>Reset</span></button>
        </div>
      <div id="bj-mml-canvas-wrap">
        <canvas id="bj-mml-canvas" height="480"></canvas>
        <textarea id="bj-mml-node-input" placeholder="Node label…" rows="1"></textarea>
      </div>
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
        <input type="color" class="docx-r1" id="bj-page-color-pick" value="#ECECEE" title="Text color">
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
        <button class="pt-btn" id="bj-pt-md" title="Render Markdown — convert raw Markdown into formatted text" style="font-weight:700;font-size:11px;">Render Markdown</button>
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
      <div class="template-card" data-template="whiteboard">
        <div class="template-card-icon"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19H5a2 2 0 0 1 0-4h5a2 2 0 0 0 0-4H7"/><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L15 12l-4 1 1-4Z"/></svg></div>
        <h3>Whiteboard</h3>
        <p>Free-draw canvas with pen, shapes, text and undo.</p>
      </div>
      <div class="template-card" data-template="notes">
        <div class="template-card-icon"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v12l-4 4H4Z"/><path d="M20 16h-4v4"/><path d="M8 9h8"/><path d="M8 13h5"/></svg></div>
        <h3>Structured Notes</h3>
        <p>Three sections: ideas, connections, next steps.</p>
      </div>
      <div class="template-card" data-template="cornell">
        <div class="template-card-icon"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4" width="12" height="18" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 11h6"/><path d="M9 15h4"/></svg></div>
        <h3>Cornell Notes</h3>
        <p>Classic format: cues, notes, and summary.</p>
      </div>
      <div class="template-card" data-template="mindmap">
        <div class="template-card-icon"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5a3 3 0 0 0-6 0 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1Z"/><path d="M12 5a3 3 0 0 1 6 0 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1Z"/></svg></div>
        <h3>Mind Map</h3>
        <p>Visual node-based map for exploring ideas.</p>
      </div>
      <div class="template-card" data-template="mindmap-legacy">
        <div class="template-card-icon"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="m9.9 9.9-3-3"/><path d="m14.1 9.9 3-3"/><path d="m9.9 14.1-3 3"/><path d="m14.1 14.1 3 3"/></svg></div>
        <h3>Mind Map Legacy</h3>
        <p>The original free-placement canvas: drag nodes anywhere, connect any two.</p>
      </div>
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
  <button id="bj-bb-template" style="flex:1;background:transparent;color:var(--text2);border:1px solid var(--border2);border-radius:5px;padding:7px 0;font-size:10px;font-weight:700;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:1px;cursor:pointer;touch-action:manipulation;"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18"/><path d="M12 3v18"/></svg><span>Template</span></button>
  <button id="bj-bb-new" style="flex:2;background:var(--purple);color:#fff;border:none;border-radius:5px;padding:7px 0;font-size:10px;font-weight:700;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:1px;cursor:pointer;touch-action:manipulation;">+ New</button>
  <span id="bj-bb-saved" style="font-size:10px;color:var(--green);font-family:'IBM Plex Mono',monospace;font-weight:700;opacity:0;transition:opacity 0.4s;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;"><svg class="bji" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></span>
</div>
</div>
`;
if (me && me.parentNode) me.insertAdjacentHTML('beforebegin', html);
else document.body.insertAdjacentHTML('beforeend', html);
})();

(function(){
'use strict';
const STORAGE_KEY = 'brainstorm_journal_v3';
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
  pill.className = 'bj-sync-pill bj-sync-' + status;
  var labels = { idle:'Saved', syncing:'Saving…', synced:'Synced', error:'Sync Failed' };
  txt.textContent = labels[status] || status;
  // Bottom bar indicator on mobile
  if (bb) {
    if (status === 'syncing') { bb.innerHTML = window.TNI.arrowUp + '<span>Syncing…</span>'; bb.style.color = 'var(--cyan)'; bb.style.opacity = '1'; }
    else if (status === 'synced') { bb.innerHTML = window.TNI.check + '<span>Synced</span>'; bb.style.color = 'var(--green)'; bb.style.opacity = '1'; clearTimeout(bb._t); bb._t = setTimeout(() => { bb.style.opacity='0'; }, 3000); }
    else if (status === 'error') { bb.innerHTML = window.TNI.alert + '<span>Failed</span>'; bb.style.color = 'var(--red)'; bb.style.opacity = '1'; }
    else { bb.style.opacity = '0'; }
  }
  // Auto-reset synced → idle after 4s
  if (status === 'synced') {
    clearTimeout(_bjSyncResetTimer);
    _bjSyncResetTimer = setTimeout(() => _bjSetSync('idle'), 4000);
  }
}
var _bjSyncResetTimer = null;

/* Every mind map that existed before the Mind Elixir rebuild belongs to the
 * LEGACY template, and this is what sends it there.
 *
 * The test is the data itself, not a flag or a date: an entry saved as
 * 'mindmap' whose data still carries the old free-placement node list was made
 * by the old editor, so that is the editor that opens it. A mind map created
 * since the rebuild has no `nodes` array at all — its content lives in its own
 * document — so it is left alone and opens in Mind Elixir.
 *
 * Nothing is written and nothing is converted. The entry's own bytes
 * (data.nodes / data.edges, including any node images) are untouched; only the
 * template it is routed to changes, and it changes the same way on every device
 * because every device applies this same rule to the same data. If the entry is
 * later edited the new id persists naturally, and if it never is, nothing about
 * it was ever rewritten. */
function _bjLegacyTemplate(entry) {
  if (!entry || entry.template !== 'mindmap') return;
  const d = entry.data;
  if (d && Array.isArray(d.nodes) && d.nodes.length) entry.template = 'mindmap-legacy';
}

/* ── Legacy whiteboard PNGs live in IndexedDB, not localStorage ─────────────
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
    _bjLegacyTemplate(entry);
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
    if (activeEntry.template === 'notes') {
      var _m = document.getElementById('bj-notes-main');
      var _l = document.getElementById('bj-notes-links');
      var _q = document.getElementById('bj-notes-questions');
      if (_m && _fa === _m) activeEntry.data.main      = _m.value;
      if (_l && _fa === _l) activeEntry.data.links     = _l.value;
      if (_q && _fa === _q) activeEntry.data.questions = _q.value;
    } else if (activeEntry.template === 'cornell') {
      var _ct = document.getElementById('bj-cornell-topic');
      var _cc = document.getElementById('bj-cornell-cues-ta');
      var _cn = document.getElementById('bj-cornell-notes-ta');
      var _cs = document.getElementById('bj-cornell-summary-ta');
      if (_ct && _fa === _ct) activeEntry.data.topic   = _ct.value;
      if (_cc && _fa === _cc) activeEntry.data.cues    = _cc.value;
      if (_cn && _fa === _cn) activeEntry.data.notes   = _cn.value;
      if (_cs && _fa === _cs) activeEntry.data.summary = _cs.value;
    } else if (activeEntry.template === 'page') {
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
    // A mind map arriving from another device gets routed the same way one read
    // from the local cache does — see _bjLegacyTemplate.
    _bjLegacyTemplate(remoteEntry);
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
    if (remoteEntry.template === 'notes') {
      var mainEl  = document.getElementById('bj-notes-main');
      var linksEl = document.getElementById('bj-notes-links');
      var questEl = document.getElementById('bj-notes-questions');
      var titleEl = document.getElementById('bj-entry-title-input');
      var newData = Object.assign({}, local.data);
      var newTitle = local.title;
      if (!_bjBusy(titleEl) && remoteEntry.title !== undefined) { newTitle = remoteEntry.title; if (titleEl) titleEl.value = newTitle; }
      if (!_bjBusy(mainEl)  && remoteEntry.data && remoteEntry.data.main      !== undefined) { newData.main      = remoteEntry.data.main;      if (mainEl)  mainEl.value  = newData.main; }
      if (!_bjBusy(linksEl) && remoteEntry.data && remoteEntry.data.links     !== undefined) { newData.links     = remoteEntry.data.links;     if (linksEl) linksEl.value = newData.links; }
      if (!_bjBusy(questEl) && remoteEntry.data && remoteEntry.data.questions !== undefined) { newData.questions = remoteEntry.data.questions; if (questEl) questEl.value = newData.questions; }
      localById[remoteEntry.id] = Object.assign({}, remoteEntry, { title: newTitle, data: newData });
    } else if (remoteEntry.template === 'cornell') {
      var topicEl   = document.getElementById('bj-cornell-topic');
      var cuesEl    = document.getElementById('bj-cornell-cues-ta');
      var notesEl   = document.getElementById('bj-cornell-notes-ta');
      var summaryEl = document.getElementById('bj-cornell-summary-ta');
      var titleElC  = document.getElementById('bj-entry-title-input');
      var newDataC = Object.assign({}, local.data);
      var newTitleC = local.title;
      if (!_bjBusy(titleElC)  && remoteEntry.title !== undefined)                             { newTitleC = remoteEntry.title;              if (titleElC)  titleElC.value  = newTitleC; }
      if (!_bjBusy(topicEl)   && remoteEntry.data && remoteEntry.data.topic   !== undefined) { newDataC.topic   = remoteEntry.data.topic;   if (topicEl)   topicEl.value   = newDataC.topic; }
      if (!_bjBusy(cuesEl)    && remoteEntry.data && remoteEntry.data.cues    !== undefined) { newDataC.cues    = remoteEntry.data.cues;    if (cuesEl)    cuesEl.value    = newDataC.cues; }
      if (!_bjBusy(notesEl)   && remoteEntry.data && remoteEntry.data.notes   !== undefined) { newDataC.notes   = remoteEntry.data.notes;   if (notesEl)   notesEl.value   = newDataC.notes; }
      if (!_bjBusy(summaryEl) && remoteEntry.data && remoteEntry.data.summary !== undefined) { newDataC.summary = remoteEntry.data.summary; if (summaryEl) summaryEl.value = newDataC.summary; }
      localById[remoteEntry.id] = Object.assign({}, remoteEntry, { title: newTitleC, data: newDataC });
    } else if (remoteEntry.template === 'page') {
      var pageEd = document.getElementById('bj-page-editor');
      var userInEditor = _bjBusy(pageEd);
      if (!userInEditor) {
        // Apply remote HTML, rehydrate images if needed
        localById[remoteEntry.id] = remoteEntry;
        var remoteHtml = remoteEntry.data && remoteEntry.data.html || '';
        if (pageEd) {
          if (remoteHtml.includes('bj-fbimg://') && window._fbRehydratePageImages) {
            window._fbRehydratePageImages(remoteHtml).then(function(rehydrated) {
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
  if (_bjActiveGone || _bjActiveTrashed) {
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
      _bjFbSaveEntry(e);
    });
  }

  // NEVER override local activeId — each device stays on its own entry
  _bjWriteCache();
  renderSidebar();
  // Re-run the lock check so an entry deleted (or unlocked) on another device
  // can't leave a lock overlay stranded over a document that no longer exists.
  if (window._bjLockCheck && !_bjHidden) window._bjLockCheck();
  if (_activeWasUpdated) { var _ae = getActive(); if (_ae && (_ae.template === 'mindmap' || _ae.template === 'mindmap-legacy')) loadActiveEntry(); }
}

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
window.addEventListener('fb-bj-canvas-saved', function() { _bjSetSync('synced'); });
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
  if (window._fbResyncJournal) window._fbResyncJournal();
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
  const entry = { id, title: '', template: template || 'notes', created: Date.now(), updated: Date.now(), tags: [], data: {} };
  if (template === 'whiteboard') entry.data = { attachments: [] };
  if (template === 'notes') entry.data = { main: '', links: '', questions: '', attachments: [] };
  if (template === 'cornell') entry.data = { topic: '', cues: '', notes: '', summary: '', attachments: [] };
  if (template === 'mindmap') entry.data = { attachments: [] };
  if (template === 'mindmap-legacy') entry.data = { nodes: [{ id: 1, x: 340, y: 220, label: 'Central Idea', root: true }], edges: [], attachments: [] };
  if (template === 'page') entry.data = { html: '', attachments: [] };
  // Unsynced until the cloud confirms it — without this an authoritative resync
  // arriving in the next second would prune an entry the server has never seen.
  entry._dirty = true;
  // A shared entry records who made it (Veda, from here) and opens its live document.
  if (_bjIsOJ() && window.OJ) window.OJ.created('bj', entry);
  state.entries.unshift(entry);
  state.activeId = id;
  return entry;
}

// ── TRASH SYSTEM: delete = move to Trash (30 days), synced via entry.trashed ──
const BJ_TRASH_TTL = 30 * 24 * 60 * 60 * 1000;
function deleteEntry(id) {
  const entry = state.entries.find(e => e.id === id);
  if (!entry) return;
  var _bjDelTs = Date.now();
  entry.trashed = _bjDelTs;
  entry.trashChangedAt = _bjDelTs;   // trash-action clock (drives cross-device delete sync)
  entry.updated = _bjDelTs;
  if (state.activeId === id) state.activeId = (state.entries.find(e => !e.trashed) || {}).id || null;
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
    try {
      localStorage.removeItem('bj_unlocked_' + id);
      localStorage.removeItem('bj_unlockedv_' + id);
      localStorage.removeItem('bj_unlockedat_' + id);
      sessionStorage.removeItem('bj_unlocked_' + id);
      sessionStorage.removeItem('bj_unlockedv_' + id);
      sessionStorage.removeItem('bj_unlockedat_' + id);
    } catch (e) {}
    _bjCanvasDel(id);
  });
  // Keep the tombstone list from growing without bound across years of use.
  if (state.deletedIds.length > 500) state.deletedIds = state.deletedIds.slice(-500);
}
// Permanent delete — used by the Trash UI and the 30-day auto-purge
function hardDeleteEntry(id) {
  _bjForgetDeleted([id]);
  _bjFbDelete(id);
  state.entries = state.entries.filter(e => e.id !== id);
  if (state.activeId === id) state.activeId = (state.entries.find(e => !e.trashed) || {}).id || null;
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
  list: () => state.entries.filter(e => e.trashed).sort((a,b) => (b.trashed||0)-(a.trashed||0)),
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
window._bjGetPageMargins = function() {
  const e = state.entries.find(x => x.id === state.activeId);
  if (e && e.template === 'page' && e.data && e.data.margins && typeof e.data.margins.ml === 'number') return e.data.margins;
  return null;
};
window._bjSetPageMargins = function(m) {
  const e = state.entries.find(x => x.id === state.activeId);
  if (e && e.template === 'page') { e.data.margins = m; e.updated = Date.now(); autoSave(); }
};

// ── UNIFIED SEARCH: title + full content + tags; multi-tag filter ──
let bjTagFilters = [];
function _bjEntryText(e) {
  const d = e.data || {};
  const parts = [e.title || '', (e.tags||[]).join(' ')];
  ['main','links','questions','topic','cues','notes','summary'].forEach(k => { if (d[k]) parts.push(d[k]); });
  if (d.html) parts.push(String(d.html).replace(/<[^>]*>/g, ' '));
  if (d.dates) Object.values(d.dates).forEach(dd => { if (dd && dd.html) parts.push(String(dd.html).replace(/<[^>]*>/g, ' ')); });
  if (d.nodes) d.nodes.forEach(n => parts.push(n.label || ''));
  return parts.join(' ').toLowerCase();
}
function _bjHlTitle(text, q) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0,i)) + '<mark class="docx-hl">' + esc(text.slice(i, i+q.length)) + '</mark>' + esc(text.slice(i+q.length));
}
function _bjRenderTagChips(live) {
  let row = document.getElementById('bj-tagfilter-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'bj-tagfilter-row';
    row.className = 'docx-tagchips';
    const listEl = document.getElementById('bj-entries-list');
    listEl.parentNode.insertBefore(row, listEl);
  }
  const all = [...new Set(live.reduce((a,e) => a.concat(e.tags||[]), []))].sort((a,b)=>a.localeCompare(b));
  bjTagFilters = bjTagFilters.filter(t => all.includes(t));
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
    chip.className = 'docx-tagchip' + (bjTagFilters.includes(tag) ? ' on' : '');
    chip.textContent = tag;
    chip.title = tag;
    chip.onclick = () => {
      bjTagFilters = bjTagFilters.includes(tag) ? bjTagFilters.filter(t => t !== tag) : bjTagFilters.concat(tag);
      renderSidebar();
    };
    row.appendChild(chip);
  });
}
function _bjRenderTrashBtn() {
  let btn = document.getElementById('bj-trash-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'bj-trash-btn';
    btn.className = 'docx-trash-btn';
    btn.onclick = () => { if (window._docxOpenTrash) window._docxOpenTrash('bj'); };
    const stats = document.getElementById('bj-sidebar-stats');
    if (stats && stats.parentNode) stats.parentNode.insertBefore(btn, stats);
  }
  const n = state.entries.filter(e => e.trashed).length;
  btn.innerHTML = window.TNI.trash + '<span>Trash</span>' + (n ? ' <span class="docx-trash-count">' + n + '</span>' : '');
}

function renderSidebar() {
  if (_bjHidden) return;
  const list = document.getElementById('bj-entries-list');
  const search = document.getElementById('bj-search-box').value.toLowerCase().trim();
  const live = state.entries.filter(e => !e.trashed);
  const entries = live.filter(e => {
    // Locked entries: search title/tags only (never their hidden content)
    const isLocked = window._bjGetLock && window._bjGetLock(e.id) && !(window._bjIsUnlocked && window._bjIsUnlocked(e.id));
    const hay = isLocked ? ((e.title||'') + ' ' + (e.tags||[]).join(' ')).toLowerCase() : _bjEntryText(e);
    return (!search || hay.includes(search)) &&
           (bjTagFilters.length === 0 || bjTagFilters.every(t => (e.tags||[]).includes(t)));
  });
  list.innerHTML = '';
  if (entries.length === 0) {
    list.innerHTML = `<div class="list-empty">${search || bjTagFilters.length ? 'No entries match your search.' : (_bjIsOJ() ? 'Nothing shared yet.<br>Anything created here is visible to Tony and Veda.' : 'No entries yet.<br>Click "New Entry" to begin.')}</div>`;
  }
  const isDraggable = !search && bjTagFilters.length === 0;
  let dragSrcId = null;

  entries.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'entry-item' + (entry.id === state.activeId ? ' active' : '');
    div.dataset.entryId = entry.id;
    if (isDraggable) div.draggable = true;
    const tmap = { whiteboard: 'BOARD', notes: 'NOTES', cornell: 'CORNELL', mindmap: 'MAP', 'mindmap-legacy': 'MAP', page: 'PAGE', 'journal-entries': 'JOURNAL' };
    const date = new Date(entry.updated).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const titleClass = entry.title ? '' : ' untitled';
    div.innerHTML = `
      ${isDraggable ? `<div class="entry-drag-handle" title="Drag to reorder"><span></span><span></span><span></span></div>` : ''}
      <div class="entry-item-title${titleClass}">${_bjHlTitle(entry.title || 'Untitled', search)}</div>
      <div class="entry-item-meta">
        <span class="template-badge">${tmap[entry.template]||'NOTE'}</span>
        <span>${date}</span>
        ${(entry.tags||[]).length ? `<span>· ${entry.tags.slice(0,2).join(', ')}${entry.tags.length > 2 ? '…' : ''}</span>` : ''}
        ${_bjIsOJ() && entry.creator && window.OJ ? `<span class="oj-by oj-by-${entry.creator}" title="Created by ${window.OJ.name(entry.creator)}">${window.OJ.name(entry.creator)}</span>` : ''}
      </div>
      <button class="entry-delete" data-id="${entry.id}" title="Move to Trash" aria-label="Move to Trash">${window.TNI.x}</button>
    `;
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
      // If entry is locked, require password before deleting. The lock helpers
      // live inside the lock code below; it hands them out through _bjLock.
      var lock = entry.lock;
      if (lock) {
        if (!_bjLock.isUnlocked(entry.id)) {
          var pw = await window.uiPrompt('This entry is locked. Enter password to delete:', {title:'Locked entry', password:true});
          if (pw === null) return;
          try {
            var data = await _bjLock.post('/auth/journal/verify', { journal: 'bj', entryId: entry.id, password: pw });
            if (!data.ok) { await window.uiAlert('Incorrect password. Entry not deleted.'); return; }
            if (await window.uiConfirm('Delete "' + (entry.title || 'Untitled') + '"?', {danger:true, okLabel:'Delete'})) {
              await _bjLock.post('/auth/journal/remove-lock', { journal: 'bj', entryId: entry.id, password: pw }).catch(function(){});
              deleteEntry(entry.id);
            }
          } catch(e) { await window.uiAlert(_bjLock.errText(e)); }
          return;
        }
      }
      if (await window.uiConfirm(`Delete "${entry.title || 'Untitled'}"?`, {danger:true, okLabel:'Delete'})) deleteEntry(entry.id);
    });
    if (isDraggable) {
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
        saveState(); renderSidebar();
      });
      // Touch drag for mobile
      const bjHandle = div.querySelector('.entry-drag-handle');
      if (bjHandle && window._attachJournalTouchDrag) {
        window._attachJournalTouchDrag(bjHandle, div, entry, list, state, 'bj-drag-over', 'bj-dragging', () => { saveState(); renderSidebar(); _bjFbOrder(); });
      }
    }
    list.appendChild(div);
  });
  const ec = document.getElementById('bj-entry-count');
  if (ec) ec.textContent = live.length;
  _bjRenderTagChips(live);
  _bjRenderTrashBtn();
}

function showTemplate(name) {
  // Leaving a board flushes it and drops its remote listener. Doing it here
  // rather than in loadActiveEntry covers every exit: another template, another
  // entry, the empty state, and the lock screen.
  if (name !== 'whiteboard' && _bjBoards.wb) _bjBoards.wb.close();
  if (name !== 'mindmap'    && _bjBoards.mm) _bjBoards.mm.close();
  document.getElementById('bj-wb-canvas-wrap').style.display = name === 'whiteboard' ? 'flex' : 'none';
  document.getElementById('bj-notes-area').style.display = name === 'notes' ? 'flex' : 'none';
  document.getElementById('bj-cornell-area').style.display = name === 'cornell' ? 'flex' : 'none';
  document.getElementById('bj-mindmap-area').style.display = name === 'mindmap' ? 'flex' : 'none';
  document.getElementById('bj-mml-area').style.display = name === 'mindmap-legacy' ? 'flex' : 'none';
  document.getElementById('bj-page-area').style.display = name === 'page' ? 'flex' : 'none';
  document.getElementById('bj-empty-state').style.display = name ? 'none' : 'flex';
  document.getElementById('bj-tags-row').style.display = name ? 'flex' : 'none';
  // Page toolbar edit-mode sync
  const pt = document.getElementById('bj-page-toolbar');
  if (pt) { if (name === 'page' && isEditMode) pt.classList.add('edit-mode'); else pt.classList.remove('edit-mode'); }
  // Attach bars for notes/cornell/mindmap
  if (window._bjRefreshAttachBars) _bjRefreshAttachBars(name, isEditMode);
}

function loadActiveEntry() {
  if (_bjHidden) return;
  const entry = getActive();
  // Nothing painted for any entry yet — see _bjDomOwner. Cleared BEFORE the early
  // returns below, so the blank editor they leave behind can never be read back as
  // an entry's new content.
  _bjDomOwner = null;
  if (!entry) { document.getElementById('bj-entry-title-input').value = ''; showTemplate(null); renderTags([]); if (_bjIsOJ() && window.OJ) window.OJ.painted('bj', null); return; }
  // A shared entry's content is fetched on first open (only the index is kept
  // live for the whole list). The engine calls back here once it has it.
  if (_bjIsOJ() && window.OJ && !window.OJ.isLoaded(entry)) {
    document.getElementById('bj-entry-title-input').value = entry.title || '';
    showTemplate(null); renderTags(entry.tags || []);
    window.OJ.open('bj', entry);
    return;
  }
  // Lock guard: if entry is locked and not yet unlocked this session, show lock screen — no content
  if (window._bjGetLock && window._bjGetLock(entry.id) && !(window._bjIsUnlocked && window._bjIsUnlocked(entry.id))) {
    document.getElementById('bj-entry-title-input').value = '';
    showTemplate(null);
    renderTags([]);
    if (window._bjLockCheck) window._bjLockCheck();
    return;
  }
  // An entry that has come back empty while a local copy of its content survives is
  // healed here, before it is painted — otherwise the blank paint is what the next
  // save would publish. Only ever fills an EMPTY entry. See JGuard.recover.
  if (window.JGuard && window.JGuard.recover('bj', entry)) { entry.updated = Date.now(); _bjWriteCache(); }
  document.getElementById('bj-entry-title-input').value = entry.title;
  showTemplate(entry.template);
  renderTags(entry.tags || []);
  if (entry.template === 'whiteboard') {
    _bjBoard('wb').open(entry).then(function () { _bjBoard('wb').setEditable(isEditMode); });
  }
  if (entry.template === 'notes') {
    document.getElementById('bj-notes-main').value = entry.data.main || '';
    document.getElementById('bj-notes-links').value = entry.data.links || '';
    document.getElementById('bj-notes-questions').value = entry.data.questions || '';
    if (window._bjRenderAttachments) _bjRenderAttachments('notes');
  }
  if (entry.template === 'cornell') {
    document.getElementById('bj-cornell-topic').value = entry.data.topic || '';
    document.getElementById('bj-cornell-cues-ta').value = entry.data.cues || '';
    document.getElementById('bj-cornell-notes-ta').value = entry.data.notes || '';
    document.getElementById('bj-cornell-summary-ta').value = entry.data.summary || '';
    if (window._bjRenderAttachments) _bjRenderAttachments('cornell');
  }
  if (entry.template === 'mindmap') {
    _bjBoard('mm').open(entry).then(function () { _bjBoard('mm').setEditable(isEditMode); });
    if (window._bjRenderAttachments) _bjRenderAttachments('mindmap');
  }
  if (entry.template === 'mindmap-legacy') {
    mmNodes = JSON.parse(JSON.stringify(entry.data.nodes || [{ id:1, x:340, y:220, label:'Central Idea', root:true }]));
    mmEdges = JSON.parse(JSON.stringify(entry.data.edges || []));
    initMindmap(); renderMindmap();
    if (window._bjRenderAttachments) _bjRenderAttachments('mindmap-legacy');
  }
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
          ed.innerHTML = rehydrated;
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
  // Visual templates keep their content in their own document (see VizEngine),
  // so what lands on the ENTRY is a fingerprint: the board's revision, how much
  // is on it, and a title to fall back on. That is enough for the sidebar, the
  // auto-title, the no-op guard and the remote merge — and it keeps a drawing
  // out of the journal document, which has one 1 MiB budget for every entry.
  if (entry.template === 'whiteboard' || entry.template === 'mindmap') {
    var _vb = _bjBoards[entry.template === 'whiteboard' ? 'wb' : 'mm'];
    var _vs = (_vb && _vb.isOpen(entry.id)) ? _vb.stats() : null;
    if (_vs) { _next.vizRev = _vs.rev; _next.vizCount = _vs.count; _next.vizTitle = _vs.title; }
  }
  if (entry.template === 'notes') {
    _next.main = document.getElementById('bj-notes-main').value;
    _next.links = document.getElementById('bj-notes-links').value;
    _next.questions = document.getElementById('bj-notes-questions').value;
  }
  if (entry.template === 'cornell') {
    _next.topic = document.getElementById('bj-cornell-topic').value;
    _next.cues = document.getElementById('bj-cornell-cues-ta').value;
    _next.notes = document.getElementById('bj-cornell-notes-ta').value;
    _next.summary = document.getElementById('bj-cornell-summary-ta').value;
  }
  // COPIED, not handed over. Object.assign below puts whatever is in _next onto
  // entry.data, so passing the live arrays would make entry.data.nodes and
  // mmNodes the same object from the first save onwards — and the no-op guard
  // further down, which asks whether entry.data differs from _next, would be
  // comparing an array to itself and answering "nothing changed" forever. The
  // symptom is precise and easy to miss: the first edit to a map saves, and
  // every later drag only persists if some unrelated saveState() happens to run.
  if (entry.template === 'mindmap-legacy') {
    _next.nodes = JSON.parse(JSON.stringify(mmNodes));
    _next.edges = JSON.parse(JSON.stringify(mmEdges));
  }
  if (entry.template === 'page') { _next.html = document.getElementById('bj-page-editor').innerHTML; }

  // Auto-title: derive from content while the title is empty; a user-typed title
  // always wins. Read from the PROPOSED data above, not the stored data — otherwise a title taken from the
  // editor is always one save out of date, which is how a whiteboard whose first
  // text says "Launch plan" stayed "Untitled".
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
function _bjAutoTitle(entry, dataOverride) {
  const d = dataOverride || entry.data || {};
  let src = '';
  if (entry.template === 'page') { const ed = document.getElementById('bj-page-editor'); src = ed && ed.innerText ? ed.innerText : String(d.html||'').replace(/<[^>]*>/g,'\n'); }
  else if (entry.template === 'notes') src = d.main || d.links || d.questions || '';
  else if (entry.template === 'cornell') src = d.topic || d.notes || d.cues || '';
  else if (entry.template === 'mindmap-legacy') { const root = (d.nodes||[]).find(n=>n.root) || (d.nodes||[])[0]; src = (root && root.label !== 'Central Idea') ? (root.label||'') : ''; }
  else if (entry.template === 'mindmap' || entry.template === 'whiteboard') {
    // The board reports its own title — the mind map's root topic, or the first
    // text on the canvas. Legacy mind maps fall back to their old root node.
    if (d.vizTitle) src = d.vizTitle;
    else if (entry.template === 'mindmap') { const root = (d.nodes||[]).find(n=>n.root) || (d.nodes||[])[0]; src = (root && root.label !== 'Central Idea') ? (root.label||'') : ''; }
  }
  const line = (src||'').split('\n').map(s=>s.trim()).find(s=>s.length > 1) || '';
  if (!line) return '';
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
}

/* TAGS */
function renderTags(tags) {
  const row = document.getElementById('bj-tags-row');
  row.querySelectorAll('.tag').forEach(t => t.remove());
  const input = document.getElementById('bj-add-tag-input');
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
document.getElementById('bj-add-tag-input').addEventListener('keydown', e => {
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
 * Both are VizEngine boards. Everything that used to live here — the 2D canvas,
 * the stroke smoother, the node hit-testing, the per-stroke PNG upload — is
 * gone; the engine above owns drawing, layout, persistence and export, and this
 * is only the wiring that gives it Veda's identity.
 * ======================================================================== */
var _bjBoards = {};
function _bjBoard(kind) {
  if (_bjBoards[kind]) return _bjBoards[kind];
  var isWb = kind === 'wb';
  _bjBoards[kind] = window.VizEngine.createBoard({
    kind: kind,
    app: 'bj',
    // dashboards/journal_viz_<id>, dashboards/journal_vizf_<hash> — alongside
    // the legacy journal_canvas_<id> documents, which are read but never written.
    prefix: 'journal',
    // A shared (OurJournal) entry's board lives in ourjournal_viz_<id> — the same
    // document MyJournal opens — and merges live with the other person's edits.
    prefixFor: function (e) { return (_bjOJState && _bjOJState.entries.indexOf(e) >= 0 && window.OJ) ? window.OJ.NS : 'journal'; },
    liveFor: function (e) { return !!(_bjOJState && _bjOJState.entries.indexOf(e) >= 0); },
    shell: document.getElementById(isWb ? 'bj-wb-canvas-wrap' : 'bj-mindmap-area'),
    mount: document.getElementById(isWb ? 'bj-wb-mount' : 'bj-mm-mount'),
    title: isWb ? 'Whiteboard' : 'Mind Map',
    setSync: function (s) { _bjSetSync(s); },
    entryTitle: function () { var e = getActive(); return (e && e.title) || 'Untitled Entry'; },
    // The board has committed a change locally; run the journal's own save so
    // the entry's fingerprint, title and its updated stamp follow it. Debounced by
    // autoSave, and only ever reached once per board write — never per stroke.
    onMeta: function () { autoSave(); },
    onPdf: function () { var e = getActive(); if (e) exportEntryAsPDF(e); }
  });
  return _bjBoards[kind];
}
window._bjFlushBoards = function () {
  return Promise.all(Object.keys(_bjBoards).map(function (k) { return _bjBoards[k].flush(); }));
};

/* ── MIND MAP LEGACY ───────────────────────────────────────────────────────
 * Veda's original canvas mind map, restored unchanged. It is a separate
 * template from the Mind Elixir one, not a fallback inside it: the two share no
 * state, no DOM and no document. Its content lives on the entry exactly where
 * it always did (data.nodes / data.edges), so every map that existed before the
 * rebuild still opens from the same bytes it was saved as.
 * ======================================================================== */
let mmCanvas, mmCtx, mmNodes=[], mmEdges=[], mmDragNode=null, mmDragOffset=null;
let mmConnectMode=false, mmConnectFrom=null, mmSelectedNode=null, mmEditingNode=null, mmNextId=10;
let mmNodeFill='#26272A', mmNodeStroke='#4A4B51';
let mmResizing=null;    // node resize: {node, handle, startX, startY, origW, origH, origX, origY}
let mmImgResizing=null; // image resize: {node, startX, startY, origW, origH}
var mmImgCache = {};

function initMindmap() {
  mmCanvas = document.getElementById('bj-mml-canvas');
  mmCtx = mmCanvas.getContext('2d');
  mmCanvas.width  = 1200;
  mmCanvas.height = 700;
}
/* Mindmap helpers */
function mmWrapText(ctx, text, maxWidth) {
  const hardLines = text.split('\n');
  const lines = [];
  for (const hard of hardLines) {
    if (hard === '') { lines.push(''); continue; }
    const words = hard.split(' ');
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = w; }
      else { cur = test; }
    }
    lines.push(cur);
  }
  return lines;
}
function mmNodeSize(ctx, node) {
  // If node has explicit w/h set, use those
  if (node.w && node.h) {
    const isRoot = node.root;
    const fontSize = isRoot ? 13 : 11;
    ctx.font = `${isRoot?'700 ':'500 '}${fontSize}px 'IBM Plex Mono', monospace`;
    const label = node.label || 'Node';
    const lines = mmWrapText(ctx, label, node.w - (isRoot?36:28));
    const LINE_H = fontSize + 4;
    const PAD_Y = isRoot ? 10 : 8;
    return { boxW: node.w, boxH: node.h, lines, fontSize, LINE_H, PAD_Y };
  }
  const isRoot = node.root;
  const fontSize = isRoot ? 13 : 11;
  ctx.font = `${isRoot?'700 ':'500 '}${fontSize}px 'IBM Plex Mono', monospace`;
  const label = node.label || 'Node';
  const MAX_W = node.imageData ? Math.max(160, (node.imgW||160)) : (isRoot ? 160 : 140);
  const PAD_X = isRoot ? 18 : 14;
  const PAD_Y = isRoot ? 10 : 8;
  const LINE_H = fontSize + 4;
  const singleW = ctx.measureText(label).width;
  let boxW, lines;
  if (singleW <= MAX_W) {
    boxW = Math.max(singleW + PAD_X*2, isRoot ? 90 : 70);
    lines = [label];
  } else {
    lines = mmWrapText(ctx, label, MAX_W);
    const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
    boxW = widest + PAD_X*2;
  }
  let boxH = lines.length * LINE_H + PAD_Y*2;
  // If node has image, expand to fit it
  if (node.imageData) {
    const imgW = node.imgW || 160;
    const imgH = node.imgH || 120;
    boxW = Math.max(boxW, imgW + PAD_X*2);
    boxH += imgH + 8;
  }
  return { boxW, boxH, lines, fontSize, LINE_H, PAD_Y };
}
function mmExpandCanvas() {
  if (!mmCanvas || !mmNodes.length) return;
  const PAD = 80;
  // Check if any node is too close to left or top edge — shift all nodes right/down
  let minX = Infinity, minY = Infinity;
  mmNodes.forEach(n => {
    const sz = mmCtx ? mmNodeSize(mmCtx, n) : {boxW:120, boxH:40};
    minX = Math.min(minX, n.x - sz.boxW/2);
    minY = Math.min(minY, n.y - sz.boxH/2);
  });
  if (minX < PAD || minY < PAD) {
    const shiftX = minX < PAD ? PAD - minX : 0;
    const shiftY = minY < PAD ? PAD - minY : 0;
    mmNodes.forEach(n => { n.x += shiftX; n.y += shiftY; });
    // Keep scroll position anchored so the view doesn't jump
    const wrap = document.getElementById('bj-mml-canvas-wrap');
    if (wrap) { wrap.scrollLeft += shiftX; wrap.scrollTop += shiftY; }
  }
  // Expand right and bottom as before
  let maxX = 1200, maxY = 700;
  mmNodes.forEach(n => {
    const sz = mmCtx ? mmNodeSize(mmCtx, n) : {boxW:120, boxH:40};
    maxX = Math.max(maxX, n.x + sz.boxW/2 + PAD);
    maxY = Math.max(maxY, n.y + sz.boxH/2 + PAD);
  });
  if (mmCanvas.width < maxX) mmCanvas.width = maxX;
  if (mmCanvas.height < maxY) mmCanvas.height = maxY;
}

// Get or create cached image for a node
function mmGetImg(node) {
  if (!node.imageData) return null;
  if (mmImgCache[node.id] && mmImgCache[node.id]._src === node.imageData) return mmImgCache[node.id];
  var img = new Image();
  img._src = node.imageData;
  img.onload = function() { mmImgCache[node.id] = img; renderMindmap(); };
  img.src = node.imageData;
  return null; // will trigger re-render when loaded
}

// Resize handle positions for a node (8 handles)
function mmGetHandles(node) {
  const {boxW, boxH} = mmNodeSize(mmCtx, node);
  const L = node.x - boxW/2, R = node.x + boxW/2;
  const T = node.y - boxH/2, B = node.y + boxH/2;
  const MX = node.x, MY = node.y;
  return [
    {id:'nw', x:L, y:T}, {id:'n',  x:MX, y:T}, {id:'ne', x:R, y:T},
    {id:'e',  x:R, y:MY},
    {id:'se', x:R, y:B}, {id:'s',  x:MX, y:B}, {id:'sw', x:L, y:B},
    {id:'w',  x:L, y:MY},
  ];
}

function renderMindmap() {
  if (!mmCtx) return;
  mmExpandCanvas();
  const ctx = mmCtx;
  ctx.clearRect(0,0,mmCanvas.width,mmCanvas.height);
  ctx.fillStyle='#1B1C1E'; ctx.fillRect(0,0,mmCanvas.width,mmCanvas.height);
  ctx.fillStyle='#3D3E4350';
  for (let x=24; x<mmCanvas.width; x+=28) for (let y=24; y<mmCanvas.height; y+=28) {
    ctx.beginPath(); ctx.arc(x,y,1.2,0,Math.PI*2); ctx.fill();
  }
  mmEdges.forEach(edge => {
    const a=mmNodes.find(n=>n.id===edge.from), b=mmNodes.find(n=>n.id===edge.to);
    if(!a||!b) return;
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2 - 30;
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.quadraticCurveTo(mx,my,b.x,b.y);
    let edgeColor = a.stroke || '#8D769A', edgeStroke;
    if (edgeColor.startsWith('#') && edgeColor.length===7) {
      const r=parseInt(edgeColor.slice(1,3),16),g=parseInt(edgeColor.slice(3,5),16),b2=parseInt(edgeColor.slice(5,7),16);
      edgeStroke=`rgba(${r},${g},${b2},0.45)`;
    } else if (edgeColor.startsWith('rgb(')) { edgeStroke=edgeColor.replace('rgb(','rgba(').replace(')',',0.45)'); }
    else { edgeStroke='rgba(141,118,154,0.35)'; }
    ctx.strokeStyle=edgeStroke; ctx.lineWidth=1.5; ctx.stroke();
  });
  mmNodes.forEach(node => {
    const isSel=node.id===mmSelectedNode, isCF=node.id===mmConnectFrom;
    const nodeFill=node.root?'#3a2d4a':(node.fill||'#26272A');
    const nodeStroke=node.root?'#8D769A':(node.stroke||'#4A4B51');
    const {boxW,boxH,lines,fontSize,LINE_H,PAD_Y} = mmNodeSize(ctx,node);
    const rx=node.x-boxW/2, ry=node.y-boxH/2, rad=8;
    ctx.shadowColor='rgba(0,0,0,0.5)'; ctx.shadowBlur=12; ctx.shadowOffsetY=4;
    ctx.beginPath();
    ctx.moveTo(rx+rad,ry); ctx.lineTo(rx+boxW-rad,ry); ctx.quadraticCurveTo(rx+boxW,ry,rx+boxW,ry+rad);
    ctx.lineTo(rx+boxW,ry+boxH-rad); ctx.quadraticCurveTo(rx+boxW,ry+boxH,rx+boxW-rad,ry+boxH);
    ctx.lineTo(rx+rad,ry+boxH); ctx.quadraticCurveTo(rx,ry+boxH,rx,ry+boxH-rad);
    ctx.lineTo(rx,ry+rad); ctx.quadraticCurveTo(rx,ry,rx+rad,ry); ctx.closePath();
    ctx.fillStyle=isCF?'#0e3d4a':(isSel?'#3d1f1a':nodeFill); ctx.fill();
    ctx.shadowBlur=0; ctx.shadowOffsetY=0;
    ctx.strokeStyle=isCF?'#22d3ee':(isSel?'#E74C3C':nodeStroke);
    ctx.lineWidth=isSel||node.root?2.5:1.5; ctx.stroke();
    // Draw image if present
    var img = node.imageData ? mmGetImg(node) : null;
    if (img && img.complete) {
      const iw = node.imgW || Math.min(boxW-20, 320);
      const ih = node.imgH || Math.round(iw * img.naturalHeight / Math.max(img.naturalWidth,1));
      const imgX = node.x - iw/2;
      const textH = lines.length * LINE_H + PAD_Y*2;
      const imgY = ry + textH;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(imgX, imgY, iw, ih, 4) : ctx.rect(imgX, imgY, iw, ih);
      ctx.clip();
      ctx.drawImage(img, imgX, imgY, iw, ih);
      ctx.restore();
      // Image SE resize handle (blue, bottom-right of image)
      if (isSel) {
        ctx.fillStyle = '#3b82f6';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(imgX + iw, imgY + ih, 7, 0, Math.PI*2);
        ctx.fill(); ctx.stroke();
        // Draw resize arrow icon inside
        // Two short strokes, not a glyph: the resize grip has to stay crisp at
        // any devicePixelRatio, and ⤡ fell back to whatever the system font had.
        const _gx = imgX + iw, _gy = imgY + ih;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(_gx - 3.5, _gy + 3.5); ctx.lineTo(_gx + 3.5, _gy - 3.5);
        ctx.moveTo(_gx + 0.5, _gy + 3.5); ctx.lineTo(_gx + 3.5, _gy + 0.5);
        ctx.stroke();
      }
    }
    // Draw label text
    ctx.fillStyle='#ECECEE';
    ctx.font=`${node.root?'700 ':'500 '}${fontSize}px 'IBM Plex Mono', monospace`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    const textBlockH = lines.length*LINE_H;
    const textStartY = ry + PAD_Y + LINE_H/2;
    lines.forEach((line,i)=>{ ctx.fillText(line, node.x, textStartY+i*LINE_H); });
    // Draw resize handles on selected node
    if (isSel) {
      const handles = mmGetHandles(node);
      handles.forEach(function(h) {
        ctx.fillStyle = '#E74C3C';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(h.x, h.y, 5, 0, Math.PI*2);
        ctx.fill(); ctx.stroke();
      });
      // Remove image button if image present
      if (node.imageData) {
        const _sz = mmNodeSize(ctx, node);
        const iw2 = node.imgW || Math.min(_sz.boxW-20, 320);
        const textH2 = _sz.lines.length*_sz.LINE_H + _sz.PAD_Y*2;
        const imgY2 = node.y - _sz.boxH/2 + textH2;
        ctx.fillStyle = '#E74C3C';
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(node.x - iw2/2 + 10, imgY2 + 10, 8, 0, Math.PI*2); ctx.fill(); ctx.stroke();
        const _cx = node.x - iw2/2 + 10, _cy = imgY2 + 10, _r = 3.2;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(_cx - _r, _cy - _r); ctx.lineTo(_cx + _r, _cy + _r);
        ctx.moveTo(_cx + _r, _cy - _r); ctx.lineTo(_cx - _r, _cy + _r);
        ctx.stroke();
      }
    }
  });
}
function getNodeAt(x,y) {
  for (let i=mmNodes.length-1;i>=0;i--) {
    const n=mmNodes[i];
    if (!mmCtx) continue;
    const {boxW,boxH}=mmNodeSize(mmCtx,n);
    if (x>=n.x-boxW/2&&x<=n.x+boxW/2&&y>=n.y-boxH/2&&y<=n.y+boxH/2) return n;
  } return null;
}
// Hit-test image SE resize handle on selected node — returns {node, imgX, imgY, iw, ih} or null
function mmHitImgHandle(x, y) {
  if (!mmSelectedNode) return null;
  var node = mmNodes.find(function(n) { return n.id === mmSelectedNode; });
  if (!node || !node.imageData) return null;
  var sz = mmNodeSize(mmCtx, node);
  var iw = node.imgW || Math.min(sz.boxW-20, 320);
  var ih = node.imgH || 120;
  var textH = sz.lines.length * sz.LINE_H + sz.PAD_Y*2;
  var ry = node.y - sz.boxH/2;
  var imgX = node.x - iw/2;
  var imgY = ry + textH;
  // SE handle at (imgX+iw, imgY+ih)
  if (Math.abs(x-(imgX+iw)) <= 12 && Math.abs(y-(imgY+ih)) <= 12) {
    return { node: node, imgX: imgX, imgY: imgY, iw: iw, ih: ih };
  }
  return null;
}
// Hit-test remove-image button (top-left of image)
function mmHitImgRemove(x, y) {
  if (!mmSelectedNode) return null;
  var node = mmNodes.find(function(n) { return n.id === mmSelectedNode; });
  if (!node || !node.imageData) return null;
  var sz = mmNodeSize(mmCtx, node);
  var iw = node.imgW || Math.min(sz.boxW-20, 320);
  var textH = sz.lines.length * sz.LINE_H + sz.PAD_Y*2;
  var ry = node.y - sz.boxH/2;
  var imgX = node.x - iw/2;
  var imgY = ry + textH;
  if (Math.abs(x-(imgX+10)) <= 12 && Math.abs(y-(imgY+10)) <= 12) return node;
  return null;
}
// Hit-test resize handles — returns handle id or null
function mmHitHandle(x, y) {
  if (!mmSelectedNode) return null;
  const node = mmNodes.find(n => n.id === mmSelectedNode);
  if (!node) return null;
  const handles = mmGetHandles(node);
  for (var i=0; i<handles.length; i++) {
    var h = handles[i];
    if (Math.abs(x-h.x) <= 8 && Math.abs(y-h.y) <= 8) return h.id;
  }
  return null;
}

// Hit-test edges: returns index of edge near (x,y) or -1
function mmHitEdge(x, y) {
  var THRESH = 8;
  for (var i = 0; i < mmEdges.length; i++) {
    var edge = mmEdges[i];
    var a = mmNodes.find(function(n){return n.id===edge.from;}), b = mmNodes.find(function(n){return n.id===edge.to;});
    if (!a || !b) continue;
    var mx = (a.x+b.x)/2, my = (a.y+b.y)/2 - 30;
    for (var t = 0; t <= 1; t += 0.05) {
      var bx = (1-t)*(1-t)*a.x + 2*(1-t)*t*mx + t*t*b.x;
      var by = (1-t)*(1-t)*a.y + 2*(1-t)*t*my + t*t*b.y;
      if (Math.abs(x-bx) < THRESH && Math.abs(y-by) < THRESH) return i;
    }
  }
  return -1;
}

(function() {
  var mmEl = document.getElementById('bj-mml-canvas');

  function mmGetXY(e) {
    var r = mmCanvas.getBoundingClientRect();
    var scaleX = mmCanvas.width / r.width, scaleY = mmCanvas.height / r.height;
    return {
      x: (e.clientX - r.left) * scaleX,
      y: (e.clientY - r.top) * scaleY
    };
  }

  // Cursor style by handle id
  var HANDLE_CURSORS = {nw:'nw-resize',n:'n-resize',ne:'ne-resize',e:'e-resize',se:'se-resize',s:'s-resize',sw:'sw-resize',w:'w-resize'};

  mmEl.addEventListener('pointermove', function(e) {
    if (mmImgResizing) {
      var pos = mmGetXY(e);
      var dx = pos.x - mmImgResizing.startX, dy = pos.y - mmImgResizing.startY;
      var node = mmImgResizing.node;
      var nw = Math.max(40, mmImgResizing.origW + dx*2); // *2 because centered
      var nh = Math.max(30, mmImgResizing.origH + dy);
      node.imgW = Math.round(nw);
      node.imgH = Math.round(nh);
      e.preventDefault(); renderMindmap(); return;
    }
    if (mmResizing) {
      var pos = mmGetXY(e);
      var dx = pos.x - mmResizing.startX, dy = pos.y - mmResizing.startY;
      var node = mmResizing.node;
      var h = mmResizing.handle;
      var origW = mmResizing.origW, origH = mmResizing.origH;
      var origX = mmResizing.origX, origY = mmResizing.origY;
      var newW = origW, newH = origH, newX = origX, newY = origY;
      var MIN = 60;
      if (h==='e'||h==='ne'||h==='se') newW = Math.max(MIN, origW + dx);
      if (h==='w'||h==='nw'||h==='sw') { newW = Math.max(MIN, origW - dx); newX = origX + (origW - newW)/2; }
      if (h==='s'||h==='se'||h==='sw') newH = Math.max(MIN, origH + dy);
      if (h==='n'||h==='ne'||h==='nw') { newH = Math.max(MIN, origH - dy); newY = origY + (origH - newH)/2; }
      if (h==='n'||h==='s') newW = origW;
      if (h==='e'||h==='w') newH = origH;
      node.w = Math.round(newW); node.h = Math.round(newH);
      node.x = Math.round(newX); node.y = Math.round(newY);
      e.preventDefault(); renderMindmap(); return;
    }
    if (mmDragNode) {
      var pos = mmGetXY(e);
      mmDragNode.x = pos.x - mmDragOffset.x;
      mmDragNode.y = pos.y - mmDragOffset.y;
      e.preventDefault(); renderMindmap(); return;
    }
    // Update cursor
    var pos = mmGetXY(e);
    if (mmHitImgHandle(pos.x, pos.y)) { mmEl.style.cursor = 'se-resize'; return; }
    var hid = mmHitHandle(pos.x, pos.y);
    var onEdge = !getNodeAt(pos.x,pos.y) && isEditMode && mmHitEdge(pos.x,pos.y) !== -1;
    mmEl.style.cursor = hid ? HANDLE_CURSORS[hid] : (getNodeAt(pos.x,pos.y) ? 'grab' : (onEdge ? 'pointer' : 'default'));
  }, { passive: false });

  mmEl.addEventListener('pointerdown', function(e) {
    var pos = mmGetXY(e);

    // Check resize handle first
    var hid = mmHitHandle(pos.x, pos.y);
    if (hid && isEditMode) {
      var node = mmNodes.find(n => n.id === mmSelectedNode);
      var sz = mmNodeSize(mmCtx, node);
      mmResizing = { node, handle: hid, startX: pos.x, startY: pos.y, origW: sz.boxW, origH: sz.boxH, origX: node.x, origY: node.y };
      mmEl.setPointerCapture(e.pointerId);
      e.preventDefault(); return;
    }

    var node = getNodeAt(pos.x, pos.y);

    if (mmConnectMode) {
      if (node) {
        if (!mmConnectFrom) { mmConnectFrom = node.id; renderMindmap(); }
        else if (mmConnectFrom !== node.id) {
          var exists = mmEdges.some(function(ed) {
            return (ed.from===mmConnectFrom&&ed.to===node.id)||(ed.from===node.id&&ed.to===mmConnectFrom);
          });
          if (!exists) mmEdges.push({from:mmConnectFrom, to:node.id});
          mmConnectFrom = null; mmConnectMode = false;
          document.getElementById('bj-mml-connect-mode').classList.remove('active');
          renderMindmap(); autoSave();
        }
      }
      return;
    }

    if (node) {
      // Check image SE resize handle first
      var imgH = mmHitImgHandle(pos.x, pos.y);
      if (imgH && isEditMode) {
        mmImgResizing = { node: imgH.node, startX: pos.x, startY: pos.y, origW: imgH.iw, origH: imgH.ih };
        mmEl.setPointerCapture(e.pointerId);
        e.preventDefault(); return;
      }
      // Check remove-image button
      var rmNode = mmHitImgRemove(pos.x, pos.y);
      if (rmNode && isEditMode) {
        rmNode.imageData = null; rmNode.imgW = null; rmNode.imgH = null;
        delete mmImgCache[rmNode.id];
        renderMindmap(); autoSave(); e.preventDefault(); return;
      }
      mmEl.setPointerCapture(e.pointerId);
      mmSelectedNode = node.id; mmDragNode = node;
      mmDragOffset = {x: pos.x - node.x, y: pos.y - node.y};
      if (!node.root && node.fill) {
        document.querySelectorAll('.mml-color-btn').forEach(function(b) {
          b.classList.toggle('active', b.dataset.fill === node.fill);
        });
        mmNodeFill = node.fill; mmNodeStroke = node.stroke || '#4A4B51';
      }
      e.preventDefault();
      renderMindmap();
    } else {
      // Check if clicked near an edge — if so, delete it (edit mode)
      if (isEditMode) {
        var edgeIdx = mmHitEdge(pos.x, pos.y);
        if (edgeIdx !== -1) {
          mmEdges.splice(edgeIdx, 1);
          renderMindmap(); autoSave(); e.preventDefault(); return;
        }
      }
      mmSelectedNode = null; renderMindmap();
    }
  }, { passive: false });

  mmEl.addEventListener('pointerup', function(e) {
    if (mmImgResizing) { mmImgResizing = null; autoSave(); return; }
    if (mmResizing) { mmResizing = null; autoSave(); return; }
    if (mmDragNode) { mmDragNode = null; autoSave(); }
  });
  mmEl.addEventListener('pointercancel', function() { mmDragNode = null; mmResizing = null; mmImgResizing = null; });

  // Drag-and-drop image files onto canvas
  mmEl.addEventListener('dragover', function(e) { e.preventDefault(); mmEl.style.outline = '2px dashed #8D769A'; });
  mmEl.addEventListener('dragleave', function() { mmEl.style.outline = ''; });
  mmEl.addEventListener('drop', function(e) {
    e.preventDefault(); mmEl.style.outline = '';
    var files = e.dataTransfer.files;
    if (!files || !files.length) return;
    var file = files[0];
    if (!file.type.startsWith('image/')) return;
    var pos = mmGetXY(e);
    var targetNode = getNodeAt(pos.x, pos.y);
    var reader = new FileReader();
    reader.onload = function(ev) {
      var dataURL = ev.target.result;
      var tmpImg = new Image();
      tmpImg.onload = function() {
        var maxW = 400, maxH = 320;
        var iw = tmpImg.naturalWidth, ih = tmpImg.naturalHeight;
        if (iw > maxW) { ih = Math.round(ih * maxW / iw); iw = maxW; }
        if (ih > maxH) { iw = Math.round(iw * maxH / ih); ih = maxH; }
        if (targetNode) {
          // Drop onto node — attach image, resize node to fit
          targetNode.imageData = dataURL;
          targetNode.imgW = iw; targetNode.imgH = ih;
          // Expand node w/h to accommodate image
          var sz = mmNodeSize(mmCtx, targetNode);
          targetNode.w = Math.max(sz.boxW, iw + 20);
          targetNode.h = sz.boxH; // auto-calculated via imageData path
          delete targetNode.w; delete targetNode.h; // let mmNodeSize auto-calc with image
          delete mmImgCache[targetNode.id];
        } else {
          // Drop onto empty canvas — create new image node
          mmNextId++;
          var node = {id:mmNextId, x:pos.x, y:pos.y, label:'Image', fill:mmNodeFill, stroke:mmNodeStroke, imageData:dataURL, imgW:iw, imgH:ih};
          mmNodes.push(node);
          mmSelectedNode = node.id;
        }
        renderMindmap(); autoSave();
      };
      tmpImg.src = dataURL;
    };
    reader.readAsDataURL(file);
  });
})();
document.getElementById('bj-mml-canvas').addEventListener('dblclick', e => {
  if (!isEditMode) return;
  const r=mmCanvas.getBoundingClientRect();
  const scaleX=mmCanvas.width/r.width, scaleY=mmCanvas.height/r.height;
  const x=(e.clientX-r.left)*scaleX, y=(e.clientY-r.top)*scaleY;
  const node=getNodeAt(x,y); if (!node) return;
  const inp=document.getElementById('bj-mml-node-input');
  // Position relative to canvas element (CSS pixels), not canvas pixel coords
  const cssX=node.x/scaleX, cssY=node.y/scaleY;
  inp.style.display='block'; inp.style.left=(cssX-130)+'px'; inp.style.top=(cssY-18)+'px';
  inp.value=node.label; inp.focus(); inp.select(); mmEditingNode=node;
});
document.getElementById('bj-mml-node-input').addEventListener('keydown', e => {
  if (e.key==='Enter'&&!e.shiftKey) {
    e.preventDefault();
    const ta=e.target, start=ta.selectionStart, end=ta.selectionEnd;
    ta.value=ta.value.substring(0,start)+'\n'+ta.value.substring(end);
    ta.selectionStart=ta.selectionEnd=start+1;
    ta.style.height='auto'; ta.style.height=ta.scrollHeight+'px';
    return;
  }
  if ((e.key==='Enter'&&e.shiftKey)||e.key==='Escape') {
    if (e.key!=='Escape'&&mmEditingNode) { mmEditingNode.label=e.target.value||mmEditingNode.label; autoSave(); }
    if (e.key==='Escape'&&mmEditingNode) { mmEditingNode.label=e.target.value||mmEditingNode.label; autoSave(); }
    e.target.style.display='none'; e.target.style.height=''; mmEditingNode=null; renderMindmap();
  }
});
document.getElementById('bj-mml-node-input').addEventListener('blur', e => {
  if (mmEditingNode) { mmEditingNode.label=e.target.value||mmEditingNode.label; autoSave(); }
  e.target.style.display='none'; e.target.style.height=''; mmEditingNode=null; renderMindmap();
});
document.getElementById('bj-mml-node-input').addEventListener('input', e => {
  e.target.style.height='auto'; e.target.style.height=e.target.scrollHeight+'px';
});
document.getElementById('bj-mml-add-node').addEventListener('click', () => {
  mmNextId++;
  const cx = mmCanvas ? mmCanvas.width/2 : 340;
  const cy = mmCanvas ? mmCanvas.height/2 : 240;
  mmNodes.push({id:mmNextId,x:cx+(Math.random()-.5)*220,y:cy+(Math.random()-.5)*160,label:'Idea',fill:mmNodeFill,stroke:mmNodeStroke});
  renderMindmap(); autoSave();
});
document.querySelectorAll('.mml-color-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    mmNodeFill = this.dataset.fill;
    mmNodeStroke = this.dataset.stroke;
    document.querySelectorAll('.mml-color-btn').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    // Apply to selected node if any
    if (mmSelectedNode) {
      const node = mmNodes.find(n => n.id === mmSelectedNode);
      if (node && !node.root) {
        node.fill = mmNodeFill;
        node.stroke = mmNodeStroke;
        renderMindmap(); autoSave();
      }
    }
  });
});
document.getElementById('bj-mml-connect-mode').addEventListener('click', function() {
  mmConnectMode=!mmConnectMode; mmConnectFrom=null; this.classList.toggle('active',mmConnectMode);
});
document.getElementById('bj-mml-delete-node').addEventListener('click', () => {
  if (!mmSelectedNode) { alert('Select a node first.'); return; }
  if (mmNodes.find(n=>n.id===mmSelectedNode)?.root) { alert("Can't delete the root node."); return; }
  mmNodes=mmNodes.filter(n=>n.id!==mmSelectedNode);
  mmEdges=mmEdges.filter(e=>e.from!==mmSelectedNode&&e.to!==mmSelectedNode);
  mmSelectedNode=null; renderMindmap(); autoSave();
});
document.getElementById('bj-mml-reset').addEventListener('click', async () => {
  if (!(await window.uiConfirm('Reset the mind map?', {danger:true, okLabel:'Reset'}))) return;
  const cx = mmCanvas ? mmCanvas.width/2 : 340;
  const cy = mmCanvas ? mmCanvas.height/2 : 240;
  mmNodes=[{id:1,x:cx,y:cy,label:'Central Idea',root:true}];
  mmEdges=[]; mmNextId=10; renderMindmap(); autoSave();
});

// Mindmap: add image to selected node via file picker
document.getElementById('bj-mml-img-file').addEventListener('change', function() {
  var file = this.files[0]; if (!file) return;
  if (!mmSelectedNode) { alert('Select a node first, then click Image.'); this.value=''; return; }
  var node = mmNodes.find(function(n) { return n.id === mmSelectedNode; });
  if (!node) { this.value=''; return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    var dataURL = e.target.result;
    var tmpImg = new Image();
    tmpImg.onload = function() {
      var maxW = 400, maxH = 320;
      var iw = tmpImg.naturalWidth, ih = tmpImg.naturalHeight;
      if (iw > maxW) { ih = Math.round(ih * maxW / iw); iw = maxW; }
      if (ih > maxH) { iw = Math.round(iw * maxH / ih); ih = maxH; }
      node.imageData = dataURL;
      node.imgW = iw; node.imgH = ih;
      delete mmImgCache[node.id];
      renderMindmap(); autoSave();
    };
    tmpImg.src = dataURL;
  };
  reader.readAsDataURL(file);
  this.value = '';
});


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
// ── Markdown → HTML (shared, global) — full-featured ──────────────────────
// Handles: headings, bold/italic/strike, inline+fenced code (with lang), links
// (inline/reference/auto/email), images, ordered/unordered/nested/task lists,
// definition lists, tables (with alignment), blockquotes (nested), horizontal
// rules, highlight (==x==), sub (~x~) / sup (^x^), footnotes, emoji shortcodes,
// backslash escaping, safe inline+block HTML passthrough, and math ($…$, $$…$$)
// via KaTeX placeholders that _docxRenderMath() fills in after insertion.
var DOCX_EMOJI = { smile:'😄', smiley:'😃', grin:'😁', laughing:'😆', wink:'😉', blush:'😊', heart:'❤️', hearts:'💕', fire:'🔥', rocket:'🚀', tada:'🎉', star:'⭐', star2:'🌟', sparkles:'✨', zap:'⚡', boom:'💥', sunny:'☀️', bulb:'💡', check:'✔️', white_check_mark:'✅', x:'❌', warning:'⚠️', question:'❓', exclamation:'❗', thumbsup:'👍', '+1':'👍', thumbsdown:'👎', '-1':'👎', eyes:'👀', wave:'👋', clap:'👏', pray:'🙏', muscle:'💪', ok_hand:'👌', point_right:'👉', point_left:'👈', rainbow:'🌈', hourglass:'⏳', alarm_clock:'⏰', calendar:'📅', memo:'📝', pencil:'✏️', book:'📖', books:'📚', computer:'💻', iphone:'📱', email:'📧', mag:'🔍', lock:'🔒', key:'🔑', bell:'🔔', chart_with_upwards_trend:'📈', chart_with_downwards_trend:'📉', bar_chart:'📊', moneybag:'💰', gift:'🎁', trophy:'🏆', medal:'🏅', dart:'🎯', hammer:'🔨', wrench:'🔧', gear:'⚙️', package:'📦', pushpin:'📌', paperclip:'📎', coffee:'☕', pizza:'🍕', beer:'🍺', cake:'🎂', sun:'☀️', cloud:'☁️', snowflake:'❄️', umbrella:'☔', earth_americas:'🌎', globe:'🌐', bug:'🐛', ghost:'👻', robot:'🤖', alien:'👽', skull:'💀', poop:'💩', '100':'💯', ok:'🆗', new:'🆕', up:'🔼', cool:'🆒', thinking:'🤔', sob:'😭', joy:'😂', sunglasses:'😎', heart_eyes:'😍', angry:'😠', scream:'😱' };

if (!window._mdToHtml) {
window._mdToHtml = function(md) {
  var esc = function(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  md = String(md == null ? '' : md).replace(/\r\n?/g, '\n');

  var codeBlocks = [], mathBlocks = [], refs = {}, footnotes = {}, footnoteOrder = [];

  // 1) Reference-link definitions:  [id]: url "title"
  md = md.replace(/^[ \t]{0,3}\[([^\^\]][^\]]*)\]:\s*(\S+).*$/gm, function(_, id, url){ refs[id.toLowerCase().trim()] = url; return 'K'; });
  // 2) Footnote definitions:  [^id]: text
  md = md.replace(/^[ \t]{0,3}\[\^([^\]]+)\]:[ \t]*(.*)$/gm, function(_, id, text){ footnotes[id.trim()] = text; return 'K'; });
  // 3) Fenced code blocks  ```lang \n … ```
  md = md.replace(/```([a-zA-Z0-9_+-]*)[ \t]*\n?([\s\S]*?)```/g, function(_, lang, c){
    codeBlocks.push('<pre class="docx-code"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '><code>' + esc(c.replace(/\n$/, '')) + '</code></pre>');
    return 'C' + (codeBlocks.length - 1) + '';
  });
  // 4) Block math  $$ … $$  (multi-line) → its own placeholder line
  md = md.replace(/\$\$([\s\S]*?)\$\$/g, function(_, tex){
    mathBlocks.push({ tex: tex.replace(/^\n+|\n+$/g, ''), display: true });
    return '\nM' + (mathBlocks.length - 1) + '\n';
  });

  var SAFE_HTML = 'u|sub|sup|br|mark|kbd|small|b|i|em|strong|code|span|a|abbr|del|ins';
  var inline = function(t){
    // backslash escapes FIRST (so \` \* etc. become literal and never trigger code/format)
    var escd = [];
    t = t.replace(/\\([\\`*_{}\[\]()#+.!~^=|<>&-])/g, function(_, ch){ escd.push(ch); return 'e' + (escd.length - 1) + ''; });
    // protect inline math  $ math $
    t = t.replace(/\$([^$\n]+?)\$/g, function(_, tex){ mathBlocks.push({ tex: tex.trim(), display: false }); return 'M' + (mathBlocks.length - 1) + ''; });
    // protect inline code  ` code `  (escaped backticks are already placeholders now)
    var codes = [];
    t = t.replace(/`([^`]+)`/g, function(_, c){ codes.push(esc(c)); return 'c' + (codes.length - 1) + ''; });
    t = esc(t);
    // images
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img src="$2" alt="$1" style="max-width:100%;">');
    // inline links
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // reference links  [text][id]  and  [text][]
    t = t.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, function(m, txt, id){ var u = refs[(id || txt).toLowerCase().trim()]; return u ? '<a href="' + u + '" target="_blank" rel="noopener">' + txt + '</a>' : m; });
    // emails  <a@b.c>
    t = t.replace(/&lt;([^@\s]+@[^@\s]+\.[^@\s]+)&gt;/g, '<a href="mailto:$1">$1</a>');
    // bare URLs
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    // bold / italic
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
    // strikethrough
    t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    // highlight
    t = t.replace(/==([^=]+)==/g, '<mark class="docx-hl">$1</mark>');
    // subscript ~x~  and superscript ^x^  (after ~~ strike so it doesn't clash)
    t = t.replace(/~([^~\s][^~]*?)~/g, '<sub>$1</sub>');
    t = t.replace(/\^([^\^\s]+?)\^/g, '<sup>$1</sup>');
    // footnote references [^id]
    t = t.replace(/\[\^([^\]]+)\]/g, function(m, id){ id = id.trim(); if (!(id in footnotes)) return m; if (footnoteOrder.indexOf(id) < 0) footnoteOrder.push(id); var n = footnoteOrder.indexOf(id) + 1; return '<sup class="docx-fnref">[<a href="#docx-fn-' + encodeURIComponent(id) + '">' + n + '</a>]</sup>'; });
    // emoji shortcodes
    t = t.replace(/:([a-z0-9_+-]+):/g, function(m, name){ return DOCX_EMOJI[name] || m; });
    // restore whitelisted inline HTML tags the author wrote
    t = t.replace(new RegExp('&lt;(/?)(' + SAFE_HTML + ')((?:\\s[^&]*?)?)\\s*(/?)&gt;', 'gi'), function(m, slash, tag, attrs, sc){ attrs = attrs.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&'); return '<' + slash + tag + attrs + sc + '>'; });
    // restore escapes / inline code
    t = t.replace(/e(\d+)/g, function(_, n){ return esc(escd[+n]); });
    t = t.replace(/c(\d+)/g, function(_, n){ return '<code>' + codes[+n] + '</code>'; });
    return t;
  };

  var lines = md.split('\n'), out = [], j = 0;
  var isSepLine = function(s){ return /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && /-/.test(s) && /\|/.test(s); };
  // A line that BEGINS with a block-level HTML tag passes through raw (content after the tag is fine,
  // so `<summary>Click</summary>` / `<li>item</li>` inside a <details> render as HTML, not literal text).
  var htmlBlockRe = /^\s*<\/?(details|summary|div|section|article|aside|nav|header|footer|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|dl|dt|dd|blockquote|pre|hr|p|h[1-6]|iframe|video|audio|img|br)\b/i;

  while (j < lines.length) {
    var ln = lines[j];
    if (ln === 'K') { j++; continue; }
    var phC = ln.match(/^C(\d+)$/); if (phC) { out.push(codeBlocks[+phC[1]]); j++; continue; }
    var phM = ln.match(/^M(\d+)$/); if (phM) { out.push('M' + phM[1] + ''); j++; continue; }
    if (/^\s*$/.test(ln)) { j++; continue; }

    // raw HTML block line → pass through untouched
    if (htmlBlockRe.test(ln)) { out.push(ln); j++; continue; }

    // ATX heading
    var h = ln.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (h) { var lv = h[1].length; out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'); j++; continue; }

    // horizontal rule
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(ln)) { out.push('<hr>'); j++; continue; }

    // blockquote (supports nesting via >>)
    if (/^\s*>/.test(ln)) {
      var qlines = [];
      while (j < lines.length && /^\s*>/.test(lines[j])) { qlines.push(lines[j].replace(/^\s*>\s?/, '')); j++; }
      out.push('<blockquote>' + window._mdToHtml(qlines.join('\n')).replace(/<p><br><\/p>\s*$/, '') + '</blockquote>');
      continue;
    }

    // table
    if (/\|/.test(ln) && !isSepLine(ln)) {
      var sIdx = j + 1;
      while (sIdx < lines.length && /^\s*$/.test(lines[sIdx])) sIdx++;
      if (sIdx < lines.length && isSepLine(lines[sIdx])) {
        var cell = function(r){ return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function(c){ return c.trim(); }); };
        var aligns = cell(lines[sIdx]).map(function(s){ var l = /^:/.test(s), r = /:$/.test(s); return l && r ? 'center' : r ? 'right' : l ? 'left' : ''; });
        var head = cell(ln);
        var al = function(i){ return aligns[i] ? ' style="text-align:' + aligns[i] + '"' : ''; };
        var t = '<table><thead><tr>' + head.map(function(c, i){ return '<th' + al(i) + '>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
        j = sIdx + 1;
        while (j < lines.length) {
          if (/^\s*$/.test(lines[j])) { var p = j + 1; while (p < lines.length && /^\s*$/.test(lines[p])) p++; if (p < lines.length && /\|/.test(lines[p]) && !isSepLine(lines[p])) { j = p; continue; } break; }
          if (!/\|/.test(lines[j])) break;
          if (isSepLine(lines[j])) { j++; continue; }
          t += '<tr>' + cell(lines[j]).map(function(c, i){ return '<td' + al(i) + '>' + inline(c) + '</td>'; }).join('') + '</tr>'; j++;
        }
        out.push(t + '</tbody></table>'); continue;
      }
    }

    // definition list:  Term \n : def \n : def
    if (j + 1 < lines.length && /^:\s+/.test(lines[j + 1]) && !/^\s*([-*+]|\d+\.)\s/.test(ln)) {
      var dl = '<dl>';
      while (j < lines.length && lines[j].trim() && !/^:\s+/.test(lines[j])) { dl += '<dt>' + inline(lines[j].trim()) + '</dt>'; j++;
        while (j < lines.length && /^:\s+/.test(lines[j])) { dl += '<dd>' + inline(lines[j].replace(/^:\s+/, '')) + '</dd>'; j++; }
      }
      out.push(dl + '</dl>'); continue;
    }

    // lists (nested + task lists)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(ln)) {
      var items = [];
      while (j < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[j])) {
        var lm = lines[j].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        items.push({ depth: Math.floor(lm[1].replace(/\t/g, '  ').length / 2), ordered: /\d/.test(lm[2]), text: lm[3] });
        j++;
      }
      var renderList = function(arr){
        var depth = arr[0].depth, k = 0, ordered = arr[0].ordered;
        var hasCheck = arr.some(function(it){ return it.depth === depth && /^\[[ xX]\]\s/.test(it.text); });
        var html = ordered ? '<ol>' : (hasCheck ? '<ul class="docx-checklist">' : '<ul>');
        while (k < arr.length) {
          var it = arr[k], kids = [], k2 = k + 1;
          while (k2 < arr.length && arr[k2].depth > depth) { kids.push(arr[k2]); k2++; }
          var cm = it.text.match(/^\[([ xX])\]\s+(.*)$/);
          var body = cm ? '<input type="checkbox" class="docx-cl-box"' + (cm[1] !== ' ' ? ' checked' : '') + '><span class="docx-cl-text">' + inline(cm[2]) + '</span>' : inline(it.text);
          html += '<li' + (cm ? ' class="docx-cl-item' + (cm[1] !== ' ' ? ' done' : '') + '"' : '') + '>' + body + (kids.length ? renderList(kids) : '') + '</li>';
          k = k2;
        }
        return html + (ordered ? '</ol>' : '</ul>');
      };
      out.push(renderList(items)); continue;
    }

    // paragraph
    var para = [];
    while (j < lines.length && lines[j].trim() && !/^(#{1,6})\s/.test(lines[j]) && !/^\s*>/.test(lines[j]) &&
           !/^\s*([-*+]|\d+[.)])\s+/.test(lines[j]) && !/^[CM]\d+$/.test(lines[j]) &&
           !/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[j]) && !htmlBlockRe.test(lines[j]) &&
           !(lines[j].indexOf('|') >= 0 && j + 1 < lines.length && isSepLine(lines[j + 1]))) {
      para.push(inline(lines[j])); j++;
    }
    if (para.length) out.push('<p>' + para.join('<br>') + '</p>');
  }

  var html = out.join('');
  // math placeholders → KaTeX target elements (rendered by _docxRenderMath after insert)
  html = html.replace(/M(\d+)/g, function(_, n){ var m = mathBlocks[+n]; if (!m) return ''; var enc = encodeURIComponent(m.tex); return m.display ? '<div class="docx-math docx-math-block" data-tex="' + enc + '" contenteditable="false"></div>' : '<span class="docx-math docx-math-inline" data-tex="' + enc + '" contenteditable="false"></span>'; });
  html = html.replace(/C(\d+)/g, function(_, n){ return codeBlocks[+n] || ''; });
  // footnotes section
  if (footnoteOrder.length) {
    html += '<hr><ol class="docx-footnotes">';
    footnoteOrder.forEach(function(id){ html += '<li id="docx-fn-' + encodeURIComponent(id) + '">' + inline(footnotes[id] || '') + '</li>'; });
    html += '</ol>';
  }
  return html + '<p><br></p>';
};
}
// ── Convert raw markdown tables left inside an already-rendered editor ─────
if (!window._renderMdTables) {
window._renderMdTables = function(ed) {
  var isSepLine = function(s){ return /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && /-/.test(s) && /\|/.test(s); };
  var splitCells = function(htmlLine){ return htmlLine.replace(/^\s*\|/,'').replace(/\|\s*$/,'').split('|').map(function(c){return c.trim();}); };
  var lineText = function(el){ return (el.textContent || '').trim(); };

  // Pass 0: a single block may hold the whole table as <br>-separated lines — split it.
  Array.prototype.slice.call(ed.children).forEach(function(el){
    var inner = el.innerHTML;
    if (!/<br\s*\/?>/i.test(inner)) return;
    var segs = inner.split(/<br\s*\/?>/i);
    var anySep = segs.some(function(s){ var d=document.createElement('div'); d.innerHTML=s; return isSepLine(d.textContent.trim()); });
    if (!anySep) return;
    var frag = document.createDocumentFragment();
    segs.forEach(function(s){ var p=document.createElement('p'); p.innerHTML = (s && s.trim()) ? s : '<br>'; frag.appendChild(p); });
    el.parentNode.replaceChild(frag, el);
  });

  // Pass 1: scan top-level <p>/<div> blocks for header + separator + rows (blank lines tolerated).
  var children = Array.prototype.slice.call(ed.children);
  var i = 0;
  while (i < children.length) {
    var el = children[i];
    var line = lineText(el);
    if (line && /\|/.test(line) && !isSepLine(line) && el.tagName && /^(P|DIV)$/i.test(el.tagName)) {
      var k = i + 1;
      while (k < children.length && lineText(children[k]) === '') k++;
      if (k < children.length && isSepLine(lineText(children[k]))) {
        var rows = [], lastIdx = k, m = k + 1;
        while (m < children.length) {
          var ml = lineText(children[m]);
          if (ml === '') { m++; continue; }
          if (/\|/.test(ml) && !isSepLine(ml) && children[m].tagName && /^(P|DIV)$/i.test(children[m].tagName)) {
            rows.push(children[m]); lastIdx = m; m++;
          } else break;
        }
        var head = splitCells(el.innerHTML);
        var t = '<table><tr>' + head.map(function(c){return '<th>'+c+'</th>';}).join('') + '</tr>';
        rows.forEach(function(r){ t += '<tr>' + splitCells(r.innerHTML).map(function(c){return '<td>'+c+'</td>';}).join('') + '</tr>'; });
        t += '</table>';
        var holder = document.createElement('div'); holder.innerHTML = t;
        var tableEl = holder.firstChild;
        ed.insertBefore(tableEl, el);
        for (var d = i; d <= lastIdx; d++) { if (children[d].parentNode) children[d].parentNode.removeChild(children[d]); }
        children = Array.prototype.slice.call(ed.children);
        i = Array.prototype.indexOf.call(children, tableEl) + 1;
        continue;
      }
    }
    i++;
  }
};
}
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

// ── ATTACHMENT SYSTEM (Notes / Cornell / Mindmap) ────────────────────────────
(function() {
  // Each template stores attachments as entry.data.attachments = [{id,name,mime,data}]
  var ATTACH_CONFIGS = [
    { inputId: 'bj-notes-attach-input',   chipsId: 'bj-notes-attach-chips',   imgsId: 'bj-notes-attach-images',   barId: 'bj-notes-attach-bar',   tmpl: 'notes'    },
    { inputId: 'bj-cornell-attach-input', chipsId: 'bj-cornell-attach-chips', imgsId: 'bj-cornell-attach-images', barId: 'bj-cornell-attach-bar', tmpl: 'cornell'  },
    { inputId: 'bj-mm-attach-input',      chipsId: 'bj-mm-attach-chips',      imgsId: 'bj-mm-attach-images',      barId: 'bj-mm-attach-bar',      tmpl: 'mindmap'  },
    { inputId: 'bj-mml-attach-input',     chipsId: 'bj-mml-attach-chips',     imgsId: 'bj-mml-attach-images',     barId: 'bj-mml-attach-bar',     tmpl: 'mindmap-legacy' },
  ];

  function getAttachments() {
    var entry = getActive(); if (!entry) return [];
    if (!entry.data.attachments) entry.data.attachments = [];
    return entry.data.attachments;
  }
  function addAttachment(name, mime, data) {
    var entry = getActive(); if (!entry) return;
    if (_bjFileTooBig(name, data)) return;
    if (!entry.data.attachments) entry.data.attachments = [];
    var id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    entry.data.attachments.push({ id: id, name: name, mime: mime, data: data });
    autoSave();
    renderAttachments(entry.template);
  }
  function removeAttachment(id) {
    var entry = getActive(); if (!entry) return;
    entry.data.attachments = (entry.data.attachments || []).filter(function(a) { return a.id !== id; });
    autoSave();
    renderAttachments(entry.template);
  }

  function renderAttachments(tmpl) {
    var cfg = ATTACH_CONFIGS.find(function(c) { return c.tmpl === tmpl; });
    if (!cfg) return;
    var chipsEl = document.getElementById(cfg.chipsId);
    var imgsEl  = document.getElementById(cfg.imgsId);
    if (!chipsEl || !imgsEl) return;
    var atts = getAttachments();
    chipsEl.innerHTML = '';
    imgsEl.innerHTML  = '';
    atts.forEach(function(att) {
      var isImg = att.mime && att.mime.startsWith('image/');
      if (isImg) {
        var wrap = document.createElement('div');
        wrap.className = 'bj-img-wrap';
        wrap.setAttribute('data-id', att.id);
        var img = document.createElement('img');
        img.src = att.data;
        img.style.width  = (att.w || 200) + 'px';
        img.style.height = 'auto';
        img.draggable = false;
        var del = document.createElement('div');
        del.className = 'bj-img-del';
        del.innerHTML = window.TNI.x;
        del.addEventListener('click', function() { removeAttachment(att.id); });
        var rsz = document.createElement('div');
        rsz.className = 'bj-img-resize';
        // Resize drag
        rsz.addEventListener('pointerdown', function(e) {
          e.stopPropagation(); e.preventDefault();
          rsz.setPointerCapture(e.pointerId);
          var startX = e.clientX, startW = img.offsetWidth;
          function onMove(ev) {
            var nw = Math.max(60, startW + (ev.clientX - startX));
            img.style.width = nw + 'px';
            att.w = nw;
          }
          function onUp() {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            autoSave();
          }
          document.addEventListener('pointermove', onMove);
          document.addEventListener('pointerup', onUp);
        });
        wrap.appendChild(img);
        wrap.appendChild(del);
        wrap.appendChild(rsz);
        // Drag to reorder within images panel
        _bjMakeImgDraggable(wrap, imgsEl);
        imgsEl.appendChild(wrap);
      } else {
        var chip = document.createElement('a');
        chip.className = 'bj-chip';
        chip.href = att.data;
        chip.download = att.name;
        chip.title = att.name;
        chip.innerHTML = '<span class="docx-clip-wrap">' + (window._docxPaperclipSVG || window.TNI.clip) + '</span><span class="bj-chip-name">' + _bjEsc(att.name) + '</span>';
        if (isEditMode) {
          var delSpan = document.createElement('span');
          delSpan.className = 'bj-chip-del';
          delSpan.innerHTML = window.TNI.x;
          delSpan.addEventListener('click', function(e) { e.preventDefault(); removeAttachment(att.id); });
          chip.appendChild(delSpan);
        }
        chipsEl.appendChild(chip);
      }
    });
  }

  // Make image wrap draggable for reordering within its container
  function _bjMakeImgDraggable(wrap, container) {
    wrap.addEventListener('pointerdown', function(e) {
      if (e.target.classList.contains('bj-img-resize') || e.target.classList.contains('bj-img-del')) return;
      e.preventDefault();
      container.querySelectorAll('.bj-img-wrap').forEach(function(w) { w.classList.remove('selected'); });
      wrap.classList.add('selected');
      var startX = e.clientX, startY = e.clientY;
      var moved = false;
      var placeholder = document.createElement('div');
      placeholder.style.cssText = 'width:' + wrap.offsetWidth + 'px;height:' + wrap.offsetHeight + 'px;border:2px dashed var(--border);border-radius:6px;flex-shrink:0;';
      function onMove(ev) {
        if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
        moved = true;
        wrap.style.opacity = '0.5';
        // Find insertion point
        var siblings = Array.from(container.children).filter(function(c) { return c !== wrap && c !== placeholder; });
        var after = null;
        siblings.forEach(function(s) {
          var r = s.getBoundingClientRect();
          if (ev.clientX > r.left + r.width / 2) after = s;
        });
        if (after) { container.insertBefore(placeholder, after.nextSibling); }
        else { container.insertBefore(placeholder, container.firstChild); }
      }
      function onUp() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        wrap.style.opacity = '';
        if (moved && placeholder.parentNode) {
          container.insertBefore(wrap, placeholder);
          placeholder.remove();
          // Sync order in entry.data.attachments
          var entry = getActive(); if (!entry || !entry.data.attachments) return;
          var orderedImgIds = Array.from(container.querySelectorAll('.bj-img-wrap')).map(function(w) { return w.getAttribute('data-id'); });
          var nonImgs = entry.data.attachments.filter(function(a) { return !(a.mime && a.mime.startsWith('image/')); });
          var imgs = orderedImgIds.map(function(id) { return entry.data.attachments.find(function(a) { return a.id === id; }); }).filter(Boolean);
          entry.data.attachments = imgs.concat(nonImgs);
          autoSave();
        } else if (placeholder.parentNode) { placeholder.remove(); }
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  // Wire file inputs
  ATTACH_CONFIGS.forEach(function(cfg) {
    var input = document.getElementById(cfg.inputId);
    if (!input) return;
    input.addEventListener('change', function() {
      Array.from(this.files).forEach(function(file) {
        var reader = new FileReader();
        reader.onload = function(e) { addAttachment(file.name, file.type, e.target.result); };
        reader.readAsDataURL(file);
      });
      this.value = '';
    });
  });

  // Show/hide attach bars with edit mode & template
  window._bjRenderAttachments = renderAttachments;
  window._bjRefreshAttachBars = function(tmpl, editMode) {
    ATTACH_CONFIGS.forEach(function(cfg) {
      var bar = document.getElementById(cfg.barId);
      if (bar) {
        if (cfg.tmpl === tmpl && editMode) bar.classList.add('edit-mode');
        else bar.classList.remove('edit-mode');
      }
    });
  };
})();


// ── DRAG & DROP FILE UPLOAD (all templates) ─────────────────────────────────
(function() {
  var DROP_ZONES = [
    { areaId: 'bj-notes-area',     zoneId: 'bj-notes-drop-zone',   tmpl: 'notes'      },
    { areaId: 'bj-cornell-area',   zoneId: 'bj-cornell-drop-zone', tmpl: 'cornell'    },
    { areaId: 'bj-mindmap-area',   zoneId: 'bj-mm-drop-zone',      tmpl: 'mindmap'    },
    { areaId: 'bj-mml-area',       zoneId: 'bj-mml-drop-zone',     tmpl: 'mindmap-legacy' },
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
        // All other templates: use shared addAttachment
        if (typeof window._bjAddAttachment === 'function') {
          window._bjAddAttachment(file.name, file.type, ev.target.result);
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

  // Expose addAttachment globally so drag-drop can call it
  // (it's defined inside the attachment IIFE; re-expose it here)
  var _origRefresh = window._bjRefreshAttachBars;
  // Wrap: when attachment IIFE runs it exposes _bjRenderAttachments
  // We need addAttachment — re-implement a thin wrapper using the same storage
  window._bjAddAttachment = function(name, mime, data) {
    var entry = (typeof getActive === 'function') ? getActive() : null;
    if (!entry) return;
    if (_bjFileTooBig(name, data)) return;
    if (!entry.data.attachments) entry.data.attachments = [];
    var id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    entry.data.attachments.push({ id: id, name: name, mime: mime, data: data });
    if (typeof autoSave === 'function') autoSave();
    if (typeof window._bjRenderAttachments === 'function') window._bjRenderAttachments(entry.template);
  };
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
  try { if (window._bjFlushBoards) window._bjFlushBoards(); } catch(e) {}
  try { clearTimeout(autoTimer); if (getActive()) saveCurrentEntry(); } catch(e) {}
  try { return _bjFbFlush(); } catch(e) {}
};
document.getElementById('bj-entry-title-input').addEventListener('input', autoSave);
document.getElementById('bj-page-editor').addEventListener('input', autoSave);
['bj-notes-main','bj-notes-links','bj-notes-questions','bj-cornell-topic','bj-cornell-cues-ta','bj-cornell-notes-ta','bj-cornell-summary-ta'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', autoSave);
});

/* KEYBOARD SHORTCUTS */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault(); saveCurrentEntry();
    if (window._bjFlushBoards) window._bjFlushBoards();
  }
  // Undo/redo inside a board belong to the board — both editors bind their own
  // Ctrl+Z / Ctrl+Shift+Z on their container, and a second handler here would
  // fire for the same keystroke.
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
  // View mode puts Excalidraw into its own viewModeEnabled and Mind Elixir into
  // disableEdit(), so panning, zooming and reading still work but nothing can be
  // changed — the same contract the text templates get from readOnly.
  if (_bjBoards.wb) _bjBoards.wb.setEditable(enabled);
  if (_bjBoards.mm) _bjBoards.mm.setEditable(enabled);
  // The legacy mind map gates the same way it always did: its toolbar appears
  // in edit mode and its canvas stops taking pointer events out of it.
  const mmlToolbar = document.getElementById('bj-mml-toolbar');
  if (mmlToolbar) mmlToolbar.classList.toggle('edit-mode', enabled);
  const mmlC = document.getElementById('bj-mml-canvas');
  if (mmlC) mmlC.style.pointerEvents = enabled ? 'auto' : 'none';
  const editableIds = [
    'bj-entry-title-input','bj-notes-main','bj-notes-links','bj-notes-questions',
    'bj-cornell-topic','bj-cornell-cues-ta','bj-cornell-notes-ta','bj-cornell-summary-ta',
    'bj-add-tag-input'
  ];
  editableIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.readOnly = !enabled;
  });
  const ctInput = document.getElementById('bj-cornell-topic');
  if (ctInput) ctInput.readOnly = !enabled;
  // Page editor
  const pgEd = document.getElementById('bj-page-editor');
  if (pgEd) pgEd.contentEditable = enabled ? 'true' : 'false';
  const pgTb = document.getElementById('bj-page-toolbar');
  if (pgTb) {
    const activeEntry = getActive();
    if (enabled && activeEntry && activeEntry.template === 'page') pgTb.classList.add('edit-mode');
    else pgTb.classList.remove('edit-mode');
  }
  // Show/hide attach bars for notes/cornell/mindmap
  if (window._bjRefreshAttachBars) {
    const ae = getActive();
    _bjRefreshAttachBars(ae ? ae.template : null, enabled);
  }
  document.querySelectorAll('.tag-del').forEach(el => {
    el.style.display = enabled ? '' : 'none';
  });
  const addTagInput = document.getElementById('bj-add-tag-input');
  if (addTagInput) addTagInput.style.display = enabled ? '' : 'none';
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

  /* bj-btn-template */
  fastTouch(document.getElementById('bj-btn-template'), function() {
    var entry = getActive();
    if (!entry) { alert('Create a new entry first.'); return; }
    document.getElementById('bj-new-entry-btn')._creating = false;
    document.getElementById('bj-template-modal').classList.add('open');
  });

  /* bj-btn-export-pdf */
  (function() {
    var bjExportBtn = document.getElementById('bj-btn-export-pdf');
    if (bjExportBtn) bjExportBtn.onclick = function() {
      var entry = getActive();
      if (!entry) { alert('No entry selected.'); return; }
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

  fastTouch(document.getElementById('bj-bb-template'), function() {
    var entry = getActive();
    if (!entry) { alert('Create a new entry first.'); return; }
    document.getElementById('bj-new-entry-btn')._creating = false;
    document.getElementById('bj-template-modal').classList.add('open');
  });

  fastTouch(document.getElementById('bj-bb-new'), function() {
    document.getElementById('bj-new-entry-btn')._creating = true;
    document.getElementById('bj-template-modal').classList.add('open');
  });
})();

/* TOOLBAR — mouse/keyboard change handler (touchstart path handled above) */
document.getElementById('bj-btn-edit').addEventListener('change', function() { setEditMode(this.checked); });
/* bj-btn-template click handled by fastTouch above */
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
document.getElementById('bj-search-box').addEventListener('input', renderSidebar);

loadState(); purgeExpiredTrash(); renderSidebar(); loadActiveEntry(); setEditMode(false);

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
  bjTagFilters = [];
  var sb = document.getElementById('bj-search-box'); if (sb) sb.value = '';
  window.OJ.enter('bj');
  _bjModeUI();
  renderSidebar(); loadActiveEntry();
}
function _bjOJLeave() {
  if (!_bjIsOJ()) return;
  try { saveCurrentEntry(); } catch (e) {}
  try { if (window._bjFlushBoards) window._bjFlushBoards(); } catch (e) {}
  state = _bjPersonal; _bjPersonal = null;
  if (window.OJ) window.OJ.leave('bj');
  bjTagFilters = [];
  var sb = document.getElementById('bj-search-box'); if (sb) sb.value = '';
  // The entry that was open may have been deleted elsewhere in the meantime.
  if (state.activeId && !state.entries.some(function(e) { return e.id === state.activeId && !e.trashed; })) {
    state.activeId = (state.entries.find(function(e) { return !e.trashed; }) || {}).id || null;
  }
  _bjModeUI();
  renderSidebar(); loadActiveEntry();
}
window._bjOJ = { enter: _bjOJEnter, leave: _bjOJLeave, active: _bjIsOJ };
(function() {
  if (!window.OJ) return;
  _bjOJState = window.OJ.register('bj', {
    shown: function() { return _bjIsOJ(); },
    render: function() { if (_bjIsOJ()) renderSidebar(); },
    reload: function() { if (_bjIsOJ()) loadActiveEntry(); },
    editor: function() { return document.getElementById('bj-page-editor'); },
    pageOwned: function(id) { var e = _bjIsOJ() ? getActive() : null; return !!(e && e.id === id && e.template === 'page' && _bjDomOwner === id); },
    titleInput: function() { return document.getElementById('bj-entry-title-input'); },
    renderTags: function(t) { if (_bjIsOJ()) renderTags(t); },
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
      '<button class="oj-tab" data-oj="0" role="tab" title="Brainstorm Journal — your own entries">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2.5Z"/><path d="M8 7h7"/></svg>' +
        '<span class="oj-lbl">Journal</span></button>';
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
  bjIsMobile = window.innerWidth <= 768;
  // Fix wb size slider: vertical on desktop, horizontal on mobile
  var slider = document.getElementById('bj-wb-size');
  if (slider) {
    if (bjIsMobile) {
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

/* Patch saveState to show mobile saved indicator */
var bjBbSaved = document.getElementById('bj-bb-saved');
var _origSaveState = saveState;
saveState = function() {
  _origSaveState();
  if (bjBbSaved) {
    bjBbSaved.style.opacity = '1';
    clearTimeout(bjBbSaved._t);
    bjBbSaved._t = setTimeout(function() { bjBbSaved.style.opacity = '0'; }, 2000);
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
  var tags = (entry.tags || []).length ? entry.tags.join(', ') : '';

  // The legacy mind map draws itself onto a 2D canvas, so its own bitmap is the
  // export — exactly as it was before the rebuild.
  if (entry.template === 'mindmap-legacy') {
    var mmCv = document.getElementById('bj-mml-canvas');
    if (!mmCv) { window.uiAlert('Open this mind map before exporting it to PDF.', { title: 'Nothing to export' }); return; }
    var mmlHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + _bjEsc(_bjPdfName(title)) + '</title>'
      + '<style>body{margin:0;background:#fff;}img{max-width:100%;display:block;}h1{font-family:serif;font-size:18px;margin:16px;}p{font-family:sans-serif;font-size:12px;color:#666;margin:0 16px 12px;}</style>'
      + '</head><body>'
      + '<h1>' + _bjEsc(title) + '</h1>'
      + '<p>' + _bjEsc(date) + (tags ? ' &middot; ' + _bjEsc(tags) : '') + '</p>'
      + '<img src="' + mmCv.toDataURL('image/png') + '" />'
      + '</body></html>';
    _bjOpenPrintBlob(mmlHtml);
    return;
  }

  // Visual templates: ask the live board to render itself. Both engines export
  // at their own resolution with a light background, so the printed page is a
  // clean image of the work rather than a screenshot of a dark UI.
  if (entry.template === 'whiteboard' || entry.template === 'mindmap') {
    var _vbrd = _bjBoards[entry.template === 'whiteboard' ? 'wb' : 'mm'];
    if (!_vbrd || !_vbrd.isOpen(entry.id)) {
      window.uiAlert('Open this ' + (entry.template === 'whiteboard' ? 'whiteboard' : 'mind map') + ' before exporting it to PDF.', { title: 'Nothing to export' });
      return;
    }
    _vbrd.toPngDataUrl().then(function (dataURL) {
      var vHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + _bjEsc(_bjPdfName(title)) + '</title>'
        + '<style>body{margin:0;background:#fff;}img{max-width:100%;display:block;}h1{font-family:serif;font-size:18px;margin:16px;}p{font-family:sans-serif;font-size:12px;color:#666;margin:0 16px 12px;}@media print{h1,p{display:block;}}</style>'
        + '</head><body>'
        + '<h1>' + _bjEsc(title) + '</h1>'
        + '<p>' + _bjEsc(date) + (tags ? ' &middot; ' + _bjEsc(tags) : '') + '</p>'
        + (dataURL ? '<img src="' + dataURL + '" />' : '<p style="color:#aaa;font-style:italic;padding:16px;">This board is empty.</p>')
        + '</body></html>';
      _bjOpenPrintBlob(vHtml);
    });
    return;
  }

  // Text-based templates: build styled HTML print page
  var bodyHTML = '';
  if (entry.template === 'page') {
    bodyHTML = '<div class="page-content">' + (window._docxPdfBlackText ? window._docxPdfBlackText(entry.data.html || '') : (entry.data.html || '')) + '</div>';
  } else if (entry.template === 'notes') {
    bodyHTML = _bjPdfSection('Main Notes', entry.data.main || '');
    if (entry.data.links) bodyHTML += _bjPdfSection('Links & Resources', entry.data.links);
    if (entry.data.questions) bodyHTML += _bjPdfSection('Questions', entry.data.questions);
  } else if (entry.template === 'cornell') {
    bodyHTML += _bjPdfSection('Topic', entry.data.topic || '');
    bodyHTML += '<div style="display:flex;gap:20px;margin-top:16px;">';
    bodyHTML += '<div style="flex:1;min-width:0;">' + _bjPdfSection('Cues / Keywords', entry.data.cues || '') + '</div>';
    bodyHTML += '<div style="flex:2.5;min-width:0;">' + _bjPdfSection('Notes', entry.data.notes || '') + '</div>';
    bodyHTML += '</div>';
    bodyHTML += _bjPdfSection('Summary', entry.data.summary || '');
  }

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + _bjEsc(_bjPdfName(title)) + '</title><style>'
    + 'body{font-family:Georgia,serif;max-width:750px;margin:32px auto;color:#1a1a2e;font-size:14px;line-height:1.7;padding:0 24px;}'
    + 'h1{font-size:22px;font-weight:700;margin:0 0 6px;color:#2d1b4e;}'
    + '.meta{font-size:11px;color:#888;font-family:sans-serif;margin-bottom:20px;}'
    + '.tag{background:#ede9f4;color:#6b4fa0;border-radius:4px;padding:2px 8px;margin-left:4px;font-size:10px;font-weight:700;}'
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
    + (tags ? tags.split(',').map(function(t){ return '<span class="tag">' + _bjEsc(t.trim()) + '</span>'; }).join('') : '')
    + '</div><hr/>'
    + bodyHTML
    + (/docx-math/.test(bodyHTML) && window._docxExportMathScript ? window._docxExportMathScript() : '')
    + '</body></html>';

  _bjOpenPrintBlob(html);
}

function _bjEsc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _bjPdfSection(label, text) {
  return '<div class="section"><div class="section-label">' + _bjEsc(label) + '</div><div class="section-body">' + _bjEsc(text) + '</div></div>';
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
// BJ LOCK SYSTEM (Veda's Brainstorm Journal)
// ══════════════════════════════════════════
// What the rest of the app needs from the lock code (the sidebar's delete).
var _bjLock = null;
(function() {
  // Lock data stored on entry.lock = {hash, plain} → syncs to Firebase via saveState()
  // Per-device unlock session stored in localStorage (not synced — each device must unlock once)
  // Auth worker base URL (same worker as reminders)
  var BJ_AUTH = 'https://taskhub-reminders.av1.workers.dev';
  var _bjUnlocked = {};
  function blGetLock(id) {
    var entry = state.entries.find(function(e) { return e.id === id; });
    // locked = entry has lock marker (no longer stores hash/plain locally)
    return (entry && entry.lock) ? entry.lock : null;
  }
  // Version stamp: bumped whenever the password is set/changed/reset so every other
  // device must re-enter the new password once (like MyList / app-locks).
  function blLockVersion(id) {
    var entry = state.entries.find(function(e) { return e.id === id; });
    return (entry && entry.lock && entry.lock.v) || 0;
  }
  // blSetLock marks the entry locked and stamps a version (fresh unless one is passed).
  function blSetLock(id, v) {
    var entry = state.entries.find(function(e) { return e.id === id; });
    if (!entry) return;
    entry.lock = { locked: true, v: v || Date.now() };
    entry.updated = Date.now();
    saveState();
  }
  function blRemoveLock(id) {
    var entry = state.entries.find(function(e) { return e.id === id; });
    if (!entry) return;
    delete entry.lock;
    entry.updated = Date.now();
    saveState();
  }
  
  // Once per device, forever — same monotonic rule as the app-locks (see
  // alIsUnlocked). blLockVersion() reads entry.lock.v out of Firebase-synced
  // state, so it can briefly read 0 or an older value while a sync is in flight;
  // an exact-match test turned each of those into a spurious password prompt.
  // Comparing "version I unlocked at" >= "version I now see" is stable under
  // stale reads and still re-locks on a real password change (strictly newer v).
  function _blUnlockAt(id) {
    var best = (_bjUnlocked[id] !== undefined) ? _bjUnlocked[id] : -1;
    var read = function(store, key) {
      try {
        var raw = store.getItem(key); if (raw === null) return;
        var s = String(raw), n = parseInt(s.charAt(0)==='v' ? s.slice(1) : s, 10);
        if (!isNaN(n)) { if (n > best) best = n; }
        else if (best < 0) best = 0;
      } catch(e) {}
    };
    read(localStorage,'bj_unlockedat_'+id); read(sessionStorage,'bj_unlockedat_'+id);
    read(localStorage,'bj_unlockedv_'+id);  read(sessionStorage,'bj_unlockedv_'+id);
    try { if ((localStorage.getItem('bj_unlocked_'+id)==='1'||sessionStorage.getItem('bj_unlocked_'+id)==='1') && best < 0) best = 0; } catch(e) {}
    return best;
  }
  function blIsUnlocked(id) {
    var at = _blUnlockAt(id);
    if (at < 0) return false;
    return at >= blLockVersion(id);
  }
  function blMarkUnlocked(id) {
    var v = blLockVersion(id), prev = _blUnlockAt(id);
    if (prev > v) v = prev;                     // never regress on a stale read
    _bjUnlocked[id] = v;
    try{localStorage.setItem('bj_unlockedat_'+id,String(v));}catch(e){}
    try{sessionStorage.setItem('bj_unlockedat_'+id,String(v));}catch(e){}
    try{localStorage.setItem('bj_unlockedv_'+id,'v'+v);}catch(e){}
    try{localStorage.setItem('bj_unlocked_'+id,'1');}catch(e){}
  }
  function blMarkLocked(id) {
    delete _bjUnlocked[id];
    try{localStorage.removeItem('bj_unlocked_'+id);localStorage.removeItem('bj_unlockedv_'+id);localStorage.removeItem('bj_unlockedat_'+id);}catch(e){}
    try{sessionStorage.removeItem('bj_unlocked_'+id);sessionStorage.removeItem('bj_unlockedv_'+id);sessionStorage.removeItem('bj_unlockedat_'+id);}catch(e){}
  }


  var overlay = document.getElementById('bj-lock-overlay');
  var lockBtn = document.getElementById('bj-btn-lock');
  var mobileLockBtn = document.getElementById('bj-mobile-lock-btn');
  var pwInput = document.getElementById('bj-lock-pw');
  var submitBtn = document.getElementById('bj-lock-submit');
  var errEl = document.getElementById('bj-lock-err');
  var forgotBtn = document.getElementById('bj-lock-forgot');
  var resetBtn = document.getElementById('bj-lock-reset');
  var lockIcon = document.getElementById('bj-lock-icon');
  var lockTitle = document.getElementById('bj-lock-title');
  var lockSub = document.getElementById('bj-lock-sub');
  var cancelBtn = document.getElementById('bj-lock-cancel');
  var boxEl = document.getElementById('bj-lock-box');
  var menuEl = document.getElementById('bj-lock-menu');
  var inputWrap = document.getElementById('bj-lock-input-wrap');
  var bioEl = document.getElementById('bj-lock-bio');
  var blMode = 'unlock';
  var _blRemoveBioId = null;   // when set to an entry id, a successful unlock removes that entry's biometric

  // ── BIOMETRICS (Face ID / Touch ID / fingerprint / Windows Hello) ──
  // Primary unlock per entry; the password stays available as the fallback.
  // Keyed by entry id under the 'bj' namespace → each entry keeps its own credential.
  function blBioShowInput(show) {
    pwInput.style.display = show ? '' : 'none';
    submitBtn.style.display = show ? '' : 'none';
    forgotBtn.style.display = show ? '' : 'none';
    if (resetBtn) resetBtn.style.display = show ? '' : 'none';
    if (show) setTimeout(function() { pwInput.focus(); }, 60);
  }
  var _blBioSeq = 0;   // newest render wins: two quick opens used to draw the buttons twice
  function blBioRender() {
    if (!bioEl) return; bioEl.innerHTML = ''; bioEl.style.display = 'none';
    var seq = ++_blBioSeq;
    if (!window.Bio || blMode !== 'unlock') return;
    var id = state.activeId; if (!id) return;
    window.Bio.available().then(function(avail) {
      if (blMode !== 'unlock' || state.activeId !== id) return;
      if (seq !== _blBioSeq) return;
      bioEl.innerHTML = '';
      var had = window.Bio.isRegistered('bj', id);
      if (!(avail && window.Bio.isRegistered('bj', id, blLockVersion(id)))) { if (avail && had) blBioStaleMsg(); return; }
      bioEl.style.display = 'flex'; bioEl.style.flexDirection = 'column'; bioEl.style.gap = '8px'; bioEl.style.marginBottom = '10px';
      var b = document.createElement('button'); b.className = 'tl-btn';
      b.innerHTML = TNI.unlock + '<span>Unlock with ' + window.Bio.label() + '</span>';
      b.onclick = function() { blBioUnlock(); };
      bioEl.appendChild(b);
      // The password field stays visible alongside it: biometrics run ONLY when
      // this button is pressed, so either route is available at all times.
      blBioShowInput(true);
    });
  }
  function blBioUnlock() {
    errEl.textContent = '';
    var id = state.activeId; if (!id || !window.Bio) return;
    window.Bio.authenticate('bj', id, { v: blLockVersion(id) }).then(function(r) {
      if (r.ok) {
        if (_blRemoveBioId === id) { blDoRemoveBio(id); return; }
        blMarkUnlocked(id); blHideOverlay(); blUpdateLockBtn(); try { loadActiveEntry(); renderSidebar(); } catch(e) {}
      }
      else if (r.error === 'stale') { blBioStaleMsg(); }
      else if (r.error === 'notregistered') { blBioShowInput(true); }
      else { errEl.textContent = 'Biometric check failed — use your password.'; blBioShowInput(true); }
    });
  }
  // The password changed since this device enrolled, so its biometric no longer
  // opens the entry (Bio drops it): say why, and fall back to the password.
  function blBioStaleMsg() {
    if (bioEl) { bioEl.innerHTML = ''; bioEl.style.display = 'none'; }
    errEl.textContent = 'The password changed — enter the new one. ' + window.Bio.label() + ' needs registering again on this device.';
    blBioShowInput(true);
  }
  // After the password proves who this is: if a password change dropped this
  // device's biometric (or this device just changed it), offer to enrol again.
  function blBioAfterPw(id, hadBio) {
    if (!window.Bio) return;
    if (window.Bio.takeStale('bj', id) || hadBio) blMaybeOfferBio(id);
  }
  function blHadBio(id) { return !!(window.Bio && window.Bio.isRegistered('bj', id)); }
  // Verify identity (biometric OR password) before removing this entry's biometric.
  function blBioRemovePrompt(id) {
    blShowOverlay('unlock');
    _blRemoveBioId = id;
    lockIcon.innerHTML = TNI.user;
    lockSub.textContent = 'Verify with ' + window.Bio.label() + ' or your password to remove biometrics from this device.';
  }
  function blDoRemoveBio(id) {
    _blRemoveBioId = null;
    window.Bio.unregister('bj', id);
    blHideOverlay(); blUpdateLockBtn();
    window.uiAlert('Biometrics removed from this device.');
  }
  function blBioRegister(id, closeAfter) {
    if (!window.Bio) return;
    window.Bio.register('bj', id, { rpName: 'Brainstorm Journal', userName: 'bj-' + id, displayName: 'Journal entry — Brainstorm Journal', v: blLockVersion(id) }).then(function(r) {
      if (r.ok) { blMarkUnlocked(id); if (closeAfter) { blHideOverlay(); blUpdateLockBtn(); try { loadActiveEntry(); renderSidebar(); } catch(e) {} } alert('Biometrics registered on this device. You can now unlock this entry with ' + window.Bio.label() + '.'); }
      else if (!(r.error === 'cancelled' || r.error === 'NotAllowedError')) alert('Could not register biometrics on this device.');
    });
  }
  function blMaybeOfferBio(id) {
    if (!window.Bio) return;
    window.Bio.available().then(function(avail) {
      if (!avail || window.Bio.isRegistered('bj', id, blLockVersion(id))) return;
      window.uiConfirm('Register ' + window.Bio.label() + ' to unlock this entry on this device? Your password still works as a fallback.', { title: 'Register ' + window.Bio.label(), okLabel: 'Register' }).then(function(ok) { if (ok) blBioRegister(id, false); });
    });
  }

  // modes: 'setpw' | 'unlock' | 'remove' | 'changepw'
  function blShowOverlay(mode) {
    blMode = mode;
    overlay.style.display = 'flex';
    if (menuEl) { menuEl.innerHTML = ''; menuEl.style.display = 'none'; }
    if (inputWrap) inputWrap.style.display = '';
    if (bioEl) { bioEl.innerHTML = ''; bioEl.style.display = 'none'; }
    _blRemoveBioId = null;   // cleared on any normal open; blBioRemovePrompt re-sets it after
    errEl.textContent = '';
    pwInput.value = '';
    pwInput.style.display = '';   // restore in case a prior biometric prompt hid it
    pwInput.classList.remove('error');
    submitBtn.style.display = '';
    cancelBtn.style.display = '';
    forgotBtn.style.display = '';
    if (resetBtn) resetBtn.style.display = '';
    // Same SVG icon set MyJournal uses — emoji render as flat black glyphs on
    // most phones, which is unreadable on this dark overlay.
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
    blBioRender();
  }

  function blHideOverlay() {
    overlay.style.display = 'none';
    if (menuEl) { menuEl.innerHTML = ''; menuEl.style.display = 'none'; }
    if (inputWrap) inputWrap.style.display = '';
    if (bioEl) { bioEl.innerHTML = ''; bioEl.style.display = 'none'; }
    _blRemoveBioId = null;
  }

  function blLockErr(msg) {
    errEl.textContent = msg;
    pwInput.value = '';
    pwInput.classList.add('error');
    if (boxEl) { boxEl.classList.remove('shake'); void boxEl.offsetWidth; boxEl.classList.add('shake'); }
    setTimeout(function() { pwInput.classList.remove('error'); }, 450);
  }

  function _blMenuBtn(parent, label, cls, fn, beforeEl) {
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
  function blShowMenu(entry) {
    overlay.style.display = 'flex';
    errEl.textContent = '';
    pwInput.value = '';
    pwInput.classList.remove('error');
    if (bioEl) { bioEl.innerHTML = ''; bioEl.style.display = 'none'; }
    // Shared SVG icon set, not emoji: 🔒/🔓/🔑 render as flat black text glyphs
    // on most phones, so they were unreadable against the button fill.
    lockIcon.innerHTML = TNI.lock;
    lockTitle.textContent = 'Locked Entry';
    lockSub.textContent = 'Manage lock for this entry.';
    if (inputWrap) inputWrap.style.display = 'none';
    forgotBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';
    var m = menuEl; m.innerHTML = ''; m.style.display = 'flex';
    if (!blIsUnlocked(entry.id)) {
      _blMenuBtn(m, TNI.unlock + '<span>Unlock this entry</span>', '', function() { blShowOverlay('unlock'); });
    } else {
      _blMenuBtn(m, TNI.lock + '<span>Lock this entry now</span>', '', function() { blMarkLocked(entry.id); blHideOverlay(); blUpdateLockBtn(); blCheckEntry(); });
    }
    var changeBtn = _blMenuBtn(m, TNI.key + '<span>Change password</span>', 'ghost', function() { blShowOverlay('changepw'); });
    _blMenuBtn(m, TNI.trash + '<span>Remove lock</span>', 'danger', function() { blShowOverlay('remove'); });
    _blMenuBtn(m, 'Close', 'ghost', function() { blDismiss(); });
    if (window.Bio) window.Bio.available().then(function(avail) {
      if (!avail || state.activeId !== entry.id) return;
      if (window.Bio.isRegistered('bj', entry.id, blLockVersion(entry.id)))
        _blMenuBtn(m, TNI.user + '<span>Remove biometrics</span>', 'ghost', function() { blBioRemovePrompt(entry.id); }, changeBtn);
      else
        _blMenuBtn(m, TNI.user + '<span>Register ' + window.Bio.label() + '</span>', '', function() { blBioRegister(entry.id, true); }, changeBtn);
    });
  }

  // Dismiss the overlay — but if the entry is still locked & not unlocked on this
  // device, stay gated (never expose content) by falling back to the unlock prompt.
  function blDismiss() {
    var entry = state.entries.find(function(e) { return e.id === state.activeId; });
    if (entry && blGetLock(entry.id) && !blIsUnlocked(entry.id)) { blShowOverlay('unlock'); }
    else { blHideOverlay(); }
  }

  function blManage() {
    var entry = state.entries.find(function(e) { return e.id === state.activeId; });
    if (!entry) return;
    var lock = blGetLock(entry.id);
    if (!lock) { blShowOverlay('setpw'); return; }
    blShowMenu(entry);
  }

  cancelBtn && cancelBtn.addEventListener('click', function() { blDismiss(); });

  function blUpdateLockBtn() {
    var entry = state.entries.find(function(e) { return e.id === state.activeId; });
    if (!entry) {
      lockBtn.style.display = 'none';
      if (mobileLockBtn) mobileLockBtn.style.display = 'none';
      return;
    }
    lockBtn.style.display = '';
    if (mobileLockBtn) mobileLockBtn.style.display = '';
    var lock = blGetLock(entry.id);
    if (lock) {
      lockBtn.classList.add('locked');
      lockBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Locked';
      // SVG + a class, not an emoji + inline colour: 🔒/🔓 render as a flat black
      // text glyph on most phones, and the inline colour left the unlocked state
      // inheriting the UA's black buttontext.
      if (mobileLockBtn) { mobileLockBtn.innerHTML = TNI.lock; mobileLockBtn.classList.add('tl-locked'); mobileLockBtn.style.color = ''; }
    } else {
      lockBtn.classList.remove('locked');
      lockBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Lock';
      if (mobileLockBtn) { mobileLockBtn.innerHTML = TNI.unlock; mobileLockBtn.classList.remove('tl-locked'); mobileLockBtn.style.color = ''; }
    }
  }

  function _blHandleLockClick() { blManage(); }
  mobileLockBtn && mobileLockBtn.addEventListener('click', _blHandleLockClick);
  lockBtn && lockBtn.addEventListener('click', _blHandleLockClick);

  function blCheckEntry() {
    var entry = state.entries.find(function(e) { return e.id === state.activeId; });
    blUpdateLockBtn();
    if (!entry) { blHideOverlay(); return; }
    var lock = blGetLock(entry.id);
    if (lock && !blIsUnlocked(entry.id)) {
      blShowOverlay('unlock');
    } else {
      blHideOverlay();
    }
  }

  // Every lock call went through a bare fetch+res.json() inside one try/catch
  // that reported "Network error" for anything that threw — including a server
  // that answered with an HTML error page. Tag the failure so the message can
  // tell the truth about what actually went wrong.
  async function blAuthPost(path, body) {
    if (navigator.onLine === false) { var offErr = new Error('offline'); offErr._offline = true; throw offErr; }
    var res;
    try { res = await fetch(BJ_AUTH + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { var netErr = new Error('unreachable'); netErr._offline = true; throw netErr; }
    var txt = await res.text();
    try { return JSON.parse(txt); }
    catch (e) { var srvErr = new Error('bad response'); srvErr._status = res.status; throw srvErr; }
  }
  // The server is the source of truth for locks. If it reports no lock for this
  // entry, the local marker is stale (typically the entry was deleted and
  // re-synced) — clear it and let the user in rather than trapping them behind
  // a password that nothing on the server can verify.
  // The message for a lock call that threw (see blAuthPost).
  function blErrText(e) {
    return e && e._offline
      ? 'No connection. Check your network and try again.'
      : (e && e._status ? 'Lock server error (' + e._status + '). Try again.' : 'Could not reach the lock server. Try again.');
  }
  _bjLock = { post: blAuthPost, isUnlocked: blIsUnlocked, errText: blErrText };
  function blDropStaleLock(entry) {
    blRemoveLock(entry.id); blMarkUnlocked(entry.id);
    blHideOverlay(); blUpdateLockBtn();
    try { loadActiveEntry(); renderSidebar(); } catch (e) {}
  }

  submitBtn && submitBtn.addEventListener('click', async function() {
    var entry = state.entries.find(function(e) { return e.id === state.activeId; });
    if (!entry) return;
    var pw = pwInput.value.trim();
    if (!pw) { pwInput.classList.add('error'); errEl.textContent = 'Password required.'; return; }
    submitBtn.disabled = true; var _prev = submitBtn.textContent; submitBtn.textContent = 'Checking…';
    var lock = blGetLock(entry.id);
    try {
      if (!lock || blMode === 'setpw') {
        // Setting a new password — ask for hint first
        var hint = (await window.uiPrompt('Optional: enter a password hint (visible in the recovery email, never the password itself). Leave blank to skip.', {title:'Password hint'})) || '';
        var data = await blAuthPost('/auth/journal/set-lock', { journal: 'bj', entryId: entry.id, password: pw, hint: hint });
        if (data.ok) { blSetLock(entry.id); blMarkUnlocked(entry.id); blHideOverlay(); blUpdateLockBtn(); renderSidebar(); blMaybeOfferBio(entry.id); }
        else errEl.textContent = 'Failed to set lock. Try again.';
      } else if (blMode === 'remove') {
        var data2 = await blAuthPost('/auth/journal/remove-lock', { journal: 'bj', entryId: entry.id, password: pw });
        if (data2.ok) { blRemoveLock(entry.id); blMarkLocked(entry.id); blHideOverlay(); blUpdateLockBtn(); renderSidebar(); }
        else blLockErr('Wrong password.');
      } else if (blMode === 'changepw') {
        var data3 = await blAuthPost('/auth/journal/verify', { journal: 'bj', entryId: entry.id, password: pw });
        if (data3.ok) {
          var chg = await window.uiForm({ title:'Change password', okLabel:'Change password',
            fields:[ {name:'password',label:'New password',type:'password',required:true}, {name:'hint',label:'New password hint (optional)'} ] });
          var np = chg ? chg.password : '';
          if (np && np.trim()) {
            var nh = (chg.hint) || '';
            var sd = await blAuthPost('/auth/journal/set-lock', { journal: 'bj', entryId: entry.id, password: np.trim(), hint: nh, current: pw });
            if (sd.ok) { var hadBio = blHadBio(entry.id); blSetLock(entry.id); blMarkUnlocked(entry.id); blHideOverlay(); blUpdateLockBtn(); renderSidebar(); blBioAfterPw(entry.id, hadBio); }
            else errEl.textContent = 'Failed to set new password.';
          } else errEl.textContent = 'New password empty.';
        } else blLockErr('Wrong password.');
      } else {
        // unlock
        var data4 = await blAuthPost('/auth/journal/verify', { journal: 'bj', entryId: entry.id, password: pw });
        if (data4.ok) {
          if (_blRemoveBioId === entry.id) { blDoRemoveBio(entry.id); }
          else { blMarkUnlocked(entry.id); blHideOverlay(); blUpdateLockBtn(); try { loadActiveEntry(); renderSidebar(); } catch(e) {} blBioAfterPw(entry.id, false); }
        } else if (data4.noLock) {
          blDropStaleLock(entry);
        } else blLockErr('Wrong password.');
      }
    } catch(e) {
      errEl.textContent = blErrText(e);
    }
    submitBtn.disabled = false; submitBtn.textContent = _prev;
  });

  pwInput && pwInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') submitBtn.click();
    if (e.key === 'Escape') {
      errEl.textContent = '';
      pwInput.classList.remove('error');
    }
  });

  // Forgot password — fetches hint from Worker, emails via Formspree from client
  forgotBtn && forgotBtn.addEventListener('click', async function() {
    var entry = state.entries.find(function(e) { return e.id === state.activeId; });
    if (!entry) return;
    var lock = blGetLock(entry.id);
    if (!lock) { errEl.textContent = 'No lock set on this entry.'; return; }
    forgotBtn.textContent = 'Sending...';
    forgotBtn.disabled = true;
    try {
      // The worker mails the hint and no longer returns its text, so the page
      // never handles it. journal:'bj' is what routes this to Veda's inbox —
      // the entry id is random and carries no owner (see JOURNAL_OWNER in the
      // worker), so removing it here would silently send her hints to Tony.
      var hintRes = await fetch(BJ_AUTH + '/auth/journal/hint', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          journal: 'bj', entryId: entry.id, owner: 'veda',
          appName: 'Brainstorm Journal',
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

  // Reset password via emailed security code (Brainstorm Journal → Veda's email).
  resetBtn && resetBtn.addEventListener('click', async function() {
    var entry = state.entries.find(function(e) { return e.id === state.activeId; });
    if (!entry) return;
    if (!blGetLock(entry.id)) { errEl.textContent = 'No lock set on this entry.'; return; }
    var prev = resetBtn.textContent; resetBtn.textContent = 'Sending code…'; resetBtn.disabled = true;
    await window._pwReset({
      worker: BJ_AUTH,
      reqBody: { journal: 'bj', entryId: entry.id },
      // The worker picks the mailbox; `owner` states it outright rather than
      // leaning on the journal lookup. `email` is now only display text.
      owner: 'veda',
      email: 'vedaapatel1605@gmail.com',
      appName: 'Brainstorm Journal',
      label: 'entry "' + (entry.title || 'Untitled') + '"',
      onSuccess: function() {
        var hadBio = blHadBio(entry.id);
        blSetLock(entry.id); blMarkUnlocked(entry.id); blHideOverlay(); blUpdateLockBtn();
        blBioAfterPw(entry.id, hadBio);
        try { loadActiveEntry(); renderSidebar(); } catch(e) {}
      }
    });
    resetBtn.textContent = prev; resetBtn.disabled = false;
  });

  // Patch loadActiveEntry to run lock check after loading
  var _origLoadActive = loadActiveEntry;
  loadActiveEntry = function() {
    _origLoadActive.apply(this, arguments);
    blCheckEntry();
  };

  // Run immediately so the first entry loaded before this patch executes is also gated
  blCheckEntry();

  // Patch renderSidebar to show lock badge
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

  window._bjGetLock = blGetLock;
  window._bjIsUnlocked = blIsUnlocked;
  window._bjLockCheck = blCheckEntry;
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
  aiProfile: 'veda', bindImg: '_bjBindImg'
});
