@echo off
REM ===========================================================================
REM  Shield launcher.
REM
REM  Copy this file anywhere you like - Desktop, taskbar, Start menu. It works
REM  from inside the A1 folder and from outside it:
REM
REM    * Run from inside A1  -> rebuilds the agent first if its source changed,
REM                             then starts it.
REM    * Run from elsewhere  -> starts the installed agent directly.
REM
REM  The UI never needs anything: the agent re-fetches shield.html from the web
REM  with a cache-buster every time it launches, so edits to the page are always
REM  picked up. Tray > Reload UI does the same without restarting.
REM ===========================================================================
setlocal

set "LAUNCH=%~dp0desktop\shield\launch.ps1"
if exist "%LAUNCH%" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%LAUNCH%" %*
  exit /b %errorlevel%
)

REM Copied away from the repo - just start the installed agent.
set "EXE=%LOCALAPPDATA%\Shield\shield-agent.exe"
if exist "%EXE%" (
  start "" "%EXE%"
  exit /b 0
)

echo.
echo   Shield is not installed on this PC.
echo.
echo   From the A1 folder, run:   desktop\shield\build.ps1 -Update
echo   ^(needs Rust + VS Build Tools - see desktop\shield\README.md^)
echo.
pause
exit /b 1
