/* ============================================================================
 * StudyOS — application logic
 * ============================================================================
 * Ported verbatim from the original embedded build. The only edits are at the
 * boundaries where it used to reach into the host page:
 *
 *   was                                  now
 *   ─────────────────────────────────    ────────────────────────────────────
 *   hardcoded studyos-files worker URL   STUDYOS_CONFIG.cloudflare.filesWorker
 *   window.sosPastel  (host global)      defined here
 *   window.uiConfirm  (host global)      js/ui.js
 *   window.thScheduleNotif / thCancelNotif  js/push.js
 *   window._fbLoadStudyOs / _fbSaveStudyOs  js/firebase-sync.js
 *   window.studyOsOpen() called by host  self-boots on DOMContentLoaded
 *
 * Everything else — every render function, every persist call, every guard —
 * is byte-for-byte what shipped, so behaviour is identical by construction.
 *
 * OPTIONAL host hooks (window._vedaAddTask / _vedaUpdateTask / _vedaRemoveTask
 * / _vedaTogTask) mirror dated items into a sibling weekly planner. They were
 * already null-guarded in the original, so standalone they are simply inert.
 * See config.js §7 for the contract if you want to reconnect them.
 * ------------------------------------------------------------------------- */

/* ── SOI — StudyOS icon set ────────────────────────────────────────────────
 * Replaces the emoji this file used to render as UI chrome. Every glyph is a
 * 24px-grid line icon drawn in `currentColor`, so it inherits whatever colour
 * its host already sets — Veda's accent (--accent), the muted text tone, the
 * red of a delete control — instead of arriving as a flat black character.
 * Sized in em (see `.soi` in css/so-notes.css) so an icon is exactly as big as
 * the text it replaced.
 *
 * The emoji that remain in this file are deliberate CONTENT, not chrome: the
 * per-file-type map in _sosFileIcon(), the module-type ICONS, and the titles
 * pushed into OS notifications (which render plain text, never markup).
 * ------------------------------------------------------------------------ */
