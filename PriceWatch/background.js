// ─────────────────────────────────────────────────────────────────────────────
// PriceWatch — MV3 service worker.
//
// Two entry points, one scraping engine:
//
//   1. MyList (https://anthonyn99.github.io) → chrome.runtime.sendMessage via
//      externally_connectable. The page hands over the product term AND the
//      store list it is holding RIGHT NOW (pwStores()). Nothing about the store
//      set is baked in here — add or remove a retailer in MyList's Manage
//      Stores panel and the very next message carries the new list.
//   2. chrome.alarms → the same engine, with the store list + items pulled
//      fresh from the pricewatch Firestore doc (via the personal-ai worker),
//      then written back through /watch/ingest. Works with MyList closed.
//
// For each store we open a REAL tab in the user's own session, let it render,
// read the DOM, and close it. No server, no data API, no headless browser —
// which is exactly why it sees the same prices a human would.
//
// Kroger / King Soopers are never scraped: they have an official Products API
// and are routed to the existing worker path (see STORE_NOTES.md). A store
// whose domain has no parser module comes back source:"unsupported" — one
// unknown retailer never sinks the rest of the request.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

importScripts(
  "pw-core.js",
  "parsers/common.js",
  "parsers/walmart.js",
  "parsers/amazon.js",
  "parsers/cvs.js",
  "parsers/walgreens.js"
);

const API = "https://personal-ai.av1.workers.dev";
const ALLOWED_ORIGIN = "https://anthonyn99.github.io";
const ALARM_AUTO = "pw-auto";

// ── Defaults ────────────────────────────────────────────────────────────────
// minIntervalHours is the anti-abuse floor: the same store domain is not
// re-opened more often than this, whoever asks. A rate-limited store returns
// its last cached result (flagged `cached`) rather than nothing, so the UI
// still shows a price instead of a hole.
const DEFAULTS = {
  autoEnabled: false,        // background auto-checks are OPT-IN (they open tabs)
  autoEveryMin: 240,         // 4h between alarm runs
  minIntervalHours: 3,       // per-domain floor
  blockedBackoffHours: 6,    // longer cooldown after a bot wall
  maxItemsPerRun: 3,         // items per alarm run (mirrors the worker cron cap)
  profiles: ["tony"]
};
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SETTLE_MS = 1400;      // after load event, before the first parse attempt
const POLL_MS = 800;         // between parse attempts while results hydrate
const MAX_POLLS = 12;        // ~10s of hydration budget
const LOAD_TIMEOUT_MS = 30000;

// Pacing between two stores in one run. Randomised so a run doesn't produce a
// machine-regular request cadence.
const GAP_MIN_MS = 2200, GAP_MAX_MS = 6500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => Math.round(a + Math.random() * (b - a));

// ── Settings / log ──────────────────────────────────────────────────────────
async function getCfg() {
  const d = await chrome.storage.local.get("pw_cfg");
  return Object.assign({}, DEFAULTS, (d && d.pw_cfg) || {});
}
async function setCfg(patch) {
  const cur = await getCfg();
  const next = Object.assign({}, cur, patch);
  await chrome.storage.local.set({ pw_cfg: next });
  await syncAlarm(next);
  return next;
}
async function log(msg) {
  try {
    const d = await chrome.storage.local.get("pw_log");
    const arr = (d && d.pw_log) || [];
    arr.unshift({ at: Date.now(), msg: String(msg).slice(0, 300) });
    await chrome.storage.local.set({ pw_log: arr.slice(0, 40) });
  } catch (e) {}
  console.log("[pricewatch]", msg);
}

// ── Per-domain rate limiting ────────────────────────────────────────────────
const rlKey = (d) => "rl_" + d;
const cacheKey = (d, q) => "c_" + d + "_" + self.PWCore.hashKey(self.PWCore.normName(q));

