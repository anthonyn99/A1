/* ============================================================================
 * StudyOS drills — stack, queue and singly linked list frames
 * ============================================================================
 * Stack/queue state: { stack: [...bottom→top], queue: [...front→back] }.
 * List state: { nodes: [values head→tail] } with frames that walk a `cur`
 * pointer and show the relink, because the relink ORDER is what exams test
 * (set newNode.next before prev.next, or the rest of the list is lost).
 * ------------------------------------------------------------------------- */

export function sq(state, op, v) {
  const stack = state.stack.slice(), queue = state.queue.slice();
  const f = (note, extra = {}) => ({ stack: stack.slice(), queue: queue.slice(), note, ...extra });
  if (op === 'push') { stack.push(v); return { frames: [f(`push(${v}): ${v} goes on TOP.`, { hiStack: stack.length - 1 })], state: { stack, queue } }; }
  if (op === 'pop') {
    if (!stack.length) return { frames: [f('pop() on an empty stack — underflow.')], state };
    const x = stack.pop();
    return { frames: [f(`pop() removes the TOP: ${x}. Last in, first out.`, { removed: x, from: 'stack' })], state: { stack, queue }, removed: x };
  }
  if (op === 'enqueue') { queue.push(v); return { frames: [f(`enqueue(${v}): ${v} joins the BACK.`, { hiQueue: queue.length - 1 })], state: { stack, queue } }; }
  if (op === 'dequeue') {
    if (!queue.length) return { frames: [f('dequeue() on an empty queue — underflow.')], state };
    const x = queue.shift();
    return { frames: [f(`dequeue() removes the FRONT: ${x}. First in, first out.`, { removed: x, from: 'queue' })], state: { stack, queue }, removed: x };
  }
  return { frames: [], state };
}

/** Wrong answers for pop/dequeue: taking from the other end. */
export function sqAlternatives(prev, frame) {
  if (frame.removed == null) return [];
  if (frame.from === 'stack' && prev.stack.length > 1) return [{ stack: prev.stack.slice(1), queue: prev.queue.slice(), note: '' }];
  if (frame.from === 'queue' && prev.queue.length > 1) return [{ stack: prev.stack.slice(), queue: prev.queue.slice(0, -1), note: '' }];
  return [];
}

export function list(state, op, v, index) {
  const nodes = state.nodes.slice();
  const frames = [];
  const f = (ns, note, extra = {}) => frames.push({ nodes: ns.slice(), note, ...extra });
  if (op === 'insertHead') {
    f(nodes, `Create node ${v}; point its next at the current head${nodes.length ? ` (${nodes[0]})` : ' (null)'}.`, { pending: v, pendingAt: 0 });
    nodes.unshift(v);
    f(nodes, `Move head to ${v}.`, { hi: [0], placed: 0 });
  } else if (op === 'insertTail' || op === 'insertAt') {
    const at = op === 'insertTail' ? nodes.length : Math.max(0, Math.min(index | 0, nodes.length));
    if (at === 0) return list(state, 'insertHead', v);
    for (let i = 0; i < at; i++) f(nodes, i === 0 ? `cur = head (${nodes[0]}).` : `cur = cur.next (${nodes[i]}).`, { cur: i });
    f(nodes, `Create node ${v}; set ${v}.next = cur.next (${nodes[at] ?? 'null'}) FIRST, so the rest of the list is not lost.`, { cur: at - 1, pending: v, pendingAt: at });
    nodes.splice(at, 0, v);
    f(nodes, `Then cur.next = ${v}. Inserted at position ${at}.`, { hi: [at], placed: at });
  } else if (op === 'delete') {
    const i = nodes.indexOf(v);
    if (i < 0) {
      nodes.forEach((x, k) => f(nodes, `cur = ${x}: not ${v}.`, { cur: k }));
      f(nodes, `Reached null: ${v} is not in the list.`);
    } else if (i === 0) {
      f(nodes, `${v} is the head: head = head.next.`, { cur: 0 });
      nodes.shift();
      f(nodes, `${v} removed.`, { removedAt: 0 });
    } else {
      for (let k = 0; k < i; k++) f(nodes, `prev = ${nodes[k]}; prev.next is ${nodes[k + 1]}${nodes[k + 1] === v ? ' — found it.' : '.'}`, { cur: k });
      f(nodes, `Bypass it: prev.next = ${v}.next (${nodes[i + 1] ?? 'null'}).`, { cur: i - 1, hi: [i] });
      nodes.splice(i, 1);
      f(nodes, `${v} removed.`, { removedAt: i });
    }
  }
  return { frames, state: { nodes } };
}

/** Wrong results for an insert/delete: off-by-one position, or the dropped tail. */
export function listAlternatives(prev, frame) {
  const out = [];
  if (frame.placed != null) {
    const v = frame.nodes[frame.placed];
    for (const at of [frame.placed + 1, frame.placed - 1]) {
      if (at < 0 || at > prev.nodes.length) continue;
      const n = prev.nodes.slice(); n.splice(at, 0, v); out.push({ nodes: n });
    }
    // The classic bug: cur.next = new BEFORE new.next = cur.next loses the tail.
    if (frame.placed > 0) out.push({ nodes: [...prev.nodes.slice(0, frame.placed), v] });
  }
  if (frame.removedAt != null && prev.nodes.length > 1) {
    const n = prev.nodes.slice(); n.splice(Math.min(frame.removedAt + 1, n.length - 1), 1); out.push({ nodes: n });
  }
  const key = (x) => x.nodes.join(',');
  const right = frame.nodes.join(',');
  return [...new Map(out.filter((x) => key(x) !== right).map((x) => [key(x), x])).values()].slice(0, 3);
}

export default { sq, sqAlternatives, list, listAlternatives };
