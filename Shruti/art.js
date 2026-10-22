// The artwork in Shruti's videos (Tony, 2026-10-22: "graphics and animations
// of what's going on, not just a bunch of slide decks"). Each motif is drawn
// live on the video's canvas in fine strokes of the scene's colour, and moves
// gently: a chariot wheel turns, banners wave, a conch's sound spreads, a
// lotus opens, a flame flickers, waves roll. A frame is a pure function of
// the time, so pausing, scrubbing and export land on exactly what played.
//
//   draw(ctx, names, box, t, pal)   box {x, y, w, h}; names from formats.js ART
//   pick(scene)                     the motifs a scene shows: its own `art`,
//                                   else chosen from its words (the shipped
//                                   scripts carry none)
//
// Motif functions take (c, s, t, k): the origin is the motif's centre, s is
// its size (it stays within ±s/2), t seconds into the scene, k the palette.

const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
const wob = (t, f, ph = 0) => Math.sin(t * f + ph);
function line(c, pts) { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke(); }
function circle(c, x, y, r, fill) { c.beginPath(); c.arc(x, y, r, 0, TAU); fill ? c.fill() : c.stroke(); }
const alpha = (hex, a) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; };

/** A person, drawn as a soft silhouette with a line: standing, seated, slumped. */
function figure(c, s, t, k, { pose = 'stand', col = k.ac, crown = false, feather = false, flute = false, bow = false, spear = false, sway = 0 } = {}) {
  c.save();
  const u = s / 10, b = wob(t, 1.1) * sway;
  c.rotate(b * 0.02);
  c.fillStyle = alpha(col, 0.16); c.strokeStyle = col;
  if (pose === 'seated') {
    // Cross-legged: a wide base, upright back, hands on the knees.
    c.beginPath(); c.ellipse(0, 3.2 * u, 3.4 * u, 1 * u, 0, 0, TAU); c.fill(); c.stroke();
    c.beginPath(); c.moveTo(-1.3 * u, 2.6 * u); c.quadraticCurveTo(-1.6 * u, -0.6 * u, 0, -1.4 * u); c.quadraticCurveTo(1.6 * u, -0.6 * u, 1.3 * u, 2.6 * u); c.closePath(); c.fill(); c.stroke();
    line(c, [[-1.2 * u, 0], [-2.4 * u, 2.4 * u]]); line(c, [[1.2 * u, 0], [2.4 * u, 2.4 * u]]);
    circle(c, 0, -2.5 * u, 1 * u); c.fill();
  } else if (pose === 'slumped') {
    // Arjuna in despair: sitting, head bowed, the bow laid down.
    c.beginPath(); c.moveTo(-2.2 * u, 3.4 * u); c.quadraticCurveTo(-2.4 * u, 0.2 * u, -0.4 * u, -0.4 * u); c.quadraticCurveTo(1.6 * u, 0.4 * u, 1.8 * u, 3.4 * u); c.closePath(); c.fill(); c.stroke();
    circle(c, 0.6 * u, -1.2 * u, 0.95 * u); c.fill();
    line(c, [[-0.6 * u, 0.6 * u], [0.9 * u, 2.2 * u]]);
    c.strokeStyle = k.gold; c.beginPath(); c.arc(-1 * u, 4.2 * u, 3.6 * u, Math.PI * 1.08, Math.PI * 1.92); c.stroke();
    line(c, [[-4.3 * u, 3.4 * u], [2.3 * u, 3.4 * u]]);
  } else {
    // Standing, in a long robe.
    c.beginPath(); c.moveTo(-0.9 * u, -1.6 * u); c.quadraticCurveTo(-1.6 * u, 2 * u, -2 * u, 4.8 * u); c.lineTo(2 * u, 4.8 * u); c.quadraticCurveTo(1.6 * u, 2 * u, 0.9 * u, -1.6 * u); c.closePath(); c.fill(); c.stroke();
    circle(c, 0, -2.6 * u, 1 * u); c.fill();
    if (flute) { c.strokeStyle = k.gold; line(c, [[-0.4 * u, -1.5 * u], [2.6 * u, -1.9 * u]]); c.strokeStyle = col; line(c, [[-0.8 * u, -0.8 * u], [0.6 * u, -1.6 * u]]); line(c, [[0.8 * u, -0.8 * u], [1.8 * u, -1.8 * u]]); }
    else { line(c, [[-0.9 * u, -1 * u], [-1.6 * u, 1.6 * u]]); line(c, [[0.9 * u, -1 * u], [1.6 * u, 1.6 * u]]); }
    if (bow) { c.strokeStyle = k.gold; c.beginPath(); c.arc(2.6 * u, 0.2 * u, 2.6 * u, -Math.PI * 0.42, Math.PI * 0.42); c.stroke(); line(c, [[3.2 * u, -2.3 * u], [3.2 * u, 2.7 * u]]); }
    if (spear) { c.strokeStyle = k.txm; line(c, [[2 * u, 4.8 * u], [2 * u, -5 * u]]); c.beginPath(); c.moveTo(2 * u, -5.8 * u); c.lineTo(1.6 * u, -4.8 * u); c.lineTo(2.4 * u, -4.8 * u); c.closePath(); c.fill(); }
  }
  const hy = pose === 'seated' ? -2.5 * u : pose === 'slumped' ? -1.2 * u : -2.6 * u, hx = pose === 'slumped' ? 0.6 * u : 0;
  if (crown) { c.strokeStyle = k.gold; line(c, [[hx - 0.8 * u, hy - 0.9 * u], [hx - 0.5 * u, hy - 1.7 * u], [hx, hy - 1.1 * u], [hx + 0.5 * u, hy - 1.7 * u], [hx + 0.8 * u, hy - 0.9 * u]]); }
  if (feather) { c.save(); c.translate(hx + 0.4 * u, hy - 1 * u); c.rotate(0.35 + wob(t, 1.6) * 0.06); c.strokeStyle = k.alt; c.beginPath(); c.ellipse(0, -1 * u, 0.45 * u, 1 * u, 0, 0, TAU); c.stroke(); c.fillStyle = k.gold; circle(c, 0, -1.1 * u, 0.22 * u, true); c.restore(); }
  c.restore();
}

