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
    _WINEVENTPROC = ctypes.WINFUNCTYPE(
        None, wt.HANDLE, wt.DWORD, wt.HWND, wt.LONG, wt.LONG, wt.DWORD, wt.DWORD
    )
    _user32.SetWinEventHook.restype = wt.HANDLE
    _user32.SetWinEventHook.argtypes = (
        wt.DWORD, wt.DWORD, wt.HMODULE, _WINEVENTPROC, wt.DWORD, wt.DWORD, wt.DWORD
    )


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


def _is_chrome_frame(hwnd: int) -> bool:
    if not _user32.IsWindowVisible(hwnd):
        return False
    buf = ctypes.create_unicode_buffer(256)
    _user32.GetClassNameW(hwnd, buf, 256)
    return "Chrome_WidgetWin" in buf.value


def _is_parked(hwnd: int) -> bool:
    if _user32.IsIconic(hwnd):
        return False
    rect = wt.RECT()
    return bool(_user32.GetWindowRect(hwnd, ctypes.byref(rect))) and (
        rect.left <= _PARKED_AT and rect.top <= _PARKED_AT
    )


def _parked_frames() -> list[int]:
    """Visible, non-minimised Chrome frames parked off-screen: only a
    background run puts a frame there, so it can be hidden before its
    process is known (closing the flash at launch)."""
    found: list[int] = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def _cb(hwnd, _lparam):
        if _is_chrome_frame(hwnd) and _is_parked(hwnd):
            found.append(hwnd)
        return True

    _user32.EnumWindows(callback_type(_cb), 0)
    return found


_tls = threading.local()


def _taskbar():
    """This thread's ITaskbarList (COM objects belong to the thread that made
    them), or None if it can't be had."""
    if not hasattr(_tls, "taskbar"):
        _tls.taskbar = None
        try:
            ole32 = ctypes.windll.ole32
            ole32.CoInitializeEx(None, 2)  # STA; a thread already in COM is fine
            clsid, iid = (ctypes.create_string_buffer(16) for _ in range(2))
            ole32.CLSIDFromString("{56FDF344-FD6D-11d0-958A-006097C9A090}", clsid)
            ole32.CLSIDFromString("{56FDF342-FD6D-11d0-958A-006097C9A090}", iid)
            ptr = ctypes.c_void_p()
            if ole32.CoCreateInstance(clsid, None, 1, iid, ctypes.byref(ptr)) == 0:
                vtbl = ctypes.cast(ctypes.cast(ptr, ctypes.POINTER(ctypes.c_void_p))[0],
                                   ctypes.POINTER(ctypes.c_void_p))
                hr_init = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p)(vtbl[3])
                delete_tab = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, wt.HWND)(vtbl[5])
                if hr_init(ptr) == 0:
                    _tls.taskbar = (ptr, delete_tab)
        except Exception:  # noqa: BLE001 - hiding still works without it
            _tls.taskbar = None
    return _tls.taskbar


def _hide(hwnd: int) -> None:
    """Take a frame off the taskbar and the screen without waiting on Chrome.

    ShowWindow on another process's window blocks until that window's thread
    handles it, and a starting Chrome is busy for ~160 ms, all of it with a
    taskbar button showing. So: the style first (applied at once, and a frame
    Chrome shows again later then gets no button), then Explorer drops the
    button itself (DeleteTab), then the hide is posted, not waited for."""
    ex = _user32.GetWindowLongW(hwnd, _GWL_EXSTYLE)
    _user32.SetWindowLongW(hwnd, _GWL_EXSTYLE, (ex | _WS_EX_TOOLWINDOW) & ~_WS_EX_APPWINDOW)
    taskbar = _taskbar()
    if taskbar is not None:
        taskbar[1](taskbar[0], hwnd)
    _user32.ShowWindowAsync(hwnd, _SW_HIDE)


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
            _hide(hwnd)
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

    def __init__(self, pids_fn: Callable[[], set[int]]) -> None:
        self._pids_fn = pids_fn
        self._pids: set[int] = set()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.hidden = 0

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

    def _on_show(self, _hook, _event, hwnd, id_object, id_child, _thread, _time) -> None:
        """A window just became visible: hide it there and then if it is one
        of ours, so even the first frame never reaches the taskbar. The
        polling below is the backstop for a show this misses."""
        if id_object != 0 or id_child != 0:  # OBJID_WINDOW, the window itself
            return
        try:
            if _user32.GetAncestor(hwnd, 2) != hwnd or not _is_chrome_frame(hwnd):
                return  # GA_ROOT: only top-level frames
            pid = wt.DWORD()
            _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value in self._pids or _is_parked(hwnd):
                _hide(hwnd)
                self.hidden += 1
        except Exception:  # noqa: BLE001 - a visible window is cosmetic
            pass

    def _read_pids(self) -> None:
        read_at = float("-inf")
        while not self._stop.is_set():
            due = self.EMPTY_REREAD_S if not self._pids else self.REFRESH_S
            if time.monotonic() - read_at >= due:
                try:
                    self._pids = set(self._pids_fn())
                except Exception:  # noqa: BLE001 - try again next round
                    self._pids = set()
                read_at = time.monotonic()
            self._stop.wait(self.TICK_S)

    def _run(self) -> None:
        # EVENT_OBJECT_SHOW and EVENT_OBJECT_LOCATIONCHANGE (Chrome can show
        # its frame and only then move it off-screen), out of context: they
        # arrive through this thread's message queue, so the loop below pumps
        # messages while it waits.
        proc = _WINEVENTPROC(self._on_show)
        hooks = [_user32.SetWinEventHook(e, e, 0, proc, 0, 0, 0) for e in (0x8002, 0x800B)]
        msg = wt.MSG()
        # The process list is a slow read (PowerShell); on its own thread, so
        # it never stalls the hook or the sweep while Chrome is starting.
        reader = threading.Thread(target=self._read_pids, name="winhide-pids", daemon=True)
        reader.start()
        try:
            while not self._stop.is_set():
                # Parked frames first: they are hidden before the process
                # list (a slow read) even knows Chrome has started.
                self.hidden += hide_parked()
                if self._pids:
                    self.hidden += hide_windows(self._pids)
                _user32.MsgWaitForMultipleObjects(0, None, False, int(self.TICK_S * 1000), 0x04FF)
                while _user32.PeekMessageW(ctypes.byref(msg), 0, 0, 0, 1):
                    _user32.TranslateMessage(ctypes.byref(msg))
                    _user32.DispatchMessageW(ctypes.byref(msg))
        finally:
            reader.join(timeout=0.1)
            for hook in hooks:
                if hook:
                    _user32.UnhookWinEvent(hook)
