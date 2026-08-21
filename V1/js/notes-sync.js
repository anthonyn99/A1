/* ============================================================================
 * StudyOS Notes — Word-style page editor host glue.
 * ============================================================================
 * Drives the shared docx-engine.js ("so" app) for the per-module Notes type.
 * Structurally mirrors Brainstorm Journal's own host glue in TradeBoard's
 * index.html (state / CRUD / sidebar / autosave / image-insert), trimmed to
 * the Page template only — StudyOS's Notes module never offered Whiteboard /
 * Cornell / Mind Map, so those template branches are not ported.
 *
 * Unlike Brainstorm Journal (one global entries list app-wide), each StudyOS
 * Notes module owns its OWN independent page list, scoped by module id — a
 * Notes module in one Class doesn't share pages with a Notes module in
 * another Class or in KSU. See openNotesModule() below.
 *
 * Firestore: one doc per module at dashboards/studyos_notes/{moduleId},
 * written via window._fbSaveJournal / _fbSaveJournalEntry / _fbSaveJournalOrder
 * — the exact contract docx-engine.js already calls through APPS.so.trashAPI
 * and the AI-format prompt hooks. See the bottom of this file for the
 * Firestore layer itself.
 * ========================================================================== */
(function(){
'use strict';

const SO_TRASH_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days, matches bj/tj

// Per-module state cache: moduleId -> { entries: [...], activeId, deletedIds: [...] }
let _soStates = {};
let _soCurrentModuleId = null;   // which module's page-list is currently mounted
let _soCurrentClassId = null;    // classId or 'ksu', for persistForCls() routing
let isEditMode = false;
let autoTimer = null;
let soTagFilters = [];

function _soState() {
  if (!_soCurrentModuleId) return { entries: [], activeId: null, deletedIds: [] };
  if (!_soStates[_soCurrentModuleId]) _soStates[_soCurrentModuleId] = { entries: [], activeId: null, deletedIds: [] };
  return _soStates[_soCurrentModuleId];
}
function getActive() {
  const st = _soState();
  return st.entries.find(e => e.id === st.activeId) || null;
}

/* ── Sync status pill (mirrors _bjSetSync) ── */
let _soSyncResetTimer = null;
window._soSetSync = function(status) {
  const pill = document.getElementById('so-sync-pill');
  const txt = document.getElementById('so-sync-text');
  if (!pill || !txt) return;
  pill.className = 'bj-sync-pill bj-sync-' + status;
  const labels = { idle: 'Saved', syncing: 'Saving…', synced: 'Synced', error: 'Sync Failed' };
  txt.textContent = labels[status] || status;
  if (status === 'synced') {
    clearTimeout(_soSyncResetTimer);
    _soSyncResetTimer = setTimeout(() => window._soSetSync('idle'), 4000);
  }
};

/* ── Local cache (per module, keyed by moduleId) ── */
function _soCacheKey(modId) { return 'studyos_notes_' + modId; }
function loadModuleState(modId) {
  if (_soStates[modId]) return _soStates[modId];
  let st = { entries: [], activeId: null, deletedIds: [] };
  try {
    const r = localStorage.getItem(_soCacheKey(modId));
    if (r) st = JSON.parse(r);
  } catch (e) {}
  if (!Array.isArray(st.deletedIds)) st.deletedIds = [];
  _soStates[modId] = st;
  return st;
}
function _soWriteCache() {
  if (!_soCurrentModuleId) return;
  try { localStorage.setItem(_soCacheKey(_soCurrentModuleId), JSON.stringify(_soState())); }
  catch (e) {}
}
function saveState() {
  _soWriteCache();
  window._soSetSync('syncing');
  if (window._fbSaveJournal) {
    const modId = _soCurrentModuleId;
    const st = _soState();
    const sid = st.activeId;
    window._fbSaveJournal(modId, () => ({ entries: st.entries, activeId: sid }));
  }
}
function autoSave() { window._soSetSync('syncing'); clearTimeout(autoTimer); autoTimer = setTimeout(saveCurrentEntry, 700); }

/* ── CRUD ── */
function createEntry() {
  const id = 'e_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const entry = { id, title: '', template: 'page', created: Date.now(), updated: Date.now(), tags: [], data: { html: '', attachments: [] } };
  const st = _soState();
  st.entries.unshift(entry);
  st.activeId = id;
  return entry;
}
function deleteEntry(id) {
  const st = _soState();
  const entry = st.entries.find(e => e.id === id);
  if (!entry) return;
  const ts = Date.now();
  entry.trashed = ts;
  entry.trashChangedAt = ts;
  entry.updated = ts;
  if (st.activeId === id) st.activeId = (st.entries.find(e => !e.trashed) || {}).id || null;
  saveState(); renderSoSidebar(); loadActiveEntry();
  if (window._fbSaveJournalEntry) window._fbSaveJournalEntry(_soCurrentModuleId, entry, st.entries);
}
function hardDeleteEntry(id) {
  const st = _soState();
  if (!st.deletedIds.includes(id)) st.deletedIds.push(id);
  if (window._fbDeleteJournalEntry) window._fbDeleteJournalEntry(_soCurrentModuleId, id);
  st.entries = st.entries.filter(e => e.id !== id);
  if (st.activeId === id) st.activeId = (st.entries.find(e => !e.trashed) || {}).id || null;
  saveState(); renderSoSidebar(); loadActiveEntry();
}
function purgeExpiredTrash() {
  const st = _soState();
  const cutoff = Date.now() - SO_TRASH_TTL;
  st.entries.filter(e => e.trashed && e.trashed < cutoff).map(e => e.id).forEach(hardDeleteEntry);
}
window._soTrashAPI = {
  list: () => _soState().entries.filter(e => e.trashed).sort((a, b) => (b.trashed || 0) - (a.trashed || 0)),
  restore: (ids) => {
    const st = _soState();
    (ids || []).forEach(id => {
      const e = st.entries.find(x => x.id === id);
      if (e) {
        const ts = Date.now();
        delete e.trashed; e.trashChangedAt = ts; e.updated = ts;
        if (window._fbSaveJournalEntry) window._fbSaveJournalEntry(_soCurrentModuleId, e, st.entries);
      }
    });
    saveState(); renderSoSidebar();
  },
  purge: (ids) => { (ids || []).forEach(hardDeleteEntry); },
  ttlDays: 30
};

/* ── Search + tag filter (mirrors _bjEntryText / _bjRenderTagChips) ── */
function _soEntryText(e) {
  const d = e.data || {};
  const parts = [e.title || '', (e.tags || []).join(' ')];
  if (d.html) parts.push(String(d.html).replace(/<[^>]*>/g, ' '));
  return parts.join(' ').toLowerCase();
}
function _soHlTitle(text, q) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark class="docx-hl">' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}
function _soRenderTagChips(live) {
  let row = document.getElementById('so-tagfilter-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'so-tagfilter-row';
    row.className = 'docx-tagchips';
    const listEl = document.getElementById('so-entries-list');
    if (listEl && listEl.parentNode) listEl.parentNode.insertBefore(row, listEl);
  }
  const all = [...new Set(live.reduce((a, e) => a.concat(e.tags || []), []))].sort((a, b) => a.localeCompare(b));
  soTagFilters = soTagFilters.filter(t => all.includes(t));
  row.classList.toggle('on', all.length > 0);
  row.innerHTML = '';
  if (!all.length) return;
  const lbl = document.createElement('div');
  lbl.className = 'docx-tagchips-lbl';
  lbl.textContent = 'Filter by tag';
  row.appendChild(lbl);
  all.forEach(tag => {
    const chip = document.createElement('button');
    chip.className = 'docx-tagchip' + (soTagFilters.includes(tag) ? ' on' : '');
    chip.textContent = tag;
    chip.title = tag;
    chip.onclick = () => {
      soTagFilters = soTagFilters.includes(tag) ? soTagFilters.filter(t => t !== tag) : soTagFilters.concat(tag);
      renderSoSidebar();
    };
    row.appendChild(chip);
  });
}
function _soRenderTrashBtn() {
  let btn = document.getElementById('so-trash-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'so-trash-btn';
    btn.className = 'docx-trash-btn';
    btn.onclick = () => { if (window._docxOpenTrash) window._docxOpenTrash('so'); };
    const stats = document.getElementById('so-sidebar-stats');
    if (stats && stats.parentNode) stats.parentNode.insertBefore(btn, stats);
  }
  const n = _soState().entries.filter(e => e.trashed).length;
  btn.innerHTML = '<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>Trash</span>' + (n ? ' <span class="docx-trash-count">' + n + '</span>' : '');
}

/* ── Sidebar render + drag reorder (native HTML5 DnD, mirrors bj renderSidebar) ── */
function renderSoSidebar() {
  const list = document.getElementById('so-entries-list');
  const searchBox = document.getElementById('so-search-box');
  if (!list || !searchBox) return;
  const search = searchBox.value.toLowerCase().trim();
  const st = _soState();
  const live = st.entries.filter(e => !e.trashed);
  const entries = live.filter(e => {
    const hay = _soEntryText(e);
    return (!search || hay.includes(search)) && (soTagFilters.length === 0 || soTagFilters.every(t => (e.tags || []).includes(t)));
  });
  list.innerHTML = '';
  if (entries.length === 0) {
    list.innerHTML = `<div class="list-empty">${search || soTagFilters.length ? 'No pages match your search.' : 'No pages yet.<br>Click "New Page" to begin.'}</div>`;
  }
  const isDraggable = !search && soTagFilters.length === 0;
  let dragSrcId = null;

  entries.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'entry-item' + (entry.id === st.activeId ? ' active' : '');
    div.dataset.entryId = entry.id;
    if (isDraggable) div.draggable = true;
    const date = new Date(entry.updated).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const titleClass = entry.title ? '' : ' untitled';
    div.innerHTML = `
      ${isDraggable ? `<div class="entry-drag-handle" title="Drag to reorder"><span></span><span></span><span></span></div>` : ''}
      <div class="entry-item-title${titleClass}">${_soHlTitle(entry.title || 'Untitled', search)}</div>
      <div class="entry-item-meta">
        <span>${date}</span>
        ${(entry.tags || []).length ? `<span>· ${entry.tags.slice(0, 2).join(', ')}${entry.tags.length > 2 ? '…' : ''}</span>` : ''}
      </div>
      <button class="entry-delete" data-id="${entry.id}" title="Move to Trash" aria-label="Move to Trash"><svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
    `;
    div.addEventListener('click', e => {
      if (e.target.classList.contains('entry-delete') || e.target.closest('.entry-delete')) return;
      if (e.target.classList.contains('entry-drag-handle') || e.target.closest('.entry-drag-handle')) return;
      saveCurrentEntry();
      if (window._fbFlushJournal) window._fbFlushJournal(_soCurrentModuleId);
      st.activeId = entry.id;
      renderSoSidebar(); loadActiveEntry();
    });
    div.querySelector('.entry-delete').addEventListener('click', async e => {
      e.stopPropagation();
      if (await window.uiConfirm(`Delete "${entry.title || 'Untitled'}"?`, { danger: true, okLabel: 'Delete' })) deleteEntry(entry.id);
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
        const fromIdx = st.entries.findIndex(x => x.id === dragSrcId);
        const toIdx = st.entries.findIndex(x => x.id === entry.id);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = st.entries.splice(fromIdx, 1);
        st.entries.splice(toIdx, 0, moved);
        dragSrcId = null;
        saveState(); renderSoSidebar();
        if (window._fbSaveJournalOrder) window._fbSaveJournalOrder(_soCurrentModuleId, st.entries);
      });
    }
    list.appendChild(div);
  });
  const ec = document.getElementById('so-entry-count');
  if (ec) ec.textContent = live.length;
  _soRenderTagChips(live);
  _soRenderTrashBtn();
}

