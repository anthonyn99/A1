// Shruti's shell: the profile picker, the lock gate, the router, the header,
// Settings (Orca key, AI units, Google Drive), the bottom nav and the mini-player.
// Order matters for privacy: nothing reaches Firestore, Orca or Drive until
// Guardian has opened this profile (enter() is the only caller of boot()).

import * as C from './core.js';
import * as O from './orca.js';
import * as L from './library.js';
import * as NR from './narrate.js';
import * as POD from './podcast.js';
import * as VID from './video.js';
import * as G from './generate.js';
import * as M from './media.js';
import * as J from './jobs.js';
import * as MK from './make.js';

const P = C.P, PROFILES = C.PROFILES, GID = window.SHRUTI_GID;
const DRIVE = 'https://shruti-drive.av1-2.workers.dev';
const $ = (s, r = document) => r.querySelector(s);
const esc = L.esc;
const STAR = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>';
const LOCK_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const LOCK_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>';
const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const FLEUR = '<svg width="0.78em" height="0.78em" viewBox="0 0 24 22" aria-hidden="true"><path d="M12 1C14.7 3.7 15.5 7.6 13.7 13H10.3C8.5 7.6 9.3 3.7 12 1ZM13.9 13C14.4 9.1 17.3 6.7 20.3 7.7C22.7 8.5 23.4 11.6 21.4 13.4C21.6 11.8 20.6 10.4 19 10.6C17.3 10.9 16.2 12.2 15.8 13ZM10.1 13C9.6 9.1 6.7 6.7 3.7 7.7C1.3 8.5 .6 11.6 2.6 13.4C2.4 11.8 3.4 10.4 5 10.6C6.7 10.9 7.8 12.2 8.2 13ZM7.4 13.4H16.6A.85 .85 0 0 1 16.6 15.1H7.4A.85 .85 0 0 1 7.4 13.4ZM10.9 15.5H13.1C13.1 17.6 12.7 19.4 12 21.2C11.3 19.4 10.9 17.6 10.9 15.5ZM13.6 15.5H15.3C15.6 17.1 16.7 18.1 18.4 17.9C17.8 19.5 16.1 20 14.9 19.2C14.1 18.6 13.7 17.4 13.6 15.5ZM10.4 15.5H8.7C8.4 17.1 7.3 18.1 5.6 17.9C6.2 19.5 7.9 20 9.1 19.2C9.9 18.6 10.3 17.4 10.4 15.5Z" fill="currentColor"/></svg>';

const SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.3 7.2L21.5 12l-7.2 2.3L12 21.5l-2.3-7.2L2.5 12l7.2-2.3z" fill="currentColor"/></svg>';

/* ── toast and in-UI dialogs (no native alert/confirm) ────────────────────── */
let toastT = null;
/** A short note at the bottom; with action {label, fn} it carries a button and stays longer. */
export function toast(msg, err, action) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '') + (action ? ' act' : '');
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-b'; b.textContent = action.label;
    b.addEventListener('click', () => { t.className = 'toast'; action.fn(); });
    t.appendChild(b);
  }
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, action ? 7000 : 2800);
}
function dialog({ title, message, ok = 'OK', cancel }) {
  return new Promise((res) => {
    const dim = document.createElement('div');
    dim.className = 'sheet-dim';
    dim.style.cssText = 'justify-content:center;align-items:center;padding:16px';
    dim.innerHTML = '<div class="card" role="dialog" aria-modal="true" style="max-width:400px;width:100%;margin:0;box-shadow:var(--sh2)">' +
      (title ? '<h3 style="font-size:17px;margin-bottom:6px">' + esc(title) + '</h3>' : '') +
      '<p style="margin:0 0 16px;color:var(--txm);white-space:pre-wrap">' + esc(message) + '</p>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' + (cancel ? '<button class="btn ghost" data-r="0">' + esc(cancel) + '</button>' : '') +
      '<button class="btn solid" data-r="1">' + esc(ok) + '</button></div></div>';
    const done = (v) => { dim.remove(); removeEventListener('keydown', key); res(v); };
    const key = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
    dim.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r === '1'); else if (e.target === dim) done(false); });
    addEventListener('keydown', key);
    document.body.appendChild(dim);
    dim.querySelector('[data-r="1"]').focus();
  });
}
window.uiAlert = (m, o = {}) => dialog({ title: o.title, message: String(m == null ? '' : m), ok: o.okLabel || 'OK' });
window.uiConfirm = (m, o = {}) => dialog({ title: o.title, message: String(m == null ? '' : m), ok: o.okLabel || 'OK', cancel: o.cancelLabel || 'Cancel' });
try { window.alert = (m) => { window.uiAlert(m); }; } catch (e) {}