async function rlState(domain) {
  const d = await chrome.storage.local.get(rlKey(domain));
  return (d && d[rlKey(domain)]) || { at: 0, until: 0 };
}
async function rlStamp(domain, backoffMs) {
  const now = Date.now();
  await chrome.storage.local.set({
    [rlKey(domain)]: { at: now, until: now + (backoffMs || 0) }
  });
}
async function readCache(domain, query) {
  const k = cacheKey(domain, query);
  const d = await chrome.storage.local.get(k);
  const hit = d && d[k];
  if (!hit || (Date.now() - hit.at) > CACHE_TTL_MS) return null;
  return hit;
}
async function writeCache(domain, query, results) {
  await chrome.storage.local.set({ [cacheKey(domain, query)]: { at: Date.now(), results } });
}

// ── Tab plumbing ────────────────────────────────────────────────────────────
// Tabs are created INACTIVE so a check never steals focus mid-browse. When no
// normal window exists (alarm firing with the browser idle in the tray) we open
// one unfocused and close it again afterwards.
async function openScrapeTab(url) {
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  if (wins.length) {
    const tab = await chrome.tabs.create({ url, active: false });
    return { tabId: tab.id, tempWindowId: null };
  }
  const win = await chrome.windows.create({ url, focused: false, width: 1280, height: 900 });
  return { tabId: win.tabs[0].id, tempWindowId: win.id };
}
async function closeScrapeTab(h) {
  try {
    if (h.tempWindowId != null) await chrome.windows.remove(h.tempWindowId);
    else await chrome.tabs.remove(h.tabId);
  } catch (e) {}
}
async function waitForLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return false; } // tab gone
    if (tab.status === "complete") return true;
    await sleep(300);
  }
  return false; // parse anyway — a stalled subresource shouldn't lose the grid
}

// Open the store's SEARCH page (not a pinned product URL) so similar products
// come back alongside the tracked one, then read the rendered grid.
async function scrapeInTab(def, domain, query) {
  const url = def.searchUrl(query);
  const h = await openScrapeTab(url);
  try {
    await waitForLoad(h.tabId, LOAD_TIMEOUT_MS);
    await sleep(SETTLE_MS + jitter(0, 700));

    await chrome.scripting.executeScript({
      target: { tabId: h.tabId },
      files: ["pw-core.js", "parsers/common.js", def.file]
    });

    // Results hydrate progressively. Poll until the count stops growing —
    // stable-twice, so we don't grab a half-rendered grid.
    let best = { results: [], blocked: false, note: "" };
    let stableAt = -1;
    let lastWeak = false;
    for (let i = 0; i < MAX_POLLS; i++) {
      let out;
      try {
        const [inj] = await chrome.scripting.executeScript({
          target: { tabId: h.tabId },
          func: (d) => self.PWP.run(d),
          args: [domain]
        });
        out = inj && inj.result;
      } catch (e) {
        out = { results: [], blocked: false, note: "inject failed: " + (e.message || e) };
      }
      if (out) {
        if (out.blocked) return { results: [], blocked: true, url };
        lastWeak = !!out.weak;
        if (out.results.length >= best.results.length) best = out;
        if (best.results.length > 0) {
          if (stableAt === best.results.length) break;
          stableAt = best.results.length;
        }
      }
      await sleep(POLL_MS);
    }
    // Poll budget spent with nothing found AND the body never filled in: that's
    // an unnamed interstitial, not a slow page. Treat it as blocked so it earns
    // the long backoff instead of being retried at the normal interval.
    if (!best.results.length && lastWeak) return { results: [], blocked: true, url };
    return { results: best.results, blocked: false, note: best.note || "", url };
  } finally {
    await closeScrapeTab(h);
  }
}

