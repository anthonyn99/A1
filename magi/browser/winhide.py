"""Hide browser windows from the taskbar (Windows only).

Off-screen positioning gets a window out of sight, but Windows still shows a
taskbar button for it -- four Chrome icons appear during a run. Sites that
tolerate true headless avoid this entirely, but ChatGPT and Claude sit behind
Cloudflare, which blocks headless outright, so they must run as real windows.

For those, this hides the window at the Win32 level:
  * WS_EX_TOOLWINDOW  -- excludes it from the taskbar and Alt-Tab
  * SW_HIDE           -- removes it from the screen entirely

The page keeps running normally; rendering and JS are unaffected because the
browser process itself is untouched. Verified: a hidden window still loads
pages and returns titles.

No-op on non-Windows platforms.
"""

from __future__ import annotations

import sys
from pathlib import Path

_IS_WINDOWS = sys.platform == "win32"

if _IS_WINDOWS:
    import ctypes
    import ctypes.wintypes as wt

    _user32 = ctypes.windll.user32
    _GWL_EXSTYLE = -20
    _WS_EX_TOOLWINDOW = 0x00000080
    _WS_EX_APPWINDOW = 0x00040000
    _SW_HIDE = 0


def _top_level_windows(pids: set[int]) -> list[int]:
    """Visible top-level Chrome windows owned by any of these PIDs."""
    found: list[int] = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def _cb(hwnd, _lparam):
        pid = wt.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids and _user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            _user32.GetClassNameW(hwnd, buf, 256)
            # Chrome's real top-level frame; skips tooltips and popups.
            if "Chrome_WidgetWin" in buf.value:
                found.append(hwnd)
        return True

    _user32.EnumWindows(callback_type(_cb), 0)
    return found


def hide_windows_for_profile(profile_dir: Path) -> int:
    """Hide every taskbar button for browsers using this profile.

    Returns how many windows were hidden. Safe to call repeatedly -- Chrome can
    create its window slightly after launch, so callers may retry.
    """
    if not _IS_WINDOWS:
        return 0

    # Imported here to avoid a circular import at module load.
    from .launcher import _chrome_pids_using

    pids = set(_chrome_pids_using(profile_dir))
    if not pids:
        return 0

    hidden = 0
    for hwnd in _top_level_windows(pids):
        try:
            ex = _user32.GetWindowLongW(hwnd, _GWL_EXSTYLE)
            _user32.SetWindowLongW(
                hwnd, _GWL_EXSTYLE, (ex | _WS_EX_TOOLWINDOW) & ~_WS_EX_APPWINDOW
            )
            _user32.ShowWindow(hwnd, _SW_HIDE)
            hidden += 1
        except Exception:
            # Best effort: a visible window is a cosmetic problem, not a
            # reason to fail someone's question.
            pass
    return hidden
