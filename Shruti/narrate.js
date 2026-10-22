// Read-aloud: the chapter spoken in a neural voice, the word being said lit on
// the page, the page following the voice.
//
// One narrator per page. It keeps playing while the person moves around
// Shruti (the mini-player stays), and attaches to the reader whenever that
// chapter's text is on screen. Two sources:
//   live  - each segment (a block, or part of a long one) spoken by Orca
//           (POST /v1/audio/speech, the person's key), fetched two ahead;
//   file  - one ready-made MP3 with its timings: shipped in the repo
//           (books/<book>/media/) or saved to Drive by "Save narration".
// A ready-made narration in the chosen voice is used first; it needs no key.
// Speed is the player's own (playbackRate, pitch kept), so it never asks
// Orca again.

import * as C from './core.js';
import * as O from './orca.js';
import * as T from './text.js';
import * as M from './media.js';

const DRIVE = M.DRIVE;
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
export const SLEEPS = [0, 5, 10, 15, 30, 45, 60];
const ACCENT = { 'en-US': 'American', 'en-GB': 'British', 'en-AU': 'Australian', 'en-IN': 'Indian', 'en-IE': 'Irish', 'en-CA': 'Canadian' };

let ui = { player: null, toast: () => {}, openSettings: () => {}, go: () => {} };
export function setUI(x) { ui = Object.assign(ui, x); }

const audio = typeof Audio === 'function' ? new Audio() : null;
if (audio) { audio.preload = 'auto'; audio.preservesPitch = true; audio.mozPreservesPitch = true; audio.webkitPreservesPitch = true; }

const N = {
  book: null, n: null, title: '', ch: null,
  segs: [], i: 0, mode: null,          // mode: 'live' | 'file'
  file: null,                          // {url, segs:[{b, part, start, dur, words}], voice, duration}
  cache: new Map(),                    // live: i -> Promise<{url, words, dur}>
  playing: false, voice: null,
  view: null, maps: new Map(), lit: null, litBlock: null,
  follow: true, away: false,
  sleepUntil: 0, raf: 0, savedAt: 0, ended: false,
};
export const state = N;
const listeners = new Set();
export function onChange(f) { listeners.add(f); return () => listeners.delete(f); }
const emit = () => listeners.forEach((f) => { try { f(N); } catch (e) {} });

/* ── settings (per person, every device) ─────────────────────────────────── */
export const prefs = () => Object.assign({ voice: O.DEFAULT_VOICE, speed: 1, follow: true }, C.me.get('narration', {}) || {});
export function setPref(k, v) {
  C.me.set({ ['narration.' + k]: v });
  if (k === 'speed' && audio) audio.playbackRate = v;
  if (k === 'follow') N.follow = !!v;
  emit();
}
const keyOf = () => String(C.me.get('orcaKey', '') || '');

