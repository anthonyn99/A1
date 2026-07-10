"""
Morning Launcher
================
On every market weekday (Mon–Fri, skipping NYSE holidays), the FIRST time you
wake / unlock / boot your laptop at or after 6 AM Mountain Time, it opens:
  - WeBull Desktop   →  left   panel
  - TradeHub         →  middle panel  (browser window)
  - TaskHub          →  right  panel  (Brave app shortcut)
  - ChatGPT          →  your selected TradeHub "Analysis" prompt, AUTO-SUBMITTED,
                        plus your configured Analysis search tabs

The ChatGPT step is the automated equivalent of clicking "Launch Analysis": it
fetches the prompt you picked in TradeHub's Analysis tab (TradeHub pushes it to the
trade-dashboard Cloudflare worker) and opens ChatGPT with that prompt already sent —
no manual paste / Enter. See the CHATGPT ANALYSIS AUTOMATION config block below.
PRECONDITION: stay signed in to ChatGPT in Brave's default profile.

NOTE: Editing this file's behavior does NOT require re-running --setup — Task
Scheduler runs the script fresh each trigger. Only re-run --setup if the TRIGGERS
or task settings change.

It fires on ALL of these so nothing is missed on a laptop:
  - waking from sleep + unlocking the screen   (session-unlock trigger)
  - a fresh boot / login                        (logon trigger)
  - already-on-and-unlocked at 6 AM             (daily trigger)
  - classic wake-from-sleep event               (power event trigger)
It only launches ONCE per day (first qualifying trigger wins), only on days the
US stock market is open, and it runs even when the laptop is on battery.

USAGE
-----
  1. Tweak the layout coordinates below if windows land in the wrong spot.
  2. Run ONCE to (re)install into Task Scheduler:
         python launcher.py --setup
     (If it complains about permissions, run that from an Administrator terminal.)
  3. Done. Runs silently from now on.

  To remove:   python launcher.py --uninstall
  Test now:    python launcher.py --test      (opens everything immediately)
  Logs:        morning-launcher/launcher.log

  NOTE: If you had an older version installed, you MUST re-run --setup so the new
  battery / unlock / market-day behavior takes effect.
"""

# ==============================================================================
#  LAYOUT — pixel coordinates on your 5120 × 1440 ultrawide
#  Format: [left_x, top_y, width, height]
#  Tweak widths until each window lands where you want it.
# ==============================================================================

SCREEN_W = 5120
SCREEN_H = 1440   # native panel height. The ACTUAL window height is auto-reduced at
                  # runtime to the work area (screen minus the Windows taskbar) so no
                  # window content ever hides behind the taskbar. See _apply_work_area().

# Three equal columns that exactly tile the 5120-wide screen (widths sum to 5120, no
# gaps). The height value here is a placeholder — _apply_work_area() overwrites it with
# the real usable height at launch. The launcher also compensates for Windows' invisible
# ~7px DWM window border (see _place) so the VISIBLE edges of the three windows sit
# perfectly flush against each other and the screen edges.
WEBULL_POS   = [   0, 0, 1707, SCREEN_H]   # ← left
TRADEHUB_POS = [1707, 0, 1706, SCREEN_H]   # ← middle
TASKHUB_POS  = [3413, 0, 1707, SCREEN_H]   # ← right

# ==============================================================================
#  URLs
# ==============================================================================

TRADEHUB_URL = "https://anthonyn99.github.io/A1/tradehub.html"
# TaskHub opens via its installed Brave app (app-id below) — no URL needed here

# ==============================================================================
#  CHATGPT ANALYSIS AUTOMATION
#  After the morning windows open, fetch the prompt you selected in TradeHub's
#  Analysis tab (TradeHub pushes it to this worker) and open ChatGPT with the
#  prompt already submitted — no manual paste / Enter.
#
#  HOW IT WORKS: the prompt goes in via CLIPBOARD PASTE — the launcher copies the
#  prompt, opens a plain ChatGPT window, focuses it, then sends Ctrl+V + Enter.
#  (We do NOT put the prompt in a chatgpt.com/?q=... URL: real prompts are long
#  enough that the URL + ChatGPT's auth cookies overflow the server's header limit
#  → HTTP 431. Pasting has no length cap.)
#
#  PRECONDITION: you must be signed in to ChatGPT in Brave's default profile, and
#  ChatGPT should open straight to the composer (no blocking modal stealing focus).
# ==============================================================================

CHATGPT_ANALYSIS_ENABLED = True   # master switch for the whole ChatGPT step
TD_WORKER_URL            = "https://trade-dashboard.av1.workers.dev"

# On the morning run, ChatGPT + searches open as TABS in the existing TradeHub window,
# so this position is only used in the standalone --test-chatgpt case (its own window).
CHATGPT_POS = [1707, 0, 1706, SCREEN_H]

# MAX seconds to wait for the ChatGPT tab to come to the front + finish loading before
# we paste. This is a cap, not a fixed delay — the launcher proceeds the instant the
# window title confirms ChatGPT is the active tab (usually 1–3s), so raising it only
# affects the slow/cold case. It never pastes until ChatGPT is confirmed in front.
CHATGPT_LOAD_WAIT = 12

