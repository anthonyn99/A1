// ─────────────────────────────────────────────────────────────────────────────
// Launcher ← Links shared backend (client side).
//
// Launcher keeps NO database of its own. It reads — and writes card ORDER back
// to — the single Firestore document Veda's Links program uses:
//
//     dashboards/veda_links  →  { connections, colmap, savedAt }
//
// A "connection" is a group:  { name, color, items: [ ... ] }, where items of
// type:'link' are { type:'link', name, url }. Links also stores email / phone /
// username / info / doc items — Launcher round-trips those untouched, so a
// reorder saved from here never drops data the popup does not render.
//
// The Firebase project enforces App Check (reCAPTCHA v3), which a browser
// extension cannot satisfy, so Launcher does NOT hit Firestore directly. It goes
// through the `keychain-sync` Cloudflare Worker's /links route, whose Firebase
// service account bypasses App Check + rules. Same source of truth as the Links
// program, both directions: Links listens on this document with onSnapshot, so a
// PUT from here lands in an open Links tab within a second.
//
// This file is loaded BOTH by popup.html (as a <script>) and by background.js
// (via importScripts), so it attaches to globalThis rather than window.
// ─────────────────────────────────────────────────────────────────────────────

const LauncherDB = (() => {
  // The keychain-sync Worker's Links endpoint + shared key. The worker accepts
  // its LINKS_KEY secret here if one is set, otherwise VAULT_KEY — see
  // workers/keychain-sync/worker.js. If LINKS_KEY is ever provisioned, change
  // LAUNCHER_KEY to match and repackage.
  const WORKER_URL = "https://keychain-sync.av1.workers.dev/links";
  const LAUNCHER_KEY = "vh-Ou55y3rGmjUn_ZGFTdSIFph2xN_OK";

  // Last good payload, so the popup paints instantly instead of showing a
  // spinner on every open, and still shows something useful when offline.
  const CACHE_KEY = "launcher_links_cache";

  function normalizeDoc(d) {
    return {
      connections: Array.isArray(d && d.connections) ? d.connections : [],
      colmap: Array.isArray(d && d.colmap) ? d.colmap : null,
      savedAt: (d && d.savedAt) || 0
    };
  }

  async function load() {
    const r = await fetch(WORKER_URL, {
      headers: { "X-Vault-Key": LAUNCHER_KEY },
      cache: "no-store"
    });
    if (!r.ok) throw new Error("Launcher load failed: " + r.status + " " + (await safeText(r)));
    return normalizeDoc(await r.json());
  }

  // Write back. Only ORDER changes originate here (card drag-and-drop), but the
  // whole connections array is sent because the document is written whole —
  // exactly as the Links program writes it.
  async function save(state) {
    const body = {
      connections: Array.isArray(state.connections) ? state.connections : [],
      colmap: Array.isArray(state.colmap) && state.colmap.length ? state.colmap : null
    };
    const r = await fetch(WORKER_URL, {
      method: "PUT",
      headers: { "X-Vault-Key": LAUNCHER_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error("Launcher save failed: " + r.status + " " + (await safeText(r)));
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

  // Fetch and cache in one step; used by the popup and by the background alarm.
  async function refresh() {
    const doc = await load();
    await writeCache(doc);
    return doc;
  }

  async function safeText(r) { try { return await r.text(); } catch { return ""; } }

  return { load, save, refresh, linksOf, readCache, writeCache, CACHE_KEY, WORKER_URL };
})();

if (typeof globalThis !== "undefined") globalThis.LauncherDB = LauncherDB;
