// ─────────────────────────────────────────────────────────────────────────────
// vault-bio-sync.js — runs ONLY on https://anthonyn99.github.io/* (Index/TaskHub).
//
// Lets the Vault extension unlock with the SAME biometric (Windows Hello / Touch
// ID / Face ID / fingerprint) that was registered for the password vault in
// Index, instead of enrolling a separate credential inside the extension.
//
// WebAuthn credentials are scoped to their relying-party ID (this site's
// hostname). A browser extension can assert that same RP ID from its own
// chrome-extension:// origin ONLY if it declares host_permissions for the site
// (Chrome 122+) — see manifest.json. It still cannot read this page's
// localStorage directly, so this content script relays the three small,
// non-secret-until-combined pieces the extension needs to complete the SAME
// biometric gate Index uses:
//   • vault.vault.deviceId   — this device's id
//   • vault.vault.deviceKey  — the device key that wraps the vault's DEK,
//                              released only after a live WebAuthn assertion
//   • bio_cred_vault_<id>    — the WebAuthn credential id + label
//
// None of this weakens the model: the extension still cannot unwrap the vault
// without a fresh, successful biometric assertion against this exact credential
// (see vault-pw-core.js unlockWithBiometric). It's the same trust boundary,
// just readable from a second place the user already controls (their own
// browser, same device).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  var DEVICE_ID_KEY = 'vault.vault.deviceId';
  var DEVICE_KEY_KEY = 'vault.vault.deviceKey';
  var BIO_APP = 'vault';

  function read() {
    var deviceId = null, deviceKeyB64 = null, credId = null, label = null;
    try { deviceId = localStorage.getItem(DEVICE_ID_KEY) || null; } catch (e) {}
    try { deviceKeyB64 = localStorage.getItem(DEVICE_KEY_KEY) || null; } catch (e) {}
    if (deviceId) {
      try {
        var rec = JSON.parse(localStorage.getItem('bio_cred_' + BIO_APP + '_' + deviceId) || 'null');
        if (rec && rec.id) { credId = rec.id; label = rec.label || null; }
      } catch (e) {}
    }
    return { deviceId: deviceId, deviceKeyB64: deviceKeyB64, credId: credId, label: label };
  }

  var last = null;
  function sync() {
    var cur = read();
    var complete = !!(cur.deviceId && cur.deviceKeyB64 && cur.credId);
    var payload = complete ? cur : null;
    var key = JSON.stringify(payload);
    if (key === last) return;
    last = key;
    try { chrome.runtime.sendMessage({ action: 'vaultBioSync', link: payload }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  }

  sync();
  // Catch changes made while this tab stays open (e.g. enabling biometrics in
  // Settings without a reload). Cheap: three localStorage reads.
  var poll = setInterval(sync, 3000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(); });
  window.addEventListener('storage', sync);
  window.addEventListener('pagehide', function () { clearInterval(poll); });
})();
