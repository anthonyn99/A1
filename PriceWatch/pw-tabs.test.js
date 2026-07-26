// Verifies the orphan-scrape-tab registry + sweep in background.js.
//
// The bug this guards: an MV3 service worker is torn down on browser shutdown,
// so scrapeInTab()'s `finally` never runs and the tab survives — then session
// restore hands it back on the next launch. The restart case is the tricky one
// because TAB IDS CHANGE across a restart, so the sweep has to match on URL.
//
//   node pw-tabs.test.js
"use strict";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  ✓", n)) : (fail++, console.log("  ✗ FAIL:", n)); };

// ── chrome stub ─────────────────────────────────────────────────────────────
function makeChrome() {
  const store = {};
  let nextTabId = 100, nextWinId = 900;
  const tabs = new Map();      // id -> { id, url, windowId }
  const windows = new Map();   // id -> { id }
  const alarms = new Map();
  const listeners = { updated: [], removed: [], alarm: [], startup: [], installed: [] };

  const chrome = {
    storage: { local: {
      get: async (k) => (k in store ? { [k]: store[k] } : {}),
      set: async (o) => { Object.assign(store, o); },
    } },
    alarms: {
      create: async (n, o) => { alarms.set(n, o); },
      clear: async (n) => { alarms.delete(n); },
      onAlarm: { addListener: (f) => listeners.alarm.push(f) },
    },
    tabs: {
      create: async ({ url }) => { const t = { id: nextTabId++, url, windowId: 1 }; tabs.set(t.id, t); return t; },
      query: async () => Array.from(tabs.values()),
      remove: async (id) => { if (!tabs.has(id)) throw new Error("No tab with id " + id); tabs.delete(id); },
      get: async (id) => { if (!tabs.has(id)) throw new Error("no tab"); return tabs.get(id); },
      onUpdated: { addListener: (f) => listeners.updated.push(f) },
      onRemoved: { addListener: (f) => listeners.removed.push(f) },
    },
    windows: {
      getAll: async () => Array.from(windows.values()),
      create: async ({ url }) => {
        const w = { id: nextWinId++ }; windows.set(w.id, w);
        const t = { id: nextTabId++, url, windowId: w.id }; tabs.set(t.id, t);
        return { id: w.id, tabs: [t] };
      },
      remove: async (id) => {
        if (!windows.has(id)) throw new Error("no window");
        windows.delete(id);
        for (const [tid, t] of tabs) if (t.windowId === id) tabs.delete(tid);
      },
    },
    runtime: {
      onStartup: { addListener: (f) => listeners.startup.push(f) },
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      onMessage: { addListener: () => {} },
      onMessageExternal: { addListener: () => {} },
      lastError: null,
    },
    action: { onClicked: { addListener: () => {} } },
  };
  return { chrome, store, tabs, windows, alarms, listeners,
    // simulate a browser restart: same URLs come back with BRAND NEW ids
    restart() {
      const urls = Array.from(tabs.values()).map((t) => t.url);
      tabs.clear(); windows.clear();
      urls.forEach((u) => { const t = { id: nextTabId++, url: u, windowId: 1 }; tabs.set(t.id, t); });
    },
    openUserTab(url) { const t = { id: nextTabId++, url, windowId: 1 }; tabs.set(t.id, t); return t; },
  };
}

// background.js is a service-worker SCRIPT, not a module: its top-level
// `async function`s are meant to land in the global scope. require() would box
// them in a module wrapper, so run it as a real script instead — that's also
// closer to how the browser actually loads it.
const vm = require("vm");
const fs = require("fs");
const BG_SRC = fs.readFileSync(require.resolve("./background.js"), "utf8");

