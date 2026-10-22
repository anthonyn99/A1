// Listen: a chapter told as a conversation between two hosts.
//
// The player: turn bubbles (avatar, name, colour per host), the turn being
// spoken lit and kept in view, the word being said lit, tap a turn or a word
// to go there, segment chips (Welcome, The story, Lesson 1…), subtitles over
// the page, the lessons this episode teaches, speed, download, the
// mini-player and the lock screen. Progress is synced (progress…pod).
//
// Sources: shipped (books/<book>/media/podcasts.json) or made by Shruti and
// saved to Drive (shruti_shared assets.<book>.ch<n>.podcast). Both are one MP3
// plus a transcript: {hosts, duration, segments:[{title, start}],
// turns:[{s, start, end, text, L, words:[[t, d, w]]}]}, word times relative
// to their turn.
//
// build() makes a podcast in the browser from a script: each turn spoken by
// Orca in its host's voice, joined byte for byte with a silent clip in the
// same MP3 format (Edge's is 24 kHz mono 48 kbps CBR), so nothing is decoded
// or re-encoded and every time comes from byte counts. tools/podcast.py does
// the same for the shipped episodes.

import * as C from './core.js';
import * as O from './orca.js';
import * as T from './text.js';
import * as M from './media.js';

const DRIVE = M.DRIVE;
const BPS = 6000;   // bytes per second of 48 kbps audio
/** 0.288 s of silence, 24 kHz mono 48 kbps (tools/silence.mp3, made with lamejs). */
export const SILENCE_B64 = '//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//NkxAAAAANIAAAAAExBTUUDAAkIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const GAPS = { turn: 1, same: 1, segment: 3 };
export const SPEEDS = [0.75, 1, 1.1, 1.25, 1.5, 1.75, 2];

let ui = { player: null, toast: () => {}, go: () => {} };
export function setUI(x) { ui = Object.assign(ui, x); }

const audio = typeof Audio === 'function' ? new Audio() : null;
if (audio) { audio.preload = 'auto'; audio.preservesPitch = true; audio.mozPreservesPitch = true; audio.webkitPreservesPitch = true; }

const P = { book: null, n: null, title: '', meta: null, url: null, playing: false, view: null, turn: -1, word: null, away: false, savedAt: 0 };
export const state = P;
const listeners = new Set();
export function onChange(f) { listeners.add(f); return () => listeners.delete(f); }
const emit = () => listeners.forEach((f) => { try { f(P); } catch (e) {} });
const keyOf = () => String(C.me.get('orcaKey', '') || '');
export const prefs = () => Object.assign({ speed: 1, subs: false }, C.me.get('podcast', {}) || {});
export function setPref(k, v) { C.me.set({ ['podcast.' + k]: v }); if (k === 'speed' && audio) audio.playbackRate = v; emit(); }

