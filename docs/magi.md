# MAGI — multi-model council

Ask one question, get independent answers from several AI models, then one
synthesised verdict naming agreements, disagreements and confidence. Named
after the three deliberating supercomputers in *Evangelion*.

```
question ──> ChatGPT  ─┐
        ──> Claude    ─┤
        ──> Gemini    ─┼──> chairman synthesises ──> VERDICT
        ──> DeepSeek  ─┘        (one of the members)
```

Members are queried **independently** — none sees the others' answers — then
one member reads all of them and writes the verdict.

Built by Veda; taken over on 2026-09-09 and reorganised as an A1 program. This
file replaces her `README.md`, `SETUP-FOR-TONY.md` and `magi-setup.md`.

---

## The one thing that makes MAGI different from every other A1 program

Every other program in this repo is a page. MAGI is a page **plus an engine on
this PC**, and the engine cannot move.

It talks to the models through **browser automation of your own logged-in
subscriptions**, not APIs — four real Chrome profiles holding live sessions.
Those profiles cannot leave the machine, so:

| | |
|---|---|
| `magi.html` | the console. Static, at the A1 root, served from GitHub Pages like every other page. |
| `magi/` | the engine. Python + Playwright, runs on this PC only. |
| `workers2/magi-link/` | one KV record saying where the engine currently is. |

**This is against those services' terms of use**, which prohibit automated
access. You are running it on your own accounts at your own risk.

---

## First run

Double-click **`magi.bat`**. It builds `magi/.venv` from Python 3.12, installs
the dependencies, downloads Playwright's Chromium, starts the server and opens
the console. That takes a few minutes once and is never repeated.

Then sign in to each site — one window opens per command, you log in by hand
exactly as you would normally, and the session is saved under `magi/profiles/`:

```
magi login chatgpt
magi login claude
magi login gemini
magi login deepseek
```

MAGI never sees your credentials, and your personal Chrome profile is never
touched — it can stay open the whole time. Skip any site you don't have an
account for and disable it in `magi/config/magi.yaml` under `providers:`.
`chairman.min_members: 2` is the minimum for a verdict to be attempted at all.

Finally, `magi doctor` to confirm the selectors still match.

### Prerequisites

- **Real Google Chrome**, not just Playwright's bundled Chromium.
  `config/magi.yaml` sets `channel: chrome` because a real Chrome fingerprint
  is part of what clears ChatGPT/Claude's Cloudflare challenge.
- **Python 3.11+.** Veda verified against 3.11; this machine has no 3.11, so
  `magi.bat` pins **3.12** — closest to that baseline, and further from the
  3.14 that `py` would otherwise pick. All 147 tests pass on it.
- **Windows.** The off-screen window mechanism (`magi/browser/winhide.py`) uses
  Win32 APIs directly.

---

## Everyday use

| Command | What it does |
|---|---|
| `magi` | start the engine and open the console |
| `magi cloud` | ...and publish a tunnel, so the console works off this PC too |
| `magi login <site>` | sign in to a site, or refresh an expired session |
| `magi doctor` | which selectors still match — **run this first when a member stops responding** |
| `magi ask "…"` | run the council in the terminal, no UI |
| `magi setup` | rebuild the venv from scratch |

Runs are **completely invisible** — no windows, no taskbar icons. Two
mechanisms, because the sites differ:

- **Gemini and DeepSeek** run in true headless Chrome.
- **ChatGPT and Claude** cannot: both sit behind Cloudflare, which serves
  headless Chrome a "Just a moment…" page it never gets past (verified —
  headless still blocked after 30s, headful clears in ~3s). They run as real
  windows parked off-screen with their taskbar buttons hidden via the Win32
  `WS_EX_TOOLWINDOW` style. The page runs normally; only the chrome is hidden.

Set `browser.offscreen: false` in `magi/config/magi.yaml` to watch the four
windows tile and answer live — useful when a selector breaks. They tile into
quadrants rather than stacking, and that is not cosmetic: Windows throttles
background work in occluded windows, which would slow the very members launched
in parallel to go faster.

---

## Opening the console from somewhere else

`magi.html` is at `https://anthonyn99.github.io/A1/magi.html`, and there is a
**MAGI** button in Tony's TaskHub. The page finds the engine on its own, in
this order:

1. **Same origin** — you opened `http://127.0.0.1:8000`. The backend is serving
   the page itself. No CORS, no token, nothing to configure.
