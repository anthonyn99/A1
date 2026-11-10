# TradeBoard Control, News and Market Summary redesign (2026-10-29)

Tony asked for Veda's TradeBoard (`V1/tradeboard.html`) to get the
layout TradeHub's Control and News got on 2026-10-27
(A1-Priv `docs/TradeHub/ui-redesign.md`), and the Market Summary TradeHub got
on 2026-10-29. TradeBoard's Control has no Prompts, so only the watchlist came
over. Every feature is still there; the logic (builds, sync, trash, filters)
is unchanged.

**Her look stays hers.** The layout is TradeHub's, but every colour and font
is TradeBoard's own tokens (`--accent`, `--bg-card`, DM Sans, IBM Plex Mono).
Never copy TradeHub's MAGI tokens (`--ac`, Manrope, Inter) in.

## One page grammar

Plain CSS classes (no `#tradeboard-root` scope, TradeBoard is not React):
`.tbx-page` (1180px; `.narrow` 920px for Control), `.tbx-head` (title, `.tbx-sub`
meta line split by dots, `.tbx-actions`), `.tbx-note` (`.warn`), `.tbx-seg`,
`.tbx-ib` + `.tbx-count`, `.tbx-label`, `.tbx-empty`. On a phone (720px) the
header stacks and its actions share one row; `.tbx-head.keep-row` keeps a
single small button (Control's Trash) beside the title.

## Control

Header: title, "N of 40 tickers · default state", one **Trash** button with
its count (opens the 30-day trash). The Watchlist card: add field (Add
disabled until something parses), one tile per ticker with its sector
("Detecting…" until the worker answers), auto-derived sectors, the `[A, B]`
copy box, Set current as default / Reset to default (each disabled when it
would do nothing).

## News

Header: Summary (dot when the digest is ready), Force, Refresh; meta: build
age, event count, refreshes left, cooldown. Then the pulse (six counts;
Critical, Major, Bullish, Bearish set their filter, Breaking sorts newest
first, Events clears), Top movers, the toolbar (sentiment, order, window,
**Filters** with Impact + Sector behind it and a count badge), the ticker strip
(the whole watchlist, quiet tickers dimmed), the results line with removable
tags and Clear all, and cards: ticker/move/time on top, the AI summary, up to 4
headlines (+N more), a footer of pills (tier, sentiment, type, sector, Raw)
and up to 3 outlets.

`TB.news.render()` rebuilds `innerHTML` every minute and on every quote fetch,
so it saves and restores the page scroll, both sideways strips'
(`data-strip`) scroll, and keyboard focus.

## Market Summary

`TB.news._renderSummary()`: sticky head (mark, title, events · built), then
the hero (The read, headline, tone with a bearish→bullish gauge, overview),
numbered key points with stance tags and tickers, By ticker and Themes cards,
Risks beside What to watch, the foot; a skeleton while loading, Try again on
an error. Her phone bottom sheet stays. Reopening starts at the top.

## Bugs fixed on the way

- A repaint threw away the sideways strips' scroll and keyboard focus.
- Removing a ticker left a sector filter that could hide every event.
- Tickers still being detected showed in the sectors list as "Diversified".
- The summary sheet could scroll the feed behind it; it now contains its
  scroll and is a labelled dialog.

## Tests

`node tests/live/tradeboard-ui.live.js`: real page, fake Firestore, a fake
news worker (never forces a build); Control, News, the summary, desktop and
390px. `TB_PAGE_FILE=<copy>` serves a work-in-progress copy (auto-commit ships
every save of the real file). `tradeboard-notebook.live.js` covers Strats.

# Portfolio, Journal and the News market strip (2026-11-06)

Tony asked for TradeHub's rebuilt Portfolio and Journal (2026-11-04), Portfolio ▸
Activity and News' market strip (2026-11-03) on Veda's TradeBoard, in her theme.
Same rule as above: TradeHub's layout, her tokens only.

## Portfolio

Header (title, broker · Synced, Refresh), the **market clock card** (phase,
today's hours in her zone, a live countdown, the next three NYSE holidays; the
clock functions are TradeHub's, verbatim), six **account figures** (Total Value
first, Cash, Buying Power, Day P&L, Unrealized, Realized: FIFO over the order
history when Webull sends no realized figure), **Account details** (only the
figures the sync sent), then **Positions / Open Orders / History / Activity**.
Each table scrolls inside a window-height box with a sticky header
(`TB.pf.fit`). Positions: a weight bar and share of total, day %, a totals row;
her phone keeps its cards. Activity: 30D / 90D / YTD / 1Y, four totals that
double as filters, kind chips, a table (a list on a phone).

**Data:** `V1/TradeBoard/wb_sync.py` (her PC, every 2 min) now also sends the
balance figures (`account`), open orders, the last 30 days of orders
(`history`), Webull cash activity (`activity`, re-read at most every 10 min,
cached in `broker_activity.json`) and a position's day % when Webull gives one.
Field names follow Tony's `workers/tradeboard-api`. A piece the sync could not
read is left out, and its tab says it appears after the PC sync runs.

**No restart by hand.** MAGI's watchdog (every 2 min on her PC, right after it
pulls A1) restarts the running sync when its `wb_*.py` changed after it started
(`magi/tbsync.py`, tests `magi/tests/test_tbsync.py`). A pushed `wb_sync.py`
change reaches her in about 5-8 minutes; she only reloads the page.