// ── One store ───────────────────────────────────────────────────────────────
// Always resolves — every failure mode becomes a typed entry, never a throw.
async function scrapeStore(store, query, cfg) {
  const domain = self.PWCore.cleanDomain(store.domain);
  const base = { store: store.key, storeName: store.name };
  const def = domain && self.PWP.get(domain);

  if (!def) {
    return Object.assign({}, base, {
      source: "unsupported", variants: [],
      note: domain ? ("no scraper module for " + domain) : "no website set for this store"
    });
  }

  const rl = await rlState(domain);
  const minMs = cfg.minIntervalHours * 3600 * 1000;
  const waitMs = Math.max(rl.until - Date.now(), (rl.at + minMs) - Date.now());
  if (waitMs > 0) {
    const cached = await readCache(domain, query);
    const mins = Math.ceil(waitMs / 60000);
    if (cached) {
      return Object.assign({}, base, {
        source: "live-scrape", variants: cached.results.slice(), cached: true, cachedAt: cached.at,
        note: "cached " + new Date(cached.at).toLocaleString() + " · next check in ~" + mins + "m"
      });
    }
    return Object.assign({}, base, {
      source: "rate-limited", variants: [],
      note: "cooling down — next check in ~" + mins + "m"
    });
  }

  let out;
  try {
    out = await scrapeInTab(def, domain, query);
  } catch (e) {
    await rlStamp(domain, 0);
    return Object.assign({}, base, { source: "unavailable", variants: [], note: "scrape error: " + (e.message || e) });
  }

  if (out.blocked) {
    // Back off HARD on a bot wall — hammering it is what escalates a block.
    await rlStamp(domain, cfg.blockedBackoffHours * 3600 * 1000);
    await log(store.name + ": bot check hit, backing off " + cfg.blockedBackoffHours + "h");
    return Object.assign({}, base, { source: "blocked", variants: [], note: "store showed a bot check" });
  }

  await rlStamp(domain, 0);
  if (!out.results.length) {
    return Object.assign({}, base, {
      source: "unavailable", variants: [],
      note: out.note || "no priced results on the search page"
    });
  }
  await writeCache(domain, query, out.results);
  return Object.assign({}, base, { source: "live-scrape", variants: out.results });
}

// ── Kroger banners → existing worker API path ───────────────────────────────
async function krogerBreakdown(profile, item, krogerStores) {
  if (!krogerStores.length) return [];
  try {
    const r = await fetch(API + "/watch/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, item, stores: krogerStores })
    });
    const j = await r.json();
    if (j && Array.isArray(j.breakdown)) return j.breakdown;
    throw new Error((j && j.error) || "bad response");
  } catch (e) {
    return krogerStores.map((s) => ({
      store: s.key, storeName: s.name, source: "unavailable", variants: [],
      note: "Kroger API unreachable: " + (e.message || e)
    }));
  }
}