# ==============================================================================
#  WEBULL POST-LAUNCH ACTIONS
#  After WeBull opens it lands on the Trading tab + Individual Cash account. These
#  clicks switch it to the Trackers tab and the Individual Margin account.
#
#  WeBull is a native app with no scripting API, so this is COORDINATE clicking. The
#  points below are pixel offsets from the WeBull window's TOP-LEFT corner, tuned for
#  the left-panel (1707px-wide) placement. If a click ever misses (e.g. WeBull changes
#  its layout), nudge these — or set WEBULL_AUTO_ACTIONS = False to disable.
# ==============================================================================

WEBULL_AUTO_ACTIONS = True
WEBULL_ACTION_DELAY = 9    # seconds to let WeBull finish loading (accounts populated) before clicking

# (x, y) offsets from the WeBull window's top-left:
WEBULL_TRACKERS_TAB   = (620, 54)    # the "Trackers" tab in the tab row
WEBULL_ACCOUNT_BUTTON = (1460, 19)   # top-right account dropdown ("Individual Cash(…)")
WEBULL_MARGIN_ITEM    = (1465, 146)  # "Individual Margin(…)" row in the opened dropdown

# ==============================================================================
#  TRIGGER WINDOW  (Mountain Time)
# ==============================================================================

TRIGGER_HOUR = 6    # Earliest launch time. Open before this → it waits until 6:00 AM.
LATEST_HOUR  = 12   # If your FIRST open of the day is at/after this hour (noon MT),
                    # it won't auto-launch — assumes you're not starting a trading day.

# ==============================================================================
#  EXECUTABLE PATHS  (auto-detected — override here if detection fails)
# ==============================================================================

WEBULL_EXE_OVERRIDE = r""   # e.g. r"C:\Program Files (x86)\Webull Desktop\Webull Desktop.exe"
BRAVE_EXE_OVERRIDE  = r""   # e.g. r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"

# TaskHub is installed as a Brave app shortcut — this is its app-id (do not change)
TASKHUB_APP_ID        = "eejkbnfcmekdcdpjpiocgkmnjabcieoj"
TASKHUB_PROFILE_DIR   = "Default"

# ==============================================================================
#  END OF CONFIGURATION
# ==============================================================================

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
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


def mountain_today() -> date:
    try:
        return mountain_now().date()
    except Exception:
        return date.today()


def seconds_until_trigger() -> float:
    now    = mountain_now()
    target = now.replace(hour=TRIGGER_HOUR, minute=0, second=0, microsecond=0)
    return max((target - now).total_seconds(), 0.0)


# ──────────────────────────────────────────────────────────────────────────────
# US stock market (NYSE) calendar
# ──────────────────────────────────────────────────────────────────────────────

def _easter(year: int) -> date:
    """Gregorian Easter Sunday (anonymous algorithm)."""
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day   = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """n-th `weekday` (Mon=0) of a month, e.g. 3rd Monday of January."""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return date(year, month, 1) + timedelta(days=offset + (n - 1) * 7)


def _last_weekday(year: int, month: int, weekday: int) -> date:
    """Last `weekday` (Mon=0) of a month, e.g. last Monday of May."""
    if month == 12:
        last = date(year, 12, 31)
    else:
        last = date(year, month + 1, 1) - timedelta(days=1)
    offset = (last.weekday() - weekday) % 7
    return last - timedelta(days=offset)


def _observed(d: date) -> date:
    """NYSE weekend-observation: Sat holiday → Fri before, Sun holiday → Mon after."""
    if d.weekday() == 5:      # Saturday
        return d - timedelta(days=1)
    if d.weekday() == 6:      # Sunday
        return d + timedelta(days=1)
    return d


def _observed_new_year(year: int) -> date:
    """New Year's Day is the ONE exception to the Sat→Fri rule: when Jan 1 falls on
    a Saturday the NYSE does NOT close the preceding Friday (Dec 31 stays a trading
    day). Sunday still rolls forward to Monday."""
    d = date(year, 1, 1)
    if d.weekday() == 6:      # Sunday → observed Monday
        return d + timedelta(days=1)
    return d                  # weekday as-is; Saturday → not observed (falls on weekend)


def _nyse_holidays(year: int) -> set:
    return {
        _observed_new_year(year),           # New Year's Day
        _nth_weekday(year, 1, 0, 3),        # MLK Jr. Day        (3rd Mon Jan)
        _nth_weekday(year, 2, 0, 3),        # Washington's Bday  (3rd Mon Feb)
        _easter(year) - timedelta(days=2),  # Good Friday
        _last_weekday(year, 5, 0),          # Memorial Day       (last Mon May)
        _observed(date(year, 6, 19)),       # Juneteenth
        _observed(date(year, 7, 4)),        # Independence Day
        _nth_weekday(year, 9, 0, 1),        # Labor Day          (1st Mon Sep)
        _nth_weekday(year, 11, 3, 4),       # Thanksgiving       (4th Thu Nov)
        _observed(date(year, 12, 25)),      # Christmas Day
    }


def is_market_day(d: date) -> bool:
    """True on a regular US-stock-market trading day (Mon–Fri, not an NYSE holiday)."""
    if d.weekday() >= 5:                    # Saturday / Sunday
        return False
    if d in _nyse_holidays(d.year):
        return False
    return True


# ──────────────────────────────────────────────────────────────────────────────
# State / logging
# ──────────────────────────────────────────────────────────────────────────────

def already_ran_today() -> bool:
    return STATE_FILE.exists() and STATE_FILE.read_text().strip() == str(mountain_today())


def mark_ran():
    STATE_FILE.write_text(str(mountain_today()))