/* ── ready-made narrations ───────────────────────────────────────────────── */
const shippedIndex = new Map();
function shipped(book) {
  if (!C.isShipped(book)) return Promise.resolve({});
  if (!shippedIndex.has(book)) shippedIndex.set(book, fetch('books/' + book + '/media/index.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  return shippedIndex.get(book);
}
/** What exists for a chapter: [{where:'shipped'|'drive', voice, mp3, json}] */
export async function readyFor(book, n) {
  const out = [];
  const idx = await shipped(book);
  const s = idx && idx[String(n)];
  if (s) out.push({ where: 'shipped', voice: s.voice, mp3: 'books/' + book + '/media/' + s.mp3, json: 'books/' + book + '/media/' + s.json, duration: s.duration });
  const a = M.docFor(book).get('assets.' + book + '.ch' + n + '.read', null);
  if (a && a.mp3 && a.json) out.push({ where: 'drive', voice: a.voice, mp3: a.mp3, json: a.json, duration: a.duration, by: a.by, at: a.at });
  return out;
}
async function openReady(r) {
  let mp3 = r.mp3, json = r.json;
  if (r.where === 'drive') ({ mp3, json } = await M.links({ mp3: r.mp3, json: r.json }));
  const meta = await (await fetch(json)).json();
  return { url: mp3, segs: meta.segs, voice: meta.voice, duration: meta.duration, where: r.where };
}

/* ── loading a chapter ───────────────────────────────────────────────────── */
function reset() {
  if (audio) { audio.pause(); audio.removeAttribute('src'); try { audio.load(); } catch (e) {} }
  for (const p of N.cache.values()) p.then((d) => URL.revokeObjectURL(d.url)).catch(() => {});
  N.cache.clear(); N.maps.clear(); unlight();
  N.playing = false; N.ended = false; N.file = null; N.mode = null; N.i = 0;
}
export const active = (book, n) => N.book === book && N.n === n && N.mode != null;

/** Start (or resume) reading a chapter aloud. from: {b, word} or 'resume'. */
export async function start({ book, n, ch, title, from }) {
  unlockAudio();
  if (!active(book, n)) {
    reset();
    Object.assign(N, { book, n, ch, title, segs: T.segmentsFor(ch) });
    N.follow = prefs().follow !== false;
    const want = prefs().voice;
    const ready = await readyFor(book, n);
    const same = ready.find((r) => r.voice === want);
    const pick = same || (!keyOf() ? ready[0] : null);
    if (pick) {
      try {
        N.file = await openReady(pick);
        N.mode = 'file';
        N.voice = N.file.voice;
        if (!same) ui.toast('Playing the ready-made narration (' + voiceName(N.voice) + '). Add your Orca key in Settings for other voices.');
      } catch (e) { N.file = null; if (!keyOf()) { ui.toast(e.message || String(e), true); return false; } }
    }
    if (!N.mode) {
      if (!keyOf()) { needKey(); return false; }
      N.mode = 'live';
      N.voice = want;
    }
    if (audio && N.mode === 'file') audio.src = N.file.url;
  }
  let i = 0, t = 0;
  if (from && from.b != null) {
    ({ i, t } = await locate(from.b, from.word || 0));
  } else {
    const ra = C.me.get('progress.' + book + '.ch' + n + '.ra', null);
    if (ra && ra.i > 0 && ra.i < N.segs.length) { i = ra.i; t = Math.max(0, (ra.t || 0) - 2); }
  }
  showPlayer();
  await seek(i, t, true);
  return true;
}

/** No key, or (rejected) a key Orca refused: one dialog that leads to Settings. */
function needKey(rejected) {
  const p = rejected ? O.explain({ code: 'key' }) : { title: 'Read-aloud needs your Orca key', text: 'Read-aloud uses Orca\'s neural voices with your own Orca key. Paste it once in Settings and it works on all your devices.' };
  if (rejected) O.forget();
  window.uiConfirm(p.text, { title: p.title, okLabel: 'Open Settings' })
    .then((go) => { if (go) ui.openSettings(); });
}
export const voiceName = (id) => { const v = O.VOICES.find((x) => x.id === id); return v ? v.name : String(id || '').replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace(/(Multilingual)?Neural$/, ''); };

/* ── segments ────────────────────────────────────────────────────────────── */
const segList = () => (N.mode === 'file' ? N.file.segs : N.segs);
function load(i) {
  if (N.mode === 'file') { const s = N.file.segs[i]; return Promise.resolve(s ? { words: s.words, dur: s.dur } : null); }
  if (i < 0 || i >= N.segs.length) return Promise.resolve(null);
  if (!N.cache.has(i)) {
    const seg = N.segs[i], voice = N.voice;
    const p = O.speak({ key: keyOf(), text: seg.text, voice }).then((r) => ({ url: URL.createObjectURL(r.audio), words: r.words, engine: r.engine, dur: null, text: seg.text }));
    p.catch(() => N.cache.delete(i));
    N.cache.set(i, p);
  }
  return N.cache.get(i);
}
function prefetch(i) {
  if (N.mode !== 'live') return;
  for (let k = i + 1; k <= i + 2 && k < N.segs.length; k++) load(k).catch(() => {});
  // Keep memory flat on a long chapter: drop audio well behind us.
  for (const k of N.cache.keys()) if (k < i - 2) { N.cache.get(k).then((d) => URL.revokeObjectURL(d.url)).catch(() => {}); N.cache.delete(k); }
}
/** Which segment and time a page word (block b, word index in the block) is in. */
async function locate(b, word) {
  const list = segList();
  let i = list.findIndex((s) => s.b === b);
  if (i < 0) { i = list.findIndex((s) => s.b > b); if (i < 0) i = 0; return { i, t: 0 }; }
  // The part of the block holding that word.
  let off = 0;
  for (let k = i; k < list.length && list[k].b === b; k++) {
    const nw = T.words(textOf(k)).length;
    if (word < off + nw || k + 1 >= list.length || list[k + 1].b !== b) { i = k; break; }
    off += nw;
  }
  const d = await load(i).catch(() => null);
  if (!d || !d.words || word <= off) return { i, t: 0 };
  const map = T.align(d.words.map((w) => w[2]), T.words(textOf(i)));
  const k = map.findIndex((m) => m >= word - off);
  return { i, t: k > 0 ? Math.max(0, d.words[k][0] - 0.05) : 0 };
}
const textOf = (i) => { const s = segList()[i]; return s.text != null ? s.text : T.blockTextPart(N.ch, s); };

/** Go to segment i at t seconds into it, and play. */
let seekSeq = 0;
async function seek(i, t = 0, play = true) {
  const seq = ++seekSeq, list = segList();
  i = Math.max(0, Math.min(list.length - 1, i));
  N.i = i; N.ended = false;
  unlight();
  if (N.mode === 'file') {
    const at = (list[i].start || 0) + t;
    if (audio.readyState >= 1) audio.currentTime = at;
    else audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; }, { once: true });
  } else {
    let d;
    setBusy(true);
    try { d = await load(i); } catch (e) { setBusy(false); return fail(e); }
    setBusy(false);
    if (seq !== seekSeq) return;
    if (audio.src !== d.url) audio.src = d.url;
    if (t) { if (audio.readyState >= 1) audio.currentTime = t; else audio.addEventListener('loadedmetadata', () => { audio.currentTime = t; }, { once: true }); }
    prefetch(i);
  }
  audio.playbackRate = prefs().speed || 1;
  if (play) await resume();
  emit(); paintPlayer();
}
function fail(e) {
  pause();
  if (e && e.code === 'key') { needKey(true); return; }
  ui.toast('Read-aloud stopped: ' + (e && e.message || e), true);
}
export async function resume() {
  if (!N.mode) return;
  if (N.ended) { await seek(0, 0, true); return; }
  // One thing plays at a time: an episode playing pauses for the voice.
  dispatchEvent(new CustomEvent('shruti:playing', { detail: { who: 'read' } }));
  if (!mine()) showPlayer();
  try { await audio.play(); N.playing = true; } catch (e) { N.playing = false; if (e && e.name !== 'AbortError') ui.toast('Tap play to start read-aloud', true); }
  tick(); emit(); paintPlayer(); mediaSession();
}
export function pause() { if (audio) audio.pause(); N.playing = false; savePos(true); emit(); paintPlayer(); }
addEventListener('shruti:playing', (e) => { if (e.detail.who !== 'read' && N.playing) pause(); });
export const toggle = () => (N.playing ? pause() : resume());

