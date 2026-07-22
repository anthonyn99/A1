# Price Watch — Store Integration Notes

Persistent memory across Claude Code sessions for MyList's "Price Watch" feature.
**Read this before touching a store module in `workers/personal-ai/worker.js`, and
update the relevant section after.** One section per store.

Three integration classes:
- **Verified (`source: "verified"`)** — Kroger / King Soopers via the official
  Products API. Real numbers, no AI.
- **Live (`source: "live-scrape"`)** — the **PriceWatch browser extension**
  (`PriceWatch/`) opens the store's real search page in Tony's own Chrome session,
  reads the rendered grid, closes the tab. Real observed numbers, no AI, no server.
  Badge `✓ live`. See the PriceWatch section below.
- **Estimated (`source: "ai-estimated"`)** — Walmart / Amazon / CVS / Walgreens via
  Gemini-grounded Google Search + url_context. A price is only ever stored if the
  grounding metadata carried a supporting citation URL; otherwise it is written as
  `source: "unavailable"` with no price (never a guess).

The three are **additive, not exclusive**. mylist.html scrapes first when the
extension is installed, then asks the worker to fill in only the stores the scrape
couldn't do (bot-checked / cooling down / no parser module). Installing PriceWatch
can add coverage but never removes the AI-estimated fallback.

---

## Kroger / King Soopers
Method: Official Products API (OAuth2 client-credentials)
Last verified working: 2026-07-17 (live prices returned for both profiles)
Notes:
- Same API serves both chains; the chain/store is selected by `filter.locationId`.
- **Location IDs are PER PROFILE** — var name `<BANNER>_LOCATION_ID_<PROFILE>`.
  Tony shops Colorado (King Soopers), Veda shops Georgia (Kroger), and the two
  banners don't overlap by region, so only the store that actually exists near
  each ZIP is set:
    - `KINGSOOPERS_LOCATION_ID_TONY = 62000102`  (King Soopers – Pace Street, Longmont; ZIP 80504)
    - `KROGER_LOCATION_ID_VEDA      = 01100446`  (Kroger – Shiloh Square, Kennesaw; ZIP 30144)
  The other two combos (Tony+Kroger, Veda+KingSoopers) are intentionally UNSET —
  no such store exists near those ZIPs — so those report `source:"unavailable"`
  naming the missing var. To add a store, query the Locations API
  (`/v1/locations?filter.zipCode.near=<zip>&filter.chain=<KROGER|KINGSOOPERS>`)
  and set the new var in `wrangler.toml`.
- Credentials (set as secrets on the `personal-ai` worker): `KROGER_CLIENT_ID`,
  `KROGER_CLIENT_SECRET` (Personal App registered at developer.kroger.com,
  Production env, Products + Locations public APIs). Verified: token endpoint
  returns a 30-min token.
- OAuth2 token (`product.compact` scope) is cached in-memory + in the
  `TOKEN_CACHE` KV (key `kroger_tok`) and reused across a whole cron run.
- The location price (`items[].price.promo` when > 0, else `.regular`) is the
  store's price, which also drives that store's online pickup/delivery — so a
  single locationId covers both in-store and online-at-that-store.
- `filter.term` is a **fuzzy** search and can drift to a different product over
  time, so on add we resolve the exact `productId` once (confirm-on-add) and pin
  every later check to that id via `filter.productId`.
- Observed quirk: the token-endpoint response reports `scope` empty even though
  `product.compact` was granted — Products calls still succeed, so this is benign.

## AI-search retailers (Walmart / Amazon / CVS / Walgreens + any user-added)  (shared design)
Method: Gemini-grounded — ONE combined call for ALL enabled AI retailers
Last verified working: 2026-07-17 (Kroger dynamic-store path verified; grounding path pending quota reset)
Notes:
- **DYNAMIC STORE LIST:** the retailer set is no longer hardcoded. It lives per
  profile in the pricewatch doc's `stores` field (`{key,name,domain,type}`), and
  the client sends it on every /watch/check + /watch/resolve; the cron reads it
  from the doc. Users add/remove AI retailers at runtime (name + website domain) —
  the search adapts by DOMAIN with no per-store code. Kroger-type is limited to the
  two API banners. `normStores()` sanitizes; `DEFAULT_STORES` is the fallback.
- **ONE grounded call for ALL enabled AI retailers** (not one per store) — cost is
  ~1 grounded request regardless of how many AI retailers are enabled, so the
  pipeline stays performant as stores are added. Each returned product is assigned
  to a store by matching its URL host to a configured domain (also the citation
  gate). Reshape splits results back per store.
- **Relevance ranking:** `relevanceScore(query, brandLock, brand+title)` (token
  overlap + full-phrase bonus + partial-token credit) ranks variants; sorted by
  relevance then price. A specific query ("La Roche-Posay Face Wash") surfaces face
  washes first; a broad query ("La Roche-Posay") returns a representative range.
  The prompt also instructs broad-vs-specific handling + fuzzy matching.
- Returns MULTIPLE variants per store; the confirm UI lists them, each trackable.
- **ONE grounded call covers all four AI stores** (`aiAllStores`), not one per
  store. Four separate grounded calls (×2 attempts) per item blew the free-tier
  per-minute grounding limit (429) and burned 4× the shared daily pool. The single
  call also lets the model compare across retailers in one search. Reshape then
  splits the result back per store.
- **Returns MULTIPLE VARIANTS per store** (up to ~4–5 products each: title, size,
  brand, price, product URL). The confirm UI lists them so the user can track a
  specific variant, or "track cheapest (any brand)".
