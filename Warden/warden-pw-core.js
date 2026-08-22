// ─────────────────────────────────────────────────────────────────────────────
// warden-pw-core.js — Warden extension · warden data layer (NO DOM)
//
// Shared by the popup (warden-pw.js + warden-pay-panel.js UIs), the background
// service worker (background.js), and — via the background — the inline
// autofill content script. Handles: fetching the encrypted warden through the
// warden-pw-sync Worker, unlocking locally with WardenCrypto, decrypting logins
// AND payment methods, domain matching, and a 30-minute idle SESSION so you
// don't re-enter your master password on every popup open.
//
// SESSION SECURITY: the unlocked Data Key is cached in chrome.storage.session,
// which is IN-MEMORY ONLY (never written to disk) and cleared when the browser
// fully closes. It auto-expires 30 minutes after the last activity. This mirrors
// how desktop password managers keep the warden key resident while unlocked.
//
// AUTH FRESHNESS (payments): the session also records `unlockedAt` — the moment
// a real credential (master password or biometric) was last presented, which
// activity touches do NOT extend. The CVV is only ever released within
// CVV_FRESH_MS of that moment, so a long-idle-but-still-unlocked session can
// autofill a card number but must be re-authenticated for the security code.
// Everything else in the warden behaves exactly as it did before.
// ─────────────────────────────────────────────────────────────────────────────