if (audio) {
  audio.addEventListener('ended', () => {
    if (N.mode === 'live' && N.i < N.segs.length - 1) { seek(N.i + 1, 0, true); return; }
    finish();
  });
  audio.addEventListener('pause', () => { if (N.playing && !audio.ended) { N.playing = false; emit(); paintPlayer(); } });
  audio.addEventListener('play', () => { if (!N.playing) { N.playing = true; tick(); emit(); paintPlayer(); } });
  audio.addEventListener('loadedmetadata', () => {
    if (N.mode !== 'live') return;
    // Aura gives no timings: spread the words over the audio by length.
    N.cache.get(N.i)?.then((d) => { if (d && !d.words && isFinite(audio.duration)) d.words = T.spreadWords(d.text, audio.duration); if (d) d.dur = audio.duration; });
  });
}
function finish() {
  N.playing = false; N.ended = true; unlight();
  const base = 'progress.' + N.book + '.ch' + N.n;
  C.me.set({ [base + '.ra']: C.DELETE, [base + '.f']: 1, [base + '.done']: true, [base + '.modes.read']: 1, [base + '.at']: Date.now() });
  emit(); paintPlayer();
  ui.toast('Finished reading chapter ' + N.n + ' aloud');
}

/* ── time within the chapter ─────────────────────────────────────────────── */
function local() {
  if (!audio) return 0;
  if (N.mode === 'file') {
    const t = audio.currentTime, list = N.file.segs;
    let i = N.i;
    while (i + 1 < list.length && list[i + 1].start <= t + 0.01) i++;
    while (i > 0 && list[i].start > t) i--;
    if (i !== N.i) { N.i = i; unlight(); emit(); }
    return t - list[i].start;
  }
  return audio.currentTime;
}
export function skip(sec) {
  if (!N.mode) return;
  if (N.mode === 'file') { audio.currentTime = Math.max(0, Math.min((N.file.duration || audio.duration) - 0.2, audio.currentTime + sec)); return; }
  const t = audio.currentTime + sec, dur = audio.duration || 0;
  if (t < 0) {
    if (N.i === 0) { audio.currentTime = 0; return; }
    load(N.i - 1).then((d) => seek(N.i - 1, Math.max(0, (d && d.dur || 0) + t), N.playing));
  } else if (dur && t > dur - 0.1) {
    if (N.i < N.segs.length - 1) seek(N.i + 1, Math.min(t - dur, 5), N.playing);
  } else audio.currentTime = t;
}
export function step(dir) { const i = N.i + dir; if (i >= 0 && i < segList().length) seek(i, 0, N.playing); }
export async function playFrom(b, word) { if (!N.mode) return; const { i, t } = await locate(b, word); await seek(i, t, true); }

