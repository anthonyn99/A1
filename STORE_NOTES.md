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
Last verified working: (not yet — pending credentials, see below)
Notes:
- Same API serves both chains; the chain is selected by `filter.locationId`. Kroger
  and King Soopers are **different location IDs**.
- **MANUAL STEPS REQUIRED (Tony) before this module returns real prices:**
  1. Register a free app at https://developer.kroger.com and set the two secrets on
     the `personal-ai` worker:
     `wrangler secret put KROGER_CLIENT_ID`
     `wrangler secret put KROGER_CLIENT_SECRET`
  2. Provide the two real location IDs and set them as **vars** in
     `workers/personal-ai/wrangler.toml`:
     `KROGER_LOCATION_ID` (the Kroger store) and
     `KINGSOOPERS_LOCATION_ID` (the King Soopers store).
  Until all four are present the module returns `source: "unavailable"` with a
  `note` explaining which config is missing — it never fabricates a price or a
  placeholder location ID.
- OAuth2 token (`product.compact` scope) is short-lived; it is cached in-memory +
  in the `TOKEN_CACHE` KV (key `kroger_tok`) and reused across a whole cron run so
  we don't re-auth per item.
- `filter.term` is a **fuzzy** search and can drift to a different product over
  time, so on add we resolve the exact `productId` once (confirm-on-add) and pin
  every later check to that id via `filter.productId`.
- Price fields read from the response: `items[].price.regular` and
  `items[].price.promo` (promo wins when > 0). Requires a `locationId` — without
  one the API returns no price data.

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