/* ── Load / save the active entry into the page editor ── */
function loadActiveEntry() {
  const entry = getActive();
  const titleEl = document.getElementById('so-entry-title-input');
  const emptyEl = document.getElementById('so-empty-state');
  const pageEl = document.getElementById('so-page-area');
  const tagsRow = document.getElementById('so-tags-row');
  if (!entry) {
    if (titleEl) titleEl.value = '';
    if (emptyEl) emptyEl.style.display = 'flex';
    if (pageEl) pageEl.style.display = 'none';
    if (tagsRow) tagsRow.style.display = 'none';
    renderTags([]);
    return;
  }
  if (titleEl) titleEl.value = entry.title;
  if (emptyEl) emptyEl.style.display = 'none';
  if (pageEl) pageEl.style.display = 'flex';
  if (tagsRow) tagsRow.style.display = 'flex';
  renderTags(entry.tags || []);
  const ed = document.getElementById('so-page-editor');
  if (ed) {
    ed.innerHTML = entry.data.html || '';
    ed.contentEditable = isEditMode ? 'true' : 'false';
    if (window._docxOnLoad) window._docxOnLoad('so-page-editor', entry.id);
    ed.querySelectorAll('.pg-img-wrap').forEach(_soBindImgWrap);
  }
  const pt = document.getElementById('so-page-toolbar');
  if (pt) { if (isEditMode) pt.classList.add('edit-mode'); else pt.classList.remove('edit-mode'); }
}

