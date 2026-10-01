# TradeBoard desktop shell

A [Tauri v2](https://tauri.app) wrapper around the existing TradeBoard web app,
built for one reason: the **Apps** tab needs to start and stop real Windows
programs, and browser JavaScript cannot do that.

Everything else is unchanged. The web app still deploys to Cloudflare Pages
exactly as before, and this shell is a purely additive, optional packaging
target. Someone who never builds it loses nothing except the ability to launch
things.

```
tradeboard.html ──┬── scripts/build.mjs        → public/index.html   → Cloudflare Pages
                  └── scripts/build-desktop.mjs → desktop/dist/index.html → Tauri shell
```

Both targets copy the **same** canonical `tradeboard.html`, so the two can't
drift apart.

## Layout

| Path | What it is |
|---|---|
| `core/` | Data model + all schedule maths. No GUI dependencies, so it is fully unit-testable. |
| `core/tests/` | 46 tests: schedule evaluation, process-safety contracts, re-parenting regressions, and end-to-end scheduler runs against real processes. |
| `src-tauri/` | The shell: Tauri commands, process control, tray icon, background scheduler. |
| `dist/` | Generated. The bundled copy of the web app (`npm run build:desktop`). |

The split exists for a practical reason as well as a tidy one: a test binary
that links Tauri cannot start under this MinGW toolchain
(`STATUS_ENTRYPOINT_NOT_FOUND` out of the WebView2/GUI import chain), so the
logic worth testing lives in a crate that doesn't link it.

## Prerequisites

Node 18+, plus a Rust toolchain. **This machine has no MSVC C++ compiler** —
Visual Studio is installed without the C++ workload, and adding it needs an
admin UAC prompt — so the build is configured for the **GNU** toolchain, which
installs entirely per-user:

```powershell
# 1. Rust (per-user, no admin)
winget install Rustlang.Rustup      # or https://rustup.rs

# 2. GNU toolchain — note: `rustup default`, not just a target override.
#    Build scripts and proc-macros compile for the HOST, so a target-only
#    setting still tries to use link.exe and fails.
rustup toolchain install stable-x86_64-pc-windows-gnu
rustup default stable-x86_64-pc-windows-gnu

# 3. MinGW-w64 — supplies gcc / ld / dlltool (user scope, no admin)
winget install BrechtSanders.WinLibs.POSIX.UCRT --scope user
```

Make sure `%LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs...\mingw64\bin`
and `%USERPROFILE%\.cargo\bin` are both on `PATH`.

WebView2 is already present on Windows 11.

> **If you later install the MSVC C++ workload** (Visual Studio Installer →
> Modify → "Desktop development with C++"), just run
> `rustup default stable-x86_64-pc-windows-msvc`. Nothing in the source depends
> on GNU; only `.cargo/config.toml` mentions it, and its one setting (a larger
> linker stack reserve) is scoped to the GNU target.

## Build and run

```bash
npm run build:desktop     # copy tradeboard.html → desktop/dist/index.html
npm run desktop:dev       # debug build + run
npm run desktop:build     # release build
npm run desktop:test      # cargo test (the core crate's 39 tests)
```

An installer (`.exe`, NSIS, per-user — no admin) comes from:

```bash
cd desktop/src-tauri && cargo tauri build
```

### Known build warnings

Two warnings are expected under MinGW and are harmless:

- `.rsrc merge failure: multiple non-default manifests` — the linker keeps the
  first application manifest. The app runs correctly.
- The debug binary is large (~220 MB) because GNU debug info is not stripped.
  The release profile sets `strip = true`.

## How the pieces fit

**Storage.** `LaunchItem`s live in `TBStore` under `tb.apps.items` and mirror to
Firestore through `TBCloud` like every other section, so your list of apps and
schedules syncs across devices. The *action history* (`tb.apps.log`) is
deliberately **device-local** — it records what this machine actually launched,
and merging another machine's log would be a fiction. PIDs are never persisted.

**The bridge.** The frontend talks to Rust through `TB.apps.shell`, which is just
a guarded `window.__TAURI__.core.invoke`. In a plain browser
`TB.apps.shell.available` is `false`, every native button reports "not running
in the desktop shell", and the tab explains itself with a banner. Adding and
scheduling items still works there and still syncs.

**Commands** (`src-tauri/src/state.rs`): `set_items`, `validate_path`,
`launch_app`, `open_item`, `close_item`, `list_running`.

**The scheduler** (`src-tauri/src/scheduler.rs`) is a 20-second tokio loop that
*reconciles* rather than firing timers: it computes what should be true, looks at
what is true, and corrects the difference. Three awkward requirements fall out of
that design for free:

- **Catch-up.** A trigger missed because the PC slept or the shell wasn't running
  self-corrects on the next tick — including the first tick after startup.
- **No double-launch.** "Should be open" is a single boolean OR across rules, so
  duplicate or overlapping rules cannot each launch a copy.
- **Live config changes.** The item list is re-read every tick, so disabling an
  item or one rule takes effect immediately, with no restart.

**Timezones.** Every rule carries an IANA zone and is evaluated with
`chrono-tz`. There is no manual UTC-offset arithmetic anywhere. A wall-clock time
that DST skips (spring forward) is treated as not occurring rather than being
fired at a substitute moment; an ambiguous time (fall back) resolves to the
earlier instant.

**Midnight.** An end time at or before the start time means "ends the next day",
so `22:00 → 02:00` is one continuous window.

**Manual override.** Closing an item by hand during a window in which the
schedule wants it open sets a suppression flag, so the scheduler doesn't fight
you. The flag is keyed to the window's start edge and clears at the next
scheduled start.

## Websites: why child windows

Website items default to **opening in a Tauri-managed child window**, because
that is the only mode in which "close" can be honoured — the shell owns the
window and can close it.

The alternative, **Default browser**, is offered per item and is genuinely
open-only. Once a URL is handed to the OS there is no reliable cross-browser way
to find and close that specific tab, and pretending otherwise would mean either
killing the user's whole browser or silently doing nothing. Instead, choosing
that mode:

- shows an `open-only` badge on the item row,
- warns in the schedule editor that the end time will be ignored,
- makes `close_item` a **no-op, not an error** (spec §3).

## Safety

- Programs are spawned with an **argument array**, never a shell string, so a
  path or argument containing `&`, `|` or quotes cannot become a second command.
  `.bat`/`.cmd` files must go through the interpreter, but even then the script
  path and each argument are separate argv entries.
- The shell **only ever terminates a process it started itself**, identified by a
  PID it recorded *and* re-verified by executable path immediately before acting
  (PIDs get recycled). A matching process it didn't launch is left alone: with no
  tracked PID, `close_item` is a no-op.
- Paths and URLs are validated before being saved, with inline errors.
- **No elevation, ever.** If a target needs admin rights, the resulting
  `ERROR_ELEVATION_REQUIRED` becomes a plain message telling you so; there is no
  attempt to work around UAC.

## Testing

```bash
npm run desktop:test
```

39 tests run by default:

| Suite | Covers |
|---|---|
| `schedule_tests.rs` (18) | Window boundaries, midnight crossing, both DST directions, per-rule and per-item disabling, duplicate rules, specific dates, suppression edges. |
| `process_contract_tests.rs` (9) | Path validation, argv-not-shell-string, real spawn/kill, path-identity normalisation. |
| `e2e_scheduler_tests.rs` (12) | Full scheduler loop against real processes: auto-launch/auto-close, removal mid-window, restart catch-up, manual-close suppression, never touching untracked processes. |
| `reparenting_tests.rs` (6) | The re-parenting regression below, plus the safety property that a pre-existing process is never adopted. |

Four tests are `#[ignore]`d because they open real windows or cost minutes of
wall time. Run them explicitly:

```bash
cargo test -p tradeboard-core --test reparenting_tests -- --include-ignored --test-threads=1
cargo test -p tradeboard-core --test wallclock_notepad_test -- --ignored --nocapture
```

The web half has its own suite (37 tests, no browser needed):

```bash
npm run test:apps
```

### The re-parenting bug (worth knowing about)

The wall-clock acceptance test initially **passed while doing the wrong thing**:
Notepad launched *five times* in a two-minute window. `C:\Windows\System32\notepad.exe`
is only a stub — modern Notepad is store-packaged, so the process we spawn exits
within a second and the real app continues from
`...\WindowsApps\Microsoft.WindowsNotepad_...\Notepad\Notepad.exe` under a pid we
never saw. A liveness check that only watches the spawned pid therefore reports
"not running" on the very next tick, and the scheduler relaunches.

`process::find_reparented` fixes this by adopting a process that (a) matches the
launched executable — by full path, or failing that by file name, since the
packaged path differs entirely — and (b) started at or after our launch. That
second condition is the safety property: a matching process that predates our
launch is the user's own and is never adopted, so it can never be killed by a
later scheduled close.
