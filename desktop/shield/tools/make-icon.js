#!/usr/bin/env node
/**
 * Rasterises the Shield mark to a multi-size Windows .ico.
 *
 * The suite draws every app icon as an inline data-URI SVG, which the web can
 * render but Windows cannot: a tray icon and an NSIS installer both need a real
 * .ico. Rather than add an image toolchain to a repo that deliberately has no
 * build step, this rasterises the same 96-unit geometry directly — the shield
 * split down the middle (gold half for T, purple half for V) around a gray
 * keyhole — and packs it as an ICO of uncompressed 32-bit BMP entries.
 *
 * BMP rather than PNG entries on purpose: Windows accepts both, and BMP needs
 * no compressor, so this stays dependency-free. 256px costs 256KB, which is
 * irrelevant for an icon that ships once.
 *
 * Run: node desktop/shield/tools/make-icon.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4;                       // supersampling factor per axis

const BG    = [0x1a, 0x1a, 0x1d];
const GOLD  = [0xe0, 0xb8, 0x74];
const PURP  = [0x8d, 0x76, 0x9a];
const GRAY  = [0xad, 0xad, 0xb2];
const ALERT = [0xd6, 0x8a, 0x7c];

// ── geometry, in the suite's 96-unit grid ──────────────────────────────────
function cubic(p0, c0, c1, p1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u*u*u*p0[0] + 3*u*u*t*c0[0] + 3*u*t*t*c1[0] + t*t*t*p1[0],
      u*u*u*p0[1] + 3*u*u*t*c0[1] + 3*u*t*t*c1[1] + t*t*t*p1[1],
    ]);
  }
  return out;
}
// Left half:  M48 14 L22 23 V47 c0 17 13 28 26 35   (ends at 48,82)
const LEFT  = [[48,14], [22,23], [22,47]].concat(cubic([22,47], [22,64], [35,75], [48,82], 24));
// Right half: mirrored about x=48
const RIGHT = LEFT.map(([x, y]) => [96 - x, y]);
const BAR   = [[48,49], [48,60]];
const RING  = { cx: 48, cy: 42, r: 7 };
const STROKE = 5;

function distToSeg(px, py, a, b) {
  const dx = b[0]-a[0], dy = b[1]-a[1];
  const L2 = dx*dx + dy*dy;
  let t = L2 ? ((px-a[0])*dx + (py-a[1])*dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a[0] + t*dx, cy = a[1] + t*dy;
  return Math.hypot(px-cx, py-cy);
}
function distToPolyline(px, py, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const s = distToSeg(px, py, pts[i], pts[i+1]);
    if (s < d) d = s;
  }
  return d;
}

// Colour of a single sample point in 96-space. Returns [r,g,b].
function sample(x, y, variant) {
  const half = STROKE / 2;
  const gold = variant === 'veda' ? PURP : (variant === 'alert' ? ALERT : GOLD);
  const purp = variant === 'tony' ? GOLD : (variant === 'alert' ? ALERT : PURP);
  const gray = variant === 'alert' ? [0xf4, 0xf3, 0xf0] : GRAY;

  if (Math.abs(Math.hypot(x - RING.cx, y - RING.cy) - RING.r) <= half) return gray;
  if (distToPolyline(x, y, BAR) <= half) return gray;
  if (distToPolyline(x, y, LEFT)  <= half) return gold;
  if (distToPolyline(x, y, RIGHT) <= half) return purp;
  return null;
}

// Rounded-rect background mask (rx = 22 on the 96 grid).
function inBg(x, y) {
  const r = 22, w = 96;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), w - r);
  if (x >= r && x <= w - r) return y >= 0 && y <= w;
  if (y >= r && y <= w - r) return x >= 0 && x <= w;
  return Math.hypot(x - cx, y - cy) <= r;
}

/** Render one size to a BGRA buffer, bottom-up (BMP order). */
function render(size, variant) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = 96 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          n++;
          if (!inBg(x, y)) continue;             // outside the rounded corner → transparent
          const c = sample(x, y, variant) || BG;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      // BMP rows run bottom-to-top.
      const off = ((size - 1 - py) * size + px) * 4;
      buf[off + 0] = Math.round(b / n);
      buf[off + 1] = Math.round(g / n);
      buf[off + 2] = Math.round(r / n);
      buf[off + 3] = Math.round(a / n);
    }
  }
  return buf;
}

function icoEntry(size, bgra) {
  // BITMAPINFOHEADER with doubled height (colour rows + AND mask rows).
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size * 2, 8);
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  // The AND mask is required by the format even for 32-bit icons; all-zero
  // means "use the alpha channel", which is what every modern shell does.
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  return Buffer.concat([hdr, bgra, mask]);
}

function buildIco(variant) {
  const images = SIZES.map(s => ({ size: s, data: icoEntry(s, render(s, variant)) }));
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 0);
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);
    dir.writeUInt8(0, e + 2); dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([dir].concat(images.map(i => i.data)));
}

/** Minimal uncompressed-PNG writer, for the 512px installer asset. */
function buildPng(size, variant) {
  const zlib = require('zlib');
  const bgra = render(size, variant);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                       // filter: none
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;     // un-flip BMP order
      const dst = y * (size * 4 + 1) + 1 + x * 4;
      raw[dst + 0] = bgra[src + 2];
      raw[dst + 1] = bgra[src + 1];
      raw[dst + 2] = bgra[src + 0];
      raw[dst + 3] = bgra[src + 3];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const out = path.join(__dirname, '..', 'src-tauri', 'icons');
fs.mkdirSync(out, { recursive: true });
const files = [
  ['icon.ico',       buildIco('dual')],
  ['icon-alert.ico', buildIco('alert')],   // tray icon while Emergency Mode is on
  ['icon.png',       buildPng(512, 'dual')],
  ['128x128.png',    buildPng(128, 'dual')],
  ['32x32.png',      buildPng(32, 'dual')],
];
for (const [name, data] of files) {
  fs.writeFileSync(path.join(out, name), data);
  console.log('wrote icons/' + name + '  (' + data.length + ' bytes)');
}