var SOI = (function () {
  function I(body, w) {
    return '<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" ' +
           'stroke="currentColor" stroke-width="' + (w || 1.5) + '" stroke-linecap="round" ' +
           'stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  return {
    check:    I('<path d="M20 6 9 17l-5-5"/>'),
    checkBold:I('<path d="M20 6 9 17l-5-5"/>', 2.5),
    x:        I('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    pencil:   I('<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
    trash:    I('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    alert:    I('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    refresh:  I('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>'),
    cloud:    I('<path d="M12 13v8"/><path d="m8 17 4-4 4 4"/><path d="M20.9 18.4A5 5 0 0 0 18 9h-1.3A8 8 0 1 0 4 16.2"/>'),
    download: I('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
    clip:     I('<path d="M21.4 11 12.3 20a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.9-2.9l8.5-8.5"/>'),
    calendar: I('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>'),
    bell:     I('<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    settings: I('<circle cx="12" cy="12" r="3"/><path d="M12 2.5a1.5 1.5 0 0 1 1.5 1.3l.1 1a7.6 7.6 0 0 1 1.7.7l.8-.6a1.5 1.5 0 0 1 2 .2l.8.8a1.5 1.5 0 0 1 .2 2l-.6.8c.3.5.5 1.1.7 1.7l1 .1a1.5 1.5 0 0 1 1.3 1.5v1.1a1.5 1.5 0 0 1-1.3 1.5l-1 .1a7.6 7.6 0 0 1-.7 1.7l.6.8a1.5 1.5 0 0 1-.2 2l-.8.8a1.5 1.5 0 0 1-2 .2l-.8-.6a7.6 7.6 0 0 1-1.7.7l-.1 1a1.5 1.5 0 0 1-1.5 1.3h-1.1a1.5 1.5 0 0 1-1.5-1.3l-.1-1a7.6 7.6 0 0 1-1.7-.7l-.8.6a1.5 1.5 0 0 1-2-.2l-.8-.8a1.5 1.5 0 0 1-.2-2l.6-.8a7.6 7.6 0 0 1-.7-1.7l-1-.1A1.5 1.5 0 0 1 2.5 13.1V12a1.5 1.5 0 0 1 1.3-1.5l1-.1c.2-.6.4-1.2.7-1.7l-.6-.8a1.5 1.5 0 0 1 .2-2l.8-.8a1.5 1.5 0 0 1 2-.2l.8.6c.5-.3 1.1-.5 1.7-.7l.1-1A1.5 1.5 0 0 1 11.9 2.5Z"/>'),
    box:      I('<path d="m12 2 9 5v10l-9 5-9-5V7Z"/><path d="m3 7 9 5 9-5"/><path d="M12 12v10"/>'),
    printer:  I('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 15h12v6H6Z"/>'),
    expand:   I('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
    task:     I('<path d="M9 11.5 11 13.5 15.5 9"/><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4"/><path d="M16 2v4"/>')
  };
})();

/* ── Config-derived constants ──────────────────────────────────────────────
 * Read once at load. If the files worker is unconfigured, baseUrl stays null
 * and every SosCloud call fails fast and visibly rather than firing requests
 * at a placeholder host. */
var _SOS_CFG   = (window.STUDYOS_CONFIG || {});
var _SOS_FILES = (_SOS_CFG.cloudflare && _SOS_CFG.cloudflare.filesWorker) || {};
var _SOS_CLOUD_OK = !!(window.STUDYOS_CONFIG_READY && window.STUDYOS_CONFIG_READY('cloudflare')) && _SOS_FILES.enabled !== false;

/* Legacy class colors → soft pastel equivalents. Applied on load and at render
 * so classes created before the palette change adopt it without re-picking. */
var SOS_PASTEL_MAP = {
  '#7c6fff':'#a99cf0','#ff6b6b':'#ef9f9f','#ff9f43':'#f0bd86','#ffd32a':'#e6cd7c',
  '#0be881':'#8fd6ad','#00d2d3':'#8ccfcf','#54a0ff':'#9dc0ee','#f368e0':'#dea2d6',
  '#ff6b81':'#f0a2af','#48dbfb':'#9bd6ea','#1dd1a1':'#88d2ba','#c8d6e5':'#c2cdda',
  '#a29bfe':'#bbb4ef','#fd79a8':'#f0a8c2','#e17055':'#dd9f8b','#00b894':'#84ccb6'
};
function sosPastel(c){ if(!c) return c; return SOS_PASTEL_MAP[String(c).toLowerCase()] || c; }
window.sosPastel = sosPastel;

window._sosRoot = null;
function _sosEl(id) {
  if (window._sosRoot) {
    var el = window._sosRoot.querySelector('#' + id);
    if (el) return el;
  }
  return document.getElementById(id);
}

const COLORS = [
  '#a99cf0','#ef9f9f','#f0bd86','#e6cd7c','#8fd6ad',
  '#8ccfcf','#9dc0ee','#dea2d6','#f0a2af','#9bd6ea',
  '#88d2ba','#c2cdda','#bbb4ef','#f0a8c2','#dd9f8b','#84ccb6'
];
const EVENT_COLORS = { exam:'#ff6b6b', hw:'#ff9f43', quiz:'#ffd32a', lecture:'#54a0ff', lab:'#0be881', other:'#c8d6e5' };
const PRIORITY_COLORS = { low:'#54a0ff', medium:'#ffd32a', high:'#ff6b6b' };

let classes = JSON.parse(localStorage.getItem('studyos_classes') || '[]');
// Migrate any legacy vibrant class colors to the soft pastel palette in-place.
classes.forEach(c => { if (c && c.color && window.sosPastel) c.color = window.sosPastel(c.color); });
let events = JSON.parse(localStorage.getItem('studyos_events') || '[]');
let tasks = JSON.parse(localStorage.getItem('studyos_tasks') || '[]');
let notesList = JSON.parse(localStorage.getItem('studyos_notes_v2') || '[]');
// Brightspace import state: the course -> class mapping owned by js/d2l-sync.js.
// Kept here rather than in that module so it rides along in the same Firestore
// document as everything else and therefore syncs across devices for free.
let d2lMap = JSON.parse(localStorage.getItem('studyos_d2l') || 'null');
let currentNoteId = null;
let selectedColor = COLORS[0];
let currentClassId = null;
let calDate = new Date();
let activeView = 'home';
let editingEventId = null;

// ── Repeat state for the event modal ────────────────────────────────────────
let _sosRepeat = { mode: 'none', days: [], endDate: '' };
function sosSetRepeat(mode) {
  _sosRepeat.mode = mode;
  // Update button styles
  ['none','daily','weekly'].forEach(m => {
    const b = _sosEl('sos-rep-' + m);
    if (b) b.classList.toggle('active', m === mode);
  });
  const daysEl  = _sosEl('sos-repeat-days');
  const untilEl = _sosEl('sos-repeat-until');
  if (daysEl)  daysEl.style.display  = mode === 'weekly' ? '' : 'none';
  if (untilEl) untilEl.style.display = (mode === 'daily' || mode === 'weekly') ? '' : 'none';
}
function sosToggleDay(d) {
  const idx = _sosRepeat.days.indexOf(d);
  if (idx === -1) _sosRepeat.days.push(d);
  else _sosRepeat.days.splice(idx, 1);
  // Refresh day button styles
  document.querySelectorAll('.sos-day-btn').forEach(b => {
    b.classList.toggle('active', _sosRepeat.days.includes(parseInt(b.dataset.day)));
  });
}
function _sosResetRepeatUI(ev) {
  // ev = existing event object when editing, null when adding
  const mode = ev?.repeat || 'none';
  _sosRepeat = { mode, days: ev?.repeatDays ? [...ev.repeatDays] : [], endDate: ev?.repeatEndDate || '' };
  sosSetRepeat(mode);
  // Reset day buttons
  document.querySelectorAll('.sos-day-btn').forEach(b => {
    b.classList.toggle('active', _sosRepeat.days.includes(parseInt(b.dataset.day)));
  });
  const endEl = _sosEl('inp-event-repeat-end');
  if (endEl) endEl.value = _sosRepeat.endDate || '';
  // Show warning only when editing a repeating event
  const warn = _sosEl('sos-repeat-warning');
  if (warn) warn.style.display = (ev?.repeatId && mode !== 'none') ? '' : 'none';
}
// DAY_JS_IDX→Veda Monday-indexed: JS Sun=0 → Veda 6, Mon=1 → 0, …
function _sosJsDayToVeda(d) { return d === 0 ? 6 : d - 1; }
// Build all repeat dates from startDate (YYYY-MM-DD string) using _sosRepeat
function _sosRepeatDates(startDate) {
  const mode = _sosRepeat.mode;
  if (mode === 'none') return [startDate];
  const endRaw = (_sosEl('inp-event-repeat-end') || {}).value || _sosRepeat.endDate;
  if (!endRaw) return [startDate];
  const dates = [];
  const cur = new Date(startDate + 'T12:00:00');
  const end = new Date(endRaw   + 'T12:00:00');
  if (end < cur) return [startDate];
  while (cur <= end) {
    const iso = cur.toISOString().slice(0,10);
    if (mode === 'daily') {
      dates.push(iso);
    } else if (mode === 'weekly') {
      const jsDay = cur.getDay(); // 0=Sun
      const vedaDay = _sosJsDayToVeda(jsDay);
      if (_sosRepeat.days.length === 0 || _sosRepeat.days.includes(vedaDay)) {
        dates.push(iso);
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  return dates.length ? dates : [startDate];
}
let editingTaskId = null;

// ── Repeat state for the task modal ─────────────────────────────────────────
let _sosTaskRepeat = { mode: 'none', days: [], endDate: '' };
function sosSetTaskRepeat(mode) {
  _sosTaskRepeat.mode = mode;
  ['none','daily','weekly'].forEach(m => {
    const b = _sosEl('sos-trep-' + m);
    if (b) b.classList.toggle('active', m === mode);
  });
  const daysEl  = _sosEl('sos-task-repeat-days');
  const untilEl = _sosEl('sos-task-repeat-until');
  if (daysEl)  daysEl.style.display  = mode === 'weekly' ? '' : 'none';
  if (untilEl) untilEl.style.display = (mode === 'daily' || mode === 'weekly') ? '' : 'none';
}
function sosToggleTaskDay(d) {
  const idx = _sosTaskRepeat.days.indexOf(d);
  if (idx === -1) _sosTaskRepeat.days.push(d);
  else _sosTaskRepeat.days.splice(idx, 1);
  document.querySelectorAll('#sos-task-day-btns .sos-day-btn').forEach(b => {
    b.classList.toggle('active', _sosTaskRepeat.days.includes(parseInt(b.dataset.day)));
  });
}
function _sosResetTaskRepeatUI(t) {
  const mode = t?.repeat || 'none';
  _sosTaskRepeat = { mode, days: t?.repeatDays ? [...t.repeatDays] : [], endDate: t?.repeatEndDate || '' };
  sosSetTaskRepeat(mode);
  document.querySelectorAll('#sos-task-day-btns .sos-day-btn').forEach(b => {
    b.classList.toggle('active', _sosTaskRepeat.days.includes(parseInt(b.dataset.day)));
  });
  const endEl = _sosEl('inp-task-repeat-end');
  if (endEl) endEl.value = _sosTaskRepeat.endDate || '';
  const warn = _sosEl('sos-task-repeat-warning');
  if (warn) warn.style.display = (t?.repeatId && mode !== 'none') ? '' : 'none';
}
function _sosTaskRepeatDates(startDate) {
  const mode = _sosTaskRepeat.mode;
  if (mode === 'none' || !startDate) return startDate ? [startDate] : [];
  const endRaw = (_sosEl('inp-task-repeat-end') || {}).value || _sosTaskRepeat.endDate;
  if (!endRaw) return [startDate];
  const dates = [];
  const cur = new Date(startDate + 'T12:00:00');
  const end = new Date(endRaw   + 'T12:00:00');
  if (end < cur) return [startDate];
  while (cur <= end) {
    const iso = cur.toISOString().slice(0,10);
    if (mode === 'daily') {
      dates.push(iso);
    } else if (mode === 'weekly') {
      const vedaDay = _sosJsDayToVeda(cur.getDay());
      if (_sosTaskRepeat.days.length === 0 || _sosTaskRepeat.days.includes(vedaDay)) dates.push(iso);
    }
    cur.setDate(cur.getDate() + 1);
  }
  return dates.length ? dates : [startDate];
}

// ===== KSU MODULES =====
let ksuData = JSON.parse(localStorage.getItem('studyos_ksu') || 'null') || { modules: [] };
function persistKsu() { localStorage.setItem('studyos_ksu', JSON.stringify(ksuData)); _sosFirebaseSave(); }

function renderKsuModules() {
  const grid = _sosEl('ksu-modules-grid');
  if (!grid) return;
  grid.innerHTML = '';
  ksuData.modules.forEach(m => {
    const meta = m.type === 'documents'
      ? (m.files.length + ' file' + (m.files.length !== 1 ? 's' : ''))
      : m.type === 'prompts'
      ? (m.prompts.length + ' prompt' + (m.prompts.length !== 1 ? 's' : ''))
      : ((m.notes||[]).length + ' note' + ((m.notes||[]).length !== 1 ? 's' : ''));
    const btn = document.createElement('div');
    btn.className = 'module-btn';
    btn.dataset.id = m.id;
    btn.innerHTML = `
      <div class="th-drag-handle" title="Drag to reorder" onclick="event.stopPropagation()">⠿</div>
      <button class="rename-btn" title="Rename" onclick="event.stopPropagation();openRenameModule('ksu','${m.id}')">${SOI.pencil}</button>
      <button class="delete-btn" title="Delete" aria-label="Delete" onclick="event.stopPropagation();deleteKsuModule('${m.id}')">${SOI.x}</button>
      <div class="module-btn-icon" style="background:#8D769A22;color:#8D769A;font-size:11px">${m.type.toUpperCase().slice(0,3)}</div>
      <div class="module-btn-name">${m.name}</div>
      <div class="module-btn-meta">${meta}</div>
    `;
    btn.onclick = () => openKsuModuleDetail(m);
    grid.appendChild(btn);
  });
  thDragList(grid, () => ksuData.modules, (arr) => { ksuData.modules = arr; }, () => persistKsu(), '#8D769A');
}

async function deleteKsuModule(modId) {
  const mod = ksuData.modules.find(m => m.id === modId);
  if (!(await window.uiConfirm('Remove "' + (mod ? mod.name : 'this module') + '"?', {danger:true, okLabel:'Remove'}))) return;
  ksuData.modules = ksuData.modules.filter(m => m.id !== modId);
  persistKsu();
  renderKsuModules();
}

function openKsuAddModule() {
  // set pending target to ksu, reuse modal flow
  _ksuAddPending = true;
  _sosOpen('modal-add-module');
}

function openKsuModuleDetail(mod) {
  // reuse existing module detail modal with a fake cls object
  const fakeCls = { id: 'ksu', color: '#8D769A', modules: ksuData.modules,
    _persistFn: persistKsu };
  // patch persist to also save ksu
  _sosCurrentModuleClassId = 'ksu';
  _sosCurrentModuleId = mod.id;
  _sosParkSoRoot();
  _sosEl('module-detail-title-text').textContent = mod.name;
  const body = _sosEl('module-detail-body');
  body.innerHTML = '';
  moduleEditMode[mod.id] = false;
  if (mod.type !== 'notes') {
    const toggleWrap = document.createElement('div');
    toggleWrap.className = 'mode-toggle-wrap';
    toggleWrap.innerHTML = `
      <span class="mode-toggle-label active" id="lbl-view-${mod.id}">View</span>
      <div class="mode-slider" id="mode-slider-${mod.id}" onclick="toggleKsuMode('${mod.id}')">
        <div class="mode-slider-thumb"></div>
      </div>
      <span class="mode-toggle-label" id="lbl-edit-${mod.id}">Edit</span>
    `;
    body.appendChild(toggleWrap);
  }
  const content = document.createElement('div');
  content.id = 'module-content-' + mod.id;
  body.appendChild(content);
  renderModuleContent(content, fakeCls, mod);
  _sosOpen('modal-module-detail');
}

function toggleKsuMode(modId) {
  moduleEditMode[modId] = !moduleEditMode[modId];
  const editOn = moduleEditMode[modId];
  const slider = _sosEl('mode-slider-' + modId);
  const lblView = _sosEl('lbl-view-' + modId);
  const lblEdit = _sosEl('lbl-edit-' + modId);
  if (slider) slider.className = 'mode-slider' + (editOn ? ' edit-on' : '');
  if (lblView) lblView.classList.toggle('active', !editOn);
  if (lblEdit) lblEdit.classList.toggle('active', editOn);
  const mod = ksuData.modules.find(m => m.id === modId);
  const fakeCls = { id: 'ksu', color: '#8D769A', modules: ksuData.modules };
  const content = _sosEl('module-content-' + modId);
  if (mod && content) { content.innerHTML = ''; renderModuleContent(content, fakeCls, mod); }
}

function findClassOrKsu(classId) {
  if (classId === 'ksu') return { id: 'ksu', color: '#8D769A', modules: ksuData.modules, _ksu: true };
  return classes.find(c => c.id === classId);
}
function persistForCls(cls) {
  if (cls && cls._ksu) persistKsu(); else persist();
}

// ===== INIT =====
// Expose render hook so Veda TaskHub can trigger SOS calendar re-render after toggling a task
window._sosRenderCalendar = function() {
  try {
    tasks = JSON.parse(localStorage.getItem('studyos_tasks') || '[]');
    renderCalendar();
    updateStats();
    const curCls = classes.find(c => c.id === currentClassId);
    if (curCls) renderClassEvents(curCls);
  } catch(e) {}
};

function init() {
  buildColorGrid();
  renderClasses();
  renderSidebarClasses();
  renderCalendar();
  updateStats();
  renderNotesList();
  setTodayDate();
  scheduleNotifications();
  renderKsuModules();
  renderExamCountdown();
  renderPriorityQueue();
  // Migrate legacy base64 file blobs → IndexedDB (one-time, no-op if already done)
  // then push any local-only files up to the cloud (offline / no-Firebase path).
  _sosMigrateFilesToIdb()
    .then(() => _sosAfterSync())
    .catch(e => console.warn('SOS file migration error:', e));
  _sosRefreshStorage();
  _sosInstallIngest();
}

// ── Cloud-URL memory (survives Firestore array-replacement) ───────────────
// Firestore sync does `classes = remote.classes` / `ksuData = remote.ksu`,
// replacing the arrays wholesale. That would drop a storageUrl this device
// just set (or that another device set) whenever a save without it lands. So
// we remember every cloud URL we've ever seen/created, keyed by stable fileId,
// and re-stamp it back onto the current data after each sync.
const _sosCloudUrls = new Map(); // fileId → storageUrl

function _sosEachFile(fn) {
  for (const cls of classes) for (const mod of (cls.modules || [])) for (const f of (mod.files || [])) fn(f);
  for (const mod of (ksuData.modules || [])) for (const f of (mod.files || [])) fn(f);
}

// Learn any cloud URLs already present in the current data.
function _sosLearnCloudUrls() {
  _sosEachFile(f => { if (f.fileId && f.storageUrl) _sosCloudUrls.set(f.fileId, f.storageUrl); });
}

// Re-stamp known cloud URLs onto files that lost them. Returns true if it filled any.
function _sosReapplyCloudUrls() {
  let changed = false;
  _sosEachFile(f => {
    if (f.fileId && !f.storageUrl && _sosCloudUrls.has(f.fileId)) {
      f.storageUrl = _sosCloudUrls.get(f.fileId);
      f.storagePath = f.fileId;
      changed = true;
    }
  });
  return changed;
}

// Called after the initial load AND every remote sync: keep cloud URLs sticky,
// then upload anything this device has locally that isn't in the cloud yet.
function _sosAfterSync() {
  _sosLearnCloudUrls();
  if (_sosReapplyCloudUrls()) { persist(); persistKsu(); }
  // debounce backfill so a burst of remote events triggers it once
  _sosScheduleSync(400);
  _sosUpdateCloudBadge(); // refresh the count immediately
}

// ── Self-healing upload loop ──────────────────────────────────────────────
// A failed upload used to sit local-only until a remote Firestore change
// happened to fire _sosAfterSync, or the user pressed "Sync to Cloud" by hand.
// One dropped request (flaky wifi, a blocked fetch, the worker briefly 5xx-ing)
// therefore meant the file silently never reached the other devices — which is
// exactly what the "Cloud sync off" notice was reporting. This retries on its
// own with backoff for as long as anything is still waiting, and sweeps
// immediately whenever the tab regains connectivity or comes back to the front.
const SOS_RETRY_MIN = 5000, SOS_RETRY_MAX = 5 * 60 * 1000;
// NB: `_sosSyncTimer` is already taken further down (the sync-status pill), and
// a second top-level declaration in this same scope is a hard SyntaxError.
let _sosCloudRetryTimer = null, _sosRetryDelay = SOS_RETRY_MIN;

function _sosScheduleSync(delay) {
  if (_sosCloudRetryTimer) clearTimeout(_sosCloudRetryTimer);
  _sosCloudRetryTimer = setTimeout(_sosRunSyncPass, delay == null ? _sosRetryDelay : delay);
}

async function _sosRunSyncPass() {
  _sosCloudRetryTimer = null;
  // No files worker configured: there is nothing to retry toward, so stop the
  // loop entirely rather than backing off against a URL that doesn't exist.
  // Everything stays in IndexedDB and works; only cross-device sync is idle.
  if (!SOS_CLOUD_BASE) return;
  // Offline: don't burn a request — the 'online' listener below wakes us up.
  if (navigator.onLine === false) { _sosScheduleSync(SOS_RETRY_MAX); return; }
  let r = null;
  try { r = await _sosBackfillCloud(); }
  catch (e) { console.warn('SOS auto-sync pass failed:', e); }
  _sosUpdateCloudBadge();
  if (r && r.busy) { _sosScheduleSync(SOS_RETRY_MIN); return; }
  if (r && r.failed > 0) {
    // Still broken — back off so a dead worker isn't hammered, but never stop.
    _sosRetryDelay = Math.min(_sosRetryDelay * 2, SOS_RETRY_MAX);
    _sosScheduleSync();
  } else {
    _sosRetryDelay = SOS_RETRY_MIN;   // clean pass → forget the backoff
  }
}

window.addEventListener('online', () => { _sosRetryDelay = SOS_RETRY_MIN; _sosScheduleSync(500); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { _sosRetryDelay = SOS_RETRY_MIN; _sosScheduleSync(1000); }
});

// ── Per-file upload status ────────────────────────────────────────────────
function _sosFmtBytes(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  if (n < 1024 * 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
  }
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Single source of truth for how a file's cloud state is worded, so the list
// render and the live progress ticks can never disagree with each other.
function _sosApplyCloudStatus(el, f) {
  if (!el) return;
  el.classList.remove('is-up', 'is-ok', 'is-warn');
  if (f._uploading) {
    el.textContent = 'Uploading ' + Math.round((f._progress || 0) * 100) + '%';
    el.title = 'Uploading to the cloud…';
    el.classList.add('is-up');
  } else if (f.storageUrl) {
    el.innerHTML = SOI.check + ' Synced';
    el.title = 'In the cloud — available on all your devices';
    el.classList.add('is-ok');
  } else if (f._cloudError) {
    el.innerHTML = SOI.refresh + ' Retrying';
    el.title = 'Saved on this device — retrying automatically until it reaches the cloud';
    el.classList.add('is-warn');
  } else {
    el.textContent = '· Queued';
    el.title = 'Waiting to upload to the cloud';
    el.classList.add('is-up');
  }
}

// Repaint just the rows for one fileId. A chunked upload ticks many times, and
// re-rendering the whole list on each tick would thrash the DOM (and drop the
// user's scroll position) while a big PDF streams.
function _sosPaintProgress(fileId, p) {
  if (!fileId) return;
  document.querySelectorAll('.doc-item-cloud').forEach(el => {
    if (el.dataset.fileId !== fileId) return;
    el.classList.remove('is-ok', 'is-warn');
    el.classList.add('is-up');
    el.textContent = 'Uploading ' + Math.round((p || 0) * 100) + '%';
  });
}

// ── Cloud capacity indicator ──────────────────────────────────────────────
// Reads real totals from the worker. If the worker can't be reached the meter
// hides rather than showing an invented number.
let _sosStorageBusy = false;
async function _sosRefreshStorage() {
  const el = document.getElementById('sos-storage-meter');
  if (!el || _sosStorageBusy) return;
  _sosStorageBusy = true;
  try {
    const u = await SosCloud.usage();
    const used  = typeof u.bytes === 'number' ? u.bytes : 0;
    const limit = typeof u.limit === 'number' && u.limit > 0 ? u.limit : SOS_KV_LIMIT;
    const pct   = Math.min(100, (used / limit) * 100);
    const fill = el.querySelector('.sos-storage-fill');
    const text = el.querySelector('.sos-storage-text');
    if (fill) {
      fill.style.width = (pct < 1 && used > 0 ? 1 : pct).toFixed(1) + '%';
      fill.classList.toggle('near-full', pct >= 80 && pct < 95);
      fill.classList.toggle('full', pct >= 95);
    }
    if (text) text.textContent = _sosFmtBytes(used) + ' / ' + _sosFmtBytes(limit);
    el.title = 'Cloud storage: ' + _sosFmtBytes(used) + ' of ' + _sosFmtBytes(limit) + ' used'
             + (u.files ? ' across ' + u.files + ' file' + (u.files > 1 ? 's' : '') : '')
             + '. Files up to ' + _sosFmtBytes(SOS_CLOUD_MAX) + ' each.';
    el.style.display = '';
    if (pct >= 95 && !_sosStorageWarned) {
      _sosStorageWarned = true;
      showNotif(SOI.alert, 'Cloud storage almost full', _sosFmtBytes(used) + ' of ' + _sosFmtBytes(limit) + ' used — remove some files to keep syncing.');
    }
  } catch (_) {
    el.style.display = 'none';
  } finally {
    _sosStorageBusy = false;
  }
}
let _sosStorageWarned = false;
window.sosRefreshStorage = _sosRefreshStorage;

// "Reached the cloud" announcement, coalesced across a batch — dropping ten
// separate toasts for a ten-file drop would bury the one thing that matters.
// The per-row pill still reports each file individually and in real time.
let _sosSyncedN = 0, _sosSyncedName = '', _sosSyncedTimer = null;
function _sosNoteSynced(name) {
  _sosSyncedN++;
  _sosSyncedName = name || 'File';
  if (_sosSyncedTimer) clearTimeout(_sosSyncedTimer);
  _sosSyncedTimer = setTimeout(() => {
    const n = _sosSyncedN, nm = _sosSyncedName;
    _sosSyncedN = 0; _sosSyncedTimer = null;
    showNotif(SOI.cloud, 'Synced to cloud',
      (n === 1 ? nm : n + ' files') + ' now available on all your devices.');
  }, 900);
}

// Count files not in the cloud, split by whether THIS device holds the blob.
//   localOnly  → has a local blob, not uploaded yet (this device can fix it)
//   elsewhere  → no cloud copy and no local blob (lives on another device)
async function _sosCloudCounts() {
  const pending = new Set();
  _sosEachFile(f => { if (f.fileId && !f.storageUrl && !_sosCloudUrls.has(f.fileId)) pending.add(f.fileId); });
  let localOnly = 0, elsewhere = 0;
  for (const id of pending) {
    // has() checks the key only — no need to pull whole PDFs into memory
    // just to count them, which this sweep used to do on every badge refresh.
    let here = false; try { here = await SosFileStore.has(id); } catch (_) {}
    if (here) localOnly++; else elsewhere++;
  }
  return { localOnly, elsewhere };
}

// Paint the sidebar badge: amber count of files still local-only on this
// device, or a green ✓ when everything here is in the cloud.
let _sosBadgeBusy = false, _sosBadgeDirty = false;
async function _sosUpdateCloudBadge() {
  const badge = document.getElementById('sos-cloud-badge');
  const btn = document.getElementById('sos-cloud-sync-btn');
  if (!badge || !btn) return;
  if (_sosBadgeBusy) { _sosBadgeDirty = true; return; } // coalesce; re-run after
  _sosBadgeBusy = true;
  try {
    do {
      _sosBadgeDirty = false;
      const { localOnly, elsewhere } = await _sosCloudCounts();
      badge.classList.remove('pending', 'synced');
      badge.style.display = '';
      if (localOnly > 0) {
        badge.textContent = localOnly;
        badge.classList.add('pending');
        btn.title = localOnly + ' file' + (localOnly > 1 ? 's are' : ' is') + ' on this device but not in the cloud yet — click to upload'
          + (elsewhere ? ' · ' + elsewhere + ' more live on another device' : '');
      } else if (elsewhere > 0) {
        // Nothing to upload from here, but the account still has un-synced files elsewhere.
        badge.textContent = elsewhere + ' elsewhere';
        badge.classList.add('synced');
        btn.title = 'All files on THIS device are synced. ' + elsewhere + ' file' + (elsewhere > 1 ? 's' : '') + ' not yet uploaded live on another device — open StudyOS there and click Sync.';
      } else {
        badge.innerHTML = SOI.check;
        badge.classList.add('synced');
        btn.title = 'All files are synced to the cloud and available on every device.';
      }
    } while (_sosBadgeDirty);
  } finally {
    _sosBadgeBusy = false;
  }
}
window.sosUpdateCloudBadge = _sosUpdateCloudBadge;
window.sosSyncAllToCloud = () => _sosBackfillCloud(true); // manual trigger (console/button)

// Auto-upload every previously-uploaded file that's still local-only (has a
// local blob in THIS device's IndexedDB but no cloud copy yet) so old files
// become cross-device without re-uploading. Keyed by fileId so it's immune to
// the array-replacement race. Sweeps regular classes AND the KSU bucket.
let _sosBackfillRunning = false;
async function _sosBackfillCloud(manual, onProgress) {
  if (_sosBackfillRunning) return { busy: true };
  _sosBackfillRunning = true;
  try {
    // Snapshot fileIds needing a cloud copy (deduped) from the CURRENT data.
    const want = new Map(); // fileId → {name, mime}
    _sosEachFile(f => {
      if (f.fileId && !f.storageUrl && !_sosCloudUrls.has(f.fileId) && !want.has(f.fileId))
        want.set(f.fileId, { name: f.name, mime: f.mime });
    });
    const total = want.size;
    if (!total) {
      if (manual) showNotif(SOI.cloud, 'All synced', 'Every file on this device is already in the cloud.');
      return { uploaded: 0, total: 0, missing: 0, tooBig: 0, failed: 0 };
    }

    let uploaded = 0, strikes = 0, missing = 0, tooBig = 0, failed = 0, seen = 0;
    for (const [fileId, meta] of want) {
      seen++;
      if (onProgress) onProgress(seen, total, meta.name);
      let blob;
      try { blob = await SosFileStore.get(fileId); } catch (_) {}
      if (!blob) { missing++; continue; }          // no local copy on this device → skip
      if (blob.size > SOS_CLOUD_MAX) { tooBig++; continue; } // absurdly large → local-only
      try {
        const file = new File([blob], meta.name || 'document', { type: meta.mime || blob.type || 'application/octet-stream' });
        const url = await SosCloud.upload(fileId, file, p => _sosPaintProgress(fileId, p));
        _sosCloudUrls.set(fileId, url);            // remember so syncs can't drop it
        uploaded++; strikes = 0;
      } catch (e) {
        failed++;
        console.warn('SOS backfill upload failed:', meta.name, e);
        if (++strikes >= 3) break;                 // worker likely down — retry next sync
      }
    }

    if (uploaded) {
      // Stamp the new URLs onto the live data (by fileId — current arrays), save, refresh.
      _sosReapplyCloudUrls();
      persist(); persistKsu();
      _sosRefreshAllDocLists();
      _sosRefreshStorage();
      if (!manual) showNotif(SOI.cloud, 'Synced to cloud', uploaded + ' file' + (uploaded > 1 ? 's are' : ' is') + ' now available on all devices.');
    } else if (manual && missing) {
      showNotif(SOI.alert, 'Files not on this device', missing + ' file' + (missing > 1 ? "s aren't" : " isn't") + ' stored on this device, so they can\'t be uploaded from here. Open StudyOS on the device that has them.');
    }
    return { uploaded, total, missing, tooBig, failed };
  } finally {
    _sosBackfillRunning = false;
  }
}

// ── "Sync to Cloud" button (sidebar) ──────────────────────────────────────
let _sosCloudSyncBusy = false;
async function sosCloudSyncClick() {
  if (_sosCloudSyncBusy) return;
  _sosCloudSyncBusy = true;
  const btn = document.getElementById('sos-cloud-sync-btn');
  const label = btn ? btn.querySelector('.sos-cloud-sync-label') : null;
  const setLabel = t => { if (label) label.textContent = t; };
  const orig = label ? label.textContent : 'Sync to Cloud';
  if (btn) btn.disabled = true;
  setLabel('Syncing…');
  try {
    const r = await _sosBackfillCloud(true, (done, total) => setLabel('Syncing ' + done + '/' + total + '…'));
    if (r && r.busy) { setLabel('Already running…'); }
    else if (r && r.uploaded) {
      setLabel(SOI.check + ' ' + r.uploaded + ' synced');
      const extra = [];
      if (r.tooBig)  extra.push(r.tooBig + ' over 25MB');
      if (r.missing) extra.push(r.missing + ' not on this device');
      if (r.failed)  extra.push(r.failed + ' failed');
      showNotif(SOI.cloud, 'Sync complete', r.uploaded + ' file' + (r.uploaded > 1 ? 's' : '') + ' uploaded — now on all devices.' + (extra.length ? ' (' + extra.join(', ') + ')' : ''));
    } else if (r && r.total === 0) {
      setLabel(SOI.check + ' All synced');
    } else {
      setLabel('Nothing to upload');
    }
  } catch (e) {
    console.warn('Sync to Cloud failed:', e);
    setLabel(SOI.alert + ' Failed — retry');
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => setLabel('Sync to Cloud'), 4000);
    _sosCloudSyncBusy = false;
    _sosUpdateCloudBadge();
  }
}
window.sosCloudSyncClick = sosCloudSyncClick;

// Refresh whatever module doc-lists are currently rendered so ☁ badges update.
function _sosRefreshAllDocLists() {
  const stamp = (cls, mods) => { for (const mod of (mods || [])) _sosRefreshModFiles(cls, mod, mod.id); };
  for (const cls of classes) stamp(cls, cls.modules);
  stamp({ id: 'ksu', color: '#8D769A', modules: ksuData.modules, _ksu: true }, ksuData.modules);
}

function setTodayDate() {
  const today = new Date().toISOString().split('T')[0];
  _sosEl('inp-event-date').value = today;
}

// ===== COLORS =====
function buildColorGrid() {
  const grid = _sosEl('color-grid');
  grid.innerHTML = '';
  COLORS.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (c === selectedColor ? ' selected' : '');
    sw.style.background = c;
    sw.onclick = () => {
      selectedColor = c;
      grid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    };
    grid.appendChild(sw);
  });
}

// ===== VIEW SWITCHING =====
function switchView(view, classId) {
  document.querySelectorAll('#study-root .view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('#study-root .nav-item').forEach(n => n.classList.remove('active'));
  _sosEl('view-' + (view === 'class' ? 'class' : view)).classList.add('active');
  if (view !== 'class') {
    const navEl = _sosEl('nav-' + view);
    if (navEl) navEl.classList.add('active');
  }
  activeView = view;
  const titles = { home:'Dashboard', calendar:'Calendar', notes:'Quick Notes', class:'Class Detail', pomodoro:'Pomodoro', ksu:'KSU' };
  if (view === 'ksu') renderKsuModules();
  _sosEl('topbar-title').textContent = titles[view] || 'StudyOS';
  if (view === 'class' && classId) openClassDetail(classId);
  if (view === 'calendar') renderCalendar();
  // Sync bottom nav active state
  var bnViews = ['home','calendar','notes','ksu','pomodoro'];
  bnViews.forEach(function(v) {
    var btn = document.getElementById('sos-bn-' + v);
    if (btn) btn.classList.toggle('active', v === view);
  });
}

// ===== CLASSES =====
function openAddClass() {
  selectedColor = COLORS[0];
  buildColorGrid();
  _sosEl('inp-class-name').value = '';
  _sosEl('inp-class-code').value = '';
  _sosEl('inp-class-instructor').value = '';
  _sosOpen('modal-add-class');
}

function saveClass() {
  const name = _sosEl('inp-class-name').value.trim();
  if (!name) { alert('Class name required.'); return; }
  const cls = {
    id: Date.now().toString(),
    name,
    code: _sosEl('inp-class-code').value.trim(),
    instructor: _sosEl('inp-class-instructor').value.trim(),
    color: selectedColor,
    modules: [],
  };
  classes.push(cls);
  persist();
  _sosClose('modal-add-class');
  renderClasses();
  renderSidebarClasses();
  updateStats();
  populateEventClassSelect();
  showNotif('', 'Class Created', cls.name + ' added to your semester.');
}

let selectedColorEdit = COLORS[0];

function buildColorGridEdit() {
  const grid = _sosEl('color-grid-edit');
  grid.innerHTML = '';
  COLORS.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (c === selectedColorEdit ? ' selected' : '');
    sw.style.background = c;
    sw.onclick = () => {
      selectedColorEdit = c;
      grid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    };
    grid.appendChild(sw);
  });
}

function openEditClass() {
  const cls = classes.find(c => c.id === currentClassId);
  if (!cls) return;
  selectedColorEdit = cls.color;
  buildColorGridEdit();
  _sosEl('inp-edit-class-name').value = cls.name;
  _sosEl('inp-edit-class-code').value = cls.code || '';
  _sosEl('inp-edit-class-instructor').value = cls.instructor || '';
  _sosOpen('modal-edit-class');
}

function saveEditClass() {
  const cls = classes.find(c => c.id === currentClassId);
  if (!cls) return;
  const name = _sosEl('inp-edit-class-name').value.trim();
  if (!name) { alert('Class name required.'); return; }
  cls.name = name;
  cls.code = _sosEl('inp-edit-class-code').value.trim();
  cls.instructor = _sosEl('inp-edit-class-instructor').value.trim();
  cls.color = selectedColorEdit;
  persist();
  _sosClose('modal-edit-class');
  openClassDetail(currentClassId);
  renderClasses();
  renderSidebarClasses();
  showNotif(SOI.pencil, 'Class Updated', cls.name + ' saved.');
}

async function deleteCurrentClass() {
  if (!currentClassId) return;
  const cls = classes.find(c => c.id === currentClassId);
  if (!(await window.uiConfirm('Remove "' + (cls ? cls.name : '') + '" and all its modules?', {danger:true, okLabel:'Remove'}))) return;
  classes = classes.filter(c => c.id !== currentClassId);
  persist();
  renderClasses();
  renderSidebarClasses();
  updateStats();
  populateEventClassSelect();
  switchView('home');
}

function renderClasses() {
  const grid = _sosEl('classes-grid');
  const empty = _sosEl('empty-msg');
  // Remove only class cards, never destroy empty-msg
  grid.querySelectorAll('.class-card').forEach(c => c.remove());
  if (classes.length === 0) {
    grid.appendChild(empty);
    empty.style.display = '';
    _sosEl('class-count').textContent = 0;
    return;
  }
  empty.style.display = 'none';
  classes.forEach(cls => {
    const card = document.createElement('div');
    card.className = 'class-card';
    card.style.setProperty('--card-color', cls.color);
    card.onclick = () => switchView('class', cls.id);
    card.innerHTML = `
      <div class="class-name">${cls.name}</div>
      <div class="class-code">${cls.code}${cls.instructor ? ' · ' + cls.instructor : ''}</div>
      <div class="class-modules">
        ${cls.modules.map(m => `<div class="module-chip">${m.name}</div>`).join('')}
        ${cls.modules.length === 0 ? '<div class="module-chip" style="color:var(--text3)">No modules yet</div>' : ''}
      </div>
    `;
    grid.appendChild(card);
  });
  _sosEl('class-count').textContent = classes.length;
}

async function removeClass(id) {
  const cls = classes.find(c => c.id === id);
  if (!(await window.uiConfirm('Remove "' + (cls ? cls.name : '') + '"?', {danger:true, okLabel:'Remove'}))) return;
  classes = classes.filter(c => c.id !== id);
  persist();
  renderClasses();
  renderSidebarClasses();
  updateStats();
  populateEventClassSelect();
}

function renderSidebarClasses() {
  const el = _sosEl('sidebar-classes');
  el.innerHTML = '';
  classes.forEach(cls => {
    const item = document.createElement('div');
    item.className = 'nav-item';
    item.style.borderLeft = '3px solid ' + cls.color;
    item.style.paddingLeft = '9px';
    item.onclick = () => switchView('class', cls.id);
    item.innerHTML = cls.name;
    el.appendChild(item);
  });
}

// ===== CLASS DETAIL =====
function openClassDetail(id) {
  const cls = classes.find(c => c.id === id);
  if (!cls) return;
  currentClassId = id;
  _sosEl('breadcrumb-class').textContent = cls.name;
  _sosEl('detail-title').textContent = cls.name;
  _sosEl('detail-subtitle').textContent = [cls.code, cls.instructor].filter(Boolean).join(' · ');
  _sosEl('detail-color-bar').style.background = cls.color;
  renderModules(cls);
  renderClassEvents(cls);
}

function renderClassEvents(cls) {
  const list = _sosEl('class-events-list');
  list.innerHTML = '';
  const _p=n=>String(n).padStart(2,'0');
  const _now=new Date();
  const todayStr = _now.getFullYear()+'-'+_p(_now.getMonth()+1)+'-'+_p(_now.getDate());

  // Build a mixed array of events and tasks, each tagged with kind + sort date
  const items = [];

  events
    .filter(e => e.classId === cls.id && e.date >= todayStr)
    .forEach(e => items.push({ kind: 'event', date: e.date, data: e }));

  tasks
    .filter(t => t.classId === cls.id && (!t.dueDate || t.dueDate >= todayStr))
    .forEach(t => items.push({ kind: 'task', date: t.dueDate || todayStr, data: t }));

  if (items.length === 0) {
    list.innerHTML = '<div class="class-events-empty">No upcoming events or tasks.<br><span style="font-size:10px">Click + Event or + Task to create one.</span></div>';
    return;
  }

  // Sort by date asc; tasks after events on same day; done tasks last
  items.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1;
    if (a.kind === 'task') {
      const ad = a.data.done, bd = b.data.done;
      if (ad !== bd) return ad ? 1 : -1;
      const po = { high:0, medium:1, low:2 };
      return (po[a.data.priority]||1) - (po[b.data.priority]||1);
    }
    return 0;
  });

  items.forEach(({ kind, data }) => {
    const item = document.createElement('div');
    item.className = 'class-event-item';

    if (kind === 'event') {
      const ev = data;
      const color = EVENT_COLORS[ev.type] || '#888';
      item.title = 'Click to edit';
      item.onclick = () => openAddEvent(ev);
      item.innerHTML = `
        <div class="class-event-dot" style="background:${color}"></div>
        <div style="flex:1;min-width:0">
          <div class="class-event-name">${ev.name}</div>
          <div class="class-event-meta">${formatDate(ev.date)}${ev.time ? ' · ' + ev.time : ''} · ${ev.type}</div>
        </div>
        <button style="background:none;border:1px solid var(--border2);color:var(--text3);cursor:pointer;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;white-space:nowrap;flex-shrink:0;font-family:inherit;transition:0.15s" title="Convert to Task" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text3)'" onclick="event.stopPropagation();convertEventToTask('${ev.id}')">→ Task</button>
      `;
    } else {
      const t = data;
      const pColor = PRIORITY_COLORS[t.priority] || '#888';
      item.style.cursor = 'default';
      item.innerHTML = `
        <div style="width:8px;height:8px;border-radius:2px;margin-top:5px;flex-shrink:0;border:1.5px solid ${pColor};background:${t.done ? pColor : 'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:7px;color:#fff;font-weight:700;transition:0.2s" onclick="toggleTaskDone('${t.id}')">${t.done ? SOI.checkBold : ''}</div>
        <div style="flex:1;min-width:0">
          <div class="class-event-name" style="${t.done ? 'text-decoration:line-through;color:var(--text3)' : ''}">${t.name}</div>
          ${t.dueDate ? `<div class="class-event-meta">${formatDate(t.dueDate)}${t.dueTime ? ' · ' + t.dueTime : ''} · task</div>` : (t.notes ? `<div class="class-event-meta">${t.notes.slice(0,40)}${t.notes.length>40?'…':''}</div>` : '')}
        </div>
        <button style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px;padding:2px 4px;border-radius:3px;transition:0.15s" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text3)'" title="Edit" aria-label="Edit" onclick="openEditTask('${t.id}')">${SOI.pencil}</button>
        <button style="background:none;border:1px solid var(--border2);color:var(--text3);cursor:pointer;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;white-space:nowrap;flex-shrink:0;font-family:inherit;transition:0.15s" title="Convert to Event" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text3)'" onclick="convertTaskToEvent('${t.id}')">→ Event</button>
      `;
    }

    list.appendChild(item);
  });
}

function openAddEventForClass() {
  populateEventClassSelect();
  editingEventId = null;
  document.querySelector('#modal-add-event .modal-title').textContent = 'Add Event';
  setTodayDate();
  _sosEl('inp-event-name').value = '';
  _sosEl('inp-event-time').value = '';
  _sosEl('inp-event-class').value = currentClassId || '';
  _sosEl('inp-event-type').value = 'hw';
  { const _nd=_sosEl('inp-event-notif-date'); if(_nd)_nd.value=''; const _nt=_sosEl('inp-event-notif-time'); if(_nt)_nt.value=''; }
  _sosEl('btn-delete-event').style.display = 'none';
  _sosOpen('modal-add-event');
}

function renderModules(cls) {
  const grid = _sosEl('modules-grid');
  grid.innerHTML = '';
  cls.modules.forEach((m) => {
    // migrate old modules without id/type
    if (!m.id) m.id = Date.now().toString() + Math.random();
    if (!m.type) m.type = 'documents';
    if (!m.files) m.files = [];
    if (!m.prompts) m.prompts = [];
    if (m.noteBody === undefined) m.noteBody = '';

    const btn = document.createElement('div');
    btn.className = 'module-btn';
    btn.dataset.id = m.id;
    const meta = m.type === 'documents' ? (m.files.length + ' file' + (m.files.length !== 1 ? 's' : ''))
                : m.type === 'prompts' ? (m.prompts.length + ' prompt' + (m.prompts.length !== 1 ? 's' : ''))
                : 'Notes';
    btn.innerHTML = `
      <div class="th-drag-handle" title="Drag to reorder" onclick="event.stopPropagation()">⠿</div>
      <button class="rename-btn" title="Rename" onclick="event.stopPropagation();openRenameModule('${cls.id}','${m.id}')">${SOI.pencil}</button>
      <button class="delete-btn" title="Delete" aria-label="Delete" onclick="event.stopPropagation();deleteModule('${cls.id}','${m.id}')">${SOI.x}</button>
      <div class="module-btn-icon" style="background:${cls.color}22;color:${cls.color};font-size:11px">${m.type.toUpperCase().slice(0,3)}</div>
      <div class="module-btn-name">${m.name}</div>
      <div class="module-btn-meta">${meta}</div>
    `;
    btn.onclick = () => openModuleDetail(cls, m);
    grid.appendChild(btn);
  });
  thDragList(grid, () => cls.modules, (arr) => { cls.modules = arr; }, () => persistForCls(cls), cls.color);
}

function openAddModule() {
  _sosOpen('modal-add-module');
}

let pendingModuleType = null;
let _ksuAddPending = false;

function openModuleCreate(type) {
  pendingModuleType = type;
  const titles = { documents: 'New Documents Module', prompts: 'New AI Prompts Module', notes: 'New Notes Module' };
  _sosEl('module-create-title').textContent = titles[type];
  _sosEl('inp-module-name').value = '';
  _sosClose('modal-add-module');
  _sosOpen('modal-module-create');
}

function saveModule() {
  const name = _sosEl('inp-module-name').value.trim();
  if (!name) { alert('Module name required.'); return; }
  const ICONS = { documents: 'doc', prompts: 'ai', notes: 'txt' };
  const newMod = {
    id: Date.now().toString(),
    name,
    type: pendingModuleType || 'documents',
    icon: ICONS[pendingModuleType] || '📄',
    files: [],
    prompts: [],
    notes: [],
  };
  if (_ksuAddPending) {
    _ksuAddPending = false;
    ksuData.modules.push(newMod);
    persistKsu();
    _sosClose('modal-module-create');
    renderKsuModules();
  } else {
    const cls = classes.find(c => c.id === currentClassId);
    if (!cls) return;
    cls.modules.push(newMod);
    persist();
    _sosClose('modal-module-create');
    renderModules(cls);
    renderClasses();
    updateStats();
  }
}

let _sosRenameTarget = null;

function openRenameModule(classId, modId) {
  const cls = findClassOrKsu(classId);
  if (!cls) return;
  const mod = cls.modules.find(m => m.id === modId);
  if (!mod) return;
  _sosRenameTarget = { classId, modId };
  _sosEl('inp-rename-module-name').value = mod.name;
  _sosOpen('modal-rename-module');
}

function saveRenameModule() {
  if (!_sosRenameTarget) return;
  const name = _sosEl('inp-rename-module-name').value.trim();
  if (!name) { alert('Module name required.'); return; }
  const cls = findClassOrKsu(_sosRenameTarget.classId);
  if (!cls) return;
  const mod = cls.modules.find(m => m.id === _sosRenameTarget.modId);
  if (!mod) return;
  mod.name = name;
  persistForCls(cls);
  _sosClose('modal-rename-module');
  if (cls._ksu) renderKsuModules(); else renderModules(cls);
  if (_sosCurrentModuleId === mod.id) {
    const titleText = _sosEl('module-detail-title-text');
    if (titleText) titleText.textContent = name;
  }
}

async function deleteModule(classId, modId) {
  const cls = findClassOrKsu(classId);
  if (!cls) return;
  const mod = cls.modules.find(m => m.id === modId);
  if (!(await window.uiConfirm('Remove "' + (mod ? mod.name : 'this module') + '"?', {danger:true, okLabel:'Remove'}))) return;
  cls.modules = cls.modules.filter(m => m.id !== modId);
  persist();
  renderModules(cls);
  updateStats();
}

const moduleEditMode = {};
let _sosCurrentModuleClassId = null;
let _sosCurrentModuleId = null;

// #so-root is a single persistent DOM node the Notes editor moves into whichever
// module's modal is open (see openNotesModule in js/notes-sync.js). Since
// openModuleDetail/openKsuModuleDetail wipe #module-detail-body via innerHTML='',
// #so-root must be parked back at the document body first or that wipe deletes
// it permanently — the next Notes module opened would find no #so-root to reuse.
function _sosParkSoRoot() {
  var soRoot = document.getElementById('so-root');
  if (soRoot && soRoot.parentNode !== document.body) {
    soRoot.style.display = 'none';
    document.body.appendChild(soRoot);
  }
}

function openModuleDetail(cls, mod) {
  _sosCurrentModuleClassId = cls.id;
  _sosCurrentModuleId = mod.id;
  _sosParkSoRoot();
  _sosEl('module-detail-title-text').textContent = mod.name;
  const body = _sosEl('module-detail-body');
  body.innerHTML = '';

  // Always default to view mode when opening
  moduleEditMode[mod.id] = false;

  // Notes modules use the page editor's own View/Edit toggle (so-btn-edit) —
  // the generic slider below is for Documents/Prompts only.
  if (mod.type !== 'notes') {
    const toggleWrap = document.createElement('div');
    toggleWrap.className = 'mode-toggle-wrap';
    toggleWrap.innerHTML = `
      <span class="mode-toggle-label ${!moduleEditMode[mod.id] ? 'active' : ''}" id="lbl-view-${mod.id}">View</span>
      <div class="mode-slider ${moduleEditMode[mod.id] ? 'edit-on' : ''}" id="mode-slider-${mod.id}" onclick="toggleModuleMode('${cls.id}','${mod.id}')">
        <div class="mode-slider-thumb"></div>
      </div>
      <span class="mode-toggle-label ${moduleEditMode[mod.id] ? 'active' : ''}" id="lbl-edit-${mod.id}">Edit</span>
    `;
    body.appendChild(toggleWrap);
  }

  const content = document.createElement('div');
  content.id = 'module-content-' + mod.id;
  body.appendChild(content);

  renderModuleContent(content, cls, mod);
  _sosOpen('modal-module-detail');
}

function toggleModuleMode(classId, modId) {
  moduleEditMode[modId] = !moduleEditMode[modId];
  const editOn = moduleEditMode[modId];
  const slider = _sosEl('mode-slider-' + modId);
  const lblView = _sosEl('lbl-view-' + modId);
  const lblEdit = _sosEl('lbl-edit-' + modId);
  if (slider) slider.className = 'mode-slider' + (editOn ? ' edit-on' : '');
  if (lblView) lblView.classList.toggle('active', !editOn);
  if (lblEdit) lblEdit.classList.toggle('active', editOn);
  const cls = classes.find(c => c.id === classId);
  const mod = cls && cls.modules.find(m => m.id === modId);
  const content = _sosEl('module-content-' + modId);
  if (cls && mod && content) { content.innerHTML = ''; renderModuleContent(content, cls, mod); }
}

function renderModuleContent(container, cls, mod) {
  if (mod.type === 'documents') renderDocumentsModule(container, cls, mod);
  else if (mod.type === 'prompts') renderPromptsModule(container, cls, mod);
  else if (mod.type === 'notes') { if (window.openNotesModule) window.openNotesModule(cls.id, mod); }
}

// Flushes the page editor's pending save (if a Notes module is open) before
// closing the shared module-detail modal, then hides #so-root so the next
// module opened (of any type) doesn't briefly show stale editor content.
function closeModuleDetail() {
  var cls = findClassOrKsu(_sosCurrentModuleClassId);
  var mod = cls && cls.modules.find(function(m) { return m.id === _sosCurrentModuleId; });
  if (mod && mod.type === 'notes' && window.closeNotesModule) window.closeNotesModule();
  _sosClose('modal-module-detail');
}
document.addEventListener('DOMContentLoaded', function() {
  var overlay = document.getElementById('modal-module-detail');
  if (overlay) overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModuleDetail(); });
});

// ---- DOCUMENTS ----
function renderDocumentsModule(body, cls, mod) {
  const editOn = !!moduleEditMode[mod.id];

  const list = document.createElement('div');
  list.className = 'doc-list';
  list.id = 'doc-list-' + mod.id;
  refreshDocList(list, cls, mod);
  body.appendChild(list);

  if (editOn) {
    const zone = document.createElement('div');
    zone.className = 'upload-zone';
    zone.innerHTML = `
      <div style="font-size:28px;margin-bottom:8px;opacity:.45;display:flex;justify-content:center">${SOI.clip}</div>
      <div style="font-weight:700;margin-bottom:4px">Drop files or click to upload</div>
      <div style="font-size:11px;color:var(--text3);font-family:var(--mono)">Any file type — stored locally in browser</div>
      <input type="file" multiple id="file-input-${mod.id}" onchange="handleFileUpload(event,'${cls.id}','${mod.id}')">
    `;
    zone.ondragover = e => { e.preventDefault(); zone.style.borderColor = 'var(--accent)'; };
    zone.ondragleave = () => { zone.style.borderColor = ''; };
    zone.ondrop = e => {
      e.preventDefault();
      // Keep the global window drop handler out: this zone already knows the
      // destination, so it files directly. Without this the same files would
      // ALSO be ingested via the picker and land twice.
      e.stopPropagation();
      zone.style.borderColor = '';
      handleFilesAdded(Array.from(e.dataTransfer.files), cls.id, mod.id);
    };
    body.appendChild(zone);
  }
}

// ── SosFileStore: IndexedDB blob storage for StudyOS documents ────────────
// Files live here; only metadata ({id,name,size,mime,fileId}) goes in classes[].
const SosFileStore = (function() {
  const DB = 'sos_file_store', VER = 1, ST = 'files';
  let _db = null, _opening = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    if (_opening) return _opening;            // coalesce concurrent opens
    const p = new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open(DB, VER); }
      catch (e) { rej(e); return; }           // storage blocked entirely (private mode / shields)
      r.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(ST)) db.createObjectStore(ST, { keyPath: 'id' });
      };
      r.onsuccess = e => {
        const db = e.target.result;
        // A connection can die under us: storage eviction while the tab is
        // backgrounded, another tab upgrading the DB, the browser clearing site
        // data. Nothing used to clear the cached handle, so once that happened
        // EVERY later read/write threw InvalidStateError for the life of the
        // page — which is how a perfectly good upload reported "could not be
        // saved". Drop the handle so the next call reopens.
        db.onclose = () => { if (_db === db) _db = null; };
        db.onversionchange = () => { try { db.close(); } catch (_) {} if (_db === db) _db = null; };
        _db = db; res(db);
      };
      r.onerror   = e => rej((e.target && e.target.error) || new Error('indexedDB.open failed'));
      // Without this the promise would hang forever instead of failing.
      r.onblocked = () => rej(new Error('IndexedDB upgrade blocked by another tab'));
    });
    _opening = p;
    const clear = () => { if (_opening === p) _opening = null; };
    p.then(clear, clear);
    return p;
  }

  // Run a transaction; if the cached connection turned out to be dead, throw it
  // away and try once more on a fresh one. Every job below is keyed by a
  // caller-supplied id, so a retry is idempotent — it can't duplicate a file.
  async function withDb(job) {
    try {
      return await job(await open());
    } catch (e) {
      _db = null; _opening = null;
      return await job(await open());
    }
  }

  // Wrap a readwrite tx. onabort matters as much as onerror: a quota failure
  // aborts at commit time without firing onerror, which used to leave the
  // promise pending forever (upload spinner stuck, no error, no file).
  function writeTx(db, fn) {
    return new Promise((res, rej) => {
      let tx;
      try { tx = db.transaction(ST, 'readwrite'); } catch (e) { rej(e); return; }
      try { fn(tx.objectStore(ST)); } catch (e) { rej(e); return; }
      tx.oncomplete = () => res();
      tx.onerror    = e => rej(tx.error || (e.target && e.target.error) || new Error('write failed'));
      tx.onabort    = () => rej(tx.error || new Error('transaction aborted'));
    });
  }

  const newId = () => 'sf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  return {
    save: function(file) {
      // A File *is* a Blob — same path, no duplicated logic.
      return SosFileStore.saveBlob(file, file && file.name);
    },
    saveBlob: async function(blob, name) {
      const id = newId();
      // Read the bytes outside the DB retry: a NotReadableError here is a
      // problem with the file on disk, not with IndexedDB, and retrying is futile.
      const buf = await blob.arrayBuffer();
      const mime = blob.type || 'application/octet-stream';
      await withDb(db => writeTx(db, st => st.put({ id, buf, name: name || 'document', mime })));
      return id;
    },
    // Cache a blob under a specific (existing) id — used to store a file
    // pulled down from the cloud so later views/drags are instant & offline.
    putById: async function(id, blob, name) {
      const buf = await blob.arrayBuffer();
      const mime = blob.type || 'application/octet-stream';
      await withDb(db => writeTx(db, st => st.put({ id, buf, name: name || 'document', mime })));
      return id;
    },
    get: async function(id) {
      if (!id) return null;
      return withDb(db => new Promise((res, rej) => {
        let tx;
        try { tx = db.transaction(ST, 'readonly'); } catch (e) { rej(e); return; }
        const req = tx.objectStore(ST).get(id);
        req.onsuccess = e => {
          const r = e.target.result;
          res(r ? new Blob([r.buf], { type: r.mime }) : null);
        };
        req.onerror = e => rej((e.target && e.target.error) || new Error('read failed'));
        tx.onabort  = () => rej(tx.error || new Error('transaction aborted'));
      }));
    },
    // Existence check that does NOT materialize the bytes. The cloud badge runs
    // this over every un-synced file; pulling whole PDFs into memory just to ask
    // "is it here?" made that sweep slow and memory-hungry.
    has: async function(id) {
      if (!id) return false;
      return withDb(db => new Promise((res, rej) => {
        let tx;
        try { tx = db.transaction(ST, 'readonly'); } catch (e) { rej(e); return; }
        const st = tx.objectStore(ST);
        // getKey isn't universal on older WebKit — fall back to a count().
        const req = st.getKey ? st.getKey(id) : st.count(id);
        req.onsuccess = e => res(!!e.target.result);
        req.onerror = e => rej((e.target && e.target.error) || new Error('read failed'));
        tx.onabort  = () => rej(tx.error || new Error('transaction aborted'));
      }));
    },
    delete: async function(id) {
      if (!id) return;
      await withDb(db => writeTx(db, st => st.delete(id)));
    },
    openTab: async function(fileId, name) {
      const blob = await SosFileStore.get(fileId);
      if (!blob) { showNotif(SOI.alert, 'File missing', 'File data not found. It may have been cleared.'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    download: async function(fileId, name) {
      const blob = await SosFileStore.get(fileId);
      if (!blob) { showNotif(SOI.alert, 'File missing', 'File data not found.'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name || 'document';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  };
})();

// ── Migrate legacy dataUrl files to IndexedDB (runs once on init) ─────────
async function _sosMigrateFilesToIdb() {
  let dirty = false;
  for (const cls of classes) {
    for (const mod of (cls.modules || [])) {
      for (const f of (mod.files || [])) {
        if (f.dataUrl && !f.fileId) {
          try {
            // dataUrl → Blob → IDB
            const [header, b64] = f.dataUrl.split(',');
            const mime = (header.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
            const bytes = atob(b64);
            const arr = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
            const blob = new Blob([arr], { type: mime });
            f.fileId = await SosFileStore.saveBlob(blob, f.name);
            f.mime = mime;
            delete f.dataUrl; // strip blob from metadata
            dirty = true;
          } catch(e) { console.warn('SOS migrate file failed:', f.name, e); }
        }
      }
    }
  }
  if (dirty) {
    // Serialize the same way every other write does, so transient `_`-flags
    // and any leftover dataUrl can't leak back into storage.
    localStorage.setItem('studyos_classes', JSON.stringify(_sosSerializeClasses()));
  }
}

// ── StudyOS cross-device file sync (Cloudflare KV worker — free, no card) ──
// Files upload to the `studyos-files` Worker (Workers KV, free plan). The
// returned URL rides along in the synced file metadata, so any device can
// fetch a file it never uploaded locally. Local IndexedDB stays the fast path
// / offline cache; the KV worker is the fallback + cross-device link.
// Worker origin comes from config.js — never hardcode it here. When the files
// worker is unconfigured this is null, and _sosRequireCloud() below turns every
// upload/download attempt into a clear "not configured" error instead of a
// request fired at a placeholder hostname.
const SOS_CLOUD_BASE = _SOS_CLOUD_OK ? String(_SOS_FILES.baseUrl || '').replace(/\/+$/, '') : null;
function _sosRequireCloud() {
  if (SOS_CLOUD_BASE) return true;
  const e = new Error('cloud-not-configured');
  e.notConfigured = true;
  throw e;
}
// Per-part size. Must stay under the worker's own MAX_VALUE (24MB) which is
// itself under the hard 25MB KV value cap.
const SOS_CHUNK      = 20 * 1024 * 1024;
// Total we're willing to push for one file. Nothing in KV stops us going
// higher — this only exists so a mis-drag of a 5GB video fails fast and loud
// instead of grinding through 250 uploads.
const SOS_CLOUD_MAX  = 500 * 1024 * 1024;
const SOS_KV_LIMIT   = _SOS_FILES.capacityBytes || 1024 * 1024 * 1024; // free-plan KV total, for the indicator
let _sosCloudWarned = false;

// One PUT with a bounded retry. The key is derived from the fileId, so every
// request here is idempotent — a retry can never duplicate or corrupt.
async function _sosPut(url, body, headers, _attempt) {
  try {
    const resp = await fetch(url, { method: 'PUT', headers: headers || {}, body });
    if (!resp.ok) {
      const err = new Error('upload ' + resp.status);
      err.status = resp.status;
      // 413 means the payload itself is wrong — retrying is pointless and, when
      // it was reported as a network blip, produced an infinite retry loop.
      err.retryable = resp.status === 429 || resp.status >= 500;
      throw err;
    }
    return resp;
  } catch (e) {
    if (e && e.retryable === false) throw e;
    if (_attempt >= 2) throw e;
    await new Promise(r => setTimeout(r, 1500 * ((_attempt || 0) + 1)));
    return _sosPut(url, body, headers, (_attempt || 0) + 1);
  }
}

const SosCloud = {
  // Store the file under its fileId and return the GET url.
  //
  // Files that fit in a single KV value go up whole. Anything bigger is split
  // into parts and finalized with a manifest — which is what makes a 65-page
  // PDF (or anything else over 25MB) sync at all; it previously just stayed on
  // the device that uploaded it. `onProgress(fraction)` reports 0→1.
  async upload(fileId, file, onProgress) {
    _sosRequireCloud();
    if (file.size > SOS_CLOUD_MAX) { const e = new Error('too-large'); e.tooLarge = true; throw e; }
    const u = SOS_CLOUD_BASE + '/f/' + encodeURIComponent(fileId);
    const report = f => { try { if (onProgress) onProgress(Math.max(0, Math.min(1, f))); } catch (_) {} };

    if (file.size <= SOS_CHUNK) {
      report(0);
      await _sosPut(u, file, {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name || 'document'),
      });
      report(1);
      return u;
    }

    const parts = Math.ceil(file.size / SOS_CHUNK);
    for (let i = 0; i < parts; i++) {
      const slice = file.slice(i * SOS_CHUNK, Math.min((i + 1) * SOS_CHUNK, file.size));
      await _sosPut(
        SOS_CLOUD_BASE + '/p/' + encodeURIComponent(fileId) + '/' + i,
        slice,
        { 'Content-Type': 'application/octet-stream' }
      );
      // Hold the last sliver back for the manifest so it can't read "100%"
      // while the file is still unreadable to other devices.
      report(((i + 1) / parts) * 0.98);
    }
    // Manifest last: until it lands, GET /f/<id> 404s rather than serving a
    // half-uploaded file.
    await _sosPut(
      SOS_CLOUD_BASE + '/m/' + encodeURIComponent(fileId),
      JSON.stringify({ parts, size: file.size, type: file.type || 'application/octet-stream', name: file.name || 'document' }),
      { 'Content-Type': 'application/json' }
    );
    report(1);
    return u;
  },
  async remove(fileId) {
    if (!fileId || !SOS_CLOUD_BASE) return;
    try { await fetch(SOS_CLOUD_BASE + '/f/' + encodeURIComponent(fileId), { method: 'DELETE' }); } catch (_) {}
  },
  async usage() {
    _sosRequireCloud();
    const r = await fetch(SOS_CLOUD_BASE + '/usage');
    if (!r.ok) throw new Error('usage ' + r.status);
    return r.json();
  },
};

// Resolve a file's bytes: local IDB first, then the cloud copy (cached back).
async function sosResolveBlob(f) {
  if (!f) return null;
  if (f.fileId) {
    try { const b = await SosFileStore.get(f.fileId); if (b) return b; } catch (_) {}
  }
  if (f.storageUrl) {
    try {
      const resp = await fetch(f.storageUrl);
      if (resp.ok) {
        const raw = await resp.blob();
        const blob = new Blob([raw], { type: f.mime || raw.type || 'application/octet-stream' });
        // Cache locally so future opens/drags are instant and work offline.
        if (f.fileId) SosFileStore.putById(f.fileId, blob, f.name).catch(() => {});
        return blob;
      }
    } catch (_) { /* CORS or network — fall through to open-by-URL */ }
  }
  return null;
}

async function sosOpenFile(f) {
  const blob = await sosResolveBlob(f);
  if (blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  if (f && f.storageUrl) { window.open(f.storageUrl, '_blank', 'noopener'); return; }
  showNotif(SOI.alert, 'File missing', 'No local copy and the cloud copy is unavailable.');
}

async function sosDownloadFile(f) {
  const blob = await sosResolveBlob(f);
  if (blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = (f && f.name) || 'document';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return;
  }
  if (f && f.storageUrl) { window.open(f.storageUrl, '_blank', 'noopener'); return; }
  showNotif(SOI.alert, 'File missing', 'No local copy and the cloud copy is unavailable.');
}

// Push a freshly-uploaded file to Firebase Storage, then re-sync metadata so
// the storageUrl reaches every device. Non-blocking; failure leaves the file
// fully usable locally (degrades to the pre-cloud behaviour).
async function sosUploadToCloud(file, meta, cls, mod, modId) {
  if (!meta.fileId) return;
  const fileId = meta.fileId;
  meta._uploading = true;
  meta._progress = 0;
  delete meta._cloudError;
  _sosRefreshModFiles(cls, mod, modId);
  try {
    const url = await SosCloud.upload(fileId, file, p => {
      // Repaint the one row rather than the whole list, so a multi-part upload
      // doesn't thrash the DOM while it streams.
      meta._progress = p;
      _sosPaintProgress(fileId, p);
    });
    // Record the URL by fileId BEFORE persisting. A Firestore sync landing
    // mid-upload swaps `classes`/`ksuData` wholesale and orphans `meta`, so
    // writing storageUrl onto it alone can be silently thrown away — the file
    // then looks local-only on every device. _sosCloudUrls is what survives
    // that swap; the backfill path always used it, this path never did.
    _sosCloudUrls.set(fileId, url);
    meta.storageUrl  = url;
    meta.storagePath = fileId;        // KV key = fileId
    delete meta._uploading;
    delete meta._progress;
    _sosReapplyCloudUrls();           // stamp onto the CURRENT arrays too
    persistForCls(cls);               // re-sync metadata (now carries storageUrl)
    _sosNoteSynced(meta.name);
    _sosRefreshStorage();
  } catch (e) {
    delete meta._uploading;
    delete meta._progress;
    meta._cloudError = true;
    console.warn('SOS cloud upload failed:', meta.name, e);
    if (e && e.tooLarge) {
      showNotif(SOI.box, 'Too big to sync', (meta.name || 'File') + ' is over ' + _sosFmtBytes(SOS_CLOUD_MAX) + ' — kept on this device only.');
    } else if (e && e.notConfigured) {
      // Terminal, not transient: no amount of retrying invents a worker URL.
      // The file is safe in IndexedDB; it just can't reach other devices yet.
      if (!_sosCloudWarned) {
        _sosCloudWarned = true;
        showNotif(SOI.settings, 'Cloud sync not set up', 'Files are saved on this device. Add your studyos-files Worker URL in config/config.js to sync across devices.');
      }
    } else {
      // Not terminal any more: hand it to the retry loop, which keeps trying
      // until the file is in the cloud and on every device.
      _sosRetryDelay = SOS_RETRY_MIN;
      _sosScheduleSync(SOS_RETRY_MIN);
      if (!_sosCloudWarned) {
        _sosCloudWarned = true;
        showNotif(SOI.cloud, 'Sync retrying', (meta.name || 'File') + ' is saved on this device and will upload automatically as soon as the connection allows.');
      }
    }
  }
  _sosRefreshModFiles(cls, mod, modId);
  _sosUpdateCloudBadge();
}

function _sosRefreshModFiles(cls, mod, modId) {
  const listEl = _sosEl('doc-list-' + modId);
  if (!listEl) return;
  // Re-resolve against the CURRENT arrays: a Firestore sync may have replaced
  // the objects the caller was handed, and rendering those orphans would paint
  // stale state (e.g. a ⚠ local-only badge on a file that just synced).
  const liveCls = (cls && cls.id && findClassOrKsu(cls.id)) || cls;
  const liveMod = (liveCls && liveCls.modules && liveCls.modules.find(m => m.id === modId)) || mod;
  if (liveCls && liveMod) refreshDocList(listEl, liveCls, liveMod);
}

function refreshDocList(listEl, cls, mod) {
  const editOn = !!moduleEditMode[mod.id];
  listEl.innerHTML = '';
  if (!mod.files || mod.files.length === 0) {
    listEl.innerHTML = `<div style="font-size:12px;color:var(--text3);font-family:var(--mono);padding:4px 0 8px">${editOn ? 'No files yet. Upload below.' : 'No files uploaded.'}</div>`;
    return;
  }
  mod.files.forEach((f, idx) => {
    // Migrate legacy files saved before .id existed (thDragList matches by .id).
    if (!f.id) f.id = f.fileId || ('legacy_' + idx + '_' + Date.now().toString(36));

    const item = document.createElement('div');
    item.className = 'doc-item';
    item.dataset.id = f.id;
    item.style.cursor = 'pointer';
    item.title = 'Click to open · drag out to copy into another app';

    // ── Drag-out: drag this file into Explorer / Office / Slack / any app ──
    // We put a real File into the drag via dataTransfer.items.add() (for
    // same-browser drop targets) plus DownloadURL (so the OS file manager
    // writes the actual file out). No text/uri-list — that's what made targets
    // paste a link as text. NOTE: a sandboxed web page can only offer a
    // "virtual file", which apps like Claude (that need a real on-disk path)
    // won't accept — that's a hard browser limitation, not fixable here.
    // The payload must be ready synchronously at dragstart, so we pre-build it
    // on hover / mousedown (IndexedDB reads can't run inside dragstart).
    item.draggable = true;
    let _dragFile = null, _dragUrl = null, _dragReady = false;
    const _prepDrag = () => {
      if (_dragReady || (!f.fileId && !f.storageUrl)) return;
      _dragReady = true;
      sosResolveBlob(f).then(blob => {
        if (blob) {
          const mime = f.mime || blob.type || 'application/octet-stream';
          _dragFile = new File([blob], f.name, { type: mime });
          _dragUrl = URL.createObjectURL(blob);
        } else { _dragReady = false; }
      }).catch(() => { _dragReady = false; });
    };
    item.addEventListener('mouseenter', _prepDrag);
    item.addEventListener('mousedown', _prepDrag);
    item.addEventListener('dragstart', ev => {
      if (!_dragFile) { _prepDrag(); ev.preventDefault(); return; }
      const mime = f.mime || 'application/octet-stream';
      try { ev.dataTransfer.items.add(_dragFile); } catch (_) {}
      // Format "mimetype:filename:url" — lets a native OS drop write the file out.
      if (_dragUrl) ev.dataTransfer.setData('DownloadURL', mime + ':' + f.name + ':' + _dragUrl);
      ev.dataTransfer.effectAllowed = 'copy';
    });
    item.addEventListener('dragend', () => {
      if (_dragUrl) { const u = _dragUrl; setTimeout(() => URL.revokeObjectURL(u), 60000); }
      _dragFile = null; _dragUrl = null; _dragReady = false;
    });

    const icon = document.createElement('div');
    icon.className = 'doc-item-icon';
      icon.innerHTML = fileEmoji(f.name);

    const nameEl = document.createElement('div');
    nameEl.className = 'doc-item-name';
    nameEl.title = f.name;
    nameEl.textContent = f.name;

    const sizeEl = document.createElement('div');
    sizeEl.className = 'doc-item-size';
    sizeEl.textContent = formatBytes(f.size);

    // Download button
    const dlBtn = document.createElement('a');
    dlBtn.title = 'Download';
    dlBtn.innerHTML = SOI.download;
    dlBtn.style.cssText = 'color:var(--text3);text-decoration:none;font-size:14px;padding:4px 8px;border-radius:4px;transition:0.15s;border:1px solid var(--border)';
    dlBtn.addEventListener('mouseover', () => { dlBtn.style.color='var(--accent)'; dlBtn.style.borderColor='var(--accent)'; });
    dlBtn.addEventListener('mouseout',  () => { dlBtn.style.color='var(--text3)';  dlBtn.style.borderColor='var(--border)'; });
    dlBtn.addEventListener('click', e => {
      e.stopPropagation();
      sosDownloadFile(f);
    });

    // Cloud-sync status — a readable word + live percentage, not a lone glyph,
    // so it's obvious at a glance whether a file has actually reached the cloud.
    const cloudEl = document.createElement('div');
    cloudEl.className = 'doc-item-cloud';
    cloudEl.dataset.fileId = f.fileId || '';
    _sosApplyCloudStatus(cloudEl, f);

    if (editOn) {
      const handle = document.createElement('div');
      handle.className = 'th-drag-handle row-drag-handle';
      handle.title = 'Drag to reorder';
      handle.textContent = '⠿';
      handle.addEventListener('click', e => e.stopPropagation());
      item.appendChild(handle);
    }

    item.appendChild(icon);
    item.appendChild(nameEl);
    item.appendChild(sizeEl);
    item.appendChild(cloudEl);
    item.appendChild(dlBtn);

    if (editOn) {
      const delBtn = document.createElement('button');
      delBtn.className = 'doc-item-del';
      delBtn.title = 'Remove';
      delBtn.innerHTML = SOI.x;
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        removeFile(cls.id, mod.id, idx);
      });
      item.appendChild(delBtn);
    }

    // Open in new tab — local IDB blob, else cloud copy
    item.onclick = () => sosOpenFile(f);

    listEl.appendChild(item);
  });

  if (editOn) {
    thDragList(listEl, () => mod.files, (arr) => { mod.files = arr; }, () => { persistForCls(cls); refreshDocList(listEl, cls, mod); }, cls.color || '#8D769A');
  }
}

function handleFileUpload(e, classId, modId) {
  handleFilesAdded(Array.from(e.target.files), classId, modId);
  e.target.value = '';
}

function handleFilesAdded(files, classId, modId) {
  const cls = findClassOrKsu(classId);
  if (!cls) return;
  const mod = cls.modules.find(m => m.id === modId);
  if (!mod) return;
  let done = 0, added = 0;
  // Finish once every file has SETTLED — success or failure. The old counter
  // only advanced on success, so a single bad file in a batch meant the good
  // ones were never persisted, never rendered, and never announced.
  const settle = () => {
    if (++done < files.length || !added) return;
    try {
      persistForCls(cls);
      const listEl = _sosEl('doc-list-' + modId);
      if (listEl) refreshDocList(listEl, cls, mod);
      showNotif(SOI.clip, 'Uploaded', added + ' file' + (added > 1 ? 's' : '') + ' added.');
    } catch (err) {
      // The bytes are already safe in IndexedDB - a render hiccup is not a lost file.
      console.error('SOS post-save refresh failed:', err);
    }
  };
  files.forEach(file => {
    SosFileStore.save(file).then(fileId => {
      try {
        const meta = { id: fileId, name: file.name, size: file.size, mime: file.type || 'application/octet-stream', fileId };
        mod.files.push(meta);
        added++;
        // Push to cloud so it's viewable/downloadable on every device.
        sosUploadToCloud(file, meta, cls, mod, modId)
          .catch(err => console.warn('SOS cloud upload threw:', file.name, err));
      } catch (err) {
        console.error('SOS post-save step failed:', file.name, err);
      }
      settle();
    // Two-arg then, NOT a trailing .catch: this handler must fire only for a
    // real save failure. The old .catch also swallowed anything thrown by the
    // success path above, so a persist/render error was reported to the user as
    // "could not be saved" even though the file WAS stored and did go on to sync.
    }, e => {
      console.error('SOS file save failed:', file.name, e);
      const why = e && e.name ? ' (' + e.name + ')' : '';
      showNotif('\u26a0\ufe0f', 'Upload failed', file.name + ' could not be saved to this device' + why + '.');
      settle();
    });
  });
}

// ═══ DIRECT INGEST: drop anywhere, paste, launch-queue, share ═══════════════
//
// The point of this section is that filing a document should never require
// downloading it first. Every path here — window drop, Ctrl+V, and later the
// PWA share target / file handler — funnels into ONE entry point,
// sosIngestFiles(), which asks where the file goes and then hands off to
// handleFilesAdded() above.
//
// THAT HANDOFF IS THE RULE, NOT A DETAIL. handleFilesAdded -> sosUploadToCloud
// already performs the _sosCloudUrls.set()-before-persist dance that keeps a
// mid-upload Firestore sync from orphaning a storageUrl (see the cloud-URL
// memory notes near the top of this file). Any "simpler" ingest path that
// writes to IndexedDB or KV directly reintroduces that bug. Don't write one.

let _sosPendingIngest = null;                     // {files, resolve} while the picker is open
let _sosClassPickAbort = null;                    // set while the class sub-picker is up
const SOS_LAST_DEST_KEY = 'studyos_last_dest';    // {classId, modId}

// Run fn now if the app is unlocked, otherwise once App Lock opens the gate.
// applock.js drives body[data-sos-gate] = pending | locked | open. We watch the
// attribute rather than window.alIsLocked, which reports "a lock is CONFIGURED"
// — not "the app is currently blocked". A file arriving at a locked app (share
// target, file handler) must wait, not vanish.
function _sosWhenUnlocked(fn) {
  if (document.body.dataset.sosGate === 'open') { fn(); return; }
  const obs = new MutationObserver(function() {
    if (document.body.dataset.sosGate === 'open') { obs.disconnect(); fn(); }
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ['data-sos-gate'] });
}

// Every documents-type module across real classes AND the KSU pseudo-class.
// Reads classes/ksuData directly instead of going through findClassOrKsu,
// which builds a throwaway wrapper object on every call — the same walk that
// _sosEachFile does.
function _sosDocDestinations() {
  const out = [];
  for (const cls of classes) {
    for (const mod of (cls.modules || [])) {
      if (mod.type !== 'documents') continue;
      out.push({ classId: cls.id, className: cls.name || 'Class', color: cls.color || '#8D769A',
                 modId: mod.id, modName: mod.name || 'Module', count: (mod.files || []).length });
    }
  }
  for (const mod of (ksuData.modules || [])) {
    if (mod.type !== 'documents') continue;
    out.push({ classId: 'ksu', className: 'KSU', color: '#8D769A',
               modId: mod.id, modName: mod.name || 'Module', count: (mod.files || []).length });
  }
  return out;
}

function _sosReadLastDest() {
  try { return JSON.parse(localStorage.getItem(SOS_LAST_DEST_KEY) || 'null'); } catch (_) { return null; }
}

function _sosRenderDestList(dests) {
  const list = _sosEl('pick-dest-list');
  if (!list) return;
  list.innerHTML = '';
  if (!dests.length) {
    const empty = document.createElement('div');
    empty.className = 'pick-dest-empty';
    empty.textContent = 'No documents modules yet.';
    list.appendChild(empty);
    return;
  }
  const last = _sosReadLastDest();
  let focusRow = null;
  dests.forEach(function(d) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pick-dest-row';
    if (last && last.classId === d.classId && last.modId === d.modId) {
      row.classList.add('is-last');
      focusRow = row;
    }
    const main = document.createElement('div');
    main.className = 'pick-dest-main';
    const cn = document.createElement('div');
    cn.className = 'pick-dest-class';
    cn.style.color = d.color;
    cn.textContent = d.className;
    const mn = document.createElement('div');
    mn.className = 'pick-dest-mod';
    mn.textContent = d.modName;
    main.appendChild(cn); main.appendChild(mn);
    const ct = document.createElement('div');
    ct.className = 'pick-dest-count';
    ct.textContent = d.count + (d.count === 1 ? ' file' : ' files');
    row.appendChild(main); row.appendChild(ct);
    row.onclick = function() { _sosChooseDest(d.classId, d.modId); };
    list.appendChild(row);
  });
  // Focus the remembered row so Enter confirms it; else the first row.
  const target = focusRow || list.querySelector('.pick-dest-row');
  if (target) { try { target.focus(); target.scrollIntoView({ block: 'nearest' }); } catch (_) {} }
}

// Ask which module these files belong in. Resolves {classId,modId} or null.
function sosPickDestination(files) {
  return new Promise(function(resolve) {
    if (document.body.dataset.sosGate !== 'open') { resolve(null); return; }
    const dests = _sosDocDestinations();
    const total = files.reduce(function(a, f) { return a + (f.size || 0); }, 0);
    const summary = _sosEl('pick-dest-summary');
    if (summary) summary.textContent = files.length + ' file' + (files.length === 1 ? '' : 's') + ' · ' + _sosFmtBytes(total);
    _sosPendingIngest = { files: files, resolve: resolve };
    _sosRenderDestList(dests);
    _sosOpen('modal-pick-dest');
    // No documents module anywhere: skip the empty modal and offer to make one.
    if (!dests.length) _sosCreateDestModule();
  });
}

// Resolve exactly once. Both exits null _sosPendingIngest FIRST so a second
// call (Escape after a click, backdrop after Cancel) is a harmless no-op.
function _sosChooseDest(classId, modId) {
  const p = _sosPendingIngest;
  if (!p) return;
  _sosPendingIngest = null;
  try { localStorage.setItem(SOS_LAST_DEST_KEY, JSON.stringify({ classId: classId, modId: modId })); } catch (_) {}
  _sosClose('modal-pick-dest');
  p.resolve({ classId: classId, modId: modId });
}

function _sosCancelPick() {
  // A class sub-picker on top of the destination list must unwind too.
  if (_sosClassPickAbort) _sosClassPickAbort();
  const p = _sosPendingIngest;
  if (!p) return;
  _sosPendingIngest = null;
  _sosClose('modal-pick-dest');
  p.resolve(null);
}

// The generic backdrop handler installed at parse time (see the
// querySelectorAll('.sos-modal') loop further down) only strips the `open`
// class — it never resolves anything. Without this listener a backdrop click
// would close the picker and leave _sosPendingIngest dangling, hanging this
// ingest and silently swallowing every later one. Runs after the generic
// handler; resolution is idempotent, so the ordering does not matter.
document.addEventListener('DOMContentLoaded', function() {
  const ov = _sosEl('modal-pick-dest');
  if (ov) ov.addEventListener('click', function(e) { if (e.target === ov) _sosCancelPick(); });
});

// Deliberately not saveModule(): that one is wired to pendingModuleType,
// _ksuAddPending, currentClassId and closing modal-module-create. This just
// makes a documents module and selects it.
//
// Two steps rather than one form: window.uiForm renders every field as an
// <input> and its collect() reads only inputs, so a "select" field would draw
// as a text box and hand back whatever was typed. Rendering the class list
// ourselves sidesteps that entirely.
async function _sosCreateDestModule() {
  const opts = classes.map(function(c) { return { id: c.id, name: c.name || 'Class' }; });
  opts.push({ id: 'ksu', name: 'KSU' });   // KSU always exists as a destination

  let classId;
  if (opts.length === 1) {
    classId = opts[0].id;
  } else {
    classId = await _sosPickClassForNewModule(opts);
    if (!classId) return;
  }

  let name;
  try {
    name = await window.uiPrompt('Name for the new documents module', {
      title: 'New documents module', okLabel: 'Create', placeholder: 'e.g. Lecture Slides',
    });
  } catch (_) { return; }
  if (!name || !String(name).trim()) { _sosCancelPick(); return; }

  const cls = findClassOrKsu(classId);
  if (!cls) { _sosCancelPick(); return; }
  const mod = {
    id: Date.now().toString(),
    name: String(name).trim(),
    type: 'documents',
    icon: (typeof ICONS !== 'undefined' && ICONS.documents) || '📄',
    files: [], prompts: [], notes: [],
  };
  cls.modules.push(mod);
  persistForCls(cls);
  _sosRefreshModuleGrid(cls);
  // Still mid-pick? Re-render so the new module is listed, then take it.
  if (_sosPendingIngest) { _sosRenderDestList(_sosDocDestinations()); _sosChooseDest(cls.id, mod.id); }
  else showNotif('✅', 'Module created', mod.name + ' is ready for documents.');
}

// Repaints the picker list as a class chooser, then restores it. Resolves a
// classId or null. Reuses the picker rows so this needs no extra modal.
function _sosPickClassForNewModule(opts) {
  return new Promise(function(resolve) {
    const list = _sosEl('pick-dest-list');
    const summary = _sosEl('pick-dest-summary');
    const overlay = _sosEl('modal-pick-dest');
    if (!list || !overlay) { resolve(null); return; }
    const prevSummary = summary ? summary.textContent : '';
    const wasOpen = overlay.classList.contains('open');
    if (summary) summary.textContent = 'Which class does the new module belong to?';
    list.innerHTML = '';
    let settled = false;
    const finish = function(v) {
      if (settled) return;
      settled = true;
      _sosClassPickAbort = null;
      if (summary) summary.textContent = prevSummary;
      _sosRenderDestList(_sosDocDestinations());   // restore for whatever comes next
      if (!wasOpen) _sosClose('modal-pick-dest');
      resolve(v);
    };
    opts.forEach(function(o) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pick-dest-row';
      const main = document.createElement('div');
      main.className = 'pick-dest-main';
      const mn = document.createElement('div');
      mn.className = 'pick-dest-mod';
      mn.textContent = o.name;
      main.appendChild(mn);
      row.appendChild(main);
      row.onclick = function() { finish(o.id); };
      list.appendChild(row);
    });
    _sosOpen('modal-pick-dest');
    const first = list.querySelector('.pick-dest-row');
    if (first) { try { first.focus(); } catch (_) {} }
    _sosClassPickAbort = function() { finish(null); };
  });
}

