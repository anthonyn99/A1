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
    task:     I('<path d="M9 11.5 11 13.5 15.5 9"/><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4"/><path d="M16 2v4"/>'),
    globe:    I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z"/>'),
    monitor:  I('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>'),
    play:     '<svg class="soi" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8z"/></svg>',
    plus:     I('<path d="M12 5v14"/><path d="M5 12h14"/>', 2),
    arrowR:   I('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>', 1.8),
    chevR:    I('<path d="m9 18 6-6-6-6"/>', 1.8),
    chevL:    I('<path d="m15 18-6-6 6-6"/>', 1.8),
    doc:      I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>'),
    sparkle:  I('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'),
    note:     I('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    cards:    I('<rect x="2.5" y="6" width="14" height="14" rx="2.5"/><path d="M7 3.5h11a2.5 2.5 0 0 1 2.5 2.5v11"/>'),
    info:     I('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/>'),
    bolt:     I('<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>'),
    plug:     I('<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0Z"/><path d="M12 17v5"/>'),
    star:     I('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>'),
    undo:     I('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    eye:      I('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
    flame:    I('<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.6 1.2 2.5 2 2.5-1-3 0-5.5 1-8Z"/>'),
    module:   I('<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>')
  };
})();

/* Toast icons by name. showNotif() also takes the emoji the feature modules
 * used to pass ('⚠️', '✅' …) and draws these instead, so no toast anywhere
 * shows an emoji (Tony, 2026-10-29). Each carries its pastel tone. */
var SOS_NOTIF = {
  alert: ['alert', '#F2C9A0'], check: ['check', '#A8DCC0'], info: ['info', '#A9CBEF'],
  cards: ['cards', '#F0B3CB'], calendar: ['calendar', '#C9B4D8'], bolt: ['bolt', '#F0B3CB'],
  plug: ['plug', '#F2C9A0'], file: ['doc', '#C9B4D8'], cloud: ['cloud', '#A9CBEF'],
  trash: ['trash', '#F2AFAF'], task: ['task', '#F0B3CB'], pencil: ['pencil', '#C9B4D8'],
  bell: ['bell', '#C9B4D8'], download: ['download', '#A9CBEF'], timer: ['flame', '#F0B3CB']
};
var SOS_EMOJI_NOTIF = {
  '⚠️': 'alert', '⚠': 'alert', '✅': 'check', 'ℹ️': 'info', '🃏': 'cards', '🗓️': 'calendar', '📅': 'calendar',
  '⚡': 'bolt', '🔌': 'plug', '📄': 'file', '☁️': 'cloud', '🗑️': 'trash'
};

/* Today as YYYY-MM-DD in HER time zone. toISOString() is UTC, so after about
 * 8pm in Georgia "today" became tomorrow: an exam due today dropped out of the
 * countdown and every new event defaulted to the wrong day. */
function sosLocalDate(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
window.sosLocalDate = sosLocalDate;

/* A1's drag (dragsort.js, window.A1Drag) on a list of cards or rows, the way
 * Everwell wires it: a mouse takes a card by any part that is not a control, a
 * finger holds it 300ms. No grip dots. Rows are matched by `row`; onDrop
 * reorders the backing array by index and the caller saves and redraws. */
function sosDragList(list, row, getArr, setArr, onDone, axis, ignore) {
  if (!list || !window.A1Drag) return;
  window.A1Drag.sort(list, {
    row: row, hold: 300, axis: axis || 'y', ignore: ignore || undefined,
    onDrop: function (from, to) {
      const next = getArr().slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      setArr(next);
      onDone && window.A1Drag.later(onDone);
    }
  });
}

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
  '#7c6fff':'#a99cf0','#ff6b6b':'#ef9f9f','#ff9f43':'#f0bd86','#ffd32a':'#dcc08a',
  '#0be881':'#8fd6ad','#00d2d3':'#8ccfcf','#54a0ff':'#9dc0ee','#f368e0':'#dea2d6',
  '#ff6b81':'#f0a2af','#48dbfb':'#9bd6ea','#1dd1a1':'#88d2ba','#c8d6e5':'#c2cdda',
  '#a29bfe':'#bbb4ef','#fd79a8':'#f0a8c2','#e17055':'#dd9f8b','#00b894':'#84ccb6',
  // Retired in the pastel sweep: the old harsh yellow, and the vibrant leftovers
  // that were still reachable on classes created before it.
  '#e6cd7c':'#dcc08a','#4ade80':'#8fd6ad','#22d3ee':'#9bd6ea','#e74c3c':'#dd8f84'
};
function sosPastel(c){ if(!c) return c; return SOS_PASTEL_MAP[String(c).toLowerCase()] || c; }
window.sosPastel = sosPastel;

/* Module-type badge text. The badge used to print type.toUpperCase().slice(0,3),
 * which rendered "notes" as the non-word "NOT". Spell the singular type out
 * instead; .module-btn-icon no longer uppercases it. */
var SOS_MODULE_LABELS = { documents:'Doc', prompts:'Prompt', notes:'Note' };
function sosModuleLabel(t) {
  return SOS_MODULE_LABELS[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Doc');
}
window.sosModuleLabel = sosModuleLabel;

window._sosRoot = null;
function _sosEl(id) {
  if (window._sosRoot) {
    var el = window._sosRoot.querySelector('#' + id);
    if (el) return el;
  }
  return document.getElementById(id);
}

const COLORS = [
  '#a99cf0','#ef9f9f','#f0bd86','#dcc08a','#8fd6ad',
  '#8ccfcf','#9dc0ee','#dea2d6','#f0a2af','#9bd6ea',
  '#88d2ba','#c2cdda','#bbb4ef','#f0a8c2','#dd9f8b','#84ccb6'
];
// Fallback tints, used only when an event/task has no class of its own — the
// calendar prefers the class color (see renderCalendar). No yellow anywhere.
const EVENT_COLORS = { exam:'#ef9f9f', hw:'#f0bd86', quiz:'#dea2d6', lecture:'#9dc0ee', lab:'#8fd6ad', other:'#c2cdda' };
const PRIORITY_COLORS = { low:'#9bd6ea', medium:'#f0bd86', high:'#ef9f9f' };

// Every local write goes through here. All A1 pages share this origin's 5 MB
// of localStorage and it fills up (Veda's Brave, 2026-09-30); a bare setItem
// then throws QuotaExceededError, and in persist() that throw came BEFORE
// _sosFirebaseSave() — so edits never reached the cloud, and a remote update
// died half-applied without re-rendering. The local copy is only a cold-start
// cache; Firestore holds the real state, so a failed local write is logged once
// and otherwise ignored.
// Id for new events, tasks and repeat series. Inside the old host page this
// came from TaskHub's global uid(); standalone, nothing defined it, so every
// call threw ReferenceError, including "Convert to task / to event"
// (2026-09-30). Same shape as the ids already stored (base-36 time + random),
// so TaskHub's mirror keys (sos_ev_<id>, sos_t_<id>) look the same as ever.
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

let _sosLsWarned = false;
function _sosLsSet(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch (e) {
    if (!_sosLsWarned) {
      _sosLsWarned = true;
      console.warn('[StudyOS] localStorage is full — local cache not updated (cloud sync unaffected):', key, e && e.name);
    }
    return false;
  }
}

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
function persistKsu() { _sosLsSet('studyos_ksu', JSON.stringify(_sosSerializeKsu())); _sosFirebaseSave(); _sosEmit('ksu'); }

// KSU files were never run through _sosSerializeClasses, so their PDFs rode
// along as base64 `dataUrl`s: ~580 KB of Veda's KSU bucket, re-uploaded with
// the whole dashboards/studyos document on EVERY edit anywhere in StudyOS and
// re-parsed on every snapshot — the lag — and 60% of the 1 MB document cap.
// Nothing reads `dataUrl` to open a file, either (sosResolveBlob wants a
// fileId or storageUrl), so those PDFs could not be opened at all.
// A dataUrl is dropped only once _sosMigrateKsuFiles has put the blob in
// IndexedDB and given the file a fileId; until then it is the only copy.
function _sosSerializeKsu() {
  return {
    ...ksuData,
    modules: (ksuData.modules || []).map(mod => ({
      ...mod,
      files: (mod.files || []).map(f => {
        const meta = {};
        for (const k in f) {
          if (k.charAt(0) === '_') continue;
          if (k === 'dataUrl' && f.fileId) continue;
          meta[k] = f[k];
        }
        return meta;
      })
    }))
  };
}

// Move KSU dataUrl files into IndexedDB. The fileId is derived from the bytes,
// not random: remote.ksu still carries the dataUrls until a save lands, and it
// replaces ksuData wholesale, so this re-runs after every remote apply. A
// content-derived id makes that idempotent (same blob, same key — no duplicate
// copies) and identical on every device, so _sosCloudUrls re-stamps the
// storageUrl the backfill uploads under that id.
async function _sosMigrateKsuFiles() {
  let changed = false;
  for (const mod of (ksuData.modules || [])) {
    for (const f of (mod.files || [])) {
      if (!f.dataUrl || f.fileId) continue;
      try {
        const comma = f.dataUrl.indexOf(',');
        const header = f.dataUrl.slice(0, comma), b64 = f.dataUrl.slice(comma + 1);
        const mime = (header.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
        let h = 0x811c9dc5;
        for (let i = 0; i < b64.length; i++) { h ^= b64.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        const id = 'sf_ksu_' + (h >>> 0).toString(36) + '_' + b64.length.toString(36);
        const bytes = atob(b64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        await SosFileStore.putById(id, new Blob([arr], { type: mime }), f.name);
        f.fileId = id;
        f.mime = f.mime || mime;
        delete f.dataUrl;
        changed = true;
      } catch (e) { console.warn('SOS migrate KSU file failed:', f.name, e); }
    }
  }
  if (changed) _sosLsSet('studyos_ksu', JSON.stringify(_sosSerializeKsu()));
  return changed;
}

function renderKsuModules() {
  const grid = _sosEl('ksu-modules-grid');
  if (!grid) return;
  grid.innerHTML = '';
  if (!ksuData.modules.length) {
    grid.innerHTML = '<div class="empty-state"><h3>No modules yet</h3><p>Add one for documents, parking, scholarships: anything that isn’t a class.</p></div>';
    return;
  }
  ksuData.modules.forEach(m => grid.appendChild(_sosModuleCard({ id: 'ksu', color: KSU_COLOR }, m)));
  sosDragList(grid, '.module-btn', () => ksuData.modules, (arr) => { ksuData.modules = arr; }, () => { persistKsu(); renderKsuModules(); }, 'grid');
}

/* One module card (a class's or KSU's). The whole card is the drag handle;
 * rename and remove are real buttons in its corner. */
const KSU_COLOR = '#C9B4D8';
function _sosModuleMeta(m) {
  return m.type === 'documents' ? ((m.files || []).length + ' file' + ((m.files || []).length !== 1 ? 's' : ''))
       : m.type === 'prompts' ? ((m.prompts || []).length + ' prompt' + ((m.prompts || []).length !== 1 ? 's' : ''))
       : 'Pages';   // its pages are a Notebook folder; m.notes is the old textarea copy
}
function _sosModuleIcon(type) {
  return type === 'prompts' ? SOI.sparkle : type === 'notes' ? SOI.note : SOI.doc;
}
function _sosModuleCard(cls, m) {
  const color = sosPastel(cls.color) || KSU_COLOR;
  const btn = document.createElement('div');
  btn.className = 'module-btn';
  btn.dataset.id = m.id;
  btn.tabIndex = 0;
  btn.style.setProperty('--card-color', color);
  btn.title = 'Open ' + (m.name || 'module') + ' · drag to reorder';
  btn.innerHTML = `
    <div class="module-btn-top">
      <div class="module-btn-icon">${_sosModuleIcon(m.type)}</div>
      <div class="module-btn-acts">
        <button class="icon-chip sm" title="Rename" aria-label="Rename" data-act="rename">${SOI.pencil}</button>
        <button class="icon-chip sm danger" title="Delete" aria-label="Delete" data-act="delete">${SOI.trash}</button>
      </div>
    </div>
    <div class="module-btn-name">${escHtml(m.name)}</div>
    <div class="module-btn-meta"><span class="module-kind">${sosModuleLabel(m.type)}</span><span>${_sosModuleMeta(m)}</span></div>
  `;
  btn.querySelector('[data-act="rename"]').onclick = (e) => { e.stopPropagation(); openRenameModule(cls.id, m.id); };
  btn.querySelector('[data-act="delete"]').onclick = (e) => { e.stopPropagation(); cls.id === 'ksu' ? deleteKsuModule(m.id) : deleteModule(cls.id, m.id); };
  btn.onclick = () => cls.id === 'ksu' ? openKsuModuleDetail(m) : openModuleDetail(classes.find(c => c.id === cls.id) || cls, m);
  btn.onkeydown = (e) => { if (e.key === 'Enter' && e.target === btn) btn.onclick(); };
  return btn;
}

async function deleteKsuModule(modId) {
  const mod = ksuData.modules.find(m => m.id === modId);
  if (!(await window.sosConfirmDelete('“' + (mod ? mod.name : 'this module') + '”', 'The module and everything in it are removed from every device.'))) return;
  ksuData.modules = ksuData.modules.filter(m => m.id !== modId);
  persistKsu();
  renderKsuModules();
  _sosDropFilesOf(mod ? [mod] : []);
}

function openKsuAddModule() {
  // set pending target to ksu, reuse modal flow
  _ksuAddPending = true;
  _sosOpen('modal-add-module');
}

function openKsuModuleDetail(mod) {
  // reuse existing module detail modal with a fake cls object
  const fakeCls = { id: 'ksu', color: KSU_COLOR, modules: ksuData.modules, _ksu: true,
    _persistFn: persistKsu };
  // patch persist to also save ksu
  _sosCurrentModuleClassId = 'ksu';
  _sosCurrentModuleId = mod.id;
  _sosParkSoRoot();
  _sosModuleHeader(fakeCls, mod);
  const body = _sosEl('module-detail-body');
  body.innerHTML = '';
  moduleEditMode[mod.id] = false;
  if (mod.type !== 'notes') body.appendChild(_sosModeToggle(mod, () => toggleKsuMode(mod.id)));
  const content = document.createElement('div');
  content.id = 'module-content-' + mod.id;
  body.appendChild(content);
  renderModuleContent(content, fakeCls, mod);
  _sosOpen('modal-module-detail');
}

/* The module popup's title row: type icon in the class's colour, the name. */
function _sosModuleHeader(cls, mod) {
  _sosEl('module-detail-title-text').textContent = mod.name;
  const modal = _sosEl('module-detail-modal');
  if (modal) modal.style.setProperty('--card-color', sosPastel(cls.color) || KSU_COLOR);
  const t = _sosEl('module-detail-type');
  if (t) t.innerHTML = _sosModuleIcon(mod.type);
}

/* View / Edit for a Documents or Prompts module: a two-part switch. Edit is
 * where rows are dragged, files uploaded and things removed. */
function _sosModeToggle(mod, onToggle) {
  const wrap = document.createElement('div');
  wrap.className = 'mode-toggle-wrap';
  wrap.id = 'mode-toggle-' + mod.id;
  const editOn = !!moduleEditMode[mod.id];
  wrap.innerHTML = `
    <button type="button" class="mode-seg m-view${editOn ? '' : ' active'}" data-m="view">${SOI.eye}<span>View</span></button>
    <button type="button" class="mode-seg m-edit${editOn ? ' active' : ''}" data-m="edit">${SOI.pencil}<span>Edit</span></button>`;
  wrap.querySelectorAll('.mode-seg').forEach(b => b.addEventListener('click', () => {
    if ((b.dataset.m === 'edit') !== !!moduleEditMode[mod.id]) onToggle();
  }));
  return wrap;
}
function _sosPaintModeToggle(modId) {
  const wrap = _sosEl('mode-toggle-' + modId);
  if (!wrap) return;
  const editOn = !!moduleEditMode[modId];
  wrap.querySelectorAll('.mode-seg').forEach(b => b.classList.toggle('active', (b.dataset.m === 'edit') === editOn));
}

function toggleKsuMode(modId) {
  moduleEditMode[modId] = !moduleEditMode[modId];
  _sosPaintModeToggle(modId);
  const mod = ksuData.modules.find(m => m.id === modId);
  const fakeCls = { id: 'ksu', color: KSU_COLOR, modules: ksuData.modules, _ksu: true };
  const content = _sosEl('module-content-' + modId);
  if (mod && content) { content.innerHTML = ''; renderModuleContent(content, fakeCls, mod); }
}

function findClassOrKsu(classId) {
  if (classId === 'ksu') return { id: 'ksu', color: KSU_COLOR, modules: ksuData.modules, _ksu: true };
  return classes.find(c => c.id === classId);
}
function persistForCls(cls) {
  if (cls && cls._ksu) persistKsu(); else persist();
}

/* ── Local-change notification (F-2) ───────────────────────────────────────
 * firebase-sync.js already publishes REMOTE changes as window CustomEvents
 * (fb-sos-remote / fb-sos-saved), and four modules listen to them. What had no
 * signal was a LOCAL edit: nothing fired when this tab changed its own data,
 * so a module could only learn about it by polling.
 *
 * Emitted from the persist* functions rather than from each call site: those
 * are the single chokepoint every mutation already funnels through, so this
 * cannot drift the way per-call-site notifications would. Same reasoning as
 * taskmirror.js's derived-not-incremental mirror.
 *
 * Fire-and-forget and individually try/caught — a throwing listener must never
 * break the save that triggered it. */
function _sosEmit(entity) {
  try {
    window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity } }));
  } catch (e) {}
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
  setTodayDate();
  scheduleNotifications();
  renderKsuModules();
  renderExamCountdown();
  renderPriorityQueue();
  setPomoMode(pomoMode);
  updatePomoDots();
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
  try { await _sosRetryCloudDeletes(); } catch (e) { console.warn('SOS cloud delete retry failed:', e); }
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
    el.textContent = 'Queued';
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
    if (text) text.textContent = _sosFmtBytes(used) + ' of ' + _sosFmtBytes(limit) + ' used';
    const pctEl = el.querySelector('.sos-storage-pct');
    if (pctEl) pctEl.textContent = (pct > 0 && pct < 1 ? '<1' : Math.round(pct)) + '%';
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
        // Removed while this was uploading: take the copy back out, record nothing.
        if (_sosCancelledUploads.has(fileId)) { SosCloud.remove(fileId, url); continue; }
        _sosCloudUrls.set(fileId, url);            // remember so syncs can't drop it
        uploaded++; strikes = 0;
      } catch (e) {
        if (e && e.cancelled) { SosCloud.remove(fileId); continue; }
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
  // innerHTML: some states carry an icon (SOI.check). Through textContent they
  // printed as raw "<svg …>" text in the sidebar.
  const setLabel = t => { if (label) label.innerHTML = t; };
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
  stamp({ id: 'ksu', color: KSU_COLOR, modules: ksuData.modules, _ksu: true }, ksuData.modules);
}

