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

// The popup size lives in launcher-size.js (LauncherSize.KEY) — it has to be
// restored before <body> is parsed, so it cannot live here.
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
// HYSTERESIS on the split: two columns at 560px, but it doesn't fold back until
// 530px. Without the dead band, easing the width rail across the threshold
// re-rendered every card on alternate frames, which is what made the drag feel
// like it was seizing up.
function colCount() {
  const w = appEl.offsetWidth;
  const inner = groupsEl.clientWidth || (w - 41);
  const fits  = Math.floor((inner + 10) / (COL_MIN_W + 10));
  const byWidth = lastCols >= 2 ? (w < COL2_MIN - 30 ? 1 : 2) : (w >= COL2_MIN ? 2 : 1);
  return Math.max(1, Math.min(MAX_COLS, fits, byWidth));
}

// ── Popup size ───────────────────────────────────────────────────────────────
// launcher-size.js owns this — it already restored the saved size from
// localStorage before <body> was parsed, so the popup opens at the right size
// instead of being resized after the fact. Everything here just drives it.

// On a phone the popup is a full-width sheet, not a floating panel, and the CSS
// hands <html> over to the viewport. An inline size would outrank that media
// query, so on a sheet we leave the element alone entirely.
const IS_SHEET = window.matchMedia("(pointer:coarse) and (max-width:420px)").matches;
if (IS_SHEET) {
  document.documentElement.style.width = "";
  document.documentElement.style.height = "";
}

chrome.storage.local.get([LauncherSize.KEY, REORDER_KEY], (d) => {
  // Only used when localStorage had nothing — a size saved by an older build,
  // or a profile whose localStorage was cleared. Normally a no-op.
  if (!IS_SHEET && LauncherSize.adoptStored(d && d[LauncherSize.KEY])) render();

  setReorder(!!(d && d[REORDER_KEY]), false);

  // Re-flow whenever the grid gains or loses a column.
  new ResizeObserver(() => {
    const cols = colCount();
    if (cols !== lastCols && connections.length) render();
  }).observe(appEl);
});

// ── Resize rails: one per axis ───────────────────────────────────────────────
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
// write itself is throttled inside launcher-size.js — localStorage is
// synchronous, and writing it every frame was enough to make the drag stutter.
function makeRail(el, axis) {
  let drag = null, raf = 0, next = null;

  const flush = () => {
    raf = 0;
    if (!next) return;
    LauncherSize.apply(next.w, next.h);
    next = null;
    LauncherSize.save();
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
    const base = next || { w: LauncherSize.w, h: LauncherSize.h };
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
    LauncherSize.save(true);
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
  afterFrames(2, () => LauncherSize.apply(LauncherSize.w, LauncherSize.h));
}

function afterFrames(n, fn) {
  const step = () => (--n <= 0 ? fn() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}

if (!IS_SHEET) {
  makeRail(document.getElementById("resize-x"), "x");
  makeRail(document.getElementById("resize-y"), "y");
}

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
  "riftiq.html":    "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2096%2096'%3E%3Crect%20width%3D'96'%20height%3D'96'%20rx%3D'22'%20fill%3D'%2316161c'%2F%3E%3Cpath%20d%3D'M48%2019%2073%2033.5v29L48%2077%2023%2062.5v-29Z'%20fill%3D'none'%20stroke%3D'%235a5a68'%20stroke-width%3D'4'%20stroke-linejoin%3D'round'%2F%3E%3Cpath%20d%3D'M48%2026l5%2012v18H43V38Z'%20fill%3D'%23c0aeea'%2F%3E%3Crect%20x%3D'33'%20y%3D'56'%20width%3D'30'%20height%3D'6'%20rx%3D'3'%20fill%3D'%23dbd0f5'%2F%3E%3Crect%20x%3D'45'%20y%3D'62'%20width%3D'6'%20height%3D'11'%20rx%3D'3'%20fill%3D'%2383838f'%2F%3E%3C%2Fsvg%3E", // RiftIQ
  "warroom.html":   "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2096%2096'%3E%3Crect%20width%3D'96'%20height%3D'96'%20rx%3D'22'%20fill%3D'%2316161c'%2F%3E%3Cpath%20d%3D'M48%2019%2073%2033.5v29L48%2077%2023%2062.5v-29Z'%20fill%3D'none'%20stroke%3D'%235a5a68'%20stroke-width%3D'4'%20stroke-linejoin%3D'round'%2F%3E%3Cpath%20d%3D'M48%2026l5%2012v18H43V38Z'%20fill%3D'%23c0aeea'%2F%3E%3Crect%20x%3D'33'%20y%3D'56'%20width%3D'30'%20height%3D'6'%20rx%3D'3'%20fill%3D'%23dbd0f5'%2F%3E%3Crect%20x%3D'45'%20y%3D'62'%20width%3D'6'%20height%3D'11'%20rx%3D'3'%20fill%3D'%2383838f'%2F%3E%3C%2Fsvg%3E", // RiftIQ (old name)
  "shield.html":    "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2096%2096'%3E%3Crect%20width%3D'96'%20height%3D'96'%20rx%3D'22'%20fill%3D'%231a1a1d'%2F%3E%3Cg%20fill%3D'none'%20stroke-width%3D'5'%20stroke-linecap%3D'round'%20stroke-linejoin%3D'round'%3E%3Cpath%20d%3D'M48%2014%2022%2023v24c0%2017%2013%2028%2026%2035'%20stroke%3D'%23e0b874'%2F%3E%3Cpath%20d%3D'M48%2014%2074%2023v24c0%2017-13%2028-26%2035'%20stroke%3D'%238D769A'%2F%3E%3Ccircle%20cx%3D'48'%20cy%3D'42'%20r%3D'7'%20stroke%3D'%23adadb2'%2F%3E%3Cpath%20d%3D'M48%2049v11'%20stroke%3D'%23adadb2'%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", // Shield
  "warden.html":    "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2096%2096'%3E%3Crect%20width%3D'96'%20height%3D'96'%20rx%3D'22'%20fill%3D'%231B1C1E'%2F%3E%3Cg%20fill%3D'none'%20stroke%3D'%238D769A'%20stroke-width%3D'5'%20stroke-linecap%3D'round'%20stroke-linejoin%3D'round'%3E%3Crect%20x%3D'22'%20y%3D'42'%20width%3D'52'%20height%3D'34'%20rx%3D'7'%2F%3E%3Cpath%20d%3D'M33%2042v-9a15%2015%200%200%201%2030%200v9'%2F%3E%3Cpath%20d%3D'M48%2055v8'%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E", // Warden
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

function renderList() {
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
