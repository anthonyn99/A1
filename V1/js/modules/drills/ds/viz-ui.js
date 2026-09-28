/* ============================================================================
 * StudyOS drills — data-structure visualizer core
 * ============================================================================
 * One player for seven structures. An operation (insert 7, dequeue, run BFS)
 * produces FRAMES from a pure module (heap.js, avl.js, …); the player shows
 * them with Step / Play / Reset and the frame's one-line explanation.
 *
 * ── PREDICT MODE ──────────────────────────────────────────────────────────
 * With Predict on, before a frame that is a real decision (a swap, a
 * rotation, a probe, the next BFS node) the player shows the right next state
 * beside the wrong states students actually produce, as thumbnails. Picking
 * one is scored (ctx.record) and then the true frame plays. Frames that are
 * not decisions just play.
 * ------------------------------------------------------------------------- */

import * as R from './render.js';
import * as Heap from './heap.js';
import * as AVL from './avl.js';
import * as Hash from './hash.js';
import * as G from './graph.js';
import * as Sort from './sort.js';
import * as Lin from './linear.js';

const rand = (n = 99) => 1 + Math.floor(Math.random() * n);
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const nums = (text) => String(text || '').split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));

/* Per-structure config: initial state, controls, how an op makes frames, how
 * a frame renders, and the wrong alternatives for predict mode. */
const MODES = {
  heap: {
    topic: 'Heaps', init: () => ({ arr: [], kind: 'min' }),
    controls: `<input class="sp-input" data-v type="number" placeholder="value" style="width:90px">
      <button class="sp-btn primary" data-op="insert">Insert</button><button class="sp-btn" data-op="removeTop">Remove top</button>
      <button class="sp-btn" data-op="random">+ random</button>
      <label class="sp-chip"><input type="checkbox" data-max> max-heap</label>`,
    presets: [['Insert 40 20 60 10 30 5', 'insert', [40, 20, 60, 10, 30, 5]]],
    run(st, op, v) { return op === 'removeTop' ? Heap.removeTop(st) : Heap.insert(st, v); },
    render: (f) => R.heap(f), alt: Heap.alternatives,
  },
  avl: {
    topic: 'AVL rotations', init: () => null,
    controls: `<input class="sp-input" data-v type="number" placeholder="key" style="width:90px">
      <button class="sp-btn primary" data-op="insert">Insert</button><button class="sp-btn" data-op="random">+ random</button>`,
    presets: [['RR: 10 20 30', 'insert', [10, 20, 30]], ['LL: 30 20 10', 'insert', [30, 20, 10]],
              ['LR: 30 10 20', 'insert', [30, 10, 20]], ['RL: 10 30 20', 'insert', [10, 30, 20]],
              ['Build: 50 30 70 20 40 35 36', 'insert', [50, 30, 70, 20, 40, 35, 36]]],
    run(st, op, v) { const r = AVL.insert(st, v); return { frames: r.frames, state: r.root }; },
    render: (f) => R.tree(f), alt: AVL.alternatives,
  },
  hash: {
    topic: 'Hashing', init: () => Hash.empty(7, 'linear'),
    controls: `<input class="sp-input" data-v type="number" placeholder="key" style="width:90px">
      <button class="sp-btn primary" data-op="insert">Insert</button><button class="sp-btn" data-op="random">+ random</button>
      <select class="sp-input" data-hmode><option value="linear">Linear probing</option><option value="quadratic">Quadratic probing</option><option value="chaining">Separate chaining</option></select>
      <select class="sp-input" data-hsize><option>7</option><option>11</option><option>13</option></select>`,
    presets: [['Insert 10 17 24 3 31', 'insert', [10, 17, 24, 3, 31]]],
    run(st, op, v) { return Hash.insert(st, v); },
    render: (f) => R.hash(f), alt: Hash.alternatives,
  },
  sort: {
    topic: 'Sorting', init: () => ({ arr: [38, 27, 43, 3, 9, 82, 10], algo: 'bubble' }),
    controls: `<select class="sp-input" data-algo>${Sort.ALGOS.map((a) => `<option value="${a}">${a[0].toUpperCase() + a.slice(1)} sort</option>`).join('')}</select>
      <button class="sp-btn primary" data-op="sort">Sort it</button><button class="sp-btn" data-op="shuffle">New array</button>`,
    presets: [],
    run(st, op) { const fr = Sort.frames(st.arr, st.algo); return { frames: fr, state: { ...st, arr: fr[fr.length - 1].arr } }; },
    render: (f) => R.bars(f), alt: Sort.alternatives,
  },
  stackqueue: {
    topic: 'Stacks & queues', init: () => ({ stack: [3, 8], queue: [5, 1] }),
    controls: `<input class="sp-input" data-v type="number" placeholder="value" style="width:90px">
      <button class="sp-btn primary" data-op="push">push</button><button class="sp-btn" data-op="pop">pop</button>
      <button class="sp-btn primary" data-op="enqueue">enqueue</button><button class="sp-btn" data-op="dequeue">dequeue</button>`,
    presets: [],
    run(st, op, v) { return Lin.sq(st, op, v); },
    render: (f) => R.stackQueue(f), alt: Lin.sqAlternatives,
  },
  list: {
    topic: 'Linked lists', init: () => ({ nodes: [4, 9, 15] }),
    controls: `<input class="sp-input" data-v type="number" placeholder="value" style="width:80px">
      <input class="sp-input" data-i type="number" placeholder="index" style="width:70px">
      <button class="sp-btn primary" data-op="insertHead">Insert head</button><button class="sp-btn" data-op="insertTail">Insert tail</button>
      <button class="sp-btn" data-op="insertAt">Insert at index</button><button class="sp-btn" data-op="delete">Delete value</button>`,
    presets: [],
    run(st, op, v, i) { return Lin.list(st, op, v, i); },
    render: (f) => R.linkedList(f), alt: Lin.listAlternatives,
  },
};