/* ── the motifs ──────────────────────────────────────────────────────────── */
const M = {
  battlefield(c, s, t, k) {
    const w = s * 0.5;
    c.strokeStyle = alpha(k.tx, 0.35); line(c, [[-w, s * 0.28], [w, s * 0.28]]);
    // Two armies: rows of spears and banners that wave, facing each other.
    for (const side of [-1, 1]) for (let row = 0; row < 3; row++) for (let i = 0; i < 7; i++) {
      const x = side * (w * 0.18 + i * w * 0.11 + row * w * 0.05), y = s * (0.27 - row * 0.07), hgt = s * (0.13 - row * 0.02);
      c.strokeStyle = alpha(side < 0 ? k.rose : k.ac, 0.5 + 0.15 * row); line(c, [[x, y], [x, y - hgt]]);
      if (i % 2 === 0) { const f = wob(t, 3, i + row) * 0.25; c.fillStyle = alpha(side < 0 ? k.rose : k.ac, 0.55); c.beginPath(); c.moveTo(x, y - hgt); c.quadraticCurveTo(x - side * hgt * 0.25, y - hgt * (0.85 + f * 0.1), x - side * hgt * 0.45, y - hgt * 0.75); c.lineTo(x, y - hgt * 0.62); c.fill(); }
    }
    // Dust drifting up between them.
    c.fillStyle = alpha(k.gold, 0.5);
    for (let i = 0; i < 18; i++) { const p = ((t * 0.12 + i * 0.137) % 1); circle(c, (Math.sin(i * 12.9) * 0.16) * s, s * (0.26 - p * 0.42), 2 + (i % 3), true); }
  },
  chariot(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.gold;
    // The wheel turns.
    c.save(); c.translate(0.6 * u, 2.2 * u); c.rotate(t * 0.9);
    circle(c, 0, 0, 1.9 * u); circle(c, 0, 0, 0.3 * u);
    for (let i = 0; i < 8; i++) { const a = i * TAU / 8; line(c, [[0, 0], [Math.cos(a) * 1.9 * u, Math.sin(a) * 1.9 * u]]); }
    c.restore();
    // The car and its banner.
    c.strokeStyle = k.ac; c.fillStyle = alpha(k.ac, 0.14);
    c.beginPath(); c.moveTo(-1.8 * u, 1.6 * u); c.lineTo(3.4 * u, 1.6 * u); c.lineTo(3 * u, -0.6 * u); c.lineTo(-1.2 * u, -0.6 * u); c.closePath(); c.fill(); c.stroke();
    line(c, [[2.6 * u, -0.6 * u], [2.6 * u, -4.4 * u]]);
    const f = wob(t, 2.4) * 0.3; c.fillStyle = alpha(k.gold, 0.6); c.beginPath(); c.moveTo(2.6 * u, -4.4 * u); c.quadraticCurveTo(3.6 * u, -4.4 * u + f * u, 4.4 * u, -3.9 * u); c.lineTo(2.6 * u, -3.3 * u); c.fill();
    // Two horses, mid-stride.
    c.strokeStyle = k.tx;
    for (const dx of [-4.2, -5.6]) {
      const g = wob(t, 4, dx) * 0.4 * u;
      c.save(); c.translate(dx * u, 0.4 * u);
      c.beginPath(); c.ellipse(0, 0, 1.6 * u, 0.7 * u, 0, 0, TAU); c.stroke();
      line(c, [[-1.3 * u, -0.2 * u], [-2.2 * u, -1.6 * u], [-2.8 * u, -1.3 * u]]);
      line(c, [[-1 * u, 0.5 * u], [-1.2 * u + g, 2.4 * u]]); line(c, [[1 * u, 0.5 * u], [1.2 * u - g, 2.4 * u]]);
      c.restore();
    }
    c.strokeStyle = alpha(k.tx, 0.5); line(c, [[-5 * u, -0.2 * u], [-1.8 * u, 0.6 * u]]);
  },
  conch(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.gold; c.fillStyle = alpha(k.gold, 0.12);
    c.beginPath(); c.moveTo(-3 * u, 1 * u); c.bezierCurveTo(-3 * u, -2 * u, 1 * u, -2.6 * u, 3 * u, -0.6 * u); c.bezierCurveTo(2.2 * u, 0.4 * u, 1 * u, 2.2 * u, -3 * u, 1 * u); c.fill(); c.stroke();
    for (let i = 0; i < 4; i++) { c.beginPath(); c.arc(-1.6 * u + i * 0.9 * u, -0.2 * u, (1.2 - i * 0.25) * u, Math.PI * 0.9, Math.PI * 1.9); c.stroke(); }
    // Its sound spreads out.
    for (let i = 0; i < 4; i++) {
      const p = (t * 0.45 + i / 4) % 1;
      c.strokeStyle = alpha(k.ac, 0.7 * (1 - p)); c.beginPath(); c.arc(3 * u, -0.6 * u, (0.8 + p * 4.5) * u, -Math.PI * 0.35, Math.PI * 0.35); c.stroke();
    }
  },
  bow(c, s, t, k) {
    const u = s / 10, v = wob(t, 14) * 0.15 * u * Math.exp(-((t % 3) * 1.2));
    c.strokeStyle = k.gold; c.beginPath(); c.arc(-3 * u, 0, 5 * u, -Math.PI * 0.36, Math.PI * 0.36); c.stroke();
    c.strokeStyle = k.tx; line(c, [[1.05 * u, -2.9 * u], [-0.6 * u + v, 0], [1.05 * u, 2.9 * u]]);
    c.strokeStyle = k.ac; line(c, [[-0.6 * u, 0], [4 * u, 0]]);
    c.beginPath(); c.moveTo(4.6 * u, 0); c.lineTo(3.8 * u, -0.4 * u); c.lineTo(3.8 * u, 0.4 * u); c.closePath(); c.stroke();
  },
  warrior(c, s, t, k) { figure(c, s, t, k, { spear: true, crown: true, col: k.rose, sway: 1 }); },
  krishna(c, s, t, k) {
    const u = s / 10;
    const g = c.createRadialGradient(0, -2.4 * u, 0, 0, -2.4 * u, 3.4 * u); g.addColorStop(0, alpha(k.gold, 0.28 + 0.08 * wob(t, 1.5))); g.addColorStop(1, alpha(k.gold, 0));
    c.fillStyle = g; circle(c, 0, -2.4 * u, 3.4 * u, true);
    figure(c, s, t, k, { flute: true, feather: true, col: '#7fa7d8', sway: 1 });
  },
  arjuna(c, s, t, k) { figure(c, s, t, k, { pose: 'slumped', col: k.ac }); },
  elders(c, s, t, k) {
    [[-0.3, 0.8, k.txm], [0, 1, k.ac], [0.3, 0.8, k.rose]].forEach(([dx, sc, col]) => { c.save(); c.translate(dx * s, (1 - sc) * s * 0.3); c.scale(sc * 0.6, sc * 0.6); figure(c, s, t, k, { col, crown: dx === 0, sway: 0.5 }); c.restore(); });
  },
  king(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.gold; c.fillStyle = alpha(k.gold, 0.1);
    c.beginPath(); c.moveTo(-3 * u, 4.6 * u); c.lineTo(-3 * u, -3.6 * u); c.quadraticCurveTo(0, -5.6 * u, 3 * u, -3.6 * u); c.lineTo(3 * u, 4.6 * u); c.stroke(); c.fill();
    c.save(); c.scale(0.8, 0.8); c.translate(0, 0.8 * u); figure(c, s, t, k, { pose: 'seated', crown: true, col: k.ac }); c.restore();
  },
  seer(c, s, t, k) {
    const u = s / 10, o = 0.6 + 0.4 * wob(t, 1.2);
    c.strokeStyle = k.ac; c.beginPath(); c.moveTo(-4 * u, 0); c.quadraticCurveTo(0, -3.4 * u, 4 * u, 0); c.quadraticCurveTo(0, 3.4 * u, -4 * u, 0); c.stroke();
    c.fillStyle = alpha(k.gold, 0.8); circle(c, 0, 0, 1.3 * u * (0.9 + 0.1 * o), true);
    c.fillStyle = k.bg0 || '#111'; circle(c, 0, 0, 0.5 * u, true);
    for (let i = 0; i < 12; i++) { const a = i * TAU / 12 + t * 0.15; c.strokeStyle = alpha(k.gold, 0.35 * o); line(c, [[Math.cos(a) * 4.4 * u, Math.sin(a) * 3.2 * u], [Math.cos(a) * 5.2 * u, Math.sin(a) * 4 * u]]); }
  },
  family(c, s, t, k) {
    [-0.32, -0.11, 0.11, 0.32].forEach((dx, i) => { c.save(); c.translate(dx * s, i % 2 ? s * 0.08 : 0); c.scale(i % 2 ? 0.45 : 0.55, i % 2 ? 0.45 : 0.55); figure(c, s, t + i, k, { col: [k.ac, k.rose, k.alt, k.gold][i], sway: 0.6 }); c.restore(); });
  },
  lotus(c, s, t, k) {
    const u = s / 10, open = ease(t / 3.2);
    // Water rings.
    for (let i = 0; i < 3; i++) { const p = (t * 0.25 + i / 3) % 1; c.strokeStyle = alpha(k.alt, 0.5 * (1 - p)); c.beginPath(); c.ellipse(0, 2.6 * u, (2 + p * 4) * u, (0.4 + p * 0.8) * u, 0, 0, TAU); c.stroke(); }
    // Petals open from the centre.
    const petals = [[-0.95, 0.75], [-0.55, 0.95], [0, 1.1], [0.55, 0.95], [0.95, 0.75]];
    petals.forEach(([a, h], i) => {
      c.save(); c.translate(0, 2.2 * u); c.rotate(a * open * 0.9);
      c.fillStyle = alpha(i === 2 ? k.rose : k.ac, 0.22); c.strokeStyle = i === 2 ? k.rose : k.ac;
      c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(-1.1 * u, -2 * u * h, 0, -4 * u * h); c.quadraticCurveTo(1.1 * u, -2 * u * h, 0, 0); c.fill(); c.stroke();
      c.restore();
    });
    c.fillStyle = k.gold; circle(c, 0, 1.9 * u, 0.35 * u, true);
  },
  sun(c, s, t, k) {
    const u = s / 10, rise = ease(t / 2.5);
    c.save(); c.translate(0, (1 - rise) * 2 * u);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 4.6 * u); g.addColorStop(0, alpha(k.gold, 0.5)); g.addColorStop(1, alpha(k.gold, 0));
    c.fillStyle = g; circle(c, 0, 0, 4.6 * u, true);
    c.strokeStyle = k.gold; circle(c, 0, 0, 1.8 * u);
    for (let i = 0; i < 16; i++) { const a = i * TAU / 16 + t * 0.12, r1 = 2.4 * u, r2 = (i % 2 ? 3.2 : 3.8) * u; line(c, [[Math.cos(a) * r1, Math.sin(a) * r1], [Math.cos(a) * r2, Math.sin(a) * r2]]); }
    c.restore();
    c.strokeStyle = alpha(k.tx, 0.3); line(c, [[-5 * u, 2.2 * u], [5 * u, 2.2 * u]]);
  },
  moon(c, s, t, k) {
    const u = s / 10;
    c.fillStyle = alpha(k.tx, 0.85); c.beginPath(); c.arc(0, 0, 2.6 * u, 0, TAU); c.arc(1.1 * u, -0.6 * u, 2.3 * u, 0, TAU, true); c.fill('evenodd');
    M.stars(c, s, t, k, 14);
  },
  stars(c, s, t, k, n = 30) {
    for (let i = 0; i < n; i++) {
      const x = Math.sin(i * 91.7) * s * 0.48, y = Math.cos(i * 37.3) * s * 0.44, tw = 0.35 + 0.65 * Math.abs(Math.sin(t * (0.6 + (i % 5) * 0.2) + i));
      c.fillStyle = alpha(i % 4 ? k.tx : k.gold, tw); circle(c, x, y, 1.5 + (i % 3), true);
    }
  },
  flame(c, s, t, k) {
    const u = s / 10, f = wob(t, 7) * 0.2 + wob(t, 11, 1) * 0.12;
    const g = c.createRadialGradient(0, -1 * u, 0, 0, -1 * u, 4 * u); g.addColorStop(0, alpha(k.gold, 0.35)); g.addColorStop(1, alpha(k.gold, 0)); c.fillStyle = g; circle(c, 0, -1 * u, 4 * u, true);
    c.fillStyle = alpha(k.gold, 0.85); c.beginPath(); c.moveTo(0, 1.6 * u); c.bezierCurveTo(-1.8 * u, 0.4 * u, -0.8 * u, -2 * u, f * u, -4.2 * u); c.bezierCurveTo(0.9 * u, -2 * u, 1.8 * u, 0.4 * u, 0, 1.6 * u); c.fill();
    c.fillStyle = alpha(k.tx, 0.85); c.beginPath(); c.moveTo(0, 1.2 * u); c.bezierCurveTo(-0.7 * u, 0.4 * u, -0.3 * u, -1 * u, f * 0.5 * u, -2 * u); c.bezierCurveTo(0.4 * u, -1 * u, 0.7 * u, 0.4 * u, 0, 1.2 * u); c.fill();
  },
  lamp(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.gold; c.fillStyle = alpha(k.gold, 0.15);
    c.beginPath(); c.moveTo(-3 * u, 2 * u); c.quadraticCurveTo(0, 4.4 * u, 3 * u, 2 * u); c.quadraticCurveTo(1 * u, 2.6 * u, -3 * u, 2 * u); c.fill(); c.stroke();
    c.save(); c.translate(1.8 * u, 0.4 * u); c.scale(0.5, 0.5); M.flame(c, s, t, k); c.restore();
  },
  river(c, s, t, k) {
    const u = s / 10;
    for (let r = 0; r < 5; r++) {
      c.strokeStyle = alpha(r % 2 ? k.alt : k.ac, 0.7 - r * 0.1); c.beginPath();
      for (let x = -5; x <= 5; x += 0.25) { const y = (r - 2) * 1 * u + Math.sin(x * 1.1 + t * 1.6 + r) * 0.35 * u; x === -5 ? c.moveTo(x * u, y) : c.lineTo(x * u, y); }
      c.stroke();
    }
  },
  ocean(c, s, t, k) {
    const u = s / 10;
    for (let r = 0; r < 4; r++) {
      c.strokeStyle = alpha(k.alt, 0.85 - r * 0.15); c.beginPath();
      for (let x = -5; x <= 5; x += 0.2) { const y = (r * 1.1 - 0.5) * u + Math.sin(x * 1.4 + t * (1.2 - r * 0.2) + r * 2) * 0.45 * u; x === -5 ? c.moveTo(x * u, y) : c.lineTo(x * u, y); }
      c.stroke();
    }
    c.save(); c.translate(0, -2.8 * u); c.scale(0.5, 0.5); M.sun(c, s, t, k); c.restore();
  },
  mountain(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.ac; c.fillStyle = alpha(k.ac, 0.1);
    c.beginPath(); c.moveTo(-5 * u, 3 * u); c.lineTo(-1.6 * u, -2.6 * u); c.lineTo(0.4 * u, 0); c.lineTo(2 * u, -1.4 * u); c.lineTo(5 * u, 3 * u); c.closePath(); c.fill(); c.stroke();
    c.strokeStyle = k.tx; line(c, [[-2.4 * u, -1.3 * u], [-1.6 * u, -2.6 * u], [-0.9 * u, -1.5 * u]]);
    for (let i = 0; i < 3; i++) { const x = ((t * 0.3 + i * 1.7) % 10) - 5; c.strokeStyle = alpha(k.tx, 0.3); line(c, [[x * u, (0.6 + i * 0.6) * u], [(x + 2.2) * u, (0.6 + i * 0.6) * u]]); }
  },
  tree(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.gold; line(c, [[0, 4 * u], [0, -0.5 * u]]); line(c, [[0, 1 * u], [-1.6 * u, -0.8 * u]]); line(c, [[0, 0.4 * u], [1.8 * u, -1 * u]]);
    for (let i = 0; i < 16; i++) { const a = i * 2.4, r = (1.4 + (i % 4) * 0.7) * u, x = Math.cos(a) * r * 1.2, y = -2.2 * u + Math.sin(a) * r * 0.7, sw = wob(t, 1.4, i) * 0.12 * u; c.fillStyle = alpha(i % 3 ? k.alt : k.ac, 0.45); c.beginPath(); c.ellipse(x + sw, y, 0.7 * u, 0.4 * u, a, 0, TAU); c.fill(); }
    c.strokeStyle = alpha(k.gold, 0.5); line(c, [[-1.2 * u, 4 * u], [0, 3.2 * u], [1.4 * u, 4 * u]]);
  },
  seed(c, s, t, k) {
    const u = s / 10, g = ease(t / 4);
    c.strokeStyle = alpha(k.tx, 0.4); line(c, [[-4 * u, 2 * u], [4 * u, 2 * u]]);
    c.fillStyle = alpha(k.gold, 0.8); c.beginPath(); c.ellipse(0, 2.6 * u, 0.8 * u, 0.5 * u, 0, 0, TAU); c.fill();
    c.strokeStyle = k.alt; line(c, [[0, 2.2 * u], [0, 2.2 * u - 4 * u * g]]);
    if (g > 0.4) { const l = (g - 0.4) / 0.6; c.fillStyle = alpha(k.alt, 0.5); c.beginPath(); c.ellipse(-0.9 * u * l, (2.2 - 3.2 * g) * u, 0.9 * u * l, 0.4 * u * l, -0.5, 0, TAU); c.fill(); c.beginPath(); c.ellipse(0.9 * u * l, (2.2 - 3.6 * g) * u, 0.9 * u * l, 0.4 * u * l, 0.5, 0, TAU); c.fill(); }
  },
  wheel(c, s, t, k) {
    const u = s / 10;
    c.save(); c.rotate(t * 0.35);
    c.strokeStyle = k.gold; circle(c, 0, 0, 4 * u); circle(c, 0, 0, 3.4 * u); circle(c, 0, 0, 0.7 * u);
    for (let i = 0; i < 24; i++) { const a = i * TAU / 24; line(c, [[Math.cos(a) * 0.7 * u, Math.sin(a) * 0.7 * u], [Math.cos(a) * 3.4 * u, Math.sin(a) * 3.4 * u]]); }
    c.restore();
    // Birth, life, death, again: three marks travelling round.
    for (let i = 0; i < 3; i++) { const a = t * 0.6 + i * TAU / 3; c.fillStyle = [k.ac, k.rose, k.alt][i]; circle(c, Math.cos(a) * 4.8 * u, Math.sin(a) * 4.8 * u, 0.35 * u, true); }
  },
  path(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.ac; c.beginPath(); c.moveTo(-3 * u, 4 * u); c.bezierCurveTo(-1 * u, 1 * u, 2 * u, 1.4 * u, 0.2 * u, -3.6 * u); c.stroke();
    c.beginPath(); c.moveTo(3 * u, 4 * u); c.bezierCurveTo(2 * u, 1 * u, 3 * u, 1 * u, 0.6 * u, -3.6 * u); c.stroke();
    const p = (t * 0.12) % 1, x = (-3 + (0.2 + 3.2) * p) * u * 0.5 + 0.2 * u, y = (4 - 7.6 * p) * u;
    c.fillStyle = k.gold; circle(c, x, y, 0.3 * u, true);
    c.save(); c.translate(0.4 * u, -4.2 * u); c.scale(0.25, 0.25); M.sun(c, s, t, k); c.restore();
  },
  scales(c, s, t, k) {
    const u = s / 10, tilt = wob(t, 0.8) * 0.12;
    c.strokeStyle = k.gold; line(c, [[0, 4 * u], [0, -3 * u]]); line(c, [[-2 * u, 4 * u], [2 * u, 4 * u]]);
    c.save(); c.translate(0, -3 * u); c.rotate(tilt); line(c, [[-4 * u, 0], [4 * u, 0]]);
    for (const sx of [-4, 4]) { c.save(); c.translate(sx * u, 0); c.rotate(-tilt); line(c, [[0, 0], [-1 * u, 2.2 * u]]); line(c, [[0, 0], [1 * u, 2.2 * u]]); c.beginPath(); c.arc(0, 2.2 * u, 1.2 * u, 0, Math.PI); c.stroke(); c.restore(); }
    c.restore();
  },
  heart(c, s, t, k) {
    const u = s / 10, b = 1 + 0.06 * Math.max(0, Math.sin(t * 5)) * (Math.sin(t * 2.5) > 0 ? 1 : 0);
    c.save(); c.scale(b, b);
    c.fillStyle = alpha(k.rose, 0.3); c.strokeStyle = k.rose;
    c.beginPath(); c.moveTo(0, 3 * u); c.bezierCurveTo(-5 * u, -0.4 * u, -2.4 * u, -4 * u, 0, -1.6 * u); c.bezierCurveTo(2.4 * u, -4 * u, 5 * u, -0.4 * u, 0, 3 * u); c.fill(); c.stroke();
    c.restore();
  },
  mind(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.ac; c.beginPath(); c.moveTo(-1 * u, 4 * u); c.lineTo(-1 * u, 2.4 * u); c.bezierCurveTo(-3.6 * u, 1.6 * u, -3.4 * u, -3.6 * u, 0.4 * u, -3.6 * u); c.bezierCurveTo(3 * u, -3.6 * u, 3.4 * u, -0.6 * u, 2.6 * u, 0.4 * u); c.lineTo(3.2 * u, 1.4 * u); c.lineTo(2.4 * u, 1.6 * u); c.lineTo(2.4 * u, 2.6 * u); c.lineTo(1 * u, 2.8 * u); c.lineTo(1 * u, 4 * u); c.stroke();
    // Thoughts, restless at first, then still.
    const calm = ease(t / 5);
    c.strokeStyle = alpha(k.gold, 0.8); c.beginPath();
    for (let x = -2; x <= 2; x += 0.1) { const y = -1.2 * u + Math.sin(x * 4 + t * 3) * 0.5 * u * (1 - calm); x === -2 ? c.moveTo(x * u, y) : c.lineTo(x * u, y); }
    c.stroke();
  },
  meditation(c, s, t, k) {
    const u = s / 10;
    for (let i = 0; i < 3; i++) { const p = (t * 0.2 + i / 3) % 1; c.strokeStyle = alpha(k.gold, 0.5 * (1 - p)); circle(c, 0, -0.5 * u, (2 + p * 3) * u); }
    figure(c, s, t, k, { pose: 'seated', col: k.ac });
  },
  light(c, s, t, k) {
    const u = s / 10;
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 5 * u); g.addColorStop(0, alpha(k.tx, 0.6)); g.addColorStop(0.3, alpha(k.gold, 0.3)); g.addColorStop(1, alpha(k.gold, 0)); c.fillStyle = g; circle(c, 0, 0, 5 * u, true);
    for (let i = 0; i < 12; i++) { const a = i * TAU / 12 + t * 0.08, r = (3 + 0.6 * wob(t, 2, i)) * u; c.strokeStyle = alpha(k.gold, 0.6); line(c, [[Math.cos(a) * 1.2 * u, Math.sin(a) * 1.2 * u], [Math.cos(a) * r, Math.sin(a) * r]]); }
  },
  storm(c, s, t, k) {
    const u = s / 10;
    c.fillStyle = alpha(k.txm, 0.35); c.strokeStyle = k.txm;
    c.beginPath(); c.moveTo(-3.6 * u, -0.6 * u); c.arc(-2.2 * u, -1.2 * u, 1.4 * u, Math.PI * 0.8, Math.PI * 1.7); c.arc(0, -2 * u, 2 * u, Math.PI * 1.1, Math.PI * 1.95); c.arc(2.4 * u, -1 * u, 1.4 * u, Math.PI * 1.4, Math.PI * 0.3); c.closePath(); c.fill(); c.stroke();
    const flash = (t % 3.2) < 0.18;
    c.strokeStyle = flash ? k.tx : alpha(k.gold, 0.7); line(c, [[0.4 * u, 0.2 * u], [-0.6 * u, 2 * u], [0.4 * u, 2 * u], [-0.6 * u, 4 * u]]);
    c.strokeStyle = alpha(k.alt, 0.6);
    for (let i = 0; i < 10; i++) { const x = (-3 + i * 0.7) * u, p = (t * 1.6 + i * 0.37) % 1; line(c, [[x, (0.6 + p * 3) * u], [x - 0.2 * u, (1.2 + p * 3) * u]]); }
  },
  garden(c, s, t, k) {
    const u = s / 10;
    for (let i = 0; i < 6; i++) {
      const x = (-4 + i * 1.6) * u, sw = wob(t, 1.3, i) * 0.4 * u, h = (2.4 + (i % 3)) * u;
      c.strokeStyle = k.alt; c.beginPath(); c.moveTo(x, 4 * u); c.quadraticCurveTo(x, 4 * u - h / 2, x + sw, 4 * u - h); c.stroke();
      c.fillStyle = alpha([k.rose, k.gold, k.ac][i % 3], 0.7);
      for (let p = 0; p < 5; p++) { const a = p * TAU / 5 + t * 0.2; circle(c, x + sw + Math.cos(a) * 0.45 * u, 4 * u - h + Math.sin(a) * 0.45 * u, 0.32 * u, true); }
    }
  },
  scroll(c, s, t, k) {
    const u = s / 10, open = ease(t / 2.4);
    c.strokeStyle = k.gold; c.fillStyle = alpha(k.gold, 0.08);
    c.fillRect(-3.4 * u, -3 * u * open, 6.8 * u, 6 * u * open); c.strokeRect(-3.4 * u, -3 * u * open, 6.8 * u, 6 * u * open);
    for (const y of [-3, 3]) { c.beginPath(); c.ellipse(0, y * u * open, 3.8 * u, 0.45 * u, 0, 0, TAU); c.stroke(); }
    c.strokeStyle = alpha(k.tx, 0.5);
    for (let i = 0; i < 6; i++) { const y = (-2.2 + i * 0.85) * u; if (Math.abs(y) < 3 * u * open - 0.3 * u) line(c, [[-2.6 * u, y], [(i === 5 ? 0.4 : 2.6) * u, y]]); }
  },
  temple(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.gold; c.fillStyle = alpha(k.gold, 0.08);
    c.beginPath(); c.moveTo(-4 * u, 4 * u); c.lineTo(-4 * u, 1 * u); c.lineTo(-2.4 * u, 1 * u); c.quadraticCurveTo(-2 * u, -3 * u, 0, -4.6 * u); c.quadraticCurveTo(2 * u, -3 * u, 2.4 * u, 1 * u); c.lineTo(4 * u, 1 * u); c.lineTo(4 * u, 4 * u); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.arc(0, 4 * u, 1 * u, Math.PI, 0); c.stroke();
    const f = wob(t, 2.6) * 0.3; c.fillStyle = alpha(k.rose, 0.7); c.beginPath(); c.moveTo(0, -4.6 * u); c.lineTo(0, -6 * u); c.quadraticCurveTo(0.8 * u, -5.8 * u + f * u, 1.4 * u, -5.5 * u); c.lineTo(0, -5.2 * u); c.fill();
  },
  om(c, s, t, k) {
    const u = s / 10;
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 4.4 * u); g.addColorStop(0, alpha(k.gold, 0.25 + 0.08 * wob(t, 1.2))); g.addColorStop(1, alpha(k.gold, 0)); c.fillStyle = g; circle(c, 0, 0, 4.4 * u, true);
    c.fillStyle = k.gold; c.font = '400 ' + Math.round(6.4 * u) + 'px "Noto Sans Devanagari", "Nirmala UI", Mangal, serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('ॐ', 0, 0.2 * u);
  },
  feather(c, s, t, k) {
    const u = s / 10;
    c.save(); c.rotate(-0.4 + wob(t, 1.1) * 0.05);
    c.strokeStyle = k.alt; line(c, [[0, 4.6 * u], [0, -3 * u]]);
    for (let i = 0; i < 14; i++) { const y = 3.6 * u - i * 0.5 * u, w = Math.sin(i / 13 * Math.PI) * 1.8 * u; c.strokeStyle = alpha(i % 2 ? k.alt : '#7fa7d8', 0.7); line(c, [[0, y], [-w, y - 0.6 * u]]); line(c, [[0, y], [w, y - 0.6 * u]]); }
    c.fillStyle = alpha('#7fa7d8', 0.9); c.beginPath(); c.ellipse(0, -1.8 * u, 0.9 * u, 1.3 * u, 0, 0, TAU); c.fill();
    c.fillStyle = k.gold; c.beginPath(); c.ellipse(0, -1.8 * u, 0.45 * u, 0.7 * u, 0, 0, TAU); c.fill();
    c.restore();
  },
  garment(c, s, t, k) {
    // As a person puts on new clothes and gives up the old (2.22).
    const u = s / 10, p = ease((t % 6) / 3);
    const robe = (x, col, a) => { c.save(); c.translate(x, 0); c.globalAlpha *= a; c.strokeStyle = col; c.fillStyle = alpha(col, 0.15); c.beginPath(); c.moveTo(-1 * u, -3 * u); c.lineTo(1 * u, -3 * u); c.lineTo(2.2 * u, 3 * u); c.lineTo(-2.2 * u, 3 * u); c.closePath(); c.fill(); c.stroke(); line(c, [[-1 * u, -3 * u], [-2.4 * u, -1.2 * u]]); line(c, [[1 * u, -3 * u], [2.4 * u, -1.2 * u]]); c.restore(); };
    robe(-2.6 * u, k.txm, 1 - 0.6 * p);
    robe(2.6 * u, k.ac, 0.4 + 0.6 * p);
    c.strokeStyle = alpha(k.gold, 0.8); line(c, [[-0.6 * u, 0], [0.6 * u, 0]]); line(c, [[0.2 * u, -0.4 * u], [0.6 * u, 0], [0.2 * u, 0.4 * u]]);
  },
  door(c, s, t, k) {
    const u = s / 10, o = ease(t / 3);
    c.strokeStyle = k.ac; c.strokeRect(-2.4 * u, -4 * u, 4.8 * u, 8 * u);
    const g = c.createLinearGradient(-2.4 * u, 0, 2.4 * u, 0); g.addColorStop(0, alpha(k.gold, 0.5 * o)); g.addColorStop(1, alpha(k.gold, 0.1)); c.fillStyle = g; c.fillRect(-2.4 * u, -4 * u, 4.8 * u, 8 * u);
    c.fillStyle = alpha(k.ac, 0.2); c.beginPath(); c.moveTo(2.4 * u, -4 * u); c.lineTo(2.4 * u - 4.8 * u * (1 - o * 0.7), -4 * u + o * 0.6 * u); c.lineTo(2.4 * u - 4.8 * u * (1 - o * 0.7), 4 * u - o * 0.6 * u); c.lineTo(2.4 * u, 4 * u); c.closePath(); c.fill(); c.stroke();
  },
  steps(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.ac; c.beginPath(); c.moveTo(-4.5 * u, 4 * u);
    for (let i = 0; i < 6; i++) { c.lineTo((-4.5 + i * 1.5) * u, (4 - i * 1.3) * u - 1.3 * u); c.lineTo((-3 + i * 1.5) * u, (4 - i * 1.3) * u - 1.3 * u); }
    c.stroke();
    const p = (t * 0.25) % 1, i = Math.floor(p * 6); c.fillStyle = k.gold; circle(c, (-3.8 + i * 1.5) * u, (2.3 - i * 1.3) * u - 0.4 * u, 0.35 * u, true);
  },
  people(c, s, t, k) { M.family(c, s, t, k); },
  crown(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.gold; c.fillStyle = alpha(k.gold, 0.15);
    c.beginPath(); c.moveTo(-4 * u, 2 * u); c.lineTo(-4 * u, -2 * u); c.lineTo(-2 * u, 0); c.lineTo(0, -3 * u); c.lineTo(2 * u, 0); c.lineTo(4 * u, -2 * u); c.lineTo(4 * u, 2 * u); c.closePath(); c.fill(); c.stroke();
    [[-4, -2], [0, -3], [4, -2]].forEach(([x, y], i) => { c.fillStyle = alpha(k.rose, 0.6 + 0.4 * wob(t, 2, i)); circle(c, x * u, y * u, 0.4 * u, true); });
  },
  sword(c, s, t, k) {
    const u = s / 10;
    c.save(); c.rotate(-0.6);
    c.strokeStyle = k.tx; c.beginPath(); c.moveTo(0, -5 * u); c.lineTo(0.5 * u, -4 * u); c.lineTo(0.5 * u, 2.4 * u); c.lineTo(-0.5 * u, 2.4 * u); c.lineTo(-0.5 * u, -4 * u); c.closePath(); c.stroke();
    c.strokeStyle = k.gold; line(c, [[-2 * u, 2.4 * u], [2 * u, 2.4 * u]]); line(c, [[0, 2.4 * u], [0, 4.4 * u]]);
    const sh = (t * 0.5) % 1; c.strokeStyle = alpha(k.tx, 0.8 * (1 - Math.abs(sh - 0.5) * 2)); line(c, [[0.2 * u, -3.8 * u + sh * 6 * u], [0.2 * u, -3.2 * u + sh * 6 * u]]);
    c.restore();
  },
  clock(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.ac; circle(c, 0, 0, 4 * u);
    for (let i = 0; i < 12; i++) { const a = i * TAU / 12; line(c, [[Math.cos(a) * 3.4 * u, Math.sin(a) * 3.4 * u], [Math.cos(a) * 3.8 * u, Math.sin(a) * 3.8 * u]]); }
    c.strokeStyle = k.gold; const a1 = t * 0.6 - Math.PI / 2, a2 = t * 0.05 - Math.PI / 2;
    line(c, [[0, 0], [Math.cos(a1) * 3 * u, Math.sin(a1) * 3 * u]]); line(c, [[0, 0], [Math.cos(a2) * 2 * u, Math.sin(a2) * 2 * u]]);
  },
  key(c, s, t, k) {
    const u = s / 10;
    c.save(); c.rotate(-0.3 + wob(t, 0.9) * 0.05);
    c.strokeStyle = k.gold; circle(c, -2.4 * u, 0, 1.6 * u); circle(c, -2.4 * u, 0, 0.6 * u);
    line(c, [[-0.8 * u, 0], [4 * u, 0]]); line(c, [[3 * u, 0], [3 * u, 1.2 * u]]); line(c, [[4 * u, 0], [4 * u, 1.4 * u]]);
    c.restore();
  },
  bridge(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.ac; c.beginPath(); c.moveTo(-5 * u, 1 * u); c.quadraticCurveTo(0, -3 * u, 5 * u, 1 * u); c.stroke();
    line(c, [[-5 * u, 1 * u], [5 * u, 1 * u]]);
    for (let i = -4; i <= 4; i++) { const y = 1 - (1 - (i / 5) ** 2) * 2; line(c, [[i * u, y * u], [i * u, 1 * u]]); }
    c.save(); c.translate(0, 3 * u); c.scale(1, 0.4); M.river(c, s, t, k); c.restore();
  },
  city(c, s, t, k) {
    const u = s / 10;
    [[-4.4, 3], [-3, 5], [-1.6, 4], [-0.2, 6.4], [1.2, 3.6], [2.6, 5.2], [3.8, 4]].forEach(([x, h], i) => {
      c.strokeStyle = k.ac; c.fillStyle = alpha(k.ac, 0.1); c.fillRect(x * u, (3.6 - h) * u, 1.2 * u, h * u); c.strokeRect(x * u, (3.6 - h) * u, 1.2 * u, h * u);
      for (let w = 0; w < h - 1; w++) { const on = Math.sin(t * 0.7 + i * 3 + w * 1.7) > 0.3; c.fillStyle = alpha(k.gold, on ? 0.8 : 0.15); c.fillRect((x + 0.35) * u, (3.6 - h + 0.6 + w) * u, 0.4 * u, 0.4 * u); }
    });
  },
  home(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.ac; c.fillStyle = alpha(k.ac, 0.1);
    c.beginPath(); c.moveTo(-3.4 * u, 0); c.lineTo(0, -3.4 * u); c.lineTo(3.4 * u, 0); c.stroke();
    c.fillRect(-2.6 * u, 0, 5.2 * u, 4 * u); c.strokeRect(-2.6 * u, 0, 5.2 * u, 4 * u);
    c.fillStyle = alpha(k.gold, 0.6 + 0.2 * wob(t, 1.5)); c.fillRect(-1.6 * u, 1 * u, 1.2 * u, 1.2 * u);
    c.strokeRect(0.6 * u, 1.4 * u, 1.2 * u, 2.6 * u);
  },
  globe(c, s, t, k) {
    const u = s / 10;
    c.strokeStyle = k.alt; circle(c, 0, 0, 4 * u);
    for (let i = -2; i <= 2; i++) { c.beginPath(); c.ellipse(0, i * 1.4 * u, Math.sqrt(16 - (i * 1.4) ** 2) * u, 0.3 * u, 0, 0, TAU); c.stroke(); }
    for (let i = 0; i < 4; i++) { const w = Math.cos(t * 0.5 + i * Math.PI / 4) * 4 * u; c.beginPath(); c.ellipse(0, 0, Math.abs(w), 4 * u, 0, 0, TAU); c.stroke(); }
  },
  idea(c, s, t, k) {
    const u = s / 10, on = 0.5 + 0.5 * Math.min(1, t / 1.5);
    const g = c.createRadialGradient(0, -1 * u, 0, 0, -1 * u, 5 * u); g.addColorStop(0, alpha(k.gold, 0.4 * on)); g.addColorStop(1, alpha(k.gold, 0)); c.fillStyle = g; circle(c, 0, -1 * u, 5 * u, true);
    c.strokeStyle = k.gold; c.beginPath(); c.arc(0, -1.2 * u, 2.6 * u, Math.PI * 0.8, Math.PI * 2.2); c.lineTo(1.2 * u, 2.4 * u); c.lineTo(-1.2 * u, 2.4 * u); c.closePath(); c.stroke();
    line(c, [[-1 * u, 3.1 * u], [1 * u, 3.1 * u]]); line(c, [[-0.7 * u, 3.7 * u], [0.7 * u, 3.7 * u]]);
  },
  book(c, s, t, k) {
    const u = s / 10, f = wob(t, 0.8) * 0.3;
    c.strokeStyle = k.ac; c.fillStyle = alpha(k.ac, 0.1);
    for (const sd of [-1, 1]) { c.beginPath(); c.moveTo(0, -2.6 * u); c.quadraticCurveTo(sd * 2.4 * u, -3.4 * u, sd * 4.4 * u, -2.8 * u + (sd > 0 ? f * u : 0)); c.lineTo(sd * 4.4 * u, 2.6 * u); c.quadraticCurveTo(sd * 2.4 * u, 2 * u, 0, 2.8 * u); c.closePath(); c.fill(); c.stroke(); }
    c.strokeStyle = alpha(k.tx, 0.4); for (let i = 0; i < 4; i++) for (const sd of [-1, 1]) line(c, [[sd * 0.8 * u, (-1.4 + i) * u], [sd * 3.6 * u, (-1.6 + i) * u]]);
  },
};
export const MOTIFS = Object.keys(M);