_ECHO = False   # when True, log() also prints to the console (set by --test-chatgpt)


def log(msg: str):
    try:
        ts = mountain_now().strftime("%Y-%m-%d %H:%M:%S MT")
    except Exception:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}\n"
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line)
    if _ECHO:
        try:
            sys.stdout.write(line)
            sys.stdout.flush()
        except Exception:
            pass


# ──────────────────────────────────────────────────────────────────────────────
# Win32 window helpers  (ctypes only — no extra packages)
# ──────────────────────────────────────────────────────────────────────────────

_u32           = ctypes.windll.user32
_k32           = ctypes.windll.kernel32
_dwm           = ctypes.windll.dwmapi
_WNDENUMPROC   = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
_SW_RESTORE    = 9
_SWP_NOZORDER  = 0x0004
_SWP_NOACTIVATE = 0x0010
_SPI_GETWORKAREA = 0x0030
_DWMWA_EXTENDED_FRAME_BOUNDS = 9
_VK_RETURN       = 0x0D
_VK_TAB          = 0x09
_VK_SHIFT        = 0x10
_VK_CONTROL      = 0x11
_VK_MENU         = 0x12   # ALT
_VK_ESCAPE       = 0x1B
_VK_V            = 0x56
_VK_9            = 0x39
_KEYEVENTF_KEYUP = 0x0002
_MOUSEEVENTF_LEFTDOWN = 0x0002
_MOUSEEVENTF_LEFTUP   = 0x0004
_CF_UNICODETEXT  = 13
_GMEM_MOVEABLE   = 0x0002

# 64-bit-safe signatures — the default int return type truncates HANDLE/pointer
# values, which corrupts the clipboard handles and crashes. Set once at import.
_k32.GlobalAlloc.restype  = ctypes.c_void_p
_k32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
_k32.GlobalLock.restype   = ctypes.c_void_p
_k32.GlobalLock.argtypes  = [ctypes.c_void_p]
_k32.GlobalUnlock.argtypes = [ctypes.c_void_p]
_k32.GlobalFree.argtypes  = [ctypes.c_void_p]
_u32.OpenClipboard.argtypes     = [ctypes.c_void_p]
_u32.SetClipboardData.restype   = ctypes.c_void_p
_u32.SetClipboardData.argtypes  = [ctypes.c_uint, ctypes.c_void_p]

# Process-name lookup (to make sure we only ever drive BRAVE windows — never VS Code,
# a terminal, etc. — before sending any tab-switch / paste keystrokes).
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_k32.OpenProcess.restype  = ctypes.c_void_p
_k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
_k32.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
_k32.QueryFullProcessImageNameW.restype  = wt.BOOL
_k32.CloseHandle.argtypes = [ctypes.c_void_p]


def _hwnd_process_name(hwnd) -> str:
    """Lower-case executable name that owns hwnd (e.g. 'brave.exe'), or '' on failure."""
    pid = _hwnd_pid(hwnd)
    if not pid:
        return ""
    h = _k32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(4096)
        size = wt.DWORD(4096)
        if _k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return Path(buf.value).name.lower()
        return ""
    finally:
        _k32.CloseHandle(h)


def _is_brave_hwnd(hwnd) -> bool:
    """True only if hwnd belongs to the Brave browser process."""
    return bool(hwnd) and _hwnd_process_name(hwnd) == "brave.exe"


def _work_area_height() -> int:
    """Usable height of the primary monitor with the taskbar excluded, so windows
    don't hide behind it. Falls back to the full screen height if the query fails."""
    r = wt.RECT()
    if _u32.SystemParametersInfoW(_SPI_GETWORKAREA, 0, ctypes.byref(r), 0):
        h = r.bottom - r.top
        if 0 < h <= SCREEN_H:
            return h
    return SCREEN_H


def _apply_work_area():
    """Reduce each window's height to the taskbar-free work area, in place."""
    h = _work_area_height()
    for pos in (WEBULL_POS, TRADEHUB_POS, TASKHUB_POS, CHATGPT_POS):
        pos[3] = h
    log(f"Usable height (taskbar excluded) = {h}px")


def _get_window_rect(hwnd):
    r = wt.RECT()
    if _u32.GetWindowRect(hwnd, ctypes.byref(r)):
        return r
    return None


def _get_frame_bounds(hwnd):
    """The window's true VISIBLE rectangle (DWM extended frame), which excludes the
    invisible resize border. Returns None if unavailable (older / custom-chrome windows)."""
    r = wt.RECT()
    res = _dwm.DwmGetWindowAttribute(
        wt.HWND(hwnd), _DWMWA_EXTENDED_FRAME_BOUNDS,
        ctypes.byref(r), ctypes.sizeof(r))
    return r if res == 0 else None


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
    """Position a window so its VISIBLE frame lands exactly on (x, y, w, h).

    Windows draws an invisible ~7px resize border around most Chromium/Electron
    windows (WeBull, Brave). SetWindowPos targets that invisible OUTER frame, so
    tiling windows edge-to-edge leaves visible gaps. We place once, measure the
    border via the DWM extended frame bounds, then re-place with compensation so the
    visible edges sit flush against each other and the screen edges."""
    _u32.ShowWindow(hwnd, _SW_RESTORE)
    time.sleep(0.25)
    _u32.SetWindowPos(hwnd, 0, x, y, w, h, _SWP_NOZORDER | _SWP_NOACTIVATE)
    time.sleep(0.15)

    wr = _get_window_rect(hwnd)
    fb = _get_frame_bounds(hwnd)
    if wr and fb:
        ml = fb.left   - wr.left      # invisible border widths (usually 0,0,7,7,7)
        mt = fb.top    - wr.top
        mr = wr.right  - fb.right
        mb = wr.bottom - fb.bottom
        if any(v > 0 for v in (ml, mt, mr, mb)):
            _u32.SetWindowPos(hwnd, 0,
                              x - ml, y - mt,
                              w + ml + mr, h + mt + mb,
                              _SWP_NOZORDER | _SWP_NOACTIVATE)


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