/** 0..1 through the chapter. */
export function fraction() {
  if (!N.mode || !audio) return 0;
  if (N.mode === 'file') return (audio.currentTime || 0) / (N.file.duration || audio.duration || 1);
  return (N.i + (audio.duration ? (audio.currentTime / audio.duration) : 0)) / Math.max(1, N.segs.length);
}

/* ── the word on the page ────────────────────────────────────────────────── */
export function attach(view) { N.view = view; N.maps.clear(); unlight(); if (N.playing) tick(); }
function viewOk() { return N.view && N.view.art && N.view.art.isConnected && N.view.book === N.book && N.view.n === N.n; }
function unlight() {
  if (N.lit) N.lit.classList.remove('on');
  if (N.litBlock) N.litBlock.classList.remove('speaking');
  N.lit = N.litBlock = null;
}
function pageMap(i, d) {
  if (N.maps.has(i)) return N.maps.get(i);
  const seg = segList()[i], blk = N.view.wrap(seg.b);
  if (!blk) return null;
  // Words of earlier parts of the same block come first on the page.
  let off = 0;
  for (let k = i - 1; k >= 0 && segList()[k].b === seg.b; k--) off += T.words(textOf(k)).length;
  const from = Math.max(0, off - 3);
  const page = blk.spans.slice(from).map((s) => s.textContent);
  const map = T.align(d.words.map((w) => w[2]), page, off ? 12 : 6).map((m) => (m < 0 ? -1 : m + from));
  const out = { map, blk };
  N.maps.set(i, out);
  return out;
}
function tick() {
  cancelAnimationFrame(N.raf);
  const loop = () => {
    if (!N.playing) return;
    N.raf = requestAnimationFrame(loop);
    const t = local();
    if (N.sleepUntil && Date.now() >= N.sleepUntil) { N.sleepUntil = 0; pause(); ui.toast('Sleep timer: read-aloud paused'); return; }
    paintProgress();
    savePos(false);
    if (!viewOk()) return;
    const i = N.i;
    const cached = N.mode === 'file' ? { words: N.file.segs[i].words } : null;
    const go = (d) => {
      if (!d || !d.words || !d.words.length) return;
      const pm = pageMap(i, d);
      if (!pm) return;
      if (N.litBlock !== pm.blk.el) { if (N.litBlock) N.litBlock.classList.remove('speaking'); N.litBlock = pm.blk.el; N.litBlock.classList.add('speaking'); }
      const k = T.wordAt(d.words, t);
      const idx = k >= 0 ? pm.map[k] : -1;
      const span = idx >= 0 ? pm.blk.spans[idx] : null;
      if (span && span !== N.lit) {
        if (N.lit) N.lit.classList.remove('on');
        N.lit = span; span.classList.add('on');
        followTo(span);
      }
    };
    if (cached) go(cached);
    else { const p = N.cache.get(i); if (p) p.then((d) => { if (N.i === i && N.playing) go(d); }).catch(() => {}); }
  };
  loop();
}
/** Keep the voice's word in view, unless the person is reading elsewhere. */
function followTo(el) {
  if (!N.follow) return;
  const r = el.getBoundingClientRect();
  const top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-h')) || 58) + 70;
  const bottom = innerHeight - (document.querySelector('.mini:not([hidden])') ? 110 : 30) - (document.querySelector('.bnav') && getComputedStyle(document.querySelector('.bnav')).display !== 'none' ? 70 : 0);
  if (r.top >= top && r.bottom <= bottom) { if (N.away) { N.away = false; emit(); } return; }
  // Scrolled away to read elsewhere: wait (the reader offers "Back to the voice").
  if (N.away) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  scrollTo({ top: scrollY + r.top - (top + (bottom - top) * 0.3), behavior: reduce ? 'auto' : 'smooth' });
}