/* ── sync pill ────────────────────────────────────────────────────────────── */
C.on('sync', (k) => { if (window.A1Head) A1Head.sync($('#sync-pill'), k); });

/* ── the profile picker and the lock ──────────────────────────────────────── */
let entered = false;
function renderPicker() {
  const fav = C.ls.get('shruti.favProfile'), last = C.ls.get('shruti.lastProfile');
  $('#pk-cards').innerHTML = Object.entries(PROFILES).map(([id, p]) => {
    const locked = window.Guardian && Guardian.isLocked(id + '_shruti'), here = id === (P || last);
    return '<div class="pk-card ' + id + (here ? ' last' : '') + '" role="button" tabindex="0" data-p="' + id + '" aria-label="' + esc(p.label) + '">' +
      '<button class="pk-star' + (fav === id ? ' on' : '') + '" data-fav="' + id + '" title="' + (fav === id ? 'Default on this device (tap to clear)' : 'Make default on this device') + '" aria-label="Default profile">' + STAR + '</button>' +
      '<span class="pk-em">' + (id === 'tony' ? FLEUR : SPARK) + '</span><span class="nm">' + esc(p.label) + '</span>' +
      '<span class="pk-note">' + (locked ? LOCK_ON + 'Locked' : here ? 'Last here' : '') + '</span></div>';
  }).join('');
}
function showPicker() {
  renderPicker();
  $('#picker').hidden = false;
  if (!entered) $('#app').hidden = true;
  pickerBackdrop(true);
}
function hidePicker() { $('#picker').hidden = true; pickerBackdrop(false); }

/** The picker's backdrop, Everwell's intro in Shruti's colours: three slow
 *  light pools (Tony's lilac, a deeper violet, Veda's mauve) and motes rising
 *  through them. 30 fps, only while the picker shows and the page is visible;
 *  one still frame when the person asks for less motion. */
const pickerBackdrop = (() => {
  const GLOWS = [[192, 174, 234, .2], [120, 92, 206, .17], [183, 159, 196, .12]];
  let cv, ctx, W = 0, H = 0, motes = [], raf = 0, on = false, last = 0;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const mote = (any) => ({ x: Math.random() * W, y: any ? Math.random() * H : H + 8, r: .5 + Math.pow(Math.random(), 2.2) * 2, v: .006 + Math.random() * .016, ph: Math.random() * 6.28, tw: .0008 + Math.random() * .0016 });
  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.round(Math.min(70, (W * H) / 16000));
    while (motes.length < want) motes.push(mote(true));
    motes.length = want;
  }
  function frame(now) {
    ctx.fillStyle = '#141418'; ctx.fillRect(0, 0, W, H);
    const big = Math.min(Math.max(W, H), Math.sqrt(W * H) * 1.15), tall = H > W * 1.2;
    GLOWS.forEach((g, i) => {
      const k = i + 1, gx = W * (.5 + (tall ? .3 : .38) * Math.sin(now * .00004 * k + i * 2.1)), gy = H * ((tall ? .45 : .42) + (tall ? .38 : .3) * Math.cos(now * .000033 * k + i * 1.3));
      const r = big * (.55 - i * .08), grd = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
      grd.addColorStop(0, 'rgba(' + g.join(',') + ')'); grd.addColorStop(1, 'rgba(' + g.slice(0, 3).join(',') + ',0)');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
    });
    for (const m of motes) {
      m.y -= m.v * 16 * .9; m.x += Math.sin(now * .0004 + m.ph) * .08;
      if (m.y < -8) Object.assign(m, mote(false));
      const a = .25 + .45 * (.5 + .5 * Math.sin(now * m.tw + m.ph));
      ctx.fillStyle = 'rgba(225,214,250,' + (a * Math.min(1, (H - m.y) / 120)).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 6.283); ctx.fill();
    }
  }
  function loop(now) {
    raf = 0;
    if (!on || document.hidden) return;
    if (now - last >= 33) { last = now; frame(now); }
    if (!still.matches) raf = requestAnimationFrame(loop);
  }
  addEventListener('resize', () => { if (on) { size(); frame(performance.now()); } });
  document.addEventListener('visibilitychange', () => { if (on && !document.hidden && !raf) raf = requestAnimationFrame(loop); });
  return (show) => {
    on = show;
    if (!show) { cancelAnimationFrame(raf); raf = 0; return; }
    cv = cv || $('#pk-backdrop'); if (!cv) return;
    ctx = ctx || cv.getContext('2d');
    size(); frame(performance.now());
    if (!raf) raf = requestAnimationFrame(loop);
  };
})();
$('#pk-cards').addEventListener('click', (e) => {
  const star = e.target.closest('[data-fav]');
  if (star) {
    e.stopPropagation();
    const id = star.dataset.fav;
    if (C.ls.get('shruti.favProfile') === id) C.ls.del('shruti.favProfile'); else C.ls.set('shruti.favProfile', id);
    renderPicker(); return;
  }
  const card = e.target.closest('[data-p]');
  if (card) choose(card.dataset.p);
});
$('#pk-cards').addEventListener('keydown', (e) => { const c = e.target.closest('[data-p]'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(c.dataset.p); } });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && entered && !$('#picker').hidden) hidePicker(); });