/* ── choosing the art for a scene ────────────────────────────────────────── */
// The shipped scripts name no art: their words choose it (first match wins,
// most specific first). A model's own `art` is used as it is.
const WORDS = [
  [/\bconch|shell|blew|blow/i, 'conch'], [/chariot|charioteer|horses?\b/i, 'chariot'], [/battle|war\b|armies|army|kurukshetra|field of|soldiers/i, 'battlefield'],
  [/\bbow\b|gandiva|arrow/i, 'bow'], [/despair|grief|griev|sorrow|weep|tears|dejected|sank down|collapse/i, 'arjuna'], [/krishna|the lord|supreme lord|god\b|divine/i, 'krishna'],
  [/bhishma|drona|elders|teachers|grandsire|gurus?\b/i, 'elders'], [/dhritarashtra|\bking\b|throne|duryodhana/i, 'king'], [/sanjaya|divine sight|vision|\bsees?\b/i, 'seer'],
  [/kinsmen|family|relatives|cousins|sons|brothers/i, 'family'], [/garment|clothes|worn-out|cast off/i, 'garment'], [/rebirth|reborn|birth and death|cycle|samsara|transmigrat/i, 'wheel'],
  [/lotus|untouched|unattached|detach/i, 'lotus'], [/ocean|sea\b|rivers? (?:flow|enter)/i, 'ocean'], [/river|flow/i, 'river'], [/meditat|yogi|yoga\b|posture|breath/i, 'meditation'],
  [/\bmind\b|thought|senses|restless|desire|anger|calm/i, 'mind'], [/soul|spirit|\bself\b|atman|eternal|immortal|imperishable/i, 'flame'], [/knowledge|wisdom|learn|teach|scripture|veda/i, 'scroll'],
  [/devotion|bhakti|surrender|worship|faith|love/i, 'lotus'], [/\bsun\b|light|radiant|splendou?r|brilliance/i, 'sun'], [/night|moon|darkness/i, 'moon'], [/cosmos|universe|creation|universal form|infinite/i, 'stars'],
  [/tree|ashvattha|banyan|roots/i, 'tree'], [/seed|grow|sprout/i, 'seed'], [/duty|dharma|action|karma|work|deeds?/i, 'path'], [/balance|equanim|same in|alike|even-minded/i, 'scales'],
  [/heart|compassion|kindness/i, 'heart'], [/fire|burn|sacrifice|offering|yajna/i, 'flame'], [/storm|turmoil|chaos|confus/i, 'storm'], [/temple|sacred|holy/i, 'temple'], [/\bom\b|aum|sound of/i, 'om'],
  [/time|death|ages|moment/i, 'clock'], [/freedom|liberat|moksha|release|door/i, 'door'], [/step|ladder|climb|progress/i, 'steps'], [/home|house/i, 'home'], [/world|earth/i, 'globe'], [/idea|insight|realiz/i, 'idea'], [/book|read/i, 'book'],
];
const BY_LAYOUT = { title: ['lotus', 'sun'], closing: ['lotus'], lesson: ['lamp'], compare: ['scales'], steps: ['steps'], verse: ['scroll'], story: ['lotus'] };
export function pick(sc) {
  if (sc.art && sc.art.length) return sc.art.filter((a) => M[a]).slice(0, 3);
  const text = [sc.headline, ...(sc.visual || []), sc.say].filter(Boolean).join(' ');
  const out = [];
  for (const [re, name] of WORDS) if (re.test(text) && !out.includes(name)) { out.push(name); if (out.length === 2) break; }
  return out.length ? out : (BY_LAYOUT[sc.layout] || ['lotus']).slice(0, 1);
}

