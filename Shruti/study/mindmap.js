// Mind map, from MAGI Studio's renderMindMap: the root, its branches and their
// points laid out with flex, joined by curves drawn after layout. Added for
// Shruti: zoom (buttons, pinch, ctrl/trackpad wheel), pan by dragging, fit,
// collapse and expand a branch (synced per person), full screen, a PNG, and
// the outline copied as text.
//
//   mount(root, map, {book, set, title}) -> dispose()
// Progress: study.<book>.<set>.mindmap = {closed: [branch index]}

import { h, btn, esc, IC, keys, progress, saveProgress } from './ui.js';

const SVGNS = 'http://www.w3.org/2000/svg';
export function outline(map) {
  return ['# ' + map.root, ...map.branches.flatMap((b) => ['- ' + b.text, ...b.children.map((c) => '  - ' + c.text)])].join('\n');
}

export function mount(rootEl, map, { book, set, title }) {
  const wrap = h('div', 'mm');
  rootEl.replaceChildren(wrap);
  const closed = new Set((progress(book, set, 'mindmap').closed || []).map(Number));
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
    btn('', 'copy', async () => { try { await navigator.clipboard.writeText(outline(map)); flash('Outline copied'); } catch (e) { flash('Could not copy'); } }, 'sm ic', 'Copy the outline'));
  bar.append(acts);
  const port = h('div', 'mm-port');
  const canvas = h('div', 'mm-canvas');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'mm-links'); svg.setAttribute('aria-hidden', 'true');
  const rootNode = h('div', 'mm-node mm-root', esc(map.root));
  const branchBox = h('div', 'mm-branches');
  const nodes = [];   // {el, parent: el|null, b: branch index}
  map.branches.forEach((b, bi) => {
    const col = h('div', 'mm-col b' + (bi % 6));
    const node = h('button', 'mm-node mm-branch', '<span>' + esc(b.text) + '</span>' + (b.children.length ? '<em>' + b.children.length + '</em>' : ''));
    node.type = 'button';
    node.setAttribute('aria-expanded', String(!closed.has(bi)));
    if (b.children.length) node.title = 'Show or hide its points';
    node.addEventListener('click', (e) => { if (moved) return; if (!b.children.length) return; closed.has(bi) ? closed.delete(bi) : closed.add(bi); saveProgress(book, set, 'mindmap', { closed: [...closed] }); paintClosed(); e.stopPropagation(); });
    col.append(node);
    nodes.push({ el: node, parent: rootNode, b: bi });
    const kids = h('div', 'mm-kids');
    b.children.forEach((c) => { const k = h('div', 'mm-node mm-leaf', esc(c.text)); kids.append(k); nodes.push({ el: k, parent: node, b: bi }); });
    if (b.children.length) col.append(kids);
    branchBox.append(col);
  });
  canvas.append(svg, rootNode, branchBox);
  port.append(canvas);
  const note = h('div', 'mm-note', '');
  wrap.append(bar, port, note, h('div', 'st-keys', 'Drag to move · pinch or ctrl + scroll to zoom · tap a branch to fold it · + − 0 F'));
  const flash = (t) => { note.textContent = t; note.classList.add('on'); clearTimeout(flash.t); flash.t = setTimeout(() => note.classList.remove('on'), 1600); };

  // Positions inside the canvas, untouched by its transform.
  const at = (el) => { let x = 0, y = 0; for (let e = el; e && e !== canvas; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; } return { x, y, w: el.offsetWidth, hh: el.offsetHeight }; };
  const draw = () => {
    if (!wrap.isConnected) return;
    svg.textContent = '';
    svg.setAttribute('width', canvas.scrollWidth); svg.setAttribute('height', canvas.scrollHeight);
    for (const nd of nodes) {
      if (nd.el.offsetParent === null) continue;   // folded away
      const a = at(nd.parent), b = at(nd.el);
      const x1 = a.x + a.w, y1 = a.y + a.hh / 2, x2 = b.x, y2 = b.y + b.hh / 2, mid = (x1 + x2) / 2;
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
      p.setAttribute('class', 'mm-link b' + (nd.b % 6) + (nd.parent === rootNode ? ' main' : ''));
      svg.append(p);
    }
  };
  const apply = () => { canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`; };
  const fit = () => {
    const r = port.getBoundingClientRect(), w = canvas.scrollWidth, hh = canvas.scrollHeight;
    if (!r.width || !w) return;
    view.z = Math.max(0.3, Math.min(1, (r.width - 24) / w, (r.height - 24) / hh));
    // A phone would shrink a wide map past reading: start readable, root at the left.
    const small = view.z < 0.62 && r.width < 600;
    if (small) view.z = Math.min(0.62, (r.height - 24) / hh);
    view.x = small ? 4 : (r.width - w * view.z) / 2; view.y = Math.max(12, (r.height - hh * view.z) / 2);
    apply();
  };
  const paintClosed = () => {
    branchBox.querySelectorAll('.mm-col').forEach((col, bi) => { col.classList.toggle('closed', closed.has(bi)); col.querySelector('.mm-branch').setAttribute('aria-expanded', String(!closed.has(bi))); });
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
  port.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey && !wrap.classList.contains('max')) return;
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
