/* ============================================================================
 * StudyOS — diagram renderer  (v2 lessons: diagrams are DATA, drawn here)
 * ============================================================================
 * renderDiagram(d, opts) -> an HTML string: a <figure> holding an inline SVG
 * (a table is an HTML <table>) and its caption. Every text from the model is
 * escaped for text AND attributes (& < > " '); every coordinate is a number
 * computed here. Colours are CSS classes (study-style.js: .dg-*) on the
 * app's tokens, so the drawing follows the theme and the class accent.
 *
 * Bad data never throws: the caption and "diagram unavailable" instead.
 * ------------------------------------------------------------------------- */

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => (Math.round(v * 10) / 10).toString();
let _uid = 0;

/** Lines of at most ~`max` characters, at most `rows` of them. */
export function wrap(text, max = 18, rows = 3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    if (!line) line = w;
    else if ((line + ' ' + w).length <= max) line += ' ' + w;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  if (out.length > rows) { out.length = rows; out[rows - 1] = out[rows - 1].replace(/.{0,1}$/, '…'); }
  return out.map((l) => (l.length > max + 6 ? l.slice(0, max + 5) + '…' : l));
}

/** The diagram as frame `i` shows it: patches up to i applied, that frame's
 *  highlight and labels (on top of the base labels). i < 0: the base. */
export function atFrame(d, i = -1) {
  if (!d || i < 0 || !(d.frames || []).length) return d;
  const out = { ...d };
  const frames = d.frames.slice(0, i + 1);
  for (const f of frames) if (f.patch) Object.assign(out, f.patch);
  const f = frames[frames.length - 1] || {};
  out.highlight = f.highlight || [];
  const fl = f.labels || [];
  out.labels = [...(d.labels || []).filter((l) => !fl.some((x) => x.target === l.target)), ...fl];
  return out;
}

const textEl = (x, y, s, cls = '', anchor = 'middle', size = 0) =>
  `<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ''}${size ? ` font-size="${size}"` : ''}>${esc(s)}</text>`;
const multiText = (x, y, lines, cls, lh = 15, anchor = 'middle') =>
  lines.map((l, k) => textEl(x, y + k * lh - ((lines.length - 1) * lh) / 2, l, cls, anchor)).join('');

function svg(w, h, body, label) {
  const id = 'dga' + (++_uid);
  const defs = `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0 0 L10 5 L0 10 z" class="dg-head"/></marker></defs>`;
  return `<svg class="dg-svg" viewBox="0 0 ${n(w)} ${n(h)}" width="100%" style="max-width:${n(Math.max(w, 160) * 1.25)}px" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">` +
    defs + body.replace(/__ARROW__/g, `url(#${id})`) + '</svg>';
}
const state = (d, id) => {
  const c = [];
  if ((d.highlight || []).includes(id)) c.push('dg-hl');
  if ((d.dim || []).includes(id)) c.push('dg-dim');
  return c.join(' ');
};
const labelOf = (d, id) => (d.labels || []).filter((l) => l.target === id).map((l) => l.text).join(', ');