// handleFilesAdded only refreshes doc-list-<modId>, which exists solely while
// that module's detail modal is open. For a background ingest the grid's file
// count would otherwise stay stale until the next navigation.
function _sosRefreshModuleGrid(cls) {
  try {
    if (cls && cls._ksu) renderKsuModules();
    else if (cls && cls.id === currentClassId) renderModules(cls);
  } catch (e) { console.warn('SOS grid refresh failed:', e); }
}

// THE ingest entry point. Every path lands here.
async function sosIngestFiles(files) {
  files = Array.from(files || []).filter(Boolean);
  if (!files.length) return;
  if (document.body.dataset.sosGate !== 'open') return;
  const dest = await sosPickDestination(files);
  if (!dest) return;
  // Re-validate: a Firestore sync can replace classes/ksuData wholesale while
  // the picker sits open, so the module chosen a moment ago may be gone.
  // handleFilesAdded would return silently; say so instead.
  const cls = findClassOrKsu(dest.classId);
  const mod = cls && (cls.modules || []).find(function(m) { return m.id === dest.modId; });
  if (!mod) {
    showNotif('⚠️', 'Destination gone', 'That module no longer exists — nothing was filed.');
    return;
  }
  handleFilesAdded(files, dest.classId, dest.modId);
  _sosRefreshModuleGrid(cls);
}

