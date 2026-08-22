// ─────────────────────────────────────────────────────────────────────────────
// Warden Launcher popup size.
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

const WardenSize = (() => {
  const KEY = "warden_popup_size";
  // Browsers cap popups at 800x600, so the maxima stay just under.
  //
  // The default opens NEAR the full allowed height: this popup is a list, and
  // the only thing a short default achieved was hiding the second card behind a
  // scroll. The vertical minimum is high for the same reason — below roughly
  // one card plus the header and tabs there is nothing left to look at, so
  // shrinking further is not a size anyone wants, just a way to break the view.
  const MIN_W = 300, MAX_W = 780;
  const MIN_H = 430, MAX_H = 590;
  const DEF_W = 344, DEF_H = 580;

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
  // BOTH stores are throttled, for different reasons:
  //
  //   localStorage is SYNCHRONOUS. Writing it on every animation frame of a
  //   resize drag — 60 to 120 times a second — is enough on its own to make the
  //   drag stutter, because each write blocks the frame it is on. 150ms is far
  //   inside the time a popup takes to dismiss, so a gesture cut short still
  //   keeps its size, and the flush handlers below close the gap entirely.
  //
  //   chrome.storage.local has a per-minute write quota, so it is slower still.
  let lsTimer = 0, csTimer = 0;

  function writeLocal() {
    lsTimer = 0;
    try { localStorage.setItem(KEY, JSON.stringify({ w, h })); } catch (_) {}
  }
  function writeSynced() {
    csTimer = 0;
    try { chrome.storage.local.set({ [KEY]: { w, h } }); } catch (_) {}
  }

  function save(immediate) {
    if (immediate) {
      if (lsTimer) { clearTimeout(lsTimer); }
      if (csTimer) { clearTimeout(csTimer); }
      writeLocal(); writeSynced();
      return;
    }
    if (!lsTimer) lsTimer = setTimeout(writeLocal, 150);
    if (!csTimer) csTimer = setTimeout(writeSynced, 600);
  }

  // A popup is dismissed the instant it loses focus, which can land between two
  // throttled writes. Flushing here means the size is never more than the last
  // frame stale, without paying for a write on every frame.
  addEventListener("pagehide", () => save(true));
  addEventListener("blur", () => save(true));
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save(true);
  });

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

if (typeof globalThis !== "undefined") globalThis.WardenSize = WardenSize;
