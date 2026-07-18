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

// ── Morning-launcher tab grouping ──────────────────────────────────────────
// The morning-launcher (Python) opens TradeHub + its searches + ChatGPT as tabs
// in a fresh Brave window, but it can't create a tab GROUP (only this extension
// API can). So TradeHub, when opened with ?morning=1, asks us (via the
// vault-bio-sync content script) to wrap that whole window into one named group.
//
// The launcher's tabs arrive SPREAD OUT over many seconds (TradeHub first, then —
// after a config fetch — the searches + ChatGPT), and an MV3 service worker can be
// torn down between those events. So we do NOT rely on an in-memory timer. Instead
// we persist the request in chrome.storage.session (survives worker restarts) and
// re-group INCREMENTALLY: the moment the request arrives we group whatever tabs
// exist, and every new tab that appears in that window (until a deadline) is added
// to the same group. State lives in storage, so a restarted worker just resumes.
const VALID_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
function normalizeGroupColor(c) {
  c = String(c || "").toLowerCase();
  if (c === "teal") return "cyan";      // friendly alias
  if (c === "gray") return "grey";
  return VALID_GROUP_COLORS.includes(c) ? c : "cyan"; // default: elegant teal
}

const PENDING_KEY = "morningGroupPending";   // storage.session: { [windowId]: {name,color,groupId,deadline} }
const GROUP_WINDOW_MS = 90000;               // keep adding new tabs to the group for this long

async function loadPending() {
  try { const d = await chrome.storage.session.get(PENDING_KEY); return d[PENDING_KEY] || {}; }
  catch (_) { return {}; }
}
async function savePending(map) {
  try { await chrome.storage.session.set({ [PENDING_KEY]: map }); } catch (_) {}
}

// Serialize regroup passes so two near-simultaneous tab events can't each spawn a
// separate group (they'd race on the not-yet-persisted groupId).
let _regroupChain = Promise.resolve();
function regroupWindow(windowId) {
  _regroupChain = _regroupChain.then(() => _regroupWindow(windowId)).catch(() => {});
  return _regroupChain;
}

async function _regroupWindow(windowId) {
  const key = String(windowId);
  const map = await loadPending();
  const st = map[key];
  if (!st) return;                                  // this window isn't pending
  if (Date.now() > st.deadline) { delete map[key]; await savePending(map); return; }

  let tabs;
  try { tabs = await chrome.tabs.query({ windowId }); } catch (_) { return; }
  const allIds = tabs.map((t) => t.id).filter((id) => id != null);
  if (!allIds.length || !chrome.tabs.group) return;

  try {
    const groupStillExists = st.groupId != null && tabs.some((t) => t.groupId === st.groupId);
    let gid;
    if (!groupStillExists) {
      // First pass (or the group was closed) → group every tab into a fresh group.
      gid = await chrome.tabs.group({ tabIds: allIds });
    } else {
      // Group exists → fold in any tabs that aren't in it yet (the new arrivals).
      gid = st.groupId;
      const toAdd = tabs.filter((t) => t.groupId !== gid).map((t) => t.id).filter((id) => id != null);
      if (toAdd.length) await chrome.tabs.group({ groupId: gid, tabIds: toAdd });
    }
    if (chrome.tabGroups && chrome.tabGroups.update) {
      await chrome.tabGroups.update(gid, {
        title: (st.name || "Trade Analysis").slice(0, 60),
        color: normalizeGroupColor(st.color),
      });
    }
    st.groupId = gid;
    map[key] = st;
    await savePending(map);
    console.log("[Vault] grouped", allIds.length, "tab(s) in window", windowId, "→", st.name, normalizeGroupColor(st.color));
  } catch (_) {
    // The group may have been closed mid-pass — forget the id so the next pass rebuilds it.
    st.groupId = null; map[key] = st; await savePending(map);
  }
}

// Every new tab in a still-pending window gets folded into its group.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab && tab.windowId != null) regroupWindow(tab.windowId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  // ── morning-launch grouping request (relayed by vault-bio-sync from TradeHub) ──
  if (message.action === "groupMorningTabs") {
    const wid = _sender && _sender.tab ? _sender.tab.windowId : null;
    console.log("[Vault] groupMorningTabs request, window =", wid, message.name, message.color);
    if (wid == null) { sendResponse({ ok: false }); return true; }
    (async () => {
      const map = await loadPending();
      const prev = map[String(wid)];
      map[String(wid)] = {
        name: message.name || "Trade Analysis",
        color: message.color || "cyan",
        groupId: prev && prev.groupId != null ? prev.groupId : null,  // reuse across repeat signals
        deadline: Date.now() + GROUP_WINDOW_MS,
      };
      await savePending(map);
      await regroupWindow(wid);           // group whatever's open right now
      sendResponse({ ok: true });
    })();
    return true;                          // async response
  }

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