// ── Layer 1: drop anywhere in the window ──────────────────────────────────
let _sosDragDepth = 0;

// True only for an OS file drag. Also false while a Notes editor is open:
// notes-sync/docx-engine own drops in that region and their stopPropagation()
// keeps the window handler out, but suppressing the overlay too avoids
// flashing a prompt the user cannot act on.
function _sosDragHasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt || !dt.types) return false;
  if (Array.prototype.indexOf.call(dt.types, 'Files') === -1) return false;
  if (document.querySelector('#modal-module-detail.open #so-root')) return false;
  return true;
}

function _sosShowDropOverlay(on) {
  const ov = _sosEl('sos-drop-overlay');
  if (ov) ov.classList.toggle('open', !!on);
}

function _sosInstallDropTarget() {
  // Bound on window, not document: dragleave fires on document when the
  // pointer crosses any child boundary. The enter/leave DEPTH COUNTER is what
  // keeps the overlay from flickering on every element crossed.
  window.addEventListener('dragenter', function(e) {
    if (!_sosDragHasFiles(e)) return;
    e.preventDefault();
    if (++_sosDragDepth === 1) _sosShowDropOverlay(true);
  });
  window.addEventListener('dragover', function(e) {
    if (!_sosDragHasFiles(e)) return;
    // BOTH lines matter: without preventDefault here the browser never fires
    // `drop` at all, which is the classic silent failure for this feature.
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
  });
  window.addEventListener('dragleave', function(e) {
    if (!_sosDragHasFiles(e)) return;
    if (--_sosDragDepth <= 0) { _sosDragDepth = 0; _sosShowDropOverlay(false); }
  });
  window.addEventListener('drop', function(e) {
    if (!_sosDragHasFiles(e)) return;
    e.preventDefault();
    _sosDragDepth = 0;
    _sosShowDropOverlay(false);
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) sosIngestFiles(files);
  });
  // A drag that leaves the window entirely can swallow the final dragleave.
  window.addEventListener('blur', function() { _sosDragDepth = 0; _sosShowDropOverlay(false); });
}

