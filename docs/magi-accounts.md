# MAGI accounts, back to front

How every "account" in MAGI works, from the files on the engine PC up to the
buttons in the console, and which source files to read for each part. The
rationale behind most of these choices is written up at length in
[magi.md](magi.md); this document is the map that connects those sections to
the code.

References are **file + function name**, not line numbers: they drift, and
`magi.html` is over 20,000 lines, so a name is what you search for.

---

## 0. The model in one table

"Account" means five stacked things. Every one of them is **a directory or a
secret on the engine PC, owned by exactly one profile**. Nothing about a
login ever lives in Firestore or in the browser.

| Layer | What it is | Where it lives |
|---|---|---|
| **Person** | profile `tony` / `veda`, plus a password gate | Firestore `dashboards/magi` (Tony) or `dashboards/magi_veda`; browser storage `magi.<profile>.*`; password record `jlock:applock:<profile>_magi` on the `taskhub-reminders` worker |
| **Engine** | one Python engine process per person, with its own API token | `magi/data/<profile>/engine.json`; env var `MAGI_API_TOKEN` (Tony) or `MAGI_API_TOKEN_VEDA` |
| **Council units** | one logged-in Chrome profile per chat site (ChatGPT, Claude, Gemini, ...) | `magi/profiles/<profile>/<site>/` plus notes in `magi/data/<profile>/accounts.json` |
| **Coding agents** | CLI login "slots" for Claude Code and Codex | `magi/profiles/<profile>/cli/<agent>-<slot>/`; the Claude `system` slot is this PC's own `~/.claude` |
| **GitHub** | one token per GitHub login | Windows Credential Manager entry `magi-github:<profile>:<login>`; public metadata in `magi/data/<profile>/github/accounts.json` |

`magi/profiles/` and `magi/data/` are git-ignored because they hold logins.
They are never copied between PCs.

### How a request travels

```
 magi.html (browser, any device)
   │  1. gate: pick profile, unlock with password   (lockSubmit → taskhub-reminders worker)
   │  2. discovery: same origin → 127.0.0.1:<port> → tunnel via magi-link   (connect / connectTo)
   │  3. every call carries X-MAGI-Token   (authed / streamUrl)
   ▼
 magi/app.py  _require_token middleware
   │  foreign Origin → 403 · coding-agent process → 403 · over the tunnel without token → 401
   ▼
 route  (/api/accounts/*  ·  /api/code/agents/*  ·  /api/code/github/*)
   ▼
 module  (accounts.py · code/agents/slots.py + login.py · github/accounts.py)
   ▼
 disk / keyring, under magi/profiles/<profile>/ and magi/data/<profile>/
```

---

## 1. Back end: the profile and the engine

**One engine serves exactly one person**, because the credentials *are* the
profile. The profile is fixed when the process starts, and every path is
derived from it.

| Piece | Where | What it does |
|---|---|---|
| Choosing the profile | `magi/settings.py` `resolve_profile`, `set_active_profile` | Uses `--profile`, then `MAGI_PROFILE`, then `profile:` in `config/magi.yaml`, then `tony`. The flag has to win, because two engines on one PC share one `magi.yaml`. Names are restricted to `[a-z0-9_-]`, which rules out path traversal. |
| Paths | `settings.data_dir`, `profiles_dir`, `artifacts_dir` | These are **functions, not constants**. Modules are imported before `--profile` is applied, so a constant would pin every engine to the default profile. |
| Token name | `settings.api_token_env`, `api_token` | `MAGI_API_TOKEN` for Tony, `MAGI_API_TOKEN_<PROFILE>` for anyone else. The names must differ, because magi-link keys its records by the token's hash. |
| Setup | `magi/cli/onboard.py` `run`, `_set_token`, `PROFILE_PORTS` | Makes the directories, generates the token with `secrets.token_urlsafe(32)` and stores it with `setx`, picks the port (tony 8000, veda 8001 as a spare), and writes `engine.json`. It **never regenerates a working token**, because that would unpair every device. |
| Engine identity | `magi/data/<profile>/engine.json` | Holds a stable id, an editable label, and the port. `/api/health` reports these along with `profile`. |

### The request gate: `magi/app.py` `_require_token`

This runs on every `/api/` call except `OPTIONS`, in this order:

1. **`_foreign_origin`**: returns 403 unless the `Origin` is the same origin
   or is `https://anthonyn99.github.io` (plus any extras in
   `MAGI_ALLOWED_ORIGINS`).
