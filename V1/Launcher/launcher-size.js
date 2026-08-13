// ─────────────────────────────────────────────────────────────────────────────
// Launcher popup size.
//
// WHY THIS IS A SEPARATE FILE, LOADED FROM <head>
// The browser measures this document exactly once — as the popup opens — to
// decide how big to make the popup window. An async chrome.storage callback
// answers long after that measurement, so the window was already stuck at the
// CSS default and the saved size looked like it reset on every reopen. This
// file runs from <head>, before <body> is parsed, and reads localStorage: the
// only store that can answer synchronously. chrome.storage.local is kept as the
// durable mirror (and as the migration path for sizes saved by older builds).
//
// MV3's extension CSP forbids inline <script>, so this cannot just be a few
// lines in the page — it has to be a file.
//
// WHAT CARRIES THE SIZE
// <html> is the sized element. #app fills it at 100%/100% and is deliberately
// NOT viewport-locked — no `position:fixed; inset:0`, no 100vw/100vh. An
// element pinned to the viewport holds the document's preferred size at the
// window's CURRENT size, which pins the window open at its widest: the popup
// could then be dragged out but never back in.
// ─────────────────────────────────────────────────────────────────────────────

const LauncherSize = (() => {
  const KEY = "launcher_popup_size";
  const MIN_W = 300, MAX_W = 780;     // browsers cap popups at 800x600
  const MIN_H = 240, MAX_H = 590;
  const DEF_W = 352, DEF_H = 520;

  let w = DEF_W, h = DEF_H;

  const clampW = (v) => Math.round(Math.max(MIN_W, Math.min(MAX_W, v)));
  const clampH = (v) => Math.round(Math.max(MIN_H, Math.min(MAX_H, v)));

  function apply(nw, nh) {
    w = clampW(nw); h = clampH(nh);
    const s = document.documentElement.style;
    s.width = w + "px";
    s.height = h + "px";
    return { w, h };
  }

  // ── Synchronous restore, at parse time ──
  let restored = false;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && saved.w && saved.h) { apply(saved.w, saved.h); restored = true; }
  } catch (_) {}
  if (!restored) apply(DEF_W, DEF_H);

  // ── Persistence ──
  // localStorage is written every time (it is what the next open reads, and it
  // is synchronous, so a popup dismissed mid-drag still keeps the new size).
  // chrome.storage.local has a per-minute write quota, so it is throttled.
  let lastWrite = 0, pending = 0;

  function save(immediate) {
    try { localStorage.setItem(KEY, JSON.stringify({ w, h })); } catch (_) {}
    const now = Date.now();
    if (!immediate && now - lastWrite < 500) {
      if (!pending) pending = setTimeout(() => { pending = 0; save(true); }, 500);
      return;
    }
    if (pending) { clearTimeout(pending); pending = 0; }
    lastWrite = now;
    try { chrome.storage.local.set({ [KEY]: { w, h } }); } catch (_) {}
  }

  // One-time migration for a size saved by a build that only wrote
  // chrome.storage. Applied late (the window is already open), but it seeds
  // localStorage so every subsequent open is correct from the first layout.
  function adoptStored(v) {
    if (restored || !v || !v.w || !v.h) return false;
    apply(v.w, v.h);
    restored = true;
    save(true);
    return true;
  }

  return {
    KEY, MIN_W, MAX_W, MIN_H, MAX_H, DEF_W, DEF_H,
    get w() { return w; },
    get h() { return h; },
    get restored() { return restored; },
    apply, save, adoptStored
  };
})();

if (typeof globalThis !== "undefined") globalThis.LauncherSize = LauncherSize;