function setTodayDate() {
  const today = sosLocalDate();
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


/* ── Deep link: open straight to a class ───────────────────────────────────
 * studyos.html?class=<classId> lands on that class's detail view instead of
 * the dashboard. TaskHub's play button uses it so pressing play opens the
 * class's sites and apps AND the class itself (see index.html
 * _sosLaunchClass).
 *
 * Applied twice on purpose. Classes come from localStorage first and from
 * Firestore a moment later, and on a cold open — a device that has never run
 * StudyOS, or one whose cache was cleared — the local copy has no classes at
 * all, so the first attempt finds nothing. Re-running it when the cloud data
 * lands is what makes the link work there. _sosPendingClass is cleared on the
 * first success so a later sync can never yank the user out of whatever they
 * navigated to in the meantime.
 */
let _sosPendingClass = null;

function _sosReadClassParam() {
  try {
    var m = /[?&]class=([^&#]+)/.exec(location.search);
    return m ? decodeURIComponent(m[1]) : null;
  } catch (e) { return null; }
}

function _sosApplyClassParam() {
  if (!_sosPendingClass) return;
  // Only navigate once the class actually exists, or switchView would set a
  // title for a class openClassDetail then refuses to render.
  if (!classes.some(c => c && c.id === _sosPendingClass)) return;
  var id = _sosPendingClass;
  _sosPendingClass = null;
  try { switchView('class', id); } catch (e) {}
  // Drop the parameter once it has been honoured. Without this a reload — or
  // the PWA restoring this url — would drag the user back to this class every
  // time, and the back button would never leave it.
  try { history.replaceState({}, '', location.pathname + location.hash); } catch (e) {}
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
  // Quick Notes: the notes on their 'quick' folder; leaving sets them aside.
  if (view === 'notes' && window.SOSNotes) window.SOSNotes.show(_sosEl('sos-notes-host'), window.SOSNotes.QUICK);
  else if (activeView === 'notes' && window.SOSNotes) window.SOSNotes.hide(_sosEl('sos-notes-host'));
  activeView = view;
  const titles = { home:'Dashboard', calendar:'Calendar', notes:'Quick Notes', class:'Class', pomodoro:'Timer', ksu:'KSU', ai:'AI Settings', lesson:'Lesson' };
  if (view === 'ksu') renderKsuModules();
  // ES-module views, reached through window.SOS (this is a classic script).
  try {
    if (view === 'ai' && window.SOS && window.SOS.aiSettings) window.SOS.aiSettings.render();
    if (view !== 'lesson' && window.SOS && window.SOS.lessonUi) window.SOS.lessonUi.leave();
  } catch (e) { console.warn('view hook failed:', e); }
  _sosEl('topbar-title').textContent = titles[view] || 'StudyOS';
  if (view === 'class' && classId) openClassDetail(classId);
  if (view !== 'class') currentSidebarClass(null);
  if (view === 'calendar') renderCalendar();
  if (view === 'home') _sosPaintGreeting();
  if (view === 'pomodoro') _sosPaintPomoToday();
  // A new tab starts at its top.
  const v = _sosEl('view-' + view);
  if (v) v.scrollTop = 0;
  // Sync bottom nav active state
  var bnViews = ['home','calendar','notes','ksu','pomodoro','ai'];
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
  showNotif('check', 'Class created', sosClassName(cls) + ' is on your dashboard.');
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

// ===== CLASS RESOURCES =====
/* Websites and native apps attached to a class, launched together from a
 * TaskHub card (see js/taskmirror.js buildClasses + index.html
 * _sosLaunchClass). Stored on the class object itself: `resources` is not
 * underscore-prefixed, so _sosSerializeClasses() carries it through to both
 * localStorage and Firestore untouched, and because the two Firestore merge
 * sites (:fb-sos-remote and the initial load) both do `classes =
 * remote.classes` wholesale it syncs across devices with no merge-site edit.
 * That is only true for fields nested INSIDE a class — a new TOP-LEVEL field
 * would still need both sites updated (ARCHITECTURE.md section 8). */

// MUST stay byte-identical to index.html's _isLocalPath and shield.html's
// isLocalPath. A string one file treats as a local path and another treats as
// a URL either opens a dead tab or silently launches nothing.
function _sosIsLocalPath(u){
  return typeof u === 'string' && !/^https?:\/\//i.test(u) && (/^[A-Za-z]:[\\/]/.test(u) || /^\\\\/.test(u));
}

let editingResourceId = null;

/* The program chosen with Browse…, as {id, name}: the StudyOS bridge's opaque
 * app id, never a path. TaskHub's ▶ hands the id to the bridge on her PC,
 * which opens it the way the Start menu does -- so Store apps like the Claude
 * desktop app work too. Cleared when the target text stops being its name. */
let _sosPickedApp = null;

function _sosPickedFor(v) {
  return _sosPickedApp && v === _sosPickedApp.name ? _sosPickedApp : null;
}

/* Live feedback on how the single target input was classified. A radio the
 * user could set to disagree with the text they typed would be a bug source;
 * the classification is deterministic from the string, so just show it. */
function _sosResHint() {
  const el = _sosEl('res-kind-hint');
  if (!el) return;
  const v = (_sosEl('inp-res-target').value || '').trim();
  if (!_sosPickedFor(v)) _sosPickedApp = null;
  if (!v) { el.textContent = ''; return; }
  if (_sosPickedApp) {
    el.textContent = 'Program on your PC — the play button in TaskHub opens it through the StudyOS bridge.';
    el.style.color = 'var(--text3)';
  } else if (_sosIsLocalPath(v)) {
    el.textContent = 'A typed path cannot be opened. Use Browse… to pick the program.';
    el.style.color = '#ef9f9f';
  } else if (/^https?:\/\//i.test(v)) {
    el.textContent = 'Website — opens in a browser tab anywhere.';
    el.style.color = 'var(--text3)';
  } else {
    el.textContent = 'Not recognised. Use a full https:// URL, or Browse… for a program.';
    el.style.color = '#ef9f9f';
  }
}

function renderClassResources(cls) {
  const list = _sosEl('class-resources-list');
  if (!list) return;
  list.innerHTML = '';
  const res = cls.resources || [];
  if (res.length === 0) {
    list.innerHTML = '<div class="class-events-empty">No linked resources yet.<br>Add the sites and apps this class uses.</div>';
    return;
  }
  res.forEach(r => {
    const item = document.createElement('div');
    item.className = 'class-event-item static';
    // An app saved before Browse used the bridge has only a path; TaskHub
    // matches it by label, which can miss, so ask for a re-pick.
    const legacyApp = r.kind === 'app' && !r.appId;
    const target = r.kind === 'app'
      ? (legacyApp ? 'Pick again with Browse\u2026 so it opens reliably' : 'Program on your PC' + (r.appName && r.appName !== r.label ? ' \u00b7 ' + r.appName : ''))
      : (r.url || '');
    const shown = r.kind === 'app' ? target : target.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
    const icon = r.kind === 'app' ? SOI.monitor : SOI.globe;
    item.style.setProperty('--c', sosPastel(cls.color) || KSU_COLOR);
    item.innerHTML = `
      <div class="ce-ic">${icon}</div>
      <div style="min-width:0">
        <div class="class-event-name">${escHtml(r.label)}</div>
        <div class="class-event-meta${legacyApp ? ' warn' : ''}" title="${escHtml(target).replace(/"/g, '&quot;')}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(shown)}</div>
      </div>
      <div class="ce-acts">
        <button class="icon-chip sm" title="Edit" aria-label="Edit" onclick="openEditResource('${r.id}')">${SOI.pencil}</button>
        <button class="icon-chip sm danger" title="Delete" aria-label="Delete" onclick="deleteResource('${r.id}')">${SOI.trash}</button>
      </div>
    `;
    list.appendChild(item);
  });
}

function openAddResource() {
  if (!currentClassId) return;
  editingResourceId = null;
  _sosEl('resource-modal-title').textContent = 'Add Resource';
  _sosEl('inp-res-label').value = '';
  _sosEl('inp-res-target').value = '';
  _sosPickedApp = null;
  _sosResHint();
  _sosOpen('modal-resource');
}

function openEditResource(id) {
  const cls = classes.find(c => c.id === currentClassId);
  if (!cls) return;
  const r = (cls.resources || []).find(r => r.id === id);
  if (!r) return;
  editingResourceId = id;
  _sosEl('resource-modal-title').textContent = 'Edit Resource';
  _sosEl('inp-res-label').value = r.label || '';
  if (r.kind === 'app' && r.appId) {
    _sosPickedApp = { id: r.appId, name: r.appName || r.label };
    _sosEl('inp-res-target').value = _sosPickedApp.name;
  } else {
    _sosPickedApp = null;
    _sosEl('inp-res-target').value = (r.kind === 'app' ? r.path : r.url) || '';
  }
  _sosResHint();
  _sosOpen('modal-resource');
}

/* ── BROWSE PROGRAMS ───────────────────────────────────────────────────────
 * Picks a program for the class from her PC's app list.
 *
 * Why this is not a native file dialog: StudyOS is a web page, and a browser
 * has no API to enumerate installed programs. <input type="file"> reports
 * "C:\fakepath\matlab.exe" by design. The list comes from the StudyOS bridge
 * on her PC, which reads the Start menu (Microsoft Store apps included); her
 * TaskHub publishes its names and opaque ids to dashboards/veda_pc_apps
 * (index.html _vdBridgeProbe), and this reads that doc (firebase-sync
 * _fbLoadPcApps). Only her PC's list, never Tony's, and never a path.
 *
 * Shield is NOT used (Veda's call, 2026-10-20). Its picker listed only apps
 * with a shortcut, so "Claude" was the Claude Code CLI, which opens a terminal.
 */

// Cached for the session. The inventory changes when software is installed,
// so re-fetching on every open would spend a Firestore read to be told the
// same thing; a page reload is a fine granularity for "I just installed
// something".
let _sosBrowseApps = null;

async function openResourceBrowse() {
  const listEl = _sosEl('res-browse-list');
  const search = _sosEl('inp-res-browse-search');
  if (search) search.value = '';
  if (listEl) listEl.innerHTML = '<div class="empty-note">Loading programs…</div>';
  _sosOpen('modal-res-browse');

  if (!_sosBrowseApps || !_sosBrowseApps.length) {
    let apps = null;
    try {
      if (window._fbLoadPcApps) apps = await window._fbLoadPcApps();
    } catch (e) { apps = null; }
    _sosBrowseApps = (apps || [])
      .filter(function (a) { return a && typeof a.id === 'string' && /^[0-9a-f]{6,40}$/.test(a.id) && a.name; })
      .map(function (a) { return { id: a.id, name: String(a.name) }; })
      .sort(function (x, y) { return x.name.toLowerCase() < y.name.toLowerCase() ? -1 : 1; });
  }
  _sosRenderBrowseList();
  if (search) try { search.focus(); } catch (e) {}
}

function _sosRenderBrowseList() {
  const listEl = _sosEl('res-browse-list');
  if (!listEl) return;
  const apps = _sosBrowseApps || [];

  if (!apps.length) {
    // Empty means her TaskHub has not yet reached the bridge on her PC, not
    // "no programs" -- say which, or the button looks broken.
    listEl.innerHTML =
      '<div class="empty-note" style="text-align:left">' +
      'No programs available yet.<br>' +
      'This list comes from the <strong>StudyOS Bridge</strong> on your PC. Open TaskHub on your PC ' +
      'once while the bridge is running, then try Browse… again.' +
      '</div>';
    return;
  }

  const q = ((_sosEl('inp-res-browse-search') || {}).value || '').trim().toLowerCase();
  const shown = q
    ? apps.filter(function (a) { return a.name.toLowerCase().indexOf(q) >= 0; })
    : apps;

  if (!shown.length) {
    listEl.innerHTML = '<div class="empty-note">No program matches that.</div>';
    return;
  }

  listEl.innerHTML = '';
  shown.forEach(function (a) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'browse-row';
    row.innerHTML = SOI.monitor + '<span>' + escHtml(String(a.name)) + '</span>';
    row.onclick = function () { _sosPickBrowseApp(a); };
    listEl.appendChild(row);
  });
}

function _sosPickBrowseApp(a) {
  _sosPickedApp = { id: a.id, name: a.name };
  const target = _sosEl('inp-res-target');
  if (target) target.value = a.name;
  // Only fill the label when it is still blank: someone who typed "Simulink"
  // and then browsed for the exe meant to keep their own name for it.
  const label = _sosEl('inp-res-label');
  if (label && !label.value.trim()) label.value = a.name;
  _sosResHint();
  _sosClose('modal-res-browse');
}

function saveResource() {
  const cls = classes.find(c => c.id === currentClassId);
  if (!cls) return;
  const label  = _sosEl('inp-res-label').value.trim();
  const target = _sosEl('inp-res-target').value.trim();
  if (!label)  { alert('Label required.'); return; }
  if (!target) { alert('Website URL required, or pick a program with Browse….'); return; }
  const picked = _sosPickedFor(target);
  // A typed path is refused: the bridge opens only programs from its own list.
  if (!picked && _sosIsLocalPath(target)) {
    alert('A typed path cannot be opened. Use Browse… to pick the program.');
    return;
  }
  // A bare "google.com" would ship a button that does nothing.
  if (!picked && !/^https?:\/\//i.test(target)) {
    alert('Enter a full website URL starting with http:// or https://, or pick a program with Browse….');
    return;
  }
  // Drop every key of the other kind, or an app->web edit leaves a stale
  // app id (or an old path) behind.
  const fill = (r) => {
    r.label = label;
    r.kind = picked ? 'app' : 'web';
    delete r.path; delete r.url; delete r.appId; delete r.appName;
    if (picked) { r.appId = picked.id; r.appName = picked.name; }
    else r.url = target;
  };
  cls.resources = cls.resources || [];
  if (editingResourceId) {
    const r = cls.resources.find(r => r.id === editingResourceId);
    if (!r) return;
    fill(r);
  } else {
    const r = { id: 'r' + Date.now().toString(36) };
    fill(r);
    cls.resources.push(r);
  }
  persist();
  // persist() writes localStorage + Firestore but never touches the task
  // mirror, which is driven by the legacy globals. Without this the change
  // would not reach TaskHub until some unrelated task changed.
  if (window._vedaUpdateTask) window._vedaUpdateTask();
  _sosClose('modal-resource');
  renderClassResources(cls);
}

async function deleteResource(id) {
  const cls = classes.find(c => c.id === currentClassId);
  if (!cls) return;
  const r = (cls.resources || []).find(x => x.id === id);
  if (!(await window.sosConfirmDelete('“' + (r ? r.label : 'this resource') + '”', 'It no longer opens from this class or from TaskHub.'))) return;
  cls.resources = (cls.resources || []).filter(r => r.id !== id);
  persist();
  if (window._vedaUpdateTask) window._vedaUpdateTask();
  renderClassResources(cls);
}

async function deleteCurrentClass() {
  if (!currentClassId) return;
  const cls = classes.find(c => c.id === currentClassId);
  if (!(await window.uiConfirm('Every module, document and prompt in it is removed from every device.', { title: 'Remove “' + (cls ? sosClassName(cls) : 'this class') + '”?', danger: true, okLabel: 'Remove class' }))) return;
  classes = classes.filter(c => c.id !== currentClassId);
  persist();
  _sosDropFilesOf(cls ? cls.modules : []);
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
  const today = sosLocalDate();
  const wk = new Date(); wk.setDate(wk.getDate() + 7);
  const weekEnd = sosLocalDate(wk);
  classes.forEach(cls => {
    const card = document.createElement('div');
    card.className = 'class-card';
    card.style.setProperty('--card-color', sosPastel(cls.color));
    card.onclick = () => switchView('class', cls.id);
    card.tabIndex = 0;
    card.onkeydown = (e) => { if (e.key === 'Enter') card.onclick(); };
    const name = sosClassName(cls);
    // At most four module chips, then "+N more": a class with fifteen modules
    // reads as tidily as one with two.
    const mods = cls.modules || [];
    const SHOW = 4;
    const chips = mods.slice(0, SHOW).map(m => `<span class="module-chip" title="${escHtml(m.name).replace(/"/g, '&quot;')}">${escHtml(m.name)}</span>`).join('')
      + (mods.length > SHOW ? `<span class="module-chip more">+${mods.length - SHOW} more</span>` : '')
      + (mods.length === 0 ? '<span class="module-chip none">No modules yet</span>' : '');
    const files = mods.reduce((n, m) => n + ((m.files || []).length), 0);
    const due = events.filter(e => e.classId === cls.id && e.date >= today && e.date <= weekEnd).length
              + tasks.filter(t => t.classId === cls.id && !t.done && t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd).length;
    card.innerHTML = `
      <div class="class-card-top">
        <div class="class-mono">${escHtml((name.trim()[0] || '?').toUpperCase())}</div>
        <div class="class-head">
          <div class="class-name">${escHtml(name)}</div>
          <div class="class-code">${[cls.code, cls.instructor].filter(Boolean).map(escHtml).join(' · ') || '&nbsp;'}</div>
        </div>
        <span class="class-go">${SOI.chevR}</span>
      </div>
      <div class="class-modules">${chips}</div>
      <div class="class-foot">
        <span>${SOI.module}${mods.length} module${mods.length === 1 ? '' : 's'}</span>
        <span>${SOI.doc}${files} file${files === 1 ? '' : 's'}</span>
        ${due ? `<span class="due">${SOI.calendar}${due} this week</span>` : ''}
      </div>
    `;
    grid.appendChild(card);
  });
  _sosEl('class-count').textContent = classes.length;
  // Drag to reorder (Tony, 2026-10-29), as Everwell's cards: the order is the
  // classes array itself, so the sidebar and every class list follow it.
  sosDragList(grid, '.class-card', () => classes, (arr) => { classes = arr; }, () => { persist(); renderClasses(); renderSidebarClasses(); }, 'grid');
}

/* A class's name for display. Some names arrived from an import still
 * HTML-escaped ("Computer Organization &amp"), which drew as "& amp". */
function sosClassName(cls) {
  const raw = String((cls && cls.name) || '');
  const t = raw.replace(/&amp;?/gi, '&').replace(/&lt;?/gi, '<').replace(/&gt;?/gi, '>').replace(/&quot;?/gi, '"').replace(/&#0?39;?/g, "'");
  return t.replace(/\s*&\s*$/, '').trim() || raw;
}
window.sosClassName = sosClassName;

async function removeClass(id) {
  const cls = classes.find(c => c.id === id);
  if (!(await window.uiConfirm('Every module, document and prompt in it is removed from every device.', { title: 'Remove “' + (cls ? sosClassName(cls) : 'this class') + '”?', danger: true, okLabel: 'Remove class' }))) return;
  classes = classes.filter(c => c.id !== id);
  persist();
  _sosDropFilesOf(cls ? cls.modules : []);
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
    item.className = 'nav-item nav-class';
    item.dataset.cls = cls.id;
    item.onclick = () => switchView('class', cls.id);
    const name = sosClassName(cls);
    item.title = name;
    const dot = document.createElement('span');
    dot.className = 'nav-dot';
    dot.style.setProperty('--c', sosPastel(cls.color));
    dot.textContent = (name.trim()[0] || '?').toUpperCase();
    // textContent, not innerHTML: names are stored raw.
    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = name;
    item.appendChild(dot); item.appendChild(label);
    if (activeView === 'class' && cls.id === currentClassId) item.classList.add('active');
    el.appendChild(item);
  });
}

/* Light the open class in the sidebar (null: none). */
function currentSidebarClass(id) {
  document.querySelectorAll('#sidebar-classes .nav-class').forEach(n => n.classList.toggle('active', !!id && n.dataset.cls === id));
}

// ===== CLASS DETAIL =====
function openClassDetail(id) {
  const cls = classes.find(c => c.id === id);
  if (!cls) return;
  currentClassId = id;
  const name = sosClassName(cls);
  _sosEl('detail-title').textContent = name;
  _sosEl('detail-subtitle').textContent = [cls.code, cls.instructor].filter(Boolean).join(' · ');
  _sosEl('detail-color-bar').style.setProperty('--card-color', sosPastel(cls.color));
  const tt = _sosEl('topbar-title');
  if (tt && activeView === 'class') tt.textContent = name;
  currentSidebarClass(id);
  renderModules(cls);
  renderClassEvents(cls);
  renderClassResources(cls);
  // The class's flashcards (deck tree, exam banner) — an ES module, so a hook.
  if (window.sosDecorateClass) {
    try { window.sosDecorateClass(cls); } catch (e) { console.warn('[StudyOS] cards section failed:', e); }
  }
  try { sosSyncStickyHeader(); } catch (e) {}
}

function renderClassEvents(cls) {
  const list = _sosEl('class-events-list');
  list.innerHTML = '';
  const todayStr = sosLocalDate();

  // Build a mixed array of events and tasks, each tagged with kind + sort date
  const items = [];

  events
    .filter(e => e.classId === cls.id && e.date >= todayStr)
    .forEach(e => items.push({ kind: 'event', date: e.date, data: e }));

  tasks
    .filter(t => t.classId === cls.id && (!t.dueDate || t.dueDate >= todayStr))
    .forEach(t => items.push({ kind: 'task', date: t.dueDate || todayStr, data: t }));

  if (items.length === 0) {
    list.innerHTML = '<div class="class-events-empty">Nothing coming up.<br>Add an event or a task for this class.</div>';
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

  const when = (d, t) => _sosRelDay(d) + (t ? ' · ' + _sosFmtTime(t) : '');
  items.forEach(({ kind, data }) => {
    const item = document.createElement('div');
    item.className = 'class-event-item';

    if (kind === 'event') {
      const ev = data;
      const color = EVENT_COLORS[ev.type] || '#C9B4D8';
      item.title = 'Edit event';
      item.onclick = () => openAddEvent(ev);
      item.innerHTML = `
        <div class="class-event-dot" style="background:${color}"></div>
        <div style="min-width:0">
          <div class="class-event-name">${escHtml(ev.name)}</div>
          <div class="class-event-meta">${when(ev.date, ev.time)} · ${escHtml(_sosTypeLabel(ev.type))}</div>
        </div>
        <div class="ce-acts">
          <button class="mini-act" title="Turn this event into a task" onclick="event.stopPropagation();convertEventToTask('${ev.id}')">${SOI.arrowR}<span>Task</span></button>
        </div>
      `;
    } else {
      const t = data;
      const pColor = PRIORITY_COLORS[t.priority] || '#C9B4D8';
      item.title = 'Edit task';
      item.onclick = () => openEditTask(t.id);
      item.style.setProperty('--c', pColor);
      item.innerHTML = `
        <button class="ce-check${t.done ? ' on' : ''}" title="${t.done ? 'Mark not done' : 'Mark done'}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}" onclick="event.stopPropagation();toggleTaskDone('${t.id}')">${t.done ? SOI.checkBold : ''}</button>
        <div style="min-width:0">
          <div class="class-event-name${t.done ? ' done' : ''}">${escHtml(t.name)}</div>
          ${t.dueDate ? `<div class="class-event-meta">${when(t.dueDate, t.dueTime)} · ${escHtml(_sosTypeLabel(t.type || 'task'))}</div>` : (t.notes ? `<div class="class-event-meta">${escHtml(t.notes.slice(0,60))}${t.notes.length>60?'…':''}</div>` : '')}
        </div>
        <div class="ce-acts">
          <button class="mini-act" title="Turn this task into an event" onclick="event.stopPropagation();convertTaskToEvent('${t.id}')">${SOI.arrowR}<span>Event</span></button>
        </div>
      `;
    }

    list.appendChild(item);
  });
}

/* "Today", "Tomorrow", a weekday this week, or "Nov 12" for a YYYY-MM-DD date. */
function _sosRelDay(d) {
  const today = sosLocalDate();
  const t = new Date(); t.setDate(t.getDate() + 1);
  if (d === today) return 'Today';
  if (d === sosLocalDate(t)) return 'Tomorrow';
  const days = Math.round((new Date(d + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000);
  if (days > 1 && days < 7) return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
  return formatDate(d);
}
/* "14:30" → "2:30 PM". */
function _sosFmtTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  if (!m) return t || '';
  const h = +m[1];
  return (h % 12 || 12) + ':' + m[2] + ' ' + (h >= 12 ? 'PM' : 'AM');
}
const _SOS_TYPE_LABELS = { exam: 'Exam', hw: 'Homework', quiz: 'Quiz', lecture: 'Lecture', lab: 'Lab', other: 'Other', task: 'Task' };
function _sosTypeLabel(t) { return _SOS_TYPE_LABELS[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : ''); }

function openAddEventForClass() {
  populateEventClassSelect();
  editingEventId = null;
  document.querySelector('#modal-add-event .modal-title').textContent = 'Add Event';
  setTodayDate();
  _sosEl('inp-event-name').value = '';
  _sosEl('inp-event-time').value = '';
  _sosEl('inp-event-class').value = currentClassId || '';
  _sosEl('inp-event-type').value = 'hw';
  // A new event starts clean: the weight and repeat of the last one edited
  // used to carry over into it.
  _sosEl('inp-event-weight').value = '';
  { const _nd=_sosEl('inp-event-notif-date'); if(_nd)_nd.value=''; const _nt=_sosEl('inp-event-notif-time'); if(_nt)_nt.value=''; }
  _sosEl('btn-delete-event').style.display = 'none';
  _sosResetRepeatUI(null);
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
    grid.appendChild(_sosModuleCard(cls, m));
  });
  if (!cls.modules.length) {
    grid.innerHTML = '<div class="empty-state"><h3>No modules yet</h3><p>Add one for lecture slides, notes or AI prompts.</p></div>';
    return;
  }
  sosDragList(grid, '.module-btn', () => cls.modules, (arr) => { cls.modules = arr; }, () => { persistForCls(cls); renderModules(cls); renderClasses(); }, 'grid');
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
    icon: ICONS[pendingModuleType] || 'doc',
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
  if (!(await window.sosConfirmDelete('“' + (mod ? mod.name : 'this module') + '”', 'The module and everything in it are removed from every device.'))) return;
  // findClassOrKsu('ksu') returns a stand-in object: reassigning ITS modules
  // would leave ksuData untouched and persist() would save nothing. Route the
  // KSU bucket to its own store.
  if (cls._ksu) {
    ksuData.modules = ksuData.modules.filter(m => m.id !== modId);
    persistKsu();
    renderKsuModules();
    _sosDropFilesOf(mod ? [mod] : []);
    return;
  }
  cls.modules = cls.modules.filter(m => m.id !== modId);
  persist();
  renderModules(cls);
  renderClasses();
  updateStats();
  _sosDropFilesOf(mod ? [mod] : []);
}

const moduleEditMode = {};
let _sosCurrentModuleClassId = null;
let _sosCurrentModuleId = null;

// The notes (V's Notebook) live in the module modal only while a Notes module
// is open. openModuleDetail/openKsuModuleDetail wipe #module-detail-body, so
// the notes are set aside first (Notebook.detach, via SOSNotes.hide): wiped
// with the body they could not come back.
function _sosParkSoRoot() { _sosLeaveNotesModule(); }

function openModuleDetail(cls, mod) {
  _sosCurrentModuleClassId = cls.id;
  _sosCurrentModuleId = mod.id;
  _sosParkSoRoot();
  _sosModuleHeader(cls, mod);
  const body = _sosEl('module-detail-body');
  body.innerHTML = '';

  // Always default to view mode when opening
  moduleEditMode[mod.id] = false;

  // Notes modules use Notebook's own editing — the View / Edit switch is for
  // Documents and Prompts only.
  if (mod.type !== 'notes') body.appendChild(_sosModeToggle(mod, () => toggleModuleMode(cls.id, mod.id)));

  const content = document.createElement('div');
  content.id = 'module-content-' + mod.id;
  body.appendChild(content);

  renderModuleContent(content, cls, mod);
  _sosOpen('modal-module-detail');
}

function toggleModuleMode(classId, modId) {
  moduleEditMode[modId] = !moduleEditMode[modId];
  _sosPaintModeToggle(modId);
  const cls = findClassOrKsu(classId);
  const mod = cls && cls.modules.find(m => m.id === modId);
  const content = _sosEl('module-content-' + modId);
  if (cls && mod && content) { content.innerHTML = ''; renderModuleContent(content, cls, mod); }
}

function renderModuleContent(container, cls, mod) {
  if (mod.type === 'documents') renderDocumentsModule(container, cls, mod);
  else if (mod.type === 'prompts') renderPromptsModule(container, cls, mod);
  else if (mod.type === 'notes') renderNotesModule(container, cls, mod);
}

// Saves and sets aside the notes (if a Notes module is open) before closing
// the shared module-detail modal.
function closeModuleDetail() {
  _sosLeaveNotesModule();
  _sosClose('modal-module-detail');
}

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
      <span class="uz-ic">${SOI.download.replace('M12 3v12', 'M12 15V3').replace('m7 10 5 5 5-5', 'm7 8 5-5 5 5')}</span>
      <b>Drop files here, or click to choose</b>
      <small>Any file type · saved on this device and synced to the cloud</small>
      <input type="file" multiple id="file-input-${mod.id}" onchange="handleFileUpload(event,'${cls.id}','${mod.id}')">
    `;
    zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => { zone.classList.remove('over'); };
    zone.ondrop = e => {
      e.preventDefault();
      // Keep the global window drop handler out: this zone already knows the
      // destination, so it files directly. Without this the same files would
      // ALSO be ingested via the picker and land twice.
      e.stopPropagation();
      zone.classList.remove('over');
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
    // Every stored id, without reading any file's bytes (for the self-cleanup).
    keys: async function() {
      return withDb(db => new Promise((res, rej) => {
        let tx;
        try { tx = db.transaction(ST, 'readonly'); } catch (e) { rej(e); return; }
        const req = tx.objectStore(ST).getAllKeys();
        req.onsuccess = e => res(e.target.result || []);
        req.onerror = e => rej((e.target && e.target.error) || new Error('read failed'));
      }));
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
    _sosLsSet('studyos_classes', JSON.stringify(_sosSerializeClasses()));
  }
  await _sosMigrateKsuFiles();
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

/* ── Cloud deletes that actually free the space ────────────────────────────
 * Three ways a removed file used to keep its cloud storage (Veda's removed
 * video, 2026-09-30):
 *   1. Removed WHILE uploading: the delete ran first and the loop kept sending
 *      parts, then the manifest. _sosCancelledUploads now stops the loop, and
 *      the caller deletes whatever part was already in flight.
 *   2. Sent to the wrong Worker: files uploaded under an older config live on
 *      another studyos-files Worker (their storageUrl says which). remove()
 *      now deletes on that Worker as well as the configured one.
 *   3. Fire-and-forget: a failed DELETE was swallowed. It now waits in
 *      studyos_cloud_deletes and _sosRunSyncPass retries it.
 * The Worker side (a delete finds parts by key prefix even with no manifest)
 * is in workers/studyos-files/worker.js. */
const _sosCancelledUploads = new Set();
const SOS_PENDING_DELETES = 'studyos_cloud_deletes';
function _sosCloudBaseFor(url) {
  try { const u = new URL(url); if (/^studyos-files\./.test(u.hostname)) return u.origin; } catch (_) {}
  return null;
}
function _sosPendingDeletes() {
  try { const v = JSON.parse(localStorage.getItem(SOS_PENDING_DELETES) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}
function _sosSetPendingDeletes(list) { _sosLsSet(SOS_PENDING_DELETES, JSON.stringify(list.slice(-200))); }
function _sosUploadCancelled(fileId) {
  if (!_sosCancelledUploads.has(fileId)) return false;
  const e = new Error('upload-cancelled'); e.cancelled = true; e.retryable = false;
  throw e;
}
async function _sosRetryCloudDeletes() {
  const list = _sosPendingDeletes();
  if (!list.length) return;
  for (const d of list) { if (d && d.id) await SosCloud.remove(d.id, d.url, true); }
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

    _sosUploadCancelled(fileId);
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
      _sosUploadCancelled(fileId);
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
    _sosUploadCancelled(fileId);
    await _sosPut(
      SOS_CLOUD_BASE + '/m/' + encodeURIComponent(fileId),
      JSON.stringify({ parts, size: file.size, type: file.type || 'application/octet-stream', name: file.name || 'document' }),
      { 'Content-Type': 'application/json' }
    );
    report(1);
    return u;
  },
  // Delete a file's cloud copy (see "Cloud deletes that actually free the
  // space" above). Returns true once every Worker that may hold it said OK.
  async remove(fileId, storageUrl, fromQueue) {
    if (!fileId) return false;
    _sosCancelledUploads.add(fileId);
    const bases = [];
    const own = _sosCloudBaseFor(storageUrl);
    if (own) bases.push(own);
    if (SOS_CLOUD_BASE && bases.indexOf(SOS_CLOUD_BASE) < 0) bases.push(SOS_CLOUD_BASE);
    if (!bases.length) return false;
    let ok = true;
    for (const b of bases) {
      try {
        const r = await fetch(b + '/f/' + encodeURIComponent(fileId), { method: 'DELETE' });
        if (!r.ok) ok = false;
      } catch (_) { ok = false; }
    }
    const rest = _sosPendingDeletes().filter(d => d && d.id !== fileId);
    if (!ok) rest.push({ id: fileId, url: storageUrl || null, at: Date.now() });
    if (!ok || fromQueue || rest.length !== _sosPendingDeletes().length) _sosSetPendingDeletes(rest);
    return ok;
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

// Put a file on the system clipboard so it can be pasted into ANOTHER web app
// (Gemini, NotebookLM, ChatGPT, Slack…). This is the only path that actually
// crosses origins: a drag from one web page to another cannot carry a file,
// because a script-created File is never serialised outside its own browsing
// context — the target's dropzone lights up on dragover (it sees a file-kind
// item) and then reads an empty dataTransfer.files on drop. See _sosDragOutHint.
// navigator.clipboard.write() only accepts a small set of MIME types; anything
// else has to fall back to Save (a real on-disk file the user can then drag).
async function sosCopyFileToClipboard(f) {
  const blob = await sosResolveBlob(f);
  if (!blob) return false;
  if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') return false;
  const mime = f.mime || blob.type || 'application/octet-stream';
  try {
    // Must be constructed with the blob's real type; a mismatch throws.
    const typed = blob.type === mime ? blob : new Blob([blob], { type: mime });
    await navigator.clipboard.write([new ClipboardItem({ [mime]: typed })]);
    return true;
  } catch (_) {
    return false;
  }
}

// Explain, once per session, why a drag into another browser tab did nothing —
// and offer the two routes that do work. Fired from dragend when the drag was
// not consumed (dropEffect 'none'), which is exactly the failed-cross-page case.
let _sosDragHintShown = false;
function _sosDragOutHint() {
  // The desktop shell drags natively, so a refused drop there means the target
  // declined a perfectly good file — not the cross-origin limitation below.
  if (SOS_NATIVE_DRAG) return;
  if (_sosDragHintShown) return;
  _sosDragHintShown = true;
  showNotif(SOI.clip, 'Nothing accepted that drop',
    'A browser can’t hand a file from one web page to another — Gemini and NotebookLM will highlight the box but receive nothing. Use the paperclip button on the file — it copies images to the clipboard to paste with Ctrl+V, and downloads anything else so you can drag it in from your Downloads folder.');
}

/* ═══════════ Native file drag-out (desktop shell only) ═══════════
   In a browser this is impossible: a File built in script is not serialised
   across browsing contexts, so dragging onto Gemini/NotebookLM highlights
   their dropzone and delivers nothing. The Tauri shell (V1/StudyOS/desktop)
   fixes it properly — it stages the bytes to a real file and asks the OS to
   start a real drag, which every app accepts because it is indistinguishable
   from dragging out of Explorer.

   Feature-detected: in a plain browser SOS_NATIVE_DRAG is false and every
   path below is skipped, leaving the existing HTML5 drag + Copy button. */
const SOS_NATIVE_DRAG = !!(typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.drag);

function _sosInvoke(cmd, args) {
  const t = window.__TAURI__;
  const invoke = (t && t.core && t.core.invoke) || (t && t.invoke);
  if (!invoke) return Promise.reject(new Error('no invoke bridge'));
  return invoke(cmd, args);
}

// Blob -> base64, in chunks. The JSON bridge can't carry raw bytes, and
// String.fromCharCode(...bytes) blows the argument limit on a big PDF.
async function _sosBlobToB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Write the file into the shell's staging directory and return its real path.
// Cached per file id: staging the same bytes twice is wasted work, and hover
// fires constantly.
const _sosStagedPaths = new Map();
async function sosStageForDrag(f) {
  const key = f.fileId || f.id;
  if (!key) return null;
  if (_sosStagedPaths.has(key)) return _sosStagedPaths.get(key);
  const p = (async () => {
    const blob = await sosResolveBlob(f);
    if (!blob) return null;
    const res = await _sosInvoke('stage_drag_file', {
      id: String(key),
      name: f.name || 'file',
      bytesB64: await _sosBlobToB64(blob),
    });
    return (res && res.path) || null;
  })().catch(err => {
    // Drop the rejected promise so a transient failure can be retried on the
    // next hover instead of being cached forever.
    _sosStagedPaths.delete(key);
    console.warn('SOS drag staging failed:', err);
    return null;
  });
  _sosStagedPaths.set(key, p);
  return p;
}

// A 1x1 transparent PNG. The plugin REQUIRES a drag image; the OS supplies its
// own file-drag cursor on Windows, so an invisible one keeps it from drawing a
// second, stray thumbnail next to it.
const _SOS_DRAG_PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Start the real OS drag. Called from a pointer gesture, NOT from dragstart:
// once the native drag begins the OS owns the pointer, so the HTML5 drag must
// never have started in the first place.
function sosStartNativeDrag(path) {
  return window.__TAURI__.drag.startDrag({ item: [path], icon: _SOS_DRAG_PX, mode: 'copy' });
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
    // Removed in the moment the last request was finishing: undo, record nothing.
    if (_sosCancelledUploads.has(fileId)) {
      delete meta._uploading; delete meta._progress;
      SosCloud.remove(fileId, url);
      return;
    }
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
    // Removed while uploading: the loop has stopped, so this delete also takes
    // the part that was already in flight when the file was removed.
    if (e && e.cancelled) { SosCloud.remove(fileId, meta.storageUrl); return; }
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

/* A labelled row action (Slides, Break down): text, not a lone glyph, so what
 * it does is obvious without hovering. Shared with breakdown-ui via window. */
function _sosRowActionBtn(label, title) {
  const b = document.createElement('button');
  b.className = 'doc-item-act';
  b.type = 'button';
  b.title = title || label;
  b.textContent = label;
  return b;
}
window._sosRowActionBtn = _sosRowActionBtn;


// The release function of the one file row currently holding a drag payload
// (see _prepDrag below). One slot for the whole page bounds that memory to a
// single file however many rows are hovered or re-rendered.
let _sosDragSlot = null;
function refreshDocList(listEl, cls, mod) {
  const editOn = !!moduleEditMode[mod.id];
  listEl.innerHTML = '';
  if (!mod.files || mod.files.length === 0) {
    listEl.innerHTML = `<div class="doc-empty">${editOn ? 'No files yet. Add some below.' : 'No files here yet. Switch to Edit to add some.'}</div>`;
    return;
  }
  mod.files.forEach((f, idx) => {
    // Migrate legacy files saved before .id existed (rows are keyed by .id).
    if (!f.id) f.id = f.fileId || ('legacy_' + idx + '_' + Date.now().toString(36));

    const item = document.createElement('div');
    item.className = 'doc-item';
    item.dataset.id = f.id;
    item.title = 'Click to open · drag to reorder';

    // The file's icon is its drag-OUT handle; the rest of the row reorders
    // (A1Drag, below, ignores the icon). Two gestures, two places.
    const icon = document.createElement('div');
    icon.className = 'doc-item-icon';
    icon.innerHTML = fileEmoji(f.name);
    icon.title = SOS_NATIVE_DRAG ? 'Drag into any app' : 'Drag out to a folder · use Copy to paste into another website';

    // ── Drag-out: drag this file into Explorer / the desktop / a native app ──
    // DownloadURL is what makes the OS shell write a real file out on drop, and
    // items.add() covers drop targets inside this same page. What neither can do
    // is reach ANOTHER web page (Gemini, NotebookLM, ChatGPT): a File built in
    // script is not serialised across browsing contexts, so their dropzone
    // highlights on dragover — it sees a file-kind item — and then reads an
    // empty dataTransfer.files on drop and discards it. That silent failure is
    // why dragend below offers Copy/Save instead of leaving the user retrying.
    // No text/uri-list — that's what made targets paste a link as text.
    // The payload must be ready synchronously at dragstart, so we pre-build it
    // on hover / mousedown (IndexedDB reads can't run inside dragstart).
    //
    // MEMORY: the pre-built payload is the WHOLE file. It used to be built on
    // every hover and released only on dragend, with an object URL that was
    // never revoked, so moving the mouse down a list pinned every file in the
    // tab, and every re-render (each sync update rebuilds these rows) pinned
    // them again. Veda's StudyOS tab reached 2-5 GB (2026-09-30). Now at most
    // ONE row holds a payload (_sosDragSlot), it is released 20 s after the
    // pointer leaves, and a plain hover never downloads a cloud-only file.
    //
    // The row itself reorders (A1Drag), so only the icon is draggable.
    icon.draggable = true;
    let _dragFile = null, _dragUrl = null, _dragReady = false, _dragIdle = null;
    // afterDrop: a drop target may still be reading the URL, so keep it a
    // minute; a payload that was never dragged is freed at once.
    const _releaseDrag = (afterDrop) => {
      clearTimeout(_dragIdle); _dragIdle = null;
      if (_dragUrl) {
        const u = _dragUrl;
        if (afterDrop === true) setTimeout(() => URL.revokeObjectURL(u), 60000);
        else URL.revokeObjectURL(u);
      }
      _dragFile = null; _dragUrl = null; _dragReady = false;
      if (_sosDragSlot === _releaseDrag) _sosDragSlot = null;
    };
    const _prepDrag = (ev) => {
      if (_dragReady || (!f.fileId && !f.storageUrl)) return;
      if (_sosDragSlot && _sosDragSlot !== _releaseDrag) _sosDragSlot();
      _sosDragSlot = _releaseDrag;
      _dragReady = true;
      const hoverOnly = ev && ev.type === 'mouseenter';
      const get = hoverOnly
        ? (f.fileId ? SosFileStore.get(f.fileId).catch(() => null) : Promise.resolve(null))
        : sosResolveBlob(f);
      get.then(blob => {
        if (_sosDragSlot !== _releaseDrag) return;          // another row took the slot meanwhile
        if (blob) {
          const mime = f.mime || blob.type || 'application/octet-stream';
          _dragFile = new File([blob], f.name, { type: mime });
          _dragUrl = URL.createObjectURL(blob);
        } else { _dragReady = false; }
      }).catch(() => { _dragReady = false; });
    };
    item.addEventListener('mouseenter', _prepDrag);
    item.addEventListener('mousedown', _prepDrag);
    item.addEventListener('mouseleave', () => {
      clearTimeout(_dragIdle);
      _dragIdle = setTimeout(_releaseDrag, 20000);
    });

    // ── Desktop shell: hand the drag to the OS ──────────────────────────────
    // A native drag carries a real path, so Gemini/NotebookLM/Word/Slack all
    // accept it. It must be armed from a pointer gesture rather than dragstart:
    // startDrag takes over the pointer, and an HTML5 drag already in flight
    // would fight it for the same gesture. So here draggable is turned OFF and
    // the drag is started once the pointer has actually moved a few pixels —
    // which also keeps a plain click (open the file) from starting a drag.
    if (SOS_NATIVE_DRAG) {
      icon.draggable = false;
      item.addEventListener('mouseenter', () => { sosStageForDrag(f); });
      icon.addEventListener('mousedown', ev => {
        if (ev.button !== 0) return;
        if (ev.target.closest('button, a')) return;   // row actions aren't drag handles
        const x0 = ev.clientX, y0 = ev.clientY;
        let armed = true;
        const move = async mv => {
          if (!armed) return;
          if (Math.abs(mv.clientX - x0) < 5 && Math.abs(mv.clientY - y0) < 5) return;
          armed = false;
          cleanup();
          const path = await sosStageForDrag(f);
          if (!path) { showNotif(SOI.alert, 'Can’t drag yet', 'That file isn’t downloaded to this device yet. Open it once, then drag.'); return; }
          try { await sosStartNativeDrag(path); }
          catch (err) { console.warn('SOS native drag failed:', err); }
        };
        const cleanup = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        const up = () => { armed = false; cleanup(); };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }

    icon.addEventListener('dragstart', ev => {
      if (!_dragFile) { _prepDrag(); ev.preventDefault(); return; }
      const mime = f.mime || 'application/octet-stream';
      try { ev.dataTransfer.items.add(_dragFile); } catch (_) {}
      // Format "mimetype:filename:url" — lets a native OS drop write the file out.
      if (_dragUrl) ev.dataTransfer.setData('DownloadURL', mime + ':' + f.name + ':' + _dragUrl);
      ev.dataTransfer.effectAllowed = 'copy';
    });
    icon.addEventListener('dragend', ev => {
      // dropEffect 'none' means nothing accepted the drag. A drop onto another
      // browser tab lands here too: the page took the drop but got no file.
      if (ev.dataTransfer && ev.dataTransfer.dropEffect === 'none') _sosDragOutHint();
      _releaseDrag(true);
    });

    const main = document.createElement('div');
    main.className = 'doc-item-main';
    const nameEl = document.createElement('div');
    nameEl.className = 'doc-item-name';
    nameEl.title = f.name;
    nameEl.textContent = f.name;
    const sub = document.createElement('div');
    sub.className = 'doc-item-sub';
    const sizeEl = document.createElement('span');
    sizeEl.className = 'doc-item-size';
    sizeEl.textContent = formatBytes(f.size);
    // Cloud-sync status — a readable word + live percentage, not a lone glyph,
    // so it's obvious at a glance whether a file has actually reached the cloud.
    const cloudEl = document.createElement('span');
    cloudEl.className = 'doc-item-cloud';
    cloudEl.dataset.fileId = f.fileId || '';
    _sosApplyCloudStatus(cloudEl, f);
    sub.appendChild(sizeEl); sub.appendChild(cloudEl);
    main.appendChild(nameEl); main.appendChild(sub);

    const acts = document.createElement('div');
    acts.className = 'doc-item-acts';

    // Slides — the NotebookLM deck pipeline (spec P-3). Rendered only when the
    // pipeline is configured AND on. A LOCAL blob is enough: the bridge runs on
    // this PC and sosResolveBlob reads IndexedDB first.
    if (window.sosRunPrompt && (f.fileId || f.storageUrl || f.storagePath)) {
      const runBtn = _sosRowActionBtn('Slides', 'Make a slide deck from this file with NotebookLM');
      runBtn.dataset.act = 'slides';
      runBtn.addEventListener('click', e => {
        e.stopPropagation();
        try { window.sosRunPrompt(cls.id, f.id, mod.id); }
        catch (err) { console.warn('run prompt failed:', err); }
      });
      acts.appendChild(runBtn);
    }

    // Copy to clipboard — the one route into another web app's upload box
    // (Gemini/NotebookLM/ChatGPT all accept a pasted file; none can receive a
    // drag from this page). Falls back to a download when the OS clipboard
    // refuses the type, since a real on-disk file can be dragged from Explorer.
    const cpBtn = document.createElement('button');
    cpBtn.type = 'button';
    cpBtn.className = 'icon-chip';
    cpBtn.dataset.act = 'copy';
    cpBtn.title = 'Send to another app — copies images to the clipboard, downloads everything else';
    cpBtn.setAttribute('aria-label', 'Send to another app');
    cpBtn.innerHTML = SOI.clip;
    cpBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const ok = await sosCopyFileToClipboard(f);
      if (ok) {
        showNotif(SOI.check, 'Copied to clipboard', 'Click the upload box in the other app and press Ctrl+V.');
      } else {
        // Expected for PDF/DOCX/PPTX: the OS clipboard only carries a short
        // list of types (images, text), so a download is the working route —
        // once it's on disk it can be dragged or file-picked into any app.
        showNotif(SOI.download, 'Downloaded instead', 'The clipboard can’t hold this file type. It’s in your Downloads folder — drag it into the upload box from there.');
        sosDownloadFile(f);
      }
    });
    acts.appendChild(cpBtn);

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'icon-chip';
    dlBtn.title = 'Download';
    dlBtn.setAttribute('aria-label', 'Download');
    dlBtn.innerHTML = SOI.download;
    dlBtn.addEventListener('click', e => { e.stopPropagation(); sosDownloadFile(f); });
    acts.appendChild(dlBtn);

    if (editOn) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-chip danger';
      delBtn.title = 'Delete file';
      delBtn.setAttribute('aria-label', 'Delete file');
      delBtn.innerHTML = SOI.trash;
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        removeFile(cls.id, mod.id, f.id);
      });
      acts.appendChild(delBtn);
    }

    item.appendChild(icon);
    item.appendChild(main);
    item.appendChild(acts);

    // Open in new tab — local IDB blob, else cloud copy.
    item.onclick = () => sosOpenFile(f);

    listEl.appendChild(item);
    // Study tools (js/modules/breakdown-ui.js) add their button to the row and
    // the document's topics beneath it. A hook, not an import: this is a
    // classic script, and with the module absent the row is unchanged.
    if (window.sosDecorateDocRow) {
      try { window.sosDecorateDocRow(item, cls, mod, f); }
      catch (err) { console.warn('doc row decorate failed:', err); }
    }
  });

  // Always reorderable, View or Edit (Tony, 2026-10-29).
  sosDragList(listEl, '.doc-item', () => mod.files, (arr) => { mod.files = arr; }, () => { persistForCls(cls); refreshDocList(listEl, cls, mod); }, 'y', '.doc-item-icon');
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
          // Auto-run (spec P-4) hangs off the CLOUD upload, not the local save:
          // the pipeline Worker fetches the source from studyos-files, so a job
          // queued before the bytes are up there would just 404.
          .then(() => { try { _sosFileAdded(cls, mod, meta); } catch (e) {} })
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
    out.push({ classId: 'ksu', className: 'KSU', color: KSU_COLOR,
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
    cn.style.color = sosPastel(d.color);
    row.style.setProperty('--rowc', sosPastel(d.color));
    cn.textContent = d.classId === 'ksu' ? d.className : sosClassName({ name: d.className });
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

// The picker closes only through Cancel, a choice, or Escape (which the modal
// key handler routes to _sosCancelPick), so _sosPendingIngest always resolves.

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
    icon: 'doc',
    files: [], prompts: [], notes: [],
  };
  cls.modules.push(mod);
  persistForCls(cls);
  _sosRefreshModuleGrid(cls);
  // Still mid-pick? Re-render so the new module is listed, then take it.
  if (_sosPendingIngest) { _sosRenderDestList(_sosDocDestinations()); _sosChooseDest(cls.id, mod.id); }
  else showNotif('check', 'Module created', mod.name + ' is ready for documents.');
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
    showNotif('alert', 'Destination gone', 'That module no longer exists — nothing was filed.');
    return;
  }
  handleFilesAdded(files, dest.classId, dest.modId);
  _sosRefreshModuleGrid(cls);
}

// ── Layer 1: drop anywhere in the window ──────────────────────────────────
let _sosDragDepth = 0;

// True only for an OS file drag, and never over the notes (V's Notebook): a
// file dropped on a page belongs to the page, so the "file it as a document"
// overlay must not cover the editor it is meant for.
function _sosDragHasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt || !dt.types) return false;
  if (Array.prototype.indexOf.call(dt.types, 'Files') === -1) return false;
  if (e.target && e.target.closest && e.target.closest('.sos-nb-host')) return false;
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
  // (the notes, V's Notebook, have their own paste handling).
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


// Removing a whole class or module used to drop its file list and leave every
// file's bytes behind: in IndexedDB here and in the studyos-files Worker. On
// Veda's Brave that was 50 of 52 stored files (94 MB, 2026-09-30), from classes
// long gone. removeFile() always cleaned up one file; this does the same for
// every file of the modules being removed. Runs after persist(), so the bytes
// go only once nothing points at them.
function _sosDropFilesOf(mods) {
  for (const mod of (mods || [])) {
    for (const f of ((mod && mod.files) || [])) {
      if (!f) continue;
      if (f.fileId) { SosFileStore.delete(f.fileId).catch(() => {}); _sosCloudUrls.delete(f.fileId); }
      if (f.storagePath || f.fileId) { try { SosCloud.remove(f.storagePath || f.fileId, f.storageUrl); } catch (e) {} }
    }
  }
}

/* ── Self-cleanup adapter (sweep.js, item "studyos-orphan-files") ───────────
 * Deletes local file bytes that no class or KSU module points at any more:
 * the ones deletes left behind before _sosDropFilesOf existed, and ones whose
 * file was removed on another device. Local IndexedDB only; the Worker copy is
 * not touched, because the sweep's KV budget is for requests that happen anyway.
 * Safeguards, all required:
 *   - ready only once the server's copy has been APPLIED, so a stale local
 *     class list cannot make live files look orphaned;
 *   - an id stamped less than a day ago is never listed (an upload in flight
 *     saves the bytes before it files the entry);
 *   - an id must stay orphaned for capDays sweeps apart before it is listed,
 *     tracked in studyos_orphan_since (if that key cannot be written, nothing
 *     ages and nothing is deleted);
 *   - del() re-checks the reference right before deleting. */
const SOS_ORPHAN_KEY = 'studyos_orphan_since';
function _sosReferencedFileIds() {
  const refs = new Set();
  _sosEachFile(f => {
    if (!f) return;
    if (f.fileId) refs.add(f.fileId);
    if (f.id) refs.add(f.id);
    if (f.storagePath) refs.add(f.storagePath);
  });
  return refs;
}
// Shared by both adapters: the ids orphaned for at least capDays, tracked in
// `trackKey`. An id stamped within a day is never listed (an upload saves its
// bytes before it files the entry). If the tracker cannot be written, nothing
// ages and nothing is listed.
function _sosAgedOrphans(ids, capDays, trackKey) {
  const refs = _sosReferencedFileIds();
  let since = {};
  try { since = JSON.parse(localStorage.getItem(trackKey) || '{}') || {}; } catch (e) { since = {}; }
  const now = Date.now(), next = {}, out = [];
  for (const id of ids) {
    if (refs.has(id)) continue;
    const m = /^sf_(\d{12,})_/.exec(String(id));
    if (m && now - Number(m[1]) < 864e5) continue;
    const first = typeof since[id] === 'number' ? since[id] : now;
    next[id] = first;
    if (now - first >= capDays * 864e5) out.push(id);
  }
  return _sosLsSet(trackKey, JSON.stringify(next)) ? out : [];
}

/* Cloud copies nothing points at (sweep.js item "studyos-orphan-cloud-files").
 * On Veda's account that was 101 files, 130 MB of the configured studyos-files
 * Worker (2026-09-30): files of removed classes/modules, decks whose entry a
 * stale save dropped, deletes sent to the wrong Worker. Same safeguards as the
 * local adapter below; the listing is GET /keys (names and sizes only). Only
 * the configured Worker is swept. */
window._a1SweepCloud = window._a1SweepCloud || {};
window._a1SweepCloud['studyos-orphan-cloud-files'] = {
  ready: () => !!(SOS_CLOUD_BASE && window._fbSosServerSeen && window._fbSosServerSeen()),
  list: async (capDays) => {
    const r = await fetch(SOS_CLOUD_BASE + '/keys');
    if (!r.ok) throw new Error('keys ' + r.status);
    const files = ((await r.json()) || {}).files || [];
    const size = {};
    files.forEach(f => { if (f && f.id) size[f.id] = f.bytes || 0; });
    return _sosAgedOrphans(Object.keys(size), capDays, 'studyos_cloud_orphan_since')
      .map(id => ({ key: id, label: id + ' (' + _sosFmtBytes(size[id]) + ')' }));
  },
  del: async (id) => {
    if (_sosReferencedFileIds().has(id)) throw new Error('referenced again');
    if (!(await SosCloud.remove(id))) throw new Error('delete failed');
  },
};
/* One-off, by hand, for storage that is ALREADY orphaned (the sweep above
 * waits 30 days). In the StudyOS console:
 *   await sosCloudOrphanReport()     → what nothing references, with sizes
 *   await sosReclaimCloudOrphans()   → deletes that list after a confirm
 * Uses this page's server-applied class list, never the local cache, and
 * still skips anything uploaded in the last day. Needs the Worker's /keys. */
async function _sosCloudOrphansNow() {
  if (!SOS_CLOUD_BASE) throw new Error('no files Worker configured');
  if (!(window._fbSosServerSeen && window._fbSosServerSeen())) throw new Error('wait until StudyOS has synced with the server');
  const r = await fetch(SOS_CLOUD_BASE + '/keys');
  if (!r.ok) throw new Error('GET /keys ' + r.status + ' (deploy the updated studyos-files Worker)');
  const refs = _sosReferencedFileIds(), now = Date.now();
  return (((await r.json()) || {}).files || []).filter(f => {
    if (!f || !f.id || refs.has(f.id)) return false;
    const m = /^sf_(\d{12,})_/.exec(f.id);
    return !(m && now - Number(m[1]) < 864e5);
  });
}
window.sosCloudOrphanReport = async () => {
  const list = await _sosCloudOrphansNow();
  const total = list.reduce((n, f) => n + (f.bytes || 0), 0);
  console.table(list.map(f => ({ id: f.id, size: _sosFmtBytes(f.bytes), parts: f.parts, manifest: f.manifest })));
  console.info('[StudyOS] ' + list.length + ' unreferenced cloud files, ' + _sosFmtBytes(total) + '.');
  return { count: list.length, bytes: total, files: list };
};
window.sosReclaimCloudOrphans = async () => {
  const list = await _sosCloudOrphansNow();
  const total = list.reduce((n, f) => n + (f.bytes || 0), 0);
  if (!list.length) { showNotif(SOI.cloud, 'Nothing to reclaim', 'Every cloud file is still in use.'); return 0; }
  if (!(await window.uiConfirm('Delete ' + list.length + ' cloud files (' + _sosFmtBytes(total) + ') that no class or module uses?', { danger: true, okLabel: 'Delete' }))) return 0;
  let n = 0;
  for (const f of list) {
    if (_sosReferencedFileIds().has(f.id)) continue;
    if (await SosCloud.remove(f.id)) n++;
  }
  _sosRefreshStorage();
  showNotif(SOI.cloud, 'Cloud storage reclaimed', n + ' unused file' + (n === 1 ? '' : 's') + ' deleted.');
  return n;
};

window._a1SweepIdb = window._a1SweepIdb || {};
window._a1SweepIdb['studyos-orphan-files'] = {
  ready: () => !!(window._fbSosServerSeen && window._fbSosServerSeen()),
  list: async (capDays) => {
    const keys = await SosFileStore.keys();
    return _sosAgedOrphans(keys, capDays, SOS_ORPHAN_KEY).map(id => ({ key: id, label: String(id) }));
  },
  del: async (id) => {
    if (_sosReferencedFileIds().has(id)) throw new Error('referenced again');
    await SosFileStore.delete(id);
  },
};

// `which` is the file's id (an index still works, for older callers). By id,
// because a drag in Edit mode can reorder the list after the row was drawn.
async function removeFile(classId, modId, which) {
  const cls = findClassOrKsu(classId);
  if (!cls) return;
  const mod = cls.modules.find(m => m.id === modId);
  if (!mod) return;
  const idx = typeof which === 'number' ? which : mod.files.findIndex(x => x.id === which);
  const f = mod.files[idx];
  if (!f) return;
  if (!(await window.sosConfirmDelete('“' + f.name + '”', 'The file is removed from this module, this device and the cloud.'))) return;
  // The list may have changed while the question was up: find it again.
  const at = mod.files.indexOf(f);
  if (at < 0) return;
  if (f.fileId) SosFileStore.delete(f.fileId).catch(() => {});
  if (f.storagePath || f.fileId) SosCloud.remove(f.storagePath || f.fileId, f.storageUrl);
  if (f.fileId) _sosCloudUrls.delete(f.fileId);
  mod.files.splice(at, 1);
  persistForCls(cls);
  const listEl = _sosEl('doc-list-' + modId);
  if (listEl) refreshDocList(listEl, cls, mod);
  _sosUpdateCloudBadge();
  if (cls._ksu) renderKsuModules(); else if (currentClassId === cls.id) renderModules(classes.find(c => c.id === cls.id) || cls);
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
      <textarea id="new-prompt-${mod.id}" placeholder="Write a new prompt…"></textarea>
      <button class="btn primary" onclick="addPrompt('${cls.id}','${mod.id}')">${SOI.plus}<span>Add</span></button>
    `;
    body.appendChild(addRow);
  }
}

