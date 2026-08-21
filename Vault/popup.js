// Vault Launcher popup — reads the shared Keychain document, renders each
// connection as a group, launches links (a single link or a whole group), and
// writes card ORDER back. Everything else about a link (adding, renaming,
// recolouring, deleting) lives in the Vault app (vault.html); this popup
// displays, opens, and re-orders.

const groupsEl  = document.getElementById("groups");
const loadingEl = document.getElementById("loading");
const syncEl    = document.getElementById("sync");
const toastEl   = document.getElementById("toast");
const scrollEl  = document.getElementById("scroll");
const barEl     = document.getElementById("reorder-bar");
const toggleEl  = document.getElementById("reorder-toggle");

// Vault is its own program at /A1/vault.html — it used to live inside the
// TaskHub PWA and was reached with ?goto=keychain. Nothing else about the
// extension changes: both apps read the same Firestore documents
// (dashboards/keychain, dashboards/vault_pw) through the same Workers, and
// vault.html is the same origin, so the synced biometric link and the app-lock
// unlock marker in localStorage carry over untouched.
//
// index.html keeps a redirect from the old ?goto=keychain link to this URL, so
// an extension build older than this one still lands in the right place.
const VAULT_APP_URL = "https://anthonyn99.github.io/A1/vault.html";
// The Links tab's gear — link groups are managed on Vault's Keychain tab, which
// is the tab vault.html opens on by default.
const TASKHUB_KEYCHAIN_URL = VAULT_APP_URL;
// Straight to Passwords / Payments, where those items are created and edited.
// ?vaulttab is read by vault-ui.js on boot.
const TASKHUB_VAULT_PW_URL = VAULT_APP_URL + "?vaulttab=passwords";
const TASKHUB_VAULT_PAY_URL = VAULT_APP_URL + "?vaulttab=payments";
const TASKHUB_VAULT_ID_URL = VAULT_APP_URL + "?vaulttab=iddocs";

// ── Popup state ──
// Declared before the chrome.storage restore below, which calls setReorder():
// these are `let`, so a storage callback that runs synchronously (as it does
// under test) would hit the temporal dead zone if they were declared after it.
let connections = [];
let colmap = null;          // Keychain's column map (index-aligned to connections)
let lastCols = 0;           // last-rendered column count (to re-render on width change)
let reorderMode = false;
let dragCtl = null;
let pollTimer = null;
let lastOwnSaveAt = 0;
const COL2_MIN = 560;       // px width of #app at/above which we go to 2 columns
const POLL_MS  = 5000;      // live refresh cadence while the popup is open
const ECHO_MS  = 8000;      // ignore server reads for this long after our own save

// ── Popup size ──
// vault-size.js owns this — it already restored the saved size from
// localStorage before <body> was parsed, so the popup opens at the right size
// instead of being resized after the fact. Everything here just drives it.
const appEl = document.getElementById("app");
const REORDER_KEY = "vault_reorder_mode";

// Column count from the laid-out content width, with HYSTERESIS: it splits into
// two columns at 560px but doesn't fold back until 530px. Without the dead band,
// easing the width rail across the threshold re-rendered every card on
// alternate frames, which is what made the drag feel like it was seizing up.
function colCount() {
  const w = appEl.offsetWidth;
  return lastCols >= 2 ? (w < COL2_MIN - 30 ? 1 : 2) : (w >= COL2_MIN ? 2 : 1);
}

chrome.storage.local.get([VaultSize.KEY, REORDER_KEY], (d) => {
  // Only used when localStorage had nothing — a size saved by an older build,
  // or a profile whose localStorage was cleared. Normally a no-op.
  if (VaultSize.adoptStored(d && d[VaultSize.KEY])) render();

  // Reorder is sticky: leave it on and the grips are there next time.
  setReorder(!!(d && d[REORDER_KEY]), false);

  // Re-flow into 1 or 2 columns whenever the content box actually changes.
  new ResizeObserver(() => {
    if (colCount() !== lastCols && connections.length) render();
  }).observe(appEl);
});

