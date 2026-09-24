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

**Except when the question is about the responder.** "Which model are you?",
"what would you prefer?", "how would *you* approach this?" — every member's
answer is correct for itself, there is no disagreement to resolve, and merging
means stating something false about the members you dropped. The chairman is
told to list one line per member for those, naming each; for everything else,
merging is exactly the job. `magi/tests/test_chairman_prompt.py` pins it.

Built by Veda; taken over on 2026-09-09 and reorganised as an A1 program. This
file replaces her `README.md`, `SETUP-FOR-TONY.md` and `magi-setup.md`.

---

## The one thing that makes MAGI different from every other A1 program

Every other program in this repo is a page. MAGI is a page **plus an engine on
this PC**, and the engine cannot move.

It talks to the models through **browser automation of your own logged-in
subscriptions**, not APIs — one real Chrome profile per unit, each holding a
live session.
Those profiles cannot leave the machine, so:

| | |
|---|---|
| `magi.html` | the console. Static, at the A1 root, served from GitHub Pages like every other page. |
| `magi/` | the engine. Python + Playwright, runs on this PC only. |
| `workers2/magi-link/` | one KV record saying where the engine currently is. |

**This is against those services' terms of use**, which prohibit automated
access. You are running it on your own accounts at your own risk.

---

## Profiles — two people, two MAGIs

Tony and Veda each get their own MAGI: their own AI accounts, their own
history, their own settings, their own password. It is the same split
`index.html` has had for its TaskHubs, built the same way and sharing its
colours, so the two programs read as one product.

**A profile is a document path plus a set of credentials, not an identity.**
Firebase auth stays a single anonymous session for the whole suite — nothing
about `firestore.rules`, App Check or sign-in changed. What changes is which
document the console reads and which `localStorage` namespace it writes:

```
dashboards/magi              Tony        localStorage  magi.tony.*
dashboards/magi_veda         Veda        localStorage  magi.veda.*
```

Tony keeps `dashboards/magi`, which is where every deliberation he has ever
run already lives. **There is no history migration in this change and there
must never need to be one.** His `localStorage` keys were bare `magi.*` before
profiles existed, and those are carried into `magi.tony.*` on first load —
*copied*, not moved, so an older build of the page left open in another tab
keeps working. The copy marks itself done, so a key you delete on purpose
afterwards does not come back.

Both documents sit under the existing `/dashboards/{doc=**}` rule.

### The gate

The profile picker and the app lock used to be two separate ideas. They are
one screen now, because keeping them apart is two chances to get the ordering
wrong — and the ordering is the security property. The card you pick expands
in place into its password field rather than handing you to a second screen.

The profile you last used arrives expanded; the other sits collapsed beside
it, one tap away. Choosing it **reloads the page**. That is deliberate: every
per-profile key constant is evaluated once, at load, so a switch that merely
reassigned the current profile would leave a dozen constants and one live
Firestore listener pointing at the person who just left — and Firestore's
persistent cache means a document read once stays on the device.

### The lock now actually guards something

It used to say so itself: *"this lock has one job: stop someone at your laptop
reading the transcripts or spending your model quota"*, while the sync
listener attached at boot regardless. That was fine when there was one person.
With two it is not, so three things changed:

- **Nothing is fetched before unlock.** `cloudInit()` refuses while the
  profile is locked, so a locked profile's document is never read and never
  lands in the IndexedDB cache.
- **The engine is not contacted before unlock.** `tryReconnect()` refuses too
  — `pageshow` fires on every load, so without that guard a locked console
  probed `127.0.0.1` for the engine before anyone had proved who they were.
- **Discovery and sync start on the unlock**, in `openUp()`, rather than
  beside the gate. The cost is the second or so it now takes after unlocking;
  on a trusted device, which is the usual case, the unlock itself is instant.

Each profile has its own password record (`jlock:applock:tony_magi` /
`veda_magi` on the same worker) and its own biometric credential. Unlocking
one never unlocks the other. Tony's entry id is unchanged from before profiles
existed, which is why his password and his fingerprint both survived this
change untouched.

**Device-shaped settings stay shared** — mute, sidebar collapsed, device id.
Muting MAGI should not un-mute itself because you switched profile.

`tests/magi-profiles.test.js` pins the document paths, the namespacing, the
two network guards and the absence of native dialogs. The end-to-end
behaviour — the gate painting, unlocking, switching, the migration — is proved
in a real browser over CDP; see `.claude/skills/verify` for the recipe.

### The engine side

An engine serves exactly one person, because the credentials *are* the profile
and they live in directories on disk:

```
magi/profiles/<profile>/<site>/   the logged-in Chrome sessions
magi/data/<profile>/magi.db       that person's run history
magi/data/<profile>/engine.json   this engine's stable id, label and port
magi/artifacts/<profile>/         failure screenshots
```

`--profile` on any command, then `MAGI_PROFILE`, then `profile:` in
`config/magi.yaml`, then `tony`. The flag has to win: two engines on one
machine share one checkout and therefore one `magi.yaml`, so if the file had
the last word they could never differ. **One PC can host both at once**, which
is how the second profile was built and proven before a second machine existed:

```
magi serve                              # tony, port 8000
magi serve --profile veda --port 8001   # veda, port 8001
```

Each gets its own scheduled tasks (Tony keeps the unsuffixed `MAGI Engine` and
`MAGI Watchdog` names his are already registered under), its own tunnel record,
and **its own API token** — `MAGI_API_TOKEN` for Tony, `MAGI_API_TOKEN_VEDA`
for Veda. They must differ: `magi-link` keys its records by the hash of the
token, so a shared one would mean two engines fighting over a single record,
and either person's console reaching the other's engine and its signed-in
accounts. `/api/health` reports the profile, and **the console refuses to talk
to an engine belonging to anyone else** — it says whose it is rather than
failing as "offline", because the fix is switching profile and nothing about
"offline" would suggest that.

### More than one engine

A profile can have an engine on more than one machine — a desktop and a
laptop, say. The console keeps a small registry and tries each in turn.

An engine identifies itself: `magi/data/<profile>/engine.json` holds a stable
id, a label you can edit, and the port, and `/api/health` reports all three.
That id is **not** `instance`, which is fresh per process — exactly right for
tunnel adoption, and exactly wrong for "is this the same laptop as yesterday?",
which would grow a new row in the picker on every reboot.

**The console learns an engine by connecting to it.** Nothing is configured:
the first time one answers, its id, label and port are recorded. The only
thing you ever type is another machine's access key, because that is the one
fact the console cannot discover for itself. The registry entry that existed
before any of this — a single token in a single key — is absorbed rather than
duplicated, so an upgrade does not leave two rows for one PC.

Discovery runs the same three steps it always did (same origin, loopback, then
the tunnel) **once per engine**, active one first, stopping at the first that
answers. One engine costs exactly what it did before: the loop runs once. The
second pass only happens when the machine you usually use is asleep, which is
precisely when you want the laptop tried rather than being told MAGI is
offline.

The picker stays hidden until there is more than one engine, and shows
reachability from what the last connection attempt found — opening the panel
does not wake four machines.

The registry rides the **same document that already has a listener**, as one
`engines` field, so a laptop added at the desk reaches the phone for zero extra
reads and no second listener. `lastSeen` is deliberately *not* synced: it is
what **this** device last managed to reach, and syncing it would have a phone
claim the laptop is up because the desktop could see it a minute ago.

### `magi onboard`

One idempotent command takes a machine from a fresh clone to a working engine:
directories, a generated API token, a free port, a stable engine identity,
Playwright's Chromium, and the scheduled tasks. What is left is the part only a
person can do — signing in to each site, and typing the token into the console
once.

```
magi onboard --profile veda
```

Re-running repairs what is missing and leaves the rest alone. It never
regenerates a token that already works, because that would silently orphan
every device already paired with it, and it recognises its own engine on a busy
port rather than shunting it onto a new one.

### The migration, and what it cost

The pre-profile layout moves under `tony/` on first run. It **renames** rather
than copies: `profiles/` is over a gigabyte of Chrome session data, so a copy
would double it on disk, while a directory rename within one volume is atomic
and instantly reversible.

The first version wrapped the whole migration in one `try`. `cloudflared`
survives a restart by design and holds its log file open the entire time, so
the rename of `cloudflared.log` raised `PermissionError` — and that single
exception ended the loop before `magi.db` had moved. The engine then came up
pointing at the new path, found nothing, and created an **empty** database
beside the full one. Fifty-seven deliberations were still on disk, but MAGI
showed none of them.

So: the guard is **per item**, live logs are **never moved** (they are
append-only scratch, recreated wherever the new engine points, and the files
most likely to be locked), and the database moves **first**. Pinned by
`magi/tests/test_profile_paths.py`, which also covers the case that would have
been worse — a half-migrated tree whose moved sessions get clobbered by the
stale copies still sitting at the old level, signing every account out at once.

---

## Code Mode

> Code Mode is being built in phases, one session each. The living plan and
> the hand-off between sessions is **[docs/magi-plan.md](magi-plan.md)** —
> start at its §0.

The switch beside the prompt box changes what that box does.

| | |
|---|---|
| **Deliberate** | ask the council a question — everything above |
| **Code Mode** | hand the words to a coding agent working on a folder on the engine's machine |

**Mode is not a view.** The views — history, doctor, accounts, brainstorm —
are places you go and come back from; mode is what the main screen *is*.
Making it a view would have meant History had two versions and every nav
button had to know which mode it was returning to. It is per device and not
synced: which mode you left this browser in is a fact about the browser.

Code Mode replaces the council's controls with its own — the verdict, the
empty state and the caption step aside, and the council's unit chips are
swapped for the **agent chain** (below), which is a different choice about
different things. Convene becomes **Run**; Queue and Refine are **held and
relabelled**, not hidden, because a control that vanishes teaches you the
mode has fewer capabilities than it does. Run says why it is held —
no engine, no workspace, nothing ticked, or a task already running.

The status strip carries the five facts that change what a command will do —
whose MAGI this is, which machine will run it, which folder it will touch,
which repository that folder answers to, and whether finishing will commit
and push. Fields that do not exist yet are shown **empty rather than
omitted**, because a strip that hides them teaches a shape that is about to
change. It repaints when the engine's state changes: discovery finishes
after the first paint, so without that it sat on "offline" while the sidebar
three inches away said the engine was running on this PC.

**What exists today** (Phase 14): the mode, the workspace registry, the
agent chain, read tasks, write tasks you approve as a diff, local git, GitHub
(push, the Repository panel, the Actions watch), model choice and caps, auto
commit/push, and sync across devices. **A1 itself is still read-only** to
Code Mode: opening it to writes is the second half of Phase 14 and waits on
Tony. Who may drive the engine at all is at the end of this chapter
(*Who may drive the engine*).

`tests/magi-codemode.test.js` pins the split; the behaviour is proved in a
real browser over CDP.

### Workspaces

A **project** is the logical thing: "A1". A **binding** is where that project
lives on one machine. They are separate records because they have different
lifetimes: the project follows you between devices, the binding describes one
engine and never leaves it.

The path is the whole reason for the split. `C:/Users/antho/Desktop/A1` is
true at the desk and meaningless on a phone, so syncing it would put a value
in front of you that cannot be acted on and looks like it can. What another
device gets instead is *"A1 has a binding on Tony PC"* — enough to say where
the work can run. A project can also exist with **no** binding, which is how
you set one up for a laptop you are not sitting at.

```
GET  /api/code/state                      everything the console paints from
GET  /api/code/browse?path=…              directory NAMES, one level
POST /api/code/projects                   register, optionally bind
POST /api/code/projects/{id}/bind         point it at a folder on this machine
GET  /api/code/projects/{id}/skeleton     its shape, cached
POST /api/code/resolve                    "work on A1" -> which project
```

Registering, binding and browsing never write into a project or run a
command.

#### Choosing a folder

`/api/code/browse` lists directory **names**, one level, never contents. A
browser cannot enumerate a remote filesystem and MAGI does not use the native
file picker, so this is how a folder gets chosen — and it is the only shape
that also works from a phone. Repositories are flagged, because "which of
these is the project?" is nearly always answered by "the one that is a repo".

#### What gets refused, and why

A workspace that was never registered cannot be worked in, so the cheap
refusal happens here rather than later under load. A drive root (`C:/` — the
one slip where "delete the build output" could mean the disk), a system
folder, and **MAGI's own engine directory** (an agent editing the engine it
is running inside is a class of problem best not opened). Each refusal names
its cause: "invalid path" sends you to check the spelling of a path that is
spelled correctly.