2. **Hosted, at your desk** — the page is on GitHub Pages but the PC is right
   there. Chrome lets an https page call `http://127.0.0.1` and the backend
   answers the Private Network Access preflight, so this works with no tunnel.
3. **Hosted, away** — `magi cloud` published its quick-tunnel url to
   `magi-link`, and the page asks for it.

Cases 2 and 3 need the API token (below). The console's bottom-left status
shows which one it landed on, and says plainly when it found nothing.

**The PC must be awake and logged in.** A webpage cannot start anything on this
machine — opening the console while the PC is asleep cannot wake it, and every
run will fail.

### The token

`/api/*` is gated on a shared secret, because a quick tunnel **cannot** sit
behind Cloudflare Access — Access binds to a hostname on a zone you own, and
`trycloudflare.com` belongs to Cloudflare. Without the gate, the tunnel url is
the only thing protecting endpoints that drive your paid accounts, and urls
leak.

```powershell
setx MAGI_API_TOKEN "<a long random string>"   # then open a NEW terminal
```

Enter the same value in the console (click the status row at the bottom of the
sidebar). It is kept in that browser's `localStorage`.

Unset, the gate is **off** — so plain `magi` over 127.0.0.1 behaves as before.
`magi cloud` refuses to publish without it, and verifies the tunnel returns
**401** before publishing: a 200 there would mean the server started without
the token and is wide open.

### Why there is no rebuild step any more

Veda's build inlined the tunnel url into the JS bundle, so every PC restart
meant: new url → rewrite `.env.production` → `npm run build` → `firebase
deploy`. `magi.html` looks the url up at load instead, so **nothing is ever
rebuilt or redeployed**. Firebase hosting is gone with it.

`magi-link` holds one KV record per token, keyed by SHA-256 of that token — so
the worker never learns the secret, holds no secrets of its own, and a dump of
its namespace reveals no credential. It costs one KV write per PC boot.
Registering a domain would remove the tunnel churn entirely; see the named-tunnel
note in `magi/config/`.

---

## When a site changes its UI

This is the routine maintenance task, and it does not require touching Python.

```
magi doctor        # OK / FALLBACK / MISS per selector
```

Then open the site, inspect the element, and add the working selector to the
**top** of that field's list in `magi/config/selectors.yaml`. Every field is a
list tried in order, so old entries stay as fallbacks and you keep a rollback
path if the site reverts or is A/B testing.

---

## Troubleshooting

Every failure MAGI can produce has a specific cause and a concrete fix — this
is `magi/errors.py`'s `FailureKind` taxonomy, condensed. The UI shows the same
cause and remedy inline on the failing unit.

| Symptom | Cause | Fix |
|---|---|---|
| `not_logged_in` | Saved session isn't logged in | `magi login <site>` |
| `selector_miss` | Site's UI changed | `magi doctor`, then edit `config/selectors.yaml` |
| `bot_challenge` | Human-verification challenge served | `magi login <site>` and clear it by hand; consider slowing `pacing` |
| `timeout` | Model didn't finish in time | raise `hard_timeout_s` for that site, or retry |
| `rate_limited` | Usage limit hit | wait, or disable that provider |
| `profile_locked` | That profile is already open elsewhere | close other MAGI browser windows; your personal Chrome is unaffected |
| `browser_crash` | Browser closed unexpectedly | retry; if persistent, delete that site's folder under `profiles/` and log in again |

Every failed attempt also saves a screenshot + DOM dump under
`magi/artifacts/`. The console says **"Engine offline"** with the specific
reason when it cannot find the backend at all — that is a different problem
from any row above, and the fix is in the discovery list further up.

---

## Design notes worth keeping

**Failures are never disguised as answers.** A provider that fails returns a
specific `FailureKind` with a plain-language cause and remedy — never an empty
string or an error message in the answer field. If fewer members respond than
the configured minimum, MAGI refuses to synthesise rather than presenting a
one-model opinion as a council verdict. The verdict always states how many
members actually answered.

**A unit that replied without answering is neither "resolved" nor "offline".**
It is `degraded`, shown as *unusable*, excluded from the synthesis, and named
in the Verdict panel. Conflating it with either of the other two is what once
produced a silent "4/4 resolved" on a run where one member had returned a
clarifying question.