// ── Resize rails: one per axis ──
// Width is dragged from the LEFT rail and height from the BOTTOM rail because
// those are the popup's free edges — it hangs below the toolbar icon, so its
// top and right edges are pinned by the browser and cannot move. Drag the left
// rail LEFT to widen, the bottom rail DOWN to heighten; each edge travels
// exactly as far as the pointer, so the handle stays under the cursor.
//
// Deltas are INCREMENTAL: each move adjusts the size we last asked for, rather
// than re-deriving it from where the drag began. An absolute baseline keeps
// accumulating past the clamp, so dragging well beyond the maximum and then
// back left the popup frozen until the pointer had travelled all the way back.
// Screen coordinates (not client) because the window re-anchors as it resizes.
//
// The size is saved DURING the drag, not on release: a popup dismisses the
// moment it loses focus, and a rail drag routinely ends with the pointer
// outside the popup, so a release-only save silently lost the new size. The
// write itself is throttled inside vault-size.js — localStorage is synchronous,
// and writing it every frame was enough to make the drag stutter.
function makeRail(el, axis) {
  let drag = null, raf = 0, next = null;

  const flush = () => {
    raf = 0;
    if (!next) return;
    VaultSize.apply(next.w, next.h);
    next = null;
    VaultSize.save();
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    drag = { sx: e.screenX, sy: e.screenY };
    el.classList.add("active");
    document.body.classList.add("resizing-" + axis);
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  });

  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    // Accumulate onto any pending frame, so a burst of moves inside one frame
    // isn't collapsed down to just the last delta.
    const base = next || { w: VaultSize.w, h: VaultSize.h };
    next = axis === "x"
      ? { w: base.w - (e.screenX - drag.sx), h: base.h }
      : { w: base.w, h: base.h + (e.screenY - drag.sy) };
    drag.sx = e.screenX; drag.sy = e.screenY;
    if (!raf) raf = requestAnimationFrame(flush);
  });

  const end = (e) => {
    if (!drag) return;
    drag = null;
    if (raf) cancelAnimationFrame(raf);
    flush();
    el.classList.remove("active");
    document.body.classList.remove("resizing-" + axis);
    VaultSize.save(true);
    reconcile();
    try { el.releasePointerCapture(e && e.pointerId); } catch (_) {}
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("lostpointercapture", end);
}

// After a drag, re-assert the requested size once. Popup auto-sizing follows a
// growing document eagerly and a shrinking one lazily, and a second assertion
// settles the lag.
//
// It deliberately does NOT fall back to adopting the window's own size when the
// window doesn't come down. That was tried and it is actively wrong: any moment
// the window sits wider than the request — which is the whole symptom being
// fixed — adopting would snap the size back up AND save it, so a shrink could
// never stick. The request always wins; if the window trails for a frame that
// is cosmetic, and the next open is laid out from the saved value anyway.
function reconcile() {
  afterFrames(2, () => VaultSize.apply(VaultSize.w, VaultSize.h));
}

