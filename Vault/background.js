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
//
// Two things matter to keep each launch its own independent group, even when
// another group already sits in the window (and across several launches in the
// same session):
//
//  1. New tabs are opened INACTIVE and pinned to explicit indices at the very
//     end of the tab strip. Without an explicit index, Chrome inserts a new tab
//     next to the currently *active* tab — if that active tab belongs to an
//     existing group, the new tabs land adjacent to (or inside) that group's
//     index range before we ever call tabs.group().
//  2. The group is created from a SINGLE tab first (a fresh, unambiguous
//     groupId), then the rest of the tabs are folded into that specific
//     groupId one call at a time — never a single tabs.group() call spanning
//     the whole batch. Grouping the whole batch at once, right after those tabs
//     were appended next to a pre-existing group, is what lets the browser fold
//     them into that neighboring group instead of making a new one. This
//     mirrors the same single-tab-first pattern _regroupWindow() below already
//     relies on for the Trading Auto Launcher.
async function openLinksAsGroup(urls, groupName, colorHex) {
  let win;
  try { win = await chrome.windows.getCurrent(); } catch (_) { win = null; }
  const windowId = win ? win.id : undefined;

  const existing = await chrome.tabs.query(windowId != null ? { windowId } : { currentWindow: true });
  let nextIndex = existing.length;

  const ids = [];
  for (let i = 0; i < urls.length; i++) {
    const createProps = { url: urls[i], active: false, index: nextIndex++ };
    if (windowId != null) createProps.windowId = windowId;
    const tab = await chrome.tabs.create(createProps);
    if (tab && tab.id != null) ids.push(tab.id);
  }

  if (chrome.tabs.group && ids.length) {
    try {
      const groupId = await chrome.tabs.group({ tabIds: [ids[0]] });
      if (ids.length > 1) await chrome.tabs.group({ groupId, tabIds: ids.slice(1) });
      if (chrome.tabGroups && chrome.tabGroups.update) {
        await chrome.tabGroups.update(groupId, {
          title: (groupName || "Group").slice(0, 60),
          color: nearestGroupColor(colorHex),
        });
      }
    } catch (_) { /* grouping unsupported — tabs already opened */ }
  }

  try { await chrome.tabs.update(ids[0], { active: true }); } catch (_) {}
  return ids.length;
}

// ── Trading Auto Launcher tab grouping ─────────────────────────────────────
// The Trading Auto Launcher (Python) opens TradeHub + its searches + ChatGPT as
// tabs, but it can't create a tab GROUP (only this extension API can). So
// TradeHub, when opened with ?autolaunch=1 (or via the in-app Deploy button),
// asks us — through the vault-bio-sync content script — to wrap ONLY those
// launcher tabs into one named group.
//
// CRITICAL: we group ONLY the tabs the launcher created, never pre-existing /
// session-restored tabs that happen to share the window. We do that by tracking
// MEMBERS: the seed is the TradeHub tab that sent the signal, and every tab
// created in that window AFTER the signal (the searches + ChatGPT) is added.
// Tabs that already existed when the signal arrived are never members, so a
// restored session stays out of the group.
//
// The launcher's tabs arrive spread out over many seconds and an MV3 service
// worker can be torn down between events, so we persist state in
// chrome.storage.session (survives restarts) and re-group incrementally.
const VALID_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
function normalizeGroupColor(c) {
  c = String(c || "").toLowerCase();
  if (c === "teal") return "cyan";      // friendly alias
  if (c === "gray") return "grey";
  return VALID_GROUP_COLORS.includes(c) ? c : "cyan"; // default: elegant teal
}

const GROUP_DEFAULT_NAME = "Trading Analysis";
const PENDING_KEY = "tradingGroupPending"; // storage.session: { [windowId]: {name,color,groupId,deadline,members:{id:1}} }
const GROUP_WINDOW_MS = 240000;            // keep folding new launcher tabs into the group for this long (covers a slow reminder gate)

async function loadPending() {
  try { const d = await chrome.storage.session.get(PENDING_KEY); return d[PENDING_KEY] || {}; }
  catch (_) { return {}; }
}
async function savePending(map) {
  try { await chrome.storage.session.set({ [PENDING_KEY]: map }); } catch (_) {}
}