/** Choosing the other person reloads the page (MAGI's rule): every key, listener
 *  and lock id is that person's from the first line, so nothing of the other
 *  one can linger. */
function choose(id) {
  if (!PROFILES[id]) return;
  if (id === P) { if (entered) hidePicker(); else openGate(); return; }
  try { sessionStorage.setItem('shruti.pick', id); } catch (e) {}
  C.ls.set('shruti.lastProfile', id);
  const u = new URL(location.href);
  if (window.SHRUTI_STORAGE_BLOCKED) u.searchParams.set('profile', id); else u.searchParams.delete('profile');
  if (u.href === location.href) location.reload(); else location.replace(u.href);
}
function openGate() {
  Guardian.gate(GID).then((ok) => { if (ok) enter(); else showPicker(); });
}
function updateLockBtn() {
  const b = $('#lock-btn'); if (!b || !P) return;
  const on = Guardian.isLocked(GID);
  b.innerHTML = on ? LOCK_ON : LOCK_OFF;
  b.style.opacity = on ? '1' : '.6';
  b.title = on ? 'Locked: manage the lock' : 'Not locked: set a password';
}
if (P) {
  Guardian.define(GID, {
    // A password set, changed or removed: ring the bell in this person's doc so
    // their other open devices ask the worker now.
    onChange: () => { if (C.me.loaded) C.me.set({ lockV: Date.now() }, { now: true }); updateLockBtn(); },
    // Locked again here (Lock this device now, or a new password elsewhere).
    onBlock: () => { Guardian.hideRoot && Guardian.hideRoot(GID); openGate(); },
  });
  ['guardian:status', 'guardian:change', 'guardian:unlock', 'guardian:lock'].forEach((ev) => addEventListener(ev, updateLockBtn));
  let lockV = null;
  C.on('doc:me', ({ data }) => {
    if (lockV !== null && data.lockV !== lockV) Guardian.refresh([GID], true);
    lockV = data.lockV || 0;
  });
}

function enter() {
  if (entered) { hidePicker(); return; }
  entered = true;
  C.ls.set('shruti.lastProfile', P);
  hidePicker();
  $('#app').hidden = false;
  updateLockBtn();
  C.boot();
  route();
}