function afterFrames(n, fn) {
  const step = () => (--n <= 0 ? fn() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}

makeRail(document.getElementById("resize-x"), "x");
makeRail(document.getElementById("resize-y"), "y");

// Same palette Keychain uses for connection colours, for a consistent look.
const CD = ['#f1b0c4','#f6c29e','#f1e19e','#cfe39c','#a9dcb4','#9bd8d0','#a3c8ec','#c3aee6','#e795ae','#f0ac7e','#e7d07e','#b9d683','#8fc99c','#82c6be','#8aafe2','#ab92dc'];

const COPY_SVG ='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const GRIP_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="6" cy="3" r="1.5"/><circle cx="10" cy="3" r="1.5"/><circle cx="6" cy="8" r="1.5"/><circle cx="10" cy="8" r="1.5"/><circle cx="6" cy="13" r="1.5"/><circle cx="10" cy="13" r="1.5"/></svg>';

// Map any stored color to the nearest pastel in CD by hue (non-destructive —
// mirrors index.html's _pastelize so Vault matches Keychain/Links exactly).
function pastelize(hex) {
  if (!hex) return CD[0];
  hex = String(hex).toLowerCase();
  if (CD.indexOf(hex) >= 0) return hex;
  const hs = (h) => {
    h = h.replace("#", "");
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    const r = parseInt(h.slice(0,2),16)/255, g = parseInt(h.slice(2,4),16)/255, b = parseInt(h.slice(4,6),16)/255;
    const mx = Math.max(r,g,b), mn = Math.min(r,g,b), d = mx-mn;
    let H = 0;
    if (d) { if (mx===r) H=((g-b)/d)%6; else if (mx===g) H=(b-r)/d+2; else H=(r-g)/d+4; H*=60; if (H<0) H+=360; }
    return { h:H, s: mx?d/mx:0 };
  };
  let src;
  try { src = hs(hex); } catch { return CD[0]; }
  if (src.s < 0.08) return CD[0];
  let best = CD[0], bd = 1e9;
  for (const c of CD) { const t = hs(c); let dh = Math.abs(t.h-src.h); if (dh>180) dh=360-dh; if (dh<bd) { bd=dh; best=c; } }
  return best;
}

// ── A1 suite app icons ──────────────────────────────────────────
// Every A1 program is served off the one host (anthonyn99.github.io/A1), so the
// favicon service below hands back the same generic globe for all of them. Map
// our own pages to the app's own <link rel="icon"> mark instead, keyed by
// filename. Twins of this map live in index.html, vault.html and the other
// launcher's popup.js — edit them together.
const APP_ICONS = {
  "index.html":      "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2096%2096%27%3E%3Crect%20width%3D%2796%27%20height%3D%2796%27%20rx%3D%2722%27%20fill%3D%27%231a1a1d%27%2F%3E%3Cg%20fill%3D%27none%27%20stroke%3D%27%23e0b874%27%20stroke-width%3D%275%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M26%2034l7%207%2012-13%27%2F%3E%3Cpath%20d%3D%27M56%2036h16%27%2F%3E%3Cpath%20d%3D%27M26%2058h46%27%2F%3E%3Cpath%20d%3D%27M26%2072h46%27%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", // TaskHub
  "tradehub.html":   "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2096%2096%27%3E%3Crect%20width%3D%2796%27%20height%3D%2796%27%20rx%3D%2722%27%20fill%3D%27%231a1a1d%27%2F%3E%3Cg%20fill%3D%27none%27%20stroke%3D%27%23e0b874%27%20stroke-width%3D%275%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M24%2022v50a2%202%200%200%200%202%202h48%27%2F%3E%3Cpath%20d%3D%27M34%2062l12-14%2010%209%2016-21%27%2F%3E%3Cpath%20d%3D%27M60%2036h12v12%27%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", // TradeHub
  "mylist.html":     "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2096%2096%27%3E%3Crect%20width%3D%2796%27%20height%3D%2796%27%20rx%3D%2722%27%20fill%3D%27%231a1a1d%27%2F%3E%3Cg%20fill%3D%27none%27%20stroke%3D%27%23e0b874%27%20stroke-width%3D%275%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M42%2032h30%27%2F%3E%3Cpath%20d%3D%27M42%2048h30%27%2F%3E%3Cpath%20d%3D%27M42%2064h30%27%2F%3E%3Ccircle%20cx%3D%2728%27%20cy%3D%2732%27%20r%3D%273.5%27%20fill%3D%27%23e0b874%27%20stroke%3D%27none%27%2F%3E%3Ccircle%20cx%3D%2728%27%20cy%3D%2748%27%20r%3D%273.5%27%20fill%3D%27%23e0b874%27%20stroke%3D%27none%27%2F%3E%3Ccircle%20cx%3D%2728%27%20cy%3D%2764%27%20r%3D%273.5%27%20fill%3D%27%23e0b874%27%20stroke%3D%27none%27%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", // MyList
  "insight.html":    "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2096%2096%27%3E%3Crect%20width%3D%2796%27%20height%3D%2796%27%20rx%3D%2722%27%20fill%3D%27%231a1a1d%27%2F%3E%3Cg%20fill%3D%27none%27%20stroke%3D%27%23e0b874%27%20stroke-width%3D%275%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M48%2024a24%2024%200%201%200%2024%2024H48Z%27%2F%3E%3Cpath%20d%3D%27M60%2020a20%2020%200%200%201%2016%2016H60Z%27%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", // Insight
  "vault.html":      "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2096%2096%27%3E%3Crect%20width%3D%2796%27%20height%3D%2796%27%20rx%3D%2722%27%20fill%3D%27%231a1a1d%27%2F%3E%3Cg%20fill%3D%27none%27%20stroke%3D%27%23e0b874%27%20stroke-width%3D%275%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Crect%20x%3D%2722%27%20y%3D%2742%27%20width%3D%2752%27%20height%3D%2734%27%20rx%3D%277%27%2F%3E%3Cpath%20d%3D%27M33%2042v-9a15%2015%200%200%201%2030%200v9%27%2F%3E%3Cpath%20d%3D%27M48%2055v8%27%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", // Vault
  "oneinbox.html":   "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2096%2096'%3E%3Crect%20width%3D'96'%20height%3D'96'%20rx%3D'22'%20fill%3D'%231a1a1d'%2F%3E%3Cg%20fill%3D'none'%20stroke%3D'%23e0b874'%20stroke-width%3D'5'%20stroke-linecap%3D'round'%20stroke-linejoin%3D'round'%3E%3Crect%20x%3D'20'%20y%3D'28'%20width%3D'56'%20height%3D'40'%20rx%3D'6'%2F%3E%3Cpath%20d%3D'M20%2033%2048%2054%2076%2033'%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D'75'%20cy%3D'27'%20r%3D'9'%20fill%3D'%231a1a1d'%2F%3E%3Ccircle%20cx%3D'75'%20cy%3D'27'%20r%3D'5.5'%20fill%3D'%23e0b874'%2F%3E%3C%2Fsvg%3E", // OneInbox
  "solace.html":     "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2096%2096'%3E%3Crect%20width%3D'96'%20height%3D'96'%20rx%3D'22'%20fill%3D'%231a1a1d'%2F%3E%3Cg%20fill%3D'none'%20stroke%3D'%23e0b874'%20stroke-linecap%3D'round'%20stroke-linejoin%3D'round'%3E%3Cpath%20d%3D'M48%2070C33.5%2059.5%2025%2051%2025%2041.5%2025%2034%2030.5%2028.5%2037.5%2028.5%2042.5%2028.5%2046%2031.5%2048%2034.5%2050%2031.5%2053.5%2028.5%2058.5%2028.5%2065.5%2028.5%2071%2034%2071%2041.5%2071%2051%2062.5%2059.5%2048%2070Z'%20stroke-width%3D'5'%2F%3E%3Cpath%20d%3D'M34%2045h6l4-8.5%205.5%2016%204-7.5h8.5'%20stroke-width%3D'4'%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", // Solace
  "wellness.html":   "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2096%2096%27%3E%3Crect%20width%3D%2796%27%20height%3D%2796%27%20rx%3D%2722%27%20fill%3D%27%231B1C1E%27%2F%3E%3Cg%20fill%3D%27none%27%20stroke%3D%27%238D769A%27%20stroke-width%3D%275%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M26%2052c0-10%208-18%2018-18s18%208%2018%2018%27%2F%3E%3Cpath%20d%3D%27M22%2062h12l5-10%206%2020%205-10h24%27%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", // Wellness
};

// The A1 app icon for a link, or "" when the URL isn't one of our programs.
function appIconUrl(url) {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : "https://" + url);
    const path = u.pathname.toLowerCase();
    // Accept the published /A1/ path and any local dev server serving it.
    if (!/(^|\/)a1\//.test(path) && !/^(localhost|127\.0\.0\.1)$/i.test(u.hostname)) return "";
    // A bare directory ("/A1/") is served as index.html, i.e. TaskHub.
    const file = /\.html?$/.test(path) ? path.split("/").pop() : "index.html";
    return APP_ICONS[file] || "";
  } catch { return ""; }
}

