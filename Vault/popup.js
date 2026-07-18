// Vault popup — reads the shared Keychain document, renders each connection as
// a group, and launches links (a single link or a whole group). Link editing
// lives entirely in TaskHub → Keychain; Vault only displays and opens.

const groupsEl  = document.getElementById("groups");
const loadingEl = document.getElementById("loading");
const syncEl    = document.getElementById("sync");
const toastEl   = document.getElementById("toast");

// TaskHub PWA, deep-linked straight to the Keychain program. The ?goto=keychain
// query (not just a #hash) forces a real navigation so the deep link fires even
// when the installed PWA is already open and gets re-navigated (launch_handler:
// navigate-existing). Opens in the desktop app if the browser routes it there,
// otherwise a browser tab.
const TASKHUB_KEYCHAIN_URL = "https://anthonyn99.github.io/A1/?goto=keychain";
// Deep-link straight to Vault → Passwords in the TaskHub PWA (where credentials
// are created/edited). The ?goto=keychain query opens the Vault program and
// vaulttab=passwords selects the Passwords tab (handled by vault-ui.js).
const TASKHUB_VAULT_PW_URL = "https://anthonyn99.github.io/A1/?goto=keychain&vaulttab=passwords";

// ── Persisted, user-adjustable popup size ──
// #app has CSS `resize:both`; drag its bottom-right corner to resize. We restore
// the last size on open and save changes (debounced).
const appEl = document.getElementById("app");
const SIZE_KEY = "vault_popup_size";
chrome.storage.local.get(SIZE_KEY, (d) => {
  const s = d && d[SIZE_KEY];
  if (s && s.w && s.h) {
    appEl.style.width = s.w + "px";
    appEl.style.height = s.h + "px";
  }
  let t = null;
  new ResizeObserver(() => {
    // Re-flow into 1 or 2 columns as the width crosses the threshold.
    const cols = appEl.offsetWidth >= COL2_MIN ? 2 : 1;
    if (cols !== lastCols && connections.length) render();
    // Debounced size save.
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      chrome.storage.local.set({
        [SIZE_KEY]: { w: Math.round(appEl.offsetWidth), h: Math.round(appEl.offsetHeight) }
      });
    }, 300);
  }).observe(appEl);
});

// ── Big drag-to-resize grip ──
// Uses screenX/Y deltas so resizing stays stable no matter how the popup window
// re-anchors as it grows. The ResizeObserver above handles reflow + saving.
const gripEl = document.getElementById("resize-grip");
let grip = null;
gripEl.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  grip = { sx: e.screenX, sy: e.screenY, w: appEl.offsetWidth, h: appEl.offsetHeight };
  try { gripEl.setPointerCapture(e.pointerId); } catch (_) {}
});
gripEl.addEventListener("pointermove", (e) => {
  if (!grip) return;
  appEl.style.width  = Math.max(300, Math.min(780, grip.w + (e.screenX - grip.sx))) + "px";
  appEl.style.height = Math.max(240, Math.min(590, grip.h + (e.screenY - grip.sy))) + "px";
});
const endGrip = (e) => { grip = null; try { gripEl.releasePointerCapture(e.pointerId); } catch (_) {} };
gripEl.addEventListener("pointerup", endGrip);
gripEl.addEventListener("pointercancel", endGrip);

// Same palette Keychain uses for connection colours, for a consistent look.
const CD = ['#f1b0c4','#f6c29e','#f1e19e','#cfe39c','#a9dcb4','#9bd8d0','#a3c8ec','#c3aee6','#e795ae','#f0ac7e','#e7d07e','#b9d683','#8fc99c','#82c6be','#8aafe2','#ab92dc'];

let connections = [];
let colmap = null;          // Keychain's column map (index-aligned to connections)
let lastCols = 0;           // last-rendered column count (to re-render on width change)
const COL2_MIN = 560;       // px width of #app at/above which we go to 2 columns

const COPY_SVG ='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

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

// Official site icon (like a browser bookmark), via Google's favicon service.
function faviconUrl(url) {
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).hostname;
    return "https://www.google.com/s2/favicons?sz=32&domain=" + encodeURIComponent(host);
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
    ? `<button class="open-group" data-group="${ci}" title="Open all ${links.length} links as a tab group">Open ${links.length} tabs</button>`
    : "";

  card.innerHTML = `
    <div class="card-top">
      <div class="card-name">${esc(conn.name || "Untitled")}</div>
      ${openGroupBtn}
    </div>
    ${linkRows}`;
  return card;
}

function render() {
  loadingEl.style.display = "none";
  groupsEl.innerHTML = "";

  // Only groups that actually contain links, keeping their original index so
  // colmap placement and open-group wiring stay correct.
  const visible = connections
    .map((conn, ci) => ({ conn, ci }))
    .filter(({ conn }) => VaultDB.linksOf(conn).length > 0);

  if (!visible.length) {
    groupsEl.innerHTML = `<div class="empty">No link groups yet.<br />Add links in TaskHub → Keychain (⚙) — they sync here automatically.</div>`;
    return;
  }

  // 1 column when narrow, 2 when widened — mirrors Keychain. When at 2 columns
  // and Keychain saved a colmap, place cards in the exact same columns/order;
  // otherwise fill top-to-bottom in reading order.
  const cols = appEl.offsetWidth >= COL2_MIN ? 2 : 1;
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
}

// ── Tabs + tab-aware settings button ──
// Links tab: the gear opens TaskHub → Keychain (all link management lives there).
// Passwords tab: the gear opens Vault's own settings page.
let activeTab = "links";
const gearEl = document.getElementById("gear");

function setActiveTab(name) {
  activeTab = name;
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.panel === name));
  document.getElementById("panel-links").classList.toggle("hidden", name !== "links");
  document.getElementById("panel-passwords").classList.toggle("hidden", name !== "passwords");
  gearEl.title = name === "passwords" ? "Manage passwords in TaskHub → Vault" : "Open Keychain in TaskHub";
  // Render the Passwords panel (unlock / list / autofill) on first open.
  if (name === "passwords" && window.VaultPWPanel) window.VaultPWPanel.render();
}

document.querySelectorAll(".tab").forEach(tab =>
  tab.addEventListener("click", () => setActiveTab(tab.dataset.panel)));

gearEl.addEventListener("click", () => {
  // Passwords tab → open TaskHub → Vault → Passwords (where you manage them).
  // Links tab → open TaskHub → Keychain. (No more unused options page.)
  chrome.tabs.create({ url: activeTab === "passwords" ? TASKHUB_VAULT_PW_URL : TASKHUB_KEYCHAIN_URL });
  window.close();
});

// ── Load from the shared Keychain doc ──
(async () => {
  try {
    const data = await VaultDB.load();
    connections = Array.isArray(data.connections) ? data.connections : [];
    colmap = Array.isArray(data.colmap) ? data.colmap : null;
    render();
    syncEl.textContent = "Synced with Keychain";
  } catch (e) {
    console.error(e);
    loadingEl.style.display = "none";
    groupsEl.innerHTML = `<div class="empty">Couldn't reach Keychain.<br />Check your connection and reopen.</div>`;
    syncEl.textContent = "Offline";
    syncEl.classList.add("error");
  }
})();
