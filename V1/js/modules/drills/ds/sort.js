/* ============================================================================
 * StudyOS drills — sorting frames
 * ============================================================================
 * Frames: { arr, hi: [indices being compared/moved], sorted: [final indices],
 *           note, swap?: [i, j] }.
 * Bubble / insertion / selection show every compare; merge shows each merge
 * of two runs; quick uses Lomuto partitioning with the LAST element as pivot.
 * ------------------------------------------------------------------------- */

export const ALGOS = ['bubble', 'insertion', 'selection', 'merge', 'quick'];

export function frames(input, algo) {
  const a = input.slice();
  const out = [{ arr: a.slice(), hi: [], sorted: [], note: `Start: [${a.join(', ')}].` }];
  const push = (f) => out.push({ arr: a.slice(), sorted: [], ...f });

  if (algo === 'bubble') {
    const done = [];
    for (let end = a.length - 1; end > 0; end--) {
      let swapped = false;
      for (let i = 0; i < end; i++) {
        if (a[i] > a[i + 1]) {
          [a[i], a[i + 1]] = [a[i + 1], a[i]]; swapped = true;
          push({ hi: [i, i + 1], sorted: done.slice(), swap: [i, i + 1], note: `${a[i + 1]} > ${a[i]}: swap.` });
        } else {
          push({ hi: [i, i + 1], sorted: done.slice(), note: `${a[i]} ≤ ${a[i + 1]}: leave.` });
        }
      }
      done.push(end);
      push({ hi: [], sorted: done.slice(), note: `${a[end]} has bubbled to its final place.` });
      if (!swapped) { push({ hi: [], sorted: a.map((_, i) => i), note: 'No swaps in that pass: sorted.' }); return out; }
    }
  } else if (algo === 'insertion') {
    for (let i = 1; i < a.length; i++) {
      const key = a[i];
      let j = i - 1;
      push({ hi: [i], note: `Insert ${key} into the sorted prefix.` });
      while (j >= 0 && a[j] > key) {
        a[j + 1] = a[j]; a[j] = key;
        push({ hi: [j, j + 1], swap: [j, j + 1], note: `${a[j + 1]} > ${key}: shift it right.` });
        j--;
      }
    }
  } else if (algo === 'selection') {
    for (let i = 0; i < a.length - 1; i++) {
      let m = i;
      for (let j = i + 1; j < a.length; j++) if (a[j] < a[m]) m = j;
      if (m !== i) { [a[i], a[m]] = [a[m], a[i]]; push({ hi: [i, m], swap: [i, m], sorted: [...Array(i + 1).keys()], note: `Smallest remaining is ${a[i]}: swap it into position ${i}.` }); }
      else push({ hi: [i], sorted: [...Array(i + 1).keys()], note: `${a[i]} is already the smallest remaining.` });
    }
  } else if (algo === 'merge') {
    const merge = (lo, mid, hi) => {
      const L = a.slice(lo, mid), R = a.slice(mid, hi);
      let i = 0, j = 0, k = lo;
      while (i < L.length && j < R.length) a[k++] = L[i] <= R[j] ? L[i++] : R[j++];
      while (i < L.length) a[k++] = L[i++];
      while (j < R.length) a[k++] = R[j++];
      push({ hi: [...Array(hi - lo).keys()].map((x) => x + lo), note: `Merge [${L.join(', ')}] and [${R.join(', ')}] → [${a.slice(lo, hi).join(', ')}].`, merged: [lo, hi] });
    };
    const sort = (lo, hi) => { if (hi - lo < 2) return; const mid = (lo + hi) >> 1; sort(lo, mid); sort(mid, hi); merge(lo, mid, hi); };
    sort(0, a.length);
  } else if (algo === 'quick') {
    const q = (lo, hi) => {
      if (lo >= hi) return;
      const pivot = a[hi];
      push({ hi: [hi], note: `Partition [${a.slice(lo, hi + 1).join(', ')}] around pivot ${pivot}.` });
      let i = lo;
      for (let j = lo; j < hi; j++) {
        if (a[j] < pivot) {
          if (i !== j) { [a[i], a[j]] = [a[j], a[i]]; push({ hi: [i, j], swap: [i, j], note: `${a[i]} < ${pivot}: swap it into the low side.` }); }
          i++;
        }
      }
      if (i !== hi) { [a[i], a[hi]] = [a[hi], a[i]]; push({ hi: [i, hi], swap: [i, hi], note: `Put pivot ${pivot} in its final place, index ${i}.` }); }
      else push({ hi: [i], note: `Pivot ${pivot} is already in its final place.` });
      q(lo, i - 1); q(i + 1, hi);
    };
    q(0, a.length - 1);
  }
  out.push({ arr: a.slice(), hi: [], sorted: a.map((_, i) => i), note: `Sorted: [${a.join(', ')}].` });
  return out;
}

/** Wrong next arrays for a swap frame: no swap, or a neighbouring swap. */
export function alternatives(prev, frame) {
  if (!frame.swap) return [];
  const [i, j] = frame.swap;
  const out = [prev.arr.slice()];
  for (const [x, y] of [[i, j + 1], [i - 1, j], [Math.min(i, j), Math.max(i, j) + 1]]) {
    if (x >= 0 && y < prev.arr.length && x !== y) { const b = prev.arr.slice(); [b[x], b[y]] = [b[y], b[x]]; out.push(b); }
  }
  const key = (x) => x.join(',');
  const right = key(frame.arr);
  return [...new Map(out.filter((x) => key(x) !== right).map((x) => [key(x), x])).values()].slice(0, 3).map((arr) => ({ arr, hi: [] }));
}

export default { ALGOS, frames, alternatives };