def _find_brave_window_by_title(substr: str, timeout: int = 2) -> int | None:
    """Return a visible BRAVE window whose title contains substr — used to find the
    TradeHub browser window without matching a VS Code / editor window that merely has
    'tradehub' in its title."""
    sub = substr.lower()
    deadline = time.time() + timeout
    while time.time() < deadline:
        for hwnd in _all_visible_hwnds():
            if sub in _hwnd_title(hwnd).lower() and _is_brave_hwnd(hwnd):
                return hwnd
        time.sleep(0.3)
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


def _find_brave() -> str | None:
    """Find Brave browser — supports the same --window-position/--window-size flags as Chrome."""
    if BRAVE_EXE_OVERRIDE and Path(BRAVE_EXE_OVERRIDE).exists():
        return BRAVE_EXE_OVERRIDE
    candidates = [
        r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
        r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
        Path.home() / "AppData" / "Local" / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe",
    ]
    for p in candidates:
        if Path(p).exists():
            return str(p)
    return None


def _find_chrome_proxy() -> str | None:
    """Find chrome_proxy.exe inside Brave's install dir — used to launch installed PWA apps."""
    brave = _find_brave()
    if brave:
        proxy = Path(brave).parent / "chrome_proxy.exe"
        if proxy.exists():
            return str(proxy)
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Opening each app
# ──────────────────────────────────────────────────────────────────────────────

def open_webull():
    """Launch + position WeBull, returning its window HWND (or None) so post-launch
    UI actions (tab + account switch) can drive it."""
    exe = _find_webull()
    if not exe:
        log("ERROR: WeBull not found. Set WEBULL_EXE_OVERRIDE at the top of this file.")
        return None

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
        return None

    time.sleep(2)   # let WeBull finish painting before we resize it
    _place(hwnd, x, y, w, h)
    log(f"WeBull → ({x},{y}) {w}×{h}")
    return hwnd


def _click_at(x: int, y: int):
    """Left-click at absolute screen coords (x, y)."""
    _u32.SetCursorPos(int(x), int(y))
    time.sleep(0.12)
    _u32.mouse_event(_MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.05)
    _u32.mouse_event(_MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)


def webull_post_launch(hwnd, initial_delay=None):
    """After WeBull loads, switch it to the Trackers tab + the Individual Margin account
    via coordinate clicks (WeBull has no scripting API). Clicks are offset from the
    window's top-left, so they follow the window wherever it's placed."""
    if not WEBULL_AUTO_ACTIONS:
        return
    if not hwnd:
        log("WeBull: window handle unknown — skipping tab/account switch.")
        return

    wait = WEBULL_ACTION_DELAY if initial_delay is None else initial_delay
    time.sleep(wait)   # let WeBull finish loading (accounts populated)
    if not _focus_window(hwnd):
        log("WeBull: could not focus the window — skipping tab/account switch.")
        return
    r = _get_frame_bounds(hwnd) or _get_window_rect(hwnd)
    if not r:
        log("WeBull: no window rectangle — skipping tab/account switch.")
        return
    ox, oy = r.left, r.top

    # 1) Switch account: open the top-right dropdown, then click "Individual Margin".
    #    Done first because switching account can reset the active tab.
    _click_at(ox + WEBULL_ACCOUNT_BUTTON[0], oy + WEBULL_ACCOUNT_BUTTON[1])
    time.sleep(1.0)   # let the dropdown render
    _click_at(ox + WEBULL_MARGIN_ITEM[0], oy + WEBULL_MARGIN_ITEM[1])
    time.sleep(1.2)   # let the account switch settle

    # 2) Switch to the Trackers tab (last, so it's the final visible state).
    _focus_window(hwnd)
    _click_at(ox + WEBULL_TRACKERS_TAB[0], oy + WEBULL_TRACKERS_TAB[1])
    log("WeBull: switched to Individual Margin account + Trackers tab.")


def _open_browser_window(browser: str, url: str, pos: list, known_before: set):
    """Open url in a new Brave window at pos and return its HWND (or None)."""
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

    return hwnd


def open_tradehub():
    """Open TradeHub in its own Brave window and return that window's HWND, so the
    ChatGPT + search tabs can be opened INTO the same window."""
    brave = _find_brave()
    if not brave:
        log("ERROR: Brave not found. Set BRAVE_EXE_OVERRIDE at the top of this file.")
        return None

    before = set(_all_visible_hwnds())
    log("Opening TradeHub in Brave...")
    return _open_browser_window(brave, TRADEHUB_URL, TRADEHUB_POS, before)


