// Pins the invariants of the Whiteboard / Mind Map boards (the VizEngine block
// in index.html). All five are things that were WRONG at some point while it was
// being built, and every one of them fails silently — a board that looks fine on
// the device you are holding and is not there on the other one.
//
//  1. LOCAL BEFORE CLOUD, AND NEVER BEHIND IT. Offline, a Firestore write
//     neither resolves nor rejects; it sits in the mutation queue until the
//     connection returns. An earlier version returned that promise from save(),
//     so the second edit made on a train queued behind it in memory and closing
//     the tab took it — and close() awaited the same promise, which froze entry
//     switching outright.
//
//  2. THE OPEN PATH IS TIME-BOUNDED. The same offline hang on the READ side left
//     the board stuck behind its loading veil, which correctly swallows pointer
//     events — so the editor looked alive and ignored the pen.
//
//  3. CHUNKS ARE MEASURED IN BYTES. Firestore counts UTF-8. A mind map written
//     in Chinese, or one emoji in a node label, is 3–4 bytes per JS character,
//     so a character-counted chunk sails past the 1 MiB document limit and the
//     write is rejected with the board apparently saved.
//
//  4. THE LEGACY DOCUMENTS ARE READ, NEVER WRITTEN. Old whiteboards are a base64
//     PNG in dashboards/{prefix}_canvas_{id}; old Veda mind maps are
//     data.nodes/data.edges on the entry. Both are converted in memory and left
//     exactly as they are, so a bad conversion is recoverable.
//
//  5. A DRAWING NEVER ENTERS THE JOURNAL DOCUMENT. dashboards/journal holds every
//     entry in one 1 MiB document and already sits near its ceiling; a scene in
//     there would wedge the whole journal's sync, not just one board.
//
// Run: node tests/viz-board.test.js

const fs = require('fs');
const path = require('path');

// The engine lives in Notebook/ (core/viz.js, the accessor in core/fb.js, JGuard in core/jguard.js). Since
// Page only (2026-11-17) the journals no longer configure boards: core/convert.js draws old ones as pages.
const src = ['index.html', 'Notebook/apps/brainstorm.js', 'Notebook/apps/myjournal.js','Notebook/core/viz.js', 'Notebook/core/fb.js', 'Notebook/core/jguard.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};

// Pull one function body out by brace matching from its declaration.
function body(decl) {
  const at = src.indexOf(decl);
  if (at < 0) return null;
  let i = src.indexOf('{', at);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
  }
  return null;
}

