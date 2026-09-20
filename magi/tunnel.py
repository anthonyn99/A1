"""Keep ONE cloudflared alive across engine restarts, and adopt it.

A quick tunnel's hostname is random and takes seconds to minutes to register
in public DNS, so every restart used to cost the phones several minutes of
"Your PC is offline" -- and, because there is no custom domain in the account,
a stable hostname is not available to buy the problem away.

But the tunnel points at 127.0.0.1:8000, which is not tied to the engine
PROCESS. So the tunnel outlives a restart and the new engine adopts it: same
url, same magi-link record, nothing withdrawn, nothing republished, and the
phone reconnects in seconds because the address never changed.

Adoption has to be PROVEN, not assumed. A 401 over the tunnel only shows that
some token-gated MAGI answered -- an orphaned tunnel from an earlier run says
401 too, and so does another PC sharing the token. The proof used here is the
per-process id from ident.py, echoed by /api/health: the request left this
machine, crossed Cloudflare, came back through that hostname and landed in
THIS process.

The same scan that finds the survivor is what stops strays accumulating: four
orphaned cloudflareds were live when this was written, each one a tunnel the
world could still reach. `reap` runs at startup and after every watchdog
replacement, so there is exactly one.
"""

from __future__ import annotations

import contextlib
import ctypes
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import ident, proc
from .settings import ROOT, data_dir

# Per profile: two engines on one PC each own their own tunnel record.
STATE = data_dir() / "tunnel.json"
QUICK_TUNNEL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
# Only ever a quick-tunnel hostname, checked before any request is made with a
# url that came from a file or a remote record.
SAFE_URL = re.compile(r"^https://[a-z0-9-]+\.trycloudflare\.com$")

_WAIT_TIMEOUT = 0x00000102          # WAIT_TIMEOUT
_SYNCHRONIZE = 0x00100000
_QUERY_LIMITED = 0x00001000


# ── the live process ────────────────────────────────────────────────────────

class Live:
    """An adopted cloudflared, shaped like the Popen the caller expects.

    Polled by the watchdog every few seconds, so it must not shell out: a
    `tasklist` per poll would cost more CPU than the tunnel does, and this
    change is also meant to save power. Holding the handle open pins the PID
    too, so a recycled PID cannot masquerade as the tunnel.
    """

    def __init__(self, pid: int) -> None:
        self.pid = pid
        k32 = ctypes.windll.kernel32
        # Without this the handle is truncated to 32 bits and every wait fails.
        k32.OpenProcess.restype = ctypes.c_void_p
        k32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        self._h = k32.OpenProcess(_SYNCHRONIZE | _QUERY_LIMITED, False, pid)

    def poll(self):
        """None while it runs, 0 once it has exited (Popen's contract)."""
        if not self._h:
            return 0
        k32 = ctypes.windll.kernel32
        k32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        return None if k32.WaitForSingleObject(self._h, 0) == _WAIT_TIMEOUT else 0

    def terminate(self) -> None:
        with contextlib.suppress(Exception):
            proc.run(["taskkill", "/f", "/pid", str(self.pid)],
                     capture_output=True, text=True, timeout=15)

    kill = terminate

    def wait(self, timeout: float = 10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.poll() is not None:
                return 0
            time.sleep(0.2)
        return None


# ── finding and reaping ─────────────────────────────────────────────────────

def scan(port: int) -> list[dict]:
    """Every cloudflared serving THIS port, newest first.

    Matched on the exact --url argument, so another project's tunnel on this
    machine is never touched.
    """
    if os.name != "nt":
        return []
    out = proc.powershell(
        "@(Get-CimInstance Win32_Process -Filter \"name='cloudflared.exe'\" | "
        f"Where-Object {{ $_.CommandLine -like '*127.0.0.1:{port}*' }} | "
        "Select-Object ProcessId,CreationDate) | ConvertTo-Json -Compress"
    )
    try:
        data = json.loads(out) if out.strip() else []
    except ValueError:
        return []
    if isinstance(data, dict):
        data = [data]
    rows = [{"pid": int(d["ProcessId"]), "created": str(d.get("CreationDate") or "")}
            for d in data if d.get("ProcessId")]
    rows.sort(key=lambda r: r["created"], reverse=True)
    return rows


def reap(port: int, keep: int | None = None) -> int:
    """Kill every cloudflared on this port except `keep`. Returns how many."""
    killed = 0
    for row in scan(port):
        if keep is not None and row["pid"] == keep:
            continue
        with contextlib.suppress(Exception):
            proc.run(["taskkill", "/f", "/pid", str(row["pid"])],
                     capture_output=True, text=True, timeout=15)
            killed += 1
    return killed


# ── what we know about the tunnel between runs ──────────────────────────────

def record(pid: int, url: str, port: int, published_at: float | None = None) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps({
        "pid": pid, "url": url, "port": port,
        "started_at": time.time(),
        "published_at": published_at,
    }), encoding="utf-8")
    tmp.replace(STATE)


