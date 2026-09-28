// Tests for the data-structure visualizers' frame generators (js/modules/drills/ds/).
//
// The visualizers TEACH, so a wrong frame teaches a wrong algorithm. Pinned:
//   - invariants hold after every operation (heap order, AVL balance + BST order)
//   - the four AVL cases rotate the way the textbook says
//   - probing sequences, BFS/DFS orders match a hand trace
//   - every sort ends sorted, for every algorithm
//   - predict mode's wrong answers are never secretly the right one
//
// Run with:  npm run test:viz
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra == null ? '' : '\n       ' + JSON.stringify(extra).slice(0, 400))); }
};
const imp = (p) => import(new URL(p, import.meta.url).href);
const Heap = await imp('../js/modules/drills/ds/heap.js');
const AVL = await imp('../js/modules/drills/ds/avl.js');
const Hash = await imp('../js/modules/drills/ds/hash.js');
const G = await imp('../js/modules/drills/ds/graph.js');
const Sort = await imp('../js/modules/drills/ds/sort.js');
const Lin = await imp('../js/modules/drills/ds/linear.js');
const R = await imp('../js/modules/drills/ds/render.js');
let seed = 12345;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

console.log('\nheap');
for (const kind of ['min', 'max']) {
  let st = { arr: [], kind };
  let ok = true, altOk = true;
  for (let i = 0; i < 60; i++) {
    const r = rnd(3) ? Heap.insert(st, rnd(100)) : Heap.removeTop(st);
    st = r.state;
    if (!Heap.isHeap(st.arr, kind)) ok = false;
    r.frames.forEach((f, j) => { if (j && Heap.alternatives(r.frames[j - 1], f).some((a) => a.arr.join() === f.arr.join())) altOk = false; });
  }
  t(`${kind}-heap order holds after 60 random ops`, ok);
  t(`${kind}-heap: no predict alternative equals the right answer`, altOk);
}
{
  const r = Heap.removeTop({ arr: [1, 3, 2, 7, 4], kind: 'min' });
  t('removeTop returns the min', r.removed === 1 && r.state.arr.join() === '2,3,4,7', r.state.arr);
  const ins = Heap.insert({ arr: [2, 5, 3], kind: 'min' }, 1);
  t('insert 1 into [2,5,3] sifts to the root', ins.state.arr[0] === 1 && ins.frames.some((f) => f.swap));
}

console.log('\nAVL');
{
  const caseOf = (vals) => {
    let root = null, notes = [];
    for (const v of vals) { const r = AVL.insert(root, v); root = r.root; notes.push(...r.frames.map((f) => f.note)); }
    return { root, notes: notes.join(' ') };
  };
  for (const [vals, kase] of [[[10, 20, 30], 'RR'], [[30, 20, 10], 'LL'], [[30, 10, 20], 'LR'], [[10, 30, 20], 'RL']]) {
    const { root, notes } = caseOf(vals);
    t(`${vals.join(' ')} is the ${kase} case, root 20`, root.v === 20 && notes.includes(`the ${kase} case`), notes.slice(0, 200));
  }
  let root = null, ok = true, altOk = true;
  const inserted = new Set();
  for (let i = 0; i < 80; i++) {
    const v = rnd(200);
    const r = AVL.insert(root, v);
    root = r.root; inserted.add(v);
    if (!AVL.isAVL(root)) ok = false;
    r.frames.forEach((f, j) => { if (j && AVL.alternatives(r.frames[j - 1], f).some((a) => JSON.stringify(a.tree) === JSON.stringify(f.tree))) altOk = false; });
  }
  t('80 random inserts: always balanced and ordered', ok);
  t('in-order is the sorted set of keys', AVL.inorder(root).join() === [...inserted].sort((a, b) => a - b).join());
  t('a duplicate insert is refused, not duplicated', AVL.inorder(AVL.insert(root, [...inserted][0]).root).length === inserted.size);
  t('rotation alternatives are never the right tree', altOk);
  const rr = AVL.insert(AVL.insert(AVL.insert(null, 10).root, 20).root, 30);
  const rot = rr.frames.find((f) => f.rotation);
  t('a rotation frame offers wrong rotations to predict', rot && AVL.alternatives(rr.frames[rr.frames.indexOf(rot) - 1], rot).length >= 2);
}

