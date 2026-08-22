// Config first: this is a classic (non-module) service worker, so
// importScripts runs synchronously and self.WARDEN_CFG exists before any of
// the constants below are evaluated.
importScripts('warden-config.js');

// MV3 service worker.
//  1. Opens tabs on request from the popup (group-launch from Links).
//  2. Serves decrypted credential matches to the inline-autofill content script,
//     using the 30-minute idle session (so no master password re-prompt).
//  3. Serves MASKED payment-method summaries to the same content script, and
//     performs the actual card fill itself (see wardenFillCard below).
//
// The service worker can decrypt because warden-pw-core.js restores the unlocked
// Data Key from chrome.storage.session (in-memory only). If the session has
// expired / never unlocked, it reports locked and the content script shows an
// "unlock" hint instead of credentials.

importScripts("warden-crypto.js", "warden-pay.js", "warden-id.js", "warden-pw-core.js");

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
//     them into that neighboring group instead of making a new one.
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
      // Chrome can put a freshly created tab into a group at CREATION time, before
      // we ever call tabs.group(): a new tab landing next to (or inside) an
      // existing group's index range gets absorbed by it, and the browser's
      // "automatically group similar tabs" behaviour does the same. If that has
      // happened, tabs.group({tabIds}) below just returns the id of THAT group —
      // so we would append to it and then rename it. Ungrouping first guarantees
      // the tabs are loose before we build our own group from them.
      if (chrome.tabs.ungroup) {
        try { await chrome.tabs.ungroup(ids); } catch (_) { /* none were grouped */ }
      }
      // createProperties is what actually forces a BRAND-NEW group. Calling
      // tabs.group() with only tabIds asks the browser to "group these", and
      // when the tabs sit next to an existing group (they do — we append at the
      // end of the strip, which is exactly where the last launch's group lives)
      // Chrome satisfies that by folding them into the neighbour instead. Naming
      // the window in createProperties leaves it no such option, so every launch
      // gets its own group no matter what is already open.
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

  try { await chrome.tabs.update(ids[0], { active: true }); } catch (_) {}
  return ids.length;
}

// NOTE: the Trading Auto Launch used to ask us to wrap its tabs into a named
// "Trading Analysis" tab group; that whole feature was removed at Tony's request.
// The popup's own link-group launcher (openLinksAsGroup, above) is unrelated and stays.

// ── Launch Analysis: open the AI tab + searches, and auto-submit the prompt ──
// TradeHub's "Launch Analysis" button can't type into chatgpt.com (cross-origin),
// so it hands us the prompt instead. We open the tabs, then park the prompt
// against the AI tab's id; warden-ai-prompt.js — the content script running INSIDE
// that new tab — collects it and does the paste + send.
//
// Handing it over as a PULL (the tab asks us) rather than a push avoids racing
// the tab's load.
//
// The prompt is held until the tab CONFIRMS it submitted, not merely until it
// was handed over. A fresh chatgpt.com tab routinely runs a short-lived auth /
// bot-check document before the real app loads: that first document asks for the
// prompt, then gets replaced mid-flight. Releasing on hand-out lost the prompt
// there every time — the tab opened and nothing was ever typed. So each new
// document may retry, capped at AI_MAX_TRIES so a page that can never submit
// gives up instead of looping.
const AI_PENDING_KEY = "aiPromptPending";   // storage.session: { [tabId]: {text, deadline, tries} }
const AI_PENDING_MS = 180000;               // a cold AI page + sign-in can take a while
const AI_MAX_TRIES = 3;                     // hand-outs per tab before we stop trying

async function loadAiPending() {
  try { const d = await chrome.storage.session.get(AI_PENDING_KEY); return d[AI_PENDING_KEY] || {}; }
  catch (_) { return {}; }
}
async function saveAiPending(map) {
  try { await chrome.storage.session.set({ [AI_PENDING_KEY]: map }); } catch (_) {}
}

