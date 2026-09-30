"""A project's check command: a real exit code beside the diff.

From Claude Queue, whose one rule was "Claude never decides whether it
succeeded" -- after every task it ran the project's real test command and read
the exit code. Here that code sits on the approval card beside the diff, so
Approve is decided with it in view. It informs; it does not gate. MAGI tasks
are separate asks, not steps in a pipeline, and a failing suite can be the
very thing you asked an agent to look at.

Where it runs: the task's PRIVATE COPY (sandbox.py), never your folder, and
only while the card is up. What `apply` writes was fixed when the diff was
taken (Sandbox.patch / final_tree), so nothing a check leaves behind -- a
build folder, __pycache__ -- can reach your folder.

What it is allowed to be, and who may set it:

  * The command is YOURS, stored on THIS engine only (data/<profile>/code/
    checks.json). It never syncs: the cloud document is written by browsers,
    and a synced command would let anything that can write it run code here.
  * It can only be set from this PC (routes.py refuses the tunnel with a 404,
    like /api/token). The token lives in the cloud document too, so a command
    settable over the tunnel would be the same hole by another door.
  * It runs inside the agents' Windows job (agent_guard), because the code it
    runs was just written by an agent: a test file can call the engine as
    easily as a shell can.
  * By default it runs when you press Run check on the card, after you have
    seen the diff. "Automatically" runs it before the card appears; that runs
    the agent's code before any person has looked at it, and the setting says
    so where it is switched on.

Dependencies: the copy leaves out ignored folders (node_modules, .venv), so a
check there would fail for want of packages -- Claude Queue copied
node_modules into its worktree for the same reason. Here they are LINKED in
for the length of the check (a directory junction; no copy, no admin) and the
links are removed as soon as it ends, before anything else can walk the copy.
"""

from __future__ import annotations

import asyncio
import collections
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from .. import agent_guard, proc

DEFAULT_TIMEOUT_MIN = 10
MAX_TIMEOUT_MIN = 60
MAX_COMMAND = 500
OUTPUT_TAIL = 8000          # characters kept: the failure is at the END of a run
# Folders a check needs that the copy leaves out, linked in from the real
# workspace while it runs. Only these names, only at the workspace's top.
DEP_DIRS = ("node_modules", ".venv", "venv", "env", "vendor")

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
# Secrets a test run has no business holding. MAGI's own token first: a
# check that inherits it could reach the engine over the tunnel.
_SECRET = re.compile(r"(^MAGI_API_TOKEN$|API_KEY|_TOKEN$|SECRET|PASSWORD)", re.I)


class CheckError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


# ── the setting ──────────────────────────────────────────────────────────────

def _store() -> Path:
    from ..settings import data_dir
    d = data_dir() / "code"
    d.mkdir(parents=True, exist_ok=True)
    return d / "checks.json"


def _read() -> dict[str, Any]:
    try:
        d = json.loads(_store().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def get(project_id: str) -> dict[str, Any]:
    """{"command", "auto", "timeout_min"} -- command "" means no check."""
    raw = _read().get(project_id) or {}
    return clean(raw.get("command", ""), raw.get("auto", False),
                 raw.get("timeout_min", DEFAULT_TIMEOUT_MIN), strict=False)


def clean(command: Any, auto: Any, timeout_min: Any, strict: bool = True) -> dict[str, Any]:
    """Validated. `strict` raises on a bad command; reading a stored one
    tolerates it (and treats it as no check) rather than crashing a task."""
    cmd = str(command or "").strip()
    bad = ""
    if len(cmd) > MAX_COMMAND:
        bad = f"Keep the command under {MAX_COMMAND} characters."
    elif "\n" in cmd or "\r" in cmd or "\x00" in cmd:
        bad = "One line: chain steps with && if you need more than one."
    if bad:
        if strict:
            raise CheckError(bad)
        cmd = ""
    try:
        t = int(timeout_min)
    except (TypeError, ValueError):
        t = DEFAULT_TIMEOUT_MIN
    return {"command": cmd, "auto": bool(auto) and bool(cmd),
            "timeout_min": max(1, min(MAX_TIMEOUT_MIN, t))}


def put(project_id: str, command: Any, auto: Any = False,
        timeout_min: Any = DEFAULT_TIMEOUT_MIN) -> dict[str, Any]:
    c = clean(command, auto, timeout_min)
    d = _read()
    if c["command"]:
        d[project_id] = c
    else:
        d.pop(project_id, None)
    f = _store()
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    os.replace(tmp, f)
    return c


def forget(project_id: str) -> None:
    d = _read()
    if d.pop(project_id, None) is not None:
        _store().write_text(json.dumps(d, indent=1), encoding="utf-8")


# ── what to suggest ──────────────────────────────────────────────────────────

def suggest(root: Path) -> list[dict[str, str]]:
    """Commands this folder looks like it runs, best first, each with why.

    Claude Queue's detect-commands: nobody should have to remember a test
    command to use one. Read from the folder's own files, never guessed."""
    out: list[dict[str, str]] = []

    def add(cmd: str, why: str) -> None:
        if not any(o["command"] == cmd for o in out):
            out.append({"command": cmd, "why": why})

    try:
        pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
        scripts = pkg.get("scripts") or {}
    except (OSError, ValueError, AttributeError):
        scripts = {}
    for name in ("test", "check", "lint", "build", "typecheck"):
        s = scripts.get(name) if isinstance(scripts, dict) else None
        if isinstance(s, str) and s and "no test specified" not in s:
            add(f"npm run {name}" if name != "test" else "npm test",
                f"package.json “{name}”: {s[:80]}")
    py = [n for n in ("pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini") if (root / n).exists()]
    if py or (root / "tests").is_dir() or (root / "test").is_dir():
        venv = next((v for v in (".venv", "venv", "env")
                     if (root / v / ("Scripts" if os.name == "nt" else "bin")).is_dir()), "")
        exe = (f"{venv}\\Scripts\\python.exe" if os.name == "nt" else f"{venv}/bin/python") if venv \
            else "python"
        add(f"{exe} -m pytest -q", "Python tests" + (f" ({', '.join(py)})" if py else " (a tests folder)")
            + (f", with the project's {venv}" if venv else ""))
    if (root / "Cargo.toml").exists():
        add("cargo test", "Cargo.toml")
    if (root / "go.mod").exists():
        add("go test ./...", "go.mod")
    return out


# ── running it ───────────────────────────────────────────────────────────────

def _env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not _SECRET.search(k)
           and not k.startswith("CLAUDE_CODE_")}
    # Test runners that would otherwise wait for a keypress (jest --watch),
    # colour their output, or open a pager.
    env.update({"CI": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "PAGER": "cat",
                "GIT_PAGER": "cat", "PYTHONUNBUFFERED": "1"})
    return env


