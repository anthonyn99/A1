# MAGI — Veda's isolation check (run ON VEDA'S PC)

**For Claude.** If you are reading this because someone said something like
*"do the isolation check"*, *"run the Veda check"* or *"check MAGI is
separate"*, this file is the whole job. Do it start to finish without asking
for instructions; ask Veda only the two questions marked **ASK** below. It
costs two small Codex requests and nothing else.

## What it proves

Phase 15 put Veda's MAGI engine on her own PC (installed 2026-09-28,
self-updating). What was never verified is that her MAGI and Tony's stay
completely apart (docs/magi-plan.md, §8 "Phase 15", *Verify*):

1. **Each console reaches only its own engine** — hers talks to her engine,
   Tony's never does.
2. **History is separate** — her deliberations live in `dashboards/magi_veda`
   and never show up in Tony's (`dashboards/magi`), and the reverse.
3. **A locked profile fetches nothing** — Veda's console, while locked, sends
   nothing to the engine or the cloud.
4. **Code Mode's agent guard works on HER engine** — a coding agent cannot
   call the engine and approve its own work. The guard lives inside each
   running engine, so passing on Tony's PC proves nothing about hers.

Checks 1–3 are `tests/live/magi-isolation.live.js`; check 4 is
`tests/live/magi-guard.live.js`. Both drive a headless browser of their own
(`tests/live/cdp.js`) — they never touch Veda's Brave, her tabs or her logins.

## Before you start

1. **Make sure this is Veda's PC.** `Test-Path magi\data\veda\engine.json`
   must be true. Then read the port:
   `(Get-Content magi\data\veda\engine.json | ConvertFrom-Json).port`
   (8000, or 8001 if her old MAGI held 8000 — see docs/magi-setup.md).
   `curl.exe -s http://127.0.0.1:<port>/api/health` must say
   `"profile":"veda"`. If it says `tony`, **stop**: this is Tony's PC, and
   none of this means anything here.
2. `git pull --rebase --autostash` in A1 (Tony and Veda both push to it).
3. If the engine does not answer: `powershell -ExecutionPolicy Bypass -File
   magi\restart.ps1` once, wait ~20 s, check health again. Never send Veda
   setup commands — her engine is installed (docs/magi-plan.md §0).

## Run

Set `$env:MAGI_BASE = "http://127.0.0.1:<port>"` first if the port is not 8000.

1. **Checks 1–3:** `node tests/live/magi-isolation.live.js`
   - Every line should be PASS.
   - A **NOTE** that Veda has no MAGI password means check 3 cannot run (a
     profile with no password is never locked). **ASK** Veda: *"Do you want a
     password on your MAGI? If so, click the lock button (top right) in MAGI,
     set one, and tell me."* If she sets one, run the test again; if not,
     record check 3 as "not applicable — no password".
   - "Tony's console on her PC ..." may come out offline or reach Tony's own
     engine over his tunnel; both pass. Only reaching HER engine fails.
2. **Check 4:** `node tests/live/magi-guard.live.js`
   - Expect 14/14. It makes a scratch repository in %TEMP% (never A1), asks
     Codex twice, and denies the diff, so nothing is written anywhere real.
   - If Codex is not signed in on her engine, the write/read sections fail
     with a sign-in reason: say so, run `LIVE_ONLY=origin` for the rest, and
     record the guard as "not verified — Codex signed out".
3. **The one look only a person can do. ASK** Veda: *"Open MAGI as you and
   go to History. Do you see any of Tony's questions — for example 'In one
   sentence: what is the capital of Australia?' or 'Reply with one word:
   what colour is a clear daytime sky?' (both asked on Tony's PC on
   2026-10-01)?"* The right answer is **no**.

## If something fails

Do not try to fix it on her PC. A failure here is a privacy bug, so:
write down the exact FAIL lines and what Veda saw, and put them in the
record below for Tony's next session. The only exception is the engine
simply being off (step 3 of "Before you start").

## Record the result, then tell them

1. In `docs/magi-plan.md`: replace §0's "Phase 15 — what is left" section
   with the outcome (date, port, each check PASS / FAIL / not applicable,
   anything Veda saw), and update the *Status* line of §8 "Phase 15 —
   Veda's engine". Also strike Phase 15's isolation check from §0's "After
   Track S — waiting on Tony" list.
2. Commit and push (`git pull --rebase` first). The repo also auto-commits.
3. Tell Veda in a sentence or two whether her MAGI is fully separate, and
   that Tony will see the details in the plan.

## Notes for whoever maintains this

- `magi-isolation.live.js` knows Tony's engine id (`eng_68bec3b7a7ff`) and a
  few of Tony's run ids from 2026-10-01; if Tony's engine is ever re-made,
  update `TONY_ENGINE` there.
- Dry-run on Tony's PC (2026-10-01): check 1 correctly FAILS there (the
  engine is his), Veda's console on his PC correctly reaches no engine, and
  check 3 reported that Veda has no MAGI password set at the time.