/** The person scrolled the page themselves: stop following until they come back. */
function userScrolled(e) {
  if (!N.playing || !viewOk() || !N.follow) return;
  if (e.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) return;
  if (e.type === 'keydown' && e.target && e.target.closest && e.target.closest('input,textarea,button,[role=radio]')) return;
  if (!N.away) { N.away = true; emit(); }
}
['wheel', 'touchmove', 'keydown'].forEach((t) => addEventListener(t, userScrolled, { passive: true }));
/** "Back to the voice": follow again and scroll to the word now. */
export function backToVoice() { N.away = false; emit(); if (N.lit) { const el = N.lit; N.lit = null; el.classList.remove('on'); } }

/* ── where they are: synced, so another device resumes here ──────────────── */
function savePos(now) {
  if (!N.mode || !N.book) return;
  if (!now && Date.now() - N.savedAt < 10000) return;
  N.savedAt = Date.now();
  const base = 'progress.' + N.book + '.ch' + N.n;
  C.me.set({ [base + '.ra']: { i: N.i, t: +local().toFixed(1) }, [base + '.at']: Date.now(), last: { book: N.book, n: N.n, at: Date.now() } }, { lazy: !now });
}
addEventListener('pagehide', () => { if (N.playing) savePos(true); });

/* ── sleep timer ─────────────────────────────────────────────────────────── */
export function setSleep(min) { N.sleepUntil = min ? Date.now() + min * 60000 : 0; emit(); paintPlayer(); if (min) ui.toast('Read-aloud will pause in ' + min + ' minutes'); }
export const sleepLeft = () => (N.sleepUntil ? Math.max(0, Math.ceil((N.sleepUntil - Date.now()) / 60000)) : 0);

/* ── mini-player and lock screen ─────────────────────────────────────────── */
let busy = false;
function setBusy(b) { busy = b; paintPlayer(); }
function blockLabel() {
  const list = segList(), s = list[N.i];
  if (!s || !N.ch) return '';
  const bl = N.ch.blocks[s.b] || {};
  if (bl.k === 'p') { const v = (bl.s || []).find((x) => x.v); if (v) return 'Verse ' + v.v; }
  for (let b = s.b; b >= 0; b--) { const h = N.ch.blocks[b]; if (h && h.k === 'h' && !h.minor) return h.t; }
  return N.ch.title || '';
}
function showPlayer() {
  if (!ui.player) return;
  ui.player.show({
    title: (N.n ? 'Chapter ' + N.n + ' · ' : '') + N.title,
    sub: '', kind: 'read',
    onToggle: toggle, onBack: () => skip(-15), onFwd: () => skip(15),
    onMore: () => openSheet(), onOpen: () => ui.go('#/b/' + N.book + '/' + N.n),
    onClose: () => { pause(); reset(); N.book = null; emit(); if (navigator.mediaSession) navigator.mediaSession.metadata = null; },
  });
  paintPlayer();
}
const mine = () => ui.player && ui.player.owner === 'read';
function paintPlayer() {
  if (!mine() || !N.mode) return;
  ui.player.setPlaying(N.playing, busy);
  const sl = sleepLeft();
  ui.player.setSub([busy ? 'Getting the voice ready…' : blockLabel(), voiceName(N.voice), (prefs().speed || 1) + '×', sl ? 'sleep ' + sl + ' min' : ''].filter(Boolean).join(' · '));
  paintProgress();
}
let lastProg = 0;
function paintProgress() {
  if (!mine() || Date.now() - lastProg < 250) return;
  lastProg = Date.now();
  ui.player.progress(fraction());
}
function mediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    ms.metadata = new MediaMetadata({ title: (N.n ? 'Chapter ' + N.n + ': ' : '') + N.title, artist: 'Shruti · read aloud by ' + voiceName(N.voice), album: N.book === 'gita' ? 'Bhagavad-Gita' : N.book });
    ms.setActionHandler('play', () => resume());
    ms.setActionHandler('pause', () => pause());
    ms.setActionHandler('seekbackward', (d) => skip(-(d && d.seekOffset || 15)));
    ms.setActionHandler('seekforward', (d) => skip(d && d.seekOffset || 15));
    ms.setActionHandler('previoustrack', () => step(-1));
    ms.setActionHandler('nexttrack', () => step(1));
    ms.setActionHandler('stop', () => pause());
  } catch (e) {}
}

