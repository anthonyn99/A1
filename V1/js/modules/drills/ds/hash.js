/* ============================================================================
 * StudyOS drills — hash table frames (chaining, linear, quadratic probing)
 * ============================================================================
 * h(k) = k mod m. Probing tries (h + i) mod m (linear) or (h + i²) mod m
 * (quadratic) for i = 0, 1, 2, …; chaining appends to the bucket's list.
 * State: { m, mode, table } — table[i] is a key, null, or (chaining) an array.
 * ------------------------------------------------------------------------- */

export function empty(m = 7, mode = 'linear') {
  return { m, mode, table: Array.from({ length: m }, () => (mode === 'chaining' ? [] : null)) };
}

const probe = (mode, h, i, m) => (mode === 'quadratic' ? (h + i * i) % m : (h + i) % m);
const clone = (t) => t.map((x) => (Array.isArray(x) ? x.slice() : x));

export function insert(state, k) {
  const { m, mode } = state;
  const table = clone(state.table);
  const h0 = ((k % m) + m) % m;
  const frames = [{ table: clone(table), hi: [h0], note: `h(${k}) = ${k} mod ${m} = ${h0}.` }];
  if (mode === 'chaining') {
    if (table[h0].includes(k)) {
      frames.push({ table: clone(table), hi: [h0], note: `${k} is already in bucket ${h0}.` });
      return { frames, state };
    }
    table[h0].push(k);
    frames.push({ table: clone(table), hi: [h0], note: table[h0].length > 1 ? `Collision: append ${k} to bucket ${h0}'s chain.` : `Bucket ${h0} is empty: store ${k} there.`, placed: h0 });
    return { frames, state: { ...state, table } };
  }
  for (let i = 0; i < m; i++) {
    const slot = probe(mode, h0, i, m);
    if (table[slot] === k) {
      frames.push({ table: clone(table), hi: [slot], note: `${k} is already at slot ${slot}.` });
      return { frames, state };
    }
    if (table[slot] === null) {
      table[slot] = k;
      frames.push({ table: clone(table), hi: [slot], note: i === 0 ? `Slot ${slot} is free: store ${k}.` : `Slot ${slot} is free: store ${k} (after ${i} probe${i === 1 ? '' : 's'}).`, placed: slot, probe: i });
      return { frames, state: { ...state, table } };
    }
    const next = probe(mode, h0, i + 1, m);
    frames.push({ table: clone(table), hi: [slot], note: `Slot ${slot} holds ${table[slot]} — collision. ${mode === 'quadratic' ? `Try (${h0} + ${i + 1}²) mod ${m} = ${next}.` : `Try slot ${next}.`}` });
  }
  frames.push({ table: clone(table), hi: [], note: `No free slot found for ${k}${mode === 'quadratic' ? ' — quadratic probing can miss free slots when the table is over half full' : ' — the table is full'}.` });
  return { frames, state };
}

/** Wrong placements: home slot (overwrite), linear-vs-quadratic confusion, off by one. */
export function alternatives(prev, frame) {
  if (frame.placed == null) return [];
  const m = prev.table.length;
  const key = frame.table[frame.placed];
  const k = Array.isArray(key) ? key[key.length - 1] : key;
  const cand = new Set([(frame.placed + 1) % m, (frame.placed + m - 1) % m, ((k % m) + m) % m]);
  cand.delete(frame.placed);
  return [...cand].slice(0, 3).map((slot) => {
    const t = clone(prev.table);
    if (Array.isArray(t[slot])) t[slot].push(k); else t[slot] = k;
    return { table: t, hi: [slot] };
  });
}

export default { empty, insert, alternatives };