def open_taskhub_app():
    """Launch TaskHub as its installed Brave app shortcut, then position it."""
    proxy = _find_chrome_proxy()
    if not proxy:
        log("ERROR: chrome_proxy.exe not found inside Brave's directory.")
        return

    x, y, w, h = TASKHUB_POS
    snapshot = set(_all_visible_hwnds())

    log("Opening TaskHub as Brave app...")
    subprocess.Popen([
        proxy,
        f"--profile-directory={TASKHUB_PROFILE_DIR}",
        f"--app-id={TASKHUB_APP_ID}",
    ])

    hwnd = _wait_for_new_window(snapshot, timeout=25)
    if hwnd is None:
        # Fallback: search by window title
        hwnd = _wait_for_title_window("taskhub", timeout=15)

    if hwnd:
        time.sleep(1)
        _place(hwnd, x, y, w, h)
        log(f"TaskHub → ({x},{y}) {w}×{h}")
    else:
        log("WARNING: TaskHub window not detected in time; it may not be positioned correctly.")


# ──────────────────────────────────────────────────────────────────────────────
# ChatGPT analysis automation
# ──────────────────────────────────────────────────────────────────────────────

def _fetch_analysis_config(attempts: int = 5, delay: float = 3.0):
    """GET the Analysis-tab selection (prompt + searches) that TradeHub pushed to the
    worker. Retries a few times so a freshly-opened TradeHub has time to push on the
    very first run. Returns the parsed dict, or None if never available."""
    url = TD_WORKER_URL.rstrip("/") + "/analysis-config"
    for i in range(max(1, attempts)):
        try:
            # A real User-Agent is required — Cloudflare's edge 403s the default
            # "Python-urllib" agent before the request ever reaches the worker.
            req = urllib.request.Request(url, headers={
                "Cache-Control": "no-cache",
                "User-Agent": "MorningLauncher/1.0 (+https://anthonyn99.github.io/A1)",
            })
            with urllib.request.urlopen(req, timeout=15) as r:
                data = json.loads(r.read().decode("utf-8"))
            if data.get("ok") and (data.get("text") or "").strip():
                return data
        except Exception as e:
            log(f"ChatGPT: analysis-config fetch attempt {i+1} failed: {e}")
        if i < attempts - 1:
            time.sleep(delay)
    return None


def _resolve_search_url(query: str) -> str:
    """Mirror TradeHub's tbResolveUrl: full URL passthrough, www. auto-scheme, else Google."""
    t = (query or "").strip()
    if re.match(r"^https?://", t, re.I):
        return t
    if re.match(r"^www\.", t, re.I):
        return "https://" + t
    if "." in t and " " not in t and "?" not in t:
        return "https://" + t
    return "https://www.google.com/search?q=" + urllib.parse.quote(t)


def _is_chatgpt_url(u: str) -> bool:
    try:
        host = (urllib.parse.urlparse(u).hostname or "").lower()
    except Exception:
        return False
    return host in ("chatgpt.com", "chat.openai.com") or host.endswith((".chatgpt.com", ".chat.openai.com"))


def _set_clipboard_text(text: str) -> bool:
    """Put text on the Windows clipboard as CF_UNICODETEXT (no external packages).
    On success the OS owns the allocated handle, so we must NOT free it."""
    try:
        if not _u32.OpenClipboard(None):
            return False
        try:
            _u32.EmptyClipboard()
            data = text.encode("utf-16-le") + b"\x00\x00"
            h = _k32.GlobalAlloc(_GMEM_MOVEABLE, len(data))
            if not h:
                return False
            p = _k32.GlobalLock(h)
            if not p:
                _k32.GlobalFree(h)
                return False
            ctypes.memmove(p, data, len(data))
            _k32.GlobalUnlock(h)
            if not _u32.SetClipboardData(_CF_UNICODETEXT, h):
                _k32.GlobalFree(h)
                return False
            return True
        finally:
            _u32.CloseClipboard()
    except Exception as e:
        log(f"ChatGPT: clipboard set failed: {e}")
        return False


def _focus_window(hwnd) -> bool:
    """Bring hwnd to the true foreground. A background process (our launcher) is
    normally BLOCKED from SetForegroundWindow — Windows just flashes the taskbar. The
    reliable workaround is to briefly AttachThreadInput to the current foreground
    window's thread, which lets our SetForegroundWindow succeed. Returns True if hwnd
    actually became foreground."""
    for _ in range(4):
        try:
            fg = _u32.GetForegroundWindow()
            cur_tid = _k32.GetCurrentThreadId()
            fg_tid = 0
            if fg:
                pid = wt.DWORD()
                fg_tid = _u32.GetWindowThreadProcessId(fg, ctypes.byref(pid))
            attached = bool(fg_tid) and fg_tid != cur_tid and \
                bool(_u32.AttachThreadInput(cur_tid, fg_tid, True))
            _u32.ShowWindow(hwnd, _SW_RESTORE)
            _u32.BringWindowToTop(hwnd)
            _u32.SetForegroundWindow(hwnd)
            if attached:
                _u32.AttachThreadInput(cur_tid, fg_tid, False)
        except Exception as e:
            log(f"ChatGPT: focus error: {e}")
        time.sleep(0.4)
        if _u32.GetForegroundWindow() == hwnd:
            return True
    return False


def _tap(vk):
    _u32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.03)
    _u32.keybd_event(vk, 0, _KEYEVENTF_KEYUP, 0)


def _send_ctrl(vk):
    """Ctrl+<vk>."""
    _u32.keybd_event(_VK_CONTROL, 0, 0, 0)
    _tap(vk)
    _u32.keybd_event(_VK_CONTROL, 0, _KEYEVENTF_KEYUP, 0)


