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
Method: Gemini-grounded (gemini-2.5-flash + gemini-2.5-flash-lite, google_search + url_context)
Last verified working: (not yet)
Notes:
- Free Google Search grounding on 2.5-flash / 2.5-flash-lite only (no billing
  account, shared 500 req/day pool). Do NOT switch this path to the 3.x models —
  grounding is not free for them without billing enabled.
- Two-call shape: (1) grounded free-text lookup, (2) plain no-tools
  gemini-2.5-flash-lite reshape into `{price,url,foundBrand,note}` (call 2 does not
  touch grounding quota).

## Amazon
Method: Gemini-grounded (gemini-2.5-flash + gemini-2.5-flash-lite, google_search + url_context)
Last verified working: (not yet)
Notes:
- Prices change intra-day and by seller; the model is told to prefer the primary
  buy-box / "Sold by Amazon" price and to say "no reliable price found" rather than
  guess when it can't cite one.

## CVS
Method: Gemini-grounded (gemini-2.5-flash + gemini-2.5-flash-lite, google_search + url_context)
Last verified working: (not yet)
Notes:
- Store/online prices differ and often require a ZIP; the model is told to report
  the online price and note if it looks store-only.

## Walgreens
Method: Gemini-grounded (gemini-2.5-flash + gemini-2.5-flash-lite, google_search + url_context)
Last verified working: (not yet)
Notes:
- Same shared grounded function as the other three AI stores, parameterized by
  store name only.