function refreshPromptList(listEl, cls, mod) {
  const editOn = !!moduleEditMode[mod.id];
  listEl.innerHTML = '';
  if (!mod.prompts || mod.prompts.length === 0) {
    listEl.innerHTML = `<div class="doc-empty">${editOn ? 'No prompts yet. Write one below.' : 'No prompts saved yet. Switch to Edit to add one.'}</div>`;
    return;
  }
  mod.prompts.forEach(p => {
    const entry = document.createElement('div');
    entry.className = 'prompt-entry';
    entry.dataset.id = p.id;
    _promptTextStore[p.id] = p.text;
    const safeText = escHtml(p.text);
    entry.innerHTML = `
      <div class="prompt-entry-text">${safeText}</div>
      <div class="prompt-entry-actions">
        ${editOn ? `<button class="prompt-copy-btn" onclick="editPrompt('${cls.id}','${mod.id}','${p.id}')">${SOI.pencil}<span>Edit</span></button>` : ''}
        ${editOn ? `<button class="prompt-del-btn" onclick="removePrompt('${cls.id}','${mod.id}','${p.id}')">${SOI.trash}<span>Delete</span></button>` : ''}
        <button class="prompt-copy-btn" id="cpbtn-${p.id}" onclick="copyPromptById('${p.id}')">${SOI.clip}<span>Copy</span></button>
      </div>
    `;
    listEl.appendChild(entry);
  });

  // Always reorderable; the text stays selectable for copying by hand.
  sosDragList(listEl, '.prompt-entry', () => mod.prompts, (arr) => { mod.prompts = arr; }, () => { persistForCls(cls); refreshPromptList(listEl, cls, mod); }, 'y', '.prompt-entry-text');
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

/* Edit a saved prompt in place. Deck prompts are meant to be tuned, and
 * deleting + re-adding would lose their place in the list. Swaps the row's
 * text for a textarea; Save writes it back, Cancel repaints. The prompt keeps
 * its id, so a module's defaultPromptId still resolves — the deck sheet hashes
 * the TEXT into promptVersion, so an edited prompt never hits the old cache. */
function editPrompt(classId, modId, promptId) {
  const cls = findClassOrKsu(classId);
  const mod = cls && cls.modules.find(m => m.id === modId);
  const p = mod && (mod.prompts || []).find(x => x.id === promptId);
  const listEl = _sosEl('prompt-list-' + modId);
  const row = listEl && listEl.querySelector(`.prompt-entry[data-id="${CSS.escape(promptId)}"]`);
  if (!p || !row) return;
  const textEl = row.querySelector('.prompt-entry-text');
  const ta = document.createElement('textarea');
  ta.value = p.text;
  ta.rows = Math.min(16, Math.max(4, p.text.split('\n').length + 1));
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:6px;margin-top:8px';
  const save = document.createElement('button');
  save.className = 'btn primary xs'; save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.className = 'btn ghost xs'; cancel.textContent = 'Cancel';
  save.onclick = () => {
    const text = ta.value.trim();
    if (text) { p.text = text; persistForCls(cls); }
    refreshPromptList(listEl, cls, mod);
  };
  cancel.onclick = () => refreshPromptList(listEl, cls, mod);
  // The row is a drag handle in Edit mode; the box being typed in is not.
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  textEl.replaceChildren(ta, bar);
  bar.append(save, cancel);
  ta.focus();
}

async function removePrompt(classId, modId, promptId) {
  const cls = findClassOrKsu(classId);
  if (!cls) return;
  const mod = cls.modules.find(m => m.id === modId);
  if (!mod) return;
  if (!(await window.sosConfirmDelete('this prompt'))) return;
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
    const orig = btn.innerHTML;
    btn.innerHTML = SOI.check + '<span>Copied</span>';
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1800);
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

// ---- NOTES MODULE: V's Notebook on this module's folder ----
// The module's pages are a folder of StudyOS's Notebook (js/sos-notebook.js):
// its list, search, tags, Trash and every template are Notebook's. The modal
// widens to hold it (notes-mode) and the title row gets Make flashcards.
function renderNotesModule(body, cls, mod) {
  const modal = _sosEl('module-detail-modal');
  if (modal) modal.classList.add('notes-mode');
  const cardsBtn = _sosEl('module-detail-cards-btn');
  if (cardsBtn) cardsBtn.hidden = false;
  const host = document.createElement('div');
  host.className = 'sos-nb-modal-host';
  body.appendChild(host);
  if (window.SOSNotes) window.SOSNotes.show(host, mod.id);
  else host.innerHTML = '<div class="sos-nb-msg">Notes could not load. Reload StudyOS.</div>';
}

// Back to a plain module modal: notes set aside (saved), the modal its own size.
function _sosLeaveNotesModule() {
  const host = document.querySelector('#module-detail-body .sos-nb-modal-host');
  if (host && window.SOSNotes) window.SOSNotes.hide(host);
  const modal = _sosEl('module-detail-modal');
  if (modal) modal.classList.remove('notes-mode');
  const cardsBtn = _sosEl('module-detail-cards-btn');
  if (cardsBtn) cardsBtn.hidden = true;
}

/* Make flashcards from every page of the open Notes module (spec R-1). Each
 * page is HTML, so its headings, bold terms and lists are real structure
 * (cards.js fromHtml). Re-running merges: a card is keyed to its page and its
 * content, so nothing is duplicated and a deleted card stays deleted. */
window.sosMakeCardsHere = function (classId, modId) {
  classId = classId || _sosCurrentModuleClassId;
  modId = modId || _sosCurrentModuleId;
  try { if (window.Notebook && window.SOSNotes && window.SOSNotes.mounted()) window.Notebook.flushAll(); } catch (e) {}
  const pages = window.SOSNotes ? window.SOSNotes.pages(modId) : [];
  if (!pages.length) {
    try { showNotif(SOI.alert, 'No pages yet', 'Write a page in this module first, then make cards from it.'); } catch (e) {}
    return;
  }
  if (!window.sosMakeCardsFromPages) {
    try { showNotif(SOI.alert, 'Not ready', 'Flashcards are still loading — try again in a moment.'); } catch (e) {}
    return;
  }
  window.sosMakeCardsFromPages(classId, modId, pages);
};

// Escapes text for interpolation into an HTML *text node*. Coerces first:
// callers pass stored values (class/event names) that may be null or numeric,
// and the bare .replace() this used to do threw on anything but a string.
// Covers & < > only — NOT safe for attribute values, which also need " and '.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ===== AI PROMPTS =====

// ===== NOTES =====
// Quick Notes and every Notes module are V's Notebook (js/sos-notebook.js).
// `notesList` (the main document's old quick notes) is still loaded and saved
// as it was, untouched: it is the backup of what moved into Notebook.

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
  sel.innerHTML = '<option value="">No class</option>';
  classes.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = sosClassName(c);
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
    // Ask: this one, or this and every later one? Cancel (and Escape) delete
    // nothing: Cancel used to be relabelled "This only", so backing out
    // deleted an occurrence.
    const choice = await window.uiChoice('“' + deletedEvent.name + '” repeats. Delete only this occurrence, or this one and every later one?', {
      title: 'Delete repeating event', danger: true,
      choices: [{ label: 'Only this one', value: 'one' }, { label: 'This and all future', value: 'all', danger: true }] });
    if (!choice) return;
    if (choice === 'all') {
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
    if (!(await window.sosConfirmDelete('“' + deletedEvent.name + '”', 'The event and its reminder are removed from StudyOS and TaskHub.'))) return;
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
  showNotif(SOI.trash, 'Event deleted', deletedEvent.name);
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
  const MAX = 3;   // items drawn in a cell before "+N more"

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
    if (i % 7 === 0 || i % 7 === 6) cell.classList.add('weekend');
    const isToday = day === today.getDate() && m === today.getMonth() && y === today.getFullYear();
    if (isToday) cell.classList.add('today');
    const dateStr = y + '-' + String(m+1).padStart(2,'0') + '-' + String(day).padStart(2,'0');
    cell.innerHTML = `<div class="day-num">${day}</div>`;
    cell.title = 'Add an event on ' + formatDate(dateStr);
    const dayEvents = events.filter(e => e.date === dateStr);
    const dayTasks = tasks.filter(t => t.dueDate === dateStr);
    let shown = 0;
    dayEvents.forEach(ev => {
      if (shown >= MAX) return;
      shown++;
      const dot = document.createElement('div');
      dot.className = 'cal-event';
      const cls = classes.find(c => c.id === ev.classId);
      dot.style.setProperty('--c', cls ? sosPastel(cls.color) : (EVENT_COLORS[ev.type] || '#C2CDDA'));
      dot.title = ev.name + (ev.time ? ' · ' + _sosFmtTime(ev.time) : '') + (cls ? ' · ' + sosClassName(cls) : '');
      const t = document.createElement('span');
      t.textContent = ev.name;
      dot.appendChild(t);
      dot.onclick = e => { e.stopPropagation(); openAddEvent(ev); };
      cell.appendChild(dot);
    });
    dayTasks.forEach(task => {
      if (shown >= MAX) return;
      shown++;
      // Color-coded by the class the task belongs to, matching how events are
      // tinted just above, so a month view reads as "which class" at a glance.
      // Priority only decides the fallback tint for class-less tasks.
      const tCls = classes.find(c => c.id === task.classId);
      const pColor = tCls ? sosPastel(tCls.color)
                          : (EVENT_COLORS[task.type] || PRIORITY_COLORS[task.priority] || '#C2CDDA');
      const row = document.createElement('div');
      row.className = 'cal-task' + (task.done ? ' done' : '');
      row.style.setProperty('--c', pColor);
      row.title = task.name + (task.dueTime ? ' · ' + _sosFmtTime(task.dueTime) : '');
      const box = document.createElement('span');
      box.className = 'cal-box';
      box.innerHTML = task.done ? SOI.checkBold : '';
      box.title = task.done ? 'Mark not done' : 'Mark done';
      box.onclick = e => {
        e.stopPropagation();
        task.done = !task.done;
        persistTasks();
        row.classList.toggle('done', task.done);
        box.innerHTML = task.done ? SOI.checkBold : '';
        // Sync to Veda TaskHub
        if (window._vedaTogTask) window._vedaTogTask('t_' + task.id, task.done);
        // refresh class tasks panel if open, and the dashboard counts
        const cls2 = classes.find(c => c.id === currentClassId);
        if (cls2) renderClassTasks(cls2);
        updateStats();
      };
      const label = document.createElement('span');
      label.textContent = task.name;
      label.onclick = e => { e.stopPropagation(); openEditTask(task.id); };
      row.appendChild(box);
      row.appendChild(label);
      cell.appendChild(row);
    });
    const rest = dayEvents.length + dayTasks.length - shown;
    if (rest > 0) {
      const more = document.createElement('div');
      more.className = 'cal-more';
      more.textContent = '+' + rest + ' more';
      cell.appendChild(more);
    }
    cell.onclick = () => openAddEvent(null, dateStr);
    cells.appendChild(cell);
  }

  renderUpcoming();
}

