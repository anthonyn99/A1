<#
    Restart the MAGI engine.

    The engine is a long-running process started at logon by the Startup
    shortcut (MAGI.lnk -> magi\.venv\Scripts\pythonw.exe -m magi cloud). It
    loads its Python at import, so ANY change under magi\ is inert until this
    has run -- a browser refresh does nothing for it.

    What it does:
      1. refuses while a deliberation is in flight (a MAGI Chrome is open),
         unless -Force;
      2. kills the engine process TREE, which takes cloudflared with it;
      3. starts it again exactly as the Startup shortcut does, detached and
         windowless, so it outlives this shell;
      4. waits for the API to answer on 127.0.0.1:8000 and reports.

    A restart gives phones a NEW tunnel address: the engine publishes it to
    magi-link, and a phone picks it up within a minute or two.

    Usage:  powershell -ExecutionPolicy Bypass -File magi\restart.ps1 [-Force]
#>
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # ...\A1
$py = Join-Path $root "magi\.venv\Scripts\pythonw.exe"
if (-not (Test-Path $py)) { throw "No engine interpreter at $py" }

# 1. Is a run in flight? A MAGI Chrome open means a member or a Studio card is
#    mid-answer, and killing the engine would lose it.
$busy = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
          Where-Object { $_.CommandLine -match [regex]::Escape("$root\magi\profiles") })
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
function Stop-Tree([int]$processId) {
    if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return }
    Write-Host "stopping PID $processId"
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & taskkill /f /t /pid $processId | Out-Null } catch { }
    $ErrorActionPreference = $old
}

$engines = @(Get-CimInstance Win32_Process -Filter "name='pythonw.exe'" |
             Where-Object { $_.CommandLine -match "-m magi cloud" })
foreach ($e in $engines) { Stop-Tree $e.ProcessId }
# Anything still holding the port (a stray cloudflared or a previous engine).
foreach ($c in @(Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)) {
    Stop-Tree $c.OwningProcess
}
Start-Sleep -Seconds 1

# 3. Start, the way the Startup shortcut does: pythonw (no console window),
#    working directory A1, detached from this shell.
Start-Process -FilePath $py -ArgumentList "-m", "magi", "cloud" -WorkingDirectory $root -WindowStyle Hidden
Write-Host "engine starting..."

# 4. Wait for it to answer.
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/providers" -TimeoutSec 4 -UseBasicParsing
        if ($r.StatusCode -eq 200) {
            $pid8000 = (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue).OwningProcess
            Write-Host "MAGI engine is up on 127.0.0.1:8000 (PID $pid8000)." -ForegroundColor Green
            Write-Host "Phones: the tunnel address changes on every restart; it republishes within a minute or two."
            exit 0
        }
    } catch { }
}
Write-Host "Engine did not answer on 127.0.0.1:8000 within 60s. Check magi\data\ logs." -ForegroundColor Red
exit 1
