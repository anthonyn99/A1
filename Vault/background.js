// MV3 service worker.
//  1. Opens tabs on request from the popup (group-launch from Links).
//  2. Serves decrypted credential matches to the inline-autofill content script,
//     using the 30-minute idle session (so no master password re-prompt).
//
// The service worker can decrypt because vault-pw-core.js restores the unlocked
// Data Key from chrome.storage.session (in-memory only). If the session has
// expired / never unlocked, it reports locked and the content script shows an
// "unlock" hint instead of credentials.

importScripts("vault-crypto.js", "vault-pw-core.js");

function normalize(url) {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : "https://" + url;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  // ── group-launch (Links) ──
  if (message.action === "openLinks") {
    const urls = (Array.isArray(message.urls) ? message.urls : []).map(normalize).filter(Boolean);
    urls.forEach((url, i) => chrome.tabs.create({ url, active: i === 0 }));
    sendResponse({ opened: urls.length });
    return true;
  }

  // ── inline autofill: return decrypted matches for a domain ──
  if (message.action === "vaultGetCreds") {
    (async () => {
      try {
        const VP = self.VaultPWCore;
        const resumed = await VP.restoreSession();
        if (!resumed || !VP.isUnlocked()) { sendResponse({ unlocked: false }); return; }
        const creds = await VP.credentials();
        const matches = VP.matchDomain(creds, message.host || "");
        // Only send what the content script needs to fill.
        sendResponse({
          unlocked: true,
          creds: matches.map((c) => ({ id: c.id, title: c.title || VP.hostFromUrl(c.url) || "", username: c.username || c.email || "", password: c.password || "" })),
        });
      } catch (e) {
        sendResponse({ unlocked: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async
  }
});
