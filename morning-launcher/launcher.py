"""
Morning Launcher
================
At 6 AM Mountain Time (auto-handles DST), opens:
  - WeBull Desktop   →  left   panel
  - TradeHub         →  middle panel  (browser window)
  - TaskHub          →  right  panel  (browser window)

USAGE
-----
  1. Tweak the layout coordinates below if windows land in the wrong spot.
  2. Run ONCE as Administrator to install into Task Scheduler:
         python launcher.py --setup
  3. Done. Runs silently at every login from now on.

  To remove:   python launcher.py --uninstall
  Manual run:  python launcher.py
  Logs:        morning-launcher/launcher.log
"""

# ==============================================================================
#  LAYOUT — pixel coordinates on your 5120 × 1440 ultrawide
#  Format: [left_x, top_y, width, height]
#  Tweak widths until each window lands where you want it.
# ==============================================================================

SCREEN_W = 5120
SCREEN_H = 1440

WEBULL_POS   = [   0, 0, 1700, SCREEN_H]   # ← left   (~33 %)
TRADEHUB_POS = [1700, 0, 1720, SCREEN_H]   # ← middle (~33 %)
TASKHUB_POS  = [3420, 0, 1700, SCREEN_H]   # ← right  (~33 %)

# ==============================================================================
#  URLs
# ==============================================================================

TRADEHUB_URL = "https://anthonyn99.github.io/A1/tradehub.html"
TASKHUB_URL  = "https://anthonyn99.github.io/A1/"

# ==============================================================================
#  TRIGGER TIME
# ==============================================================================

TRIGGER_HOUR = 6   # 6 = 6:00 AM Mountain Time

# ==============================================================================
#  EXECUTABLE PATHS  (auto-detected — override here if detection fails)
# ==============================================================================

WEBULL_EXE_OVERRIDE = r""   # e.g. r"C:\Program Files (x86)\Webull Desktop\Webull Desktop.exe"
BROWSER_EXE_OVERRIDE = r""  # e.g. r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# ==============================================================================
#  END OF CONFIGURATION
# ==============================================================================

import argparse
import ctypes
import ctypes.wintypes as wt
import subprocess
import sys
import time
from datetime import date, datetime
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve()
STATE_FILE  = SCRIPT_PATH.parent / ".last_run"
LOG_FILE    = SCRIPT_PATH.parent / "launcher.log"
TASK_NAME   = "MorningLauncher"
TASK_FOLDER = "\\Custom\\"

try:
    from zoneinfo import ZoneInfo
    _MOUNTAIN_TZ = ZoneInfo("America/Denver")
except Exception:
    _MOUNTAIN_TZ = None


# ──────────────────────────────────────────────────────────────────────────────
# Time / timezone
# ──────────────────────────────────────────────────────────────────────────────

def mountain_now() -> datetime:
    if _MOUNTAIN_TZ:
        return datetime.now(tz=_MOUNTAIN_TZ)
    # Fallback: ask Windows — works even without tzdata installed
    raw = subprocess.check_output(
        ["powershell", "-NoProfile", "-Command",
         "[System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId("
         "[datetime]::Now,'Mountain Standard Time').ToString('yyyy-MM-dd HH:mm:ss')"],
        text=True
    ).strip()
    return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")


def seconds_until_trigger() -> float:
    now    = mountain_now()
    target = now.replace(hour=TRIGGER_HOUR, minute=0, second=0, microsecond=0)
    return max((target - now).total_seconds(), 0.0)


# ──────────────────────────────────────────────────────────────────────────────
# State / logging
# ──────────────────────────────────────────────────────────────────────────────

def already_ran_today() -> bool:
    return STATE_FILE.exists() and STATE_FILE.read_text().strip() == str(date.today())


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


# ──────────────────────────────────────────────────────────────────────────────
# Win32 window helpers  (ctypes only — no extra packages)
# ──────────────────────────────────────────────────────────────────────────────

