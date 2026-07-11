// ─────────────────────────────────────────────────────────────────────────────
// Vault ← Keychain shared backend (client side).
//
// Vault keeps NO database of its own and does NOT edit links — all link
// management lives in TaskHub → Keychain. Vault only READS the single Firestore
// document the Index app's Keychain uses, to display and open it:
//
//     dashboards/keychain  →  { connections, colmap, savedAt }
//
// A "connection" is a group:  { name, color, items: [ ... ] }, where items of
// type:'link' are { type:'link', name, url }. Keychain also stores email /
// phone / username / info / doc items — Vault preserves those untouched.
//
// The Firebase project enforces App Check (reCAPTCHA v3), which a browser
// extension cannot satisfy, so Vault does NOT hit Firestore directly. It goes
// through the `keychain-sync` Cloudflare Worker, whose Firebase service account
// bypasses App Check + rules. Same source of truth, both directions.
// ─────────────────────────────────────────────────────────────────────────────

const VaultDB = (() => {
  // The keychain-sync Worker endpoint + shared key (also set as the worker's
  // VAULT_KEY secret). See workers/keychain-sync and Vault/README.md.
  const WORKER_URL = "https://keychain-sync.av1.workers.dev/keychain";
  const VAULT_KEY  = "vh-Ou55y3rGmjUn_ZGFTdSIFph2xN_OK";

  async function load() {
    const r = await fetch(WORKER_URL, { headers: { "X-Vault-Key": VAULT_KEY } });
    if (!r.ok) throw new Error("Vault load failed: " + r.status + " " + (await safeText(r)));
    const d = await r.json();
    return {
      connections: Array.isArray(d.connections) ? d.connections : [],
      colmap: Array.isArray(d.colmap) ? d.colmap : null,
      savedAt: d.savedAt || 0
    };
  }

  // Pull just the launchable link items out of a connection (group).
  function linksOf(conn) {
    return (conn.items || [])
      .filter(it => it && it.type === "link" && it.url)
      .map(it => ({ name: it.name || it.url, url: it.url }));
  }

  async function safeText(r) { try { return await r.text(); } catch { return ""; } }

  return { load, linksOf };
})();

if (typeof window !== "undefined") window.VaultDB = VaultDB;