// Official site icon (like a browser bookmark): our own app mark for A1
// programs, otherwise Google's favicon service.
function faviconUrl(url) {
  const app = appIconUrl(url);
  if (app) return app;
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).hostname;
    // Drawn locally — see the note in vault-ui.js's faviconUrl().
    return (function(h){h=String(h||'').replace(/^www\./,'');if(!h)return '';var n=0;for(var i=0;i<h.length;i++)n=(n*31+h.charCodeAt(i))>>>0;var c=/^[a-z0-9]/i.test(h)?h.charAt(0).toUpperCase():'#';return 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +'<rect width="64" height="64" rx="14" fill="hsl('+(n%360)+' 42% 46%)"/>' +'<text x="32" y="44" font-family="system-ui,sans-serif" font-size="34" font-weight="600" fill="#ffffff" text-anchor="middle">'+c+'</text></svg>');})(host);
  } catch { return ""; }
}

function esc(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// Open one or more links. When `group` is set (a multi-link group launch), the
// background wraps them in a named, color-matched browser tab group.
function openUrls(urls, group) {
  const clean = urls.filter(Boolean);
  if (!clean.length) return;
  const msg = { action: "openLinks", urls: clean };
  if (group) { msg.group = true; msg.groupName = group.name || ""; msg.groupColor = group.color || ""; }
  chrome.runtime.sendMessage(msg, () => window.close());
}

function setSync(state, text) {
  syncEl.className = "sync" + (state ? " " + state : "");
  syncEl.textContent = text || "";
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.style.opacity = "1";
  toastEl.style.transform = "translateX(-50%) translateY(0)";
  setTimeout(() => {
    toastEl.style.opacity = "0";
    toastEl.style.transform = "translateX(-50%) translateY(20px)";
  }, 1300);
}

// Build one group card (original index `ci` is used for colmap + open-group).
function buildCard(conn, ci) {
  const color = conn.color ? pastelize(conn.color) : CD[ci % CD.length];
  const links = VaultDB.linksOf(conn);

  const card = document.createElement("div");
  card.className = "card";
  card.style.setProperty("--card-accent", color);
  // The drag module reads/rewrites this — it is the ORIGINAL index into
  // `connections`, which is what a reorder write has to be expressed in.
  card.dataset.ci = String(ci);

  const linkRows = links.map(l => `
    <div class="link-row">
      <img class="favicon" src="${faviconUrl(l.url)}" width="16" height="16" alt="" loading="lazy">
      <span class="link-name" title="${esc(l.url)}">${esc(l.name)}</span>
      <button class="icon-btn visit" data-url="${esc(l.url)}">Visit</button>
      <button class="icon-btn copy" data-copy="${esc(l.url)}" title="Copy link">${COPY_SVG}</button>
    </div>`).join("");

  // Group-launch button only for 2+ links — a single link has its own Visit.
  // Opens every link and auto-wraps them in one named, color-matched tab group.
  const openGroupBtn = links.length > 1
    ? `<button class="open-group" data-group="${ci}" title="Open all ${links.length} links as a tab group">Open ${links.length} Tab${links.length===1?"":"s"}</button>`
    : "";

  card.innerHTML = `
    <div class="card-top">
      <div class="card-headline">
        <span class="grip" data-role="card-grip" title="Drag to reorder">${GRIP_SVG}</span>
        <div class="card-name">${esc(conn.name || "Untitled")}</div>
      </div>
      ${openGroupBtn}
    </div>
    ${linkRows}`;
  return card;
}

function renderList() {
  loadingEl.style.display = "none";
  groupsEl.innerHTML = "";

  // Only groups that actually contain links, keeping their original index so
  // colmap placement and open-group wiring stay correct.
  const visible = connections
    .map((conn, ci) => ({ conn, ci }))
    .filter(({ conn }) => VaultDB.linksOf(conn).length > 0);

  // Nothing to rearrange with fewer than two cards.
  barEl.hidden = visible.length < 2;

  if (!visible.length) {
    groupsEl.innerHTML = `<div class="empty">No link groups yet.<br />Add links in the Vault app under Settings \u2014 they sync here automatically.</div>`;
    return;
  }

  // 1 column when narrow, 2 when widened — mirrors Keychain. When at 2 columns
  // and Keychain saved a colmap, place cards in the exact same columns/order;
  // otherwise fill top-to-bottom in reading order.
  const cols = colCount();
  lastCols = cols;
  const colDivs = Array.from({ length: cols }, () => {
    const d = document.createElement("div");
    d.className = "col";
    return d;
  });
  const perCol = Math.ceil(visible.length / cols);
  visible.forEach(({ conn, ci }, vi) => {
    let colIdx;
    if (cols === 2 && Array.isArray(colmap) && typeof colmap[ci] === "number") {
      colIdx = Math.max(0, Math.min(colmap[ci], cols - 1));
    } else {
      colIdx = Math.min(Math.floor(vi / perCol), cols - 1);
    }
    colDivs[colIdx].appendChild(buildCard(conn, ci));
  });
  colDivs.forEach(d => groupsEl.appendChild(d));

  // Hide any favicon that fails to load (CSP-safe: no inline onerror).
  groupsEl.querySelectorAll("img.favicon").forEach(img =>
    img.addEventListener("error", () => { img.style.visibility = "hidden"; }));

  // Wire buttons (CSP-safe: no inline handlers).
  groupsEl.querySelectorAll(".icon-btn.visit").forEach(b =>
    b.addEventListener("click", () => openUrls([b.dataset.url])));
  groupsEl.querySelectorAll(".icon-btn.copy").forEach(b =>
    b.addEventListener("click", () => {
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast("Copied!"));
    }));
  groupsEl.querySelectorAll(".open-group").forEach(b =>
    b.addEventListener("click", () => {
      const conn = connections[+b.dataset.group];
      const links = VaultDB.linksOf(conn);
      const color = conn.color ? pastelize(conn.color) : CD[(+b.dataset.group) % CD.length];
      openUrls(links.map(l => l.url), { name: conn.name || "Group", color });
    }));

  // The grips are recreated on every render, so the drag module has to rebind.
  if (dragCtl) dragCtl.rebind();
  else dragCtl = VaultCardDrag.enable(groupsEl, {
    scroller: scrollEl,
    isEnabled: () => reorderMode,
    onDrop: persistOrder
  });
}


