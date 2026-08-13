// Launcher popup — reads Veda's Links document, renders each connection as a
// card, launches links (one, or a whole card as a named tab group), and writes
// card ORDER back. Creating/editing/deleting links lives entirely in the Links
// program (Index → Veda → Links); the gear opens it.

const groupsEl  = document.getElementById("groups");
const loadingEl = document.getElementById("loading");
const syncEl    = document.getElementById("sync");
const toastEl   = document.getElementById("toast");
const appEl     = document.getElementById("app");
const scrollEl  = document.getElementById("scroll");
const gearEl    = document.getElementById("gear");
const toggleEl  = document.getElementById("reorder-toggle");

// Deep link straight to Veda → Links inside Index. index.html reads ?goto=links
// on boot, selects Veda's profile (honouring the profile/app locks) and opens
// the Links program — the same trick Vault's popup uses with ?vaulttab=.
const INDEX_LINKS_URL = "https://anthonyn99.github.io/A1/index.html?goto=links";

// Same palette Links uses for connection colours, so cards match exactly.
const CD = ['#f1b0c4','#f6c29e','#f1e19e','#cfe39c','#a9dcb4','#9bd8d0','#a3c8ec','#c3aee6',
            '#e795ae','#f0ac7e','#e7d07e','#b9d683','#8fc99c','#82c6be','#8aafe2','#ab92dc'];

const SIZE_KEY    = "launcher_popup_size";
const REORDER_KEY = "launcher_reorder_mode";
// Column sizing. The cards wrap into a second column as soon as two columns of
// at least COL_MIN_W fit, and never into a third: the Links program is itself a
// two-column layout, so its saved colmap only ever holds 0 or 1 and a third
// column here would always be empty. COL2_MIN is the resulting #app width at
// which the split happens — the same 560px the old fixed layout used, so
// existing colmap positions carry over unchanged.
const COL_MIN_W   = 240;
const MAX_COLS    = 2;
const COL2_MIN    = 560;
const POLL_MS     = 5000;   // live refresh cadence while the popup is open
const ECHO_MS     = 8000;   // ignore server reads for this long after our own save

let connections = [];
let colmap = null;
let lastCols = 0;
let lastOwnSaveAt = 0;
let reorderMode = false;
let dragCtl = null;
let pollTimer = null;

const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const GRIP_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="6" cy="3" r="1.5"/><circle cx="10" cy="3" r="1.5"/><circle cx="6" cy="8" r="1.5"/><circle cx="10" cy="8" r="1.5"/><circle cx="6" cy="13" r="1.5"/><circle cx="10" cy="13" r="1.5"/></svg>';

// How many columns to lay out at the current popup width. Measured from the
// real content box when it is available (so the padding/scrollbar are already
// accounted for), falling back to #app's width before first paint.
function colCount() {
  const inner = groupsEl.clientWidth || (appEl.offsetWidth - 41);
  const fits  = Math.floor((inner + 10) / (COL_MIN_W + 10));
  const byWidth = appEl.offsetWidth >= COL2_MIN ? 2 : 1;
  return Math.max(1, Math.min(MAX_COLS, fits, byWidth));
}

// ── Persisted, user-adjustable popup size ────────────────────────────────────
chrome.storage.local.get([SIZE_KEY, REORDER_KEY], (d) => {
  const s = d && d[SIZE_KEY];
  if (s && s.w && s.h) { appEl.style.width = s.w + "px"; appEl.style.height = s.h + "px"; }
  setReorder(!!(d && d[REORDER_KEY]), false);

  let t = null;
  new ResizeObserver(() => {
    // Re-flow whenever the grid gains or loses a column as the popup is dragged.
    const cols = colCount();
    if (cols !== lastCols && connections.length) render();
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      chrome.storage.local.set({
        [SIZE_KEY]: { w: Math.round(appEl.offsetWidth), h: Math.round(appEl.offsetHeight) }
      });
    }, 300);
  }).observe(appEl);
});

// ── Drag-to-resize grip ──────────────────────────────────────────────────────
// screenX/Y deltas, so resizing stays stable however the popup re-anchors as it
// grows. The ResizeObserver above handles reflow + saving.
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

// ── Helpers ──────────────────────────────────────────────────────────────────