// ── Trading Auto Launch (launch.py) hand-off ──────────────────────────────────
// The launcher is a Python process: it opens the AI tab from the command line and
// has no way to tell us its tab id, so it can't use the TradeHub path above.
// Instead it marks the URL with #tbauto, and the content script in that tab asks
// us to fetch the very same Analysis selection TradeHub pushed to the worker.
// That replaces the launcher's old OS-keystroke paste (Shift+Esc / Ctrl+V /
// Enter), which Brave hijacked — Shift+Esc is Brave's own Task Manager shortcut,
// so the paste and the Enter landed in the Task Manager instead of the composer.
// Inert in Warden: this bridge belongs to Tony's trading launcher, which does
// not exist on her machine. Left in place rather than surgically removed (it is
// only reachable via a #tbauto URL the launcher produces), but pointed at
// nothing, and its host permission is gone from the manifest.
const TD_WORKER_URL = (self.WARDEN_CFG || {}).TD_WORKER_URL || "";

const AI_AUTO_MARK = /#tbauto\b/i;

async function fetchAnalysisPrompt() {
  try {
    const r = await fetch(TD_WORKER_URL + "/analysis-config", { cache: "no-store" });
    if (!r.ok) return null;
    const d = await r.json();
    const t = d && d.ok ? String(d.text || "") : "";
    return t.trim() ? t : null;
  } catch (e) {
    console.warn("[Warden] AI prompt: analysis-config fetch failed:", e);
    return null;
  }
}

// Register the launcher's prompt against a #tbauto tab. Idempotent: an existing,
// unexpired entry wins, so the several onUpdated events one navigation produces
// (and the content script's own claim) can't double-fetch or reset the counter.
// tries stays 0 here — arming is not a hand-out; only handOutPrompt counts.
const _aiArming = new Set();   // in-flight guard across the fetch's await gap
async function armAutoSubmitTab(tabId) {
  if (tabId == null || _aiArming.has(tabId)) return false;
  const key = String(tabId);
  let map = await loadAiPending();
  if (map[key] && map[key].deadline >= Date.now()) return true;

  _aiArming.add(tabId);
  try {
    const text = await fetchAnalysisPrompt();
    if (!text) {
      console.warn("[Warden] AI prompt: #tbauto tab", tabId, "— worker had no Analysis prompt.");
      return false;
    }
    const now = Date.now();
    map = await loadAiPending();   // re-read: the fetch was an await gap
    if (map[key] && map[key].deadline >= now) return true;
    for (const k of Object.keys(map)) if (!map[k] || map[k].deadline < now) delete map[k];
    map[key] = { text, deadline: now + AI_PENDING_MS, tries: 0 };
    await saveAiPending(map);

    // The launcher no longer drives the tab strip with keystrokes, so bringing the
    // AI tab to the front is our job now — it's also what lets the content script
    // type into a composer that has actually laid out.
    try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
    console.log("[Warden] AI prompt: armed #tbauto tab", tabId, "with", text.length, "chars");
    return true;
  } finally { _aiArming.delete(tabId); }
}

// Catch the marker at NAVIGATION time, not just when the content script asks. These
// AI sites are SPAs that rewrite the URL as they boot, so by the time a content
// script runs at document_idle the #tbauto fragment may already be gone — but the
// tabs API still reports it here, on the very first loading event.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (tab && tab.url) || "";
  if (AI_AUTO_MARK.test(url)) armAutoSubmitTab(tabId);
});

// One shared hand-out path for both sources (TradeHub button and #tbauto), so the
// try cap and the "release only on a confirmed submit" rule apply identically.
async function handOutPrompt(tabId) {
  if (tabId == null) return null;
  const map = await loadAiPending();
  const key = String(tabId);
  const entry = map[key];
  if (!entry || entry.deadline < Date.now()) return null;
  if ((entry.tries || 0) >= AI_MAX_TRIES) {
    console.warn("[Warden] AI prompt: giving up on tab", tabId, "after", entry.tries, "tries");
    delete map[key]; await saveAiPending(map);
    return null;
  }
  entry.tries = (entry.tries || 0) + 1;
  map[key] = entry;
  await saveAiPending(map);
  console.log("[Warden] AI prompt: handed to tab", tabId, "(try", entry.tries + ")");
  return entry.text;
}

