"""
Morning Launcher
================
Opens your programs and websites every morning at 6 AM Mountain Time (auto-handles DST).
Runs once per calendar day — safe to leave running across reboots and re-logins.

USAGE
-----
  1. Edit the PROGRAMS and URLS sections below.
  2. Run once as Administrator to register with Task Scheduler:
       python launcher.py --setup
  3. That's it. It will run silently at every login from now on.

  To remove it from Task Scheduler:
       python launcher.py --uninstall
"""

# ==============================================================================
# YOUR PROGRAMS  (edit this list)
# ==============================================================================
# Each entry is either:
#   - A plain string path:            r"C:\Program Files\App\app.exe"
#   - A list (path + arguments):      [r"C:\Program Files\App\app.exe", "--flag"]
# ==============================================================================

PROGRAMS = [
    # r"C:\Program Files\Mozilla Firefox\firefox.exe",
    # r"C:\Program Files\Slack\slack.exe",
    # [r"C:\Windows\System32\notepad.exe"],
]

# ==============================================================================
# YOUR WEBSITES  (edit this list)
# ==============================================================================
# Plain URL strings — they open in your default browser, in order.
# ==============================================================================

URLS = [
    # "https://gmail.com",
    # "https://calendar.google.com",
    # "https://reddit.com",
]

# ==============================================================================
# SETTINGS
# ==============================================================================

TRIGGER_HOUR = 6          # 6 = 6:00 AM Mountain Time
TASK_NAME    = "MorningLauncher"
TASK_FOLDER  = "\\Custom\\"

# ==============================================================================
# END OF CONFIGURATION — do not edit below unless you know what you're doing
# ==============================================================================

import argparse
import subprocess
import sys
import time
import webbrowser
from datetime import date, datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Timezone — zoneinfo is built into Python 3.9+.
# On Windows, it needs the 'tzdata' package (installed automatically by --setup).
# ---------------------------------------------------------------------------
try:
    from zoneinfo import ZoneInfo
    MOUNTAIN_TZ = ZoneInfo("America/Denver")
except Exception:
    # Fallback: ask Windows for Mountain Time via PowerShell (no packages needed)
    MOUNTAIN_TZ = None

SCRIPT_PATH = Path(__file__).resolve()
STATE_FILE  = SCRIPT_PATH.parent / ".last_run"
LOG_FILE    = SCRIPT_PATH.parent / "launcher.log"


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def mountain_now() -> datetime:
    if MOUNTAIN_TZ is not None:
        return datetime.now(tz=MOUNTAIN_TZ)
    # Fallback via PowerShell when tzdata isn't installed yet
    cmd = (
        "powershell -NoProfile -Command "
        "[System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId("
        "[datetime]::Now, 'Mountain Standard Time').ToString('yyyy-MM-dd HH:mm:ss')"
    )
    raw = subprocess.check_output(cmd, text=True).strip()
    return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")


def seconds_until_trigger() -> float:
    now    = mountain_now()
    target = now.replace(hour=TRIGGER_HOUR, minute=0, second=0, microsecond=0)
    delta  = (target - now).total_seconds()
    return max(delta, 0.0)


# ---------------------------------------------------------------------------
# State / logging
# ---------------------------------------------------------------------------

def already_ran_today() -> bool:
    if not STATE_FILE.exists():
        return False
    return STATE_FILE.read_text().strip() == str(date.today())


def mark_ran():
    STATE_FILE.write_text(str(date.today()))


def log(msg: str):
    try:
        ts = mountain_now().strftime("%Y-%m-%d %H:%M:%S MT")
    except Exception:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}\n"
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line)


# ---------------------------------------------------------------------------
# Launching
# ---------------------------------------------------------------------------

def launch_programs():
    for prog in PROGRAMS:
        try:
            cmd = prog if isinstance(prog, list) else [prog]
            subprocess.Popen(cmd)
        except Exception as e:
            log(f"ERROR opening program {prog!r}: {e}")


def open_urls():
    for url in URLS:
        try:
            webbrowser.open(url)
            time.sleep(0.8)   # small gap so browser tabs open in order
        except Exception as e:
            log(f"ERROR opening URL {url!r}: {e}")


# ---------------------------------------------------------------------------
# Main morning routine
# ---------------------------------------------------------------------------

def run_morning():
    if already_ran_today():
        return

    wait = seconds_until_trigger()
    if wait > 0:
        log(f"Logged in early — waiting {wait / 60:.1f} min until {TRIGGER_HOUR}:00 AM MT")
        time.sleep(wait)

    log(f"Running morning launch ({len(PROGRAMS)} program(s), {len(URLS)} URL(s))")
    launch_programs()
    open_urls()
    mark_ran()
    log("Done.")


# ---------------------------------------------------------------------------
# Task Scheduler setup / uninstall
# ---------------------------------------------------------------------------

def _find_pythonw() -> str:
    """Return path to pythonw.exe (silent Python, no console window)."""
    exe = Path(sys.executable)
    # sys.executable might be python.exe; look for pythonw.exe next to it
    candidate = exe.parent / "pythonw.exe"
    if candidate.exists():
        return str(candidate)
    return str(exe)   # fallback to python.exe if pythonw not found


def setup():
    print("Installing tzdata for timezone support...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "tzdata"])

    pythonw   = _find_pythonw()
    script    = str(SCRIPT_PATH)
    work_dir  = str(SCRIPT_PATH.parent)

    ps = f"""
$action   = New-ScheduledTaskAction -Execute '{pythonw}' -Argument '"{script}"' -WorkingDirectory '{work_dir}'
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '{TASK_NAME}' -TaskPath '{TASK_FOLDER}' -Action $action -Trigger $trigger -Settings $settings -Description 'Opens morning programs and websites at {TRIGGER_HOUR} AM Mountain Time' -Force
Write-Host 'Task registered successfully.'
"""
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print("ERROR: Could not register task. Try running this script as Administrator.")
        print(result.stderr)
        sys.exit(1)
    print(result.stdout.strip())
    print(f"\nDone! Morning Launcher will run at every login as '{TASK_FOLDER}{TASK_NAME}'.")
    print(f"Check {LOG_FILE} to confirm it's working.")


def uninstall():
    ps = f"Unregister-ScheduledTask -TaskName '{TASK_NAME}' -TaskPath '{TASK_FOLDER}' -Confirm:$false"
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print("Could not remove task (maybe it wasn't registered?).")
        print(result.stderr)
    else:
        print(f"Task '{TASK_FOLDER}{TASK_NAME}' removed.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Morning Launcher")
    parser.add_argument("--setup",     action="store_true", help="Register with Task Scheduler (run as Administrator)")
    parser.add_argument("--uninstall", action="store_true", help="Remove from Task Scheduler")
    args = parser.parse_args()

    if args.setup:
        setup()
    elif args.uninstall:
        uninstall()
    else:
        run_morning()
