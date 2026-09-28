/* ============================================================================
 * StudyOS drills — BFS / DFS frames on an editable graph
 * ============================================================================
 * Undirected graph { nodes: [{id, x, y}], edges: [[a, b]] }. Neighbours are
 * visited in ALPHABETICAL order — the convention exam traces use — so a trace
 * has exactly one right answer.
 *
 * Frames: { visited: [...order], frontier: [...queue or stack], current, note }.
 * Predict mode asks "which node is visited next?" (choices() below).
 * ------------------------------------------------------------------------- */

export function sample() {
  const pos = { A: [80, 60], B: [220, 50], C: [340, 90], D: [70, 190], E: [200, 170], F: [330, 210], G: [200, 280] };
  return {
    nodes: Object.entries(pos).map(([id, [x, y]]) => ({ id, x, y })),
    edges: [['A', 'B'], ['A', 'D'], ['B', 'C'], ['B', 'E'], ['D', 'E'], ['E', 'F'], ['C', 'F'], ['E', 'G'], ['D', 'G']],
  };
}

export function neighbours(g, id) {
  return g.edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a))
    .filter((x, i, arr) => arr.indexOf(x) === i).sort();
}

export function toggleEdge(g, a, b) {
  if (a === b) return g;
  const has = g.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  return { ...g, edges: has ? g.edges.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a))) : [...g.edges, [a, b].sort()] };
}

export function addNode(g) {
  const ids = g.nodes.map((n) => n.id);
  const id = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((c) => !ids.includes(c));
  if (!id) return g;
  const i = g.nodes.length;
  return { ...g, nodes: [...g.nodes, { id, x: 60 + (i * 97) % 320, y: 60 + ((i * 53) % 230) }] };
}

export function traverse(g, start, algo = 'bfs') {
  const frames = [];
  const visited = [];
  if (algo === 'bfs') {
    const queue = [start];
    const seen = new Set([start]);
    frames.push({ visited: [], frontier: queue.slice(), current: null, note: `Start: enqueue ${start}.` });
    while (queue.length) {
      const u = queue.shift();
      visited.push(u);
      const add = neighbours(g, u).filter((v) => !seen.has(v));
      add.forEach((v) => { seen.add(v); queue.push(v); });
      frames.push({ visited: visited.slice(), frontier: queue.slice(), current: u,
        note: `Dequeue ${u} and visit it.${add.length ? ` Enqueue its unseen neighbours ${add.join(', ')}.` : ' No unseen neighbours.'}` });
    }
  } else {
    // Iterative DFS that visits in the same order as the recursive version:
    // push neighbours in REVERSE alphabetical order so the smallest pops first.
    const stack = [start];
    const seen = new Set();
    frames.push({ visited: [], frontier: stack.slice(), current: null, note: `Start: push ${start}.` });
    while (stack.length) {
      const u = stack.pop();
      if (seen.has(u)) {
        frames.push({ visited: visited.slice(), frontier: stack.slice(), current: null, note: `Pop ${u} — already visited, skip.`, skip: true });
        continue;
      }
      seen.add(u);
      visited.push(u);
      const add = neighbours(g, u).filter((v) => !seen.has(v)).reverse();
      add.forEach((v) => stack.push(v));
      frames.push({ visited: visited.slice(), frontier: stack.slice(), current: u,
        note: `Pop ${u} and visit it.${add.length ? ` Push unvisited neighbours ${add.slice().reverse().join(', ')} (so ${add[add.length - 1]} is on top).` : ''}` });
    }
  }
  frames.push({ visited: visited.slice(), frontier: [], current: null, note: `Done. ${algo.toUpperCase()} order: ${visited.join(' → ')}.` });
  return frames;
}

/** For a visiting frame: the node visited, plus plausible wrong picks. */
export function choices(prev, frame, g) {
  if (!frame.current) return null;
  const pool = new Set([...(prev.frontier || []), ...g.nodes.map((n) => n.id).filter((id) => !prev.visited.includes(id))]);
  pool.delete(frame.current);
  const wrong = [...pool].slice(0, 3);
  return { right: frame.current, options: [frame.current, ...wrong].sort() };
}

export default { sample, neighbours, toggleEdge, addNode, traverse, choices };