**Completion detection is layered**, because no single signal survives UI
churn: the site's own streaming marker, then the stop-button state, then text
stability, each confirmed by a quiet period, with a turn-count baseline to
guarantee the answer is new. Answers that complete only via the weakest signal
are flagged low-confidence rather than presented as certain.

**Long prompts are inserted in one operation** rather than typed. The synthesis
prompt carries every member's full answer, and typing 2,372 characters at human
speed took 86 seconds — a third of a whole run.

**Refine is a separate button, not a step inside Convene.** Refining on the way
to a run would send the council a question the person never read. It lands in
the composer instead, where it can be read, edited or undone first. It runs on
the Gemini **API** rather than a browser session (~4s vs a Chrome launch plus a
scrape-until-stable poll), with the model pinned to an exact version — the
`gemini-flash-latest` alias measured 14–30s with intermittent 503s, so "newest"
is not "fastest". Optional: without `GEMINI_API_KEY` in `magi/.env` it falls
back to the slow browser path.

---

## Configuration

| File | What it controls |
|---|---|
| `magi/config/selectors.yaml` | per-site selectors and timeouts — **edit this when a site changes** |
| `magi/config/magi.yaml` | pacing, which members are enabled, who chairs, artifact settings |
| `magi/.env` | `GEMINI_API_KEY` for Refine (gitignored) |
| `MAGI_API_TOKEN` | env var; gates `/api/*` (see above) |

The two YAML files are deliberately **not** merged. Selectors are what break
when a site ships a redesign, and the person fixing them at 1am should not have
to scroll past pacing and chairman config to do it.

---

## Layout

```
magi.html               the console — single file, no build step
magi.bat                the only launcher
magi/
  app.py                FastAPI + SSE
  __main__.py           the CLI
  providers/            Provider interface + browser implementation + registry
  browser/              launch, typing, completion detection, text cleaning
  engine/               orchestrator, chairman, brainstorm, studio, refine
  cli/                  serve/cloud, doctor, login, ask
  config/               selectors.yaml, magi.yaml
  tests/                147 tests — `magi\.venv\Scripts\python -m pytest magi/tests`
  profiles/  data/  artifacts/  .venv/      gitignored, created at runtime
workers2/magi-link/     where the engine currently is (Cloudflare account 2)
```

`profiles/`, `data/` and `artifacts/` are gitignored and **must stay that
way** — this repo is public, and they hold live login sessions, the full text
of every question and answer, and screenshots taken from logged-in pages.

The `Provider` interface in `magi/providers/base.py` is the seam: an API-backed
provider can be dropped in with no change to the engine, UI or database, if the
scraping ever becomes too brittle.

---

## What the A1 port changed, and what is still to do

Carried over unchanged: the whole Python engine, all 147 tests, both config
files, the Evangelion console styling.

Consolidated or dropped:

| Before | After |
|---|---|
| `README.md` + `SETUP-FOR-TONY.md` + `magi-setup.md` | this file |
| `MAGI.bat` + `MAGI-Login.bat` + `MAGI-Doctor.bat` + `MAGI-Cloud.ps1` | `magi.bat` |
| `backend/magi/` | `magi/` |
| React + Vite + TypeScript frontend (23 files, a build step) | `magi.html` |
| Firebase Hosting | GitHub Pages, with the rest of A1 |
| Interpreter probing across four candidate Pythons | a pinned `.venv` |
| Tunnel url compiled into the bundle | looked up at load from `magi-link` |
| A stale 2.4MB copy of TaskHub's `index.html` | deleted |

**Still to port: Brainstorm and Studio.** Their engine code came across intact
and is fully wired into `app.py` — `/api/brainstorm/*` and
`/api/runs/{id}/studio/*` work today and `magi ask` is unaffected. What does
not exist yet is their console: `magi.html` currently renders the Council only.
That is the next piece of work, and their CSS was left out of `magi.html`
deliberately so it arrives with the markup it styles rather than sitting unused.

Brainstorm is worth knowing about before porting it — a round is three phases
(propose → critique → merge), and the critique phase is what makes it a debate
rather than a poll: each member reads the others verbatim and attacks them, so
a wrong claim from one member gets challenged by the three that could catch it.
The properties it depends on are enforced in code rather than only asked for in
the prompt (an answered-facts ledger, blocking unknowns that gate the finish,
refutations replayed to the member that made the claim, disagreement as a table
rather than prose, and a review pass that can only improve or no-op). Read
`magi/engine/brainstorm.py` before rebuilding that UI.