/* The next fortnight of events AND open tasks, grouped by day, each with a
 * date tile in its class's colour. */
function renderUpcoming() {
  const list = _sosEl('upcoming-list');
  if (!list) return;
  list.innerHTML = '';
  const todayStr = sosLocalDate();
  const items = events
    .filter(e => e.date >= todayStr)
    .map(e => ({ kind: 'event', date: e.date, time: e.time || '', name: e.name, classId: e.classId, type: e.type, ref: e }))
    .concat(tasks
      .filter(t => t.dueDate && t.dueDate >= todayStr && !t.done)
      .map(t => ({ kind: 'task', date: t.dueDate, time: t.dueTime || '', name: t.name, classId: t.classId, type: t.type || 'hw', ref: t })))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99').localeCompare(b.time || '99'))
    .slice(0, 14);
  if (items.length === 0) {
    list.innerHTML = '<div class="class-events-empty">Nothing coming up.<br>Click a day on the calendar to add an event.</div>';
    return;
  }
  let lastDay = '';
  items.forEach(it => {
    if (it.date !== lastDay) {
      lastDay = it.date;
      const g = document.createElement('div');
      g.className = 'up-group' + (it.date === todayStr ? ' today' : '');
      g.textContent = _sosRelDay(it.date);
      list.appendChild(g);
    }
    const cls = classes.find(c => c.id === it.classId);
    const color = cls ? sosPastel(cls.color) : (EVENT_COLORS[it.type] || '#C9B4D8');
    const dt = new Date(it.date + 'T12:00:00');
    const item = document.createElement('div');
    item.className = 'timeline-item';
    item.style.setProperty('--c', color);
    item.title = it.kind === 'task' ? 'Edit task' : 'Edit event';
    item.onclick = () => it.kind === 'task' ? openEditTask(it.ref.id) : openAddEvent(it.ref);
    item.innerHTML = `
      <div class="tl-date"><b>${dt.getDate()}</b><small>${dt.toLocaleDateString('en-US', { month: 'short' })}</small></div>
      <div class="timeline-content">
        <div class="timeline-title">${escHtml(it.name)}</div>
        <div class="timeline-meta">
          <span class="type-tag">${it.kind === 'task' ? 'Task' : escHtml(_sosTypeLabel(it.type))}</span>
          ${it.time ? `<span>${_sosFmtTime(it.time)}</span>` : ''}
          ${cls ? `<span class="cls-tag" style="--c:${color}"><i></i><span>${escHtml(sosClassName(cls))}</span></span>` : ''}
        </div>
      </div>
      <div class="tl-acts">
        ${it.kind === 'event'
          ? `<button class="icon-chip sm pink" title="Turn this event into a task" aria-label="Turn into a task" onclick="event.stopPropagation();convertEventToTask('${it.ref.id}')">${SOI.task}</button>`
          : `<button class="icon-chip sm" title="Mark done" aria-label="Mark done" onclick="event.stopPropagation();toggleTaskDone('${it.ref.id}')">${SOI.check}</button>`}
      </div>
    `;
    list.appendChild(item);
  });
}