/* ── what exists ─────────────────────────────────────────────────────────── */
const shippedIdx = new Map();
export function shipped(book) {
  if (!C.isShipped(book)) return Promise.resolve({});
  if (!shippedIdx.has(book)) shippedIdx.set(book, fetch('books/' + book + '/media/podcasts.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  return shippedIdx.get(book);
}
/** The episode for a chapter: a saved (Drive) one first, else the shipped one. */
export async function sourceFor(book, n) {
  const a = M.docFor(book).get('assets.' + book + '.ch' + n + '.podcast', null);
  if (a && a.mp3 && a.json) return { where: 'drive', mp3: a.mp3, json: a.json, duration: a.duration, hosts: a.hosts };
  const s = (await shipped(book))[String(n)];
  if (s) return { where: 'shipped', mp3: 'books/' + book + '/media/' + s.mp3, json: 'books/' + book + '/media/' + s.json, duration: s.duration, hosts: s.hosts };
  return null;
}
async function open(src) {
  let mp3 = src.mp3, json = src.json;
  if (src.where === 'drive') ({ mp3, json } = await M.links({ mp3: src.mp3, json: src.json }));
  return { url: mp3, meta: await (await fetch(json)).json() };
}

/** Which lessons a transcript teaches, and which it misses. */
export function coverage(meta, lessonIds) {
  const have = new Set((meta.turns || []).flatMap((t) => t.L || []));
  return { covered: lessonIds.filter((id) => have.has(id)), missing: lessonIds.filter((id) => !have.has(id)) };
}
/** The turn playing at time t (the last that started). */
export function turnAt(turns, t) {
  let lo = 0, hi = turns.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (turns[mid].start <= t + 0.01) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/* ── playback ────────────────────────────────────────────────────────────── */
export const active = (book, n) => P.book === book && P.n === n && !!P.meta;
/** Load a chapter's episode (no sound yet). */
export async function load(book, n, title) {
  if (active(book, n)) return P.meta;
  const src = await sourceFor(book, n);
  if (!src) return null;
  const { url, meta } = await open(src);
  stop(true);
  Object.assign(P, { book, n, title, meta, url, turn: -1, word: null, away: false });
  if (audio) audio.src = url;
  emit();
  return meta;
}
export async function play(at) {
  if (!P.meta || !audio) return;
  dispatchEvent(new CustomEvent('shruti:playing', { detail: { who: 'podcast' } }));
  if (at != null) await seek(at);
  else if (!audio.currentTime) {
    const t = Number(C.me.get('progress.' + P.book + '.ch' + P.n + '.pod.t', 0)) || 0;
    if (t > 3 && t < P.meta.duration - 5) await seek(Math.max(0, t - 2));
  }
  audio.playbackRate = prefs().speed || 1;
  try { await audio.play(); P.playing = true; } catch (e) { P.playing = false; if (e && e.name !== 'AbortError') ui.toast('Tap play to start the episode', true); }
  showPlayer(); tick(); emit(); mediaSession();
}
export function pause() { if (audio) audio.pause(); P.playing = false; savePos(true); emit(); paint(); }
export const toggle = () => (P.playing ? pause() : play());
export function seek(t) {
  return new Promise((res) => {
    const go = () => { audio.currentTime = Math.max(0, Math.min((P.meta.duration || audio.duration) - 0.1, t)); res(); };
    if (audio.readyState >= 1) go(); else audio.addEventListener('loadedmetadata', go, { once: true });
  }).then(() => { P.away = false; paintNow(); });
}
export const skip = (s) => seek((audio.currentTime || 0) + s);
export function stepSegment(dir) {
  const segs = P.meta.segments, t = audio.currentTime;
  let i = segs.findIndex((s, k) => t >= s.start && (k + 1 >= segs.length || t < segs[k + 1].start));
  if (dir < 0 && t - segs[i].start > 3) return seek(segs[i].start);
  i = Math.max(0, Math.min(segs.length - 1, i + dir));
  return seek(segs[i].start);
}
/** Close it: silent, the player gone. keep: leave the episode loaded. */
export function stop(keep) {
  if (audio) audio.pause();
  if (P.playing) savePos(true);
  P.playing = false;
  if (!keep) { P.book = null; P.meta = null; }
  emit();
}
// One thing plays at a time: read-aloud starting pauses the episode.
addEventListener('shruti:playing', (e) => { if (e.detail.who !== 'podcast' && P.playing) pause(); });
if (audio) {
  audio.addEventListener('ended', () => {
    P.playing = false;
    const base = 'progress.' + P.book + '.ch' + P.n;
    C.me.set({ [base + '.modes.listen']: 1, [base + '.pod']: C.DELETE, [base + '.at']: Date.now() });
    emit(); paint(); ui.toast('Episode finished');
  });
  audio.addEventListener('pause', () => { if (P.playing && !audio.ended) { P.playing = false; emit(); paint(); } });
}
function savePos(now) {
  if (!P.meta || !audio) return;
  if (!now && Date.now() - P.savedAt < 10000) return;
  P.savedAt = Date.now();
  const base = 'progress.' + P.book + '.ch' + P.n;
  C.me.set({ [base + '.pod']: { t: +audio.currentTime.toFixed(1) }, [base + '.at']: Date.now(), last: { book: P.book, n: P.n, at: Date.now() } }, { lazy: !now });
}
addEventListener('pagehide', () => { if (P.playing) savePos(true); });

/* ── the transcript on the page ──────────────────────────────────────────── */
export function attach(view) { P.view = view; P.turn = -1; P.word = null; paintNow(); }
const viewOk = () => P.view && P.view.root.isConnected && P.view.book === P.book && P.view.n === P.n;
let raf = 0;
function tick() {
  cancelAnimationFrame(raf);
  const loop = () => { if (!P.playing) return; raf = requestAnimationFrame(loop); paintNow(); savePos(false); };
  loop();
}
let lastBar = 0;
function paintNow() {
  if (!P.meta || !audio) return;
  const t = audio.currentTime, turns = P.meta.turns;
  const i = turnAt(turns, t);
  if (Date.now() - lastBar > 250) { lastBar = Date.now(); ui.player && ui.player.progress(t / (P.meta.duration || 1)); }
  const tr = turns[i];
  const k = tr ? T.wordAt(tr.words, t - tr.start) : -1;
  if (i !== P.turn) { P.turn = i; paint(); }
  subtitle(tr, k);
  if (!viewOk()) return;
  const v = P.view;
  if (v.litTurn !== i) {
    if (v.litTurn != null && v.turnEls[v.litTurn]) v.turnEls[v.litTurn].classList.remove('on');
    v.litTurn = i;
    if (v.turnEls[i]) { v.turnEls[i].classList.add('on'); follow(v.turnEls[i]); }
    // the segment chip
    const segs = P.meta.segments;
    const si = segs.findIndex((s, x) => t >= s.start && (x + 1 >= segs.length || t < segs[x + 1].start));
    v.chips.forEach((c, x) => { c.classList.toggle('on', x === si); if (x === si && c.scrollIntoView && v.chipRow) { const r = c.getBoundingClientRect(), rr = v.chipRow.getBoundingClientRect(); if (r.left < rr.left || r.right > rr.right) v.chipRow.scrollTo({ left: c.offsetLeft - 40, behavior: 'smooth' }); } });
  }
  const idx = i >= 0 && k >= 0 && v.maps[i] ? v.maps[i][k] : -1;
  const span = idx >= 0 ? v.wordEls[i][idx] : null;
  if (span !== P.word) { if (P.word) P.word.classList.remove('on'); P.word = span; if (span) span.classList.add('on'); }
}
function follow(el) {
  if (P.away || !P.playing) return;
  const r = el.getBoundingClientRect();
  const top = 150, bottom = innerHeight - 170;
  if (r.top >= top && r.bottom <= bottom) return;
  scrollTo({ top: scrollY + r.top - innerHeight * 0.32, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
['wheel', 'touchmove'].forEach((ev) => addEventListener(ev, () => { if (P.playing && viewOk() && !P.away) { P.away = true; emit(); } }, { passive: true }));
export function backToVoice() { P.away = false; emit(); if (viewOk() && P.view.turnEls[P.turn]) follow(P.view.turnEls[P.turn]); }

/* ── subtitles: the current line over the page ───────────────────────────── */
function subtitle(tr, k) {
  let el = document.getElementById('pod-subs');
  if (!prefs().subs || !P.playing || !tr) { if (el) el.hidden = true; return; }
  if (!el) { el = document.createElement('div'); el.id = 'pod-subs'; el.className = 'pod-subs'; el.setAttribute('aria-hidden', 'true'); document.body.appendChild(el); }
  // A window of about a dozen words around the one being said.
  const ws = tr.words.map((w) => w[2]);
  const at = Math.max(0, k);
  const start = Math.floor(at / 12) * 12, end = Math.min(ws.length, start + 12);
  const host = P.meta.hosts.findIndex((h) => h.id === tr.s);
  const key = P.turn + ':' + start;
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML = '<b class="h' + host + '">' + esc(P.meta.hosts[host] ? P.meta.hosts[host].name : '') + '</b>' + ws.slice(start, end).map((w, x) => '<span data-x="' + (start + x) + '">' + esc(w) + '</span>').join(' ');
  }
  el.hidden = false;
  el.querySelectorAll('span.on').forEach((s) => s.classList.remove('on'));
  const cur = el.querySelector('[data-x="' + at + '"]');
  if (cur) cur.classList.add('on');
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── mini-player and lock screen ─────────────────────────────────────────── */
function showPlayer() {
  if (!ui.player || (ui.player.owner === 'podcast' && document.querySelector('#mini:not([hidden])'))) { paint(); return; }
  ui.player.show({
    title: 'Chapter ' + P.n + ' · ' + P.title, kind: 'podcast',
    onToggle: toggle, onBack: () => skip(-15), onFwd: () => skip(15),
    onOpen: () => ui.go('#/b/' + P.book + '/' + P.n + '/listen'),
    onClose: () => { stop(); if (navigator.mediaSession) navigator.mediaSession.metadata = null; const s = document.getElementById('pod-subs'); if (s) s.hidden = true; },
  });
  paint();
}
function paint() {
  if (!ui.player || ui.player.owner !== 'podcast' || !P.meta) return;
  ui.player.setPlaying(P.playing);
  const tr = P.meta.turns[P.turn], h = tr && P.meta.hosts.find((x) => x.id === tr.s);
  const segs = P.meta.segments, t = audio ? audio.currentTime : 0;
  const seg = segs.filter((s) => s.start <= t + 0.01).pop();
  ui.player.setSub([seg && seg.title, h && h.name, (prefs().speed || 1) + '×'].filter(Boolean).join(' · '));
}
function mediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    ms.metadata = new MediaMetadata({ title: 'Chapter ' + P.n + ': ' + P.title, artist: 'Shruti · ' + P.meta.hosts.map((h) => h.name).join(' & '), album: P.book === 'gita' ? 'Bhagavad-Gita' : P.book });
    ms.setActionHandler('play', () => play());
    ms.setActionHandler('pause', () => pause());
    ms.setActionHandler('seekbackward', (d) => skip(-(d && d.seekOffset || 15)));
    ms.setActionHandler('seekforward', (d) => skip(d && d.seekOffset || 15));
    ms.setActionHandler('previoustrack', () => stepSegment(-1));
    ms.setActionHandler('nexttrack', () => stepSegment(1));
  } catch (e) {}
}

/* ── the Listen tab ──────────────────────────────────────────────────────── */
const PLAY_I = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const PAUSE_I = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>';
const DL_I = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';
const CC_I = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10.5a2 2 0 1 0 0 3M16 10.5a2 2 0 1 0 0 3"/></svg>';

/** A turn's text as written, each word a span (punctuation kept). */
function textHtml(text) {
  let out = '', at = 0, k = 0;
  for (const m of String(text).matchAll(T.WORD_RE)) {
    out += esc(text.slice(at, m.index)) + '<span class="w" data-k="' + (k++) + '">' + esc(m[0]) + '</span>';
    at = m.index + m[0].length;
  }
  return out + esc(text.slice(at));
}
/** Two letters, so two hosts who share an initial still differ. */
const initials = (name) => String(name || '?').slice(0, 2);

export async function renderListen(body, { book, n, title, lessons }) {
  body.innerHTML = '<div class="pod-loading">Loading the episode…</div>';
  let meta;
  try { meta = await load(book, n, title); } catch (e) { meta = null; body.innerHTML = '<div class="empty"><b>The episode could not be opened</b><span>' + esc(e.message || e) + '</span></div>'; return; }
  if (!meta) return false;
  const L = (lessons && lessons.lessons) || [];
  const cov = coverage(meta, L.map((l) => l.id));
  const hostIx = (id) => Math.max(0, meta.hosts.findIndex((h) => h.id === id));
  const firstTurnOf = (id) => meta.turns.findIndex((t) => (t.L || []).includes(id));
  body.innerHTML =
    '<div class="pod">' +
      '<div class="pod-head">' +
        '<div class="pod-hosts">' + meta.hosts.map((h, i) => '<span class="av h' + i + '" title="' + esc(h.name) + '">' + esc(initials(h.name)) + '</span>').join('') + '</div>' +
        '<div class="pod-t"><b>A conversation about chapter ' + n + '</b><span>' + esc(meta.hosts.map((h) => h.name).join(' and ')) + ' · ' + T.fmtTime(meta.duration) + ' · the full story and all ' + L.length + ' lessons</span></div>' +
        '<button class="btn solid pod-play" data-play>' + PLAY_I + '<span>Play</span></button>' +
      '</div>' +
      '<div class="pod-tools">' +
        '<div class="chips pod-speed" role="radiogroup" aria-label="Speed">' + SPEEDS.map((s) => '<button class="chip" data-speed="' + s + '" role="radio">' + s + '×</button>').join('') + '</div>' +
        '<span class="sp"></span>' +
        '<button class="ib" data-subs title="Subtitles" aria-label="Subtitles" aria-pressed="false">' + CC_I + '</button>' +
        '<a class="ib" data-dl href="' + esc(P.url) + '" download="Shruti - Chapter ' + n + ' - ' + esc(title) + '.mp3" title="Download the episode" aria-label="Download the episode">' + DL_I + '</a>' +
      '</div>' +
      '<div class="pod-chips" role="tablist" aria-label="Parts">' + meta.segments.map((s, i) => '<button class="pchip" data-seg="' + i + '">' + esc(s.title) + '</button>').join('') + '</div>' +
      '<div class="pod-turns" id="pod-turns">' + meta.turns.map((t, i) => {
        const hi = hostIx(t.s), h = meta.hosts[hi] || { name: t.s };
        const seg = meta.segments.find((s) => Math.abs(s.start - t.start) < 0.01);
        return (seg ? '<div class="pod-sec">' + esc(seg.title) + '</div>' : '') +
          '<div class="turn h' + hi + (hi ? ' r' : '') + '" data-turn="' + i + '">' +
          '<span class="av h' + hi + '" aria-hidden="true">' + esc(initials(h.name)) + '</span>' +
          '<div class="bub"><div class="who"><b>' + esc(h.name) + '</b><span>' + T.fmtTime(t.start) + '</span>' +
          (t.L || []).map((id) => { const l = L.find((x) => x.id === id); return '<i class="ltag" title="' + esc(l ? l.title : id) + '">' + esc(id) + '</i>'; }).join('') + '</div>' +
          '<p>' + textHtml(t.text) + '</p></div></div>';
      }).join('') + '</div>' +
      '<section class="pod-cov"><h3>Lessons in this episode <span class="' + (cov.missing.length ? 'bad' : 'good') + '">' + cov.covered.length + ' of ' + L.length + '</span></h3>' +
        '<div class="pod-ls">' + L.map((l) => '<button class="pl" data-lesson="' + esc(l.id) + '"' + (firstTurnOf(l.id) < 0 ? ' disabled' : '') + '><i>' + esc(l.id) + '</i><span>' + esc(l.title || '') + '</span></button>').join('') + '</div></section>' +
    '</div>' +
    '<button class="rd-follow" id="pod-follow" hidden>' + 'Back to the conversation</button>';
  const root = body.querySelector('.pod');
  const turnEls = [...root.querySelectorAll('.turn')];
  const wordEls = turnEls.map((el) => [...el.querySelectorAll('.w')]);
  // The voice's words, lined up with the words as written.
  const maps = meta.turns.map((tr, i) => T.align(tr.words.map((w) => w[2]), wordEls[i].map((s) => s.textContent)));
  attach({ book, n, root, turnEls, wordEls, maps, chips: [...root.querySelectorAll('.pchip')], chipRow: root.querySelector('.pod-chips'), litTurn: null });

  const playBtn = root.querySelector('[data-play]');
  const paintTab = () => {
    const on = active(book, n) && P.playing;
    playBtn.innerHTML = (on ? PAUSE_I : PLAY_I) + '<span>' + (on ? 'Pause' : audio && audio.currentTime > 1 && active(book, n) ? 'Resume' : 'Play') + '</span>';
    const sp = prefs().speed || 1;
    root.querySelectorAll('[data-speed]').forEach((b) => { const on2 = Number(b.dataset.speed) === sp; b.classList.toggle('on', on2); b.setAttribute('aria-checked', on2); });
    const subs = root.querySelector('[data-subs]'); subs.setAttribute('aria-pressed', !!prefs().subs); subs.classList.toggle('on', !!prefs().subs);
    body.querySelector('#pod-follow').hidden = !(on && P.away);
  };
  const off = onChange(() => { if (!root.isConnected) { off(); return; } paintTab(); });
  paintTab();
  playBtn.addEventListener('click', async () => { if (!active(book, n)) await load(book, n, title); toggle(); });
  root.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setPref('speed', Number(b.dataset.speed))));
  root.querySelector('[data-subs]').addEventListener('click', () => setPref('subs', !prefs().subs));
  root.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => play(meta.segments[Number(b.dataset.seg)].start)));
  root.querySelectorAll('[data-lesson]').forEach((b) => b.addEventListener('click', () => { const i = firstTurnOf(b.dataset.lesson); if (i >= 0) play(meta.turns[i].start); }));
  body.querySelector('#pod-follow').addEventListener('click', backToVoice);
  root.querySelector('#pod-turns').addEventListener('click', (e) => {
    const turn = e.target.closest('[data-turn]'); if (!turn) return;
    const tr = meta.turns[Number(turn.dataset.turn)];
    const w = e.target.closest('.w');
    // A word: from that word. Anywhere else on the bubble: from the turn's start.
    const k = w ? maps[Number(turn.dataset.turn)].findIndex((m) => m >= Number(w.dataset.k)) : -1;
    play(k >= 0 ? tr.start + tr.words[k][0] : tr.start);
  });
  return true;
}

