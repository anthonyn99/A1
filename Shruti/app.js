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

const P = C.P, PROFILES = C.PROFILES, GID = window.SHRUTI_GID;
const DRIVE = 'https://shruti-drive.av1-2.workers.dev';
const $ = (s, r = document) => r.querySelector(s);
const esc = L.esc;
const STAR = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>';
const LOCK_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const LOCK_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const FLEUR = '<svg width="0.78em" height="0.78em" viewBox="0 0 24 22" aria-hidden="true"><path d="M12 1C14.7 3.7 15.5 7.6 13.7 13H10.3C8.5 7.6 9.3 3.7 12 1ZM13.9 13C14.4 9.1 17.3 6.7 20.3 7.7C22.7 8.5 23.4 11.6 21.4 13.4C21.6 11.8 20.6 10.4 19 10.6C17.3 10.9 16.2 12.2 15.8 13ZM10.1 13C9.6 9.1 6.7 6.7 3.7 7.7C1.3 8.5 .6 11.6 2.6 13.4C2.4 11.8 3.4 10.4 5 10.6C6.7 10.9 7.8 12.2 8.2 13ZM7.4 13.4H16.6A.85 .85 0 0 1 16.6 15.1H7.4A.85 .85 0 0 1 7.4 13.4ZM10.9 15.5H13.1C13.1 17.6 12.7 19.4 12 21.2C11.3 19.4 10.9 17.6 10.9 15.5ZM13.6 15.5H15.3C15.6 17.1 16.7 18.1 18.4 17.9C17.8 19.5 16.1 20 14.9 19.2C14.1 18.6 13.7 17.4 13.6 15.5ZM10.4 15.5H8.7C8.4 17.1 7.3 18.1 5.6 17.9C6.2 19.5 7.9 20 9.1 19.2C9.9 18.6 10.3 17.4 10.4 15.5Z" fill="currentColor"/></svg>';

/* ── toast and in-UI dialogs (no native alert/confirm) ────────────────────── */
let toastT = null;
export function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, 2800);
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
  $('#pk-cards').innerHTML = Object.entries(PROFILES).map(([id, p]) =>
    '<div class="pk-card ' + id + (id === (P || last) ? ' last' : '') + '" role="button" tabindex="0" data-p="' + id + '">' +
    '<button class="pk-star' + (fav === id ? ' on' : '') + '" data-fav="' + id + '" title="' + (fav === id ? 'Default on this device (tap to clear)' : 'Make default on this device') + '" aria-label="Default profile">' + STAR + '</button>' +
    '<div class="em">' + (id === 'tony' ? FLEUR : '✦') + '</div><div class="nm">' + esc(p.label) + '</div>' +
    '<div class="pk-lock">' + (window.Guardian && Guardian.isLocked(id + '_shruti') ? LOCK_ON : '') + '</div></div>').join('');
}
function showPicker() {
  renderPicker();
  $('#picker').hidden = false;
  if (!entered) $('#app').hidden = true;
}
function hidePicker() { $('#picker').hidden = true; }
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
  let h = '<span class="sep">/</span><button data-go="#/b/' + esc(b.id) + '">' + esc(b.title) + '</button>';
  if (r.view === 'chapter') h += '<span class="sep">/</span><button data-go="#/b/' + esc(b.id) + '/' + r.n + '">' + (r.n ? esc((b.unit || 'Chapter') + ' ' + r.n) : 'Introduction') + '</button>';
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

/* ── header buttons ───────────────────────────────────────────────────────── */
$('#lock-btn').addEventListener('click', () => Guardian.manage(GID).then(updateLockBtn));
// Veda's star is drawn, not the ✦ glyph: a font's glyph sits off-centre in the ring.
const SPARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.3 7.2L21.5 12l-7.2 2.3L12 21.5l-2.3-7.2L2.5 12l7.2-2.3z" fill="currentColor"/></svg>';
$('#switch-btn').innerHTML = '<span class="pf-av">' + (P === 'veda' ? SPARK : FLEUR) + '</span>';
$('#switch-btn').addEventListener('click', () => showPicker());
$('#settings-btn').addEventListener('click', () => openSettings());

