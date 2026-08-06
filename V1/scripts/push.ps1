# ============================================================================
#  V1 — Push Changes
#  ---------------------------------------------------------------------------
#  Sends your work to GitHub. Cloudflare picks it up from there and updates the
#  live apps automatically, so there is no website to open and nothing to click.
#
#  Run it by double-clicking "Push Changes.bat" in the V1 folder.
#
#  Written to be SAFE rather than clever: it shows what changed and asks before
#  sending anything, it never force-pushes, and it stops with a plain-English
#  explanation instead of failing silently.
# ============================================================================

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Line { Write-Host ("-" * 62) -ForegroundColor DarkGray }
function Bye($code) {
  Write-Host ""
  Write-Host "Press any key to close..." -ForegroundColor DarkGray
  $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
  exit $code
}

Write-Host ""
Write-Host "  V1 - Push Changes" -ForegroundColor Magenta
Line

# --- Is git even available? ------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "  Git isn't installed on this PC, so nothing can be sent." -ForegroundColor Red
  Write-Host "  Install it from https://git-scm.com/download/win and try again."
  Bye 1
}

# --- What changed? ----------------------------------------------------------
$changes = git status --porcelain
if (-not $changes) {
  Write-Host "  Nothing has changed since the last push." -ForegroundColor Green
  Write-Host "  Everything on your PC is already on GitHub."
  Bye 0
}

$count = ($changes | Measure-Object).Count
Write-Host "  $count file(s) changed:" -ForegroundColor Yellow
Write-Host ""

# Show a readable list: "modified: Finance/finance.html" rather than "M  ..."
foreach ($line in ($changes | Select-Object -First 25)) {
  $code = $line.Substring(0, 2).Trim()
  $file = $line.Substring(3)
  $what = switch -Regex ($code) {
    '^\?\?' { 'new file' }
    '^A'    { 'new file' }
    '^D'    { 'deleted ' }
    '^R'    { 'renamed ' }
    default { 'modified' }
  }
  Write-Host "    $what  $file" -ForegroundColor Gray
}
if ($count -gt 25) { Write-Host "    ...and $($count - 25) more" -ForegroundColor DarkGray }

Line

# --- Describe the change ----------------------------------------------------
Write-Host "  Describe what you changed (or press Enter for a default):" -ForegroundColor Cyan
$msg = Read-Host "  "
if ([string]::IsNullOrWhiteSpace($msg)) {
  $msg = "Update $(Get-Date -Format 'MMM d, yyyy h:mm tt')"
}

# --- Confirm before anything leaves the machine -----------------------------
Write-Host ""
Write-Host "  Send these changes to GitHub? (Y/N)" -ForegroundColor Cyan
$ok = Read-Host "  "
if ($ok -notmatch '^[Yy]') {
  Write-Host ""
  Write-Host "  Cancelled - nothing was sent. Your files are untouched." -ForegroundColor Yellow
  Bye 0
}

Line

# --- Commit -----------------------------------------------------------------
Write-Host "  Saving..." -ForegroundColor DarkGray
git add -A
git commit -m $msg | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "  Could not save the changes." -ForegroundColor Red
  Write-Host "  Copy this window and send it to Claude."
  Bye 1
}

# --- Pull first, so a change made on another device isn't clobbered ---------
# --rebase replays your work on top of theirs; --autostash handles anything
# still uncommitted. This is why the script never needs to force-push.
Write-Host "  Checking for changes from your other devices..." -ForegroundColor DarkGray
git pull --rebase --autostash 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "  Your PC and GitHub both changed the same file, so they need to" -ForegroundColor Red
  Write-Host "  be merged by hand. Nothing was lost and nothing was sent."
  Write-Host "  Send Claude this message and he'll sort it out."
  Bye 1
}

# --- Push -------------------------------------------------------------------
Write-Host "  Sending to GitHub..." -ForegroundColor DarkGray
git push 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "  Couldn't reach GitHub." -ForegroundColor Red
  Write-Host "  Usually this means no internet, or GitHub wants you to sign in."
  Write-Host "  Your work IS saved on this PC - nothing is lost. Try again later."
  Bye 1
}

Line
Write-Host ""
Write-Host "  Done - your changes are on GitHub." -ForegroundColor Green
Write-Host ""
Write-Host "  Cloudflare is now updating the live apps by itself." -ForegroundColor Gray
Write-Host "  Give it about a minute, then refresh:" -ForegroundColor Gray
Write-Host "    https://tradeboard.vedapatel05.workers.dev/          (TradeBoard)" -ForegroundColor DarkGray
Write-Host "    https://tradeboard.vedapatel05.workers.dev/finance/  (Finance)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  If something looks wrong, check the Actions tab on GitHub for a" -ForegroundColor DarkGray
Write-Host "  red X, and send it to Claude." -ForegroundColor DarkGray
Bye 0