export function mount(host, ctx) {
  const { esc } = ctx;
  if (ctx.mode === 'graph') return mountGraph(host, ctx);
  const M = MODES[ctx.mode];
  if (!M) { host.textContent = 'Unknown visualizer.'; return null; }

  let state = M.init();
  let frames = [{ ...snapshot(state), note: 'Pick an operation below.' }];
  let k = 0;
  const pending = [];        // queued [op, value] from presets / batch input
  let timer = null;

  function snapshot(st) {
    if (ctx.mode === 'avl') return { tree: st, hi: [] };
    if (ctx.mode === 'heap' || ctx.mode === 'sort') return { arr: st.arr.slice(), hi: [], sorted: [] };
    if (ctx.mode === 'hash') return { table: st.table.map((x) => (Array.isArray(x) ? x.slice() : x)), hi: [] };
    if (ctx.mode === 'stackqueue') return { stack: st.stack.slice(), queue: st.queue.slice() };
    return { nodes: st.nodes.slice() };
  }

  host.innerHTML = `
    <div class="sp-panel">
      <div class="sp-row" style="margin-bottom:8px">${M.controls}</div>
      ${M.presets.length ? `<div class="sp-row" style="margin-bottom:8px"><span class="sp-muted" style="font-size:11px;font-family:var(--mono)">Try:</span>
        ${M.presets.map((p, i) => `<button class="sp-chip" data-preset="${i}">${esc(p[0])}</button>`).join('')}</div>` : ''}
      <div class="sp-row"><button class="sp-btn" data-step>Step ▸</button><button class="sp-btn" data-play>Play ▸▸</button>
        <button class="sp-btn" data-reset>Reset</button>
        <label class="sp-chip" title="Before each decision, guess the next state"><input type="checkbox" data-predict> Predict mode</label>
        <span class="sp-muted" data-pos style="font-family:var(--mono);font-size:11px;margin-left:auto"></span></div>
    </div>
    <div data-stage></div>
    <div data-note style="font-size:14px;margin:10px 2px;min-height:20px"></div>
    <div data-predict-area></div>`;
  const q = (s) => host.querySelector(s);
  const stage = q('[data-stage]'), noteEl = q('[data-note]'), pa = q('[data-predict-area]');

  const paint = () => {
    const f = frames[k];
    stage.innerHTML = M.render(f);
    noteEl.textContent = f.note || '';
    q('[data-pos]').textContent = frames.length > 1 ? `step ${k + 1}/${frames.length}` : '';
  };

  const startOp = (op, v, i) => {
    const r = M.run(state, op, v, i);
    if (!r.frames.length) return false;
    state = r.state;
    frames = r.frames;
    k = 0;
    paint();
    return true;
  };

  const atEnd = () => k >= frames.length - 1;
  const advance = () => {
    pa.innerHTML = '';
    if (!atEnd()) {
      const prev = frames[k], next = frames[k + 1];
      const wrong = q('[data-predict]').checked && M.alt ? M.alt(prev, next) : [];
      if (wrong.length) return askPredict(prev, next, wrong);
      k++; paint(); return true;
    }
    if (pending.length) { const [op, v] = pending.shift(); return startOp(op, v); }
    return false;
  };

  const askPredict = (prev, next, wrong) => {
    stopPlay();
    const opts = shuffle([{ f: next, right: true }, ...wrong.map((w) => ({ f: { ...prev, ...w }, right: false }))]);
    pa.innerHTML = `<div class="sp-panel"><div style="margin-bottom:8px">What does it look like after the next step?</div>
      <div class="sp-grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">
        ${opts.map((o, j) => `<button class="sp-card" data-pick="${j}" style="padding:6px">${M.render(o.f)}</button>`).join('')}
      </div></div>`;
    pa.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = () => {
        const ok = opts[Number(b.dataset.pick)].right;
        ctx.record({ topic: M.topic, correct: ok, difficulty: ctx.mode === 'avl' ? 3 : 2 });
        pa.innerHTML = `<div class="${ok ? 'sp-ok' : 'sp-bad'}" style="font-size:13px;margin:4px 2px">${ok ? '✓ Right.' : '✗ Not that one — here is what happens:'}</div>`;
        k++; paint();
      };
    });
    return true;
  };

  const stopPlay = () => { if (timer) { clearInterval(timer); timer = null; q('[data-play]').textContent = 'Play ▸▸'; } };
  q('[data-step]').onclick = () => { stopPlay(); advance(); };
  q('[data-play]').onclick = () => {
    if (timer) return stopPlay();
    q('[data-play]').textContent = 'Pause ❚❚';
    timer = setInterval(() => { if (pa.querySelector('[data-pick]')) return; if (!advance()) stopPlay(); }, 850);
  };
  q('[data-reset]').onclick = () => { stopPlay(); pending.length = 0; state = M.init(); applyToggles(); frames = [{ ...snapshot(state), note: 'Reset.' }]; k = 0; pa.innerHTML = ''; paint(); };

  // Finish any animation instantly, then run an op.
  const doOp = (op, v, i) => {
    stopPlay(); pa.innerHTML = '';
    k = frames.length - 1;
    startOp(op, v, i);
  };
  const valueIn = () => { const el = q('[data-v]'); const n = el ? Number(el.value) : NaN; return Number.isFinite(n) && el.value !== '' ? n : null; };

  function applyToggles() {
    const mx = q('[data-max]'); if (mx && ctx.mode === 'heap') state.kind = mx.checked ? 'max' : 'min';
    const hm = q('[data-hmode]'), hs = q('[data-hsize]');
    if (hm && ctx.mode === 'hash') state = Hash.empty(Number(hs.value), hm.value);
    const al = q('[data-algo]'); if (al && ctx.mode === 'sort') state.algo = al.value;
  }

  host.querySelectorAll('[data-op]').forEach((b) => {
    b.onclick = () => {
      const op = b.dataset.op;
      if (op === 'random') { doOp('insert', rand()); return; }
      if (op === 'shuffle') { state = { ...state, arr: Array.from({ length: 7 + Math.floor(Math.random() * 3) }, () => rand(90)) }; frames = [{ ...snapshot(state), note: 'New array. Pick an algorithm and press "Sort it".' }]; k = 0; paint(); return; }
      if (op === 'sort') { applyToggles(); doOp('sort'); return; }
      const needsValue = ['insert', 'push', 'enqueue', 'insertHead', 'insertTail', 'insertAt', 'delete'].includes(op);
      const v = valueIn();
      if (needsValue && v == null) { ctx.toast('ℹ️', 'Enter a value first'); return; }
      const iEl = q('[data-i]');
      doOp(op, v, iEl ? Number(iEl.value) : 0);
      if (q('[data-v]')) q('[data-v]').select();
    };
  });
  const mx = q('[data-max]');
  if (mx) mx.onchange = () => { state = { arr: [], kind: mx.checked ? 'max' : 'min' }; frames = [{ ...snapshot(state), note: `Empty ${state.kind}-heap.` }]; k = 0; paint(); };
  const hm = q('[data-hmode]'), hs = q('[data-hsize]');
  const resetHash = () => { state = Hash.empty(Number(hs.value), hm.value); frames = [{ ...snapshot(state), note: `Empty table of size ${hs.value}, ${hm.options[hm.selectedIndex].text.toLowerCase()}.` }]; k = 0; paint(); };
  if (hm) { hm.onchange = resetHash; hs.onchange = resetHash; }
  const al = q('[data-algo]');
  if (al) al.onchange = () => { state = { ...state, algo: al.value }; };
  host.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => {
      const [, op, values] = M.presets[Number(b.dataset.preset)];
      stopPlay(); pa.innerHTML = '';
      state = M.init(); applyToggles();
      pending.length = 0;
      values.slice(1).forEach((v) => pending.push([op, v]));
      startOp(op, values[0]);
      noteEl.textContent = (frames[0].note || '') + '  (Step or Play to continue.)';
    };
  });
  const vIn = q('[data-v]');
  if (vIn) vIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = host.querySelector('[data-op].primary'); if (first) first.click(); } });

  paint();
  return () => stopPlay();
}