// ── tree ─────────────────────────────────────────────────────────────────
function tree(d) {
  const kids = new Map();
  for (const e of d.edges || []) kids.set(e.from + ':' + e.side, e.to);
  const val = new Map((d.nodes || []).map((x) => [x.id, x.value]));
  const pos = new Map();
  let col = 0, depthMax = 0;
  // In-order columns: every node its own column, so a BST reads left to right in order.
  const visit = (id, depth, guard) => {
    if (!id || guard.has(id)) return;
    guard.add(id);
    depthMax = Math.max(depthMax, depth);
    visit(kids.get(id + ':left'), depth + 1, guard);
    pos.set(id, { x: col++, y: depth });
    visit(kids.get(id + ':right'), depth + 1, guard);
  };
  visit(d.root, 0, new Set());
  if (!pos.size) throw new Error('empty tree');
  const CW = 48, RH = 66, R = 18, PX = 30, PY = 34;
  const nulls = d.showNulls ? 22 : 0;
  const W = col * CW + PX * 2, H = (depthMax + 1) * RH + PY + nulls;
  const X = (id) => PX + pos.get(id).x * CW + CW / 2, Y = (id) => PY + pos.get(id).y * RH + R;
  const parts = [];
  for (const e of d.edges || []) {
    if (!pos.has(e.from) || !pos.has(e.to)) continue;
    const cls = ['dg-edge', (d.highlight || []).includes(e.to) && (d.highlight || []).includes(e.from) ? 'dg-hl' : '', (d.dim || []).includes(e.to) ? 'dg-dim' : ''].filter(Boolean).join(' ');
    parts.push(`<line x1="${n(X(e.from))}" y1="${n(Y(e.from))}" x2="${n(X(e.to))}" y2="${n(Y(e.to))}" class="${cls}"/>`);
  }
  if (d.showNulls) {
    for (const id of pos.keys()) for (const side of ['left', 'right']) {
      if (kids.get(id + ':' + side)) continue;
      const dx = side === 'left' ? -14 : 14;
      const x2 = X(id) + dx, y2 = Y(id) + R + 16;
      parts.push(`<line x1="${n(X(id) + dx * 0.6)}" y1="${n(Y(id) + R * 0.8)}" x2="${n(x2)}" y2="${n(y2)}" class="dg-edge dg-null${(d.dim || []).includes(id) ? ' dg-dim' : ''}"/>`,
        textEl(x2, y2 + 11, '∅', 'dg-nulltxt'));
    }
  }
  for (const id of pos.keys()) {
    const cls = state(d, id);
    parts.push(`<g class="dg-node ${cls}" data-dg="${esc(id)}"><circle cx="${n(X(id))}" cy="${n(Y(id))}" r="${R}"/>` +
      textEl(X(id), Y(id) + 4.5, String(val.get(id)).slice(0, 5), 'dg-val') + '</g>');
    const lab = labelOf(d, id);
    if (lab) parts.push(textEl(X(id), Y(id) - R - 6, lab, 'dg-label' + ((d.dim || []).includes(id) ? ' dg-dim' : '')));
  }
  return svg(W, H, parts.join(''), d.caption || 'tree');
}

// ── linked list ──────────────────────────────────────────────────────────
function linkedlist(d) {
  const nodes = d.nodes || [];
  if (!nodes.length) throw new Error('empty list');
  const next = new Map(), hasIn = new Set();
  for (const l of d.links || []) if (l.dir !== 'prev') { next.set(l.from, l.to); if (l.to) hasIn.add(l.to); }
  const val = new Map(nodes.map((x) => [x.id, x.value]));
  const head = ((d.pointers || []).find((p) => /head|first|root|front/i.test(p.name) && p.target) || {}).target
    || (nodes.find((x) => !hasIn.has(x.id)) || nodes[0]).id;
  const order = [];
  const seen = new Set();
  for (let cur = head; cur && !seen.has(cur) && val.has(cur); cur = next.get(cur)) { seen.add(cur); order.push(cur); }
  for (const x of nodes) if (!seen.has(x.id)) { seen.add(x.id); order.push(x.id); }
  const BW = 76, BH = 38, GAP = 36, PX = 18, PTR = (d.pointers || []).length ? 34 : 10;
  const ptrH = d.circular || d.doubly ? 34 : 0;
  const tail = order[order.length - 1];
  const showNull = !d.circular && next.has(tail) && next.get(tail) === null;
  const W = PX * 2 + order.length * BW + (order.length - 1) * GAP + (showNull ? 44 : 0), H = PTR + BH + 26 + ptrH;
  const x0 = (i) => PX + i * (BW + GAP);
  const y0 = PTR;
  const parts = [];
  order.forEach((id, i) => {
    const cls = state(d, id);
    const split = d.doubly ? [18, BW - 18] : [null, BW - 22];
    parts.push(`<g class="dg-node dg-box ${cls}" data-dg="${esc(id)}"><rect x="${n(x0(i))}" y="${n(y0)}" width="${BW}" height="${BH}" rx="5"/>` +
      (split[0] ? `<line x1="${n(x0(i) + split[0])}" y1="${n(y0)}" x2="${n(x0(i) + split[0])}" y2="${n(y0 + BH)}" class="dg-sep"/>` : '') +
      `<line x1="${n(x0(i) + split[1])}" y1="${n(y0)}" x2="${n(x0(i) + split[1])}" y2="${n(y0 + BH)}" class="dg-sep"/>` +
      textEl(x0(i) + ((split[0] || 0) + split[1]) / 2, y0 + BH / 2 + 4.5, String(val.get(id)).slice(0, 8), 'dg-val') + '</g>');
    const nx = next.get(id);
    const j = order.indexOf(nx);
    if (nx && j === i + 1) {
      parts.push(`<line x1="${n(x0(i) + BW - 11)}" y1="${n(y0 + BH / 2 - (d.doubly ? 6 : 0))}" x2="${n(x0(j) - 2)}" y2="${n(y0 + BH / 2 - (d.doubly ? 6 : 0))}" class="dg-edge" marker-end="__ARROW__"/>`);
    }
    if (d.doubly && i > 0) {
      parts.push(`<line x1="${n(x0(i) + 9)}" y1="${n(y0 + BH / 2 + 6)}" x2="${n(x0(i - 1) + BW + 2)}" y2="${n(y0 + BH / 2 + 6)}" class="dg-edge" marker-end="__ARROW__"/>`);
    }
    const lab = labelOf(d, id);
    if (lab) parts.push(textEl(x0(i) + BW / 2, y0 + BH + 16, lab, 'dg-label'));
  });
  if (showNull) {
    const i = order.length - 1;
    parts.push(`<line x1="${n(x0(i) + BW - 11)}" y1="${n(y0 + BH / 2)}" x2="${n(x0(i) + BW + 22)}" y2="${n(y0 + BH / 2)}" class="dg-edge dg-null"/>`,
      textEl(x0(i) + BW + 32, y0 + BH / 2 + 5, '∅', 'dg-nulltxt'));
  }
  if (d.circular && order.length > 1) {
    const a = x0(order.length - 1) + BW - 11, b = x0(0) + BW / 2, y = y0 + BH;
    parts.push(`<path d="M${n(a)} ${n(y)} C ${n(a)} ${n(y + 34)}, ${n(b)} ${n(y + 34)}, ${n(b)} ${n(y + 4)}" class="dg-edge" fill="none" marker-end="__ARROW__"/>`);
  }
  (d.pointers || []).forEach((p, k) => {
    const i = p.target ? order.indexOf(p.target) : -1;
    if (i < 0) return;
    const cx = x0(i) + BW / 2 + (k % 2 ? 10 : -10) * ((d.pointers || []).filter((q) => q.target === p.target).length > 1 ? 1 : 0);
    parts.push(textEl(cx, 12, p.name, 'dg-ptr'),
      `<line x1="${n(cx)}" y1="${n(16)}" x2="${n(cx)}" y2="${n(y0 - 3)}" class="dg-edge dg-ptrline" marker-end="__ARROW__"/>`);
  });
  return svg(W, H, parts.join(''), d.caption || 'linked list');
}

