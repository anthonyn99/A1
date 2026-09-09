@echo off
setlocal EnableDelayedExpansion
title MAGI - Multi-Model Council
cd /d "%~dp0"

REM ===========================================================================
REM  MAGI launcher. One file, replacing MAGI.bat + MAGI-Login.bat +
REM  MAGI-Doctor.bat + MAGI-Cloud.ps1 from the original project.
REM
REM    magi              start MAGI and open the UI
REM    magi cloud        ...and publish a tunnel, so it works off this PC too
REM    magi login <site> sign in to chatgpt / claude / gemini / deepseek
REM    magi doctor       check which selectors still match
REM    magi ask "..."    run the council in the terminal
REM    magi autostart    run the engine at logon (then just bookmark the page)
REM    magi setup        rebuild the venv from scratch
REM
REM  Everything runs out of magi\.venv, created on first use. That is the only
REM  reason this file is short: the original spent 40 lines probing four
REM  candidate interpreters for one that had the dependencies, because "py"
REM  picks the NEWEST Python rather than the right one. A pinned venv makes the
REM  interpreter a fact instead of a search.
REM ===========================================================================

set "PYTHONIOENCODING=utf-8"
set "VENV=%~dp0magi\.venv"
set "PY=%VENV%\Scripts\python.exe"

if /i "%~1"=="setup" (
    if exist "%VENV%" rmdir /s /q "%VENV%"
    shift
)

if not exist "%PY%" call :bootstrap || exit /b 1

if "%~1"=="" (
    "%PY%" -m magi serve
    goto :done
)

"%PY%" -m magi %*

:done
if errorlevel 1 (
    echo.
    echo   MAGI exited with an error. See above.
    echo.
    pause
)
exit /b %errorlevel%


REM ===========================================================================
REM  First run: build the venv and install everything.
REM
REM  3.12 is pinned deliberately. This machine has no 3.11 (the version the
REM  project was verified against) and defaults to 3.14, which is further from
REM  that baseline than 3.12 is. Playwright's browser download also lands in
REM  the venv, so it can never drift from the interpreter using it.
REM ===========================================================================
:bootstrap
echo.
echo   First run - setting up MAGI. This takes a few minutes.
echo.
set "BASE="
for %%C in ("py -3.12" "py -3.13" "py -3.11" "py" "python") do (
    %%~C -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3,11) else 1)" >nul 2>&1
    if not errorlevel 1 (
        set "BASE=%%~C"
        goto :got_base
    )
)
:got_base
if not defined BASE (
    echo   [X] No Python 3.11+ found. Install one from python.org and rerun.
    echo.
    pause
    exit /b 1
)

echo   Creating venv with !BASE! ...
!BASE! -m venv "%VENV%" || exit /b 1
"%PY%" -m pip install --upgrade pip --quiet || exit /b 1
echo   Installing dependencies ...
"%PY%" -m pip install -r "%~dp0magi\requirements.txt" --quiet || exit /b 1
echo   Downloading Playwright's Chromium ...
REM Downloaded even though config\magi.yaml runs `channel: chrome` (your real
REM Chrome install) -- some Playwright internals expect the bundled browser to
REM be present regardless.
"%PY%" -m playwright install chromium || exit /b 1
echo.
echo   Setup complete.
echo.
exit /b 0
