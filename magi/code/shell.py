"""A shell for the agents (Track W2), inside Codex's elevated Windows sandbox.

Claude Code in VS Code runs commands: installs packages, starts dev servers,
tries things. MAGI's agents could not, because on Windows nothing kept a
shell inside the task's private copy. Codex's ELEVATED sandbox does
(codex_sandbox.py): a command run through `codex sandbox` as its own Windows
user can write only in the folders it is given -- verified 2026-10-08 on this
PC: a write or delete anywhere else is "Permission denied"; with the network
switch off, the internet is refused (EACCES); with it on, `npm install` and
`pip install` into a venv in the copy work.

Every command:

  * is a Git Bash script (Claude Code's own shell on Windows) written to the
    task's scratch folder -- never through argv, which Codex re-quotes;
  * runs as the sandbox user with these folders writable and nothing else:
    the task's copy (Write) or nothing of yours (Read: the script cds into
    your real folder, which stays read-only), the scratch folder (TMP, the
    scripts) and a shared package cache (npm, pip);
  * is inside the agents' job (the engine guard refuses its loopback calls --
    and a sandbox-user process that cannot be asked counts as an agent) AND
    in a job of its own, closed when it ends or the task does: a server it
    started cannot outlive the task. Found 2026-10-08: a plain kill does NOT
    reach a sandbox-user process; terminating its job does.

Settings per project, on the engine PC only, never synced: the shell on or
off (on by default where the sandbox is ready), and internet in the sandbox
(off by default -- needed to install packages).

ws_mcp.py (Claude's tools) is stdlib-only and builds the same command line
itself; test_code_shell.py keeps the two equal.
"""

from __future__ import annotations

import asyncio
import collections
import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

