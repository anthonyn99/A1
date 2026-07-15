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

  // ── biometric unlock — reuses the SAME WebAuthn credential + device key ────
  // registered on this device by Index (see vault-bio-sync.js). We never
  // enroll a separate credential here: the content script relays this
  // device's { deviceId, deviceKeyB64, credId } from Index's localStorage,
  // and Chrome 122+ lets an extension assert Index's own RP ID (its
  // hostname) for WebAuthn as long as it holds host_permissions for that
  // site (declared in manifest.json). A live biometric assertion is still
  // required every time — the synced device key alone unlocks nothing.
  const BIO_RP_ID = "anthonyn99.github.io";
  function bioHasSession() { try { return !!(root.chrome && chrome.storage && chrome.storage.local); } catch (e) { return false; } }
  function getBioLink() {
    return new Promise((res) => {
      if (!bioHasSession()) return res(null);
      try { chrome.storage.local.get("vaultBioLink", (d) => res((d && d.vaultBioLink) || null)); }
      catch (e) { res(null); }
    });
  }
  function unb64u(str) {
    str = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    const bin = atob(str), b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b.buffer;
  }
  function bioSupported() {
    return !!(root.PublicKeyCredential && root.navigator && root.navigator.credentials && root.navigator.credentials.get);
  }
  async function biometricAvailable() {
    if (!bioSupported()) return false;
    const link = await getBioLink();
    if (!link || !link.deviceId || !link.deviceKeyB64 || !link.credId) return false;
    await ensureLoaded();
    return !!(config && config.biometrics && config.biometrics[link.deviceId]);
  }
  function biometricLabel(link) {
    if (link && link.label) return link.label;
    const ua = (root.navigator && root.navigator.userAgent) || "";
    if (/Windows/.test(ua)) return "Windows Hello";
    if (/Mac/.test(ua)) return "Touch ID";
    if (/iPhone|iPad|iPod/.test(ua)) return "Face ID";
    if (/Android/.test(ua)) return "fingerprint";
    return "biometrics";
  }
  async function unlockWithBiometric() {
    if (!bioSupported()) throw new Error("bio-unavailable");
    const link = await getBioLink();
    if (!link || !link.deviceId || !link.deviceKeyB64 || !link.credId) throw new Error("no-biometric-slot");
    await ensureLoaded();
    if (!config) throw new Error("no-vault");
    if (!(config.biometrics && config.biometrics[link.deviceId])) throw new Error("no-biometric-slot");
    let asr;
    try {
      asr = await root.navigator.credentials.get({
        publicKey: {
          challenge: root.crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ type: "public-key", id: unb64u(link.credId) }],
          userVerification: "required", timeout: 60000, rpId: BIO_RP_ID,
        },
      });
    } catch (e) { throw new Error(e && e.name === "NotAllowedError" ? "cancelled" : "bio-failed"); }
    if (!asr) throw new Error("cancelled");
    dek = await VC.unlockWithBiometric(config, link.deviceId, link.deviceKeyB64); // throws 'bad-biometric'
    await saveSession();
    return true;
  }

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

  const api = {
    fetchVault, hasVault, unlock, lock, isUnlocked, credentials, matchDomain, hostFromUrl, saveSession, touchSession, restoreSession, IDLE_MS,
    biometricAvailable, biometricLabel, unlockWithBiometric, getBioLink,
  };
  root.VaultPWCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