/* ── router ───────────────────────────────────────────────────────────────── */
// #/                library      #/b/<book>          the book's chapters
// #/b/<book>/<n>    chapter, Read    #/b/<book>/<n>/<mode>
function parse() {
  const h = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  // #/b/<book>/<n>/read/<block> opens the reader at that block (a bookmark).
  if (h[0] === 'b' && h[1]) return { view: h[2] != null ? 'chapter' : 'book', id: h[1], n: h[2] != null ? Number(h[2]) : null, mode: h[3] || 'read', at: h[4] != null ? Number(h[4]) : null };
  return { view: 'library' };
}
export function go(hash, { replace = false } = {}) {
  if (location.hash === hash) { route(); return; }
  if (replace) { history.replaceState(null, '', hash); route(); } else location.hash = hash;
}
// Shruti scrolls each view itself. A restored scroll position after a reload (a
// profile switch) would otherwise count as reading in the reader.
try { history.scrollRestoration = 'manual'; } catch (e) {}
addEventListener('hashchange', () => { if (entered) route(); });
let routeSeq = 0, lastView = null;
async function route() {
  const r = parse(), seq = ++routeSeq;
  const el = $('#view');
  const sameChapter = lastView && lastView.view === 'chapter' && r.view === 'chapter' && lastView.id === r.id && lastView.n === r.n && r.at == null;
  const holder = document.createElement('div');
  try {
    if (r.view === 'library') await L.viewLibrary(holder, { go });
    else if (r.view === 'book') await L.viewBook(holder, { id: r.id, go });
    else await L.viewChapter(holder, { id: r.id, n: r.n, mode: r.mode, at: r.at, go });
  } catch (e) {
    console.error(e);
    holder.innerHTML = '<div class="empty"><b>That page could not be opened</b><span>' + esc(e.message || e) + '</span><button class="btn" data-home>Back to the library</button></div>';
    holder.querySelector('[data-home]').addEventListener('click', () => go('#/'));
  }
  if (seq !== routeSeq) return;
  const swap = () => {
    el.replaceChildren(...holder.childNodes);
    if (!sameChapter) { el.classList.remove('v-enter'); void el.offsetWidth; el.classList.add('v-enter'); scrollTo(0, 0); }
  };
  if (document.startViewTransition && !sameChapter && lastView && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(swap);
  else swap();
  lastView = r;
  crumbs(r);
  navState(r);
}
async function crumbs(r) {
  const c = $('#crumbs');
  if (r.view === 'library') { c.innerHTML = ''; return; }
  const b = await L.loadBook(r.id).catch(() => null);
  if (!b) { c.innerHTML = ''; return; }
  let h = '<span class="sep" aria-hidden="true">/</span><button data-go="#/b/' + esc(b.id) + '">' + esc(b.title) + '</button>';
  if (r.view === 'chapter') h += '<span class="sep" aria-hidden="true">/</span><button data-go="#/b/' + esc(b.id) + '/' + r.n + '">' + (r.n ? esc((b.unit || 'Chapter') + ' ' + r.n) : 'Introduction') + '</button>';
  c.innerHTML = h;
  c.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', () => go(x.dataset.go)));
}
function continueHash() {
  const last = C.me.get('last', null);
  if (last && last.book) return '#/b/' + last.book + '/' + last.n;
  return '#/b/gita';
}
function navState(r) {
  document.querySelectorAll('[data-nav]').forEach((b) => {
    const k = b.dataset.nav;
    b.classList.toggle('on', (k === 'library' && r.view === 'library') || (k === 'continue' && r.view !== 'library'));
  });
}
document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.nav;
  if (k === 'library') go('#/');
  else if (k === 'continue') go(continueHash());
  else if (k === 'settings') openSettings();
}));
$('#brand').addEventListener('click', () => go('#/'));
// Another device moved progress or the shared library: redraw lists, never the reader under you.
let redrawT = null;
const redraw = () => { clearTimeout(redrawT); redrawT = setTimeout(() => { const r = parse(); if (entered && r.view !== 'chapter' && !(window.A1Drag && A1Drag.active)) route(); }, 250); };
C.on('doc:me', ({ remote }) => { if (remote) redraw(); });
C.on('doc:shared', ({ remote }) => { if (remote) redraw(); });
// Older Drive records get links that never expire, so the other profile plays
// them with no key (once both docs are in, by whoever has a key).
const upgrade = () => { if (C.me.loaded && C.shared.loaded) setTimeout(() => M.upgradeLinks(), 1500); };
C.on('doc:me', upgrade); C.on('doc:shared', upgrade);
// What was being made on this device before a reload goes on (jobs.js).
let resumed = false;
const resumeJobs = () => {
  if (resumed || !C.me.loaded || !C.shared.loaded) return;
  resumed = true;
  const n = J.resume();
  if (n) toast('Carrying on with ' + n + ' thing' + (n === 1 ? '' : 's') + ' being made', false, { label: 'See', fn: MK.openJobs });
};
C.on('doc:me', resumeJobs); C.on('doc:shared', resumeJobs);

/* ── header buttons ───────────────────────────────────────────────────────── */
$('#lock-btn').addEventListener('click', () => Guardian.manage(GID).then(updateLockBtn));
// Veda's star is drawn, not the ✦ glyph: a font's glyph sits off-centre in the ring.
$('#switch-btn').innerHTML = '<span class="pf-av">' + (P === 'veda' ? SPARK : FLEUR) + '</span>';
$('#switch-btn').addEventListener('click', () => showPicker());
$('#settings-btn').addEventListener('click', () => openSettings());