def _send_shift(vk):
    """Shift+<vk>."""
    _u32.keybd_event(_VK_SHIFT, 0, 0, 0)
    _tap(vk)
    _u32.keybd_event(_VK_SHIFT, 0, _KEYEVENTF_KEYUP, 0)


def _active_tab_is_chatgpt(hwnd) -> bool:
    """The window title reflects the ACTIVE tab's page title. ChatGPT's is 'ChatGPT'
    (or 'chatgpt.com' while loading); the searches (finviz, Google, …) never contain
    'chatgpt'. So this tells us whether ChatGPT is the tab currently in front."""
    return "chatgpt" in _hwnd_title(hwnd).lower()


def _activate_chatgpt_tab(hwnd, timeout: int) -> bool:
    """Make the ChatGPT tab the ACTIVE tab and CONFIRM it via the window title, so we
    never paste into a search tab. ChatGPT is opened last, so Ctrl+9 (jump to last tab)
    is the fast path; if that isn't it (or it's still loading), we walk every tab with
    Ctrl+Tab, checking the title each time. Returns as soon as ChatGPT is confirmed in
    front (fast when it loads quickly), or False on timeout.

    SAFETY: every tab-switch keystroke is gated on the Brave window being the true
    foreground window — so keystrokes can never leak into another app (VS Code, a
    terminal, …)."""
    deadline = time.time() + max(3, timeout)
    while time.time() < deadline:
        if not _focus_window(hwnd):
            time.sleep(0.3)
            continue
        if _active_tab_is_chatgpt(hwnd):
            return True
        if _u32.GetForegroundWindow() != hwnd:
            continue                    # not really in front → do NOT send keys
        _send_ctrl(_VK_9)               # jump to the last tab (= ChatGPT by position)
        time.sleep(0.45)
        if _active_tab_is_chatgpt(hwnd):
            return True
        for _ in range(10):             # fallback: walk the tabs looking for ChatGPT
            if time.time() >= deadline or _u32.GetForegroundWindow() != hwnd:
                break                   # focus left our window → stop sending keys
            _send_ctrl(_VK_TAB)         # Ctrl+Tab = next tab
            time.sleep(0.35)
            if _active_tab_is_chatgpt(hwnd):
                return True
    return _active_tab_is_chatgpt(hwnd)


def open_chatgpt_analysis(target_hwnd=None):
    """Open the configured searches (left tabs) plus ChatGPT (last tab) and submit the
    selected Analysis prompt into ChatGPT. Fully automated.

    If target_hwnd is given (the TradeHub window from the morning run), the tabs open
    INSIDE that window so everything shares one browser window. Otherwise (e.g.
    --test-chatgpt) a fresh window is opened at CHATGPT_POS.

    The prompt goes in via CLIPBOARD PASTE, not the ?q= URL: real prompts are far too
    long for the URL (ChatGPT returns HTTP 431 — request headers too large once the
    long query is combined with its auth cookies). Pasting has no length limit."""
    if not CHATGPT_ANALYSIS_ENABLED:
        return

    brave = _find_brave()
    if not brave:
        log("ChatGPT: Brave not found; skipping ChatGPT analysis.")
        return

    cfg = _fetch_analysis_config()
    if not cfg:
        log("ChatGPT: no analysis prompt available from worker yet — open TradeHub's "
            "Analysis tab once so it syncs, then it'll work next time. Skipping.")
        return

    prompt   = (cfg.get("text") or "")[:16000]
    name     = cfg.get("name") or "Prompt"
    searches = cfg.get("searches") or []

    # 1) Load the prompt onto the clipboard BEFORE opening anything.
    if not _set_clipboard_text(prompt):
        log("ChatGPT: could not set clipboard; aborting ChatGPT step.")
        return
    log(f"ChatGPT: prompt '{name}' ({len(prompt)} chars) copied to clipboard.")

    # 2) Build the tab list: searches first (skip any ChatGPT entry), ChatGPT last.
    tabs = [u for u in (_resolve_search_url(q) for q in searches)
            if u and not _is_chatgpt_url(u)] + ["https://chatgpt.com/"]

    # Only reuse target_hwnd if it's a real BRAVE window (never a lookalike like a
    # VS Code window whose title happens to contain "tradehub").
    use_existing = bool(target_hwnd) and target_hwnd in set(_all_visible_hwnds()) \
        and _is_brave_hwnd(target_hwnd)
    if use_existing:
        # Open the tabs INTO the TradeHub window: focus it first so Brave adds the tabs
        # there (a bare `brave <urls>` goes to the last-focused browser window).
        hwnd = target_hwnd
        _focus_window(hwnd)
        log(f"ChatGPT: adding {len(tabs)-1} search tab(s) + ChatGPT to the TradeHub window...")
        subprocess.Popen([brave] + tabs)
    else:
        # Standalone: one dedicated new window (searches + ChatGPT as tabs).
        x, y, w, h = CHATGPT_POS
        snapshot = set(_all_visible_hwnds())
        log(f"ChatGPT: opening 1 window with {len(tabs)-1} search tab(s) + ChatGPT...")
        subprocess.Popen([
            brave,
            f"--window-position={x},{y}",
            f"--window-size={w},{h}",
            "--new-window",
        ] + tabs)
        hwnd = _wait_for_new_window(snapshot, timeout=25)
        if not hwnd:
            log("ChatGPT: new window not detected; skipping paste. Prompt is on the "
                "clipboard — switch to the ChatGPT tab, focus the box, Ctrl+V, Enter.")
            return
        time.sleep(1)
        _place(hwnd, x, y, w, h)

    # Safety: never drive a non-Brave window (guards the standalone path too).
    if not _is_brave_hwnd(hwnd):
        log("ChatGPT: target window is not Brave; refusing to send keystrokes. Prompt "
            "is on the clipboard — switch to the ChatGPT tab, Ctrl+V then Enter.")
        return

    # 3) Make ChatGPT the ACTIVE tab and CONFIRM it by the window title before typing —
    #    this is what prevents pasting into a search tab. Returns as soon as ChatGPT is
    #    in front (fast when warm). If we can't confirm it, we must NOT type — bail with
    #    the prompt left on the clipboard.
    time.sleep(1.0)             # let the tabs spawn
    if not _activate_chatgpt_tab(hwnd, CHATGPT_LOAD_WAIT):
        log("ChatGPT: couldn't confirm the ChatGPT tab is in front; prompt is on the "
            "clipboard — switch to the ChatGPT tab, focus the box, Ctrl+V then Enter.")
        return

    # 4) ChatGPT is confirmed active. Focus its message box with ChatGPT's own Shift+Esc
    #    shortcut (works whether the box is centred on the new-chat screen or docked at
    #    the bottom), paste, and submit — but ONLY while the Brave window is truly in
    #    front, so keystrokes can't leak into another app.
    if not _focus_window(hwnd) or _u32.GetForegroundWindow() != hwnd:
        log("ChatGPT: lost the Brave window before paste; prompt is on the clipboard — "
            "switch to the ChatGPT tab, focus the box, Ctrl+V then Enter.")
        return
    _send_shift(_VK_ESCAPE)     # ChatGPT shortcut: focus the message box
    time.sleep(0.15)
    _send_ctrl(_VK_V)          # paste
    time.sleep(0.5)            # let the pasted text render in the composer
    _tap(_VK_RETURN)           # submit
    log("ChatGPT: confirmed ChatGPT tab, focused box, pasted prompt, pressed Enter.")


