<#
    Set up a MAGI engine on this PC, from a clone of A1, in one command.

        powershell -ExecutionPolicy Bypass -File magi\setup.ps1 -Profile veda

    Written for Veda's PC (docs/magi-setup.md is what a Claude session there
    reads and runs), and it works for any profile on any Windows PC. It ends
    with the engine running, starting at every logon, reachable from the
    hosted console, and A1 registered in Code Mode -- identical to Tony's.
    What only a person can do is signing in, all of it from the console's
    Accounts view; the last lines printed list exactly what.

    Idempotent: re-running repairs what is missing and leaves the rest alone
    (the API token is never regenerated -- that would unpair every device).

    Steps:
      1. pull A1 (Tony and Veda both push to it);
      2. prerequisites -- Python 3.11+, Node.js, Google Chrome, git --
         installed with winget when missing;
      3. the venv and MAGI's Python packages;
      4. the Claude Code and Codex CLIs (npm, global);
      5. `magi onboard --profile <p>`: data folders, engine identity, port
         (8000 on a PC of its own), the API token (setx), Playwright's
         Chromium, the logon tasks;
      6. start the engine (magi\restart.ps1 -Profile <p>) and wait for it;
      7. register A1 as a Code Mode project on this engine;
      8. check it: the engine answers as <p>, and print the sign-ins.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][Alias("Profile")][string]$Who,
    [string]$Label = "",
    [switch]$NoAutostart,
    [switch]$SkipPrereqs
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # ...\A1
$Who = $Who.ToLower()
if (-not $Label) { $Label = (Get-Culture).TextInfo.ToTitleCase($Who) + " PC" }
$venvPy = Join-Path $root "magi\.venv\Scripts\python.exe"
# `python -m magi` imports the magi package from the CURRENT directory: run
# from anywhere else (another clone of A1, say) it would set up THAT copy.
# Found in the first test run, which onboarded Tony's A1 instead of the clone.
Set-Location $root

function Step($n, $text) { Write-Host ""; Write-Host "[$n/8] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "      $text" -ForegroundColor Green }
function Note($text) { Write-Host "      $text" }
function Fail($text) { Write-Host "      $text" -ForegroundColor Red; exit 1 }
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
}
function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Winget-Install($id, $what) {
    if (-not (Have "winget")) { Fail "$what is missing and winget is not available: install $what by hand, then re-run." }
    Note "installing $what (winget $id)..."
    & winget install -e --id $id --silent --accept-package-agreements --accept-source-agreements | Out-Null
    Refresh-Path
}

Write-Host "Setting up MAGI for '$Who' on $env:COMPUTERNAME ($root)" -ForegroundColor White

# ── 1. pull ──────────────────────────────────────────────────────────────────
Step 1 "Pull A1"
if (Have "git") {
    $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & git -C $root pull --rebase --autostash 2>&1 | ForEach-Object { Note $_ }
    $ErrorActionPreference = $old
} else { Note "git not found yet; skipped (installed below)" }

# ── 2. prerequisites ─────────────────────────────────────────────────────────
Step 2 "Prerequisites"
function Find-Python {
    # The full path of a Python 3.11+, or $null. `py` first: python.exe on a
    # fresh Windows is often the Microsoft Store stub.
    $probe = "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)"
    foreach ($pre in @("-3.12", "-3", "")) {
        $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        try {
            if ($pre) { if (-not (Have "py")) { continue }; $v = & py $pre -c $probe 2>$null }
            else { if (-not (Have "python")) { continue }; $v = & python -c $probe 2>$null }
        } catch { $v = $null } finally { $ErrorActionPreference = $old }
        if ($LASTEXITCODE -eq 0 -and $v -and $v.Count -ge 2) {
            $parts = $v[0].Split(".")
            if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 11) { return $v[1] }
        }
    }
    return $null
}
if (-not $SkipPrereqs) {
    if (-not (Have "git")) { Winget-Install "Git.Git" "git" }
    $pyExe = Find-Python
    if (-not $pyExe) { Winget-Install "Python.Python.3.12" "Python 3.12"; $pyExe = Find-Python }
    if (-not $pyExe) { Fail "Python 3.11+ still not found. Install it from python.org, then re-run." }
    Ok "python  $pyExe"
    if (-not (Have "npm")) { Winget-Install "OpenJS.NodeJS.LTS" "Node.js" }
    if (-not (Have "npm")) { Fail "Node.js (npm) still not found. Install it from nodejs.org, then re-run." }
    Ok "node    $((& node --version))"
    $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ }
    if (-not $chrome) { Winget-Install "Google.Chrome" "Google Chrome" }
    Ok "chrome  present (the council's browser windows are real Chrome)"
} else {
    $pyExe = Find-Python
    Note "skipped (-SkipPrereqs)"
}