2. **`magi/agent_guard.py` `decide`**: for loopback connections, it finds the
   process behind the socket. If that process is one of the coding-agent CLIs
   (`adopt` places them in a Windows Job object), it returns 403, except for
   read-only repository GETs. This stops a coding agent from driving the
   engine that launched it. If the process can't be identified, the request
   is refused.
3. **Token**: only if a token is set **and** `_arrived_over_the_tunnel` is
   true (a Cloudflare header is present, or the Host is not loopback). The
   request must then carry `X-MAGI-Token` or `?token=`; otherwise it gets
   401. The comparison uses `secrets.compare_digest`. Local requests never
   need the token.

Two related routes:

- **`GET /api/health`** reports `profile`. The console uses this to refuse
  another person's engine.
- **`GET /api/token`** gives the token only over loopback. Over the tunnel it
  returns 404. This is how the PC's own browser learns the token without
  anyone typing it.

`magi/cli/serve.py` `cloud` refuses to open a tunnel without a token, and
refuses to publish if `/api/health` answers without one.

---

## 2. Back end: council unit accounts (`magi/accounts.py`)

A council unit's account is **a persistent Chrome user-data directory**:
`magi/profiles/<profile>/<site>/`. Signing in means you type into the real
site in a real window. MAGI keeps a copy of the session and never sees your
password.

### State file: `magi/data/<profile>/accounts.json`

```json
{
  "chatgpt":  { "label": "work account", "signed_in": true,
                "checked_at": "2026-09-28T10:00:00+00:00", "detail": "Signed in." },
  "_chairman": "claude"
}
```

- **`label`** is written by you (`set_label`). MAGI deliberately does not
  scrape the account's email address: seven selectors behind logins would rot
  into showing the *wrong* account.
- **`signed_in`** holds the result of the **last live check**. A value of
  `None` means "not checked", and is never a guess. A profile folder existing
  does not prove the session still works.
- **`_chairman`** is the chairman override (`set_chairman`,
  `chairman_override`). It is kept here, on the engine, because it decides
  how a run is conducted.

### What "signed in" means

`accounts._signed_in` (and its copy in `magi/cli/login.py`) needs all three
of these:

1. **No bot-check page.** `browser/resolve.py` `is_challenge_page` looks for a
   "Just a moment" title or a visible challenge selector.
2. **The composer is visible.** `resolve.resolve(page, site.input)`.
3. **No sign-in control is attached to the page.**
   `resolve.signed_out(page, site.login_selectors)` checks for any login
   selector attached to the page, even a hidden one, because Gemini hides its
   link.

The composer alone is **not** proof. ChatGPT and Gemini both show a working
message box to logged-out visitors, and without check 3 MAGI would run the
whole council against a free tier.

Each site's selectors live in `magi/config/selectors.yaml`. The fields that
matter here are `url`, `input`, `login_selectors`, `challenge_selectors`, and
`headless_ok`. The two Claude units, `claude` (free) and `claude-pro`
(subscription), share one selector block through a YAML merge key
(`<<: *claude`). What separates the accounts is only their profile
directories.

### Operations