/* ── Settings ─────────────────────────────────────────────────────────────── */
// The last /models answer for this key is orca.js's (shared with every maker).
const modelsNow = () => O.cachedModels(keyOf());
function openSettings() {
  if ($('#settings')) return;
  const dim = document.createElement('div');
  dim.className = 'sheet-dim'; dim.id = 'settings';
  // Rebuilt 2026-10-22 (Tony: "far more elegant", "descriptions more concise"):
  // the Make with AI sheets' look, one short line under each heading.
  dim.innerHTML = '<aside class="sheet mk st" role="dialog" aria-modal="true" aria-labelledby="st-h">' +
    '<header class="mk-head"><span class="mk-ic">' + GEAR + '</span><div class="mk-ht"><h2 id="st-h">Settings</h2><p>' + esc(PROFILES[P].label) + ' · on every device</p></div><button class="ib" data-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>' +
    '<section class="mk-sec st-sec" id="st-orca"></section><section class="mk-sec st-sec" id="st-units"></section><section class="mk-sec st-sec" id="st-drive"></section>' +
    '<section class="mk-sec st-sec"><div class="mk-label">Profile</div><div class="st-card st-prof"><span class="pf-av">' + (P === 'veda' ? SPARK : FLEUR) + '</span><div><b>' + esc(PROFILES[P].label) + '</b><span>Your progress and settings; the shared books are both of yours.</span></div></div>' +
    '<div class="st-row"><button class="btn" data-switch>Switch profile</button><button class="btn" data-lock>' + (Guardian.isLocked(GID) ? 'Manage lock' : 'Set a password') + '</button></div></section>' +
    '</aside>';
  document.body.appendChild(dim);
  const close = () => { dim.remove(); removeEventListener('keydown', esc1); offMe(); };
  const esc1 = (e) => { if (e.key === 'Escape' && !Guardian.isOpen()) close(); };
  addEventListener('keydown', esc1);
  dim.addEventListener('click', (e) => { if (e.target === dim || e.target.closest('[data-close]')) close(); });
  dim.querySelector('[data-switch]').addEventListener('click', () => { close(); showPicker(); });
  dim.querySelector('[data-lock]').addEventListener('click', () => Guardian.manage(GID).then(updateLockBtn));
  drawOrca(); drawUnits(); drawDrive();
  const offMe = C.on('doc:me', ({ remote }) => { if (remote && !dim.contains(document.activeElement)) { drawOrca(); drawUnits(); } });
  if (keyOf() && !modelsNow()) refreshModels();
}
const keyOf = () => C.orcaKey();
const masked = (k) => k ? k.slice(0, 12) + '…' + k.slice(-4) : '';
function drawOrca(state) {
  const box = $('#st-orca'); if (!box) return;
  const k = keyOf();
  const mdl = modelsNow();
  const st = state || (mdl ? { kind: 'good', text: 'Working · ' + mdl.filter((m) => m.routable).length + ' of ' + mdl.length + ' models ready' } : k ? { kind: '', text: 'Saved · not checked yet' } : !C.me.loaded ? { kind: 'busy', text: 'Loading your settings…' } : { kind: 'bad', text: 'No key yet: AI is off. Everything that ships still plays.' });
  box.innerHTML = '<div class="mk-label">Orca key<span>Every AI feature runs on it</span></div>' +
    '<div class="st-card"><div class="st-key"><input id="orca-key" type="password" autocomplete="off" spellcheck="false" placeholder="' + (k ? esc(masked(k)) : 'Paste orca_sk_…') + '" aria-label="Orca key">' +
    '<button class="btn solid" id="orca-save">' + (k ? 'Replace' : 'Save') + '</button></div>' +
    '<div class="st-foot"><div class="stat ' + st.kind + '" id="orca-stat"><i></i><span>' + esc(st.text) + '</span></div>' +
    (k ? '<span class="sp"></span><button class="btn ghost sm" id="orca-check">Check</button><button class="btn ghost sm danger" id="orca-del">Remove</button>' : '') + '</div></div>';
  const inp = box.querySelector('#orca-key');
  box.querySelector('#orca-save').addEventListener('click', () => saveKey(inp.value));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(inp.value); });
  const chk = box.querySelector('#orca-check'); if (chk) chk.addEventListener('click', () => refreshModels(true));
  const del = box.querySelector('#orca-del'); if (del) del.addEventListener('click', async () => {
    if (!(await window.uiConfirm('Remove your Orca key from Shruti on every device?', { okLabel: 'Remove' }))) return;
    O.forget(); C.me.set({ orcaKey: C.DELETE }, { now: true }); C.ls.del(C.lsKey('orcaKey')); drawOrca(); drawUnits(); drawDrive();
  });
}
async function saveKey(v) {
  v = String(v || '').trim();
  if (!v) return;
  drawOrca({ kind: 'busy', text: 'Checking with Orca…' });
  const r = await O.models(v, { fresh: true });
  if (!r.ok) { drawOrca({ kind: 'bad', text: keyProblem(r) }); return; }
  C.me.set({ orcaKey: v }, { now: true }); C.ls.set(C.lsKey('orcaKey'), v);
  toast('Orca key saved for ' + PROFILES[P].label);
  drawOrca(); drawUnits(); drawDrive();
}
async function refreshModels(loud) {
  const k = keyOf(); if (!k) return;
  drawOrca({ kind: 'busy', text: 'Checking with Orca…' });
  const r = await O.models(k, { fresh: !!loud });
  if (r.ok) { drawOrca(); drawUnits(); if (loud) toast('Orca key works'); }
  else { drawOrca({ kind: 'bad', text: keyProblem(r) }); drawUnits(); }
}
// A refused key says what to do about it; the rest say what happened.
const keyProblem = (r) => (r.status === 401 || r.status === 403 ? 'Orca rejected this key: it may have been deleted or changed on Orca\'s Keys page. Paste a working one.' : r.error);
function unitPrefs() { return C.me.get('units', {}) || {}; }
// "Test each unit": a small real ask of every kind per ticked unit (generate.js testUnit).
const unitTests = { running: false, res: {}, abort: null };
const TEST_NAME = { podcast: 'Podcast', video: 'Video', lessons: 'Lessons', study: 'Study' };
function testRow(id) {
  const r = unitTests.res[id];
  if (!r) return '';
  return '<div class="ut">' + G.TEST_KINDS.map((k) => { const x = r[k]; return '<span class="ut-k ' + (!x ? 'wait' : x.ok ? 'ok' : 'no') + '" title="' + esc(!x ? 'Testing…' : x.ok ? TEST_NAME[k] + ': works' : TEST_NAME[k] + ': ' + x.why) + '">' + (!x ? '<i class="mk-spin"></i>' : x.ok ? CHECK : '×') + esc(TEST_NAME[k]) + '</span>'; }).join('') +
    (G.TEST_KINDS.some((k) => r[k] && !r[k].ok) ? '<p class="ut-why">' + esc(G.TEST_KINDS.filter((k) => r[k] && !r[k].ok).map((k) => TEST_NAME[k] + ': ' + r[k].why).join(' · ')) + '</p>' : '') + '</div>';
}
async function testUnits() {
  if (unitTests.running) { if (unitTests.abort) unitTests.abort.abort(); return; }
  const stop = await G.aiReady();
  if (stop) { toast(stop.title + '. ' + stop.text, true); return; }
  const rows = O.unitRows(unitPrefs(), modelsNow()).filter((r) => r.on && (r.status === 'ready' || r.status === 'unknown' || r.status === 'offline'));
  unitTests.running = true; unitTests.res = {}; unitTests.abort = new AbortController();
  rows.forEach((r) => { unitTests.res[r.id] = {}; });
  drawUnits();
  await Promise.all(rows.map((r) => G.testUnit(r.id, (k, res) => { unitTests.res[r.id][k] = res; drawUnits(); }, { signal: unitTests.abort.signal }).catch(() => {})));
  unitTests.running = false; unitTests.abort = null;
  drawUnits();
  const bad = rows.filter((r) => G.TEST_KINDS.some((k) => unitTests.res[r.id][k] && !unitTests.res[r.id][k].ok));
  toast(bad.length ? bad.map((r) => r.name).join(', ') + (bad.length > 1 ? ' could not' : ' could not') + ' make everything: see Settings' : 'Every ticked unit made all four kinds', !!bad.length);
}
function drawUnits() {
  const box = $('#st-units'); if (!box) return;
  const rows = O.unitRows(unitPrefs(), modelsNow());
  box.innerHTML = '<div class="mk-label">AI units<span>Tried top to bottom · drag to reorder</span></div>' +
    '<div class="units st-card" id="unit-list">' + rows.map((r, i) =>
      '<div class="unit' + (r.on ? ' on' : '') + '" data-dkey="' + esc(r.id) + '"><span class="ord">' + (i + 1) + '</span>' +
      '<button class="tick" data-tick="' + esc(r.id) + '" role="checkbox" aria-checked="' + r.on + '" aria-label="' + esc(r.name + (O.STATUS[r.status] ? ', ' + O.STATUS[r.status] : '')) + '">' + CHECK + '</button>' +
      '<span class="nm">' + esc(r.name) + '</span><span class="st ' + (r.status === 'ready' ? 'ok' : r.status === 'unknown' ? '' : 'off') + '">' + esc(O.STATUS[r.status]) + '</span>' + testRow(r.id) + '</div>').join('') + '</div>' +
    '<div class="st-row"><button class="btn" id="unit-test"' + (keyOf() ? '' : ' disabled') + '>' + (unitTests.running ? '<i class="mk-spin"></i>Stop the test' : 'Test each unit') + '</button><span class="hint">A small podcast, video, lessons and study set from each ticked unit.</span></div>';
  box.querySelector('#unit-test').addEventListener('click', testUnits);
  box.querySelectorAll('[data-tick]').forEach((b) => b.addEventListener('click', () => {
    const p = unitPrefs(), on = Object.assign({}, p.on || {});
    const row = rows.find((r) => r.id === b.dataset.tick);
    on[row.id] = !row.on;
    C.me.set({ 'units.on': on });
    drawUnits();
  }));
  const list = box.querySelector('#unit-list');
  if (window.A1Drag) A1Drag.sort(list, {
    row: '.unit', hold: 300,
    onDrop(from, to) {
      const ids = rows.map((r) => r.id);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      C.me.set({ 'units.order': ids }, { now: true });
      A1Drag.later(drawUnits);
    },
  });
}
// Two Drives (Tony, 2026-10-22): shared books keep their media in Tony's, each
// person's own books in their own. Tony sees one line (both are his); Veda
// sees the shared one (Tony's) and her own, with its Connect button.
let driveWaiting = null;   // the account a Google tab was opened for
async function drawDrive() {
  const box = $('#st-drive'); if (!box) return;
  const rows = P === 'veda' ? [['tony', 'Shared books', 'Tony\'s Drive'], ['veda', 'Your books', 'your Drive']] : [['tony', 'Shared and your books', 'your Drive']];
  const paint = (h) => {
    box.innerHTML = '<div class="mk-label">Google Drive<span>Where made media is kept</span></div>' +
      '<div class="drv">' + rows.map(([a, label, whose]) => {
        const s = !h ? { k: 'busy', t: 'Checking…' } : h.err ? { k: 'bad', t: 'Unreachable' } : !h.configured ? { k: 'bad', t: 'Not set up' }
          : h.accounts && h.accounts[a] && h.accounts[a].connected ? { k: 'good', t: h.accounts[a].email || 'Connected' }
          : driveWaiting === a ? { k: 'busy', t: 'Finish in the Google tab' } : { k: '', t: 'Not connected' };
        const can = h && !h.err && h.configured && keyOf() && (a === P || (P === 'tony' && a === 'tony'));
        const btn = can && s.k !== 'good' ? '<button class="btn sm" data-drive="' + a + '">' + (driveWaiting === a ? 'Check again' : 'Connect ' + (a === P ? 'your' : 'Tony\'s') + ' Drive') + '</button>' : '';
        return '<div class="drv-row"><div><b>' + esc(label) + '</b><span>' + esc(whose) + '</span></div><div class="stat ' + s.k + '"><i></i><span>' + esc(s.t) + '</span></div>' + btn + '</div>';
      }).join('') + '</div>' +
      (h && !h.err && h.configured && !keyOf() ? '<p class="hint">Connecting needs your Orca key first.</p>' : '');
    box.querySelectorAll('[data-drive]').forEach((b) => b.addEventListener('click', () => (driveWaiting === b.dataset.drive ? (driveWaiting = null, drawDrive()) : connectDrive(b.dataset.drive))));
  };
  paint(null);
  const h = await M.driveHealth(true).catch(() => null);
  if (!$('#st-drive')) return;
  paint(h || { err: true });
}
async function connectDrive(acct) {
  // Open the window inside the click, so a popup blocker lets it through.
  const w = window.open('', '_blank');
  try {
    const r = await fetch(DRIVE + '/connect?acct=' + acct, { method: 'POST', headers: { authorization: 'Bearer ' + keyOf() } });
    const j = await r.json();
    if (!r.ok || !j.url) throw new Error(j.error || r.status);
    if (w) w.location = j.url; else location.href = j.url;
    driveWaiting = acct; drawDrive();
  } catch (e) {
    if (w) w.close();
    toast('Google Drive could not be started: ' + (e.message || e), true);
  }
}
addEventListener('focus', () => { if ($('#st-drive') && driveWaiting) { M.driveHealth(true).then((h) => { if (h && h.accounts && h.accounts[driveWaiting] && h.accounts[driveWaiting].connected) driveWaiting = null; drawDrive(); }); } });