This is not the containment. That is the sandbox copy every write task runs
in and `security.review` of its diff (*Write mode*, below).

#### The fingerprint

A project's shape is cached so no task re-walks a tree to find out what it is
looking at. The cache key is **two git calls** — `rev-parse HEAD` plus a hash
of `ls-files -s` — not a filesystem walk, so checking whether the cache is
still good costs far less than rebuilding it.

It deliberately does **not** move when you edit a file. The skeleton caches
the project's *shape*, and editing one file does not change the shape; if an
edit invalidated it, the cache would be rebuilt on every keystroke and buy
nothing. Adding, staging or committing does move it. A folder that is not a
repository falls back to a hash of its top level, which is still O(1) in the
depth of the tree.

The tree itself skips `node_modules`, `.git`, `dist` and friends, and is
capped at 600 entries — a cap that reports `truncated: true` rather than one
that is a suggestion. A project with 50,000 files should produce a listing
nobody has to apologise for.

`magi/tests/test_code_workspace.py` pins all of it, including that every
refusal carries a sentence and that the fingerprint moves on exactly the
changes it should.

### Coding agents and the fallback chain

**Any unit can code.** That is the rule, so a task does not stop because one
provider's allowance ran out. There are two kinds of agent behind one
interface (`magi/code/agents/base.py`), and no third kind that bills:

| Kind | Who | How it sees the folder | Cost |
|---|---|---|---|
| **CLI** | Claude (Claude Code CLI), Codex (Codex CLI) | runs its own tool loop: search, read | the signed-in account's plan |
| **Browser** | every enabled council unit | MAGI gathers the relevant files (`context.py`) and asks through the unit's session | the same sessions the council uses |

**No API key is used, anywhere.** Both CLIs run with `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `CODEX_API_KEY` and friends *removed* from their
environment, so a key that happens to be set on the machine cannot quietly
turn a free task into a billed one. Claude signs in with `--claudeai` (the
subscription), never `--console` (API billing). Codex works on a **free**
ChatGPT account, inside its one 30-day window (Plus has 5 h + weekly).

**Accounts are slots.** Each CLI agent keeps each login in its own folder —
`magi/profiles/<profile>/cli/<agent>-<slot>/`, pointed at by
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` — the way each browser unit has its own
Chrome profile. So Codex is **not** tied to the ChatGPT unit's account: any
ChatGPT account can be signed in to a Codex slot. Claude also has a `system`
slot, which is this PC's own Claude Code login and cannot be removed from
MAGI. More than one slot per agent is what lets the chain move to a fresh
*account* before it moves to a weaker *model*.

Each slot can be **renamed** — the slot name is a folder name (lowercase, no
spaces, fixed once a login is in it); the label is what you actually read,
and it is what the chips and the transcript say once you set one. Renaming
never touches the login. Labels live in
`magi/profiles/<profile>/cli/labels.json`.

**Usage is shown before the wall, not after, and it is current.** Every
`/api/code/agents` and `/api/code/usage` asks each provider directly
(`magi/code/agents/usage_fetch.py`) — the same read the CLIs make for their
own `/usage` and `/status` screens:

| Agent | Read | Windows |
|---|---|---|
| Claude | `GET api.anthropic.com/api/oauth/usage` with the slot's own OAuth token | `five_hour`, `seven_day` → `5h 22% · 7d 82%` |
| Codex | `GET chatgpt.com/backend-api/wham/usage` with the slot's own token | free: one 30-day window; Plus: 5h + weekly |

No model call and nothing billed. The token is read from the slot's login
file and goes only to the provider that issued it. **MAGI never refreshes a
token:** both providers rotate refresh tokens, and a second refresher racing
the CLI can sign the CLI out. An expired token means "skip this read"; the
CLI renews it on its next run. Reads are throttled to one per slot per
minute. When the provider says there is room, a remembered limit is cleared.

Before this, the numbers came only from the last task (Claude's
`rate_limit_event`, Codex's session rollout), so a `5h used 90%` from the
night before stayed on the card the next morning on an account that had
reset. Those sources are still used as fallbacks, and **a window whose reset
time has passed reads 0%**, both on the engine (`limits.aged`) and in the
console (`usageLive`), so a stale figure can never outlive its window.

Signing in is in **Accounts → Coding agents**, hand-drawn like everything
else. Codex uses its device-code flow: the sheet shows OpenAI's URL and a
one-time code, which can be entered **from any device, the phone included**,
with a warning never to enter a code someone sent you. Claude's sign-in page
opens on the engine machine. Either way MAGI never sees a password; it only
watches the slot report signed in.

Both CLIs run **locked down**: `--ignore-user-config --ignore-rules` and
`--sandbox read-only` for Codex, with its off-machine features (`browser_use`,
`computer_use`, `apps`, `plugins`, `multi_agent`, `hooks`, …) disabled in
every mode; `--restricted --strict-mcp-config`, a fixed read-only tool list
and `--permission-mode plan` for Claude, plus
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` in read mode, so nothing an agent runs
can read the credentials it is running on. A hostile `AGENTS.md`, rules file
or `.claude/` in a target repository does not reconfigure the agent. Write
mode's flags are below.

#### The chain

The unit chips in Code Mode are the chain. Default order, highest first —
Claude and Codex lead because they are the strongest coders and the only two
that drive their own tools:

```
Claude CLI (each signed-in slot) -> Codex CLI (each slot) -> Claude (Pro)
  -> ChatGPT -> Claude (free) -> Gemini -> DeepSeek -> Grok -> Perplexity
```

Tap **Agents** to reorder (arrows, not drag, so it works one-handed). The
ticks and order are this browser's own (`magi.<profile>.code.units`,
`code.order`), separate from the council's unit picks — you may well want
Grok on the council and not on your code.

**Pull before you work.** A1 is edited by two people on different machines,
so work begun against a stale tree is work that gets redone. Every task in a
repository with a remote starts with `git pull --rebase --autostash` and says
in the transcript what came down; a tree it cannot pull cleanly stops the
task rather than starting quietly on stale files. A1 is only fetched (*Git*,
below).

**What hands a task on:** only a failure another agent could fix — a usage
limit, a signed-out account, a missing or crashed CLI. **Not** a task
failure: if the agent read everything and could not answer, another author
would fail the same way. The next agent is told what the previous one had
worked out and to continue, not start over.

**Limits are remembered** (`magi/data/<profile>/agent_limits.json`). A limit
with a reset time — Claude's `rate_limit_event`, Codex's "try again in 2
hours" — makes the chain skip that slot until then, instead of walking into
the same wall on every task. **Clear limit** in Accounts overrides it.

#### Running a task

```
GET    /api/code/agents                        slots, who they are, usage, limits
POST   /api/code/agents/{agent}/slots/{slot}/login   start a sign-in
GET    /api/code/login/{job}                   poll it
POST   /api/code/tasks                         {project_id, prompt, agents:[...], mode:"read"|"write"}
GET    /api/code/tasks/{id}/stream             SSE, replayed from the start
POST   /api/code/tasks/{id}/approve            {approve: true|false} -- write mode
POST   /api/code/tasks/{id}/cancel             Halt
GET    /api/code/usage                         usage + limits, no CLI processes
```

A task keeps every event and gives **each viewer its own queue**, unlike a
council run: the desk and the phone can watch the same task, and a reload
replays the whole transcript (the console remembers the watched task per tab
in `sessionStorage`). Tasks live in memory; an engine restart ends them and
the console says so rather than showing one busy forever, and `/api/restart`
refuses while one is running. **Nothing about a running task is written to
Firestore**; when it ends, one row and one body document are (*Code Mode
across your devices*, below).

`magi/tests/test_code_agents.py` pins the parsers against recorded event
streams, the chain's hand-off rules, the environment scrubbing and the slot
layout; `tests/magi-codemode.test.js` pins the console side.

#### Write mode: edits you approve as a diff

**Agents never write to your folder.** A write task runs in a throwaway copy.
MAGI diffs the copy, you approve the diff, and only then does MAGI apply it.

```
your folder ──git stash create──► worktree in %TEMP%\magi-sandbox\<profile>\<task>
                                     │  agents edit freely here
                                     ▼
                              diff (two git trees) ──► security.review ──► approval card
                                     │                                   (5 min; silence = No)
                           Approve ──┘   Deny / timeout / Halt → discarded
                                     ▼
                     applied onto your folder (never staged, never committed)
```

- **The copy starts from your disk, not from HEAD.** `git stash create`
  commits the working tree without touching it or the stash list, so
  uncommitted edits are included. Untracked, non-ignored files are copied in
  (secrets among them are not). The baseline is recorded as a git *tree*
  (`add -A` + `write-tree`), not a commit: no hooks, no author, nothing on any
  branch, and the copied files never show up as the agent's additions.
- **Hooks never run.** Every sandbox git call passes an empty
  `core.hooksPath`; a worktree shares the real repo's hooks.
- **One gate for every agent.** Claude CLI runs with
  `--permission-mode acceptEdits --tools Read,Glob,Grep,Edit,Write` (no
  Bash). `--restricted` confines its file tools to the copy; tested live, a
  write to the home folder comes back as a `permission_denied` event, which
  the transcript shows. The env scrub is **dropped in write mode**: found
  live, it makes acceptEdits refuse every edit as "not granted", and write
  mode has no shell for it to protect. Codex runs with
  `--sandbox workspace-write` plus `windows.sandbox=unelevated` (without it,
  workspace-write is silently read-only on Windows), temp-dir exemptions off
  and network off. Tested live: a write to `%USERPROFILE%` or `%TEMP%` is
  denied. Codex keeps its shell, because that is how it reads files, but only
  inside that OS sandbox -- and **that sandbox does not keep it off
  127.0.0.1** (found in Phase 14: `network_access=false` is not enforced on
  loopback, in read or write mode). The engine refuses it instead; see *Who
  may drive the engine*. Browser units answer in a fixed format
  (`magi/code/agents/edits.py`): one fenced code block per change, holding
  `FILE:` + `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`. It has to be
  fenced because MAGI reads the reply from the rendered page, and outside a
  code block markdown eats the markers and the line breaks. MAGI applies
  those edits into the copy all-or-nothing, checking every path first.
- **`security.review` runs before you are asked.** Paths are checked on both
  sides of every diff header: no `..`, nothing absolute, no `:` streams, no
  Windows device names. Checked against the *real* folder, no path may pass
  through a link that points outside. The deny-list is `.git/`, `.ssh/`,
  `.gnupg/`, `.aws/`, `.azure/`, `.claude/`, `.codex/` (a planted hook there
  runs next task), and env, key and credential files. The deny-list is also
  asked about the name Windows actually opens: an **8.3 short name** is the
  same folder (`CLAUDE~1` is `.claude`, `GIT~1` is `.git`), and
  `CLAUDE~1/settings.json` passed every by-name rule until Phase 14. Symlinks
  and submodules are refused. Over 2 MB or 300 files is refused with a
  sentence, never truncated. **One bad file refuses the whole diff**, and
  you are not asked. The review runs **again at approval**, against the
  folder as it is then: the card can wait five minutes, and a junction made
  meanwhile must not carry an approved path elsewhere (a `refused` event,
  nothing written).
- **Approval** is an `approval` event on the stream: per-file diffs, `+/−`
  counts and a deadline. Any device watching the task can answer, and the
  first answer wins (`tasks.decide`). Only an explicit `true` approves.
  No answer within 5 minutes, or Halt, is a No.
- **Apply** tries `git apply`, all or nothing. If you edited the same file
  meanwhile, each file is three-way merged (`git merge-file`) against the
  tree the agent was given. A real conflict applies **nothing** and keeps the
  patch at `magi/data/<profile>/code-patches/<task>.patch`.
- **Hand-offs continue in the same copy.** When Claude runs out mid-task,
  Codex works in the same worktree and is told which files already changed.
- **Nothing outlives the task.** The copy is removed in a `finally`, and a
  marker file lets engine startup sweep any copy left by a crash.
- **Refused for now:** a folder that is not a git repository (with a
  sentence saying to `git init`), a repository with no commits, and **A1
  itself**, MAGI's own repository. Both the engine (`read_only_project`) and
  the console (Write greyed out with the reason) refuse A1 until Tony opens
  it (the second half of Phase 14).

In the console, **Read / Write** sits under the agent chips. Every task
starts in Read, and the switch falls back to Read once a task starts, so
Write is never left on from yesterday. The Run button says **Run edits**
when Write is on. The approval card lists each file with a status and `+/−`
counts; each file opens to its tinted diff, and open files stay open across
redraws. The countdown ticks without redrawing the view. On a phone, Deny and
Approve are full-width 46px buttons.

Tests: `magi/tests/test_code_security.py` (written first),
`test_code_sandbox.py` (temp repos: uncommitted and untracked files, hooks,
sweep, clean, merged and conflicting apply, CRLF), `test_code_write.py` (edit
format, flags, and the task runner with fake agents: approve, deny, timeout,
Halt, refused, a hand-off in the same copy), `tests/magi-code-approval.test.js`
(console), and `tests/live/magi-write.live.js` (a real scratch repo with
Claude, Codex and ChatGPT; `LIVE_ONLY=` and `LIVE_TIMEOUT=1` pick sections).

#### Git: pull before work, the repository line, commit

**MAGI performs git itself; agents never get git.** They edit a sandbox and
hand back a diff. Every operation on the real repository lives in
`magi/code/git.py`, so no agent (CLI or browser) needs a git binary, a shell
or a credential, and that file is the complete list of things that can move
your branch.

```
task starts ─► git pull --rebase --autostash ─► (write) sandbox ─► agents ─► diff
                 │ no remote / no upstream / detached: skipped, said
                 │ clash: rebase --abort, task stops, no agent runs
                 ▼
            approve ─► apply ─► [Commit these files] ─► git commit --only -- <applied>
                                                        (your hooks run; never pushed)
```

- **Pull first, every task** (read tasks too — an answer about stale code is
  a wrong answer). It is the transcript's first line: "Pulled 3 commits from
  origin/main." / "Up to date with origin/main." / "No remote — nothing to
  pull." Uncommitted edits survive through `--autostash`. A pull that clashes
  with your local commits is **undone** (`git rebase --abort`, which also
  restores the autostash), the folder is exactly as it was, and the task ends
  `pull_failed` naming the files — before any agent starts. A pull that
  succeeds but whose autostash will not re-apply also stops the task, since
  your edits are then in `git stash`, not in the folder.
- **A1 is fetched, never pulled.** Its working tree is shared with running
  Claude Code sessions and its own auto-commit hook; a rebase under them is
  worse than a stale answer. The transcript says how far behind it is.
- **Nothing waits for a password.** Every git call runs with
  `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `ssh -o BatchMode=yes`
  and no editor. The engine has no terminal; a prompt would hang the task.
  Pull/fetch time out after 120 s.
- **One git writer per repository** (`git.lock`), so a pull and a commit
  never race for `index.lock`.
- **Commit is a second press.** After an apply, the card offers **Commit these
  files**. The engine stages **exactly the applied paths** — `check_paths`
  refuses `.`, `*`, pathspec magic, `..`, absolute paths and `.git/`, and
  runs with `--literal-pathspecs`; there is no `add -A` anywhere — then
  `git commit --only -- <paths>`, so anything else you had staged stays
  staged and out of the commit. The repository's **own hooks run** (only the
  sandbox turns hooks off). If the commit fails (a hook says no, no
  `user.name`), the index is restored exactly (`read-tree` of the tree saved
  first). A merge or rebase in progress refuses. Once per task
  (`already`), and only for a task whose change was applied (`not_applied`).
  Nothing is pushed until you press **Push** (below).