async function launchAnalysis(message, senderTab) {
  const windowId = senderTab && senderTab.windowId != null ? senderTab.windowId : null;
  const searches = (Array.isArray(message.searches) ? message.searches : []).map(normalize).filter(Boolean);
  const aiUrl = normalize(message.aiUrl);
  const text = String(message.text || "");

  // Append at the end of the strip (same reasoning as openLinksAsGroup: an
  // implicit index drops new tabs beside the active one, inside its group).
  let index;
  try {
    const existing = await chrome.tabs.query(windowId != null ? { windowId } : { currentWindow: true });
    index = existing.length;
  } catch (_) { index = undefined; }

  const mk = (url, active) => {
    const props = { url, active };
    if (windowId != null) props.windowId = windowId;
    if (index != null) props.index = index++;
    return props;
  };

  for (const u of searches) {
    try { await chrome.tabs.create(mk(u, false)); } catch (_) {}
  }

  // The AI tab opens LAST and active, so it's the tab you land on — the same
  // end state the Trading Auto Launch produces.
  let aiTabId = null;
  if (aiUrl) {
    try { const t = await chrome.tabs.create(mk(aiUrl, true)); aiTabId = t && t.id != null ? t.id : null; } catch (_) {}
    if (aiTabId != null && text.trim()) {
      const now = Date.now();
      const map = await loadAiPending();
      for (const k of Object.keys(map)) if (!map[k] || map[k].deadline < now) delete map[k];  // prune
      map[String(aiTabId)] = { text, deadline: now + AI_PENDING_MS, tries: 0 };
      await saveAiPending(map);
    }
    if (windowId != null) { try { await chrome.windows.update(windowId, { focused: true }); } catch (_) {} }
  }

  console.log("[Warden] launchAnalysis:", searches.length, "search tab(s),", aiUrl || "no AI tab", "prompt", text.length, "chars");
  return { ok: true, aiTabId, opened: searches.length + (aiUrl ? 1 : 0) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  // ── TradeHub asks whether this build can auto-submit (relayed by warden-bio-sync) ──
  // TradeHub must know BEFORE the click: if we can't do it, its button has to
  // fall back to window.open, and window.open only works inside the click's own
  // gesture — there's no time to ask us and then decide.
  if (message.action === "aiLaunchCapability") { sendResponse({ ok: true }); return true; }

  // ── Launch Analysis: open tabs + auto-submit the prompt in the AI tab ──
  if (message.action === "launchAnalysis") {
    launchAnalysis(message, _sender && _sender.tab)
      .then(sendResponse)
      .catch((e) => { console.warn("[Warden] launchAnalysis failed:", e); sendResponse({ ok: false }); });
    return true;
  }

  // ── warden-ai-prompt.js asking for the prompt this tab was opened to run ──
  // Handing it out does NOT clear it — only a confirmed submit does (below), so
  // a document that dies to a redirect before it can type doesn't swallow the
  // prompt with it.
  if (message.action === "wardenAiPromptPending") {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    (async () => {
      const text = await handOutPrompt(tabId);
      sendResponse(text ? { text } : {});
    })();
    return true;
  }

  // ── a #tbauto tab (opened by the Trading Auto Launch) claiming its prompt ──
  // Registering it in the SAME pending map is the point: from here the tab uses
  // the identical hand-out / retry / confirm path as the TradeHub button, so an
  // auth interstitial or a reload gets another go instead of losing the prompt.
  // A tab that already has an entry just gets it back — a re-claim after a
  // redirect must not reset the try counter or double-fetch.
  if (message.action === "wardenAiAutoSubmit") {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    (async () => {
      await armAutoSubmitTab(tabId);   // usually already armed by the onUpdated listener
      const text = await handOutPrompt(tabId);
      sendResponse(text ? { text } : {});
    })();
    return true;
  }

  // ── the tab confirming it typed + sent the prompt → stop offering it ──
  if (message.action === "wardenAiPromptDone") {
    const tabId = _sender && _sender.tab ? _sender.tab.id : null;
    (async () => {
      if (tabId != null) {
        const map = await loadAiPending();
        if (map[String(tabId)]) { delete map[String(tabId)]; await saveAiPending(map); }
        console.log("[Warden] AI prompt: submitted in tab", tabId);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  // A stale TradeHub tab may still post groupTradingTabs. Acknowledge and ignore
  // it — the Trading Auto Launch tab group was removed.
  if (message.action === "groupTradingTabs") { sendResponse({ ok: false }); return true; }

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

  // ── biometric link sync from Index (warden-bio-sync.js content script) ──
  if (message.action === "wardenBioSync") {
    try { chrome.storage.local.set({ wardenBioLink: message.link || null }, () => sendResponse({ ok: true })); }
    catch (e) { sendResponse({ ok: false }); }
    return true;
  }

  // ── inline autofill: return decrypted matches for a domain ──
  if (message.action === "wardenGetCreds") {
    (async () => {
      try {
        const VP = self.WardenPWCore;
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

  // ── inline autofill: MASKED payment methods for the dropdown ──
  // Deliberately returns WardenPay.summarize() output only — nickname, network,
  // last 4, expiry. No card number, no CVV, no billing address ever crosses into
  // a page-side context just to render a list.
  if (message.action === "wardenGetCards") {
    (async () => {
      try {
        const VP = self.WardenPWCore;
        const resumed = await VP.restoreSession();
        if (!resumed || !VP.isUnlocked()) { sendResponse({ unlocked: false, cards: [] }); return; }
        // The brand badge is generated here (self-drawn SVG, no remote assets) so
        // the content script doesn't need to carry the payments module.
        const cards = (await VP.paymentSummaries()).map((s) => Object.assign({}, s, { mark: self.WardenPay.brandMark(s.network) }));
        sendResponse({ unlocked: true, cvvFresh: VP.authFresh(), cards });
      } catch (e) {
        sendResponse({ unlocked: false, cards: [], error: String(e && e.message || e) });
      }
    })();
    return true; // async
  }

  // ── autofill a chosen card ──
  // Called two ways, both landing here so there is ONE decrypt path:
  //   • from the page dropdown  → fills the exact frame that asked
  //   • from the popup's Fill   → message.tabId set, fills every frame of it
  //     (hosted card fields live in their own iframes)
  //
  // The card is decrypted HERE and handed to warden-cardfill.js's fill() in the
  // extension's isolated world. The page can't observe that world, and the
  // content script keeps no copy — it passes the bundle straight into fill().
  //
  // The CVV rides along ONLY inside the auth-freshness window (a real master
  // password / biometric check within the last CVV_FRESH_MS). Everything else
  // fills regardless, so a long-idle session still autofills the card.
  if (message.action === "wardenFillCard") {
    (async () => {
      const fromPage = !!(_sender && _sender.tab);
      const tabId = fromPage ? _sender.tab.id : message.tabId;
      const frameId = fromPage && _sender.frameId != null ? _sender.frameId : null;
      if (tabId == null) { sendResponse({ ok: false, error: "no-tab" }); return; }
      try {
        const VP = self.WardenPWCore;
        const resumed = await VP.restoreSession();
        if (!resumed || !VP.isUnlocked()) { sendResponse({ ok: false, locked: true }); return; }
        const card = await VP.paymentById(message.id);
        if (!card) { sendResponse({ ok: false, error: "not-found" }); return; }

        const cvvFresh = VP.authFresh();
        const values = self.WardenPay.autofillValues(card, { includeCvv: cvvFresh });

        // Frames that find nothing to fill stay SILENT (see wardenDoFillCard in
        // content.js). That's what makes the popup path work without naming a
        // frame: we broadcast to the whole tab and the frame holding the card
        // fields is the one that answers — no webNavigation permission needed.
        const opts = frameId != null ? { frameId } : {};
        const r = await new Promise((res) => {
          try {
            chrome.tabs.sendMessage(tabId, { action: "wardenDoFillCard", values }, opts, (resp) => {
              void chrome.runtime.lastError; res(resp || null);
            });
          } catch (e) { res(null); }
        });

        const filled = (r && r.filled) || 0;
        await VP.touchSession();
        sendResponse({ ok: filled > 0, filled, cvvFilled: !!(r && r.cvv), cvvFresh });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async
  }

  // ── inline autofill: MASKED ID-document summaries for the dropdown ──
  // Same posture as wardenGetCards: title, type, issuer, expiry and a MASKED
  // number only. The document number itself and every scan stay in the service
  // worker until a specific document is chosen.
  if (message.action === "wardenGetIdDocs") {
    (async () => {
      try {
        const VP = self.WardenPWCore;
        const resumed = await VP.restoreSession();
        if (!resumed || !VP.isUnlocked()) { sendResponse({ unlocked: false, docs: [] }); return; }
        sendResponse({ unlocked: true, authFresh: VP.authFresh(), docs: await VP.idDocSummaries() });
      } catch (e) {
        sendResponse({ unlocked: false, docs: [], error: String(e && e.message || e) });
      }
    })();
    return true; // async
  }

  // ── autofill a chosen ID document's TEXT fields ──
  // Called from the page dropdown (fills the asking frame) or the popup's Fill
  // (message.tabId set → broadcast; the frame that owns the form answers).
  //
  // The document number rides along unless the document is one of the sensitive
  // types (an SSN card) AND no real credential has been presented recently —
  // the same rule the CVV follows. Everything else fills on an unlocked session.
  if (message.action === "wardenFillIdDoc") {
    (async () => {
      const fromPage = !!(_sender && _sender.tab);
      const tabId = fromPage ? _sender.tab.id : message.tabId;
      const frameId = fromPage && _sender.frameId != null ? _sender.frameId : null;
      if (tabId == null) { sendResponse({ ok: false, error: "no-tab" }); return; }
      try {
        const VP = self.WardenPWCore;
        const resumed = await VP.restoreSession();
        if (!resumed || !VP.isUnlocked()) { sendResponse({ ok: false, locked: true }); return; }
        const doc = await VP.idDocById(message.id);
        if (!doc) { sendResponse({ ok: false, error: "not-found" }); return; }

        const sensitive = self.WardenId.isSensitive(doc);
        const includeNumber = !sensitive || VP.authFresh();
        const values = self.WardenId.autofillValues(doc, { includeNumber });

        const opts = frameId != null ? { frameId } : {};
        const r = await new Promise((res) => {
          try {
            chrome.tabs.sendMessage(tabId, { action: "wardenDoFillIdDoc", values }, opts, (resp) => {
              void chrome.runtime.lastError; res(resp || null);
            });
          } catch (e) { res(null); }
        });

        const filled = (r && r.filled) || 0;
        await VP.touchSession();
        sendResponse({ ok: filled > 0, filled, numberFilled: !!(r && r.number), numberWithheld: !includeNumber });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async
  }

  // ── attach a document's SCAN to a file-upload field ──
  // The one place decrypted file bytes have to cross into a page-side context:
  // an <input type="file"> can only be populated with a real File object, which
  // must be constructed in the frame that owns the input. They go to the
  // extension's ISOLATED world (invisible to the page) and are written straight
  // into the input — after which the page can read them, which is precisely
  // what the user asked for by choosing to attach the document.
  //
  // Base64 rather than a typed array: structured-cloning a multi-megabyte
  // Uint8Array through chrome.runtime is dramatically slower and, in MV3,
  // unreliable across a service-worker restart.
  if (message.action === "wardenAttachIdFile") {
    (async () => {
      const fromPage = !!(_sender && _sender.tab);
      const tabId = fromPage ? _sender.tab.id : message.tabId;
      const frameId = fromPage && _sender.frameId != null ? _sender.frameId : null;
      if (tabId == null) { sendResponse({ ok: false, error: "no-tab" }); return; }
      try {
        const VP = self.WardenPWCore;
        const resumed = await VP.restoreSession();
        if (!resumed || !VP.isUnlocked()) { sendResponse({ ok: false, locked: true }); return; }
        const doc = await VP.idDocById(message.id);
        if (!doc) { sendResponse({ ok: false, error: "not-found" }); return; }

        const entries = self.WardenId.allAttachments(doc);
        if (!entries.length) { sendResponse({ ok: false, error: "no-file" }); return; }
        // A specific file when the dropdown named one; otherwise the front /
        // first page, which is what "attach my licence" means.
        const chosen = (message.key && entries.filter((e) => e.att.key === message.key)[0]) || entries[0];
        const att = chosen.att;
        if (att.pending) { sendResponse({ ok: false, error: "pending" }); return; }
        if ((att.size || 0) > 12 * 1024 * 1024) { sendResponse({ ok: false, error: "too-large" }); return; }

        const bytes = await VP.attachmentBytes(att);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        const b64 = btoa(bin);

        const opts = frameId != null ? { frameId } : {};
        const r = await new Promise((res) => {
          try {
            chrome.tabs.sendMessage(tabId, {
              action: "wardenDoAttachIdFile",
              file: { b64, name: att.name || "document", mime: att.mime || "application/octet-stream" },
            }, opts, (resp) => { void chrome.runtime.lastError; res(resp || null); });
          } catch (e) { res(null); }
        });

        await VP.touchSession();
        if (r && r.ok) { sendResponse({ ok: true, name: att.name || "document" }); return; }
        sendResponse({ ok: false, error: (r && r.error) || "no-field" });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async
  }
});
