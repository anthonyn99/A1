"""
Morning Launcher
================
On every market weekday (Mon–Fri, skipping NYSE holidays), the FIRST time you
wake / unlock / boot your laptop at or after 6 AM Mountain Time, it opens:
  - WeBull Desktop   →  left   panel
  - TradeHub         →  middle panel  (browser window)
  - TaskHub          →  right  panel  (Brave app shortcut)

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
#  WHY THIS WORKS: launching the browser from the command line makes ChatGPT see
#  Sec-Fetch-Site: none (same as typing the URL in the address bar), which lets
#  its ?q= parameter AUTO-SUBMIT. A web page's window.open() is Sec-Fetch-Site:
#  cross-site, which ChatGPT only prefills — so this MUST run from the launcher.
#
#  PRECONDITION: you must be signed in to ChatGPT in Brave's default profile.
# ==============================================================================

CHATGPT_ANALYSIS_ENABLED = True   # master switch for the whole ChatGPT step
TD_WORKER_URL            = "https://trade-dashboard.av1.workers.dev"

# Where the ChatGPT window lands. Defaults to the middle column (over TradeHub).
CHATGPT_POS = [1707, 0, 1706, SCREEN_H]

# Belt-and-suspenders: after ChatGPT loads, focus it and press Enter ONCE. If the
# ?q= auto-submit already fired, the composer is empty so this is a harmless no-op;
# if OpenAI ever changes the auto-submit behavior, this still submits the prompt.
CHATGPT_PRESS_ENTER_FALLBACK = True
CHATGPT_LOAD_WAIT = 7   # seconds to let ChatGPT load before the Enter fallback

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
_dwm           = ctypes.windll.dwmapi
_WNDENUMPROC   = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
_SW_RESTORE    = 9
_SWP_NOZORDER  = 0x0004
_SWP_NOACTIVATE = 0x0010
_SPI_GETWORKAREA = 0x0030
_DWMWA_EXTENDED_FRAME_BOUNDS = 9
_VK_RETURN       = 0x0D
_KEYEVENTF_KEYUP = 0x0002


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


def open_tradehub():
    brave = _find_brave()
    if not brave:
        log("ERROR: Brave not found. Set BRAVE_EXE_OVERRIDE at the top of this file.")
        return

    before = set(_all_visible_hwnds())
    log("Opening TradeHub in Brave...")
    _open_browser_window(brave, TRADEHUB_URL, TRADEHUB_POS, before)


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
            req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
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


def _focus_window(hwnd) -> bool:
    """Bring hwnd to the foreground; return True only if it actually became foreground
    (so we never send keystrokes to the wrong window)."""
    _u32.ShowWindow(hwnd, _SW_RESTORE)
    _u32.SetForegroundWindow(hwnd)
    time.sleep(0.3)
    return _u32.GetForegroundWindow() == hwnd


def _press_enter():
    _u32.keybd_event(_VK_RETURN, 0, 0, 0)
    time.sleep(0.05)
    _u32.keybd_event(_VK_RETURN, 0, _KEYEVENTF_KEYUP, 0)


def open_chatgpt_analysis():
    """Open ChatGPT with the selected Analysis prompt already SUBMITTED, then open the
    configured search tabs. Fully automated — no manual paste / Enter."""
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

    prompt   = (cfg.get("text") or "")[:8000]
    name     = cfg.get("name") or "Prompt"
    searches = cfg.get("searches") or []

    # 1) Open ChatGPT. A command-line launch is a browser-initiated navigation
    #    (Sec-Fetch-Site: none), so ChatGPT's ?q= parameter AUTO-SUBMITS the prompt.
    x, y, w, h = CHATGPT_POS
    url = "https://chatgpt.com/?q=" + urllib.parse.quote(prompt)
    snapshot = set(_all_visible_hwnds())
    log(f"ChatGPT: launching with prompt '{name}' ({len(prompt)} chars)...")
    subprocess.Popen([
        brave,
        f"--window-position={x},{y}",
        f"--window-size={w},{h}",
        "--new-window",
        url,
    ])

    hwnd = _wait_for_new_window(snapshot, timeout=25)
    if hwnd:
        time.sleep(1)
        _place(hwnd, x, y, w, h)
        log(f"ChatGPT window → ({x},{y}) {w}×{h}")
    else:
        log("ChatGPT: new window not detected in time; it may still have opened.")

    # 2) Belt-and-suspenders Enter. If ?q= already auto-submitted, the composer is
    #    empty and this is a no-op; otherwise it submits the prefilled prompt. Only
    #    fires if the ChatGPT window is truly in the foreground, so we never mis-type.
    if CHATGPT_PRESS_ENTER_FALLBACK and hwnd:
        time.sleep(CHATGPT_LOAD_WAIT)
        if _focus_window(hwnd):
            _press_enter()
            log("ChatGPT: sent Enter fallback.")
        else:
            log("ChatGPT: window not foreground — skipped Enter fallback to avoid mis-typing.")

    # 3) Open the configured searches in one extra window (skip any ChatGPT entry —
    #    already handled above). Command-line launch, so no popup-blocker issues.
    search_urls = []
    for q in searches:
        u = _resolve_search_url(q)
        if u and not _is_chatgpt_url(u):
            search_urls.append(u)
    if search_urls:
        log(f"ChatGPT: opening {len(search_urls)} search tab(s)...")
        subprocess.Popen([brave, "--new-window"] + search_urls)


# ──────────────────────────────────────────────────────────────────────────────
# Main morning routine
# ──────────────────────────────────────────────────────────────────────────────

def _launch_all(test: bool):
    log("=== Morning launch starting ===" + (" [TEST]" if test else ""))
    _apply_work_area()   # size windows to the taskbar-free height before opening them
    open_webull()
    open_tradehub()
    time.sleep(1.5)
    open_taskhub_app()
    open_chatgpt_analysis()   # fetch selected Analysis prompt → open ChatGPT auto-submitted + searches
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
    args = parser.parse_args()

    if args.setup:
        setup()
    elif args.uninstall:
        uninstall()
    else:
        run_morning(test=args.test)