- **The draft message**: subject from what you asked (the intent, already a
  short sentence; capitalised, ≤72 chars), body from the agent's summary
  with code blocks removed. Edited in a hand-built field; Ctrl+Enter
  commits. The view redraws once a minute, and a message being typed keeps
  its focus and caret across it.
- **The repository line** under the workspace: branch (or "detached at …"),
  `↑ahead ↓behind` against the upstream as of the last fetch, "N
  uncommitted" or "clean", conflicts, a merge/rebase in progress, and "fetched
  4m ago" / "never fetched". One `GET /api/code/projects/{id}/git`, local git
  only; read on entering Code Mode, on switching workspace, after a task and
  after a commit — **never on a timer**.

Routes: `GET /api/code/projects/{id}/git`, `POST /api/code/tasks/{id}/commit
{message}`. Events: `pull {ok, skipped, commits, text, conflicts}`,
`applied {…, draft}`, `committed {sha, short, subject, files}`.

Tests: `magi/tests/test_code_git.py` (porcelain v2 parsing of every record
kind incl. renames with scores, unmerged, spaces and unicode; ahead/behind
against a real bare remote; no upstream; detached; staging refuses anything
but plain paths and never uses `add -A`; commit takes exactly the named
paths, leaves your staged changes out, runs hooks, restores the index when a
hook refuses; pull brings commits, keeps edits, rebases local commits, undoes
a clash; unreachable remote fails with a reason), the Phase 9 section of
`test_code_write.py` (task pulls before the agent looks, a clash stops before
any agent, A1 fetched only, commit after apply, a denied change cannot be
committed), `tests/magi-code-git.test.js` (console), and
`tests/live/magi-git.live.js` (bare origin + a second clone in `%TEMP%`: pull,
real Claude edit, commit from desktop and from 390px, clash, A1 fetch-only).

#### GitHub: accounts, push, and where the token lives

**A token goes in once and never comes out.** Accounts › GitHub › *Add a
token* takes a GitHub token in a masked field MAGI draws itself. The engine
checks it with GitHub (`GET /user`), then stores it in the **PC's credential
store** (Windows Credential Manager, via `keyring`) under
`magi-github:<profile>:<login>`. What is kept beside it, in
`magi/data/<profile>/github/accounts.json`, is only the public half: login,
name, token kind, scopes (classic tokens), expiry, when added. No response,
log line, error, SQLite row or Firestore field carries the token — the tests
feed a sentinel token through every path and grep for it. Use a
**fine-grained token** listing just the repositories MAGI should reach:
*Contents: Read-only* to look, *Read and write* to push.

```
Push (card or line) ─► git fetch ─► behind? refuse ─► git push <remote> refs/heads/B:refs/heads/B
      │  -c credential.helper=   (GCM and every other helper cleared)
      │  -c http.sslVerify=true  (a repo's own sslVerify=false cannot expose the token)
      │  GIT_ASKPASS=data/<p>/github/askpass.sh ─► pythonw magi/github/askpass.py
      │        answers ONLY for the account's host, reads the token from the
      │        credential store at that moment, prints it to git's pipe
      ▼
  GitHub
```

- **Which account.** Each project names one GitHub login (`prefs.github`),
  chosen in the GitHub sheet: from the Repository panel's header on a
  github.com remote (the pill opens the panel since Phase 11), from
  **Choose account to push** on the repository line when none is set, or
  from the pill itself on any other host (`owner/repo`, parsed from the
  remote URL with any userinfo stripped). The sheet says whether that
  account can see the repository (`GET /repos/{o}/{r}`) and whether it may
  push — asked of **git**, not REST (`git.can_push`: `git push --dry-run` to a
  never-created ref, hooks skipped; GitHub serves the receive-pack
  advertisement only to a credential with write access, and nothing is
  sent). REST's `permissions.push` is the *owner's* role: a read-only
  fine-grained token on your own repo reports `push: true` (found live), so
  it is returned as `role_push` and never shown as the token's permission. The same account is used for the task's pull/fetch
  when the remote is on github.com.
- **Push is a third press.** After Commit, the card offers **Push**; whenever
  the branch is ahead, the repository line offers **Push ↑n**. Never forced:
  the refspec is spelled out with no `+`, a fetch first refuses when the
  remote has commits you do not ("Pull first"), and git's own
  non-fast-forward check catches a race. Refused mid-merge/rebase, detached,
  with no commits, or with a password written into the remote URL.
- **An HTTPS remote with no account is not pushed at all** (`no_account`) —
  it never goes out as whatever login Git Credential Manager remembers. A
  token is only offered to the host that issued it (`wrong_host`, and
  askpass itself refuses any other host, and plain http except loopback).
  Local-path and SSH remotes push with the machine's own access.
- **A1 is never pushed from Code Mode** (`read_only_project`) until Tony opens
  it (the second half of Phase 14).
- Failures are sentences: `behind`, `auth_refused` (needs Contents: Read and
  write, or expired), `not_found` (a fine-grained token only sees the repos you
  picked), `protected`, `hook` (your pre-push hook said no).
- **REST client** (`magi/github/client.py`): `X-GitHub-Api-Version:
  2026-03-10` on every request, ETags remembered per account and sent back as
  `If-None-Match` (a 304 costs none of the 5,000/h), `Link: rel="next"`
  pagination (never followed to another host), `x-ratelimit-*` recorded per
  account and shown in Accounts, typed errors (`bad_token`, `forbidden`,
  `not_found`, `rate_limited` with its reset time, `invalid`, `bad_version`,
  `unavailable`, `network`).
- Removing an account deletes the credential and its record; the token keeps
  working on GitHub until you revoke it there.

Routes: `GET/POST /api/code/github/accounts` (`{token}` in, public record
out), `DELETE /api/code/github/accounts/{login}`,
`GET /api/code/github/accounts/{login}/repos`,
`GET/POST /api/code/projects/{id}/github` (`{account}`),
`POST /api/code/projects/{id}/push`, `POST /api/code/tasks/{id}/push`.
Event: `pushed {ok, code, text, commits, remote, branch, repo, old, new, by}`.
The repository line's `git.github = {remote, host, owner, repo, url, scheme}`.

Tests: `magi/tests/test_github_client.py` (mocked transport: version header,
ETag/304, per-account cache, pagination + max pages + foreign-host refusal,
rate limits incl. secondary, every status → kind, the sentinel-token grep over
errors, tracebacks, reprs, logs and caches; the account store with a fake
keyring; askpass host rules; the routes), `magi/tests/test_github_push.py`
(remote URL parsing; pushes to a bare remote; behind, forcing config, the
fetch-then-push race, new branch, detached, mid-merge; HTTPS rules; and a
**real smart-HTTP server** (`git http-backend` behind Basic auth) with the
**real credential store**: the token reaches the server and appears in no
argv, env, `.git` file or result), the Phase 10 section of
`test_code_write.py`, `tests/magi-code-github.test.js` (console), and
`tests/live/magi-github.live.js` (add-token sheet against real GitHub, Push ↑n,
a real Claude edit pushed from the card at 390px, and an injected account
whose push reaches GitHub through askpass and is refused in words).

#### The Repository panel, the Actions watch, and GitHub tools for Claude (Phase 11)

**Read-only, per project, as the project's GitHub account.** On a folder whose
remote is on github.com, the **Repository** pill opens a tabbed panel —
Overview, Branches, Commits, Pull requests, Issues, Actions, Releases — a
bottom sheet on a phone. Each tab is fetched when opened and never on a timer;
every read is a conditional request (`client.py` ETags), so asking again
costs none of the 5,000/h until something changed (verified live: repeat
reads leave `x-ratelimit-used` where it was). The account is one tap further,
in the panel's header. Nothing in it writes — to GitHub or to the folder.