DEFAULTS = {"enabled": True, "internet": False}
RUN_TIMEOUT_S = 120
MAX_TIMEOUT_S = 600
OUTPUT_TAIL = 8000
BASH_CANDIDATES = (r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe")


# ── settings ─────────────────────────────────────────────────────────────

def _store() -> Path:
    from ..settings import data_dir
    d = data_dir() / "code"
    d.mkdir(parents=True, exist_ok=True)
    return d / "shell.json"


def _read() -> dict[str, Any]:
    try:
        d = json.loads(_store().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def get(project_id: str) -> dict[str, Any]:
    raw = _read().get(project_id) or {}
    return {"enabled": raw.get("enabled", True) is not False, "internet": raw.get("internet") is True}


def put(project_id: str, enabled: Any, internet: Any) -> dict[str, Any]:
    c = {"enabled": enabled is not False, "internet": internet is True}
    d = _read()
    if c == DEFAULTS:
        d.pop(project_id, None)
    else:
        d[project_id] = c
    f = _store()
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    os.replace(tmp, f)
    return c


def forget(project_id: str) -> None:
    d = _read()
    if d.pop(project_id, None) is not None:
        _store().write_text(json.dumps(d, indent=1), encoding="utf-8")


# ── is it possible here ──────────────────────────────────────────────────

def bash_path() -> str:
    for c in BASH_CANDIDATES:
        if Path(c).is_file():
            return c
    git = shutil.which("git")
    if git:
        p = Path(git).resolve().parent.parent / "bin" / "bash.exe"
        if p.is_file():
            return str(p)
    return ""


def availability(wait: bool = False) -> tuple[bool | None, str]:
    """(usable here, why not); None = not known yet (checking). Needs Git
    Bash, the Codex CLI, and Codex's elevated sandbox set up (one Windows
    Yes, codex_sandbox.py). `wait`: a task asking -- at most ~10 s, the same
    readiness check Codex's own tasks use; the console never waits."""
    if sys.platform != "win32":
        return False, "The agents' shell runs in Codex's Windows sandbox; this engine is not on Windows."
    if not bash_path():
        return False, "Git for Windows is not installed (its bash runs the agents' commands)."
    from .agents import codex_sandbox, models, slots
    exe = slots.cli_path("codex")
    if not exe:
        return False, "The Codex CLI is not installed; its sandbox is what keeps commands in the copy."
    ver = models.codex_cli_version() or "?"
    if wait:
        ok, why = codex_sandbox.ready_for_task(exe, slots.env_for("codex", _codex_slot()), ver, within=10)
        return ok, why
    st = codex_sandbox.state(ver)
    if st is None:
        codex_sandbox.check_soon(exe, slots.env_for("codex", _codex_slot()), ver)
        return None, codex_sandbox.CHECKING
    return st.get("ok"), st.get("why") or ""


def _codex_slot() -> str:
    from .agents import slots
    have = slots.list_slots("codex")
    return have[0] if have else slots.SYSTEM_SLOT


def _home() -> Path:
    from ..settings import active_profile
    return Path(tempfile.gettempdir()) / "magi-shell" / (active_profile() or "default")


def cache_dir() -> Path:
    """The package cache (npm, pip), kept between tasks."""
    d = _home() / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def work_dir() -> Path:
    """Where each task's scratch folder lives. The SAME folder every time,
    granted to the sandbox once: a brand-new writable folder per task made
    the sandbox's setup step run each time, and now and then it failed
    ("windows sandbox failed: orchestrator_helper_incomplete", 2026-10-08)."""
    d = _home() / "work"
    d.mkdir(parents=True, exist_ok=True)
    return d


def scratch_for(task_id: str) -> Path:
    return work_dir() / task_id


def sweep() -> int:
    """Remove scratch folders left by tasks that ended without cleaning up
    (an engine restart). Call when no task runs."""
    n = 0
    w = _home() / "work"
    if w.is_dir():
        for d in w.iterdir():
            shutil.rmtree(d, ignore_errors=True)
            n += 1
    return n


def spec(*, cwd: Path, scratch: Path, write: bool, internet: bool,
         extra_writable: list[Path] | None = None) -> dict[str, Any]:
    """What a run needs, as plain data (it also goes into ws_mcp's config).
    `cwd`: the copy (Write) or your real folder (Read, kept read-only)."""
    from .agents import slots
    scratch.mkdir(parents=True, exist_ok=True)
    (scratch / "tmp").mkdir(exist_ok=True)
    cache = cache_dir()
    # The stable parents, not the per-task folders (see work_dir).
    root = scratch.parent if scratch.parent == work_dir() else scratch
    writable = [str(root), str(cache)] + [str(p) for p in extra_writable or []]
    return {"codex": slots.cli_path("codex") or "", "bash": bash_path(), "cwd": str(cwd),
            "write": bool(write), "internet": bool(internet), "scratch": str(scratch),
            "cache": str(cache), "writable": writable, "path_first": python_dirs()}


def python_dirs() -> list[str]:
    """A Python the sandbox user can run, put first on its PATH. Found on
    Tony's PC 2026-10-08: `python` was the Microsoft Store's Python Install
    Manager, whose program lives under C:\\Program Files\\WindowsApps --
    "Permission denied" for the sandbox user, so every `python` an agent ran
    (and the Python Problems checker) failed. The interpreter MAGI itself is
    built on is an ordinary install, readable by anyone."""
    base = Path(getattr(sys, "_base_executable", "") or sys.executable)
    if not base.is_file() or "windowsapps" in [p.lower() for p in base.parts]:
        return []
    out = [str(base.parent)]
    if (base.parent / "Scripts").is_dir():
        out.append(str(base.parent / "Scripts"))
    return out


def toml_list(paths: list[str]) -> str:
    """A TOML array of literal strings ('...', no escapes) of forward-slash paths."""
    return "[" + ", ".join("'" + p.replace("\\", "/") + "'" for p in paths) + "]"


def argv(sp: dict[str, Any], script: str) -> list[str]:
    """The command line: bash running `script`, as the sandbox user. The
    copy is writable because it is the process's working folder (Write); in
    Read the working folder is the scratch folder and the script cds into
    your real folder, which is not writable."""
    return [sp["codex"], "sandbox",
            "-c", "sandbox_mode=workspace-write",
            "-c", "windows.sandbox=elevated",
            "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
            "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
            "-c", f"sandbox_workspace_write.network_access={'true' if sp['internet'] else 'false'}",
            "-c", f"sandbox_workspace_write.writable_roots={toml_list(sp['writable'])}",
            "--", sp["bash"], "--noprofile", "--norc", script]


def env_for(sp: dict[str, Any]) -> dict[str, str]:
    from .check import _env as check_env
    import re as _re
    env = check_env()
    # As for Codex (slots.env_for): the sandbox user cannot start anything
    # under a WindowsApps folder, so those PATH entries only produce
    # "Access is denied" instead of finding the real program.
    for k in [k for k in env if k.upper() == "PATH"]:
        env[k] = os.pathsep.join(list(sp.get("path_first") or []) + [
            x for x in env[k].split(os.pathsep)
            if "windowsapps" not in _re.split(r"[\\/]", x.lower())])
    tmp = str(Path(sp["scratch"]) / "tmp")
    cache = Path(sp["cache"])
    env.update({"TMP": tmp, "TEMP": tmp, "TMPDIR": tmp,
                "npm_config_cache": str(cache / "npm"), "PIP_CACHE_DIR": str(cache / "pip"),
                "YARN_CACHE_FOLDER": str(cache / "yarn"), "PNPM_HOME": str(cache / "pnpm"),
                "PIP_DISABLE_PIP_VERSION_CHECK": "1", "npm_config_update_notifier": "false"})
    _git_trust(env)
    return env


# What the sandbox says when IT could not start (not the command failing):
# seen once on 2026-10-08 right after Codex was reinstalled -- worth one retry.
SANDBOX_START_FAILED = "windows sandbox failed"


def _git_trust(env: dict) -> None:
    """The sandbox runs as another Windows user, so git refuses a repository
    owned by you ("dubious ownership", exit 128). Trusted for these runs
    only, through git's environment config -- never written to any file."""
    n = 0
    try:
        n = int(env.get("GIT_CONFIG_COUNT") or 0)
    except ValueError:
        n = 0
    env[f"GIT_CONFIG_KEY_{n}"] = "safe.directory"
    env[f"GIT_CONFIG_VALUE_{n}"] = "*"
    env["GIT_CONFIG_COUNT"] = str(n + 1)


def write_script(sp: dict[str, Any], command: str) -> str:
    """The command as a bash script in the scratch folder (LF endings)."""
    d = Path(sp["scratch"]) / "scripts"
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"c{time.time_ns()}.sh"
    cwd = sp["cwd"].replace("\\", "/")
    p.write_text(f"cd '{cwd}' || exit 99\n{command}\n", encoding="utf-8", newline="\n")
    return str(p)


# ── a job per run: what it starts, it takes down ─────────────────────────

class Job:
    """A Windows job with kill-on-close. Nested inside the agents' job when
    the process is already in it (Windows 8+)."""

    def __init__(self) -> None:
        self.h = None
        if sys.platform != "win32":
            return
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = ctypes.c_void_p
        self._k32 = k32
        h = k32.CreateJobObjectW(None, None)
        if not h:
            return

        class _Basic(ctypes.Structure):
            _fields_ = [("a", ctypes.c_int64), ("b", ctypes.c_int64), ("LimitFlags", ctypes.c_uint32),
                        ("c", ctypes.c_size_t), ("d", ctypes.c_size_t), ("e", ctypes.c_uint32),
                        ("f", ctypes.c_size_t), ("g", ctypes.c_uint32), ("h", ctypes.c_uint32)]

        class _Ext(ctypes.Structure):
            _fields_ = [("Basic", _Basic), ("Io", ctypes.c_uint64 * 6), ("p1", ctypes.c_size_t),
                        ("p2", ctypes.c_size_t), ("p3", ctypes.c_size_t), ("p4", ctypes.c_size_t)]
        info = _Ext()
        info.Basic.LimitFlags = 0x2000            # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        k32.SetInformationJobObject(h, 9, ctypes.byref(info), ctypes.sizeof(info))
        self.h = h

    def add(self, pid: int) -> bool:
        if not self.h:
            return False
        k32 = self._k32
        k32.OpenProcess.restype = ctypes.c_void_p
        hp = k32.OpenProcess(0x1F0FFF, False, pid)
        if not hp:
            return False
        k32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        ok = bool(k32.AssignProcessToJobObject(self.h, hp))
        k32.CloseHandle.argtypes = [ctypes.c_void_p]
        k32.CloseHandle(hp)
        return ok

    def kill(self) -> None:
        if self.h:
            self._k32.TerminateJobObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
            self._k32.TerminateJobObject(self.h, 1)

    def close(self) -> None:
        if self.h:
            self.kill()
            self._k32.CloseHandle.argtypes = [ctypes.c_void_p]
            self._k32.CloseHandle(self.h)
            self.h = None


async def run(sp: dict[str, Any], command: str, timeout_s: float = RUN_TIMEOUT_S,
              stop: asyncio.Event | None = None) -> dict[str, Any]:
    """Run one command to the end (or `timeout_s`) in the sandbox. Everything
    it started is killed when it returns. -> {ok, code, timed_out, secs, output}.
    A sandbox that could not START is tried once more."""
    res = await _run_once(sp, command, timeout_s, stop)
    for wait in (3, 6):
        if (res["ok"] or res["timed_out"]
                or not res["output"].lstrip().lower().startswith(SANDBOX_START_FAILED)):
            break
        await asyncio.sleep(wait)
        res = await _run_once(sp, command, timeout_s, stop)
    return res


async def _run_once(sp: dict[str, Any], command: str, timeout_s: float,
                    stop: asyncio.Event | None) -> dict[str, Any]:
    from .. import agent_guard
    from .. import proc
    t0 = time.monotonic()
    script = write_script(sp, command)
    cwd = sp["cwd"] if sp["write"] else sp["scratch"]
    tail: collections.deque[str] = collections.deque()
    size = [0]
    try:
        p = proc.popen(argv(sp, script), cwd=cwd, env=env_for(sp), stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                       encoding="utf-8", errors="replace", bufsize=1)
    except OSError as e:
        return {"ok": False, "code": None, "timed_out": False, "secs": 0.0,
                "output": f"The sandbox could not start: {e}"}
    agent_guard.adopt(p)
    job = Job()
    job.add(p.pid)

    def pump() -> None:
        try:
            for line in p.stdout:
                tail.append(line)
                size[0] += len(line)
                while size[0] > OUTPUT_TAIL * 2 and len(tail) > 1:
                    size[0] -= len(tail.popleft())
        except (OSError, ValueError):
            pass
    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    loop = asyncio.get_running_loop()
    waiter = loop.run_in_executor(None, p.wait)
    halt = asyncio.ensure_future(stop.wait()) if stop is not None else None
    timed_out = False
    try:
        done, _ = await asyncio.wait({waiter} | ({halt} if halt else set()),
                                     timeout=min(MAX_TIMEOUT_S, timeout_s),
                                     return_when=asyncio.FIRST_COMPLETED)
        if waiter not in done:
            timed_out = not (halt and halt in done)
    finally:
        if halt is not None:
            halt.cancel()
        job.close()              # the command, and anything it left running
        try:
            await asyncio.wait_for(asyncio.shield(waiter), 15)
        except asyncio.TimeoutError:
            pass
    await loop.run_in_executor(None, reader.join, 5)
    out = "".join(tail).replace("\r\n", "\n").strip()
    if len(out) > OUTPUT_TAIL:
        out = "…" + out[-OUTPUT_TAIL:]
    code = None if timed_out else p.returncode
    if timed_out:
        out += f"\n[stopped: still running after {int(timeout_s)} s -- start a server with start_process instead]"
    return {"ok": code == 0, "code": code, "timed_out": timed_out,
            "secs": round(time.monotonic() - t0, 1), "output": out}
