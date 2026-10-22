// Imported books (Phase 8). A book's contents live in a doc's books.<id>:
// the shared doc for a book both see, the person's own for theirs ("Mine").
// Each chapter's text is a document of its own beside it,
//   dashboards/<doc>/texts/<book>_<file>
// (Firestore, like everything else Shruti keeps; Drive is for media). A
// chapter over ~700 KB is cut into parts <book>_<file>~1, ~2, ... The
// original file goes to Drive too when Drive is connected (src.drive).
//
//   books.<id> = {id, title, author, unit, chapters:[{n, title, file, words}],
//                 words, at, by, src:{name, kind, size, drive?}, how, imported:true}

import * as C from './core.js';
import * as M from './media.js';

const PART = 700000;   // bytes of JSON per text document (the limit is 1 MiB)
const docOf = (where) => (where === 'mine' ? C.me : C.shared);
const pathOf = (where) => (where === 'mine' ? C.me.path : C.shared.path);

/** Every imported book: {shared:[...], mine:[...]}. Mine are marked personal,
 *  so their media, sets and jobs go to the person's own doc (media.js). */
export function list() {
  const pick = (d) => Object.values(d.get('books', {}) || {}).filter((b) => b && b.id && Array.isArray(b.chapters));
  const mine = pick(C.me), shared = pick(C.shared);
  mine.forEach((b) => M.markPersonal(b.id));
  return { shared, mine };
}
export function whereOf(id) {
  if ((C.me.get('books.' + id, null) || {}).id) return 'mine';
  if ((C.shared.get('books.' + id, null) || {}).id) return 'shared';
  return null;
}
/** Both docs have answered (or 8 s went by): only then can "no such book" be said. */
function loaded() {
  if (C.me.loaded && C.shared.loaded) return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(done, 8000);
    const offs = [C.on('doc:me', check), C.on('doc:shared', check)];
    function check() { if (C.me.loaded && C.shared.loaded) done(); }
    function done() { clearTimeout(t); offs.forEach((f) => f()); res(); }
  });
}
/** An imported book's contents (the same shape as a shipped book.json). */
export async function get(id) {
  let w = whereOf(id);
  if (!w) { await loaded(); w = whereOf(id); }
  if (!w) throw new Error('This book is not in your library (it may have been deleted).');
  if (w === 'mine') M.markPersonal(id);
  return Object.assign({ shared: w === 'shared', where: w }, docOf(w).get('books.' + id));
}

/* ── chapter texts ───────────────────────────────────────────────────────── */
const texts = new Map();   // "<book>/<file>" -> Promise<chapter>
const bytes = (s) => new TextEncoder().encode(s).length;
/** Cut a JSON string into parts of at most `max` UTF-8 bytes. A surrogate
 *  pair counts 4 on its first half and 0 on its second, so it is never split. */
export function parts(json, max = PART) {
  if (bytes(json) <= max) return [json];
  const out = [];
  let start = 0, size = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    const b = c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xD800 && c <= 0xDBFF ? 4 : c >= 0xDC00 && c <= 0xDFFF ? 0 : 3;
    if (size + b > max) { out.push(json.slice(start, i)); start = i; size = 0; }
    size += b;
  }
  out.push(json.slice(start));
  return out;
}
const textRef = async (where, id, file, part) => {
  const { db, fs } = await C.firebase();
  return fs.doc(db, pathOf(where) + '/texts/' + id + '_' + file + (part ? '~' + part : ''));
};
export async function chapter(id, file) {
  const k = id + '/' + file;
  if (!texts.has(k)) {
    texts.set(k, (async () => {
      const b = await get(id);
      const { fs } = await C.firebase();
      const first = await fs.getDoc(await textRef(b.where, id, file, 0));
      if (!first.exists()) throw new Error('This chapter\'s text is missing.');
      const d = first.data(), n = Number(d.n) || 1;
      const rest = await Promise.all(Array.from({ length: n - 1 }, (_, i) => textRef(b.where, id, file, i + 1).then((r) => fs.getDoc(r))));
      return JSON.parse(d.s + rest.map((x) => (x.exists() ? x.data().s : '')).join(''));
    })().catch((e) => { texts.delete(k); throw e; }));
  }
  return texts.get(k);
}
async function writeText(where, id, file, ch) {
  const { fs } = await C.firebase();
  const ps = parts(JSON.stringify(ch));
  for (let i = 0; i < ps.length; i++) {
    await fs.setDoc(await textRef(where, id, file, i), i ? { s: ps[i] } : { s: ps[i], n: ps.length, v: 1, at: Date.now() });
  }
  texts.set(id + '/' + file, Promise.resolve(ch));
  return ps.length;
}

/* ── save, rename, delete ────────────────────────────────────────────────── */
/** book: the contents (no chapters' text); chapters: [{n, title, blocks}] in
 *  order. Every text is written first, so the book never shows without them.
 *  onStep(i, total) after each chapter. */
export async function save(where, book, chapters, { onStep } = {}) {
  const d = docOf(where);
  if (!d.loaded) throw new Error('Not connected yet: try again in a moment.');
  for (let i = 0; i < chapters.length; i++) {
    const c = book.chapters[i];
    await writeText(where, book.id, c.file, chapters[i]);
    if (onStep) onStep(i + 1, chapters.length);
  }
  if (where === 'mine') M.markPersonal(book.id);
  d.set({ ['books.' + book.id]: Object.assign({ imported: true, at: Date.now(), by: C.P || 'tony' }, book) }, { now: true });
  await d.flush();
  return book.id;
}
export function rename(id, { title, author }) {
  const w = whereOf(id); if (!w) return;
  const patch = {};
  if (title != null) patch['books.' + id + '.title'] = String(title).trim() || 'Untitled';
  if (author != null) patch['books.' + id + '.author'] = String(author).trim();
  docOf(w).set(patch, { now: true });
}
/** Deletes the book, its texts, and what was made for it (versions, sets,
 *  jobs) in its doc. Each person's progress and bookmarks stay (harmless). */
export async function remove(id) {
  const w = whereOf(id); if (!w) return;
  const d = docOf(w), b = d.get('books.' + id, {}) || {};
  const { fs } = await C.firebase();
  for (const c of b.chapters || []) {
    const first = await fs.getDoc(await textRef(w, id, c.file, 0)).catch(() => null);
    const n = first && first.exists() ? Number(first.data().n) || 1 : 1;
    for (let i = 0; i < n; i++) await fs.deleteDoc(await textRef(w, id, c.file, i)).catch(() => {});
    texts.delete(id + '/' + c.file);
  }
  const patch = { ['books.' + id]: C.DELETE };
  for (const k of ['assets', 'versions', 'jobs', 'sets']) if (d.get(k + '.' + id, null)) patch[k + '.' + id] = C.DELETE;
  d.set(patch, { now: true });
  if (b.src && b.src.drive && b.src.drive.id) {
    try { await fetch(M.DRIVE + '/f/' + encodeURIComponent(b.src.drive.id) + '?a=' + (b.src.drive.acct || 'tony'), { method: 'DELETE', headers: { authorization: 'Bearer ' + String(C.me.get('orcaKey', '') || '') } }); } catch (e) {}
  }
  M.markPersonal(id, false);
}