- `magi/github/repos.py` — repository info, branches, commits for a ref,
  `compare base...head`, releases. `pulls.py` — PRs (merged shown as merged)
  and one PR with the **checks** on its head commit: check runs and the older
  commit statuses folded into one verdict (`failure` / `pending` / `success`
  / `none`); a token without Checks access still gets the statuses.
  `issues.py` — issues **without** PRs (GitHub's `/issues` returns both), one
  issue with its latest 30 comments. `actions.py` — runs (for a SHA or a
  branch), jobs, and the failing job's step and **log tail**.
- **Logs** are a 302 to a short-lived signed URL on another host.
  `client.get_raw` follows it **without** the Authorization header (the URL is
  its own credential), only to https, one hop, never back to the API; the
  last 256 KB are read, timestamps and colour codes stripped, `##[group]`
  made readable, and any early `##[error]` line kept ahead of the last 80.
- **Found live:** `actions/runs?branch=main` on A1 (4,000+ runs) answered with
  runs from four weeks earlier — a different slice per page size — while the
  same query plus `exclude_pull_requests=true` came back newest first. Branch
  queries always send it.
- Local branches come from one `git for-each-ref` (`git.branches`: upstream,
  ↑↓ as of the last fetch, `gone`), merged with GitHub's list.

**The Actions watch.** After a successful push (the card or the line) the
console follows the pushed commit (`Push.sha`, the full SHA) with
`GET /projects/{id}/repo/actions?sha=` every 20 s — only while a run is
queued or running, or for up to 4 min while none has appeared, never past an
hour, skipping reads while the tab is hidden. The line under the repository
(and the task card, for a card push) says `n of m done`, then passed or
failed; a failure fetches `/repo/actions/{run}` once and names the **job ›
step**, with **Log** (the tail) and **Diagnose** — a *Read* task whose prompt
carries the tail. A1's pushes come from its own hook, so for A1 the panel's
Overview offers **Watch ‹sha›** for the branch tip.

**GitHub tools for the Claude CLI.** When a project names an account and its
remote is on github.com, each task writes `data/<p>/code/mcp/<task>.json` and
Claude gets `--mcp-config <file> --allowedTools mcp__magi_github`:
`github_overview`, `_branches`, `_commits`, `_issues`, `_issue`, `_pulls`,
`_pull`, `_actions_runs`, `_run_failure`. The server (`magi/github/mcp_server.py`,
stdlib only, run `pythonw -I`) answers each by a GET to the engine on
127.0.0.1 — the same routes the panel uses — so the agent can only ever read
what the panel shows, the project is fixed by MAGI's command line (no tool
argument names a repository), and **no token reaches the agent**. Verified
live: in `--permission-mode plan` with `--tools Read,Glob,Grep` the tools
connect and are callable; Claude read A1's failed Pages deploy and named the
cause. The file is deleted when the task ends. `--tools` still lists exactly
the built-in read tools.

Routes (all GET): `/api/code/projects/{id}/repo` (overview: info, local line,
tip commit, latest runs on the branch), `/repo/branches`, `/repo/commits?ref=`,
`/repo/pulls?state=`, `/repo/pulls/{n}`, `/repo/issues?state=`,
`/repo/issues/{n}`, `/repo/actions?sha=&branch=` (with `sha`, a `summary`
verdict), `/repo/actions/{run}` (jobs + `failed_job {name, step, log,
log_error}`), `/repo/releases`. Refusals: `no_account`, `not_github`,
`not_git`, and GitHub's kinds (`bad_token`, `forbidden`, …) in words.

Tests: `magi/tests/test_github_repo.py` (mocked GitHub: PRs excluded from
issues, merged PRs, checks folded and tolerant of 403, branch/compare/release
shapes, runs by SHA and 304 on repeat, `exclude_pull_requests` on branch
queries, the watch verdict, the failing job/step/log tail with the signed
URL fetched **without** the token, redirect refusals, 403 → "needs Actions:
Read-only", local branches against a real bare remote, the MCP server's
tools/refusals/stdio, the per-task config, Claude's argv, and the routes'
refusals with a sentinel token), `tests/magi-code-models.test.js` (console),
`tests/live/magi-repo.live.js` (every tab against the real A1, 304 on
repeat, the watch to a verdict, A1's real failed deploy named by job and
step with its log, 390 px bottom sheet; `LIVE_ONLY=diagnose` runs a real
diagnosis).

#### Models, usage credits, Auto, and your caps (Phase 11B)

**Which models an account can run is asked of the provider**, with the slot's
own sign-in — the reads the CLIs make for their own pickers
(`magi/code/agents/models.py`):

```
Claude  GET api.anthropic.com/v1/models       (OAuth bearer; lists the account's models)
        GET api.anthropic.com/api/oauth/profile  → plan: pro / max / team / free
Codex   GET chatgpt.com/backend-api/codex/models?client_version=<installed CLI>
        (only visibility "list"; falls back to $CODEX_HOME/models_cache.json)
```

Cached in `data/<p>/agent_models.json` for 6 h (a failed read is not retried
for 10 min, and the old list is kept). No model call, nothing billed. The
**Re-check** button re-reads now.

**Usage credits** come from the usage read that already runs every minute or
five (`usage_fetch.py`): Claude's `extra_usage {is_enabled,
spend_limit_reached}`, Codex's `credits {has_credits, unlimited,
overage_limit_reached}` and `plan_type`, stored per account
(`limits.note_account`, written only when it changed). So **turning credits
on is noticed within minutes, no restart**.

- **Verified live (2026-09-24):** Fable 5.1 on this Pro account with credits
  off → `rate_limit_event {status: rejected, errorCode: credits_required}`
  and "Fable 5.1 requires usage credits", nothing billed. Before this phase
  that event would have marked the whole account **limited until next
  week**; now `credits_required` (or those words) means *this model*, never
  the account.
- A model needs credits when its family is Fable/Mythos on a Pro/Free plan
  (seeded from the CLI's own wording), or when the provider refused it for
  credits on this account before (remembered in `gated`, cleared when it
  later runs with credits off). With credits off it is listed, disabled,
  with the reason; on → available ("on usage credits"); spent → disabled.
- A plan whose window is at 100% runs only on credits: with credits off the
  agent is skipped **before** a CLI starts ("Plan limit reached until …;
  usage credits are off"); with them on, the remembered limit is lifted
  (`usage_fetch.refresh` treats "limit reached + credits on" as allowed).
- If a task's model is refused for credits anyway (a plan MAGI has not seen),
  it is remembered — for the whole family, since credits are a family rule —
  and the task goes **once more on the same account** with the best model it
  can run, not handed to the next agent.
- **A model the account lists can still be too new for the installed Claude
  Code.** Found live: Opus 5.5 on 2.1.278 → "API Error: 400 … does not
  support this model; version 2.1.280 or newer is required" — which the chain
  used to treat as the task failing, stopping it. Now it is remembered
  (`cli_min`), the task retries once on the next-newest model of that family
  (Opus 5), and the sheet says "needs Claude Code 2.1.280 or newer — run
  `claude update`". The installed version is re-read every 10 minutes, so
  after an update the model is offered again with no restart. Auto takes the
  newest *available* model of the family it wants before dropping a family.

**Keeping the CLIs current** (`magi/code/agents/updates.py`). The install
MAGI runs is the one on PATH (`slots.cli_path`: the npm copies in
`%APPDATA%\npm`) — the Claude desktop app and the VS Code extension carry
their own, so updating those changes nothing here. Each agent's sheet ends
with a card: installed version (`--version`, re-read every 10 min or at once
after an update), latest (`npm view <pkg> version`, cached 6 h), the models
waiting on a newer one (`cli_min`), **Update now** and **Auto-update**
(`prefs.auto_update`, default on). Claude updates with its own `claude
update`; Codex with `npm install -g @openai/codex@latest`. Both run with the
engine's environment minus `DISABLE_AUTOUPDATER` (which MAGI's task runs
set). Refused while a Code Mode task or a sign-in is running; while a CLI is
being replaced its agent reports "being updated" and the chain uses the next.
The automatic updater (`auto_loop`, started in `app.lifespan`, never under
pytest or with `MAGI_NO_AUTO_UPDATE`) looks every 10 min, asks npm at most
every 6 h — at once when a model is waiting — and updates only when idle.
Logins live in the slot folders, so an update keeps every account signed in.
Routes: `GET /api/code/updates[?check=1]`, `POST /updates/{agent}`,
`POST /updates/auto {on}`; `/models` carries `agents[a].cli` and
`auto_update`. Tests: `magi/tests/test_code_updates.py`.

**Choice per agent** (`data/<p>/code_models.json`, per profile, on the engine
— the phone and the desk agree, and Veda's engine keeps hers): a model or
**Auto**, and an effort (Auto, low … max; Claude `--effort`, Codex
`-c model_reasoning_effort=…`, clamped to what the model supports). A chosen
model that cannot run now is replaced by Auto's pick with a note in the
transcript; every run's transcript names the model, effort and — for Auto —
why.

**Auto** (`classify` + `choose`): local rules, no network, milliseconds
(the preview endpoint answers in ~40 ms). Weight 1–4 from what the prompt
asks for (design/refactor/debugging/implement words, "think hard", a
question or small edit), its length, code or a stack trace, Write mode.
Claude: 1–2 → newest Sonnet, 3 → newest Opus, 4 → Fable when it can run,
else Opus; effort low/medium/high/xhigh. Codex: 3–4 → the highest-ranked
model (version, "balanced/frontier" vs "fast/affordable", "legacy"),
everyday work → the provider's own recommended model (head of its picker),
1 → its newest light model. When any window is over the warning line, weight
2–3 steps one lighter. The console shows Auto's pick for the composer's
text as you pause typing (`POST /models/preview`, debounced 350 ms).

**Caps** — "stop at 80% of the weekly limit": per agent, per window the
account reports (Claude: session `five_hour`, weekly `seven_day`; Codex: its
plan's windows — a free account has one `30d`, Plus `5h` and weekly). A
capped account (`cap_block`) is skipped by the chain with the reason until
that window resets or you change the cap; mid-task, Claude's own usage
events trip it at once and a 60 s re-read (`cap_watch`, only when a cap is
set) covers Codex — the CLI is stopped and the task handed on as `limited`,
**without** being remembered as a provider limit.

**Warnings**: `/usage` carries `alerts` (`warn` ≥ your line, default 80 %;
`near_cap` within 5 of a cap; `capped`; `limit`), each keyed by
agent/slot/window/**reset time**/level, so the console's corner popup shows
each once per window per reset (seen keys in localStorage, last 60). Warnings
fade after 12 s; stops stay until dismissed; **Limits** opens the sheet.

Routes: `GET /api/code/models[?refresh=1]`, `POST /models/choice {agent,
model, effort}`, `POST /models/cap {agent, window, percent|null}`,
`POST /models/warn {percent}`, `POST /models/preview {prompt, mode}`;
`/usage` adds `alerts, capped, credits, caps, warn_at`; `/agents` slots add
`capped`. Event: `model {agent, slot, model, label, effort, auto, why}`.

Tests: `magi/tests/test_code_models.py` (the real provider shapes: sort and
latest incl. Opus 5 vs 5.5, plans, Codex filtering; catalog cache and
failure back-off and the CLI-cache fallback; credits parsing; credits turned
on after a limit lifting it; Fable gated on Pro, open on Max or with credits,
exhausted credits, learned gating; Auto tiers, step-down, effort clamping,
choice fallback with its note; caps per window, reset, validation, the chain
skip; alerts; a scripted CLI proving the credits retry is not a limit, either
signal alone is enough, a mid-run cap stops the stream, Codex's `-m`/effort;
per-profile files), `tests/magi-code-models.test.js`,
`tests/live/magi-models.live.js` (real accounts: the row, Auto as you type,
the sheet, a real cap enforced on a real task, the popup, 390 px;
`LIVE_ONLY=run` a real task with Fable chosen and credits off,
`LIVE_ONLY=veda` a second engine on :8001 keeping its own settings).

#### Auto commit and auto push (Phase 12)

Two switches per project — **Auto commit** and **Auto push** — both **off by
default** and **always off for A1** (its Stop hook already commits `auto:`
and pushes; two systems staging one tree is how one silently absorbs the
other). Tap either strip pill to open them: auto push needs auto commit, and
the window is 1, 3 (default), 5 or 10 minutes (`prefs.batchWindowMin`,
clamped 1–30).

`magi/code/autocommit.py`, in memory like tasks:

1. A write task's diff is **applied** → `on_applied` reads the project's
   prefs *now* (a switch turned off mid-task is off) and schedules a pending
   commit of exactly `t.result.files`. The task stream carries an
   `autocommit {files, tasks, due, message}` event and the card hands the
   commit to the repository line instead of offering *Commit these files*.
2. Another applied task on the same project **folds in** (its files join,
   its ask joins the message) and **restarts** the window. One applied while
   a commit is in flight waits in the next pending commit. A write task still
   running on the project at the deadline postpones it 30 s — the follow-up
   will fold in.
3. At the deadline, `check` refuses — and the line says why — when the
   repository is mid-merge/rebase, HEAD is detached, one of the files is
   conflicted, or **something else is staged** (`--only` would keep it out,
   but staged work you did not mention means someone is in the middle of
   something). Those refusals keep the commit pending, untimed, for
   **Try again** / **Cancel**.
4. `git.commit` (explicit paths, `--only`, your hooks run) with
   `magi: <what you asked>` + what the agent said it did; several asks →
   `magi: <first> (+n more)` and each listed. Distinct from `auto:` and
   `auto: claude code`.
5. Auto push: `git.pull` (rebase + autostash) must come back clean, then
   `git.push` as the project's GitHub account — never forced; no account
   for an HTTPS remote → not pushed. A clashing pull is undone and the commit
   stays local, said on the line.
6. The outcome lands in `LAST` and `/projects/{id}/git` returns it as
   `auto.last`; the console starts the **Actions watch** on
   `auto.last.push.sha` — once per SHA, GitHub remotes only.

A manual *Commit these files* takes its task out of the pending commit
(`forget_task`). An engine restart drops a pending commit: the files stay
applied and uncommitted, as they were before the timer. MAGI makes every git
call itself; agents never get git or a token.

**Console**: the pills show on / off / `off · A1` / `in 2:40` / `blocked`;
the line shows `magi: commit of n files + push in 0:59 · Commit now ·
Cancel`, then the outcome (5 min if it went well, 30 min if not). Nothing
polls: the countdown rides the existing 1 s ticker, the line is re-read once
at zero, then every 3 s only while the engine says committing/pushing.

Routes: `POST /api/code/projects/{id}/auto {commit?, push?, window?}`
(refused for A1 with `read_only_project`), `POST …/auto/now` (also retries a
blocked one), `POST …/auto/cancel`; `GET …/git` adds `auto {commit, push,
window, locked, pending, last}`. `create_project` and `/prefs` pass through
`guard_prefs` too, so no stored pref turns it on for A1.

Tests: `magi/tests/test_code_autocommit.py` (real git + a bare remote:
defaults, clamp, A1 in the guard, on_applied and the route; the message; N
applies → one commit with the timer restarted; the real timer; only touched
files; hooks run; a running write task postpones; switched off before it
fires; cancel; hand commit; staged / merge / rebase / detached / nothing; push after a clean pull with the other machine's commit, a clash →
no push, push off, HTTPS with no account; wired into a real write task —
6 mutants checked), `tests/magi-autocommit.test.js`,
`tests/live/magi-autocommit.live.js` (a real Claude edit in a scratch repo:
switches from the sheet, countdown, a hand-staged file blocks it, Try again
commits + pulls + pushes, the watch once per SHA, 390 px, A1 locked), and
`tests/live/magi-autocommit-github.live.js` against **real GitHub** — the
throwaway private repo `anthonyn99/magi-push-test`: the window runs out while
another clone pushes, MAGI pulls that in and pushes on top as the account;
Commit now; Cancel; A1 refused (`LIVE_ONLY=noaccess,run`; `run` spends three
small tasks). Passed 2026-09-24.

The Actions watch stops at once — no four minutes of the same 403 — when
GitHub refuses in a way another try will not change (`WATCH_FINAL`:
forbidden, bad token, not found, no account), and says the fix: a
**private** repository needs **Actions: Read-only** on the token to watch
runs (a public one like A1 needs nothing).

#### Code Mode across your devices (Phase 13)

Projects, their switches, the agent chain and a one-line record of each
finished task follow you, in ONE `code` field on the profile's document
(`dashboards/magi` / `dashboards/magi_veda`) — the document the console
already listens to. **No second listener, no extra read on page load.**

```
code: { v, rev, updatedAt,
        projects: {id: {name, aliases, prefs, notes, updatedAt,
                        bindings: {engineId: {label}}}},   presence only
        deleted:  {id: deletedAt},                           tombstones, ≤ 200
        chain:    {order, picks, updatedAt},                 agent order + ticks
        tasks:    [{id, pid, project, prompt, outcome, by, write, at, device}] }  ≤ 25
