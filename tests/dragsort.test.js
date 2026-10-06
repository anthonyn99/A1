// dragsort.js (window.A1Drag): MAGI's drag to reorder, shared by every A1
// program (theme overhaul, docs/theme-overhaul-plan.md §2 "Drag and drop").
// Driven in jsdom with a stubbed layout: every element's box comes from its
// data-box="x,y,w,h", so the geometry the drag reads is the one written here.
//
// Run: node tests/dragsort.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 220;

const src = fs.readFileSync(path.join(__dirname, '..', 'dragsort.js'), 'utf8');
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
window.Element.prototype.getBoundingClientRect = function () {
  const [x, y, w, h] = (this.dataset && this.dataset.box ? this.dataset.box : '0,0,0,0').split(',').map(Number);
  return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y };
};
window.eval(src);
const A1Drag = window.A1Drag;

function ptr(type, target, x, y, kind, id) {
  const C = window.PointerEvent || window.MouseEvent;
  const e = new C(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
    pointerId: id || 1, pointerType: kind || 'mouse' });
  if (e.pointerId === undefined) Object.defineProperty(e, 'pointerId', { value: id || 1 });
  if (e.pointerType === undefined) Object.defineProperty(e, 'pointerType', { value: kind || 'mouse' });
  target.dispatchEvent(e);
  return e;
}

// A vertical list of n 40px rows, each with a grip, at (x0, 0).
function vlist(n, x0, opts) {
  const list = doc.createElement('div');
  list.dataset.box = `${x0 || 0},0,200,${n * 40}`;
  for (let i = 0; i < n; i++) {
    const r = doc.createElement('div');
    r.className = 'row'; r.dataset.box = `${x0 || 0},${i * 40},200,40`; r.dataset.dkey = 'k' + i;
    r.appendChild(A1Drag.grip('Move ' + i));
    const t = doc.createElement('span'); t.className = 'txt'; t.textContent = 'row ' + i; r.appendChild(t);
    const b = doc.createElement('button'); b.className = 'ctl'; b.textContent = 'x'; r.appendChild(b);
    list.appendChild(r);
  }
  doc.body.appendChild(list);
  const drops = [], keys = [];
  A1Drag.sort(list, Object.assign({ row: '.row', onDrop: (...a) => drops.push(a), onKey: (r, d) => keys.push([r.dataset.dkey, d]) }, opts || {}));
  return { list, rows: [...list.children], drops, keys };
}

async function drag(target, from, to, kind) {
  ptr('pointerdown', target, from[0], from[1], kind);
  ptr('pointermove', window, from[0], (from[1] + to[1]) / 2, kind);
  ptr('pointermove', window, to[0], to[1], kind);
  ptr('pointerup', window, to[0], to[1], kind);
  await wait(SETTLE);
}