- **Citation gate (recall-first):** a variant is kept only if it has a numeric
  price AND a product-page URL **on that store's own domain** (walmart.com etc).
  This replaced the old groundingMetadata-chunks gate, which was rejecting real
  products (e.g. Walmart brown eggs) whenever the chunks array came back empty.
- **Models:** grounded call tries `gemini-2.5-flash` → `gemini-2.0-flash` (both
  FREE Google Search grounding, no billing, SEPARATE daily quota buckets). The
  **reshape** is a plain no-tools call on `gemini-3.1-flash-lite` (high RPD, no
  grounding cost) — keeps the scarce 2.5-flash budget for grounding only.
  `gemini-2.5-flash-lite` is EXCLUDED (404 "no longer available to new users" on
  this key). Never use 3.x for the GROUNDED call (grounding isn't free there).
- **FREE-TIER QUOTA REALITY (important):** grounding shares the same free Gemini
  quota as MyList voice / TaskHub / Journal on the per-profile keys. Heavy same-day
  use (or repeated manual testing) can exhaust `gemini-2.5-flash` and return 429,
  after which the four AI stores show `unavailable` until the daily reset. Kroger /
  King Soopers (verified API) are unaffected. Normal load is tiny (cron checks 3
  items/day); the 429s seen on 2026-07-17 were from bulk testing. Do NOT "fix" a
  429 by enabling billing — it's the expected free-lane tradeoff; just let it reset.
- Watch out: grounded estimates can latch onto a multipack/case price (a "Cheerios"
  lookup returned $18 from a variety pack). Stored as `ai-estimated`; the drop
  notification says "worth double-checking".

## PriceWatch extension (live scraping)  — `PriceWatch/`
Method: MV3 Chrome extension; real tabs in Tony's own session, DOM read, tab closed
Last verified working: 2026-07-22 (Amazon returned 12 real products from headless Brave)
Notes:
- **Read `PriceWatch/README.md` before touching a parser module.** One module per
  store domain in `PriceWatch/parsers/`, registered BY DOMAIN — the same domain the
  user typed in Manage Stores.
- **Store list is never stored in the extension.** MyList ships `pwStores()` with
  every `PW_CHECK`; the alarm path re-reads it from the pricewatch doc via
  `/watch/state`. Adding a retailer never needs an extension rebuild. A domain with
  no module returns `source:"unsupported"` and does not sink the rest of the request.
- **Kroger banners are never scraped** — the extension routes `type:"kroger"` stores
  to the worker's existing `/watch/check` API path and merges the result.
- **Bridge:** `externally_connectable` + a PINNED extension id (manifest `key`),
  `oinemolmfefbaifalljkflfaleapihco`, hardcoded in mylist.html as `PW_EXT_ID`.
  Regenerating the key MUST be mirrored there or the bridge silently dies.
  background.js also hard-checks `sender.origin` — verified rejecting a foreign
  origin on 2026-07-22.
- **Rate limiting:** a store domain is re-opened at most every 3h (popup-configurable
  1/3/6/12h). Inside the window the last cached result for that exact query is
  returned instead, flagged `cached`, and no tab opens. Stores are scraped strictly
  one at a time with a randomised 2.2–6.5s gap; tabs open inactive. A bot check
  earns a 6h backoff and is never retried in a loop.
- **BOT WALLS ARE THE NORM, NOT THE EXCEPTION.** Verified 2026-07-22 from headless
  Brave: Amazon ✅ (12 products, real prices + `/dp/` URLs + thumbnails);
  Walmart ⛔; CVS ⛔; Walgreens ⛔ (Akamai "Challenge Validation", 0-length body).
  A real non-headless profile with cookies/history clears these far more often, but
  it is intermittent by nature. Do NOT "fix" a block by retrying harder — that is
  what escalates it. Every blocked store falls through to the AI-estimated path.
- Walgreens' wall renders an EMPTY body, which the first-pass `looksBlocked()` missed
  (it required a non-empty body). Detection is now split: `hardBlocked()` (named
  vendor interstitials → immediate stop) vs `weakBlocked()` (empty body → only
  concluded after the ~10s poll budget, so a slow SPA isn't misread as a wall).
- **Background auto-checks are OFF by default** (they open tabs unprompted). When on,
  a `chrome.alarms` timer POSTs results to `/watch/ingest`, which writes Firestore
  with the worker's service-account JWT — the extension can't write directly because
  mylist.html has App Check (reCAPTCHA v3) and an extension SW can't attest to it.
  Cron and ingest share `pwApplyToItem()` / `pwNotifyDrop()`, so history shape and
  the >$1 drop push are identical either way. `pwApplyToItem` collapses same-day
  history entries — without that, 6 checks/day would break MyList's day-over-day
  `pwDelta()`.
- `relevanceScore` / `normStores` / `cleanDomain` in `PriceWatch/pw-core.js` are a
  deliberate PORT of the worker's versions. **Keep them in sync** or live results
  start ranking differently from estimated ones in the same list.

## Amazon
Method: Gemini-grounded (shared AI-search design) **+ live scrape** via `parsers/amazon.js`
Notes:
- Prices change intra-day and by seller; the model is told to prefer the primary
  buy-box / "Sold by Amazon" price and to say "no reliable price found" rather than
  guess when it can't cite one.

## CVS
Method: Gemini-grounded — part of the shared AI-search design (see Walmart section)
Notes:
- Store/online prices differ and often require a ZIP; the model is told to report
  the online price and note if it looks store-only.

## Walgreens
Method: Gemini-grounded — part of the shared AI-search design (see Walmart section)
Notes:
- Same shared grounded function as the other three AI stores, parameterized by
  store name only.