dashboards/<doc>/code/{taskId}   one finished task's transcript, read only when opened
```

**What never syncs**: folder paths, GitHub tokens, CLI logins, a pending auto
commit, a running task's events — and 11B's model choices and caps, which
describe each PC's own CLIs (`magi/data/<p>/code_models.json` stays per
engine). The engine's `GET /api/code/sync` view (`magi/code/sync.py:view`)
is the only source of projects the console writes, and it has no path in it.

**Engine** (`magi/code/sync.py`, routes in `routes.py`):

* `code_meta` table: `rev` (bumped by every project/pref/binding change —
  not by opening a project) and `deleted` tombstones.
* `GET /api/code/sync` → `{rev, engine, projects, deleted}`; `/state` carries
  `rev` too.
* `PUT /api/code/sync {projects, deleted}` → per project, **newest
  `updatedAt` wins**; the winner is stored **with its own time**, so the next
  comparison is equal and nothing ping-pongs. A tie changes nothing. A
  deletion beats every copy older than it; a tombstone for a project never
  held here is kept so a stale copy cannot create it. Stray or mistyped prefs
  are dropped (`_PREF_TYPES`), and every pref passes through `_guarded` —
  **A1's auto commit stays off whatever a synced document says**. Binding a
  project that arrived from the cloud re-guards its prefs against the real
  folder.
* The document is written by browsers, so its shape is input (Phase 14):
  ids must look like the engine's (`proj_…`), one body is read up to 500
  projects and 500 tombstones, any unreadable time loses (Windows raised
  `OSError` on a naive year-1 or year-9999 time: a 500 that stopped every
  later reconcile), and a time **more than a day ahead** of the engine's
  clock counts as unreadable -- otherwise one bad copy would win every
  reconcile forever. The console's `codeSyncMerge` applies the same rule.

**Console** (`magi.html`, "CODE MODE, ACROSS YOUR DEVICES"):

* `codeSyncFromCloud` — one branch in `cloudWatch`; returns at once on an
  identical snapshot (stable JSON) and while `_codeDirty`.
* `codeSyncReconcile` — `GET /sync`, `codeSyncMerge` (pure), `PUT /sync` if
  the engine is behind, then `cloudSaveCode()` if the cloud is. Run when the
  listener brings a change, when `/state` shows a new `rev` (`codeSyncCheck`:
  one integer, no request otherwise), and after an Auto switch. That is how
  a change made on `127.0.0.1` (no Firebase there) reaches the cloud: the
  next synced console that connects sees the rev moved.
* `cloudSaveCode()` → `codeFlush` — 900 ms debounce, dirty flag, the whole
  field replaced (`mergeFields: ["code"]`), skipped when nothing differs, a
  **64 KB guard** (old task rows go first, then nothing is written), and
  **held while a task runs**: the task's end flushes it.
* `codeSyncTaskEnd` — once per task (sessionStorage), from the tab that ran
  it: a row into `tasks` plus the body doc (events and result as JSON
  strings — Firestore refuses nested arrays — bounded to 400 KB, the middle
  dropped first). **Recent** under the composer lists them; tapping one reads
  its body and shows it as "a saved copy" (no commit/push buttons).
* `cloudCountWrites` wraps the SDK so every write is logged with its fields:
  `CLOUD.writeLog` in DevTools.

**Measured** (`tests/live/magi-sync.live.js`, real page + real engine + an
in-page fake Firestore behind the real listener): seeding an empty cloud = 1
write; one Auto switch = 1; ten rapid chain toggles = 1; a rename from
another device = 0 writes back (the engine takes it); a 400-event task = **0**
until it ends, then 1 index write + 1 body; one listener throughout. Tests:
`magi/tests/test_code_sync.py` (49), `tests/magi-code-sync.test.js` (43, the
real functions in a VM with fake timers; 13 mutants checked across both).

#### Who may drive the engine (Phase 14)

The engine drives logged-in accounts and can write, commit and push. Who may
send it a request:

| Caller | Allowed? | Enforced by |
|---|---|---|
| Anything over the tunnel | only with the token | `_require_token` (every `/api/` route; `test_route_gate.py` walks them all) |
| A process on this PC, on 127.0.0.1 | yes, no token | `_arrived_over_the_tunnel`: anything here could read the token anyway |
| ...that is a **coding agent**, or anything it started | **no** (403), except the GitHub MCP server's GETs under `/projects/<id>/repo` | `magi/agent_guard.py` |
| A browser page from **another origin** | **no** (403), before anything runs | `_foreign_origin` |
| The Pages console, or the page the engine serves | yes | the allow-list / same origin |

**Why agents are refused.** Codex keeps a shell, and its Windows sandbox
reaches 127.0.0.1 whatever its network setting (verified live, read and write
mode). With loopback trusted, a prompt-injected task could have read the
state, approved its own diff or pushed. Every agent CLI now starts inside a
**Windows job object**; the job follows every process it starts, however
deep, even after the parent exits. While one is running, each loopback
`/api/` request is traced to the process that opened the connection (the TCP
table's owning PID) and refused if that process is in the job. When no agent
runs this costs one job query. Verified live (`tests/live/magi-guard.live.js`):
a Codex write task told to curl `/api/code/state` got `403 not from a coding
agent's process`, Codex still made its edit inside the job, and a request
from outside the job went through mid-task.

**Why a foreign Origin is refused outright.** CORS decides who may *read* an
answer; a "simple" POST is **sent** either way, so any site you visit could
have fired one at 127.0.0.1. Browsers always attach `Origin` to cross-origin
requests and a page cannot forge it, so the engine refuses any origin that is
neither allow-listed (`https://anthonyn99.github.io`, plus
`MAGI_ALLOWED_ORIGINS`) nor the request's own host. DNS rebinding does not
get past that: a rebound host is not loopback, so the token gate applies.
**`null` is no longer allowed.** It let `file://` pages in, but any website
can produce Origin `null` from a sandboxed iframe. To try a local change,
open **<http://127.0.0.1:8000/>**: the engine serves the working copy of
`magi.html` there.

**What each agent can touch**:

| Agent | Tools | Files | The engine |
|---|---|---|---|
| Claude CLI | Read/Glob/Grep (+ Edit/Write in write mode), no shell, no web; `--restricted` | the sandbox copy only | its MCP server's repo GETs, nothing else |
| Codex CLI | its shell, inside its OS sandbox; off-machine features disabled | the sandbox copy (writes elsewhere denied) | refused |
| Browser units | none: MAGI applies their SEARCH/REPLACE edits | the sandbox copy, every path checked | never touches it |

Every change then goes through `security.review` twice and your approval.
**A hostile repository does not reconfigure an agent**. Verified live with a
workspace carrying `.claude/settings.json` (hooks on every event,
`bypassPermissions`, Bash allowed), `.claude/settings.local.json`, a project
skill, a `.mcp.json` server and a `CLAUDE.md` telling it to curl the engine:
no hook fired, no server started, the skill never loaded, and the tools were
exactly the fixed list.

**Still open, knowingly**: a process started *outside* the job on an agent's
behalf (a scheduled task, WMI) is not traced. That takes a shell, so only
Codex has one, and its sandbox cannot create either. Secrets were searched
for on this PC (the API token and the GitHub token, across `magi/data`,
`magi/profiles`, the sandbox and screenshot folders, and A1's last 400
commits): not found anywhere. `/docs`, `/redoc` and `/openapi.json`, which
sat outside `/api/` and so outside the gate, are switched off.

Tests: `magi/tests/test_route_gate.py` (every route through the real
middleware: token, Origin, the guard's wiring), `test_agent_guard.py` (real
processes and sockets: an adopted process, the MCP door, a non-agent let
through, an orphaned grandchild), `test_code_security.py` (8.3 names),
`test_code_sandbox.py` (the approval-time review), `test_code_sync.py`
(hostile copies), `tests/live/magi-guard.live.js`.

---

## Opening MAGI

Once set up, **bookmark <http://127.0.0.1:8000>** and open it like any other
page. `magi autostart` puts the engine on your logon items, so it is already
running by the time you get there and there is no launcher to remember.

```
magi autostart          install it (and start it now)
magi autostart status   is the shortcut installed, and is the engine up?
magi autostart off      remove it
```

It writes `MAGI.lnk` into your Startup folder — visible and deletable by hand
at `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`. A scheduled
task would be the nicer object (delays, battery policy, run history) but
registering one needs elevation, and an autostart that demands an admin prompt
to install is not an autostart.

It runs `magi cloud`, so the same logon also publishes a tunnel and the page
works from your phone. **The tunnel never holds up local access**: it is
verified and published on a background thread, so `127.0.0.1` is answering
seconds after logon whether or not the tunnel has registered yet.

The engine runs under `pythonw.exe` — no console window — and everything it
would have printed goes to `magi/data/autostart.log`, truncated per run. That
is the first place to look when the console says the engine is offline.

There was a `magi.bat` launcher. It was deleted on 2026-09-12, once the
startup shortcut had made it redundant for daily use: the shortcut runs the
venv's `pythonw.exe` directly and never went through the batch file. Every
command it wrapped is one line of the venv's Python, and they are written out
below.

## First run

Build the environment once. From the repo root:

