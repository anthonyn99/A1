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

// Map an arbitrary pastel hex (from Keychain) to the nearest of Chrome's fixed
// tab-group colors, so a launched group visually matches its Keychain card.
const TAB_GROUP_HUES = [
  ["red", 0], ["orange", 30], ["yellow", 55], ["green", 120],
  ["cyan", 185], ["blue", 215], ["purple", 275], ["pink", 330],
];
function nearestGroupColor(hex) {
  if (!hex) return "grey";
  let h = String(hex).toLowerCase().replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length < 6) return "grey";
  const r = parseInt(h.slice(0, 2), 16) / 255,
        g = parseInt(h.slice(2, 4), 16) / 255,
        b = parseInt(h.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!mx || d / mx < 0.08) return "grey"; // desaturated → grey
  let H = 0;
  if (mx === r) H = ((g - b) / d) % 6;
  else if (mx === g) H = (b - r) / d + 2;
  else H = (r - g) / d + 4;
  H = H * 60; if (H < 0) H += 360;
  let best = "grey", bd = 1e9;
  for (const [name, hue] of TAB_GROUP_HUES) {
    let dh = Math.abs(hue - H); if (dh > 180) dh = 360 - dh;
    if (dh < bd) { bd = dh; best = name; }
  }
  return best;
}

// Open a set of links and wrap them in a single named, colored tab group in the
// current window — the browser auto-creates the group so the user doesn't have
// to. Falls back to plain tabs if the tabGroups API is unavailable.
async function openLinksAsGroup(urls, groupName, colorHex) {
  const ids = [];
  for (let i = 0; i < urls.length; i++) {
    const tab = await chrome.tabs.create({ url: urls[i], active: i === 0 });
    if (tab && tab.id != null) ids.push(tab.id);
  }
  if (chrome.tabs.group && ids.length) {
    try {
      const groupId = await chrome.tabs.group({ tabIds: ids });
      if (chrome.tabGroups && chrome.tabGroups.update) {
        await chrome.tabGroups.update(groupId, {
          title: (groupName || "Group").slice(0, 60),
          color: nearestGroupColor(colorHex),
        });
      }
    } catch (_) { /* grouping unsupported — tabs already opened */ }
  }
  return ids.length;
}

// Emulated "split view": open two links as two normal windows snapped to the
// left and right halves of the screen. Native browser split view (Brave/Edge)
// has no extension API, so side-by-side windows are the closest we can drive.
// `screen` carries the popup's window.screen.avail* bounds (the usable desktop).
async function openSplit(urls, screen) {
  const s = screen || {};
  const left = Math.round(s.left || 0),
        top = Math.round(s.top || 0),
        W = Math.round(s.width || 1280),
        H = Math.round(s.height || 800);
  const halfL = Math.floor(W / 2), halfR = W - halfL;
  const panes = [
    { url: urls[0], left, top, width: halfL, height: H, focused: false },
    { url: urls[1], left: left + halfL, top, width: halfR, height: H, focused: true },
  ];
  for (const p of panes) {
    if (!p.url) continue;
    await chrome.windows.create({ url: p.url, type: "normal", state: "normal",
      left: p.left, top: p.top, width: p.width, height: p.height, focused: p.focused });
  }
  return panes.filter((p) => p.url).length;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  // ── group-launch (Links) — opens tabs and auto-creates a tab group ──
  if (message.action === "openLinks") {
    const urls = (Array.isArray(message.urls) ? message.urls : []).map(normalize).filter(Boolean);
    if (message.group && urls.length > 1) {
      openLinksAsGroup(urls, message.groupName, message.groupColor)
        .then((n) => sendResponse({ opened: n }));
    } else {
      urls.forEach((url, i) => chrome.tabs.create({ url, active: i === 0 }));
      sendResponse({ opened: urls.length });
    }
    return true;
  }

  // ── split-launch (Links) — two links side by side as half-screen windows ──
  if (message.action === "openSplit") {
    const urls = (Array.isArray(message.urls) ? message.urls : []).map(normalize).filter(Boolean).slice(0, 2);
    openSplit(urls, message.screen).then((n) => sendResponse({ opened: n }));
    return true;
  }

  // ── biometric link sync from Index (vault-bio-sync.js content script) ──
  if (message.action === "vaultBioSync") {
    try { chrome.storage.local.set({ vaultBioLink: message.link || null }, () => sendResponse({ ok: true })); }
    catch (e) { sendResponse({ ok: false }); }
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