// ── array ────────────────────────────────────────────────────────────────
function array(d) {
  const count = Math.max((d.cells || []).length, d.capacity || 0);
  if (!count) throw new Error('empty array');
  const CW = 46, CH = 40, PX = 16, PTR = (d.pointers || []).length ? 34 : 8;
  const W = PX * 2 + count * CW, H = PTR + CH + (d.indices !== false ? 22 : 6) + 4;
  const parts = [];
  for (let i = 0; i < count; i++) {
    const v = (d.cells || [])[i];
    const empty = v == null;
    const id = 'c' + i;
    const x = PX + i * CW;
    parts.push(`<g class="dg-node dg-box ${state(d, id)}${empty ? ' dg-empty' : ''}" data-dg="${id}"><rect x="${n(x)}" y="${n(PTR)}" width="${CW}" height="${CH}"/>` +
      (empty ? '' : textEl(x + CW / 2, PTR + CH / 2 + 4.5, String(v).slice(0, 6), 'dg-val')) + '</g>');
    if (d.indices !== false) parts.push(textEl(x + CW / 2, PTR + CH + 15, String(i), 'dg-idx'));
    const lab = labelOf(d, id);
    if (lab && !(d.pointers || []).length) parts.push(textEl(x + CW / 2, PTR - 6, lab, 'dg-label'));
  }
  for (const p of d.pointers || []) {
    const cx = PX + p.index * CW + CW / 2;
    parts.push(textEl(cx, 12, p.name, 'dg-ptr'), `<line x1="${n(cx)}" y1="16" x2="${n(cx)}" y2="${n(PTR - 3)}" class="dg-edge dg-ptrline" marker-end="__ARROW__"/>`);
  }
  return svg(W, H, parts.join(''), d.caption || 'array');
}