```
py -3.12 -m venv magi\.venv
magi\.venv\Scripts\python.exe -m pip install -r magi\requirements.txt
magi\.venv\Scripts\python.exe -m playwright install chromium
```

3.12 is pinned deliberately: Veda verified against 3.11, this machine has no
3.11, and `py` on its own picks 3.14 — further from that baseline than 3.12
is. Playwright's Chromium is downloaded even though `config/magi.yaml` runs
`channel: chrome` (your real Chrome), because some Playwright internals expect
the bundled browser to be present regardless.

Then start it:

```
magi\.venv\Scripts\python.exe -m magi serve
```

Or `-m magi autostart` once, and it starts itself at every logon.

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
`chairman.min_members: 2` is the minimum for a verdict to be attempted — but
only ever *out of the units you actually selected*. Tick one unit and MAGI asks
one model and shows you its answer, with no chairman pass at all: the console
says **SOLE UNIT** and "answered directly" rather than calling one voice a
consensus. min_members still does its real job, which is refusing to present a
verdict built from one member when you asked for four.

Finally, `magi doctor` to confirm the selectors still match.

### Prerequisites

- **Real Google Chrome**, not just Playwright's bundled Chromium.
  `config/magi.yaml` sets `channel: chrome` because a real Chrome fingerprint
  is part of what clears ChatGPT/Claude's Cloudflare challenge.
- **Python 3.11+.** Veda verified against 3.11; this machine has no 3.11, so
  the venv is built from **3.12** — closest to that baseline, and further from
  the 3.14 that `py` would otherwise pick.
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
| `magi capture <site>` | find the selectors that only exist mid-answer (costs one real question) |
| `magi ask "…"` | run the council in the terminal, no UI |
| `magi autostart` | run the engine at logon, so there is no launcher to remember |
| `magi setup` | rebuild the venv from scratch |

Runs are **completely invisible** — no windows, no taskbar icons, nothing on
screen. All four sites currently run in **true headless Chrome**
(`headless_ok: true` for each in `selectors.yaml`).

That works because MAGI overrides the user agent. Headless Chrome advertises
`HeadlessChrome/141…` instead of `Chrome/141…`, and that token alone is what
Cloudflare blocks — with it removed, ChatGPT and Claude load and answer
normally. Both sit behind Cloudflare and used to need a workaround: a real
window parked off-screen with its taskbar button hidden via the Win32
`WS_EX_TOOLWINDOW` style (`magi/browser/winhide.py`). That path still exists as
the fallback — if either site starts serving "Just a moment…" again, set
`headless_ok: false` for it and it goes back to a hidden window rather than
failing.

Set `browser.offscreen: false` in `magi/config/magi.yaml` to watch the four
windows tile and answer live — useful when a selector breaks. They tile into
quadrants rather than stacking, and that is not cosmetic: Windows throttles
background work in occluded windows, which would slow the very members launched
in parallel to go faster.

---

## The prompt queue

**Queue** beside Convene puts a prompt on a list instead of running it now.
Each row carries its own units, and the list runs one prompt at a time, in
order.

Technically this is a port of the ideas in Veda's Claude Queue, not of its
code — that drives `claude.exe` through a PTY, this drives browser sessions —
but three of its decisions carried over directly:

- **Fractional ordering.** Rows sit on multiples of 1000, so moving one is one
  number changing rather than a renumbering of its siblings. In a field that
  syncs as a whole, that keeps a move to a small diff.
- **A generation counter.** Pressing Pause then Run quickly would otherwise
  start a *second* drain loop over the same list, interleaving two prompts into
  one engine. Every loop iteration rechecks the generation after each `await`
  and a superseded loop exits silently.

Where it deliberately differs: Claude Queue **stops the queue on any failure**,
because its tasks are steps that build on each other and a failed step poisons
the rest. MAGI's queued prompts are independent questions, so a failed one is
marked failed and the queue carries on. The exception is a rate limit — the
next prompt would only hit the same wall, so that stops the queue and says so.

### What syncs, and what it costs

The queue is a `queue` field on the same `dashboards/magi` document as the
history index. That document already has a live listener, so a prompt added on
the phone reaches the PC with **no extra read at all**, and an edit is one
debounced write (700ms) to one field via `mergeFields`, which is also what lets
a removed row actually disappear.

**Attachment bytes never sync.** A row carries its files' names, sizes and
types — enough for every device to show what is attached — while the files
themselves stay on the device that picked them, in an in-memory map that is
deliberately not part of the synced state. A device that does not hold the
bytes says so on the row and runs the prompt without them, rather than
silently asking the council about files it was never given.

The queue is also mirrored to `localStorage`. That is not belt and braces: the
console **served by the engine** (127.0.0.1) can never sign in to Firebase —
App Check only issues tokens on a registered domain — and that is exactly the
page you would sit at to run a queue.

### Watching, and surviving a refresh

A deliberation runs in the **engine**, not in the page, so closing or
reloading the console does not stop it — but the grid is built by the tab that
started the run, so a reload used to leave it invisible.

The row records its run id the moment the engine hands one back (not when the
run ends), and `GET /api/runs/{id}/stream` replays state to a reconnecting
client: an `init` frame carrying every unit as it stands, and the finished
verdict if it has already landed. So:

- A running row has a **◉** that attaches to that stream and puts the units
  back on screen, live.
- On load, a row left mid-run **reconnects** rather than being requeued —
  requeuing would ask the whole council a question the engine is already
  answering. Nothing else starts by itself: the rest of the queue waits for
  Run, because a page that starts deliberations on load spends your accounts
  while you are reading something else.
- If the engine has forgotten the run (it restarted), the attach fails
  cleanly and the row says so instead of sitting on "running" for ever.

### One device at a time

Draining is leased. A device writes `queueLease` with its id and a timestamp,
refreshes it every 30s while it works, and clears it at the end. Another
device sees the lease and says where the queue is running. A lease nobody has
refreshed for 90 seconds is treated as abandoned, so a closed laptop cannot
freeze the queue.

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

`magi.html` opened **from disk** (`file://`) no longer reaches the engine
(Phase 14: its Origin is `null`, which any website can also produce). Open
<http://127.0.0.1:8000/> instead, which serves the same working copy. If you
really want `file://`, set `MAGI_ALLOWED_ORIGINS=null`.

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

**You only type it once, on one device.** A browser that has connected with a
token publishes it into `dashboards/magi` alongside the history it gates, and a
browser that has none reads it from there before reporting itself offline. That
was not a nicety: `magi-link` keys its records by the token's *hash*, so a
phone without the secret cannot even ask where the engine is — and the fix
otherwise was typing a long random string on a phone keyboard. It lives in the
same document, under the same rules, the same App Check and the same sign-in
that already hold every deliberation; Keychain keeps real passwords in this
project, so guarding the token more heavily than the data it protects would be
theatre.

An *unproven* token — one sitting in a desk browser's `localStorage`, used to
reach the engine over `127.0.0.1`, which needs no token at all — only ever
fills a gap. It cannot overwrite a token the phone just proved over a live
tunnel. Proven ones, and one you have just typed in, replace.

The desk console does not even need it typed once: `GET /api/token` hands the
engine's own copy to a loopback caller and 404s over the tunnel, so the console
learns it from the engine and publishes it. That endpoint adds no exposure —
anything that can reach it can already `POST /api/runs` and drive four
logged-in paid accounts, which is strictly worse than reading the string that
authorises exactly that. Two local callers are refused all the same, this
endpoint included: a page from another origin, and a coding agent's process
(*Who may drive the engine*).

**The field in the setup sheet is read-only until you unlock it.** It holds 43
opaque characters and one stray keystroke takes the console offline with no
symptom but silence. Press **Change** to edit; **Restore last working** puts
back the last token that actually reached the engine — remembered only when
*proven* (handed over by the engine, or used to open the tunnel), never merely
when typed.

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

### The tunnel heals itself, and asks Windows for nothing

A quick tunnel is not durable: cloudflared drops out on a network blip, on
sleep/wake, or when Cloudflare recycles the hostname. `magi cloud` replaces it
rather than serving locally for the rest of the session — each replacement gets
a new hostname, which is exactly what `magi-link` is for, and the phone follows
on its next look. Backoff is capped at a minute.

It also **withdraws the old record before opening the new tunnel**. A quick
tunnel dies with the process that opened it, but magi-link keeps serving that
hostname until the replacement is verified and published — minutes, while
public DNS catches up — and for that whole window the phone follows the record
to something answering 530 and the console says "tunnel is dead". A clean exit
withdraws on its way out; a crash, a power cut or a force-kill does not, and
those are exactly the times MAGI gets restarted.

It is also launched with three flags that exist for one symptom: Windows put up
**"allow cloudflared?"** at every single logon, and clicking Allow did not stop
it — four allow rules were already in place. The prompt is not about the rules,
it is about cloudflared **binding a socket that is not loopback**:

| Flag | Why |
|---|---|
| `--protocol http2` | the default QUIC transport binds an unconnected UDP socket to `0.0.0.0`, which Windows cannot tell from a listener. http2 carries the same tunnel over ordinary outbound TCP. |
| `--metrics 127.0.0.1:0` | pins the metrics server to loopback so it can never land on a routable address. |
| `--no-autoupdate` | cloudflared replacing its own binary underneath the firewall rules is one of the few ways a settled prompt comes back. |

---

## After changing the engine: restart it

The engine is a logon process (`MAGI.lnk` → `pythonw -m magi cloud`) that
loads its Python **once**, at start. Any change under `magi/` does nothing
until it restarts, and a browser refresh does not restart it. Two ways:

- `powershell -ExecutionPolicy Bypass -File magi\restart.ps1` (`-Force` to
  interrupt a deliberation). It keeps cloudflared running, so phones keep the
  same address, and it waits until 127.0.0.1:8000 answers.
- **Restart engine** in the console's engine sheet (tap the status row at the
  bottom of the sidebar; `POST /api/restart`): local only
  (404 over the tunnel), and refused while a run, a Studio card or a Code
  Mode task is in flight unless forced.

Whoever changes the engine restarts it and re-checks it live. Handing the
restart back to someone else is how a fix sits on disk while the old code
keeps running.

## "How it works", inside the app

There is a **?** button in the header — the sidebar's on desktop, the top bar's
on a phone — that opens the explanation of MAGI as a panel: what it is, what
happens when you press Convene, what ticking a unit does, why the engine device
has to be awake, and what the Doctor is for.

**It is part of the contract, not a nicety.** It is the only documentation most
people will ever read, and a confidently wrong explanation is worse than none —
it teaches you to expect behaviour the program does not have, and then the
program looks broken. So: *any change to how a run fans out, how completion is
decided, what unticking a unit does, what the doctor checks, how long history
is kept, or where the engine has to be, updates that panel in the same commit.*

`magi/tests/test_howitworks.py` fails when the checkable claims drift — the
doctor's status words, the units it names, the retention window, the promises
about unticked units and about the single-unit path. It cannot check prose;
that part is on whoever is editing.

The content lives in the `HOW` array in `magi.html`. Numbers are interpolated
from the constants they describe rather than typed, so a retention window
cannot go stale on its own.

## Every member is told the answer goes in the chat

`DIRECT_ANSWER_PREAMBLE` (in `magi/providers/browser_base.py`) is prepended to
every browser turn — council members, the chairman's synthesis, Studio, Refine.
Two sentences, both bought with a lost run:

**"Reply in this chat. Do not create an artifact, canvas, document, file, app
or tool to hold it."** Asked for a ten-section daily trading report, Claude
replied *"I'll help you build a template"*, read its memories, and started
building an interactive generator as a file. MAGI scrapes the conversation — it
cannot read an artifact — so it waited for text that never settled and the run
ended `stall_timeout`. A long structured prompt is exactly the shape that makes
these UIs reach for a tool.

**"This is a single turn and there is no follow-up… look things up if you need
current information."** With the artifact fixed, Claude came back with *"Should
I: 1. Search the web for today's data? 2. Wait for you to provide it?"* — a
reasonable thing to ask a person, and worthless here: nobody is watching that
tab. The other three units simply looked the data up, which is the only reason
they answered and Claude did not.

It says nothing about content, tone, length or format, so it cannot bend an
answer — only where that answer is put and whether there is one.
`magi/tests/test_tool_use.py` fails if a shaping word creeps in.

