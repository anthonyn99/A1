/* ============================================================================
 * StudyOS drills — AVL tree frames
 * ============================================================================
 * Immutable nodes { v, l, r, h }. An insert becomes frames:
 *   descend (one frame per comparison) → place → check balance on the way up
 *   → name the case (LL / RR / LR / RL) → the rotated tree.
 * alternatives() for a rotation frame are the trees the OTHER rotations would
 * produce — the exact mistake predict mode is there to catch.
 * ------------------------------------------------------------------------- */

const h = (n) => (n ? n.h : 0);
const mk = (v, l = null, r = null) => ({ v, l, r, h: 1 + Math.max(h(l), h(r)) });
export const balance = (n) => (n ? h(n.l) - h(n.r) : 0);

export const rotR = (y) => { const x = y.l; return mk(x.v, x.l, mk(y.v, x.r, y.r)); };
export const rotL = (x) => { const y = x.r; return mk(y.v, mk(x.v, x.l, y.l), y.r); };
const lr = (n) => rotR(mk(n.v, rotL(n.l), n.r));
const rl = (n) => rotL(mk(n.v, n.l, rotR(n.r)));
export const ROTATIONS = { LL: rotR, RR: rotL, LR: lr, RL: rl };

/** Replace the subtree rooted at `path` (array of 'l'/'r') with `sub`. */
function replaceAt(root, path, sub) {
  if (!path.length) return sub;
  const [d, ...rest] = path;
  return d === 'l' ? mk(root.v, replaceAt(root.l, rest, sub), root.r) : mk(root.v, root.l, replaceAt(root.r, rest, sub));
}
const at = (root, path) => path.reduce((n, d) => (n ? n[d] : null), root);

export function contains(root, v) {
  let n = root;
  while (n) { if (v === n.v) return true; n = v < n.v ? n.l : n.r; }
  return false;
}

export function insert(root, v) {
  const frames = [];
  if (contains(root, v)) return { frames: [{ tree: root, hi: [v], note: `${v} is already in the tree — AVL trees hold distinct keys.` }], root };

  // Descend, recording the path.
  const path = [];
  let n = root;
  while (n) {
    const d = v < n.v ? 'l' : 'r';
    frames.push({ tree: root, hi: [n.v], note: `${v} ${d === 'l' ? '<' : '>'} ${n.v}: go ${d === 'l' ? 'left' : 'right'}.` });
    path.push(d);
    n = n[d];
  }
  // Place the leaf, then rebuild heights bottom-up (immutably).
  let tree = root ? replaceAt(root, path, mk(v)) : mk(v);
  const rebuildHeights = (t) => (t ? mk(t.v, rebuildHeights(t.l), rebuildHeights(t.r)) : null);
  tree = rebuildHeights(tree);
  frames.push({ tree, hi: [v], note: `Insert ${v} as a leaf.` });

  // Walk back up: the FIRST unbalanced ancestor is fixed by one (double) rotation.
  for (let k = path.length - 1; k >= 0; k--) {
    const p = path.slice(0, k);
    const node = at(tree, p);
    const bf = balance(node);
    if (Math.abs(bf) <= 1) continue;
    const kase = bf > 1 ? (v < node.l.v ? 'LL' : 'LR') : (v > node.r.v ? 'RR' : 'RL');
    const how = { LL: 'a single right rotation', RR: 'a single left rotation', LR: 'a left-right double rotation', RL: 'a right-left double rotation' }[kase];
    frames.push({ tree, hi: [node.v], note: `${node.v} has balance factor ${bf > 0 ? '+' : ''}${bf}: the ${kase} case, fixed by ${how}.` });
    const fixed = ROTATIONS[kase](node);
    tree = rebuildHeights(replaceAt(tree, p, fixed));
    frames.push({ tree, hi: [fixed.v], note: `After the rotation ${fixed.v} is the root of that subtree. Balanced.`, rotation: { path: p, kase, before: frames[frames.length - 1].tree } });
    return { frames, root: tree };
  }
  frames.push({ tree, hi: [], note: 'Every node has balance −1, 0 or +1. No rotation needed.' });
  return { frames, root: tree };
}

/** Wrong trees for a rotation frame: the other three rotations at that node. */
export function alternatives(prev, frame) {
  if (!frame.rotation) return [];
  const { path, kase, before } = frame.rotation;
  const node = at(before, path);
  const out = [];
  for (const [k, fn] of Object.entries(ROTATIONS)) {
    if (k === kase) continue;
    try {
      const sub = fn(node);
      out.push({ tree: replaceAt(before, path, sub), hi: [], label: k });
    } catch (e) { /* that rotation is not even possible here */ }
  }
  // The other classic mistake: rotating at the heavy CHILD instead of the
  // node that is actually out of balance.
  const heavy = balance(node) > 0 ? 'l' : 'r';
  if (node[heavy]) {
    for (const [k, fn] of Object.entries({ L: rotL, R: rotR })) {
      try { out.push({ tree: replaceAt(before, [...path, heavy], fn(node[heavy])), hi: [], label: 'child-' + k }); }
      catch (e) { /* not possible at that child */ }
    }
  }
  out.push({ tree: before, hi: [], label: 'none' });
  const key = (t) => JSON.stringify(t);
  const right = key(frame.tree);
  return [...new Map(out.filter((x) => key(x.tree) !== right).map((x) => [key(x.tree), x])).values()].slice(0, 3);
}

export const isAVL = (n) => !n || (Math.abs(balance(n)) <= 1 && isAVL(n.l) && isAVL(n.r)
  && (!n.l || max(n.l) < n.v) && (!n.r || min(n.r) > n.v));
const max = (n) => (n.r ? max(n.r) : n.v);
const min = (n) => (n.l ? min(n.l) : n.v);
export const inorder = (n) => (n ? [...inorder(n.l), n.v, ...inorder(n.r)] : []);

export default { insert, alternatives, balance, isAVL, inorder, contains, ROTATIONS };
