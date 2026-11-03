# TradeBoard Control, News and Market Summary redesign (2026-10-29)

Tony asked for Veda's TradeBoard (`V1/TradeBoard/tradeboard.html`) to get the
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