(function (root) {
  // From warden-config.js, which every context loads first.
  const _C = (typeof self !== "undefined" && self.WARDEN_CFG) || {};
  const WORKER_URL = _C.VAULT_URL || "";
  const WARDEN_KEY  = _C.WORKER_KEY || "";
  const IDLE_MS = 30 * 60 * 1000;
  const CVV_FRESH_MS = 5 * 60 * 1000; // re-auth window for releasing a CVV
  const SKEY = "vpwSession";

  const VC = root.WardenCrypto || (typeof require !== "undefined" ? require("./warden-crypto.js") : null);
  const VPay = root.WardenPay || (typeof require !== "undefined" ? require("./warden-pay.js") : null);
  const VId  = root.WardenId  || (typeof require !== "undefined" ? require("./warden-id.js")  : null);

  // Where ID-document scans live. The same Worker + KV namespace the web app
  // uploads to; what it holds is AES-GCM ciphertext under a random key, so the
  // extension fetching from it leaks nothing about which document is which.
  const FILES_URL = _C.FILES_BASE || "";

  let config = null, items = {}, dek = null, loaded = false;
  // Set on a real credential presentation only; survives across popup opens via
  // the session record. `null` means "unlocked, but we can't prove how recently".
  let unlockedAt = 0;

  // ── chrome.storage.session helpers (guarded; no-op outside the extension) ──
  function hasSession() { try { return !!(root.chrome && chrome.storage && chrome.storage.session); } catch (e) { return false; } }
  function sesGet() { return new Promise((res) => { if (!hasSession()) return res(null); try { chrome.storage.session.get(SKEY, (d) => res((d && d[SKEY]) || null)); } catch (e) { res(null); } }); }
  function sesSet(v) { return new Promise((res) => { if (!hasSession()) return res(); try { chrome.storage.session.set({ [SKEY]: v }, () => res()); } catch (e) { res(); } }); }
  function sesDel() { return new Promise((res) => { if (!hasSession()) return res(); try { chrome.storage.session.remove(SKEY, () => res()); } catch (e) { res(); } }); }

  // ── data ───────────────────────────────────────────────────────────────────
  async function fetchWarden() {
    const r = await fetch(WORKER_URL, { headers: { "X-Warden-Key": WARDEN_KEY } });
    if (!r.ok) throw new Error("load " + r.status);
    const d = await r.json();
    config = d.config || null;
    items = d.items || {};
    loaded = true;
    return { hasWarden: !!config };
  }
  async function ensureLoaded() { if (!loaded) await fetchWarden(); }
  async function hasWarden() { await ensureLoaded(); return !!config; }

  async function unlock(masterPassword) {
    await ensureLoaded();
    if (!config) throw new Error("no-warden");
    dek = await VC.unlockWithPassword(config, masterPassword); // throws 'bad-password'
    unlockedAt = Date.now();
    await saveSession();
    return true;
  }
  async function lock() { dek = null; unlockedAt = 0; await sesDel(); }
  function isUnlocked() { return !!dek; }

  // ── auth freshness ─────────────────────────────────────────────────────────
  // ms since a real credential was presented (Infinity if never/unknown).
  function authAge() { return unlockedAt ? Date.now() - unlockedAt : Infinity; }
  function authFresh(maxMs) { return authAge() <= (maxMs == null ? CVV_FRESH_MS : maxMs); }
  // Re-present the master password on an ALREADY-unlocked session to refresh the
  // window (e.g. to release a CVV) without disturbing the cached DEK.
  async function reauth(masterPassword) {
    await ensureLoaded();
    if (!config) throw new Error("no-warden");
    await VC.unlockWithPassword(config, masterPassword); // throws 'bad-password'
    unlockedAt = Date.now();
    await saveSession();
    return true;
  }

  // ── biometric unlock — reuses the SAME WebAuthn credential + device key ────
  // registered on this device by Index (see warden-bio-sync.js). We never
  // enroll a separate credential here: the content script relays this
  // device's { deviceId, deviceKeyB64, credId } from Index's localStorage,
  // and Chrome 122+ lets an extension assert Index's own RP ID (its
  // hostname) for WebAuthn as long as it holds host_permissions for that
  // site (declared in manifest.json). A live biometric assertion is still
  // required every time — the synced device key alone unlocks nothing.
  const BIO_RP_ID = _C.BIO_RP_ID || "";
  function bioHasSession() { try { return !!(root.chrome && chrome.storage && chrome.storage.local); } catch (e) { return false; } }
  function getBioLink() {
    return new Promise((res) => {
      if (!bioHasSession()) return res(null);
      try { chrome.storage.local.get("wardenBioLink", (d) => res((d && d.wardenBioLink) || null)); }
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
    if (!config) throw new Error("no-warden");
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
    unlockedAt = Date.now();
    await saveSession();
    return true;
  }

  // ── decryption ─────────────────────────────────────────────────────────────
  // One decrypt path for every item kind. `kind` is the only plaintext field on
  // a stored doc (routing); everything else comes out of `enc`.
  async function decryptKind(kind) {
    if (!dek) throw new Error("locked");
    const out = [];
    for (const id of Object.keys(items)) {
      const doc = items[id];
      if (!doc || doc.deleted || doc.kind !== kind || !doc.enc) continue;
      try { const body = await VC.decrypt(dek, doc.enc); out.push(Object.assign({ id }, body)); } catch (e) {}
    }
    return out;
  }

  async function credentials() {
    const out = await decryptKind("login");
    return out.sort((a, b) => (a.title || a.url || "").localeCompare(b.title || b.url || ""));
  }

  // Decrypted payment methods, favourites/expiry-sorted like the PWA shows them.
  async function payments() {
    const out = await decryptKind("payment");
    return VPay ? VPay.sortCards(out) : out;
  }
  async function paymentById(id) {
    const doc = items[id];
    if (!dek) throw new Error("locked");
    if (!doc || doc.deleted || doc.kind !== "payment" || !doc.enc) return null;
    try { return Object.assign({ id }, await VC.decrypt(dek, doc.enc)); } catch (e) { return null; }
  }
  // What a page-side context (the autofill dropdown) is allowed to see: masked
  // display data only — never a full number, never a CVV. See WardenPay.summarize.
  async function paymentSummaries() {
    const list = await payments();
    return VPay ? list.map((c) => VPay.summarize(c)) : list;
  }

  // ── ID documents ───────────────────────────────────────────────────────────
  // Same one decrypt path as logins and cards — `kind:'iddoc'` is the only
  // plaintext field on the stored doc. Sorting matches the web app's default so
  // the popup lists documents in the order you last saw them there.
  async function idDocs() {
    const out = await decryptKind("iddoc");
    return VId ? VId.sortDocs(out, "added") : out;
  }
  async function idDocById(id) {
    if (!dek) throw new Error("locked");
    const doc = items[id];
    if (!doc || doc.deleted || doc.kind !== "iddoc" || !doc.enc) return null;
    try { return Object.assign({ id }, await VC.decrypt(dek, doc.enc)); } catch (e) { return null; }
  }
  // What a page-side context (the autofill dropdown) may see: title, type,
  // issuer, expiry state, a MASKED number, and the inline thumbnail — never the
  // document number itself, and never a decrypted scan.
  async function idDocSummaries() {
    const list = await idDocs();
    if (!VId) return list;
    return list.map((d) => {
      const s = VId.summarize(d);
      return {
        id: d.id, docType: d.docType, title: s.title, typeLabel: s.typeLabel,
        subtitle: s.subtitleFull, masked: s.masked, hasNumber: !!s.number,
        expiry: s.expirationShort, expiryState: s.expiryState, badge: s.badge,
        files: s.attachments, thumb: (s.cover && s.cover.thumb) || "",
      };
    });
  }

  // ── attachment bytes ───────────────────────────────────────────────────────
  // Decrypt raw bytes under the session DEK. Mirrors WardenSession.decryptBytes
  // in the web app — same key, same algorithm, so a scan uploaded from a phone
  // opens here and vice versa.
  async function decryptBytes(ivB64, bytes) {
    if (!dek) throw new Error("locked");
    const iv = VC.b64ToBytes(ivB64);
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, dek, buf);
    return new Uint8Array(pt);
  }
  // Fetch one attachment's ciphertext from the file host and decrypt it.
  // Returns plaintext bytes; the caller decides whether that becomes a Blob to
  // download or a File to hand to a page's upload field.
  async function attachmentBytes(att) {
    if (!dek) throw new Error("locked");
    if (!att || !att.key) throw new Error("no-attachment");
    const r = await fetch(FILES_URL + encodeURIComponent(att.key));
    if (!r.ok) throw new Error("download-" + r.status);
    const ct = new Uint8Array(await r.arrayBuffer());
    return decryptBytes(att.iv, ct);
  }

  // A ready-to-save Blob for one attachment.
  async function attachmentBlob(att) {
    const plain = await attachmentBytes(att);
    return new Blob([plain], { type: (att && att.mime) || "application/octet-stream" });
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
      await sesSet({ dek: VC.bytesToB64(new Uint8Array(raw)), at: Date.now(), unlockedAt: unlockedAt || Date.now(), stamp: (config && config.securityStamp) || null });
    } catch (e) {}
  }
  // Extend the IDLE window on activity. It must carry `stamp` and `unlockedAt`
  // forward untouched: dropping the stamp would disable the "master password
  // changed elsewhere → re-lock" check on the next resume, and bumping
  // unlockedAt would let mere activity stand in for re-authentication.
  async function touchSession() {
    if (!dek || !hasSession()) return;
    const cur = await sesGet();
    if (cur && cur.dek) await sesSet({ dek: cur.dek, at: Date.now(), unlockedAt: cur.unlockedAt || 0, stamp: cur.stamp || null });
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
      await fetchWarden();
      if (s.stamp && config && config.securityStamp && s.stamp !== config.securityStamp) { await sesDel(); return false; }
      dek = await crypto.subtle.importKey("raw", VC.b64ToBytes(s.dek), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
      // A resume is NOT a re-authentication: carry the original unlock moment
      // forward so the CVV window keeps counting from the real credential check.
      unlockedAt = s.unlockedAt || 0;
      await sesSet({ dek: s.dek, at: Date.now(), unlockedAt: unlockedAt, stamp: (config && config.securityStamp) || s.stamp }); // reset idle window on resume
      return true;
    } catch (e) { dek = null; return false; }
  }

  const api = {
    fetchWarden, hasWarden, unlock, lock, isUnlocked, credentials, matchDomain, hostFromUrl, saveSession, touchSession, restoreSession, IDLE_MS,
    biometricAvailable, biometricLabel, unlockWithBiometric, getBioLink,
    // payments
    payments, paymentById, paymentSummaries, decryptKind,
    // ID documents
    idDocs, idDocById, idDocSummaries, attachmentBytes, attachmentBlob, decryptBytes, FILES_URL,
    // auth freshness (gates CVV release)
    authAge, authFresh, reauth, CVV_FRESH_MS,
  };
  root.WardenPWCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