// From the 1st: setMonth() on the 31st overflowed (Oct 31 + 1 month = Dec 1),
// so Next skipped November.
function prevMonth() { calDate = new Date(calDate.getFullYear(), calDate.getMonth() - 1, 1); renderCalendar(); }
function nextMonth() { calDate = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 1); renderCalendar(); }
function sosCalToday() { calDate = new Date(); renderCalendar(); }
window.sosCalToday = sosCalToday;

// ===== NOTIFICATIONS =====
function showNotif(icon, title, body) {
  const container = _sosEl('notif-container');
  const notif = document.createElement('div');
  notif.className = 'notif';
  // The icon may be SVG markup (SOI.*), a name ('alert', 'check' …) or one of
  // the emoji older callers pass; a name or an emoji draws as its SVG, so no
  // toast ever shows an emoji.
  let ic = String(icon == null ? '' : icon).trim();
  let tone = '#C9B4D8';
  const named = SOS_NOTIF[ic] || SOS_NOTIF[SOS_EMOJI_NOTIF[ic]];
  if (named) { tone = named[1]; ic = SOI[named[0]] || ''; }
  else if (ic && ic.charAt(0) !== '<') ic = SOI.info;            // any other emoji or text
  else if (ic) {
    for (const k in SOS_NOTIF) { if (SOI[SOS_NOTIF[k][0]] === ic) { tone = SOS_NOTIF[k][1]; break; } }
  }
  notif.style.setProperty('--tone', tone);
  // Title and body are TEXT (class and file names reach here raw — "&
  // Architecture" parsed as HTML rendered as "& amp"); only the icon is markup.
  notif.innerHTML = `
    <div class="notif-icon">${ic}</div>
    <div class="notif-text">
      <div class="notif-title">${escHtml(title)}</div>
      ${body ? `<div class="notif-body">${escHtml(body)}</div>` : ''}
    </div>
    <button class="notif-close" type="button" aria-label="Dismiss">${SOI.x}</button>
  `;
  notif.querySelector('.notif-close').onclick = (e) => { e.stopPropagation(); notif.classList.remove('show'); setTimeout(() => notif.remove(), 300); };
  container.appendChild(notif);
  requestAnimationFrame(() => notif.classList.add('show'));
  setTimeout(() => {
    notif.classList.remove('show');
    setTimeout(() => notif.remove(), 300);
  }, 4200);
  // Returned so a caller can make the toast actionable (the pipeline's "Deck
  // ready" opens the module it filed into). Callers that ignore it are
  // unaffected.
  return notif;
}
window.showNotif = showNotif;

