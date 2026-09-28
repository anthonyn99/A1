/* ============================================================================
 * StudyOS drills — SVG renderers for the data-structure visualizers
 * ============================================================================
 * Each returns an <svg> string sized by viewBox, so the same picture works as
 * the main view and as a predict-mode thumbnail. Colours come from the app's
 * CSS variables (inline SVG inherits them), so light/dark follow the app.
 * ------------------------------------------------------------------------- */

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HI = '#f0bd86', OK = '#8fd6ad', ACC = 'var(--accent)';

const svg = (w, h, body) =>
  `<svg class="sp-svg" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Mono, monospace" role="img">${body}</svg>`;

function node(x, y, label, { hi, r = 17, sub } = {}) {
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${hi ? HI : 'var(--bg3)'}" stroke="${hi ? HI : 'var(--text3)'}" stroke-width="1.5"/>
    <text x="${x}" y="${y + 4}" text-anchor="middle" font-size="12" fill="${hi ? '#1B1C1E' : 'var(--text)'}" font-weight="600">${esc(label)}</text>
    ${sub != null ? `<text x="${x + r + 3}" y="${y - r + 4}" font-size="9" fill="var(--text3)">${esc(sub)}</text>` : ''}`;
}
const line = (x1, y1, x2, y2, c = 'var(--text3)') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="1.4"/>`;

function boxes(values, y, { hi = [], labels = true, w = 38, x0 = 10, dim = [] } = {}) {
  return values.map((v, i) => {
    const x = x0 + i * w;
    const h = hi.includes(i);
    return `<rect x="${x}" y="${y}" width="${w - 4}" height="30" rx="3" fill="${h ? HI : dim.includes(i) ? 'rgba(143,214,173,.25)' : 'var(--bg3)'}" stroke="${h ? HI : 'var(--border)'}"/>
      <text x="${x + (w - 4) / 2}" y="${y + 19}" text-anchor="middle" font-size="12" fill="${h ? '#1B1C1E' : 'var(--text)'}">${v == null ? '' : esc(v)}</text>
      ${labels ? `<text x="${x + (w - 4) / 2}" y="${y + 43}" text-anchor="middle" font-size="9" fill="var(--text3)">${i}</text>` : ''}`;
  }).join('');
}

// ── Heap: tree above, array below ───────────────────────────────────────────
export function heap(frame) {
  const arr = frame.arr || [];
  const hi = frame.hi || [];
  const W = Math.max(420, arr.length * 40 + 20);
  const depth = Math.max(1, Math.ceil(Math.log2(arr.length + 1)));
  const H = 60 + depth * 58 + 60;
  const pos = arr.map((_, i) => {
    const d = Math.floor(Math.log2(i + 1));
    const idx = i - (2 ** d - 1);
    const span = W / (2 ** d);
    return [span * idx + span / 2, 34 + d * 58];
  });
  let body = '';
  arr.forEach((_, i) => { if (i > 0) { const p = Math.floor((i - 1) / 2); body += line(pos[p][0], pos[p][1], pos[i][0], pos[i][1]); } });
  arr.forEach((v, i) => { body += node(pos[i][0], pos[i][1], v, { hi: hi.includes(i) }); });
  body += boxes(arr, H - 58, { hi });
  if (!arr.length) body += `<text x="${W / 2}" y="60" text-anchor="middle" font-size="12" fill="var(--text3)">empty</text>`;
  return svg(W, H, body);
}

// ── AVL: in-order x, depth y, balance factor beside each node ───────────────
export function tree(frame) {
  const root = frame.tree;
  const hi = frame.hi || [];
  const nodes = [];
  let i = 0;
  const walk = (n, d) => { if (!n) return; walk(n.l, d + 1); nodes.push({ n, d, x: i++ }); walk(n.r, d + 1); };
  walk(root, 0);
  const W = Math.max(360, nodes.length * 46 + 30);
  const depth = nodes.reduce((m, x) => Math.max(m, x.d), 0);
  const H = 50 + depth * 62 + 30;
  const at = new Map(nodes.map((x) => [x.n, [25 + x.x * 46 + 10, 30 + x.d * 62]]));
  let body = '';
  for (const { n } of nodes) {
    const [x, y] = at.get(n);
    if (n.l) body += line(x, y, ...at.get(n.l));
    if (n.r) body += line(x, y, ...at.get(n.r));
  }
  for (const { n } of nodes) {
    const [x, y] = at.get(n);
    const bf = (n.l ? n.l.h : 0) - (n.r ? n.r.h : 0);
    body += node(x, y, n.v, { hi: hi.includes(n.v), sub: bf > 0 ? '+' + bf : String(bf) });
  }
  if (!nodes.length) body += `<text x="${W / 2}" y="50" text-anchor="middle" font-size="12" fill="var(--text3)">empty tree</text>`;
  return svg(W, H, body);
}

// ── Hash table ──────────────────────────────────────────────────────────────
export function hash(frame) {
  const t = frame.table || [];
  const hi = frame.hi || [];
  const chaining = t.some(Array.isArray);
  if (!chaining) {
    const W = Math.max(340, t.length * 46 + 20);
    return svg(W, 70, boxes(t, 10, { hi, w: 46 }));
  }
  const maxLen = t.reduce((m, c) => Math.max(m, c.length), 0);
  const W = 90 + Math.max(3, maxLen) * 56;
  const H = t.length * 38 + 16;
  let body = '';
  t.forEach((chain, i) => {
    const y = 8 + i * 38;
    const h = hi.includes(i);
    body += `<rect x="10" y="${y}" width="34" height="28" rx="3" fill="${h ? HI : 'var(--bg3)'}" stroke="var(--border)"/>
      <text x="27" y="${y + 18}" text-anchor="middle" font-size="11" fill="${h ? '#1B1C1E' : 'var(--text3)'}">${i}</text>`;
    chain.forEach((k, j) => {
      const x = 64 + j * 56;
      body += line(x - (j ? 14 : 20), y + 14, x, y + 14);
      body += `<rect x="${x}" y="${y + 2}" width="42" height="24" rx="3" fill="var(--bg3)" stroke="${ACC}"/>
        <text x="${x + 21}" y="${y + 18}" text-anchor="middle" font-size="12" fill="var(--text)">${esc(k)}</text>`;
    });
  });
  return svg(W, H, body);
}

// ── Graph ───────────────────────────────────────────────────────────────────
export function graph(g, frame = {}, selected = null) {
  const visited = frame.visited || [];
  const frontier = frame.frontier || [];
  let body = '';
  const at = new Map(g.nodes.map((n) => [n.id, n]));
  for (const [a, b] of g.edges) {
    const A = at.get(a), B = at.get(b);
    if (A && B) body += line(A.x, A.y, B.x, B.y);
  }
  for (const n of g.nodes) {
    const order = visited.indexOf(n.id);
    const isCur = frame.current === n.id;
    const fill = isCur ? HI : order >= 0 ? 'rgba(143,214,173,.35)' : frontier.includes(n.id) ? 'rgba(157,192,238,.35)' : 'var(--bg3)';
    body += `<g data-node="${esc(n.id)}" style="cursor:pointer"><circle cx="${n.x}" cy="${n.y}" r="19" fill="${fill}" stroke="${selected === n.id ? ACC : 'var(--text3)'}" stroke-width="${selected === n.id ? 3 : 1.5}"/>
      <text x="${n.x}" y="${n.y + 5}" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text)">${esc(n.id)}</text>
      ${order >= 0 ? `<text x="${n.x + 16}" y="${n.y - 16}" font-size="10" fill="${OK}">${order + 1}</text>` : ''}</g>`;
  }
  return svg(420, 320, body);
}

// ── Sorting bars ────────────────────────────────────────────────────────────
export function bars(frame) {
  const a = frame.arr || [];
  const hi = frame.hi || [];
  const sorted = frame.sorted || [];
  const max = Math.max(1, ...a);
  const W = Math.max(320, a.length * 42 + 20);
  const H = 190;
  const body = a.map((v, i) => {
    const h = Math.round((v / max) * 130) + 6;
    const x = 12 + i * 42;
    const fill = hi.includes(i) ? HI : sorted.includes(i) ? OK : 'var(--accent)';
    return `<rect x="${x}" y="${150 - h}" width="34" height="${h}" rx="3" fill="${fill}" opacity="${hi.includes(i) || sorted.includes(i) ? 1 : 0.75}"/>
      <text x="${x + 17}" y="168" text-anchor="middle" font-size="12" fill="var(--text)">${esc(v)}</text>`;
  }).join('');
  return svg(W, H, body);
}

// ── Stack and queue ─────────────────────────────────────────────────────────
export function stackQueue(frame) {
  const s = frame.stack || [], q = frame.queue || [];
  const H = Math.max(200, s.length * 34 + 70);
  let body = `<text x="60" y="18" text-anchor="middle" font-size="11" fill="var(--text3)">STACK</text>
    <text x="270" y="18" text-anchor="middle" font-size="11" fill="var(--text3)">QUEUE</text>`;
  s.forEach((v, i) => {
    const y = H - 20 - (i + 1) * 34;
    const top = i === s.length - 1;
    body += `<rect x="20" y="${y}" width="80" height="30" rx="3" fill="${frame.hiStack === i ? HI : 'var(--bg3)'}" stroke="${top ? ACC : 'var(--border)'}"/>
      <text x="60" y="${y + 19}" text-anchor="middle" font-size="12" fill="${frame.hiStack === i ? '#1B1C1E' : 'var(--text)'}">${esc(v)}</text>
      ${top ? `<text x="108" y="${y + 19}" font-size="10" fill="${ACC}">← top</text>` : ''}`;
  });
  q.forEach((v, i) => {
    const x = 170 + i * 44;
    body += `<rect x="${x}" y="40" width="40" height="30" rx="3" fill="${frame.hiQueue === i ? HI : 'var(--bg3)'}" stroke="var(--border)"/>
      <text x="${x + 20}" y="59" text-anchor="middle" font-size="12" fill="${frame.hiQueue === i ? '#1B1C1E' : 'var(--text)'}">${esc(v)}</text>`;
  });
  if (q.length) {
    body += `<text x="170" y="90" font-size="10" fill="${ACC}">↑ front</text>
      <text x="${170 + (q.length - 1) * 44}" y="104" font-size="10" fill="var(--text3)">↑ back</text>`;
  }
  const W = Math.max(380, 190 + q.length * 44);
  return svg(W, H, body);
}

// ── Linked list ─────────────────────────────────────────────────────────────
export function linkedList(frame) {
  const ns = frame.nodes || [];
  const W = Math.max(360, (ns.length + 1) * 78 + 60);
  let body = `<text x="12" y="30" font-size="11" fill="${ACC}">head</text>`;
  ns.forEach((v, i) => {
    const x = 50 + i * 78;
    const isCur = frame.cur === i;
    const h = (frame.hi || []).includes(i);
    body += `<rect x="${x}" y="40" width="46" height="30" rx="3" fill="${h ? HI : 'var(--bg3)'}" stroke="${isCur ? ACC : 'var(--border)'}" stroke-width="${isCur ? 2.5 : 1}"/>
      <text x="${x + 23}" y="59" text-anchor="middle" font-size="12" fill="${h ? '#1B1C1E' : 'var(--text)'}">${esc(v)}</text>
      ${line(x + 46, 55, x + 74, 55)}<polygon points="${x + 74},51 ${x + 78},55 ${x + 74},59" fill="var(--text3)"/>
      ${isCur ? `<text x="${x + 23}" y="90" text-anchor="middle" font-size="10" fill="${ACC}">cur</text>` : ''}`;
  });
  body += `<text x="${50 + ns.length * 78 + 4}" y="59" font-size="11" fill="var(--text3)">null</text>`;
  if (frame.pending != null) {
    const x = 50 + Math.max(0, frame.pendingAt - 0.5) * 78;
    body += `<rect x="${x}" y="100" width="46" height="30" rx="3" fill="${HI}" stroke="${HI}"/>
      <text x="${x + 23}" y="119" text-anchor="middle" font-size="12" fill="#1B1C1E">${esc(frame.pending)}</text>
      <text x="${x + 23}" y="146" text-anchor="middle" font-size="10" fill="var(--text3)">new node</text>`;
  }
  return svg(W, 160, body);
}

export default { heap, tree, hash, graph, bars, stackQueue, linkedList };
