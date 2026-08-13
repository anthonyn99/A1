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
const hintEl    = document.getElementById("reorder-hint");
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

// ── Persisted, user-adjustable popup size ──
// #app has CSS `resize:both`; drag its bottom-right corner to resize. We restore
// the last size on open and save changes (debounced).
const appEl = document.getElementById("app");
const SIZE_KEY = "vault_popup_size";
const REORDER_KEY = "vault_reorder_mode";
chrome.storage.local.get([SIZE_KEY, REORDER_KEY], (d) => {
  const s = d && d[SIZE_KEY];
  if (s && s.w && s.h) {
    appEl.style.width = s.w + "px";
    appEl.style.height = s.h + "px";
  }
  // Reorder is sticky: leave it on and the grips are there next time.
  setReorder(!!(d && d[REORDER_KEY]), false);
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

function render() {
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

  // The grips are recreated on every render, so the drag module has to rebind.
  if (dragCtl) dragCtl.rebind();
  else dragCtl = VaultCardDrag.enable(groupsEl, {
    scroller: scrollEl,
    isEnabled: () => reorderMode,
    onDrop: persistOrder
  });
}

// ── Reorder → write back to Keychain ─────────────────────────────────────────

function setReorder(on, persist) {
  reorderMode = !!on;
  appEl.classList.toggle("reorder", reorderMode);
  toggleEl.setAttribute("aria-checked", reorderMode ? "true" : "false");
  hintEl.textContent = reorderMode
    ? "Drag a card by its grip"
    : "Rearrange your connection cards";
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
function applyRemote(doc) {
  if (Date.now() - lastOwnSaveAt < ECHO_MS) return;
  const before = JSON.stringify({ c: connections, m: colmap });
  const after  = JSON.stringify({ c: doc.connections, m: doc.colmap });
  if (before === after) return;
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
