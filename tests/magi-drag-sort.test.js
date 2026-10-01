// Drag to reorder (2026-10-01): the agent order and both queues are dragged
// by a grip instead of moved with arrows. Runs dropOrder (a dragged queue
// row's new order number) for real and pins the wiring statically; the
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

const dropOrder = new Function(lift('dropOrder') + '\nreturn dropOrder;')();

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

console.log('\nThe arrows are gone; grips and drags in their place');
ok('no ↑/↓ buttons in the agent order', !/code-order-mv/.test(MAGI));
ok('no ↑/↓ buttons on queue rows', !/queueMove\(it\.id/.test(MAGI) && !/"Move up"/.test(MAGI));
const order = lift('openCodeOrder');
ok('the agent order rows carry a grip', /dragGrip\(`Move \$\{m\.label\}/.test(order));
ok('...and are dragSort-ed, keyboard included', /dragSort\(list, \{[\s\S]*onDrop:[\s\S]*onKey:/.test(order));
const rq = lift('renderQueue');
ok('a queue row carries a grip, hidden on rows that cannot move',
   /dragGrip\(/.test(rq) && /if \(it\.status !== "queued"\) \{ grip\.hidden = true;/.test(rq));
ok('a redraw never lands under a drag', /if \(DSORT\.active\) \{ DSORT\.pending = renderQueue; return; \}/.test(rq));
const init = lift('queueDragInit');
ok('only a waiting row is draggable', /canDrag: \(r\) => r\.dataset\.status === "queued"/.test(init));
ok('wired once per list', /if \(box\.dataset\.dsort\) return;/.test(init));
const mv = lift('queueMoveTo');
ok('a drop changes only the moved row\'s number', (mv.match(/\.order =/g) || []).length === 1);
ok('...trusting the id, not a stale index', /rows\.findIndex\(\(x\) => x\.id === id\)/.test(mv));

console.log('\nHow it drags');
const ds = lift('dragSort');
ok('pointer events: mouse, touch and pen are one path', /addEventListener\("pointerdown"/.test(ds));
ok('touch drags only from the grip (the list still scrolls)', /if \(e\.pointerType !== "mouse"\) return;/.test(ds));
ok('a press on a control stays that control\'s', /closest\("button, a, input, select, textarea, \[contenteditable\]"\)/.test(ds));
ok('moves by transform only (nothing laid out per frame)', /translate3d\(0, \$\{dy\}px, 0\)/.test(ds) && !/\.style\.top\s*=/.test(ds));
ok('Escape cancels a drag, and is used up (the sheet stays open)',
   /if \(ev\.key !== "Escape" \|\| !live\) return;\s*ev\.stopPropagation\(\);\s*ev\.preventDefault\(\);\s*cancelled = true;/.test(ds));
ok('a mouse press on a row\'s text does not start a text selection', /e\.preventDefault\(\);\s*\}\s*begin\(e, r\);/.test(ds));
ok('a row reaches the first and last slot (leading edge past the middle)',
   /if \(top < boxes\[i\]\.top \+ boxes\[i\]\.h \/ 2\)/.test(ds) && /if \(bottom > boxes\[i\]\.top \+ boxes\[i\]\.h \/ 2\)/.test(ds));
ok('the click after a drag is swallowed, and only that one',
   /window\.addEventListener\("click", swallow, true\);\s*setTimeout\(\(\) => window\.removeEventListener\("click", swallow, true\), 0\)/.test(ds));
ok('the grip cannot scroll the page under a finger', /\.dsort-grip \{[^}]*touch-action: none/.test(MAGI));
ok('reduced motion turns the animation off', /prefers-reduced-motion: reduce\) \{\s*\.dsort > \*/.test(MAGI));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