/* ── mini-player: read-aloud, the podcast and the video share it ────────── */
const PLAY_I = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const PAUSE_I = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>';
const BACK_I = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><text x="12" y="15.5" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Inter,sans-serif">15</text></svg>';
const FWD_I = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/><text x="12" y="15.5" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="Inter,sans-serif">15</text></svg>';
const MORE_I = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>';
const CLOSE_I = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
export const player = {
  /** show({title, sub, onToggle, onBack, onFwd, onMore, onOpen, onClose}): a
   *  control appears only when its handler is given. */
  /** Who the player belongs to now ('read', 'podcast', 'video'): the others leave it alone. */
  owner: null,
  show(o = {}) {
    player.owner = o.kind || null;
    const m = $('#mini');
    const b = (k, icon, label, cls) => '<button class="ib' + (cls ? ' ' + cls : '') + '" data-mp="' + k + '" aria-label="' + label + '" title="' + label + '">' + icon + '</button>';
    m.innerHTML = '<div class="mp"><button class="art" data-mp="open" aria-label="Open the chapter">' + (o.kind === 'video' ? L.IC.watch : L.IC.listen) + '</button>' +
      '<button class="tt" data-mp="open"><b>' + esc(o.title || '') + '</b><span>' + esc(o.sub || '') + '</span></button>' +
      '<div class="ctl">' + (o.onBack ? b('back', BACK_I, 'Back 15 seconds', 'skip') : '') + b('toggle', PLAY_I, 'Play', 'pp') + (o.onFwd ? b('fwd', FWD_I, 'Forward 15 seconds', 'skip') : '') +
      (o.onMore ? b('more', MORE_I, 'Voice, speed and sleep timer', 'more') : '') + b('close', CLOSE_I, 'Close') + '</div><div class="bar"></div></div>';
    m.hidden = false;
    document.documentElement.style.setProperty('--mini-h', '74px');
    const on = { toggle: o.onToggle, back: o.onBack, fwd: o.onFwd, more: o.onMore, open: o.onOpen };
    m.querySelectorAll('[data-mp]').forEach((x) => x.addEventListener('click', () => {
      const k = x.dataset.mp;
      if (k === 'close') { if (o.onClose) o.onClose(); player.hide(); return; }
      if (on[k]) on[k]();
    }));
  },
  setPlaying(playing, busy) {
    const t = $('#mini [data-mp="toggle"]'); if (!t) return;
    t.innerHTML = playing ? PAUSE_I : PLAY_I;
    t.setAttribute('aria-label', playing ? 'Pause' : 'Play'); t.title = playing ? 'Pause' : 'Play';
    t.classList.toggle('busy', !!busy);
  },
  setSub(sub) { const s = $('#mini .tt span'); if (s) s.textContent = sub || ''; },
  progress(f) { const b = $('#mini .bar'); if (b) b.style.width = (Math.max(0, Math.min(1, f)) * 100).toFixed(2) + '%'; },
  hide() { player.owner = null; const m = $('#mini'); m.hidden = true; m.innerHTML = ''; document.documentElement.style.removeProperty('--mini-h'); },
};
NR.setUI({ player, toast, openSettings: () => openSettings(), go: (h) => go(h) });
POD.setUI({ player, toast, go: (h) => go(h) });
VID.setUI({ player, toast, go: (h) => go(h) });
G.setUI({ toast, go: (h) => go(h), openSettings: () => openSettings() });
MK.setUI({ toast, go: (h) => go(h), openSettings: () => openSettings() });
J.setUI({ toast, go: (h) => go(h), context: L.taskContext, made: MK.made, openJobs: MK.openJobs,
  playWhenShown: (kind, book, n) => (kind === 'podcast' ? POD : VID).playWhenShown(book, n) });