// Each load gets its OWN vm context — that's what makes "restart the worker"
// testable, and it stops the script's top-level `const`s colliding on reload.
// Returns the sandbox, which is the worker's global scope.
function loadBackground(env) {
  const sandbox = {
    chrome: env.chrome,
    importScripts: () => {},
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => "" }),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.self.PWP = { domains: () => [], get: () => null, run: () => ({ results: [] }) };
  sandbox.self.PWCore = { cleanDomain: (d) => d };
  vm.runInContext(BG_SRC, sandbox, { filename: "background.js" });
  return sandbox;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  console.log("\n── registry records a scrape tab ──");
  let env = makeChrome();
  env.windows.set(1, { id: 1 });                       // a normal window exists
  let sw = loadBackground(env);
  await tick();
  const g = sw;
  const h1 = await g.openScrapeTab("https://www.walmart.com/search?q=milk");
  ok("tab created", env.tabs.has(h1.tabId));
  ok("recorded in storage.local (survives browser close)", (env.store.pwOpenTabs || []).length === 1);
  ok("record carries the url", env.store.pwOpenTabs[0].url === "https://www.walmart.com/search?q=milk");
  ok("watchdog alarm armed", env.alarms.has("pw-sweep"));

  console.log("\n── normal close clears the record ──");
  await g.closeScrapeTab(h1);
  ok("tab closed", !env.tabs.has(h1.tabId));
  ok("record removed", (env.store.pwOpenTabs || []).length === 0);
  ok("watchdog disarmed when idle", !env.alarms.has("pw-sweep"));

  console.log("\n── an in-flight scrape is NOT swept ──");
  const h2 = await g.openScrapeTab("https://www.amazon.com/s?k=eggs");
  let closed = await g.sweepOrphanTabs("wake");
  ok("fresh tab survives a wake sweep", closed === 0 && env.tabs.has(h2.tabId));
  ok("record retained", env.store.pwOpenTabs.length === 1);

  console.log("\n── watchdog closes a tab the worker abandoned ──");
  env.store.pwOpenTabs[0].at = Date.now() - (4 * 60 * 1000);   // older than TAB_MAX_LIFE_MS
  closed = await g.sweepOrphanTabs("watchdog");
  ok("stale tab closed", closed === 1 && !env.tabs.has(h2.tabId));
  ok("record cleared", env.store.pwOpenTabs.length === 0);

  console.log("\n── THE BUG: orphan survives shutdown, restored with a NEW id ──");
  const h3 = await g.openScrapeTab("https://www.cvs.com/search?q=vitamins");
  const oldId = h3.tabId;
  ok("registry holds the pre-restart id", env.store.pwOpenTabs[0].tabId === oldId);
  env.restart();                                        // session restore: same URL, new id
  ok("tab came back with a different id", !env.tabs.has(oldId) && env.tabs.size === 1);
  ok("id-based lookup would now fail", !Array.from(env.tabs.values()).some((t) => t.id === oldId));

  sw = loadBackground(env);                               // fresh worker, in-memory set empty
  await tick();
  closed = await sw.sweepOrphanTabs("startup");
  ok("startup sweep closed the restored orphan", closed === 1);
  ok("no scrape tabs left", env.tabs.size === 0);
  ok("registry emptied", (env.store.pwOpenTabs || []).length === 0);

  console.log("\n── redirects: the recorded url tracks the tab ──");
  env = makeChrome(); env.windows.set(1, { id: 1 });
  sw = loadBackground(env); await tick();
  const h4 = await sw.openScrapeTab("https://www.walmart.com/search?q=bread");
  const finalUrl = "https://www.walmart.com/browse/bread-12345";
  env.tabs.get(h4.tabId).url = finalUrl;
  for (const f of env.listeners.updated) await f(h4.tabId, { url: finalUrl });
  ok("registry followed the redirect", env.store.pwOpenTabs[0].url === finalUrl);
  env.restart();
  sw = loadBackground(env); await tick();
  closed = await sw.sweepOrphanTabs("startup");
  ok("redirected orphan still gets closed", closed === 1 && env.tabs.size === 0);

  console.log("\n── a temp window is removed whole ──");
  env = makeChrome();                                    // NO normal window → temp window path
  sw = loadBackground(env); await tick();
  const h5 = await sw.openScrapeTab("https://www.walgreens.com/search?q=soap");
  ok("temp window created", h5.tempWindowId != null && env.windows.has(h5.tempWindowId));
  env.store.pwOpenTabs[0].at = Date.now() - (4 * 60 * 1000);
  closed = await sw.sweepOrphanTabs("watchdog");
  ok("window closed, not just the tab", !env.windows.has(h5.tempWindowId) && env.tabs.size === 0);

  console.log("\n── it must NOT close the user's own tabs ──");
  env = makeChrome(); env.windows.set(1, { id: 1 });
  sw = loadBackground(env); await tick();
  const mine = await sw.openScrapeTab("https://www.amazon.com/s?k=coffee");
  const theirs = env.openUserTab("https://www.amazon.com/s?k=headphones");
  const unrelated = env.openUserTab("https://news.ycombinator.com/");
  env.restart();
  sw = loadBackground(env); await tick();
  await sw.sweepOrphanTabs("startup");
  const left = Array.from(env.tabs.values()).map((t) => t.url).sort();
  console.log("   surviving tabs:", left.join(", "));
  ok("the scrape tab is gone", !left.includes("https://www.amazon.com/s?k=coffee"));
  ok("a different search on the SAME site survives", left.includes("https://www.amazon.com/s?k=headphones"));
  ok("an unrelated tab survives", left.includes("https://news.ycombinator.com/"));
  ok("exactly the one tab was closed", left.length === 2);

  console.log("\n── user closing the tab drops the record ──");
  env = makeChrome(); env.windows.set(1, { id: 1 });
  sw = loadBackground(env); await tick();
  const h6 = await sw.openScrapeTab("https://www.cvs.com/search?q=soap");
  env.tabs.delete(h6.tabId);
  for (const f of env.listeners.removed) f(h6.tabId);
  await tick();
  ok("record dropped so its url can't match later", (env.store.pwOpenTabs || []).length === 0);

  console.log("\n── a very old record never matches a coincidental url ──");
  env = makeChrome(); env.windows.set(1, { id: 1 });
  sw = loadBackground(env); await tick();
  const h7 = await sw.openScrapeTab("https://www.walmart.com/search?q=old");
  env.store.pwOpenTabs[0].at = Date.now() - (49 * 60 * 60 * 1000);  // > ORPHAN_STALE_MS
  env.restart();
  sw = loadBackground(env); await tick();
  await sw.sweepOrphanTabs("startup");
  ok("stale record does not close a same-url tab", env.tabs.size === 1);
  ok("but the record is discarded", (env.store.pwOpenTabs || []).length === 0);

  console.log("\n  " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