// ── Layer 2: paste anywhere ───────────────────────────────────────────────
function _sosIsEditable(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '');
}

// Win+Shift+S puts a bitmap on the clipboard with NO filename — every capture
// arrives as "image.png". handleFilesAdded stores name verbatim and does not
// dedupe, so ten screenshots would become ten identical rows, synced forever.
// Only the paste path needs this; drags carry real filenames.
function _sosNameClipboardFile(f) {
  if (f.name && !/^image\.(png|jpe?g|webp)$/i.test(f.name)) return f;
  const d = new Date();
  const p = function(n) { return String(n).padStart(2, '0'); };
  const stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
                ' ' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
  const ext = (f.type && f.type.split('/')[1]) || 'png';
  try { return new File([f], 'Screenshot ' + stamp + '.' + ext, { type: f.type }); }
  catch (_) { return f; }   // File constructor unavailable — keep the original
}

function _sosOnPaste(e) {
  if (document.body.dataset.sosGate !== 'open') return;
  // Leave real text entry alone. Checked on both the event target and the
  // focused element, since paste can target <body> while focus sits elsewhere
  // (the Notes editor has its own paste handler in docx-engine.js).
  if (_sosIsEditable(e.target) || _sosIsEditable(document.activeElement)) return;
  const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
  if (!files.length) return;          // pasted text falls through untouched
  e.preventDefault();
  sosIngestFiles(files.map(_sosNameClipboardFile));
}

function _sosInstallIngest() {
  _sosInstallDropTarget();
  _sosInstallLaunchQueue();   // before anything async: launchQueue buffers only until a consumer exists
  _sosRegisterSw();
  _sosDrainShare();
  document.addEventListener('paste', _sosOnPaste);
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && (_sosPendingIngest || _sosClassPickAbort)) _sosCancelPick();
  });
}

// ── Stage B: files arriving from OUTSIDE the page ─────────────────────────
// Two OS-level entry points, both landing in sosIngestFiles() like every
// other path:
//   * file_handlers  — Explorer "Open with > StudyOS". Handled in-page by
//                      launchQueue; needs no service worker.
//   * share_target   — the Android / Edge-Windows share sheet. The OS POSTs
//                      multipart form data to /studyos/share, which only a
//                      service worker can intercept, so studyos-sw.js stashes
//                      the files and redirects here to drain them.

const SOS_STAGE_DB = 'sos_share_stage';
const SOS_STAGE_VER = 1;
const SOS_STAGE_ST = 'pending';
const SOS_STAGE_TTL = 24 * 60 * 60 * 1000;   // abandoned shares expire after a day

function _sosOpenStage() {
  return new Promise((resolve, reject) => {
    let r;
    try { r = indexedDB.open(SOS_STAGE_DB, SOS_STAGE_VER); }
    catch (e) { reject(e); return; }
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(SOS_STAGE_ST)) db.createObjectStore(SOS_STAGE_ST, { keyPath: 'id' });
    };
    r.onsuccess = e => resolve(e.target.result);
    r.onerror = () => reject(r.error);
  });
}

// Read every staged record and delete them in the SAME pass. Draining before
// ingesting is deliberate: if the picker is cancelled, or ingest throws, the
// share must not resurface on every future app open. Losing a share the user
// explicitly cancelled is correct; re-prompting forever is not.
async function _sosDrainStage() {
  let db;
  try { db = await _sosOpenStage(); } catch (_) { return []; }
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SOS_STAGE_ST, 'readwrite');
      const st = tx.objectStore(SOS_STAGE_ST);
      const q = st.getAll();
      let rows = [];
      q.onsuccess = () => {
        rows = q.result || [];
        st.clear();
      };
      tx.oncomplete = () => resolve(rows);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (_) {
    return [];
  } finally {
    try { db.close(); } catch (_) {}
  }
}

// Turn staged records back into Files and hand them to the normal picker.
// Called unconditionally at startup, not only when ?share=1 is present: a
// share that landed while the app was closed, or whose redirect was lost,
// would otherwise sit stranded in IndexedDB forever.
async function _sosDrainShare() {
  let rows;
  try { rows = await _sosDrainStage(); } catch (_) { return; }
  if (!rows || !rows.length) return;

  const now = Date.now();
  const fresh = rows.filter(r => r && r.blob && (!r.ts || now - r.ts < SOS_STAGE_TTL));

  // Strip ?share=1 so a refresh doesn't look like a brand-new share.
  try {
    if (/[?&]share=1/.test(location.search)) {
      history.replaceState({}, '', location.pathname + location.hash);
    }
  } catch (_) {}

  if (!fresh.length) return;
  const files = fresh.map(r => {
    try { return new File([r.blob], r.name || 'shared', { type: r.type || 'application/octet-stream' }); }
    catch (_) { return null; }
  }).filter(Boolean);
  if (files.length) _sosWhenUnlocked(() => sosIngestFiles(files));
}

// Scope is /studyos/ — see the header of studyos-sw.js for why this must not
// be hoisted to the site root alongside firebase-messaging-sw.js.
function _sosRegisterSw() {
  if (!('serviceWorker' in navigator)) return;
  // Mirrors the guard push.js uses: a SW needs HTTPS or localhost, and file://
  // throws outright.
  if (!window.isSecureContext) return;
  navigator.serviceWorker.register('./studyos-sw.js')
    .catch(e => console.info('[StudyOS] share-target SW not registered:', e && e.message));
}

// file_handlers: Explorer "Open with > StudyOS". No service worker involved.
// Registered as early as possible — launchQueue buffers a launch only until a
// consumer is set, so a late registration drops the very launch that opened
// the window.
function _sosInstallLaunchQueue() {
  if (!('launchQueue' in window) || !window.launchQueue.setConsumer) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params || !params.files || !params.files.length) return;
    const files = [];
    for (const h of params.files) {
      // These are FileSystemFileHandles, not Files.
      try { files.push(await h.getFile()); } catch (_) {}
    }
    if (files.length) _sosWhenUnlocked(() => sosIngestFiles(files));
  });
}


function removeFile(classId, modId, idx) {
  const cls = findClassOrKsu(classId);
  if (!cls) return;
  const mod = cls.modules.find(m => m.id === modId);
  if (!mod) return;
  const f = mod.files[idx];
  if (f && f.fileId) SosFileStore.delete(f.fileId).catch(() => {});
  if (f && (f.storagePath || f.fileId)) SosCloud.remove(f.storagePath || f.fileId);
  if (f && f.fileId) _sosCloudUrls.delete(f.fileId);
  mod.files.splice(idx, 1);
  persistForCls(cls);
  const listEl = _sosEl('doc-list-' + modId);
  if (listEl) refreshDocList(listEl, cls, mod);
  _sosUpdateCloudBadge();
  // KV deletes are eventually consistent; give it a moment before re-reading.
  setTimeout(_sosRefreshStorage, 1200);
}

