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

// ── Gear → Veda's Links, preferring the installed Index PWA ──────────────────
//
// An extension cannot enumerate installed PWAs (chrome.management's app APIs
// are ChromeOS-only), but it does not need to: when Index is installed AND
// open, it lives in its own window whose tab is on the Index start_url. So:
//
//   1. Index open in a PWA window   → focus it and steer it to Links.
//   2. Index open in a normal tab   → focus that tab and steer it.
//   3. Neither                      → open a fresh tab on ?goto=links.
//
// Steering is done by setting the hash rather than re-navigating to
// ?goto=links: a full navigation would reload the app, losing unsaved state and
// re-running the profile/app-lock gates. index.html listens for hashchange on
// '#links' and runs the very same _gotoVedaLinks() the query param triggers.
// The hash is cleared first, because re-assigning an identical hash fires no
// event.
//
// ── Chromium-fork compatibility (Brave, Edge, Vivaldi, Opera) ──
// Everything below is plain MV3 that every Chromium fork implements; there are
// no Chrome-only APIs. The two places the forks actually differ are handled:
//
//  * PWA window type. Chrome reports an installed PWA's window as type "app";
//    some forks/versions report "popup" instead. So a window counts as a PWA
//    window if it is anything OTHER than "normal" — and, since that is a
//    heuristic and not a guarantee, the tab is steered correctly either way.
//    Misreading the type only changes WHICH open Index is reused, never
//    whether the gear works.
//  * Brave Shields. Shields can block an extension's scripting injection on a
//    site. executeScript is therefore treated as best-effort: if it throws OR
//    reports no result, we fall back to a plain tabs.update navigation to
//    ?goto=links on that same tab, which needs no scripting at all.
const INDEX_ORIGIN    = "https://anthonyn99.github.io";
const INDEX_PAGE      = INDEX_ORIGIN + "/A1/index.html";
const INDEX_LINKS_URL = INDEX_PAGE + "?goto=links";

// Bring a window/tab to the front. Both calls are best-effort: a minimised or
// otherwise odd window can reject focus on some forks without that meaning the
// steer failed.
async function focusTab(tab) {
  try { await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true }); } catch (_) {}
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
}

// Steer an already-open Index to Links without reloading it. Returns false if
// the injection could not run (restricted page, Shields, missing permission),
// so the caller can fall back to a real navigation.
async function steerToLinks(tab) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return false;
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Prefer the app's own entry point when it is already parsed — it
        // honours the profile and app locks exactly as clicking through does.
        if (typeof window._gotoVedaLinks === "function") { window._gotoVedaLinks(); return true; }
        if (location.hash === "#links") location.hash = "";
        location.hash = "links";
        return true;
      },
    });
    return Array.isArray(res) && res.length > 0 && res[0] && res[0].result === true;
  } catch (_) {
    return false;
  }
}

async function openIndexLinks() {
  // Match the Index page on any query/hash. Two patterns because the installed
  // PWA's start_url is the bare page while a browser tab may carry ?goto=.
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: [INDEX_PAGE, INDEX_PAGE + "?*", INDEX_PAGE + "#*"] });
  } catch (_) {
    try { tabs = await chrome.tabs.query({ url: INDEX_PAGE + "*" }); } catch (_) { tabs = []; }
  }

  if (tabs.length) {
    // Prefer a PWA window: any window type other than "normal". Chrome says
    // "app", some forks say "popup" — treating both as the PWA is what makes
    // this work on Brave as well as Chrome.
    let pwaTab = null;
    try {
      const wins = await chrome.windows.getAll({});
      const byId = new Map(wins.map(w => [w.id, w]));
      pwaTab = tabs.find(t => {
        const w = byId.get(t.windowId);
        return w && w.type && w.type !== "normal";
      }) || null;
    } catch (_) { /* windows API unavailable — fall through to the first tab */ }

    const target = pwaTab || tabs[0];
    await focusTab(target);
    if (await steerToLinks(target)) return pwaTab ? "pwa" : "tab";

    // Injection blocked — navigate that same tab instead. Still reuses the PWA
    // window rather than opening Index in the browser.
    try {
      await chrome.tabs.update(target.id, { url: INDEX_LINKS_URL });
      return pwaTab ? "pwa-nav" : "tab-nav";
    } catch (_) { /* fall through to a new tab */ }
  }

  await chrome.tabs.create({ url: INDEX_LINKS_URL });
  return "opened";
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

  if (message.action === "openIndexLinks") {
    openIndexLinks()
      .then(how => sendResponse({ ok: true, how }))
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