# ──────────────────────────────────────────────────────────────────────────────
# Main morning routine
# ──────────────────────────────────────────────────────────────────────────────

def _launch_all(test: bool):
    log("=== Morning launch starting ===" + (" [TEST]" if test else ""))
    _apply_work_area()   # size windows to the taskbar-free height before opening them
    webull_hwnd = open_webull()
    tradehub_hwnd = open_tradehub()
    time.sleep(1.5)
    open_taskhub_app()
    # Open ChatGPT + searches as tabs in the SAME TradeHub window, then paste+submit.
    open_chatgpt_analysis(target_hwnd=tradehub_hwnd)
    # WeBull has now had ~20s to load — switch it to Trackers + Individual Margin.
    webull_post_launch(webull_hwnd)
    if not test:
        mark_ran()
    log("=== Done ===")


def run_morning(test: bool = False):
    log("Triggered" + (" [TEST]" if test else ""))

    if test:
        _launch_all(test=True)
        return

    if already_ran_today():
        log("Already launched today — skipping.")
        return

    today = mountain_today()
    if not is_market_day(today):
        log(f"{today} is a weekend or NYSE holiday — market closed, skipping.")
        return

    now = mountain_now()
    if now.hour < TRIGGER_HOUR:
        wait = seconds_until_trigger()
        log(f"Woke before {TRIGGER_HOUR}:00 — waiting {wait / 60:.1f} min until market-open prep time.")
        time.sleep(wait)
    elif now.hour >= LATEST_HOUR:
        log(f"First open of the day at {now:%H:%M} MT is past the morning window "
            f"({TRIGGER_HOUR}:00–{LATEST_HOUR}:00 MT) — not auto-launching. "
            f"Run 'python launcher.py --test' to open manually.")
        return

    _launch_all(test=False)


# ──────────────────────────────────────────────────────────────────────────────
# Task Scheduler setup / uninstall
# ──────────────────────────────────────────────────────────────────────────────

def _pythonw() -> str:
    exe = Path(sys.executable)
    pw  = exe.parent / "pythonw.exe"
    return str(pw) if pw.exists() else str(exe)


