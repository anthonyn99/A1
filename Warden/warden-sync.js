// ─────────────────────────────────────────────────────────────────────────────
// Warden Launcher ← Links shared backend (client side).
//
// Warden Launcher keeps NO database of its own. It reads — and writes card ORDER
// back to — the single Firestore document the Warden app's Links tab uses:
//
//     dashboards/warden_links  →  { connections, colmap, savedAt }
//
// A "connection" is a group:  { name, color, items: [ ... ] }, where items of
// type:'link' are { type:'link', name, url }. Links also stores email /
// phone / username / info / doc items — a reorder saved from here round-trips
// those untouched, so it never drops data the popup does not render.
//
// Everything ELSE about a connection (adding, renaming, recolouring, deleting
// links) still lives only in the Warden app. Order is the one thing this popup
// may change.
//
// The Firebase project enforces App Check (reCAPTCHA v3), which a browser
// extension cannot satisfy, so this does NOT hit Firestore directly. It goes
// through the `keychain-sync` Cloudflare Worker, whose Firebase service account
// bypasses App Check + rules. Same source of truth, both directions: warden.html
// listens on this document with onSnapshot, so a PUT from here lands in an open
// Warden tab within a second.
// ─────────────────────────────────────────────────────────────────────────────

const WardenDB = (() => {
  // The keychain-sync Worker endpoint + shared key (also set as the worker's
  // WARDEN_KEY secret). See workers/keychain-sync and Warden/README.md.
  // From warden-config.js, which every context loads first.
  const _C = (self.WARDEN_CFG || {});
  const WORKER_URL = _C.LINKS_URL || "";
  const WARDEN_KEY  = _C.WORKER_KEY || "";

  // Last good payload, so the popup paints instantly instead of showing a
  // spinner on every open, and still shows something useful when offline.
  const CACHE_KEY = "warden_keychain_cache";

  function normalizeDoc(d) {
    return {
      connections: Array.isArray(d && d.connections) ? d.connections : [],
      colmap: Array.isArray(d && d.colmap) ? d.colmap : null,
      savedAt: (d && d.savedAt) || 0
    };
  }

  async function load() {
    const r = await fetch(WORKER_URL, {
      headers: { "X-Warden-Key": WARDEN_KEY },
      cache: "no-store"
    });
    if (!r.ok) throw new Error("Warden load failed: " + r.status + " " + (await safeText(r)));
    return normalizeDoc(await r.json());
  }

  // Write back. Only ORDER changes originate here (card drag-and-drop), but the
  // whole connections array is sent because the document is written whole —
  // exactly as the Warden app's Keychain writes it.
  async function save(state) {
    const body = {
      connections: Array.isArray(state.connections) ? state.connections : [],
      colmap: Array.isArray(state.colmap) && state.colmap.length ? state.colmap : null
    };
    const r = await fetch(WORKER_URL, {
      method: "PUT",
      headers: { "X-Warden-Key": WARDEN_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error("Warden save failed: " + r.status + " " + (await safeText(r)));
    return await r.json();
  }

  // Pull just the launchable link items out of a connection (group).
  function linksOf(conn) {
    return ((conn && conn.items) || [])
      .filter(it => it && it.type === "link" && it.url)
      .map(it => ({ name: it.name || it.url, url: it.url }));
  }

  async function readCache() {
    try {
      const d = await chrome.storage.local.get(CACHE_KEY);
      return d && d[CACHE_KEY] ? normalizeDoc(d[CACHE_KEY]) : null;
    } catch (_) { return null; }
  }

  async function writeCache(doc) {
    try { await chrome.storage.local.set({ [CACHE_KEY]: normalizeDoc(doc) }); } catch (_) {}
  }

  // Fetch and cache in one step.
  async function refresh() {
    const doc = await load();
    await writeCache(doc);
    return doc;
  }

  async function safeText(r) { try { return await r.text(); } catch { return ""; } }

  return { load, save, refresh, linksOf, readCache, writeCache, CACHE_KEY, WORKER_URL };
})();

if (typeof globalThis !== "undefined") globalThis.WardenDB = WardenDB;