// Map any stored colour to the nearest pastel in CD by hue (non-destructive —
// mirrors index.html's _pastelize so Launcher matches Links exactly).
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

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), 1400);
}

function setSync(state, text) {
  syncEl.className = "sync" + (state ? " " + state : "");
  syncEl.textContent = text || "";
}

// Open one or more links. When `group` is set (a multi-link launch), the
// background wraps them in a named, colour-matched browser tab group.
function openUrls(urls, group) {
  const clean = urls.filter(Boolean);
  if (!clean.length) return;
  const msg = { action: "openLinks", urls: clean };
  if (group) { msg.group = true; msg.groupName = group.name || ""; msg.groupColor = group.color || ""; }
  chrome.runtime.sendMessage(msg, () => window.close());
}

// ── Render ───────────────────────────────────────────────────────────────────

function buildCard(conn, ci) {
  const color = conn.color ? pastelize(conn.color) : CD[ci % CD.length];
  const links = LauncherDB.linksOf(conn);

  const card = document.createElement("div");
  card.className = "card";
  card.style.setProperty("--card-accent", color);
  card.dataset.ci = String(ci);

  const linkRows = links.map(l => `
    <div class="link-row">
      <img class="favicon" src="${faviconUrl(l.url)}" width="16" height="16" alt="" loading="lazy">
      <span class="link-name" title="${esc(l.url)}">${esc(l.name)}</span>
      <button class="icon-btn visit" data-url="${esc(l.url)}">Visit</button>
      <button class="icon-btn copy" data-copy="${esc(l.url)}" title="Copy link">${COPY_SVG}</button>
    </div>`).join("");

  // Group-launch only for 2+ links — a single link already has its own Visit.
  const openGroupBtn = links.length > 1
    ? `<button class="open-group" data-group="${ci}" title="Open all ${links.length} links as a tab group">Open ${links.length} Tabs</button>`
    : "";

  card.innerHTML = `
    <div class="card-top">
      <div class="card-headline">
        <span class="grip" data-role="card-grip" title="Drag to reorder">${GRIP_SVG}</span>
        <div class="card-name">${esc(conn.name || "Untitled")}</div>
      </div>
      ${openGroupBtn}
    </div>
    <div class="links">${linkRows}</div>`;
  return card;
}

function render() {
  loadingEl.style.display = "none";
  groupsEl.innerHTML = "";

  // Only groups that actually contain links, keeping their original index so
  // colmap placement, open-group wiring and reorder writes stay correct.
  const visible = connections
    .map((conn, ci) => ({ conn, ci }))
    .filter(({ conn }) => LauncherDB.linksOf(conn).length > 0);

  if (!visible.length) {
    groupsEl.innerHTML = `<div class="empty">No links yet.<br />Add them in the Links program — they sync here automatically.<br /><a id="empty-open">Open Links</a></div>`;
    const a = document.getElementById("empty-open");
    if (a) a.addEventListener("click", openIndexLinks);
    return;
  }

  // Lay the grid out at the column count the current width supports, and drive
  // the CSS from the same number so layout and distribution can never disagree.
  // At 2 columns honour the colmap Links saved, so a card keeps the position
  // Veda gave it in the Links program.
  const cols = colCount();
  groupsEl.style.setProperty("--cols", String(cols));
  lastCols = cols;
  const colDivs = Array.from({ length: cols }, () => {
    const d = document.createElement("div");
    d.className = "col";
    return d;
  });
  const perCol = Math.ceil(visible.length / cols);
  visible.forEach(({ conn, ci }, vi) => {
    let colIdx;
    if (cols >= 2 && Array.isArray(colmap) && typeof colmap[ci] === "number") {
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
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast("Copied"), () => toast("Copy failed"));
    }));
  groupsEl.querySelectorAll(".open-group").forEach(b =>
    b.addEventListener("click", () => {
      const conn = connections[+b.dataset.group];
      const links = LauncherDB.linksOf(conn);
      const color = conn.color ? pastelize(conn.color) : CD[(+b.dataset.group) % CD.length];
      openUrls(links.map(l => l.url), { name: conn.name || "Group", color });
    }));

  if (dragCtl) dragCtl.rebind();
  else dragCtl = LauncherDrag.enable(groupsEl, {
    scroller: scrollEl,
    isEnabled: () => reorderMode,
    onDrop: persistOrder
  });
}