// File-type badge in the documents list. Each type gets a drawn icon rather
// than an emoji, so the column reads as one set at any size and takes the
// list's own colour instead of the platform's emoji font.
function fileEmoji(name) {
  const ext = name.split('.').pop().toLowerCase();
  const PAGE = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>';
  const map = {
    pdf:   PAGE + '<path d="M8 13h2.2a1.4 1.4 0 0 1 0 2.8H8V13v5"/><path d="M14 18v-5h2.4"/><path d="M14 15.5h2"/>',
    doc:   PAGE + '<path d="M8 13h8"/><path d="M8 17h5"/>',
    docx:  PAGE + '<path d="M8 13h8"/><path d="M8 17h5"/>',
    ppt:   PAGE + '<path d="M8 18v-5h2.3a1.6 1.6 0 0 1 0 3.2H8"/>',
    pptx:  PAGE + '<path d="M8 18v-5h2.3a1.6 1.6 0 0 1 0 3.2H8"/>',
    xls:   PAGE + '<path d="m8.5 13 5 5"/><path d="m13.5 13-5 5"/>',
    xlsx:  PAGE + '<path d="m8.5 13 5 5"/><path d="m13.5 13-5 5"/>',
    png:   '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
    mp4:   '<rect x="2.5" y="5" width="14" height="14" rx="2"/><path d="m16.5 14 5 3V7l-5 3Z"/>',
    mp3:   '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    zip:   '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M11 4v3"/><path d="M13 7v3"/><path d="M11 10v3"/><rect x="10.5" y="13" width="3" height="4" rx="1"/>',
    txt:   PAGE + '<path d="M8 13h8"/><path d="M8 17h8"/>',
    md:    PAGE + '<path d="M8 13h8"/><path d="M8 17h8"/>'
  };
  map.jpg = map.jpeg = map.gif = map.png;
  const body = map[ext] || PAGE;
  return '<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="none" ' +
         'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
         'stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

// ---- PROMPTS ----
function renderPromptsModule(body, cls, mod) {
  const editOn = !!moduleEditMode[mod.id];

  const listEl = document.createElement('div');
  listEl.className = 'prompt-list';
  listEl.id = 'prompt-list-' + mod.id;
  refreshPromptList(listEl, cls, mod);
  body.appendChild(listEl);

  if (editOn) {
    const addRow = document.createElement('div');
    addRow.className = 'add-prompt-row';
    addRow.innerHTML = `
      <textarea id="new-prompt-${mod.id}" placeholder="Type a new prompt..."></textarea>
      <button class="btn primary" style="white-space:nowrap;align-self:flex-end" onclick="addPrompt('${cls.id}','${mod.id}')">+ Add</button>
    `;
    body.appendChild(addRow);
  }
}

function refreshPromptList(listEl, cls, mod) {
  const editOn = !!moduleEditMode[mod.id];
  listEl.innerHTML = '';
  if (!mod.prompts || mod.prompts.length === 0) {
    listEl.innerHTML = `<div style="font-size:12px;color:var(--text3);font-family:var(--mono);padding:4px 0 8px">${editOn ? 'No prompts yet. Add one below.' : 'No prompts saved.'}</div>`;
    return;
  }
  mod.prompts.forEach(p => {
    const entry = document.createElement('div');
    entry.className = 'prompt-entry';
    entry.dataset.id = p.id;
    _promptTextStore[p.id] = p.text;
    const safeText = escHtml(p.text);
    entry.innerHTML = `
      ${editOn ? `<div class="th-drag-handle row-drag-handle prompt-drag-handle" title="Drag to reorder">⠿</div>` : ''}
      <div class="prompt-entry-text">${safeText}</div>
      <div class="prompt-entry-actions">
        ${editOn ? `<button class="prompt-del-btn" onclick="removePrompt('${cls.id}','${mod.id}','${p.id}')">${SOI.x}<span>Remove</span></button>` : ''}
        <button class="prompt-copy-btn" id="cpbtn-${p.id}" onclick="copyPromptById('${p.id}')">Copy</button>
      </div>
    `;
    listEl.appendChild(entry);
  });

  if (editOn) {
    thDragList(listEl, () => mod.prompts, (arr) => { mod.prompts = arr; }, () => { persistForCls(cls); refreshPromptList(listEl, cls, mod); }, cls.color || '#8D769A');
  }
}

function addPrompt(classId, modId) {
  const ta = _sosEl('new-prompt-' + modId);
  const text = ta.value.trim();
  if (!text) return;
  const cls = findClassOrKsu(classId);
  if (!cls) return;
  const mod = cls.modules.find(m => m.id === modId);
  if (!mod) return;
  mod.prompts.push({ id: Date.now().toString(), text });
  ta.value = '';
  persistForCls(cls);
  const listEl = _sosEl('prompt-list-' + modId);
  if (listEl) refreshPromptList(listEl, cls, mod);
}

function removePrompt(classId, modId, promptId) {
  const cls = findClassOrKsu(classId);
  if (!cls) return;
  const mod = cls.modules.find(m => m.id === modId);
  if (!mod) return;
  mod.prompts = mod.prompts.filter(p => p.id !== promptId);
  persistForCls(cls);
  const listEl = _sosEl('prompt-list-' + modId);
  if (listEl) refreshPromptList(listEl, cls, mod);
}

const _promptTextStore = {};

function copyPromptById(promptId) {
  const textToCopy = _promptTextStore[promptId] || '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(textToCopy).catch(() => fallbackCopy(textToCopy));
  } else {
    fallbackCopy(textToCopy);
  }
  const btn = _sosEl('cpbtn-' + promptId);
  if (btn) {
    const orig = btn.textContent;
    btn.innerHTML = SOI.check + ' Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1800);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

// ---- NOTES MODULE (multi-note) ----
function renderNotesModule(body, cls, mod) {
  const editOn = !!moduleEditMode[mod.id];

  // migrate old single noteBody
  if (!mod.notes) {
    mod.notes = mod.noteBody ? [{ id: Date.now().toString(), title: 'Note 1', body: mod.noteBody, updated: Date.now() }] : [];
    delete mod.noteBody;
    persist();
  }

  const layout = document.createElement('div');
  layout.style.cssText = 'display:grid;grid-template-columns:180px 1fr;gap:12px;height:320px';

  const sidebar = document.createElement('div');
  sidebar.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:6px;display:flex;flex-direction:column;overflow:hidden';
  sidebar.innerHTML = `
    <div style="padding:8px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text3);font-family:var(--mono)">Notes</span>
      ${editOn ? `<button class="btn primary" style="padding:2px 8px;font-size:10px" onclick="addModuleNote('${cls.id}','${mod.id}')">+ New</button>` : ''}
    </div>
    <div id="modnote-list-${mod.id}" style="flex:1;overflow-y:auto"></div>
  `;

  const editor = document.createElement('div');
  editor.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:6px;display:flex;flex-direction:column;overflow:hidden';
  editor.innerHTML = `
    <div id="modnote-empty-${mod.id}" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:13px;font-family:var(--mono)">Select a note</div>
    <div id="modnote-editor-${mod.id}" style="display:none;flex-direction:column;height:100%">
      <div style="padding:8px 10px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center">
        <input id="modnote-title-${mod.id}" style="flex:1;background:transparent;border:none;font-size:13px;font-weight:700;color:var(--text);font-family:var(--sans);outline:none;pointer-events:${editOn ? 'auto' : 'none'}" placeholder="Note title" ${editOn ? '' : 'readonly'}>
        <button class="btn" style="padding:3px 8px;font-size:10px" title="Fullscreen" aria-label="Fullscreen" onclick="fullscreenModuleNote('${cls.id}','${mod.id}')">${SOI.expand}</button>
        <button class="btn" style="padding:3px 8px;font-size:10px" title="Print / Save as PDF" aria-label="Print" onclick="printModuleNote('${mod.id}')">${SOI.printer}</button>
        ${editOn ? `<button class="btn" style="padding:3px 8px;font-size:10px;color:#ff6b6b" onclick="deleteModuleNote('${cls.id}','${mod.id}')">Delete</button>` : ''}
      </div>
      <textarea id="modnote-body-${mod.id}" style="flex:1;background:transparent;border:none;padding:12px;font-family:var(--mono);font-size:12px;color:var(--text);resize:none;line-height:1.7;outline:none;${editOn ? '' : 'pointer-events:none'}" placeholder="${editOn ? 'Write here...' : ''}" ${editOn ? '' : 'readonly'}></textarea>
      <div id="modnote-status-${mod.id}" style="padding:4px 10px;font-size:10px;color:var(--text3);font-family:var(--mono);border-top:1px solid var(--border)">${editOn ? 'Auto-saved' : 'Read-only — switch to Edit to modify'}</div>
    </div>
  `;

  layout.appendChild(sidebar);
  layout.appendChild(editor);
  body.appendChild(layout);

  refreshModuleNoteList(cls, mod);
  if (mod.notes.length > 0) openModuleNote(cls, mod, mod.notes[0].id);
}

let currentModuleNoteId = {};

function refreshModuleNoteList(cls, mod) {
  const listEl = _sosEl('modnote-list-' + mod.id);
  if (!listEl) return;
  listEl.innerHTML = '';
  if (mod.notes.length === 0) {
    listEl.innerHTML = '<div style="padding:12px 10px;font-size:11px;color:var(--text3);font-family:var(--mono)">No notes yet.</div>';
    return;
  }
  [...mod.notes].sort((a,b) => b.updated - a.updated).forEach(n => {
    const item = document.createElement('div');
    const isActive = currentModuleNoteId[mod.id] === n.id;
    item.style.cssText = `padding:9px 10px;cursor:pointer;border-bottom:1px solid var(--border);border-left:3px solid ${isActive ? 'var(--accent)' : 'transparent'};background:${isActive ? 'var(--bg4)' : 'transparent'};transition:0.15s`;
    item.innerHTML = `
      <div style="font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${n.title || 'Untitled'}</div>
      <div style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-top:2px">${new Date(n.updated).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>
    `;
    item.onmouseover = () => { if (!isActive) item.style.background = 'var(--bg3)'; };
    item.onmouseout = () => { if (!isActive) item.style.background = 'transparent'; };
    item.onclick = () => openModuleNote(cls, mod, n.id);
    listEl.appendChild(item);
  });
}

function openModuleNote(cls, mod, noteId) {
  currentModuleNoteId[mod.id] = noteId;
  const note = mod.notes.find(n => n.id === noteId);
  if (!note) return;
  const editOn = !!moduleEditMode[mod.id];

  const emptyEl = _sosEl('modnote-empty-' + mod.id);
  const editorEl = _sosEl('modnote-editor-' + mod.id);
  if (emptyEl) emptyEl.style.display = 'none';
  if (editorEl) editorEl.style.display = 'flex';

  const titleEl = _sosEl('modnote-title-' + mod.id);
  const bodyEl = _sosEl('modnote-body-' + mod.id);
  const statusEl = _sosEl('modnote-status-' + mod.id);
  if (titleEl) titleEl.value = note.title;
  if (bodyEl) bodyEl.value = note.body;

  if (editOn) {
    const save = () => {
      const n = mod.notes.find(x => x.id === currentModuleNoteId[mod.id]);
      if (!n) return;
      if (titleEl) n.title = titleEl.value;
      if (bodyEl) n.body = bodyEl.value;
      n.updated = Date.now();
      persistForCls(cls);
      if (statusEl) { statusEl.innerHTML = 'Saved ' + SOI.check; clearTimeout(titleEl._st); titleEl._st = setTimeout(() => { statusEl.textContent = 'Auto-saved'; }, 1500); }
      refreshModuleNoteList(cls, mod);
    };
    if (titleEl) titleEl.oninput = save;
    if (bodyEl) bodyEl.oninput = save;
  }

  refreshModuleNoteList(cls, mod);
}

function addModuleNote(classId, modId) {
  const cls = findClassOrKsu(classId);
  if (!cls) return;
  const mod = cls.modules.find(m => m.id === modId);
  if (!mod) return;
  const n = { id: Date.now().toString(), title: '', body: '', updated: Date.now() };
  mod.notes.unshift(n);
  persistForCls(cls);
  refreshModuleNoteList(cls, mod);
  openModuleNote(cls, mod, n.id);
  setTimeout(() => { const t = _sosEl('modnote-title-' + modId); if (t) t.focus(); }, 50);
}

async function deleteModuleNote(classId, modId) {
  const cls = findClassOrKsu(classId);
  if (!cls) return;
  const mod = cls.modules.find(m => m.id === modId);
  if (!mod) return;
  const noteId = currentModuleNoteId[modId];
  const note = mod.notes.find(n => n.id === noteId);
  if (!(await window.uiConfirm('Delete "' + (note?.title || 'Untitled') + '"?', {danger:true, okLabel:'Delete'}))) return;
  mod.notes = mod.notes.filter(n => n.id !== noteId);
  delete currentModuleNoteId[modId];
  persistForCls(cls);
  refreshModuleNoteList(cls, mod);
  // clear editor
  const emptyEl = _sosEl('modnote-empty-' + modId);
  const editorEl = _sosEl('modnote-editor-' + modId);
  if (emptyEl) emptyEl.style.display = 'flex';
  if (editorEl) editorEl.style.display = 'none';
  // open first remaining note
  if (mod.notes.length > 0) openModuleNote(cls, mod, mod.notes[0].id);
}

function fullscreenModuleNote(classId, modId) {
  const titleEl = _sosEl('modnote-title-' + modId);
  const bodyEl  = _sosEl('modnote-body-'  + modId);
  if (!titleEl || !bodyEl) return;

  const cls = findClassOrKsu(classId);
  const mod = cls && cls.modules.find(m => m.id === modId);
  const editOn = !!moduleEditMode[modId];

  const overlay = document.createElement('div');
  overlay.className = 'note-fullscreen-overlay';
  overlay.innerHTML = `
    <div class="note-fullscreen-header">
      <input class="note-fullscreen-title" id="fs-title-${modId}" value="${titleEl.value.replace(/"/g,'&quot;')}" ${editOn ? '' : 'readonly'} placeholder="Untitled">
      <button class="btn" style="padding:5px 12px;font-size:12px" title="Print / Save as PDF" onclick="printModuleNoteFs('${modId}')">${SOI.printer}<span>Print</span></button>
      <button class="btn" style="padding:5px 12px;font-size:12px" onclick="_sosEl('fs-overlay-${modId}').remove()">${SOI.x}<span>Close</span></button>
    </div>
    <textarea class="note-fullscreen-body" id="fs-body-${modId}" ${editOn ? '' : 'readonly'} placeholder="${editOn ? 'Write here...' : ''}">${bodyEl.value}</textarea>
  `;
  overlay.id = 'fs-overlay-' + modId;
  var sosRoot = document.getElementById('study-root');
  (sosRoot || document.body).appendChild(overlay);

  if (editOn && mod) {
    const fsTitleEl = _sosEl('fs-title-' + modId);
    const fsBodyEl  = _sosEl('fs-body-'  + modId);
    const sync = () => {
      const n = mod.notes.find(x => x.id === currentModuleNoteId[modId]);
      if (!n) return;
      n.title = fsTitleEl.value; n.body = fsBodyEl.value; n.updated = Date.now();
      titleEl.value = n.title; bodyEl.value = n.body;
      persistForCls(cls); refreshModuleNoteList(cls, mod);
    };
    fsTitleEl.addEventListener('input', sync);
    fsBodyEl.addEventListener('input', sync);
  }
}

function printModuleNote(modId) {
  const titleEl = _sosEl('modnote-title-' + modId);
  const bodyEl  = _sosEl('modnote-body-'  + modId);
  if (!titleEl || !bodyEl) return;
  _doPrint(titleEl.value, bodyEl.value);
}

function printModuleNoteFs(modId) {
  const t = _sosEl('fs-title-' + modId);
  const b = _sosEl('fs-body-'  + modId);
  if (!t || !b) return;
  _doPrint(t.value, b.value);
}

function _doPrint(title, body) {
  const win = window.open('', '_blank');
  if (!win) return;
  const escaped = body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  win.document.write(`<!DOCTYPE html><html><head><title>${title || 'Note'}</title>
<style>
  body{font-family:'Georgia',serif;max-width:760px;margin:48px auto;color:#111;line-height:1.8;font-size:15px}
  h1{font-size:24px;font-weight:700;margin-bottom:28px;border-bottom:2px solid #ccc;padding-bottom:12px}
  pre{font-family:'Courier New',monospace;white-space:pre-wrap;word-break:break-word;font-size:14px}
  @media print{body{margin:24px}}
</style></head><body>
<h1>${title || 'Untitled'}</h1><pre>${escaped}</pre>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
  win.document.close();
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ===== AI PROMPTS =====

// ===== NOTES =====
function persistNotes() { localStorage.setItem('studyos_notes_v2', JSON.stringify(notesList)); _sosFirebaseSave(); }

function renderNotesList() {
  const list = _sosEl('notes-list');
  list.innerHTML = '';
  if (notesList.length === 0) {
    list.innerHTML = '<div style="padding:20px 14px;font-size:12px;color:var(--text3);font-family:var(--mono)">No notes yet.</div>';
    return;
  }
  [...notesList].sort((a,b) => b.updated - a.updated).forEach(n => {
    const item = document.createElement('div');
    item.className = 'note-list-item' + (n.id === currentNoteId ? ' active' : '');
    const preview = n.body.replace(/\n/g,' ').slice(0, 60) || '—';
    const d = new Date(n.updated);
    const dateStr = d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
    item.innerHTML = `
      <div class="note-list-title">${n.title || 'Untitled'}</div>
      <div class="note-list-preview">${preview}</div>
      <div class="note-list-date">${dateStr}</div>
    `;
    item.onclick = () => openNote(n.id);
    list.appendChild(item);
  });
}

function openNote(id) {
  currentNoteId = id;
  const n = notesList.find(x => x.id === id);
  if (!n) return;
  _sosEl('notes-empty-editor').style.display = 'none';
  const active = _sosEl('notes-editor-active');
  active.style.display = 'flex';
  _sosEl('note-title-input').value = n.title;
  _sosEl('notes-area').value = n.body;
  renderNotesList();

  // wire up autosave
  _sosEl('note-title-input').oninput = e => {
    const note = notesList.find(x => x.id === currentNoteId);
    if (note) { note.title = e.target.value; note.updated = Date.now(); persistNotes(); renderNotesList(); }
  };
  _sosEl('notes-area').oninput = e => {
    const note = notesList.find(x => x.id === currentNoteId);
    if (note) { note.body = e.target.value; note.updated = Date.now(); persistNotes(); renderNotesList(); }
  };
}

function createNote() {
  const n = { id: Date.now().toString(), title: '', body: '', updated: Date.now() };
  notesList.unshift(n);
  persistNotes();
  renderNotesList();
  openNote(n.id);
  setTimeout(() => _sosEl('note-title-input').focus(), 50);
}

async function deleteCurrentNote() {
  if (!currentNoteId) return;
  const n = notesList.find(x => x.id === currentNoteId);
  if (!(await window.uiConfirm('Delete "' + (n?.title || 'Untitled') + '"?', {danger:true, okLabel:'Delete'}))) return;
  notesList = notesList.filter(x => x.id !== currentNoteId);
  currentNoteId = null;
  persistNotes();
  renderNotesList();
  _sosEl('notes-empty-editor').style.display = '';
  _sosEl('notes-editor-active').style.display = 'none';
}

// ===== EVENTS =====
function openAddEvent(ev, prefillDate) {
  populateEventClassSelect();
  if (ev) {
    editingEventId = ev.id;
    document.querySelector('#modal-add-event .modal-title').textContent = 'Edit Event';
    _sosEl('inp-event-name').value = ev.name;
    _sosEl('inp-event-date').value = ev.date;
    _sosEl('inp-event-time').value = ev.time || '';
    _sosEl('inp-event-class').value = ev.classId || '';
    _sosEl('inp-event-type').value = ev.type || 'other';
    (()=>{ const nd=_sosEl('inp-event-notif-date'), nt=_sosEl('inp-event-notif-time'); if(ev.notif&&ev.notif!=='none'){ const dt=new Date(ev.notif); if(!isNaN(dt.getTime())){ const pad=n=>String(n).padStart(2,'0'); if(nd)nd.value=dt.getFullYear()+'-'+pad(dt.getMonth()+1)+'-'+pad(dt.getDate()); if(nt)nt.value=pad(dt.getHours())+':'+pad(dt.getMinutes()); } } else { if(nd)nd.value=''; if(nt)nt.value=''; } })();
    _sosEl('inp-event-weight').value = ev.weight || '';
    _sosEl('btn-delete-event').style.display = '';
    _sosResetRepeatUI(ev);
  } else {
    editingEventId = null;
    document.querySelector('#modal-add-event .modal-title').textContent = 'Add Event';
    if (prefillDate) { _sosEl('inp-event-date').value = prefillDate; } else { setTodayDate(); }
    _sosEl('inp-event-name').value = '';
    _sosEl('inp-event-time').value = '';
    _sosEl('inp-event-class').value = '';
    _sosEl('inp-event-type').value = 'exam';
    { const _nd=_sosEl('inp-event-notif-date'); if(_nd)_nd.value=''; const _nt=_sosEl('inp-event-notif-time'); if(_nt)_nt.value=''; }
    _sosEl('inp-event-weight').value = '';
    _sosEl('btn-delete-event').style.display = 'none';
    _sosResetRepeatUI(null);
  }
  _sosOpen('modal-add-event');
}

function populateEventClassSelect() {
  const sel = _sosEl('inp-event-class');
  sel.innerHTML = '<option value="">— None —</option>';
  classes.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  });
}

function saveEvent() {
  const name = _sosEl('inp-event-name').value.trim();
  const date = _sosEl('inp-event-date').value;
  if (!name || !date) { alert('Name and date required.'); return; }
  const repeatEndDate = (_sosEl('inp-event-repeat-end') || {}).value || '';
  const baseData = {
    name, date,
    time: _sosEl('inp-event-time').value,
    classId: _sosEl('inp-event-class').value,
    type: _sosEl('inp-event-type').value,
    notif: (()=>{ const d=(_sosEl('inp-event-notif-date')||{}).value||''; const t=(_sosEl('inp-event-notif-time')||{}).value||''; return (d&&t)?new Date(d+'T'+t+':00').toISOString():'none'; })(),
    weight: parseFloat(_sosEl('inp-event-weight').value) || 0,
    repeat: _sosRepeat.mode,
    repeatDays: _sosRepeat.mode === 'weekly' ? [..._sosRepeat.days] : [],
    repeatEndDate: _sosRepeat.mode !== 'none' ? repeatEndDate : '',
  };
  const _sosCls = classes.find(c => c.id === baseData.classId);
  const _sosClsName = _sosCls ? _sosCls.name : '';
  const _sosClsColor = _sosCls ? _sosCls.color : '';
  const toVedaKey = d => { const [y,m,dd2] = d.split('-').map(Number); return `${y}-${String(m).padStart(2,'0')}-${String(dd2).padStart(2,'0')}`; };

  let oldClassId = null;

  if (editingEventId) {
    // ── EDIT ────────────────────────────────────────────────────────────────
    const editingEv = events.find(e => e.id === editingEventId);
    if (!editingEv) { editingEventId = null; return; }
    oldClassId = editingEv.classId || null;
    const wasRepeating = !!editingEv.repeatId;
    const nowCancelled = _sosRepeat.mode === 'none';

    if (wasRepeating && nowCancelled) {
      // Remove all future occurrences of this repeatId from cutoff date onward
      const rid = editingEv.repeatId;
      const cutoff = new Date(editingEv.date + 'T12:00:00');
      events = events.filter(e => {
        if (e.repeatId !== rid) return true;
        return new Date(e.date + 'T12:00:00') < cutoff;
      });
      // Add back a single non-repeating event at the original date
      const singleId = uid();
      events.push({ id: singleId, ...baseData, repeat: 'none', repeatDays: [], repeatEndDate: '', repeatId: undefined });
      if (window._vedaRemoveTask) window._vedaRemoveTask('__repeatId__' + rid);
      if (window._vedaAddTask) {
        window._vedaAddTask(toVedaKey(editingEv.date), {
          id: 'sos_' + singleId, _sosId: singleId, type: 'event',
          title: baseData.name, time: baseData.time || '', category: 'study', done: false,
          _sosClassName: _sosClsName, _sosClassColor: _sosClsColor,
        });
      }
    } else if (wasRepeating) {
      // Update all occurrences of this repeatId
      const rid = editingEv.repeatId;
      events = events.filter(e => e.repeatId !== rid);
      const dates = _sosRepeatDates(date);
      dates.forEach(d => {
        events.push({ id: uid(), ...baseData, repeatId: rid, date: d });
      });
      if (window._vedaRemoveTask) window._vedaRemoveTask('__repeatId__' + rid);
      if (window._vedaAddTask) {
        dates.forEach(d => {
          const itemId = uid();
          window._vedaAddTask(toVedaKey(d), {
            id: 'sos_' + itemId, _sosId: itemId, _sosRepeatId: rid,
            type: 'event', title: baseData.name, time: baseData.time || '',
            category: 'study', done: false,
            _sosClassName: _sosClsName, _sosClassColor: _sosClsColor,
          });
        });
      }
    } else {
      // Single event edit (not repeating, or newly made repeating)
      const idx = events.findIndex(e => e.id === editingEventId);
      if (idx !== -1) {
        const oldDate = events[idx].date;
        if (_sosRepeat.mode !== 'none') {
          // Was single, now repeating — remove original and expand
          events.splice(idx, 1);
          const rid = uid();
          const dates = _sosRepeatDates(date);
          dates.forEach(d => events.push({ id: uid(), ...baseData, repeatId: rid, date: d }));
          if (window._vedaRemoveTask) window._vedaRemoveTask(editingEventId);
          if (window._vedaAddTask) {
            dates.forEach(d => {
              const itemId = uid();
              window._vedaAddTask(toVedaKey(d), {
                id: 'sos_' + itemId, _sosId: itemId, _sosRepeatId: rid,
                type: 'event', title: baseData.name, time: baseData.time || '',
                category: 'study', done: false,
                _sosClassName: _sosClsName, _sosClassColor: _sosClsColor,
              });
            });
          }
        } else {
          events[idx] = { ...events[idx], ...baseData };
          if (window._vedaUpdateTask) {
            window._vedaUpdateTask(toVedaKey(oldDate), toVedaKey(date), {
              id: 'sos_' + editingEventId, _sosId: editingEventId,
              type: 'event', title: baseData.name, time: baseData.time || '',
              category: 'study', done: false,
              _sosClassName: _sosClsName, _sosClassColor: _sosClsColor,
            });
          }
        }
      }
    }
    showNotif(SOI.calendar, 'Event Updated', baseData.name + ' on ' + formatDate(date));

  } else {
    // ── ADD ─────────────────────────────────────────────────────────────────
    if (_sosRepeat.mode !== 'none') {
      const rid = uid();
      const dates = _sosRepeatDates(date);
      dates.forEach(d => events.push({ id: uid(), ...baseData, repeatId: rid, date: d }));
      if (window._vedaAddTask) {
        dates.forEach(d => {
          const itemId = uid();
          window._vedaAddTask(toVedaKey(d), {
            id: 'sos_' + itemId, _sosId: itemId, _sosRepeatId: rid,
            type: 'event', title: baseData.name, time: baseData.time || '',
            category: 'study', done: false,
            _sosClassName: _sosClsName, _sosClassColor: _sosClsColor,
          });
        });
      }
      showNotif(SOI.calendar, 'Repeating Event Added', baseData.name + ' · ' + dates.length + ' occurrences');
    } else {
      const newId = Date.now().toString();
      events.push({ id: newId, ...baseData });
      if (window._vedaAddTask) {
        window._vedaAddTask(toVedaKey(date), {
          id: 'sos_' + newId, _sosId: newId,
          type: 'event', title: baseData.name, time: baseData.time || '',
          category: 'study', done: false,
          _sosClassName: _sosClsName, _sosClassColor: _sosClsColor,
        });
      }
      showNotif(SOI.calendar, 'Event Added', baseData.name + ' on ' + formatDate(date));
    }
  }

  editingEventId = null;
  persistEvents();
  _sosClose('modal-add-event');
  renderCalendar();
  renderUpcoming();
  updateStats();
  scheduleNotifications();
  const affectedIds = new Set([oldClassId, baseData.classId, currentClassId].filter(Boolean));
  affectedIds.forEach(id => { const cls = classes.find(c => c.id === id); if (cls) renderClassEvents(cls); });
  if (currentClassId) { const cls = classes.find(c => c.id === currentClassId); if (cls) renderClassEvents(cls); }
}

async function deleteEditingEvent() {
  if (!editingEventId) return;
  const deletedEvent = events.find(e => e.id === editingEventId);
  if (!deletedEvent) { editingEventId = null; return; }
  const deletedClassId = deletedEvent.classId || null;

  if (deletedEvent.repeatId) {
    // Ask: delete this only, or all future?
    const choice = await window.uiConfirm('This is a repeating event. Delete all future occurrences, or only this one?', {title:'Delete repeating event', okLabel:'All future', cancelLabel:'This only'});
    if (choice) {
      // Delete this + all future
      const rid = deletedEvent.repeatId;
      const cutoff = new Date(deletedEvent.date + 'T12:00:00');
      if (window.thCancelNotif) {
        events.filter(e => e.repeatId === rid && new Date(e.date+'T12:00:00') >= cutoff)
              .forEach(e => { window.thCancelNotif('sos_ev_' + e.id, null); });
      }
      events = events.filter(e => {
        if (e.repeatId !== rid) return true;
        return new Date(e.date + 'T12:00:00') < cutoff;
      });
      if (window._vedaRemoveTask) window._vedaRemoveTask('__repeatId__' + rid);
    } else {
      // Delete this only
      if (window.thCancelNotif) window.thCancelNotif('sos_ev_' + editingEventId, null);
      events = events.filter(e => e.id !== editingEventId);
      if (window._vedaRemoveTask) window._vedaRemoveTask(editingEventId);
    }
  } else {
    if (window.thCancelNotif) window.thCancelNotif('sos_ev_' + editingEventId, null);
    events = events.filter(e => e.id !== editingEventId);
    // ── One-way sync: delete → Veda weekly tasks ────────────────────────────
    if (window._vedaRemoveTask) window._vedaRemoveTask(editingEventId);
  }

  editingEventId = null;
  persistEvents();
  _sosClose('modal-add-event');
  renderCalendar();
  renderUpcoming();
  updateStats();
  showNotif(SOI.trash, 'Event Deleted', 'Event removed.');
  const affectedIds = new Set([deletedClassId, currentClassId].filter(Boolean));
  affectedIds.forEach(id => {
    const cls = classes.find(c => c.id === id);
    if (cls) renderClassEvents(cls);
  });
  if (currentClassId) {
    const cls = classes.find(c => c.id === currentClassId);
    if (cls) renderClassEvents(cls);
  }
}

function formatDate(d) {
  const dt = new Date(d + 'T12:00:00');
  return dt.toLocaleDateString('en-US', { month:'short', day:'numeric' });
}

// ===== CALENDAR =====
function renderCalendar() {
  const cells = _sosEl('cal-cells');
  const label = _sosEl('cal-month-label');
  const year = calDate.getFullYear();
  const month = calDate.getMonth();
  label.textContent = calDate.toLocaleDateString('en-US', { month:'long', year:'numeric' });

  const today = new Date();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();

  cells.innerHTML = '';
  let totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;
  for (let i = 0; i < totalCells; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    let day, m = month, y = year, otherMonth = false;
    if (i < firstDay) {
      day = daysInPrev - firstDay + i + 1;
      m = month - 1; if (m < 0) { m = 11; y--; }
      otherMonth = true;
    } else if (i >= firstDay + daysInMonth) {
      day = i - firstDay - daysInMonth + 1;
      m = month + 1; if (m > 11) { m = 0; y++; }
      otherMonth = true;
    } else {
      day = i - firstDay + 1;
    }
    if (otherMonth) cell.classList.add('other-month');
    const isToday = day === today.getDate() && m === today.getMonth() && y === today.getFullYear();
    if (isToday) cell.classList.add('today');
    const dateStr = y + '-' + String(m+1).padStart(2,'0') + '-' + String(day).padStart(2,'0');
    cell.innerHTML = `<div class="day-num">${day}</div>`;
    const dayEvents = events.filter(e => e.date === dateStr);
    dayEvents.slice(0, 3).forEach(ev => {
      const dot = document.createElement('div');
      dot.className = 'cal-event';
      const cls = classes.find(c => c.id === ev.classId);
      const color = cls ? cls.color : (EVENT_COLORS[ev.type] || '#888');
      dot.style.background = color + '33';
      dot.style.color = color;
      dot.style.cursor = 'pointer';
      dot.textContent = ev.name;
      dot.onclick = e => { e.stopPropagation(); openAddEvent(ev); };
      cell.appendChild(dot);
    });
    const dayTasks = tasks.filter(t => t.dueDate === dateStr);
    dayTasks.slice(0, 3).forEach(task => {
      const pColor = PRIORITY_COLORS[task.priority] || '#888';
      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:3px;font-size:10px;padding:2px 4px;border-radius:4px;margin-bottom:2px;background:${pColor}18;color:${pColor};font-family:var(--mono);font-weight:700;min-width:0;overflow:hidden;`;
      const box = document.createElement('div');
      box.style.cssText = `width:9px;height:9px;border-radius:2px;flex-shrink:0;border:1.5px solid ${pColor};background:${task.done ? pColor : 'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:7px;color:#fff;transition:0.15s`;
      box.innerHTML = task.done ? SOI.checkBold : '';
      box.onclick = e => {
        e.stopPropagation();
        task.done = !task.done;
        persistTasks();
        box.style.background = task.done ? pColor : 'transparent';
        box.innerHTML = task.done ? SOI.checkBold : '';
        label.style.textDecoration = task.done ? 'line-through' : '';
        label.style.opacity = task.done ? '0.5' : '1';
        // Sync to Veda TaskHub
        if (window._vedaTogTask) window._vedaTogTask('t_' + task.id, task.done);
        // refresh class tasks panel if open
        const cls2 = classes.find(c => c.id === currentClassId);
        if (cls2) renderClassTasks(cls2);
      };
      const label = document.createElement('span');
      label.textContent = task.name + (task.dueTime ? ' · ' + task.dueTime : '');
      label.style.cssText = `overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;${task.done ? 'text-decoration:line-through;opacity:0.5' : ''}`;
      label.style.cursor = 'pointer';
      label.onclick = e => { e.stopPropagation(); openEditTask(task.id); };
      row.appendChild(box);
      row.appendChild(label);
      cell.appendChild(row);
    });
    cell.onclick = () => openAddEvent(null, dateStr);
    cells.appendChild(cell);
  }

  renderUpcoming();
}

function renderUpcoming() {
  const list = _sosEl('upcoming-list');
  if (!list) return;
  list.innerHTML = '';
  const _p2=n=>String(n).padStart(2,'0');
  const _n2=new Date();
  const todayStr = _n2.getFullYear()+'-'+_p2(_n2.getMonth()+1)+'-'+_p2(_n2.getDate());
  const future = events
    .filter(e => e.date >= todayStr)
    .sort((a,b) => a.date.localeCompare(b.date))
    .slice(0, 8);
  if (future.length === 0) {
    list.innerHTML = '<div style="padding:20px 18px;font-size:13px;color:var(--text3)">No upcoming events.</div>';
    return;
  }
  future.forEach(ev => {
    const cls = classes.find(c => c.id === ev.classId);
    const color = cls ? cls.color : (EVENT_COLORS[ev.type] || '#888');
    const item = document.createElement('div');
    item.className = 'timeline-item';
    item.style.cursor = 'pointer';
    item.title = 'Click to edit';
    item.onclick = () => openAddEvent(ev);
    item.innerHTML = `
      <div class="timeline-dot" style="background:${color}"></div>
      <div class="timeline-content" style="flex:1;min-width:0">
        <div class="timeline-title">${ev.name}</div>
        <div class="timeline-meta">${formatDate(ev.date)}${ev.time ? ' · ' + ev.time : ''}${cls ? ' · ' + cls.name : ''}</div>
      </div>
      <button style="background:none;border:1px solid var(--border2);color:var(--text3);cursor:pointer;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;white-space:nowrap;flex-shrink:0;font-family:inherit;transition:0.15s;margin-right:4px" title="Convert to Task" onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'" onmouseout="this.style.borderColor='var(--border2)';this.style.color='var(--text3)'" onclick="event.stopPropagation();convertEventToTask('${ev.id}')">→ Task</button>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="color:var(--text3);flex-shrink:0"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    `;
    list.appendChild(item);
  });
}

function prevMonth() { calDate.setMonth(calDate.getMonth() - 1); renderCalendar(); }
function nextMonth() { calDate.setMonth(calDate.getMonth() + 1); renderCalendar(); }

// ===== TIMELINE =====

function deleteEvent(id) {
  events = events.filter(e => e.id !== id);
  persistEvents();
  renderCalendar();
  updateStats();
}

// ===== NOTIFICATIONS =====
function showNotif(icon, title, body) {
  const container = _sosEl('notif-container');
  const notif = document.createElement('div');
  notif.className = 'notif';
  notif.innerHTML = `
    <div class="notif-icon">${icon}</div>
    <div>
      <div class="notif-title">${title}</div>
      <div class="notif-body">${body}</div>
    </div>
    <div class="notif-close" onclick="this.parentElement.remove()">×</div>
  `;
  container.appendChild(notif);
  requestAnimationFrame(() => notif.classList.add('show'));
  setTimeout(() => {
    notif.classList.remove('show');
    setTimeout(() => notif.remove(), 300);
  }, 4000);
}