function _soAutoTitle(entry) {
  const ed = document.getElementById('so-page-editor');
  const src = ed && ed.innerText ? ed.innerText : String((entry.data || {}).html || '').replace(/<[^>]*>/g, '\n');
  const line = (src || '').split('\n').map(s => s.trim()).find(s => s.length > 1) || '';
  if (!line) return '';
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line;
}

function saveCurrentEntry() {
  const entry = getActive(); if (!entry) return;
  const titleEl = document.getElementById('so-entry-title-input');
  entry.title = titleEl ? titleEl.value : entry.title;
  if (!entry.title.trim()) {
    const auto = _soAutoTitle(entry);
    if (auto) {
      entry.title = auto;
      if (titleEl && document.activeElement !== titleEl) titleEl.value = auto;
    }
  }
  entry.updated = Date.now();
  const ed = document.getElementById('so-page-editor');
  if (ed) entry.data.html = ed.innerHTML;
  saveState(); renderSoSidebar();
}

/* ── Tags ── */
function renderTags(tags) {
  const row = document.getElementById('so-tags-row');
  if (!row) return;
  row.querySelectorAll('.tag').forEach(t => t.remove());
  const input = document.getElementById('so-add-tag-input');
  tags.forEach(tag => {
    const span = document.createElement('span');
    span.className = 'tag';
    const label = document.createElement('span');
    label.className = 'tag-txt';
    label.textContent = tag;
    span.appendChild(label);
    const delBtn = document.createElement('span');
    delBtn.className = 'tag-del';
    delBtn.innerHTML = '<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    delBtn.style.display = isEditMode ? '' : 'none';
    delBtn.onclick = () => {
      const e = getActive(); if (!e) return;
      e.tags = (e.tags || []).filter(t => t !== tag);
      saveState(); renderTags(e.tags); renderSoSidebar();
    };
    span.appendChild(delBtn);
    if (input) row.insertBefore(span, input);
  });
}

