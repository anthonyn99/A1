# =============================================================================
#  TradeBoard Auth Worker - setup + deploy  (Wrangler 4.x)
#  Run from the worker folder:
#     powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#
#  Steps: 1) ensure Cloudflare login  2) create LOCKS KV namespace
#         3) write KV id into wrangler.toml  4) deploy + print Worker URL
#
#  If login fails, run "npx wrangler login" by itself, finish it in the
#  browser, then re-run this script.
# =============================================================================
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSScriptRoot
Set-Location $here
$toml = Join-Path $here "wrangler.toml"

function WR { npx --yes wrangler@4 $args }

Write-Host ""
Write-Host "[1/5] wrangler version..." -ForegroundColor Cyan
WR --version | Out-Host

Write-Host ""
Write-Host "[2/5] Checking Cloudflare login..." -ForegroundColor Cyan
$who = (WR whoami 2>&1 | Out-String)
if ($who -match "not authenticated") {
  Write-Host "Not logged in. Opening the Cloudflare login in your browser..." -ForegroundColor Yellow
  Write-Host ">>> Approve the Wrangler authorization in the browser, then come back. <<<" -ForegroundColor Yellow
  WR login | Out-Host
  Start-Sleep -Seconds 2
  $who = (WR whoami 2>&1 | Out-String)
}
if ($who -match "not authenticated") {
  Write-Host ""
  Write-Host "[!] Still not authenticated. Run 'npx wrangler login' alone, finish it," -ForegroundColor Red
  Write-Host "    then re-run this script." -ForegroundColor Red
  exit 1
}
Write-Host "Authenticated." -ForegroundColor Green

Write-Host ""
Write-Host "[3/5] Creating KV namespace LOCKS..." -ForegroundColor Cyan
$kvOut = (WR kv namespace create LOCKS 2>&1 | Out-String)
Write-Host $kvOut

$hex32 = '[0-9a-f]{32}'
$kvId = $null
$m = [regex]::Match($kvOut, $hex32)
if ($m.Success) { $kvId = $m.Value }

if (-not $kvId) {
  Write-Host "Create did not yield an id - listing existing namespaces..." -ForegroundColor Yellow
  $list = (WR kv namespace list 2>&1 | Out-String)
  Write-Host $list
  try {
    $arr = ($list | ConvertFrom-Json)
    $found = $arr | Where-Object { $_.title -match "LOCKS" } | Select-Object -First 1
    if ($found) { $kvId = $found.id }
  } catch {
    Write-Host "Could not parse the namespace list as JSON." -ForegroundColor Yellow
  }
}

if (-not $kvId) {
  Write-Host ""
  Write-Host "[!] Could not determine the KV id. Copy the 32-char id from the output" -ForegroundColor Red
  Write-Host "    above, paste it into wrangler.toml (the id = line), run: npx wrangler deploy" -ForegroundColor Red
  exit 1
}
Write-Host "KV id: $kvId" -ForegroundColor Green

Write-Host ""
Write-Host "[4/5] Writing KV id into wrangler.toml..." -ForegroundColor Cyan
$content = Get-Content $toml -Raw
$content = [regex]::Replace($content, 'id\s*=\s*"[^"]*"', ('id = "' + $kvId + '"'))
Set-Content -Path $toml -Value $content -NoNewline
Write-Host "wrangler.toml updated."

Write-Host ""
Write-Host "[5/5] Deploying Worker..." -ForegroundColor Cyan
$deployOut = (WR deploy 2>&1 | Out-String)
Write-Host $deployOut

$workerUrl = $null
$um = [regex]::Match($deployOut, 'https://\S+\.workers\.dev')
if ($um.Success) { $workerUrl = $um.Value }

if ($workerUrl) {
  try {
    $h = Invoke-RestMethod -Uri ($workerUrl + "/health") -Method Get -TimeoutSec 20
    Write-Host ("Health: " + ($h | ConvertTo-Json -Compress)) -ForegroundColor Green
  } catch {
    Write-Host "Health check pending (worker may need a few seconds)." -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "=================================================================" -ForegroundColor Green
  Write-Host " DONE. Copy this Worker URL and give it to Claude:" -ForegroundColor Green
  Write-Host ("   " + $workerUrl) -ForegroundColor White
  Write-Host "=================================================================" -ForegroundColor Green
} else {
  Write-Host "Deploy finished but URL not auto-detected." -ForegroundColor Yellow
  Write-Host "Look for the *.workers.dev line above and send it to Claude." -ForegroundColor Yellow
}
