// Watch: a chapter as a narrated video, drawn live on a canvas.
//
// The pictures are painted here, frame by frame, on a 1920x1080 canvas (the
// painters are MAGI Studio's, magi.html VIDEO_PAINT, in Shruti's colours and
// type, plus the verse, story and lesson layouts); the narration is one MP3.
// Time is the audio's own clock, so speed, seeking and the lock screen all
// work as for the podcast, and a frame is a pure function of (scene, time):
// scrubbing, pausing and the export land on exactly what played.
//
// Word-level captions come from the narration's word timings; on a verse
// scene the verse itself lights word by word as the narrator reads it.
// Fullscreen turns a phone to landscape (or rotates the picture where the
// browser cannot). Export records the canvas and the narration in real time
// with MediaRecorder (MP4 where the browser can, else WebM).
//
// Sources: shipped (books/<book>/media/videos.json) or made by Shruti and saved
// to Drive (shruti_shared assets.<book>.ch<n>.video). Both are one MP3 plus
// {narrator, duration, scenes:[{layout, headline, visual, L, ref, verse, key,
// beyond, say, vs, start, end, at, words:[[t, d, w]]}]} (tools/video.py).
// Progress is synced (progress…vid).

import * as C from './core.js';
import * as T from './text.js';
import * as M from './media.js';

const DRIVE = M.DRIVE;
export const W = 1920, H = 1080;
export const LAYOUTS = ['title', 'verse', 'story', 'lesson', 'compare', 'steps', 'closing'];
export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

let ui = { player: null, toast: () => {}, go: () => {} };
export function setUI(x) { ui = Object.assign(ui, x); }

const audio = typeof Audio === 'function' ? new Audio() : null;
if (audio) { audio.preload = 'auto'; audio.preservesPitch = true; audio.mozPreservesPitch = true; audio.webkitPreservesPitch = true; }

const V = { book: null, n: null, title: '', meta: null, url: null, playing: false, view: null, scene: -1, savedAt: 0, rec: null };
export const state = V;
const listeners = new Set();
export function onChange(f) { listeners.add(f); return () => listeners.delete(f); }
const emit = () => listeners.forEach((f) => { try { f(V); } catch (e) {} });
const keyOf = () => String(C.me.get('orcaKey', '') || '');
export const prefs = () => Object.assign({ speed: 1, cc: true }, C.me.get('video', {}) || {});
export function setPref(k, v) { C.me.set({ ['video.' + k]: v }); if (k === 'speed' && audio && !V.rec) audio.playbackRate = v; emit(); paint(); if (V.view) V.view.draw(); }
export const now = () => (audio ? audio.currentTime || 0 : 0);

