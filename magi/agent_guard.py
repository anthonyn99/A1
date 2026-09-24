"""Coding agents may not drive the engine that runs them.

The engine trusts loopback: a request that did not come through the tunnel
needs no token (app.py `_arrived_over_the_tunnel`), because anything already
on this PC could read the token anyway. Coding agents are the exception to
"anything on this PC is you". Phase 14 verified live that Codex's Windows
sandbox -- read-only AND workspace-write, network_access=false or not --
lets a shell command reach http://127.0.0.1:8000: a prompt-injected task
could approve its own diff, push it, or read /api/token.

So every agent CLI MAGI starts goes into one Windows Job object
(`adopt`, called by agents/_proc.py). A job is inherited by every process
the agent starts, however deep, and survives the parent exiting -- unlike a
parent-PID walk, which an orphaned process escapes. While any process is in
the job, each loopback /api/ request is traced to the process that opened the
connection (the TCP table's owning PID) and refused if that process is in the
job. One thing stays open to them: GETs under /api/code/projects/<id>/repo,
which the read-only GitHub MCP server (started by the Claude CLI, so inside
the job) exists to make.

What this does not stop: a process started OUTSIDE the job on the agent's
behalf -- a task scheduler entry, WMI, or a page handed to an already-running
browser. The browser path is closed separately by the Origin check in app.py.

Windows only. Elsewhere `adopt` is a no-op and nothing is refused; the engine
has only ever run on Windows.
"""

from __future__ import annotations

import ctypes
import re
import socket
import sys
import threading
from ctypes import wintypes

WIN = sys.platform == "win32"
_lock = threading.Lock()
_job: int | None = None

# The one door left open: the GitHub MCP server's reads (github/mcp_server.py).
_READ_OK = re.compile(r"^/api/code/projects/[A-Za-z0-9_-]+/repo(/[A-Za-z0-9_-]+)*/?$")

if WIN:
    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _ip = ctypes.WinDLL("iphlpapi", use_last_error=True)
    _k32.CreateJobObjectW.restype = wintypes.HANDLE
    _k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _k32.AssignProcessToJobObject.restype = wintypes.BOOL
    _k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _k32.IsProcessInJob.restype = wintypes.BOOL
    _k32.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.QueryInformationJobObject.restype = wintypes.BOOL
    _k32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                               wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    _ip.GetExtendedTcpTable.restype = wintypes.DWORD
    _ip.GetExtendedTcpTable.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), wintypes.BOOL,
                                        wintypes.ULONG, ctypes.c_int, wintypes.ULONG]

_QUERY_LIMITED = 0x1000
_ACCOUNTING = 1                 # JobObjectBasicAccountingInformation
_TCP_OWNER_PID_ALL = 5
_ESTABLISHED = 5                # MIB_TCP_STATE_ESTAB
_AF = {"v4": 2, "v6": 23}


class _Acct(ctypes.Structure):
    _fields_ = [("TotalUserTime", ctypes.c_int64), ("TotalKernelTime", ctypes.c_int64),
                ("ThisPeriodTotalUserTime", ctypes.c_int64), ("ThisPeriodTotalKernelTime", ctypes.c_int64),
                ("TotalPageFaultCount", wintypes.DWORD), ("TotalProcesses", wintypes.DWORD),
                ("ActiveProcesses", wintypes.DWORD), ("TotalTerminatedProcesses", wintypes.DWORD)]


class _Row4(ctypes.Structure):          # MIB_TCPROW_OWNER_PID
    _fields_ = [("state", wintypes.DWORD), ("laddr", wintypes.DWORD), ("lport", wintypes.DWORD),
                ("raddr", wintypes.DWORD), ("rport", wintypes.DWORD), ("pid", wintypes.DWORD)]


class _Row6(ctypes.Structure):          # MIB_TCP6ROW_OWNER_PID
    _fields_ = [("laddr", ctypes.c_ubyte * 16), ("lscope", wintypes.DWORD), ("lport", wintypes.DWORD),
                ("raddr", ctypes.c_ubyte * 16), ("rscope", wintypes.DWORD), ("rport", wintypes.DWORD),
                ("state", wintypes.DWORD), ("pid", wintypes.DWORD)]


def _the_job() -> int | None:
    global _job
    if not WIN:
        return None
    with _lock:
        if _job is None:
            _job = _k32.CreateJobObjectW(None, None) or None
        return _job


def adopt(popen) -> bool:
    """Put a just-started agent process (and so everything it starts) in the job."""
    job = _the_job()
    if job is None:
        return False
    try:
        return bool(_k32.AssignProcessToJobObject(job, int(popen._handle)))
    except (AttributeError, OSError, TypeError):
        return False


def agents_running() -> bool:
    if _job is None:
        return False
    a = _Acct()
    if not _k32.QueryInformationJobObject(_job, _ACCOUNTING, ctypes.byref(a), ctypes.sizeof(a), None):
        return True     # cannot tell: assume one is
    return a.ActiveProcesses > 0


def _rows(af: int, row):
    size = wintypes.DWORD(0)
    _ip.GetExtendedTcpTable(None, ctypes.byref(size), False, af, _TCP_OWNER_PID_ALL, 0)
    for _ in range(4):
        buf = ctypes.create_string_buffer(size.value + 8192)
        size = wintypes.DWORD(len(buf))
        rc = _ip.GetExtendedTcpTable(buf, ctypes.byref(size), False, af, _TCP_OWNER_PID_ALL, 0)
        if rc == 0:
            n = wintypes.DWORD.from_buffer(buf).value
            return (row * n).from_buffer(buf, 4)
        if rc != 122:   # anything but ERROR_INSUFFICIENT_BUFFER
            return ()
    return ()


def client_pid(client_port: int, server_port: int) -> int | None:
    """The process holding the client end of a loopback connection to us."""
    if not WIN:
        return None
    for af, row in ((_AF["v4"], _Row4), (_AF["v6"], _Row6)):
        for r in _rows(af, row):
            # TIME_WAIT rows belong to PID 0 and can share an old port pair.
            if r.state != _ESTABLISHED or not r.pid:
                continue
            if (socket.ntohs(r.lport & 0xFFFF) == client_port
                    and socket.ntohs(r.rport & 0xFFFF) == server_port):
                return int(r.pid)
    return None


def in_job(pid: int) -> bool | None:
    """True/False, or None when the process cannot be asked."""
    job = _the_job()
    if job is None:
        return False
    h = _k32.OpenProcess(_QUERY_LIMITED, False, pid)
    if not h:
        return None
    try:
        b = wintypes.BOOL(0)
        if not _k32.IsProcessInJob(h, job, ctypes.byref(b)):
            return None
        return bool(b.value)
    finally:
        _k32.CloseHandle(h)


def decide(method: str, path: str, client_port: int | None,
           server_port: int | None) -> tuple[bool, str]:
    """(refuse?, why) for one loopback request.

    Cheap when no agent runs (one job query). While one does, a process that
    cannot be asked counts as an agent -- the console's own browser can always
    be asked, so failing closed costs nothing real.
    """
    if not agents_running():
        return False, ""
    if method in ("GET", "HEAD") and _READ_OK.match(path):
        return False, ""
    if not client_port or not server_port:
        return True, "no client port"
    pid = client_pid(client_port, server_port)
    if pid is None:
        return False, ""    # no such connection any more: nobody to answer
    member = in_job(pid)
    if member is False:
        return False, ""
    return True, f"pid {pid} " + ("is in the agents' job" if member else "cannot be asked")


def refuse(method: str, path: str, client_port: int | None, server_port: int | None) -> bool:
    return decide(method, path, client_port, server_port)[0]