**Tool rows are stripped from the capture** (`extract.strip_tool_rows`): "Read
4 memories", "Searched the web", "Creating a file56srunning" — that last one is
the label, the elapsed timer and the status word as three sibling nodes with no
whitespace between them, glued together by `innerText`. Each is matched as a
whole line that contains nothing else, so a sentence that merely mentions
searching the web keeps its line.

**A long non-answer is still a non-answer.** The clarifying-question rule stops
at 300 characters, because a long answer ending in a question mark is a normal
rhetorical device — but a member can decline at length. An offer to proceed
("Should I…?", "Would you like me to…?") under 1,200 characters is now rejected
the same way: in a one-shot council, asking permission is declining.

**A stock refusal or error line is not an answer either** (`Rejection.REFUSAL`).
On 2026-09-21 Gemini returned "I'm having a hard time fulfilling your request"
as a member — recorded RESOLVED in a 5/5 consensus — and "I encountered an
error doing what you asked. Could you try again?" as chairman, which was
published as the verdict. Both are complete sentences, so no earlier rule
caught them. Any capture under 600 characters matching a site's stock
refusal/error phrasing (all six units' wordings) is now `degraded`.

**A failed chairman hands over** (`Orchestrator.chair_candidates`). The chair's
capture is validated like a member's, so a refusal or error from the chair is a
synthesis failure — and the verdict then goes to the next unit that answered:
the configured chairman, its fallback order, then every other responder. Only
when every one of them fails is the run reported as a synthesis failure, naming
each. Brainstorm's round merge and plan writing use the same handover.

**A refusal gets one retry** (`Orchestrator._ask`). Gemini Flash later
refused the same market question with "I do not have access to real-time
financial market data or live web search" while the identical question typed
into gemini.google.com searched and answered — whether a chat model searches is
decided per turn. A member whose capture is a `refusal` is asked once more in a
fresh chat with `REFUSAL_RETRY_NUDGE` ("search the web now…") in front of the
question; a second refusal stands. Clarifying questions and echoes are not
retried — they would come back the same. The preamble also no longer lists
"tool" among the things not to create (Gemini read it as "don't use tools"),
and it now says web search is available.

Gemini then refused again in new words — "I am unable to perform real-time web
searches or access live market data… please check Bloomberg, Reuters" — and was
recorded RESOLVED, so the retry never fired. Refusals are now also matched by
meaning (`_NO_LIVE_ACCESS`: disclaiming search, browsing or live data) under
600 characters, and up to 1,500 when paired with a redirect to outside sources
(`_REDIRECT`). Replayed against every stored answer and verdict (225): it flags
the five known refusals and nothing else.

## Questions handed over by another A1 program

TradeHub's **Analysis** tab no longer opens a chat site and types a prompt into
it. It opens MAGI:

```
magi.html#tb=<base64url of {v, src, q, units, run, t}>
```

The units it ticks are ticked here, and the council convenes on arrival. Its
searches still open as ordinary browser tabs — only the AI half changed.

**The payload is in the fragment, and that is the whole design.** A fragment is
never sent to a server, so a long prompt cannot overflow a request line — that
is the HTTP 431 that made TradeHub fall back to putting the prompt on your
clipboard, and it is why `?q=` was never an option for a real trading prompt.
Nothing is written to a worker, to KV or to Firestore to carry it either: a
hand-off costs zero reads and zero writes. It also works cross-origin, so the
same link opens the console whether it is on GitHub Pages or being served by
the engine.

**It is consumed once.** `takeHandoff()` strips the fragment *before* the
payload is parsed, so a reload cannot fire a second council run against your
paid accounts. `t` is a nonce for the opposite case: re-sending the same prompt
to a console that is already open has to change the url, or the browser fires
no `hashchange` and the launch looks like it did nothing.

**Nothing is ever dropped silently.** The link waits for whichever of these is
in the way and runs when it clears:

| In the way | What happens |
|---|---|
| MAGI is locked | held; `hideLock()` runs it |
| The unit list has not arrived | held; `boot()` runs it |
| A council is already in flight | held; `endRun()` runs it |
| The engine has not connected yet | the prompt lands in the box and the handoff is KEPT; the reconnect's `boot()` convenes it. Retries keep going in a hidden tab for 30 min while one is waiting (the morning launcher opens MAGI in the background) |
| This tab was left in Code Mode | switched to Deliberation first; `start()` would otherwise hand it to the coding agents |
| It names units this engine has none of | the selection already made here is kept, and the run goes ahead with it |

**It always lands in the one MAGI tab.** TradeHub opens the console exactly
the way TaskHub's MAGI button does — `_tnOpenTab`'s pairing, ported: the window
name `a1tab_magi` first, and when that misses (Chrome restores tabs but not the
opener links that make a name findable) the `tabsync.js` heartbeat and its
`a1tabs` BroadcastChannel. A console that is already open is navigated rather
than duplicated, and because only the fragment differs that is not a reload —
whatever it was doing survives, and it hears `hashchange`.

One message was added to `tabsync.js` for this: **`deliver`**. TaskHub's
handshake ends with the old tab merely coming forward, which for a prompt would
mean focusing a console that never heard the question; `deliver` hands it the
url instead, and it navigates itself. Same-origin only, both sender (the
channel guarantees it) and payload (checked), so it can never send one of these
tabs off-origin.

The morning launcher builds the same link in Python
(`trading-auto-launch/launch.py`, `_magi_link`), from the prompt and unit list
TradeHub pushes to `trade-dashboard`'s `/analysis-config`. A non-empty
`magiUnits` there is exactly what tells it the destination is the council
rather than a chat site — the Vault extension and its `#tbauto` marker are not
in that path at all.

`tests/magi-handoff.test.js` runs the encoder, both decoders and the state
machine above; it also fails if TradeHub offers a unit `selectors.yaml` does
not have.

## Copying a result

Every surface that finishes with something worth keeping carries the same
button (`copyButton` in `magi.html`): the verdict, each unit's answer, a
brainstorm plan, an earlier round's draft, a Studio report, and any run
reopened from History.

One click writes **two flavours** and lets the destination choose:

| | |
|---|---|
| `text/plain` | the original markdown, untouched — for another model, an editor, a commit message |
| `text/html` | the rendered result with its styling inlined — for a document or an email |

Emoji are characters and survive either way. The **colours are inverted on the
way out**: this console is white-on-black and a document is black-on-white, so
each colour's lightness is flipped while its hue and saturation are kept — the
gold stays gold, near-white becomes near-black, and the three-level hierarchy
of heading, body and muted aside survives as three distinct greys. Only
typography is inlined; the box model is deliberately left behind, because
carrying a 2000px console's padding and flex layout into Word is what makes
pasted HTML look broken.

The async clipboard API is not available everywhere (it needs a secure
context), so there are two fallbacks, and the last one — `execCommand` over an
offscreen selection — overrides both types through a one-shot `copy` listener.
Without that it would hand over the text the BROWSER derives from the html,
which is the rendered prose with every `**` and `#` stripped: the one thing the
button exists to preserve. `magi/tests/test_copy.py` pins that, and that every
surface is still wired up.

## Accounts — which account each unit is signed in as

**System → Accounts.** One card per unit: whether a session is saved, whether
it still works, how big the profile is, and a label you write yourself.

Three deliberate omissions, all in `magi/accounts.py`:

- **It does not scrape the account's email.** Seven more selectors, all behind
  logins, each of which would rot into showing the *wrong* account — worse
  than showing none. You label the profile instead; a label you wrote is never
  stale in a way that lies.
- **It does not open a browser to build the list.** Seven Chrome launches to
  render a settings tab is absurd. The listing reads the filesystem; **Check**
  is one unit, on request, and is the only honest answer to "does this session
  still work" — a profile folder existing proves nothing.
- **It never sees your credentials.** *Sign in* opens the real site in a real
  window **on the engine device** — the only place it can open, since that is
  where the profiles live — and MAGI watches the page until the composer
  appears. *Sign out* deletes MAGI's copy of that session so you can sign in
  as somebody else; it is not a sign-out at the provider, and your personal
  Chrome is never touched.

A phone can start a sign-in. The window still opens at the engine device, and
the panel says so rather than leaving you watching a phone for a window that
is never coming.

## Adding a unit

Three files, and the two that are easy to forget are both in `magi.html`:

1. `magi/config/selectors.yaml` — the site block. **Discover the selectors
   against the live page**; a guess ships a unit that looks configured and
   never answers. `magi doctor <site>` then confirms them and names anything
   that does not match.
2. `magi/config/magi.yaml` — `providers.<id>.enabled`.
3. `magi.html` — a codename in `UNIT` and a stagger in `PHASE`. Neither throws
   when missing, so neither gets noticed: `magi/tests/test_units.py` fails
   instead, and also refuses two units sharing an accent colour.

A fourth place names units, outside MAGI: **TradeHub's Analysis tab**
(`TB_MAGI_UNITS` in `tradehub.html`) and the allow-list that carries its choice
through `workers2/trade-dashboard`. A unit missing there is simply one you
cannot tick from TradeHub; a unit *misspelled* there is a tick box that does
nothing at all. `tests/magi-handoff.test.js` fails on either.

### Two Claudes

The council has two Claude units, on two accounts:

| Unit | Account | Codename |
|---|---|---|
| `claude` | free | BALTHASAR·02 |
| `claude-pro` | subscription | ARMISAEL·07 |

They exist because they draw on **different allowances**. Code Mode drives
Claude through the CLI, on the subscription, and a long coding session spends
exactly what a council run would — so pointing every deliberation at the paid
account means the two compete for the same limit. The free unit carries
ordinary council work; the paid one is the deliberate choice when the answer
is worth it. Tick both and two Claudes answer independently.

`claude-pro` ships `enabled: false`, so it appears as an unticked chip until
you `magi login claude-pro` — a unit you can see and turn on beats one you
have to know exists, and enabling it before there is a session would put a
member in every run that can only fail.

The chairman stays on the **free** Claude on purpose: the synthesis is a full
extra turn on top of every member, and spending the subscription on it
competes with Code Mode for the same allowance.

In `selectors.yaml` the second unit is a **YAML merge key** (`<<: *claude`),
not a copy. These selectors break when Anthropic ships a redesign, and a
duplicated block is one you fix twice — or, worse, once, leaving a unit that
silently stops answering. The accounts are separated by their Chrome profile
directories (`profiles/<profile>/claude/` and `.../claude-pro/`), which is the
whole mechanism.

### The members

| Unit | Codename | Verified |
|---|---|---|
| ChatGPT | MELCHIOR·01 | yes |
| Claude (free) | BALTHASAR·02 | yes |
| Gemini | CASPER·03 | yes |
| DeepSeek | ADAM·04 | yes |
| Perplexity | LILITH·05 | composer, submit, answer and stop probed live |
| Grok | TABRIS·06 | composer and submit probed live; answer and stop **not** — logged out, Grok accepts the question and never answers |
| Claude (Pro) | ARMISAEL·07 | selectors shared with BALTHASAR via a merge key; needs its own sign-in |

Perplexity earns its place by being the one member that is search-grounded by
default: where the others reason from training data, it reads today's page.
That is exactly the disagreement a council exists to surface.

Copilot was a member until 2026-09-11 and is gone. It showed a sign-in wall
with no reachable composer, and the only input selector loose enough to match
anything on that wall matched a hidden decoy — so it reported itself usable
and then answered nothing. A member that cannot answer is worse than one that
is absent: it costs a browser, a timeout, and a slot in the quorum.

For Grok: sign in from the Accounts tab, then `magi doctor grok`. It primes
the composer, names every field that does not match and prints the line to
change.

## When a site changes its UI

This is the routine maintenance task, and it does not require touching Python.

```
magi doctor        # OK / FALLBACK / MISS per selector
```

Then open the site, inspect the element, and add the working selector to the
**top** of that field's list in `magi/config/selectors.yaml`. Every field is a
list tried in order, so old entries stay as fallbacks and you keep a rollback
path if the site reverts or is A/B testing.

### What the report tells you

A verdict line first — *"all 4 units healthy"*, or *"1 unit needs attention ·
3 fine"* — then one card per unit, then the full field table folded away. It
used to be a single flat table of every field of every unit, about thirty rows
and almost all of them OK, which answered "what matched?" when the question is
"is anything broken, and what do I do?".

A stale or missing field now prints the fix: the file, the key, the selector
that matched and the one it should be moved above. That is the whole repair,
and it was previously something you inferred from two table columns.

The units are checked **in parallel**, for the same reason the council fans out
in parallel — each drives its own profile against a different service, so
nothing is being hammered. Sequentially, four units meant about two minutes of
staring at a spinner, which is long enough that the doctor stopped being
something you just run. Each card also reports how long that unit took: one
that is "fine" but took fifty seconds is on its way to timing out mid-run, and
nothing else would tell you.

It checks the units you have **selected**. A unit you are not using is a unit
whose selectors you do not need to know about — and it opens a real signed-in
browser per unit, which is not something an unticked model should get.

### Dialogs that land on the composer

A cookie banner cost a run. Perplexity served its consent card — fixed,
bottom-right, over the composer — and the unit failed after thirty seconds with
`Could not type: Locator.click: Timeout 30000ms exceeded … locator resolved to
<div id="ask-input" …>`.

Read that closely: the selector **matched**. Playwright's click then waits for
the element to pass its actionability checks, one of which is a hit test, and a
click at that point would have landed on the dialog. It was reported as
`selector_miss`, whose remedy is "rewrite selectors.yaml" — against a selector
that was perfectly correct.

`magi/browser/overlay.py` makes that class of thing a non-event, in two halves:

- **Known dialogs are clicked away** before the prompt is typed, from
  `dismiss_selectors` — a shared list in `defaults` that every site gets, plus
  per-site entries, unioned rather than overridden. They are scoped to a
  `role="dialog"` wherever the site gives us one, and the **refusing** option
  is always listed before the accepting one: "Decline optional" before "Got
  it", "Maybe later" and never its sibling "Get started". MAGI answers a
  consent prompt on your behalf, so it answers conservatively.
- **Unknown dialogs cannot stop a run anyway.** The click is only the first of
  three routes into a composer. The second is `focus()`, which does no hit
  testing at all, so nothing painted on top can block it — and everything after
  that point is keyboard-driven (`Input.insertText`, `keyboard.type`), which
  follows focus and needs no pointer. Focus is read back out of
  `document.activeElement` before it is believed, because a `focus()` that
  silently did nothing would type the whole prompt into the page body.

When it does fail, it fails as `overlay_blocked` and the cause NAMES what was
in front — `elementFromPoint` at the click position, walked up to its dialog.

`magi doctor` reports the same thing: it now says when a dialog was covering
the composer and whether the configured selectors closed it. It also waits for
the composer as long as a run does rather than a flat three seconds — measured
on perplexity.ai with two dialogs to render, that flat wait reported `input`
and `ready_selector` as MISS, which is the same false alarm in a different
place.

`magi/tests/test_overlay.py` pins all of it, including that the shared list
cannot click anything but a dismissal.

### The three fields `doctor` can never check

`doctor` can only probe an **idle** page, so `stop_button`, `streaming_marker`
and `assistant_turn` are permanently unverifiable there — they do not exist
until a model is actually answering. That gap is why DeepSeek ships with
`stop_button: []` and `streaming_marker: []`: its completion detection rests on
text stability alone, so every DeepSeek answer is flagged *"end of response
inferred, not confirmed"* and pays a 14-second silence before MAGI calls it
finished, whether or not it actually was.

```
magi capture deepseek
```

asks one short throwaway question, snapshots the page before, repeatedly during
and after the answer, and reports what existed **only while generating**. Those
are the stop-button and streaming-marker candidates; put the ones that look
right at the top of their lists. It deliberately ignores build-hashed class
names (`_4f3769f`), because a selector built from one works today and breaks
silently at the site's next deploy — looking exactly like a redesign when it
does.

It costs a real question against your account, which is why it is a command you
run deliberately rather than something `doctor` does on every pass.

---

## Troubleshooting

Every failure MAGI can produce has a specific cause and a concrete fix — this
is `magi/errors.py`'s `FailureKind` taxonomy, condensed. The UI shows the same
cause and remedy inline on the failing unit.

| Symptom | Cause | Fix |
|---|---|---|
| `not_logged_in` | Saved session isn't logged in | `magi login <site>` |
| `selector_miss` | Site's UI changed | `magi doctor`, then edit `config/selectors.yaml` |
| `overlay_blocked` | Something is covering the composer | the cause names it; add the button that closes it to that site's `dismiss_selectors` |
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

**Halt stops a run on the first click**, and both halves of that were once
too slow to look like anything had happened. Cancelling is cooperative on the
engine — an event is set and a provider acts on it where it safely can, which
is before sending and on every poll while it waits. That covers the long middle
of a run and nothing else: launching Chrome, navigating, clearing a dialog and
pasting the prompt are uninterruptible, and together they are most of the first
thirty seconds, which is exactly when somebody presses Halt. So the fan-out is
now raced against the event and the member's task is cancelled outright, which
unwinds `async with launcher.launch(...)` and closes the browser mid-phase; the
member still returns a CANCELLED answer rather than vanishing from the grid.
The console does not wait for any of that: the click stops the tone, marks
working units HALTED and disables the button before the POST is even sent, and
ends the run locally if the engine never answers. It used to `await` the POST
and change nothing, so the click looked like it had missed — which is why
people clicked twice. `magi/tests/test_halt.py` pins both halves.

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
| `magi/config/selectors.yaml` | per-site selectors, timeouts and `dismiss_selectors` — **edit this when a site changes** |
| `magi/config/magi.yaml` | pacing, which members are enabled, who chairs, artifact settings |
| `magi/.env` | `GEMINI_API_KEY` for Refine (gitignored) |
| `MAGI_API_TOKEN` | env var; gates `/api/*` (see above) |
| `MAGI_ALLOWED_ORIGINS` | env var; extra origins the engine answers, comma separated (`null` lets a `file://` page in; see *Who may drive the engine*) |

The two YAML files are deliberately **not** merged. Selectors are what break
when a site ships a redesign, and the person fixing them at 1am should not have
to scroll past pacing and chairman config to do it.

---

## Layout

```
magi.html               the console — single file, no build step
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
| `MAGI.bat` + `MAGI-Login.bat` + `MAGI-Doctor.bat` + `MAGI-Cloud.ps1` | one `magi.bat`, and then nothing — the startup shortcut runs the venv directly |
| `backend/magi/` | `magi/` |
| React + Vite + TypeScript frontend (23 files, a build step) | `magi.html` |
| Firebase Hosting | GitHub Pages, with the rest of A1 |
| Interpreter probing across four candidate Pythons | a pinned `.venv` |
| Tunnel url compiled into the bundle | looked up at load from `magi-link` |
| A stale 2.4MB copy of TaskHub's `index.html` | deleted |

**Studio is ported.** Seven cards derived from a finished verdict — Data
Table, Report, Flashcards, Quiz, Mind Map, Slide Deck and Audio Overview — in
the sidebar under *Studio*, disabled until a run has a verdict. Clicking a card
generates it if it has never run and opens it either way; an open card replaces
the grid and verdict rather than stacking above them. Generated cards are
stored, so reopening a past run from History brings its cards back rather than
regenerating them. Audio Overview is read aloud by the browser's own
SpeechSynthesis — MAGI has no audio generation surface, so the two-host script
is spoken client-side, with a second voice where the platform has one and a
pitch offset where it does not. Video is a permanently disabled tile: there is
no video surface reachable through a browser-automated chat UI.

**Brainstorm is ported.** Its own section in the sidebar, and it takes over the
content area when open — it brings its own topic box and its own reply box, so
the council's question bar is hidden rather than stacked above a second textarea
that submits somewhere else. Rounds stream the same per-member events a council
run does, so they drive the same grid with no changes to it.

Questions come back as cards, modelled on Claude Code's own AskUserQuestion: a
header chip, the question, then either options to pick from or a text box. One
marked *shapes the plan* is blocking — while it is unanswered the session cannot
report itself ready. Every answer is optional; skipping one means "you decide".
The plan is never written to disk on its own: **Save as…** opens a real file
dialog where the browser supports one and falls back to a download otherwise.

Rounds that were retried are kept and labelled rather than hidden — a round that
failed still happened, and what the members said before it failed is part of the
record.

Brainstorm is worth knowing about before porting it — a round is three phases
(propose → critique → merge), and the critique phase is what makes it a debate
rather than a poll: each member reads the others verbatim and attacks them, so
a wrong claim from one member gets challenged by the three that could catch it.
The properties it depends on are enforced in code rather than only asked for in
the prompt (an answered-facts ledger, blocking unknowns that gate the finish,
refutations replayed to the member that made the claim, disagreement as a table
rather than prose, and a review pass that can only improve or no-op). Read
`magi/engine/brainstorm.py` before rebuilding that UI.

---

## Cross-device sync

Every finished deliberation goes to Firestore, so a verdict produced on the PC
opens on the phone. The engine stays where the Chrome profiles are; only the
RESULTS travel.

```
dashboards/magi              one index doc: compact rows, newest first
dashboards/magi/runs/{id}    one body per run: answers, verdict, Studio cards
```

Both sit under the existing `/dashboards/{doc=**}` rule, so `firestore.rules`
needed no change.

**The write budget drove the shape.** The free tier is 20k writes and 50k reads
a day, shared with every other A1 program:

- **Nothing is written while a run is in flight.** A run emits an SSE frame
  every few hundred ms per member; mirroring those would be thousands of
  writes for one question. One completed run is **one body write plus one
  index update**.
- **History reads one document, not a collection.** A collection query costs
  one read per run returned — 30 reads every time the page opens. One index
  doc is one read.
- **Exactly one listener**, on that index doc, so a run finished on the PC
  appears elsewhere without polling. Its cost is bounded by write volume, not
  by time.
- **Bodies are read only when you open that run.** Opening History reads
  nothing extra.
- Index writes are **debounced**, so generating three Studio cards in a row is
  still one index write.

Steady state for heavy use — 30 runs a day, read on three devices — is roughly
90 writes and a few hundred reads. Under half a percent of the allowance.

Studio cards travel with the body deliberately: each one costs a real browser
run, so a phone should open one rather than re-earn it.

### Retention: 30 days, or pinned

History keeps 30 days; everything older is dropped, body document first and
then the index row, so an interruption leaves an invisible orphan rather than a
History entry that opens to nothing. The sweep runs once per load and only when
something has actually expired, so the usual cost is zero writes.

**Pin a deliberation to keep it forever.** Pins live BOTH in that browser and on
the cloud row, and either one counts — a pin has to survive sync being
unavailable (App Check refuses to sign in on `127.0.0.1`) *and* reach your other
devices when sync works. Both paths fail towards keeping the run: the cost of
getting this wrong is deleting something you asked to keep. Backfill skips
expired runs too, or the engine's SQLite — which keeps everything — would
re-upload them on the next load and pruning would be a loop rather than a
policy. The API token travels
in the index doc for the same reason — see **The token** above.

**Every scroller has an overlay scrollbar** — the page, the drawer, and each
open answer. Nothing while you read, a thumb while you move, grabbable with a
finger or a cursor, gone a moment later. They are fixed overlays positioned
from each scroller's rect rather than children of it, so no scroller needed
restructuring to get one.

**Pull down to refresh reloads the page**, exactly like Index and the rest of
A1: the gesture is what people reach for when the page itself looks wrong, and
refetching state in place cannot fix that (or pick up a newly deployed
`magi.html`). The one exception is a deliberation in flight — reloading then
would drop the SSE stream and leave the council running against your paid
accounts with nothing watching — so that case refreshes in place instead. The
gesture is implemented by hand because `body { overflow: hidden }` and an
installed PWA leave the browser's own version nothing to fire on.

**When sync fails it says why.** "Sync failed" alone named no operation, no
cause and no fix, and the detail went to a browser console you cannot open on a
phone. The line is now clickable: it gives the Firestore code, a plain-language
cause, what was being written, and a retry. Backfill also stopped crying wolf —
it used to report failure whenever *zero* runs were pushed, so a batch whose
only missing run had been deleted from the engine showed "Sync failed" with
nothing wrong, and a batch where nine of ten failed showed "Synced".

**App Check is registered per domain.** Sync works on
`https://anthonyn99.github.io/A1/magi.html`; on `http://127.0.0.1:8000` the
App Check token is refused and sync silently stays off. Everything local —
running the council, History, Studio, Brainstorm — is unaffected either way,
and the console degrades to local-only rather than erroring.

## Installing it

`magi.html` carries an inline `data:` manifest, the same pattern every other A1
program uses, so there is no extra file to deploy. Open it and use the
browser's **Install** option to get it as a standalone app with its own icon.
Install from the GitHub Pages URL rather than `127.0.0.1`, so the installed app
has a stable identity and App Check works.