// Rebuilding the list parks the scroller back at the top. A background poll or
// a column reflow must never do that to someone who has scrolled down, so the
// offset is captured around the rebuild and put back — clamped, in case the new
// list is shorter than the old one.
function render() {
  const top = scrollEl ? scrollEl.scrollTop : 0;
  renderList();
  if (scrollEl && top) {
    const max = scrollEl.scrollHeight - scrollEl.clientHeight;
    scrollEl.scrollTop = Math.max(0, Math.min(top, max));
  }
}

// ── Reorder → write back to Keychain ─────────────────────────────────────────

function setReorder(on, persist) {
  reorderMode = !!on;
  appEl.classList.toggle("reorder", reorderMode);
  toggleEl.setAttribute("aria-checked", reorderMode ? "true" : "false");
  if (persist !== false) chrome.storage.local.set({ [REORDER_KEY]: reorderMode });
}
toggleEl.addEventListener("click", () => setReorder(!reorderMode, true));
toggleEl.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); setReorder(!reorderMode, true); }
});

// `order` holds the ORIGINAL connection indices in their new DOM order, and only
// covers the cards that are rendered — groups with no links are filtered out of
// the view. Those hidden entries must survive the write, so they are appended in
// their existing relative order rather than dropped.
function persistOrder(result) {
  if (!result || !Array.isArray(result.order)) { render(); return; }

  const shown = new Set(result.order);
  const hidden = connections.map((_, i) => i).filter(i => !shown.has(i));
  const finalIdx = result.order.concat(hidden);

  const reordered = finalIdx.map(i => connections[i]);
  if (reordered.length !== connections.length || reordered.some(c => !c)) { render(); return; }

  // colmap is keyed by the NEW index of each connection.
  //
  // At two columns the popup shows the real layout, so the drop result IS the
  // truth. At one column it is not: writing "everything in column 0" would
  // flatten the two-column layout in the Vault app's Keychain the next time it
  // is opened. So a one-column reorder carries each card's EXISTING column
  // forward through the permutation and only changes the vertical order.
  const oldMap = Array.isArray(colmap) ? colmap : null;
  let newMap;
  if (lastCols >= 2) {
    newMap = finalIdx.map((origIdx, n) =>
      (n < result.order.length && typeof result.colmap[n] === "number")
        ? result.colmap[n]
        : (oldMap && typeof oldMap[origIdx] === "number" ? oldMap[origIdx] : 0));
  } else if (oldMap) {
    newMap = finalIdx.map(origIdx => (typeof oldMap[origIdx] === "number" ? oldMap[origIdx] : 0));
  } else {
    newMap = null;   // Keychain falls back to reading-order distribution
  }

  connections = reordered;
  colmap = newMap;
  render();

  lastOwnSaveAt = Date.now();
  setSync("saving", "Syncing…");
  VaultDB.save({ connections, colmap })
    .then(() => {
      lastOwnSaveAt = Date.now();
      VaultDB.writeCache({ connections, colmap, savedAt: Date.now() });
      setSync("ok", "✓ Synced");
      setTimeout(() => { if (syncEl.textContent === "✓ Synced") setSync("", "Synced with Keychain"); }, 2200);
    })
    .catch((e) => { console.error(e); setSync("error", "⚠ Sync failed"); });
}

