# Price Watch — Store Integration Notes

Persistent memory across Claude Code sessions for MyList's "Price Watch" feature.
**Read this before touching a store module in `workers/personal-ai/worker.js`, and
update the relevant section after.** One section per store.

Two integration classes:
- **Verified (`source: "verified"`)** — Kroger / King Soopers via the official
  Products API. Real numbers, no AI.
- **Estimated (`source: "ai-estimated"`)** — Walmart / Amazon / CVS / Walgreens via
  Gemini-grounded Google Search + url_context. A price is only ever stored if the
  grounding metadata carried a supporting citation URL; otherwise it is written as
  `source: "unavailable"` with no price (never a guess).

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

## Walmart / Amazon / CVS / Walgreens  (shared AI-search design)
Method: Gemini-grounded — ONE combined call for all four AI stores
Last verified working: 2026-07-17 (grounding returns cited variants; see quota note)
Notes:
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

## Amazon
Method: Gemini-grounded — part of the shared AI-search design (see Walmart section)
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
