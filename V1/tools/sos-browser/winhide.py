"""Keep the driver's off-screen Chrome out of the taskbar (Windows only).

A non-visible, non-headless run parks Chrome at -32000,-32000, which is out
of sight but still gets a taskbar button until someone clicks it. The same
mechanism MAGI and ORCA use (copied, not imported -- see driver.py's header):

  * WS_EX_TOOLWINDOW -- no taskbar button, not in Alt-Tab
  * SW_HIDE          -- not on the screen at all

The page keeps running; only the frame is hidden. `KeepHidden` re-hides for
the whole run, because Chrome opens new frames mid-run (new pages, popups,
a late first frame on a busy PC). No-op anywhere but Windows.
"""

from __future__ import annotations

import sys
import threading
import time
from typing import Callable

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
    """Visible top-level Chrome frames owned by any of these processes."""
    found: list[int] = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def _cb(hwnd, _lparam):
        pid = wt.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids and _user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(256)
            _user32.GetClassNameW(hwnd, buf, 256)
            if "Chrome_WidgetWin" in buf.value:
                found.append(hwnd)
        return True

    _user32.EnumWindows(callback_type(_cb), 0)
    return found


#: Where every background run parks its window (MAGI, ORCA and StudyOS all
#: pass --window-position=-32000,-32000). A minimised window reports the same
#: spot, so only frames that are NOT minimised count as parked.
_PARKED_AT = -30000


def _parked_frames() -> list[int]:
    """Visible, non-minimised Chrome frames parked off-screen: only a
    background run puts a frame there, so it can be hidden before its
    process is known (closing the flash at launch)."""
    found: list[int] = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def _cb(hwnd, _lparam):
        if _user32.IsWindowVisible(hwnd) and not _user32.IsIconic(hwnd):
            rect = wt.RECT()
            if _user32.GetWindowRect(hwnd, ctypes.byref(rect)) and (
                rect.left <= _PARKED_AT and rect.top <= _PARKED_AT
            ):
                buf = ctypes.create_unicode_buffer(256)
                _user32.GetClassNameW(hwnd, buf, 256)
                if "Chrome_WidgetWin" in buf.value:
                    found.append(hwnd)
        return True

    _user32.EnumWindows(callback_type(_cb), 0)
    return found


def _hide(hwnd: int) -> None:
    ex = _user32.GetWindowLongW(hwnd, _GWL_EXSTYLE)
    _user32.SetWindowLongW(hwnd, _GWL_EXSTYLE, (ex | _WS_EX_TOOLWINDOW) & ~_WS_EX_APPWINDOW)
    _user32.ShowWindow(hwnd, _SW_HIDE)


def hide_parked() -> int:
    """Hide every parked background frame; how many."""
    if not _IS_WINDOWS:
        return 0
    hidden = 0
    for hwnd in _parked_frames():
        try:
            _hide(hwnd)
            hidden += 1
        except Exception:  # noqa: BLE001 - a visible window is cosmetic
            pass
    return hidden


def hide_windows(pids: set[int]) -> int:
    """Hide every visible Chrome frame of these processes; how many."""
    if not _IS_WINDOWS or not pids:
        return 0
    hidden = 0
    for hwnd in _top_level_windows(pids):
        try:
            ex = _user32.GetWindowLongW(hwnd, _GWL_EXSTYLE)
            _user32.SetWindowLongW(hwnd, _GWL_EXSTYLE,
                                   (ex | _WS_EX_TOOLWINDOW) & ~_WS_EX_APPWINDOW)
            _user32.ShowWindow(hwnd, _SW_HIDE)
            hidden += 1
        except Exception:                               # noqa: BLE001
            pass
    return hidden


class KeepHidden:
    """Re-hide one profile's Chrome frames every TICK_S until stopped.

    Started before the launch so the first frame is caught as it appears. The
    process list (a PowerShell call) is re-read only while none is known, and
    every REFRESH_S after that.
    """

    TICK_S = 0.05
    EMPTY_REREAD_S = 0.5
    REFRESH_S = 30.0

    def __init__(self, pids_fn: Callable[[], set[int]]):
        self._pids_fn = pids_fn
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> "KeepHidden":
        if _IS_WINDOWS and self._thread is None:
            self._thread = threading.Thread(target=self._run, name="winhide", daemon=True)
            self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None

    def _run(self) -> None:
        pids: set[int] = set()
        read_at = float("-inf")
        while not self._stop.is_set():
            now = time.monotonic()
            due = self.EMPTY_REREAD_S if not pids else self.REFRESH_S
            if now - read_at >= due:
                try:
                    pids = set(self._pids_fn())
                except Exception:                       # noqa: BLE001
                    pids = set()
                read_at = now
            hide_parked()  # before the slow process list knows Chrome started
            if pids:
                hide_windows(pids)
            self._stop.wait(self.TICK_S)
