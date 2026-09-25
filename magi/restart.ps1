<#
    Restart the MAGI engine.

    The engine is a long-running process started at logon by the Startup
    shortcut (MAGI.lnk -> magi\.venv\Scripts\pythonw.exe -m magi cloud). It
    loads its Python at import, so ANY change under magi\ is inert until this
    has run -- a browser refresh does nothing for it.

    What it does:
      1. refuses while a deliberation is in flight (a MAGI Chrome is open),
         unless -Force;
      2. kills the engine and its children, but LEAVES cloudflared running so
         the tunnel url survives and the new engine adopts it;
      3. starts it again exactly as the Startup shortcut does, detached and
         windowless, so it outlives this shell;
      4. waits for the API to answer on the engine's port and reports.

    Per profile: -Profile veda restarts Veda's engine (her port from
    magi\data\veda\engine.json, `--profile veda`, her token). Without it,
    the profile is the one onboarded on this PC -- Tony's where his engine
    lives, Veda's on a PC that only has hers -- so the same command works on
    both machines. The token is read from the USER environment (where
    `magi onboard` put it with setx), so a terminal opened before onboarding
    still starts an engine that has it.

    Phones keep the SAME address across a restart: the tunnel is left running
    and the new engine adopts it (magi/tunnel.py), so there is no wait for a
    fresh hostname to register in DNS.

    Usage:  powershell -ExecutionPolicy Bypass -File magi\restart.ps1 [-Force] [-Profile veda]
#>
[CmdletBinding()]
param([switch]$Force, [Alias("Profile")][string]$Who = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # ...\A1
$py = Join-Path $root "magi\.venv\Scripts\pythonw.exe"
if (-not (Test-Path $py)) { throw "No engine interpreter at $py" }

# Whose engine. Tony's if his is onboarded here; otherwise the one profile
# that is (Veda's own PC).
if (-not $Who) {
    $Who = "tony"
    if (-not (Test-Path (Join-Path $root "magi\data\tony\engine.json"))) {
        $only = @(Get-ChildItem (Join-Path $root "magi\data") -Directory -ErrorAction SilentlyContinue |
                  Where-Object { Test-Path (Join-Path $_.FullName "engine.json") })
        if ($only.Count -eq 1) { $Who = $only[0].Name }
    }
}
$Who = $Who.ToLower()
$port = 8000
$engineJson = Join-Path $root "magi\data\$Who\engine.json"
if (Test-Path $engineJson) {
    $rec = Get-Content $engineJson -Raw | ConvertFrom-Json
    if ($rec.port) { $port = [int]$rec.port }
} elseif ($Who -ne "tony") {
    # Never guess a port for someone else's engine: guessing 8000 once killed
    # Tony's engine while setting Veda's up in a test clone.
    Write-Host "No '$Who' engine is set up in $root. Run magi\setup.ps1 -Profile $Who first." -ForegroundColor Red
    exit 1
}

# Whatever answers on the port must be THIS profile's engine (or nothing).
# Another person's engine is never stopped to make room.
try {
    $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 3
    if ($h.profile -and $h.profile -ne $Who) {
        Write-Host "Port $port is $($h.profile)'s engine, not $Who's. Not touching it." -ForegroundColor Red
        exit 1
    }
} catch { }
$profileArgs = @()
if ($Who -ne "tony") { $profileArgs = @("--profile", $Who) }
$tokenName = if ($Who -eq "tony") { "MAGI_API_TOKEN" } else { "MAGI_API_TOKEN_$($Who.ToUpper())" }
$tok = [Environment]::GetEnvironmentVariable($tokenName, "User")
if ($tok) { Set-Item -Path "env:$tokenName" -Value $tok }
Write-Host "profile $Who, port $port"

# 1. Is a run in flight? A MAGI Chrome open means a member or a Studio card is
#    mid-answer, and killing the engine would lose it.
$busy = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
          Where-Object { $_.CommandLine -match [regex]::Escape("$root\magi\profiles\$Who") })
if ($busy.Count -gt 0 -and -not $Force) {
    Write-Host "MAGI is mid-run ($($busy.Count) browser(s) open). Re-run with -Force to restart anyway." -ForegroundColor Yellow
    exit 1
}

