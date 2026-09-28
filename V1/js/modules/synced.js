/* ============================================================================
 * StudyOS — synced list  (engagement upgrade, shared plumbing)
 * ============================================================================
 * A list of records that lives in localStorage AND in its own Firestore
 * document, merged by id. Quizzes and progress both need exactly this, and
 * the cards store (deck.js) is the precedent it generalises.
 *
 * ── WHY NOT THE MAIN SYNC DOCUMENT ────────────────────────────────────────
 * Same reason as deck.js: that document is a whole-document last-write-wins
 * setDoc, and this data is written from whichever device she is studying on.
 * Here every write contains the UNION of what this device has seen, so a
 * whole-document write can never erase another device's records.
 *
 * ── DELETIONS ARE TOMBSTONES ──────────────────────────────────────────────
 * A union merge cannot tell "deleted here" from "not yet seen there": the
 * other device's copy simply re-adds it. So remove() keeps `{id, deleted:true,
 * updatedAt}` and readers skip it. (The cold-load bug that resurrected deleted
 * StudyOS items was this exact shape.)
 *
 * ── SCHEMA VERSION ────────────────────────────────────────────────────────
 * Every stored document carries `v`. migrate.js upgrades an older document on
 * read, so a record written by an old build is converted, never discarded.
 * ------------------------------------------------------------------------- */

import { upgrade } from './migrate.js';

const DEBOUNCE_MS = 600;
const TOMBSTONE_TTL_MS = 120 * 86400000;   // long enough for every device to see it

/**
 * @param {object} o
 * @param {string} o.kind      migrate.js key, e.g. 'quiz'
 * @param {string} o.lsKey     localStorage key
 * @param {string} o.docPath   Firestore document path
 * @param {(a:object,b:object)=>object} [o.merge]  pick/merge two copies of one id
 */
export function syncedList({ kind, lsKey, docPath, merge }) {
  let mem = null;
  let timer = null;
  const pick = merge || ((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a));

  function read() {
    if (mem) return mem;
    try {
      const raw = localStorage.getItem(lsKey);
      const doc = raw ? upgrade(kind, JSON.parse(raw)) : null;
      mem = doc && Array.isArray(doc.items) ? doc.items : [];
    } catch (e) {
      console.warn('[synced] unreadable', lsKey, e);
      mem = [];
    }
    return mem;
  }

  function emit() {
    try { window.dispatchEvent(new CustomEvent('sos-changed', { detail: { entity: kind } })); }
    catch (e) {}
  }

  function persist() {
    const now = Date.now();
    // Tombstones only need to outlive the slowest device's next sync.
    mem = read().filter((r) => !r.deleted || now - (r.updatedAt || 0) < TOMBSTONE_TTL_MS);
    const doc = { v: 1, items: mem };
    try { localStorage.setItem(lsKey, JSON.stringify(doc)); }
    catch (e) { console.warn('[synced] could not save', lsKey, e); }
    emit();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try { if (window._fbSaveDoc) window._fbSaveDoc(docPath, doc); }
      catch (e) { console.warn('[synced] cloud save failed', docPath, e); }
    }, DEBOUNCE_MS);
  }

  /** Union a list of records into memory. Returns true if anything changed. */
  function unionIn(list) {
    const byId = new Map(read().map((r) => [r.id, r]));
    let changed = false;
    for (const r of list || []) {
      if (!r || !r.id) continue;
      const cur = byId.get(r.id);
      const next = cur ? pick(cur, r) : r;
      if (next !== cur) { byId.set(r.id, next); changed = true; }
    }
    if (changed) mem = [...byId.values()];
    return changed;
  }

  const api = {
    /** Live records (tombstones skipped). */
    all() { return read().filter((r) => !r.deleted); },
    get(id) { return read().find((r) => r.id === id && !r.deleted) || null; },

    /** Insert or replace records by id, stamping updatedAt. */
    upsert(items) {
      const now = Date.now();
      const list = (Array.isArray(items) ? items : [items]).filter(Boolean)
        .map((r) => ({ ...r, updatedAt: now }));
      if (!list.length) return [];
      const byId = new Map(read().map((r) => [r.id, r]));
      for (const r of list) byId.set(r.id, r);
      mem = [...byId.values()];
      persist();
      return list;
    },

    remove(ids) {
      const set = new Set(Array.isArray(ids) ? ids : [ids]);
      const now = Date.now();
      let hit = false;
      mem = read().map((r) => {
        if (!set.has(r.id) || r.deleted) return r;
        hit = true;
        return { id: r.id, deleted: true, updatedAt: now };
      });
      if (hit) persist();
      return hit;
    },

    /** Merge a remote document's items. Writes back only when this device
     *  holds something the remote lacks (a record, or a newer copy of one), so
     *  two devices converge instead of ping-ponging identical writes. */
    applyRemote(data) {
      const doc = data ? upgrade(kind, data) : null;
      if (!doc || !Array.isArray(doc.items)) return false;
      const changed = unionIn(doc.items);
      if (changed) {
        try { localStorage.setItem(lsKey, JSON.stringify({ v: 1, items: mem })); } catch (e) {}
        emit();
      }
      const remote = new Map(doc.items.filter(Boolean).map((r) => [r.id, r]));
      const ahead = read().some((r) => {
        const rr = remote.get(r.id);
        return !rr || pick(rr, r) !== rr;
      });
      if (ahead) persist();
      return changed;
    },

    /** Load once from the cloud and keep listening. */
    connect() {
      if (!window._fbLoadDoc) return;
      window._fbLoadDoc(docPath).then((d) => { if (d) api.applyRemote(d); }).catch(() => {});
      window.addEventListener('fb-doc-remote', (e) => {
        const d = (e && e.detail) || {};
        if (d.path === docPath) api.applyRemote(d.data);
      });
    },

    /** Test hook: forget the in-memory copy so the next read hits storage. */
    _reset() { mem = null; if (timer) { clearTimeout(timer); timer = null; } },
  };
  return api;
}

export default { syncedList };