// A single mutex for ALL pending-state work. Every read-modify-write of the
// storage.session map — adding a member, recording the group id, regrouping — runs
// through this one chain, so two near-simultaneous tab events (e.g. a search tab and
// the ChatGPT tab opening together) can never clobber each other's membership. This
// is what fixes launcher tabs being left out of the group.
let _opChain = Promise.resolve();
function runSerial(fn) {
  _opChain = _opChain.then(fn).catch((e) => { console.warn("[Vault] group op failed:", e); });
  return _opChain;
}

async function _regroupWindow(windowId) {
  const key = String(windowId);
  const map = await loadPending();
  const st = map[key];
  if (!st) return;                                  // this window isn't pending
  if (Date.now() > st.deadline) { delete map[key]; await savePending(map); return; }
  if (!chrome.tabs.group) return;

  let tabs;
  try { tabs = await chrome.tabs.query({ windowId }); } catch (_) { return; }
  const liveIds = new Set(tabs.map((t) => t.id));
  // Only our tracked members that still exist — restored tabs are never members.
  const memberIds = Object.keys(st.members || {}).map(Number).filter((id) => liveIds.has(id));
  if (!memberIds.length) return;
  const byId = new Map(tabs.map((t) => [t.id, t]));

  try {
    const groupStillExists = st.groupId != null && tabs.some((t) => t.groupId === st.groupId);
    let gid;
    if (!groupStillExists) {
      gid = await chrome.tabs.group({ tabIds: memberIds });    // first pass → new group from members
    } else {
      gid = st.groupId;
      const toAdd = memberIds.filter((id) => byId.get(id).groupId !== gid);  // fold in new members only
      if (toAdd.length) await chrome.tabs.group({ groupId: gid, tabIds: toAdd });
    }
    if (chrome.tabGroups && chrome.tabGroups.update) {
      await chrome.tabGroups.update(gid, {
        title: (st.name || GROUP_DEFAULT_NAME).slice(0, 60),
        color: normalizeGroupColor(st.color),
      });
    }
    st.groupId = gid;
    map[key] = st;
    await savePending(map);
    console.log("[Vault] grouped", memberIds.length, "launcher tab(s) in window", windowId, "→", st.name, normalizeGroupColor(st.color));
  } catch (_) {
    st.groupId = null; map[key] = st; await savePending(map);   // group closed mid-pass → rebuild next time
  }
}

// A tab created in a still-pending window is a launcher tab → make it a member,
// then regroup. Serialized so concurrent tab-opens can't drop each other's id.
chrome.tabs.onCreated.addListener((tab) => {
  if (!tab || tab.windowId == null || tab.id == null) return;
  runSerial(async () => {
    const map = await loadPending();
    const st = map[String(tab.windowId)];
    if (!st || Date.now() > st.deadline) return;
    st.members = st.members || {};
    st.members[tab.id] = 1;
    map[String(tab.windowId)] = st;
    await savePending(map);
    await _regroupWindow(tab.windowId);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  // ── Trading Auto Launcher grouping request (relayed by vault-bio-sync) ──
  if (message.action === "groupTradingTabs") {
    const wid = _sender && _sender.tab ? _sender.tab.windowId : null;
    const seedTab = _sender && _sender.tab ? _sender.tab.id : null;   // the TradeHub tab itself is the first member
    console.log("[Vault] groupTradingTabs request, window =", wid, "seed =", seedTab, message.name, message.color);
    if (wid == null) { sendResponse({ ok: false }); return true; }
    runSerial(async () => {
      const map = await loadPending();
      const prev = map[String(wid)];
      const members = (prev && prev.members) || {};
      if (seedTab != null) members[seedTab] = 1;
      map[String(wid)] = {
        name: message.name || GROUP_DEFAULT_NAME,
        color: message.color || "cyan",
        groupId: prev && prev.groupId != null ? prev.groupId : null,  // reuse across repeat signals
        deadline: Date.now() + GROUP_WINDOW_MS,
        members,
      };
      await savePending(map);
      await _regroupWindow(wid);
    }).then(() => sendResponse({ ok: true }));
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
