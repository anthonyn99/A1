# MAGI — Profiles, Multi-Engine, and Code Mode (living plan)

> **This file is the hand-off between sessions.** Each phase is built in its
> own Claude Code session. A new session starts by reading **§0 Hand-off**
> below, and ends by rewriting it. Nothing needed to continue lives anywhere
> else: not in a scratchpad, not in `~/.claude/plans/`, not in memory alone.

---

## 0. Hand-off — read this first

**Last updated:** 2026-09-24, end of the Phase 11 + 11B session.
**Phases complete:** 1–11, plus **11B** (model selection, usage credits, caps —
added at Tony's request this session; see its section in §8).
**Next phase:** **12 — Auto Commit / Auto Push** (design in §8; first concrete
steps at the end of this §0).

> **To start the next phase, the whole instruction is "continue" or "next
> phase".** Do the start-of-session checklist, then build Phase 12 from the
> steps below. Everything needed is in this file.

### The road from here (agreed with Tony 2026-09-21; 11B added 2026-09-24)

One phase per session.

| # | Phase | What it adds | Complexity | Expected |
|---|---|---|---|---|
| ~~11~~ | ~~Repository surface~~ | **done 2026-09-24** | | |
| ~~11B~~ | ~~Models, credits, Auto, caps~~ | **done 2026-09-24** | | |
| 12 | Auto Commit / Auto Push | Per-project toggles, off by default, always off for A1; `magi:` commits of touched files after a ~3 min debounce; auto-push only after a clean pull; the Phase 11 Actions watch then follows the auto-push | Medium (must not collide with A1's hook) | 1 |
| 13 | Firebase sync of Code Mode state | One `code` field on the profile doc, debounced dirty-flag writes, zero writes during a task, no second listener; tokens never sync. **Decide then** whether model choice/caps (engine-side today, per profile) join it | Medium (measure write counts) | 1 |
| 14 | Hardening + A1 writable | Regression + security sweep, docs; then open A1 to write/commit/push carefully (shared with live sessions + auto-commit hook) | High | 1–2 (needs Tony's go-ahead for A1) |
| 15 | Veda's engine | `magi onboard --profile veda` on her PC, her logins + GitHub account, isolation check. Nothing new to build: 11B is per-profile already (see "Ready for Veda's PC") | Low (an install) | < 1 (needs Veda) |

### Start-of-session checklist (do these in order)

1. `git pull --rebase --autostash` in A1 — Tony and Veda both push to it.
2. Read this §0, then the next phase's section in §8. Skim §6 (Git/GitHub
   strategy) and §7A for the agent architecture.
3. Check the engine is alive: `curl http://127.0.0.1:8000/api/health`. If not,
   `powershell -ExecutionPolicy Bypass -File magi\restart.ps1` (never ask Tony
   to restart it).
4. The venv needs `httpx` and `keyring` (`magi/requirements.txt`):
   `magi\.venv\Scripts\python -m pip install -r magi\requirements.txt` if an
   import fails.
5. Baseline the tests before touching anything. **Run pytest from `magi/`
   over the whole folder** — `cd magi; .venv\Scripts\python -m pytest tests -q`
   (≈890). From the A1 root, `test_morning_run.py` fails to collect (it
   imports `tests.test_completion`); a single file runs fine from the root
   (`python -m pytest magi/tests/test_x.py`). Node: `node tests/run-all.js`
   (47 suites). Both must be green; if not, fix that first.

### End-of-phase checklist (the definition of "done")

1. Engine changed? Restart it with `magi\restart.ps1` and re-verify live.
2. `pytest` and `node tests/run-all.js` green. New behaviour has new tests,
   and at least a few were mutation-checked (break the code, watch the test
   fail, restore). **The repo auto-commits mid-session** — a mutation script
   must restore the file in a `finally` and check the file afterwards (this
   session's `mutate.py` pattern: bytes in, bytes out, CRLF-aware — the
   files are CRLF on disk).
3. Live check in a real browser: `node tests/live/<file>.live.js` (see
   "Test harness" below), desktop and 390px phone widths.
4. `docs/magi.md` and the console's HOW panel updated in the same commit
   (`magi/tests/test_howitworks.py` enforces the panel as a contract).
5. **Rewrite this §0**: move the finished phase into "What exists", write the
   next phase's first concrete steps, list anything waiting on Tony.
   Mark the phase's section in §8 with a `*Status:*` line.
6. Commit and push (`git pull --rebase` first). The repo also auto-commits.
7. Tell Tony the phase is done, what to test, and that a fresh session can
   pick up from here.

### What exists (as of Phase 11B)

* **Profiles** Tony/Veda: gate = lock + picker (`MAGI_PROFILES`, `lsKey()`),
  Firestore `dashboards/magi` vs `dashboards/magi_veda`, favourite star.
* **Engine** per profile: `magi/profiles/<p>/`, `magi/data/<p>/`,
  `magi onboard --profile veda` builds a second engine; `magi serve --profile
  veda --port 8001 --no-browser` runs a backend only (no tunnel) — used by
  `magi-models.live.js LIVE_ONLY=veda`.
* **Multi-engine** registry in the console (`ENG`, `connectTo`).
* **Units** include `claude` (free account) and `claude-pro` (Pro account).
* **Code Mode** (`magi.html` CODE MODE block, `magi/code/`):
  - Workspace registry + MAGI's own folder browser (`/api/code/browse`).
    A1 is registered (`proj_60d8f14fbc1c`).
  - Coding agents (`magi/code/agents/`): Claude CLI and Codex CLI (their own
    tool loops), every browser unit (MAGI gathers context). One fallback
    chain (`chain.py`); hands off only on limit / signed-out / crash / cap.
  - Account **slots** per CLI (`slots.py`; `CLAUDE_CONFIG_DIR`/`CODEX_HOME`),
    renameable, device-code sign-in for Codex shown in Accounts.
    Signed in now: Claude `system` (anthonypn99@gmail.com, **Pro, usage
    credits off**) and Codex `codex1` (**free** ChatGPT account, one 30-day
    window).
  - Usage is **live from the providers** (`usage_fetch.py`), refreshed by
    the task stream and `GET /api/code/usage` (60s during a task / 5 min idle,
    only while Code Mode is on screen). It now also records each account's
    **credits and plan** (`limits.note_account` / `account`).
  - Tasks: `POST /api/code/tasks {mode}` → SSE `/tasks/{id}/stream`
    (replayable, one queue per viewer) → `/approve` → `/commit` → `/push`.
  - **Write mode (Phase 8)** — sandbox worktree, `security.py`, approval
    card, `sandbox.apply`. **A1 is refused** (`is_engine_repo`,
    `read_only_project`) until Phase 14.
  - **Local git (Phase 9)** — `magi/code/git.py`; pull-before-work
    (`tasks._pull_first`; A1 fetch-only), **Commit these files**, the
    repository line. `git.branches` (Phase 11) lists local branches with ↑↓.
  - **GitHub (Phase 10)** — `magi/github/{accounts,client,askpass}.py`:
    token in the OS credential store, ETag cache, askpass only for the
    account's host, push routes, Accounts › GitHub, `prefs.github`. `Push`
    now carries the full `sha`.
  - **Repository surface (Phase 11)** — `magi/github/{repos,pulls,issues,
    actions}.py` + `client.get_raw` (job logs: signed 302 followed WITHOUT
    the token); GET routes `/api/code/projects/{id}/repo[/branches|commits|
    pulls[/n]|issues[/n]|actions[/run]|releases]` via `_repo_ctx` /
    `_repo_call`. Console: the **Repository pill opens the panel** on GitHub
    (`codeRepoPanel`, tabs, bottom sheet on phones; account in its header);
    the **Actions watch** (`CODE.watch`, `codeWatchStart/Tick`,
    `renderCodeWatch`) after every push — 20s while pending, hard stops,
    Log + **Diagnose** (`codeDiagnose` → a Read task with the tail).
    **MCP tools for the Claude CLI**: `magi/github/mcp_server.py` (stdlib,
    `pythonw -I`, GETs the engine on loopback), per-task config
    `data/<p>/code/mcp/<task>.json` (`tasks.write_mcp_config`), argv
    `--mcp-config <file> --allowedTools mcp__magi_github`.
  - **Models, credits, Auto, caps (Phase 11B)** — `magi/code/agents/
    models.py`: catalog per account (Claude `/v1/models` + `/api/oauth/
    profile`; Codex `codex/models?client_version=`; cached 6h in
    `data/<p>/agent_models.json`, `gated` remembers credit refusals);
    `availability` (credit families on Pro/Free, learned gating, used-up plan
    → credits only); prefs in `data/<p>/code_models.json` (choice per agent:
    model|auto + effort; caps per agent per window; `warn_at`); `classify` +
    `choose` (Auto); `cap_block`, `cap_crossed`, `cap_watch` (mid-run),
    `alerts`. Agents pass `--model/--effort` (Claude) and `-m` +
    `-c model_reasoning_effort=` (Codex), emit a `model` event, retry once on
    the same account after `credits_required`, and stop mid-run at a cap.
    Routes `/api/code/models[?refresh=1]`, `/models/choice|cap|warn|preview`;
    `/usage` adds `alerts, capped, credits, caps, warn_at`; `/agents` slots
    add `capped`. Console: the **model row** (`renderCodeModels`, Auto's pick
    for the composer text via `codePreviewSoon`), the **sheet**
    (`codeModelSheet`: models, effort, usage bars with cap markers, Stop at,
    Warn me at, credits), the corner **popup** (`codeUsageAlerts` /
    `usageToast`, once per key in `lsKey("usage.seen")`), Accounts ›
    *Models & limits*.

### Ready for Veda's PC (the 11B completion requirement)

Everything added in 11 and 11B is per profile and needs no setup on her
engine beyond Phase 15's install: model lists are read from HER signed-in
accounts, choices/caps live in `magi/data/veda/code_models.json` (default:
Auto, no caps, warn at 80%), credits come from her own usage reads, and the
Repository panel/MCP tools use HER GitHub account (`prefs.github` on her
projects). Verified this session with a real veda engine on :8001 (own
defaults; a cap and a choice set there did not touch Tony's). On her PC:
install both CLIs (`npm i -g @anthropic-ai/claude-code @openai/codex`), sign
in the slots from Accounts, add her GitHub token, then open Code Mode — the
model row fills itself.

### Hard-won facts (verified live — do not re-learn them)

* (11B) **Claude's OAuth token lists models**: `GET /v1/models` with
  `Authorization: Bearer <oauth>` + `anthropic-beta: oauth-2025-04-20` +
  `anthropic-version` → the account's models (Opus 5.5, Fable 5.1, …).
  `/api/oauth/profile` gives the plan (`has_claude_pro`, `organization_type`).
  The usage body's `extra_usage {is_enabled, user_disabled,
  spend_limit_reached}` is the credits switch; `limits[]` has session/weekly.
* (11B) **Fable on Pro with credits off**: `rate_limit_event {status:
  "rejected", errorCode: "credits_required", overageDisabledReason:
  "org_level_disabled"}`, result 429 "Fable 5.1 requires usage credits…",
  nothing billed. The old code marked the whole account limited until the
  weekly reset on that — never treat `credits_required` as an account limit.
* (11B) **Codex**: `GET chatgpt.com/backend-api/codex/models?client_version=
  <cli version>` with the slot's token + `chatgpt-account-id` lists models
  (`visibility: "list"` ones are the picker; `priority` is display order,
  not strength). `wham/usage` has `plan_type` and `credits {has_credits,
  unlimited, overage_limit_reached}`. The CLI caches the list in
  `$CODEX_HOME/models_cache.json`. Effort: `-c model_reasoning_effort=high`.
* (11B) **A model can be listed for the account yet too new for the
  installed Claude Code**: Opus 5.5 on 2.1.278 → `API Error: 400 Claude Code
  2.1.278 does not support this model; version 2.1.280 or newer is required`
  (result `is_error`, `api_error_status` 400). It used to classify as
  TASK_FAILED and stop the chain; now `cli_min` remembers it and the task
  retries on Opus 5 (verified live via Diagnose). MAGI does NOT run `claude
  update` mid-task; since 2026-09-24 it updates the CLIs itself when idle
  (Tony asked for it) — `magi/code/agents/updates.py`.
* (11) **GitHub `actions/runs?branch=X` without `exclude_pull_requests=true`
  returned a weeks-old slice** on A1 (4,000+ runs); with it, newest first.
* (11) Job logs: `/actions/jobs/{id}/logs` → 302 to a signed blob URL; follow
  it without Authorization. A1 is public; its token (Contents: Read-only)
  reads Actions, PRs, issues and releases fine.
* (11) **MCP in plan mode works**: `claude -p --permission-mode plan --tools
  Read,Glob,Grep --strict-mcp-config --mcp-config <file> --allowedTools
  mcp__<server>` → the server connects (`init.mcp_servers[].status:
  "connected"`) and its tools are callable; a `pythonw` stdio server is fine.
* (11) `str.strip()` treats `\x1f` (and `\x1c`–`\x1e`) as whitespace — never
  `.strip()` output that uses them as separators.
* (11) The auto-mode classifier refuses reading `~/.claude.json`
  ("credential exploration"); nothing in it is needed — the model list and
  credits come from the endpoints above.
* (Phase 10) **`credential.interactive=never` also stops git asking
  `GIT_ASKPASS`** — clear helpers with `-c credential.helper=` and rely on
  `GIT_TERMINAL_PROMPT=0`.
* (Phase 10) Git for Windows runs a `#!/bin/sh` script as `GIT_ASKPASS`;
  `pythonw` writes to git's pipe fine.
* (Phase 10) A local **smart-HTTP server** (`git http-backend` behind Basic
  auth) tests a credentialed push without GitHub — see `test_github_push.py`.
* (Phase 10) **REST `permissions.push` is the owner's role, not the
  token's** — ask git (`git.can_push`, a dry-run push).
* (Phase 9) `git commit --only -- <path>` refuses a never-seen path; `git
  add` new files first; save/restore the index with `write-tree`/`read-tree`.
* (Phase 9) Git Credential Manager is machine-wide — network git WITHOUT
  `Auth` still uses it silently. git subprocesses cost ~50–100 ms each.
* `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` makes Claude's `acceptEdits` refuse
  EVERY edit; `claude_cli.env_for_task` drops it in write mode (no shell).
* Claude `--restricted` confines file tools to cwd.
* Codex `workspace-write` is **silently read-only on Windows** without
  `-c windows.sandbox=unelevated`; `-c` values unquoted.
* Browser replies are read from the RENDERED page: verbatim output goes in
  a fenced code block.
* `core.autocrlf=true` machine-wide; files are CRLF on disk after the
  auto-commit — compare contents line-ending-normalised.
* The worktree shares the real repo's hooks → every sandbox git call passes
  an empty `core.hooksPath`.
* **Writing files:** bash heredocs in this harness turn backslash escapes
  into raw control bytes (it happened twice this session: a `\x1f` and a
  `\r\n`). Write scripts and anything with backslashes with the Write tool;
  PowerShell 5.1 mangles `git commit -m` here-strings — use `git commit -F`.
* `tests/live/cdp.js` `evalJs`: an expression containing `;` or a newline is
  wrapped WITHOUT `return` — add an explicit `return`.

### Non-negotiables (Tony's rules — keep them)

* Nothing paid, no API keys. Free/subscription accounts only. (A GitHub PAT
  is a credential, not a paid API — it stays on the engine PC.) **Usage
  credits are never turned on by MAGI**; it only notices that you did.
* No native browser UI (alert/confirm/prompt/pickers) — everything hand-built.
* No secrets in code; credentials stay on the engine machine. Tokens never in
  a response, a log, Firestore, `.git/config`, argv or an env var — and never
  in an agent's reach (the MCP tools ask the engine).
* Firestore: one listener, debounced dirty-flag writes, nothing written while
  work is in flight.
* Clean on desktop AND phone (test at 390px).
* Pull before working in any repo that pushes to GitHub.
* Restart the engine yourself after engine changes.
* Never force-push.
* Your caps override everything automatic: a capped agent gets no requests.

### Test harness

* `tests/live/cdp.js` — headless Edge/Chrome over CDP (port 9333, its own
  profile). `evalJs(c, expr)`, `shotPath(name)` → `%TEMP%\magi-live-shots`.
* `tests/live/magi-codemode.live.js`, `magi-usage-sync.live.js`,
  `magi-codex-login.live.js`, `magi-write.live.js` (Phase 8),
  `magi-git.live.js` (Phase 9), `magi-github.live.js` (Phase 10).
* `tests/live/magi-repo.live.js` — Phase 11 against the real A1, read-only:
  every tab, 304 on repeat, the watch to a verdict, A1's real failed Pages
  deploy (`ead3625…`) named by job › step with its log, 390px bottom sheet.
  `LIVE_ONLY=panel,watch,phone,diagnose` (diagnose is opt-in: a real Read
  task).
* `tests/live/magi-models.live.js` — Phase 11B on the real accounts: the
  model row, Auto as you type, the sheet, a **real cap enforced on a real
  task** (spends nothing: Claude is skipped), the popup, 390px. Opt-in:
  `run` (a real task with Fable chosen and credits off → Auto's pick),
  `veda` (a second engine on :8001). Restores every setting in `finally`.
  `LIVE_ONLY=row,auto,sheet,caps,toast,phone,run,veda`.
* The page is opened as `file:///…/magi.html`; Firebase is stubbed off and
  `/auth/journal/status` is stubbed to "no lock" so the profile opens.

### Waiting on Tony

* **Nothing blocks Phase 12.** Try when convenient: open Code Mode, tap the
  **Claude** line under the agents (model, effort, usage, *Stop at*), and
  the **Repository** pill on A1 (tabs; *Watch* on Overview).
* The A1 GitHub token (fine-grained, Contents: Read-only on A1) **expires
  2026-10-21** — Phase 12+ sessions after that need a new one.
* ~~Run `claude update`~~ — **done 2026-09-24**: Claude Code 2.1.278 → 2.1.281,
  Codex 0.155.1 → 0.156.1, and MAGI now keeps both current itself
  (`updates.py`, Auto-update on by default, never mid-task; Update now in each
  agent's sheet).
* To see Fable become choosable: turn usage credits on at
  claude.ai/settings/usage; within a few minutes the sheet shows Fable
  available ("on usage credits") with no restart. (Not done — it would bill.)
* Phase 14 (A1 writable) needs Tony's explicit go-ahead; Phase 15 needs Veda
  for her sign-ins (see "Ready for Veda's PC").

### Phase 12 — first concrete steps for the next session

Keep from Phases 9–11: **MAGI performs git and GitHub calls itself; agents
never get git or a token.** Auto commit is `git.commit` (explicit paths,
`--only`, hooks run) called by MAGI, and auto push is `git.push` with the
project's `Auth` — no new git code paths.

1. `prefs.autoCommit` / `prefs.autoPush` per project (`W.DEFAULT_PREFS`,
   both false), **forced false for A1** in the route and in the runner
   (`is_engine_repo`), whatever the console sends.
2. New `magi/code/autocommit.py`: after a write task is *applied*
   (`t.result.write == "applied"`), schedule a commit of exactly
   `t.result.files` after a debounce (3 min default; a later applied task on
   the same project folds its files in and restarts the timer). Message
   `magi: <draft_message>` (distinct from `auto:` / `auto: claude code`).
   Refuse (and say so on the line) when unrelated files are staged
   (`git.status`), mid-merge/rebase (`in_progress`), or detached.
3. Auto push: only after that commit, only with an account for HTTPS
   remotes, only after `git.pull` came back clean (never force); then start
   the Phase 11 **Actions watch** for the pushed SHA (the console already
   does this for manual pushes — expose the auto-push SHA via a `pushed`
   event on the task stream or a field on `/projects/{id}/git`).
4. Console: two toggles in the Repository panel's header or the workspace
   sheet (off by default; greyed with the reason on A1), and the strip pills
   "Auto commit"/"Auto push" (today hard-coded "off") show the real state and
   a countdown while a commit is pending ("commits in 2:40 — Cancel").
5. Tests: `magi/tests/test_code_autocommit.py` (debounce collapses N applies
   into one commit; unrelated staged changes block; mid-rebase blocks; A1
   never; push only after a clean pull; `magi:` prefix), a scratch-repo
   live test (`tests/live/magi-autocommit.live.js`) with it on, then A1 with
   it off confirming the Stop hook still behaves.

---

## Context

MAGI today is a **deliberation** tool: `magi.html` (a static console on GitHub Pages) asks a question to
several browser-automated AI accounts in parallel through a **local Python engine** (`magi/`, FastAPI +
Playwright) that runs on exactly one PC, then one member synthesises a verdict. Finished results sync to
Firestore so a verdict produced at the desk opens on the phone.

Three things are being added, and they are deliberately ordered foundations-first:

1. **Profiles** — Tony and Veda each get their own MAGI: their own AI account credentials, their own history,
   their own settings, gated by their own password. Modelled directly on `index.html`'s existing Tony/Veda split.
2. **Multi-engine** — MAGI stops assuming one engine on one PC. Each profile can have engines on several
   machines, and the console picks between them. This is for *all* of MAGI, not just Code Mode.
3. **Code Mode** — Claude as an implementation agent inside MAGI: reading and editing real files on the engine's
   device, running commands and tests, driving Git, and managing GitHub repositories, with the council available
   for planning and second opinions.

The ordering matters. Profiles change the Firestore document path, and multi-engine changes what an "engine" is
in every request. Code Mode's own data model is built on both. Building Code Mode first would mean writing its
sync layer and its device-binding model against assumptions that are about to change, then rewriting them.

### Decisions already made

| Question | Answer |
|---|---|
| Veda's engine | **Veda gets her own MAGI** — her own credentials, history and settings, like the Tony/Veda TaskHub split. |
| Profile system | Copy `index.html`'s pattern: a profile picker at boot, per-profile App Lock, separate Firestore documents. |
| Lock | The lock **is** the profile picker — one secured screen, not two. Each profile has its own password and its own biometric credential. |
| UI | Every pixel hand-built in MAGI's own CSS. **No native browser dialogs, pickers or controls anywhere.** Clean on desktop and mobile equally. |
| Veda readiness | Build **everything** for two profiles and two engines now, so her PC is one command plus sign-ins. |
| Claude accounts | **Two separate council units** — subscription Claude and free Claude, tick either or both. |
| Other units | Claude only for now; the pattern is there to copy if ChatGPT ever needs it. |
| Ordering | Foundations (profiles, multi-engine) before Code Mode. |
| Cost | **Nothing paid. No API keys.** Code Mode uses the Claude Code CLI's existing subscription auth. |
| Auto-commit | Per-workspace, **off by default**, off for A1 (the existing `Stop` hook already commits there). |
| GitHub auth | Fine-grained PATs, one per account, in Windows Credential Manager on the engine device. |

### On cost, since that was a hard requirement

Nothing in this plan bills per token. The Agent SDK spawns the `claude` CLI, which uses the subscription
credentials already in `~/.claude/.credentials.json` — the same ones your VS Code sessions use, which is why
Code Mode and Deliberation are deliberately split across two Claude accounts: **coding draws on the
subscription, and the free Claude unit keeps Deliberation and Brainstorm from competing with it.** Gemini's
Refine path already uses a free-tier AI Studio key. `ANTHROPIC_API_KEY` is supported by the code only as an
escape hatch you will not set.

Worth naming once and then leaving alone: driving a subscription login from a program rather than the app it
ships with sits in the same grey area `docs/magi.md` already documents for the browser units — *"This is
against those services' terms of use… at your own risk."* Same posture, knowingly taken, for the same reasons.

---

## 1. Current Architecture Assessment

### The pieces

| | Where | What |
|---|---|---|
| `magi.html` (15,470 lines) | GitHub Pages, static, no build step | The console. All UI, all Firestore access. |
| `magi/` (~9,500 lines Python) | One PC | FastAPI + SSE engine, Playwright, SQLite. No network identity of its own. |
| `workers2/magi-link` | Cloudflare account 2 | One KV record per token hash saying where that engine's tunnel is. |

### What gets reused rather than rebuilt

**`index.html`'s profile system** — `PROFILES = {tony:{key,label,emoji,color}, veda:{…}}`
([index.html:17520](index.html#L17520)); a full-screen `#profile-overlay` with one card per person
([:17675](index.html#L17675)); `clickCard(who)` → `window.alGate("profile_"+who, enter, back)`
([:17712](index.html#L17712)) so each profile is gated by the **shared App Lock** with cross-device password
sync; `goTony()`/`goVeda()` ([:17570](index.html#L17570), [:17611](index.html#L17611)) set
`window._activeProfile` and swap which roots are visible. Data separation is by **document path** —
`dashboards/main` vs `dashboards/vedasdash` ([:10644](index.html#L10644)) — not by auth, because Firebase auth
is a single anonymous identity for the whole suite. MAGI copies this wholesale.

**MAGI's own App Lock** already exists and is already namespaced per person:
`LOCK_ID = {journal:"applock", entryId:"tony_magi"}` ([magi.html:14594](magi.html#L14594)), backed by the
`taskhub-reminders` worker. `veda_magi` is the natural sibling — no new lock system needed.

**Engine job pattern** — every long-running operation in `app.py` uses one shape: `POST` creates
`{queue: asyncio.Queue(), cancel: asyncio.Event(), done, result}` in a module dict, spawns
`asyncio.create_task(work())`, returns an id; `GET /…/{id}/stream` drains the queue as SSE; `POST /…/{id}/cancel`
sets the Event. Runs ([app.py:375](magi/app.py#L375), [:511](magi/app.py#L511)), Studio
([:597](magi/app.py#L597)), Brainstorm ([:973](magi/app.py#L973)). **Code Mode tasks reuse it verbatim.**

**Cooperative cancellation** — `Orchestrator._ask` ([orchestrator.py:105-150](magi/engine/orchestrator.py#L105))
races work against `cancel.wait()` with `FIRST_COMPLETED` and cancels the task outright so `async with` blocks
unwind. Exactly what Halt on a running Claude session needs.

**Subprocess discipline** — everything goes through [`magi/proc.py`](magi/proc.py) `run()`/`popen()`, which force
`CREATE_NO_WINDOW`. *No module in the package calls `subprocess` directly.* Git and the Claude CLI must follow.

**Failure taxonomy** — [`magi/errors.py`](magi/errors.py)'s `FailureKind`; providers never raise for expected
failure, they return a structured cause and remedy shown inline. Code Mode failures (git conflict, rejected push,
non-zero exit, denied approval, CLI rate limit) get the same treatment — never a bare 500.

**Adding a unit** is a documented three-file path (`docs/magi.md`): a site block in `config/selectors.yaml`, an
`enabled` flag in `config/magi.yaml`, and a codename in `UNIT` + a stagger in `PHASE` in `magi.html`.
`magi/tests/test_units.py` fails if the last two are forgotten, and refuses two units sharing an accent colour.
The free Claude unit goes in through exactly this path.

**Console view system** — no router; one `setView(v)` ([magi.html:9054](magi.html#L9054)) shows/hides fixed
containers and toggles sidebar `active` classes. A new mode is a branch there plus a `<div id="codeView" hidden>`.

**Firestore sync layer** — one index doc, one body doc per run, **exactly one `onSnapshot`**
([cloudWatch, magi.html:14139](magi.html#L14139)), debounced merge-writes guarded by dirty flags
(`_queueDirty`, `_marksDirty`). Budget rationale at [magi.html:12657](magi.html#L12657). Path helpers are
already factored as `_indexDoc()` / `_runDoc(id)` ([:12770](magi.html#L12770)) — which is what makes profiles a
small change rather than a sweep.

**Shared A1 furniture** — `uiAlert/uiConfirm/uiPrompt/uiForm` ([:4161](magi.html#L4161)), the `ui-cap-2000` cap
([:4074](magi.html#L4074)), `SPINNER`/`spinnerEl()`, overlay scrollbars, `tabsync.js`, `<a1-lifehub>`.

### Hard constraints discovered

1. **The engine has no Firebase credentials and must not grow any** — policy, stated at
   [app.py:579-582](magi/app.py#L579): the machine holding logged-in AI accounts should not also hold the keys
   to the sync store. Firestore is browser-only.
2. **App Check refuses `127.0.0.1`** — a console served by the engine can never sync. Already why the prompt
   queue is mirrored to `localStorage`.
3. **Firebase budget is shared across all of A1** — 20k writes / 50k reads a day. Nothing is written while work
   is in flight; one body write plus one debounced index update per *finished* unit of work.
4. **1 MiB per document**, 900 KB house soft-guard (`docs/warden-handoff.md`, `docs/taskhub-archive-handoff.md`).
5. **Engine code is inert until restarted.** Every engine change needs `magi/restart.ps1`.
6. **`.claude/hooks/auto-push.sh` runs `git add -A` on every Stop.** Code Mode must stage *specific paths only*.
7. **Tests lift strings out of `magi.html`** — `tests/magi-handoff.test.js`, `tests/ui-width-cap.test.js`,
   `magi/tests/test_console_intact.py`, `magi/tests/test_howitworks.py`. The last is a contract: any change to
   what a run does updates the `HOW` panel in the same commit.
8. **`magi-link` keys KV by SHA-256 of the token.** Two engines with *different* tokens already get separate
   records — so multi-engine needs **no worker change**, provided each engine has its own token.
9. **No GitHub/Git/file/editor code exists in `magi.html`.** All new surface.
10. **Missing prerequisites**: `claude` is not on PATH (Node 24 is, so `npm i -g @anthropic-ai/claude-code`
    covers it); `gh` is not installed, so GitHub work goes through REST.

---

## 2. Recommended Architecture

```
   ┌── PROFILE PICKER (boot) ── App Lock: profile_tony / profile_veda ──┐
   │                                                                    │
   ▼                                                                    ▼
 TONY                                                                 VEDA
 dashboards/magi                                        dashboards/magi_veda
 localStorage  magi.tony.*                              localStorage magi.veda.*
   │                                                                    │
   │  engines: [{id,label,token}]        (per profile, synced)          │
   ▼                                                                    ▼
 ┌──────────────────────┐  ┌────────────────────┐    ┌──────────────────────┐
 │ ENGINE  tony@deskPC  │  │ ENGINE tony@laptop │    │ ENGINE veda@vedaPC   │
 │ :8000                │  │ :8000              │    │ :8000                │
 │ profiles/tony/<site> │  │ profiles/tony/…    │    │ profiles/veda/<site> │
 │ data/tony/magi.db    │  │ data/tony/magi.db  │    │ data/veda/magi.db    │
 │ own MAGI_API_TOKEN   │  │ own token          │    │ own token            │
 └──────────┬───────────┘  └────────────────────┘    └──────────────────────┘
            │  discovery: same-origin → 127.0.0.1 → magi-link(hash of ITS token)
            │
            ├── Deliberation / Brainstorm / Studio ──► Playwright ──► AI accounts
            │        units incl. claude (sub) + claude-free
            │
            └── CODE MODE  /api/code/*
                     │
                     ├─ claude-agent-sdk ──► claude CLI (subscription auth)
                     │     cwd = workspace root
                     │     PreToolUse hook: containment + audit
                     │     can_use_tool:    approval → SSE → console
                     │     ├─ Read/Edit/Write/Glob/Grep ──► LOCAL FILES
                     │     ├─ Bash ─────────────────────► TERMINAL / TESTS
                     │     └─ MCP (in-process) ─┐
                     │                          │
                     ├─ git   → proc.run ───────┼──► LOCAL GIT
                     ├─ github→ httpx ──────────┼──► api.github.com
                     └─ council ────────────────┴──► Orchestrator ──► browser units
```

**Four seams that make this work:**

1. **A profile is a document path plus a set of credentials, not an identity.** Firebase auth stays a single
   anonymous session — exactly as `index.html` does it. Nothing about rules, App Check or sign-in changes.
2. **An engine belongs to exactly one profile.** `magi/config/magi.yaml` gains `profile: tony`, and a console in
   Veda's profile only ever talks to engines that declare `veda`. This is what guarantees Veda's console uses
   Veda's AI accounts — the accounts live in that engine's own `profiles/veda/` Chrome directories, and Tony's
   console has no route to them. A single PC can host both by running two engines on different ports.
3. **The Agent SDK is the implementation agent, not a council provider.** It is not registered in
   `API_PROVIDERS` and never joins `build_providers()`. A council member answers a question; a coding agent runs
   a tool loop. Mixing them corrupts quorum counting — the same reason `GeminiAPIProvider` is kept out.
4. **The council is exposed to Claude as MCP tools.** `create_sdk_mcp_server()` gives Claude
   `convene_council(question, units)` and `ask_unit(unit, question)` calling the existing `Orchestrator`, so it
   can get an architecture opinion or a second read on a bug mid-task. This is MAGI's advantage over plain
   Claude Code, and it costs almost no new engine code.

### UI principles — apply to every phase

**Everything is hand-built in MAGI's own CSS. No native browser UI, anywhere.** MAGI already takes this
position — `window.alert` is globally overridden to route through `uiAlert` ([magi.html:4263](magi.html#L4263))
and the suite ships `uiModal/uiAlert/uiConfirm/uiPrompt/uiForm` ([:4161](magi.html#L4161)). Code Mode and the
profile system extend it rather than reopening it:

| Instead of | Build |
|---|---|
| `window.prompt` for a password | A drawn field with its own show/hide eye, caps-lock hint and error line |
| A `<select>` for profile / engine / workspace | Custom pickers — cards on the profile screen, a drawn dropdown elsewhere |
| The browser's file picker for a workspace path | **An engine-served directory browser** (`GET /api/code/browse`) rendered in MAGI's own tree UI — the only way this can work on a phone anyway, since a browser cannot enumerate a remote filesystem |
| A native `confirm()` before a destructive action | The approval card, showing the literal diff or command |
| Default `<input type=file>` chrome | The existing `#btnAttach` pattern |

**One layout, two shapes.** Every new surface is designed at 400 px first and allowed to expand, not designed
wide and then squeezed. The rules the rest of MAGI already follows apply unchanged: the `ui-cap-2000` width cap
([:4074](magi.html#L4074)) stays; the 760 px breakpoint moves the sidebar into the existing off-canvas drawer;
modals become bottom sheets under 430 px ([:4198](magi.html#L4198)); every new scroller gets an overlay
scrollbar; touch targets stay at 44 px; and the Code Mode status strip collapses from a row of pills to a single
tappable line. Approval cards in particular are designed for a phone, because approving a diff from the couch is
a primary use, not a fallback.

---

## 3. Security Architecture

Code Mode is the highest-privilege thing MAGI will do, and unlike `/api/restart` and `/api/power` — which are
loopback-only — it must be tunnel-reachable, because remote control from the phone is a requirement. Seven
layers:

**Profile isolation.** Each profile's data lives in its own Firestore document, its own localStorage namespace,
and its own engine with its own Chrome profile directories and its own SQLite. Switching profiles tears down the
Firestore listener and re-attaches to the other document — it is not a UI filter over shared data.

**The lock is the profile gate, and it is load-bearing.** Today MAGI's lock is explicitly cosmetic — the code
says so at [magi.html:14580-14591](magi.html#L14580): it stops someone at the laptop reading transcripts, and
authorises nothing. With profiles that is not enough, because "someone at the laptop" now includes the other
person. So the lock gains three real properties:

- **Nothing is fetched before unlock.** `cloudInit()` and `cloudWatch()` are gated on the profile being
  unlocked, so a locked profile's document is never read and never lands in the Firestore IndexedDB cache. Today
  the listener attaches at boot regardless.
- **The engine token is not loaded before unlock**, so a locked profile cannot reach its engine, and cannot
  drive its AI accounts.
- **Independent credentials per profile.** Separate password records (`tony_magi` / `veda_magi` against the
  existing `taskhub-reminders` worker, which already syncs them cross-device) and separate biometric
  credentials — the shared `window.Bio` helper already namespaces by `NS + app + '_' + id`
  ([:4270](magi.html#L4270)), so `bio_cred_magi_tony` and `bio_cred_magi_veda` need no new mechanism. Unlocking
  one never unlocks the other, and leaving a profile re-locks it.

This is a genuine improvement to MAGI independent of Code Mode, and it is why the lock and the picker are one
screen rather than two: a picker that shows you the door and a lock that guards it separately is two chances to
get the ordering wrong.

**Arming.** Code Mode is inert until armed. `POST /api/code/arm` sets an in-process flag with a TTL (12h,
cleared on restart). From loopback it is unconditional; over the tunnel it requires the App Lock password again.
An unarmed engine answers every write endpoint with a structured `not_armed` failure. Read-only endpoints stay
open so the phone can look without arming.

**Workspace containment.** A workspace is an explicit registered absolute path. The Agent SDK runs with
`cwd = binding.root` and **no `additionalDirectories`**. On top, a `PreToolUse` hook — which runs before every
other permission step, and whose deny stands even in `bypassPermissions` — resolves every path argument through
`Path.resolve()` and denies anything escaping the root, plus a standing deny-list (`.git/config`, `.env*`,
`**/.ssh/**`, `**/id_rsa*`, writes under `node_modules/`, anything under `%USERPROFILE%\.claude`). Symlink
escape is caught because `resolve()` follows links before the comparison.

**Permission mode, never bypassed.** Per-workspace, capped at `acceptEdits`. **`bypassPermissions` is not
offered in the UI at all** — with it, `allowed_tools` stops constraining anything and every tool is approved.
New workspaces start in `plan` mode, so a new project's first agent is read-only.

**Human approval round-trip.** `can_use_tool` emits an `approval` SSE frame carrying the tool, the arguments,
and a rendered preview — a unified diff for Write/Edit, the literal command line for Bash — then awaits an
`asyncio.Future` resolved by `POST /api/code/tasks/{id}/approve`. Five-minute timeout, denying by default.
Approvals are one-shot; "always allow this pattern" writes a visible, revocable rule into the workspace's
`allowed_tools`. Always-ask regardless of mode: `git push`, `git reset --hard`, `rm -rf`, any delete touching
more than 10 files, anything writing outside the workspace.

**Credential isolation.** GitHub PATs live in Windows Credential Manager via `keyring`, keyed by
`magi-github:<profile>:<login>`. Never in Firestore, never returned by any endpoint, never logged, never placed
in the agent's environment. Pushes authenticate through a short-lived `GIT_ASKPASS` helper, so no token reaches
`.git/config` or a process listing. The agent gets `disallowed_tools=["Bash(git push *)", "Bash(gh *)"]` and
must *ask MAGI* to push via an MCP tool, which performs it under MAGI's own confirmation — keeping the
credential outside the agent's reach entirely.

**Untrusted content.** File contents, git output, issue and PR bodies are **data, not instructions**. Three
measures: the system prompt says so; every approval card shows the *actual* bytes or command, so an injection
that persuades Claude still has to persuade the human reading the diff; and the hook's checks are structural, so
no prose moves them. A malicious `.claude/` inside a target repo is neutralised by `setting_sources=[]` (§7).

**Audit trail.** Every tool call — allowed, denied or auto-approved — appends to a `code_events` SQLite table
with timestamp, task, tool, argument digest and outcome. Local only; never synced.

---

## 4. Profile and Workspace Data Model

### Profiles

```js
MAGI_PROFILES = {
  tony: { label:"Tony", emoji:"⚜️", color:"#e0b874",
          doc:"dashboards/magi",      lock:"tony_magi", ns:"magi.tony" },
  veda: { label:"Veda", emoji:"✦", color:"#8D769A",
          doc:"dashboards/magi_veda", lock:"veda_magi", ns:"magi.veda" }
}
```

Colours and emoji are lifted from `index.html`'s `PROFILES` so the two programs look like one suite.
`dashboards/magi` stays Tony's, so **no migration of existing history is needed**.

localStorage splits into namespaced and global:

| Namespaced (`magi.<profile>.*`) | Global |
|---|---|
| `token`, `token.ok`, `engines`, `units`, `unitorder`, `pins`, `nicks`, `unpinned`, `queue`, `bspins`, `bsnicks`, `bsunpinned`, `mode`, `code.project` | `magi.device` (device id), `magi.muted`, `magi.nav.collapsed`, `magi.lastProfile`, `magi_lock_session` |

### Engines

```
Engine        (one per profile per machine, or per port)
  id          "eng_tony_desk"      stable, magi/data/<profile>/engine.json
  profile     "tony"               magi/config/magi.yaml
  label       "Tony PC"            user-editable
  token       its own MAGI_API_TOKEN  → its own magi-link KV record
  port        8000
```

The console holds `engines: [{id,label,token,lastSeen}]` per profile, synced in that profile's document.
Discovery runs the existing three steps *per engine*: same-origin, then `127.0.0.1:<port>`, then magi-link keyed
by the hash of **that engine's** token. Because each engine has its own token, **`workers2/magi-link` needs no
change** — separate tokens already produce separate KV records, and Tony's token can never reach Veda's engine.

Engine-local directory layout, profile-scoped (migration in Phase 2 moves today's contents under `tony/`):

```
magi/profiles/<profile>/<site>/     Chrome sessions   (gitignored)
magi/data/<profile>/magi.db         SQLite            (gitignored)
magi/data/<profile>/engine.json     engine identity   (gitignored)
```

### Code Mode workspaces

The insight that makes multi-device work: **a project is a logical thing; a path is a device-local fact.**

```
Project   (syncs, inside the profile's document)
  id, name, aliases
  repos        [{host, owner, name, account}]     0..n
  defaultRepo  "anthonyn99/A1" | null
  prefs        {permissionMode, autoCommit, autoPush, commitStyle, batchWindowMin}
  notes        curated project context, ≤ 4 KB
  bindings     {eng_tony_desk: {present:true, label:"Tony PC"}}   presence only

Binding   (engine-local SQLite, NEVER syncs)
  projectId, engineId, root, lastOpenedAt, allowRemote, allowedTools[]
```

A laptop binding the same project to a different path is a second Binding row on that engine. Firestore learns
only *that* a binding exists and on which engine — never the path. **This is what makes a new machine a
configuration change rather than a migration.**

"Work on A1." resolves by exact name → alias → binding root basename → fuzzy, and sticks for the console session.

### Project context without re-scanning

| Tier | Contents | Where | Refresh |
|---|---|---|---|
| **Notes** | Curated prose: what it is, key paths, decisions, known issues. ≤ 4 KB. | Firestore | Written by Claude when something durable is learned; user-editable. |
| **Skeleton** | Tree to depth 3, top-level files, detected stack, git remote. 10–40 KB. | SQLite, keyed by a fingerprint | Rebuilt only when the fingerprint changes. |
| **Live** | Actual file contents. | Never stored. | The SDK's own Glob/Grep/Read fetch what a task needs. |

The fingerprint is `(git HEAD sha, count + max mtime of tracked files)` — one `git rev-parse` plus one
`git ls-files -s`, not a filesystem walk. **Nothing re-reads a whole project because one file changed**, and
nothing sends a project to a model: the SDK's built-in tools retrieve on demand, which is exactly why we are
not building a filesystem API of our own.

---

## 5. Firebase Strategy

**One document per profile. One listener. No new listener, ever.**

```
dashboards/magi           (Tony)          dashboards/magi_veda   (Veda)
  rows[]  unitOrder  pins  nicks  queue  queueLease  token
  engines: [{id, label, token, lastSeen}]
  code:    { projects:{…}, active:"proj_a1", rev:17 }
dashboards/magi/runs/{id}                 body per run
dashboards/magi/code/{id}                 body per Code Mode task
```

Both are covered by the existing `/dashboards/{doc=**}` rule — **`firestore.rules` needs no change.**

Code Mode state is a single new `code` **field on the document that already has a listener attached**. A
separate document would cost a second listener and a second read on every page load, permanently, for a few
kilobytes. Folding it in costs **zero additional reads and zero additional listeners**.

Written by `cloudSaveCode()` and `cloudSaveEngines()`, both cloned from `cloudSaveUnitOrder()`
([magi.html:12807](magi.html#L12807)): 900 ms debounce, dirty-flag guard, `setDoc(…, {merge:true})` on one
field. `cloudWatch` gains two `if (!_dirty && snap.x)` branches.

**Size:** ~1–3 KB per project; twenty projects is under 60 KB against a 900 KB soft ceiling. A hard guard
refuses to write `code` above 64 KB; notes are capped at 4 KB each.

### What syncs and what does not

| Syncs | Stays local |
|---|---|
| Profile's projects, names, aliases | Absolute paths (engine SQLite) |
| GitHub repo associations + which account | GitHub PATs (Credential Manager) |
| autoCommit / autoPush / commitStyle / permissionMode | Per-workspace `allowedTools` |
| Curated notes (≤ 4 KB) | Project skeleton / file index |
| Engine list: id, label, token, lastSeen | Chrome profiles, SQLite, engine.json |
| Which engine holds a binding (presence only) | File contents, diffs, command output |
| A finished task's one-line summary | Full transcript (body doc, read only when opened) |

### Steady-state cost

A heavy day — 20 Code Mode tasks, 5 preference changes, read on three devices — is roughly **25 writes and a
handful of reads** against a 20k/50k allowance shared with all of A1: under a fifth of a percent. Three rules
hold it there, the same three the council already follows:

1. **Nothing is written while work is in flight.** Progress is SSE. A task emitting 400 tool events produces
   zero Firestore writes.
2. **Debounce plus dirty-flag on every write**, so a burst of toggles is one write.
3. **Bodies are read only when opened.**

Profiles add no ongoing cost: a profile switch detaches one listener and attaches another, so there is never
more than one live.

**The `127.0.0.1` case.** A console served by the engine has no Firestore at all. So the engine's SQLite is the
source of truth and carries a monotonic `codeRev`; a console that *does* have Firebase reconciles both ways on
connect (higher `rev` wins; ties resolve per-field by `updatedAt`). A setting changed at the desk on
`127.0.0.1` reaches the phone next time any Pages-origin console connects. Since discovery step 2 lets the
Pages console reach `127.0.0.1` directly, the standing advice — already given for PWA install — is to use the
Pages URL at the desk too, and the gap never opens.

---

## 6. Git / GitHub Strategy

The dividing line: **local Git for anything about the working tree; REST for anything about GitHub as a service.**
Local Git is faster, works offline, needs no token, and is the only thing that sees uncommitted work. REST is
the only thing that sees issues, PRs, Actions and other people's pushes.

| Operation | Mechanism | Why |
|---|---|---|
| status, diff, log, branches, stash | `git` via `proc.run` | The working tree is local by definition |
| add, commit | `git` — **specific paths, never `-A`** | Avoids racing `.claude/hooks/auto-push.sh` |
| push, pull, fetch, merge, rebase | `git` + `GIT_ASKPASS` | Needs the real object store; token never hits `.git/config` |
| conflicts: detect, enumerate, resolve | `git` (`--no-commit` probe, `ls-files -u`) | Only local Git sees conflict state |
| ahead / behind | `git rev-list --left-right --count` after fetch | One network call, exact |
| repo list, browse, permissions | REST `/user/repos` | No clone required |
| issues, PRs, reviews, comments | REST | No Git equivalent exists |
| Actions runs, jobs, logs, statuses | REST `/actions/runs`, `/check-runs` | **The highest-value REST capability** — below |
| releases | REST to publish; Git for local tags | |
| branch protection, repo settings | REST | |
| read one file from an uncloned repo | REST `/contents` | Avoids cloning to read a file |

`X-GitHub-Api-Version: 2026-03-10` on every request — **omitting it silently pins you to 2022-11-28.**
Rate limits come from `x-ratelimit-remaining` and surface as a `FailureKind`; conditional requests
(`If-None-Match` with cached ETags) make repo and issue polling nearly free against 5,000/hr.

**Where REST earns its place:** A1 already auto-deploys workers through four GitHub Actions workflows on push
to `main`, and the failure mode the docs record as costing the most time is a push that succeeds while the
deploy behind it silently fails. Code Mode closes that loop — after a push, poll `/actions/runs` for the run
matching that SHA, surface failure with the failing job's log tail, and hand the error to Claude to diagnose.
Neither local Git nor Claude Code in VS Code does that today.

**Service layer** — `magi/github/` with no UI coupling: `client.py` (auth, retries, ETag cache, rate-limit
accounting, pagination), `repos.py`, `issues.py`, `pulls.py`, `actions.py`, `accounts.py`. Every function
returns plain dicts or a `GitHubError` carrying a `FailureKind`. The `/api/code/github/*` routes are thin
pass-throughs, and the MCP tools call the same functions — one implementation for both Claude and the UI.

---

## 7. Claude Integration Strategy

**The CLI is integrated directly into MAGI, and it works with the whole council — not with Claude alone.**

That is the shape of the thing, so it is worth stating before the mechanism. Code Mode is not "a Claude window
bolted onto MAGI". It is MAGI, in a different mode, where one unit happens to hold the pen:

```
   you ──► MAGI (Code Mode)
             │
             ├─ plan        ChatGPT · Claude · Gemini · DeepSeek · Perplexity · Grok
             │              the council, or a Brainstorm round, argue the approach out
             │                                   │
             ├─ implement   Claude, through the CLI ◄── reads that plan
             │                      │
             │                      ├─ can call BACK into the council mid-task
             │                      │  (convene_council / ask_unit, over MCP)
             │                      ▼
             │              files · terminal · tests · git · GitHub
             │
             └─ review      the council again, on the diff, where that earns its cost
```

Every unit is available in Code Mode, for the things units are good at: arguing an approach, catching a wrong
claim, reading an error message a different way, saying "that library does not do what you think". Claude holds
the pen because it is the only one that can actually drive a tool loop against a filesystem — the others reach
MAGI through browser automation of a chat UI, which cannot reliably do multi-step tool calling. That is a
capability difference, not a ranking.

So the council does not go quiet when you switch to Code Mode. It is reachable three ways: **before**, to
produce the plan; **during**, because Claude can call `convene_council` or `ask_unit` as MCP tools mid-task and
get real answers back from your logged-in accounts; and **after**, on the finished diff. The existing
`Orchestrator` does all of it, unchanged — this is why the seam is worth so little new engine code.

**The mechanism: Claude Agent SDK (`claude-agent-sdk`, Python) driving the Claude Code CLI as a subprocess.**

Rejected alternatives, briefly: a raw Messages API loop means hand-building file editing, context management,
diffing and permissions — and it needs a paid key, which is out. Managed Agents runs the sandbox on Anthropic's
infrastructure, the opposite of what's needed when the files are on *this* PC. Driving the existing
browser-Claude unit cannot do reliable multi-step tool calling against a filesystem — it's a chat scraper. The
browser units stay for reasoning, where they're genuinely good, via the MCP council tools.

```python
options = ClaudeAgentOptions(
    cwd=binding.root,                     # containment
    permission_mode=ws.permission_mode,   # "plan" | "default" | "acceptEdits" — never bypass
    allowed_tools=ws.allowed_tools,       # user-granted, visible, revocable
    disallowed_tools=["Bash(git push *)", "Bash(gh *)", "Bash(curl *)"],
    can_use_tool=approval_via_sse,        # → SSE frame → console → Future
    hooks={"PreToolUse": [HookMatcher(hooks=[containment_and_audit])]},
    mcp_servers={"magi": magi_tools},     # council, git, github
    system_prompt={"type":"preset", "preset":"claude_code", "append": MAGI_CODE_PREAMBLE},
    setting_sources=[],                   # do NOT inherit the target repo's .claude/
    model="claude-opus-5",
    include_partial_messages=True,        # token-level streaming into the console
)
```

Two load-bearing details:

- **`setting_sources=[]`.** At its default, an agent working in A1 would load `.claude/settings.json` and
  inherit the `Stop` → `auto-push.sh` hook, so every Code Mode task would fire a second, uncontrolled
  `git add -A` commit. It also neutralises a hostile `.claude/` planted in any repo. This belongs in a test.
- **`ClaudeSDKClient`, not `query()`.** A persistent session gives `interrupt()` for Halt and `resume` for
  follow-ups, so "now also fix the test" doesn't re-read the project.

**You choose which units Code Mode may consult.** The same tick boxes, in the same place, doing the
same job they do in Deliberation — they name the models MAGI is allowed to drive. What changes is who
reads them: in Deliberation the council fans out to the ticked units; in Code Mode that set is the
**allow-list** `convene_council` and `ask_unit` are bound to, so Claude can only reach members you
have turned on. Untick everything and Code Mode still works — Claude simply has nobody to ask.

Two consequences worth stating: the selection is per profile and already synced, so it needs no new
state; and the chips must come back in Code Mode, which the Phase 5 shell deliberately hides. They
return in **Phase 7**, when there is something behind them — a row of tick boxes that controls
nothing is worse than no row at all, which is why they are hidden until then. The unit that holds the
pen (Claude, via the CLI) is not one of these ticks: it is not a council member and unticking
`claude` must not disable Code Mode itself.

**MCP tools exposed to Claude:** `convene_council(question, units)`, `ask_unit(unit, question)`,
`git_commit(paths, message)`, `git_push()`, `github_*`. Everything credential-bearing or irreversible is an MCP
tool rather than a Bash command, because MCP tools route through MAGI's confirmation and audit path.

**Quota, and why there are two Claude accounts.** The CLI draws on the subscription, so Code Mode competes with
your VS Code sessions. That is exactly why Deliberation and Brainstorm get a *free* Claude unit alongside the
subscription one — a long coding session no longer starves the council, and you can still tick the subscription
unit deliberately when you want its better answer. The free account will hit `rate_limited` sooner; MAGI already
has that `FailureKind` and reports it per unit.

**The workflow this produces:**

```
idea → [optional] council or Brainstorm produces a plan
     → plan lands in the Code Mode composer, editable
     → Claude implements, consulting the council via MCP where it helps
     → approvals stream to whichever device you're on
     → tests run under Bash
     → MAGI commits the touched paths, pushes
     → MAGI watches the Actions run and reports the deploy
```

---

## 7A. Coding agents, accounts, and the fallback chain

**Any unit can code.** That is the rule this section exists to make true. If
Claude's allowance runs out halfway through a change, the work must not stop —
Codex picks it up, and behind Codex every other unit on the council.

### Three kinds of coding agent, one interface

| Kind | Units | How it touches files | Cost |
|---|---|---|---|
| **CLI agent** | Claude (Claude Code CLI), **Codex** (Codex CLI) | Drives its own tool loop: read, search, edit, run | Free — the account's own plan |
| **Browser agent** | ChatGPT, Claude (free), Gemini, DeepSeek, Perplexity, Grok | MAGI drives the loop: it gathers context, the unit answers in a structured form, MAGI applies it | Free — the same logged-in sessions the council uses |
| *(no API agents)* | — | — | — |

All three implement one `CodingAgent` interface in `magi/code/agents/` —
`run(task, workspace, mode) -> events`, `health()`, `usage_state()` — so the
task runner, the approval gate, the audit log and the fallback chain never know
which kind they are talking to.

**Codex runs through the Codex CLI** (`codex exec --json`), signed in with a
ChatGPT account. It works on the Free plan for local coding tasks, capped by a
rolling 5-hour window plus weekly limits. No API key, no per-token billing.
**Claude runs through the Claude Code CLI**, likewise on a signed-in account.

**Browser agents are the floor, not an afterthought.** They cannot run tools,
so MAGI does it for them: it assembles the relevant context from the workspace
(the cached skeleton, files the task names, search hits), asks the unit for a
structured answer — an analysis in read-only mode, and in write mode a list of
edits in a fixed format — and applies those edits itself through the same
containment hook and approval gate a CLI agent's edits go through. Slower and
less autonomous than a CLI agent, but it means a council with six working
units can still finish a change when both CLI agents are out of allowance.

### Any account, per agent

Each CLI agent keeps its login in **its own directory**, exactly as each
browser unit keeps its session in its own Chrome profile:

```
magi/profiles/<profile>/cli/claude-<slot>/    CLAUDE_CONFIG_DIR -> .credentials.json
magi/profiles/<profile>/cli/codex-<slot>/     CODEX_HOME        -> auth.json
```

Both variables are documented for exactly this — Claude Code's reads
*"useful for running multiple accounts side by side"*, and `CODEX_HOME`
controls both auth and config. So Codex is **not** tied to the ChatGPT account
the council's ChatGPT unit uses: its slot is signed in separately, to any
ChatGPT account. Several slots per agent are allowed, which is what lets the
chain rotate *accounts* before it rotates *models*.

Sign-in happens from **Accounts**, like every other unit: *Sign in* launches
the CLI's own login with the slot's directory set, which opens the provider's
page on the engine PC. MAGI never sees the password. *Check* runs a zero-cost
auth probe; *Sign out* deletes MAGI's copy of that slot. A special `system`
slot for Claude points at this PC's existing Claude Code login, so Code Mode
works on day one without signing anything in.

Both CLIs run with their user config ignored (`setting_sources=[]` for Claude,
`--ignore-user-config --ignore-rules` for Codex), so a hostile `.claude/`,
`AGENTS.md` or rules file in a target repo cannot reconfigure the agent, and
with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so the agent's own shell commands
cannot read the credentials it is running on.

### Pull before you work — a standing rule, not a preference

**Every task in a folder that commits to GitHub starts with `git pull`.** A1
is worked on by Tony *and* Veda, often on different machines, and work begun
against a stale tree is work that has to be redone or merged by hand. The
rule applies to every actor equally: Code Mode's agents, MAGI's own git
operations, and any assistant editing the repo directly.

How it lands:

* **Phase 9 (local Git)** implements it: before a task starts, if the
  workspace is a git repository with a remote, MAGI runs
  `git pull --rebase --autostash` and reports what came down in the
  transcript's first line ("pulled 3 commits from origin/main" or "already
  up to date"). `--autostash` so uncommitted work is not in the way, and
  `--rebase` so a local commit does not produce a merge bubble.
* **A dirty or mid-rebase tree does not silently skip it.** If the pull
  cannot be done cleanly the task does not start; the console says why and
  offers to run it anyway against the tree as it stands. Starting quietly
  against a stale tree is the failure this rule exists to prevent.
* **Per project, on by default** (`prefs.pullFirst`), because a workspace
  with no remote has nothing to pull and should not be asked.
* **After a push**, the Actions watch (§6) already closes the other half of
  the loop.

Until Phase 9 ships, the rule is manual: pull before starting work in A1.

### The fallback chain

The default order, highest first — Claude and Codex lead because they are the
strongest coders and the only two that drive their own tools:

```
1. Claude  · CLI    (each signed-in slot, in order)
2. Codex   · CLI    (each signed-in slot, in order)
3. Claude (Pro)  · browser
4. ChatGPT       · browser
5. Claude (free) · browser
6. Gemini        · browser
7. DeepSeek      · browser
8. Grok          · browser
9. Perplexity    · browser
```

Editable per profile, and filtered by the unit tick boxes: an unticked unit is
never in the chain, the same promise the council makes.

**What triggers a hand-off.** Only a failure that another agent could fix:
a usage/rate limit (the CLI's own limit message, or a 429), an auth failure
(signed out, token expired), the CLI missing, or a crash before any work was
done. **Not** a task failure — if Claude ran the tests and they failed, handing
the same task to Codex would just fail them again with a different author.

**What survives a hand-off.** The next agent is not started from scratch. It
receives the original task, a summary of what the previous agent did, and —
because every edit goes through MAGI's audit hook — the exact list of files
already changed and the current `git diff`. It is told to continue, not to
begin. A limit that trips mid-edit therefore costs the remainder of the task,
not the part already done.

**Limits are remembered.** When an agent reports a limit with a reset time
("Limits will reset at 5:00 PM"), the chain skips it until then rather than
re-discovering the wall on every task. The state is per slot and local to the
engine; it is shown in the Code Mode strip and in Accounts.

### Any unit can manage Git and GitHub

This follows from a decision already made: **git and GitHub are MAGI's tools,
not the agent's.** The agent requests `commit these paths`, `push`, `open a
pull request`; MAGI performs it with its own credentials under its own
confirmation. A CLI agent asks through MCP tools; a browser agent asks through
the same structured-answer format it uses for edits. Either way the credential
never enters the agent, and **any** unit that can produce the request can run
the operation — including when Claude and Codex are both out.

## 8. Phased Implementation Plan

Fifteen phases in three tracks. Each ends with a system that works and is committed; nothing is left half-wired
across a boundary. **Every phase touching `magi/` ends with `magi/restart.ps1`, then
`magi\.venv\Scripts\python -m pytest magi/tests`, then `node tests/run-all.js`** — engine code is inert until
restart, and a silently stale engine is the easiest way to lose an afternoon.

---

## Track A — Foundations

### Phase 1 — The gate: one screen that is both profile picker and lock

*Status:* **complete (profile picker + per-profile lock, favourite star).**

*Purpose:* Tony and Veda become separate, separately-secured MAGIs in the browser. Nothing about the engine
changes yet.

*Files:* `magi.html` only.

*Steps:*

**The screen.** One full-bleed surface at boot, hand-built, replacing the current standalone `#lockScreen`. Two
cards — Tony and Veda, using `index.html`'s colours and emoji so the suite reads as one product — each showing
its own lock state. Tapping a card expands it *in place* into the password step rather than navigating to a
second screen: the card grows, the other dims, and a drawn password field appears with its own show/hide eye, a
caps-lock hint and an inline error line. Biometric unlock, where the platform has it, is offered as a button on
the expanded card. Escape or the backdrop collapses it. **Nothing here uses a native dialog, prompt or form
control** (§2, UI principles). On a phone the two cards stack and the expanded one fills the viewport; on
desktop they sit side by side and the expanded one grows without moving its sibling.

**The mechanics.** `MAGI_PROFILES` (§4); `PROFILE` module state plus a global `magi.lastProfile`; unlock through
the existing lock worker with per-profile entry ids and per-profile biometric credentials (§3);
`_indexDoc()` / `_runDoc()` ([:12770](magi.html#L12770)) become profile-aware — that is the whole data split,
and it is two functions; every `localStorage` key routed through `lsKey(name)` → `magi.<profile>.<name>`, with
the global exceptions in §4; **`cloudInit()` and the token load gated on unlock**, which is the security change
in §3; a profile chip in the sidebar that returns to the gate and re-locks the profile being left; password
set/change/remove for each profile, drawn in the same visual language.

*Testing:* New `tests/magi-profiles.test.js` — every namespaced key resolves per profile, globals don't,
`_indexDoc()` returns the right path, and no native `prompt`/`confirm` appears in the new code. Manually:
Tony's existing history is untouched at `dashboards/magi`; Veda's profile starts empty; a run in one never
appears in the other; **a locked profile fetches nothing** (watch the network tab — no document read before
unlock); switching attaches exactly one listener; unlocking Tony leaves Veda locked; biometric works per
profile; `#tb=` handoff from TradeHub lands in the last-used profile and still passes
`tests/magi-handoff.test.js`; the gate at 400 / 760 / 1280 / 2000 px.

*Risk:* Medium — touches the sync layer's entry points and the lock. Mitigation: `dashboards/magi` stays
Tony's, so existing data never moves; the lock keeps its existing worker and record format, gaining only a
second entry id. *Firebase:* no new document until Veda is used; no new listeners ever. *Rollback:* one file.

---

### Phase 2 — Profile system (engine), built for both profiles now

*Status:* **complete (profile-scoped dirs, `magi onboard`, migration).**

*Purpose:* One engine serves one profile, with that profile's AI credentials and its own database — and the
second profile's engine is fully built and provable on this PC, so Veda's machine later is an install, not a
build.

*Files:* `magi/settings.py`, `magi/config/magi.yaml` (+`profile: tony`), `magi/accounts.py`, `magi/db.py`,
`magi/__main__.py` (+`--profile`, `--port`), `magi/cli/*.py`, new `magi/cli/onboard.py`, `magi/app.py`,
`magi.html`, `docs/magi.md`.

*Steps:*

**Scoping.** Profile-scoped paths — `magi/profiles/<profile>/<site>/` and `magi/data/<profile>/` — with a
one-time migration moving today's contents under `tony/`. `--profile` and `--port` on every command, so one PC
can host both engines at once. `/api/health` reports `profile`, and the console refuses a mismatched engine with
a clear message rather than silently showing someone else's accounts. Autostart registers one scheduled task per
profile, with distinct task names.

**`magi onboard --profile <name>` — the whole point of doing this now.** One command that takes a bare machine
to a working engine: build or reuse the venv, install Playwright's Chromium, create the profile's directories,
generate a strong `MAGI_API_TOKEN` and set it for the user, pick a free port, write `engine.json` with a stable
id and a label it asks for, register autostart, start the engine, and print the one thing a human still has to
do — sign in to each unit, and enter the token once in the console. Idempotent, so re-running it repairs rather
than duplicates. **This is built and proven on this PC against the `veda` profile in this phase**, which means
Veda's PC in Phase 15 is `git clone`, `magi onboard --profile veda`, and four sign-ins.

**Console side.** A profile's engine can be registered before the machine exists — you add the entry, MAGI shows
it as *not yet reachable*, and it lights up the first time that engine publishes itself. So Veda's engine can be
configured today and simply start working when her PC runs the command.

*Testing:* New `magi/tests/test_profile_paths.py` — path derivation, migration idempotence, mismatch refusal —
and `magi/tests/test_onboard.py` — idempotence, port selection, token generation, no overwrite of an existing
profile's data. Manually: existing Chrome sessions still work after migration (they must, or every account needs
re-login); `magi onboard --profile veda` produces a clean second engine on this PC; sign one unit into a
*different* account under `veda` and confirm Tony's engine cannot see it; Tony's console refuses the veda engine
and vice versa.

*Risk:* **Medium-high — this moves live Chrome profile directories.** Mitigation: the migration copies before
deleting, is idempotent, and is verified by opening one unit before the original is removed.
*Firebase:* none. *Rollback:* move the directories back; paths are derived, not stored.

---

### Phase 3 — Multi-engine

*Status:* **complete (engine registry + picker, per-engine tokens).**

*Purpose:* A profile can have engines on several machines, and the console picks between them.

*Files:* `magi/ident.py` + `magi/data/<profile>/engine.json`, `magi/app.py`, `magi.html`
(the `══ link ══` section, [:4644](magi.html#L4644)), `docs/magi.md`.

*Steps:* Stable `engineId` + editable label per engine, distinct from the existing per-process
`ident.INSTANCE` (which tunnel adoption still needs); `/api/health` returns both; an engine registry in the
console (`engines[]`, synced via `cloudSaveEngines()`); discovery runs the existing three steps per known
engine, in parallel, with the first healthy one selected and the rest listed as available; an engine picker on
the status row showing label, reachability and route (local / PNA / tunnel); runs tagged with `engineId`;
history merge tolerant of rows from several engines (run ids are uuids, so no collision); reattach-to-live-run
only offered for the engine that owns it; the queue lease extended to name an engine.

*Testing:* New `magi/tests/test_engine_identity.py` — id stability across restarts, health payload shape.
Manually with one engine, then two on one PC (ports 8000/8001, Tony + Veda): each console sees only its own;
adding a second Tony engine shows both and lets you switch; a run started on one and reopened from the other
reads from Firestore rather than failing; killing the active engine falls over to the other with a clear notice.

*Risk:* Medium. **`workers2/magi-link` needs no change** — per-engine tokens already hash to separate KV
records. *Firebase:* one new field, no new listener. *Rollback:* a single-entry registry behaves exactly as today.

---

### Phase 4 — Second Claude unit (free account)

*Status:* **complete (`claude` = free account, `claude-pro` = Pro).**

*Purpose:* Deliberation and Brainstorm stop competing with Code Mode for subscription quota.

*Files:* `magi/config/selectors.yaml`, `magi/config/magi.yaml`, `magi.html` (`UNIT` + `PHASE`),
`tradehub.html` (`TB_MAGI_UNITS`), `workers2/trade-dashboard` allow-list, `docs/magi.md`.

*Steps:* The documented three-file "Adding a unit" path — a `claude-free` site block reusing Claude's selectors
against its own profile directory, an `enabled` flag, and a codename plus stagger with a **distinct accent**
(`test_units.py` refuses a shared colour); sign in with the free account via Accounts → Sign in; label both
cards clearly ("Claude · subscription", "Claude · free"); add to TradeHub's allow-list and the worker's, or the
tick box silently does nothing.

*Testing:* `magi/tests/test_units.py` and `tests/magi-handoff.test.js` both fail loudly if a name is missed —
run them first. `magi doctor claude-free` against the live site. Manually: tick both, convene, confirm two
distinct answers from two accounts; confirm a free-plan rate limit reports as `rate_limited` on that unit only.

*Risk:* Low — this is the best-trodden path in the codebase. *Firebase:* none. *Rollback:* `enabled: false`.

---

## Track B — Code Mode

### Phase 5 — Mode switch and Code Mode shell (console only)

*Status:* **complete.**

*Purpose:* Prove the UI with no engine dependency. Deliberation must be untouched.

*Files:* `magi.html` only.

*Steps:* Mode toggle in `.qbar-toolbar` beside Refine (thumb-reachable on mobile); `S.mode` persisted to
`lsKey("mode")`, defaulting to `"deliberation"`; the header
[`magi.html:4428`](magi.html#L4428) `<span class="bs-title council-title">Deliberation</span>` reads
**Code Mode** when active; `setView()` gains a `"code"` branch and a `<div id="codeView" hidden>` beside
`#bsView`; a compact status strip — profile · engine · project · repo · branch · autoCommit/autoPush pills —
collapsing to one tappable line under 760 px; engine-offline placeholders throughout.

*Testing:* Deliberation, queue, brainstorm, studio and history unaffected in both profiles.
`node tests/run-all.js` green. Layout at 2000 / 1280 / 760 / 400 px.

*Risk:* Low. *Firebase:* none. *Rollback:* one file.

---

### Phase 6 — Workspace registry (engine)

*Status:* **complete (A1 registered; folder browser wired in Phase 7).**

*Files:* new `magi/code/{__init__,workspace,routes}.py`; `magi/db.py` (+`code_projects`, `code_bindings`,
`code_events`, `code_tasks`, hand-rolled migration per [db.py:156-254](magi/db.py#L156)); `magi/app.py`
(mount the router); `magi/settings.py` + `magi/config/magi.yaml` (`CodeModeConfig`).

*Steps:* CRUD for projects and bindings; path validation (exists, is a directory, not a drive root, not inside
`magi/`); `git rev-parse` to detect a repo and read `origin`; the skeleton builder with the cheap fingerprint;
read-only endpoints only — `GET/POST /api/code/projects`, `/api/code/bindings`,
`GET /api/code/projects/{id}/skeleton`. Wire `#codeView` to real data.

**`GET /api/code/browse?path=` — the directory picker.** A browser cannot enumerate a remote filesystem, and
the native file picker is off the table anyway, so the engine lists directories (names, whether each is a git
repo, hidden ones folded away) and the console renders its own tree with a breadcrumb and drive roots. This is
also the only shape that works from a phone, which is the point. Read-only, never lists file *contents*, and
refuses paths outside the drives it is told about.

*Testing:* New `magi/tests/test_code_workspace.py` — validation rejects escapes and non-directories, the
fingerprint is stable across a no-op and changes on a commit, the skeleton is capped. Register A1 and confirm
the tree renders.

*Risk:* Low — nothing writes to disk. *Firebase:* none yet. *Rollback:* drop the router; the tables are additive.

---

### Phase 7 — Coding agents, read-only (Claude CLI, Codex CLI, browser units, fallback chain)

*Expanded from "Claude Agent SDK, read-only".* The agent layer is built once, with all three
kinds of agent and the fallback chain, rather than hard-wiring Claude and retrofitting the
rest. Still **read-only**: an agent can read and search a workspace, never change it — the
write path is Phase 8, unchanged. See §7A.

*Adds:* `magi/code/agents/` (`base`, `claude_cli`, `codex_cli`, `browser`, `chain`, `limits`,
`slots`, `login`, `context`, `_proc`) and `magi/code/tasks.py`; per-slot account directories and
Accounts entries for the CLI agents; `POST /api/code/tasks` + SSE stream + cancel; the unit chips
returning in Code Mode as the allow-list; usage-limit detection with remembered reset times; tests
against recorded event streams.

*Console half (done in the same phase):* the workspace row and MAGI's own folder browser wired to
Phase 6's routes; the chain chips with their own ticks and order (`code.units`, `code.order`),
separate from the council's; Convene becoming **Run**, gated with a reason; the live transcript —
agent, tool, note, skip, hand-off, answer, outcome — replayed to a reloading console from
`sessionStorage`; Halt; and **Accounts → Coding agents**, with Codex's device code shown for
sign-in from any device.

*Status:* **complete.** Verified live against the engine: Claude CLI answered a read-only task in
under 5s, a forced limit handed off to a browser unit mid-task, and a reload replayed the
transcript; ChatGPT alone (both CLIs unticked) answered a workspace question correctly in 84s.
Codex signed in as slot `codex1` (free ChatGPT account) and ran live.
*Follow-ups done in the same session:* readable chips with every usage window (Claude 5h + 7d,
Codex from its rollout log), Agents label above the row, no order badges, renameable account
slots reported on the sync line, usage kept live (stream events + `/api/code/usage` timer),
smaller profile cards, mobile pass, and the pull-before-work rule added to §7A and Phase 9.

#### Original Phase 7 notes (still apply)

*Purpose:* A real agent streaming into the console with **zero write capability**, so the plumbing is proven
before anything can damage a file.

*Files:* `magi/requirements.txt` (+`claude-agent-sdk`); new `magi/code/{agent,prompt}.py`;
`magi/code/routes.py`; `magi.html`; `docs/magi.md`.

*Steps:* Install the CLI (`npm i -g @anthropic-ai/claude-code`) and document it as a prerequisite alongside
Chrome and Python; `CodeSession` wrapping `ClaudeSDKClient` with `permission_mode="plan"` and
`disallowed_tools=["Write","Edit","Bash","NotebookEdit"]`; `POST /api/code/tasks` +
`GET /api/code/tasks/{id}/stream` + `/cancel`, copied from the runs pattern; map SDK message types
(`AssistantMessage`, `TextBlock`, `ThinkingBlock`, `ToolUseBlock`, `ResultMessage`) onto SSE frames; render the
transcript with the existing markdown renderer ([:1147](magi.html#L1147)) and `copyButton`; Halt → `interrupt()`;
extend the restart-refusal check at [app.py:299-307](magi/app.py#L299) to cover live code tasks.

*Testing:* Ask "explain how the queue works in magi.html" — expect Glob/Grep/Read only, and confirm a Write is
refused. Halt mid-task closes cleanly. Reload mid-task reattaches, or fails cleanly and says so. Engine restart
mid-task leaves no orphan row (as Studio already handles at [app.py:85](magi/app.py#L85)).

*Risk:* Medium — new dependency, subprocess lifecycle. Mitigated by being read-only: the worst case is a wasted
run. *Firebase:* none. *Rollback:* remove the route; the dependency is inert unused.

---

### Phase 8 — Writes, approvals and diffs

*Purpose:* The dangerous half, gated properly.

*Redesigned 2026-09-21.* The original text here assumed the Claude Agent SDK
(`PreToolUse` hooks, `can_use_tool`). Phase 7 instead drives the **Claude
Code CLI and the Codex CLI directly**, plus browser units that cannot touch a
disk at all, so an in-process hook is not available for two of the three
kinds. The design below gets the same guarantees for all three, by
construction rather than by interception.

**The idea: agents never write to the real folder.** A write task runs in a
throwaway copy; MAGI diffs the copy; you approve the diff; MAGI applies it.

```
real workspace ──git stash create──► throwaway worktree (%TEMP%)
                                        │  agent edits freely here
                                        ▼
                                  git diff --binary  ──► approval card
                                        │                 (per-file diff)
                              approve ──┘ deny → discard
                                        ▼
                         git apply --3way onto the real tree
```

Why this is better than intercepting each tool call:

* **One gate for every agent.** Claude CLI (`--permission-mode acceptEdits`,
  `--tools Read,Glob,Grep,Edit,Write`), Codex (`--sandbox workspace-write`)
  and browser units (a fixed edit format MAGI writes into the worktree) all
  end in the same diff and the same card.
* **Containment is structural.** The agent's cwd is the worktree; nothing it
  does reaches the real tree until a human approves a diff. A path escape,
  a planted `.claude/` or `AGENTS.md`, a prompt injection — all of it has to
  survive a person reading the literal diff.
* **Hand-offs keep working.** When the chain moves from Claude to Codex
  mid-task, the next agent continues *in the same worktree*, so work done
  before the limit is kept.
* **Approve from the phone** is just reading a diff, which is what the card
  is designed for.

*Files:* new `magi/code/sandbox.py` (worktree lifecycle), new
`magi/code/security.py` (path + deny-list checks on the diff),
`magi/code/agents/{claude_cli,codex_cli,browser}.py` (write mode),
`magi/code/tasks.py` (approval Future), `magi/code/routes.py`
(`POST /tasks/{id}/approve`), `magi.html` (approval card).

*Steps:*

1. **Security tests first** — `magi/tests/test_code_security.py`: a diff
   touching `../x`, an absolute path outside the root, a symlink pointing
   out, `.git/`, `.env*`, `**/.ssh/**`, `id_rsa*`, `.claude/**` is refused
   before any approval is asked; a diff over a size cap is refused with a
   sentence, not truncated.
2. **Sandbox** — `git worktree add --detach <tmp> <sha>` where `<sha>` is
   `git stash create` (includes uncommitted tracked edits) or HEAD; copy
   untracked, non-ignored files in. Always removed afterwards
   (`git worktree remove --force` + prune), including after a crash or an
   engine restart (sweep stale ones at startup). Non-git workspaces: refuse
   write mode with a clear message for now.
3. **Write mode in the agents**, pointed at the worktree. **No Bash** in
   this phase — commands and tests come later behind their own approval.
4. **Approval** — after the chain finishes, `git diff --binary` in the
   worktree → security check → `approval` SSE event with per-file hunks →
   `asyncio.Future` resolved by `POST /api/code/tasks/{id}/approve`
   (`{approve: bool}`), **5-minute timeout = deny**, first answer wins
   across devices.
5. **Apply** — `git apply --3way` onto the real tree (nothing is staged or
   committed; that is Phase 9's job); a
   conflict (the real tree moved meanwhile) is reported with the files, and
   the diff is kept so nothing is lost.
6. **Console** — approval card: file list with +/− counts, each file's diff
   collapsible, Approve / Deny, countdown; phone-first. The composer gets a
   Read / Write toggle per task (default Read). A1 stays read-only (the
   toggle is disabled for it) until Phase 14.

*Testing:* the security tests; unit tests for sandbox create/teardown/sweep
against a temp repo; a live run in a **scratch repo** (never A1): ask for an
edit, approve it, check the file; deny one, check nothing changed; let one
time out; approve from a 390px viewport; force a Claude limit mid-task and
check Codex continues in the same worktree.

*Risk:* **Highest in the plan.** Mitigated by never writing to the real tree
without an approved diff, security tests written first, and A1 excluded.
*Firebase:* none. *Rollback:* force `mode = "read"` in `routes.py` again.

*Status:* **complete** (2026-09-21). Built as designed, with these changes
from the text above: apply is `git apply`, falling back to a per-file
`git merge-file` three-way (not `--3way`, which implies `--index` and would
stage); the diff is between two git *trees* (baseline written after
untracked files are copied), not `git diff` of the worktree; Codex keeps its
shell (its only way to read files) inside its OS sandbox; Claude write mode
drops the env scrub (it blocks acceptEdits). Verified live on a scratch repo:
Claude approve → file changed, nothing staged, sandbox gone; deny at 390px →
unchanged; Codex approve; ChatGPT approve via fenced SEARCH/REPLACE; 5-minute
silence → unchanged; A1 refused by the engine and greyed out in the console.
Mid-task hand-off in the same sandbox is proven with fake agents
(`test_a_handoff_continues_in_the_same_copy`), not live (a real limit
cannot be triggered on demand). Tests: 47 security, 14 sandbox, 28 write,
8 usage, plus `tests/magi-code-approval.test.js`; mutations (silence→approve,
agent handed the real folder, `.claude` not denied, symlinks allowed) all
caught.
*Also this session:* live provider usage for both CLIs (`usage_fetch.py`),
because Claude's card still showed the previous night's 90%.

---

### Phase 9 — Local Git

*Files:* new `magi/code/git.py`; `magi/code/routes.py`; `magi.html`.

*First step of every task:* the pull-before-work rule (§7A) — `git pull --rebase --autostash` when the workspace has a remote, reported in the transcript; a tree that cannot pull cleanly stops the task.

*Steps:* `proc.run`-based wrappers — status (porcelain v2), diff, log, branches, ahead/behind, stage specific
paths, commit, pull, push, conflict enumeration. **Never `git add -A`.** A repo-state panel in `#codeView`.
*(Superseded 2026-09-21: git is NOT exposed to agents as tools. MAGI performs every git operation itself on
the approved result — see §0 "Phase 9 — first concrete steps".)*

*Testing:* New `magi/tests/test_code_git.py` against a temp repo — porcelain parsing including renames and
untracked files, ahead/behind, conflict enumeration. Manually: a Code Mode commit in A1 does not fight the
`Stop` hook.

*Risk:* Medium. Push waits for Phase 10 (no credentials yet). *Rollback:* one module.

*Status:* **complete** (2026-09-21). Built per §0's Phase 9 steps: `magi/code/git.py` (status porcelain v2,
state, explicit-path stage, commit `--only`, pull, fetch_only, draft message), pull-before-work in
`tasks.start`, Commit on the applied card, the repository line. Decisions: a clashing pull is **undone**
(`rebase --abort`) rather than left mid-rebase; **A1 is fetch-only** (its tree is shared with live Claude Code
sessions and its auto-commit hook), so "a Code Mode commit in A1" cannot happen until Phase 14; commit
subjects come from the prompt, bodies from the agent summary. Tests: 37 git + 7 task-level + 26 console
static + 1 HOW contract; `tests/live/magi-git.live.js` 38/38 (pull, real Claude edit, commit on desktop and
at 390px, clash, A1 fetch-only). Mutations caught: `--only`→`--include`, no rebase abort, failed pull not
stopping the task, A1 pulled instead of fetched.

---

### Phase 10 — GitHub credentials and REST layer

*Files:* `magi/requirements.txt` (+`keyring`, +`httpx`); new `magi/github/` package; `magi/code/routes.py`;
`magi.html`; `magi/.env.example`.

*Steps:* `keyring`-backed multi-account store keyed `magi-github:<profile>:<login>`; add / verify / remove an
account (verify = `GET /user`, store login and scopes, **never return the token**); the REST client with
`X-GitHub-Api-Version: 2026-03-10`, ETag cache, pagination, rate-limit accounting and typed errors; the
`GIT_ASKPASS` helper so push works without the token entering `.git/config`; repo connect/disconnect UI and
project↔repo association.

*Testing:* New `magi/tests/test_github_client.py` with mocked transport — the 304 path, pagination, rate-limit
parsing, error mapping. Manually: add an account, list repos, associate A1, push a trivial commit, then grep
every log, config file and API response for the token.

*Risk:* Medium-high — first credential with real blast radius. Mitigation: start with a read-only PAT and widen
once proven. *Firebase:* associations sync in Phase 13; tokens never do.
*Rollback:* delete the credential; everything degrades to local-Git-only.

*Status:* **complete** (2026-09-21), except the one step that needs Tony's own token (live push to a real GitHub
repo — listed under §0 "Waiting on Tony"). Built per §0's Phase 10 steps: `magi/github/{accounts,client,askpass}.py`,
`git.push` + `Auth` + `remote_info`, project↔account in `prefs.github`, push routes for the card and the line,
Accounts › GitHub and the Repository pill in the console. Decisions: the token lives in the **OS credential store**
(keyring), never SQLite/Firestore; askpass answers **only for the account's host**; an HTTPS remote with **no
account is not pushed at all** (never falls through to GCM); a task's pull uses the project's account too; A1 is
never pushed. Found live: `credential.interactive=never` silently disables GIT_ASKPASS. Tests: 44 client/account/
askpass/route + 33 push (incl. a real `git http-backend` server with Basic auth and the real credential store) + 4
task-level + 1 HOW contract + 33 console static; `tests/live/magi-github.live.js` 33/33 + 12/12 (card at 390px with a
real Claude edit). Mutations caught: helper not cleared, askpass ignores host, token not scrubbed, `+` refspec,
pagination/ETag/foreign-host, HTTPS without account, unmasked field, token field not emptied, Push without account.

---

### Phase 11 — Repository management surface

*Files:* `magi/github/{repos,issues,pulls,actions}.py`, `magi/code/routes.py`, `magi.html`.

*Steps:* Branches, commit history, remote/local divergence, issues, PRs, releases, Actions runs with job-level
status and a failing log tail; the post-push Actions watch (§6); the same functions exposed as MCP tools so
Claude can read an issue or diagnose a failed workflow.

*Testing:* Against the real A1 repo, read-only first; confirm conditional requests actually return 304; check a
deliberately failed workflow surfaces its log tail. *Risk:* Low-medium. *Rollback:* per-surface; all additive.

*Status:* **complete** (2026-09-24). `magi/github/{repos,pulls,issues,actions,mcp_server}.py`, `client.get_raw`
(signed-URL logs followed without the token), `git.branches`, `Push.sha`, the `/api/code/projects/{id}/repo/…`
GET routes, the console's Repository panel (the pill opens it on GitHub; bottom sheet on phones), the post-push
Actions watch with Log + Diagnose, and read-only `github_*` MCP tools for the Claude CLI (engine on loopback; no
token for the agent). Found live: `runs?branch=` needs `exclude_pull_requests=true` on a busy repo (GitHub returned
a four-week-old slice); `str.strip()` eats `\x1f`. Verified live on A1: 304 on repeat (used count unchanged), the
real failed Pages deploy of 2026-09-21 surfaced by job › step with its log, and Claude diagnosed it through the
MCP tools in plan mode. Tests: 46 unit (`test_github_repo.py`), 2 HOW contract, console static, `magi-repo.live.js`
34/34. Mutations caught: log fetched with the token, PRs in issues, branch runs without the flag, MCP number
validation. Releases/compare are read but PR/issue *writes* are deliberately out of scope.

---

### Phase 11B — Model selection, usage credits and caps (added 2026-09-24 at Tony's request)

*Why here:* it belongs with the coding agents and usage (Phases 7–8), and must land before Veda's engine
(Phase 15) so her engine arrives with it. One session, built straight after Phase 11.

*Files:* new `magi/code/agents/models.py`; `usage_fetch.py` (credits, plan), `limits.py` (`note_account`),
`claude_cli.py` / `codex_cli.py` (model + effort per task, credits retry, caps), `routes.py` (`/models…`),
`magi.html` (model row, sheet, Auto preview, usage popup), `docs/magi.md`.

*Steps (as built):* model lists from the providers per account (`/v1/models` + `/api/oauth/profile`;
`codex/models`), cached 6 h; usage credits from the existing usage read; credit-gated models (Fable/Mythos on
Pro/Free, plus anything the provider refuses with `credits_required`, remembered) disabled while credits are off
and enabled within minutes of turning them on; a used-up plan runs only on credits; per-agent choice (model or
Auto + effort) stored on the engine per profile; Auto = local classifier (weight 1–4) → strongest available model
for the weight, one lighter under usage pressure; caps per agent per window (Claude session/weekly, Codex whatever
windows its plan has) enforced before a run and mid-run; alerts (`warn`/`near_cap`/`capped`/`limit`) once per
window per reset in a corner popup.

*Status:* **complete** (2026-09-24). Found live: Fable on Pro with credits off answers `credits_required`, which the
old code took as "account limited until next week" — fixed; and Opus 5.5 listed for the account but refused by the installed Claude Code 2.1.278 ("version 2.1.280 or newer is required"), which used to stop the chain — now learned (`cli_min`) and retried on Opus 5. Tests: 61 unit (`test_code_models.py`), HOW contract,
47 console static (`magi-code-models.test.js`), `magi-models.live.js` 46/46 default + 26/26 with `caps,run,veda`
(a real cap enforced on a real task; a real task with Fable chosen and credits off ran on Auto's pick and said
why; a second engine for Veda on :8001 kept its own settings). Mutations caught: 12/12 across both phases.

---

### Phase 12 — Auto Commit / Auto Push

*Files:* new `magi/code/autocommit.py`; `magi/code/agent.py`; `magi.html`.

*Steps:* Independent `autoCommit` and `autoPush` per project, **both off by default, both off for A1**;
batching — a commit fires at *task completion*, not per file operation, with a debounce (default 3 min) so a
follow-up folds into the same logical change; messages generated from the task summary with a `magi:` prefix,
distinguishable from `auto:` and `auto: claude code`; staging limited to the paths the task actually touched, as
recorded by the audit hook; a hard refusal to auto-commit when unrelated staged changes exist or a merge/rebase
is in progress; auto-push additionally requires a clean `git pull --rebase`.

*Testing:* New `magi/tests/test_code_autocommit.py` — batching collapses N writes into one commit; unrelated
staged changes block; mid-rebase blocks. Manually in a scratch repo with it on, then A1 with it off, confirming
the existing `Stop` hook still behaves.

*Risk:* Medium — where the two commit systems could collide. Mitigated by specific-path staging, the `magi:`
prefix, off-for-A1, and the blocking conditions. *Rollback:* a per-project toggle; no code revert.

---

### Phase 13 — Firebase synchronisation of Code Mode state

*Files:* `magi.html` (`cloudSaveCode()`, one `cloudWatch` branch, the reconcile); `magi/code/routes.py`
(`GET/PUT /api/code/state` + `codeRev`).

*Steps:* The `code` field on the profile's document exactly as in §5; `cloudSaveCode()` cloned from
`cloudSaveUnitOrder()` (900 ms debounce, `_codeDirty` guard, merge-write of one field); the `cloudWatch` branch;
bidirectional reconcile on connect keyed on `codeRev`; the 64 KB write guard; a finished task's one-line summary
into the index and its transcript into `dashboards/<profile-doc>/code/{id}`, read only when opened.

*Testing:* **Instrument the write count before and after.** Change a preference on the PC → exactly one write,
and the phone reflects it. Run a 400-event task → **zero** writes during it. Toggle ten settings rapidly → one
write. Change a setting on `127.0.0.1`, open the Pages console, confirm the reconcile carries it. Confirm no
second listener was attached, in either profile.

*Risk:* Medium — the requirement most easily got wrong, and a listener leak would be a permanent tax on every A1
program. Mitigated by one field, one existing listener, the dirty-flag guard, and the explicit write count.
*Rollback:* remove the branch; the engine's SQLite stays authoritative, so nothing is lost.

---

## Track C — Hardening and rollout

### Phase 14 — Hardening, documentation, regression sweep

*Files:* `docs/magi.md`, the `HOW` array ([magi.html:5006](magi.html#L5006)), `magi/tests/*`, `tests/*`.

*Steps:* The `HOW` panel gains profiles, multi-engine and Code Mode — a **contract**, not a nicety:
`magi/tests/test_howitworks.py` enforces the checkable claims and `docs/magi.md` requires the panel to be updated
in the same commit as the behaviour; new `docs/magi.md` sections on the profile model, the engine model, the
Code Mode security model and the restart requirement; an adversarial pass (path traversal, symlink escape, a
prompt-injection file planted in a scratch repo, a hostile `.claude/` in a target workspace, an oversized diff,
a runaway Bash command, a cross-profile data leak attempt); a full regression sweep of Deliberation, Queue,
Brainstorm, Studio, History, Accounts, Doctor, handoff and lock **in both profiles**; only then A1 off `plan`.

*Risk:* Low.

---

### Phase 15 — Veda's engine (an install, not a build)

*Purpose:* Move the already-working `veda` engine onto her machine.

Because Phase 2 builds and proves both profiles on this PC, nothing here is new code. On Veda's PC:
`git clone`, `magi onboard --profile veda`, sign in to each unit with her accounts, and enter the token once in
her console. The engine entry she uses may already exist in her profile from Phase 2, in which case it simply
goes from *not yet reachable* to live.

*Verify:* her console reaches only her engine and Tony's only his; her history is in `dashboards/magi_veda` and
never appears in Tony's; her locked profile fetches nothing on his devices.

*Risk:* Low — everything it needs was built and tested in Phases 1–3.
*Note:* Code Mode there uses **her** Windows user's Claude CLI auth, which is correct — but it also means a
`veda` engine hosted on *Tony's* PC would use Tony's CLI credentials. Documented, and Code Mode is gated to the
profile that owns the machine.

---

## 9. Files / Components Likely To Change

**New:**

```
magi/cli/onboard.py                      one-command engine setup per profile
magi/code/{__init__,workspace,agent,security,git,autocommit,prompt,routes}.py
magi/github/{__init__,client,repos,issues,pulls,actions,accounts}.py
magi/tests/test_profile_paths.py  test_onboard.py  test_engine_identity.py
          test_code_workspace.py  test_code_security.py  test_code_git.py
          test_code_autocommit.py  test_github_client.py
tests/magi-profiles.test.js
magi/data/<profile>/engine.json          (runtime, gitignored)
```

**Modified:**

| File | Change | Size |
|---|---|---|
| `magi.html` | The gate — profile cards + inline lock, replacing `#lockScreen` ([:14574](magi.html#L14574)) — plus `MAGI_PROFILES` and `lsKey()`; profile-aware `_indexDoc`/`_runDoc` ([:12770](magi.html#L12770)) with `cloudInit` gated on unlock; engine registry and picker in `══ link ══` ([:4644](magi.html#L4644)); mode switch + header swap ([:4428](magi.html#L4428)); `setView()` branch ([:9054](magi.html#L9054)); `#codeView`, the directory picker, the file tree and approval cards, all hand-built; `cloudSaveCode`/`cloudSaveEngines` beside [:12807](magi.html#L12807); two `cloudWatch` branches ([:14139](magi.html#L14139)); `UNIT`/`PHASE` for the free Claude; `HOW` array | **Large — most of the frontend work** |
| `magi/settings.py`, `config/magi.yaml` | `profile`, `CodeModeConfig`, profile-scoped paths | Medium |
| `magi/db.py` | Four tables + migration, per [:156-254](magi/db.py#L156) | Medium |
| `magi/app.py` | Mount the code router; `profile` + `engineId` in `/api/health`; restart-refusal covers live code tasks ([:299](magi/app.py#L299)) | Small |
| `magi/accounts.py`, `cli/*.py`, `__main__.py` | Profile-scoped profile dirs; `--profile` / `--port` | Medium |
| `magi/config/selectors.yaml` | `claude-free` site block | Small |
| `magi/requirements.txt`, `.env.example` | `claude-agent-sdk`, `keyring`, `httpx` | Small |
| `tradehub.html` + `workers2/trade-dashboard` | `claude-free` in the unit allow-list | Small |
| `docs/magi.md` | Profiles, engines, Code Mode | Large |

**Deliberately not touched:** `magi/engine/{orchestrator,chairman,brainstorm,studio}.py`, `providers/*`,
`browser/*`, `tunnel.py`, `firestore.rules` (the `/dashboards/{doc=**}` rule already covers the new document),
`workers2/magi-link` (per-engine tokens already hash to separate records), the existing `.claude/` hooks and
`.githooks/pre-commit`.

---

## 10. Risks and Edge Cases

**The ones that could actually hurt:**

1. **Moving live Chrome profile directories (Phase 2).** Get it wrong and every AI account needs re-login.
   *Mitigation:* copy before delete, idempotent migration, verify one unit opens before removing the original.
2. **Two auto-commit systems racing.** `.claude/hooks/auto-push.sh` runs `git add -A` on Stop; if Code Mode also
   staged everything, whichever ran second would absorb the other's changes. *Mitigation:* specific-path
   staging, `magi:` prefix, off for A1, refusal when unrelated staged changes exist.
3. **`setting_sources` defaulting on.** An agent in A1 would inherit A1's `Stop` hook and fire an uncontrolled
   `git add -A` per task. `setting_sources=[]` is load-bearing and belongs in a test.
4. **Cross-profile leakage.** A cached Firestore snapshot or a stale listener surviving a profile switch would
   show one person's data under the other's name — and because Firestore's `persistentLocalCache` writes to
   IndexedDB ([magi.html:12739](magi.html#L12739)), a document read once stays on that device. *Mitigation:*
   gate `cloudInit()` on unlock so a locked profile is never read in the first place, full listener teardown on
   switch, every localStorage key through `lsKey()`, and an explicit test that watches the network tab.
5. **Firebase regression.** A stray listener or an in-flight write is a permanent tax on every A1 program.
   *Mitigation:* one field on an existing document, the existing single listener, a measured write count.
6. **Prompt injection from project files.** *Mitigation:* structural containment no prose can move, approval
   cards showing literal bytes, `setting_sources=[]`, and a system prompt naming project content as data.
7. **Tunnel exposure.** A leaked token costs AI quota today; with Code Mode it costs your filesystem.
   *Mitigation:* arming with App Lock re-entry over the tunnel, approval on every write, per-workspace
   `allowRemote`.
8. **Stale engine.** A Python change that isn't restarted looks exactly like a bug in the new feature.

**Edge cases to handle explicitly:** a profile switched mid-run; the same profile open in two tabs (`tabsync.js`
already pairs them); an engine whose profile doesn't match the console's; two engines racing for the queue lease;
a workspace path deleted or on a disconnected drive; engine restart mid-task; two consoles approving the same
request (first wins, second told so); an approval never answered; a diff too large to render; the Claude CLI
missing, unauthenticated, or rate-limited (a specific `FailureKind`, with the council offered for planning
meanwhile); the free Claude account rate-limiting mid-council; a PAT expired or revoked mid-push; a repo renamed
on GitHub; detached HEAD, mid-rebase, or a pre-existing conflict; a project bound on an offline engine; the
`code` field exceeding its size guard; a Bash command that starts a server and never returns.

---

## 11. Testing Plan

**Standing rule: after every phase touching `magi/`, run `magi/restart.ps1`, then
`magi\.venv\Scripts\python -m pytest magi/tests`, then `node tests/run-all.js`.**

| Phase | Automated | Manual |
|---|---|---|
| 1 | `tests/magi-profiles.test.js`; `run-all.js` | Tony's history intact; Veda's empty; no cross-visibility; **locked profile fetches nothing**; one listener per switch; independent locks + biometrics; gate at 400/760/1280/2000 px |
| 2 | `test_profile_paths.py`, `test_onboard.py` | **Chrome sessions survive migration**; `magi onboard --profile veda` builds a clean second engine on this PC; different accounts under each profile; mismatch refused |
| 3 | `test_engine_identity.py` | Engine picker with 1 then 2 engines; failover; cross-engine history read |
| 4 | `test_units.py`, `magi-handoff.test.js` (run first) | `magi doctor claude-free`; both Claudes answer one question; free-plan rate limit isolated |
| 5 | `run-all.js` | Deliberation unaffected in both profiles; layout 2000/1280/760/400 px |
| 6 | `test_code_workspace.py` | Register A1; render the tree |
| 7 | existing suites green | Read-only task; a Write is refused; Halt; reload and restart mid-task |
| 8 | `test_code_security.py` (written first) | Approve an edit; deny an escape; approve from the phone; let one time out |
| 9 | `test_code_git.py` | A commit in A1 that doesn't disturb the `Stop` hook |
| 10 | `test_github_client.py` | Add an account; push; grep every log/config/response for the token |
| 11 | — | Real A1 repo read-only; confirm 304s; a deliberately failed workflow |
| 12 | `test_code_autocommit.py` | Scratch repo on; A1 off |
| 13 | — | **Write count before/after**; zero writes during a 400-event task; ten toggles → one write; `127.0.0.1` → Pages reconcile; no second listener, either profile |
| 14 | Full sweep, both suites | Adversarial pass; every surface re-checked in both profiles; **a grep confirming no native `alert`/`confirm`/`prompt`/`showDirectoryPicker` in new code** |
| 15 | — | Veda's engine end-to-end; no cross-profile visibility |

**Regression surfaces to re-check at every boundary:** Deliberation convene, Queue drain and lease, Brainstorm
rounds, Studio cards, History and pins, Accounts, Doctor, the `#tb=` handoff from TradeHub, App Lock,
pull-to-refresh, the mobile drawer — **in both profiles** from Phase 1 onward.

---

## 12. Final Recommendation

**Build Track A before Track B.** Profiles change the Firestore document path and multi-engine changes what an
engine is in every request; Code Mode's sync layer and device-binding model sit on top of both. Building Code
Mode first means writing those twice. Track A is also independently valuable — MAGI gains profiles and
multi-engine whether or not Code Mode ever ships.

Within Track A: **1 → 2** does the console before the engine so the data split is proven in the cheap, reversible
half first; **3** then adds engine plurality on a settled model; **4** is nearly free and immediately reduces the
quota pressure everything after it creates.

**Both profiles and both engines are fully built and proven in Phases 1–2, on this PC.** That is deliberate: a
second engine that only exists in theory until someone carries a laptop into the room is a second engine that
does not work. Standing up the `veda` engine here — its own directories, its own token, its own sign-ins, its
own database — exercises every path Veda's machine will take, months before it exists. Phase 15 then has no code
in it at all.

Within Track B: **7 before 8** is the most important boundary in the plan. Phase 7 proves subprocess lifecycle,
streaming, cancellation and reconnection with a **read-only** agent, so when writes land in Phase 8 the only new
variable is the write path. Reversing them means debugging the SDK plumbing and the security model at once,
against a live filesystem. **9 → 10 → 11** takes Git before GitHub because local Git needs no credential — the
first token appears only once everything around it works. **12** comes after both because auto-commit is
meaningless without commit and push, and it is where the two commit systems could collide. **13** comes late
because syncing a data model that is still moving means migrating it twice; by then it is one field and one branch.

**Start with Phase 1.** It is one file, fully reversible, and it ends with two working MAGIs — which is the point
where you can judge the profile UI before anything expensive depends on it.

**Before Phase 7, one prerequisite:** `npm i -g @anthropic-ai/claude-code` (Node 24 is present; `claude` is not
currently on PATH), signed in to the **subscription** account.

**End-to-end verification once Phase 14 is done:** from the phone, in Tony's profile, over the tunnel —
*"Work on A1. The queue lease timeout is 90 seconds — find where that's defined and add a comment explaining why."*
Expect the arming prompt, a plan, an approval card showing the exact diff, a commit the existing `Stop` hook
leaves alone, and — with auto-push on for a scratch repo rather than A1 — a push followed by a green Actions run
reported back in the console. Then switch to Veda's profile and confirm none of it is visible there.