def state() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def clear() -> None:
    with contextlib.suppress(OSError):
        STATE.unlink()


# ── verification ────────────────────────────────────────────────────────────

def _get(url: str, token: str | None, ua: str, timeout: int = 12):
    headers = {"User-Agent": ua}
    if token:
        headers["X-MAGI-Token"] = token
    return urllib.request.urlopen(
        urllib.request.Request(f"{url}/api/health", headers=headers), timeout=timeout)


def reaches_me(url: str, token: str, ua: str, trusted: bool) -> bool:
    """Does this hostname reach THIS engine?

    `trusted` is False for a url learned from the remote magi-link record: that
    one is probed WITHOUT the token first and must answer 401, so the token is
    never handed to a host a remote record named.
    """
    if not SAFE_URL.match(url or ""):
        return False
    if not trusted:
        try:
            _get(url, None, ua)
            return False                      # 200 unauthenticated = not our gated engine
        except urllib.error.HTTPError as e:
            if e.code != 401:
                return False
        except OSError:
            return False
    try:
        with _get(url, token, ua) as r:
            body = json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.HTTPError, OSError, ValueError):
        return False
    return body.get("instance") == ident.INSTANCE


def candidates(cf_log: Path, link_record_url: str | None) -> list[tuple[str, bool]]:
    """Hostnames to try, best first, with whether the source is trusted."""
    out: list[tuple[str, bool]] = []
    seen: set[str] = set()

    def add(url: str | None, trusted: bool) -> None:
        if url and url not in seen and SAFE_URL.match(url):
            seen.add(url)
            out.append((url, trusted))

    add(state().get("url"), True)
    try:
        hits = QUICK_TUNNEL.findall(cf_log.read_text(encoding="utf-8", errors="replace"))
        add(hits[-1] if hits else None, True)
    except OSError:
        pass
    add(link_record_url, False)
    return out


class Adopted:
    def __init__(self, live: Live, url: str, published_at: float | None, log_size: int) -> None:
        self.proc = live
        self.url = url
        self.published_at = published_at
        self.log_size = log_size


def adopt(port: int, token: str, cf_log: Path, ua: str,
          link_record: dict | None, internet_up=None) -> Adopted | None:
    """Take over the cloudflared left behind by the previous engine.

    Returns None when there is nothing usable, and the caller opens a tunnel
    exactly as before. Every path leaves at most one cloudflared alive.
    """
    rows = scan(port)
    if not rows:
        return None

    # A logon racing the Wi-Fi stack must not kill a perfectly good tunnel just
    # because it cannot verify it yet. The local backend is already serving, so
    # nothing is blocked by waiting.
    if internet_up is not None:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and not internet_up():
            time.sleep(2)

    known = state()
    pids = [r["pid"] for r in rows]
    survivor = known.get("pid") if known.get("pid") in pids else rows[0]["pid"]

    # Reap BEFORE verifying. There is no reliable pid -> hostname mapping (all
    # of them append to one log), so the only way to know the hostname that
    # verifies belongs to the survivor is for the survivor to be the only one
    # left when it is checked.
    if reap(port, keep=survivor):
        time.sleep(1.5)                       # let the edge drop the killed ones

    for url, trusted in candidates(cf_log, (link_record or {}).get("url")):
        for attempt in range(2):
            if reaches_me(url, token, ua, trusted):
                try:
                    log_size = cf_log.stat().st_size
                except OSError:
                    log_size = 0
                published_at = None
                if link_record and link_record.get("url") == url:
                    age = float(link_record.get("age_s") or 0)
                    published_at = time.time() - age
                record(survivor, url, port, published_at)
                return Adopted(Live(survivor), url, published_at, log_size)
            if attempt == 0:
                time.sleep(3)

    # Nothing verified: this tunnel is no use to anyone, and leaving it running
    # would leave a hostname the world can reach pointing at our port.
    reap(port, keep=None)
    clear()
    return None
