# Shield agent (Phase 2)

The part of Shield that can actually close things. `shield.html` is the UI; this
is the Windows process that gives it teeth.

> **Status: written, not yet compiled.** There is no Rust toolchain on the
> machine this was authored on, so nothing here has been through `cargo`. Treat
> the first build as part of the work, not as a formality — see
> [First build](#first-build).

---

## Why the window loads a remote URL

The window points at `https://anthonyn99.github.io/A1/shield.html` rather than
bundling the page. That is deliberate and load-bearing:

- the auth Worker pins CORS to that exact origin ([`workers/taskhub-reminders/worker.js:23`](../../workers/taskhub-reminders/worker.js));
- Firebase App Check's reCAPTCHA site key is registered for it and is **shared by
  every A1 app** — re-registering it breaks the whole suite about an hour later,
  while Auth carries on working and hides the cause;
- Firestore rejects a `file://` or `tauri://` origin outright.

Loading the live page sidesteps all three and leaves exactly one copy of the UI.

The cost is that the *window* needs the network. The tray menu and the global
hotkeys deliberately do not: they read the last configuration the page pushed
into `%APPDATA%\Shield\state.json` and run entirely in Rust. Closing apps has to
work when the internet is down, when the page has never been opened this boot,
and when there is no window at all — that is the whole reason an agent exists.

`ui/index.html` is a small offline status page. It satisfies Tauri's
`frontendDist` requirement and shows agent state if you reach it, but there is
**no automatic failover to it** when Pages is unreachable — the window will show
the browser's own error page. Worth adding later; not claimed now.

---

## Layout

```
desktop/shield/
├── build.ps1                 prerequisite check + build + optional install
├── tools/make-icon.js        rasterises the Shield mark to a real .ico
├── ui/index.html             offline status page (also satisfies frontendDist)
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json       remote window URL, tray, NSIS currentUser
    ├── capabilities/default.json   ← grants invoke to the Pages origin
    ├── icons/                generated, checked in
    └── src/
        ├── main.rs
        ├── lib.rs            commands, tray, hotkeys, boot re-arm
        ├── proc.rs           enumerate / capture / kill / launch
        ├── shortcuts.rs      hide + restore .lnk launch points
        ├── watchdog.rs       kill-on-sight loop
        ├── history.rs        agent-side close history
        └── state.rs          %APPDATA%\Shield\state.json
```

---

## First build

```powershell
cd desktop\shield
.\build.ps1              # checks prerequisites and tells you what is missing
```

Prerequisites it will ask for:

| Need | Install |
|---|---|
| Rust (MSVC) | `winget install Rustlang.Rustup` |
| MSVC C++ build tools | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| WebView2 | already present on Windows 11 |

Then `.\build.ps1 -Dev` to run it, or `.\build.ps1 -Install` for the NSIS
installer, or `.\build.ps1 -Autostart` to register it at logon.

### Verify these first — they are the parts most likely to need adjusting

1. **The remote capability.** `capabilities/default.json` grants `invoke` to
   `https://anthonyn99.github.io/*`. This is the one piece of the design not
   already proven elsewhere in this repo. If commands come back as
   *"not allowed"*, that file is where to look. Fallback if it cannot be made to
   work: proxy the four auth-Worker calls through Rust (`reqwest` has no CORS)
   and bundle the UI locally — costs the single-copy benefit, nothing else.
2. **`sysinfo` 0.32 API.** `Process::name()` / `cmd()` return `&OsStr` in this
   version; older examples return `&str`. If the build complains about
   `to_string_lossy`, the crate version moved.
3. **`windows` 0.58 signatures.** `PostMessageW` takes `Option<HWND>` here and
   `HWND` in some versions; `EnumWindows` returns `Result<()>`.

---

## What it does

| Command | Effect |
|---|---|
| `sh_status` | version, live emergency state, watchdog state, capabilities |
| `sh_set_config` | page pushes this device's targets down so tray/hotkeys work offline |
| `sh_enumerate` | running executables + shortcut names, for the target picker |
| `sh_kill` | capture manifest → `WM_CLOSE` → force after 1.5s → record history |
| `sh_emergency_on` | the above, plus hide shortcuts, start watchdog, optional lock |
| `sh_emergency_off` | stop watchdog, restore shortcuts |
| `sh_launch` | reopen from a captured manifest |
| `sh_restore_icons` | put one entry's shortcuts back |
| `sh_pull_history` | entries the agent recorded while the page was closed |
| `sh_lock_workstation` | `LockWorkStation` |

Tray: left-click opens the window, right-click gives **Close Apps / EMERGENCY /
Open Shield / Quit**. Hotkeys: `Ctrl+Shift+X` close, `Ctrl+Shift+L` emergency.

**Capture before kill.** `Win32_Process.CommandLine` and the full image path are
only readable while a process is alive, so `capture_and_kill` builds the whole
manifest before sending a single close message. Getting that order wrong does
not fail loudly — it silently produces history entries that can never be
reverted.

**The captured command line is stored but not replayed.** It routinely contains
one-shot arguments (a crash-handler pipe, a parent PID, an update token) that
are meaningless or harmful the second time. Reopen starts the image from its own
directory, which is what "reopen the app" actually means.

---

## Limits, stated plainly

- **No true launch blocking.** Windows 11 Home has no AppLocker and no Software
  Restriction Policies. The watchdog closes a target again roughly every 750 ms,
  so it will visibly flash on screen before it dies. Rejected alternatives:
  Image File Execution Options `Debugger` hijacking (needs admin, is a known
  malware technique, trips Defender/ASR) and HKCU `DisallowRun` (only Explorer
  honours it, so it stops a double-click but not a script or an app's own
  updater).
- **Taskbar pins are not touched.** The pin state is an undocumented binary blob
  under `HKCU\...\Taskband` and needs Explorer restarted. Killing the process
  does remove its running taskbar button; a *pinned* icon stays.
- **Shortcuts are matched by name**, not by reading the `.lnk` target path.
  `Discord.lnk` → `discord.exe` works; a shortcut named nothing like its
  executable will not be found and stays on the desktop. Reading `.lnk` targets
  properly means COM (`IShellLink`) — a fair amount of surface area for the
  uncommon case.
- **Store/UWP apps** have no `.lnk` to move.
- **Elevated processes** cannot be closed by a non-elevated agent; they are
  reported as `denied — needs admin`, never as closed.
- **Ending the agent in Task Manager stops enforcement** until next logon. A
  self-resurrecting watchdog pair would behave like malware, trip Defender, and
  can make your own machine unusable. Shield does not do it, and the UI says so.
- **Unsigned.** SmartScreen will warn on first install. `currentUser` install,
  no HKLM writes, no service, no admin prompt.

## Not in this phase

The **Firestore listener** — the piece that makes *Emergency — All My Devices*
reach this machine while the browser is closed. It is a genuine fork:

- Firestore's real-time `Listen` is gRPC, so a Rust agent needs `tonic` plus
  anonymous-auth token handling. Correct, sub-second, costs one read per change.
- REST polling is trivial to write but bills a read per poll per device. At 10 s
  that is ~8,600 reads/device/day, which is exactly the "don't spike Firebase"
  problem; at 60 s the latency defeats the point of an emergency button.
- A Cloudflare Durable Object push channel avoids Firestore reads entirely but
  is new infrastructure.

Worth deciding deliberately rather than defaulting into. Until then, remote
emergency reaches this device only while `shield.html` is open on it.