/* ── making an episode in the browser (Phase 6 uses this) ─────────────────── */
const b64ToBytes = (b64) => { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
/** script: {hosts:[{id,name,voice}], segments:[{title, turns:[{s, t, L}]}]}.
 *  Resolves {mp3: Blob, meta}. onStep(done, total). */
export async function build(script, { key = keyOf(), onStep, parallel = 3, speak = O.speak } = {}) {
  const voices = Object.fromEntries(script.hosts.map((h) => [h.id, h.voice]));
  const flat = script.segments.flatMap((seg, si) => seg.turns.map((t) => ({ si, t })));
  const spoken = new Array(flat.length);
  let done = 0, next = 0;
  const lane = async () => {
    while (next < flat.length) {
      const i = next++, { t } = flat[i];
      const r = await speak({ key, text: t.t, voice: voices[t.s] });
      const bytes = new Uint8Array(await r.audio.arrayBuffer());
      spoken[i] = { bytes, words: r.words || T.spreadWords(t.t, bytes.length / BPS) };
      onStep && onStep(++done, flat.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, flat.length) }, lane));
  const silence = b64ToBytes(SILENCE_B64);
  const parts = [], turns = [], segments = [];
  let bytes = 0, prev = null;
  flat.forEach(({ si, t }, i) => {
    if (prev) {
      const gaps = si !== prev.si ? GAPS.segment : t.s === prev.s ? GAPS.same : GAPS.turn;
      for (let g = 0; g < gaps; g++) { parts.push(silence); bytes += silence.length; }
    }
    if (!segments.length || segments[segments.length - 1].si !== si) segments.push({ si, title: script.segments[si].title, start: +(bytes / BPS).toFixed(3) });
    const start = bytes / BPS;
    parts.push(spoken[i].bytes); bytes += spoken[i].bytes.length;
    turns.push({ s: t.s, start: +start.toFixed(3), end: +(bytes / BPS).toFixed(3), text: t.t, L: t.L || [], words: spoken[i].words });
    prev = { si, s: t.s };
  });
  segments.forEach((s) => delete s.si);
  const meta = { v: 1, book: script.book, n: script.n, title: script.title, hosts: script.hosts, duration: +(bytes / BPS).toFixed(3), segments, turns };
  return { mp3: new Blob(parts, { type: 'audio/mpeg' }), meta };
}
/** Play an episode made here before (or without) saving it: this device only. */
export function useLocal(book, n, title, { mp3, meta }) {
  stop();
  const url = URL.createObjectURL(mp3);
  Object.assign(P, { book, n, title, meta, url, turn: -1, word: null, away: false });
  if (audio) audio.src = url;
  emit();
}
/** Upload a built episode to Drive and keep it as a new version, playing it
 *  (both profiles, on a shared book). Resolves the record. */
export async function save(book, n, { mp3, meta }, extra = {}) {
  const up = (body, type, name) => M.upload({ book, n, body, type, name });
  const rec = Object.assign({ hosts: meta.hosts.map((h) => h.name), voices: meta.hosts.map((h) => h.voice), duration: meta.duration, mp3: await up(mp3, 'audio/mpeg', 'podcast.mp3'), json: await up(JSON.stringify(meta), 'application/json', 'podcast.json') }, extra);
  rec.id = M.record(book, n, 'podcast', rec);
  return rec;
}