function scheduleNotifications() {
  if (!window.thScheduleNotif) return;
  const nowT = Date.now();
  // ── Events ────────────────────────────────────────────────────────────────
  (Array.isArray(events) ? events : []).forEach(ev => {
    const nid = 'sos_ev_' + ev.id;
    const notifyAt = (ev.notif && ev.notif !== 'none') ? ev.notif : null;
    if (!notifyAt) { if (window.thCancelNotif) { try { window.thCancelNotif(nid, null); } catch(e){} } return; }
    if (new Date(notifyAt).getTime() <= nowT) return; // already past
    window.thScheduleNotif({
      id: nid,
      title: '📅 ' + ev.name + (ev.time ? ' at ' + ev.time : ' on ' + formatDate(ev.date)),
      notifyAt: notifyAt,
      dashboard: 'veda',
      notifyRepeat: 'none',
      notifyRepeatDays: [],
    });
  });
  // ── Tasks ───────────────────────────────────────────────────────────────
  // Previously omitted entirely — that's why StudyOS task reminders never fired
  // on the phone and never showed an on-screen card. Each task (incl. each
  // repeat occurrence, which is its own entry in `tasks`) gets its own unique
  // reminder id so simultaneous task+event reminders never collide.
  (Array.isArray(tasks) ? tasks : []).forEach(t => {
    const nid = 'sos_task_' + t.id;
    const notifyAt = (t.notif && t.notif !== 'none') ? t.notif : null;
    if (!notifyAt) { if (window.thCancelNotif) { try { window.thCancelNotif(nid, null); } catch(e){} } return; }
    if (new Date(notifyAt).getTime() <= nowT) return; // already past
    window.thScheduleNotif({
      id: nid,
      title: '📚 ' + t.name + (t.dueTime ? ' at ' + t.dueTime : ''),
      notifyAt: notifyAt,
      dashboard: 'veda',
      notifyRepeat: 'none',
      notifyRepeatDays: [],
    });
  });
}

function openNotifSettings() {
  showNotif(SOI.bell, 'Notifications', 'Set reminders when adding events via "Add Event" button.');
}

// ===== STATS =====
function updateStats() {
  const today = new Date();
  const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + 7);
  const eventsThisWeek = events.filter(e => {
    const d = new Date(e.date + 'T12:00:00');
    return d >= today && d <= weekEnd;
  }).length;
  _sosEl('stat-events').textContent = eventsThisWeek;

  // Exam-specific stats
  const todayStr = today.toISOString().split('T')[0];
  const upcomingExams = events
    .filter(e => (e.type === 'exam' || e.type === 'quiz') && e.date >= todayStr)
    .sort((a,b) => a.date.localeCompare(b.date));
  const examCountEl = _sosEl('stat-exams');
  const nextExamEl  = _sosEl('stat-next-exam');
  if (examCountEl) examCountEl.textContent = upcomingExams.length;
  if (nextExamEl) {
    if (upcomingExams.length > 0) {
      const daysUntil = Math.ceil((new Date(upcomingExams[0].date + 'T12:00:00') - today) / 86400000);
      nextExamEl.textContent = daysUntil === 0 ? 'TODAY' : daysUntil === 1 ? '1 day' : daysUntil + ' days';
      nextExamEl.style.color = daysUntil <= 3 ? '#ff6b6b' : daysUntil <= 7 ? '#ff9f43' : 'var(--accent2)';
    } else {
      nextExamEl.textContent = '—';
      nextExamEl.style.color = 'var(--accent2)';
    }
  }
  renderExamCountdown();
  renderPriorityQueue();
}

// ── Urgency score helper ────────────────────────────────────────────────────
// score = weight% × urgencyMultiplier where urgencyMultiplier decays over time
function _sosPriorityScore(ev) {
  const today = new Date();
  const daysLeft = Math.max(0, Math.ceil((new Date(ev.date + 'T12:00:00') - today) / 86400000));
  const weight = parseFloat(ev.weight) || 10; // default 10% if unset
  // Urgency: 100 at 0 days, halves every 7 days (exponential decay)
  const urgency = 100 * Math.pow(0.5, daysLeft / 7);
  return Math.round(urgency * weight);
}

// ── Exam Countdown ──────────────────────────────────────────────────────────
function renderExamCountdown() {
  const el = _sosEl('sos-exam-countdown-list');
  if (!el) return;
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const exams = events
    .filter(e => (e.type === 'exam' || e.type === 'quiz') && e.date >= todayStr)
    .sort((a,b) => a.date.localeCompare(b.date))
    .slice(0, 6);

  if (exams.length === 0) {
    el.innerHTML = '<div class="sos-exam-empty">No upcoming exams or quizzes.<br>Add one via <strong>+ Add Exam</strong> above,<br>or set type to Exam/Quiz when adding events.</div>';
    return;
  }

  el.innerHTML = '';
  exams.forEach(ev => {
    const cls = classes.find(c => c.id === ev.classId);
    const color = cls ? cls.color : (EVENT_COLORS[ev.type] || '#8D769A');
    const daysLeft = Math.ceil((new Date(ev.date + 'T12:00:00') - today) / 86400000);
    const daysLabel = daysLeft === 0 ? 'TODAY' : daysLeft === 1 ? '1 day' : daysLeft + ' days';
    const weight = parseFloat(ev.weight) || 0;

    // Badge color based on urgency
    let badgeBg, badgeText;
    if (daysLeft <= 2)       { badgeBg = 'rgba(255,107,107,0.18)'; badgeText = '#ff6b6b'; }
    else if (daysLeft <= 7)  { badgeBg = 'rgba(255,159,67,0.18)';  badgeText = '#ff9f43'; }
    else if (daysLeft <= 14) { badgeBg = 'rgba(255,211,42,0.15)';  badgeText = '#ffd32a'; }
    else                     { badgeBg = 'rgba(141,118,154,0.15)'; badgeText = '#A892B0'; }

    const item = document.createElement('div');
    item.className = 'sos-exam-item';
    item.title = 'Click to edit';
    item.onclick = () => openAddEvent(ev);
    item.innerHTML = `
      <div class="sos-exam-cd-badge" style="background:${badgeBg}">
        <div class="sos-exam-cd-days" style="color:${badgeText}">${daysLeft <= 0 ? '0' : daysLeft}</div>
        <div class="sos-exam-cd-lbl" style="color:${badgeText}">${daysLeft === 0 ? 'TODAY' : 'days'}</div>
      </div>
      <div class="sos-exam-info">
        <div class="sos-exam-name">${ev.name}</div>
        <div class="sos-exam-meta">${formatDate(ev.date)}${ev.time ? ' · ' + ev.time : ''}${cls ? ' · ' + cls.name : ''} · ${ev.type}</div>
      </div>
      ${weight > 0 ? `<div class="sos-exam-score-pill" style="background:${badgeBg};color:${badgeText}">${weight}%</div>` : ''}
    `;
    el.appendChild(item);
  });
}

// ── Priority Queue ──────────────────────────────────────────────────────────
function renderPriorityQueue() {
  const el = _sosEl('sos-priority-queue-list');
  if (!el) return;
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const in30 = new Date(today); in30.setDate(today.getDate() + 30);
  const in30Str = in30.toISOString().split('T')[0];

  // Include exams + hw + quiz within 30 days
  const scored = events
    .filter(e => ['exam','hw','quiz'].includes(e.type) && e.date >= todayStr && e.date <= in30Str)
    .map(e => ({ ev: e, score: _sosPriorityScore(e) }))
    .sort((a,b) => b.score - a.score)
    .slice(0, 8);

  if (scored.length === 0) {
    el.innerHTML = '<div class="sos-exam-empty">No exams, quizzes or<br>homework due in 30 days.</div>';
    return;
  }

  el.innerHTML = '';
  const maxScore = scored[0].score || 1;
  scored.forEach(({ ev, score }, i) => {
    const cls = classes.find(c => c.id === ev.classId);
    const color = cls ? cls.color : (EVENT_COLORS[ev.type] || '#888');
    const daysLeft = Math.ceil((new Date(ev.date + 'T12:00:00') - today) / 86400000);
    const daysStr = daysLeft === 0 ? 'today' : daysLeft === 1 ? '1d' : daysLeft + 'd';
    const weight = parseFloat(ev.weight) || 0;
    const pct = Math.round((score / maxScore) * 100);

    const item = document.createElement('div');
    item.className = 'sos-pq-item';
    item.title = 'Click to edit';
    item.onclick = () => openAddEvent(ev);
    item.innerHTML = `
      <div class="sos-pq-rank">${i + 1}</div>
      <div class="sos-pq-dot" style="background:${color}"></div>
      <div class="sos-pq-info">
        <div class="sos-pq-name">${ev.name}</div>
        <div class="sos-pq-meta">${daysStr} away · ${ev.type}${weight > 0 ? ' · ' + weight + '%' : ''}</div>
      </div>
      <div class="sos-pq-score">${pct}</div>
    `;
    el.appendChild(item);
  });
}

// ===== TASKS =====
function persistTasks() { localStorage.setItem('studyos_tasks', JSON.stringify(tasks)); _sosFirebaseSave(); }

function openAddTaskForClass() {
  editingTaskId = null;
  _sosEl('add-task-modal-title').textContent = 'New Task';
  _sosEl('inp-task-name').value = '';
  const today = new Date().toISOString().split('T')[0];
  _sosEl('inp-task-date').value = today;
  _sosEl('inp-task-time').value = '';
  _sosEl('inp-task-priority').value = 'medium';
  _sosEl('inp-task-notes').value = '';
  { const _nd=_sosEl('inp-task-notif-date'); if(_nd)_nd.value=''; const _nt=_sosEl('inp-task-notif-time'); if(_nt)_nt.value=''; }
  _sosEl('btn-delete-task').style.display = 'none';
  // Hide class selector when opening from class detail (class already set)
  const classField = _sosEl('inp-task-class-field');
  if (classField) classField.style.display = 'none';
  _sosResetTaskRepeatUI(null);
  _sosOpen('modal-add-task');
}

function openAddTaskGlobal() {
  editingTaskId = null;
  _sosEl('add-task-modal-title').textContent = 'New Task';
  _sosEl('inp-task-name').value = '';
  const today = new Date().toISOString().split('T')[0];
  _sosEl('inp-task-date').value = today;
  _sosEl('inp-task-time').value = '';
  _sosEl('inp-task-priority').value = 'medium';
  _sosEl('inp-task-notes').value = '';
  { const _nd=_sosEl('inp-task-notif-date'); if(_nd)_nd.value=''; const _nt=_sosEl('inp-task-notif-time'); if(_nt)_nt.value=''; }
  _sosEl('btn-delete-task').style.display = 'none';
  // Show class selector and populate it
  const classField = _sosEl('inp-task-class-field');
  if (classField) classField.style.display = '';
  const sel = _sosEl('inp-task-class');
  if (sel) {
    sel.innerHTML = '<option value="">— None —</option>';
    classes.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id; opt.textContent = c.name; sel.appendChild(opt);
    });
    sel.value = '';
  }
  _sosResetTaskRepeatUI(null);
  _sosOpen('modal-add-task');
}

function openEditTask(taskId) {
  const t = tasks.find(x => x.id === taskId);
  if (!t) return;
  editingTaskId = taskId;
  _sosEl('add-task-modal-title').textContent = 'Edit Task';
  _sosEl('inp-task-name').value = t.name;
  _sosEl('inp-task-date').value = t.dueDate || '';
  _sosEl('inp-task-time').value = t.dueTime || '';
  _sosEl('inp-task-priority').value = t.priority || 'medium';
  _sosEl('inp-task-notes').value = t.notes || '';
  (()=>{ const nd=_sosEl('inp-task-notif-date'), nt=_sosEl('inp-task-notif-time'); if(t.notif&&t.notif!=='none'){ const dt=new Date(t.notif); if(!isNaN(dt.getTime())){ const pad=n=>String(n).padStart(2,'0'); if(nd)nd.value=dt.getFullYear()+'-'+pad(dt.getMonth()+1)+'-'+pad(dt.getDate()); if(nt)nt.value=pad(dt.getHours())+':'+pad(dt.getMinutes()); } } else { if(nd)nd.value=''; if(nt)nt.value=''; } })();
  _sosEl('btn-delete-task').style.display = '';
  // Show class selector and populate it
  const classField = _sosEl('inp-task-class-field');
  if (classField) classField.style.display = '';
  const sel = _sosEl('inp-task-class');
  if (sel) {
    sel.innerHTML = '<option value="">— None —</option>';
    classes.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id; opt.textContent = c.name; sel.appendChild(opt);
    });
    sel.value = t.classId || '';
  }
  _sosResetTaskRepeatUI(t);
  _sosOpen('modal-add-task');
}

// Build notifyAt ISO string for a task given its dueDate, dueTime, and notif offset (minutes)
function _sosBuildTaskNotifyAt(dueDate, notifVal, dueTime) {
  if (!dueDate || !notifVal || notifVal === 'none') return null;
  const offsetMin = parseInt(notifVal);
  if (isNaN(offsetMin)) return null;
  // Use task's due time if set, else default to 9:00 AM
  const timeStr = dueTime || '09:00';
  const base = new Date(dueDate + 'T' + timeStr + ':00');
  return new Date(base.getTime() - offsetMin * 60000).toISOString();
}

function saveTask() {
  const name = _sosEl('inp-task-name').value.trim();
  if (!name) { alert('Task name required.'); return; }
  const dueDate = _sosEl('inp-task-date').value;
  const dueTime = (_sosEl('inp-task-time') || {}).value || '';
  const repeatEndDate = (_sosEl('inp-task-repeat-end') || {}).value || '';
  const baseData = {
    name,
    dueDate,
    dueTime,
    priority: _sosEl('inp-task-priority').value,
    classId: (()=>{ const cf=_sosEl('inp-task-class-field'); const sel=_sosEl('inp-task-class'); return (cf&&cf.style.display!=='none'&&sel) ? (sel.value||'') : (currentClassId||''); })(),
    notes: _sosEl('inp-task-notes').value.trim(),
    notif: (()=>{ const d=(_sosEl('inp-task-notif-date')||{}).value||''; const t=(_sosEl('inp-task-notif-time')||{}).value||''; return (d&&t)?new Date(d+'T'+t+':00').toISOString():'none'; })(),
    repeat: _sosTaskRepeat.mode,
    repeatDays: _sosTaskRepeat.mode === 'weekly' ? [..._sosTaskRepeat.days] : [],
    repeatEndDate: _sosTaskRepeat.mode !== 'none' ? repeatEndDate : '',
  };
  const _sosCls = classes.find(c => c.id === baseData.classId);
  const _sosClsName  = _sosCls ? _sosCls.name  : '';
  const _sosClsColor = _sosCls ? _sosCls.color : '';
  const toVedaKey = d => { const [y,m,dd] = d.split('-').map(Number); return `${y}-${String(m).padStart(2,'0')}-${String(dd).padStart(2,'0')}`; };

  // Build Veda task item for a given date + id
  const mkVedaItem = (itemId, d) => ({
    id: 'sos_t_' + itemId, _sosId: 't_' + itemId,
    type: 'task', title: baseData.name,
    category: 'study', done: false,
    _sosClassName: _sosClsName, _sosClassColor: _sosClsColor,
  });

  if (editingTaskId) {
    // ── EDIT ────────────────────────────────────────────────────────────────
    const editingT = tasks.find(t => t.id === editingTaskId);
    if (!editingT) { editingTaskId = null; return; }
    const wasRepeating = !!editingT.repeatId;
    const nowCancelled = _sosTaskRepeat.mode === 'none';

    if (wasRepeating && nowCancelled) {
      const rid = editingT.repeatId;
      const cutoff = new Date(editingT.dueDate + 'T12:00:00');
      tasks = tasks.filter(t => {
        if (t.repeatId !== rid) return true;
        return new Date((t.dueDate||'9999')+  'T12:00:00') < cutoff;
      });
      const singleId = uid();
      tasks.push({ id: singleId, done: false, createdAt: Date.now(), ...baseData, repeat:'none', repeatDays:[], repeatEndDate:'', repeatId:undefined });
      if (window._vedaRemoveTask) window._vedaRemoveTask('__repeatId__t_' + rid);
      if (window._vedaAddTask && dueDate) {
        const item = mkVedaItem(singleId, dueDate);
        item._sosId = 't_' + singleId;
        window._vedaAddTask(toVedaKey(dueDate), item);
      }
    } else if (wasRepeating) {
      const rid = editingT.repeatId;
      tasks = tasks.filter(t => t.repeatId !== rid);
      const dates = dueDate ? _sosTaskRepeatDates(dueDate) : [dueDate];
      dates.forEach(d => {
        if (d) tasks.push({ id: uid(), done: false, createdAt: Date.now(), ...baseData, repeatId: rid, dueDate: d });
      });
      if (window._vedaRemoveTask) window._vedaRemoveTask('__repeatId__t_' + rid);
      if (window._vedaAddTask) {
        dates.forEach(d => {
          if (!d) return;
          const iid = uid();
          const item = mkVedaItem(iid, d);
          item._sosRepeatId = 't_' + rid;
          window._vedaAddTask(toVedaKey(d), item);
        });
      }
    } else {
      const idx = tasks.findIndex(t => t.id === editingTaskId);
      if (idx !== -1) {
        const oldDate = tasks[idx].dueDate;
        if (_sosTaskRepeat.mode !== 'none') {
          tasks.splice(idx, 1);
          const rid = uid();
          const dates = dueDate ? _sosTaskRepeatDates(dueDate) : [];
          dates.forEach(d => tasks.push({ id: uid(), done: false, createdAt: Date.now(), ...baseData, repeatId: rid, dueDate: d }));
          if (window._vedaRemoveTask) window._vedaRemoveTask('t_' + editingTaskId);
          if (window._vedaAddTask) {
            dates.forEach(d => {
              if (!d) return;
              const iid = uid();
              const item = mkVedaItem(iid, d);
              item._sosRepeatId = 't_' + rid;
              window._vedaAddTask(toVedaKey(d), item);
            });
          }
        } else {
          tasks[idx] = { ...tasks[idx], ...baseData };
          if (window._vedaUpdateTask && dueDate && oldDate) {
            const item = mkVedaItem(editingTaskId, dueDate);
            window._vedaUpdateTask(toVedaKey(oldDate), toVedaKey(dueDate), item);
          } else if (window._vedaUpdateTask && dueDate) {
            const item = mkVedaItem(editingTaskId, dueDate);
            window._vedaAddTask && window._vedaAddTask(toVedaKey(dueDate), item);
          }
        }
      }
    }
    showNotif(SOI.task, 'Task Updated', baseData.name);

  } else {
    // ── ADD ─────────────────────────────────────────────────────────────────
    if (_sosTaskRepeat.mode !== 'none') {
      const rid = uid();
      const dates = dueDate ? _sosTaskRepeatDates(dueDate) : [];
      dates.forEach(d => tasks.push({ id: uid(), done: false, createdAt: Date.now(), ...baseData, repeatId: rid, dueDate: d }));
      if (window._vedaAddTask) {
        dates.forEach(d => {
          if (!d) return;
          const iid = uid();
          const item = mkVedaItem(iid, d);
          item._sosRepeatId = 't_' + rid;
          window._vedaAddTask(toVedaKey(d), item);
        });
      }
      showNotif(SOI.task, 'Repeating Task Added', baseData.name + ' · ' + dates.length + ' occurrences');
    } else {
      const newId = Date.now().toString();
      tasks.push({ id: newId, done: false, createdAt: Date.now(), ...baseData });
      if (window._vedaAddTask && dueDate) {
        const item = mkVedaItem(newId, dueDate);
        window._vedaAddTask(toVedaKey(dueDate), item);
      }
      showNotif(SOI.task, 'Task Added', baseData.name);
    }
  }

  editingTaskId = null;
  persistTasks();
  _sosClose('modal-add-task');
  renderCalendar();
  renderUpcoming();
  updateStats();
  // ── FCM + on-screen reminders (Veda-main devices) ──────────────────────
  // Re-run the unified scheduler so tasks register exactly like events. This
  // covers single, edited, and repeat-occurrence tasks — each keeps its own
  // unique 'sos_task_<id>' reminder so a task + event at the same time both fire.
  scheduleNotifications();
  const cls = classes.find(c => c.id === currentClassId);
  if (cls) renderClassTasks(cls);
}

async function deleteEditingTask() {
  if (!editingTaskId) return;
  const t = tasks.find(x => x.id === editingTaskId);
  if (!t) { editingTaskId = null; return; }

  if (t.repeatId) {
    const choice = await window.uiConfirm('This is a repeating task. Delete all future occurrences, or only this one?', {title:'Delete repeating task', okLabel:'All future', cancelLabel:'This only'});
    if (choice) {
      const rid = t.repeatId;
      const cutoff = new Date((t.dueDate || '9999') + 'T12:00:00');
      if (window.thCancelNotif) {
        tasks.filter(x => x.repeatId === rid && new Date((x.dueDate||'9999')+'T12:00:00') >= cutoff)
             .forEach(x => window.thCancelNotif('sos_task_' + x.id, null));
      }
      tasks = tasks.filter(x => {
        if (x.repeatId !== rid) return true;
        return new Date((x.dueDate || '9999') + 'T12:00:00') < cutoff;
      });
      if (window._vedaRemoveTask) window._vedaRemoveTask('__repeatId__t_' + rid);
    } else {
      if (window.thCancelNotif) window.thCancelNotif('sos_task_' + editingTaskId, null);
      tasks = tasks.filter(x => x.id !== editingTaskId);
      if (window._vedaRemoveTask) window._vedaRemoveTask('t_' + editingTaskId);
    }
  } else {
    if (!(await window.uiConfirm('Delete "' + t.name + '"?', {danger:true, okLabel:'Delete'}))) return;
    if (window.thCancelNotif) window.thCancelNotif('sos_task_' + editingTaskId, null);
    tasks = tasks.filter(x => x.id !== editingTaskId);
    if (window._vedaRemoveTask) window._vedaRemoveTask('t_' + editingTaskId);
  }

  editingTaskId = null;
  persistTasks();
  _sosClose('modal-add-task');
  renderCalendar();
  const cls = classes.find(c => c.id === currentClassId);
  if (cls) renderClassTasks(cls);
  showNotif(SOI.trash, 'Task Deleted', 'Task removed.');
}

function toggleTaskDone(taskId) {
  const t = tasks.find(x => x.id === taskId);
  if (!t) return;
  t.done = !t.done;
  persistTasks();

  // Sync done state to Veda/TaskHub calendar
  if (window._vedaTogTask) {
    window._vedaTogTask('t_' + taskId, t.done);
  }

  // Re-render calendar + stats so strikethrough/progress updates everywhere
  renderCalendar();
  updateStats();

  const cls = classes.find(c => c.id === currentClassId);
  if (cls) renderClassTasks(cls);
}

function renderClassTasks(cls) {
  // Tasks now rendered inside renderClassEvents (merged Upcoming panel)
  renderClassEvents(cls);
}