console.log('\nhash');
{
  let st = Hash.empty(7, 'linear');
  for (const k of [10, 17, 24]) st = Hash.insert(st, k).state;
  t('linear: 10,17,24 (all ≡ 3 mod 7) land in 3,4,5', st.table[3] === 10 && st.table[4] === 17 && st.table[5] === 24, st.table);
  let q = Hash.empty(7, 'quadratic');
  for (const k of [10, 17, 24]) q = Hash.insert(q, k).state;
  t('quadratic: 10,17,24 land in 3, 3+1, 3+4 = 3,4,0', q.table[3] === 10 && q.table[4] === 17 && q.table[0] === 24, q.table);
  let c = Hash.empty(7, 'chaining');
  for (const k of [10, 17, 24]) c = Hash.insert(c, k).state;
  t('chaining: all three share bucket 3', c.table[3].join() === '10,17,24');
  const r = Hash.insert(st, 3);
  t('a collision frame explains the next probe', r.frames.some((f) => /collision/.test(f.note)));
  const last = r.frames[r.frames.length - 1];
  t('hash alternatives are never the right placement', !Hash.alternatives(r.frames[r.frames.length - 2], last).some((a) => JSON.stringify(a.table) === JSON.stringify(last.table)));
  let full = Hash.empty(7, 'linear');
  for (let k = 0; k < 7; k++) full = Hash.insert(full, k).state;
  t('a full table says so', /full/.test(Hash.insert(full, 99).frames.at(-1).note));
}

console.log('\ngraph');
{
  const g = G.sample();
  const bfs = G.traverse(g, 'A', 'bfs').at(-1).visited.join('');
  const dfs = G.traverse(g, 'A', 'dfs').at(-1).visited.join('');
  // Hand trace, neighbours alphabetical. A: B D. B: A C E. D: A E G. C: B F. E: B D F G.
  t('BFS from A = A B D C E G F', bfs === 'ABDCEGF', bfs);
  t('DFS from A = A B C F E D G', dfs === 'ABCFEDG', dfs);
  t('every node visited once', new Set(bfs).size === g.nodes.length);
  const e = G.toggleEdge(g, 'A', 'G');
  t('toggling adds an edge', e.edges.length === g.edges.length + 1 && G.neighbours(e, 'A').includes('G'));
  t('toggling again removes it', G.toggleEdge(e, 'G', 'A').edges.length === g.edges.length);
  const fr = G.traverse(g, 'A', 'bfs');
  const ch = G.choices(fr[1], fr[2], g);
  t('predict offers the right next node among others', ch && ch.options.includes(ch.right) && ch.options.length > 1, ch);
}

console.log('\nsorting');
for (const algo of Sort.ALGOS) {
  let allSorted = true, altOk = true;
  for (let trial = 0; trial < 25; trial++) {
    const arr = Array.from({ length: 3 + rnd(8) }, () => rnd(50));
    const fr = Sort.frames(arr, algo);
    const out = fr.at(-1).arr;
    if (out.join() !== arr.slice().sort((a, b) => a - b).join()) allSorted = false;
    fr.forEach((f, j) => { if (j && Sort.alternatives(fr[j - 1], f).some((a) => a.arr.join() === f.arr.join())) altOk = false; });
  }
  t(`${algo} sort always ends sorted`, allSorted);
  t(`${algo}: predict alternatives are never right`, altOk);
}

console.log('\nstack, queue, list');
{
  let s = { stack: [], queue: [] };
  s = Lin.sq(s, 'push', 1).state; s = Lin.sq(s, 'push', 2).state;
  s = Lin.sq(s, 'enqueue', 1).state; s = Lin.sq(s, 'enqueue', 2).state;
  t('pop is LIFO', Lin.sq(s, 'pop').removed === 2);
  t('dequeue is FIFO', Lin.sq(s, 'dequeue').removed === 1);
  t('underflow is explained, not thrown', /underflow/.test(Lin.sq({ stack: [], queue: [] }, 'pop').frames[0].note));
  let l = { nodes: [4, 9, 15] };
  t('insertAt 1', Lin.list(l, 'insertAt', 7, 1).state.nodes.join() === '4,7,9,15');
  t('insertHead', Lin.list(l, 'insertHead', 1).state.nodes.join() === '1,4,9,15');
  t('insertTail', Lin.list(l, 'insertTail', 20).state.nodes.join() === '4,9,15,20');
  t('delete middle', Lin.list(l, 'delete', 9).state.nodes.join() === '4,15');
  t('delete missing leaves it unchanged', Lin.list(l, 'delete', 99).state.nodes.join() === '4,9,15');
  const r = Lin.list(l, 'insertAt', 7, 1);
  const last = r.frames.at(-1);
  const alts = Lin.listAlternatives({ nodes: l.nodes }, last);
  t('list alternatives include the lost-tail bug', alts.some((a) => a.nodes.join() === '4,7'), alts);
  t('...and never the right answer', !alts.some((a) => a.nodes.join() === last.nodes.join()));
  t('the relink order is spelled out', r.frames.some((f) => /FIRST/.test(f.note)));
}

console.log('\nrenderers');
{
  t('heap renders svg', /^<svg/.test(R.heap({ arr: [1, 2, 3], hi: [0] })));
  t('empty tree renders', /empty tree/.test(R.tree({ tree: null })));
  t('values are escaped', !/<script>/.test(R.linkedList({ nodes: ['<script>'] })));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