console.log('\n-- the engine is present --');
ok('VizEngine.createBoard is exported', /window\.VizEngine\s*=\s*\{\s*createBoard/.test(src));
ok('VizStore exposes the local cache and the chunked document IO',
  /window\.VizStore\s*=\s*\{[\s\S]{0,400}?idbGet[\s\S]{0,400}?readChunked[\s\S]{0,400}?writeChunked/.test(src));
ok('the Firestore accessor is installed once, beside the journals', /window\._fbViz\s*=\s*\{/.test(src));
ok('both editors are pinned to exact versions',
  /V_EXC\s*=\s*'\d+\.\d+\.\d+'/.test(src) && /V_ME\s*=\s*'\d+\.\d+\.\d+'/.test(src));

console.log('\n-- 1. local before cloud, and never behind it --');
const save = body('  function save() {');
ok('save() exists', !!save);
if (save) {
  const idbAt = save.indexOf('S.idbPut(');
  const cloudAt = save.indexOf('pushCloud(');
  ok('save() writes the local cache', idbAt > 0);
  ok('the local write comes before the cloud write', idbAt > 0 && cloudAt > idbAt, { idbAt, cloudAt });
  // The bug: `return B.saving`. That promise never settles offline.
  ok('save() never returns the in-flight cloud promise', !/return\s+B\.saving\s*;/.test(save),
    (save.match(/return[^\n]*B\.saving[^\n]*/g) || []).join(' | '));
  ok('save() returns the LOCAL write', /return\s+local\s*;/.test(save));
  // The in-flight branch must fall THROUGH to the local write and the return,
  // never short-circuit out of the function the way it originally did.
  ok('an edit made while a cloud write is in flight is still cached locally',
    /if\s*\(B\.saving\)\s*\{[\s\S]{0,600}?armSlow\(id\);/.test(save),
    save.slice(save.indexOf('if (B.saving)'), save.indexOf('if (B.saving)') + 120));
}
const close = body('  B.close = function () {');
ok('close() exists', !!close);
if (close) ok('close() waits on save(), which is local-only', /save\(\)/.test(close) && !/B\.saving/.test(close));

console.log('\n-- 2. the open path is time-bounded --');
const capped = body('  function capped(p, ms) {');
ok('capped() exists', !!capped);
if (capped) {
  ok('capped() races the read against a timer', /Promise\.race/.test(capped) && /setTimeout/.test(capped));
  ok('a capped read that misses its deadline resolves to null, it does not reject',
    /res\(null\)/.test(capped) && !/rej\(/.test(capped));
}
const loadDoc = body('  function loadDoc(entry) {');
ok('loadDoc() exists', !!loadDoc);
if (loadDoc) ok('the cloud read on the open path is capped', /capped\(/.test(loadDoc));
const migrate = body('  function migrate(entry) {');
ok('migrate() exists', !!migrate);
if (migrate) ok('the legacy probe on the open path is capped too', /capped\(/.test(migrate));

console.log('\n-- 3. chunks are measured in bytes --');
const split = body('function splitChunks(str) {');
ok('splitChunks() exists', !!split);
if (split) {
  ok('it measures UTF-8 bytes, not characters', /byteLen\(/.test(split));
  ok('it shrinks a slice that is over the byte ceiling', /CHUNK_BYTES/.test(split) && /while\s*\(/.test(split));
  // Splitting between a surrogate pair leaves two lone halves, which Firestore
  // stores as U+FFFD — silent corruption on rejoin.
  ok('it refuses to end a chunk on half a surrogate pair', /0xD800/.test(split) && /0xDBFF/.test(split));
}
ok('the byte ceiling stays under the writer\'s own limit',
  (() => {
    const m = src.match(/var CHUNK_BYTES\s*=\s*(\d+)/);
    const g = src.match(/FB_MAX_WRITE_BYTES\s*=\s*(\d+)/);
    return !!m && !!g && Number(m[1]) < Number(g[1]);
  })());

console.log('\n-- 4. the legacy documents are read, never written --');
// The only mentions of the old canvas documents must be reads.
const legacyLines = src.split('\n')
  .map((line, i) => ({ line: line.trim(), n: i + 1 }))
  .filter(r => /_canvas_'\s*\+|legacyCanvasId/.test(r.line));
ok('the legacy canvas documents are still referenced (for conversion)', legacyLines.length > 0);
ok('nothing writes a legacy canvas document',
  !legacyLines.some(r => /setDoc|_fbViz\.set|writeChunked|updateDoc/.test(r.line)),
  legacyLines.filter(r => /setDoc|_fbViz\.set|writeChunked|updateDoc/.test(r.line)).map(r => r.n + ': ' + r.line).join(' | '));
ok('the per-stroke canvas uploader is gone', !/window\._fbSaveCanvas\s*=/.test(src) && !/window\._fbSaveTJCanvas\s*=/.test(src));
if (migrate) {
  ok('the mind-map conversion never mutates entry.data',
    !/entry\.data\.(nodes|edges)\s*=/.test(migrate) && !/delete\s+entry\.data/.test(migrate));
  ok('a node the old edge list never reached is re-parented, not dropped', /orphans/.test(migrate));
  ok('a cycle in the old edge list cannot recurse forever', /depth\s*>\s*\d+/.test(migrate));
}

console.log('\n-- 5. a drawing never enters the journal document --');
for (const app of [{ p: 'bj', doc: 'journal' }, { p: 'tj', doc: 'tony_journal' }]) {
  const strip = body('    const _' + app.p + 'StripEntry = async (e0) => {');
  ok(app.p + ': the entry stripper still drops any legacy canvas before upload',
    !!strip && /canvas,\s*history,\s*\.\.\.rest/.test(strip));
}
ok('saveCurrentEntry never serialises a canvas onto the entry', !/_next\.canvas\s*=/.test(src));
ok('JGuard reads the fingerprint when deciding a board is empty',
  /case 'whiteboard': return d\.vizRev \? !\(d\.vizCount > 0\) : !d\.canvas;/.test(src));

// Page only (2026-11-17): the journals have no boards of their own any more.
// Every Whiteboard / Mind Map / old canvas Mind Map becomes a page, drawn by the
// engine in a hidden, READ-ONLY board (core/convert.js); the board documents
// stay exactly where they are, and the entry is backed up before it changes.
console.log('\n-- page only: boards become pages, nothing is lost --');
const conv = fs.readFileSync(path.join(__dirname, '..', 'Notebook/core/convert.js'), 'utf8');
ok('the converter draws boards with the engine', /window\.VizEngine\.createBoard\(/.test(conv));
ok('its board is never live (no merge, no shared writes)', /liveFor:\s*function \(\) \{ return false; \}/.test(conv));
ok('it opens the board read-only', /B\.setEditable\(false\)/.test(conv));
ok('its board writes no metadata back to the journal', /onMeta:\s*function \(\) \{\}/.test(conv));
ok('the entry is backed up to its own document before anything changes',
  /_legacy_/.test(conv) && /fbv\.set\(id, doc\)/.test(conv));
ok('a first backup is never overwritten by a later one', /had && had\.entry/.test(conv));
ok('a board that cannot be drawn waits (null), it is never converted blank', /return null;/.test(conv));
ok('board pictures are shrunk to fit one image document', /function shrink\(/.test(conv) && /980000/.test(conv));
ok('the converter never writes a board document',
  !/writeChunked|_vizf_|_viz_'\s*\+/.test(conv));
for (const app of ['bj', 'tj']) {
  const one = body('function _' + app + 'ConvertOne(e) {');
  ok(app + ': conversion only proceeds once the backup is confirmed', !!one && /backup\([\s\S]*?\.then\(function \(backedUp\) \{\s*if \(!backedUp\) return false;/.test(one), one && one.slice(0, 200));
  ok(app + ': a converted entry is a normal edit (new revision, unsynced mark)', !!one && /e\.rev = \(e\.rev \|\| 0\) \+ 1; e\._dirty = true;/.test(one));
  ok(app + ': an OurJournal entry is written only while OurJournal is on screen', !!one && /if \(shared\) return \(coll && state === coll\) \? write\(\) : false;/.test(one));
  ok(app + ': no board of its own any more', !new RegExp('function _' + app + 'Board\\(').test(src) && !new RegExp('_' + app + 'Boards').test(src));
}
ok('the old canvas mind map editor is gone', !/function renderMindmap\(\)/.test(src) && !/id="bj-mml-canvas"/.test(src));
ok('the picker offers no board templates',
  !/data-template="(whiteboard|mindmap|mindmap-legacy|notes|cornell)"/.test(src));

console.log('\n-- listeners --');
ok('the board watcher is keyed, so navigating swaps it instead of stacking',
  /watch:\s*\(key,\s*id,\s*cb\)\s*=>\s*\{[\s\S]{0,200}?_vizWatch\[key\]/.test(src));
ok('the engine itself flushes every live board on pagehide',
  /addEventListener\('pagehide',\s*function \(\) \{ flushAll\(\); \}\)/.test(src));

console.log('\n-- the drawing loop stays cheap --');
const onChange = body('  function onExcChange(elements, appState) {');
ok('onExcChange() exists', !!onChange);
if (onChange) {
  // This runs on every pointer event. One integer compare, nothing else.
  ok('no JSON is serialised per pointer event', !/JSON\.stringify/.test(onChange), onChange);
  ok('no Firestore call is made per pointer event', !/_fbViz|writeChunked|idbPut/.test(onChange));
  ok('it compares a scene version and pokes a timer', /getSceneVersion/.test(onChange) && /markDirty\(\)/.test(onChange));
}
ok('the autosave debounce has a hard ceiling, so a long burst still reaches disk',
  /SAVE_MAX/.test(src) && /now - B\.firstDirtyAt >= SAVE_MAX/.test(src));

console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' : 'ALL PASSED — ') + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