# 2. Stop. Kill the whole tree: the launcher spawns the real interpreter, which
#    spawns cloudflared; killing only the parent leaves both behind, and the
#    orphan keeps port 8000 so the new engine cannot bind it.
#    Killing a tree takes the children with it, so by the time the loop
#    reaches a child it is usually already gone -- taskkill then writes to
#    stderr, which under ErrorActionPreference=Stop aborted the script with
#    the engine down and not restarted. Each kill is therefore best-effort.
function Kill-Pid([int]$processId) {
    if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return }
    Write-Host "stopping PID $processId"
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & taskkill /f /pid $processId | Out-Null } catch { }
    $ErrorActionPreference = $old
}

# Walk the tree by parent id and kill everything EXCEPT cloudflared: the
# tunnel points at 127.0.0.1:8000, not at the engine process, so leaving it
# alive is what lets the new engine adopt the same url. Plain taskkill without
# /t is not enough on its own -- Playwright's Chromes are children too, and
# orphaning them would hold the profiles.
function Stop-Tree([int]$processId) {
    $all = Get-CimInstance Win32_Process
    $doomed = New-Object System.Collections.Generic.List[int]
    $frontier = @($processId)
    while ($frontier.Count -gt 0) {
        $next = @()
        foreach ($id in $frontier) {
            foreach ($child in @($all | Where-Object { $_.ParentProcessId -eq $id })) {
                if ($child.Name -eq "cloudflared.exe") { continue }
                $doomed.Add([int]$child.ProcessId)
                $next += [int]$child.ProcessId
            }
        }
        $frontier = $next
    }
    foreach ($id in $doomed) { Kill-Pid $id }
    Kill-Pid $processId
}

# THIS profile's engine only: Tony's has no --profile, anyone else's does.
$engines = @(Get-CimInstance Win32_Process -Filter "name='pythonw.exe'" |
             Where-Object { $_.CommandLine -match "-m magi cloud" -and
                            $_.CommandLine -like "*$root\magi\.venv*" -and
                            (($Who -eq "tony" -and $_.CommandLine -notmatch "--profile") -or
                             ($Who -ne "tony" -and $_.CommandLine -match "--profile $Who\b")) })
foreach ($e in $engines) { Stop-Tree $e.ProcessId }
# Anything still holding the port (a stray cloudflared or a previous engine).
# Checked above that it is not another profile's engine.
foreach ($c in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    Stop-Tree $c.OwningProcess
}
Start-Sleep -Seconds 1

# Pick up everything pushed, and any new package, before starting -- the same
# step the console's Restart button and the watchdog take (magi/selfupdate.py).
$pyc = Join-Path $root "magi\.venv\Scripts\python.exe"
try {
    Push-Location $root
    $upd = & $pyc -m magi.selfupdate 2>&1 | Out-String
    Write-Host ("update: " + $upd.Trim())
} catch { Write-Host "update skipped: $_" } finally { Pop-Location }

# 3. Start, the way the Startup shortcut does: pythonw (no console window),
#    working directory A1, detached from this shell.
Start-Process -FilePath $py -ArgumentList (@("-m", "magi", "cloud", "--port", "$port") + $profileArgs) -WorkingDirectory $root -WindowStyle Hidden
Write-Host "engine starting..."

# 4. Wait for it to answer.
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/providers" -TimeoutSec 4 -UseBasicParsing
        if ($r.StatusCode -eq 200) {
            $pidUp = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess
            Write-Host "MAGI engine ($Who) is up on 127.0.0.1:$port (PID $pidUp)." -ForegroundColor Green
            # Per profile since profiles landed. This read the pre-profile
            # magi\data\tunnel.json, which the migration left behind, so it
            # reported a stale hostname as "the same address as before" --
            # including after cloudflared had been killed and a new one opened.
            $t = Join-Path $root "magi\data\$Who\tunnel.json"
            if (Test-Path $t) {
                $rec = Get-Content $t -Raw | ConvertFrom-Json
                if ($rec.url) {
                    # Adopted means the phone keeps working without a pause; a
                    # fresh tunnel needs ~10s to be reachable and then publish.
                    if ($rec.published_at) {
                        Write-Host "Phones: $($rec.url) (published)"
                    } else {
                        Write-Host "Phones: $($rec.url) (publishing - usually under 10s)"
                    }
                }
            }
            exit 0
        }
    } catch { }
}
Write-Host "Engine did not answer on 127.0.0.1:$port within 60s. Check magi\data\$Who\autostart.log." -ForegroundColor Red
exit 1
