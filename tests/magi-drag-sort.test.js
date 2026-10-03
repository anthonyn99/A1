// Drag to reorder (2026-10-01): the agent order, both queues and the unit
// chips are dragged instead of moved with arrows, with the shared dragsort.js
// since theme phase 11. Runs A1Drag.order (a dragged queue row's new order
// number) for real and pins the wiring statically; the
// behaviour itself is proved with real pointer drags in
// tests/live/magi-drag-sort.live.js.
//
// Run: node tests/magi-drag-sort.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const MAGI = fs.readFileSync(process.env.MAGI_HTML || path.join(__dirname, '..', 'magi.html'), 'utf8')
  .replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
function lift(name) {
  const at = MAGI.search(new RegExp('(^|\\n)(async )?function ' + name + '\\('));
  if (at < 0) throw new Error('not found: ' + name);
  let i = MAGI.indexOf('{', MAGI.indexOf(')', at)), depth = 0;
  for (let j = i; j < MAGI.length; j++) {
    if (MAGI[j] === '{') depth++;
    else if (MAGI[j] === '}' && --depth === 0) return MAGI.slice(at, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}

// The shared file: MAGI runs the same dragsort.js every A1 program does
// (theme overhaul phase 11), so A1Drag.order is what a dropped queue row gets.
const vm = require('vm');
const ctx = { window: {}, document: { getElementById: () => null } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'dragsort.js'), 'utf8'), ctx);
const dropOrder = ctx.window.A1Drag.order;

console.log('\nA dragged row\'s new order number');
const o = [1000, 2000, 3000, 4000];
// The moved row lands between its new neighbours; sorting by order must put
// it exactly at `to`.
const lands = (from, to) => {
  const items = o.map((v, i) => ({ i, v }));
  items[from].v = dropOrder(o, from, to);
  return items.sort((a, b) => a.v - b.v).findIndex((x) => x.i === from);
};
let all = true;
for (let f = 0; f < o.length; f++) for (let t = 0; t < o.length; t++) if (lands(f, t) !== t) all = false;
ok('every from -> to lands exactly at `to`', all);
ok('down past one: between its new neighbours', dropOrder(o, 0, 1) === 2500);
ok('to the end: one step past the last', dropOrder(o, 1, 3) === 5000);
ok('to the front: one step before the first', dropOrder(o, 3, 0) === 0);
ok('nowhere to go: unchanged', dropOrder([7], 0, 0) === 7);

console.log('\nOne copy of the code: MAGI uses the shared dragsort.js');
ok('magi.html loads dragsort.js', /<script src="dragsort\.js"><\/script>/.test(MAGI));
ok('...and carries no copy of its own',
   !/function (dragSort|dragGrip|dropOrder|dragRefocus|unitDragStart)\(/.test(MAGI) && !/\bDSORT\b/.test(MAGI) && !/\.dsort-grip \{/.test(MAGI));
ok('no grip dots anywhere (rows are taken by the row)', !/dragGrip\(|A1Drag\.grip\(|dsort-grip/.test(MAGI));

console.log('\nThe arrows are gone; drags in their place');
ok('no ↑/↓ buttons in the agent order', !/code-order-mv/.test(MAGI));
ok('no ↑/↓ buttons on queue rows', !/queueMove\(it\.id/.test(MAGI) && !/"Move up"/.test(MAGI));
const order = lift('openCodeOrder');
ok('the agent order is A1Drag-ed, held 300ms on touch',
   /A1Drag\.sort\(list, \{[\s\S]*row: "\.code-order-row"[\s\S]*hold: 300[\s\S]*onDrop:/.test(order));
const rq = lift('renderQueue');
ok('a redraw never lands under a drag', /if \(A1Drag\.active\) \{ queueRenderLater\(\); return; \}/.test(rq));
const init = lift('queueDragInit');
ok('only a waiting row is draggable', /canDrag: \(r\) => r\.dataset\.status === "queued"/.test(init));
ok('...held 300ms on touch', /hold: 300/.test(init));
ok('wired once per list', /if \(box\.dataset\.dsort\) return;/.test(init));
const mv = lift('queueMoveTo');
ok('a drop changes only the moved row\'s number', (mv.match(/\.order =/g) || []).length === 1);
ok('...via A1Drag.order', /it\.order = A1Drag\.order\(/.test(mv));
ok('...trusting the id, not a stale index', /rows\.findIndex\(\(x\) => x\.id === id\)/.test(mv));

console.log('\nThe unit chips');
ok('chips are an A1Drag grid, held 300ms on touch',
   /A1Drag\.sort\(\$\("unitChips"\), \{\s*row: "\.chip",\s*axis: "grid",\s*hold: 300,/.test(MAGI));
const ruc = lift('renderUnitChips');
ok('a chip redraw never lands under a drag', /if \(A1Drag\.active\) \{ unitChipsLater\(\); return; \}/.test(ruc));
ok('a synced order is ignored mid-drag', /if \(ord && !A1Drag\.active &&/.test(MAGI));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
