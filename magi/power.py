"""Keep this PC awake while MAGI runs -- but only on mains power.

MAGI is only reachable while the machine is awake, and this laptop's only
standby state is S0 Low Power Idle "Network Disconnected": asleep, its
networking is off, so a phone cannot reach it at all and nothing can wake it
remotely (Wake-on-LAN does not work on modern standby over Wi-Fi). The engine
therefore has to hold the machine awake itself.

Three deliberate limits:

  * ON AC ONLY. An unplugged laptop that never sleeps is a flat battery and a
    hot bag, so the hold is dropped within seconds of the charger coming out
    and Windows sleeps it normally.
  * ES_SYSTEM_REQUIRED, never ES_DISPLAY_REQUIRED. The screen must still turn
    off -- that is the single biggest saving, and a lid-closed laptop has no
    use for a lit panel.
  * No ES_AWAYMODE_REQUIRED. Away mode is an S3-era concept and means nothing
    on modern standby.

WHAT THIS CANNOT DO: a power request only stops the IDLE timer. Closing the
lid, pressing the power button and choosing Sleep are user-initiated and
override it -- which is why `magi power setup` also sets the lid action.
"""

from __future__ import annotations

import ctypes
import os
import threading
import time

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001

# How often the AC/battery state is re-read. A bare kernel call, so this is
# far cheaper than anything else the engine does on a timer.
POLL_S = 15


class _PowerStatus(ctypes.Structure):
    _fields_ = [
        ("ACLineStatus", ctypes.c_ubyte),
        ("BatteryFlag", ctypes.c_ubyte),
        ("BatteryLifePercent", ctypes.c_ubyte),
        ("SystemStatusFlag", ctypes.c_ubyte),
        ("BatteryLifeTime", ctypes.c_ulong),
        ("BatteryFullLifeTime", ctypes.c_ulong),
    ]


def on_ac() -> bool:
    """True when running on mains power.

    ACLineStatus is 0 offline, 1 online, 255 unknown. Unknown counts as
    BATTERY: the failure that matters is draining a battery flat, not sleeping
    a plugged-in machine that can be woken by opening the lid.
    """
    if os.name != "nt":
        return False
    st = _PowerStatus()
    if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(st)):
        return False
    return st.ACLineStatus == 1


class KeepAwake:
    """Holds the wake request on one long-lived thread.

    SetThreadExecutionState is per-THREAD, and the request dies with the thread
    that made it. Asserting it from a request handler or a short-lived helper
    looks like it works and silently stops holding moments later -- so one
    thread owns the state for the engine's lifetime, and the same thread is the
    only thing that ever changes it.
    """

    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self.holding = False
        self.since: float | None = None
        self.on_ac = False
        self.error = ""
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        if os.name != "nt" or self._thread:
            return
        self._thread = threading.Thread(target=self._run, name="keep-awake", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def set_enabled(self, on: bool) -> None:
        self.enabled = bool(on)
        self._wake.set()          # apply now rather than up to POLL_S later

    def state(self) -> dict:
        return {
            "enabled": self.enabled,
            "on_ac": self.on_ac,
            "holding": self.holding,
            "since": self.since,
            "error": self.error,
        }

    # -- the one thread that may touch the execution state -----------------
    def _apply(self, want: bool) -> None:
        if want == self.holding:
            return
        flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED if want else ES_CONTINUOUS
        if ctypes.windll.kernel32.SetThreadExecutionState(ctypes.c_uint(flags)) == 0:
            self.error = "SetThreadExecutionState failed"
            return
        self.error = ""
        self.holding = want
        self.since = time.time() if want else None

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                self.on_ac = on_ac()
                self._apply(self.enabled and self.on_ac)
                self._wake.wait(POLL_S)
                self._wake.clear()
        finally:
            # Same thread that asserted it, which is the only thread that can
            # release it.
            with_error = getattr(ctypes, "windll", None)
            if with_error:
                ctypes.windll.kernel32.SetThreadExecutionState(ctypes.c_uint(ES_CONTINUOUS))
            self.holding = False
            self.since = None


# The engine's one instance, started from app.py's lifespan.
KEEP_AWAKE = KeepAwake(enabled=os.environ.get("MAGI_KEEP_AWAKE", "1") != "0")
