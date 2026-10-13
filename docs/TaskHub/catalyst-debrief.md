# Catalysts debrief ▶ (both TaskHubs)

Every earnings report and macro release TradeHub Catalysts publishes
(`dashboards/market_calendar`) shows on Tony's and Veda's TaskHubs. Ten
minutes after an event comes out, its card grows a ▶. Pressing it opens MAGI,
or brings the open MAGI tab forward, and convenes a debrief of that event in
the profile of the TaskHub it was pressed in, with that profile's units.

## Pieces

| Where | What |
|---|---|
| `catdebrief.js` (A1 root) | The one source: timing, default templates, the fill-in-the-blank, the `#tb=` link, the one-MAGI-tab opener. Loaded unpinned by index.html and by A1-Priv `tradehub.html`. |
| `index.html` | `mcDebriefBtn` (Tony) and `vdDebriefBtn` (Veda) on the catalyst card; `window._mcDebrief(events, profile, macroET)`; an `onSnapshot` on `dashboards/catalyst_debrief` that feeds `A1Debrief.setConfig`. |
| A1-Priv `tradehub.html` | Catalysts ▸ **Debrief in MAGI** card (`TBDebriefSettings`): units per profile, Earnings and Macro templates, placeholder chips, Reset, a preview. The only writer of the settings doc. |
| `magi.html` | Reads `p` from the handoff and opens in that profile (see docs/MAGI/magi.md, "Questions handed over"). |

## Settings doc: `dashboards/catalyst_debrief`

```
{ tony: { units: [...] }, veda: { units: [...] },
  templates: { earnings: "", macro: "" }, savedAt }
```

It is a separate doc because TradeHub rewrites `market_calendar` whole on
every publish. A template equal to the default is stored as `""`, so a better
default in `catdebrief.js` reaches everyone who never customised it. An empty
unit list means "whatever is already ticked in that MAGI console". A profile
that never chose gets ChatGPT, Claude (free), Gemini and DeepSeek.

## When the button appears (ET, plus 10 minutes)

- Macro: the release time from the TaskHub's `mcMacroET` table (8:30, 10:00,
  14:00 FOMC, ...). A release with no fixed clock (a Fed speaker) waits for
  16:30.
- Earnings: `when` from Finnhub. `bmo` 8:00, `amc` 16:30, `dmh` 12:00.
  Untagged (TSM and other ADRs from the Nasdaq scan) 16:30.
- Holidays never get one.

A day with 2+ earnings shows one card, so its ▶ debriefs every report on it
that is out, each with its own filled template. Each TaskHub sets one timer
for the next due time, so a button appears without a reload.

## Placeholders

Earnings: `{ticker}` `{timing}` (before the open / after the close)
`{date}` `{epsEst}` (consensus EPS or "not available").
Macro: `{event}` `{time}` (release time ET) `{date}` `{category}`.
An empty value tidies itself away, so "(, Oct 15)" never reaches a prompt.

## Tests

- `node tests/catdebrief.test.js`: timing (incl. DST), fill, settings
  normalisation, the link, the opener (open console, blocked popup, a TaskHub
  tab that carries MAGI's window name), the wiring in index.html and TradeHub.
- `node tests/magi-handoff.test.js`, `node tests/magi-profiles.test.js`: the
  `p` field in MAGI.
- `node tests/live/catdebrief.live.js`: both TaskHubs, MAGI and TradeHub in a
  real browser against the fake Firestore. Screenshots go to the OS temp dir.