def link_deps(real: Path, copy: Path) -> list[Path]:
    """Link the dependency folders the copy is missing. Returns the links."""
    made: list[Path] = []
    if real.resolve() == copy.resolve():
        return made
    for name in DEP_DIRS:
        src, dst = real / name, copy / name
        if not src.is_dir() or dst.exists() or os.path.lexists(dst):
            continue
        try:
            if os.name == "nt":
                r = proc.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(dst), str(src)],
                             capture_output=True, timeout=20)
                if r.returncode != 0:
                    continue
            else:
                os.symlink(src, dst, target_is_directory=True)
            made.append(dst)
        except (OSError, subprocess.SubprocessError):
            continue
    return made


def unlink_deps(links: list[Path]) -> None:
    """Remove ONLY the links -- never what they point at. os.rmdir on a
    junction (and os.unlink on a symlink) removes the link itself; neither
    recurses, which is the whole reason for not using rmtree here."""
    for p in []:
        try:
            if os.name == "nt":
                os.rmdir(p)
            else:
                os.unlink(p)
        except OSError:
            pass


def _argv(command: str) -> Any:
    if os.name == "nt":
        # A string, not a list: /s makes cmd take everything between the first
        # and last quote verbatim, and list2cmdline would backslash-escape any
        # quotes inside the command, which cmd does not understand.
        return f'cmd.exe /d /s /c "{command}"'
    return ["/bin/sh", "-c", command]


def _kill_tree(p: subprocess.Popen) -> None:
    """The whole tree (Claude Queue: a plain kill signals only the shell, and
    a grandchild holding stdout keeps the read open for ever)."""
    try:
        if os.name == "nt":
            proc.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, timeout=15)
        else:
            p.kill()
    except Exception:
        try:
            p.kill()
        except Exception:
            pass


async def run(command: str, cwd: Path, timeout_s: float,
              stop: asyncio.Event | None = None) -> dict[str, Any]:
    """Run it. -> {ok, code, timed_out, stopped, secs, output}. Never raises
    for the command's own sake: a command that cannot start is a failed check
    with the reason as its output."""
    t0 = time.monotonic()
    tail: collections.deque[str] = collections.deque()
    size = [0]

    def keep(chunk: str) -> None:
        tail.append(chunk)
        size[0] += len(chunk)
        while size[0] > OUTPUT_TAIL * 2 and len(tail) > 1:
            size[0] -= len(tail.popleft())

    try:
        p = proc.popen(_argv(command), cwd=str(cwd), env=_env(), stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       text=True, encoding="utf-8", errors="replace", bufsize=1)
    except OSError as e:
        return {"ok": False, "code": None, "timed_out": False, "stopped": False,
                "secs": 0.0, "output": f"Could not start the check: {e}"}
    # Into the agents' job before it can start anything (see the docstring).
    agent_guard.adopt(p)

    def pump() -> None:
        try:
            for line in p.stdout:
                keep(line)
        except (OSError, ValueError):
            pass
    reader = threading.Thread(target=pump, daemon=True)
    reader.start()

    loop = asyncio.get_running_loop()
    waiter = loop.run_in_executor(None, p.wait)
    halt = asyncio.ensure_future(stop.wait()) if stop is not None else None
    timed_out = stopped = False
    try:
        done, _ = await asyncio.wait({waiter} | ({halt} if halt else set()),
                                     timeout=timeout_s, return_when=asyncio.FIRST_COMPLETED)
        if waiter not in done:
            stopped = bool(halt and halt in done)
            timed_out = not stopped
            await loop.run_in_executor(None, _kill_tree, p)
            try:
                await asyncio.wait_for(asyncio.shield(waiter), 15)
            except asyncio.TimeoutError:
                pass
    finally:
        if halt is not None:
            halt.cancel()
    await loop.run_in_executor(None, reader.join, 5)
    text = _ANSI.sub("", "".join(tail)).replace("\r\n", "\n")
    if len(text) > OUTPUT_TAIL:
        text = "…" + text[-OUTPUT_TAIL:]
    code = p.returncode if not (timed_out or stopped) else None
    if timed_out:
        text += f"\n[stopped: still running after {round(timeout_s / 60)} min]"
    return {"ok": code == 0, "code": code, "timed_out": timed_out, "stopped": stopped,
            "secs": round(time.monotonic() - t0, 1), "output": text.strip()}


def describe(res: dict[str, Any]) -> str:
    """One line for a transcript or a queue row."""
    if res.get("stopped"):
        return "check stopped"
    if res.get("timed_out"):
        return "check timed out"
    return "check passed" if res.get("ok") else f"check failed (exit {res.get('code')})"
