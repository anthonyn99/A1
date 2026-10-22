// Mind map, from MAGI Studio's renderMindMap: the root, its branches and their
// points laid out with flex, joined by curves drawn after layout. Added for
// Shruti: zoom (buttons, pinch, ctrl/trackpad wheel), pan by dragging, fit,
// collapse and expand a branch (synced per person), full screen, a PNG, and
// the outline copied as text.
//
//   mount(root, map, {book, set, title}) -> dispose()
// Progress: study.<book>.<set>.mindmap = {closedK: [branch key]} (older:
// closed = [branch index in the set]).
// Order: "Arrange" shows the map as an outline, where branches, and the
// points under a branch, are dragged into the person's own order (ui.js
// ordered: order.items.<book>.<set>.mindmap, and ….mmkids.<branch key>).

import { h, btn, esc, IC, keys, progress, saveProgress, ordered, saveOrder, orderPath, OR } from './ui.js';

const SVGNS = 'http://www.w3.org/2000/svg';
export function outline(map) {
  return ['# ' + map.root, ...map.branches.flatMap((b) => ['- ' + b.text, ...b.children.map((c) => '  - ' + c.text)])].join('\n');
}

/** The map in this person's order: {map, bkeys, ckeys:[[...]], orig}. */
export function arranged(book, set, map) {
  const B = ordered(book, set, 'mindmap', map.branches);
  const kids = B.items.map((b, i) => ordered(book, set, 'mindmap', b.children || [], orderPath(book, set, 'mmkids') + '.' + B.keys[i]));
  return { map: { root: map.root, branches: B.items.map((b, i) => Object.assign({}, b, { children: kids[i].items })) }, bkeys: B.keys, ckeys: kids.map((k) => k.keys), orig: B.orig };
}

export function mount(rootEl, setMap, opts) {
  let off = null, arrange = false;
  const show = () => {
    if (off) off();
    const A = arranged(opts.book, opts.set, setMap);
    off = arrange ? mountOutline(rootEl, A, opts, show, () => { arrange = false; show(); }) : mountMap(rootEl, A, opts, () => { arrange = true; show(); });
  };
  show();
  return () => { if (off) off(); };
}

/** The outline: drag branches, and points within a branch, into order. */
function mountOutline(rootEl, A, { book, set }, redraw, done) {
  const wrap = h('div', 'mm mm-arr');
  rootEl.replaceChildren(wrap);
  const bar = h('div', 'st-bar');
  bar.append(h('span', 'st-meta', 'Drag branches and their points into the order you want'));
  const acts = h('div', 'st-actions');
  acts.append(btn('Done', 'tick', done, 'sm solid'));
  bar.append(acts);
  const ol = h('ol', 'mm-ol');
  A.map.branches.forEach((b, bi) => {
    const li = h('li', 'mm-ob b' + (A.orig[bi] % 6), '<div class="mm-ob-h"><span>' + esc(b.text) + '</span>' + (b.children.length ? '<em>' + b.children.length + '</em>' : '') + '</div>');
    li.dataset.dkey = A.bkeys[bi]; li.tabIndex = 0; li.title = OR.HINT;
    if (b.children.length) {
      const kids = h('ol', 'mm-ok');
      b.children.forEach((c, ci) => { const k = h('li', 'mm-oc', esc(c.text)); k.dataset.dkey = A.ckeys[bi][ci]; k.tabIndex = 0; k.title = OR.HINT; kids.append(k); });
      li.append(kids);
      OR.sortable(kids, { row: '.mm-oc', onMove: (ks) => { saveOrder(book, set, 'mindmap', ks, orderPath(book, set, 'mmkids') + '.' + A.bkeys[bi]); redraw(); } });
    }
    ol.append(li);
  });
  wrap.append(bar, ol);
  OR.sortable(ol, { row: '.mm-ob', onMove: (ks) => { saveOrder(book, set, 'mindmap', ks); redraw(); } });
  return () => {};
}

