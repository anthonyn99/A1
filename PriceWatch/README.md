# PriceWatch

Browser extension that puts **real, live prices** into MyList's Price Watch by opening each
store's own search page in your normal Chrome session, reading the rendered results, and
closing the tab.

No server. No paid scraping service. No third-party data API. No login automation, no
credential entry — it only reads public search-result pages, using the session, cookies and IP
you already browse with.

---

## Why it exists

Price Watch had two tiers of number:

| tier | badge | where it comes from |
|---|---|---|
| Kroger / King Soopers | `✓ verified` | official Kroger Products API |
| everything else | `🔍 estimated` | Gemini-grounded Google Search (an educated guess) |

PriceWatch adds a third, which sits above the guess:

| tier | badge | where it comes from |
|---|---|---|
| scraped stores | `✓ live` | actually read off that store's search page, in your browser |

The estimated tier does **not** go away. If a store is bot-checked, cooling down, or has no
parser module, MyList falls back to the AI-search path for exactly those stores — installing
this can only add coverage, never remove it.

---

## The store list is never stored here

This is the core rule. The retailer set lives in the `stores` field of
`dashboards/pricewatch[-veda]`, edited from MyList's **Manage Stores** panel.

- **Message path** — MyList sends `pwStores()` with every `PW_CHECK`. The list is read at call
  time, so a store added or removed in Manage Stores applies to the very next check.
- **Alarm path** — each run POSTs `/watch/state` to the personal-ai worker and uses the store
  list that comes back from the doc.

Neither path caches a store list, and neither has one compiled in. Adding a retailer never
requires rebuilding or reloading this extension.

A store whose domain has no parser module comes back `source:"unsupported"` with a note. The
other stores in the same request are unaffected.

---

## Files

```
manifest.json      MV3. Pinned "key" → stable extension id across machines.
background.js      Service worker: message + alarm entry points, orchestration,
                   rate limiting, tab lifecycle, response assembly.
pw-core.js         Pure helpers. relevanceScore / normStores / cleanDomain are a
                   deliberate PORT of workers/personal-ai/worker.js — keep in sync.
parsers/common.js  Parser registry + the DOM helpers every module is built from.
parsers/*.js       One module per store domain.
popup.html/.js     Settings (rate limit, auto-checks) + activity log.
```

`parsers/*.js` are loaded in **two** contexts: `importScripts()` in the service worker (so it
knows each store's `searchUrl()` and file path) and `chrome.scripting.executeScript` in the
scraped page's isolated world (where `parse()` runs). **Nothing in a parser may touch
`document` at load time** — DOM access belongs inside `parse()` / `blocked()` only.

That `importScripts()` call is also what makes the installer find the parsers: the packager in
`mylist.html` walks `manifest.json → popup.html → importScripts()`, and the parsers are
injected dynamically so the manifest never references them.

---

## Adding a store parser

1. Copy `parsers/amazon.js` to `parsers/<store>.js`.
2. Register it by **domain** — the same domain the user typed in Manage Stores.
3. Add the file to the `importScripts()` list in `background.js`.
4. Add `"https://www.<store>.com/*"` to `host_permissions` in `manifest.json`
   (`executeScript` needs it; `tabs.create` does not).
5. Bump `version`.

Selector lists are tried **in order**. Put today's markup first and older/more generic
selectors after — a module keeps working through a redesign as long as one still matches.
`H.price()` falls back to a `$`-anchored regex sweep of the card's own text, which is what
carries a module through a renamed price node.

---

## Rate limiting

A store domain is not re-opened more often than **every 3 hours** (configurable 1/3/6/12h in
the popup), whoever asks — MyList or the alarm. Within that window the last cached result for
that exact query is returned instead, flagged `cached`, and no tab opens.

Other pacing: stores are scraped strictly **one at a time**, with a randomised 2.2–6.5s gap
between them, and tabs open **inactive** so a check never steals focus.

Hitting a bot check triggers a longer backoff (**6h** default) and the store reports
`source:"blocked"`. It is never retried in a loop — that's what escalates a block.

---

## Background auto-checks

**Off by default** (they open tabs on their own). Enable in the popup.

When on, a `chrome.alarms` timer fires every 4h (configurable) and, for each configured
profile: reads `/watch/state` → scrapes up to 3 items → POSTs `/watch/ingest`.

The extension does **not** write Firestore directly: mylist.html enables App Check
(reCAPTCHA v3), which an extension service worker cannot attest to. `/watch/ingest` on the
personal-ai worker writes with its existing service-account JWT and reuses the same
`pwApplyToItem()` / `pwNotifyDrop()` the daily cron uses — so history shape, the `source`
badge, and the >$1 drop push are identical no matter which path did the checking.

---

## Installing

Use **Install PriceWatch** in MyList → Price Watch (under your store chips). It packages the
newest source straight from GitHub into a zip and walks you through Load Unpacked — same
mechanism as Index's "Install Vault".

Unpacked extensions don't self-update: download again, replace the folder in place, then hit
Reload ⟳ on the extensions page.

**Chrome ≥ 137 blocks `--load-extension` from the command line**, but Load Unpacked from the
extensions page works normally. Brave / Edge / Opera work as-is. **Firefox is not supported** —
no MV3 service worker, no `externally_connectable`.

The extension id is pinned by the `key` field in `manifest.json` to:

```
oinemolmfefbaifalljkflfaleapihco
```

mylist.html hardcodes that id (`PW_EXT_ID`). **If you regenerate the key, update it there too**
or the bridge silently goes dead. The matching private key was never committed — it's only
needed to pack a `.crx`, which this install flow doesn't use.

---

## Reality check on scraping

Walmart, CVS and Walgreens all sit behind commercial bot walls (Akamai / PerimeterX) that
fire on headless browsers and sometimes on real ones. Verified 2026-07-22 from headless Brave:

| store | result |
|---|---|
| Amazon | ✅ 12 products with real prices, titles, `/dp/` URLs, thumbnails |
| Walmart | ⛔ bot check (correctly detected → 6h backoff) |
| CVS | ⛔ bot check (correctly detected → 6h backoff) |
| Walgreens | ⛔ Akamai "Challenge Validation", empty body (correctly detected → 6h backoff) |

A real Chrome profile with history, cookies and a non-headless fingerprint clears these walls
far more often than headless does — that is the entire reason this runs in your own browser
instead of on a server. But expect it to be **intermittent**, not guaranteed. Every blocked
store falls back to the AI-estimated path, so a wall costs freshness, never the price itself.
