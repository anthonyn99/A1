// Programs that left A1 for the private repo (anthonyn99/A1-Priv) on
// 2026-10-10 (TradeHub, Insight, Vault, then RiftIQ and Solace, which Everwell
// replaced on 2026-10-11; OneInbox followed on 2026-10-28) —
// docs/a1-priv-move-plan.md. A1 has no copy of them, but the suites here still
// guard the REAL code: they read it from the sibling checkout next to this one
// (Desktop\A1-Priv). Without that checkout (CI, another PC) a suite skips those
// files and says so.
//
//   const M = require('./moved');
//   M.file('tradehub.html')   → absolute path, in A1-Priv when it moved
//   M.read('tradehub.html')   → its text
//   M.has('tradehub.html')    → false when the file is not on this machine
//   M.src('dragsort.js')      → regex source for a <script src> of a shared A1
//                               file: relative here (`../` from a page in a
//                               program folder, e.g. Shruti/), absolute in A1-Priv
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// A1_PRIV points the suites at another checkout (e.g. a git worktree under test).
const PRIV = process.env.A1_PRIV ? path.resolve(process.env.A1_PRIV) : path.join(ROOT, '..', 'A1-Priv');
const MOVED = /^(?:(?:tradehub|insight|vault|riftiq|everwell|oneinbox)\.html$|Vault[\\/])/;

const isMoved = (rel) => MOVED.test(String(rel));
const file = (rel) => path.join(isMoved(rel) ? PRIV : ROOT, rel);
const has = (rel) => fs.existsSync(file(rel));
const read = (rel) => fs.readFileSync(file(rel), 'utf8');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const src = (shared) => '(?:https://anthonyn99\\.github\\.io/A1/|(?:\\.\\./)+)?' + esc(shared);

let warned = false;
function skipNote(rel) {
  if (!warned) console.log('  · skipped ' + rel + ' and the other moved programs: no ../A1-Priv checkout here');
  warned = true;
}

module.exports = { ROOT, PRIV, isMoved, file, has, read, src, skipNote };
