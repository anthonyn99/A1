# TradeHub's standing prompts, run by the engine (2026-11-09)

Tony asked the council the same two things by hand every week. Tony's MAGI
engine now runs them on its own, and TradeHub's **Analysis ▸ Debrief** shows
the answers in two tabs, **Movers** and **Next week**, rendered the way the
MAGI tab renders the morning answer (verdict, then each unit's answer).

| Job | When (New York time) | Prompt |
|---|---|---|
| `movers` | every trading day, an hour after the close: **5:00 PM**, **2:00 PM** on a 1 PM half day; catch-up until 4 AM the next morning | "What factor(s) moved the market the most today? Research and give me the latest." |
| `weekly` | **Saturday 10:00 AM**; catch-up until Monday 4 AM | "Weekly Trading Catalyst Tier List (Next Week) …" |

Why an hour after the close: the wrap-ups (AP, Reuters, CNBC's close stories)
are published and indexed by then, so the units' searches find the day's
story rather than the midday one. Tony's own runs were 4:30–8 PM ET.

## How it runs

```
engine (magi/engine/autoprompts.py, a loop in the engine process, every 60 s)
  ├─ GET trade-dashboard /analysis-config   → the two prompts (`auto`) + the units
  ├─ the council, started exactly as POST /api/runs starts one
  └─ POST taskhub-reminders /magi-auto      → Firestore dashboards/tb_debrief_auto
                                               movers / weekly: the run as JSON text
TradeHub Debrief ← onSnapshot(dashboards/tb_debrief_auto)
```

- **No new scheduled task and no browser.** The engine is already always on;
  the loop lives in it like the Claude kickstart and the reset push.
- **The prompts** come from TradeHub's prompt list, found by name
  (`tbAutoPrompts`: "moved the market" / "market movers"; "catalyst" plus
  "next/upcoming week" or "weekly", a name match first), pushed with the
  Analysis config. Not found, the engine uses its own copy of Tony's wording,
  so a renamed prompt never stops the schedule.
- **The units** are the Analysis destination's: MAGI's ticked units; a single
  chat site (ChatGPT, Claude, Gemini, Perplexity, Grok, DeepSeek) becomes that
  one unit in MAGI, because only a MAGI run can be read back; anything else,
  every enabled unit.
- **A council you started goes first:** a due job waits while any run is live.
- **Failures:** a council with no answer retries 20 minutes later, at most 3
  councils a day per job; a council that answered but whose push failed is
  re-sent without asking the council again. State:
  `magi/data/tony/autoprompts.json`.
- **Auth:** the engine's MAGI API token, checked by the worker against
  dashboards/magi (as `/claude-resets`). Tony's engine only; Veda's never runs
  these.
- **Each answer stays** until the next run of its kind replaces it.

## Checking and running by hand

- `GET http://127.0.0.1:8000/api/autoprompts`: next run, last result (units,
  how many answered, the run id) per job.
- `POST http://127.0.0.1:8000/api/autoprompts/run?job=movers` (or `weekly`):
  run one now.
- The run itself is an ordinary MAGI run: it shows in MAGI's History once a
  console has backfilled it.

## Tests

`magi/tests/test_autoprompts.py` (calendar, schedule, units, prompt, the run →
push path and every failure), `tests/magi-handoff.test.js` (the worker keeps
`auto`), `tests/live/tradehub-debrief.live.js` (the two tabs, desktop and phone,
a run arriving live, the push).

The first scheduled run went out on its own on 2026-11-09 at 11:28 PM ET
(today's catch-up): 4 of 4 units answered, delivered.