## Journal

Header with Manual trade and a tool group (Re-merge, Export CSV, Export JSON),
the equity curve beside the stats (curve capped at 900px and shorter), the
equity table (pill toggle, newest first, P&L chips, best/worst footer), a search
field, All / Wins / Losses / Open, her side / source / tag filters, and, sorted by
date, rows grouped by day with each day's trade count and net P&L.

## News

The market strip (S&P and Nasdaq futures, semis, the 10-year, WTI, Brent, VIX,
the dollar; four by two) from her own worker's new `/market` route (ported from
newshub-api, Yahoo spark, cached 2 min), fetched with the quotes. Stories about
a ticker in her Webull positions carry a **Held** badge.

## Tests

`node tests/live/tradeboard-portfolio.live.js` (Portfolio, Journal, the strip,
390px) and `py -3 tests/wb-portfolio.test.py` (the sync's new reads, offline).

# Parity sweep with TradeHub (2026-11-09)

Tony asked for every feature TradeBoard and TradeHub share to carry the same
information and the same fixes, both ways. What each program has alone stays
its own: TradeHub's Catalysts, Analysis, Prompts, Webull Sync button, CSV import
and journal backups; TradeBoard's Rules checklist, Apps and tag filter.

## TradeBoard got from TradeHub

- **Display mode hides the equity curve**: the curve, its dates, tooltip and
  table are not drawn; a dashed "Chart hidden in display mode" box keeps the
  space. A blur still showed the trend.
- **Equity curve**: 1M / 3M / 6M / YTD / 1Y / All (a range re-bases the curve to
  P&L over the period), the first and last date under it, and a hover tooltip
  (equity, date · symbol, that trade's P&L). The table follows the range.
- **Journal Hold column**: entry to exit in days. `wb_sync.py` now sends each
  round trip's entry date as `entryDate` (it used to drop `_entry_date`; a
  merged row carries its earliest). `TB.jr.normalize` keeps it, and
  `mergeBroker` counts a newly arrived entry date as a change so stored trades
  pick it up on the next sync.
- **Portfolio Day %** from the live quote (her worker's `/market`, then
  `/quotes`) when Webull sends none; Webull's figure is the fallback. Read at
  most every 5 minutes.
- **News**: the movers and cards lead with the pre-market move before the open,
  show the after-hours move and a sparkline (`tbnLiveMove`: Yahoo via `/market
  ?tickers=`, Finnhub as the fallback); a dot marks a mover she holds; a story is
  Held when any of its tickers is held; a Held chip filters (with a tag and
  Clear all); Held stories come first in Impact order (minor ones excepted).
- **Intraday news**: every 15 minutes in the regular session (through 4:15 PM
  ET, holidays and half days from `tbMktState`) the page asks
  `/news?intraday=1`; the worker rebuilds a feed older than 45 minutes on the
  ordinary path, never the 12-a-day force budget.
- **Raw-build retry**: a build with no AI analysis is retried once with a fresh
  build: once per build, 15 minutes apart, at most 3 a day, never while a build
  is running or with no force refreshes left (`tradeboard_news_raw_retry`).

Her worker (`V1/workers/tradeboard-news`) got newshub-api's fixes: one card per
event (a re-delivered AI window and the omission retries used to show a story
two or three times), the intraday rebuild, and `/quotes` cached in the Cache
API (it spent a KV write on every poll) and only when quotes came back.

## TradeHub got from TradeBoard

- **Journal stats**: Expectancy, Largest win, Largest loss and the current
  Streak beside win rate, wins, losses, open and profit factor (four across on
  desktop, so the card keeps the curve's height; blurred in display mode).
- **Journal filters**: Side (Long / Short) and Source (Webull / Manual / CSV),
  with Clear.

## Bugs fixed on the way

- TradeHub asked Webull for quotes twice when News and Portfolio asked at the
  same moment, before either learned Webull has no market data, and kept asking
  inside the 6-hour back-off whenever two requests overlapped. A second caller
  now waits for the first answer (`_tbMdProbe`).
- TradeHub's Hold read "1 days".
- TradeBoard's hover tooltip box showed empty under the curve (`display:flex`
  beat the `hidden` attribute).
- Two stale live tests: `tradehub-news-market` read the Day % by a column index
  the 2026-11-04 Portfolio had moved, and clicked an Activity chip class that no
  longer exists; `tradehub-outlines` didn't know about the cards' sources line
  (`.nh-outlets`, a disclosure row).

## Tests

`node tests/live/tradeboard-parity.live.js` and
`node tests/live/tradehub-parity.live.js` (both pages, real code, fake workers),
`node tests/tradeboard-news-parity.test.js` (her worker against newshub-api's
fixes) and `py -3 tests/wb-portfolio.test.py` (the entry dates).