// ── one object's memory ──────────────────────────────────────────────────
const isNullish = (v) => /^(null|∅|none|nil)$/i.test(String(v || '').trim());
function nodebox(d) {
  const fields = d.fields || [];
  if (!fields.length) throw new Error('no fields');
  const NW = 92, VW = 74, RH = 34, PX = 14, HD = 30;
  const targets = fields.some((f) => f.pointsTo || isNullish(f.value));
  const W = PX * 2 + NW + VW + (targets ? 96 : 0), H = HD + fields.length * RH + 16;
  const x = PX, y = 8;
  const parts = [`<rect x="${x}" y="${y}" width="${NW + VW}" height="${HD + fields.length * RH}" rx="6" class="dg-frame"/>`,
    textEl(x + (NW + VW) / 2, y + 20, d.className || 'Node', 'dg-class')];
  fields.forEach((f, i) => {
    const ry = y + HD + i * RH;
    const cls = state(d, f.name);
    parts.push(`<g class="dg-node dg-field ${cls}" data-dg="${esc(f.name)}"><rect x="${x}" y="${n(ry)}" width="${NW + VW}" height="${RH}"/>` +
      `<line x1="${x + NW}" y1="${n(ry)}" x2="${x + NW}" y2="${n(ry + RH)}" class="dg-sep"/>` +
      textEl(x + 10, ry + RH / 2 + 4.5, f.name, 'dg-fname', 'start') +
      textEl(x + NW + VW / 2, ry + RH / 2 + 4.5, isNullish(f.value) ? '∅' : String(f.value).slice(0, 9), 'dg-val') + '</g>');
    const to = f.pointsTo || (isNullish(f.value) ? null : undefined);
    if (to !== undefined) {
      const ax = x + NW + VW - 6, tx = x + NW + VW + 46;
      parts.push(`<line x1="${n(ax)}" y1="${n(ry + RH / 2)}" x2="${n(tx - 14)}" y2="${n(ry + RH / 2)}" class="dg-edge${to ? '' : ' dg-null'}" marker-end="${to ? '__ARROW__' : ''}"/>`);
      parts.push(to ? `<g class="dg-node dg-target ${cls}"><rect x="${n(tx - 12)}" y="${n(ry + 5)}" width="58" height="${RH - 10}" rx="12"/>${textEl(tx + 17, ry + RH / 2 + 4.5, String(to).slice(0, 7), 'dg-val')}</g>`
        : textEl(tx - 4, ry + RH / 2 + 5, '∅', 'dg-nulltxt'));
    }
  });
  return svg(W, H, parts.join(''), d.caption || d.className || 'object');
}

// ── stack / queue ────────────────────────────────────────────────────────
function stackqueue(d) {
  const items = d.items || [];
  const parts = [];
  if (d.kind === 'stack') {
    const BW = 120, BH = 32, PX = 60, PY = 12;
    const H = PY * 2 + Math.max(1, items.length) * BH + 6, W = PX + BW + 60;
    parts.push(`<path d="M${PX - 6} ${PY} L${PX - 6} ${n(H - PY + 2)} L${PX + BW + 6} ${n(H - PY + 2)} L${PX + BW + 6} ${PY}" class="dg-edge" fill="none"/>`);
    items.forEach((v, i) => {
      const y = H - PY - (i + 1) * BH;
      parts.push(`<g class="dg-node dg-box ${state(d, 'i' + i)}" data-dg="i${i}"><rect x="${PX}" y="${n(y)}" width="${BW}" height="${BH - 4}" rx="4"/>${textEl(PX + BW / 2, y + BH / 2 + 2.5, String(v).slice(0, 14), 'dg-val')}</g>`);
      const lab = labelOf(d, 'i' + i) || (i === items.length - 1 ? 'top' : '');
      if (lab) parts.push(textEl(PX + BW + 12, y + BH / 2 + 2.5, lab, 'dg-label', 'start'));
    });
    if (!items.length) parts.push(textEl(PX + BW / 2, H / 2 + 4, 'empty', 'dg-idx'));
    return svg(W, H, parts.join(''), d.caption || 'stack');
  }
  const BW = 60, BH = 38, PX = 16, PY = 24;
  const W = PX * 2 + Math.max(1, items.length) * (BW + 6), H = PY + BH + 26;
  items.forEach((v, i) => {
    const x = PX + i * (BW + 6);
    parts.push(`<g class="dg-node dg-box ${state(d, 'i' + i)}" data-dg="i${i}"><rect x="${n(x)}" y="${PY}" width="${BW}" height="${BH}" rx="4"/>${textEl(x + BW / 2, PY + BH / 2 + 4.5, String(v).slice(0, 7), 'dg-val')}</g>`);
    const lab = labelOf(d, 'i' + i) || (i === 0 ? 'head' : i === items.length - 1 ? 'tail' : '');
    if (lab) parts.push(textEl(x + BW / 2, PY - 8, lab, 'dg-label'));
  });
  if (!items.length) parts.push(textEl(W / 2, PY + BH / 2 + 4, 'empty', 'dg-idx'));
  else parts.push(textEl(PX, PY + BH + 18, '← dequeue', 'dg-idx', 'start'), textEl(W - PX, PY + BH + 18, 'enqueue ←', 'dg-idx', 'end'));
  return svg(W, H, parts.join(''), d.caption || 'queue');
}