/* ── what exists ─────────────────────────────────────────────────────────── */
const shippedIdx = new Map();
export function shipped(book) {
  if (!shippedIdx.has(book)) shippedIdx.set(book, fetch('books/' + book + '/media/videos.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  return shippedIdx.get(book);
}
/** The video for a chapter: a saved (Drive) one first, else the shipped one. */
export async function sourceFor(book, n) {
  const a = C.shared.get('assets.' + book + '.ch' + n + '.video', null);
  if (a && a.mp3 && a.json) return { where: 'drive', mp3: a.mp3, json: a.json, duration: a.duration };
  const s = (await shipped(book))[String(n)];
  if (s) return { where: 'shipped', mp3: 'books/' + book + '/media/' + s.mp3, json: 'books/' + book + '/media/' + s.json, duration: s.duration };
  return null;
}
async function open(src) {
  let mp3 = src.mp3, json = src.json;
  if (src.where === 'drive') {
    const res = await fetch(DRIVE + '/sign', { method: 'POST', headers: { authorization: 'Bearer ' + keyOf(), 'content-type': 'application/json' }, body: JSON.stringify({ ids: [src.mp3.id, src.json.id] }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.urls) throw new Error('Drive could not be reached (' + res.status + ').');
    mp3 = j.urls[src.mp3.id]; json = j.urls[src.json.id];
  }
  return { url: mp3, meta: prepare(await (await fetch(json)).json()) };
}

/* ── timing helpers (no DOM: tested in Node) ─────────────────────────────── */
/** The scene showing at time t (the last that started). */
export function sceneAt(scenes, t) {
  let lo = 0, hi = scenes.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (scenes[mid].start <= t + 0.001) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
/** Which lessons a video teaches, and which it misses. */
export function coverage(meta, lessonIds) {
  const have = new Set((meta.scenes || []).flatMap((s) => s.L || []));
  return { covered: lessonIds.filter((id) => have.has(id)), missing: lessonIds.filter((id) => !have.has(id)) };
}
const CUE_MAX = 60;
/** Caption pieces for one scene: its words as written (tokens, punctuation
 *  kept), cut at the speaker's pauses into pieces of about two short lines,
 *  each starting when the voice reaches it. tok(t) is the token being said. */
export function cuesFor(sc) {
  const toks = String(sc.say || '').split(/\s+/).filter(Boolean);
  const ws = sc.words || [];
  const map = T.align(ws.map((w) => w[2]), toks);
  // When each token is said: its first spoken word; a token the voice did
  // not mark (a dash) takes the time of the one before it.
  const at = new Array(toks.length).fill(null);
  map.forEach((k, i) => { if (k >= 0 && at[k] == null) at[k] = ws[i][0]; });
  let last = 0;
  for (let k = 0; k < at.length; k++) { if (at[k] == null) at[k] = last; else last = at[k]; }
  const cues = [];
  let from = 0, len = 0;
  toks.forEach((tk, k) => {
    len += tk.length + 1;
    // A verse is never split across a piece with the words around it.
    const edge = sc.vs && (k + 1 === sc.vs[0] || k + 1 === sc.vs[1]);
    const end = edge || (/[.!?]["'’”)]*$/.test(tk) ? len > 18 : /[,;:—–]["'’”)]*$/.test(tk) ? len > 34 : false);
    const next = toks[k + 1];
    if (end || k === toks.length - 1 || (next && len + next.length > CUE_MAX)) { cues.push({ from, to: k + 1, t0: at[from] }); from = k + 1; len = 0; }
  });
  const lastWord = ws.length ? ws[ws.length - 1][0] + ws[ws.length - 1][1] : 0;
  cues.forEach((c, i) => { c.t1 = i + 1 < cues.length ? cues[i + 1].t0 : lastWord + 0.5; });
  return { toks, map, at, cues };
}
/** The token being said at time t (seconds after the voice starts), or -1. */
export function tokenAt(cc, words, t) {
  const i = T.wordAt(words, t);
  for (let j = i; j >= 0; j--) if (cc.map[j] >= 0) return cc.map[j];
  return -1;
}
/** Ready a built video for the player: captions per scene. */
export function prepare(meta) {
  meta.scenes.forEach((s) => { s.cc = cuesFor(s); });
  return meta;
}

/* ── colours and type ────────────────────────────────────────────────────── */
const PAL = {
  tony: { bg0: '#0e0e11', bg1: '#1c1a23', tx: '#f3f1f8', txm: '#b6b3c1', txd: '#7e7b89', ac: '#c0aeea', gold: '#e0b874', alt: '#8cc7c4', rose: '#e7a6bb' },
  veda: { bg0: '#111113', bg1: '#24202a', tx: '#efedf1', txm: '#b9b4be', txd: '#827d87', ac: '#b49ebc', gold: '#d8b47a', alt: '#9fbcae', rose: '#cf9eac' },
};
const FONTS = {
  tony: { display: "800 {s}px Manrope, Inter, system-ui, sans-serif", body: "{w} {s}px Inter, system-ui, sans-serif", verse: "italic 500 {s}px Lora, Georgia, serif", label: "700 {s}px Inter, system-ui, sans-serif" },
  veda: { display: "700 {s}px Lora, Georgia, serif", body: "{w} {s}px Nunito, system-ui, sans-serif", verse: "italic 500 {s}px Lora, Georgia, serif", label: "800 {s}px Nunito, system-ui, sans-serif" },
};
let K = PAL.tony, F = FONTS.tony;
function theme() { const p = C.P === 'veda' ? 'veda' : 'tony'; K = PAL[p]; F = FONTS[p]; }
const fDisplay = (s) => F.display.replace('{s}', s);
const fBody = (w) => (s) => F.body.replace('{w}', w).replace('{s}', s);
const fVerse = (s) => F.verse.replace('{s}', s);
const fLabel = (s) => F.label.replace('{s}', s);
const accOf = (sc) => (!sc ? K.ac : sc.layout === 'verse' ? K.gold : sc.layout === 'story' || sc.layout === 'steps' ? K.alt : K.ac);

/* ── drawing helpers (MAGI's) ────────────────────────────────────────────── */
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
const back = (x) => { x = clamp(x); const c = 1.4; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
/** 0..1 progress of an animation that starts at `delay` and lasts `dur`. */
const vin = (t, delay, dur = 0.7) => ease((t - delay) / dur);
function wrap(ctx, text, maxW) {
  const words = String(text || '').split(/\s+/).filter(Boolean), lines = [];
  let cur = '';
  for (const w of words) { const next = cur ? cur + ' ' + w : w; if (ctx.measureText(next).width > maxW && cur) { lines.push(cur); cur = w; } else cur = next; }
  if (cur) lines.push(cur);
  return lines;
}
/** Largest font (from `px` down) at which `text` fits in maxLines. */
function fit(ctx, text, font, px, maxW, maxLines, min = 28) {
  for (let s = px; s >= min; s -= 4) { ctx.font = font(s); const lines = wrap(ctx, text, maxW); if (lines.length <= maxLines) return { size: s, lines }; }
  ctx.font = font(min);
  return { size: min, lines: wrap(ctx, text, maxW).slice(0, maxLines) };
}
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function text(ctx, lines, x, y, size, lh = 1.18, align = 'left') {
  ctx.textAlign = align; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * size * lh));
  return lines.length * size * lh;
}
/** Small spaced capitals: "THE STORY". */
function kicker(ctx, s, x, y, col, align = 'left', size = 26) {
  ctx.font = fLabel(size); ctx.fillStyle = col; ctx.textAlign = align; ctx.textBaseline = 'top';
  const str = String(s).toUpperCase().split('').join(' ');
  if ('letterSpacing' in ctx) { ctx.letterSpacing = '6px'; ctx.fillText(String(s).toUpperCase(), x, y); ctx.letterSpacing = '0px'; }
  else ctx.fillText(str, x, y);
}
function chip(ctx, s, x, y, col) {
  ctx.font = fLabel(22);
  const w = ctx.measureText(s).width + 36;
  ctx.fillStyle = 'rgba(255,255,255,.06)'; rr(ctx, x, y, w, 44, 22); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 2; rr(ctx, x, y, w, 44, 22); ctx.stroke();
  ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(s, x + 18, y + 23);
  return w;
}
/** When item i of n appears: spread across the narration. */
const stagger = (i, n, speech, first = 0.9) => first + i * Math.min(3.2, Math.max(0.4, (speech - first - 1.5) / Math.max(1, n)));
/** Heading block for the content layouts: kicker, rule, headline. */
function heading(ctx, sc, t, acc, label, y = 150) {
  const a = vin(t, 0.1, 0.8);
  ctx.globalAlpha = a;
  kicker(ctx, label, 160, y + (1 - a) * 20, acc);
  ctx.fillStyle = acc; ctx.fillRect(160, y + 46 + (1 - a) * 20, 70 * a, 3);
  const f = fit(ctx, sc.headline, fDisplay, 80, 1560, 2, 48);
  ctx.fillStyle = K.tx; ctx.font = fDisplay(f.size);
  const h = text(ctx, f.lines, 160, y + 76 + (1 - a) * 30, f.size, 1.12);
  ctx.globalAlpha = 1;
  return y + 76 + h;
}
function points(ctx, items, t, acc, y, speech, size = 48) {
  items.forEach((it, i) => {
    const p = vin(t, stagger(i, items.length, speech), 0.65);
    if (p <= 0) return;
    ctx.globalAlpha = p;
    const x = 160 + (1 - p) * -60;
    ctx.font = fBody(500)(size);
    const lines = wrap(ctx, it, 1440).slice(0, 2), h = lines.length * size * 1.25;
    ctx.fillStyle = acc; rr(ctx, x, y + 6, 12, h - 12, 6); ctx.fill();
    ctx.fillStyle = K.tx; text(ctx, lines, x + 48, y, size, 1.25);
    y += h + 40;
  });
  ctx.globalAlpha = 1;
}

/* ── scene painters: pure in (scene, t) ──────────────────────────────────── */
// ctx is in 1920x1080 units; t is seconds into the scene; v = {meta, i, lit}.
const PAINT = {
  title(ctx, sc, t, acc, v) {
    const a = vin(t, 0.15, 1.0);
    ctx.globalAlpha = vin(t, 0, 0.6) * 0.9;
    kicker(ctx, 'Shruti · ' + (v.meta.book === 'gita' ? 'Bhagavad-Gita' : v.meta.book), W / 2, 270, acc, 'center');
    ctx.globalAlpha = a;
    ctx.font = fLabel(40); ctx.fillStyle = K.txm; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('Chapter ' + v.meta.n, W / 2, 360 + (1 - a) * 30);
    const f = fit(ctx, sc.headline || v.meta.title, fDisplay, 128, 1500, 2, 64);
    ctx.font = fDisplay(f.size); ctx.fillStyle = K.tx;
    const y0 = 430 + (1 - a) * 40, h = f.lines.length * f.size * 1.08;
    text(ctx, f.lines, W / 2, y0, f.size, 1.08, 'center');
    const bw = 220 * vin(t, 0.7, 0.9);
    ctx.fillStyle = acc; rr(ctx, W / 2 - bw / 2, y0 + h + 34, bw, 6, 3); ctx.fill();
    const sub = sc.visual[0];
    if (sub) {
      const p = vin(t, 1.1, 0.8); ctx.globalAlpha = p;
      const s = fit(ctx, sub, fBody(500), 42, 1300, 2, 30);
      ctx.fillStyle = K.txm; ctx.font = fBody(500)(s.size);
      text(ctx, s.lines, W / 2, y0 + h + 76 + (1 - p) * 16, s.size, 1.3, 'center');
    }
    ctx.globalAlpha = 1;
  },

  story(ctx, sc, t, acc, v) {
    const y = heading(ctx, sc, t, acc, sc.beyond ? 'The story · beyond this rendition' : 'The story') + 70;
    points(ctx, sc.visual.slice(0, 4), t, acc, y, v.speech, sc.visual.length > 3 ? 44 : 48);
  },

  lesson(ctx, sc, t, acc, v) {
    const id = (sc.L || [])[0] || '', num = id.replace(/\D/g, ''), all = v.lessonCount;
    const a = vin(t, 0.1, 0.8);
    // The lesson's number, large, in a ring on the left.
    const cx = 330, cy = 520, R = 150;
    ctx.globalAlpha = a;
    ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = acc; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * vin(t, 0.3, 1.4) * (all ? Number(num) / all : 1)); ctx.stroke();
    ctx.fillStyle = K.tx; ctx.font = fDisplay(150); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(num || '·', cx, cy + 8);
    const x = 600, maxW = 1160;
    kicker(ctx, 'Lesson ' + num + (all ? ' of ' + all : ''), x, 230 + (1 - a) * 20, acc);
    const f = fit(ctx, sc.headline, fDisplay, 72, maxW, 3, 44);
    ctx.fillStyle = K.tx; ctx.font = fDisplay(f.size);
    let y = 290 + (1 - a) * 30;
    y += text(ctx, f.lines, x, y, f.size, 1.12) + 50;
    ctx.globalAlpha = 1;
    const items = sc.visual.slice(0, 3);
    items.forEach((it, i) => {
      const p = vin(t, stagger(i, items.length, v.speech, 1.4), 0.6);
      if (p <= 0) return;
      ctx.globalAlpha = p;
      ctx.font = fBody(500)(40);
      const lines = wrap(ctx, it, maxW - 50).slice(0, 2), h = lines.length * 40 * 1.28;
      ctx.fillStyle = acc; ctx.beginPath(); ctx.arc(x + 10, y + 24, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = K.tx; text(ctx, lines, x + 44 + (1 - p) * 30, y, 40, 1.28);
      y += h + 30;
    });
    ctx.globalAlpha = 1;
  },

  verse(ctx, sc, t, acc, v) {
    const a = vin(t, 0.1, 0.8);
    ctx.globalAlpha = a;
    kicker(ctx, 'Verse ' + sc.ref, W / 2, 150, acc, 'center');
    if (sc.key) { ctx.font = fLabel(22); const s = 'KEY VERSE', w = ctx.measureText(s).width + 36; chip(ctx, s, W / 2 - w / 2, 200, acc); }
    // The verse exactly as the book prints it, word by word: lit up to the
    // word being read, dim ahead of it; all lit once read.
    const toks = sc.verse.split(/\s+/).filter(Boolean);
    let size = 64, lines;
    for (; size >= 34; size -= 4) { ctx.font = fVerse(size); lines = layoutTokens(ctx, toks, 1480); if (lines.length * size * 1.42 <= 620) break; }
    ctx.font = fVerse(size);
    const lh = size * 1.42, y0 = 300 + (620 - lines.length * lh) / 2 + (1 - a) * 20;
    const lit = v.lit;   // index into toks of the word being read, or -1 / Infinity
    ctx.fillStyle = acc; ctx.globalAlpha = a * 0.5;
    ctx.font = '700 220px Lora, Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('“', 240, y0 - 130);
    ctx.font = fVerse(size); ctx.textAlign = 'left';
    lines.forEach((ln, li) => {
      let x = W / 2 - ln.w / 2;
      for (const k of ln.k) {
        const w = toks[k];
        const read = k <= lit;
        ctx.globalAlpha = a * (lit < 0 ? 0.72 : read ? 1 : 0.38);
        ctx.fillStyle = k === lit ? acc : K.tx;
        ctx.fillText(w, x, y0 + li * lh);
        x += ctx.measureText(w + ' ').width;
      }
    });
    ctx.globalAlpha = 1;
  },

  compare(ctx, sc, t, acc, v) {
    const top = heading(ctx, sc, t, acc, sc.L && sc.L.length ? 'Lesson ' + sc.L[0].replace(/\D/g, '') : 'Compare') + 56;
    const rows = sc.visual.map((l) => l.split('|').map((s) => s.trim()));
    const head = rows.length > 1 ? rows[0] : ['', ''], body = (rows.length > 1 ? rows.slice(1) : rows).slice(0, 4);
    const colW = 720, gap = 100, x0 = (W - colW * 2 - gap) / 2, Hh = Math.max(340, H - top - 230);
    [0, 1].forEach((c) => {
      const p = vin(t, 0.4 + c * 0.25, 0.8), x = x0 + c * (colW + gap) + (1 - p) * (c ? 80 : -80), col = c ? acc : K.rose;
      ctx.globalAlpha = p;
      ctx.fillStyle = 'rgba(255,255,255,.045)'; rr(ctx, x, top, colW, Hh, 28); ctx.fill();
      ctx.fillStyle = col; rr(ctx, x, top, colW, 8, 4); ctx.fill();
      const hf = fit(ctx, head[c] || '', fDisplay, 44, colW - 80, 1, 28);
      ctx.fillStyle = col; ctx.font = fDisplay(hf.size); text(ctx, hf.lines, x + 44, top + 40, hf.size);
      let y = top + 124;
      body.forEach((r, i) => {
        const q = vin(t, stagger(i, body.length, v.speech, 1.1) + c * 0.2, 0.6);
        if (q <= 0) return;
        ctx.globalAlpha = p * q;
        ctx.font = fBody(500)(36);
        const lines = wrap(ctx, r[c] || '', colW - 120).slice(0, 2);
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x + 54, y + 20, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = K.tx; y += text(ctx, lines, x + 80, y, 36, 1.25) + 28;
      });
    });
    const vp = back(vin(t, 0.9, 0.6));
    ctx.globalAlpha = clamp(vp);
    const cx = W / 2, cy = top + Hh / 2;
    ctx.fillStyle = K.bg1; ctx.beginPath(); ctx.arc(cx, cy, 52 * vp, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.stroke();
    ctx.fillStyle = K.tx; ctx.font = fLabel(30); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('vs', cx, cy + 1);
    ctx.globalAlpha = 1;
  },

  steps(ctx, sc, t, acc, v) {
    const top = heading(ctx, sc, t, acc, sc.L && sc.L.length ? 'Lesson ' + sc.L[0].replace(/\D/g, '') : 'Step by step') + 40;
    const steps = sc.visual.slice(0, 6), n = steps.length || 1;
    const x0 = 250, x1 = W - 250, cy = Math.max(top + 150, 580);
    const xs = steps.map((_, i) => (n === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1)));
    const when = steps.map((_, i) => stagger(i, n, v.speech, 0.8));
    ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.moveTo(xs[0], cy); ctx.lineTo(xs[n - 1], cy); ctx.stroke();
    let reach = xs[0];
    for (let i = 1; i < n; i++) { const p = vin(t, when[i] - 0.5, 0.5); if (p <= 0) break; reach = xs[i - 1] + (xs[i] - xs[i - 1]) * p; }
    ctx.strokeStyle = acc; ctx.beginPath(); ctx.moveTo(xs[0], cy); ctx.lineTo(reach, cy); ctx.stroke();
    steps.forEach((s, i) => {
      const p = back(vin(t, when[i], 0.55));
      if (p <= 0) return;
      ctx.globalAlpha = clamp(p);
      ctx.fillStyle = K.bg1; ctx.beginPath(); ctx.arc(xs[i], cy, 46 * p, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = acc; ctx.stroke();
      ctx.fillStyle = K.tx; ctx.font = fDisplay(38); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), xs[i], cy + 2);
      const w = n === 1 ? 900 : Math.min(400, ((x1 - x0) / (n - 1)) - 24);
      const f = fit(ctx, s, fBody(600), 36, w, 3, 24);
      ctx.fillStyle = K.tx; ctx.font = fBody(600)(f.size);
      text(ctx, f.lines, xs[i], cy + 86 + (1 - clamp(p)) * 20, f.size, 1.25, 'center');
    });
    ctx.globalAlpha = 1;
  },

  closing(ctx, sc, t, acc, v) {
    const a = vin(t, 0.1, 0.9);
    ctx.globalAlpha = a;
    kicker(ctx, 'Chapter ' + v.meta.n + ' · Summary', W / 2, 180, acc, 'center');
    const f = fit(ctx, sc.headline, fDisplay, 92, 1500, 2, 52);
    ctx.fillStyle = K.tx; ctx.font = fDisplay(f.size);
    const h = text(ctx, f.lines, W / 2, 240 + (1 - a) * 30, f.size, 1.1, 'center');
    let y = 240 + h + 64;
    const items = sc.visual.slice(0, 3);
    items.forEach((it, i) => {
      const p = vin(t, stagger(i, items.length, v.speech, 1.2), 0.6);
      if (p <= 0) return;
      ctx.globalAlpha = p;
      ctx.font = fBody(500)(42);
      const lines = wrap(ctx, it, 1200).slice(0, 2), bh = lines.length * 42 * 1.25 + 40;
      const bw = Math.min(1400, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 160), x = W / 2 - bw / 2;
      ctx.fillStyle = 'rgba(255,255,255,.05)'; rr(ctx, x, y + (1 - p) * 20, bw, bh, 22); ctx.fill();
      ctx.strokeStyle = acc; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const cx = x + 56, cy = y + bh / 2 + (1 - p) * 20;
      ctx.beginPath(); ctx.moveTo(cx - 14, cy); ctx.lineTo(cx - 3, cy + 11); ctx.lineTo(cx + 16, cy - 12); ctx.stroke();
      ctx.fillStyle = K.tx; text(ctx, lines, x + 100, y + 20 + (1 - p) * 20, 42, 1.25);
      y += bh + 24;
    });
    ctx.globalAlpha = 1;
  },
};
/** Lay tokens out in lines of at most maxW; each line {k: token indices, w}. */
function layoutTokens(ctx, toks, maxW) {
  const lines = [], sp = ctx.measureText(' ').width;
  let cur = { k: [], w: 0 };
  toks.forEach((tk, k) => {
    const w = ctx.measureText(tk).width;
    if (cur.k.length && cur.w + sp + w > maxW) { lines.push(cur); cur = { k: [], w: 0 }; }
    cur.w += (cur.k.length ? sp : 0) + w; cur.k.push(k);
  });
  if (cur.k.length) lines.push(cur);
  return lines;
}

/** Background: deep gradient and three slow orbs that drift toward the
 *  scene's colour, so the picture moves even while the text holds. */
function background(ctx, T0, acc, accPrev, mix) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, K.bg1); g.addColorStop(1, K.bg0);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  [[0.16, 0.2, 640, 0.09, 0], [0.86, 0.32, 560, 0.07, 2.1], [0.58, 0.95, 720, 0.06, 4.2]].forEach(([ox, oy, r, sp, ph], i) => {
    const x = W * ox + Math.sin(T0 * sp + ph) * 120, y = H * oy + Math.cos(T0 * sp * 1.3 + ph) * 80;
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    ctx.globalAlpha = i === 1 ? 0.22 * (1 - mix) + 0.12 : 0.26 * mix + 0.08;
    rg.addColorStop(0, i === 1 ? accPrev : acc); rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  });
  ctx.globalAlpha = 0.05; ctx.fillStyle = '#ffffff';
  const off = (T0 * 5) % 60;
  for (let x = -60 + off; x < W; x += 60) for (let y = 0; y < H; y += 60) ctx.fillRect(x, y, 2, 2);
  ctx.globalAlpha = 1;
}

/** One frame of `meta` at time T on ctx (in 1920x1080 units). opts: {cc,
 *  still (paused: show a scene's first instant fully built), layer (an
 *  offscreen context of the same size for the scene fade), lessonCount}. */
export function frame(ctx, meta, T0, opts = {}) {
  theme();
  const scenes = meta.scenes, i = sceneAt(scenes, T0), sc = scenes[i];
  const dur = sc.end - sc.start;
  let t = T0 - sc.start;
  if (opts.still && t < 0.3) t = Math.max(t, Math.min(dur - 0.45, sc.at - sc.start + (sc.words.length ? sc.words[sc.words.length - 1][0] : 0) + 0.6));
  const acc = accOf(sc);
  background(ctx, T0, acc, accOf(scenes[Math.max(0, i - 1)]), vin(t, 0, 1.2));
  const into = T0 - sc.at;   // seconds since the voice began
  let lit = -1;
  if (sc.layout === 'verse' && sc.vs) {
    const k = tokenAt(sc.cc, sc.words, into);
    const cues = sc.cc.cues, over = !cues.length || into > cues[cues.length - 1].t1;
    lit = opts.still && T0 - sc.start < 0.3 ? Infinity : k < sc.vs[0] ? -1 : k >= sc.vs[1] || over ? Infinity : k - sc.vs[0];
  }
  const v = { meta, i, lit, speech: Math.max(1, sc.end - sc.at - 0.9), lessonCount: opts.lessonCount || 0 };
  const L = opts.layer || ctx;
  if (opts.layer) L.clearRect(0, 0, W, H);
  L.save();
  try { (PAINT[sc.layout] || PAINT.story)(L, sc, t, acc, v); } catch (e) {}
  L.restore();
  if (opts.layer) {
    const fade = Math.min(vin(t, 0, 0.45), 1 - ease((t - (dur - 0.4)) / 0.4));
    ctx.globalAlpha = clamp(opts.still ? 1 : fade);
    ctx.drawImage(opts.layer.canvas, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }
  chrome(ctx, meta, i, T0, sc, t);
  if (opts.cc) caption(ctx, sc, into, acc);
}
function chrome(ctx, meta, i, T0, sc, t) {
  ctx.font = fLabel(22); ctx.fillStyle = K.txd; ctx.textBaseline = 'top';
  ctx.textAlign = 'right'; ctx.fillText(String(i + 1).padStart(2, '0') + ' / ' + String(meta.scenes.length).padStart(2, '0'), W - 80, 64);
  ctx.textAlign = 'left'; ctx.fillText(('Chapter ' + meta.n + ' · ' + meta.title).toUpperCase().slice(0, 64), 80, 64);
  // A lesson this scene teaches, when its layout does not already say so.
  if (sc.L && sc.L.length && sc.layout !== 'lesson' && sc.layout !== 'compare' && sc.layout !== 'steps') {
    ctx.globalAlpha = vin(t, 0.6, 0.6);
    ctx.font = fLabel(22);
    const s = sc.L.map((x) => 'Lesson ' + x.replace(/\D/g, '')).join(' · ');
    chip(ctx, s, W - 80 - (ctx.measureText(s).width + 36), 104, K.gold);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(0, H - 8, W, 8);
  ctx.fillStyle = accOf(sc); ctx.fillRect(0, H - 8, W * (meta.duration ? T0 / meta.duration : 0), 8);
}
/** Word-level captions: the piece being said, the word being said in colour. */
function caption(ctx, sc, into, acc) {
  const cc = sc.cc;
  if (!cc || !cc.cues.length || into < 0 || into > cc.cues[cc.cues.length - 1].t1) return;
  const k = tokenAt(cc, sc.words, into);
  // On a verse scene the verse lights on its own; captions only around it.
  if (k < 0 || (sc.vs && k >= sc.vs[0] && k < sc.vs[1])) return;
  const cue = cc.cues.find((c) => k >= c.from && k < c.to) || cc.cues[0];
  const toks = cc.toks.slice(cue.from, cue.to);
  ctx.font = fBody(600)(42);
  const lines = layoutTokens(ctx, toks, 1500);
  const lh = 56, padX = 40, padY = 18;
  const w = Math.max(...lines.map((l) => l.w)) + padX * 2, h = lines.length * lh + padY * 2;
  const x = W / 2 - w / 2, y = H - 60 - h;
  ctx.fillStyle = 'rgba(6,6,10,.72)'; rr(ctx, x, y, w, h, 18); ctx.fill();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const sp = ctx.measureText(' ').width;
  lines.forEach((ln, li) => {
    let xx = W / 2 - ln.w / 2;
    for (const j of ln.k) {
      const g = cue.from + j;
      ctx.fillStyle = g === k ? acc : '#ffffff';
      ctx.globalAlpha = g <= k ? 1 : 0.62;
      ctx.fillText(toks[j], xx, y + padY + li * lh + 4);
      xx += ctx.measureText(toks[j]).width + sp;
    }
  });
  ctx.globalAlpha = 1;
}

/* ── playback ────────────────────────────────────────────────────────────── */
export const active = (book, n) => V.book === book && V.n === n && !!V.meta;
/** Load a chapter's video (no sound yet). */
export async function load(book, n, title) {
  if (active(book, n)) return V.meta;
  const src = await sourceFor(book, n);
  if (!src) return null;
  const { url, meta } = await open(src);
  stop(true);
  Object.assign(V, { book, n, title, meta, url, scene: -1 });
  if (audio) audio.src = url;
  emit();
  return meta;
}
export async function play(at) {
  if (!V.meta || !audio) return;
  dispatchEvent(new CustomEvent('shruti:playing', { detail: { who: 'video' } }));
  if (at != null) await seek(at);
  else if (!audio.currentTime) {
    const t = Number(C.me.get('progress.' + V.book + '.ch' + V.n + '.vid.t', 0)) || 0;
    if (t > 3 && t < V.meta.duration - 5) await seek(V.meta.scenes[sceneAt(V.meta.scenes, t)].start);
  }
  audio.playbackRate = V.rec ? 1 : prefs().speed || 1;
  try { await audio.play(); V.playing = true; } catch (e) { V.playing = false; if (e && e.name !== 'AbortError') ui.toast('Tap play to start the video', true); }
  showPlayer(); tick(); emit(); mediaSession();
}
export function pause() { if (audio) audio.pause(); V.playing = false; savePos(true); emit(); paint(); if (V.view) V.view.draw(); }
export const toggle = () => (V.playing ? pause() : play());
export function seek(t) {
  return new Promise((res) => {
    const go = () => { audio.currentTime = Math.max(0, Math.min((V.meta.duration || audio.duration) - 0.05, t)); res(); };
    if (audio.readyState >= 1) go(); else audio.addEventListener('loadedmetadata', go, { once: true });
  }).then(() => { paintNow(true); });
}
export const skip = (s) => seek(now() + s);
export function stepScene(dir) {
  const sc = V.meta.scenes, t = now();
  let i = sceneAt(sc, t);
  // "Previous" from a few seconds in restarts the scene, like any player.
  if (dir < 0 && t - sc[i].start > 2) return seek(sc[i].start);
  i = Math.max(0, Math.min(sc.length - 1, i + dir));
  return seek(sc[i].start);
}
/** Close it: silent, the player gone. keep: leave the video loaded. */
export function stop(keep) {
  if (V.rec) stopExport(true);
  if (audio) audio.pause();
  if (V.playing) savePos(true);
  V.playing = false;
  if (!keep) { V.book = null; V.meta = null; }
  emit();
}
// One thing plays at a time.
addEventListener('shruti:playing', (e) => { if (e.detail.who !== 'video' && V.playing) pause(); });
if (audio) {
  audio.addEventListener('ended', () => {
    V.playing = false;
    const base = 'progress.' + V.book + '.ch' + V.n;
    C.me.set({ [base + '.modes.watch']: 1, [base + '.vid']: C.DELETE, [base + '.at']: Date.now() });
    if (V.rec) finishExport();
    emit(); paint(); if (V.view) V.view.draw();
    ui.toast('Video finished');
  });
  audio.addEventListener('pause', () => { if (V.playing && !audio.ended) { V.playing = false; emit(); paint(); } });
}
function savePos(force) {
  if (!V.meta || !audio || V.rec) return;
  if (!force && Date.now() - V.savedAt < 10000) return;
  V.savedAt = Date.now();
  const base = 'progress.' + V.book + '.ch' + V.n;
  C.me.set({ [base + '.vid']: { t: +audio.currentTime.toFixed(1) }, [base + '.at']: Date.now(), last: { book: V.book, n: V.n, at: Date.now() } }, { lazy: !force });
}
addEventListener('pagehide', () => { if (V.playing) savePos(true); });

let raf = 0;
function tick() {
  cancelAnimationFrame(raf);
  const loop = () => { if (!V.playing) return; raf = requestAnimationFrame(loop); paintNow(); savePos(false); };
  loop();
}
let lastBar = 0;
function paintNow(force) {
  if (!V.meta) return;
  const t = now(), i = sceneAt(V.meta.scenes, t);
  if (force || Date.now() - lastBar > 250) { lastBar = Date.now(); ui.player && ui.player.owner === 'video' && ui.player.progress(t / (V.meta.duration || 1)); }
  if (i !== V.scene) { V.scene = i; paint(); }
  const view = V.view;
  if (view && view.root.isConnected && view.book === V.book && view.n === V.n) view.draw();
}

/* ── mini-player and lock screen ─────────────────────────────────────────── */
function showPlayer() {
  if (!ui.player || (ui.player.owner === 'video' && document.querySelector('#mini:not([hidden])'))) { paint(); return; }
  ui.player.show({
    title: 'Chapter ' + V.n + ' · ' + V.title, kind: 'video',
    onToggle: toggle, onBack: () => stepScene(-1), onFwd: () => stepScene(1),
    onOpen: () => ui.go('#/b/' + V.book + '/' + V.n + '/watch'),
    onClose: () => { stop(); if (navigator.mediaSession) navigator.mediaSession.metadata = null; },
  });
  paint();
}
function paint() {
  if (!ui.player || ui.player.owner !== 'video' || !V.meta) return;
  ui.player.setPlaying(V.playing);
  const sc = V.meta.scenes[Math.max(0, V.scene)];
  ui.player.setSub(['Video', sc && (sc.headline || sc.ref && 'Verse ' + sc.ref), (prefs().speed || 1) + '×'].filter(Boolean).join(' · '));
}
function mediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    ms.metadata = new MediaMetadata({ title: 'Chapter ' + V.n + ': ' + V.title, artist: 'Shruti · Video · ' + ((V.meta.narrator && V.meta.narrator.name) || ''), album: V.book === 'gita' ? 'Bhagavad-Gita' : V.book });
    ms.setActionHandler('play', () => play());
    ms.setActionHandler('pause', () => pause());
    ms.setActionHandler('seekbackward', (d) => skip(-(d && d.seekOffset || 10)));
    ms.setActionHandler('seekforward', (d) => skip(d && d.seekOffset || 10));
    ms.setActionHandler('previoustrack', () => stepScene(-1));
    ms.setActionHandler('nexttrack', () => stepScene(1));
  } catch (e) {}
}

/* ── export: the canvas and the narration, recorded in real time ─────────── */
let actx = null, srcNode = null;
function audioGraph() {
  // Once the audio runs through an AudioContext it must keep doing so, so
  // this is made on the first export only (the shipped MP3s are same-origin).
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !audio) return null;
  if (!actx) { actx = new AC(); srcNode = actx.createMediaElementSource(audio); srcNode.connect(actx.destination); }
  return actx;
}
export function pickMime() {
  const MR = window.MediaRecorder;
  if (!MR) return '';
  for (const m of ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    try { if (MR.isTypeSupported(m)) return m; } catch (e) {}
  }
  return '';
}
export const canExport = () => !!(pickMime() && typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype.captureStream);
async function startExport() {
  const view = V.view, mime = pickMime();
  if (!view || !canExport()) { ui.toast('This browser cannot record video. Chrome, Edge or Brave on a computer can.', true); return; }
  pause();
  const ac = audioGraph();
  if (ac && ac.state === 'suspended') { try { await ac.resume(); } catch (e) {} }
  view.full = true; view.resize();
  const stream = view.canvas.captureStream(30);
  let dest = null;
  if (ac) { dest = ac.createMediaStreamDestination(); srcNode.connect(dest); dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr)); }
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    if (dest) try { srcNode.disconnect(dest); } catch (e) {}
    const keep = rec._keep;
    V.rec = null; view.full = false; view.resize();
    if (audio) audio.playbackRate = prefs().speed || 1;
    emit();
    if (!keep || !chunks.length) return;
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(new Blob(chunks, { type: mime.split(';')[0] }));
    const a = document.createElement('a');
    a.href = url; a.download = 'Shruti - Chapter ' + V.n + ' - ' + V.title + '.' + ext;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    view.note('Saved ' + T.fmtTime(V.meta.duration) + ' of video as .' + ext + '.');
  };
  V.rec = rec; rec._keep = true;
  view.note('Recording in real time (' + T.fmtTime(V.meta.duration) + '). Keep this tab open and visible until it finishes.');
  rec.start(1000);
  emit();
  await play(0);
}
function finishExport() { const r = V.rec; if (!r) return; r._keep = true; try { r.stop(); } catch (e) {} }
function stopExport(cancelled) {
  const r = V.rec; if (!r) return;
  r._keep = !cancelled;
  if (audio) audio.pause();
  V.playing = false;
  try { r.stop(); } catch (e) {}
  if (cancelled && V.view) V.view.note('Export cancelled.');
}

