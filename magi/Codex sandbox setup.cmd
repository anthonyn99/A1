@echo off
rem Double-click to set up Codex's protected sandbox for MAGI (once per PC).
rem Why: magi\code\agents\codex_sandbox.py. MAGI uses Codex only inside it.
title MAGI - set up Codex's protected sandbox
echo.
echo  Setting up Codex's protected sandbox for MAGI.
echo  If Windows asks "Do you want to allow this app to make changes?", click Yes.
echo.
where codex >nul 2>nul
if errorlevel 1 (
  echo  Codex is not installed on this PC, so there is nothing to set up.
  echo.
  pause
  exit /b 1
)
set "OUT=%TEMP%\magi-codex-sandbox.txt"
call codex sandbox -c windows.sandbox=elevated -- cmd /c echo magi-sandbox-ok > "%OUT%" 2>&1
findstr /c:"magi-sandbox-ok" "%OUT%" >nul
if errorlevel 1 (
  echo  It did not finish. What Codex said:
  type "%OUT%"
  echo.
  echo  Run this file again and click Yes on the Windows prompt.
) else (
  echo  Done. Codex is protected, and MAGI will use it again within a minute.
  echo  You can close this window.
)
del "%OUT%" 2>nul
echo.
pause
