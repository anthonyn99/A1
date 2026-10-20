// Media made in Shruti: where its files go (Drive, through the shruti-drive
// worker), and how its versions are kept.
//
// A chapter can have several versions of one kind (podcast, video, read,
// lessons). Each is kept under versions.<book>.ch<n>.<kind>.<id>, and the one
// that plays is copied to assets.<book>.ch<n>.<kind> (what the players and the
// mode badges read). With no featured version, the shipped one plays. Shared
// books keep all this in dashboards/shruti_shared, so both profiles see it;
// a personal book keeps it in the person's own doc.
//
// While something is being made, jobs.<book>.ch<n>.<kind> says who, and how
// far, so another device shows "Veda is making a podcast… 12 of 80".

import * as C from './core.js';

export const DRIVE = 'https://shruti-drive.av1-2.workers.dev';
export const KINDS = ['podcast', 'video', 'read', 'lessons'];
export const KIND_NAME = { podcast: 'Podcast', video: 'Video', read: 'Read-aloud', lessons: 'Lessons' };
const JOB_FRESH = 10 * 60 * 1000;
const keyOf = () => String(C.me.get('orcaKey', '') || '');

/** Shared books' media lives in the shared doc; personal books' in the person's. */
const personal = new Set();
export function markPersonal(book, yes = true) { if (yes) personal.add(book); else personal.delete(book); }
export const docFor = (book) => (personal.has(book) ? C.me : C.shared);
const base = (book, n) => book + '.ch' + n;

/* ── Drive ───────────────────────────────────────────────────────────────── */
export async function driveReady() {
  const h = await fetch(DRIVE + '/health').then((r) => r.json()).catch(() => null);
  return !!(h && h.connected);
}
/** Upload one file to Shruti/<book>/ch<n>/ on Drive (or Shruti/<book>/<chapter>/,
 *  e.g. "source" for an imported book's original). Resolves {id, size, store}. */
export async function upload({ book, n, chapter, body, type, name, key = keyOf() }) {
  const owner = C.P || 'tony';
  const r = await fetch(DRIVE + '/f?book=' + encodeURIComponent(book) + '&chapter=' + encodeURIComponent(chapter || 'ch' + n) + '&name=' + encodeURIComponent(name) + '&owner=' + owner,
    { method: 'PUT', headers: { authorization: 'Bearer ' + key, 'content-type': type }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error('Drive upload failed (' + (j.error || r.status) + ')');
  return { id: j.id, size: j.size, store: j.store || 'gdrive' };
}
async function dropFile(f, key = keyOf()) {
  if (!f || !f.id) return;
  try { await fetch(DRIVE + '/f/' + encodeURIComponent(f.id), { method: 'DELETE', headers: { authorization: 'Bearer ' + key } }); } catch (e) {}
}

/* ── versions ────────────────────────────────────────────────────────────── */
export const newId = () => 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
/** Keep a new version; feature it (play it) unless feature:false. Resolves its id. */
export function record(book, n, kind, rec, { feature = true } = {}) {
  const id = rec.id || newId();
  const full = Object.assign({}, rec, { id, by: rec.by || C.P || 'tony', at: rec.at || Date.now() });
  const patch = { ['versions.' + base(book, n) + '.' + kind + '.' + id]: full };
  if (feature) patch['assets.' + base(book, n) + '.' + kind] = full;
  docFor(book).set(patch, { now: true });
  return id;
}
/** Every saved version, newest first. Older records (before versions) count too. */
export function versions(book, n, kind) {
  const d = docFor(book);
  const v = d.get('versions.' + base(book, n) + '.' + kind, {}) || {};
  const list = Object.entries(v).filter(([, r]) => r && typeof r === 'object').map(([id, r]) => Object.assign({}, r, { id }));
  const cur = d.get('assets.' + base(book, n) + '.' + kind, null);
  if (cur && cur.mp3 && !cur.id) list.push(Object.assign({}, cur, { id: 'legacy' }));
  else if (cur && kind === 'lessons' && !cur.id) list.push(Object.assign({}, cur, { id: 'legacy' }));
  return list.sort((a, b) => (b.at || 0) - (a.at || 0));
}
/** The id of the version that plays, or null (the shipped one, if any). */
export function featured(book, n, kind) {
  const cur = docFor(book).get('assets.' + base(book, n) + '.' + kind, null);
  return cur ? cur.id || 'legacy' : null;
}
/** Play this version; null plays the shipped one again. */
export function feature(book, n, kind, id) {
  const d = docFor(book), key = 'assets.' + base(book, n) + '.' + kind;
  if (!id) { d.set({ [key]: C.DELETE }, { now: true }); return; }
  const r = versions(book, n, kind).find((x) => x.id === id);
  if (r) d.set({ [key]: r }, { now: true });
}
/** Delete a version and its files on Drive. The newest other one plays if this one did. */
export async function remove(book, n, kind, id) {
  const d = docFor(book), all = versions(book, n, kind), r = all.find((x) => x.id === id);
  if (!r) return;
  const wasFeatured = featured(book, n, kind) === id;
  const patch = {};
  if (id !== 'legacy') patch['versions.' + base(book, n) + '.' + kind + '.' + id] = C.DELETE;
  if (wasFeatured) {
    const next = all.find((x) => x.id !== id);
    patch['assets.' + base(book, n) + '.' + kind] = next || C.DELETE;
  }
  d.set(patch, { now: true });
  await Promise.all([dropFile(r.mp3), dropFile(r.json)]);
}

/* ── jobs: who is making what, synced ────────────────────────────────────── */
/** status: {kind, stage, done, total, model} or null when finished. */
export function job(book, n, kind, status, { now = false } = {}) {
  const key = 'jobs.' + base(book, n) + '.' + kind;
  if (!status) { docFor(book).set({ [key]: C.DELETE }, { now: true }); return; }
  docFor(book).set({ [key]: Object.assign({ by: C.P || 'tony', at: Date.now() }, status) }, now ? { now: true } : { lazy: true });
}
/** A job still running somewhere (seen within the last 10 minutes), or null. */
export function jobOf(book, n, kind) {
  const j = docFor(book).get('jobs.' + base(book, n) + '.' + kind, null);
  return j && Date.now() - (j.at || 0) < JOB_FRESH ? j : null;
}