// ── Tabs + tab-aware settings button ──
// Links tab: the gear opens the Vault app (all link management lives there).
// Passwords tab: the gear opens Vault's own settings page.
let activeTab = "links";
const gearEl = document.getElementById("gear");

const TAB_TITLES = {
  passwords: "Manage passwords in the Vault app",
  payments: "Manage payment methods in the Vault app",
  iddocs: "Manage ID documents in the Vault app",
  links: "Open the Vault app",
};
const TAB_GEAR_URLS = {
  passwords: TASKHUB_VAULT_PW_URL,
  payments: TASKHUB_VAULT_PAY_URL,
  iddocs: TASKHUB_VAULT_ID_URL,
  links: TASKHUB_KEYCHAIN_URL,
};

function setActiveTab(name) {
  activeTab = name;
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.panel === name));
  ["links", "passwords", "payments", "iddocs"].forEach(p =>
    document.getElementById("panel-" + p).classList.toggle("hidden", name !== p));
  gearEl.title = TAB_TITLES[name] || TAB_TITLES.links;
  // Render each vault panel (unlock / list / autofill) on first open. Both share
  // one unlocked session, so unlocking on either tab covers the other.
  if (name === "passwords" && window.VaultPWPanel) window.VaultPWPanel.render();
  if (name === "payments" && window.VaultPayPanel) window.VaultPayPanel.render();
  if (name === "iddocs" && window.VaultIdPanel) window.VaultIdPanel.render();
}