(async () => {
  console.log('\nA1Drag.order: the moved row\'s new number');
  const o = [1000, 2000, 3000, 4000];
  ok('between its new neighbours', A1Drag.order(o, 0, 1) === 2500);
  ok('to the end: one step past the last', A1Drag.order(o, 1, 3) === 5000);
  ok('to the front: one step before the first', A1Drag.order(o, 3, 0) === 0);

  console.log('\nMouse, same list');
  let L = vlist(4);
  await drag(L.rows[0].querySelector('.txt'), [50, 20], [50, 105]);
  ok('down: row 0 to slot 2 (leading edge past the middle)', JSON.stringify(L.drops.map((d) => d.slice(0, 2))) === '[[0,2]]', JSON.stringify(L.drops.map((d) => d.slice(0, 2))));
  ok('onDrop gets the list as fromList and toList', L.drops[0][2] === L.list && L.drops[0][3] === L.list);
  ok('rows are put back after the glide', L.rows.every((r) => !r.style.transform && !r.classList.contains('dsort-drag')));
  ok('the list is not left in drag mode', !L.list.classList.contains('dsort-on') && !doc.documentElement.classList.contains('dsort-grabbing'));
  L.list.remove();

  L = vlist(4);
  await drag(L.rows[3].querySelector('.txt'), [50, 140], [50, 50]);
  ok('up: row 3 to slot 1', JSON.stringify(L.drops.map((d) => d.slice(0, 2))) === '[[3,1]]', JSON.stringify(L.drops.map((d) => d.slice(0, 2))));
  L.list.remove();

  L = vlist(4);
  let clicks = 0;
  L.rows[1].addEventListener('click', () => clicks++);
  ptr('pointerdown', L.rows[1].querySelector('.txt'), 50, 60);
  ptr('pointermove', window, 50, 62);
  ptr('pointerup', window, 50, 62);
  L.rows[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await wait(SETTLE);
  ok('under the 4px threshold it is a click, not a drag', L.drops.length === 0 && clicks === 1, `${L.drops.length} ${clicks}`);

  ptr('pointerdown', L.rows[1].querySelector('.txt'), 50, 60);
  ptr('pointermove', window, 50, 90);
  ptr('pointermove', window, 50, 110);
  ptr('pointerup', window, 50, 110);
  L.rows[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  ok('the click a release fires is swallowed', clicks === 1, clicks);
  await wait(SETTLE);
  L.rows[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  ok('...and only that one', clicks === 2, clicks);
  L.list.remove();

  L = vlist(4);
  ptr('pointerdown', L.rows[0].querySelector('.ctl'), 190, 20);
  ptr('pointermove', window, 190, 100);
  ptr('pointerup', window, 190, 100);
  await wait(SETTLE);
  ok('a press on a control inside the row stays the control\'s', L.drops.length === 0);

  ptr('pointerdown', L.rows[0].querySelector('.txt'), 50, 20);
  ptr('pointermove', window, 50, 60);
  ptr('pointermove', window, 50, 110);
  ok('lifted: dsort-drag, moved by transform only', L.rows[0].classList.contains('dsort-drag') && /translate3d\(0, 90px, 0\)/.test(L.rows[0].style.transform), L.rows[0].style.transform);
  ok('neighbours slide out of the way', /-40px/.test(L.rows[1].style.transform) && /-40px/.test(L.rows[2].style.transform) && !L.rows[3].style.transform);
  ok('a drag is visible to A1Drag.active', A1Drag.active === true);
  let ran = 0;
  A1Drag.later(() => ran++);
  ok('A1Drag.later waits for the drag', ran === 0);
  const esc = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  let reached = false;
  doc.body.addEventListener('keydown', () => { reached = true; }, { once: true });
  doc.body.dispatchEvent(esc);
  await wait(SETTLE);
  ok('Escape puts the row back (no drop)', L.drops.length === 0 && L.rows.every((r) => !r.style.transform));
  ok('...and is used up (the sheet stays open)', !reached);
  ok('A1Drag.later ran once the drag finished', ran === 1 && A1Drag.active === false);
  A1Drag.later(() => ran++);
  ok('...and runs at once when idle', ran === 2);

  console.log('\nKeyboard');
  const g = L.rows[2].querySelector('.dsort-grip');
  g.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  g.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  ok('a focused grip\'s ↓/↑ call onKey(row, ±1)', JSON.stringify(L.keys) === '[["k2",1],["k2",-1]]', JSON.stringify(L.keys));
  ok('the grip is a real button with a label', g.tagName === 'BUTTON' && g.type === 'button' && /Move 2/.test(g.getAttribute('aria-label')));
  L.list.remove();

  console.log('\nTouch');
  L = vlist(4);
  await drag(L.rows[0].querySelector('.txt'), [50, 20], [50, 110], 'touch');
  ok('a finger on the row (not the grip) scrolls: no drag', L.drops.length === 0);
  await drag(L.rows[0].querySelector('.dsort-grip'), [10, 20], [10, 110], 'touch');
  ok('a finger on the grip drags', JSON.stringify(L.drops.map((d) => d.slice(0, 2))) === '[[0,2]]', JSON.stringify(L.drops.map((d) => d.slice(0, 2))));
  L.list.remove();

  // A chip row: no grips, horizontal, a 300ms hold picks up.
  const chips = doc.createElement('div');
  chips.dataset.box = '0,0,400,30';
  for (let i = 0; i < 4; i++) {
    const c = doc.createElement('button'); c.className = 'chip'; c.dataset.box = `${i * 100},0,96,30`; c.textContent = 'c' + i;
    chips.appendChild(c);
  }
  doc.body.appendChild(chips);
  const cd = [];
  let cclicks = 0;
  chips.addEventListener('click', () => cclicks++);
  A1Drag.sort(chips, { row: '.chip', axis: 'x', hold: 300, onDrop: (f, t) => cd.push([f, t]) });
  const c0 = chips.children[0];
  ptr('pointerdown', c0, 40, 15, 'touch');
  ptr('pointermove', window, 70, 15, 'touch');
  ptr('pointerup', window, 70, 15, 'touch');
  await wait(350);
  ok('chip row: moving before the hold completes is a scroll', cd.length === 0 && !c0.classList.contains('dsort-drag'));
  ptr('pointerdown', c0, 40, 15, 'touch');
  await wait(330);
  ok('chip row: a 300ms hold picks the chip up', c0.classList.contains('dsort-drag') && c0.classList.contains('dsort-chip'));
  ptr('pointermove', window, 150, 15, 'touch');
  ptr('pointermove', window, 250, 15, 'touch');
  ok('chip row: the chip moves along x', /translate3d\(210px, 0px, 0\)|translate3d\(210px, 0, 0\)/.test(c0.style.transform), c0.style.transform);
  ok('chip row: the lifted chip is 1.06 inside its own transform', /scale\(1\.06\)$/.test(c0.style.transform), c0.style.transform);
  ptr('pointerup', window, 250, 15, 'touch');
  await wait(SETTLE);
  ok('chip row: chip 0 lands in slot 2', JSON.stringify(cd) === '[[0,2]]', JSON.stringify(cd));
  ptr('pointerdown', c0, 40, 15);
  ptr('pointerup', window, 40, 15);
  c0.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  ok('a button that is its own row still clicks', cclicks === 1, cclicks);
  chips.remove();

  console.log('\nBetween lists (group)');
  const A = vlist(3, 0, { group: 'g' });
  const B = vlist(2, 300, { group: 'g' });
  await drag(A.rows[1].querySelector('.txt'), [50, 60], [350, 50]);
  ok('a row dropped on another list in the group: onDrop(from, to, fromList, toList)',
     A.drops.length === 1 && A.drops[0][0] === 1 && A.drops[0][1] === 1 && A.drops[0][2] === A.list && A.drops[0][3] === B.list,
     JSON.stringify(A.drops.map((d) => d.slice(0, 2))));
  ok('both lists are put back', [...A.rows, ...B.rows].every((r) => !r.style.transform) && !B.list.classList.contains('dsort-on'));
  // B is 2 rows (0-80px); 75px is inside it, past its last row's middle.
  await drag(A.rows[0].querySelector('.txt'), [50, 20], [350, 75]);
  ok('past the other list\'s last row: appended (to = its length)', A.drops.length === 2 && A.drops[1][1] === 2 && A.drops[1][3] === B.list,
     JSON.stringify(A.drops.map((d) => d.slice(0, 2))));
  const C = vlist(2, 600, { group: 'other' });
  await drag(A.rows[0].querySelector('.txt'), [50, 20], [650, 30]);
  ok('a list in another group is not a target', C.drops.length === 0 && A.drops.every((d) => d[3] !== C.list));
  A.list.remove(); B.list.remove(); C.list.remove();

  console.log('\nCopy (a palette: the row stays, a floating copy is carried)');
  const P = vlist(3, 0, { group: 'cp', copy: true });
  const Q = vlist(2, 300, { group: 'cp' });
  const nBody = doc.body.children.length;
  ptr('pointerdown', P.rows[1].querySelector('.txt'), 50, 60);
  ptr('pointermove', window, 200, 60);
  ptr('pointermove', window, 350, 50);
  const gh = doc.querySelector('.dsort-ghost');
  ok('a fixed floating copy is carried; the original stays and is dimmed',
     !!gh && gh !== P.rows[1] && doc.body.children.length === nBody + 1 && P.rows[1].classList.contains('dsort-src') && !P.rows[1].style.transform);
  ok('the other palette rows do not move', P.rows.every((r) => !r.style.transform));
  ptr('pointerup', window, 350, 50);
  await wait(SETTLE);
  ok('dropped on the other list: onDrop(from, to, fromList, toList), original still there',
     P.drops.length === 1 && P.drops[0][0] === 1 && P.drops[0][1] === 1 && P.drops[0][2] === P.list && P.drops[0][3] === Q.list && P.list.children.length === 3);
  ok('the copy is gone and the palette is put back', !doc.querySelector('.dsort-ghost') && doc.body.children.length === nBody && P.rows.every((r) => !r.style.transform && !r.classList.contains('dsort-src')));
  await drag(P.rows[0].querySelector('.txt'), [50, 20], [50, 100]);
  ok('dropped within its own list: nothing happens', P.drops.length === 1, JSON.stringify(P.drops.map((d) => d.slice(0, 2))));
  P.list.remove(); Q.list.remove();

  console.log('\nNested lists and ignore');
  // An outer list of one card (0-200 x 0-160) whose body is an inner list of rows.
  const outer = doc.createElement('div'); outer.dataset.box = '0,0,200,320';
  const cards = [0, 1].map((ci) => {
    const card = doc.createElement('div'); card.className = 'card'; card.dataset.box = `0,${ci * 160},200,160`;
    const head = doc.createElement('span'); head.className = 'head'; head.textContent = 'card ' + ci; card.appendChild(head);
    const inner = doc.createElement('div'); inner.className = 'inner'; inner.dataset.box = `0,${ci * 160 + 40},200,120`;
    for (let i = 0; i < 3; i++) {
      const r = doc.createElement('div'); r.className = 'item'; r.dataset.box = `0,${ci * 160 + 40 + i * 40},200,40`;
      const t = doc.createElement('span'); t.className = 'txt'; t.textContent = 'item ' + i; r.appendChild(t);
      const body = doc.createElement('div'); body.className = 'body'; body.textContent = 'notes'; r.appendChild(body);
      inner.appendChild(r);
    }
    card.appendChild(inner); outer.appendChild(card);
    return card;
  });
  doc.body.appendChild(outer);
  const cardDrops = [], itemDrops = [];
  A1Drag.sort(outer, { row: '.card', onDrop: (...a) => cardDrops.push(a) });
  cards.forEach((c) => A1Drag.sort(c.querySelector('.inner'), { row: '.item', ignore: '.body', onDrop: (...a) => itemDrops.push(a) }));
  await drag(cards[0].querySelector('.item .txt'), [50, 60], [50, 145]);
  ok('a row of an inner list drags that row, not the card around it', itemDrops.length === 1 && cardDrops.length === 0,
     JSON.stringify({ itemDrops: itemDrops.length, cardDrops: cardDrops.length }));
  await drag(cards[0].querySelector('.head'), [50, 10], [50, 300]);
  ok('the card\'s own head still drags the card', cardDrops.length === 1 && itemDrops.length === 1);
  await drag(cards[0].querySelector('.item .body'), [50, 70], [50, 300]);
  ok('a press inside `ignore` is not a drag (of the row or the card)', itemDrops.length === 1 && cardDrops.length === 1);
  outer.remove();

  console.log('\nWiring');
  {
    // Every copy of the file is the same file (extensions carry their own).
    const copies = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name === 'dragsort.js') copies.push(p);
      }
    };
    walk(path.join(__dirname, '..'));
    ok('every dragsort.js copy is byte-identical', copies.length >= 1 && copies.every((p) => fs.readFileSync(p, 'utf8') === src), copies.join(', '));
  }
  ok('CSS injected once, with MAGI fallbacks', doc.querySelectorAll('#a1-dragsort-css').length === 1 && /var\(--ds-ac, #c0aeea\)/.test(doc.getElementById('a1-dragsort-css').textContent));
  ok('the grip cannot scroll the page under a finger', /\.dsort-grip \{[^}]*touch-action: none/.test(doc.getElementById('a1-dragsort-css').textContent));
  ok('a lifted row\'s label is light on s2 (a selected chip\'s dark label went black)', /\.dsort-drag \{[^}]*color: var\(--ds-tx, #f4f3f0\) !important/.test(doc.getElementById('a1-dragsort-css').textContent));
  ok('a lifted chip is scaled inside its transform, not by the `scale` property (that scaled the translate: the chip trailed the pointer 6%)',
     !/scale: 1\.06/.test(doc.getElementById('a1-dragsort-css').textContent));
  ok('reduced motion: no transitions', /prefers-reduced-motion: reduce/.test(doc.getElementById('a1-dragsort-css').textContent));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