/* ── the Watch tab ───────────────────────────────────────────────────────── */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SV = (b, fill) => '<svg viewBox="0 0 24 24" ' + (fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"') + ' aria-hidden="true">' + b + '</svg>';
const I = {
  play: SV('<path d="M8 5.5v13l10.5-6.5z"/>', true),
  pause: SV('<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>', true),
  prev: SV('<path d="M6 5v14"/><path d="M18 6l-9 6 9 6z"/>'),
  next: SV('<path d="M18 5v14"/><path d="M6 6l9 6-9 6z"/>'),
  cc: SV('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10.5a2 2 0 1 0 0 3M16 10.5a2 2 0 1 0 0 3"/>'),
  full: SV('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  shrink: SV('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  rec: SV('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>'),
  close: SV('<path d="M6 6l12 12M18 6L6 18"/>'),
};
const LAYOUT_NAME = { title: 'Title', verse: 'Verse', story: 'Story', lesson: 'Lesson', compare: 'Compare', steps: 'Steps', closing: 'Summary' };

export async function renderWatch(body, { book, n, title, lessons }) {
  body.innerHTML = '<div class="pod-loading">Loading the video…</div>';
  let meta;
  try { meta = await load(book, n, title); } catch (e) { body.innerHTML = '<div class="empty"><b>The video could not be opened</b><span>' + esc(e.message || e) + '</span></div>'; return; }
  if (!meta) return false;
  theme();
  const Ls = (lessons && lessons.lessons) || [];
  const cov = coverage(meta, Ls.map((l) => l.id));
  const firstSceneOf = (id) => meta.scenes.findIndex((s) => (s.L || []).includes(id));
  body.innerHTML =
    '<div class="vid">' +
      '<div class="vid-stage" tabindex="0" aria-label="Video. Space plays and pauses, arrows change scene, F is full screen, C is captions.">' +
        '<canvas width="1280" height="720"></canvas>' +
        '<button class="vid-cover" data-cover aria-label="Play the video">' + '<span class="vc-ic">' + I.play + '</span>' +
          '<b>Watch chapter ' + n + '</b><span>' + T.fmtTime(meta.duration) + ' · ' + meta.scenes.length + ' scenes · all ' + Ls.length + ' lessons</span></button>' +
        '<div class="vid-ov"><button class="ib" data-ov-play aria-label="Play">' + I.play + '</button><span class="vid-ov-t"></span><span class="sp"></span>' +
          '<button class="ib" data-ov-cc aria-label="Captions">' + I.cc + '</button><button class="ib" data-ov-fs aria-label="Exit full screen">' + I.shrink + '</button></div>' +
        '<div class="vid-recb" hidden>● REC</div>' +
      '</div>' +
      '<div class="vid-bar">' +
        '<button class="ib" data-prev aria-label="Previous scene" title="Previous scene">' + I.prev + '</button>' +
        '<button class="btn solid vid-play" data-play aria-label="Play">' + I.play + '</button>' +
        '<button class="ib" data-next aria-label="Next scene" title="Next scene">' + I.next + '</button>' +
        '<div class="vid-track" data-track role="slider" aria-label="Position" aria-valuemin="0" aria-valuemax="' + Math.round(meta.duration) + '" tabindex="0">' +
          '<div class="vid-ticks">' + meta.scenes.map((s) => '<i class="' + (s.L && s.L.length ? 'l' : s.layout === 'verse' ? 'v' : '') + '" style="left:' + (100 * s.start / meta.duration).toFixed(3) + '%"></i>').join('') + '</div>' +
          '<div class="vid-fill"></div><div class="vid-knob"></div></div>' +
        '<span class="vid-time"><b>0:00</b> / ' + T.fmtTime(meta.duration) + '</span>' +
      '</div>' +
      '<div class="pod-tools vid-tools">' +
        '<div class="chips pod-speed" role="radiogroup" aria-label="Speed">' + SPEEDS.map((s) => '<button class="chip" data-speed="' + s + '" role="radio">' + s + '×</button>').join('') + '</div>' +
        '<span class="sp"></span>' +
        '<button class="ib" data-cc title="Captions" aria-label="Captions" aria-pressed="true">' + I.cc + '</button>' +
        '<button class="ib" data-export title="Export the video as a file" aria-label="Export the video as a file">' + I.rec + '</button>' +
        '<button class="ib" data-fs title="Full screen" aria-label="Full screen">' + I.full + '</button>' +
      '</div>' +
      '<div class="vid-note" hidden></div>' +
      '<div class="sec-h"><h2>Scenes</h2><span class="n">' + meta.scenes.length + '</span></div>' +
      '<div class="vid-board">' + meta.scenes.map((s, i) =>
        '<button class="vsc ' + s.layout + '" data-scene="' + i + '">' +
          '<span class="vsc-h"><i>' + String(i + 1).padStart(2, '0') + '</i><span>' + esc(LAYOUT_NAME[s.layout] || s.layout) + (s.beyond ? ' · beyond the book' : '') + '</span><time>' + T.fmtTime(s.start) + '</time></span>' +
          '<b>' + esc(s.layout === 'verse' ? 'Verse ' + s.ref : s.headline) + '</b>' +
          ((s.L || []).length ? '<span class="vsc-l">' + s.L.map((id) => '<i class="ltag">' + esc(id) + '</i>').join('') + '</span>' : '') +
        '</button>').join('') + '</div>' +
      '<section class="pod-cov"><h3>Lessons in this video <span class="' + (cov.missing.length ? 'bad' : 'good') + '">' + cov.covered.length + ' of ' + Ls.length + '</span></h3>' +
        '<div class="pod-ls">' + Ls.map((l) => '<button class="pl" data-lesson="' + esc(l.id) + '"' + (firstSceneOf(l.id) < 0 ? ' disabled' : '') + '><i>' + esc(l.id) + '</i><span>' + esc(l.title || '') + '</span></button>').join('') + '</div></section>' +
    '</div>';
  const root = body.querySelector('.vid'), stage = root.querySelector('.vid-stage'), canvas = stage.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const layerCv = document.createElement('canvas'), lctx = layerCv.getContext('2d');
  const sceneEls = [...root.querySelectorAll('.vsc')];
  const noteEl = root.querySelector('.vid-note');
  let litScene = -1, scale = 1;

  const view = {
    book, n, root, canvas, full: false,
    resize() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const want = view.full ? W : Math.max(640, Math.min(W, Math.round((r.width || 960) * dpr)));
      if (canvas.width !== want) { canvas.width = want; canvas.height = Math.round(want * 9 / 16); layerCv.width = canvas.width; layerCv.height = canvas.height; }
      scale = canvas.width / W;
      view.draw();
    },
    draw() {
      const t = active(book, n) ? now() : 0;
      ctx.setTransform(scale, 0, 0, scale, 0, 0); lctx.setTransform(scale, 0, 0, scale, 0, 0);
      frame(ctx, meta, t, { cc: prefs().cc, still: !V.playing, layer: lctx, lessonCount: Ls.length });
      paintBar(t);
    },
    note(s) { noteEl.textContent = s || ''; noteEl.hidden = !s; },
  };
  V.view = view;
  const fill = root.querySelector('.vid-fill'), knob = root.querySelector('.vid-knob'), timeEl = root.querySelector('.vid-time b'), ovT = root.querySelector('.vid-ov-t');
  function paintBar(t) {
    const f = (100 * t / meta.duration).toFixed(3) + '%';
    fill.style.width = f; knob.style.left = f;
    timeEl.textContent = T.fmtTime(t); ovT.textContent = T.fmtTime(t) + ' / ' + T.fmtTime(meta.duration);
    const i = sceneAt(meta.scenes, t);
    if (i !== litScene) {
      if (sceneEls[litScene]) sceneEls[litScene].classList.remove('on');
      litScene = i;
      if (sceneEls[i]) { sceneEls[i].classList.add('on'); if (V.playing && !document.fullscreenElement && !stage.classList.contains('pfs')) keepInRow(sceneEls[i]); }
    }
  }
  function keepInRow(el) {
    const row = el.parentElement, r = el.getBoundingClientRect(), rr2 = row.getBoundingClientRect();
    if (row.scrollWidth > row.clientWidth + 4 && (r.left < rr2.left || r.right > rr2.right)) row.scrollTo({ left: el.offsetLeft - 24, behavior: 'smooth' });
  }

  const playBtn = root.querySelector('[data-play]'), ovPlay = root.querySelector('[data-ov-play]'), cover = root.querySelector('[data-cover]');
  const paintTab = () => {
    if (!root.isConnected) return;
    const on = active(book, n) && V.playing;
    playBtn.innerHTML = on ? I.pause : I.play; playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    ovPlay.innerHTML = on ? I.pause : I.play; ovPlay.setAttribute('aria-label', on ? 'Pause' : 'Play');
    cover.hidden = on || (active(book, n) && now() > 0.05) || !!V.rec;
    stage.classList.toggle('playing', on);
    const sp = prefs().speed || 1;
    root.querySelectorAll('[data-speed]').forEach((b) => { const o = Number(b.dataset.speed) === sp; b.classList.toggle('on', o); b.setAttribute('aria-checked', o); b.disabled = !!V.rec; });
    const cc = !!prefs().cc;
    root.querySelectorAll('[data-cc],[data-ov-cc]').forEach((b) => { b.classList.toggle('on', cc); b.setAttribute('aria-pressed', cc); });
    const ex = root.querySelector('[data-export]');
    ex.classList.toggle('on', !!V.rec); ex.title = V.rec ? 'Stop the export' : canExport() ? 'Export the video as a file' : 'This browser cannot record video';
    ex.disabled = !V.rec && !canExport();
    root.querySelector('.vid-recb').hidden = !V.rec;
    [playBtn, root.querySelector('[data-prev]'), root.querySelector('[data-next]')].forEach((b) => { b.disabled = !!V.rec; });
  };
  const off = onChange(() => { if (!root.isConnected) { off(); if (V.view === view) V.view = null; return; } paintTab(); });
  paintTab();

  const toggleHere = async () => { if (V.rec) return; if (!active(book, n)) await load(book, n, title); toggle(); };
  playBtn.addEventListener('click', toggleHere);
  ovPlay.addEventListener('click', (e) => { e.stopPropagation(); toggleHere(); });
  cover.addEventListener('click', (e) => { e.stopPropagation(); toggleHere(); });
  // Full screen on a phone: a tap first shows the controls, a second pauses.
  canvas.addEventListener('click', () => {
    if (isFs() && V.playing && !stage.classList.contains('awake')) { wake(); return; }
    wake(); toggleHere();
  });
  root.querySelector('[data-prev]').addEventListener('click', () => !V.rec && stepScene(-1));
  root.querySelector('[data-next]').addEventListener('click', () => !V.rec && stepScene(1));
  root.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setPref('speed', Number(b.dataset.speed))));
  root.querySelectorAll('[data-cc],[data-ov-cc]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setPref('cc', !prefs().cc); }));
  root.querySelector('[data-export]').addEventListener('click', () => (V.rec ? stopExport(true) : startExport()));
  root.querySelectorAll('[data-scene]').forEach((b) => b.addEventListener('click', () => { if (V.rec) return; const s = meta.scenes[Number(b.dataset.scene)]; V.playing ? play(s.start) : seek(s.start); }));
  root.querySelectorAll('[data-lesson]').forEach((b) => b.addEventListener('click', () => { const i = firstSceneOf(b.dataset.lesson); if (i >= 0 && !V.rec) { play(meta.scenes[i].start); stage.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }));

  // Scrubbing: press and drag along the bar.
  const track = root.querySelector('[data-track]');
  const atX = (x) => { const r = track.getBoundingClientRect(); return clamp((x - r.left) / r.width) * meta.duration; };
  track.addEventListener('pointerdown', (e) => {
    if (V.rec) return;
    track.setPointerCapture(e.pointerId);
    const was = V.playing;
    if (was) { audio.pause(); }
    seek(atX(e.clientX));
    const move = (ev) => seek(atX(ev.clientX));
    const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); track.removeEventListener('pointercancel', up); if (was) play(); else view.draw(); };
    track.addEventListener('pointermove', move); track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up);
  });
  track.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); skip(e.key === 'ArrowLeft' ? -5 : 5); } });

  // Full screen: the real thing where the browser has it (and landscape on a
  // phone), else the stage fills the window, the picture turned sideways
  // when the phone is upright.
  const fsBtn = root.querySelector('[data-fs]');
  const isFs = () => document.fullscreenElement === stage || document.webkitFullscreenElement === stage || stage.classList.contains('pfs');
  async function enterFs() {
    const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
    if (req) {
      try { await req.call(stage, { navigationUI: 'hide' }); } catch (e) { stage.classList.add('pfs'); }
      try { if (matchMedia('(pointer: coarse)').matches && screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) {}
    } else stage.classList.add('pfs');
    document.documentElement.classList.toggle('vid-pfs', stage.classList.contains('pfs'));
    wake(); setTimeout(() => view.resize(), 120);
  }
  function exitFs() {
    if (stage.classList.contains('pfs')) { stage.classList.remove('pfs'); document.documentElement.classList.remove('vid-pfs'); }
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
    try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (e) {}
    setTimeout(() => view.resize(), 120);
  }
  const toggleFs = () => (isFs() ? exitFs() : enterFs());
  fsBtn.addEventListener('click', toggleFs);
  root.querySelector('[data-ov-fs]').addEventListener('click', (e) => { e.stopPropagation(); exitFs(); });
  // Real full screen on a phone that stays upright (the rotation lock is on,
  // or the browser will not turn): the picture turns sideways instead.
  const orient = () => stage.classList.toggle('rot', (document.fullscreenElement === stage || document.webkitFullscreenElement === stage) && matchMedia('(orientation: portrait)').matches && matchMedia('(pointer: coarse)').matches);
  const onFs = () => { const on = isFs(); stage.classList.toggle('fs', on); orient(); fsBtn.innerHTML = on ? I.shrink : I.full; if (!root.isConnected) { document.removeEventListener('fullscreenchange', onFs); return; } setTimeout(() => view.resize(), 80); };
  addEventListener('resize', () => { if (root.isConnected) orient(); });
  document.addEventListener('fullscreenchange', onFs);
  document.addEventListener('webkitfullscreenchange', onFs);
  // The overlay controls show on a touch or a move, and while paused.
  let sleepT = 0;
  function wake() { stage.classList.add('awake'); clearTimeout(sleepT); sleepT = setTimeout(() => stage.classList.remove('awake'), 2600); }
  stage.addEventListener('pointermove', wake);

  // Keys, while this tab is on screen (Space is the shell's: app.js).
  const onKey = (e) => {
    if (!root.isConnected) { removeEventListener('keydown', onKey); return; }
    const tg = e.target && e.target.closest ? e.target : document.body;
    if (tg.closest('input,textarea,select,[contenteditable],.sheet,.sheet-dim') || V.rec || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowRight' && !tg.closest('[data-track]')) stepScene(1);
    else if (e.key === 'ArrowLeft' && !tg.closest('[data-track]')) stepScene(-1);
    else if (e.key === 'f' || e.key === 'F') toggleFs();
    else if (e.key === 'c' || e.key === 'C') setPref('cc', !prefs().cc);
    else if (e.key === 'Escape' && stage.classList.contains('pfs')) exitFs();
    else return;
    e.preventDefault();
  };
  addEventListener('keydown', onKey);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (!root.isConnected) { ro.disconnect(); return; } view.resize(); }) : null;
  if (ro) ro.observe(stage);

  // The first frame goes up at once; again when the typefaces arrive.
  view.resize();
  if (document.fonts && document.fonts.load) Promise.all([fDisplay(80), fBody(500)(40), fBody(600)(40), fVerse(60), fLabel(26)].map((f) => document.fonts.load(f))).catch(() => {}).then(() => view.draw());
  return true;
}

/* ── a video made in the browser (Phase 6) ─────────────────────────────── */
/** Upload a built video to Drive and keep it as a new version, playing it. */
export async function save(book, n, { mp3, meta }, extra = {}) {
  const up = (body, type, name) => M.upload({ book, n, body, type, name });
  const clean = Object.assign({}, meta, { scenes: meta.scenes.map((s) => { const c = Object.assign({}, s); delete c.cc; return c; }) });
  const rec = Object.assign({ narrator: meta.narrator && meta.narrator.name, voices: [meta.narrator && meta.narrator.voice], duration: meta.duration, scenes: meta.scenes.length, mp3: await up(mp3, 'audio/mpeg', 'video.mp3'), json: await up(JSON.stringify(clean), 'application/json', 'video.json') }, extra);
  rec.id = M.record(book, n, 'video', rec);
  return rec;
}