/** Draw the motifs in box: the first large in the middle, others smaller
 *  beside it; each floats a little and fades in one after another. */
export function draw(ctx, names, box, t, k, { fade = 1 } = {}) {
  const list = names.filter((n) => M[n]);
  if (!list.length) return;
  const slots = list.length === 1 ? [[0.5, 0.52, 0.9]] : list.length === 2 ? [[0.42, 0.5, 0.78], [0.8, 0.74, 0.4]] : [[0.45, 0.48, 0.7], [0.82, 0.76, 0.36], [0.16, 0.2, 0.3]];
  // A soft glow behind, in the scene's colour.
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, R = Math.min(box.w, box.h) * 0.6;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R); g.addColorStop(0, alpha(k.acc || k.ac, 0.12 * fade)); g.addColorStop(1, alpha(k.acc || k.ac, 0));
  ctx.fillStyle = g; ctx.fillRect(box.x, box.y, box.w, box.h);
  list.forEach((name, i) => {
    const [fx, fy, fs] = slots[i];
    const a = ease((t - 0.3 - i * 0.5) / 0.9) * fade;
    if (a <= 0) return;
    const size = Math.min(box.w, box.h) * fs;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(box.x + box.w * fx, box.y + box.h * fy + Math.sin(t * 0.7 + i * 2) * size * 0.015 + (1 - a) * size * 0.06);
    ctx.lineWidth = Math.max(2, size / 140); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    try { M[name](ctx, size, t, k); } catch (e) {}
    ctx.restore();
  });
}