// ── Full check ──────────────────────────────────────────────────────────────
// Returns the SAME shape as the worker's checkAllStores(), so MyList's existing
// pwApplyResult() / pwSlim() consume it with no special-casing.
async function checkItem(profile, item, storesInput, opts) {
  const cfg = await getCfg();
  const stores = self.PWCore.normStores(storesInput);
  if (!stores.length) return { ok: false, error: "no stores supplied" };

  const itemName = item.name || item.itemName || "";
  const brandLock = item.brandLock || "";
  if (!itemName) return { ok: false, error: "missing item name" };

  const krogerStores = stores.filter((s) => s.type === "kroger");
  const scrapeStores = stores.filter((s) => s.type !== "kroger");

  const perStore = {};
  const krogerPromise = krogerBreakdown(profile, item, krogerStores);

  // Strictly sequential, with a randomised gap — one tab at a time is both
  // kinder to the machine and much less conspicuous than parallel bursts.
  for (let i = 0; i < scrapeStores.length; i++) {
    const s = scrapeStores[i];
    const entry = await scrapeStore(s, itemName, cfg);
    perStore[s.key] = entry;
    if (i < scrapeStores.length - 1) await sleep(jitter(GAP_MIN_MS, GAP_MAX_MS));
  }
  (await krogerPromise).forEach((e) => { perStore[e.store] = e; });

  // Rank + pick the cheapest per store, exactly as the worker does.
  const breakdown = stores.map((s) => {
    const res = perStore[s.key] || { source: "unavailable", variants: [] };
    const variants = (Array.isArray(res.variants) ? res.variants : []).map((v) =>
      Object.assign({}, v, { store: s.key, source: res.source }));
    variants.forEach((v) => {
      v.score = self.PWCore.relevanceScore(itemName, brandLock, (v.brand || "") + " " + (v.title || ""));
    });
    variants.sort((a, b) => (b.score - a.score) || (a.price - b.price));

    let cheapest = null;
    variants.forEach((v) => {
      if (typeof v.price === "number" && (cheapest === null || v.price < cheapest.price)) cheapest = v;
    });

    const entry = {
      store: s.key, storeName: s.name,
      source: cheapest ? res.source : (res.source === "live-scrape" ? "unavailable" : res.source),
      variants
    };
    if (cheapest) {
      entry.price = cheapest.price;
      if (cheapest.url) entry.url = cheapest.url;
      if (cheapest.brand) entry.brand = cheapest.brand;
      if (cheapest.title) entry.foundTitle = cheapest.title;
      if (cheapest.thumb) entry.thumb = cheapest.thumb;
      if (cheapest.currency && cheapest.currency !== "USD") entry.currency = cheapest.currency;
      if (cheapest.krogerProductId) entry.krogerProductId = cheapest.krogerProductId;
    }
    if (res.note) entry.note = res.note;
    if (res.cached) { entry.cached = true; entry.cachedAt = res.cachedAt; }
    return entry;
  });

  let best = null;
  breakdown.forEach((e) => {
    if (typeof e.price === "number" && (best === null || e.price < best.price)) best = e;
  });

  return {
    ok: true,
    via: "pricewatch-extension",
    breakdown,
    bestPrice: best ? best.price : null,
    bestStore: best ? best.store : null,
    bestStoreName: best ? (best.storeName || best.store) : null,
    bestBrand: best ? (best.brand || "") : "",
    foundCount: breakdown.filter((e) => typeof e.price === "number").length,
    storeCount: stores.length,
    stores: stores.map((s) => ({ key: s.key, name: s.name, type: s.type, domain: s.domain || "" }))
  };
}

// ── Serialised queue ────────────────────────────────────────────────────────
// Concurrent checks would open overlapping tabs and defeat the pacing, so every
// request goes through one chain.
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ── MyList bridge (externally_connectable) ──────────────────────────────────
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!sender || !sender.origin || sender.origin !== ALLOWED_ORIGIN) {
    sendResponse({ ok: false, error: "origin not allowed" });
    return false;
  }
  const type = msg && msg.type;

  if (type === "PW_PING") {
    getCfg().then((cfg) => sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
      domains: self.PWP.domains(),
      autoEnabled: cfg.autoEnabled,
      minIntervalHours: cfg.minIntervalHours
    }));
    return true;
  }

  if (type === "PW_CHECK") {
    // `stores` is whatever MyList holds right now — never a cached copy here.
    enqueue(() => checkItem(msg.profile === "veda" ? "veda" : "tony", msg.item || {}, msg.stores, msg))
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }

  if (type === "PW_SET_PROFILE") {
    // Lets MyList tell the alarm path which profile(s) to auto-check.
    const p = msg.profile === "veda" ? "veda" : "tony";
    getCfg().then((cfg) => {
      const set = new Set(cfg.profiles || []);
      set.add(p);
      return setCfg({ profiles: [...set] });
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  sendResponse({ ok: false, error: "unknown message type" });
  return false;
});

// ── Popup bridge ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  if (type === "PW_GET_STATE") {
    Promise.all([getCfg(), chrome.storage.local.get("pw_log")]).then(([cfg, d]) => {
      sendResponse({ ok: true, cfg, log: (d && d.pw_log) || [], domains: self.PWP.domains() });
    });
    return true;
  }
  if (type === "PW_SET_CFG") {
    setCfg(msg.patch || {}).then((cfg) => sendResponse({ ok: true, cfg }));
    return true;
  }
  if (type === "PW_RUN_NOW") {
    enqueue(() => runAutoCheck(true)).then((r) => sendResponse({ ok: true, ran: r }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (type === "PW_CLEAR_LIMITS") {
    chrome.storage.local.get(null).then((all) => {
      const keys = Object.keys(all).filter((k) => k.indexOf("rl_") === 0);
      return chrome.storage.local.remove(keys).then(() => keys.length);
    }).then((n) => sendResponse({ ok: true, cleared: n }));
    return true;
  }
  return false;
});

// ── Background auto-checks (chrome.alarms) ──────────────────────────────────
async function syncAlarm(cfg) {
  await chrome.alarms.clear(ALARM_AUTO);
  if (cfg.autoEnabled) {
    chrome.alarms.create(ALARM_AUTO, {
      periodInMinutes: Math.max(60, cfg.autoEveryMin),
      delayInMinutes: 2
    });
  }
}

// The store list for an alarm run is read from the SAME Firestore doc MyList
// writes, so a retailer added in Manage Stores is picked up on the next run
// with no extension change — identical rule to the message path.
async function fetchState(profile) {
  const r = await fetch(API + "/watch/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile })
  });
  const j = await r.json();
  if (!j || j.ok === false) throw new Error((j && j.error) || "state fetch failed");
  return j;
}