// ── Reorder → write back to Links ────────────────────────────────────────────

function setReorder(on, persist) {
  reorderMode = !!on;
  appEl.classList.toggle("reorder", reorderMode);
  toggleEl.setAttribute("aria-checked", reorderMode ? "true" : "false");
  if (persist !== false) chrome.storage.local.set({ [REORDER_KEY]: reorderMode });
}
toggleEl.addEventListener("click", () => setReorder(!reorderMode, true));

// `order` holds the ORIGINAL connection indices in their new DOM order, and only
// covers the cards that are rendered — cards with no links are filtered out of
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
  // truth. At one column it does not: writing "everything in column 0" would
  // flatten Veda's two-column layout in the Links program the next time she
  // opens it. So a one-column reorder carries each card's EXISTING column
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
    newMap = null;   // Links falls back to reading-order distribution
  }

  connections = reordered;
  colmap = newMap;
  render();

  lastOwnSaveAt = Date.now();
  setSync("saving", "Syncing…");
  LauncherDB.save({ connections, colmap })
    .then(() => {
      lastOwnSaveAt = Date.now();
      LauncherDB.writeCache({ connections, colmap, savedAt: Date.now() });
      setSync("ok", "✓ Synced");
      setTimeout(() => { if (syncEl.textContent === "✓ Synced") setSync("", "Synced with Links"); }, 2200);
    })
    .catch(() => setSync("error", "⚠ Sync failed"));
}

// ── Load + live refresh ──────────────────────────────────────────────────────

function apply(doc) {
  connections = Array.isArray(doc.connections) ? doc.connections : [];
  colmap = Array.isArray(doc.colmap) ? doc.colmap : null;
  render();
}

// Don't let a server read stomp a reorder that hasn't round-tripped yet — the
// same guard the Links program applies to its own snapshot listener.
function applyRemote(doc) {
  if (Date.now() - lastOwnSaveAt < ECHO_MS) return;
  const before = JSON.stringify({ c: connections, m: colmap });
  const after  = JSON.stringify({ c: doc.connections, m: doc.colmap });
  if (before === after) return;
  apply(doc);
}

async function boot() {
  // Paint from the cached document first so the popup never opens empty, then
  // reconcile against the worker.
  try {
    const cached = await LauncherDB.readCache();
    if (cached && cached.connections.length) { apply(cached); setSync("", "Synced with Links"); }
  } catch (_) {}

  try {
    const doc = await LauncherDB.refresh();
    applyRemote(doc);
    if (loadingEl.style.display !== "none") apply(doc);
    setSync("", "Synced with Links");
  } catch (e) {
    if (!connections.length) {
      loadingEl.style.display = "none";
      groupsEl.innerHTML = `<div class="empty">Couldn't reach Links.<br />Check your connection and reopen.</div>`;
    }
    setSync("error", "Offline");
  }

  // Keep the open popup live: an edit made in the Links program shows up here
  // without closing and reopening.
  pollTimer = setInterval(async () => {
    try { applyRemote(await LauncherDB.refresh()); } catch (_) {}
  }, POLL_MS);
}

window.addEventListener("unload", () => { if (pollTimer) clearInterval(pollTimer); });

// The worker does the real work — it can see window types and inject the hash
// nudge, so an installed Index PWA is reused (and steered straight to Links)
// instead of Index being opened again in a browser tab. See background.js.
//
// If the worker is unreachable (lastError) or reports failure, open a plain tab
// here so the gear always does something. window.close() runs on every path.
function openIndexLinks() {
  let done = false;
  const finish = (fallback) => {
    if (done) return;
    done = true;
    if (fallback) { try { chrome.tabs.create({ url: INDEX_LINKS_URL }); } catch (_) {} }
    window.close();
  };
  // A service worker that has to cold-start can be slow; don't hang the gear.
  const t = setTimeout(() => finish(true), 1500);
  try {
    chrome.runtime.sendMessage({ action: "openIndexLinks" }, (resp) => {
      clearTimeout(t);
      finish(!!chrome.runtime.lastError || !(resp && resp.ok));
    });
  } catch (_) {
    clearTimeout(t);
    finish(true);
  }
}
gearEl.addEventListener("click", openIndexLinks);

boot();