MK.bindPill($('#jobs-pill'));

// Space plays and pauses whatever owns the player, unless typing or on a control.
addEventListener('keydown', (e) => {
  if (e.key !== ' ' || (e.target.closest && e.target.closest('input,textarea,select,button,a,[contenteditable],[role=radio]'))) return;
  if (player.owner === 'podcast' && POD.state.meta) { e.preventDefault(); POD.toggle(); }
  else if ((player.owner === 'video' || (!player.owner && VID.state.view && VID.state.view.root.isConnected)) && VID.state.meta) { e.preventDefault(); if (!VID.state.rec) VID.toggle(); }
  else if (NR.state.mode) { e.preventDefault(); NR.toggle(); }
});

/* ── text boxes: A1's corner grip (resizegrip.js), the same as MAGI's ─────── */
// Tony, 2026-10-22: every box that drags to grow does it the A1 way. Each
// textarea, wherever it appears, is wrapped once and given the grip; its
// height is remembered per box (by id) on this device.
function gripAll(root) {
  if (!window.A1Resize) return;
  root.querySelectorAll('textarea:not([data-grip])').forEach((ta) => {
    ta.dataset.grip = '1';
    const w = document.createElement('div');
    w.className = 'a1-gripwrap';
    ta.parentNode.insertBefore(w, ta);
    w.appendChild(ta);
    const g = A1Resize.grip(ta.getAttribute('aria-label') || ta.placeholder || 'the text box');
    w.appendChild(g);
    A1Resize.attach(ta, g, ta.id ? 'shruti.' + ta.id : null);
  });
}
new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) gripAll(n.tagName === 'TEXTAREA' ? n.parentNode : n); }).observe(document.body, { childList: true, subtree: true });

/* ── start ────────────────────────────────────────────────────────────────── */
window.Shruti = { go, player, toast, core: C, orca: O, library: L, narrate: NR, podcast: POD, video: VID, generate: G, jobs: J, make: MK, openSettings };
if (window.SHRUTI_STORAGE_BLOCKED) setTimeout(() => toast('This browser blocks storage: Shruti works, but this device will not remember choices.', true), 1200);
if (!P) showPicker();
else openGate();