async function ingest(profile, results) {
  const r = await fetch(API + "/watch/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, results, via: "pricewatch-extension" })
  });
  const j = await r.json();
  if (!j || j.ok === false) throw new Error((j && j.error) || "ingest failed");
  return j;
}

// Rotates through the watchlist a few items per run (same round-robin idea as
// the worker cron) so a long list doesn't mean a long tab-opening session.
async function runAutoCheck(manual) {
  const cfg = await getCfg();
  if (!cfg.autoEnabled && !manual) return 0;

  let done = 0;
  for (const profile of (cfg.profiles || ["tony"])) {
    let state;
    try { state = await fetchState(profile); }
    catch (e) { await log("auto[" + profile + "] state read failed: " + (e.message || e)); continue; }

    const items = (state.items || []).filter((i) => i && (i.itemName || i.name));
    if (!items.length) continue;

    const ck = "pw_cursor_" + profile;
    const cd = await chrome.storage.local.get(ck);
    let cursor = (cd && cd[ck]) || 0;
    if (cursor >= items.length) cursor = 0;
    const slice = items.slice(cursor, cursor + cfg.maxItemsPerRun);
    await chrome.storage.local.set({
      [ck]: (cursor + cfg.maxItemsPerRun >= items.length) ? 0 : cursor + cfg.maxItemsPerRun
    });

    const results = [];
    for (const it of slice) {
      const res = await checkItem(profile, it, state.stores, {});
      if (res.ok) {
        results.push({
          id: it.id,
          breakdown: res.breakdown.map((e) => {
            const o = { store: e.store, storeName: e.storeName, source: e.source };
            if (typeof e.price === "number") o.price = e.price;
            if (e.url) o.url = e.url;
            if (e.brand) o.brand = e.brand;
            if (e.foundTitle) o.foundTitle = e.foundTitle;
            if (e.krogerProductId) o.krogerProductId = e.krogerProductId;
            if (e.note) o.note = e.note;
            return o;
          }),
          bestPrice: res.bestPrice,
          bestStore: res.bestStore,
          bestStoreName: res.bestStoreName
        });
        done++;
      }
      await sleep(jitter(GAP_MIN_MS, GAP_MAX_MS));
    }

    if (results.length) {
      try {
        await ingest(profile, results);
        await log("auto[" + profile + "] wrote " + results.length + " item(s) to Firestore");
      } catch (e) {
        await log("auto[" + profile + "] ingest failed: " + (e.message || e));
      }
    }
  }
  return done;
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_AUTO) enqueue(() => runAutoCheck(false));
});

chrome.runtime.onInstalled.addListener(async () => {
  const cfg = await getCfg();
  await syncAlarm(cfg);
  await log("PriceWatch installed · parsers: " + self.PWP.domains().join(", "));
});
chrome.runtime.onStartup.addListener(async () => { await syncAlarm(await getCfg()); });
