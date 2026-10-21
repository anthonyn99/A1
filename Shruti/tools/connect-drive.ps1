# Gives the shruti-drive worker Tony's Google OAuth client (step 3 of
# "Connecting Google Drive" in Shruti/docs/README.md). Asks for the client id
# and secret (paste them from the Vault), stores both as Cloudflare secrets on
# account 2, then checks the worker sees them. Nothing is written to disk.
#
#   powershell -ExecutionPolicy Bypass -File Shruti\tools\connect-drive.ps1
$ErrorActionPreference = 'Stop'
$env:CLOUDFLARE_ACCOUNT_ID = 'dbde452fc0d60264a7e9339460b7188c'
Set-Location (Join-Path $PSScriptRoot '..\worker')

$id = (Read-Host 'Google client ID (ends in .apps.googleusercontent.com)').Trim()
if ($id -notmatch '\.apps\.googleusercontent\.com$') { Write-Host 'That does not look like a client ID.' -ForegroundColor Red; exit 1 }
$sec = Read-Host 'Google client secret (starts GOCSPX-)' -AsSecureString
$secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
if (-not $secret) { Write-Host 'No secret given.' -ForegroundColor Red; exit 1 }

$id | npx --no-install wrangler secret put GOOGLE_CLIENT_ID
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$secret | npx --no-install wrangler secret put GOOGLE_CLIENT_SECRET
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$secret = $null

Start-Sleep 3
$h = Invoke-RestMethod 'https://shruti-drive.av1-2.workers.dev/health'
if ($h.configured) { Write-Host "`nDone: the worker has the Google sign-in. Now: Shruti > Settings > Google Drive > Connect Google Drive." -ForegroundColor Green }
else { Write-Host "`nThe secrets were sent but /health still says not configured. Tell Claude." -ForegroundColor Yellow }