_u32           = ctypes.windll.user32
_WNDENUMPROC   = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
_SW_RESTORE    = 9
_SWP_NOZORDER  = 0x0004
_SWP_NOACTIVATE = 0x0010


def _all_visible_hwnds() -> list:
    out = []
    @_WNDENUMPROC
    def cb(hwnd, _):
        if _u32.IsWindowVisible(hwnd) and _u32.GetWindowTextLengthW(hwnd) > 0:
            out.append(hwnd)
        return True
    _u32.EnumWindows(cb, 0)
    return out


def _hwnd_pid(hwnd) -> int:
    pid = wt.DWORD()
    _u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def _hwnd_title(hwnd) -> str:
    n = _u32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    _u32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _place(hwnd, x: int, y: int, w: int, h: int):
    _u32.ShowWindow(hwnd, _SW_RESTORE)
    time.sleep(0.25)
    _u32.SetWindowPos(hwnd, 0, x, y, w, h, _SWP_NOZORDER | _SWP_NOACTIVATE)


def _wait_for_pid_window(pid: int, timeout: int = 40) -> int | None:
    """Return first visible top-level HWND owned by pid, or None on timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for hwnd in _all_visible_hwnds():
            if _hwnd_pid(hwnd) == pid:
                return hwnd
        time.sleep(1)
    return None


def _wait_for_title_window(substr: str, timeout: int = 40) -> int | None:
    """Return first visible HWND whose title contains substr (case-insensitive)."""
    sub = substr.lower()
    deadline = time.time() + timeout
    while time.time() < deadline:
        for hwnd in _all_visible_hwnds():
            if sub in _hwnd_title(hwnd).lower():
                return hwnd
        time.sleep(1)
    return None


def _wait_for_new_window(known: set, timeout: int = 25) -> int | None:
    """Return first HWND that appears after `known` was snapshotted."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        current = set(_all_visible_hwnds())
        new = current - known
        if new:
            return next(iter(new))
        time.sleep(0.8)
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Executable detection
# ──────────────────────────────────────────────────────────────────────────────

def _find_webull() -> str | None:
    if WEBULL_EXE_OVERRIDE and Path(WEBULL_EXE_OVERRIDE).exists():
        return WEBULL_EXE_OVERRIDE
    candidates = [
        r"C:\Program Files (x86)\Webull Desktop\Webull Desktop.exe",
        r"C:\Program Files\Webull Desktop\Webull Desktop.exe",
        Path.home() / "AppData" / "Local" / "Webull" / "Webull.exe",
        Path.home() / "AppData" / "Local" / "Programs" / "Webull Desktop" / "Webull Desktop.exe",
    ]
    for p in candidates:
        if Path(p).exists():
            return str(p)
    return None


def _find_browser() -> str | None:
    """Find Chrome or Edge — both support --window-position/--window-size flags."""
    if BROWSER_EXE_OVERRIDE and Path(BROWSER_EXE_OVERRIDE).exists():
        return BROWSER_EXE_OVERRIDE
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        Path.home() / "AppData" / "Local" / "Google" / "Chrome" / "Application" / "chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for p in candidates:
        if Path(p).exists():
            return str(p)
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Opening each app
# ──────────────────────────────────────────────────────────────────────────────

def open_webull():
    exe = _find_webull()
    if not exe:
        log("ERROR: WeBull not found. Set WEBULL_EXE_OVERRIDE at the top of this file.")
        return

    x, y, w, h = WEBULL_POS
    log("Launching WeBull...")
    proc = subprocess.Popen([exe])

    # WeBull (Electron) may hand off to a child process; try PID first, then title
    hwnd = _wait_for_pid_window(proc.pid, timeout=30)
    if hwnd is None:
        log("PID lookup failed — searching by window title...")
        hwnd = _wait_for_title_window("webull", timeout=20)

    if hwnd is None:
        log("WARNING: WeBull window not found; it may not be positioned correctly.")
        return

    time.sleep(2)   # let WeBull finish painting before we resize it
    _place(hwnd, x, y, w, h)
    log(f"WeBull → ({x},{y}) {w}×{h}")