document.querySelectorAll(".tab").forEach(tab =>
  tab.addEventListener("click", () => setActiveTab(tab.dataset.panel)));

gearEl.addEventListener("click", () => {
  // Each vault tab's gear deep-links to the matching tab of the Vault app (where
  // items are created/edited); Links opens Keychain.
  chrome.tabs.create({ url: TAB_GEAR_URLS[activeTab] || TASKHUB_KEYCHAIN_URL });
  window.close();
});

// ── Load from the shared Keychain doc + live refresh ──

function apply(doc) {
  connections = Array.isArray(doc.connections) ? doc.connections : [];
  colmap = Array.isArray(doc.colmap) ? doc.colmap : null;
  render();
}

// Don't let a server read stomp a reorder that hasn't round-tripped yet — the
// same guard vault.html applies to its own Keychain snapshot listener.
// Key-ORDER-insensitive serialisation. The document round-trips through
// Firestore's REST shape, whose `mapValue.fields` key order is not guaranteed
// stable between reads, so a plain JSON.stringify compare reported "changed"
// for two byte-identical documents. Every false positive rebuilt the list, and
// rebuilding the list is what threw a scrolled-down user back to the top.
function stableJson(v) {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort()
      .map(k => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

// True while the user is mid-gesture. A card drag holds live references into
// the DOM and a rail drag is measuring it, so a poll must not rebuild under
// either — the next one, five seconds later, will pick the change up.
function interacting() {
  return !!document.querySelector(".card-fly") || /resizing-/.test(document.body.className);
}

function applyRemote(doc) {
  if (Date.now() - lastOwnSaveAt < ECHO_MS) return;
  if (interacting()) return;
  if (stableJson({ c: connections, m: colmap }) ===
      stableJson({ c: doc.connections, m: doc.colmap })) return;
  apply(doc);
}

(async () => {
  // Paint from the cached document first so the popup never opens empty, then
  // reconcile against the worker.
  try {
    const cached = await VaultDB.readCache();
    if (cached && cached.connections.length) { apply(cached); setSync("", "Synced with Keychain"); }
  } catch (_) {}

  try {
    const doc = await VaultDB.refresh();
    if (loadingEl.style.display !== "none") apply(doc);
    else applyRemote(doc);
    setSync("", "Synced with Keychain");
  } catch (e) {
    console.error(e);
    if (!connections.length) {
      loadingEl.style.display = "none";
      groupsEl.innerHTML = `<div class="empty">Couldn't reach Keychain.<br />Check your connection and reopen.</div>`;
    }
    setSync("error", "Offline");
  }

  // Keep the open popup live: an edit made in the Vault app shows up here
  // without closing and reopening.
  pollTimer = setInterval(async () => {
    try { applyRemote(await VaultDB.refresh()); } catch (_) {}
  }, POLL_MS);
})();

window.addEventListener("unload", () => { if (pollTimer) clearInterval(pollTimer); });