// ===== POMODORO =====
const POMO_CIRCUMFERENCE = 2 * Math.PI * 108;
let pomoMode = 'work';
let pomoRunning = false;
let pomoSeconds = 25 * 60;
let pomoTotal = 25 * 60;
let pomoSession = 0;

// Web Worker for accurate background timing
// Inline timer replaces Web Worker (blob workers blocked by CSP)
let _pomoIv = null, _pomoEnd = 0;
const pomoWorker = {
  postMessage: function(data) {
    if (data.cmd === 'start') {
      clearInterval(_pomoIv);
      _pomoEnd = Date.now() + data.secs * 1000;
      _pomoIv = setInterval(function() {
        const rem = Math.round((_pomoEnd - Date.now()) / 1000);
        if (rem <= 0) {
          clearInterval(_pomoIv); _pomoIv = null;
          pomoWorker.onmessage({data: {type: 'done'}});
        } else {
          pomoWorker.onmessage({data: {type: 'tick', left: rem}});
        }
      }, 250);
    } else if (data.cmd === 'stop') {
      clearInterval(_pomoIv); _pomoIv = null;
    }
  },
  onmessage: null
};
pomoWorker.onmessage = function(e) {
  if (e.data.type === 'tick') {
    pomoSeconds = e.data.left;
    updatePomoDisplay();
    updatePomoRing();
    updateTopbarPomo();
  } else if (e.data.type === 'done') {
    pomoSeconds = 0;
    pomoRunning = false;
    updatePomoDisplay();
    updatePomoRing();
    updatePomoPlayBtn();
    updateTopbarPomo();
    playPomoAlarm();
    if (pomoMode === 'work') {
      pomoSession = (pomoSession + 1) % 4;
      updatePomoDots();
      const nextMode = pomoSession === 0 ? 'long' : 'short';
      showNotif('', 'Focus complete!', 'Time for a ' + (nextMode==='long'?'long':'short') + ' break.');
      setPomoMode(nextMode);
    } else {
      showNotif('', 'Break over!', 'Ready to focus again.');
      setPomoMode('work');
    }
  }
};

function playPomoAlarm() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  const notes = [523.25, 659.25, 783.99, 659.25, 783.99, 1046.5, 783.99, 1046.5, 783.99, 659.25];
  const dur = 0.45, gap = 0.05;
  notes.forEach((freq, i) => {
    const t = ctx.currentTime + i * (dur + gap);
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(0.18, t + 0.05);
    gain.gain.setValueAtTime(0.18, t + dur * 0.6); gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(gain); gain.connect(ctx.destination); osc.start(t); osc.stop(t + dur);
    const osc2 = ctx.createOscillator(); const g2 = ctx.createGain();
    osc2.type = 'triangle'; osc2.frequency.setValueAtTime(freq * 2, t);
    g2.gain.setValueAtTime(0.08, t); osc2.connect(g2); g2.connect(ctx.destination);
    osc2.start(t); osc2.stop(t + dur);
  });
  setTimeout(() => ctx.close(), 6000);
}

// Warm up AudioContext on first user interaction (required by browsers)
let _pomoAudioCtx = null;
document.addEventListener('click', function warmAudio() {
  if (!_pomoAudioCtx) {
    _pomoAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = _pomoAudioCtx.createOscillator(); const g = _pomoAudioCtx.createGain();
    g.gain.setValueAtTime(0, _pomoAudioCtx.currentTime);
    o.connect(g); g.connect(_pomoAudioCtx.destination);
    o.start(); o.stop(_pomoAudioCtx.currentTime + 0.01);
  }
  document.removeEventListener('click', warmAudio);
}, {once: true});

function pomoMins(mode) {
  const v = { work: 'pomo-inp-work', short: 'pomo-inp-short', long: 'pomo-inp-long' };
  return parseInt(_sosEl(v[mode]).value) || (mode==='work'?25:mode==='short'?5:15);
}

function setPomoMode(mode) {
  if (pomoRunning) { pomoWorker.postMessage({cmd:'stop'}); pomoRunning = false; updatePomoPlayBtn(); }
  pomoMode = mode;
  pomoTotal = pomoMins(mode) * 60;
  pomoSeconds = pomoTotal;
  document.querySelectorAll('#study-root .pomo-mode-btn').forEach(b => b.classList.remove('active'));
  _sosEl('pomo-btn-' + (mode==='work'?'work':mode==='short'?'short':'long')).classList.add('active');
  const labels = { work:'Focus', short:'Short Break', long:'Long Break' };
  _sosEl('pomo-mode-label').textContent = labels[mode];
  updatePomoDisplay();
  updatePomoRing();
  updateTopbarPomo();
}

function togglePomo() {
  if (pomoRunning) {
    pomoWorker.postMessage({cmd:'stop'});
    pomoRunning = false;
  } else {
    pomoWorker.postMessage({cmd:'start', secs: pomoSeconds});
    pomoRunning = true;
  }
  updatePomoPlayBtn();
  updateTopbarPomo();
}

function resetPomo() {
  pomoWorker.postMessage({cmd:'stop'});
  pomoRunning = false;
  pomoSeconds = pomoTotal;
  updatePomoDisplay();
  updatePomoRing();
  updatePomoPlayBtn();
  updateTopbarPomo();
}

function skipPomo() {
  pomoWorker.postMessage({cmd:'stop'});
  pomoRunning = false;
  pomoSeconds = 0;
  updatePomoDisplay();
  updatePomoRing();
  updatePomoPlayBtn();
  if (pomoMode === 'work') {
    pomoSession = (pomoSession + 1) % 4;
    updatePomoDots();
    const nextMode = pomoSession === 0 ? 'long' : 'short';
    setPomoMode(nextMode);
  } else {
    setPomoMode('work');
  }
}

function updatePomoDisplay() {
  const m = Math.floor(pomoSeconds / 60);
  const s = pomoSeconds % 60;
  const str = String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  _sosEl('pomo-display').textContent = str;
  _sosEl('topbar-pomo-time').textContent = str;
  var spbTime = document.getElementById('spb-time');
  if (spbTime) spbTime.textContent = str;
}

function updatePomoRing() {
  const frac = pomoSeconds / pomoTotal;
  const offset = POMO_CIRCUMFERENCE * (1 - frac);
  _sosEl('pomo-ring').style.strokeDashoffset = offset;
}

function updatePomoPlayBtn() {
  const pause = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  const play = '<polygon points="5,3 19,12 5,21"/>';
  _sosEl('pomo-play-icon').innerHTML = pomoRunning ? pause : play;
  _sosEl('topbar-pomo-icon').innerHTML = pomoRunning ? pause : play;
  var spbIcon = document.getElementById('spb-icon');
  if (spbIcon) spbIcon.innerHTML = pomoRunning ? pause : play;
}

function updateTopbarPomo() {
  const pill = _sosEl('topbar-pomo');
  const labels = { work:'Focus', short:'Short Break', long:'Long Break' };
  _sosEl('topbar-pomo-label').textContent = labels[pomoMode];
  const active = pomoRunning || pomoSeconds < pomoTotal;
  pill.style.display = active ? 'flex' : 'none';
  // Mobile banner
  var banner = document.getElementById('sos-pomo-banner');
  var spbLabel = document.getElementById('spb-label');
  if (banner) banner.style.display = active ? 'flex' : 'none';
  if (spbLabel) spbLabel.textContent = labels[pomoMode];
}

function updatePomoDots() {
  for (let i = 0; i < 4; i++) {
    _sosEl('pd'+i).classList.toggle('done', i < pomoSession);
  }
}

function onPomoSettingChange() {
  if (!pomoRunning) setPomoMode(pomoMode);
}


function _sosOpen(id) {
  var el = document.getElementById(id);
  if (el) el.classList.add('open');
}
function _sosClose(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('open');
}
document.querySelectorAll('.sos-modal').forEach(function(overlay) {
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

// ===== PERSIST =====
var _sosSyncTimer = null;
function _sosSetSync(status) {
  var el = document.getElementById('sos-sync-status');
  if (!el) return;
  // Color: use StudyOS accent color (purple)
  var accentColor = '#8D769A';
  var greenColor  = '#4a7c59';
  var errColor    = '#d68a7c';
  var mutedColor  = 'var(--text2,#888)';
  if (status === 'saving') {
    el.style.visibility = 'visible';
    el.style.color = mutedColor;
    el.textContent = 'Syncing…';
    if (_sosSyncTimer) { clearTimeout(_sosSyncTimer); _sosSyncTimer = null; }
  } else if (status === 'saved') {
    el.style.visibility = 'visible';
    el.style.color = greenColor;
    el.innerHTML = SOI.check + ' Synced';
    if (_sosSyncTimer) clearTimeout(_sosSyncTimer);
    _sosSyncTimer = setTimeout(function() { el.style.visibility = 'hidden'; }, 2500);
  } else if (status === 'error') {
    el.style.visibility = 'visible';
    el.style.color = errColor;
    el.innerHTML = SOI.alert + ' Sync failed';
    if (_sosSyncTimer) { clearTimeout(_sosSyncTimer); _sosSyncTimer = null; }
  } else {
    el.style.visibility = 'hidden';
  }
}

// Strip dataUrl/blob fields from classes before any serialization.
// Files live in IndexedDB; only metadata (name, size, mime, fileId) serialized.
function _sosSerializeClasses() {
  return classes.map(cls => ({
    ...cls,
    modules: (cls.modules || []).map(mod => ({
      ...mod,
      files: (mod.files || []).map(f => {
        // Keep persistent metadata (incl. storageUrl/storagePath so the cloud
        // copy is reachable on other devices). Strip the inline blob (dataUrl)
        // and any transient `_`-prefixed flags (e.g. _uploading/_cloudError).
        const meta = {};
        for (const k in f) { if (k === 'dataUrl' || k.charAt(0) === '_') continue; meta[k] = f[k]; }
        return meta;
      })
    }))
  }));
}

function _sosFirebaseSave() {
  if (!window._fbSaveStudyOs) return;
  _sosSetSync('saving');
  window._fbSaveStudyOs({
    classes:   _sosSerializeClasses(),
    events:    events,
    tasks:     tasks,
    notes:     notesList,
    ksu:       ksuData,
    d2l:       d2lMap
  });
}

function persist() {
  localStorage.setItem('studyos_classes', JSON.stringify(_sosSerializeClasses()));
  _sosFirebaseSave();
  // also re-render ksu grid if open
  if (activeView === 'ksu') renderKsuModules();
}
function _ksuPersistHook() {
  persistKsu();
  if (activeView === 'ksu') renderKsuModules();
}
function persistEvents()  { localStorage.setItem('studyos_events', JSON.stringify(events));     _sosFirebaseSave(); }
function persistTasks_()  { localStorage.setItem('studyos_tasks',  JSON.stringify(tasks));      _sosFirebaseSave(); }

// ===== CONVERT EVENT ↔ TASK =====
async function convertEventToTask(evId) {
  const ev = events.find(e => e.id === evId);
  if (!ev) return;
  if (!(await window.uiConfirm('Convert "' + ev.name + '" from event to task?', {okLabel:'Convert'}))) return;

  // Create task from event
  const newId = uid();
  const cls = classes.find(c => c.id === ev.classId);
  const newTask = {
    id: newId,
    name: ev.name,
    dueDate: ev.date || '',
    dueTime: ev.time || '',
    priority: 'medium',
    classId: ev.classId || '',
    notes: '',
    notif: 'none',
    repeat: 'none',
    repeatDays: [],
    repeatEndDate: '',
    done: false,
    createdAt: Date.now(),
  };
  tasks.push(newTask);

  // Remove event from StudyOS
  if (ev.repeatId) {
    events = events.filter(e => e.repeatId !== ev.repeatId);
    if (window._vedaRemoveTask) window._vedaRemoveTask('__repeatId__' + ev.repeatId);
  } else {
    events = events.filter(e => e.id !== evId);
    if (window._vedaRemoveTask) window._vedaRemoveTask(evId);
  }

  // Push task to Veda TaskHub
  if (window._vedaAddTask && newTask.dueDate) {
    const toVedaKey = d => { const [y,m,dd] = d.split('-').map(Number); return `${y}-${String(m).padStart(2,'0')}-${String(dd).padStart(2,'0')}`; };
    window._vedaAddTask(toVedaKey(newTask.dueDate), {
      id: 'sos_t_' + newId, _sosId: 't_' + newId,
      type: 'task', title: newTask.name,
      category: 'study', done: false,
      _sosClassName: cls ? cls.name : '', _sosClassColor: cls ? cls.color : '',
    });
  }

  persistEvents();
  persistTasks();
  renderCalendar();
  renderUpcoming();
  updateStats();
  const curCls = classes.find(c => c.id === currentClassId);
  if (curCls) { renderClassEvents(curCls); }
  showNotif(SOI.task, 'Converted to Task', ev.name + ' is now a task.');
}

async function convertTaskToEvent(taskId) {
  const t = tasks.find(x => x.id === taskId);
  if (!t) return;
  if (!(await window.uiConfirm('Convert "' + t.name + '" from task to event?', {okLabel:'Convert'}))) return;

  // Create event from task
  const newId = uid();
  const cls = classes.find(c => c.id === t.classId);
  const newEvent = {
    id: newId,
    name: t.name,
    date: t.dueDate || new Date().toISOString().split('T')[0],
    time: t.dueTime || '',
    classId: t.classId || '',
    type: 'other',
    weight: '',
    notif: 'none',
    repeat: 'none',
    repeatDays: [],
    repeatEndDate: '',
  };
  events.push(newEvent);

  // Remove task from StudyOS + Veda
  if (t.repeatId) {
    tasks = tasks.filter(x => x.repeatId !== t.repeatId);
    if (window._vedaRemoveTask) window._vedaRemoveTask('__repeatId__t_' + t.repeatId);
  } else {
    tasks = tasks.filter(x => x.id !== taskId);
    if (window._vedaRemoveTask) window._vedaRemoveTask('t_' + taskId);
  }

  // Push event to Veda TaskHub
  if (window._vedaAddTask && newEvent.date) {
    const toVedaKey = d => { const [y,m,dd] = d.split('-').map(Number); return `${y}-${String(m).padStart(2,'0')}-${String(dd).padStart(2,'0')}`; };
    window._vedaAddTask(toVedaKey(newEvent.date), {
      id: 'sos_' + newId, _sosId: newId,
      type: 'event', title: newEvent.name,
      time: newEvent.time || '', category: 'study', done: false,
      _sosClassName: cls ? cls.name : '', _sosClassColor: cls ? cls.color : '',
    });
  }

  persistTasks();
  persistEvents();
  renderCalendar();
  renderUpcoming();
  updateStats();
  const curCls = classes.find(c => c.id === currentClassId);
  if (curCls) { renderClassEvents(curCls); }
  showNotif(SOI.calendar, 'Converted to Event', t.name + ' is now an event.');
}

// ── Firebase init for StudyOS ──────────────────────────────────────────────
function sosInitFirebase() {
  var doLoad = function() {
    if (!window._fbLoadStudyOs) return;
    window._fbLoadStudyOs().then(function(remote) {
      if (!remote) return;
      var changed = false;
      if (Array.isArray(remote.classes) && remote.classes.length) {
        classes = remote.classes;
        classes.forEach(c => { if (c && c.color && window.sosPastel) c.color = window.sosPastel(c.color); });
        localStorage.setItem('studyos_classes', JSON.stringify(classes));
        changed = true;
      }
      if (Array.isArray(remote.events) && remote.events.length) {
        events = remote.events;
        localStorage.setItem('studyos_events', JSON.stringify(events));
        changed = true;
      }
      if (Array.isArray(remote.tasks) && remote.tasks.length) {
        tasks = remote.tasks;
        localStorage.setItem('studyos_tasks', JSON.stringify(tasks));
        changed = true;
      }
      if (Array.isArray(remote.notes) && remote.notes.length) {
        notesList = remote.notes;
        localStorage.setItem('studyos_notes_v2', JSON.stringify(notesList));
        changed = true;
      }
      if (remote.ksu && Array.isArray(remote.ksu.modules)) {
        ksuData = remote.ksu;
        localStorage.setItem('studyos_ksu', JSON.stringify(ksuData));
        changed = true;
      }
      if (remote.d2l && typeof remote.d2l === 'object') {
        d2lMap = remote.d2l;
        localStorage.setItem('studyos_d2l', JSON.stringify(d2lMap));
      }
      if (changed) {
        renderClasses();
        renderSidebarClasses();
        renderCalendar();
        updateStats();
        renderNotesList();
        renderKsuModules();
        renderExamCountdown();
        renderPriorityQueue();
      }
      // Firestore data is now authoritative — keep cloud URLs sticky and
      // upload any files this device has locally but the cloud doesn't.
      _sosAfterSync();
    }).catch(function(e){ console.warn('SOS load error', e); });
  };

  if (window._fbReady) doLoad();
  else window.addEventListener('fb-ready', doLoad, { once: true });

  // remote update from another device
  window.addEventListener('fb-sos-remote', function(e) {
    var remote = e.detail;
    if (!remote) return;
    if (Array.isArray(remote.classes))  { classes   = remote.classes;   classes.forEach(c => { if (c && c.color && window.sosPastel) c.color = window.sosPastel(c.color); });   localStorage.setItem('studyos_classes',   JSON.stringify(classes));   }
    if (Array.isArray(remote.events))   { events    = remote.events;    localStorage.setItem('studyos_events',    JSON.stringify(events));    }
    if (Array.isArray(remote.tasks))    { tasks     = remote.tasks;     localStorage.setItem('studyos_tasks',     JSON.stringify(tasks));     }
    if (Array.isArray(remote.notes))    { notesList = remote.notes;     localStorage.setItem('studyos_notes_v2',  JSON.stringify(notesList));  }
    if (remote.ksu && Array.isArray(remote.ksu.modules)) { ksuData = remote.ksu; localStorage.setItem('studyos_ksu', JSON.stringify(ksuData)); }
    if (remote.d2l && typeof remote.d2l === 'object') { d2lMap = remote.d2l; localStorage.setItem('studyos_d2l', JSON.stringify(d2lMap)); }
    renderClasses();
    renderSidebarClasses();
    renderCalendar();
    updateStats();
    renderNotesList();
    renderKsuModules();
    renderExamCountdown();
    renderPriorityQueue();
    scheduleNotifications();
    // A remote save may have arrived without storageUrls (from a device that
    // lacks the blobs). Re-stamp known cloud URLs and upload any local-only files.
    _sosAfterSync();
  });

  // saved / error events
  window.addEventListener('fb-sos-saved', function() { _sosSetSync('saved'); });
  window.addEventListener('fb-sos-synced', function() { _sosSetSync('saved'); });
  window.addEventListener('fb-sos-error', function() { _sosSetSync('error'); });
}


/* ── Boot ──────────────────────────────────────────────────────────────────
 * The host page used to call studyOsInit() the first time its nav opened
 * StudyOS. Standalone, StudyOS *is* the page, so it boots itself — but only
 * once the App Lock has cleared, so a locked app never renders its data.
 *
 * js/applock.js resolves window.SOS_GATE when access is granted. With App Lock
 * disabled or unconfigured that promise is already resolved, so this is a
 * straight-through boot. */
window.studyOsInit = function () {
  window._sosRoot = document.getElementById('study-root');
  init();
  sosInitFirebase();
  scheduleNotifications();
};

/* ── Bridge for js/taskmirror.js ───────────────────────────────────────────
 * `classes`, `events` and `tasks` are top-level `let` bindings in this classic
 * script. They live in the global LEXICAL scope, not on `window`, so another
 * script can't reach them by property access. This is the one supported way in
 * and out — taskmirror.js derives the whole mirror from these getters rather
 * than tracking changes incrementally, which is what makes it self-healing.
 *
 * setTaskDone is the return path: TaskHub ticking a StudyOS task lands here. */
window._sosBridge = {
  getClasses: () => classes,
  getEvents:  () => events,
  getTasks:   () => tasks,
  setTaskDone: (taskId, done) => {
    const t = tasks.find(x => x.id === taskId);
    if (!t || t.done === done) return false;
    t.done = done;
    persistTasks();
    // Repaint whatever is on screen; each of these is a no-op if its view
    // isn't mounted.
    try { renderCalendar(); } catch (e) {}
    try { renderUpcoming(); } catch (e) {}
    try { updateStats(); } catch (e) {}
    try { renderPriorityQueue(); } catch (e) {}
    const cur = classes.find(c => c.id === currentClassId);
    if (cur) { try { renderClassEvents(cur); } catch (e) {} }
    return true;
  },
};

/* ── Brightspace import bridge (js/d2l-sync.js) ────────────────────────────
 * Same contract as setTaskDone above, and it exists for the same reason:
 * `events`, `tasks`, the persist* functions and every render function are
 * lexically scoped to this file, so d2l-sync.js cannot reach them by property
 * access. Mutating the arrays through the getters would persist nothing and
 * repaint nothing, and the next fb-sos-remote would discard the change.
 *
 * This is a DUMB, TOTAL setter. All of the reconciliation — which items to add,
 * update, keep or drop, and the carry-over of local state like a ticked `done`
 * — lives in d2l-sync.js. Nothing here knows what D2L is.
 *
 * The 900 KB size guard in firebase-sync.js still applies to whatever this
 * writes, so an oversized payload is refused there and can never wedge the
 * queue; d2l-sync.js pre-checks the size anyway so the user gets a message
 * that names the problem. */
window._sosBridge.getD2LMap = () => (d2lMap ? JSON.parse(JSON.stringify(d2lMap)) : null);

window._sosBridge.applyD2L = (payload) => {
  if (!payload) return false;
  if (Array.isArray(payload.events)) events = payload.events;
  if (Array.isArray(payload.tasks))  tasks  = payload.tasks;
  if (payload.map) {
    d2lMap = payload.map;
    try { localStorage.setItem('studyos_d2l', JSON.stringify(d2lMap)); } catch (e) {}
  }
  // Both of these call _sosFirebaseSave(); the 400 ms debounce in
  // firebase-sync.js coalesces them into a single document write.
  persistEvents();
  persistTasks_();
  try { renderCalendar(); }        catch (e) {}
  try { renderUpcoming(); }        catch (e) {}
  try { updateStats(); }           catch (e) {}
  try { renderExamCountdown(); }   catch (e) {}
  try { renderPriorityQueue(); }   catch (e) {}
  const curD2L = classes.find(c => c.id === currentClassId);
  if (curD2L) { try { renderClassEvents(curD2L); } catch (e) {} }
  try { scheduleNotifications(); } catch (e) {}
  // Tell taskmirror.js something moved, so imports reach TaskHub now rather
  // than waiting for an unrelated edit. The arguments are ignored — these are
  // "rebuild soon" triggers (js/taskmirror.js:50).
  try { window._vedaUpdateTask && window._vedaUpdateTask(); } catch (e) {}
  return true;
};

(function () {
  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    try { window.studyOsInit(); }
    catch (e) { console.error('StudyOS failed to start:', e); }
  }
  function whenGateOpen() {
    var gate = window.SOS_GATE;
    if (gate && typeof gate.then === 'function') gate.then(boot, function () { /* stays locked */ });
    else boot();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', whenGateOpen);
  else whenGateOpen();
})();