// ── table (HTML: text wraps) ─────────────────────────────────────────────
function table(d) {
  if (!(d.headers || []).length && !(d.rows || []).length) throw new Error('empty table');
  const head = (d.headers || []).length ? `<thead><tr>${d.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : '';
  const rows = (d.rows || []).map((r, i) => `<tr class="${state(d, 'r' + i)}" data-dg="r${i}">${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="dg-tablewrap"><table class="dg-table">${head}<tbody>${rows}</tbody></table></div>`;
}

// ── flow ─────────────────────────────────────────────────────────────────
function flow(d) {
  const boxes = d.boxes || [];
  if (!boxes.length) throw new Error('no boxes');
  const ids = boxes.map((b) => b.id);
  const rank = new Map(ids.map((id) => [id, 0]));
  // Longest path from a source; capped passes, so a cycle cannot loop.
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const a of d.arrows || []) {
      if (a.from === a.to) continue;
      const r = rank.get(a.from) + 1;
      if (r > rank.get(a.to) && r < ids.length) { rank.set(a.to, r); moved = true; }
    }
    if (!moved) break;
  }
  const LR = d.direction === 'LR';
  const byRank = new Map();
  for (const id of ids) { const r = rank.get(id); (byRank.get(r) || byRank.set(r, []).get(r)).push(id); }
  const BW = 140, LH = 15;
  const lines = new Map(boxes.map((b) => [b.id, wrap(b.text, 19, 3)]));
  const BH = (id) => Math.max(40, lines.get(id).length * LH + 18) + (boxes.find((b) => b.id === id).shape === 'diamond' ? 18 : 0);
  const GX = LR ? 70 : 26, GY = LR ? 22 : 46, P = 16;
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const maxPer = Math.max(...ranks.map((r) => byRank.get(r).length));
  const rowH = Math.max(...ids.map(BH));
  const pos = new Map();
  ranks.forEach((r, ri) => {
    const list = byRank.get(r);
    list.forEach((id, k) => {
      const off = (maxPer - list.length) / 2 + k;
      pos.set(id, LR ? { x: P + ri * (BW + GX), y: P + off * (rowH + GY) } : { x: P + off * (BW + GX), y: P + ri * (rowH + GY) });
    });
  });
  const W = LR ? P * 2 + ranks.length * BW + (ranks.length - 1) * GX : P * 2 + maxPer * BW + (maxPer - 1) * GX;
  const H = LR ? P * 2 + maxPer * rowH + (maxPer - 1) * GY : P * 2 + ranks.length * rowH + (ranks.length - 1) * GY;
  const center = (id) => { const p = pos.get(id); return { x: p.x + BW / 2, y: p.y + rowH / 2 }; };
  // Where the line from a box's centre toward (tx,ty) leaves the box.
  const edgePoint = (id, tx, ty) => {
    const c = center(id), hw = BW / 2 + 2, hh = BH(id) / 2 + 2;
    const dx = tx - c.x, dy = ty - c.y;
    if (!dx && !dy) return c;
    const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return { x: c.x + dx * t, y: c.y + dy * t };
  };
  const parts = [];
  for (const a of d.arrows || []) {
    if (!pos.has(a.from) || !pos.has(a.to) || a.from === a.to) continue;
    const ca = center(a.from), cb = center(a.to);
    const p1 = edgePoint(a.from, cb.x, cb.y), p2 = edgePoint(a.to, ca.x, ca.y);
    const hl = (d.highlight || []).includes(a.from) && (d.highlight || []).includes(a.to);
    parts.push(`<line x1="${n(p1.x)}" y1="${n(p1.y)}" x2="${n(p2.x)}" y2="${n(p2.y)}" class="dg-edge${hl ? ' dg-hl' : ''}" marker-end="__ARROW__"/>`);
    if (a.label) {
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      parts.push(`<rect x="${n(mx - a.label.length * 3.4 - 4)}" y="${n(my - 9)}" width="${n(a.label.length * 6.8 + 8)}" height="16" rx="3" class="dg-elabelbg"/>`,
        textEl(mx, my + 3.5, a.label, 'dg-elabel'));
    }
  }
  for (const b of boxes) {
    const c = center(b.id), h = BH(b.id);
    const shape = b.shape === 'diamond'
      ? `<polygon points="${n(c.x)},${n(c.y - h / 2)} ${n(c.x + BW / 2)},${n(c.y)} ${n(c.x)},${n(c.y + h / 2)} ${n(c.x - BW / 2)},${n(c.y)}"/>`
      : `<rect x="${n(c.x - BW / 2)}" y="${n(c.y - h / 2)}" width="${BW}" height="${n(h)}" rx="${b.shape === 'pill' ? n(h / 2) : 6}"/>`;
    parts.push(`<g class="dg-node dg-box ${state(d, b.id)}" data-dg="${esc(b.id)}">${shape}${multiText(c.x, c.y + 4.5, lines.get(b.id), 'dg-ftext', LH)}</g>`);
    const lab = labelOf(d, b.id);
    if (lab) parts.push(textEl(c.x, c.y - h / 2 - 5, lab, 'dg-label'));
  }
  return svg(W, H + 6, parts.join(''), d.caption || 'flow');
}

// ── timeline (vertical: legible at phone width) ─────────────────────────
function timeline(d) {
  const ev = d.events || [];
  if (!ev.length) throw new Error('no events');
  const RH = 46, X = 92, P = 18, W = 360;
  const rows = ev.map((e) => wrap(e.label, 34, 2));
  const H = P * 2 + ev.length * RH;
  const parts = [`<line x1="${X}" y1="${P}" x2="${X}" y2="${n(H - P)}" class="dg-edge"/>`];
  ev.forEach((e, i) => {
    const y = P + i * RH + RH / 2;
    parts.push(`<g class="dg-node ${state(d, e.id)}" data-dg="${esc(e.id)}"><circle cx="${X}" cy="${n(y)}" r="6"/></g>`,
      textEl(X - 14, y + 4.5, e.date, 'dg-date', 'end'), multiText(X + 16, y + 4.5, rows[i], 'dg-ftext', 15, 'start'));
    const lab = labelOf(d, e.id);
    if (lab) parts.push(textEl(X + 16, y - 14, lab, 'dg-label', 'start'));
  });
  return svg(W, H, parts.join(''), d.caption || 'timeline');
}

const DRAW = { tree, linkedlist, array, nodebox, stack: stackqueue, queue: stackqueue, table, flow, timeline };

/** The drawing alone (SVG or table HTML). Throws on unusable data. */
export function drawDiagram(d, frame = -1) {
  const f = atFrame(d, frame);
  const draw = f && DRAW[f.kind];
  if (!draw) throw new Error('unknown diagram kind');
  return draw(f);
}

/**
 * The diagram as a figure: drawing + caption. opts.frame: the walkthrough
 * frame to show; opts.extraHighlight: ids lit by a selected code line.
 */
export function renderDiagram(d, { frame = -1, extraHighlight = [], className = '' } = {}) {
  if (!d) return '';
  const cap = d.caption ? `<figcaption class="dg-cap">${esc(d.caption)}</figcaption>` : '';
  try {
    const src = extraHighlight.length ? { ...d, highlight: [...(d.highlight || []), ...extraHighlight] } : d;
    const withFrame = extraHighlight.length && frame >= 0 ? { ...atFrame(d, frame), frames: undefined, highlight: [...(atFrame(d, frame).highlight || []), ...extraHighlight] } : null;
    const body = withFrame ? DRAW[withFrame.kind](withFrame) : drawDiagram(src, frame);
    return `<figure class="dg ${esc(className)}" data-diagram="${esc(d.id || '')}">${body}${cap}</figure>`;
  } catch (e) {
    return `<figure class="dg dg-bad ${esc(className)}">${cap}<div class="dg-unavail">diagram unavailable</div></figure>`;
  }
}

export default { renderDiagram, drawDiagram, atFrame, wrap };
