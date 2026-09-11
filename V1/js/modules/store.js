/* ============================================================================
 * StudyOS — store facade  (ticket F-2)
 * ============================================================================
 * The typed read surface over StudyOS's data, plus one place to subscribe to
 * changes. New feature modules talk to THIS, not to js/studyos.js.
 *
 * ── WHY THIS HOLDS NO STATE ───────────────────────────────────────────────
 * F-2 as written asked for "a single source of truth" owning classes/events/
 * tasks, with the persist* functions delegating to it. That is not implementable
 * here without the rewrite rule 1 forbids:
 *
 *   `classes`, `events`, `tasks`, `notesList` and `ksuData` are top-level `let`
 *   bindings in js/studyos.js, which is a CLASSIC script. Every ES module on
 *   the page is deferred, so this file is guaranteed to execute AFTER
 *   studyos.js has already parsed localStorage, populated those bindings and
 *   rendered the first frame. A module-owned copy would be a SECOND source of
 *   truth that is already stale on arrival, and ~4,700 lines would go on
 *   mutating the originals directly.
 *
 * So the real single source of truth stays where it already is, and this file
 * is a facade over window._sosBridge — the seam studyos.js already documents as
 * "the one supported way in and out". Consumers get the typed API and the event
 * bus F-2 wanted; nobody gets a duplicate of the data.
 *
 * Migrating a feature out of studyos.js later means moving its state INTO the
 * bridge, not into this file. This module's shape does not change when that
 * happens — which is the point.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────
 *   import { store } from './store.js';
 *   const off = store.on('tasks', () => repaint());   // also fires on remote
 *   store.getTasks();
 *   off();
 * ------------------------------------------------------------------------- */

/** The bridge, or null when studyos.js has not booted yet. */
function bridge() {
  return (typeof window !== 'undefined' && window._sosBridge) || null;
}

/** Read through the bridge, falling back to `fallback` before boot. */
function read(method, fallback, ...args) {
  const B = bridge();
  if (!B || typeof B[method] !== 'function') return fallback;
  try {
    const v = B[method](...args);
    return v == null ? fallback : v;
  } catch (e) {
    console.warn(`[store] ${method} failed:`, e);
    return fallback;
  }
}

export const store = {
  /** True once studyos.js has installed the bridge. */
  get ready() { return !!bridge(); },

  // ── Reads ───────────────────────────────────────────────────────────────
  // These return studyos.js's LIVE arrays. Treat them as read-only: mutating
  // one persists nothing and repaints nothing, and the next remote sync will
  // discard the change. Use the writes below instead.
  getClasses: () => read('getClasses', []),
  getEvents:  () => read('getEvents', []),
  getTasks:   () => read('getTasks', []),
  getNotes:   () => read('getNotes', []),
  getKsu:     () => read('getKsu', { modules: [] }),
  getModules: (classId) => read('getModules', [], classId),
  getD2LMap:  () => read('getD2LMap', null),

  /** One class by id, or null. */
  getClass(id) {
    return this.getClasses().find(c => c && c.id === id) || null;
  },

  /**
   * A deep COPY of everything, safe to index, cache or hand to a worker
   * without aliasing live state. Returns null if the bridge isn't up.
   */
  getSnapshot: () => read('getSnapshot', null),

  // ── Writes ──────────────────────────────────────────────────────────────
  // Deliberately narrow. Each one routes to a bridge setter that persists AND
  // repaints; there is no generic "set anything" escape hatch, because that is
  // how the two-sources-of-truth problem gets in through the back door.
  /** Tick/untick a task. Returns true if something actually changed. */
  setTaskDone(taskId, done) {
    const B = bridge();
    if (!B || typeof B.setTaskDone !== 'function') return false;
    try { return !!B.setTaskDone(taskId, !!done); }
    catch (e) { console.warn('[store] setTaskDone failed:', e); return false; }
  },

  // ── Subscription ────────────────────────────────────────────────────────
  /**
   * Subscribe to data changes. `entity` is one of
   * 'classes' | 'events' | 'tasks' | 'notes' | 'ksu' | 'all', or '*' for every
   * change. The callback receives (entity, origin) where origin is
   * 'local' (this tab edited) or 'remote' (another device synced in).
   *
   * A remote sync replaces the whole document, so it always reports 'all' —
   * an 'all' notification means "everything you cached may be stale".
   *
   * Returns an unsubscribe function.
   */
  on(entity, fn) {
    const B = bridge();
    if (!B || typeof B.subscribe !== 'function' || typeof fn !== 'function') {
      return () => {};
    }
    return B.subscribe((changed, origin) => {
      if (entity === '*' || changed === entity || changed === 'all') {
        fn(changed, origin);
      }
    });
  },

  /**
   * Run `fn` once the bridge exists, then on every change. Saves every caller
   * from writing the same "render now, and again when it moves" pair, and
   * handles the case where this module loaded before studyos.js booted.
   */
  onReady(fn) {
    if (typeof fn !== 'function') return () => {};
    let off = () => {};
    const start = () => {
      off = this.on('*', fn);
      try { fn('all', 'init'); } catch (e) { console.warn('[store] init cb failed:', e); }
    };
    if (this.ready) start();
    else {
      // studyos.js installs the bridge during its boot; poll briefly rather
      // than depend on a load-order guarantee that deferred modules don't give.
      let tries = 0;
      const t = setInterval(() => {
        if (this.ready) { clearInterval(t); start(); }
        else if (++tries > 100) clearInterval(t);   // ~10s, then give up quietly
      }, 100);
    }
    return () => off();
  },
};

export default store;
