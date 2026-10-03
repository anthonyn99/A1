# MAGI — retire the old "tony" engine on Veda's PC (run ON VEDA'S PC)

**For Claude.** If someone said *"read the retire plan"*, *"retire the old
engine"* or *"do the Veda engine cleanup"*, this file is the whole job. Do it
start to finish; ask Veda only the one question marked **ASK**. Nothing here
deletes anything: the old engine is stopped, its autostart is switched off,
and its files are moved aside, so every step can be undone.

## Why

Veda's PC (`VedaHPENVY`) runs two MAGI engines:

- **Hers**: profile `veda`, A1's `magi\data\veda\engine.json`, scheduled
  tasks named `MAGI Engine (veda)` and `MAGI Watchdog (veda)`, port 8000 or
  8001. **Keep this one.**
- **An old one under Tony's profile**: her MAGI from before profiles existed.
  It answers `/api/health` with `"profile":"tony"`, engine id
  **`eng_f2a5dcf41f29`**, label `VedaHPENVY - tony`, normally on port 8000.
  **Retire this one.**

The old one breaks the rule in [magi-setup.md](magi-setup.md) ("never run
anything with `-Profile tony` on her PC"). It got onto Tony's engine list
(he forgot it there on 2026-10-03), it makes a plain `magi\restart.ps1` on
her PC restart the wrong engine, and an old-style install of it kills every
`cloudflared.exe` on the PC when its tunnel restarts (the 2026-09-28 KV-write
burn in magi-setup.md).

It may run from either of two places, and you find out which in step 2:

- **`%USERPROFILE%\Downloads\MAGI`**, her original copy, with tasks
  `MAGI Cloud` and `MAGI Watchdog`; or
- **A1 itself**, with data in `A1\magi\data\tony\` and tasks `MAGI Engine` and
  `MAGI Watchdog` (no suffix: Tony's default names).

## Hard rules

- **Only on Veda's PC.** On Tony's PC the tony engine is HIS real engine
  (`eng_68bec3b7a7ff`); retiring it there takes MAGI down for him. Step 1
  checks this. If it fails, stop and say so.
- **Never touch anything with `veda` in it**: her engine, her tasks, her
  `magi\data\veda`, her `magi\profiles\veda`, her token.
- **Never kill every `cloudflared.exe`.** Her own engine's tunnel is one of
  them. Kill only the old engine's processes (by PID, step 3).
- **Delete nothing.** Move it aside (step 5). Nothing under `magi\data` or
  `magi\profiles` goes into git (both are git-ignored, and they hold logins).
- **Never print a token**, never write one into a file, a commit or the chat.

## Steps

### 1. Prove this is Veda's PC and find both engines

```powershell
cd $env:USERPROFILE\Desktop\A1        # wherever A1 is on her PC
git pull --rebase --autostash
$env:COMPUTERNAME                      # expect VEDAHPENVY
foreach ($p in 8000, 8001, 8002) {
  try { $h = Invoke-RestMethod "http://127.0.0.1:$p/api/health" -TimeoutSec 3
        "{0}: profile={1} id={2} label={3}" -f $p, $h.profile, $h.engine.id, $h.engine.label }
  catch { "${p}: nothing" }
}
```

Carry on only if:

- the computer name is `VEDAHPENVY`, **and**
- one port answers `profile=veda` (her engine; note its port), **and**
- the port answering `profile=tony` reports id **`eng_f2a5dcf41f29`**.

If a tony engine answers with any other id, **stop**: that is not the engine
this plan is about. If no tony engine answers at all, it may only be stopped
right now: skip to step 2 and retire its tasks and folders anyway.

### 2. Find where the old engine runs from, and what starts it

```powershell
# the process listening on the tony port (usually 8000)
$tp = 8000
$owner = (Get-NetTCPConnection -LocalPort $tp -State Listen -ErrorAction SilentlyContinue).OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=$owner" | Select ProcessId, ExecutablePath, CommandLine

# every MAGI scheduled task, with what it runs
Get-ScheduledTask | Where-Object TaskName -like 'MAGI*' | ForEach-Object {
  $a = $_.Actions[0]
  "{0} | {1} | {2} {3} | in {4}" -f $_.TaskName, $_.State, $a.Execute, $a.Arguments, $a.WorkingDirectory
}
```

The **old engine's tasks** are every MAGI task whose arguments do **not**
contain `--profile veda`. Expect `MAGI Cloud` + `MAGI Watchdog` (Downloads
copy), or `MAGI Engine` + `MAGI Watchdog` (A1 copy), or both. Tasks named
`... (veda)` are hers. **Leave them alone.**

Note the old engine's folder: the `WorkingDirectory` of its tasks, or the
folder its `pythonw.exe` lives under.

### 3. Switch off its autostart, then stop it

The autostart goes first, or its watchdog restarts the engine within two
minutes of you stopping it.

```powershell
# for EACH old task found in step 2 (example names; use the real ones):
Disable-ScheduledTask -TaskName 'MAGI Cloud'    | Out-Null
Disable-ScheduledTask -TaskName 'MAGI Watchdog' | Out-Null
Disable-ScheduledTask -TaskName 'MAGI Engine'   | Out-Null   # only if it exists AND has no --profile veda
```

Disable them; don't unregister them yet. A disabled task can be re-enabled
in one line if anything turns out to depend on it.

Then stop the engine and only its own children (its browser windows and its
cloudflared):

```powershell
function Get-Tree($id) { $id; Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | ForEach-Object { Get-Tree $_.ProcessId } }
# $owner is from step 2 (re-run that line in a new shell); skip if nothing was listening
if ($owner) { $tree = Get-Tree $owner } else { $tree = @() }
$tree | Sort-Object -Descending | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
```

The old engine's cloudflared may not be its child (the A1 engine leaves its
tunnel running across restarts). Find it by the port it forwards to, and stop
only that one:

```powershell
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
  Where-Object { $_.CommandLine -match "127\.0\.0\.1:$tp\b|localhost:$tp\b" } |
  ForEach-Object { "stopping cloudflared $($_.ProcessId): $($_.CommandLine)"; Stop-Process -Id $_.ProcessId -Force }
```

If a cloudflared line points at **her** port, it is hers. Leave it.

### 4. ASK Veda about her old history

> "Your old MAGI (from before you had your own profile) is now stopped. Its
> files, including any old deliberations, are being kept, just moved out of
> the way. Do you want anything from it, or is it fine to archive?"

Whatever she says, step 5 only moves the files. If she wants something from
it, say where the files are (step 5's folder) and stop there. Copying old
runs into her new engine is not part of this plan.

### 5. Move its files aside

Into one folder outside A1, so nothing in A1 can mistake it for an engine
again. That matters: `magi\restart.ps1` with no `-Profile` picks **tony**
whenever `A1\magi\data\tony\engine.json` exists.

```powershell
$dest = "$env:USERPROFILE\MAGI-retired\tony-engine-$(Get-Date -Format yyyy-MM-dd)"
New-Item -ItemType Directory -Force $dest | Out-Null

# A1 copy (only if these exist on this PC)
if (Test-Path magi\data\tony)     { Move-Item magi\data\tony     "$dest\A1-data-tony" }
if (Test-Path magi\profiles\tony) { Move-Item magi\profiles\tony "$dest\A1-profiles-tony" }

# Downloads copy: move the whole folder, if that is where step 2 found it
if (Test-Path "$env:USERPROFILE\Downloads\MAGI") { Move-Item "$env:USERPROFILE\Downloads\MAGI" "$dest\Downloads-MAGI" }
```

Check `magi\data\veda` and `magi\profiles\veda` are still where they were.

If a move fails with "in use", a process from step 3 is still running. Find
it (`Get-Process | Where-Object Path -like "$((Resolve-Path magi).Path)*"`,
or the Downloads path), stop **only** processes whose command line has no
`--profile veda`, and retry.

Leave the `MAGI_API_TOKEN` user environment variable alone. It was the old
engine's token, nothing of hers reads it (hers is `MAGI_API_TOKEN_VEDA`), and
removing it gains nothing.

### 6. Verify

```powershell
# 1. no tony engine answers anywhere; hers still does
foreach ($p in 8000, 8001, 8002) {
  try { $h = Invoke-RestMethod "http://127.0.0.1:$p/api/health" -TimeoutSec 3; "${p}: $($h.profile) $($h.engine.id)" }
  catch { "${p}: nothing" } }

# 2. her tasks are Ready/Running; the old ones are Disabled
Get-ScheduledTask | Where-Object TaskName -like 'MAGI*' | Select TaskName, State

# 3. a plain restart now picks HER engine (it is the only one left in magi\data)
powershell -ExecutionPolicy Bypass -File magi\restart.ps1
```

Pass when: only `veda` answers, every old task is `Disabled`, her two tasks
are not, and the plain restart reports her engine coming back on her port.

Then wait about 3 minutes and run check 1 again. A tony engine that has come
back means a task was missed in step 3. Find it and disable it.

Finally, open MAGI in Veda's Brave on her profile. The status at the bottom
left of the sidebar should say her engine is connected. Her Engines window
(click that status) should list only her own machine(s).

### 7. Record it

1. In [magi-plan.md](magi-plan.md), find the note *"this PC also runs a
   **tony**-profile engine on :8000"* (Phase 14 area) and add one line under
   it: `Retired <date>: tasks disabled, files in %USERPROFILE%\MAGI-retired\.`
2. In [magi-setup.md](magi-setup.md), in the "onboard says **port 8001**"
   row, add: `(Retired on Veda's PC <date> — see magi-veda-retire-old-engine.md.)`
3. At the top of **this** file, add `**DONE <date>** — <one line of what was
   found and moved>` under the title, so nobody runs it twice.
4. Commit and push (`git pull --rebase --autostash` first).

## Undo

Everything is reversible:

- **Files**: move them back from `%USERPROFILE%\MAGI-retired\tony-engine-<date>\`
  to where they came from.
- **Tasks**: `Enable-ScheduledTask -TaskName '<name>'`, then
  `Start-ScheduledTask -TaskName '<name>'`.

Once a month has passed with nothing missed, the folder and the disabled
tasks can be deleted (`Unregister-ScheduledTask -TaskName '<name>'
-Confirm:$false`). Ask Veda first.
