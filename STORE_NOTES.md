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

## Walmart
Method: Gemini-grounded (gemini-2.5-flash ONLY, google_search + url_context)
Last verified working: 2026-07-17 (returned a cited estimate)
Notes:
- **MODEL CONSTRAINT DISCOVERED 2026-07-17:** this project's Gemini key returns
  404 "gemini-2.5-flash-lite is no longer available to new users" — for BOTH the
  grounded call and the reshape call. So flash-lite is dropped entirely and BOTH
  the grounded lookup and the reshape now run on **gemini-2.5-flash** (the reshape
  is a no-tools call, so it still doesn't touch the grounding quota). Do NOT
  reintroduce flash-lite here, and do NOT switch to 3.x (grounding isn't free for
  3.x without billing). If a lighter free-grounding model becomes available to the
  key later, it can be added back.
- With only one usable model there's no cross-model fallback, so the grounded call
  gets up to 2 attempts on flash (hard stores like Amazon fail transiently).
- All 6 stores per item are priced CONCURRENTLY (Promise.all) — a single item
  check is ~30-45s instead of ~2min sequential.
- Two-call shape: (1) grounded free-text lookup, (2) plain no-tools gemini-2.5-flash
  reshape into `{found,price,url,foundBrand,note}`; a price is stored only if the
  grounded response carried a citation URL.
- Watch out: grounded estimates can latch onto a multipack/case price (saw a
  "Cheerios" lookup return $18 from a variety pack). The citation gate passes it,
  so it's stored as `ai-estimated` and the notification says "worth double-checking".

## Amazon
Method: Gemini-grounded (gemini-2.5-flash ONLY, google_search + url_context)
Last verified working: 2026-07-17 (grounded call runs; no cited price in test items)
Notes:
- Prices change intra-day and by seller; the model is told to prefer the primary
  buy-box / "Sold by Amazon" price and to say "no reliable price found" rather than
  guess when it can't cite one.

## CVS
Method: Gemini-grounded (gemini-2.5-flash ONLY, google_search + url_context)
Last verified working: 2026-07-17 (grounded call runs; no cited price in test items)
Notes:
- Store/online prices differ and often require a ZIP; the model is told to report
  the online price and note if it looks store-only.

## Walgreens
Method: Gemini-grounded (gemini-2.5-flash ONLY, google_search + url_context)
Last verified working: 2026-07-17 (grounded call runs; no cited price in test items)
Notes:
- Same shared grounded function as the other three AI stores, parameterized by
  store name only.
