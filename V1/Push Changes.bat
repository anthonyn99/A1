@echo off
REM ============================================================================
REM  V1 — Push Changes
REM
REM  Double-click this to send your work to GitHub. Cloudflare then updates the
REM  live apps by itself, so there is nothing else to open or click.
REM
REM  Deliberately a thin wrapper around scripts\push.ps1 — the real logic lives
REM  there so it can be read, edited and fixed like normal code.
REM ============================================================================
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\push.ps1"
endlocal