/* ── Settings ─────────────────────────────────────────────────────────────── */
let modelsCache = null;   // last /models answer for this key, this session
function openSettings() {
  if ($('#settings')) return;
  const dim = document.createElement('div');
  dim.className = 'sheet-dim'; dim.id = 'settings';
  dim.innerHTML = '<aside class="sheet" role="dialog" aria-modal="true" aria-labelledby="st-h">' +
    '<div class="sh-h"><h2 id="st-h">Settings</h2><button class="ib" data-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
    '<section class="card" id="st-orca"></section><section class="card" id="st-units"></section><section class="card" id="st-drive"></section>' +
    '<section class="card"><h3>Profile</h3><p class="hint">Signed in here as <b>' + esc(PROFILES[P].label) + '</b>. Progress, keys and settings are yours on every device; the Gita is shared.</p>' +
    '<div class="row"><button class="btn" data-switch>Switch profile</button><button class="btn" data-lock>' + (Guardian.isLocked(GID) ? 'Manage lock' : 'Set a password') + '</button></div></section>' +
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
  if (C.me.get('orcaKey') && !modelsCache) refreshModels();
}
const keyOf = () => String(C.me.get('orcaKey', '') || '');
const masked = (k) => k ? k.slice(0, 12) + '…' + k.slice(-4) : '';
function drawOrca(state) {
  const box = $('#st-orca'); if (!box) return;
  const k = keyOf();
  const st = state || (modelsCache ? { kind: 'good', text: 'Working · ' + modelsCache.filter((m) => m.routable).length + ' of ' + modelsCache.length + ' models ready' } : k ? { kind: '', text: 'Saved · not checked yet' } : { kind: 'bad', text: 'No key yet: AI features are off' });
  box.innerHTML = '<h3>' + L.IC.key + 'Orca key</h3>' +
    '<p class="hint">Every AI feature in Shruti (podcasts, videos, study sets) runs through Orca with your own key. Make one on Orca\'s Keys page and paste it here once; it then works on all your devices.</p>' +
    '<div class="row"><input id="orca-key" type="password" autocomplete="off" spellcheck="false" placeholder="' + (k ? esc(masked(k)) : 'orca_sk_…') + '" aria-label="Orca key">' +
    '<button class="btn solid" id="orca-save">' + (k ? 'Replace' : 'Save') + '</button></div>' +
    '<div class="stat ' + st.kind + '" id="orca-stat"><i></i><span>' + esc(st.text) + '</span></div>' +
    (k ? '<div class="row" style="margin-top:10px"><button class="btn ghost" id="orca-check">Check again</button><button class="btn ghost danger" id="orca-del">Remove key</button></div>' : '');
  const inp = box.querySelector('#orca-key');
  box.querySelector('#orca-save').addEventListener('click', () => saveKey(inp.value));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(inp.value); });
  const chk = box.querySelector('#orca-check'); if (chk) chk.addEventListener('click', () => refreshModels(true));
  const del = box.querySelector('#orca-del'); if (del) del.addEventListener('click', async () => {
    if (!(await window.uiConfirm('Remove your Orca key from Shruti on every device?', { okLabel: 'Remove' }))) return;
    modelsCache = null; C.me.set({ orcaKey: C.DELETE }, { now: true }); drawOrca(); drawUnits(); drawDrive();
  });
}
async function saveKey(v) {
  v = String(v || '').trim();
  if (!v) return;
  drawOrca({ kind: 'busy', text: 'Checking with Orca…' });
  const r = await O.checkKey(v);
  if (!r.ok) { drawOrca({ kind: 'bad', text: r.error }); return; }
  modelsCache = r.models;
  C.me.set({ orcaKey: v }, { now: true });
  toast('Orca key saved for ' + PROFILES[P].label);
  drawOrca(); drawUnits(); drawDrive();
}
async function refreshModels(loud) {
  const k = keyOf(); if (!k) return;
  drawOrca({ kind: 'busy', text: 'Checking with Orca…' });
  const r = await O.checkKey(k);
  if (r.ok) { modelsCache = r.models; drawOrca(); drawUnits(); if (loud) toast('Orca key works'); }
  else { modelsCache = null; drawOrca({ kind: 'bad', text: r.error }); drawUnits(); }
}
function unitPrefs() { return C.me.get('units', {}) || {}; }
function drawUnits() {
  const box = $('#st-units'); if (!box) return;
  const rows = O.unitRows(unitPrefs(), modelsCache);
  const label = { ready: 'ready', offline: 'offline', missing: 'not on this key', unknown: '' };
  box.innerHTML = '<h3>AI units</h3><p class="hint">Tick the units Shruti may use and drag them into order. It tries them top to bottom and moves on when one is busy or offline. Claude stays off unless you tick it.</p>' +
    '<div class="units" id="unit-list">' + rows.map((r, i) =>
      '<div class="unit' + (r.on ? ' on' : '') + '" data-dkey="' + esc(r.id) + '"><span class="ord">' + (i + 1) + '</span>' +
      '<button class="tick" data-tick="' + esc(r.id) + '" role="checkbox" aria-checked="' + r.on + '" aria-label="' + esc(r.name) + '">' + CHECK + '</button>' +
      '<span class="nm">' + esc(r.name) + '</span><span class="st ' + (r.status === 'ready' ? 'ok' : r.status === 'offline' || r.status === 'missing' ? 'off' : '') + '">' + esc(label[r.status]) + '</span></div>').join('') + '</div>';
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
async function drawDrive(state) {
  const box = $('#st-drive'); if (!box) return;
  const paint = (s) => {
    box.innerHTML = '<h3>Google Drive</h3><p class="hint">Podcasts, videos and narrations are kept in Tony\'s Google Drive (a folder named Shruti) and stream to every device and both profiles. The Gita\'s text never depends on it.</p>' +
      '<div class="stat ' + s.kind + '"><i></i><span>' + esc(s.text) + '</span></div>' +
      (s.action ? '<div class="row" style="margin-top:10px"><button class="btn" id="drive-act">' + esc(s.action) + '</button></div>' : '');
    const a = box.querySelector('#drive-act'); if (a) a.addEventListener('click', s.onAction);
  };
  if (state) { paint(state); return; }
  paint({ kind: 'busy', text: 'Checking…' });
  let h = null;
  try { h = await (await fetch(DRIVE + '/health', { cache: 'no-store' })).json(); } catch (e) {}
  if (!$('#st-drive')) return;
  if (!h) { paint({ kind: 'bad', text: 'The Drive service could not be reached.' }); return; }
  if (h.connected) { paint({ kind: 'good', text: 'Connected' + (h.email ? ' · ' + h.email : '') }); return; }
  if (!h.configured) { paint({ kind: 'bad', text: 'Not set up yet: the Google sign-in for Shruti still has to be created (see Shruti/docs/README.md).' }); return; }
  if (!keyOf()) { paint({ kind: '', text: 'Not connected. Save an Orca key first; it is what lets this device talk to the Drive service.' }); return; }
  paint({ kind: '', text: 'Not connected', action: 'Connect Google Drive', onAction: connectDrive });
}
async function connectDrive() {
  // Open the window inside the click, so a popup blocker lets it through.
  const w = window.open('', '_blank');
  try {
    const r = await fetch(DRIVE + '/connect', { method: 'POST', headers: { authorization: 'Bearer ' + keyOf() } });
    const j = await r.json();
    if (!r.ok || !j.url) throw new Error(j.error || r.status);
    if (w) w.location = j.url; else location.href = j.url;
    drawDrive({ kind: 'busy', text: 'Finish in the Google tab, then come back here.', action: 'I have connected it', onAction: () => drawDrive() });
  } catch (e) {
    if (w) w.close();
    drawDrive({ kind: 'bad', text: 'Could not start: ' + (e.message || e), action: 'Try again', onAction: connectDrive });
  }
}
addEventListener('focus', () => { if ($('#st-drive') && /Google tab/.test($('#st-drive').textContent)) drawDrive(); });

/* ── mini-player: read-aloud now; the podcast and the video use it too ───── */
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
    m.innerHTML = '<div class="mp"><button class="art" data-mp="open" aria-label="Open the chapter">' + L.IC.listen + '</button>' +
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

// Space plays and pauses whatever owns the player, unless typing or on a control.
addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.target.closest('input,textarea,select,button,a,[contenteditable],[role=radio]')) return;
  if (player.owner === 'podcast' && POD.state.meta) { e.preventDefault(); POD.toggle(); }
  else if ((player.owner === 'video' || (!player.owner && VID.state.view && VID.state.view.root.isConnected)) && VID.state.meta) { e.preventDefault(); if (!VID.state.rec) VID.toggle(); }
  else if (NR.state.mode) { e.preventDefault(); NR.toggle(); }
});

/* ── start ────────────────────────────────────────────────────────────────── */
window.Shruti = { go, player, toast, core: C, orca: O, library: L, narrate: NR, podcast: POD, video: VID, openSettings };
if (window.SHRUTI_STORAGE_BLOCKED) setTimeout(() => toast('This browser blocks storage: Shruti works, but this device will not remember choices.', true), 1200);
if (!P) showPicker();
else openGate();
