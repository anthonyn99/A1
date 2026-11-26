# AGENTS.md (Codex and any other coding agent)

Codex reads this file; Claude Code reads `CLAUDE.md`. **Both agents follow the same rules: read `CLAUDE.md` in this repo
in full, it applies to you exactly as written** (where a file goes, the shared modules, the theme rules, never changing
Veda's side, and so on). This file only adds what an agent that is not Claude Code needs.

## "continue TradeHub Quant" (also "continue Quant", "next Trading phase", "continue")

TradeHub lives in the private repo `C:\Users\antho\Desktop\A1-Priv` (its worker `workers2/quant-api` and the live tests
are here in A1). The work is a plan with phases, handed back and forth between Claude Code and Codex.

1. `git pull` in both `C:\Users\antho\Desktop\A1` and `C:\Users\antho\Desktop\A1-Priv` (Tony and Veda both push).
2. Read `C:\Users\antho\Desktop\A1-Priv\AGENTS.md`, then **§0 of the plan named there** (today:
   `A1-Priv\docs\TradeHub\quant-trading.md`, Part 2 Neo Cortex N0-N10). §0 names the NEXT phase; its spec is
   `quant/n4-NN.md` (Progress checklist = where the last agent stopped); §3 has Tony's asks
   word for word; the "Hand-off log" says who did what last.
3. Build the phase it names, exactly as specified; keep going phase after phase until the batch is done (Tony's word),
   unless a phase needs Tony (then stop and say what).
4. Test (below), then update the plan (§0, §2, the hand-off log) and the plan page (below). Commit nothing by hand: the
   PC's watcher commits, pushes and deploys within seconds of every saved file (both repos).

## Testing (the same as Claude does it)

- Unit: A1-Priv `npm test` (all suites must pass); A1 `node tests/run-all.js` (two Notebook suites,
  `journal-images` and `notebook-idle`, fail from other work: known, not yours).
- Live (a real headless Chrome over CDP, the page against a mocked worker): from A1,
  `CDP_PORT=93xx PHASES=TR5 node tests/live/tradehub-trading.live.js` (a fresh port per run; never leave a test page
  running). Each phase adds its tagged checks (`ok('TR5', …)`) to that file, at 1280, 820 and 390 px. Screenshots:
  set `SHOTS_DIR=<folder>` and call `shot('name')`. The other `tests/live/tradehub-*.live.js` cover older work: run the
  ones your change touches.
- A code review of your own diff before you call a phase done (Claude uses its `/code-review`; do the equivalent), and
  fix what it finds.

## The plan page (artifact) and the Desktop copy

The plan is also a page Tony reads: https://claude.ai/artifact/PhrgRdR8vw32JutAsgNgRR (section `#trading`, the block
"Part 1 refinements · Batch 1"). Only Claude can publish to claude.ai. So: **edit the same HTML at
`C:\Users\antho\Desktop\TradeHub Quant Plan.html`** (change the phase's chip `In progress` → `Done …` and add a
`<p class="done">` with what was built and tested, in plain words for Tony), and write in the hand-off log
"artifact: Desktop copy updated, not yet published". The next Claude session publishes that file to the artifact.

## Tony's standing preferences (Claude keeps them in its memory; they apply to you)

Read `C:\Users\antho\.claude\projects\c--Users-antho-Desktop-A1\memory\MEMORY.md` and open the entries that touch your
work. The ones that matter most for TradeHub: do every step yourself and hand over only what truly needs Tony; snappy
motion, no fades; MAGI's look on Tony's side, no gradient fills; dates like "Thursday, November 12, 1:48 PM"; no
in-place source mutation to prove a test; Python on this PC writes CRLF unless you pass `newline=''`; apply additive D1
migrations yourself and say so.

## Secrets

Never commit a key. Real paper-broker checks through the live worker need Tony's Orca key: ask him for it in the
session and keep it out of every file in either repo.
