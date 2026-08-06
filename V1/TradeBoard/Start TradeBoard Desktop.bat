@echo off
REM ===========================================================================
REM  Start TradeBoard Desktop — the scheduled app/site launcher
REM
REM  Runs TradeBoard in its own window instead of a browser tab. Same app, but
REM  the "Apps" tab can actually open and close programs on this PC, and its
REM  schedules keep running in the background (system tray, by the clock).
REM
REM  Close the window and it minimises to the tray so schedules keep firing.
REM  To really quit: right-click the tray icon -> Quit.
REM ===========================================================================
setlocal
cd /d "%~dp0"
title TradeBoard Desktop

REM Binaries land in the WORKSPACE target dir (desktop\target), not under
REM src-tauri — desktop\Cargo.toml defines a two-crate workspace.
set "REL=desktop\target\release\tradeboard-desktop.exe"
set "DBG=desktop\target\debug\tradeboard-desktop.exe"

REM --- refresh the bundled copy of the app so the shell shows the latest UI ---
where node >nul 2>&1
if not errorlevel 1 (
  node scripts\build-desktop.mjs >nul 2>&1
)

REM --- prefer the release build; fall back to a debug build if that's all there is ---
if exist "%REL%" (
  start "" "%REL%"
  exit /b 0
)
if exist "%DBG%" (
  echo Using the debug build ^(bigger and slower^).
  echo Run "npm run desktop:build" once for the fast release version.
  echo.
  start "" "%DBG%"
  exit /b 0
)

REM --- nothing built yet: build it now ---
echo TradeBoard Desktop hasn't been built yet. Building it now.
echo This takes a few minutes the first time, then it's instant.
echo.

REM Rust lives in %USERPROFILE%\.cargo\bin and MinGW under WinGet Packages;
REM add both so this works from a plain double-click with no PATH set up.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs*") do (
  if exist "%%D\mingw64\bin" set "PATH=%%D\mingw64\bin;%PATH%"
)

where cargo >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Rust isn't installed, so the desktop app can't be built.
  echo   See desktop\README.md for the one-time setup ^(no admin needed^).
  echo.
  pause
  exit /b 1
)

pushd desktop
cargo build --release
set "BUILD_ERR=%errorlevel%"
popd

if not "%BUILD_ERR%"=="0" (
  echo.
  echo   The build failed. See desktop\README.md for setup help.
  echo.
  pause
  exit /b 1
)

if exist "%REL%" (
  echo.
  echo Built. Starting TradeBoard Desktop...
  start "" "%REL%"
  exit /b 0
)

echo.
echo   Build reported success but the .exe is missing. Check desktop\README.md.
echo.
pause
exit /b 1