/* iOS and some Androids let audio start only inside a tap: a silent sound
   played right in the tap unlocks the element for the voice that follows. */
let unlocked = false;
function unlockAudio() {
  if (unlocked || !audio) return;
  unlocked = true;
  try {
    const rate = 8000, n = 800, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
    const silent = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    audio.src = silent;
    // Paused only if the voice has not taken over the element meanwhile.
    audio.play().then(() => { if (audio.src === silent) audio.pause(); }).catch(() => {});
  } catch (e) {}
}

/* ── the read-aloud sheet: speed, voice, sleep, follow, a ready-made copy ── */
// Rebuilt 2026-10-22 (Tony: "far more elegant"): the Make with AI sheets' look.
let voiceList = null;
const RA_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z"/><path d="M3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z"/></svg>';
const PLAY_SM = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
export async function openSheet(ctx) {
  ctx = ctx || (N.book ? { book: N.book, n: N.n, ch: N.ch, title: N.title } : null);
  if (document.getElementById('ra-sheet')) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dim = document.createElement('div');
  dim.className = 'sheet-dim'; dim.id = 'ra-sheet';
  dim.innerHTML = '<aside class="sheet mk ra" role="dialog" aria-modal="true" aria-labelledby="ra-h">' +
    '<header class="mk-head"><span class="mk-ic">' + RA_ICON + '</span><div class="mk-ht"><h2 id="ra-h">Read-aloud</h2>' + (ctx ? '<p>' + esc((ctx.n ? 'Chapter ' + ctx.n + ' · ' : '') + (ctx.title || '')) + '</p>' : '') + '</div>' +
    '<button class="ib" data-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>' +
    '<section class="mk-sec"><div class="mk-label">Speed</div><div class="chips ra-chips" id="ra-speed"></div></section>' +
    '<section class="mk-sec"><div class="mk-label">Voice<span>Tap ▶ to hear one</span></div><div class="mk-voices" id="ra-voices" role="radiogroup" aria-label="Voice"></div></section>' +
    '<section class="mk-sec"><div class="mk-label">Sleep timer</div><div class="chips ra-chips" id="ra-sleep"></div></section>' +
    '<section class="mk-sec"><label class="st-card ra-follow"><span><b>Follow the voice</b><span>The page scrolls with the word being read.</span></span><input type="checkbox" class="sw-in" id="ra-follow"></label></section>' +
    (ctx ? '<section class="mk-sec" id="ra-save"></section>' : '') + '</aside>';
  document.body.appendChild(dim);
  const close = () => { dim.remove(); removeEventListener('keydown', k); off(); };
  const k = (e) => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', k);
  dim.addEventListener('click', (e) => { if (e.target === dim || e.target.closest('[data-close]')) close(); });
  const p = () => prefs();
  const drawSpeed = () => {
    const box = dim.querySelector('#ra-speed');
    box.innerHTML = SPEEDS.map((s) => '<button class="chip' + (s === (p().speed || 1) ? ' on' : '') + '" data-s="' + s + '">' + s + '×</button>').join('');
    box.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => { setPref('speed', Number(b.dataset.s)); drawSpeed(); paintPlayer(); }));
  };
  const drawSleep = () => {
    const box = dim.querySelector('#ra-sleep'), left = sleepLeft();
    box.innerHTML = SLEEPS.map((m) => '<button class="chip' + ((m === 0 && !left) ? ' on' : '') + '" data-m="' + m + '">' + (m ? m + ' min' : 'Off') + '</button>').join('') +
      (left ? '<span class="hint ra-left">Pausing in ' + left + ' min</span>' : '');
    box.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { setSleep(Number(b.dataset.m)); drawSleep(); }));
  };
  let scrolled = false;
  const drawVoices = () => {
    const box = dim.querySelector('#ra-voices'), cur = p().voice;
    const list = voiceList || O.VOICES;
    box.innerHTML = list.filter((v) => v.engine !== 'aura').map((v) =>
      '<div class="mk-voice voice' + (v.id === cur ? ' on' : '') + '" data-v="' + esc(v.id) + '" role="radio" aria-checked="' + (v.id === cur) + '" tabindex="0">' +
      '<span class="dot"></span><span class="mk-vn"><b>' + esc(v.name) + '</b><span>' + esc((ACCENT[v.locale] || v.locale) + ' · ' + v.gender) + '</span></span>' +
      '<button class="ib sm" data-try="' + esc(v.id) + '" aria-label="Hear ' + esc(v.name) + '" title="Hear ' + esc(v.name) + '">' + PLAY_SM + '</button></div>').join('');
    box.querySelectorAll('[data-v]').forEach((row) => {
      const choose = () => {
        if (row.dataset.v === p().voice) return;
        setPref('voice', row.dataset.v);
        drawVoices();
        // "Make it in …" names the voice now ticked (it once said the old one).
        if (ctx) drawSave(dim.querySelector('#ra-save'), ctx, esc);
        // A new voice for what is playing: start this segment again in it.
        if (N.mode) { const at = { b: segList()[N.i].b, word: 0 }, playing = N.playing, cur = { book: N.book, n: N.n, ch: N.ch, title: N.title }; reset(); if (playing) start(Object.assign(cur, { from: at })); else { N.book = null; ui.player && ui.player.hide(); } }
      };
      row.addEventListener('click', (e) => { if (!e.target.closest('[data-try]')) choose(); });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
    });
    box.querySelectorAll('[data-try]').forEach((b) => b.addEventListener('click', () => preview(b.dataset.try, b)));
    const on = box.querySelector('.on');
    if (on && !scrolled) { scrolled = true; requestAnimationFrame(() => { box.scrollTop += on.getBoundingClientRect().top - box.getBoundingClientRect().top - 8; }); }
  };
  drawSpeed(); drawSleep(); drawVoices();
  const fol = dim.querySelector('#ra-follow');
  fol.checked = p().follow !== false;
  fol.addEventListener('change', () => setPref('follow', fol.checked));
  if (ctx) drawSave(dim.querySelector('#ra-save'), ctx, esc);
  const off = onChange(() => { if (dim.isConnected) drawSleep(); });
  if (!voiceList && keyOf()) O.voices(keyOf()).then((v) => { voiceList = v; if (dim.isConnected) drawVoices(); });
}
let previewAudio = null;
export async function preview(id, btn) {
  if (!keyOf()) { needKey(); return; }
  btn.disabled = true;
  try {
    const r = await O.speak({ key: keyOf(), text: 'This is ' + voiceName(id) + ', reading the Bhagavad-Gita for you.', voice: id });
    if (previewAudio) previewAudio.pause();
    previewAudio = new Audio(URL.createObjectURL(r.audio));
    previewAudio.play().catch(() => {});
  } catch (e) { ui.toast(e.message || String(e), true); }
  btn.disabled = false;
}

