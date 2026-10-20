/**
 * The shipped Gita must be complete and well-formed.
 *
 * Shruti/tools/extract.py builds books/gita from the PDF and refuses to write
 * unless every letter of the source survives (its fidelity check). This test
 * guards the files that were committed: if someone hand-edits a chapter, drops
 * a verse or breaks the lesson notes, it fails here instead of in the reader.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BOOK = path.join(__dirname, '..', 'books', 'gita');
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOOK, f), 'utf8'));
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

const book = read('book.json');
const lessons = read('lessons.json');

// Verses per chapter in the full Gita. This rendition omits 1.02-1.46 and 2.02-2.09 on
// purpose (its own NOTE says so); every other chapter is complete.
const FULL = [47, 72, 43, 42, 29, 47, 30, 28, 34, 42, 55, 20, 34, 27, 20, 24, 28, 78];
const OMITTED = { 1: range(2, 46), 2: range(2, 9) };
function range(a, z) { const r = []; for (let i = a; i <= z; i++) r.push(i); return r; }

ok(book.id === 'gita' && book.shared === true, 'book.json is the shared Gita');
ok(book.chapters.length === 18, '18 chapters listed');

let keyTotal = 0;
book.chapters.forEach((meta, i) => {
  const n = i + 1;
  ok(meta.n === n, `chapter ${n} in order`);
  const ch = read(meta.file);
  ok(ch.n === n && ch.title && ch.title === meta.title, `ch${n} title matches book.json`);
  ok(Array.isArray(ch.blocks) && ch.blocks.length, `ch${n} has blocks`);

  const seen = [];
  let verses = 0, key = 0;
  for (const b of ch.blocks) {
    ok(['h', 'p', 'a'].includes(b.k), `ch${n} block kind ${b.k}`);
    if (b.k !== 'p') { ok(typeof b.t === 'string' && b.t.trim(), `ch${n} ${b.k} block has text`); continue; }
    for (const s of b.s) {
      ok(typeof s.t === 'string' && s.t.trim() && s.t === s.t.trim(), `ch${n} segment text is trimmed`);
      ok(!/\(\d{1,2}\.\d{2}(-\d{2})?\)/.test(s.t), `ch${n} verse ref left inside text: ${s.t.slice(0, 60)}`);
      if (s.key) key++;
      if (s.hl) for (const [a, z] of s.hl) ok(a >= 0 && z <= s.t.length && a < z, `ch${n} ${s.v} highlight range in bounds`);
      if (!s.v) continue;
      verses++;
      const m = /^(\d+)\.(\d{2})(?:-(\d{2}))?$/.exec(s.v);
      ok(m && +m[1] === n, `ch${n} verse ${s.v} belongs to its chapter`);
      for (let v = +m[2]; v <= +(m[3] || m[2]); v++) seen.push(v);
    }
  }
  const sorted = [...seen].sort((a, b) => a - b);
  ok(JSON.stringify(seen) === JSON.stringify(sorted), `ch${n} verses in order`);
  ok(new Set(seen).size === seen.length, `ch${n} no duplicate verses`);
  const omitted = OMITTED[n] || [];
  const missing = range(1, FULL[i]).filter((v) => !seen.includes(v) && !omitted.includes(v));
  ok(!missing.length, `ch${n} missing verses ${missing.join(',')}`);
  ok(meta.verses === verses && meta.key === key, `ch${n} counts in book.json are current`);
  keyTotal += key;

  const L = lessons[String(n)];
  ok(L && L.lessons.length >= 4, `ch${n} has lesson notes`);
  L.lessons.forEach((l, j) => {
    ok(l.id === `L${j + 1}`, `ch${n} lesson ids run L1..Ln`);
    ok(l.title && l.title.length < 120, `ch${n} ${l.id} title`);
    ok(l.body && l.body.length > 60, `ch${n} ${l.id} body`);
    ok(!/^Lesson \d+/m.test(l.body), `ch${n} ${l.id} swallowed the next lesson`);
  });
  ok(meta.lessons === L.lessons.length, `ch${n} lesson count in book.json is current`);
});

// The notes Tony and Veda wrote: 8, 12, 15, 13, 13, 13 lessons for chapters 1-6.
assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map((n) => lessons[n].lessons.length), [8, 12, 15, 13, 13, 13]);
ok(keyTotal > 100, 'key (highlighted) verses were carried over');
const intro = read(book.intro.file);
ok(intro.blocks.length > 5, 'introduction present');

console.log(`content.test: ${checks} checks passed`);