def setup():
    print("Installing tzdata for timezone support...")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "tzdata"])
    except Exception as e:
        print(f"  (tzdata install skipped: {e} — Windows timezone fallback will be used)")

    pw       = _pythonw()
    script   = str(SCRIPT_PATH)
    work_dir = str(SCRIPT_PATH.parent)

    ps = f"""
$action   = New-ScheduledTaskAction -Execute '{pw}' -Argument '"{script}"' -WorkingDirectory '{work_dir}'

# Settings tuned for a LAPTOP:
#   -AllowStartIfOnBatteries / -DontStopIfGoingOnBatteries → run even when unplugged
#     (this is the #1 reason a laptop task silently never runs)
#   -WakeToRun          → let the daily trigger wake the machine
#   -StartWhenAvailable → re-run a missed trigger as soon as possible
#   -RestartCount       → retry a few times if it fails to start
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 12) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -WakeToRun `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

# Run interactively as the logged-on user so the GUI windows actually draw on the desktop
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited

# Trigger 1: daily at {TRIGGER_HOUR}:00 AM — fires when the laptop is already on & unlocked.
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At {TRIGGER_HOUR}:00

# Trigger 2: fresh boot / login (covers cold starts).
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"

# Trigger 3: SESSION UNLOCK — the key one for a laptop. Opening the lid on a
#            Windows 11 (Modern Standby) machine wakes + unlocks WITHOUT a fresh
#            logon, so this is what actually fires when you open your laptop.
$sessionClass  = Get-CimClass -ClassName MSFT_TaskSessionStateChangeTrigger -Namespace 'Root/Microsoft/Windows/TaskScheduler'
$unlockTrigger = $sessionClass | New-CimInstance -ClientOnly
$unlockTrigger.StateChange = 8   # 8 = SessionUnlock
$unlockTrigger.UserId      = "$env:USERDOMAIN\\$env:USERNAME"
$unlockTrigger.Enabled     = $True

# Trigger 4: classic wake-from-sleep event (belt-and-suspenders for machines that
#            still emit Power-Troubleshooter event 1).
$wakeClass   = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace 'Root/Microsoft/Windows/TaskScheduler'
$wakeTrigger = $wakeClass | New-CimInstance -ClientOnly
$wakeTrigger.Subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name=''Microsoft-Windows-Power-Troubleshooter''] and EventID=1]]</Select></Query></QueryList>'
$wakeTrigger.Enabled = $True

Register-ScheduledTask -TaskName '{TASK_NAME}' -TaskPath '{TASK_FOLDER}' `
    -Action $action -Trigger @($dailyTrigger, $logonTrigger, $unlockTrigger, $wakeTrigger) `
    -Principal $principal -Settings $settings `
    -Description 'Opens WeBull + TradeHub + TaskHub on the first wake/unlock/login of each market weekday (>= {TRIGGER_HOUR} AM MT).' -Force
Write-Host 'Registered.'
"""
    result = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                            capture_output=True, text=True)
    if result.returncode != 0:
        print("ERROR: Could not register task. Try running from an Administrator terminal.")
        print(result.stderr)
        sys.exit(1)
    print(result.stdout.strip())
    print(f"\nInstalled as '{TASK_FOLDER}{TASK_NAME}'.")
    print("Triggers: session-unlock (open laptop) | logon (boot) | daily 6 AM | wake event.")
    print("Runs on battery, only on market weekdays, once per day. Logs -> " + str(LOG_FILE))


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
    parser.add_argument("--setup",     action="store_true", help="Install into Task Scheduler")
    parser.add_argument("--uninstall", action="store_true", help="Remove from Task Scheduler")
    parser.add_argument("--test",      action="store_true", help="Open everything immediately, skipping time / market / once-per-day checks")
    parser.add_argument("--test-chatgpt", action="store_true", help="Run ONLY the ChatGPT analysis step (fetch prompt + open ChatGPT auto-submitted + searches); prints progress to the console")
    parser.add_argument("--test-webull", action="store_true", help="Run ONLY the WeBull tab/account switch on an already-open WeBull window (for tuning the click coordinates); prints progress to the console")
    parser.add_argument("--webull-coords", action="store_true", help="Print the mouse cursor's offset from the WeBull window as you hover — use it to read exact click coordinates for the WEBULL_* settings")
    args = parser.parse_args()

    if args.setup:
        setup()
    elif args.uninstall:
        uninstall()
    elif args.webull_coords:
        # Tuning aid: hover over each WeBull target and read its offset from the window
        # top-left, then plug those into WEBULL_* at the top of this file.
        _ECHO = True
        wb = _wait_for_title_window("webull", timeout=3)
        if not wb:
            log("No WeBull window found — open WeBull first.")
        else:
            r = _get_frame_bounds(wb) or _get_window_rect(wb)
            log(f"WeBull window top-left=({r.left},{r.top}) size={r.right-r.left}x{r.bottom-r.top}")
            log("Hover over Trackers / the account dropdown / (after opening it) Individual "
                "Margin. Offsets from the WeBull top-left print for 25s:")
            pt = wt.POINT()
            end = time.time() + 25
            last = None
            while time.time() < end:
                if _u32.GetCursorPos(ctypes.byref(pt)):
                    off = (pt.x - r.left, pt.y - r.top)
                    if off != last:
                        log(f"  offset-from-webull = {off}   (screen {pt.x},{pt.y})")
                        last = off
                time.sleep(0.4)
    elif args.test_webull:
        _ECHO = True
        log("=== WeBull actions test ===")
        wb = _wait_for_title_window("webull", timeout=3)
        if not wb:
            log("WeBull test: no open WeBull window found — open WeBull first.")
        else:
            webull_post_launch(wb, initial_delay=1)   # WeBull already loaded → short wait
        log("=== WeBull actions test done ===")
    elif args.test_chatgpt:
        _ECHO = True
        log("=== ChatGPT analysis test ===")
        _apply_work_area()   # size the ChatGPT window to the taskbar-free height
        # If a TradeHub BRAVE window is already open, add the tabs to it (mirrors the
        # morning run); otherwise open a standalone window. Only Brave windows match —
        # never an editor/terminal window that happens to show "tradehub".
        th = _find_brave_window_by_title("tradehub", timeout=2)
        if th:
            log("ChatGPT test: found an open TradeHub Brave window — using it.")
        open_chatgpt_analysis(target_hwnd=th)
        log("=== ChatGPT analysis test done ===")
    else:
        run_morning(test=args.test)
