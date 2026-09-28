/* ============================================================================
 * StudyOS drills — binary heap frames
 * ============================================================================
 * A heap operation becomes a list of FRAMES, one per visible step:
 *   { arr, hi: [indices], note }
 * The viz core plays them; predict mode asks which frame comes next, using
 * alternatives() for the wrong answers students actually give.
 * ------------------------------------------------------------------------- */

const better = (kind) => (a, b) => (kind === 'max' ? a > b : a < b);
const parent = (i) => Math.floor((i - 1) / 2);

export function insert(state, v) {
  const b = better(state.kind);
  const arr = [...state.arr, v];
  let i = arr.length - 1;
  const frames = [{ arr: arr.slice(), hi: [i], note: `Place ${v} at the next free slot (index ${i}).` }];
  while (i > 0 && b(arr[i], arr[parent(i)])) {
    const p = parent(i);
    [arr[i], arr[p]] = [arr[p], arr[i]];
    frames.push({ arr: arr.slice(), hi: [p, i], note: `${arr[p]} ${state.kind === 'max' ? '>' : '<'} ${arr[i]}: swap with its parent (sift up).`, swap: [i, p] });
    i = p;
  }
  frames.push({ arr: arr.slice(), hi: [i], note: i === 0 ? `${arr[0]} reached the root. Heap order restored.` : `Parent ${arr[parent(i)]} is ${state.kind === 'max' ? 'larger' : 'smaller'} — stop.` });
  return { frames, state: { ...state, arr } };
}

export function removeTop(state) {
  const b = better(state.kind);
  if (!state.arr.length) return { frames: [{ arr: [], hi: [], note: 'The heap is empty.' }], state };
  const arr = state.arr.slice();
  const top = arr[0];
  const frames = [{ arr: arr.slice(), hi: [0], note: `Remove the root ${top}.` }];
  const last = arr.pop();
  if (!arr.length) {
    frames.push({ arr: [], hi: [], note: `${top} removed. The heap is empty.` });
    return { frames, state: { ...state, arr }, removed: top };
  }
  arr[0] = last;
  frames.push({ arr: arr.slice(), hi: [0], note: `Move the last element ${last} to the root.` });
  let i = 0;
  for (;;) {
    const l = 2 * i + 1, r = l + 1;
    let c = i;
    if (l < arr.length && b(arr[l], arr[c])) c = l;
    if (r < arr.length && b(arr[r], arr[c])) c = r;
    if (c === i) break;
    [arr[i], arr[c]] = [arr[c], arr[i]];
    frames.push({ arr: arr.slice(), hi: [i, c], note: `Swap ${arr[c]} down with its ${state.kind === 'max' ? 'larger' : 'smaller'} child ${arr[i]} (sift down).`, swap: [i, c] });
    i = c;
  }
  frames.push({ arr: arr.slice(), hi: [i], note: `Heap order restored. Removed ${top}.` });
  return { frames, state: { ...state, arr }, removed: top };
}

/**
 * Wrong next frames for a swap step: not swapping, swapping with the OTHER
 * child (the classic sift-down mistake), or swapping with the root.
 */
export function alternatives(prev, frame) {
  if (!frame.swap) return [];
  const [a, b] = frame.swap;
  const out = [];
  out.push(prev.arr.slice());                               // stopped too early
  const lo = Math.min(a, b);
  const sibling = (i) => (i % 2 ? i + 1 : i - 1);
  const hiChild = Math.max(a, b);
  const sib = sibling(hiChild);
  if (sib > 0 && sib < prev.arr.length) {
    const x = prev.arr.slice(); [x[lo], x[sib]] = [x[sib], x[lo]]; out.push(x);
  }
  if (lo !== 0) { const x = prev.arr.slice(); [x[0], x[hiChild]] = [x[hiChild], x[0]]; out.push(x); }
  const key = (x) => x.join(',');
  const right = key(frame.arr);
  return [...new Map(out.filter((x) => key(x) !== right).map((x) => [key(x), x])).values()].slice(0, 3)
    .map((arr) => ({ arr, hi: [] }));
}

export const isHeap = (arr, kind = 'min') => arr.every((v, i) => i === 0 || !better(kind)(v, arr[parent(i)]));

export default { insert, removeTop, alternatives, isHeap };