// ── Graph traversal ─────────────────────────────────────────────────────────
function mountGraph(host, ctx) {
  const { esc } = ctx;
  let g = G.sample();
  let frames = [];
  let k = 0;
  let selected = null;
  let timer = null;
  host.innerHTML = `
    <div class="sp-panel"><div class="sp-row" style="margin-bottom:8px">
      <select class="sp-input" data-algo><option value="bfs">Breadth-first (queue)</option><option value="dfs">Depth-first (stack)</option></select>
      <label class="sp-for">start <select class="sp-input" data-start></select></label>
      <button class="sp-btn primary" data-run>Traverse</button>
      <button class="sp-btn" data-add>+ node</button>
      <label class="sp-chip"><input type="checkbox" data-predict> Predict mode</label></div>
      <div class="sp-muted" style="font-size:11px;font-family:var(--mono)">Edit: tap two nodes to add or remove the edge between them. Neighbours are taken in alphabetical order.</div>
    </div>
    <div data-stage></div>
    <div class="sp-row" style="margin:8px 0"><button class="sp-btn" data-step>Step ▸</button><button class="sp-btn" data-play>Play ▸▸</button>
      <span class="sp-muted" data-front style="font-family:var(--mono);font-size:12px"></span></div>
    <div data-note style="font-size:14px;margin:6px 2px;min-height:20px"></div>
    <div data-predict-area></div>`;
  const q = (s) => host.querySelector(s);
  const stage = q('[data-stage]'), pa = q('[data-predict-area]');
  const fillStart = () => {
    const cur = q('[data-start]').value || 'A';
    q('[data-start]').innerHTML = g.nodes.map((n) => `<option${n.id === cur ? ' selected' : ''}>${esc(n.id)}</option>`).join('');
  };
  const paint = () => {
    const f = frames[k] || {};
    stage.innerHTML = R.graph(g, f, selected);
    const algo = q('[data-algo]').value;
    q('[data-front]').textContent = frames.length ? `${algo === 'bfs' ? 'queue' : 'stack'}: [${(f.frontier || []).join(', ')}]  visited: ${(f.visited || []).join(' ')}` : '';
    q('[data-note]').textContent = f.note || 'Tap Traverse to start.';
    stage.querySelectorAll('[data-node]').forEach((el) => {
      el.onclick = () => {
        if (frames.length) return;          // editing only when no traversal is showing
        const id = el.getAttribute('data-node');
        if (!selected) { selected = id; }
        else { g = G.toggleEdge(g, selected, id); selected = null; }
        paint();
      };
    });
  };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; q('[data-play]').textContent = 'Play ▸▸'; } };
  const advance = () => {
    pa.innerHTML = '';
    if (k >= frames.length - 1) return false;
    const prev = frames[k], next = frames[k + 1];
    const ch = q('[data-predict]').checked ? G.choices(prev, next, g) : null;
    if (ch && ch.options.length > 1) {
      stop();
      pa.innerHTML = `<div class="sp-panel"><div style="margin-bottom:8px">Which node is visited next?</div>
        <div class="sp-row">${ch.options.map((o) => `<button class="sp-btn" data-pick="${esc(o)}">${esc(o)}</button>`).join('')}</div></div>`;
      pa.querySelectorAll('[data-pick]').forEach((b) => {
        b.onclick = () => {
          const ok = b.dataset.pick === ch.right;
          ctx.record({ topic: q('[data-algo]').value === 'bfs' ? 'BFS' : 'DFS', correct: ok, difficulty: 2 });
          pa.innerHTML = `<div class="${ok ? 'sp-ok' : 'sp-bad'}" style="font-size:13px;margin:4px 2px">${ok ? '✓ Right.' : `✗ It is ${esc(ch.right)}.`}</div>`;
          k++; paint();
        };
      });
      return true;
    }
    k++; paint(); return true;
  };
  q('[data-run]').onclick = () => { stop(); selected = null; frames = G.traverse(g, q('[data-start]').value, q('[data-algo]').value); k = 0; pa.innerHTML = ''; paint(); };
  q('[data-add]').onclick = () => { stop(); frames = []; g = G.addNode(g); fillStart(); paint(); };
  q('[data-algo]').onchange = () => { stop(); frames = []; paint(); };
  q('[data-step]').onclick = () => { stop(); if (!frames.length) q('[data-run]').click(); else advance(); };
  q('[data-play]').onclick = () => {
    if (timer) return stop();
    if (!frames.length) q('[data-run]').click();
    q('[data-play]').textContent = 'Pause ❚❚';
    timer = setInterval(() => { if (pa.querySelector('[data-pick]')) return; if (!advance()) { stop(); } }, 900);
  };
  fillStart();
  paint();
  return () => stop();
}

export default { mount };
