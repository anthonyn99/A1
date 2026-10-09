# TradeBoard News + Control (Veda)

TradeBoard ([V1/TradeBoard/tradeboard.html](../V1/TradeBoard/tradeboard.html))
has News and Control tabs, integrated from Tony's TradeHub on 2026-10-08.
Control is TradeHub's watchlist editor without Prompts. News is TradeHub's
News tab, rebuilt in TradeBoard's vanilla JS.

## Pieces

| Piece | Where | Notes |
|---|---|---|
| Page | `V1/TradeBoard/tradeboard.html` (`TB.wl`, `TB.news`, `TBSync`) | Deploys with the V1 site worker on push. |
| News worker | `V1/workers/tradeboard-news` → `https://tradeboard-news.vedapatel05.workers.dev` | Veda's Cloudflare account. Copy of `workers/newshub-api`; the header comment lists every difference. |
| Watchlist, default, trash, AI sectors | main doc `tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12`, fields `watchlist*` | Mirrored by `TBCloud` like every other TradeBoard key. |
| News feed + filters | doc `tradeboard/UboRGuQZT5QlGhJa1U4zMSd7Sm12_news` | Its own doc because it is rewritten every build. Allowed by `V1/firebase/firestore.rules`. |

TradeBoard never calls Tony's `newshub-api`. In particular it never calls
`POST /watchlist` there, which would replace the list his 6am cron builds.

## Worker secrets (Cloudflare only, never in the repo)

- `GEMINI_KEY`: Veda's Gemini key. Her key is new, so `gemini-2.5-flash-lite`
  and `gemini-2.0-flash` return 404. The chains use `3.1-flash-lite`,
  `2.5-flash`, `3.5-flash-lite`, `3.8-flash` and `3.5-flash`.
- `ADMIN_KEY`: unlocks `/debug`, `/_stage-debug`, `/clear-cache`, `/ai-test`
  and the other operator routes (`?admin=…`). It is a random value that was not
  written down. Set a new one with `npx wrangler secret put ADMIN_KEY` in the
  worker folder.
- `FINNHUB_KEY`: Veda's own Finnhub key (set 2026-10-08). It powers per-company
  news, market-wide news and Top Movers quotes. Remove it and the worker falls
  back to keyless sources: Yahoo Finance RSS per ticker, and Yahoo spark for
  quotes.
- Optional: `MARKETAUX_KEY`, `STOCKDATA_KEY`, `ALPHAVANTAGE_KEY`,
  `NVIDIA_API_KEY`. Any source without a key is skipped.
- TickerTick, SEC EDGAR and the semiconductor supply-chain feed (Yahoo RSS for
  TSMC, Broadcom, Samsung, SK hynix and Kioxia) need no key. Google News
  answers Cloudflare IPs with a 503, so it can't be used here.

## No cron

Veda's Cloudflare account is at the free plan's limit of 5 cron triggers, so
the worker has no 6am pre-warm. The first time TradeBoard is opened after 6am
(device time), it builds that morning's news in the background (about 30
seconds). Free a cron slot and add the `[triggers]` block shown in
`wrangler.toml` to get the pre-warm back.

## Builds

Every cache-miss build holds the request open (up to 60s) and returns the
finished feed. Builds left running in the background after a 202 response
were cut off once they passed about 30 seconds. Force fresh uses one of
12/day (Veda's own budget).
