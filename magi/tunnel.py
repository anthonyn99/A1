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
import http.client
import json
import os
import re
import socket
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from . import ident, proc
from .settings import ROOT, data_dir

# Per profile: two engines on one PC each own their own tunnel record.
# Looked up when used, never at import: the module is imported before
# --profile is applied, so an import-time path was TONY's for every engine
# -- a veda engine wrote its tunnel record over his (found 2026-09-24).
def _state() -> Path:
    return data_dir() / "tunnel.json"
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
    _state().parent.mkdir(parents=True, exist_ok=True)
    tmp = _state().with_suffix(".tmp")
    tmp.write_text(json.dumps({
        "pid": pid, "url": url, "port": port,
        "started_at": time.time(),
        "published_at": published_at,
    }), encoding="utf-8")
    tmp.replace(_state())


def state() -> dict:
    try:
        return json.loads(_state().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def mark_published(url: str, at: float) -> None:
    """Record that `url` was published, without touching anything else.

    Separate from record() because that one stamps a fresh started_at, and
    "when did this tunnel open" is exactly what the publish latency is
    measured against. Only applies if the file still names this url -- a
    replacement tunnel may have been recorded in the meantime.
    """
    s = state()
    if s.get("url") != url:
        return
    s["published_at"] = at
    tmp = _state().with_suffix(".tmp")
    tmp.write_text(json.dumps(s), encoding="utf-8")
    tmp.replace(_state())


def clear() -> None:
    with contextlib.suppress(OSError):
        _state().unlink()


# ── verification ────────────────────────────────────────────────────────────

def _get(url: str, token: str | None, ua: str, timeout: int = 12):
    headers = {"User-Agent": ua}
    if token:
        headers["X-MAGI-Token"] = token
    return urllib.request.urlopen(
        urllib.request.Request(f"{url}/api/health", headers=headers), timeout=timeout)


# ── probing a tunnel without trusting this PC's resolver ────────────────────
# Windows (and many home routers) cache a NEGATIVE answer for a quick-tunnel
# hostname looked up before Cloudflare's DNS had it -- up to fifteen minutes,
# and some resolvers far longer. Publishing learned that first (serve.py,
# _verify_and_publish), but the watchdog and adoption kept asking the OS. On
# Veda's PC that made every healthy tunnel look dead: three failed checks, a
# replacement, a new hostname the resolver had never heard of, and round again
# -- a magi-link delete + write every ~5 minutes, 275 of each on 2026-09-28,
# half of account 2's daily KV write cap on its own.
#
# So every probe resolves through Cloudflare DoH and connects to the address
# directly (real hostname in SNI and Host), and only falls back to the OS
# resolver when DoH itself gives nothing.

def doh_resolve(host: str, ua: str) -> list[str]:
    """A records for `host` from Cloudflare DoH. [] means "not yet"."""
    req = urllib.request.Request(
        f"https://cloudflare-dns.com/dns-query?name={host}&type=A",
        headers={"accept": "application/dns-json", "User-Agent": ua})
    with urllib.request.urlopen(req, timeout=5) as r:
        data = json.loads(r.read())
    return [a["data"] for a in data.get("Answer") or [] if a.get("type") == 1]


class _PinnedHTTPS(http.client.HTTPSConnection):
    """HTTPS to `host`, but connected to `ip` -- no name resolution at all."""

    def __init__(self, host: str, ip: str, timeout: float) -> None:
        super().__init__(host, 443, timeout=timeout, context=ssl.create_default_context())
        self._ip = ip

    def connect(self) -> None:
        raw = socket.create_connection((self._ip, 443), self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


def health(url: str, ua: str, token: str | None = None, timeout: float = 12,
           os_fallback: bool = True) -> tuple[int, bytes] | None:
    """(status, body) of `url`/api/health, or None if it could not be reached."""
    host = urlparse(url).hostname or ""
    headers = {"User-Agent": ua, "Connection": "close"}
    if token:
        headers["X-MAGI-Token"] = token
    try:
        ips = doh_resolve(host, ua)
    except Exception:  # noqa: BLE001 -- DoH down is a reason to fall back
        ips = []
    for ip in ips:
        conn = _PinnedHTTPS(host, ip, timeout)
        try:
            conn.request("GET", "/api/health", headers=headers)
            r = conn.getresponse()
            return r.status, r.read()
        except Exception:  # noqa: BLE001 -- try the next address
            continue
        finally:
            conn.close()
    if not os_fallback:
        return None
    try:
        with _get(url, token, ua, timeout=int(timeout)) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except OSError:
        return None


def reaches_me(url: str, token: str, ua: str, trusted: bool) -> bool:
    """Does this hostname reach THIS engine?

    `trusted` is False for a url learned from the remote magi-link record: that
    one is probed WITHOUT the token first and must answer 401, so the token is
    never handed to a host a remote record named.
    """
    if not SAFE_URL.match(url or ""):
        return False
    if not trusted:
        hit = health(url, ua)
        if hit is None or hit[0] != 401:      # 200 unauthenticated = not our gated engine
            return False
    hit = health(url, ua, token)
    if hit is None or hit[0] != 200:
        return False
    try:
        body = json.loads(hit[1].decode("utf-8", "replace"))
    except ValueError:
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