def _open_browser_window(browser: str, url: str, pos: list, known_before: set) -> set:
    x, y, w, h = pos
    snapshot = set(_all_visible_hwnds())   # snapshot just before launch

    subprocess.Popen([
        browser,
        f"--window-position={x},{y}",
        f"--window-size={w},{h}",
        "--new-window",
        url,
    ])

    # Force-place the new window even if the flags were ignored (Chrome single-instance)
    hwnd = _wait_for_new_window(snapshot, timeout=20)
    if hwnd:
        time.sleep(1)
        _place(hwnd, x, y, w, h)
    else:
        log(f"WARNING: browser window for {url} not detected in time.")

    return set(_all_visible_hwnds())   # updated snapshot for next call


def open_browser_windows():
    browser = _find_browser()
    if not browser:
        log("ERROR: Chrome/Edge not found. Set BROWSER_EXE_OVERRIDE at the top of this file.")
        return

    before = set(_all_visible_hwnds())

    log(f"Opening TradeHub...")
    before = _open_browser_window(browser, TRADEHUB_URL, TRADEHUB_POS, before)
    time.sleep(1.5)

    log(f"Opening TaskHub...")
    _open_browser_window(browser, TASKHUB_URL, TASKHUB_POS, before)


# ──────────────────────────────────────────────────────────────────────────────
# Main morning routine
# ──────────────────────────────────────────────────────────────────────────────

def run_morning():
    if already_ran_today():
        return

    wait = seconds_until_trigger()
    if wait > 0:
        log(f"Logged in early — waiting {wait / 60:.1f} min until {TRIGGER_HOUR}:00 AM MT")
        time.sleep(wait)

    log("=== Morning launch starting ===")
    open_webull()
    open_browser_windows()
    mark_ran()
    log("=== Done ===")


# ──────────────────────────────────────────────────────────────────────────────
# Task Scheduler setup / uninstall
# ──────────────────────────────────────────────────────────────────────────────

def _pythonw() -> str:
    exe = Path(sys.executable)
    pw  = exe.parent / "pythonw.exe"
    return str(pw) if pw.exists() else str(exe)


def setup():
    print("Installing tzdata for timezone support...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "tzdata"])

    pw       = _pythonw()
    script   = str(SCRIPT_PATH)
    work_dir = str(SCRIPT_PATH.parent)

    ps = f"""
$action   = New-ScheduledTaskAction -Execute '{pw}' -Argument '"{script}"' -WorkingDirectory '{work_dir}'
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '{TASK_NAME}' -TaskPath '{TASK_FOLDER}' -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Opens WeBull + TradeHub + TaskHub at {TRIGGER_HOUR} AM Mountain Time' -Force
Write-Host 'Registered.'
"""
    result = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                            capture_output=True, text=True)
    if result.returncode != 0:
        print("ERROR: Could not register task. Try running as Administrator.")
        print(result.stderr)
        sys.exit(1)
    print(result.stdout.strip())
    print(f"\nInstalled as '{TASK_FOLDER}{TASK_NAME}'. Logs → {LOG_FILE}")


def uninstall():
    ps = (f"Unregister-ScheduledTask -TaskName '{TASK_NAME}' "
          f"-TaskPath '{TASK_FOLDER}' -Confirm:$false")
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       capture_output=True, text=True)
    print("Removed." if r.returncode == 0 else f"Error: {r.stderr}")


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Morning Launcher")
    parser.add_argument("--setup",     action="store_true", help="Install into Task Scheduler (run as Admin)")
    parser.add_argument("--uninstall", action="store_true", help="Remove from Task Scheduler")
    args = parser.parse_args()

    if args.setup:
        setup()
    elif args.uninstall:
        uninstall()
    else:
        run_morning()
