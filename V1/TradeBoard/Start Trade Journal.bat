@echo off
REM ===========================================================================
REM  Start Trade Journal — Webull auto-sync launcher
REM  Installs the Webull SDK if needed, then runs the auto-sync server which
REM  pulls from Webull every 2 min and pushes to your cloud TradeBoard so every
REM  device (incl. the hosted site + your phone) updates live. Leave this window
REM  open; close it to stop syncing.
REM ===========================================================================
setlocal
cd /d "%~dp0"
title Trade Journal - Webull auto-sync

REM --- find Python ---
set "PY=python"
where python >nul 2>&1
if errorlevel 1 (
  where py >nul 2>&1
  if errorlevel 1 (
    echo.
    echo   Python isn't installed or not on PATH.
    echo   Install it from https://www.python.org/downloads/  ^(check "Add to PATH"^),
    echo   then double-click this file again.
    echo.
    pause
    exit /b 1
  )
  set "PY=py"
)

REM --- ensure the Webull SDK is present ---
%PY% -c "import webull" >nul 2>&1
if errorlevel 1 (
  echo Installing the Webull SDK ^(one time^)...
  %PY% -m pip install --quiet --disable-pip-version-check webull-openapi-python-sdk
  if errorlevel 1 (
    echo.
    echo   Couldn't install the Webull SDK. Check your internet connection and retry.
    echo.
    pause
    exit /b 1
  )
)

REM --- first-run config: create webull_config.json and open it for editing ---
if not exist "webull_config.json" (
  echo Creating webull_config.json - paste your Webull App Key + Secret, save, then rerun.
  > webull_config.json echo {
  >>webull_config.json echo   "app_key":    "your-app-key",
  >>webull_config.json echo   "app_secret": "your-app-secret",
  >>webull_config.json echo   "region_id":  "us",
  >>webull_config.json echo   "history_start": "2026-01-01"
  >>webull_config.json echo }
  notepad "webull_config.json"
  echo.
  echo   Saved your keys? Double-click this launcher again to start syncing.
  echo.
  pause
  exit /b 0
)

REM --- run the auto-sync server (syncs every 2 min + pushes to cloud) ---
echo Starting Webull auto-sync... (Ctrl+C or close this window to stop)
%PY% wb_server.py

pause