/* ── a ready-made narration: the whole chapter in the chosen voice, to Drive ─ */
// Made in the background (jobs.js), like Make with AI's narration.
async function drawSave(box, ctx, esc) {
  const ready = await readyFor(ctx.book, ctx.n);
  const want = prefs().voice;
  const has = ready.some((r) => r.voice === want);
  const drive = has || await M.driveReady(ctx.book);
  // A newer draw (the voice changed meanwhile) wins.
  if (!box.isConnected || want !== prefs().voice) return;
  const J = await import('./jobs.js');
  const busy = J.active().some((t) => t.kind === 'read' && t.book === ctx.book && t.n === ctx.n && t.opts.voice === want);
  box.innerHTML = '<div class="mk-label">Ready-made<span>Plays offline-fast, no Orca calls</span></div>' +
    '<div class="st-card ra-ready">' + (ready.length ? ready.map((r) => '<div class="ra-r"><b>' + esc(voiceName(r.voice)) + '</b><span>' + (r.where === 'shipped' ? 'Comes with Shruti' : 'Saved to Drive') + (r.duration ? ' · ' + T.fmtTime(r.duration) : '') + '</span></div>').join('') : '<p class="hint">None yet for this chapter.</p>') + '</div>' +
    (!drive ? '<div class="stat ra-nodrive"><i></i><span>Google Drive is not connected.</span><button class="btn sm" data-ra-drive>Open Settings</button></div>' : '') +
    '<div class="st-row"><button class="btn" id="ra-save-btn"' + (has || !drive || busy ? ' disabled' : '') + '>' + (has ? 'Ready in ' + esc(voiceName(want)) : busy ? 'Being made in ' + esc(voiceName(want)) + '…' : 'Make it in ' + esc(voiceName(want))) + '</button></div>';
  const dr = box.querySelector('[data-ra-drive]'); if (dr) dr.addEventListener('click', () => { const sh = box.closest('.sheet-dim'); if (sh) sh.remove(); ui.openSettings(); });
  box.querySelector('#ra-save-btn').addEventListener('click', () => {
    if (!keyOf()) { needKey(); return; }
    J.add({ kind: 'read', book: ctx.book, n: ctx.n, title: ctx.title, opts: { voice: want } });
    ui.toast('Making the ' + voiceName(want) + ' narration in the background');
    drawSave(box, ctx, esc);
  });
}
/** Exported for the live test. Resolves the shared-doc record. */
export async function saveNarration(ctx, voice, onStep, onUpload, extra = {}) {
  const key = keyOf(), segs = T.segmentsFor(ctx.ch);
  if (!await M.driveReady(ctx.book)) throw new Error('Google Drive is not connected yet (Settings → Google Drive).');
  const parts = [], out = [];
  let t = 0, done = 0;
  const engine = 'edge';
  const one = async (i) => {
    // Whole Edge frames with word timings only (orca.js speakExact): the
    // narration is timed from its bytes, 48 kbps constant bitrate.
    const r = await O.speakExact(O.speak, { key, text: segs[i].text, voice });
    parts[i] = { bytes: r.bytes, dur: r.bytes.length / O.BYTES_PER_SECOND, words: r.words };
    onStep && onStep(++done, segs.length);
  };
  for (let i = 0; i < segs.length; i += 3) await Promise.all([i, i + 1, i + 2].filter((k) => k < segs.length).map(one));
  segs.forEach((s, i) => { out.push({ b: s.b, part: s.part, text: s.text, start: +t.toFixed(3), dur: +parts[i].dur.toFixed(3), words: parts[i].words }); t += parts[i].dur; });
  const mp3 = new Blob(parts.map((p) => p.bytes), { type: 'audio/mpeg' });
  const meta = { v: 1, book: ctx.book, n: ctx.n, voice, engine, duration: +t.toFixed(3), segs: out };
  onUpload && onUpload();
  const name = 'read-' + voiceName(voice).toLowerCase();
  const up = (body, type, ext) => M.upload({ book: ctx.book, n: ctx.n, body, type, name: name + '.' + ext, key });
  const rec = Object.assign({ voice, voices: [voice], engine, duration: meta.duration, mp3: await up(mp3, 'audio/mpeg', 'mp3'), json: await up(JSON.stringify(meta), 'application/json', 'json') }, extra);
  rec.id = M.record(ctx.book, ctx.n, 'read', rec);
  return rec;
}

