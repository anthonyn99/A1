// MV3 service worker.
//  1. Opens tabs on request from the popup — a single link, or a whole card's
//     links wrapped in one named, colour-matched browser tab group.
//  2. Keeps the cached copy of Veda's Links document warm on an alarm, so the
//     popup paints instantly and already-fresh on open.
//
// Launcher stores no credentials and decrypts nothing — the Links document is
// plain link metadata — so unlike Vault's worker there is no session handling
// here. See launcher-sync.js for the transport.

importScripts("launcher-sync.js");

// How often to re-pull the Links document in the background. One minute keeps
// the popup effectively live without being chatty; the popup also polls while
// it is actually open (see popup.js), which is what makes an edit made in the
// Links program show up in a popup that is already on screen.
const REFRESH_ALARM = "launcher-refresh";
const REFRESH_MINUTES = 1;

function normalize(url) {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : "https://" + url;
}

// Map an arbitrary pastel hex (from Links) to the nearest of the browser's fixed
// tab-group colours, so a launched group visually matches its Launcher card.
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

// Open a set of links and wrap them in a single named, coloured tab group in the
// current window. Verbatim in intent from Vault/background.js — the two things
// that keep each launch its own independent group are load-bearing:
//
//  1. New tabs are opened INACTIVE at explicit indices at the very end of the
//     tab strip. Without an explicit index the browser inserts next to the
//     ACTIVE tab — and if that tab is in a group, the new tabs land inside that
//     group's index range before tabs.group() is ever called.
//  2. The group is created from a SINGLE tab first (a fresh, unambiguous
//     groupId), then the rest are folded into that groupId. One tabs.group()
//     call spanning the whole batch is what lets the browser absorb them into a
//     neighbouring group instead of making a new one.
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
      // A freshly created tab can be absorbed by an adjacent group at CREATION
      // time (and by "automatically group similar tabs"). Ungroup first so the
      // batch is definitely loose before we build our own group from it.
      if (chrome.tabs.ungroup) {
        try { await chrome.tabs.ungroup(ids); } catch (_) { /* none were grouped */ }
      }
      const createProperties = windowId != null ? { windowId } : {};
      const groupId = await chrome.tabs.group({ createProperties, tabIds: [ids[0]] });
      if (ids.length > 1) await chrome.tabs.group({ groupId, tabIds: ids.slice(1) });
      if (chrome.tabGroups && chrome.tabGroups.update) {
        await chrome.tabGroups.update(groupId, {
          title: (groupName || "Group").slice(0, 60),
          color: nearestGroupColor(colorHex),
        });
      }
    } catch (_) { /* grouping unsupported — tabs already opened */ }
  }

  if (ids.length) { try { await chrome.tabs.update(ids[0], { active: true }); } catch (_) {} }
  return ids.length;
}

async function openPlainTabs(urls) {
  for (const u of urls) { try { await chrome.tabs.create({ url: u }); } catch (_) {} }
  return urls.length;
}

// ── Background refresh ───────────────────────────────────────────────────────
async function refreshCache() {
  try { await LauncherDB.refresh(); } catch (e) { /* offline / worker down — keep the cache */ }
}

function ensureAlarm() {
  try {
    chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_MINUTES, delayInMinutes: REFRESH_MINUTES });
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); refreshCache(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); refreshCache(); });
chrome.alarms.onAlarm.addListener(a => { if (a && a.name === REFRESH_ALARM) refreshCache(); });
// A service worker that was torn down and revived by any event should still have
// its alarm; creating an existing alarm is a no-op.
ensureAlarm();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  if (message.action === "openLinks") {
    const urls = (message.urls || []).map(normalize).filter(Boolean);
    if (!urls.length) { sendResponse({ ok: false, opened: 0 }); return true; }
    (message.group ? openLinksAsGroup(urls, message.groupName, message.groupColor) : openPlainTabs(urls))
      .then(n => sendResponse({ ok: true, opened: n }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;   // async response
  }

  if (message.action === "refresh") {
    LauncherDB.refresh()
      .then(doc => sendResponse({ ok: true, doc }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
});