function scheduleNotifications() {
  if (!window.thScheduleNotif) return;
  const nowT = Date.now();
  // ── Events ────────────────────────────────────────────────────────────────
  (Array.isArray(events) ? events : []).forEach(ev => {
    const nid = 'sos_ev_' + ev.id;
    const notifyAt = (ev.notif && ev.notif !== 'none') ? ev.notif : null;
    if (!notifyAt) { const cancel = window.thCancelNotifIfKnown || window.thCancelNotif; if (cancel) { try { cancel(nid, null); } catch(e){} } return; }
    if (new Date(notifyAt).getTime() <= nowT) return; // already past
    window.thScheduleNotif({
      id: nid,
      title: ev.name + (ev.time ? ' at ' + _sosFmtTime(ev.time) : ' on ' + formatDate(ev.date)),
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
    if (!notifyAt) { const cancel = window.thCancelNotifIfKnown || window.thCancelNotif; if (cancel) { try { cancel(nid, null); } catch(e){} } return; }
    if (new Date(notifyAt).getTime() <= nowT) return; // already past
    window.thScheduleNotif({
      id: nid,
      title: t.name + (t.dueTime ? ' at ' + _sosFmtTime(t.dueTime) : ''),
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
  const todayStr = sosLocalDate(today);
  const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + 7);
  const weekEndStr = sosLocalDate(weekEnd);
  const feed = _sosScheduleItems();
  const eventsThisWeek = feed.filter(e => e.date >= todayStr && e.date <= weekEndStr).length;
  _sosEl('stat-events').textContent = eventsThisWeek;

  // Exam-specific stats
  const upcomingExams = feed
    .filter(e => (e.type === 'exam' || e.type === 'quiz') && e.date >= todayStr)
    .sort((a,b) => a.date.localeCompare(b.date));
  const examCountEl = _sosEl('stat-exams');
  const nextExamEl  = _sosEl('stat-next-exam');
  // Null-guarded: that tile was replaced by Cards Due (spec M-7) and may not
  // exist. Kept so a layout that still has it keeps working.
  if (examCountEl) examCountEl.textContent = upcomingExams.length;

  // Cards due today (Phase 2). Read through window.SOS rather than an import:
  // this is a classic script and the deck is an ES module. Absent until the
  // module boots, so the tile just stays at its previous value.
  const cardsEl = _sosEl('stat-cards');
  if (cardsEl && window.SOS && window.SOS.deck) {
    try {
      const n = window.SOS.deck.countsFor(null).toStudy;
      cardsEl.textContent = n;
      const tile = _sosEl('stat-card-cards');
      if (tile) tile.style.opacity = n > 0 ? '1' : '0.7';
    } catch (e) {}
  }

  // Streak (M-1) — the one number here that goes up.
  const streakEl = _sosEl('stat-streak');
  if (streakEl && window.SOS && window.SOS.sessions) {
    try {
      const n = window.SOS.sessions.streak();
      const day = window.SOS.sessions.dayTotals();
      streakEl.textContent = n === 0 ? '0' : String(n);
      const tile = _sosEl('stat-card-streak');
      if (tile) {
        tile.title = day.minutes
          ? `${day.minutes} min today · ${day.sessions} session${day.sessions === 1 ? '' : 's'}`
          : 'No session logged today yet';
      }
    } catch (e) {}
  }
  if (nextExamEl) {
    if (upcomingExams.length > 0) {
      const daysUntil = Math.round((new Date(upcomingExams[0].date + 'T12:00:00') - new Date(todayStr + 'T12:00:00')) / 86400000);
      nextExamEl.textContent = daysUntil === 0 ? 'Today' : daysUntil === 1 ? '1 day' : daysUntil + ' days';
      nextExamEl.style.color = daysUntil <= 3 ? '#F2AFAF' : daysUntil <= 7 ? '#F2C9A0' : '';
      nextExamEl.title = upcomingExams[0].name;
    } else {
      nextExamEl.textContent = '—';
      nextExamEl.style.color = '';
      nextExamEl.title = '';
    }
  }
  renderExamCountdown();
  renderPriorityQueue();
  _sosPaintGreeting();
}

/* The dashboard's opening line: the date, a greeting for the hour, and what
 * is next on her plate. */
function _sosPaintGreeting() {
  const d = new Date();
  const dateEl = _sosEl('sos-dash-date'), greetEl = _sosEl('sos-dash-greet'), nextEl = _sosEl('sos-dash-next');
  if (!dateEl || !greetEl || !nextEl) return;
  dateEl.textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const h = d.getHours();
  greetEl.textContent = h < 5 ? 'Still up, Veda?' : h < 12 ? 'Good morning, Veda' : h < 17 ? 'Good afternoon, Veda' : 'Good evening, Veda';
  const todayStr = sosLocalDate(d);
  const next = _sosScheduleItems()
    .filter(e => e.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99').localeCompare(b.time || '99'))[0];
  if (!next) { nextEl.textContent = 'Nothing due. A good day to get ahead.'; return; }
  const cls = classes.find(c => c.id === next.classId);
  nextEl.innerHTML = 'Next up: <b>' + escHtml(next.name) + '</b> · ' + escHtml(_sosRelDay(next.date))
    + (next.time ? ' at ' + escHtml(_sosFmtTime(next.time)) : '')
    + (cls ? ' · ' + escHtml(sosClassName(cls)) : '');
}

// ── Urgency score helper ────────────────────────────────────────────────────
// score = weight% × urgencyMultiplier where urgencyMultiplier decays over time
// Unified schedule feed: events and tasks share one shape so every dashboard
// panel (stats, countdown, priority queue) treats them identically. Tasks use
// dueDate/dueTime and carry no grade weight; completed/dateless tasks drop out.
function _sosScheduleItems() {
  const fromEvents = events
    .filter(e => e && e.date)
    .map(e => ({ src:'event', ref:e, id:e.id, name:e.name, date:e.date, time:e.time || '',
                 classId:e.classId, type:e.type, weight:e.weight }));
  const fromTasks = tasks
    .filter(t => t && t.dueDate && !t.done)
    .map(t => ({ src:'task', ref:t, id:t.id, name:t.name, date:t.dueDate, time:t.dueTime || '',
                 classId:t.classId, type:t.type || 'hw', weight:'' }));
  return fromEvents.concat(fromTasks);
}

/* Priority score v2 (spec G-2).
 *
 * Was `urgency × weight`, which cannot tell a 5% quiz she has already mastered
 * from a 25% exam she is weak on — they rank purely by date and weight. Now
 * mastery exists (js/modules/deck.js), the missing term is available:
 *
 *     priority = urgency × weight × (1 − mastery × MASTERY_MAX_DISCOUNT)
 *
 * Mastery only ever DISCOUNTS, capped at 60%. Fully mastered material still
 * ranks — an exam you feel good about is not an exam you skip — but it steps
 * aside for the thing you cannot do yet. Capping the discount also means a
 * wrong mastery estimate can never bury a real deadline.
 *
 * Degrades to the old behaviour when the deck module has not booted, or when a
 * class has no cards: with no evidence, assume nothing.
 */
const MASTERY_MAX_DISCOUNT = 0.6;

function _sosDaysLeft(date) {
  return Math.max(0, Math.round((new Date(date + 'T12:00:00') - new Date(sosLocalDate() + 'T12:00:00')) / 86400000));
}

function _sosPriorityScore(ev) {
  const daysLeft = _sosDaysLeft(ev.date);
  const weight = parseFloat(ev.weight) || 10; // default 10% if unset
  // Urgency: 100 at 0 days, halves every 7 days (exponential decay)
  const urgency = 100 * Math.pow(0.5, daysLeft / 7);

  let readiness = 1;
  try {
    if (ev.classId && window.SOS && window.SOS.deck) {
      const m = window.SOS.deck.mastery(ev.classId);
      // No cards means no evidence, not "0% mastered" — treating an
      // un-carded class as totally unknown would shove it to the top of the
      // queue purely for having no flashcards.
      if (m && m.total > 0) readiness = 1 - (m.pct / 100) * MASTERY_MAX_DISCOUNT;
    }
  } catch (e) { /* fall back to urgency × weight */ }

  return Math.round(urgency * weight * readiness);
}

/** Why a row is ranked where it is — shown on hover so the order is trustable
 *  rather than magic (spec G-2). */
function _sosPriorityWhy(ev) {
  const daysLeft = _sosDaysLeft(ev.date);
  const weight = parseFloat(ev.weight) || 10;
  const bits = [
    daysLeft === 0 ? 'due today' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} away`,
    `${weight}% of the grade`,
  ];
  try {
    if (ev.classId && window.SOS && window.SOS.deck) {
      const m = window.SOS.deck.mastery(ev.classId);
      if (m && m.total > 0) bits.push(`${m.pct}% mastered`);
    }
  } catch (e) {}
  return bits.join(' · ');
}

function _sosClsTag(cls) {
  return cls ? `<span class="cls-tag" style="--c:${sosPastel(cls.color)}"><i></i><span>${escHtml(sosClassName(cls))}</span></span>` : '';
}

// ── Exam Countdown ──────────────────────────────────────────────────────────
function renderExamCountdown() {
  const el = _sosEl('sos-exam-countdown-list');
  if (!el) return;
  const todayStr = sosLocalDate();

  const exams = _sosScheduleItems()
    .filter(e => (e.type === 'exam' || e.type === 'quiz') && e.date >= todayStr)
    .sort((a,b) => a.date.localeCompare(b.date))
    .slice(0, 6);

  if (exams.length === 0) {
    el.innerHTML = '<div class="sos-exam-empty">No exams or quizzes coming up.<br>Add one, or set an event’s type to <b>Exam</b> or <b>Quiz</b>.</div>';
    return;
  }

  el.innerHTML = '';
  exams.forEach(ev => {
    const cls = classes.find(c => c.id === ev.classId);
    const daysLeft = _sosDaysLeft(ev.date);
    const weight = parseFloat(ev.weight) || 0;

    // Pastel by urgency: rose, peach, butter, then lavender.
    const tone = daysLeft <= 2 ? '#F2AFAF' : daysLeft <= 7 ? '#F2C9A0' : daysLeft <= 14 ? '#E8D49A' : '#C9B4D8';

    const item = document.createElement('div');
    item.className = 'sos-exam-item';
    item.title = 'Edit';
    item.style.setProperty('--tone', tone);
    item.onclick = () => ev.src === 'task' ? openEditTask(ev.id) : openAddEvent(ev.ref);
    item.innerHTML = `
      <div class="sos-exam-cd-badge" style="background:color-mix(in srgb, ${tone} 13%, transparent);color:${tone}">
        <div class="sos-exam-cd-days">${daysLeft === 0 ? '!' : daysLeft}</div>
        <div class="sos-exam-cd-lbl">${daysLeft === 0 ? 'today' : daysLeft === 1 ? 'day' : 'days'}</div>
      </div>
      <div class="sos-exam-info">
        <div class="sos-exam-name" title="${escHtml(ev.name).replace(/"/g, '&quot;')}">${escHtml(ev.name)}</div>
        <div class="sos-exam-meta">
          <span>${formatDate(ev.date)}${ev.time ? ' · ' + _sosFmtTime(ev.time) : ''}</span>
          ${cls ? '<span class="meta-dot"></span>' + _sosClsTag(cls) : ''}
          <span class="type-tag">${escHtml(_sosTypeLabel(ev.type))}</span>
        </div>
      </div>
      ${weight > 0 ? `<div class="sos-exam-score-pill" style="background:color-mix(in srgb, ${tone} 13%, transparent);color:${tone}" title="Worth ${weight}% of the grade">${weight}%</div>` : ''}
    `;
    el.appendChild(item);
  });
}

// ── Priority Queue ──────────────────────────────────────────────────────────
function renderPriorityQueue() {
  const el = _sosEl('sos-priority-queue-list');
  if (!el) return;
  const todayStr = sosLocalDate();
  const in30 = new Date(); in30.setDate(in30.getDate() + 30);
  const in30Str = sosLocalDate(in30);

  // Include exams + hw + quiz within 30 days
  const scored = _sosScheduleItems()
    .filter(e => ['exam','hw','quiz'].includes(e.type) && e.date >= todayStr && e.date <= in30Str)
    .map(e => ({ ev: e, score: _sosPriorityScore(e) }))
    .sort((a,b) => b.score - a.score)
    .slice(0, 8);

  if (scored.length === 0) {
    el.innerHTML = '<div class="sos-exam-empty">Nothing due in the next 30 days.<br>Exams, quizzes and homework rank here.</div>';
    return;
  }

  el.innerHTML = '';
  const maxScore = scored[0].score || 1;
  scored.forEach(({ ev, score }, i) => {
    const cls = classes.find(c => c.id === ev.classId);
    const daysLeft = _sosDaysLeft(ev.date);
    const when = daysLeft === 0 ? 'Due today' : daysLeft === 1 ? 'Tomorrow' : 'In ' + daysLeft + ' days';
    const whenTone = daysLeft <= 2 ? '#F2AFAF' : daysLeft <= 7 ? '#F2C9A0' : '';
    const weight = parseFloat(ev.weight) || 0;
    const pct = Math.max(6, Math.round((score / maxScore) * 100));

    const item = document.createElement('div');
    item.className = 'sos-pq-item';
    item.title = _sosPriorityWhy(ev) + ' · click to edit';
    item.onclick = () => ev.src === 'task' ? openEditTask(ev.id) : openAddEvent(ev.ref);
    // Start and Done (spec S-2): the queue ranked eight things and gave her
    // nothing to do with any of them. Done is tasks-only: an exam is not
    // something you complete.
    item.innerHTML = `
      <div class="sos-pq-rank">${i + 1}</div>
      <div class="sos-pq-info">
        <div class="sos-pq-name">${escHtml(ev.name)}</div>
        <div class="sos-pq-meta">
          <span class="sos-pq-when"${whenTone ? ` style="color:${whenTone}"` : ''}>${when}</span>
          ${cls ? '<span class="meta-dot"></span>' + _sosClsTag(cls) : ''}
          ${weight > 0 ? `<span class="meta-dot"></span><span>${weight}%</span>` : ''}
        </div>
        <div class="sos-pq-bar" title="Priority ${pct} of 100"><i style="width:${pct}%"></i></div>
      </div>
      <div class="sos-pq-actions">
        <button class="sos-pq-btn" data-act="start" title="Start a focus session on this">${SOI.play}<span>Start</span></button>
        ${ev.src === 'task' ? `<button class="sos-pq-btn" data-act="done" title="Mark done" aria-label="Mark done">${SOI.checkBold}</button>` : ''}
      </div>
    `;
    item.querySelectorAll('.sos-pq-btn').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();                 // the row itself opens the editor
        if (b.dataset.act === 'done' && ev.src === 'task') {
          toggleTaskDone(ev.id);
          renderPriorityQueue();
        } else if (b.dataset.act === 'start') {
          startFocusOn(ev);
        }
      };
    });
    el.appendChild(item);
  });
}

/* ── Start Session (spec S-1 / S-2) ────────────────────────────────────────
 * The blocker is activation energy, not information. She knows HW3 matters;
 * the gap is between knowing and starting. So this reduces starting to one
 * click: pick the work, open its class, start the clock.
 *
 * Deliberately does NOT ask which class, how long, or what to work on. Every
 * decision put between her and starting is a place to stop.
 */
function startFocusOn(ev, minutes) {
  try {
    if (ev && ev.classId) {
      currentClassId = ev.classId;
      _sosPomoClassId = ev.classId;
    }
    _sosPomoFor = ev && ev.name ? ev.name : '';
    switchView('pomodoro');
    if (minutes) {
      const inp = _sosEl('pomo-inp-work');
      if (inp) { inp.value = String(minutes); onPomoSettingChange(); }
    }
    if (!pomoRunning) {
      if (pomoMode !== 'work') setPomoMode('work');
      togglePomo();
    }
    _sosPaintPomoFor();
    const what = ev && ev.name ? ev.name : 'Focus';
    showNotif('timer', 'Started', what + (minutes ? ` · ${minutes} min` : ''));
  } catch (e) { console.warn('startFocusOn failed:', e); }
}

/**
 * The dashboard's one button. Takes the top of the priority queue and starts.
 * `minutes` lets "Just 10 minutes" lower the bar to something that cannot
 * reasonably be refused — a ten-minute session that happens beats a fifty
 * minute one that does not.
 */
window.sosStartSession = function (minutes) {
  const todayStr = sosLocalDate();
  const in30 = new Date(); in30.setDate(in30.getDate() + 30);
  const top = _sosScheduleItems()
    .filter(e => ['exam', 'hw', 'quiz'].includes(e.type)
              && e.date >= todayStr && e.date <= sosLocalDate(in30))
    .map(e => ({ ev: e, score: _sosPriorityScore(e) }))
    .sort((a, b) => b.score - a.score)[0];

  if (!top) {
    // Nothing due is not nothing to do: due cards are still worth the minutes.
    if (window.SOS && window.SOS.deck && window.SOS.deck.countsFor(null).toStudy > 0) {
      return window.sosStudyAll && window.sosStudyAll();
    }
    showNotif('check', 'Nothing queued', 'No work due in the next 30 days.');
    return;
  }
  startFocusOn(top.ev, minutes);
};

// ===== TASKS =====
function persistTasks() { _sosLsSet('studyos_tasks', JSON.stringify(tasks)); _sosFirebaseSave(); _sosEmit('tasks'); }

function openAddTaskForClass() {
  editingTaskId = null;
  _sosEl('add-task-modal-title').textContent = 'New Task';
  _sosEl('inp-task-name').value = '';
  const today = sosLocalDate();
  _sosEl('inp-task-date').value = today;
  _sosEl('inp-task-time').value = '';
  _sosEl('inp-task-priority').value = 'medium';
  { const _tt=_sosEl('inp-task-type'); if(_tt)_tt.value='hw'; }
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
  const today = sosLocalDate();
  _sosEl('inp-task-date').value = today;
  _sosEl('inp-task-time').value = '';
  _sosEl('inp-task-priority').value = 'medium';
  { const _tt=_sosEl('inp-task-type'); if(_tt)_tt.value='hw'; }
  _sosEl('inp-task-notes').value = '';
  { const _nd=_sosEl('inp-task-notif-date'); if(_nd)_nd.value=''; const _nt=_sosEl('inp-task-notif-time'); if(_nt)_nt.value=''; }
  _sosEl('btn-delete-task').style.display = 'none';
  // Show class selector and populate it
  const classField = _sosEl('inp-task-class-field');
  if (classField) classField.style.display = '';
  const sel = _sosEl('inp-task-class');
  if (sel) {
    sel.innerHTML = '<option value="">No class</option>';
    classes.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id; opt.textContent = sosClassName(c); sel.appendChild(opt);
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
  { const _tt=_sosEl('inp-task-type'); if(_tt)_tt.value = t.type || 'hw'; }
  _sosEl('inp-task-notes').value = t.notes || '';
  (()=>{ const nd=_sosEl('inp-task-notif-date'), nt=_sosEl('inp-task-notif-time'); if(t.notif&&t.notif!=='none'){ const dt=new Date(t.notif); if(!isNaN(dt.getTime())){ const pad=n=>String(n).padStart(2,'0'); if(nd)nd.value=dt.getFullYear()+'-'+pad(dt.getMonth()+1)+'-'+pad(dt.getDate()); if(nt)nt.value=pad(dt.getHours())+':'+pad(dt.getMinutes()); } } else { if(nd)nd.value=''; if(nt)nt.value=''; } })();
  _sosEl('btn-delete-task').style.display = '';
  // Show class selector and populate it
  const classField = _sosEl('inp-task-class-field');
  if (classField) classField.style.display = '';
  const sel = _sosEl('inp-task-class');
  if (sel) {
    sel.innerHTML = '<option value="">No class</option>';
    classes.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id; opt.textContent = sosClassName(c); sel.appendChild(opt);
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
    type: (_sosEl('inp-task-type') || {}).value || 'hw',
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
    const choice = await window.uiChoice('“' + t.name + '” repeats. Delete only this occurrence, or this one and every later one?', {
      title: 'Delete repeating task', danger: true,
      choices: [{ label: 'Only this one', value: 'one' }, { label: 'This and all future', value: 'all', danger: true }] });
    if (!choice) return;
    if (choice === 'all') {
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
    if (!(await window.sosConfirmDelete('“' + t.name + '”', 'The task and its reminder are removed from StudyOS and TaskHub.'))) return;
    if (window.thCancelNotif) window.thCancelNotif('sos_task_' + editingTaskId, null);
    tasks = tasks.filter(x => x.id !== editingTaskId);
    if (window._vedaRemoveTask) window._vedaRemoveTask('t_' + editingTaskId);
  }

  editingTaskId = null;
  persistTasks();
  _sosClose('modal-add-task');
  renderCalendar();
  updateStats();
  const cls = classes.find(c => c.id === currentClassId);
  if (cls) renderClassTasks(cls);
  showNotif(SOI.trash, 'Task deleted', t.name);
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
// The Timer view, after TaskHub Veda's timer (index.html Pomodoro): a ring
// whose arc runs every frame off the exact end time with a dot riding its
// end, a length stepper, and TaskHub's own sounds.
const POMO_CIRCUMFERENCE = 2 * Math.PI * 122;
let pomoMode = 'work';
let pomoRunning = false;
let pomoSeconds = 25 * 60;
let pomoTotal = 25 * 60;
let pomoSession = 0;
let _pomoDone = false;          // a block just ended; the play button restarts it
let _sosPomoFor = '';           // what Start Session / the queue started it for

// Inline timer (blob workers are blocked by CSP). Ticks whole seconds for the
// digits; the ring reads _pomoEnd directly.
let _pomoIv = null, _pomoEnd = 0, _pomoRemMs = null;
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
    if (!_pomoEnd) return;
    pomoSeconds = e.data.left;
    updatePomoDisplay();
    updateTopbarPomo();
  } else if (e.data.type === 'done') {
    _pomoEnd = 0; _pomoRemMs = null;
    pomoSeconds = 0;
    pomoRunning = false;
    _pomoDone = true;
    updatePomoDisplay();
    updatePomoRing();
    updatePomoPlayBtn();
    updateTopbarPomo();
    playPomoAlarm();
    if (pomoMode === 'work') {
      // The whole point of S-3: a completed focus block is written down.
      if (_sosPomoStartedAt) {
        _sosLogSession('focus', {
          classId: _sosPomoClassId,
          startedAt: _sosPomoStartedAt,
          durationMs: Date.now() - _sosPomoStartedAt,
          completed: true,
        });
        _sosPomoStartedAt = null;
      }
      pomoSession = (pomoSession + 1) % 4;
      updatePomoDots();
      const nextMode = pomoSession === 0 ? 'long' : 'short';
      showNotif('timer', 'Focus complete', 'Time for a ' + (nextMode === 'long' ? 'long' : 'short') + ' break.');
      // Show "Complete" for a moment, then line up the break.
      setTimeout(() => { if (_pomoDone && !pomoRunning) setPomoMode(nextMode); }, 2600);
    } else {
      showNotif('timer', 'Break over', 'Ready to focus again.');
      setTimeout(() => { if (_pomoDone && !pomoRunning) setPomoMode('work'); }, 2600);
    }
    _sosPaintPomoToday();
  }
};

/* ── Timer sounds: TaskHub's (index.html _tmBell / playAlarm / playTimerCue) ─
 * A soft bell: each note is a sine fundamental plus three bell-like partials
 * with an exponential decay, through a short generated room reverb and a
 * gentle compressor, so overlapping notes stay smooth instead of clipping. */
let _pomoAudioCtx = null;
function _pomoCtx() {
  try {
    if (!_pomoAudioCtx) _pomoAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_pomoAudioCtx.state === 'suspended') { const r = _pomoAudioCtx.resume(); if (r && r.catch) r.catch(() => {}); }
  } catch (e) { _pomoAudioCtx = null; }
  return _pomoAudioCtx;
}
function _tmBell(ctx, out, freq, t, vel) {
  [[1, 1, 2.6], [2.01, .32, 1.7], [2.76, .16, 1.1], [4.07, .06, .6]].forEach(([mul, amp, len]) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(freq * mul, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vel * amp, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + len + 0.05);
  });
}
function _tmChain(ctx) {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.setValueAtTime(-14, ctx.currentTime); comp.knee.setValueAtTime(12, ctx.currentTime);
  comp.ratio.setValueAtTime(3, ctx.currentTime); comp.attack.setValueAtTime(0.004, ctx.currentTime); comp.release.setValueAtTime(0.25, ctx.currentTime);
  comp.connect(ctx.destination);
  const dry = ctx.createGain(); dry.gain.value = 0.8; dry.connect(comp);
  const len = Math.floor(ctx.sampleRate * 1.8), ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
  const rev = ctx.createConvolver(); rev.buffer = ir; const wet = ctx.createGain(); wet.gain.value = 0.2;
  dry.connect(rev); rev.connect(wet); wet.connect(comp);
  return dry;
}
// The end-of-timer chime: a rising Cmaj7 arpeggio played twice, then a
// resolving high C held over a low C. About five seconds in all.
function playPomoAlarm() {
  const ctx = _pomoCtx(); if (!ctx) return;
  const out = _tmChain(ctx); const t0 = ctx.currentTime + 0.05;
  const arp = [523.25, 659.25, 783.99, 987.77];
  [0, 1.5].forEach(off => arp.forEach((f, i) => _tmBell(ctx, out, f, t0 + off + i * 0.17, 0.24 - i * 0.015)));
  _tmBell(ctx, out, 1046.5, t0 + 3.0, 0.25); _tmBell(ctx, out, 523.25, t0 + 3.0, 0.17);
}
// A soft mallet note for the button cues: a rounder, shorter cousin of the
// bell, lowpassed so it never sounds sharp.
function _tmMallet(ctx, out, freq, t, vel, len) {
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(Math.min(9000, freq * 6), t); lp.Q.value = 0.4; lp.connect(out);
  [[1, 1, len], [2, .2, len * .5], [3.98, .07, len * .2]].forEach(([mul, amp, l]) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(freq * mul, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vel * amp, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + l);
    o.connect(g); g.connect(lp); o.start(t); o.stop(t + l + 0.05);
  });
}
// Button cues, all in G major so they sit with each other and the chime:
// start = a rising G-B-D triad, resume = G up to D, pause = D down to G.
function playTimerCue(kind) {
  const ctx = _pomoCtx(); if (!ctx) return;
  const out = _tmChain(ctx); const t = ctx.currentTime + 0.02;
  const seq = kind === 'start' ? [[783.99, 0, .19], [987.77, .075, .16], [1174.66, .15, .17]]
    : kind === 'resume' ? [[783.99, 0, .18], [1174.66, .085, .16]]
    : [[1174.66, 0, .14], [783.99, .09, .15]];
  seq.forEach(([f, d, v]) => _tmMallet(ctx, out, f, t + d, v, kind === 'pause' ? 0.7 : 0.95));
}

/* Lengths, remembered on this device (a convenience: blocked storage just
 * means 25 / 5 / 15). */
const POMO_DEFAULTS = { work: 25, short: 5, long: 15 };
const POMO_INPUT = { work: 'pomo-inp-work', short: 'pomo-inp-short', long: 'pomo-inp-long' };
(function () {
  try {
    const s = JSON.parse(localStorage.getItem('sos_pomo_lengths') || 'null');
    if (s) document.addEventListener('DOMContentLoaded', () => {
      Object.keys(POMO_INPUT).forEach(k => { const el = _sosEl(POMO_INPUT[k]); if (el && s[k]) el.value = String(s[k]); });
      if (!pomoRunning) setPomoMode(pomoMode);
    });
  } catch (e) {}
})();
function _pomoSaveLengths() {
  try { localStorage.setItem('sos_pomo_lengths', JSON.stringify({ work: pomoMins('work'), short: pomoMins('short'), long: pomoMins('long') })); } catch (e) {}
}

function pomoMins(mode) {
  const el = _sosEl(POMO_INPUT[mode]);
  return Math.max(1, Math.min(180, parseInt(el && el.value) || POMO_DEFAULTS[mode]));
}

/* The stepper: −5 / −1 / +1 / +5 on the shown mode's length, while stopped. */
function sosPomoAdjust(delta) {
  if (pomoRunning) return;
  const el = _sosEl(POMO_INPUT[pomoMode]);
  if (!el) return;
  el.value = String(Math.max(1, Math.min(180, pomoMins(pomoMode) + delta)));
  _pomoSaveLengths();
  setPomoMode(pomoMode);
}
window.sosPomoAdjust = sosPomoAdjust;

function setPomoMode(mode) {
  if (pomoRunning) { pomoWorker.postMessage({cmd:'stop'}); pomoRunning = false; }
  if (mode !== pomoMode) _sosPomoFor = mode === 'work' ? _sosPomoFor : '';
  pomoMode = mode;
  _pomoDone = false;
  _pomoEnd = 0; _pomoRemMs = null;
  pomoTotal = pomoMins(mode) * 60;
  pomoSeconds = pomoTotal;
  document.querySelectorAll('#study-root .pomo-mode-btn').forEach(b => b.classList.remove('active'));
  _sosEl('pomo-btn-' + (mode==='work'?'work':mode==='short'?'short':'long')).classList.add('active');
  updatePomoDisplay();
  updatePomoRing();
  updatePomoPlayBtn();
  updateTopbarPomo();
}

/* ── Session logging (spec S-3) ────────────────────────────────────────────
 * The timer recorded nothing: no storage key, no persist call, no Firestore
 * field. When the 25 minutes ended a chime played and the evidence evaporated,
 * which is why the app produced no sense of progress — there was nothing to
 * look back at. These three lines of state are what streaks, the heatmap and
 * hours-by-class are all views over.
 *
 * `_sosPomoClassId` lets a session be attributed to whatever class she was
 * looking at when she started it, which is the honest default and costs her no
 * extra decision. */
let _sosPomoStartedAt = null;
let _sosPomoClassId = '';

function _sosLogSession(kind, fields) {
  try {
    if (window.SOS && window.SOS.sessions) return window.SOS.sessions.log(kind, fields);
  } catch (e) { console.warn('session log failed:', e); }
  return null;
}

function togglePomo() {
  if (_pomoDone) { setPomoMode(pomoMode); return; }   // "Restart" after a block ends
  if (pomoRunning) {
    _pomoRemMs = Math.max(0, _pomoEnd - Date.now());
    _pomoEnd = 0;
    pomoWorker.postMessage({cmd:'stop'});
    pomoRunning = false;
    playTimerCue('pause');
    // A paused focus block still happened. Log what was done rather than
    // discarding it — pausing to answer the door should not erase 18 minutes.
    if (pomoMode === 'work' && _sosPomoStartedAt) {
      _sosLogSession('focus', {
        classId: _sosPomoClassId,
        startedAt: _sosPomoStartedAt,
        durationMs: Date.now() - _sosPomoStartedAt,
        completed: false,
      });
      _sosPomoStartedAt = null;
    }
  } else {
    const ms = _pomoRemMs != null ? _pomoRemMs : pomoSeconds * 1000;
    playTimerCue(ms >= pomoTotal * 1000 ? 'start' : 'resume');
    pomoWorker.postMessage({cmd:'start', secs: ms / 1000});
    _pomoRemMs = null;
    pomoRunning = true;
    if (pomoMode === 'work' && !_sosPomoStartedAt) {
      _sosPomoStartedAt = Date.now();
      _sosPomoClassId = currentClassId || '';
    }
    _pomoRingLoop();
  }
  updatePomoPlayBtn();
  updatePomoRing();
  updateTopbarPomo();
}

function resetPomo() {
  pomoWorker.postMessage({cmd:'stop'});
  pomoRunning = false;
  _pomoDone = false;
  _pomoEnd = 0; _pomoRemMs = null;
  pomoSeconds = pomoTotal;
  updatePomoDisplay();
  updatePomoRing();
  updatePomoPlayBtn();
  updateTopbarPomo();
}

function skipPomo() {
  pomoWorker.postMessage({cmd:'stop'});
  pomoRunning = false;
  _pomoEnd = 0; _pomoRemMs = null;
  if (pomoMode === 'work') {
    pomoSession = (pomoSession + 1) % 4;
    updatePomoDots();
    setPomoMode(pomoSession === 0 ? 'long' : 'short');
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
  const len = _sosEl('pomo-len');
  if (len) len.textContent = pomoMins(pomoMode) + ' min';
  document.querySelectorAll('#pomo-stepper .pomo-step').forEach(b => { b.disabled = pomoRunning; });
  const card = document.querySelector('#study-root .pomo-card');
  if (card) {
    card.classList.toggle('running', pomoRunning);
    card.classList.toggle('done', _pomoDone);
    card.classList.toggle('break', pomoMode !== 'work');
  }
  const lbl = _sosEl('pomo-mode-label');
  if (lbl) lbl.textContent = _pomoDone ? 'Complete' : pomoRunning ? (pomoMode === 'work' ? 'Focusing' : 'On break') : (pomoSeconds < pomoTotal || _pomoRemMs != null ? 'Paused' : 'Ready');
  const sess = _sosEl('pomo-sess-txt');
  if (sess) sess.textContent = 'Block ' + (pomoSession + 1) + ' of 4';
  _sosPaintPomoFor();
}

function _sosPaintPomoFor() {
  const el = _sosEl('pomo-for');
  if (el) { el.textContent = _sosPomoFor && pomoMode === 'work' ? 'for ' + _sosPomoFor : ''; el.title = el.textContent; }
}

/* Today's focus, from the session log (js/modules/sessions.js). */
function _sosPaintPomoToday() {
  const el = _sosEl('pomo-today');
  if (!el) return;
  try {
    if (!(window.SOS && window.SOS.sessions)) { el.textContent = ''; return; }
    const d = window.SOS.sessions.dayTotals();
    el.innerHTML = d.minutes
      ? '<b>' + d.minutes + ' min</b> focused today · ' + d.sessions + ' session' + (d.sessions === 1 ? '' : 's')
      : 'No focus logged today yet. One block is a good start.';
  } catch (e) { el.textContent = ''; }
}

/* The arc shows the time LEFT; the dot rides its end. While running, a frame
 * loop writes it straight from the exact end time, so it glides instead of
 * stepping once a second. */
function _pomoFrac() {
  if (_pomoDone) return 0;
  const ms = _pomoEnd ? Math.max(0, _pomoEnd - Date.now()) : (_pomoRemMs != null ? _pomoRemMs : pomoSeconds * 1000);
  return pomoTotal > 0 ? Math.min(1, ms / (pomoTotal * 1000)) : 0;
}
function updatePomoRing() {
  const p = _pomoFrac();
  const ring = _sosEl('pomo-ring');
  if (ring) ring.style.strokeDashoffset = POMO_CIRCUMFERENCE * (1 - p);
  const dot = _sosEl('pomo-ring-dot');
  if (dot) { dot.style.transform = 'rotate(' + (360 * p) + 'deg)'; dot.style.opacity = p > 0.004 && p < 0.9995 ? 1 : 0; }
}
let _pomoRaf = 0;
function _pomoRingLoop() {
  cancelAnimationFrame(_pomoRaf);
  const f = () => {
    if (!pomoRunning || !_pomoEnd) { _pomoRaf = 0; return; }
    if (activeView === 'pomodoro' && !document.hidden) updatePomoRing();
    _pomoRaf = requestAnimationFrame(f);
  };
  _pomoRaf = requestAnimationFrame(f);
}

function updatePomoPlayBtn() {
  const pause = '<rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/>';
  const play = '<path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8z"/>';
  const again = '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
  const icon = _pomoDone ? again : pomoRunning ? pause : play;
  _sosEl('pomo-play-icon').innerHTML = icon;
  _sosEl('topbar-pomo-icon').innerHTML = pomoRunning ? pause : play;
  var spbIcon = document.getElementById('spb-icon');
  if (spbIcon) spbIcon.innerHTML = pomoRunning ? pause : play;
  const btn = _sosEl('pomo-play-btn');
  if (btn) btn.setAttribute('aria-label', _pomoDone ? 'Restart' : pomoRunning ? 'Pause' : 'Start');
  updatePomoDisplay();
}

function updateTopbarPomo() {
  const pill = _sosEl('topbar-pomo');
  const labels = { work:'Focus', short:'Short Break', long:'Long Break' };
  _sosEl('topbar-pomo-label').textContent = labels[pomoMode];
  const active = pomoRunning || pomoSeconds < pomoTotal || _pomoRemMs != null;
  // On the Timer view itself the pill would repeat the big clock.
  pill.style.display = active && activeView !== 'pomodoro' ? 'flex' : 'none';
  // Phone / tablet strip
  var banner = document.getElementById('sos-pomo-banner');
  var spbLabel = document.getElementById('spb-label');
  if (banner) banner.style.display = active && activeView !== 'pomodoro' ? 'flex' : 'none';
  if (spbLabel) spbLabel.textContent = labels[pomoMode];
  const live = _sosEl('nav-timer-live');
  if (live) live.hidden = !pomoRunning;
}

function updatePomoDots() {
  for (let i = 0; i < 4; i++) {
    _sosEl('pd'+i).classList.toggle('done', i < pomoSession);
  }
  const sess = _sosEl('pomo-sess-txt');
  if (sess) sess.textContent = 'Block ' + (pomoSession + 1) + ' of 4';
}

function onPomoSettingChange() {
  _pomoSaveLengths();
  if (!pomoRunning) setPomoMode(pomoMode);
}

/* ── Modals ─────────────────────────────────────────────────────────────────
 * Opened and closed only by their own buttons (Cancel, Close, Back, Save):
 * a click outside the card does nothing (Tony, 2026-10-29: it threw away a
 * half-filled form). Escape still backs out of the top one, as its Cancel. */
function _sosOpen(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.add('open');
  // Desktop: the first field is ready to type in. Not on touch, where focus
  // throws the keyboard over the form before she has looked at it.
  if (window.matchMedia && window.matchMedia('(pointer: fine)').matches && id !== 'modal-module-detail') {
    setTimeout(function () {
      var f = el.querySelector('.modal input[type="text"]:not([disabled]), .modal textarea');
      if (f && el.classList.contains('open')) try { f.focus({ preventScroll: true }); } catch (e) {}
    }, 80);
  }
}
function _sosClose(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('open');
}
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if ((window.uiIsOpen && window.uiIsOpen()) || (window.Guardian && window.Guardian.isOpen && window.Guardian.isOpen())) return;
  var open = Array.prototype.slice.call(document.querySelectorAll('.sos-modal.open'));
  if (!open.length) return;
  var top = open[open.length - 1];
  e.preventDefault();
  if (top.id === 'modal-module-detail') {
    // Inside the notes editor Escape belongs to the editor.
    if (top.querySelector('.notes-mode') && e.target && e.target.closest && e.target.closest('.sos-nb-modal-host')) return;
    closeModuleDetail();
  }
  else if (top.id === 'modal-pick-dest') _sosCancelPick();
  else _sosClose(top.id);
});

// ===== PERSIST =====
var _sosSyncTimer = null;
function _sosSetSync(status) {
  var el = document.getElementById('sos-sync-status');
  if (!el) return;
  // The indicator sits under the sidebar wordmark on a dark panel, where the old
  // forest green and dusty salmon barely registered. Both states now use the
  // saturated success/danger pair, so a failed save is something you notice out
  // of the corner of your eye.
  var greenColor  = '#A8DCC0';
  var errColor    = '#F2AFAF';
  var mutedColor  = 'var(--text2,#888)';
  if (status === 'saving') {
    el.style.visibility = 'visible';
    el.style.color = mutedColor;
    el.innerHTML = SOI.refresh + '<span>Syncing…</span>';
    if (_sosSyncTimer) { clearTimeout(_sosSyncTimer); _sosSyncTimer = null; }
  } else if (status === 'saved') {
    el.style.visibility = 'visible';
    el.style.color = greenColor;
    el.innerHTML = SOI.check + '<span>Synced</span>';
    if (_sosSyncTimer) clearTimeout(_sosSyncTimer);
    _sosSyncTimer = setTimeout(function() { el.style.visibility = 'hidden'; }, 2500);
  } else if (status === 'error') {
    el.style.visibility = 'visible';
    el.style.color = errColor;
    el.innerHTML = SOI.alert + '<span>Sync failed</span>';
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

function _sosBuildPayload() {
  return {
    classes:   _sosSerializeClasses(),
    events:    events,
    tasks:     tasks,
    notes:     notesList,
    ksu:       _sosSerializeKsu(),
    d2l:       d2lMap
  };
}
// firebase-sync.js rebuilds every write from this at send time, so a write
// queued before the server's copy was applied cannot carry the stale cache.
window._sosBuildPayload = _sosBuildPayload;

function _sosFirebaseSave() {
  if (!window._fbSaveStudyOs) return;
  _sosSetSync('saving');
  window._fbSaveStudyOs(_sosBuildPayload());
}

function persist() {
  _sosLsSet('studyos_classes', JSON.stringify(_sosSerializeClasses()));
  _sosFirebaseSave();
  _sosEmit('classes');
  // also re-render ksu grid if open
  if (activeView === 'ksu') renderKsuModules();
}
function _ksuPersistHook() {
  persistKsu();
  if (activeView === 'ksu') renderKsuModules();
}
function persistEvents()  { _sosLsSet('studyos_events', JSON.stringify(events));     _sosFirebaseSave(); _sosEmit('events'); }
function persistTasks_()  { _sosLsSet('studyos_tasks',  JSON.stringify(tasks));      _sosFirebaseSave(); _sosEmit('tasks'); }

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
    type: ev.type || 'hw',
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
    date: t.dueDate || sosLocalDate(),
    time: t.dueTime || '',
    classId: t.classId || '',
    type: t.type || 'other',
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
      // Apply every array field the server sent, INCLUDING an empty one: an
      // empty array is legitimate server state (the last item was deleted on
      // another device), not "nothing to apply". Skipping empty arrays here
      // left this device's stale non-empty localStorage copy in place, and the
      // very next local edit's persist() would push it straight back to
      // Firestore, resurrecting the deleted items. The fb-sos-remote handler
      // below already gets this right — this initial load must match it.
      if (Array.isArray(remote.classes)) {
        classes = remote.classes;
        classes.forEach(c => { if (c && c.color && window.sosPastel) c.color = window.sosPastel(c.color); });
        _sosLsSet('studyos_classes', JSON.stringify(classes));
        changed = true;
      }
      if (Array.isArray(remote.events)) {
        events = remote.events;
        _sosLsSet('studyos_events', JSON.stringify(events));
        changed = true;
      }
      if (Array.isArray(remote.tasks)) {
        tasks = remote.tasks;
        _sosLsSet('studyos_tasks', JSON.stringify(tasks));
        changed = true;
      }
      if (Array.isArray(remote.notes)) {
        notesList = remote.notes;
        _sosLsSet('studyos_notes_v2', JSON.stringify(notesList));
        changed = true;
      }
      if (remote.ksu && Array.isArray(remote.ksu.modules)) {
        ksuData = remote.ksu;
        _sosLsSet('studyos_ksu', JSON.stringify(_sosSerializeKsu()));
        changed = true;
      }
      if (remote.d2l && typeof remote.d2l === 'object') {
        d2lMap = remote.d2l;
        _sosLsSet('studyos_d2l', JSON.stringify(d2lMap));
      }
      if (changed) {
        renderClasses();
        renderSidebarClasses();
        renderCalendar();
        updateStats();
        renderKsuModules();
        renderExamCountdown();
        renderPriorityQueue();
      }
      // Firestore data is now authoritative — keep cloud URLs sticky and
      // upload any files this device has locally but the cloud doesn't.
      _sosMigrateKsuFiles().catch(() => {}).then(_sosAfterSync);
    }).catch(function(e){ console.warn('SOS load error', e); });
  };

  if (window._fbReady) doLoad();
  else window.addEventListener('fb-ready', doLoad, { once: true });

  // remote update from another device
  window.addEventListener('fb-sos-remote', function(e) {
    var remote = e.detail;
    if (!remote) return;
    if (Array.isArray(remote.classes))  { classes   = remote.classes;   classes.forEach(c => { if (c && c.color && window.sosPastel) c.color = window.sosPastel(c.color); });   _sosLsSet('studyos_classes',   JSON.stringify(classes));   }
    if (Array.isArray(remote.events))   { events    = remote.events;    _sosLsSet('studyos_events',    JSON.stringify(events));    }
    if (Array.isArray(remote.tasks))    { tasks     = remote.tasks;     _sosLsSet('studyos_tasks',     JSON.stringify(tasks));     }
    if (Array.isArray(remote.notes))    { notesList = remote.notes;     _sosLsSet('studyos_notes_v2',  JSON.stringify(notesList));  }
    if (remote.ksu && Array.isArray(remote.ksu.modules)) { ksuData = remote.ksu; _sosLsSet('studyos_ksu', JSON.stringify(_sosSerializeKsu())); }
    if (remote.d2l && typeof remote.d2l === 'object') { d2lMap = remote.d2l; _sosLsSet('studyos_d2l', JSON.stringify(d2lMap)); }
    renderClasses();
    renderSidebarClasses();
    renderCalendar();
    updateStats();
    renderKsuModules();
    renderExamCountdown();
    renderPriorityQueue();
    scheduleNotifications();
    // A cold open has no local classes, so the deep link could not resolve
    // during init — this is the attempt that makes it work there. A no-op once
    // it has already been honoured.
    _sosApplyClassParam();
    // A remote save may have arrived without storageUrls (from a device that
    // lacks the blobs). Re-stamp known cloud URLs and upload any local-only files.
    _sosMigrateKsuFiles().catch(() => {}).then(_sosAfterSync);
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
  // Read BEFORE init() so a cold open still has the id after the first render;
  // applied after, when `classes` is populated from localStorage.
  _sosPendingClass = _sosReadClassParam();
  init();
  _sosApplyClassParam();
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

/* ── Store surface (F-2) ───────────────────────────────────────────────────
 * The spec asked for a separate store.js owning this state. It cannot: these
 * are top-level `let` bindings in a CLASSIC script, and every ES module on the
 * page is deferred, so a module is guaranteed to run AFTER studyos.js has
 * already read localStorage and rendered. A module-owned store would therefore
 * be a second copy of the truth, not the truth — exactly the failure the
 * strangler rule exists to prevent.
 *
 * So the bridge stays the seam and simply grows the accessors that were
 * missing. js/modules/store.js is a thin facade over this; it holds no state.
 *
 * Getters return the live arrays (cheap, and callers only read). getSnapshot()
 * deep-copies instead, because the search index must not alias live data. */
window._sosBridge.getNotes   = () => notesList;
window._sosBridge.getKsu     = () => ksuData;
window._sosBridge.getModules = (classId) => {
  const c = findClassOrKsu(classId);
  return c ? (c.modules || []) : [];
};

/* ── Pipeline write-back (spec P-5) ────────────────────────────────────────
 * js/modules/pipeline.js calls this when a job finishes. It is the only way a
 * generated note enters the app, and it lives here for the same reason every
 * other setter does: `classes`, persistForCls() and the render functions are
 * lexically scoped to this file and unreachable by property access.
 *
 * The output is a NOTE, not a file, so it opens in the docx editor and can be
 * edited and annotated immediately — the spec's argument for why generated
 * output must not land as a dead artifact.
 *
 * The destination module is created on demand ("Generated"), because P-4's
 * auto-run drops results into classes that may never have had such a module.
 */
/* Markdown → HTML for the page editor.
 *
 * The model answers in markdown; the page editor stores contentEditable HTML.
 * Deliberately small and tag-limited rather than a full parser: the output goes
 * straight into innerHTML, so every piece of model text is ESCAPED first and
 * only the structure this recognises is re-introduced as tags. A general
 * converter would be a way for model output to inject markup.
 *
 * Covers what the prompt actually asks for — headings, bold, italic, bullets,
 * numbered lists, rules — and leaves anything else as escaped text.
 */
function _sosMdToHtml(md) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');

  const out = [];
  let list = null;                       // 'ul' | 'ol' | null

  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };

  for (const raw of String(md || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }

    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

window._sosBridge.addGeneratedNote = (spec) => {
  if (!spec || !spec.classId) return null;
  const cls = findClassOrKsu(spec.classId);
  if (!cls) return null;

  // The requested module is honoured ONLY if it can actually show a note.
  // Every module carries a `notes` array regardless of type, so writing into a
  // documents module succeeds silently and then renders nowhere — the note is
  // stored, invisible and unreachable. P-4's auto-run passes the module the
  // FILE was dropped into, which is a documents module by definition, so
  // without this guard every auto-run result would vanish.
  let mod = spec.moduleId
    && (cls.modules || []).find(m => m.id === spec.moduleId && m.type === 'notes');
  if (!mod) {
    mod = (cls.modules || []).find(m => m.type === 'notes' && m.name === 'Generated');
  }
  if (!mod) {
    mod = {
      id: Date.now().toString(),
      name: 'Generated',
      type: 'notes',
      icon: 'txt',
      files: [], prompts: [], notes: [],
    };
    cls.modules = cls.modules || [];
    cls.modules.push(mod);
  }
  mod.notes = mod.notes || [];
  const meta = spec.meta || {};

  /* A `type:'notes'` module shows its folder of StudyOS's Notebook (V's
   * Notebook, js/sos-notebook.js), so the note is a page there: the model's
   * markdown as the HTML the editor speaks, written by Notebook (putPage),
   * which syncs it like any edit. Re-running one source replaces its page.
   * Resolves in the background; `saved` is that promise. */
  if (window.SOSNotes) {
    const title = String(spec.title || 'Generated note');
    persistForCls(cls);
    try { if (currentClassId === cls.id) renderModules(cls); } catch (e) {}
    const saved = window.SOSNotes.putGenerated(mod.id, {
      title, html: _sosMdToHtml(spec.body || ''), sourceId: meta.sourceFileId, meta,
    }).catch((e) => { console.warn('[StudyOS] generated note not saved:', e); return null; });
    return { moduleId: mod.id, title, _sos: { generated: true, ...meta }, saved };
  }

  // Fallback path, used only when the notes (js/sos-notebook.js) have not loaded. Re-running the
  // same source replaces its previous note rather than stacking near-identical
  // copies — "Regenerate with a different prompt" runs repeatedly for one deck.
  const prior = meta.sourceFileId
    ? mod.notes.findIndex(n => n && n._sos && n._sos.sourceFileId === meta.sourceFileId)
    : -1;

  const note = {
    id: Date.now().toString(),
    title: String(spec.title || 'Generated note'),
    body: String(spec.body || ''),
    updated: Date.now(),
    // Provenance, so "why is this one worse" stays answerable later.
    _sos: { generated: true, ...meta },
  };

  if (prior >= 0) { note.id = mod.notes[prior].id; mod.notes[prior] = note; }
  else mod.notes.unshift(note);

  persistForCls(cls);
  try { if (currentClassId === cls.id) renderModules(cls); } catch (e) {}
  try { refreshModuleNoteList(cls, mod); } catch (e) {}
  return note;
};

/* File a generated PDF deck as a real document (P-5).
 *
 * The pipeline's output is a slide deck — one page per slide, the original
 * slide image above its rewritten text — so it is a DOCUMENT, not editor text.
 * It lands in the class's documents list and opens, downloads and syncs
 * exactly like a file she uploaded herself.
 *
 * ── THE INGEST SEQUENCE IS THE RULE, NOT A DETAIL ────────────────────────
 * This repeats handleFilesAdded's four steps in order — saveBlob -> push meta
 * -> sosUploadToCloud -> persist — for the reason spelled out above
 * sosIngestFiles(): sosUploadToCloud performs the _sosCloudUrls.set()-before-
 * persist dance that stops a mid-upload Firestore sync from orphaning the
 * storageUrl. Writing to IndexedDB or KV directly here would reintroduce that
 * bug, and the file would silently stay local-only on every other device.
 *
 * ── WHY NOT INTO THE SOURCE MODULE ───────────────────────────────────────
 * _sosFileAdded fires auto-run for any module carrying a defaultPromptId. The
 * source module is exactly such a module — that is how the job was started —
 * so filing the result beside its source would queue a new job ON THE
 * GENERATED FILE, whose output would queue another. A separate "Generated"
 * module breaks that loop, and _sosFileAdded is deliberately NOT called here.
 *
 * Re-running one source REPLACES its previous deck rather than stacking
 * near-identical copies: "regenerate with a different prompt" is a normal
 * thing to do repeatedly to one deck.
 */
/* Serialises filing per source file.
 *
 * Two things can file the same finished job at once — trackJob's watcher and
 * resumeWatches' catch-up sweep — and this function awaits a blob write before
 * it touches mod.files. Without a lock both calls read the array BEFORE either
 * writes to it, both miss the dedup, and the same deck lands several times.
 * That is exactly what it did: six copies of one deck in a single run. */
const _sosGenDocLocks = new Map();

window._sosBridge.addGeneratedDoc = (spec) => {
  const key = (spec && spec.classId) + '|'
    + ((spec && spec.meta && spec.meta.sourceFileId) || (spec && spec.name) || '');
  const prev = _sosGenDocLocks.get(key) || Promise.resolve();
  // Chain onto whatever is already filing this source, so the second caller
  // sees the first one's file in mod.files and replaces it instead of adding.
  const run = prev.then(() => _sosAddGeneratedDoc(spec), () => _sosAddGeneratedDoc(spec));
  const settled = run.catch(() => {});
  _sosGenDocLocks.set(key, settled);
  // Drop the entry once nothing is queued behind it, so the map does not grow
  // for the life of the session.
  settled.then(() => {
    if (_sosGenDocLocks.get(key) === settled) _sosGenDocLocks.delete(key);
  });
  return run;
};

const _sosAddGeneratedDoc = async (spec) => {
  if (!spec || !spec.classId || !spec.blob) return null;
  const cls = findClassOrKsu(spec.classId);
  /* A class id that resolves to nothing used to `return null` here, silently.
   *
   * That is the worst outcome on this whole path: the deck generated (real
   * NotebookLM quota), downloaded, and was then dropped on the floor with no
   * toast, no console line, and no way to get it back short of reading
   * jobs.json by hand. It looked identical to "the pipeline never ran".
   *
   * It happens for ordinary reasons, not exotic ones — the class was deleted
   * or recreated (ids are timestamps, so a recreated class is a NEW id) while
   * a job that takes ~11 minutes was in flight, or the job outlived a device
   * that had not synced the class yet.
   *
   * Refuse loudly instead. `unfiled` tells the caller not to mark the job
   * filed, so the bytes stay claimable on the bridge and a later run — once
   * the class is back or synced — can still land it. */
  if (!cls) {
    console.warn('SOS generated-doc: no such class', spec.classId, '— not filing');
    return { unfiled: true, reason: 'class-missing', classId: spec.classId };
  }

  // Where the deck lands, in order of preference:
  //
  //   1. spec.moduleId, when it names a DOCUMENTS module on this class. This
  //      is the whole point of the Run sheet collecting a destination, and it
  //      used to be ignored outright — every deck was forced into a module
  //      literally named 'Generated', so a class with its own "GEMINI NOTES"
  //      documents module got a second, near-duplicate one it never asked for.
  //   2. an existing 'Generated' module, so nothing moves for anyone who was
  //      relying on the old behaviour.
  //   3. a new 'Generated' module, created on demand.
  //
  // A DOCUMENTS module in every case, never a notes one: a notes module
  // renders from the editor's own store and would show this file nowhere.
  // spec.moduleId pointing at a notes module is therefore declined rather
  // than honoured — filing there would "succeed" and display nothing.
  //
  // Each fallback is RECORDED, not just taken. Every step down this list means
  // the deck is landing somewhere other than where it was asked to go, and the
  // old code took them silently — so "I picked GEMINI NOTES and the deck is not
  // there" had no explanation anywhere in the app. `redirected` rides back to
  // the caller so the toast can name where it really went and why.
  cls.modules = cls.modules || [];
  let redirected = '';
  let mod = spec.moduleId
    && (cls.modules || []).find(m => m.id === spec.moduleId && m.type === 'documents');
  if (!mod && spec.moduleId) {
    // Distinguish the two ways a chosen destination can miss, because they
    // mean different things to the user and one of them is a bug in whatever
    // supplied the id rather than a deleted module.
    const wrongType = (cls.modules || []).find(m => m.id === spec.moduleId);
    redirected = wrongType ? 'not-a-documents-module' : 'module-missing';
    console.warn('SOS generated-doc: destination module', spec.moduleId,
      wrongType ? `is a '${wrongType.type}' module, which cannot show a PDF`
                : 'no longer exists on this class', '— falling back');
  }
  if (!mod) {
    mod = (cls.modules || []).find(m => m.type === 'documents' && m.name === 'Generated');
  }
  if (!mod) {
    mod = {
      id: Date.now().toString(),
      name: 'Generated',
      type: 'documents',
      icon: 'doc',
      files: [], prompts: [], notes: [],
    };
    cls.modules.push(mod);
  }
  mod.files = mod.files || [];

  const meta0 = spec.meta || {};
  const name = String(spec.name || 'Generated deck.pdf');
  // A File, not a bare Blob: SosCloud.upload reads .name for the manifest and
  // the X-File-Name header, and a Blob would sync as "document".
  const file = new File([spec.blob], name, { type: 'application/pdf' });

  let fileId;
  try {
    fileId = await SosFileStore.saveBlob(file, name);
  } catch (e) {
    console.error('SOS generated-doc save failed:', name, e);
    showNotif('alert', 'Could not save', name + ' could not be stored on this device.');
    return null;
  }

  const meta = {
    id: fileId, name, size: file.size, mime: 'application/pdf', fileId,
    // `gen`, NOT `_sos`: _sosSerializeClasses() strips every underscore-prefixed
    // key on its way to localStorage and Firestore (they mark transient UI flags
    // like _uploading). Provenance stored under an underscore therefore vanished
    // on the first save — which also broke the dedup below, since the
    // sourceFileId it matches on had been deleted, so every regenerate stacked
    // another copy instead of replacing one.
    gen: { generated: true, ...meta0 },
  };

  // Replace the previous deck for this source rather than stacking copies.
  //
  // KEYED ON (sourceFileId, mode), NOT sourceFileId ALONE. Two pipelines can
  // generate from one lecture — a Claude rewrite (your slide images, rewritten
  // text) and a NotebookLM deck (a new deck built from the source) — and they
  // are different artifacts that should coexist. Matching on sourceFileId only
  // meant the second one REPLACED the first and then deleted its bytes below,
  // silently, with no way to get them back. Distinct filenames do not help:
  // the match is on provenance, not on name.
  //
  // `|| 'rewrite'` on BOTH sides so every doc filed before `mode` existed —
  // none of which carries one — still matches a rewrite re-run exactly as it
  // did before. Re-running either pipeline replaces only its own output.
  const priorMode = meta0.mode || 'rewrite';
  const prior = meta0.sourceFileId
    ? mod.files.findIndex(f => f && f.gen
        && f.gen.sourceFileId === meta0.sourceFileId
        && (f.gen.mode || 'rewrite') === priorMode)
    : -1;
  let old = null;
  if (prior >= 0) { old = mod.files[prior]; mod.files[prior] = meta; }
  else mod.files.push(meta);

  persistForCls(cls);

  // Cloud upload is awaited so the caller's "ready" toast means the file is
  // actually reachable from her phone, not merely written to this laptop.
  try {
    await sosUploadToCloud(file, meta, cls, mod, mod.id);
  } catch (e) {
    // The bytes are safe locally and the retry loop owns it from here.
    console.warn('SOS generated-doc cloud upload threw:', name, e);
  }

  // Drop the replaced file's bytes only after the new one is filed, so a
  // failure above never leaves her with neither.
  if (old && old.fileId && old.fileId !== fileId) {
    SosFileStore.delete(old.fileId).catch(() => {});
    try { SosCloud.remove(old.fileId, old.storageUrl); } catch (e) {}
  }

  try { if (currentClassId === cls.id) renderModules(cls); } catch (e) {}
  try { _sosRefreshModFiles(cls, mod, mod.id); } catch (e) {}

  /* Make the deck VISIBLE, not merely stored.
   *
   * _sosRefreshModFiles above repaints `doc-list-<modId>`, and returns silently
   * when that element is not in the DOM. That is every case that matters here:
   *
   *   - the destination module was CREATED by this function a moment ago, so it
   *     has never been rendered and owns no doc-list;
   *   - the module-detail modal is open on a DIFFERENT module (commonly the
   *     source one the run was started from), so the only doc-list present
   *     belongs to somewhere else;
   *   - the modal is open on THIS module, but was rendered before the file
   *     existed.
   *
   * In all three the deck finished, downloaded, uploaded and persisted, and the
   * screen kept showing exactly what it showed before — the "nothing happened"
   * that makes a working pipeline look broken until a manual reload. The
   * detail modal is re-rendered in place when it is already showing this
   * module, so the new file appears under the user's cursor rather than after
   * a reload.
   */
  try {
    if (_sosCurrentModuleId === mod.id && _sosCurrentModuleClassId === cls.id
        && document.querySelector('#modal-module-detail.open')) {
      const content = _sosEl('module-content-' + mod.id);
      if (content) { content.innerHTML = ''; renderModuleContent(content, cls, mod); }
    }
  } catch (e) {}

  // NOT _sosFileAdded: see the auto-run loop note above.
  //
  // moduleId/moduleName ride along so the caller's toast can say WHERE the deck
  // landed. The destination is frequently not the module the run was started
  // from — it can be one created by this call — and "Deck ready" naming only
  // the source file left the user hunting for it.
  // `redirected` is '' on the normal path. When set, the deck is filed and
  // safe, but NOT where it was asked to go — the toast says so rather than
  // letting her hunt for it in a module that no longer exists.
  return { title: name, meta, moduleId: mod.id, moduleName: mod.name || '',
           classId: cls.id, redirected };
};

/* Bring a module on screen. Used by the pipeline's "Deck ready" toast so the
 * finished deck is one click away instead of somewhere in the class. */
window._sosBridge.revealModule = (classId, moduleId) => {
  const cls = findClassOrKsu(classId);
  const mod = cls && (cls.modules || []).find(m => m.id === moduleId);
  if (!cls || !mod) return false;
  try {
    // Get the class itself on screen first: openModuleDetail renders into the
    // shared detail modal, and leaving the class view behind it stale means
    // closing the deck drops you somewhere unrelated.
    //
    // openClassDetail resolves through `classes`, which does NOT contain the
    // KSU pseudo-class — calling it for that id returns silently and leaves the
    // wrong class underneath. KSU modules have their own opener, so dispatch on
    // the same _ksu flag findClassOrKsu keys off.
    if (cls._ksu) {
      if (typeof openKsuModuleDetail === 'function') {
        openKsuModuleDetail(mod);
        return true;
      }
    } else if (currentClassId !== cls.id && typeof openClassDetail === 'function') {
      openClassDetail(cls.id);
    }
  } catch (e) {}
  try { openModuleDetail(cls, mod); return true; } catch (e) { return false; }
};

/* Create a module from outside this file (the deck sheet's "New module…").
 * Same shape saveModule() builds — all three arrays, whatever the type (see
 * DATA_MODEL "every module has all 3 arrays"). Returns the new module's id. */
window._sosBridge.addModule = (classId, name, type = 'documents') => {
  const cls = findClassOrKsu(classId);
  const clean = String(name || '').trim();
  if (!cls || !clean) return null;
  const ICON = { documents: 'doc', prompts: 'ai', notes: 'txt' };
  const mod = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 5),
    name: clean,
    type,
    icon: ICON[type] || 'doc',
    files: [], prompts: [], notes: [],
  };
  cls.modules = cls.modules || [];
  cls.modules.push(mod);
  persistForCls(cls);
  try { _sosRefreshModuleGrid(cls); } catch (e) {}
  return mod.id;
};

/* The topic breakdown's one-line summary on a file ({status, done, total}),
 * so a module's file list can show "12 topics" without loading any lessons.
 * `study`, never `_study`: _sosSerializeClasses strips underscore keys, and
 * the summary would vanish on the first save. null removes it. */
window._sosBridge.setFileStudy = (classId, moduleId, fileId, summary) => {
  const cls = findClassOrKsu(classId);
  if (!cls) return false;
  const mods = cls.modules || [];
  const mod = mods.find(m => m.id === moduleId && (m.files || []).some(f => f && f.id === fileId))
    || mods.find(m => (m.files || []).some(f => f && f.id === fileId));
  const f = mod && mod.files.find(x => x && x.id === fileId);
  if (!f) return false;
  if (summary) f.study = { ...summary, updatedAt: Date.now() };
  else delete f.study;
  persistForCls(cls);
  return true;
};

/* Add a prompt to a prompts module (the deck sheet's quick-add). */
window._sosBridge.addPromptTo = (classId, moduleId, text) => {
  const cls = findClassOrKsu(classId);
  const mod = cls && (cls.modules || []).find(m => m.id === moduleId && m.type === 'prompts');
  const clean = String(text || '').trim();
  if (!mod || !clean) return null;
  mod.prompts = mod.prompts || [];
  const p = { id: Date.now().toString(), text: clean };
  mod.prompts.push(p);
  persistForCls(cls);
  return p.id;
};

/* Per-module default prompt (spec P-4). Stored on the module so it rides the
 * same Firestore document as everything else and syncs across devices for
 * free, rather than becoming a second thing to keep in step. */
window._sosBridge.setModuleDefaultPrompt = (classId, moduleId, promptId) => {
  const cls = findClassOrKsu(classId);
  if (!cls) return false;
  const mod = (cls.modules || []).find(m => m.id === moduleId);
  if (!mod) return false;
  if (promptId) mod.defaultPromptId = String(promptId);
  else delete mod.defaultPromptId;
  persistForCls(cls);
  return true;
};

/* Fired by the upload path when a file lands in a module, so P-4's auto-run
 * can pick it up. Dispatched as an event rather than calling the pipeline
 * directly: studyos.js is a classic script and must not import an ES module,
 * and this keeps the pipeline entirely optional — with the feature off, this
 * event simply has no listener. */
function _sosFileAdded(cls, mod, file) {
  if (!cls || !mod || !file) return;
  if (!mod.defaultPromptId) return;
  try {
    window.dispatchEvent(new CustomEvent('sos-file-added', {
      detail: { classId: cls.id, moduleId: mod.id, file, promptId: mod.defaultPromptId },
    }));
  } catch (e) {}
}

/* A file's bytes, for the local pipeline bridge (tools/sos-browser).
 *
 * The Cloudflare Worker fetches the source from studyos-files itself, but the
 * local bridge drives a browser on this machine and has no access to that
 * store, so it needs the actual blob. Exposed rather than reimplemented in the
 * module: sosResolveBlob already tries IndexedDB, falls back to the cloud copy
 * and caches it back, and a second copy of that logic would drift. */
window._sosBridge.resolveBlob = (file) => sosResolveBlob(file);

window._sosBridge.getSnapshot = () => {
  try {
    return JSON.parse(JSON.stringify({
      classes: _sosSerializeClasses(),
      events, tasks, notes: notesList, ksu: ksuData,
    }));
  } catch (e) { return null; }
};

/* Both a local edit (sos-changed, emitted by the persist* functions) and a
 * remote one (fb-sos-remote, from firebase-sync.js) mean "the data moved".
 * Subscribers almost always want both, so this collapses them into one
 * callback and hands back an unsubscribe. */
window._sosBridge.subscribe = (fn) => {
  if (typeof fn !== 'function') return () => {};
  const onLocal  = (e) => { try { fn((e.detail && e.detail.entity) || 'all', 'local'); } catch (_) {} };
  const onRemote = () => { try { fn('all', 'remote'); } catch (_) {} };
  window.addEventListener('sos-changed', onLocal);
  window.addEventListener('fb-sos-remote', onRemote);
  return () => {
    window.removeEventListener('sos-changed', onLocal);
    window.removeEventListener('fb-sos-remote', onRemote);
  };
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
    try { _sosLsSet('studyos_d2l', JSON.stringify(d2lMap)); } catch (e) {}
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

/* ===== STICKY CLASS HEADER =====
 * .detail-header is position:sticky inside its scrolling .view. The Upcoming /
 * Resources rail is sticky in the same view, so it has to start below the
 * header — publish the header's measured height as --sos-sticky-top rather
 * than hard-coding a number that a wrapped title would break. */
function sosSyncStickyHeader() {
  document.querySelectorAll('#study-root .view > .detail-header').forEach(function (h) {
    var v = h.parentElement;
    if (h.offsetHeight) v.style.setProperty('--sos-sticky-top', h.offsetHeight + 'px');
  });
}
(function () {
  var heads = document.querySelectorAll('#study-root .view > .detail-header');
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(sosSyncStickyHeader);
    heads.forEach(function (h) { ro.observe(h); });
  }
  window.addEventListener('resize', sosSyncStickyHeader);
  sosSyncStickyHeader();
})();

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