# ── 3. venv + packages ───────────────────────────────────────────────────────
Step 3 "Python environment"
if (-not (Test-Path $venvPy)) {
    if (-not $pyExe) { Fail "no Python to create the venv with" }
    & $pyExe -m venv (Join-Path $root "magi\.venv")
    if ($LASTEXITCODE -ne 0) { Fail "could not create magi\.venv" }
    Ok "created magi\.venv"
}
& $venvPy -m pip install --disable-pip-version-check -q -r (Join-Path $root "magi\requirements.txt")
if ($LASTEXITCODE -ne 0) { Fail "pip install failed (see above)" }
Ok "packages installed"

# ── 4. coding CLIs ───────────────────────────────────────────────────────────
Step 4 "Claude Code and Codex CLIs"
Refresh-Path
$need = @()
if (-not (Have "claude")) { $need += "@anthropic-ai/claude-code" }
if (-not (Have "codex")) { $need += "@openai/codex" }
if ($need.Count) {
    $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & npm install -g @need 2>&1 | Select-Object -Last 3 | ForEach-Object { Note $_ }
    $ErrorActionPreference = $old
    Refresh-Path
}
foreach ($c in @("claude", "codex")) {
    if (Have $c) { Ok "$c $((& $c --version 2>$null | Select-Object -First 1))" }
    else { Note "$c not on PATH yet -- open a new terminal and re-run if Code Mode does not list it" }
}

# ── 5. onboard ───────────────────────────────────────────────────────────────
Step 5 "Onboard the '$Who' engine"
$ob = @("-m", "magi", "onboard", "--profile", $Who, "--label", $Label)
if ($NoAutostart) { $ob += "--no-autostart" }
& $venvPy @ob
if ($LASTEXITCODE -ne 0) { Fail "magi onboard failed (see above)" }

# ── 6. start ─────────────────────────────────────────────────────────────────
Step 6 "Start the engine"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "magi\restart.ps1") -Profile $Who -Force
if ($LASTEXITCODE -ne 0) { Fail "the engine did not start (see magi\data\$Who\autostart.log)" }
$port = [int]((Get-Content (Join-Path $root "magi\data\$Who\engine.json") -Raw | ConvertFrom-Json).port)
$api = "http://127.0.0.1:$port"

# ── 7. A1 in Code Mode ───────────────────────────────────────────────────────
Step 7 "Register A1 in Code Mode"
try {
    $state = Invoke-RestMethod "$api/api/code/state" -TimeoutSec 20
    $a1 = @($state.projects | Where-Object { $_.name -eq "A1" })
    if ($a1.Count) { Ok "A1 already registered ($($a1[0].id))" }
    else {
        $body = @{ name = "A1"; root = $root } | ConvertTo-Json
        $r = Invoke-RestMethod "$api/api/code/projects" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 30
        if ($r.ok) { Ok "A1 registered ($($r.project.id)) at $root" } else { Note "could not register A1: $($r.message)" }
    }
} catch { Note "could not reach Code Mode: $($_.Exception.Message)" }

# ── 8. check ─────────────────────────────────────────────────────────────────
Step 8 "Check"
$h = Invoke-RestMethod "$api/api/health" -TimeoutSec 10
if ($h.profile -ne $Who) { Fail "the engine on $port answers as '$($h.profile)', not '$Who'" }
Ok "engine '$($h.engine.label)' answers as $Who on port $port"
# This profile's own task: Tony's is "MAGI Engine", anyone else's "MAGI Engine (<p>)".
$task = if ($Who -eq "tony") { "MAGI Engine" } else { "MAGI Engine ($Who)" }
$tasks = @(schtasks /query /fo csv /nh 2>$null | Where-Object { $_ -like "*`"\$task`"*" })
if ($tasks.Count) { Ok "starts at every logon (scheduled task)" } elseif ($NoAutostart) { Note "autostart skipped (-NoAutostart)" } else { Note "no logon task found -- run: magi\.venv\Scripts\python -m magi autostart on --profile $Who" }

Write-Host ""
Write-Host "Done. The engine is running. What only $((Get-Culture).TextInfo.ToTitleCase($Who)) can do, all in the console:" -ForegroundColor White
Write-Host "  1. Open https://anthonyn99.github.io/A1/magi.html on this PC, pick $((Get-Culture).TextInfo.ToTitleCase($Who)), unlock."
Write-Host "     (If Chrome asks to let the page reach devices on this network, Allow -- that is this engine.)"
Write-Host "  2. Accounts > each council unit > Sign in: a Chrome window opens; sign in by hand."
Write-Host "  3. Accounts > Coding agents: Claude uses this PC's Claude Code login (already signed in if"
Write-Host "     Claude Code runs here); Codex > Sign in shows a code to enter at OpenAI."
Write-Host "  4. Accounts > GitHub > Add a token (fine-grained; Contents: Read and write on A1)."
Write-Host "  Phones and other PCs pick the engine up by themselves once step 1 has connected."