/* ── Edit mode ── */
function setEditMode(enabled) {
  isEditMode = enabled;
  const checkbox = document.getElementById('so-btn-edit');
  if (checkbox) checkbox.checked = enabled;
  const modeLabel = document.getElementById('so-mode-label');
  if (modeLabel) {
    modeLabel.textContent = enabled ? 'EDIT' : 'VIEW';
    modeLabel.classList.toggle('edit-active', enabled);
  }
  const titleEl = document.getElementById('so-entry-title-input');
  if (titleEl) titleEl.readOnly = !enabled;
  const tagInput = document.getElementById('so-add-tag-input');
  if (tagInput) tagInput.readOnly = !enabled;
  const pgEd = document.getElementById('so-page-editor');
  if (pgEd) pgEd.contentEditable = enabled ? 'true' : 'false';
  const pgTb = document.getElementById('so-page-toolbar');
  if (pgTb) { if (enabled) pgTb.classList.add('edit-mode'); else pgTb.classList.remove('edit-mode'); }
  renderTags(getActive() ? getActive().tags || [] : []);
}

/* ── Image insert (base64, local — mirrors pgInsertImage / _pgBindImgWrap) ── */
function _soCompressImage(src, callback) {
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
  img.onerror = function() { callback(src); };
  img.src = src;
}
function _soBindImgWrap(wrap) {
  if (wrap._pgBound) return;
  wrap._pgBound = true;
  const img = wrap.querySelector('img');
  const rsz = wrap.querySelector('.pg-img-resize-handle');
  const del = wrap.querySelector('.pg-img-del-handle');
  if (!img || !rsz || !del) return;
  rsz.addEventListener('pointerdown', function(e) {
    e.preventDefault(); e.stopPropagation();
    rsz.setPointerCapture(e.pointerId);
    const startX = e.clientX, startW = img.offsetWidth;
    function onMove(ev) {
      const nw = Math.max(60, startW + (ev.clientX - startX));
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
  del.addEventListener('pointerdown', function(e) {
    e.preventDefault(); e.stopPropagation();
    wrap.parentNode && wrap.parentNode.removeChild(wrap);
    autoSave();
  });
  wrap.addEventListener('pointerdown', function(e) {
    if (e.target === del || e.target === rsz) return;
    const ed = document.getElementById('so-page-editor');
    if (ed) ed.querySelectorAll('.pg-img-wrap').forEach(w => w.classList.remove('selected'));
    wrap.classList.add('selected');
    function onOutside(ev) {
      if (!wrap.contains(ev.target)) { wrap.classList.remove('selected'); document.removeEventListener('pointerdown', onOutside, true); }
    }
    document.addEventListener('pointerdown', onOutside, true);
  });
}
window._soBindImg = function(w) { return _soBindImgWrap(w); };

function pgInsertImage(src) {
  _soCompressImage(src, function(compressed) {
    const ed = document.getElementById('so-page-editor');
    if (!ed) return;
    ed.focus();
    const wrap = document.createElement('span');
    wrap.className = 'pg-img-wrap';
    wrap.contentEditable = 'false';
    const img = document.createElement('img');
    img.src = compressed;
    img.alt = 'image';
    img.style.width = '320px';
    const rsz = document.createElement('span');
    rsz.className = 'pg-img-resize-handle';
    rsz.title = 'Drag to resize';
    const del = document.createElement('span');
    del.className = 'pg-img-del-handle';
    del.innerHTML = '<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    del.title = 'Remove image';
    wrap.appendChild(img);
    wrap.appendChild(rsz);
    wrap.appendChild(del);
    _soBindImgWrap(wrap);
    const sel = window.getSelection();
    if (sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.insertNode(wrap);
      range.collapse(false);
    } else {
      ed.appendChild(wrap);
    }
    autoSave();
  });
}
function _soPageInsertFileChip(name, dataURL, mimeType) {
  const ed = document.getElementById('so-page-editor');
  if (!ed) return;
  ed.focus();
  const escaped = name.replace(/"/g, '&quot;');
  const clip = (window._docxPaperclipSVG || '<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11 12.3 20a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.9-2.9l8.5-8.5"/></svg>');
  const html = '<a class="tj-file-chip" href="' + dataURL + '" download="' + escaped + '" contenteditable="false" style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;background:var(--card2);border:1px solid var(--border);border-radius:4px;text-decoration:none;color:var(--text2);font-size:11px;font-weight:600;margin:2px 3px;cursor:pointer;">' + clip + '<span class="tj-file-name">' + escaped + '</span></a>';
  document.execCommand('insertHTML', false, html);
  autoSave();
}

/* ── Wire static event listeners once (module-scoped, DOM never destroyed —
     only its content is swapped when a different module's notes are opened) ── */
let _soListenersWired = false;
function wireStaticListeners() {
  if (_soListenersWired) return;
  _soListenersWired = true;

  const newBtn = document.getElementById('so-new-entry-btn');
  if (newBtn) newBtn.addEventListener('click', () => {
    saveCurrentEntry();
    createEntry();
    saveState(); renderSoSidebar(); loadActiveEntry();
    const titleEl = document.getElementById('so-entry-title-input');
    if (titleEl) { titleEl.focus(); }
  });

  const searchBox = document.getElementById('so-search-box');
  if (searchBox) searchBox.addEventListener('input', renderSoSidebar);

  const titleEl = document.getElementById('so-entry-title-input');
  if (titleEl) titleEl.addEventListener('input', autoSave);

  const ed = document.getElementById('so-page-editor');
  if (ed) ed.addEventListener('input', autoSave);

  const editCb = document.getElementById('so-btn-edit');
  if (editCb) editCb.addEventListener('change', function() { setEditMode(this.checked); });

  const imgFile = document.getElementById('so-page-img-file');
  if (imgFile) imgFile.addEventListener('change', function() {
    Array.from(this.files).forEach(file => {
      const reader = new FileReader();
      if (file.type.startsWith('image/')) {
        reader.onload = e => pgInsertImage(e.target.result);
        reader.readAsDataURL(file);
      } else {
        reader.onload = e => _soPageInsertFileChip(file.name, e.target.result, file.type);
        reader.readAsDataURL(file);
      }
    });
    this.value = '';
  });

  const tagInput = document.getElementById('so-add-tag-input');
  if (tagInput) tagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = e.target.value.trim().replace(/,/g, '');
      if (!val) return;
      const entry = getActive(); if (!entry) return;
      entry.tags = entry.tags || [];
      if (!entry.tags.includes(val)) entry.tags.push(val);
      e.target.value = '';
      saveState(); renderTags(entry.tags); renderSoSidebar();
    }
  });

  const dropZone = document.getElementById('so-page-drop-zone');
  const pageArea = document.getElementById('so-page-area');
  if (dropZone && pageArea) {
    pageArea.addEventListener('dragenter', e => { if (isEditMode) { e.preventDefault(); dropZone.classList.add('active'); } });
    pageArea.addEventListener('dragover', e => { if (isEditMode) e.preventDefault(); });
    pageArea.addEventListener('dragleave', e => { if (e.target === dropZone) dropZone.classList.remove('active'); });
    pageArea.addEventListener('drop', e => {
      // Not in edit mode: let the drop bubble to the global StudyOS
      // handler, which offers to file the files as documents instead.
      if (!isEditMode) return;
      e.preventDefault();
      // In edit mode these files belong to the page. Stop the
      // window-level ingest handler so they are not ALSO filed into a
      // documents module.
      e.stopPropagation();
      dropZone.classList.remove('active');
      Array.from(e.dataTransfer.files || []).forEach(file => {
        const reader = new FileReader();
        if (file.type.startsWith('image/')) {
          reader.onload = ev => pgInsertImage(ev.target.result);
          reader.readAsDataURL(file);
        } else {
          reader.onload = ev => _soPageInsertFileChip(file.name, ev.target.result, file.type);
          reader.readAsDataURL(file);
        }
      });
    });
  }

  purgeExpiredTrash();
}

/* ── Firebase wiring: initial load (one-shot) + live remote updates (event,
     fires again on every subsequent change from another device/tab) — same
     split as studyos.js's own fb-sos-remote listener for the main document. ── */
let _soFbListenersWired = false;
function wireFbListeners() {
  if (_soFbListenersWired) return;
  _soFbListenersWired = true;
  window.addEventListener('fb-notes-remote', function(e) {
    const detail = e.detail;
    if (!detail || detail.moduleId !== _soCurrentModuleId) return;   // not the open module
    const remote = detail.data;
    if (!remote || !Array.isArray(remote.entries)) return;
    const st = _soState();
    st.entries = remote.entries;
    if (remote.activeId) st.activeId = remote.activeId;
    _soWriteCache();
    renderSoSidebar(); loadActiveEntry();
  });
  window.addEventListener('fb-notes-saved', function(e) {
    if (e.detail && e.detail.moduleId === _soCurrentModuleId) window._soSetSync('synced');
  });
  window.addEventListener('fb-notes-error', function(e) {
    if (e.detail && e.detail.moduleId === _soCurrentModuleId) window._soSetSync('error');
  });
}

/* ── Public entry point: called from studyos.js when a Notes-type module opens ── */
window.openNotesModule = function(classId, mod) {
  _soCurrentClassId = classId;
  _soCurrentModuleId = mod.id;
  loadModuleState(mod.id);
  wireStaticListeners();
  wireFbListeners();

  const soRoot = document.getElementById('so-root');
  const host = document.getElementById('module-content-' + mod.id);
  if (soRoot && host) { soRoot.style.display = ''; host.appendChild(soRoot); }
  const detailModal = document.getElementById('module-detail-modal');
  if (detailModal) detailModal.classList.add('notes-mode');

  if (window._fbLoadJournal) {
    window._fbLoadJournal(mod.id).then(remote => {
      // Only apply if this is still the open module — the user may have
      // already closed/switched by the time this async load resolves.
      if (remote && Array.isArray(remote.entries) && _soCurrentModuleId === mod.id) {
        const st = _soState();
        st.entries = remote.entries;
        if (remote.activeId) st.activeId = remote.activeId;
        _soWriteCache();
        renderSoSidebar(); loadActiveEntry();
      }
    }).catch(() => {});
  }

  setEditMode(false);
  renderSoSidebar();
  loadActiveEntry();
};

window.closeNotesModule = function() {
  saveCurrentEntry();
  if (window._fbFlushJournal && _soCurrentModuleId) window._fbFlushJournal(_soCurrentModuleId);
  const soRoot = document.getElementById('so-root');
  if (soRoot) soRoot.style.display = 'none';
  const detailModal = document.getElementById('module-detail-modal');
  if (detailModal) detailModal.classList.remove('notes-mode');
  _soCurrentModuleId = null;
};

})();