function mountMap(rootEl, A, { book, set, title }, toArrange) {
  const map = A.map, bk = A.bkeys;
  const wrap = h('div', 'mm');
  rootEl.replaceChildren(wrap);
  const p0 = progress(book, set, 'mindmap');
  const closed = new Set(Array.isArray(p0.closedK) ? p0.closedK
    : (p0.closed || []).map(Number).map((oi) => bk[A.orig.indexOf(oi)]).filter(Boolean));
  const view = { z: 1, x: 0, y: 0 };
  let fitted = false;

  const bar = h('div', 'st-bar');
  bar.append(h('span', 'st-meta', esc(map.branches.length + ' branches · ' + map.branches.reduce((s, b) => s + b.children.length, 0) + ' points')));
  const acts = h('div', 'st-actions');
  const zoomBy = (f, cx, cy) => {
    const r = port.getBoundingClientRect();
    cx = cx == null ? r.width / 2 : cx; cy = cy == null ? r.height / 2 : cy;
    const z = Math.max(0.3, Math.min(2.5, view.z * f));
    view.x = cx - (cx - view.x) * (z / view.z); view.y = cy - (cy - view.y) * (z / view.z); view.z = z;
    apply();
  };
  acts.append(btn('', 'minus', () => zoomBy(1 / 1.2), 'sm ic', 'Zoom out (−)'), btn('', 'plus', () => zoomBy(1.2), 'sm ic', 'Zoom in (+)'), btn('', 'fit', () => fit(), 'sm ic', 'Fit to view (0)'),
    btn('', 'full', () => toggleFull(), 'sm ic', 'Full screen (F)'), btn('', 'image', () => png(), 'sm ic', 'Save as a picture (PNG)'),
    btn('', 'copy', async () => { try { await navigator.clipboard.writeText(outline(map)); flash('Outline copied'); } catch (e) { flash('Could not copy'); } }, 'sm ic', 'Copy the outline'), btn('', 'list', toArrange, 'sm ic', 'Arrange: drag branches and points into order'));
  bar.append(acts);
  const port = h('div', 'mm-port');
  const canvas = h('div', 'mm-canvas');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'mm-links'); svg.setAttribute('aria-hidden', 'true');
  // Both sides of the root (Tony, 2026-10-22: "WAY more elegant"): the first
  // half of the branches to the right, the rest to the left, as a mind map is
  // drawn by hand; points under a branch are underlined in its colour.
  const rootNode = h('div', 'mm-node mm-root', '<span>' + esc(map.root) + '</span>');
  const right = h('div', 'mm-side mm-right'), left = h('div', 'mm-side mm-left');
  const half = map.branches.length > 3 ? Math.ceil(map.branches.length / 2) : map.branches.length;
  const nodes = [];   // {el, parent: el, b: branch index, side: 1 | -1, leaf}
  map.branches.forEach((b, bi) => {
    const side = bi < half ? 1 : -1;
    const col = h('div', 'mm-col b' + (A.orig[bi] % 6) + (side < 0 ? ' rev' : ''));
    col.dataset.bi = bi;   // the left side comes first on the page: fold by this, not by place
    const node = h('button', 'mm-node mm-branch', '<span>' + esc(b.text) + '</span>' + (b.children.length ? '<em>' + b.children.length + '</em>' : ''));
    node.type = 'button';
    node.setAttribute('aria-expanded', String(!closed.has(bk[bi])));
    if (b.children.length) node.title = 'Show or hide its points';
    node.addEventListener('click', (e) => { if (moved) return; if (!b.children.length) return; closed.has(bk[bi]) ? closed.delete(bk[bi]) : closed.add(bk[bi]); saveProgress(book, set, 'mindmap', { closedK: [...closed] }); paintClosed(); e.stopPropagation(); });
    col.append(node);
    nodes.push({ el: node, parent: rootNode, b: A.orig[bi], side });
    const kids = h('div', 'mm-kids');
    b.children.forEach((c) => { const k = h('div', 'mm-node mm-leaf', '<span>' + esc(c.text) + '</span>'); kids.append(k); nodes.push({ el: k, parent: node, b: A.orig[bi], side, leaf: true }); });
    if (b.children.length) col.append(kids);
    (side > 0 ? right : left).append(col);
  });
  const branchBox = h('div', 'mm-branches');
  branchBox.append(left, rootNode, right);
  if (!left.children.length) left.remove();
  canvas.append(svg, branchBox);
  port.append(canvas);
  const note = h('div', 'mm-note', '');
  wrap.append(bar, port, note);
  const flash = (t) => { note.textContent = t; note.classList.add('on'); clearTimeout(flash.t); flash.t = setTimeout(() => note.classList.remove('on'), 1600); };

  // Positions inside the canvas, untouched by its transform.
  const at = (el) => { let x = 0, y = 0; for (let e = el; e && e !== canvas; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; } return { x, y, w: el.offsetWidth, hh: el.offsetHeight }; };
  const draw = () => {
    if (!wrap.isConnected) return;
    svg.textContent = '';
    svg.setAttribute('width', canvas.scrollWidth); svg.setAttribute('height', canvas.scrollHeight);
    for (const nd of nodes) {
      if (nd.el.offsetParent === null) continue;   // folded away
      const a = at(nd.parent), b = at(nd.el), main = nd.parent === rootNode;
      // Out of the parent's side, into the child's near edge; a point meets
      // its underline, a branch its middle.
      const x1 = nd.side > 0 ? a.x + a.w : a.x, y1 = a.y + a.hh / 2;
      const x2 = nd.side > 0 ? b.x : b.x + b.w, y2 = nd.leaf ? b.y + b.hh - 1 : b.y + b.hh / 2;
      const mid = x1 + (x2 - x1) * (main ? 0.5 : 0.55);
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` + (nd.leaf ? ` L ${nd.side > 0 ? b.x + b.w : b.x} ${y2}` : ''));
      p.setAttribute('class', 'mm-link b' + (nd.b % 6) + (main ? ' main' : ''));
      svg.append(p);
    }
  };
  const apply = () => { canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`; };
  const fit = () => {
    const r = port.getBoundingClientRect(), w = canvas.scrollWidth, hh = canvas.scrollHeight;
    if (!r.width || !w) return;
    view.z = Math.max(0.3, Math.min(1, (r.width - 24) / w, (r.height - 24) / hh));
    // A phone would shrink a wide map past reading: start readable, the root in view.
    const small = view.z < 0.55 && r.width < 600;
    if (small) {
      view.z = Math.min(0.55, (r.height - 24) / hh);
      const rr = at(rootNode);
      view.x = r.width / 2 - (rr.x + rr.w / 2) * view.z;
    } else view.x = (r.width - w * view.z) / 2;
    view.y = Math.max(12, (r.height - hh * view.z) / 2);
    apply();
  };
  const paintClosed = () => {
    branchBox.querySelectorAll('.mm-col').forEach((col) => { const bi = Number(col.dataset.bi); col.classList.toggle('closed', closed.has(bk[bi])); col.querySelector('.mm-branch').setAttribute('aria-expanded', String(!closed.has(bk[bi]))); });
    requestAnimationFrame(draw);
  };

  // Drag to pan; two fingers to pinch.
  const pts = new Map();
  let moved = false, start = null, pinch = null;
  port.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 1) start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    if (pts.size === 2) { const [p1, p2] = [...pts.values()]; pinch = { d: Math.hypot(p1.x - p2.x, p1.y - p2.y), z: view.z }; }
  });
  port.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && pinch) {
      const [p1, p2] = [...pts.values()], r = port.getBoundingClientRect();
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      zoomBy((pinch.z * d / pinch.d) / view.z, (p1.x + p2.x) / 2 - r.left, (p1.y + p2.y) / 2 - r.top);
      moved = true;
    } else if (start) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      if (!moved) port.setPointerCapture(e.pointerId);
      moved = true; port.classList.add('grab');
      view.x = start.vx + dx; view.y = start.vy + dy; apply();
    }
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) { start = null; port.classList.remove('grab'); setTimeout(() => { moved = false; }, 0); } };
  port.addEventListener('pointerup', up); port.addEventListener('pointercancel', up);
  // The wheel zooms the map (Tony, 2026-10-22), toward the pointer; a
  // trackpad pinch arrives as a ctrl+wheel and does the same.
  port.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = port.getBoundingClientRect();
    zoomBy(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  const toggleFull = () => {
    const on = !wrap.classList.contains('max');
    if (on && wrap.requestFullscreen && !document.fullscreenElement) wrap.requestFullscreen().catch(() => {});
    else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    wrap.classList.toggle('max', on);
    document.body.classList.toggle('mm-maxed', on);
    setTimeout(fit, 60);
  };
  const onFs = () => { if (!document.fullscreenElement && wrap.classList.contains('max')) { wrap.classList.remove('max'); document.body.classList.remove('mm-maxed'); setTimeout(fit, 60); } };
  document.addEventListener('fullscreenchange', onFs);

  /* A PNG of the whole map, drawn from the laid-out nodes. */
  function png() {
    const all = branchBox.querySelectorAll('.mm-col.closed').length;
    const W = canvas.scrollWidth + 48, H = canvas.scrollHeight + 48, S = 2;
    const cv = document.createElement('canvas');
    cv.width = W * S; cv.height = H * S;
    const g = cv.getContext('2d');
    g.scale(S, S);
    const css = getComputedStyle(wrap);
    g.fillStyle = css.getPropertyValue('--bg').trim() || '#1a1a1d'; g.fillRect(0, 0, W, H);
    g.translate(24, 24);
    const box = (el) => { const r = at(el); return r; };
    // Links first.
    for (const p of svg.querySelectorAll('path')) { g.strokeStyle = getComputedStyle(p).stroke; g.lineWidth = parseFloat(getComputedStyle(p).strokeWidth) || 1.6; g.stroke(new Path2D(p.getAttribute('d'))); }
    const nodeEls = [rootNode, ...nodes.map((x) => x.el)].filter((el) => el.offsetParent !== null);
    for (const el of nodeEls) {
      const r = box(el), cs = getComputedStyle(el), rad = parseFloat(cs.borderTopLeftRadius) || 8;
      g.beginPath(); g.roundRect(r.x, r.y, r.w, r.hh, rad);
      g.fillStyle = cs.backgroundColor; g.fill();
      if (parseFloat(cs.borderTopWidth)) { g.strokeStyle = cs.borderTopColor; g.lineWidth = parseFloat(cs.borderTopWidth); g.stroke(); }
      else if (parseFloat(cs.borderBottomWidth)) { g.fillStyle = cs.borderBottomColor; g.fillRect(r.x, r.y + r.hh - parseFloat(cs.borderBottomWidth), r.w, parseFloat(cs.borderBottomWidth)); }
      g.fillStyle = cs.color; g.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily; g.textBaseline = 'top';
      const padL = parseFloat(cs.paddingLeft), padT = parseFloat(cs.paddingTop), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
      const span = el.querySelector('span'), text = (span || el).textContent, maxW = r.w - padL - parseFloat(cs.paddingRight) - (el.querySelector('em') ? 26 : 0);
      let line = '', y = r.y + padT;
      for (const w of text.split(/\s+/)) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { g.fillText(line, r.x + padL, y); line = w; y += lh; } else line = t; }
      if (line) g.fillText(line, r.x + padL, y);
    }
    cv.toBlob((b) => {
      if (!b) { flash('Could not make the picture'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = (title || 'Mind map').replace(/[\\/:*?"<>|]+/g, '') + ' - mind map.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      flash(all ? 'Saved (folded branches stay folded)' : 'Saved');
    }, 'image/png');
  }

  const ro = new ResizeObserver(() => { requestAnimationFrame(() => { draw(); if (!fitted) { fitted = true; fit(); } }); });
  ro.observe(port); ro.observe(canvas);
  paintClosed();
  const offKeys = keys(wrap, (e) => {
    if (e.key === '+' || e.key === '=') zoomBy(1.2);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.2);
    else if (e.key === '0') fit();
    else if (e.key === 'f' || e.key === 'F') toggleFull();
    else if (e.key === 'Escape' && wrap.classList.contains('max')) toggleFull();
    else return;
    e.preventDefault();
  });
  return () => { offKeys(); ro.disconnect(); document.removeEventListener('fullscreenchange', onFs); document.body.classList.remove('mm-maxed'); };
}