| Operation | Function | Behaviour |
|---|---|---|
| List | `listing` | Reads the **filesystem only** and never opens a browser. Returns, per unit: `profile` (the folder exists and is not empty), `last_used` (the folder's mtime), `size_mb`, and the stored label and last check. |
| Check | `check` | Opens the site once, headless, waits 3 seconds, runs the three tests, and records the result. It reports a separate detail for a challenge page, a missing composer, and a sign-in control. |
| Sign in | `LoginJob` + `run_login` | Opens a **visible** window **on the engine PC**, the only place the profile lives (`force_visible=True` overrides the off-screen setting). It polls `_signed_in` every 1.5 seconds for up to 15 minutes. Job states: `opening`, `waiting`, then `done`, `failed` or `cancelled`. It fails if you close the window. Every outcome is written to `accounts.json`. |
| Sign out | `sign_out` | Runs `rmtree` on `profiles/<profile>/<site>/` and nothing else. It does **not** sign you out at the provider. If Chrome still holds the folder, Windows refuses and you get `removed: false`. |
| Label | `set_label` | Up to 80 characters. |

### The browser launcher: `magi/browser/launcher.py` `launch`

This is an async context manager, and every browser use goes through it.

1. It takes a **per-site `asyncio.Lock`**, so a check waits behind a sign-in
   on the same unit.
2. It finds any orphaned Chrome processes using that profile directory and
   kills them.
3. It deletes stale `Singleton*` lock files.
4. It calls `launch_persistent_context(user_data_dir=<profile dir>)`.
5. It closes the context on exit. That is what closes the sign-in window.

### From the command line

`magi login <site> --profile veda` is handled by `magi/cli/login.py` `run`.
It opens the same kind of window and waits for either the signed-in test or
ENTER.

### Endpoints (`magi/app.py`)

Sign-in jobs are held in memory in `_logins`. "Busy" (409) means a council
run or a brainstorm is in progress (`_profiles_busy`).

| Method | Path | Handler |
|---|---|---|
| GET | `/api/accounts` | `list_accounts` → `accounts.listing` |
| POST | `/api/accounts/{site}/label` | `label_account` (form field `label`) |
| POST | `/api/accounts/{site}/check` | `check_account` (409 if busy) |
| POST | `/api/accounts/{site}/signout` | `signout_account` (409 if busy) |
| POST | `/api/accounts/{site}/login` | `start_login`: reuses a live job, otherwise `create_task(run_login)` |
| GET | `/api/accounts/{site}/login` | `login_status`: job snapshot |
| POST | `/api/accounts/{site}/login/cancel` | `cancel_login`: the window closes within about 1.5 seconds |
| GET / POST | `/api/chairman` | `get_chairman` / `put_chairman` |

---

## 3. Back end: coding-agent accounts (`magi/code/agents/`)

Code Mode drives the **Claude Code** and **Codex** CLIs. A **slot** is one
CLI login, kept in its own config directory. Adding an account means adding a
slot.

### Slots: `slots.py`

| Piece | Detail |
|---|---|
| Directory | `slot_dir(agent, slot)` returns `magi/profiles/<profile>/cli/<agent>-<slot>/` (via `cli_root`). The CLI writes its own credentials there: Claude `.credentials.json`, Codex `auth.json`. MAGI never writes them. |
| The `system` slot | Claude only. `slot_dir` returns `None`, so `CLAUDE_CONFIG_DIR` is left unset and the CLI uses this PC's own Claude Code login in `~/.claude`. It is always listed first and cannot be created or removed. |
| Environment | `env_for(agent, slot)` removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` and `CODEX_API_KEY`, so a stray key cannot outrank the slot's login. It then sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. |
| Names | `check_slot_name` accepts `^[a-z0-9][a-z0-9_-]{0,23}$`. Display names are stored in `cli/labels.json` under the key `"agent:slot"`. |
| Status | `status` asks the CLI itself (`claude auth status`, `codex login status`) and makes no model call. It returns whether the slot is signed in, plus the email and plan. |
| Create / remove | `create` makes the directory. `remove` deletes it with `rmtree`, but only if it sits under `cli_root`. Neither will touch `system`. |

### Signing a slot in: `login.py`

- **`start(agent, slot)`**:
  - Creates the slot directory and reuses any live job for that slot.
  - Otherwise launches `login_argv` with `env_for` and starts a `_watch`
    thread.
  - `login_argv` is `claude auth login --claudeai` (forced so it can never
    fall back to Console / API billing) or `codex login --device-auth`.
- **`_watch`**:
  - Strips terminal codes from the CLI's output and scrapes the OpenAI URL
    and a code like `ABCD-12345`.
  - Waits up to 15 minutes, then asks `slots.status`. The job is `done` only
    if the CLI now reports it is signed in.
- **Claude and Codex differ in where you can finish:**
  - **Claude**: the browser opens on the engine PC.
  - **Codex**: a device code, so you can finish on any device, including your
    phone.
- **`cancel`** kills the process tree.

### Usage, limits and caps

| File | Role |
|---|---|
| `usage_fetch.py` `refresh`, `refresh_all` | Reads the slot's token and asks the provider directly. Claude: `api.anthropic.com/api/oauth/usage`. Codex: `chatgpt.com/backend-api/wham/usage`. At most once a minute per slot. It **never refreshes a token**: if the token has expired it skips, and the CLI renews it on its next run. |
| `limits.py` | `magi/data/<profile>/agent_limits.json`. `mark` records that a slot hit its limit and when it resets (15 minutes if no reset time is given). `blocked_until` answers "can this slot run now?". |
| `models.py` | Model catalogue, your caps (`cap_block`), credits (`plan_used_up`, `needs_credits`), and Auto model choice. Your preferences live in `code_models.json`. |

### Choosing an account and failing over: `chain.py`

- **`expand`** turns the order `claude-cli, codex-cli, claude-pro, chatgpt, …`
  into one agent **per slot**, with Claude's `system` slot first. So every
  account of one agent is tried before MAGI moves to a different model.
- **`run_chain`**:
  - Skips any agent whose `available()` is false. `available()` checks, in
    order: the CLI is installed, it isn't being updated, you're under your
    caps, it isn't blocked by a limit, the plan isn't used up, and the slot is
    signed in.
  - Outcomes **`LIMITED`, `UNAUTHED` and `UNAVAILABLE` hand off** to the next
    agent, with a note saying what the previous one already did.
  - `OK`, `CANCELLED` and a real task failure stop the chain.

### Endpoints (`magi/code/routes.py`, prefix `/api/code`)

| Method | Path | Handler |
|---|---|---|
| GET | `/agents` | `list_agents`: each slot's status, limits, usage, and the browser units |
| POST / DELETE | `/agents/{agent}/slots[/{slot}]` | `add_slot` / `remove_slot` |
| POST | `/agents/{agent}/slots/{slot}/label` | `set_slot_label` |
| POST | `/agents/{agent}/slots/{slot}/login` | `login_slot`: waits up to about 5 seconds so the first reply usually already carries the code |
| GET | `/login/{job_id}` | `login_status` |
| POST | `/login/{job_id}/cancel` | `login_cancel` |
| POST | `/agents/{agent}/slots/{slot}/clear-limit` | `clear_limit` |
| GET | `/usage` | `agent_usage` |
| GET / POST | `/models`, `/models/choice`, `/models/cap`, `/models/warn` | model and caps settings |

---

## 4. Back end: GitHub accounts (`magi/github/`)

Code Mode clones, pulls and pushes with **your** GitHub token. The design
goal is that the token lives in exactly one place, the Windows Credential
Manager, and is read only at the moment git asks for it.

### Adding an account

- **Pasting a token** is handled by `accounts.add`:
  1. Checks the token's format.
  2. Calls `GET /user` to learn the login.
  3. Stores the token with `keyring.set_password(service(login), login, token)`,
     where `service` is `magi-github:<profile>:<login>`.
  4. Writes public metadata only (login, name, avatar, kind, scopes, expiry)
     to `magi/data/<profile>/github/accounts.json`.
  A second token for the same login replaces the first.
- **"Sign in with GitHub"** is handled by `device.py` `start` and `_wait`,
  using GitHub's OAuth device flow with scopes `repo workflow`. On success it
  calls the same `accounts.add`, so both routes store the token identically.
- **Listing** with `list_accounts` never returns a token. It reports `stored`,
  which says whether keyring still holds the token.

### Why the token doesn't leak

| Guard | Where |
|---|---|
| The API client masks the token in `repr`, scrubs it from error messages, drops chained exceptions that carry the header, and only sends it to the API host | `client.py` `GitHub` |
| git gets **names, not the token**: `credential.helper` is blanked (so Git Credential Manager neither supplies nor saves it), and git is given `GIT_ASKPASS` plus `MAGI_GH_SERVICE` / `MAGI_GH_LOGIN` / `MAGI_GH_HOST` | `magi/code/git.py` `Auth`; `magi/code/tasks.py` `git_auth` |
| The askpass helper reads keyring **when git asks**, and answers only for the expected host over https | `askpass.py` `answer` (launched by `git._askpass_script`) |
| Clone uses the plain `https://github.com/o/r.git` URL, so nothing ends up in `.git/config`. Push refuses a remote URL that contains a password, and never force-pushes | `git.clone`, `git.push` |
| The GitHub tools given to Claude go through the engine's read-only repository routes and hold no token | `mcp_server.py` |

### Endpoints (`magi/code/routes.py`)

| Method | Path | Handler |
|---|---|---|
| GET / POST | `/github/accounts` | `gh_accounts` / `gh_add_account` (body `{token}`, cleared afterwards) |
| DELETE | `/github/accounts/{login}` | `gh_remove_account` |
| GET | `/github/accounts/{login}/repos` | `gh_repos` |
| POST / GET / DELETE | `/github/device/start`, `/github/device/{id}` | `gh_device_start` / `gh_device_status` / `gh_device_cancel` |
| GET / POST | `/projects/{id}/github` | `project_github` / `set_project_github`: which login a project pushes as. Only the login name is stored, never the token. |
| POST | `/projects/{id}/push`, `/tasks/{id}/push` | `push_project`, `push_task` |

---

## 5. Front end: the gate and finding the engine (`magi.html`)

### Profiles

| Name | Role |
|---|---|
| `MAGI_PROFILES` | `tony` → document `magi`, lock `tony_magi`. `veda` → document `magi_veda`, lock `veda_magi`. |
| `PROFILE.id` | Resolved **once at load**. Priority: a handoff from another A1 app (always Tony), this tab's pick (`sessionStorage magi.pick`), `?profile=`, the starred favourite (`magi.favProfile`), the last-used profile, then `tony`. |
| `lsKey(name)` | Builds `magi.<profile>.<name>`. Every per-person key goes through it. |
| `reloadAsProfile` | Switching profile **reloads the page**. Every key constant and the Firestore listener were bound at load, so anything short of a reload would leave them pointing at the previous person. |

**Storage probe.** An early script only reads storage. If a read throws, it
sets `MAGI_STORAGE_BLOCKED` and the gate shows the amber "blocking site
storage" note (the Brave case). If storage is full, it sets
`MAGI_STORAGE_FULL`: writes that don't fit are kept in memory, and keys that
look secret (token, engines, passwords, API keys) are never spilled into a
cookie.

### The lock

- **Checking the password.** `lockSubmit` posts to
  `https://taskhub-reminders.av1.workers.dev/auth/journal/verify` with
  `{journal: "applock", entryId: "<profile>_magi", password}`.
- **Remembering the unlock.** On success the device stores `{at}` in
  `magi.<profile>.lock_session`. That is all: trust is local to the device.
  "Lock now" sets `magi.<profile>.locked`.
- **Separate records.** Each profile has its own password record and its own
  biometric credential. Unlocking one never unlocks the other.
- **Nothing happens before unlock.** `PROFILE.unlocked` stays false until
  `hideLock`. Until then `tryReconnect` and `cloudInit` refuse to run, so a
  locked profile never reads its Firestore document and never contacts the
  engine. `openUp` starts `connect()` and `cloudWatch()` after the unlock.
- **Boot.** `lockBootDecide` asks `/auth/journal/status`. If the lock service
  is unreachable it fails closed, unless this device is already trusted.

### Finding and pairing the engine

| Name | Role |
|---|---|
| `connect`, `findHere` | First probes loopback without a token: port 8000, the profile's spare port (`PROFILE_SPARE_PORTS`, veda 8001), and every port in the registry. |
| `connectTo(eng)` | Tries one engine: same origin, then loopback, then remote. On loopback it pulls the token with `fetchEngineToken` (`GET /api/token`) and shares it with `cloudPublishToken`. Remote uses the shared token and `askLink` to find the tunnel URL. |
| `probe(base)` | `GET /api/health`. Returns `unauthorized` on a 401, and **`wrongprofile`** when `profile` isn't this console's profile. The console says whose engine it is instead of calling it "offline". |
| `authed()`, `streamUrl()` | Add `X-MAGI-Token` to every call, or `?token=` to event streams, which can't carry headers. |
| `cloudPublishToken`, `cloudFetchToken`, `cloudSaveEngines`, `cloudWatch` | Share the token and the engine list through the profile's Firestore document (fields `token` and `engines`). A phone picks them up with no typing. A token that hasn't been proven to work only fills an empty field. |
| `engSeen`, `openEnginePicker` | The engine registry (`magi.<profile>.engines`), for a person with more than one PC. |

**magi-link** is `workers2/magi-link/worker.js`, a Cloudflare Worker that
records where the tunnel currently is. Its records are keyed by
`SHA-256(X-MAGI-Token)`, so knowing the token is the only credential. Records
expire after 36 hours. It only stores plain `https://` URLs.

---

## 6. Front end: the Accounts view (`magi.html`)

This is **System → Accounts** (`navAccounts`). `renderAccounts` draws three
sections, top to bottom.

### Coding agents: `renderCodeAccounts`

- There is one card per CLI and one row per slot. The `system` row is labelled
  "This PC's Claude Code login".
- **Add another account**: `codeAddSlot` asks for a slot name, then calls
  `codeLogin`.
- **`codeLogin`**: `POST …/slots/{slot}/login`, then polls
  `GET /api/code/login/{id}` every 2.5 seconds.
  - **Codex** shows the device link, the code with a "Copy code" button, and
    a phishing and expiry warning.
  - **Claude** says the sign-in page has opened on the engine PC.
- **Usage**: `usageLine` renders text like "5h used 81% (resets …)", with
  data from `codeUsageRefresh` (`GET /api/code/usage`). `codeUsagePoll`
  keeps it fresh while Code Mode is open.
- Row buttons: rename, Clear limit, Remove, and Models & limits
  (`codeModelSheet`).

### GitHub: `renderGhAccounts`

- The list comes from `codeGhLoad` (`GET /api/code/github/accounts`).
- **Sign in with GitHub**: `codeGhSignIn` runs the device flow.
- **Paste a token instead**: `codeGhAddSheet` shows a masked field. "Verify
  and add" posts the token and empties the field straight away.
- A project's push account is chosen in `codeRepoSheet`.

### Browser units: the council

- `loadAccounts` fetches `GET /api/accounts`. Each card shows the label
  (saved when you leave the field), the status, and Sign in / Switch account,
  Check, and Sign out.
- **`startLogin`** posts `…/login`, then polls `GET …/login` every 2 seconds
  until the job is `done`, `failed` or `cancelled`. Cancelling posts
  `…/login/cancel`. When started from a phone, the panel says the window has
  opened on the engine PC.
- `checkAccount` and `signOutAccount` call `/check` and `/signout`.

---

## 7. Three traces

**Sign in to ChatGPT from your phone**

1. Accounts → ChatGPT → **Sign in**. `startLogin` sends
   `POST /api/accounts/chatgpt/login` over the tunnel, with the token header.
2. `_require_token` passes. `start_login` creates a `LoginJob` and runs
   `run_login` as a background task.
3. `launcher.launch("chatgpt", force_visible=True)` opens Chrome on the
   **engine PC**, using `magi/profiles/<profile>/chatgpt/`.
4. Someone at the PC signs in. Each 1.5-second poll of `_signed_in` checks
   for no challenge page, a visible composer, and no login control.
5. The job becomes `done` and `accounts.json` records `signed_in: true`. The
   context closes, which closes the window. The phone's 2-second poll sees
   `done`.

**Add a second Codex account**

1. Accounts → Codex → **Add another account** → name `codex2`.
   `codeLogin("codex", "codex2")` is called.
2. `login_slot` runs `login.start`: `mkdir profiles/<profile>/cli/codex-codex2/`,
   then `codex login --device-auth` with `CODEX_HOME` set to that directory.
3. `_watch` scrapes the URL and code, and the console shows them. You enter
   the code on any device.
4. The CLI writes `auth.json` into the slot. `_watch` confirms with
   `codex login status`, and the job becomes `done`.
5. From now on, `chain.expand` includes `codex2` after `codex`'s other slots.

**Push with your GitHub token**

1. Code Mode → Push. `push_project` calls `tasks.git_auth(login)`, which
   builds `git.Auth(login, service)`. This carries names only.
2. `git.push` runs git with `credential.helper=` blanked and `GIT_ASKPASS`
   pointing at the askpass shim.
3. git asks for a password. `askpass.answer` checks the host, reads keyring
   `magi-github:<profile>:<login>`, and prints the token to git's pipe.
4. Nothing is written to `.git/config`, the environment, or Git Credential
   Manager.

---

## 8. Sharp edges worth knowing when debugging

- **`magi login <site>` from the command line does not update
  `accounts.json`.** The console keeps showing the old status, or "not
  checked", until you press **Check**.
- **`magi doctor` and Accounts can disagree.** The doctor's logged-in test is
  looser: it only trusts a login control when `login_is_proof` is set, and no
  site sets it. When they disagree, believe Accounts → Check.
- **`_profiles_busy` only counts council runs and brainstorms.** A Check can
  start during a sign-in; it then waits on the launcher lock. **Sign out**
  doesn't take the launcher lock at all; it relies on Windows refusing to
  delete a folder Chrome is holding.
- **`/api/restart` refuses while a sign-in window is open**, and so does the
  self-updater.
- **"Wrong profile" is not "offline".** If the console says the engine
  belongs to someone else, switch profile. Nothing is broken.
- **MAGI never refreshes an expired coding-agent token.** The usage bar goes
  stale until a task runs on that slot and the CLI renews its own token.

---

## 9. Reference files

### Core: hand these over first

| File | What it covers |
|---|---|
| [magi/accounts.py](../magi/accounts.py) | Council unit accounts: listing, check, sign in, sign out, labels, chairman |
| [magi/settings.py](../magi/settings.py) | Profile resolution, per-profile paths, token env name, site selectors model |
| [magi/code/agents/slots.py](../magi/code/agents/slots.py) | What a coding-agent slot is, its environment, the `system` slot |
| [magi/code/agents/login.py](../magi/code/agents/login.py) | Claude and Codex CLI sign-in jobs, including the device code |
| [magi/github/accounts.py](../magi/github/accounts.py) | GitHub token storage in keyring |
| [magi.html](../magi.html) | Console. Search for `renderAccounts`, `startLogin`, `codeLogin`, `renderGhAccounts`, `connectTo`, `probe`, `lockSubmit`, `MAGI_PROFILES` |

### Supporting

| File | What it covers |
|---|---|
| [magi/app.py](../magi/app.py) | `_require_token`, `_arrived_over_the_tunnel`, `/api/health`, `/api/token`, `/api/accounts/*` routes |
| [magi/agent_guard.py](../magi/agent_guard.py) | Stops coding agents from calling their own engine |
| [magi/code/routes.py](../magi/code/routes.py) | `/api/code/agents/*`, `/api/code/github/*` routes |
| [magi/browser/launcher.py](../magi/browser/launcher.py) | Chrome profile launch, lock, orphan reclaim |
| [magi/browser/resolve.py](../magi/browser/resolve.py) | `is_challenge_page`, `resolve`, `signed_out` |
| [magi/config/selectors.yaml](../magi/config/selectors.yaml) | Per-site `url`, `input`, `login_selectors`, `challenge_selectors` |
| [magi/cli/onboard.py](../magi/cli/onboard.py) | Token generation, ports, engine identity |
| [magi/cli/login.py](../magi/cli/login.py) | `magi login <site>` |
| [magi/code/agents/usage_fetch.py](../magi/code/agents/usage_fetch.py), [limits.py](../magi/code/agents/limits.py), [models.py](../magi/code/agents/models.py) | Usage, limits, caps, credits |
| [magi/code/agents/chain.py](../magi/code/agents/chain.py) | Per-slot failover |
| [magi/github/device.py](../magi/github/device.py), [client.py](../magi/github/client.py), [askpass.py](../magi/github/askpass.py) | GitHub device flow, token-safe client, askpass |
| [magi/code/git.py](../magi/code/git.py) | `Auth`, `clone`, `push` |
| [workers2/magi-link/worker.js](../workers2/magi-link/worker.js) | Tunnel address book keyed by token hash |

### Docs

- [magi.md](magi.md) sections:
  - "Profiles — two people, two MAGIs", including "The gate", "The engine
    side", "More than one engine" and "`magi onboard`"
  - "Coding agents and the fallback chain"
  - "GitHub: accounts, push, and where the token lives"
  - "Models, usage credits, Auto, and your caps"
  - "Who may drive the engine"
  - "The token"
  - "Accounts — which account each unit is signed in as"
  - "Two Claudes"
- [magi-plan.md](magi-plan.md) sections:
  - §3 Security Architecture, §4 Profiles and Engines data model, §5 Firebase
    Strategy
  - §7A Coding agents, accounts, fallback chain
  - Phases 1–4, 7, 10 and 11B
- [magi-setup.md](magi-setup.md) §2: the sign-ins a person does on a new PC.

### Tests that pin this behaviour

- **Engine**, under `magi/tests/`:
  - `test_profile_paths.py`: per-profile paths, distinct token names, the
    migration.
  - `test_gate.py`, `test_route_gate.py`: when the token is required.
  - `test_code_agents.py`: slots and the chain.
  - `test_code_usage_fetch.py`: usage reads.
  - `test_github_device.py`, `test_github_client.py`: device flow and token
    scrubbing.
- **Console**, under `tests/`:
  - `magi-profiles.test.js`: document paths, namespacing, no network before
    unlock.
  - `magi-engines.test.js`: one token per engine, spare ports matching
    `onboard.py`.
  - `magi-code-github.test.js`: the token sheet and push.
- **Live**, under `tests/live/`:
  - `magi-codex-login.live.js`
  - `magi-github-signin.live.js`
