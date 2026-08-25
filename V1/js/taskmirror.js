/* ============================================================================
 * StudyOS — task mirror into TaskHub (Index project)
 * ============================================================================
 * Pushes StudyOS's dated tasks and events into Veda's weekly TaskHub, which
 * lives in a SEPARATE deployment (the Index project).
 *
 * ── WHY THIS EXISTS IN THIS FORM ──────────────────────────────────────────
 * Originally StudyOS and TaskHub shared one HTML page, so the mirror was four
 * in-page function calls (window._vedaAddTask / _vedaUpdateTask /
 * _vedaRemoveTask / _vedaTogTask). Across two separately-hosted pages a JS
 * global call is physically impossible, so the transport is shared Firestore.
 *
 * ── NO-CLOBBER GUARANTEE ──────────────────────────────────────────────────
 * TaskHub saves its document with a whole-document setDoc(). If StudyOS also
 * wrote that document, last-writer-wins would silently destroy habits, goals
 * or same-day edits made on the other side. So the two apps never share a
 * writable document. Two docs, exactly one writer each:
 *
 *   mirrorDoc   StudyOS WRITES  →  TaskHub READS   (the StudyOS-derived items)
 *   ackDoc      TaskHub WRITES  →  StudyOS READS   (done-state flips)
 *
 * ── DERIVED, NOT INCREMENTAL ──────────────────────────────────────────────
 * The mirror is rebuilt in full from `tasks` + `events` + `classes` on every
 * change, rather than being mutated by the four legacy calls. That is a
 * deliberate upgrade: the incremental version could drift permanently if a
 * single call was missed (a crash mid-edit, a call fired before this module
 * finished loading, an edit made on a device that was offline). A derived
 * mirror is idempotent and self-healing — any write reconciles the whole set.
 *
 * The four legacy globals are still defined, because js/studyos.js calls them
 * throughout and they are its only signal that dated data changed. Here they
 * are simply "something moved, rebuild soon" triggers. That is why studyos.js
 * needed no edits for any of this.
 *
 * A side benefit: repeating EVENTS used to be mirrored under a freshly minted
 * id that matched no stored event, so a done-tick could never be routed back.
 * Deriving from source means every item carries its real id.
 * ------------------------------------------------------------------------- */

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js';
import { getFirestore, doc, setDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';

const CFG = window.STUDYOS_CONFIG || {};
const TM  = CFG.taskMirror || {};

/* Defined immediately, before any await, so a very early edit can't hit an
 * undefined global. Each one only marks the mirror dirty. */
let _dirty = () => {};
window._vedaAddTask    = () => _dirty();
window._vedaUpdateTask = () => _dirty();
window._vedaRemoveTask = () => _dirty();
window._vedaTogTask    = () => _dirty();

/* ── Build ──────────────────────────────────────────────────────────────────
 * Derives the complete mirror from StudyOS's live arrays. Defined at module
 * scope (not inside the connected branch) so it is always callable — exposed as
 * window._sosMirrorBuild() it answers "what would we push right now?" even when
 * the transport is idle, which is the fastest way to diagnose a mirror problem.
 *
 * The shape matches what the old in-page mirror produced, so the TaskHub side
 * needed no new item handling. dateKey matches TaskHub's own dkey():
 * 'YYYY-MM-DD', zero-padded, month 1-based. */
function _sosToKey(d) {
  if (!d || typeof d !== 'string') return null;
  const [y, m, dd] = d.split('-').map(Number);
  if (!y || !m || !dd) return null;
  return y + '-' + String(m).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
}

function buildItems() {
  const B = window._sosBridge;
  if (!B) return null;                       // studyos.js hasn't booted yet
  const byId = {};
  (B.getClasses() || []).forEach(c => { if (c && c.id) byId[c.id] = c; });

  const items = {};

  (B.getTasks() || []).forEach(t => {
    if (!t || !t.id) return;
    const key = _sosToKey(t.dueDate);
    if (!key) return;                        // undated tasks don't belong on a weekly grid
    const c = byId[t.classId] || null;
    const sid = 't_' + t.id;
    items[sid] = {
      id: 'sos_t_' + t.id, _sosId: sid,
      type: 'task', title: String(t.name || 'Untitled'),
      category: 'study', done: !!t.done,
      dateKey: key,
      _sosClassName: c ? c.name : '',
      _sosClassColor: c ? c.color : '',
      _sosClassId: c ? c.id : '',
      ...(t.repeatId ? { _sosRepeatId: 't_' + t.repeatId } : {}),
    };
  });

  (B.getEvents() || []).forEach(e => {
    if (!e || !e.id) return;
    const key = _sosToKey(e.date);
    if (!key) return;
    const c = byId[e.classId] || null;
    items[e.id] = {
      id: 'sos_' + e.id, _sosId: e.id,
      type: 'event', title: String(e.name || 'Untitled'),
      time: e.time || '', category: 'study', done: false,
      dateKey: key,
      _sosClassName: c ? c.name : '',
      _sosClassColor: c ? c.color : '',
      _sosClassId: c ? c.id : '',
      ...(e.repeatId ? { _sosRepeatId: e.repeatId } : {}),
    };
  });

  return items;
}
window._sosMirrorBuild = buildItems;

/* ── Class resources ────────────────────────────────────────────────────────
 * The per-class websites/apps a TaskHub card can launch (studyos.js
 * saveResource). Published as a SIDE TABLE keyed by classId, never as a
 * payload on each item, for two reasons:
 *
 *  1. TaskHub's reconcile signature (index.html sig()) hashes exactly
 *     [_sosId, title, done, time, _sosClassName]. A resource blob riding on an
 *     item would not change that signature, so the reconcile would decide
 *     nothing had changed and the edit would be SILENTLY DROPPED. Widening
 *     sig() instead would make every label typo trigger a full strip-and-
 *     re-add of every StudyOS row plus a whole-document vedasdash write.
 *  2. Resources live once per class rather than once per task.
 *
 * Keeping them out of `items` means resources never enter TaskHub's `data` at
 * all: sig() and the reconcile effect stay untouched, and a resource edit
 * costs one mirror write and zero vedasdash writes. */
function buildClasses() {
  const B = window._sosBridge;
  if (!B) return null;
  const out = {};
  (B.getClasses() || []).forEach(c => {
    if (!c || !c.id) return;
    const res = (c.resources || []).map(r => r.kind === 'app'
      // r.path is deliberately omitted — see classAppsDoc in config §taskMirror.
      ? { id: r.id, kind: 'app', label: r.label }
      : { id: r.id, kind: 'web', label: r.label, url: r.url });
    if (!res.length) return;              // only classes that actually have any
    out[c.id] = { name: c.name, color: c.color, resources: res };
  });
  return out;
}
window._sosMirrorBuildClasses = buildClasses;

/* Native-app paths, for the Shield desktop agent only. Separate document so
 * these never reach a phone (see buildClasses). */
function buildClassApps() {
  const B = window._sosBridge;
  if (!B) return null;
  const out = {};
  (B.getClasses() || []).forEach(c => {
    if (!c || !c.id) return;
    const apps = (c.resources || [])
      .filter(r => r && r.kind === 'app' && r.path)
      .map(r => ({ id: r.id, label: r.label, path: r.path }));
    if (apps.length) out[c.id] = apps;
  });
  return out;
}
window._sosMirrorBuildApps = buildClassApps;

if (TM.enabled === false) {
  console.info('[StudyOS] Task mirror disabled — StudyOS will not push to TaskHub.');
} else if (!window.STUDYOS_CONFIG_READY || !window.STUDYOS_CONFIG_READY('firebase')) {
  console.info('[StudyOS] Task mirror idle — Firebase is not configured yet (config §1).');
} else {
  /* ── Connection ──────────────────────────────────────────────────────────
   * By default reuse the app firebase-sync.js already created. If the mirror
   * lives in a DIFFERENT Firebase project (StudyOS keeps its own data
   * elsewhere), open a second, separately-named app just for these two docs. */
  let db;
  try {
    if (TM.firebase && TM.firebase.projectId) {
      const existing = getApps().find(a => a.name === 'studyos-mirror');
      const app = existing || initializeApp(TM.firebase, 'studyos-mirror');
      // A second project needs its own anonymous session before its rules pass.
      signInAnonymously(getAuth(app)).catch(e =>
        console.warn('[StudyOS] Mirror project anon auth failed:', e && e.code,
          '\n→ enable Anonymous sign-in on the mirror Firebase project too.'));
      db = getFirestore(app);
    } else {
      const app = getApps()[0];
      if (!app) throw new Error('no Firebase app');
      db = getFirestore(app);
    }
  } catch (e) {
    console.warn('[StudyOS] Task mirror could not connect:', e && e.message);
  }

  if (db) {
    const mirrorRef = doc(db, TM.mirrorDoc || 'dashboards/studyos_mirror');
    const ackRef    = doc(db, TM.ackDoc    || 'dashboards/studyos_mirror_ack');
    const appsRef   = doc(db, TM.classAppsDoc || 'dashboards/studyos_class_apps');

    /* ── Write ────────────────────────────────────────────────────────────
     * Debounced, and skipped entirely when nothing actually changed. The
     * no-change skip matters: TaskHub merging our items into its own document
     * triggers its save, which we must not answer with another write, or the
     * two apps ping-pong forever. */
    let lastSerialized = null;
    let lastAppsSerialized = null;
    let timer = null;

    async function flush() {
      timer = null;
      const items = buildItems();
      if (!items) return;
      const cls = buildClasses() || {};
      // The compare MUST span items AND classes. Keyed on items alone, a
      // pure-resource edit (no task touched) would look unchanged and never
      // be written at all.
      const serialized = JSON.stringify([items, cls]);
      if (serialized !== lastSerialized) {
        try {
          await setDoc(mirrorRef, { items, classes: cls, savedAt: Date.now(), app: 'studyos' });
          lastSerialized = serialized;
        } catch (err) {
          // Leave lastSerialized alone so the next trigger retries this state.
          console.warn('[StudyOS] Task mirror write failed:', err && err.code);
        }
      }

      /* Native-app paths for Shield, in their own document and on their own
       * change-compare: app paths move roughly once a semester, so this
       * almost never writes even when tasks are churning. */
      const apps = buildClassApps() || {};
      const appsSerialized = JSON.stringify(apps);
      if (appsSerialized !== lastAppsSerialized) {
        try {
          await setDoc(appsRef, { apps, savedAt: Date.now(), app: 'studyos' });
          lastAppsSerialized = appsSerialized;
        } catch (err) {
          console.warn('[StudyOS] Class-apps write failed:', err && err.code);
        }
      }
    }

    function schedule(delay) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay == null ? 1200 : delay);
    }
    _dirty = () => schedule();

    /* ── Ack: TaskHub ticked one of our items ─────────────────────────────
     * Only task done-state comes back. Events have no done-state in StudyOS,
     * so an ack for one is ignored rather than invented. */
    let ackApplying = false;
    onSnapshot(ackRef, (snap) => {
      if (!snap.exists()) return;
      const done = (snap.data() || {}).done || {};
      const B = window._sosBridge;
      if (!B) return;
      let changed = false;
      ackApplying = true;
      try {
        Object.keys(done).forEach(sid => {
          if (sid.indexOf('t_') !== 0) return;    // tasks only
          if (B.setTaskDone(sid.slice(2), !!done[sid])) changed = true;
        });
      } finally { ackApplying = false; }
      // Re-derive so the mirror reflects the state TaskHub just told us about;
      // without this our next write would push the old done-flag straight back.
      if (changed) schedule(400);
    }, (err) => console.warn('[StudyOS] Task mirror ack listener error:', err && err.code));

    /* ── Triggers ─────────────────────────────────────────────────────────
     * Beyond the four legacy calls: a full push once StudyOS has booted (so a
     * fresh device populates TaskHub without anyone editing anything), and
     * after remote StudyOS data lands from another device. */
    const kick = () => schedule(1500);
    if (window.SOS_GATE && window.SOS_GATE.then) window.SOS_GATE.then(kick, () => {});
    else kick();
    window.addEventListener('fb-sos-remote', kick);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(3000); });

    /* Manual escape hatch for debugging: window._sosMirrorNow() */
    window._sosMirrorNow = () => { lastSerialized = null; lastAppsSerialized = null; return flush(); };
  }
}
