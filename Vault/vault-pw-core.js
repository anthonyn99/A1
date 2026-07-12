// ─────────────────────────────────────────────────────────────────────────────
// vault-pw-core.js — Vault extension · password data layer (NO DOM)
//
// Shared by the popup (vault-pw.js UI), the background service worker
// (background.js), and — via the background — the inline autofill content
// script. Handles: fetching the encrypted vault through the vault-pw-sync
// Worker, unlocking locally with VaultCrypto, decrypting logins, domain
// matching, and a 30-minute idle SESSION so you don't re-enter your master
// password on every popup open.
//
// SESSION SECURITY: the unlocked Data Key is cached in chrome.storage.session,
// which is IN-MEMORY ONLY (never written to disk) and cleared when the browser
// fully closes. It auto-expires 30 minutes after the last activity. This mirrors
// how desktop password managers keep the vault key resident while unlocked.
// ─────────────────────────────────────────────────────────────────────────────

(function (root) {
  const WORKER_URL = "https://vault-pw-sync.av1.workers.dev/vault";
  const VAULT_KEY  = "vh-Ou55y3rGmjUn_ZGFTdSIFph2xN_OK";
  const IDLE_MS = 30 * 60 * 1000;
  const SKEY = "vpwSession";

  const VC = root.VaultCrypto || (typeof require !== "undefined" ? require("./vault-crypto.js") : null);

  let config = null, items = {}, dek = null, loaded = false;

  // ── chrome.storage.session helpers (guarded; no-op outside the extension) ──
  function hasSession() { try { return !!(root.chrome && chrome.storage && chrome.storage.session); } catch (e) { return false; } }
  function sesGet() { return new Promise((res) => { if (!hasSession()) return res(null); try { chrome.storage.session.get(SKEY, (d) => res((d && d[SKEY]) || null)); } catch (e) { res(null); } }); }
  function sesSet(v) { return new Promise((res) => { if (!hasSession()) return res(); try { chrome.storage.session.set({ [SKEY]: v }, () => res()); } catch (e) { res(); } }); }
  function sesDel() { return new Promise((res) => { if (!hasSession()) return res(); try { chrome.storage.session.remove(SKEY, () => res()); } catch (e) { res(); } }); }

  // ── data ───────────────────────────────────────────────────────────────────
  async function fetchVault() {
    const r = await fetch(WORKER_URL, { headers: { "X-Vault-Key": VAULT_KEY } });
    if (!r.ok) throw new Error("load " + r.status);
    const d = await r.json();
    config = d.config || null;
    items = d.items || {};
    loaded = true;
    return { hasVault: !!config };
  }
  async function ensureLoaded() { if (!loaded) await fetchVault(); }
  async function hasVault() { await ensureLoaded(); return !!config; }

  async function unlock(masterPassword) {
    await ensureLoaded();
    if (!config) throw new Error("no-vault");
    dek = await VC.unlockWithPassword(config, masterPassword); // throws 'bad-password'
    await saveSession();
    return true;
  }
  async function lock() { dek = null; await sesDel(); }
  function isUnlocked() { return !!dek; }

  async function credentials() {
    if (!dek) throw new Error("locked");
    const out = [];
    for (const id of Object.keys(items)) {
      const doc = items[id];
      if (!doc || doc.deleted || doc.kind !== "login" || !doc.enc) continue;
      try { const body = await VC.decrypt(dek, doc.enc); out.push(Object.assign({ id }, body)); } catch (e) {}
    }
    return out.sort((a, b) => (a.title || a.url || "").localeCompare(b.title || b.url || ""));
  }

  function hostFromUrl(u) {
    try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.toLowerCase().replace(/^www\./, ""); }
    catch { return String(u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]; }
  }
  function matchDomain(creds, pageHost) {
    const host = String(pageHost || "").toLowerCase().replace(/^www\./, "");
    if (!host) return [];
    return creds.filter((c) => {
      const u = hostFromUrl(c.url || c.title || "");
      if (!u) return false;
      return host === u || host.endsWith("." + u) || u.endsWith("." + host);
    });
  }

  // ── session persistence (30-min idle) ──────────────────────────────────────
  async function saveSession() {
    if (!dek || !hasSession()) return;
    try {
      const raw = await crypto.subtle.exportKey("raw", dek);
      await sesSet({ dek: VC.bytesToB64(new Uint8Array(raw)), at: Date.now(), stamp: (config && config.securityStamp) || null });
    } catch (e) {}
  }
  async function touchSession() {
    if (!dek || !hasSession()) return;
    const cur = await sesGet();
    if (cur && cur.dek) await sesSet({ dek: cur.dek, at: Date.now() });
  }
  // Try to resume a previous unlock. Returns true if still valid (within idle).
  async function restoreSession() {
    if (dek) return true;
    const s = await sesGet();
    if (!s || !s.dek) return false;
    if (Date.now() - (s.at || 0) > IDLE_MS) { await sesDel(); return false; }
    try {
      // Fetch the current config first so we can honor a securityStamp change
      // (master password changed elsewhere → this cached DEK must be dropped).
      await fetchVault();
      if (s.stamp && config && config.securityStamp && s.stamp !== config.securityStamp) { await sesDel(); return false; }
      dek = await crypto.subtle.importKey("raw", VC.b64ToBytes(s.dek), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
      await sesSet({ dek: s.dek, at: Date.now(), stamp: (config && config.securityStamp) || s.stamp }); // reset idle window on resume
      return true;
    } catch (e) { dek = null; return false; }
  }

  const api = { fetchVault, hasVault, unlock, lock, isUnlocked, credentials, matchDomain, hostFromUrl, saveSession, touchSession, restoreSession, IDLE_MS };
  root.VaultPWCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
